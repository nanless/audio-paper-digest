# Paper Digest

**语音 / 音乐 / 音频论文速递自动化流水线**

**[English](README.en.md)** · 中文

从 arXiv 与 HuggingFace Papers 抓取候选论文，经 LLM 筛选和多阶段全文分析，生成
每日汇总页、每篇中文深度解读，以及发布后的 TOP 10 论文长图和汇总封面。

## 你会得到什么

- 一份可续跑、可审计的当日候选、筛选决定和深度分析数据。
- 一篇每日汇总博客，以及每篇论文面向初学研究者的连续中文解读。
- 完整作者机构与八维评分；原文存在且可验证时纳入公式、实验表格、论文图和复现资源。
- 博客远端发布成功后生成的 TOP 10 论文长图与一张批次汇总封面。

## 默认行为

默认路线是 LLM/API，不是人工流程：

```text
arXiv + HuggingFace
  → 关键词预筛 → LLM 逐篇筛选 → 多阶段全文分析与评分
  → 博客 generate → review → push / 远端 OID 验证
  → TOP 10 长图与汇总封面 → 最终状态验收
```

- `digest:prepare` 与 `digest:api` 是同一条默认路线。
- Manual/人工高保障流程只有在明确选择时才启用；API、网络或配额失败不会自动切换。
- 微信、飞书、小红书是可选集成，不属于默认日更。

## 5 分钟开始

要求：Node `>=20.18.1 <21 || >=22.3.0`、Python 3.11+（OpenSSL 后端），以及可用的 Hugo 博客仓库。

```bash
# 1. 安装依赖
npm install
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt

# 2. 创建项目配置
cp env.example .env
```

在项目根 `.env` 中至少填写：

```dotenv
PAPER_ANALYZER_API_KEY=...
PAPER_ANALYZER_MODEL=...
PAPER_ANALYZER_ENDPOINT=https://...
HTTPS_PROXY=http://127.0.0.1:7897   # 也可按 setup 使用 HTTP_PROXY
```

模型、协议和代理要求见[环境配置](docs/setup.md)。项目脚本需要在沙箱外运行；入口会在
网络、日志和写入前拒绝受限沙箱。

```bash
# 3. 运行 Node 测试
npm test

# 4. 运行北京时间当天的完整脚本阶段
today="$(TZ=Asia/Shanghai date +%F)"
npm run digest:prepare -- "$today"
```

`digest:prepare` 会完成数据流程和博客发布，并准备视觉任务，但不会自行调用图像 API。
随后由 Codex 内置生图完成并目检视觉资产，或在用户明确取消时签发可审计豁免。

```bash
# 5. 最终验收
npm run digest:status -- --date "$today"
```

## 怎样才算完成

一次完整日更同时满足：

1. 抓取来源、筛选决定和深度分析均为完整终态。
2. 汇总页和全部论文页通过 review，博客提交已推送且远端 OID 匹配。
3. TOP 10 长图与汇总封面均已登记，或存在绑定当前发布版本的显式视觉豁免。
4. 最新 `digest:status` 不再报告未完成阶段。

博客已经发布后，视觉失败不会反向撤销博客，也不应触发博客重新生成或重新审查。

## 核心命令

| 目的 | 命令 |
|---|---|
| 默认当天日更 | `npm run digest:prepare -- YYYY-MM-DD` |
| 续跑未完成分析 | `npm run deep -- --date YYYY-MM-DD` |
| 刷新 API Reader | `npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader` |
| 校验 current 数据 | `npm run validate:data` |
| 查看运行数据占用 | `npm run storage:status` |
| 预览引用感知清理 | `npm run storage:prune` |
| 查看最终状态 | `npm run digest:status -- --date YYYY-MM-DD` |
| 单独执行博客三阶段 | `npm run blog:generate` → `npm run blog:review` → `npm run blog:push` |
| 用户明确取消视觉 | `npm run digest:waive-visuals -- --date YYYY-MM-DD --reason "..."` |
| 显式 Manual 路线 | `npm run digest:manual -- YYYY-MM-DD` |

所有入口、参数和恢复语义见[脚本说明](docs/scripts.md)；文件到职责的一页索引见
[`scripts/README.md`](scripts/README.md)。

## 失败后从哪里继续

- 抓取或筛选中断：直接重跑默认入口，健康 checkpoint 会复用。
- 只有部分论文分析失败：运行 `npm run deep -- --date YYYY-MM-DD`，或按论文定向重分析。
- 博客审查或推送失败：修复后运行 `npm run blog:review -- --date YYYY-MM-DD` 或 `npm run blog:push -- --date YYYY-MM-DD`。
- 视觉任务缺失或失效：运行 `npm run visual:post-publish -- --date YYYY-MM-DD`，不要重发博客。
- 不确定失败属于哪一层：先看[排错手册](docs/troubleshooting.md)和
  [主流程](docs/workflow.md)。

从 fetch 开始只能绑定北京时间当天。历史批次必须基于已存在的受控数据，从相应恢复
阶段继续，不能伪造日期重新抓取。

## 架构概览

```text
Node.js 数据层
  fetch / filter / deep analysis / state / visual manifests
                         ↓
Python 发布层
  Hugo generation / page review / Git transaction / remote verification
                         ↓
Codex 视觉层
  built-in image generation / visual QA / asset record
```

默认 API 与显式 Manual 共用博客发布和视觉边界，但内容证据与 provenance 独立，不能混批。
Manual 的脚本、Prompt、测试和工作流集中在 [`manual/`](manual/README.md)。

## 数据与输出

| 位置 | 内容 |
|---|---|
| `data/current/` | 当前候选、筛选、分析、发布凭证和视觉任务状态 |
| `data/archive/<date>/` | 每日数据快照与最终视觉资产 |
| `logs/` | 脱敏后的运行日志，可在 `.env` 中关闭文件日志 |
| Hugo 博客仓库 | 汇总页、论文页、主题模板与发布提交 |

字段和跨文件一致性见[数据格式](docs/data-format.md)。

## 开发与维护

```bash
npm run test:default       # 默认 API 与共享 Node 测试
npm run test:manual        # 显式 Manual Node 测试
npm test                   # 两者一起运行
```

CI 还运行 Python 单测、JS/Python/shell 语法检查和空数据结构校验。修改配置、评分、
Prompt 或持久化契约前，请阅读[维护约定](docs/maintenance.md)。

## 文档导航

- [文档总览](docs/README.md)：按任务选择下一篇文档。
- [安装与配置](docs/setup.md)：环境变量、代理、模型和博客仓库。
- [默认主流程](docs/workflow.md)：归档、抓取、筛选、分析、发布和恢复。
- [默认 API 架构](docs/architecture.md)：组件调用、单篇 DAG、锁和跨仓库事务。
- [脚本说明](docs/scripts.md)：命令参数和运行语义。
- [数据格式](docs/data-format.md)：checkpoint、canonical、receipt 和 manifest。
- [契约兼容矩阵](docs/compatibility.md)：当前 writer、历史读取和 production 资格。
- [排错手册](docs/troubleshooting.md)：API、代理、分析、发布和视觉问题。
- [Manual 子系统](manual/README.md)：显式人工高保障路线。

## 可选集成

微信公众号、飞书和小红书入口仍可独立使用，但不由默认日更调用。相关命令集中在
[脚本说明](docs/scripts.md#43-发布脚本)。

## 参考与致谢

项目设计参考了 [speech-paper-daily-skill](https://github.com/JusperLee/speech-paper-daily-skill)。
