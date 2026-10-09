# 数据、状态与发布记录

## 本页目标

本文说明各类文件保存什么、哪些值需要相互核对，以及失败后能否继续运行。字段的具体校验以程序为准；人工流程的数据说明见 [Manual 入口](../manual/README.md)。

## 数据分类

| 类别 | 保存内容 |
|---|---|
| 持久论文库 | `papers.json` 跨运行保存论文和去重状态，不随日期批次移走。 |
| 日期批次 | 当前或归档目录中的候选、筛选决定、入选论文和分析结果。 |
| 发布与视觉记录 | 页面生成清单、审查记录、发布提交、配图任务及资产信息。 |
| 跨批次请求状态 | `data/runtime/llm-account-pool.json` 保存当前账号及额度冷却状态，不随日批次归档。 |

文件存在或写有 `complete`，都不能单独证明完成。程序还须核对该文件与输入、来源和其他状态文件是否一致。SHA 用于确认内容身份，不能证明文章事实正确，也不是评审人的数字签名。

不同对象中的 `generation` 含义不同：来源目录用它区分获取次数，账号池和可变数据用它记录更新次数，博客生成清单记录一次页面生成。这些编号都不是 arXiv 论文的 `vN` 修订号。

## OpenCode Go 账号池状态

`data/runtime/llm-account-pool.json` 使用 `opencode-go-sticky-quota-failover-v1`。它保存服务和账号的 SHA-256 身份、当前账号、归一化额度窗口、`blockedUntil` 及更新计数，不保存 API key、认证头、请求或响应正文。账号稳定指纹仍属于敏感操作信息，文件权限须为 `0600`，不得上传或归档。更换密钥会形成新的账号身份，但账号身份不进入筛选、分析或发布内容的指纹。

Node 与 Python 使用同一目录锁和原子写入方式；锁只覆盖账号选择与状态更新，HTTP 请求在锁外发送。未知格式、损坏 JSON 或符号链接状态路径会使程序停止。只有明确的 HTTP 429 `GoUsageLimitError` 或 HTTP 401 `Insufficient balance` 才触发向后切换及冷却记录；普通认证 401 停止运行，其他 429、5xx、传输或内容失败不触发切换。冷却到期也不会自动把流量从当前成功账号切回。

## `data/current/` 核心文件

### `papers.json`

跨运行去重库。每篇的 `digestStatus` 可记录分析成功、待分析、失败和最近一次尝试。旧成功正文可以保留，但后来的失败仍须写入 `latestAttemptStatus`，不能用旧结果掩盖最新失败。

### `fetch-checkpoint.json`

按 arXiv 类别和 HuggingFace 保存来源状态、候选数、内容 SHA 及恢复信息。某一来源损坏只使该来源的记录失效；必需来源未完成时，下游不能声明完成。

来源协议从 v5 升至 v6 时，HuggingFace 两个端点都须提供规范 arXiv 编号及非空题目、摘要，重复 ID 页也先核验条目。此次协议升级会改变整个 `candidateFingerprint`，所以旧 v5 抓取检查点整体不能复用，与同一协议下仅某个来源损坏的处理不同。目标日期仍为北京时间当天时，重新运行同一日更入口可以重新抓取；历史日期不能从抓取阶段续跑，须使用受控历史维护流程。升级不改写或重签已有运行数据；条目格式完整也不等于全文真实性已经核验。

### `raw-candidates.json`

当日合并、规范化并排除已发布论文后的完整筛选输入。筛选决定必须覆盖这份候选集合，不能只对成功响应的论文计算覆盖率。

### `filter-decisions.json`

按规范论文 ID 保存模型或关键词预筛的决定、理由、原始响应、解析方式、输入 SHA 和配置指纹。模型、提示词、协议或关键词规则变化时须重新筛选；仍完整有效的候选数据不必重新抓取。

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

解读失败候选只供恢复，不能作为成功分析或发布依据。新版表格数量诊断使用 `code=reader_table_count_insufficient`、`requiredCount` 和 `actualCount`。计数必须是安全整数，满足 `requiredCount >= 1`、`0 <= actualCount < requiredCount`；带该错误代码却缺少有效计数时，不得从说明文字补出计数。`diagnosticOnly: true` 的记录仅供参考，不触发修复动作。旧保存诊断只由限定的兼容读取处理，不能让新的自然语言报错决定修复动作。通用草稿哈希及已有恢复身份的计算规则不变。

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

主结果覆盖检查按结果或消融章节中的实测数值单元格计数。年份、数据集规模、样本数、训练配置和模型版本号不能补足结果数量；交错列和转置指标表仍按原布局检查。该检查用于完整 Reader 解析和失败草稿修复，现存成功记录的所有快速复用入口尚未统一重核，不能据此宣告旧文章已全部补齐主结果。

`source_quotes` 表格的列头单位也属于数值证据。裸单元格数字须由同一指标、同一局部分句的明确单位声明支持，不能借另一指标或另一句话中的百分号、秒或毫秒；单元格已明确写出的单位继续按原数字引文规则核验。仅有共享表头而无法逐值定位时，要求按原文修复来源记录或明确单元格单位，不自动转换数值。旧成功记录和 Python 发布同样执行这项检查；`artifact_table` 仍按原表 DOM 逐格核验。

旧窄表曾把不明归属的 `validation set` 写成 `TidyVoice`。相同旧表形状现在须有直接说明二者关系的逐字来源引文，另一个句子的同名数据集或较长数据集名称不能补足这项证明。新生成不再猜数据集，也不再按指标名称自动给散文补百分号；旧散文的逐句单位证据尚未完整迁移，不能据此宣布所有历史文字已经修正。

原始 TeX 在等号后截断时，不再根据公式名称或可见文本猜补，须去掉该展示公式并依据完整原文解释。旧实现曾猜补的一条 CTC 公式，以及 `2609.15067` 中曾按图片文件名写死的图注，若新结果仍包含相同表达，计划会自动保存 `structuredSourcePayload`：与既有结构化来源 SHA 对应的原始 JSON 内容。恢复与发布逐项核对全文 SHA、公式或图片位置、DOM SHA 和原始内容；输出自身哈希或布尔声明不能替代来源。该字段只在这些兼容场景增加一份完整结构化内容，普通记录不增加。旧 `2609.27195` 中无像素证据的固定图中叙述须移除后重新核验。

受影响的旧缓存不能直接复用；从封存来源正常重建 Reader，并重新生成和审查待发布页面。来源记录保持原字节，不手改计划补签，也不为此重新抓取历史日期来源。

新日更的图片只在调用时准备像素，不保存图片文件到运行目录。`apiReaderFigures` 中存在像素 SHA 不代表还有可复用缓存。兼容早期结构化来源时，须通过来源清单和全文 SHA 校验；处理旧键序哈希还须能按记录的解析器版本重验，或属于实现认可的无布局来源且表格、公式和图片数组均为空。任意布局声明不能取得兼容资格，已保存的文件也不能被重写来制造新 SHA。

## 博客生成清单

schema v3 生成清单记录日期、`category`、博客基线 `HEAD`、精确非空页面和受控下载文件集合、逐文件 SHA、新建或覆盖或删除状态、输入及模板指纹、实际渲染的 `publishedPapers`、一致的 `publicationMode` 与发布依据，以及发布后视觉能力。

默认 API 使用 `llm_api_production`；显式 Manual 使用自己的发布依据。混合两种来源、缺少绑定或使用旧 schema，不能用于新日更发布。

Reader v3 和 Manual v6 新论文页使用 `researcher-workbench-v1` 页面元数据，保存读者标题、原始标题、规范 arXiv ID、明确输入或由已保存并核验的来源确定的 `vN`、版本一致的 abs/PDF URL、主任务、数值评分、排名分档、文档类型、一句话主线、结构化作者及原摘要 SHA。原始摘要保存在同批 `static/data/papers/<date>/<safe-arxiv-id>/rethink-context.json`，不塞入页面元数据。

每篇有四个同源下载文件：`citation.json`、`citation.bib`、`citation.ris` 和 `rethink-context.json`。写入暂存结果前校验路径、LF/UTF-8、JSON/TeX/RIS 转义及 256 KiB 上限；四个 SHA 同时记录在页面元数据、生成清单和审查记录中。审查从 `publishedPapers` 快照重建这些文件并逐字比较，推送只允许审查记录指定的精确变更。

新 `rethink-context.json` 使用 `paper-research-context-v2`、`schemaVersion=2`，标签记录位于 `assessment.tagMetadata`。页面 `paper_digest_sidecars` 中该文件的记录保存 `contract`、URL 和 SHA。旧 `researcher-sidecars-v1`、`schemaVersion=1` 使用原 `assessment.taxonomy`，原页面记录不带新的格式标识；读取时按旧格式重建，不改写原文件。格式与版本须正确配对，新旧标签字段不能混用，即使值相同或为空。其他三份引用文件保持原格式。

历史版本引用采用已核验的 `sourceVersion.selectedSourceId`。输入和已保存来源都没有明确版本时，保存 `version: null` 并使用无版本 abs/PDF URL，不能猜成 `v1`。

新论文把 3–5 个当前分类表中启用的首选标签写入 Hugo 的 `tags`，并记录 `paper-tag-flat-tags-v2`、选择规则、分类表版本及 SHA、有序的 `{id, facet, label}`、显式主任务和主方法。标签采用中文首选名称；既定 `CNN/RNN/SFT/CTC/LoRA/Adapter/Transformer/Conformer` 八个专名保留原形，并在分类表中配中文别名，不能扩成任意英文标签。`rethink-context.json.assessment.tagMetadata` 保存同一分类信息。旧页面仍按原 `paper-taxonomy-flat-tags-compat-v1` 读取，不因新发布而改写。两版的标签规则相同；汇总页“热门方向”只统计主任务。

## 审查记录与远端发布

审查记录绑定生成清单 SHA、实际页面 SHA、当前审查协议、Git 基线、Hugo 构建结果和配置、布局、数据、前端代码的运行时指纹，以及发布依据。逐页通过记录单独保存，只按“相对路径 + 页面内容 SHA”长期复用。

发布器代码变化仍使生成阶段重新渲染，以发现真实字节变化。模板、站点脚本、模型、发布器代码、协议或生成清单元数据变化时，须重跑当前批次检查并生成新审查记录；最终内容未变的页面仍复用原通过记录，只有内容变化的文件重新审查。

推送成功后追加 `publicationCommit`、相同的 `remoteVerifiedOid`、远端身份及北京时间 `remoteVerifiedAt`。远端 OID、名称或推送 URL 身份变化会使旧发布记录无法直接复用。远端验证只证明博客提交已到远端；上线还须另查对应 GitHub Pages 构建、部署和全部页面的 HTTP 200、正式地址及标题，保存核验结果。

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

`digest:status` 把结果写成 `data/current/digest-run-reports/<日期>.json`。这份报告的 `version` 现在是 **3**。**`version: 1` 是旧口径；`version: 2` 起改成下面这些说法；`version: 3` 又收紧了 `visuals.status`、`fetch.rawCandidateCount` 两处取值域，并新增 `readProblems`。**

- `filter.pendingDecisions`：**还没拿到明确决定的候选数**（候选总数减去已决定数）。v1 里它取的是「已经有决定、但决定本身可重试」的条数，运行在写完全部决定之前被杀时会显示 0，把缺口藏起来。要判断「可重试」请看同一节点下的 `filter.retryableDecisions`（v1 没有这个字段）。
- `analysis.expected` 与 `analysis.missing`：分母是筛选入选集大小，缺口是入选集里没有出现在分析结果中的篇数。`analysis.total` 的含义没变，仍是分析结果本身的条数。
- `analysis` 未完成时的文案会区分两种情况：**逐篇复验不通过**（按当前词表和检查规则重新核验已保存记录，不等于当时那次运行失败）与**集合缺篇**。不能仅凭前者就整批重跑，也不能断言无需修复；应先定位来源、正文、标签或阶段指纹的具体失败，再选择必要的修复或重分析范围。
- `blog.remoteOidVerified` 与 `blog.publicationVerified`：前者只说明远端 OID 与发布提交是否一致，后者是整份凭证是否通过校验。v1 把两者合成一个 `remoteVerified`，凭证因为别的原因失效时会被读成「没推到远端」。
- `visuals.complete/total/pending/failed`：读不到长图清单时是 **`null`**，摘要打印 `?`。v1 用 `|| 0`，把「清单不存在」显示成「一张都没做」。
- `cover.status`：由实际检查结果确定，检查不通过时不会说 `complete`。v1 直接镜像清单内层说法，出现过「封面 incomplete 但 status=complete」。
- `visuals.status`：同样由实际检查结果确定（v3 起）。清单自称 `complete` 而资产校验或发布绑定已经失败时，这里说 `incomplete`；清单自己写的是 `pending`／`partial_failed` 就照说；清单根本不在才是 `missing`。v2 直接镜像清单内层的 `overallStatus`，当时的归档日期里有 29 天打出过 `长图 incomplete | status=complete | complete=10/10 | pending=0 | failed=0`（归档随日更增长，这里不写死当时的日期总数）。
- `fetch.rawCandidateCount`：候选快照读不到时是 **`null`**，摘要打印 `?`（v3 起）。快照在、候选确实为空才是 `0`。v2 把两种情形都写成 `0`，于是出现过 `candidates=0` 同屏 `selected=53`。
- `readProblems`：列出「文件存在但读不出来」的项，`kind` 为 `invalid-json` 或 `unreadable`（后者带 `code`，例如 `EISDIR`）。文件不存在不会进这个数组，也不算错误——那只是这一步还没跑。v2 把损坏与不存在都返回 `null`，运维分不出该重跑还是该修文件。
