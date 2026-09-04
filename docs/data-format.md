# 数据、状态与凭证

## 本页目标

帮助操作者判断“哪个文件是权威状态”“何时能恢复”“为什么文件存在仍不算完成”。字段级实现以 validator 和 publisher 为准；Manual 数据见 [manual/README.md](../manual/README.md)。

## 四类数据

1. **持久库**：跨批次累积，例如 `papers.json`。
2. **日期批次状态**：raw、decisions、filtered、deep，可从 current 归档到日期目录。
3. **事务凭证**：generation、review、publication、视觉 manifest，绑定精确字节和外部状态。
4. **跨批次运输状态**：`data/runtime/llm-account-pool.json` 保存 OpenCode Go sticky 账号和配额冷却，不随 current 归档。

任何对象的 `complete` 都是契约结论，不是文件名或布尔字段的自我声明。

## OpenCode Go 账号池状态

`data/runtime/llm-account-pool.json` 使用 `opencode-go-sticky-quota-failover-v1`。它只保存服务/账号的 SHA-256 身份、active 账号、归一化额度窗口、`blockedUntil` 和 generation，不保存 API key、认证头、请求正文或响应正文。稳定凭据指纹仍属于敏感操作元数据，因此文件固定 `0600` 且不得上传或归档。账号身份用于在 key 更换后自然形成新凭据身份，不进入论文分析、筛选或发布内容指纹。

Node 与 Python 使用同一目录锁协议和耐久原子写；锁只覆盖选择与状态变换，HTTP 请求始终在锁外。未知 schema、损坏 JSON 或 symlink 状态路径都会失败关闭。冷却到期只让账号重新具备候选资格，不会把流量从当前成功账号自动切回。

## current 核心文件

### `papers.json`

跨运行去重数据库，永不随日批次移走。每项可包含 `digestStatus`：成功分析、待分析、失败和最新尝试信息。旧成功正文保留时，新的失败仍写入 `latestAttemptStatus`，防止发布陈旧结果。

### `fetch-checkpoint.json`

按 arXiv 类别/HuggingFace 保存来源状态、候选数、内容 SHA 和恢复信息。某个来源损坏只失效该来源；必需来源不完整时，下游不能声明 complete。

### `raw-candidates.json`

当日合并、规范化并排除已发布论文后的筛选全集。它是 decision coverage 的分母。

### `filter-decisions.json`

按 normalized ID 保存 LLM 或关键词预筛决定、理由、原始响应、parse source、输入 SHA 和配置指纹。模型、Prompt、协议或关键词契约变化会重筛，但不必重抓健康 raw。

### `filtered-papers.json`

正式入选集。其 ID 集必须精确等于 raw 中的相关决定减去显式排除；不能把 API 错误、未知决定或缺失项静默丢掉。

### `deep-analysis-result.json`

默认 API canonical。每篇至少包含 metadata、analysis、parsed、source identity、stage checkpoints、analysis manifest、评分与 Reader production bindings。完整性要求 deep 论文集精确覆盖 filtered，且每篇所有必需阶段终态闭合。

## 分析来源与恢复

`analysisSource` 记录来源类型、请求 ID、原始/全文/实际输入长度、截断、SHA、警告和置信度。来源 SHA 变化会失效主分析及下游。

失败时保留：

- `analysisManifest`；
- `analysisCheckpoint`；
- `analysisStageCheckpoints`；
- `analysisRecoveryImageManifest`；
- 最新失败状态与错误。

checkpoint 绑定阶段的输入、模型、协议、Prompt、温度、预算和输出 SHA。恢复从第一个不完整或指纹失效阶段开始。

## canonical 与发布正文

canonical 的 13 个中文一级标题是机器解析契约。`parsed` 是缓存，不是独立事实来源；发布前必须从 analysis 重新解析并逐字段比较。

默认 API 发布正文来自：

- `apiReaderArticle`：读者可见长文；
- `apiReaderPlan`：章节、术语桥、Figure placements，以及 `api-reader-source-bindings-v4` 表格/公式来源绑定；
- `apiReaderFigures`：已物化官方图片绑定；
- `apiReaderAuthors`：`api-reader-author-identity-v1` 逐作者姓名与机构来源绑定；
- `apiReaderResources`：`api-reader-resource-identity-v1` 原文/Demo 来源、重定向终点和可达状态绑定；
- 评分证据与评分稳定性裁决；
- `llm_api_production` 集合级 proof。

Reader v1/v2，以及没有当前来源身份合同的旧 v3，只作历史读取兼容。新 production 必须同时闭合 Reader v3、source binding v4、作者/机构 identity v1 与资源 identity v1。摘要 fallback 默认不可发布。

## 博客 generation manifest

schema v3 generation 记录：

- 目标日期、category、博客 base HEAD；
- 精确非空页面集合与逐页 SHA；
- 新建/覆盖/删除状态；
- 输入分析与模板指纹；
- 实际渲染的 `publishedPapers`；
- 同质的 `publicationMode` 与对应 production proof；
- 发布后视觉能力标记。

默认 API 使用 `llm_api_production`；显式 Manual 使用独立 proof。混批、缺绑定或旧 schema 不能作为新日更 publication。

## review receipt 与远端发布

review receipt 绑定 generation SHA、逐页实际 SHA、每页 review 协议、Git baseline、Hugo gate 和 production proof。push 成功后追加：

- `publicationCommit`；
- 相同的 `remoteVerifiedOid`；
- remote 身份；
- 北京时间 `remoteVerifiedAt`。

实时远端 OID、remote 名称或 push URL 身份变化会使旧凭证失效。

## 视觉 manifest

`visual-summary-manifests/<date>.json` 保存 TOP 10 排名、论文任务 token、参考图缓存、generation context、QA claims 与资产 SHA。`digest-cover-manifests/<date>.json` 保存批次标题、热门方向、排行榜和封面资产。

完成态同时要求：

- 绑定当前 publication commit 与远端 OID；
- 任务 token 匹配；
- 文件位于 canonical 归档路径；
- SHA/尺寸/格式正确；
- `qaAttested=true`。

waiver 是单独状态，绑定当前 publication 与两类 manifest SHA；变化后自动失效。

## 归档

`data/archive/<date>/` 保存日批次快照和最终视觉资产。历史 `digest:status` 只有在 raw、decisions、filtered、deep 的日期与集合契约完整时才回退归档；当前日期不会用 archive 掩盖 current 故障。

## 只读验证

```bash
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

`validate:data --allow-empty` 仅适合无运行数据的干净 checkout。状态报告是生成时快照，后续状态改变后必须重跑。
