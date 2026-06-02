---
name: audio-paper-digest
description: >
  Automated speech/music/audio paper digest skill. Fetches arXiv + HuggingFace Papers, uses environment-variable-configured LLM for filtering and deep analysis,
  outputs structured JSON, and can publish to GitHub Pages blog, WeChat Official Account drafts, and Xiaohongshu (Little Red Book) copy.
  Applicable scenarios: paper digests, paper summaries, daily tracking, re-analysis, blog publishing, WeChat publishing, and Xiaohongshu publishing.
---

# Paper Digest Skill (Code Prevails)

English | **[中文](SKILL.md)**

## 1. Document Roles

- `SKILL.md`: Execution rules and safety constraints for the Agent
- `README.md`: Human-run manual (commands, configuration, troubleshooting)
- `prompts/filter.md`: LLM prompt for the filtering stage
- `prompts/deep-analysis.md`: LLM prompt for the deep analysis stage (output format, tag system, scoring criteria)

When documents conflict with code, **the current implementation in `scripts/*` prevails; update documents accordingly**.

---

## 2. Actual Workflow

Main entry: `./run-full-fetch.sh` (or `node scripts/full-fetch.js` / `npm run fetch`)

1. **Auto-archive**: Checks `data/current/deep-analysis-result.json` / `filtered-papers.json` / `analyzed.json`; if their timestamps are earlier than today (Beijing time) and `data/archive/<date>/` does not exist, copies them and deletes the originals. **`papers.json` is NOT archived.**
2. **Load dedup DB**: Reads existing IDs from `data/current/papers.json`; scans the Hugo blog repository (`PAPER_DIGEST_BLOG_REPO`) for published paper arXiv IDs, merging both into a unified deduplication set
3. **arXiv fetch**: 7 categories, up to 100 papers each (adjustable via `PD_ARXIV_MAX_RESULTS`), stops early if 20 consecutive existing IDs are encountered (dedup set includes papers.json + blog-published IDs)
4. **HuggingFace fetch**: `daily_papers` pagination (up to 20 pages) + `papers` API supplement, defaulting to the last 7 days, excluding IDs in the dedup set
5. **Merge & deduplicate**: arXiv takes priority, HF supplements 7 unique fields, marks `sources`; filters out blog-published papers
6. **LLM filtering**: Uses `PAPER_ANALYZER_*` config to judge speech/music/audio relevance paper by paper, `batchSize=5` (adjustable via `PD_FILTER_BATCH_SIZE`), 60s timeout per paper, 3 retries
7. **Save filter results**: `data/current/filtered-papers.json`
8. **Deep analysis**: `deep-analyzer.js`, full text + images, concurrency of 3 (adjustable via `PD_ANALYSIS_CONCURRENCY`), up to 2 retries per paper (adjustable via `PD_ANALYSIS_MAX_RETRIES`)
9. **Incremental save**: Saves to `data/current/deep-analysis-result.json` immediately after each batch, with failure-result protection (papers with a successful analysis will not be overwritten by a failure result with no analysis)
10. **Update dedup DB**: Appends new paper IDs to `data/current/papers.json`, auto-backing up papers.json (retaining the last 7 days)
11. **Final merge**: Deduplicates and merges historical results, auto-backing up bak files (retaining the last 10)

`full-fetch.js` **does NOT auto-publish blog/WeChat**; publishing requires running Python scripts separately.

---

## 3. Data Path Conventions

### 3.1 Priority Paths (Current)

| File | Purpose | Archive Behavior |
|------|---------|------------------|
| `data/current/papers.json` | Paper deduplication database | **Not archived**, accumulates continuously |
| `data/current/filtered-papers.json` | Filtered paper metadata | Archived daily and regenerated |
| `data/current/deep-analysis-result.json` | Core analysis results (includes analysis / parsed / imageUrls) | Archived daily and regenerated |
| `data/current/analyzed.json` | Legacy analyzed records (for compatibility) | Archived daily and regenerated |

### 3.2 Compatibility Behavior

Some scripts read from the legacy `data/*.json` paths, but new outputs should be written to `data/current/`.

### 3.3 Archive Directory

`data/archive/<YYYY-MM-DD>/` stores daily archived files by date subdirectory. `deep-analysis-result-<timestamp>.bak.json` backup files are also stored here, automatically cleaned to retain the last 10.

---

## 4. Models & Environment Variables

### 4.1 Unified Storage Location

**All environment variables are stored in `the `.env` file in the project root`.** `.zshrc` is configured as:
```zsh
set -a; source the `.env` file in the project root 2>/dev/null; set +a
```

This means:
- All variables are automatically injected on shell startup
- Python scripts read directly via `os.environ`
- Node scripts have a secondary fallback via `loadEnvFile()` (only fills in unset variables)

### 4.2 Filtering Stage (`fetch-papers.js`)

Filtering uniformly calls the LLM specified by `PAPER_ANALYZER_*`:

- endpoint: `PAPER_ANALYZER_ENDPOINT` (required)
- key: `PAPER_ANALYZER_API_KEY` (required)
- model: `PAPER_ANALYZER_MODEL` (required)
- **API protocol auto-routing**: `detectApiType()` in `scripts/utils.js` automatically determines whether to use OpenAI or Anthropic protocol based on the endpoint and model name
  - **MiMo/Kimi Token Plan / Coding Plan** (endpoint contains `token-plan` or `coding`, model contains `mimo`/`kimi`) → automatically switches to **Anthropic protocol**, masquerading as a Claude Code call
    - **MiMo**: `https://token-plan-cn.xiaomimimo.com/v1` → `https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages` (replaces `/v1` with `/anthropic`)
    - **Kimi**: `https://api.kimi.com/coding/v1` → `https://api.kimi.com/coding/v1/messages` (directly appends `/messages`, no `/anthropic` intermediate path)
    - Headers: `x-api-key` + `anthropic-version: 2023-06-01` + `User-Agent: claude-cli/<version> (external, cli)` (version dynamically obtained from local `claude --version`, falling back to `2.1.108`)
    - system message is automatically extracted as a top-level field in the request body (Anthropic requirement)
  - **All other cases** (including MiMo pay-as-you-go, generic OpenAI-compatible endpoints) → uses standard **OpenAI protocol**
    - URL: `/v1/chat/completions`
    - Headers: `Authorization: Bearer {key}`
- **agent: `false`** — LLM API requests explicitly disable connection reuse to prevent the global agent connection pool from being polluted by proxies, which causes MiMo 403 (see 9.2)
- 60s timeout, 3 retries, each retry creates an independent AbortController
- Exponential backoff: fetch 4s/8s/16s (`2^attempt * 2s`, cap 60s), rate limit 10s/20s/40s (`2^attempt * 5s`, cap 60s)
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
- Overall timeout 20 minutes (AbortController)
- max_tokens=64000, temperature=0.7
- **Double-layer retry**: analysis-engine.js level retries up to 2 times per paper (max 3 total attempts); deep-analyzer.js internally retries each API call up to 3 times (exponential backoff: first 10s, then doubles, `2^attempt * 5s`)
- **LLM API requests explicitly set `agent: false`, forcing direct connections to bypass local proxies (avoids MiMo 403); arXiv/HuggingFace and other external fetches still use proxy auto-detection**
- arXiv HTML parsing uses **cheerio** structured selectors, removing noise elements such as script/style/nav/header/footer
- Image downloads are **parallelized (concurrency 3)**, downloading all paper images (no quantity limit); single image base64 cap is approximately 20M characters (`imageMaxBase64Chars` in config.js); automatically downgrades to pure text retry after timeout
- Full text cap is approximately 500K characters (`fullTextMaxChars` in config.js)
- All analysis configurations are centrally managed in `scripts/config.js`, supporting environment variable overrides

Output constraints:
- Prompt source: `prompts/deep-analysis.md`, read at runtime via `loadPrompt()` and replaces `{hasFullText}`, `{title}`, `{authors}`, `{categories}`, `{arxivId}`, `{textForAnalysis}` placeholders
- Fixed level-1 headings: `## Score`, `## Machine Summary`, `## Tags`, `## Authors & Institutions`, `## Roast`, `## Core Summary`, `## Method Overview & Architecture`, `## Core Innovations`, `## Experimental Results`, `## Detailed Description`, `## Scoring Rationale`, `## Limitations & Issues`, `## Open Source Details`
- Under `## Score`, output the total score first (X.X/10)
- **Code post-processing**: `parseAnalysis`/`parse_analysis` extracts eight sub-items (Innovation/2, Technical Rigor/1.5, Experimental Sufficiency/1.5, Clarity/1, Impact/1.5, Open Source/1.5, Reproducibility/0.5, Engineering/Practical Value/1.5) from `## Scoring Rationale` to recalculate the total score, capped at 10, rounding to 0.1, overriding the LLM's raw total score
- `## Machine Summary` includes `rank_bucket` (with top-conference mapping), `innovation` (innovation 0-2), `technical_rigor` (technical rigor 0-1.5), `experimental_sufficiency` (experimental sufficiency 0-1.5), `clarity` (clarity 0-1), `impact` (impact 0-1.5), `open_source` (open source 0-1.5), `reproducibility` (reproducibility 0-0.5), `engineering_score` (engineering/practical value 0-1.5), `confidence`, `primary_task_tag`, `primary_method_tag`, and other fixed keys
- Scoring uses an eight-dimensional reviewer system: Innovation (0-2) + Technical Rigor (0-1.5) + Experimental Sufficiency (0-1.5) + Clarity (0-1) + Impact (0-1.5) + Open Source (0-1.5) + Reproducibility (0-0.5) + Engineering/Practical Value (0-1.5), max 11, total capped at 10
- **Code post-processing**: `parseAnalysis`/`parse_analysis` always extracts sub-items from `## Scoring Rationale` to recalculate the total score, overriding the LLM's raw output to prevent LLM calculation errors
- Tag output must simultaneously include the final tag string, `Primary Task Tag`, `Primary Method Tag`, and `Supplementary Tags`
- Missing information must be written as "Not stated / Not provided / Not mentioned"; guessing author institutions, experimental numbers, open source status, or external information is prohibited
- When modifying `prompts/deep-analysis.md` or `prompts/filter.md`, synchronously check whether the parsing logic in `scripts/utils.js` and `scripts/utils.py` can still match the new output format

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

# WeChat Official Account
WECHAT_APP_ID=your-app-id
WECHAT_APP_SECRET=your-app-secret
# WECHAT_THUMB_MEDIA_ID=your-thumb-media-id  # Permanent cover image material ID (optional, uses default material if not set)

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
# PD_ANALYSIS_CONCURRENCY=3       # Deep analysis concurrency
# PD_ANALYSIS_MAX_RETRIES=2       # Deep analysis retry count
# PD_REANALYZE_CONCURRENCY=3      # Re-analysis concurrency (defaults to ANALYSIS_CONFIG.concurrency)
# PD_FILTER_BATCH_SIZE=5          # LLM filtering batch size
# PD_ARXIV_MAX_RESULTS=100        # arXiv fetch count per category

# Proxy (optional, but recommended to disable or bypass for MiMo Token Plan)
# https_proxy=http://127.0.0.1:7897
# http_proxy=http://127.0.0.1:7897
# all_proxy=socks5://127.0.0.1:7897
```

**API Protocol Auto-Routing Overview**:

| Endpoint Feature | Model Feature | Auto Route | Anthropic URL Transform |
|------------------|---------------|------------|-------------------------|
| Contains `token-plan` | Contains `mimo` | Anthropic | `/v1` → `/anthropic/v1/messages` |
| Contains `coding` | Contains `kimi` | Anthropic | `/coding/v1` → `/coding/v1/messages` |
| Any other | Any other | OpenAI | `/v1/chat/completions` |

Endpoint configuration format is uniformly `protocol://domain/v1`, regardless of which protocol is used subsequently.

---

## 5. Common Commands (Currently Available)

```bash
cd ~/.hermes/skills/openclaw-imports/audio-paper-digest

# Full pipeline (fetch + filter + deep analysis)
npm run fetch
# or ./run-full-fetch.sh

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

# Analyze a single paper (command line argument)
node scripts/analyze-single-paper.js 2604.16044

# Backfill historical paper IDs (no deep analysis)
npm run backfill

# Publish blog (explicitly specifying date is recommended)
npm run publish -- --date YYYY-MM-DD

# Generate markdown only, do not push
npm run publish -- --skip-push --date YYYY-MM-DD

# Publish with custom data file
npm run publish -- --date YYYY-MM-DD data/current/deep-analysis-result.json

# Generate WeChat Official Account draft (defaults to reading data/current/deep-analysis-result.json)
npm run wechat

# Generate Xiaohongshu copy (defaults to TOP 5 curated version)
npm run xiaohongshu
npm run xiaohongshu -- --top 7     # Specify TOP N
npm run xiaohongshu -- --all       # Full summary version
npm run xiaohongshu -- --date 2026-04-22
```

**Xiaohongshu Publishing Tips:**

- Xiaohongshu single post body limit is approximately 1000 characters; TOP 3 mode defaults to approximately 800-950 characters, suitable for direct single-post publishing
- **The one-sentence introduction for each paper is generated by calling the MiMo LLM API** (anthropic protocol, bypassing proxy); falls back to local `extract_one_liner()` on LLM failure (prioritizes the first innovation item, then a sentence in summary containing "proposes/solves/aims to", then roast)
- The script automatically cleans Markdown formatting (`**bold**`, `` `code` ``) and academic prefixes ("This paper aims to", "This paper addresses", etc.) to avoid platform rendering issues
- Copy automatically includes emoji heat indicators: 🔥≥8 pts, ✅≥6 pts, 📝<6 pts (consistent with blog and WeChat)
- Fixed blog link and open source repository link appended at the end; tags and `---` separators are not output
- `--all` mode outputs longer content, suitable for split-posting or self-selecting highlights for publishing

---

## 6. Publishing Behavior & Date Safety

Publishing script: `scripts/publish-to-blog.py`

### Core Principle: Blog Date = Crawl/Analysis Date, ≠ arXiv Upload Date

- The `published` field is the paper's original publication date on arXiv, which may be earlier than today
- **The blog's `YYYY-MM-DD` date represents the "crawled and analyzed today" batch**, not the paper's original publication date
- `deep-analysis-result.json` is already the result of "today's fetch → deduplicate with `papers.json` → LLM filter"; all papers in it should be published under today's blog

Current behavior:

- Defaults to reading `data/current/deep-analysis-result.json`
- **Filters by `fetchedAt` date**: only publishes papers whose `fetchedAt` matches the `--date` specified date (defaults to today), preventing historical data from being republished
- Generates in `~/code/github_repos/audio-paper-digest-blog/content/posts`:
  - Summary page: `YYYY-MM-DD.md`
  - Single paper page: `YYYY-MM-DD-<slug>.md`
- By default executes `git add -A`, `git commit`, `git push origin main`
- To publish all papers (no filtering), manually modify the script or use a custom data file

Agent execution constraints:

- By default only allows using `--skip-push` mode to verify blog generation results
- Only when the user explicitly requests "official publish / push blog" is `--skip-push` allowed to be omitted
- If only checking format, verifying new fields, or previewing artifacts, triggering a real `git push` is prohibited

Pre-publish safeguards:

- `full-fetch.js` automatically archives and moves yesterday's `deep-analysis-result.json`, `filtered-papers.json`, and `analyzed.json` when run daily, ensuring `data/current/` only contains newly fetched papers for the day
- If non-current-day papers are accidentally mixed in, they will also be published under today's blog, so it is essential to ensure `data/current/` is cleared before each daily run

### Correct Procedure for Re-running / Fixing the Same Day

If the day's results need to be cleared and re-run:

1. Delete `data/current/filtered-papers.json`, `data/current/deep-analysis-result.json`
2. **Restore `papers.json` to yesterday's state** (recommended, more reliable than deleting IDs one by one):
   ```bash
   # Replace dedup DB with yesterday's backup (generated by backupPapersJson, format is papers-YYYY-MM-DD.json)
   cp data/archive/papers-2026-04-21.json data/current/papers.json
   ```
3. Delete all `content/posts/YYYY-MM-DD-*.md` files in the blog repository for the day
4. Re-run `npm run fetch`

**Special Scenario — Filtering Stage API Completely Fails (e.g., 34→0 papers):**
- Even if filtering results in 0 papers, `papers.json` has already been contaminated (new IDs have been written), and must be cleaned and re-run following steps 1-2.
- If re-running immediately after fixing, `npm run batch` can be used to resume deep analysis (no need to re-fetch).

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
| **Today** (e.g., `2026-04-23T03:09:03`) | **Do NOT restore!** It is already in the latest state; simply delete `filtered-papers.json` and re-run |
| **Yesterday or earlier** | Can restore backup: `cp data/archive/papers-YYYY-MM-DD.json data/current/papers.json` |

Recommended check command (optional):

```bash
python3 - <<'PY'
import json
from collections import Counter
with open('data/current/deep-analysis-result.json') as f:
    d = json.load(f)
papers = d.get('papers', [])
dates = [p.get('published', '')[:10] for p in papers if p.get('published')]
print('Total papers:', len(papers))
print('Date distribution:', Counter(dates))
PY
```

---

## 7. Logging & Runtime Characteristics

- Node scripts uniformly output logs to `logs/<script>-YYYYMMDD-HHMMSS.log` via `scripts/log-setup.js`
- Python scripts uniformly output logs to `logs/<script>-YYYYMMDD-HHMMSS.log` via `scripts/log_setup.py`
- **Auto-cleanup**: cleans old logs on each startup, retaining the last 50
- `backfill_papers.py` additionally writes independent logs to `logs/backfill.log`
- Major Node scripts have handled background stdout buffering (`setBlocking`) for real-time progress viewing
- `full-fetch.js` / `deep-analysis-only.js` / `batch-analyze.js` use retry and incremental saving to reduce data loss risk from interruptions
- `reanalyze.js` saves intermediate results every 5 papers (save interval auto-adjusted in concurrent mode)
- `full-fetch.js` auto-backs up bak files to `data/archive/`, retaining the last 10
- `full-fetch.js` auto-backs up `papers.json` to `data/archive/papers-<date>.json`, retaining the last 7 days

---

## 8. Agent Execution Rules (Strong Constraints)

1. **Check before modifying**: Read relevant scripts to confirm current behavior before updating documents or executing commands.
2. **Confirm date for publishing**: Ask the user when the date is not explicitly specified; do not default to "today".
3. **Prohibit dangerous operations**: Do not execute `git reset --hard`, `git push -f`, or batch deletion of historical articles without explicit authorization.
4. **Do not auto-extend workflow**: After running `full-fetch.js`, do not arbitrarily append blog/WeChat publishing unless explicitly requested by the user.
5. **Leave a trace after changes**: After process, parameter, or path changes, synchronously update `SKILL.md` and `README.md`.
6. **Prohibit hard-coded keys**: Do not write real API keys in any script or document; all credentials (LLM, WeChat Official Account, Feishu) are uniformly read from environment variables, with LLM configuration in `the `.env` file in the project root` (auto-`source`d by scripts), and WeChat/Feishu credentials also written to `the `.env` file in the project root`.
7. **Prevent security mechanism breakage when modifying scripts**: This environment silently replaces sensitive characters such as `API_KEY` with `***`. When modifying scripts containing such characters, you must re-read the file after modification to verify that key lines were not corrupted. Also periodically check whether `data/`, `logs/` directories contain residual backup files or log snapshots with keys, and clean them immediately if found.
8. **Unified environment variable management**: When new scripts need to read LLM configuration, uniformly use `PAPER_ANALYZER_API_KEY`, `PAPER_ANALYZER_MODEL`, `PAPER_ANALYZER_ENDPOINT`; introducing alias fallback chains, hard-coding, or base64-encoded variable name hacks is prohibited.
9. **New configurable parameters go in config.js**: When new scripts involve adjustable parameters (concurrency, timeout, batch size, etc.), uniformly place them in `scripts/config.js` and add corresponding environment variable override support.
10. **New analysis scripts reuse analysis-engine.js**: When adding paper analysis-related scripts, prioritize reusing `analyzeBatch()` / `analyzePaperWithRetry()` from `analysis-engine.js` to avoid re-implementing retry, parsing, and saving logic.
11. **Blog verification defaults to no push**: When running `publish-to-blog.py` without explicit user authorization, `--skip-push` must be included.
12. **Output contract changes must sync parser**: If modifying `## Machine Summary` key names, section order, or tag output format in `prompts/deep-analysis.md`, you must synchronously check the parsing logic in `scripts/utils.js` and `scripts/utils.py`.
13. **Artifact-level verification required after changes**: At minimum, spot-check one `data/current/deep-analysis-result.json` to confirm the presence of `rank_bucket`, `primary_task_tag`, `primary_method_tag`, and other fields, then run blog/social media scripts to verify final artifacts.
14. **Verify prompt loading after changes**: After modifying markdown files in the `prompts/` directory, run a quick test (`node scripts/quick-test.js` or single-paper analysis) to confirm `loadPrompt()` can correctly read and replace placeholders without `{variableName}` residue.
15. **Run unit tests after changes**: After modifying `scripts/utils.js`, `scripts/config.js`, or core analysis engine logic, you must run `npm test` to ensure tests pass.
16. **MiMo API requests must disable proxy connection reuse**: In `fetch-papers.js` and `deep-analyzer.js`, when calling the LLM API, `options.agent` must be `false` (not `undefined`). During any refactoring or modification of HTTP request logic, changing `agent: false` back to `agent: proxyAgent` or `agent: undefined` is prohibited, otherwise MiMo Token Plan will return 403 in environments with system proxies.
17. **New LLM endpoints must integrate API protocol auto-routing**: Any new script calling an LLM must uniformly use `detectApiType()`, `buildApiUrl()`, `buildHeaders()`, `buildRequestBody()`, `parseResponseText()` from `scripts/utils.js`; hard-coding specific protocol URLs/Headers/Bodies is prohibited.
18. **Sync the full pipeline when modifying API protocol routing logic**: When modifying `detectApiType()` judgment rules or `buildApiUrl()`/`buildHeaders()` and other functions, you must synchronously check `fetch-papers.js`, `deep-analyzer.js`, and all scripts using `analysis-engine.js` (`full-fetch.js`, `reanalyze.js`, `batch-analyze.js`, `deep-analysis-only.js`, `analyze-single-paper.js`) to ensure consistent behavior across the full pipeline.
19. **Prohibit committing sensitive files to version control**: `data/`, `logs/`, `*.env`, `*.backup*`, cache files, log archives containing keys, etc. are strictly forbidden from entering git; before committing, confirm `.gitignore` is correctly configured and that no historically遗留 sensitive files exist in the repository.

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
   - Ensure `.env` is correctly configured and `.zshrc` has been sourced

2. **Check if the correct protocol is being used** (search logs for `[filter] API type: xxx` or `[api] → model | xxx` lines)
   - If using MiMo/Kimi Token Plan but it shows `openai`, check if the endpoint contains `token-plan` or `coding`, and if the model contains `mimo` or `kimi`
   - If logs show `anthropic` but it still fails, check if the path is `/anthropic/v1/messages` (not `/v1/chat/completions`)

3. **Anthropic protocol专项检查** (when logs show `anthropic`)
   - Is the request header `x-api-key` (not `Authorization: Bearer`)
   - Does it include `anthropic-version: 2023-06-01`
   - Does it include `User-Agent: claude-cli/<version> (external, cli)` (logs won't directly show this, verify with proxy tools)

4. **OpenAI protocol专项检查** (when logs show `openai`)
   - Confirm using `Authorization: Bearer {key}`
   - Confirm URL path is `/v1/chat/completions`

5. **Check proxy** (see Section 9.2)
   - MiMo Token Plan may be blocked when a system proxy is present
   - Try testing with `curl --noproxy "xiaomimimo.com"` to bypass proxy

6. **Check logs**: `logs/full-fetch-*.log`, `logs/deep-analyzer-*.log`

### 9.2 MiMo API Returns 403 Illegal Access / Timeout / Socket Hang Up

**Root cause**: Node.js `https.request` with `agent: undefined` still reuses the global default agent's connection pool. When a system proxy is configured (`https_proxy` etc.), connections from the global agent may be polluted by the proxy, causing the MiMo Token Plan server to reject requests.

**Fix**: In `fetch-papers.js` and `deep-analyzer.js`, LLM API requests must set `options.agent` to `false` (not `undefined`), completely disabling connection reuse and forcing each request to establish a new connection:

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

- Configure `PAPER_ANALYZER_API_KEY` in `the `.env` file in the project root`
- Re-source: `source ~/.zshrc`

### 9.7 WeChat Official Account Publishing Failure

- Check if `WECHAT_APP_ID` / `WECHAT_APP_SECRET` environment variables are set (in `the `.env` file in the project root`)
- Check if `APP_SECRET` has expired
- Check if images are too large or restricted by arXiv
- WeChat image upload has rate limits; large numbers of images may need to be executed in batches

### 9.8 HuggingFace Fetch Empty

- Check network connection (`curl https://huggingface.co/api/daily_papers?limit=10`)
- Check if rate-limited or proxy required
- `fetch-huggingface-papers.js` uses the `curl` command, ensure system `curl` is available

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
2. If today, do not restore papers.json, simply delete `filtered-papers.json` and re-run
3. If yesterday or earlier, restore `papers.json` backup and re-run

---

## 10. Related Sub-Skills

### Lightweight Paper Digest

#### arXiv Trending (`references/arxiv-digest.md`)
Daily AI/ML trending papers from HuggingFace Papers with accessible interpretations. Fetches trending papers, ranks by combined score (position + upvotes + freshness), generates plain-language summaries. Supports automated daily delivery via cron.
- Script: `scripts/fetch_papers.py`
- Output: JSON or Markdown
- Deduplication: history tracking

#### Daily Paper Digest (`references/daily-paper-digest.md`)
Aggregates latest AI papers from arXiv and HuggingFace, formats output for chat apps (Feishu, Slack, Discord). Configurable sources and keyword filters via `config/sources.json`.
- Scripts: `main.py`, `arxiv_fetcher.py`, `huggingface_fetcher.py`
- Triggers: `论文速递`, `今日论文`, `最新论文`, `/papers`, `/digest`
