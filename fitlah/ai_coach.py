"""OpenRouter exercise coaching from computer-vision session metrics."""

import json
import os
import re

import requests
from requests.packages.urllib3.exceptions import InsecureRequestWarning

try:
    import certifi
except ImportError:
    certifi = None

DEFAULT_MODEL = "openai/gpt-4o-mini"
OPENROUTER_CHAT_COMPLETIONS_API = "https://openrouter.ai/api/v1/chat/completions"


def _verify_setting():
    cafile = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
    if not cafile and certifi:
        cafile = certifi.where()
    return cafile or True


def _should_retry_without_ssl_verify():
    return os.environ.get("FITLAH_INSECURE_SSL", "").lower() not in {"0", "false", "no"}


def _request_timeout():
    try:
        return int(os.environ.get("OPENROUTER_TIMEOUT_SECONDS", "120"))
    except ValueError:
        return 120


def get_openrouter_config():
    """Load OpenRouter API key and model from environment."""
    api_key = (
        os.environ.get("OPENROUTER_API_KEY")
        or os.environ.get("OPENROUTER_KEY")
        or ""
    ).strip()
    return {
        "api_key": api_key,
        "model": (os.environ.get("OPENROUTER_MODEL") or DEFAULT_MODEL).strip(),
    }


def _call_openrouter(system_prompt, user_prompt):
    config = get_openrouter_config()
    if not config["api_key"]:
        return {
            "success": False,
            "error": (
                "OpenRouter API key is not set. Add OPENROUTER_API_KEY to your .env file "
                "and restart the server."
            ),
        }

    headers = {
        "Authorization": f"Bearer {config['api_key']}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "HTTP-Referer": os.environ.get("OPENROUTER_SITE_URL", "http://localhost:5000"),
        "X-Title": os.environ.get("OPENROUTER_APP_NAME", "FitLah"),
    }
    payload = {
        "model": config["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        "top_p": 1.0,
        "stream": False,
    }

    try:
        response = requests.post(
            OPENROUTER_CHAT_COMPLETIONS_API,
            headers=headers,
            json=payload,
            timeout=_request_timeout(),
            verify=_verify_setting(),
        )
        response.raise_for_status()
        body = response.json()
    except requests.exceptions.SSLError as exc:
        if not _should_retry_without_ssl_verify():
            return {"success": False, "error": f"Could not reach OpenRouter API: {exc}"}
        requests.packages.urllib3.disable_warnings(category=InsecureRequestWarning)
        try:
            response = requests.post(
                OPENROUTER_CHAT_COMPLETIONS_API,
                headers=headers,
                json=payload,
                timeout=_request_timeout(),
                verify=False,
            )
            response.raise_for_status()
            body = response.json()
        except requests.RequestException as retry_exc:
            return {"success": False, "error": f"Could not reach OpenRouter API: {retry_exc}"}
        except ValueError:
            return {"success": False, "error": "OpenRouter API returned a non-JSON response."}
    except requests.HTTPError as exc:
        detail = response.text if "response" in locals() else str(exc)
        hint = ""
        if response.status_code == 404 and "model" in detail.lower():
            hint = f" Check OPENROUTER_MODEL in .env (current: {config['model']})."
        return {"success": False, "error": f"OpenRouter API error ({response.status_code}): {detail[:280]}{hint}"}
    except requests.RequestException as exc:
        return {"success": False, "error": f"Could not reach OpenRouter API: {exc}"}
    except ValueError:
        return {"success": False, "error": "OpenRouter API returned a non-JSON response."}

    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return {"success": False, "error": "Unexpected response format from OpenRouter chat completions API."}

    parsed = _parse_coach_json(content)
    if not parsed:
        return {
            "success": True,
            "summary": _limit_words(content, 7),
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
                "summary": _limit_words(data.get("summary", ""), 7),
                "dos": [_limit_words(item, 5) for item in _as_list(data.get("dos"))[:1]],
                "donts": [_limit_words(item, 5) for item in _as_list(data.get("donts"))[:1]],
                "focus_areas": [_limit_words(item, 2) for item in _as_list(data.get("focus_areas"))[:1]],
            }
            if any(key in data for key in ("strength", "weakness", "recommendations", "safetyNote", "safety_note")):
                parsed.update({
                    "summary": _clean_text(data.get("summary", "")),
                    "strength": _clean_text(data.get("strength", "")),
                    "weakness": _clean_text(data.get("weakness", "")),
                    "recommendations": [_clean_text(item) for item in _as_list(data.get("recommendations"))[:5]],
                    "safetyNote": _clean_text(data.get("safetyNote") or data.get("safety_note", "")),
                })
            return parsed
    return None


def _as_list(value):
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _limit_words(text, max_words):
    cleaned = _clean_text(text)
    words = cleaned.split()
    return " ".join(words[:max_words])


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
        "You are not a chat assistant. You are a strict JSON formatter. "
        "Give terse point-form coaching using command verbs. "
        "No greetings. No praise. No first-person wording. No explanations. No filler. "
        "Do not use em dashes. "
        "For sit-ups, emphasise hands-on-ears if compliance is low. "
        "For push-ups, emphasise depth, body alignment, and pacing. "
        "Respond ONLY with valid JSON, no markdown fences."
    )


def _build_user_prompt(metrics):
    exercise = metrics.get("exercise", "exercise")
    label = "push-up" if exercise == "pushup" else "sit-up"
    return (
        f"Analyse this 1-minute {label} session and return personalised coaching.\n\n"
        f"Session metrics (JSON):\n{json.dumps(metrics, indent=2)}\n\n"
        "Return JSON exactly in this shape:\n"
        "{\n"
        '  "summary": "direct verdict, max 7 words",\n'
        '  "dos": ["exactly 1 command point, max 5 words"],\n'
        '  "donts": ["exactly 1 avoid point, max 5 words"],\n'
        '  "focus_areas": ["exactly 1 focus label, max 2 words"]\n'
        "}\n"
        "Use fragments, not sentences. No conversational words. No em dashes."
    )


def generate_exercise_recommendation(metrics):
    """Return coaching text from CV metrics via OpenRouter."""
    if not metrics or not isinstance(metrics, dict):
        return {"success": False, "error": "No session metrics provided."}

    exercise = metrics.get("exercise")
    if exercise not in {"pushup", "situp"}:
        return {"success": False, "error": "Invalid exercise type in metrics."}

    return _call_openrouter(_build_system_prompt(), _build_user_prompt(metrics))


def generate_ippt_run_recommendation(run_summary):
    """Return coaching JSON for an already-computed IPPT 2.4km Strava result."""
    if not run_summary or not isinstance(run_summary, dict):
        return {"success": False, "error": "No run summary provided."}

    system_prompt = (
        "You are a certified Singapore IPPT running coach. You receive only structured "
        "run analytics that have already been calculated and verified by application code. "
        "Do not calculate, recalculate, dispute, or verify official timing, points, validity, "
        "distance, or splits. Use the supplied values as facts. Respond ONLY with valid JSON, "
        "no markdown fences, no greetings, no first-person wording, and no em dashes."
    )
    user_prompt = (
        "Give personalised coaching from this computed 2.4km run summary.\n\n"
        f"Run summary JSON:\n{json.dumps(run_summary, indent=2)}\n\n"
        "Return JSON exactly in this shape:\n"
        "{\n"
        '  "summary": "one concise result interpretation",\n'
        '  "strength": "one clear strength",\n'
        '  "weakness": "one clear weakness",\n'
        '  "recommendations": ["3 to 5 concrete training actions"],\n'
        '  "safetyNote": "one practical safety note"\n'
        "}\n"
        "Do not include official timing calculations or validity judgements."
    )
    result = _call_openrouter(system_prompt, user_prompt)
    if not result.get("success"):
        return result

    return _normalise_ippt_run_response(result)


def _normalise_ippt_run_response(data):
    return {
        "success": True,
        "summary": _clean_text(data.get("summary", "")),
        "strength": _clean_text(data.get("strength", "")) or _clean_text((data.get("dos") or [""])[0]),
        "weakness": _clean_text(data.get("weakness", "")) or _clean_text((data.get("donts") or [""])[0]),
        "recommendations": [
            _clean_text(item)
            for item in _as_list(data.get("recommendations") or data.get("focus_areas"))[:5]
            if _clean_text(item)
        ],
        "safetyNote": _clean_text(data.get("safetyNote") or data.get("safety_note", "")),
    }
