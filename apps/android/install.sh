#!/bin/bash
set -euo pipefail
[[ -z "${CODEX_SANDBOX:-}" ]] || { echo "请在正常本机环境安装。" >&2; exit 1; }
app_root="$(cd "$(dirname "$0")" && pwd)"
[[ "$#" -le 2 ]] || { echo "安装只接受一个明确设备和一个 APK：install.sh SERIAL [APK]。" >&2; exit 1; }
serial="${1:-${ANDROID_SERIAL:-}}"
[[ -n "$serial" && "$serial" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || { echo "安装须明确选择一个设备：install.sh SERIAL [APK]，或设置 ANDROID_SERIAL。" >&2; exit 1; }
apk="${2:-$app_root/app/build/outputs/apk/debug/app-debug.apk}"
[[ -f "$apk" && ! -L "$apk" ]] || { echo "请先构建实际 APK。" >&2; exit 1; }
device_state="$(adb -s "$serial" get-state 2>/dev/null)" || { echo "指定设备不可用，未安装。" >&2; exit 1; }
[[ "$device_state" == device ]] || { echo "指定设备未就绪，未安装。" >&2; exit 1; }
if [[ "$serial" == emulator-* ]]; then
 avd_name="$(adb -s "$serial" emu avd name | tr -d '\r' | sed '/^OK$/d')"
 [[ "$avd_name" == PaperDigest_QA_API35 || "$avd_name" == PaperDigest_QA_API28 ]] || { echo "这不是论文速递工作台独立验收设备，未安装。" >&2; exit 1; }
fi
adb -s "$serial" install -r -t "$apk"
