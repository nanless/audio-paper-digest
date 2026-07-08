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

此外，最终保存新的深度分析结果前，若已有 `deep-analysis-result.json` 且包含数据，会先备份到 `data/archive/deep-analysis-result-<时间戳>.bak.json`，并自动清理旧备份（保留最近 10 个）。这一步发生在分析完成后的最终保存阶段，不属于启动时的每日归档。

### 3.2 加载去重库与博客去重

运行开始时，首先加载去重集合：

1. **papers.json**：读取 `data/current/papers.json` 中已有的论文 ID
2. **博客已发布**：扫描 Hugo 博客仓库（`PAPER_DIGEST_BLOG_REPO`，默认 `~/code/github_repos/audio-paper-digest-blog`）的 `content/posts/` 目录，从所有 `.md` 文件中提取 `arxiv.org/abs/XXXX.XXXXX` 格式的 arXiv ID

两者合并为统一去重集合，后续 arXiv 抓取和 HuggingFace 抓取都会跳过集合中的已有 ID，**在抓取阶段就排除已发布论文，避免浪费 LLM API 调用。**

### 3.3 arXiv 抓取

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

**抓取策略：recent 页面 → 搜索页 → API 三级**

1. **recent 页面（主要方式）**：
   - 从 `arxiv.org/list/{category}/recent` 页面抓取，支持翻页（`?skip=50&show=50`，每类最多 100 篇）
   - recent 页面限流策略宽松，优先使用
   - 抓取后自动补充摘要（`fetchAbstracts`）
   - 获取到足够论文后跳过后续步骤

2. **搜索页（备用）**：
   - recent 不足时，从 `arxiv.org/search/` 搜索页面补充
   - 每页 50 篇，支持分页获取
   - 使用 User-Agent 轮换，页面间延迟 10-25 秒

3. **API 补充（最后兜底）**：
   - 上两步均不足时，使用 `export.arxiv.org/api/query`
   - 429 限流指数退避：60s, 120s, 240s, 480s，最多 5 次重试

3. **抓取参数**：
   - **提前停止**：若连续遇到 20 篇已有 ID（存在于 `papers.json`），则停止该分类抓取
   - 核心类别优先抓取，补充类别随机排序
   - 类别间延迟约 70-90 秒起（`categoryDelayMs=60s` + 10-30 秒随机抖动，限流时额外补偿）
   - 无新论文时继续运行而非终止

4. **终端输出**：
   - 显示每篇新论文的 arXiv ID 和标题
   - 显示搜索到的总篇数和去重后的篇数

去重逻辑：`deduplicatePapers()` 按 `arxivId` 去重，core 类别（eess.AS / cs.SD / eess.SP）优先于 supplement 类别保留。

### 3.4 HuggingFace Papers 抓取

通过 `fetch-huggingface-papers.js` 双源抓取：

1. **`/api/daily_papers`**：精选每日论文，含 `ai_summary`、`githubRepo`、`upvotes`、`ai_keywords`、`projectPage`、`githubStars`、`discussionId` 等丰富字段。分页获取（`limit=100`，最多 20 页），直到覆盖近 7 天。
2. **`/api/papers`**：最新论文补充，覆盖最近 1-2 天，用于补充 daily_papers 未收录的新论文。

过滤：
- 只保留近 7 天的论文（`published >= 今天-7天`）
- 排除历史已有 ID（papers.json 中已完成/已发布论文、博客已发布 ID）
- **不排除本轮刚抓取的 arXiv ID**：同批重叠论文会进入合并阶段，用 HF upvotes、AI 摘要、项目页等字段补齐 arXiv 元数据
- 按 `upvotes` 降序排列

技术实现：使用 `curl` 命令获取数据（避免 Node fetch 在代理环境下的兼容问题），返回数据标准化为与 arXiv 一致的字段结构。

### 3.5 合并去重与博客过滤

`mergeAndDeduplicate(arxivPapers, hfPapers)` 的规则：

- **arXiv 论文优先级更高**：先全部放入 `merged` Map，保留其 `categories`、`abstract` 等元数据
- **HF 论文补充**：若 HF 论文的 `arxivId` 已存在于 arXiv 论文中，合并全部 7 个 HF 特有字段；若不存在，作为独立论文加入
- **来源标记**：`sources: ['arxiv']`、`['huggingface']` 或 `['arxiv', 'huggingface']`
- **摘要统一**：HF 论文同时输出 `summary` 和 `abstract`（内容相同），确保下游无需区分字段名

合并后，过滤掉博客已发布论文（基于第 3.2 步加载的博客 ID 集合），确保已发布论文不会进入 LLM 筛选阶段。

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

### 3.6 LLM 筛选

使用 `项目根目录的 `.env` 文件` 中的 `PAPER_ANALYZER_*` 配置逐篇判断是否为语音/音乐/音频相关。

**API 协议自动路由**：`scripts/utils.js` 中的 `detectApiType()` 会根据端点和模型名自动切换 OpenAI / Anthropic 协议
- **MiMo/Kimi Token Plan / Coding Plan**（端点含 `token-plan` 或 `coding`，模型含 `mimo`/`kimi`）→ 自动切换为 **Anthropic 协议**，伪装成 Claude Code 调用
  - **MiMo**: `https://token-plan-cn.xiaomimimo.com/v1` → `/anthropic/v1/messages`
  - **Kimi**: `https://api.kimi.com/coding/v1` → `https://api.kimi.com/coding/v1/messages`（无需 `/anthropic` 中间路径）
  - Headers: `x-api-key` + `anthropic-version: 2023-06-01` + `User-Agent: claude-cli/<version> (external, cli)`（版本号动态获取自本地 `claude --version`，失败回退到 `2.1.108`）
  - system message 自动提取为请求体顶级字段
- **其他情况**（包括 MiMo 按量付费 `api.xiaomimimo.com` 、通用 OpenAI 端点）→ 使用标准 **OpenAI 协议**
  - URL: `/v1/chat/completions`
  - Headers: `Authorization: Bearer {key}`

筛选 prompt 从 `prompts/filter.md` 读取，运行时替换 `{title}`、`{abstract}`、`{categories}` 占位符。判定标准如下：
- 语音合成/识别/增强/分离/克隆/转换 → **是**
- 音频生成/理解/音乐/事件检测 → **是**
- 说话人相关任务 → **是**
- 语音/音乐/音频相关模型、表示学习、预训练 → **是**
- 多模态模型只要明确涉及语音/音乐/音频（输入、输出、训练目标、评测任务或核心能力之一）→ **是**
- 其他领域且没有实质性语音/音乐/音频方法或任务 → **否**
- 冲突处理：若同时看起来满足"多模态涉及语音/音乐/音频"和"其他领域"，优先判定为 **是**

运行参数：
- `batchSize = 5`（批内并行调用 LLM）
- `delayBetweenBatches = 2000`（批次间延迟 2 秒）
- `useKeywordPreFilter = false`（当前主流程不用关键词预筛选）
- 单篇超时 **60 秒**，重试 **5 次**（退避 `2^attempt * 1s`）
- 每次重试独立创建 `AbortController` 和 `setTimeout`，避免重试时复用已 abort 的 controller

筛选阶段会增量保存三类文件：
- `data/current/raw-candidates.json`：合并和博客去重后的候选输入，并包含 arXiv/HF 的 `sourceHealth`；单类别或 HF 抓取失败时会记录 `ok:false`、`error`、`durationMs`。如果合并后候选为空，只有 arXiv 核心来源全部失败或唯一尝试来源失败时才中止；单个补充来源失败但核心来源已成功返回空结果时不再误判为致命错误
- `data/current/filter-decisions.json`：逐篇 LLM 决策缓存，包含筛选模型、`prompts/filter.md` hash、`related`、`reason`、`rawResponse`、`parseSource`；中断重跑时只复用同模型同 prompt 的决策
- `data/current/filtered-papers.json`：阶段性/最终筛选输出；`status: "filter_complete"` 只表示逐篇筛选已完成但归档去重尚未完成，最终可跳过抓取/筛选的状态必须是 `status: "complete"`

若今天已经存在完整 `filtered-papers.json`，再次运行 `node scripts/full-fetch.js` 会跳过抓取与筛选，直接进入深度分析续跑；若筛选尚未完成，则复用 `filter-decisions.json` 中已有逐篇决策继续筛选。
`npm run validate:data` 会交叉校验 `filter-decisions.json` 与 `filtered-papers.json` 的决策数量、相关数量和最终论文数量。

### 3.7 深度分析

使用 `deep-analyzer.js` 对每篇筛选后的论文进行全文 + 图片的深度阅读理解。

深度分析 prompt 从 `prompts/deep-analysis.md` 读取，运行时替换 `{hasFullText}`、`{title}`、`{authors}`、`{categories}`、`{arxivId}`、`{textForAnalysis}` 占位符。

**分析内容（由 LLM 生成，中文输出）**：

| 章节 | 要求 |
|------|------|
| 评分 | 1-10 分，保留一位小数；机器摘要含 `rank_bucket`（前10%/前25%/前50%/后50%）、`innovation`（0-2）、`technical_rigor`（0-1.5）、`experimental_sufficiency`（0-1.5）、`clarity`（0-1）、`impact`（0-1.5）、`open_source`（0-1.5）、`reproducibility`（0-0.5）、`engineering_score`（0-1.5）、`confidence` 等字段。代码后处理：从 `## 评分理由` 提取八个分项重新计算总分（上限 10 分），覆盖 LLM 原始输出 |
| 标签 | 3-5 个，必须含至少 1 个【任务】和 1 个【方法/模型】标签；除最终标签串外，还要求输出"主任务标签""主方法标签""补充标签" |
| 作者与机构 | 第一作者、通讯作者、作者列表及所属机构；缺失信息必须写"未说明"，禁止猜测 |
| 毒舌点评 | 2-3 句话犀利点评亮点和槽点，像资深审稿人的 final comment |
| 核心摘要 | 5-8 句话，覆盖问题、方法、效果、局限性 |
| 方法概述和架构 | 输入输出流程、组件结构、连接方式、设计理由；不少于 600 中文字符 |
| 核心创新点 | 3-5 个，每个含定义、之前方法的不足、解决机制、实际效果 |
| 实验结果 | 必须优先给出 benchmark、指标和具体数字；拿不到数字时明确写"论文未给出具体数值"；表格必须完整输出 |
| 细节详述 | 训练数据、损失函数、训练策略、超参数、硬件、推理细节 |
| 评分理由 | 按 8 个维度分别给分（创新性/2、技术严谨性/1.5、实验充分性/1.5、清晰度/1、影响力/1.5、开源/1.5、可复现性/0.5、工程/实践价值/1.5），严禁使用 10 分制，代码自动从评分理由提取分项重新计算总分 |
| 局限与问题 | 分两部分：论文明确承认的局限 + 审稿人发现的潜在问题 |
| 开源详情 | 只允许基于论文文本或当前输入链接总结，缺失时写"未提及"，禁止编造仓库/热度信息 |

> **图片与表格放置规则**：图片和表格不再集中在一个单独 section 中，而是直接嵌入到对应位置——架构图贴在**方法概述和架构**部分，实验结果图/表贴在**实验结果**部分。严禁编造图片 URL；只有双模型 `image-supplement` 阶段提供的候选图片可被副模型选择并插入。

**技术特性**：
- **API 协议自动路由**：与筛选阶段共用同一套 `detectApiType()` 逻辑，根据 `PAPER_ANALYZER_ENDPOINT` 和 `PAPER_ANALYZER_MODEL` 自动切换 OpenAI / Anthropic 协议
- 获取 arXiv HTML 全文（最多 500K 字符），依次尝试 `v1`、`v2`、无后缀版本；使用 **cheerio** 结构化解析 HTML，移除 script/style/nav/header/footer 等噪音元素
- 提取图片 URL，过滤 logo/favicon；下载层会校验 Content-Type、Content-Length 和 PNG/JPEG/WebP 文件头，避免把 HTML 错误页或过大图片送入模型
- **图片分析**：先按 caption/文件名/顺序启发式预筛候选图片（默认最多 `imageCandidateMax=20` 张），再串行下载最多 `imageMaxCount=20` 张；默认单图原始大小上限 6MB、单图 base64 上限 8M 字符、所有图片 base64 总上限 20M 字符。双模型模式下只有成功下载并通过副模型筛选的图片会写入正文；若没有可用图片，自动退回纯文本分析
- 每篇结果会保存 `imageManifest`：包含总发现图片数、候选评分、下载成功列表、最终选图；该字段由 `analysis-engine.js` 保留到最终 `deep-analysis-result.json`，便于复盘图片筛选质量
- **并发度：3 篇并行**（可通过 `PD_ANALYSIS_CONCURRENCY` 环境变量调整）
- 每篇最多重试 **2 次**（外层 `analysis-engine.js`），每次外层重试内部 API 调用还有 **3 次** 重试（`deep-analyzer.js` 内层，指数退避：第一次 10 秒，之后翻倍，`2^attempt * 5000ms`），外层重试间隔 3 秒（可通过 `PD_ANALYSIS_MAX_RETRIES` 调整外层）
- API 整体超时 **20 分钟**（AbortController）
- `max_tokens=64000`（config.js 中 `apiMaxTokens`），`temperature=0.7`
- 支持代理自动检测（环境变量 → macOS `scutil --proxy`）
- 支持纯 Node 内置模块的 HTTP CONNECT 代理（无需外部依赖）
- 所有分析配置集中管理于 `scripts/config.js`，支持环境变量覆写（`PD_ANALYSIS_CONCURRENCY`、`PD_ANALYSIS_MAX_RETRIES`、`PD_FILTER_BATCH_SIZE`、`PD_ARXIV_MAX_RESULTS`）

**深度分析不是单次调用，而是多轮递进式处理**：

| 轮次 | 名称 | Prompt | 作用 |
|------|------|--------|------|
| Round 1 | 主深度分析 | `prompts/deep-analysis.md` | 主模型对**全文纯文本**分析，生成所有章节 |
| Round 2 | 开源扫描 | `prompts/opensource-scan.md` | 从论文文本提取 GitHub/HF/ModelScope 等链接，补充开源详情 |
| Round 2.5 | Demo 页链接发现 | 代码抓取 | 若无开源链接，访问分析中出现的 demo 页（最多 3 个），从中回捞代码/模型/数据集链接 |
| Round 3 | 审校重写 | `prompts/gap-fill.md` | 对比原始论文与前几轮输出，修正缺失、错误、过度推断 |
| Round 4 | 表格修复 | 代码检测 + LLM 补充 | 检测实验结果章节缺失的 Markdown 表格，触发补充 |
| Round 5 | 方法章节修复 | 代码检测 + LLM 补充 | 检测方法概述是否过于简略（<600 字/<3 段），触发扩展至 600+ 字 |
| Round 6 | 图像筛选与补充（仅双模型模式） | `prompts/image-supplement.md` | 副模型接收候选图片 + 最终文本，筛选高价值图、丢弃低信息图，并把图片插入对应段落 |

> **单模型 vs 双模型**：设置 `PAPER_ANALYZER_SECONDARY_MODEL`（及可选的 `SECONDARY_ENDPOINT`/`SECONDARY_API_KEY`，未设置则复用主模型）即启用双模型模式——主模型先做纯文本分析，后续纯文本修复完成后，副模型负责从候选图片中筛选高价值图（流程图、模型图、语谱图、对比图、结果图等）、丢弃低信息图，并把图片插入到相应段落。未设置副模型时退回单模型：图片 URL 只保存在 `allImageUrls` 候选元数据中，不会自动嵌入博客正文。

### 3.8 增量保存与收尾

- **每批分析完成后立即增量保存**到 `data/current/deep-analysis-result.json`，避免中断丢失全部结果；增量合并时**自动保护已有成功分析**（失败结果不会覆盖已有 `analysis`）
- 增量保存和最终保存都会通过 `scripts/digest-status.js` 同步 `data/current/papers.json` 的 `digestStatus.status`，成功为 `analyzed`，失败为 `analysis_failed`
- 全部论文分析完毕后，再次读取已有结果，按 `arxivId`/`paper_id` 去重合并，保留历史数据
- 自动备份旧文件到 `data/archive/deep-analysis-result-<时间戳>.bak.json`，并清理旧备份（保留最近 10 个）
- **`papers.json` 自动备份**：每天运行前自动备份 `data/current/papers.json` 到 `data/archive/papers-<日期>.json`，保留最近 7 天
- 更新 `data/current/papers.json` 去重库
