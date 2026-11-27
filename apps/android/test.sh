#!/bin/bash
set -euo pipefail
[[ -z "${CODEX_SANDBOX:-}" ]] || { echo "请在正常本机环境运行 Android 测试。" >&2; exit 1; }
app_root="$(cd "$(dirname "$0")" && pwd)"
if [[ "${1:-}" == --device ]]; then
 shift
 qa_serial="${ANDROID_SERIAL:-}"
 if [[ -n "${1:-}" && "${1:0:1}" != - ]]; then qa_serial="$1"; shift; fi
 [[ -n "$qa_serial" && "$qa_serial" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || { echo "设备测试须明确选择一个设备：test.sh --device SERIAL，或设置 ANDROID_SERIAL。" >&2; exit 1; }
 for qa_argument in "$@"; do
  [[ "$qa_argument" == -* ]] || { echo "测试入口只接受 Gradle 选项；其他构建任务请使用 build.sh。" >&2; exit 1; }
  case "$qa_argument" in --serial*|-Pandroid.injected.device.serial=*|-Dandroid.injected.device.serial=*) echo "设备已由 --device 或 ANDROID_SERIAL 唯一选定，请勿再附加设备覆盖参数。" >&2; exit 1;; esac
  case "$qa_argument" in -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=*) [[ "$qa_argument" == -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true ]] || { echo "设备测试结束后必须保留应用和验收资料，不接受自动卸载选项。" >&2; exit 1; };; esac
 done
 qa_state="$(adb -s "$qa_serial" get-state 2>/dev/null)" || { echo "指定设备不可用，未开始测试。" >&2; exit 1; }
 [[ "$qa_state" == device ]] || { echo "指定设备未就绪，未开始测试。" >&2; exit 1; }
 if [[ "$qa_serial" == emulator-* ]]; then
  qa_avd="$(adb -s "$qa_serial" emu avd name | tr -d '\r' | sed '/^OK$/d')"
  [[ "$qa_avd" == PaperDigest_QA_API35 || "$qa_avd" == PaperDigest_QA_API28 ]] || { echo "这不是音频研究工作台独立验收设备，未开始测试。" >&2; exit 1; }
 fi
 # AGP ConnectedDeviceProvider filters connected devices using this exact single serial.
 export ANDROID_SERIAL="$qa_serial"
 # AGP otherwise uninstalls the target and deletes its data after connected tests.
 exec "$app_root/build.sh" :app:connectedDebugAndroidTest "$@" -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true
fi
for qa_argument in "$@"; do
 [[ "$qa_argument" == -* ]] || { echo "测试入口只接受 Gradle 选项；设备测试请使用 --device SERIAL，其他任务请使用 build.sh。" >&2; exit 1; }
done
py_tests=(
 DeviceSelection.test.py
 WorkbenchBranding.test.py
 CompiledSecurityResources.test.py
 ReleasePackaging.test.py
 AndroidReleaseStages.test.py
 ReleaseBoundaries.test.py
 ReleaseKeystoreCanonical.test.py
 ReleaseCompiledIcon.test.py
 ReleasePackagedAssets.test.py
 ReleaseSignatureSchemes.test.py
 ReleaseFinalizeSigned.test.py
)
cjs_tests=(
 DocumentTables.test.cjs
)
mjs_tests=(
 AssetsChannel.test.mjs
)
# 完整性守卫：确保 Tests/*.test.py、Tests/*.test.cjs 与 *.test.mjs 均已登记且真实存在，防止新增测试静默漏跑。
shopt -s nullglob
for discovered in "$app_root"/Tests/*.test.py; do
 base="$(basename "$discovered")"
 known=0
 for declared in "${py_tests[@]}"; do
  if [[ "$base" == "$declared" ]]; then known=1; break; fi
 done
 if [[ "$known" -ne 1 ]]; then
  echo "Android 测试未接入：Tests/${base} 不在 py_tests 清单中，请先登记到 $app_root/test.sh。" >&2
  exit 1
 fi
done
for discovered in "$app_root"/Tests/*.test.cjs; do
 base="$(basename "$discovered")"
 known=0
 for declared in "${cjs_tests[@]}"; do
  if [[ "$base" == "$declared" ]]; then known=1; break; fi
 done
 if [[ "$known" -ne 1 ]]; then
  echo "Android 测试未接入：Tests/${base} 不在 cjs_tests 清单中，请先登记到 $app_root/test.sh。" >&2
  exit 1
 fi
done
for discovered in "$app_root"/*.test.mjs "$app_root"/Tests/*.test.mjs; do
 rel="${discovered#"$app_root"/}"
 known=0
 for declared in "${mjs_tests[@]}"; do
  if [[ "$rel" == "$declared" ]]; then known=1; break; fi
 done
 if [[ "$known" -ne 1 ]]; then
  echo "Android 测试未接入：${rel} 不在 mjs_tests 清单中，请先登记到 $app_root/test.sh。" >&2
  exit 1
 fi
done
shopt -u nullglob
for declared in "${py_tests[@]}"; do
 [[ -f "$app_root/Tests/$declared" ]] || { echo "Android 测试缺失：Tests/${declared} 不存在。" >&2; exit 1; }
done
for declared in "${cjs_tests[@]}"; do
 [[ -f "$app_root/Tests/$declared" ]] || { echo "Android 测试缺失：Tests/${declared} 不存在。" >&2; exit 1; }
done
for declared in "${mjs_tests[@]}"; do
 [[ -f "$app_root/$declared" ]] || { echo "Android 测试缺失：${declared} 不存在。" >&2; exit 1; }
done
for py_test in "${py_tests[@]}"; do
 bash "$app_root/../../scripts/python-runtime.sh" "$app_root/Tests/$py_test"
done
android_cjs_tmp="$(mktemp -d "${TMPDIR:-/tmp}/android-document-tables.XXXXXX")"
cleanup_android_cjs_tmp() {
 [[ -n "${android_cjs_tmp:-}" && -d "$android_cjs_tmp" ]] && rm -rf "$android_cjs_tmp" || true
}
trap cleanup_android_cjs_tmp EXIT
for cjs_test in "${cjs_tests[@]}"; do
 cjs_out="$android_cjs_tmp/$(basename "$cjs_test" .cjs)"
 mkdir -p "$cjs_out"
 PD_DOCUMENT_TABLE_OUTPUT="$cjs_out" node "$app_root/Tests/$cjs_test"
done
# exec 会替换当前进程导致 EXIT trap 不再执行，因此在移交 Gradle 前显式清理临时目录。
cleanup_android_cjs_tmp
android_cjs_tmp=''
trap - EXIT
# 资产通道的 17 个负例此前只有文件、没有执行入口；这里与其它非设备检查同列。
for mjs_test in "${mjs_tests[@]}"; do
 node --test "$app_root/$mjs_test"
done
exec "$app_root/build.sh" :app:testDebugUnitTest :app:lintDebug "$@"
