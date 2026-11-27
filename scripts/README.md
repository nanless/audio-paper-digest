# 脚本指南

**中文** · [English](README.en.md) · [自动生成的完整文件索引](INDEX.md)

本仓库只维护三条默认 LLM/API 内容生产流程：当天日更、官方会议整理与历史博客更新。权威命令表见根 `package.json`，三流程代码与提示词分工见[三流程对应表](../docs/three-workflows.md)，逐文件清单见由脚本自动维护的 [scripts/INDEX.md](INDEX.md)。

## 三流程入口与共享核心

| 职责分层 | 流程入口与适配 | 共享核心 |
|---|---|---|
| 日更主链 | `full-fetch.js`、`deep-analysis-only.js`、`batch-analyze.js`、`refresh-api-reader.js`、`reanalyze.js`、`reanalyze-selected.js` | `analysis-engine.js`、`deep-analyzer.js`、`analysis-contract.js`、`lib/daily-filter-prefilter.js`、`lib/filter-scope-evidence.js`、`lib/deep-arxiv-source-fetch.js`、`lib/deep-primary-sections.js`、`lib/analysis-contract-paper-exemptions.js`、`lib/reader-ordinal-format.js` |
| 官方会议 | `official-conference-acquire.js`、`conference-discover.js`、`conference-filter-run.js`、`conference-process.js`、`migrate-conference-process.js` | 同一分析引擎、Reader、八维评分（`scoring-rubric.js`）与九维词表 |
| 历史更新 | `historical-outdated-audit.js`、`historical-direct-rewrite-inputs.js`、`historical-direct-rewrite-plan.js`、`historical-direct-rewrite-run.js`、`history-resume.js` | 同一引擎，来源与断点由历史适配器独立核验 |
| 页面与引用 | `generate-blog.py`、`conference-page-render.py`、`historical-page-render.py`、`lib/historical-direct-aggregate.js` | `publish-to-blog.py`、`paper_reader_presentation.py`、`tag_presentation.py` |
| 审查与发布 | `review-blog.py`、`push-blog.py`、`publish-conference.py`、`lib/historical-direct-publication.js`、`verify-web.js` | `publish_common.py`、`publish_llm_client.py`、`publish_manual_legacy.py`、`blog_core_summary_verifier.py`、`blog_reader_binding_verifier.py`、`tutorial_payload_verifier_core.py`、`markdown_hugo_gate.py`、`pinned_http_transport.py` |
| 基础设施 | `env-loader.js`、`project_env.py`、`workspace-role.js`、`runtime_guard.py`、`utils.js`、`llm-account-pool.js`、`llm_account_pool.py` | `config/runtime-paths.json`（Node `config.js` 与 Python `path_config.py` 跨语言单一真源）、`config/workspace-roles.json`、`lib/env-schema.js`、`lib/file-lock.js`、`lib/papers-backup.js`、`lib/physical-request-hook.js`、`lib/arxiv-origin-gate.js`、`publish_node_replay_client.py` |

全仓库 JavaScript 模块图保持零循环依赖 SCC，由 `tests/architecture-scc-and-cycles.test.js` 持续守卫。

## 常用运维与可选 CLI

| 命令 | 脚本 | 用途 |
|---|---|---|
| `npm run doctor -- --offline` | `doctor.js` | 只读体检（环境、代理、账号池、磁盘、博客仓库）；加 `--network` 探测 arXiv |
| `npm run config:check` | `config-check.js` | 按 `lib/env-schema.js` 核对 `.env` 必填项、范围、推理档与拼写 |
| `npm run source:probe -- --date YYYY-MM-DD` | `source-probe.js` | 只读探测 arXiv Atom/官方 OAI/RSS 三入口与目标日公告状态 |
| `npm run llm:accounts` / `llm:accounts:quota` | `llm-accounts-report.js` / `llm-accounts-quota.js` | 查看共享账号池调度与冷却；同步或管理 OpenCode Go 官方 `/zen/go/v1/usage` 三窗口额度与月到期日 |
| `npm run digest:status` / `digest:scorecard` | `digest-run-report.js` / `digest-scorecard.js` | 查完整冷核状态与单日各阶段耗时、缓存命中、推理占比（支持 `--workflow daily\|conference\|history`） |
| `npm run history:outdated` | `historical-outdated-audit.js` | 只读审计博客 `content/posts/` 中落后于现行规范的过时历史页面并生成重写命令 |
| `npm run locks` | `locks.js` | 有界只读观测本地与共享博客运行锁及陈旧锁预览 |
| `npm run recover` / `manifest:new` | `recover.js` / `manifest-new.js` | 汇总失败原因与建议入口；准备来源绑定的人工修正清单 |
| `npm run fact-feedback:new` / `reader-retry:new` | `fact-feedback-new.js` / `reader-retry-new.js` | 自动核验四源并生成来源绑定事实反馈包或 Reader 显式重试清单 |
| `npm run verify:web` / `publish:finish` | `verify-web.js` / `publish-finish.js` | 核验 Pages 部署、全页 HTTP 200 与标题；输出推送后收尾核对清单 |
| `npm run digest:waive-visuals` | `waive-post-publish-visuals.js` | 绑定当前发布凭证与提交，登记日更持续不生图豁免 |
| `npm run reanalyze:selected -- <arxivId...>` | `reanalyze-selected.js` | 仅重分析当前批次的选定论文（支持来源绑定事实反馈与 `--natural-resource-prose`，不重抓来源） |
| `npm run table:check` / `review:overrides` | `table-check.js` / `review-overrides-cli.js` | 离线预检表格排版；核对严格 schema 的审查误报说明 |
| `npm run papers:compact` | `compact-papers-ledger.js` | 原子压缩 `data/current/papers.json` 账本，保留完整记录并瘦身体积 |
| `npm run storage:pdf-dedupe` / `storage:report` / `storage:prune` | `runtime-storage.js` / `storage-report.js` | 核验并写时复制去重重复 PDF、输出保留建议、引用感知清理预览 |
| `npm run digest:calibrate` | `calibrate-batch-scores.js` | 可选 CLI：批后瑞士轮 Bradley-Terry 相对分校准（只读输入，产出伴生文件） |
| `npm run podcast:generate` | `publish-daily-podcast.js` | 可选 CLI：基于已分析日批生成每日音频播客脚本/音频并可选发至 GitHub Release；传 `--portal-repo` 同步 `static/feeds/podcast.xml`、`data/podcast-episodes.json` 与 `static/client/podcast/feed.json` |
| `npm run impact -- --git` | `impact.js` | 静态反向依赖分析，列出改动影响面与精确单测列表 |
| `npm run docs:check` | `docs-consistency.js` | 核验命令、版本、链接锚点、双语索引、环境变量、`env.example` 同步与 `AGENTS.md` 体积 |
| `node scripts/test-api-key.js` | `test-api-key.js` | 显式路由诊断（发送真实最小请求核对主/副模型与代理） |

### 独立演进 / 可选实验模块

- `conference_layout_extractor.py`：布局增强版会议 PDF 提取器（现为新会议批次默认 `enhanced` 模式，支持双栏重排、结构化表格与 288 DPI 裁切；`conference_extractor.py` 因历史凭证哈希保持冻结供冷重放）。
- `lib/arxiv-tex-source.js`、`arxiv_tex_extract.py`：按需获取并安全解析 arXiv `/src/<id>` LaTeX 源码 AST sidecar。
- `generate-scripts-index.js`：重新生成或 `--check` 校验 [scripts/INDEX.md](INDEX.md)。

## 共享兼容边界

`manual/scripts` 是共享兼容边界，只保留旧来源、签名、正文与 Prompt 合同的只读核验以及单页独立人工审查（现行独立审查使用 `gpt-6.1-sol/high`）。常规日更、会议与历史 API 路径已与 `manual/` 隔离，不再主动加载 `manual/scripts/*`（`analysis-contract.js` 按需惰性加载退役合同，日常发布与 Hugo 门禁直连迁入 `scripts/` 的 `scripts/tutorial_payload_verifier_core.py` 与 `scripts/publish_manual_legacy.py`）。整批 Manual 生产链及微信、飞书、小红书发布已退役。历史 Prompt 通过原 Git blob 与 `lib/git-prompt-evidence-index.json` 只读核验，不在工作树重建旧模板。

## 专项维护入口

会议台账核验（`conference:validate-ledger`、`conference:verify-ledger`、`conference:validate-run`）、标签迁移（`tags:validate`、`tags:preview`、`tags:serve`、`tags:update-records`、`tags:check-inventory`）、历史身份裁定（`history:arxiv-source`、`history:openreview-pdf-source`、`history:resolve-conflict`）、关键词回归（`keyword:recall`）与失败豁免（`digest:waive-analysis`）的完整参数见各自流程文档与根 `package.json`。

## 验证命令

```bash
npm run verify
npm run validate:data
npm run docs:check
node scripts/generate-scripts-index.js --check
```
