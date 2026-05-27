from datetime import datetime
from db import get_db
from auth import current_user

def update_personal_best(nric, exercise_type, reps):
    if exercise_type not in {"pushup", "situp"}:
        return

    db = get_db()
    best = get_personal_best(nric)
    if not any(pb.get("nric") == nric for pb in db.get("personal_best", [])):
        db.setdefault("personal_best", []).append(best)

    field = "pushups" if exercise_type == "pushup" else "situps"
    if reps > int(best.get(field) or 0):
        best[field] = reps
        best["updated_at"] = datetime.now().strftime("%Y-%m-%d")

def save_ai_recommendation(db, session_id, nric, recommendation):
    """Persist AI coach output on workout_sessions and linked performance_log."""
    if not recommendation.get("success") or not session_id:
        return False

    ai_data = {
        "summary": recommendation.get("summary", ""),
        "dos": recommendation.get("dos", []),
        "donts": recommendation.get("donts", []),
        "focus_areas": recommendation.get("focus_areas", []),
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    updated = False
    for session in db.get("workout_sessions", []):
        if session.get("id") == session_id and session.get("nric") == nric:
            session["ai_recommendation"] = ai_data
            updated = True
            break

    for log in db.get("performance_log", []):
        if log.get("session_id") == session_id and log.get("nric") == nric:
            log["ai_recommendation"] = ai_data
            updated = True

    return updated

def attach_ai_to_performance_logs(db, logs, nric):
    """Join performance logs with AI data from workout_sessions when needed."""
    sessions_by_id = {
        s.get("id"): s
        for s in db.get("workout_sessions", [])
        if s.get("nric") == nric
    }
    enriched = []
    for log in logs:
        row = dict(log)
        if not row.get("ai_recommendation"):
            session = sessions_by_id.get(row.get("session_id"))
            if session and session.get("ai_recommendation"):
                row["ai_recommendation"] = session["ai_recommendation"]
        enriched.append(row)
    return enriched

def find_auth_user(nric):
    normalized = (nric or "").strip().upper()
    db = get_db()
    return next((u for u in db.get("auth_user", []) if u.get("nric") == normalized), None)

def find_group(group_id):
    db = get_db()
    return next((g for g in db.get("fitness_group", []) if g.get("id") == group_id), None)

def user_is_group_member(group_id, nric):
    normalized = (nric or "").strip().upper()
    db = get_db()
    return any(
        m.get("group_id") == group_id and m.get("nric") == normalized
        for m in db.get("group_member", [])
    )

def get_personal_best(nric):
    normalized = (nric or "").strip().upper()
    db = get_db()
    best = next((pb for pb in db.get("personal_best", []) if pb.get("nric") == normalized), None)
    if best:
        return best
    return {
        "nric": normalized,
        "pushups": 0,
        "situps": 0,
        "run_time": "--:--",
        "updated_at": None
    }

def member_with_personal_best(member):
    best = get_personal_best(member.get("nric"))
    return {
        **member,
        "personal_best": best,
        "pushups": best.get("pushups", 0),
        "situps": best.get("situps", 0),
        "run_time": best.get("run_time", "--:--")
    }

def create_invites_for_group(db, group, invited_nrics):
    created = 0
    sender = current_user()
    db.setdefault("group_invite", [])
    db.setdefault("group_member", [])

    for raw_nric in invited_nrics:
        recipient_nric = (raw_nric or "").strip().upper()
        if not recipient_nric or recipient_nric == sender.get("nric"):
            continue

        recipient = next((u for u in db.get("auth_user", []) if u.get("nric") == recipient_nric), None)
        already_invited = any(
            invite.get("group_id") == group.get("id")
            and invite.get("recipient_nric") == recipient_nric
            and invite.get("status") == "Pending"
            for invite in db["group_invite"]
        )

        if not recipient or already_invited or user_is_group_member(group.get("id"), recipient_nric):
            continue

        db["group_invite"].append({
            "id": max([i.get("id", 0) for i in db["group_invite"]], default=0) + 1,
            "sender": sender.get("name", "NSman"),
            "sender_nric": sender.get("nric"),
            "recipient_nric": recipient_nric,
            "recipient_name": recipient.get("name", "NSman"),
            "group_id": group.get("id"),
            "group_name": group.get("name"),
            "invited_on": datetime.now().strftime("%Y-%m-%d"),
            "status": "Pending"
        })
        created += 1

    return created
