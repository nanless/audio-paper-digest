# 全历史博客重写：实施路线图（历史设计记录）

本文保存已经废止的设计方案：先用 crosswalk 核验所有页面对应的论文，再进入 P0–P5、试点和逐批扩大运行。后文的统计、协议提案及 `planned` 命令均属于那份方案，不是现在的执行要求，也不能复制执行。

现在的历史重写以 [历史重写流程](history-rewrite.md) 为准。流程合并本地会议元数据/PDF 与冻结页面已有的单一 arXiv 线索，建立输入和计划；`direct-scheduler` 负责获取并封存来源，`direct-run` 只读取同一计划和来源获取序号 `generation` 下已标为 `ready` 的文件。arXiv 的文本、PDF、运行记录和来源清单须重新获取并封存，会议来源须核验本地元数据和 PDF SHA。

只有新 arXiv 获取失败后生成的命名交接文件才能进入备用来源流程；会议本地文件缺失或损坏须停止该论文，不能转入这个备用流程。旧 crosswalk 仍可用于显式维护旧状态，但不再是普通直接重写的前提。当前已有 [历史直接发布流程](history-direct-publication.md)，不同于本文设计时尚不完整的旧私有发布入口；这也不表示全部历史论文已经重写或发布。新会议另见 [会议工作流](conference-workflow.md)。

所有脚本和测试仍须遵守根目录 `AGENTS.md`。旧正文不得进入新的分析或 Reader 输入；来源、页面集合、Git、Hugo 或远端核验不一致时停止。远端 OID 只能证明提交已推送，宣告上线还须核验对应部署以及正式网页的 HTTP 200、地址和标题。

<a id="1-目标范围与当前基线"></a>
## 1. 目标、范围与当时基线

当时的目标是重新核验论文来源，生成正式分析结果、Reader、评分和分类，再按已发布页面的身份生成新页面。旧页面只提供身份、公开 URL、汇总成员关系和恢复基线，旧正文不能成为写作素材、事实证据或分类依据。

当时冻结的页面清单如下。数字描述那份清单，不是所有历史任务通用的数量门槛。

| 页面类型 | 数量 | 必须保持的身份 |
|---|---:|---|
| 单篇论文页 | 4,185 | `pageId`、路径、正式 URL、发布日期、所属批次、发布或草稿状态 |
| 日更汇总 | 109 | 日期、路径、URL、论文成员与内部链接拓扑 |
| 会议汇总 | 3 | ICASSP 2026、ICLR 2026、ICML 2026 的独立范围 |
| 会议任务页 | 193 | ICASSP 140、ICLR 53、ICML 0；保留任务标识与成员关系 |
| 合计 | 4,490 | 受版本控制页面集合与 Hugo 已发布页面集合完全对应 |

清单还记录了 14,743 次内部文章链接，当时均能唯一解析，没有 URL 冲突。实际验收须读取最终页面清单及其核验凭证，不能将这份文字中的数字当作输入。

`content/about.md`、`archives.md`、`conferences.md`、`links.md`、`papers.md` 和 `search.md` 等站点根页面不在这 4,490 个历史文章页面内。该方案要求保持它们的 Git 字节不变，同时检查 Hugo 仍能正确索引新页面；修改这些入口须另列明确授权的新增或变更项。

4,185 个论文页面提供的身份线索仅是候选，尚未全部验证。表中的 `single/none/conflict/multiple` 分别表示单一线索、无线索、冲突和多条线索。

| 范围 | 单一线索 | 无线索 | 冲突 | 多条线索 | 合计 |
|---|---:|---:|---:|---:|---:|
| 日更 | 2,692 | 116 | 72 | 3 | 2,883 |
| 会议 | 130 | 1,161 | 8 | 3 | 1,302 |

旧分类预览另记录了 2,767 个带 arXiv 候选的页面、2,651 个候选唯一 arXiv ID、110 组候选重复 ID 和 1,418 个未定 ID 页面。得到的 4,069 条展示记录不等于 4,069 篇已验证的唯一论文。方案将最终唯一论文数记作 `U`，要求从完成核验的 crosswalk 计算。

同一 `iclr-2026` 范围包含两个发表批次：2026-05-02 的 134 篇和 2026-05-04 的 133 篇。论文去重不能合并批次，生成页面时也不能将两批改成同一日期。

<a id="2-现有能力的可复用边界"></a>
## 2. 设计时已有能力及复用限制

<a id="21-历史-inventory-与-crosswalk"></a>
### 2.1 历史页面清单与来源对应表

当时 `npm run history:inventory` 能保存 `content/posts` 的 Git、Hugo、页面和链接快照，使用 O_EXCL、0600、双文件凭证及写入前后的 repository CAS，防止基线变化时继续写入。`npm run history:crosswalk` 能从核验程序实际生成、不能自行构造的清单引用对象创建 4,185 个页面对应记录，保存状态 SHA 和只追加的决定，并从崩溃或失效锁中安全恢复。

`paper-source-authority-v1` 及 crosswalk 的 verified/finalize 基础已实现。每项 verified 决定绑定 pageId、内容 SHA、完整论文身份记录及双 SHA、来源授权文件及其自身 SHA，以及来源证据类型。同一论文的多页确定性分组，全部 verified 才生成不可变的最终凭证。每次读取仍须使用核验程序实际生成、具有生产授权的引用对象，重新读取并核验来源，标题证据始终不足。

设计时，真实 arXiv 来源授权采集器和会议计划授权的跨进程装载还没有完成：arXiv 只有重新读取并核验来源的协议和测试数据，会议只能在持有有效计划引用对象的同一进程内核验。因此，当时还不能生成全历史正式最终凭证，也不能据此授权全量分析。这是当时的实现限制，不是对今天入口的描述。

旧标签 URL 只是清单中的 `unverified` 候选。正式重标前仍须由 Hugo 保存实际分类路由，不能根据标签字符串猜测 slug 并声称已保留旧 URL。

<a id="22-arxiv-fresh-source"></a>
### 2.2 arXiv 来源获取与隔离运行

可以复用 `fresh-rewrite-run-v1` 的隔离运行、不可变输入、来源期望、阶段状态、同一运行恢复及用量和断点记录；也可以复用 `fresh-analysis-context` 的 source-only 白名单、正文、结构和来源快照 `sourceSnapshot` 的 SHA、缓存提交标记和旧生成字段禁入检查。已有 arXiv HTML/PDF 获取、项目 CONNECT 代理、结构提取、图片与资源 URL 安全检查，以及普通操作补丁、对已核 Reader 的补丁（`signed-patch`）、独立事实复验和正式记录写入时的 CAS 的恢复方式都有复用价值。

单日日更的外层流程不能直接用于执行这份历史方案：

- `rewrite:source prepare` 只读 `data/current` 的同日原始候选、入选集合和正式分析，要求 batchDate、论文集合和来源精确对应，采用现代 arXiv ID，并为每篇生成独立页面和当日一张汇总页。
- 它的基线要求旧正式记录已有来源证明、正式分析和 Reader，而多数历史记录不满足。
- 来源身份、目录和追踪记录使用 `\d{4}.\d{4,5}` 为键，不适用于会议论文 ID。
- 最终写入会修改 `deep-analysis-result.json` 和累计 `papers.json`，不能作为 109 个日更批次、三个会议和重复页面的独立历史论文库。

因此，方案选择复用安全检查和 arXiv 获取适配器，另建历史运行及最终写入流程。

### 2.3 analysis-engine 与 Reader

可复用 `analysis-engine.analyzeBatch()` 的并发、单篇锁内重读、同步 checkpoint、增量回调、重试分类和成功判定；正式分析的 13 个解析标题、八维评分、Reader v3、`api-reader-source-bindings-v4`，以及作者/机构、资源、表格、公式和图片检查也应沿用。Reader 的内容预算、失败草稿、局部诊断、零模型调用的操作补丁和独立事实报告不必重新设计。

当时仍需解决以下接口问题：

- 默认 `analyzePaperDeep` 会获取 arXiv 来源，会议只能接收 `conference-source-context-v2` 提供的已获授权的计划对象。
- 论文锁、结果合并和正式记录查找须使用 `paper-identity-v1.canonicalId`，不能以 `sourceIdentity`、标题或页面路径代替论文主键。
- 当时的会议 PDF 能力仅授权逐页正文与可重放的视觉审计，Reader 可在 OS 临时目录查看命中的页面。它不提供 HTML DOM、作者原始 TeX 或可独立发布的 Figure URL，不能据此编造对应结构；能力不足须记录“视觉可见、语义未绑定”。这不表示今天所有会议 PDF 都没有表格、公式或图像能力。
- 历史分析须写独立论文库和完成凭证，不混入日更 checkpoint。

<a id="24-taxonomy"></a>
### 2.4 分类

`paper-taxonomy-v1` 的词表、九个分面、稳定 concept ID、同分面父子关系、别名解析、祖先查询和中英文校验器可以复用。旧预览却不能当正式分类：当时 1,243 个旧标签只有 178 个字面映射，1,065 个未解析标签，语义审查数量为 0。旧标签只用于比较变化和保留旧路由，不成为新论文的分类证据。现行分类要求见 [分类实现说明](tag-system-implementation.md)。

<a id="25-generate--review--push"></a>
### 2.5 生成、审查与推送

发布方面可复用安全路径、Markdown/Hugo 检查、逐文件 SHA、审查缓存、Git 基线和差异、仓库锁、实时 `ls-remote`、推送后远端 main OID，以及可恢复的 intent/receipt。

当时的 schema v3 生成清单、审查和推送围绕一个 `YYYY-MM-DD`、现代 arXiv frontmatter、该日论文集合及汇总页组织；当时的新来源发布入口也只支持一种单日旧凭证关系。方案要求另建历史生成清单和发布事务，不能循环 109 次旧命令，在 main 上留下只发布了一部分的状态。

## 3. 总依赖图

下图保存当时 P0–P5 的设计关系。图中的 signed 表示内容 SHA 和核验记录的绑定，不是密码学签名。

```text
[signed historical-page ledger + receipt]
                    |
                    v
P0  source authority adapters --> verified page crosswalk --> identity groups (U)
       | arXiv                  |                    |
       | conference plans      |                    +--> page/cohort topology
       v                        v
P1  verified source bundles --> source completion receipt
                                      |
                                      v
P2  canonical analysis --> Reader v3/source bindings --> fact review completion
                                      |
                                      +--------------------+
                                                           v
P3  标签词表 --------------------------------------> 已审查的标签记录
                                                           |
页面、链接和标签页路由清单 --------------------------+
                                                           v
P4  4,490 deterministic staged projections + authorized additions
                                                           |
                                                           v
P5  immutable generation --> review --> one history publication transaction
                                                           |
                                                           v
                                  live remote main OID + final history status
```

按该设计，P0 在任何来源获取和模型费用之前完成。P1 核验一篇论文的来源后可进入 P2；P0 finalize、P3 全量分类审查及 P4 汇总完成则分别等待整个集合满足要求，P5 串行执行。这些全局等待条件不是当前直接重写队列的前提。

<a id="4-p0来源身份闭合与-verified-crosswalk"></a>
## 4. P0：核验来源身份和页面对应关系

<a id="41-新合同"></a>
### 4.1 当时已有基础与拟议扩展

以下是当时已有的基础及拟补的能力：

1. `paper-source-authority-v1` 的协议和加载器已有，生产适配器待实现。它绑定 `paper-identity-v1` 的完整身份记录 SHA 和 identity SHA；接入官方 metadata 适配器之前，citation 必须为 null，不能携带旧标题、作者或 venue。证据类型只有 `arxiv-official-fulltext` 和 `conference-plan-source-context`：arXiv 文件的自哈希不能授予生产授权，会议必须持有当前进程核验过的计划引用对象，重新逐项核验完整导入记录、来源清单和上下文，才能生成带授权的来源引用对象。授权记录绑定命名来源文件及 SHA、来源快照和全文 SHA、会议观察记录和计划绑定 SHA；理由、决定者、模型和实际用量留在后续决定记录。候选线索只供查找，不进入已验证输出，标题单独匹配不够。
2. `page-source-crosswalk-v1` 的 verified 扩展已有，批量解析待实现。页面对应记录精确覆盖 4,185 个 pageId；`pending/needs-review/blocked/conflict/verified` 转换只追加、按 CAS 写入。verified 必须引用核验程序实际生成的来源授权对象，不能接受调用方手填 SHA。
3. `identityGroups` 分组基础已有，全量数据尚待核验。每个论文身份对应一个或多个 pageId，只存 `paperId`、身份和完整记录的 SHA、排序后的 `pageKeys` 及 group SHA。范围、批次和页面 URL 保留在 crosswalk 的 `source.papers` 中，重复页不能因分组丢失。`analysisKey` 尚未进入该协议，须由后续分析计划定义并绑定最终来源。
4. `page-source-crosswalk-final-receipt-v1` 基础已有，全量生产凭证尚未生成。它绑定 inventory ledger/receipt、完整决定集合、4,185 个 assignment 和 U 个 identity group；只有 `pending=blocked=conflict=0` 才 complete，并核对 self-SHA、文件 SHA、页面集合 SHA 及身份分组集合 SHA。

<a id="42-adapter-与难例"></a>
### 4.2 来源适配器与难例

- 对日更单一线索重新核验 arXiv metadata/abs URL，不直接相信文件名或旧 frontmatter；版本差异保留在来源版本中，论文身份仍用无版本号 arXiv ID。
- 对 daily 116 个 none，依次检查旧归档原始 raw metadata、可核来源凭证和页面外链官方 ID；没有权威身份时保持 blocked，不能按标题相似度补齐。
- 对 daily 72 个 conflict 和 3 个 multiple，保存全部候选及冲突证据，只在官方 ID 与来源记录吻合后选择。
- 对 conference 1,161 个 none，从会议目录、官方元数据索引和已下载 PDF 精确匹配入手，经过 filter、extraction、staging、import 和 plan；文件名或标题模糊匹配只能产生候选。
- 对 conference 8 个 conflict 和 3 个 multiple，只有官方交叉链接、DOI/论文记录或人工确认的双源 receipt 才能将会议外部 ID 与 arXiv ID 合为同一组。
- ICLR 分组可跨页面，但每页的 2026-05-02/05-04 cohort 原样保留。

### 4.3 CLI

当时已有以下清单及受控维护入口。这里保留命令原形供解释设计，不提供本次执行授权。

```bash
npm run history:inventory -- --apply --ledger all-history.json --receipt all-history.receipt.json
npm run history:crosswalk -- prepare --apply \
  --ledger all-history.json --receipt all-history.receipt.json --crosswalk UUID
```

```bash
npm run history:crosswalk -- status --crosswalk UUID
npm run history:crosswalk -- apply --crosswalk UUID --decision NAME.json --owner REVIEWER
npm run history:crosswalk -- apply-verified --crosswalk UUID \
  --decision NAME.json --authority AUTHORITY.json --owner REVIEWER
npm run history:crosswalk -- finalize --crosswalk UUID
```

设计还拟新增批量 resolve 和来源授权采集器，只写受控 decision/authority 目录。会议计划须重新核验完整文件链后生成引用对象，不接受用保存的普通对象冒充授权引用；该方案要求 finalize 后才进入 P1，不能据此阻挡当前直接重写。

### 4.4 P0 验收

要求 4,185/4,185 页面各有一次 assignment，pageId、路径、内容 SHA 与清单相同；U 个分组没有重复论文身份，pageId 并集恰好等于论文页集合。116 个 daily none、72 个 daily conflict、1,161 个 conference none 等队列须归零，否则整批明确 blocked。

输出不得含旧正文、用户绝对路径、API key 或远端 URL 凭据。重新加载来源引用对象后，仍须独立读取并核验原始文件字节；inventory/crosswalk 对应的 Git/Hugo 快照与原记录不同时立即停止。

<a id="5-p1全量-source-recovery"></a>
## 5. P1：恢复并核验全部来源

<a id="51-新合同"></a>
### 5.1 当时拟议的协议

1. `historical-source-run-v1` 拟绑定 crosswalk final receipt、U 个 analysis key、adapter 版本、并发和 source policy，每个身份保存独立状态与尝试记录。
2. `historical-source-bundle-v1` 拟保存论文身份、元数据、全文、结构数据、原始来源位置，以及 source/artifact/PDF/DOM SHA、能力矩阵和不可变来源描述文件。
3. `historical-source-completion-v1` 拟证明精确的 U/U 来源集合和 self-SHA。任何缺失、短正文、论文或来源身份与记录不符、摘要降级或缓存损坏都不能 complete。

能力须分别报告 `fullText`、`tables`、`formulas`、`figures`、`authorDom` 和 `resourceLinks`，每项为 `replayable/weak/unavailable` 并说明原因，不能从 `analysisReady=true` 推断所有结构都可用。

### 5.2 实现边界

arXiv 适配器拟复用 `fetchArxivTextDetailed`、代理、HTML/PDF 和结构提取，但输入改为核验过的 `paper-identity-v1` 与来源授权凭证，不读日更当前数据。会议适配器只接受 `conference-source-context-v2` 的已核验并登记的计划对象；当时 weak PDF 可用于长文分析，表格、公式和图像仍为 unavailable，须由后续独立提取凭证证明相应能力才能开放。

每篇论文只缓存一份来源，多个历史页引用同一来源文件组的 SHA。旧来源归档只供查找，须按来源格式要求重新读取，并逐字节核验；当时 82 个来源归档没有完整的现代五段来源文件，不能凭文件存在跳过恢复。默认禁止 abstract-only 发布：没有全文时保持 blocked，显式降级须另获用户同意，并且不纳入“全部深度重写”的 complete。

### 5.3 CLI

以下是未实施的命令提案，不是现行 npm 入口。

```bash
planned history:sources prepare --crosswalk UUID --run-id UUID
planned history:sources fetch --run-id UUID --adapter arxiv --concurrency N
planned history:sources import-conference --run-id UUID --plan PLAN_HANDLE --concurrency N
planned history:sources status --run-id UUID
planned history:sources finalize --run-id UUID
```

### 5.4 P1 验收

来源身份集合须恰好等于 P0 的 U，每份缓存能在断网状态下，根据来源描述文件重新读取并核验保存的来源；缺失或改变一个字节即失败。元数据须对应论文身份，会议 `paperId` 不能与 `sourceIdentity` 混用。

测试拟覆盖非空白全文、UTF-8、PDF、JSON 重复键、符号链接、父路径和最大字节限制，使用真实来源授权测试数据并断言具体原因码，不能只依靠外层 SHA 失败冒充语义覆盖。此来源获取阶段消耗零 LLM Token，但网络请求及失败原因仍须记录。

## 6. P2：唯一论文分析、Reader、评分与事实验收

<a id="61-新合同"></a>
### 6.1 当时拟议的协议

1. `historical-analysis-run-v1` 拟保存 `runId`、crosswalk 和来源完成凭证的 SHA、U 个分析键。模型、协议、提示词、解析器、引擎和预算均进入指纹，并保存精确分片计划，不含旧分析、Reader 或博客正文。
2. `historical-analysis-record-v1` 拟复用正式分析的 13 个解析标题、阶段链、八维评分和恢复断点；来源记录绑定论文身份、bundle SHA、`source-only=true` 和 `oldGeneratedTextIncluded=false`。
3. `historical-reader-record-v1` 拟保存 Reader v3 article/plan、source-bindings v4、作者/机构、资源、表格/公式/图片能力，以及 article/plan/source/figure/author/resource SHA 和服务商实际返回的用量。
4. `historical-fact-review-v1` 拟绑定完整 paper/article/plan/source SHA。解析、事实和图像分别验收；没有图像能力时写 not-applicable/unavailable，不伪造通过结果。
5. `historical-analysis-completion-v1` 拟要求 U/U 分析、Reader 和事实复验成功；任何 pending/failed 都阻断 P4 最终完成。

<a id="62-analysis-engine-适配"></a>
### 6.2 分析引擎适配

方案拟复用 `analyzeBatch` 的工作任务、重试、断点回调、锁内重读和结果合并，新增 `withHistoricalAnalysisContext(identityHandle, sourceHandle, callback)`。这是拟议接口名称，不表示现在源码使用它。深度分析器只从注入上下文取得来源，不自行按 arXiv ID 联网补取。

单篇锁拟使用 `paper-identity-v1.identitySha256` 或安全编码的论文 ID，存入历史运行受控根，不与 `data/current/.analysis-runs` 隐式共享。arXiv 与会议可使用不同来源适配器，但正式分析和 Reader 采用相同成功条件。

`preparePaperLocked` 须在锁内重读论文身份、来源和分析状态，先持久化 checkpoint 再返回回调。只有完成且全部指纹相同才跳过；提示词、来源、解析器、Reader 协议或分类输入改变时只让必要下游失效，既有用量记录不清零。

<a id="63-reader-与质量门禁"></a>
### 6.3 Reader 与质量检查

Reader 只接受原始来源、结构和必要元数据，不重复注入旧分析评论或博客。结构证据不足时减少相应表格、公式和图片，不能放松表格单元格、TeX 或像素的来源绑定。

先用生产解析器重新解析并检查已保存结果，不请求模型，再将可局部修复的问题交给局部修复，事实问题交给独立审查。同一论文身份只做一次事实复验，所有页面引用同一已核记录。操作补丁保留 parent/source CAS、归档和 `newApiRequests=0` 证明，不能新建 runId 重置预算。

### 6.4 CLI

以下命令是当时的提案。

```bash
planned history:analyze prepare --source-run UUID --run-id UUID
planned history:analyze run --run-id UUID --shard SHARD --concurrency N
planned history:analyze status --run-id UUID
planned history:analyze patch --run-id UUID --patch NAME.json
planned history:analyze signed-patch --run-id UUID --patch NAME.json
planned history:analyze fact-accept --run-id UUID --report NAME.json
planned history:analyze finalize --run-id UUID
```

### 6.5 P2 验收

U/U 正式分析和 Reader 须通过 `isSuccessfulAnalysisRecord`、`hasValidApiReaderV3Records` 及重新读取来源后的完整核验。13 个标题、篇幅、术语组合解释、主结果覆盖、评分、作者/机构、资源可达性和结构证据分别检查。

每篇事实报告绑定最终文章 SHA，操作补丁改变内容后，旧报告即失效。服务商用量按论文、阶段和尝试汇总，未知回执单列，不能说成零。重复页面不得触发第二次正式分析或 Reader 主生成。

<a id="7-p3production-taxonomy-与旧-taxonomy-url"></a>
## 7. P3：正式分类和旧标签 URL

<a id="71-新合同"></a>
### 7.1 当时拟议的协议

1. `paper-taxonomy-assignment-v1` 拟为每个论文身份保存一份分类，绑定词表、分析、Reader 和来源 SHA。记录主任务 `primaryTask`、0–2 个补充任务和科学主题 `primaryScientificTopic`，其他字段为 `methods`、`settings`、`signals`、`applications`、`researchFocus`、`artifacts`、`modelFamily`、`documentType`。每个概念还保存来源证据、决定者、用量和已审状态。
2. `historical-taxonomy-assignment-set-v1` 拟精确覆盖 U，拒绝父子重复、数量不符、未知概念和未经支持的废弃概念迁移。
3. `historical-taxonomy-route-ledger-v1` 拟在改标签前由固定 Hugo 构建枚举实际旧 URL、标签名称与页面集合；inventory 候选 URL 只供交叉提示。
4. `historical-taxonomy-route-plan-v1` 拟明确旧 URL 对应保留的标签页、新概念页或静态重定向，不能静默删除长尾标签 URL。

### 7.2 分类原则

分类从新分析和来源证据产生，不复制旧标签。任务采用最具体叶节点，父节点通过检索继承，不重复存储。方案曾提议让非任务论文使用科学主题并允许主任务为空；当前严格解析器尚不支持这个例外，不能用历史提案绕过现行主任务和主方法要求。

方法、应用和运行设置不互相代替。可先确定性整理证据，再只对含糊分类调用模型，语义审查与字面映射分别统计。每个身份只分类一次，再生成全部对应页面；方案要求同一论文的不同批次使用相同分类，除非来源版本确实不同并已拆成不同身份。这一拆分规则也属于原设计，不能据此自行变更现行身份协议。

### 7.3 CLI

以下仍为拟议命令，不对应现行分类入口的参数。

```bash
planned history:tags snapshot-routes --inventory all-history.json --output ROUTE_LEDGER
planned history:tags prepare --analysis-run UUID --registry config/tag-catalog.json --run-id UUID
planned history:tags classify --run-id UUID --shard SHARD --concurrency N
planned history:tags review --run-id UUID --decision NAME.json --owner REVIEWER
planned history:tags status --run-id UUID
planned history:tags finalize --run-id UUID
```

### 7.4 P3 验收

U/U 分类记录须为已审状态，不能将 partial/legacy_mapped 当作语义通过。concept ID 须属于同一 registry SHA，父子冗余为 0，并核验数量和当时拟议的非任务例外。

1,243 个旧标签名称各有经过核验的路由处置，1,065 个未解析标签不得静默消失。固定分层评测集复核覆盖广度、同义合并和子任务边界。页面只突出主任务与 2–3 个区分度高的概念，避免将多个分面重新堆成平面标签。

<a id="8-p44490-页面确定性投影"></a>
## 8. P4：按既有身份生成 4,490 个页面

<a id="81-新合同"></a>
### 8.1 当时拟议的协议

1. `historical-projection-plan-v1` 拟绑定页面清单、来源对应表、分析及分类的完成凭证 SHA，并精确列出 4,490 个基线 `pageId`。每页记录路径 `path`、正式 URL、发布日期 `publishedDate`、所属批次日期 `cohortDate`、旧任务标识 `legacyTaskKey` 和旧字节 SHA；另存汇总成员、顺序、链接目标集合及重复次数，明确记录拓扑变更。`authorizedAdditions` 单列新增页面或重定向，默认空。
2. `historical-page-projection-v1` 拟保存新 Markdown、附属记录和来源图文件 SHA，并绑定论文身份、Reader、分类或汇总输入 SHA；`oldGeneratedTextIncluded=false`，标题和引用只能来自新来源或 Reader。
3. `historical-projection-completion-v1` 拟要求基线 4,490/4,490 全部完成，新增项另计，不能用新增页面补齐缺失旧页。

### 8.2 页面规则

- 4,185 个单篇页可共享同一论文的事实内容，但分别保留 pageId、路径、URL、日期、cohort 和页面 SHA；正文重新渲染，不复制另一旧页。
- 109 个日更汇总只读取对应日期的完整成员集合的最终 Reader、评分和分类，排行榜和标题指向原单篇 URL，不让模型重写整批总结。
- 3 个会议汇总按唯一会议身份统计，分别报告目录总数、verified、source-ready、analysis complete、blocked/excluded，不能伪装成某日日更。
- 193 个任务页保留 ICASSP/ICLR 的 task key 和成员分区。新分类改变归属时，计划须给旧任务 URL 兼容内容或 redirect，不能直接删页。
- ICLR 两个批次分别生成页面，再进入同一会议导航；日期、排序和来源版本不能串批。
- 内部链接的旧目标页面集合须继续可达。模板改变同一目标的引用次数时，在 topologyDelta 中逐页说明并授权；未授权则保持 inventory 的 link target multiset。
- 原方案要求所有 4,490 页的新 body SHA 不同于旧 SHA。来源标题、标准术语和逐字证据自然重合不表示使用旧正文；依据应是输入白名单和来源记录，不能简单比较字符相似率。

<a id="83-icml-task-additions"></a>
### 8.3 新增 ICML 任务页

当时 ICML 有 137 个论文页和一张会议汇总，没有历史任务页。新增任务页不属于重写旧页，须另有用户或版本化授权策略的同意。每项 path、URL、pageId、task concept、成员和 redirect 写入 authorizedAdditions，数量与基线 4,490 分开报告。dry-run Hugo 须证明没有 URL、alias 或标签冲突；不能删除或改名 `icml2026-summary.md`，汇总新增链接须记入 topology delta。

### 8.4 CLI

以下是当时的页面生成提案。

```bash
planned history:project prepare --analysis-run UUID --tag-run UUID --projection UUID
planned history:project render --projection UUID --scope daily:YYYY-MM-DD --concurrency N
planned history:project render --projection UUID --scope conference:icassp-2026 --concurrency N
planned history:project status --projection UUID
planned history:project finalize --projection UUID
```

输出拟写入 `data/runtime/history-rewrites/<UUID>/staging-blog/` 或隔离 Git worktree，P4 不修改真实博客。可抽取 `publish-to-blog.py` 的通用 Markdown/Hugo 渲染器，但不能调用逐日写入入口。

### 8.5 P4 验收

基线须精确包含 4,185 个论文页、109 个日汇总、3 个会议汇总、193 个任务页，合计 4,490 页，无缺失或重复。新增项独立计数，未授权时为 0。每个旧正式 URL、alias 和已核验标签路由仍可达，并对应正确的新页。

Hugo 的 list all/published、全站构建、Markdown/HTML/MathJax/链接检查须通过，内部链接只指向计划 pageId 或受控 redirect，没有失效或指向不明的链接。汇总的排名、成员数、分数、标签和链接能从正式记录重算。页面最终字节冻结后才进入审查，审查任务不原地修改内容。

<a id="9-p5历史-review-与-publication-transaction"></a>
## 9. P5：历史审查和发布事务

<a id="91-新合同"></a>
### 9.1 当时拟议的协议

1. `historical-publication-baseline-v1` 拟绑定干净的博客 main、HEAD、实时远端 main OID 和远端身份、Hugo 版本，以及 4,490 个路径的旧字节；还保留旧生成、审查和推送凭证及资源清单。
2. `historical-generation-manifest-v1` 拟绑定页面生成完成凭证，列明新增、删除及不变文件，保存逐文件 SHA、模板和渲染器 SHA、基线及已授权新增项。
3. `historical-review-receipt-v1` 拟保存逐文件字节/Hugo 检查、按唯一论文复用的事实报告、汇总成员/排序和标签路由检查。
4. `historical-publication-intent-v1` 拟绑定精确 Git 差异、目标 tree OID、parent OID 和预期远端 OID，并保存提交说明与回滚 commit 计划。
5. `historical-publication-receipt-v1` 拟记录实际 commit/tree、推送输出、实时远端 main OID 和全部清单 SHA。
6. `historical-rewrite-status-v1` 拟汇报 P0–P5 凭证链、4,490 个基线页、新增项和 U，并分别报告来源、分析、分类、页面、审查、发布的计数与错误。

### 9.2 发布策略

原方案默认一次完整发布：隔离 worktree 完成所有写入和审查后，受控安装 Git tree 并推送，不能将 109 个日期依次推到 main。若仓库大小迫使分批发布，须另获用户对分批策略的授权；每批有独立 URL 检查和回滚凭证，不能将部分推送说成全量完成。

旧发布凭证不删除或覆盖，新的历史激活流程逐项归档并绑定原 SHA；循环单日 `blog:activate-fresh` 不能冒充全历史激活。锁顺序固定为博客仓库、历史事务、排序后的论文身份、状态文件。

推送前重取远端 main，偏离基线即停止；推送后远端 OID 须等于本地 publication commit。当时还要求 Pages/Hugo 线上抽样及旧 URL 清单检查通过，才标为 complete。现行上线要求见本文开头的发布导航，Git OID 不等于 HTTP 部署证明。

### 9.3 CLI

以下是原发布提案，不是已存在的 npm 命令。

```bash
planned history:review prepare --projection UUID --publication UUID
planned history:review run --publication UUID --shard SHARD --concurrency N
planned history:review status --publication UUID
planned history:publish dry-run --publication UUID
planned history:publish apply --publication UUID
planned history:status --publication UUID
```

设计拟将 `history:publish apply` 设为唯一可写真实博客并推送的入口，禁止隐式触发来源获取、LLM、分类或内容修复。review 后页面 SHA 改变时退回生成阶段，冻结新字节后只重审变化页；模型、Prompt、代码、Hugo、协议或 manifest 元数据改变时重跑批次检查并生成新 receipt，不重审内容 SHA 未变的文件。

### 9.4 P5 验收

generation manifest 路径集合须等于 Git delta，不能夹带人工改动；review receipt 覆盖全部 4,490 基线页及 authorized additions 的最终 SHA。独立论文事实审查按 U 全覆盖，页面渲染审查按 4,490 全覆盖。

Hugo 页数、published 集合、旧 URL/redirect、标签路由和 14,743 条基线链接均有明确处置；本地 HEAD、tree、远端 main 与凭证 OID 相同。故障注入拟覆盖 write/link/rename/fsync/commit/push/remote verify，恢复不能误删不同 inode 或字节。拟议 status 只有 P0–P5 全部 complete 且 errors=0 才成功，不表示现行入口返回这些字段。

## 10. Token 与返工控制

<a id="101-只按-unique-identity-付费"></a>
### 10.1 每篇唯一论文只付费处理一次

页面逐篇处理会为 4,185 页分别分析并生成 Reader。方案在身份核验后只处理 U 篇唯一论文，按下式比较费用：

```text
避免的主分析次数 = 4,185 - U
页面/identity 放大率 = 4,185 / U
实际节省 Token = 按阶段汇总的 page-naive 对照 usage - identity-run 实际 usage
```

旧预览的 4,069 只是候选记录。如果全部身份成立，至少能避免 116 次重复主分析；但方案要求在 crosswalk finalize 前按最坏 4,185 篇预算，不提前宣称已节省费用。

<a id="102-分阶段-cache-key"></a>
### 10.2 分阶段缓存键

当时提出按下列输入决定各阶段能否复用；逐页审查依据最终内容 SHA，批次协议变化另行处理。

| 阶段 | 缓存键至少包含 | 输入变化后需重做 |
|---|---|---|
| 来源 | 身份 SHA、来源授权凭证、适配器和提取器版本 | 只重做该论文的下游阶段 |
| 正式分析 | 来源快照、分析提示词/模型/协议/预算、引擎和解析器 | 正式分析及其下游 |
| Reader | 正式分析、来源绑定、Reader 提示词/模型/预算及来源能力 | Reader 及其下游 |
| 评分 | 正式分析/Reader、评分规则和审计提示词/模型 | 评分和汇总排名 |
| 标签分类 | 正式分析、Reader、原文来源、标签词表和标签选择规则 | 分类和页面生成 |
| 页面 | Reader、评分和标签记录，以及页面身份、批次、渲染器与模板 | 相应页面和依赖它的汇总页 |
| 审查 | 相对路径、最终文件内容 SHA | 只重审内容 SHA 变化的文件；protocol/model/code/Hugo/manifest 变化时仅重做批次检查并生成新 receipt |

按当时的账号机制，同一逻辑请求更换 API key 不建立新缓存身份，只有明确 usage-limit 才换账号。网络错误、5xx、截断和正文检查失败保留原账号及尝试记录；服务商 token 用量以实际回执为准，缺失回执单列。这里不改写成今天所有账号错误的完整分类。

### 10.3 减少返工的执行规则

当时拟将 P0/P1 都设为无 LLM 阶段，来源未核验不启动分析；先运行 parser/preflight，不能用更多重试修补 schema 或来源错误。正式分析、Reader、事实复验可按论文流水处理，但后阶段只读取已冻结的前阶段 SHA。汇总、任务页和 redirect 确定性生成，多数页面检查也不让模型重复总结论文。

失败从原阶段恢复，局部问题用受 SHA 约束的补丁，不新建运行重置预算。每个分片设请求数、输入输出 Token 和运行时间上限，超过即暂停并保存 checkpoint，不降级来源。原方案还要求试点达到首轮事实通过率和 Token 门槛后，才启动全量 4,185 页分析。

## 11. 试点矩阵

原方案要求试点 manifest 从最终 inventory/crosswalk SHA 确定性选样并保存 pageId/identity，不临时挑选容易通过的论文。样本和门槛如下，均不作为当前直接重写的新增前提。

| 试点 | 最小样本 | 必含场景 | 扩大运行的条件 |
|---|---:|---|---|
| Identity A | 40 页面 | 日更的单一、缺失、冲突和多条线索；三个会议；跨日期重复；ICLR 两批次 | 40/40 已核验，人工复核没有错配 |
| Source B | 12 篇唯一论文 | arXiv HTML、备用 PDF、长文、表/公式/图；ICASSP/ICLR/ICML 当时的 weak PDF；短文或损坏 PDF 须阻断 | 保存的来源字节和每项能力均可再次核验 |
| Analysis C | 12 篇唯一论文 | 方法、数据集、理论、系统报告；资源有/无；机构有/无；结构能力不同 | 解析器通过率为 100%，首轮事实通过率达到预设阈值 |
| 标签分类 D | 30 篇唯一论文 | ASR/AV-ASR、PEFT/LoRA、增强子任务、非任务科学主题、跨模态、数据集与基准 | 双人或独立审查一致率达到门槛 |
| Projection E | 1 日更 + 3 会议切片 | 重复页、ICASSP 任务页、ICLR 双批次、ICML 无任务页；嵌套方括号链接 | 页面、链接和 Hugo 检查全通过，addition=0 |
| Publication F | 全 4,490 页影子构建 | 完整路径集、旧标签路由、远端提交或身份变化、故障恢复 | 预览凭证完整，真实博客没有写入 |

当时建议按 12 → 50 → 200 → 500 → 全量唯一论文逐级扩大，比较首次解析通过率、首次事实通过率、平均及分位 Token、修复次数、不可恢复来源比例和审查分歧。未达到 pilot manifest 预定阈值时，修正协议、Prompt 或代码后重跑同一试点。

## 12. 并行与串行边界

原方案允许独立来源和页面分片并行，将集合完成检查及发布放在统一状态写入和固定锁序内。

| 工作 | 可否并行 | 约束 |
|---|---|---|
| arXiv 和三个会议的身份适配器开发 | 可以 | 先冻结 P0 格式，各自只写独立测试数据和适配器 |
| 页面来源对应关系解析 | 可以 | 每个 pageId 保存独立决定，finalize 单线程按 CAS 写入 |
| 来源获取与提取 | 可以 | 按论文身份分片，同一身份只获取一次，遵守代理和 I/O 限额 |
| 正式论文分析 | 可以 | 使用配置并发，同一论文锁内重读，不合并不同 source SHA 的结果 |
| Reader 与分类 | 部分 | Reader 等正式分析完成；分类程序可并行开发，正式分类须等最终证据 |
| 单篇页面渲染 | 可以 | 按 pageId 分片写暂存区，不写真实博客 |
| 日更、会议和任务页汇总 | 批次内等待全部成员 | 须等该批次或会议全部成员的评分和分类完成 |
| 逐文件审查 | 可以 | 最终字节冻结后分片，同一文件只有一个有效审查结论 |
| 清单最终核验、Git 安装、提交、推送和远端核验 | 必须串行 | 使用同一历史发布事务及固定锁序 |

工作任务只返回不可变结果或凭证，由一个状态写入者按 CAS 合并全局状态；不能直接修改正式分析、博客或 complete 计数。

## 13. 总体验收清单

下列是原方案的分阶段验收，不是当前 status 的真实字段清单。

按原方案，启动真实全量前，P0 须完成 4,185 个页面对应和 U 个身份分组，unresolved/conflict 为零；P1 有 U/U 来源及能力、SHA 核验。固定试点达到事实质量、Token 和恢复门槛，分类记录格式、旧路由清单和页面格式均冻结。

进入历史审查前，P2 有 U/U 分析、Reader 和事实复验，P3 有 U/U 已审语义分类，P4 有 4,490/4,490 暂存页面，正文来自新证据。109 个日更、3 个会议汇总和 193 个任务页齐全，ICLR 双批次不串，ICML 新增项单列；Hugo、URL、链接、标签路由、页数及 published 集合通过。

推送前，review receipt 精确覆盖 generation manifest，博客仍为基线的干净 main，实时远端 OID 未变。Git delta 只含允许路径，旧 receipt 安全归档未覆盖，故障恢复预演和远端失败演练通过。

最终，发布提交已推送，远端 OID 与该提交相同，旧 URL 全部可达，新增项单列。拟议 `history:status` 报 P0–P5 complete、errors=0，并列 4,490、4,185、U、additions、实际模型请求和 Token。解析通过、候选身份、字面标签映射、部分推送或没有回执的调用都不能被报告为全量完成。

## 14. 推荐实施顺序

当时建议先冻结并测试 P0 authority/crosswalk v2，完成 40 页身份试点；再抽取通用来源适配器和上下文，完成 12 篇的 P1/P2 端到端试点。Reader、事实复验与正式分类接通后，完成 30 篇分类试点。

接着实现只写暂存区的页面生成，按日更、ICASSP、ICLR 双 cohort、ICML 的顺序处理，不新建 ICML task 页；用全部 4,490 页的隔离构建核对 URL、链接、标签路由和 Git delta。历史 generation/review/publication receipts 与故障注入完成后，再冻结干净 main 和实时远端基线，启动 U 篇来源与模型处理。全部审查完成后进行一次历史发布事务，重新读取状态并检查线上旧 URL。

这个顺序是旧方案的建议，现行任务只按开头链接的工作流执行。
