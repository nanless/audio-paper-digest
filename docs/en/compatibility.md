# Data and Publication Compatibility

A readable artifact is not automatically eligible for new analysis or publication. The table separates current formats, historical uses, and operational requirements. Default API, explicit Manual, and independent historical publication validate their own evidence.

| Artifact | Current format | Historical use | Current requirements |
|---|---|---|---|
| Filter decision | decision contract v3 | Reuse requires matching input, model, and prompt fingerprints. | Decisions cover the entire candidate set. |
| Analysis manifest | manifest v1 and current stage contracts | Older stages may support explicit recovery or migration. | Required terminal states match the chosen API or Manual mode. |
| Daily source run | `daily-fresh-source-run-v1`, `daily-fresh-source-reference-v1` | Old text/PDF caches remain readable but cannot become a new sealed run. | Validate the batch, complete paper set, and each paper's PDF, text, runtime record, and manifest. |
| API Reader | Reader v3, source v4, author/resource identity v1 | v1/v2 and v3 missing any current source requirement are historical-read only; structured-source compatibility is explained below. | Validate article, plan, figures, authors, affiliations, resources, and source hashes without rewriting sealed files. |
| Scoring audit | `api-scoring-audit-v2`, with stability resolution when triggered | Older scores may be displayed. | Recompute eight-dimensional totals and bind the final analysis. |
| Generation manifest | schema v3 | v1/v2 support explicit historical maintenance only. | New daily publication requires v3, rendered `publishedPapers`, and one publication mode with matching evidence. |
| Reading and downloads | `researcher-workbench-v1`, `researcher-sidecars-v1` | Older pages remain readable without structured-download eligibility. | New Reader-v3/Manual-v6 pages bind front matter, four sidecars, and every SHA. |
| Review receipt | current review protocol | Per-page passes persist by relative path and exact content SHA. | Run current batch gates and bind generation, Git baseline, protocol, and Hugo; unchanged pages are not re-reviewed. |
| Paper visual manifest | v3 TOP 10 | v1/v2 require explicit migration. | Bind publication commit, remote OID, and current token; ephemeral figures use identity checks and empty references without legacy-cache fallback. |
| Manual analysis | production v6 | v5, shadow, and sealed previews support historical maintenance. | Default API cannot use Manual lineage as automatic-analysis proof; continued tasks also require current instruction hashes. |
| OpenCode Go account pool | `opencode-go-sticky-quota-failover-v1` | Unknown versions cannot be overwritten. | Only explicit `GoUsageLimitError` 429 or `Insufficient balance` 401 updates cooldown and advances accounts; raw keys are never stored. |
| Historical catalog and plan | `merged-good-historical-local-data-v5`, `historical-direct-rewrite-plan-v5` | v4/v3 and legacy crosswalk/fresh runs support fallback audit only. | Preserve conflicting or multiple Daily primary-arXiv bindings, ICML poster authority, and the current PDF-routable subset; replay page, source, and subset hashes without old blog prose. |
| Historical staging, aggregates, and publication | `historical-direct-*-v1` | Private artifacts remain auditable; page passes persist by path and content SHA. | Complete results require independent review, locked activation/commit/push, and remote-OID verification; unmet plan requirements for conference aggregates, pages, or source validation block publication. |

## Specific Compatibility Limits

Reader structure and table/formula source versions govern different checks. Legacy structured evidence must pass source-manifest and full-text SHA verification. Earlier key-order hashes additionally require replay using the recorded `parserVersion`. The only exception is an implementation-recognized no-layout source marker with empty `tables`, `formulas`, and `figures` arrays. Arbitrary layout declarations or rewritten sealed files cannot establish eligibility.

Page passes are reused only by final relative path and content SHA. Model, code, protocol, generation, or Hugo changes require current batch checks and a new receipt, while unchanged page bytes retain their pass. A mismatched Git baseline or remote identity still blocks push.

Keeping old instruction copies inside a Manual packet does not make that packet valid for continued tasks. Consumers compare its authoring prompt and editorial contract with current repository `manual/prompts/manual-tutorial-article.md` and `manual/docs/editorial-reference-contract.md` hashes and reject a mismatch. Analysis specifications also check stage prompts and the analysis-record instructions. Displaying a historical result and continuing an old packet are distinct operations; these checks do not make every historical file unreadable.

An independent historical publisher exists, but a complete plan or staging directory does not establish a published batch. See [Historical rewriting](../history-rewrite.md) and [Historical publication](../history-direct-publication.md). Operator patches for an existing-batch rewrite have additional legacy-run restrictions described in [Rewriting from source](../fresh-rewrite.md). Do not insert missing hashes to bypass them.

## Migration Rules

1. Current writers emit current formats without silently rewriting older files to appear current.
2. Compatibility reads cannot grant old results new analysis or publication eligibility.
3. Migration reopens sources and verifies real paths, byte lengths, and SHA.
4. Version, prompt, budget, and algorithm changes enter the relevant stage fingerprint and invalidate only necessary stages and downstream work.
5. Stop when source identity or paper coverage cannot be verified; a plausible-looking page does not replace validation.
