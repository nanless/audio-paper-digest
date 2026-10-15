# 三流程与共享核心

只有日更、官方会议、历史博客更新三条生产流程。新任务均调用当前公共引擎与 Prompt；来源和页面范围的差异通过适配器保留，不能伪装成 arXiv 身份。

## 从哪里进入

| 流程 | 获取/范围 | 分析/恢复 | 生成与发布 |
|---|---|---|---|
| 日更 | `run-daily-digest.sh` → `scripts/full-fetch.js` | `analysis-engine.js`；`deep-analysis-only.js`、`batch-analyze.js`、`refresh-api-reader.js` | `generate-blog.py`、`review-blog.py`、`push-blog.py` → `publish-to-blog.py` |
| 官方会议 | `official-conference-acquire.js`、`conference-discover.js`、`conference-filter-run.js` | `conference-process.js` → `lib/conference-analysis-adapter.js` → 同一 `analysis-engine.js` | `conference-page-render.py`、`publish-conference.py` |
| 历史更新 | `history-inventory.py`、`historical-direct-rewrite-inputs.js`、`historical-direct-rewrite-plan.js`、来源准备 | `historical-direct-rewrite-run.js` → `lib/historical-direct-rewrite-runner.js` → 同一引擎；`history-resume.js` | `historical-page-render.py`、`lib/historical-direct-publication.js` |

## 三条流程共用什么

| 职责 | 权威代码 | 要保留的规则 |
|---|---|---|
| 分析编排、锁、检查点、费用与恢复 | `scripts/analysis-engine.js`、`scripts/deep-analyzer.js` | 同篇锁内重读合并，原稿、失败与费用保留 |
| 网络与模型 | `utils.js`、`llm-account-pool.js`、`publish_common.py` | Muse/arXiv 强制代理，只有声明的账号额度故障可向后切号 |
| 全文、表格、公式、作者和资源身份 | `lib/fresh-analysis-context.js`、`lib/reader-*`、`reader_sealed_pdf_*.py` | 来源 SHA、结构化单元格、原始 TeX、真实像素、作者逐项身份与资源可达状态 |
| Reader 写作与局部修复 | `deep-analyzer.js`、`lib/reader-contract.js`、`reader-repair.js`、`reader-draft-order.js` | 同一长文结构、术语机制解释、来源绑定、受限修复预算 |
| 资源宣称 | `deep-analyzer.js` 的共享资源规则与发布只读重放 | 代码可访问不等于权重可下载；否定、条件、第三方引用与本文发布声明区分；新阶段绑定 reader-resource-availability-claims-v1 |
| 评分与标签 | `analysis-contract.js`、`lib/tag-stage-record.js`、`tag_stage_record.py`、`tag_catalog.py` | 八维评分、封顶总分、当前中文标签与明确主任务/方法 |
| 页面展示与引用导出 | `publish-to-blog.py`、`paper_reader_presentation.py` | 同一资源去重、作者展示、评分说明及 JSON/BibTeX/RIS/上下文导出；会议使用真实会议身份 |
| 实现指纹 | `lib/workflow-implementation-files.js` | 收录共享模块和 Python worker 的传递依赖；当前 Prompt 只由版本登记表选取 |
| 不可变文件与页面暂存 | `lib/publication-file-primitives.js`、`lib/paper-page-staging.js` | inode/单链接/目录、严格 UTF-8、SHA 回读和精确路径守卫 |
| 发布与审查 | `publish-to-blog.py`、`publish_common.py`、流程发布适配器 | 内容 SHA 审查复用、事务锁、精确文件清单、远端 OID、部署与网页核验 |

`lib/reader-*` 分成来源、表格、修复和恢复等模块是职责拆分；它们仍由公共引擎调用，不能因文件多而删掉守卫。

## 标签目录与多级路径

三条流程共用当前386项九维词表及 `tag_presentation.py` 展示函数，所选概念从原词表完整核验后生成父级路径。论文的直接标签仍为3–5项，祖先只作导航；文章不显示无命中的分面、兄弟方向或全目录。总目录保留全部方向及零计数节点。新分类只选[新版目录](https://nanless.github.io/audio-paper-digest-blog/tags/)已有概念，原262项和历史签名保留。

会议与历史发布通过 `tag_catalog_publication.py` 检查站点已保存本批词表的双份目录和原快照；新版本须先经受控词表同步，不能发布后才发现分类被隐藏。日更把这些资产纳入正常生成清单。词表纯追加的只读兼容、快照及发布边界见[标签规则](tag-display-policy.md#三条流程共用的目录与呈现)。

## 全批轮次与失败集合

来源和任务范围先通过各入口核验。首轮让本次选定且有执行资格的论文统一走正常流程：主分析、审校、Reader、评分、标签及对应暂存。每篇每轮进入一次正常流水线；保留各阶段原有的内部请求尝试和校验。等本轮所有在途论文结束，逐篇结果及轮次记录保存完毕，下一轮才启动。

后续轮仅处理上轮仍可重试的失败集合，按原来源和检查点恢复；通过当前资格检查的成功论文不重复请求模型。认证、配额、配置、保存故障或已标为运行级的错误停止新论文和新轮，等待在途结果保存；来源或身份不能核实、不可重试及额度耗尽的项不靠增加批次轮数放行。普通单篇内容失败不抢在其余论文首轮结束前反复精修。

来源绑定的事实反馈进入正常修复前，须持有论文锁并核验原严格反馈包，随后保存 `analysisFactReviewObligation`。原成功正文、阶段和费用照常保留，但不能代表本次纠错完成；无反馈续跑须读取原包继续同一范围。只有当前反馈的阶段证明、反馈 SHA、拒绝原句和完整内容资格全部通过，正常收尾才清除该义务与最新失败。批次保存、零工作与最终统计使用同一反馈完成判定；旧反馈已满足也不能替更晚失败作证。发布侧在义务字段存在时一律拒绝，即使请求仍在途中、尚未写入失败标记。该字段不给任何新请求额度，普通付费原稿仍可经真实正常复验成功返回后恢复。

公共调度由 `scripts/lib/analysis-failure-rounds.js` 实现。`PD_ANALYSIS_BATCH_MAX_ROUNDS` 控制本次调用最多执行多少轮，默认 3，范围 1–10；旧 `PD_ANALYSIS_MAX_RETRIES=N` 兼容为总共 `N+1` 轮，默认 2 对应 3 轮。它们改变外层调度，不清零阶段尝试、Reader 原候选、无进展记录或费用，也不自动建立新的付费 Reader 轮。单篇内部恢复、明确预算追加和来源重新获取是不同操作，见 [Reader 恢复预算](reader-explicit-retry.md)。

三条流程仍有必要边界：日更只使用当前批次完整封存来源；会议每篇仍受原尝试窗口和跨调用冷却约束，同次调用的轮次最多为公共上限与原 3 次窗口的较小值；历史的队列、`--paper-ids`、`--max-papers` 在首轮确定，失败轮不扩大该范围。来源下载、会议筛选和博客审查保留各自请求及恢复规则，不能把分析轮次参数套用到这些阶段。

Reader 批量刷新默认使用配置并发5和总轮数3，分别可用 `--concurrency N`（1–60）及 `--rounds N`（1–10）覆写。只有错误明确标为 `retryable=true` 的论文进入下一轮；来源计划、运行级或存储错误停止新派发，其余不可重试失败保留阻断原因并交回受控处理。显式强制重分析只在本次首次准备每篇时执行获准的候选重置；同次后续失败轮继续原候选与预算，不重复重置。

博客审查遇到正常内容拒稿时继续检查本批其他页面，最后汇总阻断发布；服务、存储、页面字节变化或凭证损坏按各入口的运行级故障规则停止新派发。一次审查不会因普通拒稿在同次调用中反复请求该页；修正后重跑审查，只按各流程的真实通过缓存复用未变页面或分块。失败审查记录是审计，不能充当通过记录。

共享图片审查对可识别的 Reader 图组保留完整的导读、看图路径、原图、图注与解释，包含当前图的 PDF 整页来源说明；不再用固定字符窗口夹入下一张图的导读。合法的前图解释兼作后图导读时，该完整段落可在两图上下文中分别保留，其他图的路径、图像与图注仍隔离。不识别的旧排版继续使用原局部窗口，不猜测或改写归属；图片自身的图文矛盾仍须正常拒绝。上下文修复只改变审查请求及协议，通过页仍按原路径与内容 SHA 复用，原失败记录和真实费用保留。

只有自动正常流程经过多轮、最终只剩少量持续失败项时，才考虑受控人工修正。`manualHandoff` 是建议和诊断：默认最多 5 篇、每项本次至少失败 3 轮；语义无进展默认观察 3 轮。到总轮上限仍有新稿变化，也可报告 `small_persistently_failed_set`；配置更多轮时，达到连续无进展阈值可提前结束自动轮。次数、时间戳和费用增加不算正文进展。把 `PD_ANALYSIS_MANUAL_HANDOFF_MAX_ITEMS` 设为 0 可关闭这项建议。

报告不修改失败状态，`newApiRequestsAuthorized` 始终为 `false`。服务故障、不可重试和预算耗尽分别保留阻断原因；预算耗尽只指向明确受控修正或有界追加的处理，不能自动重开额度。人工修改须保留原稿和真实费用，绑定本篇来源、当前失败稿 SHA、具体反馈及获准修改范围；修正后重新通过正常来源、正文、Reader、评分、标签和发布审查。不得手填 complete、删除失败记录或跳过校验来“手动通过”，见 [独立人工审查边界](../manual/README.md)。

## 必须保留的适配差异

日更封存本次官方 arXiv HTML/PDF；会议核验官方版本、会议 ID、账本和 PDF。只有 PDF 的来源不能声称有 HTML DOM 表格或公式能力，已授权的单一替代 PDF 例外仍受白名单限制。

历史按冻结页面范围去重，同篇论文只分析一次，再生成对应历史页面；保留的会议元数据/PDF须核验，arXiv按历史来源策略重新获取。无独立摘要或公开来源 URL 时，导出资料明确标为本次发布元数据不可得，不生成假 arXiv 链接或私有文件路径。

三者共用内容审查函数，但页面集合、来源账本和 Git 基线不同，仍需各自清单与审查凭证；不能复用不属于当前范围的凭证。

## Prompt 的唯一选择入口

`scripts/lib/prompt-text-versions.js` 登记各阶段当前版本。三流程通过公共分析引擎选取同一份主分析、审校、评分、Reader 和局部修复 Prompt；当前文件及用途见 [Prompt 索引](../prompts/README.md)。筛选和页面审查保留各自任务上下文，共用网络、模型路由与请求封装。

旧提示词正文不再保存在工作树；`scripts/lib/git-prompt-evidence-index.json` 只登记原路径、Git blob OID 和整文件 SHA。旧记录通过受控读取器从 Git 取回原字节，复核整文件及首围栏模板 SHA，并保留原声明、来源、检查点和付费记录；缺失或不符就停止，不能用当前正文补签旧结果。新请求只读取当前登记的 18 份 Prompt。

旧资源协议记录仅按其声明只读核验，不补签新合同；当前出版总是按最新资源规则对封存来源重放，缺少版本字段不能绕过。

## 已收敛的旧链

整批 Manual v5/v6/shadow 作者、任务、spec 与 records 链，以及微信、飞书、小红书、旧 backfill、隔离 Reader 效率实验和视觉调试渲染已退役。

会议独立 execution/analyze/postprocess CLI 已删除，统一走 `conference:process`。历史旧独立分析、标签、暂存、汇总、发布 CLI 和旧整批重写 CLI 已删除，统一走当前历史计划与 `history:resume`。

`manual/` 的剩余源码仅为旧记录来源/签名/正文核验，以及独立单页人工审查。旧历史核心中仍被受限恢复入口调用的部分保留，不允许重新建立旧任务或重置预算。单篇人工修正与审查是三流程的恢复能力。

## 操作与验证文档

- [操作手册](../SKILL.md)、[会议流程](conference-workflow.md)、[历史更新](history-rewrite.md)、[历史发布](history-direct-publication.md)。
- [安装配置](setup.md)、[来源补抓边界](daily-fetch-boundary.md)、[Reader 写作](reader-writing.md)、[恢复预算](reader-explicit-retry.md)。
- [数据格式](data-format.md)、[标签规则](tag-display-policy.md)、[维护验证](maintenance.md)、[故障排查](troubleshooting.md)。
