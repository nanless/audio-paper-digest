# 全历史论文博客重写交接（2026-09-07）

本文保留 2026-09-07 的**归档现场快照**，只供定位旧 runtime 工件使用。它不再定义执行顺序，也不能把旧
crosswalk 数字、`pilot` 参数、逐级放量或下面的旧命令样例当成当前门槛；除本节开头的 current-route 摘要外，
后续命令块均是历史记录，**不得执行**。当前操作以
[历史重写底座](history-rewrite.md) 为准：先合并本地好数据，直接建计划并重写；只有 arXiv fresh fetch
失败后写出的 named immutable handoff 才进入 crosswalk。会议本地输入缺失或损坏时 direct item 失败关闭。

当前链路是：`conference-local-sources → direct-inputs → conference-projections → direct-plan →
direct-scheduler → direct-run → direct-aggregate`。`direct-inputs` 的 arXiv route 直接来自冻结 inventory
已有的单一 arXiv link，故不再需要 `--arxiv-manifest`；每次 arXiv run 重新拉取、封存 TXT/PDF/runtime/manifest，会议则
重放本地 metadata/PDF SHA。任何旧 `history:analyze-batch`、`history:postprocess` 或 `crosswalk` 命令只能处理
相应 fallback/历史审计，不能阻挡 direct 队列。

## 1. 归档时的结论（非当前状态）

- 代码仓库 `main` 已推送到 `7671bdb8afca7b9f7b5ed03f1ceac96e75c6216e`。
- 博客仓库 `/Users/francis7999/code/github_repos/audio-paper-digest-blog` 工作区干净；本地与远端 `main` 均为 `bf263b803bd353f1411d94f27c621edb33dbb898`。
- 本轮没有启动全量 LLM 历史重写，没有改写或发布任何历史博客，也没有生成图片。
- 全仓验证已通过：Node `1504/1504`、Python `467/467`、Manual Python `24/24`；JavaScript/Python/shell 语法和真实 `validate:data --allow-empty` 通过。
- 当前历史 inventory 冻结了 4490 个已发布页面，其中 4185 个是论文页面。下文记录的 legacy crosswalk 数字仅描述当时的 identity fallback 快照；它不限制本地好数据进入 direct rewrite。
- 历史 publication 目前只实现安全的 `plan` 与私有 bundle `generate`；全历史专属 review、真实博客 activation、commit/push receipt 仍未实现。即使全部 staging 完成，也不能绕过这一缺口直接批量覆盖博客。
- 会议本地 metadata/PDF 可经 `history:conference-local-sources` 纳入 direct local catalog；其 SHA 与冻结页面 projection 是重写输入，不需要先走 legacy conference execution 或 crosswalk。

## 2. 归档时到底完成了什么

### 2.1 更详细、一次成型的核心摘要

`prompts/deep-analysis.md` 与 `prompts/core-summary-repair.md` 现在要求核心摘要：

- 6–9 句、320–600 个中文/中文标点字符；
- 覆盖任务输入、输出和实际难点；
- 用 2–4 步说明方法链，并写清各步骤分工和数据流；
- 给出至少 1 个原文可核对的定量结果，包含比较对象、数据集或设置、指标、数值与方向；
- 交代适用边界、失败条件或未验证外推范围；
- 交代训练、推理或部署成本；原文没有时使用固定的不可得声明。

摘要不再靠人工逐篇返修。主分析若没有满足合同，只调用 2500-token 的摘要局部修复；它只能替换 `## 核心摘要`，其余 12 个 canonical 一级章节逐字保护。评分审计随后重新绑定摘要，但 source-only Reader 不因 canonical 摘要变化自动重写。

### 2.2 九维受控标签体系

唯一权威是 `config/paper-taxonomy.json`。当前 registry 共有 228 个 active concept：

| 分面 | 数量 | 回答的问题 |
|---|---:|---|
| `task` | 90 | 论文主要解决什么任务 |
| `method` | 72 | 核心方法或真实研究方法是什么 |
| `setting` | 18 | 在什么学习、运行或部署条件下 |
| `signal` | 7 | 主要研究什么信号 |
| `application` | 11 | 主要应用场景是什么 |
| `research_focus` | 10 | 主要研究哪种性质或风险 |
| `artifact` | 4 | 论文贡献了什么产物 |
| `scientific_topic` | 11 | 主要解释什么科学现象 |
| `model_family` | 5 | 哪类基础模型承担关键角色 |

Current production 每篇必须显式给出 1 个 task 主标签和 1 个 method 主标签，总标签 3–5 个。标签必须逐字使用 active 中文首选名；别名、英文名、deprecated 名称和自造标签不得进入新 canonical。同一概念、同义项、祖先与后代不得重复；主任务必须是所选任务中最具体的概念。允许有独立证据的 peer method 作为补充，但不得靠标签顺序猜主方法。

为数据集、基准、主观听测、用户研究、综述和理论论文补充了真实研究方法分支，例如数据集构建、数据标注、评测协议、基准设计、众包评测、心理声学实验、系统综述、文献计量与形式化分析。这样无需用 Transformer、模型族或另一个任务冒充主方法。

Node 与 Python current parser 都从同一 raw registry 派生标签集合。Legacy alias 只存在于显式只读迁移路径；真正 pre-taxonomy 的旧成功记录可以被 `validate:data` 读取，但不能成为 current production success，也不能凭旧标签直接生成新页面。

### 2.3 `taxonomySeal` 局部封口

API 分析阶段顺序现在是：

```text
structureRepair -> taxonomySeal -> coreSummaryRepair -> scoringAudit
```

- 标签首次就合法时，`taxonomySeal=not_needed`，不调用模型。
- 标签非法时，最多进行 2 次、每次 2500-token 的 JSON concept-ID 修复。
- 修复只允许改完整 `## 标签` 节和机器摘要中的 `primary_task_tag`、`primary_method_tag` 两行。
- `not_needed` 也必须保留 taxonomy checkpoint 并逐字重放；`complete` 必须同时保留 structure 与 taxonomy 两份 checkpoint。
- Node 分析成功判断、`validate:data` 和 Python 发布预检都会独立重算 registry/projection/selection contract、输入输出 SHA、受保护正文投影、taxonomy surface、concept IDs，以及 taxonomy→摘要→评分的下游 SHA 链。

这项设计的 Token 目标是：分类正确时零增量调用，分类错误时只重标，不为 3–5 个标签重写整篇文章。

### 2.4 Manual 流程不再猜主方法

Manual V6 的 author base、production packet、task runner、revision binder、metadata correction、records envelope 和最终 spec 已贯通显式 `primaryMethodTag`。`type/task/primaryMethodTag/tags` 在 metadata correction 中必须同批绑定并重新通过 taxonomy runtime；只改角色字段、不改完整标签集合会失败关闭。

旧三字段 correction artifact 会失效，必须按新四字段合同重新物化。这是预期行为，不要增加兼容旁路。

### 2.5 历史后处理的漂移与并发保护

- taxonomy assignment 文件名同时绑定 registry SHA 和 assignment SHA；旧的 registry-only 文件只有逐字段等于当前重建结果时才可兼容读取。
- staging identity 绑定 analysis 文件 SHA、analysis record SHA、analysis 正文 SHA、assignment SHA、scheduler item SHA 和 renderer implementation SHA。
- staging 前后都会重读并比较期望 assignment 与 analysis，关闭 assignment A 到 staging B 的竞态。
- daily aggregate 会重放当日每个当前成员；同一论文出现在多个日期时，分析升级会使所有相关日期同时失效并等待重建。
- historical postprocess checkpoint 按 crosswalk、registry 和 renderer SHA 隔离。旧 checkpoint 保留审计价值，但不能冒充 current。

### 2.6 会议测试接入 current taxonomy

`tests/conference-postprocess.test.js` 不再使用两个标签和缺失角色行的旧 fixture，而是从 current runtime 按稳定 concept ID 生成 3 个 active 首选标签并自证 task/method/层级合同。会议 postprocess 聚焦测试 `11/11` 通过；没有为了测试变绿而放宽生产门禁。

## 3. 已废止私有运行状态（只用于解释旧 runtime）

所有 `data/runtime/` 工件都不提交 Git。新会话必须现场重读，以下数字只是 2026-09-07 交接快照。

### 3.0 专用长运行工作区

用户要求把全历史长任务与日更分开。历史重写的唯一工作目录是：

```text
/Users/francis7999/code/github_repos/audio-paper-digest-rewrite-all
```

原目录 `/Users/francis7999/code/github_repos/audio-paper-digest` 继续负责新论文筛选、日更博客、review 和 push。本文后续所有 `history:*` 和 `conference:*` 生产命令都必须在 `audio-paper-digest-rewrite-all` 执行。新会话第一条命令必须是 `pwd`；如果不在该目录，立即停止历史任务。

两个目录保留各自的 `.git`、`.env` 和 `data/runtime`。不得手工拼接 runtime JSON；不得让两个目录同时操作博客仓库或 push 代码远端。长运行期间可在历史目录保留私有 checkpoint；真正发布前必须：

1. 暂停原目录的日更发布；
2. 确认历史目录 tracked 代码无未保存改动，再同步最新 `origin/main`；
3. 同步博客仓库最新远端 `main`；
4. 重跑全量 producer/review，重新签发基于最新 Git/Hugo/OID 的 publication plan/receipt；
5. 只允许一个工作区执行最终 commit/push。

### 3.1 Crosswalk

当前主 crosswalk：

```text
7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328
```

只读状态命令：

```bash
npm run history:crosswalk -- status \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328
```

交接时输出：

```text
total=4185
verified=147
pending=4038
needsReview=0
blocked=0
conflict=0
identityGroups=128
completion=incomplete
```

4038 个 pending 页面的身份线索拆分为：

| 类型 | 页面数 | 处理方式 |
|---|---:|---|
| 唯一 arXiv hint | 2549 | 可由 `history:arxiv-batch` 现场抓取官方来源并验证 |
| 含 arXiv 候选的 conflict/multiple | 82 | 操作者必须选择 inventory 已有 hint，再用 `history:resolve-conflict` |
| 唯一 OpenReview hint | 128 | 需要对应官方 authority 适配与页面绑定 |
| 无 arXiv 的冲突页 | 2 | 需要会议/其他官方身份证据 |
| 无 identity hint | 1277 | 当前 blocked；其中 ICASSP 894、ICLR 267、daily 116 |

Inventory 总拓扑为 4490 页：4185 论文页、109 daily 汇总、3 会议汇总和 193 会议 task 页（ICASSP 140、ICLR 53）。论文 scope 为 daily 2883、ICASSP 898、ICLR 267、ICML 137。

不要手工删除 crosswalk 的 `operation.lock`。若 apply 报锁占用，使用脚本自己的 owner/lease/存活校验恢复；不得 `rm -rf`。

### 3.2 历史 analysis scheduler

权威 checkpoint：

```text
data/runtime/historical-analysis-schedulers/
  7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328.json
```

交接时 128 个 verified arXiv identity group 的状态：

| 状态 | 数量 |
|---|---:|
| 旧 `complete` | 2 |
| `analysis_partial` | 15 |
| `sources_ready` | 92 |
| `prepare_failed` | 9 |
| 尚未 prepare | 10 |

9 个 `prepare_failed` 的当前理由都是“analysis run missing; checkpoint completion was not trusted”。这类记录必须让 scheduler 重新 prepare，不可手工把状态改成 complete。

按当前 Prompt/taxonomy 现场重放后，可立即选择 123 个 identity：12 个 `analysis_partial`、92 个 `sources_ready`、19 个 pending/prepare-recovery；`new-full` 队列为 111，`reader-recovery` 为 8。另有 5 个 run 仍显示 `analyzing` 并带跨 hostname 锁：

```text
03fcc1e3-b4c4-49db-942f-b30353d532ce
4dec643f-a899-4343-b054-00662667123f
442dc33b-98fb-4d37-852d-32b08790ff81
70b67fcf-f836-4ab1-b4f3-51d1116dfca2
ed9a0272-32a2-4fbc-879e-ee4b495548e3
```

本机 PID 已不存在不等于可以手工删锁。只允许公共锁实现按 lease、hostname、PID、inode 和 owner SHA 的规则回收；新会话先 dry-run，然后原样重跑 scheduler。

新 Prompt/registry 下的只读 pilot dry-run 已确认：

```bash
npm run history:analyze-batch -- --dry-run \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --stage analyze --queue all --limit pilot --concurrency 1
```

选中项为：

```text
paperId=arxiv:2403.14817
runId=66759276-f030-4e3c-886e-6f5ca858b278
cohortDate=2026-08-06
currentStatus=analysis_partial
recoveryKind=full
```

注意 `recoveryKind=full`：新会话不得把旧的摘要-only 成功当成本轮完整试点。Registry/Prompt 变化后必须从 source-only 证据重新生成 current canonical；Reader 是否可按独立 source-only 身份复用，由代码门禁决定，不能人工强制复用。

### 3.3 Historical postprocess

当前 registry SHA：

```text
15c82a567ce5a55dc1175684ed08b64c158558639d9c8fb822c9587ec32a8778
```

只读 dry-run：

```bash
npm run history:postprocess -- --dry-run \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 --concurrency 3
```

交接时结果：scheduler 里有 2 个旧 complete，但两者在 current registry 下都是 `unsealed`，`completeAvailable=0`，因此没有 selected item。现有 postprocess checkpoint 使用旧 registry SHA `3f9a14...`，只能保留审计，不能复用为 current 页面。

### 3.4 ICASSP 2026

用户提供的本机 PDF 根：

```text
/Users/francis7999/Downloads/icassp-2026-papers
```

仓库里已有旧式汇总输入：

```text
data/current/icassp-2026-snippets.json
data/current/icassp_2026_deep_analyzers.json
data/current/icassp_2026_deep_analyzers-filtered.json
data/current/icassp_2026_deep_analyzers-excluded.json
data/current/output/icassp-2026-report.md
```

这些文件不是 `conference-source-ledger-v1` 的 authenticated production authority，不能拿来跳过 discovery、filter、PDF extraction、reviewed staging 和 import。交接时 `data/runtime/` 中没有真实 ICASSP conference execution 可供继续。

对用户本机目录做过只读 discovery 盘点：3694 条 metadata、3694 个 PDF；1652 个 exact、2040 个 normalized、2 个 ambiguous、0 unmatched、1 orphan。歧义项是同标题 `Robust Multimodal Representation Learning in Healthcare` 的 arnumber `11460772` / `11464483`；孤立文件是 `Robust Multimodal Representation Learning in Healthcare (11464483).pdf`。必须用人工或官方身份证据解歧，不能依赖标题自动认定。

## 4. 旧会话开场记录（不执行）

本节保留原会话的命令历史，不能作为新会话的开场清单。它引用的 crosswalk status、
`history:analyze-batch` 和 `--limit pilot` 都不是 direct rewrite 的前置步骤。新会话只按
`docs/history-rewrite.md` 的 local-direct chain 建 catalog/plan；不要执行下面的旧命令样例。

让新模型先完整阅读根目录 `AGENTS.md`、`SKILL.md`、`docs/history-rewrite.md`、`docs/conference-workflow.md` 和本文，然后执行只读检查：

```bash
cd /Users/francis7999/code/github_repos/audio-paper-digest-rewrite-all
pwd
npm run workspace:role -- status
git status --short
git branch --show-current
git rev-parse HEAD
npm run verify
npm run history:crosswalk -- status \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328
npm run history:analyze-batch -- --dry-run \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --stage analyze --queue all --limit pilot --concurrency 1
```

预期代码 HEAD 是本文提交之后的文档提交，而代码功能基线至少包含 `7671bdb8...`。博客仓库必须仍是干净 `main`；如有人工修改，先报告，不得覆盖。

原先建议的单篇 `arxiv:2403.14817` pilot 已撤销，不能用作任何放大门槛。质量审查保留为每个
direct run 的常规 review，而不是阻塞本地好数据的队列开关。

## 5. 已废止的 2026-09-07 执行草案（不执行）

以下 A–E 保留为旧运行记录，帮助解释既有 runtime 目录，不是当前执行路线。特别是其中的
`pilot`、分级放量、crosswalk finalize 和“先身份闭合再分析”要求均已被 direct-local-first 取代。

### 阶段 A：单篇真实 pilot

先运行完全相同的 dry-run。选中仍为 `arxiv:2403.14817` 后才 apply：

```bash
npm run history:analyze-batch -- --apply \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --stage analyze --queue all \
  --paper-ids arxiv:2403.14817 --limit pilot --concurrency 1
```

中断后重跑同一命令，由 checkpoint 决定恢复位置。不要删除 run 或 checkpoint。完成后：

```bash
npm run history:arxiv-analyze -- status \
  --run-id 66759276-f030-4e3c-886e-6f5ca858b278
npm run history:postprocess -- --dry-run \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 --concurrency 3
```

必须人工/Agent 审查 pilot 的以下事实，再决定扩大：

- 核心摘要为 6–9 句、320–600 中文字符，并有问题、方法链、关键数字、边界和成本；
- 不含旧博客正文或旧 Reader prose 输入；
- 主任务和主方法来自正确 facet，3–5 标签无祖先重复；
- `taxonomySeal` 可由 Node 与 Python 重放；
- 分项评分与总分闭合；
- 若 Reader 被复用，source-only identity、文章、plan、figure 和 source-binding SHA 全部未漂移；
- 没有为了通过门禁而把缺失证据写成技术错误。

然后执行单篇后处理：

```bash
npm run history:postprocess -- --apply \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --limit pilot --concurrency 1
```

`2026-08-06` 的 daily aggregate 若因同日其他论文未完成而 blocked，是正确行为，不要降低完整日期 barrier。

### 阶段 B：扩大已验证 arXiv 子集

Pilot 通过后按 12、50、剩余 verified identity 分级，不要直接用最大并发：

```bash
npm run history:analyze-batch -- --dry-run \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --stage analyze --queue all --limit 12 --concurrency 1
npm run history:analyze-batch -- --apply \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --stage analyze --queue all --limit 12 --concurrency 1
```

每一级统计：主分析首次通过率、taxonomy 零调用通过率、摘要局部修复率、Reader 重试率、平均输入/输出 token、失败类型与账号切换原因。系统只在明确 `GoUsageLimitError` 时切换 OpenCode Go 账号；普通 429、5xx、网络错误、截断或正文门禁不能切号。`.env` 已配置本机账号池，但密钥不得写入日志、文档或 Git。

每批分析后运行 postprocess；汇总页只做确定性聚合，不再调用 LLM：

```bash
npm run history:postprocess -- --apply \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 --concurrency 3
```

### 阶段 C：闭合剩余 4038 页的来源身份

先处理具有唯一、直接 arXiv hint 的 pending 页面。`history:arxiv-batch` 只做官方来源授权和 crosswalk CAS，不调用 LLM：

```bash
npm run history:arxiv-batch -- --dry-run \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --owner codex.history --limit pilot --concurrency 1
npm run history:arxiv-batch -- --apply \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --owner codex.history --limit pilot --concurrency 1
```

确认 pilot 后再使用数值 limit 和最多 3 并发。每批必须重跑 crosswalk status。多个/冲突 hint 只能使用 `history:resolve-conflict`，且选择值必须已经存在于 inventory 的非标题 hint；标题相似度永远不能签发 verified。

剩余没有可靠 arXiv identity 的页面必须进入会议或其他来源 adapter。不能把旧标题、旧正文、PDF 文件名相似度或搜索结果当成身份真值。Crosswalk 只有在 `pending=0`、所有 authority 可现场重放时才能 finalize；在此之前“全部历史论文”仍不成立。

### 阶段 D：ICASSP 2026 真实会议链

先取得与 PDF 对应的官方 metadata 快照；只有 PDF 目录时不能开始 production discovery。随后严格按 `docs/conference-workflow.md`：

```text
conference:discover
  -> conference:filter / conference:filter:run
  -> conference:extract --verify
  -> conference:staging
  -> conference:import
  -> conference:plan
  -> conference:execution
  -> sealed analysis/completion
  -> conference postprocess/aggregate
```

每一步先 dry-run，再 apply。当前 `conference:analyze` 已复用共享深度分析/Reader，`conference:postprocess paper|aggregate` 已能重放 completion、current taxonomy 和完整 selected member set。真实阻断是：

- reviewed extraction 仍需人工工件；弱 PDF 无法证明的表格、TeX 公式与图片必须保持 `unavailable`；
- conference postprocess 生成 generic 路径，尚未绑定 inventory 中的旧页面路径与 URL；
- 尚未覆盖 ICASSP 898、ICLR 267、ICML 137 个旧论文页、3 个会议汇总和 193 个 task 页；
- conference aggregate 尚未接入 historical publication，也没有会议历史 review/push/remote-OID 闭环。

因此下一模型可以先做 3–5 篇隔离 pilot，但不得手写 completed patch，也不得把 generic 试点当成历史会议页已重写。

会议论文按 canonical conference identity 去重；与 arXiv 页面确属同一论文时，需要有可审计 cross-identity 证据，不能仅凭标题合并。会议汇总必须列出目录总数、已核身份、来源可用、深度理解完成、未纳入/阻断原因，并只消费完成单篇投影。

### 阶段 E：全历史 publication 缺口

现有入口：

```bash
npm run history:publication -- plan --dry-run --plan-id UUID \
  --page-staging-runs UUID[,UUID...] \
  --daily-aggregates UUID@YYYY-MM-DD[,UUID@YYYY-MM-DD...]
npm run history:publication -- plan --apply --plan-id UUID \
  --page-staging-runs UUID[,UUID...] \
  --daily-aggregates UUID@YYYY-MM-DD[,UUID@YYYY-MM-DD...]
npm run history:publication -- generate --apply \
  --plan-id UUID --batch-id daily-YYYY-MM-DD
```

这些命令只生成受保护的私有发布 bundle，不写博客。下一模型必须完成并验证历史专属的：

1. 全量 review manifest/receipt；
2. 逐页最终字节 SHA 和 Hugo gate；
3. 精确 Git delta 与旧 URL/alias 保留；
4. activation/commit/push transaction；
5. 推送后远端 `main` OID 验证；
6. 覆盖单篇、每日汇总、会议汇总的统一最终 status。

不要把现有日更 `blog:generate/blog:review/blog:push` 强行套到数千页历史 bundle，除非先证明它们可以绑定完整历史 DAG、精确允许的 delta 和跨批次恢复；否则会破坏已经实现的历史事务边界。

## 6. 当时拟定的完成定义（已废止）

“全部历史论文博客已重写、重标并发布”必须同时满足：

- 4185 个冻结论文页面全部有可重放的 direct source route；本地好数据直接进入该 route，只有 arXiv fresh fetch 失败后写出的 named immutable handoff 才有已解决的 crosswalk fallback；
- 每个唯一 canonical paper 只从 source-only 证据生成一次 analysis/Reader；
- 每篇摘要、评分、Reader 和 taxonomy production proof 全部 current 且可重放；
- 3–5 标签使用当前 registry，主任务/主方法明确，无 alias 输出和祖先重复；
- 所有重复历史页面得到同一 canonical 的确定性投影，同时保留原 URL；
- 所有每日汇总和会议汇总只由完整成员集合确定性生成；
- 全量 review 无 blocking issue，Hugo 固定版本通过；
- 博客提交只包含 manifest 允许的 delta；
- push 后远端 `main` OID 与本地提交一致；
- 最终状态列出页面总数、唯一论文数、成功/失败/阻断数，不能把 partial 称为 complete。

用户明确要求本轮不生图。图片生成不是上述重写任务的完成条件；不要调用 `image_gen`，除非用户以后重新明确授权。

## 7. 仍有效的禁止捷径

- 不读取旧博客正文、旧摘要或旧 Reader prose 作为新稿创作输入。
- 不用 `npm run reanalyze` 代替隔离的全历史 source-only scheduler。
- 不从历史日期重新执行 fetch 日更入口。
- 不在 API、网络或额度失败时切到 Manual。
- 不因标签错误重写 Reader；先用 `taxonomySeal` 局部修复。
- 不手工编辑 runtime JSON、SHA、receipt、checkpoint、锁或 completed 状态。
- 不在 direct source/analysis 未闭合、日期成员不全或会议本地 PDF/metadata 绑定不完整时发布 partial 汇总。
- 不把代码测试通过、staging 完成、私有 bundle 生成或局部 push 描述成全历史完成。

## 8. 相关权威文档

- 根约束：`AGENTS.md`
- 完整技能与运行说明：`SKILL.md`
- 文档路由：`docs/README.md`
- 历史来源与分析底座：`docs/history-rewrite.md`
- 全历史长期路线图：`docs/history-rewrite-roadmap.md`
- 会议生产链：`docs/conference-workflow.md`
- 标签设计：`docs/tag-taxonomy-design.md`
- 标签实现：`docs/tag-taxonomy-implementation.md`
- 脚本入口：`scripts/README.md`
