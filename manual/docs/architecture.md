# Manual v6 架构与证据契约

[返回入口](../README.md) · [文档地图](README.md) · [运行手册](workflow.md) · [编辑契约](editorial-reference-contract.md)

本文给维护 runner、packet、records/spec、canonical 和发布门禁的人使用。它解释组件为什么分层、每层信任什么，以及一次变化应使哪些证据失效。日常运行命令集中在[运行手册](workflow.md)。

## 受众、目标与非目标

Manual v6 的目标是：把“人或 Agent 已认真读过论文”变成可重放的文件证据，而不是一句不可验证的声明。

它必须同时保证：

- 每个语义任务只接触一篇论文和精确允许输入；
- 来源、表图公式和关键数字能回到当前论文；
- author、两类 review、revision 与页面 review 有独立 provenance；
- 单篇结果和整批发布输入都有确定性闭包；
- 输入或协议变化后，旧结果不能静默复用。

它不负责自动创建 subagent，也不把 Manual 变成默认路线。默认 API canonical 使用自己的 production proof，只在共享 publisher 边界与 Manual 汇合。

## 从来源到发布的总 DAG

```text
raw candidates
      │ manual_offline decisions（全集闭包）
      ▼
filtered-papers.json
      │
      ├──────────────► full text / structured source / ArtifactIndex
      │                                      │
      │                                      ▼
      │                       deny-by-default role packets
      │                                      │
      │                               author leaf + receipt
      │                                ┌─────┴─────┐
      │                                ▼           ▼
      │                         technical     pedagogy
      │                         scoring       readability
      │                                └─────┬─────┘
      │                                      ▼
      │                         revision + binder + audit
      │                                      │
      └──────────────────────────────────────┤
                                             ▼
                                  sealed paper record v4
                                             │ all papers
                                             ▼
                                   records-v4 envelope
                                             │
                                             ▼
                               spec v6 + batch Merkle root
                                             │ verified ingestion
                                             ▼
                             deep-analysis-result.json canonical
                                             │
                                             ▼
                      generation v3 → page review → push → remote OID
```

箭头代表证据依赖，不代表脚本会自动完成下一个语义任务。

## 角色和组件所有权

| 组件/参与者 | 唯一职责 | 信任的输入 | 不能承担的职责 |
|---|---|---|---|
| 主 Agent | 维护队列、直接创建 leaf、把真实 task name 交给 runner、收口批次 | runner status、packet 输出、平台任务状态 | 代替 runner 判定 validated；让一个 leaf 处理多篇 |
| author leaf | 从当前论文证据冷启动教程初稿和证据蓝图 | author packet allowlist | 读取历史 prose 或 review findings |
| technical reviewer | 独立评分与校准 | 当前论文证据、受控 author 提交 | 改写 author 内容或改变正式量表 |
| pedagogy reviewer | 独立检查解释、结构和读者负担 | 当前论文证据、受控 author 提交 | 只给泛化文风评价或提供旧稿补丁 |
| revision leaf | 根据原始证据和结构化 findings 冷启动完整替换稿 | revision packet allowlist | 读取 previous draft 后局部编辑 |
| task runner | DAG 状态、claim、路径/SHA、output/receipt 验证 | 已物化 packet 和普通文件 | 创建 subagent、调用 LLM/API、写 prose |
| revision binder | 将已完成 article/map/reviews/audit 确定性序列化 | runner-validated author/reviews 与当前 revision files | 发明语义内容或代替 independent audit |
| records sealer | 注入四角色 receipts 和 resolution，密封 record/envelope | validated task artifacts | 接受缺 role、漂移文件或跨论文 evidence |
| spec assembler | 重放全批集合并建立 paper shard/Merkle root | records envelope、filtered、来源与任务证据 | 从文件名推断 provenance |
| canonical ingestion | 再次重放 spec，写共享 canonical | 同日 production spec v6 | 自动识别/提升 shadow 或 v5 |
| publisher/review gate | 页面、review、Git 与远端发布闭包 | 标准 canonical 和 production proof | 修改已审页面；发布未验证输入 |

## 三种运行模式

| 模式 | 数据根 | 用途 | 是否写标准 canonical | 是否允许正式发布 |
|---|---|---|---|---|
| `production` | `data/current/manual-v6/<date>/` | 用户显式选择的 Manual 正式批次 | 是 | 是 |
| `shadow` | `data/current/manual-v6-shadow/<date>/` | 隔离审计、比较和回归 | 否 | 否 |
| `legacy_v5_maintenance` | 历史工件原路径 | 复演或显式维护既有 v5 | 否 | 仅历史维护，不建立新视觉任务 |

模式是签名输入，不能通过目录名、文件存在性或 `--data-file` 自动推断。Shadow 与 production 使用同构概念但不能互相引用文件。

## 运行数据布局

```text
data/current/
├── filtered-papers.json
├── manual-full-text/<date>/
│   ├── manifest.json
│   ├── papers/<paper-id>-<input-sha>.txt
│   ├── structured/<paper-id>.json
│   └── artifacts/
│       ├── manifest.json
│       └── <paper-id>.json
├── manual-v6/<date>/
│   ├── task-runner/
│   │   ├── state.json
│   │   └── tasks/<paper-id>/...
│   ├── records-v4.json
│   ├── spec.json
│   └── metrics/
├── manual-v6-shadow/<date>/...
└── deep-analysis-result.json
```

源码位于 `manual/scripts/`，Prompt 位于 `manual/prompts/`，运行证据仍位于 `data/current/`。源码移动不迁移、不复制、不重签运行数据。

## 来源证据：ArtifactIndex 是什么

纯文本会丢失表格合并单元格、公式表示、图片身份和引用关系，因此 Manual v6 在 `.text()` 之前保存结构化来源，并生成 ArtifactIndex。

ArtifactIndex 至少承担四个职责：

1. **清点**：论文检测到了哪些表、图、公式、章节、术语和引用。
2. **恢复**：为表格提供 cell ID/矩阵，为公式提供 MathML/TeX，为图片提供 URL/caption/source span。
3. **绑定**：把来源 HTML、全文、论文 metadata 和当前 parser 的真实字节/SHA 连起来。
4. **覆盖检查**：让 reader-longform 能证明每个重要工件被使用或合法省略。

`inventoryHealth.status=complete` 只在检测数与恢复数闭环、无截断且工件可回放时成立。PDF 或纯文本 fallback 必须保持 `incomplete`；“没解析到”不能解释为“论文没有”。

## Packet：把上下文隔离变成文件事实

每个 packet 只属于一个日期、论文和 role。它采用 deny-by-default allowlist：leaf 只能读取列出的 realpath、kind、bytes/SHA；未列出的输入一律禁止。

author packet 的典型允许输入包括：

- 当前论文 metadata projection 和 source snapshot；
- 完整全文、structured source、complete ArtifactIndex；
- ArtifactIndex 授权的论文图片；
- production tutorial Prompt 和编辑契约；
- 空白 schema 与可选官方项目证据。

禁止输入历史 analysis、旧 `readerArticle`、`article.md`、`post.md`、博客页面、已填写 quality 或历史 review prose。

review packet 只增加其角色真正需要的受控 author 输出。revision packet 复用 author 的原始证据，只增加 runner 已验证的 technical/readability findings；它不能把 previous draft 作为编辑底稿。

新 packet 还内联角色专属 `outputContract`，规定输出路径、receipt 路径、字段、量表和稳定语义 SHA。leaf 不应依赖聊天中的补充口头 schema。

## Runner 状态机

Runner 的命令生命周期为：

```text
init → awaiting_packet
packet + register → pending / blocked
claim → claimed
start(real task name) → running
submit(valid output + receipt) → validated
                  └─ fail / abandon → failed → retry
input/protocol drift at any bound node → stale
```

关键不变量：

- `register` 重开 packet 和 allowlist 的真实文件，不信任调用者传入的摘要；
- `claim` 只返回依赖满足的节点，并受 active limit 约束；
- `start` 必须绑定平台真实、唯一 task name；
- `submit` 重开 output/receipt 并校验论文身份、role、模型、隔离声明和输入 SHA；
- `author_revision` submit 还重放 reader-longform，而不是把缺口推迟到 records 阶段；
- `abandon` 只能在平台确认真实任务终止后使用。

runner 不写正文、不调用模型、不物化 records envelope。`manual:work-queue` 只是 `status` 别名，也不创建任务。

## Revision、reader-longform 与独立审计

最终读者文章不能只靠一段自由文本进入 record。Revision leaf 同时提交文章和 binding map；binder 将其构造成 `reader-longform-v2`。

longform 的核心对象是：

- 6–32 个按最终顺序重放的教学 blocks；
- 表格及其 ArtifactIndex cell ID 覆盖；
- 图片、公式的使用或可审计 omission；
- 最终正文实际使用术语的定义；
- 真实 citation 对应的 related-work 关系与差异。

`--prepare` 只把 binding map 声明的确定性表格/工件物化进 leaf 已写好的终稿；`--preflight` 只在内存中构造未密封 record 并运行完整 validator。preflight 通过后，独立 audit 绑定当前 article/map SHA；无参数 binder 才物化 revision output/receipt。

Binder 不得回读遗留 revision payload 作为语义 base。author base、technical review 和 pedagogy review 必须来自 runner validated 路径。Reviewer-owned 分数与校准先应用，revision 只能重新绑定证据，不能改变评分决定。

## Record、spec 与 canonical 的三层闭包

### Record v4：单篇闭包

一篇 sealed record 绑定：

- author、technical、pedagogy、revision 四个互异 task provenance；
- 四类 packet/output/receipt 的真实路径、字节 SHA 和语义 SHA；
- 完整来源身份与 ArtifactIndex；
- reviewer findings 到 revision resolution；
- reader-longform 与最终 article SHA；
- legacy/base 质量子校验结果。

初稿 `authorReceipt` 与终稿 `finalRevisionAuthorReceipt` 分开。未密封 revision payload 不得预先包含 sealer 才能注入的 review receipts、resolution 或 sealed SHA，避免 record/receipt 哈希环。

### Spec v6：整批闭包

Spec assembler 重开 filtered、全文 manifest、ArtifactIndex manifest、records envelope、每篇 task artifacts 和 longform。每篇生成 paper shard，整批按固定顺序构造 Merkle root。

因此，增加/删除论文、改变论文顺序规则、修改任何单篇来源或 task evidence，都会改变 batch identity。Spec 不是 records 文件的简单拼接。

### Canonical：共享发布边界

Production ingestion 只接受同日 `manual-v6/<date>/spec.json` 并再次运行 official assembler。成功后写标准 `data/current/deep-analysis-result.json`，其中保留反向验证 spec、record、ArtifactIndex、task evidence 和 Merkle root 所需的 proof。

共享 publisher 只需要理解标准 canonical 加对应 production proof：Manual 使用 `full-text-evidence-v6` 证明，默认 API 使用自己的 `llm_api_production` 证明。两条上游路线不能互相伪装，但在 generation/review/push 的共享门禁处采用同样严格的页面与发布验证。

## 发布闭包

Manual production 发布依次绑定：

```text
canonical production proof
  → generation schema v3 + publishedPapers + page SHA
  → immutable page artifact
  → per-page Manual review shard
  → batch attestation + deterministic Markdown/Hugo gate
  → review receipt
  → exact Git delta + publication commit
  → remote main OID
```

review worker 只读；任何修改建议都让页面失败。页面改变后旧 shard 不再有效。Push 不能只以“本地 commit 已创建”为成功，必须验证远端 OID。

## 路径、SHA 与协议身份

Manual 证据同时绑定三层身份：

| 层 | 例子 | 为什么需要 |
|---|---|---|
| 文件系统身份 | realpath、普通文件、禁止 symlink、受控根内路径 | 防止路径替换和越界输入 |
| 字节身份 | bytes、SHA-256、NFKC/trim 后语义 SHA | 检测文件漂移并支持跨运行时比较 |
| 协议身份 | Prompt/contract/schema/validator/binder/assembler fingerprint | 防止旧规则输出被当前规则静默复用 |

Prompt、编辑契约、allowlist/output contract、stable JSON/Unicode 规则、validator、binder、sealer 或 assembler 的变化都可能使节点 `stale`。恢复时从最早变化节点重新 packet/register/submit，再组装 records/spec/canonical；不能在旧 JSON 中替换哈希。

对历史工件，兼容读取器只能按工件自身绑定的旧协议和字节重放。保留历史读取能力不等于允许把旧工件改签为当前 production。

## 可观测性与恢复原则

Raw fetch、fulltext、ArtifactIndex、task/records/spec/canonical 的 metrics 使用真实单调时钟，记录可测 queue/host wait、cache 命中、重试等待、输入输出 bytes/SHA 和 task count。无法观测的值写 `unknown`。

Metrics 写失败不能改变论文内容结果，但报告必须显式显示缺失。报告消费前重新检查 sidecar realpath、绑定文件 bytes/SHA 和契约 fingerprint。至少 3 个不同日期才计算 nearest-rank P50/P95。

恢复只遵守一条总原则：定位最早失效证据，保留无关健康节点，向下游重放。不能通过清空整个数据根、手改 SHA、复用旧 receipt 或降级 v5 来消除错误表象。

## 历史兼容边界

### Legacy v5

`manual:v5:*` 保留既有 records v3/spec v5、author packet、draft promotion 和 work-queue 的显式维护。它们不能：

- 为新批次创建 production v6 证明；
- 与 records v4/spec v6 混批；
- 通过修改 `version` 字段提升；
- 进入新教程生成、质量回归或新视觉任务。

V6 可以重放 legacy/base validator 作为基础质量子校验，但这不改变 v6 正式语义来自 task evidence、ArtifactIndex、reader-longform 和 Merkle root。

### Sealed tutorial preview

既有 sealed preview 仅按固定 manifest、正文和 SHA 原字节复验。Production v6 不提供新 preview 写入口；不能把 preview 页面提升为新 canonical 或视觉任务。

### Shadow

Shadow 必须显式选择并只引用 shadow 根。它可运行同构 records/spec/canonical 审计，但不会更新标准 canonical、`papers.json`、发布完成状态或视觉规划。

## 维护变更的最小验收

任何影响 Manual 协议的代码或文档变更，至少验证：

1. Production/shadow 数据根互不引用。
2. Packet allowlist、output contract 和 runner 状态转移仍 fail closed。
3. Prompt/contract/代码 fingerprint 变化能使对应节点 stale。
4. Record 任一 task/source/longform 字节变化会使 sealer 拒绝。
5. Spec 的论文集合、paper shard 或 Merkle 变化会使 ingestion 拒绝。
6. V5、shadow 和 sealed preview 不能通过 production publisher。
7. Page SHA 漂移会使 review/push 失败。
8. 历史 fixture 仍能通过明确的只读兼容路径复演。

具体测试命令由仓库共享 CI 统一维护；本文件不重复根级测试清单。
