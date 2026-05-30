from datetime import datetime

from werkzeug.security import generate_password_hash

from .schemas.performance_log_schema import ensure_performance_log_schema


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
            "unit": "5th Guards",
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
            "last_login": None,
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
            "updated_at": datetime.now().strftime("%Y-%m-%d"),
        })
        existing.add(nric)

    mock_bests = {
        "T1234567A": {"pushups": 48, "situps": 52, "run_time": "12:18"},
        "T0725746A": {"pushups": 62, "situps": 59, "run_time": "10:58"},
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
                "updated_at": datetime.now().strftime("%Y-%m-%d"),
            })

