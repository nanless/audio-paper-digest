# Manual 文档地图

Manual 只在用户明确选择人工流程时使用；默认 LLM/API 主线不在这里展开。先根据你的职责进入对应文档。

| 你正在做什么 | 读哪一份 | 读完应该能回答什么 |
|---|---|---|
| 第一次运行或续跑一个批次 | [workflow.md](workflow.md) | 当前阶段、下一条命令、需要创建哪个 leaf、失败后从哪里恢复 |
| 修改 task runner、packet、records、spec、canonical 或 publisher 门禁 | [architecture.md](architecture.md) | 组件所有权、证据闭包、路径/SHA 身份和历史兼容边界 |
| 撰写或复核一篇研究生入门教程 | [editorial-reference-contract.md](editorial-reference-contract.md) | 如何组织问题、方法、训练、数据、图表、实验与限制 |
| 只想确认 Manual 是否适用 | [目录入口](../README.md) | 进入条件、最短路径和不可混用的模式 |

## 最少术语

| 术语 | 人类可读解释 |
|---|---|
| `ArtifactIndex` | 从论文结构化来源中恢复出的表、图、公式、术语、章节和引用清单。`complete` 表示检测与恢复闭环，不等于论文内容质量高。 |
| `packet` | 一个 leaf 被允许读取的文件集合和必须写出的结果格式；默认拒绝未列出的输入。 |
| `receipt` | runner 对某次角色提交的可重放凭证，绑定任务、输入、输出与 SHA。 |
| `record v4` | 一篇论文四个角色及其来源证据的密封结果。 |
| `spec v6` | 整批 record、来源、任务证据和 Merkle root 的发布前闭包。 |
| `canonical` | 博客生成器真正消费的标准深度分析数据；Manual production provenance 必须能从这里反向重放。 |
| `stale` | 某个已注册节点的输入或协议身份已变化，必须从该节点及下游重新验证。 |
| `shadow` | 与 production 隔离的审计/比较模式，不能发布。 |
| `legacy v5` | 只为历史工件保留的维护与复演能力，不是新批次捷径。 |

## 文档与 Prompt 的边界

- [manual-tutorial-article.md](../prompts/manual-tutorial-article.md) 是 production author packet 的主要写作 Prompt。
- [manual-analysis-record.md](../prompts/manual-analysis-record.md) 是 legacy/base 兼容输入，不是默认 API Prompt，也不是 production author 的替代品。
- `editorial-reference-contract.md` 和两个 Prompt 都会被真实 SHA 绑定。修改它们会影响新 packet 或下游 fingerprint；历史工件仍按自身绑定的旧字节只读复验。

代码与文档冲突时，以当前 runner、validator 和 publisher 的 fail-closed 行为为准，并同步修正文档。不要用文档描述绕过实现门禁。
