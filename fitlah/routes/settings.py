from flask import render_template, request, redirect, url_for

from ..core.auth import current_user, login_required
from ..core.config import get_config
from ..core.constants import SIGNUP_RANKS
from ..data_access.repositories import (
    get_setting,
    get_settings,
    set_setting,
    strava_connection,
    update_user,
)
from ..core.web_security import clean_text, rate_limit


def register_settings_routes(app):
    @app.route("/settings", methods=["GET", "POST"])
    @login_required
    @rate_limit("settings", 20, 300)
    def settings():
        user = current_user()
        strava_record = _strava_connection_for_user(user.get("nric"))
        strava_config = get_settings(["strava_client_id", "strava_client_secret"])
        font_scale = _current_font_scale()
        can_update_strava_settings = get_config().allow_strava_settings_write
        error = None
        saved = request.args.get("saved") == "1"

        if request.method == "POST":
            name = request.form.get("name", "").strip()
            rank = request.form.get("rank", "").strip().upper()
            unit = request.form.get("unit", "").strip()
            strava_client_id = request.form.get("strava_client_id", "").strip()
            strava_client_secret = request.form.get("strava_client_secret", "").strip()
            font_scale = _clean_font_scale(request.form.get("font_scale"))
            name = clean_text(name, 80)
            unit = clean_text(unit, 80)

            if not name:
                error = "Enter your name."
            elif rank not in SIGNUP_RANKS:
                error = "Select a valid rank."
            elif (strava_client_id or strava_client_secret) and not can_update_strava_settings:
                error = "Strava app credential updates are disabled on this server."
            else:
                profile_updates = {
                    "name": name,
                    "rank": rank,
                    "unit": unit or "UNASSIGNED",
                }
                update_user(user.get("nric"), profile_updates)
                set_setting("font_scale", f"{font_scale:.2f}")
                if can_update_strava_settings and strava_client_id:
                    set_setting("strava_client_id", strava_client_id)
                if can_update_strava_settings and strava_client_secret:
                    set_setting("strava_client_secret", strava_client_secret)
                elif can_update_strava_settings and not get_setting("strava_client_secret"):
                    set_setting("strava_client_secret", "")
                return redirect(url_for("settings", saved=1))

        return render_template(
            "settings.html",
            user=user,
            strava_connection=strava_record or {},
            strava_config=strava_config,
            has_strava_client_secret=bool(strava_config.get("strava_client_secret")),
            can_update_strava_settings=can_update_strava_settings,
            ranks=SIGNUP_RANKS,
            font_scale=font_scale,
            font_percent=round(font_scale * 100),
            error=error,
            saved=saved,
        )


def _strava_connection_for_user(nric):
    return strava_connection(nric)


def _current_font_scale():
    return _clean_font_scale(get_setting("font_scale", "1"))


def _clean_font_scale(value):
    try:
        scale = float(value)
    except (TypeError, ValueError):
        scale = 1.0
    return min(1.4, max(0.85, scale))
