# 安装与环境配置

## 适合谁

本文说明如何安装默认 LLM/API 日更所需的环境，也用于排查配置未被读取的问题。运行步骤见[主流程](workflow.md)，环境变量示例见 [env.example](../env.example)。

## 最短安装路径

```bash
npm install
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp env.example .env
```

Node 版本须满足 `>=20.18.1 <21 || >=22.3.0`。Python 须为 3.11 或更高版本，并使用 OpenSSL 提供 TLS；macOS 自带的 Python 3.9/LibreSSL 不受支持。默认博客和视觉入口通过 `scripts/python-runtime.sh` 选择 Python，优先使用项目 `.venv`，其次是 `python3.11`，最后才检查 `python3`。项目使用 Node 内置测试框架，Python 依赖用于博客生成、Hugo 构建检查和视觉辅助。

安装后先确认当前目录及工作区角色：

```bash
pwd
npm run workspace:role -- status
```

日更目录应为 `daily`，全历史副本应为 `history`。角色标记缺失或绑定的真实路径不匹配时，先停止运行。确认目录用途后，再用 `npm run workspace:role -- set daily` 或 `npm run workspace:role -- set history` 绑定；不要用 `--force` 把历史工作区改成日更工作区来绕过检查。

## 最小 `.env`

```dotenv
PAPER_ANALYZER_API_KEY=your-key
# 可选；同一路由的备用账号，逗号分隔
PAPER_ANALYZER_FALLBACK_API_KEYS=your-second-key
PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY=your-third-key
PAPER_ANALYZER_MODEL=mimo-v2.6-flash
PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
PAPER_DIGEST_BLOG_REPO=/absolute/path/to/audio-paper-digest-blog
# 可选：历史 ICLR 2026 路线使用的本地官方论文信息与 PDF 根目录
PAPER_DIGEST_ICLR_2026_ACCEPTED_ROOT=/absolute/path/to/iclr2026-paper-scraper
```

当前文档示例使用 OpenCode Go 的 `mimo-v2.6-flash`，通过 OpenAI Chat Completions 请求，`/v1` 端点原样使用；`muse-spark-*` 模型仍走 OpenAI Responses。实际模型由项目配置决定。公开服务端点必须使用 HTTPS，只有本机回环测试服务允许 HTTP。

`PAPER_DIGEST_ICLR_2026_ACCEPTED_ROOT` 只供历史 ICLR 2026 会议来源收集使用，须指向已保留的本地官方录用论文信息与 PDF。未配置时使用 `~/code/github_repos/iclr2026-paper-scraper`。日更抓取和 arXiv 写作都不读它，设置它也不会触发下载。

### 备用账号

系统会持续使用当前成功的账号。只有 OpenCode Go 返回 HTTP 429 `GoUsageLimitError` 或 HTTP 401 `Insufficient balance` 时，才按配置顺序切换到后续账号，不会返回前面的账号。普通认证 401 会停止本次运行；普通 429、5xx、网络或代理故障、响应截断和内容校验失败都不触发切换。

账号选择与冷却时间保存在 `data/runtime/llm-account-pool.json`，供 Node、Python 和后续日期的运行共同使用。前面账号的冷却时间到期后，不会自动切回；追加备用账号也不会改变当前成功账号。后续账号全部不可用时，程序停止派发并保存进度。这些规则不用于轮流分配流量。

`PAPER_ANALYZER_FALLBACK_API_KEYS` 可填写逗号分隔的备用账号。`PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY` 排在这份列表之后，也可填写第三、第四等账号的列表。需要独立副模型账号池时，使用 `PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS`。只有主副端点属于同一规范 OpenCode Go 服务、且副模型没有独立密钥时，副模型才继承主账号池；跨服务必须显式提供副模型密钥。

账号池文件不保存原始密钥，但账号的稳定指纹仍属于敏感操作记录，权限须为 `0600`，不得上传或归档。发送认证信息前，程序还会核对实际请求地址是否与端点和模型确定的 API 路由一致。

## 环境为什么只认项目 `.env`

Node 的 `scripts/env-loader.js` 和 Python 的 `scripts/project_env.py` 都读取项目根目录 `.env`。它们先清理从 shell、IDE、Trae 或 Codex 继承的 `PAPER_ANALYZER_*`、`PAPER_DIGEST_*`、`PD_*`、渠道变量及大小写代理变量，再载入项目配置，并将文件权限收紧到 `0600`。

项目必需值不能只写在 `.zshrc`，也不能靠外层环境临时补齐。子进程须使用公共的最小环境构造函数，避免把模型或发布密钥传给 curl、Git hook、浏览器及无关命令。

## 代理职责

| 流量 | 规则 |
|---|---|
| Muse 模型请求（`muse-spark-*`） | 必须使用项目 `HTTPS_PROXY` 或 `HTTP_PROXY` 配置的 HTTP CONNECT；每次请求创建独立代理连接对象，用完关闭 |
| arXiv 元数据、HTML、PDF 和图片 | 必须使用 HTTP CONNECT |
| HuggingFace curl | 继承 HTTP(S) 代理，可额外使用 `ALL_PROXY` SOCKS |
| 其他模型请求 | 默认设置 `agent:false`，直接连接；当前推荐的 `mimo-v2.6-flash` 属于这一类 |
| 外部图片和 Demo | 只接受 HTTPS，每次重定向都校验公网 IP |

需要代理却未配置时，程序会停止，不会静默直连。所有项目脚本和测试都必须在沙箱外运行，包括访问本机代理的诊断命令。

## PDF/TXT 来源存储

筛选完成后，`full-fetch.js` 通过项目代理为每个入选 arXiv ID 获取本次官方 HTML 文本和 PDF，保存到 `data/runtime/daily-fresh-source-runs/`。每篇包含 `source.txt`、`source.pdf`、`source-runtime.json` 和 `source-manifest.json`，后续分析与发布须使用并校验这组文件，不能读取旧文本缓存。

这些文件是保留的论文来源，不是可删除缓存，`storage:prune` 不会清理它们。论文图片只在当前模型请求的系统临时目录中准备和使用，用完清理，不保存到运行目录的图片缓存。

历史重写每次获取 arXiv 来源时，也会保存这四类文件，并用 `generation` 序号区分各次获取。目录为 `data/runtime/fetched-arxiv-sources/`。会议论文则核对保留的本地论文信息和 PDF 及其 SHA。两种来源的具体要求见[历史重写流程](history-rewrite.md)。

## 常用容量参数

| 变量 | 默认值 |
|---|---:|
| `PD_ANALYSIS_CONCURRENCY` | 3 篇论文 |
| `PD_ANALYSIS_API_MAX_TOKENS` | 64000 |
| `PD_ANALYSIS_REPAIR_MAX_TOKENS` | 16000 |
| `PD_API_READER_MAX_TOKENS` | 48000 |
| `PD_API_READER_REPAIR_MAX_TOKENS` | 8000 |
| `PD_API_READER_EVIDENCE_MAX_CHARS` | 180000 字符 |
| `PD_API_READER_CONTEXT_MAX_CHARS` | 240000 字符 |
| `PD_API_READER_CONCURRENCY` | 5 个进程内解读生成任务 |
| `PD_BLOG_REVIEW_CONCURRENCY` | 5 个独立页面审查任务 |

筛选批次大小由 `PD_FILTER_BATCH_SIZE` 控制，整篇分析并发由 `PD_ANALYSIS_CONCURRENCY` 控制。账号池只在选择账号和更新状态时短暂持锁，发送网络请求时不持锁。Responses 仅在 `PD_OPENAI_RESPONSES_STREAM=1` 时启用 SSE；`PD_OPENAI_RESPONSES_STREAM` 和 `PD_OPENAI_RESPONSES_REASONING_EFFORT` 对当前主模型的 Chat Completions 请求没有作用。

解读正文的局部修复通常最多输出 8000 tokens。如果一次局部修复恰好在该上限截断，且候选尚可获得一次额外恢复机会，程序会保存失败草稿并停止；下次显式续跑可提高修复上限，默认最多 16000 tokens。这次机会与实现升级提供的额外尝试共用，不能叠加。自定义预算下，上限按正文预算和基础修复预算计算，最高为 16000，且不超过 `PD_API_READER_MAX_TOKENS`；不能据此无限追加尝试。模型返回任何内容后即消耗这次机会，纯网络故障不消耗。截断的 JSON 仍不能作为有效候选，也不能绕过内容检查。

## 可选副模型

API Reader v3 会直接把安全准备的官方论文图交给主模型，因此主模型及所选协议须支持图片输入。当前示例中的 `mimo-v2.6-flash` 通过 Chat Completions 接收图片，`muse-spark-*` 通过 Responses 接收图片；公共请求封装也支持 Chat 和 Anthropic 的图片格式。`PAPER_ANALYZER_SECONDARY_MODEL` 只启用旧正式分析结果的额外图片补充：副模型选择候选图并规划局部插入，不替换主模型正文，也不参与评分。副模型端点未设置时复用主端点；密钥只有在主副属于同一规范服务时才能复用。

`PD_API_READER_CONCURRENCY` 限制进程内解读生成的重阶段并发，`api:reader:refresh --concurrency N` 限制刷新命令同时处理的论文数。刷新任务仍可能等待前者提供的空闲容量，两项不能混为同一个限制。

文件日志默认保留 30 天，总量不超过 256 MiB；可分别用 `PD_LOG_RETENTION_DAYS` 和 `PD_LOG_MAX_TOTAL_BYTES` 覆盖。

## 博客与 Hugo

`PAPER_DIGEST_BLOG_REPO` 须指向真实 Hugo 仓库。数据抓取阶段在仓库目录不存在时可以跳过已发布论文去重，但正式发布不能缺少目标仓库。审查会执行 Hugo 构建检查，Hugo 须在沙箱外环境中可用。

外部进程有明确等待上限。图片审查、Hugo、Git 本地操作、提交及 hook、推送与远端核验、视觉规划默认分别为 120、300、30、180、180、120 秒。可在 `env.example` 规定范围内，分别使用 `PD_BLOG_IMAGE_REVIEW_DEADLINE_SECONDS`、`PD_HUGO_GATE_TIMEOUT_SECONDS`、`PD_GIT_LOCAL_TIMEOUT_SECONDS`、`PD_GIT_COMMIT_TIMEOUT_SECONDS`、`PD_GIT_NETWORK_TIMEOUT_SECONDS` 和 `PD_VISUAL_PLANNER_TIMEOUT_SECONDS` 调整。超时不会被记录为审查或远端发布成功；有效的本地发布提交若尚未验证远端，会保留供续跑核对和使用。

## 验证安装

```bash
node --version
npm test
npm run validate:data -- --allow-empty
```

`--allow-empty` 仅供明确没有运行数据的干净 checkout 使用。已有数据的工作区应运行 `npm run validate:data`，检查实际数据。测试和诊断同样须在沙箱外执行。

需要验证模型路由时，可单独运行 `node scripts/test-api-key.js`；它会发送真实 API 请求，不属于上述离线检查。不要把完整日更当作安装探针。

## 安全边界

`.env`、`data/`、`logs/`、缓存和密钥不得提交。公开模型端点须使用 HTTPS，日志须隐藏密钥、认证头、Cookie、密码、URL 中的用户认证信息及其他敏感信息。

非 dry-run 微信发布还要求 `WECHAT_APP_ID`、`WECHAT_APP_SECRET` 和 `WECHAT_THUMB_MEDIA_ID`。这些可选渠道不属于默认日更。人工流程的环境与命令见 [Manual 入口](../manual/README.md)。
