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
        r'\b([a-z][a-z0-9+.-]*://)[^\s/\"\'<>]*@',
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
    text = re.sub(r'(?<![A-Za-z0-9_])(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+', '[REDACTED]', text, flags=re.IGNORECASE)
    text = re.sub(r'(?<![A-Za-z0-9_])sk-[A-Za-z0-9._-]+', '[REDACTED]', text, flags=re.IGNORECASE)
    # 项目账号池的 oc_sk_ 前缀不区分大小写。
    text = re.sub(r'(?<![A-Za-z0-9_])oc_sk_[A-Za-z0-9_-]+', '[REDACTED]', text, flags=re.IGNORECASE)
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
    _CONFIGURED_SECRETS = tuple(sorted((
        item.strip()
        for key, value in os.environ.items()
        if re.search(r'(?:API_KEYS?|SECRET|TOKEN|PASSWORD|PASSWD|COOKIES?)$', key, re.IGNORECASE)
        and len(str(value)) >= 6
        for item in str(value).split(',')
        if len(item.strip()) >= 6
    ), key=len, reverse=True))
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
STAGE_SUMMARY_RAW_INPUT_MAX_CHARS = 20000
STAGE_SUMMARY_DIR_MODE = 0o700
STAGE_SUMMARY_FILE_MODE = 0o600
STAGE_SUMMARY_MAX_SAFE_INTEGER = 9007199254740991


def _sanitize_stage_summary_text(value):
    text = str(value if value is not None else '')
    # 先去掉 ANSI CSI 序列，再清掉残留 ESC 与行分隔控制字符，保证只写一行。
    text = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', text)
    text = text.replace('\x1b', '')
    text = re.sub(r'[\r\n]+', ' ', text)
    text = re.sub(r'[\x0b\x0c\x1c-\x1e\x85\u2028\u2029]', '', text)
    # 其余 C0/C1、bidi 与零宽字符也不能进入单行摘要（防终端注入/隐藏文本）。
    text = re.sub(r'[\x00-\x08\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]', '', text)
    return text


def _stage_summary_line_text(value):
    return _sanitize_stage_summary_text(value).strip()


def _stage_summary_secrets():
    merged = {}
    for key, value in os.environ.items():
        if not re.search(r'(?:API_KEYS?|SECRET|TOKEN|PASSWORD|PASSWD|COOKIES?)$', key, re.IGNORECASE):
            continue
        for item in str(value).split(','):
            item = item.strip()
            if len(item) >= 6:
                merged[item] = True
    for secret in _CONFIGURED_SECRETS:
        if secret:
            merged[str(secret)] = True
    return sorted(merged, key=len, reverse=True)


def redact_stage_summary_text(value):
    text = str(value if value is not None else '')
    for secret in _stage_summary_secrets():
        if secret:
            text = text.replace(secret, '[REDACTED]')
    # 与文件日志同一批凭证形态；值只遮到空白/分隔符，保留单行摘要的可读性。
    # 统一用 ASCII 字符类与 lookbehind，避免 Node/Python 的 \b、\s 语义差异。
    text = re.sub(
        r'(?<![A-Za-z0-9_])([a-z][a-z0-9+.-]*://)[^ \t\"\'<>]*@',
        r'\1[REDACTED]@',
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r'(?<![A-Za-z0-9_])(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]+',
        '[REDACTED]',
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
        rf'((?:["\']?{credential_name}["\']?)[ \t]*[:=][ \t]*)([^ \t&;；,，。]+)',
        r'\1[REDACTED]',
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r'(?<![A-Za-z0-9_])oc_sk_[A-Za-z0-9_-]+', '[REDACTED]', text, flags=re.IGNORECASE)
    text = re.sub(r'(?<![A-Za-z0-9_])sk-[A-Za-z0-9._-]+', '[REDACTED]', text, flags=re.IGNORECASE)
    return text


def _truncate_stage_summary_text(text, max_chars=STAGE_SUMMARY_MESSAGE_MAX_CHARS):
    if len(text) <= max_chars:
        return text
    return text[:max_chars - 1] + '…'


def _cap_stage_summary_text(text, max_chars=STAGE_SUMMARY_RAW_INPUT_MAX_CHARS):
    if len(text) <= max_chars:
        return text
    return text[:max_chars]


# 先按上限截断原始输入，再跑脱敏正则，避免在超长文本上反复全量匹配。
def _prepare_stage_summary_field(value, max_chars=STAGE_SUMMARY_MESSAGE_MAX_CHARS):
    return _truncate_stage_summary_text(
        redact_stage_summary_text(_cap_stage_summary_text(_stage_summary_line_text(value))),
        max_chars,
    )


def _split_shortest_decimal(text):
    mantissa = text
    exponent = 0
    for marker in ('e', 'E'):
        index = mantissa.find(marker)
        if index >= 0:
            exponent = int(mantissa[index + 1:])
            mantissa = mantissa[:index]
            break
    dot = mantissa.find('.')
    int_part = mantissa if dot < 0 else mantissa[:dot]
    frac_part = '' if dot < 0 else mantissa[dot + 1:]
    digits = int_part + frac_part
    point_pos = len(int_part) + exponent
    leading = 0
    while leading < len(digits) and digits[leading] == '0':
        leading += 1
    digits = digits[leading:]
    point_pos -= leading
    digits = digits.rstrip('0')
    if not digits:
        return None
    return digits, point_pos


# 统一 Node/Python 的数字文本：安全整数用整数写法，其余按十进制最短表示重排。
def _format_stage_summary_number(value):
    if isinstance(value, bool):
        return ''
    if isinstance(value, int):
        if abs(value) <= STAGE_SUMMARY_MAX_SAFE_INTEGER:
            return str(value)
        value = float(value)
    if not isinstance(value, float) or not math.isfinite(value):
        return ''
    if value == 0:
        return '0'
    negative = value < 0
    abs_value = abs(value)
    parts = _split_shortest_decimal(repr(abs_value))
    if parts is None:
        return '0'
    digits, point_pos = parts
    if abs_value >= 1e21 or abs_value < 1e-6:
        mantissa = digits if len(digits) == 1 else f'{digits[0]}.{digits[1:]}'
        exponent = point_pos - 1
        body = f'{mantissa}e{"+" if exponent >= 0 else ""}{exponent}'
    elif point_pos <= 0:
        body = '0.' + '0' * (-point_pos) + digits
    elif point_pos >= len(digits):
        body = digits + '0' * (point_pos - len(digits))
    else:
        body = digits[:point_pos] + '.' + digits[point_pos:]
    return ('-' + body) if negative else body


def _render_stage_summary_json(value):
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return _format_stage_summary_number(value) or 'null'
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(_render_stage_summary_json(item) or 'null' for item in value) + ']'
    if isinstance(value, dict):
        parts = []
        for key, item in value.items():
            item_text = _render_stage_summary_json(item)
            if item_text is None:
                continue
            parts.append(f'{json.dumps(str(key), ensure_ascii=False)}:{item_text}')
        return '{' + ','.join(parts) + '}'
    return None


def _stage_summary_extra_text(extra):
    if extra is None:
        return ''
    if isinstance(extra, str):
        return _stage_summary_line_text(extra)
    if isinstance(extra, bool):
        return 'true' if extra else 'false'
    if isinstance(extra, (int, float)):
        return _format_stage_summary_number(extra)
    try:
        rendered = _render_stage_summary_json(extra)
    except Exception:
        return ''
    if rendered is None:
        return ''
    return _stage_summary_line_text(rendered)


def _normalize_stage_summary_status(status):
    raw = _stage_summary_line_text(status).lower()
    if raw in STAGE_SUMMARY_STATUS_LABELS:
        return raw, None
    warning = f'阶段摘要 status 非法：「{_stage_summary_line_text(status)}」，按 error 处理'
    return 'error', warning


def _parse_stage_summary_datetime(text):
    if not text:
        return None
    candidate = text
    if candidate[-1:] in ('Z', 'z'):
        candidate = candidate[:-1] + '+00:00'
    try:
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', candidate):
            parsed = datetime.fromisoformat(candidate).replace(tzinfo=ZoneInfo('UTC'))
        else:
            parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    return parsed.astimezone(ZoneInfo('Asia/Shanghai'))


def _stage_summary_datetime(now):
    beijing = ZoneInfo('Asia/Shanghai')
    if isinstance(now, datetime):
        if now.tzinfo is None:
            return now.replace(tzinfo=beijing)
        return now.astimezone(beijing)
    if isinstance(now, bool) or now is None:
        return datetime.now(tz=beijing)
    if isinstance(now, (int, float)):
        value = float(now)
        if not math.isfinite(value):
            return datetime.now(tz=beijing)
        # 与 Node Date(ms) 对齐：数字 now 是毫秒时间戳。
        return datetime.fromtimestamp(value / 1000, tz=ZoneInfo('UTC')).astimezone(beijing)
    if isinstance(now, str):
        parsed = _parse_stage_summary_datetime(now.strip())
        if parsed is not None:
            return parsed
    return datetime.now(tz=beijing)


def _format_stage_summary_timestamp(now):
    return _stage_summary_datetime(now).strftime('%Y-%m-%d %H:%M:%S')


def _is_stage_summary_date_text(text):
    match = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})', text)
    if not match:
        return False
    try:
        datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return False
    return True


def _resolve_stage_summary_date(date, now):
    if isinstance(date, datetime):
        return _stage_summary_datetime(date).strftime('%Y-%m-%d')
    text = _stage_summary_line_text(date)
    if _is_stage_summary_date_text(text):
        return text
    return _stage_summary_datetime(now).strftime('%Y-%m-%d')


def _format_stage_summary_elapsed(elapsed_ms):
    if isinstance(elapsed_ms, bool) or elapsed_ms is None:
        return ''
    if isinstance(elapsed_ms, (int, float)):
        value = float(elapsed_ms)
    elif isinstance(elapsed_ms, str):
        text = elapsed_ms.strip()
        # 只接受十进制数字串：拒绝 0x10、1e3、空白等形态。
        if not re.fullmatch(r'\d+(?:\.\d+)?', text):
            return ''
        value = float(text)
    else:
        return ''
    if not math.isfinite(value) or value < 0:
        return ''
    tenths = math.floor(value / 100 + 0.5)
    if tenths % 10 == 0:
        return f'{tenths // 10}s'
    return f'{tenths / 10:.1f}s'


def _stage_summary_in_test_context():
    if os.environ.get('NODE_TEST_CONTEXT'):
        return True
    if os.environ.get('PYTEST_CURRENT_TEST'):
        return True
    return 'pytest' in sys.modules or 'unittest' in sys.modules


def _stage_summary_warn(message):
    try:
        print(message, file=sys.stderr)
    except Exception:
        # stderr 不可写时也不能打断业务调用方。
        pass


def _stage_summary_warn_failure(prefix, error):
    try:
        _stage_summary_warn(redact_stage_summary_text(f'[log] {prefix}: {error}'))
    except Exception:
        # 连失败详情都处理不了时，退化成不带详情的警告，绝不影响业务调用方。
        _stage_summary_warn(f'[log] {prefix}')


def _stage_summary_logs_dir():
    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(scripts_dir), 'logs', 'summaries')


def _stage_summary_open_flags():
    return os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0)


def _append_stage_summary_line(file_path, line):
    fd = os.open(file_path, _stage_summary_open_flags(), STAGE_SUMMARY_FILE_MODE)
    try:
        handle = os.fdopen(fd, 'a', encoding='utf-8')
    except Exception:
        os.close(fd)
        raise
    with handle:
        handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())


def _assert_stage_summary_not_symlink(target_path, label):
    if os.path.islink(target_path):
        raise OSError(f'{label}是符号链接：{target_path}')


def write_stage_summary(stage, status, message, elapsed_ms=None, date=None, extra=None, *,
                        logs_dir=None, now=None, allow_in_test_process=False):
    """往 logs/summaries/<YYYY-MM-DD>-summary.log 追加一行「人话」阶段摘要。

    写日志是旁路能力：任何失败都只打印警告，不向业务调用方抛错。
    未显式传 logs_dir 且处于测试上下文时直接返回 None，避免污染真实日志目录。
    返回 {'path', 'line', 'status', 'permissionsTightened'}；写入失败返回 None。
    """
    explicit_logs_dir = bool(logs_dir)
    if not explicit_logs_dir and not allow_in_test_process and _stage_summary_in_test_context():
        return None
    current = _stage_summary_datetime(now)
    status_key, status_warning = _normalize_stage_summary_status(status)
    if status_warning:
        try:
            _stage_summary_warn(redact_stage_summary_text(f'[log] {status_warning}'))
        except Exception:
            pass
    stage_text = _prepare_stage_summary_field(stage) or '未命名阶段'
    message_text = _prepare_stage_summary_field(message)
    elapsed_text = _format_stage_summary_elapsed(elapsed_ms)
    extra_text = _prepare_stage_summary_field(_stage_summary_extra_text(extra))
    line = ' '.join(field for field in [
        f'[{_format_stage_summary_timestamp(current)}]',
        f'[阶段 {stage_text}]',
        STAGE_SUMMARY_STATUS_LABELS[status_key],
        message_text,
        f'用时 {elapsed_text}' if elapsed_text else '',
        extra_text,
    ] if field)
    summary_date = _resolve_stage_summary_date(date, current)
    base_dir = os.path.abspath(os.fspath(logs_dir)) if explicit_logs_dir else _stage_summary_logs_dir()
    file_path = os.path.join(base_dir, f'{summary_date}-summary.log')
    permissions_tightened = True
    try:
        _assert_stage_summary_not_symlink(base_dir, '阶段摘要目录')
        os.makedirs(base_dir, mode=STAGE_SUMMARY_DIR_MODE, exist_ok=True)
        # mkdir 之后再核一次，防止检查与创建之间被换成符号链接。
        _assert_stage_summary_not_symlink(base_dir, '阶段摘要目录')
    except Exception as error:
        _stage_summary_warn_failure('阶段摘要写入失败', error)
        return None
    if os.name == 'posix':
        try:
            os.chmod(base_dir, STAGE_SUMMARY_DIR_MODE)
        except OSError as error:
            permissions_tightened = False
            _stage_summary_warn_failure('阶段摘要目录权限收紧失败', error)
    try:
        _assert_stage_summary_not_symlink(file_path, '阶段摘要文件')
        _append_stage_summary_line(file_path, f'{line}\n')
    except Exception as error:
        _stage_summary_warn_failure('阶段摘要写入失败', error)
        return None
    if os.name == 'posix':
        try:
            # 已有文件的权限不受 open 的 mode 影响，显式收紧。
            os.chmod(file_path, STAGE_SUMMARY_FILE_MODE)
        except OSError as error:
            permissions_tightened = False
            _stage_summary_warn_failure('阶段摘要文件权限收紧失败', error)
    return {
        'path': file_path,
        'line': line,
        'status': status_key,
        'permissionsTightened': permissions_tightened,
    }
