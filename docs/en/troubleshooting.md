# Troubleshooting

## Method

Start with the earliest failed stage and identify its inputs, configuration, and records before choosing a recovery command. All project diagnostics run outside the sandbox. A failure to reach a local proxy inside the sandbox does not establish a target-site outage. Do not edit checkpoints or source files just to make an error disappear.

## Missing Configuration

Check that repository-root `.env` exists, has suitable permissions, and defines `PAPER_ANALYZER_API_KEY`, `PAPER_ANALYZER_MODEL`, and `PAPER_ANALYZER_ENDPOINT`. Public endpoints require HTTPS. Project loaders clear inherited project variables, so `.zshrc` cannot fill missing values.

```bash
ls -l .env
npm run workspace:role -- status
```

The role must match the directory's purpose. If the marker is missing or its real path does not match, follow [Setup](setup.md) before binding the role. `node scripts/test-api-key.js` can test the model connection on its own, but it sends a real API request and is not an offline check.

## Primary Model Failure or Empty Response

Check that the model name matches project configuration and that the command runs outside the sandbox. With Muse, `HTTPS_PROXY` or `HTTP_PROXY` must supply an `http(s)://` CONNECT proxy whose exit region matches the account. If `PD_OPENAI_RESPONSES_STREAM=1` is enabled, check that the proxy supports SSE.

Muse uses a separate CONNECT proxy connection object for each request and destroys it afterward. Do not switch it to direct access. `incomplete/max_output_tokens` means truncation: adjust evidence, output budgets, or the prompt and retry. Never accept partial JSON.

With fallback accounts configured, inspect `activeAccountId`, `limitClass`, and `blockedUntil` in `data/runtime/llm-account-pool.json`. It contains no raw key, but the credential fingerprints are still sensitive: keep permissions at `0600` and do not upload or archive it.

Only an explicit `GoUsageLimitError` or `Insufficient balance` on the current account switches to a later account. Other authentication 401 responses stop the run, while a generic 429 keeps the account and follows rate-limit backoff. Do not delete or edit state to force a return to the primary account. A cooldown expiring does not switch back automatically. Corrupt state, an invalid generation counter, or an unsafe path stops requests before any network I/O.

## MiMo/Kimi 403

These requests normally connect directly with `agent:false`. If direct curl succeeds but the script returns 403, look for callers that bypass `requestLlmJson()` or pass a proxy connection object. Do not apply Muse's required proxy routing to other models.

## arXiv or HuggingFace Failure

Check the project proxy and the affected source checkpoint. arXiv Node requests require HTTP CONNECT; HuggingFace curl may also use `ALL_PROXY=socks5h://...`. Respect the configured 429 backoff instead of deleting checkpoints and raising concurrency.

If candidate counts or SHA values do not match, fetch only that source again. Never read a missing proxy configuration as a healthy empty HuggingFace result. HTML that carries metadata but no reliable full text should lead to PDF extraction during source capture.

## Incomplete Filter State

Run the read-only check:

```bash
npm run validate:data
```

Look for mismatched candidate/decision input SHA, missing decisions, API failures still marked `pending`, non-`related` selected items, or partially updated model, prompt, and keyword versions. Resume filtering to finish the decisions. Do not delete unknown ones.

## Slow or Repeated Analysis Failure

Identify the failed stage and its saved records before restarting an entire paper. Whole-paper concurrency defaults to 3, heavy Reader stages to 5, and filtering follows `PD_FILTER_BATCH_SIZE`. Primary analysis, local repair, and Reader generation have separate output and context budgets.

Reader repair normally allows 8000 output tokens. If a repair truncates exactly at the base limit and the candidate is still eligible for extra recovery, the run saves the failed draft and stops. The next explicit resume can use one higher-budget repair, up to 16000 tokens by default. That attempt is shared with implementation-upgrade recovery and cannot be stacked with it. Custom limits still depend on the full-article and base-repair budgets. Any model content consumes the attempt, while a transport failure with no content does not. Truncated content stays invalid.

```bash
npm run deep -- --date YYYY-MM-DD
npm run batch -- --retry-failed-readers
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader
```

Source SHA, prompt, or model changes rerun the affected stages and the downstream work that depends on them. An older successful article cannot hide the latest failure. `batch --retry-failed-readers` stops reusing failed candidates only for unfinished papers. Use `reanalyze` to force all analysis again and clear old Reader/image-supplement state.

If a recovery command reports missing or changed daily sources, do not edit checkpoints or paste in old `data/current` text. While the target is still Beijing today, rerun the same dated `npm run digest:prepare -- YYYY-MM-DD` to establish the sources. Historical dates cannot restart at fetch. Keep the failure records and follow the historical maintenance workflow.

## Historical Direct Source or Staging Failure

Identify the source route first. The current saved files under `data/runtime/fetched-arxiv-sources/<arxivId>/generation-XXXXXX/` must contain text, PDF, runtime metadata, and a manifest. The `generation` number identifies a source capture, not the paper's arXiv `vN` version. Run the same `history:direct-scheduler` until every selected paper is `ready` for that plan and source generation, then run `history:direct-run --apply`.

Direct-run never fetches missing sources. It stops before model calls if scheduler state is missing, `handoff`, or `failed`. Rerunning verifies sources and reuses stages in `analysis-recovery.json` that still match. If the renderer changed, it can rebuild staged pages from matching analysis without another model request and without overwriting older staging files.

If the current unversioned arXiv PDF explicitly returned HTTP 404, rerun the same generation unchanged. The system may try official historical versions of that same paper, never a guessed replacement ID. A successful fallback requires a `sourceVersion` record of the current 404, `source.txt` extracted from the selected PDF, a version warning at the top of the analysis input, and a current-unavailable warning on the final page. Source identity and hashes must match.

Never import a replacement or alter checkpoints when current-PDF 404 was not established, when the URL identifies another paper, or when it carries a query or fragment. Ordinary current-PDF sources do not use this conditional path. If every official version of the same paper is unavailable, use only the saved, explicitly named arXiv failure handoff for the corresponding fallback workflow.

If external conference paths may have changed, run one `history:status ... --verify-sources true` check to rehash metadata and PDFs. Do not combine deep verification with watch. An ordinary status check reads paths, types, and sizes without repeatedly reading large files.

For conference items, check local-source metadata/PDF paths and SHA, the frozen inventory, and conference page mappings. A missing or damaged local conference input stops that item. It cannot enter the arXiv handoff route. Do not substitute old blog prose, old analysis, filename similarity, or ad-hoc title searches.

## Repetitive Prose or Poorly Integrated Tables and Figures

Compare `apiReaderPlan` with the article. Check whether combined terms explain each component's role and why they work together, whether tables connect a comparison question to results and limits, and whether figures have adjacent guidance, viewing steps, images, captions, and explanation. The model must not describe colors, axes, or modules it has not seen. Pronouns need clear referents.

Revise prompts or structured review findings and refresh the Reader rather than changing pages during blog review. Table-count diagnostics use `reader_table_count_insufficient`, `requiredCount`, and `actualCount` for recovery. Operators must not edit them. If a table exists but lacks its source record, repair that record rather than blindly adding a table.

Check that `selection` names real DOM rows and columns, that table markers have a unique ordered mapping to source records, and that quote-based pruning leaves at least two columns and one data row. Old structured evidence must pass source-manifest and full-text SHA checks and be verifiable with its recorded parser version. The only exception is an implementation-recognized no-layout source marker whose table, formula, and figure arrays are empty. An arbitrary layout declaration is not enough, and saved source files must not be rewritten to create new hashes.

A single `RESPONSE_TOO_LARGE` figure is skipped. If no figure can be prepared successfully, investigate the proxy, URL, MIME, or source PDF.

## Generate Failure

Check current publication eligibility, batch date, eight scores, Reader v3, affiliations, safe image URLs, and the target blog worktree. Generate refuses to overwrite overlapping manual Git edits. A requested inclusion or exclusion that matches no paper also stops generation, because it protects publication scope.

## Review Failure

Review reads pages without changing them. Content corrections go back to generation or analysis. Transient API failures retry only the affected pages. Per-page passes are keyed by relative path and content SHA, so changed content needs another review. Generation metadata, model, code, protocol, or Hugo-runtime changes rerun current-batch checks and produce a current receipt without re-reviewing unchanged pages. A changed Git baseline or remote identity still blocks push.

For Hugo memory failures, check for stale parallel processes and confirm the target repository and theme before running the controlled build check. Never skip Hugo and record a successful review.

## Push Failure

Check that the receipt matches the current generation, that the blog `HEAD` is still the review baseline, that staged/unstaged/untracked files match the exact allowed delta, that the remote name and push URL are unchanged, and that remote `main` matches the retryable commit.

Push does not generate or review content and cannot bypass the receipt through an existing local commit. If a valid local publication commit was not successfully pushed, resume through the original entry so the system can verify and reuse it without broadening scope.

### Git was pushed but pages are not live

Check the GitHub Pages build and deployment for the publication commit. Read the logs and fix failures, then wait for success. If a later commit was deployed, verify that it still carries this batch's reviewed page content. Check every digest and paper page for HTTP 200, the formal URL, and the correct title, and keep the results. Even a matching remote commit or a complete `digest:status` report still requires these manual checks.

## Visual Pending or Record Failure

Confirm remote publication verification, then run:

```bash
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

Use only absolute reference paths emitted by the current prepare command. Modern daily tasks intentionally return an empty list after verifying official figure identity. Do not substitute old caches. Record requires the current task token, the analysis file, and `--qa-attested true` after visual inspection. Manifest, publication, or image SHA changes invalidate older completion records.

## Stale Status

`digest:status` is a read-time snapshot. Regenerate it after a push, image record, or waiver. Current-date failures are never hidden by archives, and historical archives must still have matching dates, sources, and paper sets. Live-site status also requires the deployment and page checks above.

## Escalation Evidence

Provide the command, target date, earliest error, stage, relevant manifest path, and a redacted log excerpt. Never include API keys, authentication headers, cookies, or complete `.env` contents.
