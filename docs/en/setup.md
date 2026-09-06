# Installation and Environment

## Audience

For first-time default LLM/API operators and anyone diagnosing project-environment issues. See [workflow.md](workflow.md) for execution and [env.example](../../env.example) for all documented variables.

## Shortest Setup

```bash
npm install
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp env.example .env
```

Node must satisfy `>=20.18.1 <21 || >=22.3.0`. Python must be 3.11+ with an OpenSSL TLS backend; macOS system Python 3.9/LibreSSL is unsupported. Default blog and visual commands use `scripts/python-runtime.sh`, prefer the project `.venv`, then `python3.11`, and only then validate `python3`.

## Minimum `.env`

```dotenv
PAPER_ANALYZER_API_KEY=your-key
# Optional comma-separated fallback accounts for the same OpenCode Go route
PAPER_ANALYZER_FALLBACK_API_KEYS=your-second-key
PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY=your-third-key
PAPER_ANALYZER_MODEL=muse-spark-1.2-contributor
PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
PAPER_DIGEST_BLOG_REPO=/absolute/path/to/audio-paper-digest-blog
```

The documented default is OpenCode Go Muse Spark 1.2 Contributor over OpenAI Responses. Public endpoints must use HTTPS; HTTP is accepted only for loopback test services.

`PAPER_ANALYZER_FALLBACK_API_KEYS` is not load balancing. The current account remains sticky until OpenCode Go returns HTTP 429 with an explicit structured `GoUsageLimitError`; only then is the next account tried immediately. `PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY` is a fixed trailing third-priority account, used after every normal fallback account. Active/cooldown state persists across Node, Python, and dates in `data/runtime/llm-account-pool.json`, and an expired earlier account does not automatically take traffic back. The file contains no raw key but does contain stable credential fingerprints, so it remains `0600` sensitive operational metadata. Generic 429, 5xx, network/proxy errors, truncation, and content-contract failures never switch accounts. Use `PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS` only when an explicitly configured secondary model needs its own pool. A secondary route without its own key inherits the primary pool only when both normalized endpoints identify the same canonical OpenCode Go service; a different service must provide its own key and never inherits the primary pool. Before credentials are attached, the actual request URL must exactly match the canonical API route derived from the endpoint and model.

## Project-Scoped Environment

Node uses `scripts/env-loader.js`; Python uses `scripts/project_env.py`. Both clear inherited project and proxy variables before loading the repository-root `.env`, then tighten it to `0600`.

Do not rely on `.zshrc`, IDE, Trae, or Codex variables to fill missing project configuration. Child processes must use the shared minimal-environment builders so credentials do not leak to curl, Git hooks, browsers, or unrelated CLIs.

## Proxy Responsibilities

| Traffic | Rule |
|---|---|
| exact Muse model | mandatory project HTTP CONNECT, one agent per request |
| arXiv metadata/HTML/PDF/images | mandatory HTTP CONNECT |
| HuggingFace curl | HTTP(S) proxy; optional SOCKS `ALL_PROXY` |
| other LLM providers | direct with `agent:false` |
| external images/demos | HTTPS only; public-IP validation per hop |

A missing proxy is an explicit failure, never a direct fallback. Project scripts that reach a local proxy must run outside the sandbox.

## Capacity Defaults

| Variable | Default |
|---|---:|
| `PD_ANALYSIS_CONCURRENCY` | 3 |
| `PD_ANALYSIS_API_MAX_TOKENS` | 64000 |
| `PD_ANALYSIS_REPAIR_MAX_TOKENS` | 16000 |
| `PD_API_READER_MAX_TOKENS` | 48000 |
| `PD_API_READER_EVIDENCE_MAX_CHARS` | 180000 |
| `PD_API_READER_CONTEXT_MAX_CHARS` | 240000 |
| `PD_API_READER_CONCURRENCY` | 5 (in-process Reader generation slots) |
| `PD_BLOG_REVIEW_CONCURRENCY` | 5 |

Muse filtering uses `PD_FILTER_BATCH_SIZE`, while whole-paper analysis keeps configured concurrency. Pool state uses short locks and never holds a lock across network I/O. Responses uses SSE only when `PD_OPENAI_RESPONSES_STREAM=1`. Reader v3 sends safely materialized official Figures to the primary model; the optional secondary model only enables the legacy canonical image-supplement path. The refresh CLI `--concurrency` controls paper workers and is distinct from `PD_API_READER_CONCURRENCY`.

## Optional Secondary Model

Reader v3 sends safely materialized official Figures directly to the primary model. `PAPER_ANALYZER_SECONDARY_MODEL` only enables the legacy canonical image-supplement selection and insertion plan; it neither replaces primary prose nor scores the paper. An omitted secondary endpoint falls back to the primary endpoint. An omitted secondary key may be reused only when both routes identify the same canonical service; a cross-service secondary route requires an explicit key.

## Blog and Hugo

`PAPER_DIGEST_BLOG_REPO` must identify the actual Hugo repository. Review runs the Hugo gate outside the sandbox. A missing blog repository may skip published-paper deduplication during data-only work, but real publishing cannot proceed.

Publication subprocesses cannot wait forever. Image review, Hugo, local Git operations, commit/hooks, push/remote verification, and visual planning have default absolute deadlines of 120, 300, 30, 180, 180, and 120 seconds. `PD_BLOG_IMAGE_REVIEW_DEADLINE_SECONDS`, `PD_HUGO_GATE_TIMEOUT_SECONDS`, `PD_GIT_LOCAL_TIMEOUT_SECONDS`, `PD_GIT_COMMIT_TIMEOUT_SECONDS`, `PD_GIT_NETWORK_TIMEOUT_SECONDS`, and `PD_VISUAL_PLANNER_TIMEOUT_SECONDS` may override them within the ranges documented in `env.example`. A timeout never issues a false review or remote-OID proof; a valid local publication commit that has not yet been remotely verified remains adoptable on the next run.

## Verify

```bash
node --version
npm test
npm run validate:data -- --allow-empty
node scripts/test-api-key.js
```

Do not use a real daily run as an environment probe.

## Security

Never commit `.env`, `data/`, `logs/`, caches, or credentials. Logs must redact keys, authentication headers, cookies, secrets, passwords, and URL userinfo. Non-dry-run WeChat publishing requires app ID, app secret, and thumbnail media ID; optional channels are outside the default digest. Manual setup starts at [manual/README.md](../../manual/README.md).
