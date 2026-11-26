# 工作台 1.5.1 预发布记录

[English](README.en.md) · 返回[文档索引](README.md)

版本 **1.5.1（构建号 25）（尚未公开发布）** 是 `1.5.0 / 构建号 24`（2026-11-26 公开发布，来源提交 `5b5a8e79`）之后的双端质量加固与 Studio Monograph 界面升级预发布版本，同时完成内容生产引擎中官方会议与历史更新产线的全面日更齐平改造。目前仅完成源码版本推进与自动化预冻结验证，尚未创建公开发行标签或上传 GitHub Release 附件；公开下载仍以最近已公开发行版本 `1.5.0 / 构建号 24` 为准（见 [1.5.0 发版记录](workbench-1.5.0-review.md) 与 [客户端发行核验](client-release-verification.md)）。

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
- Android `apps/android/app/build.gradle.kts` 升为 `versionName = "1.5.1"`、`versionCode = 25`；未来正式打包继续沿用 `1.4.4–1.5.0` 的发布签名库（证书 SHA-256 `6a0c3138…`），已安装 `1.4.4–1.5.0` 的用户可直接覆盖升级，`1.4.3`（`d7c680d9…`）用户仍需先导出备份、卸载旧版再安装；零新增权限、依赖或组件。

## 预发布自动化验证范围

本轮预冻结验证在发布提交与打包前执行，覆盖以下离线自动化检查（均须 100% 通过后才进入提交、打包与发行阶段）：

- 索引、配置、协议与文档一致性：`node scripts/generate-scripts-index.js --check`、`npm run docs:check`、`npm run config:check`、`npm run doctor -- --offline`、`bash scripts/python-runtime.sh apps/generate-client-protocols.py --check`。
- 角色守卫、配置 Schema、历史审计与文档测试：`tests/workspace-role.test.js`、`tests/env-schema.test.js`、`tests/documentation.test.js`、`tests/docs-consistency.test.js`、`tests/docs-consistency-real.test.js`、`tests/scripts-index.test.js`、`tests/historical-outdated-audit.test.js`。
- macOS 全量离线回归：`bash apps/macos/test.sh`（全部 Swift/CJS、Playwright 与 Python 品牌/发版测试）。
- Android 全量离线回归：`bash apps/android/test.sh`（全部 JUnit 单元测试、`lintDebug`、资产通道与 Python 发行检查）。

## 发行状态（尚未公开发布）

- 当前状态：**预发布（尚未公开发布）**，尚未生成正式 DMG/ZIP/APK 附件、尚未打 `v1.5.1` 标签、尚未创建 GitHub Release。
- 人工验收边界：本轮预发布未重新执行 84/86 项人工图形与实机验收矩阵；最新完整人工图形与实机验收范围仍属 `1.3.0`（见 [1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)）。待正式构建、双端打包回读、签名验证、标签公开与匿名下载核验完成后，再补充正式发布结果与 12 件附件校验表至[客户端发行核验](client-release-verification.md)。
