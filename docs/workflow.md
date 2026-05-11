# 主流程详解

## 主流程详解

主入口：`./run-full-fetch.sh`（或 `node scripts/full-fetch.js` / `npm run fetch`）

### 3.1 自动归档

运行开始时，脚本检查 `data/current/` 下的以下文件：
- `deep-analysis-result.json`
- `filtered-papers.json`
- `analyzed.json`

**注意：`papers.json` 是去重数据库，不参与归档移走，持续累积。**

归档规则（逐文件判断）：
1. 读取文件中的时间戳字段（支持 `timestamp` / `lastUpdated` / `deepAnalysisCompletedAt` / `previousTimestamp`）
2. 若日期 **早于今天（北京时间）**，且 `data/archive/<日期>/` 下尚未存在该文件，则**复制**到归档目录
3. 复制成功后，**删除**原文件，确保每天从零开始
4. 若归档目录已存在同名文件，跳过（不覆盖）

同时，若 `deep-analysis-result.json` 存在且已有数据，会在归档前自动备份到 `data/archive/deep-analysis-result-<时间戳>.bak.json`，并自动清理旧备份（保留最近 10 个）。

### 3.2 arXiv 抓取

从 7 个分类各抓取最新论文：

| 分类 ID | 名称 | 优先级 |
|---------|------|--------|
| `eess.AS` | 音频语音 | core |
| `cs.SD` | 声音 | core |
| `eess.SP` | 信号处理 | core |
| `cs.CL` | 计算语言学 | supplement |
| `cs.LG` | 机器学习 | supplement |
| `cs.AI` | 人工智能 | supplement |
| `cs.MM` | 多媒体 | supplement |

抓取参数：
- API：`export.arxiv.org/api/query`，按 `submittedDate` 降序，每类 `max_results=100`
- User-Agent: `Mozilla/5.0 (compatible; PaperDigest/1.0)`
- 每分类重试最多 **6 次**，指数退避：第一次重试 4 秒，之后翻倍（`2^attempt * 2000ms`，attempt 从 1 开始）
- 遇到 HTTP 429 限流额外等待：第一次 10 秒，之后翻倍（`2^attempt * 5000ms`，attempt 从 1 开始，上限 60 秒）
- **提前停止**：若连续遇到 20 篇已有 ID（存在于 `papers.json`），则停止该分类抓取
- 类别间延迟 **2 秒**

去重逻辑：`deduplicatePapers()` 按 `arxivId` 去重，core 类别（eess.AS / cs.SD / eess.SP）优先于 supplement 类别保留。

### 3.3 HuggingFace Papers 抓取

通过 `fetch-huggingface-papers.js` 双源抓取：

1. **`/api/daily_papers`**：精选每日论文，含 `ai_summary`、`githubRepo`、`upvotes`、`ai_keywords`、`projectPage`、`githubStars`、`discussionId` 等丰富字段。分页获取（`limit=100`，最多 20 页），直到覆盖近 7 天。
2. **`/api/papers`**：最新论文补充，覆盖最近 1-2 天，用于补充 daily_papers 未收录的新论文。

过滤：
- 只保留近 7 天的论文（`published >= 今天-7天`）
- 排除已有 ID
- 按 `upvotes` 降序排列

技术实现：使用 `curl` 命令获取数据（避免 Node fetch 在代理环境下的兼容问题），返回数据标准化为与 arXiv 一致的字段结构。

### 3.4 合并去重

`mergeAndDeduplicate(arxivPapers, hfPapers)` 的规则：

- **arXiv 论文优先级更高**：先全部放入 `merged` Map，保留其 `categories`、`abstract` 等元数据
- **HF 论文补充**：若 HF 论文的 `arxivId` 已存在于 arXiv 论文中，合并全部 7 个 HF 特有字段；若不存在，作为独立论文加入
- **来源标记**：`sources: ['arxiv']`、`['huggingface']` 或 `['arxiv', 'huggingface']`
- **摘要统一**：HF 论文同时输出 `summary` 和 `abstract`（内容相同），确保下游无需区分字段名

HF 特有字段（共 7 个）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `hf_upvotes` | number | HF 社区点赞数 |
| `hf_ai_summary` | string | HF AI 生成的摘要 |
| `hf_ai_keywords` | string[] | HF AI 提取的关键词 |
| `hf_github_repo` | string | 关联 GitHub 仓库 |
| `hf_project_page` | string | 项目主页 |
| `hf_github_stars` | number | GitHub Stars 数 |
| `hf_discussion_id` | string | HF Discussion ID |

### 3.5 LLM 筛选

使用 `~/.hermes/.env` 中的 `PAPER_ANALYZER_*` 配置逐篇判断是否为语音/音频相关。

**API 协议自动路由**：`scripts/utils.js` 中的 `detectApiType()` 会根据端点和模型名自动切换 OpenAI / Anthropic 协议
- **MiMo/Kimi Token Plan / Coding Plan**（端点含 `token-plan` 或 `coding`，模型含 `mimo`/`kimi`）→ 自动切换为 **Anthropic 协议**，伪装成 Claude Code 调用
  - **MiMo**: `https://token-plan-cn.xiaomimimo.com/v1` → `/anthropic/v1/messages`
  - **Kimi**: `https://api.kimi.com/coding/v1` → `/v1/messages`（无需 `/anthropic` 中间路径）
  - Headers: `x-api-key` + `anthropic-version: 2023-06-01` + `User-Agent: claude-cli/<version> (external, cli)`（版本号动态获取自本地 `claude --version`，失败回退到 `2.1.108`）
  - system message 自动提取为请求体顶级字段
- **其他情况**（包括 MiMo 按量付费 `api.xiaomimimo.com` 、通用 OpenAI 端点）→ 使用标准 **OpenAI 协议**
  - URL: `/v1/chat/completions`
  - Headers: `Authorization: Bearer {key}`

筛选 prompt 从 `prompts/filter.md` 读取，运行时替换 `{title}`、`{abstract}`、`{categories}` 占位符。判定标准如下：
- 语音合成/识别/增强/分离/克隆/转换 → **是**
- 音频生成/理解/音乐/事件检测 → **是**
- 说话人相关任务 → **是**
- 语音/音频相关模型、表示学习、预训练 → **是**
- 多模态模型只要明确涉及语音/音频（输入、输出、训练目标、评测任务或核心能力之一）→ **是**
- 其他领域且没有实质性语音/音频方法或任务 → **否**
- 冲突处理：若同时看起来满足"多模态涉及语音/音频"和"其他领域"，优先判定为 **是**

运行参数：
- `batchSize = 5`（批内并行调用 LLM）
- `delayBetweenBatches = 2000`（批次间延迟 2 秒）
- `useKeywordPreFilter = false`（当前主流程不用关键词预筛选）
- 单篇超时 **60 秒**，重试 **3 次**
- 每次重试独立创建 `AbortController` 和 `setTimeout`，避免重试时复用已 abort 的 controller

结果保存到 `data/current/filtered-papers.json`。

### 3.6 深度分析

使用 `deep-analyzer.js` 对每篇筛选后的论文进行全文 + 图片的深度阅读理解。

深度分析 prompt 从 `prompts/deep-analysis.md` 读取，运行时替换 `{hasFullText}`、`{title}`、`{authors}`、`{categories}`、`{arxivId}`、`{textForAnalysis}` 占位符。

**分析内容（由 LLM 生成，中文输出）**：

| 章节 | 要求 |
|------|------|
| 评分 | 1-10 分，保留一位小数；同时输出 Overall Recommendation（Strong Accept → Strong Reject）；机器摘要含 `rank_bucket`、`quality_score`、`value_score`、`reproducibility_bonus`、`confidence` 等字段 |
| 标签 | 3-5 个，必须含至少 1 个【任务】和 1 个【方法/模型】标签；除最终标签串外，还要求输出"主任务标签""主方法标签""补充标签" |
| 作者与机构 | 第一作者、通讯作者、作者列表及所属机构；缺失信息必须写"未说明"，禁止猜测 |
| 毒舌点评 | 2-3 句话犀利点评亮点和槽点，像资深审稿人的 final comment |
| 核心摘要 | 5-8 句话，覆盖问题、方法、效果、局限性 |
| 方法概述和架构 | 输入输出流程、组件结构、连接方式、设计理由；不少于 600 中文字符 |
| 核心创新点 | 3-5 个，每个含定义、之前方法的不足、解决机制、实际效果 |
| 实验结果 | 必须优先给出 benchmark、指标和具体数字；拿不到数字时明确写"论文未给出具体数值"；表格必须完整输出 |
| 细节详述 | 训练数据、损失函数、训练策略、超参数、硬件、推理细节 |
| 评分理由 | 按 6 个维度分别给分并写出具体评审意见（创新性/技术严谨性/实验充分性/清晰度/影响力/可复现性），像顶会审稿人一样写清楚"为什么给这个分" |
| 局限与问题 | 分两部分：论文明确承认的局限 + 审稿人发现的潜在问题 |
| 开源详情 | 只允许基于论文文本或当前输入链接总结，缺失时写"未提及"，禁止编造仓库/热度信息 |

> **图片与表格放置规则**：图片和表格不再集中在一个单独 section 中，而是直接嵌入到对应位置——架构图贴在**方法概述和架构**部分，实验结果图/表贴在**实验结果**部分。严禁编造图片 URL，只能使用 prompt 中提供的 arXiv 图片 URL 列表中的真实 URL。

**技术特性**：
- **API 协议自动路由**：与筛选阶段共用同一套 `detectApiType()` 逻辑，根据 `PAPER_ANALYZER_ENDPOINT` 和 `PAPER_ANALYZER_MODEL` 自动切换 OpenAI / Anthropic 协议
- 获取 arXiv HTML 全文（最多 100K 字符），依次尝试 `v1`、`v2`、无后缀版本；使用 **cheerio** 结构化解析 HTML，移除 script/style/nav/header/footer 等噪音元素
- 提取图片 URL（png/jpg/jpeg），过滤 logo/favicon
- **图片分析**：下载论文全部图片（无数量限制）；单张 base64 上限 500K 字符；**图片下载并行化（并发 3）**。图片 URL 列表会写入 prompt，即使下载失败 LLM 也能获取真实 URL 用于正文引用。若全部下载失败，自动降级为纯文本重试
- **并发度：3 篇并行**（可通过 `PD_ANALYSIS_CONCURRENCY` 环境变量调整）
- 每篇最多重试 **2 次**（外层 `analysis-engine.js`），每次外层重试内部 API 调用还有 **3 次** 重试（`deep-analyzer.js` 内层，指数退避：第一次 10 秒，之后翻倍，`2^attempt * 5000ms`），外层重试间隔 3 秒（可通过 `PD_ANALYSIS_MAX_RETRIES` 调整外层）
- API 整体超时 **20 分钟**（AbortController）
- `max_tokens=15000`，`temperature=0.7`
- 支持代理自动检测（环境变量 → macOS `scutil --proxy`）
- 支持纯 Node 内置模块的 HTTP CONNECT 代理（无需外部依赖）
- 所有分析配置集中管理于 `scripts/config.js`，支持环境变量覆写（`PD_ANALYSIS_CONCURRENCY`、`PD_ANALYSIS_MAX_RETRIES`、`PD_FILTER_BATCH_SIZE`、`PD_ARXIV_MAX_RESULTS`）

### 3.7 增量保存与收尾

- **每批分析完成后立即增量保存**到 `data/current/deep-analysis-result.json`，避免中断丢失全部结果；增量合并时**自动保护已有成功分析**（失败结果不会覆盖已有 `analysis`）
- 全部论文分析完毕后，再次读取已有结果，按 `arxivId`/`paper_id` 去重合并，保留历史数据
- 自动备份旧文件到 `data/archive/deep-analysis-result-<时间戳>.bak.json`，并清理旧备份（保留最近 10 个）
- **`papers.json` 自动备份**：每天运行前自动备份 `data/current/papers.json` 到 `data/archive/papers-<日期>.json`，保留最近 7 天
- 更新 `data/current/papers.json` 去重库
