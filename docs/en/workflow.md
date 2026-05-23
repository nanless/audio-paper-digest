# Main Workflow Explained

## Main Workflow Explained

Main entry: `./run-full-fetch.sh` (or `node scripts/full-fetch.js` / `npm run fetch`)

### 3.1 Auto-Archive

At startup, the script checks the following files under `data/current/`:
- `deep-analysis-result.json`
- `filtered-papers.json`
- `analyzed.json`

**Note: `papers.json` is the deduplication database and is NOT moved to archive; it accumulates continuously.**

Archive rules (evaluated per file):
1. Read the timestamp field from the file (supports `timestamp` / `lastUpdated` / `deepAnalysisCompletedAt` / `previousTimestamp`)
2. If the date is **earlier than today (Beijing Time)** and the file does not yet exist under `data/archive/<date>/`, **copy** it to the archive directory
3. After a successful copy, **delete** the original file to ensure a fresh start each day
4. If an identically named file already exists in the archive directory, skip it (do not overwrite)

Additionally, if `deep-analysis-result.json` exists and already contains data, it is automatically backed up to `data/archive/deep-analysis-result-<timestamp>.bak.json` before archiving, and old backups are automatically cleaned up (keeping the most recent 10).

### 3.2 arXiv Fetching

Fetch the latest papers from 7 categories:

| Category ID | Name | Priority |
|---------|------|--------|
| `eess.AS` | Audio and Speech | core |
| `cs.SD` | Sound | core |
| `eess.SP` | Signal Processing | core |
| `cs.CL` | Computation and Language | supplement |
| `cs.LG` | Machine Learning | supplement |
| `cs.AI` | Artificial Intelligence | supplement |
| `cs.MM` | Multimedia | supplement |

Fetch parameters:
- API: `export.arxiv.org/api/query`, sorted by `submittedDate` descending, `max_results=100` per category
- User-Agent: `Mozilla/5.0 (compatible; PaperDigest/1.0)`
- Up to **20 retries** per category, exponential backoff: first retry 3s, then double (`2^attempt * 3000ms`, attempt starts at 1)
- Extra wait on HTTP 429 rate-limit: first 10s, then double (`2^attempt * 5000ms`, attempt starts at 1, capped at 60s)
- **Early stop**: if 20 consecutive already-known IDs are encountered (existing in `papers.json`), stop fetching that category
- **5-second delay** between categories

Deduplication logic: `deduplicatePapers()` deduplicates by `arxivId`, with core categories (eess.AS / cs.SD / eess.SP) taking precedence over supplement categories.

### 3.3 HuggingFace Papers Fetching

Dual-source fetching via `fetch-huggingface-papers.js`:

1. **`/api/daily_papers`**: Curated daily papers, including rich fields such as `ai_summary`, `githubRepo`, `upvotes`, `ai_keywords`, `projectPage`, `githubStars`, `discussionId`. Paginated (`limit=100`, up to 20 pages) until the last 7 days are covered.
2. **`/api/papers`**: Latest papers supplement, covering the last 1-2 days, used to backfill papers not included in daily_papers.

Filtering:
- Only keep papers from the last 7 days (`published >= today-7 days`)
- Exclude already-known IDs
- Sort by `upvotes` descending

Technical implementation: data is fetched using `curl` commands (to avoid Node fetch compatibility issues in proxy environments), and returned data is normalized to a field structure consistent with arXiv.

### 3.4 Merge and Deduplicate

`mergeAndDeduplicate(arxivPapers, hfPapers)` rules:

- **arXiv papers have higher priority**: all are first placed into the `merged` Map, preserving their `categories`, `abstract`, and other metadata
- **HF papers supplement**: if an HF paper's `arxivId` already exists in an arXiv paper, all 7 HF-specific fields are merged; if not, it is added as an independent paper
- **Source tags**: `sources: ['arxiv']`, `['huggingface']`, or `['arxiv', 'huggingface']`
- **Abstract unification**: HF papers output both `summary` and `abstract` (same content), ensuring downstream consumers do not need to distinguish field names

HF-specific fields (7 total):

| Field | Type | Description |
|------|------|------|
| `hf_upvotes` | number | HF community upvotes |
| `hf_ai_summary` | string | HF AI-generated summary |
| `hf_ai_keywords` | string[] | HF AI-extracted keywords |
| `hf_github_repo` | string | Associated GitHub repository |
| `hf_project_page` | string | Project homepage |
| `hf_github_stars` | number | GitHub Stars count |
| `hf_discussion_id` | string | HF Discussion ID |

### 3.5 LLM Filtering

Using the `PAPER_ANALYZER_*` configuration in `~/.hermes/.env`, each paper is evaluated to determine whether it is speech / music / audio related.

**API Protocol Auto-Routing**: `detectApiType()` in `scripts/utils.js` automatically switches between OpenAI / Anthropic protocols based on the endpoint and model name
- **MiMo / Kimi Token Plan / Coding Plan** (endpoint contains `token-plan` or `coding`, model contains `mimo`/`kimi`) -> automatically switches to **Anthropic protocol**, masquerading as a Claude Code call
  - **MiMo**: `https://token-plan-cn.xiaomimimo.com/v1` -> `/anthropic/v1/messages`
  - **Kimi**: `https://api.kimi.com/coding/v1` -> `/v1/messages` (no `/anthropic` intermediate path needed)
  - Headers: `x-api-key` + `anthropic-version: 2023-06-01` + `User-Agent: claude-cli/<version> (external, cli)` (version dynamically obtained from local `claude --version`, fallback to `2.1.108` on failure)
  - system message is automatically extracted as a top-level request body field
- **Other cases** (including MiMo pay-as-you-go `api.xiaomimimo.com`, generic OpenAI endpoints) -> standard **OpenAI protocol**
  - URL: `/v1/chat/completions`
  - Headers: `Authorization: Bearer {key}`

The filtering prompt is read from `prompts/filter.md`, with `{title}`, `{abstract}`, `{categories}` placeholders replaced at runtime. Evaluation criteria:
- Speech synthesis / recognition / enhancement / separation / cloning / conversion -> **yes**
- Audio generation / understanding / music / event detection -> **yes**
- Speaker-related tasks -> **yes**
- Speech / music / audio related models, representation learning, pre-training -> **yes**
- Multimodal models that explicitly involve speech / music / audio (as input, output, training objective, evaluation task, or core capability) -> **yes**
- Other domains with no substantive speech / music / audio methods or tasks -> **no**
- Conflict resolution: if a paper simultaneously appears to satisfy "multimodal involving speech / music / audio" and "other domain", prioritize **yes**

Runtime parameters:
- `batchSize = 5` (parallel LLM calls within a batch)
- `delayBetweenBatches = 2000` (2-second delay between batches)
- `useKeywordPreFilter = false` (keyword pre-filtering is currently not used in the main workflow)
- Per-paper timeout **60 seconds**, **3 retries**
- Each retry independently creates an `AbortController` and `setTimeout`, avoiding reuse of an already-aborted controller

Results are saved to `data/current/filtered-papers.json`.

### 3.6 Deep Analysis

`deep-analyzer.js` performs full-text + image deep reading and comprehension for each filtered paper.

The deep analysis prompt is read from `prompts/deep-analysis.md`, with `{hasFullText}`, `{title}`, `{authors}`, `{categories}`, `{arxivId}`, `{textForAnalysis}` placeholders replaced at runtime.

**Analysis content (generated by LLM, output in Chinese)**:

| Section | Requirements |
|------|------|
| Score | 1-10, one decimal place; machine summary includes `rank_bucket` (top 10% / top 25% / top 50% / bottom 50%), `quality_score` (0-7), `value_score` (0-2), `reproducibility_bonus` (0-2), `confidence`, and other fields. Post-processing: extract seven sub-scores from `## Score Rationale` and recalculate the total score, overriding the LLM's original output |
| Tags | 3-5, must include at least 1 [Task] and 1 [Method/Model] tag; in addition to the final tag string, also output "main task tag", "main method tag", and "supplementary tags" |
| Authors and Affiliations | First author, corresponding author, author list and affiliations; missing information must be written as "not specified", no guessing allowed |
| Snarky Review | 2-3 sentences of sharp commentary on highlights and flaws, like a senior reviewer's final comment |
| Core Summary | 5-8 sentences, covering problem, method, results, limitations |
| Method Overview and Architecture | Input/output flow, component structure, connection methods, design rationale; no fewer than 600 Chinese characters |
| Core Innovations | 3-5, each including definition, shortcomings of previous methods, solution mechanism, actual effect |
| Experimental Results | Must prioritize giving benchmark, metrics, and specific numbers; when numbers are unavailable, explicitly write "paper did not provide specific values"; tables must be fully output |
| Detailed Description | Training data, loss functions, training strategies, hyperparameters, hardware, inference details |
| Score Rationale | Score and write specific review comments for each of 6 dimensions (Innovation / Technical Rigor / Experimental Adequacy / Clarity / Impact / Reproducibility), like a top-conference reviewer explaining "why this score" |
| Limitations and Issues | Two parts: limitations explicitly acknowledged by the paper + potential issues identified by the reviewer |
| Open Source Details | Only allowed to summarize based on paper text or current input links; write "not mentioned" when missing, strictly forbidden to fabricate repository / popularity information |

> **Image and Table Placement Rules**: Images and tables are no longer gathered in a separate section, but embedded directly at the corresponding positions -- architecture diagrams go in the **Method Overview and Architecture** section, experimental result figures/tables go in the **Experimental Results** section. Fabricating image URLs is strictly forbidden; only real URLs from the arXiv image URL list provided in the prompt may be used.

**Technical Features**:
- **API Protocol Auto-Routing**: shares the same `detectApiType()` logic as the filtering stage, automatically switching between OpenAI / Anthropic protocols based on `PAPER_ANALYZER_ENDPOINT` and `PAPER_ANALYZER_MODEL`
- Fetches arXiv HTML full text (up to 500K characters), trying `v1`, `v2`, and no-suffix versions in order; uses **cheerio** for structured HTML parsing, removing noise elements such as script/style/nav/header/footer
- Extracts image URLs (png/jpg/jpeg), filtering out logo/favicon
- **Image Analysis**: downloads all paper images (no quantity limit); single-image base64 cap is approximately 20M characters (`imageMaxBase64Chars` in config.js); **image download parallelization (concurrency 3)**. The image URL list is written into the prompt, so even if downloads fail the LLM can still obtain real URLs for in-text citations. If all downloads fail, automatically falls back to a pure-text retry
- **Concurrency: 3 papers in parallel** (adjustable via `PD_ANALYSIS_CONCURRENCY` environment variable)
- Up to **2 retries** per paper (outer `analysis-engine.js`), with each outer retry having **3 retries** for internal API calls (`deep-analyzer.js` inner layer, exponential backoff: first 10s, then double, `2^attempt * 5000ms`), outer retry interval 3s (adjustable via `PD_ANALYSIS_MAX_RETRIES`)
- API overall timeout **20 minutes** (AbortController)
- `max_tokens=64000` (`apiMaxTokens` in config.js), `temperature=0.7`
- Supports automatic proxy detection (environment variables -> macOS `scutil --proxy`)
- Supports pure Node built-in module HTTP CONNECT proxy (no external dependencies)
- All analysis configurations are centrally managed in `scripts/config.js`, with environment variable overrides (`PD_ANALYSIS_CONCURRENCY`, `PD_ANALYSIS_MAX_RETRIES`, `PD_FILTER_BATCH_SIZE`, `PD_ARXIV_MAX_RESULTS`)

**Deep analysis is not a single call, but a 5-round progressive process**:

| Round | Name | Prompt | Purpose |
|------|------|--------|--------|
| Round 1 | Main Deep Analysis | `prompts/deep-analysis.md` | Full-text + image analysis, generates all sections |
| Round 2 | Open Source Scan | `prompts/opensource-scan.md` | Extract GitHub/HF/ModelScope etc. links from paper text, supplement open source details |
| Round 3 | Review and Rewrite | `prompts/gap-fill.md` | Compare original paper with Round 1 output, correct omissions, errors, over-inferences |
| Round 4 | Table Fix | Code detection + LLM supplement | Detect missing Markdown tables in the Experimental Results section, trigger supplementation |
| Round 5 | Method Section Fix | Code detection + LLM supplement | Detect if Method Overview is too brief (<300 chars / <3 paragraphs), trigger expansion to 600+ chars |

### 3.7 Incremental Save and Wrap-up

- **Incremental save to `data/current/deep-analysis-result.json` immediately after each batch completes**, avoiding total loss on interruption; during incremental merge, **existing successful analyses are automatically protected** (failed results will not overwrite an existing `analysis`)
- After all papers are analyzed, existing results are read again, deduplicated and merged by `arxivId`/`paper_id`, preserving historical data
- Automatically backs up the old file to `data/archive/deep-analysis-result-<timestamp>.bak.json`, and cleans up old backups (keeping the most recent 10)
- **`papers.json` automatic backup**: before each daily run, automatically backs up `data/current/papers.json` to `data/archive/papers-<date>.json`, keeping the most recent 7 days
- Updates `data/current/papers.json` deduplication database
