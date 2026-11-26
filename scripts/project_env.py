#!/usr/bin/env python3
"""项目内环境变量加载器。

项目脚本读取 Audio Research Workbench 配置时必须用当前仓库的 .env，避免混入从
启动程序或终端继承来的变量。
唯一例外是显式出版恢复清单路径；它是受严格来源核验的进程输入，不改变模型或代理配置。
"""

import errno
import os
import stat
import sys
from pathlib import Path

from public_network_policy import is_valid_http_connect_proxy_url
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
    "MIMO_API_KEY",
    "DEEPSEEK_API_KEY",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
}

# 仅保留受严格核验的进程级输入/已核验 Python 解释器标记，不改变模型或代理配置。
PROCESS_INPUT_KEYS = (
    "PD_PUBLISH_RASTER_RECOVERY_FILE",
    "PD_PYTHON_RUNTIME_VERIFIED_BIN",
)

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
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(env_file, flags)
    except FileNotFoundError:
        return parsed
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise RuntimeError(f"项目 .env 必须是无硬链接的普通文件，禁止符号链接: {env_file}") from exc
        raise
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or (os.name != "nt" and opened.st_nlink != 1):
            raise RuntimeError(f"项目 .env 必须是无硬链接的普通文件，禁止符号链接: {env_file}")
        if os.name == "nt":
            try:
                env_file.chmod(0o600)
            except OSError:
                pass
        elif stat.S_IMODE(opened.st_mode) != 0o600 and hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        max_bytes = 2 * 1024 * 1024
        if opened.st_size > max_bytes:
            raise RuntimeError(f"项目 .env 超过大小限制 ({max_bytes} bytes): {env_file}")
        chunks = []
        remaining = max_bytes + 1
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > max_bytes:
            raise RuntimeError(f"项目 .env 超过大小限制 ({max_bytes} bytes): {env_file}")
    finally:
        os.close(fd)

    first_lines = {}
    for line_no, line in enumerate(raw.decode("utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and ((value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'"))):
            value = value[1:-1]
        if key:
            if key in first_lines:
                print(
                    f"[project_env] 第 {first_lines[key]} 行和第 {line_no} 行重复定义 {key}；采用后一项的值",
                    file=sys.stderr,
                )
            else:
                first_lines[key] = line_no
            parsed[key] = value

    return parsed


def load_project_env(env_file=None):
    process_inputs = {key: os.environ[key] for key in PROCESS_INPUT_KEYS if key in os.environ}
    parsed = parse_env_file(env_file)

    for key in list(os.environ.keys()):
        if is_project_env_key(key):
            os.environ.pop(key, None)

    os.environ.update(parsed)
    os.environ.update(process_inputs)
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
    """返回 arXiv/HF 抓取所需的项目内 HTTP CONNECT 代理。"""
    proxy_key = next((key for key in (
        "https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"
    ) if os.environ.get(key)), None)
    if proxy_key is None:
        raise RuntimeError('抓取 arXiv/HuggingFace 必须在项目 .env 配置 HTTPS_PROXY 或 HTTP_PROXY')
    proxy = os.environ[proxy_key]
    invalid_proxy_message = (
        f'Python 抓取只支持 HTTP CONNECT 代理；请检查 {proxy_key} '
        '是否为包含主机名的 http:// 或 https:// 地址'
    )
    if not is_valid_http_connect_proxy_url(proxy):
        raise RuntimeError(invalid_proxy_message)
    return proxy


def build_fetch_proxies():
    """把当前配置的 HTTP CONNECT 代理分别用于 requests 的 HTTP 和 HTTPS 请求。"""
    proxy = get_required_fetch_proxy()
    return {'http': proxy, 'https': proxy}


def build_fetch_url_opener():
    """为 arXiv/HuggingFace 资源创建明确使用 HTTP CONNECT 代理的 urllib 请求对象。"""
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
    project_root = Path(__file__).resolve().parent.parent
    entry_roots = {
        Path(__file__).resolve().parent,
        project_root / 'manual' / 'scripts',
    }
    return entry.parent in entry_roots and entry.suffix == '.py'


# 仅在直接执行共享脚本或 Manual 命令入口时运行，被 import 时不执行。
if _is_scripts_entrypoint():
    require_external_runtime(Path(sys.argv[0]).name)
