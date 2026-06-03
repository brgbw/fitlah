import json
import logging
import os
import uuid
from datetime import datetime

from flask import jsonify, redirect, render_template, request, url_for

from ..integrations.ai_coach import generate_exercise_recommendation
from ..core.auth import current_user, login_required
from ..core.config import BASE_DIR
from ..domain.activity_helpers import save_ai_recommendation
from ..data_access.repositories import (
    activity_records as activity_records_for_nric,
    create_activity as create_activity_record,
    delete_activity as delete_activity_record,
    recalculate_personal_best,
)
from ..core.web_security import bounded_int, json_too_large, limit_structure, rate_limit
from ..domain.session_cleanup import clear_session_analysis_files
from ..domain.session_analysis_store import load_temp_analysis_logs, save_temp_analysis

logger = logging.getLogger(__name__)

ALLOWED_VIDEO_MIMES = {
    "video/webm": ".webm",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/x-m4v": ".mp4",
    "video/x-msvideo": ".avi",
}

ALLOWED_VIDEO_EXTENSIONS = {".webm", ".mp4", ".mov", ".m4v", ".avi"}

REP_METRIC_KEYS = ["rep", "amplitude", "period_s"]


def _exercise_labels(exercise_type):
    if exercise_type == "pushup":
        return "pushups", "Push Ups", "pushup_videos"
    return "situps", "Sit Ups", "situp_videos"


def rep_metrics_csv(data):
    if not isinstance(data, list):
        return ",".join(REP_METRIC_KEYS)

    rows = []
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        rep = item.get("rep") or index + 1
        amplitude = item.get("amplitude")
        if amplitude is None:
            amplitude = item.get("amplitude_angle_deg")
        if amplitude is None:
            amplitude = item.get("amplitude_px")
        period = item.get("period_s")
        cells = [
            str(rep),
            f"{amplitude:.3f}" if isinstance(amplitude, (int, float)) else "",
            f"{period:.3f}" if isinstance(period, (int, float)) else "",
        ]
        rows.append(",".join(cells))
    return ",".join(REP_METRIC_KEYS) + ("\n" + "\n".join(rows) if rows else "")


def attach_rep_metrics_csv(metrics):
    if not isinstance(metrics, dict):
        return metrics

    rep_data = metrics.get("rep_metrics")
    movement_analysis = metrics.get("movement_analysis")
    if not rep_data and isinstance(movement_analysis, dict):
        rep_data = movement_analysis.get("reps")
    if rep_data:
        metrics["rep_metrics"] = rep_data
        metrics["rep_metrics_csv"] = rep_metrics_csv(rep_data)
    return metrics


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
        return render_template("webcam.html")

    @app.route("/exercise-setup")
    @login_required
    def exercise_setup():
        return render_template("exercise_setup.html")

    @app.route("/training-insights")
    @login_required
    def training_insights():
        user = current_user()
        nric = user.get("nric")
        raw_ids = request.args.get("session_ids", "")
        raw_analysis_ids = request.args.get("analysis_ids", "")
        session_ids = []
        for item in raw_ids.split(","):
            try:
                session_ids.append(int(item))
            except (TypeError, ValueError):
                continue

        temp_logs = load_temp_analysis_logs(raw_analysis_ids, nric)

        ai_logs = [
            log for log in activity_records_for_nric(nric)
            if log.get("ai_recommendation")
        ]
        if session_ids:
            allowed = set(session_ids)
            ai_logs = [log for log in ai_logs if int(log.get("id") or 0) in allowed]
            order = {session_id: index for index, session_id in enumerate(session_ids)}
            ai_logs.sort(key=lambda log: order.get(int(log.get("id") or 0), 999))
            temp_logs.sort(key=lambda log: order.get(int(log.get("session_id") or 0), 999))
        else:
            ai_logs.sort(key=lambda log: (log.get("date") or "", log.get("time") or ""), reverse=True)
            ai_logs = ai_logs[:3]

        ai_by_session = {int(log.get("id") or 0): log.get("ai_recommendation") for log in ai_logs}
        logs = []
        used_sessions = set()
        for log in temp_logs:
            session_id = int(log.get("session_id") or 0)
            if session_id in ai_by_session:
                log["ai_recommendation"] = ai_by_session[session_id]
            logs.append(log)
            used_sessions.add(session_id)

        logs.extend([
            log for log in ai_logs
            if int(log.get("id") or 0) not in used_sessions
        ])

        return render_template("training_insights.html", recommendations=logs)

    @app.route("/training-insights/dashboard", methods=["POST"])
    @login_required
    @rate_limit("training-insights-cleanup", 20, 300)
    def training_insights_dashboard():
        clear_session_analysis_files()
        return redirect(url_for("dashboard"))

    @app.route("/api/workout-session/<int:session_id>", methods=["DELETE"])
    @login_required
    def delete_workout_session(session_id):
        user = current_user()
        nric = user.get("nric")
        session_record = next(
            (
                item
                for item in activity_records_for_nric(nric)
                if item.get("id") == session_id and item.get("nric") == nric
            ),
            None,
        )

        if not session_record:
            return jsonify({"success": False, "error": "Session not found"}), 404

        exercise_type = session_record.get("exercise")
        video_deleted = delete_session_video(session_record.get("video_path"))

        delete_activity_record(session_id, nric)

        personal_best = recalculate_personal_best(nric) if exercise_type in {"pushup", "situp"} else None

        return jsonify({
            "success": True,
            "session_id": session_id,
            "video_deleted": video_deleted,
            "personal_best": personal_best,
        })

    @app.route("/api/upload-video", methods=["POST"])
    @login_required
    @rate_limit("upload-video", 12, 300)
    def upload_video():
        if "video" not in request.files:
            return jsonify({"success": False, "error": "No video file provided"}), 400

        file = request.files["video"]
        exercise_type = request.form.get("exercise", "pushup")
        if exercise_type not in {"pushup", "situp"}:
            return jsonify({"success": False, "error": "Invalid exercise type"}), 400

        valid_reps = bounded_int(request.form.get("valid_reps"), 0, 0, 120)
        invalid_reps = 0
        duration_seconds = bounded_int(request.form.get("duration_seconds"), 60, 1, 120)
        started_at = request.form.get("started_at", "")
        ended_at = request.form.get("ended_at", datetime.now().isoformat())
        movement_analysis = None
        raw_movement_analysis = request.form.get("movement_analysis", "")
        if raw_movement_analysis:
            if len(raw_movement_analysis) > 100000:
                return jsonify({"success": False, "error": "Movement analysis payload is too large"}), 413
            try:
                movement_analysis = limit_structure(json.loads(raw_movement_analysis), max_depth=5, max_items=600)
            except (TypeError, ValueError):
                movement_analysis = None

        if file.filename == "":
            return jsonify({"success": False, "error": "No selected file"}), 400
        original_extension = os.path.splitext(file.filename or "")[1].lower()
        extension = ALLOWED_VIDEO_MIMES.get((file.mimetype or "").lower())
        if not extension and original_extension in ALLOWED_VIDEO_EXTENSIONS:
            extension = ".mov" if original_extension == ".m4v" else original_extension
        if not extension:
            return jsonify({"success": False, "error": "Unsupported video file type"}), 400

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{exercise_type}_{timestamp}_{uuid.uuid4().hex[:12]}{extension}"
        pb_field, label, folder = _exercise_labels(exercise_type)
        relative_video_path = os.path.join("userdata", folder, filename)
        save_path = os.path.join(BASE_DIR, relative_video_path)
        userdata_root = os.path.abspath(os.path.join(BASE_DIR, "userdata"))
        save_path = os.path.abspath(save_path)
        if not save_path.startswith(userdata_root + os.sep):
            return jsonify({"success": False, "error": "Invalid upload path"}), 400
        os.makedirs(os.path.dirname(save_path), exist_ok=True)

        file.save(save_path)
        user = current_user()
        nric = user.get("nric")
        session_date = datetime.now().strftime("%Y-%m-%d")

        session_record = create_activity_record({
            "nric": nric,
            "event": f"Webcam {label}",
            "name": f"Webcam {label}",
            "title": f"Webcam {label}",
            "type": "ippt",
            "score": f"{valid_reps} reps",
            "time": f"{duration_seconds // 60}:{duration_seconds % 60:02d} min",
            "date": session_date,
            "notes": (
                f"Computer vision session. Valid: {valid_reps}, "
                f"duration: {duration_seconds}s. Video: {filename}."
            ),
            "exercise": exercise_type,
            "valid_reps": valid_reps,
            "invalid_reps": invalid_reps,
            "duration_seconds": duration_seconds,
            "started_at": started_at or None,
            "ended_at": ended_at,
            "video_file": filename,
            "video_path": relative_video_path.replace("\\", "/"),
            "source": "webcam",
            "ai_recommendation": None,
        })
        best = recalculate_personal_best(nric)
        session_id = session_record["id"]
        session_record["session_id"] = session_id

        analysis_id = save_temp_analysis(nric, {
            **session_record,
            "movement_analysis": movement_analysis,
        })
        return jsonify({
            "success": True,
            "filename": filename,
            "valid_reps": valid_reps,
            "session_id": session_id,
            "analysis_id": analysis_id,
            "personal_best_record": best,
            "personal_best": int(best.get(pb_field) or 0),
        })

    @app.route("/api/ai-recommendation", methods=["POST"])
    @login_required
    @rate_limit("ai-recommendation", 20, 300)
    def api_ai_recommendation():
        if json_too_large(120000):
            return jsonify({"success": False, "error": "Session metrics payload is too large."}), 413
        metrics = request.get_json(silent=True)
        if not metrics:
            return jsonify({"success": False, "error": "No session metrics provided."}), 400

        user = current_user()
        nric = user.get("nric")
        metrics = attach_rep_metrics_csv(limit_structure(dict(metrics), max_depth=5, max_items=600))
        session_id = metrics.pop("session_id", None)
        if session_id is not None:
            try:
                session_id = int(session_id)
            except (TypeError, ValueError):
                session_id = None

        metrics["athlete_name"] = user.get("name") or "Athlete"
        metrics["rank"] = user.get("rank") or ""

        logger.info(
            "AI recommendation requested. nric_present=%s session_id=%s exercise=%s valid_reps=%s frames=%s rep_csv_present=%s",
            bool(nric),
            session_id,
            metrics.get("exercise"),
            metrics.get("valid_reps"),
            metrics.get("frames_analyzed"),
            bool(metrics.get("rep_metrics_csv")),
        )

        try:
            result = generate_exercise_recommendation(metrics)
        except Exception as exc:
            logger.exception(
                "AI recommendation crashed before response. session_id=%s exercise=%s",
                session_id,
                metrics.get("exercise"),
            )
            result = {
                "success": False,
                "error": f"AI recommendation crashed: {type(exc).__name__}: {str(exc)[:800]}",
                "debug": {
                    "failure_stage": "api_ai_recommendation",
                    "exception_type": type(exc).__name__,
                    "exception_message": str(exc)[:800],
                    "session_id": session_id,
                    "exercise": metrics.get("exercise"),
                },
            }

        if result.get("success"):
            if not session_id:
                result["success"] = False
                result["error"] = "AI recommendation generated but no saved session_id was provided."
                result.setdefault("debug", {})
                result["debug"]["database_save_failed"] = True
                result["debug"]["missing_session_id"] = True
            else:
                saved = save_ai_recommendation(None, session_id, nric, result)
                result["session_id"] = session_id
                result["saved_to_database"] = saved
                if not saved:
                    result["success"] = False
                    result["error"] = "AI recommendation generated but could not be saved to the database."
                    result.setdefault("debug", {})
                    result["debug"]["database_save_failed"] = True
                    logger.error(
                        "AI recommendation generated but failed to save. session_id=%s exercise=%s result_keys=%s",
                        session_id,
                        metrics.get("exercise"),
                        sorted(result.keys()),
                    )

        if result.get("success"):
            logger.info(
                "AI recommendation completed. session_id=%s exercise=%s source=%s fallback_used=%s saved=%s",
                session_id,
                metrics.get("exercise"),
                result.get("source", "gemini"),
                bool((result.get("debug") or {}).get("fallback_used")),
                result.get("saved_to_database"),
            )
        else:
            logger.error(
                "AI recommendation failed. session_id=%s exercise=%s error=%s debug=%s",
                session_id,
                metrics.get("exercise"),
                result.get("error"),
                result.get("debug"),
            )

        status = 200 if result.get("success") else 503
        return jsonify(result), status
