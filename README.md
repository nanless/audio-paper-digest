# Paper Digest

**自动筛选、解读和发布语音、音乐与音频论文**

**[English](README.en.md)** · 中文

从 arXiv 与 HuggingFace Papers 抓取候选论文，经 LLM 筛选和多阶段全文分析，生成
每日汇总页、每篇中文深度解读，以及发布后的 TOP 10 论文长图和汇总封面。

## 你会得到什么

- 一份可续跑、可审计的当日候选、筛选决定和深度分析数据。
- 一篇每日汇总博客，以及每篇论文面向初学研究者的连续中文解读。
- 完整作者机构与八维评分；原文存在且可验证时纳入公式、实验表格、论文图和复现资源。
- 博客远端发布成功后生成的 TOP 10 论文长图与一张批次汇总封面。

## 默认行为

默认路线是 LLM/API：

```text
arXiv + HuggingFace
  → 关键词预筛 → LLM 逐篇筛选 → 封存本次官方 arXiv TXT/PDF
  → 多阶段全文分析与评分
  → 博客 generate → review → push / 远端 OID 验证
  → TOP 10 长图与汇总封面 → 最终状态验收
```

- `digest:prepare` 与 `digest:api` 是同一条默认路线。
- 默认 API 日更在筛选结束、深度分析开始前，为每篇入选 arXiv 论文封存本次官方文本和 PDF。
  来源文件位于 `data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/`，
  包含 `source.txt`、`source.pdf`、`source-runtime.json` 和 `source-manifest.json`。分析与 Reader 只能读取这组
  已封存的文件；论文图仅在当前请求的系统临时目录中准备，不写入 `data/current/` 或 runtime 图片缓存。
- Manual/人工流程只有在明确选择时才启用；API、网络或配额失败不会自动切换。
- 微信、飞书、小红书是可选集成，不属于默认日更。

## 全历史重写

全历史工作与日更、会议整理统一在当前工作区执行，角色保持 `daily`，历史入口使用 `PD_WORKSPACE_ALLOW_CROSS_ROLE=1`。旧历史工作区已废弃，各类发布由执行任务的 Agent 错峰安排。当前采用 `direct-local-first` 路线：每轮 arXiv
重写重新获取官方文本和 PDF；会议论文使用已核验 SHA 的本地元数据和 PDF。旧博客正文和旧分析不能用于写作。
OpenReview 不可达时，默认停止，不自行改用其他来源。唯一由代码白名单和用户授权的跨标题例外
`n1mAjfRDZ6` 可导入作者发布在 SSRN 的早期预印本，但分析输入、页面顶部和 staging manifest 都必须明示
“非 camera-ready”，并记录可核验的来源标题、DOI、获取凭证和来源 SHA。

同一篇论文只重写一次，再生成对应历史 URL 的页面。备用 `history:arxiv-batch` 仅接收新一轮 arXiv 获取失败后
生成的命名且不可变交接文件；`history:crosswalk` 仍支持显式维护旧来源对照记录，必须通过来源授权和 CAS 核验。长任务可分批处理、查看状态、安全暂停和续跑。来源准备按 `direct-inputs` →
`conference-projections` → `direct-plan` → `direct-scheduler` → `direct-run` 依次完成，产出私有页面和
`direct-aggregate` 汇总，再由 `history:direct-publication` 按 `plan → generate → review → publish → status`
发布；全部来源、页面覆盖、审查、Git 基线与远端检查通过前不得覆盖博客。入口存在不代表全历史已处理或
发布完成。详见[历史重写](docs/history-rewrite.md)与[独立历史发布](docs/history-direct-publication.md)。

## 5 分钟开始

要求：Node `>=20.18.1 <21 || >=22.3.0`、Python 3.11+（OpenSSL 后端）及 Hugo 博客仓库。

```bash
# 1. 安装依赖
npm install
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
# 2. 创建并按 docs/setup.md 填写项目配置
cp env.example .env
```

`.env` 至少配置模型密钥、型号、API 地址、HTTP CONNECT 代理和博客路径。字段与备用账号规则见
[环境配置](docs/setup.md)。所有项目命令必须在沙箱外运行。先确认当前目录用途，再检查工作区角色：

```bash
npm run workspace:role -- status
```

当前目录保持 `daily`，历史命令通过上述跨角色开关运行，不再使用旧历史目录。标记缺失或路径不匹配时先停止；确认用途后才用
`npm run workspace:role -- set daily|history [--force]` 绑定角色，不要直接强制改成日更目录。

```bash
# 3. 运行 Node 测试
npm test

# 4. 运行北京时间当天的完整脚本阶段
today="$(TZ=Asia/Shanghai date +%F)"
npm run digest:prepare -- "$today"
```

`digest:prepare` 完成数据处理和 Git 发布后准备视觉任务。还需人工确认部署及网页核验通过，并由 Codex
内置生图工具完成、目检和登记图片；只有用户明确取消时才记录视觉豁免。脚本不会自行调用图像 API。

```bash
# 5. 最终验收
npm run digest:status -- --date "$today"
```

## 怎样才算完成

一次完整日更同时满足：

1. 抓取来源、筛选决定和深度分析全部完成，数据相互对应。
2. 汇总页和全部论文页通过审查，博客提交已推送且远端 OID 匹配。
3. 对应发布提交（或保留本批已审页面字节的后续提交）的 GitHub Pages build/deploy 成功；人工逐页确认
   汇总和单篇页面的 HTTP 200、正式地址与标题，并保留核验记录。
4. TOP 10 长图与汇总封面均已登记，或存在绑定当前发布版本的显式视觉豁免。
5. 最后一次推送或图片登记后重新运行 `digest:status`，报告不再列出未完成阶段。它尚未自动核验部署和
   网页，显示完成也不能代替第 3 项。

博客已经发布后，视觉失败不会反向撤销博客，也不应触发博客重新生成或重新审查。

## 核心命令

| 目的 | 命令 |
|---|---|
| 默认当天日更 | `npm run digest:prepare -- YYYY-MM-DD` |
| 续跑未完成日更分析 | `npm run deep -- --date YYYY-MM-DD`（只读取本批已封存的 TXT/PDF） |
| 刷新 API Reader | `npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader`（只读取本批已封存的 TXT/PDF） |
| 校验当前数据 | `npm run validate:data` |
| 查看运行数据占用 | `npm run storage:status` |
| 预览哪些未引用文件可清理 | `npm run storage:prune` |
| 查看最终状态 | `npm run digest:status -- --date YYYY-MM-DD` |
| 单独执行博客三阶段 | `npm run blog:generate` → `npm run blog:review` → `npm run blog:push` |
| 用户明确取消视觉 | `npm run digest:waive-visuals -- --date YYYY-MM-DD --reason "..."` |
| 显式 Manual 路线 | `npm run digest:manual -- YYYY-MM-DD` |

参数见[脚本说明](docs/scripts.md)，文件职责见[代码索引](scripts/README.md)。

## 标签体系与只读历史预览

```bash
npm run tags:validate
npm run tags:preview
npm run tags:serve
```

共享词表为每个标签定义稳定 ID、上下级关系和所属的分类维度，例如任务或方法。预览读取配置中的 Hugo 仓库，保留旧标签和未能对应词表的标签。

可以按上级标签查询；同一分类维度中选多个标签时，论文命中其中一个即可，不同维度的条件则须同时满足。结果展示的是旧标签与词表的对应关系，**不能据此认定论文已按原文重新分类并通过审查**。预览不修改旧正文、评分或标签 URL，也不调用论文模型 API。静态预览服务只在本机回环地址运行。

网站搜索索引使用 `tagContract`、`tagConcepts` 等标签字段，`tagCatalogSha256` 记录词表文件的 SHA。新版论文库、搜索和阅读导出继续读取旧索引，但同一条记录不能混用新旧字段。历史论文的来源证明和已核验分类仍按原版本检查。

发布器与网站使用 `tag-catalog-snapshot.json`、`tag-catalog-versions.json` 和 `tag-presentation-policy.json`；标签逻辑集中在 `tag-core.js`，目录交互使用 `tag-browser.js`，浏览器接口为 `ResearchTags`。显示词表和历史论文核验所用的原词表分别读取；旧版本文件保留原内容，新文件不能替代原来源证明。标准 Hugo API 和历史证明中的原名称仍按其原定义读取。

详见[实施与验收计划](docs/tag-system-implementation.md)和[标签设计](docs/tag-system-design.md)。

## 失败后从哪里继续

- 抓取或筛选中断：重跑默认入口，程序会复用验证通过的检查点。
- 只有部分论文分析失败：运行 `npm run deep -- --date YYYY-MM-DD`，或按论文定向重分析。`deep`、`batch`、
  `reanalyze` 和 `api:reader:refresh` 只能读取当前正式分析结果绑定的 TXT/PDF。它们不重新抓取、不补建
  来源文件，也不读取旧文本或缓存。封存来源缺失或 SHA 不符时，只有目标仍为北京时间当天，才重新运行
  `npm run digest:prepare -- YYYY-MM-DD`；历史日期保留失败记录，按历史维护流程处理。
- 博客审查或推送失败：修复后运行 `npm run blog:review -- --date YYYY-MM-DD` 或 `npm run blog:push -- --date YYYY-MM-DD`。
- 视觉任务缺失或失效：运行 `npm run visual:post-publish -- --date YYYY-MM-DD`，不要重发博客。分工：`visual:post-publish` 负责（重新）规划两类图片任务；任务已存在时，生图前改用 `visual:prepare` 输出本次参考路径，见[主流程](docs/workflow.md)§7。
- 不确定失败属于哪一层：先看[排错手册](docs/troubleshooting.md)和
  [主流程](docs/workflow.md)。

从抓取阶段开始只能处理北京时间当天。历史批次必须使用已有受控数据，从程序允许的恢复阶段继续，
不能伪造日期重新抓取。

## 架构概览

Node.js 负责抓取、筛选、分析、运行状态和图片任务；Python 负责生成 Hugo 页面、审查与 Git 发布；
Codex 内置生图工具负责实际绘图，由 Agent 目检后登记。

默认 API 与显式 Manual 共用博客发布和视觉工具，但各自的内容证据与来源记录必须独立，不能混批。
Manual 的脚本、Prompt、测试和工作流集中在 [`manual/`](manual/README.md)。

## 数据与输出

| 位置 | 内容 |
|---|---|
| `data/current/` | 当前候选、筛选、分析、发布凭证和视觉任务状态 |
| `data/archive/<date>/` | 每日数据快照与最终视觉资产 |
| `data/runtime/daily-fresh-source-runs/` | 日更筛选后封存、供分析与 Reader 读取的官方文本和 PDF |
| `data/runtime/fetched-arxiv-sources/` | 历史 arXiv 重写每轮重新获取并封存的官方文本和 PDF |
| `data/runtime/` 的其他历史子目录 | 历史重写计划、分析、私有单页与汇总；生成这些文件不写博客 |
| `logs/` | 脱敏后的运行日志，可在 `.env` 中关闭文件日志 |
| Hugo 博客仓库 | 汇总页、论文页、主题模板与发布提交 |

字段和跨文件一致性见[数据格式](docs/data-format.md)。

## 开发与维护

```bash
npm run test:default       # 默认 API 与共享 Node 测试
npm run test:manual        # 显式 Manual Node 测试
npm test                   # 两者一起运行
```

CI 还运行 Python 单测、JS/Python/shell 语法检查和空数据结构校验。修改前请阅读[维护约定](docs/maintenance.md)。

## 文档导航

- [文档总览](docs/README.md)：按任务选择下一篇文档。
- [安装与配置](docs/setup.md)：环境变量、代理、模型和博客仓库。
- [默认主流程](docs/workflow.md)：归档、抓取、筛选、分析、发布和恢复。
- [默认 API 架构](docs/architecture.md)：组件调用、单篇阶段依赖、锁和跨仓库发布。
- [历史重写](docs/history-rewrite.md)：历史输入、重新获取的 arXiv 来源、会议 PDF 与备用路线。
- [脚本说明](docs/scripts.md)：命令参数和运行语义。
- [数据格式](docs/data-format.md)：检查点、正式分析结果和发布凭证。
- [契约兼容矩阵](docs/compatibility.md)：当前写入格式、历史读取与允许发布的条件。
- [排错手册](docs/troubleshooting.md)：API、代理、分析、发布和视觉问题。
- [Manual 子系统](manual/README.md)：显式人工流程。
