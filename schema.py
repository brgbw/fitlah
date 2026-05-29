from datetime import datetime
from werkzeug.security import generate_password_hash

def ensure_auth_tables(db):
    """Ensure every known person has a login record stored in serverdata."""
    db.setdefault("auth_user", [])
    db.setdefault("user", [])

    existing = {u.get("nric", "").upper() for u in db["auth_user"]}
    people = []

    for profile in db["user"]:
        if profile.get("nric"):
            people.append(profile)

    for member in db.get("group_member", []):
        people.append({
            "nric": member.get("nric"),
            "name": member.get("name"),
            "rank": member.get("rank"),
            "unit": "5th Guards"
        })

    for person in people:
        nric = (person.get("nric") or "").strip().upper()
        if not nric or nric in existing:
            continue

        db["auth_user"].append({
            "id": len(db["auth_user"]) + 1,
            "nric": nric,
            "password_hash": generate_password_hash("password123"),
            "password_is_default": True,
            "name": person.get("name") or "NSman",
            "rank": person.get("rank") or "Soldier",
            "unit": person.get("unit") or "Unassigned",
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "last_login": None
        })
        existing.add(nric)

def ensure_group_invite_schema(db):
    """Keep invites addressable by sender, recipient, and group."""
    db.setdefault("group_invite", [])
    db.setdefault("fitness_group", [])

    default_group = db["fitness_group"][0] if db["fitness_group"] else {}
    current_profile = db.get("user", [{}])[0] if db.get("user") else {}
    default_recipient = (current_profile.get("nric") or "S3456789C").upper()

    for invite in db["group_invite"]:
        group_name = invite.get("group_name") or default_group.get("name") or "Training Group"
        matching_group = next((g for g in db["fitness_group"] if g.get("name") == group_name), default_group)
        invite.setdefault("group_id", matching_group.get("id", 1))
        invite.setdefault("group_name", group_name)
        invite.setdefault("sender_nric", "S1234567A")
        invite.setdefault("recipient_nric", default_recipient)
        invite.setdefault("invited_on", datetime.now().strftime("%Y-%m-%d"))
        invite.setdefault("status", "Pending")

def ensure_personal_best_data(db):
    """Store personal bests once per NRIC for display across joined groups."""
    db.setdefault("personal_best", [])
    existing = {pb.get("nric") for pb in db["personal_best"]}

    for member in db.get("group_member", []):
        nric = member.get("nric")
        if not nric or nric in existing:
            continue
        db["personal_best"].append({
            "nric": nric,
            "pushups": member.get("pushups", 0),
            "situps": member.get("situps", 0),
            "run_time": member.get("run_time", "--:--"),
            "updated_at": datetime.now().strftime("%Y-%m-%d")
        })
        existing.add(nric)

    mock_bests = {
        "T1234567A": {"pushups": 48, "situps": 52, "run_time": "12:18"},
        "T0725746A": {"pushups": 62, "situps": 59, "run_time": "10:58"}
    }
    for nric, best in mock_bests.items():
        row = next((pb for pb in db["personal_best"] if pb.get("nric") == nric), None)
        if row:
            row.update(best)
            row["updated_at"] = datetime.now().strftime("%Y-%m-%d")
        else:
            db["personal_best"].append({
                "nric": nric,
                **best,
                "updated_at": datetime.now().strftime("%Y-%m-%d")
            })

def ensure_performance_log_schema(db):
    """Scope performance logs by NRIC, merge workout_sessions into performance_log, and normalize fields."""
    import os
    import json
    
    # 1. Manual check and load of workout_sessions.json if it exists on disk
    base_dir = os.path.dirname(os.path.abspath(__file__))
    workout_sessions_path = os.path.join(base_dir, "serverdata", "workout_sessions.json")
    workout_path = os.path.join(base_dir, "serverdata", "workout.json")
    
    workout_sessions = []
    if os.path.exists(workout_sessions_path):
        try:
            with open(workout_sessions_path, 'r') as f:
                workout_sessions = json.load(f)
        except Exception as e:
            print(f"Error reading workout_sessions.json: {e}")
            
    # Also load performance_log from db
    performance_log = db.setdefault("performance_log", [])
    
    # 2. Perform merge if workout_sessions are found
    if workout_sessions:
        # Index workout_sessions by (nric, video_path) and (nric, session_id)
        sessions_by_video = {}
        sessions_by_id = {}
        for s in workout_sessions:
            nric = s.get("nric")
            vpath = s.get("video_path")
            sid = s.get("id")
            if nric and vpath:
                sessions_by_video[(nric, vpath)] = s
            if nric and sid:
                sessions_by_id[(nric, sid)] = s

        merged_session_ids = set()
        
        # Merge workout_sessions details into existing performance_log entries
        for log in performance_log:
            nric = log.get("nric")
            vpath = log.get("video_path")
            sid = log.get("session_id")
            
            # Find matching session
            session = None
            if nric and vpath and (nric, vpath) in sessions_by_video:
                session = sessions_by_video[(nric, vpath)]
            elif nric and sid and (nric, sid) in sessions_by_id:
                session = sessions_by_id[(nric, sid)]
                
            if session:
                merged_session_ids.add(session.get("id"))
                # Merge fields from session into log
                for field in ["exercise", "started_at", "ended_at", "video_file", "personal_best", "source", "ai_recommendation"]:
                    if field in session and field not in log:
                        log[field] = session[field]
                # If the log's ai_recommendation is null but session has it, copy it
                if not log.get("ai_recommendation") and session.get("ai_recommendation"):
                    log["ai_recommendation"] = session["ai_recommendation"]

        # Add workout_sessions that were not merged
        for s in workout_sessions:
            if s.get("id") not in merged_session_ids:
                exercise = s.get("exercise", "pushup")
                label = s.get("exercise_label", "Push Ups")
                valid_reps = s.get("valid_reps", 0)
                invalid_reps = s.get("invalid_reps", 0)
                duration_seconds = s.get("duration_seconds", 60)
                
                new_log = {
                    "id": 0, # will assign unique ID below
                    "nric": s.get("nric"),
                    "event": f"Webcam {label}",
                    "name": f"Webcam {label}",
                    "type": exercise,
                    "score": f"{valid_reps} reps",
                    "time": f"{duration_seconds // 60}:{duration_seconds % 60:02d} min",
                    "date": s.get("date", datetime.now().strftime("%Y-%m-%d")),
                    "notes": f"Computer vision session. Valid: {valid_reps}, invalid: {invalid_reps}, duration: {duration_seconds}s. Video: {s.get('video_file', '')}.",
                    "exercise": exercise,
                    "valid_reps": valid_reps,
                    "invalid_reps": invalid_reps,
                    "duration_seconds": duration_seconds,
                    "video_path": s.get("video_path"),
                    "ai_recommendation": s.get("ai_recommendation"),
                    "started_at": s.get("started_at"),
                    "ended_at": s.get("ended_at"),
                    "personal_best": s.get("personal_best"),
                    "video_file": s.get("video_file"),
                    "source": s.get("source", "webcam_cv")
                }
                performance_log.append(new_log)

    # 3. Clean up fields, normalize exercises/types to pushup, situp, run
    default_nric = "S3456789C"
    unique_id = 1
    
    for log in performance_log:
        log["id"] = unique_id
        unique_id += 1
        
        log.setdefault("nric", default_nric)
        log.setdefault("time", "")
        log.setdefault("notes", "")
        
        # Determine the normalized type (pushup, situp, run)
        exercise = log.get("exercise") or ""
        event = log.get("event") or ""
        name = log.get("name") or ""
        notes = log.get("notes") or ""
        
        # Lowercase check
        exercise_lower = exercise.lower()
        event_lower = event.lower()
        name_lower = name.lower()
        notes_lower = notes.lower()
        
        if "pushup" in exercise_lower or "push" in event_lower or "push" in name_lower or "push" in notes_lower:
            log["type"] = "pushup"
            log["exercise"] = "pushup"
            log["event"] = "Webcam Push Ups" if "webcam" in event_lower else "Push-ups"
            log["name"] = log["event"]
        elif "situp" in exercise_lower or "sit" in event_lower or "sit" in name_lower or "sit" in notes_lower:
            log["type"] = "situp"
            log["exercise"] = "situp"
            log["event"] = "Webcam Sit Ups" if "webcam" in event_lower else "Sit-ups"
            log["name"] = log["event"]
        else:
            log["type"] = "run"
            log["exercise"] = "run"
            # If name is not descriptive, rename to 2.4km Run
            if not event or event == "Performance Entry" or "camp" in event_lower:
                log["event"] = event or "2.4km Run"
            log["name"] = log["event"]

        if "name" not in log:
            log["name"] = log.get("event", "Performance Entry")
        if "event" not in log:
            log["event"] = log.get("name", "Performance Entry")

    # Save changes to db
    db["performance_log"] = performance_log
    
    # 4. Remove workout_sessions and workout from db if exists
    if "workout_sessions" in db:
        del db["workout_sessions"]
    if "workout" in db:
        del db["workout"]

    # 5. Delete the files from disk on startup
    if os.path.exists(workout_sessions_path):
        try:
            os.remove(workout_sessions_path)
            print("Successfully deleted workout_sessions.json")
        except Exception as e:
            print(f"Error deleting workout_sessions.json: {e}")
            
    if os.path.exists(workout_path):
        try:
            os.remove(workout_path)
            print("Successfully deleted workout.json")
        except Exception as e:
            print(f"Error deleting workout.json: {e}")

