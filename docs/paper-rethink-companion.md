# 旧本机论文助手的接口维护参考

2026-09-06 起，博客已取消全部本机助手入口，包括本机 AI、Zotero 确认页和 PDF 下载服务。读者使用[纯网页阅读工具](blog-reading-tools.md)，无需运行本项目、启动服务或填写 API 密钥。博客前端也不再向本机服务传递地址或参数。

服务源码和静态附属文件仍保留。当前上下文格式为 `paper-research-context-v2`、`schemaVersion=2`，标签信息使用 `assessment.tagMetadata`；旧 `researcher-sidecars-v1`、`schemaVersion=1` 及原 `assessment.taxonomy` 只读兼容。这份说明供维护旧接口时查阅，下面的博客工具栏、导航和预填设计属于退出集成前的行为，不能据此恢复博客功能。源码中残留的旧启动或重开提示，也不代表今天的博客提供这些入口。

## 旧设计解决的问题

静态 GitHub Pages 不能安全保存 API 密钥，也不能替模型服务增加浏览器 CORS 支持。旧记录观察到 OpenCode Go 的浏览器请求带 `Authorization` 时先做 CORS 预检，服务没有对应 `OPTIONS` 路由时通常返回 404。这是当时的观察，本说明没有重新联网核验服务现状。把密钥写进网页、使用 `no-cors` 或重复请求都不能替代正确的凭据和跨源设计。

旧助手让用户导航到 `127.0.0.1` 的本机界面，再由 Node 请求模型，避开浏览器直接调用模型端点的预检。它复用 OpenAI Responses / Chat Completions 路由、OpenCode Go 固定账号及备用账号规则、Muse 的项目 HTTP CONNECT 代理，以及请求截止时间和响应体积限制。

## 维护时的启动与监听方式

旧服务按[环境与配置](setup.md)读取项目 `.env`，源码对应启动命令为：

```bash
npm run paper:rethink
```

这仅是维护入口说明，不是阅读博客的准备步骤。生产启动固定监听：

```text
http://127.0.0.1:43128/ui
```

它不监听 `0.0.0.0`、局域网地址或 IPv6 通配监听地址；端口占用即失败，不自动换端口。浏览器连接失败说明服务不可达，静态博客不能替用户启动 Node。今天的博客没有“从论文工具栏重新打开助手”的操作。

退出集成前，设计只允许用户显式点击带 `target="_blank"` 的普通外链打开 `/ui`，不允许页面加载、滚动或鼠标悬停时探测 `/health` 或请求 `/v1/rethink`，不把会话标识（session token）传回博客。官方 arXiv PDF、浏览器保存 PDF、静态 BibTeX/RIS 和浏览器 Zotero Connector 本来就不需要这个服务；本机确认导入当时只依赖 Zotero Desktop。

没有配置模型端点、密钥或模型名时，服务的 UI、PDF 和 Zotero 接口仍可独立使用；模型请求须有有效凭据及精确端点白名单。已配置却不安全的端点仍在启动时拒绝。“检查模型配置与 Zotero 连接”仅在点击后检查配置是否齐全并读取 Connector ping，不调用模型、不产生模型费用、不写 Zotero，也不能证明模型账号实际可用。

## 密钥与发送内容

旧 UI 接收协议、模型名、端点、临时 API 密钥、问题和论文文本。临时密钥仅进入当前请求内存，不进入 URL、HTML、日志或文件，不存 `localStorage`、`sessionStorage`、IndexedDB 或 Cache API，提交后清空密码输入框，也不与项目备用密钥混成账号池。

密钥不会写入文件，问题和论文原文仍会发送到所选的模型服务，受供应商自身日志、保留和训练政策约束，因此旧界面要求发送前核对端点与内容。

临时密钥留空时使用项目 `PAPER_ANALYZER_API_KEY`；默认端点为 OpenCode Go 时，公共路由还按项目规则使用 `PAPER_ANALYZER_FALLBACK_API_KEYS`。助手没有为普通网络、5xx、协议或内容失败另加自动重试。它调用公共请求层一次，但公共账号池可在同一逻辑请求内向后切换账号，因此不等于只能产生一个实际传输请求。

旧记录只列 `GoUsageLimitError` 切号；当前共享实现也识别官方 HTTP 401 的精确 `Insufficient balance`，并与明确 HTTP 429 `GoUsageLimitError` 一样记录冷却及后续账号选择。普通认证 401 不切号，普通 429、5xx、网络或内容失败也不能借此切号。这里说明现有公共层行为，没有修改服务或核验当前账号状态。

## 模型端点白名单

默认仅允许 `PAPER_ANALYZER_ENDPOINT`。旧接口允许本机操作者显式配置其他地址，而不接受网页随意指定：

```dotenv
PD_PAPER_RETHINK_ALLOWED_ENDPOINTS=https://api.openai.com/v1,https://api.example.com/v1
```

`/v1/rethink` 只接受规范化后与白名单精确相等的值。非默认端点必须输入该服务的临时密钥，项目密钥只发给项目默认端点。白名单旨在限制服务调用范围，不能把设计意图当作实际跨域泄漏或 DNS 重绑定漏洞已复现、已修好的证据。

端点只允许 HTTPS 默认端口 443，拒绝 URL 用户信息、查询参数、片段标识、IP 地址字面值、本机或私网后缀、单标签主机名，以及原始或百分号编码的点路径、编码斜线和反斜线。Chat 填 API 基础路径（如 `/v1`），不附加 `/chat/completions`。`protocol` 只能选 `openai_responses` 或 `openai_chat`，须与公共路由推导一致。

## HTTP 接口与请求限制

### `GET /health`

只返回不含会话标识、模型端点、模型名或凭据的健康状态：

```json
{"ok":true,"service":"paper-rethink-companion","schemaVersion":1}
```

### `GET /ui`

界面含进程启动时随机生成的会话标识，响应为 `no-store`，设置严格 CSP、`frame-ancestors 'none'`、Permissions Policy 和 `no-referrer`。会话标识仅供该 UI 文档使用，重启后改变。旧博客普通导航可打开界面，但带博客 `Origin` 的脚本 fetch 被拒绝，不能读取 HTML 或会话标识。

旧导航允许以下预填字段；今天的博客不再生成这些本机导航：

```text
?title=...
&arxivId=2609.03620v2
&sourceUrl=https%3A%2F%2Farxiv.org%2Fabs%2F2609.03620v2
&contextUrl=%2Faudio-paper-digest-blog%2Fdata%2Fpapers%2F2026-09-05%2F2609-03620%2Frethink-context.json
&selectedText=用户明确选择的论文段落
&pageExcerpt=用户点击时从旧博客页取得的导读摘录
&action=zotero
```

编码后查询参数总长不超过 32768 字符，HTTP 请求行与头合计上限 48 KiB，可容纳 2000 汉字的 URL 编码。字段不可重复，未知参数拒绝；`key`、`apiKey`、`token` 等凭据字段也在返回 UI HTML 或会话标识前拒绝，错误不回显参数名或值。`action` 只接受默认 `rethink` 或 `zotero`，仅决定初始聚焦区域，不请求模型或导入。

`sourceUrl` 仅允许与 `arxivId` 相同的官方 arXiv HTTPS abs/PDF 地址。`contextUrl` 只允许配置博客 HTTPS origin/base path 下的 `data/papers/YYYY-MM-DD/<safe-arxiv-id>/rethink-context.json`，且须同篇。服务器按 256 KiB、10 秒、JSON content-type、无重定向读取该附属文件，本机浏览器不跨源 fetch。格式及 arXiv 身份通过后才预填原文框，暂不可用时保留手动粘贴，只显示脱敏错误。

`selectedText` 来自旧工具栏用户主动选择的段落，规范化为 NFC 纯文本，最多 2000 字符，同时受 32768 编码总长限制。控制字符、超长选择和过长 URL 在导航前后都拒绝。选段优先置于摘要附属文件之前，并标明“不可信论文证据”，预填解释作用、前提与误读的问题；没有选择时用已核验摘要或手动全文。

`pageExcerpt` 是旧页没有附属文件时的后备导读摘录，最多 2000 字符，检查 NFC、换行和控制字符，仍受 32768 总长限制。只有无 `selectedText` 且无通过验证的附属文件时才使用，并注明“博客导读摘录，非论文原文，未经来源绑定验证”。它不进入 Zotero 作者或引用元数据、恢复链接或可信来源证明，预填后丢弃原字段。请求模型仍须用户本机核对后点击发送，不自动抓全文。

预填完成后，`history.replaceState` 清除地址栏及当前历史条目的查询参数。选段不进入密钥、Zotero 导入票据、日志或存储，只有再次点击发送才随原文框内容发给模型。仅有摘要时，预填问题要求模型说明证据不足，用户可补全文。

旧 UI 的 Zotero 失败恢复链接保留论文身份与受控附属文件，丢弃选段和导读摘录，不带 key/token。直接刷新已清除查询参数的 `/ui` 会丢论文身份；重试应先检查库中是否已保存。不确定写入不能自动重试，失败请求的一次性 ticket 仍作废。这是服务现存恢复设计，不是今天博客的导入功能。

### `GET /v1/paper/pdf?arxivId=...`

旧服务将此作为用户主动点击后的附件下载接口，只接受唯一 `arxivId`，支持现代及旧式 arXiv ID，保留显式 `vN`。未知、重复参数或非法 ID 在联网前拒绝，不接受任意 URL，也不读取 API 密钥。

下载经项目 HTTP CONNECT，只访问身份一致的官方 `arxiv.org`/`export.arxiv.org` PDF，最多两次受控重定向、50 MiB，检查 `application/pdf`/`application/octet-stream` 和 `%PDF-` 文件头后设置 `Content-Disposition: attachment` 返回。PDF 请求使用独立 180 秒超时，不能与下述模型的 120 秒预算混为一项。进程最多两个并发、每分钟六次。

HTTPS 到 HTTP loopback 导航可能使浏览器移除 referrer，它既可缺失也可被非浏览器伪造，不能作授权凭据。失败时浏览器收到含官方 PDF 链接和代理恢复说明的 HTML，普通 API 客户端收到稳定 JSON 错误；来源、重定向、体积和文件头检查不变。

### `GET /v1/local/status`

本机 UI 用户点击连接检查时携带当前 session header。有 `Origin` 时必须是精确本机 UI origin，无 `Origin` 的客户端仍必须通过 session 核验。返回模型配置是否齐全、协议是否支持、代理是否配置，以及固定 `127.0.0.1:23119/connector/ping` 是否可达，不返回 endpoint、model、key、库内容或原始网络错误，也不运行 LLM 验证或导入。

### `POST /v1/rethink`

请求须同时满足允许的博客 origin 或精确本机 UI origin、当前进程随机 token 的 `X-Paper-Rethink-Session`，以及 `Content-Type: application/json`。博客 origin 在旧白名单中不等于博客能取得 token，今天也没有恢复集成。

以下 JSON 保留原接口例子中的 `muse-spark-1.2-contributor`，用于查旧格式，不是今日模型配置推荐：

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

请求体上限为 256 KiB，其中原文最多 120000 字符，问题最多 8000 字符。响应体最多 2 MiB，输出最多 1048576 字符；模型请求预算为 120 秒，输出 token 数可设为 128–8000。成功响应只含纯文本及非敏感路由信息，原例子为：

```json
{
  "ok": true,
  "text": "模型回答",
  "protocol": "openai_responses",
  "model": "muse-spark-1.2-contributor"
}
```

上游错误正文、headers、key 和 Authorization 不回显到浏览器。Responses 的 `incomplete/failed`、SSE 缺 completed 终态，以及 Chat 的 `length`、`content_filter`、`tool_calls` 或缺 `finish_reason=stop` 都按不完整失败处理。

### `POST /v1/zotero/import`

接口只允许精确本机 UI Origin 和进程随机 session header。界面显示即将写入的标题、arXiv ID、作者来源和目标；用户确认后，才接受有效期十分钟、只能使用一次的随机导入票据（`ticket`），最多 128 个并存。服务先作废票据，再尝试导入；网络结果不确定时不能复用同票据自动重写。

服务以 BibTeX 请求固定 `127.0.0.1:23119/connector/import`，写入 Zotero 当前选中的库或分类。对 Zotero 10 的本机 HTTP 加固还发送 `Zotero-Allowed-Request: true`。公共博客不能取得本机 UI 的 origin/session 条件，也不共享它的票据、端口或权限。

有新版或明确旧版论文上下文文件时，引用使用经过论文身份、摘要 SHA 与受控 HTTPS 路径核验的 `rethink-context.json` 标题和作者。旧页没有附属文件时只用携带的标题与严格规范 arXiv ID，作者显示未知，不从正文猜测。Connector 未启动、超时或拒绝时保留稳定错误与重新确认身份链接。

导入接口不保证自动保存 PDF 附件。旧“打开 PDF”只是官方 `https://arxiv.org/pdf/<严格ID>.pdf` 导航，浏览器可能预览；附件下载与文献导入是两个分别由用户触发的动作。

## CORS、PNA 与跨站请求限制

对允许 origin 的合法预检，服务精确返回该 origin，不用通配符：

- `Access-Control-Allow-Origin`：原样精确 origin；
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`；
- 只允许 `Content-Type, X-Paper-Rethink-Session`；
- 浏览器请求 PNA 时，`Access-Control-Allow-Private-Network: true`；
- `Access-Control-Max-Age: 0`。

Origin 限制浏览器跨站读取，不能单独防 CSRF，也不等于非浏览器调用者身份认证；随机会话标识是写请求的另一项条件。旧博客 origin 虽在 CORS 白名单中，不能通过脚本读取 `/ui` token，因此旧设计只允许普通导航。保留后端约束不代表重新开放博客入口。

## 原文上下文与模型能力

旧 v1 不根据论文文本中的 URL 自动下载 PDF、访问网页或调用工具。用户从论文页、arXiv 或发布时生成的可信附属文件取内容，发送前核对会离开本机的文本。

系统提示词将论文和用户问题都视为不可信数据，文本中的忽略指令、角色声明、联网、工具调用或外传要求不执行。请求没有工具或函数调用能力，也没有网络、代码执行或文件权限，UI 以 textarea/value 显示回答，不把模型文字作为 HTML 执行。这些是输入和显示约束，不保证模型事实正确或所有提示注入都已实测。

旧设计为未来自动输入全文提出的条件仍可供维护参考：来源须是发布时生成并由 SHA 绑定的同源附属文件，或由服务按规范且版本明确的 arXiv ID 从固定官方主机获取，不能接受任意全文 URL。今天博客没有因此增加自动全文或助手功能。

## 静态引用与旧集成的区别

旧设计在博客放 Highwire/JSON-LD 学术元数据、静态 `.bib`/`.ris`，另以普通链接打开本机确认 UI；浏览器 Zotero Connector 是不运行助手时的替代方案。静态引用在发布时生成并绑定文件清单（manifest）的 SHA，不在浏览器猜作者或抓 arXiv。旧“AI 重理解”导航也只打开 `http://127.0.0.1:43128/ui`。

2026-09-06 取消的是这些本机交互入口。静态附属文件仍兼容，读者可下载引用后自行导入文献工具；本说明不会把服务留存解释成博客继续依赖它。

## 源码维护的现有测试

`tests/paper-rethink-server.test.js` 使用模拟模型和模拟文献库写入，覆盖规范端点、白名单、协议终态、不可信提示输入、公共调用次数、密钥泄漏检查、Origin/session、CORS/PNA、CSP 与请求体积。还覆盖缺模型配置时 PDF/Zotero 独立可用、2000 汉字 HTTP 预填、只读连接检查、身份恢复、PDF 浏览器错误页及旧摘录的优先级、标注和引用隔离。

下面保留源码维护检查命令。它们不是读者操作，本次文档改写也没有启动服务、请求模型或写 Zotero：

```bash
node --test --test-concurrency=1 tests/paper-rethink-server.test.js
node --check scripts/paper-rethink-server.js
```

实际修改服务时仍按项目要求在沙箱外运行相应检查，不能将本说明中的历史结果当作新修改已经测试。
