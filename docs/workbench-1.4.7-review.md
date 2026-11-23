# 工作台 1.4.7 发版记录

[English](README.en.md) · 返回[文档索引](README.md)

版本 **1.4.7（构建号 23）** 收拢 1.4.6 之后针对新版论文博客页打开兼容性、HTML5/SVG/MathML 解析净化与双端网络/WebDAV/Zotero 路径的全面修复。1.4.7 已于 2026-11-23 09:43（北京时间）公开发布：附注标签 `v1.4.7`（`3ca347ac…`）指向发行提交 `520e93c3`，[发行页](https://github.com/nanless/audio-paper-digest/releases/tag/v1.4.7)含 12 件附件；签名、附件与匿名下载核验见[客户端发行核验](client-release-verification.md)。

## 1.4.6 之后的客户端改动

1. **新版论文博客页打开与解析兼容修复**（提交 `bd49d8e1`）：修复 macOS 与 Android 客户端无法打开部分新版论文博客页的问题；对齐 macOS（`LibraryArticleExtractor`、`LibraryDesktopDetails`、`LibraryService`、`AppDocuments`、`AppAggregates`、`aggregate-native-renderer.js`、`native.js`）与 Android（`DesktopDetailsRepository`、`AggregateHtml`、`CatalogRepository`、`ResearchRenderer`、`ReaderDocumentStyle`）的新导读结构、HTML5 语义片段、内联 SVG 白名单与 MathML 渲染兼容，并在最新全站真实导出语料（9276 页导读片段、8551 篇去重论文）上完成双端全量重放校验。
2. **网络、WebDAV 同步、冲突合并与 Zotero 传输加固**（提交 `bd49d8e1`）：加固双端 `SafeHttp` DNS 解析与公网目标守卫、`LibraryImageTransport`、`CloudArchive` / `FullWebDavWorkspace` / `PersonalWebDavSync` / `NoteConflictMerger` / `ZoteroService` 及并发控制器的边界缺陷与错误处理，同步更新双端协议注册表（`apps/generate-client-protocols.py` 与 `ClientProtocolRegistry.generated.kt`）。
3. **版本、许可与发版说明同步**：Mac `Info.plist` 升为 `CFBundleShortVersionString` `1.4.7`、`CFBundleVersion` `23`，随包 `Resources/licenses/manifest.json` 与 `Resources/third-party-notices.html` 同步刷新；Android `app/build.gradle.kts` 升为 `versionName` `1.4.7`、`versionCode` `23`，继续沿用 1.4.4–1.4.6 发布签名库（证书 SHA-256 `6a0c3138…`），已安装 1.4.4、1.4.5 或 1.4.6 的用户可直接覆盖升级，1.4.3（`d7c680d9…`）用户仍需先导出备份、卸载旧版再安装；`apps/macos/release_tools.py` 补齐 `1.4.7` 的 `RELEASE_NOTES.md` 更新说明分支。

## 本轮已执行的自动化验证

- 协议与文档一致性：`npm run docs:check`、`node --test tests/documentation.test.js`、`node --test tests/docs-consistency.test.js` 与 `bash scripts/python-runtime.sh apps/generate-client-protocols.py --check` 全部通过。
- macOS 客户端全量回归（`bash apps/macos/test.sh`）：`Tests/*Tests.swift` 共 60 个套件（0 跳过）、全部 Node/Playwright 界面与安全回归，以及 `Branding.test.py`、`FinalizeBuild.test.py`、`ReleasePackaging.test.py` 全部通过，0 失败。
- Android 客户端全量回归（`bash apps/android/test.sh`）：全部 Python 发行、签名与安全资源检查脚本、`AssetsChannel.test.mjs`、全量 JUnit 单元测试与 `lintDebug` 全部通过，0 失败。
- 真实语料兼容核验：双端导读与详情校验器已完成全站最新 9276 页导读片段、8551 篇去重论文的真实导出语料重放回归（macOS `DesktopDetailsContractTests` 212 项断言通过，Android `DesktopDetailsRepositoryTest` 13 项测试全部通过）。

## 发行结果

- 发布时间：2026-11-23 09:43（北京时间，`2026-11-23T01:43:38Z`）。
- 标签与提交：附注标签 `v1.4.7`（标签对象 `3ca347ac10dcb80937a5cb3d081121126576ae6e`），指向冻结发行提交 `520e93c37cad726ca5a32d0cc79f78db29fe1e22`（`520e93c3`）。
- 附件：12 件，Mac 6 件（DMG、ZIP、`RELEASE_NOTES.md`、`build-info.json`、`release-manifest.json`、`SHA256SUMS`），Android 6 件（APK、`android-build-info.json`、`android-source-inputs.json`、`android-runtime-materials.json`、`android-release-manifest.json`、`ANDROID-SHA256SUMS`）；发行页与 12 件附件未登录请求均返回 HTTP 200，下载字节数与 SHA-256 与两份校验表一致，详见[客户端发行核验](client-release-verification.md)。
- Android 签名：沿用 1.4.4–1.4.6 发布签名库（证书 SHA-256 `6a0c3138…`，APK Signature Scheme v2 + v3，`signingOrigin: provided-signed-apk`）；已安装 1.4.4、1.4.5 或 1.4.6 的用户可直接覆盖升级，1.4.3（`d7c680d9…`）用户仍需先导出备份、卸载旧版再安装。
- 人工验收：没有重新执行 84/86 项人工图形与实机验收矩阵；受影响范围仅完成双端自动测试、打包回读与全站最新 9276 页真实导出语料重放覆盖。

## 发行范围与遗留

`mac-app-release.md` 要求在公开前完成 86 项验收；1.4.7 实际没有重新执行 84/86 项人工矩阵，只在自动测试、真实语料重放与包体层面覆盖上述改动。1.4.3 至 1.4.6 同样没有重做其中的 69 项图形验收，安装、图形首启、旧资料升级和业务操作的最新完整范围仍属 1.3.0，见[1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)。最终字节已随 `520e93c3` 冻结提交，附注标签、12 件附件与公开下载核验已按发行流程完成。
