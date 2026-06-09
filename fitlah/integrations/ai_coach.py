import json
import logging
import re

from ..core.config import get_config

try:
    from google import genai
    from google.genai import types as genai_types
except Exception as exc:
    genai = None
    genai_types = None
    GENAI_IMPORT_ERROR = exc
else:
    GENAI_IMPORT_ERROR = None

MAX_PROMPT_CHARS = 12000
logger = logging.getLogger(__name__)
REP_METRIC_KEYS = ["rep", "amplitude", "period_s"]


def _gemini_key_from_environment():
    return get_config().gemini_api_key


def environment_status():
    return {
        "api_key_present": bool(_gemini_key_from_environment()),
    }


def _print_missing_env_warning(env_status):
    if env_status.get("api_key_present"):
        return

    logger.error("Gemini API key is not set. Add GEMINI_API_KEY to the Vercel environment and redeploy.")


def get_gemini_config():
    """Load Gemini API key and model from environment variables."""
    env_status = environment_status()
    return {
        "api_key": _gemini_key_from_environment(),
        "model": get_config().gemini_model,
        "sdk_available": genai is not None and genai_types is not None,
        "sdk_import_error": str(GENAI_IMPORT_ERROR)[:800] if GENAI_IMPORT_ERROR else "",
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
                "Gemini API key is not set. Add GEMINI_API_KEY to the Vercel environment and redeploy."
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
        hint = f" Check GEMINI_MODEL in Vercel (current: {config['model']})." if "model" in str(exc).lower() else ""
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
            return {
                "summary": _clean_text(data.get("summary", "")),
                "dos": [_clean_text(item) for item in _as_list(data.get("dos"))],
                "donts": [_clean_text(item) for item in _as_list(data.get("donts"))],
                "focus_areas": [_clean_text(item) for item in _as_list(data.get("focus_areas"))],
            }
    return None


def _parse_coach_text(text):
    cleaned = _clean_text(text)
    if not cleaned:
        return None

    lines = [
        _clean_text(line.strip(" -\t"))
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
        "dos": [_clean_text(item) for item in dos],
        "donts": [_clean_text(item) for item in donts],
        "focus_areas": [_clean_text(item) for item in focus],
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


def _json_output_rules(domain_rules):
    return (
        "Follow these strict formatting and content rules for the JSON output keys:\n"
        "1. `summary`: Strictly limit to 10 words maximum. Provide a tailored overall verdict.\n"
        f"2. `dos`: {domain_rules['dos']}\n"
        f"3. `donts`: {domain_rules['donts']}\n"
        "4. `focus_areas`: Return 1-2 concise labels. Strictly limit each label to a maximum of 2 words "
        f"(e.g., {domain_rules['focus_examples']}).\n"
        "5. STYLE: No greetings. No first-person wording. Bold key action cues using Markdown **double asterisks**."
    )


def _json_output_schema(summary_placeholder, dos_placeholder, donts_placeholder):
    return (
        "Output strictly in this JSON format:\n"
        "{\n"
        f'  "summary": "{summary_placeholder}",\n'
        '  "dos": [\n'
        f'    "{dos_placeholder}",\n'
        '    "<Another detailed future recommendation>"\n'
        "  ],\n"
        '  "donts": [\n'
        f'    "{donts_placeholder}",\n'
        '    "<Another detailed pitfall to keep in mind>"\n'
        "  ],\n"
        '  "focus_areas": [\n'
        '    "<Max 2 words>",\n'
        '    "<Max 2 words>"\n'
        "  ]\n"
        "}"
    )


def _normalise_coach_response(data):
    return {
        "success": True,
        "summary": _clean_text(data.get("summary", "")),
        "dos": [_clean_text(item) for item in _as_list(data.get("dos"))],
        "donts": [_clean_text(item) for item in _as_list(data.get("donts"))],
        "focus_areas": [_clean_text(item) for item in _as_list(data.get("focus_areas"))],
    }


def _build_system_prompt():
    rules = _json_output_rules({
        "dos": (
            "Write detailed, comprehensive recommended actions for the user to take in *future* training sessions. "
            "Evaluate their pacing and range of motion, and use your fitness knowledge to explain *how* they can improve. "
            "Give minimally 3 points in slightly clearer detail. Specify the rep range where the individual slows down (e.g., rep 13-16 poorer consistency, rep 16-17 have poorer push up/sit up form). "
            "Do NOT quote the specific raw amplitude or period numbers."
        ),
        "donts": (
            "Write detailed explanations of what the user must avoid doing in *future* exercises, or highlight specific "
            "poor habits from the data that will negatively affect their fitness level. Translate technical errors into "
            "easy-to-understand feedback. Give minimally 3 points in slightly clearer detail. Specify the rep range where the individual slows down (e.g., rep 13-16 poorer consistency, rep 16-17 have poorer push up/sit up form). "
            "Do NOT use terms like \"shallow rep\" or \"period fluctuations\". "
            "Ensure that key words and action cues MUST be bolded using Markdown **double asterisks** for consistency."
        ),
        "focus_examples": '"Core Strength", "Pacing"',
    })
    return (
        "You are a certified Singapore IPPT fitness coach evaluating push-up and sit-up sessions. "
        "You will receive structured computer-vision metrics (rep counts, form flags, amplitude, period_s).\n\n"
        "Your objective is to evaluate this data using your expert fitness knowledge and provide highly actionable, future-oriented coaching. "
        "Feel free to compliment the user for good performance, strong consistency, or solid effort. "
        "Use simple, everyday language and avoid complicated physical, biomechanical, or scientific terminology.\n\n"
        f"{rules}\n"
        "   - Example for amplitude/depth drops: Instead of saying \"Avoid shallow rep 5\", say \"Push up strength for rep 5 was too low.\"\n"
        "   - Example for period/timing spikes: Instead of saying \"Avoid period fluctuations\", say \"Push up pacing was not consistent from rep 3 to 4.\"\n"
        "   Do NOT tell the user the specific raw amplitude or period numbers.\n\n"
        "Metric Context (For your analysis only, do not output these raw numbers):\n"
        "- Consistency: period_s variation of +-2 seconds is good.\n"
        "- Depth: consistent amplitude (range of motion) is good."
    )


def rep_metrics_csv(data):
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


def attach_rep_metrics_csv(metrics):
    if not isinstance(metrics, dict):
        return metrics

    rep_data = metrics.get("rep_metrics")
    movement_analysis = metrics.get("movement_analysis")
    if not rep_data and isinstance(movement_analysis, dict):
        rep_data = movement_analysis.get("reps")
    if rep_data:
        metrics["rep_metrics"] = rep_data
        metrics["rep_metrics_csv"] = rep_metrics_csv(rep_data)
    return metrics


def _compact_metrics_for_prompt(metrics):
    compact = dict(metrics)
    rep_data = compact.get("rep_metrics")
    movement_analysis = compact.get("movement_analysis")
    if not rep_data and isinstance(movement_analysis, dict):
        rep_data = movement_analysis.get("reps")
    if rep_data:
        compact["rep_metrics_csv"] = rep_metrics_csv(rep_data)
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
        "\nrep_metrics_csv columns are rep, amplitude, period_s. Look at the data carefully. "
        "If period_s stays relatively constant (+-2 seconds), compliment their pacing consistency. "
        "If amplitude is relatively constant, compliment their depth consistency. "
        "Identify where range of motion drops or pacing spikes, and provide the feedback in simple, everyday terms "
        "(e.g., \"pacing was not consistent at rep X\"). Do not quote exact metric numbers.\n"
        if metrics.get("rep_metrics_csv")
        else "\nNo per-rep CSV was captured; give general feedback.\n"
    )
    prompt = (
        f"Analyse this 1-minute {label} IPPT station session and return specific, future-oriented coaching.\n\n"
        f"Session metrics (JSON):\n{json.dumps(metrics, indent=2)}\n"
        f"{csv_note}\n"
        + _json_output_schema(
            "<Max 10 words verdict>",
            "<Detailed future recommendation based on data analysis>",
            "<Detailed explanation of what to avoid in future exercises using simple language>",
        )
    )
    return prompt[:MAX_PROMPT_CHARS]


def generate_exercise_recommendation(metrics):
    """Return coaching text from CV metrics via Gemini."""
    if not metrics or not isinstance(metrics, dict):
        return {"success": False, "error": "No session metrics provided."}

    exercise = metrics.get("exercise")
    if exercise not in {"pushup", "situp"}:
        return {"success": False, "error": "Invalid exercise type in metrics."}

    return _call_gemini(_build_system_prompt(), _build_user_prompt(metrics))


def generate_ippt_run_recommendation(run_summary):
    """Return coaching JSON for an already-computed IPPT 2.4km Strava result."""
    if not run_summary or not isinstance(run_summary, dict):
        return {"success": False, "error": "No run summary provided."}

    rules = _json_output_rules({
        "dos": (
            "Write detailed, comprehensive recommended training actions for the user to take in *future* runs based on "
            "their telemetry. Evaluate pacing/cadence and use your fitness knowledge to outline specific future "
            "training strategies."
        ),
        "donts": (
            "Write detailed explanations of specific running habits, pacing errors, or physical form mistakes to avoid "
            "in *future* runs. Outline what they must keep in mind that will negatively affect their fitness level. "
            "Translate technical metrics into easy-to-understand running advice."
        ),
        "focus_examples": '"Aerobic Base", "Kick Finish"',
    })
    system_prompt = (
        "You are a certified Singapore IPPT fitness coach evaluating 2.4km run performance. "
        "You will receive run telemetry, including overall speed data and a compact 100m-interval stream CSV "
        "containing dist_m, time_s, speed_mps, cadence, and moving flags.\n\n"
        "Your objective is to evaluate this data (speed decay patterns, cadence drops, moving ratios) using your "
        "expert fitness knowledge and provide highly actionable, future-oriented coaching. Do not recalculate official timings or splits. "
        "Feel free to compliment the user for good performance, steady pacing, or a strong finish. "
        "Use simple, everyday language and avoid complicated physical or scientific terminology.\n\n"
        f"{rules} Bold exact split marks, speed/cadence numbers, and key action cues."
    )
    user_prompt = (
        "Give personalised, future-oriented coaching from this computed 2.4km run telemetry.\n\n"
        f"Run summary & telemetry JSON:\n{json.dumps(run_summary, indent=2)}\n\n"
        "Focus on specific 100m marks where speed or cadence dropped, or where pacing was exceptional. "
        "Explain these drops in simple, everyday language.\n\n"
        + _json_output_schema(
            "<Max 10 words verdict citing telemetry insights>",
            "<Detailed recommended actions for future training based on telemetry analysis>",
            "<Detailed explanation of pacing or form mistakes to avoid in future runs>",
        )
    )[:MAX_PROMPT_CHARS]
    
    result = _call_gemini(system_prompt, user_prompt)
    if not result.get("success"):
        return result

    return _normalise_coach_response(result)


def generate_calendar_training_summary(calendar_summary):
    """Return a short AI training summary for the calendar overview."""
    if not calendar_summary or not isinstance(calendar_summary, dict):
        return {"success": False, "error": "No calendar summary provided."}

    system_prompt = (
        "You are a motivating Singapore IPPT training coach writing a concise calendar overview. "
        "Use the user's logged push-up, sit-up, and run history to write practical encouragement and next-session tips. "
        "Do not invent exact workouts, scores, medical advice, or data that is not present. "
        "No greetings. No first-person wording. Keep the copy crisp, warm, and useful.\n\n"
        "Output JSON only with these keys:\n"
        "1. `summary`: A motivating headline, maximum 8 words.\n"
        "2. `dos`: Exactly 2-3 short tip sentences, each under 18 words.\n"
        "3. `donts`: Always return an empty array.\n"
        "4. `focus_areas`: Return 1-2 concise labels, maximum 2 words each."
    )
    user_prompt = (
        "Write a dynamic 2-3 line AI Training Summary for this calendar data.\n\n"
        f"Calendar data JSON:\n{json.dumps(calendar_summary, indent=2)}\n\n"
        "Output strictly in this JSON format:\n"
        "{\n"
        '  "summary": "<Max 8 words headline>",\n'
        '  "dos": [\n'
        '    "<Short motivational observation or tip>",\n'
        '    "<Short practical next-session tip>"\n'
        "  ],\n"
        '  "donts": [],\n'
        '  "focus_areas": ["<Max 2 words>"]\n'
        "}"
    )[:MAX_PROMPT_CHARS]

    result = _call_gemini(system_prompt, user_prompt)
    if not result.get("success"):
        return result

    return _normalise_coach_response(result)
