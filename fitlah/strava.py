from datetime import datetime, timezone

import requests

try:
    import truststore
except ImportError:
    truststore = None
else:
    truststore.inject_into_ssl()


STRAVA_API_BASE_URL = "https://www.strava.com/api/v3"
STRAVA_OAUTH_TOKEN_URL = "https://www.strava.com/oauth/token"
RUN_SPORT_TYPES = {"Run", "TrailRun", "VirtualRun"}
IPPT_RUN_MIN_KM = 2.35
IPPT_RUN_MAX_KM = 2.55


class StravaApiError(Exception):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


def exchange_authorization_code(client_id, client_secret, code):
    return _request_token({
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "grant_type": "authorization_code",
    })


def refresh_access_token(client_id, client_secret, refresh_token):
    return _request_token({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    })


def fetch_recent_run_activities(access_token, per_page=10, page=1):
    activities = _get(
        "/athlete/activities",
        access_token,
        params={"per_page": per_page, "page": page},
    )
    return [
        normalize_activity(activity)
        for activity in activities
        if _is_run_activity(activity)
    ]


def fetch_activity(access_token, activity_id):
    activity = _get(f"/activities/{activity_id}", access_token)
    if not _is_run_activity(activity):
        raise StravaApiError("Only Strava run activities can be imported.", 400)
    return normalize_activity(activity)


def build_performance_log(activity, user_nric, log_id):
    return {
        "id": log_id,
        "nric": user_nric,
        "event": activity["name"],
        "name": activity["name"],
        "type": "run",
        "score": activity["score"],
        "time": activity["time"],
        "date": activity["date"],
        "notes": activity["notes"],
        "exercise": "run",
        "source": "strava",
        "strava_activity_id": str(activity["id"]),
        "distance_km": activity["distance_km"],
        "moving_time": activity["moving_time"],
        "elapsed_time": activity["elapsed_time"],
        "pace": activity["pace"],
        "start_date": activity["start_date"],
        "start_date_local": activity["start_date_local"],
        "ai_recommendation": build_run_recommendation(activity),
    }


def build_run_recommendation(activity):
    if activity["is_ippt_distance"]:
        summary = (
            f"{activity['name']} is close enough to a 2.4km benchmark to use for IPPT tracking. "
            f"The recorded time was {activity['time']} over {activity['distance_km']} km."
        )
        focus = ["controlled first 800m", "steady middle split", "final 600m push"]
    elif activity["pace_seconds_per_km"] and activity["pace_seconds_per_km"] < 300:
        summary = (
            f"{activity['name']} shows strong aerobic speed at {activity['pace']} over "
            f"{activity['distance_km']} km. Keep it as conditioning and add a separate 2.4km test."
        )
        focus = ["2.4km benchmark run", "race-pace intervals", "recovery after hard runs"]
    else:
        summary = (
            f"{activity['name']} adds useful aerobic volume. Pair this with one sharper "
            "IPPT-specific run so readiness is measured against the actual 2.4km distance."
        )
        focus = ["easy-run consistency", "stride economy", "weekly benchmark planning"]

    return {
        "summary": summary,
        "dos": [
            "Use near-2.4km activities as benchmark evidence.",
            "Warm up for 8-10 minutes before hard running.",
            "Track pace trend across repeated efforts, not distance alone.",
        ],
        "donts": [
            "Do not treat a long run time as a direct 2.4km result.",
            "Do not stack hard run days back-to-back without recovery.",
            "Do not ignore elapsed time if the activity includes long stops.",
        ],
        "focus_areas": focus,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def normalize_activity(activity):
    distance_km = round(float(activity.get("distance") or 0) / 1000, 2)
    moving_time = int(activity.get("moving_time") or 0)
    pace_seconds = _pace_seconds_per_km(distance_km, moving_time)
    start_date = activity.get("start_date") or ""
    start_date_local = activity.get("start_date_local") or start_date

    return {
        "id": activity.get("id"),
        "name": activity.get("name") or "Strava Run",
        "distance_km": distance_km,
        "distance": distance_km,
        "moving_time": moving_time,
        "elapsed_time": int(activity.get("elapsed_time") or 0),
        "date": _date_part(start_date_local),
        "start_date": start_date,
        "start_date_local": start_date_local,
        "type": activity.get("sport_type") or activity.get("type") or "Run",
        "pace": _format_pace(pace_seconds),
        "pace_seconds_per_km": pace_seconds,
        "time": _format_duration(moving_time),
        "score": f"{distance_km:.2f} km",
        "is_ippt_distance": IPPT_RUN_MIN_KM <= distance_km <= IPPT_RUN_MAX_KM,
        "notes": _activity_notes(distance_km),
    }


def _request_token(payload):
    try:
        response = requests.post(
            STRAVA_OAUTH_TOKEN_URL,
            data=payload,
            timeout=10,
        )
    except requests.RequestException as error:
        raise StravaApiError(f"Could not reach Strava: {error}", 502) from error

    if not response.ok:
        raise StravaApiError(_strava_error_message(response, "Strava authentication failed."), response.status_code)
    return response.json()


def _get(path, access_token, params=None):
    try:
        response = requests.get(
            f"{STRAVA_API_BASE_URL}{path}",
            headers={"Authorization": f"Bearer {access_token}"},
            params=params,
            timeout=10,
        )
    except requests.RequestException as error:
        raise StravaApiError(f"Could not reach Strava: {error}", 502) from error

    if not response.ok:
        raise StravaApiError(_strava_error_message(response, "Strava request failed."), response.status_code)
    return response.json()


def _is_run_activity(activity):
    return (activity.get("sport_type") or activity.get("type")) in RUN_SPORT_TYPES


def _pace_seconds_per_km(distance_km, moving_time):
    if not distance_km or not moving_time:
        return None
    return int(round(moving_time / distance_km))


def _format_pace(seconds_per_km):
    if not seconds_per_km:
        return "--/km"
    minutes, seconds = divmod(seconds_per_km, 60)
    return f"{minutes}:{seconds:02d}/km"


def _format_duration(total_seconds):
    minutes, seconds = divmod(int(total_seconds or 0), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def _date_part(value):
    if not value:
        return datetime.now(timezone.utc).date().isoformat()
    return value.split("T")[0]


def _activity_notes(distance_km):
    if IPPT_RUN_MIN_KM <= distance_km <= IPPT_RUN_MAX_KM:
        return "Imported from Strava. Near-2.4km activity used for IPPT run tracking."
    return "Imported from Strava. Stored as run training history; not used as a direct 2.4km benchmark."


def _strava_error_message(response, fallback):
    try:
        data = response.json()
    except ValueError:
        return fallback

    message = data.get("message") or fallback
    errors = data.get("errors") or []
    if errors:
        details = ", ".join(
            f"{error.get('field', 'field')} {error.get('code', 'error')}"
            for error in errors
        )
        return f"{message}: {details}"
    return message
