"""Google AI Studio (Gemini) exercise coaching from computer-vision session metrics.

Uses the Gemini API endpoint that accepts keys from https://aistudio.google.com/apikey
"""

import json
import os
import re
import ssl
import urllib.error
import urllib.request

try:
    import certifi
except ImportError:
    certifi = None

# Default model — pick any model name shown in Google AI Studio (e.g. gemini-2.0-flash)
DEFAULT_MODEL = "gemini-2.0-flash"
GOOGLE_AI_STUDIO_API = "https://generativelanguage.googleapis.com/v1beta/models"


def _ssl_context(verify=True):
    """Build SSL context. certifi helps on many systems; verify=False for local Windows dev."""
    if not verify or os.environ.get("FITLAH_INSECURE_SSL", "").lower() in {"1", "true", "yes"}:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx

    cafile = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
    if not cafile and certifi:
        cafile = certifi.where()

    if cafile:
        return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


def _urlopen(req, timeout=45):
    """HTTPS open with certifi; auto-retry without verify if Windows SSL store fails."""
    try:
        return urllib.request.urlopen(req, timeout=timeout, context=_ssl_context(verify=True))
    except urllib.error.URLError as exc:
        reason = str(exc.reason)
        if "CERTIFICATE_VERIFY_FAILED" not in reason:
            raise
        if os.environ.get("FITLAH_INSECURE_SSL", "").lower() in {"0", "false", "no"}:
            raise
        return urllib.request.urlopen(req, timeout=timeout, context=_ssl_context(verify=False))


def get_google_config():
    """Load Google AI Studio key and model from environment."""
    api_key = (
        os.environ.get("GOOGLE_AI_STUDIO_API_KEY")
        or os.environ.get("GOOGLE_API_KEY")
        or os.environ.get("GEMINI_API_KEY")
        or ""
    ).strip()
    return {
        "api_key": api_key,
        "model": (os.environ.get("GOOGLE_MODEL") or DEFAULT_MODEL).strip(),
    }


def _call_gemini(system_prompt, user_prompt):
    config = get_google_config()
    if not config["api_key"]:
        return {
            "success": False,
            "error": (
                "Google AI Studio API key is not set. Add GOOGLE_AI_STUDIO_API_KEY "
                "(or GOOGLE_API_KEY) to your .env file. Create a key at "
                "https://aistudio.google.com/apikey"
            ),
        }

    url = f"{GOOGLE_AI_STUDIO_API}/{config['model']}:generateContent?key={config['api_key']}"
    payload = json.dumps(
        {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {
                "temperature": 0.65,
                "maxOutputTokens": 900,
                "responseMimeType": "application/json",
            },
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with _urlopen(req, timeout=45) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        hint = ""
        if exc.code == 404 and "model" in detail.lower():
            hint = f" Check GOOGLE_MODEL in .env — use a model name from Google AI Studio (current: {config['model']})."
        return {"success": False, "error": f"Google AI Studio error ({exc.code}): {detail[:280]}{hint}"}
    except urllib.error.URLError as exc:
        reason = str(exc.reason)
        hint = ""
        if "CERTIFICATE_VERIFY_FAILED" in reason:
            hint = (
                " Run: pip install certifi, restart the server, and try again. "
                "Dev-only fallback: set FITLAH_INSECURE_SSL=1 in .env (not for production)."
            )
        return {"success": False, "error": f"Could not reach Google AI Studio API: {reason}{hint}"}

    try:
        content = body["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        return {"success": False, "error": "Unexpected response format from Google AI Studio (Gemini)."}

    parsed = _parse_coach_json(content)
    if not parsed:
        return {
            "success": True,
            "summary": content.strip(),
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
                "summary": str(data.get("summary", "")).strip(),
                "dos": _as_list(data.get("dos")),
                "donts": _as_list(data.get("donts")),
                "focus_areas": _as_list(data.get("focus_areas")),
            }
    return None


def _as_list(value):
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _build_system_prompt():
    return (
        "You are a certified Singapore IPPT fitness coach. You receive structured metrics from "
        "a webcam computer-vision system (pose landmarks, rep counts, form flags)—never video. "
        "Give practical, encouraging, specific advice. Use plain language. "
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
        '  "summary": "2-3 sentence overview of performance",\n'
        '  "dos": ["3-5 specific things to keep doing"],\n'
        '  "donts": ["3-5 specific mistakes to avoid"],\n'
        '  "focus_areas": ["2-3 priorities for the next session"]\n'
        "}"
    )


def generate_exercise_recommendation(metrics):
    """Return coaching text from CV metrics via Google AI Studio (Gemini)."""
    if not metrics or not isinstance(metrics, dict):
        return {"success": False, "error": "No session metrics provided."}

    exercise = metrics.get("exercise")
    if exercise not in {"pushup", "situp"}:
        return {"success": False, "error": "Invalid exercise type in metrics."}

    return _call_gemini(_build_system_prompt(), _build_user_prompt(metrics))
