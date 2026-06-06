import time
from datetime import datetime
from urllib.parse import urlencode, urlparse

from flask import g, jsonify, render_template, request, url_for

from ..integrations.ai_coach import generate_ippt_run_recommendation
from ..core.auth import current_user, login_required
from ..core.config import get_config
from ..core.responses import api_error
from ..domain.ippt_scoring import age_profile_from_nric, run_station_points
from ..data_access.repositories import (
    create_activity as create_activity_record,
    delete_strava_connection,
    get_setting,
    get_settings,
    link_strava_ippt_activity_record,
    personal_best as repo_personal_best,
    recalculate_personal_best,
    save_strava_connection,
    save_strava_ippt_result,
    strava_activity_record,
    strava_connection,
    strava_ippt_result,
    update_activity,
    update_strava_activity_ippt_result,
    update_strava_activity_record,
    update_strava_ippt_recommendation,
)
from ..core.web_security import json_too_large, limit_structure, rate_limit
from ..integrations.strava_client import (
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

    @app.route("/previewstravarun")
    @login_required
    def preview_strava_run():
        return render_template(
            "preview_strava_run.html",
            user=current_user(),
            activity_id=str(request.args.get("activity_id", "")).strip(),
            **strava_connection_context(),
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
            user = current_user()
            cache_key = ("activities", user.get("nric"))
            activities = _cache_get(cache_key)
            if activities is None:
                access_token = _valid_access_token()
                activities = fetch_recent_run_activities(access_token)
                _cache_set(cache_key, activities)
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
            activity, streams = _cached_activity_preview(current_user().get("nric"), activity_id)
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
                ai_recommendation=data.get("ai_recommendation"),
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
            result = _cached_ippt_result(nric, activity_id, user)
            activity_for_log, _ = _cached_activity_preview(nric, activity_id)
        except StravaApiError as error:
            return _error(str(error), error.status_code)

        imported = _import_strava_activity(
            nric,
            activity_id,
            activity=activity_for_log,
        )
        result = dict(result)
        result["activity_record_id"] = imported["log"].get("id")
        result["ai_recommendation"] = _cache_get(("ippt_recommendation", nric, activity_id))

        previous_best = repo_personal_best(nric)
        saved_result = save_strava_ippt_result(nric, result)
        if result.get("ai_recommendation") and imported["log"].get("id"):
            update_activity(imported["log"]["id"], nric, {"ai_recommendation": result["ai_recommendation"]})
            imported["log"]["ai_recommendation"] = result["ai_recommendation"]
        updated_log = update_strava_activity_ippt_result(nric, activity_id, saved_result)
        if updated_log:
            if result.get("ai_recommendation"):
                updated_log["ai_recommendation"] = result["ai_recommendation"]
            imported["log"] = updated_log
        personal_best_updated = False
        personal_best = previous_best
        if result["status"] != "invalid":
            personal_best = recalculate_personal_best(nric)
            personal_best_updated = (previous_best or {}).get("run_time") != (personal_best or {}).get("run_time")

        return jsonify({
            "success": True,
            "result": saved_result,
            "log": imported["log"],
            "created": imported["created"],
            "personal_best_updated": personal_best_updated,
            "personal_best": personal_best,
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
            result = _cached_ippt_result(nric, activity_id, user)
            _, streams = _cached_activity_details(nric, activity_id)
        except StravaApiError as error:
            return _error(str(error), error.status_code)

        age_group = user.get("age_group") or age_profile_from_nric(nric).get("age_group")

        recommendation = _cached_ippt_recommendation(nric, activity_id, result, age_group, streams)

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

        age_group = user.get("age_group") or age_profile_from_nric(nric).get("age_group")
        recommendation = (result or {}).get("ai_recommendation") or _cache_get(("ippt_recommendation", nric, activity_id))
        streams = None
        if recommendation is None and result:
            try:
                _, streams = _cached_activity_details(nric, activity_id)
            except StravaApiError:
                streams = None
            recommendation = _build_ippt_recommendation(result, age_group, streams)
        elif recommendation is None:
            try:
                result = _cached_ippt_result(nric, activity_id, user)
                _, streams = _cached_activity_details(nric, activity_id)
            except StravaApiError as error:
                return _error(str(error), error.status_code)
            recommendation = _build_ippt_recommendation(result, age_group, streams)
        _cache_set(("ippt_recommendation", nric, activity_id), recommendation)

        saved_result = update_strava_ippt_recommendation(nric, activity_id, recommendation) if strava_ippt_result(nric, activity_id) else result
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


def _cache_get(key):
    return getattr(g, "_strava_request_cache", {}).get(key)


def _cache_set(key, value):
    if not hasattr(g, "_strava_request_cache"):
        g._strava_request_cache = {}
    g._strava_request_cache[key] = value
    return value


def _cached_activity_preview(nric, activity_id):
    cache_key = ("activity_preview", nric, activity_id)
    cached = _cache_get(cache_key)
    if cached:
        return cached

    access_token = _valid_access_token()
    activity = fetch_activity(access_token, activity_id)
    streams = fetch_activity_streams(access_token, activity_id)
    return _cache_set(cache_key, (activity, streams))


def _cached_activity_details(nric, activity_id):
    cache_key = ("activity_details", nric, activity_id)
    cached = _cache_get(cache_key)
    if cached:
        return cached

    preview = _cache_get(("activity_preview", nric, activity_id))
    cached_streams = preview[1] if preview else None
    access_token = _valid_access_token()
    activity = fetch_activity_details(access_token, activity_id)
    streams = cached_streams or fetch_activity_streams(access_token, activity_id)
    return _cache_set(cache_key, (activity, streams))


def _cached_ippt_result(nric, activity_id, user):
    cache_key = ("ippt_result", nric, activity_id)
    cached = _cache_get(cache_key)
    if cached:
        return dict(cached)

    saved = strava_ippt_result(nric, activity_id)
    if saved:
        return dict(_cache_set(cache_key, saved))

    activity, streams = _cached_activity_details(nric, activity_id)
    result = process_ippt_24(activity, streams)
    age_group = user.get("age_group") or age_profile_from_nric(nric).get("age_group")
    result["run_points"] = run_station_points(result["official_time_seconds"], age_group)
    return dict(_cache_set(cache_key, result))


def _cached_ippt_recommendation(nric, activity_id, result, age_group, streams=None):
    cache_key = ("ippt_recommendation", nric, activity_id)
    recommendation = _cache_get(cache_key)
    if recommendation is not None:
        return recommendation
    if result and result.get("ai_recommendation"):
        return _cache_set(cache_key, result["ai_recommendation"])

    return _cache_set(cache_key, _build_ippt_recommendation(result, age_group, streams))


def _build_ippt_recommendation(result, age_group, streams=None):
    recommendation = generate_ippt_run_recommendation(_ippt_ai_summary(result, age_group, streams))
    return recommendation if recommendation.get("success") else None


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
    config = get_config()
    explicit_uri = config.strava_redirect_uri
    if explicit_uri:
        return explicit_uri

    if config.public_base_url:
        return f"{config.public_base_url}{url_for('strava_sync')}"

    stored_uri = (get_setting("strava_redirect_uri") or "").strip().rstrip("/")
    if stored_uri:
        return stored_uri

    return f"{_external_base_url()}{url_for('strava_sync')}"


def _external_base_url():
    forwarded_host = (request.headers.get("X-Forwarded-Host") or "").split(",")[0].strip()
    forwarded_proto = (request.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip()
    host = forwarded_host or request.host
    scheme = forwarded_proto or request.scheme

    origin = (request.headers.get("Origin") or "").strip().rstrip("/")
    parsed_origin = urlparse(origin)
    if parsed_origin.scheme and parsed_origin.netloc:
        scheme = parsed_origin.scheme
        host = parsed_origin.netloc

    return f"{scheme}://{host}".rstrip("/")


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
        if activity:
            payload = build_activity_record(activity, nric)
            if ai_recommendation:
                payload["ai_recommendation"] = limit_structure(ai_recommendation, max_depth=4, max_items=20)
            imported_log = update_strava_activity_record(nric, activity_id, payload) or imported_log
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
    return {
        "log": log,
        "created": True,
        "personal_best_updated": False,
    }


def _ippt_ai_summary(result, age_group, streams=None):
    details = result.get("details") or {}
    summary = {
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
        "elapsedTime": details.get("elapsed_time") or int(details.get("elapsed_time") or 0),
        "movingTime": details.get("moving_time") or int(details.get("moving_time") or 0),
        "averageSpeed": round(float(details.get("average_speed") or 0), 3),
        "maxSpeed": round(float(details.get("max_speed") or 0), 3),
    }
    if streams:
        csv = _compact_stream_csv(streams)
        if csv:
            summary["streamCSV"] = csv
    return summary


def _compact_stream_csv(streams):
    """Downsample streams to ~every 100m for a token-efficient CSV."""
    time_s = streams.get("time") or []
    dist_s = streams.get("distance") or []
    vel_s = streams.get("velocity_smooth") or []
    mov_s = streams.get("moving") or []
    cad_s = streams.get("cadence") or []
    if len(time_s) < 2 or len(dist_s) < 2:
        return ""

    header = "dist_m,time_s,speed_mps,cadence,moving"
    rows = []
    next_mark = 0
    step = 100
    n = min(len(time_s), len(dist_s))
    for i in range(n):
        d = float(dist_s[i])
        if d >= next_mark:
            t = int(time_s[i])
            v = round(float(vel_s[i]), 2) if i < len(vel_s) else ""
            c = int(cad_s[i]) if i < len(cad_s) and cad_s[i] is not None else ""
            m = 1 if (i >= len(mov_s) or mov_s[i]) else 0
            rows.append(f"{int(d)},{t},{v},{c},{m}")
            next_mark = d + step
            if d >= 2400:
                break
    return header + "\n" + "\n".join(rows) if rows else ""


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
    return api_error(message, status_code)
