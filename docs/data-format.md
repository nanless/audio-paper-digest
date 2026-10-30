# 数据、状态与发布记录

## 本页目标

这一页回答三个问题：各类文件保存什么、哪些值需要相互核对、失败后能否继续运行。字段的具体校验以程序为准；旧 Manual 记录的只读核验边界见 [兼容目录](../manual/README.md)。

第一次阅读时，沿“候选 → 筛选决定 → 入选集合 → 正式分析 → 页面清单 → 审查 → 发布”理解各文件的关系。箭头表示后一步必须能对应前一步的输入，不表示只凭前一步文件存在就能继续。常见术语解释见 [写作约定中的术语表](writing-guide.md#术语先解释再统一称呼)。

## 数据分类

| 类别 | 保存内容 |
|---|---|
| 持久论文库 | `papers.json` 跨运行保存论文和去重状态，不随日期批次移走。 |
| 日期批次 | 当前或归档目录中的候选、筛选决定、入选论文和分析结果。 |
| 发布与视觉记录 | 页面生成清单、审查记录、发布提交、配图任务及资产信息。 |
| 跨批次请求状态 | `data/runtime/llm-account-pool.json` 保存账号池轮转游标、最近选择与额度冷却状态，不随日批次归档。 |

文件存在或写有 `complete`，都不能单独证明完成。程序还须核对该文件与输入、来源和其他状态文件是否一致。SHA 用于确认内容身份，不能证明文章事实正确，也不是评审人的数字签名。

不同对象中的 `generation` 含义不同：来源目录用它区分获取次数，账号池和可变数据用它记录更新次数，博客生成清单记录一次页面生成。这些编号都不是 arXiv 论文的 `vN` 修订号。

## OpenCode Go 账号池状态

`data/runtime/llm-account-pool.json` 使用 `opencode-go-sticky-quota-failover-v1`（该字符串是历史兼容标识，语义已升级为同池等权轮转）。它保存服务和账号的 SHA-256 身份、轮转游标、最近选择的观测字段、归一化额度窗口、`blockedUntil` 及更新计数，不保存 API key、认证头、请求或响应正文。账号稳定指纹仍属于敏感操作信息，文件权限须为 `0600`，不得上传或归档。更换密钥会形成新的账号身份，但账号身份不进入筛选、分析或发布内容的指纹。

Node 与 Python 使用同一目录锁和原子写入方式；锁只覆盖账号选择与状态更新，HTTP 请求在锁外发送。未知格式、损坏 JSON 或符号链接状态路径会使程序停止。同一池内所有 key 等权，按账号 ID 稳定排序轮转，跳过已排除与冷却未到期账号；只有明确的 HTTP 429 `GoUsageLimitError` 或 HTTP 401 `Insufficient balance` 才在同一逻辑请求内切换并记录冷却，普通认证 401 停止运行，其他 429、5xx、传输或内容失败不触发切换。冷却到期后账号自动回到轮转。

## 请求开始、终态与异常响应保全

`data/runtime/llm-usage/` 中 Node/Python 的 `request_started` 与真实终态请求事件共用 `eventId`。只有开始记录的请求仍是未知消费，不能按零消费处理；旧终态协议继续只读兼容。终态或 Reader 采用事件保存失败停止新请求，费用统计不能把缺失事件补成成功。

账本故障时的实际响应使用独立 `llm-response-recovery-v1` 保存在 `data/runtime/llm-response-recovery/`，绑定原安全事件、响应及文件 SHA。它属于受保护运行证据，不能上传或清理，也不能直接提供来源、完成或发布资格；恢复须走原受控入口。完整故障处理见[费用记录保存失败](troubleshooting.md#费用记录保存失败)。

## `data/current/` 核心文件

### `papers.json`

跨运行去重库。每篇的 `digestStatus` 可记录分析成功、待分析、失败和最近一次尝试。旧成功正文可以保留，但后来的失败仍须写入 `latestAttemptStatus`，不能用旧结果掩盖最新失败。

### `fetch-checkpoint.json`

当前补抓使用 `sourceContractVersion: 7`、`coverageStrategy: previous-digest-window-v1` 和完整 `fetchBoundary`。它绑定上次已发布日期、固定 `since`/`until` 与身份 SHA；七类 arXiv 和 HuggingFace 均须提供对应窗口的完整覆盖证明。续跑须以原 `until` 重新解析远端已发布基线并核对全部身份，不能移动终点后拼接旧检查点。v6 及更早记录仍保留，但不能当作此窗口已抓完整的证据。

按 arXiv 类别和 HuggingFace 保存来源状态、候选数、内容 SHA 及恢复信息。某一来源损坏只使该来源的记录失效；新筛选和筛选续跑都须先确认全部必需来源完整。未完成的来源不能进入付费筛选或分析，已有记录仍保留供恢复。仅有 v7 抓取检查点、尚缺原始候选时，数据校验会报告批次未完整；同日抓取仍可按核验后的检查点恢复。

来源协议从 v5 升至 v6 时，HuggingFace 两个端点都须提供规范 arXiv 编号及非空题目、摘要，重复 ID 页也先核验条目。此次协议升级会改变整个 `candidateFingerprint`，所以旧 v5 抓取检查点整体不能复用，与同一协议下仅某个来源损坏的处理不同。目标日期仍为北京时间当天时，重新运行同一日更入口可以重新抓取；历史日期不能从抓取阶段续跑，须使用受控历史维护流程。升级不改写或重签已有运行数据；条目格式完整也不等于全文真实性已经核验。

### `raw-candidates.json`

保存当日已获取、合并、规范化并排除已发布论文的候选。只有全部必需来源完整时，这份集合才是完整筛选输入；来源失败时保留的部分候选不能冒充完整覆盖。筛选决定必须覆盖正式候选集合，不能只对成功响应的论文计算覆盖率。

### `filter-decisions.json`

按规范论文 ID 保存模型或关键词预筛的决定、理由、原始响应、解析方式、输入 SHA 和配置指纹。模型、提示词、协议或关键词规则变化时须重新筛选；仍完整有效的候选数据不必重新抓取。

仅命中泛多模态词、未明确声音模态的候选会交给模型判断，并在任何付费筛选请求前取得全部这类候选的官方材料；取得或核验失败时停止，已保存的完整材料可核验后复用。摘要达到80字只满足本地预筛的长度条件，不证明它列全了论文模态。人工流程不因此新增联网。`filterScopeEvidence` 保存四个来源文件的核验信息、选取的实际原文和内容 SHA；这份证据也进入决定的输入 SHA。恢复和数据校验会重新读取核验，不能只信保存的 SHA 字段。材料只帮助模型判断实际输入、输出和评测模态，不直接把论文标为相关，也不改写原始候选。

范围证据的片段端点和字符预算不得切断数学字母等补充平面 Unicode 字符。只有需要纠正这类端点的片段使用 `official-modality-scope-codepoints-v2` 选取版本，并由真实片段重算输入 SHA；字节未变的选取沿用原版本和已有筛选决定。官方来源原字节、原决定、请求及费用不因截取修复而改签或清零。

### `filtered-papers.json`

正式入选集合，必须等于候选中的 `related=true` 决定扣除显式排除的 `excludedRelatedIds`。API 错误、未知决定或缺失项不能被静默丢弃。

### `deep-analysis-result.json`

默认 API 的正式分析结果。每篇保存论文信息、`analysis`、`parsed`、来源身份、阶段检查点、`analysisManifest`、评分和解读正文的发布依据。论文集合须精确覆盖入选集合，各必需阶段须达到对应终态。

若数据声明 `dailyFreshSourceRun`，该引用须使用 `daily-fresh-source-reference-v1`，绑定 `batchDate`、完整论文集合、运行清单 SHA 和来源集合 SHA。每篇的 `freshRewriteProvenance` 与 `analysisManifest.freshRewriteProvenance` 须一致，并能核对到本次获取的来源文件。文件缺失或多出、来源或集合变化、混入旧来源记录，都不能取得默认 API 的发布资格。

## 日更来源的保存与核验

日更来源运行使用 `daily-fresh-source-run-v1`，位于 `data/runtime/daily-fresh-source-runs/<runId>/`。每篇的 `sources/<arxivId>/generation-000001/` 只包含以下四文件：

| 文件 | 内容 |
|---|---|
| `source.txt` | 本次获取的官方全文文本。 |
| `source.pdf` | 本次获取的官方 PDF 原始字节。 |
| `source-runtime.json` | 结构化证据、作者信息、图片网址和文本 SHA 等，不保存图片像素。 |
| `source-manifest.json` | 来源身份、官方网址、提取器、文件长度和 SHA，供后续重新核验。 |

这些文件是保留的论文来源，不是随日期轮换的缓存。图片字节、base64、缓存路径和临时文件名不得写入这组文件。来源引用、获取序号、清单及快照 SHA 须共同匹配，不能只补一个 SHA 字段让旧结果看起来符合要求。

当前无版本号的官方 PDF 确认返回 HTTP 404 后，获取器才可尝试同一论文的官方历史版本。`source-runtime.json.sourceVersion` 使用 `arxiv-historical-version-source-v1`，记录实际选中的 `selectedSourceId`、PDF 地址、当前 PDF 的 404、固定警告和身份 SHA。文本必须从选中的 PDF 提取；普通当前 PDF 不携带这条历史版本记录。Node 与 Python 都检查这些条件，而不只比较文件哈希。

论文的 `sourceVersion` 须与保存记录一致，两处来源记录中的 `sourceVersionIdentitySha256` 也须匹配。缺少该绑定的旧历史版本分析必须重新分析，不能在旧成功记录上补写证明。普通来源不增加这些可选字段；传递标题或版本说明也不改变既有来源快照字段、顺序和 SHA 的计算方式。

## 分析来源与恢复

`analysisSource` 记录来源类型、请求 ID、原始、全文及实际输入长度、截断状态、SHA、警告和置信度。默认 API 的记录须与上述已核验来源相符。来源 SHA 变化会使主分析及必要下游失效。

失败时保留 `analysisManifest`、`analysisCheckpoint`、`analysisStageCheckpoints`、`analysisRecoveryImageManifest` 及最新失败状态和错误。阶段检查点绑定输入、模型、协议、提示词、温度、预算和输出 SHA；恢复从第一个未完成或指纹失效的阶段开始。

`analysisFactReviewObligation` 记录锁内核验并实际保存的未完成严格事实反馈证明，绑定原包 SHA、论文、日期、来源运行、四文件与原输入正文。它不是成功或额外预算声明；恢复须重读原包并核验所有绑定，缺包或篡改均阻断。保留的旧成功正文和更早的已完成反馈不能清除最新失败。只有真实正常流程返回，当前反馈各阶段证明、拒句、来源和完整资格全部通过，才移除此字段及最新失败标记；保存、合并及批次最终统计必须保留未完成义务，发布端在字段仍存在时拒绝。

Reader 子阶段的 `reviewFeedbackSha256` 对应实际签发时父包与子包合并后的引文上下文。完成核验从已保存的真实父子包只读重建该上下文；恢复型记录的 `restoredReaderConstraints` 仍保留其原协议，不用新哈希覆盖旧签名。核验本身不清除失败或义务，也不授予模型请求。

独立 `coreFeedbackFiles` 必须只含核心摘要反馈。公共选定入口在论文锁内保存原包后单独进入核心单节范围，不把同一包伪装成主文父包。没有主文反馈的旧核心记录也按原单节范围恢复；核心阶段逐字保护其余十二节，后续正常评分和必要 Reader 可随新摘要更新。原包缺失、被修改或来源不符时停止，不能降为全篇重写。 `coreInputRecoveryHistory` 仅记录核心恢复入口误删阶段后的受控恢复，绑定真实原文件 SHA、当前失败整对象 SHA、原反馈及失败清单；原失败、未完成义务和费用保留。它不授予新的主文请求或重新签发旧阶段。

已签名日更 Reader 的 `daily-reader-signed-correction-v2` 记录保存完整当前 `parentPaper`、四源和退休付费稿身份，以及受拒原句内的精确范围补丁；真实旧人工修正按 `operatorHistory` 逐项重放。原 API 阶段和次数不变，新阶段明确记为零新请求的 operator。正文、计划及图注由正常装配器派生；不直接写成功标记，完整规则见[签名稿修正](reader-explicit-retry.md#已签稿的有界事实修正-v2)。

解读失败候选只供恢复，不能作为成功分析或发布依据。新版表格数量诊断使用 `code=reader_table_count_insufficient`、`requiredCount` 和 `actualCount`。计数必须是安全整数，满足 `requiredCount >= 1`、`0 <= actualCount < requiredCount`；带该错误代码却缺少有效计数时，不得从说明文字补出计数。`diagnosticOnly: true` 的记录仅供参考，不触发修复动作。旧保存诊断只由限定的兼容读取处理，不能让新的自然语言报错决定修复动作。通用草稿哈希及已有恢复身份的计算规则不变。

## 会议独立追加窗口

仅明确获准的会议剩余失败集合使用 `conference-recovery-grant-v1`。`data/runtime/conference-recovery-grants/<grantId>/` 的 `manifest.json`、`baseline-state.json` 和最后保存的 `registration.json` 不可变，绑定原 process、完整失败集合、原父子稿与候选 CAS、来源和 3轮/Reader累计6次/全文2次上限。普通状态 JSON 不能代替已核验的私有运行能力。

原失败子稿保持不变；新子运行的 `reader-revision.json` 使用 `conference-reader-recovery-window-v1`，同时指向原完成父稿、原失败子稿和唯一已登记许可。`recovery-seed.json` 不可变保存正常接续的初始检查点；若先复用原付费核心摘要，必须由真实旧来源、原响应及正常引擎生成检查点，并逐字保护其余十二节，不能手写通过阶段。新 `readerRevisionProgress` 只累计本窗口轮次，process 的 `retryReleases` 按同一 grantId 只登记一次，重复执行不重新起算。

`reader-grant-budget.json` 使用 `conference-granted-reader-budget-v1`，逐请求预留，绑定实际 Reader 身份。`reader-grant-request-<id>.json` 和内容响应的 `reader-grant-response-<id>.json` 是不可变原账；冷核须逐项与账本和真实输出 SHA 相符。未结请求保守占额，账本缺失或裁剪不能重开额度。新增请求沿公共费用记录保存，以该 grantId 作为 `runId`、新子运行 ID 的 SHA 作为默认 `unitId`，覆盖必要主分析、摘要、评分及 Reader，旧费用与旧连续失败不修改。生成、冷后处理和发布仍须核验真实会议来源及原完整链，详见[操作与恢复边界](conference-workflow.md#原额度耗尽后的独立付费恢复)。

## 会议博客审查后的 Reader 维护记录

已完成会议的正常付费维护使用 `conference-reader-review-maintenance-batch-v1`，与原失败迁移 grant、零请求人工清单分开。

私有根为 `conference-processes/<processId>/review-reader-maintenance/<batchId>/`，不可变 manifest 绑定实际停稳完整 state、当前 canonical generation、完整正常 review batch 及各原失败的物理/语义 SHA；原 current complete 父包 analysis/run/source、PDF、来源快照及明确类型的 Reader 父稿表面逐一 CAS 对应。

generation 可从 current 或按完整物理 SHA 唯一匹配的 superseded 找回，不能拿私造的自洽归档充当正常审查已结束。

规范发布目录中的这两种 generation 允许发布器原有的 `0600` 或 `0644`，仍拒绝符号链接、硬链接、重复身份及字节漂移；私有恢复副本继续严格要求 `0600`。通过页还须核正式永久 pass cache。

`baseline-state.json`、`generation.json`、`review-batch.json`、`failures/`、`classifications/` 保留原材料。全部 text 及分类为 normal-reader 的 Markdown/图片构成完整唯一成员集；其余 markdown/image 失败仍完整分类并保留原 stage，不改名为 text。`raw-review-findings-v1` 只发送带待核验警示的真实意见，`corrective-assertion-v1` 另绑定旧节点与逐字来源。deferred-review/deferred-publication-format 明确 pending-new-page-review，不得带 repaired/passed，也不能授新模型或发布通过。

`aggregateClassifications` 逐条绑定真实汇总拒稿，固定8字段合同 `conference-reader-aggregate-review-classification-v1`：kind=`deferred-aggregate-generation`、status=`pending-new-page-review`、nextAction=`normal-aggregate-generation-then-normal-review`。`nativeReviewClassifications` 完整绑定已结算 transient 原件，固定8字段合同 `conference-reader-native-review-classification-v1`、kind=`deferred-native-review`、相同 pending 状态及 nextAction=`normal-publication-review`。两类都保留原路径、页/失败的物理与语义 SHA，不加入单篇 members、不声称 passed/repaired，也不能漏失败；后续仍正常生成/复审。

`aggregatePaperFeedback` 的 `conference-reader-aggregate-author-feedback-v1` 绑定 paperId、实际汇总 failureSha256、aggregateEntryRank/aggregateEntrySha256、officialRecordUrl、authorName 和 sourceQuote；父包/Reader surface/CAS 仍逐篇绑定，纯意见仍发送原失败。原单篇 passed 不改失败；真实来源重放与明确 v2 作者解析必须证实对应变化，原 aggregate 字节及当前父包持续核验。作者 identity 新字段 `conferencePdfAuthorParser: conference-pdf-author-lines-v2` 明确新解析；无该字段的旧签名按原逐行 v1 冷核，不倒写。

原始意见维护的成员使用 `parentReaderSurfaceContract: conference-reader-final-parent-surface-v1` 与 `parentReaderSurfaceSha256`，绑定 `{contract,article,plan,figures}` 的真实原签字节，不宣称原付费 raw draft；不能同时放 `parentReaderDraftSha256`。旧无此字段的清单及 corrective 节点模式仍走原严格逆算。

登记以 `registration.json` 和 `registered-state.json` 绑定 state 的 `readerReviewMaintenanceObligations`；只追加义务，不把原 complete 论文伪装失败。`progress.json` 持久保存真实 child、尝试、轮次意图和逐篇成功，成功稿先保存再处理兄弟失败。原签稿 seed 由真实父来源上下文重建为 child 的 `review-reader-seed.json`，revision 固定绑定 manifest/member/反馈 SHA；继承 Reader 或同反馈 SHA 的别篇稿不能清义务。

精简修订输入另使用进程内 `parentSeedHandle`，不写入 JSON。该私有能力绑定实际子运行目录、修订和来源文件 SHA、原父三份文件 CAS、反馈和 seed；每次读取都复核这些身份及原受保护表面。已存在候选时须按完整逻辑身份唯一匹配原精简或完整显示，只有原恢复协议允许的实现字段可迁移，原请求和失败计数保留；无匹配不得新建输入绕账。Reader 定稿中的资源可达性同步仍检查同源证据与评分事实，但此维护分支保留原上游字节，不改变普通日更、历史或会议恢复的默认行为。

采纳后的原父科学读取另使用不可序列化的私有句柄，绑定实际 canonical 子稿、修订、原父 CAS、完整维护登记和采纳材料。来源身份读取不执行反馈、seed 或 Reader 校验，也不能成为分析调度或出版通过证明；完整加载随后仍执行这些阶段。私有句柄仅供本次同源父科学回放，进入和退出均重核实际文件；不新增磁盘许可，不更改任何原次数或费用。当前页面证明可以由正常后处理更新，但必须仍绑定同一实际完整子稿。

首轮签名稿的受控保存恢复记录为 `readerSavedStageRecovery`，合同 `conference-saved-maintenance-reader-completion-v1`。

`saved-reader-stage-recovery/<原分析文件SHA>/` 不可变保留原 `analysis.json`、`run.json`、`source.json`、`reader-revision.json`、`reader-resource-preflight.json`、`review-reader-seed.json` 和 `receipt.json`。

凭证绑定真实原父及预检、唯一中性投影、原新 Reader 阶段及恢复后正文、原请求正文 SHA 和三份真实费用事件；原外层、内容和全文次数保留，新增模型请求为零。

正常请求正文在预算预留前只读重建；原保存阶段指纹与当前准备器指纹、实现 SHA 分开记录。

单图输入另核正常来源重渲染与原封存 PNG 字节、原模型图片预检和图片证据，不能用新像素替代原请求。

冷读取重放原包、费用与当前正文对应关系，再正常核验完整资格，不补造不存在的首次成功 raw archive。

下一窗使用 `conference-reader-review-maintenance-window-v1`，位于 `windows/<windowId>/`，绑定本维护批完整实际失败 child、唯一前窗、原材料树/Reader账本与各物理 CAS，单窗3轮/6次内容/2次全文。中央 `conference-recovery-grants/<windowId>/registration.json` 使用独立维护窗口定位器，经私有能力复用现有累计账本；不改原 process 的失败状态或旧 grant 声明。必要窗口已获持续授权，新费用独立记账。

未签发准备的恢复位于本维护根 `unissued-preflight-recoveries/<executionId>/`。`before/` 保留原五份准备文件和 `member-progress.json`，`new-preflight.json` 保存正常探测快照，`receipt.json` 使用 `conference-reader-unissued-preflight-recovery-v1`，绑定维护清单、父 CAS、原文件 SHA、新预检 SHA、探测次数及是否恢复 Reader-only。只有原始 pending、generation 0、零尝试、无修订、seed、候选和请求材料时可使用；资源模式在真实 child 的认证 PDF 来源作用域内派生。

若新快照已封存但回执未写，恢复须先核原六文件归档、当前五文件、原失败及父稿和来源 CAS，再重放原快照，不覆盖它或重新探测。正常生成的回执以 `resumedSavedPreflightFileSha256` 绑定该快照，`normalProbeInvocations` 保留原探测次数，`normalProbeInvocationsThisResume: 0` 记录本次零新探测。已有回执恢复仍核对前后字节及真实来源作用域；这些记录不授予 Reader 通过，不改旧证明、失败、次数或费用。

全部新稿正常完整资格及 stage 通过后，`adoption.json` 与 `adoption-after-state.json` 不可变绑定原 baseline、实际登记前后状态和全 child/page CAS，锁内原子采纳后正常重做汇总。pending 发布门同时核 state 定位器和私有实物，缺目录/旧成功/旧 passed 缓存都不能清义务。操作命令见[正常 Reader 维护](conference-workflow.md#博客拒稿后的正常-reader-维护)。

## 会议零请求来源纠正

`conference:migrate-process --postprocess-only` 保存真实统一后处理及迁移凭证后返回，结果含 `postprocessedOnly:true`、检查/通过/失败数量和 `newApiRequests:0`。它不派发分析、放行重试或生成聚合。

`--postprocess-only --source-corrections FILE` 读取 process 下独立的 `source-resource-corrections/` 或 `source-core-corrections/`。两者分别使用 `conference-source-resource-correction-{batch,receipt}-v1` 与 `conference-source-core-correction-{batch,receipt}-v1`，逐篇记录去掉中间的 `batch`/`receipt`。清单绑定实际状态文件 SHA、语义 SHA、完整唯一集合和每条记录字节；每条记录绑定固定新 UUID、原角色 CAS、来源/PDF、Reader 补丁、原费用及独立批准提案，权限不因共有保存器而合并。

原角色包括完整 Reader 父稿、当前 process 指针、最新实际失败及所选主文；追加窗口另用 `originalFailedExecutionId` / `originalFailedCAS` 绑定公共加载器核验的许可前失败稿，并同样保存完整原目录。当前指针可以仍是完整父稿，不能把它冒充中间失败 UUID；有付费失败时主文必须来自最新失败。纯后处理的核心错误没有新付费子稿时，另精确绑定正常当前错误与失败状态。核心只改一条原句，其余十二节、资源和完整评分对象不变；资源修正仅重算作者归属及对应评分，不改主文。阶段记录如实标识本地执行，原模型阶段、检查点、请求及计数在不可变原包保留，不重签成新 API 响应。

新稿 `conferenceSourceCorrection` 和完成义务绑定实际独立合同、process、新执行及物理清单 SHA；正常 Reader、评分、核心与完整资格的热核/保存冷核重放后签独立回执。采纳项 `sourceResourceCorrectionAdoption` 保留原状态/成员 SHA、原次数/失败及真实主文/Reader父身份，不复用 `readerRevision`。分析、来源、暂存页及原状态在全部成员锁内复核后原子采纳；旧完成凭证只投影到真实物理原包。详见[恢复与限制](conference-workflow.md#认证来源事实的零请求纠正)。

显式最新评分检查点恢复另绑定原 `analysis:null`、原 Reader 失败、当前评分阶段及实际检查点 SHA；检查点、活动正文检查点和评分输出必须是同一正文。只恢复私有正文/解析视图，原文件与费用不变。原无图片候选和下载的未收尾 `imageSupplement` 必须在真实新 Reader 完成后由同一公共官方图逻辑派生并冷重放。核心审计保留原完整对象时，记录原/新核心的公共归一校验结果 SHA 与原审计 SHA，二者分别核验，不混充同一字节。

## 批次轮次与人工建议的诊断

共享批量调用返回 `rounds`、`failedIds`、`unstartedIds` 和 `manualHandoff`。每轮的 `inputIds` 是该轮固定集合；`attemptedIds`、`successIds`、`skippedIds`、`failedIds`、`retryableFailedIds` 和 `unstartedIds` 分开记录。下一轮只取可重试失败项，不把尚未启动或被预算/来源阻断的论文算成成功。结果数组保留每篇最近一次真实结果，`stats.roundsCompleted` 是已结束轮数；成功/失败数量按最新结果计算，不能把同篇多次尝试当成多篇成功。

每篇结果和费用仍逐次保存，轮次边界等待所有在途结果与保存回调结束。会议另写不可变的 `conference-process-round-v1` 回执，绑定 process、当前 state SHA、generation 与本轮输入/成功/失败集合；历史在进入下一轮前保存原 registry 和恢复记录。轮次报告用于解释调度，不替代来源、Reader、页面、审查或发布凭证。

日更分析和恢复入口将 `analysis-batch-retry-diagnostics-v1` 写入正式结果的 `stats.analysisBatchRetry`，绑定日期、当前封存来源引用 SHA 和本次论文范围 SHA。`digest:status` 只展示仍对应当前日期、来源和范围的诊断；后续修正已改变失败集合时，旧人工建议不能继续显示为就绪。Reader 刷新另以 `0600` 保存 `data/runtime/analysis-batch-reports/<runId>.json`，使用 `analysis-batch-diagnostics-v1`，记录本次固定论文集合、封存来源引用、轮次、失败和未启动项。两者均声明 `diagnosticOnly=true`、`newApiRequestsAuthorized=false`，不能补签成功或解锁费用。

`manualHandoff` 使用 `analysis-batch-manual-handoff-v1`，包含 `eligible`、`status`、`reason`、逐项 `attempts`/`noProgressRounds`/错误作用域及预算状态，以及 `eligibleIds`、`blockedIds`、`budgetExhaustedIds`。阶段完成与正文/草稿 SHA 的实质变化才算进展，时间、次数、费用变化不算。`ready` 只表示少量持续失败达到建议阈值；`newApiRequestsAuthorized=false`，失败仍是失败，额度仍按原账。服务故障、不可重试和耗尽项保留原阻断，不授予发布资格，见 [统一恢复规则](three-workflows.md#全批轮次与失败集合)。

## 正式分析结果与发布正文

`analysis` 的 13 个中文一级标题是解析锚点。`parsed` 是解析缓存，发布前须从正文重新解析并逐字段比较，不能把它作为独立事实来源。

默认 API 页面使用以下解读和评分数据：

| 字段或记录 | 用途 |
|---|---|
| `apiReaderArticle` | 读者看到的长文。 |
| `apiReaderPlan` | 章节、术语解释、图片安排及表格、公式来源记录。 |
| `apiReaderFigures` | 实际输入图片的来源、DOM、像素 SHA 和显示网址等身份信息。 |
| `apiReaderAuthors` | `api-reader-author-identity-v1` 逐项核对作者姓名和机构。 |
| `apiReaderResources` | `api-reader-resource-identity-v1` 核对原文或 Demo 来源、重定向终点及可达状态。 |
| 评分证据与稳定性裁决 | 说明八维分数及最终评分所依据的分析。 |
| `llm_api_production` | 确认本次发布论文集合满足默认 API 要求。 |

Reader v3 规定正文结构，`api-reader-source-bindings-v4` 核对表格和公式来源；它们各管一部分要求，版本号不必相同。新发布还须满足作者和资源的 v1 来源核验要求。Reader v1/v2 及缺少任一当前来源要求的旧 v3 只供历史兼容读取。摘要级分析默认不可发布。

机构解析无法与作者逐人绑定时，新记录明确写“机构信息未能在本次解析中与作者逐人可靠绑定”，不能据此声称论文未披露机构；旧签名仅按原字节兼容核验。原 HTML 无法保留时，只有公共来源读取逐一核验四个文件及清单绑定后，才能使用封存元数据中的作者机构。正常日更调用中传递的完整详情须与已核验来源一致，并再次核对四个文件；外部手构或克隆的对象不能自行取得许可，被修改的详情会被拒绝。合法的空作者元数据仍明确标为不可得；不改来源记录补签。

主结果覆盖检查按结果或消融章节中的实测数值单元格计数。年份、数据集规模、样本数、训练配置和模型版本号不能补足结果数量；交错列和转置指标表仍按原布局检查。该检查用于完整 Reader 解析和失败草稿修复，现存成功记录的所有快速复用入口尚未统一重核，不能据此宣告旧文章已全部补齐主结果。

`source_quotes` 表格的列头单位也属于数值证据。裸单元格数字须由同一指标、同一局部分句的明确单位声明支持，不能借另一指标或另一句话中的百分号、秒或毫秒；单元格已明确写出的单位继续按原数字引文规则核验。仅有共享表头而无法逐值定位时，要求按原文修复来源记录或明确单元格单位，不自动转换数值。旧成功记录和 Python 发布同样执行这项检查；`artifact_table` 仍按原表 DOM 逐格核验。

自动检索补充表格引文时，不把括号或方括号中的裸整数、图表章节定位号、明确的协议/版本号及提交哈希的数字前缀当成测量或计数。它们出现在原文中不代表能为另一张表的同值补证。真实括号计数仍可由模型明确引用的完整原句或原表 DOM 单元格支持；缺少对应证据时保持失败，交回正常有界修复。

### 表格数量、单位与来源证明

宽表默认仍要求至少两张不少于五列的表。仅在当前认证 HTML 来源的全部结构化资料完整、未截断，且文章把全部 DOM 原表一一完整展示、全行全列逐格通过原 DOM 绑定时，宽表数量下限最多取来源真正具备的宽表数。运行时告知与最终解析共用这一来源能力；缺表、重复表、删行列、partial 来源或 `source_quotes` 整理表均不能降低默认要求，也不能传入数量或自签对象取得例外。原表及历史签名、请求次数和费用不变。

正常会议和历史 PDF 的表绑定另可由程序写入 `authenticatedPdfTableEvidence`，协议为 `reader-authenticated-pdf-table-evidence-v1`。该对象绑定实际来源身份、来源快照、正文及结构化投影 SHA、PDF SHA、当前表格 SHA、唯一连续原表引文和逐行列映射，并保存 `evidenceSha256`。它仍属于 `source_quotes`，不是 DOM 表或模型自行填写的证明。当前绑定及整个 Reader 计划的 SHA 包含此字段；保存后与 Python 发布均从真实来源冷重放，不能只验证自哈希或信任传入的单位数组。缺字段的旧稿继续走原实际证据规则，不补签；原表无单位、另一张同值表、重复列或映射不唯一时继续拒绝。

旧窄表曾把不明归属的 `validation set` 写成 `TidyVoice`。相同旧表形状现在须有直接说明二者关系的逐字来源引文，另一个句子的同名数据集或较长数据集名称不能补足这项证明。新生成不再猜数据集，也不再按指标名称自动给散文补百分号；旧散文的逐句单位证据尚未完整迁移，不能据此宣布所有历史文字已经修正。

### 公式与图像的旧记录限制

原始 TeX 在等号后截断时，不再根据公式名称或可见文本猜补，须去掉该展示公式并依据完整原文解释。

旧实现曾猜补的一条 CTC 公式，以及 `2609.15067` 中曾按图片文件名写死的图注，若新结果仍包含相同表达，计划会自动保存 `structuredSourcePayload`：与既有结构化来源 SHA 对应的原始 JSON 内容。

恢复与发布逐项核对全文 SHA、公式或图片位置、DOM SHA 和原始内容；输出自身哈希或布尔声明不能替代来源。

现在每个展示公式都须有这份完整内容及匹配的来源身份。

缺少它的旧 Reader 应从同一组封存来源正常重建；没有展示公式的记录不受此项影响。

旧 `2609.27195` 中无像素证据的固定图中叙述须移除后重新核验。

受影响的旧缓存不能直接复用；从封存来源正常重建 Reader，并重新生成和审查待发布页面。来源记录保持原字节，不手改计划补签，也不为此重新抓取历史日期来源。

新日更的图片只在调用时准备像素，不保存图片文件到运行目录。`apiReaderFigures` 中存在像素 SHA 不代表还有可复用缓存。兼容早期结构化来源时，须通过来源清单和全文 SHA 校验；处理旧键序哈希还须能按记录的解析器版本重验，或属于实现认可的无布局来源且表格、公式和图片数组均为空。任意布局声明不能取得兼容资格，已保存的文件也不能被重写来制造新 SHA。

## 博客生成清单

### 发布范围与来源证明

schema v3 生成清单记录日期、`category`、博客基线 `HEAD`、精确非空页面和受控下载文件集合、逐文件 SHA、新建或覆盖或删除状态、输入及模板指纹、实际渲染的 `publishedPapers`、一致的 `publicationMode` 与发布依据，以及论文长图与汇总封面不在发布前生成的标记。

默认 API 日更使用 `llm_api_production`；会议和历史另核对各自正式来源与发布清单。旧 Manual 发布依据仅按原记录核验。混合来源资格、缺少绑定或使用旧 schema，不能用于新日更发布。

### 原图恢复与派生资产

新 schema v3 同时保存 `derivedFigureAssets` 及其指纹。日更封存 SVG 缺失或循环引用绘图定义时，`reader-sealed-pdf-page-asset-v1` 独立绑定原 Reader 像素 SHA、原 SVG 与 DOM SHA、同篇四份来源 SHA、唯一完整图注与图号、原 PDF 页码及完整 mediaBox、渲染实现和新 PNG SHA。

另一个受限触发条件是 LaTeXML `foreignObject` 中声明白字却实际继承黑色：程序必须从相邻同坐标系的受限闭合圆角矩形、完整文字容器包围盒和不透明填色证明黑字落在深底，且黑字对比度小于 3、原声明白字对比度大于 4.5；正确的标准 `color` 映射、可读蓝橙底、未知变换、越界、透明或遮罩均不触发。程序不补猜 CSS，也不把其他字色差异统称为损坏。

完整图注比对仅额外允许连续字母乘积的显式 `\,\cdot\,` 显示为居中点，保留原图注 SHA、完整投影内容及每处替换证据；其他 TeX、词句、数字及图注唯一性要求保持不变。

页面明确标示原 PDF 页，不冒充精确裁图或旧模型输入；生成、审查和推送均重算该证明。没有这两个新字段的旧清单只按原输入语义、原来源和原 Reader 像素路径及 SHA 只读核验；不能删新证明字段，把新的替代 PNG 伪装成旧格式。替换旧资产经原清单的精确 owned 文件安装事务处理，其他图片不进入删除范围。

会议原 PDF 出版派生另保存于 `conference-publications/<conferenceId>/<processId>/figure-crop-derivations/`，原页视图位于 `figure-publication-views/`。

`generation.figurePublicationView` 绑定完整原 rawFiles/rawImageFiles/原 bundle SHA、真实 Node derivation、原 generation 双 SHA、固定实现及实际 changedPages；新像素和出版 body SHA 不冒充原 Reader 签名。

共享摘要显示对 `<unk>` 等论文控制词元作字面转义，原签摘要保持；合法完整图片 ALT 内的 Markdown 方括号转义仅在公式配对诊断副本中按字面处理，不改页面、ALT、URL 或图注，正文数学与 HTML 检查保持严格。

完整页证明带目标印刷图号和 PDF 页码；正常模式核完整图注，有限源页模式须另核选中图的原认证 raw artifacts/ref/page/DOM/asset 能力，同页真实印刷图号唯一，completeTargetCaption:null 且 captionExtractionStatus 为 partial/unavailable，实际 sourceNote 明示未完整抽取；原 PDF、raw stage、原图、Reader 和费用保持。

后续维护反馈的两阶段历史能力先验证原生批审查/父来源/真实当前后继，再通过库内 opaque 范围重算同 PDF 派生与全部实物闭包，以原生纯 FD 变换逐字对照 raw→view。缓存仍持真实 source assertUnchanged，不能只缓存 JSON 自哈希；它仅避免几何及纯 FD 重算，逐 child 仍可能重读完整批缓存与来源/页面/PNG 闭包，不承诺总 I/O 无重复；旧父不再 current 时也只认证历史意见材料，不授当前发布或新 Reader 成功。原日更 `reader-sealed-pdf-page-asset-v1` 字节及证明合同不因此改变。

### 页面元数据与四份下载文件

当前 Reader v3 和已保存的旧 Manual v6 论文页使用 `researcher-workbench-v1` 页面元数据，保存读者标题、原始标题、规范 arXiv ID、明确输入或由已保存并核验的来源确定的 `vN`、版本一致的 abs/PDF URL、主任务、数值评分、排名分档、文档类型、一句话主线、结构化作者及原摘要 SHA。原始摘要保存在同批 `static/data/papers/<date>/<safe-arxiv-id>/rethink-context.json`，不塞入页面元数据。

每篇有四个同源下载文件：`citation.json`、`citation.bib`、`citation.ris` 和 `rethink-context.json`。写入暂存结果前校验路径、LF/UTF-8、JSON/TeX/RIS 转义及 256 KiB 上限；四个 SHA 同时记录在页面元数据、生成清单和审查记录中。审查从 `publishedPapers` 快照重建这些文件并逐字比较，推送只允许审查记录指定的精确变更。

新 `rethink-context.json` 使用 `paper-research-context-v2`、`schemaVersion=2`，标签记录位于 `assessment.tagMetadata`。页面 `paper_digest_sidecars` 中该文件的记录保存 `contract`、URL 和 SHA。旧 `researcher-sidecars-v1`、`schemaVersion=1` 使用原 `assessment.taxonomy`，原页面记录不带新的格式标识；读取时按旧格式重建，不改写原文件。格式与版本须正确配对，新旧标签字段不能混用，即使值相同或为空。其他三份引用文件保持原格式。

历史版本引用采用已核验的 `sourceVersion.selectedSourceId`。输入和已保存来源都没有明确版本时，保存 `version: null` 并使用无版本 abs/PDF URL，不能猜成 `v1`。

### 分类字段、卡片与统计范围

新论文把 3–5 个当前分类表中启用的首选标签写入 Hugo 的 `tags`，并记录 `paper-tag-flat-tags-v2`、选择规则、分类表版本及 SHA、有序的 `{id, facet, label}`、显式主任务和主方法。标签采用中文首选名称；既定 `CNN/RNN/SFT/CTC/LoRA/Adapter/Transformer/Conformer` 八个专名保留原形，并在分类表中配中文别名，不能扩成任意英文标签。`rethink-context.json.assessment.tagMetadata` 保存同一分类信息。

旧页面仍按原 `paper-taxonomy-flat-tags-compat-v1` 读取，不因新发布而改写。两版的标签规则相同；日更汇总页“热门方向”只将主任务追溯到最上级统计，不计方法、条件和补充任务。

当前标签分类与新版导航均包含386项九维概念。页首的扁平兼容字段只存直接命中项；正文和分类卡片从这些ID推导多级路径，祖先不写进直接集合，不显示空分面或兄弟方向。旧262项的原文件按SHA归档，严格纯追加时按原规则完整重放旧阶段，而非修改其绑定。会议及历史发布还核对站点 `data/`、`static/data/` 中本次SHA的完整原快照和版本目录。目录可见范围、版本投影及恢复见[标签规则](tag-display-policy.md#三条流程共用的目录与呈现)。

历史每日、会议和任务汇总的页首 `paper_digest_tags_scope: aggregate-primary-task-counts` 明确只记录成员的去重主任务；对应 `paper_digest_tags_concepts` 保存这些任务的 `{id, facet, label}`，不把整篇汇总冒充单篇的3–5项选择。汇总正文则逐篇显示各自完整的直接所选项及祖先路径，两种范围不能混算。

共享分类块在源Markdown中保留，并用不含空白的成对注释标记边界。单篇网页只在页头已实际呈现经核验分类、且正文恰有一对完整有序边界时，移除网页正文中的同一分类块；汇总页仍逐篇显示。旧无边界页面和异常边界不作猜测删除，原Markdown、Reader及分类证明保持原样。具体模板与发布基线要求见[标签呈现规则](tag-display-policy.md#已发布页面切换到当前呈现)。

汇总的自然语言质量检查仅在当前完整词表及部署前缀下逐字重放共享渲染器、确认分类块完全一致后，在检查副本中用短占位替代这段结构化元数据，避免路径URL的问号和相同分类误算成长句或重复正文；实际Markdown、单篇检查及通用正文阈值不变，只有成对标记不构成豁免，伪造标签/路径、夹带文字、嵌套或不完整块仍须阻断。

## 审查记录与远端发布

审查记录绑定生成清单 SHA、实际页面 SHA、当前审查协议、Git 基线、Hugo 构建结果和配置、布局、数据、前端代码的运行时指纹，以及发布依据。逐页通过记录单独保存，只按“相对路径 + 页面内容 SHA”长期复用。会议后续整批可混合旧协议 passed 与当前协议失败；passed 必须逐字段等于 canonical `page-review-passes/<stable({path,sha256})>.json` 的真实原件，核 `conference-page-content-review-v1`、`resultSha256`、路径/页 SHA 及合法原协议；不能无缓存伪造 passed 或改签原协议。失败仍严格绑定当前整批协议与原不可变 failure。

独立人工审查 v4 将文章语义记录 `files` 与 `machineAssets` 分开；后者使用 `manual-review-controlled-assets-v1`，仅容纳 schema v3 清单中的现存受控引用资料、词表和论文图，逐项保存 `{path, deleted: false, sha256}`。两者的精确并集必须等于完整生成及发布清单，不能漏项、夹入未知资产或给资产伪造审查者。机器资产在签发和推送时重新核验当前生成、正式同源分析、封存来源、词表、伴随文件重建及已通过且 SHA 一致的引用页。逐图记录中的站内地址只接受当前部署前缀下、同一清单和当前字节匹配的受控论文图；旧纯文章声明保持原规则。

单图模型输入在前图解释与本图导读共享同一段时，记录其原文边界及前图序号，并明确标注过渡段与本图自有上下文；正文和图片字节不变，不能因前图特征不在当前像素中就认定正文错误。本图真实冲突仍须报告，标注不构成审查豁免。

对当前签名 V3 Reader，审查输入只在来源清单、运行元数据及逐图 DOM、标签、图注和唯一资源映射核验后，说明三种编号：图片 K 是本次位置，论文图 N 是来源 DOM 条目，Figure M 是作者印刷图号。N 可跳号或重排；编号不同、URL 文件名及作者图注的概括程度本身不能证明配错图。实际错图、印刷标签矛盾及图文科学冲突仍阻断。旧记录、非 DOM 来源或缺真实作者标签不套用此说明；文本单元缓存显式绑定说明内容，图片单元沿用完整实际提示词身份。

新独立人工审查的 v4 外层声明使用 `manual-agents-sol-high-v2`，逐页必须实际配置并如实记录 `gpt-6.1-sol/high` 身份；旧版本只按原模型规则读取，不允许补填新身份。

发布器代码变化仍使生成阶段重新渲染，以发现真实字节变化。模板、站点脚本、模型、发布器代码、协议或生成清单元数据变化时，须重跑当前批次检查并生成新审查记录；已经通过且最终内容未变的页面仍复用原通过记录，只有内容变化的通过页重新审查。

已完成的内容拒稿不属于通过缓存：页面字节未变且原审查协议仍相同时，继续保留拒稿阻断；只有保存的旧协议和当前协议均为合法 SHA 且确实不同时，才让该失败页进入正常整页重审。缺失或非法旧协议不能据此授权重审。通过页仍按路径和内容 SHA 永久复用，不因协议变化重新调用模型。单页重审中的请求仍遵循原单元缓存身份，可能产生新的文本及图片请求，原失败记录、响应和真实费用均须保留，不能手填通过。

图片审查每次只接收一张实际图片及其附近正文，不能据此断言全篇缺图或遗漏其他结果。审查须核对图例、坐标分组及计数与比例的区别；作者文字或图注与实际图像冲突时仍须指出，正文如实归属并披露矛盾时不能要求它捏造确定结论。

推送成功后追加 `publicationCommit`、相同的 `remoteVerifiedOid`、远端身份及北京时间 `remoteVerifiedAt`。远端 OID、名称或推送 URL 身份变化会使旧发布记录无法直接复用。远端验证只证明博客提交已到远端；上线还须另查对应 GitHub Pages 构建、部署和全部页面的 HTTP 200、正式地址及标题，保存核验结果。

### 同来源同分析的日批重发布

普通生成保留“已发布日期不可直接覆盖”的保护。用户明确要求同一完整日批更新模板或多级标签呈现时，使用 `npm run blog:generate -- --date YYYY-MM-DD --republish UUID`，再按正常 `blog:review`、`blog:push` 顺序发布；UUID必须为规范小写，恢复同一事务须复用同日期同UUID。只接受当前正式数据中的完整canonical日批，拒绝all、include/exclude子集、自定义数据和旧legacy范围。

`daily_republication.py` 在共享博客锁与日期锁内核验原schema-v3生成清单、审查凭证、原发布提交及实际远端祖先关系，重新核对完整来源引用、每篇四份封存文件、正式分析和受控页面/资产字节。Git index须为空；无关人工改动保留。已受控维护的当前成对词表目录可按严格兼容规则核验，其余受控文件漂移仍阻断，不能借重发布吸收手改页面。

事务保存在 `data/runtime/daily-republications/<UUID>/`：`intent.json` 记录不可变意图，`archive/` 按原相对路径逐字备份并核对SHA，`completion.json` 记录退休与准备完成；日期标记位于 `data/current/blog-republications/<DATE>.json`。原manifest、receipt、失败与安装日志等活跃指针只在完整备份后按CAS受控退休；逐页通过缓存和检查点保留原地复用。事务待激活时普通生成、审查和推送均阻断，用显式同UUID命令恢复，不手工删除标记或凭证。

这里的完成记录仅证明重发布准备事务完成，不证明新页面已审查、推送或上线。正式分析、Reader、原分类签名、来源、模型次数和费用不变；它不创建fresh分析或promotion。新页面变化仍须独立审查，新的发布提交须重新核验部署及全部目标页面，用户已取消视觉时也须建立与实际新发布绑定的有效豁免。

## 视觉任务清单

`visual-summary-manifests/<date>.json` 保存 TOP 10 排名、论文任务 token、参考图身份、生成上下文、目检声明和资产 SHA。`digest-cover-manifests/<date>.json` 保存批次标题、热门方向、排行榜及封面资产。

采用 `ephemeral-no-persisted-figure-assets-v1` 的新日更核验官方图身份后使用空引用路径；只有旧记录的兼容流程才核对实际缓存。完成任务还须匹配当前发布提交和远端 OID、任务 token、规范归档路径、图片 SHA、尺寸、格式以及 `qaAttested=true`。

用户取消配图的 `waiver` 是独立状态，绑定当前发布和两类清单 SHA，变化后失效。它只替代视觉完成条件，不能替代数据、审查、远端或上线核验。

## 归档

`data/archive/<date>/` 保存日批次快照及最终视觉资产。历史 `digest:status` 只有在候选、决定、入选及分析文件的日期和集合都匹配时，才可使用归档；当前日期不会用归档掩盖当前数据的故障。

## 只读验证

```bash
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

`validate:data --allow-empty` 只用于明确没有运行数据的干净 checkout。状态报告反映读取时的状态，后续推送、登记或取消配图后须重新运行。

`digest:status` 将当前 **version 3** 报告保存为 `data/current/digest-run-reports/<日期>.json`。

| 字段 | 当前含义 |
|---|---|
| `filter.pendingDecisions` | 候选总数减已决定数，即尚无明确决定的数量。可重试决定另计 `filter.retryableDecisions`。 |
| `analysis.expected` / `analysis.missing` | 入选集大小，以及其中未进入分析结果的篇数。`analysis.total` 是结果记录数。 |
| `blog.remoteOidVerified` | 实际远端 OID 是否与发布提交一致。 |
| `blog.publicationVerified` | 完整发布凭证是否通过核验；与远端提交分别报告。 |
| `visuals.complete/total/pending/failed` | 长图实际计数；清单不可读时为 `null`，摘要显示 `?`。 |
| `cover.status` | 按实际封面检查结果确定，检查失败不返回 `complete`。 |
| `visuals.status` | 完成声明未通过资产或发布绑定时为 `incomplete`；原 `pending`/`partial_failed` 保留，清单不存在为 `missing`。 |
| `fetch.rawCandidateCount` | 候选快照可读且为空才是 `0`；不可读为 `null`，摘要显示 `?`。 |
| `readProblems` | 文件存在但无法读取的项目：`invalid-json` 或 `unreadable`，后者带实际错误 `code`。尚未生成的缺失文件不进入此数组。 |

分析未完成时先区分“逐篇复验不通过”与“集合缺篇”。前者按当前词表、来源和阶段检查保存稿，应定位具体阻断再选择必要修复，不直接推断原运行失败或整批重跑。

读取旧报告时保留原版本：v1 的 `pendingDecisions` 计可重试决定、无 `retryableDecisions`，远端与凭证合为 `remoteVerified`，缺失视觉计数可能为 0，封面状态直接取清单；v2 的 `visuals.status` 直接取 `overallStatus`，候选缺失与空集都可能为 0，不区分坏文件和缺失文件。旧字段用于解释当时报告，最终完成仍执行当前来源、发布、部署及页面核验。


归档优先使用显式 `batchDate`，刷新时间和 `lastUpdated` 不改变批次归属；缺显式日期的旧记录才按已有时间字段处理。归档仅移动原字节，不重写原稿、费用或发布输入 SHA。异日刷新过的旧分析若曾按时间戳存到其他日期目录，上一发布证明只能按当前已审生成清单的输入 SHA 和原 `batchDate` 冷查找；目标文件已存在但损坏时必须拒绝，不能用其他目录掩盖损坏。
