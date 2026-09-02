# Default API Commands and Script Roles

## How to Use This Page

This page is task-oriented. See [scripts/README.md](../../scripts/README.md) for file dependencies; `package.json` is authoritative for aliases. Manual commands live only in [manual/README.md](../../manual/README.md).

## Complete Daily Run

| Command | Purpose |
|---|---|
| `npm run digest:prepare -- DATE` | default complete LLM/API orchestration |
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

## Visual State Machines

| Command | Behavior |
|---|---|
| `npm run visual:post-publish -- --date DATE` | plan both visual types from verified publication |
| `npm run visual:prepare -- --date DATE` | validate references and emit absolute paths |
| `npm run visual:status -- --date DATE` | paper infographic status |
| `npm run visual:record -- ... --qa-attested true` | record inspected paper image |
| `npm run visual:fail -- ...` | record paper-image failure |
| `npm run cover:status -- --date DATE` | cover status |
| `npm run cover:record -- ... --qa-attested true` | record inspected cover |
| `npm run cover:fail -- ...` | record cover failure |

Only built-in `image_gen` creates final art. `visual:render:debug` is debugging/offline fallback.

## Shared Runtime

- `config.js`: Node parameters and current paths.
- `env-loader.js` / `project_env.py`: project environment and sandbox guard.
- `utils.js`: protocol, proxy, prompt, atomic file, time, and ID utilities.
- `analysis-engine.js`: locks, retries, checkpoints, merge.
- `deep-analyzer.js`: per-paper staged analysis and Reader.
- `path_config.py`: Python publishing paths.
- `publish_common.py`: publishing data, scoring, LLM, provenance.
- `publish-to-blog.py`: shared blog transaction implementation.

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
