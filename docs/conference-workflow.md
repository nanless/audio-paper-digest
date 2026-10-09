# 会议论文的来源获取、分析与发布

新会议从官方目录和 PDF 开始，完成筛选后使用统一的 `process` 入口，再独立生成、审查和发布博客。已有会议运行和全历史页面有各自的维护入口，不能把它们的任务 ID、运行模式或来源记录混用。本页先介绍新会议的完整路径，再说明恢复和旧运行维护。

## 工作区与入口选择

运行前先核对目录和工作区角色，所有项目脚本均须在沙箱外执行：

```bash
pwd
npm run workspace:role -- status
```

| 任务 | 工作区与入口 |
|---|---|
| 获取、筛选和处理 2026 年新会议 | 已绑定 `daily` 的日更目录，使用 `conference:new:*`。 |
| 维护旧会议的发现、提取、导入和隔离执行记录 | 当前 `daily` 目录，通过 `PD_WORKSPACE_ALLOW_CROSS_ROLE=1` 使用原 `conference:*`。 |
| 重写和发布历史会议页面，保留已有 URL 和任务页 | 当前目录，使用[全历史重写](history-rewrite.md)及[历史直接发布](history-direct-publication.md)。 |

新会议的 npm 包装入口会设置并校验所需运行模式；不要自行伪造 `AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE` 或跳过角色检查。旧历史工作区已废弃；日更、会议和历史任务不能同时生成、审查、推送同一博客，或修改同一远端 `main`，执行者负责错峰。下文的 `UUID`、`NAME.json`、`C.json` 等是占位符，执行前须替换为对应入口接受的真实任务 ID 和安全文件名。

```text
官方目录与逐篇 PDF
  → 已核验的 discovery catalog/report
  → 全集 PDF 摘要证据
  → 每会独立配置和 LLM 筛选
  → conference:new:process：提取、导入、分析、评分、解读和页面暂存
  → conference:new:publish：generate → review → push → verify
```

会议来源与 arXiv 日更不同，分析仍复用 `analysis-engine.js`、正式分析的 13 个解析标题、类型感知八维评分、`beginner-researcher-v3` 解读及 `api-reader-source-bindings-v4` 来源核验。单篇页面和 `reader-facing-v3` 会议汇总使用现行标签体系，包含中英文题目、分档、文档类型、评分、作者机构、资源状态及官方记录和 PDF 链接，不能沿用旧标签或另造会议标签。

会议汇总只读取已通过来源、解读和分类检查的单篇结果，不再让模型总结整批，因此不会为了汇总重复生成每篇深度解读。队列入口只协调已筛选会议的处理和发布，不负责获取或筛选。

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
npm run conference:new:acquire -- catalog \
  --provider iwslt-2026 --conference-id iwslt-2026 --year 2026 --apply
npm run conference:new:acquire -- download \
  --provider iwslt-2026 --conference-id iwslt-2026 --year 2026 --apply --concurrency 4 --retries 3
npm run conference:new:acquire -- verify \
  --provider iwslt-2026 --conference-id iwslt-2026 --year 2026
```

`catalog` 和 `download` 须显式选择 `--dry-run` 或 `--apply`；`status` 和 `verify` 不接受这两个模式参数。`--provider`、`--conference-id` 和 `--year` 必须与固定来源身份一致。

下载默认并发 1、网络重试 0，可显式设置 `--concurrency 1..5` 和 `--retries 0..5`；这些参数及 `--limit` 只用于 `download`。重试限于 socket、超时、HTTP 429 和 5xx，保持同一官方 URL。任一下载失败后停止领取新论文，等待在途任务保存结果，再返回失败。重跑同一命令会重验完整 PDF/回执对并补缺项；有回执却缺 PDF 时仍须停止，不能据回执假装文件存在。

目录响应接受 HTML 和 XHTML；重新读取并核验已封存目录响应时，采用相同的类型要求。目录、PDF 和凭证均先完整写入临时文件，再以不可覆盖的方式保存到正式路径。普通写入失败不会留下半截正式文件。

`status` 计算已下载数量前，也会逐篇核对 PDF 与凭证字节；损坏文件不会被计为完成。`status` 和 `verify` 始终只读。若进程在正式文件已完整保存、临时硬链接尚未移除时中断，重新执行对应 `catalog --apply` 或 `download --apply` 会先核验文件身份并回收同机已退出写者的临时硬链接，再重验完整来源与凭证。

若进程在正式文件保存前被强制终止，可能只留下临时文件。程序保留该文件并报告准确路径；先核验写入进程已经退出、文件确属本次中断及正式凭证状态，再单独清理并续跑。不要批量删除未知文件，也不能把这类中断描述为已经自动恢复。

完成下载后再做 discovery。`--pdf-root` 指向 provider 根，而不是 `pdfs/` 子目录，因为 metadata 中的 `pdfFile` 是 `pdfs/<official-id>.pdf`：

```bash
npm run conference:new:discover -- --apply \
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
npm run conference:new:evidence -- plan \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --run 00000000-0000-4000-8000-000000000001
npm run conference:new:evidence -- apply \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --run 00000000-0000-4000-8000-000000000001 --limit 10
npm run conference:new:evidence -- status \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --run 00000000-0000-4000-8000-000000000001
npm run conference:new:evidence -- verify \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --run 00000000-0000-4000-8000-000000000001 --limit 10
```

普通 `apply` 默认处理 1 篇，`--limit` 范围 1–500。确认全集并准备一次处理时，须同时提供 `--all --expected-total N`，其中 `N` 精确等于认证目录的成员总数，否则在创建或推进运行前拒绝。`--all` 仅供 `apply`，不能与 `--limit` 共用。下面的 39 是示例会议的数量，不能照搬到其他目录：

```bash
npm run conference:new:evidence -- apply \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --run 00000000-0000-4000-8000-000000000001 \
  --all --expected-total 39
```

这样既避免误启动数万篇任务，也减少小批次恢复时反复扫描已有回执的本地开销。状态保存在 `data/runtime/conference-filter-evidence-runs/<runId>/`。恢复先重验已完成成员的回执、摘要定位结果、文本及解析证据 SHA；半成品、提取器错误或字节变化都会停止，不能改成排除决定。

非 AAAI 会议继续使用不带 `profile` 的默认定位实现。只有 `aaai-2026` 使用 `aaai-2026-bare-introduction-v1`，允许前两页唯一独占行 `Introduction` 作为摘要终点。实现 SHA 必须来自代码登记表，CLI 不接受任意 profile/hash；更换 profile 必须建立新运行，不能改写旧回执。

全集完成后才生成 `evidence-catalog.json` 和 `evidence-report.json`。筛选通过 `loadEvidenceHandle()` / `evidenceHandleSnapshot()` 读取已经认证的对象，把 catalog/report/state、各篇回执和摘要 SHA、定位版本一起纳入输入、请求及恢复核验。`ready` 摘要进入关键词和提示词输入；其他状态保留原 metadata，交给模型判断，不能凭题目或不完整摘要直接排除。不得直接信任裸 JSON 或路径，也不得把摘要回写到已固定的官方 metadata 快照。

## 配置与执行会议筛选

当前 `conference-filter-v6` 保存候选发现记录、完整摘要证据目录与报告、逐篇回执和定位信息，并绑定来源 SHA、选择规则、提示词、模型、请求格式和标签词表 SHA。记录分别标明入选、排除、待处理或失败；全部论文处理完成且没有失败，任务才记为 `complete`。

`conference:new:filter` 管理配置、状态和显式人工决定；`conference:new:filter:run` 是生产 LLM 筛选入口。它逐篇核验官方记录和完整输入，通过 `requestLlmJson()` 使用项目路由、代理及 sticky 账号池：

```bash
npm run conference:new:filter -- spec --catalog NAME.json --report REPORT.json \
  --evidence-run EVIDENCE_RUN_UUID --output CONFERENCE-FILTER-V6.json
npm run conference:new:filter -- prepare --catalog NAME.json --report REPORT.json \
  --evidence-run EVIDENCE_RUN_UUID --spec CONFERENCE-FILTER-V6.json
npm run conference:new:filter:run -- --apply --catalog NAME.json --report REPORT.json \
  --evidence-run EVIDENCE_RUN_UUID --spec CONFERENCE-FILTER-V6.json \
  --filter UUID --owner filter.worker --limit 1
npm run conference:new:filter -- status --filter UUID
npm run conference:new:filter -- apply --filter UUID --decision DECISION.json --owner OPERATOR
```

新任务只使用 v6 配置；模型请求记录使用 `conference-filter-llm-request-v3`。旧 v5 配置只供原 UUID 的已有任务恢复，核验原记录后仍按原格式继续，不能用它创建新任务。新旧词表字段不能同时出现，即使值相同或为空。决定、选择回执、选择凭据和锁记录仍使用各自的版本 5，不能把它们当成任务版本 6。

每会配置位于 `data/runtime/conference-filter-specs/`，只能由 `spec` 从同会认证的 discovery 双文件及完整摘要证据运行生成，不能跨会议共享。以下字段示例中的占位 SHA 须按相应文件原字节或规范化对象真实计算，不能直接通过校验：

```json
{
  "contract": "conference-filter-spec-v6",
  "version": 6,
  "filterPolicySha256": "<64-hex-current-policy-sha256>",
  "promptSha256": "<64-hex-current-prompt-sha256>",
  "model": "mimo-v2.6-flash",
  "endpointProtocol": "openai-chat",
  "endpointIdentitySha256": "e4e17c2ccca11abebb9087c7ebb6a43d01185e9e47a82ba5425fa7939b651f08",
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

`endpointIdentitySha256` 由 `endpointIdentitySha256(endpoint, model)` 对公共路由规范化后的 API URL 的 UTF-8 字节计算，不含 API key。示例值不代替当前端点计算。端点、协议或模型改变须新建筛选任务，不能在原状态上混跑。

### 筛选健康检查、并发与恢复

`prepare` 返回的 `filterId` 用于运行和恢复。先用 `--limit 1` 检查一篇论文的请求、响应和筛选记录，再保持同一组输入、去掉 `--limit` 继续。推荐全局最多同时运行 5 个不同筛选任务；这是操作建议。同一 `filterId` 的请求、原始响应、用量和状态更新共用一把锁，不得启动并发 worker。中断后继续使用原 catalog、spec 和 `filterId`，不能换输入恢复旧任务。

每次请求先在锁内以 `O_EXCL` 保存 intent，再保存终态 HTTP 原始响应、提供方用量及各物理请求的用量账本（usage-ledger）事件绑定，最后生成决定文件并按状态 SHA 比较后更新。入选和排除决定都须有受控文件；模型决定还须真实请求/响应字节、模型/协议及非零逻辑请求用量。人工决定使用独立 actor，不能冒充模型。普通 `buildDecisionArtifact` 和人工 `filter apply` 拒绝 LLM actor；生产证据生成器不接受自传 transport 函数。

筛选与日更使用同一个结构化决定解析器。格式无法解析时保存响应和用量，记为 `failed`，不在同一 intent 中追加格式修复请求。pending 优先处理；failed 只有显式 `--retry-failed`、超过五分钟退避且累计少于 `FILTER_CONFIG.maxRetries`（当前 5 次）时才重试。新尝试分别记录请求、响应及费用依据；OpenAI Responses 从第二次已登记尝试起，输出预算至少为 4096 tokens。

请求中断后先恢复已有回执或决定文件。intent 已存在而终态响应不可知时，保守记为带错误类型的失败，不自动重复计费。用量完整、输出非零且严格 JSON 的 `included`/`excluded` 才能成为最终决定。账号池切换前的完整原始响应无法从公共封装取得时，回执保留物理请求的用量账本事件 SHA，并单独保存终态原始响应，不能把不可得状态说成完整响应。全集 complete 后才生成只含 included 身份的选择回执。

筛选遇到公共请求封装标记的 `scope=run` 故障时，先保存本篇请求、回执、失败决定和状态，再原样抛出异常并停止本轮派发。HTTP 401 也会停止；其余候选保持待处理。恢复尚未登记的回执或决定时，账号认证、额度耗尽、账号状态及配置故障会按稳定错误码恢复为运行级故障，保存本篇记录后停止，不重复请求，也不改写旧凭证。普通正文格式错误、输出截断等单篇失败仍继续处理下一篇。排除运行级故障后可重新启动；失败论文仍须遵守显式重试、退避和次数限制。

## 新会议统一处理与暂存

新会议处理只用 `conference:new:process`。`conference:new:execution`、`conference:new:analyze` 和 `conference:new:postprocess` 已禁用，调用会明确失败，不能用它们拼接另一条新会议流程。

```bash
npm run conference:new:process -- --dry-run \
  --catalog odyssey-2026.json --report odyssey-2026-report.json --filter UUID \
  --concurrency 3
npm run conference:new:process -- --apply \
  --catalog odyssey-2026.json --report odyssey-2026-report.json --filter UUID \
  --concurrency 3
npm run conference:new:process -- --status \
  --catalog odyssey-2026.json --report odyssey-2026-report.json --filter UUID
npm run conference:new:process -- --status --verify-files \
  --catalog odyssey-2026.json --report odyssey-2026-report.json --filter UUID
```

入口只接受 complete、非空、来自 `official-proceedings` discovery 的选择，每个 included 成员必须是唯一 `exact` PDF。自动来源验收使用 `conference-deterministic-source-seal-v1`，表示程序按官方 metadata 的 `pdfFile` 核验文件，不表示人工审阅。程序内部依次安排提取、暂存、导入和计划，再完成共享深度分析、评分、解读、标签和单篇暂存页。

每篇仍按固定 PyMuPDF 提取，重新核对提取请求、元数据、PDF、文本、结构化证据、回执及验证记录的 SHA。进程 UUID 由入选集合、词表原文件和实现指纹确定；每篇分析 UUID 再由进程 UUID 和完整 `paperId` 确定。状态保存在 `data/runtime/conference-processes/<process-uuid>/state.json`。

新进程和完成凭证各自使用 v2 格式，词表身份字段为 `tagCatalogVersion`、`tagCatalogSha256`。已有 v1 记录先按原对象完整核验，再继续原 UUID，保留创建时的词表字段和值；读取不会给旧记录换格式或重算原身份。工作区盘点同时识别两版，但盘点通过不能代替正式完成及发布检查。队列和分析配置仍使用各自独立的版本。

`--concurrency` 默认 1，范围 1–5，覆盖单篇处理生命周期；每篇进入分析引擎时内部并发为 1。相同身份重跑使用同一 UUID，完成论文不再请求模型，未完成论文从原分析检查点继续。只有来源依据、共享分析的完成回执、当前标签及单页清单均通过，论文才 complete；所有成员 complete 后才生成会议汇总及不可覆盖的 `completion-receipt.json`。

分类未能确定时，程序保存 `tag-review-queue.json` 和具体阻断原因。这是单篇待处理条件，不是服务故障，也不能把未解决标签放进可发布汇总。

只有 `--apply` 取得 process 操作锁，`--dry-run` 和 `--status` 只读且不取写锁。程序返回或抛出异常时在 `finally` 释放锁；进程退出遗留的锁只允许安全回收同机已死亡 owner，未知或仍存活 owner 不能擅自清理。逐篇更新另有状态 SHA 比较，禁止把 complete 回退成 analyzing 或 analysis_partial。最终完成事务在锁内重新确认全部成员及回执。

`--status` 默认只读 `state.json` 和 `completion-receipt.json`，检查状态与完成凭证中记录的内容及对应关系，不读磁盘上的分析结果和暂存页；报告里的 `filesVerified` 为 `false` 就表示这次没核文件。要同时确认文件在位，加 `--verify-files`：它按 `analysisProof`、`pageProof` 和 `aggregate` 复算 analysis.json、暂存 page.md／manifest.json、汇总页的 SHA，缺文件或字节不符都列进 `fileVerification.failures`（`paperId`、`artifact`、`detail`），进程退出码为 1。它只遍历该进程已知的 `analysisRunId` 目录，不扫整个暂存根目录。来源封存文件不在这项检查内，它们由 `--apply` 的来源连续性核验和发布前检查负责。

process 只生成私有来源、缓存、检查点及单篇和汇总暂存页，不执行博客生成、审查、推送或远端验证。完成处理后继续下节发布，不把 process complete 当作已上线。

单篇页面暂存的写入使用公共文件锁，锁记录位于暂存根目录的 `.stage-locks/`，按分析运行、词表及页面生成实现区分。同一组输入的待审标签记录升级也在该锁内进行：删除前重核打开的文件描述符、当前路径和父目录；文件被替换或读取失败时保留现状并报错。它只协调遵守此入口的写入者，不授权手工删除锁或覆盖未核验文件。

### PDF 中能核验的图表和公式

PDF 提取保留逐页 PNG、内嵌图片摘要、表格单元格及坐标、Figure 和公式候选，以及可重验的页面/区域像素 SHA。不能因为来自 PDF 就统一说图表不可得，也不能把普通文本拼接当作原始 TeX。

当前会议来源不会把启发式表格候选升级成可信 DOM 单元格，矩形矩阵也不能证明原表行列正确；表格候选标为 `needs-review`，数值叙述和可支持的表格通过逐字原文引文核验。没有原始 TeX 时公式来源为 `unavailable`，保留公式候选和页面证据，不能丢上下标后声称得到可核验公式。不能定位完整表格及数值时不展示表格。

Figure 识别支持 `Figure`/`Fig.` 图注，排除 `Figure 2 presents ...` 等正文引用，保留原图号并去重。双栏图只用同栏前置图注限制裁剪；没有有效图片资产的候选不进入可发布图片集合。图片须有页码、图号及解析证据 SHA，不能从旧博客反向补造。旧 weak 来源只供符合相应身份条件的兼容读取。

新会议解读的 PNG 保存在该篇隔离分析运行的 `reader-assets/`。后处理核对文件名、缓存路径、图片类型、SHA 和字节数，再把有效图片写入私有页面暂存目录，发布时进入受控图床。不能将这条会议路径与默认 arXiv 日更或历史直接重写的临时像素路径混为一谈，也不能跨任务复制图片绕过身份检查。

## 新会议独立发布与线上核验

以 process 返回的 ID 发布同一会议，依次执行：

```bash
conference_process_id='替换为 process 返回的 UUID'
npm run conference:new:publish:generate -- --conference-id odyssey-2026 --process-id "$conference_process_id"
npm run conference:new:publish:review -- --conference-id odyssey-2026 --process-id "$conference_process_id"
npm run conference:new:publish:push -- --conference-id odyssey-2026 --process-id "$conference_process_id"
npm run conference:new:publish:verify -- --conference-id odyssey-2026 --process-id "$conference_process_id"
npm run conference:new:publish:status -- --conference-id odyssey-2026 --process-id "$conference_process_id"
```

`generate` 重验来源及暂存页，生成博客文件和本批清单。`review` 对最终页面字节作只读审查，包含正文模型审查、图片多模态、Markdown 及 Hugo 检查；失败不保存通过记录，也不原地改正文。模型通过不等于论文事实已绝对正确，更不代替独立事实或人工视觉检查。

`review` 要求博客检出目录带 Hugo 运行时（`hugo.yaml`/`hugo.yml`/`hugo.toml`/`hugo.json` 任一，加 `layouts`/`assets`/`themes` 任一）。缺运行时就没有可审查的渲染结果，`review` 直接报错，不产出任何审查凭证，也不会跳过正文和图片审查后伪造一份通过记录。审查协议指纹同样按实际算出；算不出来就报错，不替换成替代值。

逐页通过证据只按相对路径和页面内容 SHA 复用。实现、模型、协议或批次记录变化后，未变页面保留通过依据，当前批次仍须重跑确定性检查并生成新审查记录。图片子审查不能脱离整页身份或省略来源检查。

发布正文审查默认并发 5，`PD_BLOG_REVIEW_CONCURRENCY` 范围 1–5。程序只按空出的并发位置补派任务；运行级故障停止新页面，在途页面完成保存后交回原错误。普通页面审查异常也会使本轮停止补派并失败，不能保存整批通过记录。并发设为 1 时逐页顺序处理。

`push` 逐文件核验 Git 暂存区及提交内文件字节，核对本次允许变动的文件集合、父提交、推送身份和远端 OID，不只看工作区文件。博客与图床分别处理受控提交；图床完整资产清单和本次 Git 变动分开，相同已发布图片可零差异复用。自身提交后断网或重复发布，仅在父提交、文件集合、内容和远端身份精确一致时恢复。

### main 前移后的恢复

尚未发布的生成清单（`generation.json`）因日更或 UI 更新遇到 `main` 前移时，重新走正常 `generate → review → push`，不得手改清单、审查记录或直接重跑旧 push。generate 分别核对博客和图床的推送目标、`HEAD = 远端 main`，确认旧基线存在且是当前基线祖先，并逐提交检查所有会议目标，包括合并提交的父提交；即使最终字节恢复，中途删除、符号链接或文件模式变化仍会拒绝。

通常要求当前提交中的会议目标仍与旧生成清单的精确字节相同；未被中间提交触及的目标可以保留旧基线内容或原本不存在。工作区目标必须路径安全、是普通单链接文件、权限为 `0644`，并与旧清单字节相同。现有代码另允许受控生成恢复：generate 已重验本次完整 process 和暂存来源，且工作区目标字节精确等于本次暂存来源 SHA 时，可以接受它与旧清单或中间提交中的字节不同，随后生成新的基线凭证。博客与图片均只接受这一精确字节对应关系；它不允许任意人工改动，也不放宽中途删除、可执行或符号链接模式变化、未知基线、非祖先历史替换及远端身份变化的检查。其他进程仍须遵守共享锁。

以上只允许 generate 重验来源和暂存结果后生成当前基线的清单，不修复损坏的来源或图片。被替换的未发布凭证先按原字节保存为 `superseded` 备份；review 可复用未变页面，但重跑当前基线的 Hugo 和确定性检查，再签发当前审查记录。已有发布凭证保持不变；push 对允许变动的精确文件集合、父提交、暂存区、提交及远端的核验不变。

正文或图片被拒绝时，具体 findings 保存为不可覆盖的 `data/runtime/conference-publications/page-review-failures/<failureSha256>.json`，绑定路径、内容 SHA、审查协议和阶段，异常给出文件路径。文件不含正文替换建议或图片字节，也不是通过缓存。先按 findings 修正生成阶段的内容或来源，再正常 generate/review；服务和账号异常保留原类型，不能当内容失败反复请求。

### 自动验收覆盖什么

新 v2 发布在推送博客和图床后，自动 GET 已审页面和全部图片，通过后才保存发布完成记录。页面检查 HTTP 200、HTML 类型、最终 URL 与唯一正式地址一致，以及已审正文、图片顺序和表格单元格的对应关系；含公式时还检查数学脚本存在。图片检查 PNG 类型、实际字节 SHA 和可解码性，允许通过安全核验的重定向，不套用页面最终 URL 必须等于正式地址的条件。线上核验默认并发 4，`PD_CONFERENCE_ONLINE_VERIFY_CONCURRENCY` 范围 1–16。

GET 使用项目 HTTP CONNECT，逐跳核验公网地址并限制响应。全链共享 60 秒期限，响应最多 16 MiB；每一跳的瞬时传输最多尝试 6 次。HTTP 状态、哈希和 HTML 不匹配不作为瞬时故障重试。线上尚未符合时保留远端已经推送的事实，继续运行 `verify`，不要重新分析论文。

`status` 报告已保存的线上检查快照；显式 `verify` 会记录一次新的 intent/result 并重新 GET，最新 pending 或失败不能被旧通过掩盖。已有 publish 的重复 `push` 只读 status，不代替新的线上重验。旧 v1 发布通过单独的 `verification-v2.json` 补充核验，原记录字节保留。

读取已发布凭证时，不带 `contentReview` 的 v2 审查记录按旧格式识别：`conference-blog-review-v1` 的 version 2 中途增加过 `contentReview` 要求，早期代码写过不带的 v2 记录，自哈希、文件清单、`generationSha256` 和 HTML 检查的页面集合都对得上，是那段代码的合法输出文件。当前发布器给每个 v2 generation 都写 `contentReview`，缺字段不可能由当前代码产生，所以只在读取已发布凭证时按旧格式放行。新发布和待推送的凭证仍必须带一份通过的 `contentReview`；带 `contentReview` 但没通过、逐页记录不符、或 HTML 检查的页面集合不完整或不一致的记录一律拒绝。正文审查协议指纹绑定的是当时的审查代码、模型与 Hugo 运行时，当前发布器算不出那个值，所以读取已发布凭证时也不拿当前哈希去比，只要求协议字段相互一致（汇总协议与逐页记录一致，页面与 `generation` 的绑定仍逐页核对）；待推送的凭证仍要求协议等于当前发布器算出的值。

这里的 complete 范围是 `mechanical-html+remote-oid+online-urls`。该验收不查询 GitHub Pages workflow 的 build/deploy，不另查页面标题，也不执行浏览器中的 MathJax/KaTeX 或人工看图。对用户宣告上线前，还须确认部署对应发布提交或保留已审字节的后续提交，核对全部目标页面的正式地址和标题，并保留部署及页面核验记录。需要的事实、浏览器和视觉审查也须按任务完成；不能把机器字段或模型通过当作这些工作已经完成。

## 队列、恢复与升级

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
npm run conference:new:queue -- --dry-run --plan /absolute/path/plan.json
npm run conference:new:queue -- --status --plan /absolute/path/plan.json
npm run conference:new:queue -- --apply --plan /absolute/path/plan.json
```

队列项 `concurrency` 默认 3、范围 1–3；独立 process 的默认 1、范围 1–5 是另一层配置，不能互换。队列发现已发布会议也会进入真实 verify，不仅凭旧发布回执跳过当前线上检查。

阶段抛错或 process 存活状态不明时，队列暂停后续会议并保留阶段、错误和在途结果。只有确认故障解除，才在 `--apply` 命令中显式加 `--retry-failed` 释放暂停和重试条件。普通恢复不清空错误依据，不重新分析完成项，也不能为了显示完成手改状态。

process 会将余额、认证、限流、配置及被分类为系统传输故障的错误记为 `batchFailure`，停止领取后续论文并等待在途结果；已保存记录保留。单篇 Demo 瞬时故障、部分带类型的网络错误和待处理标签不等于系统失败。普通可重试论文默认最多进入 3 次、退避 15 分钟；中断留下的 analyzing 不自动重发，须明确处理。显式 retry 记录释放依据，不能伪装成失败从未发生。筛选和 Python 发布审查的不同派发边界见各自章节。

### 实现变化后的显式迁移

process 的实现指纹来自固定清单，覆盖共享引擎、深度分析、来源核验与来源上下文、JS/Python 论文身份、Reader 修复及表格和资源处理、会议暂存及渲染，以及实际分析、Reader、评分、开源扫描和修复提示词。来源核验那一组是 `conference-source-ledger.js`、`conference-importer.js`、`conference-extraction-receipt.js`、`conference-pdf-source.js` 和 `conference-source-context.js`；它们只进当前指纹，不写进 v1 冻结清单，所以旧记录仍按当时那份清单复算。

已有进展的任务遇到实现变化时，普通 process 会要求显式迁移，不会静默另建 UUID 并整会重新计费。只有旧任务全为 pending、尝试为 0 且没有来源、分析或页面证明时，才允许新实现建立另一命名空间，旧检查点仍保留。多个已进展任务身份相符却有歧义时停止，不能任意选一个。

```bash
npm run conference:new:migrate-process -- --apply \
  --catalog C.json --report R.json --filter FILTER_UUID --from PROCESS_UUID \
  --concurrency 3
```

迁移默认并发 3、范围 1–5，重新核验原来源和固定成员。完成论文先由当前后处理重新生成并核验暂存页，不重新请求模型；未完成论文仍可能继续分析。迁移继续原 UUID 和记录格式，保留原词表身份及已发生的尝试。`--reuse-complete-pages` 另要求重新核验后的页面路径及内容 SHA 不变。需要解除失败限制时可显式加 `--retry-failed`，迁移记录和原来源依据保留。迁移实现与升级来源是不同操作。

### 来源升级需要明确的新分析授权

来源升级先输出绑定原 process、输入 SHA 和当前提取器的计划，再只分析明确选中的论文：

```bash
npm run conference:new:process -- --source-upgrade-plan \
  --catalog C.json --report R.json --filter FILTER_UUID --from PROCESS_UUID
npm run conference:new:process -- --source-upgrade-apply \
  --catalog C.json --report R.json --filter FILTER_UUID --from PROCESS_UUID \
  --plan-sha PLAN_SHA256 --paper-ids 'PAPER_ID_1,PAPER_ID_2' \
  --authorize-new-analysis --concurrency 3
npm run conference:new:process -- --source-upgrade-promote \
  --catalog C.json --report R.json --filter FILTER_UUID --from PROCESS_UUID \
  --plan-sha PLAN_SHA256
```

`PLAN_SHA256` 必须等于刚核对的计划 SHA，`--paper-ids` 只列本会明确授权的新分析对象，`--authorize-new-analysis` 不能省略。未选择的旧成果保留；新提取组使用新的来源依据，不能放宽旧回执或覆写旧文件。来源获取或提取的 generation 不等于论文 `vN` 修订号。

新来源升级计划使用 v2 格式和当前词表字段，随后建立同代的子进程。恢复已有计划时，先核原计划、授权、检查点及父进程对应关系，再按已核格式完整重算；原计划 SHA、尝试次数和已完成结果不能为了恢复而被替换。来源、成员或实现变化使原计划无法完整对应时，程序停止，须重新核对并明确授权新的计划。升级状态及提升记录仍保留各自原格式，不能随计划一起改版本。

子集升级 complete 不等于整会完成。普通 promote 需要全成员升级结果；显式 `--preserve-original-complete` 可保留原完成项，`--prefer-upgrade` 优先用完成的升级项并保留其他原完成项，两者互斥。无论哪种方式，缺少完整可核验结果的成员都会阻止生成新会议结果。返回的新 `processId` 用于后续发布，原 process、分析和发布记录保留。计划没有承诺跨来源复用模型阶段，输入改变时须说明新分析成本。

`--page-repair-mode caption-only` 是另一个明确限定的确定性页面修复选项，只供 source-upgrade 的 plan/promote，要求保留的 process 已完成并有绑定的修复策略；它不等于 source-upgrade-apply 的模型新分析，也不自动授权新成本。不要为普通恢复自行加这些模式参数。

### 工作区、重复文件与锁维护

`npm run conference:new:workspace` 只读报告未提交内容、配置重复定义及进程存活信息。旧 JSON 的 running 不代表当前仍有进程；应依据实际 owner 和锁记录判断。

`npm run storage:pdf-duplicates -- --json` 仅按来源记录声明的哈希报告重复候选，不是逐字节核验或删除授权。`--hash-bytes` 才重新读取全部 PDF 计算哈希，大目录可能耗时较长。会议来源及发布记录受保护，不属于自动 prune 范围。

`npm run conference:new:recover-locks` 会实际回收符合条件的锁，不是只读查询。它只处理程序判定可回收、owner 确认死亡的 process 操作锁；锁格式损坏、进程存活或存活未知时保留并报告跳过，不批量删除锁文件。

## 旧会议来源和隔离执行的维护

以下命令保留 history 角色入口，在当前 daily 工作区通过项目的 `PD_WORKSPACE_ALLOW_CROSS_ROLE=1` 运行，用于维护已有独立会议链。它们不替代新会议 process，也不自动映射历史页面清单的旧 URL 和任务页。旧会议汇总未接入 `history:publication` 的限制只属于该旧入口，不能据此说当前历史直接发布没有会议能力。

一份本机 PDF 的文件名、相似题目或旧博客题目不足以证明论文身份。旧链先固定官方主身份、PDF 字节和匹配依据，再依次发现、筛选、提取、复核、导入、计划及隔离执行。

### 来源账本与只读校验

`conference-source-ledger-v1` 固定一个会议和年份。主身份使用 IEEE `arnumber`、OpenReview `forumId` 或会议官方 paper ID；题目只能帮助人工寻找候选，不作身份或去重键。公开主键使用 `paper-identity-v1` 的完整形式，例如 `conference:icassp:2026:icassp-arnumber:10910001`。短 `sourceIdentity=icassp-arnumber:10910001` 只在账本内定位来源。

账本记录官方 metadata SHA、受控 PDF 的相对路径和字节 SHA、提取文本及结构化证据 SHA、提取器版本、来源和身份审查状态。身份缺失、无全文或来源冲突保持 blocked，不能进入分析或发布。四类来源文件格式未变，所以账本仍为 v1；发现、暂存和导入仍使用各自 v2 格式；新计划、运行及执行状态使用 v3 格式，新筛选状态及配置为 v6，已有 v5 任务按原格式恢复，均须核验完整 `paperId`。早期 `icassp-2026:icassp-arnumber:10910001` 临时 ID 会被拒绝，没有自动运行数据迁移入口。

本机 PDF 和逐篇 metadata 先放 `conference-staging-sources`，提取并复核后由导入器复制到私有 `conference-sources`。账本、缓存、运行状态和本机绝对路径均在 `data/runtime/`，不提交 Git；仓库只跟踪实现、协议、校验器、测试和文档。

```bash
npm run conference:validate-ledger -- --ledger icassp-2026.json
npm run conference:verify-ledger -- --ledger icassp-2026.json
npm run conference:validate-run -- --run icassp-2026-pilot.json --ledger icassp-2026.json
```

这些只读命令只接收私有运行目录直属 `.json` 文件名，不导入、不联网、不调用模型。`verify-ledger` 重验 metadata、PDF、文本及结构化证据原字节 SHA；运行校验还核对指定账本的 SHA、会议身份和成员，手写 `ledgerSha256` 不能代替实际重验。

### 发现、提取与人工复核

先提供官方 metadata 快照和本机 PDF 根做只读 discovery。ICASSP 题目只找候选；ICLR/ICML 按 OpenReview forum ID 精确匹配。发现结果不是 verified，命令也不下载缺失 PDF：

```bash
npm run conference:discover -- --dry-run --adapter icassp --year 2026 \
  --metadata /absolute/papers_2026.json --pdf-root /absolute/papers_2026
```

apply 时 candidate/report 只能给直接文件名，在 `conference-discovery-catalogs` 和 `conference-discovery-reports` 以 `O_EXCL` 创建，不覆盖旧快照：

```bash
npm run conference:discover -- --apply --adapter icassp --year 2026 \
  --metadata /absolute/papers_2026.json --pdf-root /absolute/papers_2026 \
  --candidate-output icassp-2026.json --report-output icassp-2026-report.json
```

旧运行仍须满足前述筛选和完整证据要求，不能拿旧 v4 配置继续混跑。旧 `conference:filter` 和 `conference:filter:run` 在当前工作区通过上述跨角色开关使用。每篇 included PDF 必须在固定的暂存来源根提取，人工复核清单只引用 `paperId`、`sourceIdentity` 和提取回执文件名；暂存重验请求、metadata、PDF、文本、结构化证据和回执的全部字节，不接受手写路径或哈希替代提取。

```bash
npm run conference:extract -- --dry-run --manifest PAPER-extract.json
npm run conference:extract -- --apply --manifest PAPER-extract.json
npm run conference:extract -- --verify --manifest PAPER-extract.json \
  --source-root /absolute/conference-staging-sources

npm run conference:staging -- --dry-run \
  --catalog icassp-2026.json --report icassp-2026-report.json --filter UUID \
  --extraction icassp-2026-reviewed.json \
  --import-output icassp-2026-import.json --receipt-output icassp-2026-staging-receipt.json
```

提取请求及其 metadata、PDF 和输出使用暂存来源根直属文件名，彼此不能混用。以下最小 v2 示例的 `discoveryBinding` 来自已认证目录对应 metadata index 的重验，PDF 须等于唯一 `exact` 候选。当前未实现用于单独解决匹配歧义的回执适配器，`normalized`、`ambiguous` 或 `unmatched` 候选不能进入暂存：

```json
{
  "contract": "conference-pdf-extraction-request-v2",
  "version": 2,
  "paperId": "conference:icassp:2026:icassp-arnumber:10910001",
  "sourceIdentity": "icassp-arnumber:10910001",
  "source": {
    "metadata": {
      "file": "10910001-metadata.json",
      "sha256": "<64-hex-metadata-bytes-sha256>",
      "identityEvidence": {
        "conferenceIdPointer": "/conferenceId",
        "conferenceYearPointer": "/year",
        "identityTypePointer": "/identity/type",
        "identityValuePointer": "/identity/value"
      },
      "discoveryBinding": {
        "catalogSha256": "<64-hex-catalog-file-sha256>",
        "metadataSnapshotSha256": "<64-hex-metadata-snapshot-sha256>",
        "metadataIndex": 0,
        "metadataRecordSha256": "<64-hex-discovery-record-sha256>"
      },
      "provenance": {
        "kind": "official-metadata",
        "locator": "<official-record-locator>",
        "retrievedAt": "2026-09-06T00:00:00.000Z"
      }
    },
    "pdf": {
      "file": "10910001.pdf",
      "sha256": "<64-hex-pdf-bytes-sha256>",
      "provenance": {
        "kind": "official-pdf",
        "locator": "<official-pdf-locator>",
        "retrievedAt": "2026-09-06T00:00:00.000Z"
      }
    }
  },
  "outputs": {
    "textFile": "10910001.txt",
    "artifactsFile": "10910001-artifacts.json",
    "receiptFile": "10910001-extraction-receipt.json"
  },
  "options": {
    "minimumTextCharacters": 5000,
    "normalization": "unicode-nfc-lf-rstrip-v1",
    "pageSeparator": "\n\f\n"
  }
}
```

`--verify` 在临时目录用固定 `PyMuPDF==1.27.2.3` 重新提取，要求文本、视觉证据和回执的新旧字节完全一致。当前提取器为 `2.3.1`，`2.3.0` 及更早解析结果须在新的来源提取组中重新生成并保存，旧文件保留，不能原地覆盖。逐页视觉审计和可定位结构记录也须保留。

Node 的 `loadExtractionHandle()` 返回经核验的结果对象，默认先在临时目录重新提取 PDF。同一次自动 process 的暂存和导入可用 `replay: false` 核对已保存文件的字节、SHA 和抽取凭证，避免重复解析；这不是重新提取。单独运行 verify 只用于诊断，不能代替后续来源检查。

默认提取要求至少 5000 个非空字符。JEP/ICMC 的完整两页短论文使用明确绑定的 3000 字符 profile，仍须完整 PDF、逐页文本、结构化证据和 SHA，不能拿摘要或缺正文记录当短篇全文。

人工复核清单在 `data/runtime/conference-staging-specs/`，成员按 `paperId` 排序，`membersSha256` 绑定整个数组。新 process 的自动验收与这里的人工复核记录不同，不能互相冒充：

```json
{
  "contract": "conference-reviewed-extraction-v2",
  "version": 2,
  "conference": {"id": "icassp-2026", "year": 2026},
  "review": {"actor": "reviewer.1", "reviewedAt": "2026-09-06T00:10:00.000Z"},
  "members": [
    {
      "paperId": "conference:icassp:2026:icassp-arnumber:10910001",
      "sourceIdentity": "icassp-arnumber:10910001",
      "receiptName": "10910001-extraction-receipt.json"
    }
  ],
  "membersSha256": "<64-hex-canonical-members-sha256>"
}
```

核对 dry-run 后才把暂存步骤改为 `--apply`。它在 `conference-staging` 以 `O_EXCL` 保存导入清单及回执，不复制来源或调用模型。

### 导入与固定运行计划

导入只接收暂存的两份文件及完整 discovery/filter 依据，不再接受任意 `--manifest`、`--source-root` 或 `--cache-root`：

```bash
npm run conference:import -- --dry-run \
  --import icassp-2026-import.json --receipt icassp-2026-staging-receipt.json \
  --filter UUID --catalog icassp-2026.json --report icassp-2026-report.json \
  --updated-at 2026-09-06T00:00:00.000Z --ledger-output icassp-2026-ledger.json
```

确认后改为 `--apply`。导入器从配置的暂存来源根读取认证文件，复制到 `conference-sources`，在 `conference-ledgers` 以 `O_EXCL` 保存账本和自动命名的 `icassp-2026-ledger.import-receipt.json`。

新计划使用 `conference-run-plan-v3`，保存在 `conference-ledgers`。计划逐项列出全部已入选且来源核验通过的论文身份、标签词表 SHA，以及没有重叠的处理分片。可以按主题、会议场次或编号分组，但不能遗漏或重复论文：

```json
{
  "contract": "conference-run-plan-v3",
  "version": 3,
  "ledgerName": "icassp-2026-ledger.json",
  "tagMetadata": {
    "version": "paper-tag-catalog-v2",
    "sha256": "<64-hex-current-tag-catalog-file-sha256>"
  },
  "selectionPolicy": {
    "contract": "conference-selected-members-v2",
    "identities": [
      {
        "paperId": "conference:icassp:2026:icassp-arnumber:10910001",
        "sourceIdentity": "icassp-arnumber:10910001"
      }
    ],
    "selectedMemberSetSha256": "<SHA-256-of-sorted-canonical-paperId-array>"
  },
  "shards": [
    {
      "shardId": "part-001",
      "paperIds": ["conference:icassp:2026:icassp-arnumber:10910001"]
    }
  ]
}
```

创建运行仍核验全部上游记录：

```bash
npm run conference:plan -- --dry-run \
  --catalog icassp-2026.json --report icassp-2026-report.json --filter UUID \
  --import icassp-2026-import.json --staging-receipt icassp-2026-staging-receipt.json \
  --ledger icassp-2026-ledger.json --import-receipt icassp-2026-ledger.import-receipt.json \
  --plan icassp-2026-plan.json --run icassp-2026-run.json
```

确认后改为 `--apply`。生成的运行记录使用 `conference-run-v3`，它和自动命名的 `icassp-2026-run.plan-receipt.json` 在 `conference-runs` 成对创建，不可覆盖。运行分别固定账本、`filterPolicySha256`、`selectionReceiptSha256`、`selectedMemberSetSha256` 和标签版本，不能用一个 `selectionPolicySha256` 混指规则、筛选结果及成员集合。

当前计划凭证使用 `conference-run-plan-secure-receipt-v3`，计划和凭证中的词表记录为 `tagMetadata`；运行和执行模板中的词表版本为 `tagCatalogVersion`。旧 v2 文件对先按原文件字节和完整上游关系核验，再供已有任务恢复，不能把裸旧计划用于创建新的执行 UUID。新旧字段不能混用，即使值相同或为空。

### 隔离 execution 的创建与恢复

`prepare` 不能只使用手写的运行记录，必须核验已审计划和完整上游记录。新执行状态使用 `conference-execution-v3`，权限记录仍使用 `conference-execution-authority-v2`，两者分别核验版本。已有旧执行 UUID 可以按原格式继续；只有初始状态且未产生尝试记录的合法中断，才可补齐缺少的权限记录：

```bash
npm run conference:execution -- prepare \
  --run icassp-2026-run.json --plan-receipt icassp-2026-run.plan-receipt.json \
  --plan icassp-2026-plan.json --ledger icassp-2026-ledger.json \
  --import-receipt icassp-2026-ledger.import-receipt.json \
  --import icassp-2026-import.json --staging-receipt icassp-2026-staging-receipt.json \
  --filter UUID --catalog icassp-2026.json --report icassp-2026-report.json \
  --execution 00000000-0000-4000-8000-000000000001
```

状态及不可变 `authority.json` 位于 `data/runtime/conference-executions/<UUID>/`。该文件固定计划回执、run 文件、导入回执、筛选规则、选择回执和最终成员集合，每次 status/transition 都须重新提供完整参数并重验，不能只读状态文件继续。

创建顺序为 `patches/ → 初始 state.json → authority.json`。prepare 只恢复可由当前计划完整证明的空目录、空 `patches/` 或没有尝试记录的初始 `state.json` 单件。孤立 `authority.json` 无法区分创建中断与状态被删，因此拒绝重建 pending；未知文件、非空孤立 patch、符号链接和字节变化也停止。

并发进程已创建相同 `authority.json` 时，失败方只重验完整文件组，不回滚共享文件。其他创建错误只清理由本进程记录、且当前 dev/ino/size/SHA 仍与写入描述符一致的文件或目录。操作锁、状态 SHA 比较及受控补丁保证可恢复，不能删除记录绕过检查。

transition 只读 execution `patches/` 直属 JSON。`expectedStateSha256` 使用当前 status 对应值，`operationId` 不可复用于不同字节。来源就绪补丁如下；没有完成证明包（completion-proof bundle）时，手写 completed 一定被拒绝：

```json
{
  "operationId": "11111111-1111-4111-8111-111111111111",
  "expectedStateSha256": "<64-hex-current-execution-state-sha256>",
  "paperId": "conference:icassp:2026:icassp-arnumber:10910001",
  "nextState": {
    "status": "source_ready",
    "usage": {}
  }
}
```

```bash
npm run conference:execution -- status \
  --run icassp-2026-run.json --plan-receipt icassp-2026-run.plan-receipt.json \
  --plan icassp-2026-plan.json --ledger icassp-2026-ledger.json \
  --import-receipt icassp-2026-ledger.import-receipt.json \
  --import icassp-2026-import.json --staging-receipt icassp-2026-staging-receipt.json \
  --filter UUID --catalog icassp-2026.json --report icassp-2026-report.json \
  --execution UUID
npm run conference:execution -- transition --execution UUID \
  --run icassp-2026-run.json --plan-receipt icassp-2026-run.plan-receipt.json \
  --plan icassp-2026-plan.json --ledger icassp-2026-ledger.json \
  --import-receipt icassp-2026-ledger.import-receipt.json \
  --import icassp-2026-import.json --staging-receipt icassp-2026-staging-receipt.json \
  --filter UUID --catalog icassp-2026.json --report icassp-2026-report.json \
  --patch source-ready-10910001.json --owner worker.1
```

旧 `conference:analyze` 复用共享分析和 Reader，`conference:postprocess paper|aggregate` 重验完成记录、当前标签和完整选择集合。它们在通用会议页面路径生成私有单篇及汇总，未绑定历史页面清单的旧 URL 和任务页，因此不能直接声称旧历史页已重写或已发布。

生产来源入口 `conference-source-context-v2` 只接受校验器返回的受控 `planHandle`、完整 `paperId` 及受控根，绑定 plan/import/filter 回执。不导出仅用账本、运行和执行状态拼造的低层入口，也不返回 `analysisReady=true` 的测试上下文。metadata、PDF、全文和解析证据仍须逐字节重验；来源 SHA 不含可变的执行状态，观察状态另有 SHA。它不接受任意全文、旧博客、arXiv 替代获取或外部图片下载。

会议页独立使用 `conference` scope，不伪装成某一天日更。汇总至少说明目录总数、身份已核数、来源可用数、深度分析完成数、未纳入或阻断原因，以及按唯一会议身份统计的任务分布；长篇解读只放单篇。blocked、未完成或未分类成员不能进入可发布汇总。

## 与全历史重写的衔接

单个既有日批次可查 [`rewrite:source`](fresh-rewrite.md)。全历史会议页优先走 `history:conference-local-sources → history:direct-inputs → history:conference-projections → history:direct-plan` 后进入直接重写队列，不要求先跑旧账本或执行状态，也不把旧全文、任意路径或旧解读直接塞进正式分析。

会议来源只读取本地来源清单已绑定的 metadata/PDF SHA 和冻结页面对应记录，本轮解读所需图片从 PDF 在系统临时目录准备。本地文件缺失或损坏只使该项失败，不转入来源对照表（crosswalk）或备用 arXiv 获取。arXiv 来源根据冻结页的单一 arXiv 线索，每个新的来源获取序号都重新获取官方文本、PDF、runtime metadata 和 manifest；同一获取序号恢复时，先核验并复用原四文件。只有明确命名的 arXiv 新获取失败交接才能进入来源对照表，不能任意调用备用链。只有当前官方 PDF 返回 404 后才可尝试同 ID 历史版本，文本须来自实际选中 PDF，引用使用核验的 `sourceVersion`，不能把获取序号当论文修订号或猜成 `v1`。

ICML/OpenReview 替代 PDF 默认拒绝，不能以相似题目替换来源。经用户授权的跨标题预印本例外仅为 `conference:icml:2026:openreview-forum-id:n1mAjfRDZ6`，由代码白名单绑定 poster/forum、固定 SSRN 题目与作者、DOI 及 PDF、凭证和来源的 SHA。浏览器文件只经受控 `--import-file` 导入，记录 `networkResponseObserved: false`；计划、模型输入和页面都须显示不是会议 camera-ready 定稿，不能推广到其他论文。完整来源和发布要求见历史文档。

当前历史直接发布已有计划、生成、独立审查和精确发布入口，维护旧 URL、会议汇总和任务页。旧 `history:publication` 的私有输出不能代替它；独立 `activate --apply` 已禁用，`publish --apply` 在共享锁内完成交接、提交、推送和远端核验。具体参数及中断恢复见[历史直接发布](history-direct-publication.md)，不据旧分支的未完成说明跳过当前流程。

每篇仍只允许一个写入者，请求用量和检查点保留；来源、Reader 或标签规则变化按实际指纹及迁移要求处理，不无限复用旧通过。每次直接重写的质量审查都是正常阶段，不能当作可省略的试点。发布范围是否排除视觉或允许豁免取决于用户明确要求，命令示例不能代替用户授权或决定；Git 到达远端仍不能替代部署和页面核验。
