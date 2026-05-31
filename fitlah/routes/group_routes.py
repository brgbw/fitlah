from datetime import datetime

from flask import jsonify, render_template, request

from ..auth import current_user, login_required
from ..helpers import (
    create_invites_for_group,
    find_group,
    get_personal_best,
    user_is_group_member,
)
from ..ippt_scoring import age_profile_from_nric, calculate_from_personal_best
from ..repositories import (
    add_group_member as repo_add_group_member,
    create_group as repo_create_group,
    list_group_members,
    list_groups,
    list_invites,
    personal_best as repo_personal_best,
    update_invite,
)
from ..security import clean_text, json_too_large, rate_limit
from ..validators import nric_check


def _default_best(nric):
    return {
        "nric": nric,
        "pushups": 0,
        "situps": 0,
        "run_time": "--:--",
        **age_profile_from_nric(nric),
        "updated_at": None,
    }


def _member_with_best(member, best_by_nric):
    nric = (member.get("nric") or "").strip().upper()
    best = dict(best_by_nric.get(nric) or _default_best(nric))
    best.update(age_profile_from_nric(nric))
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
        "run_time": best.get("run_time", "--:--"),
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
            group_members = [
                _member_with_best(member, best_by_nric)
                for member in all_members
                if member.get("group_id") == fitness_group.get("id")
            ]
            members = sorted(
                group_members,
                key=lambda x: x.get("ippt_score", {}).get("total_points", 0),
                reverse=reverse_sort,
            )
            group_data.append({"group": fitness_group, "members": members})

        return render_template(
            "group_invites.html",
            invites=invites,
            group_data=group_data,
            sort_order=sort_order,
        )

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

    @app.route("/api/create-group", methods=["POST"])
    @login_required
    @rate_limit("create-group", 10, 300)
    def create_group():
        if json_too_large(20000):
            return jsonify({"success": False, "error": "Request body is too large"}), 413
        data = request.get_json() or {}
        group_name = clean_text(data.get("group_name"), 80)
        invited_nrics = data.get("invited_nrics", [])
        if not isinstance(invited_nrics, list):
            invited_nrics = []
        invited_nrics = [
            str(nric).strip().upper()
            for nric in invited_nrics[:20]
            if nric_check(str(nric).strip().upper())
        ]

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
        created_invites = create_invites_for_group(None, new_group, invited_nrics)
        repo_add_group_member(group_id, user.get("nric"))
        return jsonify({"success": True, "group_id": new_group["id"], "invites_created": created_invites})

    @app.route("/api/add-member", methods=["POST"])
    @login_required
    @rate_limit("add-member", 20, 300)
    def add_member():
        if json_too_large(20000):
            return jsonify({"success": False, "error": "Request body is too large"}), 413
        data = request.get_json() or {}
        group_id = data.get("group_id")
        nric = str(data.get("nric") or "").strip().upper()

        if not all([group_id, nric]):
            return jsonify({"success": False, "error": "Missing required fields"}), 400
        if not nric_check(nric):
            return jsonify({"success": False, "error": "Invalid NRIC"}), 400

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

        created = create_invites_for_group(None, fitness_group, [nric])
        if created == 0:
            return jsonify({
                "success": False,
                "error": "Invite already exists, user is already in the group, or NRIC is unknown",
            }), 400

        return jsonify({"success": True, "invites_created": created})
