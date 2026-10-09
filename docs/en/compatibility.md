# Data and Publication Compatibility

A file you can still read is not automatically usable for new analysis or publication. The table separates current formats from historical uses and from what a run needs today. Default API, explicit Manual, and independent historical publication each check their own evidence, and none of them may borrow another's proof.

| Artifact | Current format | Historical use | Current requirements |
|---|---|---|---|
| Filter decision | decision contract v3 | Reuse requires matching input, model, and prompt fingerprints. | Decisions cover the entire candidate set. |
| Analysis manifest | manifest v1 and current stage contracts | Older stages may still support an explicit recovery or migration. | Required terminal states match the chosen API or Manual mode. |
| Daily source run | `daily-fresh-source-run-v1`, `daily-fresh-source-reference-v1` | Old text/PDF caches stay readable, but they cannot be turned into a new captured run. | Validate the batch, the complete paper set, and each paper's PDF, text, runtime record, and manifest. |
| API Reader | Reader v3, source v4, author/resource identity v1 | v1/v2, and v3 missing any current source requirement, are historical-read only; structured-source compatibility is explained below. | Validate article, plan, figures, authors, affiliations, resources, and source hashes without rewriting saved files. |
| Scoring audit | `api-scoring-audit-v2`, with stability resolution when triggered | Older scores may still be displayed. | Recompute eight-dimensional totals and bind the final analysis. |
| Generation manifest | schema v3 | v1/v2 support explicit historical maintenance only. | New daily publication requires v3, rendered `publishedPapers`, and one publication mode with matching evidence. |
| Reading and downloads | `researcher-workbench-v1`, `researcher-sidecars-v1` | Pages without the current protocol stay readable, but they do not qualify for structured downloads. | New Reader-v3/Manual-v6 pages bind front matter, four sidecars, and every SHA. |
| Review receipt | current review protocol | Per-page passes persist by relative path and exact content SHA. | Run current batch gates and bind generation, Git baseline, protocol, and Hugo; unchanged pages are not re-reviewed. |
| Paper visual manifest | v3 TOP 10 | v1/v2 require an explicit migration command. | Bind publication commit, remote OID, and current token; ephemeral figures use identity checks and empty reference paths, with no fallback to old caches. |
| Manual analysis | production v6 | v5, `shadow`, and saved previews serve historical maintenance only. | Default API cannot use Manual lineage as automatic-analysis proof; continued tasks also require current instruction hashes. |
| OpenCode Go account pool | `opencode-go-sticky-quota-failover-v1` | Unknown versions cannot be overwritten. | Only an explicit `GoUsageLimitError` 429 or `Insufficient balance` 401 updates cooldown and advances accounts; raw keys are never stored. |
| Historical catalog and plan | `merged-good-historical-local-data-v5`, `historical-direct-rewrite-plan-v5` | v4/v3 and legacy crosswalk/fresh runs support fallback audit only. | Preserve conflicting or multiple Daily primary-arXiv bindings, ICML poster authority, and the current PDF-routable subset; recheck page, source, and subset hashes without old blog prose. |
| Historical staging, aggregates, and publication | `historical-direct-*-v1` | Private artifacts stay auditable, and page passes persist by path and content SHA. | Complete results require independent review, then locked activation, commit, push, and remote-OID verification; unmet plan requirements for conference aggregates, pages, or source validation block publication. |

## Specific Compatibility Limits

Reader article structure and table/formula source versions cover different checks, and neither version stands in for the other. Legacy structured evidence has to pass source-manifest and full-text SHA verification, and earlier key-order hashes also need a recheck against the recorded `parserVersion`. The one exception is an implementation-recognized no-layout source marker whose `tables`, `formulas`, and `figures` arrays are all empty. Arbitrary layout declarations do not qualify. Never rewrite saved files to produce new hashes.

Page passes are reused only by final relative path and content SHA. Model, code, protocol, generation, or Hugo changes require current batch checks and a new receipt, but unchanged page bytes stay out of model review. A mismatched Git baseline or remote identity still blocks push.

An old prompt or editorial-contract copy inside a Manual packet does not authorize continuing the current task. Consumers compare their hashes against the repository's current `manual/prompts/manual-tutorial-article.md` and `manual/docs/editorial-reference-contract.md`, and reject a mismatch. Analysis specifications also check the stage prompts and the analysis-record instructions. Displaying an older result and continuing an old packet are different operations. These checks do not make every historical file unreadable.

An independent historical publisher exists, but a complete plan or staging directory does not mean the full-history task was published. See [Historical rewriting](../history-rewrite.md) and [Historical publication](../history-direct-publication.md). Operator patches for an existing-batch rewrite have additional legacy-run restrictions described in [Rewriting from source](../fresh-rewrite.md). Do not insert missing hashes to bypass them.

The retired `sealed_tutorial_preview` remains available only for reading saved material. New page generation, review receipts, and push reject that mode. Its older loader checks only part of the saved evidence and cannot establish full article, source, or current publication eligibility.

## Migration Rules

1. Current writers emit current formats, and never rewrite older files so they look like the new version.
2. Reading an old file never grants it new analysis or publication eligibility.
3. Migration reopens sources and verifies real paths, byte lengths, and SHA.
4. Version, prompt, budget, and algorithm changes enter the relevant stage fingerprint and invalidate only the stages they affect, plus downstream work.
5. Stop when source identity or paper coverage cannot be verified. A page that looks fine still needs validation.
