# Manual v6 运行手册

[返回入口](../README.md) · [文档地图](README.md) · [架构说明](architecture.md) · [编辑要求](editorial-reference-contract-v2.md)

主助手负责创建实际运行的单篇助手、登记任务并汇总整批结果。本手册按执行顺序说明每步读取和生成什么，以及失败后怎样恢复。文件身份和 SHA 算法见[架构说明](architecture.md)，正文质量要求见[编辑说明](editorial-reference-contract-v2.md)。

## 开始前确认工作区和日期

只有用户明确要求 Manual 或人工流程时，才使用此入口：

```bash
npm run digest:manual -- YYYY-MM-DD
```

先确认位于日更工作区，并按根目录要求核对角色、环境和博客仓库：

```bash
pwd
npm run workspace:role -- status
```

角色须为 `daily`。日期使用北京时间批次日期，格式为 `YYYY-MM-DD`；抓取阶段还须符合根目录的日期限制，历史日期不能从抓取开始重跑。共享流程负责校验项目环境、代理和博客配置，不能因默认 API 的网络、模型或配额失败就自动切换到 Manual。

正式模式（`production`）、隔离模式（`shadow`）和旧 v5 维护使用各自路径，不能混用文件。主助手直接管理单篇任务队列，任务管理器不创建单篇助手。其他发布渠道与实际生图操作另见根目录说明。

## 一、抓取与筛选候选

先获取原始候选：

```bash
npm run manual:fetch -- --date YYYY-MM-DD --raw
```

`--raw` 访问 arXiv/HuggingFace，不调用筛选模型。检查输出中的完整候选、逐来源健康信息、checkpoint 和输入 SHA。某来源暂时失败时，不能将不完整集合宣布为完整。

主助手逐篇给出 `manual_offline` 决定，再提交筛选 spec：

```bash
npm run manual:fetch -- --date YYYY-MM-DD --select FILTER_SPEC.json
```

筛选文件必须恰好覆盖原始候选全集，既包含选中项，也包含明确排除项。缺失、未知或重复 ID，日期不一致、理由不足都会失败；标题关键词脚本不能冒充逐篇人工决定。

多人分片筛选时，由合并程序检查和合并至少两份 `--part`：

```bash
npm run manual:filter-merge -- --date YYYY-MM-DD --reviewer REVIEWER_ID \
  --part PART_1.json --part PART_2.json [--output MERGED_SPEC.json]
```

方括号表示可选参数，执行时不要将括号作为命令字符；文件路径使用真实输出，`REVIEWER_ID` 填实际审查者身份。

## 二、保存全文与结构化来源

```bash
npm run manual:fulltext -- YYYY-MM-DD
```

提取器在转成纯文本之前保存表格矩阵及合并单元格关系、MathML/TeX、图片、章节、正文引用和参考文献，并为每篇建立 `ArtifactIndex` 来源索引。

每篇入选论文须达到 `inventoryHealth.status=complete`。受支持的结构化来源需核对表格、公式、图片、引用的检测和恢复计数，且无截断、未解决的解析问题；表格还须有能够按原始记录重新构建的单元格矩阵。PDF 或纯文本回退仍是 `incomplete`，没有解析到条目不能证明论文没有这些内容。

单篇失败时保留其他论文仍可继续使用的阶段检查点，修复对应来源再续跑。不要删除整个日期目录或手改 `incomplete` 为 `complete`。

## 三、初始化单篇任务

```bash
npm run manual:tasks -- init --date YYYY-MM-DD
npm run manual:tasks -- status --date YYYY-MM-DD
```

正式模式默认读取标准 `filtered-papers.json`；`init` 也可用 `--papers PATH` 显式指定入选文件。每篇包含四个角色，依赖如下：

```text
author
  ├── technical_scoring ─────┐
  └── pedagogy_readability ──┤
                            ▼
                     author_revision
```

初稿验证通过后两个审查任务才可运行，两者都通过后才可修订。不同论文可并发，同篇不能跳过依赖。这里的“通过”是管理器核验文件与角色要求后记录的 `validated`，不能用单篇助手一句“完成”替代。

## 四、创建并推进一个角色任务

### 生成任务输入包

```bash
npm run manual:packet -- --date YYYY-MM-DD --paper ARXIV_ID --role ROLE
```

`ROLE` 只能为 `author`、`technical_scoring`、`pedagogy_readability` 或 `author_revision`。命令输出当前输入包（`packet`）、单篇文件目录及准确的注册参数，使用这些实际输出，不从示例推算路径。

输入包列明允许读取的文件、SHA 和角色结果格式。结构校验通过不等于实际文件可用：注册、状态恢复和结果汇总都重读文件；作者和修订作者还须满足仓库当前提示词、编辑要求的 SHA。旧副本和旧包自洽，也不能绕过当前检查。

### 注册输入包

原样使用上一步返回的路径：

```bash
npm run manual:tasks -- register --date YYYY-MM-DD \
  --paper ARXIV_ID --role ROLE \
  --artifact-root ARTIFACT_ROOT --packet PACKET_JSON
```

`register` 核验并登记文件白名单，不领取任务或创建单篇助手。

### 领取可运行任务

```bash
npm run manual:tasks -- claim --date YYYY-MM-DD --limit 3
```

`--limit` 默认为 3，范围 1–3。管理器只领取依赖满足的任务，并按当前已领取或运行的任务计算剩余容量。平台共 4 槽，主助手占 1 槽，最多同时运行 3 个单篇助手。

### 创建真实子代理并登记任务名

主助手根据 claim 创建只处理当前论文、当前角色的单篇助手。平台返回唯一任务名后，才能执行：

```bash
npm run manual:tasks -- start --date YYYY-MM-DD \
  --claim CLAIM_ID --task-name TASK_NAME \
  --model gpt-6.1-sol --reasoning-effort high
```

不能提前 start，也不能用虚构任务名占位。开始时必须如实声明模型和推理等级，管理器保存这份声明，组合器据此填写凭证；字段核对不能单凭记录证明远端平台实际使用了该模型。主助手及四个正文角色均使用 `gpt-6.1-sol/high`。新输入包版本 4、管理器状态版本 2 和提交凭证版本 2 都必须带 `manual-agents-sol-high-v2`；凭证必须填写真实模型、推理等级和任务信息，不能以其他模型运行后借用当前标识。旧状态、输入包和凭证只按原模型规则读取，不继续新领取、启动、提交或重试。

### 提交结果与凭证

单篇助手只读取白名单文件，按 `outputContract` 写入规定结果和提交凭证。完成后提交：

```bash
npm run manual:tasks -- submit --date YYYY-MM-DD \
  --claim CLAIM_ID --output OUTPUT_JSON --receipt RECEIPT_JSON
```

`submit` 重读真实文件，核验论文身份、模型/推理等级、输入 SHA、输出结构及角色规则。全部通过才记录 `validated`，验证后不能原地修改文件。

### 记录失败并恢复

```bash
npm run manual:tasks -- fail --date YYYY-MM-DD \
  --claim CLAIM_ID --reason REASON

npm run manual:tasks -- abandon --date YYYY-MM-DD \
  --claim CLAIM_ID --reason REASON

npm run manual:tasks -- retry --date YYYY-MM-DD \
  --paper ARXIV_ID --role ROLE
```

单篇助手明确返回失败时用 `fail` 保存原因；平台已确认任务终止，但领取记录未正常结束时用 `abandon`；失败或放弃后，用 `retry` 重新开放对应论文和角色。不能只凭等待时间推断任务已经终止，否则可能出现两个单篇助手同时写同一目录。

## 五、四个角色分别交付什么

| 角色 | 实际允许输入 | 结果与职责 |
|---|---|---|
| `author` | 当前论文元数据、来源快照、全文、来源索引、提示词、编辑要求、空白结构模板；索引声明的结构化来源、授权图片及可选官方项目证据 | 写新初稿和研究蓝图，绑定事实与来源；不读旧分析、旧正文、博客页或其他论文 |
| `technical_scoring` | 来源索引、空白模板、已验证初稿输出/凭证及初稿文章、结构化初稿 | 交八维评分、8 条论文特有理由、证据 ID 与独立校准；不改正文或自创尺度 |
| `pedagogy_readability` | 与技术审查对应的受控初稿文件和来源索引 | 检查解释、术语、段落承接、章节职责与图表；交具体问题记录，不只评文风好恶 |
| `author_revision` | 逐项复用 author 的原始证据及其顺序，加两份已验证审查结果 | 重新写完整终稿、来源映射和问题处理记录；不读取前稿局部修补，不改变审查者分数 |

两个审查角色没有单独获准读取完整全文文件，须按生成的实际白名单工作，不能自行扩大上下文。四个角色的任务名必须互异。

初稿正文和结构化记录分别写入 `draft/author-article.md`、`draft/author-record.json`，以 `outputs/author.json` 描述，凭证为 `receipts/author.json`。两个审查结果写入 `reviews/technical-scoring.json`、`reviews/pedagogy-readability.json`，各有对应的提交凭证文件。修订作者交 `draft/final-article.md`、`draft/revision-binding-map.json` 和修订记录，组合器最终生成 `outputs/author-revision.json` 与 `receipts/author-revision.json`。以当前输入包指定路径为准。

修订要求依据原始证据重写整篇，与 API Reader 的局部修复是不同流程，不能将补丁当成 Manual 完整替换稿。

## 六、核验修订稿与独立审计

修订作者完成终稿和来源映射后，依次执行：

```bash
# 将映射中确定的来源表格等内容写入已有终稿
npm run manual:bind-revision -- --date YYYY-MM-DD \
  --paper ARXIV_ID --prepare

# 只在内存重新构建完整单篇记录，并检查正文来源
npm run manual:bind-revision -- --date YYYY-MM-DD \
  --paper ARXIV_ID --preflight
```

映射不在默认位置时可加 `--map PATH`；`--prepare` 与 `--preflight` 互斥。预检通过后，由独立的 `gpt-6.1-sol/high` 审计任务核对当前文章和映射 SHA 及完整语义要求，至少记录两轮真实检查，最终无遗留问题，并将审计写入输入包规定位置。新审计使用版本 2、`manual-v6-independent-revision-audit-v2` 和当前 `modelPolicy`，如实记录模型与任务信息。四个正文角色的实际提交结果、开始记录中的模型声明及独立修订审计须分别核对，不能用构造的审计样例代替真实审查。预检的内部结构占位不是模型审查，不能保存为正式审计凭证。

最后不带模式参数运行组合器：

```bash
npm run manual:bind-revision -- --date YYYY-MM-DD --paper ARXIV_ID
```

它将已完成的文章、映射、审查与审计组合成规定结果和凭证，不替作者写正文。随后按第四节执行修订角色的 `submit`。

教程写作通常要求 8–18 个论文特有三级标题；当前 v2 编辑计划的 4–8 个锚点、输入包说明的 2400–24000 字符和 `reader-longform-v2` 的 6–32 个内容块是不同对象。V6 单篇记录检查至少 2400 字符，其他独立教程质量检查另有 6000 字符与 8–18 节要求；不能据某个检查通过宣布全部满足。具体适用范围见[正文结构说明](editorial-reference-contract-v2.md#正文顺序跟随理解需要)。

## 七、纠正论文元数据

只有论文元数据身份有误且已有来源证据时，才进入这个独立状态机：

```bash
npm run manual:correction -- packet --date YYYY-MM-DD --paper ARXIV_ID
npm run manual:correction -- register --date YYYY-MM-DD --paper ARXIV_ID
npm run manual:correction -- claim --date YYYY-MM-DD [--paper ARXIV_ID] [--limit N]
npm run manual:correction -- start --date YYYY-MM-DD \
  --claim CLAIM_ID --task-name TASK_NAME \
  --model gpt-6.1-sol --reasoning-effort high
npm run manual:correction -- submit --date YYYY-MM-DD --claim CLAIM_ID
npm run manual:correction -- manifest --date YYYY-MM-DD
npm run manual:correction -- status --date YYYY-MM-DD
```

中断后的恢复入口为：

```bash
npm run manual:correction -- retry --date YYYY-MM-DD --paper ARXIV_ID
npm run manual:correction -- abandon --date YYYY-MM-DD \
  --claim CLAIM_ID --reason REASON
```

`N` 只能为 1–3，不传时使用实现的活动任务上限。`--force` 只用于 `packet` 和 `manifest`，仍核字段、证据及 SHA。纠错清单完成后，从最早受影响节点重新生成正式任务输入包；不能直接改单篇记录或正式分析结果。

## 八、汇总单篇与整批结果

四个角色都 `validated` 后运行：

```bash
npm run manual:records -- --date YYYY-MM-DD
npm run manual:spec -- --date YYYY-MM-DD \
  --records data/current/manual-v6/YYYY-MM-DD/records-v4.json
npm run manual:analyze -- --date YYYY-MM-DD \
  --spec data/current/manual-v6/YYYY-MM-DD/spec.json
```

`manual:records` 重读每篇输入包、结果及凭证，生成单篇记录和整批文件。新记录、整批 records、spec 和正文分块文件 `manualReaderLongform` 必须保存当前 `modelPolicy` 并纳入 SHA；records 4、spec 6 和正文分块格式 `reader-longform` 2 的格式数字保持不变。旧缺标识记录只按原规则读取，不自动补字段或重算旧 SHA。`manual:spec` 重验论文全集、来源索引、records、任务证据和正文映射，生成每篇发布输入及 batch Merkle root。`manual:analyze` 再次验证 spec，写标准 `data/current/deep-analysis-result.json`。

`manual:records` 支持显式 `--force`；`manual:spec` 和 `manual:analyze` 也支持在已有输出变化时显式覆盖。它只允许覆盖目标文件，不跳过任何校验。集合、路径、SHA、来源身份或 Merkle 不符仍会失败，四角色完成也不等于已发布。

## 九、独立逐页审查与博客发布

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:manual-plan -- --date YYYY-MM-DD
```

计划输出需要新审查的页面、可复用的逐页通过记录，以及批次审查声明（`attestation`）的保存路径。逐页通过记录按相对路径和正文 SHA 永久复用；页面字节未变时，模型或批次规则变化不要求重审。新增、内容变化或尚未通过的页面由独立的 `gpt-6.1-sol/high` 助手审查，并登记真实任务名。审查者只读页面；需要修改时回到生成或修订阶段，产生新 SHA 后重审该页。

新签发的人工审查声明使用版本 4 和当前 `manual-agents-sol-high-v2`。新审页面的身份使用版本 2，记录真实 `gpt-6.1-sol/high`、隔离上下文、任务名和逐图审查结果；复用页明确保存 `cacheReuse` 原证据，由程序核验实际缓存中的路径、正文 SHA 和原身份，不能伪装成本次模型审查。原记录没有模型信息时明确写未记录，不补填 Sol；已有原身份不得覆盖。缓存元数据可以更新，但原证据副本继续保留。读取新凭证时须再次核验原缓存证据，当前批次的 Git、生成清单和 Hugo 检查仍须通过。旧版本 2、3 声明及原整批有效凭证按原身份读取，不自动改写版本、模型或 SHA。

论文页审查任务的 `paperId` 填写无版本号的规范 arXiv 基础编号，支持 `2608.12345`、`0704.0001` 和 `hep-th/9901001`。这里不接受网址、`arxiv:` 前缀或 `vN`，并须与本页的论文身份一致。

逐页记录完成后：

```bash
npm run blog:manual-attest -- --date YYYY-MM-DD
npm run blog:manual-review -- --date YYYY-MM-DD --attestation ATTESTATION.json
npm run blog:push -- --date YYYY-MM-DD
```

`push` 重验页面生成清单、页面 SHA、审查凭证、Git 基线、允许提交差异和远端 OID。远端 `main` OID 等于本次发布提交，只表示提交已到远端。

宣告上线前还须核对 GitHub Pages 构建和部署成功，部署对应发布提交或保留已审字节的后续提交；逐页记录 HTTP 200、正式地址和标题。按根目录要求完成论文配图与封面，或保留用户明确且仍有效的视觉取消记录。视觉取消不能替代数据、审查、远端和上线核验；推送或登记后重新读取最终状态。

只发布单篇时，生成页面、准备审查计划、汇总审查声明、审查页面和推送这五步，都传同一个 `--include-id ARXIV_ID`。不能因此删除同日其他页面或建立整批视觉任务。

## 十、状态与恢复矩阵

```bash
npm run manual:work-queue -- --date YYYY-MM-DD
npm run manual:tasks -- status --date YYYY-MM-DD
npm run digest:status -- --date YYYY-MM-DD
```

| 状态或症状 | 含义 | 下一步与限制 |
|---|---|---|
| `awaiting_packet` | 当前角色没有有效输入包 | 生成包，使用返回参数 register；不猜路径或借其他论文的包 |
| `pending` | 输入有效、依赖满足，等待领取 | 有容量时 claim 并创建真实单篇助手；不手改成 running |
| `blocked` | 上游角色尚未 validated | 完成上游再查状态；不跳过依赖直接修订 |
| `claimed` | 已领取，未登记真实任务 | 创建单篇助手后立即 start；不长期占位或填假任务名 |
| `running` | 真实任务已登记 | 等待提交；只有确认终止才 abandon，不凭超时重复创建 |
| `validated` | 结果和凭证已核验 | 推进下游；不原地修改验证文件 |
| `failed` | 有明确失败记录 | 修复后 retry 指定论文和角色；不删状态或凭证掩盖失败 |
| `stale` | 输入或协议 SHA 不再一致 | 从最早变化节点重新生成、注册、提交；不改旧 SHA |
| 作者包与仓库当前要求不符 | 包内副本及外层 SHA 可仍自洽，但当前提示词或编辑要求已变化 | 保留旧证据，按正常流程重建受影响输入和下游；不能仅保存旧副本继续 |
| `awaiting_records_envelope` | 四角色完成，整批 records 尚未生成 | 运行 manual:records，再验证 spec；不能直接宣告批次完成 |
| 页面 SHA 变化 | 审过的字节与当前页面不同 | 重审变化页，汇总当前批次凭证；不能复用不符的批次审查声明 |
| 推送后 OID 不符 | 提交尚未得到远端确认 | 恢复 push 或远端核验；不能宣告已发布 |

定位最早不符的输入，保留无关的健康任务，再重做对应下游。状态报告只是读取时快照，不能替代上线检查，也不能在后续写入后继续当作最终状态。

<a id="十一性能观测"></a>

## 十一、性能统计

```bash
npm run manual:performance-report -- \
  --date DATE_1 --date DATE_2 --date DATE_3
```

将三个占位日期换成不同的真实 `YYYY-MM-DD`。`--date` 可重复提供，但不能重复同一日期；`--output PATH` 只能写受控的运行统计记录目录，且不能覆盖文件。报告只读取真实的附属统计文件；一个指标不足 3 个不同日期时显示 `insufficient_data`，不能从理论耗时推算 P50/P95。

## 十二、隔离审计与旧格式维护

隔离模式用于审计和比较，不发布：

| 入口 | 参数 | 实际范围 |
|---|---|---|
| `manual:v6:shadow:spec` | `--date`，至少一个可重复 `--records`，可选 `--force` | 只生成隔离模式的批次输入 |
| `manual:v6:shadow:analyze` | `--date --spec`，可选 `--force` | 只写隔离模式的分析结果 |
| `manual:v6:tasks` | 正式管理器参数，追加 `--shadow` | 状态只保存在隔离模式的数据根 |
| `manual:shadow` | `--date`；可选 `--output`、可重复 `--metrics` | 默认只读审计 |
| `manual:shadow -- --init-shadow` | 另需 `--workspace` | 只允许北京时间当天的新批次 |
| `manual:shadow:benchmark` | 至少一个可重复 `--report`；可选 `--output` | 少于 3 个真实批次不计算性能分位数 |

旧 v5 文件只供读取和核验，以下旧写入命令不再执行。新任务使用当前模型规则的 v6 入口；工作队列只输出已有记录与观察统计：

| 旧入口 | 原参数（不构成新写入许可） |
|---|---|
| `manual:v5:spec` | `--date`、至少一个可重复 `--records` |
| `manual:v5:analyze` | `--date --spec`，可选 `--force` |
| `manual:v5:author-packet` | `--date --paper` |
| `manual:v5:promote-draft` | `--date --paper-id --source-dir --technical-review --readability-review --figure-review`；可选 `--author-packet` |
| `manual:v5:work-queue` | `--date`；可选 `--observations`、`--output-dir`、`--no-sidecar` |

旧 spec、analyze、author-packet 和 promote-draft 的新写入已关闭。work-queue 可保留观察统计附属文件，不生成新的作者材料或正文。这些入口不能生成新正式模式的 v6 证明、混入 v6 批次或建立新视觉任务。Python v5 写作来源及既有封存预览仍核当前固定路径和字节 SHA；仅保存旧提示词或编辑要求副本，不保证旧预览能重新通过检查。预览中 `editorialContract` 绑定提示词，`referenceContract` 绑定编辑要求，不能混用。预览没有新写入口。

静态旧文章的阅读、旧任务恢复、预览复验和重新发布各有边界，不能由某个包的失败推断全部历史文章不可读。哪些程序读取这些旧记录，以及各自允许什么操作，见[历史兼容边界](architecture.md#历史兼容边界)。
