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
| `lib/daily-fresh-source-plan.js` | Node 库 | 日更筛选结束后为每个 arXiv 论文封存本次官方 TXT/PDF/manifest；分析只重放 sealed bundle，图像只在请求期间临时物化。 |
| `lib/fresh-arxiv-rewrite-source.js` | Node 库 | 为 fresh arXiv generation 原子封存官方文本、PDF、无像素 runtime metadata 和 manifest；仅在 current PDF 明确 404 后接受同 canonical 官方 `vN` PDF，强制由该 PDF 提取文本并条件性签发自哈希 `sourceVersion`；普通 bundle 保持原结构兼容。 |
| `lib/direct-rewrite-analysis-context.js` | Node 库 | 将 direct historical 与日更 source bundle 放入隔离 AsyncLocalStorage，阻止旧正文/缓存进入分析，并约束 Reader 临时图像不跨持久化边界；历史版本 identity SHA 随 source provenance 进入所有分析阶段。 |
| `fetch-papers.js` | Node 模块/入口 | arXiv 抓取、摘要补全、关键词预筛和逐篇 LLM 筛选。 |
| `fetch-huggingface-papers.js` | Node 模块/入口 | 通过最小环境中的 `curl` 抓取 HuggingFace Papers。 |
| `deep-analyzer.js` | Node 核心 | 单篇全文获取、多阶段分析、评分审计、API reader 长文和图片计划；结构修复后以 source-only 证据封口 `core-summary-detailed-v3`，并用显式阶段 DAG、SHA 投影和 stale snapshot 减少安全恢复时的整篇返工。 |
| `analysis-engine.js` | Node 共享 | 论文锁、重试、checkpoint、批量并发、canonical 合并与终态判断。 |
| `analysis-contract.js` | Node 共享 | API 分析结构、评分、方法/表格门禁及历史 Manual 兼容校验。 |
| `editorial-quality.js` | Node 共享 | API/Manual 共用的读者可见文风、事实、评分与可读性门禁。 |
| `digest-status.js` | Node 共享 | `papers.json` 的分析状态、批次日期和恢复状态同步。 |
| `lib/fetch-scheduler.js` | Node 库 | 按 host 串行调度、冷却和失败类型判定。 |
| `lib/filter-input-contract.js` | Node 库 | 筛选决定所绑定的最小输入 SHA。 |
| `lib/paper-taxonomy.js` | Node 库 | 共享标签 registry 的严格加载、同义解析、候选枚举与祖先查询；raw registry 字节是 Prompt、Node/Python parser 和发布门禁的唯一标签权威。 |
| `lib/taxonomy-runtime.js` | Node 库 | 从 active 中文首选标签派生白名单、task/method 角色、紧凑 Prompt 投影与 SHA，并验证 3–5 标签、最具体任务和祖先去重；alias 只供显式 legacy 解析。 |
| `lib/historical-taxonomy-assignment.js` | Node 库 | 从完成且来源绑定的历史 analysis run 重放 canonical 标签，精确映射 concept ID、裁剪祖先，并生成逐论文 assignment；新文件名同时绑定 registry SHA 与 assignment SHA，同一 run 的分析升级不会覆盖旧审计件；旧 registry-only 文件仅在逐字段等于当前重建 assignment 时兼容读取。 |
| `lib/historical-page-staging.js` | Node 库 | 将完成 canonical 与新 taxonomy 投影到 crosswalk 保留的单篇路径；同一论文的重复历史页面共用新分析，输出隔离 staging run 与逐页 SHA。 |
| `lib/historical-daily-aggregate.js` | Node 库 | 完整重放并合并多份 per-paper staging、crosswalk/inventory 与新 canonical/taxonomy，按稳定次序重建每日汇总 staging manifest；旧汇总正文从不进入输入。 |
| `lib/historical-postprocess-scheduler.js` | Node 库 | 从 sealed-complete 历史 analysis scheduler 确定性执行重标、单篇 staging 与完整日期 daily aggregate；staging identity/checkpoint 绑定当前 analysis record/file 与 assignment SHA，每次聚合重放同日全部当前成员，多日期论文升级会同步失效其全部日期；最多并发 3，不写博客仓库。 |
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
| `workspace-role.js` | CLI/公共门禁 | 用 gitignored、`0600`、仓库 realpath 绑定的 marker 将完整工作区显式分为 `daily` 或 `history`；`set` 原子签发/显式切换，`exec` 在 npm 生产入口启动前校验角色，Node/Python 直接入口再由公共 runtime guard 重放。 |
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
| `lib/historical-arxiv-publication-metadata.js` | Node 库 | 为 direct plan 的每篇历史 arXiv 论文封存独立 publication-only Atom sidecar；每次读取重放 raw Atom、metadata、摘要 SHA、精确 vN 查询或 versionless observed 时间窗，以及原 source generation/manifest/snapshot，不修改四文件来源。 |
| `lib/page-source-crosswalk.js` | Node 库 | 跨运行时重放历史 inventory，以锁内 CAS/append-only 决策绑定 pageId/页面 SHA 与 production-authorized source authority；标题不能 verified，同 identity 多页确定性分组，finalize 与每次 final receipt 读取都重新验证来源。 |
| `lib/history-conflict-identity.js` | Node 库 | legacy conflict resolver；当前 direct policy 不把 conflict/multiple 页面送入 production crosswalk。 |
| `lib/historical-arxiv-analysis.js` | Node 库 | 将 live arXiv 全文 authority 和官方 Atom 元数据封装为可恢复的隔离 fresh-analysis run，不读取旧生成正文。 |
| `lib/historical-arxiv-analysis-scheduler.js` | Node 库 | legacy fallback：从 crosswalk 已 verified 的唯一 arXiv identity groups 派生稳定 run ID；不调度正常 direct-local 历史重写。 |
| `lib/historical-arxiv-batch.js` | Node 库 | strict fallback：只消费 named immutable fresh-arXiv failure handoff；重放 handoff 的 inventory/page SHA/非标题链接后才按其中列出的页面 CAS，绝不扫描 pending hint。 |
| `lib/historical-archive-crawl-authority.js` | Node 库 | 以 retained archive crawler 的稳定 arXiv ID 和输入 SHA 签发 identity-only authority；不暴露正文、图片或旧分析。 |
| `lib/historical-local-crawl-authority.js` | Node 库 | 汇集 archive 与 current 本地 crawler 的稳定 arXiv identity 记录，作为无网络、无正文的 local-first authority。 |
| `lib/historical-archive-crawl-batch.js` | Node 库 | retained crawler 的只读审计 helper；其 crosswalk writer 已退休，任何调用都会失败关闭。 |
| `lib/historical-conference-crawl-authority.js` | Node 库 | 以 retained conference metadata/PDF 的稳定会议 ID 形成 identity-only authority，支持 ICASSP 与 ICLR 的本地来源重放。 |
| `lib/historical-conference-crawl-batch.js` | Node 库 | legacy 只读 helper；其 crosswalk writer 已退休。会议 title fingerprint 只能进入 direct projection，不能写 crosswalk。 |
| `lib/historical-conference-local-sources.js` | Node 库 | 生成 `historical-conference-local-sources-v2`：除既有会议 metadata/PDF 外，使用 authenticated ICML poster authority 按 poster→OpenReview forum ID 合并 raw ICML 来源；合并只读 retained 根和 runtime fresh overlay，fresh PDF 必须绑定唯一 OpenReview/alternate receipt；逐来源签 metadata、record、PDF acquisition 和 source binding，缺 PDF 显式 unavailable。 |
| `lib/historical-conference-page-projections.js` | Node 库 | 将冻结 inventory 的 frontmatter title fingerprint 与本地会议 collector 建成不读正文的 page projection。 |
| `lib/historical-direct-rewrite-input-catalog.js` | Node 库 | 从冻结 inventory 的 single arXiv hint、严格 primary-score-row binding、ICML poster authority/routable binding 与 conference local-source manifest 建立 `merged-good-historical-local-data-v5`；binding 只保存字节区间/哈希，不把旧正文送入写作。 |
| `lib/historical-daily-primary-arxiv-binding.js` | Node 库 | 重放冻结 Daily 页面 SHA，只接受唯一合法评分元数据行中的规范 `[arxiv]` 主身份；签发字节区间/行哈希绑定并拒绝把正文引用链接误当 canonical。 |
| `lib/historical-icml-poster-authority.js` | Node 库 | 严格认证 ICML 2026 raw poster→OpenReview forum 快照，签发 Daily child/汇总 section 身份绑定并重放 forum-ID 本地 PDF；不把旧页面正文作为写作输入。 |
| `lib/historical-openreview-pdf-source.js` | Node 库 | 从 authenticated ICML poster authority 固定 OpenReview forum 身份，经项目 HTTP CONNECT、手动受限重定向和流式字节上限抓取缺失 PDF；以 O_EXCL/0600 封存 forum-ID PDF 和自哈希 receipt，恢复时先重放现有字节。 |
| `lib/historical-icml-alternate-pdf-source.js` | Node 库 | OpenReview 被挑战页阻断时，仅对代码白名单的 ICML poster/forum 使用固定替代 PDF；精确重放快照标题和作者顺序。`n1mAjfRDZ6` 还可受控导入浏览器下载的 SSRN PDF，重新核验标题、作者、日期和跨页特征文本并绑定固定 SSRN DOI，以非网络 receipt 明示来源；绝不冒充 OpenReview/camera-ready 字节。 |
| `lib/historical-direct-rewrite-plan.js` | Node 库 | 从 strict current catalog、inventory 与会议 projections 生成可重放路由计划，并自哈希记录所有未覆盖 frozen paper pages 及 scope/hint-status 汇总；唯一白名单跨标题预印本必须带自哈希 source disclosure，普通 v5 路由保持旧字节结构以兼容长任务恢复；不调用 LLM、网络、crosswalk 或旧正文。 |
| `lib/historical-direct-rewrite-runner.js` | Node 库 | 执行 direct plan：强制重放同 plan/generation scheduler-ready 前置证明与来源字节；持久化 source-bound analysis recovery checkpoint，支持跨进程阶段续跑；仅完整 source-only analysis/Reader 写隔离 staging。 |
| `lib/historical-direct-control.js` | Node 库 | 提供 source/analysis 两阶段 plan+generation 绑定的 immutable pause request、安全 resume、source checkpoint、registry/aggregate/task/publication blocker 只读汇总；不调用模型或修改博客。 |
| `lib/historical-direct-page-staging.js` | Node 库 | 将 sealed direct source/analysis/Reader packet 投影成历史单篇 staging 页面；跨标题预印本显示非 camera-ready 提示；current PDF=404 的同 canonical 历史版本显示“当前稿不可用”提示，并确定性重放 disclosure、manifest 与页面 SHA。 |
| `lib/historical-direct-aggregate.js` | Node 库 | 从 direct registry 与 page projections 可重放地产生日汇总、会议汇总和 conference-task staging，不读取旧正文；projection v3 用冻结链接拓扑绑定 task 成员，为无论文汇总签 `retain-unchanged`，并闭合 inventory 全页面 coverage；reader-facing-v3 输出只按主任务统计热门方向，并显示双语链接标题、八维评分、分档/文档类型/arXiv、作者机构和资源状态；条件重放历史 arXiv version identity，在排行榜和条目中显式显示当前稿不可用及实际官方 `vN` 链接。 |
| `lib/historical-direct-publication.js` | Node 库 | 对完整 direct staging、aggregate projection v3、aggregate v2 与显式视觉处置执行可恢复的历史发布事务；绑定博客基线、逐页 SHA、确定性/Hugo/语义审查、激活回滚、Git 提交及远端 OID。 |

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
| `arxiv-source-authority.js` | 对规范化 arXiv ID 规划或抓取官方全文；用于 source-authority 维护，不属于 direct route 或 fresh-failure crosswalk batch 的选择器；dry-run 不联网、不写盘。 |
| `historical-arxiv-analysis.js` | 用 live arXiv authority 与白名单原始抓取元数据建立隔离 source-only run；`analyze` 复用现有多阶段引擎，canonical 不写入 daily current。 |
| `historical-arxiv-analysis-scheduler.js` | legacy fallback：从 finalized crosswalk 调度历史 arXiv run；`new-full`、`reader-recovery`、`all` 只维护这条旧队列，不能阻塞或替代 direct-local。 |
| `historical-taxonomy-assignment.js` | 对完成的历史 analysis run 执行单篇或批量 deterministic 重标；dry-run 零写，apply 只写独立 assignment artifact，不调用 LLM。 |
| `historical-page-staging.js` | 按显式 analysis run 与当前 registry SHA 精确选择 assignment，从 verified crosswalk 生成隔离单篇页面 staging；不写博客仓库。 |
| `historical-daily-aggregate.js` | 以 `--staging-runs UUID[,UUID...]` 合并多份单篇 staging run，重建 daily summary 的隔离 manifest；保留原路径/URL，dry-run 零写，apply 不写博客仓库。 |
| `historical-publication.js` | `plan` 冻结历史发布输入、博客基线与逐路径操作；`generate` 再重放 producer 并 O_EXCL 写私有 bundle。conference refs 在有 authenticated aggregate 前明确拒绝。 |
| `historical-postprocess-scheduler.js` | legacy fallback：可恢复地编排旧 crosswalk analysis 的重标、staging 与日期汇总；direct-local 使用 `historical-direct-aggregate.js`。 |
| `conference-postprocess.js` | 使用完整 conference plan authority flags 对单篇执行重标/staging，或对 plan 全量 selected members 生成隔离 aggregate；roots 全部来自项目配置。 |
| `conference-page-render.py` | 从已封存 conference Reader 与 assigned taxonomy 渲染无 arXiv 别名的弱结构会议单篇页；不生成资产，不读取旧博客正文。 |
| `historical-arxiv-batch.js` | strict fallback：只接受 `--handoffs NAME.json[,NAME.json...]` 的 named immutable fresh-arXiv failure handoff。逐页重放冻结 inventory/page SHA 与非标题链接；不扫描 crosswalk pending 页，不调用 LLM，也不阻塞 direct 队列。 |
| `historical-archive-crawl-batch.js` | retired fail-closed compatibility endpoint；retained archive crawler 数据只能由 direct 路线消费。 |
| `historical-local-crawl-batch.js` | `historical-archive-crawl-batch.js` 的 retired fail-closed compatibility alias。 |
| `historical-conference-crawl-batch.js` | retired fail-closed compatibility endpoint；会议 metadata/PDF 和 exact title fingerprint 只能进入 direct local-source/projection 路线，不能写 crosswalk。 |
| `historical-conference-local-sources.js` | 只读生成本地会议 source manifest v2；必须显式传入绝对 `--icml-poster-snapshot` 和 retained `--icml-pdf-root`，fresh PDF/receipt 根从参数或集中配置取得；不接触历史页、crosswalk、LLM、网络或发布。 |
| `historical-openreview-pdf-source.js` | 为一个 authenticated ICML/OpenReview forum ID 规划或封存缺失官方 PDF；dry-run 零网络零写入，PDF 写入 local-sources 已消费的 ICML PDF 根，receipt 单独进入 runtime。 |
| `historical-icml-alternate-pdf-source.js` | 只封存代码白名单中的 ICML 替代来源；固定 poster/forum/标题/作者/来源 URL。`--import-file` 仅允许 `n1mAjfRDZ6`，重提取并匹配标题、作者、日期和跨页特征文本，以非网络 receipt 记录浏览器下载导入。 |
| `historical-conference-page-projections.js` | 从显式本地 catalog 和冻结 inventory 建立会议页 projection；不读取历史正文。 |
| `historical-direct-rewrite-inputs.js` | 从冻结 inventory 的 single hint、严格主评分行 arXiv binding、ICML poster total/routable binding、conference manifest 与 blog root 写出 scoped v5 direct-input catalog；不要求额外 arXiv manifest。 |
| `historical-direct-rewrite-plan.js` | 从 v5 direct catalog、inventory 与 conference projection v3 签发 source-only rewrite route plan；精确重放 primary arXiv 与 ICML routable binding，旧 v4/v3 文件失败关闭，并报告 frozen paper page 覆盖缺口。 |
| `historical-direct-rewrite-scheduler.js` | 只准备 direct plan 的 arXiv/会议来源队列和 sealed source 工件；支持稳定 paper 集合/上限、plan+generation 来源锁、pause marker、信号安全停点和逐项进度；arXiv 原子写 TXT、PDF、runtime metadata、manifest，失败只写 immutable crosswalk handoff；不调用分析、Reader、crosswalk 或发布。 |
| `historical-direct-rewrite-run.js` | 显式运行 source-only direct analysis、Reader 与单篇 staging；apply 强制所选项已有同 plan/generation scheduler-ready 状态；失败阶段以 source-bound recovery 文件跨进程续跑而不冒充 staging。 |
| `historical-arxiv-publication-metadata.js` | 默认对 direct plan 全部 arXiv 执行 dry-run 或批量封存官方 Atom sidecar；只复用满足当前 source 版本/时间窗的既有 raw Atom，其余按 sealed source ID 经公共 CONNECT metadata adapter 精确抓取，不调用模型。明确瞬时请求有界重试三次；单篇耗尽后继续同批并最终输出 `partial`/非零退出，失败项不生成 sidecar，重跑只补缺失项。 |
| `historical-direct-aggregate.js` | 为完成的 direct registry 生成可重放 daily 或 conference aggregate staging。 |
| `historical-direct-control.js` | 全历史长任务控制面：`history:status` 单次/持续只读汇总 registry、pause/lock、覆盖率、汇总和 publication blockers；`history:pause` 写入 plan+generation 绑定的停机请求；`history:resume` 只在 operation lock 释放后恢复。 |
| `historical-direct-publication.js` | 全历史 direct 发布入口：按 `plan → generate → review → publish → status` 驱动单一 publication UUID；发布阶段独占共享博客锁并验证远端 `main` OID。 |
| `historical-direct-review.py` | 全历史 direct 语义审查协调器：逐页复用正式发布 LLM 与多模态审查，持久化输入/模型/prompt/代码绑定 checkpoint，只允许全页通过后签发最终 receipt。 |
| `paper_identity.py` | `paper-identity-v1` 的 Python 同构实现，使用共享向量防止发布侧与 Node 身份/SHA 漂移。 |
| `paper_taxonomy.py` | 与 Node 共用 registry 的 Python 加载、current/legacy 显式解析和精确映射；production current 只接受 active 中文首选标签，未知/歧义不自动收窄。 |
| `taxonomy_paths.py` | 集中管理独立标签预览的Python路径，复用项目根与环境；不改变正式发布path_config模板指纹。 |
| `build-taxonomy-preview.py` | 只读扫描Hugo历史论文，生成有来源指纹的映射预览、完整旧词处置与待核报告；不修改博客或current。 |
| `deep-analysis-only.js` | 仅重放当前 `dailyFreshSourceRun` 的 sealed PDF/TXT，续跑 complete 筛选结果中未完成分析；缺少或漂移时失败，不抓取或读取 legacy cache。 |
| `batch-analyze.js` | 仅用当前 sealed 日更 PDF/TXT 批量分析 canonical 中的未完成论文；缺少 source run 时失败。 |
| `reanalyze.js` | 强制全量重分析，但仍只用 canonical 精确绑定的 sealed 日更 PDF/TXT；不从 legacy result/text/cache 恢复。 |
| `reanalyze-selected.js` | 只重分析指定 arXiv ID，并同步恢复统计。 |
| `analyze-single-paper.js` | 从论文库取一篇论文分析并合并回 canonical。 |
| `refilter-reanalyze-by-date.js` | 对历史日期重新筛选、分析并写入受控日期快照。 |
| `refresh-api-reader.js` | 对指定论文或日期批次刷新 API reader/评分/作者/图片阶段；重放 sealed PDF/TXT，并只在 OS 临时目录物化当前调用的图像。 |
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
| `blog_repository_lock.py` | Python 共享博客仓库锁；以 Git common-dir 作为跨项目工作区共同根，使用 PID/hostname/token/lease 与 inode/SHA 精确回收和释放，不污染博客 Git。 |
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
| `publish-to-blog.py` | Python 核心 | 三阶段共用的生成模板、researcher-workbench-v1 front matter/citation 与 rethink sidecar、taxonomy 扁平兼容投影、Git 事务、审查缓存、receipt 与发布证明实现。 |
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
