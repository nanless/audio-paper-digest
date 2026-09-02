# 安装与环境配置

## 适合谁

给第一次运行默认 LLM/API 日更，或排查“环境明明配了但脚本没读到”的用户。流程概念见 [workflow.md](workflow.md)，变量的完整示例见 [env.example](../env.example)。

## 最短安装路径

```bash
npm install
python3 -m pip install -r requirements.txt
cp env.example .env
```

Node 必须满足 `>=20.18.1 <21 || >=22.3.0`。项目使用 Node 内置测试框架；Python 依赖用于博客、Hugo 门禁与视觉辅助。

## 最小 `.env`

```dotenv
PAPER_ANALYZER_API_KEY=your-key
PAPER_ANALYZER_MODEL=muse-spark-1.2-contributor
PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
PAPER_DIGEST_BLOG_REPO=/absolute/path/to/audio-paper-digest-blog
```

默认模型是 OpenCode Go 的 Muse Spark 1.2 Contributor，协议为 OpenAI Responses。endpoint 必须为 HTTPS；只有 loopback 测试服务允许 HTTP。

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
| `PD_API_READER_CONCURRENCY` | 5 |
| `PD_BLOG_REVIEW_CONCURRENCY` | 5 |

Muse 的筛选实际 batch 固定为 1；整篇分析仍按 `PD_ANALYSIS_CONCURRENCY` 并发。Responses 只有 `PD_OPENAI_RESPONSES_STREAM=1` 时启用 SSE。

## 可选副模型

设置 `PAPER_ANALYZER_SECONDARY_MODEL` 后，主模型仍只写文本，副模型只做候选图筛选和插图计划。secondary endpoint/key 未设置时复用主模型对应值。副模型必须支持图片输入；不得替换主模型原文或参与评分。

## 博客与 Hugo

`PAPER_DIGEST_BLOG_REPO` 必须指向真实 Hugo 仓库。生成阶段可以在缺目录时跳过“博客已发布去重”，但真实发布不能。review 会运行 Hugo 门禁；Hugo 可执行文件必须在沙箱外环境可用。

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
