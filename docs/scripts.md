# 脚本分工

## 脚本分工（全部脚本详解）

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

#### `scripts/backup-data.sh`

数据备份壳脚本。

---