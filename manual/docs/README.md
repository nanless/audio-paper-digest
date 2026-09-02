# Manual 文档索引

Manual 是用户显式选择的人工高保障路线，不是项目默认流程。第一次执行请先读[目录入口](../README.md)，再按你此刻承担的职责选择文档；不需要为了运行一个批次通读全部协议字段。

| 文档 | 适用场景 | 内容边界 |
|---|---|---|
| [workflow.md](workflow.md) | 批次负责人或主 Agent：运行、续跑、定位阻塞 | raw/select、全文、task lifecycle、records/spec/canonical、review/push、恢复矩阵 |
| [architecture.md](architecture.md) | 维护者：修改 runner、records、spec、provenance 或兼容边界 | 组件所有权、数据布局、DAG、Merkle、路径/SHA、shadow 与 legacy |
| [editorial-reference-contract.md](editorial-reference-contract.md) | author/reviewer leaf 或编辑：撰写、复核单篇教程 | 读者顺序、教学递进、图表公式、实验、渲染与缓存 |

Prompt 位于相邻的 `../prompts/`：

- [manual-tutorial-article.md](../prompts/manual-tutorial-article.md) 是 production author packet 的教程写作规范。
- [manual-analysis-record.md](../prompts/manual-analysis-record.md) 是 legacy/base 分析兼容规范，不是默认 API Prompt。

文档与代码冲突时，以当前 Manual validator、runner 和 publisher 的 fail-closed 行为为准，并在同一变更中修正文档。`editorial-reference-contract.md` 与两个 Prompt 都是被真实 SHA 绑定的生产输入，不能把文字调整当成无行为影响的普通文档改动：已注册 packet 及其下游会因依赖 SHA 变化而失效，历史工件则继续按它自身绑定的旧字节作只读复验。
