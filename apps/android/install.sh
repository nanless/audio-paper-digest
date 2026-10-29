#!/bin/bash
set -euo pipefail
[[ -z "${CODEX_SANDBOX:-}" ]] || { echo "请在正常本机环境安装。" >&2; exit 1; }
app_root="$(cd "$(dirname "$0")" && pwd)"
serial="${1:-emulator-5580}"
apk="${2:-$app_root/app/build/outputs/apk/debug/app-debug.apk}"
[[ -f "$apk" && ! -L "$apk" ]] || { echo "请先构建实际 APK。" >&2; exit 1; }
if [[ "$serial" == emulator-* ]]; then
 avd_name="$(adb -s "$serial" emu avd name | tr -d '\r' | sed '/^OK$/d')"
 [[ "$avd_name" == PaperDigest_QA_API35 || "$avd_name" == PaperDigest_QA_API28 ]] || { echo "这不是论文速递工作台独立验收设备，未安装。" >&2; exit 1; }
fi
adb -s "$serial" install -r -t "$apk"
