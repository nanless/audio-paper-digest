---
name: audio-paper-digest
description: >
  Automated speech/music/audio paper digest skill. Fetches arXiv + HuggingFace Papers, uses environment-variable-configured LLM for filtering and deep analysis,
  outputs structured JSON, and can publish to GitHub Pages blog, WeChat Official Account drafts, Xiaohongshu (Little Red Book) copy, and Feishu (Lark) documents.
  Applicable scenarios: paper digests, paper summaries, daily tracking, re-analysis, blog publishing, WeChat publishing, Xiaohongshu publishing, and Feishu publishing.
---

# Paper Digest Skill (Code Prevails)

English | **[中文](SKILL.md)**

## 1. Document Roles

- `SKILL.md`: Execution rules and safety constraints for the Agent
- `README.md`: Human-run manual (commands, configuration, troubleshooting)
- `prompts/filter.md`: LLM prompt for the filtering stage
- `prompts/deep-analysis.md`: LLM prompt for the deep analysis stage (text-only, output format, tag system, scoring criteria)
- `prompts/image-supplement.md`: Image selection and insertion-plan prompt (dual-model mode; the secondary model outputs JSON only and may add only figure-adjacent lead/explanation text)
- `prompts/opensource-scan.md`: Open source scan prompt (Round 2)
- `prompts/structure-repair.md`: primary-model structural repair used only when required sections are missing
- `prompts/scoring-audit.md`: final type-aware JSON scoring audit after text repair; executed by the primary model only
- `prompts/visual-summary.md`: post-publication Codex prompt for one tall infographic per final-score TOP 10 paper
- `prompts/digest-cover.md`: post-publication prompt for the batch title, hot directions, and TOP 10 digest image

When documents conflict with code, **the current implementation in `scripts/*` prevails; update documents accordingly**.

---

## 2. Actual Workflow

Default daily entry: `./run-daily-digest.sh YYYY-MM-DD`. It uses production Manual v6, pausing only at the human-authored boundaries where the primary Agent must dispatch isolated Terra-high leaf subagents and then continue the complete chain. The production root is `data/current/manual-v6/<date>/`; `manual-v6-shadow` is a separate, unpublishable audit runtime. Use `npm run digest:api -- YYYY-MM-DD` or `./run-daily-digest.sh YYYY-MM-DD --api` only when the user explicitly requests the API/LLM route. Data-only entry: `./run-full-fetch.sh` (or `node scripts/full-fetch.js` / `npm run fetch`).

1. **Auto-archive**: Checks `data/current/deep-analysis-result.json` / `filtered-papers.json` / `analyzed.json`; if their timestamps are earlier than today (Beijing time) and `data/archive/<date>/` does not exist, copies them and deletes the originals. **`papers.json` is NOT archived.**
2. **Load dedup DB**: Reads existing IDs from `data/current/papers.json`; scans the Hugo blog repository (`PAPER_DIGEST_BLOG_REPO`) for published paper arXiv IDs, merging both into a unified deduplication set
3. **arXiv fetch**: 7 categories, checkpointed atomically per category; a resumed run fetches only incomplete categories, and any page or abstract failure keeps that category unhealthy
4. **HuggingFace fetch**: `daily_papers` pagination plus the `papers` supplement, checkpointed independently; incomplete required requests, pagination, or date coverage fail the source for retry
5. **Merge & deduplicate**: arXiv takes priority, HF supplements 7 unique fields, marks `sources`; filters out blog-published papers
6. **LLM filtering**: Checkpoints each definitive per-paper decision. Fetch, raw, decision, and filtered artifacts share fingerprints for source config, historical dedup IDs, and blog-published IDs; healthy raw candidates can resume from zero decisions, while model/prompt changes refilter without refetching
7. **Save filter results**: `data/current/raw-candidates.json` stores filtering input, and `data/current/filtered-papers.json` stores filtered/archive-deduplicated output
8. **Update dedup DB**: Appends all crawled paper IDs to `data/current/papers.json` (not just filtered ones; save early to prevent data loss if interrupted later)
9. **Deep analysis**: `deep-analyzer.js`. Dual-model mode (when `PAPER_ANALYZER_SECONDARY_MODEL` is configured): primary model text-only analysis + secondary model JSON image insertion plan; Single-model mode (no secondary model): text-only analysis. Concurrency of 3 (adjustable via `PD_ANALYSIS_CONCURRENCY`), up to 2 retries per paper (adjustable via `PD_ANALYSIS_MAX_RETRIES`)
10. **Incremental save**: Saves to `data/current/deep-analysis-result.json` immediately after each batch, with failure-result protection (papers with a successful analysis will not be overwritten by a failure result with no analysis); also writes `papers.json.digestStatus` back through `scripts/digest-status.js`
11. **Final merge**: Deduplicates and merges historical results, auto-backing up bak files (retaining the last 10)
12. **Post-publication visual assets**: finish deep analysis for every paper, then generate, review, push, and remotely verify all blog pages. Only after remote `main` matches the publication commit does `push-blog.py` plan one tall infographic for each final-score TOP 10 paper and one batch digest image. Paper posters target roughly 220–360 Chinese characters and must not collapse into slogan-only concept art. If deep analysis selected and fully cached trustworthy paper figures, each task binds at most two references—method overview/architecture/pipeline first, key experiments second—together with caption, MIME, cache path, and SHA. Built-in image generation creates the complete final composition—English title, Chinese explanations, verified numbers, diagrams, captions, and paper-collage artwork—and the result must not be passed through the legacy deterministic text-card compositor. Before record, visually verify every title, statement, arrow relationship, metric direction, and value; regenerate unreadable or materially incorrect assets. Both asset types use a fresh paper-editorial system with warm light backgrounds, restrained low-saturation colors, subtle grain, layered sheets, limited deckled edges and tape accents, soft shadows, and generous whitespace. Dirty vintage paper, crowded scrapbook styling, dark neon, cyberpunk HUDs, metallic frames, and dashboards are prohibited. All generated images for one batch are stored flat in `data/archive/<date>/visual-summaries/`: the cover is `00-digest-cover-<date>.png`, and paper images are `<rank>-<paper-id>-<title-slug>.png`, ordered by manifest rank rather than completion order. A later plan verifies and migrates legacy current/archive layouts. These assets are independently resumable but do not enter or block the completed blog publication transaction

`full-fetch.js` **does NOT auto-publish blog/WeChat**. However, when the user asks to run a dated paper digest, the default intent is the complete workflow in this section. The Agent runs `run-daily-digest.sh` or equivalent separate stages, fixes review blockers, completes push, then uses built-in `image_gen` for every pending paper infographic and digest cover until both visual status gates are complete. WeChat, Feishu, and Xiaohongshu auto-publishing are not part of this default.

### 2.1 Default Production Manual v6 Without Project Model APIs

Production Manual v6 is the default daily workflow, not an automatic fallback from an unavailable model. The project filtering/analysis/review APIs remain disabled unless the user explicitly selects the API route. Codex subagents perform the manual semantic work, while every source, content, publication, and remote-verification gate remains mandatory:

1. `manual_offline` replaces only the filtering-model decision. It does not claim that the filtering API ran.
2. Production Manual v6 replaces the automatic filtering/analysis models with controlled full-text editorial work. Every selected paper must have one isolated author task and independent technical-scoring, readability, revision, and final-page-review provenance. The persistent runner validates exact allowlisted packets, real claim/start times, `gpt-5.6-terra` with high reasoning, outputs, receipts, and task lineage; it never creates a subagent or writes prose. Newly materialized packets include a signed role-specific `outputContract`, and technical-review submission must validate the formal eight-dimension order/ranges, fixed Open Source anchors, eight reasons, complete calibration, and the project semantic-hash algorithm before the task can become validated.
3. Structured full text must close as complete under the current ArtifactIndex parser. PDF/text fallback is incomplete. The revision binder deterministically converts the leaf's article and semantic map into `reader-longform-v2`, injects exact ArtifactIndex tables, binds figures/formulas/terms/related work, and normalizes evidence IDs atomically. It does not invent or rewrite claims.
4. Only when all four production tasks for every paper are validated may `manual:records` seal records v4. `manual:spec` then assembles spec v6 and its Merkle root, and `manual:analyze` writes production canonical with `manualDepth=full-text-evidence-v6`. Shadow artifacts cannot update canonical or `papers.json`, and missing production provenance fails closed rather than falling back to v5.
5. Manual blog review replaces only the semantic review model. New batches require its v3 attestation (v2 is historical compatibility): it binds every generated file and SHA to independent notes plus eight per-file semantic checks, an independent `gpt-5.6-terra` high-reasoning review subagent per page, and ordered per-image `imageFindings` covering caption, adjacent narrative, visible facts, and mobile readability; receipts use `manual_semantic`. Deterministic checks, the generation manifest, Git baseline, review protocol, Hugo gate, normal `push-blog.py`, and remote OID verification remain mandatory.

Manual work is quality- and provenance-compatible with the API route, not a claim of identical execution. Historical v5 records/specs remain readable only through explicit legacy-maintenance paths and cannot satisfy a production-v6 gate. Public articles must not expose internal evidence IDs, evidence-block numbers, scoring-source markers, stage-audit prose, prompt restatements, manual status names, template scaffolding, or repeated boilerplate left by repair templates.

---

## 3. Data Path Conventions

### 3.1 Priority Paths (Current)

| File | Purpose | Archive Behavior |
|------|---------|------------------|
| `data/current/papers.json` | Paper deduplication database with `digestStatus` | **Not archived**, accumulates continuously; `pending_analysis` / `analysis_failed` are not used for strong deduplication; all analysis entry points sync status through `scripts/digest-status.js`; when an older successful analysis is preserved, `latestAttemptStatus` records a later failed attempt |
| `data/current/fetch-checkpoint.json` | Per-source crawl checkpoints bound to candidate fingerprints, paper count, and stable content SHA-256 | Tampering invalidates and refetches only that source |
| `data/current/raw-candidates.json` | Candidate input after merge and blog deduplication, including `sourceHealth` | Rewritten by each full run, useful for debugging filter input |
| `data/current/filter-decisions.json` | Per-paper LLM filter decision cache with reason/rawResponse | Incrementally written after each batch; invalidated when model or prompt hash changes |
| `data/current/filtered-papers.json` | Filtered paper metadata | Archived daily and regenerated |
| `data/current/deep-analysis-result.json` | Core analysis results, including per-stage checkpoints and fingerprints | Persisted after each paper; resumes from the first incomplete or invalidated stage |
| `data/current/visual-summary-manifests/YYYY-MM-DD.json` | Date-isolated final-score TOP 10 infographic state, bound to rank, analysis, prompt, and asset SHA-256 | Only missing, failed, damaged, or invalidated infographics return to pending |
| `data/current/digest-cover-manifests/YYYY-MM-DD.json` | Post-publication digest-image state with deterministic hot-direction and ranking context | Data and prompt fingerprints invalidate only the digest image |
| `data/current/xiaohongshu-oneliners-YYYY-MM-DD.json` | Per-paper Xiaohongshu one-liner cache bound to analysis, prompt, model config, and sanitation contract | Saves each success atomically; only failed or changed papers rerun |
| `data/current/analyzed.json` | Legacy analyzed records (for compatibility) | Archived daily and regenerated |

### 3.2 Compatibility Behavior

Some scripts read from the legacy `data/*.json` paths, but new outputs should be written to `data/current/`. Python publishing entrypoints use `path_config.resolve_deep_analysis_result_path()` to prefer current data and fall back to legacy only when needed.

### 3.3 Archive Directory

`data/archive/<YYYY-MM-DD>/` stores daily archived files by date subdirectory. `deep-analysis-result-<timestamp>.bak.json` backup files are also stored here, automatically cleaned to retain the last 10.

---

## 4. Models & Environment Variables

### 4.1 Unified Storage Location

**All project configuration lives in `the `.env` file in the project root`.**

This means:
- Node scripts read the project-root `.env` through `scripts/env-loader.js` / `loadEnvFile()`
- Python scripts read the project-root `.env` through `scripts/project_env.py`
- Scripts clear inherited project-scoped variables from Trae/Codex/shell before loading the current project's `.env`; inherited outer variables must not be mixed with current project configuration

### 4.2 Filtering Stage (`fetch-papers.js`)

Filtering uniformly calls the LLM specified by `PAPER_ANALYZER_*`:

- endpoint: `PAPER_ANALYZER_ENDPOINT` (required)
- key: `PAPER_ANALYZER_API_KEY` (required)
- model: `PAPER_ANALYZER_MODEL` (required)
- **API protocol auto-routing**: `detectApiType()` in `scripts/utils.js` automatically determines whether to use OpenAI or Anthropic protocol based on the endpoint and model name; see Section 4.2 for the full priority order. DeepSeek is forced to OpenAI, while `token-plan+mimo`, `coding+kimi`, and non-DeepSeek `/anthropic` endpoints use Anthropic
  - **MiMo/Kimi Token Plan / Coding Plan** (endpoint contains `token-plan` or `coding`, model contains `mimo`/`kimi`) → automatically switches to **Anthropic protocol**, masquerading as a Claude Code call
    - **MiMo**: `https://token-plan-cn.xiaomimimo.com/v1` → `https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages` (replaces `/v1` with `/anthropic`)
    - **Kimi**: `https://api.kimi.com/coding/v1` → `https://api.kimi.com/coding/v1/messages` (directly appends `/messages`, no `/anthropic` intermediate path)
    - Headers: `x-api-key` + `anthropic-version: 2023-06-01` + `User-Agent: claude-cli/<version> (external, cli)` (version dynamically obtained from local `claude --version`, falling back to `2.1.108`)
    - system message is automatically extracted as a top-level field in the request body (Anthropic requirement)
  - **Other non-DeepSeek `/anthropic` endpoints** → use Anthropic protocol and append `/messages`
  - **All other cases** (including DeepSeek, MiMo pay-as-you-go, generic OpenAI-compatible endpoints) → uses standard **OpenAI protocol**
    - URL: `/v1/chat/completions`
    - Headers: `Authorization: Bearer {key}`
- **agent: `false`** — LLM API requests explicitly disable connection reuse to prevent the global agent connection pool from being polluted by proxies, which causes MiMo 403 (see 9.2)
- 60s timeout, 5 retries, each retry creates an independent AbortController
- Exponential backoff: filter LLM call `2^attempt * 1s` (2s/4s/8s/16s/32s); arXiv page-fetch 429 rate-limit `60s * 2^(attempt-1)`, other errors linear `5s * attempt`
- Prompt source: `prompts/filter.md`, read at runtime via `loadPrompt()` and replaces `{title}`, `{abstract}`, `{categories}` placeholders
- Judgment criteria: Multimodal models are considered relevant if they clearly involve speech/music/audio (input, output, training objective, evaluation task, or one of the core capabilities)
- Conflict handling: If a paper simultaneously satisfies "multimodal involving speech/music/audio" and "other domain" descriptions, it is prioritized as "yes"

### 4.3 Deep Analysis Stage (`deep-analyzer.js`)

Deep analysis uniformly uses the LLM specified by `PAPER_ANALYZER_*`, **sharing the same API protocol auto-routing logic as the filtering stage**:

- endpoint: `PAPER_ANALYZER_ENDPOINT` (required)
- key: `PAPER_ANALYZER_API_KEY` (required)
- model: `PAPER_ANALYZER_MODEL` (required)
- `detectApiType()` automatically determines the protocol type, behavior consistent with Section 4.2
  - **MiMo**: `/v1` → `/anthropic/v1/messages`
  - **Kimi**: `/coding/v1` → `/coding/v1/messages`

API call characteristics:
- Overall timeout is 20 minutes of active process time. Heartbeat gaps over 30 seconds are treated as system sleep or long suspension and excluded, so wake-up socket errors can retry with the remaining budget.
- max_tokens=64000, temperature=0.7
- **Double-layer retry**: analysis-engine.js level retries up to 2 times per paper (max 3 total attempts); deep-analyzer.js internally retries each API call up to 3 times (exponential backoff: first 10s, then doubles, `2^attempt * 5s`)
- **Fetch proxy is mandatory**: LLM APIs remain direct with `agent: false` and must never receive a proxy agent/dispatcher; arXiv/HuggingFace must fail when the project `.env` proxy is absent rather than falling back to direct access. Node arXiv requires at least one HTTP CONNECT value in `HTTPS_PROXY` or `HTTP_PROXY`, while HuggingFace curl may additionally use SOCKS `ALL_PROXY`; network commands accessing a local proxy must run outside the sandbox.
- arXiv HTML parsing uses **cheerio** structured selectors, removing noise elements such as script/style/nav/header/footer
- Images are first preselected by caption/filename/order heuristics (default `imageCandidateMax=20`); only dual-model mode with a configured secondary model downloads up to `imageMaxCount=20` candidate images serially and sends them to the secondary model. Single-model mode only keeps candidate URL/manifest metadata. Downloads validate Content-Type, Content-Length, and PNG/JPEG/WebP file signatures; defaults are a 60-second per-image timeout (`PD_IMAGE_DOWNLOAD_TIMEOUT_MS`), 6MB raw bytes per image, 8M base64 chars per image, and 20M total base64 chars per paper
- Every analysis stage is recorded in `analysisManifest`. Failed attempts retain `analysisCheckpoint` and a separate `analysisRecoveryImageManifest`. Merge logic validates an older body independently of the latest failed manifest, so repeated failures cannot erase usable content. arXiv HTML/image discovery uses 60 seconds per request and PDF fallback uses 180 seconds; demo pages may follow at most three redirects while revalidating public DNS/IP on every hop. Only strict `{"insertions":[]}` is a valid empty image plan; missing fields, wrong types, and malformed JSON remain retryable failures
- Full text cap is approximately 500K characters (`fullTextMaxChars` in config.js)
- All analysis configurations are centrally managed in `scripts/config.js`, supporting overrides from the project-root `.env`

Output constraints:
- Prompt source: `prompts/deep-analysis.md`, read at runtime via `loadPrompt()` and replaces `{hasFullText}`, `{title}`, `{authors}`, `{categories}`, `{arxivId}`, `{textForAnalysis}` placeholders
- Automatic API canonical fixed headings must remain Chinese because `parseAnalysis` / `parse_analysis` match these anchors: `## 评分`, `## 机器摘要`, `## 标签`, `## 作者与机构`, `## 毒舌点评`, `## 核心摘要`, `## 方法概述和架构`, `## 核心创新点`, `## 实验结果`, `## 细节详述`, `## 评分理由`, `## 局限与问题`, `## 开源详情`. They remain API parser/audit anchors, not the production-v6 reader layout. Production v6 rebuilds the reader body from validated `manualReaderLongform.blocks`; historical v5 pages retain their legacy rendering only in maintenance mode.
- Under `## 评分`, output the total score first (X.X/10)
- **Code post-processing**: `parseAnalysis`/`parse_analysis` extracts eight sub-items (创新性/2, 技术严谨性/1.5, 实验充分性/1.5, 清晰度/1, 影响力/1.5, 开源/1.5, 可复现性/0.5, 工程/实践价值/1.5) from `## 评分理由` to recalculate the total score, capped at 10, rounding to 0.1, overriding the LLM's raw total score
- `## 机器摘要` includes `document_type`, `rank_bucket` (with top-conference mapping), `innovation` (innovation 0-2), `technical_rigor` (technical rigor 0-1.5), `experimental_sufficiency` (experimental sufficiency 0-1.5), `clarity` (clarity 0-1), `impact` (impact 0-1.5), `open_source` (open source 0-1.5), `reproducibility` (reproducibility 0-0.5), `engineering_score` (engineering/practical value 0-1.5), `confidence`, `primary_task_tag`, `primary_method_tag`, and other fixed keys
- Scoring uses an eight-dimensional reviewer system: Innovation (0-2) + Technical Rigor (0-1.5) + Experimental Sufficiency (0-1.5) + Clarity (0-1) + Impact (0-1.5) + Open Source (0-1.5) + Reproducibility (0-0.5) + Engineering/Practical Value (0-1.5), max 11, total capped at 10
- The current rubric version is `type-aware-v1`. `document_type` must be one of 方法研究, 系统技术报告, 模型报告, 数据集与基准, 综述, 理论研究, or 应用研究. Type selects the evidence standard but never changes weights or grants a fixed bonus, floor, or exemption
- Claim-evidence matching and single-issue-single-primary-dimension deduction are mandatory. Missing artifacts, missing reproduction details, insufficient evidence, presentation problems, and technical logic flaws belong to separate dimensions; lower `confidence` when claims cannot be verified
- System/model reports are evaluated through end-to-end quality, latency, throughput, cost, scale, stress testing, fair comparisons, and failure cases. Datasets, surveys, theory, and applied work use their own evidence standards rather than a method-paper ablation template
- After text repair, the shared analysis contract checks all 13 required sections. Missing sections trigger only `prompts/structure-repair.md`, avoiding a full paper-level rerun
- The primary model then runs `prompts/scoring-audit.md` and returns JSON only. Validation errors are fed into the next local audit attempt. With no released core artifact, code deterministically normalizes Open Source to 0.5 for an explicit release promise, 0.2 for demo-only, or 0 otherwise; theory papers are judged by public proofs, derivations, and appendices and are not forced to zero solely because code/model/data flags are absent
- The complete contract is checked again after image insertion. If an insertion plan damages structure or parsing, only that plan is discarded and the audited primary-model text is retained
- Candidate numbers are not display numbers. Code normalizes generic alts and `selectedImageUrls` to final body order. Publish review must preserve valid Markdown continuation rows whose leading group cells are empty
- The secondary image stage must emit detailed `[secondary]` logs: model/protocol/endpoint and key sources, candidate/download counts, safe image labels/MIME/payload sizes, request/response lengths, valid plans, and final selections. Never print API key contents
- Scores are accepted only when all eight dimensions are complete and unique, denominators are correct, and values use at most one decimal; Open Source is restricted to the fixed anchor set
- Tag output must simultaneously include the final tag string, `Primary Task Tag`, `Primary Method Tag`, and `Supplementary Tags`
- Missing information must be written as "Not stated / Not provided / Not mentioned"; guessing author institutions, experimental numbers, open source status, or external information is prohibited
- When modifying `prompts/deep-analysis.md` or `prompts/filter.md`, synchronously check whether the parsing logic in `scripts/utils.js` and `scripts/utils.py` can still match the new output format

### 4.3.1 Dual-Model Mode

When `PAPER_ANALYZER_SECONDARY_MODEL` is configured, dual-model mode is enabled:

- **Primary model** (`PAPER_ANALYZER_*`): text-only deep analysis, using `prompts/deep-analysis.md` (Round 1a)
- **Secondary model** (`PAPER_ANALYZER_SECONDARY_*`): multimodal image selection and insertion planning, using `prompts/image-supplement.md`, requires a vision-capable multimodal model (e.g. `mimo-v2.5`, `gpt-4o`)
- Secondary model's `endpoint`/`key` default to the primary model's values if not set
- If no secondary model is configured, automatically falls back to single-model text-only mode (no image analysis)
- Secondary model tasks: select high-value figures and return at most four value-ranked JSON plans with target section, a code-generated stable `paragraph_id`, lead, and explanation. Invalid IDs and over-limit plans are rejected; free-form anchors are legacy-only. HTML captions enrich candidates, successful downloads use a validated disk cache, and permanent HTTP/MIME/size failures are not retried.
- Every result records text source, original/used/full-text lengths, truncation, SHA-256, warnings, and confidence. Abstract fallback is publication-blocking unless explicitly approved. Scoring audit uses a separate low temperature and persists model, prompt/evidence fingerprints, attempts, and final audit JSON so stale checkpoints can be invalidated precisely.

### 4.4 WeChat Official Account (`publish-wechat-full.py`)

- `WECHAT_APP_ID` and `WECHAT_APP_SECRET` are read from `os.environ`
- `WECHAT_THUMB_MEDIA_ID` (optional): permanent cover image material ID; uses built-in default material if not set
- Image upload: downloads arXiv images → uploads to WeChat CDN → replaces with WeChat URLs. Cache is stored in `wechat-image-cache.json` under the system temp directory
- This script accesses real WeChat APIs; do not execute unless the user explicitly requests generating or uploading an Official Account draft
- **Note**: All publishing scripts uniformly read credentials from environment variables; hard-coding is prohibited

### 4.5 Complete Environment Variable List

```bash
# LLM API (filtering + deep analysis; the following are 4 common configuration options, only one can be enabled at a time)

# Option 1: MiMo Token Plan (recommended, auto-switches to Anthropic protocol by masquerading as Claude Code)
PAPER_ANALYZER_API_KEY=tp-your-token-plan-key
PAPER_ANALYZER_MODEL=mimo-v2.5
PAPER_ANALYZER_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1

# Option 2: MiMo Pay-as-you-go (generic OpenAI protocol)
# PAPER_ANALYZER_API_KEY=sk-your-pay-as-you-go-key
# PAPER_ANALYZER_MODEL=mimo-v2.5
# PAPER_ANALYZER_ENDPOINT=https://api.xiaomimimo.com/v1

# Option 3: Kimi Coding Plan (auto-switches to Anthropic protocol by masquerading as Claude Code)
# PAPER_ANALYZER_API_KEY=sk-your-kimi-key
# PAPER_ANALYZER_MODEL=kimi-for-coding
# PAPER_ANALYZER_ENDPOINT=https://api.kimi.com/coding/v1

# Option 4: Generic OpenAI-compatible endpoint
# PAPER_ANALYZER_API_KEY=sk-your-openai-key
# PAPER_ANALYZER_MODEL=gpt-4o
# PAPER_ANALYZER_ENDPOINT=https://api.openai.com/v1

# Option 5: Dual-model mode (primary text-only + secondary multimodal image selection and insertion plan)
# Primary model config: choose one of options 1-4 above
# Secondary model (optional; if not set, falls back to single-model text-only mode)
# PAPER_ANALYZER_SECONDARY_MODEL=mimo-v2.5
# PAPER_ANALYZER_SECONDARY_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1
# PAPER_ANALYZER_SECONDARY_API_KEY=tp-your-token-plan-key
# Note: secondary endpoint/key default to primary model values if not set

# WeChat Official Account
WECHAT_APP_ID=your-app-id
WECHAT_APP_SECRET=your-app-secret
# Permanent cover image material ID (optional, uses default material if not set)
# WECHAT_THUMB_MEDIA_ID=your-thumb-media-id

# Feishu (Lark) Docs
FEISHU_APP_ID=your-feishu-app-id
FEISHU_APP_SECRET=your-feishu-app-secret

# Blog publishing
# PAPER_DIGEST_BLOG_REPO=~/code/github_repos/audio-paper-digest-blog
# PAPER_DIGEST_BLOG_BASE_PATH=/audio-paper-digest-blog
# PAPER_DIGEST_BLOG_URL=https://nanless.github.io/audio-paper-digest-blog/posts
# PAPER_DIGEST_GITHUB_REMOTE=origin

# WeChat Official Account author (optional)
# PAPER_DIGEST_AUTHOR=your-name

# Configuration overrides (optional)
# Deep analysis concurrency
# PD_ANALYSIS_CONCURRENCY=3
# Deep analysis retry count
# PD_ANALYSIS_MAX_RETRIES=2
# Re-analysis concurrency (defaults to ANALYSIS_CONFIG.concurrency)
# PD_REANALYZE_CONCURRENCY=3
# LLM filtering batch size
# PD_FILTER_BATCH_SIZE=5
# arXiv fetch count per category
# PD_ARXIV_MAX_RESULTS=100
# PD_ARXIV_PDF_MAX_BYTES=52428800
# PD_SCORING_AUDIT_TEMPERATURE=0.1
# PD_IMAGE_PLAN_TEMPERATURE=0.2

# Fetch proxy (required): configure at least one of HTTPS_PROXY or HTTP_PROXY as an HTTP CONNECT URL
# HTTPS_PROXY=http://127.0.0.1:7897
# HTTP_PROXY=http://127.0.0.1:7897
# HuggingFace curl may additionally use SOCKS; LLM requests stay direct with agent:false
# ALL_PROXY=socks5h://127.0.0.1:7897
```

**API Protocol Auto-Routing Overview**:

| Endpoint Contains | Model Contains | Protocol | URL Conversion |
|-------------------|---------------|----------|----------------|
| `deepseek.com` or model contains `deepseek` | — | OpenAI | `/anthropic` → `/v1/chat/completions` (highest priority) |
| `token-plan` | `mimo` | Anthropic | `/v1` → `/anthropic/v1/messages` |
| `coding` | `kimi` | Anthropic | `/coding/v1` → `/coding/v1/messages` |
| `/anthropic` | — | Anthropic | `{base}/messages` |
| Any other | Any other | OpenAI | `/v1/chat/completions` |

Endpoint configuration format is uniformly `protocol://domain/v1`, regardless of which protocol is used subsequently.

---

## 5. Common Commands (Currently Available)

```bash
cd /Users/francis7999/code/github_repos/audio-paper-digest

# Default deterministic daily stages; Codex continues with built-in image generation
npm run digest:prepare -- YYYY-MM-DD
# Resume after fixing review blockers
./run-daily-digest.sh YYYY-MM-DD --from review

# Data pipeline only (fetch + filter + deep analysis)
npm run fetch
# or ./run-full-fetch.sh

# Run only after every blog page is published and the remote OID is verified.
npm run visual:post-publish -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD

# Deep analysis resume only (skips papers with existing analysis)
npm run deep

# Full re-analysis (defaults to reading data/current/deep-analysis-result.json)
npm run reanalyze

# Re-analysis with specified concurrency
node scripts/reanalyze.js --concurrency 3 data/current/deep-analysis-result.json

# Run unit tests
npm test

# Quick fetch test (fetch + filter only, no analysis, outputs data/quick-test-result.json)
node scripts/quick-test.js

# Batch analyze unanalyzed papers (based on deep-analysis-result.json)
npm run batch

# Re-filter & re-analyze papers by date
node scripts/refilter-reanalyze-by-date.js 2026-07-01

# Analyze a single paper (command line argument)
node scripts/analyze-single-paper.js 2604.16044

# Backfill historical paper IDs (no deep analysis)
npm run backfill

# Publish blog (explicitly specifying date is recommended)
npm run blog:generate -- --date YYYY-MM-DD

# Strictly review generated Markdown, then verify the receipt and push it
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD

# Publish with custom data file
npm run blog:generate -- --date YYYY-MM-DD data/current/deep-analysis-result.json

# Generate WeChat Official Account draft (defaults to reading data/current/deep-analysis-result.json)
npm run wechat

# Generate Xiaohongshu copy (defaults to TOP 5 curated version)
npm run xiaohongshu
npm run xiaohongshu -- --top 7     # Specify TOP N
npm run xiaohongshu -- --all       # Full summary version
npm run xiaohongshu -- --date 2026-04-22
```

**Xiaohongshu Publishing Tips:**

- Xiaohongshu single post body limit is approximately 1000 characters; curated mode defaults to TOP 5 (use `--top 3` to adjust), with roughly 800-950 characters, suitable for direct single-post publishing
- TOP-N one-liners default to concurrency 5 and can be configured from 1 to 5 with `PD_XIAOHONGSHU_ONELINER_CONCURRENCY`; completion order never changes ranking order, and failures fall back per paper
- Each success is checkpointed under a per-date lock. Corrupt caches are atomically quarantined and rebuilt; only exact fingerprint matches are reused, and `--date` must be strict `YYYY-MM-DD`. This workflow generates copy only
- **The one-sentence introduction for each paper is generated by the publishing-stage LLM API** (via `publish_common.py` protocol routing, bypassing proxy); falls back to local `extract_one_liner()` on LLM failure (prioritizes the first innovation item, then a sentence in summary containing "proposes/solves/aims to", then roast)
- The script automatically cleans Markdown formatting (`**bold**`, `` `code` ``) and academic prefixes ("This paper aims to", "This paper addresses", etc.) to avoid platform rendering issues
- Copy automatically includes emoji heat indicators: 🔥≥8 pts, ✅≥6 pts, 📝<6 pts (consistent with blog and WeChat)
- Fixed blog link and open source repository link appended at the end; tags and `---` separators are not output
- `--all` mode outputs one full summary copy, suitable for manual splitting or self-selecting highlights for publishing

---

## 6. Publishing Behavior & Date Safety

Blog entry points: `scripts/generate-blog.py` → `scripts/review-blog.py` → `scripts/push-blog.py`. `scripts/publish-to-blog.py` remains only as a generation compatibility entry and shared implementation.

### Core Principle: Blog Date = Crawl/Analysis Date, ≠ arXiv Upload Date

- The `published` field is the paper's original publication date on arXiv, which may be earlier than today
- **The blog's `YYYY-MM-DD` date represents the "crawled and analyzed today" batch**, not the paper's original publication date
- `deep-analysis-result.json` may contain both newly analyzed papers for the day and previously preserved merged results; blog, WeChat, Feishu, and Xiaohongshu publishing filter by immutable `fetchBatchDate`/`batchDate` first and strict Beijing `fetchedAt` only for legacy records, so only papers matching the batch date are published under that date

Current behavior:

- Defaults to reading `data/current/deep-analysis-result.json`
- **Filters by batch date**: uses `fetchBatchDate`/`batchDate` first and falls back to strict Beijing `fetchedAt` only for legacy records; only papers matching the `--date` specified date (defaults to today) are published, preventing historical data from being republished
- Generates in `~/code/github_repos/audio-paper-digest-blog/content/posts`:
  - Summary page: `YYYY-MM-DD.md`
  - Single paper page: `YYYY-MM-DD-<slug>.md`
- Generation, review, and push are separate and share both date-level and repository-global locks. Generation journals each page; review checkpoints the SHA actually read and blocks changes across the Hugo gate. Push compares every staged index blob/deletion against the receipt after `git add` and again before commit, preventing cross-date worktree/index/HEAD contamination.
- **All three stages and compatibility `publish-to-blog.py` must run outside the sandbox**. The entry points reject the reliable sandbox marker `CODEX_SANDBOX`; the elevation wrapper preserves the network-disabled marker, so it cannot independently reject an external runtime. Review directly reaches the LLM, downloads images, and runs Hugo, while push requires real Git networking. Do not bypass review, fabricate a receipt, or use a no-network fallback inside a sandbox.
- To publish all papers (no filtering), pass `--all` explicitly

Agent execution constraints:

- A request to run a dated paper digest is itself explicit authorization for the complete chain, including `push-blog.py`; only requests explicitly limited to generation, review, preview, checking, or diagnosis stop before push. Push requires an unchanged strict review receipt, the blog repository on `main`, manifest-only staging, an explicit `HEAD:main` push, and remote OID verification.
- If only checking format, verifying new fields, or previewing artifacts, triggering a real `git push` is prohibited

Pre-publish safeguards:

- `full-fetch.js` automatically archives and moves yesterday's `deep-analysis-result.json`, `filtered-papers.json`, and `analyzed.json` when run daily, ensuring `data/current/` only contains newly fetched papers for the day
- Publishing filters by `fetchBatchDate`/`batchDate` first and legacy `fetchedAt` second; still keep `data/current/` clean so validation, review, and `--all` publishing do not mix batches accidentally

### Correct Procedure for Re-running / Fixing the Same Day

If the day's results need to be resumed or re-run:

1. If today's complete filtered artifact matches the current filter fingerprint, keep it and run `node scripts/full-fetch.js` to resume deep analysis. If only the filter model, prompt, or protocol settings changed while healthy raw candidates still match, the workflow refilters without refetching.
2. If filtering is incomplete but `data/current/filter-decisions.json` is from today and matches the current model/prompt hash, run `node scripts/full-fetch.js` to reuse existing per-paper decisions.
3. To force a full refetch/refilter, also delete `data/current/fetch-checkpoint.json` together with raw candidates, decisions, filtered papers, and deep-analysis results.
4. **Restore `papers.json` to yesterday's state only when necessary** (recommended over deleting IDs one by one):
   ```bash
   # Replace dedup DB with yesterday's backup (generated by backupPapersJson, format is papers-YYYY-MM-DD.json)
   cp data/archive/papers-2026-04-21.json data/current/papers.json
   ```
5. Delete all `content/posts/YYYY-MM-DD-*.md` files in the blog repository for the day
6. Re-run `node scripts/full-fetch.js`

**Special Scenario — Filtering Stage API Completely Fails:**
- Retryable or indeterminate decisions keep filtering incomplete and are not cached as definitive decisions. The main workflow stops before committing the incomplete batch as `complete` and can resume from matching per-paper decisions.
- Do not restore `papers.json` merely because filtering failed. Inspect `lastUpdated`, batch status, and backups first; restore only when a verified write from an invalid run actually needs to be reverted.

**Key Lesson — Must Check `lastUpdated` Before Restoring `papers.json`:**

After the first run is interrupted, do not blindly restore any backup! You must first confirm the state of `papers.json`:

```bash
# Check papers.json last update time
ls -la data/current/papers.json
# Or read the lastUpdated field
cat data/current/papers.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('lastUpdated'))"
```

Judgment rules:
| `papers.json` `lastUpdated` | Correct Action |
|-----------------------------|----------------|
| **Today** (e.g., `2026-04-23T03:09:03`) | **Do NOT restore!** It is already in the latest state; prefer today's complete `filtered-papers.json` / `filter-decisions.json` resume path |
| **Yesterday or earlier** | Can restore backup: `cp data/archive/papers-YYYY-MM-DD.json data/current/papers.json` |

Recommended check command (optional):

```bash
python3 - <<'PY'
import json
from collections import Counter
with open('data/current/deep-analysis-result.json') as f:
    d = json.load(f)
papers = d.get('papers', [])
dates = [p.get('fetchedAt', '')[:10] for p in papers if p.get('fetchedAt')]
print('Total papers:', len(papers))
print('fetchedAt batch date distribution:', Counter(dates))
PY
```

---

## 7. Logging & Runtime Characteristics

- Node/Python executable scripts write UTF-8 plain text to both terminal and unique `logs/<script>-YYYYMMDD-HHMMSS-<pid>-<seq>.log` files with `0600` permissions by default
- `PD_ENABLE_FILE_LOGS=1` / `PAPER_DIGEST_ENABLE_FILE_LOGS=1` remain compatible, but are no longer required for log creation
- File logs have no count, total-size, or per-file-size limit and old logs are not cleaned automatically
- `backfill_papers.py` uses the same unified per-run log and no longer appends a duplicate `logs/backfill.log`
- Authentication headers, cookies, tokens, secrets, passwords, actual configured key values, and URL userinfo are centrally redacted
- Major Node scripts have handled background stdout buffering (`setBlocking`) for real-time progress viewing
- `full-fetch.js` / `deep-analysis-only.js` / `batch-analyze.js` use retry and incremental saving to reduce data loss risk from interruptions
- `full-fetch.js` also holds a single-run lock across archive, cleanup, filtering, and final merge while retaining configured paper-analysis concurrency; random owner tokens prevent an old owner from releasing a replacement lock
- `reanalyze.js` saves intermediate results every 5 papers (save interval auto-adjusted in concurrent mode)
- `npm run validate:data` performs read-only validation for current `papers.json`, `raw-candidates.json`, `filter-decisions.json`, `filtered-papers.json`, and `deep-analysis-result.json`, including candidate stats, filter-count consistency, and full candidate-set coverage when filter decisions are complete; it does not repair data and exits non-zero on problems. A clean checkout with no runtime data may use `npm run validate:data -- --allow-empty`; CI uses that explicit empty-data mode while unit fixtures cover non-empty validation
- `full-fetch.js` auto-backs up bak files to `data/archive/`, retaining the last 10
- `full-fetch.js` auto-backs up `papers.json` to `data/archive/papers-<date>.json`, retaining the last 7 days

---

## 8. Agent Execution Rules (Strong Constraints)

1. **Check before modifying**: Read relevant scripts to confirm current behavior before updating documents or executing commands.
2. **Confirm date for publishing**: Ask the user when the date is not explicitly specified; do not default to "today".
3. **Prohibit dangerous operations**: Do not execute `git reset --hard`, `git push -f`, or batch deletion of historical articles without explicit authorization.
4. **Complete the default dated-digest intent**: "Run the paper digest for a given date" explicitly authorizes blog publication and requires fetch, filter, deep analysis, blog generation, review/fixes, push, TOP 10 paper infographics, the digest cover, and final status gates. Do not stop at an intermediate stage. A request limited to `full-fetch.js`, analysis, diagnosis, preview, or inspection does not authorize publishing. WeChat, Feishu, and Xiaohongshu auto-publishing remain outside the default.
5. **Leave a trace after changes**: After process, parameter, or path changes, synchronously update `SKILL.md`, `SKILL.en.md`, `README.md`, `AGENTS.md`, and relevant `docs/` files.
6. **Prohibit hard-coded keys**: Do not write real API keys in any script or document; all credentials (LLM, WeChat Official Account, Feishu) live in `the `.env` file in the project root` and are loaded through the project env loader.
7. **Prevent security mechanism breakage when modifying scripts**: This environment silently replaces sensitive characters such as `API_KEY` with `***`. When modifying scripts containing such characters, you must re-read the file after modification to verify that key lines were not corrupted. Also periodically check whether `data/`, `logs/` directories contain residual backup files or log snapshots with keys, and clean them immediately if found.
8. **Unified environment variable management**: When new scripts need to read LLM configuration, uniformly use `PAPER_ANALYZER_API_KEY`, `PAPER_ANALYZER_MODEL`, and `PAPER_ANALYZER_ENDPOINT` from the project `.env`, and reuse Node `scripts/env-loader.js` or Python `scripts/project_env.py`; alias fallback chains, hard-coding, base64-encoded variable name hacks, or inherited shell/Codex/Trae variables as project configuration are prohibited.
8.1 **Run every script outside the sandbox**: Every direct `scripts/*.js`, `scripts/*.py`, `run-daily-digest.sh`, `run-full-fetch.sh`, and `scripts/*.sh` invocation requires external runtime permissions. The Node/Python shared environment loaders and shell entries fail before business logic, logging, networking, or writes when they detect `CODEX_SANDBOX`; do not substitute a sandbox command, disable the check, or fabricate results. Unit-test module imports do not trigger this guard.
9. **New configurable parameters and runtime data paths go in shared config**: New Node scripts with adjustable parameters (concurrency, timeout, batch size, etc.) or `data/current/*.json` runtime data files must place/reuse them in `scripts/config.js` (runtime data paths via `Config.FILES`) and add project `.env` overrides for parameters when needed; new Python publish/maintenance scripts with shared paths must reuse `scripts/path_config.py` instead of hand-writing default `data/current/*.json` paths again.
10. **New analysis scripts reuse analysis-engine.js**: When adding paper analysis-related scripts, prioritize reusing `analyzeBatch()` / `analyzePaperWithRetry()` from `analysis-engine.js` to avoid re-implementing retry, parsing, and saving logic; after saving results, sync `papers.json.digestStatus` through `scripts/digest-status.js`.
11. **Never merge the three blog stages**: `generate-blog.py` only generates and records a manifest; `review-blog.py` only performs strict LLM/image review plus the Hugo gate and writes a per-file SHA-256 receipt; `push-blog.py` only validates that receipt and commits/pushes. Push must never regenerate or re-run review. A request to run a dated paper digest is explicit push authorization; other requests still require explicit publication authorization.
11.1 **Run blog publishing outside the sandbox**: Agents must use external runtime permissions for `generate-blog.py`, `review-blog.py`, `push-blog.py`, and compatibility `publish-to-blog.py`. A Codex sandbox rejection is an execution-environment failure, not a content failure; do not retry there or bypass LLM/image/Hugo/Git checks.
12. **Output contract changes must sync parser**: If modifying `## 机器摘要` key names, section order, or tag output format in `prompts/deep-analysis.md`, you must synchronously check the parsing logic in `scripts/utils.js` and `scripts/utils.py`.
13. **Artifact-level verification required after changes**: At minimum, spot-check one `data/current/deep-analysis-result.json` to confirm the `analysis` machine summary contains `document_type`, `rank_bucket`, `primary_task_tag`, and `primary_method_tag`, and the `parsed` cache contains `documentType`, `scoringRubricVersion`, `rankBucket`, `primaryTaskTag`, and `primaryMethodTag`; then run blog/social media scripts to verify final artifacts.
14. **Verify prompt loading after changes**: After modifying markdown files in the `prompts/` directory, run a quick test (`node scripts/quick-test.js` or single-paper analysis) to confirm `loadPrompt()` can correctly read and replace placeholders without `{variableName}` residue.
15. **Run unit tests after changes**: After modifying `scripts/utils.js`, `scripts/config.js`, or core analysis engine logic, you must run `npm test` to ensure tests pass.
16. **MiMo API requests must disable proxy connection reuse**: Every Node LLM call, including `test-api-key.js`, must set `options.agent` to `false` (not `undefined`). During refactoring, changing it back to `proxyAgent` or `undefined` is prohibited because MiMo Token Plan can return 403 in environments with system proxies.
17. **New LLM endpoints must integrate API protocol auto-routing**: Any new script calling an LLM must uniformly use `detectApiType()`, `buildApiUrl()`, `buildHeaders()`, `buildRequestBody()`, `parseResponseText()` from `scripts/utils.js`; hard-coding specific protocol URLs/Headers/Bodies is prohibited.
18. **Sync the full pipeline when modifying API protocol routing logic**: When modifying `detectApiType()` judgment rules or `buildApiUrl()`/`buildHeaders()` and other functions, you must synchronously check `fetch-papers.js`, `deep-analyzer.js`, and all scripts using `analysis-engine.js` (`full-fetch.js`, `reanalyze.js`, `batch-analyze.js`, `deep-analysis-only.js`, `analyze-single-paper.js`) to ensure consistent behavior across the full pipeline.
19. **Prohibit committing sensitive files to version control**: `data/`, `logs/`, `*.env`, `*.backup*`, cache files, log archives containing keys, etc. are strictly forbidden from entering git; before committing, confirm `.gitignore` is correctly configured and that no historically leftover sensitive files exist in the repository.
20. **CI checks**: CI runs serial `npm test`, `npm run validate:data -- --allow-empty`, JS syntax checks, Python `py_compile`, Python unit tests, and shell syntax checks. When adding special file types, update `.github/workflows/ci.yml` accordingly.
21. **Use Beijing-time timestamps for runtime data**: Use `getBeijingISOString()` when writing `timestamp` / `lastUpdated` / `fetchedAt`; Python publishing code should use `now_bj_iso()` / `now_bj_date()` to avoid UTC dates causing cross-day archiving or publish filtering mistakes.
22. **Commit messages must be detailed Chinese**: Commit messages must be written in Chinese and explain the main changes and impact scope; avoid vague one-liners such as "fix" or "update".

---

## 9. Minimal Troubleshooting Guide

### 9.1 Model Call Failure / API Returns 401 / 403 / Timeout

**Check steps**:

1. **Check if the key/endpoint/model triplet matches**
   | Plan Type | Endpoint | Key Prefix | Protocol |
   |-----------|----------|------------|----------|
   | MiMo Token Plan | `token-plan-cn.xiaomimimo.com/v1` | `tp-` | Anthropic (auto-switch) |
   | MiMo Pay-as-you-go | `api.xiaomimimo.com/v1` | `sk-` | OpenAI |
   | Kimi Coding Plan | `api.kimi.com/coding/v1` | `sk-kimi-...` | Anthropic (auto-switch) |
   | Generic OpenAI | Custom endpoint | `sk-...` | OpenAI |

   - MiMo Token Plan key prefix is `tp-`, must be paired with the Token Plan endpoint; mixing the two will definitely return 401
   - Ensure the key/endpoint/model triplet in the current project-root `.env` comes from the same provider; do not rely on `.zshrc` or outer shell variables

2. **Check if the correct protocol is being used** (search logs for `[filter] API type: xxx` or `[api] → model | xxx` lines)
   - If using MiMo/Kimi Token Plan but it shows `openai`, check if the endpoint contains `token-plan` or `coding`, and if the model contains `mimo` or `kimi`
   - If logs show `anthropic` but it still fails, check if the path is `/anthropic/v1/messages` (not `/v1/chat/completions`)

3. **Anthropic protocol specific checks** (when logs show `anthropic`)
   - Is the request header `x-api-key` (not `Authorization: Bearer`)
   - Does it include `anthropic-version: 2023-06-01`
   - Does it include `User-Agent: claude-cli/<version> (external, cli)` (logs won't directly show this, verify with proxy tools)

4. **OpenAI protocol specific checks** (when logs show `openai`)
   - Confirm using `Authorization: Bearer {key}`
   - Confirm URL path is `/v1/chat/completions`

5. **Check proxy** (see Section 9.2)
   - MiMo Token Plan may be blocked when a system proxy is present
   - Try testing with `curl --noproxy "xiaomimimo.com"` to bypass proxy

6. **Check logs**: `logs/full-fetch-*.log`, `logs/deep-analyzer-*.log`

### 9.2 MiMo API Returns 403 Illegal Access / Timeout / Socket Hang Up

**Root cause**: Node.js `https.request` with `agent: undefined` still reuses the global default agent's connection pool. When a system proxy is configured (`https_proxy` etc.), connections from the global agent may be polluted by the proxy, causing the MiMo Token Plan server to reject requests.

**Fix**: Every Node LLM request, including the API test script, must set `options.agent` to `false` (not `undefined`), completely disabling connection reuse and forcing each request to establish a new connection:

```javascript
const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: headers,
    agent: false,  // ← must be false, undefined is ineffective
    signal: controller.signal
};
```

**Verification**: Test directly with `curl --noproxy "xiaomimimo.com"`; if bypassing the proxy succeeds while the script fails, this is the issue.

### 9.3 Deep Analysis Slow or Frequently Failing

- Check logs: `logs/deep-analyzer-*.log`, `logs/full-fetch-*.log`
- Check if the key/endpoint/model triplet matches (see Section 9.1)
- If timeout occurs, the script will automatically downgrade to pure text retry; if it still fails, check proxy or reduce concurrency
- `node scripts/deep-analysis-only.js` can be safely used to resume

### 9.4 No Changes to Push After Publishing

Check in the blog repository:
```bash
cd ~/code/github_repos/audio-paper-digest-blog
git status --short
ls -lt content/posts | head -20
```

### 9.5 Path Confusion

Prefer using `data/current/deep-analysis-result.json`; only read from old paths in compatibility scenarios.

### 9.6 Re-analysis Startup Reports Key Not Set

- Configure `PAPER_ANALYZER_API_KEY`, `PAPER_ANALYZER_MODEL`, and `PAPER_ANALYZER_ENDPOINT` in `the `.env` file in the project root`
- Re-run the script; do not rely on `.zshrc` / Trae / Codex outer environment variables to fill project configuration

### 9.7 WeChat Official Account Publishing Failure

- Check whether `WECHAT_APP_ID` / `WECHAT_APP_SECRET` are written to `the `.env` file in the project root`
- Check if `APP_SECRET` has expired
- Check if images are too large or restricted by arXiv
- WeChat image upload has rate limits; large numbers of images may need to be executed in batches

### 9.8 HuggingFace Fetch Empty

- Check that project `.env` configures at least one of `HTTPS_PROXY` or `HTTP_PROXY` as an HTTP CONNECT address; optionally configure `ALL_PROXY=socks5h://127.0.0.1:7897` for curl
- Run the command outside the sandbox. Sandbox loopback cannot reach a local proxy and is not a HuggingFace diagnostic
- `fetch-huggingface-papers.js` uses `curl`; missing project proxy configuration now fails explicitly instead of returning a pseudo-success empty batch

### 9.9 Verify API Routing Changes

When modifying `detectApiType()` or `buildApiUrl()`, the following test script must be used to verify both endpoints work:

```bash
# Plain text test
node -e "
const u = require('./scripts/utils.js');
const cases = [
  ['MiMo', 'https://token-plan-cn.xiaomimimo.com/v1', 'mimo-v2.5'],
  ['Kimi', 'https://api.kimi.com/coding/v1', 'kimi-for-coding'],
  ['OpenAI', 'https://api.openai.com/v1', 'gpt-4o']
];
for (const [name, ep, model] of cases) {
  const t = u.detectApiType(ep, model);
  const url = u.buildApiUrl(t, ep);
  console.log(name + ': ' + t + ' -> ' + url);
}
"
```

Ensure output matches expectations:
- MiMo → `anthropic` → `.../anthropic/v1/messages`
- Kimi → `anthropic` → `.../coding/v1/messages` (no `/anthropic` intermediate path)
- OpenAI → `openai` → `.../v1/chat/completions`

**Important experience**: Kimi and MiMo have different Anthropic URL structures; branch handling is required when modifying `buildApiUrl()`.

### 9.10 Background full-fetch Interrupted by SIGTERM (exit code 143)

**Root cause**: npm scripts attempt to access TTY interaction in background mode, causing bash errors and terminating the process.

**Fix**: Use direct Node commands when running in background, bypassing npm:
```bash
# ❌ Avoid using in background mode
npm run fetch

# ✅ Recommended way to run in background
node scripts/full-fetch.js
```

If interrupted during the filtering stage, handle according to Section 6 "Correct Procedure for Re-running / Fixing the Same Day":
1. Check if `papers.json`'s `lastUpdated` is today (see Section 6 judgment matrix)
2. If today, do not restore papers.json; prefer resuming from today's `status: complete` `filtered-papers.json` when the filter model/hash match, and delete `filtered-papers.json` only when forcing a full refilter
3. If yesterday or earlier, restore `papers.json` backup and re-run

---

## 10. Related Entrypoints

This repository does not currently contain a standalone `references/` sub-skill directory, nor legacy entrypoints such as `scripts/fetch_papers.py` or `main.py`. Use the Node/Python scripts listed in Section 3 as the source of truth. New conference or special-topic flows should be explicitly registered in their branch-specific docs.
