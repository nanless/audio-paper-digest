# Default API Commands and Script Roles

## How to Use This Page

This page is task-oriented. See [scripts/README.md](../../scripts/README.md) for file dependencies; `package.json` is authoritative for aliases. Manual commands live only in [manual/README.md](../../manual/README.md).

## Complete Daily Run

| Command | Purpose |
|---|---|
| `npm run digest:prepare -- DATE` | scripted LLM/API stages through blog publication and visual-input preparation; exit 0 is not the final visual state |
| `npm run digest:api -- DATE` | exact alias |
| `./run-daily-digest.sh DATE --from STAGE` | resume from a safe stage |
| `npm run digest:status -- --date DATE` | read-only final snapshot |
| `npm run digest:waive-visuals -- --date DATE --reason TEXT` | explicit user visual waiver |

## Workspace Role

Run `npm run workspace:role -- status` before a production command. `digest:*`, `fetch`, and
`blog:generate/review/push` require the `daily` workspace; `history:*`, `conference:*`, `rewrite:source`, and
`blog:activate-fresh` require `history`. Bind a verified checkout with
`npm run workspace:role -- set daily|history [--force]`.

## Data Stage

| Command | Behavior |
|---|---|
| `npm run fetch` | archive, fetch, filter, analyze; no publication |
| `npm run deep -- --date DATE` | continue only from the current sealed PDF/TXT source run; never refetch or use legacy cache |
| `npm run batch` | analyze unfinished canonical papers only from current sealed PDF/TXT |
| `npm run reanalyze -- --concurrency N` | force reanalysis while replaying only current sealed PDF/TXT |
| `node scripts/analyze-single-paper.js ID --force` | analyze one paper |
| `node scripts/reanalyze-selected.js ID...` | reanalyze selected IDs |
| `node scripts/refilter-reanalyze-by-date.js DATE` | controlled historical refilter/reanalysis |
| `npm run api:reader:refresh -- --all --date DATE --concurrency N --scoring-and-reader` | batch score/Reader refresh from sealed PDF/TXT; figures are call-temporary |
| `npm run validate:data` | read-only current validation |
| `npm run keyword:recall` | keyword-gate gold replay |
| `npm run backfill` | ID backfill only |
| `npm run paper:rethink` | historical standalone maintenance tool; no longer integrated into the blog and not needed by readers; see the [archived interface documentation](../paper-rethink-companion.md) |

A fetch-start run accepts Beijing today. Direct `node scripts/full-fetch.js` is preferable for background data-only execution when npm/TTY wrappers are unreliable.

All four recovery entries require an exact replay of `deep-analysis-result.json.dailyFreshSourceRun`: its batch date, canonical paper set, and each `source.txt`, `source.pdf`, runtime metadata, and manifest. Missing or drifted bundles fail before model or image work. Re-run `npm run digest:prepare -- DATE` to establish a new source phase; do not patch checkpoints.

## Blog Transaction

| Command | Sole responsibility |
|---|---|
| `npm run blog:generate -- --date DATE` | pages and generation manifest |
| `npm run blog:review -- --date DATE` | read-only review, Hugo gate, receipt |
| `npm run blog:push -- --date DATE` | exact commit/push and remote OID |
| `--include-id ID` | isolated paper scope; same ID across applicable stages |
| `--exclude-id ID` | explicit generation exclusion; repeatable |

The generation manifest records the actual current file, dated archive, or explicit `--data-file` as
`generation-input-source-reference-v1`; its absolute path, byte count, and SHA-256 enter the input fingerprint.
Review and push replay only that file and its `dailyFreshSourceRun`, never the then-current
`DEEP_ANALYSIS_RESULT_FILE`. Input or sealed PDF/TXT drift requires generation again.

`publish-to-blog.py` is shared implementation and a generation compatibility entry, not a bypass around the three stages.

Default blog and visual commands pass through `scripts/python-runtime.sh`, which prefers the project `.venv` and rejects Python versions below 3.11 or non-OpenSSL TLS runtimes.

## Historical Direct Rewrite

The active historical route is `conference-local-sources → direct-inputs → conference-projections → direct-plan
→ direct-scheduler → direct-run → direct-aggregate`. It does not wait for crosswalk: arXiv derives from a frozen
single historical hint and freshly seals official TXT/PDF/runtime/manifest per generation; conference replays
bound retained metadata/PDF SHA. Crosswalk accepts only a named immutable fresh-arXiv failure handoff; a damaged or
missing local conference source fails its direct item closed. Historical review, activation, commit/push receipt, and remote-OID publication
are not implemented.

```bash
npm run history:conference-local-sources -- --dry-run|--apply [--output NAME.json]
npm run history:direct-inputs -- --dry-run|--apply --conference-manifest /abs/FILE.json --inventory /abs/FILE.json --blog-root /abs/DIR [--name NAME.json]
npm run history:conference-projections -- --dry-run|--apply --catalog /abs/FILE.json --inventory /abs/FILE.json [--output NAME.json]
npm run history:direct-plan -- --dry-run|--apply --catalog /abs/FILE.json --inventory /abs/FILE.json --conference-projections /abs/FILE.json [--output NAME.json]
npm run history:direct-scheduler -- --dry-run|--apply --plan /abs/FILE.json [--queue all|arxiv|conference] [--generation N] [--arxiv-concurrency 1-8] [--conference-concurrency 1-8]
npm run history:direct-run -- --dry-run|--apply --plan /abs/FILE.json [--queue all|arxiv|conference] [--generation N] [--concurrency 1-8]
npm run history:direct-aggregate -- projection --dry-run|--apply --plan-file /abs/FILE.json --inventory-file /abs/FILE.json --output-name NAME.json
npm run history:direct-aggregate -- aggregate --dry-run|--apply --plan-file /abs/FILE.json --registry-file /abs/FILE.json --projection-file /abs/FILE.json (--daily YYYY-MM-DD|--conference KEY)
```

`history:crosswalk` remains read-only/audit state for the active route. `history:arxiv-batch` requires explicit named
immutable failure handoffs; it does not enumerate pending hints. `history:local-crawl-batch` (the
`archive-crawl-batch` compatibility alias) and `history:conference-crawl-batch` are retired fail-closed endpoints.
The detailed active guide is currently
[Chinese](../history-rewrite.md).

## Visual State Machines

| Command | Behavior |
|---|---|
| `npm run visual:post-publish -- --date DATE` | plan both visual types from verified publication |
| `npm run visual:prepare -- --date DATE` | validate references and emit absolute paths |
| `npm run visual:status -- --date DATE` | paper infographic status |
| `npm run visual:record -- --date DATE --paper ID --kind infographic --file /abs/result.png --token TOKEN --qa-attested true` | record an inspected paper image; `--output-hint` may replace `--file` |
| `npm run visual:fail -- ...` | record paper-image failure |
| `npm run cover:status -- --date DATE` | cover status |
| `npm run cover:record -- --date DATE --file /abs/cover.png --token TOKEN --qa-attested true` | record an inspected cover; `--output-hint` may replace `--file` |
| `npm run cover:fail -- ...` | record cover failure |

Only built-in `image_gen` creates final art. `visual:render:debug` is debugging/offline fallback.

## Shared Runtime

- `config.js`: Node parameters and current paths.
- `env-loader.js` / `project_env.py`: project environment and sandbox guard.
- `utils.js`: protocol, proxy, prompt, atomic file, time, and ID utilities.
- `llm-account-pool.js`: OpenCode Go long-lived sticky account selection, explicit quota classification, and shared state.
- `analysis-engine.js`: locks, retries, checkpoints, merge.
- `deep-analyzer.js`: per-paper staged analysis and Reader.
- `path_config.py`: Python publishing paths.
- `llm_account_pool.py`: the matching Python account-pool state machine used by publication review.
- `publish_common.py`: publishing data, scoring, LLM, provenance.
- `publish-to-blog.py`: shared blog transaction implementation.

## Runtime Storage

| Command | Behavior |
|---|---|
| `npm run storage:status` | read-only size and file-count report for `data/current`, `data/archive`, `logs`, and important caches |
| `npm run storage:prune` | scan authoritative JSON references and print a dry-run deletion list without deleting files |
| `npm run storage:prune -- --apply` | after fail-closed validation, delete only expired, unreferenced files inside fixed allowlisted roots |

`scripts/runtime-storage.js` never targets canonical JSON, publication/visual manifests, blog files, or archived final assets. Apply is blocked by invalid JSON, symlinks, path escapes, or a changed reference/candidate snapshot.

## Optional Channels

`npm run wechat`, `npm run xiaohongshu`, XHS login/publish commands, and `publish-to-feishu.py` are outside the default daily run. Do not perform real external writes unless explicitly requested.

## Tests

```bash
npm test
npm run test:default
npm run test:manual
npm run validate:data -- --allow-empty
```

CI additionally checks JavaScript, Python, Python unit suites, and repository shell syntax. Run all project commands outside the sandbox.
