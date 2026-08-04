# 排错手册

## 排错手册

### 12.1 模型调用失败 / API 返回 401 / 403

**检查步骤**：

1. **检查 key/endpoint/model 三元组是否匹配**
   - MiMo Token Plan key 前缀为 `tp-`，必须配合 Token Plan 端点 `token-plan-cn.xiaomimimo.com`
   - MiMo 按量付费 key 前缀为 `sk-`，必须配合按量付费端点 `api.xiaomimimo.com`
   - 两者混用必返回 401

2. **检查是否走对了协议**
   - 查看终端输出或 `logs/*.log` 中的 `[filter] API 类型: xxx` / `[api] → model | xxx` 行，确认显示 `anthropic` 还是 `openai`
   - 若 MiMo Token Plan 显示 `openai`，检查 `token-plan` 端点和 MiMo 域名/模型；Kimi Coding 应使用 `kimi.com/coding`，`k3` 无需在模型名中含 `kimi`

3. **Anthropic 协议专项检查**（输出显示 `anthropic` 时）
   - 确认请求头中包含 `User-Agent: claude-cli/<version> (external, cli)`（终端输出中不会直接显示，但可以用 tcpdump 或代理工具验证）
   - 确认使用的是 `x-api-key` 而非 `Authorization: Bearer`
   - 确认 URL 路径正确：MiMo Token Plan 是 `/anthropic/v1/messages`，Kimi Coding Plan 是 `/coding/v1/messages`，而不是 `/v1/chat/completions`

4. **OpenAI 协议专项检查**（输出显示 `openai` 时）
   - 确认使用 `Authorization: Bearer {key}`
   - 确认 URL 路径是 `/v1/chat/completions`

5. **检查代理**
   - MiMo Token Plan 在有系统代理时可能被屏蔽，尝试关闭代理或设置 `agent: false`
   - 详见 12.7 节

6. **查看输出**：查看 `logs/full-fetch-*.log`、`logs/deep-analyzer-*.log`，同时保留终端完整输出

### 12.2 深度分析慢或频繁失败

- 查看 `logs/deep-analyzer-*.log`、`logs/full-fetch-*.log`，同时保留终端完整输出
- 若成功结果的 `analysisSource=abstract`，说明 HTML/PDF 全文均不可用；该结果默认被博客发布预检阻断。人工确认必须发布时显式设置 `allowAbstractAnalysisPublish: true`，不要删除来源字段伪装成全文结果
- 图片成功缓存位于 `data/current/image-cache/`；查看 `imageManifest.downloadOutcomes` 区分永久拒绝与瞬时错误，查看 `imageManifest.supplement.insertionDiagnostics` 排查非法 `paragraph_id`。禁止恢复章节末尾兜底
- 检查 key/endpoint/model 三元组是否匹配（见 12.1 节）
- 若超时，脚本会自动降级为纯文本重试；若仍失败，检查代理或减小并发
- 可用 `node scripts/deep-analysis-only.js` 安全续跑

### 12.3 重分析启动即报 key 未配置

- 在 `项目根目录的 `.env` 文件` 中配置 `PAPER_ANALYZER_API_KEY`、`PAPER_ANALYZER_MODEL`、`PAPER_ANALYZER_ENDPOINT`
- 重新运行脚本即可；不要依赖 `.zshrc` / Trae / Codex 外层环境变量补齐项目配置

### 12.4 发布后提示"没有新内容需要推送"

在博客仓库检查：
```bash
cd ~/code/github_repos/audio-paper-digest-blog
git status --short
ls -lt content/posts | head -20
```

可能原因：
- 只运行了 `generate-blog.py` 或 `review-blog.py`；正式推送必须显式运行 `push-blog.py`
- `push-blog.py` 找不到审查凭证，或 review 后文件 SHA-256 已变更：需重新运行 `review-blog.py`
- 数据文件为空或论文分析失败
- 目标日期文件已存在且内容相同

### 12.4.1 全部博客发布后未建立视觉任务

- 先检查 `blog-review-receipt-YYYY-MM-DD.json` 是否同时包含相同的 `publicationCommit`、`remoteVerifiedOid` 和 `remoteVerifiedAt`；缺少时说明远端发布尚未验证，不能生图
- 远端验证完成后运行 `npm run visual:post-publish -- --date YYYY-MM-DD`；完整输出只列出 TOP 10 pending/failed 长图和一张汇总图
- manifest 缺失或发布版本/分析/prompt/热门方向/排名/category 变化时，重新运行 `visual:post-publish`；`status` 只读报告过期、缺失、失败、PNG 损坏或 SHA 不符，不会修改任务
- 使用 Codex 内置 `image_gen` 生成待处理项，目视核对英文标题、中文正文、论文数字和排行榜无误后，再通过 `visual:record` 或 `cover:record` 登记；旧 token 被拒绝时必须重新读取最新规划，禁止覆盖新任务
- 若参考图缓存路径以 `.bin` 结尾，不要直接上传或手工改名；先运行 `npm run visual:prepare -- --date YYYY-MM-DD [--paper ID]`，再把输出的绝对 `referencedImagePaths` 交给内置 `image_gen`（`relativePath` 仅供日志展示）。命令会阻断缓存 SHA、字节数、MIME、文件头或路径不一致，避免上传阶段出现误导性的 network error
- 两个 status 都返回 0 即表示发布后图片完成；图片独立于已经完成的博客事务，无需也不得因此重新 generate/review

### 12.5 路径混淆

- **优先使用** `data/current/deep-analysis-result.json`
- 旧路径 `data/deep-analysis-result.json` 仅在兼容场景下读取
- 若同时存在新旧路径，脚本优先选择 `data/current/`

### 12.5.1 博客阶段提示必须沙箱外运行

- `generate-blog.py`、`review-blog.py`、`push-blog.py` 与兼容 `publish-to-blog.py` 会主动拒绝可靠沙箱标志 `CODEX_SANDBOX`；沙箱外权限包装可能保留网络禁用标志，不能单独据此判定仍在沙箱内
- 应以沙箱外权限重跑**同一阶段**；这不是内容问题，不要无故重新生成，也绝不能跳过 LLM/图片审查或伪造 SHA-256 审查凭证

### 12.6 HuggingFace 抓取为空

- 检查项目根 `.env` 是否至少有 `HTTPS_PROXY=http://127.0.0.1:7897` 或 `HTTP_PROXY=http://127.0.0.1:7897` 其中一项；若本机代理提供 SOCKS，可再设置 `ALL_PROXY=socks5h://127.0.0.1:7897`
- 在**沙箱外**执行 `node scripts/fetch-huggingface-papers.js`。沙箱无法访问本机 `127.0.0.1:7897`，不能据此判断 HuggingFace 或代理失效
- `fetch-huggingface-papers.js` 使用 `curl` 命令，确保系统 `curl` 可用；无项目代理时脚本会主动报错，避免写入伪成功空结果

### 12.6.1 arXiv 抓取或全文下载失败

- arXiv 元数据、HTML、PDF 与图片均强制走项目 `.env` 的 `HTTPS_PROXY` 或 `HTTP_PROXY`。至少一项必须是 `http://` 或 `https://` 的 HTTP CONNECT 地址，不能只配置 SOCKS `ALL_PROXY`
- 在沙箱外验证：`node scripts/quick-test.js` 或完整流程；沙箱内访问本机代理失败是运行环境限制
- LLM 与抓取代理无关：检查 LLM 时应确认所有 Node LLM 请求仍为 `agent: false`，不得给 LLM 注入代理 agent/dispatcher

### 12.7 MiMo API 返回 403 / 代理问题

**根因**：Node.js `https.request` 的 `agent: undefined` 仍会复用全局默认 agent 的连接池。当系统配置了代理（`https_proxy` 等环境变量）时，全局 agent 的连接可能被代理污染，导致 MiMo Token Plan 服务端拒绝请求。

**修复**：所有 Node LLM 请求（包括 `test-api-key.js`）的 `options.agent` 必须设为 `false`（不是 `undefined`），彻底禁用连接复用，强制每个请求建立新连接：

```javascript
const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: headers,
    agent: false,  // ← 必须是 false，undefined 无效
    signal: controller.signal
};
```

**验证**：直接用 `curl --noproxy "xiaomimimo.com"` 测试，若绕过代理成功而脚本失败，即为此问题。

### 12.8 图片上传微信 CDN 失败

- 检查 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` 是否过期
- 检查图片是否过大或被 arXiv 限制
- 微信图片上传有频率限制，大量图片可能需要分批执行

### 12.9 API 协议路由验证

运行 `node scripts/test-api-key.js` 测试 API 配置是否正确——会输出检测到的协议类型（`openai` / `anthropic`）、实际请求的 URL 和模型响应。Anthropic 协议输出类似 `[test-api-key] 协议: anthropic`，OpenAI 类似 `[test-api-key] 协议: openai`。若 MiMo Token Plan 显示 `openai`，检查 `token-plan` 端点和 MiMo 域名/模型；Kimi Coding 应使用 `kimi.com/coding`，并兼容 `k3`。

### 12.10 后台运行时 `npm run fetch` 被 SIGTERM 终止（exit code 143）

**直接原因**：npm 创建一个 TTY 控制终端来运行子进程，当终端信号处理不当时，子进程可能收到 SIGTERM 终止信号，npm 返回 exit code 143。

**解决方案**：用 `node scripts/full-fetch.js` 直接调用，避免 npm 的进程管理。根目录 `run-full-fetch.sh` 已经包装好这个行为（`exec node scripts/full-fetch.js`）。

---
