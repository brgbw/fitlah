import json
import logging
import os
import re

from dotenv import load_dotenv

from ..core.config import BASE_DIR

try:
    from google import genai
    from google.genai import types as genai_types
except Exception as exc:
    genai = None
    genai_types = None
    GENAI_IMPORT_ERROR = exc
else:
    GENAI_IMPORT_ERROR = None

DEFAULT_MODEL = "gemini-3.1-flash-lite"
MAX_PROMPT_CHARS = 12000
logger = logging.getLogger(__name__)
REP_METRIC_KEYS = ["rep", "amplitude", "period_s"]
ENV_PATH = os.path.join(BASE_DIR, ".env")
GEMINI_KEY_NAMES = ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY")


def _gemini_key_from_environment():
    return next(
        ((os.environ.get(name) or "").strip() for name in GEMINI_KEY_NAMES if (os.environ.get(name) or "").strip()),
        "",
    )


def load_project_env():
    """Load the project-root .env regardless of the process current directory."""
    loaded = load_dotenv(ENV_PATH, override=False)
    if not _gemini_key_from_environment():
        loaded = load_dotenv(ENV_PATH, override=True) or loaded
    return {
        "env_path": ENV_PATH,
        "env_file_exists": os.path.exists(ENV_PATH),
        "env_loaded": loaded,
        "api_key_present": bool(_gemini_key_from_environment()),
    }


def _print_missing_env_warning(env_status):
    if env_status.get("api_key_present"):
        return

    message = (
        "\n"
        "================================================================================\n"
        " AI_COACH ERROR: GEMINI API KEY NOT FOUND\n"
        f" Expected .env path: {env_status.get('env_path')}\n"
        f" .env file exists: {env_status.get('env_file_exists')}\n"
        f" .env loaded: {env_status.get('env_loaded')}\n"
        " Add GEMINI_API_KEY=your_key to the project-root .env file and restart app.py.\n"
        "================================================================================\n"
    )
    print(f"\033[91m{message}\033[0m")
    logger.error(message)


_INITIAL_ENV_STATUS = load_project_env()
_print_missing_env_warning(_INITIAL_ENV_STATUS)


def get_gemini_config():
    """Load Gemini API key and model from project-root .env/environment."""
    env_status = load_project_env()
    return {
        "api_key": _gemini_key_from_environment(),
        "model": (os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL).strip(),
        **env_status,
    }


def _debug_base(config=None, system_prompt="", user_prompt=""):
    config = config or get_gemini_config()
    return {
        "provider": "google_genai",
        "model": config.get("model") or "",
        "api_key_present": bool(config.get("api_key")),
        "env_path": config.get("env_path") or "",
        "env_file_exists": bool(config.get("env_file_exists")),
        "env_loaded": bool(config.get("env_loaded")),
        "sdk_available": genai is not None and genai_types is not None,
        "sdk_import_error": str(GENAI_IMPORT_ERROR)[:800] if GENAI_IMPORT_ERROR else "",
        "system_prompt_chars": len(system_prompt or ""),
        "user_prompt_chars": len(user_prompt or ""),
    }


def _call_gemini(system_prompt, user_prompt):
    config = get_gemini_config()
    debug = _debug_base(config, system_prompt, user_prompt)
    if genai is None:
        logger.error("Gemini AI failed: google-genai SDK is not importable. debug=%s", debug)
        return {
            "success": False,
            "error": (
                "Google Gen AI SDK is not importable. Install or repair google-genai and its dependencies. "
                f"{type(GENAI_IMPORT_ERROR).__name__}: {str(GENAI_IMPORT_ERROR)[:800]}"
            ),
            "debug": {
                **debug,
                "failure_stage": "sdk_import",
                "exception_type": type(GENAI_IMPORT_ERROR).__name__ if GENAI_IMPORT_ERROR else "ImportError",
                "exception_message": str(GENAI_IMPORT_ERROR)[:800] if GENAI_IMPORT_ERROR else "",
            },
        }
    if not config["api_key"]:
        _print_missing_env_warning(config)
        return {
            "success": False,
            "error": (
                "Gemini API key is not set. Add GEMINI_API_KEY to your .env file "
                "and restart the server."
            ),
            "debug": {
                **debug,
                "failure_stage": "configuration",
            },
        }

    try:
        client = genai.Client(api_key=config["api_key"])
        response = client.models.generate_content(
            model=config["model"],
            contents=user_prompt,
            config=genai_types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=0.1,
                top_p=1.0,
            ),
        )
        content = getattr(response, "text", "") or ""
    except Exception as exc:
        logger.exception("Gemini request failed. debug=%s", debug)
        hint = f" Check GEMINI_MODEL in .env (current: {config['model']})." if "model" in str(exc).lower() else ""
        return {
            "success": False,
            "error": f"Could not reach Gemini API.{hint} {type(exc).__name__}: {str(exc)[:800]}",
            "debug": {
                **debug,
                "failure_stage": "generate_content",
                "exception_type": type(exc).__name__,
                "exception_message": str(exc)[:800],
            },
        }

    if not content:
        return {
            "success": False,
            "error": "Unexpected empty response from Gemini API.",
            "debug": {
                **debug,
                "failure_stage": "empty_response",
            },
        }
    
    print(content)

    parsed = _parse_coach_json(content)
    if not parsed:
        parsed = _parse_coach_text(content)
    if not parsed:
        return {
            "success": True,
            "summary": _clean_text(content),
            "dos": [],
            "donts": [],
            "focus_areas": [],
        }
    parsed["success"] = True
    return parsed


def _parse_coach_json(text):
    text = (text or "").strip()
    if not text:
        return None

    candidates = [text]
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fence:
        candidates.insert(0, fence.group(1).strip())
    brace = re.search(r"\{[\s\S]*\}", text)
    if brace:
        candidates.append(brace.group(0))

    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            parsed = {
                "summary": _clean_text(data.get("summary", "")),
                "dos": [_clean_text(item) for item in _as_list(data.get("dos"))[:1]],
                "donts": [_clean_text(item) for item in _as_list(data.get("donts"))[:1]],
                "focus_areas": [_clean_text(item) for item in _as_list(data.get("focus_areas"))[:1]],
            }
            if any(key in data for key in ("strength", "weakness", "recommendations", "safetyNote", "safety_note")):
                weakness = _clean_text(data.get("weakness", ""))
                recommendations = [
                    _clean_text(item)
                    for item in _as_list(data.get("recommendations"))[:5]
                    if _clean_text(item)
                ]
                parsed.update({
                    "summary": _clean_text(data.get("summary", "")),
                    "strength": _clean_text(data.get("strength", "")),
                    "weakness": weakness,
                    "recommendations": recommendations,
                    "safetyNote": _clean_text(data.get("safetyNote") or data.get("safety_note", "")),
                    "dos": recommendations,
                    "donts": [weakness] if weakness else [],
                    "focus_areas": [],
                })
            return parsed
    return None


def _parse_coach_text(text):
    cleaned = _clean_text(text)
    if not cleaned:
        return None

    lines = [
        _clean_text(line.strip(" -*\t"))
        for line in str(text or "").splitlines()
        if _clean_text(line.strip(" -*\t"))
    ]
    if not lines:
        lines = [cleaned]

    summary = ""
    dos = []
    donts = []
    focus = []

    for line in lines:
        lowered = line.lower()
        value = re.sub(
            r"^(summary|verdict|overall|do|dos|recommended action|recommended actions|avoid|dont|don't|donts|focus|focus area)[:\-\s]*",
            "",
            line,
            flags=re.IGNORECASE,
        ).strip()
        if not value:
            continue

        if not summary and any(key in lowered for key in ("summary", "verdict", "overall")):
            summary = value
        elif any(key in lowered for key in ("avoid", "don't", "dont")):
            donts.append(value)
        elif any(key in lowered for key in ("focus", "focus area")):
            focus.append(value)
        elif any(key in lowered for key in ("do:", "dos", "recommended")):
            dos.append(value)
        elif not summary:
            summary = value
        elif not dos:
            dos.append(value)
        elif not donts:
            donts.append(value)

    return {
        "summary": _clean_text(summary or cleaned),
        "dos": [_clean_text(item) for item in dos[:2]],
        "donts": [_clean_text(item) for item in donts[:2]],
        "focus_areas": [_clean_text(item) for item in focus[:1]],
    }


def _as_list(value):
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _clean_text(text):
    cleaned = str(text or "").replace("—", "-").replace("–", "-").strip()
    cleaned = re.sub(
        r"^(great job|good job|well done|nice work|sure|of course|here'?s|i think|you should)\b[:,!\s-]*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"\byou should\b[:,!\s-]*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\b(I|we|let's|please)\b[:,!\s-]*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .,:;!-")
    return cleaned


def _build_system_prompt():
    return (
        "You are a certified Singapore IPPT fitness coach. You receive structured metrics from "
        "a webcam computer-vision system: pose landmarks, rep counts, and form flags. Never video. "
        "Evaluate rep consistency, exercise depth, and overall effectiveness. "
        "Give terse point-form coaching using command verbs. "
        "No greetings. No praise. No first-person wording. No filler. "
        "Do not use em dashes. "
        "If period stays relatively constant within 1 second, do not criticise pacing. "
        "If amplitude is relatively constant, do not criticise consistency. "
        "Only criticise amplitude when it drops across reps or is too low for exercise depth. "
        "If there is no clear issue, leave donts empty and say nothing bad. "
        "For push-ups, amplitude is shoulder-height range in pixels. "
        "For sit-ups, amplitude is hip-angle range in degrees."
    )


def _rep_metrics_csv(data):
    if not isinstance(data, list):
        return ",".join(REP_METRIC_KEYS)

    rows = []
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        rep = item.get("rep") or index + 1
        amplitude = item.get("amplitude")
        if amplitude is None:
            amplitude = item.get("amplitude_angle_deg")
        if amplitude is None:
            amplitude = item.get("amplitude_px")
        period = item.get("period_s")
        row = [
            str(rep),
            f"{amplitude:.3f}" if isinstance(amplitude, (int, float)) else "",
            f"{period:.3f}" if isinstance(period, (int, float)) else "",
        ]
        rows.append(",".join(row))
    return ",".join(REP_METRIC_KEYS) + ("\n" + "\n".join(rows) if rows else "")


def _compact_metrics_for_prompt(metrics):
    compact = dict(metrics)
    rep_data = compact.get("rep_metrics")
    movement_analysis = compact.get("movement_analysis")
    if not rep_data and isinstance(movement_analysis, dict):
        rep_data = movement_analysis.get("reps")
    if rep_data:
        compact["rep_metrics_csv"] = _rep_metrics_csv(rep_data)
    compact.pop("rep_metrics", None)
    if isinstance(movement_analysis, dict):
        compact["movement_analysis"] = {
            key: value
            for key, value in movement_analysis.items()
            if key not in {"samples", "reps"}
        }
    return compact


def _build_user_prompt(metrics):
    metrics = _compact_metrics_for_prompt(metrics)
    exercise = metrics.get("exercise", "exercise")
    label = "push-up" if exercise == "pushup" else "sit-up"
    csv_note = (
        "\nrep_metrics_csv columns are rep, amplitude, period_s. "
        "Use period_s for pacing consistency and amplitude for depth consistency. "
        "For push-ups, amplitude is shoulder-height range in pixels. "
        "For sit-ups, amplitude is hip-angle range in degrees. "
        "Do not criticise period if values stay within 1 second. "
        "Do not criticise amplitude if values are relatively constant; mention amplitude only if it drops or is too low. "
        "If no clear negative issue exists, keep donts empty.\n"
        if metrics.get("rep_metrics_csv")
        else "\nNo per-rep CSV was captured; do not invent pacing or amplitude problems.\n"
    )
    prompt = (
        f"Analyse this 1-minute {label} session and return personalised coaching.\n\n"
        f"Session metrics (JSON):\n{json.dumps(metrics, indent=2)}\n"
        f"{csv_note}\n"
        "Prefer compact JSON in this shape, but concise plain text is acceptable:\n"
        "{\n"
        '  "summary": "direct verdict",\n'
        '  "dos": ["1 or 2 command points"],\n'
        '  "donts": ["1 or 2 avoid points"],\n'
        '  "focus_areas": ["1 short focus label"]\n'
        "}\n"
        "Use fragments, not long explanations. No conversational words. No em dashes."
    )
    return prompt[:MAX_PROMPT_CHARS]


def generate_exercise_recommendation(metrics):
    """Return coaching text from CV metrics via Gemini."""
    if not metrics or not isinstance(metrics, dict):
        return {"success": False, "error": "No session metrics provided."}

    exercise = metrics.get("exercise")
    if exercise not in {"pushup", "situp"}:
        return {"success": False, "error": "Invalid exercise type in metrics."}

    if not get_gemini_config()["api_key"]:
        return _fallback_exercise_recommendation(metrics)

    result = _call_gemini(_build_system_prompt(), _build_user_prompt(metrics))
    if not result.get("success") and os.environ.get("FITLAH_AI_FALLBACK", "1").lower() in {"1", "true", "yes"}:
        return _fallback_exercise_recommendation(metrics)
    return result


def _fallback_exercise_recommendation(metrics):
    """Return deterministic mock coaching when live AI is unavailable."""
    exercise = metrics.get("exercise")
    flags = " ".join(_as_list(metrics.get("form_flags"))).lower()
    shallow_signals = int(metrics.get("shallow_rep_signals") or 0)

    if exercise == "pushup":
        if "depth" in flags or shallow_signals >= 2:
            summary = "Push-up depth needs work"
            dos = ["Lower chest with control"]
            donts = ["Avoid half reps"]
            focus = ["Depth"]
        elif "hips" in flags or "plank" in flags:
            summary = "Body line needs control"
            dos = ["Lock hips and ribs"]
            donts = ["Avoid hip sag"]
            focus = ["Alignment"]
        elif "rushed" in flags or "control" in flags:
            summary = "Rep quality needs tightening"
            dos = ["Slow each full rep"]
            donts = ["Avoid rushed reps"]
            focus = ["Control"]
        else:
            summary = "Solid push-up rhythm"
            dos = ["Keep steady full range"]
            donts = []
            focus = ["Pacing"]
    else:
        if "partial" in flags or "height" in flags:
            summary = "Sit-up height needs work"
            dos = ["Reach full upright height"]
            donts = ["Avoid partial reps"]
            focus = ["Height"]
        elif "hands" in flags:
            summary = "Technique needs cleaner control"
            dos = ["Keep hands on ears"]
            donts = ["Avoid arm swing"]
            focus = ["Form"]
        else:
            summary = "Solid sit-up rhythm"
            dos = ["Keep reps smooth"]
            donts = []
            focus = ["Control"]

    return {
        "success": True,
        "summary": summary,
        "dos": dos,
        "donts": donts,
        "focus_areas": focus,
        "mock": True,
        "source": "fallback",
    }


def generate_ippt_run_recommendation(run_summary):
    """Return coaching JSON for an already-computed IPPT 2.4km Strava result."""
    if not run_summary or not isinstance(run_summary, dict):
        return {"success": False, "error": "No run summary provided."}

    system_prompt = (
        "You are a certified Singapore IPPT running coach. You receive only structured "
        "run analytics that have already been calculated and verified by application code. "
        "Do not calculate, recalculate, dispute, or verify official timing, points, validity, "
        "distance, or splits. Use the supplied values as facts. No greetings, no first-person "
        "wording, and no em dashes."
    )
    user_prompt = (
        "Give personalised coaching from this computed 2.4km run summary.\n\n"
        f"Run summary JSON:\n{json.dumps(run_summary, indent=2)}\n\n"
        "Prefer compact JSON in this shape, but concise plain text is acceptable:\n"
        "{\n"
        '  "summary": "one concise result interpretation",\n'
        '  "strength": "one clear strength",\n'
        '  "weakness": "one clear weakness",\n'
        '  "recommendations": ["3 to 5 concrete training actions"],\n'
        '  "safetyNote": "one practical safety note"\n'
        "}\n"
        "Do not include official timing calculations or validity judgements."
    )[:MAX_PROMPT_CHARS]
    result = _call_gemini(system_prompt, user_prompt)
    if not result.get("success"):
        return result

    return _normalise_ippt_run_response(result)


def _normalise_ippt_run_response(data):
    weakness = _clean_text(data.get("weakness", "")) or _clean_text((data.get("donts") or [""])[0])
    recommendations = [
        _clean_text(item)
        for item in _as_list(data.get("recommendations") or data.get("focus_areas"))[:5]
        if _clean_text(item)
    ]
    return {
        "success": True,
        "summary": _clean_text(data.get("summary", "")),
        "strength": _clean_text(data.get("strength", "")) or _clean_text((data.get("dos") or [""])[0]),
        "weakness": weakness,
        "recommendations": recommendations,
        "safetyNote": _clean_text(data.get("safetyNote") or data.get("safety_note", "")),
        "dos": recommendations,
        "donts": [weakness] if weakness else [],
        "focus_areas": [],
    }
