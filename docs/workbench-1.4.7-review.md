# 工作台 1.4.7 发版记录

[English](README.en.md) · 返回[文档索引](README.md)

版本 **1.4.7（构建号 23）** 收拢 1.4.6 之后针对新版论文博客页打开兼容性、HTML5/SVG/MathML 解析净化与双端网络/WebDAV/Zotero 路径的全面修复。本页先登记 1.4.7 发版前改动与自动测试范围；正式附注标签 `v1.4.7`、12 件双端附件、签名与匿名下载核验结果待公开发布后补充，当前最新已公开发行版本仍为 1.4.6 / 构建号 22，见[客户端发行核验](client-release-verification.md)。

## 1.4.6 之后的客户端改动

1. **新版论文博客页打开与解析兼容修复**（提交 `bd49d8e1`）：修复 macOS 与 Android 客户端无法打开部分新版论文博客页的问题；对齐 macOS（`LibraryArticleExtractor`、`LibraryDesktopDetails`、`LibraryService`、`AppDocuments`、`AppAggregates`、`aggregate-native-renderer.js`、`native.js`）与 Android（`DesktopDetailsRepository`、`AggregateHtml`、`CatalogRepository`、`ResearchRenderer`、`ReaderDocumentStyle`）的新导读结构、HTML5 语义片段、内联 SVG 白名单与 MathML 渲染兼容，并在最新全站真实导出语料（9276 页导读片段、8551 篇去重论文）上完成双端全量重放校验。
2. **网络、WebDAV 同步、冲突合并与 Zotero 传输加固**（提交 `bd49d8e1`）：加固双端 `SafeHttp` DNS 解析与公网目标守卫、`LibraryImageTransport`、`CloudArchive` / `FullWebDavWorkspace` / `PersonalWebDavSync` / `NoteConflictMerger` / `ZoteroService` 及并发控制器的边界缺陷与错误处理，同步更新双端协议注册表（`apps/generate-client-protocols.py` 与 `ClientProtocolRegistry.generated.kt`）。
3. **版本、许可与发版说明同步**：Mac `Info.plist` 升为 `CFBundleShortVersionString` `1.4.7`、`CFBundleVersion` `23`，随包 `Resources/licenses/manifest.json` 与 `Resources/third-party-notices.html` 同步刷新；Android `app/build.gradle.kts` 升为 `versionName` `1.4.7`、`versionCode` `23`，继续沿用 1.4.4–1.4.6 发布签名库（证书 SHA-256 `6a0c3138…`），已安装 1.4.4、1.4.5 或 1.4.6 的用户可直接覆盖升级，1.4.3（`d7c680d9…`）用户仍需先导出备份、卸载旧版再安装；`apps/macos/release_tools.py` 补齐 `1.4.7` 的 `RELEASE_NOTES.md` 更新说明分支。

## 本轮已执行的自动化验证

- 协议与文档一致性：`npm run docs:check`、`node --test tests/documentation.test.js`、`node --test tests/docs-consistency.test.js` 与 `bash scripts/python-runtime.sh apps/generate-client-protocols.py --check` 全部通过。
- macOS 客户端全量回归（`bash apps/macos/test.sh`）：`Tests/*Tests.swift` 共 60 个套件（0 跳过）、全部 Node/Playwright 界面与安全回归，以及 `Branding.test.py`、`FinalizeBuild.test.py`、`ReleasePackaging.test.py` 全部通过，0 失败。
- Android 客户端全量回归（`bash apps/android/test.sh`）：全部 Python 发行、签名与安全资源检查脚本、`AssetsChannel.test.mjs`、全量 JUnit 单元测试与 `lintDebug` 全部通过，0 失败。
- 真实语料兼容核验：双端导读与详情校验器已完成全站最新 9276 页导读片段、8551 篇去重论文的真实导出语料重放回归（macOS `DesktopDetailsContractTests` 212 项断言通过，Android `DesktopDetailsRepositoryTest` 13 项测试全部通过）。

## 尚未执行的项目与正式发布前步骤

1. **人工图形与设备验收矩阵未重跑**：本轮只执行自动化单元、集成、浏览器隔离渲染、真实语料重放与打包工具检查，**没有重新执行 84/86 项人工图形与实机验收矩阵**（含 Mac 69 项人工图形操作、云端与发行 17 项真实账号/草稿核验，以及 Android 实体机和完整 TalkBack 遍历）。安装、图形首启、旧资料升级和真实服务人工操作的最新完整范围仍属 1.3.0，见[1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)。
2. **提交干净工作区后再打包**：`apps/macos/release_tools.py` 与 `apps/android/release_tools.py` 均要求干净的 Git 提交作为 `sourceCommit`；需先提交本轮版本与文档修改，再构建并签名两端正式候选包。
3. **标签、十二件附件与公开核验待后续登记**：待完成正式候选包核验、创建附注标签 `v1.4.7`、上传 Mac 与 Android 共 12 件附件并公开 GitHub Release 后，再于后续提交在[客户端发行核验](client-release-verification.md)和[Mac 构建与发行](mac-app-release.md)中登记公开时间、标签指向提交、各附件字节与 SHA-256 以及未登录 HTTP 200 下载结果。
