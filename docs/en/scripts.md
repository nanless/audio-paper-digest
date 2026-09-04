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

## Data Stage

| Command | Behavior |
|---|---|
| `npm run fetch` | archive, fetch, filter, analyze; no publication |
| `npm run deep -- --date DATE` | safely continue analysis |
| `npm run batch` | analyze unfinished canonical papers |
| `npm run reanalyze -- --concurrency N` | force full reanalysis |
| `node scripts/analyze-single-paper.js ID --force` | analyze one paper |
| `node scripts/reanalyze-selected.js ID...` | reanalyze selected IDs |
| `node scripts/refilter-reanalyze-by-date.js DATE` | controlled historical refilter/reanalysis |
| `npm run api:reader:refresh -- --all --date DATE --concurrency N --scoring-and-reader` | batch score/Reader refresh |
| `npm run validate:data` | read-only current validation |
| `npm run keyword:recall` | keyword-gate gold replay |
| `npm run backfill` | ID backfill only |

A fetch-start run accepts Beijing today. Direct `node scripts/full-fetch.js` is preferable for background data-only execution when npm/TTY wrappers are unreliable.

## Blog Transaction

| Command | Sole responsibility |
|---|---|
| `npm run blog:generate -- --date DATE` | pages and generation manifest |
| `npm run blog:review -- --date DATE` | read-only review, Hugo gate, receipt |
| `npm run blog:push -- --date DATE` | exact commit/push and remote OID |
| `--include-id ID` | isolated paper scope; same ID across applicable stages |
| `--exclude-id ID` | explicit generation exclusion; repeatable |

`publish-to-blog.py` is shared implementation and a generation compatibility entry, not a bypass around the three stages.

Default blog and visual commands pass through `scripts/python-runtime.sh`, which prefers the project `.venv` and rejects Python versions below 3.11 or non-OpenSSL TLS runtimes.

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
