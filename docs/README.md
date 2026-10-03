# 文档导航

默认运行 LLM/API 日更。第一次使用请先看根目录 [README.md](../README.md) 的快速开始，再按下面的任务查阅说明。只有用户明确选择人工流程时，才进入 [Manual 子系统](../manual/README.md)。

## 按任务选择

| 你要做什么 | 先读 | 再查 |
|---|---|---|
| 安装依赖，配置模型、代理和博客仓库 | [安装与配置](setup.md) | [故障排查](troubleshooting.md) |
| 运行日更，或从中断处继续 | [主流程](workflow.md) | [数据格式](data-format.md) |
| 理解模块、状态、锁和发布顺序 | [默认 API 架构](architecture.md) | [兼容规则](compatibility.md) |
| 查命令参数或脚本职责 | [脚本说明](scripts.md) | [`scripts/` 索引](../scripts/README.md) |
| 下载论文原文、导读和引用，或批量导出资料 | [博客阅读工具](blog-reading-tools.md) | 博客“关于与方法”页面 |
| 修改评分、提示词、路径或数据格式 | [维护约定](maintenance.md) | [数据格式](data-format.md) |
| 执行离线验证或排查故障恢复 | [验证矩阵](maintenance.md#验证矩阵) | `npm run verify` |
| 根据原文重写一个已有日批次 | [从原文完整重写](fresh-rewrite.md) | `npm run rewrite:source` 的分阶段入口 |
| 重写全部历史论文与汇总页 | [历史重写流程](history-rewrite.md) | 本地会议来源、论文计划、来源准备和逐篇重写命令 |
| 审查并发布历史重写结果 | [历史发布流程](history-direct-publication.md) | `history:direct-publication` 的生成、审查、发布和状态查询 |
| 查找 2026-09-07 的历史运行记录 | [归档交接记录](historical-rewrite-handoff-2026-09-07.md) | 只供定位当时文件；不能按旧命令启动当前任务 |
| 改进解读写法，比较重写前后的文章 | [解读写作与比较](reader-writing.md) | [维护约定](maintenance.md) |
| 设计标签、检查历史标签映射或分类显示 | [标签体系设计](tag-taxonomy-design.md) | [实施计划](tag-taxonomy-implementation.md)、[显示规则](taxonomy-presentation-policy.md)和 `npm run taxonomy:preview` |
| 抓取并处理 2026 年新会议论文 | [会议工作流](conference-workflow.md) | `conference:new:*`；[来源研究记录](research/2026-conferences/report-source.md)说明研究时的覆盖范围 |
| 整理本地会议 PDF，处理历史会议论文 | [会议工作流](conference-workflow.md) | 原 `conference:*` 在历史工作区运行；发布历史页面另查[历史发布流程](history-direct-publication.md) |
| 查看会议处理曾出现的故障与修复范围 | [2026-09-12 修复记录](conference-repair-notes.md) | 文中的验证结果与待修旧页面属于记录当时的范围 |
| 核对旧会议分支的迁移限制 | [2026-09-06 分支审查](conference-branch-audit.md) | [当前会议工作流](conference-workflow.md) |
| 显式运行人工流程 | [Manual 入口](../manual/README.md) | [人工流程操作说明](../manual/docs/workflow.md) |

日常运行通常只需阅读安装、主流程和排错说明。维护代码时，再查看脚本、架构、数据、兼容和维护文档。根目录 [AGENTS.md](../AGENTS.md) 与 [SKILL.md](../SKILL.md) 保留执行约束和完整操作要求。

## 默认日更

```text
抓取候选 → 关键词预筛 → 模型筛选 → 保存本次官方论文文本与 PDF
        → 全文分析与评分 → 生成博客 → 审查 → 推送并核对远端提交
        → 配图生成与登记 → 最终核验
```

默认入口是 `npm run digest:prepare -- YYYY-MM-DD`，`digest:api` 与它等价。模型、网络或额度失败不会自动切换到人工流程；微信、飞书和小红书也不属于默认日更。

脚本成功退出后，仍需完成内置生图及目检，或记录用户明确取消配图的选择。宣告任务完成前，还须确认 GitHub Pages 构建、部署及每篇页面核验通过，重新读取最终状态。具体要求见[主流程](workflow.md)。

新会议的摘要提取与每会独立筛选配置见[会议工作流](conference-workflow.md)，首次运行、并发和恢复见[筛选健康检查、并发与恢复](conference-workflow.md#筛选健康检查并发与恢复)。历史重写只在历史工作区运行；独立历史发布入口已存在，但生成了暂存页面并不代表整批已经审查或发布。

## English documentation

Start with the English [project README](../README.en.md), then use
[Setup](en/setup.md), [Workflow](en/workflow.md), [Scripts](en/scripts.md),
[Architecture](en/architecture.md), [Data formats](en/data-format.md),
[Compatibility](en/compatibility.md), [Maintenance](en/maintenance.md), and
[Troubleshooting](en/troubleshooting.md).
