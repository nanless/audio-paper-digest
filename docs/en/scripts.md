# Script Responsibilities

## Script Responsibilities (Complete Script Reference)

> **Runtime precondition**: every project script must run outside the sandbox. Direct Node/Python scripts use their shared environment loaders to reject `CODEX_SANDBOX` before business operations; `run-full-fetch.sh` and `scripts/backup-data.sh` have the same entry check. Unit-test module imports do not trigger it.

### 4.1 Main Pipeline Scripts

#### `scripts/full-fetch.js`

Core data-workflow entry point. Executes auto-archive -> dedup -> fetch -> filter -> deep analysis -> incremental save. It does not create visual tasks. Publish the digest index and every paper page first; post-publication TOP 10 and digest-image tasks start only after remote OID verification.

Fetching atomically checkpoints each arXiv category and HuggingFace with paper count and stable content SHA, so tampering refetches only that source. Checkpoint/raw/decisions/filtered artifacts must share candidate/source/blog fingerprints and a Beijing batch date. Filtering requires complete source coverage; healthy raw candidates can resume from zero decisions, while filter configuration changes refilter without refetching.

All configurations are read from `scripts/config.js`, with project-root `.env` overrides:
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

Besides success/failure counts, the final summary groups results by `analysisSource` (HTML, PDF, provided full text, or abstract fallback). Abstract fallback is not treated as equivalent to full-text analysis.

Full reanalysis.
- Default data source: `data/current/deep-analysis-result.json` (supports custom file path via command line, compatible with old-format pure arrays)
- Calls `deep-analyzer.js` for **all** papers in the file
- Default concurrency matches `ANALYSIS_CONFIG.concurrency` (default 3), adjustable via `--concurrency N` or `PD_REANALYZE_CONCURRENCY` in the project `.env`
- **Saves intermediate results every 5 papers** (save interval auto-adjusted in concurrent mode), **only successful results overwrite old data**; saves also sync `papers.json.digestStatus` from the current persisted results
- On startup, checks whether `PAPER_ANALYZER_API_KEY`, `PAPER_ANALYZER_MODEL`, `PAPER_ANALYZER_ENDPOINT` are set; exits directly if any are missing

#### `scripts/reanalyze-selected.js`

Reanalyzes specified IDs with the fixed default concurrency of 3, replaces old analyses only on success, and syncs `digestStatus`. When a target did not previously use the current scoring contract, success reconciles the corresponding historical failure in `stats.reanalyzed` / `stats.reanalyzeFailed`. It also records `selectedReanalyzed`, `selectedReanalyzeFailed`, and `selectedReanalyzeAt`; rerunning an already-current result does not inflate recovered counts.

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
- Analyzes unanalyzed papers one by one, saves success/failure results, and syncs `papers.json.digestStatus`, convenient for retrying remaining papers after `full-fetch.js` is interrupted

#### `scripts/analyze-single-paper.js`

Analyze a single paper and merge it into the results.

**Usage**: `node scripts/analyze-single-paper.js <arxiv_id> [--force]`

- Reads metadata from `data/current/papers.json`
- Calls `deep-analyzer.js` for analysis, then appends to `deep-analysis-result.json`
- Skips if the paper already exists in the results by default; `--force` reanalyzes and replaces the old result
- Compatible with old-format pure array data, automatically converts to new object format on save
- Syncs `papers.json.digestStatus` after a successful save; failed analysis also writes `analysis_failed` without modifying `deep-analysis-result.json`

#### `scripts/validate-data-files.js`

Read-only validation for current runtime data.
- Checks `data/current/papers.json`, `data/current/raw-candidates.json`, `data/current/filtered-papers.json`, and `data/current/deep-analysis-result.json` by default
- Also checks `data/current/filter-decisions.json`; validates digest/filter metadata, paper IDs, `sourceHealth`, `documentType`, `scoringRubricVersion`, all eight dimension ranges, total-score consistency with the capped subtotal, deep-analysis statistics, image fields, and complete filter-decision coverage
- Does not modify any data; prints errors and exits non-zero on failure
- npm entry: `npm run validate:data`

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

**Runtime Data Paths (`FILES`)**

`Config.FILES` centrally registers the core JSON files read/written by the current workflow: `papers` / `rawCandidates` / `filterDecisions` / `filteredPapers` / `deepAnalysisResult` / `analyzed`, plus the legacy paths that still need compatibility. New scripts should reuse these constants instead of hand-writing `data/current/*.json` paths.

**Analysis Configuration (`ANALYSIS_CONFIG`)**

| Config Item | Default | Env Override | Description |
|--------|--------|-------------|------|
| Concurrency | 3 | `PD_ANALYSIS_CONCURRENCY` | Number of papers analyzed in parallel |
| Outer retries | 2 | `PD_ANALYSIS_MAX_RETRIES` | Retries per paper at the analysis-engine level |
| Outer retry delay | 3000ms | -- | Outer retry interval |
| API overall timeout | 20 active minutes | -- | Excludes system-sleep and long-suspension wall-clock jumps |
| API inner retries | 3 | -- | Retries per inner deep-analyzer call |
| API inner backoff base | 5000ms | -- | Exponential backoff: first 5s, then double |
| max_tokens | 64000 | -- | LLM output length limit |
| temperature | 0.7 | -- | LLM sampling temperature |
| Image download timeout | 60s | `PD_IMAGE_DOWNLOAD_TIMEOUT_MS` | Per-image timeout; failures still use the configured retry loop |
| Single-image raw-size limit | 6MB | `PD_IMAGE_MAX_BYTES` | Byte-size guard after download |
| Single-image base64 limit | 8M chars | `PD_IMAGE_MAX_BASE64_CHARS` | Base64 conversion limit per image |
| Per-paper total image base64 limit | 20M chars | `PD_IMAGE_TOTAL_BASE64_CHARS` | Prevents oversized multi-image model payloads |
| Full-text limit | 500K chars | -- | arXiv HTML body truncation limit |
| arXiv HTML/image discovery timeout | 60s | `PD_ARXIV_FETCH_TIMEOUT_MS` | HTML body and image-list request timeout |
| arXiv PDF fallback timeout | 180s | `PD_ARXIV_PDF_TIMEOUT_MS` | Per-PDF timeout when HTML is unavailable |

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
| Blog repo path | `~/code/github_repos/audio-paper-digest-blog` | Overridable via `PAPER_DIGEST_BLOG_REPO` in the project `.env` |
| Content directory | `content/posts` | Hugo content directory |
| basePath | `/audio-paper-digest-blog` | Site subpath |
| WeChat draft char limit | 48000 | Per-draft HTML character limit |

**Archive Configuration (`ARCHIVE_CONFIG`)**

| Config Item | Default | Description |
|--------|--------|------|
| Max backups | 10 | `deep-analysis-result` bak file retention count |
| File logs | Enabled by default | Can be forced off by setting `PD_DISABLE_FILE_LOGS=1` or `PAPER_DIGEST_DISABLE_FILE_LOGS=1` in the project `.env` |
| Log count/size limits | None | No count, total-size, or per-file-size limit; old logs are not cleaned automatically |

Referenced by all core scripts.

#### `scripts/analysis-engine.js`

Unified analysis engine. Encapsulates the following functionality, eliminating duplicate logic across `full-fetch.js` / `deep-analysis-only.js` / `batch-analyze.js` / `reanalyze.js` / `analyze-single-paper.js`:

- `analyzePaperWithRetry(paper, options)`: single-paper analysis (with retry + auto-parse)
- `analyzeBatch(papers, options)`: batch analysis (supports concurrency control + incremental save callbacks); callback failures propagate to the entry point instead of being counted as successful analysis
- `mergeAndSaveResults(newResults, filePath, extraData)`: deduplicate by ID and save, **with built-in failure protection** (papers with an existing successful analysis will not be overwritten by a failed result without analysis)
- Success requires every mandatory version-1 `analysisManifest` stage to be terminal. Failure merges retain an older valid body while overlaying the new checkpoint, recovery image manifest, and latest-attempt error
- Lock owners carry random tokens and local PID liveness checks, so an old owner cannot delete a replacement lock and a live process is not reclaimed merely because its lock is old

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

Multimodal deep analyzer. The analysis flow is an **up-to-8-round progressive process**, not a single call:

**Round 1 -- Main Deep Analysis**
- `analyzePaperDeep(paper)`: fetches arXiv HTML full text (up to 500K characters) and preselects candidate images. Dual-model mode downloads candidate images serially and lets the secondary model output a JSON insertion plan for high-value figures; single-model mode only stores candidate image metadata. `allImageUrls` stores candidates, while `selectedImageUrls` / `imageUrls` store selected figures
- Loads `prompts/deep-analysis.md`, replaces placeholders, and calls the LLM
- Output includes: document type, score, machine summary, tags, authors and affiliations, snarky review, core summary, method overview and architecture, core innovations, experimental results, detailed description, score rationale, limitations and issues, open source details
- `parseAnalysis(analysis)`: parses the analysis, normalizes `document_type`, and marks new results with `type-aware-v1`. `score` is recalculated only when all eight dimensions are complete, unique, use the correct denominators, and contain finite in-range values; otherwise a contract error blocks saving and publishing

**Round 2 -- Open Source Scan (`scanOpensource`)**
- Loads `prompts/opensource-scan.md`
- Extracts GitHub / HuggingFace / ModelScope etc. open source links from paper text
- Supplements the runtime `## 开源详情` section

**Round 3 -- Review and Rewrite (`reviseAnalysis`)**
- Loads `prompts/gap-fill.md`
- Compares original paper with Round 1 output, checking for omissions, errors, over-inferences
- Generates a revised analysis text, overwriting the original content

**Round 4 -- Table Fix (`checkAndFixTables`)**
- Loads `prompts/table-fill.md`
- Detects missing Markdown tables in the runtime `## 实验结果` section
- If tables are found to be omitted or truncated, triggers LLM supplementation of the complete table

**Round 5 -- Method Section Fix (`checkAndFixMethodSection`)**
- Loads `prompts/method-fill.md`
- Detects if the runtime `## 方法概述和架构` section is too brief (fewer than 600 Chinese characters, vague expression, fewer than 3 paragraphs)
- If conditions are met, triggers LLM expansion to a 600+ character detailed description

**Round 6 -- Final Structural Repair (`repairMissingAnalysisSections`, conditional)**
- Uses `scripts/analysis-contract.js` to check all 13 required sections
- When sections are missing, loads `prompts/structure-repair.md` with exact missing titles and prior validation feedback; complete reports skip this round

**Round 7 -- Type-aware Scoring Audit (`auditTypeAwareScoring`)**
- Loads `prompts/scoring-audit.md`; the primary model returns JSON only
- Re-audits document type, confidence, eight scores, and unique deduction ownership; cross-dimension failures are fed into the next local attempt
- Non-theory papers with no released core artifact are normalized to 0.5 for an explicit promise, 0.2 for demo-only, or 0 otherwise; theory retains the judgment based on public proof material
- Code updates scoring sections and machine-summary score fields without rewriting body text

**Round 8 -- Image Selection and Insertion Plan (`applyImageSupplement`, dual-model mode)**
- Loads `prompts/image-supplement.md`
- The secondary model uses the final text and candidate images to select high-value figures, drop low-information figures, and output JSON only
- `[secondary]` logs record paper ID, model, protocol, endpoint/key source, candidate/download counts, safe image labels and payloads, active request duration, response parse status, exact anchor matches, rejection reasons, and inserted figures; secrets are never printed
- The insertion plan accepts only `anchor`, lead, and explanation. Legacy `replacement` / `rewrite` fields are ignored
- Code inserts at most four figures in secondary-model priority order. Every plan needs a non-empty anchor that exactly matches the target section; empty, unmatched, and over-limit plans are rejected instead of falling back to the section end. Primary-model sentences are never replaced, and candidate numbers are not treated as source Figure numbers
- The shared complete contract runs again after merging. An invalid plan is discarded while the audited primary-model text is retained
- Generic `图N` alts without real captions and `selectedImageUrls` are normalized to final body order, preventing candidate numbers from becoming out-of-order display numbers
- Only an object with strict `insertions: []` becomes `no_high_value_images`. Schema errors, malformed JSON, total image-download failure, and contract damage remain non-terminal recovery states instead of masquerading as success

**Stage recovery**: `analysisManifest` persists each stage, `analysisCheckpoint` stores the intermediate body, and `analysisRecoveryImageManifest` stores figure recovery metadata. Failed merges validate an older body independently of the latest failed manifest, so repeated failures cannot erase usable content. Force-reanalyzing an older successful record clears primary and downstream completion markers because no checkpoint exists; a normal failed run resumes at the first incomplete stage.

**Mandatory Codex visual-asset stage**
- After every blog page is pushed and remote `main` is verified, `visual-summary-integration.js` creates one `infographic` task for each final-score TOP 10 paper, with normalized-ID tie breaking
- `npm run visual:render:debug -- --spec SPEC.json --output OUTPUT.png [--illustration text-free-art] [--reference method/architecture-figure] [--result-reference key-result-figure]` is the retained deterministic local debug/fallback renderer, not the default final-asset path. The default flow uses built-in `image_gen` to create the complete text-bearing composition and requires visual accuracy review before record. The Pillow fallback can still compose an approximately `2160x4552` paper infographic or digest cover, supports structured `diagram.columns/nodes/edges` Chinese redraws, reference captions, basic charts/metrics, and the 8 MiB gate
- Register it with `record --paper ID --kind infographic --file PNG --token TOKEN`. The tool validates the PNG, minimum dimensions, portrait ratio, size, SHA, and task token before archiving it under manifest-ranked directories `data/archive/<date>/visual-summaries/01-<paper>/` through `10-<paper>/`; concurrent completion order never affects numbering
- `digest-cover-state.js plan --date YYYY-MM-DD [--category CATEGORY]` deterministically derives the batch title, hot-direction counts, and TOP 10 ranking; conference flows must pass the same category used for blog generation. Codex uses `prompts/digest-cover.md` to create one cover and registers it under `data/archive/<date>/digest-cover/cover.png`
- A later plan validates PNG bytes and SHA before migrating legacy assets from `data/current/`; conflicting archive content is rejected
- For historical batches whose old receipt lacks the modern remote-OID field, run `npm run visual:archive -- --date YYYY-MM-DD` and `npm run cover:archive -- --date YYYY-MM-DD`. These maintenance commands only move verified existing assets and update manifests; they never create tasks or forge publication receipts. Non-TOP10 legacy cards use `unranked-<paper>` directories
- The manifests invalidate independently. Paper-analysis or visual-prompt changes rerun only affected infographics; paper-set, score, primary-task, or cover-prompt changes rerun only the cover. Nonzero `visual:status` or `cover:status` resumes only pending, failed, damaged, or stale assets
- Project scripts plan, validate, copy, and checkpoint assets but never call an image API. Editorial images must not be presented as original paper figures or invent authors, claims, measurements, or ranking entries; the cover must not render arXiv IDs
- Images do not enter or block the completed blog generation/review/push transaction; plan/status refuses to run without the remotely verified publication receipt

Stage fingerprints bind the actual truncated primary input, the pre-scoring structure-repair body, and image candidates/download hashes/pre-image body. A change invalidates only that stage and downstream work. Paper payloads are merged only under the shared per-paper lock; batch/final statistics never rewrite cumulative stale paper snapshots.

**API Calls**:
- `callModel(messages, maxTokens)`: retry-wrapped API call encapsulation (up to 3 inner retries, exponential backoff: first 10s, then double)
- `_callModelOnce()`: single API call, each retry independently creates an AbortController and 20-minute timeout
- LLM API requests forcibly set `agent: false`, disabling connection reuse to bypass proxy pollution (avoiding MiMo 403)

**Other Features**:
- Reads proxy variables only after project-root `.env` isolation; inherited shell/IDE proxies and macOS `scutil` are not used
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
- `parseMachineSummary(analysis)`: parse runtime `## 机器摘要` block
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
- `detectProxyUrl()`: read only proxy variables isolated and loaded by the project environment loader
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
- `parse_machine_summary(analysis)`: parse runtime `## 机器摘要` block (supports `- key: value` format)
- `parse_analysis(analysis)`: parse full analysis text into a structured object (same as JS version)

**Tag System** (core constraints):
- `ALLOWED_TAGS`: standard tag whitelist (approx. 110 Chinese tags), must be consistent with the tag table in `prompts/deep-analysis.md`
- `_normalize_tag(raw)`: normalize tags (add `#` prefix, clean separators)
- `_is_bad_task_tag(tag)`: judge whether tag quality is too poor (snake_case, arXiv category, overly long English, not in whitelist, etc.)
- `_fix_tag(tag)`: map known incorrect tags to correct tags (covering 50+ commonly LLM-invented/English tags)

### 4.3 Publish Scripts

#### `scripts/generate-blog.py` / `scripts/review-blog.py` / `scripts/push-blog.py`

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
1. `generate-blog.py` only generates and installs Markdown, then writes a generation manifest. It never calls an LLM, commits, or pushes.
2. `review-blog.py` reviews that manifest with code, strict LLM, multimodal image, and Hugo gates. A failed first pass stores a manifest/base-HEAD/per-file-hash-bound failure set; a retry reviews only modified failed pages when all reuse invariants still hold, otherwise it falls back to a full review. Success writes a per-file SHA-256 review receipt; it never commits or pushes.
3. `push-blog.py` only verifies that receipt against the current files, then stages the exact manifest, commits with a detailed Chinese message, pushes `origin HEAD:main`, and verifies the remote OID. It never regenerates or re-reviews.

**Runtime requirement**: the three entry points and compatibility `publish-to-blog.py` require an external runtime. They reject the reliable `CODEX_SANDBOX` marker; the elevation wrapper preserves the network-disabled marker, so it cannot independently identify a sandbox. Re-run the same stage outside the sandbox; never skip review or fabricate a receipt.

**Push boundary**: the review receipt binds the blog `main` baseline at review time and every file SHA-256. `push-blog.py` may create only this manifest's commit from that baseline, or retry the same receipt-recorded publication commit. Manual commits, worktree edits, or a shifted baseline block the push; generation also refuses to overwrite manual Git edits to same-date pages.

All stages share both per-date and repository-global locks. Generation journals each page; review checkpoints the SHA actually read; push compares staged index blobs/deletions with the receipt after staging and before commit so different dates cannot contaminate shared Git state.

**Parameters**: all three scripts accept `--date YYYY-MM-DD`. Only `generate-blog.py` accepts `--all`, `--category`, repeatable `--exclude-id <arXiv ID>`, and a custom data path. Every excluded ID must match the date-filtered batch; exclusions affect only the generation snapshot and never mutate analysis data. `publish-to-blog.py --push` is rejected to prevent the combined workflow from returning.

**Date Filtering**:
- The script filters by the `fetchedAt` field by default, only publishing papers matching the `--date` specified date (default today)
- `deep-analysis-result.json` accumulates historical data; date filtering ensures only newly fetched papers for the day are published
- To publish all papers (no filtering), pass `--all` explicitly

**Review Step**:
Generation reparses scoring from `analysis` and compares it with cached `parsed` data and the rubric version. The separate review step uses 5 workers by default, configurable through `PD_BLOG_REVIEW_CONCURRENCY`, and validates image payload/context alignment plus HTTPS peers. Any indeterminate strict review blocks receipt creation. Push fails closed when the receipt is absent or any reviewed file hash changed.

The shared publish LLM client uses a standard-library explicit empty proxy handler, keeping LLM calls direct and avoiding `requests` compatibility issues or fetch-proxy contamination.

Code-level auto-fix covers:
1. Unescaped HTML-like tags (`<S>`, `<E>`, `<task>`, etc.) → wrap in backticks
2. Unconverted LaTeX `$...$` formulas → convert to `\(...\)` format
3. Non-standard image references → convert to standard Markdown image syntax
4. Overly long base64 data URIs → auto-truncate
5. YAML frontmatter double commas → auto-fix
6. Unclosed LaTeX `$ \mathcal{L}_D \(` → convert to `\(\mathcal{L}_D\)`
7. Malformed LaTeX brackets (`\)\mathcal{L}_X\(`) → unify to `\(\mathcal{L}_X\)`
8. Double-backslash LaTeX (`\(\\mathcal{L}_X\)` → fix to `\(\mathcal{L}_X\)`)

Markdown tables may legitimately use empty leading group cells for continuation rows. Code review preserves those rows instead of treating them as removable subheaders. LLM advice that ordinary model names or technical terms require backticks is filtered as a style false positive.

LLM-level fix: Issues where LLM review returns `auto_fixable: true` are fixed via simple text replacement per `fix_instruction`. Blog review and Xiaohongshu one-liners share `call_publish_llm_api()` in `publish_common.py`, keeping protocol routing aligned with the Node side; Anthropic-compatible requests dynamically read local `claude --version` for `User-Agent`, falling back to the default version if unavailable.

**Important Limitation**: `fetchedAt` is the fetch time, not the paper's `published` date on arXiv. Please explicitly specify `--date` when running across midnight.

#### `scripts/publish-wechat-full.py`

Generate WeChat Official Account article drafts.

- Default data source: `data/current/deep-analysis-result.json` (supports custom path via command line)
- Filters by `fetchedAt == --date` by default (default date is today in Beijing time); pass `--all` to use all papers in the input file
- WeChat Official Account `APP_ID` / `APP_SECRET` are read from the project `.env`
- Supports `--dry-run`: only generates the local preview HTML; does not fetch a token, upload images, or create drafts
- **Image Upload**: upload only in-body Markdown images and figures listed in `selectedImageUrls` -> upload to WeChat CDN -> replace with WeChat URLs. Cache stored in `/tmp/wechat-image-cache.json`; raw `allImageUrls` candidates are not uploaded or published directly
- **Auto Split into Parts**: single draft limit is approximately 48000 characters (HTML); automatically split into multiple drafts if exceeded
  - Only Part 1 contains "Today's Overview"
  - Each Part title: `Speech/Music/Audio Paper Digest YYYY-MM-DD | part N | M papers`
- Generate preview HTML: `data/current/wechat-preview-YYYY-MM-DD.html`

#### `scripts/publish_common.py`

Python publish common module. Uniformly encapsulates data loading, score sorting, tag extraction, and formatting tools, eliminating duplicate logic across `publish-to-blog.py` / `publish-wechat-full.py` / `publish-xiaohongshu.py` / `publish-to-feishu.py`.

Main functions:
- `load_papers(data_file)`: load paper list from JSON; when no path is passed, it prefers `data/current/deep-analysis-result.json` and falls back to the legacy `data/deep-analysis-result.json` only when the current file is missing; the root must be either an array or `{papers: [...]}`, otherwise it fails immediately
- `score_and_sort(papers)`: parse analysis results and sort by score descending; prefer existing `parsed` data to avoid re-parsing overwriting manual corrections
- `extract_top_tags(papers, limit)`: extract main task tags and count frequencies
- `extract_all_tags(papers, limit)`: extract all tags (deduplicated), used for blog tag cloud
- `extract_one_liner(pa)`: extract a one-sentence highlight from analysis results, preferring innovation points or core contribution sentences
- `score_emoji(score)` / `format_medal(index)`: score emoji and medal formatting
- `build_paper_meta(pa, aurl)`: concatenate score/tier/tag meta info
- `parse_cli_args(argv, defaults)`: generic command line argument parsing, reused by each publish script
- `call_publish_llm_api()`: shared publish-time LLM API client for OpenAI / Anthropic / MiMo / Kimi / DeepSeek routing; `required=True` can block formal publishing on failure

#### `scripts/path_config.py`

Shared path configuration for Python publish/maintenance scripts. It exposes constants such as `PROJECT_ROOT`, `DATA_DIR`, `CURRENT_DIR`, `LOGS_DIR`, `PAPERS_FILE`, and `DEEP_ANALYSIS_RESULT_FILE`, plus path helpers such as `resolve_deep_analysis_result_path()`, `xiaohongshu_markdown_path()`, `wechat_preview_path()`, and `backfill_result_path()`. New Python scripts should not hand-write default `data/current/*.json` or publish-output paths again.

#### `scripts/publish-xiaohongshu.py`

TOP-N one-liners are generated with bounded concurrency (default 5, configurable from 1 to 5 through `PD_XIAOHONGSHU_ONELINER_CONCURRENCY`). Results are restored to ranking order, and a failed request falls back locally for that paper only.

Generate Xiaohongshu (Little Red Book) copy.

Each successful one-liner is stored under a per-date lock and bound to analysis, prompt, model/endpoint configuration, and sanitation fingerprints. Corrupt cache files are quarantined and rebuilt; fallbacks or changed inputs rerun only that paper. `--date` is strict `YYYY-MM-DD`; this command generates copy only.

- Default data source: `data/current/deep-analysis-result.json`
- Supports `--top N` curated version (default TOP 5, commonly `--top 3`) and `--all` full summary version
- Supports `--date YYYY-MM-DD` to specify date
- If no paper matches `fetchedAt == --date`, the script stops instead of falling back to historical papers
- Outputs to `data/current/xiaohongshu-YYYY-MM-DD-<suffix>.md`
- **One-sentence introduction per paper is generated by the publishing-stage LLM API** (via `publish_common.py` protocol routing and standard-library explicit no-proxy transport); input prioritizes `parsed.summary/results/limitations/opensource` plus primary tags, then falls back to abstracts; local `extract_one_liner()` is used when LLM generation fails
- Automatically cleans Markdown formatting and academic prefixes
- Includes emoji heat indicators: 🔥>=8 points, ✅>=6 points, 📝<6 points (consistent with blog and WeChat)
- Under 1000 words, no tags or `---` separators are output; open source information is clearly labeled

#### `scripts/xiaohongshu-publisher.py`

Xiaohongshu auto-publish script (calls Xiaohongshu Web API, unofficial interface).

- `--login`: scan QR code to log in, save cookie to local cache file
- `--publish`: publish current date TOP 5 curated post by default (reads the `top5` copy; generate copy with `--top 3` if you want TOP 3)
- `--all`: publish the current date full-summary post once (reads one `all` summary copy; not one post per paper)
- `--date YYYY-MM-DD`: specify date
- Default date uses Beijing time; screenshots are matched by `~/Pictures/微信图片_YYYYMMDD*.png`
- Cookie persists after login, no need to scan QR code again next time
- Corresponding npm scripts: `npm run xhs-login`, `npm run xhs-publish`, `npm run xhs-publish-all`

#### `scripts/publish-to-feishu.py`

Generate Feishu (Lark) documents.

**Credential Reading**:
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` are read from the project `.env` (consistent with other publish channels, all unified in `the `.env` file in the project root`)

**Data Input**:
- Uniformly reads `data/current/deep-analysis-result.json` (consistent with other publish channels)
- Supports `--date YYYY-MM-DD` to specify date
- Filters by `fetchedAt == --date` by default (default date is today in Beijing time); pass `--all` to use all papers in the input file
- Supports `--dry-run`: only reports the document title and block counts; does not fetch a token or create a Feishu document

**Implementation Characteristics**:
- Python implementation, reuses `publish_common.py` for data loading and score sorting; publishing always validates a fresh parse of `analysis` against cached `parsed` data before using it
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
- Uses the unified per-run log and no longer appends a duplicate `logs/backfill.log`
- Uses the same `.lock` directory and `generation` protocol as Node when merging `papers.json`, preventing a stale post-fetch snapshot from overwriting concurrent analysis status
- Dependency: `requests` (Python third-party library)

#### `scripts/backup-data.sh`

Data backup shell script.

---
