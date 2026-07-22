# 主流程详解

## 主流程详解

核心数据流程入口：`./run-full-fetch.sh`（或 `node scripts/full-fetch.js` / `npm run fetch`）。深度分析只负责产出稳定评分；随后先发布全部博客页面，远端 OID 验证成功后才进入 TOP 10 论文长图和批次汇总图阶段。

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

技术实现：使用 `curl` 命令获取数据（避免 Node fetch 在代理环境下的兼容问题），返回数据标准化为与 arXiv 一致的字段结构。HuggingFace 抓取必须经项目 `.env` 的代理，缺失代理配置会立即失败而非生成空批次。

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
- **MiMo/Kimi Token Plan / Coding Plan**（MiMo 由 `token-plan` + MiMo 域名/模型识别；Kimi 由 `coding` + `kimi.com` 域名或 Kimi 模型识别）→ 自动切换为 **Anthropic 协议**，兼容 `k3`，并伪装成 Claude Code 调用
  - **MiMo**: `https://token-plan-cn.xiaomimimo.com/v1` → `/anthropic/v1/messages`
  - **Kimi**: `https://api.kimi.com/coding` 或 `https://api.kimi.com/coding/v1` → `https://api.kimi.com/coding/v1/messages`（自动补齐 `/v1`，无需 `/anthropic` 中间路径；兼容 `k3` 等模型名）
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
- `data/current/raw-candidates.json`：合并和博客去重后的候选输入，并包含 arXiv/HF 的 `sourceHealth`、请求次数、成功次数和失败明细。抓取器区分真实成功空响应与全请求失败；所有尝试均失败时抛错并中止，禁止生成伪成功空批次
- `data/current/fetch-checkpoint.json`：按 arXiv 类别和 HuggingFace 来源原子保存完整响应、健康状态、固定类别顺序与不可变历史去重基线。中断后只补跑失败来源；HTTP 200 但结构签名或解析覆盖异常也按来源失败处理
- `data/current/filter-decisions.json`：逐篇 LLM 决策缓存，绑定实际 fenced prompt、模型端点/协议/温度/输出配置与解析契约；API 错误或无法判断记为 `retryable`。健康 raw 即使没有任何决定也可直接续跑，配置变化只重筛、不重抓
- `data/current/filtered-papers.json`：阶段性/最终筛选输出；包含 `filterModel` 和 `filterPromptHash`。`status: "filter_complete"` 只表示逐篇筛选已完成但归档去重尚未完成，最终可跳过抓取/筛选的状态必须是 `status: "complete"`，且模型/hash 必须匹配当前配置

若今天已经存在完整且模型/hash 匹配的 `filtered-papers.json`，再次运行 `node scripts/full-fetch.js` 会跳过抓取与筛选，直接进入深度分析续跑；若筛选尚未完成，但同日 `raw-candidates.json` 显示所有来源健康且模型/hash 匹配，则跳过抓取，只复用候选与明确决策、重试未决论文。来源失败时才禁止该续跑，必须恢复缺失来源。
`npm run validate:data` 会同时校验 fetch checkpoint 的来源结构/状态，以及 checkpoint、raw、decisions、filtered 的同批次指纹、候选统计和完整覆盖。

### 3.7 深度分析

使用 `deep-analyzer.js` 对每篇筛选后的论文进行全文 + 图片的深度阅读理解。

深度分析 prompt 从 `prompts/deep-analysis.md` 读取，运行时替换 `{hasFullText}`、`{title}`、`{authors}`、`{categories}`、`{arxivId}`、`{textForAnalysis}` 占位符。

**分析内容（由 LLM 生成，中文输出）**：

| 章节 | 要求 |
|------|------|
| 评分 | `type-aware-v1`：先输出 `document_type`（方法研究/系统技术报告/模型报告/数据集与基准/综述/理论研究/应用研究），再按对应证据标准评分；机器摘要另含 `rank_bucket`、八维分项和 `confidence`。八维合计满分 11，总分封顶 10；只有八项完整、唯一、分母和范围合法时才从 `## 评分理由` 重算总分，否则契约失败。类型不固定加分，同一缺陷只能在一个主要维度扣分 |
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
- 获取 arXiv HTML 全文（最多 500K 字符），依次尝试 `v1`、`v2`、无后缀版本；所有 HTML/PDF/图片请求均通过项目 `.env` 的 HTTP CONNECT 代理 dispatcher，缺失配置即失败；使用 **cheerio** 结构化解析 HTML，移除 script/style/nav/header/footer 等噪音元素
- 提取图片 URL，过滤 logo/favicon；下载层会校验 Content-Type、Content-Length 和 PNG/JPEG/WebP 文件头，避免把 HTML 错误页或过大图片送入模型
- **图片分析**：HTML 正文和 figure caption 同次解析，预提供 URL 用同 URL 或唯一文件名补全图注。候选按 caption/文件名/顺序预筛后串行下载，成功内容写入 `data/current/image-cache/`；404、错误 MIME、超限和安全拒绝不重试，只有限流、服务端错误和网络异常重试。副模型按价值排序输出最多 4 张计划，并从代码提供的段落目录选择稳定 `paragraph_id`；旧自由文本 anchor 只兼容历史响应。非法 ID、定位失败和超限图片不会回退到章节末尾
- 每篇结果会保存 `imageManifest`：包含候选评分、逐 URL 下载结果、缓存命中、副模型/温度、prompt/响应哈希、插入与拒绝诊断及最终选图。严格空计划为 `no_high_value_images`；全部永久不可下载为 `no_downloadable_images`；有计划但零插入为 `invalid_output` 并只重试插图阶段
- `analysisManifest` 记录图片下载、主分析、开源扫描、Demo 扫描、审校、表格/方法/结构修复、评分审计和插图阶段；失败时保留 `analysisCheckpoint` 与 `analysisRecoveryImageManifest`。再次运行从首个未完成阶段继续，只有所有必需阶段进入完成/无需/跳过等终态才视为成功
- **并发度：3 篇并行**（可通过项目 `.env` 中的 `PD_ANALYSIS_CONCURRENCY` 调整）
- 每篇最多重试 **2 次**（外层 `analysis-engine.js`），每次外层重试内部 API 调用还有 **3 次** 重试（`deep-analyzer.js` 内层，指数退避：第一次 10 秒，之后翻倍，`2^attempt * 5000ms`），外层重试间隔 3 秒（可通过 `PD_ANALYSIS_MAX_RETRIES` 调整外层）
- API 整体超时为 **20 分钟活跃时间**；每秒心跳识别超过 30 秒的系统睡眠/事件循环挂起并排除该墙钟跳变，唤醒后的请求超时仍按剩余预算重试
- 主分析 `max_tokens=64000`（config.js 中 `apiMaxTokens`）；审校/表格/方法/结构局部修复默认 `max_tokens=16000`（`repairMaxTokens`，可由 `PD_ANALYSIS_REPAIR_MAX_TOKENS` 覆写）；`temperature=0.7`
- 代理只从项目根 `.env` 中显式配置的大小写代理变量读取；不继承 shell/IDE 代理，也不读取 macOS `scutil`。`HTTPS_PROXY` / `HTTP_PROXY` 是 arXiv 抓取必填的 HTTP CONNECT 地址，HuggingFace `curl` 可额外使用 SOCKS `ALL_PROXY`
- LLM 请求与抓取请求完全隔离：全部 LLM 调用固定 `agent: false` 直连，绝不复用抓取 dispatcher；使用本机代理的网络命令必须在沙箱外运行
- 抓取阶段只要任一 arXiv 类别或 HuggingFace 来源失败，即写入 `source_partial_failed` 并终止在筛选阶段；此状态不能复用为 `filter_complete`，也不能进入深度分析或更新持久化去重库。
- 所有分析配置集中管理于 `scripts/config.js`，支持项目 `.env` 覆写（并发、重试、arXiv/PDF 超时与大小、评分审计温度、插图计划温度及图片预算）

**深度分析不是单次调用，而是多轮递进式处理**：

| 轮次 | 名称 | Prompt | 作用 |
|------|------|--------|------|
| Round 1 | 主深度分析 | `prompts/deep-analysis.md` | 主模型对**全文纯文本**分析，生成所有章节 |
| Round 2 | 开源扫描 | `prompts/opensource-scan.md` | 从论文文本提取 GitHub/HF/ModelScope 等链接，补充开源详情 |
| Round 2.5 | Demo 页链接发现 | 代码抓取 | 若无开源链接，访问分析中出现的 demo 页（最多 3 个），每页最多安全跟随 3 跳且逐跳重验公网地址，从中回捞代码/模型/数据集链接 |
| Round 3 | 审校重写 | `prompts/gap-fill.md` | 对比原始论文与前几轮输出，修正缺失、错误、过度推断 |
| Round 4 | 表格修复 | 代码检测 + LLM 补充 | 检测实验结果章节缺失的 Markdown 表格，触发补充 |
| Round 5 | 方法章节修复 | 代码检测 + LLM 补充 | 检测方法概述是否过于简略（<600 字/<3 段），触发扩展至 600+ 字 |
| Round 6 | 最终结构修复（按需） | `prompts/structure-repair.md` | 共享契约发现 13 个必要章节有缺失时，主模型只补齐当前报告结构；完整时不调用 |
| Round 7 | 类型感知评分审计 | `prompts/scoring-audit.md` | 主模型只输出 JSON；代码把校验错误反馈给下一次局部审计，并按资源状态确定性归一化无产物论文的开源分 |
| Round 8 | 图像筛选与插图计划（仅双模型模式） | `prompts/image-supplement.md` | 副模型只输出 JSON 插图计划；合并后再次校验完整契约，不合格时只丢弃插图计划并保留主模型正文 |

评分审计全部通过后，先依次运行 `generate-blog.py`、`review-blog.py` 和 `push-blog.py`，发布汇总页及全部论文页。`push-blog.py` 只有在远端 `main` OID 与 `publicationCommit` 完全一致后才写入远端验证字段，并自动调用 `visual-summary-integration.js`。规划器按最终评分降序、同分规范化 arXiv ID 升序选取 TOP 10；Codex 读取 `prompts/visual-summary.md`，为每篇生成一张顶部英文标题、正文中文的纵向长图，并用 task token 登记。

同一发布后阶段还会按博客 generation manifest 保存的 category 建立一张批次汇总图任务，内容为标题、热门方向和 TOP 10 排名。两类 manifest 分别保存发布提交、数据 SHA、prompt SHA、task token 与资产 SHA，中断后只补缺失、失败、损坏或失效项。论文长图任务还会从深度分析的 `selectedImageUrls` / `imageManifest` 中选择最多两张已下载且 URL、MIME、字节数和 SHA 全部匹配的关键原图，优先方法总览、架构和流程图，再考虑关键实验图；参考图指纹变化只失效对应论文。内置生图必须把参考图作为结构事实来源重新绘制，不得粘贴不可读截图或补造原图中没有的数据。同批次全部图片扁平归档到 `data/archive/<日期>/visual-summaries/`：封面为 `00-digest-cover-<日期>.png`，论文长图按 manifest 最终排名命名为 `<两位排名>-<paper-id>-<title-slug>.png`，并发完成顺序不参与编号。旧版 current 与旧归档目录结构会在 plan 时经 PNG/SHA 校验后迁移。图片不进入已经发布的博客清单，也不阻断博客流程；项目脚本不得调用图像 API，生成图不得冒充论文原始 Figure 或虚构事实，汇总图不得显示 arXiv ID。

调用内置生图前必须运行 `npm run visual:prepare -- --date <日期>`。该命令不会调用图像 API，也不会改变任务 token；它重新校验 `.bin` 原始缓存的受控路径、SHA、长度、MIME 与文件头，随后把参考图原子物化为 `data/current/visual-reference-inputs/<日期>/<排名-论文>/` 中带正确扩展名的文件。生图时使用命令输出的 `referencedImagePaths`，不要把 `.bin` 直接传给图片服务。可用 `--paper <ID>` 只准备单篇，重复运行会校验并修复被改写的物化文件。

> **单模型 vs 双模型**：主模型始终负责正文和最终评分审计。评分审计默认使用独立低温 0.1。设置 `PAPER_ANALYZER_SECONDARY_MODEL` 后，副模型只从候选图片中筛选高价值图、丢弃低信息图并输出章节、稳定段落 ID、图前和图后说明；代码不会接受副模型替换主模型原文。未设置副模型时图片 URL 只保存在候选元数据中。

评分审计的“单一问题单一维度”规则是硬校验。跨维度理由会触发带精确错误反馈的局部重试，而不会立即重跑前面的全文分析。开源状态能由机器摘要与 `## 开源详情` 确定时，代码使用固定锚点：肯定语境明确承诺未来开放 0.5、带 URL 或肯定结构化状态的 Demo 0.2、否定/未提及且无承诺 0；理论研究根据公开证明、推导和附录判断核心产物，不机械要求代码/模型/数据链接。

全文获取会记录 `analysisSource`、字符数、截断状态、来源 SHA-256 和告警。HTML/PDF 均不可用时使用摘要并标记 `degraded_abstract`；该结果默认不能发布，只有人工设置 `allowAbstractAnalysisPublish: true` 后才允许生成带降级提示的博客。来源、评分模型、低温、评分 prompt 或证据指纹变化会精确失效对应 checkpoint，避免混用旧证据。

### 3.8 增量保存与收尾

- **每批分析完成后立即增量保存**到 `data/current/deep-analysis-result.json`；分析结果和 `papers.json` 在跨进程锁内重新读取合并并校验 `generation`，避免多个入口并发丢更新。失败结果不会覆盖已有成功 `analysis`，当前 JSON 损坏时会阻断而不是回退旧文件覆盖
- `full-fetch.js` 用单实例运行锁覆盖归档、清理、筛选和最终合并；每篇分析在共享论文锁内重新读取最新规范记录后保存。批次回调与收尾只更新顶层统计，禁止用累计旧快照二次覆盖论文正文；失败 checkpoint 仍逐篇保留
- 增量保存和最终保存都会通过 `scripts/digest-status.js` 同步 `data/current/papers.json` 的 `digestStatus.status`，成功为 `analyzed`，失败为 `analysis_failed`
- 全部论文分析完毕后，再次读取已有结果，按 `arxivId`/`paper_id` 去重合并，保留历史数据
- 自动备份旧文件到 `data/archive/deep-analysis-result-<时间戳>.bak.json`，并清理旧备份（保留最近 10 个）
- **`papers.json` 自动备份**：每天运行前自动备份 `data/current/papers.json` 到 `data/archive/papers-<日期>.json`，保留最近 7 天
- 更新 `data/current/papers.json` 去重库
