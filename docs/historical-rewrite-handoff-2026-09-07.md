# 全历史论文博客重写交接（2026-09-07）

本文保留 2026-09-07 的归档现场，用于定位旧运行文件、解释当时结果和未完成事项。下文的数字、提交、词表 SHA、任务 ID、配置和命令均属于旧记录，本次文字整理没有重新读取私有运行数据、下载目录或账号配置。所有历史命令块均不得执行；旧试点和逐级扩大条件不再是当前直接重写的门槛。

当前任务按 [历史重写流程](history-rewrite.md) 操作：先将本地会议元数据和 PDF 与冻结页面已有的单一 arXiv 链接合并，建立输入、页面对应关系和直接重写计划，不再需要 `--arxiv-manifest`。`direct-scheduler` 获取并封存来源；`direct-run` 只读取同一计划、同一来源获取序号（`plan/generation`）下标为 `ready` 的来源；随后 `direct-aggregate` 从完成结果生成汇总。每次 arXiv 获取结束后，程序封存文本、PDF、运行记录和来源清单；会议来源则重新核对本地元数据和 PDF 的 SHA。会议输入缺失或损坏时，须停止处理对应论文。

只有新 arXiv 来源获取失败后生成的、具有明确文件名且不可变的交接文件，才能进入 crosswalk 备用流程。旧 crosswalk 仍保留显式维护旧状态的写入入口，普通直接重写不依赖它。当前 `history:arxiv-batch` 只处理指定名称的交接文件，不接受旧 `--limit pilot`；旧 `history:analyze-batch` 和 `history:postprocess` 仍接受 `pilot|N`，而当前直接重写的 `--limit` 只接受整数，不接受 pilot，不能将这些参数一概称为已删除。

当前已有 [历史直接发布流程](history-direct-publication.md)，不同于下面尚未接通发布的旧 `history:publication` 私有流程。新会议见 [会议工作流](conference-workflow.md)。这些入口的存在不表示全部历史现场已处理完成；远端提交 OID 也不表示网页已上线，现行完成要求还包括对应部署和正式网页的 HTTP 200、地址、标题核验。

## 1. 归档时的结论（非当前状态）

代码仓库 main 当时已推送到 `7671bdb8afca7b9f7b5ed03f1ceac96e75c6216e`。博客仓库 `/Users/francis7999/code/github_repos/audio-paper-digest-blog` 工作区干净，本地与远端 main 均为 `bf263b803bd353f1411d94f27c621edb33dbb898`。那次工作没有启动全量 LLM 历史重写，没有改写或发布历史博客，也没有生成图片。

当时全仓验证通过：Node `1504/1504`、Python `467/467`、Manual Python `24/24`，以及 JavaScript/Python/shell 语法和实际 `validate:data --allow-empty`。历史清单冻结了 4490 个已发布页面，其中 4185 个为论文页。这些旧数量不限制现在可核验的本地来源进入直接重写。

当时旧 `history:publication` 只能核验发布计划并生成私有文件组，全历史专属审查、将文件安装到博客，以及提交和推送凭证尚未实现。因此，暂存完成不能作为批量覆盖博客的理由。后来建立的会议本地来源目录入口 `history:conference-local-sources` 可核验元数据和 PDF 的 SHA，再结合冻结页面的对应关系用于直接重写，不必先进入旧会议执行流程或 crosswalk；不能把这项后来建立的能力写成归档当天已经完成。

## 2. 归档时到底完成了什么

### 2.1 更详细、一次成型的核心摘要

当时 `prompts/deep-analysis.md` 和 `prompts/core-summary-repair.md` 将摘要要求明确为：正文写 6–9 句，按汉字和中文标点计数，共 320–600 个字符；说明任务输入、输出和难点，用 2–4 步解释方法、分工和数据流。至少提供 1 个原文可核验的定量结果，写明比较对象、数据集或设置、指标、数值和方向，并交代适用边界、失败条件或未经验证的外推范围。训练、推理或部署成本也须说明；原文未披露时使用固定的不可得声明。

主分析未满足这些要求时，只调用 2500-token 的摘要局部修复，替换 `## 核心摘要`，保护其余 12 个正式分析一级章节的原字节。评分审计随后重新绑定摘要；只使用原始来源的 Reader 不因正式分析摘要改变而自动重写，不再要求人工逐篇返修摘要。

### 2.2 九维受控标签体系

当时唯一词表来源是 `config/paper-taxonomy.json`，共有 228 个有效概念，分布如下。这是旧版本统计，现行词表和专名例外见 [分类实现说明](tag-system-implementation.md)。

| 分面 | 数量 | 回答的问题 |
|---|---:|---|
| `task` | 90 | 论文主要解决什么任务 |
| `method` | 72 | 核心方法或真实研究方法是什么 |
| `setting` | 18 | 在什么学习、运行或部署条件下 |
| `signal` | 7 | 主要研究什么信号 |
| `application` | 11 | 主要应用场景是什么 |
| `research_focus` | 10 | 主要研究哪种性质或风险 |
| `artifact` | 4 | 论文贡献了哪些数据集、工具等研究成果 |
| `scientific_topic` | 11 | 主要解释什么科学现象 |
| `model_family` | 5 | 哪类基础模型承担关键角色 |

当时每篇正式分析须显式提供 1 个主任务标签和 1 个主方法标签，共 3–5 个标签，逐字使用有效中文首选名。旧规则禁止别名、英文名、已废弃名称和自造标签；这是那一版本的规则，不能用来否定现行已明确允许的英文专名例外。同一概念、同义项和祖先后代不能重复，主任务须为所选任务中最具体的概念；有独立证据的并列方法可补充，但不能从标签顺序猜主方法。

词表补充了数据集构建、数据标注、评测协议、基准设计、众包评测、心理声学实验、系统综述、文献计量和形式化分析等研究方法，使数据集、基准、主观听测、用户研究、综述和理论论文不必用 Transformer、模型族或另一个任务冒充主方法。

Node 和 Python 解析器当时都从同一份原始词表派生允许标签。旧别名只供显式只读迁移；真正早于分类协议的成功记录可被 `validate:data` 读取，却不能当作当时的正式生产成功记录，也不能凭旧标签直接生成新页面。

<a id="23-taxonomyseal-局部封口"></a>
### 2.3 分类检查与局部修复（`taxonomySeal`）

当时分析顺序为：

```text
structureRepair -> taxonomySeal -> coreSummaryRepair -> scoringAudit
```

标签首次检查合法时，阶段状态为 `taxonomySeal=not_needed`，不调用模型；标签非法时，最多局部修复 2 次，每次使用 2500 token 的输出预算，模型以 JSON 返回概念 ID。修复只允许替换完整 `## 标签` 节，以及机器摘要中的 `primary_task_tag`、`primary_method_tag` 两行。

`not_needed` 仍保存标签检查点，并按原正文逐字复核；`complete` 则同时保存结构修复和标签检查两份检查点。Node 的完成判断、`validate:data` 和 Python 发布预检分别重新核对词表、标签对应关系、选择协议、输入输出 SHA、受保护正文、实际标签文字和概念 ID，以及标签阶段、摘要和评分之间的下游 SHA 对应关系。

分类正确时没有增量模型调用；分类错误时仅重标，不为 3–5 个标签重写整篇。

### 2.4 Manual 流程不再猜主方法

当时 Manual V6 的初稿输入、生产输入包、任务运行器、修订绑定器、元数据修正、记录封装和最终规格，都已使用显式 `primaryMethodTag`。元数据修正中的 `type/task/primaryMethodTag/tags` 须作为同一组核验，并通过标签检查；只改角色字段而不改完整标签集合会被拒绝。

旧三字段修正文件因而失效，须按新四字段协议重新准备。这是当时有意设定的兼容边界，不能加旁路让旧文件通过。

<a id="25-历史后处理的漂移与并发保护"></a>

### 2.5 历史后处理的内容变化检查与并发保护

标签分配文件名同时包含词表 SHA 和分配记录 SHA。旧文件名只包含词表 SHA 的记录，只有逐字段等于重新计算结果时才可读取。暂存页面还绑定六项 SHA：分析文件、完整分析记录、分析正文、标签分配记录、调度条目和渲染器实现。

暂存前后都重新读取标签分配和分析记录，避免使用一份标签分配却生成另一份分析的页面。同一论文跨日期出现时，更新分析会使相关日期的汇总失效，须从全部成员重新生成。旧历史后处理检查点按页面来源对应表、词表和渲染器的 SHA 分开保存，可以留作审计，但不能代表新的结果。

<a id="26-会议测试接入-current-taxonomy"></a>
### 2.6 会议测试接入当时的分类校验

当时 `tests/conference-postprocess.test.js` 已换掉只含两个标签且缺少主角色行的旧测试数据，改用稳定 concept ID 从分类实现生成 3 个有效首选标签，并核验 task、method 和层级关系。会议后处理的聚焦测试 `11/11` 通过，没有放宽生产检查。

<a id="3-已废止私有运行状态只用于解释旧-runtime"></a>
## 3. 已废止的私有运行状态（只用于解释旧运行记录）

`data/runtime/` 文件不提交 Git。以下只描述 2026-09-07 交接现场；真正恢复任务须按当前流程读取真实状态，不能直接采用这些旧数字。

### 3.0 专用长运行工作区

用户当时要求将历史长任务与日更分开，历史工作目录为：

```text
/Users/francis7999/code/github_repos/audio-paper-digest-rewrite-all
```

原目录 `/Users/francis7999/code/github_repos/audio-paper-digest` 负责新论文筛选、日更、审查和推送。长时间历史生产命令只在 `audio-paper-digest-rewrite-all` 执行；开始前用 `pwd` 核对目录和工作区角色，目录不符即停止。本文的命令块仍是不可执行的归档记录。

两个目录各自保留 `.git`、`.env` 和 `data/runtime`，不能拼接运行数据 JSON，也不能同时操作博客或推送同一代码远端。历史目录可以保留私有检查点；真正发布前，须停止日更发布，确认历史代码没有未保存的跟踪文件改动，同步代码 `origin/main` 和博客 `main`，重新生成与最新 Git、Hugo 和远端 OID 对应的发布计划及凭证。最终只允许一个工作区提交和推送。

当时建议重跑全量生成和审查；现行审查可按页面路径和内容 SHA 复用已通过结果，但仍须重新完成当前批次检查并生成新凭证，详见开头的发布流程。

### 3.1 Crosswalk

当时的主 crosswalk ID、只读查询命令和输出如下。保留命令供定位旧状态，不在本次执行：

```text
7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328
```

```bash
npm run history:crosswalk -- status \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328
```

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

4038 个 pending 页面的线索拆分如下。表中处理方式是当时建议，不等于已写入状态；特别是“应阻断”的页面仍包含在 pending 中，输出 blocked=0。

| 类型 | 页面数 | 处理方式 |
|---|---:|---|
| 唯一 arXiv 线索 | 2549 | 当时拟由 `history:arxiv-batch` 获取官方来源并核验 |
| 含 arXiv 候选的冲突或多条线索 | 82 | 当时须选清单已有线索，再用 `history:resolve-conflict` |
| 唯一 OpenReview 线索 | 128 | 须取得官方来源授权并绑定页面 |
| 无 arXiv 的冲突页 | 2 | 须取得会议或其他官方身份记录 |
| 没有身份线索 | 1277 | 当时建议保持阻断；其中 ICASSP 894、ICLR 267、日更 116 |

当时清单共有 4490 页：4185 论文页、109 个日汇总、3 会议汇总和 193 个任务页（ICASSP 140、ICLR 53）。论文范围为 daily 2883、ICASSP 898、ICLR 267、ICML 137。

不能手工删除 crosswalk 的 operation.lock。apply 遇到占用时，只能由脚本核验 owner、lease 和进程存活后恢复，不能使用 `rm -rf`。

<a id="32-历史-analysis-scheduler"></a>
### 3.2 历史分析调度器

当时使用下列 checkpoint，记录了 128 个已验证 arXiv 身份组：

```text
data/runtime/historical-analysis-schedulers/
  7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328.json
```

```text
03fcc1e3-b4c4-49db-942f-b30353d532ce
4dec643f-a899-4343-b054-00662667123f
442dc33b-98fb-4d37-852d-32b08790ff81
70b67fcf-f836-4ab1-b4f3-51d1116dfca2
ed9a0272-32a2-4fbc-879e-ee4b495548e3
```

```bash
npm run history:analyze-batch -- --dry-run \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --stage analyze --queue all --limit pilot --concurrency 1
```

```text
paperId=arxiv:2403.14817
runId=66759276-f030-4e3c-886e-6f5ca858b278
cohortDate=2026-08-06
currentStatus=analysis_partial
recoveryKind=full
```

| 状态 | 数量 |
|---|---:|
| 旧 `complete` | 2 |
| `analysis_partial` | 15 |
| `sources_ready` | 92 |
| `prepare_failed` | 9 |
| 尚未 prepare | 10 |

9 个 `prepare_failed` 当时都报“analysis run missing; checkpoint completion was not trusted”，须由调度器重新准备，不能手工改为 `complete`。按当时的模型提示和词表重新核验后，可选择 123 个论文身份：12 个 `analysis_partial`、92 个 `sources_ready`、19 个 `pending/prepare-recovery`。`new-full` 队列为 111，`reader-recovery` 为 8；上面另列的 5 个运行仍显示 `analyzing`，并持有属于其他主机的锁。

本机 PID 已不存在，不表示可以删除锁。公共锁实现还须核验租约、主机名、进程编号、文件索引节点和锁所有者记录的 SHA。当时建议先预览，再重跑同一调度器，不删除运行记录或检查点。

所列试点预览当时选择 `arxiv:2403.14817`，运行 ID 为 `66759276-f030-4e3c-886e-6f5ca858b278`，日期为 `2026-08-06`，状态为 `analysis_partial`，恢复类型为 `recoveryKind=full`。这个旧试点后来已撤销。旧的仅摘要分析成功记录不能视为完整分析；词表或模型提示变化后，须只从原始来源证据生成符合当时规则的正式结果。读者文章能否复用，由独立的来源身份检查决定，不能人工强制。

<a id="33-historical-postprocess"></a>
### 3.3 历史后处理

当时词表 SHA 及只读预览命令如下：

```text
15c82a567ce5a55dc1175684ed08b64c158558639d9c8fb822c9587ec32a8778
```

```bash
npm run history:postprocess -- --dry-run \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 --concurrency 3
```

调度器中有 2 个旧 `complete`，但在该词表下均未通过核验（`unsealed`），`completeAvailable=0`，没有可选条目。后处理检查点仍使用旧词表 SHA `3f9a14...`，仅作审计，不能用于新页面。命令中的并发 3 也是旧现场记录。

### 3.4 ICASSP 2026

用户当时提供的本机 PDF 根目录和仓库内旧式输入如下；本次未访问它们：

```text
/Users/francis7999/Downloads/icassp-2026-papers
```

```text
data/current/icassp-2026-snippets.json
data/current/icassp_2026_deep_analyzers.json
data/current/icassp_2026_deep_analyzers-filtered.json
data/current/icassp_2026_deep_analyzers-excluded.json
data/current/output/icassp-2026-report.md
```

这些文件不能作为 `conference-source-ledger-v1` 的获授权来源，不能跳过目录获取、筛选、PDF 提取、暂存结果复核和导入。当时 data/runtime 中也没有可继续的真实 ICASSP 会议执行记录。

旧只读盘点记录为 3694 条元数据、3694 份 PDF：1652 个精确匹配、2040 个归一化匹配、2 个歧义匹配、0 个未匹配、1 个孤立文件。歧义涉及同标题 `Robust Multimodal Representation Learning in Healthcare` 的 arnumber `11460772` / `11464483`；孤立文件是 `Robust Multimodal Representation Learning in Healthcare (11464483).pdf`。须用人工或官方身份记录解歧，不能凭标题自动认定。

## 4. 旧会话开场记录（不执行）

当时建议新接手者完整阅读 AGENTS.md、SKILL.md、历史和会议流程及本文，再运行以下检查。该命令块已经废止，不是当前会话的行动清单；旧 crosswalk status、history:analyze-batch 和 --limit pilot 都不构成直接重写前提。

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

原记录期望代码 HEAD 为交接文档提交之后的提交，功能基线至少包含 `7671bdb8...`，博客保持干净 main；有人工修改时先报告，不能覆盖。这是当时的预期，不是今天应回退的提交。

原先 arxiv:2403.14817 的单篇 pilot 已撤销，不能作为放大门槛。每个直接运行仍须进行正常质量审查，但不能将这个旧试点设为使用已核验本地来源的前提。

## 5. 已废止的 2026-09-07 执行草案（不执行）

以下 A–E 用于解释旧运行目录，均为历史设计，包括 apply 命令也不授予本次操作授权。旧试点、分级扩大和 crosswalk finalize 不再定义当前流程；当前每篇仍须核验自己的真实来源。

<a id="阶段-a单篇真实-pilot"></a>
### 阶段 A：单篇真实试点

当时草案先要求预览选中 arxiv:2403.14817，再执行分析，并在完成后检查运行状态及后处理：

```bash
npm run history:analyze-batch -- --apply \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --stage analyze --queue all \
  --paper-ids arxiv:2403.14817 --limit pilot --concurrency 1
```

```bash
npm run history:arxiv-analyze -- status \
  --run-id 66759276-f030-4e3c-886e-6f5ca858b278
npm run history:postprocess -- --dry-run \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 --concurrency 3
```

旧恢复原则是重跑同一命令，由检查点决定继续位置，不删除运行记录或检查点。试点的人工或 Agent 审查要求如下：摘要 6–9 句、按中文字符计 320–600，覆盖问题、方法、关键数字、边界和成本；输入不含旧博客或旧读者文章正文；主任务和方法属于正确分类维度，3–5 标签不重复祖先；旧 `taxonomySeal` 阶段可由 Node 和 Python 重新核验；分项及总分吻合。若复用读者文章，来源身份、文章、计划、图片和来源绑定的 SHA 须与原记录一致，不能将证据缺失写成技术错误。

```bash
npm run history:postprocess -- --apply \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --limit pilot --concurrency 1
```

当时若 2026-08-06 汇总因同日其他论文未完成而 blocked，属于正常保护，不能放宽完整日期集合要求。

### 阶段 B：扩大已验证 arXiv 子集

旧草案要求试点通过后按 12、50、其余已核验论文身份分级，而不是立即使用最大并发：

```bash
npm run history:analyze-batch -- --dry-run \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --stage analyze --queue all --limit 12 --concurrency 1
npm run history:analyze-batch -- --apply \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --stage analyze --queue all --limit 12 --concurrency 1
```

```bash
npm run history:postprocess -- --apply \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 --concurrency 3
```

每一级拟记录主分析首次通过率、分类零调用通过率、摘要局部修复率、Reader 重试率、平均输入输出 token、失败类型和切号理由。按当时机制，只有明确 GoUsageLimitError 才切 OpenCode Go 账号，普通 429、5xx、网络错误、截断和正文检查失败不切号。原记录称本机 .env 已有账号池，密钥不得进入日志、文档或 Git；本次没有核验当前配置。

每批分析后拟运行后处理，汇总页确定性生成，不再调用 LLM。这个旧扩大方案现在不执行。

### 阶段 C：闭合剩余 4038 页的来源身份

旧草案拟先处理 pending 中具有唯一直接 arXiv 线索的页面，让 `history:arxiv-batch` 获取官方来源授权，并在整份页面与来源对应表的状态 SHA 与处理决定记录要求的旧状态 SHA 一致后，更新页面状态并保存处理决定，不调用 LLM：

```bash
npm run history:arxiv-batch -- --dry-run \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --owner codex.history --limit pilot --concurrency 1
npm run history:arxiv-batch -- --apply \
  --crosswalk 7e7c3bd4-630d-4f6b-9cf1-0a7f64d11328 \
  --owner codex.history --limit pilot --concurrency 1
```

随后拟改用数值 limit、最多 3 并发，每批重新读取 crosswalk 状态。这些 arxiv-batch 命令已不受当前参数解析器支持，只保留历史原形；不能扫描普通 pending。当前入口只接新 arXiv 获取失败后生成的命名交接文件，见开头说明。analyze-batch/postprocess 的 pilot|N 参数没有因此删除。

旧多线索和冲突线索须由 history:resolve-conflict 选择 inventory 已有的非标题线索，标题相似度不能产生 verified。无可靠 arXiv 身份的页面拟交会议或其他来源适配器，旧正文、旧标题、PDF 文件名相似度和搜索结果不能当成已核身份。原方案只有 pending=0 且全部来源授权均能从原记录重新核验才 finalize，不能在此前报告“全部历史论文”已核验。

### 阶段 D：ICASSP 2026 真实会议链

当时先要求官方元数据与 PDF 对应，仅有 PDF 目录不能启动正式目录获取；拟按以下旧分离流程执行：

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

那份草案要求每步先用 dry-run 预览，再用 apply 执行。当时 `conference:analyze` 已复用深度分析与读者文章生成，`conference:postprocess paper|aggregate` 能重新核验完成凭证（`completion`）、标签分配和完整入选成员，但仍有四个缺口：

- 提取结果需要人工准备并复核；当时证据较弱的 PDF 中，未获来源证明的表格、TeX 公式和图片仍标为 `unavailable`。
- 后处理生成通用路径，尚未绑定清单中的旧路径和 URL。
- 尚未覆盖 ICASSP 898、ICLR 267、ICML 137 个旧论文页、3 个会议汇总及 193 个任务页。
- 会议汇总尚未接入旧历史发布入口，会议历史审查、推送和远端 OID 核验尚未接通。

因此，当时只建议做 3–5 篇隔离试点，不能手写完成状态补丁，也不能把通用路径试验说成旧会议页面已重写。这些限制描述当时能力；今天的新会议使用会议工作流的 process 入口，历史页面使用直接重写，不重走这个分离链。

当时还要求按论文主身份去重，会议与 arXiv 合并须有可审计的双身份关联证据，不能仅凭标题。会议汇总分别列目录总数、已核身份、来源可用、分析完成、未纳入或阻断原因，并只读取完成的单篇结果。

<a id="阶段-e全历史-publication-缺口"></a>
### 阶段 E：全历史发布缺口

当时旧入口如下：

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

它们只生成受保护的私有发布文件，不写博客。草案要求另行实现并验证六项能力：审查全部生成清单和凭证、核验逐页最终 SHA 并运行 Hugo 检查、限定精确 Git 差异并保留旧 URL 和别名、执行可恢复的激活与提交推送事务、核验推送后的 `main` OID，以及统一报告单篇、每日汇总和会议汇总的最终状态。

不能直接用日更 blog:generate/blog:review/blog:push 处理数千页历史发布文件组，除非先证明它能核对全部依赖、限定精确允许的差异，并支持跨批次恢复。开头列出的当前直接发布已另建入口；保留这段旧缺口，不表示今天仍没有历史发布功能。

## 6. 当时拟定的完成定义（已废止）

归档草案将“全部历史博客已重写、重标并发布”限定为：4185 个冻结论文页面的来源均能从原记录重新核验，每篇唯一论文只从原始来源证据生成一次分析和 Reader；摘要、评分、Reader 和分类证明符合当时版本且能核验。3–5 标签来自同一词表，主任务和主方法明确，没有别名输出或祖先重复。

重复页面使用同一论文结果分别生成，保留原 URL。每日及会议汇总只读取完整成员；全量审查没有阻断问题，固定 Hugo 检查通过，博客只提交 manifest 允许的差异。推送后远端 main OID 与本地提交相同，最终状态列明页面数、唯一论文数、成功、失败和阻断数，不能将部分完成称为全部完成。

原文后来补充的 direct 来源要求，在现在的流程中指本地已核来源直接使用，只有新 arXiv 获取失败的命名不可变交接文件才走已解决的 crosswalk 备用。它不改变上面旧现场数字，也不能替代现行完整发布检查。

2026-09-07 那次用户明确排除生图，因此当时的重写完成条件不包括图片生成。这一范围记录不授予本次或未来任务排除视觉的权限，也不产生新的视觉豁免；以后是否排除或豁免视觉须以实际用户要求为准，不据此调用 `image_gen`。

## 7. 仍有效的禁止捷径

旧博客正文、摘要和 Reader 不能作为新稿输入；`npm run reanalyze` 不能替代只使用原始来源的隔离历史调度器，也不能从历史日期重跑日更来源抓取入口。API、网络或额度失败不切 Manual。

标签错误应交给当前标签选择与修复阶段处理，不能仅因此重写读者文章。新阶段和检查点使用 `tagSelection`；旧记录由兼容读取器按原版本核验，不能手工改阶段键。运行 JSON、SHA、审查凭证、检查点、锁和完成状态均不能手工修改。来源或分析未核验、日期成员不齐，或者会议 PDF 与元数据不对应时，不发布成员不全的汇总。代码测试通过、页面暂存完成、私有文件组生成或部分推送，都不等于全历史完成。

## 8. 相关权威文档

- 根约束：[AGENTS.md](../AGENTS.md)
- 完整运行说明：[SKILL.md](../SKILL.md)
- 文档导航：[docs/README.md](README.md)
- 当前历史来源与分析流程：[docs/history-rewrite.md](history-rewrite.md)
- 历史设计路线图：[docs/history-rewrite-roadmap.md](history-rewrite-roadmap.md)
- 当前会议流程：[docs/conference-workflow.md](conference-workflow.md)
- 分类设计：[标签体系设计](tag-system-design.md)
- 分类实现：[标签体系实施说明](tag-system-implementation.md)
- 脚本入口：[scripts/README.md](../scripts/README.md)
