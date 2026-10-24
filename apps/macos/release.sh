#!/bin/bash
set -euo pipefail
[[ -z "${CODEX_SANDBOX:-}" ]] || { echo '请在本机正常开发环境准备发行产物。' >&2; exit 1; }
app_root="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$app_root/../.." && pwd)"
cd "$repo_root"
exec bash "$repo_root/scripts/python-runtime.sh" "$app_root/release_tools.py" "$@"
