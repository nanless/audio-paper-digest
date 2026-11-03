# Script reference

[中文](README.md)

The project supports three production workflows: daily digests, official conferences, and historical blog updates. The authoritative npm command list is the root `package.json`. This page explains where commands enter the system and what each runtime module does; the [workflow comparison](../docs/three-workflows.md) explains how they connect. Detailed linked operating guides are in Chinese unless an English version is explicitly linked.

Start with the workflow entry point for your task. Internal libraries are not alternate production commands. A module that verifies an old record does not reopen the retired workflow that created it.

| Workflow or responsibility | Entry points and adapters | Shared implementation |
|---|---|---|
| Daily | `full-fetch.js`, `deep-analysis-only.js`, `batch-analyze.js`, `refresh-api-reader.js` | `analysis-engine.js`, `deep-analyzer.js`, `analysis-contract.js` |
| Conference | `official-conference-acquire.js`, `conference-discover.js`, `conference-filter-run.js`, `conference-process.js` | The same engine, Reader, scoring, tags, and registered prompts |
| Historical updates | `historical-direct-rewrite-inputs.js`, `historical-direct-rewrite-plan.js`, `historical-direct-rewrite-run.js`, `history-resume.js` | The same engine; adapters preserve actual sources, frozen page scope, and old checkpoints |
| Pages | `generate-blog.py`, `conference-page-render.py`, `historical-page-render.py`, `lib/historical-direct-aggregate.js` | `publish-to-blog.py`, `paper_reader_presentation.py`, `tag_presentation.py`, hierarchical single/aggregate tags, and citation exports with real paper identities |
| Review and publication | `review-blog.py`, `push-blog.py`, `publish-conference.py`, `lib/historical-direct-publication.js` | `publish_common.py`, text/figure review, Hugo, exact manifests, Git and webpage checks |
| Files and implementation identity | `lib/paper-page-staging.js`, `lib/publication-file-primitives.js` | Immutable writes/readback SHAs and transitive fingerprints from `lib/workflow-implementation-files.js` |

## Daily digests and controlled recovery

All three workflows complete a normal round for the selected batch before retrying only eligible failures. The default is 3 total rounds. Batch rounds, the original Reader budget, and human-handoff suggestions are separate controls; see the [shared batch rules](../docs/three-workflows.md#全批轮次与失败集合).

`digest:prepare` is the complete default LLM/API daily entry point. The user's standing setting is **no generated images for future daily digests**. After pushing, the normal daily entry creates the records needed for a waiver and binds that waiver to the current publication. It does not prepare reference material for image generation or generate new images. The old `--no-visuals` argument remains accepted but is unnecessary. Original-paper figure acquisition, source verification, display, and review remain required.

Fetching calls `full-fetch --require-previously-fetched`. It derives overlap witnesses from verified previous checkpoints and requires actual encounters in each source, while still checking complete pages/windows and deduplicating only published papers. The recovery entries `deep`, `batch`, `reanalyze`, `reanalyze:selected`, and `api:reader:refresh` consume formally sealed daily sources; they do not fetch historical sources anew. Reader retries, paid-draft replay, and operator corrections retain original drafts, budgets, and costs; see [Reader recovery](../docs/reader-explicit-retry.md).

`prepare-daily-fetch-witness-recovery.js` (`fetch:witness:prepare`) registers private older-window materials only for a published original-input byte mismatch. `lib/daily-fetch-witness-recovery.js` activates them by CAS before archiving, then replays them at production-boundary, source-checkpoint, and next-day verification. The latest publication remains the deduplication baseline; the earlier complete five-file source checkpoint is recorded separately. This neither recovers missing original bytes nor changes old articles/costs. See [explicit older-window recovery](../docs/daily-fetch-boundary.md#published-input-drift-recovery).

Reader refresh defaults to concurrency 5 and 3 rounds. `--concurrency N` accepts 1–60; `--rounds N` accepts 1–10. Only explicitly retryable failures enter another round. Normal rounds do not change Reader epoch. Forced reanalysis applies its authorized reset only when first preparing each paper in this invocation; later failure rounds retain the candidate, counts, and costs.

### Core-summary-only recovery

`reanalyzeSelected(ids, { coreFeedbackFiles })` saves the original package and an unfinished correction obligation under the lock before any model request. For completed papers whose temporary checkpoints were cleared, it verifies the full original upstream before preserving stages only within core recovery. It does not fabricate intermediate text or re-sign old fingerprints. The other twelve sections are protected; normal scoring and any necessary Reader work follow.

`coreInputRecovery`, for old entry-point invalidation mistakes, permits only an exact recovery bound to the current complete failed object and actual parent-file SHAs. It retains the original failure, pending work, and costs. See [core recovery](../docs/reader-explicit-retry.md#已完成稿的独立核心摘要恢复).

### Small corrections after a Reader has been signed

An already-completed daily Reader whose original candidate is retired can use:

```bash
npm run batch -- --reader-signed-corrections MANIFEST --fact-feedback-file FEEDBACK
```

Replace both placeholders with the actual verified files. This explicit entry requires new source-bound Reader-only feedback, a literal rejected claim still present in the current article, complete-parent CAS, and step-by-step replay of the actual retired paid draft and operator history. The manifest covers every currently unfinished member.

v1 permits one bounded Chinese-term replacement. v2 preserves the complete parent and permits edits only within rejected-claim ranges in 1–8 existing nodes; table-binding corrections additionally need cell-by-cell evidence from the same complete original DOM table. Execution first saves a real unfinished feedback obligation, then uses normal parsing, sealing, and locked save. Retired candidates stay retired, original attempts/pixel evidence remain, and paid grants or model fallback cannot be mixed in. New manifests first use the module's read-only `prepare`/`preview`; normal independent blog review remains mandatory.

## Official conferences

Use `conference:acquire`, `conference:discover`, evidence/filtering, then `conference:process`. Publication uses `conference:publish:generate`, `conference:publish:review`, `conference:publish:push`, and `conference:publish:verify`. The unified entry authenticates actual conference sources and permissions. See the [conference guide](../docs/conference-workflow.md) for parameters.

For completed papers rejected by a full blog review, use the same migration entry's `--reader-review-feedback`; an additional window uses `--reader-review-window`. Do not mix these with `--retry-failed` or an operator manifest.

The conference adapter retains authenticated source context through Reader finalization and saved-record verification. On recovery, it first checks the same child's new saved paid draft. Zero-request completion requires genuine issuance and whole-paper qualification; an inherited parent is not a new repair. Shared summary-repair diagnostics use conference execution/canonical identity rather than a fabricated daily arXiv path, with unchanged repair standards.

The shared candidate-identity bridge also retains actual historical conference/arXiv routes. Early replay of an active conference paid candidate uses only a safe private temporary copy, with an independent asynchronous scope rejecting model calls before dispatch. Full qualification must pass before saving under the original paper lock. It grants neither child-run nor content allowance. Process reports distinguish window versus child exhaustion and retain the first actual service-fault cause.

## Historical blog updates

Use `history:inputs/plan/sources/run/aggregate/publication`; the [historical guide](../docs/history-rewrite.md) defines scope and source parameters. `history:resume` restores a paused current plan or narrowly resumes an already-existing legacy source task. It does not create old tasks or reset budgets. Source acquisition, tag supplements, status, and control tools remain part of historical maintenance.

## Shared support and terminology

Reader is the long-form explanation intended for readers. Reader-only means refreshing that explanation while preserving the upstream content specified by the chosen recovery route. A source capability is a private object produced by actual file verification and valid only in its corresponding scope; copied JSON, a declared SHA, or a direct low-level call cannot replace it.

Saved-record replay reopens original sources, drafts, and receipts and repeats their checks. Adoption is the normal transaction that makes a verified result the formal current record. Neither a saved candidate nor a staged page means the article has been published or the website is live. CAS compares the actual parent identity immediately before writing so a newer result is not overwritten.

After a rejected local patch, the next local request retains at most 3000 characters of rejection diagnostics. Normalization rebuilds current issues/targets. `patchRejectionFeedback` preserves diagnostics across transport failure and clears them after successful patch application. The old diagnostic grants no target or SHA; current target lists govern. Counts, no-progress decisions, and `lastContentError` budget rules stay unchanged.

All workflows depend on controlled environment/paths, model/proxy/account routing, catalogs, locks, usage, immutable sources, temporary original-paper figures, table/formula/author source checks, and publication completion checks. Daily digests directly register the standing no-generated-images instruction after publication. Retired generated images have read-only checks; original paper figures remain part of normal article review.

`manual/scripts` retains only old source/signature/article/prompt-contract verification and independent single-page review. Bulk author/task/spec production, social publishing, backfill, experiments, and visual debugging entries are retired. New independent reviews actually use `gpt-6.1-sol/high` and real v4 identity under `manual_agent_policy.py`; old model declarations cannot sign new reviews.

Text and figure review in `publish-to-blog.py` share a figure-number explanation only after the current signed Reader and sealed DOM mapping pass. It distinguishes review-image position, DOM entry ordinal, and the author's printed figure number. The explanation participates in actual requests/text-unit cache identity; it changes neither text nor figures and does not remove model findings. Non-DOM, legacy, and sources without actual author labels do not use it.

`test-api-key.js` is an explicit installed-route diagnostic and sends real model requests. Historical prompts are verified read-only against original Git blobs/SHAs; their full text is not restored to the working tree.

## Validation

```bash
npm run verify
npm run validate:data
npm run test:default
npm run test:compat
```

Full validation covers the shared engine, three source adapters, legacy compatibility, JS/Python/shell syntax, fixed Hugo, and read-only formal-data checks. A successful entry point or staged page does not establish deployment. These commands are reference instructions, not evidence that validation ran during a documentation edit.

## Runtime file index

Use a workflow entry first, then locate its libraries here. “Internal library” and “legacy recovery” do not authorize bypassing normal entry points. Legacy records remain limited to their original identities and budgets. Search by the exact filenames below.

### Analysis, scheduling, and fact recovery

| File | Role and limits |
|---|---|
| `analysis-contract.js` | Checks the shared API analysis structure, scores, methods, and tables in Node; also reads historical Manual results. |
| `lib/experiment-source-setting-axes.js` | Uses the paper's actual experiment statements, complete source table, and row identities to verify perturbation, fusion scheduling, and sample-size axes, including sample-size comparisons supported by that matrix. It changes neither values, sources, nor budget; other table and whole-paper checks remain required. |
| `analysis-engine.js` | Schedules a full first round and only retryable failures thereafter, waiting for each round's results and saves. Manages paper locks, retries, checkpoints, concurrency, merging, and completion. `PD_CHECKPOINT_TIMING=1` records checkpoint-save timings. |
| `analysis-waiver.js` | Verifies a user waiver for the current daily analysis batch against the exact deep, filtered, and papers files and each source SHA; does not modify analysis text. |
| `analysis_sections.py` | Recognizes paper-assessment sections in Python, accepts older headings, and rejects duplicate or mixed headings. |
| `batch-analyze.js` | Resumes sealed daily sources under per-paper locks. Full conditions follow this table under the same filename. |
| `lib/daily-arxiv-oai-source.js`, `lib/daily-arxiv-announcement-source.js` | Implements explicit `--official-oai-recovery` only after both date and category Atom queries actually return HTTP 429 for the same category and fixed window. Full conditions follow this table under the same filename. |
| `deep-analysis-only.js` | Continues selected but unfinished daily papers using the current `dailyFreshSourceRun` PDF/TXT. Missing or mismatched sources stop processing; no refetch or old-cache fallback. |
| `deep-analyzer.js` | Runs source-adapted full-paper analysis, score audits, Reader writing, and original-paper figure planning. Daily recovery reads this batch's sealed sources. After structural repair, verifies the detailed core summary solely against the original paper. Stage dependencies, SHAs, and checkpoints determine the necessary recovery work. |
| `lib/analysis-section-titles.js` | Recognizes analysis headings and code fences, extracts the unique assessment section, and supports old headings without rewriting text. |
| `lib/analysis-stop-control.js` | Handles graceful stops during batch analysis and Reader refresh: stops new papers and model requests while preserving returned content and original costs. Nested calls share stop state; parallel calls keep separate state; listeners are removed on exit. See [stopping analysis](../docs/analysis-stop.md). |
| `lib/analysis-terminal-summary.js` | Provides Chinese display labels for final analysis status, text-source types, and counts; unknown values retain their original spelling. |
| `lib/analysis-text-profile.js` | Shares text-length profiles across full analysis, Reader-only, and scoring-plus-Reader. Registered short papers require replay of the actual verified conference PDF; ordinary thresholds and formula/table requirements stay unchanged. |
| `lib/analysis-failure-rounds.js` | Fixes the first-round scope, waits at round boundaries, selects retryable failures, stops on run-level errors, and reports possible human handoff. Does not alter sources, articles, costs, or publication eligibility. |
| `lib/analysis-batch-report.js` | Saves the fixed Reader-refresh scope, source references, rounds, and handoff suggestions as private diagnostics. It does not certify sources, successful articles, publication, or new requests. |
| `lib/cancelled-reader-audit-recovery.js` | At the normal analysis entry, verifies failures caused by cancelled steps against saved text, sources, and request records, then lets the engine finalize. Adds no model request and retains original stage errors and costs. |
| `lib/analysis-stage-request-guard.js` | Persists request prohibitions for failed non-Reader stages across conference recovery rounds, covering normal and custom model entry points. Pure checks and paid-output replay remain available; Reader uses its own cumulative ledger. |
| `lib/conference-reader-operator-correction.js` | Applies bounded human Reader patches only to the registered conference grant's complete final failure set. Full conditions follow this table under the same filename. |
| `lib/reader-single-source-table-append.js` | Purely validates the fixed shape of a single source-table append, binding six files, original PDF bytes, source window, existing section-11 ending, and second binding. Protects existing content. Output is candidate data, not source authority, eligibility, or budget; conference private v2 loading still requires complete parsing and saved-source replay. |
| `lib/conference-reader-resolved-origin.js` | Read-only authentication of the unique latest retired paid Reader not saved by the outer caller. Full conditions follow this table under the same filename. |
| `lib/conference-source-resource-correction.js`, `lib/conference-source-resource-correction-apply.js` | Zero-request source-fact recovery with separate physical contracts for resource ownership and a single core-summary sentence. Full conditions follow this table under the same filename. |
| `lib/conference-complete-stage-pool.js`, `lib/conference-complete-stage-worker.js` | Privately verifies completed conference papers and full aggregates using at most 5 real worker threads. Full conditions follow this table under the same filename. |
| `lib/conference-analysis-adapter.js` — `replaySavedConferenceReaderRevision()` | Replays existing ordinary or additional-window Reader revisions under actual sources and the paper lock, with models forbidden. Full conditions follow this table under the same filename. |
| `lib/conference-reader-operator-apply.js` | Under actual paper locks, runs normal Reader parsing and whole-paper checks, saves child drafts by CAS, revalidates saved files after leaving the live scope, stages pages, and atomically adopts the complete set. Preserves attempts and costs; opens no paid window. |
| `lib/cancelled-reader-final-checkpoint.js` | When a cancelled step is the only blocker, resumes a real final checkpoint after original integrity, source, and feedback checks, without regenerating completed content. |
| `lib/completed-bound-fact-feedback.js` | Shared by ordinary batch and single-paper recovery to read-only replay completion proofs, sources, and forbidden claims in the actual parent/child feedback context. Does not write packages, grant requests, or change explicit full-reanalysis behavior. |
| `lib/pending-fact-feedback.js` | Saves an unfinished fact-correction obligation under the lock after checking real feedback and the original package. Old success is not new-feedback completion. Recovery without new feedback uses the saved package; only complete qualification for that feedback clears it. Grants no model budget. |
| `lib/completed-reader-upstream.js` | Verifies analysis, core summary, tags, scores, sources, and original feedback before the Reader; shared by normal recovery entries. |
| `lib/paid-core-literal-correction.js` | Bounded term correction with explicit core feedback and a unique paid-summary ID. Under the lock, binds the full parent, four source files, actual paid response, and task authorization. Allows one non-numeric 2–8-Chinese-character literal replacement; retains response/output SHAs, records operator provenance, replays after save, and grants no model attempts. |
| `lib/daily-fact-review.js` | Strictly reads external fact feedback, checking paper/date/runId, four source SHAs, current core/full-analysis SHA, and literal quotations. Rereads under the lock before normal full-analysis, core, Reader, or tag stages. Full correction preserves paid records first, rejects feedback-free regeneration, and does not hand-write successful text. |
| `lib/merge-failed-reader-bundle.js` | Keeps Reader text and stage records together when saving a failure, preserving actual failed drafts, requests, and costs instead of combining old text with new records. |
| `lib/paid-final-analysis-recovery.js` | Recovers an existing paid final analysis against current source and stage identity. |
| `lib/primary-fact-local-repair.js` | Limits a source-bound analysis correction to one original paragraph. Verifies JSON `from`/`to`, draft SHA, and edit scope; all unauthorized text remains byte-identical. Normal analysis still checks the full article and scores. |
| `lib/primary-local-validation-replay.js` | Replays the old dual-input local-validation chain within actual daily sources and original analysis feedback, checking payment, snapshots, and required operator markers. Keeps stages, failures, costs, and obligations; grants neither budget nor whole-paper success. Missing replay records retain their normal rejection behavior. |
| `lib/saved-fact-feedback.js` | Restores saved feedback for deep and batch, preferring explicit new feedback and checking each stage proof. Restores differing analysis/core guidance separately. Old Reader-parent recovery requires a real analysis checkpoint and protects every non-Reader upstream field in both original and callback objects before save; errors restore memory and callbacks. Drafts, failures, and costs remain. |
| `lib/scoring-third-party-resource-replay.js` | Exactly replays original scoring input when only third-party-dependency reachability fluctuates, preserving paid scores and the text used in that audit. Author-resource changes still require normal reassessment. |
| `lib/saved-scoring-audit-replay.js` | Under the real daily paper lock, reads the complete original package and unique first-scoring usage to provide a private candidate for checking. Restores a checkpoint only after normal resource reprobe, complete score fingerprint, and request-body replay all pass; grants no new request or budget. |
| `lib/daily-scoring-refresh-checkpoint.js` | Saves refreshed daily scores under the lock before Reader work. Recovery rechecks four sources, the full scoring fingerprint, feedback, and parent, then resumes only Reader. Pending work blocks publication; drift does not authorize paying for scoring again. |
| `lib/daily-scoring-refresh-checkpoint-cli.js` | Private file-descriptor entry used by Python daily publication when a private saved result belongs to the same source run. Calls the same recovery verifier only to identify pending work, with networking forbidden; does not adopt scores or grant models. |
| `lib/selected-full-stage-reanalysis.js` | Fully regenerates explicitly selected papers from current sealed text, archiving old stages, costs, and feedback under the lock. Same-round recovery retains new costs; ordinary recovery does not enable this mode. |
| `reanalyze-selected.js` | Reanalyzes only specified arXiv IDs and synchronizes recovery statistics. |
| `reanalyze.js` | Archives and disables all old failed Reader candidates, clears Reader and supplementary-image state, and forces full reanalysis. Reads only the daily PDF/TXT precisely bound to formal analysis; does not restore old text or caches. |
| `refresh-api-reader.js` | Refreshes Reader, scoring, authors, and image stages for IDs or a dated batch. Full conditions follow this table under the same filename. |
| `waive-analysis-failures.js` | Records an explicit user waiver for current daily analysis failures against existing files; does not overwrite failed attempts. |


When primary analysis is complete and only the explanatory article needs updating, use `npm run api:reader:refresh -- ID`. To resume existing failures in their original batch, use `npm run batch`. Both verify the sealed sources bound to current formal results, reread the parent under the paper lock, and merge saved changes against its current identity. Fact corrections still require the corresponding explicit feedback entry. Do not recover by manually deleting failure markers, completion proofs, or candidates. The program clears resolved failures only after normal whole-paper qualification and successful saving; original drafts, historical counts, and costs remain preserved.

**`batch-analyze.js` — full operating conditions**

Resumes sealed daily sources under per-paper locks. Accepts repeated `--fact-feedback-file FILE`. `--refresh-reader-diagnostics` preserves drafts and counts. An explicit paid retry requires both `--retry-failed-readers --reader-retry-manifest FILE`, or `main({ readerRetryManifestPath: FILE, refreshReaderDiagnostics: true })`.

It admits only exhausted failures with the same actual input. The first explicit window allows 3 saved attempts, 1 saved full rewrite, 6 physical requests, and 80k reserved output tokens. Later local or missing-article recovery needs a separate bounded manifest; original and cumulative ledgers remain checked. Missing manifests, bad bindings, remaining ordinary attempts, and successful papers are rejected. Original drafts and costs remain preserved.

**`lib/daily-arxiv-oai-source.js`, `lib/daily-arxiv-announcement-source.js` — full operating conditions**

Implements explicit `--official-oai-recovery` only after both date and category Atom queries actually return HTTP 429 for the same category and fixed window. Seals complete XML pagination in both OAI formats and the target-day RSS announcement.

Raw supplies version times; structured XML supplies title, abstract, and ordered authors. Recovery, data validation, and the next daily boundary reread original bytes and reconstruct candidates, preserving batch identity, successful sources, and original failures. See the [fetch boundary](../docs/daily-fetch-boundary.md#两条-atom-查询均限流时的官方-oai-恢复).

**`lib/conference-reader-operator-correction.js` — full operating conditions**

Applies bounded human Reader patches only to the registered conference grant's complete final failure set. Verifies packages, candidates, responses, budgets, assets, and the real PDF; forbids model/network requests; preserves the original package and replayable receipt.

Saved checkpoints replay receipt/before/canonical evidence without re-signing the manifest. A stale resource pointer requires the same verified preflight and real parent; an empty article may use only this execution's matching three-SHA scoring checkpoint with complete scientific upstream. Original failed bytes remain unchanged.

**`lib/conference-reader-resolved-origin.js` — full operating conditions**

Read-only authentication of the unique latest retired paid Reader not saved by the outer caller.

Checks the registered ledger, actual request/response/cost, original prompt, migration chain, deterministic normalization, and same-source input. The private handle serves only final-failure v1 local correction and per-paper restriction before Reader-only requests; it neither reactivates candidates nor grants budget.

**`lib/conference-source-resource-correction.js`, `lib/conference-source-resource-correction-apply.js` — full operating conditions**

Zero-request source-fact recovery with separate physical contracts for resource ownership and a single core-summary sentence. Preserves the latest analysis and real Reader parent; after normal parsing, complete live/saved verification, and staging, adopts the whole set atomically under all paper locks.

Costs and budgets stay unchanged. Requires `--postprocess-only --source-corrections FILE`; see [source correction](../docs/conference-workflow.md#认证来源事实的零请求纠正).

**`lib/conference-complete-stage-pool.js`, `lib/conference-complete-stage-worker.js` — full operating conditions**

Privately verifies completed conference papers and full aggregates using at most 5 real worker threads. Normally follows `--concurrency`; migration may set `--postprocess-concurrency 1–5` for completed-paper staging and aggregates alone. It changes no model slots, stage limits, attempts, or costs. Fixed workers require the daily role and cannot run as standalone main programs.

They reconstruct real source/plan authority from archives, forbid models, and perform whole-paper checks. Aggregates call normal `loadStage` once per paper. Only fixed PDF-extractor/render subprocess timeouts get one serial normal retry after the complete first round, retaining errors, without recursion or extra analysis costs. The main thread holds the operation lock, rereads members/state/pages/assets/original SHAs, and performs one final CAS; JSON or a subset cannot forge the private batch capability. No separate production CLI.

**`lib/conference-analysis-adapter.js` — `replaySavedConferenceReaderRevision()` — full operating conditions**

Replays existing ordinary or additional-window Reader revisions under actual sources and the paper lock, with models forbidden. Complete revision reads before/inside/after the lock each use their own synchronous check scope, rereading before return; never span asynchronous work. Window paths retain full checks.

Does not prepare children, preflights, or budget. Invalid drafts return before writing attempts, failures, or costs. Valid drafts are normally saved and sealed, then migration checks pages and adopts by CAS.

**`refresh-api-reader.js` — full operating conditions**

Refreshes Reader, scoring, authors, and image stages for IDs or a dated batch. Uses `ANALYSIS_CONFIG.apiReaderConcurrency` (5) unless `--concurrency N` overrides it within 1–60; `batchMaxRounds` defaults to 3, with `--rounds N` in 1–10.

Runs the full batch first, then explicitly retryable failures. Saves `analysis-batch-reports`, reads only sealed PDF/TXT, and prepares images only in this call's system temporary directory.

### Daily fetching and filtering

| File | Role and limits |
|---|---|
| `evaluate-keyword-prefilter.js` | Read-only evaluates current keyword prefilter rules against human-adjudicated samples and historical selections. Reports adjudicated-positive recall separately from raw hit rate and false admissions of adjudicated negatives. Missing valid samples or false admissions return nonzero; read/format errors are not empty samples. |
| `fetch-huggingface-papers.js` | Fetches Hugging Face Papers using `curl` with the minimal child-process environment. |
| `fetch-papers.js` | Fetches arXiv, completes abstracts, applies keyword prefiltering, and makes per-paper model filtering decisions. Even standalone fetching needs the project Python 3.11+ runner for strict Atom parsing. |
| `full-fetch.js` | Checks the published baseline and fetch boundary, then archives, fetches, deduplicates only published pages, filters, seals selected sources, analyzes, and saves each paper. First-pass recovery indexes old results by ID and merges by that map; memory retains only each paper's latest attempt, while every failure, checkpoint, and cost stays persistent. |
| `lib/arxiv-metadata-source.js` | Fetches one official arXiv Atom entry through project HTTP CONNECT, verifies response SHA, and extracts allowed title/abstract/authors/categories. Existing v1 strictly checks XML but preserves entity spelling and author whitespace when recomputing old sealed SHAs; normal daily fetching uses decoded fields. |
| `lib/daily-arxiv-prefix-source.js` | After date-query HTTP 429, completely traverses the same official Atom category list for the fixed window, retaining witnesses, pagination endpoints, response SHAs, and first-page replay. Recovery, read-only validation, and the next fetch share coverage checks. |
| `lib/daily-fetch-boundary.js` | Derives fetch windows from verified remote daily publications and controlled archives, and reads formal-page fields for deduplication; see the boundary guide. |
| `lib/daily-xml-file-stdin.js` | Transfers complete input to the original OAI/RSS Python validators through a private temporary regular file's read-only descriptor, avoiding synchronous-pipe completion waits. Preserves deadlines/output limits, cleans up after each call, and distinguishes local runtime errors from rejected source content. |
| `lib/daily-fresh-source-plan.js` | After daily filtering, seals this acquisition's official TXT/PDF and manifests for each arXiv paper. Analysis reads only that set; figures are prepared temporarily for the current request. |
| `lib/fetch-scheduler.js` | Serializes fetching by host, records cooldowns, and identifies failure categories. |
| `lib/filter-input-contract.js` | Computes the filtering input SHA; when official scope evidence is used, binds the actual evidence sent to the model too. |
| `lib/filter-scope-evidence.js` | Before paid filtering, fetches official TXT/PDF/runtime/manifest for candidates matching only broad multimodal terms without an explicit audio modality. Rereads sources and saves the actual excerpts and SHA. Does not decide relevance itself. |
| `lib/keyword-prefilter.js` | High-recall audio keyword prefilter, with versioned rules. |
| `lib/filter-decision.js` | Shared daily/conference parsing of decisions, reasons, and v3 declarations. Preserves retryable undecidable outcomes and legacy fetch exports. |
| `parse-arxiv-atom.py` | Via `python-runtime.sh`, strictly parses bounded stdin Atom XML, official IDs, titles, and abstracts, then emits bounded JSON. Rejects document-type and entity declarations. |

### Conference sources, processing, and publication

| File | Role and limits |
|---|---|
| `conference-discover.js` | Read-only scans explicit conference metadata/PDF directories, saving candidates and reports with `O_EXCL`. Does not authenticate identity or request models. |
| `conference-extract.py` | Extracts page text and a visual audit from one explicit staged PDF. `--verify --source-root ABS` reruns fixed PyMuPDF extraction temporarily and compares every saved byte. No original TeX means no displayed-formula authority. |
| `conference-filter-evidence-extract.py` | Fixed PyMuPDF evidence worker: reads only controlled source requests, metadata, and PDFs; produces page text, per-page PNG audits, figure/table/formula candidates, abstract-location evidence, and verifiable receipts. No network or models. |
| `conference-filter-evidence.js` | Before model filtering, extracts full text and `abstract-locator-v1` evidence from sealed PDFs in authenticated candidates, saving resumable candidates/reports. Makes no selection decision or model request. |
| `conference-filter-run.js` | Only `--apply` verifies the candidate/report/evidence-bound configuration and calls fixed `requestLlmJson()` per paper. New runs use v6; verified v5 runs retain their format. Processes pending first, retries failed only with explicit retry, remaining attempts, and backoff. Recovers records before requesting after interruption, avoiding automatic double charging. |
| `conference-filter.js` | Creates a conference-specific v6 configuration from authenticated candidate/report pairs and complete evidence runs; prepares, inspects, or applies controlled decisions. v5 is only for the original UUID. Human entries cannot create/load model-actor decisions; only the controlled runner can produce them. |
| `conference-import.js` | Accepts only staged/import pairs with complete discovery and filtering records; copies authenticated sources and saves source-manifest/import-receipt pairs. Arbitrary paths are rejected. |
| `conference-page-render.py` | Renders one sealed conference Reader with its assigned tags, explaining what text/figures/tables/formulas this PDF supports. Uses real conference identity, generates no figure files, and reads no old blog text. |
| `conference-plan.js` | Authenticates the full discovery/filter/staging/import chain, reviewed plan, and catalog SHA, then exclusively creates the run and plan-receipt pair. |
| `conference-process.js` | Sole new-conference production batch entry. Full conditions follow this table under the same filename. |
| `conference-queue.js` | CLI for controlled conference queues, coordinating acquisition of tasks and resumption through the unified process. |
| `conference-staging.js` | Checks the complete selection against reviewed extraction results and creates immutable import manifests/receipts. Copies no files and requests no models. |
| `conference-tools.js` | Read-only validates private conference ledger/run files; accepts direct filenames only inside controlled run directories. No PDF import, network, or models. |
| `conference-workspace.js` | Checks conference workspace directories and controlled source preparation. |
| `conference_extractor.py` | Verifies PDF bytes and SHA, records UTF-8 byte offsets, and extracts page text, PNGs, images, and layout candidates. Saves with `O_EXCL` and reports structured blocked/integrity status. |
| `conference_publication_gate.py` | Checks conference identity, source ledger, and page publication eligibility. |
| `icmc-proceedings.py` | Uses bookmarks and the official ICMC 2026 combined proceedings directory to derive paper order, page ranges, and authors, splitting original PDFs without rasterization or model calls. Original charts and formulas remain unchanged. |
| `lib/conference-analysis-adapter.js` | Revalidates the complete conference plan and sources before shared analysis. Full conditions follow this table under the same filename. |
| `lib/conference-analysis-context.js` | Places one authenticated conference paper in a process-private analysis context and fixes its Reader-attempt directory. Rejects arXiv aliases, other execution directories, or text/table/formula/figure state inconsistent with verified sources. |
| `lib/conference-discovery.js` | Read-only discovers ICASSP/ICLR/ICML or strict `official-proceedings` metadata snapshots and local PDFs. New conferences match only stable official IDs/`pdfFile`; titles are not identity. |
| `lib/conference-execution.js` | Creates independent execution directories and immutable authorization receipts only from authenticated plans. Every read/progression rechecks the plan; controlled updates compare old bytes under the lock. Generic interfaces still cannot write completion directly. |
| `lib/conference-extraction-receipt.js` | Checks request/source/extraction files by rerunning fixed Python/PyMuPDF temporarily on every load and comparing results. The visual audit retains page PNGs, embedded images, tables, figures, formula candidates, and SHAs; without original TeX, formula-text binding is forbidden. |
| `lib/conference-filter-evidence.js` | Batch-authenticates exact official PDFs from verified candidates, extracts page text, visual audits, and original abstract locations, and saves resumable evidence runs/candidates/reports. Non-ready abstract evidence goes to the model rather than automatic exclusion. |
| `lib/conference-filter.js` | Binds candidates, complete verified evidence/receipts, the daily prompt, keyword policy, conference domain, and model/endpoint/catalog fingerprints. Full conditions follow this table under the same filename. |
| `lib/conference-importer.js` | Safely imports metadata, PDFs, and extracted artifacts from authenticated staging into private storage, then saves source manifests/import receipts. Low-level helpers are reserved for isolated tests. |
| `lib/conference-pdf-source.js` | Verifies controlled local PDF bytes, paths, and links, returning a replayable source description. Without reliable structured TeX, formulas are explicitly unavailable. |
| `lib/conference-plan.js` | Builds runs and plan receipts only from authenticated imports, a reviewed plan, and the current catalog. Recovery reads the original catalog/version from its archived receipt SHA without changing plan/run/receipt bytes. Traceable sources do not grant old tags current publication authority; staging still checks tags. Rejects arbitrary paths, aliases, and incomplete member sets. |
| `lib/conference-postprocess.js` | Authenticates each plan, source, completed result, current tags, and render. Full conditions follow this table under the same filename. |
| `lib/conference-process-recovery.js` | Recovery rules preserving conference checkpoints, paid stages, and source bindings. |
| `lib/conference-recovery-grant.js` | Immutable additional conference-budget registration and private runtime authority, bound to the process's complete failures, parent/child CAS, and actual sources. Resumes the same grant; JSON alone cannot grant requests. |
| `lib/conference-reader-review-maintenance.js`, `lib/conference-reader-review-maintenance-evidence.js` | Runs a separate normal Reader-maintenance batch after actual complete conference blog rejection. Full conditions follow this table under the same filename. |
| `lib/conference-publication-figure-crop.js`, `lib/conference-publication-figure-crop-replay-cli.js` | Derives publication figures from the same authenticated PDF and replays them through a fixed offline FD bridge. Normal publication still requires the real current parent; maintenance-only functions accept a private historical authority and recompute original PDF/pixels and all actual artifacts, granting neither current publication nor Reader success. |
| `lib/conference-reader-publication-evidence.js` — `assertVerifiedPublicationReaderPdfSourcesUnchanged()` | Deduplicates source files referenced by actual WeakMap handles in one batch check. Rejects handle/SHA/read-policy conflicts, then completely rereads each unique file. No cross-call cache; source, failure-set, and current-state checks remain separate. |
| `lib/conference-reader-review-maintenance.js` — `revalidateMaintenancePublicationSources()` | Under the original process operation lock with models forbidden, recomputes a fixed historical PDF publication view and saves a new current proof/source-revalidation receipt. Keeps old outcomes, PNGs, drafts, and costs. No new public CLI or final-publication approval. |
| `conference_publication_figure_crop.py`, `reader_pdf_page_geometry.py` | Fixed geometry with unique printed-figure/full-caption matching, for exact figures or complete original pages. Full conditions follow this table under the same filename. |
| `conference_publication_figure_view.py`, `conference_publication_figure_view_replay.py` | Consumes only actual Node replay output, using the original image parser for a separate publication page while retaining Reader/source signatures. The private FD transformation recomputes raw-to-view bytes; a JSON self-hash alone grants no source, review, or publication authority. |
| `lib/conference-reader-recovery-window.js` | Cumulative ledger for one registered conference window: 6 content/2 full responses, reserved before requests. Preserves immutable requests/responses; missing or damaged records block replay. Generation requires the paper lock; read-only identity replay forbids models. |
| `lib/conference-retained-source-replay.js` | Read-only replays each paper's retained source plan after a completed source upgrade, authenticating original filtering/staging/import/plan/extraction and reusing verified plan handles. Single/aggregate pages use each original source. Only exact catalog-metadata restoration to the original receipt SHA is replayed temporarily; no original file changes, re-extraction, or analysis. |
| `lib/conference-reader-active-candidate-replay.js` | Replays an existing paid conference-child candidate in an offline private temporary directory, verifying the unique request/response/usage/source/archived prompt. Its private scope retains the original template and real PDF authority. Normal whole-paper qualification must pass before adapter save; no new requests/budget or original-draft overwrite. |
| `lib/conference-reader-publication-evidence.js` | For completed-conference publication checks, derives literal original-PDF header/unit/setting quotations bound to the original plan, extraction, article, and table. Does not modify old drafts/source signatures or grant ordinary analysis success/skip rights. |
| `lib/conference-process.js` | Seals/imports the full conference selection, calls shared analysis, and generates Reader/score/tag pages and summary. Outer concurrency defaults to 1, accepts 1–60; inner concurrency is 1, without changing stage limits/budgets/rounds. New process/completion receipts each use v2 and `tagCatalogVersion`/`tagCatalogSha256`; old records are fully verified and resumed under the original UUID. |
| `lib/conference-publication-author-replay-cli.js` | Local file-based author replay for Python publication. Full conditions follow this table under the same filename. |
| `lib/conference-publication-author-source.js` | Read-only verifies official metadata, PDF, extracted sources, and analysis receipts, including full names and affiliations. Original 2.3.0 receipts use the strict retained-source reader; other versions use current strict verification. No new sources, re-extraction, or models. |
| `lib/conference-queue.js` | Conference queue state, task acquisition, and concurrency protection using the unified process. |
| `lib/conference-run.js` | Fixes conference membership/shards/tag and selection-policy versions and paper states. Generic state updates reject direct `completed`. This older aggregate-publication interface remains disabled because authenticated completion evidence is missing; current work uses `conference:process` and `conference:publish:*`. |
| `lib/conference-source-context.js` | Production accepts only a plan actually verified and registered in the current process, rechecks full upstream evidence, and reads text. Exports no ledger/run test shortcuts. |
| `lib/conference-source-ledger.js` | Stores conference source identity, four file-category SHAs, and review evidence immutably; rereads local sources on load. A title is not a paper identity. |
| `lib/conference-source-upgrade.js` | Checks source-upgrade identity and bindings to existing analysis. |
| `lib/conference-staging.js` | Matches authenticated selection one-to-one with reviewed extraction results, issuing import manifests/receipts; excluded items and identity aliases cannot enter. |
| `lib/official-conference-acquisition.js` | Fixed 2026 official index/record/PDF acquisition allowlists, with `PROVIDERS` as source authority. AAAI volume 40 uses a fixed 48-issue set and checks every issue receipt/SHA and cross-issue article-ID uniqueness; other providers use one index. Saves index/downloads using `0600`/`O_EXCL`, fully rechecking on resume. |
| `migrate-conference-process.js` | Explicitly migrates a conference process implementation fingerprint, rechecks completed pages, archives old completion receipts, and resumes unfinished papers without changing UUID/record format/original catalog values/attempts. Full conditions follow this table under the same filename. |
| `official-conference-acquire.js` | Runs catalog/download/status/verify in the daily workspace with central configuration, fixed identities, project CONNECT, and official allowlists. Arbitrary output roots are forbidden. Download explicitly accepts concurrency 1–5 and 0–5 transient retries for the same URL. |
| `publish-conference.py` | Runs conference generate/review/push/status/verify against process receipts. Full conditions follow this table under the same filename. |
| `recover-conference-process-locks.js` | Actually recovers old operation locks only after confirming this workspace and a dead owner PID under the lock protocol. Active or incomplete locks are skipped. |


**`conference-process.js` — full operating conditions**

Sole new-conference production batch entry. From the full selected set, seals exact official proceedings PDFs, imports them, creates the current classification plan, and invokes the shared engine with stable per-paper UUIDs. `--concurrency` sets outer concurrency, which defaults to 1, accepts 1–60; inner per-paper concurrency is 1.

Reader keeps its own limit and normal full-analysis revisions use at most 3 slots. Adds no allowance. Produces private single/aggregate pages and checks full-process checkpoints/receipts; does not publish. Source upgrades must be explicitly selected.

**`lib/conference-analysis-adapter.js` — full operating conditions**

Revalidates the complete conference plan and sources before shared analysis. Preparation binds plan/source/initial-analysis SHA; interrupted preparation fills only missing files after checking existing ones. Completion is checked and receipted separately.

A legacy execution without preparation needs a new UUID under the same authenticated plan. Old complete-paper recovery preserves the parent and creates a source-bound child with fixed preflight/mode/budget; uses shared Reader-only, scoring-plus-Reader, or full analysis. Scores save immediately by CAS; Reader failure resumes only Reader. Source and parent/child chains remain fully replayed.

**`lib/conference-filter.js` — full operating conditions**

Binds candidates, complete verified evidence/receipts, the daily prompt, keyword policy, conference domain, and model/endpoint/catalog fingerprints. `ready` abstracts enter prefiltering; other states go to the model.

Saves preparation before requests, binding content/source/original-state SHA; saves request receipts and decisions, checking state before update. Only the fixed common route can issue production evidence; custom transport is forbidden. Recovery checks locks and existing records first.

**`lib/conference-postprocess.js` — full operating conditions**

Authenticates each plan, source, completed result, current tags, and render. Staging paths include catalog/render fingerprints, so upgrades do not overwrite old pages.

Full private summaries require executions exactly covering the selection; the private pool reuses one complete `loadStage` result per paper. New PDF hierarchy/flat-table evidence reconstructs the full original grid/conditions/units without changing successful old proofs.

**`lib/conference-reader-review-maintenance.js`, `lib/conference-reader-review-maintenance-evidence.js` — full operating conditions**

Runs a separate normal Reader-maintenance batch after actual complete conference blog rejection. Checks canonical generation/full review/failure/permanent pass cache, parent/source/CAS, and original unverified findings. Eligible partial Reader-only preparation may defer redundant saved-only replay to the normal entry. Only an actual unissued zero-attempt resource reprobe receipt permits first scoring-plus-Reader, with fixed preflight and scoring-checkpoint replay and protected costs/upstream. Ordinary synchronous reads/staging share repeated historical assertions only within the same scope, rereading fully at first use and return and checking child/parent/revision/seed/preflight SHAs and output/history isolation.

Full source/Reader/render checks remain; windows/exclusions retain the original path, and no scope crosses asynchronous work, requests, or a successful save. Saves each success, finishes the full round before retrying failures, records extra windows separately, and uses historical view authority only to authenticate old review materials. Pending blocks publication/ordinary migration. Full success is normally adopted, staged, and aggregated. The evidence-only module issues no capability.

**`conference_publication_figure_crop.py`, `reader_pdf_page_geometry.py` — full operating conditions**

Fixed geometry with unique printed-figure/full-caption matching, for exact figures or complete original pages. Limited-page mode additionally needs authenticated raw artifact/sourceRef/page authority and a unique printed figure on that page; partial/unavailable captions stay null and are disclosed.

Ordinary crop rules remain strict. Does not alter old daily SVG bytes/proof contracts or accept arbitrary rectangles.

**`lib/conference-publication-author-replay-cli.js` — full operating conditions**

Local file-based author replay for Python publication. Explicit new-conference mode uses the real daily wrapper; historical calls retain their role checks.

Consumes actual pending-maintenance gates, then returns verified authors and analysis/completion/source-snapshot SHAs. No network or models. Only the fixed full-conference call gets 3600 seconds/2 MiB; rendering uses shared role budgets and ordinary resources retain 30 seconds.

**`migrate-conference-process.js` — full operating conditions**

Explicitly migrates a conference process implementation fingerprint, rechecks completed pages, archives old completion receipts, and resumes unfinished papers without changing UUID/record format/original catalog values/attempts. `--concurrency 1 --postprocess-concurrency 5` keeps Reader serial while up to 5 offline workers stage completed papers/aggregates. Without the latter flag, original concurrency applies. `--reader-review-feedback ABS` maintains a full blog rejection set; another window uses `--reader-review-window ABS`.

CLI/library both reject incompatible options; ordinary migration rejects pending before grant installation. Completed analysis is not requested again. `--postprocess-only --preserve-failed-readers` is restricted preparation, incompatible with retry/grants. Additional paid recovery requires `--retry-failed --recovery-manifest ABSOLUTE_PATH`, at most 3 rounds per grant.

**`publish-conference.py` — full operating conditions**

Runs conference generate/review/push/status/verify against process receipts. Generation verifies/installs single/aggregate stages; a controlled same-batch image update needs exact old ownership/bytes, immutable backup, and CAS replacement, reusing new bytes already installed. Only generate accepts `--figure-crop-manifest ABS --figure-crop-base-sha SEMANTIC_SHA`; review/push replay its bound view.

Review uses text/multimodal/Markdown/Hugo, summaries first, default concurrency 5. Push checks actual index/commit blobs, publishes the image repository first, then blog. Verify rechecks pages/citation files/images. An already-published ID is not updated by repeated generation; deployment, titles, and actual browser display require separate checks.

### Historical pages, sources, and restricted legacy recovery

| File | Role and limits |
|---|---|
| `activate-fresh-publication.js` | Explicitly replaces an older publication after same-day rewritten results have been promoted. Holds this run's operation lock before Python archives old receipts; generates no content and does not push. |
| `arxiv-source-authority.js` | Plans or fetches official text for a canonical arXiv ID to manage source authority. Not a selector for direct rewriting or failed-fetch fallback batches. Dry-run is offline and writes nothing. |
| `historical-arxiv-batch.js` | Fallback only for named immutable arXiv fetch-failure handoffs supplied with `--handoffs NAME.json[,NAME.json...]`. Verifies frozen inventory, page SHA, and non-title links per page. Does not scan crosswalk pending pages, request models, or block the direct queue. |
| `historical-arxiv-publication-metadata.js` | Previews or seals official Atom publication sidecars for all arXiv papers in a direct-rewrite plan by default. Full conditions follow this table under the same filename. |
| `historical-conference-local-sources.js` | Read-only creates local conference source manifest v2. Requires absolute `--icml-poster-snapshot` and existing `--icml-pdf-root`; fresh PDF/receipt roots come from explicit parameters or central configuration. Does not access old pages/crosswalk/models/network/publication. |
| `historical-conference-page-projections.js` | Derives conference-paper-to-historical-page mappings from the specified local source catalog and inventory. Checks page SHAs but never uses old text for rewriting. |
| `historical-direct-aggregate.js` | Generates replayable private daily or conference summaries from completed direct-rewrite records. |
| `historical-direct-control.js` | Controls long historical tasks: `history:status` reads task registrations, pauses, locks, coverage, aggregates, and publication blockers once or continuously; `history:pause` saves a plan/acquisition-bound stop request; `history:resume` requires release of the operation lock. |
| `historical-direct-publication.js` | Runs one publication UUID through `plan → generate → review → publish → status`. Publication exclusively holds the shared blog lock and verifies remote `main` OID. |
| `historical-direct-review.py` | Coordinates semantic review of historical pages through the common text/multimodal model route. Saves input/model/prompt/code-bound checkpoints and issues a final receipt only after every page passes. |
| `historical-direct-rewrite-inputs.js` | Builds fixed-scope v5 inputs using unique arXiv hints, strict primary-scoring-row identity, full ICML poster identity with permitted local PDFs, a conference source manifest, and blog root. Does not require an additional arXiv source manifest. |
| `historical-direct-rewrite-plan.js` | Builds an original-source rewrite plan from the v5 catalog, inventory, and conference page mappings v3. Verifies primary arXiv/permitted ICML identity, rejects v4/v3 inputs, and reports uncovered old paper pages. |
| `historical-direct-rewrite-run.js` | Runs original-source analysis, Reader, and private single-page generation. Apply requires scheduler-ready records for the same plan/acquisition generation. Failed stages resume across processes through source-verified recovery files; those files are not generated pages. |
| `historical-direct-rewrite-scheduler.js` | Only prepares source queues and sealed files for direct arXiv/conference rewriting. Supports fixed members/limits, plan/acquisition locks, pause markers, safe signal stops, and item progress. Atomically saves arXiv TXT/PDF/runtime/manifest; failures create immutable crosswalk handoffs only. Runs no analysis, Reader, crosswalk, or publication. |
| `historical-direct-tag-supplement.js` | Creates immutable tag supplements/reports in the current workspace without changing blog pages or publication state. Required plan/catalog/blog/snapshot/run parameters are in [historical maintenance](../docs/history-rewrite.md#补充旧页面的标签和来源身份). |
| `historical-icml-alternate-pdf-source.js` | Seals only allowlisted ICML alternatives with fixed poster/forum/title/authors/source URLs. `--import-file` is restricted to `n1mAjfRDZ6`; re-extracts and matches title/authors/date/cross-page text and the fixed SSRN DOI. Browser import explicitly records non-network acquisition. |
| `historical-openreview-pdf-source.js` | Plans or seals a missing official PDF for an authenticated ICML/OpenReview forum. Dry-run is offline/read-only. Saves PDFs under the ICML root actually consumed by the local catalog; receipts are kept separately in runtime storage. |
| `historical-page-render.py` | Renders historical single-paper pages from verified inputs. Ordinary history uses tag assignments; direct rewrite uses saved analysis/sources. Reparses analysis rather than using old blog text. |
| `historical-source-identity-supplement.js` | Verifies all sealed sources and old pages without formal tags, producing an independent immutable identity supplement. Keeps conference identity/version disclosure; no models. Parameters are in the historical maintenance guide. |
| `historical-source-tag-assignment.js` | Classifies from original sources with per-request selection/review/decision checkpoints. The same UUID resumes only after input verification. Exhausted accounts produce a numbered partial record, without occupying the final result path. Parameters are in the historical maintenance guide. |
| `historical-tag-checkpoint-export.js` | Exports page tags and reports from verified classification checkpoints or partial runs, preserving original caches and requesting no model. Recovery/exclusion/new-run parameters are documented in the historical maintenance guide. |
| `historical_page_scan.py` | Scans historical pages without retaining their article text. New inventories record page identity, cohort date, each link target, unverified tags, the Git content tree, and remote main. Saved inventories are checked under their original rules. Checks the Git snapshot before and after scanning and before exclusive save. |
| `history-conflict-identity.js` | In one process, verifies official arXiv sources, records an explicitly selected existing conflicting hint as a verified decision, and writes by CAS. Does not read old text or titles. |
| `history-inventory.py` | Read-only inventories configured historical blog pages, URLs, and summary relationships. Dry-run writes nothing; apply creates immutable inventory/receipt pairs on clean main. |
| `history-resume.js` | Unified entry for current-plan pause recovery and restricted resumption of existing legacy source tasks. |
| `lib/arxiv-source-authority.js` | Fetches official arXiv text with the mandatory-proxy fetcher, separately saving request, source pairing, response record, full text, snapshot, receipt, and authority. Every save checks bytes and is immutable; resume verifies original requests/all source bytes and rejects old blog text. |
| `lib/fresh-rewrite-publication.js` | Backs up formal analysis and the blog baseline before rewriting. Replaces formal results only when the new result is complete and source/baseline content still matches. |
| `lib/fresh-rewrite-run.js` | Creates an independent rewrite run from allowlisted original metadata, prepares same-source files, restores only that run's analysis, and promotes formal data only after complete validation. |
| `lib/historical-archive-crawl-authority.js` | Rechecks saved archive identity records against their original arXiv IDs and input hashes. It does not issue new records or provide article text, figures, or analysis. |
| `lib/historical-arxiv-batch.js` | Fallback reads only named immutable handoffs from a new arXiv fetch failure. Verifies inventory/page SHA/non-title links, then records decisions only for listed pages while the original decision state still matches. Does not scan pending hints. |
| `lib/historical-arxiv-publication-metadata.js` | Seals publication-only Atom attachments per historical arXiv paper. On read, checks raw Atom, metadata/abstract SHA, exact `vN` query or unversioned observation window, original acquisition generation/manifest/snapshot. Does not modify the four source files. |
| `lib/historical-conference-crawl-authority.js` | Rechecks saved conference identity records against their original IDs, metadata, and PDFs, including local ICASSP and ICLR sources. It does not issue new records. |
| `lib/historical-conference-local-sources.js` | Creates `historical-conference-local-sources-v2`, combining retained conference metadata/PDFs and authenticated ICML poster-to-forum mappings. Reads existing roots and new runtime files only. Each new PDF requires a unique OpenReview/alternative receipt; records metadata/paper/acquisition/source SHAs and marks missing PDFs unavailable. |
| `lib/historical-conference-page-projections.js` | Checks frozen-page/metadata/PDF SHAs to map conference papers to historical pages. Page bytes are verified; old article text never becomes writing input. |
| `lib/historical-daily-primary-arxiv-binding.js` | Checks frozen Daily-page SHA and accepts a primary canonical `[arxiv]` link only from a unique valid scoring row. Saves byte ranges/row hash; citations in article text are not primary identity. |
| `lib/historical-direct-aggregate.js` | Rebuilds daily/conference/task private summaries without old text. Full conditions follow this table under the same filename. |
| `lib/historical-direct-control.js` | Manages immutable pause requests, safe resume, source checkpoints, and read-only progress/publication blockers by plan/acquisition generation. No models or blog modification. |
| `lib/historical-direct-page-staging.js` | Renders private historical pages from saved sources/analysis/Reader and checks input/manifest/page SHAs. Differently titled early preprints disclose non-camera-ready status first; fallback to an official old `vN` after current-PDF 404 discloses the unavailable current version. |
| `lib/historical-direct-publication.js` | Checks all private papers, aggregate mapping v3, aggregate files v2, explicit visual disposition, and a fixed blog baseline. Reuses passed pages by path/content SHA, reruns batch checks/Hugo, issues a receipt, and supports activation recovery, commit, and remote-OID verification. |
| `lib/historical-direct-rewrite-input-catalog.js` | Builds `merged-good-historical-local-data-v5` from unique frozen arXiv hints, strict scoring-row identity, ICML poster/permitted PDF identity, and local conference catalog. Identity evidence stores ranges/hashes, not old text for analysis. |
| `lib/historical-direct-rewrite-plan.js` | Builds a replayable source plan from the strict current catalog, inventory, and conference mappings, reporting uncovered pages and identity/scope counts under its SHA. The unique cross-title exception requires self-verifiable disclosure. Ordinary v5 source routes retain old byte shape for resumption. No models/network/crosswalk; frozen old pages only recheck identity and never enter writing input. |
| `lib/historical-direct-rewrite-runner.js` | Before direct rewriting, verifies scheduler-ready records for the same plan/generation and actual source bytes. Saves source-bound analysis checkpoints for cross-process recovery. Private pages require complete original-source analysis and Reader. |
| `lib/historical-direct-tag-supplement.js` | Read-only checks completed direct sources/analysis/private pages and extracts concept IDs/primary roles under the original classification version. Supplements bind old page/full-body SHAs, preserve old text/tags, list failures, and do not certify unfinished analyses. |
| `lib/historical-icml-alternate-pdf-source.js` | When OpenReview is blocked by a challenge page, permits only fixed allowlisted poster/forum/alternative URLs and checks title/ordered authors. `n1mAjfRDZ6` also permits SSRN browser import with title/authors/date/cross-page text and fixed DOI under a non-network receipt. Never claims OpenReview or camera-ready bytes. |
| `lib/historical-icml-poster-authority.js` | Authenticates the original ICML 2026 poster-to-forum snapshot and Daily-entry/summary identities with forum-named local PDFs. Old text never enters writing. |
| `lib/historical-local-crawl-authority.js` | Rechecks saved local crawl identity records and their original identity snapshots. It does not issue new records, use the network, or read article text. |
| `lib/historical-openreview-pdf-source.js` | Fetches a missing PDF for an authenticated poster/forum through project CONNECT with bounded manual redirects/streaming. Saves immutable atomic `0600` forum-named PDF and self-verifiable receipt. Resume checks authority/bytes before removing only known same-host dead-writer temporary hardlinks. An orphan PDF still requires refetch and byte comparison; partial files and unknown links remain errors. |
| `lib/historical-source-identity-supplement.js` | Checks sealed arXiv/conference identity and old page SHA. New outputs use v2/tagStatus; complete old outputs can be reused only after original digest/byte validation. Identity does not certify tags or article completion. |
| `lib/historical-source-tag-assignment.js` | For historical pages lacking valid formal tags, selects tags from numbered source excerpts, inserts exact quotations by program, then independently reviews. Uses the shared model route; distinguishes missing catalog coverage, pending review, and papers not reached before account exhaustion. |
| `lib/historical-tag-checkpoint-export.js` | Verifies classification checkpoints/partial runs, sources, quotations, and independent reviews, then exports tags subject to exclusions. Supports contiguous original ranges and processed-set concurrency; set mode reads only decision-named caches. |
| `lib/history-conflict-identity.js` | Retains legacy conflict resolution; current direct rewriting does not send `conflict/multiple` pages to the formal crosswalk. |
| `lib/legacy-history-run.js` | Read-only verifies old historical source/analysis SHAs and locates existing runs; creates no sources or scheduling tasks. |
| `lib/page-source-crosswalk.js` | Across runs, verifies inventory and compares decision-original state SHA under a lock before updating/adding decisions. Stores pageId/page SHA/publication authority; groups pages by paper identity and fixes sorting. Titles cannot establish verified identity. Finalize and every final-receipt read reverify sources. |
| `page-source-crosswalk.js` | Creates a separate crosswalk only from directly named inventory/receipt files and manages controlled decisions/CAS. Ordinary disk arXiv files do not grant publication authority; finalize requires every member verified and actual sources replayable. |


**`historical-arxiv-publication-metadata.js` — full operating conditions**

Previews or seals official Atom publication sidecars for all arXiv papers in a direct-rewrite plan by default. Reuses only Atom compatible with source version/time; otherwise uses exact IDs through common CONNECT.

No models. Transient failures get at most 3 attempts per paper; exhausted papers remain failed while the batch continues, ending partial/nonzero. No sidecar is created for failures; resume fills only missing items.

**`lib/historical-direct-aggregate.js` — full operating conditions**

Rebuilds daily/conference/task private summaries without old text. Mapping v3 uses frozen links for task members; pages without rewritten members are `retain-unchanged`, and full coverage is checked.

`reader-facing-v3` counts primary tasks only, retaining bilingual links, eight scores, tiers/type/arXiv/authors/resources. An old arXiv `vN` shows current-version-unavailable disclosure and the actual official link in both rank and entry.

### Reader writing, candidates, and recovery

| File | Role and limits |
|---|---|
| `lib/reader-next-request-plan.js` | From the actual normal Reader candidate/issues/original budget, records the next full/local route. Diagnostics are neither final preflight nor request authority. Explicit local-only scope restricts capability; all counts and later checks remain. |
| `lib/reader-candidate-transactions.js` | Tracks pending-to-save Reader articles in memory and carries that relation when results are copied. Does not load the analyzer, read/write files, or alter logs; actual save confirmation and candidate retirement remain the analyzer's job. |
| `lib/reader-candidate-normalization.js` | Before ordinary patches, persists deterministic draft normalization by actual active-envelope CAS, with immutable parent/normalization archives. Defers writeback while a patch capability is active; save failure stops dispatch. No attempt or cost changes. |
| `lib/reader-compatible-candidate-replay.js` | Uses a real migration chain or the last paid request/response and exact production replay to uniquely resolve same-input candidates. Does not select by modification time or change counts/costs; lack of proof still rejects. |
| `lib/reader-concept-term-display.js` | Verifies complete term/explanation display identity. Supports bounded small Chinese/Arabic count equivalence such as 二次/2 次 and 六维/6 维 under the same formatting rules. Protects code, English words, and complete number boundaries; rejects missing terms, different numbers, and equivalent duplicate terms. Python uses the same rule. |
| `lib/reader-contract.js` | Defines Reader format, builds evidence-specific instructions, and checks near-duplicate content across sections. |
| `lib/reader-draft-order.js` | Reorders one draft's sections while synchronizing table bindings/markers and recording original/reordered path SHAs. Rejects ambiguous ordering. |
| `lib/reader-historical-draft-normalizer-replay.js` | Verifies the request-bound historical Git program, all dependency blobs, and the pure-function dependency proof, then exactly replays paid failed-draft provenance. New proofs identify the Markdown functions and dependencies used in replay. The verifier reads earlier proofs in their recorded format. Replay establishes the origin of the paid draft. |
| `lib/reader-historical-markdown-closure.js` | Extracts exactly 6 header regexes and 7 pure functions with fixed declaration SHAs from the original Git analysis-contract blob, preserving byte ranges/hashes. Loads them without `require`, avoiding old Manual/production dependencies. |
| `lib/reader-paid-resolved-render.js` | Under normal paper locks, verifies paid-draft/current-article correspondence and rerenders. A separate offline table rerender is restricted to the current unique signed single revision, checking dispatch/parent seed/feedback/usage and fixed old replay. Preserves costs, figures, outside-table text, and other stages, with original files/code rechecked before save. |
| `lib/reader-paid-resolved-replay-worker.js` | Offline private subprocess, without production credentials, runs a fixed old renderer to prove an original response recreates current article/plan bytes. Does not accept direct publication tasks. |
| `lib/reader-paid-response-replay.js` | Explicitly replays original paid responses damaged by an old program transformation. Formal usage must bind original output SHA; real later repair request/response must link precisely to the candidate. Preserves attempts/failures and requires full normal parsing/source/fact checks before saving. Not a general response-import entry. |
| `lib/reader-parent-recovery.js` | Plans cumulatively bounded repairs for paid failed drafts, checking each parent's draft/cost/receipt. Public diagnostic preparation allows only implementation changes, preserves the ledger, and grants no requests automatically. |
| `lib/reader-transport-continuation.js` | Registers one 48k-token transport supplement for the first explicit window's unique paired ECONNRESET, unchanged input, and no returned text. Full conditions follow this table under the same filename. |
| `lib/reader-parent-upstream-preflight.js` | Within the real daily paper lock, sealed sources, and original upstream-feedback context, rechecks normal analysis, resource scan, and seven textual-stage fingerprints on a copy. Invalid upstream returns to parent-stage recovery; does not change records, success, or requests. |
| `lib/reader-scientific-quote-coverage.js` | Shared cell-level scientific-number coverage for generation and saved-draft replay. Full conditions follow this table under the same filename. |
| `lib/reader-fact-pre-request-recovery.js` | For actual zero-request configuration failures, verifies the complete signed parent, same unfinished feedback, and usage history. A private scope maps one short excerpt to its unique full original sentence; retains failures/budget and does not restore old formal files. |
| `lib/reader-derived-parent-replay.js` | After actual payment/Git/parent verification by the caller, compares derived source quotations. Only complete-source-table correction slots may compare the original table to the normal reduced view. Does not generate parents, publication eligibility, or model budgets. |
| `lib/reader-pre-image-check.js` | Before image download, reads exhausted failed drafts whose current text/source-table checks still fail. New authorization, remaining attempts, or current acceptance continue normal image download and full checks; old pixel evidence is not reused. |
| `lib/reader-proof-read-scope.js` | Reuses unchanged proof-file reads only during one recovery-preparation scope, checking file state each time and clearing on exit. The full recovery chain is still verified. |
| `lib/reader-recovery-revision.js` | Explicitly migrates same-source failed-candidate diagnostics, preserving payment counts, ordinal adjustments, old no-progress state, and archived bytes. Table-count wording cannot trigger text normalization; produces no success receipt. |
| `lib/reader-target-ordinal-patch.js` | Implements ordinary existing-node context commitments, short ordinal replies, strict SHA patch compilation, normal cost sealing, and saved replay. Daily replay reconstructs the actual authenticated synchronous source context, retaining PDF table/footnote proofs. Initially Responses-only; other protocols keep their route. Grants neither budget nor completion. |
| `lib/reader-pdf-selection-replay-cli.js` | Private read-only FD bridge for Python publication to rerun normal table row/column selection offline. Full DOM/PDF/cell-display evidence still requires real source scope; returns no write or source capability. |
| `lib/reader-repair.js` | Saves failed Reader drafts, checks permitted-node SHAs, and applies verified local patches. Full conditions follow this table under the same filename. |
| `lib/reader-malformed-previous-draft-view.js` | Only when an old response is invalid JSON and the next normal full prompt exceeds context, creates sending diagnostics retaining original SHA/parse error/literal excerpts. Full response and sources stay saved; valid drafts and local patches are not trimmed. No budget increase. |
| `lib/reader-fact-table-claim-location.js` | Explicitly binds original feedback/parent/paid candidate/four sources and misplaced/retained positions to correct one full-table claim's erroneous global exclusion. Only zero-request replay of the paid draft, through normal parse/finalize/publication replay; obligations/counts/costs remain. |
| `lib/reader-request-diagnostics.js` | Before paid Reader repair, saves the actual draft, exact SHA, permitted targets, and prompt, then original response/request SHAs. Explicit paid-version correction also binds source origin, normal costs, and a fixed completion index. Immutable per-attempt records; save failure stops; grants no text/publication eligibility. |
| `lib/reader-saved-feedback-input-continuity.js` | Reconstructs actual original paid input when the same parent/child fact package's merged display changes. Preserves every current fact constraint, original draft, costs, and counts; grants no allowance. |
| `lib/reader-unsent-empty-candidate.js` | Accepts an empty candidate only when an explicit pre-transport-block receipt proves zero content. Preserves original bytes and transport failures, then returns to normal same-input migration. Does not replace multi-candidate paid-origin proof, restore success, or add budget. |


**`lib/reader-transport-continuation.js` — full operating conditions**

Registers one 48k-token transport supplement for the first explicit window's unique paired ECONNRESET, unchanged input, and no returned text. Preserves the original 80k ledger/content counts/unknown costs.

Original unused 32k remains for normal local repairs; total physical requests stay at most 6. A consumed supplement's paid full draft anchors normal implementation migration without restoring pre-installation state.

**`lib/reader-scientific-quote-coverage.js` — full operating conditions**

Shared cell-level scientific-number coverage for generation and saved-draft replay. Old full-line quotations keep original rules; the special three-stage daily learning-rate table additionally requires actual PDF glyph authority for every role.

Only a temporary numeric view is derived; drafts/quotes/other cells/tokenization/source permissions remain unchanged. Missing or wrong values remain normal failures.

**`lib/reader-repair.js` — full operating conditions**

Saves failed Reader drafts, checks permitted-node SHAs, and applies verified local patches. Table-count estimates are advisory; valid original selections enter only matching repair feedback, not input identity. Added tables still need source selection or exact full quotations, and final parsing remains complete.

Strict kind/heading/body-only overlong drafts may use same-kind contiguous grouping while preserving all original content/bindings/path SHAs. A unique known continuation field may use v2 original-field references preserving all segments/empty strings; unknown fields retain full reorder. Requests share original allowance.

### Reader authors, figures, tables, and source bindings

| File | Role and limits |
|---|---|
| `lib/pdf-layout.js` | Calls the PDF layout worker for cell and figure/table evidence. |
| `lib/reader-author-parser.js` | Reparses authors from full original HTML, structured output, and text SHA, or conference PDF superscripts. Explicit v2 admits only source-supported affiliation continuation lines; new Reader records store that version, while absent-version identities/publication retain v1. Without original text, uses metadata names and explicitly unavailable affiliations. Loads no configuration and calls no model. |
| `lib/reader-author-replay-cli.js` | Private local author-verification FD entry for Python. Retains single-object protocol; bounded batches permit 8 items/32 MiB, rereading real four-source files and parent proofs per item, returning true only if all match. No network/models. |
| `lib/reader-pdf-extraction-scope.js` | Shares pure PDF extraction/output reuse across one Reader verification. Daily sources keep the minimal environment; verified conference/history PDFs retain the inherited environment. Unknown startup overrides or disabled venv fall back to normal extraction. Checks role/private input/isolated runtime live; caches no source or eligibility verdict. |
| `lib/reader-authenticated-pdf-footnote-evidence.js` | Derives and replays same-column author declarations, superscripts, and same-number URLs within real conference/history PDF authority. Adapter revalidation and saved reads keep the original plan/source scope; ownership and reachability remain separate. Old identities yield only independent correction proposals, not automatic edits or scoring/Reader qualification. |
| `lib/reader-author-source.js` | Current author-source eligibility for production Reader. Before skipping completed analysis, restoring historical/conference tasks, or publishing, reparses and verifies real original authors; retains old successful structures and read-only statistics. |
| `lib/reader-dom-span-projection.js` | Replays complete-width `colspan` classification-row blank views from actual sealed HTML, aligning normal table compilation with final cell checks. Preserves sources, old display bytes, and PDF rules. |
| `lib/reader-dom-span-replay-cli.js` | Private read-only FD subprocess for Python to replay complete-width HTML classification-row blanks. Checks daily role, four sources, table SHA, and actual article coordinates before shared DOM rules; no models/network. |
| `lib/reader-failed-bundle-resource-replay.js` | In ordinary source-mode recovery, reads only the same-source failed resource bundle referenced by current upstream proof, verifying literal statements/ownership/status. Does not mix old signed Reader resources or grant requests. |
| `lib/reader-inline-svg.js` | Verifies official inline SVG original bytes/source location and invokes a controlled renderer for this call's image. |
| `lib/reader-pdf-cell-evidence.js` | Binds PDF table cells to source evidence across workers. |
| `lib/reader-resource-binding.js` | Extracts/normalizes GitHub/GitLab/Hugging Face/ModelScope links, retaining original URL, exact source excerpt, and resource type, including line-wrapped URLs. |
| `lib/reader-resource-claims-replay-cli.js` | Before Python publication, replays resource claims against sealed full text and checks the actual Reader for placeholder result tables using the shared semantics. Uses private descriptors; networking is forbidden. |
| `lib/reader-resource-input-admission.js` | For actual resource-state changes, exactly replays original request/paid response/cost/failed draft plus full parent stages/sealed sources. Admits only one new input in the same-source Reader scope with fixed normal 6/2 allowance; does not migrate old drafts/counts. Metadata-only changes do not reopen it. |
| `lib/reader-resource-prose.js` | Converts verified resource identity into natural-language input, retaining author versus third-party ownership. |
| `lib/reader-resource-sync.js` | Synchronizes sealed resource state into formal/parsed/last-checkpoint/proof records, preserving scoring/Reader bytes. When preserving upstream, validates the actual returned paper Reader; an unsaved hypothetical analysis view grants no operator scope. If score-relevant availability changes, rejects and requires normal scoring audit. Offline and no file writes. |
| `lib/reader-sealed-figure-alias.js` | Within a real daily sealed-source synchronous scope, checks aliases when an unselected figure number refers to the same asset. Preserves all original evidence, and selected figures still deduplicate. Rereads four sources/input before return; grants neither budget nor whole-paper success. |
| `lib/reader-sealed-pdf-column-units.js` | Precisely binds and replays column-unit evidence from a sealed PDF table. |
| `reader_sealed_pdf_literal_column_units.py` | Independent unit evidence for complete actual daily PDF tables. Full conditions follow this table under the same filename. |
| `reader_grouped_vector_column_units.py` | Publication replay of complete preference-vector-table column units, after the caller verifies four sources and actual PDF quotes. Retains two-level column paths, all rows, and merged mean-difference cells. |
| `lib/reader-authenticated-pdf-table-evidence.js` | Shared private conference/history PDF authority derives unique original-table quotations and strict row/column unit evidence for normal `source_quotes`. Generation/recovery/saved replay use the same code, without fabricating DOM or loosening completed-old-paper publication admission. |
| `lib/reader-source-table-column-units.js` | Within verified sealed sources, checks percent units against original DOM rows/columns. Merged headers additionally require complete span coverage, a unique metric path, and an explicit original caption. Values/units/sources are unchanged; saved recovery and publication replay the same rules. |
| `lib/reader-sealed-pdf-quote-evidence.js` | Binds/replays literal sealed-PDF quotations. In actual source scope, the full three-stage learning-rate quotation receives temporary glyph authority; existing quotation evidence remains unchanged. |
| `lib/reader-sealed-pdf-table-evidence.js` | Binds and replays sealed-PDF table structure/cell evidence. |
| `lib/reader-source-blocked-normalization.js` | For a full-table source blocker, reruns the unique ordering transformation, verifying original/prepared draft SHAs and retaining bindings and content-bearing diagnostics. Paid replay must first match saved original bytes; no success or budget authority. |
| `lib/reader-source-diagnostics.js` | Read-only locates number/unit source mismatches by displayed cell and original row/column, suggesting percent/thousands-separator/possible-rounding repairs. Does not change values or weaken source checks. |
| `lib/reader-source-display.js` | Shared source-cell display normalization: combines only explicit TeX annotations with exactly matching visible duplicates. Bare duplicated numbers remain unchanged; Reader and publication reuse it. |
| `lib/source-cell-math-display.js` | Narrow math-display evidence from the original DOM cell: removes duplicate presentation only when the complete visible copy and supported TeX agree in numbers, signs, and precision. Preserves source bytes/SHA and supports table compilation, saved qualification, and Python publication cross-checks. |
| `lib/reader-source-metric-units.js` | For an event metric explicitly defined by edit distance without a source-table percent sign, accepts only literal values from that same original column. Does not convert percentages, alter values, or exempt other metrics. |
| `lib/reader-table-narrative-labels.js` | Checks table narrative labels against source labels. |
| `lib/reader-table-pdf-evidence.js` | Separates old PDF rules from independent new PDF evidence. Normal compilation and saved checks reread controlled sources, keeping DOM and PDF display evidence distinct. |
| `lib/reader-tables.js` | Expands TABLE markers and original row/column selections into Markdown with cell-source records, retaining header mapping and rejecting misalignment/out-of-bounds indices. |
| `pdf-layout-extract.py` | Extracts PDF layout, text positions, and cell evidence from controlled PDFs. |
| `reader_inline_svg.py` | Validates inline SVG elements/attributes/local references and renders PNG with script/network disabled, shared by reading and publication. |
| `reader_inline_svg_pixel_replay.py` | After current SVG safety checks, replays renderers only from trusted Git history of current HEAD. Generated pixels must exactly match the original model-pixel SHA before normal staging. |
| `reader_pdf_page_asset.py` | Only when a sealed SVG lacks drawing dependencies or has cyclic ones, derives a whole original PDF page by the unique figure number/full caption within the same daily sources. Keeps old Reader pixel SHA and separate source proof for generation/review/push. |
| `reader_damaged_raster_pdf_asset.py` | Restricted explicit single-target damaged-PNG publication recovery. Replays the official-response SHA, truncated-IDAT receipt, four sources, unique full PDF caption, and printed number to derive disclosed full-page pixels. Does not alter original Reader/sources or relax strict decoding. |
| `reader_pdf_cell_evidence.py` | Extracts and checks cells from controlled PDFs. |
| `reader_pdf_visual_audit_cache.py` | Bounded cache of successful pure visual extraction by the old PDF backend. Every use checks actual PDF and complete implementation bytes and returns an independent copy. Original validators still replay four sources/current bindings/cell-number qualification every time. |
| `reader_sealed_pdf_column_units.py` | Verifies controlled-PDF original column-unit evidence for Node and publication replay. |
| `reader_sealed_pdf_quote_evidence.py` | Verifies exact PDF quotations. A separate read-only operation checks the three-stage learning-rate superscript glyphs, full quotation, and bounded neighboring attribution; old operation output stays unchanged. |
| `reader_authenticated_pdf_hierarchical_table.py` | Reconstructs the complete actual PDF table's glyphs, column groups, original rows, and condition bands before uniquely mapping a displayed subset. Does not guess units or fabricate HTML DOM. |
| `reader_authenticated_pdf_footnote_evidence.py` | Independently extracts same-page/same-column author resource declarations, attached superscripts, and the unique matching-number URL. Rejects future, negated, third-party, or ambiguous ownership. |
| `reader_sealed_pdf_table_evidence.py` | Checks controlled-PDF original table structure and cells for Node/publication replay. |


**`reader_sealed_pdf_literal_column_units.py` — full operating conditions**

Independent unit evidence for complete actual daily PDF tables. Preserves method/condition bands, two-level headers, cumulative settings, component/parameter axes, and all original cells.

Its restricted table shapes also verify front-end/attack identities, budgets, leakage durations, input axes, and original change notes. Math glyphs, uncertainty, magnitude, and underscores require physical table evidence, not HTML display equivalence.

### Signed drafts and bounded operator corrections

| File | Role and limits |
|---|---|
| `lib/daily-reader-operator-correction.js` | Explicit daily operator manifests cover the complete failure set, normally at most 10 papers; larger batches use floor(10% of the reread original selection), capped at 15, with full unique-member checking. Full conditions follow this table under the same filename. |
| `lib/reader-operator-patch.js` | Explicit local operator patches within the same fresh rewrite run verify sources, original field/array-item SHAs, and complete Reader parsing. Save only a failed candidate, preserving budget/immutable original archives/replay records, and never issue successful-article evidence. |
| `lib/reader-signed-draft.js` | Inverse Reader representation for signed daily sealed sources, retaining fresh-source admission and exact article/plan/figure round-trip SHAs. No writes or models. |
| `lib/reader-signed-draft-surface.js` | Pure inverse representation reconstructing full term combinations and original figure references. Grants no sources/API authorship/edit scope/publication eligibility. |
| `lib/conference-reader-signed-draft.js` | Verifies a complete real conference parent and plan/PDF before inverse Reader reconstruction. Reports exact round-trip, formatting-only differences, and blockers with per-node differences; recoverable does not mean passed. |
| `lib/daily-reader-signed-correction.js` | Explicit completed-daily correction: v1 bounded Chinese terms; v2 only exact ranges inside source-bound rejected claims. Full conditions follow this table under the same filename. |
| `lib/daily-reader-signed-fact-patch.js` | Pure v2 range checks bind rejected literal claims, UTF-16 offsets, and original-node SHAs for 1–8 existing text/explanation/same-source-table nodes. Raw/display differences require actual normal formatting; no edits outside claims, to formulas/original figures, or new nodes. Normal parsing still authenticates sources. |
| `lib/daily-reader-legacy-batch-root.js` | Read-only verifies a legacy daily batch's operator root using the actual failed parent checkpoint, original authorization/manifest, paid candidate, and patches, exactly replayed to current signed Reader. Retains operator identity/four sources/costs/counts; invents no completed API parent and changes no active-candidate state. |
| `lib/reader-signed-raw-claim-display.js` | Maps one unique raw claim at its actual offset through common numeric diagnostics/normal formatting. Replays full-node position markers; rejects borrowing number evidence from another sentence, quotation, or code. |
| `lib/reader-signed-pruned-table-claim.js` | After real paid-origin/operator-history replay, verifies the unique same-order table before/after normal source-row trimming. Only whole-parent/original-node-SHA-bound, full-DOM cell recovery is supported; ordinary claims/unauthenticated callers gain no scope. |
| `lib/reader-signed-table-targets.js` | Locates true table order across inline tables and TABLE markers. Old placeholders must replay to signed parent tables; approved targets use normal compilation or strict same-DOM cell/row/column mapping. No mixing, guessing, or adding/removing tables. |
| `lib/reader-signed-operator.js` | Explicitly revises a verified Reader in the same run after checking full parent/article/plan/source SHAs. Reconstructs/parses/normally seals, checking immutable preparation records on recovery with edit/parent/run/source/expected-output SHAs. Writes isolated analysis only and requires fact review; no API calls. |
| `lib/signed-reader-recovery-draft.js` | Reconstructs a verified signed article as a local-edit draft, preserving sections, terms, and formula/table/figure relations. Rejects untraceable article text. |


**`lib/daily-reader-operator-correction.js` — full operating conditions**

Explicit daily operator manifests cover the complete failure set, normally at most 10 papers; larger batches use floor(10% of the reread original selection), capped at 15, with full unique-member checking.

Rereads four sources/failed drafts/1–8 existing-node SHA patches. Original candidate/cost stays unchanged; normal complete parsing validates and records local provenance, never model output or added allowance.

**`lib/daily-reader-signed-correction.js` — full operating conditions**

Explicit completed-daily correction: v1 bounded Chinese terms; v2 only exact ranges inside source-bound rejected claims. Replays original retired paid drafts/all real operator history to current article/plan/figures, binds whole-parent CAS/four sources/the complete small remainder, and preserves counts/pixels.

Normal parsing/engine save remain required. Preview registers no obligation; apply saves pending. No candidate reactivation or requests.

### Tags and hierarchical presentation

| File | Role and limits |
|---|---|
| `build-tag-preview.py` | Creates private tag indices, legacy tag-disposition tables, and review reports from historical metadata without modifying the blog. Matches names/aliases literally; seven dispositions/evidence requirements are in the [tag design](../docs/tag-system-design.md#53-旧名称处置). |
| `lib/page-tag-metadata.js` | Parses YAML front matter, recognizes old/new tag fields, and rejects mixed formats or duplicate keys. Only actual top-level fields count, not descriptions or body text. |
| `lib/tag-catalog-change.js` | Compares catalogs as `none/additive/destructive`, reads archives by original byte SHA, and verifies `registryUpgradeFrom`. Strict append-only compatibility also preserves the entire old facet/concept prefix field-for-field and only replays old classification read-only; never re-signs. |
| `lib/tag-catalog.js` | `loadTagCatalog` loads the catalog and `validateTagCatalog` validates fields/hierarchy; resolves explicit aliases and queries ancestors/descendants. Node/Python/publication use original file-byte SHA. |
| `lib/tag-record-update.js` | Updates or verifies tag-stage records while keeping selected concept IDs identical. Rejects unprovable changes with reasons. May inventory old records read-only; no models. |
| `lib/tag-rules.js` | `createTagRules` builds rules, `getDefaultTagRules` reuses defaults, and `buildTagPromptText` builds prompt text; default selection is `paper-tag-selection-v2`, and saved old stages use their recorded version. Can generate old verification text explicitly. |
| `lib/tag-stage-record.js` | Read-only recognizes old/new tag-stage formats, returning original stage and actual field names. Rejects mixing; does not rewrite/re-sign. |
| `tag-check-inventory.js` | Read-only inventories conference/daily/history classifications by catalog SHA, reporting counts, examples, and differences. Not publication eligibility. Explicit `--executions/--deep/--assignments/--registry` select paths; see `--help`. |
| `tag-record-update.js` | Controlled maintenance of original conference tags without Reader/scoring/LLM reruns. Default preview; `--apply` verifies SHA/original classification before writing; `--classify` compares read-only; `--archive-snapshot` immutably saves original bytes. Append-only display upgrades should replay read-only instead of re-signing. See `--help` for allowlists/parameters. |
| `tag-tools.js` | Validates catalogs and serves a loopback static preview with only four read-only routes. No local assistant or formal-data migration. |
| `tag_catalog.py` | Shares the catalog with Node, parsing current or explicit old tags to exact concepts. New formal pages require valid Chinese preferred labels and the established English-name exceptions. Unknown/ambiguous labels fail; meanings are not silently narrowed. |
| `tag_catalog_publication.py` | Read-only conference/history site-catalog gate: reconstructs complete snapshots from original file SHA and verifies data/static presentation assets, version directories, and this batch's archives. Missing/inconsistent files block; no site writes or re-signing. |
| `tag_presentation.py` | Shared hierarchical display for all three workflows: only selected concepts and ancestor navigation, skipping empty facets and never adding ancestors/siblings as direct tags. |
| `tag_paths.py` | Central tag-catalog/private-preview paths; chooses blog path from explicit parameters, environment, then defaults. Existence/repository identity remain the caller's responsibility. |
| `tag_stage_record.py` | Read-only recognizes old/new saved tag formats and returns original stage/checkpoint/actual field names. A readable format does not prove hashes or publication qualification. |

### Prompts and original-version evidence

| File | Role and limits |
|---|---|
| `lib/filter-prompt.js` | Shared daily/conference filter rendering with explicitly frozen template paths/source fields, retaining original request text/SHA. |
| `lib/prompt-history.js` | Reads and verifies original Git prompt bytes against the saved whole-file or first-code-fence SHA. In the default Git evidence route, an unregistered SHA returns `null`; a registered original Git object that is missing or has mismatched bytes stops verification. Current text cannot impersonate an old template. |
| `lib/prompt-evidence.js` | Controlled reading of current prompts or indexed Git blobs, strictly verifying original path/OID/whole-file and optional declared SHA. Does not write old prompt text. |
| `lib/git-prompt-evidence-index.json` | Read-only metadata containing original historical prompt paths, Git blob OIDs, and whole-file SHAs, not their text. |
| `lib/prompt-rendering-contract.js` | Identifies inputs altered by old prompt substitutions and invalidates only affected stages. Normal inputs retain fingerprints/recovery records. |
| `lib/prompt-contracts.js` | Registers current text paths/version identities for each stage and provides the current template paths. Saved old declarations select their original paths through Git evidence; absent versions use v1 identity, unknown versions fail. |
| `prompt_evidence.py` | Python strictly reads original historical prompt objects from local Git; current templates must come from the working tree. |
| `local_git_object.py` | Internal bounded fixed-Git reader for one local commit/tree/blob: checks type/size/raw bytes/OID, forbids lazy fetching and object replacement, and changes no objects/index/refs. Ordinary results do not prove complete trees/deletions/deltas/publication. |
| `local_git_commit_delta.py` | Internal complete-directory/single-parent commit comparison against an explicit baseline, including required bytes/deletions/exact paths. Uses fixed offline reads within one call; unreviewed bodies/full object graph remain unchecked. Ordinary output grants no review/worktree/publication authority. |
| `local_git_publication.py` | Internal fixed offline checks for HEAD directly naming main, exact commit, unique effective push-address identity, and ref-control files. Combined checking verifies full deltas in the same real read scope; no remote access, imported proof handles, or publication authority. |

### Page generation, review, and publication

| File | Role and limits |
|---|---|
| `blog_entry_loader.py` | Fixed-path Python loader for the hyphenated `publish-to-blog.py` module. |
| `daily_hugo_capture.py` | Preserves input observations, machine mappings, and primary HTML from the same normal daily-review Hugo run in immutable records referenced/replayed by a new receipt. Does not establish a full input snapshot, scientific qualification, or successful deployment; see [observation limits](../docs/three-workflows.md#日更审查的同次-html-观察记录). |
| `daily_html_projection.py` | Pure limited static-HTML parser. Fixed v1 retains no-whitespace formulas; fixed v2 also permits isolated internal single spaces. Preserves word boundaries/code/formula literals without interpreting TeX, executing HTML, or fetching resources. Results grant no source/publication authority. |
| `github_pages_deployment.py` | Bounded mechanical observation of controlled GitHub repository workflow/run-attempt/job/deployment metadata through fixed anonymous HTTPS, rechecking newer records. Webpages/public assets/artifact consumption remain unverified; no publication/source eligibility. |
| `daily_deployment_store.py` | Immutably stores daily deployment observation intents/input bindings/results; a short lock and complete-record scan maintain latest navigation. New pending/failed observations cannot be hidden by old success. Stored data grants no normal-review authority. |
| `daily_observed_projection.py` | Daily observation entry: existing three date/explicit-paper readers verify normal receipts and saved HTML/targets/local publication. Full conditions follow this table under the same filename. |
| `blog_repository_lock.py` | Shared blog lock keyed by Git common-dir across workspaces. Reclaim/release checks PID/hostname/token/lease/inode/SHA; does not alter blog Git content. |
| `generate-blog.py` | Generates and installs Hugo Markdown only. |
| `lib/paper-page-staging.js` | Private page-worker input, timeout, implementation-fingerprint, and staged-file verification shared by all three workflows. |
| `lib/publication-file-primitives.js` | Shared strict file/JSON/immutable-write/readback-SHA primitives. |
| `lib/publication-git-process.js` | Bounded synchronous Git execution for historical publication/shared file utilities. Adapters retain their original environment/return types/transactions. Deadline or truncation is not an ordinary nonzero exit and does not add push attempts. |
| `markdown_hugo_gate.py` | Shared Markdown/front-matter/formula/image checks and actual Hugo rendering gate. |
| `paper_reader_presentation.py` | Shared daily/conference/history parsing of detailed summaries, resources, score explanations/eight score dimensions, and adjacent duplicate bold headings. Detailed summaries still replay actual stages; original plan/saved identities must correspond. Source filters/page frames remain intact. |
| `lib/reader-aggregate-presentation.js` | Bounded aggregate presentation bridge for conference/history, at most 8 papers per call, using the existing Python bridge and shared summary/resource/scoring/eight-dimension formatting. Returns display text only; original entries still verify sources/full membership/publication. |
| `lib/scoring-stability.js`, `scoring_stability.py` | Strict score-stability criteria shared by Node recovery/final qualification and Python conference pages. Fixed vectors cross-check languages; reads original proof without granting requests or changing counts. |
| `lib/scoring-audit-consensus.js` | Shared audit scheduling for normal analysis and scoring maintenance: disagreement between the first two permits one additional independent audit, selecting the closest pair under original tolerance, preserving actual attempts/source checks. |
| `publication_activation.py` | Verifies old commit/blog baseline/live remote and archives six exact state files. Pending blocks all three publication stages. Supports interruption recovery without changing promoted paper analysis. |
| `publish-to-blog.py` | Shared page templates/tag compatibility/Git transactions/batch receipts/publication proof. Full conditions follow this table under the same filename. |
| `publish_common.py` | Common publication data, score, Manual/API-source, and model-review rules. |
| `push-blog.py` | Verifies the receipt, commits/pushes only its allowed changes, verifies remote OID, and then plans visual task records. Planning alone does not generate images. |
| `review-blog.py` | Read-only reviews final batch pages with program checks, model text review, figure review, and Hugo; issues a receipt only after success. |


**`daily_observed_projection.py` — full operating conditions**

Daily observation entry: existing three date/explicit-paper readers verify normal receipts and saved HTML/targets/local publication. Explicit `observe_daily_deployment()` reads fixed public metadata between two full local observations, running four normal validations total and saving independent history; `read_daily_deployment_observation()` only reads that history.

A saved record is not deployment/final acceptance. Does not rebuild/re-sign old receipts or grant current scientific qualification. Its fixed new storage paths normally change the review-protocol fingerprint.

**`publish-to-blog.py` — full operating conditions**

Shared page templates/tag compatibility/Git transactions/batch receipts/publication proof. `researcher-workbench-v1` defines metadata/citations/rethink sidecars.

Independent manual v4 separates semantic articles from `machineAssets`, while the final receipt covers the complete manifest. Passed pages persist by path/content SHA and are not re-reviewed unchanged; rejected unchanged content is reconsidered only when both complete legal old/new review-protocol SHAs differ.

### Publication completion and historical generated images

| File | Role and limits |
|---|---|
| `lib/published-blog-receipt.js` | Checks formal snapshots, per-paper source/article bindings, saved review receipts, and recorded remote commits. Deployment and live pages require separate verification. |
| `lib/post-publication-policy.js` | Shared no-generation record validation. New records bind the actual review file; historical records still bind their original task manifests. |
| `lib/historical-visual-records.js`, `lib/historical-cover-records.js` | Read-only checks of retired generated images: original prompts, sources, task identities, actual PNG files, and hashes. Creates no tasks, fetches no figures, and writes no assets. |
| `waive-post-publish-visuals.js` | Verifies formal publication evidence, then directly records that this daily batch generates no images. Original-paper figure review remains required. |

### Environment, files, logs, and validation

| File | Role and limits |
|---|---|
| `config.js` | Central Node configuration and runtime paths. |
| `daily_republication.py` | Explicit presentation-only republication of a complete already-published daily batch via `blog:generate -- --date DATE --republish UUID`. Full conditions follow this table under the same filename. |
| `source-probe.js` | `npm run source:probe -- --date YYYY-MM-DD` read-only probes arXiv Atom/official OAI/RSS and checks target-day announcement identity. Supports `--json`; no candidate fetching or data/current writes. |
| `llm-accounts-report.js` | `npm run llm:accounts` distinguishes current primary/secondary configuration from historical observations, reporting existing cooldown only. Does not probe balances or clear state. Shows per-invocation numbers, not keys/stable fingerprints; supports `--json`. |
| `config-check.js` | `npm run config:check` read-only checks `.env` required fields/types/ranges/unregistered variables. No writes or key echoing; supports `--json`. |
| `recover.js` | `npm run recover -- --date YYYY-MM-DD` collects saved failures/fact obligations/review findings and suggests existing entries by error code; read-only by default. Record completeness is distinct from real sources/full failure scope/recovery authority. `--execute --yes` still uses original entry checks; see [recovery tools](../docs/maintenance.md#恢复决策与清单生成). |
| `manifest-new.js` | `npm run manifest:new -- --spec SPEC.json` prepares 1–8-existing-node correction records/manifests and computes SHAs/UUIDs. Default dry-run; `--write` writes `data/runtime` only. Formal adoption independently rechecks full current input/paid origin/real sources/whole-paper quality; see [preparation scope](../docs/maintenance.md#恢复决策与清单生成). |
| `table-check.js` | `npm run table:check -- --draft DRAFT.json` offline checks duplicated joined numbers/column counts/unit declarations without writing data. |
| `impact.js` | `npm run impact -- <file-or-dir>` statically lists affected entries/tests/revalidation scope. |
| `verify-web.js` | `npm run verify:web -- --date DATE [--deploy OID]` checks batch summary/single-page HTTP 200, narrowly normalized final URLs, and limited title conditions; writes data/current/web-verification-<date>.json. Full conditions follow this table under the same filename. |
| `publish-finish.js` | `npm run publish:finish -- --date DATE` prints formal-state/web/current-publication-waiver completion steps. Missing waiver guidance rebuilds planning records then waives; it does not suggest image preparation, auto-register, or call an image API. |
| `review-overrides-cli.js` | `npm run review:overrides -- --date DATE --file OVERRIDES.json [--receipt RECEIPT.json]` read-only matches page SHA/literal claims/false-positive explanations. Exit decisions use `currentMatchVerdict`; old `overriddenFailedPages` and similar fields are compatibility views only. Changes no review outcome or publication eligibility; see the maintenance guide. |
| `storage-report.js` | `npm run storage:report [--advice-only]` reports must-keep/compressible/deletable categories and read-only storage status; deletes nothing. |
| `locks.js` | `npm run locks` observes owners/times/heartbeats in the original bounded scope, including `.analysis-runs`, `conference-processes`, and actual Git common-dir shared locks. Check `scanComplete`/`scopes`/`problems`; partial observation exits 1. `--recover` previews only, never deletes. Observation grants neither possession nor reclaim authority. |
| `docs-consistency.js` | `npm run docs:check` checks npm script names in root README/AGENTS/this index/all `docs/` Markdown. Other documents, argument syntax, and links need separate checks. |
| `doctor.js` | Read-only preflight for Node/Python/dependencies/`.env` permissions/models/proxy/role/disk/blog/accounts, with optional arXiv three-endpoint probing. Accepts `--date YYYY-MM-DD`, default `--offline`, `--network`, `--json`. No writes/model requests/key printing. Warns if primary/secondary pools contain the same key values; this is value comparison only. |
| `digest-run-report.js` | Reports fetch/filter/analysis/remote-publication/two visual states and saves/reads daily-round/handoff diagnostics against actual date/source/scope. `--watch` prints stage/failure/cost/account/no-progress snapshots; default single report is unchanged. Does not automatically verify deployment/webpages. |
| `digest-status.js` | Synchronizes papers.json analysis/batch/recovery status. Normal daily/deep/batch finalizers use `synchronizeCompletedAnalysisDigestStatuses` for skipped old successes, under canonical paper locks with fresh formal/source reads. Saves only mismatched successful states and never overwrites the latest failure. |
| `editorial-quality.js` | Shared language/factual-expression/scoring/readability checks for API/Manual Reader text. |
| `env-loader.js` | Loads a controlled environment from project `.env` and checks direct Node/Manual entry runtime requirements. |
| `lib/workflow-error-policy.js` | Shared failure categories, nested storage detection, and formal analysis-error fields. Conference retains old exports; history uses it directly, preserving run-level scope. Does not schedule or add retries. |
| `lib/core-summary-semantic-replay-cli.js` | Read-only private FD subprocess used by Python after checking original full-text SHA to reuse current detailed-core-summary semantic rules. Explicit stage-binding mode rechecks the complete core stage and original paid/operator evidence; forbids semantic exemptions/models/network. |
| `lib/core-symbolic-source-numerals.js` | Pure source-classification text view removing only determined TeX subscripts/formal identifiers, retaining measured values and ordinary parenthesized quantities. Changes no sealed sources/summary/paid response/completion state. |
| `lib/direct-rewrite-analysis-context.js` | Uses AsyncLocalStorage to isolate historical/daily sources from old generated text/caches. Reader images are temporary; historical paper-version identity follows source records into every analysis stage. |
| `lib/explicit-reader-retry-round.js` | Runs an explicit new paid Reader retry window only for verified exhausted failures, checking paper lock/four sources/actual input/draft SHA. Fully retains originals/counts, reserves new budget before requests, and resumes only unused allowance; no publication authority. |
| `lib/fresh-analysis-context.js` | Isolates sources and analysis context for fresh rewrite runs, revalidating source SHAs and rejecting old generated text or other runs' checkpoints. |
| `lib/fresh-arxiv-rewrite-source.js` | Atomically saves official TXT/PDF/pixel-free runtime metadata/manifest for each arXiv acquisition. Only explicit current-PDF 404 permits the same paper's official `vN`; text must come from that PDF and a verified `sourceVersion` is recorded. Ordinary source format stays compatible. |
| `lib/immutable-file.js` | Writes/syncs temporary bytes before exclusively hardlinking the final file, never overwriting. Reclaims only same-host dead-writer temporary links that point to the verified final inode; rejects cleanup of other files. |
| `lib/legacy-manual-source.js` | Read-only verifies old Manual official-source dates/versions/paths/SHAs. |
| `lib/llm-pending-request.js` | Persists request intent before model dispatch so interruption cannot refund a reservation. |
| `lib/review-overrides.js` | Strict false-positive-explanation schema with page SHA/publication commit/literal evidence/reviewer binding. Adds bounded diagnostic downgrades, not exemptions for real errors. |
| `lib/error-codes.js` | Stable error-code dictionary with labels/retryability/suggested commands/document anchors, shared by recovery and reports. |
| `lib/env-schema.js` | Central `.env` schema for required fields/types/ranges/secret markers and read-only parsing. New tools reuse it; doctor retains its own checks. |
| `lib/source-acquisition-policy.js` | Pure announcement-window and 429/5xx/RSS next-step guidance; no network. |
| `lib/llm-usage.js` | Normalizes actual model usage by paper/stage; unavailable provider billing remains unavailable. Controlled repair may read-only capture normal saved-event paths/SHAs, without another ledger or changed writes. |
| `lib/llm-usage-summary.js` | Aggregates real request usage by date, including success/failure/stage/model/account/available cost fields. Filters directory/file mtime before reading and provides cache/text/JSON output. |
| `lib/digest-live-status.js` | Read-only composes daily stage/count/current-paper/failure/recent-log/account/usage/no-progress snapshots for `digest:status --watch`. |
| `lib/error-guidance.js` | Appends known-error cause/next step/copyable command/document guidance while preserving original error codes/stacks. |
| `lib/model-text-sanitization.js` | Versions request-text sanitization preserving legal Unicode. Production recovery/promotion/staging checks current sources; affected old input needs reanalysis. Missing controlled sources cannot be assumed reusable. Old success structures and published read-only states stay unchanged. |
| `lib/paper-identity.js` | Node `paper-identity-v1` normalization, official-source URL checks, and stable SHAs. Does not replace existing arXiv helpers. |
| `lib/paper-source-authority.js` | Verifies canonical identity/full identity record/source snapshot/receipt/full-text SHA and returns a source-only reference generated by actual verification. Ordinary disk arXiv loading cannot restore publication authority; conference also needs an actually verified in-process plan handle. |
| `lib/python-json-packet-bridge.js` | Private Python input transport for conference/history pages: exclusive `0600` temporary files, bounded input/output/deadlines, and cleanup. Fixed conference/history/aggregate roles use `publication_replay_policy.json` plus 15-second cleanup; unknown entries keep 60 seconds. A private FD carries only actual fixed-program failure status; callers still verify packet/JSON/article identity. |
| `publication_local_replay.py`, `publication_replay_policy.json` | Shared fixed-page deadlines/subprocess cleanup/source replay for conference/history. A private ContextVar binds only the same synchronous render's original paper/sealed text/normal Node result and is destroyed on exit. Grants no models/source/completion permissions. |
| `lib/llm-response-recovery.js` | Preserves actually returned text and safe event metadata when Node usage saving fails, corresponding to Python `llm_usage.py`. Writes protected private records only on faults; no automatic replay or qualification entry. |
| `lib/reanalysis-helpers.js` | Helpers for selected-paper reanalysis, clearing Reader state and updating recovery statistics. |
| `lib/source-classification-failures.js` | Uses structured common-request errors only to identify account/service faults and stop dispatch. Content validation and truncation stay paper-level; never guesses service failure/account switching from prose. |
| `lib/source-classification-scheduler.js` | Processes source classification with 1–3 concurrent tasks. Account-level failures/stops halt new requests, retain returned responses, merge in original selection order, and record unfinished papers. |
| `lib/source-evidence-snippets.js` | `buildSourceEvidenceSnippets` selects/labels continuous original excerpts within character budgets; `fillConceptQuotesFromSnippets` inserts model-selected IDs' literal quotes. Preserves whitespace/UTF-16 offsets and rejects unknown IDs. |
| `lib/workflow-implementation-files.js` | Statically collects actual executable transitive dependencies for current implementation fingerprints. |
| `llm-account-pool.js` | Node OpenCode Go pool: equal-weight keys, stable account-ID-ordered round-robin, excluding blocked/cooling accounts and automatically readmitting expired cooldowns. Switches only on explicit quota/balance errors and persists cross-process cursor/cooldowns. |
| `llm-usage-report.js` | Read-only actual usage totals; `--paper` supports new/old arXiv IDs and complete conference IDs. Distinguishes provider usage/unavailable/character estimates and never invents costs or fills missing old paper identity. |
| `llm_account_pool.py` | Python counterpart using the same equal-weight rotation, data format, and lock protocol. |
| `llm_usage.py` | Saves Python publication-request usage/failure events with cross-run attribution. |
| `log-setup.js` | Timestamped Node console/file logs with secret redaction. `writeStageSummary` appends plain-language summaries to logs/summaries/<date>-summary.log with 0700/0600 permissions/redaction; summary-write failures are warnings only. |
| `log_setup.py` | Shared Python logs/redaction and `write_stage_summary` in the matching format. |
| `lib/error_guidance.py` | Python counterpart for cause/next-step/copyable-command/document error guidance, preserving original stacks. |
| `manual_agent_policy.py` | Verifies current/old Manual model declarations against trusted outer policy. New records require Sol/high and matching versions; old records keep original identity and cannot grant new declarations. Checks recorded fields, not proof of remote model execution. |
| `paper_identity.py` | Python `paper-identity-v1`, cross-checked against Node with shared vectors. |
| `path_config.py` | Shared Python paths, dates, and atomic writes. |
| `project_env.py` | Python project-environment loading, minimal child environments, and proxy settings. |
| `runtime-storage.js` | Read-only runtime size counts/reference-aware cache/log cleanup preview. Deletion requires explicit `--apply`. |
| `runtime_guard.py` | Rejects Python project entry points inside the sandbox. |
| `test-api-key.js` | Real model-request diagnostic for primary/secondary protocol routing, proxy, and responses. |
| `utils.js` | Node atomic writes/time/IDs/analysis parsing/prompts/model protocols/proxy utilities. `readTagValidation` recognizes old/new parsed fields and rejects mixing. |
| `lib/active-time-budget.js` | Effective-time budget shared by model requests and CONNECT/TLS. Excludes long system/event-loop pauses but counts short pauses; connection budget stays 60 seconds. No account/request/Reader allowance changes. |
| `utils.py` | Python analysis/scoring parsing and shared publication text utilities. `read_tag_validation` reads old/new parsed fields and rejects mixing. |
| `validate-data-files.js` | Read-only current/cross-file paper-set/score/compatible-result source validation. |
| `verify-project.js` | Complete offline external-runtime validation: fixed Hugo, repository syntax, normal/Manual JS/Python, read-only data checks. `--quick` checks only syntax/data, not full acceptance. |
| `workspace-role.js` | Checks workspace roles before npm production entries and again in shared direct Node/Python checks. Full conditions follow this table under the same filename. |


**`daily_republication.py` — full operating conditions**

Explicit presentation-only republication of a complete already-published daily batch via `blog:generate -- --date DATE --republish UUID`. Under blog/date locks, revalidates original publication/current remote/same source and analysis/controlled files; immutably backs up evidence under the UUID before retiring active pointers.

Retains pass caches/checkpoints/costs. Pending activation blocks ordinary generation/review/push and resumes only the same UUID. Creates no new analysis/fresh promotion; see [protocol](../docs/data-format.md#同来源同分析的日批重发布).

**`verify-web.js` — full operating conditions**

`npm run verify:web -- --date DATE [--deploy OID]` checks batch summary/single-page HTTP 200, narrowly normalized final URLs, and limited title conditions; writes data/current/web-verification-<date>.json. Does not compare exact titles/H1/canonical/full text.

`--deploy` checks Pages workflow, `--wait` polls, `--json` emits deployment snapshots/summary/final JSONL. Atomic output includes contract/schemaFingerprint/createdAt/partial/deploy; see [completion checks](../docs/maintenance.md#发布后网页核验与收尾).

**`workspace-role.js` — full operating conditions**

Checks workspace roles before npm production entries and again in shared direct Node/Python checks. The untracked `0600` role marker binds the repository real path to daily/history.

`set` atomically binds/explicitly changes role; `exec` checks before startup. `PD_WORKSPACE_ALLOW_CROSS_ROLE=1`, from environment or workspace `.env`, permits history commands in daily only and prints notice. Reverse use and realpath mismatch remain forbidden.
