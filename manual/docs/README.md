# Manual 文档导航

Manual 只在用户明确选择人工流程时使用；默认 LLM/API 主线不在这里展开。根据当前任务选择对应文档。

| 你正在做什么 | 读哪一份 | 读完应该能回答什么 |
|---|---|---|
| 第一次运行或续跑一个批次 | [workflow.md](workflow.md) | 当前阶段、下一条命令、需要创建哪个单篇助手、失败后从哪里恢复 |
| 修改任务管理、任务包、结果汇总或发布检查 | [architecture.md](architecture.md) | 各组件负责什么、文件之间如何核验、路径与 SHA 限制及历史兼容范围 |
| 撰写或复核一篇研究生入门教程 | [editorial-reference-contract-v2.md](editorial-reference-contract-v2.md) | 如何组织问题、方法、训练、数据、图表、实验与限制 |
| 只想确认 Manual 是否适用 | [目录入口](../README.md) | 进入条件、最短路径和不可混用的模式 |

## 必要术语

| 术语 | 白话解释 |
|---|---|
| `ArtifactIndex` | 从论文结构化来源中恢复出的表、图、公式、术语、章节和引用清单。`complete` 表示来源检测与恢复流程满足完整性要求，不表示论文本身质量高。 |
| `packet` | 一个单篇助手允许读取的文件清单和必须提交的结果格式；默认拒绝未列出的输入。 |
| `receipt` | 任务管理器保存的角色提交凭证，可再次核验其任务、输入、输出和 SHA。 |
| `record v4` | 汇总并核验过的一篇论文四个角色结果及其来源证据。 |
| `spec v6` | 整批发布输入，包含角色结果、来源、任务证据和用于核验逐篇文件的 Merkle root。 |
| `canonical` | 博客生成器读取的正式分析结果；必须能据此重新核验 Manual 内容的来源与任务证据。 |
| `stale` | 某个已注册任务的输入或协议已变化，必须从该任务及其下游重新验证。 |
| `shadow` | 与正式结果隔离的审计或比较模式，不能发布。 |
| `legacy v5` | 原文件只读核验；旧写入入口已关闭，工作队列可输出观察统计，不能跳过新任务的正式流程。 |

## 文档与 Prompt 的边界

- [manual-tutorial-article.md](../prompts/manual-tutorial-article.md) 是正式写作任务包的主要提示词。
- [manual-analysis-record-v2.md](../prompts/manual-analysis-record-v2.md) 和 [editorial-reference-contract-v2.md](editorial-reference-contract-v2.md) 用于当前 Sol 模型规则，并按真实文件 SHA 绑定任务。它们不替代正式 v6 的主要教程提示词。
- [manual-analysis-record.md](../prompts/manual-analysis-record.md) 和 [editorial-reference-contract.md](editorial-reference-contract.md) 保留旧原字节，供旧记录按原身份只读核验。读取程序依据任务所属规则选择路径与 SHA，不从凭证自报规则取得授权，也不能重算旧 records 或 JSON 的 SHA 来冒充当前任务。

代码与文档冲突时，遵守当前任务管理器、校验器和发布器的检查结果；检查未通过就停止，并同步修正文档。不能用文档描述绕过实际检查。
