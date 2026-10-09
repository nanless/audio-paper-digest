# Default API Commands and Script Roles

## How to Use This Page

Commands are grouped by task. File responsibilities live in [scripts/README.md](../../scripts/README.md), and `package.json` defines the aliases. Manual commands are in [manual/README.md](../../manual/README.md). DATE, ID, UUID, and uppercase paths are placeholders. Brackets mark optional arguments, and a vertical bar separates alternatives.

## Complete Daily Run

| Command | Purpose |
|---|---|
| `npm run digest:prepare -- DATE` | Run default data and Git publication stages, then prepare visual inputs |
| `npm run digest:api -- DATE` | Exact alias |
| `./run-daily-digest.sh DATE --from STAGE` | Resume from a stage permitted by the program |
| `npm run digest:status -- --date DATE` | Read the current status snapshot |
| `npm run digest:waive-visuals -- --date DATE --reason TEXT` | Record visuals waived by explicit user request |

`digest:manual` requires an explicit request for human processing. Exit 0 from the default entry only means its script stages passed.

Completion also requires a successful GitHub Pages build/deploy for the publication commit, or for a later commit that preserves the reviewed page bytes. Check HTTP 200, the official address, and the title of every digest and paper page by hand, and keep the results. Create, inspect, and record the infographics and cover with the built-in image tool, unless a valid user waiver covers visuals alone. Read `digest:status` afterward. It does not yet check deployment or live pages.

## Workspace Role

Run `npm run workspace:role -- status` before production commands. Daily `digest:*`, `fetch`, `blog:generate/review/push`, and new-conference `conference:new:*` commands use `daily`. Historical `history:*`, older `conference:*` maintenance, `rewrite:source`, and `blog:activate-fresh` use `history`. Do not mix new and old conference entry points.

Keep the current checkout bound to `daily`. Historical commands run here with `PD_WORKSPACE_ALLOW_CROSS_ROLE=1`; the old history checkout is retired. Do not copy its checkpoints into this checkout. The role marker is bound to the real path, Git-ignored, and protected with `0600` permissions. The executing agent must serialize all blog generation, review, and publication.

Cross-role execution is off by default: a `daily` checkout cannot run `history:*`, and the reverse is also refused. The user has decided to run historical work in the current daily checkout, so the local `.env` sets `PD_WORKSPACE_ALLOW_CROSS_ROLE=1`. A value of `1` lets a `daily` checkout run `history` commands and prints a cross-role notice; the reverse direction and the `workspaceRealpath` check still fail. The switch only relaxes the entry check. The executing agent must serialize blog generation, review, and publication across daily, conference, and historical tasks.

## Data Stage

| Command | Behavior |
|---|---|
| `npm run fetch` | Archive, fetch, filter, and analyze; no publication |
| `npm run deep -- --date DATE` | Resume unfinished analysis using the current saved text/PDF |
| `npm run batch` | Analyze unfinished papers in accepted analysis records |
| `npm run batch -- --retry-failed-readers` | Archive and disable failed Reader candidates for unfinished papers, then resume |
| `npm run reanalyze -- --concurrency N` | Archive and disable all old failed Reader candidates, clear Reader/image-supplement state, and force reanalysis from bound sources |
| `node scripts/reanalyze-selected.js ID...` | Reanalyze selected IDs; counters live in `scripts/lib/reanalysis-helpers.js` |
| `npm run api:reader:refresh -- --all --date DATE --concurrency N --scoring-and-reader` | Refresh scores/Reader from bound sources; prepare figures only for the active call |
| `npm run validate:data` | Read-only current data validation |
| `npm run keyword:recall` | Recheck keyword-filter gold data |
| `npm run backfill` | Backfill recent paper metadata; stop on source failures without running historical analysis or publishing pages |
| `npm run paper:rethink` | Historical maintenance tool; no longer integrated into the blog or needed by readers; see the [archived interface documentation](../paper-rethink-companion.md) |

`full-fetch.js` fetches only the Beijing date on which it starts. Background data-only work may call `node scripts/full-fetch.js` directly to avoid npm/TTY wrapper issues. The same environment, role, and outside-sandbox requirements still apply.

`deep`, `batch`, `reanalyze`, and `api:reader:refresh` read only the sources recorded in `deep-analysis-result.json.dailyFreshSourceRun`. They validate the batch date, paper membership, and every `source.txt`, `source.pdf`, runtime record, and manifest. Missing, damaged, or mismatched files fail before any model or figure request. Rerun `npm run digest:prepare -- DATE` only while the target date is Beijing today. For historical dates, keep the failures and use historical maintenance. Never refetch through these recovery entries, substitute old caches, or patch checkpoints.

## Blog Transaction

| Command or argument | Responsibility |
|---|---|
| `npm run blog:generate -- --date DATE` | Pages and generation manifest |
| `npm run blog:review -- --date DATE` | Read-only review, Hugo checks, and receipt |
| `npm run blog:push -- --date DATE` | Exact commit/push and remote OID verification |
| `--include-id ID` | Single-paper scope; the same ID across applicable stages |
| `--exclude-id ID` | Explicit generation exclusion; repeatable |

The manifest records the chosen current file, dated archive, or `--data-file` as `generation-input-source-reference-v1`. Its absolute path, byte count, and SHA-256 enter the input fingerprint. Review and push re-read that exact file and its `dailyFreshSourceRun`, never the `DEEP_ANALYSIS_RESULT_FILE` of the moment. If the input or the saved text/PDF changes, generate again.

A passed page review is reused permanently by relative path and content SHA. Publisher changes still rerender pages. Manifest, code, model, protocol, or Hugo changes require current batch checks and a new receipt. Only a changed page content SHA triggers another page review. Baseline and remote-identity checks stay mandatory.

Each stage takes the shared lock under the blog's Git common-dir, then its project/date lock. Two checkouts targeting one blog cannot concurrently modify its worktree, index, or HEAD. The shared lock is outside tracked blog files. Recovery and release remove only a lock whose inode, token, and SHA still match. `publish-to-blog.py` is shared implementation and a generation compatibility entry, not a bypass around the stages.

Python commands in npm, including blog, visual, Manual, and optional channel commands, use `scripts/python-runtime.sh`, which prefers the project `.venv` and requires Python 3.11+ with OpenSSL.

## Conference Papers

New conferences use the daily workspace to acquire official sources, discover candidates, prepare full-text evidence, and filter. After filtering, `conference:new:process` handles PDF capture, import, analysis, Reader, scoring, tag assignment, and private pages. The separate `conference:new:execution/analyze/postprocess` aliases are disabled.

Process concurrency defaults to 1 and accepts `--concurrency` from 1–5. Each paper's internal analysis concurrency stays 1. Preview with the verified candidate catalog and report filenames, and the filtering task's UUID:

```bash
npm run conference:new:process -- --dry-run --catalog catalog.json --report report.json --filter UUID
```

The independent `conference:new:publish:generate/review/push/status/verify` entries handle publication and checks. Each requires `--conference-id` and `--process-id`. Available commands do not prove that any batch passed source, review, or live-site verification.

Older `conference:*` entries run in the current checkout with the cross-role switch to maintain existing discovery, filtering, extraction, staging, import, plan, execution, analysis, and postprocessing records. The older postprocessing limit is 3, separate from new process settings. Exact arguments and evidence formats are in the [conference workflow](../conference-workflow.md).

## Historical Direct Rewrite

### Sources and plans

`npm run history:inventory -- --dry-run` scans historical pages, URLs, aggregate links, tracked Git tree, dates/cohorts, and unresolved tag URLs. It keeps content SHA, not old prose or sidecar paths. On a clean `main`, write the two protected inventory files:

```bash
npm run history:inventory -- --apply \
  --ledger all-history.json --receipt all-history.receipt.json
```

The files live under `data/runtime/historical-page-inventories`. The active `direct-local-first` route uses a frozen page's unique arXiv hint and verified conference sources, without waiting for crosswalk. Every arXiv `generation` captures new official text, PDF, runtime record, and manifest. Conferences revalidate retained metadata/PDF. Generation is a source capture sequence, distinct from a paper revision `vN`.

Use absolute file paths. Preview before applying, prepare missing PDFs before creating the first local manifest, and do not overwrite immutable names. Prefer official OpenReview sources when reachable. Alternate sources require the code allowlist.

```bash
npm run history:openreview-pdf-source -- --apply \
  --snapshot /abs/data/icml2026/papers.json --forum-id OPENREVIEW_ID
npm run history:icml-alternate-pdf-source -- --apply \
  --snapshot /abs/data/icml2026/papers.json --forum-id jfpkqjhex4
npm run history:icml-alternate-pdf-source -- --apply \
  --snapshot /abs/data/icml2026/papers.json --forum-id n1mAjfRDZ6 \
  --import-file /abs/downloads/ssrn-6288899.pdf
npm run history:conference-local-sources -- --apply \
  --icml-poster-snapshot /abs/data/icml2026/papers.json \
  --icml-pdf-root /abs/data/pdfs/icml2026 \
  --icml-fresh-pdf-root /abs/data/runtime/historical-icml-pdf-sources \
  --openreview-receipt-root /abs/data/runtime/historical-openreview-pdf-sources \
  --alternate-receipt-root /abs/data/runtime/historical-icml-alternate-pdf-sources \
  [--output conference-local-sources-v2.json]
npm run history:direct-inputs -- --apply --conference-manifest /abs/conference-local-sources-v2.json \
  --inventory /abs/all-history.json --blog-root /abs/audio-paper-digest-blog [--name scoped-historical-local-data-v5.json]
npm run history:conference-projections -- --apply --catalog /abs/scoped-historical-local-data-v5.json \
  --inventory /abs/all-history.json [--output conference-page-projections-v3.json]
npm run history:direct-plan -- --apply --catalog /abs/scoped-historical-local-data-v5.json \
  --inventory /abs/all-history.json --conference-projections /abs/conference-page-projections-v3.json \
  [--output direct-rewrite-plan-v5.json]
```

Only an explicit HTTP 404 from the unversioned current arXiv PDF permits an official historical `vN` PDF for the same ID. This fallback rejects cross-ID URLs, queries, fragments, and unofficial hosts, and extracts text from the selected PDF. The `sourceVersion` record binds attempted URL/status, selected version URL, source manifest, analysis evidence, and page manifest. Analysis and the page below front matter show the current-PDF-unavailable warning. Ordinary source bundles retain their existing byte/schema compatibility.

The sole cross-title preprint exception, `n1mAjfRDZ6`, can be fetched from SSRN through the proxy when reachable. A browser download requires `--import-file`. Import checks fixed title, authors, date, multiple cross-page text features, and the allowlisted DOI. It records `operator-browser-download` and `networkResponseObserved: false`, not a fabricated HTTP 200. Plan, model input, and page must disclose that it is not camera-ready. Once the source is saved and checked, the input copy may be deleted. Recovery verifies the saved PDF and receipt without editing old JSON. Ordinary conference plan v5 files retain compatibility.

### Execution, pause, and status

```bash
npm run history:direct-scheduler -- --apply --plan /abs/direct-rewrite-plan-v5.json \
  [--queue all|arxiv|conference] [--generation N] [--paper-ids ID[,ID...]] [--max-papers N] \
  [--arxiv-concurrency 1-8] [--conference-concurrency 1-8]
npm run history:direct-run -- --apply --plan /abs/direct-rewrite-plan-v5.json \
  [--queue all|arxiv|conference] [--generation N] [--paper-ids ID[,ID...]] \
  [--max-papers N] [--concurrency 1-8]
npm run history:status -- --plan /abs/direct-rewrite-plan-v5.json [--generation N] [--watch-seconds N]
npm run history:status -- --plan /abs/direct-rewrite-plan-v5.json [--generation N] --verify-sources true
npm run history:status -- --plan /abs/direct-rewrite-plan-v5.json --publication-id UUID
npm run history:pause -- --plan /abs/direct-rewrite-plan-v5.json --phase source|analysis [--generation N]
npm run history:resume -- --plan /abs/direct-rewrite-plan-v5.json --phase source|analysis [--generation N]
```

`direct-run --apply` requires the same plan/generation's saved scheduler status and every selected paper to be `ready`. It does not fetch missing sources. Recoverable analysis saves source-bound checkpoints for another process. Only complete analysis, Reader, and source evidence can produce private pages. Scheduler arXiv/conference concurrency defaults to 3/5, each in 1–8. Direct-run defaults to 3, in 1–8.

Pause requests let active sources or papers finish. Resume the same phase only after its operation lock is released. Normal status is a snapshot. `--watch-seconds` emits NDJSON. One-shot `--verify-sources true` rehashes all local sources and cannot be combined with watch.

Without `--publication-id`, normal/watch status remains offline and reports no publication selected. Selecting one enables live remote-main verification against receipt identity/OID by default. `--live-remote false` is diagnostic-only and cannot complete. Publication status is one-shot, incompatible with watch, and deeply revalidates every arXiv bundle and conference source SHA.

Completion requires the plan's full paper set, sources, daily/conference aggregates, exact task-page coverage, and a completed live publication bound to the same plan SHA. Counts come from plan/projection. Numbers such as 3,824 papers, 107 daily plus 3 conference aggregates, or 193 task pages describe only a particular plan, not universal thresholds. `completion.blockers` reports uncovered pages, failed/unstaged papers, missing aggregates, and unselected, incomplete, or mismatched publication.

### Aggregates and independent publication

```bash
npm run history:direct-aggregate -- projection --apply --plan-file /abs/direct-rewrite-plan-v5.json \
  --inventory-file /abs/all-history.json --output-name direct-aggregate-projection-v3.json
npm run history:direct-aggregate -- aggregate --apply --plan-file /abs/direct-rewrite-plan-v5.json \
  --registry-file /abs/direct-rewrite-registry.json --projection-file /abs/direct-aggregate-projection-v3.json \
  (--daily YYYY-MM-DD|--conference conference-key)
```

Projection v3 maps frozen `outboundPostLinks` from conference task pages to paper members and records per-page source SHA and coverage. Conference aggregation writes task pages first and the conference index last in the same run. Daily indexes with no paper members are explicitly `retain-unchanged` and still included in coverage checks.

Publication uses `history:direct-publication` through plan, generate, review, publish, and status. Passed pages reuse only path/content SHA. Each current batch still runs deterministic/Hugo checks and creates a receipt. Standalone `activate --apply` is disabled. `publish --apply` handles activation, commit, push, and remote OID under the shared blog lock. See [independent historical publication](../history-direct-publication.md) for arguments and visual disposition. The older `history:publication` has only private plan/generate output.

Normal direct work does not depend on crosswalk. `history:crosswalk` still permits explicit older-state maintenance: prepare with `--apply`, apply, apply-verified, and finalize may write state or receipts after their source-authorization and CAS checks. The fallback `history:arxiv-batch` requires `--handoffs NAME.json[,NAME.json...]`, accepts only named immutable fresh-arXiv failure handoffs from scheduler/run, and does not enumerate pending pages. A missing or damaged conference source fails its own item, not this fallback. `history:local-crawl-batch`, the `archive-crawl-batch` alias, and `history:conference-crawl-batch` are disabled. See the [historical rewrite guide](../history-rewrite.md).

## Visual State Machines

| Command | Behavior |
|---|---|
| `npm run visual:post-publish -- --date DATE` | Plan both image types from verified publication |
| `npm run visual:prepare -- --date DATE` | Validate legacy reference caches and return absolute paths. Current temporary-image daily runs verify figure identity and return no reference paths |
| `npm run visual:status -- --date DATE` | Read paper infographic status |
| `npm run visual:record -- --date DATE --paper ID --kind infographic --file /abs/result.png --token TOKEN --qa-attested true` | Record an inspected infographic; `--output-hint HINT` may replace `--file` |
| `npm run visual:fail -- ...` | Save infographic failure |
| `npm run cover:status -- --date DATE` | Read cover status |
| `npm run cover:record -- --date DATE --file /abs/cover.png --token TOKEN --qa-attested true` | Record an inspected cover; `--output-hint HINT` may replace `--file` |
| `npm run cover:fail -- ...` | Save cover failure |

Only built-in `image_gen` creates final art. `visual:render:debug` is for debugging or offline fallback. TOKEN comes from `taskToken` in the corresponding visual/cover status task. Never reuse an older task token.

## Shared Runtime

| File | Responsibility |
|---|---|
| `scripts/config.js` | Node settings and current paths |
| `scripts/env-loader.js`, `scripts/project_env.py` | Project environment and outside-sandbox checks |
| `scripts/utils.js` | Protocol, proxy, prompts, atomic writes, time, and IDs |
| `scripts/llm-account-pool.js`, `scripts/llm_account_pool.py` | Shared account selection/cooldown state |
| `scripts/analysis-engine.js` | Paper locks, retries, checkpoints, and accepted-record merges |
| `scripts/deep-analyzer.js` | Staged analysis and Reader |
| `scripts/path_config.py` | Python publishing paths |
| `scripts/publish_common.py` | Publishing data, scores, LLM calls, and source validation |
| `scripts/publish-to-blog.py` | Shared generation/review/push transaction |
| `scripts/python-runtime.sh` | Python 3.11+ and OpenSSL runtime selection |

## Runtime Storage

| Command | Behavior |
|---|---|
| `npm run storage:status` | Read-only size/file counts for current, archive, logs, and key caches |
| `npm run storage:prune` | Scan saved JSON references and print a deletion preview |
| `npm run storage:prune -- --apply` | After stopping all writers and passing safety checks, delete only expired unreferenced allowlisted files |

`scripts/runtime-storage.js` never deletes accepted analysis JSON, publication/visual manifests, blog files, or archived final assets. Status and previews may run while tasks are active. Before deleting anything, stop all writers. See [Maintenance](maintenance.md#runtime-storage).

## Optional Channels

`npm run wechat`, `npm run xiaohongshu`, `npm run xhs-login`, `npm run xhs-publish`, and `publish-to-feishu.py` are outside default daily work. Real external writes require an explicit user request.

## Tests

```bash
npm test
npm run test:default
npm run test:manual
npm run validate:data -- --allow-empty
```

Use `--allow-empty` only for CI or a clean checkout without data. CI also checks default/Manual JavaScript and Python, both Python test suites, and repository shell syntax. Run project checks outside the sandbox. Maintenance explains full verify versus quick checks.
