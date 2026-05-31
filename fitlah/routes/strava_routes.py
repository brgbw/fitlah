import time
from datetime import datetime
from urllib.parse import urlencode

from flask import jsonify, render_template, request, url_for

from ..ai_coach import generate_ippt_run_recommendation
from ..auth import current_user, login_required
from ..helpers import update_run_personal_best
from ..ippt_scoring import age_profile_from_nric, run_station_points
from ..repositories import (
    create_activity as create_activity_record,
    delete_strava_connection,
    get_setting,
    get_settings,
    link_strava_ippt_activity_record,
    save_strava_connection,
    save_strava_ippt_result,
    strava_activity_record,
    strava_connection,
    strava_ippt_result,
    update_activity,
    update_strava_ippt_recommendation,
)
from ..security import json_too_large, limit_structure, rate_limit
from ..strava import (
    StravaApiError,
    build_activity_record,
    exchange_authorization_code,
    fetch_activity,
    fetch_activity_details,
    fetch_activity_streams,
    fetch_recent_run_activities,
    process_ippt_24,
    refresh_access_token,
)


def register_strava_routes(app):
    @app.route("/strava-sync")
    @login_required
    def strava_sync():
        return render_template(
            "strava_sync.html",
            user=current_user(),
            strava_connected=bool(_token_record()),
            strava_authorize_url=_strava_authorize_url(),
        )

    @app.route("/api/strava-callback", methods=["POST"])
    @login_required
    @rate_limit("strava-callback", 8, 300)
    def api_strava_callback():
        if json_too_large(20000):
            return _error("Request body is too large.", 413)
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

    @app.route("/api/strava/activity-preview", methods=["POST"])
    @login_required
    @rate_limit("strava-preview", 30, 300)
    def api_strava_activity_preview():
        if json_too_large(20000):
            return _error("Request body is too large.", 413)
        activity_id = str((request.get_json() or {}).get("activity_id", "")).strip()
        if not activity_id:
            return _error("No Strava activity id provided.", 400)

        try:
            access_token = _valid_access_token()
            activity = fetch_activity(access_token, activity_id)
            streams = fetch_activity_streams(access_token, activity_id)
        except StravaApiError as error:
            return _error(str(error), error.status_code)

        return jsonify({"success": True, "activity": activity, "streams": streams})

    @app.route("/api/strava/import", methods=["POST"])
    @login_required
    @rate_limit("strava-import", 20, 300)
    def api_strava_import():
        if json_too_large(20000):
            return _error("Request body is too large.", 413)
        data = request.get_json() or {}
        activity_id = str(data.get("activity_id", "")).strip()
        if not activity_id:
            return _error("No Strava activity id provided.", 400)

        try:
            imported = _import_strava_activity(
                current_user().get("nric"),
                activity_id,
            )
        except StravaApiError as error:
            return _error(str(error), error.status_code)

        return jsonify({
            "success": True,
            "log": imported["log"],
            "created": imported["created"],
            "ai_recommendation": imported["log"].get("ai_recommendation"),
            "personal_best_updated": imported["personal_best_updated"],
        }), 201 if imported["created"] else 200

    @app.route("/api/strava/ippt-24", methods=["POST"])
    @login_required
    @rate_limit("strava-ippt", 20, 300)
    def api_strava_ippt_24():
        if json_too_large(20000):
            return _error("Request body is too large.", 413)
        data = request.get_json() or {}
        activity_id = str(data.get("activity_id", "")).strip()
        if not activity_id:
            return _error("No Strava activity id provided.", 400)

        user = current_user()
        nric = user.get("nric")

        try:
            access_token = _valid_access_token()
            activity_for_log = fetch_activity(access_token, activity_id)
            activity = fetch_activity_details(access_token, activity_id)
            streams = fetch_activity_streams(access_token, activity_id)
            result = process_ippt_24(activity, streams)
        except StravaApiError as error:
            return _error(str(error), error.status_code)

        imported = _import_strava_activity(
            nric,
            activity_id,
            activity=activity_for_log,
        )
        age_group = user.get("age_group") or age_profile_from_nric(nric).get("age_group")
        result["run_points"] = run_station_points(result["official_time_seconds"], age_group)
        result["activity_record_id"] = imported["log"].get("id")
        result["ai_recommendation"] = None

        saved_result = save_strava_ippt_result(nric, result)
        personal_best_updated = False
        if result["status"] == "verified":
            personal_best_updated = update_run_personal_best(nric, result["official_time"])

        return jsonify({
            "success": True,
            "result": saved_result,
            "log": imported["log"],
            "created": imported["created"],
            "personal_best_updated": personal_best_updated,
        })
    @app.route("/api/strava/ippt-24/preview", methods=["POST"])
    @login_required
    @rate_limit("strava-ippt-preview", 20, 300)
    def api_strava_ippt_24_preview():
        if json_too_large(20000):
            return _error("Request body is too large.", 413)
        activity_id = str((request.get_json() or {}).get("activity_id", "")).strip()
        if not activity_id:
            return _error("No Strava activity id provided.", 400)

        user = current_user()
        nric = user.get("nric")

        try:
            access_token = _valid_access_token()
            activity = fetch_activity_details(access_token, activity_id)
            streams = fetch_activity_streams(access_token, activity_id)
            result = process_ippt_24(activity, streams)
        except StravaApiError as error:
            return _error(str(error), error.status_code)

        age_group = user.get("age_group") or age_profile_from_nric(nric).get("age_group")
        result["run_points"] = run_station_points(result["official_time_seconds"], age_group)

        # Generate AI recommendation (preview only, do not persist)
        recommendation = generate_ippt_run_recommendation(_ippt_ai_summary(result, age_group))
        if not recommendation.get("success") or not recommendation.get("summary"):
            recommendation = _fallback_ippt_recommendation(result)

        return jsonify({"success": True, "result": result, "recommendation": recommendation})

    @app.route("/api/strava/ippt-24/recommendation", methods=["POST"])
    @login_required
    @rate_limit("strava-ippt-ai", 15, 300)
    def api_strava_ippt_24_recommendation():
        if json_too_large(20000):
            return _error("Request body is too large.", 413)
        activity_id = str((request.get_json() or {}).get("activity_id", "")).strip()
        if not activity_id:
            return _error("No Strava activity id provided.", 400)

        user = current_user()
        nric = user.get("nric")
        result = strava_ippt_result(nric, activity_id)
        if not result:
            return _error("Calculate the 2.4km result before asking Coach.", 404)

        age_group = user.get("age_group") or age_profile_from_nric(nric).get("age_group")
        recommendation = generate_ippt_run_recommendation(_ippt_ai_summary(result, age_group))
        if not recommendation.get("success") or not recommendation.get("recommendations"):
            recommendation = _fallback_ippt_recommendation(result)

        saved_result = update_strava_ippt_recommendation(nric, activity_id, recommendation)
        return jsonify({
            "success": True,
            "result": saved_result,
            "ai_recommendation": recommendation,
        })


def strava_connection_context():
    return {
        "strava_connected": bool(_usable_token_record()),
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
    if access_token and access_token == get_setting("strava_client_secret"):
        delete_strava_connection(current_user().get("nric"))
        raise StravaApiError("Reconnect Strava before importing activities.", 401)

    if access_token and not refresh_token_value:
        delete_strava_connection(current_user().get("nric"))
        raise StravaApiError("Reconnect Strava before importing activities.", 401)

    if not refresh_token_value:
        delete_strava_connection(current_user().get("nric"))
        raise StravaApiError("Connect Strava before importing activities.", 401)

    if access_token and expires_at > int(time.time()) + 60:
        return access_token

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
    save_strava_connection(row)


def _import_strava_activity(nric, activity_id, ai_recommendation=None, activity=None):
    imported_log = strava_activity_record(nric, activity_id)
    if imported_log:
        if ai_recommendation:
            ai_recommendation = limit_structure(ai_recommendation, max_depth=4, max_items=20)
            update_activity(imported_log["id"], nric, {"ai_recommendation": ai_recommendation})
            imported_log["ai_recommendation"] = ai_recommendation
        link_strava_ippt_activity_record(nric, activity_id, imported_log.get("id"))
        return {
            "log": imported_log,
            "created": False,
            "personal_best_updated": False,
        }

    activity = activity or fetch_activity(_valid_access_token(), activity_id)
    payload = build_activity_record(activity, nric)
    if ai_recommendation:
        payload["ai_recommendation"] = ai_recommendation

    log = create_activity_record(payload)
    link_strava_ippt_activity_record(nric, activity_id, log.get("id"))
    personal_best_updated = False
    if activity["is_ippt_distance"]:
        personal_best_updated = update_run_personal_best(nric, activity["time"])

    return {
        "log": log,
        "created": True,
        "personal_best_updated": personal_best_updated,
    }


def _ippt_ai_summary(result, age_group):
    return {
        "activityName": result.get("activity_name"),
        "ageGroup": age_group,
        "officialTime": result.get("official_time"),
        "runPoints": result.get("run_points"),
        "validityScore": result.get("validity_score"),
        "status": result.get("status"),
        "extraDistanceIgnoredM": result.get("extra_distance_m"),
        "pacingTrend": result.get("pacing_trend"),
        "splits": result.get("splits"),
        "validationFlags": result.get("validation_flags"),
    }


def _fallback_ippt_recommendation(result):
    trend = result.get("pacing_trend") or "even pace"
    official_time = result.get("official_time") or "--:--"
    if trend == "slowed down":
        summary = f"2.4km recorded at {official_time}. Pace faded late, so the next block should protect the final 800m."
        strength = "Early speed is available."
        weakness = "Late pace fade after halfway."
        actions = [
            "Open the first 800m slightly easier",
            "Run 6 x 400m at goal pace",
            "Add one weekly easy aerobic run",
        ]
    elif trend == "negative split":
        summary = f"2.4km recorded at {official_time}. The finish was strong, so the next gain is committing earlier."
        strength = "Strong finish and controlled pacing."
        weakness = "Could reach goal pace earlier."
        actions = [
            "Reach goal pace by the second 400m",
            "Finish intervals with one fast rep",
            "Keep easy days genuinely easy",
        ]
    else:
        summary = f"2.4km recorded at {official_time}. Pacing was steady; improve by making goal pace feel easier."
        strength = "Steady pacing profile."
        weakness = "Needs more race-pace efficiency."
        actions = [
            "Repeat 400m intervals at target split",
            "Use a 1200m tempo for rhythm",
            "Retest after one recovery day",
        ]
    return {
        "success": True,
        "summary": summary,
        "strength": strength,
        "weakness": weakness,
        "recommendations": actions,
        "safetyNote": "Stop hard efforts if chest pain, dizziness, or unusual breathlessness appears.",
    }


def _token_record():
    user = current_user() or {}
    nric = user.get("nric")
    if not nric:
        return None
    return strava_connection(nric)


def _usable_token_record():
    token = _token_record()
    if not token:
        return None
    if not token.get("access_token") or not token.get("refresh_token"):
        return None
    if token.get("access_token") == get_setting("strava_client_secret"):
        return None
    return token



def _error(message, status_code):
    return jsonify({"success": False, "error": message}), status_code
