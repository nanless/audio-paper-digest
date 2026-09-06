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
| `deep-analyzer.js` | Node 核心 | 单篇全文获取、多阶段分析、评分审计、API reader 长文和图片计划；结构修复后以 source-only 证据封口 `core-summary-detailed-v3`，并用显式阶段 DAG、SHA 投影和 stale snapshot 减少安全恢复时的整篇返工。 |
| `analysis-engine.js` | Node 共享 | 论文锁、重试、checkpoint、批量并发、canonical 合并与终态判断。 |
| `analysis-contract.js` | Node 共享 | API 分析结构、评分、方法/表格门禁及历史 Manual 兼容校验。 |
| `editorial-quality.js` | Node 共享 | API/Manual 共用的读者可见文风、事实、评分与可读性门禁。 |
| `digest-status.js` | Node 共享 | `papers.json` 的分析状态、批次日期和恢复状态同步。 |
| `lib/fetch-scheduler.js` | Node 库 | 按 host 串行调度、冷却和失败类型判定。 |
| `lib/filter-input-contract.js` | Node 库 | 筛选决定所绑定的最小输入 SHA。 |
| `lib/paper-taxonomy.js` | Node 库 | 共享标签registry的严格加载、同义解析、候选枚举、祖先查询与展示去重；不修改旧canonical标签。 |
| `lib/historical-taxonomy-assignment.js` | Node 库 | 从完成且来源绑定的历史 analysis run 重放 canonical 标签，精确映射 concept ID、裁剪祖先，并生成逐论文 assignment；文件名绑定 registry SHA，升级后保留旧 blocked/assigned 审计件。 |
| `lib/historical-page-staging.js` | Node 库 | 将完成 canonical 与新 taxonomy 投影到 crosswalk 保留的单篇路径；同一论文的重复历史页面共用新分析，输出隔离 staging run 与逐页 SHA。 |
| `lib/historical-daily-aggregate.js` | Node 库 | 完整重放并合并多份 per-paper staging、crosswalk/inventory 与新 canonical/taxonomy，按稳定次序重建每日汇总 staging manifest；旧汇总正文从不进入输入。 |
| `lib/historical-postprocess-scheduler.js` | Node 库 | 从 sealed-complete 历史 analysis scheduler 确定性执行重标、单篇 staging 与完整日期 daily aggregate；checkpoint 绑定逐项 SHA，最多并发 3，不写博客仓库。 |
| `lib/conference-postprocess.js` | Node 库 | 只接受 authenticated conference plan handle，逐篇重放 plan/source/completion/current taxonomy 与页面渲染；单篇目录同时绑定 registry 与 renderer/projection 实现指纹，代码升级不会覆盖旧 staging；仅在 execution 精确覆盖完整 selected member set 时生成隔离会议汇总。 |
| `lib/historical-publication.js` | Node 库 | 重放 page/daily producer 权威链，冻结 clean-main/remote/Hugo/baseline 与批次 DAG，并先生成不可变私有 bundle；本阶段不写博客、不 review、不 commit/push。 |
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
| `lib/conference-source-ledger.js` | Node 库 | 会议来源账本的身份、四类工件 SHA、审查证据、不可变读写和本地文件重放；标题绝不作为身份。 |
| `lib/conference-pdf-source.js` | Node 库 | 受控本机 PDF 的字节/路径/链接安全校验和可重放来源 descriptor；无可靠结构化 TeX 时公式明确不可用。 |
| `lib/conference-run.js` | Node 库 | 冻结会议成员、分片、taxonomy/选择策略版本和逐篇状态；completion proof 上线前拒绝 completed 与 publishable 聚合。 |
| `lib/conference-plan.js` | Node 库 | 从认证 import handle、reviewed plan 和当前 taxonomy 生成强绑定 run/plan receipt；拒绝任意路径、别名和非完整成员集。 |
| `lib/conference-importer.js` | Node 库 | 从认证 staging handle 安全导入会议 metadata/PDF/派生工件到私有 cache，并生成 ledger/import receipt；低层 manifest helper 只供隔离测试。 |
| `lib/conference-execution.js` | Node 库 | 仅从认证 plan handle 创建隔离 execution，持久化不可变 authority receipt；每次读取/推进都重放 plan authority，以锁、CAS 和受控 patch 持久化，completion proof 上线前不接受完成态。 |
| `lib/conference-analysis-context.js` | Node 库 | 将已认证会议 execution 的单篇来源封装为进程内 opaque 分析上下文；固定 Reader 尝试目录并拒绝 arXiv 身份、跨 execution 路径和伪造来源能力。 |
| `lib/conference-analysis-adapter.js` | Node 库 | 重放完整会议 plan/source authority 后复用公共深度分析引擎；prepare 先写不可变 intent，再以原子文件和精确前缀恢复保存 canonical、逐阶段 checkpoint 与完成 receipt。旧版缺少 prepare intent 的 execution 不会静默迁移，必须用同一 authenticated plan 新建 execution UUID。 |
| `lib/conference-discovery.js` | Node 库 | 从 ICASSP/ICLR/ICML 元数据快照与本机 PDF 目录生成只读候选 catalog 和匹配报告；标题匹配永不直接 verified。 |
| `lib/conference-source-context.js` | Node 库 | 生产入口仅从 opaque plan handle 重放完整上游证明与会议全文；不导出 ledger/run 测试捷径。 |
| `lib/conference-filter.js` | Node 库 | 冻结会议 catalog/Prompt/model/endpoint/taxonomy 指纹，以 durable intent→transport receipt→decision→CAS 管理决定；生产 signer 固定公共 LLM 路由，不接受 transport 注入，并以安全 stale lock 保证单飞恢复。 |
| `lib/conference-extraction-receipt.js` | Node 库 | 重放请求、来源和派生工件，并在每次 handle 加载时调用固定 Python/pypdf 临时重提取验证；只有字节一致且达到门槛的 weak profile 可进入 staging。 |
| `lib/conference-staging.js` | Node 库 | 将 authenticated filter selection 与人工复核 extraction 精确绑定为 import manifest/receipt；excluded 或身份别名不能进入。 |
| `lib/paper-identity.js` | Node 库 | `paper-identity-v1` 的 Node 规范化、官方来源 URL 门禁与稳定 SHA；不替换既有 arXiv helper。 |
| `lib/paper-source-authority.js` | Node 库 | 重放 canonical identity、完整 identity record、来源 snapshot/receipt/fulltext SHA 并返回 source-only opaque handle；通用磁盘 arXiv loader 永远不恢复 production authorization，会议合同还要求当前进程真实 plan handle。 |
| `lib/arxiv-source-authority.js` | Node 库 | 复用默认强制代理 arXiv 全文抓取器，把官方来源封存为 request→observation→fulltext→snapshot→receipt→authority；支持 O_EXCL 恢复且拒绝旧博客正文。 |
| `lib/arxiv-metadata-source.js` | Node 库 | 通过项目 HTTP CONNECT 精确抓取单篇 arXiv Atom 元数据，绑定原始响应 SHA 与白名单标题、摘要、作者、类别。 |
| `lib/page-source-crosswalk.js` | Node 库 | 跨运行时重放历史 inventory，以锁内 CAS/append-only 决策绑定 pageId/页面 SHA 与 production-authorized source authority；标题不能 verified，同 identity 多页确定性分组，finalize 与每次 final receipt 读取都重新验证来源。 |
| `lib/history-conflict-identity.js` | Node 库 | 仅对冻结 inventory 中 `conflict/multiple` 页面接受操作者明确选择的已有非标题 hint，并要求 production authority 精确匹配后生成 verified decision。 |
| `lib/historical-arxiv-analysis.js` | Node 库 | 将 live arXiv 全文 authority 和官方 Atom 元数据封装为可恢复的隔离 fresh-analysis run，不读取旧生成正文。 |
| `lib/historical-arxiv-analysis-scheduler.js` | Node 库 | 从 crosswalk 已 verified 的唯一 arXiv identity groups 派生稳定 run ID，按 pilot/限额可恢复准备或执行隔离历史分析。 |
| `lib/historical-arxiv-batch.js` | Node 库 | 按唯一 arXiv 身份批处理 single-hint 历史页面；同身份多页共用一次 live 来源授权，逐页 CAS 并持久化尝试记录。 |

## 默认 LLM/API：恢复与维护入口

| 文件 | 职责 |
|---|---|
| `taxonomy-tools.js` | 校验标签registry并启动仅四个只读路由的回环预览服务；不提供本机助手或生产迁移。 |
| `conference-tools.js` | 只读校验私有会议 ledger/run；只接受受控 runtime 目录内的直接文件名，不导入 PDF、不联网、不调用模型。 |
| `conference-analyze.js` | 从完整会议 plan/import/filter/discovery 证明准备、执行或查看隔离的逐篇深度分析；恢复时重新验证 live authority，不写日更 `current`。 |
| `conference-import.js` | 只接受 staging/import 双文件及完整 discovery/filter 证明，复制认证来源并成对写 ledger/import receipt；不接收任意路径。 |
| `conference-discover.js` | 只读扫描显式会议元数据/PDF目录并生成 O_EXCL 候选 catalog/report；不确认身份、不调用模型。 |
| `conference-plan.js` | 重放 discovery→filter→staging→import 全链、reviewed plan 和 taxonomy SHA，成对创建不可覆盖 run/plan receipt。 |
| `conference-execution.js` | 重放 run/plan/import/staging/filter/discovery 全链创建隔离 execution，并以受控 patch/CAS 推进；不写日更 `current`。 |
| `conference-filter.js` | 创建、检查和应用受控会议筛选 decision；手工入口不能构造或加载 LLM actor，生产 LLM 工件只由受控 runner 内部签发。 |
| `conference-filter-run.js` | 仅在显式 `--apply` 下从认证 discovery/filter/spec 逐篇调用固定公共 `requestLlmJson()`；pending 优先，failed 仅显式限次退避重试，崩溃先恢复已有证据且不自动重复计费。 |
| `conference-staging.js` | 把完整 filter included 集合与已审 extraction 工件绑定成不可覆盖 import manifest/receipt；不复制文件或调用模型。 |
| `conference-extract.py` | 对 staging-source 中一篇显式 PDF 执行 text-only 页级提取；`--verify --source-root ABS` 用固定 pypdf 临时重提取并比较已有 bundle，仍不声明公式/表格/图片可靠。 |
| `conference_extractor.py` | Python 会议 PDF 提取实现：严格文件/SHA、UTF-8 byte offset、pypdf 页文本、O_EXCL 和 typed blocked/integrity 状态。 |
| `history-inventory.py` | 只读扫描配置博客的历史页面、URL 与聚合拓扑；dry-run 零写，apply 在 clean main 上成对写不可变 ledger/receipt。 |
| `historical_page_scan.py` | `historical-page-ledger-v1` 严格扫描：无旧正文、稳定 pageId/cohort、逐次链接目标、未核 taxonomy 候选、Git tree/remote-main proof，以及 scan→O_EXCL 写入前后 CAS。 |
| `historical-page-render.py` | 只从完成 canonical 与 assigned taxonomy packet 渲染历史单篇页面；不读取旧页面正文。 |
| `page-source-crosswalk.js` | 从直接命名的历史 ledger/receipt 创建隔离 crosswalk，管理受控 decision/CAS；普通磁盘 arXiv bundle 不能升级 production 权限；`finalize` 要求全部 verified 且来源可现场重放。 |
| `history-conflict-identity.js` | 同一进程现场验证官方 arXiv 来源，并将操作者选择的已有冲突 hint 写成 verified decision 后 CAS apply；不读旧正文或标题。 |
| `arxiv-source-authority.js` | 对规范化 arXiv ID 规划或抓取官方全文；组合参数在同一进程用 live opaque handle 完成 verified decision/CAS，磁盘重载会降级；dry-run 不联网、不写盘。 |
| `historical-arxiv-analysis.js` | 用 live arXiv authority 与白名单原始抓取元数据建立隔离 source-only run；`analyze` 复用现有多阶段引擎，canonical 不写入 daily current。 |
| `historical-arxiv-analysis-scheduler.js` | 从 finalized crosswalk 批量调度历史 arXiv run；以 `new-full`、`reader-recovery`、`all` 分离队列，支持联网前 fail-closed 的精确 `--paper-ids`、pilot/数值 limit 与小并发恢复。 |
| `historical-taxonomy-assignment.js` | 对完成的历史 analysis run 执行单篇或批量 deterministic 重标；dry-run 零写，apply 只写独立 assignment artifact，不调用 LLM。 |
| `historical-page-staging.js` | 按显式 analysis run 与当前 registry SHA 精确选择 assignment，从 verified crosswalk 生成隔离单篇页面 staging；不写博客仓库。 |
| `historical-daily-aggregate.js` | 以 `--staging-runs UUID[,UUID...]` 合并多份单篇 staging run，重建 daily summary 的隔离 manifest；保留原路径/URL，dry-run 零写，apply 不写博客仓库。 |
| `historical-publication.js` | `plan` 冻结历史发布输入、博客基线与逐路径操作；`generate` 再重放 producer 并 O_EXCL 写私有 bundle。conference refs 在有 authenticated aggregate 前明确拒绝。 |
| `historical-postprocess-scheduler.js` | 可恢复批量编排历史重标、per-paper staging 和就绪日期汇总；支持 dry-run/apply、pilot/限额、日期和 1–3 并发。 |
| `conference-postprocess.js` | 使用完整 conference plan authority flags 对单篇执行重标/staging，或对 plan 全量 selected members 生成隔离 aggregate；roots 全部来自项目配置。 |
| `conference-page-render.py` | 从已封存 conference Reader 与 assigned taxonomy 渲染无 arXiv 别名的弱结构会议单篇页；不生成资产，不读取旧博客正文。 |
| `historical-arxiv-batch.js` | 对 pending single-hint arXiv 页面按唯一论文分组抓取与 verified 映射；支持 pilot/数值 limit 和可恢复全量续跑，不调用 LLM。 |
| `paper_identity.py` | `paper-identity-v1` 的 Python 同构实现，使用共享向量防止发布侧与 Node 身份/SHA 漂移。 |
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
