# Manual 论文速递

本目录集中保存显式 Manual/人工高保障路线的文档、Prompt、实现和测试。项目的默认日更仍是 LLM/API 路线；只有用户明确要求“Manual”或“人工流程”时，才运行：

```bash
npm run digest:manual -- YYYY-MM-DD
```

Manual 不是 API 故障时的自动降级，也不是放宽质量门槛。它以逐篇隔离的人工语义工作替代筛选、正文和页面语义审查模型，同时保留联网来源获取、结构化全文、确定性校验、博客三阶段发布、远端 OID 和视觉验收。

## 先按职责找入口

| 参与者 | 负责 | 不负责 |
|---|---|---|
| 用户/批次负责人 | 明确选择 Manual、确认批次范围与发布意图 | 为失败节点手改 SHA 或绕过门禁 |
| 主 Agent | 维护逐论文队列、执行 packet/runner 生命周期、直接创建 leaf、收口 records/spec/publish | 代替 leaf 撰写多篇正文，或让 runner 自动创建 subagent |
| 单篇 leaf | 只在当前 packet allowlist 内完成一个论文、一个 role 的语义工作 | 读取其他论文、历史正文或自行扩展输入 |
| runner / binder / sealer | 验证状态、依赖、真实字节和 SHA，确定性组装已提交语义结果 | 调用模型、补写事实或替 reviewer 作判断 |
| publisher / review gate | 绑定最终页面字节、Git 基线、publication commit 与远端 OID | 将 shadow、legacy 或未密封 canonical 提升为 production |

如果你只是运行或恢复批次，直接看[工作流](docs/workflow.md)；只有修改 provenance、runner 或 records/spec 边界时才需要完整阅读[架构文档](docs/architecture.md)。

## 最短生产链路

```text
manual_offline 逐篇筛选
  → structured full text + complete ArtifactIndex
  → author → deterministic submit validation
  → technical_scoring + pedagogy_readability
  → author_revision → longform preflight / independent audit
  → records v4
  → spec v6 + batch Merkle root
  → production canonical
  → 逐页 Manual review
  → blog push + remote OID
  → 发布后视觉资产
```

入口会在需要人工工作的边界停下。持久 runner 只管理状态、依赖和真实文件 SHA；它不会创建 subagent、编写正文、物化完整 role 输出或组装 records envelope。主 Agent 必须为每篇论文直接分派独立的 `gpt-5.6-terra`、reasoning `high` leaf，并按状态补满最多 3 个可用 leaf 槽。`manual:packet` 的 JSON 输出包含当前真实路径对应的 register 参数；应使用该输出，而不是从文档示例手抄 artifact root 或 packet 路径。

## 生产命令

以下只列稳定的 npm 入口；具体参数、状态和失败恢复见[工作流](docs/workflow.md)。

```bash
# 无筛选模型抓取候选；随后提交完整的 manual_offline 逐篇决定
npm run manual:fetch -- --date YYYY-MM-DD --raw
npm run manual:fetch -- --date YYYY-MM-DD --select FILTER_SPEC.json

# 结构化全文与 ArtifactIndex
npm run manual:fulltext -- YYYY-MM-DD

# production v6 task DAG
npm run manual:tasks -- init --date YYYY-MM-DD
npm run manual:tasks -- status --date YYYY-MM-DD
npm run manual:packet -- --date YYYY-MM-DD --paper ARXIV_ID --role author
npm run manual:packet -- --date YYYY-MM-DD --paper ARXIV_ID --role technical_scoring
npm run manual:packet -- --date YYYY-MM-DD --paper ARXIV_ID --role pedagogy_readability
npm run manual:packet -- --date YYYY-MM-DD --paper ARXIV_ID --role author_revision

# 四角色全部 validated 后收口
npm run manual:records -- --date YYYY-MM-DD
npm run manual:spec -- --date YYYY-MM-DD \
  --records data/current/manual-v6/YYYY-MM-DD/records-v4.json
npm run manual:analyze -- --date YYYY-MM-DD \
  --spec data/current/manual-v6/YYYY-MM-DD/spec.json

# 状态和真实观测
npm run manual:work-queue -- --date YYYY-MM-DD
npm run manual:performance-report -- --date YYYY-MM-DD --date YYYY-MM-DD --date YYYY-MM-DD
```

按需维护入口：

| 场景 | 命令 | 边界 |
|---|---|---|
| 合并分片筛选决定 | `npm run manual:filter-merge -- ...` | 仍须完整覆盖 raw candidates |
| 元数据纠错 | `npm run manual:correction -- <packet|register|claim|start|submit|retry|abandon|manifest|status> ...` | 独立受控生命周期；只接受允许字段和证明，不改论文事实 |
| revision 确定性绑定 | `npm run manual:bind-revision -- --date DATE --paper ID [--prepare|--preflight]` | `prepare` 把 binding map 中的确定性表/工件物化进已有终稿，`preflight` 只读重放；均不创作语义正文 |
| 显式 shadow spec/canonical | `manual:v6:shadow:spec`、`manual:v6:shadow:analyze` | 只写 shadow 根，不得发布 |
| shadow 审计/benchmark | `manual:shadow`、`manual:shadow:benchmark` | 只消费既有真实指标与报告 |
| legacy v5 读取维护 | `manual:v5:spec`、`manual:v5:analyze`、`manual:v5:author-packet`、`manual:v5:promote-draft`、`manual:v5:work-queue` | 不得创建或冒充 production v6 |

博客仍按 generate、review、push 三阶段执行。Manual 页面审查使用隔离的逐页 shard 和 attestation：

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:manual-plan -- --date YYYY-MM-DD
# 按 plan 路径写入逐页 Terra-high review shard
npm run blog:manual-attest -- --date YYYY-MM-DD
npm run blog:manual-review -- --date YYYY-MM-DD --attestation ATTESTATION.json
npm run blog:push -- --date YYYY-MM-DD
```

单篇灰度时，generate、plan、attest、review、push 必须传同一个 `--include-id`。既有 sealed tutorial preview 仅允许只读复验；新 production v6 不提供 preview 写入口。

## 文档导航

- [文档索引](docs/README.md)：按运行、编辑、契约和维护职责导航。
- [工作流与恢复](docs/workflow.md)：从 raw 到发布的逐阶段操作手册。
- [生产架构与边界](docs/architecture.md)：task DAG、records v4、spec v6、Merkle、shadow 与 legacy 边界。
- [教程编辑参考契约](docs/editorial-reference-contract.md)：正文教学结构、图表公式和渲染要求；该文件是运行时 SHA 输入。
- [研究生级教程 Prompt](prompts/manual-tutorial-article.md)：production author packet 使用的写作规范。
- [Legacy/base 分析 Prompt](prompts/manual-analysis-record.md)：历史 v5 与 records v4 基础质量子校验使用的兼容规范。

## 目录边界

- `manual/docs/`：Manual 唯一详细文档来源。默认 `docs/` 只保留指针和共享边界。
- `manual/prompts/`：Manual 专用 Prompt。修改任何字节都会改变对应 SHA 并使未完成的下游绑定失效。
- `manual/scripts/`：Manual runner、records/spec、review、shadow 和兼容实现。
- `manual/tests/`：Manual 单元测试、跨运行时向量与历史兼容 fixture。
- `data/current/manual-v6/<date>/`：production 运行证据。
- `data/current/manual-v6-shadow/<date>/`：只读审计与对比；永远不能发布。

源代码目录与运行数据目录是两套身份：把实现整理到 `manual/scripts/` 不会迁移 `data/current/` 下的证据，也不能通过复制/改名让旧证据获得新 provenance。Prompt、编辑契约或协议实现的任意字节变化都会改变相应 SHA/fingerprint；运行中的 packet 会按真实依赖变为 `stale`，应从最早失效节点重新物化并提交，而不是修改已签名 JSON。

## 必守边界

- Production 只接受 records v4 → spec v6 → `runtimeMode=production` canonical；不能从目录名、文件名或版本号猜测 provenance。
- author 与 revision 都从同一篇论文的受控原始证据冷启动；禁止读取历史正文、博客页面或 previous draft。
- 每篇论文的 author、技术评分、可读性复核、revision 和最终页面审查都必须保留独立 task provenance。
- complete ArtifactIndex 的表、图、公式、术语和相关工作必须在 `reader-longform-v2` 中逐项处置。
- Shadow、legacy v5、sealed preview 和 production v6 不得混批、改名或互相提升。
- 修复必须从最早失效阶段重跑；禁止手改 SHA、fingerprint、attestation、publication commit 或远端 OID。
