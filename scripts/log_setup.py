import atexit
import os
import re
import sys
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from project_env import load_project_env


_LOG_SETUP_DONE = False
_ACTIVE_LOGGER = None
_CONFIGURED_SECRETS = ()
DEFAULT_LOG_RETENTION_DAYS = 30
DEFAULT_LOG_MAX_TOTAL_BYTES = 256 * 1024 * 1024
ACTIVE_LOG_GRACE_SECONDS = 5 * 60


def redact_log_text(value):
    text = str(value if value is not None else '')
    for secret in _CONFIGURED_SECRETS:
        text = text.replace(secret, '[REDACTED]')
    text = re.sub(
        r'\b([a-z][a-z0-9+.-]*://)([^\s/@]+)@',
        r'\1[REDACTED]@',
        text,
        flags=re.IGNORECASE,
    )
    credential_name = (
        r'(?:authorization|proxy-authorization|x-api-key|api[-_ ]?key|key|'
        r'access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|'
        r'cookie|set-cookie|paper_analyzer_api_key|kimi_api_key|'
        r'[a-z0-9-]+_(?:api_key|token|secret|password))'
    )
    text = re.sub(
        rf'((?:["\']?{credential_name}["\']?)\s*[:=]\s*)([^\r\n]+)',
        r'\1[REDACTED]',
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r'\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+', '[REDACTED]', text, flags=re.IGNORECASE)
    text = re.sub(r'\bsk-[A-Za-z0-9._-]{3,}', '[REDACTED]', text, flags=re.IGNORECASE)
    return text


def format_log_timestamp(now=None):
    # The project uses Beijing time for all operational timestamps, regardless of host locale.
    if now is None:
        now = datetime.now(tz=ZoneInfo('Asia/Shanghai'))
    elif now.tzinfo is None:
        now = now.replace(tzinfo=ZoneInfo('Asia/Shanghai'))
    else:
        now = now.astimezone(ZoneInfo('Asia/Shanghai'))
    beijing = now
    return beijing.strftime('%Y-%m-%d %H:%M:%S.') + f'{beijing.microsecond // 1000:03d}+08:00'


class _Tee:
    def __init__(self, file_handle, original_stream, write_lock):
        self.file_handle = file_handle
        self.original_stream = original_stream
        self.write_lock = write_lock
        self.pending = ''

    @staticmethod
    def _format_complete_line(line):
        if line in ('\n', '\r\n'):
            return line
        ending = '\r\n' if line.endswith('\r\n') else '\n'
        content = line[:-len(ending)]
        return f'[{format_log_timestamp()}] {redact_log_text(content)}{ending}'

    def _write_output(self, text):
        if not text:
            return 0
        if self.file_handle is not None:
            self.file_handle.write(text)
            self.file_handle.flush()
        return self.original_stream.write(text)

    def write(self, data):
        text = str(data if data is not None else '')
        with self.write_lock:
            self.pending += text
            complete = self.pending.splitlines(keepends=True)
            if complete and not complete[-1].endswith(('\n', '\r')):
                self.pending = complete.pop()
            else:
                self.pending = ''
            rendered = ''.join(self._format_complete_line(line) for line in complete)
            self._write_output(rendered)
        return len(text)

    def drain(self):
        with self.write_lock:
            if not self.pending:
                return
            text = f'[{format_log_timestamp()}] {redact_log_text(self.pending)}'
            self.pending = ''
            self._write_output(text)

    def flush(self):
        with self.write_lock:
            if self.file_handle is not None:
                self.file_handle.flush()
            return self.original_stream.flush()

    def isatty(self):
        return self.original_stream.isatty()

    def fileno(self):
        return self.original_stream.fileno()


class _Logger:
    def __init__(self, file_handle, log_file, stdout, stderr):
        self.file_handle = file_handle
        self.log_file = log_file
        self.stdout = stdout
        self.stderr = stderr
        self.closed = False

    def close(self):
        if self.closed:
            return
        self.closed = True
        if isinstance(sys.stdout, _Tee) and sys.stdout.file_handle is self.file_handle:
            sys.stdout.drain()
        if isinstance(sys.stderr, _Tee) and sys.stderr.file_handle is self.file_handle:
            sys.stderr.drain()
        if isinstance(sys.stdout, _Tee) and sys.stdout.file_handle is self.file_handle:
            sys.stdout = self.stdout
        if isinstance(sys.stderr, _Tee) and sys.stderr.file_handle is self.file_handle:
            sys.stderr = self.stderr
        if self.file_handle is not None:
            try:
                self.file_handle.flush()
                os.fsync(self.file_handle.fileno())
            finally:
                self.file_handle.close()


def _timestamp():
    return datetime.now(tz=ZoneInfo('Asia/Shanghai')).strftime("%Y%m%d-%H%M%S")


def _create_unique_log_file(logs_dir, base_name):
    timestamp = _timestamp()
    for sequence in range(100):
        log_file = os.path.join(logs_dir, f"{base_name}-{timestamp}-{os.getpid()}-{sequence}.log")
        try:
            fd = os.open(log_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            return os.fdopen(fd, 'w', encoding='utf-8', buffering=1), log_file
        except FileExistsError:
            continue
    raise RuntimeError(f"无法为 {base_name} 创建唯一日志文件")


def _positive_integer(value, fallback):
    try:
        parsed = int(str(value))
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _log_owner_process_is_alive(file_path):
    match = re.search(r'-(\d+)-\d+\.log$', os.path.basename(file_path))
    if not match:
        return False
    try:
        os.kill(int(match.group(1)), 0)
        return True
    except PermissionError:
        return True
    except (ProcessLookupError, ValueError, OverflowError):
        return False


def prune_log_files(logs_dir, *, retention_days=None, max_total_bytes=None, now=None):
    retention_days = _positive_integer(
        retention_days if retention_days is not None else os.environ.get('PD_LOG_RETENTION_DAYS'),
        DEFAULT_LOG_RETENTION_DAYS,
    )
    max_total_bytes = _positive_integer(
        max_total_bytes if max_total_bytes is not None else os.environ.get('PD_LOG_MAX_TOTAL_BYTES'),
        DEFAULT_LOG_MAX_TOTAL_BYTES,
    )
    now = time.time() if now is None else float(now)
    cutoff = now - retention_days * 24 * 60 * 60
    entries = []
    try:
        names = os.listdir(logs_dir)
    except OSError:
        return {'removed': 0, 'reclaimedBytes': 0}
    for name in names:
        if not name.endswith('.log'):
            continue
        file_path = os.path.join(logs_dir, name)
        try:
            stat = os.lstat(file_path)
        except OSError:
            continue
        if not os.path.isfile(file_path) or os.path.islink(file_path):
            continue
        entries.append({
            'path': file_path,
            'mtime': stat.st_mtime,
            'size': stat.st_size,
            'active_owner': _log_owner_process_is_alive(file_path),
        })

    removed = 0
    reclaimed = 0
    retained = []
    for entry in entries:
        if not entry['active_owner'] and entry['mtime'] < cutoff:
            try:
                os.unlink(entry['path'])
                removed += 1
                reclaimed += entry['size']
                continue
            except FileNotFoundError:
                continue
            except OSError:
                pass
        retained.append(entry)
    retained.sort(key=lambda item: (-item['mtime'], item['path']))
    total_bytes = sum(item['size'] for item in retained)
    for entry in reversed(retained):
        if total_bytes <= max_total_bytes:
            break
        # Do not unlink a log that another still-running process may own.
        if entry['active_owner'] or entry['mtime'] >= now - ACTIVE_LOG_GRACE_SECONDS:
            continue
        try:
            os.unlink(entry['path'])
        except FileNotFoundError:
            total_bytes -= entry['size']
            continue
        except OSError:
            continue
        total_bytes -= entry['size']
        removed += 1
        reclaimed += entry['size']
    return {'removed': removed, 'reclaimedBytes': reclaimed}


def setup_script_logging(script_path=None):
    global _LOG_SETUP_DONE, _ACTIVE_LOGGER, _CONFIGURED_SECRETS
    if _LOG_SETUP_DONE:
        return _ACTIVE_LOGGER
    _LOG_SETUP_DONE = True
    load_project_env()
    _CONFIGURED_SECRETS = tuple(
        str(value)
        for key, value in os.environ.items()
        if re.search(r'(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|COOKIES?)$', key, re.IGNORECASE)
        and len(str(value)) >= 6
    )
    disable_file_logs = (
        os.environ.get("PAPER_DIGEST_DISABLE_FILE_LOGS") == "1"
        or os.environ.get("PD_DISABLE_FILE_LOGS") == "1"
    )

    if not script_path:
        script_path = sys.argv[0] if sys.argv else "script.py"

    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(scripts_dir)
    logs_dir = os.path.join(project_root, "logs")
    base_name = os.path.splitext(os.path.basename(script_path))[0] or "script"
    fh = None
    log_file = None
    if not disable_file_logs:
        os.makedirs(logs_dir, exist_ok=True)
        prune_log_files(logs_dir)
        fh, log_file = _create_unique_log_file(logs_dir, base_name)

    original_stdout = sys.stdout
    original_stderr = sys.stderr
    write_lock = threading.RLock()
    sys.stdout = _Tee(fh, original_stdout, write_lock)
    sys.stderr = _Tee(fh, original_stderr, write_lock)
    _ACTIVE_LOGGER = _Logger(fh, log_file, original_stdout, original_stderr)
    atexit.register(_ACTIVE_LOGGER.close)
    if log_file:
        print(f"[log] 输出文件: {log_file}")
    return _ACTIVE_LOGGER
