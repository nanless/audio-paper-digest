# 全历史博客重写：实施路线图

状态：实施级规划，尚未授权任何模型调用、历史页面改写或发布。本文件中的 `history:*`
新命令和 `*-v1` 新合同均是**待实现接口**；已经存在的命令会明确标为“现有”。执行时仍须
遵守仓库根 `AGENTS.md`：所有脚本与测试在沙箱外运行，历史正文不得进入新的分析或 Reader
上下文，任何来源、页面集合、Git、Hugo 或远端证明不闭合都失败关闭。

## 1. 目标、范围与当前基线

目标不是把旧 Markdown 批量润色，而是从重新核验的论文来源生成全新 canonical analysis、
Reader、评分和 taxonomy，再确定性投影回所有历史页面。旧页面只提供页面身份、公开 URL、
聚合关系及恢复基线；旧正文不能提供写作素材、事实或分类真值。

当前历史 inventory 基线包含：

| 页面类型 | 数量 | 必须保持的身份 |
|---|---:|---|
| 单篇论文页 | 4,185 | `pageId`、路径、primary URL、发布日期、cohort、published/draft |
| 日更汇总 | 109 | 日期、路径、URL、论文成员与内部链接拓扑 |
| 会议汇总 | 3 | ICASSP 2026、ICLR 2026、ICML 2026 的独立 scope |
| 会议 task 页 | 193 | ICASSP 140、ICLR 53、ICML 0；保留 task key 与成员关系 |
| 合计 | 4,490 | 精确 tracked page set 与 Hugo published page set |

inventory 已观察到 14,743 次内部文章链接，当前均可唯一解析且无 URL collision。发布验收
必须以最终签发的 inventory ledger/receipt 为准，不把这里的文字数字当权威输入。
`content/about.md`、`archives.md`、`conferences.md`、`links.md`、`papers.md`、`search.md` 等站点
根页面不属于这 4,490 个历史 post；本轮默认保持其 Git 字节不变，但最终 Hugo 回归必须确认它们
仍能正确索引新页面。若要重写这些入口，必须另列 authorized additions/changes，不能顺手带入。

4,185 个论文页面的身份线索只是候选，不是 verified identity：

| scope | single | none | conflict | multiple | 合计 |
|---|---:|---:|---:|---:|---:|
| daily | 2,692 | 116 | 72 | 3 | 2,883 |
| conference | 130 | 1,161 | 8 | 3 | 1,302 |

旧 taxonomy preview 另观察到 2,767 个带 arXiv 候选的页面、2,651 个候选唯一 arXiv ID、
110 组候选重复 ID 和 1,418 个未定 ID 页面；它得到的 4,069 条展示记录不是 4,069 篇已
验证的唯一论文。实际唯一论文数记作 `U`，只能由最终 crosswalk 计算。

ICLR 页面属于同一 `iclr-2026` scope，但必须保留两个 cohort：2026-05-02 有 134 篇，
2026-05-04 有 133 篇。身份去重不能合并 cohort，页面投影也不能把两批日期改成一个日期。

## 2. 现有能力的可复用边界

### 2.1 历史 inventory 与 crosswalk

- 现有 `npm run history:inventory` 可冻结 `content/posts` 的 Git/Hugo/page/link 快照，并以
  O_EXCL、0600、双文件 receipt 和写前/写后 repository CAS 落盘。
- 现有 `npm run history:crosswalk` 可从 opaque inventory handle 创建 4,185 个 page assignment，
  提供状态 SHA、append-only decision、崩溃恢复和安全 stale-lock reclaim。
- `paper-source-authority-v1` 与 crosswalk verified/finalize 基础已实现：verified decision 绑定
  pageId/content SHA、完整 canonical identity 记录及双 SHA、authority 文件/self SHA、来源证据类型；
  同 identity 多页确定性分组，全部 verified 后才写不可变 final receipt，并要求每次读取 receipt 时
  用当前 production-authorized opaque handle 重新验证来源。标题证据永远不足。
- 真实 arXiv authority 采集 runner 与会议 plan authority 的耐久跨进程装载仍未实现；当前 arXiv
  仅有可重放合同/fixture，会议只能在持有 live plan handle 的同一进程中验证。因此还不能生成
  全历史 production final receipt，也不能成为全量分析授权。
- inventory 中的旧标签 route 只是 `unverified` candidate；正式重标前仍需 Hugo 权威 taxonomy
  route 快照，不能把字符串 slug 猜测当成旧 URL 证明。

### 2.2 arXiv fresh source

可复用：

- `fresh-rewrite-run-v1` 的隔离 run、immutable inputs、来源期望、阶段状态、同 run 恢复和
  usage/checkpoint 思路；
- `fresh-analysis-context` 的 source-only allowlist、source/artifact/sourceSnapshot SHA、缓存
  commit marker、拒绝旧 analysis/Reader/checkpoint 字段；
- 当前 arXiv HTML/PDF 获取、项目 CONNECT 代理、结构工件提取、图片与资源 URL 安全门禁；
- operator patch、signed patch、fact review 及 promotion CAS 的故障恢复模式。

不可直接复用：

- `rewrite:source prepare` 只读取 `data/current` 的同日 raw/filtered/canonical，要求精确
  `batchDate` 闭包、现代 arXiv ID、该日每篇页加一张汇总页；
- fresh baseline 要求旧 canonical 已有 source proof、analysis 和 Reader。大部分历史记录不满足；
- fresh source 的身份、目录和 provenance 都以 `\d{4}.\d{4,5}` 为键；会议 canonical ID 不适用；
- fresh promotion 修改当前 `deep-analysis-result.json` 和累计 `papers.json`，不能承载 109 日更、
  三个会议及重复页面的全历史 canonical store。

结论：复用安全原语和 arXiv source adapter，不复用单日 run/promotion 外壳。

### 2.3 analysis-engine 与 Reader

可复用：

- `analysis-engine.analyzeBatch()` 的并发、单篇锁内重读、同步 checkpoint、增量结果回调、
  retry 分类与成功判定；
- 13 阶段 canonical、八维评分、Reader v3、`api-reader-source-bindings-v4`、作者/机构和资源
  身份、表格/公式/图片门禁；
- Reader 内容预算、失败候选、局部诊断、零模型 operator patch 与独立事实报告。

必须先改造：

- 默认 `analyzePaperDeep` 会走 arXiv 获取路径；会议只能消费
  `conference-source-context-v2` 的 opaque plan authority；
- paper lock、merge 和 canonical lookup 需要统一使用 `paper-identity-v1.canonicalId`，不能把
  `sourceIdentity`、标题或页面路径当论文主键；
- conference weak PDF profile 当前只授权可靠正文，不授权可验证表格、TeX 或图片。Reader 必须
  根据 capability 降级，不可为了统一版式伪造结构工件；
- 历史分析需要独立 store 和 completion receipt，不能写进 daily current checkpoint。

### 2.4 taxonomy

可复用 `paper-taxonomy-v1` registry、九个 facets、稳定 concept ID、同分面父子关系、别名解析、
祖先查询和跨语言 validator。不可把现有 preview 当 production assignment：当前 1,243 个旧标签
仅有 178 个字面映射，1,065 个 unresolved，semantic review 数为 0。历史正文标签只能用来做
差异审计和旧 route 保留，不能成为新论文语义分类的事实来源。

### 2.5 generate / review / push

可复用：安全路径、Markdown/Hugo gate、逐文件 SHA、review unit cache、Git baseline/delta、仓库锁、
实时 `ls-remote`、push 后 remote main OID 和恢复式 intent/receipt。

不可直接复用：现有 generation manifest schema v3、review 和 push 都以一个 `YYYY-MM-DD`、现代
arXiv frontmatter、该日 paper set 与汇总页为中心；fresh activation 也只支持一种单日旧凭证拓扑。
全历史必须使用新的 manifest/transaction，不能循环 109 次旧命令并在 main 上留下半发布状态。

## 3. 总依赖图

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
P3  taxonomy registry ------------------------------> reviewed assignments
                                                           |
inventory page/link/taxonomy routes -----------------------+
                                                           v
P4  4,490 deterministic staged projections + authorized additions
                                                           |
                                                           v
P5  immutable generation --> review --> one history publication transaction
                                                           |
                                                           v
                                  live remote main OID + final history status
```

P0 是所有真实来源与 Token 支出的前置条件。P1 完成某个 identity 后可流水进入 P2；但 P0 finalize、
P3 全量审核和 P4 聚合 completion 必须分别形成单一全局 barrier。P5 严格串行。

## 4. P0：来源身份闭合与 verified crosswalk

### 4.1 新合同

1. `paper-source-authority-v1`（基础合同/loader 已实现，production adapter 待实现）
   - `paper-identity-v1` canonical identity、完整 record SHA 与 identity SHA；在官方 metadata adapter
     接入前 citation 强制为 `null`，不得携带旧标题、作者或 venue 文案；
   - 当前 evidence kind 只有 `arxiv-official-fulltext` 与 `conference-plan-source-context`；前者的
     自哈希 bundle 永远不是 production authorization，后者只有持有当前进程 authenticated plan handle
     并完整重放 import/ledger/source-context 时才可签发 production-authorized opaque handle；
   - authority proof 绑定命名来源文件、文件 SHA、来源 snapshot/fulltext SHA，以及会议 observation/plan
     binding SHA；决定理由、actor/模型与 usage 属于后续 resolver/decision 记录，不是当前 authority 字段；
   - 候选线索只作为查找输入，不进入 verified 输出；标题单独匹配永远不足以验证。
2. `page-source-crosswalk-v1` verified 扩展（基础已实现；批量 resolver 待实现）
   - assignment 精确覆盖 4,185 个 `pageId`；
   - 允许 `pending/needs-review/blocked/conflict/verified`，所有转换 append-only、CAS 绑定；
   - verified assignment 必须引用 authenticated source-authority handle，不能接受调用方手填 SHA。
3. crosswalk `identityGroups`（基础已实现；全量数据待闭合）
   - 一个 canonical identity 对应一个或多个 pageId；
   - group 只保存 `paperId`、identity/record SHA、排序后的 `pageKeys` 与 group SHA；
   - scope/cohort/page URL 保留在 crosswalk `source.papers`，不因分组丢掉重复页面；`analysisKey`
     尚未进入该合同，必须由后续分析计划另行定义并绑定最终来源。
4. `page-source-crosswalk-final-receipt-v1`（基础已实现；production 全量 receipt 待生成）
   - 绑定 inventory ledger/receipt、完整 decision set、4,185 assignment、`U` 个 identity group；
   - `pending=blocked=conflict=0` 才 complete；
   - self-SHA、文件 SHA、page set SHA、identity group set SHA 全部闭合。

### 4.2 adapter 与难例

- daily single：重放 arXiv metadata/abs URL，不直接相信文件名或旧 frontmatter；版本差异记录为来源版本，
  canonical identity 仍是 unversioned arXiv ID。
- daily 116 个 none：依次使用旧归档中的原始 raw metadata、可核 source receipt、页面出链中的官方 ID；
  仍无权威身份则保持 blocked，不能按标题相似度补齐。
- daily 72 个 conflict、3 个 multiple：保存全部候选与冲突证据；只有官方 ID/来源记录闭合才选择。
- conference 1,161 个 none：以会议 discovery、官方 metadata index 和已下载 PDF 的 exact match 为入口，
  经过 filter → extraction → staging → import → plan；文件名/标题 fuzzy match 只能产生候选。
- conference 8 个 conflict、3 个 multiple：会议 external ID 与 arXiv ID 可以组成同一 identity group，
  但必须有官方交叉链接、DOI/论文记录或人工签发的双源 receipt。
- ICLR 双 cohort：identity group 可跨页面，但每个 page assignment 的 2026-05-02/05-04 cohort 原样保留。

### 4.3 CLI

现有入口：

```bash
npm run history:inventory -- --apply --ledger all-history.json --receipt all-history.receipt.json
npm run history:crosswalk -- prepare --apply \
  --ledger all-history.json --receipt all-history.receipt.json --crosswalk UUID
```

已实现的受控消费入口：

```bash
npm run history:crosswalk -- status --crosswalk UUID
npm run history:crosswalk -- apply --crosswalk UUID --decision NAME.json --owner REVIEWER
npm run history:crosswalk -- apply-verified --crosswalk UUID \
  --decision NAME.json --authority AUTHORITY.json --owner REVIEWER
npm run history:crosswalk -- finalize --crosswalk UUID
```

仍拟新增批量 `resolve`/authority 生产 runner。它只能写受控 decision/authority 目录；会议 plan
必须由完整受控文件链重放成 opaque handle，不接受序列化伪 handle。finalize 前禁止进入 P1
付费阶段。

### 4.4 P0 验收

- 4,185/4,185 页面恰好一次 assignment，pageId/path/content SHA 与 inventory 一致；
- `U` 个 group 无重复 canonical identity，所有 pageId 的并集精确等于论文页面集合；
- 116 daily none、72 daily conflict、1,161 conference none 等队列全部归零或整批明确 blocked；
- 输出不含旧正文、用户绝对路径、API key、任意 remote URL 凭据；
- 重新加载所有 opaque handles 后仍能从原字节独立重放；
- inventory/crosswalk 源 Git/Hugo snapshot 漂移立即阻断。

## 5. P1：全量 source recovery

### 5.1 新合同

1. `historical-source-run-v1`：绑定 crosswalk final receipt、`U` 个 analysis key、adapter 版本、并发与
   source policy；每个 identity 独立状态和 attempt ledger。
2. `historical-source-bundle-v1`：canonical identity、metadata、全文、structured artifacts、原始
   source locator、source/artifact/PDF/DOM SHA、能力矩阵和 immutable descriptor。
3. `historical-source-completion-v1`：精确 `U/U` source bundle 集合与 self-SHA；任一 missing、短正文、
   身份漂移、摘要降级或损坏缓存都不能 complete。

能力矩阵至少区分：`fullText`、`tables`、`formulas`、`figures`、`authorDom`、`resourceLinks`，每项是
`replayable/weak/unavailable` 并带原因。不能用一个 `analysisReady=true` 推导所有结构能力。

### 5.2 实现边界

- arXiv adapter 抽取现有 `fetchArxivTextDetailed`、代理、HTML/PDF 和结构工件逻辑，但其入口改为
  authenticated `paper-identity-v1` + authority receipt，不读取 daily current。
- conference adapter 只消费 `conference-source-context-v2` 的真实 plan handle。当前 weak PDF 允许
  长文分析，表格/公式/图像仍 unavailable；未来独立 extractor receipt 升级后才开放对应能力。
- 每个 identity 只缓存一份 source bundle；多个历史页面只引用 bundle SHA。
- 旧 archive 可作为查找缓存，但必须逐字节重放到当前 source contract。82 个已有 archive 中没有
  完整现代五段闭包，不能因文件存在就跳过恢复。
- 默认禁止 abstract-only 发布。确实无全文时保持 blocked；是否允许显式降级必须是另一个用户签发
  policy，且不能混入本轮“全部深度重写”的 complete。

### 5.3 CLI

```bash
planned history:sources prepare --crosswalk UUID --run-id UUID
planned history:sources fetch --run-id UUID --adapter arxiv --concurrency N
planned history:sources import-conference --run-id UUID --plan PLAN_HANDLE --concurrency N
planned history:sources status --run-id UUID
planned history:sources finalize --run-id UUID
```

### 5.4 P1 验收

- source completion 的 identity set 精确等于 P0 的 `U`；
- 每个缓存可在断网状态从 descriptor 重放，丢失/改变一个字节即失败；
- metadata 身份与 canonical identity 一致，conference `paperId` 与 `sourceIdentity` 不混用；
- 原文非空白门槛、UTF-8、PDF、JSON duplicate key、symlink/父路径和最大字节限制有真实 authority
  fixture 覆盖；测试应断言精确 reason code，不能都靠外层 SHA 失败伪装语义覆盖；
- 统计 source 获取零 LLM Token；网络请求和失败原因可审计。

## 6. P2：唯一论文分析、Reader、评分与事实验收

### 6.1 新合同

1. `historical-analysis-run-v1`
   - `runId`、crosswalk/source completion SHA、`U` 个 analysis key；
   - model/protocol/prompt/parser/engine/预算指纹和精确 shard plan；
   - 不含旧 canonical、旧 Reader、旧博客正文。
2. `historical-analysis-record-v1`
   - 复用生产 canonical 13 阶段、八维评分和 recovery checkpoint；
   - provenance 绑定 canonical identity、source bundle SHA、source-only=true、
     oldGeneratedTextIncluded=false。
3. `historical-reader-record-v1`
   - Reader v3 article/plan、source-bindings v4、作者/机构、资源、表格/公式/图片 capability；
   - article/plan/source/figure/author/resource SHA 和实际 provider usage。
4. `historical-fact-review-v1`
   - 独立报告绑定完整 paper/article/plan/source SHA；
   - parser pass、事实 pass、图像 pass 分开，缺图能力时记录 not-applicable/unavailable 而非伪 pass。
5. `historical-analysis-completion-v1`
   - `U/U` successful analysis、Reader 和 fact review；任何 pending/failed 都阻断 P4 finalization。

### 6.2 analysis-engine 适配

- 复用 `analyzeBatch` 的 worker、retry、checkpoint callback、锁内重读和 result merge。
- 新增统一 `withHistoricalAnalysisContext(identityHandle, sourceHandle, callback)`；deep analyzer 只能从
  context 取 source，不得自行按 arXiv ID fallback 联网。
- 单篇锁键改为 `paper-identity-v1.identitySha256` 或安全编码 canonical ID，并置于历史 run 的受控根；
  不与 `data/current/.analysis-runs` 隐式共享路径。
- arXiv 与 conference 可有不同 source adapter，但进入 canonical/Reader 后使用同一成功合同。
- `preparePaperLocked` 在锁内重读 identity/source/analysis state；checkpoint 先持久化后回调返回。
- 已完成且全部指纹相等才 skip；prompt、source、parser、Reader contract 或 taxonomy 输入改变时只失效
  必要下游，不清零既有 usage。

### 6.3 Reader 与质量门禁

- Reader 默认只接收原始来源证据、结构工件与必要 metadata；不重复注入旧 canonical 评论或旧博客。
- 结构证据不足时减少表格/公式/图片数量，不放松 cell/TeX/pixel 绑定。
- 先用 production parser 做零 Token 重放；只把可局部修复的问题送 repair，事实问题进入独立 review。
- 同一 unique identity 的 fact review 只做一次；所有 page projection 引用同一已签记录。
- operator patch 必须保持 parent/source CAS、归档和 `newApiRequests=0` 证明；不得用新 runId 重置预算。

### 6.4 CLI

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

- `U/U` canonical records 与 Reader records 均由 `isSuccessfulAnalysisRecord`、
  `apiReaderV3BindsCanonical` 及 source provenance 重放通过；
- 13 个标题、篇幅、术语桥、主结果覆盖、评分、作者/机构、资源可达性和结构工件分别验收；
- 每篇事实报告绑定最终而非中间 article SHA；任何 operator 修改都会使旧报告失效；
- provider usage 按 identity/stage/attempt 汇总，未知回执单列，不宣称为零；
- 任一页面重复身份不会触发第二次 canonical 或 Reader 主生成。

## 7. P3：production taxonomy 与旧 taxonomy URL

### 7.1 新合同

1. `paper-taxonomy-assignment-v1`，每个 unique identity 一份：
   - registry SHA、analysis/Reader/source SHA；
   - `primaryTask`、0–2 secondary tasks、`primaryScientificTopic`、methods、settings、signals、
     applications、researchFocus、artifacts、modelFamily、documentType；
   - 每个 concept 的来源证据、决定者、usage 和 `reviewed` 状态。
2. `historical-taxonomy-assignment-set-v1`：精确覆盖 `U`，父子去重、数量约束、未知 concept 和
   deprecated migration 全部失败关闭。
3. `historical-taxonomy-route-ledger-v1`：在改标签前由固定 Hugo build 枚举实际旧 taxonomy URL、
   term 与页面集合；inventory 的 candidate URL 只用于交叉提示。
4. `historical-taxonomy-route-plan-v1`：旧 URL 到保留 term 页、新 concept 页或静态 redirect 的
   显式映射；不能静默删除长尾标签 URL。

### 7.2 分类原则

- taxonomy 从新 analysis/source evidence 产生，不从旧 tags 直接复制。
- 任务选最具体叶节点；父节点通过检索继承，不和子节点重复存储。
- 合法非任务论文使用 scientific topic，不强塞主任务；方法、应用、setting 不互相冒充。
- 可先做确定性 evidence projection，再只对 ambiguous assignment 调模型；语义审核与字面映射分开统计。
- 一个 identity 分类一次，再投影到所有 pageId；不同 cohort 页面不得产生不同语义分类，除非来源版本
  确实不同且已拆为不同 canonical identity。

### 7.3 CLI

```bash
planned history:taxonomy snapshot-routes --inventory all-history.json --output ROUTE_LEDGER
planned history:taxonomy prepare --analysis-run UUID --registry config/paper-taxonomy.json --run-id UUID
planned history:taxonomy classify --run-id UUID --shard SHARD --concurrency N
planned history:taxonomy review --run-id UUID --decision NAME.json --owner REVIEWER
planned history:taxonomy status --run-id UUID
planned history:taxonomy finalize --run-id UUID
```

### 7.4 P3 验收

- `U/U` assignment reviewed；没有把 `partial/legacy_mapped` 当成 semantic pass；
- concept ID 全在同一 registry SHA，父子冗余为 0，数量门槛与非任务例外闭合；
- 1,243 个旧 term 每个都有 authoritative route disposition；1,065 个旧 unresolved label 不静默消失；
- 新标签覆盖广度、同义合并和子任务边界使用固定分层评测集复核；
- 页面展示只突出主任务与 2–3 个高区分度 concept，不因底层多 facet 恢复平面标签堆积。

## 8. P4：4,490 页面确定性投影

### 8.1 新合同

1. `historical-projection-plan-v1`
   - inventory/crosswalk/analysis/taxonomy completion SHA；
   - 4,490 个 baseline pageId 的精确 projection；
   - 每页 path、primary URL、publishedDate、cohortDate、legacyTaskKey、旧 bytes SHA；
   - aggregate membership、顺序策略、link target set/multiset 与显式 topology delta；
   - `authorizedAdditions` 单独列出新页面/redirect，默认空。
2. `historical-page-projection-v1`
   - 新 Markdown/sidecar/来源图文件 SHA；
   - canonical identity、Reader、taxonomy assignment 或 aggregate input SHA；
   - `oldGeneratedTextIncluded=false`；标题与引用只能来自新来源/Reader。
3. `historical-projection-completion-v1`
   - baseline 4,490/4,490 完成；新增项另计，不能用 addition 填补缺失旧页面。

### 8.2 页面规则

- 单篇 4,185 页：同一 identity 可共享 scientific payload，但每个 pageId 分别保留 path、URL、日期、
  cohort 和页面级 SHA；正文必须重新渲染，不能复制另一旧页面正文。
- 109 个日更汇总：只从对应 daily membership 的最终 Reader/评分/taxonomy 生成；排行榜和标题链接
  指向原单篇 URL，不再让模型总结整批论文。
- 3 个会议汇总：按唯一会议身份统计，同时显示目录、verified、source-ready、analysis complete、
  blocked/excluded 数；不把会议伪装成某日日更。
- 193 个 task 页：维持 ICASSP/ICLR task key 与成员分区。若新 taxonomy 改变任务归属，必须在
  projection plan 中给出旧 task URL 的兼容内容或 redirect，不能直接删页。
- ICLR 两个 cohort 分别投影，再汇入同一会议导航；页面日期、排序和来源版本不可串批。
- 内部链接至少保证旧 target page set 继续可达。若模板使同一 target 的 occurrence 数变化，必须在
  `topologyDelta` 中逐页签发；没有授权时按 inventory 的 link target multiset 保持。
- 所有 4,490 页的新 body SHA 应与旧 body SHA 不同。来源标题、标准术语和逐字证据自然重合不算使用
  旧正文；证明依据是上下文 allowlist/provenance，而不是简单字符相似率。

### 8.3 ICML task additions

ICML 当前有 137 个论文页和一个会议汇总，但没有历史 task 页。未来新增 task 页不是“重写旧页面”，
必须满足：

- 用户或版本化 policy 明确授权；
- 每个新 path、URL、pageId、task concept、成员集合和 redirect 进入 `authorizedAdditions`；
- addition 数量与 baseline 4,490 分开报告；
- dry-run Hugo 证明无 URL/alias/taxonomy collision；
- 不删除或改名 `icml2026-summary.md`；汇总页新增链接进入显式 topology delta。

### 8.4 CLI

```bash
planned history:project prepare --analysis-run UUID --taxonomy-run UUID --projection UUID
planned history:project render --projection UUID --scope daily:YYYY-MM-DD --concurrency N
planned history:project render --projection UUID --scope conference:icassp-2026 --concurrency N
planned history:project status --projection UUID
planned history:project finalize --projection UUID
```

所有输出先写 `data/runtime/history-rewrites/<UUID>/staging-blog/` 或隔离 Git worktree；P4 不修改真实
博客。现有 `publish-to-blog.py` 中通用 Markdown/Hugo renderer 可以抽取为库，不能调用其逐日写入入口。

### 8.5 P4 验收

- baseline：4,185 paper + 109 daily + 3 conference summary + 193 task = 4,490，零缺失、零重复；
- additions 独立计数，未授权时必须为 0；
- 每个旧 primary URL 返回对应新页面，所有旧 alias 和已认证 taxonomy route 可达；
- Hugo `list all/published`、全站 build、Markdown/HTML/MathJax/链接检查通过；
- 所有内部链接解析到计划中的 pageId 或受控 redirect，零 dangling/ambiguous；
- 聚合排名、成员数、分数、标签和链接可由 canonical records 机械重算；
- 真实页面字节冻结后才允许 review，review worker 不原地修改。

## 9. P5：历史 review 与 publication transaction

### 9.1 新合同

1. `historical-publication-baseline-v1`：博客 clean main、HEAD、实时 remote main OID/identity、Hugo
   版本、4,490 路径旧字节、旧 generation/review/push receipt 清单及 assets。
2. `historical-generation-manifest-v1`：projection completion、全部新/删除/不变文件、逐文件 SHA、模板和
   renderer SHA、baseline SHA、authorized additions。
3. `historical-review-receipt-v1`：逐文件 bytes/Hugo gate，加上按 unique identity 复用的事实报告、
   聚合页 membership/排序检查和 taxonomy route 检查。
4. `historical-publication-intent-v1`：精确 Git delta、目标 tree OID、parent OID、remote expected OID、
   commit message 和回滚 commit 计划。
5. `historical-publication-receipt-v1`：实际 commit/tree、push 输出、实时远端 main OID、全部 manifest SHA。
6. `historical-rewrite-status-v1`：P0–P5 receipt 链、4,490 baseline、additions、`U`、source/analysis/
   taxonomy/page/review/publish 计数与错误列表。

### 9.2 发布策略

- 默认 all-or-nothing：在隔离 worktree 完成全部写入和 review，最后一次受控 Git tree 安装与 push。
  不把 109 个日期逐次推到 main，避免读者看到混合新旧状态。
- 若仓库大小迫使分批发布，必须由用户另行授权 phased policy；每批有独立 URL 完整性与 rollback
  receipt，不能把“已推一部分”报告成全量完成。
- 旧 publication receipt 不删除、不覆盖；新的 history activation 将旧凭证逐项归档并绑定原 SHA。
  现有单日 `blog:activate-fresh` 不能循环冒充全历史 activation。
- 发布锁顺序固定：blog repository → history transaction → canonical identities（排序）→ state file。
- push 前再次获取远端 main；不等于 baseline 即停止。push 后远端 OID 必须等于本地 publication
  commit，Pages/Hugo 线上抽样和旧 URL 清单检查通过后才 complete。

### 9.3 CLI

```bash
planned history:review prepare --projection UUID --publication UUID
planned history:review run --publication UUID --shard SHARD --concurrency N
planned history:review status --publication UUID
planned history:publish dry-run --publication UUID
planned history:publish apply --publication UUID
planned history:status --publication UUID
```

`history:publish apply` 是唯一能改真实博客和推送的历史入口。它不得隐式触发 source、LLM、taxonomy
或内容修复；任何 review 后变化必须退回相应阶段、重新冻结字节并重审。

### 9.4 P5 验收

- generation manifest 路径集合与 Git delta 完全相等，仓库无旁路人工改动；
- 4,490 baseline 页面及 authorized additions 的最终 SHA 全部被 review receipt 覆盖；
- 独立论文事实审核按 `U` 全覆盖，页面渲染审核按 4,490 全覆盖；
- Hugo 页面数、published 集合、旧 URL/redirect、taxonomy route 和 14,743 基线链接 disposition 闭合；
- 本地 HEAD、tree、远端 main 和 publication receipt OID 一致；
- 故障注入覆盖 write/link/rename/fsync/commit/push/remote verify，恢复不得误删不同 inode/bytes；
- 最终 status 只有在 P0–P5 全部 complete 且 errors=0 时返回成功。

## 10. Token 与返工控制

### 10.1 只按 unique identity 付费

页面级朴素方案会为 4,185 页分别分析和生成 Reader。正确方案在 P0 后只处理 `U` 个 identity：

```text
避免的主分析次数 = 4,185 - U
页面/identity 放大率 = 4,185 / U
实际节省 Token = 按阶段汇总的 page-naive 对照 usage - identity-run 实际 usage
```

当前 preview 的 4,069 只是候选工作记录；若其身份全部成立，至少可避免 116 次重复主分析，但在
crosswalk finalize 前仍按最坏 4,185 个 identity 规划预算，不提前宣称节省。

### 10.2 分阶段 cache key

| 阶段 | cache key 至少包含 | 变化时失效 |
|---|---|---|
| source | identity SHA、authority receipt、adapter/extractor | 只失效该 identity 下游 |
| canonical | source snapshot、analysis prompt/model/protocol/budget、engine/parser | canonical 及以后 |
| Reader | canonical、source bindings、Reader prompt/model/budget、capabilities | Reader 及以后 |
| scoring | canonical/Reader、rubric、audit prompt/model | score 与聚合排名 |
| taxonomy | canonical/Reader/source、registry、assignment policy | taxonomy 与页面投影 |
| page | Reader/score/taxonomy、pageId/cohort、renderer/template | 指定页面及依赖聚合页 |
| review | 最终文件 SHA、review protocol/model | 只重审变化文件 |

同一 logical request 的 API key fallback 不生成新 cache identity；只有明确 usage-limit 才换账号。
网络错误、5xx、截断和内容门禁保留原账号与 attempt。所有 provider token 使用真实回执，缺失单列。

### 10.3 减少返工的执行规则

- P0/P1 全部是无 LLM 阶段；来源不闭合时不启动分析。
- 先运行 parser/preflight，再发模型；不可通过更多重试修 schema 或 source 错误。
- canonical → Reader → fact review 按 identity 流水，但一个 identity 的后阶段只能消费冻结的前阶段 SHA。
- aggregate、task、redirect 和绝大多数页面 review 使用确定性投影，不让模型重新总结同一论文。
- 失败按 stage 续跑；局部问题使用受 SHA 约束 patch，禁止新建 run 重置预算。
- 每个 shard 设置请求数、输入/输出 Token 和墙钟上限；超过即暂停并保留 checkpoint，不降级来源。
- 在试点达到首轮事实通过率和 Token 门槛前，不启动全量 4,185 页分析。

## 11. 试点矩阵

每个试点 manifest 必须从最终 inventory/crosswalk SHA 确定性选样并保存 pageId/identity，不能临时挑
容易通过的论文。建议至少覆盖：

| 试点 | 最小样本 | 必含场景 | 放大条件 |
|---|---:|---|---|
| Identity A | 40 页面 | daily single/none/conflict/multiple；三个会议；跨日期重复；ICLR 两 cohort | 40/40 verified，人工复核零错配 |
| Source B | 12 identities | arXiv HTML、PDF fallback、长文、表/公式/图；ICASSP/ICLR/ICML weak PDF；短文/坏 PDF 阻断 | source bytes/能力矩阵全部可重放 |
| Analysis C | 12 identities | 方法、数据集、理论、系统报告；资源有/无；机构有/无；结构能力不同 | parser 100%，事实首轮目标达到预设阈值 |
| Taxonomy D | 30 identities | ASR/AV-ASR、PEFT/LoRA、增强子任务、非任务 scientific topic、跨模态、数据集/benchmark | 双人或独立审查一致率达到门槛 |
| Projection E | 1 日更 + 3 会议切片 | 重复页、ICASSP task、ICLR 双 cohort、ICML 无 task；嵌套方括号链接 | page/link/Hugo 全通过，addition=0 |
| Publication F | 全 4,490 shadow | 完整路径集、旧 tag routes、远端漂移、故障恢复 | dry-run receipt 完整且真实博客零写 |

建议放大量级为 12 → 50 → 200 → 500 → 全量 unique identities。每一级都比较：首次 parser 通过率、
首次事实通过率、平均/分位 Token、repair 次数、不可恢复来源比例和 reviewer disagreement。未达到预先
写入 pilot manifest 的阈值就修合同/Prompt/代码并重跑同一试点，不用全量运行发现系统性问题。

## 12. 并行与串行边界

| 工作 | 可否并行 | 约束 |
|---|---|---|
| arXiv 与三个会议 identity adapter 开发 | 可以 | 先冻结 P0 schema；各自只写独立 fixture/adapter |
| page assignment 解析 | 可以 | 每 pageId 独立 decision；finalize 单线程 CAS |
| source fetch/extract | 可以 | 按 identity 分片；同 identity single-flight；受代理与 I/O 限额 |
| canonical analysis | 可以 | 复用配置并发；同 identity 锁内重读，不能跨 source SHA 合并 |
| Reader 与 taxonomy | 部分 | Reader 等 canonical；taxonomy runner 可开发并行，真实 assignment 等最终证据 |
| 单篇页面 renderer | 可以 | pageId 分片输出到 staging；不能写真实博客 |
| 日更/会议/task 聚合 | cohort 内串行 barrier | 必须等该 cohort/会议成员的 score/taxonomy 完整 |
| 文件级 review | 可以 | 最终 bytes 冻结后分片；同文件只有一个 authoritative verdict |
| manifest finalize、Git install、commit、push、remote verify | 必须串行 | 单一 history transaction 与固定锁序 |

并行 worker 只返回 immutable result/receipt；全局状态由一个 CAS writer 合并。任何 worker 不得直接
改 canonical、博客或 complete 计数。

## 13. 总体验收清单

启动真实全量前：

- P0 crosswalk finalized，4,185 page assignment、`U` identity groups、零 unresolved/conflict；
- P1 `U/U` source bundles，能力和来源 SHA 全闭合；
- 固定试点达到事实质量、Token 和恢复门槛；
- taxonomy assignment schema、旧 route ledger 和 projection schema 已冻结。

允许历史 review 前：

- P2 `U/U` analysis + Reader + fact review；
- P3 `U/U` semantic taxonomy reviewed；
- P4 4,490/4,490 baseline 页面 staged，所有新 body 来自新证据；
- 109 日更、3 会议汇总、193 task 完整；ICLR 双 cohort 未串批；ICML additions 显式计数；
- Hugo、URL、链接、taxonomy route、page count 与 published 集合通过。

允许 push 前：

- review receipt 精确覆盖 generation manifest；
- 真实博客仍为 baseline clean main，live remote main OID 未漂移；
- Git delta 只有 manifest 允许路径，旧 receipt 已安全归档而未覆盖；
- 故障恢复 dry-run 和远端失败演练通过。

最终完成：

- publication commit 已推送且远端 main OID 精确相等；
- 旧页面 URL 全部可达，授权 additions 单列；
- `history:status` 报告 P0–P5 complete、errors=0，并列出 4,490、4,185、`U`、additions、
  实际模型请求与 Token；
- 不把 parser pass、候选 identity、taxonomy literal mapping、局部 push 或未回执调用描述为全量完成。

## 14. 推荐实施顺序

1. 冻结并测试 P0 authority/crosswalk v2；完成 40 页 identity 试点。
2. 抽取通用 source adapter/context，先完成 12 identity 的 P1/P2 端到端试点。
3. 将 Reader/fact-review 与 production taxonomy assignment 接通，完成 30 identity 分类试点。
4. 实现 staging-only projection，优先日更、再 ICASSP、ICLR 双 cohort、最后 ICML；不创建 ICML task。
5. 用全 4,490 shadow build 验证 URL、链接、taxonomy routes 和 Git delta。
6. 实现 history generation/review/publication receipts，并完成故障注入。
7. 重新冻结 clean main/live remote 基线，才启动按 `U` 的全量来源与模型流水线。
8. 全部 review 完成后执行一次历史 publication transaction；重跑最终状态并核验线上旧 URL。

这条顺序把昂贵步骤放在身份和来源闭合之后，把重复页面折叠到 unique identity，并把所有聚合写作
变为可重算投影；它是同时降低 Token、减少返工和保证 4,490 页面不漏不串的核心约束。
