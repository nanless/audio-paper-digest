#!/usr/bin/env python3
"""多模态博客审查安全取图、公网固定 IP 抓取与无网隔离 SVG 光栅化。"""

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

import base64
import hashlib
import http.client
import io
import ipaddress
import math
import os
import re
import socket
import stat
import sys
import time
import xml.etree.ElementTree as ET
from collections.abc import Mapping
from pathlib import Path
from urllib.parse import urljoin, urlparse

_SHARED_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SHARED_SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SHARED_SCRIPTS_DIR)

from project_env import get_required_fetch_proxy  # noqa: E402
from public_network_policy import (  # noqa: E402
    PublicNetworkPolicyError,
    canonicalize_ip,
    has_http_connect_proxy,
    is_globally_routable_ip,
    is_ip_literal,
    normalize_strict_url_hostname,
    select_validated_public_ip,
)
from publish_common import PublishDataValidationError  # noqa: E402

REVIEW_IMAGE_MIME_TYPES = {
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
}
REVIEW_IMAGE_MAX_BYTES = 8 * 1024 * 1024
REVIEW_IMAGE_MAX_EDGE = 4096
REVIEW_IMAGE_MAX_PIXELS = 16 * 1024 * 1024
REVIEW_IMAGE_DEADLINE_SECONDS = 120
_RASTER_RECOVERY_SOURCE_READ = object()
_IMAGE_REPO_SUFFIX_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}


def _hook(hooks: Mapping | None, name: str, default=None):
    if hooks is not None and name in hooks:
        return hooks[name]
    return default


def _is_noncanonical_ipv4_literal(hostname: str) -> bool:
    """识别会被底层 resolver 解释为 IPv4 的非规范字面量（hex/octal/整数/简写）。"""
    if not hostname:
        return False
    try:
        socket.inet_aton(hostname)
        return True
    except OSError:
        pass
    parts = hostname.split('.')
    if 1 <= len(parts) <= 4 and all(
        re.fullmatch(r'(?:0[xX][0-9a-fA-F]+|0[0-7]*|\d+)', part)
        for part in parts
    ):
        return True
    return False


def _normalize_idna_hostname(raw_hostname: str, err_cls) -> str:
    """将域名/IPv6 严格规范化为纯 ASCII，禁止 %、IDNA2003 非 STD3 字符与非法标签。"""
    hostname = normalize_strict_url_hostname(raw_hostname)
    if not hostname:
        raise err_cls(f'图片 URL 主机名非法: {raw_hostname}')
    return hostname


def validate_public_image_url(url: str, *, hooks: Mapping | None = None) -> set[str]:
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    ip_literal_fn = _hook(hooks, 'is_ip_literal', is_ip_literal)
    routable_fn = _hook(hooks, 'is_globally_routable_ip', is_globally_routable_ip)
    canonical_fn = _hook(hooks, 'canonicalize_ip', canonicalize_ip)
    proxy_check_fn = _hook(hooks, 'has_http_connect_proxy', has_http_connect_proxy)
    select_ip_fn = _hook(hooks, 'select_validated_public_ip', select_validated_public_ip)
    sock_mod = _hook(hooks, 'socket', socket)

    if not isinstance(url, str) or not url or re.search(r'[\x00-\x20\x7f\\]', url):
        raise err_cls('图片 review 只允许无认证信息的合法 HTTPS URL')
    try:
        parsed = urlparse(url)
        raw_hostname = parsed.hostname
        port = parsed.port
        username = parsed.username
        password = parsed.password
    except ValueError as exc:
        raise err_cls('图片 URL 格式或端口非法') from exc
    if (
        parsed.scheme != 'https'
        or not raw_hostname
        or username is not None
        or password is not None
        or '@' in (parsed.netloc or '')
    ):
        raise err_cls('图片 review 只允许无认证信息的 HTTPS URL')
    if port is not None and not (1 <= port <= 65535):
        raise err_cls('图片 URL 端口非法')
    hostname = _normalize_idna_hostname(raw_hostname, err_cls)
    if hostname == 'localhost' or hostname.endswith('.localhost') or hostname.endswith('.local'):
        raise err_cls('图片 review 拒绝本地主机 URL')
    try:
        if ip_literal_fn(hostname) or ':' in hostname or '%' in hostname:
            if not routable_fn(hostname):
                raise err_cls(f'图片 URL 解析到非公网地址: {hostname}')
            return {canonical_fn(hostname)}
        if _is_noncanonical_ipv4_literal(hostname):
            raise err_cls(f'图片 URL 解析到非公网地址（拒绝非规范 IPv4 字面量）: {hostname}')
    except PublicNetworkPolicyError as exc:
        if str(getattr(exc, 'code', '')).startswith('PUBLIC_NETWORK_POLICY_'):
            raise err_cls(f'公网安全策略异常: {exc}') from exc
        raise err_cls(f'图片 URL 解析到非公网地址: {hostname}') from exc
    try:
        addresses = [item[4][0] for item in sock_mod.getaddrinfo(hostname, None)]
    except sock_mod.gaierror as exc:
        raise err_cls(f'图片域名无法解析: {hostname}') from exc
    # 与 Node `lib/public-network-policy.js` 共用 `config/public-network-policy.json`：
    # 仅在配置了合法 HTTP(S) CONNECT 代理且整组解析记录都落在保留 Fake-IP 段时放行合成地址；
    # 混入任何真实私网地址或公网与 Fake-IP 混杂均立即拒绝。
    proxy_enabled = proxy_check_fn()
    try:
        selected = select_ip_fn(addresses, proxy_enabled=proxy_enabled)
    except PublicNetworkPolicyError as exc:
        if str(getattr(exc, 'code', '')).startswith('PUBLIC_NETWORK_POLICY_'):
            raise err_cls(f'公网安全策略异常: {exc}') from exc
        detail = exc.offending_ip or hostname
        raise err_cls(f'图片 URL 解析到非公网地址: {detail}') from exc
    return set(selected['addresses'])


def response_peer_ip(response, *, hooks: Mapping | None = None) -> str:
    """从 requests/urllib3 取出已连接的对端，不再重复依赖 DNS 结果。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    raw = getattr(response, 'raw', None)
    candidates = [
        getattr(getattr(response, '_connection', None), 'sock', None),
        getattr(getattr(response, 'connection', None), 'sock', None),
        getattr(getattr(raw, '_connection', None), 'sock', None),
        getattr(getattr(raw, 'connection', None), 'sock', None),
    ]
    original = getattr(raw, '_original_response', None)
    try:
        candidates.append(original.fp.raw._sock)
    except AttributeError:
        pass
    for sock in candidates:
        if sock is None:
            continue
        try:
            return str(ipaddress.ip_address(sock.getpeername()[0].split('%', 1)[0]))
        except (AttributeError, OSError, TypeError, ValueError):
            continue
    raise err_cls('无法验证图片 HTTPS 连接的实际 peer IP')


def resolve_proxy_addresses(proxy: str, *, hooks: Mapping | None = None) -> set[str]:
    """解析显式配置的 CONNECT 代理，它是受信任的传输跳点。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    sock_mod = _hook(hooks, 'socket', socket)
    if not isinstance(proxy, str) or not proxy or re.search(r'[\x00-\x20\x7f\\]', proxy):
        raise err_cls('图片 review 代理必须是 HTTP CONNECT 地址')
    if not re.match(r'^https?://[^/?#]', proxy, re.IGNORECASE):
        raise err_cls('图片 review 代理必须是 HTTP CONNECT 地址')
    try:
        parsed = urlparse(proxy)
        port = parsed.port
    except ValueError as exc:
        raise err_cls('图片 review 代理必须是合法的 HTTP CONNECT 地址') from exc
    if parsed.scheme not in {'http', 'https'} or not parsed.hostname or (port is not None and not (1 <= port <= 65535)):
        raise err_cls('图片 review 代理必须是 HTTP CONNECT 地址')
    hostname = normalize_strict_url_hostname(parsed.hostname)
    if not hostname:
        raise err_cls(f'图片 review 代理主机名非法: {parsed.hostname}')
    try:
        return {
            str(ipaddress.ip_address(item[4][0].split('%', 1)[0]))
            for item in sock_mod.getaddrinfo(hostname, port or (443 if parsed.scheme == 'https' else 80))
        }
    except sock_mod.gaierror as exc:
        raise err_cls(f'图片 review 代理无法解析: {hostname}') from exc


def bounded_positive_seconds(
    env_name: str, default: int, minimum: int, maximum: int, *, hooks: Mapping | None = None,
) -> int:
    os_mod = _hook(hooks, 'os', os)
    raw = str(os_mod.environ.get(env_name, default)).strip()
    try:
        value = int(raw)
    except ValueError:
        value = default
    return min(maximum, max(minimum, value))


def remaining_deadline_seconds(deadline: float, label: str, *, hooks: Mapping | None = None) -> float:
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    time_mod = _hook(hooks, 'time', time)
    remaining = deadline - time_mod.monotonic()
    if remaining <= 0:
        raise err_cls(f'{label}超过绝对截止时间')
    return remaining


def pinned_https_url(parsed, address: str) -> str:
    """只替换传输层 authority；Host 和 TLS SNI 保持原样。"""
    normalized = str(ipaddress.ip_address(address))
    host = f'[{normalized}]' if ':' in normalized else normalized
    if parsed.port and parsed.port != 443:
        host = f'{host}:{parsed.port}'
    return parsed._replace(netloc=host).geturl()


def read_pinned_review_image(
    current: str,
    resolved_addresses,
    proxy: str,
    proxy_addresses,
    deadline: float,
    target_address: str | None = None,
    *,
    hooks: Mapping | None = None,
) -> dict:
    """经 CONNECT 取一跳 HTTPS，并固定到预先校验过的公网 IP。"""
    import urllib3

    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    pinned_url_fn = _hook(hooks, '_pinned_https_url', pinned_https_url)
    deadline_fn = _hook(
        hooks, '_remaining_deadline_seconds',
        lambda dl, lbl: remaining_deadline_seconds(dl, lbl, hooks=hooks),
    )
    validate_peer_fn = _hook(
        hooks, '_validate_response_peer_with_transport',
        lambda resp, addrs, p_addrs=None: validate_response_peer_with_transport(
            resp, addrs, p_addrs, hooks=hooks,
        ),
    )
    mime_types = _hook(hooks, 'REVIEW_IMAGE_MIME_TYPES', REVIEW_IMAGE_MIME_TYPES)
    max_bytes = _hook(hooks, 'REVIEW_IMAGE_MAX_BYTES', REVIEW_IMAGE_MAX_BYTES)

    parsed = urlparse(current)
    target_address = target_address or sorted(
        resolved_addresses,
        key=lambda value: (ipaddress.ip_address(value).version, value),
    )[0]
    pinned_url = pinned_url_fn(parsed, target_address)
    raw_hostname = parsed.hostname or ''
    hostname = _normalize_idna_hostname(raw_hostname, err_cls)
    host_header = parsed.netloc
    if not host_header.isascii():
        host_header = f'[{hostname}]' if ':' in hostname else hostname
        if parsed.port is not None:
            host_header = f'{host_header}:{parsed.port}'
    manager = urllib3.ProxyManager(
        proxy,
        cert_reqs='CERT_REQUIRED',
        assert_hostname=hostname,
        server_hostname=hostname,
        retries=False,
    )
    response = None
    try:
        remaining = deadline_fn(deadline, '图片下载')
        response = manager.request(
            'GET',
            pinned_url,
            headers={
                'Host': host_header,
                'User-Agent': 'audio-paper-digest/1.0',
            },
            redirect=False,
            preload_content=False,
            retries=False,
            timeout=urllib3.Timeout(connect=min(30.0, remaining), read=min(30.0, remaining)),
        )
        validate_peer_fn(
            response, resolved_addresses, proxy_addresses,
        )
        status = int(response.status or 0)
        headers = response.headers
        if status in {301, 302, 303, 307, 308}:
            return {
                'status': status,
                'location': headers.get('Location'),
                'media_type': '',
                'raw': b'',
                'pinned_address': target_address,
            }
        if status < 200 or status >= 300:
            raise err_cls(f'图片下载 HTTP {status}')
        media_type = str(headers.get('Content-Type') or '').split(';', 1)[0].strip().lower()
        if media_type not in mime_types:
            raise err_cls(f'图片 MIME 不受支持: {media_type or "unknown"}')
        declared_size = headers.get('Content-Length')
        if declared_size:
            try:
                if int(declared_size) > max_bytes:
                    raise err_cls('图片超过 8 MiB review 上限')
            except ValueError as exc:
                raise err_cls('图片 Content-Length 非法') from exc
        chunks = []
        size = 0
        while True:
            remaining = deadline_fn(deadline, '图片下载')
            connection = getattr(response, 'connection', None) \
                or getattr(response, '_connection', None)
            sock = getattr(connection, 'sock', None)
            if sock is not None:
                sock.settimeout(min(30.0, remaining))
            chunk = response.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                raise err_cls('图片超过 8 MiB review 上限')
            chunks.append(chunk)
        return {
            'status': status,
            'location': None,
            'media_type': media_type,
            'raw': b''.join(chunks),
            'pinned_address': target_address,
        }
    finally:
        if response is not None:
            response.close()
            response.release_conn()
        manager.clear()


def validate_response_peer_with_transport(
    response, resolved_addresses, proxy_addresses=None, *, hooks: Mapping | None = None,
) -> str:
    """校验传输层对端；代理地址必须由调用方显式传入。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    peer_ip_fn = _hook(
        hooks, '_response_peer_ip',
        lambda resp: response_peer_ip(resp, hooks=hooks),
    )
    routable_fn = _hook(hooks, 'is_globally_routable_ip', is_globally_routable_ip)
    canonical_fn = _hook(hooks, 'canonicalize_ip', canonicalize_ip)

    peer = peer_ip_fn(response)
    if proxy_addresses is not None:
        if peer not in proxy_addresses:
            raise err_cls(
                f'图片 HTTPS 连接未命中已配置代理 peer: {peer}'
            )
        return peer
    try:
        if not routable_fn(peer):
            raise err_cls(f'图片 HTTPS 连接命中非公网 peer: {peer}')
        canonical_peer = canonical_fn(peer)
    except PublicNetworkPolicyError as exc:
        if str(getattr(exc, 'code', '')).startswith('PUBLIC_NETWORK_POLICY_'):
            raise err_cls(f'公网安全策略异常: {exc}') from exc
        raise err_cls(f'图片 HTTPS 连接命中非公网 peer: {peer}') from exc
    if canonical_peer not in resolved_addresses:
        raise err_cls(
            f'图片 HTTPS peer {canonical_peer} 不在预先验证的 DNS 解析结果中，疑似 DNS rebinding'
        )
    return canonical_peer


def download_review_image(
    url: str, *, _recovery_source_read=None, hooks: Mapping | None = None,
) -> dict:
    """经 CONNECT 下载，并固定到本地预先校验过的公网 IP。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    proxy_fn = _hook(hooks, 'get_required_fetch_proxy', get_required_fetch_proxy)
    resolve_proxy_fn = _hook(
        hooks, '_resolve_proxy_addresses',
        lambda p: resolve_proxy_addresses(p, hooks=hooks),
    )
    bounded_fn = _hook(
        hooks, '_bounded_positive_seconds',
        lambda name, default, lo, hi: bounded_positive_seconds(name, default, lo, hi, hooks=hooks),
    )
    default_deadline = _hook(hooks, 'REVIEW_IMAGE_DEADLINE_SECONDS', REVIEW_IMAGE_DEADLINE_SECONDS)
    time_mod = _hook(hooks, 'time', time)
    validate_url_fn = _hook(
        hooks, '_validate_public_image_url',
        lambda u: validate_public_image_url(u, hooks=hooks),
    )
    read_pinned_fn = _hook(
        hooks, '_read_pinned_review_image',
        lambda cur, addrs, prx, p_addrs, dl, target_address=None: read_pinned_review_image(
            cur, addrs, prx, p_addrs, dl, target_address=target_address, hooks=hooks,
        ),
    )
    validate_sig_fn = _hook(
        hooks, '_validate_image_signature',
        lambda mt, rw: validate_image_signature(mt, rw, hooks=hooks),
    )
    rasterize_svg_fn = _hook(
        hooks, '_rasterize_svg_for_review',
        lambda rw: rasterize_svg_for_review(rw, hooks=hooks),
    )
    prepare_raster_fn = _hook(
        hooks, '_prepare_raster_for_review',
        lambda mt, rw: prepare_raster_for_review(mt, rw, hooks=hooks),
    )
    recovery_sentinel = _hook(hooks, '_RASTER_RECOVERY_SOURCE_READ', _RASTER_RECOVERY_SOURCE_READ)

    proxy = proxy_fn()
    proxy_addresses = resolve_proxy_fn(proxy)
    deadline_seconds = bounded_fn(
        'PD_BLOG_IMAGE_REVIEW_DEADLINE_SECONDS',
        default_deadline, 10, 300,
    )
    deadline = time_mod.monotonic() + deadline_seconds
    try:
        current = url
        for _redirect in range(4):
            resolved_addresses = validate_url_fn(current)
            result = None
            transient_error = None
            candidate_addresses = sorted(
                resolved_addresses,
                key=lambda value: (ipaddress.ip_address(value).version, value),
            )
            for target_address in candidate_addresses:
                for transport_attempt in range(4):
                    try:
                        result = read_pinned_fn(
                            current, resolved_addresses, proxy, proxy_addresses, deadline,
                            target_address=target_address,
                        )
                        break
                    except Exception as exc:
                        import urllib3
                        if isinstance(exc, (OSError, http.client.HTTPException, urllib3.exceptions.HTTPError)):
                            transient_error = exc
                            if transport_attempt < 3 and time_mod.monotonic() < deadline:
                                time_mod.sleep(0.5 * (transport_attempt + 1))
                                continue
                            break
                        raise
                if result is not None:
                    break
            if result is None:
                if transient_error is not None:
                    raise transient_error
                raise err_cls('图片下载没有可用的已校验地址')
            if result['status'] in {301, 302, 303, 307, 308}:
                location = result['location']
                if not location:
                    raise err_cls('图片重定向缺少 Location')
                current = urljoin(current, location)
                continue
            raw = result['raw']
            media_type = result['media_type']
            validate_sig_fn(media_type, raw)
            if _recovery_source_read is recovery_sentinel:
                if media_type != 'image/png':
                    raise err_cls('显式坏 PNG 恢复只接受原 PNG MIME。')
                return {'media_type': media_type, 'raw': raw}
            if media_type == 'image/svg+xml':
                raw = rasterize_svg_fn(raw)
                media_type = 'image/png'
            media_type, raw = prepare_raster_fn(media_type, raw)
            return {
                'media_type': media_type,
                'data': base64.b64encode(raw).decode('ascii'),
            }
        raise err_cls('图片重定向次数过多')
    except err_cls:
        raise
    except Exception as exc:
        try:
            import urllib3.exceptions as _urllib3_exc
            is_urllib3_http_error = isinstance(exc, _urllib3_exc.HTTPError)
        except ImportError:
            is_urllib3_http_error = False
        if isinstance(exc, (OSError, ValueError, http.client.HTTPException)) or is_urllib3_http_error:
            raise err_cls(f'图片下载失败: {exc}') from exc
        raise


def sanitize_svg_xml_for_review(raw: bytes) -> bytes:
    """只从可信的 arXiv SVG 里删掉 XML 非法的字符引用。"""
    text = raw.decode('utf-8-sig')

    def replace_reference(match):
        token = match.group(1)
        try:
            codepoint = int(token[1:], 16) if token[:1].lower() == 'x' else int(token)
        except ValueError:
            return ''
        valid = (
            codepoint in (0x9, 0xA, 0xD)
            or 0x20 <= codepoint <= 0xD7FF
            or 0xE000 <= codepoint <= 0xFFFD
            or 0x10000 <= codepoint <= 0x10FFFF
        )
        return match.group(0) if valid else ''

    text = re.sub(r'&#(x[0-9A-Fa-f]+|[0-9]+);', replace_reference, text)
    return text.encode('utf-8')


def validate_image_signature(media_type: str, raw: bytes, *, hooks: Mapping | None = None) -> None:
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    sanitize_fn = _hook(hooks, '_sanitize_svg_xml_for_review', sanitize_svg_xml_for_review)

    svg_signature = False
    if media_type == 'image/svg+xml' and raw:
        try:
            import xml.etree.ElementTree as element_tree
            root = element_tree.fromstring(sanitize_fn(raw))
            svg_signature = root.tag.rsplit('}', 1)[-1].lower() == 'svg'
        except (UnicodeDecodeError, element_tree.ParseError):
            svg_signature = False
    signatures = {
        'image/jpeg': raw.startswith(b'\xff\xd8\xff'),
        'image/png': raw.startswith(b'\x89PNG\r\n\x1a\n'),
        'image/gif': raw.startswith((b'GIF87a', b'GIF89a')),
        'image/webp': len(raw) >= 12 and raw.startswith(b'RIFF') and raw[8:12] == b'WEBP',
        'image/svg+xml': svg_signature,
    }
    if not raw:
        raise err_cls('图片内容为空')
    if not signatures.get(media_type, False):
        raise err_cls(f'图片内容与 MIME 签名不一致: {media_type}')


def prepare_raster_for_review(
    media_type: str, raw: bytes, *, hooks: Mapping | None = None,
) -> tuple[str, bytes]:
    """在把字节发给审查方之前，先限制解码后的位图尺寸。"""
    if media_type == 'image/svg+xml':
        return media_type, raw
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    max_edge = _hook(hooks, 'REVIEW_IMAGE_MAX_EDGE', REVIEW_IMAGE_MAX_EDGE)
    max_pixels = _hook(hooks, 'REVIEW_IMAGE_MAX_PIXELS', REVIEW_IMAGE_MAX_PIXELS)
    max_bytes = _hook(hooks, 'REVIEW_IMAGE_MAX_BYTES', REVIEW_IMAGE_MAX_BYTES)
    validate_sig_fn = _hook(
        hooks, '_validate_image_signature',
        lambda mt, rw: validate_image_signature(mt, rw, hooks=hooks),
    )

    try:
        from PIL import Image, ImageOps
        with Image.open(io.BytesIO(raw)) as source:
            width, height = source.size
            if width <= 0 or height <= 0:
                raise err_cls('图片像素尺寸非法')
            if max(width, height) <= max_edge and width * height <= max_pixels:
                rgba = source.convert('RGBA')
                if rgba.getchannel('A').getextrema()[0] == 255:
                    return media_type, raw
                # 用和读者页面相同的白色底来审查。否则一张带黑字的
                # 透明 PNG，在模型把透明通道解码成黑色时会看起来是一片空白。
                background = Image.new('RGB', rgba.size, 'white')
                background.paste(rgba, mask=rgba.getchannel('A'))
                output = io.BytesIO()
                background.save(output, format='PNG')
                prepared = output.getvalue()
                if len(prepared) <= max_bytes:
                    validate_sig_fn('image/png', prepared)
                    return 'image/png', prepared
            scale = min(
                max_edge / width,
                max_edge / height,
                math.sqrt(max_pixels / (width * height)),
            )
            target = (
                max(1, int(width * scale)),
                max(1, int(height * scale)),
            )
            image = ImageOps.exif_transpose(source).convert('RGBA')
            image.thumbnail(target, Image.Resampling.LANCZOS)
            background = Image.new('RGB', image.size, 'white')
            background.paste(image, mask=image.getchannel('A'))
            # 优先无损 PNG 保留学术图表中的细线与小字标注；仅当超过 8 MiB 上限时降级为渐进式 JPEG。
            png_output = io.BytesIO()
            background.save(png_output, format='PNG', optimize=True)
            prepared_png = png_output.getvalue()
            if len(prepared_png) <= max_bytes:
                validate_sig_fn('image/png', prepared_png)
                return 'image/png', prepared_png
            for quality in (90, 82, 74):
                output = io.BytesIO()
                background.save(
                    output, format='JPEG', quality=quality,
                    optimize=True, progressive=True,
                )
                prepared = output.getvalue()
                if len(prepared) <= max_bytes:
                    validate_sig_fn('image/jpeg', prepared)
                    return 'image/jpeg', prepared
    except err_cls:
        raise
    except Exception as exc:
        raise err_cls(f'图片审查降采样失败: {exc}') from exc
    raise err_cls('图片审查降采样结果超过 8 MiB')


def rasterize_svg_for_review(raw: bytes, *, hooks: Mapping | None = None) -> bytes:
    """在隔离且禁网的浏览器页面里栅格化不受信任的 SVG。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    max_bytes = _hook(hooks, 'REVIEW_IMAGE_MAX_BYTES', REVIEW_IMAGE_MAX_BYTES)
    sanitize_fn = _hook(hooks, '_sanitize_svg_xml_for_review', sanitize_svg_xml_for_review)
    validate_sig_fn = _hook(
        hooks, '_validate_image_signature',
        lambda mt, rw: validate_image_signature(mt, rw, hooks=hooks),
    )

    if not raw or len(raw) > max_bytes:
        raise err_cls('SVG 为空或超过 8 MiB review 上限')
    raw = sanitize_fn(raw)
    validate_sig_fn('image/svg+xml', raw)
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise err_cls('SVG 不是 UTF-8') from exc
    if re.search(r'<!DOCTYPE|<!ENTITY|<\s*(?:[A-Za-z_][\w.-]*:)?(?:script|iframe|object|embed)\b',
                 text, flags=re.IGNORECASE) \
            or re.search(r'\bon[a-z]+\s*=', text, flags=re.IGNORECASE) \
            or re.search(r'(?:href|src)\s*=\s*["\']\s*(?:https?:|file:|//)',
                         text, flags=re.IGNORECASE) \
            or re.search(r'url\(\s*["\']?\s*(?:https?:|file:|//)',
                         text, flags=re.IGNORECASE):
        raise err_cls('SVG 含脚本、实体、嵌入对象或外部资源')
    try:
        parsed_svg_root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise err_cls('SVG XML 解析失败') from exc
    has_foreign_object = False
    for elem in parsed_svg_root.iter():
        local_name = elem.tag.split('}')[-1].lower() if isinstance(elem.tag, str) else ''
        if local_name in {'script', 'iframe', 'object', 'embed'}:
            raise err_cls('SVG 含脚本、实体、嵌入对象或外部资源')
        if local_name == 'foreignobject':
            has_foreign_object = True
    if has_foreign_object:
        # 与 reader_inline_svg 统一安全策略：仅放行通过静态白名单校验的 LaTeXML foreignObject，
        # 并在离线禁脚本 HTML5 文档中内联渲染，避免 <img> XML 解析丢失 XHTML/MathML 命名空间或被 <br> 中断。
        try:
            import reader_inline_svg as _inline_svg
            validated_text = _inline_svg.validate_svg(raw)
            inline_markup = _inline_svg._serialize_validated_svg(ET.fromstring(validated_text))
        except Exception as exc:
            raise err_cls('SVG 含脚本、实体、嵌入对象或外部资源') from exc
        has_viewbox = any(str(k).lower() == 'viewbox' for k in parsed_svg_root.attrib)
        svg_height_rule = ';height:auto' if has_viewbox else ''
        html = (
            '<!doctype html><meta charset="utf-8">'
            '<style>html,body{margin:0;background:#fff}body{display:flex;align-items:flex-start;'
            'justify-content:flex-start}#pd-review-figure{display:inline-block;max-width:1600px;max-height:1200px}'
            f'#pd-review-figure>svg{{display:block;max-width:1600px;max-height:1200px{svg_height_rule}}}</style>'
            f'<div id="pd-review-figure">{inline_markup}</div>'
        )
    else:
        encoded_svg = base64.b64encode(raw).decode('ascii')
        html = (
            '<!doctype html><meta charset="utf-8">'
            '<style>html,body{margin:0;background:#fff}body{display:flex;align-items:flex-start;'
            'justify-content:flex-start}#pd-review-figure{display:block;max-width:1600px;max-height:1200px}</style>'
            f'<img id="pd-review-figure" alt="review figure" src="data:image/svg+xml;base64,{encoded_svg}">'
        )
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            launch_options: dict = {'headless': True}
            expected_executable = Path(playwright.chromium.executable_path)
            if not expected_executable.is_file():
                cache_roots = [
                    Path.home() / 'Library' / 'Caches' / 'ms-playwright',
                    Path.home() / '.cache' / 'ms-playwright',
                ]
                candidates = []
                for cache_root in cache_roots:
                    if cache_root.is_symlink() or not cache_root.is_dir():
                        continue
                    for pattern in (
                        'chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell',
                        'chromium_headless_shell-*/chrome-headless-shell-*/headless_shell',
                    ):
                        for candidate in cache_root.glob(pattern):
                            resolved = candidate.resolve()
                            try:
                                resolved.relative_to(cache_root.resolve())
                            except ValueError:
                                continue
                            if candidate.is_symlink() or not resolved.is_file() \
                                    or not os.access(resolved, os.X_OK):
                                continue
                            candidates.append(resolved)
                if candidates:
                    launch_options['executable_path'] = str(sorted(candidates)[-1])
            browser = playwright.chromium.launch(**launch_options)
            try:
                context = browser.new_context(
                    viewport={'width': 1600, 'height': 1200},
                    java_script_enabled=False,
                    offline=True,
                )
                page = context.new_page()
                page.route('**/*', lambda route: route.abort())
                page.set_content(html, wait_until='load', timeout=30_000)
                locator = page.locator('body > #pd-review-figure')
                box = locator.bounding_box()
                scale = 1
                if box and box.get('width', 0) > 0 and box.get('height', 0) > 0:
                    max_side = max(box['width'], box['height'])
                    min_side = min(box['width'], box['height'])
                    if max_side < 800:
                        scale = min(
                            3,
                            max(1, int(1600 // box['width'])),
                            max(1, int(1200 // box['height'])),
                        )
                    elif min_side < 320 and (max_side / min_side) >= 3.0:
                        # 极窄长横幅架构图（如 1200x240）用 2x HiDPI 避免小字模糊。
                        scale = 2
                if scale > 1:
                    context.close()
                    context = browser.new_context(
                        viewport={'width': 1600, 'height': 1200},
                        device_scale_factor=scale,
                        java_script_enabled=False,
                        offline=True,
                    )
                    page = context.new_page()
                    page.route('**/*', lambda route: route.abort())
                    page.set_content(html, wait_until='load', timeout=30_000)
                    locator = page.locator('body > #pd-review-figure')
                png = locator.screenshot(
                    type='png', animations='disabled', timeout=30_000,
                )
            finally:
                browser.close()
    except Exception as exc:
        raise err_cls(f'SVG 安全栅格化失败: {exc}') from exc
    if not png or len(png) > max_bytes:
        raise err_cls('SVG 栅格化结果为空或超过 8 MiB')
    validate_sig_fn('image/png', png)
    return png


def open_review_image_under_directory(
    image_repo, relative: str, *, hooks: Mapping | None = None,
) -> int:
    """沿已打开的目录逐层读取；内部目录被换成链接时不跟随该链接。"""
    os_mod = _hook(hooks, 'os', os)
    directories = []
    directory_flags = os_mod.O_RDONLY | os_mod.O_DIRECTORY | os_mod.O_NOFOLLOW | os_mod.O_NONBLOCK
    try:
        directories.append(os_mod.open(image_repo, directory_flags))
        for component in relative.split('/')[:-1]:
            directories.append(os_mod.open(component, directory_flags, dir_fd=directories[-1]))
        return os_mod.open(
            relative.split('/')[-1],
            os_mod.O_RDONLY | os_mod.O_NONBLOCK | os_mod.O_NOFOLLOW,
            dir_fd=directories[-1],
        )
    finally:
        for descriptor in reversed(directories):
            os_mod.close(descriptor)


def load_review_image_from_local_repo(
    url: str, *, expected_source_sha256: str | None = None, hooks: Mapping | None = None,
) -> dict | None:
    """从本地工作树里读取我们自己推送前的图片仓库 URL。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    os_mod = _hook(hooks, 'os', os)
    path_cls = _hook(hooks, 'Path', Path)
    suffix_mime = _hook(hooks, '_IMAGE_REPO_SUFFIX_MIME', _IMAGE_REPO_SUFFIX_MIME)
    mime_types = _hook(hooks, 'REVIEW_IMAGE_MIME_TYPES', REVIEW_IMAGE_MIME_TYPES)
    max_bytes = _hook(hooks, 'REVIEW_IMAGE_MAX_BYTES', REVIEW_IMAGE_MAX_BYTES)
    open_under_dir_fn = _hook(
        hooks, '_open_review_image_under_directory',
        lambda repo, rel: open_review_image_under_directory(repo, rel, hooks=hooks),
    )
    validate_sig_fn = _hook(
        hooks, '_validate_image_signature',
        lambda mt, rw: validate_image_signature(mt, rw, hooks=hooks),
    )
    rasterize_svg_fn = _hook(
        hooks, '_rasterize_svg_for_review',
        lambda rw: rasterize_svg_for_review(rw, hooks=hooks),
    )
    prepare_raster_fn = _hook(
        hooks, '_prepare_raster_for_review',
        lambda mt, rw: prepare_raster_for_review(mt, rw, hooks=hooks),
    )

    image_base_url = os_mod.environ.get(
        'PAPER_DIGEST_IMAGE_BASE_URL',
        'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main',
    ).rstrip('/')
    if not re.fullmatch(
        r'https://raw\.githubusercontent\.com/[^/?#]+/[^/?#]+/main',
        image_base_url,
    ):
        return None
    prefix = image_base_url + '/'
    if not url.startswith(prefix):
        return None
    relative = url[len(prefix):]
    if not relative or '?' in relative or '#' in relative:
        return None
    image_repo = path_cls(
        os_mod.environ.get(
            'PAPER_DIGEST_IMAGE_REPO',
            str(path_cls.home() / 'code' / 'github_repos' / 'audio-paper-digest-images'),
        )
    ).expanduser().resolve()
    target = image_repo / relative
    if any(part in ('', '.', '..') for part in relative.split('/')):
        return None
    node = target
    while node != image_repo:
        if node.is_symlink():
            return None
        node = node.parent
    if not target.is_file():
        return None
    media_type = suffix_mime.get(target.suffix.lower())
    if media_type not in mime_types:
        return None
    try:
        descriptor = open_under_dir_fn(image_repo, relative)
    except OSError:
        return None
    with os_mod.fdopen(descriptor, 'rb') as source:
        info = os_mod.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            return None
        if info.st_size > max_bytes:
            raise err_cls('本地图片仓图片为空或超过 8 MiB review 上限')
        raw = source.read(max_bytes + 1)
    if not raw or len(raw) > max_bytes:
        raise err_cls('本地图片仓图片为空或超过 8 MiB review 上限')
    if expected_source_sha256 is not None and hashlib.sha256(raw).hexdigest() != expected_source_sha256:
        raise err_cls('受控出版展示 PNG 与真实 Node 重放的像素 SHA 不一致')
    validate_sig_fn(media_type, raw)
    if media_type == 'image/svg+xml':
        raw = rasterize_svg_fn(raw)
        media_type = 'image/png'
    media_type, raw = prepare_raster_fn(media_type, raw)
    return {'media_type': media_type, 'data': base64.b64encode(raw).decode('ascii')}


def load_review_image(
    url: str, *, expected_source_sha256: str | None = None, hooks: Mapping | None = None,
) -> dict:
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    os_mod = _hook(hooks, 'os', os)
    path_cls = _hook(hooks, 'Path', Path)
    mime_types = _hook(hooks, 'REVIEW_IMAGE_MIME_TYPES', REVIEW_IMAGE_MIME_TYPES)
    max_bytes = _hook(hooks, 'REVIEW_IMAGE_MAX_BYTES', REVIEW_IMAGE_MAX_BYTES)
    open_under_dir_fn = _hook(
        hooks, '_open_review_image_under_directory',
        lambda repo_dir, rel_path: open_review_image_under_directory(repo_dir, rel_path, hooks=hooks),
    )
    local_repo_fn = _hook(
        hooks, '_load_review_image_from_local_repo',
        lambda u, expected_source_sha256=None: load_review_image_from_local_repo(
            u, expected_source_sha256=expected_source_sha256, hooks=hooks,
        ),
    )
    download_fn = _hook(
        hooks, '_download_review_image',
        lambda u: download_review_image(u, hooks=hooks),
    )
    validate_sig_fn = _hook(
        hooks, '_validate_image_signature',
        lambda mt, rw: validate_image_signature(mt, rw, hooks=hooks),
    )
    rasterize_svg_fn = _hook(
        hooks, '_rasterize_svg_for_review',
        lambda rw: rasterize_svg_for_review(rw, hooks=hooks),
    )
    prepare_raster_fn = _hook(
        hooks, '_prepare_raster_for_review',
        lambda mt, rw: prepare_raster_for_review(mt, rw, hooks=hooks),
    )

    if expected_source_sha256 is not None:
        if not re.fullmatch(r'[a-f0-9]{64}', str(expected_source_sha256)) or not url.startswith('https://'):
            raise err_cls('受控出版展示只允许已绑定的规范 HTTPS 图床资产')
        payload = local_repo_fn(url, expected_source_sha256=expected_source_sha256)
        if payload is None:
            raise err_cls('受控出版展示缺少本地真实资产，拒绝回退到旧远端像素')
        return payload
    if url.startswith('data:'):
        match = re.fullmatch(r'data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)', url)
        if not match:
            raise err_cls('图片 data URI 必须是合法 base64')
        media_type = match.group(1).lower()
        if media_type not in mime_types:
            raise err_cls(f'图片 MIME 不受支持: {media_type}')
        try:
            encoded = re.sub(r'\s+', '', match.group(2))
            raw = base64.b64decode(encoded, validate=True)
        except ValueError as exc:
            raise err_cls('图片 data URI base64 非法') from exc
        if not raw or len(raw) > max_bytes:
            raise err_cls('图片 data URI 为空或超过 8 MiB')
        validate_sig_fn(media_type, raw)
        if media_type == 'image/svg+xml':
            raw = rasterize_svg_fn(raw)
            media_type = 'image/png'
        media_type, raw = prepare_raster_fn(media_type, raw)
        return {'media_type': media_type, 'data': base64.b64encode(raw).decode('ascii')}
    if url.startswith('https://'):
        local_payload = local_repo_fn(url)
        if local_payload is not None:
            return local_payload
        return download_fn(url)
    raw_base_path = _hook(hooks, 'BASE_PATH')
    raw_blog_base_path = _hook(hooks, 'BLOG_BASE_PATH')
    init_base_path = _hook(hooks, '_INITIAL_BLOG_BASE_PATH')
    if (
        raw_blog_base_path is not None
        and raw_blog_base_path != init_base_path
        and (raw_base_path is None or raw_base_path == init_base_path)
    ):
        effective_base = raw_blog_base_path
    elif raw_base_path is not None:
        effective_base = raw_base_path
    elif raw_blog_base_path is not None:
        effective_base = raw_blog_base_path
    else:
        effective_base = '/audio-research-portal'
    base = str(effective_base).rstrip('/')
    allowed_prefixes = (
        f'{base}/images/visual-summaries/',
        f'{base}/images/digest-covers/',
        f'{base}/images/papers/',
    )
    if url.startswith(allowed_prefixes):
        parsed = urlparse(url)
        if parsed.query or parsed.fragment or parsed.netloc or parsed.scheme:
            raise err_cls('本地视觉摘要 URL 不允许参数、片段或 authority')
        relative_public = parsed.path[len(base) + 1:]
        if (
            not relative_public
            or '\\' in relative_public
            or any(part in ('', '.', '..') for part in relative_public.split('/'))
        ):
            raise err_cls('本地视觉摘要 URL 包含非法路径段')
        repo = path_cls(_hook(hooks, 'BLOG_REPO', '.')).expanduser().resolve()
        raw_target = repo / 'static' / relative_public
        try:
            target = raw_target.resolve()
            target.relative_to(repo)
        except ValueError as exc:
            raise err_cls(f'博客清单中的文件位于仓库之外：{raw_target}') from exc
        node = raw_target
        while node != repo:
            if node.is_symlink():
                raise err_cls('本地受控图片不得包含符号链接')
            node = node.parent
        manifest_record_fn = _hook(hooks, '_manifest_record')
        if manifest_record_fn is not None:
            _path, relative = manifest_record_fn(target, repo)
        else:
            relative = target.relative_to(repo).as_posix()
        rel_parts = Path(relative).parts
        visual_kinds = set(_hook(hooks, 'VISUAL_SUMMARY_KINDS', ('infographic',)))
        is_visual_asset = (
            rel_parts[:3] == ('static', 'images', 'visual-summaries')
            and len(rel_parts) >= 6
            and all(part not in ('', '.', '..') for part in rel_parts)
            and bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', rel_parts[3] or ''))
            and Path(relative).suffix.lower() == '.png'
            and Path(relative).stem in visual_kinds
        )
        is_digest_cover = (
            rel_parts[:3] == ('static', 'images', 'digest-covers')
            and len(rel_parts) == 5
            and bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', rel_parts[3] or ''))
            and rel_parts[4] == 'cover.png'
        )
        is_reader_asset = (
            rel_parts[:3] == ('static', 'images', 'papers')
            and len(rel_parts) == 5
            and bool(re.fullmatch(r'\d{4}\.\d{4,5}', rel_parts[3] or ''))
            and bool(re.fullmatch(r'figure-\d+-[0-9a-f]{16}\.(?:png|svg)', rel_parts[4] or ''))
        )
        if not (is_visual_asset or is_digest_cover or is_reader_asset):
            raise err_cls('本地图片不属于受控视觉资产目录')
        try:
            descriptor = open_under_dir_fn(repo, relative)
        except OSError as exc:
            raise err_cls('本地受控图片不可读') from exc
        with os_mod.fdopen(descriptor, 'rb') as source:
            info = os_mod.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise err_cls('本地受控图片不可读')
            if info.st_size > max_bytes:
                raise err_cls('本地受控图片超过 8 MiB review 上限')
            raw = source.read(max_bytes + 1)
        if not raw:
            raise err_cls('本地受控图片不可读')
        if len(raw) > max_bytes:
            raise err_cls('本地受控图片超过 8 MiB review 上限')
        media_type = 'image/svg+xml' if target.suffix.lower() == '.svg' else 'image/png'
        validate_sig_fn(media_type, raw)
        if media_type == 'image/svg+xml':
            raw = rasterize_svg_fn(raw)
            media_type = 'image/png'
        media_type, raw = prepare_raster_fn(media_type, raw)
        return {'media_type': media_type, 'data': base64.b64encode(raw).decode('ascii')}
    raise err_cls('图片 review 只允许 data URI、HTTPS 或受控本地图片 URL')


# 兼容带下划线前缀的既有内部别名
_validate_public_image_url = validate_public_image_url
_response_peer_ip = response_peer_ip
_resolve_proxy_addresses = resolve_proxy_addresses
_bounded_positive_seconds = bounded_positive_seconds
_remaining_deadline_seconds = remaining_deadline_seconds
_pinned_https_url = pinned_https_url
_read_pinned_review_image = read_pinned_review_image
_validate_response_peer_with_transport = validate_response_peer_with_transport
_download_review_image = download_review_image
_validate_image_signature = validate_image_signature
_sanitize_svg_xml_for_review = sanitize_svg_xml_for_review
_prepare_raster_for_review = prepare_raster_for_review
_rasterize_svg_for_review = rasterize_svg_for_review
_open_review_image_under_directory = open_review_image_under_directory
_load_review_image_from_local_repo = load_review_image_from_local_repo
_load_review_image = load_review_image
