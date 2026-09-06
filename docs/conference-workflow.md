# 会议论文：受控来源、分片重写与汇总

状态：`conference-source-ledger-v1` 与 `conference-run-v2` 是主分支中的基础
契约。它们用于把已下载的会议 PDF 变成可审计的**候选来源**；它们不自动调用
模型、不负责下载论文、不自动改历史页面，也不把某个会议全集自动发布到博客。
source ledger 继续保留 v1 是因为其四类来源工件格式未变；所有携带 canonical `paperId`
的 discovery/filter/staging/import plan/run/execution 合同均已升级为 v2。

## 为什么不能把会议 PDF 当作普通日更

默认日更的身份和来源是 arXiv 批次。历史会议页中存在没有可靠 arXiv ID 的记录；
而一份本机 PDF 的文件名、标题相似度或旧博客标题都不足以证明它与某篇页面是同一
论文。会议论文必须先冻结会议主身份、PDF 字节和与历史页面的匹配证据。

```text
会议元数据 + 本机 PDF
  → discovery → filter → PDF extract → reviewed staging
  → 受控 PDF 缓存 + source ledger（身份、SHA、来源状态）
  → plan → 隔离 execution
  → 同源 fresh analysis / Reader / 评分
  → taxonomy 证据 sidecar
  → 独立论文页
  → 确定性会议汇总投影
  → generate → review → push（远端 main OID）
```

会议汇总不会重新让模型总结整批论文：它只消费已经通过来源和 Reader 门禁的单篇
投影，因此每篇深度理解只生成一次。

## `conference-source-ledger-v1`

每个 ledger 固定一个会议与年份，并对每个成员记录：

- 主身份：IEEE `arnumber`、OpenReview `forumId` 或会议官方 paper ID；标题只可作
  人工发现候选，不能充当身份或去重键。公开 `paperId` 是
  `conference:<slug>:<year>:<scheme>:<value>`；短形式 `sourceIdentity` 只用于 ledger 定位。
- 官方元数据的 SHA、受控缓存内 PDF 的相对路径与字节 SHA、提取文本 SHA、结构化
  工件 SHA、提取器版本。
- 明确的来源/身份审查状态和证据。无身份、无全文或来源冲突必须保持 blocked，不能
  被投影为可分析或可发布。

本机 PDF 与逐篇 metadata 先放入 `conference-staging-sources`，通过提取、复核后再由 importer
复制到项目控制的 `conference-sources` 私有缓存。账本、缓存、运行
状态和绝对本机路径均是运行数据，位于 `data/runtime/`，不会提交 Git；提交到 `main`
的是契约、校验器、CLI、测试和文档。

当前只读维护命令为：

```bash
npm run conference:validate-ledger -- --ledger icassp-2026.json
npm run conference:verify-ledger -- --ledger icassp-2026.json
npm run conference:validate-run -- --run icassp-2026-pilot.json --ledger icassp-2026.json
```

名称只能是对应私有运行目录下的直接 `.json` 文件名；命令不接收任意路径、不导入文件、
不联网、不调用模型。`verify-ledger` 会重放账本中 metadata、PDF、文本与结构化工件的
字节 SHA。run 校验还会重放指定 ledger 的 SHA、会议身份和可执行成员，不能只靠
手写的 `ledgerSha256` 字段通过。

## P1：显式导入与隔离执行

在导入前，先把会议官方 metadata 快照与本机 PDF 目录做只读 discovery。ICASSP 的标题
只能寻找候选文件；ICLR/ICML 只按 OpenReview forum ID 精确匹配。discovery 的任何结果
都不是 `verified`，这个命令也不会下载缺失 PDF：

```bash
npm run conference:discover -- --dry-run --adapter icassp --year 2026 \
  --metadata /absolute/papers_2026.json --pdf-root /absolute/papers_2026
```

apply 时只提供直接文件名，程序会把 candidate/report 分别写入配置的
`data/runtime/conference-discovery-catalogs` 与 `conference-discovery-reports`，且 O_EXCL
不覆盖已有快照：

```bash
npm run conference:discover -- --apply --adapter icassp --year 2026 \
  --metadata /absolute/papers_2026.json --pdf-root /absolute/papers_2026 \
  --candidate-output icassp-2026.json --report-output icassp-2026-report.json
```

筛选的状态合同为 `conference-filter-v3`。它绑定完整 discovery catalog、逐篇 source
SHA、选择策略、Prompt、模型/协议和 taxonomy registry SHA；included、excluded、
pending、failed 四种决定彼此独立，只有全集无 pending/failed 才能 complete。当前
`conference:filter` 管理状态与显式人工 decision；`conference:filter:run` 才是唯一生产 LLM
入口。runner 逐篇重放官方 metadata record、catalog/source SHA、spec/prompt/model/endpoint/taxonomy，
统一通过固定的 `requestLlmJson()` 使用项目代理和 sticky 账号池。每篇先在全局单飞锁内 O_EXCL
保存请求 intent，网络返回后保存 terminal HTTP 原始响应、provider usage 及各物理请求的 usage-ledger
事件绑定，再生成 decision artifact 并应用 CAS：

```bash
npm run conference:filter -- prepare --catalog NAME.json --report REPORT.json --spec NAME.json
npm run conference:filter:run -- --apply --catalog NAME.json --report REPORT.json --spec NAME.json \
  --filter UUID --owner filter.worker [--limit N] [--retry-failed]
npm run conference:filter -- status --filter UUID
npm run conference:filter -- apply --filter UUID --decision DECISION.json --owner OPERATOR
```

最终 included/excluded 必须绑定受控 decision artifact；LLM 决定要求真实请求/响应字节、
模型/协议和非零逻辑请求 usage，manual 决定使用独立 actor，不得冒充模型。普通
`buildDecisionArtifact` 和 `conference:filter apply` 都拒绝 LLM actor；生产 signer 不接收 transport
函数注入，只能消费固定公共路由形成的私有证据。请求中断后先恢复已有 receipt/artifact；若 intent
存在但终态响应不可知，则保守记为 typed `failed`，绝不自动重复计费。pending 总是优先；failed
只有显式 `--retry-failed`、超过五分钟退避且累计少于三次时才可重试。只有 usage 完整、输出非零且
严格 JSON 的 `included`/`excluded` 才成为终态。账号池切换前的响应无法由公共 wrapper 提供完整 raw，
因此 decision receipt 保存各物理请求的 usage-ledger event SHA，terminal raw 单独保存；不可得状态不得
伪装成完整响应。筛选 complete 后生成只包含 included 身份的 selection receipt。

filter spec 放在 `data/runtime/conference-filter-specs/`。最小 v2 形状如下；所有 SHA 都必须由
对应原始字节或规范化对象真实计算，下面的占位符故意不能直接通过校验：

```json
{
  "contract": "conference-filter-spec-v3",
  "version": 3,
  "filterPolicySha256": "2b96a65d4069a84ec1592d5d6893af6a84107ab30822ebd0ff8a2b305946ffde",
  "promptSha256": "657342ff5deae423d50bbd4835c7e479b2d1abe3f88d1d8bcd8950483c95f396",
  "model": "muse-spark-1.2-contributor",
  "endpointProtocol": "openai-responses",
  "endpointIdentitySha256": "4de319c45169889bd6be02e65d8a8eec1003647910ba0a54490345ae52276af3",
  "taxonomyRegistrySha256": "<64-hex-current-registry-bytes-sha256>"
}
```

`endpointIdentitySha256` 是 `endpointIdentitySha256(endpoint, model)` 对公共路由最终规范 API URL
UTF-8 字节计算的 SHA-256；它不包含 API key。endpoint、协议或模型任一漂移都必须重新 prepare
新的 filter，不能在旧状态上混跑。

每篇 included 论文随后必须在固定的 `conference-staging-sources` 目录内执行 PDF 提取，
并由人工复核清单只引用 `paperId`、`sourceIdentity` 和 extraction receipt 文件名。staging
会重放 request、metadata、PDF、文本、weak artifact 和 receipt 的全部字节与 SHA；不能
手写路径或哈希绕过提取：

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

extraction request 与其 metadata/PDF/输出都使用 staging source 根下的直接文件名。ICASSP
示例的最小 v2 形状如下；`discoveryBinding` 必须来自已认证 discovery 对该 metadata index 的
重放，PDF 必须等于唯一 `exact` 候选。当前没有 resolution receipt adapter，因此
`normalized`、`ambiguous` 和 `unmatched` 候选不能进入 staging。

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

`--verify` 不信任已有派生文件：它在临时目录用固定 `pypdf==6.17.0` 重新提取，并要求新旧
text/artifact/receipt 字节完全一致。Node extraction handle 每次加载 receipt 都会内部执行
这条验证；staging 创建、staging 重载以及 importer 消费 staging handle 时又会逐篇重放，
所以人工单独运行 `--verify` 只用于诊断，不能代替后续门禁。

人工复核清单放在 `data/runtime/conference-staging-specs/`，只引用 canonical `paperId`、locator
`sourceIdentity` 与已经生成的 receipt；成员按 `paperId` 排序，`membersSha256` 绑定整个数组：

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

确认所有 dry-run 后，把 `conference:staging` 的 `--dry-run` 改为 `--apply`。apply 只在配置的 `conference-staging` 目录以
O_EXCL 写入 import manifest/receipt；它不复制来源、不调用模型。

生产导入只接收刚才的 staging 双文件及完整 discovery/filter 证明，不再接受任意
`--manifest`、`--source-root` 或 `--cache-root`：

```bash
npm run conference:import -- --dry-run \
  --import icassp-2026-import.json --receipt icassp-2026-staging-receipt.json \
  --filter UUID --catalog icassp-2026.json --report icassp-2026-report.json \
  --updated-at 2026-09-06T00:00:00.000Z --ledger-output icassp-2026-ledger.json
```

确认后改为 `--apply`。导入器只从配置的 staging source 读取被认证文件，复制进
`conference-sources`，并在 `conference-ledgers` 中以 O_EXCL 同时写 ledger 和自动命名的
`icassp-2026-ledger.import-receipt.json`。

导入后必须准备一份 `conference-run-plan-v2` 计划文件放在 `conference-ledgers`。它要
精确列出全部 included 且 verified 的身份、当前 taxonomy SHA 和无重叠完整分片。创建
run 时仍需重放全部上游凭证：

```json
{
  "contract": "conference-run-plan-v2",
  "version": 2,
  "ledgerName": "icassp-2026-ledger.json",
  "taxonomy": {
    "version": "paper-taxonomy-v1",
    "sha256": "<64-hex-current-registry-bytes-sha256>"
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

```bash
npm run conference:plan -- --dry-run \
  --catalog icassp-2026.json --report icassp-2026-report.json --filter UUID \
  --import icassp-2026-import.json --staging-receipt icassp-2026-staging-receipt.json \
  --ledger icassp-2026-ledger.json --import-receipt icassp-2026-ledger.import-receipt.json \
  --plan icassp-2026-plan.json --run icassp-2026-run.json
```

确认后改为 `--apply`。run 与自动命名的 `icassp-2026-run.plan-receipt.json` 会在
`conference-runs` 中成对、不可覆盖地写入。

execution prepare 同样不能只拿一份手写 run；它必须重放 reviewed plan 和整个上游链：

```bash
npm run conference:execution -- prepare \
  --run icassp-2026-run.json --plan-receipt icassp-2026-run.plan-receipt.json \
  --plan icassp-2026-plan.json --ledger icassp-2026-ledger.json \
  --import-receipt icassp-2026-ledger.import-receipt.json \
  --import icassp-2026-import.json --staging-receipt icassp-2026-staging-receipt.json \
  --filter UUID --catalog icassp-2026.json --report icassp-2026-report.json \
  --execution 00000000-0000-4000-8000-000000000001
```

状态文件与不可变 `authority.json` 放在 `data/runtime/conference-executions/<UUID>/`。authority
绑定 plan receipt 文件 SHA、run 文件 SHA、import receipt、筛选策略、筛选结果 receipt 和最终成员集；
每次 status/transition 都必须重新提供上面 prepare 的完整参数链并逐次重放，不能只凭一份 execution
state 继续推进。创建顺序固定为 `patches/ → 初始 state.json → authority.json`；prepare 只会
自愈可由当前 plan authority 完整证明的空目录、空 `patches/` 或无 attempt 的初始
`state.json` 单件。`authority.json` 单件无法区分创建中断与已推进 state 被删除，因此一律
失败关闭，绝不重建 pending；未知文件、非空孤立 patch、symlink 或任一字节漂移也都会失败关闭。
并发 writer 已经落下同一 authority 时，失败方只重放完整 bundle，绝不回滚共享文件；其他创建
错误的 cleanup 只删除本进程记录且当前 `dev/ino/size/SHA` 仍与写入描述符一致的文件和目录。
目录使用锁、状态 SHA CAS 和受控 patch 保证可恢复。当前仍没有模型分析、Reader、production taxonomy、completion proof
或会议博客发布器；`completed` transition 和 publishable aggregate 会主动失败关闭。

`transition` 只读取 `data/runtime/conference-executions/<UUID>/patches/` 下的直接 JSON 文件。
首个来源就绪 patch 的最小形状如下；`expectedStateSha256` 必须取当前 status 输出对应状态，
`operationId` 不可复用给不同字节。当前不要构造 `completed`：没有 completion-proof bundle 时
它一定失败。

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

会议全文生产入口是 `conference-source-context-v2`：只接受 opaque `planHandle`、canonical
`paperId` 和受控 source root，并把 plan/import/filter receipt 写入 production authority
binding。生产模块不导出 ledger + run/execution 的低层 context builder，也不会返回
`analysisReady=true` 的 test-only context。
生产入口仍会重放 metadata/PDF/text/artifact 字节；可靠正文达到门槛即可分析。固定 pypdf
重提取只证明 text-only weak artifact 的字节来源，不会凭空恢复 TeX、表格 DOM 或图片像素，
因此公式、表格和图片能力仍为 unavailable。稳定 source SHA 不包含可变 execution 状态，
观察状态另有独立 SHA。它不接受任意全文、旧博客文本、arXiv fallback 或外部图下载。

PDF 是弱结构来源：不能可靠复原原始 TeX 时，不展示“可验证公式”；不能定位完整表格
和数值时，不展示表格；图片必须记录页码/图号及工件 SHA。不得从旧博客正文反向补造
这些证据。

## `conference-run-v2`

所有 discovery 下游 `paperId` 都使用 `paper-identity-v1` 的完整 canonical ID，例如
`conference:icassp:2026:icassp-arnumber:10910001`。`sourceIdentity` 仍是 ledger 内部定位符
`icassp-arnumber:10910001`，不能替代论文主键。早期形如
`icassp-2026:icassp-arnumber:10910001` 的临时 ID 已由 v2 合同拒绝，且没有运行数据迁移入口。

一个会议运行分别冻结 ledger、`filterPolicySha256`、`selectionReceiptSha256`、
`selectedMemberSetSha256` 和 taxonomy 版本，禁止再用一个 `selectionPolicySha256` 混指
筛选规则、筛选结果或成员集合。成员可
按主题、session 或连续编号分片，但分片必须不重叠且完整覆盖固定成员清单。论文状态为
来源、分析、分类、发布的逐层状态；`blocked`、未完成或尚未分类的成员不会进入可发布
聚合输入。

会议页是独立 `conference` scope，不伪装成某一天的日更。它至少应说明目录总数、身份
已核数、来源可用数、深度理解完成数、未纳入/阻断原因，以及按唯一会议身份统计的任务
分布。长文解读仍只放在单篇页。

## 与历史重写的关系

已有完整 arXiv 原文、数据闭环和简单发布拓扑的历史日期，可继续使用
[`rewrite:source`](fresh-rewrite.md)。会议记录必须先经过 ledger 和本地 PDF 来源适配器；
不能临时把 `fullText`、文件路径或旧 Reader 文本塞进 canonical。

历史重写的顺序是：来源身份闭合 → source-only 重写 → 事实/分类审核 → promotion →
旧发布凭证交接 → generate/review/push。旧 URL 与旧 receipt 不能被删除或覆盖。

## Token 与批次控制

先从覆盖不同会议、PDF 质量、任务类型与页面长度的小批试点开始。每次请求都使用既有
用量账本和 checkpoint；来源 SHA、Reader 或 taxonomy 规则发生变化才失效必要下游。
不要依据历史页面数量或一次会议目录总数直接启动全量模型调用。
