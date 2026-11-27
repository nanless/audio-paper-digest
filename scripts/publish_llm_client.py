#!/usr/bin/env python3
"""发布阶段 LLM HTTP/SSE 客户端、账号池调度与分级推理封装（从 publish_common.py 拆出）。

顶层仅导入 Python 标准库，确保 AST 隔离测试在无项目配置/环境初始化的前提下安全加载；
所有协作对象与环境变量均经由 ContextVar 钩子解析，完整兼容 publish_common 的 monkeypatch。
"""

from __future__ import annotations

if __name__ == '__main__':
    import sys as _sys
    from pathlib import Path as _Path
    _scripts_dir = str(_Path(__file__).resolve().parent)
    if _scripts_dir not in _sys.path:
        _sys.path.insert(0, _scripts_dir)
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
    raise SystemExit('This pure helper is imported via publish_common, not a direct CLI.')

import contextvars
import http.client
import json
import math
import os
import random
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Mapping
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

_ACTIVE_HOOKS: contextvars.ContextVar[Mapping | None] = contextvars.ContextVar(
    'publish_llm_client_hooks', default=None,
)


@contextmanager
def _hooks_scope(hooks: Mapping | None):
    if hooks is None:
        yield
        return
    token = _ACTIVE_HOOKS.set(hooks)
    try:
        yield
    finally:
        _ACTIVE_HOOKS.reset(token)


class _HookAccessor:
    def __getattr__(self, name: str):
        hooks = _ACTIVE_HOOKS.get()
        if hooks is not None and name in hooks:
            return hooks[name]
        if name in globals():
            return globals()[name]
        if hooks is None:
            pc = sys.modules.get('publish_common')
            if pc is None:
                pc = __import__('publish_common')
            if hasattr(pc, name):
                return getattr(pc, name)
        raise RuntimeError(f'publish_llm_client 缺少必需运行钩子: {name}')

    def get(self, name: str, default=None):
        hooks = _ACTIVE_HOOKS.get()
        if hooks is not None:
            if name in hooks:
                return hooks[name]
            return globals().get(name, default)
        if name in globals():
            return globals()[name]
        pc = sys.modules.get('publish_common')
        if pc is not None and hasattr(pc, name):
            return getattr(pc, name)
        return default


_H = _HookAccessor()


def get_claude_code_version():
    """返回本地 Claude CLI 版本，用于 Anthropic 兼容的 User-Agent。"""
    try:
        result = _H.subprocess.run(
            ['claude', '--version'],
            capture_output=True,
            text=True,
            timeout=1,
            check=False,
            env=_H.build_child_process_env(),
        )
        output = (result.stdout or result.stderr or '').strip()
        match = re.match(r'^(\d+\.\d+\.\d+)', output)
        if match:
            return match.group(1)
    except Exception:
        pass
    return '2.1.108'


def detect_publish_api_type(endpoint, model):
    """检测发布脚本使用的 LLM API 协议，与 Node utils.js 保持一致。"""
    ep = (endpoint or '').rstrip('/').lower()
    m = (model or '').lower()
    # 只按端点判断：DeepSeek 官方端点走 Chat Completions；OpenCode Go 网关上
    # deepseek-v4.1-flash 与 muse-spark 一样按 Responses 调用。
    if 'deepseek.com' in ep:
        return 'openai'
    if (ep.endswith('/responses') or m.startswith('muse-spark-')
            or m.startswith('deepseek-v4.1-flash')):
        return 'openai_responses'
    is_token_plan = 'token-plan' in ep or 'coding' in ep
    is_mimo = 'xiaomimimo.com' in ep or 'mimo' in m
    is_kimi = 'kimi.com' in ep or 'kimi' in m
    if (is_mimo or is_kimi) and is_token_plan:
        return 'anthropic'
    if '/anthropic' in ep:
        return 'anthropic'
    return 'openai'


def _is_publish_loopback_hostname(hostname):
    normalized = str(hostname or '').lower().strip('[]')
    if normalized == 'localhost' or normalized.endswith('.localhost') or normalized == '::1':
        return True
    if not re.fullmatch(r'(?:\d{1,3}\.){3}\d{1,3}', normalized):
        return False
    octets = [int(part) for part in normalized.split('.')]
    return all(0 <= octet <= 255 for octet in octets) and octets[0] == 127


def validate_publish_api_endpoint_url(endpoint):
    """只允许 HTTPS；明文 HTTP 仅供 loopback 本地测试服务。"""
    if not isinstance(endpoint, str) or not endpoint or re.search(r'[\x00-\x20\x7f\\]', endpoint):
        raise ValueError('LLM endpoint 必须是完整的 HTTPS URL（本地测试可用 loopback HTTP）')
    authority_match = re.match(r'^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]+)', endpoint)
    if not authority_match:
        raise ValueError('LLM endpoint 必须是完整的 HTTPS URL（本地测试可用 loopback HTTP）')
    try:
        parsed = _H.urllib.parse.urlsplit(endpoint)
        # 访问这些属性同时会拒绝格式错误的方括号和端口。
        hostname = parsed.hostname
        port = parsed.port
        username = parsed.username
        password = parsed.password
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(
            'LLM endpoint 必须是完整的 HTTPS URL（本地测试可用 loopback HTTP）'
        ) from exc

    if not parsed.scheme or not hostname:
        raise ValueError('LLM endpoint 必须是完整的 HTTPS URL（本地测试可用 loopback HTTP）')
    if username is not None or password is not None or '@' in (parsed.netloc or '') or '@' in authority_match.group(1):
        raise ValueError('LLM endpoint 禁止包含 URL userinfo 凭据')
    if port is not None and not (1 <= port <= 65535):
        raise ValueError('LLM endpoint 端口非法')

    protocol = parsed.scheme.lower()
    if protocol == 'https':
        return parsed
    if protocol == 'http' and _H._is_publish_loopback_hostname(hostname):
        return parsed
    raise ValueError(
        f'LLM endpoint 禁止使用公网明文 {protocol or "协议"}；'
        '请改用 HTTPS，本地 HTTP 仅允许 loopback 地址'
    )


def build_publish_api_url(api_type, endpoint):
    """根据协议构造最终 LLM 请求 URL。"""
    _H.validate_publish_api_endpoint_url(endpoint)
    base = (endpoint or '').rstrip('/')
    base_lower = base.lower()
    if api_type == 'anthropic':
        if 'xiaomimimo.com' in base_lower:
            base = re.sub(r'/v1/?$', '/anthropic', base, flags=re.IGNORECASE)
            return f'{base}/v1/messages'
        if 'kimi.com' in base_lower:
            base = re.sub(r'/coding(?:/v1)?$', '/coding/v1', base, flags=re.IGNORECASE)
            return f'{base}/messages'
        return f'{base}/messages'
    if api_type == 'openai_responses':
        return base if base_lower.endswith('/responses') else f'{base}/responses'
    base = re.sub(r'/anthropic/?$', '/v1', base, flags=re.IGNORECASE)
    return f'{base}/chat/completions'


def _canonical_publish_request_url(url):
    """把已校验的请求 URL 规范化，同时不改动它的路径。"""
    parsed = _H.validate_publish_api_endpoint_url(str(url or ''))
    scheme = parsed.scheme.lower()
    hostname = (parsed.hostname or '').lower()
    host = f'[{hostname}]' if ':' in hostname else hostname
    port = parsed.port
    if port is not None and not (
            (scheme == 'https' and port == 443) or (scheme == 'http' and port == 80)):
        host = f'{host}:{port}'
    return _H.urllib.parse.urlunsplit((
        scheme,
        host,
        parsed.path or '/',
        parsed.query,
        parsed.fragment,
    ))


def _canonical_publish_service_endpoint(url):
    """同一服务商内安全继承 key 时使用的规范端点身份。"""
    canonical = _H.urllib.parse.urlsplit(_H._canonical_publish_request_url(url))
    return _H.urllib.parse.urlunsplit((
        canonical.scheme,
        canonical.netloc,
        canonical.path.rstrip('/') or '/',
        canonical.query,
        canonical.fragment,
    ))


def build_publish_headers(api_type, api_key, claude_version=None):
    if api_type == 'anthropic':
        version = claude_version or _H.get_claude_code_version()
        return {
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01',
            'User-Agent': f'claude-cli/{version} (external, cli)',
            'Content-Type': 'application/json'
        }
    return {
        'Authorization': f'Bearer {api_key}',
        # urllib 默认的 Python-urllib/* 标识会被部分 OpenAI 兼容网关（含 OpenCode Go）
        # 拒绝。这里用诚实、稳定的项目标识，不冒充厂商 SDK。
        'User-Agent': 'audio-paper-digest/1.0',
        'Content-Type': 'application/json'
    }


def build_publish_payload(
    api_type, model, prompt, max_tokens, temperature, images=None,
    *, stage=None, prompt_cache_key=None,
):
    images = images or []
    if api_type == 'anthropic':
        content = []
        for image in images:
            content.append({
                'type': 'image',
                'source': {
                    'type': 'base64',
                    'media_type': image['media_type'],
                    'data': image['data'],
                },
            })
        content.append({'type': 'text', 'text': prompt})
        return {
            'model': model,
            'max_tokens': max_tokens,
            'messages': [{'role': 'user', 'content': content if images else prompt}]
        }
    if api_type == 'openai_responses':
        content = [{'type': 'input_text', 'text': prompt}]
        for image in images:
            data_uri = f"data:{image['media_type']};base64,{image['data']}"
            content.append({
                'type': 'input_image',
                'image_url': data_uri,
                'detail': 'high',
            })
        payload = {
            'model': model,
            'max_output_tokens': max_tokens,
            'temperature': temperature,
            'input': [{'role': 'user', 'content': content}],
        }
        reasoning_effort = _H.resolve_stage_reasoning_effort(
            _H.os.environ.get('PD_OPENAI_RESPONSES_REASONING_EFFORT', ''),
            model,
            stage=stage,
        )
        if reasoning_effort:
            payload['reasoning'] = {'effort': reasoning_effort}
        raw_cache_key = str(prompt_cache_key or '').strip()
        if raw_cache_key and _H.os.environ.get('PD_OPENAI_RESPONSES_PROMPT_CACHE_KEY', '').strip().lower() not in {'0', 'false', 'no', 'off'}:
            payload['prompt_cache_key'] = raw_cache_key[:64]
        if _H.os.environ.get('PD_OPENAI_RESPONSES_STREAM', '').strip().lower() in {'1', 'true', 'yes', 'on'}:
            payload['stream'] = True
        return payload
    content = [{'type': 'text', 'text': prompt}]
    for image in images:
        data_uri = f"data:{image['media_type']};base64,{image['data']}"
        content.append({
            'type': 'image_url',
            'image_url': {'url': data_uri, 'detail': 'high'},
        })
    return {
        'model': model,
        'max_tokens': max_tokens,
        'temperature': temperature,
        'messages': [{'role': 'user', 'content': content if images else prompt}]
    }


def parse_publish_response_text(api_type, data):
    if not isinstance(data, dict):
        return ''
    if api_type == 'anthropic':
        blocks = data.get('content')
        if isinstance(blocks, list):
            parts = [
                block['text']
                for block in blocks
                if isinstance(block, dict)
                and block.get('type') == 'text'
                and isinstance(block.get('text'), str)
                and block['text']
            ]
            return '\n'.join(parts).strip()
        return ''
    if api_type == 'openai_responses':
        if isinstance(data.get('output_text'), str) and data['output_text'].strip():
            return data['output_text'].strip()
        parts = []
        outputs = data.get('output')
        if isinstance(outputs, list):
            for item in outputs:
                if not isinstance(item, dict):
                    continue
                content_blocks = item.get('content')
                if not isinstance(content_blocks, list):
                    continue
                for block in content_blocks:
                    if isinstance(block, dict) and block.get('type') == 'output_text' \
                            and isinstance(block.get('text'), str):
                        parts.append(block['text'])
        return '\n'.join(part for part in parts if part).strip()
    choices = data.get('choices')
    if not isinstance(choices, list) or not choices:
        return ''
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        return ''
    message = first_choice.get('message')
    if not isinstance(message, dict):
        return ''
    content = message.get('content')
    return content.strip() if isinstance(content, str) else ''


def _publish_llm_requires_proxy(endpoint, model):
    return str(model or '').lower().startswith('muse-spark-')


_PUBLISH_OPENCODE_SESSION_ID = None


# 推理强度档位随模型不同（网关 /v1/models 的 capabilities.reasoning.effort 是权威名单）：
# muse-spark 系列是 minimal/low/medium/high/xhigh，deepseek-v4.1-flash 是 low/high/max。
# 网关对不认识的档位不报错而是静默降级，所以按模型各自的白名单规范化，写错的值不发送。
REASONING_EFFORTS_BY_MODEL = {
    'muse-spark': ('minimal', 'low', 'medium', 'high', 'xhigh'),
    'deepseek': ('low', 'high', 'max'),
}
REASONING_EFFORTS = tuple(dict.fromkeys(
    effort for efforts in REASONING_EFFORTS_BY_MODEL.values() for effort in efforts))


def reasoning_efforts_for(model):
    name = str(model or '').lower()
    for family, efforts in REASONING_EFFORTS_BY_MODEL.items():
        if family in name:
            return efforts
    return REASONING_EFFORTS


def normalize_reasoning_effort(value, model=None):
    allowed = REASONING_EFFORTS if model is None else _H.reasoning_efforts_for(model)
    raw = str(value or '').strip().lower()
    if raw in ('max', 'highest', 'maximum'):
        effort = 'max' if 'max' in allowed else ('xhigh' if 'xhigh' in allowed else raw)
    else:
        effort = raw
    return effort if effort in allowed else ''


STAGE_REASONING_EFFORT_TIERS = {
    'openSourceScan': 'minimal',
    'tagSelection': 'minimal',
    'apiReaderConceptTerms': 'minimal',
    'apiReaderImageProbe': 'minimal',
    'repair_review_payload': 'minimal',
    'dailyFilter': 'low',
    'conference-filter': 'low',
    'publish.text': 'low',
    'publish.review_text': 'low',
    'publish.index_text': 'low',
    'publish.figure': 'medium',
    'publish.review_figure': 'medium',
    'coreSummaryRepair': 'medium',
    'tableRepair': 'medium',
    'structureRepair': 'medium',
    'methodRepair': 'medium',
    'imageSupplement': 'medium',
    'scoringAudit': 'high',
    'apiReaderRepair': 'high',
    'revision': 'high',
}


def resolve_stage_reasoning_effort(value, model=None, *, stage=None):
    base = _H.normalize_reasoning_effort(value, model)
    if not base:
        return ''
    if _H.os.environ.get('PD_TIERED_REASONING_EFFORT', '').strip().lower() in {'0', 'false', 'no', 'off'}:
        return base
    normalized_stage = stage.strip() if isinstance(stage, str) else ''
    requested_tier = STAGE_REASONING_EFFORT_TIERS.get(normalized_stage, '')
    if not requested_tier:
        return base
    allowed = REASONING_EFFORTS if model is None else _H.reasoning_efforts_for(model)
    if requested_tier in allowed:
        mapped_tier = requested_tier
    elif requested_tier == 'minimal' and 'low' in allowed:
        mapped_tier = 'low'
    elif requested_tier == 'medium' and 'high' in allowed:
        mapped_tier = 'high'
    else:
        mapped_tier = base
    if base not in allowed or mapped_tier not in allowed:
        return base
    return allowed[min(allowed.index(base), allowed.index(mapped_tier))]


class PublishSseTerminalEventMissingError(RuntimeError):
    code = 'SSE_TERMINAL_EVENT_MISSING'


def parse_publish_sse_response(raw_text):
    """解析 OpenAI Responses SSE 流，语义与 scripts/utils.js parseSseResponse 对齐。"""
    deltas = []
    completed = None
    terminal_failure = None
    saw_response_event = False
    for block in re.split(r'\r?\n\r?\n', str(raw_text or '')):
        event_name = ''
        data_lines = []
        for line in re.split(r'\r?\n', block):
            if line.startswith('event:'):
                event_name = line[6:].strip()
            elif line.startswith('data:'):
                data_lines.append(line[5:].lstrip(' \t'))
        if not data_lines:
            continue
        data_text = '\n'.join(data_lines)
        if not data_text or data_text == '[DONE]':
            continue
        try:
            event = json.loads(data_text)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        event_type = event.get('type') or event_name
        if isinstance(event_type, str) and event_type.startswith('response.'):
            saw_response_event = True
        if event_type == 'response.output_text.delta' and isinstance(event.get('delta'), str):
            deltas.append(event['delta'])
        elif event_type == 'response.completed' and isinstance(event.get('response'), dict):
            completed = event['response']
        elif event_type in {'response.incomplete', 'response.failed', 'response.cancelled'}:
            if isinstance(event.get('response'), dict):
                terminal_failure = event['response']
            else:
                fallback_status = event_type.split('.', 1)[1]
                terminal_failure = event if event.get('status') else {**event, 'status': fallback_status}
        elif event_type == 'error':
            error_obj = event.get('error')
            terminal_failure = {
                'status': 'failed',
                'error': error_obj if isinstance(error_obj, dict) else {
                    'message': str(event.get('message') or error_obj or 'SSE error event'),
                    'code': event.get('code'),
                },
            }
    if terminal_failure is not None:
        return terminal_failure
    if completed is not None:
        if not _H.parse_publish_response_text('openai_responses', completed) and deltas:
            completed = {**completed, 'output_text': ''.join(deltas)}
        return completed
    if deltas or saw_response_event:
        raise PublishSseTerminalEventMissingError('OpenAI Responses SSE 缺少 response.completed 终态事件')
    return None


def _publish_opencode_session_id():
    global _PUBLISH_OPENCODE_SESSION_ID
    hooks = _ACTIVE_HOOKS.get()
    if isinstance(hooks, dict) and '_PUBLISH_OPENCODE_SESSION_ID' in hooks:
        current = hooks['_PUBLISH_OPENCODE_SESSION_ID']
        if current:
            return current
        session_id = (
            str(_H.os.environ.get('PD_OPENCODE_SESSION_ID') or '').strip()
            or f'audio-paper-digest-{uuid.uuid4()}'
        )
        hooks['_PUBLISH_OPENCODE_SESSION_ID'] = session_id
        return session_id
    if _PUBLISH_OPENCODE_SESSION_ID:
        return _PUBLISH_OPENCODE_SESSION_ID
    _PUBLISH_OPENCODE_SESSION_ID = (
        str(_H.os.environ.get('PD_OPENCODE_SESSION_ID') or '').strip()
        or f'audio-paper-digest-{uuid.uuid4()}'
    )
    return _PUBLISH_OPENCODE_SESSION_ID


class _PublishLLMRedirectError(_H.urllib.error.HTTPError):
    """Redirect denial without retaining a URL, headers or provider body."""

    def __init__(self, code):
        super().__init__('', code, '模型请求禁止自动重定向', {}, None)


class _PublishLLMNoRedirectHandler(_H.urllib.request.HTTPRedirectHandler):
    """Never forward model credentials or payloads through an HTTP redirect."""

    def http_error_302(self, req, fp, code, msg, headers):
        # Reject before the default handler parses Location (including malformed
        # or unsupported targets). Its error paths can retain private URLs/body.
        if fp is not None:
            try:
                fp.close()
            except Exception:
                # Response cleanup must not replace the fixed denial with peer text.
                pass
        raise _H._PublishLLMRedirectError(code) from None

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Also fail closed if a caller invokes the transformation hook directly.
        self.http_error_302(req, fp, code, msg, headers)


def _enable_tcp_keepalive(sock):
    """Enable OS-level TCP keepalive on publish LLM sockets to prevent NAT/proxy idle resets."""
    if sock is None:
        return
    try:
        sock.setsockopt(_H.socket.SOL_SOCKET, _H.socket.SO_KEEPALIVE, 1)
    except OSError:
        return
    # macOS uses TCP_KEEPALIVE (idle seconds); Linux uses TCP_KEEPIDLE.
    for attr, value in (
        ('TCP_KEEPALIVE', 20),
        ('TCP_KEEPIDLE', 20),
        ('TCP_KEEPINTVL', 10),
        ('TCP_KEEPCNT', 6),
    ):
        opt = getattr(_H.socket, attr, None)
        if opt is None:
            continue
        try:
            sock.setsockopt(_H.socket.IPPROTO_TCP, opt, value)
        except OSError:
            pass


PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS = 60.0
PUBLISH_LLM_SSE_IDLE_TIMEOUT_SECONDS = 180.0


def _keepalive_http_init(conn, connect_timeout=None, read_timeout=None):
    default_connect = _H.get('PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS', 60.0)
    conn._connect_timeout = default_connect if connect_timeout is None else connect_timeout
    conn._read_timeout = read_timeout
    conn._handshake_deadline = None


def _keepalive_http_apply_handshake_remaining(conn):
    if conn._handshake_deadline is None:
        return
    default_connect = _H.get('PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS', 60.0)
    remaining = conn._handshake_deadline - _H.time.monotonic()
    if remaining <= 0:
        err = TimeoutError(
            f'代理 CONNECT 连接或 TLS 握手超过 {int(conn._connect_timeout or default_connect)}s，已超时'
        )
        err.code = 'PROXY_CONNECT_TIMEOUT' if getattr(conn, '_tunnel_host', None) else 'CONNECT_HANDSHAKE_TIMEOUT'
        raise err
    if conn.sock is not None:
        try:
            conn.sock.settimeout(max(0.05, remaining))
        except OSError:
            pass


def _keepalive_http_tunnel(conn, super_tunnel):
    default_connect = _H.get('PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS', 60.0)
    conn._apply_handshake_remaining()
    try:
        super_tunnel()
    except TimeoutError as exc:
        err = TimeoutError(
            f'代理 CONNECT 连接或 TLS 握手超过 {int(conn._connect_timeout or default_connect)}s，已超时'
        )
        err.code = 'PROXY_CONNECT_TIMEOUT'
        raise err from exc
    conn._apply_handshake_remaining()


def _keepalive_http_connect(conn, super_connect):
    default_connect = _H.get('PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS', 60.0)
    original_timeout = conn.timeout
    effective_connect = original_timeout
    if isinstance(conn._connect_timeout, (int, float)) and conn._connect_timeout > 0:
        if isinstance(original_timeout, (int, float)) and original_timeout > 0:
            effective_connect = min(float(original_timeout), float(conn._connect_timeout))
        else:
            effective_connect = float(conn._connect_timeout)
    conn._handshake_deadline = (
        _H.time.monotonic() + float(effective_connect)
        if isinstance(effective_connect, (int, float)) and effective_connect > 0
        else None
    )
    conn.timeout = effective_connect
    try:
        try:
            super_connect()
        except TimeoutError as exc:
            if not getattr(exc, 'code', None):
                err = TimeoutError(
                    f'代理 CONNECT 连接或 TLS 握手超过 {int(effective_connect or default_connect)}s，已超时'
                )
                err.code = (
                    'PROXY_CONNECT_TIMEOUT'
                    if getattr(conn, '_tunnel_host', None)
                    else 'CONNECT_HANDSHAKE_TIMEOUT'
                )
                raise err from exc
            raise
    finally:
        conn.timeout = original_timeout
        conn._handshake_deadline = None
    post_timeout = original_timeout
    if isinstance(conn._read_timeout, (int, float)) and conn._read_timeout > 0:
        if isinstance(original_timeout, (int, float)) and original_timeout > 0:
            post_timeout = min(float(original_timeout), float(conn._read_timeout))
        else:
            post_timeout = float(conn._read_timeout)
    if conn.sock is not None and isinstance(post_timeout, (int, float)) and post_timeout > 0:
        try:
            conn.sock.settimeout(max(0.05, float(post_timeout)))
        except OSError:
            pass
    _H._enable_tcp_keepalive(conn.sock)


class _KeepAliveHTTPConnection(http.client.HTTPConnection):
    """将 TCP 连接 + 代理 CONNECT + TLS 握手统一限制在 60s 有效预算内，握手完成后再切换为读取/SSE 空闲超时。"""

    def __init__(self, *args, connect_timeout=None, read_timeout=None, **kwargs):
        _keepalive_http_init(self, connect_timeout=connect_timeout, read_timeout=read_timeout)
        super().__init__(*args, **kwargs)

    def _apply_handshake_remaining(self):
        _keepalive_http_apply_handshake_remaining(self)

    def _tunnel(self):
        _keepalive_http_tunnel(self, super()._tunnel)

    def connect(self):
        _keepalive_http_connect(self, super().connect)


class _KeepAliveHTTPSConnection(_KeepAliveHTTPConnection, http.client.HTTPSConnection):
    pass


class _KeepAliveHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, *args, connect_timeout=None, read_timeout=None, **kwargs):
        super().__init__(*args, **kwargs)
        default_connect = _H.get('PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS', 60.0)
        self._connect_timeout = default_connect if connect_timeout is None else connect_timeout
        self._read_timeout = read_timeout

    def http_open(self, req):
        return self.do_open(
            _H._KeepAliveHTTPConnection,
            req,
            connect_timeout=self._connect_timeout,
            read_timeout=self._read_timeout,
        )


class _KeepAliveHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, *args, connect_timeout=None, read_timeout=None, **kwargs):
        super().__init__(*args, **kwargs)
        default_connect = _H.get('PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS', 60.0)
        self._connect_timeout = default_connect if connect_timeout is None else connect_timeout
        self._read_timeout = read_timeout

    def https_open(self, req):
        return self.do_open(
            _H._KeepAliveHTTPSConnection,
            req,
            context=self._context,
            connect_timeout=self._connect_timeout,
            read_timeout=self._read_timeout,
        )


def _read_publish_http_error(exc):
    cached = getattr(exc, '_paper_digest_error_raw', None)
    if isinstance(cached, bytes):
        raw_bytes = cached
    else:
        try:
            raw_bytes = exc.read(65536)
        except (OSError, AttributeError):
            raw_bytes = b''
        exc._paper_digest_error_raw = raw_bytes
    raw_text = raw_bytes.decode('utf-8', errors='replace').strip()
    try:
        def reject_non_finite(value):
            raise ValueError(f'HTTP error JSON 包含非有限数值: {value}')

        parsed = json.loads(raw_text, parse_constant=reject_non_finite) if raw_text else {}
    except (TypeError, ValueError):
        parsed = {}
    return raw_text, parsed


def _sanitize_publish_llm_error(value, api_keys=()):
    text = str(value or '')
    for secret in api_keys:
        if secret:
            text = text.replace(str(secret), '[REDACTED]')
    text = re.sub(r'\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+', '[REDACTED]', text,
                  flags=re.IGNORECASE)
    text = re.sub(r'(://)[^/@\s]+@', r'\1[REDACTED]@', text)
    return text[:1200]


def _open_publish_json_with_account_pool(
    *, api_url, endpoint, model, api_type, api_keys, payload, opener, timeout,
    state_file=None, usage_sink=None, usage_directory=None, affinity_key=None,
):
    """已确认的 Go 配额/余额失败才在同一次逻辑请求内切换到下一个账号（每个账号至多一次）。"""
    try:
        expected_api_type = _H.detect_publish_api_type(endpoint, model)
        expected_api_url = _H.build_publish_api_url(expected_api_type, endpoint)
        actual_canonical_url = _H._canonical_publish_request_url(api_url)
        expected_canonical_url = _H._canonical_publish_request_url(expected_api_url)
    except (TypeError, ValueError) as exc:
        raise _H.LlmAccountPoolConfigError(
            f'LLM 请求 URL/endpoint/model 路由非法: {exc}'
        ) from exc
    if api_type != expected_api_type or actual_canonical_url != expected_canonical_url:
        raise _H.LlmAccountPoolConfigError(
            'LLM 请求地址或接口类型与配置的端点、模型不匹配，未发送凭据。'
        )
    state_file = Path(state_file or _H.LLM_ACCOUNT_POOL_STATE_FILE)
    if len(api_keys) > 1 and not _H.is_opencode_go_endpoint(endpoint):
        raise _H.LlmAccountPoolConfigError('备用 API key 只允许用于 OpenCode Go 官方端点')
    started = _H.time.monotonic()
    max_account_attempts = len(api_keys) if len(api_keys) > 1 else 1
    attempted_account_ids = set()
    blocked_until_values = []
    resolved_affinity = affinity_key.strip() if isinstance(affinity_key, str) else ''
    if not resolved_affinity:
        try:
            import llm_usage as _usage_mod
            scoped_paper_id = (_usage_mod._SCOPE.get() or {}).get('paperId')
            if isinstance(scoped_paper_id, str) and scoped_paper_id.strip():
                resolved_affinity = scoped_paper_id.strip()
        except Exception:
            pass
    if resolved_affinity:
        resolved_affinity = re.sub(r'^arxiv:', '', resolved_affinity, flags=re.IGNORECASE)
        resolved_affinity = re.sub(r'^(\d{4}\.\d{4,5})v\d+$', r'\1', resolved_affinity, flags=re.IGNORECASE)
    if (
        len(api_keys) > 1
        and _H.is_opencode_go_endpoint(endpoint)
        and type(opener) is _H.urllib.request.OpenerDirector
        and getattr(opener, '_pd_live_usage_sync_allowed', False)
        and getattr(_H.urllib.request.build_opener, '__module__', '') == 'urllib.request'
    ):
        raw_live_proxy = getattr(opener, '_pd_live_usage_proxy', None)
        if raw_live_proxy:
            live_proxy = raw_live_proxy if _H.is_valid_http_connect_proxy_url(raw_live_proxy) else None
        else:
            live_proxy = _H.resolve_http_connect_proxy_url(_H.os.environ)
        if live_proxy:
            try:
                _resolve_sync_timeout = _H.get('resolve_live_sync_timeout_ms')
                configured_sync_timeout_ms = (
                    _resolve_sync_timeout() if callable(_resolve_sync_timeout) else 10000
                )
                sync_timeout_ms = min(configured_sync_timeout_ms, max(1000, int(float(timeout) * 500)))
                _H.sync_opencode_go_pool_usage(
                    api_keys, endpoint, state_file,
                    proxy_url=live_proxy, timeout_ms=sync_timeout_ms,
                )
            except Exception as sync_exc:
                redacted_secrets = list(api_keys)
                try:
                    proxy_password = _H.urllib.parse.urlparse(live_proxy).password
                    if proxy_password:
                        redacted_secrets.append(proxy_password)
                except ValueError:
                    pass
                safe_err = _H._sanitize_publish_llm_error(sync_exc, redacted_secrets)
                print(f'  [llm-account-pool] 实时同步额度失败（回退至本地状态）: {safe_err}')
    for _account_attempt in range(max_account_attempts):
        elapsed = _H.time.monotonic() - started
        remaining = max(0.001, float(timeout) - elapsed)
        if elapsed >= float(timeout):
            raise TimeoutError(f'LLM 请求在账号切换期间超过 {timeout}s deadline')
        if len(api_keys) > 1:
            selection = _H.select_api_key(
                api_keys, endpoint, state_file,
                exclude_account_ids=attempted_account_ids,
                affinity_key=resolved_affinity or None,
            )
            selected_key = selection['api_key']
            selected_account_id = selection['account_id']
            attempted_account_ids.add(selected_account_id)
        else:
            selection = None
            selected_key = api_keys[0]
            _get_account_id = _H.get('get_account_id')
            selected_account_id = (
                _get_account_id(selected_key)
                if _H.is_opencode_go_endpoint(endpoint) and callable(_get_account_id)
                else None
            )
        headers = _H.build_publish_headers(api_type, selected_key)
        if _H.is_opencode_go_endpoint(endpoint):
            headers['User-Agent'] = 'audio-paper-digest/1.0'
            headers['x-opencode-session'] = _H._publish_opencode_session_id()
        request = _H.urllib.request.Request(
            api_url,
            data=json.dumps(payload).encode('utf-8'),
            headers={**headers, 'Content-Type': 'application/json'},
            method='POST',
        )
        usage_started = _H.time.monotonic()
        usage_status = None
        usage_body = None
        usage_raw = None
        usage_raw_truncated = False
        usage_error = None
        pending_usage = _H.begin_pending_llm_request(
            protocol=api_type, model=model, request=payload, directory=usage_directory,
            account_id=selected_account_id,
        )
        try:
            with opener.open(request, timeout=remaining) as response:
                status = response.status
                usage_status = status
                if response.status < 200 or response.status >= 300:
                    raise RuntimeError(f'HTTP {response.status}')
                is_streamed_responses = (api_type == 'openai_responses' and payload.get('stream') is True)
                response_limit = 16 * 1024 * 1024 if is_streamed_responses else 2 * 1024 * 1024
                read_deadline = started + float(timeout)
                raw_sock = None
                fp_obj = getattr(response, 'fp', None)
                if fp_obj is not None:
                    raw_sock = getattr(getattr(fp_obj, 'raw', None), '_sock', None) or getattr(fp_obj, '_sock', None)

                def _tighten_read_socket_timeout():
                    remaining_read = read_deadline - _H.time.monotonic()
                    if remaining_read <= 0:
                        raise TimeoutError(f'LLM 响应读取超过 {timeout}s 总墙钟上限')
                    sse_idle_cap = _H.get('PUBLISH_LLM_SSE_IDLE_TIMEOUT_SECONDS', 180.0)
                    chunk_timeout = (
                        min(remaining_read, sse_idle_cap)
                        if is_streamed_responses
                        else remaining_read
                    )
                    if raw_sock is not None and hasattr(raw_sock, 'settimeout'):
                        try:
                            raw_sock.settimeout(max(0.05, chunk_timeout))
                        except OSError:
                            pass
                    return chunk_timeout

                if is_streamed_responses and isinstance(response, _H.http.client.HTTPResponse):
                    chunks = []
                    total_read = 0
                    while total_read <= response_limit:
                        idle_budget = _tighten_read_socket_timeout()
                        want = min(65536, response_limit + 1 - total_read)
                        read_fn = getattr(response, 'read1', None)
                        try:
                            chunk = read_fn(want) if callable(read_fn) else response.read(want)
                        except TimeoutError as exc:
                            if _H.time.monotonic() < read_deadline and not getattr(exc, 'code', None):
                                err = TimeoutError(f'SSE 流在 {int(round(idle_budget))}s 内未收到任何分片，已空闲超时')
                                err.code = 'REQUEST_STREAM_IDLE_TIMEOUT'
                                raise err from exc
                            raise
                        if not chunk:
                            break
                        chunks.append(chunk)
                        total_read += len(chunk)
                    raw_response = b''.join(chunks)
                else:
                    _tighten_read_socket_timeout()
                    raw_response = response.read(response_limit + 1)
                    if _H.time.monotonic() > read_deadline:
                        raise TimeoutError(f'LLM 响应读取超过 {timeout}s 总墙钟上限')
                usage_raw = raw_response
                usage_raw_truncated = len(raw_response) > response_limit
                if len(raw_response) > response_limit:
                    limit_mib = response_limit // (1024 * 1024)
                    raise RuntimeError(f'LLM 响应超过 {limit_mib} MiB 安全上限')
                usage_raw = raw_response.decode('utf-8')
                try:
                    usage_body = json.loads(usage_raw)
                except ValueError:
                    streamed = _H.parse_publish_sse_response(usage_raw) if api_type == 'openai_responses' else None
                    if streamed is None:
                        raise
                    usage_body = streamed
                if selection is not None and isinstance(usage_body, dict) and isinstance(usage_body.get('usage'), dict):
                    try:
                        _H.record_account_usage(
                            selection,
                            {'usage': usage_body.get('usage'), 'costUsd': usage_body.get('cost')},
                            state_file,
                        )
                    except Exception as usage_exc:
                        print(f'  [llm-account-pool] 记录账号用量失败（不影响本次成功响应）: {usage_exc}')
                return status, usage_body
        except _H.urllib.error.HTTPError as exc:
            raw_text, parsed = _H._read_publish_http_error(exc)
            usage_raw = getattr(exc, '_paper_digest_error_raw', None) or raw_text
            usage_raw_truncated = isinstance(usage_raw, bytes) and len(usage_raw) >= 65536
            usage_status, usage_body = exc.code, parsed
            quota = _H.classify_opencode_go_quota_response(
                exc.code, exc.headers, parsed, raw=raw_text, endpoint=endpoint,
            ) if _H.is_opencode_go_endpoint(endpoint) else None
            if _H.is_opencode_go_endpoint(endpoint) and exc.code == 401 and quota is None:
                raise _H.LlmAccountAuthError() from exc
            if selection is None and quota is not None:
                raise _H.LlmAccountPoolExhaustedError('OpenCode Go 当前账号额度不足，未配置后续账号') from exc
            if selection is None or quota is None:
                raise
            blocked_until_ms = _H.mark_quota_exhausted(selection, quota, state_file)
            blocked_until_values.append(blocked_until_ms)
            account_number = api_keys.index(selected_key) + 1
            limit_name = f" ({quota['limit_class']})" if quota.get('limit_class') else ''
            blocked_until = _H.datetime.fromtimestamp(
                blocked_until_ms / 1000, tz=_H.timezone.utc
            ).isoformat()
            print(
                f'  [llm-account-pool] OpenCode Go 账号 {account_number} '
                f'已确认额度耗尽{limit_name}，冷却至 {blocked_until}'
            )
        except Exception as exc:
            inner_exc = (
                exc.reason
                if isinstance(exc, _H.urllib.error.URLError) and isinstance(exc.reason, BaseException)
                else exc
            )
            custom_code = getattr(inner_exc, 'code', None) or getattr(exc, 'code', None)
            usage_error = (
                str(custom_code)
                if isinstance(custom_code, str) and custom_code
                else type(inner_exc).__name__
            )
            raise
        finally:
            try:
                usage_text = _H.parse_publish_response_text(api_type, usage_body) if isinstance(usage_body, dict) else None
            except (AttributeError, IndexError, KeyError, TypeError, ValueError):
                usage_text = None
            _H.record_llm_usage(
                protocol=api_type, model=model, request=payload, response=usage_body,
                status_code=usage_status, duration_ms=(_H.time.monotonic() - usage_started) * 1000,
                error_code=usage_error,
                output_text=usage_text,
                sink=usage_sink, directory=usage_directory,
                raw_response=usage_raw,
                raw_response_truncated=usage_raw_truncated,
                event_id=pending_usage['eventId'], transport_started=True,
                account_id=selected_account_id,
            )
    earliest = min(blocked_until_values) if blocked_until_values else None
    suffix = '' if earliest is None else (
        '，最早恢复时间 '
        + _H.datetime.fromtimestamp(earliest / 1000, tz=_H.timezone.utc).isoformat()
    )
    raise _H.LlmAccountPoolExhaustedError(
        f'本次请求已尝试全部 OpenCode Go 账号；均明确返回额度耗尽{suffix}',
        earliest_retry_at_ms=earliest,
        blocked_account_count=len(blocked_until_values),
    )


def call_publish_llm_api(
    prompt,
    max_tokens=800,
    temperature=0.1,
    required=False,
    context='LLM review',
    timeout=120,
    max_retries=5,
    images=None,
    use_secondary=False,
    structured_output=False,
    usage_context=None,
    usage_sink=None,
    usage_directory=None,
):
    """调用发布阶段模型。required=True 时，缺配置或连续失败会抛错。"""
    primary_key = _H.os.environ.get('PAPER_ANALYZER_API_KEY', '')
    primary_endpoint = _H.os.environ.get('PAPER_ANALYZER_ENDPOINT', '')
    try:
        primary_api_keys = _H.resolve_primary_api_key_pool(
            primary_key,
            _H.os.environ.get('PAPER_ANALYZER_FALLBACK_API_KEYS', ''),
            _H.os.environ.get('PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY', ''),
        )
    except _H.LlmAccountPoolConfigError as exc:
        message = f'{context} 的 OpenCode Go 账号池配置非法: {exc}'
        if required:
            raise
        print(f'  ⚠️  {message}，跳过')
        return None
    if use_secondary:
        secondary_key = _H.os.environ.get('PAPER_ANALYZER_SECONDARY_API_KEY', '')
        api_key = secondary_key or primary_key
        endpoint = _H.os.environ.get('PAPER_ANALYZER_SECONDARY_ENDPOINT', '') or primary_endpoint
        model = _H.os.environ.get('PAPER_ANALYZER_SECONDARY_MODEL', '')
        secondary_fallback_keys = _H.os.environ.get(
            'PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS', ''
        )
        secondary_tertiary_fallback_key = _H.os.environ.get(
            'PAPER_ANALYZER_SECONDARY_TERTIARY_FALLBACK_API_KEY', ''
        )
        secondary_fallback_list = [
            value.strip()
            for raw in (secondary_fallback_keys, secondary_tertiary_fallback_key)
            for value in str(raw or '').split(',')
            if value.strip()
        ]
        if endpoint:
            try:
                _H.validate_publish_api_endpoint_url(endpoint)
            except ValueError as exc:
                message = f'{context} 的 LLM endpoint 配置不安全: {exc}'
                if required:
                    raise _H.PublishLLMUnavailable(message) from exc
                print(f'  ⚠️  {message}，跳过')
                return None
        try:
            primary_service = _H.normalize_opencode_go_service(primary_endpoint)
            secondary_service = _H.normalize_opencode_go_service(endpoint)
            same_opencode_service = (
                primary_service is not None
                and secondary_service is not None
                and primary_service == secondary_service
            )
            try:
                same_endpoint_service = (
                    _H._canonical_publish_service_endpoint(primary_endpoint)
                    == _H._canonical_publish_service_endpoint(endpoint)
                )
            except ValueError:
                same_endpoint_service = False
            if secondary_fallback_list:
                if not secondary_key and not same_opencode_service:
                    raise _H.LlmAccountPoolConfigError(
                        '副模型独立账号池跨服务使用时必须显式配置 '
                        'PAPER_ANALYZER_SECONDARY_API_KEY'
                    )
                api_keys = _H.resolve_api_key_pool(
                    secondary_key or primary_key, secondary_fallback_list
                )
            elif secondary_key:
                api_keys = [api_key]
            elif secondary_service is not None:
                if not same_opencode_service:
                    raise _H.LlmAccountPoolConfigError(
                        '主模型不是同一 OpenCode Go 服务，副模型必须显式配置 '
                        'PAPER_ANALYZER_SECONDARY_API_KEY'
                    )
                api_keys = primary_api_keys
            elif same_endpoint_service:
                # 非 Go 的副模型仅在规范化后的服务地址完全相同时复用主模型密钥，
                # 绝不继承主模型的备用账号池。
                api_keys = [api_key]
            else:
                raise _H.LlmAccountPoolConfigError(
                    '主副模型属于不同服务，副模型必须显式配置 '
                    'PAPER_ANALYZER_SECONDARY_API_KEY'
                )
        except _H.LlmAccountPoolConfigError as exc:
            message = f'{context} 的副模型 OpenCode Go 账号池配置非法: {exc}'
            if required:
                raise
            print(f'  ⚠️  {message}，跳过')
            return None
        config_names = (
            ('PAPER_ANALYZER_SECONDARY_API_KEY 或 PAPER_ANALYZER_API_KEY', api_key),
            ('PAPER_ANALYZER_SECONDARY_ENDPOINT 或 PAPER_ANALYZER_ENDPOINT', endpoint),
            ('PAPER_ANALYZER_SECONDARY_MODEL', model),
        )
    else:
        api_key = primary_key
        api_keys = primary_api_keys
        endpoint = primary_endpoint
        model = _H.os.environ.get('PAPER_ANALYZER_MODEL', '')
        config_names = (
            ('PAPER_ANALYZER_API_KEY', api_key),
            ('PAPER_ANALYZER_ENDPOINT', endpoint),
            ('PAPER_ANALYZER_MODEL', model),
        )

    missing = [
        name for name, value in config_names if not value
    ]
    if missing:
        message = f"未配置 {', '.join(missing)}，无法执行 {context}"
        if required:
            raise _H.PublishLLMUnavailable(message)
        print(f'  ⚠️  {message}，跳过')
        return None

    api_type = _H.detect_publish_api_type(endpoint, model)
    try:
        # 先检查服务地址，再构造包含访问密钥的请求头或请求对象。
        api_url = _H.build_publish_api_url(api_type, endpoint)
    except ValueError as exc:
        message = f'{context} 的 LLM endpoint 配置不安全: {exc}'
        if required:
            raise _H.PublishLLMUnavailable(message) from exc
        print(f'  ⚠️  {message}，跳过')
        return None
    last_error = None
    current_max_tokens = max(1, int(max_tokens))
    # 严格审查的响应只是很小的 JSON 对象。推理模型可能把预算全花在隐藏推理上，
    # 最后不返回正文；让这类调用反复增加到 16K 不会改善要求的响应格式，只会浪费配额。
    # 通用发布调用保持原有行为；结构化响应被隐藏推理耗尽预算时，仅允许一次恢复。
    # 恢复预算上限通常为 8K；调用方初始预算更大时，保留该更大上限。
    adaptive_max_tokens = (
        max(current_max_tokens, 8000) if structured_output else 16000
    )
    request_prompt = prompt
    structured_recovery_used = False
    for attempt in range(max_retries):
        started_at = _H.time.monotonic()
        retry_immediately = False
        try:
            print(
                f'  [publish-api] → {context} '
                f'(尝试 {attempt + 1}/{max_retries}, timeout={timeout}s, '
                f'prompt_chars={len(request_prompt)}, images={len(images or [])}, '
                f'max_tokens={current_max_tokens})'
            )
            stage_name = (usage_context or {}).get('stage') if isinstance(usage_context, dict) else None
            if not stage_name:
                try:
                    import llm_usage as _usage_mod
                    stage_name = (_usage_mod._SCOPE.get() or {}).get('stage')
                except Exception:
                    stage_name = None
            cache_key = (
                f"pd:{stage_name}:{re.sub(r'[^A-Za-z0-9._-]', '', str(model or ''))[:24]}"
                if stage_name else None
            )
            payload = _H.build_publish_payload(
                api_type, model, request_prompt, current_max_tokens, temperature,
                images=images, stage=stage_name, prompt_cache_key=cache_key,
            )
            # Muse Spark Contributor 有地区限制，必须使用项目 .env 的
            # HTTP CONNECT 代理。其他模型明确直连，避免误用这组代理设置。
            connect_timeout_cap = _H.get('PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS', 60.0)
            sse_idle_cap = _H.get('PUBLISH_LLM_SSE_IDLE_TIMEOUT_SECONDS', 180.0)
            stream_idle_timeout = (
                sse_idle_cap
                if (api_type == 'openai_responses' and payload.get('stream') is True)
                else None
            )
            if _H._publish_llm_requires_proxy(endpoint, model):
                proxy = _H.get_required_fetch_proxy()
                opener = _H.urllib.request.build_opener(
                    _H.urllib.request.ProxyHandler({'http': proxy, 'https': proxy}),
                    _H._KeepAliveHTTPHandler(
                        connect_timeout=connect_timeout_cap,
                        read_timeout=stream_idle_timeout,
                    ),
                    _H._KeepAliveHTTPSHandler(
                        connect_timeout=connect_timeout_cap,
                        read_timeout=stream_idle_timeout,
                    ),
                    _H._PublishLLMNoRedirectHandler(),
                )
                opener._pd_live_usage_sync_allowed = True
                opener._pd_live_usage_proxy = proxy
            else:
                opener = _H.urllib.request.build_opener(
                    _H.urllib.request.ProxyHandler({}),
                    _H._KeepAliveHTTPHandler(
                        connect_timeout=connect_timeout_cap,
                        read_timeout=stream_idle_timeout,
                    ),
                    _H._KeepAliveHTTPSHandler(
                        connect_timeout=connect_timeout_cap,
                        read_timeout=stream_idle_timeout,
                    ),
                    _H._PublishLLMNoRedirectHandler(),
                )
                opener._pd_live_usage_sync_allowed = True
                opener._pd_live_usage_proxy = _H.resolve_http_connect_proxy_url(_H.os.environ)
            with _H.with_llm_usage_context({**(usage_context or {}), 'transportAttempt': attempt + 1}):
                status, data = _H._open_publish_json_with_account_pool(
                    api_url=api_url,
                    endpoint=endpoint,
                    model=model,
                    api_type=api_type,
                    api_keys=api_keys,
                    payload=payload,
                    opener=opener,
                    timeout=timeout,
                    usage_sink=usage_sink,
                    usage_directory=usage_directory,
                )
            content = _H.parse_publish_response_text(api_type, data)
            reasoning_tokens = 0
            if api_type == 'anthropic':
                finish_reason = data.get('stop_reason')
                content_blocks = data.get('content') if isinstance(data.get('content'), list) else []
                reasoning_chars = sum(
                    len(str(block.get('thinking') or ''))
                    for block in content_blocks
                    if isinstance(block, dict)
                )
            elif api_type == 'openai_responses':
                finish_reason = (data.get('incomplete_details') or {}).get('reason')
                reasoning_chars = sum(
                    len(str(summary.get('text') or ''))
                    for item in data.get('output') or []
                    if isinstance(item, dict) and item.get('type') == 'reasoning'
                    for summary in item.get('summary') or []
                    if isinstance(summary, dict)
                )
                usage_obj = data.get('usage') if isinstance(data.get('usage'), dict) else {}
                output_details = usage_obj.get('output_tokens_details') if isinstance(usage_obj.get('output_tokens_details'), dict) else {}
                raw_reasoning_tokens = output_details.get('reasoning_tokens')
                if isinstance(raw_reasoning_tokens, int) and not isinstance(raw_reasoning_tokens, bool) and raw_reasoning_tokens > 0:
                    reasoning_tokens = raw_reasoning_tokens
            else:
                choice = (data.get('choices') or [{}])[0] or {}
                finish_reason = choice.get('finish_reason')
                message = choice.get('message') or {}
                reasoning_chars = len(str(message.get('reasoning_content') or ''))
                usage_obj = data.get('usage') if isinstance(data.get('usage'), dict) else {}
                comp_details = usage_obj.get('completion_tokens_details') if isinstance(usage_obj.get('completion_tokens_details'), dict) else {}
                raw_reasoning_tokens = comp_details.get('reasoning_tokens')
                if isinstance(raw_reasoning_tokens, int) and not isinstance(raw_reasoning_tokens, bool) and raw_reasoning_tokens > 0:
                    reasoning_tokens = raw_reasoning_tokens
            response_status = data.get('status') if api_type == 'openai_responses' else None
            # 兼容未提供终态的旧网关；明确返回的失败、未完成或截断状态
            # 必须先检查，即使正文看起来是完整 JSON，也不能当作成功。
            unsuccessful_status = (
                response_status is not None and response_status != 'completed'
            )
            if api_type in {'openai', 'openai_chat', 'anthropic'} and finish_reason is not None:
                successful_reasons = ('end_turn', 'stop_sequence') if api_type == 'anthropic' else ('stop',)
                unsuccessful_status = finish_reason not in successful_reasons
            output_truncated = finish_reason in {'length', 'max_tokens', 'max_output_tokens'}
            if content and not unsuccessful_status and not output_truncated:
                print(
                    f'  [publish-api] ✓ {context} | HTTP {status} | '
                    f'{_H.time.monotonic() - started_at:.1f}s | response_chars={len(content)} '
                    f'| max_tokens={current_max_tokens}'
                )
                return content
            finish_label = finish_reason or 'unknown'
            response_details = (
                f'status={response_status}, finish_reason={finish_label}'
                if response_status is not None else f'finish_reason={finish_label}'
            )
            if unsuccessful_status or output_truncated:
                last_error = RuntimeError(
                    f'模型响应没有正常完成，已拒绝使用正文（{response_details}）'
                )
            else:
                last_error = RuntimeError(
                    f'模型没有返回正文（{response_details}, reasoning_chars={reasoning_chars}）'
                )
            # 只有原始正文为空且确实耗尽输出预算，才沿用预算恢复。
            # 已拒绝的非空正文，以及失败或取消的响应，均不能按隐藏推理耗尽预算处理。
            can_recover_empty_output = (
                not content and output_truncated
                and (response_status is None or response_status == 'incomplete')
            )
            if can_recover_empty_output:
                if structured_output and (reasoning_chars > 0 or reasoning_tokens > 0):
                    if structured_recovery_used:
                        print(
                            f'  [publish-api] ⛔ {context} 结构化响应再次被隐藏推理耗尽，'
                            f'停止继续扩大输出预算 (max_tokens={current_max_tokens})'
                        )
                        break
                    structured_recovery_used = True
                    request_prompt = (
                        prompt
                        + '\n\n上一次请求将输出预算全部用于隐藏推理。'
                        + '请立即停止展开推理，只输出最终 JSON 对象，不得输出分析过程。'
                    )
                    next_max_tokens = min(current_max_tokens * 2, adaptive_max_tokens)
                    print(
                        f'  [publish-api] ↻ {context} 收紧为纯 JSON 后有界重试，'
                        f'max_tokens {current_max_tokens} → {next_max_tokens}'
                    )
                    current_max_tokens = next_max_tokens
                    retry_immediately = True
                elif current_max_tokens < adaptive_max_tokens:
                    next_max_tokens = min(current_max_tokens * 2, adaptive_max_tokens)
                    print(
                        f'  [publish-api] ↗ {context} 检测到输出被截断，'
                        f'max_tokens {current_max_tokens} → {next_max_tokens}'
                    )
                    current_max_tokens = next_max_tokens
        except _H.urllib.error.HTTPError as exc:
            detail = ''
            try:
                raw_detail, parsed_detail = _H._read_publish_http_error(exc)
                if raw_detail:
                    error_detail = parsed_detail.get('error') if isinstance(parsed_detail, dict) else None
                    if isinstance(error_detail, dict):
                        detail = str(error_detail.get('message') or error_detail.get('type') or '')
                    elif isinstance(error_detail, str):
                        detail = error_detail
                    else:
                        detail = raw_detail[:300]
                    detail = _H._sanitize_publish_llm_error(detail, api_keys)
            except (OSError, UnicodeError, ValueError, AttributeError):
                detail = ''
            last_error = exc
            suffix = f' | provider={detail[:300]}' if detail else ''
            print(
                f'  ⚠️  {context} 调用失败 (尝试 {attempt + 1}/{max_retries}, '
                f'{_H.time.monotonic() - started_at:.1f}s): HTTP {exc.code}{suffix}'
            )
            if isinstance(exc, _H._PublishLLMRedirectError):
                # An explicit redirect denial is terminal, not a transport retry.
                break
            if 400 <= exc.code < 500 and exc.code not in (401, 403, 408, 409, 425, 429):
                # Deterministic client payload/schema/resource errors will not succeed on identical retries;
                # keep bounded retry on non-Go 401/403 per redirect-security contract (Go 401 already aborts above).
                break
        except (
            _H.LlmUsagePersistenceError,
            _H.LlmAccountPoolExhaustedError,
            _H.LlmAccountAuthError,
            _H.LlmAccountPoolStateError,
            _H.LlmAccountPoolConfigError,
        ) as exc:
            last_error = exc
            print(f'  ⛔ {context} 已停止：{exc}')
            if getattr(exc, 'scope', None) == 'run':
                raise
            break
        except Exception as exc:
            last_error = exc
            print(
                f'  ⚠️  {context} 调用失败 (尝试 {attempt + 1}/{max_retries}, '
                f'{_H.time.monotonic() - started_at:.1f}s): '
                f'{_H._sanitize_publish_llm_error(exc, api_keys)}'
            )

        if attempt < max_retries - 1 and not retry_immediately:
            retry_after = None
            if isinstance(last_error, _H.urllib.error.HTTPError) and last_error.headers is not None:
                raw_retry_after = last_error.headers.get('Retry-After')
                try:
                    parsed_retry_after = float(raw_retry_after)
                    if math.isfinite(parsed_retry_after) and parsed_retry_after > 0:
                        retry_after = parsed_retry_after
                except (TypeError, ValueError):
                    retry_after = None
            # 格式错误或异常大的 Retry-After 不能把整批审查无限期卡住。正式审查重试
            # 仍保持有界，同时遵守服务端给出的正常等待建议。
            base_delay = min(retry_after if retry_after is not None else 2 ** attempt, 60.0)
            _H.time.sleep(max(0.0, base_delay) + _H.random.uniform(0.0, 0.5))

    if required:
        raise _H.PublishLLMUnavailable(
            f'{context} 连续失败: {_H._sanitize_publish_llm_error(last_error, api_keys)}'
        )
    return None
