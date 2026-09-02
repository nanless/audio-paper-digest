# `scripts/` 运行时代码索引

返回[项目 README](../README.md) · 查看[完整文档导航](../docs/README.md) · 进入
[Manual 子系统](../manual/README.md)

这里保留默认 LLM/API 流程、共享发布与视觉模块，以及可选渠道入口。显式
Manual 子系统已经集中到 [`manual/`](../manual/README.md)，不要在本目录重新新增
`manual-*.js` 或 Manual 专属 prompt、文档与测试。

## 从哪里开始

- 完整日更由根目录 [`run-daily-digest.sh`](../run-daily-digest.sh) 编排；默认走
  LLM/API，只有显式 `--manual` 才进入 `manual/`。
- `package.json` 是命令别名的权威清单。直接执行任意项目脚本仍必须遵守项目根
  `AGENTS.md` 的沙箱外、代理、凭据和发布门禁。
- 本目录中的 `analysis-contract.js`、`validate-data-files.js` 和博客发布模块仍会读取
  `manual/`，用于复验已有 Manual 产物；这是共享兼容边界，不代表默认 API 会启动
  Manual 写作流程。

| 需求 | 推荐入口 |
|---|---|
| 跑完当天可脚本化阶段（博客发布 + 视觉输入准备） | `npm run digest:prepare -- YYYY-MM-DD` |
| 只续跑分析 | `npm run deep -- --date YYYY-MM-DD` |
| 校验运行数据 | `npm run validate:data` |
| 查整轮最终状态 | `npm run digest:status -- --date YYYY-MM-DD` |
| 查某个文件职责 | 继续阅读下方分类索引 |

## 默认 LLM/API：抓取、筛选与分析

| 文件 | 类型 | 职责 |
|---|---|---|
| `full-fetch.js` | Node 入口 | 默认数据总编排：归档、抓取、筛选、去重、深度分析和增量落盘。 |
| `fetch-papers.js` | Node 模块/入口 | arXiv 抓取、摘要补全、关键词预筛和逐篇 LLM 筛选。 |
| `fetch-huggingface-papers.js` | Node 模块/入口 | 通过最小环境中的 `curl` 抓取 HuggingFace Papers。 |
| `deep-analyzer.js` | Node 核心 | 单篇全文获取、多阶段分析、评分审计、API reader 长文和图片计划。 |
| `analysis-engine.js` | Node 共享 | 论文锁、重试、checkpoint、批量并发、canonical 合并与终态判断。 |
| `analysis-contract.js` | Node 共享 | API 分析结构、评分、方法/表格门禁及历史 Manual 兼容校验。 |
| `editorial-quality.js` | Node 共享 | API/Manual 共用的读者可见文风、事实、评分与可读性门禁。 |
| `digest-status.js` | Node 共享 | `papers.json` 的分析状态、批次日期和恢复状态同步。 |
| `lib/fetch-scheduler.js` | Node 库 | 按 host 串行调度、冷却和失败类型判定。 |
| `lib/filter-input-contract.js` | Node 库 | 筛选决定所绑定的最小输入 SHA。 |
| `lib/keyword-prefilter.js` | Node 库 | 版本化高召回音频关键词预筛。 |

## 默认 LLM/API：恢复与维护入口

| 文件 | 职责 |
|---|---|
| `deep-analysis-only.js` | 从 complete 筛选结果安全续跑未完成分析。 |
| `batch-analyze.js` | 对现有 canonical 中的未完成论文批量分析。 |
| `reanalyze.js` | 强制全量重分析，支持显式并发与数据文件。 |
| `reanalyze-selected.js` | 只重分析指定 arXiv ID，并同步恢复统计。 |
| `analyze-single-paper.js` | 从论文库取一篇论文分析并合并回 canonical。 |
| `refilter-reanalyze-by-date.js` | 对历史日期重新筛选、分析并写入受控日期快照。 |
| `refresh-api-reader.js` | 对指定论文或日期批次刷新 API reader/评分/作者/图片阶段。 |
| `evaluate-keyword-prefilter.js` | 只读回放金标准与历史正样本，报告关键词召回。 |
| `test-api-key.js` | 测试主模型或副模型的协议路由、代理和响应。 |
| `validate-data-files.js` | 只读复验 current 数据、跨文件集合、评分和兼容 provenance。 |
| `backfill_papers.py` | 只补录历史论文 ID，不执行深度分析。 |

## 配置、环境与通用工具

| 文件 | 职责 |
|---|---|
| `config.js` | Node 参数与运行数据路径的集中配置。 |
| `env-loader.js` | 从项目 `.env` 重建受控环境，并守卫直接 Node/Manual 入口。 |
| `utils.js` | Node 原子文件、时间、ID、prompt、LLM 协议和代理工具。 |
| `log-setup.js` | Node 终端/文件日志、时间戳和敏感信息脱敏。 |
| `runtime-storage.js` | Node 只读统计运行存储，并对受控缓存/日志执行引用感知的 dry-run 或显式 `--apply` 清理。 |
| `project_env.py` | Python 项目环境、最小子进程环境与代理加载。 |
| `path_config.py` | Python 共享路径、日期与原子写配置。 |
| `utils.py` | Python 评分解析与发布侧通用文本工具。 |
| `log_setup.py` | Python 统一日志与脱敏。 |
| `runtime_guard.py` | Python 沙箱外运行守卫。 |
| `python-runtime.sh` | 为默认博客/视觉入口选择并校验 Python 3.11+ 与 OpenSSL，可由 `PD_PYTHON_BIN` 覆写。 |

## 博客生成、审查与发布

| 文件 | 类型 | 职责 |
|---|---|---|
| `generate-blog.py` | Python 入口 | 只生成并安装 Hugo Markdown。 |
| `review-blog.py` | Python 入口 | 对 generation 执行确定性、LLM、图片和 Hugo 审查并签发 receipt。 |
| `push-blog.py` | Python 入口 | 复验 receipt，提交/推送并验证远端 OID，然后规划视觉任务。 |
| `publish-to-blog.py` | Python 核心 | 三阶段共用的生成模板、Git 事务、审查缓存、receipt 与发布证明实现。 |
| `publish_common.py` | Python 共享 | 发布数据、评分、Manual/API provenance 和 LLM review 公共契约。 |
| `blog_entry_loader.py` | Python 桥 | 以固定路径加载文件名含连字符的 `publish-to-blog.py`。 |
| `markdown_hugo_gate.py` | Python 共享 | Markdown、frontmatter、公式、图片和 Hugo 渲染门禁。 |

## 发布后视觉与状态

| 文件 | 类型 | 职责 |
|---|---|---|
| `visual-summary-state.js` | Node 入口/状态机 | TOP 10 论文长图任务规划、校验、登记、失败和历史归档。 |
| `digest-cover-state.js` | Node 入口/状态机 | 每日汇总封面任务规划、校验、登记、失败和历史归档。 |
| `visual-summary-integration.js` | Node 共享 | 在同一发布证明下协调论文长图与汇总封面。 |
| `plan-post-publish-visuals.py` | Python 入口 | 从已验证博客发布调用视觉规划桥。 |
| `render-visual-summary.py` | Python 调试入口 | 确定性本地渲染器，仅用于调试/离线兜底。 |
| `waive-post-publish-visuals.js` | Node 入口 | 在用户明确取消生图时签发与当前发布绑定的 waiver。 |
| `digest-run-report.js` | Node 入口 | 汇总抓取、筛选、分析、远端发布和两类视觉的最终状态。 |

## 可选渠道

这些入口不属于默认日更；它们仍复用博客发布快照、公共数据和环境模块。

| 文件 | 职责 |
|---|---|
| `publish-wechat-full.py` | 生成或发布微信公众号内容。 |
| `publish-to-feishu.py` | 生成飞书文档。 |
| `publish-xiaohongshu.py` | 生成小红书文案与汇总内容。 |
| `xiaohongshu-publisher.py` | 小红书登录及浏览器自动发布入口。 |

## Manual 与历史兼容边界

- Manual 生产、v5 compatibility、review 和 sealed-preview 实现均在
  [`manual/scripts/`](../manual/scripts/)；对应测试在
  [`manual/tests/`](../manual/tests/)。
- `scripts/analysis-contract.js` 与 `scripts/validate-data-files.js` 会导入 Manual
  validator，以确保默认工具能读取并拒绝损坏的历史产物。
- 博客共享层同样保留 Manual 只读验证，但默认 `digest:prepare` 不会调用 Manual
  author/task/records 写入口。
