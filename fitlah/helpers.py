from datetime import datetime
from .db import fetch_table, insert_row, next_id, update_row
from .auth import current_user
from .ippt_scoring import age_profile_from_nric, calculate_from_personal_best, format_run_time, parse_run_time

def update_personal_best(nric, exercise_type, reps):
    if exercise_type not in {"pushup", "situp"}:
        return

    best = get_personal_best(nric)
    best.update(age_profile_from_nric(nric))
    exists = any(pb.get("nric") == nric for pb in fetch_table("personal_best"))

    field = "pushups" if exercise_type == "pushup" else "situps"
    if reps > int(best.get(field) or 0):
        best[field] = reps
        best["updated_at"] = datetime.now().strftime("%Y-%m-%d")
        if exists:
            update_row("personal_best", "nric", best["nric"], best)
        else:
            insert_row("personal_best", best)

        for member in fetch_table("group_member"):
            if member.get("nric") == best["nric"]:
                update_row("group_member", "id", member["id"], {field: reps})


def update_run_personal_best(nric, run_time):
    new_seconds = parse_run_time(run_time)
    if not new_seconds:
        return False

    best = get_personal_best(nric)
    best.update(age_profile_from_nric(nric))
    exists = any(pb.get("nric") == best["nric"] for pb in fetch_table("personal_best"))
    current_seconds = parse_run_time(best.get("run_time"))

    if current_seconds and current_seconds <= new_seconds:
        return False

    best["run_time"] = format_run_time(new_seconds)
    best["updated_at"] = datetime.now().strftime("%Y-%m-%d")
    if exists:
        update_row("personal_best", "nric", best["nric"], best)
    else:
        insert_row("personal_best", best)

    for member in fetch_table("group_member"):
        if member.get("nric") == best["nric"]:
            update_row("group_member", "id", member["id"], {"run_time": best["run_time"]})

    return True

def save_ai_recommendation(db, session_id, nric, recommendation):
    """Persist AI coach output on performance_log entries."""
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
    for log in fetch_table("performance_log"):
        if int(log.get("session_id") or 0) == int(session_id) and log.get("nric") == nric:
            update_row("performance_log", "id", log["id"], {"ai_recommendation": ai_data})
            updated = True

    return updated

def attach_ai_to_performance_logs(db, logs, nric):
    """AI data is now directly on the performance_log records, so this is a pass-through."""
    return logs


def find_auth_user(nric):
    normalized = (nric or "").strip().upper()
    return next((u for u in fetch_table("auth_user") if u.get("nric") == normalized), None)

def find_group(group_id):
    return next((g for g in fetch_table("fitness_group") if g.get("id") == group_id), None)

def user_is_group_member(group_id, nric):
    normalized = (nric or "").strip().upper()
    return any(
        m.get("group_id") == group_id and m.get("nric") == normalized
        for m in fetch_table("group_member")
    )

def get_personal_best(nric):
    normalized = (nric or "").strip().upper()
    best = next((pb for pb in fetch_table("personal_best") if pb.get("nric") == normalized), None)
    if best:
        best.update(age_profile_from_nric(normalized))
        return best
    return {
        "nric": normalized,
        "pushups": 0,
        "situps": 0,
        "run_time": "--:--",
        **age_profile_from_nric(normalized),
        "updated_at": None
    }

def member_with_personal_best(member):
    best = get_personal_best(member.get("nric"))
    score = calculate_from_personal_best(best, best.get("age_group"))
    return {
        **member,
        "age": best.get("age"),
        "age_group": best.get("age_group"),
        "personal_best": best,
        "ippt_score": score,
        "ippt_points": score.get("total_points", 0),
        "ippt_award": score.get("award", {}),
        "pushups": best.get("pushups", 0),
        "situps": best.get("situps", 0),
        "run_time": best.get("run_time", "--:--")
    }

def create_invites_for_group(db, group, invited_nrics):
    created = 0
    sender = current_user()
    invites = fetch_table("group_invite")
    auth_users = fetch_table("auth_user")

    for raw_nric in invited_nrics:
        recipient_nric = (raw_nric or "").strip().upper()
        if not recipient_nric or recipient_nric == sender.get("nric"):
            continue

        recipient = next((u for u in auth_users if u.get("nric") == recipient_nric), None)
        already_invited = any(
            invite.get("group_id") == group.get("id")
            and invite.get("recipient_nric") == recipient_nric
            and invite.get("status") == "Pending"
            for invite in invites
        )

        if not recipient or already_invited or user_is_group_member(group.get("id"), recipient_nric):
            continue

        invite = {
            "id": next_id("group_invite"),
            "sender": sender.get("name", "NSman"),
            "sender_nric": sender.get("nric"),
            "recipient_nric": recipient_nric,
            "recipient_name": recipient.get("name", "NSman"),
            "group_id": group.get("id"),
            "group_name": group.get("name"),
            "invited_on": datetime.now().strftime("%Y-%m-%d"),
            "status": "Pending"
        }
        insert_row("group_invite", invite)
        invites.append(invite)
        created += 1

    return created
