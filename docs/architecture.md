# 默认 LLM/API 架构

本页说明默认日更中各组件读取和写入什么、单篇分析如何恢复，以及博客发布如何核验文件与 Git 状态。操作命令见 [scripts.md](scripts.md)，保存字段见 [data-format.md](data-format.md)；只有明确选择人工流程时才进入 [Manual 子系统](../manual/README.md)。

## 组件与责任

```text
run-daily-digest.sh
  ├─ full-fetch.js
  │    ├─ fetch-papers.js / fetch-huggingface-papers.js
  │    ├─ LLM 筛选
  │    ├─ daily-fresh-source-plan.js → 封存官方文本与 PDF
  │    └─ analysis-engine.js → deep-analyzer.js
  ├─ generate-blog.py → 生成页面
  ├─ review-blog.py → 确定性检查、LLM/图片审查与 Hugo 检查
  ├─ push-blog.py → 提交精确改动、推送并核验远端 OID
  └─ 视觉规划 → Codex image_gen → 目检、登记与状态检查
```

Node 负责抓取、筛选、日更来源封存、单篇分析、检查点和图片任务。Python 负责页面生成、只读审查、Hugo 检查和 Git 发布。博客仓库是发布目标，不能作为分析事实来源；尚未提交的页面也不能改变筛选时的去重基线。

Node 与 Python 共用 `data/runtime/llm-account-pool.json`，保存 OpenCode Go 账号选择和冷却状态。这些请求状态不进入论文、提示词或发布内容的指纹。文件没有原始密钥，但凭据指纹仍属敏感信息，须使用 `0600` 权限。

项目脚本只准备、核验和登记视觉输入与结果。正式图片只能由 Codex 内置生图工具生成。

## 单篇自动分析 DAG

```text
封存论文来源
  → 主分析
  → 开源与 Demo 证据
  → 审校及表格、方法、结构修复
  → 分类与核心摘要核验
  → 评分审计
  → API Reader 长文与官方论文图
  → 可选旧版图片补充
```

默认 API 在 LLM 筛选后、分析前，为每个入选 arXiv ID 重新获取官方 HTML 文本和 PDF，以原子写入保存 `daily-fresh-source-run-v1` 的四份来源文件。分析、Reader 和 Python 发布都重新核验 `dailyFreshSourceRun` 指定的文件。来源缺失或 SHA 不符时，在模型或图片请求前停止。来源获取序号 `generation` 表示一组封存文件，与论文修订号 `vN` 不同；引用的论文版本须按实际封存记录核验。

官方论文图的像素只为当前调用在系统临时目录中准备，不能写入 `data/current` 或运行目录的图片缓存。单张图片超过上限时可以跳过；服务明确拒绝损坏或不兼容的 PNG 时，可以转为白底 RGB JPEG 重试。最终证据记录实际送入模型的像素 SHA。

每个阶段保存输入指纹、模型与协议、提示词 SHA、证据预算、输出 SHA 和最终状态。输入变化只使受影响阶段及其下游失效。同篇论文由规范化 arXiv ID 锁保护；合并结果前必须在锁内重读正式分析记录，不能用锁外的旧对象覆盖它。

模型输出受到 token 数、耗时和响应字节数的限制，Node 分析还检查流式响应是否正常结束。Node 和 Python 都先检查响应终态，再接受正文：Responses 的 `incomplete/failed/cancelled`、Chat 的 `length` 和 Anthropic 的 `max_tokens` 都不能算成功，即使正文恰好是完整 JSON。Python 只对原本没有正文、且输出预算耗在隐藏推理上的响应保留有次数限制的恢复；被拒绝的非空正文不符合该条件。

Node 的 `analyzeBatch` 遇到认证或账号池不可用等运行级错误时停止领取新论文。已经开始的论文仍保存结果，尚未开始的论文保持待处理；最终保存后批量入口报告失败。普通单篇错误只结束该篇尝试。Python 页面审查会预先提交线程任务再收集结果，不能把 Node 的停派行为推广到它。

API Reader 从封存原文、结构化证据、已核验资源和本次准备的论文图写作，不把评分后的分析正文当成事实来源。旧的 13 节分析仍供程序解析；Reader 在评分后执行，不代表评分结果是其写作输入。

Reader 的各协议分别检查不同对象：

| 协议 | 检查范围 |
|---|---|
| `beginner-researcher-v3` | 读者文章的结构与篇幅 |
| `api-reader-source-bindings-v4` | 表格逐格对应原表或逐字引文，展示公式来自结构化原始 TeX |
| `api-reader-author-identity-v1` | 作者与机构对应 HTML、论文元数据或明确不可得状态 |
| `api-reader-resource-identity-v1` | 资源的原文/Demo 证据、重定向终点与可达状态 |

结构化证据按稳定键序计算 SHA。旧结构化文件须核验来源清单、原始全文 SHA、解析器版本和布局。受限的 v1 无布局来源包括 `fresh_arxiv_text_without_layout`、`direct_conference_pdf_text`，以及能力为 `weak-text-only-v1` 的 `conference_pdf_weak_text`，其表、公式和图三个数组必须全空。识别出的旧键序文件仍受来源清单和原始全文 SHA 约束，但旧 `payloadSha256` 不必等于按当前稳定键序重算的值；程序只在内存中计算稳定指纹，不改封存文件。这个兼容例外不允许使用伪造的结构化内容。

阶段复用仍受实现 SHA 约束。当前 Reader 检查包含整个 `deep-analyzer.js` 的 SHA，因此修改其中与 Reader 无关的代码也可能要求重做；不能只凭评分结果未改就认定 Reader 可复用。

## 博客事务时序

```text
正式批次输入
  → generation manifest v3 与精确页面字节
  → 不可变逐页审查文件
  → 确定性、LLM 与图片审查
  → 隔离 Hugo 检查
  → 对应页面 SHA 和 Git 基线的 review receipt
  → 精确提交 → 推送 → 现场核验远端 main OID
  → 发布后视觉任务
```

审查不修改已审页面。修正须回到生成或分析阶段；推送只接受 receipt 列出的精确增删改集合。Git hook 改动、额外暂存文件、基线不符或远端身份变化都会阻断推送。

逐页通过记录永久按“相对路径 + 页面内容 SHA”复用，只有页面内容 SHA 变化才重审。发布器实现变化仍会重新渲染，以发现真实字节变化；清单、模型、代码、协议或 Hugo 变化须重跑当前批次检查并生成新的 receipt，不能使未变页面重审。分析阶段的实现 SHA 与这项页面缓存规则各自适用，不能混用。

远端 OID 只证明 Git 提交已到远端。完成前还须人工确认对应发布提交，或保留本批已审页面字节的后续提交，已经成功 build/deploy；逐页核验目标日期汇总和论文页的 HTTP 200、正式地址与标题，并保留记录。`digest:status` 尚未自动执行这些上线检查。

## 数据所有权

| 位置 | 保存内容 |
|---|---|
| `data/current/` | 当前批次正式状态和可恢复检查点 |
| `data/archive/<date>/` | 已结束日期快照和最终视觉资产 |
| `data/runtime/daily-fresh-source-runs/` | 日更分析及发布重新核验的官方文本、PDF、来源元数据与清单 |
| `data/runtime/fetched-arxiv-sources/` | 历史 arXiv 重写每次重新获取并封存的四份来源文件 |
| Hugo 博客仓库 | 已生成页面、静态资产和已核验发布提交 |
| `logs/` | 脱敏日志，受年龄和容量保留策略约束 |

文件存在不代表完成。消费者须核验日期、论文集合、状态、输入指纹和 SHA。历史快照只有通过跨文件检查才可用于恢复，不能掩盖当前批次故障。

## 锁表

| 锁 | 保护对象 | 恢复要求 |
|---|---|---|
| full-fetch run lock | 归档、抓取、筛选和批次初始化 | 活着的持有者不得删除，退出后按持有者与租约规则回收 |
| paper analysis lock | 单篇检查点与正式分析合并 | 等待已有任务；锁内重读，禁止旧对象覆盖 |
| JSON file lock | `papers.json`、deep、manifest 等共享文件 | 同步读改写并递增 generation |
| LLM account pool lock | 跨日期账号选择与冷却状态 | 选择账号或确认额度时短暂持锁，HTTP 请求始终在锁外 |
| blog repository/date lock | 页面生成、审查、Git index、commit 与 push | 检查持有者与子进程，不得直接删除活锁 |

等待锁时，程序会核对锁持有者的 owner PID、hostname、heartbeat 以及父子进程关系。只有实现确认租约与持有者符合失效条件时才可回收，不能只因命令慢就删锁。

## 设计边界

- API 网络失败不会自动切换 Manual。
- Muse、arXiv、HuggingFace 和论文资产分别遵守项目代理规则；普通 LLM 不自动继承该代理。
- OpenCode Go 只在明确 HTTP 429 `GoUsageLimitError` 或同一路由 HTTP 401 `Insufficient balance` 时向后切账号。普通认证 401 停止运行，普通 429、5xx 和网络故障不切号；成功账号持续使用，旧账号冷却到期不自动切回。附认证前核对实际 URL 与 endpoint/model 推导结果精确相同，不同服务不得共享主账号池。
- 分析 SHA 核验字节一致性；来源检查核验表格、公式或声明是否取自论文；发布还须核对页面、凭证、Git 提交和远端状态。
- 新来源获取序号须重新核验当前文件。历史页面仍可读取，但旧 Reader 版本号不能使它重新取得发布资格。
- 历史 `direct-local-first` 独立准备来源、分析和私有页面，再通过 `history:direct-publication` 审查及发布。arXiv 每轮重新获取官方文本/PDF，会议核验保留的本地元数据/PDF。备用 `history:arxiv-batch` 只接命名的新 arXiv 获取失败交接文件；`history:crosswalk` 仍有受来源授权和 CAS 检查的显式旧状态维护，正常 direct 任务不依赖它。旧 `history:publication` 仍只生成私有文件，不具备该发布行为。
- 视觉失败不撤销已核验博客。整批完成仍须数据、审查、远端、部署与网页检查全部通过，并完成图片或记录仅针对视觉的有效用户豁免。
