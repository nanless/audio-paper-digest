#!/bin/bash
set -euo pipefail
[[ -z "${CODEX_SANDBOX:-}" ]] || { echo "请在正常本机环境运行 Android 构建。" >&2; exit 1; }
app_root="$(cd "$(dirname "$0")" && pwd)"
if [[ -z "${JAVA_HOME:-}" && -x /opt/homebrew/opt/openjdk@17/bin/java ]]; then export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home; fi
if [[ -z "${ANDROID_HOME:-}" ]]; then
 if [[ -d "$HOME/Library/Android/sdk" ]]; then export ANDROID_HOME="$HOME/Library/Android/sdk";
 elif [[ -d /opt/homebrew/share/android-commandlinetools ]]; then export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools; fi
fi
cd "$app_root"
if [[ $# -eq 0 ]]; then set -- :app:assembleDebug; fi
exec ./gradlew --no-daemon "$@"
