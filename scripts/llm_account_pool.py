#!/usr/bin/env python3
"""Python 调用方使用的跨进程 OpenCode Go 账号池。

同一个池内的所有 API key 完全同权：按账号 ID 的稳定排序（与配置里的
key 顺序无关）做跨请求轮转，每次选择把游标推进到下一个可用账号；
冷却中的账号被跳过，冷却到期后重新回到轮转。activeAccountId 只作为
可观测字段，不再代表优先账号。

一次逻辑请求（一次 call_publish_llm_api / 发布请求）内部不会因为普通
故障切换账号：调用方把本次请求已试过的账号放进 exclude_account_ids，
保证每个账号至多尝试一次；只有明确的 GoUsageLimitError / Insufficient
balance 才会在同一请求内切到下一个账号并写冷却。普通的 401/429/5xx/
网络故障不额外切换、不写冷却，但选择本身已经推进并持久化了轮转游标，
所以外层重试（新的逻辑请求）会按等权轮转继续使用下一个账号。

单账号配置（len(api_keys) < 2）不经过本模块的选择函数：调用方直接发
请求（既有行为，见 publish_common.py 的单账号分支），不写账号池状态。
"""

import calendar
import errno
import hashlib
import json
import math
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

from path_config import PROJECT_ROOT, LLM_ACCOUNT_POOL_STATE_FILE, atomic_write_json
import protocol_codec as formats

ACCOUNT_POOL_CONTRACT = formats.contract('opencode-go-account-pool')
LOCK_TIMEOUT_SECONDS = 3
LOCK_STALE_SECONDS = 120
MAX_BLOCK_MS = 370 * 24 * 60 * 60 * 1000
UNKNOWN_QUOTA_BLOCK_MS = 30 * 60 * 1000
MAX_SAFE_INTEGER = (1 << 53) - 1
BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
HOUR_MS = 60 * 60 * 1000
DAY_MS = 24 * HOUR_MS
ROLLING_5H_MS = 5 * HOUR_MS
ROLLING_5H_BUCKET_MS = 15 * 60 * 1000
DEFAULT_MONTHLY_BUDGET_USD = 30.0
DEFAULT_INPUT_USD_PER_M = 0.60
DEFAULT_CACHED_INPUT_USD_PER_M = 0.15
DEFAULT_OUTPUT_USD_PER_M = 2.40
MIN_ESTIMATED_REMAINING_PCT = 0.01
DEFAULT_LIVE_SYNC_TTL_MS = 5 * 60 * 1000
DEFAULT_LIVE_SYNC_TIMEOUT_MS = 10 * 1000
LIVE_SYNC_FAILURE_BACKOFF_MS = 60 * 1000
LIVE_SYNC_MAX_RESPONSE_BYTES = 64 * 1024
QUOTA_WINDOWS = ('monthly', 'weekly', 'rolling_5h', 'balance', 'unknown')
SAFE_ACCOUNT_LABEL_RE = re.compile(r'^[A-Za-z0-9._\u4e00-\u9fff-]{1,40}$')
_HTTP_CONNECT_PROXY_ENV_VARS = ('https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY')
_LIVE_SYNC_LOCK = threading.Lock()
_LIVE_SYNC_LAST_FAIL_MS = {}
_IN_FLIGHT_LIVE_SYNCS = {}
# 成员集合变化会生成新的 group_id（新组 cursor 从 0 开始）。同一 service
# 下超过这段时间没有被任何选择使用的其他分组会被清理，避免状态文件随历次
# key 变更无限增长；仍在并行使用的不同 key 集合（例如主/副模型各自的池）
# 因为刚被选择过而不会被误删。
STALE_GROUP_MS = 7 * 24 * 60 * 60 * 1000


class LlmAccountPoolExhaustedError(RuntimeError):
    """账号池没有可用账号：全部冷却中或已被本次逻辑请求排除。"""

    code = 'LLM_ACCOUNT_POOL_EXHAUSTED'
    retryable = False
    category = 'quota_exhausted'
    scope = 'run'

    def __init__(self, message, *, earliest_retry_at_ms=None, blocked_account_count=0):
        super().__init__(message)
        self.earliest_retry_at_ms = earliest_retry_at_ms
        self.blocked_account_count = blocked_account_count


class LlmAccountAuthError(RuntimeError):
    code = 'LLM_ACCOUNT_AUTH_ERROR'
    category = 'authentication'
    scope = 'run'
    retryable = False

    def __init__(self):
        super().__init__('OpenCode Go 认证失败，已停止请求；未切换账号')


class LlmAccountPoolStateError(RuntimeError):
    """持久化的账号池状态或其锁不可信。"""

    code = 'LLM_ACCOUNT_POOL_STATE_ERROR'
    retryable = False
    category = 'state'
    scope = 'run'


class LlmAccountPoolConfigError(ValueError):
    """账号池配置存在歧义或不安全。"""

    code = 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
    retryable = False
    category = 'config'
    scope = 'run'


class LlmAccountPoolLockTimeoutError(TimeoutError):
    """账号状态的短临界区意外持续占用。"""

    code = 'LLM_ACCOUNT_POOL_LOCK_TIMEOUT'
    retryable = True
    category = 'state_contention'


def _sha256(value):
    return hashlib.sha256(str(value).encode('utf-8')).hexdigest()


def normalize_api_keys(values):
    if not isinstance(values, (list, tuple)):
        values = [values]
    result = []
    for value in values:
        key = str(value or '').strip()
        if key and key not in result:
            result.append(key)
    return result


def parse_fallback_api_keys(value):
    if isinstance(value, (list, tuple)):
        return normalize_api_keys(value)
    return normalize_api_keys(str(value or '').split(','))


def resolve_api_key_pool(primary_key, fallback_value):
    fallback_keys = (
        [str(value or '').strip() for value in fallback_value if str(value or '').strip()]
        if isinstance(fallback_value, (list, tuple))
        else [value.strip() for value in str(fallback_value or '').split(',') if value.strip()]
    )
    keys = [str(primary_key or '').strip(), *fallback_keys]
    keys = [key for key in keys if key]
    if len(set(keys)) != len(keys):
        raise LlmAccountPoolConfigError(
            '同一 OpenCode Go 账号池内的 API key 不能相同或重复'
        )
    return keys


def _split_raw_api_keys(value):
    if isinstance(value, (list, tuple)):
        return [str(item or '').strip() for item in value if str(item or '').strip()]
    return [item.strip() for item in str(value or '').split(',') if item.strip()]


def resolve_primary_api_key_pool(primary_key, fallback_value, tertiary_fallback_value=''):
    """在常规备用账号之后追加一个显式配置的第三账号。"""
    return resolve_api_key_pool(
        primary_key,
        [*_split_raw_api_keys(fallback_value), *_split_raw_api_keys(tertiary_fallback_value)],
    )


def normalize_opencode_go_service(endpoint):
    raw_endpoint = str(endpoint or '')
    # 控制字符、空白和反斜杠会让不同解析器产生分歧，与 Node 侧
    # normalizeOpenCodeGoService 保持一致：一律拒绝，不进入 URL 解析。
    if not raw_endpoint or re.search(r'[\x00-\x20\x7f\\]', raw_endpoint):
        return None
    try:
        parsed = urlsplit(raw_endpoint)
        hostname = (parsed.hostname or '').lower()
        port = parsed.port
    except (TypeError, ValueError):
        return None
    if '@' in (parsed.netloc or ''):
        return None
    raw_path = parsed.path
    # 拒绝非法百分号转义和非 UTF-8 字节序列，与 Node decodeURIComponent 保持一致。
    if re.search(r'%(?![0-9A-Fa-f]{2})', raw_path):
        return None
    # Python 的 urlsplit 保留点号路径段，而 WHATWG URL 解析器可能把它
    # 归一化掉。推导服务身份之前，原始形式和一次百分号解码后的形式都要
    # 拒绝，这样每个运行时绑定的都是调用方给出的同一条路径，而不依赖
    # 服务端或代理的归一化结果。
    try:
        decoded_path = unquote(raw_path, errors='strict')
    except UnicodeDecodeError:
        return None
    if any(segment in {'.', '..'} for path_value in (raw_path, decoded_path)
           for segment in path_value.split('/')):
        return None
    if re.search(r'%(?:2f|5c)', raw_path, re.IGNORECASE):
        return None
    pathname = raw_path.rstrip('/').lower()
    if parsed.scheme.lower() != 'https' or hostname != 'opencode.ai':
        return None
    if parsed.username is not None or parsed.password is not None \
            or port not in (None, 443) or parsed.query or parsed.fragment:
        return None
    if pathname != '/zen/go' and not pathname.startswith('/zen/go/'):
        return None
    return 'https://opencode.ai/zen/go'


def is_opencode_go_endpoint(endpoint):
    return normalize_opencode_go_service(endpoint) is not None


def get_account_id(api_key):
    return _sha256(api_key)


def get_pool_identity(api_keys, endpoint):
    keys = normalize_api_keys(api_keys)
    service = normalize_opencode_go_service(endpoint)
    if not service:
        raise LlmAccountPoolConfigError(
            'OpenCode Go 账号池只允许 https://opencode.ai/zen/go 端点'
        )
    if not keys:
        raise LlmAccountPoolConfigError('OpenCode Go 账号池没有可用 API key')
    account_ids = [get_account_id(key) for key in keys]
    return {
        'service': service,
        'service_id': _sha256(service),
        'group_id': _sha256(f'{service}\n' + '\n'.join(sorted(account_ids))),
        'account_ids': account_ids,
    }


def _read_regular_state_text(file_path):
    target = Path(file_path)
    initial = target.lstat()
    if stat.S_ISLNK(initial.st_mode) or not stat.S_ISREG(initial.st_mode):
        raise LlmAccountPoolStateError(f'LLM 账号池文件必须为普通文件: {target}')
    flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(target, flags)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise LlmAccountPoolStateError(f'LLM 账号池文件禁止使用 symlink: {target}') from exc
        raise
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise LlmAccountPoolStateError(f'LLM 账号池文件必须为普通文件: {target}')
        with os.fdopen(descriptor, 'r', encoding='utf-8', closefd=False) as stream:
            return stream.read()
    finally:
        os.close(descriptor)


def _write_lock_owner_json(lock_path, created_dir_stat, payload):
    lock_path = Path(lock_path)
    owner_path = lock_path / 'owner.json'

    def _same_created_dir():
        try:
            current = lock_path.lstat()
        except FileNotFoundError:
            return False
        return (
            not stat.S_ISLNK(current.st_mode)
            and stat.S_ISDIR(current.st_mode)
            and (current.st_dev, current.st_ino) == (
                created_dir_stat.st_dev, created_dir_stat.st_ino
            )
        )

    if not _same_created_dir():
        return None
    temp = lock_path / f'.owner.json.{os.getpid()}.{uuid.uuid4().hex}.tmp'
    open_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    fd = None
    closed = False
    try:
        try:
            fd = os.open(temp, open_flags, 0o600)
        except FileNotFoundError:
            return None
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise LlmAccountPoolStateError(
                    f'LLM 账号池锁临时文件禁止使用 symlink: {temp}'
                ) from exc
            raise
        data = (json.dumps(payload, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        view = memoryview(data)
        written = 0
        while written < len(data):
            written += os.write(fd, view[written:])
        if hasattr(os, 'fchmod'):
            os.fchmod(fd, 0o600)
        os.fsync(fd)
        try:
            os.close(fd)
        finally:
            closed = True
        if not _same_created_dir():
            return None
        try:
            os.replace(temp, owner_path)
        except FileNotFoundError:
            return None
        try:
            dir_fd = os.open(lock_path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass
        if not _same_created_dir():
            return None
        try:
            owner_stat = owner_path.lstat()
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(owner_stat.st_mode) or not stat.S_ISREG(owner_stat.st_mode) \
                or owner_stat.st_nlink != 1:
            raise LlmAccountPoolStateError(
                f'LLM 账号池 owner 路径禁止使用 symlink、非普通文件或硬链接: {owner_path}'
            )
        return owner_stat
    except Exception:
        if fd is not None and not closed:
            try:
                os.close(fd)
            except OSError:
                pass
        if _same_created_dir():
            for path_obj in (temp, owner_path):
                try:
                    path_obj.unlink()
                except OSError:
                    pass
            try:
                lock_path.rmdir()
            except OSError:
                pass
        raise


def _snapshot_lock(lock_path, stale_seconds):
    lock_path = Path(lock_path)
    owner_path = lock_path / 'owner.json'
    try:
        lock_stat = lock_path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(lock_stat.st_mode) or not stat.S_ISDIR(lock_stat.st_mode):
        raise LlmAccountPoolStateError(
            f'LLM 账号池锁路径禁止使用 symlink 或非目录: {lock_path}'
        )
    mtimes = [lock_stat.st_mtime]
    owner_stat = None
    try:
        owner_stat = owner_path.lstat()
        if stat.S_ISLNK(owner_stat.st_mode) or not stat.S_ISREG(owner_stat.st_mode) \
                or owner_stat.st_nlink != 1:
            raise LlmAccountPoolStateError(
                f'LLM 账号池 owner 路径禁止使用 symlink、非普通文件或硬链接: {owner_path}'
            )
        mtimes.append(owner_stat.st_mtime)
    except FileNotFoundError:
        owner_stat = None
    age = time.time() - max(mtimes)
    owner_token = None
    reclaimable = age > stale_seconds
    if owner_stat is not None:
        try:
            owner = json.loads(_read_regular_state_text(owner_path))
            if isinstance(owner, dict):
                raw_token = owner.get('token')
                owner_token = raw_token if isinstance(raw_token, str) else None
                owner_pid = owner.get('pid')
                valid_owner_pid = type(owner_pid) is int and owner_pid > 0
                if owner.get('hostname') == socket.gethostname() and valid_owner_pid:
                    alive = _local_lock_owner_alive(owner)
                    hung_threshold = max(float(stale_seconds) * 3.0, 300.0)
                    reclaimable = (not alive) or (age > hung_threshold)
                elif owner.get('hostname'):
                    reclaimable = age > stale_seconds
        except (FileNotFoundError, json.JSONDecodeError):
            pass
    return {
        'dir_dev': lock_stat.st_dev,
        'dir_ino': lock_stat.st_ino,
        'owner_present': owner_stat is not None,
        'owner_dev': owner_stat.st_dev if owner_stat is not None else None,
        'owner_ino': owner_stat.st_ino if owner_stat is not None else None,
        'owner_token': owner_token,
        'reclaimable': reclaimable,
    }


def _same_lock_snapshot(left, right):
    if not left or not right:
        return False
    if left['dir_dev'] != right['dir_dev'] or left['dir_ino'] != right['dir_ino']:
        return False
    if left['owner_present'] != right['owner_present']:
        return False
    if left['owner_present']:
        if left['owner_dev'] != right['owner_dev'] or left['owner_ino'] != right['owner_ino']:
            return False
        if left['owner_token'] != right['owner_token']:
            return False
    return True


def _remove_lock_dir_checked(lock_path, expected_snapshot):
    if not expected_snapshot:
        return False
    lock_path = Path(lock_path)
    try:
        current_dir = lock_path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(current_dir.st_mode) or not stat.S_ISDIR(current_dir.st_mode):
        raise LlmAccountPoolStateError(
            f'LLM 账号池锁路径禁止使用 symlink 或非目录: {lock_path}'
        )
    if (current_dir.st_dev, current_dir.st_ino) != (
        expected_snapshot['dir_dev'], expected_snapshot['dir_ino']
    ):
        return False
    owner_path = lock_path / 'owner.json'
    if expected_snapshot['owner_present']:
        try:
            current_owner = owner_path.lstat()
        except FileNotFoundError:
            current_owner = None
        if current_owner is not None:
            if stat.S_ISLNK(current_owner.st_mode) or not stat.S_ISREG(current_owner.st_mode) \
                    or current_owner.st_nlink != 1:
                raise LlmAccountPoolStateError(
                    f'LLM 账号池 owner 路径禁止使用 symlink、非普通文件或硬链接: {owner_path}'
                )
            if (current_owner.st_dev, current_owner.st_ino) != (
                expected_snapshot['owner_dev'], expected_snapshot['owner_ino']
            ):
                return False
            try:
                owner_path.unlink()
            except FileNotFoundError:
                pass
    try:
        lock_path.rmdir()
        return True
    except FileNotFoundError:
        return False
    except OSError as exc:
        if exc.errno not in (errno.ENOTEMPTY, errno.EEXIST):
            raise
        try:
            verify_dir = lock_path.lstat()
            if stat.S_ISLNK(verify_dir.st_mode) or not stat.S_ISDIR(verify_dir.st_mode):
                raise LlmAccountPoolStateError(
                    f'LLM 账号池锁路径禁止使用 symlink 或非目录: {lock_path}'
                )
            if (verify_dir.st_dev, verify_dir.st_ino) != (
                expected_snapshot['dir_dev'], expected_snapshot['dir_ino']
            ):
                return False
            entries = os.listdir(lock_path)
        except FileNotFoundError:
            return False
        has_foreign = any(
            name != 'owner.json' and not re.fullmatch(r'\.owner\.json\..+\.tmp', name)
            for name in entries
        )
        if has_foreign:
            raise LlmAccountPoolStateError(
                f'LLM 账号池锁目录存在预期之外的文件，拒绝静默清理: {lock_path}'
            )
        if entries and all(re.fullmatch(r'\.owner\.json\..+\.tmp', name) for name in entries):
            for name in entries:
                entry_path = lock_path / name
                try:
                    entry_stat = entry_path.lstat()
                except FileNotFoundError:
                    continue
                if stat.S_ISLNK(entry_stat.st_mode) or not stat.S_ISREG(entry_stat.st_mode) \
                        or entry_stat.st_nlink != 1:
                    raise LlmAccountPoolStateError(
                        f'LLM 账号池锁临时文件禁止使用 symlink、非普通文件或硬链接: {entry_path}'
                    )
                try:
                    entry_path.unlink()
                except FileNotFoundError:
                    pass
            try:
                verify_dir2 = lock_path.lstat()
                if (verify_dir2.st_dev, verify_dir2.st_ino) != (
                    expected_snapshot['dir_dev'], expected_snapshot['dir_ino']
                ):
                    return False
                lock_path.rmdir()
                return True
            except FileNotFoundError:
                return False
            except OSError as retry_exc:
                if retry_exc.errno in (errno.ENOTEMPTY, errno.EEXIST):
                    return False
                raise
        return False


BOOT_TIME_DRIFT_TOLERANCE_SECONDS = 60


def _minimal_system_probe_env():
    return {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin:/usr/sbin:/sbin'),
        'LC_ALL': 'C',
        'TZ': 'UTC',
    }


def _boot_time_seconds():
    if sys.platform == 'darwin':
        try:
            res = subprocess.run(
                ['sysctl', '-n', 'kern.boottime'],
                check=False, capture_output=True, text=True, timeout=2,
                env=_minimal_system_probe_env(),
            )
            if res.returncode == 0 and res.stdout:
                m = re.search(r'sec\s*=\s*(\d+)', res.stdout)
                if m:
                    return int(m.group(1))
        except Exception:
            pass
    elif sys.platform.startswith('linux'):
        try:
            for line in Path('/proc/stat').read_text(encoding='utf-8').splitlines():
                if line.startswith('btime '):
                    return int(line.split()[1])
        except Exception:
            pass
    return None


def _pid_start_time(pid):
    if type(pid) is not int or pid <= 0:
        return None
    if sys.platform.startswith('linux'):
        try:
            raw = Path(f'/proc/{pid}/stat').read_text(encoding='utf-8')
            rparen = raw.rfind(')')
            if rparen > 0:
                fields = raw[rparen + 2:].split()
                if len(fields) > 19:
                    return f'linux:{fields[19]}'
        except OSError:
            return None
    try:
        res = subprocess.run(
            ['ps', '-p', str(pid), '-o', 'lstart='],
            check=False, capture_output=True, text=True, timeout=2,
            env=_minimal_system_probe_env(),
        )
        if res.returncode == 0:
            norm = ' '.join(res.stdout.strip().split())
            return norm or None
    except Exception:
        pass
    return None


_UNINITIALIZED = object()
_PROCESS_BOOT_TIME_SECONDS = _UNINITIALIZED
_CURRENT_PID_START_CACHE = None


def _get_process_boot_time_seconds():
    global _PROCESS_BOOT_TIME_SECONDS
    if _PROCESS_BOOT_TIME_SECONDS is _UNINITIALIZED:
        _PROCESS_BOOT_TIME_SECONDS = _boot_time_seconds()
    return _PROCESS_BOOT_TIME_SECONDS


def _get_current_pid_start_time():
    global _CURRENT_PID_START_CACHE
    current_pid = os.getpid()
    if _CURRENT_PID_START_CACHE is None or _CURRENT_PID_START_CACHE[0] != current_pid:
        _CURRENT_PID_START_CACHE = (current_pid, _pid_start_time(current_pid))
    return _CURRENT_PID_START_CACHE[1]


def _local_lock_owner_alive(owner):
    recorded_boot = owner.get('bootTime')
    if type(recorded_boot) is int:
        process_boot = _get_process_boot_time_seconds()
        if process_boot is not None and abs(process_boot - recorded_boot) > BOOT_TIME_DRIFT_TOLERANCE_SECONDS:
            return False
    owner_pid = owner.get('pid')
    try:
        os.kill(owner_pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    recorded_start = owner.get('pidStartTime')
    if isinstance(recorded_start, str) and recorded_start:
        actual = _pid_start_time(owner_pid)
        if actual is not None and actual != recorded_start:
            return False
    return True


def _lock_reclaimable(lock_path, stale_seconds):
    snapshot = _snapshot_lock(lock_path, stale_seconds)
    return True if snapshot is None else snapshot['reclaimable']


def _assert_safe_project_state_path(state_file):
    target = Path(os.path.abspath(str(state_file)))
    project_root = Path(os.path.abspath(str(PROJECT_ROOT)))
    try:
        relative = target.relative_to(project_root)
    except ValueError:
        if target.parent.is_symlink():
            raise LlmAccountPoolStateError(
                f'LLM 账号池父路径禁止使用 symlink: {target.parent}'
            )
        return
    current = project_root
    for segment in relative.parts[:-1]:
        current = current / segment
        if current.is_symlink():
            raise LlmAccountPoolStateError(
                f'LLM 账号池父路径禁止使用 symlink: {current}'
            )


@contextmanager
def _state_lock(state_file, *, timeout_seconds=LOCK_TIMEOUT_SECONDS,
                stale_seconds=LOCK_STALE_SECONDS):
    target = Path(state_file)
    _assert_safe_project_state_path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(f'{target}.lock')
    reclaim_path = Path(f'{lock_path}.reclaim')
    try:
        existing_lock = lock_path.lstat()
        if stat.S_ISLNK(existing_lock.st_mode) or not stat.S_ISDIR(existing_lock.st_mode):
            raise LlmAccountPoolStateError(
                f'LLM 账号池锁路径禁止使用 symlink 或非目录: {lock_path}'
            )
    except FileNotFoundError:
        pass
    try:
        existing_reclaim = reclaim_path.lstat()
        if stat.S_ISLNK(existing_reclaim.st_mode) or not stat.S_ISDIR(existing_reclaim.st_mode):
            raise LlmAccountPoolStateError(
                f'LLM 账号池回收锁路径禁止使用 symlink 或非目录: {reclaim_path}'
            )
    except FileNotFoundError:
        pass
    token = uuid.uuid4().hex
    started = time.monotonic()
    owned_snapshot = None
    while True:
        try:
            reclaim_stat = reclaim_path.lstat()
        except FileNotFoundError:
            reclaim_stat = None
        if reclaim_stat is not None:
            if stat.S_ISLNK(reclaim_stat.st_mode) or not stat.S_ISDIR(reclaim_stat.st_mode):
                raise LlmAccountPoolStateError(
                    f'LLM 账号池回收锁路径禁止使用 symlink 或非目录: {reclaim_path}'
                )
            reclaim_age = time.time() - reclaim_stat.st_mtime
            if reclaim_age > stale_seconds:
                removed_reclaim = False
                try:
                    current_reclaim = reclaim_path.lstat()
                    if stat.S_ISLNK(current_reclaim.st_mode) or not stat.S_ISDIR(current_reclaim.st_mode):
                        raise LlmAccountPoolStateError(
                            f'LLM 账号池回收锁路径禁止使用 symlink 或非目录: {reclaim_path}'
                        )
                    if (current_reclaim.st_dev, current_reclaim.st_ino) == (
                        reclaim_stat.st_dev, reclaim_stat.st_ino
                    ):
                        reclaim_path.rmdir()
                        removed_reclaim = True
                except FileNotFoundError:
                    removed_reclaim = True
                except OSError as exc:
                    if exc.errno in (errno.ENOTEMPTY, errno.EEXIST):
                        raise LlmAccountPoolStateError(
                            f'LLM 账号池回收锁目录存在异常内容，无法清理: {reclaim_path}'
                        ) from exc
                    raise
                if not removed_reclaim:
                    if time.monotonic() - started >= timeout_seconds:
                        raise LlmAccountPoolLockTimeoutError(
                            f'等待 LLM 账号池回收锁超时: {reclaim_path}'
                        )
                    time.sleep(0.025)
                    continue
            else:
                if time.monotonic() - started >= timeout_seconds:
                    raise LlmAccountPoolLockTimeoutError(
                        f'等待 LLM 账号池回收锁超时: {reclaim_path}'
                    )
                time.sleep(0.025)
                continue
        try:
            lock_path.mkdir()
            try:
                created_dir_stat = lock_path.lstat()
            except FileNotFoundError:
                if time.monotonic() - started >= timeout_seconds:
                    raise LlmAccountPoolLockTimeoutError(
                        f'等待 LLM 账号池状态锁超时: {lock_path}'
                    )
                time.sleep(0.025)
                continue
            if stat.S_ISLNK(created_dir_stat.st_mode) or not stat.S_ISDIR(created_dir_stat.st_mode):
                raise LlmAccountPoolStateError(
                    f'LLM 账号池锁路径禁止使用 symlink 或非目录: {lock_path}'
                )
            owner_payload = {
                'pid': os.getpid(),
                'hostname': socket.gethostname(),
                'token': token,
                'acquiredAt': datetime.now(timezone.utc).isoformat(),
            }
            boot_time = _get_process_boot_time_seconds()
            if boot_time is not None:
                owner_payload['bootTime'] = boot_time
            pid_start_time = _get_current_pid_start_time()
            if pid_start_time is not None:
                owner_payload['pidStartTime'] = pid_start_time
            created_owner_stat = _write_lock_owner_json(lock_path, created_dir_stat, owner_payload)
            if created_owner_stat is None:
                if time.monotonic() - started >= timeout_seconds:
                    raise LlmAccountPoolLockTimeoutError(
                        f'等待 LLM 账号池状态锁超时: {lock_path}'
                    )
                time.sleep(0.025)
                continue
            owned_snapshot = {
                'dir_dev': created_dir_stat.st_dev,
                'dir_ino': created_dir_stat.st_ino,
                'owner_present': True,
                'owner_dev': created_owner_stat.st_dev,
                'owner_ino': created_owner_stat.st_ino,
                'owner_token': token,
            }
            break
        except FileExistsError:
            stale_snapshot = _snapshot_lock(lock_path, stale_seconds)
            if stale_snapshot is not None and stale_snapshot['reclaimable']:
                reclaim_created_stat = None
                reclaimed = False
                try:
                    reclaim_path.mkdir()
                    try:
                        reclaim_created_stat = reclaim_path.lstat()
                    except FileNotFoundError:
                        reclaim_created_stat = None
                    if reclaim_created_stat is not None \
                            and not stat.S_ISLNK(reclaim_created_stat.st_mode) \
                            and stat.S_ISDIR(reclaim_created_stat.st_mode):
                        current_snapshot = _snapshot_lock(lock_path, stale_seconds)
                        if current_snapshot is not None and current_snapshot['reclaimable'] \
                                and _same_lock_snapshot(stale_snapshot, current_snapshot):
                            reclaimed = _remove_lock_dir_checked(lock_path, current_snapshot)
                except (FileExistsError, FileNotFoundError):
                    pass
                finally:
                    if reclaim_created_stat is not None:
                        try:
                            current_reclaim = reclaim_path.lstat()
                            if not stat.S_ISLNK(current_reclaim.st_mode) \
                                    and stat.S_ISDIR(current_reclaim.st_mode) \
                                    and (current_reclaim.st_dev, current_reclaim.st_ino) == (
                                        reclaim_created_stat.st_dev, reclaim_created_stat.st_ino
                                    ):
                                reclaim_path.rmdir()
                        except FileNotFoundError:
                            pass
                if time.monotonic() - started >= timeout_seconds:
                    raise LlmAccountPoolLockTimeoutError(
                        f'等待 LLM 账号池状态锁超时: {lock_path}'
                    )
                if reclaimed:
                    continue
                time.sleep(0.025)
                continue
            if stale_snapshot is None:
                if time.monotonic() - started >= timeout_seconds:
                    raise LlmAccountPoolLockTimeoutError(
                        f'等待 LLM 账号池状态锁超时: {lock_path}'
                    )
                continue
            if time.monotonic() - started >= timeout_seconds:
                raise LlmAccountPoolLockTimeoutError(
                    f'等待 LLM 账号池状态锁超时: {lock_path}'
                )
            time.sleep(0.025)
    try:
        yield
    finally:
        try:
            current_dir = lock_path.lstat()
            if stat.S_ISLNK(current_dir.st_mode) or not stat.S_ISDIR(current_dir.st_mode) \
                    or owned_snapshot is None \
                    or (current_dir.st_dev, current_dir.st_ino) != (
                        owned_snapshot['dir_dev'], owned_snapshot['dir_ino']
                    ):
                pass
            else:
                owner_path = lock_path / 'owner.json'
                current_owner = owner_path.lstat()
                if stat.S_ISLNK(current_owner.st_mode) or not stat.S_ISREG(current_owner.st_mode) \
                        or current_owner.st_nlink != 1:
                    raise LlmAccountPoolStateError(
                        f'LLM 账号池 owner 路径禁止使用 symlink、非普通文件或硬链接: {owner_path}'
                    )
                owner = json.loads(_read_regular_state_text(owner_path))
                if isinstance(owner, dict) and owner.get('token') == token:
                    _remove_lock_dir_checked(lock_path, owned_snapshot)
        except (FileNotFoundError, json.JSONDecodeError):
            pass


def _new_state():
    return formats.record(ACCOUNT_POOL_CONTRACT, {'generation': 0, 'services': {}})


def _has_account_pool_header(state):
    if type(state) is not dict:
        return False
    current = 'contract' in state
    return formats.has_valid_header(state, ACCOUNT_POOL_CONTRACT, 'contract' if current else 'policyVersion')


def _reject_non_finite_json(value):
    raise ValueError(f'非法非有限数值: {value}')


def _is_non_negative_finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) \
        and math.isfinite(value) and value >= 0


def _is_percent_value(value):
    return _is_non_negative_finite(value) and value <= 100


def _validate_account_subrecords(record, target):
    if 'windows' in record:
        windows = record['windows']
        if not isinstance(windows, dict):
            raise LlmAccountPoolStateError(f'LLM 账号池状态 account.windows 非法，已阻止覆盖 {target}')
        for window_name, entry in windows.items():
            if window_name not in QUOTA_WINDOWS or not isinstance(entry, dict) \
                    or ('blockedUntilMs' in entry and not _is_non_negative_finite(entry['blockedUntilMs'])):
                raise LlmAccountPoolStateError(
                    f'LLM 账号池状态 account.windows.{window_name} 非法，已阻止覆盖 {target}'
                )
    if 'quota' in record:
        q = record['quota']
        if not isinstance(q, dict):
            raise LlmAccountPoolStateError(f'LLM 账号池状态 account.quota 非法，已阻止覆盖 {target}')
        label = q.get('label')
        if label is not None and (not isinstance(label, str) or not SAFE_ACCOUNT_LABEL_RE.fullmatch(label)):
            raise LlmAccountPoolStateError(f'LLM 账号池状态 account.quota 非法，已阻止覆盖 {target}')
        reset_day = q.get('monthlyResetDay')
        if reset_day is not None and (type(reset_day) is not int or not (1 <= reset_day <= 31)):
            raise LlmAccountPoolStateError(f'LLM 账号池状态 account.quota 非法，已阻止覆盖 {target}')
        tz_min = q.get('monthlyResetTzOffsetMin')
        if tz_min is not None and (type(tz_min) is not int or not (-720 <= tz_min <= 840)):
            raise LlmAccountPoolStateError(f'LLM 账号池状态 account.quota 非法，已阻止覆盖 {target}')
        source = q.get('monthlyResetSource')
        if source is not None and source not in ('manual', 'auto_429', 'live_api'):
            raise LlmAccountPoolStateError(f'LLM 账号池状态 account.quota 非法，已阻止覆盖 {target}')
        budget = q.get('monthlyBudgetUsd')
        if budget is not None and (not _is_non_negative_finite(budget) or budget <= 0):
            raise LlmAccountPoolStateError(f'LLM 账号池状态 account.quota 非法，已阻止覆盖 {target}')
        for pct_field in ('monthlyRemainingPct', 'weeklyRemainingPct', 'rolling5hRemainingPct'):
            val = q.get(pct_field)
            if val is not None and not _is_percent_value(val):
                raise LlmAccountPoolStateError(f'LLM 账号池状态 account.quota 非法，已阻止覆盖 {target}')
        for ts_field in (
            'monthlyResetAtMs', 'autoMonthlyAnchorMs', 'lastLiveSyncAtMs', 'snapshotAtMs',
            'monthlySnapshotAtMs', 'weeklySnapshotAtMs', 'rolling5hSnapshotAtMs',
            'weeklyResetAtMs', 'rolling5hResetAtMs',
            'monthlySpentAtSnapshotUsd', 'weeklySpentAtSnapshotUsd', 'rolling5hSpentAtSnapshotUsd',
        ):
            val = q.get(ts_field)
            if val is not None and not _is_non_negative_finite(val):
                raise LlmAccountPoolStateError(f'LLM 账号池状态 account.quota 非法，已阻止覆盖 {target}')
    if 'usage' in record:
        u = record['usage']
        if not isinstance(u, dict):
            raise LlmAccountPoolStateError(f'LLM 账号池状态 account.usage 非法，已阻止覆盖 {target}')
        for nullable_field in ('monthlyCycleStartMs', 'weeklyCycleStartMs'):
            val = u.get(nullable_field)
            if val is not None and not _is_non_negative_finite(val):
                raise LlmAccountPoolStateError(f'LLM 账号池状态 account.usage 非法，已阻止覆盖 {target}')
        for req_num_field in ('monthlySpentUsd', 'weeklySpentUsd', 'lastUpdatedAtMs'):
            if req_num_field in u and not _is_non_negative_finite(u[req_num_field]):
                raise LlmAccountPoolStateError(f'LLM 账号池状态 account.usage 非法，已阻止覆盖 {target}')
        for int_field in ('monthlyTokens', 'monthlyRequests'):
            if int_field in u:
                val = u[int_field]
                if type(val) is not int or not (0 <= val <= MAX_SAFE_INTEGER):
                    raise LlmAccountPoolStateError(f'LLM 账号池状态 account.usage 非法，已阻止覆盖 {target}')
        if 'rolling5hBuckets' in u:
            buckets = u['rolling5hBuckets']
            if not isinstance(buckets, list):
                raise LlmAccountPoolStateError(f'LLM 账号池状态 account.usage 非法，已阻止覆盖 {target}')
            for bucket in buckets:
                if not isinstance(bucket, dict) \
                        or not _is_non_negative_finite(bucket.get('bucketMs')) \
                        or not _is_non_negative_finite(bucket.get('spentUsd')):
                    raise LlmAccountPoolStateError(f'LLM 账号池状态 account.usage 非法，已阻止覆盖 {target}')
                if 'tokens' in bucket and (type(bucket['tokens']) is not int or not (0 <= bucket['tokens'] <= MAX_SAFE_INTEGER)):
                    raise LlmAccountPoolStateError(f'LLM 账号池状态 account.usage 非法，已阻止覆盖 {target}')


def read_state_strict(state_file=LLM_ACCOUNT_POOL_STATE_FILE):
    target = Path(state_file)
    try:
        if target.is_symlink():
            raise LlmAccountPoolStateError(f'LLM 账号池状态路径禁止使用 symlink: {target}')
        state = json.loads(
            _read_regular_state_text(target),
            parse_constant=_reject_non_finite_json,
        )
    except FileNotFoundError:
        return _new_state()
    except LlmAccountPoolStateError:
        raise
    except (OSError, ValueError) as exc:
        raise LlmAccountPoolStateError(
            f'LLM 账号池状态损坏或不可读，已阻止覆盖 {target}: {exc}'
        ) from exc
    generation = state.get('generation') if isinstance(state, dict) else None
    if not _has_account_pool_header(state) \
            or type(generation) is not int \
            or generation < 0 or generation > MAX_SAFE_INTEGER \
            or not isinstance(state.get('services'), dict):
        raise LlmAccountPoolStateError(f'LLM 账号池状态 schema 非法，已阻止覆盖 {target}')
    for service in state['services'].values():
        if not isinstance(service, dict) \
                or not isinstance(service.get('endpoint'), str) \
                or not isinstance(service.get('accounts'), dict) \
                or not isinstance(service.get('groups'), dict):
            raise LlmAccountPoolStateError(
                f'LLM 账号池状态 service 非法，已阻止覆盖 {target}'
            )
        for record in service['accounts'].values():
            blocked_until = record.get('blockedUntilMs') if isinstance(record, dict) else None
            if not isinstance(record, dict) \
                    or ('blockedUntilMs' in record and (
                        not isinstance(blocked_until, (int, float))
                        or isinstance(blocked_until, bool)
                        or not math.isfinite(blocked_until) or blocked_until < 0
                    )):
                raise LlmAccountPoolStateError(
                    f'LLM 账号池状态 account 非法，已阻止覆盖 {target}'
                )
            _validate_account_subrecords(record, target)
        for group in service['groups'].values():
            if not isinstance(group, dict):
                raise LlmAccountPoolStateError(
                    f'LLM 账号池状态 group 非法，已阻止覆盖 {target}'
                )
            active = group.get('activeAccountId')
            # rotationCursor / lastSelectedAtMs 是等权轮转新增的可选字段。
            # 旧版状态没有它们也必须继续可读，所以只有出现时才校验类型。
            if active is not None and not isinstance(active, str):
                raise LlmAccountPoolStateError(
                    f'LLM 账号池状态 group 非法，已阻止覆盖 {target}'
                )
            if 'rotationCursor' in group:
                cursor = group['rotationCursor']
                if type(cursor) is not int or not (0 <= cursor <= MAX_SAFE_INTEGER):
                    raise LlmAccountPoolStateError(
                        f'LLM 账号池状态 group 非法，已阻止覆盖 {target}'
                    )
            if 'lastSelectedAtMs' in group:
                selected_at = group['lastSelectedAtMs']
                if isinstance(selected_at, bool) \
                        or not isinstance(selected_at, (int, float)) \
                        or not math.isfinite(selected_at) or selected_at < 0:
                    raise LlmAccountPoolStateError(
                        f'LLM 账号池状态 group 非法，已阻止覆盖 {target}'
                    )
    return state


def _update_state(state_file, updater):
    target = Path(state_file)
    with _state_lock(target):
        current = read_state_strict(target)
        updated = updater(current)
        if updated is None:
            return current
        if current['generation'] >= MAX_SAFE_INTEGER:
            raise LlmAccountPoolStateError('LLM 账号池 generation 已超出安全整数范围')
        updated['generation'] = current['generation'] + 1
        updated.pop('policyVersion', None)
        updated.pop('schemaVersion', None)
        updated.update(formats.record_header(ACCOUNT_POOL_CONTRACT, ACCOUNT_POOL_CONTRACT))
        atomic_write_json(target, updated, mode=0o600)
        return updated


def _ensure_service(state, identity):
    existing = state['services'].get(identity['service_id'])
    if existing is not None and existing.get('endpoint') != identity['service']:
        raise LlmAccountPoolStateError('LLM 账号池 service 身份与 endpoint 不一致')
    service = state['services'].setdefault(identity['service_id'], {
        'endpoint': identity['service'],
        'accounts': {},
        'groups': {},
    })
    if not isinstance(service.get('accounts'), dict):
        service['accounts'] = {}
    if not isinstance(service.get('groups'), dict):
        service['groups'] = {}
    return service


def beijing_date_from_ms(ms):
    if not isinstance(ms, (int, float)) or isinstance(ms, bool) or not math.isfinite(ms):
        return None
    return datetime.fromtimestamp((ms + BEIJING_OFFSET_MS) / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


def _days_in_utc_month(year, month_1_to_12):
    return calendar.monthrange(year, month_1_to_12)[1]


def _build_monthly_reset_at_offset(anchor_year, anchor_month, anchor_day, time_parts, tz_offset_min, month_offset):
    total_months = anchor_year * 12 + (anchor_month - 1) + month_offset
    year = total_months // 12
    month_1_to_12 = (total_months % 12) + 1
    day = min(anchor_day, _days_in_utc_month(year, month_1_to_12))
    dt = datetime(
        year, month_1_to_12, day,
        time_parts['hour'], time_parts['minute'], time_parts['second'],
        time_parts['ms'] * 1000, tzinfo=timezone.utc,
    )
    return int(round(dt.timestamp() * 1000)) - tz_offset_min * 60000


def _current_weekly_cycle_start_ms(now_ms):
    dt = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)
    days_since_monday = dt.weekday()
    start = datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc) - timedelta(days=days_since_monday)
    return int(round(start.timestamp() * 1000))


def _resolve_weekly_cycle_start_ms(record, now_ms):
    quota = record.get('quota') if isinstance(record, dict) and isinstance(record.get('quota'), dict) else {}
    weekly_reset_raw = quota.get('weeklyResetAtMs')
    if _is_non_negative_finite(weekly_reset_raw) and weekly_reset_raw > 0:
        week_ms = 7 * DAY_MS
        weekly_reset_ms = int(round(weekly_reset_raw))
        base_start = weekly_reset_ms - week_ms
        if base_start <= now_ms < weekly_reset_ms and base_start >= 0:
            return base_start
        if now_ms >= weekly_reset_ms:
            weeks_elapsed = int((now_ms - weekly_reset_ms) // week_ms)
            return weekly_reset_ms + weeks_elapsed * week_ms
        if base_start >= 0:
            return base_start
    return _current_weekly_cycle_start_ms(now_ms)


def _round_pct4(value):
    return math.floor(value * 10000.0 + 0.5) / 10000.0


def resolve_monthly_cycle(record, now_ms):
    if not isinstance(record, dict):
        return None
    quota = record.get('quota') if isinstance(record.get('quota'), dict) else {}
    windows = record.get('windows') if isinstance(record.get('windows'), dict) else {}
    anchor_ms = None
    anchor_day = None
    tz_offset_min = 0
    source = None

    if _is_non_negative_finite(quota.get('monthlyResetAtMs')) and quota['monthlyResetAtMs'] > 0:
        anchor_ms = quota['monthlyResetAtMs']
        tz_offset_min = quota['monthlyResetTzOffsetMin'] if type(quota.get('monthlyResetTzOffsetMin')) is int else 0
        local = datetime.fromtimestamp((anchor_ms + tz_offset_min * 60000) / 1000, tz=timezone.utc)
        anchor_day = quota['monthlyResetDay'] if type(quota.get('monthlyResetDay')) is int else local.day
        source = quota.get('monthlyResetSource') or 'manual'
    elif type(quota.get('monthlyResetDay')) is int and 1 <= quota['monthlyResetDay'] <= 31:
        tz_offset_min = quota['monthlyResetTzOffsetMin'] if type(quota.get('monthlyResetTzOffsetMin')) is int else 480
        now_local = datetime.fromtimestamp((now_ms + tz_offset_min * 60000) / 1000, tz=timezone.utc)
        anchor_day = quota['monthlyResetDay']
        day = min(anchor_day, _days_in_utc_month(now_local.year, now_local.month))
        dt = datetime(now_local.year, now_local.month, day, 23, 59, 59, 999000, tzinfo=timezone.utc)
        anchor_ms = int(round(dt.timestamp() * 1000)) - tz_offset_min * 60000
        source = quota.get('monthlyResetSource') or 'manual'
    elif _is_non_negative_finite(quota.get('autoMonthlyAnchorMs')) and quota['autoMonthlyAnchorMs'] > 0:
        anchor_ms = quota['autoMonthlyAnchorMs']
        tz_offset_min = 0
        anchor_day = datetime.fromtimestamp(anchor_ms / 1000, tz=timezone.utc).day
        source = 'auto_429'
    elif isinstance(windows.get('monthly'), dict) \
            and _is_non_negative_finite(windows['monthly'].get('blockedUntilMs')) \
            and windows['monthly']['blockedUntilMs'] > 0:
        anchor_ms = windows['monthly']['blockedUntilMs']
        tz_offset_min = 0
        anchor_day = datetime.fromtimestamp(anchor_ms / 1000, tz=timezone.utc).day
        source = 'auto_429'
    elif record.get('limitName') == 'monthly' \
            and _is_non_negative_finite(record.get('blockedUntilMs')) \
            and record['blockedUntilMs'] > 0:
        anchor_ms = record['blockedUntilMs']
        tz_offset_min = 0
        anchor_day = datetime.fromtimestamp(anchor_ms / 1000, tz=timezone.utc).day
        source = 'auto_429'

    if anchor_ms is None:
        return None
    anchor_local_ms = int(round(anchor_ms)) + tz_offset_min * 60000
    anchor_local = datetime.fromtimestamp(anchor_local_ms / 1000, tz=timezone.utc)
    anchor_year = anchor_local.year
    anchor_month = anchor_local.month
    time_parts = {
        'hour': anchor_local.hour,
        'minute': anchor_local.minute,
        'second': anchor_local.second,
        'ms': anchor_local_ms % 1000,
    }
    now_local = datetime.fromtimestamp((now_ms + tz_offset_min * 60000) / 1000, tz=timezone.utc)
    offset = (now_local.year - anchor_year) * 12 + (now_local.month - anchor_month)
    candidate = _build_monthly_reset_at_offset(anchor_year, anchor_month, anchor_day, time_parts, tz_offset_min, offset)
    while candidate <= now_ms:
        offset += 1
        candidate = _build_monthly_reset_at_offset(anchor_year, anchor_month, anchor_day, time_parts, tz_offset_min, offset)
    prev = _build_monthly_reset_at_offset(anchor_year, anchor_month, anchor_day, time_parts, tz_offset_min, offset - 1)
    while prev > now_ms:
        offset -= 1
        candidate = prev
        prev = _build_monthly_reset_at_offset(anchor_year, anchor_month, anchor_day, time_parts, tz_offset_min, offset - 1)
    return {
        'cycle_start_ms': prev,
        'next_reset_ms': candidate,
        'expiry_beijing_date': beijing_date_from_ms(candidate),
        'anchor_day': anchor_day,
        'source': source,
    }


def _sum_rolling_5h_spend_usd(usage, now_ms, since_ms=0):
    cutoff = max(now_ms - ROLLING_5H_MS, since_ms or 0)
    buckets = usage.get('rolling5hBuckets') if isinstance(usage, dict) else None
    if not isinstance(buckets, list):
        return 0.0
    total = 0.0
    for bucket in buckets:
        if not isinstance(bucket, dict):
            continue
        b_ms = bucket.get('bucketMs')
        spent = bucket.get('spentUsd')
        if not _is_non_negative_finite(b_ms) or not _is_non_negative_finite(spent):
            continue
        if b_ms + ROLLING_5H_BUCKET_MS > cutoff and b_ms <= now_ms + ROLLING_5H_BUCKET_MS:
            total += float(spent)
    return total


def _get_rolling_5h_bucket_spend_usd(usage, target_bucket_ms):
    buckets = usage.get('rolling5hBuckets') if isinstance(usage, dict) else None
    if not isinstance(buckets, list):
        return 0.0
    total = 0.0
    for bucket in buckets:
        if not isinstance(bucket, dict):
            continue
        b_ms = bucket.get('bucketMs')
        spent = bucket.get('spentUsd')
        if not _is_non_negative_finite(b_ms) or not _is_non_negative_finite(spent):
            continue
        if b_ms == target_bucket_ms:
            total += float(spent)
    return total


def _sum_rolling_5h_post_snapshot_spend_usd(usage, now_ms, snap_ms, spent_at_snap_usd):
    snap_bucket_ms = (int(snap_ms) // ROLLING_5H_BUCKET_MS) * ROLLING_5H_BUCKET_MS
    cutoff = now_ms - ROLLING_5H_MS
    buckets = usage.get('rolling5hBuckets') if isinstance(usage, dict) else None
    if not isinstance(buckets, list):
        return 0.0
    snap_bucket_spend = 0.0
    later_buckets_spend = 0.0
    for bucket in buckets:
        if not isinstance(bucket, dict):
            continue
        b_ms = bucket.get('bucketMs')
        spent = bucket.get('spentUsd')
        if not _is_non_negative_finite(b_ms) or not _is_non_negative_finite(spent):
            continue
        if b_ms + ROLLING_5H_BUCKET_MS <= cutoff or b_ms > now_ms + ROLLING_5H_BUCKET_MS:
            continue
        if b_ms == snap_bucket_ms:
            snap_bucket_spend += float(spent)
        elif b_ms > snap_bucket_ms:
            later_buckets_spend += float(spent)
    clamped_snap = float(spent_at_snap_usd) if _is_non_negative_finite(spent_at_snap_usd) else 0.0
    return max(0.0, snap_bucket_spend - clamped_snap) + later_buckets_spend


def evaluate_account_quota(record, now_ms):
    safe_record = record if isinstance(record, dict) else {}
    windows = safe_record.get('windows') if isinstance(safe_record.get('windows'), dict) else {}
    quota = safe_record.get('quota') if isinstance(safe_record.get('quota'), dict) else {}
    usage = safe_record.get('usage') if isinstance(safe_record.get('usage'), dict) else {}
    monthly_cycle = resolve_monthly_cycle(safe_record, now_ms)
    week_start_ms = _resolve_weekly_cycle_start_ms(safe_record, now_ms)
    next_week_reset_ms = week_start_ms + 7 * DAY_MS

    def window_blocked_until(name):
        entry = windows.get(name)
        val = entry.get('blockedUntilMs') if isinstance(entry, dict) else None
        return val if _is_non_negative_finite(val) and val > now_ms else 0

    monthly_blocked = window_blocked_until('monthly')
    weekly_blocked = window_blocked_until('weekly')
    rolling5h_blocked = window_blocked_until('rolling_5h')
    balance_blocked = window_blocked_until('balance')
    unknown_blocked = window_blocked_until('unknown')
    legacy_val = safe_record.get('blockedUntilMs')
    legacy_blocked = legacy_val if _is_non_negative_finite(legacy_val) and legacy_val > now_ms else 0

    if legacy_blocked > 0 and not windows:
        if safe_record.get('limitName') == 'monthly':
            monthly_blocked = max(monthly_blocked, legacy_blocked)
        elif safe_record.get('limitName') == 'weekly':
            weekly_blocked = max(weekly_blocked, legacy_blocked)
        elif safe_record.get('limitName') == 'rolling_5h':
            rolling5h_blocked = max(rolling5h_blocked, legacy_blocked)
        elif safe_record.get('limitName') == 'balance':
            balance_blocked = max(balance_blocked, legacy_blocked)

    fallback_snap = quota['snapshotAtMs'] if _is_non_negative_finite(quota.get('snapshotAtMs')) else 0
    monthly_snap = quota['monthlySnapshotAtMs'] if _is_non_negative_finite(quota.get('monthlySnapshotAtMs')) else fallback_snap
    weekly_snap = quota['weeklySnapshotAtMs'] if _is_non_negative_finite(quota.get('weeklySnapshotAtMs')) else fallback_snap
    rolling5h_snap = quota['rolling5hSnapshotAtMs'] if _is_non_negative_finite(quota.get('rolling5hSnapshotAtMs')) else fallback_snap
    budget_monthly = float(quota['monthlyBudgetUsd']) if _is_non_negative_finite(quota.get('monthlyBudgetUsd')) and quota['monthlyBudgetUsd'] > 0 else DEFAULT_MONTHLY_BUDGET_USD
    budget_weekly = budget_monthly * 0.5
    budget_5h = budget_monthly * 0.2

    monthly_pct_raw = quota.get('monthlyRemainingPct')
    monthly_snapshot_active = _is_percent_value(monthly_pct_raw) and monthly_snap > 0 and (
        monthly_snap >= monthly_cycle['cycle_start_ms'] if monthly_cycle is not None else (now_ms - monthly_snap) < 31 * DAY_MS
    )
    if monthly_snapshot_active and monthly_pct_raw == 0:
        until = monthly_cycle['next_reset_ms'] if monthly_cycle is not None else (monthly_snap + 31 * DAY_MS)
        if until > now_ms:
            monthly_blocked = max(monthly_blocked, until)

    weekly_reset_raw = quota.get('weeklyResetAtMs')
    has_explicit_weekly_reset = _is_non_negative_finite(weekly_reset_raw) and weekly_reset_raw > 0
    weekly_reset_ms = weekly_reset_raw if has_explicit_weekly_reset else next_week_reset_ms
    weekly_pct_raw = quota.get('weeklyRemainingPct')
    weekly_snapshot_active = _is_percent_value(weekly_pct_raw) and weekly_snap > 0 and (
        now_ms < weekly_reset_raw if has_explicit_weekly_reset else weekly_snap >= week_start_ms
    )
    if weekly_snapshot_active and weekly_pct_raw == 0 and weekly_reset_ms > now_ms:
        weekly_blocked = max(weekly_blocked, weekly_reset_ms)

    r5h_reset_raw = quota.get('rolling5hResetAtMs')
    has_explicit_r5h_reset = _is_non_negative_finite(r5h_reset_raw) and r5h_reset_raw > 0
    r5h_reset_ms = r5h_reset_raw if has_explicit_r5h_reset else (rolling5h_snap + ROLLING_5H_MS if rolling5h_snap > 0 else 0)
    r5h_pct_raw = quota.get('rolling5hRemainingPct')
    r5h_snapshot_active = _is_percent_value(r5h_pct_raw) and rolling5h_snap > 0 and (
        now_ms < r5h_reset_raw if has_explicit_r5h_reset else now_ms < rolling5h_snap + ROLLING_5H_MS
    )
    if r5h_snapshot_active and r5h_pct_raw == 0 and r5h_reset_ms > now_ms:
        rolling5h_blocked = max(rolling5h_blocked, r5h_reset_ms)

    active_blocked = max(
        legacy_blocked, monthly_blocked, weekly_blocked,
        rolling5h_blocked, balance_blocked, unknown_blocked,
    )
    has_monthly = monthly_blocked == 0
    has_weekly = weekly_blocked == 0
    has_r5h = rolling5h_blocked == 0
    has_balance = balance_blocked == 0
    eligible = active_blocked == 0

    usage_month_start = usage.get('monthlyCycleStartMs')
    current_monthly_spent = float(usage['monthlySpentUsd']) if (
        _is_non_negative_finite(usage.get('monthlySpentUsd'))
        and (
            (_is_non_negative_finite(usage_month_start) and usage_month_start == monthly_cycle['cycle_start_ms'])
            if monthly_cycle is not None
            else (usage_month_start is None)
        )
    ) else 0.0
    if not has_monthly:
        eff_monthly = 0.0
    elif monthly_snapshot_active:
        spent_at_snap = float(quota['monthlySpentAtSnapshotUsd']) if _is_non_negative_finite(quota.get('monthlySpentAtSnapshotUsd')) else 0.0
        delta_usd = max(0.0, current_monthly_spent - spent_at_snap)
        eff_monthly = _round_pct4(max(MIN_ESTIMATED_REMAINING_PCT, min(100.0, float(monthly_pct_raw) - (delta_usd / budget_monthly) * 100.0)))
    else:
        eff_monthly = _round_pct4(max(MIN_ESTIMATED_REMAINING_PCT, min(100.0, 100.0 - (current_monthly_spent / budget_monthly) * 100.0)))

    current_weekly_spent = float(usage['weeklySpentUsd']) if (
        _is_non_negative_finite(usage.get('weeklySpentUsd'))
        and _is_non_negative_finite(usage.get('weeklyCycleStartMs'))
        and usage['weeklyCycleStartMs'] == week_start_ms
    ) else 0.0
    if not has_weekly:
        eff_weekly = 0.0
    elif weekly_snapshot_active:
        spent_at_snap = float(quota['weeklySpentAtSnapshotUsd']) if _is_non_negative_finite(quota.get('weeklySpentAtSnapshotUsd')) else 0.0
        delta_usd = max(0.0, current_weekly_spent - spent_at_snap)
        eff_weekly = _round_pct4(max(MIN_ESTIMATED_REMAINING_PCT, min(100.0, float(weekly_pct_raw) - (delta_usd / budget_weekly) * 100.0)))
    else:
        eff_weekly = _round_pct4(max(MIN_ESTIMATED_REMAINING_PCT, min(100.0, 100.0 - (current_weekly_spent / budget_weekly) * 100.0)))

    current_5h_spent = _sum_rolling_5h_spend_usd(usage, now_ms, 0)
    if not has_r5h:
        eff_5h = 0.0
    elif r5h_snapshot_active:
        delta_usd = _sum_rolling_5h_post_snapshot_spend_usd(
            usage, now_ms, rolling5h_snap, quota.get('rolling5hSpentAtSnapshotUsd'),
        )
        eff_5h = _round_pct4(max(MIN_ESTIMATED_REMAINING_PCT, min(100.0, float(r5h_pct_raw) - (delta_usd / budget_5h) * 100.0)))
    else:
        eff_5h = _round_pct4(max(MIN_ESTIMATED_REMAINING_PCT, min(100.0, 100.0 - (current_5h_spent / budget_5h) * 100.0)))

    return {
        'eligible': eligible,
        'active_blocked_until_ms': active_blocked,
        'has_monthly_quota': has_monthly,
        'has_weekly_quota': has_weekly,
        'has_rolling5h_quota': has_r5h,
        'has_balance_quota': has_balance,
        'monthly_cycle': monthly_cycle,
        'monthly_budget_usd': budget_monthly,
        'monthly_remaining_source': (
            'live_api'
            if (monthly_snapshot_active and quota.get('monthlyResetSource') == 'live_api' and _is_non_negative_finite(quota.get('lastLiveSyncAtMs')))
            else ('manual_snapshot' if monthly_snapshot_active else 'cycle_estimate')
        ),
        'last_live_sync_at_ms': float(quota['lastLiveSyncAtMs']) if _is_non_negative_finite(quota.get('lastLiveSyncAtMs')) else None,
        'effective_monthly_remaining_pct': eff_monthly,
        'effective_weekly_remaining_pct': eff_weekly,
        'effective_rolling5h_remaining_pct': eff_5h,
        'current_monthly_spent_usd': current_monthly_spent,
        'current_weekly_spent_usd': current_weekly_spent,
        'current_5h_spent_usd': current_5h_spent,
        'label': quota.get('label') if isinstance(quota.get('label'), str) else None,
    }


def _account_is_blocked(record, now_ms):
    return not evaluate_account_quota(record, now_ms)['eligible']


def _resolve_pool_strategy(strategy=None):
    raw = str(strategy if strategy is not None else os.environ.get('PD_LLM_ACCOUNT_POOL_STRATEGY', 'expiry_priority')).strip().lower()
    return 'equal_rotation' if raw == 'equal_rotation' else 'expiry_priority'


def _tier1_sort_key(item):
    ev = item['eval']
    return (
        ev['monthly_cycle']['expiry_beijing_date'],
        -ev['effective_monthly_remaining_pct'],
        -ev['effective_weekly_remaining_pct'],
        -ev['effective_rolling5h_remaining_pct'],
        ev['monthly_cycle']['next_reset_ms'],
    )


def _choose_pool_candidate(service, ordered_account_ids, group, excluded, now_ms, normalized_affinity, strategy):
    accounts = service.get('accounts') or {}
    if strategy != 'equal_rotation':
        tier1 = []
        for index, account_id in enumerate(ordered_account_ids):
            if account_id in excluded:
                continue
            evaluated = evaluate_account_quota(accounts.get(account_id, {}), now_ms)
            if not evaluated['eligible']:
                continue
            if evaluated['monthly_cycle'] is not None:
                tier1.append({'index': index, 'account_id': account_id, 'eval': evaluated})
        if tier1:
            tier1.sort(key=lambda item: (*_tier1_sort_key(item), item['index']))
            best = tier1[0]
            best_key = _tier1_sort_key(best)
            tied = [item for item in tier1 if _tier1_sort_key(item) == best_key]
            picked = best
            if len(tied) > 1 and normalized_affinity:
                pick_offset = int(_sha256(normalized_affinity)[:8], 16) % len(tied)
                picked = tied[pick_offset]
            return {
                'selected_index': picked['index'],
                'account_id': picked['account_id'],
                'selection_mode': 'expiry_priority',
                'evaluated': picked['eval'],
            }

    if normalized_affinity:
        start_index = int(_sha256(normalized_affinity)[:8], 16) % len(ordered_account_ids)
    else:
        start_index = _resolve_rotation_cursor(group, ordered_account_ids)
    for step in range(len(ordered_account_ids)):
        index = (start_index + step) % len(ordered_account_ids)
        account_id = ordered_account_ids[index]
        if account_id in excluded:
            continue
        evaluated = evaluate_account_quota(accounts.get(account_id, {}), now_ms)
        if not evaluated['eligible']:
            continue
        return {
            'selected_index': index,
            'account_id': account_id,
            'selection_mode': 'affinity' if normalized_affinity else 'equal_rotation',
            'evaluated': evaluated,
        }
    return None


def _group_last_used_at_ms(group):
    selected_at = group.get('lastSelectedAtMs') if isinstance(group, dict) else None
    if isinstance(selected_at, (int, float)) and not isinstance(selected_at, bool) \
            and math.isfinite(selected_at) and selected_at >= 0:
        return selected_at
    switched_at = group.get('switchedAt') if isinstance(group, dict) else None
    if not isinstance(switched_at, str) or not switched_at:
        return None
    try:
        parsed = datetime.fromisoformat(switched_at)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() * 1000


def _prune_stale_groups(service, current_group_id, now_ms):
    for group_id in list(service['groups']):
        if group_id == current_group_id:
            continue
        last_used_at_ms = _group_last_used_at_ms(service['groups'][group_id])
        # 没有可解析时间戳的旧分组属于历史遗留，同样清理；当前分组始终保留。
        if last_used_at_ms is None or now_ms - last_used_at_ms > STALE_GROUP_MS:
            del service['groups'][group_id]


def _build_exhausted_error(service, account_ids, now_ms):
    blocked_times = [
        evaluate_account_quota(service['accounts'].get(account_id, {}), now_ms)['active_blocked_until_ms']
        for account_id in account_ids
    ]
    blocked_times = [ms for ms in blocked_times if ms > now_ms]
    earliest = min(blocked_times, default=None)
    suffix = '' if earliest is None else (
        '，最早恢复时间 '
        + datetime.fromtimestamp(earliest / 1000, tz=timezone.utc).isoformat()
    )
    return LlmAccountPoolExhaustedError(
        f'OpenCode Go 账号池没有可用账号（全部冷却中或已被本次逻辑请求排除）；下一逻辑请求会从轮转游标继续{suffix}',
        earliest_retry_at_ms=earliest,
        blocked_account_count=len(blocked_times),
    )


def _ordered_account_ids(identity):
    # 轮转顺序不能依赖配置里的 key 顺序：按 account_id 稳定排序后，主账号
    # 和任一备用账号完全同权，配置顺序不同也不会改变选择序列。
    return sorted(identity['account_ids'])


def _resolve_rotation_cursor(group, ordered_account_ids):
    size = len(ordered_account_ids)
    stored = group.get('rotationCursor')
    if type(stored) is int and 0 <= stored <= MAX_SAFE_INTEGER:
        return stored % size
    # 兼容旧版 v1 状态：旧实现只保存 activeAccountId（最后使用的账号）。
    # 把它的排序位置当作下一个候选，使升级后的首次选择仍与旧状态连续，
    # 随后自然进入等权轮转。
    active_id = group.get('activeAccountId')
    if isinstance(active_id, str) and active_id in ordered_account_ids:
        return ordered_account_ids.index(active_id)
    return 0


# 单账号配置（len(api_keys) < 2）不会调用本函数：调用方走各自的单账号
# 直连分支，因此不写账号池状态（既有行为，测试已固化）。
def select_api_key(api_keys, endpoint, state_file=LLM_ACCOUNT_POOL_STATE_FILE, *,
                   now_ms=None, exclude_account_ids=(), affinity_key=None, strategy=None, force_write=False):
    keys = normalize_api_keys(api_keys)
    identity = get_pool_identity(keys, endpoint)
    ordered_account_ids = _ordered_account_ids(identity)
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    excluded = set(exclude_account_ids or ())
    resolved_strategy = _resolve_pool_strategy(strategy)
    normalized_affinity = affinity_key.strip() if isinstance(affinity_key, str) else ''
    if normalized_affinity:
        normalized_affinity = re.sub(r'^arxiv:', '', normalized_affinity, flags=re.IGNORECASE)
        normalized_affinity = re.sub(r'^(\d{4}\.\d{4,5})v\d+$', r'\1', normalized_affinity, flags=re.IGNORECASE)
    keys_by_id = dict(zip(identity['account_ids'], keys))

    _assert_safe_project_state_path(state_file)

    # 只读快路径：与 JS 实现保持一致，减少高并发亲和或同账号 expiry_priority 命中时的同步 fsync。
    if not force_write:
        try:
            state = read_state_strict(state_file)
            service = (state.get('services') or {}).get(identity['service_id'])
            if service is not None and service.get('endpoint') != identity['service']:
                raise LlmAccountPoolStateError('LLM 账号池 service 身份与 endpoint 不一致')
            groups = (service or {}).get('groups') or {}
            group = groups.get(identity['group_id'])
            stored_cursor = group.get('rotationCursor') if isinstance(group, dict) else None
            stale_prune_needed = len(groups) > 1 and any(
                gid != identity['group_id']
                and (now_ms - int((g or {}).get('lastSelectedAtMs') or 0)) > STALE_GROUP_MS
                for gid, g in groups.items()
            )
            if service and isinstance(group, dict) \
                    and (type(stored_cursor) is int and 0 <= stored_cursor <= MAX_SAFE_INTEGER) \
                    and not stale_prune_needed:
                candidate = _choose_pool_candidate(
                    service, ordered_account_ids, group, excluded, now_ms, normalized_affinity, resolved_strategy,
                )
                if candidate is not None and candidate['selection_mode'] != 'equal_rotation':
                    next_id = candidate['account_id']
                    accounts = service.get('accounts') or {}
                    acct_status = (accounts.get(next_id) or {}).get('status')
                    last_selected = int(group.get('lastSelectedAtMs') or 0)
                    same_active_or_affinity = (
                        candidate['selection_mode'] == 'affinity' or group.get('activeAccountId') == next_id
                    )
                    if same_active_or_affinity and acct_status != 'quota_blocked' and last_selected > 0 \
                            and now_ms >= last_selected and (now_ms - last_selected) < 60_000:
                        return {
                            'api_key': keys_by_id[next_id],
                            'account_id': next_id,
                            'selection_mode': candidate['selection_mode'],
                            **identity,
                        }
        except LlmAccountPoolStateError:
            raise
        except Exception:
            pass

    selection = {}

    def updater(state):
        service = _ensure_service(state, identity)
        _prune_stale_groups(service, identity['group_id'], now_ms)
        group = service['groups'].get(identity['group_id'])
        if group is None:
            group = {
                'activeAccountId': None,
                'switchedAt': None,
            }
        service['groups'][identity['group_id']] = group
        candidate = _choose_pool_candidate(
            service, ordered_account_ids, group, excluded, now_ms, normalized_affinity, resolved_strategy,
        )
        if candidate is None:
            raise _build_exhausted_error(service, ordered_account_ids, now_ms)
        next_id = candidate['account_id']
        if candidate['selection_mode'] == 'equal_rotation':
            group['rotationCursor'] = (candidate['selected_index'] + 1) % len(ordered_account_ids)
        else:
            stored_cursor = group.get('rotationCursor')
            if not (type(stored_cursor) is int and 0 <= stored_cursor <= MAX_SAFE_INTEGER):
                group['rotationCursor'] = _resolve_rotation_cursor(group, ordered_account_ids)
        group['activeAccountId'] = next_id
        group['lastSelectedAtMs'] = now_ms
        group['switchedAt'] = datetime.fromtimestamp(
            now_ms / 1000, tz=timezone.utc
        ).isoformat()
        if service['accounts'].get(next_id, {}).get('status') == 'quota_blocked':
            service['accounts'][next_id]['status'] = 'eligible_after_reset'
        selection.update({
            'api_key': keys_by_id[next_id],
            'account_id': next_id,
            'selection_mode': candidate['selection_mode'],
            **identity,
        })
        return state

    _update_state(state_file, updater)
    return selection


def mark_quota_exhausted(selection, quota, state_file=LLM_ACCOUNT_POOL_STATE_FILE, *, now_ms=None):
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    requested_until = quota.get('blocked_until_ms') if isinstance(quota, dict) else None
    if not isinstance(requested_until, (int, float)) or isinstance(requested_until, bool) \
            or not math.isfinite(requested_until):
        requested_until = now_ms + UNKNOWN_QUOTA_BLOCK_MS
    blocked_until_ms = min(now_ms + MAX_BLOCK_MS, max(now_ms + 1000, int(requested_until)))
    raw_limit_class = str((quota or {}).get('limit_class') or '')
    limit_class = raw_limit_class if raw_limit_class in QUOTA_WINDOWS else 'unknown'
    effective_until_box = [blocked_until_ms]

    def updater(state):
        service = _ensure_service(state, selection)
        previous = service['accounts'].get(selection['account_id'])
        previous = dict(previous) if isinstance(previous, dict) else {}
        prev_windows = dict(previous.get('windows')) if isinstance(previous.get('windows'), dict) else {}
        prev_window_entry = prev_windows.get(limit_class)
        prev_window_until = (
            prev_window_entry.get('blockedUntilMs')
            if isinstance(prev_window_entry, dict) and _is_non_negative_finite(prev_window_entry.get('blockedUntilMs'))
            else 0
        )
        window_until_ms = max(int(prev_window_until), blocked_until_ms)
        prev_windows[limit_class] = {
            'blockedUntilMs': window_until_ms,
            'blockedUntil': datetime.fromtimestamp(window_until_ms / 1000, tz=timezone.utc).isoformat(),
            'lastExhaustedAt': datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).isoformat(),
        }

        max_window_until = max(int(previous.get('blockedUntilMs') or 0), window_until_ms)
        for entry in prev_windows.values():
            if isinstance(entry, dict) and _is_non_negative_finite(entry.get('blockedUntilMs')):
                max_window_until = max(max_window_until, int(entry['blockedUntilMs']))
        effective_until_box[0] = max_window_until

        next_quota = dict(previous.get('quota')) if isinstance(previous.get('quota'), dict) else {}
        if limit_class == 'monthly':
            next_quota['autoMonthlyAnchorMs'] = window_until_ms
            if next_quota.get('monthlyResetSource') not in ('manual', 'live_api'):
                next_quota['monthlyResetAtMs'] = window_until_ms
                next_quota['monthlyResetTzOffsetMin'] = 0
                next_quota['monthlyResetDay'] = datetime.fromtimestamp(window_until_ms / 1000, tz=timezone.utc).day
                next_quota['monthlyResetSource'] = 'auto_429'
            next_quota['monthlyRemainingPct'] = 0
            next_quota['monthlySnapshotAtMs'] = now_ms
        elif limit_class == 'weekly':
            next_quota['weeklyRemainingPct'] = 0
            next_quota['weeklyResetAtMs'] = window_until_ms
            next_quota['weeklySnapshotAtMs'] = now_ms
        elif limit_class == 'rolling_5h':
            next_quota['rolling5hRemainingPct'] = 0
            next_quota['rolling5hResetAtMs'] = window_until_ms
            next_quota['rolling5hSnapshotAtMs'] = now_ms

        next_record = {
            **previous,
            'status': 'quota_blocked',
            'reason': (quota or {}).get('type') or 'GoUsageLimitError',
            'limitName': limit_class,
            'blockedUntilMs': max_window_until,
            'blockedUntil': datetime.fromtimestamp(
                max_window_until / 1000, tz=timezone.utc
            ).isoformat(),
            'lastFailureAt': datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).isoformat(),
            'lastFailureStatus': 401 if (quota or {}).get('type') == 'InsufficientBalanceError' else 429,
            'windows': prev_windows,
        }
        if next_quota:
            next_record['quota'] = next_quota
        service['accounts'][selection['account_id']] = next_record
        return state

    _update_state(state_file, updater)
    return effective_until_box[0]


def _first_present(*values):
    for value in values:
        if value is not None:
            return value
    return None


def _estimate_usage_spend_usd(usage_info):
    if not isinstance(usage_info, dict):
        return 0.0, 0
    explicit_cost = _first_present(
        usage_info.get('costUsd'),
        usage_info.get('cost_usd'),
        usage_info.get('estimatedCostUsd'),
        usage_info.get('estimated_cost_usd'),
        usage_info.get('cost'),
    )
    raw_usage = usage_info.get('usage') if isinstance(usage_info.get('usage'), dict) else usage_info

    def _as_num(val):
        return float(val) if isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val) else 0.0

    inp = _as_num(_first_present(
        raw_usage.get('inputTokens'),
        raw_usage.get('input_tokens'),
        raw_usage.get('prompt_tokens'),
    ))
    input_details = raw_usage.get('input_tokens_details') if isinstance(raw_usage.get('input_tokens_details'), dict) else {}
    prompt_details = raw_usage.get('prompt_tokens_details') if isinstance(raw_usage.get('prompt_tokens_details'), dict) else {}
    cached = _as_num(_first_present(
        raw_usage.get('cachedInputTokens'),
        input_details.get('cached_tokens'),
        prompt_details.get('cached_tokens'),
        raw_usage.get('cache_read_input_tokens'),
    ))
    out = _as_num(_first_present(
        raw_usage.get('outputTokens'),
        raw_usage.get('output_tokens'),
        raw_usage.get('completion_tokens'),
    ))
    total_raw = _first_present(raw_usage.get('totalTokens'), raw_usage.get('total_tokens'))
    total_tokens = max(0, int(round(_as_num(total_raw) if total_raw is not None else (inp + out))))
    if isinstance(explicit_cost, (int, float)) and not isinstance(explicit_cost, bool) \
            and math.isfinite(explicit_cost) and explicit_cost >= 0:
        return float(explicit_cost), total_tokens
    if inp <= 0 and out <= 0 and total_tokens <= 0:
        return 0.0, 0
    safe_cached = max(0.0, min(inp, cached))
    uncached_in = max(0.0, inp - safe_cached)
    safe_out = max(0.0, out)
    spent_usd = (
        uncached_in * DEFAULT_INPUT_USD_PER_M
        + safe_cached * DEFAULT_CACHED_INPUT_USD_PER_M
        + safe_out * DEFAULT_OUTPUT_USD_PER_M
    ) / 1_000_000.0
    spent_usd = math.floor(spent_usd * 1e6 + 0.5) / 1e6 if math.isfinite(spent_usd) and spent_usd >= 0 else 0.0
    return spent_usd, total_tokens


def record_account_usage(selection, usage_info, state_file=LLM_ACCOUNT_POOL_STATE_FILE, *, now_ms=None):
    if not isinstance(selection, dict) or not selection.get('service_id') or not selection.get('account_id'):
        return None
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    spent_usd, total_tokens = _estimate_usage_spend_usd(usage_info)
    if spent_usd <= 0 and total_tokens <= 0:
        return None
    recorded = [None]

    def updater(state):
        service = _ensure_service(state, selection)
        previous = service['accounts'].get(selection['account_id'])
        previous = dict(previous) if isinstance(previous, dict) else {}
        monthly_cycle = resolve_monthly_cycle(previous, now_ms)
        monthly_cycle_start = monthly_cycle['cycle_start_ms'] if monthly_cycle is not None else None
        week_start_ms = _resolve_weekly_cycle_start_ms(previous, now_ms)
        prev_usage = previous.get('usage') if isinstance(previous.get('usage'), dict) else {}

        same_month = (
            prev_usage.get('monthlyCycleStartMs') == monthly_cycle_start
            if monthly_cycle_start is not None
            else prev_usage.get('monthlyCycleStartMs') is None
        )
        same_week = prev_usage.get('weeklyCycleStartMs') == week_start_ms

        bucket_ms = (now_ms // ROLLING_5H_BUCKET_MS) * ROLLING_5H_BUCKET_MS
        cutoff_ms = now_ms - ROLLING_5H_MS
        next_buckets = []
        merged = False
        for bucket in (prev_usage.get('rolling5hBuckets') if isinstance(prev_usage.get('rolling5hBuckets'), list) else []):
            if not isinstance(bucket, dict):
                continue
            b_ms = bucket.get('bucketMs')
            b_spent = bucket.get('spentUsd')
            if not _is_non_negative_finite(b_ms) or not _is_non_negative_finite(b_spent):
                continue
            if b_ms + ROLLING_5H_BUCKET_MS <= cutoff_ms:
                continue
            b_tokens = bucket.get('tokens') if type(bucket.get('tokens')) is int else 0
            if b_ms == bucket_ms:
                next_buckets.append({
                    'bucketMs': bucket_ms,
                    'spentUsd': math.floor((float(b_spent) + spent_usd) * 1e6 + 0.5) / 1e6,
                    'tokens': b_tokens + total_tokens,
                })
                merged = True
            else:
                next_buckets.append({'bucketMs': b_ms, 'spentUsd': float(b_spent), 'tokens': b_tokens})
        if not merged:
            next_buckets.append({'bucketMs': bucket_ms, 'spentUsd': spent_usd, 'tokens': total_tokens})
        next_buckets.sort(key=lambda item: item['bucketMs'])

        prev_m_spent = float(prev_usage['monthlySpentUsd']) if same_month and _is_non_negative_finite(prev_usage.get('monthlySpentUsd')) else 0.0
        prev_m_tokens = prev_usage['monthlyTokens'] if same_month and type(prev_usage.get('monthlyTokens')) is int else 0
        prev_m_reqs = prev_usage['monthlyRequests'] if same_month and type(prev_usage.get('monthlyRequests')) is int else 0
        prev_w_spent = float(prev_usage['weeklySpentUsd']) if same_week and _is_non_negative_finite(prev_usage.get('weeklySpentUsd')) else 0.0

        next_usage = {
            'monthlyCycleStartMs': monthly_cycle_start,
            'monthlySpentUsd': math.floor((prev_m_spent + spent_usd) * 1e6 + 0.5) / 1e6,
            'monthlyTokens': prev_m_tokens + total_tokens,
            'monthlyRequests': prev_m_reqs + 1,
            'weeklyCycleStartMs': week_start_ms,
            'weeklySpentUsd': math.floor((prev_w_spent + spent_usd) * 1e6 + 0.5) / 1e6,
            'rolling5hBuckets': next_buckets,
            'lastUpdatedAtMs': now_ms,
        }
        service['accounts'][selection['account_id']] = {
            **previous,
            'usage': next_usage,
        }
        recorded[0] = next_usage
        return state

    _update_state(state_file, updater)
    return recorded[0]


def _header_values(headers, name):
    if headers is None:
        return []
    target = name.lower()
    try:
        items = headers.items()
    except AttributeError:
        items = dict(headers).items()
    values = []
    for key, value in items:
        if str(key).lower() != target:
            continue
        if isinstance(value, (list, tuple)):
            values.extend(value)
        else:
            values.append(value)
    return values


def _parse_positive_finite_delay(value):
    text = str(value or '').strip()
    if not re.fullmatch(r'\d+(?:\.\d+)?', text):
        return None
    parsed = float(text)
    return parsed if math.isfinite(parsed) and parsed > 0 else None


_HTTP_TZ_OFFSETS_MIN = {
    'GMT': 0, 'UTC': 0, 'UT': 0,
    'EST': -300, 'EDT': -240, 'CST': -360, 'CDT': -300,
    'MST': -420, 'MDT': -360, 'PST': -480, 'PDT': -420,
}
_HTTP_MONTH_MAP = {
    'jan': 1, 'january': 1, 'feb': 2, 'february': 2, 'mar': 3, 'march': 3,
    'apr': 4, 'april': 4, 'may': 5, 'jun': 6, 'june': 6, 'jul': 7, 'july': 7,
    'aug': 8, 'august': 8, 'sep': 9, 'september': 9, 'oct': 10, 'october': 10,
    'nov': 11, 'november': 11, 'dec': 12, 'december': 12,
}
_TZ_SUFFIX_SRC = r'(?:GMT|UTC|UT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|[+-](?:[01]\d|2[0-3]):?[0-5]\d)'
_MONTH_SHORT_SRC = r'(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
_MONTH_FULL_OR_SHORT_SRC = (
    r'(?:January|February|March|April|May|June|July|August|September|October|November|December'
    r'|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
)
_ISO_DATE_RE = re.compile(
    r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-](?:[01]\d|2[0-3]):?[0-5]\d))?$',
    re.IGNORECASE,
)
_IMF_DATE_RE = re.compile(
    rf'^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+)?(\d{{1,2}})\s+({_MONTH_FULL_OR_SHORT_SRC})\s+(\d{{4}})\s+(\d{{2}}):(\d{{2}})(?::(\d{{2}}))?(?:\s+({_TZ_SUFFIX_SRC}))?$',
    re.IGNORECASE,
)
_RFC850_DATE_RE = re.compile(
    rf'^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(\d{{1,2}})-({_MONTH_SHORT_SRC})-(\d{{2}}|\d{{4}})\s+(\d{{2}}):(\d{{2}}):(\d{{2}})(?:\s+({_TZ_SUFFIX_SRC}))?$',
    re.IGNORECASE,
)
_ASCTIME_DATE_RE = re.compile(
    rf'^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+({_MONTH_SHORT_SRC})\s+(\d{{1,2}})\s+(\d{{2}}):(\d{{2}}):(\d{{2}})\s+(\d{{4}})(?:\s+({_TZ_SUFFIX_SRC}))?$',
    re.IGNORECASE,
)
_US_12H_DATE_RE = re.compile(
    rf'^({_MONTH_FULL_OR_SHORT_SRC})\s+(\d{{1,2}}),\s+(\d{{4}})\s+(\d{{1,2}}):(\d{{2}})(?::(\d{{2}}))?\s+(AM|PM)(?:\s+({_TZ_SUFFIX_SRC}))?$',
    re.IGNORECASE,
)


def _parse_http_tz_offset_minutes(token):
    if not token:
        return 0
    upper = str(token).strip().upper()
    if upper in _HTTP_TZ_OFFSETS_MIN:
        return _HTTP_TZ_OFFSETS_MIN[upper]
    match = re.fullmatch(r'([+-])([01]\d|2[0-3]):?([0-5]\d)', upper)
    if not match:
        return None
    sign = 1 if match.group(1) == '+' else -1
    return sign * (int(match.group(2)) * 60 + int(match.group(3)))


def _build_strict_utc_ms(year, month, day, hour, minute, second, millisecond, tz_offset_min):
    if tz_offset_min is None:
        return None
    try:
        tz = timezone(timedelta(minutes=tz_offset_min))
        dt = datetime(year, month, day, hour, minute, second, millisecond * 1000, tzinfo=tz)
        return dt.timestamp() * 1000
    except (ValueError, OverflowError):
        return None


def _parse_http_date_ms(raw):
    trimmed = str(raw or '').strip()
    if not trimmed:
        return None
    m = _ISO_DATE_RE.match(trimmed)
    if m:
        ms = int(m.group(7).ljust(3, '0')[:3]) if m.group(7) else 0
        tz_offset = _parse_http_tz_offset_minutes(m.group(9)) if m.group(9) else 0
        return _build_strict_utc_ms(
            int(m.group(1)), int(m.group(2)), int(m.group(3)),
            int(m.group(4)), int(m.group(5)), int(m.group(6)) if m.group(6) is not None else 0,
            ms, tz_offset,
        )
    m = _IMF_DATE_RE.match(trimmed)
    if m:
        return _build_strict_utc_ms(
            int(m.group(3)), _HTTP_MONTH_MAP[m.group(2).lower()], int(m.group(1)),
            int(m.group(4)), int(m.group(5)), int(m.group(6)) if m.group(6) is not None else 0,
            0, _parse_http_tz_offset_minutes(m.group(7)),
        )
    m = _RFC850_DATE_RE.match(trimmed)
    if m:
        year = int(m.group(3))
        if len(m.group(3)) == 2:
            year = (2000 + year) if year < 50 else (1900 + year)
        return _build_strict_utc_ms(
            year, _HTTP_MONTH_MAP[m.group(2).lower()], int(m.group(1)),
            int(m.group(4)), int(m.group(5)), int(m.group(6)),
            0, _parse_http_tz_offset_minutes(m.group(7)),
        )
    m = _ASCTIME_DATE_RE.match(trimmed)
    if m:
        return _build_strict_utc_ms(
            int(m.group(6)), _HTTP_MONTH_MAP[m.group(1).lower()], int(m.group(2)),
            int(m.group(3)), int(m.group(4)), int(m.group(5)),
            0, _parse_http_tz_offset_minutes(m.group(7)),
        )
    m = _US_12H_DATE_RE.match(trimmed)
    if m:
        raw_hour = int(m.group(4))
        if raw_hour < 1 or raw_hour > 12:
            return None
        is_pm = m.group(7).upper() == 'PM'
        hour24 = (raw_hour % 12) + (12 if is_pm else 0)
        return _build_strict_utc_ms(
            int(m.group(3)), _HTTP_MONTH_MAP[m.group(1).lower()], int(m.group(2)),
            hour24, int(m.group(5)), int(m.group(6)) if m.group(6) is not None else 0,
            0, _parse_http_tz_offset_minutes(m.group(8)),
        )
    return None


def _parse_retry_after_ms_evidence(headers, now_ms):
    evidence = []
    for raw_value in _header_values(headers, 'retry-after-ms'):
        for part in str(raw_value).split(','):
            value = _parse_positive_finite_delay(part)
            if value is not None:
                evidence.append(min(value, MAX_BLOCK_MS))
    for raw_value in _header_values(headers, 'retry-after'):
        raw_text = str(raw_value)
        seconds = _parse_positive_finite_delay(raw_text)
        if seconds is not None:
            evidence.append(min(seconds, MAX_BLOCK_MS / 1000) * 1000)
        for part in raw_text.split(','):
            coalesced_seconds = _parse_positive_finite_delay(part)
            if coalesced_seconds is not None:
                evidence.append(min(coalesced_seconds, MAX_BLOCK_MS / 1000) * 1000)
        if re.search(r'[A-Za-z]', raw_text):
            target_ms = _parse_http_date_ms(raw_text)
            if target_ms is not None and math.isfinite(target_ms):
                delta = target_ms - now_ms
                if math.isfinite(delta) and delta > 0:
                    evidence.append(min(delta, MAX_BLOCK_MS))
    return evidence


def _parse_reset_message_ms_evidence(message):
    matches = re.finditer(
        r'resets?\s+in\s+(\d+(?:\.\d+)?)\s*'
        r'(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b',
        str(message or ''), flags=re.IGNORECASE,
    )
    evidence = []
    for match in matches:
        amount = float(match.group(1))
        if not math.isfinite(amount) or amount <= 0:
            continue
        unit = match.group(2).lower()
        multiplier = 86400000 if unit.startswith('d') else (
            3600000 if unit.startswith('h') else (60000 if unit.startswith('m') else 1000)
        )
        delay_ms = min(amount, MAX_BLOCK_MS / multiplier) * multiplier
        if math.isfinite(delay_ms) and delay_ms > 0:
            evidence.append(delay_ms)
    return evidence


def _sanitize_limit_name(limit_name):
    value = re.sub(
        r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))',
        '', str(limit_name or ''),
    )
    value = re.sub(r'[\x00-\x1f\x7f-\x9f]', ' ', value)
    return re.sub(r'\s+', ' ', value).strip()[:160]


def _normalize_limit_class(limit_name):
    value = _sanitize_limit_name(limit_name).lower()
    if 'month' in value:
        return 'monthly'
    if 'week' in value:
        return 'weekly'
    if '5 hour' in value or '5-hour' in value or 'rolling' in value:
        return 'rolling_5h'
    return 'unknown'


def _fallback_block_ms(limit_class):
    if limit_class == 'monthly':
        return 31 * 24 * 60 * 60 * 1000
    if limit_class == 'weekly':
        return 7 * 24 * 60 * 60 * 1000
    if limit_class == 'rolling_5h':
        return 5 * 60 * 60 * 1000
    return UNKNOWN_QUOTA_BLOCK_MS


def classify_opencode_go_quota_response(status, headers, body, *, raw='', now_ms=None, endpoint=None):
    if endpoint is not None and not is_opencode_go_endpoint(endpoint):
        return None
    if status == 401 and is_opencode_go_endpoint(endpoint):
        document = body if isinstance(body, dict) else {}
        error = document.get('error') if isinstance(document.get('error'), dict) else {}
        nested = error.get('error') if isinstance(error.get('error'), dict) else {}
        messages = [body, raw, document.get('message'), document.get('error'), error.get('message'), nested.get('message')]
        balance_pattern = (r'insufficient balance(?:[.!]?|\. Manage your billing here: '
                           r'https://opencode\.ai/workspace/[A-Za-z0-9_-]+/billing)')
        if any(isinstance(value, str) and re.fullmatch(balance_pattern, value.strip(), re.I)
               for value in messages):
            current = int(time.time() * 1000) if now_ms is None else int(now_ms)
            return {'type': 'InsufficientBalanceError', 'limit_name': 'balance', 'limit_class': 'balance',
                    'blocked_until_ms': current + UNKNOWN_QUOTA_BLOCK_MS}
    if status != 429:
        return None
    body = body if isinstance(body, dict) else {}
    error = body.get('error') if isinstance(body.get('error'), dict) else {}
    nested = error.get('error') if isinstance(error.get('error'), dict) else {}
    types = [body.get('type'), body.get('code'), error.get('type'), error.get('code'),
             nested.get('type'), nested.get('code')]
    if 'GoUsageLimitError' not in [str(value or '') for value in types]:
        return None
    metadata = body.get('metadata') if isinstance(body.get('metadata'), dict) else (
        error.get('metadata') if isinstance(error.get('metadata'), dict) else (
            nested.get('metadata') if isinstance(nested.get('metadata'), dict) else {}
        )
    )
    limit_name = _sanitize_limit_name(
        metadata.get('limitName') or body.get('limitName') or ''
    )
    limit_class = _normalize_limit_class(limit_name)
    message = str(body.get('message') or error.get('message') or nested.get('message') or '')
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    reset_evidence = [
        *_parse_retry_after_ms_evidence(headers, now_ms),
        *_parse_reset_message_ms_evidence(message),
    ]
    delay_ms = max(reset_evidence) if reset_evidence else _fallback_block_ms(limit_class)
    return {
        'type': 'GoUsageLimitError',
        'limit_name': limit_name,
        'limit_class': limit_class,
        'blocked_until_ms': now_ms + int(delay_ms),
    }


class _UsageNoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def http_error_302(self, req, fp, code, msg, headers):
        if fp is not None:
            try:
                fp.close()
            except Exception:
                pass
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, None)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


def _is_valid_http_connect_proxy_url(raw_url):
    if not isinstance(raw_url, str) or not raw_url or re.search(r'[\x00-\x20\x7f\\]', raw_url):
        return False
    auth_match = re.match(r'^https?://([^/?#]+)', raw_url, re.IGNORECASE)
    if not auth_match:
        return False
    authority = auth_match.group(1)
    raw_host_port = authority.rsplit('@', 1)[-1] if '@' in authority else authority
    if not raw_host_port or '%' in raw_host_port:
        return False
    try:
        parsed = urlsplit(raw_url)
        scheme = (parsed.scheme or '').lower()
        hostname = parsed.hostname or ''
        port = parsed.port
    except ValueError:
        return False
    if scheme not in ('http', 'https') or not hostname:
        return False
    if port is not None and not (1 <= port <= 65535):
        return False
    return True


def _resolve_usage_proxy_url(explicit_proxy_url=None, env=None):
    if explicit_proxy_url is not None and explicit_proxy_url != '':
        raw = str(explicit_proxy_url)
        return raw if _is_valid_http_connect_proxy_url(raw) else None
    source = os.environ if env is None else env
    for key in _HTTP_CONNECT_PROXY_ENV_VARS:
        val = source.get(key)
        if val:
            raw = str(val)
            return raw if _is_valid_http_connect_proxy_url(raw) else None
    return None


def redact_usage_sync_error(err, api_key=None, fallback='usage 查询失败'):
    raw = str(err) if err is not None else ''
    if not raw.strip():
        raw = fallback
    keys = []
    if isinstance(api_key, str):
        keys = [api_key]
    elif isinstance(api_key, (list, tuple, set)):
        keys = [k for k in api_key if isinstance(k, str)]
    for key in keys:
        trimmed = key.strip()
        if len(trimmed) >= 4:
            raw = raw.replace(trimmed, '[REDACTED]')
    raw = re.sub(r'([A-Za-z][A-Za-z0-9+.-]*://)[^/\s@]+@', r'\1[REDACTED]@', raw)
    raw = re.sub(r'\b(Bearer|Basic)\s+[^\s,\'";)}\]]+', r'\1 [REDACTED]', raw, flags=re.IGNORECASE)
    raw = re.sub(r'\bsk-[A-Za-z0-9._-]{4,}', '[REDACTED]', raw, flags=re.IGNORECASE)
    raw = re.sub(r'\b[a-f0-9]{64}\b', '[REDACTED]', raw, flags=re.IGNORECASE)
    cleaned = _sanitize_limit_name(raw)
    return cleaned or fallback


def get_opencode_go_usage_url(endpoint):
    service = normalize_opencode_go_service(endpoint)
    return f'{service}/v1/usage' if service else None


def _is_live_sync_enabled(force=False, live_sync=None):
    if force:
        return True
    if live_sync is not None:
        return bool(live_sync)
    raw = str(os.environ.get('PD_LLM_ACCOUNT_POOL_LIVE_SYNC', '1')).strip().lower()
    return raw not in ('0', 'false', 'no', 'off')


def _resolve_live_sync_ttl_ms(ttl_ms=None):
    raw = ttl_ms if ttl_ms is not None else os.environ.get('PD_LLM_ACCOUNT_POOL_SYNC_TTL_MS')
    try:
        val = int(float(raw))
        if 15000 <= val <= 86400000:
            return val
    except (TypeError, ValueError):
        pass
    return DEFAULT_LIVE_SYNC_TTL_MS


def resolve_live_sync_timeout_ms(timeout_ms=None):
    raw = timeout_ms if timeout_ms is not None else os.environ.get('PD_LLM_ACCOUNT_POOL_SYNC_TIMEOUT_MS')
    try:
        val = int(float(raw))
        if 1000 <= val <= 60000:
            return val
    except (TypeError, ValueError):
        pass
    return DEFAULT_LIVE_SYNC_TIMEOUT_MS


_resolve_live_sync_timeout_ms = resolve_live_sync_timeout_ms


def _parse_usage_window(raw_window, name):
    if not isinstance(raw_window, dict):
        raise ValueError(f'usage.{name} 缺失或不是对象')
    pct_raw = raw_window.get('percent')
    if isinstance(pct_raw, bool) or not isinstance(pct_raw, (int, float)) or not math.isfinite(pct_raw) or not (0 <= pct_raw <= 100):
        raise ValueError(f'usage.{name}.percent 非法')
    used_pct = float(pct_raw)
    status_raw = raw_window.get('status')
    status = status_raw.strip().lower() if isinstance(status_raw, str) and status_raw.strip() else 'ok'
    limited = used_pct >= 100.0 or bool(re.fullmatch(r'rate_limited|limited|exceeded|exhausted|blocked', status))
    remaining_pct = 0.0 if limited else _round_pct4(max(0.0, min(100.0, 100.0 - used_pct)))
    resets_at = raw_window.get('resetsAt')
    resets_at_ms = _parse_http_date_ms(resets_at) if isinstance(resets_at, str) else None
    if resets_at_ms is None or not math.isfinite(resets_at_ms) or resets_at_ms <= 0:
        raise ValueError(f'usage.{name}.resetsAt 时间戳非法')
    return {
        'status': status,
        'used_percent': _round_pct4(used_pct),
        'remaining_pct': remaining_pct,
        'limited': limited,
        'resets_at_ms': int(round(resets_at_ms)),
    }


def parse_opencode_go_usage_payload(payload):
    usage = payload.get('usage') if isinstance(payload, dict) and isinstance(payload.get('usage'), dict) else None
    if usage is None:
        raise ValueError('响应缺少 usage 对象')
    return {
        'rolling': _parse_usage_window(usage.get('rolling'), 'rolling'),
        'weekly': _parse_usage_window(usage.get('weekly'), 'weekly'),
        'monthly': _parse_usage_window(usage.get('monthly'), 'monthly'),
    }


def _parse_iso_ms(value):
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith(('Z', 'z')):
        text = text[:-1] + '+00:00'
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    ms = dt.timestamp() * 1000.0
    return int(round(ms)) if math.isfinite(ms) else None


def apply_live_usage_snapshots(api_keys, endpoint, snapshots_by_account_id, state_file=LLM_ACCOUNT_POOL_STATE_FILE, *, now_ms=None):
    keys = normalize_api_keys(api_keys)
    identity = get_pool_identity(keys, endpoint)
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    items = list((snapshots_by_account_id or {}).items())
    if not items:
        return 0
    applied_box = [0]

    def updater(state):
        service = _ensure_service(state, identity)
        now_iso = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).isoformat()
        current_bucket_ms = (now_ms // ROLLING_5H_BUCKET_MS) * ROLLING_5H_BUCKET_MS
        for account_id, snap in items:
            if not isinstance(snap, dict) or not snap.get('monthly') or not snap.get('weekly') or not snap.get('rolling'):
                continue
            previous = service['accounts'].get(account_id)
            previous = dict(previous) if isinstance(previous, dict) else {}
            next_quota = dict(previous['quota']) if isinstance(previous.get('quota'), dict) else {}
            next_windows = dict(previous['windows']) if isinstance(previous.get('windows'), dict) else {}

            m_reset_ms = snap['monthly']['resets_at_ms']
            next_quota['monthlyResetAtMs'] = m_reset_ms
            next_quota['monthlyResetDay'] = datetime.fromtimestamp(m_reset_ms / 1000, tz=timezone.utc).day
            next_quota['monthlyResetTzOffsetMin'] = 0
            next_quota['monthlyResetSource'] = 'live_api'
            next_quota['autoMonthlyAnchorMs'] = m_reset_ms
            next_quota['weeklyResetAtMs'] = snap['weekly']['resets_at_ms']
            next_quota['rolling5hResetAtMs'] = snap['rolling']['resets_at_ms']

            pre_eval = evaluate_account_quota({**previous, 'quota': next_quota, 'windows': next_windows}, now_ms)

            next_quota['monthlyRemainingPct'] = snap['monthly']['remaining_pct']
            next_quota['monthlySpentAtSnapshotUsd'] = pre_eval['current_monthly_spent_usd']
            next_quota['monthlySnapshotAtMs'] = now_ms

            next_quota['weeklyRemainingPct'] = snap['weekly']['remaining_pct']
            next_quota['weeklySpentAtSnapshotUsd'] = pre_eval['current_weekly_spent_usd']
            next_quota['weeklySnapshotAtMs'] = now_ms

            next_quota['rolling5hRemainingPct'] = snap['rolling']['remaining_pct']
            next_quota['rolling5hSpentAtSnapshotUsd'] = _get_rolling_5h_bucket_spend_usd(
                previous.get('usage'), current_bucket_ms,
            )
            next_quota['rolling5hSnapshotAtMs'] = now_ms

            next_quota['snapshotAtMs'] = now_ms
            next_quota['lastLiveSyncAtMs'] = now_ms

            raw_fetched_at = snap.get('fetchedAtMs') if 'fetchedAtMs' in snap else snap.get('fetched_at_ms')
            snap_fetched_at_ms = int(raw_fetched_at) if _is_non_negative_finite(raw_fetched_at) else now_ms
            pre_sync_windows = snap.get('_pre_sync_windows') if isinstance(snap.get('_pre_sync_windows'), dict) else None
            for win_key, win_snap, pct_field, reset_field in (
                ('monthly', snap['monthly'], 'monthlyRemainingPct', None),
                ('weekly', snap['weekly'], 'weeklyRemainingPct', 'weeklyResetAtMs'),
                ('rolling_5h', snap['rolling'], 'rolling5hRemainingPct', 'rolling5hResetAtMs'),
            ):
                if win_snap['limited'] and win_snap['resets_at_ms'] > now_ms:
                    next_windows[win_key] = {
                        'status': 'quota_blocked',
                        'limitName': win_key,
                        'blockedUntilMs': win_snap['resets_at_ms'],
                        'blockedUntil': datetime.fromtimestamp(win_snap['resets_at_ms'] / 1000, tz=timezone.utc).isoformat(),
                        'updatedAt': now_iso,
                    }
                elif win_key in next_windows:
                    existing_win = next_windows[win_key]
                    existing_until = (
                        int(existing_win['blockedUntilMs'])
                        if isinstance(existing_win, dict) and _is_non_negative_finite(existing_win.get('blockedUntilMs'))
                        else 0
                    )
                    last_exhausted_ms = (
                        _parse_iso_ms(existing_win.get('lastExhaustedAt'))
                        if isinstance(existing_win, dict) else None
                    )
                    pre_win = pre_sync_windows.get(win_key) if pre_sync_windows is not None else None
                    existed_unchanged_before_sync = (
                        isinstance(pre_win, dict)
                        and isinstance(existing_win, dict)
                        and pre_win.get('lastExhaustedAt') == existing_win.get('lastExhaustedAt')
                        and pre_win.get('blockedUntilMs') == existing_win.get('blockedUntilMs')
                    )
                    preserve_newer_cooldown = (
                        existing_until > now_ms
                        and last_exhausted_ms is not None
                        and (
                            last_exhausted_ms > snap_fetched_at_ms
                            or (last_exhausted_ms == snap_fetched_at_ms and not existed_unchanged_before_sync)
                        )
                    )
                    if preserve_newer_cooldown:
                        next_quota[pct_field] = 0
                        if reset_field is not None:
                            next_quota[reset_field] = existing_until
                    else:
                        del next_windows[win_key]

            active_max = 0
            active_limit_name = None
            for win_key, entry in next_windows.items():
                until = entry.get('blockedUntilMs') if isinstance(entry, dict) else None
                if _is_non_negative_finite(until) and until > now_ms and until > active_max:
                    active_max = int(until)
                    active_limit_name = win_key

            next_record = {**previous, 'quota': next_quota, 'updatedAt': now_iso}
            if next_windows:
                next_record['windows'] = next_windows
            else:
                next_record.pop('windows', None)
            if active_max > 0:
                next_record['status'] = 'quota_blocked'
                next_record['limitName'] = active_limit_name
                next_record['blockedUntilMs'] = active_max
                next_record['blockedUntil'] = datetime.fromtimestamp(active_max / 1000, tz=timezone.utc).isoformat()
            else:
                next_record['blockedUntilMs'] = 0
                next_record.pop('blockedUntil', None)
                if next_record.get('status') in (None, 'quota_blocked'):
                    next_record['status'] = 'eligible'
            _validate_account_subrecords(next_record, state_file)
            service['accounts'][account_id] = next_record
            applied_box[0] += 1
        return state if applied_box[0] > 0 else None

    _update_state(state_file, updater)
    return applied_box[0]


def fetch_opencode_go_account_usage(api_key, endpoint, *, proxy_url=None, timeout_ms=None, fetcher=None, now_ms=None):
    url = get_opencode_go_usage_url(endpoint)
    if not url:
        return {'ok': False, 'status_code': None, 'error': '非 OpenCode Go 官方端点'}
    resolved_timeout_ms = _resolve_live_sync_timeout_ms(timeout_ms)
    if callable(fetcher):
        try:
            res = fetcher(url=url, api_key=api_key, timeout_ms=resolved_timeout_ms, proxy_url=proxy_url)
            status_code = int(res.get('status_code') or res.get('statusCode') or res.get('status') or 0)
            body = res.get('body')
            if body is None and isinstance(res.get('text'), str) and res['text']:
                body = json.loads(res['text'])
            if status_code == 200:
                return {'ok': True, 'status_code': 200, 'parsed': parse_opencode_go_usage_payload(body)}
            quota = classify_opencode_go_quota_response(
                status_code, res.get('headers') or {}, body, endpoint=endpoint, now_ms=now_ms,
            )
            if quota and quota.get('limit_class') == 'balance':
                return {'ok': False, 'status_code': status_code, 'insufficient_balance': True, 'quota': quota, 'error': 'HTTP 401 Insufficient balance'}
            if status_code == 401:
                return {'ok': False, 'status_code': 401, 'auth_error': True, 'error': 'HTTP 401 认证失败'}
            return {'ok': False, 'status_code': status_code or None, 'error': f'HTTP {status_code or "unknown"}'}
        except Exception as exc:
            return {'ok': False, 'status_code': None, 'error': redact_usage_sync_error(exc, api_key, 'usage 查询失败')}

    resolved_proxy = _resolve_usage_proxy_url(proxy_url)
    if not resolved_proxy:
        return {'ok': False, 'status_code': None, 'error': '缺少或非法的项目 HTTP CONNECT 代理配置'}

    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({'http': resolved_proxy, 'https': resolved_proxy}),
        _UsageNoRedirectHandler(),
    )
    req = urllib.request.Request(
        url,
        headers={
            'Authorization': f'Bearer {api_key}',
            'Accept': 'application/json',
            'User-Agent': 'audio-research-workbench/1.0',
        },
        method='GET',
    )
    deadline = time.monotonic() + (resolved_timeout_ms / 1000.0)
    try:
        with opener.open(req, timeout=resolved_timeout_ms / 1000.0) as resp:
            status_code = getattr(resp, 'status', None)
            if status_code is None and hasattr(resp, 'getcode'):
                status_code = resp.getcode()
            if status_code != 200:
                return {'ok': False, 'status_code': status_code, 'error': f'HTTP {status_code or "unknown"}'}
            chunks = []
            total = 0
            raw_io = getattr(getattr(resp, 'fp', None), 'raw', None)
            sock = getattr(raw_io, '_sock', None)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('usage 响应读取超过总超时时间')
                if sock is not None and hasattr(sock, 'settimeout'):
                    try:
                        sock.settimeout(remaining)
                    except OSError:
                        pass
                chunk = resp.read(8192)
                if not chunk:
                    break
                total += len(chunk)
                if total > LIVE_SYNC_MAX_RESPONSE_BYTES:
                    return {'ok': False, 'status_code': status_code, 'error': 'usage 响应超过 64 KiB 安全上限'}
                chunks.append(chunk)
            if time.monotonic() > deadline:
                raise TimeoutError('usage 响应读取超过总超时时间')
            raw = b''.join(chunks)
            body = json.loads(raw.decode('utf-8'))
            return {'ok': True, 'status_code': 200, 'parsed': parse_opencode_go_usage_payload(body)}
    except urllib.error.HTTPError as exc:
        status_code = exc.code
        raw_text = ''
        body = None
        try:
            if exc.fp is not None and (deadline - time.monotonic()) > 0:
                raw_io = getattr(getattr(exc, 'fp', None), 'raw', None)
                err_sock = getattr(raw_io, '_sock', None)
                if err_sock is not None and hasattr(err_sock, 'settimeout'):
                    try:
                        err_sock.settimeout(max(0.05, deadline - time.monotonic()))
                    except OSError:
                        pass
                raw_bytes = exc.read(LIVE_SYNC_MAX_RESPONSE_BYTES)
                raw_text = raw_bytes.decode('utf-8', errors='replace')
                body = json.loads(raw_text) if raw_text else None
        except Exception:
            body = None
        finally:
            try:
                exc.close()
            except Exception:
                pass
        quota = classify_opencode_go_quota_response(
            status_code, dict(exc.headers or {}), body, raw=raw_text, endpoint=endpoint, now_ms=now_ms,
        )
        if quota and quota.get('limit_class') == 'balance':
            return {'ok': False, 'status_code': status_code, 'insufficient_balance': True, 'quota': quota, 'error': 'HTTP 401 Insufficient balance'}
        if status_code == 401:
            return {'ok': False, 'status_code': 401, 'auth_error': True, 'error': 'HTTP 401 认证失败'}
        return {'ok': False, 'status_code': status_code, 'error': f'HTTP {status_code}'}
    except Exception as exc:
        return {'ok': False, 'status_code': None, 'error': redact_usage_sync_error(exc, api_key, 'usage 网络请求失败')}


def sync_opencode_go_pool_usage(api_keys, endpoint, state_file=LLM_ACCOUNT_POOL_STATE_FILE, *,
                                force=False, ttl_ms=None, timeout_ms=None, proxy_url=None,
                                now_ms=None, fetcher=None, strategy=None, live_sync=None):
    keys = normalize_api_keys(api_keys)
    if not keys or not is_opencode_go_endpoint(endpoint):
        return {'synced': 0, 'failed': 0, 'skipped': len(keys), 'auth_errors': [], 'from_cache': True, 'results': []}
    if not force and (not _is_live_sync_enabled(force=False, live_sync=live_sync) or _resolve_pool_strategy(strategy) != 'expiry_priority'):
        return {'synced': 0, 'failed': 0, 'skipped': len(keys), 'auth_errors': [], 'from_cache': True, 'results': []}
    has_explicit_now = now_ms is not None
    check_now_ms = int(now_ms) if has_explicit_now else int(time.time() * 1000)
    resolved_ttl = _resolve_live_sync_ttl_ms(ttl_ms)
    identity = get_pool_identity(keys, endpoint)
    sync_key = f'{Path(state_file).resolve()}|{identity["service_id"]}|{identity["group_id"]}'

    inflight = None
    if not force:
        existing = None
        with _LIVE_SYNC_LOCK:
            existing = _IN_FLIGHT_LIVE_SYNCS.get(sync_key)
            if existing is None:
                inflight = {'event': threading.Event(), 'result': None, 'error': None}
                _IN_FLIGHT_LIVE_SYNCS[sync_key] = inflight
        if existing is not None:
            existing['event'].wait()
            if existing['error'] is not None:
                raise existing['error']
            return existing['result']

    try:
        try:
            current_state = read_state_strict(state_file) if Path(state_file).exists() else None
        except Exception:
            current_state = None
        accounts = ((current_state or {}).get('services') or {}).get(identity['service_id'], {}).get('accounts') or {}

        account_fail_times = {}
        if not force:
            with _LIVE_SYNC_LOCK:
                for key in keys:
                    aid = get_account_id(key)
                    ts = _LIVE_SYNC_LAST_FAIL_MS.get((sync_key, aid))
                    if ts is not None:
                        account_fail_times[aid] = ts

        targets = []
        skipped = 0
        backoff_skipped = 0
        for idx, key in enumerate(keys):
            account_id = get_account_id(key)
            rec = accounts.get(account_id) if isinstance(accounts, dict) else None
            q = rec.get('quota') if isinstance(rec, dict) and isinstance(rec.get('quota'), dict) else {}
            last_sync = q.get('lastLiveSyncAtMs')
            window_expired = _is_non_negative_finite(last_sync) and any(
                _is_non_negative_finite(q.get(f))
                and float(q.get(f)) > float(last_sync)
                and float(q.get(f)) <= check_now_ms
                for f in ('rolling5hResetAtMs', 'weeklyResetAtMs', 'monthlyResetAtMs')
            )
            is_fresh = (
                not force
                and _is_non_negative_finite(last_sync)
                and check_now_ms >= float(last_sync)
                and (check_now_ms - float(last_sync)) < resolved_ttl
                and not window_expired
            )
            if is_fresh:
                skipped += 1
                continue
            if not force:
                last_fail = account_fail_times.get(account_id)
                if _is_non_negative_finite(last_fail) and check_now_ms >= float(last_fail) \
                        and (check_now_ms - float(last_fail)) < LIVE_SYNC_FAILURE_BACKOFF_MS:
                    skipped += 1
                    backoff_skipped += 1
                    continue
            targets.append((idx + 1, key, account_id))

        if not targets:
            res = {'synced': 0, 'failed': 0, 'skipped': skipped, 'auth_errors': [], 'from_cache': True, 'results': []}
            if backoff_skipped > 0:
                res['backoff'] = True
            if inflight is not None:
                inflight['result'] = res
            return res

        def _worker(item):
            slot, key, account_id = item
            fetched_at_ms = check_now_ms if has_explicit_now else int(time.time() * 1000)
            outcome = fetch_opencode_go_account_usage(
                key, endpoint, proxy_url=proxy_url, timeout_ms=timeout_ms,
                fetcher=fetcher, now_ms=(check_now_ms if has_explicit_now else None),
            )
            return slot, account_id, fetched_at_ms, outcome

        max_workers = min(8, len(targets))
        with ThreadPoolExecutor(max_workers=max_workers) as pool_exec:
            fetched = list(pool_exec.map(_worker, targets))

        finish_now_ms = check_now_ms if has_explicit_now else int(time.time() * 1000)
        snapshots = {}
        auth_errors = []
        results = []
        failed = 0
        succeeded_ids = []
        failed_ids = []
        for slot, account_id, fetched_at_ms, outcome in fetched:
            if outcome.get('ok'):
                p = outcome['parsed']
                prev_rec = accounts.get(account_id) if isinstance(accounts, dict) else None
                prev_windows = (
                    prev_rec.get('windows')
                    if isinstance(prev_rec, dict) and isinstance(prev_rec.get('windows'), dict)
                    else None
                )
                snap_entry = {**p, 'fetchedAtMs': fetched_at_ms}
                if prev_windows is not None:
                    snap_entry['_pre_sync_windows'] = prev_windows
                snapshots[account_id] = snap_entry
                succeeded_ids.append(account_id)
                results.append({
                    'slot': slot, 'ok': True, 'status_code': 200,
                    'monthly_expiry_beijing': beijing_date_from_ms(p['monthly']['resets_at_ms']),
                    'monthly_remaining_pct': p['monthly']['remaining_pct'],
                    'weekly_remaining_pct': p['weekly']['remaining_pct'],
                    'rolling5h_remaining_pct': p['rolling']['remaining_pct'],
                })
            else:
                failed += 1
                failed_ids.append(account_id)
                if outcome.get('auth_error'):
                    auth_errors.append(slot)
                if outcome.get('insufficient_balance') and outcome.get('quota'):
                    try:
                        mark_quota_exhausted(
                            {'service_id': identity['service_id'], 'service': identity['service'], 'account_id': account_id},
                            outcome['quota'], state_file, now_ms=finish_now_ms,
                        )
                    except Exception:
                        pass
                results.append({'slot': slot, 'ok': False, 'status_code': outcome.get('status_code'), 'error': outcome.get('error')})

        synced = apply_live_usage_snapshots(keys, endpoint, snapshots, state_file, now_ms=finish_now_ms)
        with _LIVE_SYNC_LOCK:
            for aid in succeeded_ids:
                _LIVE_SYNC_LAST_FAIL_MS.pop((sync_key, aid), None)
            if not force:
                for aid in failed_ids:
                    _LIVE_SYNC_LAST_FAIL_MS[(sync_key, aid)] = finish_now_ms
        res = {'synced': synced, 'failed': failed, 'skipped': skipped, 'auth_errors': auth_errors, 'from_cache': False, 'results': results}
        if inflight is not None:
            inflight['result'] = res
        return res
    except BaseException as exc:
        if inflight is not None:
            inflight['error'] = exc
        raise
    finally:
        if inflight is not None:
            with _LIVE_SYNC_LOCK:
                if _IN_FLIGHT_LIVE_SYNCS.get(sync_key) is inflight:
                    _IN_FLIGHT_LIVE_SYNCS.pop(sync_key, None)
            inflight['event'].set()


__all__ = [
    'ACCOUNT_POOL_CONTRACT', 'MAX_SAFE_INTEGER',
    'LlmAccountPoolExhaustedError',
    'LlmAccountAuthError',
    'LlmAccountPoolStateError', 'LlmAccountPoolConfigError',
    'LlmAccountPoolLockTimeoutError',
    'normalize_api_keys', 'parse_fallback_api_keys', 'resolve_api_key_pool', 'resolve_primary_api_key_pool',
    'normalize_opencode_go_service', 'is_opencode_go_endpoint', 'get_opencode_go_usage_url', 'get_account_id',
    'get_pool_identity', 'select_api_key', 'mark_quota_exhausted', 'record_account_usage',
    'parse_opencode_go_usage_payload', 'apply_live_usage_snapshots',
    'fetch_opencode_go_account_usage', 'sync_opencode_go_pool_usage',
    'resolve_live_sync_timeout_ms',
    'redact_usage_sync_error',
    'evaluate_account_quota', 'resolve_monthly_cycle', 'beijing_date_from_ms',
    'classify_opencode_go_quota_response', 'read_state_strict',
]


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('llm_account_pool.py')
    raise SystemExit('llm_account_pool.py 是共享模块，请通过项目 LLM 入口使用')
