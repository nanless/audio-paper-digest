# Maintenance Guide

## Audience and Method

For maintainers changing default API, shared publication, prompts, data contracts, or docs. Identify the owning layer, change one authority, then update consumers, tests, and documentation. Manual maintenance starts at [manual/README.md](../../manual/README.md).

## Change Routing

| Change | Authority | Consumers to inspect |
|---|---|---|
| Node settings/paths | `scripts/config.js` | entries, tests, env.example |
| Python publishing paths | `scripts/path_config.py` | generate/review/push |
| protocol/proxy | `utils.js`, `publish_common.py` | filter, analysis, review, key test |
| recovery | `analysis-engine.js`, `deep-analyzer.js` | all analysis entries, status |
| analysis/scoring | contract + prompts | Node/Python parsers, publisher |
| Reader quality | Reader prompt + editorial gate | validator, blog review |
| blog transaction | `publish-to-blog.py` | three wrappers, receipt tests |
| visual state | state modules | planner, status, record |
| command alias | `package.json` | all user/Agent docs |

## Invariants

- Default daily work remains LLM/API; errors never choose Manual.
- Project configuration comes only from root `.env`.
- Muse and arXiv require proxy; other LLM providers default to `agent:false`.
- Per-paper analysis and shared JSON updates lock and reread inside the lock.
- Fingerprints invalidate only required stages.
- Generate, review, and push remain separate; review is read-only.
- Production proof, page SHA, Git baseline, remote OID, and visual tasks bind layer by layer.
- Project scripts never call an image API.

## Prompt Changes

`loadPrompt()` reads the first fenced block. Verify placeholders, parser shape, fences, SHA/fingerprint ownership, retry feedback, and absence of template/meta prose.

Scoring changes must preserve dimension order/ranges, Open Source anchors, evidence IDs, and deterministic caps. Reader changes require samples for term bridges, table narrative, figure adjacency, and no-pixel description boundaries.

## Data Contracts

Classify new fields as authoritative facts, rebuildable cache, recovery state, publication receipt, or diagnostics. Structural changes require Node validators, Python publishers, fixtures, historical compatibility, and `validate:data` updates.

## Concurrency and Atomicity

Use atomic writes. Read-modify-write operations acquire shared locks, reread canonical inside the lock, merge only the owned paper/field, and increment generation. Long tasks use leases/heartbeats; only expired owners are recoverable.

## Security and Logs

Use HTTPS except loopback tests. Revalidate public destination IPs on redirects. Logs use millisecond Beijing timestamps, `0600` permissions, and redact authentication headers, cookies, tokens, configured keys, secrets, passwords, and URL userinfo. Never commit runtime state or credentials.

## Runtime storage

`npm run storage:status` is read-only. `npm run storage:prune` prints a reference-aware dry run; `npm run storage:prune -- --apply` targets only expired files inside fixed log/cache/debug allowlists and fails closed on invalid JSON, symlinks, path escapes, or changed candidates. Canonical JSON, publication/visual manifests, blog files, and archived final assets are never targets.

Apply is an offline maintenance operation. Run it only when acquisition, analysis, blog generation/review/push, and visual tasks are all stopped. Reference rescanning cannot replace a transaction lock shared by every writer, so concurrent creation of a new authoritative reference still has a post-scan race. During an active pipeline, use status or dry-run only.

## Verification

```bash
npm run verify
git diff --check
```

Run `verify` outside the sandbox. Full verification requires Hugo **0.160.1**, matching blog deployment, checks repository JS/Python/shell syntax, runs `npm test` once (both default and Manual JS suites), runs both Python suites, and performs read-only data validation. Any failure exits nonzero. The real Hugo resource pipeline fixture must build; missing Hugo is not a passing full verification. Traversal excludes vendor/runtime trees including `node_modules`, `.venv`, `data`, `logs`, and `.git`, and never follows symlinks. Python bytecode uses a private temporary directory.

Only CI or a clean checkout with no data explicitly uses `npm run verify -- --allow-empty`. Normal verification validates existing data. `npm run verify -- --quick` runs syntax and data checks only, omits all tests and Hugo, and is **not full acceptance**. Use individual suites for targeted debugging; do not repeat `test:default` and `test:manual` after the full runner.

CI installs the [pinned official Hugo release](https://github.com/gohugoio/hugo/releases/tag/v0.160.1), verifies its archive against that release's official checksums, then invokes the same `verify --allow-empty` entry. Local verification checks the installed tool without downloading or upgrading it.

Offline replay uses temporary directories and synthetic/redacted fixtures, with model, network, and publication calls injected as mocks. Never modify production canonical data to create a passing fixture. Reader cases cover multiple errors, numeric/unit evidence, figure markers, malformed JSON, stale/unauthorized patches, corrupt candidates, failure recovery, and lack of progress. Publication cases cover protocol drift, byte changes, zero-LLM deterministic rejection, and a real Hugo resource build. Record input fingerprints and observed outcomes; fixture success does not prove article quality or actual billed-token savings. A separately authorized isolated article experiment can complement these checks. Paid API calls are outside `verify`.

Original-table selection supports only tables that can be rendered verbatim safely. Before paid generation, `TABLE_N_SELECTION` reports eligibility and reasons. Blank source headers, every row marked as a header, and unresolved MathML/TeX duplication disable selection for that table; the renderer rejects it again. Do not guess header roles or loosen numeric equivalence. The existing `source_quotes` route remains available only when exact contiguous quotes pass all numeric/unit checks. This change introduces no new cross-runtime display normalization protocol.

## Before Commit

- [ ] commands match `package.json`
- [ ] Chinese and English defaults agree
- [ ] no stale paths or broken links
- [ ] no duplicated Manual internals
- [ ] no runtime data, logs, cache, or secrets
- [ ] unrelated user changes preserved
- [ ] Chinese commit message explains reason, scope, and compatibility
