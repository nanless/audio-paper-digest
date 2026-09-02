# Manual production v6 工作流

本文说明显式 Manual 批次如何从候选抓取推进到远端发布。架构对象和字段定义见[生产架构与运行边界](architecture.md)，写作与读者质量要求见[教程编辑参考契约](editorial-reference-contract.md)。

## 进入条件

只有用户明确要求 Manual/人工流程时才进入本链路：

```bash
npm run digest:manual -- YYYY-MM-DD
```

普通模型错误、网络错误或配额问题不会自动切换到 Manual。所有项目脚本仍须在沙箱外运行；抓取仍通过项目 `.env` 的代理访问 arXiv 和 HuggingFace。

## 一、抓取与逐篇筛选

```bash
npm run manual:fetch -- --date YYYY-MM-DD --raw
```

raw 阶段联网抓取候选，但不调用筛选模型。它保存来源健康、候选集合、输入 SHA 和可恢复 checkpoint。同日期 raw、select 和 fulltext 共享运行锁。

主 Agent 必须逐篇检查 metadata、标题、摘要、类别和来源，提交完整覆盖候选全集的 `manual_offline` v1 决定。缺失、未知、重复或理由不足的 ID 都会阻断：

```bash
npm run manual:fetch -- --date YYYY-MM-DD --select FILTER_SPEC.json
```

多人分片审阅时，先确定每个候选只产生一个最终决定，再由合并器验证全集覆盖；`--part` 至少重复两次：

```bash
npm run manual:filter-merge -- --date YYYY-MM-DD --reviewer REVIEWER_ID \
  --part PART_1.json --part PART_2.json [--output MERGED_SPEC.json]
```

## 二、结构化全文与 ArtifactIndex

```bash
npm run manual:fulltext -- YYYY-MM-DD
```

HTML 在 `.text()` 前保存表格矩阵、rowspan/colspan、MathML/TeX、图片、章节、citation 和 bibliography。只有 detected/recovered inventory 闭环、无截断且工件可回放时，ArtifactIndex 才是 `complete`；PDF 或纯文本 fallback 保持 `incomplete`。Production v6 不消费 incomplete ArtifactIndex。

失败或损坏时只重抓/重建对应论文，不要删除健康论文的 checkpoint。

## 三、初始化任务 DAG

```bash
npm run manual:tasks -- init --date YYYY-MM-DD
npm run manual:tasks -- status --date YYYY-MM-DD
```

每篇论文执行：

```text
author
  ├── technical_scoring
  └── pedagogy_readability
          ↓
     author_revision
```

runner 从真实 packet、output 和 receipt 推导 `awaiting_packet`、`pending`、`claimed`、`running`、`validated`、`failed`、`stale` 等状态。它不创建 subagent，不写正文，也不组装 records envelope。

## 四、逐角色物化 packet 并分派 leaf

每个 role 在分派前物化 exact allowlist：

```bash
npm run manual:packet -- --date YYYY-MM-DD --paper ARXIV_ID --role ROLE
```

生产 role 为 `author`、`technical_scoring`、`pedagogy_readability`、`author_revision`。命令返回 JSON，其中的 register 参数已经绑定当前 packet、artifact root 和真实路径；主 Agent 必须原样使用这组参数注册任务，不能根据示例猜路径。随后按 runner 生命周期推进：

```bash
# 1. 原样执行 manual:packet 返回的 register 参数
npm run manual:tasks -- register --date YYYY-MM-DD \
  --paper ARXIV_ID --role ROLE --artifact-root ARTIFACT_ROOT --packet PACKET_JSON

# 2. 只领取依赖已满足且有空闲槽的任务
npm run manual:tasks -- claim --date YYYY-MM-DD --limit 3

# 3. 主 Agent 真实创建 leaf 后，绑定平台返回的唯一 task name
npm run manual:tasks -- start --date YYYY-MM-DD --claim CLAIM_ID --task-name TASK_NAME

# 4. leaf 完成后，以当前 claim 提交受控 output 与 receipt
npm run manual:tasks -- submit --date YYYY-MM-DD --claim CLAIM_ID \
  --output OUTPUT_JSON --receipt RECEIPT_JSON
```

`register` 不等于开始任务，`claim` 不等于创建 subagent，`start` 也不能发生在平台 task name 产生之前。每次命令后都可运行 `status`，状态以落盘证据为准。

显式失败与恢复命令只作用于对应 claim 或论文/role：

```bash
npm run manual:tasks -- fail --date YYYY-MM-DD --claim CLAIM_ID --reason REASON
npm run manual:tasks -- abandon --date YYYY-MM-DD --claim CLAIM_ID --reason REASON
npm run manual:tasks -- retry --date YYYY-MM-DD --paper ARXIV_ID --role ROLE
```

`fail` 用于 leaf 已返回的真实失败；`abandon` 用于平台确认活动任务已经终止但未正常回写的 claim。两者都不能按墙钟超时自动推断。

author 只能读取本篇 metadata、source snapshot、完整全文、structured source、complete ArtifactIndex、授权原图、固定 Prompt、编辑契约和空白 schema。revision 复用同一原始证据，只额外读取当前 runner 已验证的结构化 review findings；两者都禁止读取历史 analysis、旧正文、博客页面或 previous draft。

主 Agent 之外最多保持 3 个 leaf 并发。一个任务完成后立即补入下一篇；不得用 broker 占槽，也不得把两篇论文放进同一 task。

## 五、评分、可读性与 revision 收口

技术评分必须按正式八维顺序、上限和固定开源锚点提交，并包含恰好 8 条论文特定理由与完整独立 calibration。可读性复核必须绑定当前论文和正文事实。revision 输出完整替换稿，不提交局部补丁。

`author_revision` submit 会重放 `reader-longform-v2`：

- 6–32 个承担明确教学职责的 blocks 必须逐字生成最终正文；
- complete ArtifactIndex 中的表、图和公式逐项使用或给出合法 omission；
- 表格数值 cell ID 完整覆盖，不能手抄改数；
- 正文实际使用的术语全部定义；
- related work 绑定真实 citation 并解释关系与差异。

revision leaf 先按 packet 输出完整终稿和 binding map。binder 的三个入口承担不同职责：

```bash
# 先把 binding map 中的确定性表格/工件物化到 leaf 已写好的终稿
npm run manual:bind-revision -- --date YYYY-MM-DD --paper ARXIV_ID --prepare

# 独立审计前只在内存重放完整 record/longform 门禁，不写 output/receipt
npm run manual:bind-revision -- --date YYYY-MM-DD --paper ARXIV_ID --preflight

# 审计通过后确定性物化 longform、output 与 receipt
npm run manual:bind-revision -- --date YYYY-MM-DD --paper ARXIV_ID
```

`--prepare` 与 `--preflight` 互斥；需要非默认 map 时可显式传 `--map PATH`。binder 只序列化 leaf 已完成的终稿和语义映射，不代替语义写作。最终仍以 runner `submit` 是否验证通过为准。

## 六、受控元数据纠错（仅在需要时）

元数据纠错使用独立 action-based 生命周期，不是对 canonical 的直接编辑：

```bash
npm run manual:correction -- packet --date YYYY-MM-DD --paper ARXIV_ID
npm run manual:correction -- register --date YYYY-MM-DD --paper ARXIV_ID
npm run manual:correction -- claim --date YYYY-MM-DD --paper ARXIV_ID --limit 1
npm run manual:correction -- start --date YYYY-MM-DD --claim CLAIM_ID --task-name TASK_NAME
npm run manual:correction -- submit --date YYYY-MM-DD --claim CLAIM_ID
npm run manual:correction -- manifest --date YYYY-MM-DD
npm run manual:correction -- status --date YYYY-MM-DD
```

失败恢复只使用 `retry --paper` 或 `abandon --claim --reason`。`--force` 仅用于该 CLI 明确支持的 `packet` / `manifest` 替换，仍不放宽字段、证据或 SHA 校验。纠错完成后，从受影响的最早节点重新物化 packet；禁止手改 filtered、record 或 canonical 来“对齐”。

## 七、密封 records v4 与 spec v6

四角色全部 `validated` 后：

```bash
npm run manual:records -- --date YYYY-MM-DD
npm run manual:spec -- --date YYYY-MM-DD \
  --records data/current/manual-v6/YYYY-MM-DD/records-v4.json
npm run manual:analyze -- --date YYYY-MM-DD \
  --spec data/current/manual-v6/YYYY-MM-DD/spec.json
```

sealer 会重开所有 runner-bound packet、output 和 receipt，注入初稿/终稿 lineage 与 findings resolution，再计算 sealed record。spec assembler 重放全批论文集合、ArtifactIndex、records、task evidence 和 longform，建立 per-paper shard 与 batch Merkle root。Production ingestion 只接受同日受控 spec v6，并写标准 `data/current/deep-analysis-result.json`。

任何集合、路径、SHA、source identity 或 Merkle 漂移都必须回到最早失效阶段，不能用 `--force` 绕过 validator。

## 八、博客生成与逐页 Manual review

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:manual-plan -- --date YYYY-MM-DD
```

plan 输出受控 shard 目录和 attestation 路径。每个最终页面必须由独立 Terra-high leaf 审读；每张正文图片按顺序记录 caption、邻文、移动端可读性和像素事实。组装后执行：

```bash
npm run blog:manual-attest -- --date YYYY-MM-DD
npm run blog:manual-review -- --date YYYY-MM-DD --attestation ATTESTATION.json
npm run blog:push -- --date YYYY-MM-DD
```

Manual review 只替代语义 review 模型；generation manifest、页面 SHA、确定性 Markdown/Hugo gate、Git 基线、精确 staged delta、push 和远端 OID 全部保留。review worker 不得修改已审字节；任何修正建议都回到写作阶段生成完整替换稿。

单篇灰度的五个阶段必须传同一个 `--include-id`，且不得生成汇总页、删除同日其他页面或建立批次视觉任务。

## 九、状态、恢复与性能

```bash
npm run manual:work-queue -- --date YYYY-MM-DD
npm run digest:status -- --date YYYY-MM-DD
```

状态必须从落盘 shard、manifest 和最终 SHA 计算，不能手工计数。按症状恢复：

| 症状/状态 | 正确动作 | 禁止的捷径 |
|---|---|---|
| raw 来源或单篇全文失败 | 复用健康 checkpoint，只重抓失败来源/论文 | 删除整个日期目录后重跑 |
| ArtifactIndex `incomplete` | 修复该论文的结构化获取，直到 inventory 闭环 | 把 fallback 标成 `complete` |
| `awaiting_packet` | 为显示的论文/role 执行 `manual:packet`，再用返回参数 `register` | 猜测 packet 路径或跨论文复用 |
| `pending` / `blocked` | 用 `status` 查看依赖；只 `claim` 已解锁节点 | 跳过 author/review 依赖直接 revision |
| `claimed` / `running` 但 leaf 已终止 | 平台确认任务终止后 `abandon --claim --reason`，再显式 `retry --paper --role` | 按超时时间猜任务已死，重复创建 leaf |
| `failed` | 保存失败证据，修复输入/输出后对目标 role `retry` | 修改 receipt 或清空 state |
| `stale` | 从最早 SHA/fingerprint 变化的节点重新物化，后代重新验证 | 手改旧 packet 中的 SHA |
| 页面 SHA 变化或 review 失败 | 只重审变化/失败页，最后重新收口批次 receipt | 复用旧页 attestation |
| push 后远端 OID 未匹配 | 可复用已验证本地 commit并重新验证远端 | 把本地 commit 当成发布成功 |

性能报告只消费真实 sidecar。每个指标不足 3 个不同日期时只能报告 `insufficient_data`：

```bash
npm run manual:performance-report -- \
  --date YYYY-MM-DD --date YYYY-MM-DD --date YYYY-MM-DD
```

## 十、路径、SHA 与实现升级

`manual/scripts/`、`manual/prompts/` 和 `manual/docs/` 是源码/协议位置；`data/current/manual-full-text/`、`manual-v6/` 和 `manual-v6-shadow/` 是运行证据位置。整理源码路径不会迁移运行证据，也不能靠复制、改名或符号链接更新 provenance。

以下变化必须视为协议输入变化，而不是“只改文案”：Prompt、编辑参考契约、packet allowlist、schema/validator、稳定签名算法、assembler/binder/sealer 协议实现。它们会改变相应 SHA 或 fingerprint，使当前节点及下游 stale。历史工件继续使用自身绑定的旧字节作只读复验；正在运行的新 production 批次必须从最早失效节点重新 packet/register/submit，并重新组装 records/spec/canonical。`--force` 只允许明确覆盖目标文件，永远不把旧 SHA 提升为新协议证明。

## 十一、shadow 与 legacy

Shadow 必须显式使用 `manual:v6:shadow:*` 或 runner `--shadow`，只写 `data/current/manual-v6-shadow/<date>/`，不更新标准 canonical，不进入博客、状态完成或视觉规划。

`manual:v5:*` 仅服务既有历史工件。它不能创建新 production 记录、与 v6 混批、通过改版本号提升，或建立新视觉任务。既有 sealed tutorial preview 只允许按固定 manifest、正文和 SHA 原字节复验。

维护入口的参数边界如下；这里列出它们是为了复演和诊断，不代表可进入 production：

| 入口 | 必需参数 | 可选参数/限制 |
|---|---|---|
| `manual:v6:shadow:spec` | `--date`、至少一个可重复 `--records` | `--force` 仍重放全部校验 |
| `manual:v6:shadow:analyze` | `--date --spec` | `--force` 不改变 shadow 禁发布属性 |
| `manual:shadow` | `--date` | `--output`、可重复 `--metrics`；`--init-shadow` 还要求 `--workspace` 且只允许新鲜日期 |
| `manual:shadow:benchmark` | 至少一个可重复 `--report` | `--output`；不足 3 个不同真实批次只得出 `insufficient_data` |
| `manual:v5:author-packet` | `--date --paper` | 只物化 legacy 维护 packet |
| `manual:v5:promote-draft` | `--date --paper-id --source-dir --technical-review --readability-review --figure-review` | 可选 `--author-packet`；只维护既有 v5 |
| `manual:v5:work-queue` | `--date` | `--observations`、`--output-dir`、`--no-sidecar`；只观察历史状态 |
