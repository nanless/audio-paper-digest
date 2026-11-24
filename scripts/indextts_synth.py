#!/usr/bin/env python3
"""Wave 14.3: Pluggable IndexTTS latest (IndexTTS-2.5 / 2.0 / v1) podcast synthesizer.

Backends:
  - indextts2-python : Local inference via indextts.infer_v2_5.IndexTTS2 (first),
                       falling back to indextts.infer_v2.IndexTTS2 (v2.0) and
                       indextts.infer.IndexTTS (v1).
  - indextts-http    : Remote/daemon IndexTTS HTTP server supporting OpenAI-compatible
                       /v1/audio/speech (e.g. vllm-omni), Gradio, and custom JSON.
                       Uses direct pinned IP connections (bypassing ambient proxies),
                       strict IPv4/IPv6 SSRF blocking, wall-clock deadlines, and strict
                       audio magic-byte whitelisting.
  - silent-mock      : Explicit hermetic test backend generating deterministic PCM WAV/MP3.
"""

from __future__ import annotations

import argparse
import array
import base64
import binascii
import hashlib
import http.client
import importlib
import inspect
import ipaddress
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.parse
import wave
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

PODCAST_AUDIO_MANIFEST_CONTRACT = 'daily-podcast-audio-v1'
DEFAULT_SAMPLE_RATE = 44100
MIN_SAMPLE_RATE = 8000
MAX_SAMPLE_RATE = 192000
DEFAULT_BITRATE_KBPS = 128
MIN_BITRATE_KBPS = 32
MAX_BITRATE_KBPS = 320
DEFAULT_MAX_CHUNK_CHARS = 180
DEFAULT_INTER_CHUNK_PAUSE_MS = 160
DEFAULT_HTTP_TIMEOUT_SECONDS = 120.0
DEFAULT_HTTP_RETRIES = 2
MAX_HTTP_AUDIO_BYTES = 32 * 1024 * 1024  # 32 MiB per chunk
HTTP_READ_CHUNK_BYTES = 65536
FFMPEG_CHUNK_TIMEOUT_SECONDS = 60
FFMPEG_EPISODE_TIMEOUT_SECONDS = 300
FFPROBE_TIMEOUT_SECONDS = 30
MAX_DECODE_DURATION_SECONDS = 180
LOUDNORM_MAX_DRIFT_SECONDS = 1.0
DEFAULT_OPENAI_TTS_MODEL = 'IndexTeam/IndexTTS-2.5'

INDEXTTS_INSTALL_HINT = (
    'Install IndexTTS-2.5 from upstream: '
    'git clone https://github.com/index-tts/index-tts.git && cd index-tts && uv sync --all-extras '
    '(checkpoints: https://huggingface.co/IndexTeam/IndexTTS-2.5 or IndexTeam/IndexTTS-2)'
)

# Official IndexTTS-2 / 2.5 8-dimensional emotion vector order:
# [happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]
EMOTION_HINT_VECTORS: Dict[str, List[float]] = {
    'warm': [0.35, 0.0, 0.0, 0.0, 0.0, 0.0, 0.05, 0.60],
    'enthusiastic': [0.55, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25, 0.20],
    'analytical': [0.10, 0.0, 0.0, 0.0, 0.0, 0.0, 0.05, 0.85],
    'calm': [0.05, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.95],
    'closing': [0.30, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.70],
    'surprised': [0.20, 0.0, 0.0, 0.0, 0.0, 0.0, 0.65, 0.15],
}

BLOCKED_IPV4_NETWORKS = (
    ipaddress.ip_network('0.0.0.0/8'),
    ipaddress.ip_network('10.0.0.0/8'),
    ipaddress.ip_network('100.64.0.0/10'),
    ipaddress.ip_network('127.0.0.0/8'),
    ipaddress.ip_network('169.254.0.0/16'),
    ipaddress.ip_network('172.16.0.0/12'),
    ipaddress.ip_network('192.0.0.0/24'),
    ipaddress.ip_network('192.0.2.0/24'),
    ipaddress.ip_network('192.88.99.0/24'),
    ipaddress.ip_network('192.168.0.0/16'),
    ipaddress.ip_network('198.18.0.0/15'),
    ipaddress.ip_network('198.51.100.0/24'),
    ipaddress.ip_network('203.0.113.0/24'),
    ipaddress.ip_network('224.0.0.0/4'),
    ipaddress.ip_network('240.0.0.0/4'),
)

IPV6_GLOBAL_UNICAST_NETWORK = ipaddress.ip_network('2000::/3')
IPV6_NAT64_WELL_KNOWN = ipaddress.ip_network('64:ff9b::/96')

BLOCKED_IPV6_NETWORKS = (
    ipaddress.ip_network('::/128'),
    ipaddress.ip_network('::1/128'),
    ipaddress.ip_network('::/96'),            # Deprecated IPv4-compatible
    ipaddress.ip_network('::ffff:0:0/96'),    # IPv4-mapped
    ipaddress.ip_network('::ffff:0:0:0/96'),  # IPv4-translated
    ipaddress.ip_network('64:ff9b::/96'),     # NAT64 well-known
    ipaddress.ip_network('64:ff9b:1::/48'),   # NAT64 local-use
    ipaddress.ip_network('100::/64'),         # Discard-only
    ipaddress.ip_network('2001::/23'),        # IETF protocol assignments (incl. Teredo & benchmarking)
    ipaddress.ip_network('2001:db8::/32'),    # Documentation
    ipaddress.ip_network('2002::/16'),        # 6to4
    ipaddress.ip_network('3fff::/20'),        # Documentation
    ipaddress.ip_network('fc00::/7'),         # Unique local (ULA)
    ipaddress.ip_network('fe80::/10'),        # Link-local
    ipaddress.ip_network('fec0::/10'),        # Deprecated site-local
    ipaddress.ip_network('ff00::/8'),         # Multicast
)

ALLOWED_AUDIO_DEMUXERS = frozenset({'wav', 'mp3', 'flac', 'ogg', 'mov'})

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
try:
    import public_network_policy as _pnp
    _COMPILED_PUBLIC_NETWORK_POLICY = _pnp.load_public_network_policy()
except Exception:
    _pnp = None
    _COMPILED_PUBLIC_NETWORK_POLICY = None


class IndexTTSError(RuntimeError):
    """Base error for IndexTTS synthesis failures."""


class _NonRetryableIndexTTSError(IndexTTSError):
    """Fatal IndexTTS HTTP/decoding error that must not be retried."""


class IndexTTSUnavailableError(IndexTTSError):
    """Raised when local IndexTTS Python package cannot be imported."""


class EndpointValidationError(ValueError):
    """Raised when an indextts-http endpoint fails URL, SSRF, or redirect validation."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def validate_audio_params(sample_rate: int, bitrate_kbps: int) -> Tuple[int, int]:
    sr = int(sample_rate)
    br = int(bitrate_kbps)
    if not (MIN_SAMPLE_RATE <= sr <= MAX_SAMPLE_RATE):
        raise ValueError(f'sample_rate must be in [{MIN_SAMPLE_RATE}, {MAX_SAMPLE_RATE}] (got {sr})')
    if not (MIN_BITRATE_KBPS <= br <= MAX_BITRATE_KBPS):
        raise ValueError(f'bitrate_kbps must be in [{MIN_BITRATE_KBPS}, {MAX_BITRATE_KBPS}] (got {br})')
    return sr, br


def redact_url_for_display(raw_url: str) -> str:
    """Strip query string, fragment, and userinfo before logging or storing URL."""
    parsed = urllib.parse.urlsplit(str(raw_url or '').strip())
    host = parsed.hostname or ''
    if ':' in host and not host.startswith('['):
        host = f'[{host}]'
    try:
        port = parsed.port
    except ValueError:
        port = None
    default_port = 443 if parsed.scheme.lower() == 'https' else 80
    netloc = f'{host}:{port}' if (port is not None and port != default_port) else host
    path = parsed.path or '/'
    return f'{parsed.scheme.lower()}://{netloc}{path}'


def emotion_vector_for_hint(hint: Optional[str]) -> List[float]:
    key = str(hint or 'calm').strip().lower()
    return list(EMOTION_HINT_VECTORS.get(key, EMOTION_HINT_VECTORS['calm']))


def split_text_chunks(text: str, max_chars: int = DEFAULT_MAX_CHUNK_CHARS) -> List[str]:
    cleaned = re.sub(r'\s+', ' ', str(text or '')).strip()
    if not cleaned:
        return []
    limit = max(20, int(max_chars))
    if len(cleaned) <= limit:
        return [cleaned]

    chunks: List[str] = []
    remaining = cleaned
    while len(remaining) > limit:
        window = remaining[:limit]
        split_at = -1
        for i in range(len(window) - 1, int(limit * 0.35) - 1, -1):
            if window[i] in '。！？!?\n':
                split_at = i + 1
                break
        if split_at == -1:
            for i in range(len(window) - 1, int(limit * 0.30) - 1, -1):
                if window[i] in '；，：;,:、':
                    split_at = i + 1
                    break
        if split_at == -1:
            for i in range(len(window) - 1, int(limit * 0.40) - 1, -1):
                if window[i] == ' ':
                    split_at = i + 1
                    break
        if split_at == -1:
            split_at = limit
        piece = remaining[:split_at].strip()
        if piece:
            chunks.append(piece)
        remaining = remaining[split_at:].strip()
    if remaining:
        chunks.append(remaining)
    return chunks


def detect_torch_info(preferred: str = 'auto') -> Dict[str, Any]:
    pref = str(preferred or 'auto').strip().lower()
    if pref not in ('auto', 'cuda', 'mps', 'cpu'):
        raise ValueError(f'Unsupported device preference: {preferred}')
    try:
        torch = importlib.import_module('torch')
    except Exception:
        return {
            'torchInstalled': False,
            'torchVersion': None,
            'cudaAvailable': False,
            'mpsAvailable': False,
            'device': 'cpu' if pref == 'auto' else pref,
        }

    cuda_ok = bool(getattr(torch, 'cuda', None) and torch.cuda.is_available())
    mps_backend = getattr(getattr(torch, 'backends', None), 'mps', None)
    mps_ok = bool(mps_backend and mps_backend.is_available())
    if pref != 'auto':
        device = pref
    elif cuda_ok:
        device = 'cuda'
    elif mps_ok:
        device = 'mps'
    else:
        device = 'cpu'
    return {
        'torchInstalled': True,
        'torchVersion': getattr(torch, '__version__', None),
        'cudaAvailable': cuda_ok,
        'mpsAvailable': mps_ok,
        'device': device,
    }


def resolve_indextts_class() -> Tuple[Optional[type], str, str, Optional[str]]:
    """Probe installed IndexTTS classes in strict priority order:
    1. indextts.infer_v2_5.IndexTTS2  -> ('IndexTTS2.5', 'indextts-2.5')
    2. indextts.infer_v2.IndexTTS2    -> ('IndexTTS2',   'indextts-2')
    3. indextts.infer.IndexTTS        -> ('IndexTTS',    'indextts-1')
    """
    pkg_version: Optional[str] = None
    try:
        pkg = importlib.import_module('indextts')
        pkg_version = getattr(pkg, '__version__', None)
    except Exception:
        pkg_version = None

    probes = (
        ('indextts.infer_v2_5', 'IndexTTS2', 'IndexTTS2.5', 'indextts-2.5'),
        ('indextts.infer_v2', 'IndexTTS2', 'IndexTTS2', 'indextts-2'),
        ('indextts.infer', 'IndexTTS', 'IndexTTS', 'indextts-1'),
    )
    for mod_name, cls_name, status_label, engine_label in probes:
        try:
            mod = importlib.import_module(mod_name)
            cls = getattr(mod, cls_name, None)
            if cls is not None:
                return cls, status_label, engine_label, pkg_version
        except Exception:
            continue
    return None, 'not-installed', 'none', pkg_version


def check_environment(preferred_device: str = 'auto') -> Dict[str, Any]:
    torch_info = detect_torch_info(preferred_device)
    cls, status_label, engine_label, pkg_version = resolve_indextts_class()
    ffmpeg_path = shutil.which('ffmpeg')
    ffprobe_path = shutil.which('ffprobe')
    return {
        'contract': PODCAST_AUDIO_MANIFEST_CONTRACT,
        'pythonVersion': '.'.join(str(x) for x in sys.version_info[:3]),
        'pythonExecutable': sys.executable,
        'torchInstalled': torch_info['torchInstalled'],
        'torchVersion': torch_info['torchVersion'],
        'cudaAvailable': torch_info['cudaAvailable'],
        'mpsAvailable': torch_info['mpsAvailable'],
        'device': torch_info['device'],
        'indexttsStatus': status_label,
        'indexttsEngine': engine_label,
        'indexttsVersion': pkg_version,
        'installHint': INDEXTTS_INSTALL_HINT,
        'ffmpegAvailable': bool(ffmpeg_path),
        'ffmpegPath': ffmpeg_path,
        'ffprobeAvailable': bool(ffprobe_path),
        'ffprobePath': ffprobe_path,
        'readyForLocalInference': cls is not None,
        'readyForMp3Encoding': bool(ffmpeg_path),
    }


def _unwrap_ip(ip_obj: ipaddress.IPv4Address | ipaddress.IPv6Address) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped is not None:
        return ip_obj.ipv4_mapped
    return ip_obj


def _is_loopback_ip(ip_obj: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    unwrapped = _unwrap_ip(ip_obj)
    return unwrapped.is_loopback


def _is_blocked_ipv4(v4: ipaddress.IPv4Address, *, allow_loopback: bool) -> bool:
    if allow_loopback and v4.is_loopback:
        return False
    if any(v4 in net for net in BLOCKED_IPV4_NETWORKS):
        return True
    if (v4.is_private or v4.is_loopback or v4.is_link_local
            or v4.is_multicast or v4.is_reserved or v4.is_unspecified or not v4.is_global):
        return True
    if _pnp is not None and _COMPILED_PUBLIC_NETWORK_POLICY is not None:
        if not _pnp.is_globally_routable_ip(str(v4), policy=_COMPILED_PUBLIC_NETWORK_POLICY):
            return True
    return False


def _is_blocked_ip(ip_obj: ipaddress.IPv4Address | ipaddress.IPv6Address, *, allow_loopback: bool) -> bool:
    if isinstance(ip_obj, ipaddress.IPv4Address):
        return _is_blocked_ipv4(ip_obj, allow_loopback=allow_loopback)

    # IPv6: handle IPv4-mapped loopback explicitly when allow_loopback=True
    if ip_obj.ipv4_mapped is not None:
        return _is_blocked_ipv4(ip_obj.ipv4_mapped, allow_loopback=allow_loopback)

    if allow_loopback and ip_obj.is_loopback:
        return False

    # Block special/non-global IPv6 prefixes (NAT64, 6to4, Teredo, site-local, discard, etc.)
    if any(ip_obj in net for net in BLOCKED_IPV6_NETWORKS):
        return True
    if ip_obj not in IPV6_GLOBAL_UNICAST_NETWORK:
        return True
    if (ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local
            or ip_obj.is_site_local or ip_obj.is_multicast or ip_obj.is_reserved
            or ip_obj.is_unspecified or not ip_obj.is_global):
        return True

    # Defense in depth: unwrap embedded IPv4 addresses in 6to4, Teredo, or NAT64
    if ip_obj.sixtofour is not None and _is_blocked_ipv4(ip_obj.sixtofour, allow_loopback=False):
        return True
    if ip_obj.teredo is not None:
        server_v4, client_v4 = ip_obj.teredo
        if _is_blocked_ipv4(server_v4, allow_loopback=False) or _is_blocked_ipv4(client_v4, allow_loopback=False):
            return True
    if ip_obj in IPV6_NAT64_WELL_KNOWN:
        embedded_v4 = ipaddress.IPv4Address(int(ip_obj) & 0xFFFFFFFF)
        if _is_blocked_ipv4(embedded_v4, allow_loopback=False):
            return True

    if _pnp is not None and _COMPILED_PUBLIC_NETWORK_POLICY is not None:
        if not _pnp.is_globally_routable_ip(str(ip_obj), policy=_COMPILED_PUBLIC_NETWORK_POLICY):
            return True
    return False


def _canonical_ip_str(raw: str) -> str:
    ip_obj = ipaddress.ip_address(raw.split('%')[0])
    return str(_unwrap_ip(ip_obj))


def validate_indextts_endpoint(
    raw_url: str,
    *,
    allow_loopback: bool = False,
    dns_resolver: Optional[Callable[[str, int], Sequence[Tuple[Any, ...]]]] = None,
) -> Dict[str, Any]:
    """Validate indextts-http endpoint URL strictly against SSRF, whitespace, scheme abuse, and port 0."""
    url = str(raw_url or '')
    if not url:
        raise EndpointValidationError('IndexTTS HTTP endpoint URL is empty')
    if any(ord(ch) <= 32 or ord(ch) == 127 or ch.isspace() for ch in url):
        raise EndpointValidationError('IndexTTS HTTP endpoint URL contains illegal whitespace or control characters')

    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in ('http', 'https'):
        raise EndpointValidationError(f'Unsupported endpoint scheme "{scheme}"; only https (or loopback http) allowed')
    if parsed.username is not None or parsed.password is not None:
        raise EndpointValidationError('Embedded credentials in endpoint URL are forbidden')
    hostname = (parsed.hostname or '').strip().lower().rstrip('.')
    if not hostname:
        raise EndpointValidationError('Endpoint URL is missing a valid hostname')
    if '%' in hostname:
        raise EndpointValidationError('Zone identifiers / percent-encoding in endpoint hostname are forbidden')
    try:
        parsed_port = parsed.port
    except ValueError as exc:
        raise EndpointValidationError(f'Invalid port in endpoint URL: {exc}') from exc
    port = (443 if scheme == 'https' else 80) if parsed_port is None else parsed_port
    if not isinstance(port, int) or not (1 <= port <= 65535):
        raise EndpointValidationError(f'Endpoint port must be between 1 and 65535 (got {port})')

    resolved_ips: List[str] = []
    literal_ip: Optional[ipaddress.IPv4Address | ipaddress.IPv6Address] = None
    try:
        literal_ip = ipaddress.ip_address(hostname)
    except ValueError:
        literal_ip = None

    if literal_ip is not None:
        if _is_blocked_ip(literal_ip, allow_loopback=allow_loopback):
            raise EndpointValidationError(f'Endpoint IP "{hostname}" is blocked by SSRF policy')
        is_loopback = _is_loopback_ip(literal_ip)
        if scheme == 'http' and not (allow_loopback and is_loopback):
            raise EndpointValidationError('Plaintext http:// is only allowed for explicitly enabled loopback endpoints')
        resolved_ips.append(str(_unwrap_ip(literal_ip)))
    elif hostname in ('localhost', 'localhost.localdomain'):
        if not allow_loopback:
            raise EndpointValidationError('Loopback hostname requires explicit --allow-local-endpoint opt-in')
        # Pin localhost exclusively to loopback literal IPs (never trust external DNS)
        resolved_ips.extend(['127.0.0.1', '::1'])
        is_loopback = True
    else:
        # Non-localhost hostnames NEVER inherit allow_loopback!
        if hostname.endswith('.localhost') or hostname.endswith('.internal') or hostname.endswith('.local'):
            raise EndpointValidationError(f'Internal/local hostname "{hostname}" is blocked by SSRF policy')
        if scheme == 'http':
            raise EndpointValidationError('Remote IndexTTS HTTP endpoints must use https://')
        resolver = dns_resolver or socket.getaddrinfo
        try:
            infos = resolver(hostname, port)
        except OSError as exc:
            raise EndpointValidationError(f'Failed to resolve endpoint hostname "{hostname}": {exc}') from exc
        if not infos:
            raise EndpointValidationError(f'No DNS records resolved for endpoint hostname "{hostname}"')
        seen = set()
        for info in infos:
            sockaddr = info[4]
            ip_text = sockaddr[0].split('%')[0]
            try:
                ip_obj = ipaddress.ip_address(ip_text)
            except ValueError as exc:
                raise EndpointValidationError(f'Resolver returned invalid IP "{ip_text}"') from exc
            if _is_blocked_ip(ip_obj, allow_loopback=False):
                raise EndpointValidationError(
                    f'Endpoint hostname "{hostname}" resolved to blocked IP "{ip_text}"'
                )
            canonical = str(_unwrap_ip(ip_obj))
            if canonical not in seen:
                seen.add(canonical)
                resolved_ips.append(canonical)
        is_loopback = False

    request_target = parsed.path or '/'
    if parsed.query:
        request_target = f'{request_target}?{parsed.query}'

    return {
        'url': url,
        'redactedUrl': redact_url_for_display(url),
        'scheme': scheme,
        'hostname': hostname,
        'port': port,
        'path': parsed.path or '/',
        'requestTarget': request_target,
        'isLoopback': is_loopback,
        'resolvedIps': resolved_ips,
    }


def detect_http_mode(endpoint_url: str, configured_mode: str = 'auto') -> str:
    mode = str(configured_mode or 'auto').strip().lower()
    if mode in ('openai-speech', 'json', 'gradio'):
        return mode
    if mode != 'auto':
        raise ValueError(f'Unsupported http mode: {configured_mode}')
    path = (urllib.parse.urlsplit(endpoint_url).path or '').lower().rstrip('/')
    if path.endswith('/v1/audio/speech') or path.endswith('/audio/speech'):
        return 'openai-speech'
    if '/gradio_api/' in path or path.endswith('/api/predict') or path.endswith('/run/predict'):
        return 'gradio'
    return 'json'


def _named_parameters_for_callable(fn: Callable[..., Any]) -> Optional[set[str]]:
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return None
    return {
        name for name, param in sig.parameters.items()
        if param.kind in (
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        )
    }


def _filter_kwargs_for_callable(fn: Callable[..., Any], kwargs: Dict[str, Any]) -> Dict[str, Any]:
    """Strictly filter kwargs to explicitly named non-var parameters.

    Never passes arbitrary unfiltered kwargs even when **generation_kwargs is present,
    preventing unknown-argument crashes inside downstream HF generate() calls.
    """
    named = _named_parameters_for_callable(fn)
    if named is None:
        return kwargs
    return {k: v for k, v in kwargs.items() if k in named}


def read_wav_info(wav_path: Path) -> Dict[str, Any]:
    with wave.open(str(wav_path), 'rb') as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        nframes = wf.getnframes()
        duration = float(nframes) / float(framerate) if framerate > 0 else 0.0
    return {
        'channels': channels,
        'sampwidth': sampwidth,
        'framerate': framerate,
        'nframes': nframes,
        'duration': duration,
    }


def is_valid_wav_file(wav_path: Path, expected_sample_rate: Optional[int] = None) -> bool:
    if not wav_path.is_file() or wav_path.stat().st_size <= 44:
        return False
    try:
        info = read_wav_info(wav_path)
        if info['channels'] != 1 or info['sampwidth'] != 2 or info['framerate'] <= 0 or info['nframes'] <= 0:
            return False
        if expected_sample_rate is not None and info['framerate'] != int(expected_sample_rate):
            return False
        return True
    except Exception:
        return False


def wav_has_audible_signal(wav_path: Path) -> bool:
    """Return True if the 16-bit PCM WAV contains any non-zero sample energy."""
    try:
        with wave.open(str(wav_path), 'rb') as wf:
            if wf.getsampwidth() != 2:
                return True
            while True:
                raw = wf.readframes(32768)
                if not raw:
                    break
                samples = array.array('h')
                samples.frombytes(raw)
                if any(s != 0 for s in samples):
                    return True
            return False
    except Exception:
        return False


def write_silence_wav(wav_path: Path, duration_sec: float, sample_rate: int = DEFAULT_SAMPLE_RATE) -> float:
    sr, _ = validate_audio_params(sample_rate, DEFAULT_BITRATE_KBPS)
    nframes = max(1, int(round(max(0.05, float(duration_sec)) * sr)))
    wav_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(wav_path), 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(bytes(nframes * 2))
    return float(nframes) / float(sr)


def sniff_audio_demuxer(raw_bytes: bytes) -> str:
    """Strictly sniff single-file audio magic bytes; reject playlists (HLS/ffconcat) and unknown payloads."""
    if not isinstance(raw_bytes, (bytes, bytearray)) or len(raw_bytes) < 12:
        raise _NonRetryableIndexTTSError('HTTP audio payload is too short or empty')
    head = bytes(raw_bytes[:64])
    stripped_head = head.lstrip()
    # Explicitly reject playlist/text/HTML payloads
    lower_head = stripped_head.lower()
    if (lower_head.startswith(b'#extm3u')
            or lower_head.startswith(b'ffconcat')
            or lower_head.startswith(b'<!doctype')
            or lower_head.startswith(b'<html')):
        raise _NonRetryableIndexTTSError('Disallowed playlist or HTML payload received from HTTP TTS server')

    if raw_bytes[:4] == b'RIFF' and raw_bytes[8:12] == b'WAVE':
        return 'wav'
    if raw_bytes[:3] == b'ID3':
        return 'mp3'
    if (raw_bytes[0] == 0xFF
            and (raw_bytes[1] & 0xE0) == 0xE0
            and (raw_bytes[1] & 0x18) != 0x08
            and (raw_bytes[1] & 0x06) != 0x00
            and (raw_bytes[2] & 0xF0) != 0xF0
            and (raw_bytes[2] & 0x0C) != 0x0C):
        return 'mp3'
    if raw_bytes[:4] == b'fLaC':
        return 'flac'
    if raw_bytes[:4] == b'OggS':
        return 'ogg'
    if raw_bytes[4:8] == b'ftyp':
        return 'mov'
    raise _NonRetryableIndexTTSError('Unrecognized or disallowed HTTP audio format magic bytes')


def _run_ffmpeg_transcode_to_wav(
    src_path: Path,
    dst_wav: Path,
    *,
    demuxer: str,
    sample_rate: int,
    max_duration_sec: int = MAX_DECODE_DURATION_SECONDS,
) -> None:
    if demuxer not in ALLOWED_AUDIO_DEMUXERS:
        raise _NonRetryableIndexTTSError(f'Disallowed ffmpeg demuxer: {demuxer}')
    sr, _ = validate_audio_params(sample_rate, DEFAULT_BITRATE_KBPS)
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise IndexTTSError(f'ffmpeg is required to transcode {demuxer} audio to canonical {sr}Hz mono 16-bit WAV')
    src_abs = src_path.resolve()
    dst_abs = dst_wav.resolve()
    cmd = [
        ffmpeg, '-y', '-v', 'error',
        '-protocol_whitelist', 'file',
        '-f', demuxer,
    ]
    if demuxer == 'mov':
        cmd.extend(['-enable_drefs', '0'])
    cmd.extend([
        '-i', f'file:{src_abs}',
        '-vn', '-sn', '-dn',
        '-t', str(int(max_duration_sec)),
        '-ac', '1', '-ar', str(sr), '-sample_fmt', 's16',
        '-f', 'wav',
        f'file:{dst_abs}',
    ])
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=FFMPEG_CHUNK_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        raise IndexTTSError(f'ffmpeg transcode timed out after {FFMPEG_CHUNK_TIMEOUT_SECONDS}s') from exc
    if res.returncode != 0 or not is_valid_wav_file(dst_abs, expected_sample_rate=sr):
        raise IndexTTSError(f'ffmpeg WAV normalization failed: {res.stderr.strip()}')


def normalize_wav_format(src_wav: Path, dst_wav: Path, sample_rate: int = DEFAULT_SAMPLE_RATE) -> None:
    """Ensure a WAV file is canonical mono 16-bit PCM at sample_rate.

    Handles float32/IEEE WAV (wave.Error) via ffmpeg and fails closed if ffmpeg is
    absent on any mismatched WAV format.
    """
    sr, _ = validate_audio_params(sample_rate, DEFAULT_BITRATE_KBPS)
    try:
        info = read_wav_info(src_wav)
        if info['channels'] == 1 and info['sampwidth'] == 2 and info['framerate'] == sr and info['nframes'] > 0:
            if src_wav.resolve() != dst_wav.resolve():
                shutil.copyfile(src_wav, dst_wav)
            return
    except (wave.Error, EOFError):
        # e.g. IEEE float32 WAV (format tag 3) -> transcode safely via ffmpeg
        pass

    _run_ffmpeg_transcode_to_wav(src_wav, dst_wav, demuxer='wav', sample_rate=sr)


def convert_audio_bytes_to_wav(raw_bytes: bytes, dst_wav: Path, sample_rate: int = DEFAULT_SAMPLE_RATE) -> None:
    sr, _ = validate_audio_params(sample_rate, DEFAULT_BITRATE_KBPS)
    demuxer = sniff_audio_demuxer(raw_bytes)
    tmp_in = dst_wav.with_name(f'.{dst_wav.name}.in.{os.getpid()}.{demuxer}')
    tmp_in.write_bytes(raw_bytes)
    try:
        if demuxer == 'wav':
            normalize_wav_format(tmp_in, dst_wav, sample_rate=sr)
        else:
            _run_ffmpeg_transcode_to_wav(tmp_in, dst_wav, demuxer=demuxer, sample_rate=sr)
    finally:
        tmp_in.unlink(missing_ok=True)


class BaseTtsBackend:
    backend_name: str = 'base'
    engine_name: str = 'unknown'
    device: str = 'cpu'

    def cache_identity(self) -> Dict[str, Any]:
        return {'backend': self.backend_name, 'engine': self.engine_name}

    def synthesize_chunk(
        self,
        *,
        text: str,
        output_wav: Path,
        role: str,
        emotion_hint: str,
        emo_vector: List[float],
        emo_alpha: float,
        sample_rate: int,
    ) -> None:
        raise NotImplementedError


class SilentMockBackend(BaseTtsBackend):
    backend_name = 'silent-mock'
    engine_name = 'silent-mock'
    device = 'cpu'

    def __init__(self, *, seconds_per_chunk: Optional[float] = None, chars_per_second: float = 12.0):
        self.seconds_per_chunk = seconds_per_chunk
        self.chars_per_second = max(1.0, float(chars_per_second))

    def cache_identity(self) -> Dict[str, Any]:
        return {
            'backend': self.backend_name,
            'engine': self.engine_name,
            'secondsPerChunk': self.seconds_per_chunk,
            'charsPerSecond': self.chars_per_second,
        }

    def synthesize_chunk(
        self,
        *,
        text: str,
        output_wav: Path,
        role: str,
        emotion_hint: str,
        emo_vector: List[float],
        emo_alpha: float,
        sample_rate: int,
    ) -> None:
        if self.seconds_per_chunk is not None:
            dur = max(0.05, float(self.seconds_per_chunk))
        else:
            dur = max(0.25, min(6.0, round(len(text) / self.chars_per_second, 2)))
        write_silence_wav(output_wav, dur, sample_rate=sample_rate)


class IndexTTS2PythonBackend(BaseTtsBackend):
    backend_name = 'indextts2-python'

    def __init__(
        self,
        *,
        model_dir: str,
        cfg_path: Optional[str],
        voice_prompt: str,
        cohost_voice_prompt: Optional[str] = None,
        device: str = 'auto',
        use_fp16: Optional[bool] = None,
        use_cuda_kernel: bool = False,
    ):
        cls, status_label, engine_label, pkg_version = resolve_indextts_class()
        if cls is None:
            raise IndexTTSUnavailableError(
                f'IndexTTS Python package is not installed. {INDEXTTS_INSTALL_HINT}'
            )
        self._tts_cls = cls
        self.status_label = status_label
        self.engine_name = engine_label
        self.pkg_version = pkg_version
        self.is_v2 = status_label in ('IndexTTS2.5', 'IndexTTS2')

        torch_info = detect_torch_info(device)
        self.device = torch_info['device']
        self.model_dir = str(Path(model_dir).resolve())
        self.cfg_path = str(Path(cfg_path).resolve()) if cfg_path else str((Path(self.model_dir) / 'config.yaml').resolve())
        self.cfg_sha256 = sha256_file(Path(self.cfg_path)) if Path(self.cfg_path).is_file() else None
        self.voice_prompt = str(voice_prompt)
        self.cohost_voice_prompt = str(cohost_voice_prompt) if cohost_voice_prompt else self.voice_prompt

        if not self.voice_prompt or not Path(self.voice_prompt).is_file():
            raise IndexTTSError(f'Host voice prompt file not found: {self.voice_prompt}')
        if not Path(self.cohost_voice_prompt).is_file():
            raise IndexTTSError(f'Cohost voice prompt file not found: {self.cohost_voice_prompt}')

        self.voice_prompt_sha = sha256_file(Path(self.voice_prompt))
        self.cohost_voice_prompt_sha = sha256_file(Path(self.cohost_voice_prompt))
        self.use_fp16 = (self.device == 'cuda') if use_fp16 is None else bool(use_fp16)
        self.use_cuda_kernel = bool(use_cuda_kernel)
        self._model = None

    def _ensure_model(self) -> Any:
        if self._model is not None:
            return self._model
        init_kwargs: Dict[str, Any] = {
            'cfg_path': self.cfg_path,
            'model_dir': self.model_dir,
            'device': self.device,
        }
        if self.is_v2:
            init_kwargs['use_fp16'] = self.use_fp16
            init_kwargs['use_cuda_kernel'] = self.use_cuda_kernel
        filtered = _filter_kwargs_for_callable(self._tts_cls.__init__, init_kwargs)
        self._model = self._tts_cls(**filtered)
        return self._model

    def cache_identity(self) -> Dict[str, Any]:
        return {
            'backend': self.backend_name,
            'engine': self.engine_name,
            'status': self.status_label,
            'pkgVersion': self.pkg_version,
            'modelDir': self.model_dir,
            'cfgSha256': self.cfg_sha256,
            'useFp16': self.use_fp16,
            'voicePromptSha': self.voice_prompt_sha,
            'cohostVoicePromptSha': self.cohost_voice_prompt_sha,
        }

    def synthesize_chunk(
        self,
        *,
        text: str,
        output_wav: Path,
        role: str,
        emotion_hint: str,
        emo_vector: List[float],
        emo_alpha: float,
        sample_rate: int,
    ) -> None:
        model = self._ensure_model()
        prompt_path = self.cohost_voice_prompt if role == 'cohost' else self.voice_prompt
        raw_out = output_wav.with_suffix('.raw.wav')
        named_params = _named_parameters_for_callable(model.infer) or set()
        try:
            if self.is_v2:
                prompt_key = 'spk_audio_prompt'
                if 'spk_audio_prompt' not in named_params and 'audio_prompt' in named_params:
                    prompt_key = 'audio_prompt'
                infer_kwargs = {
                    prompt_key: prompt_path,
                    'text': text,
                    'output_path': str(raw_out),
                    'emo_vector': list(emo_vector),
                    'emo_alpha': float(emo_alpha),
                    'use_random': False,
                    'lang': 'ZH',
                    'verbose': False,
                }
            else:
                prompt_key = 'audio_prompt' if ('audio_prompt' in named_params or 'spk_audio_prompt' not in named_params) else 'spk_audio_prompt'
                infer_kwargs = {
                    prompt_key: prompt_path,
                    'text': text,
                    'output_path': str(raw_out),
                }
            filtered = _filter_kwargs_for_callable(model.infer, infer_kwargs)
            model.infer(**filtered)
            if not raw_out.is_file() or raw_out.stat().st_size == 0:
                raise IndexTTSError(f'IndexTTS model did not produce output WAV at {raw_out}')
            normalize_wav_format(raw_out, output_wav, sample_rate=sample_rate)
        finally:
            raw_out.unlink(missing_ok=True)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection that dials a pre-validated pinned IP directly, bypassing ambient proxies."""

    def __init__(self, pinned_ip: str, port: int, *, timeout: float):
        super().__init__(pinned_ip, port=port, timeout=timeout)
        self._pinned_ip = _canonical_ip_str(pinned_ip)

    def connect(self) -> None:
        sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)
        try:
            peer_ip = _canonical_ip_str(sock.getpeername()[0])
            if peer_ip != self._pinned_ip:
                raise EndpointValidationError(
                    f'Connected peer IP "{peer_ip}" does not match pinned IP "{self._pinned_ip}"'
                )
        except Exception:
            sock.close()
            raise
        self.sock = sock


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPSConnection that dials a pre-validated pinned IP directly with strict TLS SNI/cert verification."""

    def __init__(self, pinned_ip: str, port: int, *, server_hostname: str, timeout: float):
        ctx = ssl.create_default_context()
        ctx.check_hostname = True
        ctx.verify_mode = ssl.CERT_REQUIRED
        super().__init__(pinned_ip, port=port, timeout=timeout, context=ctx)
        self._pinned_ip = _canonical_ip_str(pinned_ip)
        self._server_hostname = server_hostname
        self._ssl_ctx = ctx

    def connect(self) -> None:
        raw_sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)
        try:
            peer_ip = _canonical_ip_str(raw_sock.getpeername()[0])
            if peer_ip != self._pinned_ip:
                raise EndpointValidationError(
                    f'Connected peer IP "{peer_ip}" does not match pinned IP "{self._pinned_ip}"'
                )
            wrapped = self._ssl_ctx.wrap_socket(raw_sock, server_hostname=self._server_hostname)
        except Exception:
            raw_sock.close()
            raise
        self.sock = wrapped


def _default_pinned_connection_factory(
    *,
    scheme: str,
    pinned_ip: str,
    port: int,
    hostname: str,
    timeout: float,
) -> http.client.HTTPConnection:
    if scheme == 'https':
        return _PinnedHTTPSConnection(pinned_ip, port, server_hostname=hostname, timeout=timeout)
    return _PinnedHTTPConnection(pinned_ip, port, timeout=timeout)


class IndexTTSHttpBackend(BaseTtsBackend):
    backend_name = 'indextts-http'
    engine_name = 'indextts-2.5'
    device = 'remote'

    def __init__(
        self,
        *,
        endpoint: str,
        http_mode: str = 'auto',
        model_name: str = DEFAULT_OPENAI_TTS_MODEL,
        voice_prompt: str = 'default',
        cohost_voice_prompt: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
        retries: int = DEFAULT_HTTP_RETRIES,
        allow_loopback: bool = False,
        dns_resolver: Optional[Callable[[str, int], Sequence[Tuple[Any, ...]]]] = None,
        connection_factory: Optional[Callable[..., Any]] = None,
    ):
        self.validated = validate_indextts_endpoint(
            endpoint,
            allow_loopback=allow_loopback,
            dns_resolver=dns_resolver,
        )
        self.endpoint = self.validated['url']
        self.redacted_endpoint = self.validated['redactedUrl']
        self.http_mode = detect_http_mode(self.endpoint, http_mode)
        self.model_name = str(model_name or DEFAULT_OPENAI_TTS_MODEL)
        self.voice_prompt = str(voice_prompt or 'default')
        self.cohost_voice_prompt = str(cohost_voice_prompt) if cohost_voice_prompt else self.voice_prompt
        self.api_key = str(api_key or '').strip()
        self.timeout_seconds = max(0.1, float(timeout_seconds))
        self.retries = max(0, int(retries))
        self._connection_factory = connection_factory or _default_pinned_connection_factory
        self.engine_name = 'indextts-2.5' if '2.5' in self.model_name else 'indextts-http'

    def cache_identity(self) -> Dict[str, Any]:
        return {
            'backend': self.backend_name,
            'httpMode': self.http_mode,
            'endpoint': self.redacted_endpoint,
            'model': self.model_name,
            'voicePrompt': self.voice_prompt,
            'cohostVoicePrompt': self.cohost_voice_prompt,
        }

    def build_request_payload(
        self,
        *,
        text: str,
        role: str,
        emotion_hint: str,
        emo_vector: List[float],
        emo_alpha: float,
    ) -> Dict[str, Any]:
        voice = self.cohost_voice_prompt if role == 'cohost' else self.voice_prompt
        if self.http_mode == 'openai-speech':
            return {
                'model': self.model_name,
                'input': text,
                'voice': voice,
                'response_format': 'wav',
                'extra_body': {
                    'spk_audio_prompt': voice,
                    'emo_vector': list(emo_vector),
                    'emo_alpha': float(emo_alpha),
                    'emotion_hint': emotion_hint,
                    'role': role,
                },
            }
        if self.http_mode == 'gradio':
            return {
                'data': [voice, text, list(emo_vector), float(emo_alpha)],
            }
        return {
            'model': self.model_name,
            'text': text,
            'role': role,
            'spk_audio_prompt': voice,
            'emo_vector': list(emo_vector),
            'emo_alpha': float(emo_alpha),
            'emotion_hint': emotion_hint,
            'response_format': 'wav',
        }

    def _host_header_value(self) -> str:
        hostname = self.validated['hostname']
        port = self.validated['port']
        scheme = self.validated['scheme']
        default_port = 443 if scheme == 'https' else 80
        host_fmt = f'[{hostname}]' if ':' in hostname else hostname
        return host_fmt if port == default_port else f'{host_fmt}:{port}'

    def _decode_http_audio(self, body: bytes, content_type: str) -> bytes:
        ctype = (content_type or '').lower()
        stripped = body.lstrip()
        if 'application/json' in ctype or stripped[:1] == b'{':
            try:
                parsed = json.loads(stripped.decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise _NonRetryableIndexTTSError(
                    f'IndexTTS HTTP JSON response could not be parsed ({self.redacted_endpoint}): {exc}'
                ) from exc
            if not isinstance(parsed, dict):
                raise _NonRetryableIndexTTSError(
                    f'IndexTTS HTTP JSON response must be an object ({self.redacted_endpoint})'
                )
            b64 = (
                parsed.get('audio_base64')
                or parsed.get('wav_base64')
                or parsed.get('audio')
            )
            if not b64 and isinstance(parsed.get('data'), list) and parsed['data']:
                first = parsed['data'][0]
                if isinstance(first, str):
                    b64 = first
                elif isinstance(first, dict):
                    b64 = first.get('data') or first.get('audio_base64')
            if not isinstance(b64, str) or not b64.strip():
                raise _NonRetryableIndexTTSError(
                    f'IndexTTS HTTP JSON response did not contain audio_base64 payload ({self.redacted_endpoint})'
                )
            b64 = b64.strip()
            if b64.startswith('data:') and ',' in b64:
                b64 = b64.split(',', 1)[1].strip()
            try:
                decoded = base64.b64decode(b64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise _NonRetryableIndexTTSError(
                    f'IndexTTS HTTP base64 audio payload is invalid ({self.redacted_endpoint}): {exc}'
                ) from exc
            if len(decoded) > MAX_HTTP_AUDIO_BYTES:
                raise _NonRetryableIndexTTSError(
                    f'Decoded HTTP audio exceeded {MAX_HTTP_AUDIO_BYTES} bytes limit ({self.redacted_endpoint})'
                )
            return decoded
        return body

    def _read_bounded_response(self, resp: Any, conn: Any, deadline: float) -> bytes:
        cl_header = resp.getheader('Content-Length') if hasattr(resp, 'getheader') else None
        if cl_header is not None:
            try:
                cl_int = int(str(cl_header).strip())
            except ValueError as exc:
                raise _NonRetryableIndexTTSError(
                    f'Invalid Content-Length header from {self.redacted_endpoint}'
                ) from exc
            if cl_int > MAX_HTTP_AUDIO_BYTES:
                raise _NonRetryableIndexTTSError(
                    f'IndexTTS HTTP Content-Length {cl_int} exceeds {MAX_HTTP_AUDIO_BYTES} bytes limit'
                )

        chunks: List[bytes] = []
        total = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f'IndexTTS HTTP response timed out after {self.timeout_seconds}s')
            sock = getattr(conn, 'sock', None)
            if sock is not None and hasattr(sock, 'settimeout'):
                sock.settimeout(remaining)
            piece = resp.read(HTTP_READ_CHUNK_BYTES)
            if not piece:
                break
            total += len(piece)
            if total > MAX_HTTP_AUDIO_BYTES:
                raise _NonRetryableIndexTTSError(
                    f'IndexTTS HTTP response exceeded {MAX_HTTP_AUDIO_BYTES} bytes limit'
                )
            chunks.append(piece)
        return b''.join(chunks)

    def _redact_error_text(self, message: Any) -> str:
        text = str(message)
        raw_query = urllib.parse.urlsplit(self.endpoint).query
        if raw_query:
            text = text.replace(f'?{raw_query}', '?<redacted>')
            text = text.replace(raw_query, '<redacted>')
        if self.api_key:
            text = text.replace(self.api_key, '<redacted>')
        text = re.sub(r'\?[^\s\'")\]]+', '?<redacted>', text)
        return text

    def synthesize_chunk(
        self,
        *,
        text: str,
        output_wav: Path,
        role: str,
        emotion_hint: str,
        emo_vector: List[float],
        emo_alpha: float,
        sample_rate: int,
    ) -> None:
        payload = self.build_request_payload(
            text=text,
            role=role,
            emotion_hint=emotion_hint,
            emo_vector=emo_vector,
            emo_alpha=emo_alpha,
        )
        body_bytes = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        headers = {
            'Host': self._host_header_value(),
            'Content-Type': 'application/json',
            'Accept': 'audio/wav, audio/mpeg, application/json',
            'Connection': 'close',
        }
        if self.api_key:
            headers['Authorization'] = f'Bearer {self.api_key}'

        resolved_ips = list(self.validated['resolvedIps'])
        last_err: Optional[Exception] = None

        for attempt in range(self.retries + 1):
            deadline = time.monotonic() + self.timeout_seconds
            for pinned_ip in resolved_ips:
                conn = None
                resp = None
                try:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError(f'IndexTTS HTTP request timed out after {self.timeout_seconds}s')
                    conn = self._connection_factory(
                        scheme=self.validated['scheme'],
                        pinned_ip=pinned_ip,
                        port=self.validated['port'],
                        hostname=self.validated['hostname'],
                        timeout=remaining,
                    )
                    conn.request('POST', self.validated['requestTarget'], body=body_bytes, headers=headers)
                    resp = conn.getresponse()
                    status = int(getattr(resp, 'status', 0))
                    if 300 <= status < 400:
                        raise EndpointValidationError(
                            f'HTTP redirects are forbidden for indextts-http (status {status} at {self.redacted_endpoint})'
                        )
                    if status == 429 or 500 <= status < 600:
                        raise IndexTTSError(
                            f'Transient IndexTTS HTTP status {status} from {self.redacted_endpoint}'
                        )
                    if not (200 <= status < 300):
                        raise _NonRetryableIndexTTSError(
                            f'IndexTTS HTTP non-retryable status {status} from {self.redacted_endpoint}'
                        )
                    raw_body = self._read_bounded_response(resp, conn, deadline)
                    if not raw_body:
                        raise _NonRetryableIndexTTSError(
                            f'IndexTTS HTTP response was empty ({self.redacted_endpoint})'
                        )
                    ctype = resp.getheader('Content-Type') if hasattr(resp, 'getheader') else ''
                    audio_bytes = self._decode_http_audio(raw_body, ctype or '')
                    convert_audio_bytes_to_wav(audio_bytes, output_wav, sample_rate=sample_rate)
                    return
                except http.client.InvalidURL as exc:
                    raise EndpointValidationError(
                        f'Invalid HTTP URL target for {self.redacted_endpoint}: {self._redact_error_text(exc)}'
                    ) from exc
                except EndpointValidationError as exc:
                    raise EndpointValidationError(self._redact_error_text(exc)) from exc
                except _NonRetryableIndexTTSError as exc:
                    raise _NonRetryableIndexTTSError(self._redact_error_text(exc)) from exc
                except OSError as exc:
                    # Connection-level failure (e.g. IPv4 127.0.0.1 refused while ::1 listens) -> failover to next IP
                    last_err = exc
                    continue
                except Exception as exc:
                    # Connected server returned 5xx/429 or protocol failure -> retry outer loop
                    last_err = exc
                    break
                finally:
                    if resp is not None and hasattr(resp, 'close'):
                        try:
                            resp.close()
                        except Exception:
                            pass
                    if conn is not None and hasattr(conn, 'close'):
                        try:
                            conn.close()
                        except Exception:
                            pass

            if attempt < self.retries:
                time.sleep(min(2.0, 0.25 * (2 ** attempt)))

        raise IndexTTSError(
            f'IndexTTS HTTP request to {self.redacted_endpoint} failed after {self.retries + 1} attempts: '
            f'{self._redact_error_text(last_err)}'
        )


def _probe_duration_ffprobe(audio_path: Path) -> Optional[float]:
    ffprobe = shutil.which('ffprobe')
    if not ffprobe:
        return None
    cmd = [
        ffprobe, '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        '--',
        str(audio_path.resolve()),
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=FFPROBE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return None
    if res.returncode != 0:
        return None
    try:
        val = float(res.stdout.strip())
        return val if val > 0 else None
    except ValueError:
        return None


def concat_wav_files(wav_paths: Sequence[Path], out_wav: Path, sample_rate: int = DEFAULT_SAMPLE_RATE) -> float:
    sr, _ = validate_audio_params(sample_rate, DEFAULT_BITRATE_KBPS)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    total_frames = 0
    with wave.open(str(out_wav), 'wb') as out_wf:
        out_wf.setnchannels(1)
        out_wf.setsampwidth(2)
        out_wf.setframerate(sr)
        for src in wav_paths:
            with wave.open(str(src), 'rb') as in_wf:
                if (in_wf.getnchannels() != 1
                        or in_wf.getsampwidth() != 2
                        or in_wf.getframerate() != sr):
                    raise IndexTTSError(f'Chunk WAV format mismatch in {src}')
                frames = in_wf.readframes(in_wf.getnframes())
                out_wf.writeframes(frames)
                total_frames += in_wf.getnframes()
    return float(total_frames) / float(sr)


def _atomic_copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f'.{dst.name}.tmp.{os.getpid()}{dst.suffix}')
    try:
        shutil.copyfile(src, tmp)
        os.replace(tmp, dst)
    finally:
        tmp.unlink(missing_ok=True)


def encode_final_audio(
    combined_wav: Path,
    output_path: Path,
    *,
    requested_format: str = 'mp3',
    bitrate_kbps: int = DEFAULT_BITRATE_KBPS,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    enable_loudnorm: bool = True,
) -> Dict[str, Any]:
    fmt = str(requested_format or 'mp3').strip().lower()
    if fmt not in ('mp3', 'wav', 'auto'):
        raise ValueError(f'Unsupported audio format: {requested_format}')
    sr, br = validate_audio_params(sample_rate, bitrate_kbps)

    ffmpeg = shutil.which('ffmpeg')
    want_mp3 = fmt == 'mp3' or (fmt == 'auto' and bool(ffmpeg))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    wav_abs = combined_wav.resolve()
    wav_dur = read_wav_info(wav_abs)['duration']

    if want_mp3 and ffmpeg:
        final_path = (output_path if output_path.suffix.lower() == '.mp3' else output_path.with_suffix('.mp3')).resolve()
        tmp_mp3 = final_path.with_name(f'.{final_path.name}.tmp.{os.getpid()}.mp3')
        loudnorm_applied = False
        probed: Optional[float] = None
        try:
            has_signal = wav_has_audible_signal(wav_abs)
            if enable_loudnorm and has_signal:
                cmd = [
                    ffmpeg, '-y', '-v', 'error',
                    '-protocol_whitelist', 'file',
                    '-f', 'wav',
                    '-i', f'file:{wav_abs}',
                    '-vn', '-sn', '-dn',
                    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
                    '-c:a', 'libmp3lame', '-b:a', f'{br}k',
                    '-ar', str(sr), '-ac', '1',
                    '-f', 'mp3',
                    f'file:{tmp_mp3}',
                ]
                try:
                    res = subprocess.run(
                        cmd, capture_output=True, text=True, check=False, timeout=FFMPEG_EPISODE_TIMEOUT_SECONDS
                    )
                except subprocess.TimeoutExpired:
                    res = None
                if res is not None and res.returncode == 0 and tmp_mp3.is_file() and tmp_mp3.stat().st_size > 0:
                    cand_probed = _probe_duration_ffprobe(tmp_mp3)
                    # Reject loudnorm output if duration drifted > 1.0s from WAV source
                    if cand_probed is None or abs(cand_probed - wav_dur) <= LOUDNORM_MAX_DRIFT_SECONDS:
                        loudnorm_applied = True
                        probed = cand_probed

            if not loudnorm_applied:
                cmd = [
                    ffmpeg, '-y', '-v', 'error',
                    '-protocol_whitelist', 'file',
                    '-f', 'wav',
                    '-i', f'file:{wav_abs}',
                    '-vn', '-sn', '-dn',
                    '-c:a', 'libmp3lame', '-b:a', f'{br}k',
                    '-ar', str(sr), '-ac', '1',
                    '-f', 'mp3',
                    f'file:{tmp_mp3}',
                ]
                try:
                    res = subprocess.run(
                        cmd, capture_output=True, text=True, check=False, timeout=FFMPEG_EPISODE_TIMEOUT_SECONDS
                    )
                except subprocess.TimeoutExpired as exc:
                    raise IndexTTSError(f'ffmpeg MP3 encoding timed out after {FFMPEG_EPISODE_TIMEOUT_SECONDS}s') from exc
                if res.returncode != 0 or not tmp_mp3.is_file() or tmp_mp3.stat().st_size == 0:
                    raise IndexTTSError(f'ffmpeg MP3 encoding failed: {res.stderr.strip()}')
                probed = _probe_duration_ffprobe(tmp_mp3)

            os.replace(tmp_mp3, final_path)
        finally:
            tmp_mp3.unlink(missing_ok=True)

        return {
            'audioPath': str(final_path),
            'audioFileName': final_path.name,
            'format': 'mp3',
            'mimeType': 'audio/mpeg',
            'bitrateKbps': br,
            'sampleRate': sr,
            'loudnessNormalized': loudnorm_applied,
            'durationSeconds': round(probed if probed is not None else wav_dur, 3),
        }

    # Pure-Python atomic WAV fallback when ffmpeg is absent or --format wav requested
    final_path = (output_path if output_path.suffix.lower() == '.wav' else output_path.with_suffix('.wav')).resolve()
    _atomic_copy_file(wav_abs, final_path)
    return {
        'audioPath': str(final_path),
        'audioFileName': final_path.name,
        'format': 'wav',
        'mimeType': 'audio/wav',
        'bitrateKbps': int((sr * 16) // 1000),
        'sampleRate': sr,
        'loudnessNormalized': False,
        'durationSeconds': round(wav_dur, 3),
    }


def _clamp_and_align_chapters(chapters: List[Dict[str, Any]], final_duration: float) -> List[Dict[str, Any]]:
    if not chapters:
        return chapters
    max_dur = round(max(0.0, float(final_duration)), 3)
    prev_end = 0.0
    aligned: List[Dict[str, Any]] = []
    for ch in chapters:
        start = round(max(prev_end, min(max_dur, float(ch['startSec']))), 3)
        end = round(max(start, min(max_dur, float(ch['endSec']))), 3)
        item = dict(ch)
        item['startSec'] = start
        item['endSec'] = end
        aligned.append(item)
        prev_end = end
    aligned[-1]['endSec'] = max_dur
    if aligned[-1]['startSec'] > aligned[-1]['endSec']:
        aligned[-1]['startSec'] = aligned[-1]['endSec']
    return aligned


def synthesize_podcast_script(
    script: Dict[str, Any],
    *,
    backend: BaseTtsBackend,
    output_path: Path,
    cache_dir: Optional[Path] = None,
    emo_alpha: float = 0.75,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    bitrate_kbps: int = DEFAULT_BITRATE_KBPS,
    audio_format: str = 'mp3',
    enable_loudnorm: bool = True,
) -> Dict[str, Any]:
    if not isinstance(script, dict) or not isinstance(script.get('segments'), list) or not script['segments']:
        raise ValueError('Podcast script must contain a non-empty segments list')
    if not (0.0 <= float(emo_alpha) <= 1.5):
        raise ValueError(f'emo_alpha must be between 0.0 and 1.5 (received: {emo_alpha})')
    sr, br = validate_audio_params(sample_rate, bitrate_kbps)

    out_path = Path(output_path)
    resolved_cache_dir = Path(cache_dir) if cache_dir else out_path.parent / '.indextts-cache'
    resolved_cache_dir.mkdir(parents=True, exist_ok=True)

    backend_identity = backend.cache_identity()
    concat_parts: List[Path] = []
    chapters: List[Dict[str, Any]] = []
    cache_hits = 0
    cache_misses = 0
    cursor_sec = 0.0

    with tempfile.TemporaryDirectory(prefix='indextts_synth_') as tmp_str:
        tmp_dir = Path(tmp_str)
        pause_cache: Dict[int, Path] = {}

        def get_pause_wav(ms: int) -> Optional[Path]:
            clamped = max(0, min(5000, int(ms)))
            if clamped <= 0:
                return None
            if clamped not in pause_cache:
                p_wav = tmp_dir / f'pause_{clamped}ms.wav'
                write_silence_wav(p_wav, clamped / 1000.0, sample_rate=sr)
                pause_cache[clamped] = p_wav
            return pause_cache[clamped]

        for seg_index, seg in enumerate(script['segments']):
            role = str(seg.get('role') or 'host')
            emotion_hint = str(seg.get('emotionHint') or 'calm')
            emo_vector = emotion_vector_for_hint(emotion_hint)
            raw_chunks = seg.get('chunks')
            chunks: List[str] = []
            if isinstance(raw_chunks, list) and raw_chunks:
                # Re-split any pre-split chunk exceeding DEFAULT_MAX_CHUNK_CHARS
                for raw_c in raw_chunks:
                    chunks.extend(split_text_chunks(str(raw_c or ''), DEFAULT_MAX_CHUNK_CHARS))
            else:
                chunks = split_text_chunks(str(seg.get('text') or ''), DEFAULT_MAX_CHUNK_CHARS)
            if not chunks:
                continue

            seg_start = cursor_sec
            for c_idx, chunk_text in enumerate(chunks):
                cache_key_obj = {
                    'backendIdentity': backend_identity,
                    'role': role,
                    'emotionHint': emotion_hint,
                    'emoVector': emo_vector,
                    'emoAlpha': round(float(emo_alpha), 4),
                    'sampleRate': sr,
                    'text': chunk_text,
                }
                chunk_hash = sha256_bytes(
                    json.dumps(cache_key_obj, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
                )
                cached_wav = resolved_cache_dir / f'{chunk_hash}.wav'

                if is_valid_wav_file(cached_wav, expected_sample_rate=sr):
                    cache_hits += 1
                else:
                    cache_misses += 1
                    tmp_chunk = resolved_cache_dir / f'{chunk_hash}.tmp.{os.getpid()}.wav'
                    try:
                        backend.synthesize_chunk(
                            text=chunk_text,
                            output_wav=tmp_chunk,
                            role=role,
                            emotion_hint=emotion_hint,
                            emo_vector=emo_vector,
                            emo_alpha=float(emo_alpha),
                            sample_rate=sr,
                        )
                        if not is_valid_wav_file(tmp_chunk, expected_sample_rate=sr):
                            raise IndexTTSError(
                                f'Synthesized chunk is not a valid mono 16-bit {sr}Hz WAV: {tmp_chunk}'
                            )
                        os.replace(tmp_chunk, cached_wav)
                    finally:
                        tmp_chunk.unlink(missing_ok=True)

                concat_parts.append(cached_wav)
                cursor_sec += read_wav_info(cached_wav)['duration']

                if c_idx < len(chunks) - 1:
                    inter_wav = get_pause_wav(DEFAULT_INTER_CHUNK_PAUSE_MS)
                    if inter_wav is not None:
                        concat_parts.append(inter_wav)
                        cursor_sec += read_wav_info(inter_wav)['duration']

            pause_ms = int(seg.get('pauseMsAfter') or 0)
            pause_wav = get_pause_wav(pause_ms)
            if pause_wav is not None:
                concat_parts.append(pause_wav)
                cursor_sec += read_wav_info(pause_wav)['duration']

            chapters.append({
                'index': len(chapters),
                'id': str(seg.get('id') or f'seg-{seg_index}'),
                'title': str(seg.get('title') or f'第 {seg_index + 1} 节'),
                'role': role,
                'startSec': round(seg_start, 3),
                'endSec': round(cursor_sec, 3),
                'paperId': seg.get('paperId') if seg.get('paperId') else None,
            })

        if not concat_parts:
            raise ValueError('No speakable chunks found in podcast script')

        combined_wav = tmp_dir / 'combined.wav'
        concat_wav_files(concat_parts, combined_wav, sample_rate=sr)
        encoded = encode_final_audio(
            combined_wav,
            out_path,
            requested_format=audio_format,
            bitrate_kbps=br,
            sample_rate=sr,
            enable_loudnorm=enable_loudnorm,
        )

    aligned_chapters = _clamp_and_align_chapters(chapters, encoded['durationSeconds'])
    final_audio_path = Path(encoded['audioPath'])
    audio_bytes = final_audio_path.stat().st_size
    audio_sha = sha256_file(final_audio_path)

    return {
        'contract': PODCAST_AUDIO_MANIFEST_CONTRACT,
        'date': script.get('date'),
        'title': script.get('title'),
        'scriptSha256': script.get('scriptSha256'),
        'backend': backend.backend_name,
        'ttsEngine': backend.engine_name,
        'device': backend.device,
        'audioPath': encoded['audioPath'],
        'audioFileName': encoded['audioFileName'],
        'format': encoded['format'],
        'mimeType': encoded['mimeType'],
        'audioBytes': audio_bytes,
        'audioSha256': audio_sha,
        'durationSeconds': encoded['durationSeconds'],
        'loudnessNormalized': encoded['loudnessNormalized'],
        'sampleRate': encoded['sampleRate'],
        'bitrateKbps': encoded['bitrateKbps'],
        'cacheStats': {
            'hits': cache_hits,
            'misses': cache_misses,
            'totalChunks': cache_hits + cache_misses,
        },
        'chapters': aligned_chapters,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Synthesize a Chinese daily audio podcast with IndexTTS latest (2.5 / 2.0 / HTTP / silent-mock).'
    )
    parser.add_argument('--check-env', action='store_true', help='Inspect Python, PyTorch device, IndexTTS, and ffmpeg.')
    parser.add_argument('--script', help='Path to daily-podcast-script-v1 JSON file.')
    parser.add_argument('--output', help='Output audio file path (e.g. podcast-2026-11-24.mp3).')
    parser.add_argument('--manifest-out', help='Optional path to write daily-podcast-audio-v1 manifest JSON.')
    parser.add_argument('--cache-dir', help='Deterministic per-chunk WAV cache directory.')
    parser.add_argument(
        '--backend',
        choices=('indextts2-python', 'indextts-http', 'silent-mock'),
        default='indextts2-python',
        help='TTS backend to use.',
    )
    parser.add_argument('--device', choices=('auto', 'cuda', 'mps', 'cpu'), default='auto')
    parser.add_argument('--model-dir', default=os.environ.get('PD_INDEXTTS_MODEL_DIR', 'checkpoints'))
    parser.add_argument('--cfg-path', default=os.environ.get('PD_INDEXTTS_CFG_PATH', ''))
    parser.add_argument('--voice-prompt', default=os.environ.get('PD_INDEXTTS_VOICE_PROMPT', ''))
    parser.add_argument('--cohost-voice-prompt', default=os.environ.get('PD_INDEXTTS_COHOST_VOICE_PROMPT', ''))
    parser.add_argument('--emo-alpha', type=float, default=0.75)
    parser.add_argument('--endpoint', default=os.environ.get('PD_INDEXTTS_ENDPOINT', ''))
    parser.add_argument('--http-mode', choices=('auto', 'openai-speech', 'json', 'gradio'), default='auto')
    parser.add_argument('--http-model', default=os.environ.get('PD_INDEXTTS_MODEL', DEFAULT_OPENAI_TTS_MODEL))
    parser.add_argument('--http-timeout', type=float, default=DEFAULT_HTTP_TIMEOUT_SECONDS)
    parser.add_argument('--http-retries', type=int, default=DEFAULT_HTTP_RETRIES)
    parser.add_argument(
        '--allow-local-endpoint',
        action='store_true',
        default=os.environ.get('PD_INDEXTTS_ALLOW_LOCAL_ENDPOINT', '') == '1',
        help='Explicitly allow loopback http://127.0.0.1 / localhost for local IndexTTS daemon.',
    )
    parser.add_argument('--format', choices=('mp3', 'wav', 'auto'), default='mp3')
    parser.add_argument('--sample-rate', type=int, default=DEFAULT_SAMPLE_RATE)
    parser.add_argument('--bitrate-kbps', type=int, default=DEFAULT_BITRATE_KBPS)
    parser.add_argument('--no-loudnorm', action='store_true', help='Disable ffmpeg loudnorm filter.')
    parser.add_argument('--mock-seconds-per-chunk', type=float, default=None, help='Fixed seconds per chunk for silent-mock.')
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.check_env:
        info = check_environment(args.device)
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return 0

    if not args.script or not args.output:
        parser.error('--script and --output are required unless --check-env is passed')

    script_path = Path(args.script)
    script_data = json.loads(script_path.read_text(encoding='utf-8'))

    if args.backend == 'silent-mock':
        backend: BaseTtsBackend = SilentMockBackend(seconds_per_chunk=args.mock_seconds_per_chunk)
    elif args.backend == 'indextts2-python':
        backend = IndexTTS2PythonBackend(
            model_dir=args.model_dir,
            cfg_path=args.cfg_path or None,
            voice_prompt=args.voice_prompt,
            cohost_voice_prompt=args.cohost_voice_prompt or None,
            device=args.device,
        )
    elif args.backend == 'indextts-http':
        backend = IndexTTSHttpBackend(
            endpoint=args.endpoint,
            http_mode=args.http_mode,
            model_name=args.http_model,
            voice_prompt=args.voice_prompt or 'default',
            cohost_voice_prompt=args.cohost_voice_prompt or None,
            api_key=os.environ.get('PD_INDEXTTS_API_KEY', ''),
            timeout_seconds=args.http_timeout,
            retries=args.http_retries,
            allow_loopback=args.allow_local_endpoint,
        )
    else:
        raise ValueError(f'Unsupported backend: {args.backend}')

    manifest = synthesize_podcast_script(
        script_data,
        backend=backend,
        output_path=Path(args.output),
        cache_dir=Path(args.cache_dir) if args.cache_dir else None,
        emo_alpha=args.emo_alpha,
        sample_rate=args.sample_rate,
        bitrate_kbps=args.bitrate_kbps,
        audio_format=args.format,
        enable_loudnorm=not args.no_loudnorm,
    )

    if args.manifest_out:
        manifest_path = Path(args.manifest_out)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_manifest = manifest_path.with_suffix(manifest_path.suffix + f'.tmp.{os.getpid()}')
        try:
            tmp_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            os.replace(tmp_manifest, manifest_path)
        finally:
            tmp_manifest.unlink(missing_ok=True)

    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    scripts_dir = Path(__file__).resolve().parent
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    import runtime_guard  # noqa: E402
    runtime_guard.require_external_runtime('indextts_synth.py')
    sys.exit(main())
