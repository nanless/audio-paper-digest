# Manual 论文速递

Manual 是项目的显式人工流程。主助手为每篇论文安排独立助手，每名助手只处理一篇论文的一个角色任务，完成相应的筛选、论文理解、教程写作、评分或页面审查；项目脚本负责抓取、提取结构化证据、确定性校验、博客发布和远端验证。

项目默认日更是 LLM/API。只有用户明确要求“Manual”或“人工流程”时才进入本目录描述的流程：

```bash
npm run digest:manual -- YYYY-MM-DD
```

网络、模型或配额失败不会自动切换到 Manual。进入 Manual 仍须满足原有质量与来源要求，不能把它当成跳过校验的备用路线。

## 这套文档给谁看

| 读者 | 先读 | 需要解决的问题 |
|---|---|---|
| 第一次运行批次的人 | 本页 → [运行手册](docs/workflow.md) | 从哪里开始、下一条命令是什么、失败后从哪里恢复 |
| 主助手 | [运行手册](docs/workflow.md) | 如何分配任务包、创建单篇助手、提交角色结果并汇总整批 |
| 单篇写作或审查助手 | [写作与审查要求](docs/editorial-reference-contract.md)和 packet 内文件 | 如何把一篇论文写清楚、如何审查证据与可读性 |
| 维护任务管理、结果汇总和发布器的开发者 | [架构说明](docs/architecture.md) | 哪些文件是校验依据、哪些变更会导致 SHA 不符、旧格式还能做什么 |
| 历史维护人员 | [架构说明的兼容章节](docs/architecture.md#历史兼容边界) | 哪些旧文件只能重新验证，哪些入口仍可显式维护 |

## 最短完整路径

```text
原始候选
  → manual_offline 全量逐篇筛选
  → 结构化全文 + complete ArtifactIndex
  → author 写作
  → technical_scoring 技术评分 + pedagogy_readability 可读性审查
  → author_revision 修订 + 独立复核
  → records v4 单篇结果
  → spec v6 整批发布输入 + batch Merkle root
  → 正式分析结果
  → 博客生成 → 独立逐页审查 → 推送 → 远端 OID 验证
```

任务包 `packet` 指定一篇论文、一个角色允许读取的文件白名单，以及必须提交的结果格式。任务管理器 `runner` 保存任务状态，并核验任务包、输出和提交凭证；它不创建单篇助手，也不写论文内容。

四个角色都验证通过后，`manual:records` 汇总每篇角色结果及证据。`manual:spec` 核验整批论文、来源、任务结果和正文，生成逐篇文件与 batch Merkle root；`manual:analyze` 再次核验它们，写入博客生成器读取的正式分析结果。`records`、`spec` 和这份最终结果各有用途，不能互相替代。

## 主链命令

```bash
# 1. 抓取候选并提交完整人工筛选决定
npm run manual:fetch -- --date YYYY-MM-DD --raw
npm run manual:fetch -- --date YYYY-MM-DD --select FILTER_SPEC.json

# 2. 获取结构化全文和来源清单 ArtifactIndex
npm run manual:fulltext -- YYYY-MM-DD

# 3. 初始化、查看并推进单篇角色任务
npm run manual:tasks -- init --date YYYY-MM-DD
npm run manual:tasks -- status --date YYYY-MM-DD
npm run manual:packet -- --date YYYY-MM-DD --paper ARXIV_ID --role ROLE

# 4. 四个角色全部 validated 后汇总并核验整批
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

`ROLE` 只能是 `author`、`technical_scoring`、`pedagogy_readability` 或 `author_revision`。`manual:packet` 会输出指向当前真实路径的任务注册参数；必须使用该输出，不能从示例手抄任务包路径或输出文件根目录。

推送后还须人工核验对应 GitHub Pages 部署和每页的 HTTP 200、正式地址、标题。远端 OID 或状态报告不能替代上线核验；共同的发布后视觉与完成要求见[根目录操作手册](../SKILL.md)。

完整的 `register`、`claim`、`start`、`submit` 命令，以及修订结果核验、元数据纠错和恢复方式见[运行手册](docs/workflow.md)。

## 谁负责什么

| 参与者 | 负责 | 明确禁止 |
|---|---|---|
| 用户/批次负责人 | 明确选择 Manual、确定日期和发布范围 | 把普通失败解释为自动 Manual 授权 |
| 主助手 | 维护队列，生成并注册任务包，直接创建单篇助手，记录真实任务名，汇总结果并发布 | 让 runner 创建单篇助手；把多篇论文交给一个单篇助手 |
| 单篇助手 | 只读取 packet 白名单中的文件，完成一篇论文、一个角色的内容工作 | 读取其他论文、旧博客、旧分析或未经授权的前一版草稿 |
| runner/binder/sealer | 验证任务依赖、路径、字节、SHA 和规定的结构 | 调用模型、补写事实、替审查者作内容判断 |
| 发布器与审查检查 | 核验最终页面、Git 基线、发布提交和远端 OID | 发布隔离审计、旧 v5 或不完整的正式分析结果 |

平台共 4 个并发槽，主助手占 1 个；正文阶段最多同时运行 3 个单篇助手。一个任务结束后由主助手分配下一篇，不能额外创建只负责转交任务、却占用并发槽的助手。角色结果须由对应角色提交，写作、技术评分与可读性审查不能互相代替。

## 数据与源码边界

```text
manual/
├── README.md
├── docs/       # 本路线的详细文档
├── prompts/    # 任务包和发布输入按实际 SHA 核验的提示词
├── scripts/    # 任务管理、结果汇总、隔离审计、发布审查和历史维护
└── tests/      # Manual 专用测试与样例数据

data/current/
├── manual-full-text/<date>/       # 全文、结构化来源和 ArtifactIndex
├── manual-v6/<date>/              # 正式任务、单篇结果、发布输入和统计证据
└── manual-v6-shadow/<date>/       # 隔离审计证据；禁止发布
```

移动源码不会迁移或重新生成 `data/current/` 中的证据。提示词、编辑要求、schema、校验器或协议实现的字节变化会改变 SHA 或指纹。当前校验还会核对仓库固定文件的 SHA，因此旧任务包或预览可能被拒绝，不能仅凭旧包保存的副本继续使用。保留旧证据，按正常任务流程从最早失效节点重新处理；不能修改旧 records 或其他 JSON 来补出新的 SHA。

## 开始前的五项检查

还须遵守根目录的工作区角色、环境与沙箱要求。Manual 日更使用 `daily` 工作区，先运行 `npm run workspace:role -- status` 确认。

1. 用户明确要求采用人工流程（Manual）。
2. 日期使用 `YYYY-MM-DD` 格式，抓取结果、筛选结果和全文材料来自同一批次。
3. 每篇论文的材料索引（ArtifactIndex）最终状态为 `complete`。
4. 每个单篇助手只处理一篇论文，并且只承担一个角色；模型和推理等级由任务包指定。
5. 正式流程、隔离审计（shadow）、旧 v5 记录维护和教程预览分别使用各自的路径与文件，不能相互混用。

任一项不满足时先看[恢复矩阵](docs/workflow.md#十状态与恢复矩阵)，不要猜测状态后用 `--force` 强行推进。
