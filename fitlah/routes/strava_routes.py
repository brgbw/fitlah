import os
from datetime import datetime, timedelta

from flask import jsonify, render_template, request, session, url_for

from ..auth import current_user, login_required
from ..db import insert_row, next_id


def _mock_strava_runs():
    today = datetime.now().date()
    return {
        "evening-24": {
            "name": "Evening 2.4km Time Trial",
            "distance_km": 2.41,
            "moving_time": 708,
            "pace": "4:54/km",
            "date": today.strftime("%Y-%m-%d"),
            "score": "2.41 km",
            "time": "11:48",
            "notes": "Imported from Strava mock sync. Strong IPPT-distance effort with steady pacing.",
        },
        "camp-loop": {
            "name": "Camp Loop Intervals",
            "distance_km": 5.02,
            "moving_time": 1456,
            "pace": "4:50/km",
            "date": (today - timedelta(days=1)).strftime("%Y-%m-%d"),
            "score": "5.02 km",
            "time": "24:16",
            "notes": "Imported from Strava mock sync. Longer aerobic run with interval-style pacing.",
        },
        "recovery-run": {
            "name": "Recovery Run",
            "distance_km": 3.20,
            "moving_time": 1120,
            "pace": "5:50/km",
            "date": (today - timedelta(days=2)).strftime("%Y-%m-%d"),
            "score": "3.20 km",
            "time": "18:40",
            "notes": "Imported from Strava mock sync. Lower-intensity recovery run for conditioning.",
        },
    }


def _run_recommendation(run):
    if run["distance_km"] <= 2.5:
        summary = (
            f"{run['name']} is a useful IPPT-specific benchmark at {run['time']} for "
            f"{run['distance_km']} km. Keep this as the reference run and aim to trim time through controlled pacing."
        )
        focus = ["first 800m control", "final 600m push", "even split pacing"]
    elif run["pace"].startswith("4:"):
        summary = (
            f"{run['name']} shows strong aerobic speed over {run['distance_km']} km. "
            "Use this as a conditioning session, then convert the fitness into sharper 2.4km pace work."
        )
        focus = ["2.4km race pace intervals", "cadence consistency", "recovery between hard runs"]
    else:
        summary = (
            f"{run['name']} is a good lower-intensity aerobic session. "
            "It supports recovery and base fitness, but should be paired with faster IPPT-specific intervals."
        )
        focus = ["easy-run consistency", "stride economy", "one faster session this week"]

    return {
        "summary": summary,
        "dos": [
            "Log one 2.4km benchmark each week to track IPPT readiness.",
            "Warm up for 8-10 minutes before hard running.",
            "Keep the middle section controlled so the final stretch can be faster.",
        ],
        "donts": [
            "Do not start the first 400m too aggressively.",
            "Do not stack hard run days back-to-back without recovery.",
            "Do not judge readiness from distance alone; pace trend matters.",
        ],
        "focus_areas": focus,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def register_strava_routes(app):
    @app.route("/strava-sync")
    @login_required
    def strava_sync():
        user = current_user()
        strava_client_id = os.environ.get("STRAVA_CLIENT_ID", "")
        strava_redirect_uri = url_for("strava_sync", _external=True)

        return render_template(
            "strava_sync.html",
            user=user,
            strava_client_id=strava_client_id,
            strava_redirect_uri=strava_redirect_uri,
        )

    @app.route("/api/strava-callback", methods=["POST"])
    @login_required
    def api_strava_callback():
        import requests

        data = request.get_json() or {}
        auth_code = data.get("code", "").strip()

        if not auth_code:
            return jsonify({"success": False, "error": "No authorization code provided"}), 400

        strava_client_id = os.environ.get("STRAVA_CLIENT_ID", "")
        strava_client_secret = os.environ.get("STRAVA_CLIENT_SECRET", "")

        if not strava_client_id or not strava_client_secret:
            return jsonify({"success": False, "error": "Strava credentials not configured"}), 500

        try:
            token_response = requests.post(
                "https://www.strava.com/api/v3/oauth/token",
                data={
                    "client_id": strava_client_id,
                    "client_secret": strava_client_secret,
                    "code": auth_code,
                    "grant_type": "authorization_code",
                },
                timeout=10,
            )

            if token_response.status_code != 200:
                return jsonify({"success": False, "error": "Failed to authenticate with Strava"}), 400

            token_data = token_response.json()
            access_token = token_data.get("access_token", "")
            athlete_id = token_data.get("athlete", {}).get("id", "")

            if not access_token:
                return jsonify({"success": False, "error": "No access token in response"}), 400

            runs_response = requests.get(
                "https://www.strava.com/api/v3/athlete/activities",
                headers={"Authorization": f"Bearer {access_token}"},
                params={"per_page": 5, "page": 1},
                timeout=10,
            )

            if runs_response.status_code != 200:
                return jsonify({"success": False, "error": "Failed to fetch Strava activities"}), 400

            activities = runs_response.json()
            run_activities = [
                {
                    "name": activity.get("name", "Run"),
                    "distance": round(activity.get("distance", 0) / 1000, 2),
                    "moving_time": activity.get("moving_time", 0),
                    "elapsed_time": activity.get("elapsed_time", 0),
                    "date": activity.get("start_date", "").split("T")[0],
                    "type": activity.get("type", "Run"),
                }
                for activity in activities
                if activity.get("type") == "Run"
            ]

            user = current_user()
            session[f"strava_token_{user.get('nric')}"] = access_token
            session[f"strava_athlete_id_{user.get('nric')}"] = athlete_id

            return jsonify({
                "success": True,
                "activities": run_activities,
                "message": f"Successfully synced {len(run_activities)} recent runs",
            }), 200

        except requests.RequestException as error:
            return jsonify({"success": False, "error": f"Request error: {str(error)}"}), 500
        except Exception as error:
            return jsonify({"success": False, "error": f"Error: {str(error)}"}), 500

    @app.route("/api/mock-strava-import", methods=["POST"])
    @login_required
    def api_mock_strava_import():
        data = request.get_json() or {}
        run_id = data.get("run_id")
        run = _mock_strava_runs().get(run_id)

        if not run:
            return jsonify({"success": False, "error": "Unknown Strava run selected."}), 400

        user = current_user()
        ai_recommendation = _run_recommendation(run)
        new_log = {
            "id": next_id("performance_log"),
            "nric": user.get("nric"),
            "event": run["name"],
            "name": run["name"],
            "type": "run",
            "score": run["score"],
            "time": run["time"],
            "date": run["date"],
            "notes": run["notes"],
            "exercise": "run",
            "source": "strava_mock",
            "strava_run_id": run_id,
            "distance_km": run["distance_km"],
            "moving_time": run["moving_time"],
            "pace": run["pace"],
            "ai_recommendation": ai_recommendation,
        }
        insert_row("performance_log", new_log)

        return jsonify({
            "success": True,
            "log": new_log,
            "ai_recommendation": ai_recommendation,
        }), 201
