# 默认 LLM/API 架构

本页解释默认日更的调用关系、单篇状态机、跨仓库发布事务和数据所有权。操作命令见 [scripts.md](scripts.md)，字段契约见 [data-format.md](data-format.md)，人工流程见 [Manual 子系统](../manual/README.md)。

## 组件与责任

```text
run-daily-digest.sh
  ├─ full-fetch.js
  │    ├─ fetch-papers.js / fetch-huggingface-papers.js
  │    ├─ LLM filter
  │    ├─ daily-fresh-source-plan.js → sealed official TXT/PDF bundle
  │    └─ analysis-engine.js → deep-analyzer.js (replays only that bundle)
  ├─ generate-blog.py
  ├─ review-blog.py → deterministic gate + LLM review + Hugo gate
  ├─ push-blog.py → exact Git delta + remote OID verification
  └─ visual planners → Codex image_gen → record/status
```

- Node 数据层拥有抓取、筛选、日更 sealed source capture、单篇分析、checkpoint 和 visual manifest。
- Python 发布层拥有页面生成、只读 review、Hugo 门禁和 Git 事务。
- Node 与 Python 共用 `data/runtime/llm-account-pool.json`，记录 OpenCode Go 当前使用的账号和配额冷却时间。这些请求状态不进入论文、提示词或发布内容的指纹。
- 博客仓库是发布目标，不是分析事实来源；未提交页面不能反向改变筛选去重基线。
- Codex 内置生图是唯一正式绘图执行者；项目代码只规划、校验和登记资产。

## 单篇自动分析 DAG

```text
source acquisition
  → primary analysis
  → open-source / demo evidence
  → revision
  → table / method / structure repair
  → taxonomy seal → core-summary seal
  → scoring audit
  → API Reader article + official Figures
  → optional legacy image supplement
```

默认 API 的 source acquisition 在 LLM 筛选后一次性完成：每个入选 arXiv ID 新拉取官方 HTML 文本和 PDF，
原子封存为 `daily-fresh-source-run-v1` 的四文件 bundle。后续分析、Reader 和 Python 发布重放其
`dailyFreshSourceRun`；缺失或 SHA 漂移在模型/图片请求前失败。官方 Figure 像素只在当前调用的 OS 临时目录
存在，不能成为 `data/current` 或 runtime 图片缓存。单张超限 Figure 可被跳过，损坏或 provider 不兼容的 PNG 可转为白底 RGB JPEG 重试；最终绑定实际送入模型的像素 SHA。

每个阶段保存输入指纹、模型与协议、Prompt SHA、证据预算、输出 SHA 和终态。阶段输入变化时只失效该阶段及其下游。整篇论文由规范化 arXiv ID 锁保护，锁内必须重新读取 canonical 后再合并。

模型响应有输出 token 数、总耗时和响应字节数的限制。Node 分析请求还检查流式响应是否正常结束。Node 与 Python 都先检查响应终态，再接受正文：Responses 的 `incomplete`、`failed` 或 `cancelled`，Chat 的 `length`，以及 Anthropic 的 `max_tokens` 都不能作为成功响应，即使正文恰好是完整 JSON。Python 对原本没有正文、且输出预算耗在隐藏推理上的响应保留有次数限制的恢复；被拒绝的非空正文不属于这种情况。

认证或账号池不可用等运行级错误会停止领取新论文。已经开始的论文仍会保存结果，尚未开始的论文保持待处理状态；最终保存完成后，批量入口报告运行失败。普通单篇错误只结束该篇的尝试，不停止其他论文。

最终博客正文由 API Reader 生成。它读取封存的原文、结构化全文证据、已验证的资源信息和本次准备的论文图，不把评分后的分析正文当作写作来源；旧的 13 节分析仍供程序解析。Reader 在评分后执行，这个先后顺序不代表它读取评分结果。

正文结构和来源检查分别使用版本协议。`beginner-researcher-v3` 规定文章结构；`api-reader-source-bindings-v4` 逐格核对表格来源，并从结构化原文插入公式；`api-reader-author-identity-v1` 核对作者与机构来源；`api-reader-resource-identity-v1` 核对资源的原文或演示页面证据、重定向地址和可达状态。结构化证据按稳定键序计算 SHA。旧的封存证据只有在来源清单、文本 SHA、解析器版本和布局都能重新核验时才可兼容读取，不改写原文件。

阶段复用还受实现哈希约束。目前 Reader 的质量检查依赖整个 `deep-analyzer.js` 的 SHA，所以修改该文件中与 Reader 无关的代码也可能触发重做。不能仅凭“没有修改评分结果”判断 Reader 一定会复用。

## 博客事务时序

```text
canonical batch
  → generation manifest v3 + exact page bytes
  → immutable page artifacts
  → per-page deterministic/LLM/image review
  → isolated Hugo gate
  → review receipt bound to page SHA + Git baseline
  → exact git commit → push → live remote main OID verification
  → post-publication visual manifests
```

review 不修改页面。任何修正必须回到生成或分析阶段并产生新 SHA。push 只接受 receipt 列出的精确增删改集合；Git hook、额外 staged 文件、baseline 漂移或 remote 身份变化都会阻断。

## 数据所有权

```text
data/current/               当日权威状态和可续跑 checkpoint
data/archive/<date>/        已结束日期快照和最终视觉资产
data/runtime/daily-fresh-source-runs/
                            日更分析/发布重放的官方 PDF/TXT/runtime/manifest
data/runtime/fetched-arxiv-sources/
                            历史 direct arXiv generation 的官方 PDF/TXT/runtime/manifest
Hugo blog repository        已生成页面、静态资产和已验证发布提交
logs/                       脱敏日志，受年龄与容量保留策略约束
```

`current` 文件存在不代表完成；消费者必须验证日期、论文集合、状态、输入指纹和 SHA。历史 archive 只有在完整跨文件契约通过时才能作为恢复输入，不能掩盖当前批次故障。

## 锁表

| 锁 | 保护对象 | 正常恢复规则 |
|---|---|---|
| full-fetch run lock | 归档、抓取、筛选和批次初始化 | 活 owner 不得删除；退出后按 owner/租约规则回收 |
| paper analysis lock | 单篇阶段 checkpoint 与 canonical 合并 | 等待已有任务；锁内重读，禁止旧对象覆盖 |
| JSON file lock | `papers.json`、deep、manifest 等共享文件 | 同步读改写并递增 generation |
| LLM account pool lock | 跨日期 OpenCode Go active/cooldown 状态 | 只在选择或确认 quota 时短暂持有；HTTP 永远在锁外 |
| blog repository/date lock | generation、review、Git index、commit 与 push | 先检查 owner 和子进程，不得直接删除活锁 |

锁等待时先检查 owner PID、hostname、heartbeat 和父子进程。只有实现判定为 stale 的租约才能自动回收。

## 设计边界

- API 网络失败不会自动切换 Manual。
- Muse、arXiv、HuggingFace 和论文资产按各自策略使用项目代理；普通 LLM 不继承代理。
- OpenCode Go 备用账号严格长期 sticky：只响应明确 `GoUsageLimitError`，不对普通 429、5xx 或网络故障切号，也不在冷却到期后自动 failback。认证信息只会附加到与 endpoint/model 推导结果精确一致的规范 API URL；不同服务的副模型不得继承主账号池。
- canonical SHA 证明“这些字节被发布”，来源级 table/formula/claim binding 才证明“这些事实来自论文”。
- 新 generation 必须重放当前来源绑定；历史页面可读取，不得只凭旧 Reader 版本号重新取得 production 资格。
- 历史 direct-local-first 由独立 catalog/plan/scheduler/runner 处理：arXiv 每 generation 重新拉取官方
  PDF/TXT，会议只重放本地 metadata/PDF SHA；crosswalk 只接收 named arXiv fresh-failure handoff，会议本地输入坏掉时直接失败关闭。完整 direct 投影可经内容寻址的历史 review、锁内 activation/commit/push 和远端 OID 验证发布；conference aggregate 未接入时仍失败关闭。
- 视觉失败不撤销已验证博客，但整批只有视觉 complete 或有效 waiver 后才是业务终态。
