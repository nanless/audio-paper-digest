#!/bin/bash
set -euo pipefail
[[ -z "${CODEX_SANDBOX:-}" ]] || { echo "请在正常本机环境运行 Android 测试。" >&2; exit 1; }
app_root="$(cd "$(dirname "$0")" && pwd)"
if [[ "${1:-}" == --device ]]; then
 shift
 qa_serial="${ANDROID_SERIAL:-}"
 if [[ -n "${1:-}" && "${1:0:1}" != - ]]; then qa_serial="$1"; shift; fi
 [[ -n "$qa_serial" && "$qa_serial" =~ ^[A-Za-z0-9._:-]+$ ]] || { echo "设备测试须明确选择一个设备：test.sh --device SERIAL，或设置 ANDROID_SERIAL。" >&2; exit 1; }
 for qa_argument in "$@"; do
  [[ "$qa_argument" == -* ]] || { echo "测试入口只接受 Gradle 选项；其他构建任务请使用 build.sh。" >&2; exit 1; }
  case "$qa_argument" in --serial*|-Pandroid.injected.device.serial=*|-Dandroid.injected.device.serial=*) echo "设备已由 --device 或 ANDROID_SERIAL 唯一选定，请勿再附加设备覆盖参数。" >&2; exit 1;; esac
 done
 qa_state="$(adb -s "$qa_serial" get-state 2>/dev/null)" || { echo "指定设备不可用，未开始测试。" >&2; exit 1; }
 [[ "$qa_state" == device ]] || { echo "指定设备未就绪，未开始测试。" >&2; exit 1; }
 if [[ "$qa_serial" == emulator-* ]]; then
  qa_avd="$(adb -s "$qa_serial" emu avd name | tr -d '\r' | sed '/^OK$/d')"
  [[ "$qa_avd" == PaperDigest_QA_API35 || "$qa_avd" == PaperDigest_QA_API28 ]] || { echo "这不是论文速递独立验收设备，未开始测试。" >&2; exit 1; }
 fi
 # AGP ConnectedDeviceProvider filters connected devices using this exact single serial.
 export ANDROID_SERIAL="$qa_serial"
 exec "$app_root/build.sh" :app:connectedDebugAndroidTest "$@"
fi
for qa_argument in "$@"; do
 [[ "$qa_argument" == -* ]] || { echo "测试入口只接受 Gradle 选项；设备测试请使用 --device SERIAL，其他任务请使用 build.sh。" >&2; exit 1; }
done
bash "$app_root/../../scripts/python-runtime.sh" "$app_root/Tests/DeviceSelection.test.py"
exec "$app_root/build.sh" :app:testDebugUnitTest :app:lintDebug "$@"
