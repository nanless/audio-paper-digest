# Audio Paper Digest Operations

## 1. Audience, Goal, and Entry Point

This document is for Agents running, recovering, publishing, or maintaining the default LLM/API digest. See [AGENTS.md](AGENTS.md) for compact non-negotiable rules, [docs/README.md](docs/README.md) for task-based navigation, and [scripts/README.md](scripts/README.md) for code ownership.

A dated digest means the complete default route:

```bash
npm run digest:prepare -- YYYY-MM-DD
# exact alias
npm run digest:api -- YYYY-MM-DD
```

The outcome includes fetching, filtering, staged analysis, API Reader longform, blog generate/review/push, remote-OID verification, post-publication visuals, and final status. `full-fetch.js` alone is not that outcome. WeChat, Feishu, and Xiaohongshu are optional channels outside the default request.

Manual is an isolated, explicit workflow:

```bash
npm run digest:manual -- YYYY-MM-DD
```

Use it only when the user explicitly requests Manual/human processing, and read [manual/README.md](manual/README.md) first. API failures never select Manual automatically.

## 2. First Run

```bash
npm install
python3 -m pip install -r requirements.txt
cp env.example .env
```

Minimum project `.env`:

```dotenv
PAPER_ANALYZER_API_KEY=your-key
PAPER_ANALYZER_MODEL=muse-spark-1.2-contributor
PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
PAPER_DIGEST_BLOG_REPO=/absolute/path/to/audio-paper-digest-blog
```

Node must satisfy `>=20.18.1 <21 || >=22.3.0`. Every project script, test, syntax check, and data validation command must run outside the sandbox.

## 3. Default Workflow

```text
archive current
  → proxy-backed arXiv and HuggingFace fetch
  → published-paper deduplication
  → high-recall keyword prefilter
  → per-paper LLM filtering
  → staged full-text analysis
  → type-aware scoring
  → API Reader v3 longform and official figures
  → generate
  → review
  → push and remote OID
  → TOP 10 infographics and digest cover
  → digest:status
```

### 3.1 Fetch and Filter Closure

`scripts/full-fetch.js` archives date-scoped current state, fetches seven arXiv categories and HuggingFace Papers, filters, updates the paper database, analyzes, and persists each result. A source is healthy only when its checkpoint binds candidate count and stable content SHA.

`raw-candidates.json` is the authoritative candidate set. Core categories, short abstracts, and audio-keyword matches always reach the LLM. A filter run is complete only when decisions cover every raw candidate and the filtered set exactly matches positive decisions minus explicit exclusions.

### 3.2 Analysis and Reader Longform

Each paper prefers healthy arXiv HTML and uses controlled PDF fallback. Metadata shells and malformed short pages cannot claim full-text provenance. A source-SHA change invalidates primary analysis and downstream stages.

Stages include primary analysis, open-source and demo scans, revision, table/method/structure repair, scoring audit, API Reader, and figure materialization. Each stage binds input, model, protocol, prompt, temperature, budgets, and output SHA.

The 13 Chinese canonical headings remain machine-parser anchors. The reader-visible article is `beginner-researcher-v3`:

- 12–18 learning-dependent sections and 5,000–18,000 Chinese characters;
- 4–10 explicit bridges between paired paper terms;
- narrative tables for data/protocol, results, ablations/failures, and training/deployment cost when evidence exists;
- “lead → viewing path → official figure → caption → explanation” adjacency;
- clear separation of reported facts, bounded interpretation, and untested speculation.

### 3.3 Scoring

Eight dimensions have maxima of 2/1.5/1.5/1/1.5/1.5/0.5/1.5. Code recomputes their sum and caps the displayed total at 10.

Document type selects applicable evidence, not weights. One defect belongs to one primary dimension: missing artifacts to Open Source, missing configuration to Reproducibility, missing claim support to Experimental Sufficiency, presentation to Clarity, and actual logical or derivational faults to Technical Rigor. Scoring must cite the evidence ledger and persist `evidenceProfile` plus deterministic caps.

## 4. APIs, Proxy, Concurrency, and Context

### 4.1 Protocol Routing

| Priority condition | Protocol | URL |
|---|---|---|
| DeepSeek domain or model | OpenAI Chat | `/v1/chat/completions` |
| exact Muse Contributor | OpenAI Responses | `/v1/responses` |
| `token-plan` + MiMo | Anthropic | `/anthropic/v1/messages` |
| Kimi coding | Anthropic | `/coding/v1/messages` |
| other `/anthropic` | Anthropic | `{base}/messages` |
| other | OpenAI Chat | `/v1/chat/completions` |

All Node LLM calls use `requestLlmJson()`. Muse requires a fresh project HTTP CONNECT agent per request; other providers use `agent:false`. Python publishing follows the same Muse exception.

arXiv metadata, HTML, PDF, and images require project HTTP CONNECT. HuggingFace curl inherits HTTP(S) proxy and may additionally use SOCKS `ALL_PROXY`. External image/demo redirects are HTTPS-only and revalidate public destination IPs at every hop.

### 4.2 Defaults

| Setting | Default |
|---|---:|
| analysis concurrency | 3 |
| configured filter batch | 5; exact Muse effective batch is 1 |
| whole-paper retries / per-stage attempts | 2 / 3 |
| primary / local-repair output | 64,000 / 16,000 tokens |
| primary input | 200,000 characters |
| API Reader output | 48,000 tokens |
| Reader evidence / total request | 180,000 / 240,000 characters |
| Reader heavy-stage concurrency | 5, bounded 1–5 |
| independent blog-page review concurrency | 5, bounded 1–5 |

OpenAI Responses uses SSE only when `PD_OPENAI_RESPONSES_STREAM=1`. An `incomplete/max_output_tokens` response is a truncation failure, never successful JSON.

## 5. Authoritative State and Recovery

| Current file | Meaning |
|---|---|
| `papers.json` | persistent deduplication database and digest status |
| `fetch-checkpoint.json` | per-source recovery proof |
| `raw-candidates.json` | full filter input |
| `filter-decisions.json` | per-paper decisions and cache |
| `filtered-papers.json` | selected set |
| `deep-analysis-result.json` | canonical analysis, checkpoints, production proof |
| generation manifest | exact blog-page set and SHA values |
| review receipt | review, Git baseline, and remote publication proof |
| visual manifests | TOP 10 and cover task state |

An archive is not trusted merely because it exists. Date, source, candidate, decision, and paper-set contracts must still close.

```bash
npm run digest:prepare -- YYYY-MM-DD
./run-daily-digest.sh YYYY-MM-DD --from review
npm run deep -- --date YYYY-MM-DD
npm run reanalyze -- --concurrency 5
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

Fetching from scratch is restricted to Beijing today. Historical batches resume only from stages accepted by the orchestrator. Never edit checkpoints to manufacture completion.

Failures retain manifests and checkpoints. A prior successful body may remain available, but the latest failure forces a retry until a later success clears it. Per-paper analysis holds a normalized-arXiv-ID lock and rereads canonical state inside the lock before merging.

## 6. Blog Transaction

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

Generate installs exact pages and issues the generation manifest. Review treats each page as immutable, runs deterministic/LLM/image/Hugo gates, persists page checkpoints, and issues a receipt. Push permits only the receipt's exact Git delta and verifies the remote `main` OID.

Page bytes, generation, production proof, review protocol, Hugo gate, blog baseline, remote name, or push-URL identity drift invalidates the transaction. Review workers never modify reviewed bytes; findings return to generation/repair.

Single-paper inclusion, exclusion, and historical sealed preview are explicit maintenance scopes. Their IDs must remain identical across applicable stages and cannot establish full-batch visual proof.

## 7. Post-Publication Visuals

Only a remotely verified publication can plan TOP 10 paper infographics and the digest cover. Project scripts manage manifests and validated references; only Codex built-in `image_gen` creates final art.

```bash
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

Use only absolute `referencedImagePaths` emitted by `visual:prepare`. Before `record --qa-attested true`, visually verify title, Chinese text, relationships, metric direction, values, and ranking. If the user explicitly waives visuals, issue `digest:waive-visuals`; never relabel pending work as complete.

The batch is complete only when `digest:status` reports closed data, review, remote publication, and visual gates—or a still-valid explicit waiver. Status is a read-time snapshot and must be regenerated after push or record.

## 8. Maintenance and Verification

```bash
npm test
npm run validate:data -- --allow-empty
```

- Reuse `analysis-engine.js` for analysis entry points and shared request wrappers for LLM calls.
- Put Node/Python paths in centralized configuration; use atomic writes and cross-process locks.
- `loadPrompt()` reads the first fenced block. Prompt changes require placeholder, parser, validator, test, SHA, and fingerprint review.
- Logs use millisecond Beijing timestamps, `0600` permissions, and credential redaction.
- Never commit `data/`, `logs/`, `.env`, caches, or secrets.
- Use specific Chinese commit messages that explain reason, scope, and impact.
- Route field-level and troubleshooting questions through [docs/README.md](docs/README.md); do not duplicate Manual internals here.
