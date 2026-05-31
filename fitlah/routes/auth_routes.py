from datetime import datetime

from flask import redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from ..auth import current_user
from ..constants import SIGNUP_RANKS
from ..ippt_scoring import age_profile_from_nric
from ..profile_age import sync_age_for_nric
from ..repositories import get_user, save_personal_best, save_user, update_last_login
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
            user = get_user(nric)

            if user and check_password_hash(user.get("password_hash", ""), password):
                session["user_nric"] = user["nric"]
                sync_age_for_nric(user["nric"])
                update_last_login(user["nric"])
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
                existing = get_user(nric)
                age_profile = age_profile_from_nric(nric)

                if existing and not existing.get("password_is_default"):
                    error = "This NRIC already has an account. Please log in."
                elif existing:
                    save_user({
                        **existing,
                        "nric": nric,
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
                    save_user({
                        "nric": nric,
                        "password_hash": generate_password_hash(password),
                        "password_is_default": False,
                        "name": name,
                        "rank": rank,
                        "unit": unit,
                        **age_profile,
                        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "last_login": None,
                    })
                    save_personal_best(nric, {"pushups": 0, "situps": 0, "run_time": "--:--"})
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
