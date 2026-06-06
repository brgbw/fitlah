from flask import jsonify


def api_error(message, status=400, code=None, **extra):
    payload = {"success": False, "error": str(message or "Request failed.")}
    if code:
        payload["code"] = code
    payload.update(extra)
    return jsonify(payload), status
