from datetime import datetime
from ..core.auth import current_user
from .ippt_scoring import age_profile_from_nric
from ..data_access.repositories import (
    create_invite,
    list_group_members,
    list_groups,
    list_invites,
    list_users,
    personal_best,
    update_activity as update_activity_record,
)


def save_ai_recommendation(db, session_id, nric, recommendation):
    """Persist AI coach output on unified activity records."""
    if not recommendation.get("success") or not session_id:
        return False

    ai_data = {
        "summary": recommendation.get("summary", ""),
        "dos": recommendation.get("dos", []),
        "donts": recommendation.get("donts", []),
        "focus_areas": recommendation.get("focus_areas", []),
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    return update_activity_record(session_id, nric, {"ai_recommendation": ai_data})


def find_group(group_id):
    return next((g for g in list_groups() if g.get("id") == group_id), None)

def user_is_group_member(group_id, nric):
    normalized = (nric or "").strip().upper()
    return any(
        m.get("group_id") == group_id and m.get("nric") == normalized
        for m in list_group_members()
    )

def get_personal_best(nric):
    normalized = (nric or "").strip().upper()
    best = personal_best(normalized)
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

def create_group_invite_for_user(group, recipient_nric):
    sender = current_user()
    invites = list_invites()
    users = list_users()
    normalized = (recipient_nric or "").strip().upper()

    if not sender or not normalized:
        return False, "Invitation recipient was not found"
    if normalized == sender.get("nric"):
        return False, "You cannot invite yourself"

    recipient = next((u for u in users if u.get("nric") == normalized), None)
    if not recipient:
        return False, "Invitation recipient was not found"

    already_invited = any(
        invite.get("group_id") == group.get("id")
        and invite.get("recipient_nric") == normalized
        and invite.get("status") == "Pending"
        for invite in invites
    )
    if already_invited:
        return False, "This teammate already has a pending invitation"
    if user_is_group_member(group.get("id"), normalized):
        return False, "This teammate is already in the group"

    create_invite(group.get("id"), sender.get("nric"), normalized)
    return True, recipient.get("name", "NSman")
