# Troubleshooting

## Method

Find the earliest failed gate. Run all diagnostics outside the sandbox; inability to reach a local proxy inside the sandbox is not a target-site diagnosis.

## Missing Configuration

Inspect repository-root `.env`, not shell variables. The required triplet is API key/model/endpoint, and public endpoints require HTTPS. Project loaders intentionally clear inherited values.

## Muse Failure or Empty Response

Confirm exact model, project HTTP CONNECT URL, external runtime, expected proxy region, and whether optional SSE is compatible. Muse must not be switched to direct access. `incomplete/max_output_tokens` is truncation; adjust evidence/output budgets or prompt and retry.

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

Identify the failed stage. Whole-paper concurrency defaults to 3, Reader heavy work to 5, and Muse filtering to batch 1. Primary, repair, and Reader have separate budgets.

```bash
npm run deep -- --date YYYY-MM-DD
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader
```

A retained older success plus a latest failure still requires retry.

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
