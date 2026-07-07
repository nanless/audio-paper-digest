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

Additionally, before final saving of a new deep-analysis result, if an existing `deep-analysis-result.json` contains data, it is backed up to `data/archive/deep-analysis-result-<timestamp>.bak.json`, and old backups are cleaned up automatically (keeping the most recent 10). This happens during the final save after analysis, not during startup archive.

### 3.2 Load Deduplication Database and Blog Dedup

At startup, the deduplication set is first loaded:

1. **papers.json**: Read existing paper IDs from `data/current/papers.json`
2. **Blog published**: Scan the Hugo blog repository (`PAPER_DIGEST_BLOG_REPO`, default `~/code/github_repos/audio-paper-digest-blog`) `content/posts/` directory, extract arXiv IDs in `arxiv.org/abs/XXXX.XXXXX` format from all `.md` files

Both are merged into a unified deduplication set. Subsequent arXiv and HuggingFace fetching will skip IDs in this set, **excluding already-published papers at the fetch stage to avoid wasting LLM API calls.**

### 3.3 arXiv Fetching

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

Fetch strategy: 3-level (recent → search → API):

1. **Recent page (primary)**: `arxiv.org/list/{category}/recent`, paginated (`?skip=50&show=50`, max 100 per category). Abstracts fetched afterward via `fetchAbstracts`. Falls through only if recent returns 0 papers.
2. **Search page (fallback)**: `arxiv.org/search/` with User-Agent rotation, page delay 10-25s.
3. **API (last resort)**: `export.arxiv.org/api/query`. 429 rate-limit: exponential backoff 60s, 120s, 240s, 480s, max 5 retries.

Deduplication logic: `deduplicatePapers()` deduplicates by `arxivId`, with core categories (eess.AS / cs.SD / eess.SP) taking precedence over supplement categories.

### 3.4 HuggingFace Papers Fetching

Dual-source fetching via `fetch-huggingface-papers.js`:

1. **`/api/daily_papers`**: Curated daily papers, including rich fields such as `ai_summary`, `githubRepo`, `upvotes`, `ai_keywords`, `projectPage`, `githubStars`, `discussionId`. Paginated (`limit=100`, up to 20 pages) until the last 7 days are covered.
2. **`/api/papers`**: Latest papers supplement, covering the last 1-2 days, used to backfill papers not included in daily_papers.

Filtering:
- Only keep papers from the last 7 days (`published >= today-7 days`)
- Exclude already-known IDs (including IDs from papers.json, just-fetched arXiv papers, and blog-published IDs)
- Sort by `upvotes` descending

Technical implementation: data is fetched using `curl` commands (to avoid Node fetch compatibility issues in proxy environments), and returned data is normalized to a field structure consistent with arXiv.

### 3.5 Merge and Deduplicate

`mergeAndDeduplicate(arxivPapers, hfPapers)` rules:

- **arXiv papers have higher priority**: all are first placed into the `merged` Map, preserving their `categories`, `abstract`, and other metadata
- **HF papers supplement**: if an HF paper's `arxivId` already exists in an arXiv paper, all 7 HF-specific fields are merged; if not, it is added as an independent paper
- **Source tags**: `sources: ['arxiv']`, `['huggingface']`, or `['arxiv', 'huggingface']`
- **Abstract unification**: HF papers output both `summary` and `abstract` (same content), ensuring downstream consumers do not need to distinguish field names

After merging, blog-published papers are filtered out (based on the blog ID set loaded in Step 3.2), ensuring already-published papers do not enter the LLM filter stage.

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

### 3.6 LLM Filtering

Using the `PAPER_ANALYZER_*` configuration in `the `.env` file in the project root`, each paper is evaluated to determine whether it is speech / music / audio related.

**API Protocol Auto-Routing**: `detectApiType()` in `scripts/utils.js` automatically switches between OpenAI / Anthropic protocols based on the endpoint and model name
- **MiMo / Kimi Token Plan / Coding Plan** (endpoint contains `token-plan` or `coding`, model contains `mimo`/`kimi`) -> automatically switches to **Anthropic protocol**, masquerading as a Claude Code call
  - **MiMo**: `https://token-plan-cn.xiaomimimo.com/v1` -> `/anthropic/v1/messages`
  - **Kimi**: `https://api.kimi.com/coding/v1` -> `https://api.kimi.com/coding/v1/messages` (no `/anthropic` intermediate path needed)
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
- Per-paper timeout **60 seconds**, **5 retries** (backoff `2^attempt * 1s`)
- Each retry independently creates an `AbortController` and `setTimeout`, avoiding reuse of an already-aborted controller

Results are saved to `data/current/filtered-papers.json`.

### 3.7 Deep Analysis

`deep-analyzer.js` performs full-text + image deep reading and comprehension for each filtered paper.

The deep analysis prompt is read from `prompts/deep-analysis.md`, with `{hasFullText}`, `{title}`, `{authors}`, `{categories}`, `{arxivId}`, `{textForAnalysis}` placeholders replaced at runtime.

**Analysis content (generated by LLM, output in Chinese)**:

| Section | Requirements |
|------|------|
| Score | 1-10, one decimal place; machine summary includes `rank_bucket` (top 10% / top 25% / top 50% / bottom 50%), `innovation` (0-2), `technical_rigor` (0-1.5), `experimental_sufficiency` (0-1.5), `clarity` (0-1), `impact` (0-1.5), `open_source` (0-1.5), `reproducibility` (0-0.5), `engineering_score` (0-1.5), `confidence`, and other fields. Post-processing: extract eight sub-scores from `## Score Rationale` and recalculate the total score (capped at 10), overriding the LLM's original output |
| Tags | 3-5, must include at least 1 [Task] and 1 [Method/Model] tag; in addition to the final tag string, also output "main task tag", "main method tag", and "supplementary tags" |
| Authors and Affiliations | First author, corresponding author, author list and affiliations; missing information must be written as "not specified", no guessing allowed |
| Snarky Review | 2-3 sentences of sharp commentary on highlights and flaws, like a senior reviewer's final comment |
| Core Summary | 5-8 sentences, covering problem, method, results, limitations |
| Method Overview and Architecture | Input/output flow, component structure, connection methods, design rationale; no fewer than 600 Chinese characters |
| Core Innovations | 3-5, each including definition, shortcomings of previous methods, solution mechanism, actual effect |
| Experimental Results | Must prioritize giving benchmark, metrics, and specific numbers; when numbers are unavailable, explicitly write "paper did not provide specific values"; tables must be fully output |
| Detailed Description | Training data, loss functions, training strategies, hyperparameters, hardware, inference details |
| Score Rationale | Score and write specific review comments for each of 8 dimensions (Innovation/2, Technical Rigor/1.5, Experimental Sufficiency/1.5, Clarity/1, Impact/1.5, Open Source/1.5, Reproducibility/0.5, Engineering/Practical Value/1.5); 10-point scale is forbidden; code automatically recalculates total from sub-scores |
| Limitations and Issues | Two parts: limitations explicitly acknowledged by the paper + potential issues identified by the reviewer |
| Open Source Details | Only allowed to summarize based on paper text or current input links; write "not mentioned" when missing, strictly forbidden to fabricate repository / popularity information |

> **Image and Table Placement Rules**: Images and tables are no longer gathered in a separate section, but embedded directly at the corresponding positions -- architecture diagrams go in the **Method Overview and Architecture** section, experimental result figures/tables go in the **Experimental Results** section. Fabricating image URLs is strictly forbidden; only real URLs from the arXiv image URL list provided in the prompt may be used.

**Technical Features**:
- **API Protocol Auto-Routing**: shares the same `detectApiType()` logic as the filtering stage, automatically switching between OpenAI / Anthropic protocols based on `PAPER_ANALYZER_ENDPOINT` and `PAPER_ANALYZER_MODEL`
- Fetches arXiv HTML full text (up to 500K characters), trying `v1`, `v2`, and no-suffix versions in order; uses **cheerio** for structured HTML parsing, removing noise elements such as script/style/nav/header/footer
- Extracts image URLs (png/jpg/jpeg), filtering out logo/favicon
- **Image Analysis**: downloads all paper images serially (no quantity limit); single-image base64 cap is approximately 20M characters (`imageMaxBase64Chars` in config.js). The image URL list is written into the prompt, so even if downloads fail the LLM can still obtain real URLs for in-text citations. If all downloads fail, automatically falls back to a pure-text retry
- **Concurrency: 3 papers in parallel** (adjustable via `PD_ANALYSIS_CONCURRENCY` environment variable)
- Up to **2 retries** per paper (outer `analysis-engine.js`), with each outer retry having **3 retries** for internal API calls (`deep-analyzer.js` inner layer, exponential backoff: first 10s, then double, `2^attempt * 5000ms`), outer retry interval 3s (adjustable via `PD_ANALYSIS_MAX_RETRIES`)
- API overall timeout **20 minutes** (AbortController)
- `max_tokens=64000` (`apiMaxTokens` in config.js), `temperature=0.7`
- Supports automatic proxy detection (environment variables -> macOS `scutil --proxy`)
- Supports pure Node built-in module HTTP CONNECT proxy (no external dependencies)
- All analysis configurations are centrally managed in `scripts/config.js`, with environment variable overrides (`PD_ANALYSIS_CONCURRENCY`, `PD_ANALYSIS_MAX_RETRIES`, `PD_FILTER_BATCH_SIZE`, `PD_ARXIV_MAX_RESULTS`)

**Deep analysis is not a single call, but a multi-round progressive process**:

| Round | Name | Prompt | Purpose |
|------|------|--------|--------|
| Round 1 | Main Deep Analysis | `prompts/deep-analysis.md` | Primary model performs **text-only** full-text analysis, generating all sections |
| Round 1b | Image Supplement (dual-model only) | `prompts/image-supplement.md` | Secondary model takes images + primary output for multimodal supplement, replacing Round 1 result; skipped when no secondary model or no images |
| Round 2 | Open Source Scan | `prompts/opensource-scan.md` | Extract GitHub/HF/ModelScope etc. links from paper text, supplement open source details |
| Round 2.5 | Demo Page Link Discovery | Code fetch | If no open-source links, visit demo pages found in the analysis (up to 3) and recover code/model/dataset links |
| Round 3 | Review and Rewrite | `prompts/gap-fill.md` | Compare original paper with earlier output, correct omissions, errors, over-inferences |
| Round 4 | Table Fix | Code detection + LLM supplement | Detect missing Markdown tables in the Experimental Results section, trigger supplementation |
| Round 5 | Method Section Fix | Code detection + LLM supplement | Detect if Method Overview is too brief (<300 chars / <3 paragraphs), trigger expansion to 600+ chars |

> **Single-model vs dual-model**: setting `PAPER_ANALYZER_SECONDARY_MODEL` (plus optional `SECONDARY_ENDPOINT`/`SECONDARY_API_KEY`, which reuse the primary values if unset) enables dual-model mode — the primary model first does text-only analysis, then after text-only repair rounds finish, the secondary model selects high-value figures from the candidates (flow diagrams, model diagrams, spectrograms, comparisons, result plots, etc.), drops low-information figures, and inserts the chosen figures into the relevant paragraphs. Without a secondary model it falls back to single-model: image URLs are kept only as `allImageUrls` candidate metadata and are not automatically embedded in the blog body.

### 3.8 Incremental Save and Wrap-up

- **Incremental save to `data/current/deep-analysis-result.json` immediately after each batch completes**, avoiding total loss on interruption; during incremental merge, **existing successful analyses are automatically protected** (failed results will not overwrite an existing `analysis`)
- After all papers are analyzed, existing results are read again, deduplicated and merged by `arxivId`/`paper_id`, preserving historical data
- Automatically backs up the old file to `data/archive/deep-analysis-result-<timestamp>.bak.json`, and cleans up old backups (keeping the most recent 10)
- **`papers.json` automatic backup**: before each daily run, automatically backs up `data/current/papers.json` to `data/archive/papers-<date>.json`, keeping the most recent 7 days
- Updates `data/current/papers.json` deduplication database
