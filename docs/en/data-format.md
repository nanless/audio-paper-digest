# Data, State, and Receipts

## Purpose

Use this page to determine which file is authoritative, when recovery is safe, and why file existence is not completion. Validators and publishers are authoritative for fields. Manual data is documented in [manual/README.md](../../manual/README.md).

## Data Classes

1. Persistent databases, such as `papers.json`.
2. Date-scoped batch state: raw, decisions, filtered, deep.
3. Transaction receipts: generation, review/publication, and visual manifests.

A `complete` value is valid only when its cross-file contract closes.

## Current Core Files

### `papers.json`

Persistent deduplication database; never moved with a batch. `digestStatus` tracks success, pending work, failure, and latest attempts. A later failure remains visible even when an older successful body is retained.

### `fetch-checkpoint.json`

Per-source health, candidate count, stable content SHA, and recovery metadata. Damage invalidates only that source, but any required-source gap blocks downstream completion.

### `raw-candidates.json`

The full normalized, merged, published-deduplicated filter input and denominator for decision coverage.

### `filter-decisions.json`

Per-normalized-ID decision, reason, raw response, parse source, input SHA, and configuration fingerprint. Model/prompt/protocol/keyword changes refilter healthy raw without refetching.

### `filtered-papers.json`

Must equal positive raw decisions minus explicit exclusions. Unknown, failed, or missing decisions cannot disappear silently.

### `deep-analysis-result.json`

Default API canonical analysis, parsed cache, source identity, stage checkpoints, scoring/Reader bindings, and production proof. Its paper set must exactly cover filtered.

## Analysis Source and Recovery

`analysisSource` binds source type, request ID, raw/full/used lengths, truncation, SHA, warnings, and confidence. A source-SHA change invalidates primary analysis and downstream work.

Failures retain manifests, general and per-stage checkpoints, recovery image state, and latest error. Fingerprints include input, model, protocol, prompt, temperature, budgets, and output SHA, enabling minimal stage recovery.

## Canonical and Reader View

The 13 Chinese canonical headings are parser anchors. `parsed` is a cache and must match reparsing.

Default API publication binds the Reader v3 article and plan, `api-reader-source-bindings-v4` table/formula evidence, materialized official Figures, `api-reader-author-identity-v1` author/affiliation provenance, `api-reader-resource-identity-v1` project/demo availability evidence, scoring stability, and the exact `llm_api_production` paper set. Reader v1/v2 and v3 records without current source identities are historical read compatibility only. Abstract fallback is publication-blocking by default.

## Generation Manifest

Schema v3 binds date, category, blog base HEAD, exact non-empty page set, create/update/delete state, per-page SHA, input/template fingerprints, rendered `publishedPapers`, homogeneous publication mode, production proof, and visual capability.

Mixed API/Manual provenance, missing bindings, or old schema cannot establish a new production publication.

## Review Receipt and Publication

The receipt binds generation SHA, actual page SHAs, per-page review protocol, Git baseline, Hugo gate, and production proof. Successful push adds publication commit, matching remote-verified OID, remote identity, and Beijing verification time.

Remote branch, remote name, or push-URL identity drift invalidates reuse.

## Visual Manifests

Paper and cover manifests bind verified publication, task tokens, generation context, QA claims, canonical asset path, and SHA. Completion requires matching publication, task token, valid bytes, and `qaAttested=true`.

A waiver is a separate state bound to publication and both manifest SHAs; any change invalidates it.

## Archive

`data/archive/<date>/` stores batch snapshots and final visuals. Historical status may use it only when raw/decision/filtered/deep date and set contracts close. Current-date status never hides current failure with archive data.

## Read-Only Validation

```bash
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

`--allow-empty` is only for a clean checkout. Status is a read-time snapshot and must be regenerated after mutations.
