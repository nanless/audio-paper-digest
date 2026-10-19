# 会议论文的来源获取、分析与发布

会议从官方目录和 PDF 开始，完成筛选后使用统一的 `process` 入口，再生成、审查和发布博客。分析、Reader、评分、标签及发布展示共享日更实现；官方 PDF 的身份与能力核验保留会议适配。已有博客的批量更新使用历史流程，保留已有 URL。

标签统一使用新版386项九维词表：单篇及汇总成员只呈现实际选项及祖先路径，父级不算直接命中，总目录保持完整。生成和审查/推送须核验站点已有本批SHA的双份原快照，缺失先完成受控词表同步，不能借会议图片或sidecar通道写入未审目录资产；见[统一标签规则](tag-display-policy.md#三条流程共用的目录与呈现)。

## 工作区与入口选择

运行前先核对目录和工作区角色，所有项目脚本均须在沙箱外执行：

```bash
pwd
npm run workspace:role -- status
```

| 任务 | 工作区与入口 |
|---|---|
| 获取、筛选和处理 2026 年新会议 | 已绑定 `daily` 的日更目录，使用 `conference:*`。 |
| 重写和发布历史会议页面，保留已有 URL 和任务页 | 当前目录，使用[全历史重写](history-rewrite.md)及[历史直接发布](history-direct-publication.md)。 |

新会议的 npm 包装入口会设置并校验所需运行模式；不要自行伪造 `AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE` 或跳过角色检查。旧历史工作区已废弃；日更、会议和历史任务不能同时生成、审查、推送同一博客，或修改同一远端 `main`，执行者负责错峰。下文的 `UUID`、`NAME.json`、`C.json` 等是占位符，执行前须替换为对应入口接受的真实任务 ID 和安全文件名。

```text
官方目录与逐篇 PDF
  → 已核验的 discovery catalog/report
  → 全集 PDF 摘要证据
  → 每会独立配置和 LLM 筛选
  → conference:process：提取、导入、分析、评分、解读和页面暂存
  → conference:publish：generate → review → push → verify
```

会议来源与 arXiv 日更不同，分析仍复用 `analysis-engine.js`、正式分析的 13 个解析标题、类型感知八维评分、`beginner-researcher-v3` 解读及 `api-reader-source-bindings-v4` 来源核验。单篇页面和 `reader-facing-v3` 会议汇总使用现行标签体系，包含中英文题目、分档、文档类型、评分、作者机构、资源状态及官方记录和 PDF 链接，不能沿用旧标签或另造会议标签。

会议汇总只读取已通过来源、解读和分类检查的单篇结果，不再让模型总结整批，因此不会为了汇总重复生成每篇深度解读。队列入口只协调已筛选会议的处理和发布，不负责获取或筛选。

会议单篇与日更共用作者、资源、评分说明及研究工作区的展示和导出实现。引用 JSON、BibTeX、RIS 与研究上下文四份文件进入博客仓库，实际论文图仍进入图片仓库。会议导出只写真实会议身份和原全文 SHA；缺少独立摘要或公开来源地址时明确记录不可得，不填造 arXiv ID、摘要、链接或作者。生成、审查与发布会从已核验分析重建并逐字比较四文件，上线核验还要求四个正式地址的实际字节与已审 SHA 一致。

## 按当前状态选择下一步

| 当前状态 | 做什么 | 正常结果 |
|---|---|---|
| 还没有来源 | [获取官方目录和 PDF](#获取官方目录和-pdf)，再 discovery | 官方目录、逐篇 PDF 与可重验回执 |
| 来源已核验，尚未筛选 | [提取摘要证据](#筛选前提取摘要证据)，再[配置并执行筛选](#配置与执行会议筛选) | 全集证据与完整入选集合 |
| 筛选 complete | [统一处理](#新会议统一处理与暂存) | 全成员完成凭证、私有单篇与汇总 |
| process 完成，尚未发布 | [生成、审查、推送与验收](#新会议独立发布与线上核验) | 精确发布记录与线上核验 |
| 已有进度或旧完整稿 | [恢复与迁移](#已有完整会议只更新页面) | 保留原来源、次数和费用继续处理 |
| 原 process 已经发布 | 使用[历史流程](#与全历史重写的衔接)维护既有 URL | 不覆盖原不可变发布记录 |

每步使用实际返回的文件名和 ID。下面的示例展示参数关系，不构成新的分析额度、来源升级或视觉授权。

## 获取官方目录和 PDF

当前实现支持以下固定来源：

| 类别 | 来源代号 |
|---|---|
| 语音、音频和音乐 | `odyssey-2026`、`chime-2026`、`jep-2026`、`speechprosody-2026`、`interspeech-2026`、`iwslt-2026`、`eusipco-2026`、`nime-2026`、`dafx-2026`、`icmc-2026`。 |
| AI、机器学习、视觉和语言 | `aaai-2026`（OJS 第 40 卷）、`aistats-2026`（PMLR v300）、`uai-2026`（PMLR v337）、`cvpr-2026`（CVF 主会）、`acl-2026`、`eacl-2026`。 |

ACL/EACL 只纳入主会 `long`、`short` 和 `findings`，排除卷首、全集 PDF、workshop 和非论文演讲；Odyssey keynote 摘要页也不作为单篇论文。CHiME、JEP、Speech Prosody 和 Interspeech 使用各自官方 ISCA Archive 目录。

ICMC 2026 只有一份合并论文集 PDF。程序先保存原 PDF，再按官方目录大纲的物理页范围切成单篇，生成页码对应表和绑定原始 PDF SHA 的回执；该切片路径实际串行执行。不能从源 PDF 恢复的页面或结构保留为证据状态，不用猜测的题目、表格或公式补齐。

AAAI 第 40 卷分为 48 个独立 OJS issue，`/issue/current` 只代表其中一期。目录获取只接受代码固定的 48 个官方 URL，每期保存 `responses/issues/issue-NN-OJSID.html` 及响应回执。48 对记录全部可重验、标题与卷期相符且官方 article ID 跨期唯一，才输出聚合 `metadata.json` 和目录回执。中断后重跑可恢复完整的期刊响应与回执对，单期不能充当全集。

来源固定写入 `data/runtime/official-conference-acquisitions/<provider>/`，不接受任意输出根。目录、PDF 和回执使用私有权限，官方 URL、响应、字节数及 SHA-256 必须对应：

```bash
npm run conference:acquire -- catalog \
  --provider iwslt-2026 --conference-id iwslt-2026 --year 2026 --apply
npm run conference:acquire -- download \
  --provider iwslt-2026 --conference-id iwslt-2026 --year 2026 --apply --concurrency 4 --retries 3
npm run conference:acquire -- verify \
  --provider iwslt-2026 --conference-id iwslt-2026 --year 2026
```

`catalog` 和 `download` 须显式选择 `--dry-run` 或 `--apply`；`status` 和 `verify` 不接受这两个模式参数。`--provider`、`--conference-id` 和 `--year` 必须与固定来源身份一致。

下载默认并发 1、网络重试 0，可显式设置 `--concurrency 1..5` 和 `--retries 0..5`；这些参数及 `--limit` 只用于 `download`。重试限于 socket、超时、HTTP 429 和 5xx，保持同一官方 URL。任一下载失败后停止领取新论文，等待已经开始的下载任务结束，再返回失败；已成功保存的文件仍保留。重跑同一命令会重验完整 PDF/回执对并补缺项；有回执却缺 PDF 时仍须停止，不能据回执假装文件存在。

目录响应接受 HTML 和 XHTML；重新读取并核验已封存目录响应时，采用相同的类型要求。目录、PDF 和凭证均先完整写入临时文件，再以不可覆盖的方式保存到正式路径。普通写入失败不会留下半截正式文件。

`status` 计算已下载数量前，也会逐篇核对 PDF 与凭证字节；损坏文件不会被计为完成。`status` 和 `verify` 始终只读。若进程在正式文件已完整保存、临时硬链接尚未移除时中断，重新执行对应 `catalog --apply` 或 `download --apply` 会先核验文件身份并回收同机已退出写者的临时硬链接，再重验完整来源与凭证。

若进程在正式文件保存前被强制终止，可能只留下临时文件。程序保留该文件并报告准确路径；先核验写入进程已经退出、文件确属本次中断及正式凭证状态，再单独清理并续跑。不要批量删除未知文件，也不能把这类中断描述为已经自动恢复。

完成下载后再做 discovery。`--pdf-root` 指向 provider 根，而不是 `pdfs/` 子目录，因为 metadata 中的 `pdfFile` 是 `pdfs/<official-id>.pdf`：

```bash
npm run conference:discover -- --apply \
  --adapter official-proceedings --conference-id iwslt-2026 --year 2026 \
  --metadata "$PWD/data/runtime/official-conference-acquisitions/iwslt-2026/metadata.json" \
  --pdf-root "$PWD/data/runtime/official-conference-acquisitions/iwslt-2026" \
  --acquisition-root "$PWD/data/runtime/official-conference-acquisitions/iwslt-2026" \
  --candidate-output iwslt-2026.json --report-output iwslt-2026-report.json
```

目录和文件哈希一致只证明程序能够重验来源，不能代替人工读论文或判断模型结论是否正确。

## 筛选前提取摘要证据

筛选前必须完成离线 PDF 摘要证据批次。程序认证 discovery catalog/report，把每篇唯一 `exact` PDF 安全复制到隔离目录，生成绑定原始记录的对应文件，再使用固定 PyMuPDF 提取器。`abstract-locator-v1` 只取前两页中唯一、且有明确结束标题的 Abstract 原文，不总结、不调用模型，也不作入选决定。

摘要缺失、歧义或过短记为不可用；提取器失败则阻止继续，不能自动排除这篇论文。命令如下：

```bash
npm run conference:evidence -- plan \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --run 00000000-0000-4000-8000-000000000001
npm run conference:evidence -- apply \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --run 00000000-0000-4000-8000-000000000001 --limit 10
npm run conference:evidence -- status \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --run 00000000-0000-4000-8000-000000000001
npm run conference:evidence -- verify \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --run 00000000-0000-4000-8000-000000000001 --limit 10
```

普通 `apply` 默认处理 1 篇，`--limit` 范围 1–500。确认全集并准备一次处理时，须同时提供 `--all --expected-total N`，其中 `N` 精确等于认证目录的成员总数，否则在创建或推进运行前拒绝。`--all` 仅供 `apply`，不能与 `--limit` 共用。下面的 39 是示例会议的数量，不能照搬到其他目录：

```bash
npm run conference:evidence -- apply \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --run 00000000-0000-4000-8000-000000000001 \
  --all --expected-total 39
```

这样既避免误启动数万篇任务，也减少小批次恢复时反复扫描已有回执的本地开销。状态保存在 `data/runtime/conference-filter-evidence-runs/<runId>/`。恢复先重验已完成成员的回执、摘要定位结果、文本及解析证据 SHA；半成品、提取器错误或字节变化都会停止，不能改成排除决定。

非 AAAI 会议继续使用不带 `profile` 的默认定位实现。只有 `aaai-2026` 使用 `aaai-2026-bare-introduction-v1`，允许前两页唯一独占行 `Introduction` 作为摘要终点。实现 SHA 必须来自代码登记表，CLI 不接受任意 profile/hash；更换 profile 必须建立新运行，不能改写旧回执。

全集完成后才生成 `evidence-catalog.json` 和 `evidence-report.json`。筛选通过 `loadEvidenceHandle()` / `evidenceHandleSnapshot()` 读取已经认证的对象，把 catalog/report/state、各篇回执和摘要 SHA、定位版本一起纳入输入、请求及恢复核验。`ready` 摘要进入关键词和提示词输入；其他状态保留原 metadata，交给模型判断，不能凭题目或不完整摘要直接排除。不得直接信任裸 JSON 或路径，也不得把摘要回写到已固定的官方 metadata 快照。

## 配置与执行会议筛选

当前 `conference-filter-v6` 保存候选发现记录、完整摘要证据目录与报告、逐篇回执和定位信息，并绑定来源 SHA、选择规则、提示词、模型、请求格式和标签词表 SHA。记录分别标明入选、排除、待处理或失败；全部论文处理完成且没有失败，任务才记为 `complete`。

`conference:filter` 管理配置、状态和显式人工决定；`conference:filter:run` 是生产 LLM 筛选入口。它逐篇核验官方记录和完整输入，通过 `requestLlmJson()` 使用项目路由、代理及持续使用当前可用账号的账号池：

```bash
npm run conference:filter -- spec --catalog NAME.json --report REPORT.json \
  --evidence-run EVIDENCE_RUN_UUID --output CONFERENCE-FILTER-V6.json
npm run conference:filter -- prepare --catalog NAME.json --report REPORT.json \
  --evidence-run EVIDENCE_RUN_UUID --spec CONFERENCE-FILTER-V6.json
npm run conference:filter:run -- --apply --catalog NAME.json --report REPORT.json \
  --evidence-run EVIDENCE_RUN_UUID --spec CONFERENCE-FILTER-V6.json \
  --filter UUID --owner filter.worker --limit 1
npm run conference:filter -- status --filter UUID
npm run conference:filter -- apply --filter UUID --decision DECISION.json --owner OPERATOR
```

新任务只使用 v6 配置；模型请求记录使用 `conference-filter-llm-request-v3`。旧 v5 配置只供原 UUID 的已有任务恢复，核验原记录后仍按原格式继续，不能用它创建新任务。新旧词表字段不能同时出现，即使值相同或为空。决定、选择回执、选择凭据和锁记录仍使用各自的版本 5，不能把它们当成任务版本 6。

每会配置位于 `data/runtime/conference-filter-specs/`，只能由 `spec` 从同会认证的 discovery 双文件及完整摘要证据运行生成，不能跨会议共享。以下字段示例中的占位 SHA 须按相应文件原字节或规范化对象真实计算，不能直接通过校验：

```json
{
  "contract": "conference-filter-spec-v6",
  "version": 6,
  "filterPolicySha256": "<64-hex-current-policy-sha256>",
  "promptSha256": "<64-hex-current-prompt-sha256>",
  "model": "muse-spark-1.3-contributor",
  "endpointProtocol": "openai-responses",
  "endpointIdentitySha256": "<64-hex-current-normalized-endpoint-identity-sha256>",
  "tagCatalogSha256": "<64-hex-current-tag-catalog-file-sha256>",
  "evidenceCatalogContract": "conference-filter-evidence-catalog-v1",
  "discovery": {
    "contract": "conference-discovery-catalog-v2",
    "conferenceId": "iwslt-2026",
    "catalogSha256": "<64-hex-discovery-catalog-file-sha256>",
    "reportSha256": "<64-hex-discovery-report-sha256>",
    "candidateSetSha256": "<64-hex-normalized-filter-candidate-set-sha256>"
  },
  "evidence": {
    "runId": "<evidence-run-uuid-v4>",
    "catalogSha256": "<64-hex-evidence-catalog-sha256>",
    "reportSha256": "<64-hex-evidence-report-sha256>",
    "stateSha256": "<64-hex-evidence-state-sha256>",
    "memberSetSha256": "<64-hex-evidence-member-set-sha256>",
    "locator": {
      "contract": "abstract-locator-v1",
      "implementationSha256": "<64-hex-registered-default-locator-sha256>"
    }
  }
}
```

AAAI 的 `locator` 还须精确包含 `"profile":"aaai-2026-bare-introduction-v1"` 及其登记的实现 SHA。旧 AAAI 默认绑定、未登记的 profile/hash、不同证据运行或不完整论文集合，均在 prepare/runner 和模型请求前拒绝。旧 `conference-filter-spec-v4`、无摘要证据的配置或共享配置不能继续使用，须按会议重新 prepare。

`spec` 自动读取项目配置中的模型、协议和端点，当前新请求统一使用 `muse-spark-1.3-contributor`、OpenAI Responses 和项目 HTTP CONNECT 代理；不要复制示例手写生产配置。`endpointIdentitySha256` 由 `endpointIdentitySha256(endpoint, model)` 对公共路由规范化后的 API URL 的 UTF-8 字节计算，不含 API key。占位值不代替当前端点计算。已有筛选任务保留当时的模型、协议和全部请求证据；端点、协议或模型改变须新建筛选任务，不能为了套用当前示例改写旧 spec。仅重生成已有合格页面不重新筛选。

### 筛选健康检查、并发与恢复

`prepare` 返回的 `filterId` 用于运行和恢复。先用 `--limit 1` 检查一篇论文的请求、响应和筛选记录，再保持同一组输入、去掉 `--limit` 继续。推荐全局最多同时运行 5 个不同筛选任务；这是操作建议。同一 `filterId` 的请求、原始响应、用量和状态更新共用一把锁，不得启动并发 worker。中断后继续使用原 catalog、spec 和 `filterId`，不能换输入恢复旧任务。

每次请求先在锁内以 `O_EXCL` 保存 intent，再保存终态 HTTP 原始响应、提供方用量及各物理请求的用量账本（usage-ledger）事件绑定，最后生成决定文件并按状态 SHA 比较后更新。入选和排除决定都须有受控文件；模型决定还须真实请求/响应字节、模型/协议及非零逻辑请求用量。人工决定使用独立 actor，不能冒充模型。普通 `buildDecisionArtifact` 和人工 `filter apply` 拒绝 LLM actor；生产证据生成器不接受自传 transport 函数。

筛选与日更使用同一个结构化决定解析器。格式无法解析时保存响应和用量，记为 `failed`，不在同一 intent 中追加格式修复请求。pending 优先处理；failed 只有显式 `--retry-failed`、超过五分钟退避且累计少于 `FILTER_CONFIG.maxRetries`（当前 5 次）时才重试。新尝试分别记录请求、响应及费用依据；OpenAI Responses 从第二次已登记尝试起，输出预算至少为 4096 tokens。

请求中断后先恢复已有回执或决定文件。intent 已存在而终态响应不可知时，保守记为带错误类型的失败，不自动重复计费。用量完整、输出非零且严格 JSON 的 `included`/`excluded` 才能成为最终决定。账号池切换前的完整原始响应无法从公共封装取得时，回执保留物理请求的用量账本事件 SHA，并单独保存终态原始响应，不能把不可得状态说成完整响应。全集 complete 后才生成只含 included 身份的选择回执。

筛选遇到公共请求封装标记的 `scope=run` 故障时，先保存本篇请求、回执、失败决定和状态，再原样抛出异常并停止本轮派发。HTTP 401 也会停止；其余候选保持待处理。恢复尚未登记的回执或决定时，账号认证、额度耗尽、账号状态及配置故障会按稳定错误码恢复为运行级故障，保存本篇记录后停止，不重复请求，也不改写旧凭证。普通正文格式错误、输出截断等单篇失败仍继续处理下一篇。排除运行级故障后可重新启动；失败论文仍须遵守显式重试、退避和次数限制。

## 新会议统一处理与暂存

会议分析、Reader、评分、标签及逐篇暂存统一由 `conference:process` 调度，使用与日更相同的公共引擎及当前提示词。恢复仍核对完整目录、筛选集合、来源和保存的检查点；不再提供分离的执行、分析和页面处理入口。

```bash
npm run conference:process -- --dry-run \
  --catalog odyssey-2026.json --report odyssey-2026-report.json --filter UUID \
  --concurrency 3
npm run conference:process -- --apply \
  --catalog odyssey-2026.json --report odyssey-2026-report.json --filter UUID \
  --concurrency 3
npm run conference:process -- --status \
  --catalog odyssey-2026.json --report odyssey-2026-report.json --filter UUID
npm run conference:process -- --status --verify-files \
  --catalog odyssey-2026.json --report odyssey-2026-report.json --filter UUID
```

入口只接受 complete、非空、来自 `official-proceedings` discovery 的选择，每个 included 成员必须是唯一 `exact` PDF。自动来源验收使用 `conference-deterministic-source-seal-v1`，表示程序按官方 metadata 的 `pdfFile` 核验文件，不表示人工审阅。程序内部依次安排提取、暂存、导入和计划，再完成共享深度分析、评分、解读、标签和单篇暂存页。

每篇仍按固定 PyMuPDF 提取，重新核对提取请求、元数据、PDF、文本、结构化证据、回执及验证记录的 SHA。进程 UUID 由入选集合、词表原文件和实现指纹确定；每篇分析 UUID 再由进程 UUID 和完整 `paperId` 确定。状态保存在 `data/runtime/conference-processes/<process-uuid>/state.json`。

新进程和完成凭证各自使用 v2 格式，词表身份字段为 `tagCatalogVersion`、`tagCatalogSha256`。已有 v1 记录先按原对象完整核验，再继续原 UUID，保留创建时的词表字段和值；读取不会给旧记录换格式或重算原身份。工作区盘点同时识别两版，但盘点通过不能代替正式完成及发布检查。队列和分析配置仍使用各自独立的版本。

`--concurrency` 默认 1，范围 1–60，覆盖单篇处理生命周期；每篇进入分析引擎时内部并发为 1，单篇本轮不会自行重复跑整条流水线。初始有资格的成员先统一完成正常首轮，全部在途结果保存后只续可重试失败项。总轮数读取公共 `PD_ANALYSIS_BATCH_MAX_ROUNDS`，默认3，但不超过原单篇3次尝试窗口及其剩余额度；成功项不再请求模型。每轮保存不可变的 `conference-process-round-v1` 回执，语义进展读取原分析/恢复记录中的完成阶段、正文和草稿，不以尝试或费用增加代替。

会议外层并发仅决定同时处理多少篇，不改变来源计划、模型、单篇内部并发、原请求额度或整批轮次。Reader 重阶段仍由原 `PD_API_READER_CONCURRENCY` 独立限流；正常完整分析修订仍受原主分析配置且最多3槽限制。积压主要是 Reader 且原配置为10时，可显式使用 `--concurrency 10` 填满已有槽位；不要为加速更改已绑定的模型或预算。

相同身份重跑使用同一 UUID，从原分析检查点继续。整批来源证明按 state SHA 一次合并，逐篇 claim/result 仍即时持锁保存；该优化不缓存来源字节或跳过后续实际核验。只有来源、共享分析完成回执、当前标签及单页清单全部通过，论文才 complete；所有成员 complete 后才生成会议汇总及不可覆盖的 `completion-receipt.json`。

同一进程内，已认证计划和来源清单共用深度冻结的只读视图及私有成员索引，避免每篇重复克隆和核验完整会议集合；普通对外快照仍返回独立副本。缓存不包含论文来源文件字节，元数据、全文、结构化提取记录与 PDF 每次仍安全重读并核对 SHA，文件大小或修改时间相同也不能代替字节核验。

`manualHandoff` 读取公共人工建议阈值，仅报告多轮后的少量持续失败，不改 partial/analysis_partial 或完成凭证，也不重开 Reader 额度。预算耗尽、身份/来源错误或不可重试项保留阻断；受控人工修正后仍走原来源、分析、Reader、标签、暂存和独立发布检查。完整规则见 [统一批次恢复](three-workflows.md#全批轮次与失败集合)。

分类未能确定时，程序保存 `tag-review-queue.json` 和具体阻断原因。这是单篇待处理条件，不是服务故障，也不能把未解决标签放进可发布汇总。

只有 `--apply` 取得 process 操作锁，`--dry-run` 和 `--status` 只读且不取写锁。程序返回或抛出异常时在 `finally` 释放锁；进程退出遗留的锁只允许安全回收同机已死亡 owner，未知或仍存活 owner 不能擅自清理。逐篇更新另有状态 SHA 比较，禁止把 complete 回退成 analyzing 或 analysis_partial。最终完成事务在锁内重新确认全部成员及回执。

`--status` 默认只读 `state.json` 和 `completion-receipt.json`，检查状态与完成凭证中记录的内容及对应关系，不读磁盘上的分析结果和暂存页；报告里的 `filesVerified` 为 `false` 就表示这次没核文件。要同时确认文件在位，加 `--verify-files`：它按 `analysisProof`、`pageProof` 和 `aggregate` 复算 analysis.json、暂存 page.md／manifest.json、汇总页的 SHA，缺文件或字节不符都列进 `fileVerification.failures`（`paperId`、`artifact`、`detail`），进程退出码为 1。它只遍历该进程已知的 `analysisRunId` 目录，不扫整个暂存根目录。来源封存文件不在这项检查内，它们由 `--apply` 的来源连续性核验和发布前检查负责。

process 只生成私有来源、缓存、检查点及单篇和汇总暂存页，不执行博客生成、审查、推送或远端验证。完成处理后继续下节发布，不把 process complete 当作已上线。

单篇页面暂存的写入使用公共文件锁，锁记录位于暂存根目录的 `.stage-locks/`，按分析运行、词表及页面生成实现区分。同一组输入的待审标签记录升级也在该锁内进行：删除前重核打开的文件描述符、当前路径和父目录；文件被替换或读取失败时保留现状并报错。它只协调遵守此入口的写入者，不授权手工删除锁或覆盖未核验文件。

### PDF 中能核验的图表和公式

PDF 提取保留逐页 PNG、内嵌图片摘要、表格单元格及坐标、Figure 和公式候选，以及可重验的页面/区域像素 SHA。不能因为来自 PDF 就统一说图表不可得，也不能把普通文本拼接当作原始 TeX。

当前会议来源不会把启发式表格候选升级成可信 DOM 单元格，矩形矩阵也不能证明原表行列正确；表格候选标为 `needs-review`，数值叙述和可支持的表格通过逐字原文引文核验。没有原始 TeX 时公式来源为 `unavailable`，保留公式候选和页面证据，不能丢上下标后声称得到可核验公式。不能定位完整表格及数值时不展示表格。

认证 PDF 的同名方法行可由原 `Dim` 输入维度列消歧，但展示须保留所有原数值列，原行名和条件组合唯一，结果逐格一致。维度、模型容量或微调策略作为原表显式行带时，由完整几何及字形重放各行条件路径；表框、分隔线、单位、条件或行列不完整均拒绝，不能凭相同指标值选行。层级表原成功路径优先，补证分支不改旧证明。

原表的 `Dataset/Separator` 合并条件列须按完整横线带和唯一原条件逐行重放，展示保留真实条件列与全部结果列。原表仅有3或4列时按原列展示，不增加解释性列凑宽表；解释放在表外。不能从 `source_quotes` 抽取任意数字拼成“来源句／量化值一”结果表，也不能借文献年份或页码满足表格最低数量。无法完整呈现时进入正常 Reader 修复，原来源、响应与费用保留。

资源预检含认证 PDF 脚注证明时，生成后的即时复验和中断后的冷读取都须重放真实原计划及同篇来源作用域。适配器核对证明属于本子运行，且论文、来源文件、来源快照及全文身份一致，再在认证 PDF 权限内执行原检查；复制证明对象或保留其 SHA 不能代替来源权限。另一付费子窗口的脚注证明不支持直接复制继承，仍严格拒绝，不改签执行身份。脚注的作者归属不证明网址当前可达，不改变预检资源状态、原模式、请求次数或费用。

Figure 识别支持 `Figure`/`Fig.` 图注，排除 `Figure 2 presents ...` 等正文引用，保留原图号并去重。双栏图只用同栏前置图注限制裁剪；没有有效图片资产的候选不进入可发布图片集合。图片须有页码、图号及解析证据 SHA，不能从旧博客反向补造。旧 weak 来源只供符合相应身份条件的兼容读取。

新会议解读的 PNG 保存在该篇隔离分析运行的 `reader-assets/`。后处理核对文件名、缓存路径、图片类型、SHA 和字节数，再把有效图片写入私有页面暂存目录，发布时进入受控图床。不能将这条会议路径与默认 arXiv 日更或历史直接重写的临时像素路径混为一谈，也不能跨任务复制图片绕过身份检查。

## 新会议独立发布与线上核验

以 process 返回的 ID 发布同一会议，依次执行：

```bash
conference_process_id='替换为 process 返回的 UUID'
npm run conference:publish:generate -- --conference-id odyssey-2026 --process-id "$conference_process_id"
npm run conference:publish:review -- --conference-id odyssey-2026 --process-id "$conference_process_id"
npm run conference:publish:push -- --conference-id odyssey-2026 --process-id "$conference_process_id"
npm run conference:publish:verify -- --conference-id odyssey-2026 --process-id "$conference_process_id"
npm run conference:publish:status -- --conference-id odyssey-2026 --process-id "$conference_process_id"
```

`generate` 重验来源及暂存页，生成博客文件和本批清单。`review` 对最终页面字节作只读审查，包含正文模型审查、图片多模态、Markdown 及 Hugo 检查；失败不保存通过记录，也不原地改正文。模型通过不等于论文事实已绝对正确，更不代替独立事实或人工视觉检查。

发布作者核验只读保留的官方元数据、PDF、全文和分析绑定。原 `2.3.0` 抽取凭证仅通过已有的 `retainedLegacySnapshot` 重放，逐项核对原凭证自哈希、成员、请求及来源文件和原 `sourceProof`；其它版本仍走严格的当前抽取凭证核验。不重抽 PDF、不改旧凭证版本、不重新请求作者或 Reader。早期 Interspeech 2026 的1354篇作者重放耗时15.37秒；采纳72篇正常 Reader 维护稿后，入口还须先逐篇完整核验这些新稿，再核1354篇作者来源，真实同入口零模型重放耗时235.44秒、输出1,129,903字节且完整通过。因此仅此固定整批作者子进程使用600秒期限，输出上限仍为2 MiB，其它入口不变。失败须报告真实退出码、超时、输出截断、输出长度及错误尾部，不能把空错误或运行期限问题直接解释为作者事实错误。

仅修复这种发布专用的只读来源兼容、入口角色或有界传输时，已有完整 process、暂存页及其原实现声明保持真实字节，沿原生 `generate → review → push` 重新检查即可；不为发布检查适配重新迁移、重抽或重分析全部论文。过程与页面实现指纹变化须如实记录在本次审计，不能回填旧 `state`、完成回执或页面声明。当前发布 gate 直接记录作者核验 CLI 等已登记文件的字节，但未直接收录 `env-loader.js`；共享过程及页面依赖闭包包含该角色登记文件，须分别如实报告，不声称某指纹绑定了未收录文件。保留真实代码提交，且每次发布仍实际执行作者门。本例不扩大到 Reader、来源、词表或渲染变更，这些变更继续按各自正常迁移和内容资格处理。

生成清单逐路径核对类型、论文归属、来源内容 SHA、字节数及暂存清单 SHA，博客和图片集合都拒绝重复路径；不能把论文改标为导出文件来减少待审页面。研究引用导出仅允许 `citation.json`、`citation.bib`、`citation.ris` 和 `rethink-context.json` 四个文件，路径绑定日期及论文 ID 哈希，正式字节须由已核验分析冷重建一致。

Hugo 在隔离目录保留固定博客提交的完整物理旧来源，供站点模板读取原分类证明；当批单篇及汇总另复制到独立 contentDir 参加构建，避免无关旧页面占用本批构建资源。构建后仍逐一检查完整当批页面清单的 HTML，缺页即失败；不混入工作区未审页面，也不删除旧证明文件或跳过来源守卫。

`review` 要求博客检出目录带 Hugo 运行时（`hugo.yaml`/`hugo.yml`/`hugo.toml`/`hugo.json` 任一，加 `layouts`/`assets`/`themes` 任一）。缺运行时就没有可审查的渲染结果，`review` 直接报错，不产出任何审查凭证，也不会跳过正文和图片审查后伪造一份通过记录。审查协议指纹同样按实际算出；算不出来就报错，不替换成替代值。

正文分块通过结果另按路径、整页SHA、分块索引和块内容SHA精确保存与读取；同页后续分块失败后，重跑可复用此前已通过块。整页字节改变，即使某块正文相同也不借用该块记录；旧整页通过缓存继续保留。失败块不写通过记录，分块缓存不替代当前程序、图片、Hugo、来源和完整批次审查。

逐页通过证据只按相对路径和页面内容 SHA 复用。实现、模型、协议或批次记录变化后，未变页面保留通过依据，当前批次仍须重跑程序检查并生成新审查记录。图片子审查不能脱离整页身份或省略来源检查。

发布正文审查默认并发 5，先在这五个槽位中稳定派发汇总，再按论文原相对顺序补派；每页分块串行，最终整批记录恢复原 generation 顺序，不改变完整审查集合。`PD_BLOG_REVIEW_CONCURRENCY` 范围 1–5。程序只按空出的并发位置补派任务；正文、图片或 Markdown 的普通内容拒稿保存不可变失败审计后，继续审查其余页面，最后写整批 blocked 摘要并拒绝审查通过及推送。服务、存储、页面字节变化或凭证损坏停止补派，等待已经开始的审查结束，保留各页已保存的通过记录，再交回原错误。并发设为 1 时逐页顺序处理；同次审查不自动再请求失败页，正常修正后续审只复用已通过的页面或分块。

`push` 逐文件核验 Git 暂存区及提交内文件字节，核对本次允许变动的文件集合、父提交、推送身份和远端 OID，不只看工作区文件。博客与图床分别处理受控提交；图床完整资产清单和本次 Git 变动分开，相同已发布图片可零差异复用。自身提交后断网或重复发布，仅在父提交、文件集合、内容和远端身份精确一致时恢复。

### main 前移后的恢复

尚未发布的生成清单（`generation.json`）因日更或 UI 更新遇到 `main` 前移时，重新走正常 `generate → review → push`，不得手改清单、审查记录或直接重跑旧 push。generate 分别核对博客和图床的推送目标、`HEAD = 远端 main`，确认旧基线存在且是当前基线祖先，并逐提交检查所有会议目标，包括合并提交的父提交；即使最终字节恢复，中途删除、符号链接或文件模式变化仍会拒绝。

同一未发布 process 更新受控图片时，正常 `generate` 只替换旧合法 generation 与当前已核暂存中路径、`kind: asset` 和论文归属完全一致的图片。新源须匹配当前 SHA 和大小，目标须仍是旧清单的精确字节；先将旧字节不可变保存到本 process 的 `image-byte-history/<旧generationSHA>/<旧图片SHA>.png`，再在共享图片锁内复核目标身份及旧 SHA 后原子替换。目标已是本次新字节时直接复用；先备份后中断可继续同一备份。未知归属、人工改动、损坏备份或并发目标变化仍拒绝，不删除旧图、旧暂存页或无关文件；旧 generation 继续由原 superseded 机制保留。这是复制已核图片的恢复，不是新图片来源或分析权限。

通常要求当前提交中的会议目标仍与旧生成清单的精确字节相同；未被中间提交触及的目标可以保留旧基线内容或原本不存在。工作区目标必须路径安全、是普通单链接文件、权限为 `0644`，并与旧清单字节相同。现有代码另允许受控生成恢复：generate 已重验本次完整 process 和暂存来源，且工作区目标字节精确等于本次暂存来源 SHA 时，可以接受它与旧清单或中间提交中的字节不同，随后生成新的基线凭证。博客与图片均只接受这一精确字节对应关系；它不允许任意人工改动，也不放宽中途删除、可执行或符号链接模式变化、未知基线、非祖先历史替换及远端身份变化的检查。其他进程仍须遵守共享锁。

以上只允许 generate 重验来源和暂存结果后生成当前基线的清单，不修复损坏的来源或图片。被替换的未发布凭证先按原字节保存为 `superseded` 备份；review 可复用未变页面，但重跑当前基线的 Hugo 和程序检查，再签发当前审查记录。已有发布凭证保持不变；push 对允许变动的精确文件集合、父提交、暂存区、提交及远端的核验不变。

正文、图片或 Markdown 被拒绝时，具体 findings 保存为不可覆盖的 `data/runtime/conference-publications/page-review-failures/<failureSha256>.json`，绑定路径、内容 SHA、审查协议和阶段，异常给出文件路径。原意见及其修正建议逐字保留，但记录不是正文替换稿，不含图片字节，也不是通过缓存。必须先完成整批正常审查，再按下节统一安排正常 Reader 或出版视图恢复，不能逐页先精改或把审查意见直接当论文事实。修正后正常 generate/review；服务和账号异常保留原类型，不能当内容失败反复请求。

### 博客拒稿后的正常 Reader 维护

本入口用于尚未发布、原 process 全部 complete，但博客完整正常审查已有内容拒稿的会议。先等全页审查结算，再绑定当前 generation、完整 batch-failure、每条正式原失败及实际父包/source/PDF/CAS。不能只扫描在途失败目录挑一部分，也不能把原 process 或论文改成 partial 来套旧恢复许可。所有 text/content 进入正常维护；全部 markdown/content 必须明确分类：当前真实 Markdown gate 已通过且字节未变的记 gate-rule-revalidation 待正常新协议全页复审；否则共享 sanitize 投影经正常 Markdown gate 仍失败的送 `normal-reader`，可仅通过出版格式修复的记 `deferred-publication-format`，保留待新页审查，不能猜币种或豁免科学正文裸符号。全部 image/content 同样保留完整原 SHA，可先 `deferred-review` 交独立出版视图与正常复审，不能假称都是裁切或已修。

汇总页自己的内容拒稿不作为单篇 Reader 成员。清单用 `aggregateClassifications` 完整保留原 aggregate failure，固定 `deferred-aggregate-generation`、`pending-new-page-review` 和 `normal-aggregate-generation-then-normal-review`，交正常汇总重建及新页审查，不宣称原拒稿已修。已结算的 transient 另用 `nativeReviewClassifications` 完整保留原阶段及 failure，固定 `deferred-native-review`、待正常出版复审；不当作科学事实发送 Reader，缺失或尚未结算不能冒完整批次。单篇作者等来源问题须先正常修复，不能由汇总渲染器假补。

汇总作者来源拒稿可以用 `aggregatePaperFeedback` 绑定真实原失败、第几篇条目的完整 SHA、官方记录链接、作者名与同篇认证原文逐字窗口，交该真实单篇正常 Reader；原单篇通过记录及 summary 的 `paperId:null` 保留，不能伪造单篇失败。Loader 另核当前父包、真实作者 v2 解析确实改变对应机构，不能拿旧汇总或别篇机构移植。公共新 Reader/完整分析与独立作者刷新显式使用 `conference-pdf-author-lines-v2`，作者 identity 保存版本；旧无版本签名及旧发布冷核仍用原 v1，只刷新图片不改旧作者，零请求 operator 按原范围保留原作者字节。

正常 raw-review 维护只读绑定原已签最终 article/plan/figures 的明确 `conference-reader-final-parent-surface-v1` 合同与 SHA，不要求先把旧桥接段落逆算成模型原始草稿。真实来源、父包和全部签名仍核验；新 child 仍通过正常已核 seed 接口发出自己的请求。旧 corrective 节点模式保持严格 inverse，不能借此授人工节点权限、旧预算或新通过。

默认 `raw-review-findings-v1` 将真实原意见逐字交公共 Reader，并明确这是待核验意见；模型须对照认证全文与原图，仅改真实错误。无需先给每篇人工编写纠正事实。只有额外 `corrective-assertion-v1` 才要求既有节点旧 SHA、原句和真正相关逐字来源。实际反馈上限4000字符，不能默默截断或以无关引文冒证据。 Markdown 通用指导只对确属原文金额等字面美元符号建议闭合行内代码保真，不猜币种；数学仍用正常 TeX 分隔符，代码外或未闭合代码中的真正语法问题仍拒。

```bash
npm run conference:migrate-process -- --apply --catalog CATALOG.json --report REPORT.json --filter FILTER_UUID --from PROCESS_UUID --concurrency 5 --reader-review-feedback /absolute/process/review-reader-maintenance/BATCH_UUID/manifest.json
```

命令消费已经核验、安装到该 process 私有根的清单；没有公共 npm 清单生成器。执行者可用经过审查的 O 内只读准备工具读取正式材料、输出完整字节树与安装计划，不能把准备结果当正常通过或让工具直接安装/发模型。字段与不可变材料见[数据格式](data-format.md#会议博客审查后的-reader-维护记录)。CLI 和直接库调用均拒绝混入 `--retry-failed`、旧 `--recovery-manifest`、人工清单、来源纠正或 `--postprocess-only`。

正常维护只允许 Reader-only；原主文、核心、评分、标签及费用保护。原签稿 seed 在原父真实来源和签发上下文封存；新资源预检已进入子稿时，精简输入由私有父稿能力重新核验原父 seed，不把旧 Reader 当作与新资源匹配的完整子稿。能力绑定实际子运行、来源、修订、反馈与原父文件 SHA，普通 JSON 不能代替。已有付费候选须匹配唯一原输入显示身份；实现升级沿原恢复链迁移，保留响应、全文、传输及无进展计数。新稿的资源同步只正常检查投影和评分事实，不改原主文、解析、评分阶段及检查点；这项保留不禁止正常 Reader 请求。新 Reader 必须有本 child 的真实签发与反馈证明，不能用继承父 Reader 清义务。先完成整批正常一轮，再续真实失败集合；每篇成功立即保存，未全成功时旧 process complete 历史和父稿保持。服务、存储、身份故障停止派发并保留在途结果。

旧父稿仅因历史资源解析规则不再满足当前 Reader 校验时，先在其真实来源与 PDF 上下文中核验完整旧出版资格，再由私有作用域提供原签稿参考。该作用域绑定父包 CAS、正文、来源、反馈和执行身份，只服务新修订的输入；新 Reader 仍独立通过当前完整校验。普通有效父稿继续原 seed 路径。

维护子任务若在发请求前因旧参考或临时资源不可达停止，同一入口可恢复尚未签发的 pending 准备。必须仍是初始零代正文、零尝试、原五份准备文件，且没有修订凭证、seed、候选或请求；先核真实父参考，再持论文锁归档完整原包及失败。临时资源使模式变为评分＋Reader 时，只允许正常重探一次；确实恢复为 Reader-only 才以 CAS 更新未签发预检，并交正常修订入口继续。原失败不手填通过，已签定的模式及已消耗额度不适用。仍不可达则保留新快照与原阻断，不把旧 HTTP 200 当当前可用证明。

来源或核心曾被受控纠正的父稿，其原科学阶段可由同来源的 Reader-only 子稿继承。冷核逐字保护主文、摘要、评分、标签、原纠正定位器与阶段，回到真实原父包重放这些阶段；子稿自己的新 Reader、反馈和签发记录仍独立检查，不能把新正文冒作旧纠正稿，也不能借继承上下文请求网络。

独立 Reader 维护的轮次保存在其真实子运行中，不累计到旧 process 的重试差额；来源回投仍逐项核验这些子运行的完整失败历史和已登记维护绑定。采纳后的出版回投必须核对整条维护父链及实际采纳记录，并对当前子稿自身的 PDF、Reader 和完整资格重新检查，不能借祖先已通过的 Reader 授当前正文通过。

采纳后，当前指针已指向新稿，原科学父稿仍须在真实维护关系中读取。来源回投先只读核修订自哈希、父包 CAS、同源、登记与采纳材料，避免重建来源时递归加载 Reader；这份身份结果不授成功、调度或发布资格。完整加载仍正常重放反馈、seed、资源和新 Reader。原父科学阶段仅在已核维护绑定生成的进程内私有作用域中重放；普通父稿调用、复制 JSON 或已退出的作用域不能代替。正常后续暂存更新页面证明时，继续核验当前真实页面和原采纳关系，不把旧页面实现指纹锁成永久不变。

不可变批次材料首次仍完整解析；之后反复检查直接读取实际文件字节并重算 SHA，避免每篇反复解析全批 JSON。已完整加载的同一批次、同一采纳子稿，也只在三份文件 SHA 与当前指针证明完全相同时复用身份检查；新后代仍走完整加载。文件权限、单链接、大小和读取期间替换检查保留，不以修改时间或文件大小代替字节检查。额外的原科学父私有作用域仅用于真实采纳之后；采纳前正常 Reader 尝试与检查点推进沿用原路径。

当前状态、采纳后状态和采纳凭证各保留一个私有元数据快照，登记状态另保留一份，首次仍完整核验。只有实际文件字节 SHA 相同才复用解析及摘要检查；文件变化重新完整核验，分批身份变化不借用旧缓存。快照及其返回值深度冻结，避免调用者改内存污染后续检查；每次仍安全读取全部字节，并继续逐篇核验真实子稿、父链和来源，不缓存 Reader 通过资格。

来源身份回投在同一进程内最多复用8个已完整核验的批次元数据对象，避免每次新建对象使上述快照失效。缓存绑定规范根目录及真实 manifest、baseline 的文件字节 SHA；每次重新安全读取并核对全部字节，变化或检查失败即丢弃该项，淘汰后重新完整初始化。真实修订身份、成员、来源、父子文件 CAS、登记关系及当前采纳状态仍逐次核验；复用结果不能充当 Reader、许可、预算或发布通过凭证。

保留来源的旧完成凭证回投同样只读取普通修订的严格来源身份，覆盖当前稿及全部祖先，保留完整状态、成员证明、父稿 CAS、同源和 16 层防循环检查；恢复窗口仍核原完整许可。来源回投不重新签发旧 Reader，也不授予新正文通过，正常逐篇暂存、汇总和发布仍独立执行完整资格核验。

原父 Reader 经受控人工修正、之后又正常生成新 Reader 时，旧人工稿仍按原修正凭证、完整原稿、费用及来源重放；已核维护登记中的私有父稿能力将旧稿只读绑定到原基线成员，并在前后核对实际当前子稿与父包 CAS。该绑定只用于旧父稿回放，新 Reader 继续独立通过完整资格，不能把旧稿写回当前指针或为其增加模型次数。

Python 页面渲染传回的论文只允许原 canonical 或固定 `paper_id/arxivId` 身份适配。若其保留旧科学纠正定位器，出版桥仅沿已登记的真实 Reader 子链寻找完整匹配稿件，逐步核验原父 CAS 和同源关系；新 Reader 使用自己的 PDF 句柄和正文证明，旧科学纠正回执与评分身份保留。固定会议页面入口的外层期限为600秒，以容纳多个各有期限的本地来源冷核；认证来源纠正的资源展示和核心摘要阶段重放沿用180秒，普通资源展示和普通摘要重放仍为30秒，其它共享渲染入口仍限60秒。增加时间不授来源或表格通过，未知纠正声明仍走普通时限，调用者不能自行扩大。

首轮签名 Reader 已成功保存、随后仅因中性资源同步触发上游保护时，先走同一入口的零请求保存恢复。程序只接受真实预检和原父稿唯一决定的同步投影，保留原 Reader 和原阶段指纹，重建正常请求正文并精确匹配唯一真实请求、开始记录和接受记录；再通过正常来源、Reader 和整篇资格。保存前不可变归档原六份文件及费用绑定凭证，然后持原锁 CAS 完成，不增加或清零原次数。首次成功没有失败候选是正常情况，不能为此伪造原响应或重新从零计费；新实现的准备指纹单独记录，不冒称旧稿的原指纹。图片输入只允许已实现的零图或单张封存图路径；单图须由真实来源正常重渲染，逐字匹配原 PNG、模型图片预检及原请求正文，缺图或改图均拒。其它模式仍沿原恢复范围处理。

单窗固定最多3轮、Reader累计6次内容响应及2次全文。必要下一窗已获持续授权，绑定本独立维护批完整当前失败集合、唯一前窗、实际 child 请求/费用材料树和账本，不能重置旧计数或伪造原 process 失败：

```bash
npm run conference:migrate-process -- --apply --catalog CATALOG.json --report REPORT.json --filter FILTER_UUID --from PROCESS_UUID --concurrency 5 --reader-review-feedback /absolute/process/review-reader-maintenance/BATCH_UUID/manifest.json --reader-review-window /absolute/process/review-reader-maintenance/BATCH_UUID/windows/WINDOW_UUID/manifest.json
```

pending 由实际 state 定位器与私有目录共同核验；目录丢失不是无义务。生成、审查、推送均消费冷核门，普通迁移在任何 grant 安装及状态写入前也拒绝 pending，须用同一显式维护清单继续。全部新 child 的正常资格、冷核与 stage 通过后，才在真实锁与 CAS 下原子采纳，过程进入单篇完整、汇总待更新的 running，再正常全会 stage/aggregate。旧稿、原失败、旧清单和全部费用保留；不得补签 passed。

### 认证 PDF 的独立出版视图

正常 Reader 刷新仍使用原认证 source 的图像，重生成并不会自动恢复已裁掉的区域。对完整 image 失败集，可先统一从同篇认证 PDF 派生精确图，或用唯一印刷图号、完整图注和页码定位完整原页；原图注未完整抽取时，仅允许真实原 artifacts 物理/语义 SHA、原 ordinal/asset/caption/ref/page 与有效 DOM 严格匹配的选中图能力，重放同 PDF 原页及唯一印刷图号，完整图注保留 null，页面明示“图注未完整抽取，以原页为准”；这不授普通裁切、未知页码或非认证 ref 通过。完整页明确标示目标图及实际来源，审查只把其余内容当同页背景，不据此判错图。固定裁切规则不能覆盖的项须保持实际阻断，不接受自由矩形、猜补或删原图。

```bash
npm run conference:publish:generate -- --conference-id CONFERENCE_ID --process-id PROCESS_UUID --figure-crop-manifest /absolute/publication/figure-manifest.json --figure-crop-base-sha ORIGINAL_GENERATION_SEMANTIC_SHA
npm run conference:publish:review -- --conference-id CONFERENCE_ID --process-id PROCESS_UUID
```

两个派生参数只属于 generate。它仍先完整核原生 process bundle，再经固定 Node 禁网来源重放派生，原 raw stage/Reader/原模型像素和旧证明不变；新 PNG 与 raw→view 页面按内容地址另存。review/push 从 generation 的 `figurePublicationView` 重新核原 PDF、完整派生证明及实际页面/图片字节，不接受自行构造的 view JSON。

真实新页须正常多模态审查，换展示不消除原语义错误。完整页复审后仍有真实图文语义拒稿时，再以实际新失败和当前父稿正常 Reader 维护；同一坏 source crop 不应盲目多轮重付。反馈中的历史新视图先核真实 canonical 原批、原父/source 和当前真实后继，再由私有历史能力从同一 PDF 冷重放派生，并用原生纯变换逐字重算 raw→view；这只认证意见看过的历史材料，不授当前 publisher、新 Reader 或审查通过。新 Reader 若依赖原 crop 缺失的信息，须另核必要的真实来源输入，不能声称模型看过未送入的完整页。

Reader 更新后，旧派生父 CAS 不会自动获得 current 出版权限；最终展示继续按新实际父稿重新派生与正常审查。旧日更 SVG 的恢复输出字节及 `reader-sealed-pdf-page-asset-v1` proof 合同保持，会议出版证明不冒用日更身份。

维护冷核的来源文件按真实私有 PDF 句柄批量检查，每次只读取一遍共同引用的文件，仍检查完整字节、路径安全、大小策略和原 SHA。原失败集合、私有历史能力及实际当前状态另外照常检查，不能用文件观察清单替代。历史父包首次完整加载后，其不变守卫真实重读 intent、run、source、analysis 四份文件，并保护原成员和内存身份；当前子稿的完整加载和科学资格不省略。

固定历史出版视图的来源实现改变时，执行者可在生产停稳后调用维护库的 `revalidateMaintenancePublicationSources()`，参数为真实 `manifestPath`、`processDirectory`、`analysisRoot`。它取得原操作锁，禁止模型请求，核对归档六实现的真实 Git blob，并正常重算全部原 PDF 几何、像素及完整证明。只允许来源核验实现及新 proof 身份改变，原 PDF、显示目标、像素、URL 和原完整证明必须一致；新凭证另存，旧 generation、nodeDerivation、PNG、Reader 和费用均保留。普通 cold 入口只读重放，缺少当前合法凭证即阻断，不自行写入。来源重验记录明确引用原 outcome 和真正的当前 outcome，不授 Reader 完成、付费额度或最终发布资格；全部维护采纳后仍正常生成新 mixed view、审查和推送。

来源重验首次签发限于真实已核的 baseline 或 registered-state 原件，须在采纳前准备；不支持采纳后首次补签。凭证保留真实签发时的状态快照和原物理 SHA，私有签发者须独立核对其原件，不能只信凭证和快照自洽。后续合法采纳、实现迁移或汇总不改写该签发状态；每个新的 cold 调用必须由原完整当前批次及采纳后继链检查证明实际状态合法，再正常重放来源证明。同一次断言闭包内的当前状态仍须逐字不变；未知状态、断链后继、签发快照或证明漂移均拒绝。普通读取不自动续证或签发新状态。

### 自动验收覆盖什么

Hugo 和正文审查的页面集合只包含单篇及汇总 Markdown。研究工作区的四份 sidecar 不冒充 HTML 页，仍完整保留在 generation、review、Git 精确差异及线上字节验收集合中；例如本会 1355 个页面与 5416 份 sidecar 分别核对，不能以总文件数代替 HTML 页面数。

新 v2 发布在推送博客和图床后，自动 GET 已审页面和全部图片，通过后才保存发布完成记录。页面检查 HTTP 200、HTML 类型、最终 URL 与唯一正式地址一致，以及已审正文、图片顺序和表格单元格的对应关系；含公式时还检查数学脚本存在。图片检查 PNG 类型、实际字节 SHA 和可解码性，允许通过安全核验的重定向，不套用页面最终 URL 必须等于正式地址的条件。线上核验默认并发 4，`PD_CONFERENCE_ONLINE_VERIFY_CONCURRENCY` 范围 1–16。

GET 使用项目 HTTP CONNECT，逐跳核验公网地址并限制响应。全链共享 60 秒期限，响应最多 16 MiB；每一跳的瞬时传输最多尝试 6 次。HTTP 状态、哈希和 HTML 不匹配不作为瞬时故障重试。线上尚未符合时保留远端已经推送的事实，继续运行 `verify`，不要重新分析论文。

`status` 报告已保存的线上检查快照；显式 `verify` 会记录一次新的 intent/result 并重新 GET，最新 pending 或失败不能被旧通过掩盖。已有 publish 的重复 `push` 只读 status，不代替新的线上重验。旧 v1 发布通过单独的 `verification-v2.json` 补充核验，原记录字节保留。

读取已发布凭证时，不带 `contentReview` 的 v2 审查记录按旧格式识别：`conference-blog-review-v1` 的 version 2 中途增加过 `contentReview` 要求，早期代码写过不带的 v2 记录，自哈希、文件清单、`generationSha256` 和 HTML 检查的页面集合都对得上，是那段代码的合法输出文件。当前发布器给每个 v2 generation 都写 `contentReview`，缺字段不可能由当前代码产生，所以只在读取已发布凭证时按旧格式放行。新发布和待推送的凭证仍必须带一份通过的 `contentReview`；带 `contentReview` 但没通过、逐页记录不符、或 HTML 检查的页面集合不完整或不一致的记录一律拒绝。正文审查协议指纹绑定的是当时的审查代码、模型与 Hugo 运行时，读取已发布凭证时不要求历史批次协议等于当前指纹；待推送的批次协议仍须为当前值。按路径与 SHA 复用的逐页通过记录保留原独立协议和自哈希，不改签为新协议：跨协议复用须核验原 `conference-page-content-review-v1` 完整通过记录、自哈希、合法协议、精确路径及页面 SHA，并与原内容寻址通过缓存一致；缺失、篡改或仅有旧无签名字段的混合协议记录均拒绝。同协议旧 v2 凭证仍按其原格式识别。

这里的 complete 范围是 `mechanical-html+remote-oid+online-urls`。该验收不查询 GitHub Pages workflow 的 build/deploy，不另查页面标题，也不执行浏览器中的 MathJax/KaTeX 或人工看图。对用户宣告上线前，还须确认部署对应发布提交或保留已审字节的后续提交，核对全部目标页面的正式地址和标题，并保留部署及页面核验记录。需要的事实、浏览器和视觉审查也须按任务完成；不能把机器字段或模型通过当作这些工作已经完成。

## 不同层次的并发与重试

| 层次 | 默认与范围 | 注意事项 |
|---|---|---|
| 官方 PDF 下载 | 并发 1，可设 1–5；网络重试 0，可设 0–5 | 仅 download 使用；固定同一官方 URL |
| 会议筛选 | 同一 filterId 只有一个 worker | 不把多会议并行建议当成同任务并发许可 |
| 独立 process | 并发 1，可设 1–60 | 每篇内部为 1，仍受共享阶段槽位和原窗口约束 |
| 实现迁移 | 并发 3，可设 1–60 | 先核原状态，不因迁移增加模型预算 |
| 队列项 | 并发 3，范围 1–3 | 与独立 process 的范围不同 |
| 页面审查 | 并发 5，范围 1–5 | 优先派汇总、论文保持相对顺序；普通拒稿保存后继续其余页，运行级故障停止补派 |
| 线上核验 | 并发 4，范围 1–16 | 不重新分析未能访问的页面 |

批次总轮次、单阶段尝试、process 窗口和子运行预算分别核验，任一耗尽都不由并发设置解除。详细公共规则见[全批轮次与失败集合](three-workflows.md#全批轮次与失败集合)。

## 队列、恢复与升级

### 已有完整会议只更新页面

显式 `--retry-failed` 恢复中，已有 `normal-analysis` 子运行的核心摘要阶段被拒、且原外层轮次仍有余额时，适配器调用公共核心摘要的原付费响应重验。程序按本次真实来源、正文、证据、Prompt 和阶段身份重算完整身份，只选唯一最新的同身份原请求，再核验其请求、响应和处理记录。独立追加窗口的后续恢复同样传递该开关，使用当前新窗口自己的执行、来源及原付费诊断；首次创建时对原失败稿做的 seed 重验，不能代替新窗口后来产生的响应。较早网络失败不替代最新请求；最新缺链或仍不合格时不回退挑旧稿、不追加三次摘要请求。原十二节与付费记录保留，后续评分与 Reader 仍按原正常资格和额度继续。默认日更、历史及首次会议分析不启用此索引，原外层已耗尽的子运行不能借此绕过预算。

排版和多级分类更新先盘点原 process、筛选和来源身份、全成员状态、单篇与汇总暂存证明，以及同一 process 是否已有 `publish.json`。只读复用仍通过正常资格检查的原分析、Reader、评分、分类和费用，不从获取、筛选或模型分析阶段重跑全会。单篇和汇总必须一起覆盖原完整入选集合；目录的候选总数不等于正式入选数。

原实现过期时，用下文的 `conference:migrate-process` 在原 UUID 上重验并重暂存已完成单篇，随后由原 process 重建完整汇总。来源计划按原凭证 SHA 从集中归档只读核验当时词表，不改写原 plan、receipt、run 或 authority；这只证明原来源和执行计划可溯源，不授予旧分类当前出版资格，也不要求当时词表与当前词表一定为纯追加关系。

已完成会议的原标签阶段另按原词表、原提示文本、检查点、绑定及真实历史升级链完整只读核验；当前暂存再按386项词表重解析分类，主任务、主方法及概念 ID 须与原记录一致，不合格项进入分类复核或完整性阻断，不能补签旧记录。这份已完成会议的发布资格只供页面后处理，不用于默认分析调度的成功或跳过判定。其他既有分类签名的当前词表兼容仍须满足原严格纯追加条件；来源计划恢复和会议发布回放均不放宽该全局规则。默认迁移在原集合包含未完成项时可能继续模型分析，执行前须核对状态和原预算；显式 `--postprocess-only` 则完成来源重放、全体完成稿的正常后处理、状态与迁移凭证后返回，禁止阶段模型请求，不进入分析派发、重试放行、聚合或发布。

普通迁移及 `--postprocess-only` 在调度前正常采纳已保存完成、但尚未进入 process 的普通修订或追加子稿，不受原 process 重试次数耗尽的过滤影响。普通子稿必须由当前完整父稿的真实物理SHA唯一派生，不能凭继承父稿或文件名声称完成。程序持原操作锁及论文锁，硬禁模型，重放实际许可、原父稿及认证来源，由正常单页暂存完成整篇资格与 PDF 证据冷核，再核对分析、完成回执、来源和页面 SHA。完整旧失败项先写不可变采纳回执，然后在进程 CAS 一致时更新本篇证明及当前状态；原次数、重试释放历史、批次失败历史与费用不变。完成子稿冷核失败保留原失败并报告，不能借机请求模型或登记新额度。确认采纳后，以新的停稳状态和完整实际剩余失败集合准备下一窗口。

保存子稿仍为partial时，适配器的 `replaySavedConferenceReaderRevision()` 只恢复原已付且唯一可认证的Reader候选，复用原正常恢复和完整资格路径。它仅读取已经存在的修订，不准备新子稿、预检或许可，持论文锁且硬禁模型；未合格时在任何尝试、失败和费用写入之前返回，原文件逐字不变。合格时正常保存和封存真实完成子稿，外层再核实际完整状态及页面后采纳。普通Reader-only或已有评分检查点的评分＋Reader可复用原活动候选；不支持的正常分析中断仍保持原阻断，不能借旧父正文补主文或重签科学阶段。

同一失败集合可包含首次需要维护的完成稿与尚未采纳的追加窗口稿。普通重试逐篇核对最后真实登记：仍指向该许可原父稿的成员继续唯一最新窗口，复用原释放记录和原外层预算；已经正式采纳的完成子稿再次遇到当前检查失败时，严格核对其分析、来源及完成回执后，以这份当前完整稿作为新维护父稿。不能回到祖父稿，也不能因混合调度追加无许可释放或重置原窗口次数。

本地来源纠正稿的来源投影与正文发布资格分别核验。来源投影冷读真实纠正事务、原包、来源、页面身份和受控调度历史，返回固定来源祖先，不创建分析或 Reader 权限；正文失败由正常全批后处理报告。若原整包纠正合同不能独立继承科学阶段，普通恢复在真实计划中建立完整分析子稿，保留原父包并使用新论文基础记录，不复制旧纠正标记或旧阶段。新稿的来源沿真实修订父 CAS 回溯原纠正祖先，旧采纳记录只作来源锚点，不能冒充新稿的纠正声明；最终出版仍进行完整冷核。

没有已发布凭证的 process，在迁移或正常恢复完成后依次执行本节 `generate → review → push → verify`；已有旧 `generation.json` 时由正常 generate 处理实现变化和基线前移，保留 superseded 记录。**已有 `publish.json` 的 process 受不可变发布保护，重复 generate/push 只返回已发布状态，不会用新模板改写博客。** 此时按[历史更新与发布](#与全历史重写的衔接)维护已有 URL，不能删除旧发布凭证或把实现迁移当成重发布授权。

已完整完成的来源升级进程可能混合多套原计划与抽取版本。迁移和普通续跑按每篇原分析绑定的计划凭证，重放原筛选、暂存、导入、计划、抽取及缓存来源，再在单篇和汇总中使用该篇真实的原计划句柄；不能用一份新计划替代全部旧来源，也不能开启 `trustEvidence` 跳过检查。若旧维护只改过计划中的词表元数据，只有恢复该字段后全部原字节的 SHA 精确等于原凭证，才在系统临时目录恢复并正常核验，随后清理；现有计划和原分析不动。这个只读路径以原全成员完成凭证为依据；迁移中断后须验证每篇受控修订与原完成记录的连续关系。

已完成稿不再通过当前检查时，迁移先对全体执行正常后处理并收集完整失败集合，不在首个失败处停下；逐篇边界响应停止信号，并定期报告实际通过和失败数量。未传 `--retry-failed` 时只报告该集合，不为这些旧完成稿发起修订请求；确认需要正常恢复的任务在同一迁移命令增加 `--retry-failed`。恢复复用公共失败轮次调度，保留原父运行和付费稿的精确字节，创建绑定同一真实来源的子运行；每篇成功即时持锁更新状态，后续轮次仅继续失败集合。核心分析、原标签及模型输入仍可重放时，先正常核验资源身份并封存预检：资源字段不变则只刷新 Reader，资源状态影响原评分时复用公共评分＋Reader 刷新，不能先支付 Reader 再因评分绑定失败返工。原预检、恢复模式和总轮预算绑定子运行，中断后不得重置。旧输入清洗已损坏 Unicode 或上游不合格时走公共完整分析，不能用 Reader 刷新掩盖。来源、预算及运行级故障仍按正常规则停止；末尾少数持续失败才交受控人工修正，不能手填通过。

Reader 恢复的上游预检须从已认证的会议来源作用域取得全文，核对本篇身份、正式来源 SHA 和来源获取阶段 SHA，再以该全文重放核心摘要。Node 暂存与 Python 展示也核对同一全文；缺失、错配或仅有参数编号的伪结果不能先取得 Reader-only 路线。这项预检不改变已有子运行绑定的模式或原预算，不因规则修复重新签发付费次数；来源结果识别及资源概念的共用规则见[Reader 说明](reader-writing.md#核心摘要的结果与方法衔接)。

已有固定 Reader 模式的未完成子稿，若本次预检发现需要完整分析，先保留已保存完成稿和原付费候选的零请求恢复机会；仍未完成且子稿核心语义或原 Unicode 输入确实不合格时，在增加尝试或请求模型前阻断。不能自动切换模式或重开额度。核心合法而评分待恢复的评分＋Reader 子稿，继续原评分检查点流程，不因尚缺评分绑定而提前拒绝。

旧表格仅缺表头单位或设置引文时，出版复核可从同一封存 PDF 派生有界、唯一、逐字可重放的原文证据。该临时证据绑定原计划、原抽取、Reader 及本表字节，跨语言渲染会重新核验真实文件链与 PDF；不改旧绑定或签名，也不授予普通分析成功或跳过资格。无充分原文、含否定或假设的设置，以及不当资源开放声明继续失败。

评分＋Reader 恢复在评分通过后、请求 Reader 前即时保存真实评分检查点。Reader 失败或进程中断后，重入须在同一认证计划、PDF 和全文作用域中核验检查点中的来源、资源身份、正文和评分 SHA；通过后只续 Reader，不重复付已完成评分。检查须在计次及新请求之前完成，不能因为恢复时丢失来源上下文而重付评分。固定恢复模式和总轮预算不因此改变，检查点不一致须阻断，不能改哈希硬接续。

若本子运行没有新评分检查点，且失败历史已有记录，恢复须在新增轮次、资源或评分请求前停止。正文中继承的父稿 `scoringAudit: complete` 只证明旧评分，不能证明本次刷新完成，更不能因显式外层重试再开三次评分。最后错误即使是可重试传输失败，也可能已消耗此前的内容响应；缺少可持久重放的消耗记录时，保守阻断跨外层重开。单次逻辑请求内部的正常传输重试及合法的评分漂移一致性复核仍按原机制执行。缺失原响应时如实保留，不能按错误字符串推测并改签审计。真实新评分检查点已通过同源核验时，仍可独立续跑 Reader。

会议页面对评分稳定性的判断须与公共分析引擎一致：既接受原两轮共识，也接受具有完整证明的多轮共识。多轮记录须保留第三次分数及有效尝试数、原审计 SHA、最终采用的审计与分数，以及可重算的分差；缺项、非有限数值或对应关系不符仍拒绝。页面校验不能因不认识已签发的共识类型而要求重新评分，也不能只凭共识名称放行。

新 Reader 的资源声明资格需要真实全文上下文。适配器在正常计划与封存来源核验之后，用同一会议来源上下文核验新稿、已保存稿及冷启动后处理；不能因为离开模型调用就丢失来源，也不能用调用者任意传入的文本替代认证来源。若稿件已经保存、仅最终接口检查失败，续跑须在增加尝试或发送模型请求前先复验；完整资格通过后正常保存、封存完成凭证与暂存页面，原失败历史、已用次数和费用仍保留。种子父稿、存在未完成修复义务或来源不符的记录不能借此跳过恢复。

正常 Reader 的 PDF 表格单位证明与旧完整稿出版补证分开准入。只有实际计划和封存来源程序产生的私有 PDF 能力，才可为当前 `source_quotes` 表派生 `authenticatedPdfTableEvidence`：唯一连续原表范围内的表头或明确表注、行标签、指标列及数值都须对应，证明绑定原 PDF、来源与当前表格 SHA，并在生成、恢复、暂存和发布冷核中重放。`tables=[]` 仍表示没有 DOM 表，不能为此伪造 HTML 单元格或原 TeX。原表未声明单位、重复指标列或无法唯一映射的转置继续失败；已有完整旧稿的补证入口仍保留原完成状态及整篇 Reader SHA 约束。

候选恢复按当前认证来源选择真实论文身份：会议使用规范会议 ID，日更使用 arXiv ID，历史直改使用其已核验的实际路线；不能把会议编号放进 `arxivId`。来源上下文缺失、跨论文或跨路线时停止。会议正常恢复禁止因实现变化新增付费修复许可，原合法未消费许可只按原完整链核验和转交，原请求、无进展与费用记录不清零。

process 的重试窗口和子运行固定轮次是两个上限；任一实际耗尽都须报告，`--retry-failed` 不会重开子运行额度。达到上限后仍可仅重验已经付费的真实候选：当前只接受末次常规局部修复请求与响应能逐字重放成该候选、且唯一对应真实成功用量记录的闭合链。安全复制同源候选到私有临时目录，复用正常恢复器，并通过独立异步作用域在模型请求前硬拒绝新调用；正常完整资格、受保护上游和原文件 SHA 均通过后才保存结果。候选缺失、没有正文、付费链不完整或仍需修复时保留原阻断，不增加付费轮次。这条零请求恢复还须逐字保留原主文、评分阶段和检查点。当前资源身份仍按真实来源重核；仅涉及资源说明的确定性投影，须通过原同步器的来源、代码／模型／数据集标记、评分及 Reader 完整检查，但不将投影写回原上游或重绑原评分。该保留模式自身也禁止新模型请求，普通资源同步的默认行为不变。服务故障停止新派发并保存每篇结果，后续停止信号不能覆盖最初的实际故障原因。

正常完整分析中的核心摘要修复也使用共享修复器。会议诊断记录绑定规范会议 ID、当前认证执行、同一封存全文及结构化来源 SHA，保存在该执行内按完整身份哈希隔离的目录；恢复付费响应仍检查原请求身份和完整摘要质量。历史直改按自己的真实运行、路线与来源凭证隔离诊断，支持保留的会议 PDF 和当次 arXiv 来源。普通日更继续使用原 arXiv 命名空间，不为会议编造 arXiv ID，也不放宽正文、来源或修复预算检查。

旧活跃候选遇到 Prompt 升级时，零请求恢复按原合同和登记路径从 Git 读取原字节，核对整文件及首围栏模板 SHA。仅在唯一原付费请求、响应、用量与同源候选完整闭合后，私有异步范围才向公共 Reader 提供原声明；正常解析、收尾及整篇资格始终硬禁模型，并使用认证来源程序产生的真实 PDF 能力。普通新请求仍用当前模板；调用方 JSON、手填 SHA 或伪造完成状态不能获得该范围。原输入、模型或预算不符时保留阻断，不能用旧声明掩盖真实变化；通过后保留真实旧 Prompt 与请求策略声明，不将原稿标为新版生成。

追加会议窗口的真实用量 `runId` 属于已登记的 grant。费用重放先从不透明登记能力取得该身份，再逐项核对候选的 grant ID/SHA、论文、执行、来源及原父/失败稿 SHA；不按日更 `freshAnalysis` 或空值匹配会议费用。没有真实登记的候选 JSON 不能声明 grant，错误费用归属或混入日更身份仍拒绝。原非追加窗口路线保持原身份检查。

共性检查修复后，尚无任何子运行路径的失败项会先按同一原计划、来源和完成凭证正常重验父稿；通过即可复用原分析证明并更新暂存页，不发送模型请求。只要子运行路径已经存在，就继续原子运行与其失败义务，不回退父稿。目录权限、来源身份及运行级错误不能当作普通内容失败吞掉。

两处新版资源正文协议声明均不存在的旧 v1 记录，按原网址、引文、身份和状态只读核验；新版协议只声明一处、版本未知或混用时，不能伪装成旧记录。当前出版仍使用同一封存全文重放资源分类和正文的实际声明，单篇与汇总使用临时的当前展示视图，不改签原资源记录；只能证明论文列有项目链接时，显示“论文所列链接”，不能借旧 `dataset` 或 `code` 类型声称作者已开放资源。真实不当声明继续阻断出版。

重生成前保护工作区已有目标修改。已归属于原未发布生成清单的目标，在原清单自哈希、远端基线、工作区和完整页面成员核验后，只接受与原清单或当前暂存来源精确一致的字节；其余目标不能靠自称中断结果覆盖。不一致时先查明来源，不能手工清空。实现迁移改变完成凭证时，正常 generate 重验本次完整 process 并保留被替换清单的 superseded 原字节。新生成清单、审查和推送继续绑定同步后的博客与图床 `main`；最终还须核对对应部署、全部单篇及汇总的正式地址和标题。

### 顺序处理已筛选会议

队列使用 `conference-queue-plan-v1` 计划，按数组顺序完成一个会议的 `process → generate → review → push → verify`，再进入下一个。每项指定原 catalog/report/filter：

```json
{
  "contract": "conference-queue-plan-v1",
  "version": 1,
  "conferences": [
    {
      "conferenceId": "acl-2026",
      "catalogName": "acl-2026.json",
      "reportName": "acl-2026-report.json",
      "filterId": "a144e9b3-e014-4f21-a42a-c260c54385b1",
      "concurrency": 3
    }
  ]
}
```

```bash
npm run conference:queue -- --dry-run --plan /absolute/path/plan.json
npm run conference:queue -- --status --plan /absolute/path/plan.json
npm run conference:queue -- --apply --plan /absolute/path/plan.json
```

队列项 `concurrency` 默认 3、范围 1–3；独立 process 的默认 1、范围 1–60 是另一层配置，不能互换。队列发现已发布会议也会进入真实 verify，不仅凭旧发布回执跳过当前线上检查。

阶段抛错或 process 存活状态不明时，队列暂停后续会议，并保留已保存的阶段进度、错误和各阶段结果。只有确认故障解除，才在 `--apply` 命令中显式加 `--retry-failed` 释放暂停和重试条件。普通恢复不清空错误依据，不重新分析完成项，也不能为了显示完成手改状态。

process 会将余额、认证、限流、配置及被分类为系统传输故障的错误记为 `batchFailure`，停止领取后续论文，等待已经开始的论文处理结束并保存各自结果；已保存记录保留。单篇 Demo 瞬时故障、部分带类型的网络错误和待处理标签不等于系统失败。同次调用的正常失败轮使用剩余尝试窗口，不追加恢复 epoch；跨调用仍保留原3次窗口和15分钟退避，未开始的新成员与已通过的结果不被失败项阻塞首轮。`--retry-failed` 仍是跨调用解除原失败窗口条件的显式选项，记录释放依据而不删除原尝试、失败稿或费用；它不能被普通轮次自动加上。中断留下的 analyzing 不自动重发，须明确处理。筛选和 Python 发布审查的不同派发边界见各自章节。

### 实现变化后的显式迁移

process 的实现指纹来自固定清单，覆盖共享引擎、深度分析、来源核验与来源上下文、JS/Python 论文身份、Reader 修复及表格和资源处理、会议暂存及渲染，以及实际分析、Reader、评分、开源扫描和修复提示词。来源核验那一组是 `conference-source-ledger.js`、`conference-importer.js`、`conference-extraction-receipt.js`、`conference-pdf-source.js` 和 `conference-source-context.js`；它们只进当前指纹，不写进 v1 冻结清单，所以旧记录仍按当时那份清单复算。

已有进展的任务遇到实现变化时，普通 process 会要求显式迁移，不会静默另建 UUID 并整会重新计费。只有旧任务全为 pending、尝试为 0 且没有来源、分析或页面证明时，才允许新实现建立另一命名空间，旧检查点仍保留。多个已进展任务身份相符却有歧义时停止，不能任意选一个。

```bash
npm run conference:migrate-process -- --apply \
  --catalog C.json --report R.json --filter FILTER_UUID --from PROCESS_UUID \
  --concurrency 3
```

迁移默认并发 3、范围 1–60，重新核验原来源和固定成员。完成论文先由当前后处理重新生成并核验暂存页，不重新请求模型；未完成论文仍可能继续分析。迁移继续原 UUID 和记录格式，保留原词表身份及已发生的尝试。`--reuse-complete-pages` 另要求重新核验后的页面路径及内容 SHA 不变。需要解除失败限制时可显式加 `--retry-failed`，迁移记录和原来源依据保留。迁移实现与升级来源是不同操作。

完成稿重暂存和完整汇总默认按同一 `--concurrency` 使用最多5个私有工作线程。迁移可另传 `--postprocess-concurrency 1–5`，例如 `--concurrency 1 --postprocess-concurrency 5`，只给这两个硬禁模型的阶段单独设置并发；省略后者时保持原行为，Reader/分析调度、阶段上限、次数和费用不变。各线程执行原 `stagePaper` 的来源、Reader、评分、分类和页面检查，同步解析与Python渲染由真实独立线程并行；从实际状态、原计划、认证PDF及登记许可重建自己的不透明能力，不把JSON当授权。主线程独持进程操作锁，重新核验实际页面、资产及原包字节，整批后只做一次状态CAS。普通单篇失败继续收集；来源、存储等运行级故障或停止信号禁止补派并等待在途结果保存。

普通 Reader 拒稿维护的单篇同步操作还合并同一真实闭包的重复历史材料断言，覆盖初始化观察、公共 `loadConferenceReaderRevision`、正常 `loadChild`、`stagePaper` 和 `loadStageAndCompleted`。已付候选恢复在锁前、锁内和后续的完整修订读取各自进入同步范围，不能把整个异步恢复包进一个范围。每个断言首次及退出前仍执行完整原字节核验；当前子稿、父稿、修订、种子和预检另核实际 SHA，写入前核对当前暂存树与全部历史材料路径不相交。原完整 loader、Reader/来源资格、渲染和页面/资产字节检查均照常执行，最终核验失败不得返回成功证明或保存成功进度。此作用域仅限同一真实普通子稿的同步段；异步恢复、下一篇、费用请求和保存不在其中，窗口、非维护及非规范路径显式暂停作用域后走原路。它不缓存资格、不改变已签来源或预算，也不在不同进程之间传递。

私有池只对真实固定本地子进程的 `ETIMEDOUT` 提供一次恢复：核验项目 Python 包装器、三个认证 PDF 提取器或会议页面渲染器的实际调用形态与程序 SHA，保留原超时后继续全部首轮。首轮线程全部退出后，仅超时集合在一个新线程中逐篇正常重试一次；复用同一不可变状态及来源，每篇仍持原锁、禁止模型。成功项保留，最终回调每篇仅一次，第二次超时正常失败且不递归。来源、存储、网络、认证、模型错误不扩大为本地超时；停止时不派发重试并保留原失败。此规则也适用于汇总的正常只读页面复核，不授予完成资格、不增加分析次数或费用。

只有资源脚注证明、没有认证表格的普通完成稿，也必须在冷资格与后续渲染中保留原计划核验返回的真实PDF能力；不能因表格集合为空而丢掉脚注来源作用域。来源归属、原证明执行身份与实际可达状态仍各自核验，不复制跨执行证明或修改旧身份。

### 原额度耗尽后的独立付费恢复

用户已持续授权为效率和效果所需的全部必要付费轮，见 [AGENTS.md](../AGENTS.md#持续授权以效率和效果为准)。执行者根据完整失败集合准备、核验并登记后续恢复窗口，无需再次向用户逐轮确认。`--retry-failed`、实现升级和文档修改本身不会在机器账本里安装新增请求额度；需要新增额度时，执行者在已有授权下完成对应登记或必要的实现修正。

```bash
npm run conference:migrate-process -- --apply \
  --catalog C.json --report R.json --filter FILTER_UUID --from PROCESS_UUID \
  --retry-failed --recovery-manifest /absolute/path/authorized-recovery.json \
  --concurrency 3
```

当前 `conference-recovery-grant-v1` 的单个窗口固定为最多 3 轮，每篇 Reader 跨全部新轮累计最多 6 次内容响应，其中完整长文最多 2 次；传输尝试上限为 2。不是每轮重新分配 6 次，也不是任务的总付费授权上限。清单须引用真实持续授权、原 process 基线文件 SHA、完整失败集合、每篇原完成父稿与失败子稿及候选的文件 CAS、全文与来源快照 SHA。它不适用于新来源、新成员或日更四源清单。

首次执行在 process 操作锁内核验并登记到 `data/runtime/conference-recovery-grants/<grantId>/`，不可变保存清单、原基线和最后写入的登记回执。运行能力只能由完整登记核验取得；把 JSON 对象传给内部调用不能授予机器额度。中断后使用同一绝对清单路径、同一 grantId 继续，不换 UUID、改额度或重新释放三轮窗口。这些凭证落实已有任务授权，不要求每份清单再次请用户批准。

每篇新建由原失败稿和 grantId 确定的独立子运行。原父稿、原失败稿、旧候选、失败次数、连续失败及费用均保留；新增窗口另记轮次、Reader 请求、原响应和费用。新窗口的连续失败从本窗口开始累计，仍受正常停止规则限制。请求前持久化预留；中断时保守保留未结请求占额。请求原账、响应或账本缺失、身份漂移及旧文件 CAS 改变都阻断，不能删账重开。

恢复仍调用公共分析引擎。原已通过评分检查点先在真实旧来源中核验，再绑定新窗口复用；Reader-only 保留原上游，只有旧主分析或核心确实不合格才进入正常完整分析。完整分析模式的未完成子稿可能尚无标签阶段，或正文已变化而旧标签阶段失配：入口先在真实来源下确定模式，只以已绑定的原完成父稿重放原词表规则，不要求未完成子稿预先具有完成标签证明；Reader-only 和评分＋Reader 仍核验子稿自己的原标签。最终新稿必须以自身正常标签阶段重新通过原词表溯源、当前目录和整篇资格，父稿证明不能充当新稿通过依据。

会议正常分析已返回正文、但最终整篇资格仍拒绝时，公共引擎仅在真实会议异步来源上下文、认证 PDF 来源能力、当前执行和全文及结构化来源 SHA 全部一致后，保留本次返回正文及实际捕获的阶段检查点，供正常续跑；状态仍为失败，不能把 `complete` 阶段标签当作最终资格。此保存只作用于当前真实返回，不从原完成父稿填正文，也不为已丢失的旧检查点补建历史。

必要阶段沿用既有阶段上限，不把 Reader 的 6 次当作摘要或评分的新上限。先完成整批正常一轮，再仅续可重试失败集合；来源、认证、配额或保存故障停止新派发。共性规则修复后使用同一窗口续跑，原活动候选先完整重验，通过时不再请求模型；正常外层尝试仍累积，不能把前置检查失败从历史中删除。

当前窗口耗尽后，由执行者按真实进展选择下一步：能复用原稿则正常复验，少量明确事实问题可来源绑定修正，确需新付费则在持续授权下登记后续窗口，不再询问。后续清单沿用 `contract: conference-recovery-grant-v1`，显式使用 `version: 2`；每个成员的 `parentExecutionId` 仍指向真实原完成父稿，`childExecutionId` 必须是前许可为该篇唯一派生的最新失败窗口，不能重选最早失败稿。先正常采纳已完成而尚未进入 process 的子稿，再以停稳状态的物理 SHA 和完整剩余失败集合登记，不能从尚含完成待采纳项的失败集合中挑子集。

每个 v2 成员必须附 `continuation: {contract: "conference-recovery-window-continuation-v1", grantId, grantSha256, materialsSha256, ledgerFileSha256}`。其中 grant 字段属于前许可；`materialsSha256` 由 `recoveryWindowMaterials(analysisRoot, childExecutionId)` 对前窗口全部原文件计算，覆盖账本、原请求响应、活跃及退休候选、迁移和诊断、资产；`ledgerFileSha256` 是前 Reader 账本的物理 SHA，确无 Reader 账时才为 `null`。常规 `recordCAS` 仍绑定原完成父稿与最新失败稿。登记核对原 process 最后实际派发的许可，拒绝同一最新失败的平行新增登记、在途请求、材料缺失或变化；旧 v1 不接受延续字段，已有追加历史不能再用 v1 回退到旧失败稿。

实际剩余集合同时包含普通修订失败和原追加窗口失败时，使用显式 `version: 3`，仍精确覆盖整个停稳失败集合，不拆成两份许可。每个成员必须明确带 `continuation`：延续项使用上述原严格对象；初次项写 `null`，并以 `initialMaterialsSha256` 绑定该普通失败子运行的完整材料树。初次项须是当前完整父稿按物理SHA派生、已有真实失败轮次的唯一普通修订，不能把旧grant窗口或未派发准备态冒充普通失败。有旧许可历史时，当前父稿必须是已真实采纳的完成grant子稿，分析、来源、完成凭证和原修订记录全部对应；不能回退祖父稿。v1/v2的历史含义及额度不变，v3不新增调度入口，仍由同一不透明登记能力恢复、独立记账并阻止平行授窗。

执行命令仍为同一 `--retry-failed --recovery-manifest`。新窗口拥有独立的 3 轮及 Reader 6/2/传输2账，不修改前窗口任何计数、连续失败、候选、阶段或费用；重启恢复同一新 UUID，不再次授额。种子逐字保留最新失败稿，成功评分检查点须按最新执行重新严格核验，评分失败或空主文不能借原父稿评分冒充完成。缺少真实检查点时走获准的正常分析；已经遗失的旧付费响应或中间检查点不能补造。冷热加载逐层重放前许可、原完整父稿及来源链，并在任何新请求前用真实 PDF 能力核验前窗口原请求账；延续链最多16层，不产生发布资格。没有进展时先查明原因、调整恢复方法，不在相同无效条件下重复购买响应。

正常分析模式从第二次子运行尝试开始，先读取旧失败阶段并与 `readerRevisionProgress.blockedAuxiliaryModelStages` 取并集，在调用引擎前持久保存。主分析、资源扫描、正文修订、表格/方法/结构修复、标签、核心摘要、评分和补图中曾保存失败的阶段，只允许纯检查或原付费输出重验，不能重开内部请求循环。禁令通过异步作用域同时覆盖公共请求路由与分析器自定义请求入口；未识别阶段不允许绕过。后续纯检查改变阶段状态时，原禁令仍保留，缺失或异常记录不能清空禁令；此机制不替代逐阶段预算，也不扩大其他阶段额度。

新稿完成、重启后的后处理及发布核验，都从不可变登记与真实来源重建同一 Reader 身份；只读冷核强制禁止模型请求。最终仍须通过完整分析、Reader、评分、标签、生成、审查、推送、部署及全页核验，新增许可本身不是发布凭证。

认证 PDF 的层级表补证由 `reader_authenticated_pdf_hierarchical_table.py` 重读原文件：先证明完整表边界、原字形、列组/叶表头、条件带及全部原数据行，再唯一映射展示子集。带单位的展示列必须逐字对应原指标路径，单位仅可来自本列或同表明确指标表注；未注明单位的列保持未注明。原平面表已经通过时继续使用原证明字段，不改写成功记录。

认证 PDF 的资源脚注由 `reader_authenticated_pdf_footnote_evidence.py` 独立重建同栏作者声明、附着的上标编号及同页唯一同号网址。新条目保存 `authenticatedPdfFootnoteEvidence`，冷核重新读取同一计划/PDF 并逐项比对。提取器不接收人工坐标或作者归属声明；可达状态仍沿原安全 URL 核验。已保存身份的纠正提案保留原 URL、重定向、HTTP 及可达状态记录，只提供可重放的来源事实变化，不授权换原预检、切换固定恢复模式、复用不匹配评分或扩大任何预算。

只读检查旧签 Reader 可使用 `conference-reader-signed-draft.inspectConferenceSignedReader`。它核验真实完整父包、原输出 SHA 和同一计划/PDF，逐项报告精确往返、纯格式差异或阻断；来源引文、绑定或资源身份变化仍为阻断。底层纯逆算只恢复表示，不产生原始付费响应、人工修改许可或整篇资格；日更入口仍保留原封存来源及精确往返限制。

标签正常阶段可确定性删除已选具体标签对应的冗余补充祖先：原主标签不变，不增加或更换概念，删后仍须满足完整标签合同及 3–5 个标签。只在当前唯一语义错误为父子重复、机器摘要主标签和四行标签区完全一致时启用；恰好一对独占围栏包住严格四行时可同时移除这层包装。其它错误、主标签祖先或已绑定来源反馈不能借此改选。保存原标签区全部字节、输入输出 SHA、词表、祖先链和旧失败阶段快照，再正常签发标签阶段并继续核心、评分和 Reader；已保存的模型请求禁令仍保留。

### 最后失败集合的零请求 Reader 修正

认证PDF表格补证保留既有成功路径及证明字节。只有旧路径不能闭合时，才从同一原PDF的完整横线、全部字形、叶表头、部分父头及原非结果条件列重建完整网格；先按真实标签、条件和完整原行引文唯一定位，再核数值，不能用结果选择行。近似符号及同格双collar数值按原字面保留。原同表caption明确给WER百分数及口音代码时，才可沿该表明确映射继承单位；另一张表的单位不能借入。未实际包含单位的原表头保持原样，正常逐格及冷重放核验仍适用。

人工清单准备前需要保留已发现事实问题的原失败稿时，可单独使用 `--postprocess-only --preserve-failed-readers`。全体完成稿仍正常后处理，只暂缓失败稿的零请求重放及自动采纳，保留真实失败状态、候选、次数和费用。该标志不能与 `--retry-failed`、恢复许可、Reader人工清单或来源纠正混用，不产生完成、来源、付费或发布资格；下一次普通命令仍按正常守卫处理原稿。

`conference:migrate-process` 的显式 `--reader-corrections ABSOLUTE_PATH` 只接受同一已登记 `--recovery-manifest`，并要求已完成当前实现的普通后处理。原许可全轮已结束、无在途项，且完整当前失败集不超过原 process 成员数派生的上限（至少10、硬限15）时，才能打开来源绑定人工清单。清单覆盖完整失败集，逐篇绑定真实子运行、原包/运行/来源及唯一活跃失败候选 CAS；每篇只替换 1–8 个已有节点，不增删章节、术语桥、图、表或公式数量。没有原候选的旧签稿、上游仍不合格、来源或预算链缺失都不适用。

默认仍核对同一许可已完成3轮。少量顽固稿已跨正常执行重试，而当前窗口因同组无进展或全文次数耗尽在首轮正常停止时，可在人工清单显式声明 `normalHistoryAdmission.contract: historical-normal-terminal-v1`。其 `members` 必须精确覆盖完整当前失败集，每项绑定 `paperId`、当前 `executionId`、直接前驱 `priorExecutionId`，以及两份完整材料树的 `currentMaterialsSha256`、`priorMaterialsSha256`。程序核验真实已登记的许可、连续父子稿、同一封存来源和原完整材料；当前与直接前驱各须有实际 Reader 内容请求/响应和正常失败记录，不能把停止记录、伪造数字或同一次执行的多条响应当成多轮。当前还须有唯一活跃失败候选，以及真实的同组无进展或全文耗尽证据。这里承认的是至少2次实际正常执行，不声称已完成本窗3轮，不增加模型额度。保存冷核使用不可变原 `analysis-before.json`、`run-before.json` 和原完整失败集重放；已成功的普通稿不能因此重新成为人工失败稿。

同一人工批次中，某篇已经保存并通过冷核、但其余论文尚未完成时，进程仍保持原全失败集状态。重启继续原清单，使用同批真实完成凭证及不可变 before 包重放历史资格；核对当前完整论文、before 文件、状态、来源、许可与完整材料树，只有合法的保存替换可由 before 字节重建原树。不存在真实凭证、正文或其它原材料改变时仍拒绝。实现变化时，仅这种已保存断点可在原状态 SHA 下续完原批；随后必须执行既有全会当前实现后处理、迁移 CAS 与汇总。不能先改进程状态、重签清单，或让首次全未完成批次借此跳过迁移。

部分原失败稿的 `apiReaderResources` 已等于本次封存预检，而 `openSourceScan.resourceEvidenceSha256` 仍继承父稿。入口只在真实同次来源与预检全部核验、旧资源阶段逐字等于真实父稿时，恢复这一个私有指针。评分＋Reader 必须另核本次真实评分检查点的来源、资源、主文和评分阶段绑定；Reader-only 必须保护原父稿主文、评分及标签。原物理失败包及旧声明完整归档，新操作凭证如实记录恢复前后及来源 CAS，冷热核验重放同一派生。资源对象不任意替换，不重签旧评分或 Reader，不增加请求。保留上游的资源同步仍验证投影不改变评分，但只对实际返回的原论文核 Reader 资格，假想的未保存主文不取得人工权限。

完整付费响应仅因 JSON `version: 4` 被拒、原候选仍为 `draft: null` 时，成员可另显式声明 `version: 1`、`correctionKind: paid-raw-json-schema-v1`。`rawJsonSchemaCorrection` 绑定 `originalRawSha256`、固定 `originalVersion: 4`、只改为版本3后的 `projectedDraftSha256`，以及本窗最新真实全文的 `requestId`、`responseFileSha256`；原 `rawDraft` 必须逐字等于该实际响应。原候选及其 null、请求和费用原样保留，只在私有来源作用域内投影版本字段，再应用旧 SHA 绑定的局部补丁；版本节点计入总共1–8个已有节点，不能通过此声明重造原稿或放宽日更入口。

原稿恰有2个来源绑定、唯一独占的 `[[TABLE_1]]`、`[[TABLE_2]]`，但实际 Markdown 表为0时，可另显式声明 `declaredTablePlaceholderRestoration.contract: declared-table-placeholder-restoration-v1`，如实记录0→2恢复。声明绑定同一认证 PDF/全文 SHA、原完整绑定 SHA、每个原标记所在 body 路径与原绑定 SHA、两张完整 Markdown 表字节及恢复后整稿 SHA。程序只在原标记位置恢复两表，不增加绑定或其它结构；后续补丁不能偷换已声明表字节。该声明可与上述版本投影组合：先改版本，再恢复标记表，再以该私有投影的 SHA 应用其它局部补丁，全部独立已有节点合计仍不超过8个。默认成员继续禁止隐瞒增删实际 Markdown 表；恢复内容仍须通过正常逐格来源、整篇质量及保存冷核，声明本身不证明科学内容正确。

此入口硬禁新增模型和网络请求，沿正常 Reader 解析、来源核验、整篇资格及页面后处理执行。只允许原已认证来源和同 SHA 本地资产；缺少资产不能联网补取。输出如实标记 `operator-local/local_operator`，保留原候选树、请求响应、费用、尝试及失败计数；保存独立不可变原包、原完整失败集、补丁及输出凭证，冷态从真实来源重放，不把人工结果声称为 API 响应。所有局部结果先通过正常暂存后，才原子采纳进 process。该入口不产生付费请求；选择其他正常付费恢复时适用上述持续授权，不存在“第四付费轮未获用户允许”的限制。中断后已有子稿和凭证保留，原状态 CAS 不同必须停止。最终仍须正常生成、独立审查、推送、部署及全页核验。

正常完整分析在 Reader 失败后可能保存 `analysis: null`，同时保留本执行已完成的评分检查点。此时只能在真实人工来源作用域内投影该检查点：活动检查点、`scoringAudit` 检查点和评分输出 SHA 三者必须一致，原失败必须仅属 Reader，完整科学上游核验通过，并绑定原包、原失败阶段及修订进度的 SHA。原归档仍保存 null 和全部失败字段，不能借用父执行或把缺失评分补成完成。缺失的官方图收尾只由正常函数在新 Reader 完整绑定后派生；保存前和冷核均重算同一结果。非空主文继续使用原词表下的完整上游预检。这一投影不重签评分、不增加次数或费用，最终仍须通过完整资格。

新 Reader 与官方图正常收尾后，原 Reader 失败还须受控解除。真实热态作用域及论文锁内先核新输出和完整 Reader 记录，再建立只去掉原 Reader 失败字段的临时视图；该视图通过正常整篇资格后才清当前对象。两个旧错误通道分别核对，非 Reader、运行级、认证、配额、配置、存储或完整性失败不能解除；不得清事实义务、原修订历史或任何计数。固定失败字段只准保留原值或删除，未知尝试字段继续逐字保护；`digestStatus` 仅允许原 `analysis_failed → analyzed`，其它属性不变。任何资格失败都保留当前对象的失败字段，冷核从原包重放相同投影，原归档始终保留真实失败。

唯一缺表的受控结构修正另声明成员 `version: 2`、`correctionKind: single-source-table-append-v2`，不能借 v1 新增节点。该子类型只接受原14节、1表/1绑定、4图、0公式的真实活跃候选：在既有 `/sections/10/body` 尾部追加一张五列表及导读和解释，并在末尾追加第二个绑定。原表、原绑定、其余章节、术语桥、图和公式保持逐字相同。显式规格 SHA 绑定本成员的原分析、运行、来源、修订、账本与候选六文件 CAS，以及同一认证 PDF、唯一原表窗口、逐字引文及完整新旧稿 SHA；任一原文件变化须重新审查，不能自动刷新规格。纯数据辅助函数不能授予来源能力，只有完整最终失败集的私有加载器及真实 PDF 能力可执行，禁止退休稿使用这一结构子类型。正常解析可能确定性补充旧表的显示引文，须重放并精确核对完整最终显示计划，不能把派生结果称为人工改写原绑定。最终仍经过相同的完整资格、原包归档、保存冷核及整批采纳，不增加模型请求。

还有一种窄恢复来源：最新付费 Reader 已移入唯一 `.resolved.json`，但外层保存失败，实际 canonical 仍是旧 Reader，且没有活跃候选。显式成员可声明 `originKind: latest_resolved_paid_reader`，仅允许 v1 既有节点修正。程序须先重放真实登记许可的完整账本，核对最新付费 patch、唯一请求/响应及完成费用事件、原 Prompt 字节、全部实现迁移与原失败历史，再以正常共享归一函数逐字还原退休稿。当前真实主文、来源和资源输入指纹必须与原付费输入一致；不选择较旧或较易通过的响应，不复活退休文件、不重建活跃候选。冷态重新读取相同原链并核对完整来源证明，不能只相信热态凭证或清单自报 SHA。

正常 `reader-only` 追加恢复在发请求前若确认上述真实来源，只将该篇保留为不可重试的“待来源绑定本地纠正”，让本轮其它论文继续。无来源能力、原链损坏、账本或次数不一致仍按原运行级完整性故障停止；其它分析/评分模式不使用此减权分支。保留所有原付费次数、连续失败、文件与费用，不能以空活跃目录把新请求从零开始。共享归一函数和输入指纹只是同算法提取，不产生来源或发布资格。

上述私有退休稿减权只在集中配置的真实会议运行根目录中启用。独立目录继续原适配器的正常来源、阶段和强账本流程，不能获得该私有能力；直接以独立目录请求退休稿认证仍拒绝，不使用测试标志或自报目录覆盖来源边界。

### 认证来源事实的零请求纠正

已有真实完整 Reader 的资源归属或单句核心事实确需纠正时，先停止生产并完成当前实现的 `conference:migrate-process --apply … --postprocess-only --retry-failed`。此操作保留正常全批检查发现的失败，不增加次数。随后使用同一入口的 `--postprocess-only --source-corrections ABSOLUTE_PATH`，清单必须物理登记在原 process 的对应私有目录，绑定停稳状态、完整获准集合、每篇原稿与新子运行固定 UUID。不能同时传 `--reader-corrections`，不能混入付费调度。

资源纠正使用 `source-resource-corrections/` 内的 `conference-source-resource-correction-batch-v1`；单句核心纠正使用独立 `source-core-corrections/` 与 `conference-source-core-correction-batch-v1`。两份合同、清单、记录及回执分别验证，不共用编辑权限。每批1–15篇，授权集合、来源集合与记录集合必须完全一致；本任务的资源纠正须一次覆盖已识别的全部11篇。资源纠正不能改核心；核心纠正仅替换来源明确支持的唯一一句，保护其余十二节、资源和完整八维评分对象，不能借资源理由修正权限。

每篇分别绑定真实完整 Reader 父稿、当前 process 指针、最新实际付费失败子稿及本次主文基础的完整 CAS。追加窗口之前的原失败稿另用 `originalFailedExecutionId` 和完整 CAS 绑定，须由公共追加窗口加载器重放真实许可、父稿与失败稿链；当前 process 仍指向旧完成父稿时，不得把它当成原失败 UUID。仍有付费失败的论文必须保留最新主文，不能用旧完成父稿覆盖；只有纯后处理发现的核心错误且没有新付费子稿时，才按精确原错误及当前失败状态绑定原完整包。来源、PDF、原费用及所有原角色目录逐项归档，旧预检、模式、计数和费用不改写。

资源纠正从同篇认证 PDF 重算作者脚注归属，保留原网络可达观测；正常八维审计重算资源项并保护其它维度及理由，必要的一项理由修正须独立来源引文和原理由 SHA 绑定。Reader 最多修改1–8个已有节点；声明无修改时草稿必须逐字相同。核心纠正保留真实原标签检查点，重新计算同一公共核心绑定，不编造 API 中间稿。新阶段如实记录本地操作来源及零请求。

两类纠正均硬禁模型与网络，使用正常 Reader 解析、来源检查、最终处理、完整资格及保存后的独立冷重放；不自动补引文、删不支持的声明或补图片。Python 页面链经原私有描述符桥核对真实规范稿、呈现稿、评分阶段及回执 SHA，普通 JSON 不能签通过。所有子稿暂存成功后，重新持有按论文 ID 排序的全部锁，复核分析/运行/来源、页面及原状态字节，才单事务采纳；原完成凭证按真实不可变父链投影，不冒充 Reader 修订。最终仍正常生成、独立审查、发布和逐页上线核验。

新本地 Reader 的五项协议声明必须逐项等于正常 finalizer 当前合同，允许正常补齐旧稿缺失的 Reader 声明；原图持久化声明的有无和值保持原样。除此六项之外，原科学合同及非 Reader 阶段继续逐字保护，不能删除整个合同对象来绕过上游保护。旧物理包的声明保持不变，新声明仅属于此次真实本地输出。

最新失败包因 Reader 失败而将 `analysis` 保存为 `null` 时，只有显式检查点恢复记录精确绑定原空值、原 Reader 失败、当前评分阶段及两个实际评分检查点，且三份正文 SHA 相同，才能在私有范围内恢复该最新正文及解析字段。原物理失败包保持不变；仍须重验真实来源、全部科学上游、标签、摘要与评分，不能回退旧完成父稿。若原图片候选、下载及对应记录均为空，而唯一未收尾阶段是 `imageSupplement`，只在新的 Reader 及同 SHA 原图完整核验后沿公共官方图收尾派生该阶段，冷核重放同一派生；不提前补状态、不运行旧图片模型。

核心单句修正仍保存原完整八维评分对象。若当前公共审计对原核心与新核心的正常归一结果逐字相同、原审计本身严格有效、原理由与认证来源无矛盾，允许记录这两份实际校验 SHA，并保留原评分及原十二节字节；不能把归一措辞差异说成原对象完全相同，也不能借此改变分数、理由或资源状态。

来源纠正组合最新科学主文与独立旧 Reader 时，正常 finalizer 从私有已核输入的 `readerParent` 重放作者签名；先逐字比较主文与该父稿的作者姓名数组及来源 SHA，再核验原作者对象、原 Reader 阶段的作者 SHA 和同一来源。最新主文的 Reader 尚未完成时，不要求它具有旧签作者阶段，也不复制父阶段补成完成。合法的旧机构不可得提示保留原字节；错误姓名、来源、机构或签名继续拒绝。普通刷新仍使用自己的真实上下文，自报 JSON 不能获得私有能力。

### 来源升级需要明确的新分析授权

来源升级先输出绑定原 process、输入 SHA 和当前提取器的计划，再只分析明确选中的论文：

```bash
npm run conference:process -- --source-upgrade-plan \
  --catalog C.json --report R.json --filter FILTER_UUID --from PROCESS_UUID
npm run conference:process -- --source-upgrade-apply \
  --catalog C.json --report R.json --filter FILTER_UUID --from PROCESS_UUID \
  --plan-sha PLAN_SHA256 --paper-ids 'PAPER_ID_1,PAPER_ID_2' \
  --authorize-new-analysis --concurrency 3
npm run conference:process -- --source-upgrade-promote \
  --catalog C.json --report R.json --filter FILTER_UUID --from PROCESS_UUID \
  --plan-sha PLAN_SHA256
```

`PLAN_SHA256` 必须等于刚核对的计划 SHA，`--paper-ids` 只列本会明确授权的新分析对象，`--authorize-new-analysis` 不能省略。未选择的旧成果保留；新提取组使用新的来源依据，不能放宽旧回执或覆写旧文件。来源获取或提取的 generation 不等于论文 `vN` 修订号。

新来源升级计划使用 v2 格式和当前词表字段，随后建立同代的子进程。已明确授权的 `--paper-ids` 固定首轮范围，子进程也按正常全批轮次后仅续失败集合，不扩展新分析授权。恢复已有计划时，先核原计划、授权、检查点及父进程对应关系，再按已核格式完整重算；原计划 SHA、尝试次数和已完成结果不能为了恢复而被替换。来源、成员或实现变化使原计划无法完整对应时，程序停止，须重新核对并明确授权新的计划。升级状态及提升记录仍保留各自原格式，不能随计划一起改版本。

子集升级 complete 不等于整会完成。普通 promote 需要全成员升级结果；显式 `--preserve-original-complete` 可保留原完成项，`--prefer-upgrade` 优先用完成的升级项并保留其他原完成项，两者互斥。无论哪种方式，缺少完整可核验结果的成员都会阻止生成新会议结果。返回的新 `processId` 用于后续发布，原 process、分析和发布记录保留。计划没有承诺跨来源复用模型阶段，输入改变时须说明新分析成本。

`--page-repair-mode caption-only` 是另一个明确限定、由程序完成的页面修复选项，只供 source-upgrade 的 plan/promote，要求保留的 process 已完成并有绑定的修复策略；它不等于 source-upgrade-apply 的模型新分析，也不自动授权新成本。不要为普通恢复自行加这些模式参数。

### 工作区、重复文件与锁维护

`npm run conference:workspace` 只读报告未提交内容、配置重复定义及进程存活信息。旧 JSON 的 running 不代表当前仍有进程；应依据实际 owner 和锁记录判断。

`npm run storage:pdf-duplicates -- --json` 仅按来源记录声明的哈希报告重复候选，不是逐字节核验或删除授权。`--hash-bytes` 才重新读取全部 PDF 计算哈希，大目录可能耗时较长。会议来源及发布记录受保护，不属于自动 prune 范围。

`npm run conference:recover-locks` 会实际回收符合条件的锁，不是只读查询。它只处理程序判定可回收、owner 确认死亡的 process 操作锁；锁格式损坏、进程存活或存活未知时保留并报告跳过，不批量删除锁文件。

## 与全历史重写的衔接

单个既有日批次可查 [`history:resume`](history-rewrite.md)。全历史会议页优先走 `history:conference-local-sources → history:inputs → history:conference-projections → history:plan` 后进入直接重写队列，不要求先跑旧账本或执行状态，也不把旧全文、任意路径或旧解读直接塞进正式分析。

会议来源只读取本地来源清单已绑定的 metadata/PDF SHA 和冻结页面对应记录，本轮解读所需图片从 PDF 在系统临时目录准备。本地文件缺失或损坏只使该项失败，不转入来源对照表（crosswalk）或备用 arXiv 获取。arXiv 来源根据冻结页的单一 arXiv 线索，每个新的来源获取序号都重新获取官方文本、PDF、runtime metadata 和 manifest；同一获取序号恢复时，先核验并复用原四文件。只有明确命名的 arXiv 新获取失败交接才能进入来源对照表，不能任意调用备用链。只有当前官方 PDF 返回 404 后才可尝试同 ID 历史版本，文本须来自实际选中 PDF，引用使用核验的 `sourceVersion`，不能把获取序号当论文修订号或猜成 `v1`。

ICML/OpenReview 替代 PDF 默认拒绝，不能以相似题目替换来源。经用户授权的跨标题预印本例外仅为 `conference:icml:2026:openreview-forum-id:n1mAjfRDZ6`，由代码白名单绑定 poster/forum、固定 SSRN 题目与作者、DOI 及 PDF、凭证和来源的 SHA。浏览器文件只经受控 `--import-file` 导入，记录 `networkResponseObserved: false`；计划、模型输入和页面都须显示不是会议 camera-ready 定稿，不能推广到其他论文。完整来源和发布要求见历史文档。

当前历史直接发布已有计划、生成、独立审查和精确发布入口，维护旧 URL、会议汇总和任务页。`publish --apply` 在共享锁内完成交接、提交、推送和远端核验。具体参数及中断恢复见[历史直接发布](history-direct-publication.md)，不据旧分支的未完成说明跳过当前流程。

每篇仍只允许一个写入者，请求用量和检查点保留；来源、Reader 或标签规则变化按实际指纹及迁移要求处理，不无限复用旧通过。每次直接重写的质量审查都是正常阶段，不能当作可省略的试点。发布范围是否排除视觉或允许豁免取决于用户明确要求，命令示例不能代替用户授权或决定；Git 到达远端仍不能替代部署和页面核验。
