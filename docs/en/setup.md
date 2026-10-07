# Installation and Environment

## Audience

Use this guide to install the default LLM/API daily workflow, or to investigate configuration that the scripts cannot read. See [Workflow](workflow.md) for execution and [env.example](../../env.example) for configuration variables.

## Shortest Setup

```bash
npm install
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp env.example .env
```

Node must satisfy `>=20.18.1 <21 || >=22.3.0`. Python must be 3.11 or later with OpenSSL providing TLS. The macOS system Python 3.9/LibreSSL runtime is unsupported. Blog and visual commands use `scripts/python-runtime.sh`, which prefers the project `.venv`, then `python3.11`, and finally checks `python3`. Tests use the built-in Node test runner. The Python dependencies cover blog generation, Hugo checks, and visual preparation.

After installation, check the directory and its workspace role:

```bash
pwd
npm run workspace:role -- status
```

The daily checkout must have role `daily`. The full-history checkout must have role `history`. Stop if the marker is missing or its recorded real path does not match. Once you have confirmed what the directory is for, bind it with `npm run workspace:role -- set daily` or `npm run workspace:role -- set history`. Do not force a history checkout into the daily role just to get past a check.

## Minimum `.env`

```dotenv
PAPER_ANALYZER_API_KEY=your-key
# Optional comma-separated fallback accounts for the same route
PAPER_ANALYZER_FALLBACK_API_KEYS=your-second-key
PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY=your-third-key
PAPER_ANALYZER_MODEL=muse-spark-1.3-contributor
PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
PAPER_DIGEST_BLOG_REPO=/absolute/path/to/audio-paper-digest-blog
# Optional: retained official metadata/PDF root for historical ICLR 2026 papers
PAPER_DIGEST_ICLR_2026_ACCEPTED_ROOT=/absolute/path/to/iclr2026-paper-scraper
```

The current example uses OpenCode Go `muse-spark-1.3-contributor` through OpenAI Responses, but the project configuration is what actually selects the model. Public endpoints require HTTPS. HTTP is allowed only for loopback test services.

`PAPER_DIGEST_ICLR_2026_ACCEPTED_ROOT` is used only by the historical ICLR 2026 source collector. It must point at retained local official accepted-paper metadata and PDFs. When unset, it defaults to `~/code/github_repos/iclr2026-paper-scraper`. It supplies no daily-fetch input, triggers no download, and is not an arXiv writing source.

### Fallback accounts

The system keeps using the current successful account. It moves forward through the configured accounts only when OpenCode Go returns HTTP 429 `GoUsageLimitError` or HTTP 401 `Insufficient balance`, and it never wraps back to an earlier account. Other authentication 401 responses stop the run. Generic 429, 5xx, network or proxy failures, truncation, and content-validation failures all leave the account in place.

Account selection and cooldown times persist in `data/runtime/llm-account-pool.json` across Node, Python, and dates. An earlier account's cooldown expiring does not move traffic back, and appending accounts does not displace the current successful account. If every later account is unavailable, dispatch stops and the checkpoints stay. Accounts are not rotated to balance traffic.

`PAPER_ANALYZER_FALLBACK_API_KEYS` accepts a comma-separated fallback list. `PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY` follows that list and can hold third, fourth, and later accounts. Use `PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS` for an independent secondary-model pool. A secondary model inherits the primary pool only when both normalized endpoints identify the same OpenCode Go service and the secondary model has no independent key; a different service needs an explicit secondary key.

The pool file stores no raw keys, but the stable credential fingerprints still make it sensitive operational data. Keep its permissions at `0600` and do not upload or archive it. Before attaching credentials, the system checks that the request URL exactly matches the API route derived from the configured endpoint and model.

## Project-Scoped Environment

Node's `scripts/env-loader.js` and Python's `scripts/project_env.py` read the repository-root `.env`. They first clear inherited `PAPER_ANALYZER_*`, `PAPER_DIGEST_*`, `PD_*`, channel variables, and proxy variables in both letter cases, then load the project values and tighten the file permissions to `0600`.

Do not count on `.zshrc`, the IDE, Trae, or Codex to supply missing project values. Child processes must use the shared minimal-environment builders, so model and publication credentials do not leak into curl, Git hooks, browsers, or unrelated commands.

## Proxy Responsibilities

| Traffic | Rule |
|---|---|
| Muse requests | Project HTTP CONNECT through `HTTPS_PROXY` or `HTTP_PROXY`; create a separate proxy connection object for each request and destroy it afterward |
| arXiv metadata, HTML, PDF, and images | Project HTTP CONNECT is required |
| HuggingFace curl | Inherit HTTP(S) proxy settings; SOCKS `ALL_PROXY` is optional |
| Other model providers | Connect directly with `agent:false` by default |
| External images and demos | HTTPS only; validate public IP addresses at every redirect |

If a required proxy is missing, the request stops rather than silently connecting directly. All project scripts and tests must run outside the sandbox, including diagnostics that use a local proxy.

## PDF/TXT source storage

After filtering, `full-fetch.js` uses the project proxy to fetch official HTML text and PDF for each selected arXiv ID, then saves `source.txt`, `source.pdf`, `source-runtime.json`, and `source-manifest.json` under `data/runtime/daily-fresh-source-runs/`. Analysis and publication must use and verify those files rather than an older text cache.

These files are retained paper sources, so `storage:prune` never deletes them. Figure images are prepared and used in the system temporary directory for the current model request, then cleaned up, and they are not saved to a runtime image cache.

Historical rewriting saves the same four files for each arXiv source capture, using a `generation` number to tell separate captures apart under `data/runtime/fetched-arxiv-sources/`. Conference papers use retained local metadata and PDFs after checksum verification. See [Historical rewriting](../history-rewrite.md) for the source requirements.

## Capacity Defaults

| Variable | Default |
|---|---:|
| `PD_ANALYSIS_CONCURRENCY` | 3 papers |
| `PD_ANALYSIS_API_MAX_TOKENS` | 64000 |
| `PD_ANALYSIS_REPAIR_MAX_TOKENS` | 16000 |
| `PD_API_READER_MAX_TOKENS` | 48000 |
| `PD_API_READER_REPAIR_MAX_TOKENS` | 8000 |
| `PD_API_READER_EVIDENCE_MAX_CHARS` | 180000 characters |
| `PD_API_READER_CONTEXT_MAX_CHARS` | 240000 characters |
| `PD_API_READER_CONCURRENCY` | 5 in-process Reader generation tasks |
| `PD_BLOG_REVIEW_CONCURRENCY` | 5 independent page-review tasks |

Muse filtering follows `PD_FILTER_BATCH_SIZE`, while whole-paper analysis follows `PD_ANALYSIS_CONCURRENCY`. Account-pool locks cover selection and state updates, never network requests. Responses uses SSE only when `PD_OPENAI_RESPONSES_STREAM=1`.

A local Reader repair normally allows 8000 output tokens. If a repair truncates exactly at that limit and the candidate is still eligible for one more recovery attempt, the run saves the failed draft and stops. The next explicit resume can use a higher limit, up to 16000 tokens with the default configuration. That attempt is shared with implementation-upgrade recovery and cannot be stacked with it. Custom limits depend on the full-article and base-repair budgets, stay capped at 16000 and `PD_API_READER_MAX_TOKENS`, and do not authorize unlimited attempts. Any model content consumes the extra attempt. A transport failure with no content does not. Truncated JSON is never accepted as a valid candidate or used to bypass content checks.

## Optional Secondary Model

Reader v3 sends safely prepared official figures directly to the primary model, so the model and the chosen protocol must support image inputs. The documented Muse example uses Responses. The shared request layer also supports Chat and Anthropic image formats. `PAPER_ANALYZER_SECONDARY_MODEL` only enables the legacy analysis image-supplement selection and insertion plan. It neither writes the primary prose nor scores the paper. An omitted secondary endpoint falls back to the primary endpoint, and a secondary key can be reused only for the same service.

`PD_API_READER_CONCURRENCY` limits heavy Reader stages inside one process. The refresh command's `--concurrency N` limits how many papers are processed at once, and those papers may still wait for Reader capacity. The two limits are separate.

File logs default to 30 days and 256 MiB in total. Override these with `PD_LOG_RETENTION_DAYS` and `PD_LOG_MAX_TOTAL_BYTES`.

## Blog and Hugo

`PAPER_DIGEST_BLOG_REPO` must point at the real Hugo repository. Data fetching may skip published-paper deduplication when the directory is absent, but real publication cannot. Review runs Hugo checks, so Hugo has to be available outside the sandbox.

Image review, Hugo, local Git operations, commit/hooks, push/remote verification, and visual planning have default absolute deadlines of 120, 300, 30, 180, 180, and 120 seconds. Override them within the ranges in `env.example` using `PD_BLOG_IMAGE_REVIEW_DEADLINE_SECONDS`, `PD_HUGO_GATE_TIMEOUT_SECONDS`, `PD_GIT_LOCAL_TIMEOUT_SECONDS`, `PD_GIT_COMMIT_TIMEOUT_SECONDS`, `PD_GIT_NETWORK_TIMEOUT_SECONDS`, and `PD_VISUAL_PLANNER_TIMEOUT_SECONDS`. A timeout cannot establish a successful review or remote publication. A valid local publication commit that is still waiting for remote verification is kept, so the next run can verify and reuse it.

## Verify

```bash
node --version
npm test
npm run validate:data -- --allow-empty
```

Use `--allow-empty` only for an explicitly empty clean checkout. In a workspace with run data, use `npm run validate:data` to check that data. Tests and diagnostics also run outside the sandbox.

To check model routing on its own, use `node scripts/test-api-key.js`. It sends a real API request and is not part of the offline checks above. Do not use a full daily run as an installation probe.

## Security

Never commit `.env`, `data/`, `logs/`, caches, or credentials. Public model endpoints require HTTPS. Logs must hide keys, authentication headers, cookies, secrets, passwords, and URL user information.

Non-dry-run WeChat publishing also requires `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, and `WECHAT_THUMB_MEDIA_ID`. Optional channels are outside the default digest. Manual setup starts at [manual/README.md](../../manual/README.md).
