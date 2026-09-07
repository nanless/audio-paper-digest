# Paper Digest

**Automated speech, music, and audio paper digests**

English · **[中文](README.md)**

Fetch candidate papers from arXiv and HuggingFace Papers, filter and analyze them with an LLM, publish a daily index plus beginner-oriented Chinese deep dives, then create post-publication TOP 10 infographics and a digest cover.

## What you get

- Resumable, auditable candidate, filter-decision, and deep-analysis data for each day.
- One daily digest page and one continuous Chinese tutorial for every selected paper.
- Author affiliations and eight-dimensional scores, plus formulas, tables, figures, and resources when the paper provides verifiable evidence.
- One tall infographic for each final-score TOP 10 paper and one batch cover after blog publication.

## Default behavior

The default route is LLM/API, not the human workflow:

```text
arXiv + HuggingFace
  → keyword prefilter → per-paper LLM filter → seal this run's official arXiv text/PDF
  → staged full-text analysis and scoring
  → blog generate → review → push / remote-OID verification
  → TOP 10 infographics and digest cover → final status gate
```

- `digest:prepare` and `digest:api` are aliases for the same default route.
- After filtering and before deep analysis, every selected arXiv paper is captured into a sealed source
  generation at `data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/`.
  It contains `source.txt`, `source.pdf`, `source-runtime.json`, and `source-manifest.json`. Analysis,
  Reader, generate, review, and push replay that exact bundle. Figure pixels exist only in an active
  OS-temporary call and never become a runtime image cache.
- Manual runs only when explicitly selected; API, network, or quota failures never switch provenance.
- WeChat, Feishu, and Xiaohongshu are optional integrations, not part of the default daily run.

## Start in five minutes

Requirements: Node `>=20.18.1 <21 || >=22.3.0`, Python 3.11+ with OpenSSL, and an available Hugo blog repository.

```bash
# 1. Install dependencies
npm install
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt

# 2. Create project configuration
cp env.example .env
```

At minimum, set these values in the project-root `.env`:

```dotenv
PAPER_ANALYZER_API_KEY=...
# Optional same-route OpenCode Go fallback; used only after confirmed quota exhaustion
PAPER_ANALYZER_FALLBACK_API_KEYS=...
PAPER_ANALYZER_MODEL=...
PAPER_ANALYZER_ENDPOINT=https://...
HTTPS_PROXY=http://127.0.0.1:7897   # HTTP_PROXY is also supported; see Setup
```

Fallback accounts use persistent sticky failover across processes and dates; they are not round-robin load balancing. See [Setup](docs/en/setup.md) for model, protocol, and proxy requirements. Project commands must run outside the sandbox; entrypoints reject a restricted sandbox before network, logging, or writes.

```bash
# 3. Run Node tests
npm test

# 4. Run the complete script stages for Beijing today
today="$(TZ=Asia/Shanghai date +%F)"
npm run digest:prepare -- "$today"
```

`digest:prepare` completes data processing and blog publication, then prepares visual tasks. It does not call an image API. Codex built-in image generation must finish and inspect those assets, or record an explicit user-requested waiver.

```bash
# 5. Verify final status
npm run digest:status -- --date "$today"
```

## Definition of done

A complete daily run means all of the following:

1. Fetch sources, filter decisions, and deep analysis are in complete terminal states.
2. The digest and every paper page passed review; the blog commit is pushed and matches the remote OID.
3. TOP 10 infographics and the digest cover are recorded, or a waiver binds the current publication.
4. The latest `digest:status` report no longer lists an incomplete stage.

Once the blog is published, a visual failure does not revoke it and must not trigger blog regeneration
or another page review.

## Full-history rewrite

Full-history work runs only in the `audio-paper-digest-rewrite-all` workspace. Its active route is
`direct-local-first`:

```text
retained local conference metadata/PDF ─┐
                                        ├→ direct-inputs → conference-projections → direct-plan
frozen historical arXiv links ─────────┘                                  ├→ direct-scheduler → direct-run → staging
                                                                            └→ direct-aggregate
```

- The arXiv route fetches and seals a new official `source.txt`, `source.pdf`, runtime metadata, and
  manifest for every generation under `data/runtime/fetched-arxiv-sources/`; it never uses retained
  arXiv text, PDF, figures, old posts, old analyses, or old Reader prose as writing input.
- The conference route replays the retained local metadata/PDF SHA selected by the frozen-page
  projection. One canonical paper is analyzed once and then projected to every frozen historical page.
- A crosswalk is a strict arXiv-failure-only fallback: it accepts only a named immutable arXiv
  fresh-acquisition handoff. An unavailable or damaged retained conference source fails its direct route closed;
  it never enters a crosswalk and does not gate the remaining direct queue.
- Historical output remains private runtime source/analysis/page/aggregate staging. Historical
  review, activation, commit/push receipt, and remote-OID publication are not implemented.

The active commands and exact absolute-path arguments are documented in the Chinese
[historical rewrite guide](docs/history-rewrite.md).

## Core commands

| Purpose | Command |
|---|---|
| Default daily run | `npm run digest:prepare -- YYYY-MM-DD` |
| Resume incomplete analysis | `npm run deep -- --date YYYY-MM-DD` (replays only the sealed PDF/TXT bundle) |
| Refresh API Reader | `npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader` (replays only the sealed PDF/TXT bundle) |
| Validate current data | `npm run validate:data` |
| Inspect runtime storage | `npm run storage:status` |
| Preview reference-aware pruning | `npm run storage:prune` |
| Inspect final status | `npm run digest:status -- --date YYYY-MM-DD` |
| Run blog stages separately | `npm run blog:generate` → `npm run blog:review` → `npm run blog:push` |
| Record an explicit visual waiver | `npm run digest:waive-visuals -- --date YYYY-MM-DD --reason "..."` |
| Explicit Manual route | `npm run digest:manual -- YYYY-MM-DD` |

See [Script responsibilities](docs/en/scripts.md) for arguments and recovery semantics, or
[`scripts/README.md`](scripts/README.md) for a compact file-to-responsibility index.

## Taxonomy and read-only historical preview

```bash
npm run taxonomy:validate
npm run taxonomy:preview
npm run taxonomy:serve
```

A shared registry defines stable IDs, task ancestry and facets. The preview reads the configured Hugo checkout, retains original and unresolved tags, and supports parent queries, OR within a facet and AND across facets. These are **legacy-label mappings, not reviewed semantic reclassifications**. No article, score or old tag URL is changed and no paper-model API is called. The loopback server only serves static preview assets, not a local AI companion.

See the [implementation plan](docs/tag-taxonomy-implementation.md) and [taxonomy design](docs/tag-taxonomy-design.md) (Chinese).

## Where to resume after a failure

- Interrupted fetch/filter: rerun the default entry; healthy checkpoints are reused.
- Only some analyses failed: run `npm run deep -- --date YYYY-MM-DD` or targeted reanalysis. These
  recovery entries never refetch or reuse legacy text/cache; a missing or drifted sealed bundle requires
  `npm run digest:prepare -- YYYY-MM-DD` to create a new source generation.
- Blog review/push failed: resume with `npm run blog:review -- --date YYYY-MM-DD` or `npm run blog:push -- --date YYYY-MM-DD`.
- Visual tasks are missing or stale: run `npm run visual:post-publish -- --date YYYY-MM-DD`; do not republish the blog.
- Unsure which stage failed: start with [Troubleshooting](docs/en/troubleshooting.md) and
  [Workflow](docs/en/workflow.md).

A fresh fetch may bind only Beijing today. Historical dates must resume from existing controlled data;
they cannot be fabricated by running a new crawl under an old date.

## Architecture

```text
Node.js data layer
  fetch / filter / deep analysis / state / visual manifests
                         ↓
Python publication layer
  Hugo generation / page review / Git transaction / remote verification
                         ↓
Codex visual layer
  built-in image generation / visual QA / asset record
```

Default API and explicit Manual share publication and visual boundaries, but keep independent content
evidence and provenance. Manual scripts, prompts, tests, and workflow live under
[`manual/`](manual/README.md).

## Data and outputs

| Location | Contents |
|---|---|
| `data/current/` | Current candidates, filtering, analysis, publication receipts, and visual state |
| `data/archive/<date>/` | Daily snapshots and final visual assets |
| `data/runtime/daily-fresh-source-runs/` | Daily official PDF/TXT source generations used by API analysis and publication replay |
| `data/runtime/fetched-arxiv-sources/` | Official PDF/TXT source generations for historical direct arXiv rewrites |
| other historical `data/runtime/` directories | Direct plans, private analysis, page staging, and aggregate staging; never a blog publication |
| `logs/` | Redacted run logs; file logging can be disabled in `.env` |
| Hugo blog repository | Digest pages, paper pages, templates, and publication commits |

See [Data formats](docs/en/data-format.md) for fields and cross-file invariants.

## Development and maintenance

```bash
npm run test:default       # default API and shared Node tests
npm run test:manual        # explicit Manual Node tests
npm test                   # both suites
```

CI also runs Python tests, JavaScript/Python/shell syntax checks, and empty-checkout data validation.
Read [Maintenance](docs/en/maintenance.md) before changing configuration, scoring, prompts, or persisted
contracts.

## Documentation

- [Documentation map](docs/README.md): choose the next document by task.
- [Setup](docs/en/setup.md): environment, proxy, model, and blog repository.
- [Default workflow](docs/en/workflow.md): archive, fetch, filter, analysis, publication, and recovery.
- [Default API architecture](docs/en/architecture.md): components, state machines, locks, and publication transactions.
- [Historical rewrite guide](docs/history-rewrite.md): direct-local inputs, fresh arXiv sources, conference PDFs, and fallback boundaries.
- [Script responsibilities](docs/en/scripts.md): command arguments and runtime semantics.
- [Data formats](docs/en/data-format.md): checkpoints, canonical data, receipts, and manifests.
- [Contract compatibility](docs/en/compatibility.md): current writers, historical reads, and production eligibility.
- [Troubleshooting](docs/en/troubleshooting.md): API, proxy, analysis, publication, and visual failures.
- [Manual subsystem](manual/README.md): explicit high-assurance human workflow.

## Optional integrations

WeChat, Feishu, and Xiaohongshu entrypoints remain available but are not invoked by the default daily
route. Their commands are listed in [Script responsibilities](docs/en/scripts.md).

## Acknowledgments

The project design draws inspiration from
[speech-paper-daily-skill](https://github.com/JusperLee/speech-paper-daily-skill).
