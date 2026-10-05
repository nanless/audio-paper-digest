# Data, State, and Publication Records

## Purpose

This page explains what each file contains, which records must agree, and when recovery is safe. The validators define the exact field checks. See the [Manual entry](../../manual/README.md) for the separate manual workflow.

## Data Classes

| Class | Contents |
|---|---|
| Persistent database | `papers.json` stores papers and deduplication state across runs; it is never moved with a date batch. |
| Date batch | Candidates, decisions, selected papers, and analysis in the current or date archive directory. |
| Publication and visuals | Generation manifests, review receipts, publication commits, visual tasks, and asset records. |
| Cross-batch request state | `data/runtime/llm-account-pool.json` retains the active account and quota cooldowns outside batch rotation. |

A file's existence or a self-declared `complete` value does not establish completion. Its inputs, sources, and related records must pass the relevant checks. SHA values establish content identity, not factual correctness or a reviewer's digital signature.

A source `generation` identifies a capture; account-pool and mutable-data generations count updates; a blog generation manifest records rendered output. None of these numbers is an arXiv `vN` revision.

## OpenCode Go Account-Pool State

`data/runtime/llm-account-pool.json` uses `opencode-go-sticky-quota-failover-v1`. It stores hashed service and account identities, the active account, normalized quota windows, `blockedUntil`, and an update counter. It never stores keys, authorization headers, or request and response bodies. Stable credential fingerprints remain sensitive: keep permissions at `0600` and do not upload or archive the file. Replacing a key creates a new credential identity, which does not enter filtering, analysis, or publication-content fingerprints.

Node and Python share the directory-lock and atomic-write protocol. The lock covers selection and state updates; HTTP requests run outside it. Unknown schemas, corrupt JSON, and symlink state paths stop execution. Only HTTP 429 `GoUsageLimitError` or HTTP 401 `Insufficient balance` triggers forward failover and cooldown records. Other authentication 401 responses stop the run; generic 429, 5xx, transport, and content failures do not switch accounts. Cooldown expiry never automatically displaces the current successful account.

## Current Core Files

### `papers.json`

The persistent deduplication database. A paper's `digestStatus` can track success, pending work, failure, and the latest attempt. An older successful body may remain, but a later failure must still appear in `latestAttemptStatus`.

### `fetch-checkpoint.json`

Per-arXiv-category and HuggingFace source state, candidate counts, content hashes, and recovery metadata. Damage invalidates that source alone, while any required-source gap blocks downstream completion.

### `raw-candidates.json`

The complete normalized, merged filter input after removing already published papers. Decision coverage is measured against this set, not just papers with successful API responses.

### `filter-decisions.json`

Decisions keyed by normalized paper ID, including model or keyword decisions, reasons, raw responses, parsing method, input SHA, and configuration fingerprint. Changes to model, prompt, protocol, or keyword rules require refiltering without refetching healthy candidates.

### `filtered-papers.json`

The selected set must equal candidate decisions with `related=true`, minus explicit `excludedRelatedIds`. Unknown, failed, and missing decisions cannot disappear silently.

### `deep-analysis-result.json`

The default API analysis contains metadata, `analysis`, `parsed`, source identity, stage checkpoints, `analysisManifest`, scores, and Reader publication evidence. Its paper set must exactly cover the selected set, with every required stage in its accepted terminal state.

A declared `dailyFreshSourceRun` must use `daily-fresh-source-reference-v1` and bind `batchDate`, the complete paper set, run-manifest SHA, and source-set SHA. Each paper's `freshRewriteProvenance` and `analysisManifest.freshRewriteProvenance` must agree and replay the captured source files. Missing or extra files, source or set drift, and legacy provenance cannot establish default API publication eligibility.

## Daily Sealed Sources

A `daily-fresh-source-run-v1` run lives at `data/runtime/daily-fresh-source-runs/<runId>/`. Each `sources/<arxivId>/generation-000001/` contains exactly four private files:

| File | Contents |
|---|---|
| `source.txt` | Official full text captured for this run. |
| `source.pdf` | The captured official PDF bytes. |
| `source-runtime.json` | Structured evidence, authors, figure URLs, and text bindings without image pixels. |
| `source-manifest.json` | Source identities, official URLs, extractor, byte lengths, and hashes for replay. |

These files are retained evidence, not date-rotated caches. Image bytes, base64, cache paths, and temporary filenames are prohibited. The run reference, capture number, manifest, and snapshot hashes must agree; adding a hash to an old result cannot make it eligible.

Only after the current unversioned official PDF has returned HTTP 404 may capture try official historical versions of the same paper. The optional `source-runtime.json.sourceVersion` uses `arxiv-historical-version-source-v1` and records `selectedSourceId`, the selected PDF URL, current-PDF 404 evidence, the fixed warning, and identity SHA. Text must come from that selected PDF. A normal current PDF cannot carry historical-version evidence. Node and Python validate these conditions as well as file hashes.

The paper's `sourceVersion` must match the sealed runtime record, and both provenance records must carry its `sourceVersionIdentitySha256`. Older historical-version results without this binding require new analysis. Normal sources retain their existing snapshot fields, order, and hash calculation; carrying a title or version description does not change them.

## Analysis Source and Recovery

`analysisSource` records source type, request ID, raw, full, and used lengths, truncation, SHA, warnings, and confidence. Default API records must agree with the sealed source above. A source-SHA change invalidates primary analysis and necessary downstream work.

Failures retain `analysisManifest`, `analysisCheckpoint`, `analysisStageCheckpoints`, `analysisRecoveryImageManifest`, and the latest error and failure state. Stage fingerprints bind input, model, protocol, prompt, temperature, budgets, and output SHA. Recovery starts at the first incomplete or invalidated stage.

Failed Reader candidates are recovery inputs, not successful analysis or publication proof. New table-count diagnostics use `code=reader_table_count_insufficient`, `requiredCount`, and `actualCount`. Counts must be safe integers satisfying `requiredCount >= 1` and `0 <= actualCount < requiredCount`. A coded issue with missing or invalid counts cannot recover them from its message. Records marked `diagnosticOnly: true` are informational and do not trigger repairs. Older saved messages have a bounded compatibility reader; new prose must not control repair actions. General draft hashing and existing recovery identities remain unchanged.

## Analysis and Published Reader

The 13 Chinese top-level headings in `analysis` are parser anchors. `parsed` is a cache: publication reparses the article and compares fields rather than treating the cache as a separate factual source.

| Field or record | Purpose |
|---|---|
| `apiReaderArticle` | The published long-form article. |
| `apiReaderPlan` | Sections, concept explanations, figure placement, and table and formula evidence. |
| `apiReaderFigures` | Identities of actual image inputs, including source, DOM and pixel SHA, and display URL. |
| `apiReaderAuthors` | `api-reader-author-identity-v1` author and affiliation provenance. |
| `apiReaderResources` | `api-reader-resource-identity-v1` source or Demo evidence, redirect destination, and availability. |
| Scoring evidence and stability resolution | Evidence for the eight scores and final analysis used in scoring. |
| `llm_api_production` | Eligibility of the exact default API paper set. |

Reader v3 governs article structure; `api-reader-source-bindings-v4` governs table and formula sources. They serve different checks and need not share a version number. New publication also requires author and resource identity v1. Reader v1/v2 and v3 missing any current source requirement are historical-read compatibility only. Abstract-only analysis is blocked by default.

Modern daily images exist only during the call. A pixel hash in `apiReaderFigures` does not imply a reusable cache file. Legacy structured evidence must pass source-manifest and full-text SHA checks. Replaying earlier key-order hashes additionally requires a recorded parser version or an implementation-recognized no-layout source with empty table, formula, and figure arrays. Arbitrary layout declarations are insufficient; sealed files must not be rewritten to manufacture hashes.

## Blog Generation Manifest

Schema v3 binds date, `category`, blog baseline `HEAD`, the exact non-empty page and controlled-sidecar set, per-file SHA, create/update/delete state, input and template fingerprints, rendered `publishedPapers`, a homogeneous `publicationMode` and its proof, and visual capability.

The default API mode uses `llm_api_production`; explicit Manual publication has separate proof. Mixed lineage, missing bindings, or old schemas cannot establish a new daily publication.

New Reader-v3 and Manual-v6 pages carry `researcher-workbench-v1` front matter: reader and original titles, normalized arXiv ID, a `vN` supplied explicitly or verified from sealed source evidence, matching abs/PDF URLs, primary task, numeric score, rank bucket, document type, one-sentence thesis, structured authors, and original-abstract SHA. The abstract itself lives in same-batch `static/data/papers/<date>/<safe-arxiv-id>/rethink-context.json`.

Each paper has four same-origin files: `citation.json`, `citation.bib`, `citation.ris`, and `rethink-context.json`. Before staging, paths, UTF-8/LF bytes, JSON/TeX/RIS escaping, and the 256-KiB limit are checked. Front matter, generation manifest, and review receipt bind every SHA. Review rebuilds the files from `publishedPapers` and compares exact bytes; push allows only the receipt's precise delta.

New `rethink-context.json` files use `paper-research-context-v2` with `schemaVersion=2` and store tags in `assessment.tagMetadata`. Their `paper_digest_sidecars` entry includes the contract, URL and SHA. Older `researcher-sidecars-v1` files use `schemaVersion=1` and `assessment.taxonomy`; their page entries have no new contract marker. Readers rebuild the original format without rewriting saved files. Contract and version must match, and old and new tag fields cannot coexist, even with equal or null values. The three citation files retain their original formats.

Historical-version citations use the verified `sourceVersion.selectedSourceId`. Without an explicit or source-verified version, store `version: null` and unversioned abs/PDF URLs; never guess v1.

New papers write 3–5 active preferred labels from the tag catalog to Hugo `tags`, together with `paper-tag-flat-tags-v2`, selection contract, registry version and SHA, ordered `{id, facet, label}`, and explicit primary task and method. Chinese preferred labels are required, with the fixed `CNN/RNN/SFT/CTC/LoRA/Adapter/Transformer/Conformer` names retained and accompanied by Chinese aliases in the registry. This exception does not permit arbitrary English labels. `rethink-context.json.assessment.tagMetadata` carries the same tag information. Older pages retain their original `paper-taxonomy-flat-tags-compat-v1` records. Both versions use the same tag rules. Digest “popular directions” count primary tasks alone.

## Review and Remote Publication

A receipt binds generation SHA, actual page SHAs, the current review protocol, Git baseline, Hugo gate and the runtime fingerprint of configuration, layouts, data, and frontend code, plus production evidence. Separate per-page passes persist only by relative path and exact content SHA.

Publisher-code changes still rerender output to expose actual byte changes. Template, site-script, model, code, protocol, or manifest-metadata changes require current batch gates and a new receipt. Unchanged page bytes reuse their pass; only changed pages require another review.

Successful push adds `publicationCommit`, matching `remoteVerifiedOid`, remote identity, and Beijing `remoteVerifiedAt`. Remote OID, name, or push-URL identity drift blocks direct reuse. Git verification proves only that the blog commit reached the remote. Live publication also requires successful GitHub Pages build and deployment and each page's HTTP 200, formal URL, and title, with results retained.

## Visual Manifests

`visual-summary-manifests/<date>.json` records TOP 10 ranking, paper task tokens, reference identities, generation context, QA claims, and asset hashes. `digest-cover-manifests/<date>.json` records the batch title, popular directions, ranking, and cover asset.

Modern daily tasks with `ephemeral-no-persisted-figure-assets-v1` validate official figure identity and use empty reference paths. Only legacy compatibility tasks validate persistent caches. Completion requires the current publication commit and remote OID, task token, canonical archive path, correct asset SHA, dimensions and format, and `qaAttested=true`.

A user-requested visual `waiver` is separate, bound to publication and both manifest SHAs, and invalidated by changes. It replaces the visual requirement alone, not data, review, remote, or live-site checks.

## Archive

`data/archive/<date>/` stores batch snapshots and final visuals. Historical status may use it only when candidate, decision, selected, and analysis dates and sets agree. Current-date status never hides current failures with archive data.

## Read-Only Validation

```bash
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

`validate:data --allow-empty` is only for a clean checkout explicitly without runtime data. Status is a read-time snapshot; rerun it after publication, image recording, or a waiver.
