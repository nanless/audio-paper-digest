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

## Verification

```bash
npm test
npm run test:default
npm run test:manual
npm run validate:data -- --allow-empty
git diff --check
```

CI also checks JS/Python syntax, both Python suites, and all shell scripts. Add controlled artifact tests for prompt/publication changes and test Muse plus ordinary direct providers for proxy changes.

## Before Commit

- [ ] commands match `package.json`
- [ ] Chinese and English defaults agree
- [ ] no stale paths or broken links
- [ ] no duplicated Manual internals
- [ ] no runtime data, logs, cache, or secrets
- [ ] unrelated user changes preserved
- [ ] Chinese commit message explains reason, scope, and compatibility
