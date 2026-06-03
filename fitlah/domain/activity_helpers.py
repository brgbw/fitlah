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

def create_invites_for_group(db, group, invited_nrics):
    created = 0
    sender = current_user()
    invites = list_invites()
    users = list_users()

    for raw_nric in invited_nrics:
        recipient_nric = (raw_nric or "").strip().upper()
        if not recipient_nric or recipient_nric == sender.get("nric"):
            continue

        recipient = next((u for u in users if u.get("nric") == recipient_nric), None)
        already_invited = any(
            invite.get("group_id") == group.get("id")
            and invite.get("recipient_nric") == recipient_nric
            and invite.get("status") == "Pending"
            for invite in invites
        )

        if not recipient or already_invited or user_is_group_member(group.get("id"), recipient_nric):
            continue

        invite = {
            "sender": sender.get("name", "NSman"),
            "sender_nric": sender.get("nric"),
            "recipient_nric": recipient_nric,
            "recipient_name": recipient.get("name", "NSman"),
            "group_id": group.get("id"),
            "group_name": group.get("name"),
            "invited_on": datetime.now().strftime("%Y-%m-%d"),
            "status": "Pending"
        }
        create_invite(group.get("id"), sender.get("nric"), recipient_nric)
        invites.append(invite)
        created += 1

    return created
