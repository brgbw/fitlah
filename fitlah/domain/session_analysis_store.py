import json
import os
import time
import uuid
from datetime import datetime

from ..core.config import BASE_DIR

TEMP_ANALYSIS_TTL_SECONDS = 60 * 60


def temp_analysis_dir():
    path = os.path.join(BASE_DIR, "userdata", "temp_analysis")
    os.makedirs(path, exist_ok=True)
    return path


def temp_analysis_path(analysis_id):
    safe_id = os.path.basename(str(analysis_id or "")).replace(".json", "")
    if not safe_id or len(safe_id) != 32 or any(char not in "0123456789abcdef" for char in safe_id.lower()):
        return None
    return os.path.join(temp_analysis_dir(), f"{safe_id}.json")


def cleanup_expired_temp_analysis(ttl_seconds=TEMP_ANALYSIS_TTL_SECONDS):
    now = time.time()
    for filename in os.listdir(temp_analysis_dir()):
        if not filename.endswith(".json"):
            continue
        path = os.path.join(temp_analysis_dir(), filename)
        try:
            if now - os.path.getmtime(path) > ttl_seconds:
                os.remove(path)
        except OSError:
            pass


def save_temp_analysis(nric, log):
    if not log.get("movement_analysis"):
        return None

    cleanup_expired_temp_analysis()
    analysis_id = uuid.uuid4().hex
    path = temp_analysis_path(analysis_id)
    with open(path, "w") as file:
        json.dump({
            "nric": nric,
            "created_at": datetime.now().isoformat(),
            "log": log,
        }, file)
    return analysis_id


def load_temp_analysis_logs(raw_ids, nric):
    cleanup_expired_temp_analysis()
    logs = []
    for analysis_id in [item.strip() for item in raw_ids.split(",") if item.strip()]:
        path = temp_analysis_path(analysis_id)
        if not path or not os.path.exists(path):
            continue

        try:
            with open(path, "r") as file:
                payload = json.load(file)
            if payload.get("nric") == nric and isinstance(payload.get("log"), dict):
                logs.append(payload["log"])
        except (OSError, ValueError):
            pass
    return logs
