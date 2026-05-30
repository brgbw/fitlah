from flask import jsonify, redirect, render_template, request, url_for

from ..auth import current_user, login_required
from ..db import delete_rows, insert_row, next_id, query_db
from ..helpers import attach_ai_to_performance_logs


def register_performance_routes(app):
    @app.route("/calendar")
    @login_required
    def calendar():
        user = current_user()
        logs = sorted(
            query_db("performance_log", lambda x: x.get("nric") == user.get("nric")),
            key=lambda x: x["id"],
            reverse=True,
        )
        return render_template("calendar.html", logs=logs)

    @app.route("/performance")
    @login_required
    def performance():
        return redirect(url_for("calendar"))

    @app.route("/api/performance-log", methods=["GET"])
    @login_required
    def api_performance_logs():
        user = current_user()
        nric = user.get("nric")
        logs = sorted(
            query_db("performance_log", lambda x: x.get("nric") == nric),
            key=lambda x: (x.get("date", ""), x.get("id", 0)),
        )
        logs = attach_ai_to_performance_logs(None, logs, nric)
        return jsonify({"success": True, "logs": logs})

    @app.route("/api/performance-log", methods=["POST"])
    @login_required
    def api_create_performance_log():
        data = request.get_json() or {}
        name = (data.get("name") or "").strip()
        date = (data.get("date") or "").strip()

        if not name or not date:
            return jsonify({"success": False, "error": "Event name and date are required"}), 400

        new_log = {
            "id": next_id("performance_log"),
            "nric": current_user().get("nric"),
            "event": name,
            "name": name,
            "type": data.get("type") or "logged",
            "score": (data.get("score") or "").strip(),
            "time": (data.get("time") or "").strip(),
            "date": date,
            "notes": (data.get("notes") or "").strip(),
        }
        insert_row("performance_log", new_log)
        return jsonify({"success": True, "log": new_log}), 201

    @app.route("/api/performance-log/<int:log_id>", methods=["DELETE"])
    @login_required
    def api_delete_performance_log(log_id):
        user = current_user()
        deleted = delete_rows(
            "performance_log",
            lambda log: log.get("id") == log_id and log.get("nric") == user.get("nric"),
        )
        if not deleted:
            return jsonify({"success": False, "error": "Log not found"}), 404

        return jsonify({"success": True})
