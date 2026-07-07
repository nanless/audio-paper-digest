# Paper Digest - Fully Automated Speech / Music / Audio Paper Digest Pipeline

English | **[中文](README.md)**

This project automatically generates "Speech / Music / Audio Paper Digests," covering the complete pipeline from arXiv and HuggingFace Papers crawling, LLM-based filtering, multimodal deep analysis, to publishing Hugo blog posts, WeChat Official Account drafts, Xiaohongshu (Little Red Book) copy, and Feishu (Lark) documents.

---

## Documentation Guide

| File | Purpose | Audience |
|------|---------|----------|
| `README.md` | Project overview, quick start, command reference | Human users |
| `SKILL.md` | Execution rules and safety constraints for Agents | AI Agent |
| `docs/workflow.md` | Main workflow details (archiving, crawling, filtering, analysis, saving) | Users |
| `docs/scripts.md` | All script function descriptions | Developers |
| `docs/data-format.md` | Data file formats and field descriptions | Developers |
| `docs/setup.md` | Installation, initialization, environment variables, logging, proxy config | New users |
| `docs/troubleshooting.md` | Common issues diagnosis and fixes | Users |
| `docs/maintenance.md` | Maintenance conventions, scoring standards, tag definitions | Maintainers |
| `prompts/filter.md` | LLM prompt for the filtering stage | Maintainers |
| `prompts/deep-analysis.md` | Deep analysis main prompt (Round 1) | Maintainers |
| `prompts/image-supplement.md` | Image supplement prompt (dual-model mode) | Maintainers |
| `prompts/opensource-scan.md` | Open-source link scanning prompt (Round 2) | Maintainers |
| `prompts/gap-fill.md` | Review and rewrite prompt (Round 3) | Maintainers |

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
├── run-full-fetch.sh     # Full pipeline entry point
└── README.md / SKILL.md
```

See [`docs/scripts.md`](docs/scripts.md) for each script's functionality, and [`docs/data-format.md`](docs/data-format.md) for data file formats.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure API Key (write to `.env`)
#    Primary model (text analysis, required)
#    PAPER_ANALYZER_API_KEY=your-key
#    PAPER_ANALYZER_MODEL=deepseek-v4-pro
#    PAPER_ANALYZER_ENDPOINT=https://api.deepseek.com/anthropic
#
#    Secondary model (multimodal image analysis, optional)
#    PAPER_ANALYZER_SECONDARY_MODEL=mimo-v2.5
#    PAPER_ANALYZER_SECONDARY_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1
#    PAPER_ANALYZER_SECONDARY_API_KEY=tp-your-key

# 3. Run the full pipeline (crawl + filter + deep analysis)
./run-full-fetch.sh

# 4. Publish blog
python3 scripts/publish-to-blog.py --date 2026-05-08

# 5. Generate Xiaohongshu copy
python3 scripts/publish-xiaohongshu.py
```

For the complete installation guide, see [`docs/setup.md`](docs/setup.md).

---

## 8. Common Commands Cheatsheet

### npm scripts

```bash
# Full pipeline (crawl + filter + deep analysis)
npm run fetch

# Resume deep analysis only (skip existing analysis; can initialize from filtered-papers.json)
npm run deep

# Full re-analysis
npm run reanalyze

# Batch analyze unanalyzed papers
npm run batch

# Run unit tests
npm test

# Quick test (crawl + filter, no analysis)
node scripts/quick-test.js

# Backfill historical paper IDs
npm run backfill

# Generate blog Markdown (does not push by default)
npm run publish -- --date 2026-04-21

# Publish blog (commit and push)
npm run publish -- --push --date 2026-04-21

# Generate WeChat Official Account draft
npm run wechat
# Generate WeChat preview only, without calling WeChat APIs
python3 scripts/publish-wechat-full.py --dry-run

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
```

### Direct Invocation

```bash
# ========== Core Pipeline ==========
# Full pipeline (recommended entry point)
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

# ========== Publishing ==========
# Publish blog (strongly recommend explicit --date)
python3 scripts/publish-to-blog.py --date 2026-04-21

# Generate Markdown only, do not push
python3 scripts/publish-to-blog.py --skip-push --date 2026-04-21

# Commit and push
python3 scripts/publish-to-blog.py --push --date 2026-04-21

# Publish with custom data
python3 scripts/publish-to-blog.py --date 2026-04-21 data/current/deep-analysis-result.json

# Generate WeChat Official Account draft
python3 scripts/publish-wechat-full.py
python3 scripts/publish-wechat-full.py --dry-run

# Generate WeChat draft with custom data
python3 scripts/publish-wechat-full.py data/current/deep-analysis-result.json

# Generate Xiaohongshu copy (default TOP 5)
python3 scripts/publish-xiaohongshu.py
python3 scripts/publish-xiaohongshu.py --top 7
python3 scripts/publish-xiaohongshu.py --all

# Xiaohongshu auto-publish (login required first)
python3 scripts/xiaohongshu-publisher.py --login
python3 scripts/xiaohongshu-publisher.py
python3 scripts/xiaohongshu-publisher.py --all

# Generate Feishu (Lark) document
python3 scripts/publish-to-feishu.py
python3 scripts/publish-to-feishu.py --date 2026-04-21
python3 scripts/publish-to-feishu.py --dry-run --date 2026-04-21

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
- [Data Format](docs/data-format.md) — Structure of papers.json, filtered-papers.json, and deep-analysis-result.json
- [Installation & Configuration](docs/setup.md) — Dependency installation, environment variables, model configuration, logging
- [Troubleshooting](docs/troubleshooting.md) — Diagnosis for API errors, proxy issues, and publishing failures
- [Maintenance Conventions](docs/maintenance.md) — Code standards, scoring and tag definitions, change checklist

---

## References & Acknowledgments

- This project references the design and implementation ideas of [speech-paper-daily-skill](https://github.com/JusperLee/speech-paper-daily-skill)
