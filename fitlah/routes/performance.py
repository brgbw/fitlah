from flask import jsonify, redirect, render_template, request, url_for

from ..core.auth import current_user, login_required
from ..data_access.repositories import (
    activity_records as activity_records_for_nric,
    create_activity as create_activity_record,
    delete_activity as delete_activity_record,
    recalculate_personal_best,
)
from ..core.web_security import clean_text, json_too_large, rate_limit
from ..integrations.ai_coach import generate_calendar_training_summary


def register_performance_routes(app):
    @app.route("/calendar")
    @login_required
    def calendar():
        user = current_user()
        logs = sorted(
            activity_records_for_nric(user.get("nric")),
            key=lambda x: x["id"],
            reverse=True,
        )
        return render_template("calendar.html", logs=logs)

    @app.route("/performance")
    @login_required
    def performance():
        return redirect(url_for("calendar"))

    @app.route("/api/activity-records", methods=["GET"])
    @login_required
    def api_activity_records():
        user = current_user()
        nric = user.get("nric")
        logs = sorted(
            activity_records_for_nric(nric),
            key=lambda x: (x.get("date", ""), x.get("id", 0)),
        )
        return jsonify({"success": True, "logs": logs})

    @app.route("/api/calendar/training-summary")
    @login_required
    @rate_limit("calendar-training-summary", 20, 300)
    def api_calendar_training_summary():
        user = current_user()
        nric = user.get("nric")
        logs = sorted(
            activity_records_for_nric(nric),
            key=lambda x: (x.get("date", ""), x.get("id", 0)),
            reverse=True,
        )
        result = generate_calendar_training_summary(_calendar_training_payload(user, logs))
        if not result.get("success"):
            return jsonify({
                "success": False,
                "error": result.get("error") or "AI training summary could not be generated.",
                "debug": result.get("debug"),
            }), 503

        return jsonify({
            "success": True,
            "summary": {
                "title": result.get("summary", ""),
                "lines": (result.get("dos") or [])[:3],
                "focus_areas": result.get("focus_areas") or [],
            },
        })

    @app.route("/api/activity-records", methods=["POST"])
    @login_required
    @rate_limit("activity-records-create", 30, 300)
    def api_create_activity_record():
        if json_too_large(20000):
            return jsonify({"success": False, "error": "Request body is too large"}), 413
        data = request.get_json() or {}
        name = clean_text(data.get("name"), 120)
        date = clean_text(data.get("date"), 20)

        if not name or not date:
            return jsonify({"success": False, "error": "Event name and date are required"}), 400

        new_log = create_activity_record({
            "nric": current_user().get("nric"),
            "event": name,
            "name": name,
            "title": name,
            "type": data.get("type") or "logged",
            "score": clean_text(data.get("score"), 80),
            "time": clean_text(data.get("time"), 40),
            "date": date,
            "notes": clean_text(data.get("notes"), 500),
            "source": "manual",
        })
        personal_best = recalculate_personal_best(current_user().get("nric"))
        return jsonify({"success": True, "log": new_log, "personal_best": personal_best}), 201

    @app.route("/api/activity-records/<int:log_id>", methods=["DELETE"])
    @login_required
    @rate_limit("activity-records-delete", 60, 300)
    def api_delete_activity_record(log_id):
        user = current_user()
        nric = user.get("nric")
        deleted = delete_activity_record(log_id, nric)
        if not deleted:
            return jsonify({"success": False, "error": "Log not found"}), 404

        personal_best = recalculate_personal_best(nric)
        return jsonify({"success": True, "personal_best": personal_best})


def _calendar_training_payload(user, logs):
    counts = {}
    recent = []
    for log in logs:
        activity_type = log.get("type") or log.get("exercise") or "activity"
        counts[activity_type] = counts.get(activity_type, 0) + 1
        if len(recent) < 10:
            recent.append({
                "date": log.get("date"),
                "type": activity_type,
                "name": log.get("name") or log.get("event"),
                "score": log.get("score"),
                "time": log.get("calendar_run_time") or log.get("official_time") or log.get("time"),
                "run_points": log.get("run_points"),
                "run_status": log.get("run_status"),
            })

    return {
        "athleteName": user.get("name") or "NSman",
        "rank": user.get("rank") or "",
        "totalLoggedActivities": len(logs),
        "activityCounts": counts,
        "recentActivities": recent,
    }
