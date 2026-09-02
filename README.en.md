# Paper Digest - Fully Automated Speech / Music / Audio Paper Digest Pipeline

English | **[中文](README.md)**

This project generates "Speech / Music / Audio Paper Digests," covering the complete pipeline from arXiv and HuggingFace Papers crawling through Hugo blog publication. The default daily route is the LLM/API workflow: keyword prefiltering, model selection, staged full-text analysis, evidence-bounded scoring, beginner-oriented longform generation, blog review/push, and post-publication visual planning. Production Manual v6 remains an explicit high-assurance human workflow. Node-side tunable parameters and current runtime data-file paths are centralized in `scripts/config.js`; shared Python publish/maintenance paths are centralized in `scripts/path_config.py`.

To upgrade an existing API batch to the current reader contract, run `npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader`. The command only accepts the current canonical envelope with an exact `batchDate`, persists each successful paper under locks with a commit-time identity check, and skips SHA-complete v3 papers on retry.

If only final-text surface normalization has made headings or concept-bridge references differ from the stored plan bytes, run `npm run api:reader:refresh -- --all --date YYYY-MM-DD --surface-bindings-only --concurrency 5`. This mode performs no fetch or LLM call; it deterministically rebinds the plan to the final article and updates its SHA closure.

Production Manual v6 uses records v4, spec v6, a complete structured ArtifactIndex, and `reader-longform-v2` to turn full-text evidence into a paper-specific tutorial rather than a repeated field template. A SHA-bound 2,400–24,000-character article is deterministically rebuilt from evidence-bound blocks, exact source tables, figures, formulas, terms, and related-work relationships. Per-role packets, outputs, receipts, the sealed record, and the batch Merkle root are replayed at canonical ingestion and publication. Shadow v6 remains isolated and unpublishable; Manual v5 is available only through explicit legacy-maintenance commands and is never silently relabeled or promoted into production v6.

LLM endpoints must use HTTPS (plain HTTP is accepted only for loopback local tests). arXiv metadata retry, backoff, cumulative-wait, absolute-deadline, response-size, and User-Agent settings are controlled by `ARXIV_CONFIG`; see [Setup](docs/en/setup.md) for overrides.

When a user tells Codex to run the paper digest for a given date, the default intent is the complete LLM/API workflow: fetch, keyword prefiltering, model selection, staged analysis and scoring, reader longform generation, page review and fixes, blog publication with remote-OID verification, post-publication visuals, and final status gates. `npm run digest:prepare -- YYYY-MM-DD` and `npm run digest:api -- YYYY-MM-DD` are equivalent entries. Use `npm run digest:manual -- YYYY-MM-DD` only when the user explicitly requests the Manual/human workflow. Blog push is included in the dated digest request; other publishing channels remain outside the default scope.

Deep analysis uses the `type-aware-v1` rubric: it first classifies a document as method research, system technical report, model report, dataset/benchmark, survey, theory, or applied research, then evaluates it with the matching evidence standard. The common eight dimensions, 11-point subtotal, and 10-point cap remain unchanged; values use at most one decimal and Open Source uses fixed anchors. New production-v6 role packets carry their fixed output/receipt paths, required fields, rubric, and cross-runtime semantic-hash algorithm inside the signed packet. The runner rejects missing dimensions, ad-hoc 0–10 review scales, invalid Open Source anchors, and incomplete Terra-high calibration during technical-review submission rather than deferring the error to the revision binder. The deterministic revision binder always rebuilds from the current runner-validated `draft/author-record.json`; it never consumes a stale `revision-record-payload.json`, even when that previous output remains on disk. Type grants no fixed bonus, and complete proof material may count as a theory paper's public core artifact instead of being forced to zero merely because code/model/data flags are absent.

Visual generation is a post-publication stage. First finish deep analysis for every paper, then generate, review, push, and remotely verify all blog pages (the digest index plus every paper page). Only then does `push-blog.py` create resumable image tasks: one tall Chinese-body infographic for each final-score TOP 10 paper, with stable normalized-arXiv-ID tie breaking, plus one batch digest image containing the title, hot directions, and TOP 10 ranking. Each paper poster targets roughly 220–360 Chinese characters of substantive explanation. When deep analysis selected and cached a trustworthy method overview, architecture, pipeline, or key-result figure, the task binds up to two references and their SHA values. Built-in image generation now creates the complete final composition—title, Chinese copy, verified numbers, diagrams, captions, and paper-collage artwork—without passing through the legacy deterministic text-card compositor. Before record, every title, statement, arrow relationship, metric direction, and value must be visually verified; unreadable or materially incorrect assets are regenerated. Paper infographics and the digest cover use a fresh paper-editorial system with warm light backgrounds, restrained low-saturation colors, subtle paper grain, layered sheets, limited deckled edges and tape accents, soft shadows, and generous whitespace. Dirty vintage paper, crowded scrapbook styling, dark neon, cyberpunk HUDs, and dashboard layouts are explicitly prohibited. These assets do not enter or block the already completed blog generation/review/push transaction.

A high-recall keyword gate runs before LLM filtering, with core audio categories as a fallback so clearly unrelated papers do not consume LLM quota. `npm run keyword:recall` checks curated positive/negative gold cases and adjudicated historical positives. At the end of a daily run, `npm run digest:status -- --date YYYY-MM-DD` produces the unified machine-readable completion report for fetch, filter, analysis, remote blog publication, and both visual asset types.

Deep analysis now uses stage-specific evidence budgets. Primary analysis still covers the paper, with balanced whole-document sampling for very long sources; open-source scanning, revision, scoring, method/table repair, and structure repair receive task-focused evidence slices instead of repeatedly resending the complete paper. Blog text review uses 8,000-character chunks by default, halving repeated instruction overhead versus the former 4,000-character default. All budgets are project `.env` overrides and are bound into recovery fingerprints. Every passed blog page is also retained as durable repository-relative-path plus file-SHA-256 evidence. Code, script, documentation, model, protocol, generation-manifest, or blog-baseline changes refresh the batch receipt without re-reviewing unchanged page bytes; only new or content-changed pages re-enter the three-layer review.

---

## Documentation Guide

| File | Purpose | Audience |
|------|---------|----------|
| `README.md` | Project overview, quick start, command reference | Human users |
| `SKILL.md` | Execution rules and safety constraints for Agents | AI Agent |
| `docs/workflow.md` | Main workflow details (archiving, crawling, filtering, analysis, saving) | Users |
| `docs/scripts.md` | All script function descriptions | Developers |
| `docs/data-format.md` | Data file formats and field descriptions | Developers |
| `docs/setup.md` | Installation, initialization, project `.env`, logging, proxy config | New users |
| `docs/troubleshooting.md` | Common issues diagnosis and fixes | Users |
| `docs/maintenance.md` | Maintenance conventions, scoring standards, tag definitions | Maintainers |
| `prompts/filter.md` | LLM prompt for the filtering stage | Maintainers |
| `prompts/deep-analysis.md` | Deep analysis main prompt (Round 1) | Maintainers |
| `prompts/image-supplement.md` | Image selection and insertion-plan prompt (dual-model mode; adds only figures plus adjacent lead/explanation text) | Maintainers |
| `prompts/opensource-scan.md` | Open-source link scanning prompt (Round 2) | Maintainers |
| `prompts/gap-fill.md` | Review and rewrite prompt (Round 3) | Maintainers |
| `prompts/structure-repair.md` | Primary-model structural repair used only when required sections are missing | Maintainers |
| `prompts/scoring-audit.md` | Final type-aware scoring audit by the primary model; scoring fields only | Maintainers |
| `prompts/visual-summary.md` | Post-publication prompt for one tall infographic per TOP 10 paper | Maintainers |
| `prompts/digest-cover.md` | Post-publication digest-image prompt for title, hot directions, and TOP 10 | Maintainers |

All generated images for a batch are archived flat under `data/archive/<date>/visual-summaries/`: the cover is `00-digest-cover-<date>.png`, and paper images are `<two-digit-rank>-<paper-id>-<title-slug>.png`, using manifest rank rather than completion order. Only resumable manifests remain in `data/current/`.

> **Iron Rule**: The actual behavior in `scripts/*.js` / `scripts/*.py` is the single source of truth. If documentation conflicts with code, trust the code and fix the documentation.

---

## Project Structure

```
audio-paper-digest/
├── scripts/              # All scripts
├── tests/                # Unit tests
├── data/                 # Working data and archives (gitignored)
│   ├── current/          # Current working data
│   └── archive/          # Automatic date-based archiving
├── logs/                 # Runtime logs (gitignored)
├── prompts/              # LLM prompt files
├── docs/                 # Detailed documentation
├── package.json          # npm scripts
├── run-daily-digest.sh   # Default Codex daily orchestrator; built-in image generation follows its script stages
├── run-full-fetch.sh     # Data pipeline only: fetch, filter, and deep analysis
└── README.md / SKILL.md
```

See [`docs/scripts.md`](docs/scripts.md) for each script's functionality, and [`docs/data-format.md`](docs/data-format.md) for data file formats.

---

## Quick Start

```bash
# 1. Install dependencies
npm install
pip3 install -r requirements.txt
# Node requirement: >=20.18.1 <21 or >=22.3.0; Python dependencies include Pillow

# 2. Configure API Key (write to `.env`)
#    Primary model (text analysis, required)
#    PAPER_ANALYZER_API_KEY=your-opencode-go-key
#    PAPER_ANALYZER_MODEL=muse-spark-1.2-contributor
#    PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
#
#    Secondary model (multimodal image analysis, optional)
#    PAPER_ANALYZER_SECONDARY_MODEL=mimo-v2.5
#    PAPER_ANALYZER_SECONDARY_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1
#    PAPER_ANALYZER_SECONDARY_API_KEY=tp-your-key

# 3. Run deterministic daily stages: data pipeline + blog generate/review/push + visual preparation.
# Every project script must run outside the sandbox; entrypoints reject Codex sandbox execution.
today="$(TZ=Asia/Shanghai date +%F)"
./run-daily-digest.sh "$today"

# After fixing review blockers, resume from review without rerunning fetch/analysis.
./run-daily-digest.sh 2026-05-08 --from review

# 4. Codex uses built-in image_gen to generate and record every visual, then verifies both gates.
npm run visual:status -- --date 2026-05-08
npm run cover:status -- --date 2026-05-08

# 5. Optional: generate Xiaohongshu copy
python3 scripts/publish-xiaohongshu.py
```

For the complete installation guide, see [`docs/setup.md`](docs/setup.md).

---

## 8. Common Commands Cheatsheet

### npm scripts

```bash
# Default daily script stages; Codex then continues with built-in image generation.
npm run digest:prepare -- "$(TZ=Asia/Shanghai date +%F)"

# Data pipeline only (crawl + filter + deep analysis)
npm run fetch

# Resume deep analysis only (skip existing analysis; can initialize from filtered-papers.json)
npm run deep

# Full re-analysis
npm run reanalyze

# Batch analyze unanalyzed papers
npm run batch

# Read-only validation for current JSON data files, including filter-decision cache consistency
npm run validate:data
# Only for a clean checkout with no runtime data:
# npm run validate:data -- --allow-empty

# Idempotently plan/resume TOP 10 infographics and the digest image after all blogs publish.
npm run visual:post-publish -- --date 2026-04-21
npm run visual:status -- --date 2026-04-21
npm run cover:status -- --date 2026-04-21

# Run unit tests
npm test

# Quick test (crawl + filter, no analysis)
node scripts/quick-test.js

# Backfill historical paper IDs
npm run backfill

# Generate blog Markdown only
python3 scripts/generate-blog.py --date 2026-04-21

# Review generated Markdown and create a SHA-256 receipt
python3 scripts/review-blog.py --date 2026-04-21

# Verify the receipt, commit, and push (only after an explicit publish request)
python3 scripts/push-blog.py --date 2026-04-21

# Generate WeChat Official Account draft
npm run wechat
# Generate WeChat preview only, without calling WeChat APIs
python3 scripts/publish-wechat-full.py --dry-run
# Publish all papers from the input file to WeChat drafts
python3 scripts/publish-wechat-full.py --all

# Generate Xiaohongshu copy
npm run xiaohongshu

# Xiaohongshu auto-publish (login required first)
npm run xhs-login
npm run xhs-publish
npm run xhs-publish-all

# Generate Feishu (Lark) document
python3 scripts/publish-to-feishu.py
python3 scripts/publish-to-feishu.py --date 2026-04-21
# Preview Feishu document size only, without creating a document
python3 scripts/publish-to-feishu.py --dry-run --date 2026-04-21
# Publish all papers from the input file to Feishu
python3 scripts/publish-to-feishu.py --all
```

### Direct Invocation

```bash
# ========== Core Pipeline ==========
# Default daily script stages; Codex then continues with built-in image generation.
./run-daily-digest.sh "$(TZ=Asia/Shanghai date +%F)"

# Data pipeline only
./run-full-fetch.sh

# Or use Node directly
node scripts/full-fetch.js

# Resume deep analysis only (skip existing analysis; can initialize from filtered-papers.json)
node scripts/deep-analysis-only.js

# Full re-analysis
node scripts/reanalyze.js

# Re-analysis with specified concurrency
node scripts/reanalyze.js --concurrency 3 data/current/deep-analysis-result.json

# Quick test (crawl + filter, no analysis)
node scripts/quick-test.js

# Batch analyze unanalyzed papers
node scripts/batch-analyze.js

# Analyze a single paper
node scripts/analyze-single-paper.js 2604.16044

# Read-only validation for current data structure
node scripts/validate-data-files.js

# ========== Publishing ==========
# Blog stages are intentionally separate
python3 scripts/generate-blog.py --date 2026-04-21
python3 scripts/review-blog.py --date 2026-04-21
python3 scripts/push-blog.py --date 2026-04-21

# Passed pages with unchanged SHA-256 are reused permanently; retries review only new/changed/failed pages.

# Publish with custom data
python3 scripts/publish-to-blog.py --date 2026-04-21 data/current/deep-analysis-result.json
python3 scripts/publish-to-blog.py --all data/current/deep-analysis-result.json

# Generate WeChat Official Account draft
python3 scripts/publish-wechat-full.py
python3 scripts/publish-wechat-full.py --dry-run

# Generate WeChat draft with custom data
python3 scripts/publish-wechat-full.py data/current/deep-analysis-result.json
python3 scripts/publish-wechat-full.py --all data/current/deep-analysis-result.json

# Generate Xiaohongshu copy (default TOP 5)
python3 scripts/publish-xiaohongshu.py
python3 scripts/publish-xiaohongshu.py --top 7
python3 scripts/publish-xiaohongshu.py --all

# TOP-N one-liners default to concurrency 5; configurable from 1 to 5 in project .env
# PD_XIAOHONGSHU_ONELINER_CONCURRENCY=5
# Successful one-liners are checkpointed per paper; reruns only request failed, missing, or invalidated entries

# Xiaohongshu auto-publish (login required first)
python3 scripts/xiaohongshu-publisher.py --login
python3 scripts/xiaohongshu-publisher.py
python3 scripts/xiaohongshu-publisher.py --all

# Generate Feishu (Lark) document
python3 scripts/publish-to-feishu.py
python3 scripts/publish-to-feishu.py --date 2026-04-21
python3 scripts/publish-to-feishu.py --dry-run --date 2026-04-21
python3 scripts/publish-to-feishu.py --all

# ========== Utilities ==========
# Backfill paper IDs (no analysis)
python3 scripts/backfill_papers.py

# Re-filter + re-analyze by date
node scripts/refilter-reanalyze-by-date.js 2026-07-01
```

---

## More Documentation

- [Main Workflow](docs/workflow.md) — Complete flow of automatic archiving, crawling, filtering, and deep analysis
- [Script Reference](docs/scripts.md) — Function descriptions and usage for all scripts
- [Data Format](docs/en/data-format.md) — Fetch/filter checkpoints, staged analysis recovery, blog receipts, and Xiaohongshu copy cache
- [Installation & Configuration](docs/setup.md) — Dependency installation, environment variables, model configuration, logging
- [Troubleshooting](docs/troubleshooting.md) — Diagnosis for API errors, proxy issues, and publishing failures
- [Maintenance Conventions](docs/maintenance.md) — Code standards, scoring and tag definitions, change checklist

---

## References & Acknowledgments

- This project references the design and implementation ideas of [speech-paper-daily-skill](https://github.com/JusperLee/speech-paper-daily-skill)
