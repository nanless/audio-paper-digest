# 脚本分工

## 脚本分工（全部脚本详解）

> **运行前置条件**：所有本项目脚本必须在沙箱外执行。直接启动的 Node/Python 脚本会由公共环境加载器检测 `CODEX_SANDBOX` 并在任何业务操作前拒绝执行；`run-daily-digest.sh`、`run-full-fetch.sh` 和 `scripts/backup-data.sh` 也有同样的入口检查。单元测试导入模块不会触发该检查。

### 4.1 主链路脚本

#### `run-daily-digest.sh`

Codex 对“运行/进行某日论文速递”请求使用的默认脚本编排入口。日期参数必须是真实公历日期；从 `fetch` 开始时还必须等于北京时间当天，因为 `full-fetch.js` 自己绑定启动时的北京时间日期、并不接收历史日期参数。脚本随后启动博客 generate、review、push、发布后视觉规划和 `visual:prepare`。历史批次只能用 `--from generate|review|push|visual` 续跑已有数据，不能借该入口补抓历史日；generate 会先使用批次匹配的 current 分析，否则自动回退 `data/archive/<日期>/deep-analysis-result.json`。支持 `--from fetch|generate|review|push|visual`，便于 review 修正或瞬时失败后从对应阶段续跑，不重复已经成功的长耗时阶段。

该脚本保持博客三阶段为独立进程，并在任一阶段非零退出时立即停止。它不调用任何图像 API；脚本成功后，Codex 仍必须使用内置 `image_gen` 生成、目检、登记 TOP 10 论文长图和汇总封面，再运行 `visual:status` 与 `cover:status`，两者均完成才算整轮论文速递完成。npm 入口：`npm run digest:prepare -- YYYY-MM-DD`。

#### `scripts/full-fetch.js`

核心数据流程入口。执行自动归档 → 加载去重库（含博客已发布 ID）→ arXiv 抓取 → HF 抓取 → 合并去重 → 过滤博客已发布论文 → LLM 筛选 → 更新去重库 → 深度分析 → 增量保存。该入口不建立视觉任务；先发布汇总页和全部论文页，远端 OID 验证成功后再建立 TOP 10 论文长图和汇总图。

抓取阶段按 arXiv 类别和 HuggingFace 来源原子保存 checkpoint；每个来源同时绑定论文数量和稳定内容 SHA，损坏时仅补抓该来源。checkpoint、raw、decisions、filtered 的候选/来源/博客去重指纹与北京时间批次日期必须一致。只有七个类别和 HF 必需请求覆盖完整时才能筛选；健康 raw 即使尚无 decisions 也可继续，筛选配置变化只重筛不重抓。

所有配置从 `scripts/config.js` 读取，支持项目根 `.env` 覆写：
- `ANALYSIS_CONFIG.concurrency = 3`（`PD_ANALYSIS_CONCURRENCY`）
- `ANALYSIS_CONFIG.maxRetries = 2`（`PD_ANALYSIS_MAX_RETRIES`）
- `ANALYSIS_CONFIG.apiMaxRetries = 3`（`PD_ANALYSIS_API_MAX_RETRIES`，单次分析内部每个 LLM API 阶段的最大尝试次数）
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
- 每篇成功或失败后都在单篇运行锁内立即重读 canonical、合并并保存恢复状态；失败尝试保留 checkpoint 且不会覆盖旧成功正文，同时立即同步该篇 `papers.json.digestStatus`
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
- LLM 前默认启用高召回关键词预筛：明确命中音频任务/模态/方法词族、命中核心音频 arXiv 类别或摘要不足 80 字符时进入 LLM；只有摘要完整且未命中的补充类别论文才形成 `keyword_prefilter` 确定性否定决定。按日期重筛逐批保存 `refilter-filter-decisions.json`，续跑只重试未决论文；重筛收尾时 `deep-analysis-result.json` 会按本轮明确入选 ID 收敛，保留入选失败项的恢复 checkpoint，并移除本轮已明确落选的旧结果
- `npm run keyword:recall` 同时运行人工正负金标门禁与历史回放。历史 LLM 入选中的已知误筛必须在 `tests/fixtures/keyword-prefilter-gold.json` 留下 ID 和理由；退出码只接受金标零漏召回、零误放且裁决后历史有效正样本零漏召回
- XML 解析为 regex 实现（arXiv API 格式稳定）

#### `scripts/config.js`

统一配置中心。所有硬编码参数集中管理，按功能分组：

**运行数据路径（`FILES`）**

`Config.FILES` 统一登记当前流程会读写的核心 JSON 文件：`papers` / `rawCandidates` / `filterDecisions` / `filteredPapers` / `deepAnalysisResult` / `analyzed`、`digestRunReportDir`，以及仍需兼容的 legacy 路径。新增脚本不要手写 `data/current/*.json` 路径，优先复用这里的常量。

**分析配置（`ANALYSIS_CONFIG`）**

| 配置项 | 默认值 | 项目 `.env` 覆写 | 说明 |
|--------|--------|-------------|------|
| 并发度 | 3 | `PD_ANALYSIS_CONCURRENCY` | 深度分析并行篇数 |
| 外层重试次数 | 2 | `PD_ANALYSIS_MAX_RETRIES` | analysis-engine 层面每篇重试次数 |
| 外层重试延迟 | 3000ms | — | 外层重试间隔 |
| API 整体超时 | 20 分钟活跃时间 | — | 排除系统睡眠/长时间挂起的墙钟跳变 |
| API 内层重试次数 | 3 | — | deep-analyzer 内层每次调用重试次数 |
| API 内层退避基数 | 5000ms | — | 指数退避：第一次 5s，之后翻倍 |
| 主分析 max_tokens | 64000 | — | 主分析 LLM 输出长度上限；局部修复默认使用 `repairMaxTokens=16000` |
| temperature | 0.7 | — | LLM 采样温度 |
| 图片下载超时 | 60s | `PD_IMAGE_DOWNLOAD_TIMEOUT_MS` | 单张图片下载超时，失败后仍按既定次数重试 |
| 单张图片原始大小上限 | 6MB | `PD_IMAGE_MAX_BYTES` | 下载后按字节数校验 |
| 单张 base64 上限 | 8M 字符 | `PD_IMAGE_MAX_BASE64_CHARS` | 单张图片转 base64 上限 |
| 单篇图片 base64 总上限 | 20M 字符 | `PD_IMAGE_TOTAL_BASE64_CHARS` | 防止多图请求体过大 |
| 每篇默认实际插图上限 | 4 张（可用正整数覆写） | `PD_IMAGE_INSERTION_MAX` | 按副模型价值顺序截断，且只接受代码提供的稳定 `paragraph_id`；旧 anchor 仅兼容历史响应 |
| 主分析全文预算 | 200K 字符 | `PD_ANALYSIS_FULL_TEXT_MAX_CHARS` | 超长 arXiv HTML/PDF 正文按全文位置和任务关键词确定性取样 |
| 开源扫描证据预算 | 16K 字符 | `PD_OPENSOURCE_EVIDENCE_MAX_CHARS` | 优先保留 URL、仓库、权重、数据集和发布承诺 |
| 审校重写证据预算 | 60K 字符 | `PD_REVISION_EVIDENCE_MAX_CHARS` | 跨全文保留方法、实验、限制和关键数字 |
| 评分审计证据预算 | 40K 字符 | `PD_SCORING_EVIDENCE_MAX_CHARS` | 与已有分析证据账本共同送审 |
| 方法/表格修复证据预算 | 30K 字符 | `PD_REPAIR_EVIDENCE_MAX_CHARS` | 分别按方法词和实验/指标词选取 |
| 结构修复证据预算 | 40K 字符 | `PD_STRUCTURE_EVIDENCE_MAX_CHARS` | 为缺失章节提供跨文档证据 |
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
| 每类抓取目标数 | 100 | `PD_ARXIV_MAX_RESULTS` | 最终目标；recent 固定最多两页/100 篇，不足部分由 search/Atom API 补足 |
| 最大尝试次数 | 5 | `PD_ARXIV_FETCH_MAX_RETRIES` | recent/search/摘要/API 统一上限 |
| 普通错误退避基数 | 5000ms | `PD_ARXIV_FETCH_RETRY_BASE_DELAY_MS` | 按尝试次数线性退避 |
| 限流退避基数 | 60000ms | `PD_ARXIV_RATE_LIMIT_BASE_DELAY_MS` | 429 按 `base*2^(attempt-1)` 退避 |
| 429 累计等待上限 | 120000ms | `PD_ARXIV_RATE_LIMIT_MAX_WAIT_MS` | 单分类共享限流预算 |
| 全部重试累计等待上限 | 600000ms | `PD_ARXIV_FETCH_MAX_WAIT_MS` | 单分类 recent/search/摘要/API 共享预算 |
| 单次绝对截止时间 | 60000ms | `PD_ARXIV_METADATA_TIMEOUT_MS` | 同时保留 socket timeout |
| 单次响应字节上限 | 8388608 | `PD_ARXIV_METADATA_MAX_BYTES` | 超限立即销毁请求 |
| User-Agent | 内置轮换池 | `PD_ARXIV_USER_AGENT` | 覆写后固定使用指定值 |
| 分类间延迟 | 60000ms | — | `categoryDelayMs`，不同分类请求间隔（full-fetch 另加抖动+限流惩罚） |
| 首次请求延迟 | 30000ms | — | `firstRequestDelayMs`，首个分类额外等待 |
| 连续已知阈值 | 20 | — | 连续 20 篇已有 ID 提前停止 |

以上字段由 `fetch-papers.js` 直接读取，不再保留与运行行为不同的登记值。

**HuggingFace 配置（`HUGGINGFACE_CONFIG`）**

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 默认天数 | 7 | 含端点截止为北京时间今天减 7 天，即今天及此前 7 个日历日期 |
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
- `mergeAndSaveResults(newResults, filePath, extraData)`：按 ID 去重合并并保存，**自带失败结果保护**；跨进程锁内重读最新 canonical、合并并递增 `generation`，拒绝陈旧快照覆盖或损坏 current JSON；不使用调用方 expected-generation 乐观比较
- 成功判定要求 `analysisManifest` 版本 1 的全部必需阶段进入终态，且不存在最新失败标记；失败合并保留旧成功正文，同时叠加新的 checkpoint、恢复图片清单与最近尝试错误，成功重试后再清理失败标记
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
- `analyzePaperDeep(paper)`：获取 arXiv HTML/PDF 全文；主分析默认最多使用 200K 字符，超长来源按开头、四分位、中部、尾部和任务关键词跨全文取样，而不是只截取前缀。随后预筛候选图片；双模型模式才串行下载候选图片并由副模型最终筛选高价值图片插入正文，单模型模式只保存候选图元数据；`allImageUrls` 保存候选图，`selectedImageUrls` / `imageUrls` 保存已选图
- 加载 `prompts/deep-analysis.md`，替换占位符后调用 LLM
- 输出包含：文档类型、评分、机器摘要、标签、作者与机构、毒舌点评、核心摘要、方法概述和架构、核心创新点、实验结果、细节详述、评分理由、局限与问题、开源详情
- `parseAnalysis(analysis)`：将分析文本解析为结构化对象，归一化 `document_type` 并为新结果写入 `type-aware-v1` 版本。只有八个分项完整、唯一、分母正确且分值合法时才重算 `score` 并封顶为 10；其余情况返回 `scoreValidation` 错误并阻断保存/发布

**Round 2 — 开源扫描（`scanOpensource`）**
- 加载 `prompts/opensource-scan.md`
- 从默认 16K 的开源任务证据中提取 GitHub / HuggingFace / ModelScope 等开源链接，不重复发送完整全文
- 补充到 `## 开源详情` 章节

**Round 3 — 审校重写（`reviseAnalysis`）**
- 加载 `prompts/gap-fill.md`
- 使用默认 60K 的跨全文任务证据对比 Round 1 输出，检查缺失、错误、过度推断
- 生成修订版分析文本，覆盖原有内容

**Round 4 — 表格修复（`checkAndFixTables`）**
- 加载 `prompts/table-fill.md`
- 检测 `## 实验结果` 中缺失的 Markdown 表格
- 若发现表格被省略或截断，使用默认 30K 的实验/数字相关证据触发 LLM 补充完整表格

**Round 5 — 方法章节修复（`checkAndFixMethodSection`）**
- 加载 `prompts/method-fill.md`
- 检测 `## 方法概述和架构` 是否过于简略（少于 600 中文字符、表述模糊、不足 3 段）
- 若满足条件，使用默认 30K 的方法/架构相关证据触发 LLM 扩展至 600+ 字符的详细描述

**Round 6 — 最终结构修复（`repairMissingAnalysisSections`，按需）**
- 通过 `scripts/analysis-contract.js` 检查 13 个必要章节
- 缺失时加载 `prompts/structure-repair.md`，把缺失标题、上次校验反馈和默认 40K 的跨文档证据交给主模型；完整结果不调用本轮

**Round 7 — 类型感知评分审计（`auditTypeAwareScoring`）**
- 加载 `prompts/scoring-audit.md`，由主模型只输出 JSON
- 使用默认 40K 的评分相关证据账本重新审计文档类型、置信度和八维评分；跨维度理由失败时把精确错误反馈给下一次局部审计
- 非理论论文无核心产物时按肯定语境承诺开放 0.5、带 URL/肯定结构化状态的 Demo 0.2、否定或未提及 0 确定性归一化；理论研究保留基于公开证明材料的文类判断
- 代码只更新评分章节、机器摘要评分字段和评分理由，正文保持不变

**Round 8 — 图像筛选与插图计划（`applyImageSupplement`，双模型模式）**
- 加载 `prompts/image-supplement.md`
- 副模型基于最终文本和候选图片筛选高价值图，丢弃低信息图，并只输出 JSON 插图计划
- `[secondary]` 日志会记录论文 ID、模型、协议、endpoint/key 来源、候选与下载数量、图片安全标签/MIME/负载、活跃请求时长、请求/响应长度、JSON 解析状态、`paragraph_id` 命中、拒绝原因和实际插入数量；不会打印 API key
- 插图计划接受代码提供的稳定 `paragraph_id`、图前 `lead` 和图后 `explanation`；旧 `anchor` 只保留历史响应兼容，`replacement` / `rewrite` 字段会被忽略
- 代码按价值顺序最多插入 4 张图片；每张必须命中目标章节中的有效 `paragraph_id`，空值、非法 ID、错位或超限计划会被拒绝，不再回退到章节末尾。插入只新增图片和相邻说明，不替换主模型任何原句；候选编号不会被当成论文原始 Figure 编号
- 合并后再次执行共享完整契约；若计划破坏章节、评分或解析结果，只丢弃该计划并保留已审计正文
- 无真实 caption 的通用 `图N` alt 与 `selectedImageUrls` 按最终正文出现顺序归一化，避免候选编号在重排插入后成为倒序展示图号
- 只有严格 JSON 对象中的 `insertions: []` 才标记 `no_high_value_images`；schema 错误、非法 JSON、全图下载失败或契约破坏会写入非终态恢复状态，不能伪装成成功分析

**Codex 视觉资产（全部博客发布后的后处理阶段）**
- `push-blog.py` 在汇总页和全部论文页推送成功且远端 OID 验证后，自动运行 `visual-summary-integration.js`。它只为最终评分 TOP 10 建立 `infographic` 任务，同分按规范化 arXiv ID 排序
- `npm run visual:render:debug -- --spec SPEC.json --output OUTPUT.png [--illustration 无字插画] [--reference 方法/架构原图] [--result-reference 关键实验原图]` 是保留的本地确定性调试/回退渲染器，不再用于默认最终视觉资产。默认流程由内置 `image_gen` 一次性生成完整带字构图，并在登记前人工目检准确性。回退渲染器仍可使用 Pillow 合成约 `2160x4552` 的论文长图或汇总封面，支持结构化 `diagram.columns/nodes/edges` 中文重绘、参考图图注、简单柱状图/指标卡和 8 MiB 输出门禁
- 逐项核对 `generationContext.qaClaims` 后，使用 `visual-summary-state.js record --date YYYY-MM-DD --paper ID --kind infographic --file PNG --token TOKEN --qa-attested true` 登记。显式 QA 声明会随资产保存；脚本同时验证 PNG、最小尺寸、纵横比、大小、SHA 和 task token
- 调用内置生图前运行 `npm run visual:prepare -- --date YYYY-MM-DD [--paper ID]`。命令只物化输入，不调用图像 API；它校验 `.bin` 缓存受控路径、SHA、字节数、MIME 与文件头，再输出具有正确 `.png/.jpg/.webp` 扩展名的绝对 `referencedImagePaths`（另保留相对路径供日志展示），避免工作目录变化或直接上传 `.bin` 触发图片服务错误
- 视觉 plan/status 默认仅输出排名、论文 ID、标题、task token、参考图数和 manifest 绝对路径；`visual:prepare` 额外保留内置生图必需的绝对 `referencedImagePaths`。完整 `generationContext.qaClaims` 和封面排行仍保存在 manifest，终端不再重复打印大对象
- 汇总图从同批次审计论文确定性计算标题、热门方向计数和 TOP 10 排名，并复用博客 generation manifest 的 category；目检排行榜后用 `digest-cover-state.js record ... --qa-attested true` 登记到同一目录
- 每篇视觉任务的 `generationContext.qaClaims` 提供完整英文标题、四个必要内容区、方法声明、带数字实验声明、局限和参考图 caption；提示词和登记前目检必须逐项核对
- 旧版 `data/current/visual-summaries/` 和 `data/current/digest-covers/` 资产会在下一次 plan 时校验 PNG 与 SHA，确认归档目标无冲突后迁移
- 对缺少新版远端 OID 字段、不能重新 plan 的历史批次，使用 `npm run visual:archive -- --date YYYY-MM-DD` 和 `npm run cover:archive -- --date YYYY-MM-DD`；legacy archive 不要求现代远端 receipt，也绝不创建任务或伪造发布凭证，而是校验 manifest、PNG 字节、SHA、受控源/目标路径并拒绝符号链接后，仅迁移已有资产。旧 generation manifest 会与同日归档分析论文集合交叉校验后计算排名，非 TOP10 旧卡片平铺命名为 `unranked-<paper-id>-<kind>.png`
- 两类状态互相独立：论文分析/prompt 变化只失效对应长图，论文集合、分数、主任务标签或封面 prompt 变化只失效封面。`visual:status` / `cover:status` 非零时，下一轮仅补 pending/failed、损坏或指纹失效的资产
- 项目脚本只负责计划、验证、复制和 checkpoint，不调用图像 API。不得把生成内容称为论文原始图，不得编造数值、作者、结论或排行榜；封面不得渲染 arXiv ID
- 图片状态不进入博客 generation/review/push 清单，不阻断已经发布的博客；无远端验证凭证时所有 plan/status 命令拒绝启动

**阶段恢复**：`analysisManifest` 逐阶段保存状态，失败正文写入 `analysisCheckpoint`，候选/下载/选图元数据写入 `analysisRecoveryImageManifest`。失败合并会独立按完整契约重解析旧正文，不受最新失败 manifest 影响，连续多次失败仍保留旧成功正文，但 `latestAnalysisAttemptError` 会强制下一轮继续重试。全文或实际取样输入变化时，同时清除绑定旧来源的图片恢复清单。强制重分析成功旧记录时因没有 checkpoint 会清空主分析及所有下游完成标记；普通失败续跑则从首个未完成阶段继续。

**表格 token 门禁**：新分析/重分析在结构修复阶段写入 `analysisManifest.contracts.experimentTables=bounded-v1`。评分前的代码硬门禁限制每篇最多 2 张关键表、每张最多 12 个数据行和 8 个指标列，超限时交给局部结构修复；Node 数据校验和 Python 发布预检只对带版本标记的结果再次强制校验，因此无标记的既有成功记录不会被全量判坏。表格修复不再因原文的任意表格存在而触发；只有实验正文以 `Table` / `Tbl.` / `表` 明确引用但缺表，或存在非法省略标记时才执行。

每个分析阶段另有输入/输出快照和指纹：主分析绑定实际截断输入，评分绑定评分前结构修复正文，插图绑定候选集合、下载内容 SHA 与插图前正文。任何变化只失效当前及下游阶段。所有入口仅在同篇共享锁内合并论文内容；批次/最终统计不会再回写累计 paper payload。

**API 调用**：
- `callModel(messages, maxTokens)`：带重试的 API 调用封装（内层每个 LLM API 阶段默认最多尝试 3 次，可用 `PD_ANALYSIS_API_MAX_RETRIES` 调整；第一次失败后等待 10 秒，之后指数翻倍）
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
2. `review-blog.py` 只读取 generation manifest，对需要审查的文件执行代码、LLM 和多模态图片三层 review，并对完整批次执行确定性校验与 Hugo gate。每个通过项立即写入 `blog-review-passes-YYYY-MM-DD.json`，以博客仓库相对路径 + 实际读取 SHA-256 为永久复用键；失败状态写入 `blog-review-failure-YYYY-MM-DD.json`。代码、脚本、文档、模型、协议、generation manifest 或博客 `main` 基线变化不会清空未改页面的通过项，只会让新增、SHA 变化、瞬时失败或内容失败修复后的文件进入 review；通过后重新签发绑定当前清单、基线、协议和 Hugo gate 的 `blog-review-receipt-YYYY-MM-DD.json`，不执行 Git 发布。HTTP 重试优先服从 `Retry-After`，否则指数退避并加入短随机抖动；协议格式修复和完整协议重试使用更小预算。若推理模型将输出预算全部用于隐藏推理、未返回最终 JSON，客户端只追加纯 JSON 指令恢复一次，默认从 4000 最多增到 8000，不再盲目翻倍到 16000。
- 若 LLM review 服务在整批审查期间不可用，可显式调用 `python3 scripts/manual-review-blog.py --date YYYY-MM-DD --attestation ATTESTATION.json` 进入 `manual_complete` 接管。attestation 必须由人工/Codex 填写并包含八项全为 `true` 的检查、原因和 agent；脚本仍执行确定性 review、逐文件 SHA、generation manifest/baseHead/review protocol 绑定及 Hugo gate，并把 attestation SHA、修复记录和检查文件写入 receipt。该模式不会把普通网络/配额错误自动降级为通过，也不接受缺少全文来源或分析 provenance 的论文。
- 完全离线深度分析先用 `npm run manual:spec -- --date YYYY-MM-DD --records RECORDS.json` 组装严格 spec；并行分片可重复传入 `--records`。每份输入必须是 `manual_analysis_records` v1 envelope，且 date、agent、reviewProtocol 一致；每篇必须显式提供合法八维评分、实际 audit passes、阶段审查次数、由全文原句绑定的 `authorInfo`，以及至少六条覆盖核心摘要、方法、实验、局限、开源五章的 evidenceLedger。组装器要求 `manual-full-text/<date>/manifest.json` 为 complete v2，验证其与完整 filtered 批次、论文集合、指定 arXiv 版本、指纹化全文路径、来源身份和文件 SHA 精确一致；`titleOverride` 仅可修复标题空白，显式空 `selectedImageUrls` 保持未选图。图片候选只取 manifest，过滤 arXiv 页面 chrome、资助方 logo 和赞助素材，随后由 manual-deep 执行标准安全下载。缺失、重复、跨日期或任一指纹漂移均在原子写 spec 前阻断，且该命令不调用 API。
- 随后使用 `npm run manual:analyze -- --date YYYY-MM-DD --spec SPEC.json`。spec 必须逐篇提供受控全文路径、当前 `deep-analysis.md` 指纹、至少六条可在全文中定位的事实引用、两轮审计记录和十个阶段的 reviewed claims；命令不调用任何 LLM/API，先对整批执行标准分析契约，再执行 manual_complete v2 provenance 校验，任何一篇失败都会拒绝写入 canonical 结果。初审发现问题时必须修改正文并留下终审空问题列表，不能用单个 `review=true` 声明替代重跑。
- 完全离线抓取与筛选先运行 `node scripts/manual-fetch.js --date YYYY-MM-DD --raw`。该命令只访问 arXiv/HuggingFace，保存来源健康、逐来源内容 SHA 和候选指纹，不调用筛选模型；随后人工逐篇检查标题、摘要、类别和来源，提交 `{version:1,mode:"manual_offline",date,reviewer,decisions}` 规格并运行 `node scripts/manual-fetch.js --date YYYY-MM-DD --select SPEC.json`。脚本拒绝缺失、未知、重复或理由不足的 ID，为每篇绑定输入 SHA、审核人和 `manual-offline-v1` 协议指纹，只有完整覆盖才写入 `complete` 筛选四件套。
3. `push-blog.py` 先验证审查凭证与工作树文件哈希，并在任何 Git 变更前执行视觉能力 preflight。标准日更 `--require-visual-plan` 只接受 schema v3；schema v1/v2 仅允许显式维护 push，receipt 记录 `postPublishVisuals=not_applicable_legacy_maintenance` 并跳过视觉。通过后再精确 stage → 中文详细 commit → `git push origin HEAD:main` → 验证远端 OID，并把 remote 名称与 push URL 的 SHA-256 身份写入凭证；该脚本不生成也不 review。
4. GitHub Actions 自动构建并部署到 Pages。

**运行环境**：上述三个入口和兼容 `publish-to-blog.py` 都强制要求沙箱外运行。它们检测到可靠沙箱标志 `CODEX_SANDBOX` 即拒绝开始；沙箱外权限包装会保留网络禁用环境标志，不能将其单独视为仍在沙箱内。此时应从沙箱外重新运行原阶段，不得跳过审查或伪造凭证。

**推送边界**：review 凭证绑定 review 时博客 `main` 的基线提交和逐文件 SHA-256。`push-blog.py` 只允许从该基线提交本次清单，或重试凭证中已记录的同一发布提交；发现人工提交、工作树改动或基线偏移会拒绝推送。完全相同的已发布非空批次可三阶段幂等重跑，但复用前必须重新核对当前协议、文件、发布提交、remote 身份和实时 `main` OID；网络失败或 `origin` 换仓不信任旧凭证。生成阶段也会拒绝覆盖目标日期页面的人工 Git 修改。

三个阶段共享日期级锁和博客仓库级全局锁。生成逐页 journal 后才写汇总页/严格清单；review 记录实际读取 SHA；push 在 stage 后及 commit 前把 index blob/删除状态与凭证逐项比较，防止不同日期并发污染共享 Git 状态。

**参数**：三个脚本都支持 `--date YYYY-MM-DD`；只有 `generate-blog.py` 接受 `--all`、`--category`、可重复的 `--exclude-id <arXiv ID>` 和自定义数据文件。排除 ID 必须命中日期过滤后的当前批次，否则生成失败；它只改变本次 generation 权威快照，不修改分析数据。`publish-to-blog.py --push` 会直接拒绝，防止恢复合并流程。

**日期过滤**：
- 脚本默认优先按 `fetchBatchDate`/`batchDate` 过滤，旧数据才回退严格北京时间 `fetchedAt`，只发布匹配 `--date` 指定日期（默认今天）的论文
- `deep-analysis-result.json` 会累积历史数据，日期过滤确保只发布当日抓取的新论文
- 若需发布全部论文（不过滤），显式传 `--all`

**Review 环节**：
生成阶段先从 `analysis` 重解析评分，并与缓存 `parsed`、顶层评分版本比较。review 阶段执行代码正则、LLM 文本和图片审查；文本默认按 8000 字符分块。汇总页先审查，独立论文页并发度由 `PD_BLOG_REVIEW_CONCURRENCY` 控制且限制为 1–5。逐文件通过账本记录实际 `imageReviewMode`；receipt 汇总为 `multimodal`、`deterministic_only` 或 `mixed`，不会因当前启用副模型而把复用的旧页面误标成多模态。任何不确定 review 都按错误阻断。

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
9. 正文中完全重复的长段落，以及事实签名一致的高相似长段落 → 在 LLM 前确定性去重；数字、URL 或否定词不同则保留
10. Markdown 表格列数不一致 → 直接阻断；前导分组列为空且列数一致的合法续行保持不变
11. 120 字以上且疑似截在英文半词的图片说明 → 缩短到完整语义边界
12. 被反引号包裹的 `\(...\)` / `\[...\]` → 移除外围反引号，保留数学分隔符
13. 英文占主导的“毒舌点评” → 阻断，必须基于原点评改为简体中文
14. `[A_*]` / `[SCORING_SOURCE_*]` 内部评分锚点 → 仅从发布派生 Markdown 剥离，canonical analysis 保留证据

Markdown 表格允许前导分组列为空；代码层不得把这类合法阶段续行当作子标题删除。LLM 提出的“普通模型名/技术术语必须加反引号”属于样式伪问题，会被过滤。

LLM 层修复：LLM 审查返回 `auto_fixable: true` 的问题，必须带 `fix_instruction` 并按其执行简单文本替换；`auto_fixable: false` 的阻断问题允许省略修复指令。博客 review 与小红书 one-liner 共用 `publish_common.py` 中的 `call_publish_llm_api()`，协议路由与 Node 端保持一致；客户端使用标准库的显式空代理处理器强制 LLM 直连，避免受 `requests` 版本兼容性和抓取代理污染影响；Anthropic 兼容请求会动态读取本地 `claude --version` 生成 `User-Agent`，失败时回退默认版本。

#### `scripts/digest-run-report.js`

按 `--date YYYY-MM-DD` 汇总抓取、筛选、深度分析、博客 review/远端发布、TOP 10 长图和汇总封面状态，原子写入 `data/current/digest-run-reports/<date>.json`。终端默认只打印阶段完成数、待处理数与错误摘要；完整 `sourceHealth` 仍保存在 JSON 报告。只有所有必需阶段完整才返回 0；用于日更结束后的统一机器门禁，不会修改任一业务阶段状态。报告只绑定生成时读取到的状态，后续阶段推进不会自动改写它，验收当前状态必须重跑命令。

**重要限制**：`fetchedAt` 是抓取时间，不是论文在 arXiv 上的 `published` 日期。跨天运行时请显式指定 `--date`。

#### `scripts/publish-wechat-full.py`

生成微信公众号图文草稿。

- 默认数据源：优先读取 `data/current/deep-analysis-result.json`；current 已滚动时按目标博客发布日期回退受控日期归档（支持命令行传入自定义路径）
- 默认按目标博客发布日期绑定已远端验证的 `publishedPapers` 快照，论文原始抓取批次可以更早，自定义路径也仍绑定快照。独立发布须显式传 `--ignore-blog-snapshot`；仅在独立模式下按 `fetchBatchDate`/`batchDate`（旧数据回退严格北京时间 `fetchedAt`）过滤，`--all` 才使用全部输入
- 微信公众号 `APP_ID` / `APP_SECRET` 从项目 `.env` 读取；真实草稿还必须配置 `WECHAT_THUMB_MEDIA_ID`，只有 `--dry-run` 可省略
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

TOP N 精选版的一句话亮点使用受控并发生成，默认并发度为 5，可通过项目 `.env` 的 `PD_XIAOHONGSHU_ONELINER_CONCURRENCY` 设置为 1–5。结果始终按论文排名回填，单篇调用失败仅对该篇使用本地摘要回退。

生成小红书文案。

默认要求目标发布日期的正式博客 generation manifest（schema v3）及远端验证 receipt，验证清单 SHA、Hugo gate、review 协议、发布提交和远端 OID 后读取 `publishedPapers` 权威快照。论文原始抓取批次可以早于博客发布日期；current 已滚动时回退受控日期归档。清单缺失会 fail closed，显式自定义数据文件也仍绑定快照；只有 `--ignore-blog-snapshot` 才进入独立语义。

逐篇成功的一句话在日期级锁内写入缓存，绑定分析、prompt、模型端点配置和清洗契约；损坏缓存会原子隔离后重建，失败回退或指纹变化只重跑对应论文。`--date` 严格校验为 `YYYY-MM-DD`；该命令只产出文案。

- 默认数据源：`data/current/deep-analysis-result.json`
- 支持 `--top N` 精选版（默认 TOP 5，常用 `--top 3`）和 `--all` 完整汇总版
- 支持 `--date YYYY-MM-DD` 指定日期
- `--all` 只切换为完整汇总文案；`--ignore-blog-snapshot` 才显式绕过博客快照
- 若没有匹配批次日期的论文，脚本会停止生成，避免跨日混入历史论文
- 输出到 `data/current/xiaohongshu-YYYY-MM-DD-<suffix>.md`
- **每篇论文的一句话介绍调用发布阶段 LLM API 生成**（复用 `publish_common.py` 的协议路由和标准库显式无代理传输，强制绕过代理）；输入优先使用 `parsed.summary/results/limitations/opensource` 和主标签，再回退摘要；LLM 失败时回退到本地 `extract_one_liner()`
- 自动清理 Markdown 格式和学术化前缀
- 附带 emoji 热度标识：🔥≥8 分、✅≥6 分、📝<6 分（与博客、微信统一）
- 少于 1000 字，不输出标签和 `---` 分隔线，开源信息标注清晰

#### `scripts/xiaohongshu-publisher.py`

小红书自动发布脚本（调用小红书 Web API，非官方接口）。

- `--login`：扫码登录，保存 cookie 到本地缓存文件
- 默认直接发布当前日期 TOP 5 精选帖（读取 `top5` 文案；生成文案时可用 `--top 3` 产出 TOP 3）
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
- 默认优先读取 `data/current/deep-analysis-result.json`，current 已滚动时按目标博客发布日期回退受控日期归档（与其他发布渠道一致）
- 支持 `--date YYYY-MM-DD` 指定日期
- 默认按目标博客发布日期绑定已远端验证的 `publishedPapers` 快照，论文原始抓取批次可以更早，自定义路径也仍绑定快照。独立发布须显式传 `--ignore-blog-snapshot`；仅在独立模式下按 `fetchBatchDate`/`batchDate`（旧数据回退严格北京时间 `fetchedAt`）过滤，`--all` 才使用全部输入
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
- 抓取 arXiv 7 分类（每类 30 篇）和 HF Papers（默认含北京时间今天及此前 7 个日历日期）
- 耐限流设计：请求超时 30 秒，限流时指数退避，连续 20 篇已知 ID 提前停止
- 写入 `data/current/papers.json`
- 额外输出 `data/backfill-result.json`
- 复用统一的每次运行日志，不再重复追加 `logs/backfill.log`
- 对 `papers.json` 使用与 Node 端相同的 `.lock` 目录和 `generation` 协议，锁内重读合并，避免长时间抓取后的陈旧快照覆盖并发分析状态
- 依赖：见根目录 `requirements.txt`（`requests`、`playwright`、`PyYAML`）；`PyYAML` 用于确定性解析并校验博客 frontmatter，缺失时发布门禁会失败关闭

#### `scripts/backup-data.sh`

数据备份壳脚本。

---
