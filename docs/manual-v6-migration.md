# Manual v6 提质与加速迁移计划

## 目标与当前边界

这次改造同时解决两个问题：正文不能再靠字段堆砌和模板扩写，流水线也不能用重复读全文、重复扫全批次、固定长等待来换取“看起来严格”。质量门槛和加速设计必须共用同一套可审计 artifact；任何缓存命中都以内容 SHA、协议版本、模型身份和单篇论文身份为前提。

当前默认日更仍是 records v3 → spec v5 → `full-text-evidence-v5`。v6 已形成显式、隔离的可运行影子链，但不是默认切换：全文命令额外保存扁平化前的结构快照并生成 ArtifactIndex；records v4/spec v6 official assembler 回读实际文件字节并生成 Merkle root；`--v6-shadow` ingestion 只写日期隔离 canonical；publisher 能严格双读 v5/v6；shadow/benchmark CLI 只审计已有输入和真实 metrics。现已提供隔离的 v5/v6 博客候选页、匿名人工盲测工件生成器和持久 task runner；runner 只输出供主 Agent 分派的 pending task，不调用 API，也不冒充 subagent 执行。尚未完成的是三批新鲜运行的性能与人工质量验收。完成前不得把默认 v5 数据重新贴标成 v6。

2026-08-28 P0 修复后的真实边界：

- HTML 表格、MathML/TeX、图片和 bibliography 在 `.text()` 前提取；结构快照同时绑定原始 HTML、最终全文、论文 input 与来源身份 SHA。
- ArtifactIndex parser 为 `manual-artifact-parser-v2-structured`。只有 detected/recovered 数量闭环、无截断且 DOM 工件全部可审计时才是 `complete`；PDF/text fallback 固定为 `incomplete`，不再把解析不到误报为论文没有。
- `reader-longform-v2` 的结果表覆盖由源矩阵 cell ID 集合自动计算，正文必须包含确定性渲染表；图、公式、术语和相关工作必须绑定实际正文 block。
- records v4 validator 先重放完整 records v3/v5 门禁，再验证结构化长文、实际 task packet/receipt/review/revision 输出和 reviewer 后修订闭环；official assembler 还会校验真实文件 SHA、realpath、单篇隔离、全局 taskName 唯一和完整 filtered 集合。
- spec v6 与 shadow canonical 已显式接通：spec/paper shard 同时绑定 sealed record 语义 SHA、record/envelope/ArtifactIndex/task evidence 文件 SHA、longform SHA 与 assembler 协议；ingestion 重放 official assembler，只写 `manual-v6-shadow/<date>`，绝不更新正式 `papers.json`。
- publisher 对声明 v6 的页面确定性重放 blocks、完整表格、图、公式、术语和 related-work，并把 spec/record/artifact/task provenance 写入页面和 generation；任一字段漂移直接失败，不能静默回退 v5。
- 抓取侧已经增加 Manual 日期级运行锁、HF 真异步、真实 host 请求串行和跨类别摘要 Promise cache；具体分钟收益仍须联网 benchmark，禁止沿用 12–15 分钟的推算作为实测。
- generation schema v3 的页面 SHA/删除状态已在 review 开始、receipt 签发和 push 重验时统一兑现，跨日期路径与 durable Manual provenance 同时 fail closed。
- fulltext、ArtifactIndex、spec v6、shadow ingestion 与显式落盘的 shadow audit 已接入 `observed-stage-metrics-v1`：每次运行写隔离且不可变的 metrics sidecar，保存单调时钟实测 wall、实际可测 queue、cache hit/miss、输入/输出 bytes+SHA 和 paper/task 数量。shadow 会重新读取并验证每个绑定文件，旧 metrics 一旦输入或输出漂移就不能进入 benchmark；只输出到 stdout 的只读审计不额外写指标。
- metrics 是旁路可观测性而不是正文/发布质量凭证：sidecar 构建或写入失败会明确告警并保留 `unknown`，但刻意不改变 fulltext、spec 或 canonical 的原有成功/失败语义；benchmark 只能消费实际存在且 SHA 复验通过的 receipt，不能把缺失 receipt 当作 0。
- v6 新签名使用 `stable-json-ascii-keys-exact-ieee754-nfkc-text-v2`。对象 key 限制为可见 ASCII；真实评分所需有限浮点按其 IEEE-754 实际值确定性展开为精确十进制，NaN/Infinity、负零和非安全整数拒绝。中文等 Unicode 只作为字符串值参与 UTF-8 签名，NFKC 只在显式文本函数中执行。Node/Python 使用同一 fixture 固定 canonical JSON、数字形 key、1.7/1.4/1.5/0.1/1e-6、NFKC 和 SHA。

### 2026-08-27 真实历史批次审计

2026-08-28 使用 `manual:shadow` 对 2026-08-27 的既有 21 篇论文执行了无副作用审计。结果不是把页面分成不同质量层级，而是 21/21 全部判定为 `blocked_by_missing_structured_source`，`readyCount=0`、`v6CandidateCount=0`。现有 v5 读者正文平均约 2738 字、平均约 11.62 条事实主张，但由于历史输入没有保存 HTML 扁平化前的结构化表格、公式、图片和参考文献，数值 cell 覆盖率只能是 `blocked`，不能用扁平文本反推或伪造。

同时只读检查已发布博客仓库的 21 个独立论文页：21 页都没有任何 Markdown 数据表，只有 3 页包含正文图片，其余 18 页完全无图；页面的一级栏目又统一收敛为 6 个固定 `###` 标题。这些事实与用户反馈的“不是三个层级，而是整批都不合格”一致：问题不是少数低分页面，而是旧契约允许所有页面在缺失逐表结果与大多数图像的情况下通过。

审计报告位于 `data/current/manual-v6-shadow/reports/2026-08-27.json`；它绑定 21 篇论文集合和 24 个真实输入文件，并明确记录 `fetched=false`、`canonicalWritten=false`、`blogGenerated=false`、`published=false`。该历史报告只保留流程状态证据，不得把其中任何旧正文或旧页面作为 v6 作者、回归或修订输入，也不能作为 v6 成品质量验收样本。若要做逐表、逐图、逐公式的新写作与盲测，必须重新获取原始结构化 HTML/PDF 工件并从空白正文开始。

## 读者成品契约

`reader-longform-v2` 把正文拆成 6–32 个有教学职责的内容块，而不是固定六章。实证论文必须覆盖前置概念、问题、相关工作、方法/信号路径、训练、实验设置、结果、复现与边界；正文按“问题 → 方法/信号路径 → 结果 → 局限”递进。单 block 不得超过 4000 字符、单段不得超过 1200 字符、全文保持 2400–24000 字符，所有块规范化重放为最终 `readerArticle`。

硬门禁包括：

- ArtifactIndex 中每张表必须有 disposition；结果表不能 omit。数值 cell ID 由源矩阵坐标与内容自动生成，record 自报计数不参与判定；正文/附录必须嵌入由源矩阵确定性渲染的完整 Markdown 表。
- 每张图和每个公式都必须逐项选择或拒绝。选图的 URL、像素可见事实、公式原文及解释必须实际出现在绑定 block，不能只写在 sidecar。
- ArtifactIndex 给出的术语与相关工作候选必须逐项处置；术语和定义、关系与差异必须实际出现于绑定 block。
- 正文不能泄漏 `artifactIndex`、`sourceBindings`、`readerBindings` 等内部 schema 词。
- 作者回执必须绑定单篇输入包 SHA、成稿 SHA、Terra-high 模型身份、北京时间排队/开始/完成时间和修订次数。

## 单篇隔离任务与双分支复核

每篇论文生成独立 task packet，只能引用该论文目录内的 metadata、全文、ArtifactIndex、论文图表、写作契约和空白模板。路径必须是安全相对路径，packet 绑定单篇 normalized arXiv ID 与输入 SHA。一个任务不得看到另一篇论文的全文或 record。`author` packet 固定为 `fresh_from_evidence`：禁止把 `readerArticle`、`article.md`、`post.md`、博客页面、已有 canonical 正文或任何 previous draft 作为输入；缓存只能复用受控论文证据和空白模板，不能复用旧文句子或段落结构。

双分支复核之后的 `author_revision` 也不是旧稿补段或重排器。它固定为 `fresh_replacement_from_evidence_and_findings`，允许读取同篇原始证据与两份结构化 review findings，但不得读取上一版正文；输出必须是一篇完整替换稿。这样 reviewer 可以指出缺口，最终作者却仍需从论文证据重新组织全文，而不能把旧正文换顺序后冒充新教程。

作者完成后并行进入两个互不替代的分支：

1. `technical_scoring`：核对技术事实、表格数字、比较方向、八维评分与证据。
2. `pedagogy_readability`：从入门研究生视角核对概念铺垫、递进、术语解释、图表读法和模板化表达。

两个分支均须独立 Terra-high receipt。任一分支变化只失效自己和下游 merge/final-page 节点；例如只调整技术评分，不应重跑字节未变的可读性审查。最终页面还有独立单页 review receipt，不能拿正文作者自审冒充。

显式 shadow runner 入口为 `npm run manual:v6:tasks -- <action> --date YYYY-MM-DD`。依次使用 `init`、`register`、`claim`、`start`、`submit`；内容失败使用 `fail` 后显式 `retry`，平台已经确认 subagent 终止的悬挂 claim 使用 `abandon`。`claim` 最多返回 3 个 ready task，主 Agent 必须据此真实创建逐篇 Terra-high subagent，再用平台实际 taskName 执行 `start`。runner 不读取 LLM 凭据、不启动 subagent、不按超时自动猜测并回收仍可能运行的 claim；`status` 的 `pendingTasks` 才是安全待分派队列。`init` 只建立受控的逐篇目录和 checkpoint，packet 仍须由主 Agent按真实单篇工件显式 `register`，不能把 runner 描述成自动完成 records v4。

## ArtifactIndex 与缓存 DAG

全文 v2 manifest 保持原成功语义；companion `manual-full-text/<date>/artifacts/manifest.json` 以论文为粒度保存：

- 章节及来源跨度；
- 表格矩阵、确定性 replay、matrix/replay SHA 和结果表分类；
- 图与图片 metadata；
- 公式、缩写、引用、基线、数据集和指标；
- 输入全文、来源文件、输出 artifact 的 SHA 与论文身份。

工作流按依赖而非“整批版本号”判断复用：

```text
source snapshot
      |
ArtifactIndex
      |
author draft
   /       \
technical  readability
   \       /
    author revision / finding resolution
          |
    sealed record shard
          |
     spec v6 Merkle root
          |
 canonical -> generate -> final-page review -> push
```

每个节点的 cache key 至少包含：直接输入 artifact SHA、协议/contract 版本、角色、模型与 reasoning、任务模板 SHA、论文 ID。节点输出改变时只沿依赖边传播 stale；无依赖关系的兄弟节点保持 reusable。失败项保留 checkpoint，不回滚同批已完成论文。

records v4 是单篇封印结果；spec v6 首先写 per-paper shard。批次未齐时只能是 pending/running，重复 paper shard 必须拒绝，严禁后写覆盖。official assembler 使用真正的成对哈希 Merkle root，并同时绑定落盘 record、envelope、ArtifactIndex、task packet/receipt 和 review/revision output 字节。spec v6 只能由显式 shadow ingestion 消费，不能进入正式 canonical。

## 抓取与发布加速

抓取器采用 host-aware 调度：recent、search、abstract 和 Atom API 的真实网络请求在同一 host 串行；HuggingFace 使用异步 `execFile`，不会再以同步 curl 阻塞 arXiv callback。Manual 同日期 raw/select/fulltext 共用跨进程锁；批次级 normalized arXiv ID Promise cache 避免跨类别重复摘要。来源健康、代理、checkpoint 和完整覆盖门禁不变。

性能 sidecar 不从 `startedAt/completedAt` 猜 wall time。raw fetch 用 `observed-raw-fetch-metrics-v1` 记录端到端单调 wall、逐类别 checkpoint 命中、摘要 cache、显式 retry wait 和 host scheduler 实际 wait，并绑定最终 raw/checkpoint SHA；指标失败不改变抓取结果。fulltext 与 ArtifactIndex 目前在 worker 内交错运行，因此分别收集每篇同阶段的 `[start,end]` 单调时钟区间并计算 interval union，标记为 `union_of_observed_same_stage_operation_intervals`：同阶段并发重叠只计一次，另一阶段独占的空档不计入；两个阶段的 union 仍可真实重叠，禁止把它们相加冒充端到端 wall。spec v6 记录 assembler 锁内 wall 和真实锁等待；shadow canonical 记录整个 ingestion run wall。没有可观测 queue 的阶段保留 `unknown`。指标文件位于 `data/current/manual-v6-shadow/<date>/metrics/`，通过 `manual:shadow -- --metrics FILE` 显式选择；同一报告不得给同一阶段提供两份指标。

跨批次验收使用 `npm run manual:performance-report -- ...`。该只读层同时复核 raw fetch、stage 和 v5 work-queue sidecar 及其绑定文件；任一 symlink、realpath 逃逸、bytes/SHA 漂移或身份不一致都使整份报告 fail closed。同日重跑不增加批次数；只有每个指标覆盖至少 3 个不同日期时才输出 `nearest-rank-v1` P50/P95，否则必须是 `insufficient_data`。默认仅 stdout；显式 `--output FILE` 才写入 `data/current/manual-performance-reports/`，且禁止覆盖。

发布 review 在每次尝试开始时为每页构造一次不可变 page artifact，统一绑定原始 SHA、front matter、body 和确定性门禁结果；正文解析、确定性 dry-run、LLM 和图片审查复用该 artifact，收口前重新读/哈希只用于发现并发变化。页面结果立即写入日期隔离 shard；调度开始时线性扫描一次，任务回调不再反复重扫全批次。终轮 LLM review 只读：只要模型建议改字，该页就失败并回到修复阶段；绝不在 review 后改写已经签名的字节。批次 receipt 在所有页面 shard 完成后一次性收口，并继续绑定 generation、博客基线、review 协议、Hugo gate、remote 身份和远端 OID。

## 迁移阶段

1. 已完成 P0 基础：结构化 HTML 快照和诚实的 inventory health、Manual 运行锁、HF 真异步与摘要去重、generation schema v3 字节闭环、删除 attestation、durable provenance、只读 review、`reader-longform-v2` 与 records v4 严格超集 validator。
2. 已完成 P1 影子数据链：records v4/spec v6 official assembler、真实文件/路径/task 闭环、隔离 shadow ingestion、v6 canonical schema、publisher/review 双读与 fail-closed、shadow/benchmark CLI。
2.1 已完成真实性能与跨运行时哈希基础：五个明确入口保存真实 metrics sidecar，shadow/benchmark 复验 metrics 及其输入输出 SHA；Node/Python 共享 stable JSON/Unicode/NFKC/hash 测试向量，并对真实小数评分执行一致的 IEEE-754 精确十进制签名。
3. 已完成 records v4 持久 runner 基础：单篇 packet 注册、3 槽 claim/start/submit、Terra-high receipt、失败/retry checkpoint、内容 SHA 缓存与仅下游失效；默认 v5 CLI 保持不动。真实 subagent 的创建和结果落盘仍由主 Agent显式执行。
4. 成品影子运行：为新鲜批次真实生产两份都从同一受控论文证据冷启动的候选页，不写正式博客仓库、不发布；比较事实覆盖、表格数值、图文邻接、人工缺陷数、耗时和缓存命中率。严禁把旧 v5 页面、旧 canonical 正文或旧 readerArticle 带回质量回归。
5. 性能验收：积累至少 3 个新鲜联网批次，按 `nearest-rank-v1` 报告各阶段 P50/P95；unknown/not-applicable/blocked 不得记为 0。
6. 显式试运行：只有影子质量和性能验收通过后增加面向正式博客的显式 v6 开关；不得根据文件存在自动切换。
7. 默认切换：端到端测试、迁移文档、回滚路径和历史数据兼容全部通过后，才更新 AGENTS/SKILL 中的默认版本。

## 验收指标

质量验收以零遗漏和可回放为主：结果表数值单元格覆盖率 100%，图/公式 disposition 覆盖率 100%，内部字段泄漏为 0，正文/评分/页面 reviewer 身份独立，所有精确数字能回到同篇来源。

性能验收分阶段记录 wall time、网络等待、任务运行、缓存命中和重算原因。不得预设“22 分钟降低到 12–15 分钟”为既成结果；至少完成 3 次新鲜联网批次后报告 P50/P95。review 的不变页面应为 O(N) 字节/确定性复核加 O(1) 单页 LLM pass 复用，不再因每个 worker 回调形成 O(N²) 扫描。质量门禁不得为达到耗时目标而降级。

## 失败与回滚

- ArtifactIndex 失败不改变 v5 全文成功态，只将对应 companion 项保留为 failed/pending。
- v6 任一 receipt、identity、SHA 或集合闭包不匹配都 fail closed；不得回退到自动填充或批次级统一签名。
- v6 pilot 失败时删除显式开关即可回到未修改语义的 v5 默认链路；已有 v5 manifest/canonical 不需要迁移。
- review 建议修改时不签发 receipt；修改完成后页面 SHA 改变，只复审该页及依赖它的批次收口。
