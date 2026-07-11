# 脚本分工

## 脚本分工（全部脚本详解）

> **运行前置条件**：所有本项目脚本必须在沙箱外执行。直接启动的 Node/Python 脚本会由公共环境加载器检测 `CODEX_SANDBOX` 并在任何业务操作前拒绝执行；`run-full-fetch.sh` 和 `scripts/backup-data.sh` 也有同样的入口检查。单元测试导入模块不会触发该检查。

### 4.1 主链路脚本

#### `scripts/full-fetch.js`

完整流程入口。执行第 3 节的所有步骤：自动归档 → 加载去重库（含博客已发布 ID）→ arXiv 抓取 → HF 抓取 → 合并去重 → 过滤博客已发布论文 → LLM 筛选 → 更新去重库 → 深度分析 → 增量保存。

所有配置从 `scripts/config.js` 读取，支持项目根 `.env` 覆写：
- `ANALYSIS_CONFIG.concurrency = 3`（`PD_ANALYSIS_CONCURRENCY`）
- `ANALYSIS_CONFIG.maxRetries = 2`（`PD_ANALYSIS_MAX_RETRIES`）
- `ANALYSIS_CONFIG.retryDelayMs = 3000`
- `FILTER_CONFIG.delayBetweenBatchesMs = 2000`

#### `scripts/deep-analysis-only.js`

仅运行深度分析（续跑模式）。
- 读取 `data/current/deep-analysis-result.json`（兼容旧路径 `data/deep-analysis-result.json`，自动识别旧格式纯数组并转换）；若分析结果尚不存在但 `data/current/filtered-papers.json` 已存在，则从筛选结果初始化分析结果文件后续跑
- 跳过已有 `analysis` 字段的论文
- 对未分析论文逐篇调用 `deep-analyzer.js`
- 增量保存成功/失败结果，并同步回写 `data/current/papers.json` 的 `digestStatus.status` 为 `analyzed` / `analysis_failed`，断点续传安全

#### `scripts/reanalyze.js`

除成功/失败外，最终汇总会按 `analysisSource` 统计 HTML、PDF、预提供全文和摘要降级数量；摘要降级不会被视为等价的全文成功。

全量重分析。
- 默认数据源：`data/current/deep-analysis-result.json`（支持命令行传自定义文件路径，兼容旧格式纯数组）
- 对文件中**全部**论文重新调用 `deep-analyzer.js`
- 默认并发度与 `ANALYSIS_CONFIG.concurrency` 一致（默认 3），支持通过 `--concurrency N` 或项目 `.env` 中的 `PD_REANALYZE_CONCURRENCY` 调整
- **每 5 篇保存一次中间结果**（并发模式下自动调整保存间隔），**仅成功结果覆盖旧数据**；保存时按当前结果同步 `papers.json.digestStatus`
- 启动时检查 `PAPER_ANALYZER_API_KEY`、`PAPER_ANALYZER_MODEL`、`PAPER_ANALYZER_ENDPOINT` 是否已设置，缺失则直接退出

#### `scripts/reanalyze-selected.js`

指定 ID 重分析，固定使用默认并发 3，成功结果替换旧分析并同步 `digestStatus`。若目标论文此前尚未使用当前评分契约，成功后会把全量 `stats.reanalyzed` / `stats.reanalyzeFailed` 中对应的历史失败校正为成功；同时记录 `selectedReanalyzed`、`selectedReanalyzeFailed`、`selectedReanalyzeAt`，重复重跑当前契约论文不会重复累计恢复数。

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
- 对未分析论文逐篇分析，保存成功/失败结果并同步 `papers.json.digestStatus`，便于下次重试；存在未恢复失败时写入 `partial_failed` 并以非零状态退出
- 适合在 `full-fetch.js` 中断后补跑剩余论文

#### `scripts/analyze-single-paper.js`

单独分析一篇论文并合并到结果中。

**用法**：`node scripts/analyze-single-paper.js <arxiv_id> [--force]`

- 从 `data/current/papers.json` 读取元数据
- 调用 `deep-analyzer.js` 分析后追加到 `deep-analysis-result.json`
- 仅当已有结果通过完整分析契约时默认跳过；加 `--force` 可强制重分析并替换旧结果
- 兼容旧格式纯数组数据，自动转换为新对象格式保存
- 成功保存后同步 `papers.json.digestStatus`；分析失败时也会回写 `analysis_failed`，但不会修改 `deep-analysis-result.json`

#### `scripts/validate-data-files.js`

只读校验当前运行数据结构。
- 默认检查 `data/current/papers.json`、`data/current/raw-candidates.json`、`data/current/filtered-papers.json`、`data/current/deep-analysis-result.json`
- 额外检查 `data/current/filter-decisions.json`；校验 `digestStatus.status` / `latestAttemptStatus` 枚举、候选统计关系、筛选复用元数据、论文 ID、`sourceHealth`、`documentType`、`scoringRubricVersion`、八维分项范围、总分与分项封顶合计、深度分析统计、图片字段和筛选决策完整覆盖
- 不修改任何数据；发现问题时输出错误并以非零状态退出
- npm 入口：`npm run validate:data`

### 4.2 抓取与分析支撑脚本

#### `scripts/fetch-papers.js`

arXiv 抓取与 LLM 筛选模块。
- 导出 `fetchCategoryPapers`、`fetchCategoryFromRecentPage`、`fetchCategoryFromSearchPage`、`fetchAbstracts`、`parseRecentPageHTML`、`deduplicatePapers`、`filterPapersWithLLM`、`isSpeechAudioRelated`、`loadPapers`、`savePapers`
- **抓取策略：recent → 搜索页 → API 三级**
  - `fetchCategoryFromRecentPage()`：从 arXiv recent 页面抓取（限流宽松），支持翻页 2×50=100 篇
  - `fetchCategoryFromSearchPage()`：从 arXiv 搜索页面抓取，支持分页 + 5 次重试
  - `fetchCategoryPapers()`：自动三级降级，每步获取足够即跳过后续
  - `fetchAbstracts()`：从 arXiv abs 页面批量抓取摘要（并发 5）
- 筛选阶段统一使用 `PAPER_ANALYZER_*` 环境变量；LLM 请求强制 `agent: false` 直连，HTTP CONNECT 代理仅用于抓取侧请求
- 关键词预筛选函数 `filterPapersByKeywords` 保留但当前主流程未启用
- XML 解析为 regex 实现（arXiv API 格式稳定）

#### `scripts/config.js`

统一配置中心。所有硬编码参数集中管理，按功能分组：

**运行数据路径（`FILES`）**

`Config.FILES` 统一登记当前流程会读写的核心 JSON 文件：`papers` / `rawCandidates` / `filterDecisions` / `filteredPapers` / `deepAnalysisResult` / `analyzed`，以及仍需兼容的 legacy 路径。新增脚本不要手写 `data/current/*.json` 路径，优先复用这里的常量。

**分析配置（`ANALYSIS_CONFIG`）**

| 配置项 | 默认值 | 项目 `.env` 覆写 | 说明 |
|--------|--------|-------------|------|
| 并发度 | 3 | `PD_ANALYSIS_CONCURRENCY` | 深度分析并行篇数 |
| 外层重试次数 | 2 | `PD_ANALYSIS_MAX_RETRIES` | analysis-engine 层面每篇重试次数 |
| 外层重试延迟 | 3000ms | — | 外层重试间隔 |
| API 整体超时 | 20 分钟活跃时间 | — | 排除系统睡眠/长时间挂起的墙钟跳变 |
| API 内层重试次数 | 3 | — | deep-analyzer 内层每次调用重试次数 |
| API 内层退避基数 | 5000ms | — | 指数退避：第一次 5s，之后翻倍 |
| max_tokens | 64000 | — | LLM 输出长度上限 |
| temperature | 0.7 | — | LLM 采样温度 |
| 图片下载超时 | 60s | `PD_IMAGE_DOWNLOAD_TIMEOUT_MS` | 单张图片下载超时，失败后仍按既定次数重试 |
| 单张图片原始大小上限 | 6MB | `PD_IMAGE_MAX_BYTES` | 下载后按字节数校验 |
| 单张 base64 上限 | 8M 字符 | `PD_IMAGE_MAX_BASE64_CHARS` | 单张图片转 base64 上限 |
| 单篇图片 base64 总上限 | 20M 字符 | `PD_IMAGE_TOTAL_BASE64_CHARS` | 防止多图请求体过大 |
| 每篇实际插图上限 | 4 张 | `PD_IMAGE_INSERTION_MAX` | 按副模型价值顺序截断，且只接受精确 anchor |
| 全文上限 | 500K 字符 | — | arXiv HTML 正文截取上限 |
| arXiv HTML/图片发现超时 | 60s | `PD_ARXIV_FETCH_TIMEOUT_MS` | HTML 正文与图片列表请求超时 |
| arXiv PDF fallback 超时 | 180s | `PD_ARXIV_PDF_TIMEOUT_MS` | HTML 不可用时的单次 PDF 下载超时 |

**筛选配置（`FILTER_CONFIG`）**

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 超时 | 60s | 单篇筛选 API 调用超时 |
| 重试次数 | 5 | 单篇筛选重试次数（`FILTER_CONFIG.maxRetries`，退避 `2^attempt * 1s`） |
| 批次大小 | 5 | `PD_FILTER_BATCH_SIZE` 可覆写 |
| 批次间延迟 | 2000ms | 每批筛选后的等待时间 |
| temperature | 0.3 | 筛选阶段采样温度 |

**arXiv 配置（`ARXIV_CONFIG`）**

| 配置项 | 默认值 | 项目 `.env` 覆写 | 说明 |
|--------|--------|-------------|------|
| 每类抓取数 | 100 | `PD_ARXIV_MAX_RESULTS` | 每分类最大返回数 |
| 最大重试次数 | 30 | — | `fetchMaxRetries`，单分类抓取重试上限 |
| 重退避基数 | 5000ms | — | `fetchRetryBaseDelayMs` |
| 限流退避基数 | 30000ms | — | `fetchRateLimitBaseDelayMs`，429 限流额外等待 |
| 最大等待时间 | 600000ms | — | `fetchMaxWaitMs`，单分类最长等待 10 分钟 |
| 分类间延迟 | 60000ms | — | `categoryDelayMs`，不同分类请求间隔（full-fetch 另加抖动+限流惩罚） |
| 首次请求延迟 | 30000ms | — | `firstRequestDelayMs`，首个分类额外等待 |
| 连续已知阈值 | 20 | — | 连续 20 篇已有 ID 提前停止 |

> 注：`fetch-papers.js` 中各抓取路径（recent/search/API）的实际重试上限硬编码为 5 次，429 退避为 `60s * 2^(attempt-1)`（60s/120s/240s/480s），其他错误 `5s * attempt`；上表为 `config.js` 中 `ARXIV_CONFIG` 的登记值。

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
| 博客仓库路径 | `~/code/github_repos/audio-paper-digest-blog` | 可通过项目 `.env` 中的 `PAPER_DIGEST_BLOG_REPO` 覆写 |
| 内容目录 | `content/posts` | Hugo 内容目录 |
| basePath | `/audio-paper-digest-blog` | 站点子路径 |
| 微信草稿字符上限 | 48000 | 单篇草稿 HTML 字符上限 |

**归档配置（`ARCHIVE_CONFIG`）**

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 最大备份数 | 10 | `deep-analysis-result` bak 文件保留数 |
| 文件日志启用 | 默认开启 | 在项目 `.env` 中设置 `PD_DISABLE_FILE_LOGS=1` 或 `PAPER_DIGEST_DISABLE_FILE_LOGS=1` 强制关闭 |
| 日志数量/体积限制 | 无 | 不限制日志数量、总量或单文件大小，也不自动清理旧日志 |

被所有核心脚本引用。

#### `scripts/analysis-engine.js`

统一分析引擎。封装以下功能，消除 `full-fetch.js` / `deep-analysis-only.js` / `batch-analyze.js` / `reanalyze.js` / `analyze-single-paper.js` 的重复逻辑：

- `analyzePaperWithRetry(paper, options)`：单篇分析（带重试 + 自动解析）
- `analyzeBatch(papers, options)`：批量分析（支持并发控制 + 增量保存回调）；关键回调异常会向入口传播，不能被当作分析成功吞掉
- `mergeAndSaveResults(newResults, filePath, extraData)`：按 ID 去重合并并保存，**自带失败结果保护**；跨进程锁内重新读取并校验 `generation`，拒绝陈旧快照覆盖或损坏 current JSON
- 成功判定要求 `analysisManifest` 版本 1 的全部必需阶段进入终态；失败合并保留旧成功正文，同时叠加新的 checkpoint、恢复图片清单与最近尝试错误
- 文件锁 owner 带随机 token 并检查本机 PID；旧 owner 不能删除替代锁，存活进程持有的锁不会因时间过长被回收

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

多模态深度分析器。分析流程为 **最多 8 轮递进式处理**，不是单次调用：

**Round 1 — 主深度分析**
- `analyzePaperDeep(paper)`：获取 arXiv HTML 全文（最多 500K 字符）+ 预筛候选图片；双模型模式才串行下载候选图片并由副模型最终筛选高价值图片插入正文，单模型模式只保存候选图元数据；`allImageUrls` 保存候选图，`selectedImageUrls` / `imageUrls` 保存已选图
- 加载 `prompts/deep-analysis.md`，替换占位符后调用 LLM
- 输出包含：文档类型、评分、机器摘要、标签、作者与机构、毒舌点评、核心摘要、方法概述和架构、核心创新点、实验结果、细节详述、评分理由、局限与问题、开源详情
- `parseAnalysis(analysis)`：将分析文本解析为结构化对象，归一化 `document_type` 并为新结果写入 `type-aware-v1` 版本。只有八个分项完整、唯一、分母正确且分值合法时才重算 `score` 并封顶为 10；其余情况返回 `scoreValidation` 错误并阻断保存/发布

**Round 2 — 开源扫描（`scanOpensource`）**
- 加载 `prompts/opensource-scan.md`
- 从论文文本中提取 GitHub / HuggingFace / ModelScope 等开源链接
- 补充到 `## 开源详情` 章节

**Round 3 — 审校重写（`reviseAnalysis`）**
- 加载 `prompts/gap-fill.md`
- 对比原始论文与 Round 1 输出，检查缺失、错误、过度推断
- 生成修订版分析文本，覆盖原有内容

**Round 4 — 表格修复（`checkAndFixTables`）**
- 加载 `prompts/table-fill.md`
- 检测 `## 实验结果` 中缺失的 Markdown 表格
- 若发现表格被省略或截断，触发 LLM 补充完整表格

**Round 5 — 方法章节修复（`checkAndFixMethodSection`）**
- 加载 `prompts/method-fill.md`
- 检测 `## 方法概述和架构` 是否过于简略（少于 600 中文字符、表述模糊、不足 3 段）
- 若满足条件，触发 LLM 扩展至 600+ 字符的详细描述

**Round 6 — 最终结构修复（`repairMissingAnalysisSections`，按需）**
- 通过 `scripts/analysis-contract.js` 检查 13 个必要章节
- 缺失时加载 `prompts/structure-repair.md`，把缺失标题和上次校验反馈交给主模型；完整结果不调用本轮

**Round 7 — 类型感知评分审计（`auditTypeAwareScoring`）**
- 加载 `prompts/scoring-audit.md`，由主模型只输出 JSON
- 重新审计文档类型、置信度和八维评分；跨维度理由失败时把精确错误反馈给下一次局部审计
- 非理论论文无核心产物时按肯定语境承诺开放 0.5、带 URL/肯定结构化状态的 Demo 0.2、否定或未提及 0 确定性归一化；理论研究保留基于公开证明材料的文类判断
- 代码只更新评分章节、机器摘要评分字段和评分理由，正文保持不变

**Round 8 — 图像筛选与插图计划（`applyImageSupplement`，双模型模式）**
- 加载 `prompts/image-supplement.md`
- 副模型基于最终文本和候选图片筛选高价值图，丢弃低信息图，并只输出 JSON 插图计划
- `[secondary]` 日志会记录论文 ID、模型、协议、endpoint/key 来源、候选与下载数量、图片安全标签/MIME/负载、活跃请求时长、请求/响应长度、JSON 解析状态、anchor 实际命中、拒绝原因和实际插入数量；不会打印 API key
- 插图计划只接受 `anchor`、图前 `lead` 和图后 `explanation`；旧 `replacement` / `rewrite` 字段会被忽略
- 代码按价值顺序最多插入 4 张图片；每张必须带有能在目标章节逐字匹配的非空 anchor，空值、错位或超限计划会被拒绝，不再回退到章节末尾。插入只新增图片和相邻说明，不替换主模型任何原句；候选编号不会被当成论文原始 Figure 编号
- 合并后再次执行共享完整契约；若计划破坏章节、评分或解析结果，只丢弃该计划并保留已审计正文
- 无真实 caption 的通用 `图N` alt 与 `selectedImageUrls` 按最终正文出现顺序归一化，避免候选编号在重排插入后成为倒序展示图号
- 只有严格 JSON 对象中的 `insertions: []` 才标记 `no_high_value_images`；schema 错误、非法 JSON、全图下载失败或契约破坏会写入非终态恢复状态，不能伪装成成功分析

**阶段恢复**：`analysisManifest` 逐阶段保存状态，失败正文写入 `analysisCheckpoint`，候选/下载/选图元数据写入 `analysisRecoveryImageManifest`。失败合并会独立按完整契约重解析旧正文，不受最新失败 manifest 影响，连续多次失败仍保留旧成功正文。强制重分析成功旧记录时因没有 checkpoint 会清空主分析及所有下游完成标记；普通失败续跑则从首个未完成阶段继续。

**API 调用**：
- `callModel(messages, maxTokens)`：带重试的 API 调用封装（内层最多 3 次重试，指数退避：第一次 10 秒，之后翻倍）
- `_callModelOnce()`：单次 API 调用共享 20 分钟活跃时间预算；每秒心跳检测系统睡眠/长时间挂起并排除墙钟跳变，唤醒后的请求错误仍可在剩余预算内重试
- LLM API 请求强制设置 `agent: false`，禁用连接复用以绕过代理污染（避免 MiMo 403）

**其他特性**：
- 只检测项目根 `.env` 中显式配置的代理变量；不继承 shell/IDE 代理，也不读取 macOS `scutil`
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
- `detectProxyUrl()`：只读取已经由项目环境加载器隔离过的代理变量
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

#### `scripts/generate-blog.py` / `scripts/review-blog.py` / `scripts/push-blog.py`

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
- **排行榜表格**：排名（medal）、论文标题（链接到单篇页）、评分、分档（`rankBucket`）、文档类型、主任务标签
- **论文列表**：每篇的评分 emoji、标题链接、作者与机构、毒舌点评、核心摘要

**单篇页（`YYYY-MM-DD-<slug>.md`）**：
- Hugo frontmatter：
  - `title`：论文标题（YAML 安全转义，处理双引号、换行等）
  - `date`：博客日期
  - `tags`：解析后的标签（去除 `#`）
  - `categories: [论文速递]`
  - `description`：`主任务标签 | 评分/10`，无则回退到标题
  - `hiddenInHomeList: true`
- 正文：标签串 → 评分/分档/文档类型/评分置信度/标签元信息 → 机器评分详情 → 作者与机构 → 各分析章节 → 返回汇总页链接

**发布流程**：
1. `generate-blog.py` 只生成并安装 `.md`，然后写入 `blog-generation-manifest-YYYY-MM-DD.json`；不调用 LLM，不提交、不推送。
2. `review-blog.py` 只读取 generation manifest 对已生成文件执行代码、LLM 和多模态图片三层 review 以及 Hugo gate；通过后写入带逐文件 SHA-256 的 `blog-review-receipt-YYYY-MM-DD.json`，不执行 Git 发布。
3. `push-blog.py` 只验证审查凭证与工作树文件哈希完全一致，再精确 stage → 中文详细 commit → `git push origin HEAD:main` → 验证远端 OID；该脚本不生成也不 review。
4. GitHub Actions 自动构建并部署到 Pages。

**运行环境**：上述三个入口和兼容 `publish-to-blog.py` 都强制要求沙箱外运行。它们检测到可靠沙箱标志 `CODEX_SANDBOX` 即拒绝开始；沙箱外权限包装会保留网络禁用环境标志，不能将其单独视为仍在沙箱内。此时应从沙箱外重新运行原阶段，不得跳过审查或伪造凭证。

**推送边界**：review 凭证绑定 review 时博客 `main` 的基线提交和逐文件 SHA-256。`push-blog.py` 只允许从该基线提交本次清单，或重试凭证中已记录的同一发布提交；发现人工提交、工作树改动或基线偏移会拒绝推送。生成阶段也会拒绝覆盖目标日期页面的人工 Git 修改。

**参数**：三个脚本都支持 `--date YYYY-MM-DD`；只有 `generate-blog.py` 接受 `--all`、`--category` 和自定义数据文件。`publish-to-blog.py --push` 会直接拒绝，防止恢复合并流程。

**日期过滤**：
- 脚本默认按 `fetchedAt` 字段过滤，只发布匹配 `--date` 指定日期（默认今天）的论文
- `deep-analysis-result.json` 会累积历史数据，日期过滤确保只发布当日抓取的新论文
- 若需发布全部论文（不过滤），显式传 `--all`

**Review 环节**：
生成阶段先从 `analysis` 重解析评分，并与缓存 `parsed`、顶层评分版本比较。review 阶段执行代码正则、LLM 文本和多模态图片三层 review；汇总页文本分块与独立论文页默认以 8 并发执行，可用 `PD_BLOG_REVIEW_CONCURRENCY` 调整。任何不确定 review 都按错误阻断，未生成严格审查凭证时 push 阶段必须失败。

代码层自动修复覆盖以下问题：
三层 review 分块会保持连续 Markdown 表格行的完整性，避免将表头与分隔行分到不同请求后产生伪误报。多模态 review 只对成功加载的图片同步追加上下文与 payload，个别图片下载失败不会使后续图片错配到前一张图的正文。

1. 未转义的 HTML-like 标签（`<S>`、`<E>`、`<task>` 等）→ 用反引号包裹
2. 未转换的 LaTeX `$...$` 公式 → 转为 `\(...\)` 格式
3. 非标准图片引用格式 → 转为标准 Markdown 图片语法
4. 过长的 base64 data URI → 自动截断
5. YAML frontmatter 双逗号 → 自动修复
6. 未闭合的 LaTeX `$ \mathcal{L}_D \(` → 转为 `\(\mathcal{L}_D\)`
7. 错乱的 LaTeX 括号（`\)\mathcal{L}_X\(`）→ 统一修正为 `\(\mathcal{L}_X\)`
8. 双反斜杠 LaTeX（`\(\\mathcal{L}_X\)`）→ 修正为 `\(\mathcal{L}_X\)`

Markdown 表格允许前导分组列为空；代码层不得把这类合法阶段续行当作子标题删除。LLM 提出的“普通模型名/技术术语必须加反引号”属于样式伪问题，会被过滤。

LLM 层修复：LLM 审查返回 `auto_fixable: true` 的问题，按 `fix_instruction` 执行简单文本替换。博客 review 与小红书 one-liner 共用 `publish_common.py` 中的 `call_publish_llm_api()`，协议路由与 Node 端保持一致；客户端使用标准库的显式空代理处理器强制 LLM 直连，避免受 `requests` 版本兼容性和抓取代理污染影响；Anthropic 兼容请求会动态读取本地 `claude --version` 生成 `User-Agent`，失败时回退默认版本。

**重要限制**：`fetchedAt` 是抓取时间，不是论文在 arXiv 上的 `published` 日期。跨天运行时请显式指定 `--date`。

#### `scripts/publish-wechat-full.py`

生成微信公众号图文草稿。

- 默认数据源：`data/current/deep-analysis-result.json`（支持命令行传入自定义路径）
- 默认按 `fetchedAt == --date`（默认今天，北京时间）过滤；传 `--all` 才使用输入文件中的全部论文
- 微信公众号 `APP_ID` / `APP_SECRET` 从项目 `.env` 读取
- 支持 `--dry-run`：只生成本地预览 HTML，不获取 Token、不上传图片、不创建草稿
- **图片上传**：仅上传正文 Markdown 图片和 `selectedImageUrls` 中的已选图片 → 上传到微信 CDN → 替换为微信 URL。缓存保存在 `/tmp/wechat-image-cache.json`，不会直接上传/发布 `allImageUrls` 候选图
- **自动分 Part**：单篇草稿上限约 48000 字符（HTML），超过自动拆分为多个草稿
  - 只有 Part 1 包含"今日概览"
  - 每 Part 标题：`语音/音乐/音频论文速递 YYYY-MM-DD | part N | M篇论文`
- 生成预览 HTML：`data/current/wechat-preview-YYYY-MM-DD.html`

#### `scripts/publish_common.py`

Python 发布公共模块。统一封装数据加载、评分排序、标签提取、格式化工具，消除 `publish-to-blog.py` / `publish-wechat-full.py` / `publish-xiaohongshu.py` / `publish-to-feishu.py` 的重复逻辑。

主要函数：
- `load_papers(data_file)`：从 JSON 加载论文列表；未传路径时优先读取 `data/current/deep-analysis-result.json`，缺失时回退旧路径 `data/deep-analysis-result.json`；根对象必须是数组或 `{papers: [...]}`，否则直接报错
- `score_and_sort(papers)`：从正文重解析并校验评分，再与缓存 `parsed` 比较后按评分降序排列；人工修正必须使用 `parsedOverride` 声明来源、原因和允许覆盖字段
- `extract_top_tags(papers, limit)`：提取主任务标签并统计频次
- `extract_all_tags(papers, limit)`：提取所有标签（去重），用于博客标签云
- `extract_one_liner(pa)`：从分析结果中提取一句话亮点，优先用创新点或核心贡献句
- `score_emoji(score)` / `format_medal(index)`：评分 emoji 和奖牌格式化
- `build_paper_meta(pa, aurl)`：拼接评分/分档/标签元信息
- `parse_cli_args(argv, defaults)`：通用命令行参数解析，被各发布脚本复用
- `call_publish_llm_api()`：发布阶段公共 LLM API client，自动处理 OpenAI / Anthropic / MiMo / Kimi / DeepSeek 路由；正式发布可用 `required=True` 强制失败即阻断

#### `scripts/path_config.py`

Python 发布/维护脚本共享路径配置。集中提供 `PROJECT_ROOT`、`DATA_DIR`、`CURRENT_DIR`、`LOGS_DIR`、`PAPERS_FILE`、`DEEP_ANALYSIS_RESULT_FILE` 等常量，以及 `resolve_deep_analysis_result_path()`、`xiaohongshu_markdown_path()`、`wechat_preview_path()`、`backfill_result_path()` 等路径 helper。新增 Python 脚本不要再手写默认 `data/current/*.json` 或发布产物路径。

#### `scripts/publish-xiaohongshu.py`

生成小红书文案。

- 默认数据源：`data/current/deep-analysis-result.json`
- 支持 `--top N` 精选版（默认 TOP 5，常用 `--top 3`）和 `--all` 完整汇总版
- 支持 `--date YYYY-MM-DD` 指定日期
- 若没有匹配 `fetchedAt == --date` 的论文，脚本会停止生成，避免跨日混入历史论文
- 输出到 `data/current/xiaohongshu-YYYY-MM-DD-<suffix>.md`
- **每篇论文的一句话介绍调用发布阶段 LLM API 生成**（复用 `publish_common.py` 的协议路由和标准库显式无代理传输，强制绕过代理）；输入优先使用 `parsed.summary/results/limitations/opensource` 和主标签，再回退摘要；LLM 失败时回退到本地 `extract_one_liner()`
- 自动清理 Markdown 格式和学术化前缀
- 附带 emoji 热度标识：🔥≥8 分、✅≥6 分、📝<6 分（与博客、微信统一）
- 少于 1000 字，不输出标签和 `---` 分隔线，开源信息标注清晰

#### `scripts/xiaohongshu-publisher.py`

小红书自动发布脚本（调用小红书 Web API，非官方接口）。

- `--login`：扫码登录，保存 cookie 到本地缓存文件
- `--publish`：发布当前日期 TOP 5 精选帖（默认读取 `top5` 文案；生成文案时可用 `--top 3` 产出 TOP 3）
- `--all`：发布当前日期完整汇总帖（读取一份 `all` 汇总文案并发布一次，不是逐篇多帖）
- `--date YYYY-MM-DD`：指定日期
- 默认日期使用北京时间；截图匹配 `~/Pictures/微信图片_YYYYMMDD*.png`
- 登录后 cookie 持久化，下次无需重复扫码
- 对应 npm 脚本：`npm run xhs-login`、`npm run xhs-publish`、`npm run xhs-publish-all`

#### `scripts/publish-to-feishu.py`

生成飞书文档。

**凭据读取**：
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 从项目 `.env` 读取（与其他发布渠道一致，统一放在 `项目根目录的 `.env` 文件`）

**数据输入**：
- 统一读取 `data/current/deep-analysis-result.json`（与其他发布渠道一致）
- 支持 `--date YYYY-MM-DD` 指定日期
- 默认按 `fetchedAt == --date`（默认今天，北京时间）过滤；传 `--all` 才使用输入文件中的全部论文
- 支持 `--dry-run`：只统计将生成的文档标题和块数量，不获取 Token、不创建飞书文档

**实现特点**：
- Python 实现，复用 `publish_common.py` 的数据加载和评分排序；生成正文前从 `analysis` 重解析并与缓存 `parsed` 校验一致，人工覆盖必须带显式 provenance
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
- 复用统一的每次运行日志，不再重复追加 `logs/backfill.log`
- 对 `papers.json` 使用与 Node 端相同的 `.lock` 目录和 `generation` 协议，锁内重读合并，避免长时间抓取后的陈旧快照覆盖并发分析状态
- 依赖：见根目录 `requirements.txt`（`requests`、`playwright`）

#### `scripts/backup-data.sh`

数据备份壳脚本。

---
