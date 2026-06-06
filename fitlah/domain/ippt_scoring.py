"""IPPT scoring helpers backed by versioned lookup tables."""

import json
import os
import re
from datetime import date

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
DEFAULT_AGE_GROUP = "22-24"
DEFAULT_GENDER = "male"
GENDER_OPTIONS = [
    {"value": "male", "label": "Male"},
    {"value": "female", "label": "Female"},
]

AGE_GROUPS = [
    {"label": "< 22", "value": "below22", "min_age": 18, "max_age": 21},
    {"label": "22-24", "value": "22-24", "min_age": 22, "max_age": 24},
    {"label": "25-27", "value": "25-27", "min_age": 25, "max_age": 27},
    {"label": "28-30", "value": "28-30", "min_age": 28, "max_age": 30},
    {"label": "31-33", "value": "31-33", "min_age": 31, "max_age": 33},
    {"label": "34-36", "value": "34-36", "min_age": 34, "max_age": 36},
    {"label": "37-39", "value": "37-39", "min_age": 37, "max_age": 39},
    {"label": "40-42", "value": "40-42", "min_age": 40, "max_age": 42},
    {"label": "43-45", "value": "43-45", "min_age": 43, "max_age": 45},
    {"label": "46-48", "value": "46-48", "min_age": 46, "max_age": 48},
    {"label": "49-51", "value": "49-51", "min_age": 49, "max_age": 51},
    {"label": "52-54", "value": "52-54", "min_age": 52, "max_age": 54},
    {"label": "55-57", "value": "55-57", "min_age": 55, "max_age": 57},
    {"label": "58-60", "value": "58-60", "min_age": 58, "max_age": 60},
]


def _load_table(filename):
    with open(os.path.join(DATA_DIR, filename), "r", encoding="utf-8") as file:
        return json.load(file)


MALE_STATIC_POINTS = _load_table("ippt_static_points.json")
MALE_RUN_POINTS = _load_table("ippt_run_points.json")
FEMALE_STATIC_POINTS = _load_table("ippt_female_static_points.json")
FEMALE_RUN_POINTS = _load_table("ippt_female_run_points.json")
STATIC_POINTS_BY_GENDER = {
    "male": {
        "pushup": MALE_STATIC_POINTS,
        "situp": MALE_STATIC_POINTS,
    },
    "female": FEMALE_STATIC_POINTS,
}
RUN_POINTS_BY_GENDER = {
    "male": MALE_RUN_POINTS,
    "female": FEMALE_RUN_POINTS,
}
AGE_GROUP_VALUES = {group["value"] for group in AGE_GROUPS}


def normalize_age_group(age_group):
    if age_group in AGE_GROUP_VALUES:
        return age_group
    return DEFAULT_AGE_GROUP


def normalize_gender(gender):
    value = str(gender or "").strip().lower()
    if value in {"f", "female", "woman", "women"}:
        return "female"
    if value in {"m", "male", "man", "men"}:
        return "male"
    return DEFAULT_GENDER


def age_group_for_age(age):
    try:
        age = int(age)
    except (TypeError, ValueError):
        return DEFAULT_AGE_GROUP

    for group in AGE_GROUPS:
        if group["min_age"] <= age <= group["max_age"]:
            return group["value"]
    if age < 22:
        return "below22"
    return "58-60"


def infer_birth_year_from_nric(nric, today=None):
    """Best-effort birth year from Singapore NRIC prefix and first two digits."""
    today = today or date.today()
    text = (nric or "").strip().upper()
    if len(text) < 3 or not text[1:3].isdigit():
        return None

    year_digits = int(text[1:3])
    prefix = text[0]
    if prefix in {"S", "F"}:
        return 1900 + year_digits
    if prefix in {"T", "G", "M"}:
        return 2000 + year_digits

    current_two_digits = today.year % 100
    return 2000 + year_digits if year_digits <= current_two_digits else 1900 + year_digits


def infer_age_from_nric(nric, today=None):
    today = today or date.today()
    birth_year = infer_birth_year_from_nric(nric, today)
    if not birth_year:
        return None

    age = today.year - birth_year
    if age < 0 or age > 120:
        return None
    return age


def age_profile_from_nric(nric, today=None):
    age = infer_age_from_nric(nric, today)
    return {
        "age": age,
        "age_group": age_group_for_age(age),
    }


def parse_run_time(value):
    """Return seconds from MM:SS, HH:MM:SS, or numeric seconds."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value) if value > 0 else None

    text = str(value).strip()
    if not text or text == "--:--":
        return None
    if text.isdigit():
        seconds = int(text)
        return seconds if seconds > 0 else None

    parts = text.split(":")
    if len(parts) == 2 and all(part.isdigit() for part in parts):
        minutes, seconds = [int(part) for part in parts]
        return minutes * 60 + seconds
    if len(parts) == 3 and all(part.isdigit() for part in parts):
        hours, minutes, seconds = [int(part) for part in parts]
        return hours * 3600 + minutes * 60 + seconds

    match = re.search(r"(\d+)\s*m(?:in)?\s*(\d+)\s*s", text, re.IGNORECASE)
    if match:
        return int(match.group(1)) * 60 + int(match.group(2))

    return None


def format_run_time(seconds):
    if seconds is None:
        return "--:--"
    seconds = int(seconds)
    return f"{seconds // 60}:{seconds % 60:02d}"


def static_station_points(reps, age_group, gender=DEFAULT_GENDER, station="pushup"):
    station = station if station in {"pushup", "situp"} else "pushup"
    station_tables = STATIC_POINTS_BY_GENDER.get(normalize_gender(gender), STATIC_POINTS_BY_GENDER[DEFAULT_GENDER])
    table = station_tables.get(station, {}).get(normalize_age_group(age_group), [])
    try:
        reps = int(reps or 0)
    except (TypeError, ValueError):
        reps = 0
    if reps < 1 or not table:
        return 0
    if reps >= len(table) - 1:
        return 25
    return int(table[min(reps, len(table) - 1)])


def run_station_points(run_seconds, age_group, gender=DEFAULT_GENDER):
    if not run_seconds:
        return 0
    table = RUN_POINTS_BY_GENDER.get(normalize_gender(gender), RUN_POINTS_BY_GENDER[DEFAULT_GENDER]).get(normalize_age_group(age_group), [])
    if not table:
        return 0
    run_seconds = int(run_seconds)
    if run_seconds <= int(table[0][0]):
        return int(table[0][1])
    if run_seconds > int(table[-1][0]):
        return 0
    for max_seconds, points in table:
        if run_seconds <= int(max_seconds):
            return int(points)
    return 0


def award_for_points(total_points):
    if total_points >= 85:
        return {"code": "gold", "label": "Gold", "incentive": 500}
    if total_points >= 75:
        return {"code": "silver", "label": "Silver", "incentive": 300}
    if total_points >= 61:
        return {"code": "pass-incentive", "label": "Pass with incentive", "incentive": 200}
    if total_points >= 51:
        return {"code": "pass", "label": "Pass", "incentive": 0}
    return {"code": "fail", "label": "Fail", "incentive": 0}


def calculate_ippt_score(pushups, situps, run_time, age_group=DEFAULT_AGE_GROUP, gender=DEFAULT_GENDER):
    age_group = normalize_age_group(age_group)
    gender = normalize_gender(gender)
    run_seconds = parse_run_time(run_time)
    pushup_points = static_station_points(pushups, age_group, gender, "pushup")
    situp_points = static_station_points(situps, age_group, gender, "situp")
    run_points = run_station_points(run_seconds, age_group, gender)
    total_points = pushup_points + situp_points + run_points

    return {
        "age_group": age_group,
        "gender": gender,
        "pushups": int(pushups or 0),
        "situps": int(situps or 0),
        "run_time": format_run_time(run_seconds),
        "run_seconds": run_seconds,
        "pushup_points": pushup_points,
        "situp_points": situp_points,
        "run_points": run_points,
        "total_points": total_points,
        "award": award_for_points(total_points),
        "complete": bool(pushups and situps and run_seconds),
    }


def calculate_from_personal_best(personal_best, age_group=DEFAULT_AGE_GROUP, gender=None):
    gender = gender or personal_best.get("gender") or DEFAULT_GENDER
    return calculate_ippt_score(
        personal_best.get("pushups") or 0,
        personal_best.get("situps") or 0,
        personal_best.get("run_time") or "--:--",
        age_group,
        gender,
    )
