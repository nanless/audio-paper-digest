import os
import sys
import glob
from datetime import datetime

MAX_LOG_FILES = 50


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


def _cleanup_old_logs(logs_dir, max_files=MAX_LOG_FILES):
    try:
        log_files = [
            (f, os.path.getmtime(f))
            for f in glob.glob(os.path.join(logs_dir, "*.log"))
        ]
        log_files.sort(key=lambda x: x[1], reverse=True)
        if len(log_files) > max_files:
            for f, _ in log_files[max_files:]:
                try:
                    os.remove(f)
                except OSError:
                    pass
            print(f"[log] 已清理 {len(log_files) - max_files} 个过期日志文件（保留最近 {max_files} 个）")
    except Exception:
        pass


def setup_script_logging(script_path=None):
    if os.environ.get("PAPER_DIGEST_LOG_SETUP_DONE") == "1":
        return
    os.environ["PAPER_DIGEST_LOG_SETUP_DONE"] = "1"

    if not script_path:
        script_path = sys.argv[0] if sys.argv else "script.py"

    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(scripts_dir)
    logs_dir = os.path.join(project_root, "logs")
    os.makedirs(logs_dir, exist_ok=True)

    _cleanup_old_logs(logs_dir, MAX_LOG_FILES)

    base_name = os.path.splitext(os.path.basename(script_path))[0] or "script"
    log_file = os.path.join(logs_dir, f"{base_name}-{_timestamp()}.log")
    fh = open(log_file, "a", encoding="utf-8")

    sys.stdout = _Tee(fh, sys.__stdout__)
    sys.stderr = _Tee(fh, sys.__stderr__)
    print(f"[log] 输出文件: {log_file}")
