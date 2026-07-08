# AGENTS.md

## 项目概述

自动化"语音/音乐/音频论文速递"流水线：arXiv + HuggingFace 抓取 → LLM 筛选 → 多模态深度分析 → 发布到 Hugo 博客 / 微信公众号 / 小红书 / 飞书。

**技术栈**：Node.js（核心流水线）+ Python（发布脚本）。要求 Node ≥ 18。`scripts/config.js` 集中管理主要可调参数（部分高频参数支持 `PD_*` 环境变量覆写）。

详细执行规则见 `SKILL.md`，本文是紧凑版——只保留 Agent 不看代码就容易漏掉的要点。

## 常用命令

```bash
npm install              # 安装依赖（cheerio + pdf-parse）
npm test                 # 运行单元测试（node --test tests/*.test.js）
npm run fetch            # 全流程：抓取 + 筛选 + 深度分析
npm run deep             # 仅深度分析续跑（跳过已有 analysis；无分析结果时可从 filtered-papers.json 初始化）
npm run reanalyze        # 强制全量重分析（支持 --concurrency N）
npm run batch            # 批量分析未分析论文
npm run backfill         # 补录历史 paper ID（Python 脚本，不分析）
npm run publish          # 发布到 Hugo 博客（python3 scripts/publish-to-blog.py）
npm run wechat           # 生成微信公众号草稿
npm run xiaohongshu      # 生成小红书文案
npm run xhs-login        # 小红书登录（获取 Cookie）
npm run xhs-publish      # 小红书自动发布单篇
npm run xhs-publish-all  # 小红书自动发布全部

# 直接调用（不在 package.json 中）
node scripts/quick-test.js              # 快速测试（抓+筛选，不分析）
node scripts/analyze-single-paper.js <arxiv-id> [--force]  # 单独分析一篇论文（--force 覆盖已有结果）
node scripts/reanalyze-selected.js <arxivId1> [arxivId2] ...  # 重分析指定论文
node scripts/refilter-reanalyze-by-date.js <date>  # 按日期重新筛选+分析
node scripts/validate-scores.js         # 验证并修复评分
node scripts/test-api-key.js            # 测试 LLM API key 可用性
python3 scripts/publish-to-feishu.py    # 生成飞书文档

# ICML 2026 专属流程（仅 icml-2026-analysis 分支可用）
npm run icml-fetch-openreview   # 从 OpenReview API 抓取论文元数据（需 Chrome Cookie）
npm run icml-filter             # LLM 筛选音频/语音/音乐相关论文
npm run icml-download-pdfs      # 下载筛选论文 PDF 并提取文本（含表格）
npm run icml-analyze            # 批量深度分析（基于 PDF 全文 + 自动注入图片）
npm run icml-retry              # 重试失败的分析
npm run icml-reanalyze-pdf      # 基于 PDF 全文重分析
python3 scripts/extract-icml-images.py   # 提取 PDF 图片到图床
# 发布博客：python3 scripts/publish-to-blog.py --category icml-2026 --date YYYY-MM-DD data/current/icml_2026_deep_analysis.json
```

未配置 linter、typecheck 或 formatter。CI 会运行 `npm test`、所有 `scripts/` / `tests/` 下 JS 文件 `node -c` 语法检查、所有 `scripts/` 下 Python 文件 `py_compile` 语法检查、`tests/python` 下 Python 单测，以及所有 `.sh` 的 `bash -n`。

## 环境配置

复制 `env.example` → `.env`（已 gitignore）。

**必需变量**：`PAPER_ANALYZER_API_KEY` / `PAPER_ANALYZER_MODEL` / `PAPER_ANALYZER_ENDPOINT` + `PAPER_DIGEST_BLOG_REPO`

**双模型（可选，多模态）**：设置 `PAPER_ANALYZER_SECONDARY_MODEL` 即启用副模型做图像补充（主模型仅做纯文本分析）；不设置则跳过图片、退回单模型纯文本。`PAPER_ANALYZER_SECONDARY_ENDPOINT` / `PAPER_ANALYZER_SECONDARY_API_KEY` 未设置时默认复用主模型对应值。

Node 脚本双层加载 `.env`：① `scripts/config.js` 模块级 IIFE 最先执行（任何 `require('config')` 即触发）；② `scripts/utils.js` 的 `loadEnvFile()` 二次兜底补漏。都自行解析 `.env` 文件，不依赖任何三方库，且 **shell 环境变量优先，`.env` 只补齐缺失项**。Python 脚本通过 `python-dotenv` 加载，同样不覆盖已存在环境变量。

### LLM API 协议自动路由

`detectApiType()`（`scripts/utils.js`）根据 endpoint + model 自动判断协议：

| 端点含 | 模型含 | 协议 | URL 转换 |
|--------|--------|------|----------|
| `deepseek.com` 或模型含 `deepseek` | — | OpenAI | `/anthropic` → `/v1/chat/completions`（强制 OpenAI，优先级最高） |
| `token-plan` | `mimo` | Anthropic | `/v1` → `/anthropic/v1/messages` |
| `coding` | `kimi` | Anthropic | `/coding/v1` → `/coding/v1/messages` |
| `/anthropic` | — | Anthropic | `{base}/messages` |
| 其他 | 其他 | OpenAI | `/v1/chat/completions` |

**关键**：LLM API 请求中 `options.agent` 必须显式设为 `false`（禁用连接复用），否则在有系统代理时 MiMo Token Plan 返回 403。适用于 `fetch-papers.js` 和 `deep-analyzer.js` 中的所有 LLM API 调用。

## 架构

### 入口脚本（Node.js）

| 文件 | 角色 |
|------|------|
| `scripts/full-fetch.js` | 主编排器（归档→去重含博客已发布→抓取→筛选→更新去重库→分析→增量保存） |
| `scripts/fetch-papers.js` | arXiv 网页抓取 + LLM 筛选 |
| `scripts/fetch-huggingface-papers.js` | HuggingFace Papers 抓取（curl 命令） |
| `scripts/deep-analyzer.js` | 单篇多模态深度分析（支持双模型模式：主模型做文本分析，副模型做图像补充；单模型模式向后兼容） |
| `scripts/analysis-engine.js` | 批量分析协调器，提供 `analyzePaperWithRetry()` + `analyzeBatch()` |
| `scripts/utils.js` | Node 端共用工具（API 路由、JSON 解析、prompt 加载、`normalizedId` 去重、代理检测、文件原子写入） |
| `scripts/config.js` | 主要可调参数集中配置 + 部分 `PD_*` 环境变量覆写 |

### 发布脚本（Python）

`publish-to-blog.py` / `publish-wechat-full.py` / `publish-xiaohongshu.py` / `xiaohongshu-publisher.py` / `publish-to-feishu.py` + 共用模块 `publish_common.py` / `utils.py`。博客、微信、飞书发布优先使用论文对象中已有的 `parsed`，没有时才回退解析 `analysis`，避免覆盖人工修正或已缓存的结构化结果。

### 数据目录

```
data/current/           # 工作数据（gitignored）
  papers.json           # 论文去重数据库，跨运行累积，永不归档
  raw-candidates.json   # 当日合并+博客去重后的筛选候选，便于排查筛选输入
  filter-decisions.json # 当日 LLM 筛选逐篇决策缓存（含 reason/rawResponse），支持筛选阶段中断续跑
  filtered-papers.json  # 当日筛选结果
  deep-analysis-result.json  # 当日分析结果
  analyzed.json         # 分析状态（兼容）
data/archive/<date>/    # 每日快照（自动创建）
logs/                   # 运行日志（gitignored，自动清理保留最近 50 个，且受单文件/总量上限约束）
prompts/                # LLM prompt 模板
  filter.md             # 筛选阶段
  deep-analysis.md      # 深度分析主 prompt（Round 1，纯文本）
  image-supplement.md   # 图像补充（双模型模式副模型用）
  opensource-scan.md    # 开源链接扫描（Round 2）
  gap-fill.md           # 审校重写（Round 3）
  index.md              # Prompt 文档索引（含占位符规范）
  en/                   # 英文版 prompt（含 filter / deep-analysis / gap-fill / opensource-scan / index，不含 image-supplement）
```

`papers.json` 同时支持 `data/current/papers.json` 和 `data/papers.json`（旧版路径），均被 `config.js` 引用。**`papers.json` 持久化去重数据库，永不归档**。`full-fetch.js` 每次运行自动备份 `papers.json` 到 `data/archive/papers-<日期>.json`，保留最近 7 天。条目可带 `digestStatus.status`：`pending_analysis` / `analysis_failed` 不参与强去重，便于中断后重跑；成功后更新为 `analyzed`。

## 分支策略

- `main` — 每日论文速递流水线（arXiv + HuggingFace）
- `icml-2026-analysis` / `iclr-2026-analysis` / `icassp-2026-analysis` — 会议专用分析分支，含独立脚本和 prompt。**不要将会议脚本混入 main 分支**。

## 重要约定

- **资料权威性**：文档与代码冲突时，以 `scripts/*` 当前实现为准。详尽的执行规则与安全约束见 `SKILL.md`。
- **提交信息**：中文或语义化约定式提交（`feat:` / `fix:` / `docs:`）。
- **测试框架**：Node.js 内置 `node:test`，非 Jest/Mocha。
- **CI**：运行 `npm test` + `find scripts tests -name '*.js'` 的 `node -c` 语法检查 + `find scripts -name '*.py'` 的 `py_compile` 语法检查 + `python3 -m unittest discover -s tests/python` + 所有 `.sh` 的 `bash -n`。新增 JS/Python/shell 文件会自动纳入检查。
- **新增分析脚本必须复用 `analysis-engine.js`**，使用 `analyzePaperWithRetry()` + `analyzeBatch()`，禁止重复实现重试/解析/保存逻辑。
- **新增 LLM 调用必须通过 `utils.js` 的 `detectApiType()` / `buildApiUrl()` / `buildHeaders()` / `buildRequestBody()` / `parseResponseText()`**，禁止硬编码协议。
- **环境变量加载**：Node 端 `loadEnvFile()` 自行解析 `.env` 无三方依赖；Python 端用 `python-dotenv`。两端都必须保持 shell 环境优先，禁止让 `.env` 覆盖调用者显式传入的变量。
- **`loadPrompt()` 从 markdown 文件内的第一个 fenced code block 提取 prompt**，并替换 `{变量名}` 占位符。内部示例代码块需使用比外层更短的 fence，修改 prompt 后需验证 `utils.js` 解析逻辑兼容。
- **原子写入**：使用 `writeFileAtomic()` 保存数据文件，先写临时文件再 rename，防止写入中断损坏数据。
- **北京时间时间戳**：运行数据中的 `timestamp` / `lastUpdated` / `fetchedAt` 应使用 `getBeijingISOString()` 或 Python 端 `now_bj_iso()`，避免 UTC 日期导致跨天归档或发布筛选错误。
- **博客验证默认 `--skip-push`**，仅用户明确要求时才执行真实 `git push`。`publish-to-blog.py --push` 必须在三层 review 无剩余问题后才允许 commit/push。
- **后台运行全流程时用 `node scripts/full-fetch.js`** 而非 `npm run fetch`（npm 可能因 TTY 导致 SIGTERM，exit code 143）。根目录 `run-full-fetch.sh` 即此包装（`cd` 到项目根后 `exec node`）。
- **`data/` 和 `logs/` 已 gitignore** — 禁止提交运行时产物。

### 致命 Bug 防御

**MiMo Token Plan 403**：`fetch-papers.js` 和 `deep-analyzer.js` 中 LLM 请求的 `options.agent` 必须为 `false`（不是 `undefined`）。这会彻底禁用连接复用，强制直连。任何重构 HTTP 代码时绝对不能改回 `agent: proxyAgent` 或 `undefined`。

### 长时间运行命令

命令 `npm run fetch`、`npm run reanalyze`、`npm run deep`、`batch-analyze.js` 等可能运行数十分钟到数小时。**必须：**
1. **禁止设置 Bash timeout**，确保命令永不超时。
2. **禁止检查进程状态**（`ps aux | grep`、`jobs`）。
3. **禁止过滤输出**（`grep`、`head`、`tail`），完整输出是判断是否正常的唯一依据。
4. **禁止 abort**，命令自然结束前严禁中止、取消或重启。
5. **启动后只等待结果**，不做其他操作。

## 评分体系速查

深度分析采用八维审稿人评分：创新性(2) + 技术严谨性(1.5) + 实验充分性(1.5) + 清晰度(1) + 影响力(1.5) + 开源(1.5) + 可复现性(0.5) + 工程/实践价值(1.5) = 满分 11 分，**总分上限 10**。

`parseAnalysis()` 从 `## 评分理由` 提取各分项重新计算总分，始终覆盖 LLM 原始总分（防止 LLM 算错）。同时执行矛盾检测：开源分≥1.0 但 `hasCode/hasModel/hasDataset` 全为"否"时强制降为 0。

`rankBucket` 推断（基于最终 score）：≥9.0 → 前10%，≥7.5 → 前25%，≥5.5 → 前50%，<5.5 → 后50%。

## 发布日期安全

- 博客 `YYYY-MM-DD` 代表**爬取分析的批次日期**，不是论文 arXiv 发布日期
- `deep-analysis-result.json` 中的论文都是当日抓取+去重+筛选后的结果
- `full-fetch.js` 每天运行时自动归档移走昨日数据文件
- 重跑当天步骤见 `SKILL.md` §6（先检查 `papers.json` 的 `lastUpdated`）
- **恢复 `papers.json` 的关键判断**：`lastUpdated` 是今天→不要恢复；若今日 `filtered-papers.json` 已是 `status: complete`，直接运行 `node scripts/full-fetch.js` 会跳过抓取/筛选并续跑深度分析；是昨天或更早→可恢复 `data/archive/papers-<日期>.json` 备份
