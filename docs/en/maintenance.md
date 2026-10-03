# Maintenance Guide

## Audience and Method

This guide is for maintainers changing the default API, shared publication, prompts, data formats, or documentation. Find the implementation that owns the setting or interface, then update its consumers, tests, and documentation. Manual maintenance starts at [manual/README.md](../../manual/README.md).

## Change Routing

| Change | Primary implementation | Consumers to inspect |
|---|---|---|
| Node settings/paths | `scripts/config.js` | Entry points, tests, env.example |
| Python publishing paths | `scripts/path_config.py` | generate/review/push and tests |
| Protocol/proxy | `scripts/utils.js`, `scripts/publish_common.py` | Filtering, analysis, page review, key tests |
| Daily sealed text/PDF | `lib/daily-fresh-source-plan.js`, `lib/fresh-arxiv-rewrite-source.js` | full-fetch, four recovery entries, validators, Python publication, storage, docs |
| Historical direct sources/page mappings | `historical-direct-*`, `historical-conference-*-sources/projections` | Catalog, plan, scheduler, runner, aggregate, arXiv failure handoffs, history docs |
| Recovery | `analysis-engine.js`, `deep-analyzer.js` | All analysis entries and status |
| Analysis/scoring | `analysis-contract.js` and prompts | Node/Python parsers, publisher |
| Reader writing/tables/repair | `api-reader-article.md`, `api-reader-repair.md`, `lib/reader-contract.js`, `lib/reader-tables.js`, `lib/reader-repair.js` | Validators, candidates and stage fingerprints, blog review |
| Blog transaction | `publish-to-blog.py` | Three entry points and receipt tests |
| Visual state | State modules and integration | Planner, status, record |
| Command alias | `package.json` | User and Agent documentation |

## Invariants

- Default daily work uses LLM/API; errors never select Manual.
- Project configuration comes from the root `.env`. External subprocesses use the prescribed minimal environment rather than inheriting unrelated credentials.
- Muse and arXiv require the project proxy; other LLM providers default to `agent:false`.
- Per-paper analysis and shared JSON updates acquire locks and reread inside them.
- Changed checkpoint fingerprints invalidate only necessary stages.
- Daily analysis, Reader, and publication use only bound text, PDF, runtime records, and manifests. If these are missing or no longer match, rerun `digest:prepare` only while the target date is Beijing today. For historical dates, retain failures and use historical maintenance; never substitute old caches.
- Each historical arXiv source generation captures new official files. Historical conference entries revalidate bound metadata/PDF SHA. Neither may use old blog prose, analysis, or Reader text as writing input.
- Generate, review, and push stay separate; review reads final bytes without changing them.
- Production proof, page SHA, Git baseline, remote OID, and visual tasks require their respective checks.
- Project scripts never call an image API.

## Prompt Changes

`loadPrompt()` reads the first fenced block. Check that placeholders match the caller, output matches the parser, inner examples do not break the outer fence, and the prompt SHA belongs to the correct stage fingerprint. Retry feedback must locate the problem and limit changes. Reader prose must contain no template sentences, evidence IDs, or workflow commentary.

Scoring changes must preserve dimension order/ranges, Open Source anchors, evidence IDs, and code-calculated caps. Sample Reader output for term bridges, table explanations, adjacent figure discussion, and limits on descriptions without pixels.

Table-count diagnostics use a stable `code`, `requiredCount`, and `actualCount`. Changes must cover production, collection, repair, feedback, and recovery signatures; new typed diagnostics must not fall back to parsing prose. See [Data formats](data-format.md) and [Reader writing](../reader-writing.md) for fields and bounded legacy compatibility.

## Data Contracts

Explain each new field's purpose and validation:

| Purpose | Requirement |
|---|---|
| Original fact or source | Include in the relevant input/source SHA |
| Derived cache | Rebuild from original bytes |
| Recovery state | Save a version and stage fingerprint |
| Publication receipt | Bind exact files and required external state |
| Optional diagnostic | Do not independently change completion |

Structural changes require Node validators, Python publishers, fixtures, migration/historical compatibility, and `validate:data` updates. SHA checks bytes and correspondence; it does not establish content correctness or successful deployment.

## Concurrency and Atomicity

Use atomic JSON writes. Read-modify-write operations acquire shared locks, reread the latest accepted record, merge only the owned paper or field, and increment `generation`. Never overwrite it with a whole array read outside the lock.

Long tasks use heartbeats and leases. Only the implementation's owner and lease checks may authorize recovery. Node analysis stops claiming papers after a run-level failure; Python page review submits thread tasks in advance and does not have the same dispatch behavior.

## Security and Logs

Use HTTPS for external resources, except loopback tests. Revalidate DNS/IP on external redirects. Every nonempty physical log line uses a millisecond Beijing timestamp. Logs and `.env` use `0600` permissions. Redact authentication headers, cookies, tokens, secrets, passwords, configured key values, and URL userinfo. Never commit `data/`, `logs/`, `.env`, backups, or caches.

## Runtime storage

`npm run storage:status` reports size and file counts, including protected daily sources, historical sources/plans/private pages, and conference evidence. These are inputs and recovery evidence, not disposable caches; prune never removes them.

`npm run storage:prune` scans references and prints a deletion preview. Status and previews can run while tasks are active. Actual deletion requires checking the preview and stopping all fetching, filtering, analysis, blog generation/review/push, and visual writers before:

```bash
npm run storage:prune -- --apply
```

Retention defaults to 30 days and can be overridden with a positive `PD_STORAGE_RETENTION_DAYS`. The only targets are `logs`, `image-cache`, `api-reader-assets`, `visual-reference-inputs`, and the unused debug directories `deep_analyzer_input_output`, `filter_input_output`, and `iclr_filter_input_output`. Cache pruning scans current/archive JSON for absolute/relative paths and URL SHA-256 references. Accepted analysis JSON, publication/visual manifests, archived final assets, and blog files are excluded.

Invalid JSON, symlinks, path escapes, changed files, live local lock owners, or owners that cannot reliably be checked block deletion. Prune never removes locks. It rescans references and candidates, but no transaction lock covers every writer between scanning and deletion. Stopping writers before `--apply` remains mandatory. A preview may report blockers; its successful execution is not permission to delete.

## Verification

For an explicitly requested rewrite of an existing daily batch without old generated prose, use the [fresh rewrite staged workflow](../fresh-rewrite.md). Full history uses the [direct-local-first workflow](../history-rewrite.md): revalidate retained conference metadata/PDF and capture new arXiv text/PDF each generation. Only named immutable acquisition-failure handoffs may enter the fallback `history:arxiv-batch`; other explicit crosswalk maintenance can still write older state after its checks. Ordinary reanalysis, Reader refresh, or deleting an analysis field provides neither isolation guarantee. `rewrite:source` prepare/status do not call models; sources/analyze are explicit, and promote requires complete same-run/source evidence and baseline CAS before replacing accepted data.

```bash
npm run verify
git diff --check
```

Full `verify` runs outside the sandbox and first requires Hugo **0.160.1**, matching blog deployment. It checks repository JS/Python/shell syntax, runs `npm test` once for default and Manual JavaScript, both Python suites, and read-only data validation. Any failure exits nonzero. The real Hugo resource fixture must build; missing Hugo cannot count as full success. Traversal excludes vendor/runtime directories such as `node_modules`, `.venv`, `data`, `logs`, and `.git`, and does not follow symlinks. Python bytecode uses a private temporary directory.

Only CI or a clean checkout without data explicitly uses `npm run verify -- --allow-empty`. Normal verification checks existing data. `npm run verify -- --quick` checks syntax and data only, without tests or Hugo, and cannot replace full acceptance. Individual suites support targeted debugging; do not repeat `test:default` and `test:manual` after full verification passes.

CI installs the [pinned official Hugo release](https://github.com/gohugoio/hugo/releases/tag/v0.160.1) after checking its official checksums, then invokes `verify --allow-empty`. Local verification checks the installed version without downloading or upgrading it.

Offline tests use temporary directories and synthetic/redacted fixtures, mocking model, network, and publication calls. Never modify production analysis to manufacture success. Reader cases cover multiple errors, numeric/unit evidence, figure markers, malformed JSON, stale/unauthorized patches, corrupt candidates, recovery, and no progress. Publication cases cover protocol changes, page-byte changes, rejection before any LLM call, and real Hugo resource builds. Record input fingerprints, outcomes, and failed-call counts. Fixture success does not prove article quality or billed-token savings; those require a separately authorized isolated article experiment. Paid calls are outside `verify`.

Original-table selection supports only tables that can be rendered verbatim safely. Before paid generation, `TABLE_N_SELECTION` reports eligibility and reasons. Blank headers, every row marked as a header, or unresolved MathML/TeX duplication disable that table; runtime checks reject it again. Do not guess header roles or loosen numeric equivalence. `source_quotes` remains available only when contiguous original quotes pass all numeric/unit checks.

Page reviews are permanently reused by relative path and content SHA. Publisher changes still require rerendering; code, model, protocol, or Hugo changes require current batch checks and a new receipt. Only an actual page content SHA change triggers another page review. Deployment and live pages still require manual verification.

## Before Commit

- [ ] Commands match `package.json`.
- [ ] Chinese and English defaults agree.
- [ ] No stale paths or broken links.
- [ ] No duplicated Manual internals.
- [ ] No runtime data, logs, caches, or secrets.
- [ ] Unrelated user changes are preserved.
- [ ] The Chinese commit message explains reason, scope, and compatibility.
