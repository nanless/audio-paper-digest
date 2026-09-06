# `scripts/` 运行时代码索引

返回[项目 README](../README.md) · 查看[完整文档导航](../docs/README.md) · 进入
[Manual 子系统](../manual/README.md)

这里保留默认 LLM/API 流程、共享发布与视觉模块，以及可选渠道入口。显式
Manual 子系统已经集中到 [`manual/`](../manual/README.md)，不要在本目录重新新增
`manual-*.js` 或 Manual 专属 prompt、文档与测试。

## 从哪里开始

显式全量 fresh rewrite 已 `promoted`、需要接替同日旧发布时，先运行
`npm run blog:activate-fresh -- --run-id UUID --dry-run`，再去掉 `--dry-run`。
此维护入口只支持基线中的一个整批和一个单篇旧事务，精确归档其 6 个
manifest/receipt/pass 文件到该 run 的 `publication-archive/`；不改科学状态、
博客页面、视觉证据，不调用模型或推送。它复验旧 receipt 各自原提交、当前
Hugo 干净 HEAD、实时 remote OID/identity、baseline 字节和 promoted canonical。
中断时同命令恢复；日期级 pending 门禁持续拦住 generate/review/push，不能
手删标记或凭证。成功后按正常 `blog:generate → blog:review → blog:push` 重建
全部证明；旧视觉 waiver 不自动代表新发布完成。完成后再次调用不会退休新 generation。

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
| 完整离线验证代码、数据与 Hugo | `npm run verify`；CI/干净空 checkout 显式加 `-- --allow-empty` |
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
| `lib/paper-taxonomy.js` | Node 库 | 共享标签registry的严格加载、同义解析、祖先查询与展示去重；不修改旧canonical标签。 |
| `lib/keyword-prefilter.js` | Node 库 | 版本化高召回音频关键词预筛。 |
| `lib/reader-repair.js` | Node 库 | Reader 候选缓存、节点 SHA 与受限 patch、局部诊断及无进展检测；候选不构成 production proof。 |
| `lib/reader-operator-patch.js` | Node 库 | 显式应用同 fresh run 的人工局部补丁；严格来源/节点 SHA 与完整 Reader parser，保存 failed 候选并保留预算、原始字节归档和重入审计，不签发成功正文。 |
| `lib/reader-signed-draft.js` | Node 库 | 将本次同源签名 Reader 逆变换为严格等价输入；真实 parser 与原图注入后正文/计划/图片 SHA 全等才返回，不写文件、不调用模型，不把恢复稿冒充原始 API JSON。 |
| `lib/reader-signed-operator.js` | Node 库 | 同 run 已签名 Reader 的显式局部 operator 执行；完整父稿 CAS、真实逆变换/parser/共用封存、不可变意图与输出恢复，只写隔离分析并要求事实复核，不产生 API 调用。 |
| `lib/reader-resource-sync.js` | Node 库 | 将已封存资源状态确定性同步到 canonical/parsed/末端 checkpoint 与输出 proof；保留评分和 Reader 字节，评分可用性证据变化则拒绝并要求正常评分审计，不联网、不写文件。 |
| `lib/reader-draft-order.js` | Node 库 | 在同一候选上规范小节顺序并同步表格绑定/marker，记录原始到规范路径的 SHA 映射；歧义时拒绝重排。 |
| `lib/reader-source-diagnostics.js` | Node 库 | 将数字/单位绑定失败定位到正文单元格与原表行列证据，给出百分号位置、千分位及可能舍入的只读修复候选；不自动改数值或放宽来源门禁。 |
| `lib/reader-recovery-revision.js` | Node 库 | 显式升级同源 fresh run 的失败候选诊断，保留请求预算、记录索引迁移及旧无进展状态，可恢复归档旧证据；不签发成功。 |
| `lib/reader-contract.js` | Node 库 | Reader 共享机械阈值、按本次证据生成 Prompt 门禁说明，以及基于实际小节身份的近重复 warning。 |
| `lib/reader-tables.js` | Node 库 | 将 TABLE marker 与原表行列选择确定性展开为 Markdown 和既有逐格来源绑定，保留表头身份并拒绝错位/越界。 |
| `lib/llm-usage.js` | Node 库 | 请求级真实 usage 规范化与按论文/阶段归因；服务未提供的计费用量保持不可得。 |
| `lib/fresh-rewrite-run.js` | Node 库 | 从 raw 元数据白名单创建隔离重写 run，编排同源缓存、仅本 run 分析恢复和完整结果提升。 |
| `lib/fresh-analysis-context.js` | Node 库 | fresh run 的原文缓存、来源 SHA 重放与深分析上下文隔离；拒绝旧生成正文和跨 run checkpoint。 |
| `lib/fresh-rewrite-publication.js` | Node 库 | fresh 重写前精确备份 canonical/博客基线，完整新结果通过来源与基线 CAS 后才提升 canonical。 |

## 默认 LLM/API：恢复与维护入口

| 文件 | 职责 |
|---|---|
| `taxonomy-tools.js` | 校验标签registry并启动仅四个只读路由的回环预览服务；不提供本机助手或生产迁移。 |
| `paper_taxonomy.py` | 与Node共用registry的Python加载、验证和精确映射；未知/歧义不自动收窄。 |
| `taxonomy_paths.py` | 集中管理独立标签预览的Python路径，复用项目根与环境；不改变正式发布path_config模板指纹。 |
| `build-taxonomy-preview.py` | 只读扫描Hugo历史论文，生成有来源指纹的映射预览、完整旧词处置与待核报告；不修改博客或current。 |
| `deep-analysis-only.js` | 从 complete 筛选结果安全续跑未完成分析。 |
| `batch-analyze.js` | 对现有 canonical 中的未完成论文批量分析。 |
| `reanalyze.js` | 强制全量重分析，支持显式并发与数据文件。 |
| `reanalyze-selected.js` | 只重分析指定 arXiv ID，并同步恢复统计。 |
| `analyze-single-paper.js` | 从论文库取一篇论文分析并合并回 canonical。 |
| `refilter-reanalyze-by-date.js` | 对历史日期重新筛选、分析并写入受控日期快照。 |
| `refresh-api-reader.js` | 对指定论文或日期批次刷新 API reader/评分/作者/图片阶段。 |
| `evaluate-keyword-prefilter.js` | 只读回放金标准与历史正样本，报告关键词召回。 |
| `test-api-key.js` | 测试主模型或副模型的协议路由、代理和响应。 |
| `verify-project.js` | 沙箱外完整离线验证：固定 Hugo、全仓语法、默认/Manual JS 与 Python、只读数据门禁；`--quick` 仅语法与数据，不是完整验收。 |
| `llm-usage-report.js` | 只读汇总请求用量事件，区分真实 usage、不可得状态和字符估算，不推算未经证实的费用。 |
| `evaluate-reader-efficiency.js` | 显式、隔离、限额的单篇 Reader 效率实验；默认只预检，`--live` 才调用模型，不覆盖 canonical 或发布博客。 |
| `rewrite-from-source.js` | 显式 prepare/sources/analyze/status/patch/signed-patch/promote 的同源全新重写入口；patch 修失败候选，signed-patch 局部修订同 run 成功 Reader 并置事实待审，均无 API，不接受任意路径。 |
| `paper-rethink-server.js` | 历史独立维护工具；博客已取消本机助手集成，不应为阅读、引用或复制 AI 提问启动此服务。旧接口实现仍保留供历史维护。 |
| `validate-data-files.js` | 只读复验 current 数据、跨文件集合、评分和兼容 provenance。 |
| `backfill_papers.py` | 只补录历史论文 ID，不执行深度分析。 |

## 配置、环境与通用工具

| 文件 | 职责 |
|---|---|
| `config.js` | Node 参数与运行数据路径的集中配置。 |
| `env-loader.js` | 从项目 `.env` 重建受控环境，并守卫直接 Node/Manual 入口。 |
| `utils.js` | Node 原子文件、时间、ID、prompt、LLM 协议和代理工具。 |
| `llm-account-pool.js` | Node OpenCode Go 长期 sticky 账号选择、额度错误识别和跨进程状态。 |
| `log-setup.js` | Node 终端/文件日志、时间戳和敏感信息脱敏。 |
| `runtime-storage.js` | Node 只读统计运行存储，并对受控缓存/日志执行引用感知的 dry-run 或显式 `--apply` 清理。 |
| `project_env.py` | Python 项目环境、最小子进程环境与代理加载。 |
| `path_config.py` | Python 共享路径、日期与原子写配置。 |
| `llm_account_pool.py` | Python 与 Node 共享同一 OpenCode Go 账号池 schema/锁协议。 |
| `llm_usage.py` | Python 发布侧请求 usage 与失败事件记录，复用跨运行用量归因格式。 |
| `utils.py` | Python 评分解析与发布侧通用文本工具。 |
| `log_setup.py` | Python 统一日志与脱敏。 |
| `runtime_guard.py` | Python 沙箱外运行守卫。 |
| `python-runtime.sh` | 为默认博客/视觉入口选择并校验 Python 3.11+ 与 OpenSSL，可由 `PD_PYTHON_BIN` 覆写。 |

## 博客生成、审查与发布

| 文件 | 类型 | 职责 |
|---|---|---|
| `generate-blog.py` | Python 入口 | 只生成并安装 Hugo Markdown。 |
| `activate-fresh-publication.js` | Node 入口 | 显式激活已提升的 fresh 重发事务；持 run 操作锁调用 Python 凭证归档，不生成或推送内容。 |
| `publication_activation.py` | Python 入口/共享库 | 复验旧提交、基线与实时远端，私有归档六个精确状态文件；pending 门禁保护三阶段，支持中断重入，不修改已提升科学状态。 |
| `review-blog.py` | Python 入口 | 对 generation 执行确定性、LLM、图片和 Hugo 审查并签发 receipt。 |
| `push-blog.py` | Python 入口 | 复验 receipt，提交/推送并验证远端 OID，然后规划视觉任务。 |
| `publish-to-blog.py` | Python 核心 | 三阶段共用的生成模板、researcher-workbench-v1 front matter/citation 与 rethink sidecar、Git 事务、审查缓存、receipt 与发布证明实现。 |
| `publish_common.py` | Python 共享 | 发布数据、评分、Manual/API provenance 和 LLM review 公共契约。 |
| `blog_entry_loader.py` | Python 桥 | 以固定路径加载文件名含连字符的 `publish-to-blog.py`。 |
| `markdown_hugo_gate.py` | Python 共享 | Markdown、frontmatter、公式、图片和 Hugo 渲染门禁。 |

## 发布后视觉与状态

| 文件 | 类型 | 职责 |
|---|---|---|
| `visual-summary-state.js` | Node 入口/状态机 | TOP 10 论文长图任务规划、校验、登记、失败和历史归档；modern v3 仅取已签 Reader thesis/完整章节及原图缓存，QA 按章节 SHA 回指，不回退 canonical 摘要。 |
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
