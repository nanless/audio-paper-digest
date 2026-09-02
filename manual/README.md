# Manual 论文速递

Manual 是项目的显式人工高保障路线：逐篇筛选、论文理解、教程写作、评分和页面语义审查由隔离的 paper leaf 完成；抓取、结构化证据、确定性校验、博客发布和远端验证仍由项目脚本负责。

项目默认日更是 LLM/API。只有用户明确要求“Manual”或“人工流程”时才进入本目录描述的流程：

```bash
npm run digest:manual -- YYYY-MM-DD
```

网络、模型或配额失败不会自动切换到 Manual。Manual 也不是降低质量要求的离线兜底。

## 这套文档给谁看

| 读者 | 先读 | 需要解决的问题 |
|---|---|---|
| 第一次运行批次的人 | 本页 → [运行手册](docs/workflow.md) | 从哪里开始、下一条命令是什么、失败后从哪里恢复 |
| 主 Agent | [运行手册](docs/workflow.md) | 如何管理 packet、claim、leaf、submit 和批次收口 |
| 单篇 author/reviewer leaf | [编辑契约](docs/editorial-reference-contract.md)和 packet 内文件 | 如何把一篇论文写清楚、如何审查证据与可读性 |
| 维护 runner/records/publisher 的开发者 | [架构契约](docs/architecture.md) | 哪些文件构成证据、SHA 为什么失效、兼容边界在哪里 |
| 历史维护人员 | [架构契约的兼容章节](docs/architecture.md#历史兼容边界) | 哪些旧工件只能复验，哪些入口仍可显式维护 |

## 最短生产路径

```text
raw candidates
  → manual_offline 全量逐篇筛选
  → structured full text + complete ArtifactIndex
  → author
  → technical_scoring + pedagogy_readability
  → author_revision + independent audit
  → records v4
  → spec v6 + batch Merkle root
  → production canonical
  → blog generate → 独立逐页 review → push → remote OID
```

这里有三类容易混淆的对象：

- **packet**：一个论文、一个角色能读取的精确文件白名单，同时给出输出契约。
- **runner**：保存任务状态并验证 packet/output/receipt；不创建 subagent，也不写论文内容。
- **records/spec/canonical**：从单篇已验证结果到整批发布输入的三层确定性闭包，不是三份可随意互换的 JSON。

## 主链命令

```bash
# 1. 抓取候选并提交完整人工筛选决定
npm run manual:fetch -- --date YYYY-MM-DD --raw
npm run manual:fetch -- --date YYYY-MM-DD --select FILTER_SPEC.json

# 2. 获取结构化全文和 ArtifactIndex
npm run manual:fulltext -- YYYY-MM-DD

# 3. 初始化、查看并推进单篇角色 DAG
npm run manual:tasks -- init --date YYYY-MM-DD
npm run manual:tasks -- status --date YYYY-MM-DD
npm run manual:packet -- --date YYYY-MM-DD --paper ARXIV_ID --role ROLE

# 4. 四个角色全部 validated 后密封整批
npm run manual:records -- --date YYYY-MM-DD
npm run manual:spec -- --date YYYY-MM-DD \
  --records data/current/manual-v6/YYYY-MM-DD/records-v4.json
npm run manual:analyze -- --date YYYY-MM-DD \
  --spec data/current/manual-v6/YYYY-MM-DD/spec.json

# 5. 生成、人工逐页审查并发布
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:manual-plan -- --date YYYY-MM-DD
npm run blog:manual-attest -- --date YYYY-MM-DD
npm run blog:manual-review -- --date YYYY-MM-DD --attestation ATTESTATION.json
npm run blog:push -- --date YYYY-MM-DD
```

`ROLE` 只能是 `author`、`technical_scoring`、`pedagogy_readability` 或 `author_revision`。`manual:packet` 会输出绑定当前真实路径的 runner register 参数；必须使用该输出，不能从示例手抄 packet 或 artifact root。

完整的 register/claim/start/submit 命令、revision binder、元数据纠错和恢复方式见[运行手册](docs/workflow.md)。

## 谁负责什么

| 参与者 | 负责 | 明确禁止 |
|---|---|---|
| 用户/批次负责人 | 明确选择 Manual、确定日期和发布范围 | 把普通失败解释为自动 Manual 授权 |
| 主 Agent | 维护队列，物化并注册 packet，直接创建单篇 leaf，回写真实 task name，收口 records/spec/publish | 让 runner 创建 subagent；把多篇论文交给一个 leaf |
| 单篇 leaf | 在 packet 白名单内完成一个论文、一个角色的语义工作 | 读取其他论文、旧博客、历史 analysis 或未授权 previous draft |
| runner/binder/sealer | 验证依赖、路径、字节、SHA 和确定性结构 | 调用模型、补写事实、替 reviewer 作语义判断 |
| publisher/review gate | 绑定最终页面、Git 基线、publication commit 和远端 OID | 发布 shadow、legacy 或不完整 production canonical |

平台共 4 个并发槽，主 Agent 占 1 个；正文阶段最多同时保持 3 个真实 leaf。任务结束后由主 Agent补入下一篇，不能使用占槽 broker。

## 数据与源码边界

```text
manual/
├── README.md
├── docs/       # 本路线的详细文档
├── prompts/    # 被 packet/spec 真实 SHA 绑定的 Prompt
├── scripts/    # runner、records/spec、shadow、review 和历史维护实现
└── tests/      # Manual 专用测试与 fixture

data/current/
├── manual-full-text/<date>/       # 全文、结构化来源和 ArtifactIndex
├── manual-v6/<date>/              # production task/record/spec/metrics 证据
└── manual-v6-shadow/<date>/       # shadow 隔离证据；禁止发布
```

移动源码不会迁移或重签 `data/current/` 中的证据。Prompt、编辑契约、schema、validator 或协议实现的字节变化会改变 SHA/fingerprint；在途任务应从最早失效节点重做，不能手改已签名 JSON。

## 开始前的五项检查

1. 用户明确要求 Manual，而不是默认 API 日更。
2. 日期使用 `YYYY-MM-DD`，raw/select/fulltext 属于同一批次。
3. 每篇论文最终具有 `complete` ArtifactIndex。
4. 每个 leaf 只处理一个论文和一个 role，并使用 packet 指定的模型与推理等级。
5. production、shadow、legacy v5 和 sealed preview 没有混用路径或工件。

任一项不满足时先看[恢复矩阵](docs/workflow.md#十状态与恢复矩阵)，不要用 `--force` 猜测性推进。
