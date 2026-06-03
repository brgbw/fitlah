from flask import jsonify, request


def api_success(data=None, status=200, **extra):
    payload = {"success": True, "data": data if data is not None else {}}
    payload.update(extra)
    return jsonify(payload), status


def api_error(message, status=400, code=None, **extra):
    payload = {"success": False, "error": str(message or "Request failed.")}
    if code:
        payload["code"] = code
    payload.update(extra)
    return jsonify(payload), status


def json_body(max_bytes=None):
    if max_bytes and request.content_length and request.content_length > max_bytes:
        return None, api_error("Request body is too large.", 413, code="payload_too_large")
    return request.get_json(silent=True) or {}, None
