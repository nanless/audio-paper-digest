# Contract and compatibility matrix

“Readable” does not mean “eligible for a new production publication.” Current writers emit only current contracts; compatibility readers preserve audit and explicit maintenance paths.

| Artifact | Current writer | Historical read | Default production |
|---|---|---|---|
| Filter decision | decision contract v3 | reusable only when input/model/prompt fingerprints match | must cover the complete raw-candidate set |
| Analysis manifest | manifest v1 plus current stage contracts | old stages may support explicit recovery or migration | must satisfy the terminal set for its API or Manual mode |
| API Reader | Reader v3 + source v4 + author/resource identity v1 | v1/v2 and v3 missing any current source contract are read-only | requires article, plan, Figure, author/affiliation, resource-state, and source hashes to close |
| Scoring audit | `api-scoring-audit-v2` plus stability resolution when triggered | older scores may be displayed | recomputes all eight dimensions and binds the final analysis |
| Generation manifest | schema v3 | v1/v2 only through explicit historical maintenance | requires `publishedPapers` and one homogeneous production proof |
| Review receipt | current review protocol | unchanged page hashes may reuse per-page passes | rebinds generation, Git baseline, protocol, and Hugo gate |
| Visual summary | v3 TOP 10 | v1/v2 require explicit migration | binds publication commit/OID and the current visual token |
| Manual canonical | production v6 | v5, shadow, and sealed preview are historical maintenance | default API cannot use Manual lineage as automatic-analysis proof |

## Migration rules

1. Production writers never silently rewrite old schemas as current ones.
2. Compatibility readers never grant old artifacts current production eligibility.
3. Migration reopens source files and verifies realpath, byte length, and SHA-256.
4. Version, prompt, budget, or algorithm changes enter the narrowest relevant stage fingerprint.
5. Missing source identity or incomplete paper sets fail closed; a page that merely looks correct is not sufficient evidence.
