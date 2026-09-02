# 默认 LLM/API 架构

本页解释默认日更的调用关系、单篇状态机、跨仓库发布事务和数据所有权。操作命令见 [scripts.md](scripts.md)，字段契约见 [data-format.md](data-format.md)，人工流程见 [Manual 子系统](../manual/README.md)。

## 组件与责任

```text
run-daily-digest.sh
  ├─ full-fetch.js
  │    ├─ fetch-papers.js / fetch-huggingface-papers.js
  │    ├─ LLM filter
  │    └─ analysis-engine.js → deep-analyzer.js
  ├─ generate-blog.py
  ├─ review-blog.py → deterministic gate + LLM review + Hugo gate
  ├─ push-blog.py → exact Git delta + remote OID verification
  └─ visual planners → Codex image_gen → record/status
```

- Node 数据层拥有抓取、筛选、单篇分析、checkpoint 和 visual manifest。
- Python 发布层拥有页面生成、只读 review、Hugo 门禁和 Git 事务。
- 博客仓库是发布目标，不是分析事实来源；未提交页面不能反向改变筛选去重基线。
- Codex 内置生图是唯一正式绘图执行者；项目代码只规划、校验和登记资产。

## 单篇自动分析 DAG

```text
source acquisition
  → primary analysis
  → open-source / demo evidence
  → revision
  → table / method / structure repair
  → scoring audit
  → API Reader article + official Figures
  → optional legacy image supplement
```

每个阶段保存输入指纹、模型与协议、Prompt SHA、证据预算、输出 SHA 和终态。阶段输入变化时只失效该阶段及其下游。整篇论文由规范化 arXiv ID 锁保护，锁内必须重新读取 canonical 后再合并。

模型响应同时受 token、绝对时间和总字节三重边界约束。Responses `incomplete`、Chat `length`、Anthropic `max_tokens`、缺失 SSE 终态或超出字节上限都在解析正文前失败，不能把半截 JSON 当成阶段成功。

API Reader 是默认生产正文，不是可选装饰。它依赖最终评分后的 analysis、结构化全文证据和实际物化的 Figure；旧 13 节 analysis 继续作为机器解析层。Reader 的正文版本与来源绑定版本正交：`beginner-researcher-v3` 约束读者结构，`api-reader-source-bindings-v4` 逐格重放表格并从结构化原文注入公式，`api-reader-author-identity-v1` 绑定逐作者机构来源，`api-reader-resource-identity-v1` 绑定项目资源的原文/Demo 证据、重定向终点与可达状态。

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
| blog repository/date lock | generation、review、Git index、commit 与 push | 先检查 owner 和子进程，不得直接删除活锁 |

锁等待时先检查 owner PID、hostname、heartbeat 和父子进程。只有实现判定为 stale 的租约才能自动回收。

## 设计边界

- API 网络失败不会自动切换 Manual。
- Muse、arXiv、HuggingFace 和论文资产按各自策略使用项目代理；普通 LLM 不继承代理。
- canonical SHA 证明“这些字节被发布”，来源级 table/formula/claim binding 才证明“这些事实来自论文”。
- 新 generation 必须重放当前来源绑定；历史页面可读取，不得只凭旧 Reader 版本号重新取得 production 资格。
- 视觉失败不撤销已验证博客，但整批只有视觉 complete 或有效 waiver 后才是业务终态。
