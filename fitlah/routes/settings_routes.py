from datetime import datetime

from flask import render_template, request, redirect, url_for

from ..auth import current_user, login_required
from ..constants import SIGNUP_RANKS
from ..repositories import (
    get_setting,
    get_settings,
    save_strava_connection,
    set_setting,
    strava_connection,
    update_user,
)


def register_settings_routes(app):
    @app.route("/settings", methods=["GET", "POST"])
    @login_required
    def settings():
        user = current_user()
        strava_connection = _strava_connection_for_user(user.get("nric"))
        strava_config = get_settings([
            "strava_client_id",
            "strava_client_secret",
            "strava_redirect_uri",
        ])
        error = None
        saved = request.args.get("saved") == "1"

        if request.method == "POST":
            name = request.form.get("name", "").strip()
            rank = request.form.get("rank", "").strip().upper()
            unit = request.form.get("unit", "").strip()
            strava_user_id = request.form.get("strava_user_id", "").strip()
            strava_api_key = request.form.get("strava_api_key", "").strip()
            strava_client_id = request.form.get("strava_client_id", "").strip()
            strava_client_secret = request.form.get("strava_client_secret", "").strip()
            strava_redirect_uri = request.form.get("strava_redirect_uri", "").strip()

            if not name:
                error = "Enter your name."
            elif rank not in SIGNUP_RANKS:
                error = "Select a valid rank."
            elif not strava_client_id:
                error = "Enter the Strava client ID."
            elif not strava_redirect_uri:
                error = "Enter the Strava redirect URI."
            else:
                profile_updates = {
                    "name": name,
                    "rank": rank,
                    "unit": unit or "UNASSIGNED",
                }
                update_user(user.get("nric"), profile_updates)

                existing_token = strava_connection or {}
                save_strava_connection({
                    "nric": user.get("nric"),
                    "athlete_id": strava_user_id,
                    "access_token": strava_api_key or existing_token.get("access_token", ""),
                    "refresh_token": existing_token.get("refresh_token", ""),
                    "expires_at": int(existing_token.get("expires_at") or 0),
                    "scope": existing_token.get("scope", ""),
                    "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                })
                set_setting("strava_client_id", strava_client_id)
                if strava_client_secret:
                    set_setting("strava_client_secret", strava_client_secret)
                elif not get_setting("strava_client_secret"):
                    set_setting("strava_client_secret", "")
                set_setting("strava_redirect_uri", strava_redirect_uri)
                return redirect(url_for("settings", saved=1))

        return render_template(
            "settings.html",
            user=user,
            strava_connection=strava_connection or {},
            strava_config=strava_config,
            has_strava_client_secret=bool(strava_config.get("strava_client_secret")),
            ranks=SIGNUP_RANKS,
            error=error,
            saved=saved,
        )


def _strava_connection_for_user(nric):
    return strava_connection(nric)
