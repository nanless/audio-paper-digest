# Manual v6 生产架构与运行边界

[← 返回 Manual 入口](../README.md) · [文档索引](README.md) · [运行工作流](workflow.md)

## 正式链路

用户显式选择 Manual/人工流程时，production 日更只允许走：

```text
manual_offline 筛选
  → structured full text + complete ArtifactIndex
  → records v4 持久任务 DAG
  → spec v6 + batch Merkle root
  → full-text-evidence-v6 canonical
  → generation schema v3
  → 独立逐页 Manual review
  → push + remote OID
  → TOP 10 长图与汇总封面
```

records v3/spec v5/canonical v5 不再是默认路径。它们只保留为显式的历史维护读取能力，不能接受新写作、重新包装为 v6、与 v6 混批发布，或进入新教程质量回归。

这是契约边界，不是版本号替换。任何旧 v5 文件即使补上 `version: 6`，也会因缺少结构化来源、records v4 task evidence、reader-longform、Merkle root 或 production runtime proof 而失败。

## 三种运行模式

| 模式 | 用途 | 数据根 | canonical | 是否更新 `papers.json` | 是否允许正式发布 |
|---|---|---|---|---|---|
| `production` | 显式 Manual 正式运行 | `data/current/manual-v6/<date>/` | `data/current/deep-analysis-result.json` | 是 | 是 |
| `shadow` | 隔离审计、回归和对比 | `data/current/manual-v6-shadow/<date>/` | 该日期 shadow 目录内 | 否 | 否 |
| `legacy_v5_maintenance` | 历史 v5 页面只读维护 | 原历史路径 | 原历史 canonical | 否 | 仅显式维护，不建立视觉任务 |

模式必须由命令显式选择并进入签名对象。不得根据某个文件是否存在自动切换，也不得把 shadow canonical 作为自定义 `--data-file` 绕进正式 publisher。

## 正式数据布局

```text
data/current/
├── filtered-papers.json
├── manual-full-text/<date>/
│   ├── manifest.json
│   ├── papers/<paper-id>.txt
│   ├── structured/<paper-id>.json
│   └── artifacts/
│       ├── manifest.json
│       └── <paper-id>.json
├── manual-v6/<date>/
│   ├── task-runner/
│   │   ├── state.json
│   │   └── tasks/<paper-id>/
│   ├── records-v4.json
│   ├── spec.json
│   └── metrics/
└── deep-analysis-result.json
```

`manual-v6/<date>/` 保存 production workflow evidence；正式 publisher 仍只消费标准 canonical。这样发布、状态和视觉不需要维护另一套 v6 canonical 路径，但 canonical 中必须反向绑定日期根内的 spec、record 和 task evidence。

shadow 使用同构目录，但根为 `manual-v6-shadow/<date>/`。两个根的文件不得相互引用。

## 结构化来源与 ArtifactIndex

`manual:fulltext` 在 HTML `.text()` 前保存表格 DOM、矩阵、rowspan/colspan、MathML、TeX、图片、bibliography、citation、章节和 source span，并绑定原始 HTML、最终全文、论文 input identity 和 source identity SHA。

ArtifactIndex parser 固定为 `manual-artifact-parser-v2-structured`。只有 detected/recovered 计数闭环、无截断且所有结构工件可回放时，`inventoryHealth.status` 才能为 `complete`。PDF 或纯文本 fallback 必须为 `incomplete`，不能用“没有解析到”冒充“论文没有该工件”。

production spec v6 要求批次内每篇 ArtifactIndex 都为 complete。单篇 incomplete 会保留可恢复 checkpoint，并阻断该批 spec，而不是降级成 v5。

## 单篇任务 DAG

每篇论文独立执行。箭头表示证据依赖，不表示脚本会自动创建语义任务：

```text
source snapshot + complete ArtifactIndex + prompt/contract
                         │
                         ▼
                 author leaf output
                         │ runner submit validation
              ┌──────────┴──────────┐
              ▼                     ▼
 technical_scoring leaf   pedagogy_readability leaf
              └──────────┬──────────┘
                         ▼
        author_revision leaf（原始证据 + findings）
                         │
                  binder preflight
                         │ independent audit
                         ▼
             validated output / receipt
                         │ deterministic sealer
                         ▼
                  sealed record v4
```

跨论文不得复用 task、packet、输出或 artifact root。平台有 4 个总并发槽，主 Agent占 1 个，因此最多同时运行 3 个 leaf subagent；runner 的 active limit 同样固定为 3。

runner 只负责持久状态、SHA、依赖与真实性校验：

- `init`：绑定同日 complete filtered 集合并建立单篇受控目录；
- `register`：重开 packet 和 allowlist 文件，验证真实字节；
- `claim`：只返回依赖已满足的任务，最多填满 3 槽；
- `start`：绑定平台实际创建的唯一 task name；
- `submit`：验证输出、receipt、Terra-high、单篇隔离与输入 SHA；`author_revision` 还会在未封印状态当场重放完整 `reader-longform-v2`，而不是把 blocks/表图公式/术语/相关工作缺口推迟到 records 阶段；
- `fail/retry/abandon`：显式恢复，不按墙钟猜测任务已经死亡；
- `status`：从落盘 state 和真实文件推导 pending/blocked/validated。

runner 不调用 LLM/API，也不创建 subagent。主 Agent必须依据 claim 真实创建 `gpt-5.6-terra/high` leaf，并把平台 task name 回写 `start`。这是平台权限边界，不能被描述成脚本自动完成。

### 组件所有权

| 组件/参与者 | 可以决定什么 | 必须验证什么 | 不得做什么 |
|---|---|---|---|
| 主 Agent | 队列顺序、何时物化 packet、把 claim 分配给哪个真实 leaf | 当前状态、依赖、平台 task name 与并发槽 | 把多篇塞进一个 leaf，或替 runner 宣称 validated |
| 单篇 role leaf | 当前论文、当前 role 的语义输出 | allowlist、输出 contract、证据局部性 | 读取未授权 prose、修改 runner state、复用别篇结果 |
| task runner | register/claim/start/submit 与状态转移 | packet/output/receipt 字节、SHA、task provenance、DAG 依赖 | 创建 subagent、调用 LLM/API、撰写或修复 prose |
| revision binder | 把已完成 article/map 确定性序列化为 longform/output/receipt | author base、validated reviews、表图公式与字段闭包 | 发明语义映射、代替独立 audit |
| records sealer / spec assembler | 注入 receipts、密封 record、组装 paper shard 与 batch Merkle root | 全集合、source identity、四角色证据、协议签名 | 接受缺失 role、混用 production/shadow/legacy |
| publisher / review gate | 生成页面、绑定逐页审查与远端发布凭证 | canonical production proof、页面 SHA、Git 基线、远端 OID | 从目录名推断 provenance，或发布 shadow canonical |

## Packet 与冷启动

author packet 采用 deny-by-default allowlist，只能读取本篇 metadata projection、source snapshot、完整全文、structured source、complete ArtifactIndex、ArtifactIndex 授权图片、固定写作 prompt、编辑契约和空白 records schema。

禁止输入任何历史 analysis、readerArticle、article/post/blog、旧 record、已填写 quality 或历史 review prose。

`author_revision` 必须复用 author 的同序原始证据，并且只额外读取当前 runner 已验证的 technical/readability findings。它从原始证据和 findings 冷启动输出完整替换稿，不能读取上一版正文后局部修补。

revision packet 的 longform schema 以 validator 的正式字段为准：`paperId`、`articleSha256`、`artifactIndexSha256`、`blocks`、`tables`、`figures`、`formulas`、`terms`、`relatedWorks`。表格、图像与公式必须对 complete ArtifactIndex 全量处置；术语只覆盖最终正文实际使用的 ArtifactIndex acronym，避免把公式变量、短串和未使用候选误当作教程术语；相关工作至少选择两个真实 citation（候选不足两个时全部绑定），并将关系与差异逐字写入 related-work block。旧式 `artifactCoverage` / `tableCoverage` 等摘要字段不能替代这些正式对象。binder 的语义 base 固定为当前 runner-validated `draft/author-record.json`，绝不因输出路径已存在而回读遗留 `revision-record-payload.json`；遗留 payload 只能覆盖，不能成为冷启动输入。author base 缺失对象式 evidence ledger 或把 provenance 对象冒充 ledger 时必须从 author 节点重做。显式 retry/abandon 后，`register` 可以只对目标节点执行受控 packet 原子替换；其他已绑定 packet/output/receipt 仍逐字重验，不能借此绕过篡改检查。

生产命令把职责明确分开：`manual:packet` 只物化当前 role 的 exact allowlist 并返回 register 参数；新 packet 还在自身稳定签名中内联角色专属 `outputContract`，明确固定输出/receipt 路径、必需字段、正式量表和跨运行时语义 SHA 算法，leaf 不再依赖口头补充 schema。旧 packet 仅保留验证兼容。`manual:records` 只在四角色都由 runner 标记为 `validated` 后执行确定性密封。两者均不创建 subagent、不调用 LLM/API，也不生成论文 prose。

`technical_scoring` 的 runner submit 是正式评分闭环门禁：`dims` 必须按八维顺序、各自上限与一位小数约束填写，总分不超过 10，开源维度只接受固定锚点；同时要求 `confidence`、恰好 8 条论文特定 `scoringReasons`，以及精确覆盖八维证据 ID 的独立 Terra-high `scoringCalibration`。缺字段、自创 0–10 量表或普通 JSON hash 均在 review submit 阶段失败，不能延迟到 revision binder。

`manual:bind-revision` 消除 revision 阶段重复手抄 40–60KB JSON 的序列化风险。leaf 仍独占本篇语义工作并提交终稿、修正后的未封印 payload 与 `manual-v6-revision-binding-map-v1`；binder 只执行标题拆分、表格精确渲染、artifact ID 解析和 SHA/receipt 绑定，并从 runner 已验证的 technical / pedagogy 输出确定性回填评分与可读性字段。draft 可保留其真实 allowlist 中的 `E1` 风格 ID，binder 会把 ledger 和所有精确依赖引用一起规范化为 `E01`，任何规范化碰撞都 fail closed。它不替 leaf 做语义写作或复核判断；任何未实际进入正文的像素事实、公式解释、术语定义或相关工作差异都会被正式 longform validator 拒绝。

独立审计前必须先运行 `manual:bind-revision -- --date <date> --paper <id> --preflight`。它只在内存中把当前 article/map、runner validated reviews 和 author base 重放为未封印 record，执行完整 records-v4 与 longform 校验；不读取或创建 audit，不写 payload/output/receipt，也不改变 runner 状态。只有 preflight 通过的当前 article/map SHA 才能交给独立 audit，避免把审计槽浪费在 researchBrief、editorial review、开源状态或基础 record 字段错误上。

revision leaf 仍不得读取旧 `author-record` prose。若完整 record 门禁要求 result claim 的 `readerNarrative` 逐字进入辅助实验栏目，binding map 可用 `recordPatches.editorialSections` 从当前允许证据冷启动替换 `summary/method/innovations/results/details/limits/open` 中必要的栏目；`editorialReview` 继续单独提交。这样 resultClaims 可以绑定 fresh `editorialSections.results`，无需为迁就旧 base 扩大 deny-by-default 读取权限。

血缘分为初稿和终稿两段：`authorReceipt` 只绑定初稿 author packet/output/article；`finalRevisionAuthorReceipt` 必须来自独立 `author_revision` task，并唯一绑定最终 article。四个 taskName 必须互不相同。

revision output v2 固定绑定 `draft/final-article.md` 与未封印的 `draft/revision-record-payload.json`。payload 明确不得包含 `reviewReceipts`、`reviewResolution`、`sealedRecordSha256` 或两段 author receipt。runner 重开文件并验证 raw/semantic SHA 后，sealer 才注入真实 receipts、findings resolution 与两段 author provenance，并以“删除 `sealedRecordSha256` 后的对象”计算 sealed SHA。这个顺序避免 record 与 receipt 互相包含对方哈希形成循环。

revision binder 会把早期 author record 中不统一的开源描述按已验证的开源评分和真实 HTTPS 证据规范化：已发布、部分发布、承诺发布、仅 demo、仅正文引用而无直达链接、未发布分别落到 `released` / `partial_release` / `promise` / `demo_only` / `reference_only` / `none`。其中 `reference_only` 只接受 0.2 分且不得携带 URL；1.0 分以上必须有 HTTPS 资源 URL，并确定性补齐至少一种已发布资源标志。评分与证据冲突时 fail closed，不能靠中文自由文本绕过。

## records v4 与 reader-longform-v2

records v4 是 records v3 质量门禁的严格超集，并增加：

- author、technical、readability、revision 四个互异的 Terra-high task receipt；
- packet、receipt、output 的真实路径、字节 SHA 与语义 SHA；
- complete ArtifactIndex 原始字节和语义身份；
- reviewer findings 到 revision resolution 的逐项闭环；
- `reader-longform-v2`；
- `sealedRecordSha256`。

其中 author receipt 是初稿来源，revision receipt 同时作为 `finalRevisionAuthorReceipt` 和 `reviewReceipts.authorRevision`，两处必须语义完全一致；publisher 也会再次重放这一约束。

`reader-longform-v2` 将正文拆成 6–32 个承担明确教学职责的 blocks，按问题→方法/信号路径→结果→边界递进。所有 blocks 确定性重放为最终 article。

硬门禁包括：

- 每张结果表必须进入正文，数值 cell ID 覆盖率为 100%；
- Markdown 表由 ArtifactIndex 源矩阵确定性渲染，不能手工改数；
- 每张图、每个公式逐项使用或给出可审计 omission；
- 图片 visible facts、公式原式与解释必须进入绑定 block；
- 术语定义和 related-work 关系/差异必须进入正文；
- 精确数字、设备、帧数、时长、规模与科学计数法只能来自本篇来源或显式 derived fact；
- 内部 schema 名称不得泄漏到读者正文。

## spec v6 与 Merkle 闭包

official assembler 必须重新打开 filtered、全文 manifest、ArtifactIndex manifest、records v4 envelope、每篇 artifact root、record、四类 packet/receipt/output、reader-longform bundle 和 sealed record，并检查全批论文集合与 task name 唯一性。

每篇先构建 paper shard；批次使用成对哈希 Merkle tree 计算 root。spec 固定绑定 runtime mode、records/spec/manual-depth 版本、全部输入文件 SHA、per-paper shard、paper payload、task evidence、assembler protocol SHA 和 batch Merkle root。

输入变化时，未加 `--force` 不得覆盖既有 spec。`--force` 只允许明确替换，不绕开任何 validator。

## canonical production ingestion

production ingestion 只接受受控 `manual-v6/<date>/spec.json`；shadow ingestion 只接受同日 shadow spec。ingestion 会再次运行 official assembler并比较整个 spec 的稳定签名。

正式 canonical 逐篇写入，并包含：

- `manualDepth=full-text-evidence-v6`；
- canonical `manualTakeover` 继续使用发布侧可重放的 provenance v2；paper spec shard 另声明 `takeoverVersion=3`；
- runtime mode；
- spec root、paper shard、sealed record、records envelope、ArtifactIndex、task evidence 和 longform SHA；
- 结构化 ArtifactIndex 与 reader-longform bundle；
- 原有八维评分、claims、图片、来源和阶段审计。

production 成功时同步 `papers.json.digestStatus`；shadow 永不更新。已有非 v6 成功 canonical 不能静默复用，必须显式 `--force`，且 force 仍会重放全部 v6 输入。

## 发布、review、push 与视觉

在本文件描述的显式 Manual production 路径中，`blog:generate` 只接受完整 v6 批次：每篇 canonical 都是 v6、runtime mode 都是 production、全批绑定同一个 spec Merkle root，并且不允许 v5/v6 混批。默认 API 日更另走 `llm_api_production` proof，不属于本节的 Manual 输入。

legacy v5 只能通过显式 maintenance 参数生成，不能建立发布后视觉任务。shadow canonical 即使指定 `--data-file` 也必须被 production 门禁拒绝。

逐页 review 继续使用不可变 page artifact。每个页面必须由独立 Terra-high leaf 生成 v3 shard；汇总后由 Manual attestation、确定性 Markdown/Hugo gate 签发 receipt。review worker 只读，任何修改建议都让页面失败并返回生成或修订阶段。

push 再次复验 generation、页面字节、Manual production proof、receipt、Git 基线和 commit delta；只有远端 `main` OID 与本地 publication commit 完全相同才记录发布成功。显式 Manual 视觉任务只接受这种 production v6 receipt；默认 API 批次使用对应的 `llm_api_production` receipt。

## 性能与可观测性

production metrics 写入 `manual-v6/<date>/metrics/`，shadow metrics 写入对应 shadow 根。所有时间必须来自单调时钟；无法观测的 queue/host wait 写 `unknown`，不能用墙钟时间戳相减。

sidecar 绑定输入/输出真实路径、bytes 和 SHA。metrics 写入失败不改变内容或发布结果，但报告必须显示缺失。跨批报告只有在同一指标覆盖至少 3 个不同日期后才能计算 nearest-rank P50/P95；否则为 `insufficient_data`。

## 路径、字节身份与协议升级

源码位置和运行证据位置必须分开理解：Manual 实现、Prompt 与契约位于 `manual/`；production 证据仍位于 `data/current/manual-full-text/<date>/` 与 `data/current/manual-v6/<date>/`。源码整理不会迁移、重签或提升任何运行工件。实现通过项目根、模块目录、配置对象或 Python import 找到共享边界只是加载机制，不是 provenance；最终身份来自解析后的真实路径、文件字节、SHA 与稳定协议签名。

协议依赖包括 Prompt、编辑参考契约、packet allowlist/output contract、schema/validator、稳定 JSON/Unicode 规则、binder/sealer/assembler 实现。任一依赖字节变化都可能改变 packet、protocol 或 assembler fingerprint。对正在运行的批次，runner 应把受影响节点及后代显示为 `stale`，主 Agent从最早失效节点重新物化和验证；不得在旧 packet/spec/canonical 内替换 SHA。对历史工件，只要其自带的旧依赖仍可按绑定字节重放，就保留只读验证，不把它改签为当前 production。

因此路径迁移必须同时完成三件事：更新加载路径、让新 fingerprint 反映当前实现、保留历史读取器对旧绑定的明确兼容。只完成第一件事会造成“代码能运行但证据身份错误”；复制旧数据到新目录则不能替代后两件事。

## 失败恢复

- raw/select/fulltext 沿用日期锁与逐来源/逐论文 checkpoint；
- ArtifactIndex incomplete 只重抓或重建对应论文；
- packet/input SHA 变化只使当前节点及后代 stale，兄弟 review 可复用；
- 活动 claim 只有平台确认任务终止后才可显式 abandon；
- spec/canonical 任一集合、identity、路径、SHA 或 Merkle 不匹配均 fail closed；
- review 修改页面后只重审 SHA 变化页，批次 receipt 重新收口；
- push 失败可复用已验证本地 commit，但不能声称已发布；
- production 失败不得自动回退 v5。

## 持续验收矩阵

代码合并前必须通过：

1. Node 单元测试与全部 JS `node -c`；
2. Python 单元测试与全部 Python `py_compile`；
3. shell `bash -n`；
4. production/shadow 路径隔离测试；
5. v5→v6 静默复用拒绝测试；
6. shadow canonical 发布拒绝测试；
7. v5/v6 混批发布拒绝测试；
8. production proof 在 generation→review→push 的漂移拒绝测试；
9. records v4/ArtifactIndex/longform/Merkle 任一字节变化的 fail-closed 测试；
10. 一批新鲜真实数据的完整 production v6 实跑。

第 10 项是运行验收，不允许用 fixture 代替。至少 3 批数据前，性能报告只能显示 `insufficient_data`；这不阻止 v6 正式质量门禁，但禁止宣称已达到某个 P50/P95 提速数字。

## 兼容边界

- `manual:v5:*` 和 `--legacy-v5-maintenance` 只服务已有历史工件；
- legacy 路径不得为新批次创建可发布 records、sealed preview 或质量回归输入；`manual:v5:promote-draft` 只允许维护既有 v5 工件。仓库不再提供独立 v5 record 模板、单篇 validator 或 tutorial preview 写入口；
- v5 validator 可继续作为 v6 的基础子校验，但文档和日志必须称其为 compatibility/base validation，而不是默认主链；
- 保留既有 sealed preview、legacy receipt 和远端发布证据的只读复验能力，不得用清理写入口为由削弱历史读取。
