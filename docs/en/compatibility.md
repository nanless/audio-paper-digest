# Contract and compatibility matrix

“Readable” does not mean “eligible for a new production publication.” Current writers emit only current contracts; compatibility readers preserve audit and explicit maintenance paths.

| Artifact | Current writer | Historical read | Default production |
|---|---|---|---|
| Filter decision | decision contract v3 | reusable only when input/model/prompt fingerprints match | must cover the complete raw-candidate set |
| Analysis manifest | manifest v1 plus current stage contracts | old stages may support explicit recovery or migration | must satisfy the terminal set for its API or Manual mode |
| Daily source run | `daily-fresh-source-run-v1` plus `daily-fresh-source-reference-v1` | old text/PDF cache is read-only and cannot become a sealed run | replays current batch, complete paper set, and every four-file PDF/TXT/runtime/manifest closure |
| API Reader | Reader v3 + source v4 + author/resource identity v1 | v1/v2 and v3 missing any current source contract are read-only | requires article, plan, Figure, author/affiliation, resource-state, and source hashes to close |
| Scoring audit | `api-scoring-audit-v2` plus stability resolution when triggered | older scores may be displayed | recomputes all eight dimensions and binds the final analysis |
| Generation manifest | schema v3 | v1/v2 only through explicit historical maintenance | requires `publishedPapers` and one homogeneous production proof |
| Researcher workbench | `researcher-workbench-v1` + `researcher-sidecars-v1` | pages without the contract remain readable but have no structured workbench/download eligibility | new Reader-v3/Manual-v6 pages bind front matter, four sidecars, and every file SHA |
| Review receipt | current review protocol | unchanged page hashes may reuse per-page passes | rebinds generation, Git baseline, protocol, and Hugo gate |
| Visual summary | v3 TOP 10 | v1/v2 require explicit migration | binds publication commit/OID and the current visual token |
| Manual canonical | production v6 | v5, shadow, and sealed preview are historical maintenance | default API cannot use Manual lineage as automatic-analysis proof |
| OpenCode Go account pool | `opencode-go-sticky-quota-failover-v1` | unknown versions fail closed | only explicit `GoUsageLimitError` changes active/cooldown; raw keys are never persisted |
| Historical direct catalog/plan | `merged-good-historical-local-data-v3` / `historical-direct-rewrite-plan-v2` | legacy crosswalk/fresh runs are fallback audit only | arXiv uses a freshly captured official PDF/TXT generation; conference replays bound local metadata/PDF SHA; old blog prose is excluded |
| Historical direct staging/aggregate | `historical-direct-*-v1` | private runtime artifacts remain auditable | private staging only; historical review, activation, commit/push receipt, and remote OID are unimplemented |

## Migration rules

1. Production writers never silently rewrite old schemas as current ones.
2. Compatibility readers never grant old artifacts current production eligibility.
3. Migration reopens source files and verifies realpath, byte length, and SHA-256.
4. Version, prompt, budget, or algorithm changes enter the narrowest relevant stage fingerprint.
5. Missing source identity or incomplete paper sets fail closed; a page that merely looks correct is not sufficient evidence.
