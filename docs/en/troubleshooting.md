# Troubleshooting

## Method

Find the earliest failed gate. Run all diagnostics outside the sandbox; inability to reach a local proxy inside the sandbox is not a target-site diagnosis.

## Missing Configuration

Inspect repository-root `.env`, not shell variables. The required triplet is API key/model/endpoint, and public endpoints require HTTPS. Project loaders intentionally clear inherited values.

## Muse Failure or Empty Response

Confirm exact model, project HTTP CONNECT URL, external runtime, expected proxy region, and whether optional SSE is compatible. Muse must not be switched to direct access. `incomplete/max_output_tokens` is truncation; adjust evidence/output budgets or prompt and retry.

With fallback accounts configured, inspect `data/runtime/llm-account-pool.json` for `activeAccountId`, `limitClass`, and `blockedUntil`; raw keys are never stored there. Do not delete or edit state merely to force the primary account back. Sticky routing reselects only when the current account receives an explicit `GoUsageLimitError`. Corrupt state, an invalid generation, or an unsafe state path fails before network I/O, while a generic 429 keeps the current account and follows normal short rate-limit backoff.

## MiMo/Kimi 403

These providers normally use `agent:false` direct connections. Check for callers bypassing `requestLlmJson()` or injecting an agent. Do not copy Muse proxy behavior to ordinary models.

## arXiv or HuggingFace Failure

arXiv requires HTTP CONNECT. HuggingFace curl may use SOCKS in addition. Respect 429 backoff and preserve per-source checkpoints. Proxy absence cannot be reported as a healthy empty HuggingFace source. Metadata-shell HTML should continue to PDF fallback.

## Incomplete Filter State

```bash
npm run validate:data
```

Look for raw/decision SHA mismatch, incomplete coverage, pending API errors, non-related filtered items, or partially refreshed model/prompt/keyword versions. Resume filtering; do not delete unknown decisions.

## Slow or Repeated Analysis Failure

Identify the failed stage. Whole-paper concurrency defaults to 3, Reader heavy work to 5, and Muse filtering follows `PD_FILTER_BATCH_SIZE`. Primary, repair, and Reader have separate budgets.

```bash
npm run deep -- --date YYYY-MM-DD
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader
```

A retained older success plus a latest failure still requires retry.

If a recovery command reports a missing or drifted sealed daily source, do not edit a checkpoint or reuse old `data/current` text. Re-run `npm run digest:prepare -- YYYY-MM-DD` so its source phase seals a new PDF/TXT pair.

## Historical Direct Source or Staging Failure

Identify the route before starting a crosswalk. An arXiv direct item's current generation must contain TXT,
PDF, runtime metadata, and manifest at
`data/runtime/fetched-arxiv-sources/<arxivId>/generation-XXXXXX/`. Re-running the same
Run `history:direct-scheduler` until every selected paper is `ready` in the same plan/generation status.
`history:direct-run --apply` is replay-only and rejects missing/handoff/failed scheduler state before any model call;
rerunning it then reuses matching source-bound analysis checkpoints. A failed fresh
acquisition writes only an immutable handoff; it does not mutate crosswalk automatically or block the local
conference queue.

When the exact failure is HTTP 404 for the current unversioned arXiv PDF, rerunning the same generation may use an
official historical `vN` PDF only for that canonical ID. A successful fallback must seal self-hashed `sourceVersion`
evidence, derive `source.txt` from the selected PDF bytes, include the current-unavailable warning in analysis input,
and render the same warning at the top of the final paper page. Never import a cross-ID/query/fragment URL or patch the
checkpoint. Ordinary current-PDF bundles do not enter this conditional path; if every same-ID version remains
unavailable, use the named handoff fallback without guessing a replacement identity.

Use one `history:status ... --verify-sources true` invocation to rehash external conference metadata/PDF files when
path drift is suspected. Do not combine deep verification with watch; normal/watch status uses path/type/size checks.

For a conference direct item, check the local-source manifest metadata/PDF paths and SHA, frozen inventory SHA,
and conference projection. Do not substitute old post prose, old analysis, filename similarity, or an ad-hoc
title search. An unavailable/damaged local conference source fails that direct item closed. Only a named immutable
arXiv fresh-acquisition failure handoff can enter the crosswalk fallback.

## Mechanical Reader, Detached Tables, or Figures

Check term-pair roles and combination meaning; table question/conditions/interpretation; figure lead/viewing path/caption/explanation; no-pixel visual guesses; and ambiguous pronouns. Fix analysis/structured findings and refresh Reader. Review must not rewrite the page.

## Generate Failure

Check production proof, batch date, eight scores, Reader v3, authors, safe image URLs, and target blog worktree. Generate refuses to overwrite overlapping manual Git edits. Include/exclude scope mismatches are intentional failures.

## Review Failure

Content findings return to generation or analysis. Transient API failures retry only affected pages. Page SHA, generation, protocol, or baseline drift invalidates the receipt.

For Hugo memory problems, first eliminate stale parallel Hugo processes and verify repository/theme selection. Never skip Hugo to issue a receipt.

## Push Failure

Verify receipt/generation binding, current HEAD versus review baseline, exact worktree/index delta, remote identity, and live remote `main`. Push neither generates nor reviews and cannot use an unrelated local commit to bypass the receipt.

## Visual Pending or Record Failure

```bash
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

Use only emitted absolute reference paths. Record requires the current token, canonical asset, and `--qa-attested true`. Publication, manifest, or asset changes invalidate completion.

## Stale Status

`digest:status` is a snapshot. Regenerate it after push, record, or waiver. Current-date failures are never hidden by archives; historical archives must still satisfy cross-file contracts.

## Escalation Evidence

Provide command, date, earliest error, stage, manifest path, and a redacted log excerpt. Never include keys, authentication headers, cookies, or full `.env` contents.
