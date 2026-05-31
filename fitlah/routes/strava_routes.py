import time
from datetime import datetime
from urllib.parse import urlencode

from flask import jsonify, render_template, request, url_for

from ..app_settings import get_setting, get_settings
from ..auth import current_user, login_required
from ..db import insert_row, next_id, query_db, upsert_row
from ..helpers import update_run_personal_best
from ..strava import (
    StravaApiError,
    build_performance_log,
    exchange_authorization_code,
    fetch_activity,
    fetch_recent_run_activities,
    refresh_access_token,
)


def register_strava_routes(app):
    @app.route("/strava-sync")
    @login_required
    def strava_sync():
        return render_template(
            "strava_sync.html",
            user=current_user(),
            strava_authorize_url=_strava_authorize_url(),
        )

    @app.route("/api/strava-callback", methods=["POST"])
    @login_required
    def api_strava_callback():
        auth_code = (request.get_json() or {}).get("code", "").strip()
        if not auth_code:
            return _error("No authorization code provided.", 400)

        try:
            token_data = exchange_authorization_code(*_strava_credentials(), auth_code)
            _store_token_data(token_data)
            activities = fetch_recent_run_activities(token_data["access_token"])
        except StravaApiError as error:
            return _error(str(error), error.status_code)

        return jsonify({
            "success": True,
            "activities": activities,
            "message": f"Successfully synced {len(activities)} recent runs.",
        })

    @app.route("/api/strava/activities")
    @login_required
    def api_strava_activities():
        try:
            access_token = _valid_access_token()
            activities = fetch_recent_run_activities(access_token)
        except StravaApiError as error:
            return _error(str(error), error.status_code)

        return jsonify({"success": True, "activities": activities})

    @app.route("/api/strava/import", methods=["POST"])
    @login_required
    def api_strava_import():
        activity_id = str((request.get_json() or {}).get("activity_id", "")).strip()
        if not activity_id:
            return _error("No Strava activity id provided.", 400)

        user = current_user()
        if _already_imported(user.get("nric"), activity_id):
            return _error("This Strava activity has already been imported.", 409)

        try:
            activity = fetch_activity(_valid_access_token(), activity_id)
        except StravaApiError as error:
            return _error(str(error), error.status_code)

        log = build_performance_log(activity, user.get("nric"), next_id("performance_log"))
        insert_row("performance_log", log)

        personal_best_updated = False
        if activity["is_ippt_distance"]:
            personal_best_updated = update_run_personal_best(user.get("nric"), activity["time"])

        return jsonify({
            "success": True,
            "log": log,
            "ai_recommendation": log["ai_recommendation"],
            "personal_best_updated": personal_best_updated,
        }), 201


def strava_connection_context():
    return {
        "strava_connected": bool(_token_record()),
        "strava_authorize_url": _strava_authorize_url(),
    }


def _strava_authorize_url():
    client_id = get_setting("strava_client_id")
    if not client_id:
        return ""

    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": _strava_redirect_uri(),
        "approval_prompt": "auto",
        "scope": "activity:read_all",
    }
    return f"https://www.strava.com/oauth/authorize?{urlencode(params)}"


def _strava_redirect_uri():
    return get_setting("strava_redirect_uri") or url_for("strava_sync", _external=True)


def _strava_credentials():
    config = get_settings(["strava_client_id", "strava_client_secret"])
    client_id = config["strava_client_id"]
    client_secret = config["strava_client_secret"]
    if not client_id or not client_secret:
        raise StravaApiError("Strava credentials are not configured in the database.", 500)
    return client_id, client_secret


def _valid_access_token():
    token = _token_record()
    if not token:
        raise StravaApiError("Connect Strava before importing activities.", 401)

    access_token = token.get("access_token")
    refresh_token_value = token.get("refresh_token")
    expires_at = int(token.get("expires_at") or 0)

    if access_token and expires_at > int(time.time()) + 60:
        return access_token

    if access_token and not refresh_token_value:
        return access_token

    if not refresh_token_value:
        raise StravaApiError("Connect Strava before importing activities.", 401)

    token_data = refresh_access_token(*_strava_credentials(), refresh_token_value)
    _store_token_data(token_data)
    return token_data["access_token"]


def _store_token_data(token_data):
    access_token = token_data.get("access_token")
    refresh_token_value = token_data.get("refresh_token")
    if not access_token:
        raise StravaApiError("Strava did not return an access token.", 400)

    existing = _token_record() or {}
    athlete_id = (token_data.get("athlete") or {}).get("id")
    row = {
        "nric": current_user().get("nric"),
        "athlete_id": str(athlete_id or existing.get("athlete_id") or ""),
        "access_token": access_token,
        "refresh_token": refresh_token_value or existing.get("refresh_token", ""),
        "expires_at": int(token_data.get("expires_at") or 0),
        "scope": token_data.get("scope") or existing.get("scope", ""),
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    upsert_row("strava_token", "nric", row)


def _already_imported(nric, activity_id):
    return any(
        str(log.get("strava_activity_id")) == str(activity_id)
        for log in query_db("performance_log", lambda row: row.get("nric") == nric)
    )


def _token_record():
    user = current_user() or {}
    nric = user.get("nric")
    if not nric:
        return None
    return next(
        (row for row in query_db("strava_token", lambda token: token.get("nric") == nric)),
        None,
    )


def _error(message, status_code):
    return jsonify({"success": False, "error": message}), status_code
