#!/usr/bin/env python3
"""Project-scoped environment loader.

Project scripts must use the current repository's .env for Paper Digest
configuration so inherited Trae/Codex/shell variables cannot be mixed with it.
"""

import os
import sys
from pathlib import Path
from urllib.parse import urlparse

from runtime_guard import require_external_runtime

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = PROJECT_ROOT / ".env"

PROJECT_ENV_PREFIXES = (
    "PAPER_ANALYZER_",
    "PAPER_DIGEST_",
    "PD_",
    "WECHAT_",
    "FEISHU_",
    "XIAOHONGSHU_",
)

PROJECT_ENV_KEYS = {
    "KIMI_API_KEY",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
}

CHILD_ENV_PASSTHROUGH_KEYS = (
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SYSTEMROOT", "WINDIR", "PATHEXT",
    "COMSPEC",
)
VCS_CHILD_ENV_KEYS = ("SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_TTY")
BROWSER_CHILD_ENV_KEYS = ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS")
TRANSPORT_ENV_KEYS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
)


def resolve_env_file(env_file=None):
    if env_file is not None:
        return Path(env_file)
    return DEFAULT_ENV_FILE


def is_project_env_key(key):
    return key in PROJECT_ENV_KEYS or any(key.startswith(prefix) for prefix in PROJECT_ENV_PREFIXES)


def parse_env_file(env_file=None):
    parsed = {}
    env_file = resolve_env_file(env_file)
    if not env_file.exists():
        return parsed

    try:
        env_file.chmod(0o600)
    except OSError:
        if os.name != "nt":
            raise

    with env_file.open("r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            value = value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            if key:
                parsed[key] = value

    return parsed


def load_project_env(env_file=None):
    parsed = parse_env_file(env_file)

    for key in list(os.environ.keys()):
        if is_project_env_key(key):
            os.environ.pop(key, None)

    os.environ.update(parsed)
    return parsed


def build_child_process_env(extra=None, allowed_keys=()):
    env = {
        key: os.environ[key]
        for key in (*CHILD_ENV_PASSTHROUGH_KEYS, *allowed_keys)
        if key in os.environ
    }
    if extra:
        env.update(extra)
    return env


def get_required_fetch_proxy():
    """Return the project-scoped HTTP CONNECT proxy required for arXiv/HF fetches."""
    proxy = (
        os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
        or os.environ.get("http_proxy") or os.environ.get("HTTP_PROXY")
    )
    if not proxy:
        raise RuntimeError('抓取 arXiv/HuggingFace 必须在项目 .env 配置 HTTPS_PROXY 或 HTTP_PROXY')
    parsed = urlparse(proxy)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise RuntimeError(f'Python 抓取只支持 HTTP CONNECT 代理，收到: {proxy}')
    return proxy


def build_fetch_proxies():
    """Build explicit requests proxies without reading inherited process settings."""
    proxy = get_required_fetch_proxy()
    return {'http': proxy, 'https': proxy}


def build_fetch_url_opener():
    """Build an explicit urllib opener for arXiv/HuggingFace assets only."""
    import urllib.request
    proxy = get_required_fetch_proxy()
    return urllib.request.build_opener(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))


def _is_scripts_entrypoint():
    if not sys.argv or not sys.argv[0]:
        return False
    try:
        entry = Path(sys.argv[0]).resolve()
    except OSError:
        return False
    return entry.parent == Path(__file__).resolve().parent and entry.suffix == '.py'


# Run only for a direct scripts/*.py entrypoint, never when tests import modules.
if _is_scripts_entrypoint():
    require_external_runtime(Path(sys.argv[0]).name)
