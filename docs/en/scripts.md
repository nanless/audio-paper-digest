# Script Responsibilities

## Script Responsibilities (Complete Script Reference)

### 4.1 Main Pipeline Scripts

#### `scripts/full-fetch.js`

Complete workflow entry point. Executes all steps in Section 3: auto-archive -> load dedup database (including blog-published IDs) -> arXiv fetch -> HF fetch -> merge and deduplicate -> filter blog-published papers -> LLM filter -> update deduplication database -> deep analysis -> incremental save.

All configurations are read from `scripts/config.js`, with environment variable overrides:
- `ANALYSIS_CONFIG.concurrency = 3` (`PD_ANALYSIS_CONCURRENCY`)
- `ANALYSIS_CONFIG.maxRetries = 2` (`PD_ANALYSIS_MAX_RETRIES`)
- `ANALYSIS_CONFIG.retryDelayMs = 3000`
- `FILTER_CONFIG.delayBetweenBatchesMs = 2000`

#### `scripts/deep-analysis-only.js`

Runs deep analysis only (resume mode).
- Reads `data/current/deep-analysis-result.json` (compatible with old path `data/deep-analysis-result.json`, automatically recognizes old-format pure arrays and converts them); if no analysis result exists yet but `data/current/filtered-papers.json` exists, initializes the analysis result from the filtered papers and resumes
- Skips papers that already have an `analysis` field
- Calls `deep-analyzer.js` for each unanalyzed paper
- Incrementally saves success/failure results and writes `data/current/papers.json` `digestStatus.status` back as `analyzed` / `analysis_failed`, safe for breakpoint resume

#### `scripts/reanalyze.js`

Full reanalysis.
- Default data source: `data/current/deep-analysis-result.json` (supports custom file path via command line, compatible with old-format pure arrays)
- Calls `deep-analyzer.js` for **all** papers in the file
- Default concurrency matches `ANALYSIS_CONFIG.concurrency` (default 3), adjustable via `--concurrency N` or `PD_REANALYZE_CONCURRENCY` environment variable
- **Saves intermediate results every 5 papers** (save interval auto-adjusted in concurrent mode), **only successful results overwrite old data**
- On startup, checks whether `PAPER_ANALYZER_API_KEY`, `PAPER_ANALYZER_MODEL`, `PAPER_ANALYZER_ENDPOINT` are set; exits directly if any are missing

#### `scripts/quick-test.js`

Quick test script.
- Executes arXiv 7-category fetch + deduplication + LLM filter (configuration from `config.js`)
- **Does not execute deep analysis**
- Outputs to `data/quick-test-result.json` (only saves the first 10 papers)
- Used to verify whether the fetch and filter pipeline is working correctly
- Direct invocation: `node scripts/quick-test.js` (`npm run test` has been changed to run unit tests)

#### `scripts/batch-analyze.js`

Batch analysis of unanalyzed papers (standalone entry point).
- Reads `data/current/deep-analysis-result.json`
- Analyzes unanalyzed papers one by one, **only successful results are written to save, failed results do not overwrite existing data**, convenient for retrying remaining papers after `full-fetch.js` is interrupted

#### `scripts/analyze-single-paper.js`

Analyze a single paper and merge it into the results.

**Usage**: `node scripts/analyze-single-paper.js <arxiv_id> [--force]`

- Reads metadata from `data/current/papers.json`
- Calls `deep-analyzer.js` for analysis, then appends to `deep-analysis-result.json`
- Skips if the paper already exists in the results by default; `--force` reanalyzes and replaces the old result
- Compatible with old-format pure array data, automatically converts to new object format on save

### 4.2 Fetch and Analysis Support Scripts

#### `scripts/fetch-papers.js`

arXiv fetch and LLM filter module.
- Exports `fetchCategoryPapers`, `fetchCategoryFromRecentPage`, `fetchCategoryFromSearchPage`, `fetchAbstracts`, `parseRecentPageHTML`, `deduplicatePapers`, `filterPapersWithLLM`, `isSpeechAudioRelated`, `loadPapers`, `savePapers`
- **3-level fetch strategy: recent → search → API**
  - `fetchCategoryFromRecentPage()`: fetches from arXiv recent page (lenient rate limit), supports 2-page pagination (max 100 papers)
  - `fetchCategoryFromSearchPage()`: fetches from arXiv search page, supports pagination + 5 retries
  - `fetchCategoryPapers()`: auto 3-level fallback, stops at whichever level yields sufficient papers
  - `fetchAbstracts()`: batch fetches abstracts from arXiv abs pages (concurrency 5)
- Filtering uses `PAPER_ANALYZER_*`; LLM requests force `agent: false` direct connections, while HTTP CONNECT proxy support applies to fetch-side requests

#### `scripts/config.js`

Unified configuration center. All hardcoded parameters are centrally managed and grouped by function:

**Analysis Configuration (`ANALYSIS_CONFIG`)**

| Config Item | Default | Env Override | Description |
|--------|--------|-------------|------|
| Concurrency | 3 | `PD_ANALYSIS_CONCURRENCY` | Number of papers analyzed in parallel |
| Outer retries | 2 | `PD_ANALYSIS_MAX_RETRIES` | Retries per paper at the analysis-engine level |
| Outer retry delay | 3000ms | -- | Outer retry interval |
| API overall timeout | 20 minutes | -- | AbortController timeout |
| API inner retries | 3 | -- | Retries per inner deep-analyzer call |
| API inner backoff base | 5000ms | -- | Exponential backoff: first 5s, then double |
| max_tokens | 64000 | -- | LLM output length limit |
| temperature | 0.7 | -- | LLM sampling temperature |
| Image download timeout | 15s | -- | Per-image download timeout |
| Single-image raw-size limit | 6MB | `PD_IMAGE_MAX_BYTES` | Byte-size guard after download |
| Single-image base64 limit | 8M chars | `PD_IMAGE_MAX_BASE64_CHARS` | Base64 conversion limit per image |
| Per-paper total image base64 limit | 20M chars | `PD_IMAGE_TOTAL_BASE64_CHARS` | Prevents oversized multi-image model payloads |
| Full-text limit | 500K chars | -- | arXiv HTML body truncation limit |
| arXiv HTML fetch timeout | 30s | -- | arXiv HTML fetch timeout |

**Filter Configuration (`FILTER_CONFIG`)**

| Config Item | Default | Description |
|--------|--------|------|
| Timeout | 60s | Per-paper filter API call timeout |
| Retries | 5 | Per-paper filter retries (`FILTER_CONFIG.maxRetries`, backoff `2^attempt * 1s`) |
| Batch size | 5 | Overridable via `PD_FILTER_BATCH_SIZE` |
| Batch delay | 2000ms | Wait time after each filter batch |
| temperature | 0.3 | Filter stage sampling temperature |

**arXiv Configuration (`ARXIV_CONFIG`)**

| Config Item | Default | Env Override | Description |
|--------|--------|-------------|------|
| Per-category fetch count | 100 | `PD_ARXIV_MAX_RESULTS` | Max results per category |
| Max retries | 30 | -- | `fetchMaxRetries`, per-category fetch retry limit |
| Retry backoff base | 5000ms | -- | `fetchRetryBaseDelayMs` |
| Rate-limit backoff base | 30000ms | -- | `fetchRateLimitBaseDelayMs`, 429 extra wait |
| Max wait time | 600000ms | -- | `fetchMaxWaitMs`, max 10 minutes wait per category |
| Category delay | 60000ms | -- | `categoryDelayMs`, delay between categories (full-fetch adds jitter + rate-limit penalty) |
| First request delay | 30000ms | -- | `firstRequestDelayMs`, extra wait for the first category |
| Consecutive known threshold | 20 | -- | Early stop after 20 consecutive known IDs |

> Note: the actual retry limit hard-coded in each `fetch-papers.js` path (recent/search/API) is 5; the 429 backoff is `60s * 2^(attempt-1)` (60s/120s/240s/480s), other errors `5s * attempt`. The table above lists the `ARXIV_CONFIG` values registered in `config.js`.

**HuggingFace Configuration (`HUGGINGFACE_CONFIG`)**

| Config Item | Default | Description |
|--------|--------|------|
| Default days | 7 | Only keep papers from the last 7 days |
| Max pages | 20 | daily_papers pagination limit |
| Per-page count | 100 | Items per pagination page |
| Page delay | 300ms | Delay between pagination requests |

**Publish Configuration (`PUBLISH_CONFIG`)**

| Config Item | Default | Description |
|--------|--------|------|
| Blog repo path | `~/code/github_repos/audio-paper-digest-blog` | Overridable via `PAPER_DIGEST_BLOG_REPO` |
| Content directory | `content/posts` | Hugo content directory |
| basePath | `/audio-paper-digest-blog` | Site subpath |
| WeChat draft char limit | 48000 | Per-draft HTML character limit |

**Archive Configuration (`ARCHIVE_CONFIG`)**

| Config Item | Default | Description |
|--------|--------|------|
| Max backups | 10 | `deep-analysis-result` bak file retention count |
| File logs | Disabled by default | Explicitly enable with `PD_ENABLE_FILE_LOGS=1` or `PAPER_DIGEST_ENABLE_FILE_LOGS=1` |
| Max logs | 50 | Log file retention count after file logs are enabled |
| Per-log file cap | 10MB | After file logs are enabled, further output remains terminal-only after the cap |
| Total log cap | 250MB | After file logs are enabled, old logs over the total cap are cleaned on startup |

Referenced by all core scripts.

#### `scripts/analysis-engine.js`

Unified analysis engine. Encapsulates the following functionality, eliminating duplicate logic across `full-fetch.js` / `deep-analysis-only.js` / `batch-analyze.js` / `reanalyze.js` / `analyze-single-paper.js`:

- `analyzePaperWithRetry(paper, options)`: single-paper analysis (with retry + auto-parse)
- `analyzeBatch(papers, options)`: batch analysis (supports concurrency control + incremental save callback)
- `mergeAndSaveResults(newResults, filePath, extraData)`: deduplicate by ID and save, **with built-in failure protection** (papers with an existing successful analysis will not be overwritten by a failed result without analysis)

#### `scripts/validate-scores.js`

Score validation and fix tool.
- `validateAndFix(papers)`: checks sub-item bounds, total score consistency, open-source contradictions; auto-fixes
- `DIM_MAX`: exported dimension max mapping
- CLI: `node scripts/validate-scores.js [data-file]`

#### `scripts/fetch-huggingface-papers.js`

HuggingFace Papers fetch module.
- `fetchHuggingFacePapers(existingIds, { days, minUpvotes })`: dual-source fetch (daily_papers + papers API)
- `mergeAndDeduplicate(arxivPapers, hfPapers)`: merge and deduplicate, supplementing all 7 HF fields
- `convertDailyPaper()` / `convertPaper()`: data normalization, output fields consistent with arXiv (including `abstract` + `summary`)
- Fetches data using `curl` commands
- Direct invocation for testing: `node scripts/fetch-huggingface-papers.js`

#### `scripts/deep-analyzer.js`

Multimodal deep analyzer. The analysis flow is a **6-round progressive process**, not a single call:

**Round 1 -- Main Deep Analysis**
- `analyzePaperDeep(paper)`: fetches arXiv HTML full text (up to 500K characters) + downloads candidate images serially; in dual-model mode the secondary model finally selects high-value figures and inserts them into the body. `allImageUrls` stores candidates, while `selectedImageUrls` / `imageUrls` store selected figures
- Loads `prompts/deep-analysis.md`, replaces placeholders, and calls the LLM
- Output includes: score, machine summary, tags, authors and affiliations, snarky review, core summary, method overview and architecture, core innovations, experimental results, detailed description, score rationale, limitations and issues, open source details
- `parseAnalysis(analysis)`: parses analysis text into a structured object. Runtime output headings remain Chinese. `score` is not taken directly from the LLM's original total score under `## 评分`, but is recalculated from eight sub-scores extracted from `## 评分理由`, rounded to 0.1, always overriding the LLM's original total score

**Round 2 -- Open Source Scan (`scanOpensource`)**
- Loads `prompts/opensource-scan.md`
- Extracts GitHub / HuggingFace / ModelScope etc. open source links from paper text
- Supplements the `## Open Source Details` section

**Round 3 -- Review and Rewrite (`reviseAnalysis`)**
- Loads `prompts/gap-fill.md`
- Compares original paper with Round 1 output, checking for omissions, errors, over-inferences
- Generates a revised analysis text, overwriting the original content

**Round 4 -- Table Fix (`checkAndFixTables`)**
- Detects missing Markdown tables in `## Experimental Results`
- If tables are found to be omitted or truncated, triggers LLM supplementation of the complete table

**Round 5 -- Method Section Fix (`checkAndFixMethodSection`)**
- Detects if `## Method Overview and Architecture` is too brief (fewer than 600 Chinese characters, vague expression, fewer than 3 paragraphs)
- If conditions are met, triggers LLM expansion to a 600+ character detailed description

**Round 6 -- Image Selection and Supplement (`applyImageSupplement`, dual-model mode)**
- Loads `prompts/image-supplement.md`
- The secondary model uses the final text and candidate images to select high-value figures, drop low-information figures, and insert selected figures into relevant paragraphs

**API Calls**:
- `callModel(messages, maxTokens)`: retry-wrapped API call encapsulation (up to 3 inner retries, exponential backoff: first 10s, then double)
- `_callModelOnce()`: single API call, each retry independently creates an AbortController and 20-minute timeout
- LLM API requests forcibly set `agent: false`, disabling connection reuse to bypass proxy pollution (avoiding MiMo 403)

**Other Features**:
- Supports automatic proxy detection (environment variables -> macOS `scutil --proxy`)
- Supports pure Node built-in module HTTP CONNECT proxy
- Direct invocation for testing: `node scripts/deep-analyzer.js <arxivId>`

#### `scripts/utils.js`

Node.js common utility module. Referenced by almost all scripts:

**Files and Paths**:
- `writeFileAtomic(filePath, data)`: atomic write (write to temp file then rename)
- `readJsonSafe(filePath)`: safely read JSON, returns `null` if file does not exist
- `ensureDir(dirPath)`: ensure directory exists

**Time Handling**:
- `getBeijingISOString()` / `getBeijingDateString()` / `getBeijingCompactTimestamp()` / `getBeijingLocaleString()`: various Beijing Time formats
- `normalizeToBeijingISOString(isoString)`: converts any ISO string to Beijing Time
- `extractDatePrefix(str)` / `getRecordDate(paper)`: extract date prefix from string or paper object

**Parsing and Text**:
- `stripMd(t)`: strip Markdown formatting marks
- `parseMachineSummary(analysis)`: parse `## Machine Summary` block
- `parseAnalysis(analysis)`: parse full analysis text into a structured object (score, tags, sections, etc.)

**API Protocol Auto-Routing** (core infrastructure):
- `detectApiType(endpoint, model)`: automatically determine OpenAI / Anthropic protocol based on endpoint and model
- `getAnthropicEndpoint(endpoint)`: convert OpenAI-style endpoint to Anthropic-style path
- `buildApiUrl(apiType, endpoint)`: build complete request URL
- `buildRequestBody(apiType, model, messages, maxTokens)`: build request body
- `buildHeaders(apiType, key)`: build request headers
- `getClaudeCodeVersion()`: get local Claude Code CLI version number
- `parseResponseText(apiType, data)`: uniformly parse response text

**Proxy**:
- `detectProxyUrl()`: automatic proxy detection (environment variables -> macOS `scutil --proxy`)
- `createProxyAgent(proxyUrl)`: create HTTP CONNECT proxy agent

**Other**:
- `normalizedId(paper)`: generate unified paper ID
- `backupPapersJson()`: automatic backup of `papers.json`
- `loadPublishedIdsFromBlog(blogRepo)`: scan Hugo blog repository for published paper arXiv IDs (extracts `arxiv.org/abs/XXXX.XXXXX` format links from `content/posts/*.md`)
- `loadPrompt(filePath, replacements)`: load prompt file and replace placeholders

#### `scripts/utils.py`

Python common utility module. Referenced by `publish-to-blog.py`, `publish-wechat-full.py`, `publish-xiaohongshu.py`, `publish-to-feishu.py`:

**Time**:
- `now_bj_iso()` / `now_bj_date()`: Beijing Time ISO string and date string

**Text**:
- `strip_md(t)`: strip Markdown formatting marks (same functionality as JS version)

**Parsing**:
- `parse_machine_summary(analysis)`: parse `## Machine Summary` block (supports `- key: value` format)
- `parse_analysis(analysis)`: parse full analysis text into a structured object (same as JS version)

**Tag System** (core constraints):
- `ALLOWED_TAGS`: standard tag whitelist (approx. 110 Chinese tags), must be consistent with the tag table in `prompts/deep-analysis.md`
- `_normalize_tag(raw)`: normalize tags (add `#` prefix, clean separators)
- `_is_bad_task_tag(tag)`: judge whether tag quality is too poor (snake_case, arXiv category, overly long English, not in whitelist, etc.)
- `_fix_tag(tag)`: map known incorrect tags to correct tags (covering 50+ commonly LLM-invented/English tags)

### 4.3 Publish Scripts

#### `scripts/publish-to-blog.py`

Publish to Hugo blog (GitHub Pages).

**Prerequisites**:
- Hugo blog repository must already be cloned locally to the fixed path: `~/code/github_repos/audio-paper-digest-blog`
- Blog repository uses the PaperMod theme, automatically deployed to GitHub Pages via GitHub Actions
- Blog repository's `content/posts/` directory stores generated Markdown files

**Data Input and Processing**:
- Default reads `data/current/deep-analysis-result.json`
- Supports custom data file path via command line
- Data is processed by `publish_common.py`: sorted by score descending into `scored` (has score) and `unscored` (no score / parse failed) groups
- Each paper's structured fields are extracted via `parse_analysis()` to generate Markdown

**Slug Generation Rules** (`slugify()`):
- Preserve Chinese, Japanese kana, Korean, English, and numbers
- Filter special characters, spaces and consecutive hyphens become single `-`
- Max length 50 characters, truncate at the last `-` if exceeded
- Fallback to `paper` if empty after filtering

**Output Structure**:
```
~/code/github_repos/audio-paper-digest-blog/content/posts/
├── YYYY-MM-DD.md              # Summary page
├── YYYY-MM-DD-<slug-1>.md     # Paper 1 standalone page
├── YYYY-MM-DD-<slug-2>.md     # Paper 2 standalone page
└── ...
```

**Summary Page (`YYYY-MM-DD.md`)**:
- Hugo frontmatter: `title` (date + paper digest), `date`, `tags` (TOP 10 tags), `categories: [Paper Digest]`, `description`, `layout: posts`
- **Today's Overview**: total paper count, hot direction distribution (`█` character simulated bar chart), TOP 10 score leaderboard
- **Leaderboard Table**: rank (medal), paper title (link to standalone page), score, tier (`rankBucket`), main task tag
- **Paper List**: each paper's score emoji, title link, authors and affiliations, snarky review, core summary

**Standalone Page (`YYYY-MM-DD-<slug>.md`)**:
- Hugo frontmatter:
  - `title`: paper title (YAML-safe escaping, handling double quotes, newlines, etc.)
  - `date`: blog date
  - `tags`: parsed tags (without `#`)
  - `categories: [Paper Digest]`
  - `description`: `main task tag | score/10`, falls back to title if absent
  - `hiddenInHomeList: true`
- Body: tag string -> score/tier/tag meta info -> machine score details -> authors and affiliations -> each analysis section -> link back to summary page

**Publish Flow**:
1. Generate `.md` files into blog repository `content/posts/`
2. Stop after local generation and review by default
3. With `--push`, the three-layer review must pass and LLM review must be available before running `git add -A` -> `git commit -m "add: Paper Digest YYYY-MM-DD"` -> `git push origin main`
4. GitHub Actions automatically builds and deploys to Pages
5. Visit: `https://nanless.github.io/audio-paper-digest-blog/posts/YYYY-MM-DD/`

**Parameters**:
- `--date YYYY-MM-DD` (strongly recommended to specify explicitly to avoid date errors across midnight)
- `--skip-push` only generates files without pushing (kept for compatibility; this is now the default)
- `--push` commits and pushes the generated blog files
- `--all` skips `fetchedAt` date filtering and publishes all papers in the input file
- Custom data file path as the last argument

**Date Filtering**:
- The script filters by the `fetchedAt` field by default, only publishing papers matching the `--date` specified date (default today)
- `deep-analysis-result.json` accumulates historical data; date filtering ensures only newly fetched papers for the day are published
- To publish all papers (no filtering), pass `--all` explicitly

**Review Step**:
After generating `.md`, a three-layer review is automatically executed (code regex check -> LLM text review -> multimodal image review). Paper standalone pages use `ThreadPoolExecutor(max_workers=3)` for concurrent review; common issues are automatically fixed before writing to file. Local generation/preview skips LLM review when the API is not configured; formal `--push` requires LLM review to be available, otherwise publishing stops.

Code-level auto-fix covers:
1. Unescaped HTML-like tags (`<S>`, `<E>`, `<task>`, etc.) → wrap in backticks
2. Unconverted LaTeX `$...$` formulas → convert to `\(...\)` format
3. Non-standard image references → convert to standard Markdown image syntax
4. Overly long base64 data URIs → auto-truncate
5. YAML frontmatter double commas → auto-fix
6. Markdown table sub-header rows (first 3 columns empty) → delete the row
7. Unclosed LaTeX `$ \mathcal{L}_D \(` → convert to `\(\mathcal{L}_D\)`
8. Malformed LaTeX brackets (`\)\mathcal{L}_X\(`) → unify to `\(\mathcal{L}_X\)`
9. Double-backslash LaTeX (`\(\\mathcal{L}_X\)` → fix to `\(\mathcal{L}_X\)`)

LLM-level fix: Issues where LLM review returns `auto_fixable: true` are fixed via simple text replacement per `fix_instruction`. Blog review and Xiaohongshu one-liners share `call_publish_llm_api()` in `publish_common.py`, keeping protocol routing aligned with the Node side.

**Important Limitation**: `fetchedAt` is the fetch time, not the paper's `published` date on arXiv. Please explicitly specify `--date` when running across midnight.

#### `scripts/publish-wechat-full.py`

Generate WeChat Official Account article drafts.

- Default data source: `data/current/deep-analysis-result.json` (supports custom path via command line)
- Filters by `fetchedAt == --date` by default (default date is today in Beijing time); pass `--all` to use all papers in the input file
- WeChat Official Account `APP_ID` / `APP_SECRET` read from environment variables
- Supports `--dry-run`: only generates the local preview HTML; does not fetch a token, upload images, or create drafts
- **Image Upload**: upload only in-body Markdown images and figures listed in `selectedImageUrls` -> upload to WeChat CDN -> replace with WeChat URLs. Cache stored in `/tmp/wechat-image-cache.json`; raw `allImageUrls` candidates are not uploaded or published directly
- **Auto Split into Parts**: single draft limit is approximately 48000 characters (HTML); automatically split into multiple drafts if exceeded
  - Only Part 1 contains "Today's Overview"
  - Each Part title: `Speech/Music/Audio Paper Digest YYYY-MM-DD | part N | M papers`
- Generate preview HTML: `data/current/wechat-preview-YYYY-MM-DD.html`

#### `scripts/publish_common.py`

Python publish common module. Uniformly encapsulates data loading, score sorting, tag extraction, and formatting tools, eliminating duplicate logic across `publish-to-blog.py` / `publish-wechat-full.py` / `publish-xiaohongshu.py` / `publish-to-feishu.py`.

Main functions:
- `load_papers(data_file)`: load paper list from JSON
- `score_and_sort(papers)`: parse analysis results and sort by score descending; prefer existing `parsed` data to avoid re-parsing overwriting manual corrections
- `extract_top_tags(papers, limit)`: extract main task tags and count frequencies
- `extract_all_tags(papers, limit)`: extract all tags (deduplicated), used for blog tag cloud
- `extract_one_liner(pa)`: extract a one-sentence highlight from analysis results, preferring innovation points or core contribution sentences
- `score_emoji(score)` / `format_medal(index)`: score emoji and medal formatting
- `build_paper_meta(pa, aurl)`: concatenate score/tier/tag meta info
- `parse_cli_args(argv, defaults)`: generic command line argument parsing, reused by each publish script
- `call_publish_llm_api()`: shared publish-time LLM API client for OpenAI / Anthropic / MiMo / Kimi / DeepSeek routing; `required=True` can block formal publishing on failure

#### `scripts/publish-xiaohongshu.py`

Generate Xiaohongshu (Little Red Book) copy.

- Default data source: `data/current/deep-analysis-result.json`
- Supports `--top N` curated version (default TOP 5, commonly `--top 3`) and `--all` full summary version
- Supports `--date YYYY-MM-DD` to specify date
- If no paper matches `fetchedAt == --date`, the script stops instead of falling back to historical papers
- Outputs to `data/current/xiaohongshu-YYYY-MM-DD-<suffix>.md`
- **One-sentence introduction per paper is generated by calling the MiMo LLM API** (anthropic protocol, `session.trust_env = False` to bypass proxy); input prioritizes `parsed.summary/results/limitations/opensource` plus primary tags, then falls back to abstracts; local `extract_one_liner()` is used when LLM generation fails
- Automatically cleans Markdown formatting and academic prefixes
- Includes emoji heat indicators: 🔥>=8 points, ✅>=6 points, 📝<6 points (consistent with blog and WeChat)
- Under 1000 words, no tags or `---` separators are output; open source information is clearly labeled

#### `scripts/xiaohongshu-publisher.py`

Xiaohongshu auto-publish script (calls Xiaohongshu Web API, unofficial interface).

- `--login`: scan QR code to log in, save cookie to local cache file
- `--publish`: publish current date TOP 3 curated post (default)
- `--all`: publish all papers (one post per paper)
- `--date YYYY-MM-DD`: specify date
- Default date uses Beijing time; screenshots are matched by `~/Pictures/微信图片_YYYYMMDD*.png`
- Cookie persists after login, no need to scan QR code again next time
- Corresponding npm scripts: `npm run xhs-login`, `npm run xhs-publish`, `npm run xhs-publish-all`

#### `scripts/publish-to-feishu.py`

Generate Feishu (Lark) documents.

**Credential Reading**:
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` read from environment variables (consistent with other publish channels, all unified in `the `.env` file in the project root`)

**Data Input**:
- Uniformly reads `data/current/deep-analysis-result.json` (consistent with other publish channels)
- Supports `--date YYYY-MM-DD` to specify date
- Filters by `fetchedAt == --date` by default (default date is today in Beijing time); pass `--all` to use all papers in the input file
- Supports `--dry-run`: only reports the document title and block counts; does not fetch a token or create a Feishu document

**Implementation Characteristics**:
- Python implementation, reuses `publish_common.py` for data loading and score sorting; content generation prefers existing `parsed` data and only reparses `analysis` when needed
- Calls Feishu docx API to create documents and write content blocks
- Markdown converted line-by-line to Feishu block types: heading1(3)/heading2(4)/heading3(5)/text(2)/bullet(12)/ordered(13)/divider(22)
- Up to 20 blocks per batch, written in batches

**Feishu docx API Call Flow**:
1. `auth/v3/tenant_access_token/internal` to obtain tenant_access_token
2. `docx/v1/documents` to create a new document
3. `docx/v1/documents/{id}/blocks` to get the root block ID
4. `docx/v1/documents/{id}/blocks/{root_id}/children` to write content in batches

### 4.4 Auxiliary Scripts

#### `scripts/backfill_papers.py`

Backfill paper IDs in the background (no analysis).
- Fetch arXiv 7 categories (30 papers each) and HF Papers (last 7 days)
- Rate-limit resilient design: request timeout 30s, exponential backoff on rate-limit, early stop after 20 consecutive known IDs
- Writes to `data/current/papers.json`
- Additional output: `data/backfill-result.json`
- Independent log: not created by default; when file logs are enabled, appends to `logs/backfill.log`
- Dependency: `requests` (Python third-party library)

#### `scripts/backup-data.sh`

Data backup shell script.

---
