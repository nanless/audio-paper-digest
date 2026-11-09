#!/bin/bash
set -euo pipefail
[[ -z "${CODEX_SANDBOX:-}" ]] || { echo '请在本机正常开发环境执行测试。' >&2; exit 1; }
app_root="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$app_root/../.." && pwd)"
cd "$repo_root"
bash "$repo_root/scripts/python-runtime.sh" "$repo_root/apps/generate-client-protocols.py" --check
test_work="$(mktemp -d "${TMPDIR:-/tmp}/paperdigest-tests.XXXXXX")"
trap 'rm -rf "$test_work"' EXIT
mkdir "$test_work/Sources"
cp "$app_root"/Sources/*.swift "$test_work/Sources/"
sources=("$test_work"/Sources/*.swift)
for suite in ClientProtocols PublicProtocolEndpoints DesktopStore FavoriteCollections BackupCodec ReleaseBootstrap ReleaseEmptyLibrary PersonalWebDavSync FullWebDavSync SyncedArchiveHistory CloudArchiveService CloudSessionCredentials CloudIntegrationReview DesktopStorage DesktopStorageDetail DesktopNativeDetails DesktopNative DesktopEvidenceReview DesktopProvenanceReview DesktopContextReview DesktopArchiveIdentity DesktopReaderLink ModelEvidenceExport DesktopAppDocsEvidence DesktopDiagnostics LibraryService NativeLibraryAccessibility WebsiteClassification LibraryCatalogPaging CatalogScheduling LibraryImageSources LibraryMathML PublishedSourceWarning PublishedAggregate AggregatePreload AggregateReadScope AggregateImageReadScope AggregatePresentation AggregateResources AggregateResourceTransport AggregateResourceBudget AggregateSystemPaths ReaderSourceNoticeSnapshot ZoteroService NativeTaskPresentation NativeAggregateTask AggregateReady NativeAggregateHost NativeTaskUsageAliases NativeTasksHostProtocol NativeTasksHostMain NativeTasksHostProgress NativeNotesHost NativeNotesHostMain NativeWorkspaceFocus NativeWorkspaceScroll NativeWorkspaceAttachment; do
  echo "正在核验 ${suite}（隔离临时资料，不访问用户文库或付费服务）"
  xcrun swiftc -parse-as-library -D PAPER_DIGEST_TESTS "${sources[@]}" "$app_root/Tests/${suite}Tests.swift" -o "$test_work/$suite"
  if [[ "$suite" == "ModelEvidenceExport" || "$suite" == "DesktopAppDocsEvidence" ]]; then
    "$test_work/$suite" "$(command -v node)"
  elif [[ "$suite" == "NativeLibraryAccessibility" ]]; then
    # 该套件直接读取本进程的 AppKit 辅助功能树，需要已解锁桌面和可用的 AXWindow。
    # 探针拿不到窗口时以 77 退出并写出 blocked；这是环境限制，不是断言失败，
    # 因此只对这一种退出记为跳过。其它非零退出（解析、断言、真实回归）仍终止。
    status=0
    "$test_work/$suite" || status=$?
    if [[ $status -eq 77 ]]; then
      echo 'NativeLibraryAccessibility 跳过：当前环境没有可用的自进程 AXWindow（需要解锁桌面与辅助功能）；该套件未通过，不计为回归。'
    else
      exit "$status"
    fi
  else
    "$test_work/$suite"
  fi
done
node --test "$app_root/Tests/DesktopProtocolReview.test.cjs" "$repo_root/tests/llm-declared-protocol.test.js"
node "$app_root/Tests/LibraryPDFRevalidation.test.cjs"
# ModelServiceTests 不在上面的 swiftc 套件循环里：它需要真实回环 HTTP，由这个 CJS 壳
# 用 swiftc 显式编译 ModelServiceTests.swift 并 spawn 运行。下面这一行就是它的唯一执行入口，
# 删除它等于静默跳过整个模型服务套件。
node "$app_root/Tests/ModelWorker.test.cjs"
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
node "$app_root/Tests/ZoteroUI.test.cjs"
node "$app_root/Tests/ZoteroSettingsIntegration.test.cjs"
node "$app_root/Tests/ZoteroResumePresentation.test.cjs"
# 该套件只读核验本机已安装 Zotero 的源码（与 ZoteroServiceTests 内的同源契约一致）。
# 未安装时显式跳过，不把缺少第三方应用当成回归；本地完整环境仍会实际运行。
if [[ -f /Applications/Zotero.app/Contents/Resources/app/omni.ja ]]; then
  node --test "$app_root/Tests/ZoteroInstalledContractReview.test.cjs"
else
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
echo '隔离自动测试完成；真实窗口、模型服务与 Zotero 归档仍须按验收矩阵分别核验。'
