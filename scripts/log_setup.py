import atexit
import json
import math
import os
import re
import sys
import stat
import errno
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
        r'(?:authorization|proxy-authorization|x-api-key|api[-_ ]?keys?|key|'
        r'access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|'
        r'cookie|set-cookie|paper_analyzer_api_keys?|kimi_api_key|'
        r'[a-z0-9_-]+_(?:api_keys?|token|secret|password))'
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
    # 项目的运行时间戳一律用北京时间，跟宿主机 locale 无关。
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
    problems = []

    def report_problem(file_path, operation, error):
        code = errno.errorcode.get(error.errno) if error.errno is not None else None
        problem = {'path': str(file_path), 'code': code, 'message': f'{operation}: {error}'}
        problems.append(problem)
        print(redact_log_text(f'[log] {problem["message"]}（{problem["path"]}）'), file=sys.stderr)

    try:
        names = os.listdir(logs_dir)
    except FileNotFoundError:
        return {'removed': 0, 'reclaimedBytes': 0, 'problems': []}
    except OSError as error:
        report_problem(logs_dir, '读不出日志目录', error)
        return {'removed': 0, 'reclaimedBytes': 0, 'problems': problems}
    for name in names:
        if not name.endswith('.log'):
            continue
        file_path = os.path.join(logs_dir, name)
        try:
            file_stat = os.lstat(file_path)
        except FileNotFoundError:
            continue
        except OSError as error:
            report_problem(file_path, '读不出日志文件状态', error)
            continue
        if not stat.S_ISREG(file_stat.st_mode):
            continue
        entries.append({
            'path': file_path,
            'mtime': file_stat.st_mtime,
            'size': file_stat.st_size,
            'active_owner': _log_owner_process_is_alive(file_path),
        })

    removed = 0
    reclaimed = 0
    retained = []
    failed_removals = set()
    for entry in entries:
        if not entry['active_owner'] and entry['mtime'] < cutoff:
            try:
                os.unlink(entry['path'])
                removed += 1
                reclaimed += entry['size']
                continue
            except FileNotFoundError:
                continue
            except OSError as error:
                failed_removals.add(entry['path'])
                report_problem(entry['path'], '无法删除日志文件', error)
        retained.append(entry)
    retained.sort(key=lambda item: (-item['mtime'], item['path']))
    total_bytes = sum(item['size'] for item in retained)
    for entry in reversed(retained):
        if total_bytes <= max_total_bytes:
            break
        # 别的进程可能还在用这个日志，不要删。
        if entry['path'] in failed_removals or entry['active_owner'] or entry['mtime'] >= now - ACTIVE_LOG_GRACE_SECONDS:
            continue
        try:
            os.unlink(entry['path'])
        except FileNotFoundError:
            total_bytes -= entry['size']
            continue
        except OSError as error:
            report_problem(entry['path'], '无法删除日志文件', error)
            continue
        total_bytes -= entry['size']
        removed += 1
        reclaimed += entry['size']
    return {'removed': removed, 'reclaimedBytes': reclaimed, 'problems': problems}


def setup_script_logging(script_path=None):
    global _LOG_SETUP_DONE, _ACTIVE_LOGGER, _CONFIGURED_SECRETS
    if _LOG_SETUP_DONE:
        return _ACTIVE_LOGGER
    _LOG_SETUP_DONE = True
    load_project_env()
    _CONFIGURED_SECRETS = tuple(
        item.strip()
        for key, value in os.environ.items()
        if re.search(r'(?:API_KEYS?|SECRET|TOKEN|PASSWORD|PASSWD|COOKIES?)$', key, re.IGNORECASE)
        and len(str(value)) >= 6
        for item in str(value).split(',')
        if len(item.strip()) >= 6
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


STAGE_SUMMARY_STATUS_LABELS = {'start': '开始', 'ok': '完成', 'warn': '注意', 'error': '失败'}
STAGE_SUMMARY_MESSAGE_MAX_CHARS = 500
STAGE_SUMMARY_DIR_MODE = 0o700
STAGE_SUMMARY_FILE_MODE = 0o600


def _stage_summary_line_text(value):
    text = str(value if value is not None else '')
    return re.sub(r'[\r\n]+', ' ', text).strip()


def redact_stage_summary_text(value):
    text = str(value if value is not None else '')
    for secret in _CONFIGURED_SECRETS:
        if secret:
            text = text.replace(secret, '[REDACTED]')
    # 阶段摘要只按已知密钥形态做定向替换，避免把整行「人话」消息吞掉。
    text = re.sub(r'oc_sk_[A-Za-z0-9_-]+', '[REDACTED]', text)
    text = re.sub(
        r'([A-Za-z0-9_-]*api[-_ ]?keys?)\s*=\s*[^\s&;,。，；;]+',
        r'\1=[REDACTED]',
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r'\bBearer\s+[A-Za-z0-9._~+/=-]+', '[REDACTED]', text, flags=re.IGNORECASE)
    text = re.sub(r'\bsk-[A-Za-z0-9._-]{3,}', '[REDACTED]', text, flags=re.IGNORECASE)
    return text


def _truncate_stage_summary_text(text, max_chars=STAGE_SUMMARY_MESSAGE_MAX_CHARS):
    if len(text) <= max_chars:
        return text
    return text[:max_chars - 1] + '…'


def _normalize_stage_summary_status(status):
    raw = _stage_summary_line_text(status).lower()
    if raw in STAGE_SUMMARY_STATUS_LABELS:
        return raw, None
    warning = f'阶段摘要 status 非法：「{_stage_summary_line_text(status)}」，按 error 处理'
    return 'error', warning


def _stage_summary_datetime(now):
    if isinstance(now, datetime):
        if now.tzinfo is None:
            return now.replace(tzinfo=ZoneInfo('Asia/Shanghai'))
        return now.astimezone(ZoneInfo('Asia/Shanghai'))
    return datetime.now(tz=ZoneInfo('Asia/Shanghai'))


def _format_stage_summary_timestamp(now):
    return _stage_summary_datetime(now).strftime('%Y-%m-%d %H:%M:%S')


def _resolve_stage_summary_date(date, now):
    if isinstance(date, datetime):
        return _stage_summary_datetime(date).strftime('%Y-%m-%d')
    text = _stage_summary_line_text(date)
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', text):
        return text
    return _stage_summary_datetime(now).strftime('%Y-%m-%d')


def _format_stage_summary_elapsed(elapsed_ms):
    if elapsed_ms is None or isinstance(elapsed_ms, bool):
        return ''
    if isinstance(elapsed_ms, str) and not elapsed_ms.strip():
        return ''
    try:
        value = float(elapsed_ms)
    except (TypeError, ValueError):
        return ''
    if not math.isfinite(value) or value < 0:
        return ''
    tenths = math.floor(value / 100 + 0.5)
    if tenths % 10 == 0:
        return f'{tenths // 10}s'
    return f'{tenths / 10:.1f}s'


def _stage_summary_extra_text(extra):
    if extra is None:
        return ''
    if isinstance(extra, str):
        return _stage_summary_line_text(extra)
    if isinstance(extra, bool):
        return 'true' if extra else 'false'
    if isinstance(extra, (int, float)):
        if isinstance(extra, float):
            if not math.isfinite(extra):
                return ''
            if extra.is_integer():
                return str(int(extra))
        return str(extra)
    try:
        return _stage_summary_line_text(
            json.dumps(extra, ensure_ascii=False, separators=(',', ':'), default=str),
        )
    except (TypeError, ValueError):
        return ''


def _stage_summary_logs_dir():
    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(scripts_dir), 'logs', 'summaries')


def _append_stage_summary_line(file_path, line):
    fd = os.open(file_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, STAGE_SUMMARY_FILE_MODE)
    try:
        handle = os.fdopen(fd, 'a', encoding='utf-8')
    except Exception:
        os.close(fd)
        raise
    with handle:
        handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())


def write_stage_summary(stage, status, message, elapsed_ms=None, date=None, extra=None, *, logs_dir=None, now=None):
    """往 logs/summaries/<YYYY-MM-DD>-summary.log 追加一行「人话」阶段摘要。

    写日志是旁路能力：任何失败都只打印警告，不向业务调用方抛错。
    返回 {'path', 'line', 'status'}；写入失败返回 None。
    """
    current = _stage_summary_datetime(now)
    status_key, status_warning = _normalize_stage_summary_status(status)
    if status_warning:
        print(redact_stage_summary_text(f'[log] {status_warning}'), file=sys.stderr)
    stage_text = (
        _truncate_stage_summary_text(redact_stage_summary_text(_stage_summary_line_text(stage)))
        or '未命名阶段'
    )
    message_text = _truncate_stage_summary_text(
        redact_stage_summary_text(_stage_summary_line_text(message)),
    )
    elapsed_text = _format_stage_summary_elapsed(elapsed_ms)
    extra_text = _truncate_stage_summary_text(
        redact_stage_summary_text(_stage_summary_extra_text(extra)),
    )
    line = ' '.join(field for field in [
        f'[{_format_stage_summary_timestamp(current)}]',
        f'[阶段 {stage_text}]',
        STAGE_SUMMARY_STATUS_LABELS[status_key],
        message_text,
        f'用时 {elapsed_text}' if elapsed_text else '',
        extra_text,
    ] if field)
    summary_date = _resolve_stage_summary_date(date, current)
    base_dir = os.path.abspath(os.fspath(logs_dir)) if logs_dir else _stage_summary_logs_dir()
    file_path = os.path.join(base_dir, f'{summary_date}-summary.log')
    try:
        os.makedirs(base_dir, mode=STAGE_SUMMARY_DIR_MODE, exist_ok=True)
        if os.name == 'posix':
            os.chmod(base_dir, STAGE_SUMMARY_DIR_MODE)
        _append_stage_summary_line(file_path, f'{line}\n')
        # 已有文件的权限不受 open 的 mode 影响，显式收紧。
        if os.name == 'posix':
            os.chmod(file_path, STAGE_SUMMARY_FILE_MODE)
        return {'path': file_path, 'line': line, 'status': status_key}
    except Exception as error:  # 阶段摘要失败不能打断业务调用方
        print(
            redact_stage_summary_text(f'[log] 阶段摘要写入失败: {error}'),
            file=sys.stderr,
        )
        return None
