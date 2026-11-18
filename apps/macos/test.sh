#!/bin/bash
set -euo pipefail
[[ -z "${CODEX_SANDBOX:-}" ]] || { echo '请在本机正常开发环境执行测试。' >&2; exit 1; }
app_root="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$app_root/../.." && pwd)"
cd "$repo_root"
swift_suites=(ClientProtocols PublicProtocolEndpoints DesktopStore FavoriteCollections BackupCodec ReleaseBootstrap ReleaseEmptyLibrary PersonalWebDavSync NoteConflictMerger FullWebDavSync SyncedArchiveHistory CloudArchiveService CloudSessionCredentials CloudIntegrationReview DesktopStorage DesktopStorageDetail DesktopNativeDetails DesktopNative DesktopEvidenceReview DesktopProvenanceReview DesktopContextReview DesktopArchiveIdentity DesktopReaderLink ModelEvidenceExport DesktopAppDocsEvidence DesktopDiagnostics LibraryService NativeLibraryAccessibility WebsiteClassification LibraryCatalogPaging CatalogScheduling LibraryImageSources LibraryMathML PublishedSourceWarning PublishedAggregate AggregatePreload AggregateReadScope AggregateImageReadScope AggregatePresentation AggregateResources AggregateResourceTransport AggregateResourceBudget AggregateSystemPaths ReaderSourceNoticeSnapshot ZoteroService NativeTaskPresentation NativeAggregateTask AggregateReady NativeAggregateHost NativeTaskUsageAliases NativeTasksHostProtocol NativeTasksHostMain NativeTasksHostProgress NativeNotesHost NativeNotesHostMain NativeWorkspaceFocus NativeWorkspaceScroll NativeWorkspaceAttachment)
cjs_suites=(ModelService)
# 清单是手写的：Tests/ 下每个 *Tests.swift 都必须接入，否则新增套件会静默漏跑。
# ModelServiceTests 由 ModelWorker.test.cjs 显式编译并 spawn，因此只登记为 CJS 例外。
shopt -s nullglob
suite_total=0
for suite_file in "$app_root"/Tests/*Tests.swift; do
  suite_total=$((suite_total + 1))
  suite_name="$(basename "$suite_file")"
  suite_name="${suite_name%Tests.swift}"
  suite_known=0
  for known in "${swift_suites[@]}" "${cjs_suites[@]}"; do
    if [[ "$suite_name" == "$known" ]]; then suite_known=1; break; fi
  done
  if [[ "$suite_known" -ne 1 ]]; then
    echo "套件未接入：Tests/${suite_name}Tests.swift 既不在 swift_suites，也不是已接线的 CJS 例外。" >&2
    echo "请先把它接入 $app_root/test.sh，避免该套件静默漏跑。" >&2
    exit 1
  fi
done
shopt -u nullglob
for known in "${cjs_suites[@]}"; do
  if ! grep -Fq "${known}Tests.swift" "$app_root/Tests/ModelWorker.test.cjs" 2>/dev/null; then
    echo "CJS 例外失效：ModelWorker.test.cjs 没有编译 Tests/${known}Tests.swift；请同步 test.sh。" >&2
    exit 1
  fi
done
bash "$repo_root/scripts/python-runtime.sh" "$repo_root/apps/generate-client-protocols.py" --check
test_work="$(mktemp -d "${TMPDIR:-/tmp}/paperdigest-tests.XXXXXX")"
compile_pids=()
cleanup_test_work() {
  if [[ "${#compile_pids[@]}" -gt 0 ]]; then
    for pid in "${compile_pids[@]}"; do
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    done
  fi
  rm -rf "$test_work"
}
trap cleanup_test_work EXIT
mkdir -p "$test_work/Sources" "$test_work/Modules" "$test_work/Tests"
cp "$app_root"/Sources/*.swift "$test_work/Sources/"
sources=("$test_work"/Sources/*.swift)
swift_executed=0
swift_skipped=0
cjs_executed=0
optional_skipped=0
if [[ "$suite_total" -ne 59 || "${#swift_suites[@]}" -ne 58 || "${#cjs_suites[@]}" -ne 1 ]]; then
  echo "套件声明数量不符：期望 Tests/*Tests.swift 共 59 个（Swift 循环 58 + CJS 例外 1），实际为 ${suite_total}（${#swift_suites[@]} + ${#cjs_suites[@]}）。" >&2
  exit 1
fi
echo "套件覆盖预检通过：Tests/*Tests.swift 共 ${suite_total} 个，Swift 循环 ${#swift_suites[@]} 个，CJS 例外 ${#cjs_suites[@]} 个；开始预编译共享核心测试模块。"
xcrun swiftc -module-name PaperDigestTestableHost -enable-testing -parse-as-library -D PAPER_DIGEST_TESTS \
  -emit-module -emit-module-path "$test_work/Modules/PaperDigestTestableHost.swiftmodule" \
  -emit-library -static "${sources[@]}" -o "$test_work/libPaperDigestTestableHost.a"
echo "共享核心测试模块编译完成，开始并行链接 ${#swift_suites[@]} 个测试可执行文件…"
escaped_app_root="$(/usr/bin/python3 -c 'import sys; b, q = chr(92), chr(34); m = {b: b+b, q: b+q, chr(10): b+"n", chr(13): b+"r", chr(9): b+"t"}; print("".join(m.get(c, b+"u{"+format(ord(c), "x")+"}" if ord(c) < 32 or ord(c) == 127 else c) for c in sys.argv[1]))' "$app_root")"
for suite in "${swift_suites[@]}"; do
  suite_source="$app_root/Tests/${suite}Tests.swift"
  wrapper_source="$test_work/Tests/${suite}TestsWrapper.swift"
  escaped_source="${escaped_app_root}/Tests/${suite}Tests.swift"
  {
    printf '@testable import PaperDigestTestableHost\n#sourceLocation(file: "%s", line: 1)\n' "$escaped_source"
    cat "$suite_source"
  } > "$wrapper_source"
  xcrun swiftc -parse-as-library -D PAPER_DIGEST_TESTS \
    -I "$test_work/Modules" -L "$test_work" -lPaperDigestTestableHost -Xlinker -ObjC \
    "$wrapper_source" -o "$test_work/$suite" &
  compile_pids+=("$!")
  if [[ "${#compile_pids[@]}" -ge 8 ]]; then
    for pid in "${compile_pids[@]}"; do
      wait "$pid"
    done
    compile_pids=()
  fi
done
if [[ "${#compile_pids[@]}" -gt 0 ]]; then
  for pid in "${compile_pids[@]}"; do
    wait "$pid"
  done
  compile_pids=()
fi
echo "全部 ${#swift_suites[@]} 个 Swift 测试可执行文件链接完成，开始逐套件隔离核验。"
for suite in "${swift_suites[@]}"; do
  echo "正在核验 ${suite}（隔离临时资料，不访问用户文库或付费服务）"
  if [[ "$suite" == "ModelEvidenceExport" || "$suite" == "DesktopAppDocsEvidence" ]]; then
    "$test_work/$suite" "$(command -v node)"
    swift_executed=$((swift_executed + 1))
  elif [[ "$suite" == "NativeLibraryAccessibility" ]]; then
    # 该套件直接读取本进程的 AppKit 辅助功能树，需要已解锁桌面和可用的 AXWindow。
    # 探针拿不到窗口时以 77 退出并写出 blocked；这是环境限制，不是断言失败，
    # 因此只对这一种退出记为跳过。其它非零退出（解析、断言、真实回归）仍终止。
    status=0
    "$test_work/$suite" || status=$?
    if [[ $status -eq 77 ]]; then
      swift_skipped=$((swift_skipped + 1))
      echo 'NativeLibraryAccessibility 跳过：当前环境没有可用的自进程 AXWindow（需要解锁桌面与辅助功能）；该套件未通过，不计为回归。'
    elif [[ $status -ne 0 ]]; then
      exit "$status"
    else
      swift_executed=$((swift_executed + 1))
    fi
  else
    "$test_work/$suite"
    swift_executed=$((swift_executed + 1))
  fi
done
node --test "$app_root/Tests/DesktopProtocolReview.test.cjs" "$repo_root/tests/llm-declared-protocol.test.js"
node "$app_root/Tests/LibraryPDFRevalidation.test.cjs"
# ModelServiceTests 不在上面的 swiftc 套件循环里：它需要真实回环 HTTP，由这个 CJS 壳
# 用 swiftc 显式编译 ModelServiceTests.swift 并 spawn 运行。下面这一行就是它的唯一执行入口，
# 删除它等于静默跳过整个模型服务套件。
node "$app_root/Tests/ModelWorker.test.cjs"
cjs_executed=$((cjs_executed + 1))
node --test "$app_root/Tests/WorkerErrorPrivacy.test.cjs"
node "$app_root/Tests/LibraryUI.test.cjs"
node "$app_root/Tests/LibraryCatalogPagingUI.test.cjs"
node "$app_root/Tests/FavoritesUI.test.cjs"
node --test "$app_root/Tests/WebsiteQuery.test.cjs"
node "$app_root/Tests/WebsiteWorkspaceUI.test.cjs"
node "$app_root/Tests/NativeFavoriteUI.test.cjs"
node "$app_root/Tests/LibraryMetadata.test.cjs"
node "$app_root/Tests/LibraryReadingContinuity.test.cjs"
node "$app_root/Tests/StartupResume.test.cjs"
node "$app_root/Tests/SettingsUI.test.cjs"
node "$app_root/Tests/WorkbenchSetup.test.cjs"
node "$app_root/Tests/ReducedMotion.test.cjs"
node "$app_root/../android/Tests/DocumentTables.test.cjs"
node "$app_root/Tests/CloudUI.test.cjs"
node "$app_root/Tests/NoteConflictUI.test.cjs"
node "$app_root/Tests/ZoteroUI.test.cjs"
node "$app_root/Tests/ZoteroSettingsIntegration.test.cjs"
node "$app_root/Tests/ZoteroResumePresentation.test.cjs"
# 该套件只读核验本机已安装 Zotero 的源码（与 ZoteroServiceTests 内的同源契约一致）。
# 未安装时显式跳过，不把缺少第三方应用当成回归；本地完整环境仍会实际运行。
if [[ -f /Applications/Zotero.app/Contents/Resources/app/omni.ja ]]; then
  node --test "$app_root/Tests/ZoteroInstalledContractReview.test.cjs"
else
  optional_skipped=1
  echo '已安装 Zotero 契约审查跳过：本机未安装 Zotero；隔离套件仍已运行。'
fi
node "$app_root/Tests/DesktopUI.test.cjs"
node "$app_root/Tests/AggregateUI.test.cjs"
node "$app_root/Tests/AggregateHydration.test.cjs"
node "$app_root/Tests/AggregateReadPreview.test.cjs"
node "$app_root/Tests/AggregateSyncRefresh.test.cjs"
node "$app_root/Tests/AggregateDraftOwnerRace.test.cjs"
node "$app_root/Tests/AggregateMinimumUI.test.cjs"
node "$app_root/Tests/DesktopWorkspaceViews.test.cjs"
node --test "$app_root/Tests/NativeTasksHostUI.test.cjs"
node "$app_root/Tests/NativeTasksHostBrowser.test.cjs"
node --test "$app_root/Tests/NativeNotesHostUI.test.cjs"
node --test "$app_root/Tests/NativeWorkspaceFocus.test.cjs"
node "$app_root/Tests/NativeWorkspaceFocusBrowser.test.cjs"
node "$app_root/Tests/NativeNotesHostBrowser.test.cjs"
node "$app_root/Tests/DesktopJobMetadata.test.cjs"
node "$app_root/Tests/ReadingContinuity.test.cjs"
node "$app_root/Tests/DesktopNavigationReflow.test.cjs"
node "$app_root/Tests/DesktopFontContinuity.test.cjs"
node "$app_root/Tests/DesktopReaderPreamble.test.cjs"
node "$app_root/Tests/ReaderNotices.test.cjs"
node "$app_root/Tests/ReaderNoticesNativeDelegate.test.cjs"
node "$app_root/Tests/SourceNoticeLeaf.test.cjs"
node "$app_root/Tests/MainReaderNotices.test.cjs"
node "$app_root/Tests/NotesIndex.test.cjs"
node "$app_root/Tests/DesktopGuideReview.test.cjs"
node "$app_root/Tests/MathReview.test.cjs"
node "$app_root/Tests/DesktopContentAXReview.test.cjs"
node "$app_root/Tests/DesktopModalFacade.test.cjs"
node "$app_root/Tests/DesktopModalFocus.test.cjs"
node "$app_root/Tests/DesktopContextUI.test.cjs"
node "$app_root/Tests/StorageUIAsync.test.cjs"
node "$app_root/Tests/DesktopStorageWindow.test.cjs"
node "$app_root/Tests/DesktopDetailContent.test.cjs"
node "$app_root/Tests/DesktopStoragePause.test.cjs"
node "$app_root/Tests/DesktopReaderLink.test.cjs"
node "$app_root/Tests/DesktopReaderSecurityReview.test.cjs"
node "$app_root/Tests/DesktopPresentationReview.test.cjs"
node "$app_root/Tests/DesktopFontIndependent.test.cjs"
node "$app_root/Tests/DesktopDetailContainer.test.cjs"
node "$app_root/Tests/AggregateImagesUI.test.cjs"
node "$app_root/Tests/AggregateMathUI.test.cjs"
node "$app_root/Tests/AggregateFocusUI.test.cjs"
node "$app_root/Tests/AggregateReadyUI.test.cjs"
node "$app_root/Tests/NativeAggregateRenderer.test.cjs"
node "$app_root/Tests/SearchNavigationFocus.test.cjs"
node "$app_root/Tests/PublishedHeadingMatch.test.cjs"
bash "$repo_root/scripts/python-runtime.sh" "$app_root/Tests/Branding.test.py"
bash "$repo_root/scripts/python-runtime.sh" "$app_root/Tests/FinalizeBuild.test.py"
bash "$repo_root/scripts/python-runtime.sh" "$app_root/Tests/ReleasePackaging.test.py"
if [[ $((swift_executed + swift_skipped + cjs_executed)) -ne $suite_total ]]; then
  echo "套件计数不一致：Tests/*Tests.swift 共 ${suite_total} 个；Swift 执行 ${swift_executed} 个、跳过 ${swift_skipped} 个、CJS 执行 ${cjs_executed} 个。" >&2
  exit 1
fi
echo "套件计数：Tests/*Tests.swift 共 ${suite_total} 个；Swift 循环执行 ${swift_executed} 个、环境跳过 ${swift_skipped} 个；CJS 外壳执行 ${cjs_executed} 个；可选 Zotero 安装契约跳过 ${optional_skipped} 个。"
echo '隔离自动测试完成；真实窗口、模型服务与 Zotero 归档仍须按验收矩阵分别核验。'
