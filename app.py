import os

from fitlah.app import app, init_db
from fitlah.config import BASE_DIR


if __name__ == "__main__":
    os.makedirs(os.path.join(BASE_DIR, "userdata", "pushup_videos"), exist_ok=True)
    os.makedirs(os.path.join(BASE_DIR, "userdata", "situp_videos"), exist_ok=True)
    init_db()
    debug = os.environ.get("FLASK_DEBUG", "").lower() in {"1", "true", "yes"}
    app.run(host=os.environ.get("FLASK_RUN_HOST", "127.0.0.1"), debug=debug, use_reloader=False)
