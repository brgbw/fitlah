import re
from datetime import datetime

from flask import current_app, jsonify, render_template, request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from ..core.auth import current_user, login_required
from ..domain.activity_helpers import (
    create_group_invite_for_user,
    find_group,
    user_is_group_member,
)
from ..domain.ippt_scoring import age_profile_from_nric, calculate_from_personal_best
from ..data_access.repositories import (
    add_group_member as repo_add_group_member,
    create_group as repo_create_group,
    list_group_members,
    list_groups,
    list_invites,
    personal_best as repo_personal_best,
    remove_group_member as repo_remove_group_member,
    update_invite,
)
from ..core.web_security import clean_text, json_too_large, rate_limit

QR_TOKEN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
NRIC_PATTERN = re.compile(r"^[STFG]\d{7}[A-Z]$", re.IGNORECASE)


def _qr_serializer():
    return URLSafeTimedSerializer(current_app.secret_key, salt="fitlah-group-invite-qr")


def _int_or_none(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _display_name(value, fallback="NSman"):
    if isinstance(value, dict):
        raw = value.get("name") or ""
        nric = value.get("nric") or ""
    else:
        raw = value or ""
        nric = ""
    name = str(raw).strip()
    if not name or NRIC_PATTERN.match(name) or (nric and name.upper() == str(nric).strip().upper()):
        return fallback
    return name


def _default_best(nric):
    return {
        "nric": nric,
        "pushups": 0,
        "situps": 0,
        "run_time": "--:--",
        "gender": "male",
        **age_profile_from_nric(nric),
        "updated_at": None,
    }


def _member_with_best(member, best_by_nric):
    nric = (member.get("nric") or "").strip().upper()
    best = dict(best_by_nric.get(nric) or _default_best(nric))
    best.update(age_profile_from_nric(nric))
    best["gender"] = member.get("gender") or best.get("gender") or "male"
    score = calculate_from_personal_best(best, best.get("age_group"), best.get("gender"))
    return {
        "id": member.get("id"),
        "group_id": member.get("group_id"),
        "name": _display_name(member),
        "rank": member.get("rank"),
        "personal_best": {
            "pushups": best.get("pushups", 0),
            "situps": best.get("situps", 0),
            "run_time": best.get("run_time", "--:--"),
        },
        "ippt_score": score,
        "ippt_points": score.get("total_points", 0),
        "ippt_award": score.get("award", {}),
        "pushups": best.get("pushups", 0),
        "situps": best.get("situps", 0),
        "run_time": best.get("run_time", "--:--"),
    }


def _public_invite(invite):
    return {
        "id": invite.get("id"),
        "sender": _display_name(invite.get("sender")),
        "group_id": invite.get("group_id"),
        "group_name": invite.get("group_name"),
        "invited_on": invite.get("invited_on"),
        "status": invite.get("status"),
    }


def register_group_routes(app):
    @app.route("/group")
    @login_required
    def group():
        user = current_user()
        sort_order = request.args.get("sort") or "desc"
        reverse_sort = sort_order != "asc"
        user_nric = user.get("nric")
        all_invites = list_invites()
        all_members = list_group_members()
        all_groups = list_groups()
        personal_bests = [repo_personal_best(member.get("nric")) for member in all_members]
        best_by_nric = {
            (best.get("nric") or "").strip().upper(): best
            for best in personal_bests
            if best.get("nric")
        }

        invites = [
            invite for invite in all_invites
            if invite.get("recipient_nric") == user_nric and invite.get("status") == "Pending"
        ]
        joined_group_ids = {
            member.get("group_id")
            for member in all_members
            if member.get("nric") == user_nric
        }
        groups = [group for group in all_groups if group.get("id") in joined_group_ids]

        group_data = []
        for fitness_group in groups:
            group_members = []
            is_creator = fitness_group.get("created_by_nric") == user_nric
            for member in all_members:
                if member.get("group_id") != fitness_group.get("id"):
                    continue
                public_member = _member_with_best(member, best_by_nric)
                public_member["is_current_user"] = member.get("nric") == user_nric
                group_members.append(public_member)
            members = sorted(
                group_members,
                key=lambda x: x.get("ippt_score", {}).get("total_points", 0),
                reverse=reverse_sort,
            )
            public_group = {key: value for key, value in fitness_group.items() if key != "created_by_nric"}
            group_data.append({"group": {**public_group, "is_creator": is_creator}, "members": members})

        return render_template(
            "group_invites.html",
            invites=[_public_invite(invite) for invite in invites],
            group_data=group_data,
            sort_order=sort_order,
        )

    @app.route("/api/leave-group", methods=["POST"])
    @login_required
    @rate_limit("leave-group", 20, 300)
    def leave_group():
        if json_too_large(20000):
            return jsonify({"success": False, "error": "Request body is too large"}), 413
        data = request.get_json() or {}
        group_id = _int_or_none(data.get("group_id"))
        if not group_id:
            return jsonify({"success": False, "error": "Invalid group id"}), 400

        user = current_user()
        if not user_is_group_member(group_id, user.get("nric")):
            return jsonify({"success": False, "error": "Group not found"}), 404

        removed = repo_remove_group_member(group_id, user.get("nric"))
        return jsonify({"success": removed})

    @app.route("/api/accept-invite/<int:invite_id>", methods=["POST"])
    @login_required
    @rate_limit("accept-invite", 30, 300)
    def accept_invite(invite_id):
        user = current_user()
        for invite in list_invites():
            if invite["id"] == invite_id and invite.get("recipient_nric") == user.get("nric"):
                update_invite(invite_id, "accepted")
                group_id = invite.get("group_id")
                if group_id and not user_is_group_member(group_id, user.get("nric")):
                    repo_add_group_member(group_id, user.get("nric"))
                return jsonify({"success": True})
        return jsonify({"success": False, "error": "Invite not found"}), 404

    @app.route("/api/decline-invite/<int:invite_id>", methods=["POST"])
    @login_required
    @rate_limit("decline-invite", 30, 300)
    def decline_invite(invite_id):
        user = current_user()
        for invite in list_invites():
            if invite["id"] == invite_id and invite.get("recipient_nric") == user.get("nric"):
                update_invite(invite_id, "declined")
                return jsonify({"success": True})
        return jsonify({"success": False, "error": "Invite not found"}), 404

    @app.route("/api/group-qr-payload")
    @login_required
    @rate_limit("group-qr-payload", 60, 300)
    def group_qr_payload():
        user = current_user()
        display_name = _display_name(user)
        token = _qr_serializer().dumps({
            "nric": user.get("nric"),
            "name": display_name,
        })
        return jsonify({
            "success": True,
            "payload": token,
            "name": display_name,
        })

    @app.route("/api/pending-invites")
    @login_required
    @rate_limit("pending-invites", 120, 300)
    def pending_invites():
        user = current_user()
        invites = [
            invite for invite in list_invites()
            if invite.get("recipient_nric") == user.get("nric") and invite.get("status") == "Pending"
        ]
        return jsonify({"success": True, "invites": [_public_invite(invite) for invite in invites]})

    @app.route("/api/scan-invite", methods=["POST"])
    @login_required
    @rate_limit("scan-invite", 30, 300)
    def scan_invite():
        if json_too_large(20000):
            return jsonify({"success": False, "error": "Request body is too large"}), 413
        data = request.get_json() or {}
        group_id = data.get("group_id")
        qr_payload = str(data.get("qr_payload") or "").strip()

        if not all([group_id, qr_payload]):
            return jsonify({"success": False, "error": "Missing group or QR payload"}), 400

        try:
            group_id = int(group_id)
        except (TypeError, ValueError):
            return jsonify({"success": False, "error": "Invalid group id"}), 400

        user = current_user()
        if not user_is_group_member(group_id, user.get("nric")):
            return jsonify({"success": False, "error": "Group not found"}), 404

        fitness_group = find_group(group_id)
        if not fitness_group:
            return jsonify({"success": False, "error": "Group not found"}), 404

        try:
            decoded = _qr_serializer().loads(qr_payload, max_age=QR_TOKEN_MAX_AGE_SECONDS)
        except SignatureExpired:
            return jsonify({"success": False, "error": "This QR code has expired. Ask your teammate to refresh it."}), 400
        except BadSignature:
            return jsonify({"success": False, "error": "This QR code is not a valid FitLah invite code."}), 400

        created, result = create_group_invite_for_user(fitness_group, decoded.get("nric"))
        if not created:
            return jsonify({"success": False, "error": result}), 400

        return jsonify({
            "success": True,
            "recipient_name": _display_name(result),
            "group_name": fitness_group.get("name"),
        })

    @app.route("/api/create-group", methods=["POST"])
    @login_required
    @rate_limit("create-group", 10, 300)
    def create_group():
        if json_too_large(20000):
            return jsonify({"success": False, "error": "Request body is too large"}), 413
        data = request.get_json() or {}
        group_name = clean_text(data.get("group_name"), 80)

        if not group_name:
            return jsonify({"success": False, "error": "Group name required"}), 400

        user = current_user()
        group_id = repo_create_group(group_name, user.get("nric"))
        new_group = {
            "id": group_id,
            "name": group_name,
            "created_by": user.get("name", "NSman"),
            "created_date": datetime.now().strftime("%Y-%m-%d"),
        }
        repo_add_group_member(group_id, user.get("nric"))
        return jsonify({"success": True, "group_id": new_group["id"]})
