# 文档导航

默认读者先走 LLM/API 路线；只有明确需要人工高保障流程时才进入
[`manual/`](../manual/README.md)。如果只想运行一次日更，先看根目录
[`README.md`](../README.md) 的快速开始，不必从头阅读所有设计细节。

## 按任务选择

| 你要做什么 | 先读 | 再查 |
|---|---|---|
| 安装并配置模型、代理、博客仓库 | [环境与配置](setup.md) | [排错手册](troubleshooting.md) |
| 理解默认日更各阶段 | [主流程](workflow.md) | [数据格式](data-format.md) |
| 理解组件、状态机、锁与事务 | [默认 API 架构](architecture.md) | [契约兼容矩阵](compatibility.md) |
| 查某个命令或模块职责 | [脚本说明](scripts.md) | [`scripts/` 运行时索引](../scripts/README.md) |
| 下载论文与引用、复制 AI 提问 | [无需助手的博客阅读工具](blog-reading-tools.md) | 博客“关于与方法”页面 |
| 修改评分、Prompt、路径或契约 | [维护约定](maintenance.md) | [数据格式](data-format.md) |
| 完整离线验收、CI 与故障回放 | [维护指南：验证矩阵](maintenance.md#验证矩阵) | `npm run verify` |
| 完全不用旧生成文本重写一个既有日批次 | [从原文完整重写](fresh-rewrite.md) | `npm run rewrite:source` 分阶段入口 |
| 全历史重写：本地会议 PDF 与 fresh arXiv PDF/TXT 直达私有 staging | [历史重写底座](history-rewrite.md) | `conference-local-sources → direct-inputs → direct-plan → direct-run` |
| 审查并发布完成的 direct 全历史重写 | [全历史 direct publication 闭环](history-direct-publication.md) | immutable plan/generation → historical review → locked activation/commit/push → live OID status |
| 接管 2026-09-07 全历史重写现场 | [全历史重写交接](historical-rewrite-handoff-2026-09-07.md) | 先生成 local-direct catalog/plan；crosswalk 只处理 named arXiv fresh-failure handoff |
| 改进解读写法并比较重跑效果 | [Reader 写作与比较](reader-writing.md) | [维护约定](maintenance.md) |
| 整理历史标签、任务层级与分面检索 | [标签体系设计](tag-taxonomy-design.md) | [实施与验收计划](tag-taxonomy-implementation.md)、`npm run taxonomy:preview` |
| 抓取 2026 新会议、按日更同源流程深度理解并生成会议汇总 | [会议论文工作流](conference-workflow.md) | [来源研究记录](research/2026-conferences/report-source.md)；`conference:new:*`；官方 acquisition → discovery → filter → analysis → postprocess |
| 整理本机会议 PDF、重写历史会议论文并生成会议汇总 | [会议论文工作流](conference-workflow.md) | 原 `conference:*` 只在 history workspace；历史 URL 映射与 review/push 未完成 |
| 判断历史 ICASSP/ICLR/ICML 分支哪些能力可以迁回 main | [历史会议分支审计](conference-branch-audit.md) | [会议论文工作流](conference-workflow.md) |
| 显式运行 Manual/人工路线 | [Manual 入口](../manual/README.md) | [Manual 工作流](../manual/docs/workflow.md) |

面向新用户，推荐顺序是 `README → setup → workflow → troubleshooting`；维护者再继续阅读
`scripts → architecture → data-format → compatibility → maintenance`。Agent 的执行约束仍以根目录 `AGENTS.md` / `SKILL.md`
为准，本文只负责导航。

## 默认生产链路

```text
抓取 → 关键词预筛 → LLM 筛选 → 封存本次官方 arXiv TXT/PDF → 多阶段全文分析
     → 博客 generate → review → push/远端 OID
     → TOP 10 长图与汇总封面 → digest:status
```

`npm run digest:prepare -- YYYY-MM-DD` 是默认入口，`digest:api` 是同义命令。
Manual 不会因模型、网络或配额失败而自动启用。微信、飞书、小红书也不属于默认
日更链路。

2026 新会议先完成与 discovery 全集闭合的 PDF 摘要 evidence run，再生成一份绑定当前日更
Prompt、关键词预筛版本、解析合同、有效 `FILTER_CONFIG`、evidence locator、模型路由和
taxonomy SHA 的**每会独立** filter spec，最后为同一 discovery/evidence 对建立 filter。spec
命令必须同时认证 catalog、report 和已 complete 的 evidence run；共享 v4 spec 或把其他会议的
spec/evidence run 混入都会失败关闭：

```bash
npm run conference:new:filter -- spec \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --evidence-run EVIDENCE_RUN_UUID --output iwslt-2026-filter-v5.json
npm run conference:new:filter -- prepare \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --evidence-run EVIDENCE_RUN_UUID \
  --spec iwslt-2026-filter-v5.json
```

`prepare` 输出的 `filterId` 是后续运行和恢复键。先用 `--limit 1` 完成该 filter 的健康
探针，再用同一参数去掉 limit 续跑；失败项只能显式加 `--retry-failed` 并遵守退避与
次数上限。推荐的全局并发是最多同时运行 5 个**不同 filter** 的 worker；同一个 filter
必须单飞，因为其 durable intent、原始响应、usage receipt 与 CAS 状态共用一把锁。不要
对同一 `filterId` 启动并发 worker，也不要在中断后换 catalog、spec 或 filterId。
会议 runner 与日更使用相同的结构化决定解析器，但不会在一次 durable intent 内追加日更的
malformed-format repair 请求：无法解析的响应记为 `failed`，保留原始响应和 usage，待退避后
由 `--retry-failed` 创建新的、可独立计费审计的 intent。

```bash
npm run conference:new:filter:run -- --apply \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --evidence-run EVIDENCE_RUN_UUID \
  --spec iwslt-2026-filter-v5.json --filter FILTER_UUID --owner iwslt.health --limit 1
npm run conference:new:filter:run -- --apply \
  --catalog iwslt-2026.json --report iwslt-2026-report.json \
  --evidence-run EVIDENCE_RUN_UUID \
  --spec iwslt-2026-filter-v5.json --filter FILTER_UUID --owner iwslt.worker
```

## English documentation

Start with the English [project README](../README.en.md), then use
[Setup](en/setup.md), [Workflow](en/workflow.md), [Scripts](en/scripts.md),
[Architecture](en/architecture.md), [Data formats](en/data-format.md),
[Compatibility](en/compatibility.md), [Maintenance](en/maintenance.md), and
[Troubleshooting](en/troubleshooting.md).
