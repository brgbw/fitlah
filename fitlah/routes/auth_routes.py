from datetime import datetime

from flask import redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from ..auth import current_user
from ..constants import SIGNUP_RANKS
from ..db import fetch_table, insert_row, next_id, update_row
from ..ippt_scoring import age_profile_from_nric
from ..profile_age import sync_age_for_nric
from ..validators import nric_check


def register_auth_routes(app):
    @app.route("/login", methods=["GET", "POST"])
    def login():
        if current_user():
            return redirect(url_for("dashboard"))

        error = None
        if request.method == "POST":
            nric = request.form.get("nric", "").strip().upper()
            password = request.form.get("password", "")
            user = next((u for u in fetch_table("auth_user") if u.get("nric") == nric), None)

            if user and check_password_hash(user.get("password_hash", ""), password):
                session["user_nric"] = user["nric"]
                sync_age_for_nric(user["nric"])
                update_row("auth_user", "nric", user["nric"], {
                    "last_login": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                })
                return redirect(url_for("dashboard"))

            error = "Invalid NRIC or password."

        return render_template("auth.html", mode="login", error=error)

    @app.route("/signup", methods=["GET", "POST"])
    def signup():
        if current_user():
            return redirect(url_for("dashboard"))

        error = None
        selected_rank = ""
        if request.method == "POST":
            nric = request.form.get("nric", "").strip().upper()
            password = request.form.get("password", "")
            confirm_password = request.form.get("confirm_password", "")
            name = request.form.get("name", "").strip().upper()
            rank = request.form.get("rank", "").strip().upper()
            selected_rank = rank
            unit = request.form.get("unit", "").strip().upper() or "UNASSIGNED"

            if not nric_check(nric):
                error = "Enter a valid NRIC."
            elif rank not in SIGNUP_RANKS:
                error = "Select a valid rank."
            elif not password or len(password) < 6:
                error = "Password must be at least 6 characters."
            elif password != confirm_password:
                error = "Passwords do not match."
            elif not name:
                error = "Enter your name."
            else:
                existing = next((u for u in fetch_table("auth_user") if u.get("nric") == nric), None)
                age_profile = age_profile_from_nric(nric)

                if existing and not existing.get("password_is_default"):
                    error = "This NRIC already has an account. Please log in."
                elif existing:
                    update_row("auth_user", "nric", nric, {
                        "password_hash": generate_password_hash(password),
                        "password_is_default": False,
                        "name": name,
                        "rank": rank,
                        "unit": unit,
                        **age_profile,
                        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    })
                    session["user_nric"] = nric
                    return redirect(url_for("dashboard"))
                else:
                    new_user = {
                        "id": next_id("auth_user"),
                        "nric": nric,
                        "password_hash": generate_password_hash(password),
                        "password_is_default": False,
                        "name": name,
                        "rank": rank,
                        "unit": unit,
                        **age_profile,
                        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "last_login": None,
                    }
                    insert_row("auth_user", new_user)
                    insert_row("user", {
                        "id": next_id("user"),
                        "nric": nric,
                        "name": name,
                        "rank": rank,
                        "unit": unit,
                        **age_profile,
                        "last_login": None,
                    })
                    session["user_nric"] = nric
                    return redirect(url_for("dashboard"))

        return render_template(
            "auth.html",
            mode="signup",
            error=error,
            signup_ranks=SIGNUP_RANKS,
            selected_rank=selected_rank,
        )

    @app.route("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))
