# 工作台 1.5.2 预发布记录

[English](README.en.md) · 返回[文档索引](README.md)

版本 **1.5.2（构建号 26）（尚未公开发布）** 是 `1.5.1 / 构建号 25`（2026-11-27 公开发布，附注标签 `v1.5.1` 指向发行提交 `7622f2ec`）之后的双端会议展示齐平、客户端并发与传输加固，以及内容生产引擎第 1–4 轮全栈深度审查与架构收敛预发布版本。目前仅完成源码版本冻结与离线自动化预冻结验证，尚未创建公开发行标签或上传 GitHub Release 附件；公开下载仍以最近已公开发行版本 `1.5.1 / 构建号 25` 为准（见 [1.5.1 发版记录](workbench-1.5.1-review.md) 与 [客户端发行核验](client-release-verification.md)）。

## 1.5.1 之后的改动

### 1. 六端 58 键会议名齐平与双端客户端加固（提交 `7f292e55`、`61216ef7`、`732fc6f0`）

- **六端 58 键会议展示名统一**：在 macOS Swift（`apps/macos/Sources/LibraryCompactProjection.swift`）、macOS WebView JS（`apps/macos/Resources/website-browser.js`）、Android Kotlin（`apps/android/app/src/main/java/com/nanless/paperdigest/ui/WebsiteLibraryIndex.kt`）与“音频研究门户”（门户仓提交 `5dd0a1a7`）间对齐全部 58 组会议显示名（覆盖 `Interspeech`、`Speech Prosody`、`ACM MM`、`DCASE`、`TASLP`、`IJCAI`、`ICCV`、`ECCV` 等），统一执行一致的三步分隔符归一化（原键 → `-` 转 `_` → 去 `_` 紧凑匹配）及严格的 ASCII 年份校验（`[0-9]{2}`）。
- **并发、传输与离线边界加固**：
  - Android `StudyCoordinator` 新增 `reconcileStudyJobs()` 对账逻辑，在平台后台任务已结束或缺失时安全收敛旧队列记录，避免恢复工作空间时发生死锁，同时不自动重发已派发的付费研究请求；同步加固 `RootController`、`CatalogRepository`、`DesktopDetailsRepository`、`PublishedAggregateStore` 与 `ZoteroService`。
  - macOS 修复 `LibraryImageTransport` 的 `responseTooLarge` 边界与 `PodcastPlayerService` 并发下载/播放竞态，同步加固 `PublishedAggregateStore`、`LibraryService`、`LibraryDesktopDetails`、`llm-worker.cjs` 与播客界面状态同步。
- **构建与测试完整性守卫**：
  - Android Gradle `verifyClientProtocols` 改为监听 `config/protocols/` 下全部 12 份 `clients.json` 与 `clients-*.json` 文件，防止协议目录变动漏触发校验。
  - 修复 Android `apps/android/Tests/DocumentTables.test.cjs` 并在双端 `apps/macos/test.sh` 与 `apps/android/test.sh` 补齐测试入口完整性守卫，防止新增测试文件被静默漏跑。

### 2. 服务端内容生产、发布与门户第 1–4 轮深度审查收敛与架构升级

- **去版本后缀命名与 Prompt 精简去重（提交 `256aa9e6`）**：全仓文件、配置与现行契约名移除冗余 `v1–v5` 后缀（保留既有磁盘数据与线上历史页 100% 只读兼容）；8 份核心 Prompt 精简去重并将修改前 Git Blob 全部预登记至 `scripts/lib/git-prompt-evidence-index.json`。
- **第 1 轮核心止血、Python 共享传输闸门、门户 KaTeX 容错与上线验收闭环（提交 `61216ef7`、`441cee76`，配套门户仓提交 `fcecae13`）**：新增 `scripts/pinned_http_transport.py` 共享 arXiv `OriginGate`（并发信号量、冷却、429/5xx 指数退避），接入审图与会议验页；修复 ReDoS、循环记账、审图 `units/` 检查点泄漏、推送单次消费令牌与三线 P0 缺陷；新增 `--reader-fact-local` 及 `fact-feedback:new` / `reader-retry:new` 脚手架，并补齐首轮全文耗尽对单处漏逗号完整 JSON 响应的恢复准入；“音频研究门户”在渲染层补齐 KaTeX 容错回退、关闭 `enableGitInfo` 与 Pagefind 404 门控。
- **第 2 轮 Prompt 缓存重排、`ordinal-v2` 静态前缀与校验器防误杀（提交 `de9a5268`）**：升级 `ordinal-v2` 静态前缀协议（将动态 token 移至文末提升 KV 缓存命中，保留三代历史冷核兼容）；重排多份修复 Prompt 为静态前缀；加固核心摘要、资源声明、评分审计与跨阶段一致性校验器防误杀。
- **第 3 轮与深度复查收敛（提交 `732fc6f0`、`43f207b8`）**：精简 CI 矩阵与 `AGENTS.md`，迁移 SVG 处理回归并加固 `docs-consistency.js`；深度修复日更全文筛选的正文锚点排除、30K 摘录漏召回与预筛误拒问题，清零第 1–2 轮回归。
- **第 4 轮核心架构收敛（提交 `79aae1c9`）**：彻底破除 JS 模块循环依赖（SCC 归零）、隔离已退役 `manual/` 兼容代码至独立模块、拆解发布与分析大单体（分离 `publish_llm_client.py`、`publish_manual_legacy.py`、`blog_core_summary_verifier.py`、`file-lock.js`、`deep-arxiv-source-fetch.js`、`deep-primary-sections.js` 等），并以 `config/runtime-paths.json` 建立 Node 与 Python 跨语言路径单一真源。

### 3. 版本、签名边界与随包许可同步

- macOS `apps/macos/Info.plist` 升为 `1.5.2`（构建号 `26`），同步更新 `apps/macos/package.json`（保留 `katex` `0.19.1` 不变）、`apps/macos/Sources/AppDocuments.swift` 回退版本号、`apps/macos/release_tools.py` `1.5.2` 发行说明、`apps/macos/Tests/Branding.test.py`，并通过 `apps/macos/refresh_licenses.py` 刷新随包许可清单（`apps/macos/Resources/licenses/manifest.json`）与第三方声明页面（`apps/macos/Resources/third-party-notices.html`）。
- Android `apps/android/app/build.gradle.kts` 升为 `versionName = "1.5.2"`、`versionCode = 26`；未来正式打包继续沿用 `1.4.4–1.5.1` 的发布签名库（证书 SHA-256 `6a0c3138…`），已安装 `1.4.4–1.5.1` 的用户可直接覆盖升级，`1.4.3`（`d7c680d9…`）用户仍需先导出备份、卸载旧版再安装；零新增权限、依赖或组件。

## 预发布自动化验证范围

本轮预冻结验证在冻结提交与正式打包前执行，覆盖以下离线自动化检查：

- 索引、静态套件与文档一致性：`npm run docs:check`、`npm run scripts:index:check`、`npm run verify -- --suite static`。
- 双端与门户协议注册表一致核验：`bash scripts/python-runtime.sh apps/generate-client-protocols.py --check --blog-repo "$PAPER_DIGEST_BLOG_REPO"`。
- 双端品牌、打包与文档测试：`bash scripts/python-runtime.sh apps/macos/Tests/Branding.test.py`、`bash scripts/python-runtime.sh apps/macos/Tests/ReleasePackaging.test.py`、`bash scripts/python-runtime.sh apps/android/Tests/WorkbenchBranding.test.py`、`bash apps/android/build.sh :app:verifyClientProtocols :app:testDebugUnitTest`、`node --test tests/docs-consistency.test.js tests/docs-consistency-real.test.js tests/documentation.test.js`。
- macOS 原生 Swift 定向编译与运行：`DesktopAppDocsEvidenceTests.swift`、`LibraryFiltersTests.swift` 与 `DesktopDiagnosticsTests.swift`。

## 发行状态（尚未公开发布）

- 当前状态：**预发布（尚未公开发布）**，尚未生成正式 DMG/ZIP/APK 附件、尚未打 `v1.5.2` 标签、尚未创建 GitHub Release；公开下载仍以最近已公开发行版本 `1.5.1 / 构建号 25` 为准。
- 人工验收边界：本轮预发布未重新执行 84/86 项人工图形与实机验收矩阵；最新完整人工图形与实机验收范围仍属 `1.3.0`（见 [1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)）。待正式构建、双端打包回读、签名验证、附注标签公开与匿名下载核验完成后，再补充 `1.5.2` 正式发布结果与 12 件附件校验表至[客户端发行核验](client-release-verification.md)。
