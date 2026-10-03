# Default LLM/API Workflow

## Audience and Completion Goal

Use this guide to run or recover a dated digest. First follow [Setup](setup.md) and confirm that the workspace role is `daily`, then run:

```bash
npm run digest:prepare -- YYYY-MM-DD
```

`digest:api` is an exact alias. A complete task includes candidate and analysis data, blog publication, live-site checks, and the paper infographics and cover. An analysis file or a successful script exit is not enough. Use the [Manual subsystem](../../manual/README.md) only when explicitly requested; model, network, or quota failures never switch to it automatically.

## Sequence

```text
check date and archive → proxy-backed fetch → remove published papers
                      → keyword prefilter → model filtering
                      → save official text/PDF → analyze and score → write Reader articles
                      → generate blog → review → push and verify remote commit
                      → generate and record visuals → verify site and final status
```

## 1. Date and Archive

A run starting with fetch must target the current date in Beijing. `autoArchiveCurrentData()` moves the previous batch's candidates, decisions, selected papers, and analysis to `data/archive/<date>/`. The cross-run deduplication database, `papers.json`, never moves.

Historical daily batches resume from existing data at an allowed stage. Do not fetch today's papers and present them as an earlier batch. For example:

```bash
./run-daily-digest.sh YYYY-MM-DD --from generate
```

The default API route can resume from `generate`, `review`, `push`, or `visual`. Manual stages `tasks`, `spec`, and `analyze` do not apply to it. The orchestrator's argument checks determine the allowed stages.

## 2. Fetch

arXiv and HuggingFace requests use the project proxy. Each source has its own checkpoint with acquisition status, candidate count, and content SHA. Only a damaged source is fetched again. An incomplete required source prevents the filter result from being marked complete.

Candidates are merged by normalized arXiv ID, deduplicated against published blog papers, and saved in `raw-candidates.json`.

## 3. Keyword and LLM Filtering

The keyword layer aims to retain potentially relevant papers; the model makes the final relevance decision:

- Papers in core categories `eess.AS` and `cs.SD` always reach the model.
- Abstracts under 80 characters cannot be rejected solely by keywords.
- Matches for audio, speech, music, acoustics, multimodal speech, and common models or datasets reach the model.
- Only complete, clearly unmatched abstracts in supplementary categories can be rejected by keyword rules.

Decisions are saved per paper in `filter-decisions.json`. Muse uses the configured filter batch size. The current account switches to a later account only for explicit `GoUsageLimitError` or `Insufficient balance` responses; generic 429 responses follow rate-limit backoff. Filtering is complete only when decisions cover every candidate and `filtered-papers.json` exactly matches relevant decisions minus explicit exclusions.

## 4. Full Text and Staged Analysis

After filtering, the system freshly fetches official HTML text and PDF for every selected arXiv ID. It atomically saves `source.txt`, `source.pdf`, `source-runtime.json`, and `source-manifest.json` under `data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/`.

HTML preference and PDF fallback occur during this source capture. Analysis, Reader generation, and blog generation/review/push use and verify that saved source set, never a legacy `data/current` text, PDF, or image cache. Source records include original and actual input lengths, SHA, truncation, and warnings. Abstract-only analysis is not publishable by default. Figure images exist in the system temporary directory only for the current model request and are not saved to runtime image caches.

Each paper follows these stages. Input, model, protocol, prompt, temperature, budget, and output fingerprints determine where it can resume:

1. Primary analysis.
2. Find code, open resources, and demo evidence.
3. Check and revise factual claims.
4. Repair tables, method details, and structure.
5. Validate and save tags and the core summary.
6. Determine document type, then audit eight score dimensions.
7. Generate the Reader-v3 article and verify source references for tables, formulas, authors, affiliations, and resources.
8. Prepare official figures and check their placement and explanations.

The canonical analysis has 13 fixed headings for parsing. The Reader article uses original source evidence and the figures actually supplied to the model. It explains combined terms, training or computation, datasets, metrics, results, counterevidence, reproduction, and limits. Tables and figures belong beside the argument they support.

Each completed paper is merged into the latest `deep-analysis-result.json` under its paper lock, and `papers.json.digestStatus` is updated. Saved successes remain available after interruption. A latest failure still requires retry even if an older successful article has been retained.

## 5. Scoring and Production Proof

Scoring selects the document type and evaluates eight dimensions against paper evidence. Code recomputes the total, applies evidence-based caps, and records audit, input, and output SHA values.

The default batch obtains its `llm_api_production` publication record only after article, author, figure, score, source-identity, and exact paper-set checks pass. A default API batch must not contain provenance or proofs reserved for Manual analysis.

## 6. Blog Transaction

Run these stages in order:

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

Generate reparses scores and article content from canonical data. Reader-v3 and Manual-v6 pages also receive `researcher-workbench-v1` front matter and four same-origin files: Citation JSON, BibTeX, RIS, and `rethink-context.json`. Pages and accompanying files are installed together, with content checksums and a schema-v3 generation manifest.

Citations and pages use the verified source version. A base arXiv ID is never guessed to mean `v1`. If the current PDF returned 404 and an official historical version of the same paper was used, the sealed `sourceVersion.selectedSourceId` supplies the actual version and the page retains the current-unavailable warning.

Review checks the digest first and paper pages concurrently, using programmatic checks, LLM review, image review, and Hugo builds. It never changes pages; content corrections return to generation or analysis. Per-page passes are permanently keyed by relative path and exact page-content SHA. Only changed content requires that file to be reviewed again. Hugo and other current-batch checks still run.

A publisher-code change makes generation rerender so actual content changes can be detected. Generation metadata, model, code, review-protocol, or Hugo-runtime changes require batch checks and a new current receipt, but do not re-review files whose final bytes are unchanged. A changed Git baseline or remote identity still blocks push.

Push commits only the exact file changes authorized by review and verifies remote `main`. Generation records the actual input's absolute path, size, and SHA-256, whether it came from current data, a dated archive, or `--data-file`. Review and push verify that same input instead of switching to a later current file.

Digest indexes use `reader-facing-v3`: ranking entries and both Chinese and English titles link to standalone blog pages. Tags and eight-dimensional scores appear once, followed by rank bucket, document type, arXiv source, and affiliations. The old duplicated score/confidence/tag/arXiv footer must not return. Reader-visible bare HTTPS URLs become clickable Markdown autolinks without altering existing links, images, code blocks, or front matter.

Remote verification establishes only that the commit was pushed. Before reporting the site as live, confirm successful GitHub Pages build and deployment for that commit. A later deployment commit is acceptable only after verifying that it retains this batch's reviewed page content. Check the dated digest and every published paper page for HTTP 200, the formal URL, and the correct title, and retain the results. Read failure logs and fix deployment failures before continuing verification. The current `digest:status` command does not perform these checks automatically.

## 7. Visuals

After remote verification, the system plans infographics for the top 10 papers by final score and one digest cover. Project scripts manage the tasks but never call an image API; Codex must use built-in `image_gen`.

```bash
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

Under `ephemeral-no-persisted-figure-assets-v1`, pages retain verified official arXiv HTTPS image URLs without copying images into the blog repository. Modern daily prepare verifies the official URL, ordinal, DOM and pixel SHA, and MIME, then returns empty `referencedImagePaths`. Infographics use the verified Reader text rather than old image caches. Legacy manifests may verify `.bin` caches and emit paths with actual extensions. In either case, use only absolute reference paths emitted by the current prepare command.

Inspect each generated image's title, Chinese text, arrows, metric direction, values, and ranking before recording it with the current task token and `--qa-attested true`. An explicit user request to cancel visuals is recorded through `digest:waive-visuals` and bound to the current publication. Pending tasks must never be relabeled complete.

## 8. Recovery and Final Status

Choose the command that matches the failed stage and intended scope:

```bash
# Resume blog review
./run-daily-digest.sh YYYY-MM-DD --from review

# Continue unfinished analysis
npm run deep -- --date YYYY-MM-DD
npm run batch

# Stop reusing failed Reader candidates for unfinished papers, then resume
npm run batch -- --retry-failed-readers

# Clear old Reader/image-supplement state and force full analysis
npm run reanalyze -- --concurrency 5

# Refresh articles and scores
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader

# Check data and batch status
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

`deep`, `batch`, `reanalyze`, and `api:reader:refresh` use only the sources referenced by the current canonical `dailyFreshSourceRun`. Batch date, exact paper set, and every PDF, text, runtime record, and manifest must match. These commands never fetch missing sources or use old caches. Missing or changed sources stop them before model or image requests. If the target is still Beijing today, rerun the same dated `digest:prepare` to establish the sources. For historical dates, retain the failure records and follow the historical maintenance workflow; do not restart at fetch.

`batch --retry-failed-readers` stops reusing failed candidates only for currently unfinished papers. `reanalyze` handles all old failed candidates and clears Reader/image-supplement state before forcing analysis. Both retain the same source requirements.

Regenerate final status after the last push, image record, or waiver. Reports are read-time snapshots. Report the batch complete only when data, review, remote publication, and live-site verification have all completed, and visuals have either passed or are covered by a user-requested waiver that remains valid for the current publication.
