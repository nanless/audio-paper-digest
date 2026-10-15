# 脚本索引

只维护日更、官方会议与历史博客更新。命令权威来源是根 `package.json`，源代码和Prompt分工见 [三流程对应表](../docs/three-workflows.md)。

| 流程 | 当前入口/适配 | 共用核心 |
|---|---|---|
| 日更 | `full-fetch.js`、`deep-analysis-only.js`、`batch-analyze.js`、`refresh-api-reader.js` | `analysis-engine.js`、`deep-analyzer.js`、`analysis-contract.js` |
| 会议 | `official-conference-acquire.js`、`conference-discover.js`、`conference-filter-run.js`、`conference-process.js` | 同一引擎、Reader、评分、标签和当前Prompt |
| 历史 | `historical-direct-rewrite-inputs.js`、`historical-direct-rewrite-plan.js`、`historical-direct-rewrite-run.js`、`history-resume.js` | 同一引擎；来源/历史范围与旧断点用适配器保留 |
| 页面 | `generate-blog.py`、`conference-page-render.py`、`historical-page-render.py` | `publish-to-blog.py`、`paper_reader_presentation.py`、真实身份的研究引用导出 |
| 审查发布 | `review-blog.py`、`push-blog.py`、`publish-conference.py`、`lib/historical-direct-publication.js` | `publish_common.py`、正文/图片审查、Hugo、精确清单、Git与网页核验 |
| 文件与实现证明 | `lib/paper-page-staging.js`、`lib/publication-file-primitives.js` | 不可变写与回读SHA；`lib/workflow-implementation-files.js`的传递依赖指纹 |

## 日更与受控恢复

三流程先统一跑本次选定全批，整轮保存后只续可重试失败集合，默认总共3轮。公共轮次、Reader原预算及人工建议的区别见 [共享规则](../docs/three-workflows.md#全批轮次与失败集合)。

默认 LLM/API 日更的 `digest:prepare` 是完整入口；用户明确取消视觉时可加 `--no-visuals`，推送后只建立豁免所需清单并登记当前发布版本的声明，跳过实际参考图准备和生成；抓取调用 `full-fetch --require-previously-fetched`，以核验旧检查点派生重叠见证并检查各源实际命中；页内/窗口完整覆盖和仅已发布去重仍保留；`deep`、`batch`、`reanalyze`、`reanalyze:selected`、`api:reader:refresh` 只消费正式日更来源封存，不重新获取历史来源。Reader重试、已付费稿恢复和人工修正保留原稿、预算与费用，见 [恢复说明](../docs/reader-explicit-retry.md)。

Reader 刷新默认使用配置并发5和总轮数3，`--concurrency N` 范围1–60，`--rounds N` 范围1–10。仅明确可重试失败进入下一轮；同次正常轮不改 Reader epoch。强制重分析首次按单篇执行已授权重置，后续失败轮保持原候选、次数及费用。

## 官方会议

使用 `conference:acquire/discover/filter/process`；`conference:publish:generate/review/push/verify`独立处理发布。旧execution/analyze/postprocess CLI已删除，不能绕过统一process来源/权限检查。参数见 [会议说明](../docs/conference-workflow.md)。

## 历史博客

使用 `history:inputs/plan/sources/run/aggregate/publication`，范围和Source参数见 [历史说明](../docs/history-rewrite.md)。`history:resume`用于当前暂停计划或受限恢复已存在的旧来源任务，不创建旧任务或清零预算。必要来源取得、标签补充、状态和控制工具仍属于历史维护。

## 共享支撑

环境、路径、模型/代理、账号池、标签词表、运行锁、费用、不可变Source、论文图临时处理、来源表格/公式/作者核验以及视觉规划/登记/豁免仍是三流程依赖。图片生成须由内置工具完成；本项目没有图像API生成器。

`manual/scripts` 是共享兼容边界，只保留旧来源/签名/正文与Prompt合同核验、单页独立人工审查。完整作者/任务/spec生产、社交发布、backfill及实验/视觉调试入口已删除。

安装后的显式路由诊断使用 `test-api-key.js`，它会发送真实请求。历史 Prompt 通过原 Git blob 和 SHA 只读核验，不生成工作树中的旧正文归档。

## 验证

```bash
npm run verify
npm run validate:data
npm run test:default
npm run test:compat
```

完整验证包括共享核心、三来源适配、旧记录兼容、JS/Python/Shell语法、固定版本Hugo和正式数据只读核验；入口成功或页面暂存不等于已上线。

## 运行时文件逐项索引

本表仅列当前保留文件；入口及来源差异见上方三流程表，传递调用关系见本次依赖审计。

| 文件 | 类型与职责 |
|---|---|
| `activate-fresh-publication.js` | Node 入口：显式接替同日已提升重写结果的旧发布，持有本运行操作锁后调用 Python 归档旧凭证；不生成内容或推送。 |
| `analysis-contract.js` | Node 共享：核验 API 分析的结构、评分、方法和表格要求，同时能读历史 Manual 结果。 |
| `analysis-engine.js` | Node 共享：用公共失败轮次调度，首轮全批、下一轮只失败集合，等待每轮结果和保存完成；管理论文锁、重试、检查点、批量并发与结果合并，并判断每篇是否完成；`PD_CHECKPOINT_TIMING=1` 可记录保存各步骤的耗时。 |
| `analysis-waiver.js` | Node 库：核验用户针对当前日更批次的分析豁免，检查 deep、filtered、papers 三份文件的精确字节和逐篇来源 SHA；不修改分析正文。 |
| `analysis_sections.py` | 在 Python 解析和发布检查中识别论文评价章节，兼容旧标题并拒绝重复或混用。 |
| `arxiv-source-authority.js` | 按规范 arXiv ID 规划或获取官方全文，用来维护来源授权；它不是 direct 路线或 arXiv 获取失败备用批次的选择器。dry-run 不联网、不写文件。 |
| `batch-analyze.js` | 正常读取完整封存日更来源并逐篇锁内续跑；可重复 `--fact-feedback-file FILE`。`--refresh-reader-diagnostics` 保留原草稿与调用次数。明确有预算重试须同时提供 `--retry-failed-readers --reader-retry-manifest FILE`，或程序传入 `main({ readerRetryManifestPath: FILE, refreshReaderDiagnostics: true })`；只处理清单中同输入且耗尽的失败稿，旧稿与费用保留，初次明确付费轮最多3次已保存尝试/1次已保存完整重写/6实际请求/80k预留输出；后续局部或缺正文恢复使用单独的有界追加清单，原账和累计上限继续核验。无清单、坏绑定、仍有次数或成功稿拒绝。见 恢复说明。 |
| `blog_entry_loader.py` | Python 桥：以固定路径加载文件名含连字符的 `publish-to-blog.py`。 |
| `blog_repository_lock.py` | 管理共享博客锁，以 Git common-dir 协调不同项目工作区；核对 PID、hostname、token、lease、inode 和 SHA 后才回收或释放，不污染博客 Git。 |
| `build-tag-preview.py` | 根据历史页面元数据生成私有标签索引、旧标签处理表和待评审报告，不改写博客。按名称或别名作字面对照；七种处理状态和证据要求见本页的分类词表维护说明。 |
| `conference-discover.js` | 只读扫描显式会议元数据/PDF 目录，按 `O_EXCL` 保存候选与报告；不确认身份，不调用模型。 |
| `conference-extract.py` | 从暂存来源中的一篇显式 PDF 提取页文本和视觉审计。`--verify --source-root ABS` 用固定 PyMuPDF 临时重新提取，比较已有文件的全部字节；公式缺少原始 TeX 时不能发布为展示公式。 |
| `conference-filter-evidence-extract.py` | 证据提取使用的固定 PyMuPDF 子进程，只从受控来源目录读取请求、元数据和 PDF，输出页文本、逐页 PNG 审计、图表及公式候选、摘要定位和可核验凭证；不联网，不调用模型。 |
| `conference-filter-evidence.js` | 模型筛选前，根据认证候选中的封存 PDF 提取全文和 `abstract-locator-v1` 原文摘要定位证据，保存可恢复的候选与报告；不作筛选决定，不请求模型。 |
| `conference-filter-run.js` | 只在显式 `--apply` 时核验与候选、报告及证据运行记录对应的筛选配置，再逐篇调用固定公共 `requestLlmJson()`。新执行使用 v6 配置，已核验的旧 v5 运行按原格式继续。先处理 `pending`；`failed` 仅在显式授权、尝试次数和退避条件满足时重试。中断后先恢复已有记录，不能自动重复计费。 |
| `conference-filter.js` | 用同一会议已核验的候选及报告双文件和完整证据运行记录创建专属 v6 筛选配置，再创建、检查或应用受控筛选决定。旧 v5 配置只用于核验和继续同一 UUID 的原运行。手工入口不能创建或加载标为模型决定的记录；这类记录只能由受控运行器生成。 |
| `conference-import.js` | 仅接受暂存/导入双文件与完整发现、筛选记录，复制认证来源并成对保存来源清单和导入凭证；不接受任意路径。 |
| `conference-page-render.py` | 从已封存的会议 Reader 与已分配分类渲染会议单篇页，说明这份 PDF 来源提供哪些正文、图片、表格和公式依据，不使用 arXiv 身份别名；不生成图片文件，不读取旧博客正文。 |
| `conference-plan.js` | 核验发现、筛选、暂存、导入的整条链，以及已审计划和词表 SHA，成对生成不可覆盖的运行和计划凭证。 |
| `conference-process.js` | 新会议唯一生产批处理入口。从完整入选集自动封存官方 proceedings 精确 PDF、导入、创建当前分类计划，以稳定逐篇 UUID 调用公共分析引擎；整批默认并发 1，可通过 `--concurrency` 设为 1–5，每篇内部分析并发固定为 1。生成单篇与全会私有页面，以检查点和完成凭证核验整个流程；不发布博客，来源升级选择规则见本页末尾。 |
| `conference-queue.js` | 官方会议受控队列的命令入口，统一领取与恢复 process 任务。 |
| `conference-staging.js` | 将完整入选集和已审提取结果一一核验，生成不可覆盖的导入清单与凭证；不复制文件，不调用模型。 |
| `conference-tools.js` | 只读校验私有会议 ledger/run；只接受受控运行目录内的直接文件名，不导入 PDF、不联网、不调用模型。 |
| `conference-workspace.js` | 检查会议运行所需目录、工作区和受控来源准备状态。 |
| `conference_extractor.py` | 实现会议 PDF 提取：核验文件与 SHA，记录 UTF-8 字节偏移，生成页文本、PNG、图片与版面候选；以 `O_EXCL` 保存，按结构字段报告 blocked/integrity 状态。 |
| `conference_publication_gate.py` | 核验会议身份、来源账本和页面发布资格。 |
| `config.js` | 集中保存 Node 参数与运行数据路径。 |
| `deep-analysis-only.js` | 只读取当前 `dailyFreshSourceRun` 的封存 PDF/TXT，继续分析筛选已完成但分析未完成的论文。来源缺失或不匹配时停止，不抓取，也不读取旧缓存。 |
| `deep-analyzer.js` | Node 核心：获取单篇全文，执行多阶段分析、评分审计、API Reader 写作和图片规划。结构修复后，只用原文证据核验 `core-summary-detailed-v3`；按阶段依赖、SHA 和旧检查点决定恢复范围，尽量少做整篇重做。 |
| `digest-cover-state.js` | Node 入口/状态机：规划、校验、登记每日汇总封面任务，处理失败并归档历史记录。 |
| `digest-run-report.js` | Node 入口：汇总抓取、筛选、分析、远端发布和两类视觉状态，按当前日期、来源及范围保存/读取日更正常轮次和人工建议诊断；尚未自动核验部署与网页。 |
| `digest-status.js` | Node 共享：同步 `papers.json` 的分析状态、批次日期和恢复状态。正常日更、deep 与 batch 收尾通过 `synchronizeCompletedAnalysisDigestStatuses` 补齐被跳过旧成功记录的状态；先持规范论文锁，再重读正式结果与封存来源，仅一次保存状态不符的成功记录，不覆盖最新失败。 |
| `editorial-quality.js` | Node 共享：检查 API/Manual 读者正文的语言、事实表述、评分和可读性。 |
| `env-loader.js` | 从项目 `.env` 建立受控运行环境，检查直接 Node 和 Manual 入口的运行条件。 |
| `evaluate-keyword-prefilter.js` | 只读取人工判定的样例和历史入选记录，用当前关键词预筛规则检查是否通过预筛。裁决后的正样本召回与原始命中率分开统计，已裁决负样本误放单列；缺少有效样本或存在误放时非零退出，读取及格式错误不按空样本处理。 |
| `fetch-huggingface-papers.js` | Node 模块/入口：通过最小环境中的 `curl` 抓取 HuggingFace Papers。 |
| `fetch-papers.js` | Node 模块/入口：负责 arXiv 抓取、摘要补全、关键词预筛和逐篇 LLM 筛选；独立使用抓取模块也需要项目 Python 3.11+ 运行器来严格解析 Atom。 |
| `full-fetch.js` | Node 入口：按顺序执行默认数据流程，依次归档、抓取、筛选、去重、深度分析，并逐篇保存结果。旧结果首遍用ID索引，初始化按映射合并，内存只保留每篇最新尝试；逐次失败、检查点及费用仍持久保存。 |
| `generate-blog.py` | Python 入口：只生成并安装 Hugo Markdown。 |
| `historical-archive-crawl-batch.js` | 已停用的兼容入口，调用时直接拒绝；已有归档抓取数据只能由 direct 路线读取。 |
| `historical-arxiv-batch.js` | 备用入口只接收 `--handoffs NAME.json[,NAME.json...]` 命名、不可变的 arXiv 获取失败交接文件，逐页核验冻结清单、页面 SHA 和非标题链接；不扫描 crosswalk pending 页、不调用模型，也不阻断 direct 队列。 |
| `historical-arxiv-publication-metadata.js` | 默认对直接重写计划全部 arXiv 论文预览或批量封存官方 Atom 附件。只复用满足当前论文版本和时间窗的原始 Atom，其余按封存来源 ID 经公共 CONNECT 适配器精确获取，不调用模型。瞬时失败最多重试三次；单篇耗尽后继续整批，最后报告 partial 并非零退出。失败项不生成附件，重跑只补缺失项。 |
| `historical-conference-crawl-batch.js` | 已停用的兼容入口，调用时直接拒绝；会议元数据、PDF 和精确标题指纹只能用于 direct 本地来源与页面对应，不能写进 crosswalk。 |
| `historical-conference-local-sources.js` | 只读生成本地会议来源清单 v2，必须显式传绝对 `--icml-poster-snapshot` 与已有 `--icml-pdf-root`。新 PDF 和获取凭证根目录由参数或集中配置提供；不接触历史页、crosswalk、模型、网络或发布。 |
| `historical-conference-page-projections.js` | 从指定的本地来源目录和历史清单确定会议论文与页面的对应关系；核对页面文件 SHA，但不把旧正文用于重写。 |
| `historical-direct-aggregate.js` | 为直接重写中已完成的论文记录生成可重新核验的日汇总或会议汇总私有页面。 |
| `historical-direct-control.js` | 提供全历史长任务控制：`history:status` 单次或持续只读汇总任务登记记录、暂停、锁、覆盖率、汇总结果和发布阻断项；`history:pause` 保存对应计划与获取序号的停止请求；`history:resume` 只在操作锁释放后恢复。 |
| `historical-direct-publication.js` | 全历史直接重写发布入口：按 `plan → generate → review → publish → status` 驱动单一 publication UUID；发布阶段独占共享博客锁并验证远端 `main` OID。 |
| `historical-direct-review.py` | 协调历史直接重写的逐页语义审查，复用正式发布的 LLM 与多模态审查，保存对应输入、模型、提示词和代码的检查点；全部页面通过后才生成最终凭证。 |
| `historical-direct-rewrite-inputs.js` | 用冻结清单中的唯一 arXiv 提示、严格主评分行身份、ICML poster 的全部身份及符合本地 PDF 使用规则的身份、会议来源清单和博客根目录，生成范围固定的 v5 输入目录；不要求额外 arXiv 来源清单。 |
| `historical-direct-rewrite-plan.js` | 用直接重写的 v5 来源目录、历史清单与会议页面对应记录 v3 生成原文重写计划，核验 arXiv 主身份与符合本地 PDF 使用规则的 ICML 身份；拒绝旧 v4/v3 文件，并报告未覆盖历史论文页。 |
| `historical-direct-rewrite-run.js` | 运行仅使用原文的直接重写分析、Reader 和单篇私有页面生成。apply 要求所选项已有同计划、同获取序号的 scheduler-ready 状态；失败阶段按来源核验过的恢复文件跨进程续跑，不能当成已生成页面。 |
| `historical-direct-rewrite-scheduler.js` | 只准备直接重写计划的 arXiv/会议来源队列和封存文件，支持固定论文集合/上限、计划及获取序号锁、暂停标记、安全信号停止与逐项进度。arXiv 原子保存 TXT、PDF、元数据、清单；失败只保存不可变 crosswalk 交接文件，不执行分析、Reader、crosswalk 或发布。 |
| `historical-direct-tag-supplement.js` | 在当前工作区生成不可变分类补充和报告，不修改博客页面或发布状态。所需计划、词表、博客、快照及运行参数见本页的历史补充维护说明。 |
| `historical-icml-alternate-pdf-source.js` | 只封存代码白名单中的 ICML 替代来源，固定 poster/forum、标题、作者与来源 URL。`--import-file` 仅允许 `n1mAjfRDZ6`，重新提取并匹配标题、作者、日期和跨页特征文本，以非网络获取凭证记录浏览器下载导入。 |
| `historical-local-crawl-batch.js` | `historical-archive-crawl-batch.js` 已停用兼容入口的别名，调用时直接拒绝。 |
| `historical-openreview-pdf-source.js` | 为一个已认证 ICML/OpenReview forum ID 规划或封存缺失官方 PDF。dry-run 不联网、不写文件；PDF 保存到本地来源清单实际读取的 ICML PDF 根，凭证单独进入运行目录。 |
| `historical-page-render.py` | 根据上游核验过的历史论文输入生成单篇页面。普通历史路径使用标签分配记录，直接重写路径使用保存的分析和来源记录；正文从分析结果重新解析，不使用旧页面正文。 |
| `historical-source-identity-supplement.js` | 在当前工作区核验全部封存来源和没有正式分类记录的旧页，生成独立不可变身份证明，保留会议来源与论文版本披露，不请求模型。参数见本页的历史补充维护说明。 |
| `historical-source-tag-assignment.js` | 在当前工作区按原文生成分类补充，逐请求保存选择、审查和决定的检查点。同 UUID 核验输入后续跑；账号耗尽只保存编号 partial，不占用最终分类结果文件。参数见本页的历史补充维护说明。 |
| `historical-tag-checkpoint-export.js` | 从分类检查点或部分运行记录导出页面分类记录和处理报告，保留原分类缓存，不调用模型。恢复、排除集合和新运行参数见本页的历史补充维护说明。 |
| `historical_page_scan.py` | 按 `historical-page-ledger-v1` 扫描历史页面，不收集旧正文；记录稳定 pageId/cohort、逐次链接目标、待核分类、Git tree 与远端 main。扫描前后及 `O_EXCL` 保存前核验 CAS。 |
| `history-conflict-identity.js` | 在同一进程核验官方 arXiv 来源，再将操作者明确选定的已有冲突提示记录为 verified 决定，并按 CAS 写入；不读取旧正文或标题。 |
| `history-inventory.py` | 只读扫描配置博客的历史页面、URL 和汇总关系。dry-run 不写文件，apply 在干净 main 上成对保存不可变页面清单与凭证。 |
| `history-resume.js` | 现行计划暂停恢复和既存旧运行恢复的统一入口。 |
| `icmc-proceedings.py` | 从官方 ICMC 2026 合并 proceedings PDF 的书签和目录提取论文顺序、页范围与作者元数据，并按页范围无栅格化拆分单篇 PDF；不调用模型、不改写原始图表公式。 |
| `lib/analysis-section-titles.js` | 识别分析章节及代码围栏，读取唯一的论文评价章节，并兼容旧标题而不改写原文。 |
| `lib/analysis-stop-control.js` | Node 库：在批量分析和 Reader 刷新期间处理温和停止，停止领取新论文和发送新模型请求，保留已返回内容与原费用账；嵌套调用共用停止状态，并行调用分开记录，完成后移除信号监听器。详见分析停止说明。 |
| `lib/analysis-terminal-summary.js` | 为分析结束时的状态、文本来源和计数提供中文显示，未知值显示原值。 |
| `lib/analysis-failure-rounds.js` | Node共享：固定首轮范围、全批轮次屏障、可重试失败集合、运行级停止及人工接手建议；不操作来源文件、正文、费用或发布资格。 |
| `lib/analysis-batch-report.js` | Node共享：将 Reader 刷新固定范围、来源引用、轮次和人工建议保存为私有诊断；不签来源、成功正文或发布凭证，不授权新请求。 |
| `lib/arxiv-metadata-source.js` | Node 库：通过项目 HTTP CONNECT 获取单篇 arXiv Atom 元数据，核验原始响应 SHA，并提取白名单中的标题、摘要、作者与类别。现行 v1 先严格校验 XML，再按既有规则保留字段中的实体和作者空白，以按原规则重新计算并核验旧封存 SHA；正常日更抓取使用解码后的 XML 字段。 |
| `lib/arxiv-source-authority.js` | Node 库：使用默认强制代理抓取器获取官方 arXiv 全文，依次分别保存请求、来源配对、来源响应记录、全文、快照、凭证和授权。每份文件写入后核验其字节，已保存的文件不能覆盖；续跑重核原请求与完整来源字节，拒绝旧博客正文。 |
| `lib/cancelled-reader-audit-recovery.js` | 在正常分析入口确认已取消步骤留下的失败，核验现有正文、来源及原请求记录后复用结果，由分析引擎收尾；不新增模型请求，不删除原阶段错误和费用记录。 |
| `lib/cancelled-reader-final-checkpoint.js` | 确认最终正文仅被已取消步骤阻挡时，在原完整性、来源和反馈核验通过后从真实检查点继续，不重新生成已完成内容。 |
| `lib/completed-bound-fact-feedback.js` | Node 库：供普通批量和单篇续跑共用，核验同一事实反馈已完成、来源仍一致且错误原句未残留；不改变显式强制重分析。 |
| `lib/completed-reader-upstream.js` | 核验读者文章之前的主文、摘要、标签、评分、来源及原反馈，供正常恢复入口共用。 |
| `lib/conference-analysis-adapter.js` | Node 库：重新核验完整会议计划与来源后调用公共深度分析引擎。准备阶段先保存写入后不再改动的准备记录，绑定计划、来源与初始分析文件的 SHA；中断恢复按准备记录、来源文件、初始分析文件、运行记录的顺序核对已有内容并补齐缺失文件。分析完成后另核结果 SHA，再保存完成凭证。旧执行记录缺少准备记录时不自动迁移，须用同一认证计划新建执行记录和 UUID。 |
| `lib/conference-analysis-context.js` | Node 库：把已认证执行记录中一篇论文的来源放入仅在当前进程可用的分析上下文，固定 Reader 尝试目录；拒绝 arXiv 身份、其他执行目录，以及与已核验来源记录不符的正文、表格、公式和图片状态。 |
| `lib/conference-discovery.js` | Node 库：只读扫描 ICASSP/ICLR/ICML 或严格 `official-proceedings` 元数据快照和本机 PDF 目录，生成候选与匹配报告。新会议只按元数据稳定 official ID/`pdfFile` 匹配，标题不能作为身份。 |
| `lib/conference-execution.js` | Node 库：只从认证计划创建独立执行目录并保存不可变授权凭证。每次读取或推进都核验计划，在锁内核对旧内容仍未改变，再用受控补丁保存结果；通用接口仍拒绝直接写入完成状态。 |
| `lib/conference-extraction-receipt.js` | Node 库：核验请求、来源和提取文件；每次加载时由固定 Python/PyMuPDF 临时重新提取并比较结果。视觉审计含逐页 PNG、内嵌图片、表格、Figure、公式候选和 SHA；无原始 TeX 时禁止绑定公式文本。 |
| `lib/conference-filter-evidence.js` | Node 库：从认证候选记录批量核验官方精确 PDF，由固定 PyMuPDF 提取页文本、视觉审计和原文摘要定位证据。保存可恢复的证据运行、候选及报告；非 ready 项一律交给 LLM，不能直接排除。 |
| `lib/conference-filter.js` | Node 库：固定候选、已核验的证据文件、逐篇凭证、日更提示词、关键词策略、会议领域标签，以及模型、接口地址和词表的指纹。状态为 `ready` 的摘要进入关键词和提示词筛选；其他项交给模型。程序在请求前保存准备记录，绑定请求内容、来源与原状态 SHA，再保存请求凭证和筛选决定；写入前核对原状态。生产凭证只能由固定公共 LLM 路由生成，不允许替换网络请求实现；恢复时先核验旧锁和已有记录，避免重复执行。 |
| `lib/conference-importer.js` | Node 库：根据已认证的暂存记录，把会议元数据、PDF 和提取结果安全导入私有缓存，再保存来源清单和导入凭证；低层清单辅助函数仅供隔离测试。 |
| `lib/conference-pdf-source.js` | Node 库：核验受控本机 PDF 的字节、路径和链接，生成可重新核验的来源描述；没有可靠结构化 TeX 时明确标记公式不可用。 |
| `lib/conference-plan.js` | Node 库：只从已认证的导入记录、已审计划和当前词表生成运行与计划凭证，核验相互对应的输入；拒绝任意路径、别名和不完整成员集。 |
| `lib/conference-postprocess.js` | Node 库：只接受已认证的会议计划，逐篇核验计划、来源、完成结果、当前分类和页面渲染。单篇目录包含词表与渲染实现指纹，代码升级不覆盖旧页面；只有执行记录精确覆盖完整入选集时才生成私有会议汇总。 |
| `lib/conference-process-recovery.js` | 保留会议断点、已付费阶段与原来源绑定的恢复规则。 |
| `lib/conference-process.js` | Node 库：对会议完整入选集合封存官方 PDF、导入来源，调用公共引擎分析，生成读者文章、评分、分类页面和汇总。整批默认并发 1，可设为 1–5；每篇内部并发固定为 1。新进程及完成凭证使用各自 v2 格式，词表身份写入 `tagCatalogVersion`、`tagCatalogSha256`；旧记录完整核验后沿原 UUID 恢复。 |
| `lib/conference-publication-author-replay-cli.js` | Node 子进程入口：供会议发布器通过私有文件调用的本地来源核验入口；输出逐篇已核验作者及分析、完成凭证、来源快照 SHA，禁止网络与配置加载。 |
| `lib/conference-publication-author-source.js` | Node 库：只读核验官方元数据、PDF、已有抽取来源与分析凭证，核完整姓名及作者机构；不新建来源、不重抽 PDF 或请求模型。 |
| `lib/conference-queue.js` | 会议队列状态、领取与并发保护；调用统一 process。 |
| `lib/conference-run.js` | Node 库：固定会议成员、分片、分类策略、选择策略版本和逐篇状态。通用状态接口拒绝直接写 `completed`；聚合发布接口还要求一项尚未实现的认证完成证明，因此不能据此宣布会议可以发布。 |
| `lib/conference-source-context.js` | Node 库：生产入口只接受当前进程实际核验并登记的计划对象，再核验完整上游证明并读取会议全文；不导出 ledger/run 测试捷径。 |
| `lib/conference-source-ledger.js` | Node 库：管理会议来源身份、四类文件 SHA 和审查证据；文件不可变保存，读取时重新核验本地来源。标题不能作为论文身份。 |
| `lib/conference-source-upgrade.js` | 会议来源能力升级的身份和已有分析绑定检查。 |
| `lib/conference-staging.js` | Node 库：将认证的会议入选集与人工复核的提取结果一一核验，生成导入清单和凭证；排除项和身份别名都不能进入。 |
| `lib/core-summary-semantic-replay-cli.js` | Node 只读子进程：Python 发布检查核对封存原文 SHA 后，通过私有受限文件描述符复用当前分析侧的详细核心摘要语义规则；保留摘要阶段与正文 SHA 检查，禁止模型或网络请求。 |
| `lib/daily-fact-review.js` | Node 库：只读外部事实反馈，严格核验论文、日期、runId、四份封存来源SHA、当前核心摘要及全文SHA与逐字引文；锁内重读后将反馈传入正常完整主分析、摘要、Reader或标签模型阶段；全文纠错先保存原付费记录，并拒绝无反馈重生成，不写手工成功正文。 |
| `lib/daily-fetch-boundary.js` | Node 库：从已核验远端日更及受控归档确定补抓窗口，读取正式页字段去重；见边界说明。 |
| `lib/daily-fresh-source-plan.js` | Node 库：日更筛选结束后，为每篇 arXiv 论文封存本次官方 TXT、PDF 和清单；分析只读取这组文件，图片只在当前请求里临时准备。 |
| `lib/daily-reader-operator-correction.js` | Node 库：显式日更人工修正清单覆盖完整失败集合，通常最多10篇；大批次按重读原封存入选集的10%取整增加、硬限15篇，扩展时核验完整唯一集合。重读四份封存来源、原失败草稿与每篇1–8节点SHA补丁；原候选及费用不改，由正常 Reader 全量解析验收并记录本地修正来源，不作为模型响应或新收费额度。 |
| `lib/direct-rewrite-analysis-context.js` | Node 库：用 AsyncLocalStorage 隔离历史重写和日更的来源文件，让旧正文和缓存进不了分析，Reader 图片只能用临时文件；论文历史版本的身份 SHA 随来源记录进入所有分析阶段。 |
| `lib/explicit-reader-retry-round.js` | Node 库：为已核验且用完原有额度的失败长文执行明确的新一轮重试，核对论文锁、四份封存来源、实际输入和原稿 SHA；完整保留旧稿与旧次数，发送请求前登记新轮费用预算。重复运行只接续剩余额度，不授予发布资格。 |
| `lib/fetch-scheduler.js` | Node 库：按主机串行调度抓取，记录冷却时间并识别失败类型。 |
| `lib/filter-input-contract.js` | Node 库：算出筛选决定对应的输入 SHA；使用官方范围证据时，一并绑定实际交给模型的证据。 |
| `lib/filter-scope-evidence.js` | Node 库：为仅命中泛多模态词、且未明确声音模态的候选获取同篇官方 TXT、PDF、来源元数据和清单；读取时核验文件，并保存模型所用原文及其 SHA。它不直接判定论文相关。 |
| `lib/fresh-analysis-context.js` | Node 库：隔离全新重写运行的来源文件与深度分析上下文，重新核验来源 SHA；拒绝旧生成正文和其他运行的检查点。 |
| `lib/fresh-arxiv-rewrite-source.js` | Node 库：每轮 arXiv 来源获取时，用原子写入保存官方文本、PDF、不含像素的来源元数据和清单。只有当前稿 PDF 明确返回 404，才允许改用同一论文的官方 `vN` PDF；文本必须从该 PDF 提取，并按条件生成可自校验的 `sourceVersion`。普通来源文件仍按原结构读取。 |
| `lib/fresh-rewrite-publication.js` | Node 库：重写前备份当前正式分析结果和博客基线；新结果完整，且来源及基线内容仍与原记录一致后，才替换正式分析结果。 |
| `lib/fresh-rewrite-run.js` | Node 库：从白名单中的原始元数据创建独立重写运行，准备同源文件，只恢复本运行的分析，并在完整结果验证通过后更新正式数据。 |
| `lib/historical-archive-crawl-authority.js` | Node 库：用已有归档抓取记录的稳定 arXiv ID 和输入 SHA 提供身份依据，不提供正文、图片或旧分析。 |
| `lib/historical-archive-crawl-batch.js` | Node 库：只读审查已有归档抓取记录。旧 crosswalk 写入功能已停用，调用时直接拒绝。 |
| `lib/historical-arxiv-batch.js` | Node 库：备用路线只读取命名、不可变的新 arXiv 获取失败交接文件。核验其中的历史清单、页面 SHA 和非标题链接后，仅对其列出的页面，在确认处理状态仍与决定中的原状态一致后保存处理决定；不扫描 pending hint。 |
| `lib/historical-arxiv-publication-metadata.js` | Node 库：为历史直接重写计划的每篇 arXiv 论文封存仅用于发布的 Atom 附件。读取时核验原始 Atom、元数据、摘要 SHA、精确 `vN` 查询或无版本 ID 的观察时间窗，以及原来源获取序号、清单与快照；不修改四份原来源文件。 |
| `lib/historical-conference-crawl-authority.js` | Node 库：用已有会议元数据和 PDF 的稳定会议 ID 提供身份依据，支持重新核验 ICASSP、ICLR 本地来源。 |
| `lib/historical-conference-crawl-batch.js` | Node 库：保留旧版只读辅助功能，页面与来源对应表的写入功能已停用。会议标题指纹只能用于直接重写的页面对应，不能写进页面与来源对应表。 |
| `lib/historical-conference-local-sources.js` | Node 库：生成 `historical-conference-local-sources-v2`。除既有会议元数据和 PDF 外，还按认证 ICML poster→OpenReview forum ID 合并 ICML 来源；只读已有目录及运行目录中的新文件，新 PDF 必须对应唯一 OpenReview/替代来源凭证。逐项记录元数据、论文记录、PDF 获取与来源 SHA；缺 PDF 时明确标为 unavailable。 |
| `lib/historical-conference-page-projections.js` | Node 库：读取历史清单、页面标题和已保留的会议来源，核对文件 SHA 后确定论文对应哪些页面。页面文件参与校验，旧正文不作为重写输入。 |
| `lib/historical-daily-primary-arxiv-binding.js` | Node 库：核验冻结 Daily 页的 SHA，仅接受唯一合法评分元数据行中的规范 `[arxiv]` 主身份；保存对应字节区间和行哈希，拒绝把正文引用链接当成论文主身份。 |
| `lib/historical-direct-aggregate.js` | Node 库：根据直接重写记录和页面对应记录重建日汇总、会议汇总及会议任务私有页面，不读取旧正文。页面对应记录 v3 用冻结链接确定任务成员，无论文汇总记录为 `retain-unchanged`，并核验全部历史页面覆盖。`reader-facing-v3` 只按主任务统计热门方向，保留双语链接标题、八维评分、分档、文档类型、arXiv、作者机构与资源状态；采用旧 arXiv `vN` 时，排行榜与条目均显示当前稿不可用和实际官方链接。 |
| `lib/historical-direct-control.js` | Node 库：按计划和来源获取序号管理不可变暂停请求、安全恢复及来源检查点，并只读汇总任务登记记录、汇总结果和发布阻断项；不调用模型或修改博客。 |
| `lib/historical-direct-page-staging.js` | Node 库：用直接重写所保存的来源、分析和解读正文生成历史单篇私有页面，并核对输入、清单及页面 SHA。采用标题不同的早期预印本时，页首说明它不是会议定稿（camera-ready）；当前稿 PDF 返回 404 而采用同篇旧 `vN` 时，页首说明“当前稿不可用”。 |
| `lib/historical-direct-publication.js` | Node 库：核验直接重写的全部私有页面、汇总对应记录 v3、汇总文件 v2 和显式视觉处置，执行可恢复的历史发布。固定博客基线；按路径与内容 SHA 复用逐页通过记录，重跑本批程序检查和 Hugo 构建，并生成凭证，再处理激活回滚、Git 提交与远端 OID。 |
| `lib/historical-direct-rewrite-input-catalog.js` | Node 库：结合历史清单中的唯一 arXiv 提示、严格主评分行身份、ICML poster 与符合本地 PDF 使用规则的论文身份、会议本地来源清单，生成 `merged-good-historical-local-data-v5`。身份记录仅保存字节区间和哈希，不把旧正文送入写作。 |
| `lib/historical-direct-rewrite-plan.js` | Node 库：从严格的当前来源目录、历史清单和会议页面对应记录生成可重新核验的来源处理计划，并以自身 SHA 记录未覆盖论文页及按范围、身份提示状态统计的结果。唯一白名单跨标题预印本须有可自校验的来源披露；普通 v5 来源处理方式保持旧字节结构以恢复长任务。不调用模型、网络或页面与来源对应表模块；旧页面只用于冻结身份重核，不进入分析和写作输入。 |
| `lib/historical-direct-rewrite-runner.js` | Node 库：执行直接重写计划前核验同计划、同来源获取序号的 scheduler-ready 记录与来源字节，保存来源对应的分析恢复检查点以便跨进程续跑；只有原文分析和 Reader 都完整时才生成私有页面。 |
| `lib/historical-direct-tag-supplement.js` | Node 库：只读核验已完成直接重写的来源、分析与私有页面，按原分类版本提取概念及主角色。补充记录对应历史页面整文件与正文 SHA，保留旧正文和标签，单列失败，不把未完成分析当成已核验结果。 |
| `lib/historical-icml-alternate-pdf-source.js` | Node 库：OpenReview 被挑战页阻断时，只为代码白名单中的 poster/forum 使用固定替代 PDF，并核验快照标题和作者顺序。`n1mAjfRDZ6` 还可导入浏览器下载的 SSRN PDF，重新检查标题、作者、日期和跨页特征文本，对应固定 DOI，并用非网络获取凭证明示来源；不能当成 OpenReview 或 camera-ready 字节。 |
| `lib/historical-icml-poster-authority.js` | Node 库：认证 ICML 2026 原始 poster→OpenReview forum 快照，核验 Daily 子条目与汇总小节的身份及 forum-ID 本地 PDF；旧页面正文不进入写作。 |
| `lib/historical-local-crawl-authority.js` | Node 库：汇总归档与当前本地抓取记录中的稳定 arXiv 身份；不联网，不读取正文。 |
| `lib/historical-openreview-pdf-source.js` | Node 库：根据认证 ICML poster 记录固定 OpenReview forum 身份，经项目 HTTP CONNECT、手动受限重定向和流式字节上限获取缺失 PDF。以不可覆盖的原子写入和 `0600` 权限保存 forum-ID PDF、可自校验凭证；显式续跑先核授权与完整字节，再恢复已退出写者的已知临时硬链接。孤立 PDF 仍须联网重取并逐字比对，旧半文件和未知外链保留报错。 |
| `lib/historical-source-identity-supplement.js` | Node 库：核对封存的 arXiv 或会议来源是否对应论文，并核验原页面 SHA。新记录使用 v2 和 tagStatus；完整旧输出经原摘要和字节核验后可复用。身份记录不能证明分类或正文已经完成。 |
| `lib/historical-source-tag-assignment.js` | Node 库：对尚无有效正式分类的历史页，用编号原文片段选择标签，程序填入逐字引文后再独立审核。模型请求使用公共路由；记录明确区分词表未覆盖、待审和账号耗尽后未处理的论文。 |
| `lib/historical-tag-checkpoint-export.js` | Node 库：读取并核验分类检查点或部分运行记录、来源、原文引文及独立审核，按排除集合导出页面分类记录。支持原连续处理范围与并发已处理集合；采用集合格式时只读取决策对应文件名的缓存。 |
| `lib/history-conflict-identity.js` | Node 库：保留旧版冲突解析功能；当前直接重写策略不把状态为 `conflict/multiple` 的页面送入正式 crosswalk。 |
| `lib/immutable-file.js` | Node 库：先写临时文件并同步，再用硬链接保存正式文件，不覆盖已有内容；只回收同机已退出写者留下、且与正式文件指向同一文件的临时硬链接，拒绝清理其他文件。 |
| `lib/keyword-prefilter.js` | Node 库：音频关键词预筛，追求高召回，按版本管理。 |
| `lib/legacy-history-run.js` | 只读核验旧历史来源与分析 SHA，定位既存运行；不创建来源或调度任务。 |
| `lib/legacy-manual-source.js` | 只读核验旧 Manual 官方来源的日期、版本、路径和 SHA。 |
| `lib/llm-pending-request.js` | 模型请求发起前的持久记录，防止中断后退还已预留预算。 |
| `lib/llm-usage.js` | Node 库：规范化真实请求用量，按论文和阶段归因；服务没有提供计费用量时，就记为不可得。 |
| `lib/merge-failed-reader-bundle.js` | 失败保存时保持读者文章与对应阶段一致，保留真实失败稿、请求及费用历史，避免旧正文混用新记录。 |
| `lib/model-text-sanitization.js` | Node 库：记录保留合法 Unicode 字符的请求清洗版本；生产恢复、提升和暂存核验当前来源，旧受影响输入须重分析，缺少受控来源不能推定可复用。旧成功结构和已发布只读状态不改。 |
| `lib/official-conference-acquisition.js` | Node 库：按固定 2026 官方 index/record/PDF 白名单抓取会议元数据与 PDF，`PROVIDERS` 是来源清单的唯一依据。AAAI volume 40 用固定 48-issue 清单，核验逐 issue 响应凭证、SHA 和跨 issue article ID 唯一性；其他来源用单索引。索引和逐篇下载以 `0600`、`O_EXCL` 保存，恢复时完整核验。 |
| `lib/page-source-crosswalk.js` | Node 库：跨运行核验历史页面清单，在锁内核对处理状态的 SHA 与决定中的原状态 SHA 一致，再更新状态并追加决定记录，保存 pageId、页面 SHA 与发布授权来源。按论文身份将多页归为一组，并固定页面与论文的排序；标题不能用来判定 verified。finalize 和每次读取最终凭证时都重新验证来源。 |
| `lib/page-tag-metadata.js` | Node 库：解析页面的 YAML 页首字段，识别新旧标签字段，拒绝混用与重复键；只认实际存在的顶层字段，描述或正文里的文字不算标签声明。 |
| `lib/paid-final-analysis-recovery.js` | 按当前来源和阶段身份恢复已有付费最终分析。 |
| `lib/paper-identity.js` | Node 库：实现 Node `paper-identity-v1` 身份规范化、官方来源 URL 检查和稳定 SHA；不替换既有 arXiv 辅助函数。 |
| `lib/paper-page-staging.js` | 三流程页面 worker 私有输入、超时、实现指纹和暂存文件校验。 |
| `lib/paper-source-authority.js` | Node 库：核验规范论文身份、完整身份记录、来源快照、凭证和全文 SHA，返回只含来源、且只能由实际核验过程生成的引用对象。普通磁盘 arXiv 加载器不能恢复发布授权；会议路径还要求当前进程持有实际核验生成的计划引用对象。 |
| `lib/pdf-layout.js` | 调用 PDF 布局 worker，取得单元格和图表证据。 |
| `lib/primary-fact-local-repair.js` | Node 库：为来源绑定的主文事实纠错限定唯一原段落，严格核验 JSON 的 from/to、原稿 SHA 和修改范围；未授权正文逐字保留，完整正文与评分检查仍由正常分析入口执行。 |
| `lib/prompt-history.js` | Node 库：按原记录整文件或首围栏模板 SHA 读取、核验 Git 历史原字节；查不到返回 `null`，不把当前正文伪装成旧版本。 |
| `lib/prompt-evidence.js` | Node 库：受控读取当前 Prompt 或索引声明的 Git blob，严格核验原路径、OID、整文件 SHA 与可选声明 SHA；不写旧正文。 |
| `lib/git-prompt-evidence-index.json` | 只读元数据：仅保存历史 Prompt 的原路径、Git blob OID 与整文件 SHA，没有旧正文。 |
| `lib/prompt-rendering-contract.js` | Node 库：识别旧提示词替换可能改写的输入，仅使受影响论文的旧阶段失效；正常输入继续沿用原指纹和恢复记录。 |
| `lib/prompt-text-versions.js` | Node 库：登记每个分析阶段当前使用的提示词正文路径和版本标识。导出当前 18 份正文名单；旧记录按自己声明的版本选择原路径，通过 Git 证据读取器重新核验，未声明版本时按 v1 身份读取，未知版本直接报错。 |
| `lib/publication-file-primitives.js` | 三流程共用的严格文件、JSON、不可变写入与回读 SHA 守卫。 |
| `lib/reader-author-parser.js` | Node 库：从原始材料重新解析并核验作者：校验完整原 HTML、结构化解析结果及全文 SHA，或从会议 PDF 文本重新解析作者上标；原文不可得时只使用元数据姓名和明确不可得机构。不会加载配置或请求模型。 |
| `lib/reader-author-replay-cli.js` | Node 子进程入口：供 Python 发布器调用的本地作者核验入口；只读取调用方传入的私有文件，限制输入字节并只输出布尔核验结果。 |
| `lib/reader-author-source.js` | Node 库：当前生产 Reader 作者复用资格；跳过已完成分析、恢复历史/会议任务及发布前，必须从已核验的原始材料重新解析并核验作者，保留旧成功结构与只读统计。 |
| `lib/reader-candidate-transactions.js` | Node 库：在内存中跟踪分析结果对应的待保存文章，复制结果时同步这层对应关系；不加载分析器、不读写文件、不改变日志。文章实际保存后的检查和恢复稿停用仍由分析器负责。 |
| `lib/reader-compatible-candidate-replay.js` | Node 库：在统一恢复中用真实迁移链或最后付费请求、响应及生产逐字回放收敛同输入候选；不按文件时间选稿，不改次数和费用，无法证明仍拒绝。 |
| `lib/reader-contract.js` | Node 库：规定读者文章的格式要求，按本次证据向模型说明写作要求，并检查不同小节的内容是否近似重复。 |
| `lib/reader-dom-span-projection.js` | Node 库：从真正封存 HTML 重放全幅 colspan 分类行的空白投影，让正常完整表编译与最终逐格守卫一致；保持来源、旧展示字节及 PDF 规则不变。 |
| `lib/reader-dom-span-replay-cli.js` | Node 只读子进程：Python 发布检查通过私有受限文件描述符批量重放 HTML 全幅分类行空白投影；先核日更工作区、四份封存来源、保存表格 SHA 与实际正文坐标，再共用原 DOM 规则，不请求模型或网络。 |
| `lib/reader-draft-order.js` | Node 库：调整同一草稿的小节顺序，同步表格绑定和标记，保存原始路径与调整后路径的 SHA 对应关系；无法唯一确定顺序时拒绝调整。 |
| `lib/reader-failed-bundle-resource-replay.js` | Node 库：普通源模式恢复在内存读取当前上游证明指向的同源失败资源束，逐字核验原文、归属和状态；不混签旧公开 Reader，不请求模型或增额度。 |
| `lib/reader-historical-draft-normalizer-replay.js` | 核真实请求绑定的 Git 程序、完整依赖 blob 与纯闭包证明，逐字回放旧失败稿付费来源；v2 显式记录闭包，旧 v1 原字节只读核验，不恢复发布资格或增加预算。 |
| `lib/reader-historical-markdown-closure.js` | 从原 Git analysis-contract blob 精确提取固定 SHA 的 6 个表头正则和 7 个纯函数，在无 require 的隔离上下文中装载；保留逐声明字节边界与哈希，不导入旧 Manual/生产依赖。 |
| `lib/reader-inline-svg.js` | Node 库：核对官方内嵌 SVG 的原始字节和来源定位，调用受控渲染器生成本次阅读所需图片。 |
| `lib/reader-operator-patch.js` | Node 库：显式应用同一全新重写运行的人工局部补丁，核验来源、每个修改字段或数组项的原内容 SHA，以及完整 Reader 解析结果。只保存失败候选，保留预算、原始字节归档和重复执行记录，不生成任何成功正文凭证。 |
| `lib/reader-paid-resolved-render.js` | Node 库：通过正常论文锁校验原付费响应与当前文章的对应关系，重算排版，保留原费用、图片与其他阶段；保存前再次核对原档和旧代码。 |
| `lib/reader-paid-resolved-replay-worker.js` | Node 内部子进程：在无生产密钥且禁止网络的独立进程中运行固定旧渲染器，验证原响应能逐字恢复当前文章及计划；不直接接受发布任务。 |
| `lib/reader-paid-response-replay.js` | Node 库：显式复验被旧程序变换损坏的付费原响应：正式用量记录须绑定原输出 SHA，真实后续修复请求及响应须精确关联原候选；保留原次数和失败记录，经正常完整解析与来源、事实反馈校验后才可保存。缺少这些证明时拒绝，不能作为通用原响应导入入口。 |
| `lib/reader-parent-recovery.js` | Node 库：为已付费失败稿规划有累计上限的后续修复，核对每轮原稿、费用和父回执；公开诊断准备只允许实现变化，保留旧账，不自动添加请求额度。 |
| `lib/reader-parent-upstream-preflight.js` | Node 库：在真实日更论文锁、封存来源及原上游反馈作用域中，对副本复核正常主分析、资源扫描和七个文本阶段的指纹；失效时交回父阶段恢复，不改论文、成功状态或请求额度。 |
| `lib/reader-pdf-cell-evidence.js` | Reader PDF 表格单元格的来源绑定与跨 worker 证据核验。 |
| `lib/reader-pre-image-check.js` | Node 库：下载图片前，只读判断已用完修复次数且当前纯文本或原表检查仍失败的草稿；有新授权、剩余次数或已被当前检查接受时继续正常下载和完整验收，不复用旧像素证明。 |
| `lib/reader-proof-read-scope.js` | Node 库：在一次恢复准备期间复用未变化的证明文件读取；每次核对文件状态，结束即清空，完整恢复链仍重新核验。 |
| `lib/reader-recovery-revision.js` | Node 库：显式迁移同源失败候选的诊断，保留付费请求计数、索引调整与旧无进展状态，归档原字节；表数量文案不能触发正文规范化。迁移不会产出成功凭证。 |
| `lib/reader-repair.js` | Node 库：保存未通过检查的文章草稿，核对允许修改字段的 SHA，并应用经校验的局部修改。表格数量预估仅供参考；合法原表行列示例只进入对应错误的修复反馈，不改来源证据与候选输入身份。补表时仍核验原表选择或完整逐字引文，最终文章须通过完整解析检查。严格只有 kind/heading/body 的超节稿可用同 kind 连续索引分组计划，由程序保留全部原标题、正文与来源绑定；唯一已知续文字段可用v2原字段引用计划，全部原段及空串逐项保留；未知字段继续完整重排。各请求共用原有尝试额度。 |
| `lib/reader-request-diagnostics.js` | Node 库：在 Reader 修复付费请求前保存当前草稿、准确 SHA、允许修改的内容与提示词，响应后保留原文和请求关联 SHA；逐次记录不可覆写，写入失败停止，不授予正文或发布资格。 |
| `lib/reader-resource-binding.js` | Node 库：提取并规范化论文中的 GitHub、GitLab、Hugging Face 和 ModelScope 链接，保留原始 URL、逐字原文片段及资源类型，使换行 URL 也能准确核验来源。 |
| `lib/reader-resource-claims-replay-cli.js` | 出版前从私有描述符重放资源宣称与封存全文绑定；禁止网络。 |
| `lib/reader-resource-input-admission.js` | Node 库：真实资源状态变化须逐字重放原请求、已付响应、费用与失败稿，并核完整父阶段和封存来源；同来源 Reader 范围仅一次新输入，固定正常 6/2 预算，旧稿与旧计数不迁移。仅元数据变化拒绝再开。 |
| `lib/reader-resource-prose.js` | 把已核验资源身份投影为自然语言输入，保留作者与第三方归属。 |
| `lib/reader-resource-sync.js` | Node 库：将封存资源状态同步到分析结果、解析结果和末端检查点及证明，保留评分和 Reader 字节。如果评分依赖的可用性证据变了，就拒绝同步，并要求走正常评分审计；不联网、不写文件。 |
| `lib/reader-saved-feedback-input-continuity.js` | Node 库：同一原父子事实包的显示合并变化时，重建真实原付费输入；保留当前全部事实约束、原稿、费用和次数，不授予新额度。 |
| `lib/reader-sealed-pdf-column-units.js` | Reader 封存 PDF 表格列单位的精确绑定与重放。 |
| `lib/reader-source-table-column-units.js` | 在已核验的日更封存作用域中，以唯一单层原 DOM 表、行名及同列单元格核对百分比列单位；不改数字或来源。 |
| `lib/reader-sealed-pdf-quote-evidence.js` | Reader 封存 PDF 逐字引文证据的绑定与重放。 |
| `lib/reader-sealed-pdf-table-evidence.js` | Reader 封存 PDF 原表结构与单元格证据的绑定与重放。 |
| `lib/reader-signed-draft.js` | Node 库：把本次同源、已核验的 Reader 还原成与输入完全等价的版本。只有实际解析并恢复原图引用后，正文、计划、图片 SHA 全部相同才返回；不写文件、不调用模型，也不把恢复稿当作原始 API JSON。 |
| `lib/reader-signed-operator.js` | Node 库：显式修订同一运行的已核验 Reader，先核对完整父稿、正文、计划及来源 SHA 与修改请求一致，再还原、解析并按共同流程封存结果；恢复输出时核对先前保存且不再改动的准备记录，其中包含修改请求、父稿、运行、来源和预期输出的 SHA。只写隔离分析并要求事实复核，不调用 API。 |
| `lib/reader-source-blocked-normalization.js` | Node 库：对封存来源导致的完整表阻塞重跑唯一顺序调整，核对原稿与准备稿双 SHA，并保留真实绑定与承载正文的失败诊断；付费回放必须先逐字对应保存的原稿，不授予成功资格或新额度。 |
| `lib/reader-source-diagnostics.js` | Node 库：把数字或单位来源不匹配的问题定位到正文单元格与原表行列，给出百分号、千分位及可能舍入的修复建议，但只读；不会自动改数字，也不会放宽来源检查。 |
| `lib/reader-source-display.js` | Node 库：共用原表单元格的显示规范化；仅合并明确 TeX 注解与一致可见副本，裸数字重复保持原样，供 Reader 与发布资格检查复用。 |
| `lib/reader-source-metric-units.js` | Node 库：对原文明确由编辑距离定义、原表未标百分号的事件指标，只接受同一原列逐字保存的比较值；不转换百分比、不改数字，也不豁免其他指标。 |
| `lib/reader-table-narrative-labels.js` | Reader 表格说明文字与原表标签的来源对应检查。 |
| `lib/reader-table-pdf-evidence.js` | Node 库：隔离旧 PDF 规则与新的独立 PDF 来源证明；正常 Reader 编译和冷态保存记录核验均重读受控来源，保留原 DOM 与 PDF 显示值的不同来源。 |
| `lib/reader-tables.js` | Node 库：将 TABLE 标记与原表行列选择展开为 Markdown 和逐格来源记录，保留表头对应关系，拒绝错位和越界。 |
| `lib/reanalysis-helpers.js` | Node 库：供指定论文重分析使用，清理 Reader 状态并更新恢复统计。 |
| `lib/saved-fact-feedback.js` | Node 库：deep 与 batch 共用 `withRecoveredFeedback()` 从本次运行档案读取原纠错说明，显式新反馈优先，核对各阶段证明；整篇和摘要采用不同说明时分别恢复，保留原稿和费用，拒绝改包或扩大摘要修改范围。 |
| `lib/scoring-third-party-resource-replay.js` | Node 库：精确回放原评分输入，仅第三方依赖可达状态抖动时保留原付费评分与审计时正文；作者资源变化仍正常重审。 |
| `lib/selected-full-stage-reanalysis.js` | Node 库：将明确选定论文从当前封存全文完整重生成，锁内归档旧阶段、费用与事实反馈；同轮续跑保留新费用，普通恢复不启用。 |
| `lib/signed-reader-recovery-draft.js` | Node 库：将已核验签名长文恢复为可局部修改的文章数据，保留章节、术语及图表公式对应关系；不接受来源不明的正文。 |
| `lib/source-classification-failures.js` | Node 库：只根据公共请求层的结构化错误识别账号或服务故障，并停止新请求。正文校验失败和输出截断仍按单篇处理，不根据错误文案猜故障或切账号。 |
| `lib/source-classification-scheduler.js` | Node 库：以 1–3 个并行任务处理来源分类。账号级失败或停止请求发生后不再派发新模型请求，保留已返回响应，按所选论文顺序合并并记录未完成项。 |
| `lib/source-evidence-snippets.js` | Node 库：`buildSourceEvidenceSnippets` 按字符预算提取并编号连续原文片段；`fillConceptQuotesFromSnippets` 按模型选择的编号填入原文引文。保留原始空白及 UTF16 位置，拒绝未知编号。 |
| `lib/tag-catalog-change.js` | Node 库：比较两份词表，给出 `none/additive/destructive` 分类和理由；按 SHA 读取旧快照，核验 `registryUpgradeFrom`。沿用与确认条件见本页的分类词表维护说明。 |
| `lib/tag-catalog.js` | Node 库：`loadTagCatalog` 加载共享标签词表，`validateTagCatalog` 检查字段与层级；另外可按别名解析，也能查上下级。Node/Python 解析器和发布检查都用词表原始字节计算 SHA。 |
| `lib/tag-record-update.js` | Node 库：更新或核验分析中的标签阶段记录，所选概念 ID 必须仍与原记录一致；无法核验时拒绝并说明原因。另外可只读盘点旧分类文件，不调用模型。 |
| `lib/tag-rules.js` | Node 库：`createTagRules` 创建标签解析与选择规则，`getDefaultTagRules` 复用默认规则，`buildTagPromptText` 默认生成新版模型标签提示，指定旧版本时，也能生成核验文本。默认选择协议为 `paper-tag-selection-v2`，旧阶段按保存的版本读取，详见本页的分类词表维护说明。 |
| `lib/tag-stage-record.js` | Node 库：只读识别新旧标签阶段格式，返回原阶段及实际字段名；两种格式混用时拒绝，也不会改写或补签旧记录。 |
| `lib/workflow-implementation-files.js` | 静态收集实际可执行传递依赖，供当前实现指纹核验。 |
| `llm-account-pool.js` | 管理 Node OpenCode Go 账号池，持续使用成功账号，识别额度错误，并保存跨进程账号状态。 |
| `llm-usage-report.js` | 只读汇总真实请求用量；`--paper` 支持新旧 arXiv ID 和完整会议论文 ID。区分服务提供的 usage、不可得状态和字符估算，不推算未经证实的费用；旧记录缺失的论文身份不能自动补回。 |
| `llm_account_pool.py` | 按与 Node 相同的数据格式和锁协议管理 OpenCode Go 账号池。 |
| `llm_usage.py` | 记录 Python 发布请求的用量与失败事件，沿用跨运行请求归因格式。 |
| `log-setup.js` | 记录 Node 终端和文件日志，加时间戳，并对敏感信息脱敏。 |
| `log_setup.py` | 统一 Python 日志并脱敏。 |
| `manual_agent_policy.py` | Python 共享：按可信外层规则核对 Manual 新旧模型身份；当前声明要求 Sol/high 与对应版本，旧记录保留原身份，新声明不能借旧模型规则绕过检查。只验证记录字段，不证明远端模型实际执行。 |
| `markdown_hugo_gate.py` | Python 共享：检查 Markdown、页面元数据、公式和图片，并运行 Hugo 渲染检查。 |
| `migrate-conference-process.js` | CLI：显式更新会议处理实现指纹，重新核验完成页面，归档旧完成凭证，再继续未完成论文。保留原 UUID、记录格式、词表创建值及已有尝试，完成论文不重新请求模型。 |
| `official-conference-acquire.js` | 在日更工作区按集中配置执行 `catalog/download/status/verify`，固定来源身份、项目 CONNECT 代理和官方地址白名单，不接受任意输出目录。`download` 可显式配置 1–5 路并发和 0–5 次同 URL 瞬时网络重试。 |
| `page-source-crosswalk.js` | 从直接命名的历史清单与凭证创建独立 crosswalk，管理受控决定和 CAS。普通磁盘 arXiv 来源文件不能获得发布授权；finalize 要求全体 verified，且来源可在现场重新核验。 |
| `paper_identity.py` | 实现与 Node 相同的 `paper-identity-v1`，用共享测试向量核对身份与 SHA 结果。 |
| `paper_reader_presentation.py` | 共用作者、资源、评分展示，要求原计划与保存身份完全对应。 |
| `parse-arxiv-atom.py` | Python 解析入口：经 `python-runtime.sh` 读取有字节上限的标准输入，严格校验 Atom XML、官方论文 ID、标题与摘要，再输出有字节上限的 JSON；拒绝文档类型与实体声明。 |
| `path_config.py` | 定义 Python 共享路径、日期与原子写入配置。 |
| `pdf-layout-extract.py` | 从受控 PDF 提取布局、文本位置和单元格证据。 |
| `plan-post-publish-visuals.py` | Python 入口：博客远端发布核验通过后调用共用视觉规划接口。 |
| `project_env.py` | 加载 Python 项目环境、最小子进程环境和代理设置。 |
| `publication_activation.py` | Python 入口/共享库：核验旧提交、博客基线和实时远端，归档六个精确状态文件。pending 状态阻断发布三阶段，支持中断恢复，不修改已提升的论文分析。 |
| `publish-conference.py` | CLI：按会议处理凭证执行 generate/review/push/status/verify。generate 只安装文件；push 核验实际 Git index 和 commit blob，先发布图床再发布博客；verify 检查线上 URL。以上都是机械检查，语义审查和浏览器里的视觉效果仍要人工确认。 |
| `publish-to-blog.py` | Python 核心：实现三个发布阶段共用的页面模板、标签兼容映射、Git 事务、批次凭证及发布证明。`researcher-workbench-v1` 规定页面元数据、引用和论文再思考附属资料；逐页审查永久按“相对路径 + 内容 SHA”复用。发布器代码变化会重新渲染页面，但最终字节未变的页面不重新审查。 |
| `publish_common.py` | Python 共享：提供发布数据、评分、Manual/API 来源核验及 LLM 审查的共用规则。 |
| `push-blog.py` | Python 入口：核验 receipt，提交并推送其允许的改动，确认远端 OID 后规划视觉任务。 |
| `reader_inline_svg.py` | Python 共享：校验内嵌 SVG 的元素、属性和本地引用，在禁用脚本与网络的浏览器中渲染 PNG，供阅读和发布共用。 |
| `reader_inline_svg_pixel_replay.py` | Python 库：先执行当前 SVG 安全检查，只从当前 HEAD 的可信 Git 历史重放渲染器；生成图片必须与原模型像素 SHA 完全相同，才供正常发布器暂存。 |
| `reader_pdf_cell_evidence.py` | 按受控 PDF 提取和核验表格单元格证据。 |
| `reader_pdf_visual_audit_cache.py` | Python 库：有界缓存旧 PDF 后端成功的纯视觉抽取；每次核对真实 PDF 和完整实现字节，返回独立副本；四份封存来源、当前绑定与逐格数字资格仍由原核验器每次重放。 |
| `reader_sealed_pdf_column_units.py` | 核验受控 PDF 原表列单位证据，供 Node 和发布器重放。 |
| `reader_sealed_pdf_quote_evidence.py` | 核验受控 PDF 精确引文，供 Node 和发布器重放。 |
| `reader_sealed_pdf_table_evidence.py` | 核验受控 PDF 原表结构与单元格，供 Node 和发布器重放。 |
| `reanalyze-selected.js` | 只重分析指定 arXiv ID，并同步恢复统计。 |
| `reanalyze.js` | 归档并停用全部旧失败 Reader 候选，清空 Reader 和图片补充状态后强制全量重分析。仍只读取正式分析结果精确绑定的日更 PDF/TXT，不恢复旧分析、正文或缓存。 |
| `recover-conference-process-locks.js` | CLI：只在操作者确认本工作区、且锁的持有进程 PID 已经退出时，按文件锁协议恢复旧操作锁；活锁和不完整的锁一律跳过。 |
| `refresh-api-reader.js` | 刷新指定论文或日期批次的 Reader、评分、作者和图片阶段。未指定并发时使用 `ANALYSIS_CONFIG.apiReaderConcurrency`（默认5），`--concurrency N` 可覆写为1–60；总轮数使用 `batchMaxRounds`（默认3），`--rounds N` 可覆写为1–10。先全批再仅续明确可重试失败，诊断保存到 `analysis-batch-reports`；只读取封存 PDF/TXT，图片只为本次调用在系统临时目录中准备。 |
| `review-blog.py` | Python 入口：审查本批最终页面，执行程序检查、模型正文审查、图片审查和 Hugo 构建，通过后生成 receipt。 |
| `runtime-storage.js` | 只读统计运行存储，按文件引用关系预览受控缓存或日志清理；只有显式 `--apply` 才清理。 |
| `runtime_guard.py` | 拒绝在沙箱内运行 Python 项目入口。 |
| `tag-check-inventory.js` | 只读盘点会议、日更及历史分类记录，按词表 SHA 汇总状态、数量和示例论文，列出与当前词表的差异。扫描字段、路径和测试参数见本页的分类词表维护说明。 |
| `tag-record-update.js` | 仅重新生成分类记录，不重跑 Reader、评分或 LLM。默认预览，写入前核验 SHA 与原分类身份；参数、确认白名单及快照步骤见本页的分类词表维护说明。 |
| `tag-tools.js` | 校验分类词表，并在回环地址提供静态预览服务，只开四个只读路由；不提供本机助手，也不做正式数据迁移。 |
| `tag_catalog.py` | 与 Node 共用分类词表，显式解析当前格式或旧格式标签并精确映射概念。新正式页面只接受有效的中文首选标签及 既定英文专名例外；未知或歧义标签报错，不自行缩小含义。 |
| `tag_paths.py` | 集中定义标签词表及私有预览路径，按显式参数、环境变量和默认目录依次选择博客路径；目录存在与仓库身份由调用方另行检查。 |
| `tag_stage_record.py` | 只读识别标签阶段的新旧保存格式，返回原阶段、检查点及实际字段名；格式可读不等于哈希和发布资格已经通过。 |
| `test-api-key.js` | 测试主模型或副模型的协议路由、代理和响应。 |
| `utils.js` | 提供 Node 原子文件写入、时间、ID、分析解析、提示词、LLM 协议和代理工具；`readTagValidation` 读取新旧解析结果中的标签检查对象，拒绝混用字段。 |
| `utils.py` | Python 分析与评分解析、发布侧通用文本工具；`read_tag_validation` 读取新旧解析结果中的标签检查对象，拒绝混用字段。 |
| `validate-data-files.js` | 只读核验当前数据、跨文件论文集合、评分及兼容结果的来源记录。 |
| `verify-project.js` | 沙箱外完整离线验证：固定 Hugo、全仓语法、默认/Manual JS 与 Python、只读数据检查；`--quick` 仅语法与数据，不是完整验收。 |
| `visual-summary-integration.js` | Node 共享：在同一发布证明下协调论文长图与汇总封面。 |
| `visual-summary-state.js` | Node 入口/状态机：规划、校验、登记和归档 TOP 10 论文长图。当前 v3 只使用已核验 Reader 的 thesis 与完整章节；日更核对官方论文图身份后返回空引用路径，不取旧缓存。QA 记录对应章节的 SHA，不回退到正式分析摘要。 |
| `waive-analysis-failures.js` | CLI：记录用户明确同意跳过的当前日更分析失败项，保存对应现有文件的豁免记录；不覆盖失败尝试。 |
| `waive-post-publish-visuals.js` | Node 入口：用户明确取消生图时，记录与当前发布绑定的视觉豁免。 |
| `workspace-role.js` | 入口与共享运行检查：用不跟踪入 Git、权限为 `0600` 且绑定仓库真实路径的标记区分 `daily` 与 `history`。`set` 原子保存或显式切换角色，`exec` 在 npm 生产入口启动前检查角色；直接 Node/Python 入口再由公共运行检查核验。`PD_WORKSPACE_ALLOW_CROSS_ROLE=1` 只放行 daily 工作区执行 history 命令（读进程环境或工作区 `.env`，放行时打印提示）；反向和 realpath 不符照旧拒绝。 |

| `prompt_evidence.py` | Python旧凭证严格读取本地Git原始Prompt物件，当前模板必须来自工作树。 |
