import os

from fitlah.core.application import app, init_db
from fitlah.core.config import BASE_DIR


if __name__ == "__main__":
    os.makedirs(os.path.join(BASE_DIR, "userdata", "pushup_videos"), exist_ok=True)
    os.makedirs(os.path.join(BASE_DIR, "userdata", "situp_videos"), exist_ok=True)
    init_db()
    debug = os.environ.get("FLASK_DEBUG", "").lower() in {"1", "true", "yes"}
    port = int(os.environ.get("FLASK_RUN_PORT", "5000"))
    app.run(host=os.environ.get("FLASK_RUN_HOST", "127.0.0.1"), port=port, debug=debug, use_reloader=False)
