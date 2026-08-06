# Main Workflow Explained

## Main Workflow Explained

The default daily entry is `./run-daily-digest.sh YYYY-MM-DD`. Starting from fetch requires Beijing today because the core fetcher binds the batch to its process start date and accepts no historical-date injection; historical batches may only resume existing data from generate/review/push/visual. Generate uses matching current analysis data or falls back to the controlled archive for that date. It runs the core data pipeline, the separate blog generate/review/push stages, post-publication visual planning, and reference preparation. If review reports content blockers, the Agent fixes them and resumes with `--from review`. The script never calls an image API; after it succeeds, Codex must use built-in `image_gen` to complete the TOP 10 paper infographics and digest cover, then pass both visual status gates. The data-only entry remains `./run-full-fetch.sh` (or `node scripts/full-fetch.js` / `npm run fetch`).

When the user asks to run a dated paper digest, that request already authorizes the blog push and requires every stage above. Do not stop after fetch, analysis, review, or publication. WeChat, Feishu, and Xiaohongshu auto-publishing are outside the default scope.

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

1. **Recent page (primary)**: `arxiv.org/list/{category}/recent`, paginated (`?skip=50&show=50`, max 100 per category). Abstracts fetched afterward via `fetchAbstracts`. If recent returns fewer than the target count, the flow continues to the search/API fallbacks to fill the candidate pool.
2. **Search page (fallback)**: `arxiv.org/search/` with User-Agent rotation, page delay 10-25s.
3. **API (last resort)**: `export.arxiv.org/api/query`. 429 rate-limit: exponential backoff 60s, 120s, 240s, 480s, max 5 retries.

Deduplication logic: `deduplicatePapers()` deduplicates by `arxivId`, with core categories (eess.AS / cs.SD / eess.SP) taking precedence over supplement categories.

### 3.4 HuggingFace Papers Fetching

Dual-source fetching via `fetch-huggingface-papers.js`:

1. **`/api/daily_papers`**: Curated daily papers, including rich fields such as `ai_summary`, `githubRepo`, `upvotes`, `ai_keywords`, `projectPage`, `githubStars`, `discussionId`. Paginated (`limit=100`, up to 20 pages) until the last 7 days are covered.
2. **`/api/papers`**: Latest papers supplement, covering the last 1-2 days, used to backfill papers not included in daily_papers.

Filtering:
- Only keep papers from the last 7 days (`published >= today-7 days`)
- Exclude historical already-known IDs (completed/published IDs from papers.json and blog-published IDs)
- Do **not** exclude arXiv IDs fetched in the same run; same-batch overlaps are kept so the merge stage can enrich arXiv papers with HF upvotes, AI summaries, and project links
- Sort by `upvotes` descending

Technical implementation: data is fetched using `curl` commands (to avoid Node fetch compatibility issues in proxy environments), and returned data is normalized to a field structure consistent with arXiv. HuggingFace fetches must use the project `.env` proxy; missing proxy configuration fails immediately instead of creating an empty pseudo-success batch.

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
- **MiMo / Kimi Token Plan / Coding Plan** (MiMo is recognized by `token-plan` plus its domain/model; Kimi by `coding` plus the `kimi.com` domain or Kimi model) -> automatically switches to **Anthropic protocol**, supports names such as `k3`, and masquerades as a Claude Code call
  - **MiMo**: `https://token-plan-cn.xiaomimimo.com/v1` -> `/anthropic/v1/messages`
  - **Kimi**: `https://api.kimi.com/coding` or `https://api.kimi.com/coding/v1` -> `https://api.kimi.com/coding/v1/messages` (automatically adds `/v1`; supports model names such as `k3`; no `/anthropic` intermediate path needed)
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
- `useKeywordPreFilter = true` (high-recall local prefiltering runs before the LLM, with core audio categories as fallback)
- Per-paper timeout **60 seconds**, **5 retries** (backoff `2^attempt * 1s`)
- Each retry independently creates an `AbortController` and `setTimeout`, avoiding reuse of an already-aborted controller

The filtering stage writes three files incrementally:
- `data/current/raw-candidates.json`: candidate input after merge and blog deduplication, including request attempts, successful requests, and failure details in arXiv/HF `sourceHealth`. Fetchers distinguish a successful empty response from every request failing; all-failed sources throw and cannot produce a false-success empty batch
- `data/current/filter-decisions.json`: per-paper LLM decisions, including filter model and prompt hash. API errors or indeterminate responses are marked `retryable`, excluded from the definitive decision cache, and prevent completion until retried
- `data/current/filtered-papers.json`: partial/final filtered output; includes `filterModel` and `filterPromptHash`. `status: "filter_complete"` only means per-paper filtering has finished before archive deduplication, while final skip-ready output must use `status: "complete"` and match the current model/hash

If today's complete `filtered-papers.json` already exists and its model/hash match the current configuration, rerunning `node scripts/full-fetch.js` skips crawling/filtering and resumes deep analysis directly. If filtering is incomplete, existing decisions in `filter-decisions.json` are reused only when the model and prompt hash match.
`npm run validate:data` cross-checks candidate stats, decision counts, related counts, and final paper counts across `raw-candidates.json`, `filter-decisions.json`, and `filtered-papers.json`.

A high-recall keyword gate runs before LLM filtering by default, with core audio categories as a fallback. `npm run keyword:recall` evaluates curated positive/negative gold cases and historical replay; known historical LLM false positives require explicit ID/reason adjudication, and the report separates raw hit rate from recall over adjudicated effective positives.

### 3.7 Deep Analysis

`deep-analyzer.js` performs full-text + image deep reading and comprehension for each filtered paper.

The deep analysis prompt is read from `prompts/deep-analysis.md`, with `{hasFullText}`, `{title}`, `{authors}`, `{categories}`, `{arxivId}`, `{textForAnalysis}` placeholders replaced at runtime.

**Analysis content (generated by LLM, output in Chinese)**:

| Section | Requirements |
|------|------|
| Score (`## 评分`) | `type-aware-v1`: first output `document_type` (方法研究 / 系统技术报告 / 模型报告 / 数据集与基准 / 综述 / 理论研究 / 应用研究), then use the matching evidence standard. Dimensions sum to 11 and the total is capped at 10; code recomputes it only when all eight dimensions are complete, unique, and valid. Invalid scoring fails the contract. Type grants no fixed bonus and one defect may reduce only one primary dimension |
| Tags | 3-5, must include at least 1 [Task] and 1 [Method/Model] tag; in addition to the final tag string, also output "main task tag", "main method tag", and "supplementary tags" |
| Authors and Affiliations | First author, corresponding author, author list and affiliations; missing information must be written as "not specified", no guessing allowed |
| Snarky Review | 2-3 sentences of sharp commentary on highlights and flaws, like a senior reviewer's final comment |
| Core Summary | 5-8 sentences, covering problem, method, results, limitations |
| Method Overview and Architecture | Input/output flow, component structure, connection methods, design rationale; no fewer than 600 Chinese characters |
| Core Innovations | 3-5, each including definition, shortcomings of previous methods, solution mechanism, actual effect |
| Experimental Results | Must prioritize giving benchmark, metrics, and specific numbers; when numbers are unavailable, explicitly write "paper did not provide specific values"; tables must be fully output |
| Detailed Description | Training data, loss functions, training strategies, hyperparameters, hardware, inference details |
| Score Rationale (`## 评分理由`) | Score and write specific review comments for each of 8 dimensions (Innovation/2, Technical Rigor/1.5, Experimental Sufficiency/1.5, Clarity/1, Impact/1.5, Open Source/1.5, Reproducibility/0.5, Engineering/Practical Value/1.5); 10-point scale is forbidden; code automatically recalculates total from sub-scores |
| Limitations and Issues | Two parts: limitations explicitly acknowledged by the paper + potential issues identified by the reviewer |
| Open Source Details | Only allowed to summarize based on paper text or current input links; write "not mentioned" when missing, strictly forbidden to fabricate repository / popularity information |

> **Image and Table Placement Rules**: Images and tables are no longer gathered in a separate section, but embedded directly at the corresponding positions -- architecture diagrams go in the **方法概述和架构** section, experimental result figures/tables go in the **实验结果** section. Fabricating image URLs is strictly forbidden; only candidate figures provided in the dual-model `image-supplement` round may be selected and inserted.

**Technical Features**:
- **API Protocol Auto-Routing**: shares the same `detectApiType()` logic as the filtering stage, automatically switching between OpenAI / Anthropic protocols based on `PAPER_ANALYZER_ENDPOINT` and `PAPER_ANALYZER_MODEL`
- Fetches arXiv HTML/PDF full text. Primary analysis uses at most 200K characters by default; `task-focused-v1` samples very long sources deterministically across the head, quartiles, middle, tail, and task-relevant chunks instead of taking a prefix only. It tries `v1`, `v2`, and no-suffix versions in order; all HTML/PDF/image requests use the HTTP CONNECT proxy dispatcher from project `.env` and fail when it is absent; uses **cheerio** for structured HTML parsing, removing noise elements such as script/style/nav/header/footer
- Extracts image URLs and filters out logo/favicon; the download layer validates Content-Type, Content-Length, and PNG/JPEG/WebP magic bytes before sending images to the model
- **Image Analysis**: HTML body text and figure captions are parsed from the same response, and captions enrich preprovided URLs by exact URL or unique basename. Successful downloads use `data/current/image-cache/`; permanent HTTP/MIME/size/security failures are not retried. The secondary model selects a code-generated stable `paragraph_id` instead of copying free-form anchors; legacy anchors remain read-compatible. Invalid IDs and over-limit plans are rejected without section-end fallback
- Each result stores candidate scores, per-URL download/cache outcomes, secondary model/options, prompt/response hashes, insertion diagnostics, and final URLs in `imageManifest`. `no_downloadable_images` is a successful permanent terminal state; a non-empty plan with zero insertions is `invalid_output` and retries only the image stage
- `analysisManifest` records image download, primary analysis, open-source scan, demo scan, revision, table/method/structure repair, scoring audit, and image supplementation. Failures retain `analysisCheckpoint` and `analysisRecoveryImageManifest`; reruns resume at the first incomplete stage and success requires every mandatory stage to reach a terminal status
- **Concurrency: 3 papers in parallel** (adjustable via `PD_ANALYSIS_CONCURRENCY` in the project `.env`)
- Up to **2 retries** per paper (outer `analysis-engine.js`), with each outer retry having **3 retries** for internal API calls (`deep-analyzer.js` inner layer, exponential backoff: first 10s, then double, `2^attempt * 5000ms`), outer retry interval 3s (adjustable via `PD_ANALYSIS_MAX_RETRIES`)
- API overall timeout is **20 minutes of active process time**. A heartbeat excludes system-sleep or long-suspension wall-clock jumps, so a socket timeout after wake can retry with the remaining budget
- Primary analysis uses `max_tokens=64000` (`apiMaxTokens`); revision, table, method, and structure repair default to `max_tokens=16000` (`repairMaxTokens`, overridable with `PD_ANALYSIS_REPAIR_MAX_TOKENS`); `temperature=0.7`
- Post-processing stages no longer resend the complete source. Default evidence budgets are 16K for open-source scanning, 60K for revision, 40K for scoring audit, 30K for method/table repair, and 40K for structure repair. They are controlled by `PD_OPENSOURCE_EVIDENCE_MAX_CHARS`, `PD_REVISION_EVIDENCE_MAX_CHARS`, `PD_SCORING_EVIDENCE_MAX_CHARS`, `PD_REPAIR_EVIDENCE_MAX_CHARS`, and `PD_STRUCTURE_EVIDENCE_MAX_CHARS`; `PD_ANALYSIS_FULL_TEXT_MAX_CHARS` controls primary analysis. The selector version and budgets are part of recovery fingerprints, so only the affected stage and downstream work rerun
- Every model-call log includes text characters, estimated text tokens, and image count; image base64 is neither counted nor printed as text
- Proxy settings come only from case-insensitive proxy variables explicitly configured in the project-root `.env`; inherited shell/IDE proxies and macOS `scutil` are not used. At least one of `HTTPS_PROXY` or `HTTP_PROXY` must be an HTTP CONNECT address for arXiv; HuggingFace `curl` may additionally use SOCKS `ALL_PROXY`
- LLM and fetch transport are isolated: every LLM call is direct with `agent: false` and never reuses a fetch dispatcher; commands using a local proxy must run outside the sandbox
- If any arXiv category or HuggingFace source fails, the run records `source_partial_failed` and stops after filtering. That state is never reusable as `filter_complete` and cannot enter deep analysis or update the persistent deduplication database.
- All analysis configurations are centrally managed in `scripts/config.js`, with project `.env` overrides for concurrency, retries, fetch limits, stage evidence budgets, scoring/image temperatures, and image payload limits

**Deep analysis is not a single call, but a multi-round progressive process**:

| Round | Name | Prompt | Purpose |
|------|------|--------|--------|
| Round 1 | Main Deep Analysis | `prompts/deep-analysis.md` | Primary model performs **text-only** full-text analysis, generating all sections |
| Round 2 | Open Source Scan | `prompts/opensource-scan.md` | Extract GitHub/HF/ModelScope etc. links from paper text, supplement open source details |
| Round 2.5 | Demo Page Link Discovery | Code fetch | If no open-source links, visit up to three demo pages, following at most three redirects per page while revalidating public DNS/IP on every hop, and recover code/model/dataset links |
| Round 3 | Review and Rewrite | `prompts/gap-fill.md` | Compare original paper with earlier output, correct omissions, errors, over-inferences |
| Round 4 | Table Fix | Code detection + LLM supplement | Detect missing Markdown tables in the Experimental Results section, trigger supplementation |
| Round 5 | Method Section Fix | Code detection + LLM supplement | Detect if Method Overview is too brief (<600 chars / <3 paragraphs), trigger expansion to 600+ chars |
| Round 6 | Final Structural Repair (conditional) | `prompts/structure-repair.md` | If the shared contract finds any of the 13 required sections missing, the primary model repairs only the current report structure; otherwise this round is skipped |
| Round 7 | Type-aware Scoring Audit | `prompts/scoring-audit.md` | Primary model returns JSON only; code feeds validation errors into the next local attempt and deterministically normalizes Open Source when no artifact is released |
| Round 8 | Image Selection and Insertion Plan (dual-model only) | `prompts/image-supplement.md` | Secondary model returns JSON only; the complete contract is checked after merging, and an invalid plan is discarded without losing the audited primary text |

> **Single-model vs dual-model**: setting `PAPER_ANALYZER_SECONDARY_MODEL` enables the secondary model to select high-value figures and output a constrained insertion plan containing section, stable paragraph ID, lead, and explanation. Code only adds figures and adjacent text. Scoring audit and image planning use independent low temperatures (0.1 and 0.2 by default). When it is unset, image URLs remain candidate metadata and the optional multimodal blog-review LLM call is skipped; deterministic image checks still run.

Single-issue-single-dimension ownership is enforced in code. A cross-dimension rationale triggers a local retry with the exact validation error instead of immediately restarting full-paper analysis. When resource state is deterministic, fixed Open Source anchors are applied: 0.5 for an explicit future release promise, 0.2 for demo-only, and 0 for fully closed with no promise. Theory papers use public proofs, derivations, and appendices as the applicable core artifact rather than mechanically requiring code/model/data links.

Text acquisition persists source type, original/used/full-text lengths, truncation, SHA-256, HTML availability, and warnings. Stable HTML misses do not retry; versioned IDs never silently upgrade; PDFs are size/header/MIME checked. Abstract fallback is marked `degraded_abstract` and is blocked from publishing unless `allowAbstractAnalysisPublish: true` is explicitly approved. Source, model, temperature, prompt, or evidence fingerprint changes invalidate only the affected checkpoint stages.

An arXiv HTML response is accepted as full text only when it passes both length and document-structure checks: enough substantive paragraphs plus section or academic markers. `too_short`, `metadata_shell`, and `missing_paper_structure` continue to PDF fallback and preserve structural counters in warnings.

### 3.8 Mandatory Codex visual assets

All generated images for a batch are archived flat under `data/archive/<date>/visual-summaries/`: the digest cover is `00-digest-cover-<date>.png`, and TOP 10 paper images are `<two-digit-rank>-<paper-id>-<title-slug>.png`, never numbered by completion order. Only resumable manifests stay in `data/current/`; a later plan migrates legacy current and archive layouts after PNG/SHA verification.

After all scoring audits pass, run `generate-blog.py`, `review-blog.py`, and `push-blog.py` to publish the digest index and every paper page. Blog text review uses 8,000-character chunks by default (`PD_BLOG_REVIEW_CHUNK_CHARS`, bounded to 4,000–16,000), reducing repeated fixed instructions while preserving Markdown block boundaries; the value is bound into the batch review-receipt fingerprint. Passed page bytes are retained separately by repository-relative path plus SHA-256, so changing the chunk size or other review code/protocol metadata refreshes the batch receipt without re-reviewing unchanged pages. Push records remote verification only when remote `main` exactly matches `publicationCommit`, then automatically invokes the post-publication planner. It selects the final-score TOP 10 with normalized-arXiv-ID tie breaking. Codex creates one tall infographic per selected paper with the exact English title at the top and a Chinese body, then records it with the task token.

The same post-publication stage creates one digest-image task using the category saved by blog generation and deterministic title, hot directions, and TOP 10 ranking. A paper task also selects at most two deep-analysis-approved figures whose cached URL, MIME, byte count, and SHA all match, prioritizing method overviews, architectures, and pipelines before key result figures. Reference fingerprints invalidate only the affected paper. Built-in image generation treats these figures as structural sources of truth and redraws them in the common editorial style; it must not paste an unreadable screenshot or invent missing data. The two manifests resume independently. These images neither enter nor block the completed blog transaction. Project scripts never call an image API; generated graphics remain editorial summaries, not original paper figures, and must not invent facts or display arXiv IDs on the digest image.

Before built-in image generation, run `npm run visual:prepare -- --date <date>` (optionally `--paper <ID>`). It keeps task tokens unchanged, revalidates each controlled `.bin` cache path, SHA, byte count, MIME, and magic bytes, and atomically materializes upload-ready `.png/.jpg/.webp` files under `data/current/visual-reference-inputs/<date>/<rank-paper>/`. Pass the emitted absolute `referencedImagePaths` to the image tool instead of raw `.bin` paths or display-only `relativePath` values; repeated runs repair altered materialized files.

Visual plan/status commands print compact task indexes by default: rank, paper ID, title, task token, reference-image count, and the absolute manifest path. `visual:prepare` additionally retains the absolute `referencedImagePaths` required by image generation. Full `generationContext.qaClaims` and cover rankings remain in their manifests. `digest:status` prints only stage counts and errors to the terminal while preserving full `sourceHealth` in the report JSON. Experiment-table repair runs only for an explicit `Table` / `Tbl.` / `表` citation with no Markdown table, or an illegal omission marker; merely detecting any table in the source no longer triggers another LLM call. New analyses and reanalyses write `analysisManifest.contracts.experimentTables=bounded-v1`; before scoring, code enforces at most two tables per paper, 12 data rows and 8 metric columns per table, and routes violations through local structure repair. Node data validation and Python publication preflight enforce the same marker. Existing successful records without the marker remain compatible and are not reprocessed in bulk.

### 3.9 Incremental Save and Wrap-up

- **Incremental save to `data/current/deep-analysis-result.json` immediately after each batch completes**. Result and paper-database updates re-read and merge under a cross-process lock with `generation` checks. Failed placeholders never overwrite successful analyses, and corrupt current JSON blocks writes instead of silently falling back to legacy data
- Incremental and final saves sync `data/current/papers.json` `digestStatus.status` through `scripts/digest-status.js`: successful analyses become `analyzed`, failures become `analysis_failed`
- `full-fetch.js` holds a single-run lock across archive, cleanup, filtering, and final merge without reducing paper-analysis concurrency. Failed checkpoints are persisted incrementally; an older valid body remains usable while `latestAttemptStatus` records the failed retry
- After all papers are analyzed, existing results are read again, deduplicated and merged by `arxivId`/`paper_id`, preserving historical data
- Automatically backs up the old file to `data/archive/deep-analysis-result-<timestamp>.bak.json`, and cleans up old backups (keeping the most recent 10)
- **`papers.json` automatic backup**: before each daily run, automatically backs up `data/current/papers.json` to `data/archive/papers-<date>.json`, keeping the most recent 7 days
- Updates `data/current/papers.json` deduplication database
