# 工作台 1.5.1 发版记录

[English](README.en.md) · 返回[文档索引](README.md)

版本 **1.5.1（构建号 25）** 是 `1.5.0 / 构建号 24`（2026-11-26 公开发布，来源提交 `5b5a8e79`）之后的双端质量加固与 Studio Monograph 界面升级版本，同时完成内容生产引擎中官方会议与历史更新产线的全面日更齐平改造。1.5.1 已于 2026-11-27 02:11（北京时间，`2026-11-26T18:11:07Z`）公开发布：附注标签 `v1.5.1`（`2f9ba004…`）指向冻结发行提交 `7622f2ec`，[发行页](https://github.com/nanless/audio-research-workbench/releases/tag/v1.5.1)（Release ID `459751293`）含 12 件附件；签名、附件与匿名下载核验见[客户端发行核验](client-release-verification.md)。

## 1.5.0 之后的改动

### 1. 双端工作台 Studio Monograph 视觉升级与全量页面修复（含提交 `2fa82731`、`c3fa7c5b`）

- **统一 Studio Monograph 视觉体系**：macOS 与 Android 双端同步采用暖纸 / 深黑石板表面色板、共振青与工作室铜语义层次（Android 全部语义色组对比度通过 WCAG >= 4.5:1），补齐暗色模式下透明背景论文图/SVG 的浅色衬垫与门户语义卡片样式。
- **双端共性内容与离线修复**：
  - 修复双端同步桌面详情后“网站与资源 / 关于与资源”站点页（`about`、`conferences`、`links`）缺失以及缺少专题导航入口的问题。
  - 修复 2 期超 128 图日报（`2026-10-11`、`2026-10-15`）打开硬失败与 17 篇超 32 图会议论文离线封存受阻的问题。
  - 将官方会议 PDF 白名单扩展覆盖 `proceedings.iclr.cc` 与 PMLR `raw.githubusercontent.com/mlresearch`，恢复 4 篇官方会议 PDF 下载。
  - 修复双端播客并发下载与缓存边界，以及桌面详情音频 Demo 入口解析问题。
- **macOS 专项修复**：修正侧边栏当前选中项高亮与 `aria-current`、从聚合/任务/笔记/播客打开论文时作者信息空白、HTML 净化误删 `<del>` 与 `<ol start>` 属性，以及 toast 提示条遮挡播客控制栏与详情页提示不自动消失的问题。
- **Android 专项修复**：修复聚合页单张图片加载失败中止后续图片加载、38 期日报静态 SVG 渲染、3 篇超 256 处公式页面中止 KaTeX 渲染、正文货币金额 `$` 误解析为公式、设置页代理配置不可见以及手机端阅读页隐藏评分徽章的问题。

### 2. 服务端内容生产、账号池实时同步与三流程日更齐平

- **OpenCode Go 账号池月到期优先与实时额度同步（提交 `50be9393`、`3e392b88`）**：默认按北京时间月到期日优先、同天选有效剩余月额度最多且三窗口有额调度（`PD_LLM_ACCOUNT_POOL_STRATEGY=expiry_priority`），并在 Node 与 Python 双栈自动经项目代理请求 `/zen/go/v1/usage` 实时同步三窗口剩余额度（5 分钟 TTL，`PD_LLM_ACCOUNT_POOL_LIVE_SYNC=1`）。
- **多轮深度审查加固（提交 `2fa82731`、`c3fa7c5b`）**：修复 `undici.ProxyAgent` 忽略代理 TLS 握手超时导致 10 秒静默截断、三处离线子进程环境变量白名单隔离、用量分片与跨午夜批次归属、大输入管道死锁及多项发布审查/锁重入边界缺陷。
- **官方会议与历史更新全面齐平日更**：
  - 会议线新增 6 个 v2 提供方（`emnlp-2026`、`ismir-2026`、`dcase-2026`、`neurips-2026`、`waspaa-2025`、`asru-2025`，绝不触碰字节冻结的 v1）、默认启用 `conference_extractor_v2.py`（`PD_CONFERENCE_EXTRACTOR_VERSION=v2`）、13 个核心音频会议家族动态年份匹配（`2025+`）、Wave 11C 预筛叠加层、9 步 Reader 显示归一化与 `_nest_reader_headings`、Studio Monograph 2.0 呈现、`push --dry-run`、Pages 部署自动等待（`PD_PAGES_DEPLOY_POLL_SECONDS` / `PD_PAGES_DEPLOY_TIMEOUT_SECONDS`）、`passed_image_registry` 复用、`digest:calibrate --conference-process` 与 `digest:scorecard --workflow conference`。
  - 历史线新增只读过时审计命令 `npm run history:outdated`（`scripts/historical-outdated-audit.js`）、`history:inputs --arxiv-only`、完整日期批次汇总原子同步、`--waive-visuals`（遵循 2026-11-02 持续不生图政策）、Author v3 与四组封存 PDF 证据模块全量接入、`publish.text` `low` 推理档与 `prompt_cache_key`、确定性发布检查 + `markdown_hugo_gate` HTML 门禁，以及 `npm run verify:web -- --historical-publication-id <UUID>` 在线验收。

### 3. 版本、签名边界与随包许可同步

- macOS `apps/macos/Info.plist` 升为 `1.5.1`（构建号 `25`），同步更新 `apps/macos/package.json`（保留 `katex` `0.19.1` 不变）、`apps/macos/Sources/AppDocuments.swift` 回退版本号、`apps/macos/release_tools.py` `1.5.1` 发行说明、`apps/macos/Tests/Branding.test.py`，并通过 `apps/macos/refresh_licenses.py` 刷新随包许可清单与第三方声明页面。
- Android `apps/android/app/build.gradle.kts` 升为 `versionName = "1.5.1"`、`versionCode = 25`；正式打包沿用 `1.4.4–1.5.0` 的发布签名库（证书 SHA-256 `6a0c3138…`），已安装 `1.4.4–1.5.0` 的用户可直接覆盖升级，`1.4.3`（`d7c680d9…`）用户仍需先导出备份、卸载旧版再安装；零新增权限、依赖或组件。

## 本轮已执行的自动化验证

- 索引、配置、协议与文档一致性：`node scripts/generate-scripts-index.js --check`、`npm run docs:check`、`npm run config:check`、`npm run doctor -- --offline` 与 `bash scripts/python-runtime.sh apps/generate-client-protocols.py --check` 全部通过。
- 服务端 Python 与跨模块 Node 回归：全量 Python 2,706 项测试与 2,145 项跨模块 Node 测试（含角色守卫、配置 Schema、历史过时审计、脚本索引与文档一致性测试）全部通过，0 失败。
- macOS 客户端全量离线回归（`bash apps/macos/test.sh`）：62/62 项 Swift/CJS 与界面测试、89/89 项 Python 发版/打包与品牌测试全部通过，0 失败。
- Android 客户端全量离线回归（`bash apps/android/test.sh`）：998 项 JUnit 单元测试、`lintDebug`、资产通道与 Python 发行检查全部通过，0 失败。
- 线上门户同步：“音频研究门户”提交 `d65f0ef8` 的 GitHub Pages 构建与部署成功。

## 发行结果

- 发布时间：2026-11-27 02:11（北京时间，`2026-11-26T18:11:07Z`）。
- 标签与提交：附注标签 `v1.5.1`（标签对象 `2f9ba0044cd0428142513391db7699dbd2aa41ac`），指向冻结发行提交 `7622f2ec8ba4d201e5ba9f38e5f69b0ff63de12c`（`7622f2ec`）；GitHub Release ID `459751293`（`draft: false`，`prerelease: false`）。
- 附件与匿名下载：12 件附件（Mac 6 件：DMG、ZIP、`RELEASE_NOTES.md`、`build-info.json`、`release-manifest.json`、`SHA256SUMS`；Android 6 件：APK、`android-build-info.json`、`android-source-inputs.json`、`android-runtime-materials.json`、`android-release-manifest.json`、`ANDROID-SHA256SUMS`）。2026-11-27 未登录请求（无 Cookie、无 `Authorization` 头）访问发行页（149,599 字节）与全部 12 件附件均返回 HTTP 200，下载字节数、SHA-256 与双端 `verify-downloaded` 包体/签名回读（`androidAPKReverified: true`、`macArtifactsReverified: true`、`downloadedAssetsSHAExact: true`）均一致，详见[客户端发行核验](client-release-verification.md)。
- 双端签名：Mac 公开 ZIP 内 `音频研究工作台.app` 经 `codesign -dv --verbose=4` 核对为 `Identifier=com.nanless.PaperDigest`、`arm64`、`Signature=adhoc`、`TeamIdentifier=not set`、CDHash `8e57b7980dd6d7d814e4e4c75dc2063f111ad8ac`（`8e57b798…`）；Android 公开 APK 沿用 `1.4.4–1.5.0` 发布签名库（证书 SHA-256 `6a0c3138f9a49b01f868a123490a7e562f6d78d951160afb2ea5b1e44274e5bb`，`6a0c3138…`，APK Signature Scheme v3，`signingOrigin: provided-signed-apk`），已安装 `1.4.4–1.5.0` 的用户可直接覆盖升级，`1.4.3`（`d7c680d9…`）用户仍需先导出备份、卸载旧版再安装。
- 人工验收：未重新执行 84/86 项人工图形与实机验收矩阵；本版通过双端全量自动测试、服务端 Python/Node 回归、打包回读、匿名下载签名核验与线上门户部署核验覆盖。

## 发行范围与遗留

`mac-app-release.md` 要求在公开前完成 86 项人工验收；1.5.1 实际未重新执行 84/86 项人工图形与实机验收矩阵，只在自动化测试、打包回读、匿名下载签名复核与线上门户部署核验层面覆盖本轮改动。1.4.3 至 1.5.0 同样未重做其中的 69 项图形验收，安装、图形首启、旧资料升级和业务操作的最新完整人工范围仍属 1.3.0，见[1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)。最终字节已随 `7622f2ec` 冻结提交，附注标签、12 件附件与公开匿名下载核验已按发行流程完成。
