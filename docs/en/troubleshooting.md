# Troubleshooting Guide

## Troubleshooting Guide

### 12.1 Model Call Failure / API Returns 401 / 403

**Checklist**:

1. **Verify the key/endpoint/model triplet**
   - MiMo Token Plan keys start with `tp-` and must be used with the Token Plan endpoint `token-plan-cn.xiaomimimo.com`
   - MiMo pay-as-you-go keys start with `sk-` and must be used with the pay-as-you-go endpoint `api.xiaomimimo.com`
   - Mixing the two will always return 401

2. **Check that the correct protocol is being used**
   - Look for `[filter] API 类型: xxx` or `[api] → model | xxx` in terminal output or `logs/*.log` to confirm whether it shows `anthropic` or `openai`
   - If you are using MiMo/Kimi Token Plan but it shows `openai`, check whether the endpoint contains `token-plan` or `coding`, and whether the model name contains `mimo` or `kimi`

3. **Anthropic protocol checks** (when output shows `anthropic`)
   - Confirm the request header includes `User-Agent: claude-cli/<version> (external, cli)` (this won't appear directly in terminal output, but can be verified with tcpdump or a proxy tool)
   - Confirm you are using `x-api-key` instead of `Authorization: Bearer`
   - Confirm the URL path is correct: MiMo Token Plan uses `/anthropic/v1/messages`, Kimi Coding Plan uses `/coding/v1/messages`, not `/v1/chat/completions`

4. **OpenAI protocol checks** (when output shows `openai`)
   - Confirm you are using `Authorization: Bearer {key}`
   - Confirm the URL path is `/v1/chat/completions`

5. **Check proxy settings**
   - MiMo Token Plan may be blocked when a system proxy is active; try disabling the proxy or setting `agent: false`
   - See Section 12.7 for details

6. **Review output**: check `logs/full-fetch-*.log`, `logs/deep-analyzer-*.log`; full terminal output is still preserved

### 12.2 Deep Analysis Is Slow or Frequently Fails

- Review `logs/deep-analyzer-*.log`, `logs/full-fetch-*.log`; full terminal output is still preserved
- `analysisSource=abstract` means both HTML and PDF full text were unavailable. Publishing blocks it by default; explicit human approval requires `allowAbstractAnalysisPublish: true`. Never remove provenance fields to disguise an abstract-only result
- Successful figures are cached under `data/current/image-cache/`. Use `imageManifest.downloadOutcomes` for permanent versus transient failures and `imageManifest.supplement.insertionDiagnostics` for invalid `paragraph_id` values; do not restore section-end fallback
- Check whether the key/endpoint/model triplet is correct (see Section 12.1)
- If a timeout occurs, the script will automatically fall back to plain-text retry; if it still fails, check the proxy or reduce concurrency
- You can safely resume with `node scripts/deep-analysis-only.js`

### 12.3 Re-analysis Reports "Key Not Configured" on Startup

- Configure `PAPER_ANALYZER_API_KEY`, `PAPER_ANALYZER_MODEL`, and `PAPER_ANALYZER_ENDPOINT` in `the `.env` file in the project root`
- Re-run the script; do not rely on `.zshrc` / Trae / Codex outer environment variables to fill project configuration

### 12.4 "No New Content to Push" After Publishing

Check in the blog repository:
```bash
cd ~/code/github_repos/audio-paper-digest-blog
git status --short
ls -lt content/posts | head -20
```

Possible causes:
- Only `generate-blog.py` or `review-blog.py` ran; an explicit `push-blog.py` invocation is required for remote publication
- `push-blog.py` cannot find a review receipt or a reviewed file SHA-256 changed; run `review-blog.py` again
- Data file is empty or paper analysis failed
- Target date file already exists with identical content

### 12.5 Path Confusion

- **Prefer** `data/current/deep-analysis-result.json`
- The legacy path `data/deep-analysis-result.json` is only read for backward compatibility
- If both old and new paths exist, scripts prefer `data/current/`

### 12.6 HuggingFace Fetch Returns Empty

- Check the project-root `.env` contains both `HTTPS_PROXY=http://127.0.0.1:7897` and `HTTP_PROXY=http://127.0.0.1:7897`; if the local proxy provides SOCKS, also set `ALL_PROXY=socks5h://127.0.0.1:7897`
- Run `node scripts/fetch-huggingface-papers.js` **outside the sandbox**. A sandbox cannot reach the local `127.0.0.1:7897` proxy, so that result does not diagnose HuggingFace or the proxy
- `fetch-huggingface-papers.js` uses `curl`; ensure it is available. The script deliberately errors without project proxy configuration to avoid pseudo-success empty output

### 12.6.1 arXiv Fetch or Full-Text Download Fails

- arXiv metadata, HTML, PDF and images all require the project `.env` `HTTPS_PROXY` / `HTTP_PROXY`. Both must be `http://` or `https://` HTTP CONNECT URLs; SOCKS `ALL_PROXY` alone is insufficient
- Verify outside the sandbox with `node scripts/quick-test.js` or the full workflow. Sandbox loopback failure is an environment limitation
- LLM routing is independent: ensure every Node LLM request remains `agent: false` and never receives a proxy agent/dispatcher

### 12.7 MiMo API Returns 403 / Proxy Issues

**Root cause**: Node.js `https.request` with `agent: undefined` still reuses the global default agent's connection pool. When a system proxy is configured (via `https_proxy` or similar environment variables), connections from the global agent may be tainted by the proxy, causing the MiMo Token Plan server to reject the request.

**Fix**: Every Node LLM request, including `test-api-key.js`, must set `options.agent` to `false` (not `undefined`), completely disabling connection reuse and forcing each request to establish a new connection:

```javascript
const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: headers,
    agent: false,  // ← must be false; undefined is not enough
    signal: controller.signal
};
```

**Verification**: Test directly with `curl --noproxy "xiaomimimo.com"`. If bypassing the proxy succeeds while the script fails, this is the issue.

### 12.8 Image Upload to WeChat CDN Fails

- Check whether `WECHAT_APP_ID` / `WECHAT_APP_SECRET` have expired
- Check whether the image is too large or restricted by arXiv
- WeChat image uploads are rate-limited; large batches may need to be executed in chunks

### 12.9 API Protocol Routing Verification

Run `node scripts/test-api-key.js` to test whether the API configuration is correct — it prints the detected protocol type (`openai` / `anthropic`), the actual request URL, and the model response. If you use MiMo/Kimi Token Plan but the output shows `openai`, check whether the endpoint contains `token-plan` or `coding` and whether the model name contains `mimo` or `kimi`.

### 12.10 `npm run fetch` killed by SIGTERM (exit code 143) when running in background

**Root cause**: npm creates a controlling TTY to run the child process; when terminal signal handling misbehaves, the child may receive SIGTERM and npm returns exit code 143.

**Fix**: invoke `node scripts/full-fetch.js` directly to bypass npm's process management. The root-level `run-full-fetch.sh` already wraps this behavior (`exec node scripts/full-fetch.js`).

---
