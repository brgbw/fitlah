from datetime import datetime


def _merge_session_fields(log, session):
    for field in [
        "exercise",
        "started_at",
        "ended_at",
        "video_file",
        "personal_best",
        "source",
        "ai_recommendation",
    ]:
        if field in session and field not in log:
            log[field] = session[field]

    if not log.get("ai_recommendation") and session.get("ai_recommendation"):
        log["ai_recommendation"] = session["ai_recommendation"]


def _session_to_log(session):
    exercise = session.get("exercise", "pushup")
    label = session.get("exercise_label", "Push Ups")
    valid_reps = session.get("valid_reps", 0)
    invalid_reps = session.get("invalid_reps", 0)
    duration_seconds = session.get("duration_seconds", 60)

    return {
        "id": 0,
        "nric": session.get("nric"),
        "event": f"Webcam {label}",
        "name": f"Webcam {label}",
        "type": exercise,
        "score": f"{valid_reps} reps",
        "time": f"{duration_seconds // 60}:{duration_seconds % 60:02d} min",
        "date": session.get("date", datetime.now().strftime("%Y-%m-%d")),
        "notes": (
            f"Computer vision session. Valid: {valid_reps}, invalid: {invalid_reps}, "
            f"duration: {duration_seconds}s. Video: {session.get('video_file', '')}."
        ),
        "exercise": exercise,
        "valid_reps": valid_reps,
        "invalid_reps": invalid_reps,
        "duration_seconds": duration_seconds,
        "video_path": session.get("video_path"),
        "ai_recommendation": session.get("ai_recommendation"),
        "started_at": session.get("started_at"),
        "ended_at": session.get("ended_at"),
        "personal_best": session.get("personal_best"),
        "video_file": session.get("video_file"),
        "source": session.get("source", "webcam_cv"),
    }


def _merge_legacy_workout_sessions(performance_log, workout_sessions):
    sessions_by_video = {}
    sessions_by_id = {}
    for session in workout_sessions:
        nric = session.get("nric")
        video_path = session.get("video_path")
        session_id = session.get("id")
        if nric and video_path:
            sessions_by_video[(nric, video_path)] = session
        if nric and session_id:
            sessions_by_id[(nric, session_id)] = session

    merged_session_ids = set()
    for log in performance_log:
        nric = log.get("nric")
        video_path = log.get("video_path")
        session_id = log.get("session_id")
        session = sessions_by_video.get((nric, video_path)) or sessions_by_id.get((nric, session_id))

        if session:
            merged_session_ids.add(session.get("id"))
            _merge_session_fields(log, session)

    for session in workout_sessions:
        if session.get("id") not in merged_session_ids:
            performance_log.append(_session_to_log(session))


def _normalize_log(log, unique_id):
    log["id"] = unique_id
    log.setdefault("nric", "S3456789C")
    log.setdefault("time", "")
    log.setdefault("notes", "")

    exercise_lower = (log.get("exercise") or "").lower()
    event_lower = (log.get("event") or "").lower()
    name_lower = (log.get("name") or "").lower()
    notes_lower = (log.get("notes") or "").lower()

    if "pushup" in exercise_lower or "push" in event_lower or "push" in name_lower or "push" in notes_lower:
        log["type"] = "pushup"
        log["exercise"] = "pushup"
        log["event"] = "Webcam Push Ups" if "webcam" in event_lower else "Push-ups"
    elif "situp" in exercise_lower or "sit" in event_lower or "sit" in name_lower or "sit" in notes_lower:
        log["type"] = "situp"
        log["exercise"] = "situp"
        log["event"] = "Webcam Sit Ups" if "webcam" in event_lower else "Sit-ups"
    else:
        log["type"] = "run"
        log["exercise"] = "run"
        if not log.get("event") or log.get("event") == "Performance Entry" or "camp" in event_lower:
            log["event"] = log.get("event") or "2.4km Run"

    log["name"] = log.get("event", log.get("name", "Performance Entry"))


def ensure_performance_log_schema(db):
    """Scope performance logs by NRIC and normalize workout session log fields."""
    performance_log = db.setdefault("performance_log", [])
    workout_sessions = db.setdefault("workout_sessions", [])

    if workout_sessions:
        _merge_legacy_workout_sessions(performance_log, workout_sessions)

    for unique_id, log in enumerate(performance_log, start=1):
        _normalize_log(log, unique_id)

    db["performance_log"] = performance_log
