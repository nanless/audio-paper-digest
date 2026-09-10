# 2026 新会议论文来源研究与接入记录

- 研究日期：2026-09-09（Asia/Shanghai）
- 面向对象：本仓库维护者与后续执行会议论文速递的 Agent
- 范围：排除仓库已经整理的 ICASSP、ICLR、ICML；调查截至研究日已经公开、即将公开或值得监控的国际 AI、语音、音频和音乐会议。
- 口径：优先会议或出版组织的官方 proceedings；“顶级/次顶级”没有统一官方排名，本文只作领域影响力与仓库相关性的工程分层，不把它写入论文事实。

## 直接结论

本轮已经把十一个 2026 官方来源接进可恢复 acquisition：Odyssey、IWSLT、EUSIPCO、NIME、DAFx、AAAI、AISTATS、UAI、CVPR、ACL、EACL，并实际下载、校验和发现闭合 16,046 篇论文。它们输出统一九字段 metadata，逐篇 PDF 与响应 receipt/SHA-256 绑定，再通过 `official-proceedings` discovery 精确绑定官方 paper ID 和本地文件。

会议论文进入分析后不使用简化模板：复用日更的 `analysis-engine.js`、13 个 canonical 一级标题、类型感知八维评分、`beginner-researcher-v3`、`api-reader-source-bindings-v4` 和 current taxonomy。单篇页与汇总页只接受当前 taxonomy 的 active 中文首选标签，并带 taxonomy compat、主任务与主方法；旧标签和会议自造标签不能进入新页面。

## 已实现且官方全文可获取

| Provider | 领域与定位 | 官方单篇数 | 纳入边界 | 当前归档状态 |
|---|---|---:|---|---|
| `odyssey-2026` | 说话人/语言识别专题会议 | 52 | 排除 4 个无 proceedings PDF 的 keynote 摘要页 | PDF、receipt、SHA、discovery 已闭合 |
| `iwslt-2026` | 机器翻译/语音翻译专题会议 | 39 | 官方 event 显示 40 项；排除卷首 `.0`，保留 39 篇单篇论文 | PDF、receipt、SHA、discovery 已闭合 |
| `eusipco-2026` | 信号处理重要综合会议，含语音/音频 | 567 | 官方 session index 的逐篇 PDF | PDF、receipt、SHA、discovery 已闭合 |
| `nime-2026` | 新型音乐表达界面核心会议 | 171 | 官方 2026 proceedings 的逐篇 PDF | PDF、receipt、SHA、discovery 已闭合 |
| `dafx-2026` | 数字音频效果核心专题会议 | 91 | 72 个 regular/challenge PDF，加 19 个官方 demo PDF；demo 保留独立 track | PDF、receipt、SHA、discovery 已闭合 |
| `aaai-2026` | 综合人工智能顶级会议 | 4,920 | 官方 OJS volume 40 的固定 48 个分册；逐分册封存并证明跨分册 article ID 唯一 | PDF、receipt、SHA、discovery 已闭合 |
| `aistats-2026` | 统计机器学习重要会议 | 588 | PMLR v300 单篇记录；排除整卷和 frontmatter | PDF、receipt、SHA、discovery 已闭合 |
| `uai-2026` | 不确定性推理重要会议 | 330 | PMLR v337 单篇记录；排除整卷和 frontmatter | PDF、receipt、SHA、discovery 已闭合 |
| `cvpr-2026` | 计算机视觉顶级会议 | 4,030 | CVF main conference；不混入 workshop | PDF、receipt、SHA、discovery 已闭合 |
| `acl-2026` | NLP 顶级会议 | 4,459 | 仅 long、short、findings；排除 demo、SRW、industry、tutorial、workshop 与卷首 | PDF、receipt、SHA、discovery 已闭合 |
| `eacl-2026` | NLP 重要区域旗舰会议 | 799 | 仅 long、short、findings；边界同 ACL | PDF、receipt、SHA、discovery 已闭合 |

所有归档固定在 `data/runtime/official-conference-acquisitions/<provider>/`；本次 16,046 篇 PDF、metadata 和收据合计约 65 GiB。发现快照固定在 `data/runtime/conference-discovery-catalogs/` 和 `data/runtime/conference-discovery-reports/`。运行数据被 Git 忽略，不污染 `data/current/`。

## 已完成的日更同源筛选

16,046 篇官方论文已经全部经过会议筛选 v5。筛选先重放 discovery 的唯一 exact PDF，离线提取前两页并定位可验证的摘要证据，再使用与每日论文速递相同的关键词预筛、筛选 Prompt、公共 LLM 路由和严格 JSON 决定；每篇决定都绑定 intent、原始响应、usage ledger、来源 SHA 和 taxonomy registry。11 个筛选状态均为 `complete`，没有 `pending` 或 `failed`，最终入选 955 篇、排除 15,091 篇。

| Provider | 官方候选 | 入选 | 排除 | 筛选状态 |
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

DAFx、NIME、Odyssey、IWSLT 是仓库核心语音/音频/音乐来源，候选会直接进入 LLM 判断，不能被通用关键词过早截断。这里的 955 篇只是正式深度理解成员集合，不代表 Reader、评分、标签、单篇页或会议汇总已经完成；这些终态必须由统一 `conference:new:process` 的逐篇分析证明、页面 manifest、aggregate 和 process completion receipt 闭合后才能确认。

## 值得接入，但不能用通用单页适配冒充完整

| 会议 | 截至研究日的官方状态 | 尚未正式接入的原因 | 正确后续方案 |
|---|---|---|---|
| COLM 2026 | 官方 accepted-papers 页面已公开，会议为 10 月 6–9 日 | 展示页与 OpenReview accepted note 的精确字段/venue 绑定尚未逐条验证 | 以官方 accepted 页面为成员集合，以 forum ID 为身份，逐项交叉封存 |
| KDD 2026 | 官方明确有多个 track、两个 research cycle；OpenReview venue 页列出多组 2026 venue | `KDD.org/2026/Conference` 单 venue 假设会漏抓并可能误收 | 建立 track×cycle 注册表，逐 venue 收集 accepted invitations，再做并集闭合 |
| ECCV 2026 | 9 月 8–12 日召开，官方说明 proceedings 由 Springer 出版 | 会议进行中；公开 accepted/OpenReview 与最终 Springer camera-ready 的身份闭合尚未完成 | 等最终 proceedings 后优先以 Springer/ECVA 记录绑定，不把投稿 PDF当 camera-ready |

### COLM 2026：accepted 页面与 OpenReview 仍未闭合

2026-09-09 经项目 HTTP CONNECT 对 [COLM 官方 accepted 页面](https://colm.eventhosts.cc/Conferences/2026/AcceptedPapers)做只读解析，得到 856 行。每行公开标题、作者和可选 project page，但没有 OpenReview/forum 链接、稳定 paper ID 或可用于身份绑定的 `data-*` 字段；当前页面的精确 `(title, displayed authors)` 元组没有重复。这只能证明官方展示页的当前成员集合，不能证明任一行对应哪个 OpenReview forum。

OpenReview 官方 group 为 `colmweb.org/COLM/2026/Conference`。group API 可读，并给出以下配置：

- `submission_id = colmweb.org/COLM/2026/Conference/-/Submission`
- `submission_venue_id = colmweb.org/COLM/2026/Conference/Submission`
- `accept_decision_options = ["Accept"]`
- `decision_heading_map = {"COLM 2026":"Accepted COLM 2026 papers","Submitted to COLM 2026":"Reject"}`
- `submission_revision_accepted = true`

但同日所有匿名 notes API 查询——包括按 `venueid`、invitation、note `id` 或 `forum` 过滤——都返回 HTTP 403 `ChallengeRequiredError`；group API 则为 HTTP 200。这里不得解题、绕过挑战或退化成浏览器页面抓取。因为尚不能取得可证明完整的 accepted notes/forum 集合，也不能验证 856 行与 forum 的一一对应关系，所以本轮明确不实现 COLM provider。

未来接入必须满足以下闭合合同：

1. 封存 accepted HTML 的逐响应 receipt 与 SHA-256，并把当次解析的成员数写入 receipt；856 是本次快照观测值，不能永久硬编码。
2. 仅通过 OpenReview 官方 API 取得完整分页 notes，记录总数/分页证明，并精确验证 group、domain、submission invitation 和 accepted venue `COLM 2026`。
3. 输出身份使用稳定 forum ID；验证 note `id`/`forum` 的实际语义，`recordUrl` 只由该 forum 构造。PDF 只接受 note 实际 file 字段或已验证的该 forum PDF 路由，并继续封存响应与文件 SHA。
4. accepted 页面没有共享 ID，因此不得模糊标题匹配。只有规范化标题与有序作者完全一致且全集形成双射时才能自动闭合；任何标点、姓名或顺序差异都必须进入人工审核 crosswalk。crosswalk 至少绑定 accepted-row SHA、forum ID 和 note SHA，不能靠标题猜测身份。
5. 每次运行必须证明零重复、零 unmatched、零 orphan，且两个来源的集合基数与快照一致；任一证明缺失即失败关闭。

### KDD 2026：必须注册八个 track×cycle 桶

[KDD OpenReview venue 聚合页](https://openreview.net/venue?id=KDD.org)当前列出 25 个 KDD 2026 venue。正式主会 provider 不能对 `KDD.org/2026/Conference` 做单 venue 假设，也不能把 workshop/proposal 混入；应只接受下表八个已登记 group，未知 group 一律拒绝。

| Track × cycle | 精确 OpenReview group ID | 已验证 accepted venue 值 | 关键约束 |
|---|---|---|---|
| Research · Cycle 1 | `KDD.org/2026/Research_Track_August` | `SIGKDD 2026 Research Track` | 第一轮；不能仅凭 venue 名与 Cycle 2 合并 |
| Applied Data Science · Cycle 1 | `KDD.org/2026/ADS_Track_August` | `KDD 2026 ADS Track Cycle 1` | `Submitted ...` 在 heading map 中是 `Resubmit`，不是 reject |
| Datasets & Benchmarks · Cycle 1 | `KDD.org/2026/Datasets_and_Benchmark_Track_August` | `KDD 2026 Datasets and Benchmarks Track Oral`；`KDD 2026 Datasets and Benchmarks Track Poster` | Oral/Poster 都属于 accepted 集合 |
| Research · Cycle 2 | `KDD.org/2026/Research_Track_Cycle_2` | `SIGKDD 2026 Research Track` | 与 Cycle 1 共用 venue 字符串；身份必须由 group/domain 闭合 |
| Applied Data Science · Cycle 2 | `KDD.org/2026/ADS_Track_Cycle_2` | **未验证，阻塞** | group 仅给出小写 `accept_decision_options=["accept"]`，`decision_heading_map=null`；禁止根据命名猜 venue 值 |
| Datasets & Benchmarks · Cycle 2 | `KDD.org/2026/Datasets_and_Benchmark_Track_Cycle_2` | `KDD D&B Track 2026` | 与 Cycle 1 分桶取集合 |
| AI for Sciences · Cycle 2 | `KDD.org/2026/AI4Sciences_Track_February` | `KDD 2026 AI4Sciences Track Oral`；`KDD 2026 AI4Sciences Track Poster` | 只纳入 `submission_type="8-page full paper"`；排除 `2-page extended abstract` |
| Blue Sky Ideas · single/special cycle | `KDD.org/2026/Blue_Sky_Ideas_Track` | `SIGKDD 2026 Blue Sky Ideas Track` | 正式 proceedings track，不是 workshop |

八个 group 当前均为 `public_submissions=false`。`submission_revision_accepted=true` 只出现在 AI for Sciences；Research C1、ADS C1、D&B C1、Research C2、ADS C2、D&B C2 和 Blue Sky 均为 `false`。因此不能把七个桶的 OpenReview `pdf?id=<forum>` 推定为 camera-ready。AI for Sciences 的过期 submission invitation（以 `expired=true` 读取）明确给出 `submission_type` 枚举 `8-page full paper` 与 `2-page extended abstract`；[官方 CFP](https://kdd2026.kdd.org/ai4sciences-track-call-for-papers/)明确只有 full paper 进入 ACM proceedings。Blue Sky 的[官方 CFP](https://kdd2026.kdd.org/kdd-2026-blue-sky-ideas-track-call-for-papers/)明确 accepted paper 进入 KDD 2026 proceedings；[workshop proposal 说明](https://kdd2026.kdd.org/call-for-workshop-proposals/)则明确 workshop 不归档进 ACM Digital Library，因而其余 workshop/proposal venues 不属于这八桶并集。

与 COLM 相同，匿名 OpenReview notes API 当前返回 HTTP 403 `ChallengeRequiredError`。正式出版侧，[ACM proceedings `10.1145/3770854`](https://dl.acm.org/doi/proceedings/10.1145/3770854)及抽样 DOI 记录 `10.1145/3770854.3783954` 在 2026-09-09 经项目代理均返回 HTTP 403，尚不能证明 ACM 全集或 forum↔DOI 映射。因此本轮也不实现 KDD provider。

未来 KDD 接入必须满足以下闭合合同：

1. 注册表精确固定上述八个 group 的 track、cycle、submission invitation 与 accepted venue 集合；拒绝未知 KDD group。ADS Cycle 2 在取得并封存准确 accepted venue 值前保持阻塞。
2. 每桶通过官方 API 完整分页，记录 count proof；逐 note 验证 group/domain、invitation、accepted venue，再对八桶 forum ID 做并集去重。
3. AI for Sciences 只接受精确的 `8-page full paper`，将 Oral/Poster 保留为展示/track 子类；`2-page extended abstract` 即使 accepted 也不得进入正式论文集合。
4. Cycle 2 resubmission 即使记录了 Cycle 1 forum，也不能按标题或共用 venue 名折叠身份；正式输出 ID 使用 Cycle 2 forum，先前 forum 只进入 sealed provenance/receipt。
5. 从 ACM 官方 proceedings 完整枚举 record、DOI 与实际 PDF，并为响应和 PDF 签 receipt/SHA。OpenReview PDF 可作为评审来源证据，但除非 accepted revision 与 ACM bytes/DOI 均精确证明，不得声称它是 camera-ready。
6. forum↔ACM record 只凭官方共享稳定标识自动连接。若官方没有共享 ID，必须使用人工审核 crosswalk，绑定 forum/note SHA、DOI 与 ACM record SHA；精确标题+作者只能作门禁复核，不能单独充当身份，更不能 fuzzy match。
7. 每桶及八桶并集都必须证明零 unmatched、零 orphan、零 duplicate；输出 `track` 至少编码 track 与 cycle（例如 `Research · Cycle 1`），完整 provenance 保存在 receipt。

## 应监控、但截至研究日尚不能下载最终 proceedings 全集

- INTERSPEECH 2026：ISCA 官方日期为 9 月 28 日至 10 月 1 日；ISCA Archive 当前年份入口尚未出现 2026，等正式归档后复用 Odyssey/ISCA 类 provider。
- EMNLP 2026：官方会议日期为 10 月 24–29 日；通知与 camera-ready 已发生，但 ACL Anthology 最终 event 尚未到可封存状态，届时复用 ACL/EACL provider。
- ISMIR 2026：官方日期为 11 月 8–12 日；camera-ready 已完成，但 society 的 past-conference proceedings 还没有 2026 条目。
- ACM Multimedia 2026：官方日期为 11 月 10–14 日；正式 proceedings 尚未公开。ACM 自 2026 年转向开放获取有利于后续下载，但仍须等待最终论文记录。
- NeurIPS 2026：截至研究日仍未到 author notification/final proceedings 阶段，不能把 submission/OpenReview 状态当作正式会议论文。
- DCASE 2026：challenge technical reports 可公开获取，但官方明确它们不是 peer-reviewed；若接入，应作为 `technical-report` 独立来源，不与 DCASE Workshop 同一论文集合。

## 内容能力与已知限制

会议 PDF 是可校验全文，但当前 extraction 的结构能力标为 `weak`。正文可以进入与日更相同的多阶段深度理解、评分和 Reader；如果没有 HTML DOM、原始 TeX 或像素证据，表格单元格、展示公式和 Figure 细节必须显式不可得，不能猜测。这是来源证据能力差异，不是降低分析模板或改用旧标签的理由。

本轮只授权抓取、整理和适配，没有授权博客 generate/review/push。因此 acquisition、discovery 和 postprocess staging 的完成不等于公开发布。

## 后续执行优先级

1. 为 KDD 完成八个 track×cycle OpenReview 桶和 ACM proceedings 的双来源闭合；为 COLM 完成 accepted-page ↔ forum 双来源闭合。
2. ECCV、INTERSPEECH、EMNLP、ISMIR、ACM MM 在官方 proceedings 上线后触发适配，不提前抓投稿版本。
3. DCASE technical reports 与 workshop peer-reviewed papers 分开建 provider 和文档类型。

## Claim-to-source ledger

| 主张 | 官方来源 | 访问说明 |
|---|---|---|
| Odyssey 2026 论文及 PDF | [ISCA Archive — Odyssey 2026](https://www.isca-archive.org/odyssey_2026/index.html) | 官方单篇记录/PDF；页面混有 keynote，适配器明确排除 |
| IWSLT 2026 论文集合 | [ACL Anthology — IWSLT 2026](https://aclanthology.org/events/iwslt-2026/) | 官方 event/volume；`.0` 为卷首而非单篇论文 |
| EUSIPCO 2026 论文集合 | [EURASIP — EUSIPCO 2026 session index](https://eurasip.org/Proceedings/Eusipco/Eusipco2026/HTML/session-index/index.html) | 官方 session index 与逐篇 PDF |
| NIME 2026 论文集合 | [NIME papers](https://nime.org/papers/) | 官方历年论文入口与 2026 PDF |
| DAFx 2026 program 与 PDF | [DAFx 2026 Program](https://dafx26.mit.edu/program/) | 官方 program 提供逐篇 PDF 和 all-papers ZIP |
| AISTATS 2026 | [PMLR volume 300](https://proceedings.mlr.press/v300/) | 官方 open-access 单篇 proceedings |
| UAI 2026 | [PMLR volume 337](https://proceedings.mlr.press/v337/) | 官方 open-access 单篇 proceedings |
| CVPR 2026 | [CVF Open Access — CVPR 2026](https://openaccess.thecvf.com/CVPR2026?day=all) | 官方 main conference 单篇记录/PDF |
| ACL 2026 | [ACL Anthology — ACL 2026](https://aclanthology.org/events/acl-2026/) | 官方 event；本仓库只纳入 long/short/findings |
| EACL 2026 | [ACL Anthology — EACL 2026](https://aclanthology.org/events/eacl-2026/) | 官方 event；本仓库只纳入 long/short/findings |
| AAAI 2026 全集 | [AAAI-40 proceedings index](https://aaai.org/proceeding/aaai-40-2026/)；[AAAI OJS archive](https://ojs.aaai.org/index.php/AAAI/issue/archive) | 官方 volume 40 的 48 个分册；OJS issue ID 并不连续，不能只抓 current issue |
| COLM accepted papers 已公开 | [COLM 2026 Accepted Papers](https://colm.eventhosts.cc/Conferences/2026/AcceptedPapers)；[COLM OpenReview group](https://openreview.net/group?id=colmweb.org%2FCOLM%2F2026%2FConference)；[OpenReview notes 获取规范](https://docs.openreview.net/how-to-guides/data-retrieval-and-modification/how-to-get-all-notes-for-submissions-reviews-rebuttals-etc) | accepted 页当前 856 行但无 forum ID；group 可读，匿名 notes API 当前被 challenge 阻塞 |
| KDD 是多 track/多 cycle | [KDD 2026 Research Track CFP](https://kdd2026.kdd.org/research-track-call-for-papers/)；[Datasets & Benchmarks CFP](https://kdd2026.kdd.org/datasets-and-benchmarks-track-call-for-papers/)；[AI4Sciences CFP](https://kdd2026.kdd.org/ai4sciences-track-call-for-papers/)；[Blue Sky CFP](https://kdd2026.kdd.org/kdd-2026-blue-sky-ideas-track-call-for-papers/)；[KDD OpenReview venues](https://openreview.net/venue?id=KDD.org)；[ACM proceedings](https://dl.acm.org/doi/proceedings/10.1145/3770854) | 八个正式 group 必须逐桶注册；notes 与 ACM 页面当前均受 403 阻塞，不能签发完整 forum↔DOI/PDF 闭合 |
| ECCV 2026 状态 | [ECVA — ECCV 2026](https://eccv.ecva.net/) | 官方日期与 Springer proceedings 说明 |
| INTERSPEECH 尚未召开 | [ISCA upcoming Interspeech](https://www.isca-speech.org/Upcoming-Interspeech) | 官方日期与地点 |
| EMNLP 尚未召开 | [EMNLP 2026 program](https://2026.emnlp.org/program/) | 官方日期与会议结构 |
| ISMIR 尚未召开 | [ISMIR 2026](https://ismir2026.ismir.net/) | 官方日期、notification 与 camera-ready 时间 |
| ACM Multimedia 尚未召开 | [ACM Multimedia 2026](https://www.acmmm.org/2026/) | 官方日期与领域范围 |
| DCASE reports 非同行评审 | [DCASE 2026 submission](https://dcase.community/challenge2026/submission) | 官方对 technical report 与 workshop paper 的性质区分 |
