#!/usr/bin/env bash
set -euo pipefail

# Default/shared Python entrypoints require a maintained interpreter and
# OpenSSL-backed TLS. Prefer the repository-local, gitignored environment.
if [[ "${PD_PYTHON_RUNTIME_DISABLE_VENV:-0}" != "1" && -x ".venv/bin/python" ]]; then
  python_bin=".venv/bin/python"
elif command -v python3.11 >/dev/null 2>&1; then
  python_bin="$(command -v python3.11)"
elif command -v python3 >/dev/null 2>&1; then
  python_bin="$(command -v python3)"
else
  echo "Python 3.11+ 未安装；请先安装受支持的 Python/OpenSSL 运行时" >&2
  exit 1
fi

"$python_bin" -c '
import ssl
import sys

if sys.version_info < (3, 11):
    raise SystemExit(f"需要 Python >= 3.11，当前为 {sys.version.split()[0]}")
if not ssl.OPENSSL_VERSION.startswith("OpenSSL "):
    raise SystemExit(f"需要 OpenSSL-backed Python，当前为 {ssl.OPENSSL_VERSION}")
' || {
  echo "Python 运行时检查失败；请创建项目 .venv 或安装合规的 python3.11" >&2
  exit 1
}

exec "$python_bin" "$@"
