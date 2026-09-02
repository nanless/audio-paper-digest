# Default LLM/API Workflow

## Audience and Completion Goal

For anyone running, understanding, or recovering a dated digest. The shortest entry is:

```bash
npm run digest:prepare -- YYYY-MM-DD
```

`digest:api` is an exact alias. Completion means closed data contracts, remotely verified blog publication, and complete post-publication visual gates. Manual is explicit only; see [manual/README.md](../../manual/README.md).

## Sequence

```text
date and archive
 → proxy-backed fetch
 → published-paper deduplication
 → keyword prefilter
 → LLM filtering
 → full-text staged analysis
 → scoring audit
 → API Reader longform
 → generate/review/push
 → remote OID
 → visual generation and record
 → digest:status
```

## 1. Date and Archive

A run starting at fetch must target Beijing today. Date-scoped raw, decision, filtered, and deep files move to `data/archive/<date>/`; `papers.json` never moves.

Historical batches resume only from a safe existing stage accepted by the orchestrator, for example:

```bash
./run-daily-digest.sh YYYY-MM-DD --from generate
```

## 2. Fetch

arXiv and HuggingFace require project proxy configuration. Each source checkpoint binds health, candidate count, and stable content SHA. An incomplete required source blocks a complete filter set.

Candidates are normalized, merged, deduplicated against published blog IDs, and saved in `raw-candidates.json`.

## 3. Keyword and LLM Filtering

The keyword layer optimizes recall:

- core eess.AS/cs.SD papers always reach the LLM;
- abstracts under 80 characters always reach the LLM;
- audio/speech/music/model/dataset keyword matches reach the LLM;
- only complete, clearly unmatched supplementary-category abstracts become deterministic negatives.

Decisions persist per paper. Exact Muse uses effective batch 1, so one failure remains local. Filtering completes only when decisions cover raw exactly and filtered matches positive decisions minus explicit exclusions.

## 4. Full Text and Staged Analysis

Healthy arXiv HTML is preferred; structurally inadequate pages fall back to PDF. Metadata shells cannot claim full-text provenance, and source-SHA changes invalidate primary analysis and downstream stages.

Stages are primary analysis, open-source/demo scans, factual revision, table/method/structure repair, scoring audit, API Reader v3, and official-figure materialization. Stage fingerprints bind inputs, model, protocol, prompt, temperature, budgets, and output SHA.

The canonical 13 headings serve parsers. Reader v3 serves humans: it explains term combinations, computation/training, datasets, metrics, results, counterevidence, reproduction, and limits. Tables and figures must sit next to the argument they support.

Each paper saves immediately under its paper lock and updates `papers.json.digestStatus`.

## 5. Scoring and Production Proof

Scoring first selects document type, then audits eight dimensions against an evidence ledger. Code recomputes the total, applies deterministic evidence caps, and binds audit/input/output SHA values.

Reader, authors, figures, score, source identity, and exact paper-set bindings form `llm_api_production`. Manual-only lineage in a default API batch fails closed.

## 6. Blog Transaction

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

Generate issues a schema-v3 manifest. Review uses immutable page artifacts for deterministic, LLM, image, and Hugo gates, reviewing the digest first and paper pages concurrently. Push commits only the receipt-authorized delta and verifies remote `main`.

Review never mutates reviewed bytes. Page, baseline, protocol, generation, or remote drift invalidates the transaction.

## 7. Visuals

After remote verification, the system plans TOP 10 paper infographics and one digest cover. Scripts never call an image API; Codex uses built-in `image_gen`.

```bash
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

Use only absolute paths emitted by prepare. Inspect every final image before recording it. An explicit user no-image request creates a bound waiver; pending work is never relabeled complete.

## 8. Recovery and Final Status

```bash
./run-daily-digest.sh YYYY-MM-DD --from review
npm run deep -- --date YYYY-MM-DD
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

Regenerate final status after the last push, record, or waiver. Reports are snapshots, not live state.
