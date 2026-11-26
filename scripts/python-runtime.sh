#!/usr/bin/env bash
set -euo pipefail

# Python 命令统一使用受支持的解释器和 OpenSSL。
# 优先使用项目内不纳入版本控制的虚拟环境（按脚本相对仓库根目录定位，不依赖调用方 cwd）。
repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${PD_PYTHON_RUNTIME_DISABLE_VENV:-0}" != "1" && -x "${repo_root}/.venv/bin/python" ]]; then
  python_bin="${repo_root}/.venv/bin/python"
elif command -v python3.11 >/dev/null 2>&1; then
  python_bin="$(command -v python3.11)"
elif command -v python3 >/dev/null 2>&1; then
  python_bin="$(command -v python3)"
else
  echo "Python 3.11+ 未安装；请先安装受支持的 Python/OpenSSL 运行时" >&2
  exit 1
fi

if [[ "${PD_PYTHON_RUNTIME_VERIFIED_BIN:-}" != "$python_bin" ]]; then
  "$python_bin" -c '
import ssl
import sys

if sys.version_info < (3, 11):
    raise SystemExit(f"需要 Python >= 3.11，当前为 {sys.version.split()[0]}")
if not ssl.OPENSSL_VERSION.startswith("OpenSSL "):
    raise SystemExit(f"Python 需要使用 OpenSSL 提供 TLS，当前为 {ssl.OPENSSL_VERSION}")
' || {
    echo "Python 运行时检查失败；请创建项目 .venv 或安装合规的 python3.11" >&2
    exit 1
  }
  export PD_PYTHON_RUNTIME_VERIFIED_BIN="$python_bin"
fi

exec "$python_bin" ${1+"$@"}
