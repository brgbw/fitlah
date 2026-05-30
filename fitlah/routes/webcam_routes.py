import os
from datetime import datetime

from flask import jsonify, render_template, request

from ..ai_coach import generate_exercise_recommendation
from ..auth import current_user, login_required
from ..config import BASE_DIR
from ..db import delete_row, delete_rows, fetch_table, insert_row, next_id, query_db, update_row
from ..helpers import get_personal_best, save_ai_recommendation, update_personal_best


def _exercise_labels(exercise_type):
    if exercise_type == "pushup":
        return "pushups", "Push Ups", "pushup_videos"
    return "situps", "Sit Ups", "situp_videos"


def recalculate_exercise_best(db, nric, exercise_type):
    field, _, _ = _exercise_labels(exercise_type)
    best_reps = max(
        [
            int(session.get("valid_reps") or 0)
            for session in fetch_table("workout_sessions")
            if session.get("nric") == nric and session.get("exercise") == exercise_type
        ],
        default=0,
    )

    personal_best = next((pb for pb in fetch_table("personal_best") if pb.get("nric") == nric), None)
    if not personal_best:
        personal_best = {
            "nric": nric,
            "pushups": 0,
            "situps": 0,
            "run_time": "--:--",
            "updated_at": None,
        }
        insert_row("personal_best", personal_best)

    personal_best[field] = best_reps
    personal_best["updated_at"] = datetime.now().strftime("%Y-%m-%d")
    update_row("personal_best", "nric", nric, personal_best)

    for member in fetch_table("group_member"):
        if member.get("nric") == nric:
            update_row("group_member", "id", member["id"], {field: best_reps})

    return best_reps


def delete_session_video(video_path):
    if not video_path:
        return False

    normalized_path = video_path.replace("\\", "/").lstrip("/")
    absolute_path = os.path.abspath(os.path.join(BASE_DIR, normalized_path))
    userdata_root = os.path.abspath(os.path.join(BASE_DIR, "userdata"))

    if not absolute_path.startswith(userdata_root + os.sep):
        return False

    if os.path.exists(absolute_path):
        os.remove(absolute_path)
        return True

    return False


def register_webcam_routes(app):
    @app.route("/webcam")
    @login_required
    def webcam():
        sorted(query_db("webcam"), key=lambda x: x["id"], reverse=True)
        return render_template("webcam.html")

    @app.route("/webcam-prep")
    @login_required
    def webcam_prep():
        return render_template("webcam_prep.html")

    @app.route("/api/workout-session/<int:session_id>", methods=["DELETE"])
    @login_required
    def delete_workout_session(session_id):
        user = current_user()
        nric = user.get("nric")
        session_record = next(
            (
                item
                for item in fetch_table("workout_sessions")
                if item.get("id") == session_id and item.get("nric") == nric
            ),
            None,
        )

        if not session_record:
            return jsonify({"success": False, "error": "Session not found"}), 404

        exercise_type = session_record.get("exercise")
        video_deleted = delete_session_video(session_record.get("video_path"))

        delete_row("workout_sessions", "id", session_id)
        delete_rows(
            "performance_log",
            lambda log: log.get("session_id") == session_id and log.get("nric") == nric,
        )

        personal_best = None
        if exercise_type in {"pushup", "situp"}:
            personal_best = recalculate_exercise_best(None, nric, exercise_type)

        return jsonify({
            "success": True,
            "session_id": session_id,
            "video_deleted": video_deleted,
            "personal_best": personal_best,
        })

    @app.route("/api/upload-video", methods=["POST"])
    @login_required
    def upload_video():
        if "video" not in request.files:
            return jsonify({"success": False, "error": "No video file provided"}), 400

        file = request.files["video"]
        exercise_type = request.form.get("exercise", "pushup")
        if exercise_type not in {"pushup", "situp"}:
            return jsonify({"success": False, "error": "Invalid exercise type"}), 400

        valid_reps = min(int(request.form.get("valid_reps", 0) or 0), 120)
        invalid_reps = min(int(request.form.get("invalid_reps", 0) or 0), 120)
        duration_seconds = min(int(request.form.get("duration_seconds", 60) or 60), 120)
        started_at = request.form.get("started_at", "")
        ended_at = request.form.get("ended_at", datetime.now().isoformat())

        if file.filename == "":
            return jsonify({"success": False, "error": "No selected file"}), 400

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{exercise_type}_{timestamp}.webm"
        pb_field, label, folder = _exercise_labels(exercise_type)
        relative_video_path = os.path.join("userdata", folder, filename)
        save_path = os.path.join(BASE_DIR, relative_video_path)
        os.makedirs(os.path.dirname(save_path), exist_ok=True)

        file.save(save_path)
        user = current_user()
        nric = user.get("nric")
        update_personal_best(nric, exercise_type, valid_reps)
        best = get_personal_best(nric)
        session_date = datetime.now().strftime("%Y-%m-%d")
        session_time = datetime.now().strftime("%H:%M:%S")

        session_id = next_id("workout_sessions")
        session_record = {
            "id": session_id,
            "nric": nric,
            "exercise": exercise_type,
            "exercise_label": label,
            "valid_reps": valid_reps,
            "invalid_reps": invalid_reps,
            "duration_seconds": duration_seconds,
            "started_at": started_at or None,
            "ended_at": ended_at,
            "video_file": filename,
            "video_path": relative_video_path.replace("\\", "/"),
            "personal_best": int(best.get(pb_field) or 0),
            "date": session_date,
            "time": session_time,
            "source": "webcam_cv",
            "ai_recommendation": None,
        }
        insert_row("workout_sessions", session_record)

        log_id = next_id("performance_log")
        insert_row("performance_log", {
            "id": log_id,
            "nric": nric,
            "event": f"Webcam {label}",
            "name": f"Webcam {label}",
            "type": "ippt",
            "score": f"{valid_reps} reps",
            "time": f"{duration_seconds // 60}:{duration_seconds % 60:02d} min",
            "date": session_date,
            "notes": (
                f"Computer vision session. Valid: {valid_reps}, invalid: {invalid_reps}, "
                f"duration: {duration_seconds}s. Video: {filename}."
            ),
            "exercise": exercise_type,
            "valid_reps": valid_reps,
            "invalid_reps": invalid_reps,
            "duration_seconds": duration_seconds,
            "video_path": session_record["video_path"],
            "session_id": session_id,
            "ai_recommendation": None,
        })
        return jsonify({
            "success": True,
            "filename": filename,
            "path": save_path,
            "valid_reps": valid_reps,
            "invalid_reps": invalid_reps,
            "session_id": session_id,
            "personal_best": int(best.get(pb_field) or 0),
        })

    @app.route("/api/ai-recommendation", methods=["POST"])
    @login_required
    def api_ai_recommendation():
        metrics = request.get_json(silent=True)
        if not metrics:
            return jsonify({"success": False, "error": "No session metrics provided."}), 400

        user = current_user()
        nric = user.get("nric")
        metrics = dict(metrics)
        session_id = metrics.pop("session_id", None)
        if session_id is not None:
            try:
                session_id = int(session_id)
            except (TypeError, ValueError):
                session_id = None

        metrics["athlete_name"] = user.get("name") or "Athlete"
        metrics["rank"] = user.get("rank") or ""

        result = generate_exercise_recommendation(metrics)
        if result.get("success") and session_id:
            saved = save_ai_recommendation(None, session_id, nric, result)
            result["session_id"] = session_id
            result["saved_to_database"] = saved

        status = 200 if result.get("success") else 503
        return jsonify(result), status
