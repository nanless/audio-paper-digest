#!/bin/bash
set -euo pipefail
[[ -z "${CODEX_SANDBOX:-}" ]] || { echo '请在本机正常开发环境执行测试。' >&2; exit 1; }
app_root="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$app_root/../.." && pwd)"
cd "$repo_root"
test_work="$(mktemp -d "${TMPDIR:-/tmp}/paperdigest-tests.XXXXXX")"
trap 'rm -rf "$test_work"' EXIT
mkdir "$test_work/Sources"
cp "$app_root"/Sources/*.swift "$test_work/Sources/"
sources=("$test_work"/Sources/*.swift)
for suite in DesktopStore BackupCodec DesktopStorage DesktopNative DesktopEvidenceReview DesktopProvenanceReview DesktopContextReview LibraryService ZoteroService; do
  echo "正在核验 ${suite}（隔离临时资料，不访问用户文库或付费服务）"
  xcrun swiftc -parse-as-library -D PAPER_DIGEST_TESTS "${sources[@]}" "$app_root/Tests/${suite}Tests.swift" -o "$test_work/$suite"
  "$test_work/$suite"
done
node --test "$app_root/Tests/DesktopProtocolReview.test.cjs" "$repo_root/tests/llm-declared-protocol.test.js"
node "$app_root/Tests/LibraryPDFRevalidation.test.cjs"
node "$app_root/Tests/ModelWorker.test.cjs"
node "$app_root/Tests/LibraryUI.test.cjs"
node "$app_root/Tests/SettingsUI.test.cjs"
node "$app_root/Tests/DesktopUI.test.cjs"
node "$app_root/Tests/DesktopContextUI.test.cjs"
echo '隔离自动测试完成；真实窗口、模型服务与 Zotero 归档仍须按验收矩阵分别核验。'
