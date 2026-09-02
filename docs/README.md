# 文档导航

默认读者先走 LLM/API 路线；只有明确需要人工高保障流程时才进入
[`manual/`](../manual/README.md)。如果只想运行一次日更，先看根目录
[`README.md`](../README.md) 的快速开始，不必从头阅读所有设计细节。

## 按任务选择

| 你要做什么 | 先读 | 再查 |
|---|---|---|
| 安装并配置模型、代理、博客仓库 | [环境与配置](setup.md) | [排错手册](troubleshooting.md) |
| 理解默认日更各阶段 | [主流程](workflow.md) | [数据格式](data-format.md) |
| 查某个命令或模块职责 | [脚本说明](scripts.md) | [`scripts/` 运行时索引](../scripts/README.md) |
| 修改评分、Prompt、路径或契约 | [维护约定](maintenance.md) | [数据格式](data-format.md) |
| 显式运行 Manual/人工路线 | [Manual 入口](../manual/README.md) | [Manual 工作流](../manual/docs/workflow.md) |

## 默认生产链路

```text
抓取 → 关键词预筛 → LLM 筛选 → 多阶段全文分析
     → 博客 generate → review → push/远端 OID
     → TOP 10 长图与汇总封面 → digest:status
```

`npm run digest:prepare -- YYYY-MM-DD` 是默认入口，`digest:api` 是同义命令。
Manual 不会因模型、网络或配额失败而自动启用。微信、飞书、小红书也不属于默认
日更链路。

## English documentation

English mirrors are under [`docs/en/`](en/). The Chinese documents and current code remain
the most actively maintained source of operational detail.
