import os
import sys
from datetime import datetime

from project_env import load_project_env


_LOG_SETUP_DONE = False


class _Tee:
    def __init__(self, file_handle, original_stream):
        self.file_handle = file_handle
        self.original_stream = original_stream

    def write(self, data):
        self.file_handle.write(data)
        self.file_handle.flush()
        return self.original_stream.write(data)

    def flush(self):
        self.file_handle.flush()
        return self.original_stream.flush()

    def isatty(self):
        return self.original_stream.isatty()


def _timestamp():
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def setup_script_logging(script_path=None):
    global _LOG_SETUP_DONE
    if _LOG_SETUP_DONE:
        return
    _LOG_SETUP_DONE = True
    load_project_env()
    if os.environ.get("PAPER_DIGEST_DISABLE_FILE_LOGS") == "1" or os.environ.get("PD_DISABLE_FILE_LOGS") == "1":
        return

    if not script_path:
        script_path = sys.argv[0] if sys.argv else "script.py"

    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(scripts_dir)
    logs_dir = os.path.join(project_root, "logs")
    os.makedirs(logs_dir, exist_ok=True)

    base_name = os.path.splitext(os.path.basename(script_path))[0] or "script"
    log_file = os.path.join(logs_dir, f"{base_name}-{_timestamp()}.log")
    fh = open(log_file, "a", encoding="utf-8")

    sys.stdout = _Tee(fh, sys.__stdout__)
    sys.stderr = _Tee(fh, sys.__stderr__)
    print(f"[log] 输出文件: {log_file}")
