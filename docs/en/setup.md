# Environment Variables and Configuration

## Environment Variables and Model Configuration

### 6.1 Unified Storage Location

**All environment variables are stored in `the `.env` file in the project root`.**

Benefits of this design:
- Sensitive configurations are centralized and never written into scripts
- Node scripts read the project-root `.env` through `scripts/env-loader.js` / `loadEnvFile()`
- Python scripts read the project-root `.env` through `scripts/project_env.py`
- Scripts clear inherited project-scoped variables from Trae/Codex/shell before loading the current project's `.env`, preventing mixed-provider key/model/endpoint combinations

### 6.2 Environment Variable Reference

#### Filtering and Deep Analysis (unified under `PAPER_ANALYZER_*`)

| Variable | Description | Default |
|----------|-------------|---------|
| `PAPER_ANALYZER_API_KEY` | LLM API Key | **Required** |
| `PAPER_ANALYZER_ENDPOINT` | LLM API base path (for example `/v1`, `/coding/v1`, or `/anthropic`; scripts append the final request path) | **Required** |
| `PAPER_ANALYZER_MODEL` | LLM model name | **Required** |
| `PAPER_ANALYZER_SECONDARY_MODEL` | Secondary model name; enables image selection and insertion planning when set | Optional |
| `PAPER_ANALYZER_SECONDARY_ENDPOINT` | Secondary model API base path; falls back to the primary endpoint when unset | Optional |
| `PAPER_ANALYZER_SECONDARY_API_KEY` | Secondary model API key; falls back to the primary key when unset | Optional |
| `PD_ANALYSIS_CONCURRENCY` | Deep analysis concurrency | 3 |
| `PD_ANALYSIS_MAX_RETRIES` | Per-paper retry count for deep analysis | 2 |
| `PD_ANALYSIS_REPAIR_MAX_TOKENS` | Output-token cap for revision, table, method, and structure repair stages | 16000 |
| `PD_REANALYZE_CONCURRENCY` | Re-analysis concurrency | 3 (matches `ANALYSIS_CONFIG.concurrency`) |
| `PD_FILTER_BATCH_SIZE` | LLM filtering batch size | 5 |
| `PD_ARXIV_MAX_RESULTS` | Number of papers to fetch per arXiv category | 100 |
| `PD_IMAGE_MAX_BYTES` | Raw byte-size limit per image for deep analysis | 6291456 |
| `PD_IMAGE_MAX_BASE64_CHARS` | Base64 character limit per image for deep analysis | 8388608 |
| `PD_IMAGE_TOTAL_BASE64_CHARS` | Total image base64 character limit per paper | 20971520 |
| `PD_ARXIV_FETCH_TIMEOUT_MS` | arXiv HTML/image discovery timeout in milliseconds | 60000 |
| `PD_ARXIV_PDF_TIMEOUT_MS` | arXiv PDF fallback timeout in milliseconds | 180000 |
| `PD_ARXIV_PDF_MAX_BYTES` | Maximum arXiv PDF fallback size | 52428800 |
| `PD_SCORING_AUDIT_TEMPERATURE` | Final scoring-audit temperature | 0.1 |
| `PD_IMAGE_PLAN_TEMPERATURE` | Secondary image-plan temperature | 0.2 |
| `PD_IMAGE_INSERTION_MAX` | Maximum inserted high-value figures per paper | 4 |
| `PAPER_DIGEST_ENABLE_FILE_LOGS` / `PD_ENABLE_FILE_LOGS` | Backward-compatible setting; file logs are now enabled by default | Enabled |
| `PAPER_DIGEST_DISABLE_FILE_LOGS` / `PD_DISABLE_FILE_LOGS` | Set to `1` to force-disable file logs | Disabled |

**API Protocol Auto-Routing**: `detectApiType()` in `scripts/utils.js` automatically selects OpenAI or Anthropic protocol based on endpoint and model, in this priority order:
- **DeepSeek**: endpoints containing `deepseek.com` or models containing `deepseek` are forced to OpenAI; `/anthropic` paths are converted to `/v1/chat/completions`
- **MiMo Token Plan**: endpoint contains `token-plan` and model contains `mimo`, using Anthropic; `https://token-plan-cn.xiaomimimo.com/v1` -> `https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages`
- **Kimi Coding Plan**: the `coding` endpoint on `api.kimi.com` uses Anthropic, including model names such as `k3` that do not contain `kimi`; both `https://api.kimi.com/coding` and `https://api.kimi.com/coding/v1` normalize to `https://api.kimi.com/coding/v1/messages` with no `/anthropic` intermediate path
- **Generic `/anthropic` endpoint**: non-DeepSeek endpoints containing `/anthropic` use Anthropic and append `/messages`
- **Other endpoints/models**: use OpenAI and append `/v1/chat/completions`

#### Blog Publishing

| Variable | Description | Default |
|----------|-------------|---------|
| `PAPER_DIGEST_BLOG_REPO` | Local path to the Hugo blog repository | `~/code/github_repos/audio-paper-digest-blog` |
| `PAPER_DIGEST_BLOG_BASE_PATH` | Base URL path of the blog site (affects internal links) | `/audio-paper-digest-blog` |
| `PAPER_DIGEST_BLOG_URL` | Deployed blog URL (e.g. `https://nanless.github.io/audio-paper-digest-blog/posts`) | `https://nanless.github.io/audio-paper-digest-blog/posts` |
| `PAPER_DIGEST_REPO_URL` | Project repository URL appended to Xiaohongshu and related copy | `github.com/nanless/audio-paper-digest` |
| `PAPER_DIGEST_GITHUB_REMOTE` | Git remote name | `origin` |

#### WeChat Official Account

| Variable | Description |
|----------|-------------|
| `WECHAT_APP_ID` | WeChat Official Account AppID |
| `WECHAT_APP_SECRET` | WeChat Official Account AppSecret |
| `WECHAT_THUMB_MEDIA_ID` | Permanent cover image media ID (optional; default material is used if not set) |
| `PAPER_DIGEST_AUTHOR` | Article author name for WeChat Official Account (optional) |

#### Xiaohongshu

| Variable | Description |
|----------|-------------|
| `XIAOHONGSHU_COOKIES` | Cookie used by automated Xiaohongshu publishing; can be obtained via `npm run xhs-login` |
| `PD_XIAOHONGSHU_ONELINER_CONCURRENCY` | LLM concurrency for TOP-N one-liners; range 1–5 (default: `5`) |

#### Feishu (Lark) Documents

| Variable | Description |
|----------|-------------|
| `FEISHU_APP_ID` | Feishu app ID (e.g. `cli_xxx`) |
| `FEISHU_APP_SECRET` | Feishu app App Secret |

> Write these into the `.env` file in the project root (no `export` prefix needed). Scripts read the current project's `.env` directly at runtime.

The Node/Python loaders clear same-name inherited project variables before loading this file and tighten `.env` permissions to `0600`. LLM calls require API key, endpoint, and model together; no entry point fills a partial configuration with hard-coded OpenAI defaults.

#### Execution Environment

**Every project script must run outside the sandbox**, including direct `scripts/*.js`, `scripts/*.py`, `run-daily-digest.sh`, `run-full-fetch.sh`, and `scripts/*.sh` invocations. Node `env-loader.js`, Python `project_env.py`, and shell entry points reject `CODEX_SANDBOX` before logging, network requests, file writes, or business logic. Unit-test module imports do not trigger the guard. The external-runtime wrapper may preserve a network-disabled marker, so that marker alone cannot identify a sandbox.

#### Proxy

| Variable | Description |
|----------|-------------|
| `HTTPS_PROXY` | **Required** HTTP CONNECT proxy for arXiv Node fetches, for example `http://127.0.0.1:7897` |
| `HTTP_PROXY` | **Required** HTTP CONNECT proxy, normally the same as `HTTPS_PROXY` |
| `ALL_PROXY` | Optional SOCKS/global proxy for HuggingFace `curl`, for example `socks5h://127.0.0.1:7897` |
| `NO_PROXY` | Local-address allow list, for example `localhost,127.0.0.1,::1` |

Fetch proxy configuration is mandatory: arXiv metadata, HTML/PDF/images, HuggingFace Papers, historical backfill, and WeChat's arXiv image downloads reject direct fallback when it is missing. Node and Python HTTP fetches only support HTTP CONNECT, so `HTTPS_PROXY` / `HTTP_PROXY` cannot be SOCKS URLs; HuggingFace `curl` may additionally use `ALL_PROXY=socks5h://...`. LLM requests always use direct connections and never use the fetch proxy. Proxy values are loaded only from the project-root `.env`; same-name shell/IDE values are cleared and macOS `scutil` is not consulted. Commands that need a local proxy must run outside the sandbox, because sandbox loopback cannot reach `127.0.0.1`.

Blog generation, review, and push must also run outside the sandbox, including the generation-only stage. `generate-blog.py`, `review-blog.py`, `push-blog.py`, and compatibility `publish-to-blog.py` reject the reliable `CODEX_SANDBOX` marker; the elevation wrapper may preserve the network-disabled marker, so it cannot independently reject an external runtime.

### 6.3 Configuration Example

Project-root `.env` format (**no `export` prefix needed**):

```bash
# Paper Digest environment variables

# === Option 1: MiMo Token Plan (recommended; masquerades as Claude Code via Anthropic protocol) ===
PAPER_ANALYZER_API_KEY=tp-your-token-plan-key
PAPER_ANALYZER_MODEL=mimo-v2.5
PAPER_ANALYZER_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1

# === Option 2: MiMo Pay-as-you-go (generic OpenAI protocol) ===
# PAPER_ANALYZER_API_KEY=sk-your-pay-as-you-go-key
# PAPER_ANALYZER_MODEL=mimo-v2.5
# PAPER_ANALYZER_ENDPOINT=https://api.xiaomimimo.com/v1

# === Option 3: Kimi Coding Plan (masquerades as Claude Code via Anthropic protocol) ===
# PAPER_ANALYZER_API_KEY=sk-your-kimi-key
# PAPER_ANALYZER_MODEL=kimi-for-coding
# PAPER_ANALYZER_ENDPOINT=https://api.kimi.com/coding/v1

# === Option 4: Generic OpenAI-compatible endpoint ===
# PAPER_ANALYZER_API_KEY=sk-your-openai-key
# PAPER_ANALYZER_MODEL=gpt-4o
# PAPER_ANALYZER_ENDPOINT=https://api.openai.com/v1

# WeChat Official Account (if publishing is needed)
WECHAT_APP_ID=your-app-id
WECHAT_APP_SECRET=your-app-secret
# PAPER_DIGEST_AUTHOR=your-name

# Feishu (shared with other projects)
FEISHU_APP_ID=your-feishu-app-id
FEISHU_APP_SECRET=your-feishu-app-secret

# Blog / Xiaohongshu (if blog URL needs to be shown in copy)
# PAPER_DIGEST_BLOG_URL=https://nanless.github.io/audio-paper-digest-blog/posts
```

**Important Notes**:
- Endpoint format is uniformly `protocol://domain/v1`, regardless of which protocol is used downstream
- Scripts automatically determine whether to use the Anthropic protocol based on endpoint and model name
- Token Plan keys start with `tp-`, pay-as-you-go keys start with `sk-`; the two cannot be mixed up

---

---

## Logging Mechanism

All main scripts write to both the terminal and `logs/*.log` by default. To disable file logs, set `PD_DISABLE_FILE_LOGS=1` or `PAPER_DIGEST_DISABLE_FILE_LOGS=1` in the project-root `.env`.

- **Node scripts**: via `scripts/log-setup.js`
- **Python scripts**: via `scripts/log_setup.py`
- **Default output location**: `logs/<script-name>-YYYYMMDD-HHMMSS-<pid>-<seq>.log`
- **Default behavior**: UTF-8 plain text, `0600` permissions, unique files, synchronous persistence, and central redaction of authentication headers, cookies, tokens, secrets, passwords, actual configured key values, and URL userinfo
- **No limits and no automatic cleanup**: logs have no count, total-size, or per-file-size limit, and old logs are not deleted automatically

`backfill_papers.py` uses the same unified per-run log and no longer appends a second `logs/backfill.log`. `logs/full-fetch-*.log` can help debug fetch/analysis issues; terminal output is still preserved.

**Background Buffer Handling**: all major Node scripts call `process.stdout._handle.setBlocking(true)` to ensure real-time log flush when running in the background.

---

---

## Installation and Initialization

### 9.1 Dependencies

- **Node.js** >= 18.0.0 (`node` / `npm`)
- **Python** 3.x (`python3` / `pip3`)
- Node.js dependency: `cheerio` (arXiv HTML structured parsing)
- Python third-party libraries: see the root `requirements.txt` (`requests`, `playwright`)

### 9.2 Initialization

```bash
cd /path/to/audio-paper-digest

# Install Node.js dependencies
npm install

# Install Python dependencies (if needed)
pip3 install -r requirements.txt

# Create required directories
mkdir -p data/current data/archive logs

# Configure API Key
cat >> the `.env` file in the project root << 'EOF'
PAPER_ANALYZER_API_KEY=your-llm-key
PAPER_ANALYZER_MODEL=your-llm-model
PAPER_ANALYZER_ENDPOINT=https://your-llm-endpoint/v1

# If WeChat Official Account publishing is needed, also set:
# WECHAT_APP_ID=your-app-id
# WECHAT_APP_SECRET=your-app-secret
EOF

# Save the file and run scripts directly; scripts read the current project-root `.env`
```

### 9.3 Blog Repository Setup

Blog publishing requires a locally cloned Hugo blog repository. The default path is `~/code/github_repos/audio-paper-digest-blog`, customizable via `PAPER_DIGEST_BLOG_REPO` in the project-root `.env`:

```bash
# Default path (default when env is not set)
git clone https://github.com/nanless/audio-paper-digest-blog.git \
  ~/code/github_repos/audio-paper-digest-blog

# Or custom path
PAPER_DIGEST_BLOG_REPO="~/my-blog-repo"
```

Blog repository requirements:
- Hugo site using the PaperMod theme (or another standard theme)
- Auto-deployed to GitHub Pages via GitHub Actions
- `content/posts/` directory stores generated Markdown files
- If the blog is deployed under a sub-path, set `PAPER_DIGEST_BLOG_BASE_PATH` (e.g. `/audio-paper-digest-blog`)

### 9.4 Feishu Credentials Setup

Publishing to Feishu documents requires the `App ID` and `App Secret` of a Feishu custom app:

```bash
# Write to the `.env` file in the project root
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=your-full-app-secret
```

> How to obtain: Feishu Open Platform -> Developer Console -> Create enterprise self-built app -> View credentials.

---

---

## Date Safety Policy (Must Follow)

1. **Always explicitly specify `--date` when publishing**
   - Do not rely on the script's default "today"
   - Pay extra attention when running across midnight

2. **Before publishing, confirm the date distribution of papers in the input data file**
   ```bash
   python3 - <<'PY'
   import json
   from collections import Counter
   with open('data/current/deep-analysis-result.json') as f:
       d = json.load(f)
   papers = d.get('papers', [])
   dates = [p.get('fetchedAt', '')[:10] for p in papers if p.get('fetchedAt')]
   print('Total papers:', len(papers))
   print('fetchedAt batch date distribution:', Counter(dates))
   PY
   ```

3. **When the user explicitly says "do not touch a certain day", deleting/overwriting content for that date is prohibited**
   - Blog generation/review/push does not depend on visual assets; `generate-blog.py` installs only the digest index and every paper page
   - `push-blog.py` plans TOP 10 infographics and the digest image only after remote OID verification
   - If the data file contains papers from multiple dates, split the data or confirm intent before publishing

4. **Do not publish the same day repeatedly**
   - Re-running `generate-blog.py --date 2026-04-21` overwrites that day's files and requires a new `review-blog.py` run. `push-blog.py` accepts only an unchanged SHA-256 review receipt.
   - To append papers, regenerate the complete data first, then publish

5. **Resume visual assets; do not redraw everything**
   - A remotely verified publication receipt is mandatory; `npm run visual:post-publish -- --date YYYY-MM-DD` plans only the final-score TOP 10
   - Then run `npm run visual:prepare -- --date YYYY-MM-DD` to validate `.bin` reference caches and emit upload-ready `referencedImagePaths` for built-in generation
   - `visual:post-publish` plans both image types while holding the blog transaction lock; only missing, failed, damaged, publication/analysis/prompt-invalidated, or newly TOP-10 infographics return to pending
   - the digest image is replanned only when the published-paper snapshot, hot directions, ranking, category, publication commit, or prompt changes
   - Register assets with their own `record` commands, then rerun both status gates. Never hand-edit manifests or bypass SHA/task-token checks

---
