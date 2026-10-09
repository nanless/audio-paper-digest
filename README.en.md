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

The default route is LLM/API:

```text
arXiv + HuggingFace
  → keyword prefilter → per-paper LLM filter → capture this run's official arXiv text/PDF
  → staged full-text analysis and scoring
  → blog generate → review → push / remote-OID verification
  → TOP 10 infographics and digest cover → final status gate
```

- `digest:prepare` and `digest:api` are aliases for the same default route.
- After filtering and before deep analysis, every selected arXiv paper is captured into a saved source
  generation at `data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/`.
  It contains `source.txt`, `source.pdf`, `source-runtime.json`, and `source-manifest.json`. Analysis,
  Reader, generate, review, and push validate and use that exact bundle. Images for a model request
  are prepared in the system temporary directory and cleaned up afterward; their pixels are never saved in a runtime cache.
- Manual runs only when someone explicitly selects it; API, network, or quota failures never switch to it automatically.
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
PAPER_DIGEST_BLOG_REPO=/absolute/path/to/audio-paper-digest-blog
```

After an allowed account switch, later requests keep using the successful account across processes and dates.
Accounts are not rotated to balance load. See [Setup](docs/en/setup.md) for the switching conditions, model,
protocol, and proxy requirements. Project commands must run outside the sandbox; entrypoints reject a
restricted sandbox before network access, logging, or writes.

Confirm what this checkout is for, then inspect its role:

```bash
npm run workspace:role -- status
```

Keep the current checkout in the `daily` role for daily, conference, and historical work. Use `PD_WORKSPACE_ALLOW_CROSS_ROLE=1` for historical commands; the old history checkout is retired. Stop if the marker is
missing or its real path does not match. Only after confirming the directory purpose, use
`npm run workspace:role -- set daily|history [--force]` to bind the appropriate role.

```bash
# 3. Run Node tests
npm test

# 4. Run the complete script stages for Beijing today
today="$(TZ=Asia/Shanghai date +%F)"
npm run digest:prepare -- "$today"
```

`digest:prepare` processes the data, publishes the Git commit, and prepares visual tasks. The Agent must
then verify deployment and the live pages, use Codex built-in image generation, inspect each image,
and record the results. An explicit user-requested waiver may replace the visuals. Scripts do not call an image API.

```bash
# 5. Verify final status
npm run digest:status -- --date "$today"
```

## Definition of done

A complete daily run means all of the following:

1. Fetching, filtering, and deep analysis are complete, and their data matches across files.
2. The digest and every paper page passed review; the blog commit is pushed and matches the remote OID.
3. GitHub Pages build/deploy succeeded for the publication commit, or a later commit that preserves the
   reviewed page bytes. The Agent manually checks HTTP 200, the official address, and the title of every
   digest and paper page, and saves the deployment and page-check records.
4. TOP 10 infographics and the digest cover are recorded, or an explicit waiver binds the current publication.
5. A fresh `digest:status` report, read after the last push or image record, lists no incomplete stage.
   This command does not yet verify deployment or live pages, so it cannot replace step 3.

Once the blog is published, a visual failure does not revoke it and must not trigger blog regeneration
or another page review.

## Full-history rewrite

Daily, conference, and historical work now share the current `audio-paper-digest` checkout. Keep its role as `daily` and enable `PD_WORKSPACE_ALLOW_CROSS_ROLE=1` for historical commands. The old history checkout is retired. The executing agent must serialize generation, review, and publication across these workflows. The active historical route is
`direct-local-first`:

```text
retained local conference metadata/PDF ─┐
                                        ├→ direct-inputs → conference-projections → direct-plan
frozen historical arXiv links ─────────┘                                  ├→ direct-scheduler → direct-run → staging
                                                                            └→ direct-aggregate
```

- When OpenReview is unreachable, the default is to stop rather than switch to another source on its own.
- The arXiv route fetches and saves a new official `source.txt`, `source.pdf`, runtime metadata, and
  manifest for every generation under `data/runtime/fetched-arxiv-sources/`; it never uses retained
  arXiv text, PDF, figures, old posts, old analyses, or old Reader prose as writing input.
- The conference route rechecks the retained local metadata/PDF SHA selected by the frozen-page
  projection. One paper is analyzed once and then projected to every frozen historical page.
- The fallback `history:arxiv-batch` accepts only named immutable handoffs from failed fresh arXiv acquisition.
  `history:crosswalk` still permits explicit maintenance of older records after source authorization and CAS checks.
  An unavailable or damaged retained conference source stops its own direct route, never enters the arXiv fallback,
  and does not block the remaining direct queue.
- Long tasks can be run in batches, inspected, paused safely, and resumed.
- Analysis first produces private source, analysis, page, and aggregate files. The independent
  `history:direct-publication` entry provides `plan → generate → review → publish → status`. It requires
  complete source and page coverage, successful reviews, and valid Git baseline and remote checks
  before replacing blog pages. The presence of this entry does not mean the full history has been processed or published.
- Alternative OpenReview sources are rejected by default. The sole authorized cross-title exception,
  `n1mAjfRDZ6`, may use the authors' SSRN preprint, with an explicit “not camera-ready” notice in model
  input, the page header, and staging manifest, plus verified source title, DOI, acquisition receipt, and source SHA.

The active commands and exact absolute-path arguments are documented in the Chinese
[historical rewrite guide](docs/history-rewrite.md) and [independent historical publication guide](docs/history-direct-publication.md).

## Core commands

| Purpose | Command |
|---|---|
| Default daily run | `npm run digest:prepare -- YYYY-MM-DD` |
| Resume incomplete analysis | `npm run deep -- --date YYYY-MM-DD` (reuses only the saved PDF/TXT bundle) |
| Refresh API Reader | `npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader` (reuses only the saved PDF/TXT bundle) |
| Validate current data | `npm run validate:data` |
| Inspect runtime storage | `npm run storage:status` |
| Preview reference-aware pruning | `npm run storage:prune` |
| Inspect final status | `npm run digest:status -- --date YYYY-MM-DD` |
| Run blog stages separately | `npm run blog:generate` → `npm run blog:review` → `npm run blog:push` |
| Record an explicit visual waiver | `npm run digest:waive-visuals -- --date YYYY-MM-DD --reason "..."` |
| Explicit Manual route | `npm run digest:manual -- YYYY-MM-DD` |

See [Script responsibilities](docs/en/scripts.md) for arguments and recovery semantics, or
[`scripts/README.md`](scripts/README.md) for a compact file-to-responsibility index.

## Tag system and read-only historical preview

```bash
npm run tags:validate
npm run tags:preview
npm run tags:serve
```

The shared tag catalog defines stable IDs, parent relationships, and classification dimensions such as task and method. The preview reads the configured Hugo checkout and keeps both original tags and tags that could not be matched to the catalog.

You can search by a parent tag. When you select several tags in one dimension, matching any one is enough; conditions from different dimensions must all match. The results show how old labels map to the catalog, and **you cannot conclude from them that a paper has been reclassified against its source and reviewed.** The preview leaves articles, scores, and existing tag URLs unchanged and makes no paper-model API requests. Its static server runs only on the local loopback address.

The site search index uses tag fields such as `tagContract` and `tagConcepts`, and `tagCatalogSha256` records the SHA of the catalog file. The new paper library, search, and reading exports keep reading the old index, but a single record cannot mix old and new fields. Historical paper source proof and already-verified classification are still checked against their original versions.

The publisher and the site use `tag-catalog-snapshot.json`, `tag-catalog-versions.json`, and `tag-presentation-policy.json`. Tag logic lives in `tag-core.js`, catalog interaction in `tag-browser.js`, and the browser interface is `ResearchTags`. The display catalog and the original catalog used to verify historical papers are read separately; old-version files keep their original content, and a new file cannot replace the original source proof. The standard Hugo API and the original names in historical proofs are still read by their original definitions.

See the [implementation plan](docs/tag-system-implementation.md) and [tag design](docs/tag-system-design.md) (Chinese).

## Where to resume after a failure

- Interrupted fetch/filter: rerun the default entry; checkpoints that pass validation are reused.
- Only some analyses failed: run `npm run deep -- --date YYYY-MM-DD` or targeted reanalysis. These
  recovery commands read only the source bundle bound to the current analysis data. They never refetch, create
  replacement source files, or reuse legacy text or caches. If files are missing or their SHA no longer matches,
  rerun `npm run digest:prepare -- YYYY-MM-DD` only while the target date is still Beijing today.
  For historical dates, keep the failure records and follow the historical maintenance workflow.
- Blog review/push failed: resume with `npm run blog:review -- --date YYYY-MM-DD` or `npm run blog:push -- --date YYYY-MM-DD`.
- Visual tasks are missing or stale: run `npm run visual:post-publish -- --date YYYY-MM-DD`; do not republish the blog. Division of labor: `visual:post-publish` (re)plans both image task types, while `visual:prepare` emits the current reference paths before generation once tasks exist (see [Workflow](docs/en/workflow.md) §7).
- Unsure which stage failed: start with [Troubleshooting](docs/en/troubleshooting.md) and
  [Workflow](docs/en/workflow.md).

A fresh fetch may bind only Beijing today. Historical dates must resume from existing controlled data;
they cannot be produced by running a new crawl under an old date.

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

Default API and explicit Manual share publication and visual tooling, but each keeps its own content
evidence and provenance, and the two must not be mixed in one batch. Manual scripts, prompts, tests, and workflow live under
[`manual/`](manual/README.md).

## Data and outputs

| Location | Contents |
|---|---|
| `data/current/` | Current candidates, filtering, analysis, publication receipts, and visual state |
| `data/archive/<date>/` | Daily snapshots and final visual assets |
| `data/runtime/daily-fresh-source-runs/` | Daily official PDF/TXT source generations that API analysis and publication read and recheck |
| `data/runtime/fetched-arxiv-sources/` | Official PDF/TXT source generations for historical direct arXiv rewrites |
| other historical `data/runtime/` directories | Rewrite plans, private analysis, pages, and aggregates; creating them does not publish the blog |
| `logs/` | Redacted run logs; file logging can be disabled in `.env` |
| Hugo blog repository | Digest pages, paper pages, templates, and publication commits |

See [Data formats](docs/en/data-format.md) for fields and the relationships checked across files.

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
- [Default API architecture](docs/en/architecture.md): components, stage dependencies, locks, and publication checks.
- [Historical rewrite guide](docs/history-rewrite.md): direct-local inputs, fresh arXiv sources, conference PDFs, and fallback boundaries.
- [Script responsibilities](docs/en/scripts.md): command arguments and runtime semantics.
- [Data formats](docs/en/data-format.md): checkpoints, accepted analysis records, and publication records.
- [Contract compatibility](docs/en/compatibility.md): current output formats, historical reads, and publication requirements.
- [Troubleshooting](docs/en/troubleshooting.md): API, proxy, analysis, publication, and visual failures.
- [Manual subsystem](manual/README.md): explicitly selected human workflow.

## Optional integrations

WeChat, Feishu, and Xiaohongshu entrypoints remain available but are not invoked by the default daily
route. Their commands are listed in [Script responsibilities](docs/en/scripts.md).

## Acknowledgments

The project design draws inspiration from
[speech-paper-daily-skill](https://github.com/JusperLee/speech-paper-daily-skill).
