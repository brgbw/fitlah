import os

from .config import BASE_DIR


def _clear_directory_files(relative_dir, allowed_extensions=None):
    target_dir = os.path.abspath(os.path.join(BASE_DIR, relative_dir))
    userdata_root = os.path.abspath(os.path.join(BASE_DIR, "userdata"))
    if not target_dir.startswith(userdata_root + os.sep):
        return 0

    deleted = 0
    if not os.path.isdir(target_dir):
        return deleted

    for entry in os.scandir(target_dir):
        if not entry.is_file():
            continue
        if allowed_extensions and os.path.splitext(entry.name)[1].lower() not in allowed_extensions:
            continue
        try:
            os.remove(entry.path)
            deleted += 1
        except OSError:
            pass
    return deleted


def clear_session_analysis_files():
    video_extensions = {".webm", ".mp4", ".mov"}
    return {
        "pushup_videos": _clear_directory_files(os.path.join("userdata", "pushup_videos"), video_extensions),
        "situp_videos": _clear_directory_files(os.path.join("userdata", "situp_videos"), video_extensions),
        "temp_analysis": _clear_directory_files(os.path.join("userdata", "temp_analysis"), {".json"}),
    }
