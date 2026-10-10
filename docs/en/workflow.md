# Default LLM/API Workflow

## Audience and Completion Goal

Use this guide to run or recover a dated digest. First follow [Setup](setup.md) and confirm that the workspace role is `daily`, then run:

```bash
npm run digest:prepare -- YYYY-MM-DD
```

`digest:api` is an exact alias. A complete task covers candidate and analysis data, blog publication, live-site checks, and the paper infographics and cover. An analysis file, or a script that exited 0, does not finish the task by itself. Use the [Manual subsystem](../../manual/README.md) only when someone explicitly asks for it. Model, network, or quota failures never switch to it automatically.

## Sequence

```text
check date and archive → proxy-backed fetch → remove published papers
                      → keyword prefilter → model filtering
                      → save official text/PDF → analyze and score → write Reader articles
                      → generate blog → review → push and verify remote commit
                      → generate and record visuals → verify site and final status
```

## 1. Date and Archive

A run that starts with fetch must target the current date in Beijing. `autoArchiveCurrentData()` moves the previous batch's candidates, decisions, selected papers, and analysis to `data/archive/<date>/`. The cross-run deduplication database, `papers.json`, never moves.

A historical daily batch resumes from existing data at a stage the program allows. Do not fetch today's papers and present them as an earlier batch. For example:

```bash
./run-daily-digest.sh YYYY-MM-DD --from generate
```

The default API route can resume from `generate`, `review`, `push`, or `visual`. The Manual stages `tasks`, `spec`, and `analyze` do not apply to it. The orchestrator's argument checks decide which stages are allowed.

## 2. Fetch

Update the blog remote before resolving a fixed UTC window from the last pushed daily digest. arXiv uses 100 entries per page, verifies every page, and splits oversized queries by minute; known IDs never stop pagination. HuggingFace covers each day in the same window. A same-day v7 resume pins the saved `until` only after rechecking the published baseline, source configuration, and complete checkpoint. Legacy v6 does not prove multi-day coverage. See [the boundary guide](../daily-fetch-boundary.md).

arXiv and HuggingFace requests go through the project proxy. Each source has its own checkpoint with acquisition status, candidate count, and content SHA. Only a damaged source is fetched again. Paid model filtering starts only after all seven arXiv categories and HuggingFace pass their required acquisition-state and fixed-window coverage checks. Filtering resumes recheck these sources first. If any required source is incomplete, preserve saved checkpoints and partial candidates and stop before filtering or analysis model calls.

Fetched candidates are merged by normalized arXiv ID, deduplicated against published blog papers, and saved in `raw-candidates.json`. Candidates from partial sources support inspection and fetch recovery, but are not a complete filtering input.

## 3. Keyword and LLM Filtering

The keyword layer keeps papers that might be relevant. The model makes the final call:

- The keyword prefilter's core audio categories are only `eess.AS` and `cs.SD` (`CORE_AUDIO_CATEGORIES` in `scripts/lib/keyword-prefilter.js`); papers in either always reach the model. The fetch config in `scripts/config.js` separately marks `eess.SP` as `priority: 'core'`, which only affects fetch order and cross-category deduplication, not the keyword prefilter.
- An abstract under 80 characters cannot be rejected on keywords alone.
- Matches for audio, speech, music, acoustics, multimodal speech, and common models or datasets reach the model.
- In supplementary categories, only complete abstracts with no clear match may be rejected by keyword rules.

Decisions are saved per paper in `filter-decisions.json`. Filtering follows `PD_FILTER_BATCH_SIZE`. The current account moves to a later account only on an explicit `GoUsageLimitError` or `Insufficient balance` response. A generic 429 follows rate-limit backoff. Filtering is complete only when decisions cover every candidate and `filtered-papers.json` exactly matches the relevant decisions minus explicit exclusions.

## 4. Full Text and Staged Analysis

After filtering, the system freshly fetches official HTML text and PDF for every selected arXiv ID. It atomically saves `source.txt`, `source.pdf`, `source-runtime.json`, and `source-manifest.json` under `data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/`.

HTML preference and PDF fallback both happen here, during source capture. Analysis, Reader generation, and blog generation/review/push all use and verify that saved source set, never a legacy `data/current` text, PDF, or image cache. Source records include original and actual input lengths, SHA, truncation, and warnings. Abstract-only analysis is not publishable by default. Figure images live in the system temporary directory for the current model request only, and are not written to runtime image caches.

Each paper moves through these stages. Input, model, protocol, prompt, temperature, budget, and output fingerprints decide where it can resume:

1. Primary analysis.
2. Find code, open resources, and demo evidence.
3. Check and revise factual claims.
4. Repair tables, method details, and structure.
5. Validate and save tags and the core summary.
6. Determine document type, then audit eight score dimensions.
7. Generate the Reader-v3 article and verify source references for tables, formulas, authors, affiliations, and resources.
8. Prepare official figures and check their placement and explanations.

The official analysis keeps 13 fixed headings for the parser. The Reader article works from original source evidence and the figures actually supplied to the model, and it explains combined terms, training or computation, datasets, metrics, results, counterevidence, reproduction, and limits. Tables and figures sit next to the argument they support.

Each finished paper is merged into the latest `deep-analysis-result.json` under its paper lock, and `papers.json.digestStatus` is updated. Saved successes survive an interruption. A latest failure still requires a retry, even when an older successful article is still there.

## 5. Scoring and Production Proof

Scoring picks the document type and evaluates eight dimensions against paper evidence. Code recomputes the total, applies evidence-based caps, and records audit, input, and output SHA values.

The default batch earns its `llm_api_production` publication record only after the article, author, figure, score, source-identity, and exact paper-set checks pass. A default API batch must not contain provenance or proofs reserved for Manual analysis.

## 6. Blog Transaction

Run these stages in order:

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

Generate reparses scores and article content from the recorded data. Reader-v3 and Manual-v6 pages also receive `researcher-workbench-v1` front matter and four same-origin files: Citation JSON, BibTeX, RIS, and `rethink-context.json`. Pages and their accompanying files are installed together, with content checksums and a schema-v3 generation manifest.

Citations and pages use the verified source version. A base arXiv ID is never guessed to mean `v1`. If the current PDF returned 404 and an official historical version of the same paper was used, the saved `sourceVersion.selectedSourceId` supplies the actual version, and the page keeps the current-unavailable warning.

Review checks the digest first and paper pages concurrently, using programmatic checks, LLM review, image review, and Hugo builds. It never changes pages. Content corrections go back to generation or analysis. Per-page passes are keyed permanently by relative path and exact page-content SHA, so only changed content has to be reviewed again. Hugo and other current-batch checks still run.

A publisher-code change makes generation rerender, so real content changes show up. Generation metadata, model, code, review-protocol, or Hugo-runtime changes require batch checks and a new current receipt, but they do not re-review files whose final bytes are unchanged. A changed Git baseline or remote identity still blocks push.

Push commits only the exact file changes review authorized and verifies remote `main`. Generation records the actual input's absolute path, size, and SHA-256, whether it came from current data, a dated archive, or `--data-file`. Review and push verify that same input instead of switching to a later current file.

Digest indexes use `reader-facing-v3`: ranking entries and both Chinese and English titles link to standalone blog pages. Tags and eight-dimensional scores appear once, followed by rank bucket, document type, arXiv source, and affiliations. The old duplicated score/confidence/tag/arXiv footer must not come back. Reader-visible bare HTTPS URLs become clickable Markdown autolinks, without touching existing links, images, code blocks, or front matter.

Remote verification proves only that the commit was pushed. Before reporting the site as live, confirm a successful GitHub Pages build and deployment for that commit; a later deployment commit is acceptable only after you verify that it still carries this batch's reviewed page content. Check the dated digest and every published paper page for HTTP 200, the formal URL, and the correct title, and keep the results. Read the failure logs and fix deployment problems before continuing verification. The current `digest:status` command does not perform these checks on its own.

## 7. Visuals

After remote verification, the system plans infographics for the top 10 papers by final score and one digest cover. Project scripts manage the tasks but never call an image API; Codex must use built-in `image_gen`. Division of labor: `visual:post-publish` idempotently creates both image task types after remote verification (rerun it when tasks are missing or stale); `visual:prepare` emits the currently valid absolute reference paths before each generation.

```bash
npm run visual:post-publish -- --date YYYY-MM-DD
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

Under `ephemeral-no-persisted-figure-assets-v1`, pages keep verified official arXiv HTTPS image URLs without copying images into the blog repository. Modern daily prepare verifies the official URL, ordinal, DOM and pixel SHA, and MIME, then returns empty `referencedImagePaths`. Infographics are drawn from the verified Reader text, not from old image caches. A legacy manifest may still verify `.bin` caches and emit paths with their real extensions. Either way, use only the absolute reference paths the current prepare command prints.

Inspect each generated image's title, Chinese text, arrows, metric direction, values, and ranking before recording it with the current task token and `--qa-attested true`. An explicit user request to cancel visuals is recorded through `digest:waive-visuals` and bound to the current publication. Never relabel pending tasks as complete.

## 8. Recovery and Final Status

Pick the command that matches the failed stage and the scope you want:

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

`deep`, `batch`, `reanalyze`, and `api:reader:refresh` use only the sources the recorded `dailyFreshSourceRun` points to. The batch date, the exact paper set, and every PDF, text, runtime record, and manifest have to match. These commands never fetch missing sources or fall back to old caches, and missing or changed sources stop them before any model or image request. If the target is still Beijing today, rerun the same dated `digest:prepare` to establish the sources. For historical dates, keep the failure records and follow the historical maintenance workflow; do not restart at fetch.

`batch --retry-failed-readers` stops reusing failed candidates only for papers that are still unfinished. `reanalyze` covers all old failed candidates and clears Reader/image-supplement state before forcing analysis. Both keep the same source requirements.

Regenerate the final status after the last push, image record, or waiver. Reports are read-time snapshots. Call the batch complete only when data, review, remote publication, and live-site verification have all finished, and the visuals either passed or are covered by a user-requested waiver that is still valid for the current publication.
