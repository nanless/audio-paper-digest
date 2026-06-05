# AGENTS.md

## 项目概述

自动化"语音/音乐/音频论文速递"流水线：arXiv + HuggingFace 抓取 → LLM 筛选 → 多模态深度分析 → 发布到 Hugo 博客 / 微信公众号 / 小红书 / 飞书。

**技术栈**：Node.js（核心流水线）+ Python（发布脚本）。要求 Node ≥ 18。

## 常用命令

```bash
npm install              # 安装依赖（仅 cheerio + pdf-parse）
npm test                 # 运行单元测试（node --test tests/*.test.js）
npm run fetch            # 全流程：抓取 + 筛选 + 深度分析
npm run deep             # 仅深度分析续跑（跳过已有 analysis）
npm run reanalyze        # 强制全量重分析
npm run batch            # 批量分析未分析论文
npm run backfill         # 补录历史 paper ID（不分析）
npm run publish          # 发布到 Hugo 博客（python3 scripts/publish-to-blog.py）
npm run wechat           # 生成微信公众号草稿
npm run xiaohongshu      # 生成小红书文案
npm run xhs-login        # 小红书登录（获取 Cookie）
npm run xhs-publish      # 小红书自动发布单篇
npm run xhs-publish-all  # 小红书自动发布全部

# 直接调用（不在 package.json 中）
node scripts/quick-test.js              # 快速测试（抓+筛选，不分析）
node scripts/analyze-single-paper.js <arxiv-id>  # 单独分析一篇论文
node scripts/batch-analyze.js           # 批量分析未分析论文
node scripts/validate-scores.js          # 验证并修复评分（子项越界/总分一致性/开源矛盾）
python3 scripts/publish-to-feishu.py    # 生成飞书文档
python3 scripts/publish-to-feishu.py --date 2026-04-21
```

未配置 linter、typecheck 或 formatter。`npm test` 是唯一的自动化检查。

## 环境配置

复制 `env.example` → `.env`（已 gitignore）。必需变量：

- `PAPER_ANALYZER_API_KEY` / `PAPER_ANALYZER_MODEL` / `PAPER_ANALYZER_ENDPOINT` — LLM 筛选 + 分析
- `WECHAT_APP_ID` / `WECHAT_APP_SECRET` / `WECHAT_THUMB_MEDIA_ID` — 微信发布（可选）
- `PAPER_DIGEST_BLOG_REPO` — Hugo 博客仓库路径（发布用 + 抓取时去重用）

其他常用可选变量：

- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` — 飞书发布
- `PAPER_DIGEST_AUTHOR` — 作者名（用于发布）
- `PAPER_DIGEST_IMAGE_HOST` / `PAPER_DIGEST_IMAGE_BASE_URL` — 图床配置（可选 `local`/`qiniu`）
- `XIAOHONGSHU_COOKIES` — 小红书 Cookie（JSON 格式 base64 编码）

Python 脚本通过 `python-dotenv` 加载 `.env`。Node 脚本通过 `utils.js` 中的 `loadEnvFile()` 加载。

环境变量覆盖项：`PD_ANALYSIS_CONCURRENCY`、`PD_ANALYSIS_MAX_RETRIES`、`PD_FILTER_BATCH_SIZE`、`PD_ARXIV_MAX_RESULTS`。

## 架构

### 入口脚本

- `scripts/full-fetch.js` — 主编排器（去重含博客已发布 → 抓取 → 筛选 → 分析 → 保存）
- `scripts/fetch-papers.js` — arXiv 抓取（网页抓取为主，API为辅）+ LLM 筛选
- `scripts/fetch-huggingface-papers.js` — HuggingFace Papers 抓取
- `scripts/deep-analysis-only.js` — 仅深度分析续跑（跳过已分析论文）
- `scripts/reanalyze.js` — 强制全量重分析（支持 `--concurrency N`）
- `scripts/batch-analyze.js` — 批量分析未分析论文
- `scripts/analysis-engine.js` — 批量分析协调器（被上述脚本共用）
- `scripts/quick-test.js` — 快速测试（抓+筛选，不分析）
- `scripts/analyze-single-paper.js` — 单独分析一篇指定 arXiv ID 的论文

### 发布脚本（Python）

- `scripts/publish-to-blog.py` — 生成 Hugo Markdown 文章并推送到博客仓库
- `scripts/publish-wechat-full.py` — 生成微信公众号草稿
- `scripts/publish-xiaohongshu.py` — 生成小红书文案
- `scripts/xiaohongshu-publisher.py` — 小红书自动发布（需先 `xhs-login`）
- `scripts/publish-to-feishu.py` — 生成飞书文档
- `scripts/backfill_papers.py` — 补录论文 ID 到 papers.json（不分析）
- `scripts/publish_common.py` — 发布通用工具
- `scripts/utils.py` — Python 端工具函数

### 配置

所有可调参数集中在 `scripts/config.js`。脚本中禁止硬编码配置值。

### 数据目录

```
data/current/          # 工作数据（gitignored）
  papers.json          # 论文去重数据库，跨运行累积，永不归档
  filtered-papers.json # 当日筛选结果
  deep-analysis-result.json  # 当日分析结果
  analyzed.json        # 分析状态
data/archive/<date>/   # 每日快照（自动创建）
logs/                  # 运行日志（gitignored）
prompts/               # LLM prompt 模板
```

`papers.json` 是持久化去重数据库，永不归档。

## 分支策略

- `main` — 每日论文速递流水线（arXiv + HuggingFace）
- `icml-2026-analysis`、`iclr-2026-analysis`、`icassp-2026-analysis` — 会议专用分析分支，含各自独立脚本

会议分支会新增专用脚本（如 `scripts/icassp-batch-analyze.js`、`scripts/iclr-batch-analyze.js`）和修改后的 prompt。不要将会议脚本混入 main 分支。

## 重要约定

- **权威来源**：文档与代码冲突时，以 `scripts/*` 当前实现为准，并修正文档。（参见 SKILL.md 第 20 行。）
- **提交信息**：中文或语义化约定式提交（`feat:`、`fix:`、`docs:`）。与现有风格保持一致。
- **SKILL.md** 包含 Agent 执行规则与安全约束——修改流水线行为前务必阅读。
- **prompts/** 中的 prompt 定义 LLM 行为。修改 prompt 会直接影响论文质量，编辑后用 `npm run deep` 测试。
- `data/` 和 `logs/` 已 gitignore——不要提交运行时产物。
- 博客发布脚本依赖独立的 Hugo 仓库（`PAPER_DIGEST_BLOG_REPO`），不在本仓库内。
- 测试使用 Node.js 内置测试运行器（`node:test`），非 Jest 或 Mocha。
- CI 会运行 `npm test` 以及对关键脚本做 `node -c` 语法检查（`scripts/utils.js`、`config.js`、`analysis-engine.js`、测试文件）。

### ⛔ 铁律：长时间运行命令

以下命令可能运行数十分钟到数小时：`npm run fetch`、`npm run reanalyze`、`npm run deep`、`node scripts/batch-analyze.js`、`python3 scripts/publish-to-blog.py` 等。

**必须遵守：**
1. **禁止设置 Bash timeout**。不得使用任何超时参数（`timeout`、`timeout_ms` 等），确保命令永不超时。
2. **禁止检查进程状态**。运行后 **不得** 执行 `ps aux | grep`、`jobs` 或任何进程检查命令。
3. **禁止过滤输出**。不得对输出做 `grep`、`head`、`tail` 过滤——完整输出是判断是否正常的唯一依据。
4. **禁止 abort**。命令尚未自然结束前，**严禁** 中止、取消或重启。如果之前 abort 过导致中断，这次必须等到自然结束。
5. **放在后台后不要碰**。启动后除了等待完成，不做任何其他操作。
