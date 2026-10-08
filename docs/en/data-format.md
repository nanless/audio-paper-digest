# Data, State, and Publication Records

## Purpose

What each file contains, which records must agree, and when recovery is safe. The validators define the exact field checks. The [Manual entry](../../manual/README.md) covers the separate manual workflow.

## Data Classes

| Class | Contents |
|---|---|
| Persistent database | `papers.json` stores papers and deduplication state across runs; it never moves with a date batch. |
| Date batch | Candidates, decisions, selected papers, and analysis in the current or date archive directory. |
| Publication and visuals | Generation manifests, review receipts, publication commits, visual tasks, and asset records. |
| Cross-batch request state | `data/runtime/llm-account-pool.json` keeps the active account and quota cooldowns outside batch rotation. |

A file that exists, or that declares itself `complete`, may still be unfinished. Its inputs, sources, and related records must pass the relevant checks. SHA values tell you the bytes are unchanged; they do not establish factual correctness and are not a reviewer's digital signature.

A source `generation` identifies a capture. Account-pool and mutable-data generations count updates, and a blog generation manifest records rendered output. None of these numbers is an arXiv `vN` revision.

## OpenCode Go Account-Pool State

`data/runtime/llm-account-pool.json` uses `opencode-go-sticky-quota-failover-v1`. It stores hashed service and account identities, the active account, normalized quota windows, `blockedUntil`, and an update counter. This file never stores raw keys, authorization headers, or request and response bodies. Stable credential fingerprints are still sensitive: keep permissions at `0600` and do not upload or archive the file. Replacing a key creates a new credential identity, which stays out of filtering, analysis, and publication-content fingerprints.

Node and Python share the same directory-lock and atomic-write protocol. The lock covers selection and state updates; HTTP requests run outside it. An unknown schema, corrupt JSON, or a symlink state path stops execution. Only HTTP 429 `GoUsageLimitError` or HTTP 401 `Insufficient balance` triggers forward failover and a cooldown record. Other authentication 401 responses stop the run, and generic 429, 5xx, transport, and content failures leave the account alone. When a cooldown expires, the run does not move traffic back by itself.

## Current Core Files

### `papers.json`

The persistent deduplication database. A paper's `digestStatus` tracks success, pending work, failure, and the latest attempt. An older successful body may stay in place, but a later failure must still show up in `latestAttemptStatus`.

### `fetch-checkpoint.json`

Per-arXiv-category and HuggingFace source state, candidate counts, content hashes, and recovery metadata. Damage invalidates that one source, and a gap in any required source blocks downstream completion.

### `raw-candidates.json`

The complete normalized, merged filter input, after already published papers are removed. Decision coverage is measured against this set, not just the papers that got a successful API response.

### `filter-decisions.json`

Decisions keyed by normalized paper ID, including model or keyword decisions, reasons, raw responses, parsing method, input SHA, and configuration fingerprint. Change the model, prompt, protocol, or keyword rules and you must refilter. Healthy candidates are not fetched again.

### `filtered-papers.json`

The selected set must equal candidate decisions with `related=true`, minus explicit `excludedRelatedIds`. Unknown, failed, and missing decisions must not vanish silently.

### `deep-analysis-result.json`

The default API analysis contains metadata, `analysis`, `parsed`, source identity, stage checkpoints, `analysisManifest`, scores, and Reader publication evidence. Its paper set must exactly cover the selected set, with every required stage in its accepted terminal state.

A declared `dailyFreshSourceRun` must use `daily-fresh-source-reference-v1` and bind `batchDate`, the complete paper set, run-manifest SHA, and source-set SHA. Each paper's `freshRewriteProvenance` and `analysisManifest.freshRewriteProvenance` must agree and re-read the captured source files. Missing or extra files, source or set drift, and legacy provenance are not enough for default API publication eligibility.

## Daily Saved Sources

A `daily-fresh-source-run-v1` run lives at `data/runtime/daily-fresh-source-runs/<runId>/`. Each `sources/<arxivId>/generation-000001/` contains exactly four private files:

| File | Contents |
|---|---|
| `source.txt` | Official full text captured for this run. |
| `source.pdf` | The captured official PDF bytes. |
| `source-runtime.json` | Structured evidence, authors, figure URLs, and text bindings without image pixels. |
| `source-manifest.json` | Source identities, official URLs, extractor, byte lengths, and hashes for rechecking. |

These files are retained evidence, not date-rotated caches, so image bytes, base64, cache paths, and temporary filenames are all prohibited. The run reference, capture number, manifest, and snapshot hashes must agree. Adding a hash to an old result does not make it eligible.

Capture may try official historical versions of the same paper only after the current unversioned official PDF has returned HTTP 404. The optional `source-runtime.json.sourceVersion` uses `arxiv-historical-version-source-v1` and records `selectedSourceId`, the selected PDF URL, current-PDF 404 evidence, the fixed warning, and identity SHA. Text must come from that selected PDF. A normal current PDF cannot carry historical-version evidence. Node and Python validate these conditions as well as the file hashes.

The paper's `sourceVersion` must match the saved runtime record, and both provenance records must carry its `sourceVersionIdentitySha256`. Older historical-version results without this binding need new analysis. Normal sources keep their existing snapshot fields, order, and hash calculation. Carrying a title or version description leaves all of that unchanged.

## Analysis Source and Recovery

`analysisSource` records source type, request ID, raw, full, and used lengths, truncation, SHA, warnings, and confidence. Default API records must agree with the saved source described above. A source-SHA change invalidates primary analysis and the downstream work that depends on it.

Failures retain `analysisManifest`, `analysisCheckpoint`, `analysisStageCheckpoints`, `analysisRecoveryImageManifest`, and the latest error and failure state. Stage fingerprints bind input, model, protocol, prompt, temperature, budgets, and output SHA. Recovery starts at the first incomplete or invalidated stage.

Failed Reader candidates are recovery inputs, not proof of successful analysis or publication. New table-count diagnostics use `code=reader_table_count_insufficient`, `requiredCount`, and `actualCount`. Counts must be safe integers satisfying `requiredCount >= 1` and `0 <= actualCount < requiredCount`. A coded issue whose counts are missing or invalid cannot recover them from its message. Records marked `diagnosticOnly: true` are informational and trigger no repairs. A bounded compatibility reader still handles older saved messages, but new prose must not drive repair actions. General draft hashing and existing recovery identities are unchanged.

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

Reader v3 governs article structure; `api-reader-source-bindings-v4` governs table and formula sources. They serve different checks and need not share a version number. New publication also requires author and resource identity v1. Reader v1/v2, and v3 missing any current source requirement, are for historical reading only. Abstract-only analysis is blocked by default.

Modern daily images exist only during the call, so a pixel hash in `apiReaderFigures` does not point to a reusable cache file. Legacy structured evidence must pass source-manifest and full-text SHA checks. Rechecking earlier key-order hashes also needs a recorded parser version, or an implementation-recognized no-layout source whose table, formula, and figure arrays are empty. Arbitrary layout declarations are not enough. Never rewrite saved files to manufacture hashes.

## Blog Generation Manifest

Schema v3 binds date, `category`, blog baseline `HEAD`, the exact non-empty page and controlled-sidecar set, per-file SHA, create/update/delete state, input and template fingerprints, rendered `publishedPapers`, a homogeneous `publicationMode` and its proof, and visual capability.

The default API mode uses `llm_api_production`; explicit Manual publication has its own proof. Mixed lineage, missing bindings, or old schemas cannot establish a new daily publication.

New Reader-v3 and Manual-v6 pages carry `researcher-workbench-v1` front matter: reader and original titles, normalized arXiv ID, a `vN` supplied explicitly or verified from saved source evidence, matching abs/PDF URLs, primary task, numeric score, rank bucket, document type, one-sentence thesis, structured authors, and original-abstract SHA. The abstract itself lives in same-batch `static/data/papers/<date>/<safe-arxiv-id>/rethink-context.json`.

Each paper has four same-origin files: `citation.json`, `citation.bib`, `citation.ris`, and `rethink-context.json`. Before staging, paths, UTF-8/LF bytes, JSON/TeX/RIS escaping, and the 256-KiB limit are checked. Front matter, generation manifest, and review receipt bind every SHA. Review rebuilds the files from `publishedPapers` and compares exact bytes; push allows only the receipt's precise delta.

New `rethink-context.json` files use `paper-research-context-v2` with `schemaVersion=2` and store tags in `assessment.tagMetadata`. Their `paper_digest_sidecars` entry includes the contract, URL and SHA. Older `researcher-sidecars-v1` files use `schemaVersion=1` and `assessment.taxonomy`; their page entries have no new contract marker. Readers rebuild the original format without rewriting saved files. Contract and version must match, and old and new tag fields cannot coexist, even with equal or null values. The three citation files keep their original formats.

Historical-version citations use the verified `sourceVersion.selectedSourceId`. Without an explicit or source-verified version, store `version: null` and unversioned abs/PDF URLs; never guess v1.

New papers write 3–5 active preferred labels from the tag catalog to Hugo `tags`, together with `paper-tag-flat-tags-v2`, selection contract, registry version and SHA, ordered `{id, facet, label}`, and explicit primary task and method. Chinese preferred labels are required, with the fixed `CNN/RNN/SFT/CTC/LoRA/Adapter/Transformer/Conformer` names retained and accompanied by Chinese aliases in the registry. The exception covers only those eight names, not arbitrary English labels. `rethink-context.json.assessment.tagMetadata` carries the same tag information. Older pages keep their original `paper-taxonomy-flat-tags-compat-v1` records. Both versions follow the same tag rules. Digest "popular directions" count primary tasks alone.

## Review and Remote Publication

A receipt binds generation SHA, actual page SHAs, the current review protocol, Git baseline, Hugo gate and the runtime fingerprint of configuration, layouts, data, and frontend code, plus production evidence. Separate per-page passes persist only by relative path and exact content SHA.

Publisher-code changes still rerender output so real byte changes show up. Template, site-script, model, code, protocol, or manifest-metadata changes require current batch gates and a new receipt. Unchanged page bytes reuse their pass. Only changed pages need another review.

A successful push adds `publicationCommit`, matching `remoteVerifiedOid`, remote identity, and Beijing `remoteVerifiedAt`. Drift in the remote OID, name, or push-URL identity blocks direct reuse. Git verification proves only that the blog commit reached the remote. Live publication also requires a successful GitHub Pages build and deployment, plus each page's HTTP 200, formal URL, and title, with the results kept.

## Visual Manifests

`visual-summary-manifests/<date>.json` records TOP 10 ranking, paper task tokens, reference identities, generation context, QA claims, and asset hashes. `digest-cover-manifests/<date>.json` records the batch title, popular directions, ranking, and cover asset.

Modern daily tasks with `ephemeral-no-persisted-figure-assets-v1` validate official figure identity and use empty reference paths. Only legacy compatibility tasks validate persistent caches. Completion requires the current publication commit and remote OID, task token, the archive path, correct asset SHA, dimensions and format, and `qaAttested=true`.

A user-requested visual `waiver` is separate, bound to publication and both manifest SHAs, and invalidated by changes. It replaces the visual requirement alone, not data, review, remote, or live-site checks.

## Archive

`data/archive/<date>/` stores batch snapshots and final visuals. Historical status may use it only when candidate, decision, selected, and analysis dates and sets agree. Current-date status never hides current failures behind archive data.

## Read-Only Validation

```bash
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

`validate:data --allow-empty` is only for a clean checkout explicitly without runtime data. Status is a read-time snapshot. Rerun it after publication, image recording, or a waiver.
