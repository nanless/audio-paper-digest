# 会议论文：官方抓取、日更同源深度理解与汇总

## 2026 新会议路线（daily workspace）

新会议不是一套“只抓标题和 PDF”的旁路。它只在来源入口上区别于 arXiv 日更，进入
分析后必须复用同一套 `analysis-engine.js`、13 个 canonical 一级标题、类型感知八维评分、
`beginner-researcher-v3` Reader、`api-reader-source-bindings-v4` 和 current taxonomy。
`conference-postprocess` 也必须重放 Reader、评分审计和 taxonomy assignment，输出包含
中英文题目、分档、文档类型、八维评分、作者机构、资源状态、官方 record/PDF 链接与
current taxonomy compat 的单篇页及 `reader-facing-v3` 风格会议汇总。新增页面不能沿用
旧标签或会议自造标签。

```text
官方 2026 proceedings index
  → catalog receipt + strict metadata + 逐 PDF receipt/SHA
  → official-proceedings discovery（精确 paper ID ↔ pdfFile）
  → 与日更等价的 LLM 筛选
  → PDF extraction / reviewed staging / import / plan / execution
  → 共享多阶段全文分析、评分审计、Reader v3、current taxonomy
  → conference page staging + reader-facing-v3 aggregate
```

当前官方 acquisition provider：

- 语音/音频/音乐：`odyssey-2026`、`iwslt-2026`、`eusipco-2026`、`nime-2026`、
  `dafx-2026`；
- AI/ML/CV/NLP：`aaai-2026`（OJS volume 40）、`aistats-2026`（PMLR v300）、`uai-2026`（PMLR v337）、
  `cvpr-2026`（CVF main）、`acl-2026`、`eacl-2026`；
- ACL/EACL 只纳入主会 `long`、`short` 和 `findings`，卷首、全集 PDF、workshop 与
  非论文演讲不会冒充单篇论文；Odyssey keynote 摘要页同样排除。

AAAI 2026 的 volume 40 是 48 个独立 OJS issue，而 `/issue/current` 只指向其中一期。
`aaai-2026 catalog` 因此只接受代码中固定的 48 个官方 issue URL；每一期分别封存
`responses/issues/issue-NN-OJSID.html` 与 response receipt。只有 48 对响应/收据全部可重放、
issue 标题与 volume/no. 闭合、跨 issue 官方 article ID 唯一时，才写聚合 `metadata.json`
与 catalog receipt。中断后可重跑恢复已完成的 issue pair；单期响应永远不能生成全集 catalog。

acquisition 固定写入
`data/runtime/official-conference-acquisitions/<provider>/`，CLI 不接受任意输出根。
目录、PDF 与收据使用私有权限；索引及每篇 PDF 都绑定官方 URL、响应、字节数和
SHA-256，并支持只恢复已封存的完整 pair：

```bash
npm run conference:new:acquire -- catalog \
  --provider iwslt-2026 --conference-id iwslt-2026 --year 2026 --apply
npm run conference:new:acquire -- download \
  --provider iwslt-2026 --conference-id iwslt-2026 --year 2026 --apply --concurrency 4 --retries 3
npm run conference:new:acquire -- verify \
  --provider iwslt-2026 --conference-id iwslt-2026 --year 2026
```

`download` 默认并发为 1、瞬时网络重试为 0；大批量可显式使用 `--concurrency 1..5` 和
`--retries 0..5`。重试只覆盖 socket/timeout/429/5xx，并保持同一官方 URL。每个 worker 仍只写自己
认领的 paper ID，并在任一失败后停止领取新任务、等待在途任务封存完毕，再返回失败，
因此重新运行同一命令只会恢复完整 pair 并补齐缺项。

下载完成后，`--pdf-root` 必须指向 provider 根（不是其 `pdfs/` 子目录），因为 metadata
中的 `pdfFile` 是 `pdfs/<official-id>.pdf`：

```bash
npm run conference:new:discover -- --apply \
  --adapter official-proceedings --conference-id iwslt-2026 --year 2026 \
  --metadata "$PWD/data/runtime/official-conference-acquisitions/iwslt-2026/metadata.json" \
  --pdf-root "$PWD/data/runtime/official-conference-acquisitions/iwslt-2026" \
  --candidate-output iwslt-2026.json --report-output iwslt-2026-report.json
```

后续来源阶段用相同参数合同运行 `conference:new:filter*`、`conference:new:extract`、
`conference:new:staging`、`conference:new:import` 和 `conference:new:plan`；深度处理只运行
`conference:new:process`。`conference:new:execution`、`conference:new:analyze` 和
`conference:new:postprocess` 是已禁用的旧旁路，调用时会明确失败。新会议入口只在已绑定
`daily` 的本工作区并由 wrapper 显式签发 new-conference mode 时放行；原有 `conference:*`
仍只属于 history workspace。

会议 PDF 当前是可验证的全文、但结构能力仍标为 `weak`：文本可进入同一深度理解和
Reader/评分流程；没有结构化 DOM/TeX/像素证据时，表格、公式或 Figure 必须显示不可得，
不能猜测或冒充与 arXiv HTML 完全等价。认证的 weak source 会签发
`conference-reader-weak-unavailable-structure-v1`，强制 Reader 的 `tableBindings`、
`formulaBindings`、`figurePlacements` 均为空，并把定量结果和公式含义改用可核对的自然段表达；
这不会放宽日更 Reader v3/source-bindings v4。这里的 postprocess 产物仍是 runtime staging，
不代表博客 generate/review/push 已获授权。

状态：`conference-source-ledger-v1` 与 `conference-run-v2` 是主分支中的基础
契约。它们用于把已下载的会议 PDF 变成可审计的**候选来源**；它们不自动调用
模型、不负责下载论文、不自动改历史页面，也不把某个会议全集自动发布到博客。
source ledger 继续保留 v1 是因为其四类来源工件格式未变；所有携带 canonical `paperId`
的 discovery/filter/staging/import plan/run/execution 合同均已升级为 v2。

历史全量重写不等待这条 legacy conference execution 链：已有本地 metadata/PDF 的冻结历史页走
`history:conference-local-sources → history:direct-inputs → history:conference-projections → history:direct-plan`
后进入 direct 队列。`direct-inputs` 的 arXiv route 直接来自冻结页已有的单一 arXiv hint，且每个 generation
新拉、封存官方 TXT、PDF、runtime metadata 与 manifest；会议 route 才消费这里的本地 PDF、metadata SHA 与
冻结页 frontmatter title fingerprint。图像仅由本次 Reader 在系统临时目录从 PDF 物化；缺失或损坏的本地会议
输入会使该 direct item 失败关闭，绝不转入 crosswalk。只有 named arXiv fresh acquisition failure handoff
可以进入 crosswalk。

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

筛选的状态合同为 `conference-filter-v5`。它绑定完整 discovery catalog、完整 authenticated
evidence catalog/report、逐篇 evidence receipt 与 locator、逐篇 source SHA、选择策略、Prompt、
模型/协议和 taxonomy registry SHA；included、excluded、
pending、failed 四种决定彼此独立，只有全集无 pending/failed 才能 complete。当前
`conference:filter` 管理状态与显式人工 decision；`conference:filter:run` 才是唯一生产 LLM
入口。runner 逐篇重放官方 metadata record、catalog/source SHA、spec/prompt/model/endpoint/taxonomy，
统一通过固定的 `requestLlmJson()` 使用项目代理和 sticky 账号池。每篇先在全局单飞锁内 O_EXCL
保存请求 intent，网络返回后保存 terminal HTTP 原始响应、provider usage 及各物理请求的 usage-ledger
事件绑定，再生成 decision artifact 并应用 CAS：

```bash
npm run conference:new:filter -- spec --catalog NAME.json --report REPORT.json \
  --evidence-run EVIDENCE_RUN_UUID --output CONFERENCE-FILTER-V5.json
npm run conference:new:filter -- prepare --catalog NAME.json --report REPORT.json \
  --evidence-run EVIDENCE_RUN_UUID --spec CONFERENCE-FILTER-V5.json
npm run conference:new:filter:run -- --apply --catalog NAME.json --report REPORT.json \
  --evidence-run EVIDENCE_RUN_UUID --spec CONFERENCE-FILTER-V5.json \
  --filter UUID --owner filter.worker [--limit N] [--retry-failed]
npm run conference:new:filter -- status --filter UUID
npm run conference:new:filter -- apply --filter UUID --decision DECISION.json --owner OPERATOR
```

最终 included/excluded 必须绑定受控 decision artifact；LLM 决定要求真实请求/响应字节、
模型/协议和非零逻辑请求 usage，manual 决定使用独立 actor，不得冒充模型。普通
`buildDecisionArtifact` 和 `conference:filter apply` 都拒绝 LLM actor；生产 signer 不接收 transport
函数注入，只能消费固定公共路由形成的私有证据。请求中断后先恢复已有 receipt/artifact；若 intent
存在但终态响应不可知，则保守记为 typed `failed`，绝不自动重复计费。pending 总是优先；failed
只有显式 `--retry-failed`、超过五分钟退避且累计少于日更 `FILTER_CONFIG.maxRetries`（当前为五次）时才可重试；OpenAI Responses 从第二次 durable attempt 起与日更一样将输出预算提升到 4096 tokens。只有 usage 完整、输出非零且
严格 JSON 的 `included`/`excluded` 才成为终态。账号池切换前的响应无法由公共 wrapper 提供完整 raw，
因此 decision receipt 保存各物理请求的 usage-ledger event SHA，terminal raw 单独保存；不可得状态不得
伪装成完整响应。筛选 complete 后生成只包含 included 身份的 selection receipt。

filter spec 放在 `data/runtime/conference-filter-specs/`。v5 spec 只能由上述 `spec` 命令从同一会议的
authenticated discovery pair 和 complete evidence run 生成，不能跨会议共享。其形状如下；所有 SHA 都必须由
对应原始字节或规范化对象真实计算，下面的占位符故意不能直接通过校验：

```json
{
  "contract": "conference-filter-spec-v5",
  "version": 5,
  "filterPolicySha256": "<64-hex-current-policy-sha256>",
  "promptSha256": "<64-hex-current-prompt-sha256>",
  "model": "muse-spark-1.3-contributor",
  "endpointProtocol": "openai-responses",
  "endpointIdentitySha256": "4de319c45169889bd6be02e65d8a8eec1003647910ba0a54490345ae52276af3",
  "taxonomyRegistrySha256": "<64-hex-current-registry-bytes-sha256>",
  "evidenceCatalogContract": "conference-filter-evidence-catalog-v1",
  "discovery": {
    "contract": "conference-discovery-catalog-v2",
    "conferenceId": "iwslt-2026",
    "catalogSha256": "<64-hex-discovery-catalog-file-sha256>",
    "reportSha256": "<64-hex-discovery-report-sha256>",
    "candidateSetSha256": "<64-hex-normalized-filter-candidate-set-sha256>"
  },
  "evidence": {
    "runId": "<canonical-evidence-run-uuid-v4>",
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

非 AAAI 会议的 `locator` 保持上面的无 `profile` default binding，因此既有完整 evidence run 可继续使用。
AAAI 2026 的 `locator` 必须额外精确包含
`"profile":"aaai-2026-bare-introduction-v1"` 及该 profile 在代码 registry 中登记的实现 SHA；旧 AAAI
default binding、未登记 profile/hash、不同 evidence run/catalog/report 或不闭合的论文全集都会在
prepare/runner 和任何模型请求前被拒绝。旧 `conference-filter-spec-v4` 共享 spec 不兼容 v5，须按会议重建。

`endpointIdentitySha256` 是 `endpointIdentitySha256(endpoint, model)` 对公共路由最终规范 API URL
UTF-8 字节计算的 SHA-256；它不包含 API key。endpoint、协议或模型任一漂移都必须重新 prepare
新的 filter，不能在旧状态上混跑。

### 必需：筛选前 PDF 摘要证据

筛选前必须运行离线 evidence 批次。它认证既有 discovery
catalog/report，逐篇把唯一 exact PDF 安全 clone/copy 到隔离 item，生成绑定原始 record 的 projection，
复用固定 `pypdf` extractor，再由 `abstract-locator-v1` 只截取前两页中唯一且有明确结束标题的
Abstract 原文。它不总结、不调用模型，也不产生 included/excluded 决定；摘要缺失、歧义或过短
只记为不可用，提取器失败则整批失败关闭。默认一次只处理 1 篇，`--limit` 最大 500，避免误启
16k 全量：

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

普通 `apply` 默认 1 篇且 `--limit` 最大 500。已确认全集并准备在单进程完成时，必须同时提供
`--all --expected-total N`；`N` 必须与认证 discovery member 总数精确相等，否则在创建/推进 run 前
拒绝。`--all` 仅适用于 `apply`，不能与 `--limit` 共用。这样既保留误启动保护，也避免大会议用很多
小批次重复扫描既有 receipt 造成 O(n²) 本地 I/O：

```bash
npm run conference:new:evidence -- apply \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --run 00000000-0000-4000-8000-000000000001 \
  --all --expected-total 39
```

checkpoint 位于 `data/runtime/conference-filter-evidence-runs/<runId>/`。resume 会先重放所有已完成
item 的 evidence receipt、locator 重放结果与 text/artifact SHA；遇到半成品 item、提取器失败或任何
字节漂移立即失败关闭，且不会把该论文自动排除。
Locator 使用关闭式 provider profile：非 AAAI 继续绑定原始 default SHA；只有 `aaai-2026` 使用
`aaai-2026-bare-introduction-v1`，允许前两页唯一的独占行 `Introduction` 作为摘要终点。CLI 不接受
任意 profile/hash 覆写。Profile 变化必须创建新 run，不能改写或混用旧 receipt。
全集完成后才签发 `evidence-catalog.json` 与 `evidence-report.json`。filter 只通过
`loadEvidenceHandle()` / `evidenceHandleSnapshot()` 认证读取，并把 catalog/report/state、逐篇
receipt/evidence SHA 与 locator 版本加入 input、request envelope、durable intent 和恢复重放。
`ready` 的原文摘要只投影到当前 keyword/prompt 输入；任何 non-ready 状态保留原 metadata 且安全放行
给 LLM，不允许因标题或不完整摘要直接排除。禁止直接信任裸 JSON/路径，也禁止把摘要回写进已经签名的
官方 metadata snapshot。无 evidence 的旧 filter/spec 与 v4 不可混跑，必须重新 prepare。

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
目录使用锁、状态 SHA CAS 和受控 patch 保证可恢复。主分支现已通过
`conference:analyze` 复用共享深度分析/Reader，并由 `conference:postprocess paper|aggregate`
重放 completion、current taxonomy 和完整 selected member set。但这些新页仍使用 generic
conference 路径，没有绑定历史 inventory 保留的旧 URL/task 页；conference aggregate 也尚未接入
historical publication，且没有会议历史 review/push/remote-OID 闭环。因此可运行隔离试点，
但不能直接发布或声称已重写历史会议页。

### 新会议统一批处理入口

日更工作区中的新会议不得再分别调用 execution、analyze 或 postprocess；这三条
`conference:new:*` 旧旁路会明确失败。唯一批处理入口是：

```bash
npm run conference:new:process -- --dry-run \
  --catalog odyssey-2026.json --report odyssey-2026-report.json --filter UUID \
  --concurrency 3
npm run conference:new:process -- --apply \
  --catalog odyssey-2026.json --report odyssey-2026-report.json --filter UUID \
  --concurrency 3
npm run conference:new:process -- --status \
  --catalog odyssey-2026.json --report odyssey-2026-report.json --filter UUID
```

该入口只接受已经 complete、非空且来自 `official-proceedings` discovery 的 selection，
每个 included member 还必须是唯一 `exact` PDF。它签发
`conference-deterministic-source-seal-v1`，明确表示机器按官方 metadata 的 `pdfFile`
自动验收，不写也不暗示人工 review。每篇仍运行固定 pypdf 提取，并在 staging、import
和后续重载时重放 request、metadata、PDF、text、artifact、receipt 与 verification SHA。

process UUID 绑定 selection、current taxonomy 原始字节和实现指纹；每篇 analysis UUID
再由 process UUID 与 canonical paperId 确定性派生。checkpoint 位于
`data/runtime/conference-processes/<process-uuid>/state.json`，状态只在 source proof、公共
analysis-engine 的 completion receipt、current taxonomy 单页 manifest 均存在后进入
`complete`。全体成员 complete 后才生成 aggregate，并签发同目录不可变
`completion-receipt.json`。并发覆盖完整单篇生命周期且限制为 1–3；重跑沿用同一 UUID，
已完成论文不再调用模型，partial 论文从原 analysis checkpoint 续跑。

实现指纹使用代码中的稳定显式文件清单，覆盖共享 analysis engine、deep analyzer、会议来源上下文、
JS/Python 论文身份、Reader contract/repair/tables/resource sync、会议 staging/postprocess/renderer，
以及实际分析、Reader、评分、开源扫描和修复 Prompt。任一已绑定实现字节漂移都会产生新 process UUID；
当前安全策略接受因此发生全量重分析，不跨实现版本复用旧 complete 状态。

只有 `--apply` 获取同一 process 目录的 operation lock；`--dry-run` 和 `--status` 保持只读且不拿写锁。
该锁使用本地死亡进程可恢复策略，异常会在 `finally` 释放，SIGINT/进程退出留下的同机死亡 owner 可由
后续运行安全回收。逐篇状态更新另有状态 CAS，禁止把 `complete` 回退为 `analyzing` 或
`analysis_partial`；最终 completion transaction 会在锁内重新确认所有成员 complete 并重放 receipt。

此入口只写私有 source/cache/checkpoint/page/aggregate staging，不执行博客 generate、review、
push 或远端 OID 验证。会议公开发布仍是独立、尚未授权的后续事务。

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

单个既有日批次的隔离重写可以使用 [`rewrite:source`](fresh-rewrite.md)。全历史会议页则优先使用
本页开头的 direct-local-first chain；它不要求先跑 legacy ledger/execution，也不把 legacy `fullText`、
任意文件路径或旧 Reader 文本塞进 canonical。direct conference route 只接受 local-source manifest 已绑定的
metadata/PDF SHA 和冻结 projection。

历史 direct 顺序是：本地 source catalog/projection/plan → source-only rewrite → 私有单页/汇总 staging。
旧 URL 与旧 receipt 保留为投影和未来 publication 基线；现阶段没有历史专属 review、activation 或
generate/review/push receipt。

## Token 与批次控制

会议执行可按 source、analysis 与 Reader 并发限制分片；同一 canonical paper 仍只能有一个 writer。每次请求
使用既有用量账本和 checkpoint；来源 SHA、Reader 或 taxonomy 规则变化才失效必要下游。质量 review 是每个
direct run 的常规阶段，不是本地好数据队列的 pilot-first 开关。
