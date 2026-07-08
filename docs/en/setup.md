# Environment Variables and Configuration

## Environment Variables and Model Configuration

### 6.1 Unified Storage Location

**All environment variables are stored in `the `.env` file in the project root`.**

`.zshrc` is already configured to auto-load:
```zsh
set -a; source the `.env` file in the project root 2>/dev/null; set +a
```

Benefits of this design:
- Sensitive configurations are centralized and never written into scripts
- Automatically injected on shell startup; Python scripts (`publish-wechat-full.py`, etc.) read directly via `os.environ`
- Node scripts read the project-root `.env` via `config.js` and `loadEnvFile()` and write values into the current process environment; existing shell variables take priority and `.env` only fills missing values

### 6.2 Environment Variable Reference

#### Filtering and Deep Analysis (unified under `PAPER_ANALYZER_*`)

| Variable | Description | Default |
|----------|-------------|---------|
| `PAPER_ANALYZER_API_KEY` | LLM API Key | **Required** |
| `PAPER_ANALYZER_ENDPOINT` | LLM API base path (for example `/v1`, `/coding/v1`, or `/anthropic`; scripts append the final request path) | **Required** |
| `PAPER_ANALYZER_MODEL` | LLM model name | **Required** |
| `PAPER_ANALYZER_SECONDARY_MODEL` | Secondary model name; enables image supplementation when set | Optional |
| `PAPER_ANALYZER_SECONDARY_ENDPOINT` | Secondary model API base path; falls back to the primary endpoint when unset | Optional |
| `PAPER_ANALYZER_SECONDARY_API_KEY` | Secondary model API key; falls back to the primary key when unset | Optional |
| `PD_ANALYSIS_CONCURRENCY` | Deep analysis concurrency | 3 |
| `PD_ANALYSIS_MAX_RETRIES` | Per-paper retry count for deep analysis | 2 |
| `PD_REANALYZE_CONCURRENCY` | Re-analysis concurrency | 3 (matches `ANALYSIS_CONFIG.concurrency`) |
| `PD_FILTER_BATCH_SIZE` | LLM filtering batch size | 5 |
| `PD_ARXIV_MAX_RESULTS` | Number of papers to fetch per arXiv category | 100 |
| `PD_IMAGE_MAX_BYTES` | Raw byte-size limit per image for deep analysis | 6291456 |
| `PD_IMAGE_MAX_BASE64_CHARS` | Base64 character limit per image for deep analysis | 8388608 |
| `PD_IMAGE_TOTAL_BASE64_CHARS` | Total image base64 character limit per paper | 20971520 |
| `PD_LOG_MAX_FILES` | Number of log files to keep | 50 |
| `PD_LOG_MAX_BYTES` | Max bytes written to one log file; later output remains terminal-only | 10485760 |
| `PD_LOG_TOTAL_MAX_BYTES` | Total retained bytes under `logs/` | 262144000 |
| `PAPER_DIGEST_DISABLE_FILE_LOGS` / `PD_DISABLE_FILE_LOGS` | Set to `1` to disable file logs | Disabled |

**API Protocol Auto-Routing**: `detectApiType()` in `scripts/utils.js` automatically selects OpenAI or Anthropic protocol based on the endpoint and model name.
- **Anthropic Protocol** (auto-masquerades as Claude Code): endpoint contains `token-plan` or `coding` **and** model contains `mimo` or `kimi`
  - **MiMo Token Plan**: `https://token-plan-cn.xiaomimimo.com/v1` -> `https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages`
  - **Kimi Coding Plan**: `https://api.kimi.com/coding/v1` -> `https://api.kimi.com/coding/v1/messages` (no `/anthropic` intermediate path needed)
  - Headers: `x-api-key` + `anthropic-version: 2023-06-01` + `User-Agent: claude-cli/<version> (external, cli)` (version dynamically obtained from local `claude --version`, falls back to `2.1.108` on failure)
- **OpenAI Protocol** (generic mode): all other endpoints/models
  - Endpoint is left as-is; `/v1/chat/completions` is auto-appended
  - Headers: `Authorization: Bearer {key}`

#### Blog Publishing

| Variable | Description | Default |
|----------|-------------|---------|
| `PAPER_DIGEST_BLOG_REPO` | Local path to the Hugo blog repository | `~/code/github_repos/audio-paper-digest-blog` |
| `PAPER_DIGEST_BLOG_BASE_PATH` | Base URL path of the blog site (affects internal links) | `/audio-paper-digest-blog` |
| `PAPER_DIGEST_BLOG_URL` | Deployed blog URL (e.g. `https://nanless.github.io/audio-paper-digest-blog/posts`) | `https://nanless.github.io/audio-paper-digest-blog/posts` |
| `PAPER_DIGEST_GITHUB_REMOTE` | Git remote name | `origin` |

#### WeChat Official Account

| Variable | Description |
|----------|-------------|
| `WECHAT_APP_ID` | WeChat Official Account AppID |
| `WECHAT_APP_SECRET` | WeChat Official Account AppSecret |
| `WECHAT_THUMB_MEDIA_ID` | Permanent cover image media ID (optional; default material is used if not set) |
| `PAPER_DIGEST_AUTHOR` | Article author name for WeChat Official Account (optional) |

#### Feishu (Lark) Documents

| Variable | Description |
|----------|-------------|
| `FEISHU_APP_ID` | Feishu app ID (e.g. `cli_xxx`) |
| `FEISHU_APP_SECRET` | Feishu app App Secret |

> Write these into `the `.env` file in the project root` (no `export` prefix needed). Scripts will automatically `source` this file at runtime.

#### Proxy

| Variable | Description |
|----------|-------------|
| `https_proxy` / `HTTPS_PROXY` | HTTPS proxy |
| `http_proxy` / `HTTP_PROXY` | HTTP proxy |
| `all_proxy` / `ALL_PROXY` | Global proxy |

HTTP CONNECT proxies are supported, implemented with pure Node built-in modules, no external dependencies. Auto-detection order: environment variables -> macOS system proxy (`scutil --proxy`).

### 6.3 Configuration Example

`the `.env` file in the project root` format (**no `export` prefix needed**):

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

All main scripts automatically write logs on startup:

- **Node scripts**: via `scripts/log-setup.js`
- **Python scripts**: via `scripts/log_setup.py`
- **Output location**: `logs/<script-name>-YYYYMMDD-HHMMSS.log`
- **Features**: simultaneous terminal and file output (tee mode), timely flush
- **Auto-cleanup**: old logs are cleaned up on each startup, keeping the most recent 50 by default with a 250MB total cap; each log file writes at most 10MB by default, then continues terminal-only

Special logs:
- `backfill_papers.py` additionally writes to `logs/backfill.log` (persistent append mode)
- `logs/full-fetch-*.log` are the first place to check when debugging fetch/analysis issues

**Background Buffer Handling**: all major Node scripts call `process.stdout._handle.setBlocking(true)` to ensure real-time log flush when running in the background.

---

---

## Installation and Initialization

### 9.1 Dependencies

- **Node.js** >= 18.0.0 (`node` / `npm`)
- **Python** 3.x (`python3` / `pip3`)
- Node.js dependency: `cheerio` (arXiv HTML structured parsing)
- Python third-party libraries: see the root `requirements.txt` (`python-dotenv`, `requests`, `playwright`)

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

# Ensure .zshrc sources the `.env` file in the project root
# (If not yet configured, add to the end of ~/.zshrc: set -a; source the `.env` file in the project root 2>/dev/null; set +a)
```

### 9.3 Blog Repository Setup

Blog publishing requires a locally cloned Hugo blog repository. The default path is `~/code/github_repos/audio-paper-digest-blog`, customizable via the `PAPER_DIGEST_BLOG_REPO` environment variable:

```bash
# Default path (default when env is not set)
git clone https://github.com/nanless/audio-paper-digest-blog.git \
  ~/code/github_repos/audio-paper-digest-blog

# Or custom path
export PAPER_DIGEST_BLOG_REPO="~/my-blog-repo"
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
   dates = [p.get('published', '')[:10] for p in papers if p.get('published')]
   print('Total papers:', len(papers))
   print('Date distribution:', Counter(dates))
   PY
   ```

3. **When the user explicitly says "do not touch a certain day", deleting/overwriting content for that date is prohibited**
   - `publish-to-blog.py` fully rewrites the summary page for the target date
   - If the data file contains papers from multiple dates, split the data or confirm intent before publishing

4. **Do not publish the same day repeatedly**
   - Re-running `publish-to-blog.py --date 2026-04-21` will overwrite that day's blog files
   - To append papers, regenerate the complete data first, then publish

---
