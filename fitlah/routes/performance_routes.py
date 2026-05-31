from flask import jsonify, redirect, render_template, request, url_for

from ..auth import current_user, login_required
from ..helpers import attach_ai_to_activity_records
from ..repositories import (
    activity_records as activity_records_for_nric,
    create_activity as create_activity_record,
    delete_activity as delete_activity_record,
)


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
        logs = attach_ai_to_activity_records(None, logs, nric)
        return jsonify({"success": True, "logs": logs})

    @app.route("/api/activity-records", methods=["POST"])
    @login_required
    def api_create_activity_record():
        data = request.get_json() or {}
        name = (data.get("name") or "").strip()
        date = (data.get("date") or "").strip()

        if not name or not date:
            return jsonify({"success": False, "error": "Event name and date are required"}), 400

        new_log = create_activity_record({
            "nric": current_user().get("nric"),
            "event": name,
            "name": name,
            "title": name,
            "type": data.get("type") or "logged",
            "score": (data.get("score") or "").strip(),
            "time": (data.get("time") or "").strip(),
            "date": date,
            "notes": (data.get("notes") or "").strip(),
            "source": "manual",
        })
        return jsonify({"success": True, "log": new_log}), 201

    @app.route("/api/activity-records/<int:log_id>", methods=["DELETE"])
    @login_required
    def api_delete_activity_record(log_id):
        user = current_user()
        deleted = delete_activity_record(log_id, user.get("nric"))
        if not deleted:
            return jsonify({"success": False, "error": "Log not found"}), 404

        return jsonify({"success": True})
