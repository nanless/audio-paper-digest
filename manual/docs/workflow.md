# Manual production v6 运行手册

[返回入口](../README.md) · [文档地图](README.md) · [架构契约](architecture.md) · [编辑契约](editorial-reference-contract.md)

本文给批次负责人和主 Agent 使用：每一节都说明输入、命令、成功信号和禁止项。字段与哈希原理集中在[架构契约](architecture.md)，正文质量集中在[编辑契约](editorial-reference-contract.md)。

## 受众与进入条件

只有用户明确要求 Manual/人工流程时运行：

```bash
npm run digest:manual -- YYYY-MM-DD
```

进入前确认：

- 日期为北京时间批次日期，格式固定为 `YYYY-MM-DD`；
- 项目 `.env`、代理和博客仓库配置已由共享流程验证；
- 本批不会把 production、shadow 或 legacy 数据混在同一路径；
- 主 Agent准备直接管理 leaf 队列，runner 不会替你创建 subagent。

默认 LLM/API 日更、其他发布渠道和视觉绘制细节不在本手册展开。

## 一、抓取候选

```bash
npm run manual:fetch -- --date YYYY-MM-DD --raw
```

raw 会访问 arXiv/HuggingFace，但不调用筛选模型。成功结果应包含完整候选集合、来源健康信息、checkpoint 和输入 SHA。

主 Agent逐篇给出 `manual_offline` 决定后提交完整 spec：

```bash
npm run manual:fetch -- --date YYYY-MM-DD --select FILTER_SPEC.json
```

筛选 spec 必须恰好覆盖 raw candidate 全集。缺失 ID、未知 ID、重复 ID、日期不一致或理由不足都会失败。

多人分片时使用确定性合并器；`--part` 至少两份：

```bash
npm run manual:filter-merge -- --date YYYY-MM-DD --reviewer REVIEWER_ID \
  --part PART_1.json --part PART_2.json [--output MERGED_SPEC.json]
```

禁止项：

- 不得因某来源暂时失败就把候选集合声明完整；
- 不得只提交“选中项”，遗漏明确排除项；
- 不得用标题关键词脚本冒充逐篇人工决定。

## 二、建立全文证据

```bash
npm run manual:fulltext -- YYYY-MM-DD
```

该阶段在纯文本化之前保存表格矩阵、rowspan/colspan、MathML/TeX、图片、章节、citation 和 bibliography，并为每篇论文建立 ArtifactIndex。

成功信号是每篇入选论文的 `inventoryHealth.status=complete`。`complete` 表示来源结构闭环：检测到的表、图、公式和引用都能回放；PDF/纯文本 fallback 或截断结果仍是 `incomplete`。

单篇失败时保留其他论文的健康 checkpoint，只修复对应论文。不要删除整个日期目录，也不要手改 `incomplete` 为 `complete`。

## 三、初始化任务 DAG

```bash
npm run manual:tasks -- init --date YYYY-MM-DD
npm run manual:tasks -- status --date YYYY-MM-DD
```

如需显式使用非默认 filtered 文件，`init` 支持 `--papers PATH`。Production 默认读取标准 `filtered-papers.json`。

每篇论文有四个 runner role：

```text
author
  ├── technical_scoring
  └── pedagogy_readability
          │
          ▼
   author_revision
```

author 通过后两个 reviewer 才能解锁；两个 reviewer 都通过后 revision 才能解锁。不同论文可以并发，同一论文不能跳过依赖。

## 四、推进一个角色任务

### 1. 物化 packet

```bash
npm run manual:packet -- --date YYYY-MM-DD --paper ARXIV_ID --role ROLE
```

`ROLE` 只能是：

- `author`
- `technical_scoring`
- `pedagogy_readability`
- `author_revision`

命令输出当前 packet、artifact root 以及精确 register 参数。该输出是路径真相，不要从本文示例推算路径。

### 2. 注册 packet

原样使用上一步返回的值：

```bash
npm run manual:tasks -- register --date YYYY-MM-DD \
  --paper ARXIV_ID --role ROLE \
  --artifact-root ARTIFACT_ROOT --packet PACKET_JSON
```

register 只验证并登记 allowlist；它不会领取任务或创建 leaf。

### 3. 领取可运行任务

```bash
npm run manual:tasks -- claim --date YYYY-MM-DD --limit 3
```

claim 只返回依赖满足的任务。主 Agent占 1 个平台槽，因此 `--limit` 不应超过可用的 3 个 leaf 槽。

### 4. 创建 leaf 并回写真实 task name

主 Agent根据 claim 直接创建一个只处理当前论文、当前 role 的 leaf。平台返回唯一 task name 后：

```bash
npm run manual:tasks -- start --date YYYY-MM-DD \
  --claim CLAIM_ID --task-name TASK_NAME
```

不能在真实 leaf 创建前调用 start，也不能用虚构 task name 占位。

### 5. 提交 output 与 receipt

leaf 只读取 packet allowlist，按 packet 的 `outputContract` 写入规定路径。随后：

```bash
npm run manual:tasks -- submit --date YYYY-MM-DD \
  --claim CLAIM_ID --output OUTPUT_JSON --receipt RECEIPT_JSON
```

submit 会重开真实文件并校验论文身份、模型/推理等级、输入 SHA、输出结构和角色规则。只有通过后状态才是 `validated`。

### 6. 真实失败与恢复

```bash
npm run manual:tasks -- fail --date YYYY-MM-DD \
  --claim CLAIM_ID --reason REASON

npm run manual:tasks -- abandon --date YYYY-MM-DD \
  --claim CLAIM_ID --reason REASON

npm run manual:tasks -- retry --date YYYY-MM-DD \
  --paper ARXIV_ID --role ROLE
```

- `fail`：leaf 已明确返回失败并留下原因。
- `abandon`：平台已经确认活动任务终止，但 claim 没有正常收口。
- `retry`：失败/放弃后重新打开指定论文和 role。

不能仅凭墙钟超时推断任务死亡；否则可能同时存在两个写同一 artifact root 的 leaf。

## 五、四个角色的交付边界

| role | 主要输入 | 交付 | 不得做什么 |
|---|---|---|---|
| `author` | 当前论文 metadata、全文、结构化来源、complete ArtifactIndex、Prompt、编辑契约、空白 schema | fresh 初稿、研究蓝图、事实与工件映射 | 读取历史 analysis、旧正文、博客页或其他论文 |
| `technical_scoring` | 当前论文证据与 author 提交 | 八维评分、8 条特定理由、证据 ID、独立 calibration | 替 author 改写正文；自创评分尺度 |
| `pedagogy_readability` | 当前论文证据与 author 提交 | 教学结构、术语、段落、图表互动和可读性 findings | 只做文风好恶判断；给可直接粘贴的旧稿补丁 |
| `author_revision` | 与 author 同序的原始证据，加两个已验证 reviewer findings | 从原始证据冷启动的完整替换稿、binding map、findings resolution | 读取 previous draft 后局部修补；改变 reviewer-owned 分数 |

author_revision 不是“在旧稿上润色”。它必须根据原始证据和结构化 findings 重新生成完整终稿。

## 六、revision binder 与独立审计

revision leaf 写好 `final-article.md` 和 binding map 后依次执行：

```bash
# 将 binding map 中的确定性表格/工件物化进已有终稿
npm run manual:bind-revision -- --date YYYY-MM-DD \
  --paper ARXIV_ID --prepare

# 只在内存重放完整 record 与 reader-longform 门禁
npm run manual:bind-revision -- --date YYYY-MM-DD \
  --paper ARXIV_ID --preflight
```

如 map 不在默认位置，可追加 `--map PATH`。`--prepare` 与 `--preflight` 互斥。

preflight 通过后，再由独立 Terra-high audit 检查当前 article/map 的真实 SHA 和完整语义门禁，将 audit 写入 packet 规定位置。最后运行无模式参数的 binder：

```bash
npm run manual:bind-revision -- --date YYYY-MM-DD --paper ARXIV_ID
```

它只把已完成的 article、map、reviews 和 audit 确定性序列化为 output/receipt，不替 leaf 写作。随后用本手册第四节的 runner `submit` 提交 revision。

## 七、受控元数据纠错

只有 metadata 身份错误且已有证据时才进入纠错状态机。它与论文正文 DAG 分离：

```bash
npm run manual:correction -- packet --date YYYY-MM-DD --paper ARXIV_ID
npm run manual:correction -- register --date YYYY-MM-DD --paper ARXIV_ID
npm run manual:correction -- claim --date YYYY-MM-DD [--paper ARXIV_ID] [--limit N]
npm run manual:correction -- start --date YYYY-MM-DD \
  --claim CLAIM_ID --task-name TASK_NAME
npm run manual:correction -- submit --date YYYY-MM-DD --claim CLAIM_ID
npm run manual:correction -- manifest --date YYYY-MM-DD
npm run manual:correction -- status --date YYYY-MM-DD
```

恢复入口：

```bash
npm run manual:correction -- retry --date YYYY-MM-DD --paper ARXIV_ID
npm run manual:correction -- abandon --date YYYY-MM-DD \
  --claim CLAIM_ID --reason REASON
```

`--force` 只被 `packet` 和 `manifest` 接受，且仍会重放字段、证据和 SHA 校验。纠错 manifest 完成后，从最早受影响节点重新物化 production packet；不能直接修改 record 或 canonical。

其中 `N` 只能是 1–3；不传时使用实现的 active limit。

## 八、密封 records、spec 与 canonical

四个 role 全部 `validated` 后：

```bash
npm run manual:records -- --date YYYY-MM-DD
npm run manual:spec -- --date YYYY-MM-DD \
  --records data/current/manual-v6/YYYY-MM-DD/records-v4.json
npm run manual:analyze -- --date YYYY-MM-DD \
  --spec data/current/manual-v6/YYYY-MM-DD/spec.json
```

成功含义：

1. `manual:records` 重开每篇 packet/output/receipt，密封单篇 record 和整批 envelope。
2. `manual:spec` 重放论文全集、ArtifactIndex、records、任务证据和 reader-longform，生成 per-paper shard 与 batch Merkle root。
3. `manual:analyze` 再次验证 spec，写入标准 `data/current/deep-analysis-result.json`。

`manual:records` 支持显式 `--force`，spec/analyze 也支持在已有输出变化时显式 `--force`。force 只允许覆盖目标文件，不会跳过 validator；任何集合、路径、SHA、source identity 或 Merkle 错误仍会失败。

## 九、博客审查与发布

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:manual-plan -- --date YYYY-MM-DD
```

plan 给出受控逐页 shard 与 attestation 路径。每个最终页面由独立的单页 Terra-high leaf 审查；reviewer 只读当前不可变页面，不能边审边改。需要修改时回到生成/修订阶段，产生新 SHA 后重审该页。

逐页 shard 完成后：

```bash
npm run blog:manual-attest -- --date YYYY-MM-DD
npm run blog:manual-review -- --date YYYY-MM-DD --attestation ATTESTATION.json
npm run blog:push -- --date YYYY-MM-DD
```

push 会复验 generation manifest、页面 SHA、review receipt、Git 基线、提交差异和远端 OID。只有远端 `main` OID 等于 publication commit 才算发布完成。

单篇灰度时，generate、plan、attest、review、push 必须传相同 `--include-id ARXIV_ID`。不得因此删除同日其他页面或建立整批视觉任务。

## 十、状态与恢复矩阵

```bash
npm run manual:work-queue -- --date YYYY-MM-DD
npm run manual:tasks -- status --date YYYY-MM-DD
npm run digest:status -- --date YYYY-MM-DD
```

| 状态/症状 | 含义 | 下一步 | 禁止项 |
|---|---|---|---|
| `awaiting_packet` | 当前 role 尚无有效 packet | 执行 `manual:packet`，使用返回参数 register | 猜路径或复用其他论文 packet |
| `pending` | packet 有效，依赖满足，等待领取 | `claim`，有槽后创建 leaf | 手动改成 running |
| `blocked` | 上游 role 未 validated | 完成上游；重新 status | 跳过依赖直接 revision |
| `claimed` | runner 已发 claim，尚未绑定真实 task | 创建 leaf 后立即 `start` | 长期占 claim 或填假 task name |
| `running` | 真实 leaf 与 task name 已绑定 | 等待并 submit；确认终止后才 abandon | 按超时重复创建 leaf |
| `validated` | output/receipt 已通过 | 推进下游或等待 records 收口 | 原地编辑已验证文件 |
| `failed` | 有明确失败证据 | 修复后 `retry --paper --role` | 删除 state/receipt 掩盖失败 |
| `stale` | 输入或协议 SHA 已变化 | 从最早变化节点重新 packet/register/submit | 修改旧 SHA 使其表面一致 |
| `awaiting_records_envelope` | 四角色完成但 records-v4 尚未物化 | 运行 `manual:records` | 把任务完成等同于批次密封完成 |
| review 页面 SHA 变化 | 已审字节不再是当前页 | 只重审变化页，重新组装批次 receipt | 复用旧 attestation |
| push 后 OID 不匹配 | 本地提交未获远端确认 | 重试 push/远端验证 | 声称已发布 |

恢复的一般原则是“从最早失效的证据节点向后重放”，不是“把最后一个错误字段改到能过”。

## 十一、性能观测

```bash
npm run manual:performance-report -- \
  --date YYYY-MM-DD --date YYYY-MM-DD --date YYYY-MM-DD
```

`--date` 可重复但不能重复同一日期；`--output PATH` 仅能写入受控 observability 目录且禁止覆盖。报告只消费真实 sidecar。一个指标不足 3 个不同日期时只能显示 `insufficient_data`，不能从理论耗时推算 P50/P95。

## 十二、shadow 与 legacy 维护入口

Shadow 只用于隔离审计和比较：

| 入口 | 参数 | 结果边界 |
|---|---|---|
| `manual:v6:shadow:spec` | `--date`，至少一个可重复 `--records`，可选 `--force` | 只写 shadow spec |
| `manual:v6:shadow:analyze` | `--date --spec`，可选 `--force` | 只写 shadow canonical，禁止发布 |
| `manual:v6:tasks` | 与 production runner 相同，追加 `--shadow` | 状态只在 shadow 根 |
| `manual:shadow` | `--date`；可选 `--output`、可重复 `--metrics` | 默认只读审计 |
| `manual:shadow -- --init-shadow` | 还必须提供 `--workspace` | 只允许北京时间当天 fresh 批次 |
| `manual:shadow:benchmark` | 至少一个可重复 `--report`；可选 `--output` | 少于 3 个真实批次不得给性能分位数 |

Legacy v5 只为既有历史工件保留：

| 入口 | 必需参数 |
|---|---|
| `manual:v5:spec` | `--date`、至少一个可重复 `--records` |
| `manual:v5:analyze` | `--date --spec`，可选 `--force` |
| `manual:v5:author-packet` | `--date --paper` |
| `manual:v5:promote-draft` | `--date --paper-id --source-dir --technical-review --readability-review --figure-review`；可选 `--author-packet` |
| `manual:v5:work-queue` | `--date`；可选 `--observations`、`--output-dir`、`--no-sidecar` |

这些入口不能创建新 production v6 证明、不能与 v6 混批，也不能建立新视觉任务。既有 sealed tutorial preview 只有只读复验路径，没有新写入口。
