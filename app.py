import os

from fitlah.app import app, init_db
from fitlah.config import BASE_DIR


if __name__ == "__main__":
    os.makedirs(os.path.join(BASE_DIR, "userdata", "pushup_videos"), exist_ok=True)
    os.makedirs(os.path.join(BASE_DIR, "userdata", "situp_videos"), exist_ok=True)
    init_db()
    app.run(host="0.0.0.0", debug=True, use_reloader=False)
