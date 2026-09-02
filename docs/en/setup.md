# Installation and Environment

## Audience

For first-time default LLM/API operators and anyone diagnosing project-environment issues. See [workflow.md](workflow.md) for execution and [env.example](../../env.example) for all documented variables.

## Shortest Setup

```bash
npm install
python3 -m pip install -r requirements.txt
cp env.example .env
```

Node must satisfy `>=20.18.1 <21 || >=22.3.0`.

## Minimum `.env`

```dotenv
PAPER_ANALYZER_API_KEY=your-key
PAPER_ANALYZER_MODEL=muse-spark-1.2-contributor
PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
PAPER_DIGEST_BLOG_REPO=/absolute/path/to/audio-paper-digest-blog
```

The documented default is OpenCode Go Muse Spark 1.2 Contributor over OpenAI Responses. Public endpoints must use HTTPS; HTTP is accepted only for loopback test services.

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
| `PD_API_READER_CONCURRENCY` | 5 |
| `PD_BLOG_REVIEW_CONCURRENCY` | 5 |

Muse filtering is always effective batch 1, while whole-paper analysis keeps configured concurrency. Responses uses SSE only when `PD_OPENAI_RESPONSES_STREAM=1`.

## Optional Secondary Model

`PAPER_ANALYZER_SECONDARY_MODEL` enables image selection and insertion planning. The primary still authors text; the secondary neither replaces primary prose nor scores the paper. Secondary endpoint/key fall back to primary values when omitted.

## Blog and Hugo

`PAPER_DIGEST_BLOG_REPO` must identify the actual Hugo repository. Review runs the Hugo gate outside the sandbox. A missing blog repository may skip published-paper deduplication during data-only work, but real publishing cannot proceed.

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
