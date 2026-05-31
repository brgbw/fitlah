from datetime import datetime, timezone
from math import atan2, cos, radians, sin, sqrt
import logging

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
IPPT_DISTANCE_M = 2400
IPPT_SPLIT_MARKS_M = (400, 800, 1200, 1600, 2000, 2400)
logger = logging.getLogger(__name__)


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


def fetch_activity_details(access_token, activity_id):
    activity = _get(f"/activities/{activity_id}", access_token)
    return {
        "id": activity.get("id"),
        "name": activity.get("name") or "Strava Run",
        "distance": float(activity.get("distance") or 0),
        "elapsed_time": int(activity.get("elapsed_time") or 0),
        "moving_time": int(activity.get("moving_time") or 0),
        "sport_type": activity.get("sport_type") or activity.get("type") or "",
        "manual": bool(activity.get("manual")),
        "trainer": bool(activity.get("trainer")),
        "average_speed": float(activity.get("average_speed") or 0),
        "max_speed": float(activity.get("max_speed") or 0),
        "start_date": activity.get("start_date") or "",
        "start_date_local": activity.get("start_date_local") or activity.get("start_date") or "",
    }


def fetch_activity_streams(access_token, activity_id):
    streams = _get(
        f"/activities/{activity_id}/streams",
        access_token,
        params={
            "keys": "time,distance,latlng,velocity_smooth,moving",
            "key_by_type": "true",
        },
    )
    return {
        key: (streams.get(key) or {}).get("data") or []
        for key in ("time", "distance", "latlng", "velocity_smooth", "moving")
    }


def build_activity_record(activity, user_nric):
    return {
        "nric": user_nric,
        "event": activity["name"],
        "name": activity["name"],
        "title": activity["name"],
        "type": "run",
        "score": activity["score"],
        "time": activity["time"],
        "date": activity["date"],
        "notes": activity["notes"],
        "exercise": "run",
        "source": "strava",
        "source_external_id": str(activity["id"]),
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


def process_ippt_24(activity, streams):
    validation = validate_ippt_activity(activity, streams)
    if validation["status"] == "invalid":
        raise StravaApiError("; ".join(validation["flags"]) or "This activity cannot be used for IPPT 2.4km.", 422)

    official_seconds = interpolate_time_at_distance(streams, IPPT_DISTANCE_M)
    if official_seconds is None:
        raise StravaApiError("Strava streams do not cross 2400m.", 422)

    splits = [
        {
            "distance_m": mark,
            "time_seconds": int(round(interpolate_time_at_distance(streams, mark) or official_seconds)),
            "time": _format_duration(int(round(interpolate_time_at_distance(streams, mark) or official_seconds))),
        }
        for mark in IPPT_SPLIT_MARKS_M
    ]
    total_distance = float(activity.get("distance") or _last_numeric(streams.get("distance")) or 0)
    official_seconds = int(round(official_seconds))
    return {
        "strava_activity_id": str(activity.get("id") or ""),
        "activity_name": activity.get("name") or "Strava Run",
        "official_time_seconds": official_seconds,
        "official_time": _format_duration(official_seconds),
        "extra_distance_m": round(max(0, total_distance - IPPT_DISTANCE_M), 2),
        "splits": splits,
        "pacing_trend": pacing_trend(splits),
        "validity_score": validation["validityScore"],
        "status": validation["status"],
        "validation_flags": validation["flags"],
        "details": activity,
    }


def validate_ippt_activity(activity, streams):
    flags = []
    score = 100
    sport_type = activity.get("sport_type") or ""
    distance = float(activity.get("distance") or 0)

    if sport_type not in RUN_SPORT_TYPES:
        return {"validityScore": 0, "status": "invalid", "flags": ["Activity is not a run."]}
    if distance < IPPT_DISTANCE_M:
        return {"validityScore": 0, "status": "invalid", "flags": ["Activity is shorter than 2400m."]}
    if activity.get("manual"):
        score -= 35
        flags.append("Manual Strava activity.")
    if activity.get("trainer"):
        score -= 15
        flags.append("Trainer or indoor activity.")

    time_stream = streams.get("time") or []
    distance_stream = streams.get("distance") or []
    latlng_stream = streams.get("latlng") or []
    if len(time_stream) < 2 or len(distance_stream) < 2:
        return {"validityScore": 0, "status": "invalid", "flags": ["Missing usable time or distance streams."]}
    max_stream_distance = max((float(value or 0) for value in distance_stream), default=0)
    if max_stream_distance < IPPT_DISTANCE_M:
        return {"validityScore": 0, "status": "invalid", "flags": ["Distance stream does not reach 2400m."]}
    if not latlng_stream:
        score -= 20
        flags.append("Missing GPS data.")

    spike_count = _speed_spike_count(streams, activity)
    if spike_count:
        score -= min(30, 10 + spike_count * 5)
        flags.append("Suspicious speed spikes detected.")

    jump_count = _gps_jump_count(streams)
    if jump_count:
        score -= min(30, 10 + jump_count * 5)
        flags.append("Suspicious GPS jumps detected.")

    score = max(0, min(100, score))
    if score < 50:
        status = "invalid"
    elif flags or score < 85:
        status = "suspicious"
    else:
        status = "verified"
    return {"validityScore": score, "status": status, "flags": flags}


def interpolate_time_at_distance(streams, target_m):
    times = streams.get("time") or []
    distances = streams.get("distance") or []
    if not times or not distances or len(times) != len(distances):
        return None
    for index, distance in enumerate(distances):
        if float(distance) == target_m:
            return float(times[index])
        if float(distance) > target_m and index > 0:
            prev_distance = float(distances[index - 1])
            next_distance = float(distance)
            prev_time = float(times[index - 1])
            next_time = float(times[index])
            if next_distance == prev_distance:
                return next_time
            ratio = (target_m - prev_distance) / (next_distance - prev_distance)
            return prev_time + ratio * (next_time - prev_time)
    return None


def pacing_trend(splits):
    split_400 = [splits[0]["time_seconds"]]
    split_400.extend(splits[index]["time_seconds"] - splits[index - 1]["time_seconds"] for index in range(1, len(splits)))
    first_half = splits[2]["time_seconds"]
    second_half = splits[-1]["time_seconds"] - first_half
    if second_half <= first_half - 5:
        return "negative split"
    if second_half >= first_half + 8 or split_400[-1] >= split_400[0] + 8:
        return "slowed down"
    return "even pace"


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
        logger.warning("Strava token request failed", exc_info=True)
        raise StravaApiError("Could not reach Strava.", 502) from error

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
        logger.warning("Strava API request failed", exc_info=True)
        raise StravaApiError("Could not reach Strava.", 502) from error

    if not response.ok:
        raise StravaApiError(_strava_error_message(response, "Strava request failed."), response.status_code)
    return response.json()


def _is_run_activity(activity):
    return (activity.get("sport_type") or activity.get("type")) in RUN_SPORT_TYPES


def _pace_seconds_per_km(distance_km, moving_time):
    if not distance_km or not moving_time:
        return None
    return int(round(moving_time / distance_km))


def _last_numeric(values):
    for value in reversed(values or []):
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _speed_spike_count(streams, activity):
    times = streams.get("time") or []
    distances = streams.get("distance") or []
    velocity = streams.get("velocity_smooth") or []
    spikes = 0

    speed_threshold = 8.5
    max_reported = float(activity.get("max_speed") or 0)
    if max_reported > speed_threshold:
        spikes += 1
    for value in velocity:
        try:
            if float(value) > speed_threshold:
                spikes += 1
        except (TypeError, ValueError):
            pass

    for index in range(1, min(len(times), len(distances))):
        delta_time = float(times[index]) - float(times[index - 1])
        delta_distance = float(distances[index]) - float(distances[index - 1])
        if delta_time > 0 and delta_distance / delta_time > speed_threshold:
            spikes += 1
    return spikes


def _gps_jump_count(streams):
    times = streams.get("time") or []
    latlng = streams.get("latlng") or []
    jumps = 0
    for index in range(1, min(len(times), len(latlng))):
        previous = latlng[index - 1]
        current = latlng[index]
        if not previous or not current:
            continue
        delta_time = float(times[index]) - float(times[index - 1])
        if delta_time <= 0:
            continue
        meters = _haversine_m(previous, current)
        if meters > 50 and meters / delta_time > 10:
            jumps += 1
    return jumps


def _haversine_m(a, b):
    lat1, lon1 = radians(float(a[0])), radians(float(a[1]))
    lat2, lon2 = radians(float(b[0])), radians(float(b[1]))
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    value = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 6371000 * 2 * atan2(sqrt(value), sqrt(1 - value))


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
