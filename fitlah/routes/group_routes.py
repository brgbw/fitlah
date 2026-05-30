from datetime import datetime

from flask import jsonify, render_template, request

from ..auth import current_user, login_required
from ..db import fetch_table, insert_row, next_id, update_row
from ..helpers import (
    create_invites_for_group,
    find_group,
    get_personal_best,
    user_is_group_member,
)
from ..ippt_scoring import age_profile_from_nric, calculate_from_personal_best


def _member_row(user, group_id):
    personal_best = get_personal_best(user.get("nric"))
    return {
        "group_id": group_id,
        "nric": user.get("nric"),
        "name": user.get("name", "NSman"),
        "rank": user.get("rank", "Soldier"),
        **age_profile_from_nric(user.get("nric")),
        "pushups": personal_best.get("pushups", 0),
        "situps": personal_best.get("situps", 0),
        "run_time": personal_best.get("run_time", "--:--"),
    }


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
        all_invites = fetch_table("group_invite")
        all_members = fetch_table("group_member")
        all_groups = fetch_table("fitness_group")
        personal_bests = fetch_table("personal_best")
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
    def accept_invite(invite_id):
        user = current_user()
        for invite in fetch_table("group_invite"):
            if invite["id"] == invite_id and invite.get("recipient_nric") == user.get("nric"):
                update_row("group_invite", "id", invite_id, {"status": "Accepted"})
                group_id = invite.get("group_id")
                if group_id and not user_is_group_member(group_id, user.get("nric")):
                    insert_row("group_member", {
                        "id": next_id("group_member"),
                        **_member_row(user, group_id),
                    })
                break
        return jsonify({"success": True})

    @app.route("/api/decline-invite/<int:invite_id>", methods=["POST"])
    @login_required
    def decline_invite(invite_id):
        user = current_user()
        for invite in fetch_table("group_invite"):
            if invite["id"] == invite_id and invite.get("recipient_nric") == user.get("nric"):
                update_row("group_invite", "id", invite_id, {"status": "Declined"})
                break
        return jsonify({"success": True})

    @app.route("/api/create-group", methods=["POST"])
    @login_required
    def create_group():
        data = request.get_json() or {}
        group_name = data.get("group_name")
        invited_nrics = data.get("invited_nrics", [])

        if not group_name:
            return jsonify({"success": False, "error": "Group name required"}), 400

        user = current_user()
        new_group = {
            "id": next_id("fitness_group"),
            "name": group_name,
            "created_by": user.get("name", "NSman"),
            "created_date": datetime.now().strftime("%Y-%m-%d"),
        }
        insert_row("fitness_group", new_group)
        created_invites = create_invites_for_group(None, new_group, invited_nrics)
        insert_row("group_member", {
            "id": next_id("group_member"),
            **_member_row(user, new_group["id"]),
        })
        return jsonify({"success": True, "group_id": new_group["id"], "invites_created": created_invites})

    @app.route("/api/add-member", methods=["POST"])
    @login_required
    def add_member():
        data = request.get_json() or {}
        group_id = data.get("group_id")
        nric = data.get("nric")

        if not all([group_id, nric]):
            return jsonify({"success": False, "error": "Missing required fields"}), 400

        fitness_group = find_group(int(group_id))
        if not fitness_group:
            return jsonify({"success": False, "error": "Group not found"}), 404

        created = create_invites_for_group(None, fitness_group, [nric])
        if created == 0:
            return jsonify({
                "success": False,
                "error": "Invite already exists, user is already in the group, or NRIC is unknown",
            }), 400

        return jsonify({"success": True, "invites_created": created})
