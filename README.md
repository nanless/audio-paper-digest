# Paper Digest - 语音/音频论文速递全流程自动化

本项目用于自动生成"语音/音频论文速递"，覆盖从 arXiv 和 HuggingFace Papers 抓取、LLM 筛选、多模态深度分析，到发布 Hugo 博客、微信公众号草稿和小红书文案的完整链路。

---

## 1. 文档说明

| 文件 | 用途 | 读者 |
|------|------|------|
| `README.md` | 给人的完整运行手册（架构、配置、命令、排错） | 人类用户 |
| `SKILL.md` | 给 Agent 的执行规则与安全约束 | AI Agent |
| `prompts/filter.md` | 筛选阶段 LLM prompt（判断论文是否语音/音频相关） | 维护者 |
| `prompts/deep-analysis.md` | 深度分析阶段 LLM prompt（输出格式、标签体系、评分标准） | 维护者 |

> **铁律**：真实行为以 `scripts/*.js` / `scripts/*.py` 当前实现为最终准绳。若文档与代码冲突，以代码为准并修正文档。

---

## 2. 项目结构

```
audio-paper-digest/
├── scripts/                    # 全部脚本
│   ├── full-fetch.js           # 主入口：归档 → 抓取 → 筛选 → 深度分析 → 保存
│   ├── fetch-papers.js         # arXiv 抓取 + LLM 筛选模块
│   ├── fetch-huggingface-papers.js  # HuggingFace Papers 双源抓取
│   ├── deep-analyzer.js        # 多模态深度分析器（全文 + 图片）
│   ├── deep-analysis-only.js   # 仅深度分析续跑（跳过已有 analysis）
│   ├── reanalyze.js            # 全量重分析（支持并发配置）
│   ├── batch-analyze.js        # 批量分析未分析论文（逐篇保存）
│   ├── analyze-single-paper.js # 单独分析一篇并合并（命令行参数）
│   ├── quick-test.js           # 快速抓取测试（抓+筛选，不分析）
│   ├── publish-to-blog.py      # 发布到 Hugo 博客（GitHub Pages）
│   ├── publish-wechat-full.py  # 生成微信公众号图文草稿
│   ├── publish-xiaohongshu.py  # 生成小红书文案
│   ├── publish-to-feishu.py    # 生成飞书文档（Feishu Open API）
│   ├── publish_common.py       # Python 发布公共模块（数据加载、评分排序、标签提取）
│   ├── backfill_papers.py      # 补录历史论文 ID（不分析）
│   ├── config.js               # 统一配置中心（支持环境变量覆写）
│   ├── analysis-engine.js      # 统一分析引擎（单篇重试/解析、批量并发、增量保存）
│   ├── utils.js                # 公共工具函数（Node）
│   ├── utils.py                # 公共工具函数（Python）
│   ├── log-setup.js            # Node 日志模块（Tee + 自动清理）
│   ├── log_setup.py            # Python 日志模块（Tee + 自动清理）
│   ├── backup-data.sh          # 数据备份壳脚本
│   ├── pdf-extractor.py        # 从本地 PDF 提取文本和图片（PyMuPDF）
│   ├── icassp-batch-analyze.js # ICASSP 2026 批量分析主流程（筛选+深度分析）
│   ├── icassp-categorize.js    # ICASSP 论文按标签分类生成 Markdown 报告
│   ├── retry-failed-analysis.js # 重新分析评分失败的论文
│   ├── retry-text-only.js      # 文本-only 重新分析（跳过图片，绕过 API 安全过滤）
│   ├── retry-failed-filters.js # 重试筛选失败的论文（降低并发）
│   ├── retry-last-failed.js    # 重试最后一批筛选/分析失败的论文
│   ├── refilter-problematic.js # 对问题论文重新执行筛选
│   ├── verify-filter-io.js     # 验证 filter_input_output 日志完整性
│   ├── migrate-icassp-images.js # 从 deep_analyzer_input_output 提取图片到 icassp-images/
│   └── batch-refilter.js       # 批量重新筛选指定论文
├── tests/                      # 单元测试
│   ├── utils.test.js           # utils.js 核心函数测试
│   └── config.test.js          # config.js 配置测试
├── data/
│   ├── current/                # 当前工作数据
│   │   ├── papers.json         # 论文去重数据库（不归档，持续累积）
│   │   ├── filtered-papers.json# 筛选结果（仅元数据，每日归档）
│   │   ├── deep-analysis-result.json  # 核心分析结果（每日归档）
│   │   ├── analyzed.json       # 旧版分析记录（兼容，每日归档）
│   │   ├── icassp_2026_deep_analyzers.json      # ICASSP 2026 深度分析结果
│   │   ├── icassp_2026_deep_analyzers-filtered.json  # ICASSP 筛选结果
│   │   ├── icassp_2026_deep_analyzers-excluded.json  # ICASSP 排除列表
│   │   ├── icassp-2026-snippets.json            # ICASSP PDF 文本片段缓存
│   │   ├── icassp-images/      # ICASSP 论文图片（按 paperId 子目录）
│   │   ├── filter_input_output/ # 筛选阶段输入输出日志（调试用）
│   │   ├── deep_analyzer_input_output/ # 深度分析输入输出日志（调试用）
│   │   └── output/             # 分类报告等输出文件
│   └── archive/                # 自动归档（按日期子目录 + bak 文件）
├── logs/                       # 运行日志（自动按脚本+时间命名，保留最近50个）
├── prompts/
│   ├── filter.md               # 筛选阶段 LLM prompt
│   ├── deep-analysis.md        # 深度分析阶段 LLM prompt
│   └── index.md                # prompt 文档索引
├── package.json                # npm scripts 定义
├── run-full-fetch.sh           # 全流程启动壳脚本（推荐入口）
└── README.md / SKILL.md
```

---

## 3. 主流程详解

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

筛选 prompt 从 `prompts/filter.md` 读取，运行时替换 `{title}`、`{abstract}` 占位符。判定标准如下：
- 语音合成/识别/增强/分离/克隆/转换 → **是**
- 音频生成/理解/音乐/事件检测 → **是**
- 说话人相关任务 → **是**
- 语音/音频相关模型、表示学习、预训练 → **是**
- 多模态模型只要明确涉及语音/音频（输入、输出、训练目标、评测任务或核心能力之一）→ **是**
- 其他领域且没有实质性语音/音频方法或任务 → **否**
- 冲突处理：若同时看起来满足”多模态涉及语音/音频”和”其他领域”，优先判定为 **是**

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
| 评分 | 1-10 分，保留一位小数；总分 = 学术质量(0-7) + 选题价值(0-2) + 开源与复现加成(-1~+1)，并输出 `rank_bucket`、`quality_score`、`value_score`、`confidence` 等机器摘要字段 |
| 标签 | 3-5 个，必须含至少 1 个【任务】和 1 个【方法/模型】标签；除最终标签串外，还要求输出“主任务标签”“主方法标签”“补充标签” |
| 作者与机构 | 第一作者、通讯作者、作者列表及所属机构；缺失信息必须写“未说明”，禁止猜测 |
| 毒舌点评 | 2-3 句话犀利点评亮点和槽点 |
| 核心摘要 | 5-8 句话，覆盖问题、方法、效果、局限性 |
| 模型架构 | 输入输出流程、组件结构、连接方式、设计理由 |
| 核心创新点 | 3-5 个，每个含定义、之前方法的不足、解决机制、实际效果 |
| 细节详述 | 训练数据、损失函数、训练策略、超参数、硬件、推理细节 |
| 实验结果 | 必须优先给出 benchmark、指标和具体数字；拿不到数字时明确写“论文未给出具体数值” |
| 评分理由 | 分别解释学术质量、选题价值、开源与复现加成 |
| 开源详情 | 只允许基于论文文本或当前输入链接总结，缺失时写”未提及”，禁止编造仓库/热度信息 |

> **图片与表格放置规则**：图片和表格不再集中在一个单独 section 中，而是直接嵌入到对应位置——架构图贴在**模型架构**部分，实验结果图/表贴在**实验结果**部分。严禁编造图片 URL，只能使用 prompt 中提供的 arXiv 图片 URL 列表中的真实 URL。

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

---

## 3.8 ICASSP 2026 本地 PDF 分析专题流程

本分支（`icassp-2026-analysis`）支持对会议本地 PDF 论文进行批量分析，与日常 arXiv 流程独立。该流程已在 ICASSP 2026 全量 3693 篇论文上验证，最终筛选出 898 篇语音/音频相关论文并完成深度分析。

### 3.8.1 整体流程

```
本地 PDF (3693篇)
    │
    ▼
PDF 文本+图片提取 (pdf-extractor.py / PyMuPDF)
    │
    ▼
纯 LLM 筛选 (标题 + PDF 前3000字符摘要)
    │  → 保留 898 篇语音/音频相关
    │  → 排除 ~2795 篇非相关
    │
    ▼
多模态深度分析 (全文 + PDF 图片)
    │  → mimo-v2.5 API， Anthropic 协议
    │  → 并发 3 篇，每篇最多 3 次重试
    │
    ▼
结构化结果 (icassp_2026_deep_analyzers.json)
    │
    ▼
博客发布 (Hugo，含任务分类汇总页 + 单篇页)
```

### 3.8.2 PDF 提取 (`scripts/pdf-extractor.py`)

使用 **PyMuPDF (fitz)** 从本地 PDF 提取文本和图片：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `max_text_chars` | 100000 | 最大提取文本字符数 |
| `max_images` | 10 | 最大提取图片数 |
| `max_base64_chars` | 500000 | 单张图片 base64 字符上限 |
| `min_image_dim` | 100 | 最小图片宽高（过滤小图标） |
| `min_image_area` | 10000 | 最小图片面积 |

图片处理：
- 使用 **Pillow** 对 oversized 图片进行缩放和 JPEG 压缩（质量逐级降低：85% → 70% → 50% → 30%）
- base64 编码后约增长 33%，脚本内部按 `max_base64_chars * 0.7` 作为原始大小阈值
- 若 PDF 内容检测到大量 `©2026 IEEE` 版权标记且前5行含 `IEEE` + `ICASSP`，输出 `warning` 提示可能为会议版权页而非正文

输出格式：JSON 到 stdout，包含 `text`、`images`（含 base64）、`pageCount`、`warning`。

### 3.8.3 筛选阶段 (`icassp-batch-analyze.js` 前半段)

**与日常 arXiv 流程的区别**：
- 不使用 arXiv 摘要，而是从 PDF 提取前 3000 字符作为 `_snippet`
- **纯 LLM 单篇判断**（非 batch），基于 `prompts/filter.md`
- 并发度默认 **8**（`ICASSP_FILTER_CONCURRENCY`），单篇超时 60 秒，重试 3 次
- 输出严格校验：必须为 `是/否` 或 `yes/no`，否则视为失败

**I/O 日志**：每篇筛选的输入（prompt + messages）和输出（statusCode + rawResponse + parsedContent）保存到 `data/current/filter_input_output/{paperId}.json`，用于事后验证和重试。

**断点续传**：提取的文本片段缓存在 `data/current/icassp-2026-snippets.json`，二次运行直接读取缓存，避免重复提取 PDF。

**筛选结果**：
- `icassp_2026_deep_analyzers-filtered.json`：保留的论文列表
- `icassp_2026_deep_analyzers-excluded.json`：排除的论文列表

### 3.8.4 深度分析阶段 (`icassp-batch-analyze.js` 后半段)

复用 `analysis-engine.js` 的 `analyzeBatch()`，但对 ICASSP 论文的特殊处理：

**全文来源**：
- 从 PDF 提取完整文本（上限 100K 字符），而非 arXiv HTML
- 无 `arxivId`，使用 `arnumber` 或 `paper_id` 作为唯一标识

**图片处理**（`deep-analyzer.js`）：
- `extractPdfContent()` 调用 `pdf-extractor.py` 获取文本和图片
- `savePdfImages()` 将提取的图片保存到 `data/current/icassp-images/{paperId}/{index}.{ext}`
- 分析时图片使用内部标识符 `icassp-img://{paperId}/{index}.{ext}` 替代 base64 数据 URL，避免 prompt 过大
- 分析前将本地图片读取为 base64，嵌入多模态 message
- 单张 base64 上限 500K 字符，图片数量无硬限制（实际受 API 上下文限制）

**I/O 日志**：
- 每篇分析的输入保存到 `data/current/deep_analyzer_input_output/{paperId}_input.json`
- 输出保存到 `data/current/deep_analyzer_input_output/{paperId}_output.json`
- 用于调试、重试和事后图片提取

**增量保存**：每分析完一篇立即合并保存到 `icassp_2026_deep_analyzers.json`，已有 `analysis` 的论文不会被覆盖。

### 3.8.5 图片迁移与处理

**`scripts/migrate-icassp-images.js`**：
- 从 `deep_analyzer_input_output/*_input.json` 中提取 base64 图片
- 解码保存到 `data/current/icassp-images/{paperId}/{index}.png|jpg`
- 用于博客发布时复制图片到 Hugo static 目录

### 3.8.6 任务分类 (`scripts/icassp-categorize.js`)

读取 `icassp_2026_deep_analyzers.json`，按以下维度生成分类 Markdown 报告：

1. **评分分布**：按 9.0-10.0 / 7.5-8.5 / 5.5-7.0 / 3.0-5.0 / 1.0-2.5 五档统计
2. **主任务分类**：按 `primaryTaskTag` 分组，每组内按评分降序
3. **主方法分类**：按 `primaryMethodTag` 分组
4. **分档分类**：按 `rankBucket` 分组
5. **标签统计**：所有标签的出现频次和平均评分
6. **完整列表**：全部论文的评分、分档、标签一览

输出：`data/current/output/icassp-2026-report.md`

### 3.8.7 博客发布（ICASSP 特殊逻辑）

`publish-to-blog.py` 对 ICASSP 论文有专门的发布逻辑：

**分类体系**：
- 所有 ICASSP 论文归入 Hugo 分类 `ICASSP 2026`
- 汇总页 slug：`icassp2026-summary`（非日期 slug）
- 汇总页标题：`ICASSP 2026 论文深度分析`

**任务分类汇总页**：
- 从所有论文的 `primaryTaskTag` 提取任务标签（去重后约 140 个）
- 为每个任务生成独立汇总页，文件名使用 ASCII-safe 格式：`icassp2026-task-XXX.md`
- 通过 `url:` frontmatter 设置中文 URL 路径（如 `/posts/icassp2026-task-语音识别/`）
- 每个任务页包含：该任务下所有论文的评分排行榜 + 每篇论文的简要分析（毒舌点评、核心摘要、标签等）

**图片处理**：
- `_copy_icassp_images()`：从 `data/current/icassp-images/{paperId}/` 复制到博客 `static/icassp-images/{date}/{paperId}/`
- `_extract_from_input()`：若本地图片目录不存在，从 `deep_analyzer_input_output/{paperId}_input.json` 回退提取
- `extract_and_replace_images()`：将分析文本中的内部标识符 `icassp-img://...` 替换为实际博客图片路径
- `sanitize_external_images()`：降级外部 URL（如 IEEE Xplore 返回 403、LLM 幻觉的 Unsplash URL）为纯文本描述

**Slug 生成**：
- ICASSP 论文没有 `arxivId`，使用 `arnumber` 或 `paper_id` 作为 ID
- `slugify()` 保留中/日/韩文、英文、数字，过滤特殊字符，最大 50 字符

**YAML 安全**：
- 标签值含 `#` 时必须用引号包裹（如 `tags: ["多音高估计 #音符跟踪"]`），否则 Hugo YAML 解析器会将 `#` 后内容视为注释

### 3.8.8 重试与修复脚本

| 脚本 | 用途 | 触发场景 |
|------|------|----------|
| `retry-failed-analysis.js` | 重新分析无评分的论文 | 深度分析后部分论文 `parsed.score` 为空 |
| `retry-text-only.js` | 文本-only 重新分析（跳过图片） | API 安全过滤拒绝含图片的论文 |
| `retry-failed-filters.js` | 重试筛选失败的论文 | `filter_input_output/` 中 statusCode ≠ 200 |
| `retry-last-failed.js` | 重试最后一批失败的筛选/分析 | 批量处理末尾失败 |
| `refilter-problematic.js` | 对问题论文重新筛选 | 筛选结果异常需重新判定 |
| `verify-filter-io.js` | 验证 filter I/O 完整性 | 检查是否有论文缺少筛选日志 |

### 3.8.9 ICASSP 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ICASSP_PAPERS_DIR` | `/Users/.../icassp-2026-papers/papers_2026` | PDF 论文目录 |
| `ICASSP_JSON_FILE` | `/Users/.../papers_2026.json` | 论文元数据 JSON |
| `ICASSP_RESULT_FILE` | `data/current/icassp_2026_deep_analyzers.json` | 结果保存路径 |
| `ICASSP_SKIP_FILTER` | `false` | 跳过筛选，直接分析 |
| `ICASSP_FILTER_ONLY` | `false` | 仅执行筛选 |
| `ICASSP_OFFSET` | `0` | 从第 N 篇开始（断点续传） |
| `ICASSP_LIMIT` | `0`（无限制） | 最多分析 N 篇 |
| `ICASSP_FILTER_CONCURRENCY` | `8` | 筛选并发度 |
| `ICASSP_FILTER_TIMEOUT` | `60000` | 筛选单篇超时（毫秒） |
| `ICASSP_FILTER_RETRIES` | `3` | 筛选重试次数 |

### 3.8.10 ICASSP 常用命令

```bash
# 完整流程：筛选 + 深度分析（增量续传）
node scripts/icassp-batch-analyze.js

# 仅执行筛选
ICASSP_FILTER_ONLY=true node scripts/icassp-batch-analyze.js

# 跳过筛选，直接分析已筛选的论文
ICASSP_SKIP_FILTER=true node scripts/icassp-batch-analyze.js

# 从第 500 篇开始分析（断点续传）
ICASSP_OFFSET=500 node scripts/icassp-batch-analyze.js

# 只分析前 100 篇
ICASSP_LIMIT=100 node scripts/icassp-batch-analyze.js

# 提取 PDF 内容测试
python3 scripts/pdf-extractor.py /path/to/paper.pdf --max-images 10

# 生成分类报告
node scripts/icassp-categorize.js

# 重试无评分的论文
node scripts/retry-failed-analysis.js

# 文本-only 重试（绕过 API 安全过滤）
node scripts/retry-text-only.js

# 重试筛选失败的论文（降低并发）
node scripts/retry-failed-filters.js

# 从分析日志提取图片到 icassp-images/
node scripts/migrate-icassp-images.js

# 发布 ICASSP 博客（含任务分类汇总页）
python3 scripts/publish-to-blog.py --date 2026-04-29 data/current/icassp_2026_deep_analyzers.json
```

---

## 4. 脚本分工（全部脚本详解）

### 4.1 主链路脚本

#### `scripts/full-fetch.js`

完整流程入口。执行第 3 节的所有步骤：自动归档 → arXiv 抓取 → HF 抓取 → 合并去重 → LLM 筛选 → 深度分析 → 增量保存 → 更新去重库。

所有配置从 `scripts/config.js` 读取，支持环境变量覆写：
- `ANALYSIS_CONCURRENCY = 3`（`PD_ANALYSIS_CONCURRENCY`）
- `ANALYSIS_RETRY_MAX = 2`（`PD_ANALYSIS_MAX_RETRIES`）
- `ANALYSIS_RETRY_DELAY_MS = 3000`
- `FETCH_DELAY_MS = 2000`

#### `scripts/deep-analysis-only.js`

仅运行深度分析（续跑模式）。
- 读取 `data/current/deep-analysis-result.json`（兼容旧路径 `data/deep-analysis-result.json`，自动识别旧格式纯数组并转换）
- 跳过已有 `analysis` 字段的论文
- 对未分析论文逐篇调用 `deep-analyzer.js`
- **仅成功结果写入保存**，失败结果不覆盖已有数据，断点续传安全

#### `scripts/reanalyze.js`

全量重分析。
- 默认数据源：`data/current/deep-analysis-result.json`（支持命令行传自定义文件路径，兼容旧格式纯数组）
- 对文件中**全部**论文重新调用 `deep-analyzer.js`
- 默认串行执行（并发 1），支持通过 `--concurrency N` 或 `PD_REANALYZE_CONCURRENCY` 环境变量调整并发度
- **每 5 篇保存一次中间结果**（并发模式下自动调整保存间隔），**仅成功结果覆盖旧数据**
- 启动时检查 `PAPER_ANALYZER_API_KEY`、`PAPER_ANALYZER_MODEL`、`PAPER_ANALYZER_ENDPOINT` 是否已设置，缺失则直接退出

#### `scripts/quick-test.js`

快速测试脚本。
- 执行 arXiv 7 分类抓取 + 去重 + LLM 筛选（配置来自 `config.js`）
- **不执行深度分析**
- 输出到 `data/quick-test-result.json`（仅保存前 10 篇）
- 用于验证抓取和筛选链路是否正常
- 直接调用：`node scripts/quick-test.js`（`npm run test` 已改为运行单元测试）

#### `scripts/batch-analyze.js`

批量分析未分析论文（独立入口）。
- 读取 `data/current/deep-analysis-result.json`
- 对未分析论文逐篇分析，**仅成功结果写入保存，失败结果不覆盖已有数据**，便于下次重试
- 适合在 `full-fetch.js` 中断后补跑剩余论文

#### `scripts/analyze-single-paper.js`

单独分析一篇论文并合并到结果中。

**用法**：`node scripts/analyze-single-paper.js <arxiv_id>`

- 从 `data/current/papers.json` 读取元数据
- 调用 `deep-analyzer.js` 分析后追加到 `deep-analysis-result.json`
- 若论文已在结果中存在则跳过
- 兼容旧格式纯数组数据，自动转换为新对象格式保存

### 4.2 抓取与分析支撑脚本

#### `scripts/fetch-papers.js`

arXiv 抓取与 LLM 筛选模块。
- 导出 `fetchCategoryPapers`、`deduplicatePapers`、`filterPapersWithLLM`、`isSpeechAudioRelated`、`filterPapersByKeywords`、`loadPapers`、`savePapers`、`loadAnalyzed`、`saveAnalyzed`
- 筛选阶段统一使用 `PAPER_ANALYZER_*` 环境变量，支持 HTTP CONNECT 代理
- 关键词预筛选函数 `filterPapersByKeywords` 保留但当前主流程未启用
- XML 解析为 regex 实现（arXiv API 格式稳定）

#### `scripts/config.js`

统一配置中心。所有硬编码参数集中管理，支持环境变量覆写：

| 配置项 | 默认值 | 环境变量覆写 |
|--------|--------|-------------|
| 分析并发度 | 3 | `PD_ANALYSIS_CONCURRENCY` |
| 分析重试次数 | 2 | `PD_ANALYSIS_MAX_RETRIES` |
| 筛选批次大小 | 5 | `PD_FILTER_BATCH_SIZE` |
| arXiv 每类抓取数 | 100 | `PD_ARXIV_MAX_RESULTS` |
| HF 抓取天数 | 7 | — |
| HF 最大页数 | 20 | — |
| 备份保留数 | 10 | — |
| 日志保留数 | 50 | — |

被 `fetch-papers.js`、`deep-analyzer.js`、`analysis-engine.js`、`full-fetch.js`、`reanalyze.js` 等所有核心脚本引用。

#### `scripts/analysis-engine.js`

统一分析引擎。封装以下功能，消除 `full-fetch.js` / `deep-analysis-only.js` / `batch-analyze.js` / `reanalyze.js` / `analyze-single-paper.js` 的重复逻辑：

- `analyzePaperWithRetry(paper, options)`：单篇分析（带重试 + 自动解析）
- `analyzeBatch(papers, options)`：批量分析（支持并发控制 + 增量保存回调）
- `mergeAndSaveResults(newResults, filePath, extraData)`：按 ID 去重合并并保存，**自带失败结果保护**（已有成功 analysis 的论文不会被无 analysis 的失败结果覆盖）
- `createFileSaver(filePath, baseData)`：创建文件保存回调，兼容旧格式纯数组数据自动转换

#### `scripts/fetch-huggingface-papers.js`

HuggingFace Papers 抓取模块。
- `fetchHuggingFacePapers(existingIds, { days, minUpvotes })`：双源抓取（daily_papers + papers API）
- `mergeAndDeduplicate(arxivPapers, hfPapers)`：合并去重，补充全部 7 个 HF 字段
- `convertDailyPaper()` / `convertPaper()`：数据标准化，输出字段与 arXiv 一致（含 `abstract` + `summary`）
- 使用 `curl` 命令获取数据
- 直接运行可测试：`node scripts/fetch-huggingface-papers.js`

#### `scripts/deep-analyzer.js`

多模态深度分析器。
- `analyzePaperDeep(paper)`：全文 + 图片分析主函数
- `parseAnalysis(analysis)`：将分析文本解析为结构化对象（score/tags/authors/roast/summary/architecture/innovation/details/results/scoringReason/opensource）
- `callModel(messages, maxTokens)`：带重试的 API 调用封装（最多 3 次重试，指数退避：第一次 10 秒，之后翻倍，`2^attempt * 5000ms`）
- `_callModelOnce()`：单次 API 调用，每次重试独立创建 AbortController 和 20 分钟超时
- 支持代理自动检测（环境变量 → macOS `scutil --proxy`）
- 支持纯 Node 内置模块的 HTTP CONNECT 代理
- 直接运行可测试：`node scripts/deep-analyzer.js <arxivId>`

### 4.3 发布脚本

#### `scripts/publish-to-blog.py`

发布到 Hugo 博客（GitHub Pages）。

**前置依赖**：
- 本地必须已克隆 Hugo 博客仓库到固定路径：`~/code/github_repos/audio-paper-digest-blog`
- 博客仓库使用 PaperMod 主题，通过 GitHub Actions 自动部署到 GitHub Pages
- 博客仓库的 `content/posts/` 目录存放生成的 Markdown 文件

**数据输入与处理**：
- 默认读取 `data/current/deep-analysis-result.json`
- 支持命令行传入自定义数据文件路径
- 数据经 `publish_common.py` 处理：按评分降序分为 `scored`（有评分）和 `unscored`（无评分/解析失败）两组
- 每篇论文通过 `parse_analysis()` 提取结构化字段，生成 Markdown

**Slug 生成规则**（`slugify()`）：
- 保留中文、日文假名、韩文、英文、数字
- 过滤特殊字符，空格和连续连字符转为单个 `-`
- 最大长度 50 字符，超长在最后一个 `-` 处截断
- 过滤后为空则兜底为 `paper`

**产物结构**：
```
~/code/github_repos/audio-paper-digest-blog/content/posts/
├── YYYY-MM-DD.md              # 汇总页
├── YYYY-MM-DD-<slug-1>.md     # 论文1独立页
├── YYYY-MM-DD-<slug-2>.md     # 论文2独立页
└── ...
```

**汇总页（`YYYY-MM-DD.md`）**：
- Hugo frontmatter：`title`（日期+论文速递）、`date`、`tags`（TOP 10 标签）、`categories: [论文速递]`、`description`、`layout: posts`
- **今日概览**：论文总数、热门方向分布（`█` 字符模拟柱状图）、评分排行榜 TOP 10
- **排行榜表格**：排名（medal）、论文标题（链接到单篇页）、评分、分档（`rankBucket`）、主任务标签
- **论文列表**：每篇的评分 emoji、标题链接、作者与机构、毒舌点评、核心摘要

**单篇页（`YYYY-MM-DD-<slug>.md`）**：
- Hugo frontmatter：
  - `title`：论文标题（YAML 安全转义，处理双引号、换行等）
  - `date`：博客日期
  - `tags`：解析后的标签（去除 `#`）
  - `categories: [论文速递]`
  - `description`：`主任务标签 | 评分/10`，无则回退到标题
  - `hiddenInHomeList: true`
- 正文：标签串 → 评分/分档/标签元信息 → 机器评分详情 → 作者与机构 → 各分析章节 → 返回汇总页链接

**发布流程**：
1. 生成 `.md` 文件到博客仓库 `content/posts/`
2. `git add -A` → `git commit -m "add: 论文速递 YYYY-MM-DD"` → `git push origin main`
3. GitHub Actions 自动构建并部署到 Pages
4. 访问：`https://<your-username>.github.io/<your-repo>/posts/YYYY-MM-DD/`

**参数**：
- `--date YYYY-MM-DD`（强烈建议显式指定，避免跨天时日期错误）
- `--skip-push` 只生成文件不推送
- 自定义数据文件路径作为最后一个参数

**重要限制**：脚本按输入文件中的全部 `papers` 生成，不会自动按 `published` 日期过滤。若文件中包含多日期论文，请确认这是你的意图。

**ICASSP 2026 支持**：当输入为 `icassp_2026_deep_analyzers.json` 时，脚本自动切换为 ICASSP 发布模式：
- 分类变为 `ICASSP 2026`，汇总页 slug 为 `icassp2026-summary`
- 生成任务分类汇总页（约 140 个任务标签），文件名 ASCII-safe + `url:` frontmatter
- 图片从 `data/current/icassp-images/` 复制到博客 static 目录
- 分析文本中的 `icassp-img://` 标识符替换为实际图片路径
- 详见 [3.8.7 博客发布（ICASSP 特殊逻辑）](#387-博客发布icassp-特殊逻辑)

#### `scripts/publish-wechat-full.py`

生成微信公众号图文草稿。

- 默认数据源：`data/current/deep-analysis-result.json`（支持命令行传入自定义路径）
- 微信公众号 `APP_ID` / `APP_SECRET` 从环境变量读取
- **图片上传**：下载 arXiv 图片 → 上传到微信 CDN → 替换为微信 URL。缓存保存在 `/tmp/wechat-image-cache.json`
- **自动分 Part**：单篇草稿上限约 48000 字符（HTML），超过自动拆分为多个草稿
  - 只有 Part 1 包含"今日概览"
  - 每 Part 标题：`语音/音频论文速递 YYYY-MM-DD | part N | M篇论文`
- 生成预览 HTML：`data/current/wechat-preview-YYYY-MM-DD.html`

#### `scripts/publish_common.py`

Python 发布公共模块。统一封装数据加载、评分排序、标签提取、格式化工具，消除 `publish-to-blog.py` / `publish-wechat-full.py` / `publish-xiaohongshu.py` 的重复逻辑。

主要函数：
- `load_papers(data_file)`：从 JSON 加载论文列表
- `score_and_sort(papers)`：解析分析结果，按评分降序排列
- `extract_top_tags(papers, limit)`：提取主任务标签并统计频次
- `score_emoji(score)` / `format_medal(index)`：评分 emoji 和奖牌格式化
- `build_paper_meta(pa, aurl)`：拼接评分/分档/标签元信息

#### `scripts/publish-xiaohongshu.py`

生成小红书文案。

- 默认数据源：`data/current/deep-analysis-result.json`
- 支持 `--top N` 精选版和 `--all` 完整汇总版
- 支持 `--date YYYY-MM-DD` 指定日期
- 输出到 `data/current/xiaohongshu-YYYY-MM-DD-<suffix>.md`
- 自动清理 Markdown 格式和学术化前缀
- 附带 emoji 热度标识：🔥≥8 分、✅≥6 分、📝<6 分（与博客、微信统一）

#### `scripts/publish-to-feishu.py`

生成飞书文档。

**凭据读取**：
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 从环境变量读取（与其他发布渠道一致，统一放在 `~/.hermes/.env`）

**数据输入**：
- 统一读取 `data/current/deep-analysis-result.json`（与其他发布渠道一致）
- 支持 `--date YYYY-MM-DD` 指定日期

**实现特点**：
- Python 实现，复用 `publish_common.py` 的数据加载和评分排序
- 调用飞书 docx API 创建文档并写入内容块
- Markdown 逐行转换为飞书块类型：heading1(3)/heading2(4)/heading3(5)/text(2)/bullet(12)/ordered(13)/divider(22)
- 每批最多 20 个块，分批写入

**飞书 docx API 调用流程**：
1. `auth/v3/tenant_access_token/internal` 获取 tenant_access_token
2. `docx/v1/documents` 创建新文档
3. `docx/v1/documents/{id}/blocks` 获取根块 ID
4. `docx/v1/documents/{id}/blocks/{root_id}/children` 分批写入内容

### 4.4 辅助脚本

#### `scripts/backfill_papers.py`

后台补录论文 ID（不分析）。
- 抓取 arXiv 7 分类（每类 30 篇）和 HF Papers（近 7 天）
- 耐限流设计：请求超时 30 秒，限流时指数退避，连续 20 篇已知 ID 提前停止
- 写入 `data/current/papers.json`
- 额外输出 `data/backfill-result.json`
- 独立日志：`logs/backfill.log`
- 依赖：`requests`（Python 第三方库）

#### `scripts/pdf-extractor.py`

本地 PDF 文本和图片提取器（PyMuPDF）。
- 提取文本（上限 100K 字符）和图片（上限 10 张，过滤小图标）
- 图片自动缩放压缩（Pillow）以适配 base64 大小限制
- 检测 IEEE 版权页异常并输出 warning
- 命令行工具，输出 JSON 到 stdout

#### `scripts/icassp-batch-analyze.js`

ICASSP 2026 批量分析主流程。
- **Title → PDF 路径映射**：通过归一化标题匹配本地 PDF 文件名
- **筛选阶段**：从 PDF 提取 snippet → 纯 LLM 单篇筛选（标题+摘要）→ I/O 日志到 `filter_input_output/`
- **深度分析阶段**：复用 `analysis-engine.js`，全文+图片多模态分析 → I/O 日志到 `deep_analyzer_input_output/`
- **增量保存**：每篇分析完立即保存，支持 `OFFSET`/`LIMIT` 断点续传
- 环境变量：`ICASSP_PAPERS_DIR`、`ICASSP_JSON_FILE`、`ICASSP_RESULT_FILE`、`ICASSP_SKIP_FILTER`、`ICASSP_FILTER_ONLY`、`ICASSP_OFFSET`、`ICASSP_LIMIT`

#### `scripts/icassp-categorize.js`

ICASSP 论文分类报告生成。
- 读取 `icassp_2026_deep_analyzers.json`
- 按评分区间、主任务标签、主方法标签、分档、全部标签生成 Markdown 报告
- 输出：`data/current/output/icassp-2026-report.md`

#### `scripts/retry-failed-analysis.js`

重新分析无评分的论文。
- 遍历 `icassp_2026_deep_analyzers.json`，找出 `parsed.score` 为空的论文
- 调用 `analyzePaperDeep()` 重新分析
- 处理 API 拒绝信息（含 `rejected` 字样时记录但不覆盖）
- 每篇处理后立即保存进度

#### `scripts/retry-text-only.js`

文本-only 重新分析（跳过图片）。
- 针对被 API 安全过滤拒绝的论文（如 PerformSinger）
- 不使用图片，仅传入前 15000 字符文本
- 调用 `callModel()` 直接获取分析文本，绕过图片相关的安全拦截

#### `scripts/retry-failed-filters.js`

重试筛选失败的论文。
- 读取 `filter_input_output/`，找出 statusCode ≠ 200 的记录
- 降低并发（默认 3）并增加批次延迟（默认 2000ms）
- 重新执行 LLM 筛选并更新 I/O 日志
- 重新生成 `-filtered.json` 结果

#### `scripts/migrate-icassp-images.js`

从深度分析输入日志提取图片。
- 遍历 `deep_analyzer_input_output/*_input.json`
- 提取 message 中的 base64 图片数据
- 解码保存到 `data/current/icassp-images/{paperId}/{index}.png|jpg`
- 用于博客发布时的图片复制

#### `scripts/backup-data.sh`

数据备份壳脚本。

---

## 5. 数据文件格式详解

### 5.1 `data/current/papers.json`

论文去重数据库。**此文件不归档，持续累积。** 结构：

```json
{
  "papers": {
    "arxivId-1": {
      "arxivId": "2604.12345",
      "title": "论文标题",
      "abstract": "摘要...",
      "authors": ["Author A", "Author B"],
      "published": "2026-04-20T00:00:00+08:00",
      "categories": ["cs.SD", "eess.AS"],
      "fetchedFrom": "cs.SD",
      "fetchedAt": "2026-04-21T10:00:00+08:00"
    }
  },
  "lastUpdated": "2026-04-21T10:00:00+08:00"
}
```

### 5.2 `data/current/filtered-papers.json`

筛选结果（仅元数据，无深度分析）。结构：

```json
{
  "timestamp": "2026-04-21T10:00:00+08:00",
  "papers": [
    {
      "arxivId": "2604.12345",
      "title": "...",
      "abstract": "...",
      "authors": [...],
      "published": "2026-04-20T00:00:00+08:00",
      "categories": [...],
      "sources": ["arxiv"],
      "hf_upvotes": 0,
      "hf_ai_summary": "",
      "hf_github_repo": ""
    }
  ]
}
```

### 5.3 `data/current/deep-analysis-result.json`

核心分析结果。结构：

```json
{
  "timestamp": "2026-04-21T10:00:00+08:00",
  "previousTimestamp": "2026-04-20T10:00:00+08:00",
  "stats": {
    "arxivFetched": 200,
    "hfFetched": 50,
    "totalMerged": 230,
    "afterFilter": 28,
    "newlyAnalyzed": 28,
    "preservedExisting": 15,
    "totalAfterMerge": 43,
    "arxivOnly": 20,
    "hfOnly": 5,
    "both": 3
  },
  "papers": [
    {
      "arxivId": "2604.12345",
      "title": "...",
      "authors": [...],
      "published": "2026-04-20T00:00:00+08:00",
      "categories": [...],
      "sources": ["arxiv"],
      "hf_upvotes": 0,
      "hf_ai_summary": "",
      "hf_ai_keywords": [],
      "hf_github_repo": "",
      "hf_project_page": "",
      "hf_github_stars": 0,
      "hf_discussion_id": "",
      "analysis": "## 评分\n8.5/10\n\n## 标签\n...",
      "parsed": {
        "score": "8.5",
        "tags": ["#语音合成", "#扩散模型", "#多语言"],
        "authors": "...",
        "roast": "...",
        "summary": "...",
        "architecture": "...",
        "innovation": "...",
        "details": "...",
        "results": "...",
        "scoringReason": "...",
        "opensource": "..."
      },
      "imageUrls": ["https://arxiv.org/html/.../fig1.png"],
      "allImageUrls": ["..."]
    }
  ]
}
```

### 5.4 `data/current/analyzed.json`

旧版已分析记录（`fetch-papers.js` 直跑流程遗留）。当前主流程不直接使用，但保留兼容，参与每日归档。

### 5.5 `data/current/icassp_2026_deep_analyzers.json`

ICASSP 2026 深度分析核心结果。结构上与 `deep-analysis-result.json` 类似，但有以下区别：

```json
{
  "timestamp": "2026-04-29T12:22:00+08:00",
  "papers": [
    {
      "arnumber": "11460320",
      "title": "论文标题",
      "pdfPath": "/Users/.../papers_2026/Title Words.pdf",
      "paper_id": "11460320",
      "authors": ["Author A", "Author B"],
      "categories": ["eess.AS", "cs.SD"],
      "analysis": "## 评分\n8.5/10\n...",
      "parsed": {
        "score": "8.5",
        "tags": ["#语音识别", "#自监督学习", "#多语言"],
        "primaryTaskTag": "#语音识别",
        "primaryMethodTag": "#自监督学习",
        "rankBucket": "前25%",
        "authors": "...",
        "roast": "...",
        "summary": "...",
        "architecture": "...",
        "innovation": "...",
        "details": "...",
        "results": "...",
        "scoringReason": "...",
        "opensource": "..."
      },
      "imageUrls": ["icassp-img://11460320/0.png"],
      "allImageUrls": ["icassp-img://11460320/0.png", "icassp-img://11460320/1.jpg"]
    }
  ]
}
```

**关键字段**：
- `arnumber`：IEEE 论文编号（替代 arXiv 的 `arxivId`）
- `pdfPath`：本地 PDF 文件路径
- `paper_id`：内部唯一标识（通常为 `arnumber`）
- `imageUrls` / `allImageUrls`：内部图片标识符列表（`icassp-img://{paperId}/{index}.{ext}`），非真实 URL
- `parsed`：预解析的结构化数据，发布脚本优先使用此字段而非重新解析 `analysis` 文本

### 5.6 `data/current/icassp-images/`

本地图片存储目录，结构：

```
icassp-images/
├── 11460320/
│   ├── 0.png
│   └── 1.jpg
├── 11460321/
│   └── 0.png
└── ...
```

- 每个 `arnumber` 一个子目录
- 图片从 `pdf-extractor.py` 提取后由 `savePdfImages()` 保存，或事后由 `migrate-icassp-images.js` 从分析日志中提取
- 博客发布时复制到 Hugo 博客的 `static/icassp-images/{date}/{paperId}/`

### 5.7 `data/current/filter_input_output/`

筛选阶段 I/O 日志目录。每篇论文一个 JSON 文件 `{paperId}.json`：

```json
{
  "paperId": "11460320",
  "timestamp": "2026-04-28T14:25:00+08:00",
  "input": { "prompt": "...", "messages": [...] },
  "output": { "statusCode": 200, "rawResponse": {...}, "parsedContent": "是" }
}
```

用于：筛选结果验证、失败重试、调试 prompt 效果。

### 5.8 `data/current/deep_analyzer_input_output/`

深度分析阶段 I/O 日志目录。每篇论文两个文件：
- `{paperId}_input.json`：完整的 LLM 请求体（含 base64 图片）
- `{paperId}_output.json`：LLM 原始返回结果

用于：调试分析质量、事后图片提取（`migrate-icassp-images.js`）、分析失败排查。

---

## 6. 环境变量与模型配置

### 6.1 统一存放位置

**所有环境变量统一放在 `~/.hermes/.env`。**

`.zshrc` 已配置自动加载：
```zsh
set -a; source ~/.hermes/.env 2>/dev/null; set +a
```

这样设计的好处：
- 敏感配置集中管理，不写入脚本
- shell 启动时自动注入，Python 脚本（`publish-wechat-full.py` 等）直接通过 `os.environ` 读取
- Node 脚本通过 `loadEnvFile()` 二次兜底（仅补未设置的变量）

### 6.2 环境变量清单

#### 筛选与深度分析（统一使用 `PAPER_ANALYZER_*`）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PAPER_ANALYZER_API_KEY` | LLM API Key | **必填** |
| `PAPER_ANALYZER_ENDPOINT` | LLM API 端点（不带路径后缀，脚本自动拼接） | **必填** |
| `PAPER_ANALYZER_MODEL` | LLM 模型名 | **必填** |
| `PD_ANALYSIS_CONCURRENCY` | 深度分析并发度 | 3 |
| `PD_ANALYSIS_MAX_RETRIES` | 深度分析单篇重试次数 | 2 |
| `PD_REANALYZE_CONCURRENCY` | 重分析并发度 | 1 |
| `PD_FILTER_BATCH_SIZE` | LLM 筛选每批篇数 | 5 |
| `PD_ARXIV_MAX_RESULTS` | arXiv 每类抓取数量 | 100 |

**API 协议自动路由**：`scripts/utils.js` 中的 `detectApiType()` 会根据端点和模型名自动判断使用 OpenAI 还是 Anthropic 协议
- **Anthropic 协议**（自动伪装 Claude Code）：端点含 `token-plan` 或 `coding` **且** 模型含 `mimo` 或 `kimi`
  - **MiMo Token Plan**: `https://token-plan-cn.xiaomimimo.com/v1` → `https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages`
  - **Kimi Coding Plan**: `https://api.kimi.com/coding/v1` → `https://api.kimi.com/coding/v1/messages` 不需要 `/anthropic` 中间路径
  - Headers: `x-api-key` + `anthropic-version: 2023-06-01` + `User-Agent: claude-cli/<version> (external, cli)`（版本号动态获取自本地 `claude --version`，失败回退到 `2.1.108`）
- **OpenAI 协议**（通用模式）：所有其他端点/模型
  - 端点保持原样，自动拼接 `/v1/chat/completions`
  - Headers: `Authorization: Bearer {key}`

#### 博客发布

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PAPER_DIGEST_BLOG_REPO` | Hugo 博客仓库本地路径 | `~/code/github_repos/audio-paper-digest-blog` |
| `PAPER_DIGEST_BLOG_BASE_PATH` | 博客站点 base URL 路径（影响内部链接） | `/audio-paper-digest-blog` |
| `PAPER_DIGEST_BLOG_URL` | 博客部署后的访问地址（如 `https://xxx.github.io/xxx`） | 空 |
| `PAPER_DIGEST_GITHUB_REMOTE` | Git 远程仓库名称 | `origin` |

#### 微信公众号

| 变量 | 说明 |
|------|------|
| `WECHAT_APP_ID` | 微信公众号 AppID |
| `WECHAT_APP_SECRET` | 微信公众号 AppSecret |
| `WECHAT_THUMB_MEDIA_ID` | 封面图永久素材 ID（可选，未设置时使用默认素材） |
| `PAPER_DIGEST_AUTHOR` | 微信公众号文章作者名（可选） |

#### 飞书文档

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 App ID（如 `cli_xxx`） |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret |

> 写入 `~/.hermes/.env` 即可（不需要 `export` 前缀）。脚本运行时会自动 `source` 该文件。

#### 代理

| 变量 | 说明 |
|------|------|
| `https_proxy` / `HTTPS_PROXY` | HTTPS 代理 |
| `http_proxy` / `HTTP_PROXY` | HTTP 代理 |
| `all_proxy` / `ALL_PROXY` | 全局代理 |

支持 HTTP CONNECT 代理，纯 Node 内置模块实现，无需外部依赖。自动检测顺序：环境变量 → macOS 系统代理（`scutil --proxy`）。

### 6.3 配置示例

`~/.hermes/.env` 格式（**不需要 `export` 前缀**）：

```bash
# Paper Digest 环境变量

# === 方案 1: MiMo Token Plan（推荐，伪装 Claude Code 调用 Anthropic 协议）===
PAPER_ANALYZER_API_KEY=tp-your-token-plan-key
PAPER_ANALYZER_MODEL=mimo-v2.5
PAPER_ANALYZER_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1

# === 方案 2: MiMo 按量付费（通用 OpenAI 协议）===
# PAPER_ANALYZER_API_KEY=sk-your-pay-as-you-go-key
# PAPER_ANALYZER_MODEL=mimo-v2.5
# PAPER_ANALYZER_ENDPOINT=https://api.xiaomimimo.com/v1

# === 方案 3: Kimi Coding Plan（伪装 Claude Code 调用 Anthropic 协议）===
# PAPER_ANALYZER_API_KEY=sk-your-kimi-key
# PAPER_ANALYZER_MODEL=kimi-for-coding
# PAPER_ANALYZER_ENDPOINT=https://api.kimi.com/coding/v1

# === 方案 4: 通用 OpenAI 兼容端点 ===
# PAPER_ANALYZER_API_KEY=sk-your-openai-key
# PAPER_ANALYZER_MODEL=gpt-4o
# PAPER_ANALYZER_ENDPOINT=https://api.openai.com/v1

# 微信公众号（如需发布）
WECHAT_APP_ID=your-app-id
WECHAT_APP_SECRET=your-app-secret
# PAPER_DIGEST_AUTHOR=your-name

# 飞书（其他项目共用）
FEISHU_APP_ID=your-feishu-app-id
FEISHU_APP_SECRET=your-feishu-app-secret

# 博客/小红书（如需在文案中展示博客地址）
# PAPER_DIGEST_BLOG_URL=https://your-username.github.io/your-repo
```

**重要说明**：
- 端点格式统一为 `协议://域名/v1`，不管后续用哪种协议，配置方式一致
- 脚本会根据端点和模型名自动判断是否需要使用 Anthropic 协议
- Token Plan key 前缀为 `tp-`，按量付费 key 前缀为 `sk-`，两者不可混用

---

## 7. 日志机制

所有主脚本启动后会自动写日志：

- **Node 脚本**：通过 `scripts/log-setup.js`
- **Python 脚本**：通过 `scripts/log_setup.py`
- **输出位置**：`logs/<script-name>-YYYYMMDD-HHMMSS.log`
- **特性**：同时输出到终端和日志文件（Tee 模式），flush 及时
- **自动清理**：每次启动时清理旧日志，**保留最近 50 个**

特殊日志：
- `backfill_papers.py` 额外写 `logs/backfill.log`（持久追加）
- `logs/full-fetch-*.log` 是排查抓取/分析问题的首选

**后台缓冲处理**：所有主要 Node 脚本已调用 `process.stdout._handle.setBlocking(true)`，确保后台运行时日志实时 flush。

---

## 8. 常用命令速查

### npm scripts

```bash
# 全流程（抓取 + 筛选 + 深度分析）
npm run fetch

# 仅深度分析续跑（跳过已有 analysis）
npm run deep

# 全量重分析
npm run reanalyze

# 批量分析未分析论文
npm run batch

# 运行单元测试
npm test

# 快速测试（抓+筛选，不分析）
node scripts/quick-test.js

# 补录历史 paper ID
npm run backfill

# 发布博客
npm run publish -- --date 2026-04-21

# 生成微信公众号草稿
npm run wechat

# 生成小红书文案
npm run xiaohongshu

# 生成飞书文档
python3 scripts/publish-to-feishu.py
python3 scripts/publish-to-feishu.py --date 2026-04-21
```

### 直接调用

```bash
# ========== 核心流程 ==========
# 全流程（推荐入口）
./run-full-fetch.sh

# 或直接用 Node
node scripts/full-fetch.js

# 仅深度分析续跑（跳过已有 analysis）
node scripts/deep-analysis-only.js

# 全量重分析
node scripts/reanalyze.js

# 指定并发度重分析
node scripts/reanalyze.js --concurrency 3 data/current/deep-analysis-result.json

# 快速测试（抓+筛选，不分析）
node scripts/quick-test.js

# 批量分析未分析论文
node scripts/batch-analyze.js

# 单独分析一篇论文
node scripts/analyze-single-paper.js 2604.16044

# ========== 发布 ==========
# 发布博客（强烈建议显式 --date）
python3 scripts/publish-to-blog.py --date 2026-04-21

# 只生成 Markdown，不推送
python3 scripts/publish-to-blog.py --skip-push --date 2026-04-21

# 用自定义数据发布
python3 scripts/publish-to-blog.py --date 2026-04-21 data/current/deep-analysis-result.json

# 生成微信公众号草稿
python3 scripts/publish-wechat-full.py

# 用自定义数据生成微信草稿
python3 scripts/publish-wechat-full.py data/current/deep-analysis-result.json

# 生成小红书文案（默认 TOP 5）
python3 scripts/publish-xiaohongshu.py
python3 scripts/publish-xiaohongshu.py --top 7
python3 scripts/publish-xiaohongshu.py --all

# 生成飞书文档
python3 scripts/publish-to-feishu.py
python3 scripts/publish-to-feishu.py --date 2026-04-21

# ========== 辅助 ==========
# 补录论文 ID（不分析）
python3 scripts/backfill_papers.py
```

---

## 9. 安装与初始化

### 9.1 依赖

- **Node.js** ≥ 18.0.0（`node` / `npm`）
- **Python** 3.x（`python3` / `pip3`）
- Node.js 依赖：`cheerio`（arXiv HTML 结构化解析）
- Python 第三方库：`requests`（仅 `backfill_papers.py` 使用）

### 9.2 初始化

```bash
cd ~/.hermes/skills/openclaw-imports/audio-paper-digest

# 安装 Node.js 依赖
npm install

# 安装 Python 依赖（如有需要）
pip3 install requests

# 创建必要目录
mkdir -p data/current data/archive logs

# 配置 API Key
mkdir -p ~/.hermes
cat >> ~/.hermes/.env << 'EOF'
PAPER_ANALYZER_API_KEY=your-llm-key
PAPER_ANALYZER_MODEL=your-llm-model
PAPER_ANALYZER_ENDPOINT=https://your-llm-endpoint/v1

# 如需发布微信公众号，额外设置：
# WECHAT_APP_ID=your-app-id
# WECHAT_APP_SECRET=your-app-secret
EOF

# 确保 .zshrc 已 source ~/.hermes/.env
# （若尚未配置，在 ~/.zshrc 末尾添加：set -a; source ~/.hermes/.env 2>/dev/null; set +a）
```

### 9.3 博客仓库准备

发布博客需要本地已克隆 Hugo 博客仓库。默认路径为 `~/code/github_repos/audio-paper-digest-blog`，可通过环境变量 `PAPER_DIGEST_BLOG_REPO` 自定义：

```bash
# 默认路径（不设置 env 时的默认值）
git clone https://github.com/your-username/your-blog-repo.git \
  ~/code/github_repos/audio-paper-digest-blog

# 或自定义路径
export PAPER_DIGEST_BLOG_REPO="~/my-blog-repo"
```

博客仓库要求：
- Hugo 站点，使用 PaperMod 主题（或其他支持的标准主题）
- 通过 GitHub Actions 自动部署到 GitHub Pages
- `content/posts/` 目录存放生成的 Markdown 文件
- 若博客部署在子路径下，设置 `PAPER_DIGEST_BLOG_BASE_PATH`（如 `/audio-paper-digest-blog`）

### 9.4 飞书凭据准备

发布飞书文档需要飞书自建应用的 `App ID` 和 `App Secret`：

```bash
# 写入 ~/.hermes/.env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=your-full-app-secret
```

> 获取方式：飞书开放平台 → 开发者后台 → 创建企业自建应用 → 查看凭证。

---

## 10. 日期安全策略（必须遵守）

1. **发布时优先显式指定 `--date`**
   - 不要依赖脚本的默认"今天"
   - 跨天运行时尤其要注意

2. **发布前确认输入数据文件里的论文日期分布**
   ```bash
   python3 - <<'PY'
   import json
   from collections import Counter
   with open('data/current/deep-analysis-result.json') as f:
       d = json.load(f)
   papers = d.get('papers', [])
   dates = [p.get('published', '')[:10] for p in papers if p.get('published')]
   print('总论文:', len(papers))
   print('日期分布:', Counter(dates))
   PY
   ```

3. **用户明确"不要动某天"时，禁止删除/覆盖该日期内容**
   - `publish-to-blog.py` 会全量重写目标日期的汇总页
   - 若数据文件包含多日期论文，请拆分数据或确认意图后再发布

4. **不要重复发布同一天**
   - 重复运行 `publish-to-blog.py --date 2026-04-21` 会覆盖该日期的博客文件
   - 如需追加论文，应重新生成完整数据后再发布

---

## 11. 快速开始

```bash
# 1. 进入项目目录
cd ~/.hermes/skills/openclaw-imports/audio-paper-digest

# 2. 运行全流程（抓取 + 筛选 + 分析）
#    预计耗时：根据论文数量，约 30-120 分钟
./run-full-fetch.sh

# 3. 检查分析结果
ls -lh data/current/deep-analysis-result.json
python3 -c "import json; d=json.load(open('data/current/deep-analysis-result.json')); print('论文数:', len(d['papers']))"

# 4. 确认日期分布后，发布博客
python3 scripts/publish-to-blog.py --date 2026-04-21

# 5. 生成微信公众号草稿
python3 scripts/publish-wechat-full.py

# 6. 生成小红书文案
python3 scripts/publish-xiaohongshu.py
```

---

## 12. 排错手册

### 12.1 模型调用失败 / API 返回 401 / 403

**检查步骤**：

1. **检查 key/endpoint/model 三元组是否匹配**
   - MiMo Token Plan key 前缀为 `tp-`，必须配合 Token Plan 端点 `token-plan-cn.xiaomimimo.com`
   - MiMo 按量付费 key 前缀为 `sk-`，必须配合按量付费端点 `api.xiaomimimo.com`
   - 两者混用必返回 401

2. **检查是否走对了协议**
   - 查看日志中的 `[filter] API 类型: xxx` 或 `[api] → model | xxx` 行，确认显示 `anthropic` 还是 `openai`
   - 若使用 MiMo/Kimi Token Plan 却显示 `openai`，检查端点是否含 `token-plan` 或 `coding`，模型是否含 `mimo` 或 `kimi`

3. **Anthropic 协议专项检查**（日志显示 `anthropic` 时）
   - 确认请求头中包含 `User-Agent: claude-cli/<version> (external, cli)`（日志中不会直接显示，但可以用 tcpdump 或代理工具验证）
   - 确认使用的是 `x-api-key` 而非 `Authorization: Bearer`
   - 确认 URL 路径是 `/anthropic/v1/messages` 而非 `/v1/chat/completions`

4. **OpenAI 协议专项检查**（日志显示 `openai` 时）
   - 确认使用 `Authorization: Bearer {key}`
   - 确认 URL 路径是 `/v1/chat/completions`

5. **检查代理**
   - MiMo Token Plan 在有系统代理时可能被屏蔽，尝试关闭代理或设置 `agent: false`
   - 详见 12.7 节

6. **查看日志**：`logs/full-fetch-*.log`、`logs/deep-analyzer-*.log`

### 12.2 深度分析慢或频繁失败

- 查看日志：`logs/deep-analyzer-*.log`、`logs/full-fetch-*.log`
- 检查 key/endpoint/model 三元组是否匹配（见 12.1 节）
- 若超时，脚本会自动降级为纯文本重试；若仍失败，检查代理或减小并发
- 可用 `node scripts/deep-analysis-only.js` 安全续跑

### 12.3 重分析启动即报 key 未配置

- 在 `~/.hermes/.env` 中配置 `PAPER_ANALYZER_API_KEY`、`PAPER_ANALYZER_MODEL`、`PAPER_ANALYZER_ENDPOINT`
- 重新 source：`source ~/.zshrc`

### 12.4 发布后提示"没有新内容需要推送"

在博客仓库检查：
```bash
cd ~/code/github_repos/audio-paper-digest-blog
git status --short
ls -lt content/posts | head -20
```

可能原因：
- `--skip-push` 被误用
- 数据文件为空或论文分析失败
- 目标日期文件已存在且内容相同

### 12.5 路径混淆

- **优先使用** `data/current/deep-analysis-result.json`
- 旧路径 `data/deep-analysis-result.json` 仅在兼容场景下读取
- 若同时存在新旧路径，脚本优先选择 `data/current/`

### 12.6 HuggingFace 抓取为空

- 检查网络连接（`curl https://huggingface.co/api/daily_papers?limit=10`）
- 检查是否被限流或需要代理
- `fetch-huggingface-papers.js` 使用 `curl` 命令，确保系统 `curl` 可用

### 12.7 MiMo API 返回 403 / 代理问题

**根因**：Node.js `https.request` 的 `agent: undefined` 仍会复用全局默认 agent 的连接池。当系统配置了代理（`https_proxy` 等环境变量）时，全局 agent 的连接可能被代理污染，导致 MiMo Token Plan 服务端拒绝请求。

**修复**：`fetch-papers.js` 和 `deep-analyzer.js` 中 LLM API 请求的 `options.agent` 必须设为 `false`（不是 `undefined`），彻底禁用连接复用，强制每个请求建立新连接：

```javascript
const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: headers,
    agent: false,  // ← 必须是 false，undefined 无效
    signal: controller.signal
};
```

**验证**：直接用 `curl --noproxy "xiaomimimo.com"` 测试，若绕过代理成功而脚本失败，即为此问题。

### 12.8 图片上传微信 CDN 失败

- 检查 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` 是否过期
- 检查图片是否过大或被 arXiv 限制
- 微信图片上传有频率限制，大量图片可能需要分批执行

---

## 13. 维护约定

- 流程、路径、关键参数变更后，**必须同步更新** `README.md` 与 `SKILL.md`
- 文档冲突时，以当前脚本行为为准并立即修正文档
- **禁止在脚本中硬编码真实 API key、微信凭证或飞书凭证**，所有凭证统一通过环境变量读取
- 新增脚本需在 `README.md` 第 4 节和 `SKILL.md` 第 5 节登记
- 新增分析相关脚本应优先复用 `analysis-engine.js`，避免重复实现重试/保存逻辑
- 新增可配置参数应放入 `config.js`，并同步添加环境变量覆写支持
- 修改 `prompts/deep-analysis.md` 或 `prompts/filter.md` 后，代码会自动读取最新内容，无需改代码
- 修改 `deep-analyzer.js` 输出契约后，需同步检查 `scripts/utils.js` 与 `scripts/utils.py`
- 修改 `config.js` 后，需同步更新 `tests/config.test.js`
- 修改评分/标签/机器摘要格式后，需抽样验证 `data/current/deep-analysis-result.json` 和最终博客/社媒产物
- **安全审计**：定期检查代码中是否意外泄露 API key、token、凭证备份文件或环境变量快照；`data/` 和 `logs/` 目录下的临时/备份文件严禁提交到版本控制
- **`.gitignore` 要求**：确保 `data/`、`logs/`、`*.env`、`*.backup*`、`.DS_Store`、`*-cache.json`、敏感日志等被正确忽略

---

## 14. 附录：当前评分与标签口径

`deep-analyzer.js` 当前使用三段式评分体系，并要求同步输出机器摘要：

### 14.1 评分公式

总分 = 学术质量分（0-7）+ 选题价值分（0-2）+ 开源与复现加成（-1 到 +1）

同时必须输出以下机器摘要字段：
- `rank_bucket`
- `quality_score`
- `value_score`
- `reproducibility_bonus`
- `confidence`
- `primary_task_tag`
- `primary_method_tag`
- `sota_claim`
- `has_code`
- `has_model`
- `has_dataset`

### 14.2 分项定义

| 维度 | 范围 | 说明 |
|------|------|------|
| 学术质量 | 0-7 | 综合创新性、技术正确性、实验充分性、证据可信度 |
| 选题价值 | 0-2 | 综合前沿性、潜在影响、实际应用空间、与语音/音频读者相关性 |
| 开源与复现加成 | -1 到 +1 | 代码、模型、数据、训练细节、超参数、复现实操信息是否充分 |

### 14.3 分档要求

- `rank_bucket` 只能从 `前10% / 前25% / 前50% / 后50%` 中选择
- `9.0-10.0`：突破性、极强说服力、领域里程碑候选
- `7.5-8.5`：明显优秀，有扎实创新和较强影响力
- `5.5-7.0`：有价值但不够突出，属于合格到良好
- `3.0-5.0`：创新有限、实验薄弱、结论一般或存在明显短板
- `1.0-2.5`：问题严重，不推荐投入时间

### 14.4 标签输出要求

- 最终标签总数为 3-5 个
- 必须至少包含 1 个【任务】标签和 1 个【方法/模型】标签
- 必须额外输出 `主任务标签`、`主方法标签`、`补充标签`
- `主任务标签` 和 `主方法标签` 都只能有 1 个，且必须来自最终标签集合
- `音频大模型` 与 `语音大模型` 二选一；使用 `多模态模型` 时通常不再重复标 `音视频`

### 14.5 输出契约变更检查清单

当 `prompts/deep-analysis.md` 或评分/标签规范发生变化时，至少检查以下内容：

1. 确认 `scripts/utils.js` 中的 `loadPrompt()` 能正确读取 `prompts/` 目录下的 markdown 文件
2. `scripts/utils.js` 与 `scripts/utils.py` 是否仍能正确解析 `### 机器摘要`、标签和评分字段
3. 抽样检查 `data/current/deep-analysis-result.json`，确认存在 `rank_bucket`、`primary_task_tag`、`primary_method_tag`
4. 验证博客发布脚本产物，确认榜单、单篇页和热门方向正确显示新字段
5. 验证微信/小红书脚本产物，确认文案中没有因字段缺失导致的空值或格式错位

---

## 15. 参考与致谢

- 本项目在设计和实现过程中参考了 [speech-paper-daily-skill](https://github.com/JusperLee/speech-paper-daily-skill) 的思路与结构
