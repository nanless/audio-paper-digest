#!/usr/bin/env python3
"""Python 侧共享固定 IP HTTPS 传输原语：源站并发门禁、共享冷却、抖动指数退避与 Retry-After 解析。"""

from __future__ import annotations

if __name__ == '__main__':
    import sys as _sys
    from pathlib import Path as _Path
    _scripts_dir = str(_Path(__file__).resolve().parent)
    if _scripts_dir not in _sys.path:
        _sys.path.insert(0, _scripts_dir)
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
    raise SystemExit('This pure helper is imported by the normal publisher, not a direct CLI.')

import contextlib
import email.utils
import http.client
import ipaddress
import os
import random
import re
import ssl
import threading
import time
from collections.abc import Iterable
from datetime import datetime, timezone
from urllib.parse import urlparse

DEFAULT_ARXIV_MAX_CONCURRENCY = 3
MAX_ARXIV_CONCURRENCY = 6
DEFAULT_OTHER_ORIGIN_MAX_CONCURRENCY = 4
MAX_COOLDOWN_SECONDS = 120.0
DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 8.0
DEFAULT_TRANSIENT_COOLDOWN_SECONDS = 2.0

RETRYABLE_IMAGE_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504})
COOLDOWN_TRIGGER_HTTP_STATUSES = frozenset({429, 502, 503, 504})


class TransientHttpStatusError(Exception):
    """可重试的瞬时 HTTP 状态错误（429/5xx），携带可选 Retry-After 头。"""

    def __init__(self, status: int, retry_after: str | None = None, message: str | None = None):
        self.status = int(status)
        self.retry_after = retry_after if isinstance(retry_after, str) and retry_after.strip() else None
        super().__init__(message or f'HTTP {self.status}')


def resolve_arxiv_max_concurrency(env=None) -> int:
    """解析并钳位 arXiv 源站最大并发数（默认 3，范围 1..6）。"""
    source = os.environ if env is None else env
    raw = str(source.get('PD_ARXIV_MAX_CONCURRENCY', '') or '').strip()
    if not raw:
        return DEFAULT_ARXIV_MAX_CONCURRENCY
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_ARXIV_MAX_CONCURRENCY
    return min(MAX_ARXIV_CONCURRENCY, max(1, value))


def normalize_origin_key(url_or_host: str) -> str:
    """将 URL 或主机名归一为源站门禁键；所有 *.arxiv.org 共享同一个 arxiv.org 门禁。"""
    text = str(url_or_host or '').strip()
    if not text:
        return 'unknown'
    host = ''
    if '://' in text:
        try:
            host = (urlparse(text).hostname or '').strip().lower()
        except ValueError:
            host = ''
    else:
        host = text.split('/', 1)[0].split(':', 1)[0].strip().lower()
    host = host.rstrip('.')
    if not host:
        return 'unknown'
    if host == 'arxiv.org' or host.endswith('.arxiv.org'):
        return 'arxiv.org'
    return host


def parse_retry_after_seconds(
    header_value,
    *,
    now_wall: float | None = None,
    max_seconds: float = MAX_COOLDOWN_SECONDS,
) -> float | None:
    """解析 HTTP Retry-After（秒数或 IMF-fixdate），并钳位到 [0, max_seconds]。"""
    raw = str(header_value or '').strip()
    if not raw:
        return None
    if re.fullmatch(r'\d+(?:\.\d+)?', raw):
        try:
            seconds = float(raw)
        except ValueError:
            return None
        return min(float(max_seconds), max(0.0, seconds))
    try:
        parsed_dt = email.utils.parsedate_to_datetime(raw)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed_dt is None:
        return None
    if parsed_dt.tzinfo is None:
        parsed_dt = parsed_dt.replace(tzinfo=timezone.utc)
    now_ts = time.time() if now_wall is None else float(now_wall)
    delta = parsed_dt.timestamp() - now_ts
    return min(float(max_seconds), max(0.0, delta))


def jittered_exponential_backoff(
    attempt: int,
    *,
    base_seconds: float = 1.0,
    max_seconds: float = 12.0,
    jitter_low: float = 0.7,
    jitter_high: float = 1.3,
    remaining_seconds: float | None = None,
    uniform_fn=None,
) -> float:
    """计算带随机抖动的指数退避时长，严格不超过剩余截止预算。"""
    exp = max(0, int(attempt))
    raw = min(float(max_seconds), float(base_seconds) * (2 ** exp))
    jitter = float((uniform_fn or random.uniform)(float(jitter_low), float(jitter_high)))
    delay = max(0.0, raw * jitter)
    if remaining_seconds is not None:
        delay = min(delay, max(0.0, float(remaining_seconds)))
    return delay


def ordered_candidate_addresses(resolved_addresses: Iterable[str]) -> list[str]:
    """按 IPv4 优先、字典序稳定排列已验证公网地址。"""
    return sorted(
        set(resolved_addresses),
        key=lambda value: (ipaddress.ip_address(value).version, value),
    )


def _iter_exception_chain(exc: BaseException | None):
    seen = set()
    queue = [exc] if exc is not None else []
    while queue:
        current = queue.pop(0)
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        yield current
        for attr in ('__cause__', '__context__', 'reason'):
            nested = getattr(current, attr, None)
            if isinstance(nested, BaseException) and id(nested) not in seen:
                queue.append(nested)
        args = getattr(current, 'args', ())
        for arg in args:
            if isinstance(arg, BaseException) and id(arg) not in seen:
                queue.append(arg)


def is_origin_cooldown_exception(exc: BaseException | None) -> bool:
    """识别应触发共享源站冷却的传输断开异常（SSLEOFError / ConnectionResetError / RemoteDisconnected）。"""
    for item in _iter_exception_chain(exc):
        if isinstance(item, (ssl.SSLEOFError, ConnectionResetError, http.client.RemoteDisconnected)):
            return True
    return False


def is_transient_transport_exception(exc: BaseException | None) -> bool:
    """识别可重试的传输层异常（含 urllib3 HTTPError、OSError、HTTPException 与 TransientHttpStatusError）。"""
    if isinstance(exc, (TransientHttpStatusError, OSError, http.client.HTTPException)):
        return True
    try:
        import urllib3.exceptions as _urllib3_exc
        if isinstance(exc, _urllib3_exc.HTTPError):
            return True
    except ImportError:
        pass
    return False


def _extract_retry_after(headers) -> str | None:
    if headers is None:
        return None
    getter = getattr(headers, 'get', None)
    if callable(getter):
        value = getter('Retry-After') or getter('retry-after')
        if value is not None:
            return str(value)
    if isinstance(headers, dict):
        for key, value in headers.items():
            if str(key).lower() == 'retry-after' and value is not None:
                return str(value)
    return None


class OriginGate:
    """单源站进程内并发信号量 + 共享冷却时间戳（对齐 Node arxiv-origin-gate.js）。"""

    def __init__(self, max_concurrency: int):
        limit = max(1, int(max_concurrency))
        self.max_concurrency = limit
        self._semaphore = threading.BoundedSemaphore(limit)
        self._lock = threading.Lock()
        self._cooldown_until: float = 0.0

    def record_cooldown(self, wait_seconds: float, *, now_monotonic: float | None = None) -> float:
        try:
            wait = float(wait_seconds)
        except (TypeError, ValueError):
            return 0.0
        if not (wait > 0.0) or wait != wait:
            return 0.0
        bounded = min(MAX_COOLDOWN_SECONDS, wait)
        now = time.monotonic() if now_monotonic is None else float(now_monotonic)
        target = now + bounded
        with self._lock:
            if target > self._cooldown_until:
                self._cooldown_until = target
            return max(0.0, self._cooldown_until - now)

    def record_rate_limit_response(
        self,
        headers=None,
        *,
        fallback_seconds: float = DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS,
        retry_after_value=None,
        now_monotonic: float | None = None,
    ) -> float:
        raw_retry_after = retry_after_value if retry_after_value is not None else _extract_retry_after(headers)
        parsed = parse_retry_after_seconds(raw_retry_after)
        wait = max(parsed, 1.0) if parsed is not None else float(fallback_seconds)
        return self.record_cooldown(wait, now_monotonic=now_monotonic)

    def record_transient_failure(
        self,
        exc: BaseException | None = None,
        *,
        status: int | None = None,
        retry_after=None,
        headers=None,
        fallback_seconds: float = DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
        now_monotonic: float | None = None,
    ) -> float:
        raw_retry_after = retry_after if retry_after is not None else _extract_retry_after(headers)
        if status == 429 or raw_retry_after is not None:
            fallback = DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS if status == 429 else fallback_seconds
            return self.record_rate_limit_response(
                headers=headers,
                fallback_seconds=fallback,
                retry_after_value=raw_retry_after,
                now_monotonic=now_monotonic,
            )
        if status in COOLDOWN_TRIGGER_HTTP_STATUSES or is_origin_cooldown_exception(exc):
            return self.record_cooldown(fallback_seconds, now_monotonic=now_monotonic)
        return 0.0

    def remaining_cooldown_seconds(self, *, now_monotonic: float | None = None) -> float:
        now = time.monotonic() if now_monotonic is None else float(now_monotonic)
        with self._lock:
            return max(0.0, self._cooldown_until - now)

    def wait_cooldown(
        self,
        *,
        deadline: float | None = None,
        sleep_fn=time.sleep,
        monotonic_fn=time.monotonic,
    ) -> float:
        slept = 0.0
        while True:
            now = monotonic_fn()
            remain = self.remaining_cooldown_seconds(now_monotonic=now)
            if remain <= 0.0:
                break
            wait = remain
            if deadline is not None:
                budget = float(deadline) - now
                if budget <= 0.0:
                    break
                wait = min(wait, budget)
            if wait <= 0.0:
                break
            sleep_fn(wait)
            slept += wait
            after = monotonic_fn()
            # 单元测试中若 mock 了 sleep 且未按 wait 推进 monotonic，避免自旋消耗整段冷却时长。
            if after <= now or (sleep_fn is not time.sleep and (after - now) < min(wait * 0.5, 0.01)):
                break
        return slept

    @contextlib.contextmanager
    def slot(
        self,
        *,
        deadline: float | None = None,
        sleep_fn=time.sleep,
        monotonic_fn=time.monotonic,
    ):
        if deadline is not None:
            budget = float(deadline) - monotonic_fn()
            if budget <= 0.0:
                raise TimeoutError('等待源站并发门禁超过绝对截止时间')
            acquired = self._semaphore.acquire(timeout=budget)
            if not acquired:
                raise TimeoutError('等待源站并发门禁超过绝对截止时间')
        else:
            self._semaphore.acquire()
        try:
            self.wait_cooldown(
                deadline=deadline,
                sleep_fn=sleep_fn,
                monotonic_fn=monotonic_fn,
            )
            yield self
        finally:
            self._semaphore.release()

    def reset_for_tests(self) -> None:
        with self._lock:
            self._cooldown_until = 0.0


_ORIGIN_GATES_LOCK = threading.Lock()
_ORIGIN_GATES: dict[str, OriginGate] = {}


def get_origin_gate(url_or_host: str, *, max_concurrency: int | None = None) -> OriginGate:
    """获取指定源站的进程内共享并发与冷却门禁。"""
    origin = normalize_origin_key(url_or_host)
    if max_concurrency is not None:
        desired = max(1, int(max_concurrency))
    elif origin == 'arxiv.org':
        desired = resolve_arxiv_max_concurrency()
    else:
        desired = DEFAULT_OTHER_ORIGIN_MAX_CONCURRENCY
    with _ORIGIN_GATES_LOCK:
        existing = _ORIGIN_GATES.get(origin)
        if existing is None or existing.max_concurrency != desired:
            existing = OriginGate(desired)
            _ORIGIN_GATES[origin] = existing
        return existing


def reset_origin_gates_for_tests() -> None:
    """测试清理：重置所有源站门禁状态与冷却窗口。"""
    with _ORIGIN_GATES_LOCK:
        for gate in _ORIGIN_GATES.values():
            gate.reset_for_tests()
        _ORIGIN_GATES.clear()
