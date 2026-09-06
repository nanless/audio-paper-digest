# 安装与环境配置

## 适合谁

给第一次运行默认 LLM/API 日更，或排查“环境明明配了但脚本没读到”的用户。流程概念见 [workflow.md](workflow.md)，变量的完整示例见 [env.example](../env.example)。

## 最短安装路径

```bash
npm install
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp env.example .env
```

Node 必须满足 `>=20.18.1 <21 || >=22.3.0`。Python 必须为 3.11+ 且使用 OpenSSL TLS；macOS 系统自带的 Python 3.9/LibreSSL 不属于受支持运行时。默认博客和视觉入口通过 `scripts/python-runtime.sh` 依次选择项目 `.venv`、`python3.11`，最后才校验 `python3`。项目使用 Node 内置测试框架；Python 依赖用于博客、Hugo 门禁与视觉辅助。

## 最小 `.env`

```dotenv
PAPER_ANALYZER_API_KEY=your-key
# 可选；同一路由备用账号，逗号分隔
PAPER_ANALYZER_FALLBACK_API_KEYS=your-second-key
PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY=your-third-key
PAPER_ANALYZER_MODEL=muse-spark-1.2-contributor
PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
PAPER_DIGEST_BLOG_REPO=/absolute/path/to/audio-paper-digest-blog
```

默认模型是 OpenCode Go 的 Muse Spark 1.2 Contributor，协议为 OpenAI Responses。endpoint 必须为 HTTPS；只有 loopback 测试服务允许 HTTP。

`PAPER_ANALYZER_FALLBACK_API_KEYS` 不是负载均衡。系统持续使用当前 active 账号，只有 OpenCode Go 返回 HTTP 429 且结构化类型明确为 `GoUsageLimitError` 才立即切到下一账号；切换结果跨 Node/Python 和日期保存在 `data/runtime/llm-account-pool.json`。原账号到期后不会自动切回。普通 429、5xx、网络/代理错误、截断或内容校验失败均不切换。若只需固定第三顺位，可用 `PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY`；它总排在 `PAPER_ANALYZER_FALLBACK_API_KEYS` 的所有账号之后。副模型如有独立账号池，使用 `PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS`；只有主/副端点规范化后属于同一 OpenCode Go 服务且副模型没有独立 key 时，副模型才继承主账号池。不同服务的副模型必须提供自己的 key，不能继承主账号池。凭据发送前，实际请求 URL 还必须精确匹配由 endpoint 与 model 推导出的规范 API 路由。

## 环境为什么只认项目 `.env`

Node 由 `scripts/env-loader.js`，Python 由 `scripts/project_env.py` 加载同一文件。加载器先清理从 shell、IDE、Trae 或 Codex 继承的 `PAPER_ANALYZER_*`、`PAPER_DIGEST_*`、`PD_*`、渠道变量和大小写代理变量，再写入当前项目值，并把文件权限收紧到 `0600`。

因此：

- 不要把项目必需值只写进 `.zshrc`。
- 不要用外层环境临时“补齐”缺失变量。
- 子进程必须使用公共最小环境构造器，避免把 LLM/发布密钥传给 curl、Git hook 或浏览器。

## 代理职责

| 流量 | 规则 |
|---|---|
| Muse 精确模型 | 强制 `HTTPS_PROXY` 或 `HTTP_PROXY` 的 HTTP CONNECT；一次请求一个 agent |
| arXiv 元数据/HTML/PDF/图片 | 强制 HTTP CONNECT |
| HuggingFace curl | 继承 HTTP(S) 代理，可额外用 `ALL_PROXY` SOCKS |
| 其他 LLM | 默认 `agent:false` 直连 |
| 外部图片/Demo | HTTPS only；逐跳校验公网 IP |

缺代理必须明确失败，不能静默直连。访问本地代理的脚本必须沙箱外运行。

## 常用容量参数

| 变量 | 默认 |
|---|---:|
| `PD_ANALYSIS_CONCURRENCY` | 3 |
| `PD_ANALYSIS_API_MAX_TOKENS` | 64000 |
| `PD_ANALYSIS_REPAIR_MAX_TOKENS` | 16000 |
| `PD_API_READER_MAX_TOKENS` | 48000 |
| `PD_API_READER_EVIDENCE_MAX_CHARS` | 180000 |
| `PD_API_READER_CONTEXT_MAX_CHARS` | 240000 |
| `PD_API_READER_CONCURRENCY` | 5（单进程 Reader generation slot） |
| `PD_BLOG_REVIEW_CONCURRENCY` | 5 |

Muse 筛选使用 `PD_FILTER_BATCH_SIZE`；整篇分析按 `PD_ANALYSIS_CONCURRENCY` 并发。账号池状态更新使用短锁，网络请求不持锁。Responses 只有 `PD_OPENAI_RESPONSES_STREAM=1` 时启用 SSE。

## 可选副模型

API Reader v3 会把安全物化的官方 Figure 直接交给主模型，主模型端点因此需要支持 Responses 图片输入。设置 `PAPER_ANALYZER_SECONDARY_MODEL` 只启用旧 canonical 的额外 image-supplement：副模型筛选候选图和规划局部插入，不替换主模型原文，也不参与评分。secondary endpoint 未设置时复用主端点；secondary key 只有在主副属于同一规范服务时才可复用，跨服务必须显式配置。

`PD_API_READER_CONCURRENCY` 限制进程内 Reader 重阶段槽；`api:reader:refresh --concurrency N` 限制刷新命令同时处理的论文 worker。两者不是同一个并发旋钮，命令的实际吞吐还受前者排队约束。

文件日志默认保留 30 天且总量不超过 256 MiB，可分别用 `PD_LOG_RETENTION_DAYS` 和 `PD_LOG_MAX_TOTAL_BYTES` 覆写。

## 博客与 Hugo

`PAPER_DIGEST_BLOG_REPO` 必须指向真实 Hugo 仓库。生成阶段可以在缺目录时跳过“博客已发布去重”，但真实发布不能。review 会运行 Hugo 门禁；Hugo 可执行文件必须在沙箱外环境可用。

发布端不会无限等待外部进程。图片审查、Hugo、Git 本地操作、commit/hook、push/远端核验和视觉规划默认分别受 120、300、30、180、180、120 秒的绝对截止时间约束，可用 `PD_BLOG_IMAGE_REVIEW_DEADLINE_SECONDS`、`PD_HUGO_GATE_TIMEOUT_SECONDS`、`PD_GIT_LOCAL_TIMEOUT_SECONDS`、`PD_GIT_COMMIT_TIMEOUT_SECONDS`、`PD_GIT_NETWORK_TIMEOUT_SECONDS`、`PD_VISUAL_PLANNER_TIMEOUT_SECONDS` 在 `env.example` 给出的范围内覆写。超时不会签发伪造的 review 或远端 OID；已建立但尚未验证远端的本地发布提交会保留供续跑收养。

## 验证安装

```bash
node --version
npm test
npm run validate:data -- --allow-empty
```

测试和项目脚本同样要求沙箱外执行。不要用真实日更作为环境探针；API 路由可用 `node scripts/test-api-key.js` 独立验证。

## 安全边界

- `.env`、`data/`、`logs/` 和缓存均不得提交。
- 真实 endpoint 必须 HTTPS。
- 日志不得出现 key、Authorization、Cookie、secret、password 或 URL userinfo。
- 非 dry-run 微信发布还要求 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_THUMB_MEDIA_ID`；可选渠道不属于默认日更。
- Manual 环境与命令只从 [manual/README.md](../manual/README.md) 进入。
