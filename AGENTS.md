# AGENTS.md

## 项目概述

自动化"语音/音乐/音频论文速递"流水线：arXiv + HuggingFace 抓取 → LLM 筛选 → 多模态深度分析 → 发布到 Hugo 博客 / 微信公众号 / 小红书 / 飞书。

**技术栈**：Node.js（核心流水线）+ Python（发布脚本）。要求 Node ≥ 18。`scripts/config.js` 集中管理所有可调参数（支持 `PD_*` 环境变量覆写）。

## 常用命令

```bash
npm install              # 安装依赖（cheerio + pdf-parse）
npm test                 # 运行单元测试（node --test tests/*.test.js）
npm run fetch            # 全流程：抓取 + 筛选 + 深度分析
npm run deep             # 仅深度分析续跑（跳过已有 analysis）
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
node scripts/analyze-single-paper.js <arxiv-id>  # 单独分析一篇论文
node scripts/reanalyze-selected.js <arxivId1> [arxivId2] ...  # 重分析指定论文
node scripts/validate-scores.js         # 验证并修复评分
node scripts/test-api-key.js            # 测试 LLM API key 可用性
python3 scripts/publish-to-feishu.py    # 生成飞书文档
```

未配置 linter、typecheck 或 formatter。`npm test` 是唯一的自动化检查。

## 环境配置

复制 `env.example` → `.env`（已 gitignore）。

### 必需变量

- `PAPER_ANALYZER_API_KEY` / `PAPER_ANALYZER_MODEL` / `PAPER_ANALYZER_ENDPOINT` — LLM 筛选 + 分析
- `PAPER_DIGEST_BLOG_REPO` — Hugo 博客仓库路径（抓取时用于去重已发布论文）

### 常用可选变量

- `WECHAT_APP_ID` / `WECHAT_APP_SECRET` / `WECHAT_THUMB_MEDIA_ID` — 微信发布
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` — 飞书发布
- `PAPER_DIGEST_AUTHOR` — 作者名
- `PAPER_DIGEST_IMAGE_HOST` / `PAPER_DIGEST_IMAGE_BASE_URL` — 图床配置（`local` / `qiniu`）
- `XIAOHONGSHU_COOKIES` — 小红书 Cookie（JSON 格式 base64 编码）

### 环境变量覆写

- `PD_ANALYSIS_CONCURRENCY` — 深度分析并发度（默认 3）
- `PD_ANALYSIS_MAX_RETRIES` — 深度分析重试次数（默认 2）
- `PD_FILTER_BATCH_SIZE` — LLM 筛选每批篇数（默认 5）
- `PD_ARXIV_MAX_RESULTS` — arXiv 每类抓取数量（默认 100）
- `PD_REANALYZE_CONCURRENCY` — 重分析并发度

Python 脚本通过 `python-dotenv` 加载 `.env`。Node 脚本通过 `scripts/utils.js` 的 `loadEnvFile()` 加载，该函数自行解析 `.env` 文件，不依赖任何三方库。

### LLM API 协议自动路由

`detectApiType()`（`scripts/utils.js:350`）根据 endpoint + model 自动判断协议：

| 端点含 | 模型含 | 协议 | URL 转换 |
|--------|--------|------|----------|
| `token-plan` | `mimo` | Anthropic | `/v1` → `/anthropic/v1/messages` |
| `coding` | `kimi` | Anthropic | `/coding/v1` → `/coding/v1/messages` |
| 其他 | 其他 | OpenAI | `/v1/chat/completions` |

**关键**：LLM API 请求中 `options.agent` 必须显式设为 `false`（禁用连接复用），否则在有系统代理时 MiMo Token Plan 返回 403。这条规则适用于 `scripts/fetch-papers.js` 和 `scripts/deep-analyzer.js` 中的所有 API 调用。

## 架构

### 入口脚本

- `scripts/full-fetch.js` — 主编排器（去重含博客已发布 → 抓取 → 筛选 → 分析 → 增量保存）
- `scripts/fetch-papers.js` — arXiv 抓取（网页抓取为主）+ LLM 筛选
- `scripts/fetch-huggingface-papers.js` — HuggingFace Papers 抓取
- `scripts/deep-analyzer.js` — 单篇论文多模态深度分析
- `scripts/analysis-engine.js` — 批量分析协调器（被 full-fetch / reanalyze / batch / deep 共用），提供 `analyzePaperWithRetry()` + `analyzeBatch()`
- `scripts/utils.js` — Node 端共用工具（API 路由、JSON 解析、prompt 加载、`normalizedId` 去重等）
- `scripts/config.js` — 所有可调参数集中配置

### 发布脚本（Python）

- `scripts/publish-to-blog.py` — Hugo Markdown 生成 + git push
- `scripts/publish-wechat-full.py` — 微信公众号草稿
- `scripts/publish-xiaohongshu.py` — 小红书文案生成
- `scripts/xiaohongshu-publisher.py` — 小红书自动发布
- `scripts/publish-to-feishu.py` — 飞书文档
- `scripts/publish_common.py` — 发布通用工具
- `scripts/utils.py` — Python 端工具函数

### 数据目录

```
data/current/           # 工作数据（gitignored）
  papers.json           # 论文去重数据库，跨运行累积，永不归档
  filtered-papers.json  # 当日筛选结果
  deep-analysis-result.json  # 当日分析结果
  analyzed.json         # 分析状态
data/archive/<date>/    # 每日快照（自动创建）
logs/                   # 运行日志（gitignored，自动清理保留最近 50 个）
prompts/                # LLM prompt 模板
  filter.md             # 筛选阶段
  deep-analysis.md      # 深度分析主 prompt（Round 1）
  opensource-scan.md    # 开源链接扫描（Round 2）
  gap-fill.md           # 审校重写（Round 3）
  index.md              # Prompt 文档索引（含占位符规范）
  en/                   # 英文版 prompt（结构相同）
```

`papers.json` 支持 `data/current/papers.json` 和 `data/papers.json`（旧版路径），两者均被 `config.js` 引用。`papers.json` 是持久化去重数据库，**永不归档**。

## 分支策略

- `main` — 每日论文速递流水线（arXiv + HuggingFace）
- `icml-2026-analysis` / `iclr-2026-analysis` / `icassp-2026-analysis` — 会议专用分析分支，含独立脚本和 prompt。**不要将会议脚本混入 main 分支**。

## 重要约定

- **权威来源**：文档与代码冲突时，以 `scripts/*` 当前实现为准。参见 SKILL.md。
- **提交信息**：中文或语义化约定式提交（`feat:` / `fix:` / `docs:`）。
- **修改 prompt 后**：编辑 `prompts/` 下文件后，用 `npm run deep` 或单篇分析验证；同步检查 `scripts/utils.js` 的解析逻辑（`parseAnalysis()` 内的正则 + `ALLOWED_TAGS` 白名单）是否兼容。
- `data/` 和 `logs/` 已 gitignore — 禁止提交运行时产物。
- 发布脚本依赖独立 Hugo 仓库（`PAPER_DIGEST_BLOG_REPO`），不在本仓库。
- 测试使用 Node.js 内置 `node:test`，非 Jest/Mocha。
- CI 运行 `npm test` + 对 `scripts/utils.js` / `config.js` / `analysis-engine.js` / 测试文件做 `node -c` 语法检查。**新增 JS 文件不会自动纳入 CI 语法检查**，需手动更新 `.github/workflows/ci.yml`。
- **新增分析脚本必须复用 `analysis-engine.js`**，避免重复实现重试/解析/保存逻辑。使用 `analyzePaperWithRetry()` + `analyzeBatch()` 函数即可。
- **新增 LLM 调用必须通过 `utils.js` 的 `detectApiType()` / `buildApiUrl()` / `buildHeaders()` / `buildRequestBody()` / `parseResponseText()`**，禁止硬编码协议。
- **博客验证默认 `--skip-push`**，仅用户明确要求时才执行真实 `git push`。
- 后台运行全流程时用 `node scripts/full-fetch.js` 而非 `npm run fetch`（npm 可能因 TTY 导致 SIGTERM）。

### ⛔ 铁律：长时间运行命令

以下命令可能运行数十分钟到数小时：`npm run fetch`、`npm run reanalyze`、`npm run deep`、`node scripts/batch-analyze.js`、`python3 scripts/publish-to-blog.py` 等。

**必须遵守：**
1. **禁止设置 Bash timeout**。不得使用任何超时参数（`timeout`、`timeout_ms` 等），确保命令永不超时。
2. **禁止检查进程状态**。运行后 **不得** 执行 `ps aux | grep`、`jobs` 或任何进程检查命令。
3. **禁止过滤输出**。不得对输出做 `grep`、`head`、`tail` 过滤——完整输出是判断是否正常的唯一依据。
4. **禁止 abort**。命令尚未自然结束前，**严禁** 中止、取消或重启。如果之前 abort 过导致中断，这次必须等到自然结束。
5. **放在后台后不要碰**。启动后除了等待完成，不做任何其他操作。
