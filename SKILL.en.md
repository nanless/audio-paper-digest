# Audio Paper Digest Operations

## 1. Audience, Goal, and Entry Point

This guide covers running, resuming, publishing, and maintaining the default LLM/API digest. See
[AGENTS.md](AGENTS.md) for operational constraints, [docs/README.md](docs/README.md) to find a guide by task,
and [scripts/README.md](scripts/README.md) for module responsibilities.

A dated digest means the complete default route:

```bash
npm run digest:prepare -- YYYY-MM-DD
# exact alias
npm run digest:api -- YYYY-MM-DD
```

The request covers fetching, filtering, staged analysis, the API Reader tutorial, blog generation,
review, push, remote-OID verification, live-site checks, post-publication images, and final status.
`full-fetch.js` handles only the data stages. WeChat, Feishu, and Xiaohongshu are optional channels
outside the default request.

Manual is an isolated, explicit workflow:

```bash
npm run digest:manual -- YYYY-MM-DD
```

Use it only when the user explicitly requests Manual/human processing, and read [manual/README.md](manual/README.md) first. API failures never select Manual automatically.

## 2. First Run

```bash
npm install
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp env.example .env
```

Before starting, confirm which checkout you are using and run `npm run workspace:role -- status`.
The daily checkout must be `daily`; the full-history checkout must be `history`. Stop if its role
marker is missing or bound to another real path. After confirming the purpose, bind the appropriate
role with `npm run workspace:role -- set daily|history [--force]`; do not force a role change by default.

Set at least these fields in the project `.env`. The current documented model recommendation is
`muse-spark-1.3-contributor`; the actual model is selected by project configuration:

```dotenv
PAPER_ANALYZER_API_KEY=your-key
# Optional fallback accounts on the same OpenCode Go route, separated by commas
PAPER_ANALYZER_FALLBACK_API_KEYS=your-second-key
PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY=your-third-key
PAPER_ANALYZER_MODEL=muse-spark-1.3-contributor
PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
PAPER_DIGEST_BLOG_REPO=/absolute/path/to/audio-paper-digest-blog
```

Node must satisfy `>=20.18.1 <21 || >=22.3.0`. Default publishing and visual entry points require Python 3.11+
with an OpenSSL TLS backend; `scripts/python-runtime.sh` prefers the project `.venv`, then `python3.11`, then a
validated `python3`. Every project script, test, syntax check, and data validation command must run outside the
sandbox.

## 3. Default Workflow

```text
archive current
  → proxy-backed arXiv and HuggingFace fetch
  → published-paper deduplication
  → high-recall keyword prefilter
  → per-paper LLM filtering
  → seal this run's official arXiv text/PDF
  → staged full-text analysis
  → type-aware scoring
  → API Reader v3 longform and official figures
  → generate
  → review
  → push and remote OID
  → manually verify deployment and live pages
  → TOP 10 infographics and digest cover
  → digest:status
```

### 3.1 Fetching and complete filtering

`scripts/full-fetch.js` archives date-scoped current state, fetches seven arXiv categories and HuggingFace Papers, filters, updates the paper database, analyzes, and persists each result. Every required source must have a complete checkpoint with its candidate count and stable content SHA.
arXiv and HuggingFace both require the project proxy.

`raw-candidates.json` is the authoritative candidate set. Core categories, short abstracts, and audio-keyword matches always reach the LLM. A filter run is complete only when decisions cover every raw candidate and the filtered set exactly matches positive decisions minus explicit exclusions.

### 3.2 Analysis and Reader Longform

After filtering and before deep analysis, every selected arXiv ID is freshly captured from official arXiv into
`data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/`. Each generation is one captured source-file set, not an arXiv revision number. It
contains `source.txt`, `source.pdf`, `source-runtime.json`, and `source-manifest.json`; it is the only
daily API input for analysis and Reader. HTML remains preferred and PDF is the controlled textual fallback
inside that capture. Metadata-only pages and malformed short pages cannot stand in for the full paper. A source-SHA
change invalidates primary analysis and downstream stages. Images are prepared in the system temporary
directory for the current model request and cleaned up afterward; their pixels never persist in
`data/current` or runtime image caches.

Stages include primary analysis, open-source and demo scans, revision, table/method/structure repair,
tag checks, core-summary checks, scoring audit, API Reader, and image preparation. Each stage
records its input, model, protocol, prompt, temperature, budgets, and output SHA. Changes rerun the
affected stage and its downstream stages.

The primary analysis keeps its 13 fixed Chinese top-level headings for machine parsing. The reader-visible article is `beginner-researcher-v3`:

- 12–18 sections ordered to explain prerequisites before later concepts, and 5,000–18,000 Chinese characters;
- 4–10 explicit bridges between paired paper terms;
- tables that support discussion and comparison of data/protocol, results, ablations/failures, and training/deployment cost when evidence exists;
- adjacent figure guidance, viewing path, original image, caption, and explanation;
- every Markdown table cell bound to a source DOM cell or exact source quote; display formulas
  injected from structured original TeX;
- individually verified author names and affiliations, plus resource links bound to source evidence,
  redirect destinations, and reachability; temporary unavailability must not be described as availability;
- clear separation of reported facts, bounded interpretation, and untested speculation.

### 3.3 Scoring

Eight dimensions have maxima of 2/1.5/1.5/1/1.5/1.5/0.5/1.5. Code recomputes their sum and caps the displayed total at 10.

Document type selects applicable evidence, not weights. One defect belongs to one primary dimension: missing artifacts to Open Source, missing configuration to Reproducibility, missing claim support to Experimental Sufficiency, presentation to Clarity, and actual logical or derivational faults to Technical Rigor. Scoring must cite the evidence records and save `evidenceProfile` plus the code-derived score caps.
A change greater than 0.5 points requires an independent recheck. If the first two scores differ by
more than 0.3, one further check is allowed; accept only a pair among the three that differs by at
most 0.3. The audit proof must bind the adopted score and audit SHA and recompute the consensus difference.

## 4. APIs, Proxy, Concurrency, and Context

### 4.1 Protocol Routing

| Priority condition | Protocol | URL |
|---|---|---|
| DeepSeek domain or model | OpenAI Chat | `/v1/chat/completions` |
| Muse model or explicit `/responses` endpoint | OpenAI Responses | Use a complete endpoint unchanged; append `/responses` to a base endpoint |
| `token-plan` + MiMo | Anthropic | `/anthropic/v1/messages` |
| Kimi coding | Anthropic | `/coding/v1/messages` |
| other `/anthropic` | Anthropic | `{base}/messages` |
| other | OpenAI Chat | `/v1/chat/completions` |

All Node LLM calls use `requestLlmJson()`. Muse creates a separate project HTTP CONNECT connection
object for each request and destroys it afterward. Here, `agent` means an HTTP connection object,
not an analysis subagent. Other providers use `agent:false` to connect directly. Python publishing
follows the same Muse proxy rule.

OpenCode Go fallback accounts are enabled by `PAPER_ANALYZER_FALLBACK_API_KEYS`. Requests initially
use the primary key. Only a confirmed HTTP 429 `GoUsageLimitError` or HTTP 401 `Insufficient balance`
allows a switch to the next configured account within the same logical request. The previous account
is marked as cooling down, and selection never wraps back to an earlier cooled account. An ordinary
authentication 401 stops the run without switching. When all later accounts are unavailable, save the
checkpoint and stop dispatching new requests.

`PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY` adds accounts after the ordinary fallback list and also
accepts comma-separated keys. Once an account succeeds, Node and Python keep using it across requests
and dates; an earlier account leaving cooldown does not trigger a switch back. Ordinary 429, 5xx,
network/proxy failures, truncated Responses output, and content-validation failures do not switch
accounts. `data/runtime/llm-account-pool.json` stores selection and stable credential fingerprints,
not raw keys; it uses `0600` permissions and corruption stops the run. Before attaching credentials,
the request checks that its URL exactly matches the API URL derived from the endpoint and model. Primary and secondary models may share the
account pool only when they belong to the same canonical OpenCode Go service; other services need
separate keys.

arXiv metadata, HTML, PDF, and images require project HTTP CONNECT. HuggingFace curl inherits HTTP(S) proxy and may additionally use SOCKS `ALL_PROXY`. External image/demo redirects are HTTPS-only and revalidate public destination IPs at every hop.

### 4.2 Defaults

| Setting | Default |
|---|---:|
| analysis concurrency | 3 |
| configured filter batch | 5; Muse uses the configured value |
| whole-paper retries / per-stage attempts | 2 / 3 |
| primary / analysis local-repair output | 64,000 / 16,000 tokens |
| single analysis response | 16 MiB |
| primary input | 200,000 characters |
| API Reader output | 48,000 tokens |
| Reader local patch output | 8,000 tokens |
| Reader evidence / total request | 180,000 / 240,000 characters |
| Reader heavy-stage concurrency | 5, bounded 1–5 |
| independent blog-page review concurrency | 5, bounded 1–5 |

OpenAI Responses uses SSE only when `PD_OPENAI_RESPONSES_STREAM=1`. An `incomplete/max_output_tokens` response is a truncation failure, never successful JSON.

## 5. Authoritative State and Recovery

| Current file | Meaning |
|---|---|
| `papers.json` | persistent deduplication database and digest status |
| `fetch-checkpoint.json` | per-source recovery proof |
| `raw-candidates.json` | full filter input |
| `filter-decisions.json` | per-paper decisions and cache |
| `filtered-papers.json` | selected set |
| `deep-analysis-result.json` | Accepted analysis records, stage checkpoints, and publication-eligibility proof |
| `data/runtime/daily-fresh-source-runs/` | immutable official PDF/TXT source generations replayed by daily analysis and publication |
| generation manifest | exact blog-page set and SHA values |
| review receipt | review, Git baseline, and remote publication proof |
| visual manifests | TOP 10 and cover task state |

An archive is usable only after checking that its dates, sources, candidates, decisions, and paper sets
match across files; the existence of the directory alone is not enough.

```bash
npm run digest:prepare -- YYYY-MM-DD
./run-daily-digest.sh YYYY-MM-DD --from review
npm run deep -- --date YYYY-MM-DD
npm run reanalyze -- --concurrency 5
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

Fetching from scratch is restricted to Beijing today. Historical batches resume only from stages accepted by the orchestrator. Never edit checkpoints to manufacture completion.

`deep`, `batch`, `reanalyze`, and `api:reader:refresh` are sealed-source recovery commands: they replay only
the current accepted analysis record's `dailyFreshSourceRun`, including the exact batch date, paper set,
and every TXT, PDF, runtime record and manifest. They never recapture a source or read legacy text/cache.
If source files are missing or no longer match, rerun `npm run digest:prepare -- YYYY-MM-DD` only while
the target date is still Beijing today. For historical dates, retain the failure records and follow
the historical maintenance workflow.

Failures retain manifests, checkpoints, and recovery image lists. An earlier successful body may remain,
but the latest failure requires a retry and is cleared only after a later success. Each paper analysis
holds a normalized-arXiv-ID lock, rereads its current record inside the lock, merges results, and
increments the generation. A stale object read outside the lock must not overwrite that record.

## 6. Blog Transaction

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

`generate` installs the exact pages for the batch and saves a generation manifest. `review` reads the
final files without changing them, runs deterministic, LLM, image, and Hugo checks, saves per-page
checkpoints, and creates a review receipt. `push` permits only the receipt's exact Git delta and
verifies the remote `main` OID after pushing.

A passed page review is reused permanently by relative path and content SHA. Only a change to that
file's content SHA requires another page review. Publisher changes still rerender pages to detect
actual byte changes. A new generation manifest, production proof, model, publisher implementation,
review-protocol fingerprint, or Hugo runtime does not require re-reviewing unchanged page bytes;
rerun the current batch's deterministic/Hugo checks and create a new review receipt. A mismatched
Git baseline, remote name, push-URL identity, or receipt still blocks push. Review workers never
modify reviewed files; findings return to generation or repair.

The remote OID and `remoteVerified` prove that Git publication reached the remote. Before reporting
that the site is live or the task is complete, separately verify successful GitHub Pages build and
deploy for the publication commit, or a later commit that preserves the reviewed page bytes. Manually
check HTTP 200, the official address, and the title of every target digest and paper page, and save
these records. If deployment fails, read its logs, repair the problem, and wait for successful
redeployment. `digest:status` does not yet perform deployment or live-page checks.

During the transition to the new tag system, new pages retain Hugo's flat `tags` field but must also carry
`paper-taxonomy-flat-tags-compat-v1`, the current registry version/SHA, each tag's `concept`/`facet`,
`paper_digest_primary_task`, and `paper_digest_primary_method`. Old pages and tag URLs remain
unchanged. Aggregate “popular directions” count only explicit primary tasks; the site-wide tag list
must identify itself as a mixed index of old and new labels.

Single-paper `--include-id`, exclusions through `--exclude-id`, and historical sealed previews are
explicit maintenance scopes. Their IDs must remain identical across all applicable stages; a
single-paper publication cannot establish full-batch publication or visual completion.

## Historical direct rewrite

Full-history work belongs only in the `audio-paper-digest-rewrite-all` checkout. Its current
`direct-local-first` route prepares sources and private output before independent publication:

```text
retained conference metadata/PDF + frozen historical arXiv links
  → direct-inputs → conference-projections → direct-plan
  → direct-scheduler → direct-run → private pages / direct-aggregate
  → history:direct-publication: plan → generate → review → publish → status
```

Each arXiv generation fetches and seals new official text, PDF, runtime metadata, and a manifest under
`data/runtime/fetched-arxiv-sources/`. Retained arXiv text, PDF, images, old analysis, and old blog prose
are excluded from writing input. Conference entries use their retained metadata/PDF only after SHA
verification. Each paper is analyzed once and used to generate its corresponding historical pages.

The `crosswalk` fallback accepts only named, immutable handoff files from failed fresh arXiv
acquisitions. Unavailable or damaged retained conference sources stop their own direct route; they
do not enter the crosswalk or block the remaining direct queue. The independent publication entry
requires complete source/page coverage, passed reviews, and valid baseline and remote checks.
`activate --apply` is disabled; activation, commit, push, and OID verification run together through
`publish --apply` under the shared blog lock. These capabilities do not establish that a full-history
run or publication has actually completed. See [historical rewriting](docs/history-rewrite.md) and
[independent historical publication](docs/history-direct-publication.md) for exact arguments.

Alternative ICML/OpenReview PDFs are rejected by default. The sole user-authorized cross-title
exception is `conference:icml:2026:openreview-forum-id:n1mAjfRDZ6`. The code allowlist must bind its
poster/forum, fixed SSRN title, authors, DOI, PDF, acquisition receipt, and source SHA. Browser downloads
may enter only through `--import-file`, with `networkResponseObserved: false`. The plan, model input,
and final page must state that this is not camera-ready; the exception cannot be extended to other papers.

## 7. Post-Publication Visuals

Only a remotely verified publication can plan TOP 10 paper infographics and the digest cover. Project scripts manage manifests and validated references; only Codex built-in `image_gen` creates final art.

```bash
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

Reader pages using `ephemeral-no-persisted-figure-assets-v1` retain verified official arXiv HTTPS
image URLs for readers, without copying or caching image bytes. For legacy visual manifests,
`visual:prepare` verifies `.bin` caches and returns absolute paths with actual extensions. Current
daily runs instead verify the official URL, ordinal, DOM SHA, pixel SHA, and MIME, then return empty
`referencedImagePaths`. Image generation uses verified Reader text and never falls back to old caches.

Use only absolute `referencedImagePaths` emitted by `visual:prepare`. Before `record --qa-attested true`,
visually verify the title, Chinese text, relationships, metric directions, values, and ranking. Only
an explicit user request may waive visuals; `digest:waive-visuals` binds that waiver to the current
publication and manifests. Never relabel pending work as complete.

The batch is complete only after data, review, remote publication, deployment, and live-page checks
all pass. Both types of visuals must also be complete, unless a still-valid explicit user waiver
applies to the visuals. Read `digest:status` again after the last push or image record. It is a snapshot and cannot
replace the separate live-site checks.

## 8. Maintenance and Verification

```bash
npm run verify
# Explicitly allow empty data only for CI or a clean checkout:
# npm run verify -- --allow-empty
# Syntax and data checks only; not full verification:
# npm run verify -- --quick
```

Full verification uses Hugo 0.160.1, all JavaScript tests, default and Manual Python tests, repository-wide
syntax checks, and read-only data validation. Reader repair, the three table-input modes, and actual
request usage are covered in [Reader writing](docs/reader-writing.md).

- Reuse `analysis-engine.js` for analysis entry points and shared request wrappers for LLM calls.
- Put Node/Python paths in centralized configuration; use atomic writes and cross-process locks.
- `loadPrompt()` reads the first fenced block. Prompt changes require placeholder, parser, validator, test, SHA, and fingerprint review.
- Logs use millisecond Beijing timestamps, `0600` permissions, and credential redaction.
- Never commit `data/`, `logs/`, `.env`, caches, or secrets.
- Use specific Chinese commit messages that explain reason, scope, and impact.
- Route field-level and troubleshooting questions through [docs/README.md](docs/README.md); do not duplicate Manual internals here.
