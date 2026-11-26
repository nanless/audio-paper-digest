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
import time
import uuid
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


def _minimal_system_probe_env():
    return {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin:/usr/sbin:/sbin'),
        'LC_ALL': 'C',
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
        if process_boot is not None and recorded_boot != process_boot:
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


def _account_is_blocked(record, now_ms):
    value = record.get('blockedUntilMs') if isinstance(record, dict) else None
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > now_ms


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
    blocked = [service['accounts'].get(account_id, {}) for account_id in account_ids]
    blocked = [record for record in blocked if _account_is_blocked(record, now_ms)]
    earliest = min((record['blockedUntilMs'] for record in blocked), default=None)
    suffix = '' if earliest is None else (
        '，最早恢复时间 '
        + datetime.fromtimestamp(earliest / 1000, tz=timezone.utc).isoformat()
    )
    return LlmAccountPoolExhaustedError(
        f'OpenCode Go 账号池没有可用账号（全部冷却中或已被本次逻辑请求排除）；下一逻辑请求会从轮转游标继续{suffix}',
        earliest_retry_at_ms=earliest,
        blocked_account_count=len(blocked),
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
                   now_ms=None, exclude_account_ids=(), affinity_key=None):
    keys = normalize_api_keys(api_keys)
    identity = get_pool_identity(keys, endpoint)
    ordered_account_ids = _ordered_account_ids(identity)
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    excluded = set(exclude_account_ids or ())
    normalized_affinity = affinity_key.strip() if isinstance(affinity_key, str) else ''
    if normalized_affinity:
        normalized_affinity = re.sub(r'^arxiv:', '', normalized_affinity, flags=re.IGNORECASE)
        normalized_affinity = re.sub(r'^(\d{4}\.\d{4,5})v\d+$', r'\1', normalized_affinity, flags=re.IGNORECASE)
    keys_by_id = dict(zip(identity['account_ids'], keys))

    # 5 条件只读亲和快路径：与 JS 实现保持一致，减少高并发亲和命中时的同步 fsync。
    if normalized_affinity:
        try:
            state = read_state_strict(state_file)
            service = (state.get('services') or {}).get(identity['service_id'])
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
                start_index = int(_sha256(normalized_affinity)[:8], 16) % len(ordered_account_ids)
                selected_index = None
                accounts = service.get('accounts') or {}
                for step in range(len(ordered_account_ids)):
                    index = (start_index + step) % len(ordered_account_ids)
                    account_id = ordered_account_ids[index]
                    if account_id in excluded:
                        continue
                    if _account_is_blocked(accounts.get(account_id, {}), now_ms):
                        continue
                    selected_index = index
                    break
                if selected_index is not None:
                    next_id = ordered_account_ids[selected_index]
                    acct_status = (accounts.get(next_id) or {}).get('status')
                    last_selected = int(group.get('lastSelectedAtMs') or 0)
                    if acct_status != 'quota_blocked' and last_selected > 0 \
                            and now_ms >= last_selected and (now_ms - last_selected) < 60_000:
                        return {
                            'api_key': keys_by_id[next_id],
                            'account_id': next_id,
                            **identity,
                        }
        except Exception:
            pass

    selection = {}

    def updater(state):
        service = _ensure_service(state, identity)
        # 成员集合变化会产生新的 group_id（新组 cursor=0）；顺手清理同一
        # service 下已经不再使用的旧分组，当前分组始终保留。
        _prune_stale_groups(service, identity['group_id'], now_ms)
        group = service['groups'].get(identity['group_id'])
        if group is None:
            group = {
                'activeAccountId': None,
                'switchedAt': None,
            }
        service['groups'][identity['group_id']] = group
        if normalized_affinity:
            start_index = int(_sha256(normalized_affinity)[:8], 16) % len(ordered_account_ids)
        else:
            start_index = _resolve_rotation_cursor(group, ordered_account_ids)
        # 从起点扫描一圈：跳过本次逻辑请求已试过的账号（excluded）和
        # 仍在冷却中的账号（blockedUntilMs 未到）；冷却到期的账号自然重新
        # 加入轮转。整圈都不可用时按最早恢复时间报错。
        selected_index = None
        for step in range(len(ordered_account_ids)):
            index = (start_index + step) % len(ordered_account_ids)
            account_id = ordered_account_ids[index]
            if account_id in excluded:
                continue
            if _account_is_blocked(service['accounts'].get(account_id, {}), now_ms):
                continue
            selected_index = index
            break
        if selected_index is None:
            raise _build_exhausted_error(service, ordered_account_ids, now_ms)
        next_id = ordered_account_ids[selected_index]
        if normalized_affinity:
            # 新建分组首次以 affinity_key 选槽时，显式锚定 rotationCursor，
            # 避免后续非亲和轮转回退到 activeAccountId 所在槽位而漂移。
            stored_cursor = group.get('rotationCursor')
            if not (type(stored_cursor) is int and 0 <= stored_cursor <= MAX_SAFE_INTEGER):
                group['rotationCursor'] = _resolve_rotation_cursor(group, ordered_account_ids)
        else:
            group['rotationCursor'] = (selected_index + 1) % len(ordered_account_ids)
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
            **identity,
        })
        # 写放大说明：等权轮转下每次选择都会推进游标，跨进程/跨请求的公平
        # 依赖持久化的 rotationCursor，所以这里必须每次写状态（一次原子写
        # 加已有的文件锁），不能按“选择结果是否变化”跳过写入。
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
    effective_until_box = [blocked_until_ms]

    def updater(state):
        service = _ensure_service(state, selection)
        previous = service['accounts'].get(selection['account_id']) or {}
        effective_until = max(int(previous.get('blockedUntilMs') or 0), blocked_until_ms)
        effective_until_box[0] = effective_until
        service['accounts'][selection['account_id']] = {
            **previous,
            'status': 'quota_blocked',
            'reason': (quota or {}).get('type') or 'GoUsageLimitError',
            'limitName': str((quota or {}).get('limit_class') or 'unknown'),
            'blockedUntilMs': effective_until,
            'blockedUntil': datetime.fromtimestamp(
                effective_until / 1000, tz=timezone.utc
            ).isoformat(),
            'lastFailureAt': datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).isoformat(),
            'lastFailureStatus': 401 if (quota or {}).get('type') == 'InsufficientBalanceError' else 429,
        }
        # 冷却只影响账号可用性，不移动轮转游标：该账号在 select_api_key 里已被
        # 明确排除，下一次选择会从游标继续，冷却到期后自动重新加入轮转。
        return state

    _update_state(state_file, updater)
    return effective_until_box[0]


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


__all__ = [
    'ACCOUNT_POOL_CONTRACT', 'MAX_SAFE_INTEGER',
    'LlmAccountPoolExhaustedError',
    'LlmAccountAuthError',
    'LlmAccountPoolStateError', 'LlmAccountPoolConfigError',
    'LlmAccountPoolLockTimeoutError',
    'normalize_api_keys', 'parse_fallback_api_keys', 'resolve_api_key_pool', 'resolve_primary_api_key_pool',
    'normalize_opencode_go_service', 'is_opencode_go_endpoint', 'get_account_id',
    'get_pool_identity', 'select_api_key', 'mark_quota_exhausted',
    'classify_opencode_go_quota_response', 'read_state_strict',
]


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('llm_account_pool.py')
    raise SystemExit('llm_account_pool.py 是共享模块，请通过项目 LLM 入口使用')
