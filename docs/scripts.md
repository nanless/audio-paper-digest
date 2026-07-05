# 脚本分工

## 脚本分工（全部脚本详解）

### 4.1 主链路脚本

#### `scripts/full-fetch.js`

完整流程入口。执行第 3 节的所有步骤：自动归档 → 加载去重库（含博客已发布 ID）→ arXiv 抓取 → HF 抓取 → 合并去重 → 过滤博客已发布论文 → LLM 筛选 → 更新去重库 → 深度分析 → 增量保存。

所有配置从 `scripts/config.js` 读取，支持环境变量覆写：
- `ANALYSIS_CONFIG.concurrency = 3`（`PD_ANALYSIS_CONCURRENCY`）
- `ANALYSIS_CONFIG.maxRetries = 2`（`PD_ANALYSIS_MAX_RETRIES`）
- `ANALYSIS_CONFIG.retryDelayMs = 3000`
- `FILTER_CONFIG.delayBetweenBatchesMs = 2000`

#### `scripts/deep-analysis-only.js`

仅运行深度分析（续跑模式）。
- 读取 `data/current/deep-analysis-result.json`（兼容旧路径 `data/deep-analysis-result.json`，自动识别旧格式纯数组并转换）；若分析结果尚不存在但 `data/current/filtered-papers.json` 已存在，则从筛选结果初始化分析结果文件后续跑
- 跳过已有 `analysis` 字段的论文
- 对未分析论文逐篇调用 `deep-analyzer.js`
- **仅成功结果写入保存**，失败结果不覆盖已有数据，断点续传安全

#### `scripts/reanalyze.js`

全量重分析。
- 默认数据源：`data/current/deep-analysis-result.json`（支持命令行传自定义文件路径，兼容旧格式纯数组）
- 对文件中**全部**论文重新调用 `deep-analyzer.js`
- 默认并发度与 `ANALYSIS_CONFIG.concurrency` 一致（默认 3），支持通过 `--concurrency N` 或 `PD_REANALYZE_CONCURRENCY` 环境变量调整
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
- 导出 `fetchCategoryPapers`、`fetchCategoryFromRecentPage`、`fetchCategoryFromSearchPage`、`fetchAbstracts`、`parseRecentPageHTML`、`deduplicatePapers`、`filterPapersWithLLM`、`isSpeechAudioRelated`、`loadPapers`、`savePapers`
- **抓取策略：recent → 搜索页 → API 三级**
  - `fetchCategoryFromRecentPage()`：从 arXiv recent 页面抓取（限流宽松），支持翻页 2×50=100 篇
  - `fetchCategoryFromSearchPage()`：从 arXiv 搜索页面抓取，支持分页 + 5 次重试
  - `fetchCategoryPapers()`：自动三级降级，每步获取足够即跳过后续
  - `fetchAbstracts()`：从 arXiv abs 页面批量抓取摘要（并发 5）
- 筛选阶段统一使用 `PAPER_ANALYZER_*` 环境变量，支持 HTTP CONNECT 代理
- 关键词预筛选函数 `filterPapersByKeywords` 保留但当前主流程未启用
- XML 解析为 regex 实现（arXiv API 格式稳定）

#### `scripts/config.js`

统一配置中心。所有硬编码参数集中管理，按功能分组：

**分析配置（`ANALYSIS_CONFIG`）**

| 配置项 | 默认值 | 环境变量覆写 | 说明 |
|--------|--------|-------------|------|
| 并发度 | 3 | `PD_ANALYSIS_CONCURRENCY` | 深度分析并行篇数 |
| 外层重试次数 | 2 | `PD_ANALYSIS_MAX_RETRIES` | analysis-engine 层面每篇重试次数 |
| 外层重试延迟 | 3000ms | — | 外层重试间隔 |
| API 整体超时 | 20 分钟 | — | AbortController 超时 |
| API 内层重试次数 | 3 | — | deep-analyzer 内层每次调用重试次数 |
| API 内层退避基数 | 5000ms | — | 指数退避：第一次 5s，之后翻倍 |
| max_tokens | 64000 | — | LLM 输出长度上限 |
| temperature | 0.7 | — | LLM 采样温度 |
| 图片下载超时 | 15s | — | 单张图片下载超时 |
| 单张 base64 上限 | 20M 字符 | — | 单张图片转 base64 上限 |
| 全文上限 | 500K 字符 | — | arXiv HTML 正文截取上限 |
| arXiv HTML 获取超时 | 30s | — | 获取 arXiv HTML 超时 |

**筛选配置（`FILTER_CONFIG`）**

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 超时 | 60s | 单篇筛选 API 调用超时 |
| 重试次数 | 3 | 单篇筛选重试次数 |
| 批次大小 | 5 | `PD_FILTER_BATCH_SIZE` 可覆写 |
| 批次间延迟 | 2000ms | 每批筛选后的等待时间 |
| temperature | 0.3 | 筛选阶段采样温度 |

**arXiv 配置（`ARXIV_CONFIG`）**

| 配置项 | 默认值 | 环境变量覆写 | 说明 |
|--------|--------|-------------|------|
| 每类抓取数 | 100 | `PD_ARXIV_MAX_RESULTS` | 每分类最大返回数 |
| 最大重试次数 | 20 | — | 单分类抓取重试上限 |
| 重退避基数 | 3000ms | — | 指数退避：3s/6s/12s... |
| 限流退避基数 | 15000ms | — | 429 限流额外等待：15s/30s/60s... |
| 最大等待时间 | 300000ms | — | 单分类最长等待 5 分钟 |
| 分类间延迟 | 25000ms | — | 不同分类请求间隔 |
| 首次请求延迟 | 5000ms | — | 首个分类额外等待 |
| 连续已知阈值 | 20 | — | 连续 20 篇已有 ID 提前停止 |

**HuggingFace 配置（`HUGGINGFACE_CONFIG`）**

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 默认天数 | 7 | 只保留近 7 天论文 |
| 最大页数 | 20 | daily_papers 分页上限 |
| 每页数量 | 100 | 分页每页条数 |
| 页间延迟 | 300ms | 分页请求间隔 |

**发布配置（`PUBLISH_CONFIG`）**

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 博客仓库路径 | `~/code/github_repos/audio-paper-digest-blog` | 可通过 `PAPER_DIGEST_BLOG_REPO` 覆写 |
| 内容目录 | `content/posts` | Hugo 内容目录 |
| basePath | `/audio-paper-digest-blog` | 站点子路径 |
| 微信草稿字符上限 | 48000 | 单篇草稿 HTML 字符上限 |

**归档配置（`ARCHIVE_CONFIG`）**

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 最大备份数 | 10 | `deep-analysis-result` bak 文件保留数 |
| 最大日志数 | 50 | 日志文件保留数 |

被所有核心脚本引用。

#### `scripts/analysis-engine.js`

统一分析引擎。封装以下功能，消除 `full-fetch.js` / `deep-analysis-only.js` / `batch-analyze.js` / `reanalyze.js` / `analyze-single-paper.js` 的重复逻辑：

- `analyzePaperWithRetry(paper, options)`：单篇分析（带重试 + 自动解析）
- `analyzeBatch(papers, options)`：批量分析（支持并发控制 + 增量保存回调）
- `mergeAndSaveResults(newResults, filePath, extraData)`：按 ID 去重合并并保存，**自带失败结果保护**（已有成功 analysis 的论文不会被无 analysis 的失败结果覆盖）

#### `scripts/validate-scores.js`

评分验证与修复工具。
- `validateAndFix(papers)`：检查子项越界、总分一致性、开源矛盾，自动修复
- `DIM_MAX`：导出各维度上限表
- 直接运行：`node scripts/validate-scores.js [data-file]`

#### `scripts/fetch-huggingface-papers.js`

HuggingFace Papers 抓取模块。
- `fetchHuggingFacePapers(existingIds, { days, minUpvotes })`：双源抓取（daily_papers + papers API）
- `mergeAndDeduplicate(arxivPapers, hfPapers)`：合并去重，补充全部 7 个 HF 字段
- `convertDailyPaper()` / `convertPaper()`：数据标准化，输出字段与 arXiv 一致（含 `abstract` + `summary`）
- 使用 `curl` 命令获取数据
- 直接运行可测试：`node scripts/fetch-huggingface-papers.js`

#### `scripts/deep-analyzer.js`

多模态深度分析器。分析流程为 **5 轮递进式处理**，不是单次调用：

**Round 1 — 主深度分析**
- `analyzePaperDeep(paper)`：获取 arXiv HTML 全文（最多 500K 字符）+ 串行下载全部图片，降低代理/远端限流下的失败率
- 加载 `prompts/deep-analysis.md`，替换占位符后调用 LLM
- 输出包含：评分、机器摘要、标签、作者与机构、毒舌点评、核心摘要、方法概述和架构、核心创新点、实验结果、细节详述、评分理由、局限与问题、开源详情
- `parseAnalysis(analysis)`：将分析文本解析为结构化对象。`score` 不是直接取 `## 评分` 下的 LLM 原始总分，而是从 `## 评分理由` 中提取八个分项重新计算，四舍五入到 0.1，始终覆盖 LLM 原始总分

**Round 2 — 开源扫描（`scanOpensource`）**
- 加载 `prompts/opensource-scan.md`
- 从论文文本中提取 GitHub / HuggingFace / ModelScope 等开源链接
- 补充到 `## 开源详情` 章节

**Round 3 — 审校重写（`reviseAnalysis`）**
- 加载 `prompts/gap-fill.md`
- 对比原始论文与 Round 1 输出，检查缺失、错误、过度推断
- 生成修订版分析文本，覆盖原有内容

**Round 4 — 表格修复（`checkAndFixTables`）**
- 检测 `## 实验结果` 中缺失的 Markdown 表格
- 若发现表格被省略或截断，触发 LLM 补充完整表格

**Round 5 — 方法章节修复（`checkAndFixMethodSection`）**
- 检测 `## 方法概述和架构` 是否过于简略（少于 300 中文字符、表述模糊、不足 3 段）
- 若满足条件，触发 LLM 扩展至 600+ 字符的详细描述

**API 调用**：
- `callModel(messages, maxTokens)`：带重试的 API 调用封装（内层最多 3 次重试，指数退避：第一次 10 秒，之后翻倍）
- `_callModelOnce()`：单次 API 调用，每次重试独立创建 AbortController 和 20 分钟超时
- LLM API 请求强制设置 `agent: false`，禁用连接复用以绕过代理污染（避免 MiMo 403）

**其他特性**：
- 支持代理自动检测（环境变量 → macOS `scutil --proxy`）
- 支持纯 Node 内置模块的 HTTP CONNECT 代理
- 直接运行可测试：`node scripts/deep-analyzer.js <arxivId>`

#### `scripts/utils.js`

Node.js 公共工具模块。被几乎所有脚本引用：

**文件与路径**：
- `writeFileAtomic(filePath, data)`：原子写入（先写临时文件再重命名）
- `readJsonSafe(filePath)`：安全读取 JSON，文件不存在时返回 `null`
- `ensureDir(dirPath)`：确保目录存在

**时间处理**：
- `getBeijingISOString()` / `getBeijingDateString()` / `getBeijingCompactTimestamp()` / `getBeijingLocaleString()`：北京时间各种格式
- `normalizeToBeijingISOString(isoString)`：将任意 ISO 字符串转为北京时间
- `extractDatePrefix(str)` / `getRecordDate(paper)`：从字符串或论文对象提取日期前缀

**解析与文本**：
- `stripMd(t)`：去除 Markdown 格式标记
- `parseMachineSummary(analysis)`：解析 `## 机器摘要` 块
- `parseAnalysis(analysis)`：解析完整分析文本为结构化对象（评分、标签、各章节等）

**API 协议自动路由**（核心基础设施）：
- `detectApiType(endpoint, model)`：根据端点和模型自动判断 OpenAI / Anthropic 协议
- `getAnthropicEndpoint(endpoint)`：将 OpenAI 风格端点转为 Anthropic 风格路径
- `buildApiUrl(apiType, endpoint)`：构建完整请求 URL
- `buildRequestBody(apiType, model, messages, maxTokens)`：构建请求体
- `buildHeaders(apiType, key)`：构建请求头
- `getClaudeCodeVersion()`：获取本地 Claude Code CLI 版本号
- `parseResponseText(apiType, data)`：统一解析响应文本

**代理**：
- `detectProxyUrl()`：自动检测代理（环境变量 → macOS `scutil --proxy`）
- `createProxyAgent(proxyUrl)`：创建 HTTP CONNECT 代理 agent

**其他**：
- `normalizedId(paper)`：生成统一论文 ID
- `backupPapersJson()`：自动备份 `papers.json`
- `loadPublishedIdsFromBlog(blogRepo)`：扫描 Hugo 博客仓库中已发布论文的 arXiv ID 集合（从 `content/posts/*.md` 中提取 `arxiv.org/abs/XXXX.XXXXX` 格式链接）
- `loadPrompt(filePath, replacements)`：加载 prompt 文件并替换占位符

#### `scripts/utils.py`

Python 公共工具模块。被 `publish-to-blog.py`、`publish-wechat-full.py`、`publish-xiaohongshu.py`、`publish-to-feishu.py` 引用：

**时间**：
- `now_bj_iso()` / `now_bj_date()`：北京时间 ISO 字符串和日期字符串

**文本**：
- `strip_md(t)`：去除 Markdown 格式标记（与 JS 版功能一致）

**解析**：
- `parse_machine_summary(analysis)`：解析 `## 机器摘要` 块（支持 `- key: value` 格式）
- `parse_analysis(analysis)`：解析完整分析文本为结构化对象（与 JS 版功能一致）

**标签体系**（核心约束）：
- `ALLOWED_TAGS`：标准标签白名单（约 110 个中文标签），必须与 `prompts/deep-analysis.md` 中的标签表保持一致
- `_normalize_tag(raw)`：标准化标签（加 `#` 前缀、清理分隔符）
- `_is_bad_task_tag(tag)`：判断标签质量是否太差（snake_case、arXiv 类别、过长英文、不在白名单等）
- `_fix_tag(tag)`：将已知错误标签映射到正确标签（覆盖 50+ 个 LLM 常犯的自创/英文标签）

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
4. 访问：`https://nanless.github.io/audio-paper-digest-blog/posts/YYYY-MM-DD/`

**参数**：
- `--date YYYY-MM-DD`（强烈建议显式指定，避免跨天时日期错误）
- `--skip-push` 只生成文件不推送
- 自定义数据文件路径作为最后一个参数

**日期过滤**：
- 脚本默认按 `fetchedAt` 字段过滤，只发布匹配 `--date` 指定日期（默认今天）的论文
- `deep-analysis-result.json` 会累积历史数据，日期过滤确保只发布当日抓取的新论文
- 若需发布全部论文（不过滤），可传入自定义数据文件或临时修改脚本

**Review 环节**：
生成 `.md` 后会自动执行三层 review（代码正则检查 → LLM 文本审查 → 多模态图片审查），论文独立页面使用 `ThreadPoolExecutor(max_workers=3)` 并发审查，自动修复常见问题后写入文件。

代码层自动修复覆盖以下问题：
1. 未转义的 HTML-like 标签（`<S>`、`<E>`、`<task>` 等）→ 用反引号包裹
2. 未转换的 LaTeX `$...$` 公式 → 转为 `\(...\)` 格式
3. 非标准图片引用格式 → 转为标准 Markdown 图片语法
4. 过长的 base64 data URI → 自动截断
5. YAML frontmatter 双逗号 → 自动修复
6. Markdown 表格子标题行（前三列全空）→ 删除该行
7. 未闭合的 LaTeX `$ \mathcal{L}_D \(` → 转为 `\(\mathcal{L}_D\)`
8. 错乱的 LaTeX 括号（`\)\mathcal{L}_X\(`）→ 统一修正为 `\(\mathcal{L}_X\)`
9. 双反斜杠 LaTeX（`\(\\mathcal{L}_X\)`）→ 修正为 `\(\mathcal{L}_X\)`

LLM 层修复：LLM 审查返回 `auto_fixable: true` 的问题，按 `fix_instruction` 执行简单文本替换。

**重要限制**：`fetchedAt` 是抓取时间，不是论文在 arXiv 上的 `published` 日期。跨天运行时请显式指定 `--date`。

#### `scripts/publish-wechat-full.py`

生成微信公众号图文草稿。

- 默认数据源：`data/current/deep-analysis-result.json`（支持命令行传入自定义路径）
- 微信公众号 `APP_ID` / `APP_SECRET` 从环境变量读取
- **图片上传**：下载 arXiv 图片 → 上传到微信 CDN → 替换为微信 URL。缓存保存在 `/tmp/wechat-image-cache.json`
- **自动分 Part**：单篇草稿上限约 48000 字符（HTML），超过自动拆分为多个草稿
  - 只有 Part 1 包含"今日概览"
  - 每 Part 标题：`语音/音乐/音频论文速递 YYYY-MM-DD | part N | M篇论文`
- 生成预览 HTML：`data/current/wechat-preview-YYYY-MM-DD.html`

#### `scripts/publish_common.py`

Python 发布公共模块。统一封装数据加载、评分排序、标签提取、格式化工具，消除 `publish-to-blog.py` / `publish-wechat-full.py` / `publish-xiaohongshu.py` / `publish-to-feishu.py` 的重复逻辑。

主要函数：
- `load_papers(data_file)`：从 JSON 加载论文列表
- `score_and_sort(papers)`：解析分析结果，按评分降序排列；优先使用已有的 `parsed` 数据，避免重新解析覆盖手动修正
- `extract_top_tags(papers, limit)`：提取主任务标签并统计频次
- `extract_all_tags(papers, limit)`：提取所有标签（去重），用于博客标签云
- `extract_one_liner(pa)`：从分析结果中提取一句话亮点，优先用创新点或核心贡献句
- `score_emoji(score)` / `format_medal(index)`：评分 emoji 和奖牌格式化
- `build_paper_meta(pa, aurl)`：拼接评分/分档/标签元信息
- `parse_cli_args(argv, defaults)`：通用命令行参数解析，被各发布脚本复用

#### `scripts/publish-xiaohongshu.py`

生成小红书文案。

- 默认数据源：`data/current/deep-analysis-result.json`
- 支持 `--top N` 精选版（默认 TOP 5，常用 `--top 3`）和 `--all` 完整汇总版
- 支持 `--date YYYY-MM-DD` 指定日期
- 输出到 `data/current/xiaohongshu-YYYY-MM-DD-<suffix>.md`
- **每篇论文的一句话介绍调用 MiMo LLM API 生成**（anthropic 协议，`session.trust_env = False` 绕过代理，并发 3），LLM 失败时回退到本地 `extract_one_liner()`
- 自动清理 Markdown 格式和学术化前缀
- 附带 emoji 热度标识：🔥≥8 分、✅≥6 分、📝<6 分（与博客、微信统一）
- 少于 1000 字，不输出标签和 `---` 分隔线，开源信息标注清晰

#### `scripts/xiaohongshu-publisher.py`

小红书自动发布脚本（调用小红书 Web API，非官方接口）。

- `--login`：扫码登录，保存 cookie 到本地缓存文件
- `--publish`：发布当前日期 TOP 3 精选帖（默认）
- `--all`：发布全部论文（每帖一篇）
- `--date YYYY-MM-DD`：指定日期
- 登录后 cookie 持久化，下次无需重复扫码
- 对应 npm 脚本：`npm run xhs-login`、`npm run xhs-publish`、`npm run xhs-publish-all`

#### `scripts/publish-to-feishu.py`

生成飞书文档。

**凭据读取**：
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 从环境变量读取（与其他发布渠道一致，统一放在 `项目根目录的 `.env` 文件`）

**数据输入**：
- 统一读取 `data/current/deep-analysis-result.json`（与其他发布渠道一致）
- 支持 `--date YYYY-MM-DD` 指定日期

**实现特点**：
- Python 实现，复用 `publish_common.py` 的数据加载和评分排序；生成正文时优先使用已有 `parsed`，没有时才重新解析 `analysis`
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

#### `scripts/backup-data.sh`

数据备份壳脚本。

---
