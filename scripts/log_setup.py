import os
import sys
import glob
from datetime import datetime

MAX_LOG_FILES = int(os.environ.get("PD_LOG_MAX_FILES", "50"))
MAX_LOG_FILE_BYTES = int(os.environ.get("PD_LOG_MAX_BYTES", str(10 * 1024 * 1024)))
MAX_TOTAL_LOG_BYTES = int(os.environ.get("PD_LOG_TOTAL_MAX_BYTES", str(250 * 1024 * 1024)))


class _LogBudget:
    def __init__(self, max_bytes):
        self.max_bytes = max_bytes
        self.written = 0
        self.truncated = False


class _Tee:
    def __init__(self, file_handle, original_stream, budget):
        self.file_handle = file_handle
        self.original_stream = original_stream
        self.budget = budget

    def write(self, data):
        budget = self.budget
        if not budget.max_bytes or budget.max_bytes <= 0:
            self.file_handle.write(data)
            self.file_handle.flush()
        elif budget.written < budget.max_bytes:
            encoded_len = len(str(data).encode("utf-8", errors="replace"))
            if budget.written + encoded_len <= budget.max_bytes:
                self.file_handle.write(data)
                self.file_handle.flush()
                budget.written += encoded_len
            elif not budget.truncated:
                self.file_handle.write(
                    f"\n[log] 单文件日志达到 {budget.max_bytes} bytes，上限后的输出仅保留在终端。\n"
                )
                self.file_handle.flush()
                budget.written = budget.max_bytes
                budget.truncated = True
        return self.original_stream.write(data)

    def flush(self):
        self.file_handle.flush()
        return self.original_stream.flush()

    def isatty(self):
        return self.original_stream.isatty()


def _timestamp():
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def _cleanup_old_logs(logs_dir, max_files=MAX_LOG_FILES, max_total_bytes=MAX_TOTAL_LOG_BYTES):
    try:
        log_files = [
            (f, os.path.getmtime(f), os.path.getsize(f))
            for f in glob.glob(os.path.join(logs_dir, "*.log"))
        ]
        log_files.sort(key=lambda x: x[1], reverse=True)

        to_delete = []
        kept_bytes = 0
        for idx, (f, _, size) in enumerate(log_files):
            over_count = idx >= max_files
            over_size = max_total_bytes > 0 and kept_bytes + size > max_total_bytes
            if over_count or over_size:
                to_delete.append(f)
            else:
                kept_bytes += size

        if to_delete:
            for f in to_delete:
                try:
                    os.remove(f)
                except OSError:
                    pass
            kept_mb = kept_bytes / 1024 / 1024
            print(f"[log] 已清理 {len(to_delete)} 个过期/超额日志文件（保留最近 {max_files} 个，总量约 {kept_mb:.1f}MB）")
    except Exception:
        pass


def setup_script_logging(script_path=None):
    if os.environ.get("PAPER_DIGEST_LOG_SETUP_DONE") == "1":
        return
    os.environ["PAPER_DIGEST_LOG_SETUP_DONE"] = "1"
    if os.environ.get("PAPER_DIGEST_ENABLE_FILE_LOGS") != "1" and os.environ.get("PD_ENABLE_FILE_LOGS") != "1":
        return
    if os.environ.get("PAPER_DIGEST_DISABLE_FILE_LOGS") == "1" or os.environ.get("PD_DISABLE_FILE_LOGS") == "1":
        return

    if not script_path:
        script_path = sys.argv[0] if sys.argv else "script.py"

    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(scripts_dir)
    logs_dir = os.path.join(project_root, "logs")
    os.makedirs(logs_dir, exist_ok=True)

    _cleanup_old_logs(logs_dir, MAX_LOG_FILES, MAX_TOTAL_LOG_BYTES)

    base_name = os.path.splitext(os.path.basename(script_path))[0] or "script"
    log_file = os.path.join(logs_dir, f"{base_name}-{_timestamp()}.log")
    fh = open(log_file, "a", encoding="utf-8")

    budget = _LogBudget(MAX_LOG_FILE_BYTES)
    sys.stdout = _Tee(fh, sys.__stdout__, budget)
    sys.stderr = _Tee(fh, sys.__stderr__, budget)
    print(f"[log] 输出文件: {log_file}（单文件上限 {MAX_LOG_FILE_BYTES / 1024 / 1024:.1f}MB）")
