from datetime import datetime

from flask import jsonify, render_template, request

from ..auth import current_user, login_required
from ..db import fetch_table, insert_row, next_id, query_db, update_row
from ..helpers import (
    create_invites_for_group,
    find_group,
    get_personal_best,
    member_with_personal_best,
    user_is_group_member,
)


def _member_row(user, group_id):
    personal_best = get_personal_best(user.get("nric"))
    return {
        "group_id": group_id,
        "nric": user.get("nric"),
        "name": user.get("name", "NSman"),
        "rank": user.get("rank", "Soldier"),
        "pushups": personal_best.get("pushups", 0),
        "situps": personal_best.get("situps", 0),
        "run_time": personal_best.get("run_time", "--:--"),
    }


def register_group_routes(app):
    @app.route("/group")
    @login_required
    def group():
        user = current_user()
        invites = query_db(
            "group_invite",
            lambda x: x.get("recipient_nric") == user.get("nric") and x.get("status") == "Pending",
        )
        joined_group_ids = {
            member.get("group_id")
            for member in query_db("group_member", lambda x: x.get("nric") == user.get("nric"))
        }
        groups = query_db("fitness_group", lambda x: x.get("id") in joined_group_ids)

        group_data = []
        for fitness_group in groups:
            members = sorted(
                [
                    member_with_personal_best(member)
                    for member in query_db("group_member", lambda x: x.get("group_id") == fitness_group.get("id"))
                ],
                key=lambda x: x.get("personal_best", {}).get("pushups", 0),
                reverse=True,
            )
            group_data.append({"group": fitness_group, "members": members})

        return render_template("group_invites.html", invites=invites, group_data=group_data)

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
