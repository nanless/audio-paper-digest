#!/usr/bin/env python3
"""Cross-process OpenCode Go sticky account pool for Python callers."""

import hashlib
import json
import math
import os
import re
import shutil
import socket
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

from path_config import PROJECT_ROOT, LLM_ACCOUNT_POOL_STATE_FILE, atomic_write_json

STATE_SCHEMA_VERSION = 1
POLICY_VERSION = 'opencode-go-sticky-quota-failover-v1'
LOCK_TIMEOUT_SECONDS = 3
LOCK_STALE_SECONDS = 120
MAX_BLOCK_MS = 370 * 24 * 60 * 60 * 1000
UNKNOWN_QUOTA_BLOCK_MS = 30 * 60 * 1000
MAX_SAFE_INTEGER = (1 << 53) - 1


class LlmAccountPoolExhaustedError(RuntimeError):
    """All configured OpenCode Go accounts have a confirmed active quota block."""

    code = 'LLM_ACCOUNT_POOL_EXHAUSTED'
    retryable = False
    category = 'quota_exhausted'

    def __init__(self, message, *, earliest_retry_at_ms=None, blocked_account_count=0):
        super().__init__(message)
        self.earliest_retry_at_ms = earliest_retry_at_ms
        self.blocked_account_count = blocked_account_count


class LlmAccountPoolStateError(RuntimeError):
    """Persistent pool state or its lock cannot be trusted."""

    code = 'LLM_ACCOUNT_POOL_STATE_ERROR'
    retryable = False
    category = 'state'


class LlmAccountPoolConfigError(ValueError):
    """Account-pool configuration is ambiguous or unsafe."""

    code = 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
    retryable = False
    category = 'config'


class LlmAccountPoolLockTimeoutError(TimeoutError):
    """A short account-state critical section remained busy unexpectedly."""

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
            'OpenCode Go 主账号与备用账号 API key 不能相同或重复'
        )
    return keys


def resolve_primary_api_key_pool(primary_key, fallback_value, tertiary_fallback_value=''):
    """Append an explicitly configured third account after normal fallbacks."""
    return resolve_api_key_pool(
        primary_key,
        [*parse_fallback_api_keys(fallback_value), *parse_fallback_api_keys(tertiary_fallback_value)],
    )


def normalize_opencode_go_service(endpoint):
    try:
        parsed = urlsplit(str(endpoint or ''))
        hostname = (parsed.hostname or '').lower()
        port = parsed.port
    except (TypeError, ValueError):
        return None
    raw_path = parsed.path
    # Python's urlsplit preserves dot segments while WHATWG URL parsers may
    # normalize them away.  Reject both their raw and once-percent-decoded
    # forms before service identity is derived so every runtime binds the same
    # caller-supplied route, rather than trusting a server/proxy normalization.
    decoded_path = unquote(raw_path)
    if any(segment in {'.', '..'} for path_value in (raw_path, decoded_path)
           for segment in path_value.split('/')):
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


def _lock_reclaimable(lock_path, stale_seconds):
    lock_path = Path(lock_path)
    owner_path = lock_path / 'owner.json'
    if lock_path.is_symlink() or owner_path.is_symlink():
        raise LlmAccountPoolStateError(
            f'LLM 账号池锁/owner 路径禁止使用 symlink: {lock_path}'
        )
    try:
        mtimes = [lock_path.stat().st_mtime]
        if owner_path.exists():
            mtimes.append(owner_path.stat().st_mtime)
        age = time.time() - max(mtimes)
    except FileNotFoundError:
        return True
    try:
        owner = json.loads((lock_path / 'owner.json').read_text(encoding='utf-8'))
        if not isinstance(owner, dict):
            return age > stale_seconds
        owner_pid = owner.get('pid')
        valid_owner_pid = type(owner_pid) is int and owner_pid > 0
        if owner.get('hostname') == socket.gethostname() and valid_owner_pid:
            try:
                os.kill(owner_pid, 0)
            except ProcessLookupError:
                return True
            except PermissionError:
                return False
            return False
        if owner.get('hostname'):
            return age > stale_seconds
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        pass
    return age > stale_seconds


def _assert_safe_project_state_path(state_file):
    target = Path(state_file).absolute()
    project_root = Path(PROJECT_ROOT).absolute()
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
    if lock_path.is_symlink():
        raise LlmAccountPoolStateError(f'LLM 账号池锁路径禁止使用 symlink: {lock_path}')
    if reclaim_path.is_symlink():
        raise LlmAccountPoolStateError(
            f'LLM 账号池回收锁路径禁止使用 symlink: {reclaim_path}'
        )
    token = uuid.uuid4().hex
    started = time.monotonic()
    while True:
        if reclaim_path.is_symlink():
            raise LlmAccountPoolStateError(
                f'LLM 账号池回收锁路径禁止使用 symlink: {reclaim_path}'
            )
        if reclaim_path.exists():
            try:
                reclaim_age = time.time() - reclaim_path.stat().st_mtime
            except FileNotFoundError:
                continue
            if reclaim_age > stale_seconds:
                shutil.rmtree(reclaim_path, ignore_errors=True)
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
                atomic_write_json(lock_path / 'owner.json', {
                    'pid': os.getpid(),
                    'hostname': socket.gethostname(),
                    'token': token,
                    'acquiredAt': datetime.now(timezone.utc).isoformat(),
                }, mode=0o600)
            except Exception:
                shutil.rmtree(lock_path, ignore_errors=True)
                raise
            break
        except FileExistsError:
            if _lock_reclaimable(lock_path, stale_seconds):
                owns_reclaim = False
                try:
                    reclaim_path.mkdir()
                    owns_reclaim = True
                    if _lock_reclaimable(lock_path, stale_seconds):
                        shutil.rmtree(lock_path, ignore_errors=True)
                except FileExistsError:
                    pass
                finally:
                    if owns_reclaim:
                        shutil.rmtree(reclaim_path, ignore_errors=True)
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
            owner_path = lock_path / 'owner.json'
            if owner_path.is_symlink():
                raise LlmAccountPoolStateError(
                    f'LLM 账号池 owner 路径禁止使用 symlink: {owner_path}'
                )
            owner = json.loads(owner_path.read_text(encoding='utf-8'))
            if owner.get('token') == token:
                shutil.rmtree(lock_path, ignore_errors=True)
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            pass


def _new_state():
    return {
        'schemaVersion': STATE_SCHEMA_VERSION,
        'policyVersion': POLICY_VERSION,
        'generation': 0,
        'services': {},
    }


def _reject_non_finite_json(value):
    raise ValueError(f'非法非有限数值: {value}')


def read_state_strict(state_file=LLM_ACCOUNT_POOL_STATE_FILE):
    target = Path(state_file)
    try:
        if target.is_symlink():
            raise LlmAccountPoolStateError(f'LLM 账号池状态路径禁止使用 symlink: {target}')
        state = json.loads(
            target.read_text(encoding='utf-8'),
            parse_constant=_reject_non_finite_json,
        )
        target.chmod(0o600)
    except FileNotFoundError:
        return _new_state()
    except LlmAccountPoolStateError:
        raise
    except (OSError, ValueError) as exc:
        raise LlmAccountPoolStateError(
            f'LLM 账号池状态损坏或不可读，已阻止覆盖 {target}: {exc}'
        ) from exc
    schema_version = state.get('schemaVersion') if isinstance(state, dict) else None
    generation = state.get('generation') if isinstance(state, dict) else None
    if not isinstance(state, dict) \
            or type(schema_version) is not int \
            or schema_version != STATE_SCHEMA_VERSION \
            or state.get('policyVersion') != POLICY_VERSION \
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
            active = group.get('activeAccountId') if isinstance(group, dict) else None
            if not isinstance(group, dict) or (active is not None and not isinstance(active, str)):
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


def _build_exhausted_error(service, account_ids, now_ms):
    blocked = [service['accounts'].get(account_id, {}) for account_id in account_ids]
    blocked = [record for record in blocked if _account_is_blocked(record, now_ms)]
    earliest = min((record['blockedUntilMs'] for record in blocked), default=None)
    suffix = '' if earliest is None else (
        '，最早恢复时间 '
        + datetime.fromtimestamp(earliest / 1000, tz=timezone.utc).isoformat()
    )
    return LlmAccountPoolExhaustedError(
        f'所有 OpenCode Go 账号都处于额度冷却{suffix}',
        earliest_retry_at_ms=earliest,
        blocked_account_count=len(blocked),
    )


def select_api_key(api_keys, endpoint, state_file=LLM_ACCOUNT_POOL_STATE_FILE, *,
                   now_ms=None, exclude_account_ids=()):
    keys = normalize_api_keys(api_keys)
    identity = get_pool_identity(keys, endpoint)
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    excluded = set(exclude_account_ids or ())
    selection = {}

    def updater(state):
        service = _ensure_service(state, identity)
        group = service['groups'].get(identity['group_id']) or {
            'activeAccountId': None,
            'switchedAt': None,
        }
        keys_by_id = dict(zip(identity['account_ids'], keys))
        active_id = group.get('activeAccountId')
        if active_id in keys_by_id and active_id not in excluded \
                and not _account_is_blocked(service['accounts'].get(active_id, {}), now_ms):
            selection.update({
                'api_key': keys_by_id[active_id],
                'account_id': active_id,
                **identity,
            })
            if service['accounts'].get(active_id, {}).get('status') == 'quota_blocked':
                service['accounts'][active_id]['status'] = 'eligible_after_reset'
                return state
            return None
        next_id = next((account_id for account_id in identity['account_ids']
                        if account_id not in excluded
                        and not _account_is_blocked(service['accounts'].get(account_id, {}), now_ms)), None)
        if next_id is None:
            raise _build_exhausted_error(service, identity['account_ids'], now_ms)
        group['activeAccountId'] = next_id
        group['switchedAt'] = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).isoformat()
        service['groups'][identity['group_id']] = group
        if service['accounts'].get(next_id, {}).get('status') == 'quota_blocked':
            service['accounts'][next_id]['status'] = 'eligible_after_reset'
        selection.update({
            'api_key': keys_by_id[next_id],
            'account_id': next_id,
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

    def updater(state):
        service = _ensure_service(state, selection)
        previous = service['accounts'].get(selection['account_id']) or {}
        effective_until = max(int(previous.get('blockedUntilMs') or 0), blocked_until_ms)
        service['accounts'][selection['account_id']] = {
            **previous,
            'status': 'quota_blocked',
            'reason': 'GoUsageLimitError',
            'limitName': str((quota or {}).get('limit_class') or 'unknown'),
            'blockedUntilMs': effective_until,
            'blockedUntil': datetime.fromtimestamp(
                effective_until / 1000, tz=timezone.utc
            ).isoformat(),
            'lastFailureAt': datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).isoformat(),
            'lastFailureStatus': 429,
        }
        for group in service['groups'].values():
            if isinstance(group, dict) and group.get('activeAccountId') == selection['account_id']:
                group['activeAccountId'] = None
        return state

    _update_state(state_file, updater)
    return blocked_until_ms


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
            evidence.append(min(seconds * 1000, MAX_BLOCK_MS))
        for part in raw_text.split(','):
            coalesced_seconds = _parse_positive_finite_delay(part)
            if coalesced_seconds is not None:
                evidence.append(min(coalesced_seconds * 1000, MAX_BLOCK_MS))
        if re.search(r'[A-Za-z]', raw_text):
            try:
                from email.utils import parsedate_to_datetime
                target = parsedate_to_datetime(raw_text)
                if target.tzinfo is None:
                    target = target.replace(tzinfo=timezone.utc)
                delta = target.timestamp() * 1000 - now_ms
                if math.isfinite(delta) and delta > 0:
                    evidence.append(min(delta, MAX_BLOCK_MS))
            except (TypeError, ValueError, OverflowError):
                pass
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
        delay_ms = amount * multiplier
        if math.isfinite(delay_ms) and delay_ms > 0:
            evidence.append(min(delay_ms, MAX_BLOCK_MS))
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


def classify_opencode_go_quota_response(status, headers, body, *, raw='', now_ms=None):
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
    'STATE_SCHEMA_VERSION', 'POLICY_VERSION', 'MAX_SAFE_INTEGER',
    'LlmAccountPoolExhaustedError',
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
