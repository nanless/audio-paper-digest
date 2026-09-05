# 本机论文 AI Companion

## 为什么需要本机 companion

博客部署在静态 GitHub Pages 上，不能安全保存 API key，也不能为 OpenCode Go
补上浏览器 CORS 支持。OpenCode Go 对浏览器带 `Authorization` 的请求会先收到
CORS preflight；服务端没有对应 `OPTIONS` 路由时通常表现为 404。把 key 写进网页、
把请求改成 `no-cors` 或反复重试都不能解决这个安全边界。

本机 companion 让浏览器只访问 `127.0.0.1` 上的隔离 UI；真正的模型请求由 Node
发出，因此不经过浏览器对模型 endpoint 的 CORS preflight，并继续复用项目现有的：

- OpenAI Responses / Chat Completions 路由；
- OpenCode Go sticky 账号池；
- Muse 所需的项目 HTTP CONNECT 代理；
- 请求截止时间和响应字节上限。

## 启动

先按[环境与配置](setup.md)准备项目 `.env`，再在项目根运行：

```bash
npm run paper:rethink
```

服务固定监听：

```text
http://127.0.0.1:43128/ui
```

它不监听 `0.0.0.0`、局域网地址或 IPv6 wildcard。端口被占用时启动失败，不会自动
换端口。博客集成只能用一个普通外链显式打开这个 URL；不得在页面加载时探测
`/health`、自动调用 `/v1/rethink`，也不得把 session token 带回博客页面。

## UI 与凭据

UI 可以输入 protocol、model、endpoint、临时 API key、问题和论文原文。临时 key：

- 只进入当前请求的内存；
- 不进入 URL、HTML、日志或文件；
- 不使用 `localStorage`、`sessionStorage`、IndexedDB 或 Cache API；
- 提交后立即清空 password 输入框；
- 不会与项目 fallback key 混成账号池。

API key 不落盘不代表论文文本不会离开本机；问题与原文会发送给所选服务，并可能受
该供应商自身的日志、保留和训练政策约束。发送前必须核对 UI 中的 endpoint 和内容。

临时 key 留空时使用项目 `.env` 的 `PAPER_ANALYZER_API_KEY`；若默认 endpoint 是
OpenCode Go，还会按生产规则使用 `PAPER_ANALYZER_FALLBACK_API_KEYS`。普通网络、
5xx、协议或内容失败不会由 companion 自动重试；账号池只会对结构化、明确的
`GoUsageLimitError` 做既有 sticky failover。

## Endpoint allowlist

默认只批准 `PAPER_ANALYZER_ENDPOINT`。如确实要使用其他服务，必须由本机操作者在
`.env` 中显式添加，而不是接受网页任意指定：

```dotenv
PD_PAPER_RETHINK_ALLOWED_ENDPOINTS=https://api.openai.com/v1,https://api.example.com/v1
```

UI 仍可填写 endpoint，但 `/v1/rethink` 只接受 allowlist 的精确 canonical 值。该设计
防止获得 HTTP 调用能力的页面把本机 companion 变成内网探测或 DNS rebinding 工具。

endpoint 规则：

- 只允许 HTTPS 默认端口 443；
- 禁止 URL userinfo、query、fragment；
- 禁止 IP literal、本机/私网后缀和单标签主机名；
- 禁止原始或 percent-encoded dot segment、encoded slash/backslash；
- Chat endpoint 填 API 基础路径，例如 `/v1`，不要附加 `/chat/completions`；
- protocol 必须显式选择 `openai_responses` 或 `openai_chat`，并与公共路由推导一致。

为其他 endpoint 配置 allowlist 时，还必须输入其临时 key；项目 `.env` key 只会发送到
项目默认 endpoint。

## HTTP 合同

### `GET /health`

只返回不含 token、endpoint、model 或凭据的健康状态：

```json
{"ok":true,"service":"paper-rethink-companion","schemaVersion":1}
```

### `GET /ui`

返回带启动时随机 session token 的本机 UI。响应为 `no-store`，有严格 CSP、
`frame-ancestors 'none'`、Permissions Policy 和 `no-referrer`。token 只在该 UI 文档中
使用，每次重启都会变化。博客可以通过普通导航打开 `/ui`，但带博客 `Origin` 的
脚本 fetch 会被拒绝且拿不到 UI HTML/token。

`/ui` 导航可携带四个可选预填参数：

```text
?title=...
&arxivId=2609.03620v2
&sourceUrl=https%3A%2F%2Farxiv.org%2Fabs%2F2609.03620v2
&contextUrl=%2Faudio-paper-digest-blog%2Fdata%2Fpapers%2F2026-09-05%2F2609-03620%2Frethink-context.json
&selectedText=用户明确选择的论文段落
```

- query 总长不超过 8192 字符；字段不得重复；任何未知参数都拒绝。
- `key`、`apiKey`、`token` 等凭据字段属于未知参数，服务在签发 UI HTML/session
  token 前拒绝，错误不回显参数名或值。
- `sourceUrl` 只允许与 `arxivId` 一致的官方 arXiv HTTPS abs/PDF URL。
- `contextUrl` 只允许配置的博客 HTTPS origin/base path 下，严格形如
  `data/papers/YYYY-MM-DD/<safe-arxiv-id>/rethink-context.json`，并必须与
  `arxivId` 指向同一论文。
- companion 由服务器侧按 256 KiB、10 秒、JSON content-type、无 redirect 的边界
  读取 sidecar；本机浏览器不跨源 fetch。
- sidecar 合同和 arXiv 身份通过后才预填原文框；暂时不可用时保留手动粘贴能力，
  只显示脱敏失败提示。
- `selectedText` 只允许用户点击论文工具栏按钮时从当前文档选择读取，规范化为 NFC
  纯文本；最多 2000 字符，并继续受 8192 字符的编码后总 query 上限约束。控制字符、
  超长选择和过长 URL 在导航前后分别失败关闭。
- 有选中段落时，UI 把它标为“不可信论文证据”并置于摘要 sidecar 之前，同时预填
  “解释作用、前提和误读”的问题；没有选择时继续使用摘要 sidecar 或手动粘贴全文。
- UI 完成预填后立即用 `history.replaceState` 从地址栏和当前 history entry 移除 query；
  选中文本不会进入 API key、Zotero ticket、日志或 storage。它只会在用户再次点击
  “发送到所选模型”后随原文框内容发给 provider。

博客只能生成普通、用户点击触发的 `target="_blank"` 导航；不得在加载、滚动或
hover 时 fetch localhost，也不得把本机 session token 传回博客。

### `GET /v1/paper/pdf?arxivId=...`

这是用户显式点击“下载 PDF（本机）”后的附件下载入口。它只接受唯一的
`arxivId` 参数，支持现代及 old-style arXiv ID，并保留显式 `vN`；未知、重复参数或
非法 ID 在联网前拒绝。请求还必须带有配置博客或本机 UI 的精确 origin referrer；
博客链接只发送 origin，不泄露论文路径。服务只通过项目 HTTP CONNECT 请求官方 arXiv PDF，验证受控
重定向、50 MiB 上限、MIME 与 `%PDF-` 文件头，然后用 `attachment` 响应返回。该入口
不接受任意 URL、不读取 API key，也不在博客加载时调用。

### `POST /v1/rethink`

请求必须同时满足：

1. `Origin` 是允许的博客 origin 或精确本机 UI origin；
2. `X-Paper-Rethink-Session` 等于当前进程的随机 token；
3. `Content-Type: application/json`。

请求 schema：

```json
{
  "protocol": "openai_responses",
  "model": "muse-spark-1.2-contributor",
  "endpoint": "https://opencode.ai/zen/go/v1",
  "apiKey": "可留空",
  "question": "论文的核心限制是什么？",
  "sourceContext": "用户确认后粘贴的论文原文或可信上下文",
  "maxOutputTokens": 3000
}
```

限制：请求体 256 KiB、原文 120000 字符、问题 8000 字符、响应 2 MiB、输出
1048576 字符、模型请求 120 秒、输出 tokens 128–8000。

成功响应只返回纯文本与非敏感路由信息：

```json
{
  "ok": true,
  "text": "模型回答",
  "protocol": "openai_responses",
  "model": "muse-spark-1.2-contributor"
}
```

上游错误正文、headers、key 和 Authorization 不向浏览器回显。Responses 的
`incomplete/failed`、缺少 SSE completed 终态，以及 Chat 的 `length`、
`content_filter`、`tool_calls` 或缺少 `finish_reason=stop` 都按不完整失败处理。

## CORS、PNA 与 CSRF

companion 对允许 origin 的合法 preflight 返回：

- `Access-Control-Allow-Origin`：原样精确 origin，不使用 `*`；
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`；
- 只允许 `Content-Type, X-Paper-Rethink-Session`；
- 浏览器请求 PNA 时返回 `Access-Control-Allow-Private-Network: true`；
- `Access-Control-Max-Age: 0`。

Origin 只能防跨站读取，不能单独防 CSRF；随机 token 才是写请求的第二道门。博客
origin 虽在 CORS allowlist 中，但拿不到 token，因此博客只负责打开 `/ui`，不能直接
发送模型请求。

## 原文上下文边界

v1 不让 companion 根据论文文本中的 URL 自动下载 PDF、访问网页或调用工具。用户
应从已发布论文页、arXiv 原文或发布期生成的可信 context sidecar 中粘贴内容，并在
发送前检查会离开本机的文本。

system prompt 把论文内容与用户问题都声明为不可信证据；内容中的“忽略指令”、
角色声明、联网、工具调用或数据外传要求都不得执行。模型没有 tool/function、网络、
代码执行或文件权限。UI 以 textarea/value 显示回答，不把模型文本作为 HTML 执行。

后续如果自动注入论文全文，来源必须是发布期生成并由 SHA 绑定的同源 sidecar，或由
本机服务根据规范化、版本化 arXiv ID 从固定官方 host 获取；不要接受任意全文 URL。

## 博客工具栏与 Zotero 的分层边界

本机 AI companion 与引用工具应保持独立：

1. 博客页面嵌入 Highwire/JSON-LD 学术 metadata，同时提供“导入 Zotero（本机确认）”
   链接。链接只导航到 companion `/ui`，不会在博客加载时扫描 localhost；浏览器
   Zotero Connector 仍作为不运行 companion 时的 fallback。
2. 同源静态 `.bib` / `.ris` 是无扩展时的确定性 fallback；它们在发布期生成并绑定
   manifest SHA，不在浏览器运行时从正文猜作者或抓 arXiv。
3. companion 在本机确认页展示将写入的标题、arXiv ID、作者来源和目标说明。只有用户
   点击“确认导入这条记录”后，服务端才消费一个十分钟、单次使用、最多 128 个并存的
   随机 ticket，并通过固定 `127.0.0.1:23119/connector/import` 将 BibTeX 写入 Zotero
   当前选中的库或分类。对 Zotero 10 的本机 HTTP 加固同时发送
   `Zotero-Allowed-Request: true`；请求还必须同时携带本机 UI Origin 与进程随机
   session header，公共博客拿不到二者。
4. 博客中的“AI 重理解”只显式打开 `http://127.0.0.1:43128/ui`，不与 Zotero
   localhost 能力共享 token、端口或权限。

新 `researcher-sidecars-v1` 页面使用经过身份、摘要 SHA 和受控 HTTPS 路径验证的
`rethink-context.json` 标题与作者生成引用。历史页没有 sidecar 时只使用页面携带的
标题和严格规范化 arXiv ID，预览会明确作者未知，不从正文猜作者。Connector 未启动、
超时或拒绝导入时，UI 只显示稳定错误并要求刷新获得新 ticket，避免网络结果不确定时
重复写入。

“打开 PDF”仍是指向固定 `https://arxiv.org/pdf/<严格ID>.pdf` 的显式导航，浏览器可能
预览而不下载。论文工具栏另提供“下载 PDF（本机）”：只有用户点击后，companion 才
通过项目 HTTP CONNECT 从官方 `arxiv.org`/`export.arxiv.org` 获取身份一致的 PDF，
最多接受两次受控重定向、50 MiB、`application/pdf`/`application/octet-stream`，并在
验证 `%PDF-` 文件头后用 `Content-Disposition: attachment` 返回。它不接受任意 URL。
`connector/import` 的稳定合同不保证自动保存 PDF attachment，因此 Zotero 导入仍不
伪称自动附带 PDF；下载与导入是两个分别由用户触发的动作。

## 测试重点

`tests/paper-rethink-server.test.js` 覆盖 canonical endpoint、allowlist、协议终态、
prompt injection 边界、单次调用、key canary、Origin/session、CORS/PNA、UI CSP 和请求
大小。修改 companion 后至少运行：

```bash
node --test --test-concurrency=1 tests/paper-rethink-server.test.js
node --check scripts/paper-rethink-server.js
```
