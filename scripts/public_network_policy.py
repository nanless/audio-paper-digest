#!/usr/bin/env python3
"""公网 IP / CIDR 与代理 Fake-IP 安全策略（与 Node `lib/public-network-policy.js` 单源同构）。"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_POLICY_PATH = (Path(__file__).resolve().parent.parent / 'config' / 'public-network-policy.json').resolve()
MAX_POLICY_BYTES = 64 * 1024
POLICY_KEYS = frozenset({
    'ipv6GlobalUnicastCidr',
    'nonGlobalIpv4Cidrs',
    'nonGlobalIpv6Cidrs',
    'proxyFakeIpCidrs',
})
HTTP_CONNECT_PROXY_ENV_VARS = ('https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY')
FORBIDDEN_PROXY_FAKE_IP_CIDR_LITERALS = (
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '224.0.0.0/4',
    '240.0.0.0/4',
    '::/128',
    '::1/128',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8',
    '::ffff:0:0/96',
)
_PRINTABLE_ASCII_NO_SPACE_RE = re.compile(r'^[\x21-\x7e]+\Z', re.ASCII)
_STRICT_IPV4_RE = re.compile(r'^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}\Z', re.ASCII)
_STRICT_PREFIX_RE = re.compile(r'^(?:0|[1-9][0-9]{0,2})\Z', re.ASCII)


class PublicNetworkPolicyError(ValueError):
    """公网 IP 策略或配置校验失败。"""

    def __init__(self, message: str, code: str, offending_ip: str | None = None):
        super().__init__(message)
        self.code = code
        self.offending_ip = offending_ip


@dataclass(frozen=True)
class _ParsedIp:
    version: int
    value: int
    bits: int
    canonical: str


@dataclass(frozen=True)
class _ParsedCidr:
    cidr: str
    version: int
    network: int
    end: int
    prefix: int
    bits: int


@dataclass(frozen=True)
class CompiledPublicNetworkPolicy:
    ipv6_global_unicast: _ParsedCidr
    non_global_ipv4: tuple[_ParsedCidr, ...]
    non_global_ipv6: tuple[_ParsedCidr, ...]
    proxy_fake_ip: tuple[_ParsedCidr, ...]
    raw: dict


def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PublicNetworkPolicyError(
                f'公网安全策略配置存在重复字段: {key}',
                'PUBLIC_NETWORK_POLICY_SCHEMA',
            )
        result[key] = value
    return result


def _format_ipv6_canonical(value: int) -> str:
    groups = [(value >> (16 * (7 - idx))) & 0xFFFF for idx in range(8)]
    if groups[:6] == [0, 0, 0, 0, 0, 0xFFFF]:
        hi, lo = groups[6], groups[7]
        return f'::ffff:{(hi >> 8) & 0xFF}.{hi & 0xFF}.{(lo >> 8) & 0xFF}.{lo & 0xFF}'
    return str(ipaddress.IPv6Address(value))


def _parse_ip_address(raw) -> _ParsedIp | None:
    if (type(raw) is not str
            or not _PRINTABLE_ASCII_NO_SPACE_RE.fullmatch(raw)
            or '%' in raw):
        return None
    if _STRICT_IPV4_RE.fullmatch(raw):
        octets = [int(part) for part in raw.split('.')]
        if any(octet < 0 or octet > 255 for octet in octets):
            return None
        try:
            addr = ipaddress.IPv4Address(raw)
        except ipaddress.AddressValueError:
            return None
        return _ParsedIp(version=4, value=int(addr), bits=32, canonical=str(addr))
    if ':' not in raw:
        return None
    try:
        addr6 = ipaddress.IPv6Address(raw)
    except ipaddress.AddressValueError:
        return None
    value = int(addr6)
    return _ParsedIp(version=6, value=value, bits=128, canonical=_format_ipv6_canonical(value))


def is_ip_literal(raw) -> bool:
    return _parse_ip_address(raw) is not None


def canonicalize_ip(raw) -> str:
    parsed = _parse_ip_address(raw)
    if parsed is None:
        raise PublicNetworkPolicyError(
            f'非法 IP 地址: {raw}',
            'PUBLIC_NETWORK_INVALID_IP',
            str(raw),
        )
    return parsed.canonical


def _parse_cidr_strict(raw, expected_version: int | None = None) -> _ParsedCidr:
    if (type(raw) is not str
            or not _PRINTABLE_ASCII_NO_SPACE_RE.fullmatch(raw)
            or '/' not in raw):
        raise PublicNetworkPolicyError(f'非法 CIDR 声明: {raw}', 'PUBLIC_NETWORK_POLICY_SCHEMA')
    parts = raw.split('/')
    if len(parts) != 2 or not _STRICT_PREFIX_RE.fullmatch(parts[1]):
        raise PublicNetworkPolicyError(f'非法 CIDR 前缀: {raw}', 'PUBLIC_NETWORK_POLICY_SCHEMA')
    ip = _parse_ip_address(parts[0])
    if ip is None or (expected_version is not None and ip.version != expected_version):
        raise PublicNetworkPolicyError(f'非法 CIDR 网络地址: {raw}', 'PUBLIC_NETWORK_POLICY_SCHEMA')
    prefix = int(parts[1])
    if prefix < 0 or prefix > ip.bits:
        raise PublicNetworkPolicyError(f'CIDR 前缀超出范围: {raw}', 'PUBLIC_NETWORK_POLICY_SCHEMA')
    host_bits = ip.bits - prefix
    host_mask = 0 if host_bits == 0 else ((1 << host_bits) - 1)
    if (ip.value & host_mask) != 0:
        raise PublicNetworkPolicyError(f'CIDR 主机位必须全为 0: {raw}', 'PUBLIC_NETWORK_POLICY_SCHEMA')
    return _ParsedCidr(
        cidr=f'{ip.canonical}/{prefix}',
        version=ip.version,
        network=ip.value,
        end=ip.value | host_mask,
        prefix=prefix,
        bits=ip.bits,
    )


def _ip_in_cidr(parsed_ip: _ParsedIp | None, cidr: _ParsedCidr) -> bool:
    if parsed_ip is None or parsed_ip.version != cidr.version:
        return False
    return cidr.network <= parsed_ip.value <= cidr.end


def _merge_closed_cidr_intervals(cidrs: tuple[_ParsedCidr, ...]) -> list[tuple[int, int]]:
    if not cidrs:
        return []
    sorted_pairs = sorted((item.network, item.end) for item in cidrs)
    merged: list[list[int]] = [[sorted_pairs[0][0], sorted_pairs[0][1]]]
    for next_start, next_end in sorted_pairs[1:]:
        current = merged[-1]
        if next_start <= current[1] + 1:
            if next_end > current[1]:
                current[1] = next_end
        else:
            merged.append([next_start, next_end])
    return [(start, end) for start, end in merged]


def _is_closed_interval_covered(start: int, end: int, merged_intervals: list[tuple[int, int]]) -> bool:
    if start > end:
        return True
    return any(m_start <= start and end <= m_end for m_start, m_end in merged_intervals)


_FORBIDDEN_PROXY_FAKE_IP_CIDRS = tuple(
    _parse_cidr_strict(item, None) for item in FORBIDDEN_PROXY_FAKE_IP_CIDR_LITERALS
)


def _read_policy_file_safe(policy_path: Path | str) -> dict:
    target = Path(os.path.abspath(os.fspath(policy_path)))
    try:
        stat_before = target.lstat()
    except FileNotFoundError as exc:
        raise PublicNetworkPolicyError(
            f'公网安全策略文件不存在: {target}',
            'PUBLIC_NETWORK_POLICY_MISSING',
        ) from exc
    except OSError as exc:
        raise PublicNetworkPolicyError(
            f'读取公网安全策略文件失败: {exc}',
            'PUBLIC_NETWORK_POLICY_READ_ERROR',
        ) from exc

    if (not stat.S_ISREG(stat_before.st_mode)
            or target.is_symlink()
            or (os.name != 'nt' and stat_before.st_nlink != 1)):
        raise PublicNetworkPolicyError(
            f'公网安全策略文件必须是单硬链接普通文件且禁止符号链接: {target}',
            'PUBLIC_NETWORK_POLICY_UNSAFE_FILE',
        )
    try:
        resolved_real = target.resolve(strict=True)
    except OSError as exc:
        raise PublicNetworkPolicyError(
            f'无法解析公网安全策略文件真实路径: {target}',
            'PUBLIC_NETWORK_POLICY_SYMLINK',
        ) from exc
    if resolved_real != target:
        raise PublicNetworkPolicyError(
            f'公网安全策略文件路径禁止包含符号链接: {target}',
            'PUBLIC_NETWORK_POLICY_SYMLINK',
        )
    if stat_before.st_size <= 0 or stat_before.st_size > MAX_POLICY_BYTES:
        raise PublicNetworkPolicyError(
            f'公网安全策略文件大小超出安全范围: {stat_before.st_size}',
            'PUBLIC_NETWORK_POLICY_SIZE',
        )

    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        fd = os.open(target, flags)
    except OSError as exc:
        raise PublicNetworkPolicyError(
            f'打开公网安全策略文件失败: {exc}',
            'PUBLIC_NETWORK_POLICY_UNSAFE_FILE',
        ) from exc
    try:
        stat_opened = os.fstat(fd)
        if (not stat.S_ISREG(stat_opened.st_mode)
                or (os.name != 'nt' and stat_opened.st_nlink != 1)
                or (stat_opened.st_dev, stat_opened.st_ino) != (stat_before.st_dev, stat_before.st_ino)
                or stat_opened.st_size != stat_before.st_size):
            raise PublicNetworkPolicyError(
                f'公网安全策略文件在读取前状态异常: {target}',
                'PUBLIC_NETWORK_POLICY_TOCTOU',
            )
        raw_bytes = os.read(fd, MAX_POLICY_BYTES + 1)
        stat_after = os.fstat(fd)
        stat_named = target.lstat()
        if (len(raw_bytes) != stat_opened.st_size
                or (stat_after.st_dev, stat_after.st_ino, stat_after.st_size, stat_after.st_mtime_ns)
                != (stat_opened.st_dev, stat_opened.st_ino, stat_opened.st_size, stat_opened.st_mtime_ns)
                or (stat_named.st_dev, stat_named.st_ino) != (stat_opened.st_dev, stat_opened.st_ino)
                or target.is_symlink()
                or target.resolve(strict=True) != target):
            raise PublicNetworkPolicyError(
                f'公网安全策略文件在读取期间发生并发变化: {target}',
                'PUBLIC_NETWORK_POLICY_TOCTOU',
            )
    except PublicNetworkPolicyError:
        raise
    except OSError as exc:
        raise PublicNetworkPolicyError(
            f'读取公网安全策略文件失败: {exc}',
            'PUBLIC_NETWORK_POLICY_READ_ERROR',
        ) from exc
    finally:
        os.close(fd)

    try:
        text = raw_bytes.decode('utf-8')
    except UnicodeDecodeError as exc:
        raise PublicNetworkPolicyError(
            f'公网安全策略配置不是有效 UTF-8 编码: {exc}',
            'PUBLIC_NETWORK_POLICY_SCHEMA',
        ) from exc

    trimmed = text.strip()
    if not trimmed.startswith('{') or not trimmed.endswith('}'):
        raise PublicNetworkPolicyError(
            '公网安全策略配置必须是纯 JSON 对象且禁止使用 Markdown 代码围栏',
            'PUBLIC_NETWORK_POLICY_SCHEMA',
        )

    try:
        return json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except PublicNetworkPolicyError:
        raise
    except json.JSONDecodeError as exc:
        raise PublicNetworkPolicyError(
            f'公网安全策略配置不是有效 UTF-8 JSON: {exc}',
            'PUBLIC_NETWORK_POLICY_SCHEMA',
        ) from exc


def _is_parsed_globally_routable(parsed_ip: _ParsedIp | None, compiled: CompiledPublicNetworkPolicy) -> bool:
    if parsed_ip is None:
        return False
    if parsed_ip.version == 4:
        return not any(_ip_in_cidr(parsed_ip, cidr) for cidr in compiled.non_global_ipv4)
    if parsed_ip.version == 6:
        if not _ip_in_cidr(parsed_ip, compiled.ipv6_global_unicast):
            return False
        return not any(_ip_in_cidr(parsed_ip, cidr) for cidr in compiled.non_global_ipv6)
    return False


def compile_public_network_policy(raw_policy) -> CompiledPublicNetworkPolicy:
    if type(raw_policy) is not dict or set(raw_policy.keys()) != POLICY_KEYS:
        raise PublicNetworkPolicyError(
            '公网安全策略配置字段不完整或包含未知字段',
            'PUBLIC_NETWORK_POLICY_SCHEMA',
        )
    ipv4_list = raw_policy['nonGlobalIpv4Cidrs']
    ipv6_list = raw_policy['nonGlobalIpv6Cidrs']
    fake_list = raw_policy['proxyFakeIpCidrs']
    if (type(ipv4_list) is not list or len(ipv4_list) < 15
            or type(ipv6_list) is not list or len(ipv6_list) == 0
            or type(fake_list) is not list or len(fake_list) == 0):
        raise PublicNetworkPolicyError(
            '公网安全策略 CIDR 列表不能为空且 IPv4 保留段不少于 15 段',
            'PUBLIC_NETWORK_POLICY_SCHEMA',
        )
    ipv6_global_unicast = _parse_cidr_strict(raw_policy['ipv6GlobalUnicastCidr'], 6)
    non_global_ipv4 = tuple(_parse_cidr_strict(item, 4) for item in ipv4_list)
    non_global_ipv6 = tuple(_parse_cidr_strict(item, 6) for item in ipv6_list)
    proxy_fake_ip = tuple(_parse_cidr_strict(item, None) for item in fake_list)

    merged_non_global_ipv4 = _merge_closed_cidr_intervals(non_global_ipv4)
    merged_non_global_ipv6 = _merge_closed_cidr_intervals(non_global_ipv6)

    for fake_cidr in proxy_fake_ip:
        for forbidden in _FORBIDDEN_PROXY_FAKE_IP_CIDRS:
            if (fake_cidr.version == forbidden.version
                    and fake_cidr.network <= forbidden.end
                    and forbidden.network <= fake_cidr.end):
                raise PublicNetworkPolicyError(
                    f'proxyFakeIpCidrs 禁止覆盖私网、本机或多播保留地址段: '
                    f'{fake_cidr.cidr} 与 {forbidden.cidr} 重叠',
                    'PUBLIC_NETWORK_POLICY_SCHEMA',
                )
        if fake_cidr.version == 4:
            if not _is_closed_interval_covered(fake_cidr.network, fake_cidr.end, merged_non_global_ipv4):
                raise PublicNetworkPolicyError(
                    f'proxyFakeIpCidrs 不能覆盖公网可路由地址: {fake_cidr.cidr}',
                    'PUBLIC_NETWORK_POLICY_SCHEMA',
                )
        else:
            intersect_start = max(fake_cidr.network, ipv6_global_unicast.network)
            intersect_end = min(fake_cidr.end, ipv6_global_unicast.end)
            if (intersect_start <= intersect_end
                    and not _is_closed_interval_covered(intersect_start, intersect_end, merged_non_global_ipv6)):
                raise PublicNetworkPolicyError(
                    f'proxyFakeIpCidrs 不能覆盖公网可路由地址: {fake_cidr.cidr}',
                    'PUBLIC_NETWORK_POLICY_SCHEMA',
                )

    return CompiledPublicNetworkPolicy(
        ipv6_global_unicast=ipv6_global_unicast,
        non_global_ipv4=non_global_ipv4,
        non_global_ipv6=non_global_ipv6,
        proxy_fake_ip=proxy_fake_ip,
        raw={
            'ipv6GlobalUnicastCidr': ipv6_global_unicast.cidr,
            'nonGlobalIpv4Cidrs': [item.cidr for item in non_global_ipv4],
            'nonGlobalIpv6Cidrs': [item.cidr for item in non_global_ipv6],
            'proxyFakeIpCidrs': [item.cidr for item in proxy_fake_ip],
        },
    )


_CACHED_DEFAULT_POLICY: CompiledPublicNetworkPolicy | None = None


def load_public_network_policy(policy_path: Path | str | None = None) -> CompiledPublicNetworkPolicy:
    global _CACHED_DEFAULT_POLICY
    resolved = DEFAULT_POLICY_PATH if policy_path is None else Path(os.path.abspath(os.fspath(policy_path)))
    if resolved == DEFAULT_POLICY_PATH and _CACHED_DEFAULT_POLICY is not None:
        return _CACHED_DEFAULT_POLICY
    compiled = compile_public_network_policy(_read_policy_file_safe(resolved))
    if resolved == DEFAULT_POLICY_PATH:
        _CACHED_DEFAULT_POLICY = compiled
    return compiled


def _resolve_policy(*, policy=None, policy_path: Path | str | None = None) -> CompiledPublicNetworkPolicy:
    if policy is not None:
        if isinstance(policy, CompiledPublicNetworkPolicy):
            return policy
        return compile_public_network_policy(policy)
    if policy_path is not None:
        return load_public_network_policy(policy_path)
    return load_public_network_policy(DEFAULT_POLICY_PATH)


def is_globally_routable_ip(ip, *, policy=None, policy_path: Path | str | None = None) -> bool:
    compiled = _resolve_policy(policy=policy, policy_path=policy_path)
    parsed = _parse_ip_address(ip)
    return _is_parsed_globally_routable(parsed, compiled)


def is_private_ip_address(ip, *, policy=None, policy_path: Path | str | None = None) -> bool:
    return not is_globally_routable_ip(ip, policy=policy, policy_path=policy_path)


def is_proxy_fake_ip(ip, *, policy=None, policy_path: Path | str | None = None) -> bool:
    compiled = _resolve_policy(policy=policy, policy_path=policy_path)
    parsed = _parse_ip_address(ip)
    if parsed is None:
        return False
    return any(_ip_in_cidr(parsed, cidr) for cidr in compiled.proxy_fake_ip)


_STRICT_DNS_LABEL_RE = re.compile(r'^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$')


def normalize_strict_url_hostname(raw_hostname) -> str | None:
    """严格规范化 URL 主机名：禁止 %、校验纯 ASCII IPv6，对域名经 IDNA 后强制执行 STD3 标签白名单。"""
    if type(raw_hostname) is not str or not raw_hostname or '%' in raw_hostname:
        return None
    if ':' in raw_hostname:
        if not raw_hostname.isascii() or re.search(r'[\x00-\x20\x7f\\]', raw_hostname):
            return None
        try:
            return str(ipaddress.IPv6Address(raw_hostname))
        except ValueError:
            return None
    try:
        ascii_host = raw_hostname.encode('idna').decode('ascii').lower()
    except UnicodeError:
        return None
    hostname = ascii_host[:-1] if ascii_host.endswith('.') else ascii_host
    if not hostname or len(hostname) > 253 or re.search(r'[^a-z0-9._-]', hostname):
        return None
    if any(not _STRICT_DNS_LABEL_RE.fullmatch(label) for label in hostname.split('.')):
        return None
    return hostname


def is_valid_http_connect_proxy_url(raw_url) -> bool:
    if type(raw_url) is not str or not raw_url or re.search(r'[\x00-\x20\x7f\\]', raw_url):
        return False
    if not re.match(r'^https?://[^/?#]', raw_url, re.IGNORECASE):
        return False
    try:
        parsed = urlparse(raw_url)
        port = parsed.port
        hostname = normalize_strict_url_hostname(parsed.hostname)
        return (
            parsed.scheme in ('http', 'https')
            and bool(hostname)
            and (port is None or 1 <= port <= 65535)
        )
    except ValueError:
        return False


def resolve_http_connect_proxy_url(environ=None) -> str | None:
    """与 `project_env.get_required_fetch_proxy()` 严格一致：只检查首个非空代理变量，非法时不向低优先级穿透。"""
    env = os.environ if environ is None else environ
    first_key = next((key for key in HTTP_CONNECT_PROXY_ENV_VARS if env.get(key)), None)
    if first_key is None:
        return None
    value = env[first_key]
    return value if is_valid_http_connect_proxy_url(value) else None


def has_http_connect_proxy(environ=None) -> bool:
    return resolve_http_connect_proxy_url(environ) is not None


def select_validated_public_ip(
    addresses,
    options: dict | None = None,
    *,
    proxy_enabled: bool | None = None,
    policy=None,
    policy_path: Path | str | None = None,
) -> dict:
    if options is not None:
        if type(options) is not dict:
            raise TypeError('select_validated_public_ip options 必须为字典')
        if proxy_enabled is None and 'proxyEnabled' in options:
            proxy_enabled = options['proxyEnabled']
        if proxy_enabled is None and 'proxy_enabled' in options:
            proxy_enabled = options['proxy_enabled']
        if policy is None and 'policy' in options:
            policy = options['policy']
        if policy_path is None and ('policyPath' in options or 'policy_path' in options):
            policy_path = options.get('policyPath', options.get('policy_path'))

    effective_proxy = False if proxy_enabled is None else proxy_enabled
    if type(effective_proxy) is not bool:
        raise TypeError('proxy_enabled 必须为布尔值')

    if addresses is None or isinstance(addresses, (str, bytes)):
        raise PublicNetworkPolicyError('公网 URL DNS 解析为空', 'PUBLIC_NETWORK_EMPTY_DNS')
    try:
        raw_list = list(addresses)
    except TypeError as exc:
        raise PublicNetworkPolicyError('公网 URL DNS 解析为空', 'PUBLIC_NETWORK_EMPTY_DNS') from exc
    if not raw_list:
        raise PublicNetworkPolicyError('公网 URL DNS 解析为空', 'PUBLIC_NETWORK_EMPTY_DNS')

    compiled = _resolve_policy(policy=policy, policy_path=policy_path)
    parsed_list: list[_ParsedIp] = []
    for raw_item in raw_list:
        parsed = _parse_ip_address(raw_item)
        if parsed is None:
            raise PublicNetworkPolicyError(
                f'公网 URL DNS 解析到非公网 IP: {raw_item}',
                'PUBLIC_NETWORK_INVALID_IP',
                str(raw_item),
            )
        parsed_list.append(parsed)

    unique_canonical: list[str] = []
    seen = set()
    for item in parsed_list:
        if item.canonical not in seen:
            seen.add(item.canonical)
            unique_canonical.append(item.canonical)

    if all(_is_parsed_globally_routable(item, compiled) for item in parsed_list):
        return {
            'address': unique_canonical[0],
            'addresses': unique_canonical,
            'mode': 'global',
        }

    all_fake_ip = all(
        any(_ip_in_cidr(item, cidr) for cidr in compiled.proxy_fake_ip)
        for item in parsed_list
    )
    if effective_proxy is True and all_fake_ip:
        return {
            'address': unique_canonical[0],
            'addresses': unique_canonical,
            'mode': 'proxy_fake_ip',
        }

    offending = None
    if effective_proxy is True:
        for item in parsed_list:
            if (not _is_parsed_globally_routable(item, compiled)
                    and not any(_ip_in_cidr(item, cidr) for cidr in compiled.proxy_fake_ip)):
                offending = item
                break
    if offending is None:
        for item in parsed_list:
            if not _is_parsed_globally_routable(item, compiled):
                offending = item
                break
    offending_ip = offending.canonical if offending is not None else unique_canonical[0]
    raise PublicNetworkPolicyError(
        f'公网 URL DNS 解析到非公网 IP: {offending_ip}',
        'PUBLIC_NETWORK_NON_GLOBAL_IP',
        offending_ip,
    )


# JS 同构别名（便于双栈同构回归逐项对照）
compilePublicNetworkPolicy = compile_public_network_policy
hasHttpConnectProxy = has_http_connect_proxy
isGloballyRoutableIp = is_globally_routable_ip
isPrivateIpAddress = is_private_ip_address
isProxyFakeIp = is_proxy_fake_ip
loadPublicNetworkPolicy = load_public_network_policy
resolveHttpConnectProxyUrl = resolve_http_connect_proxy_url
selectValidatedPublicIp = select_validated_public_ip


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
