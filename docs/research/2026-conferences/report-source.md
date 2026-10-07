# 2026 会议来源研究与接入记录（9 月 9 日及 9 月 25 日增补）

主研究日期为 2026-09-09（Asia/Shanghai），面向仓库维护者和后续处理会议论文的代理。研究排除仓库已整理的 ICASSP、ICLR、ICML，调查当时已公开、即将公开或值得跟进的国际 AI、语音、音频和音乐会议；2026-09-25 另补 Interspeech 接入情况。

下面的会议状态、HTTP 观察、来源数量和运行完成情况均属于相应记录时点，没有在文档修订时重新联网核验。今天执行应查[会议工作流](../../conference-workflow.md)，不能将旧来源总表或当时授权视为当前运行状态。

研究优先使用会议或出版组织的官方论文集。“顶级/次顶级”没有统一官方排名，下面的领域定位只用于说明影响力与仓库相关性，不写成论文事实。

## 主研究时已经接入的十一项来源

当时接入 Odyssey、IWSLT、EUSIPCO、NIME、DAFx、AAAI、AISTATS、UAI、CVPR、ACL、EACL 十一个 2026 官方来源，并实际下载、校验及核对发现记录，共 16,046 篇。统一的九项元数据、逐篇 PDF、响应凭证和 SHA-256 相互绑定，再由 `official-proceedings` 的发现记录核对官方论文编号与本地文件。

分析使用日更的 `analysis-engine.js`、13 个正式分析一级标题、按文档类型适用的八维评分、`beginner-researcher-v3` 和 `api-reader-source-bindings-v4`，没有另用简化模板。单篇和汇总按当时分类词表的有效中文首选标签及兼容规则处理，保留分类兼容说明、主任务和主方法，不用旧标签或临时自造标签代替现行分类要求。

## 当时的官方全文归档

| 来源标识 | 领域与定位 | 官方单篇数 | 纳入边界 | 研究时归档状态 |
|---|---|---:|---|---|
| `odyssey-2026` | 说话人/语言识别专题会议 | 52 | 排除 4 个没有论文集 PDF 的主旨演讲摘要页 | PDF、响应凭证、SHA 与发现记录已核对 |
| `iwslt-2026` | 机器翻译/语音翻译专题会议 | 39 | 官方会议索引显示 40 项；排除卷首 `.0`，保留 39 篇单篇论文 | PDF、响应凭证、SHA 与发现记录已核对 |
| `eusipco-2026` | 信号处理重要综合会议，含语音/音频 | 567 | 官方分会场索引的逐篇 PDF | PDF、响应凭证、SHA 与发现记录已核对 |
| `nime-2026` | 新型音乐表达界面核心会议 | 171 | 官方 2026 论文集的逐篇 PDF | PDF、响应凭证、SHA 与发现记录已核对 |
| `dafx-2026` | 数字音频效果核心专题会议 | 91 | 72 个常规论文及挑战赛论文 PDF，加 19 个官方演示论文 PDF；演示论文保留独立分轨 | PDF、响应凭证、SHA 与发现记录已核对 |
| `aaai-2026` | 综合人工智能顶级会议 | 4,920 | 官方 OJS 第 40 卷的固定 48 个分册；逐分册保存并核验，证明论文编号在各分册间唯一 | PDF、响应凭证、SHA 与发现记录已核对 |
| `aistats-2026` | 统计机器学习重要会议 | 588 | PMLR v300 单篇记录；排除整卷文件和卷首材料 | PDF、响应凭证、SHA 与发现记录已核对 |
| `uai-2026` | 不确定性推理重要会议 | 330 | PMLR v337 单篇记录；排除整卷文件和卷首材料 | PDF、响应凭证、SHA 与发现记录已核对 |
| `cvpr-2026` | 计算机视觉顶级会议 | 4,030 | CVF 主会论文；不混入研讨会论文 | PDF、响应凭证、SHA 与发现记录已核对 |
| `acl-2026` | 自然语言处理顶级会议 | 4,459 | 仅 long、short、findings；排除 demo、SRW、industry、tutorial、workshop 与卷首 | PDF、响应凭证、SHA 与发现记录已核对 |
| `eacl-2026` | 自然语言处理重要区域旗舰会议 | 799 | 仅 long、short、findings；边界同 ACL | PDF、响应凭证、SHA 与发现记录已核对 |

归档目录为 `data/runtime/official-conference-acquisitions/<provider>/`，这批 16,046 篇的 PDF、元数据和响应凭证约 65 GiB。发现快照保存于 `data/runtime/conference-discovery-catalogs/` 和 `data/runtime/conference-discovery-reports/`。这些运行数据被 Git 忽略，不写入 `data/current/`。

## 当时完成的筛选及其范围

16,046 篇官方论文当时均经过会议筛选 v5。程序先重新核验发现记录中唯一的 `exact` PDF，离线提取前两页并定位摘要证据，再使用日更相同的关键词预筛、筛选提示词、公共 LLM 路由和严格校验的 JSON 筛选决定。逐篇决定绑定调用前保存的请求记录、原响应、用量记录、来源 SHA 和分类词表。11 个状态均为 `complete`，没有 `pending` 或 `failed`；入选 955 篇，排除 15,091 篇。

| 来源标识 | 官方候选 | 入选 | 排除 | 筛选状态 |
|---|---:|---:|---:|---|
| `odyssey-2026` | 52 | 52 | 0 | complete |
| `iwslt-2026` | 39 | 38 | 1 | complete |
| `eusipco-2026` | 567 | 127 | 440 | complete |
| `nime-2026` | 171 | 160 | 11 | complete |
| `dafx-2026` | 91 | 91 | 0 | complete |
| `aaai-2026` | 4,920 | 147 | 4,773 | complete |
| `aistats-2026` | 588 | 1 | 587 | complete |
| `uai-2026` | 330 | 1 | 329 | complete |
| `cvpr-2026` | 4,030 | 103 | 3,927 | complete |
| `acl-2026` | 4,459 | 199 | 4,260 | complete |
| `eacl-2026` | 799 | 36 | 763 | complete |
| **合计** | **16,046** | **955** | **15,091** | **11/11 complete** |

DAFx、NIME、Odyssey、IWSLT 是核心语音、音频和音乐来源，候选直接交 LLM 判断，不被通用关键词提前截断。955 篇只代表入选的深度分析成员，并不说明导读文章、评分、标签、单篇页或汇总已完成。实际处理须由 `conference:new:process` 的逐篇完成证明、页面文件清单、汇总结果与处理完成凭证核验，处理完成也不能当作已经公开发布。

## 主研究时尚未正式接入的会议

| 会议 | 2026-09-09 的官方状态 | 当时未接入的原因 | 当时提出的方案 |
|---|---|---|---|
| COLM 2026 | accepted-papers 页面已公开，会议为 10 月 6–9 日 | 尚未逐项核对展示页与 OpenReview accepted note 的字段及 venue | 官方 accepted 页面确定成员，forum ID 确定身份，逐项核对并保存快照 |
| KDD 2026 | 多个分轨、两个研究论文录用轮次，OpenReview 列有多个 2026 会议标识 | 单独假设 `KDD.org/2026/Conference` 会漏抓或误收 | 按分轨和轮次登记，逐个会议标识取得录用记录对应的邀请标识，再核对并集 |
| ECCV 2026 | 9 月 8–12 日召开，论文集由 Springer 出版 | 会议进行中，公开录用记录、OpenReview 记录与最终出版稿尚未完成身份核对 | 优先绑定 Springer/ECVA 最终记录，不把投稿 PDF 当最终出版稿 |

### COLM：856 行展示记录没有 forum ID

2026-09-09 经项目 HTTP CONNECT 只读解析 [COLM accepted 页面](https://colm.eventhosts.cc/Conferences/2026/AcceptedPapers)，得到 856 行。每行有标题、作者和可选项目页，没有 OpenReview/forum 链接、稳定论文编号或可绑定身份的 `data-*`。当时精确 `(title, displayed authors)` 元组没有重复，只能证明该快照展示了哪些论文，不能证明每行对应哪个 forum。

官方组 `colmweb.org/COLM/2026/Conference` 的 API 可读，配置如下：

- `submission_id = colmweb.org/COLM/2026/Conference/-/Submission`
- `submission_venue_id = colmweb.org/COLM/2026/Conference/Submission`
- `accept_decision_options = ["Accept"]`
- `decision_heading_map = {"COLM 2026":"Accepted COLM 2026 papers","Submitted to COLM 2026":"Reject"}`
- `submission_revision_accepted = true`

同日匿名 notes API 按 `venueid`、invitation、note `id` 或 `forum` 查询均返回 HTTP 403 `ChallengeRequiredError`，组 API 为 HTTP 200。研究没有解题、绕过挑战或改用浏览器页面抓取。因为无法取得可证明完整的录用记录及对应 forum 集合，也无法证明与 856 行一一对应，当时没有实现 COLM 来源适配器。

当时为后续接入提出五项要求，身份依据不能简化成标题猜测：

1. 保存录用展示页 HTML 的响应凭证和 SHA-256，并记录本次解析成员数。856 是该快照观察，不永久硬编码。
2. 用 OpenReview 官方 API 完整分页，记录总数和分页依据，核对 group、domain、submission invitation 及 accepted venue `COLM 2026`。
3. 以稳定 forum ID 输出身份，核对 note `id` 与 `forum` 的实际含义，`recordUrl` 由 forum 构造；PDF 来自 note 实际 file 字段或已核验 forum PDF 路由，保存响应与文件 SHA。
4. 录用展示页没有共享 ID，不能模糊匹配标题。只有规范化标题、有序作者完全一致且两全集形成双射时才自动核对；标点、姓名或顺序差异进入人工核对表，至少绑定 accepted-row SHA、forum ID、note SHA。
5. 每次证明零重复、零未匹配、零孤立记录，两个集合数量与快照一致；缺任一依据即停止。

### KDD：按八种分轨及录用轮次分别核对

[KDD OpenReview venue 聚合页](https://openreview.net/venue?id=KDD.org) 当时列出 25 个 KDD 2026 venue。正式主会来源不能假设只有 `KDD.org/2026/Conference`，也不能混入研讨会或研讨会提案；当时要求仅接收下列八个已登记组，未知组拒绝。

| 分轨与录用轮次 | 精确 OpenReview 组 ID | 已验证的录用 venue 值 | 关键约束 |
|---|---|---|---|
| Research · Cycle 1 | `KDD.org/2026/Research_Track_August` | `SIGKDD 2026 Research Track` | 第一轮；不能仅凭 venue 名与 Cycle 2 合并 |
| Applied Data Science · Cycle 1 | `KDD.org/2026/ADS_Track_August` | `KDD 2026 ADS Track Cycle 1` | `Submitted ...` 在 heading map 中是 `Resubmit`，不是 reject |
| Datasets & Benchmarks · Cycle 1 | `KDD.org/2026/Datasets_and_Benchmark_Track_August` | `KDD 2026 Datasets and Benchmarks Track Oral`；`KDD 2026 Datasets and Benchmarks Track Poster` | Oral/Poster 都属于 accepted 集合 |
| Research · Cycle 2 | `KDD.org/2026/Research_Track_Cycle_2` | `SIGKDD 2026 Research Track` | 与 Cycle 1 共用 venue 字符串；身份必须核对 group/domain |
| Applied Data Science · Cycle 2 | `KDD.org/2026/ADS_Track_Cycle_2` | **未验证，阻塞** | group 仅给出小写 `accept_decision_options=["accept"]`，`decision_heading_map=null`；禁止根据命名猜 venue 值 |
| Datasets & Benchmarks · Cycle 2 | `KDD.org/2026/Datasets_and_Benchmark_Track_Cycle_2` | `KDD D&B Track 2026` | 与 Cycle 1 分桶取集合 |
| AI for Sciences · Cycle 2 | `KDD.org/2026/AI4Sciences_Track_February` | `KDD 2026 AI4Sciences Track Oral`；`KDD 2026 AI4Sciences Track Poster` | 只纳入 `submission_type="8-page full paper"`；排除 `2-page extended abstract` |
| Blue Sky Ideas · single/special cycle | `KDD.org/2026/Blue_Sky_Ideas_Track` | `SIGKDD 2026 Blue Sky Ideas Track` | 正式论文集分轨，不是研讨会 |

当时八个组的设置均为 `public_submissions=false`。`submission_revision_accepted=true` 只见于 AI for Sciences；Research C1、ADS C1、D&B C1、Research C2、ADS C2、D&B C2 和 Blue Sky 都为 `false`。因此不能把七个组的 `pdf?id=<forum>` 推定为最终出版稿。

AI for Sciences 的过期 submission invitation（`expired=true`）列出 `8-page full paper` 与 `2-page extended abstract`；[官方 CFP](https://kdd2026.kdd.org/ai4sciences-track-call-for-papers/) 说明只有完整论文进入 ACM 论文集。[Blue Sky CFP](https://kdd2026.kdd.org/kdd-2026-blue-sky-ideas-track-call-for-papers/) 说明录用论文进入 KDD 2026 论文集；[workshop proposal 说明](https://kdd2026.kdd.org/call-for-workshop-proposals/) 则说明研讨会论文不归档进 ACM Digital Library，不能混入八组并集。

匿名 notes API 当时同样返回 HTTP 403 `ChallengeRequiredError`。2026-09-09 经项目代理访问 [ACM proceedings `10.1145/3770854`](https://dl.acm.org/doi/proceedings/10.1145/3770854) 及抽样 DOI `10.1145/3770854.3783954` 均为 HTTP 403，尚不能证明 ACM 全集或 forum↔DOI 映射，因此当时没有实现 KDD 来源适配器。

后续接入要求逐组和并集都可核验：

1. 登记八个 group 的 track、cycle、submission invitation 和 accepted venue 集合，拒绝未知 group。ADS Cycle 2 在准确 venue 值取得并核验前保持阻塞。
2. 各组通过官方 API 完整分页并保存数量核对依据，逐 note 核对 group/domain、invitation、accepted venue，再按 forum ID 合并去重。
3. AI for Sciences 只收 `8-page full paper`，保留 Oral/Poster 展示或分轨子类，已录用的 `2-page extended abstract` 也不进入正式论文集合。
4. Cycle 2 resubmission 即使记录 Cycle 1 forum，也不按标题或共用 venue 名折叠身份。输出 Cycle 2 forum，先前 forum 只保存在已保存并核验的来源记录和响应凭证中。
5. 从 ACM 官方论文集完整取得论文记录、DOI 和实际 PDF，保存响应凭证及文件 SHA。OpenReview PDF 只能作为评审来源，录用后修订稿与 ACM 文件字节及 DOI 都精确核对后才可称最终出版稿。
6. forum 与 ACM 论文记录只凭官方共享稳定标识自动对应。无共享 ID 时须人工审核核对表，绑定 forum/note SHA、DOI、ACM 论文记录 SHA；精确题目和作者仅供复核，不能单独当身份，也不模糊匹配。
7. 各组及八组并集证明零未匹配、零孤立记录、零重复；`track` 至少含 track 和 cycle，如 `Research · Cycle 1`，完整来源记录保存在响应凭证中。

## 研究日等待公开的来源与后来增补

2026-09-09 主研究把以下来源列为后续跟进对象，不能将当时的“尚未召开”当成今天状态。

- INTERSPEECH 2026 当时等待最终论文集；后续接入见下段。
- EMNLP 2026 日期为 10 月 24–29 日，录用通知及最终稿提交均已完成，但 ACL Anthology 最终会议索引尚不能保存并核验；当时计划复用 ACL/EACL 来源适配器。
- ISMIR 2026 日期为 11 月 8–12 日，最终稿提交已完成，学会历年论文集还没有 2026 条目。
- ACM Multimedia 2026 日期为 11 月 10–14 日，正式论文集未公开。ACM 自 2026 年转向开放获取，有利于后续下载，但仍须等待最终记录。
- NeurIPS 2026 尚未到作者录用通知或最终论文集阶段，投稿记录及 OpenReview 状态不能作为正式会议论文依据。
- DCASE 2026 挑战赛技术报告可获取，但官方明确未经过同行评议，若接入须作为 `technical-report` 独立来源，与 DCASE Workshop 分开。

### 2026-09-25：Interspeech 来源已经接入

后续记录确认 ISCA Archive 的 `interspeech_2026` 索引上线，实测 HTTP 200，含 1379 个 `*_interspeech.html` 记录页。会议在悉尼，09-27~10-01，DOI 为 `10.21437/Interspeech.2026`。`interspeech-2026` 来源适配器沿用 Odyssey/ISCA 的 `parseIsca`，排除主旨演讲摘要页。

这次增补使 Interspeech 不再属于当时的等待接入清单，但没有重算主研究的 11 来源、16,046 候选和 955 入选总表，也没有在此报告证明新增来源的下载、深度分析或发布终态。

## 当时的提取能力与发布授权

主研究使用的会议 PDF 提取结构能力标为 `weak`。可核验全文仍进入共享多阶段分析、评分和导读文章生成流程；缺 HTML DOM、原始 TeX 或实际像素时，表格单元格、展示公式和图像细节须显式不可得，不能猜测或改用简化分析。

这一描述属于当时提取方式。当前会议流程另有逐页像素、图片及表格候选核验，不能因 PDF 来源就统一说图表不可得；候选表格不等于可信 DOM 单元格。缺少原始 TeX 时，保留公式候选和页面证据，不能将它们当作已通过来源核验的展示公式。现行细则见[会议图表与公式说明](../../conference-workflow.md#pdf-中能核验的图表和公式)。

主研究当时只获抓取、整理和适配授权，没有获得生成、审查或推送博客的授权。来源获取、发现记录核验或后处理暂存完成不等于公开发布，也不授权今天发布。

## 当时提出的接入优先级

研究优先要求 KDD 的八组 OpenReview 与 ACM 双来源核对，以及 COLM accepted 页和 forum 集合核对。ECCV、INTERSPEECH、EMNLP、ISMIR、ACM MM 当时计划等最终论文集上线再适配，不提前抓投稿版本；其中 INTERSPEECH 后来已按 2026-09-25 记录接入。DCASE 技术报告与研讨会的同行评议论文另建来源和文档类型。

## 结论与官方来源对照

表中“当前”“已公开”“尚未召开”和 HTTP 状态均为研究时观察；Interspeech 行保留 9 月 9 日的日期依据，9 月 25 日更新另见前节。

| 主张 | 官方来源 | 研究时访问说明 |
|---|---|---|
| Odyssey 2026 论文及 PDF | [ISCA Archive — Odyssey 2026](https://www.isca-archive.org/odyssey_2026/index.html) | 官方单篇记录/PDF；页面混有主旨演讲，适配器明确排除 |
| IWSLT 2026 论文集合 | [ACL Anthology — IWSLT 2026](https://aclanthology.org/events/iwslt-2026/) | 官方会议索引及分卷；`.0` 为卷首而非单篇论文 |
| EUSIPCO 2026 论文集合 | [EURASIP — EUSIPCO 2026 session index](https://eurasip.org/Proceedings/Eusipco/Eusipco2026/HTML/session-index/index.html) | 官方分会场索引与逐篇 PDF |
| NIME 2026 论文集合 | [NIME papers](https://nime.org/papers/) | 官方历年论文入口与 2026 PDF |
| DAFx 2026 议程与 PDF | [DAFx 2026 Program](https://dafx26.mit.edu/program/) | 官方议程提供逐篇 PDF 和全部论文的 ZIP 包 |
| AISTATS 2026 | [PMLR volume 300](https://proceedings.mlr.press/v300/) | 官方开放获取的逐篇论文集记录 |
| UAI 2026 | [PMLR volume 337](https://proceedings.mlr.press/v337/) | 官方开放获取的逐篇论文集记录 |
| CVPR 2026 | [CVF Open Access — CVPR 2026](https://openaccess.thecvf.com/CVPR2026?day=all) | 官方主会单篇记录/PDF |
| ACL 2026 | [ACL Anthology — ACL 2026](https://aclanthology.org/events/acl-2026/) | 官方会议索引；本仓库只纳入 long/short/findings |
| EACL 2026 | [ACL Anthology — EACL 2026](https://aclanthology.org/events/eacl-2026/) | 官方会议索引；本仓库只纳入 long/short/findings |
| AAAI 2026 全集 | [AAAI-40 proceedings index](https://aaai.org/proceeding/aaai-40-2026/)；[AAAI OJS archive](https://ojs.aaai.org/index.php/AAAI/issue/archive) | 官方第 40 卷的 48 个分册；OJS 分册编号并不连续，不能只抓当前分册 |
| COLM 录用论文已公开 | [COLM 2026 Accepted Papers](https://colm.eventhosts.cc/Conferences/2026/AcceptedPapers)；[COLM OpenReview group](https://openreview.net/group?id=colmweb.org%2FCOLM%2F2026%2FConference)；[OpenReview notes 获取规范](https://docs.openreview.net/how-to-guides/data-retrieval-and-modification/how-to-get-all-notes-for-submissions-reviews-rebuttals-etc) | 录用展示页当时有 856 行但无 forum ID；组信息可读，匿名 notes API 当时被访问挑战阻断 |
| KDD 有多个分轨和轮次 | [KDD 2026 Research Track CFP](https://kdd2026.kdd.org/research-track-call-for-papers/)；[Datasets & Benchmarks CFP](https://kdd2026.kdd.org/datasets-and-benchmarks-track-call-for-papers/)；[AI4Sciences CFP](https://kdd2026.kdd.org/ai4sciences-track-call-for-papers/)；[Blue Sky CFP](https://kdd2026.kdd.org/kdd-2026-blue-sky-ideas-track-call-for-papers/)；[KDD OpenReview venues](https://openreview.net/venue?id=KDD.org)；[ACM proceedings](https://dl.acm.org/doi/proceedings/10.1145/3770854) | 八个正式组必须逐组登记；notes 与 ACM 页面当时均受 403 阻塞，尚不能证明完整 forum↔DOI/PDF 对应关系 |
| ECCV 2026 状态 | [ECVA — ECCV 2026](https://eccv.ecva.net/) | 官方日期与 Springer 论文集说明 |
| INTERSPEECH 尚未召开 | [ISCA upcoming Interspeech](https://www.isca-speech.org/Upcoming-Interspeech) | 官方日期与地点 |
| EMNLP 尚未召开 | [EMNLP 2026 program](https://2026.emnlp.org/program/) | 官方日期与会议结构 |
| ISMIR 尚未召开 | [ISMIR 2026](https://ismir2026.ismir.net/) | 官方日期、录用通知与最终稿提交时间 |
| ACM Multimedia 尚未召开 | [ACM Multimedia 2026](https://www.acmmm.org/2026/) | 官方日期与领域范围 |
| DCASE 报告未经同行评审 | [DCASE 2026 submission](https://dcase.community/challenge2026/submission) | 官方对技术报告与研讨会论文的性质区分 |
