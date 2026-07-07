# 环境变量与配置

## 环境变量与模型配置

### 6.1 统一存放位置

**所有环境变量统一放在 `项目根目录的 `.env` 文件`。**

`.zshrc` 已配置自动加载：
```zsh
set -a; source 项目根目录的 `.env` 文件 2>/dev/null; set +a
```

这样设计的好处：
- 敏感配置集中管理，不写入脚本
- shell 启动时自动注入，Python 脚本（`publish-wechat-full.py` 等）直接通过 `os.environ` 读取
- Node 脚本通过 `loadEnvFile()` 二次兜底（仅补未设置的变量）

### 6.2 环境变量清单

#### 筛选与深度分析（统一使用 `PAPER_ANALYZER_*`）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PAPER_ANALYZER_API_KEY` | LLM API Key | **必填** |
| `PAPER_ANALYZER_ENDPOINT` | LLM API 基路径（如 `/v1`、`/coding/v1`、`/anthropic`，脚本自动拼接最终请求路径） | **必填** |
| `PAPER_ANALYZER_MODEL` | LLM 模型名 | **必填** |
| `PD_ANALYSIS_CONCURRENCY` | 深度分析并发度 | 3 |
| `PD_ANALYSIS_MAX_RETRIES` | 深度分析单篇重试次数 | 2 |
| `PD_REANALYZE_CONCURRENCY` | 重分析并发度 | 3（与 `ANALYSIS_CONFIG.concurrency` 一致） |
| `PD_FILTER_BATCH_SIZE` | LLM 筛选每批篇数 | 5 |
| `PD_ARXIV_MAX_RESULTS` | arXiv 每类抓取数量 | 100 |

**API 协议自动路由**：`scripts/utils.js` 中的 `detectApiType()` 会根据端点和模型名自动判断使用 OpenAI 还是 Anthropic 协议
- **Anthropic 协议**（自动伪装 Claude Code）：端点含 `token-plan` 或 `coding` **且** 模型含 `mimo` 或 `kimi`
  - **MiMo Token Plan**: `https://token-plan-cn.xiaomimimo.com/v1` → `https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages`
  - **Kimi Coding Plan**: `https://api.kimi.com/coding/v1` → `https://api.kimi.com/coding/v1/messages` 不需要 `/anthropic` 中间路径
  - Headers: `x-api-key` + `anthropic-version: 2023-06-01` + `User-Agent: claude-cli/<version> (external, cli)`（版本号动态获取自本地 `claude --version`，失败回退到 `2.1.108`）
- **OpenAI 协议**（通用模式）：所有其他端点/模型
  - 端点保持原样，自动拼接 `/v1/chat/completions`
  - Headers: `Authorization: Bearer {key}`

#### 博客发布

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PAPER_DIGEST_BLOG_REPO` | Hugo 博客仓库本地路径 | `~/code/github_repos/audio-paper-digest-blog` |
| `PAPER_DIGEST_BLOG_BASE_PATH` | 博客站点 base URL 路径（影响内部链接） | `/audio-paper-digest-blog` |
| `PAPER_DIGEST_BLOG_URL` | 博客部署后的访问地址（如 `https://nanless.github.io/audio-paper-digest-blog/posts`） | `https://nanless.github.io/audio-paper-digest-blog/posts` |
| `PAPER_DIGEST_GITHUB_REMOTE` | Git 远程仓库名称 | `origin` |

#### 微信公众号

| 变量 | 说明 |
|------|------|
| `WECHAT_APP_ID` | 微信公众号 AppID |
| `WECHAT_APP_SECRET` | 微信公众号 AppSecret |
| `WECHAT_THUMB_MEDIA_ID` | 封面图永久素材 ID（可选，未设置时使用默认素材） |
| `PAPER_DIGEST_AUTHOR` | 微信公众号文章作者名（可选） |

#### 飞书文档

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 App ID（如 `cli_xxx`） |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret |

> 写入 `项目根目录的 `.env` 文件` 即可（不需要 `export` 前缀）。脚本运行时会自动 `source` 该文件。

#### 代理

| 变量 | 说明 |
|------|------|
| `https_proxy` / `HTTPS_PROXY` | HTTPS 代理 |
| `http_proxy` / `HTTP_PROXY` | HTTP 代理 |
| `all_proxy` / `ALL_PROXY` | 全局代理 |

支持 HTTP CONNECT 代理，纯 Node 内置模块实现，无需外部依赖。自动检测顺序：环境变量 → macOS 系统代理（`scutil --proxy`）。

### 6.3 配置示例

`项目根目录的 `.env` 文件` 格式（**不需要 `export` 前缀**）：

```bash
# Paper Digest 环境变量

# === 方案 1: MiMo Token Plan（推荐，伪装 Claude Code 调用 Anthropic 协议）===
PAPER_ANALYZER_API_KEY=tp-your-token-plan-key
PAPER_ANALYZER_MODEL=mimo-v2.5
PAPER_ANALYZER_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1

# === 方案 2: MiMo 按量付费（通用 OpenAI 协议）===
# PAPER_ANALYZER_API_KEY=sk-your-pay-as-you-go-key
# PAPER_ANALYZER_MODEL=mimo-v2.5
# PAPER_ANALYZER_ENDPOINT=https://api.xiaomimimo.com/v1

# === 方案 3: Kimi Coding Plan（伪装 Claude Code 调用 Anthropic 协议）===
# PAPER_ANALYZER_API_KEY=sk-your-kimi-key
# PAPER_ANALYZER_MODEL=kimi-for-coding
# PAPER_ANALYZER_ENDPOINT=https://api.kimi.com/coding/v1

# === 方案 4: 通用 OpenAI 兼容端点 ===
# PAPER_ANALYZER_API_KEY=sk-your-openai-key
# PAPER_ANALYZER_MODEL=gpt-4o
# PAPER_ANALYZER_ENDPOINT=https://api.openai.com/v1

# 微信公众号（如需发布）
WECHAT_APP_ID=your-app-id
WECHAT_APP_SECRET=your-app-secret
# PAPER_DIGEST_AUTHOR=your-name

# 飞书（其他项目共用）
FEISHU_APP_ID=your-feishu-app-id
FEISHU_APP_SECRET=your-feishu-app-secret

# 博客/小红书（如需在文案中展示博客地址）
# PAPER_DIGEST_BLOG_URL=https://nanless.github.io/audio-paper-digest-blog/posts
```

**重要说明**：
- 端点格式统一为 `协议://域名/v1`，不管后续用哪种协议，配置方式一致
- 脚本会根据端点和模型名自动判断是否需要使用 Anthropic 协议
- Token Plan key 前缀为 `tp-`，按量付费 key 前缀为 `sk-`，两者不可混用

---

---

## 日志机制

所有主脚本启动后会自动写日志：

- **Node 脚本**：通过 `scripts/log-setup.js`
- **Python 脚本**：通过 `scripts/log_setup.py`
- **输出位置**：`logs/<script-name>-YYYYMMDD-HHMMSS.log`
- **特性**：同时输出到终端和日志文件（Tee 模式），flush 及时
- **自动清理**：每次启动时清理旧日志，**保留最近 50 个**

特殊日志：
- `backfill_papers.py` 额外写 `logs/backfill.log`（持久追加）
- `logs/full-fetch-*.log` 是排查抓取/分析问题的首选

**后台缓冲处理**：所有主要 Node 脚本已调用 `process.stdout._handle.setBlocking(true)`，确保后台运行时日志实时 flush。

---

---

## 安装与初始化

### 9.1 依赖

- **Node.js** ≥ 18.0.0（`node` / `npm`）
- **Python** 3.x（`python3` / `pip3`）
- Node.js 依赖：`cheerio`（arXiv HTML 结构化解析）
- Python 第三方库：`requests`（仅 `backfill_papers.py` 使用）

### 9.2 初始化

```bash
cd ~/.hermes/skills/openclaw-imports/audio-paper-digest

# 安装 Node.js 依赖
npm install

# 安装 Python 依赖（如有需要）
pip3 install requests

# 创建必要目录
mkdir -p data/current data/archive logs

# 配置 API Key
mkdir -p ~/.hermes
cat >> 项目根目录的 `.env` 文件 << 'EOF'
PAPER_ANALYZER_API_KEY=your-llm-key
PAPER_ANALYZER_MODEL=your-llm-model
PAPER_ANALYZER_ENDPOINT=https://your-llm-endpoint/v1

# 如需发布微信公众号，额外设置：
# WECHAT_APP_ID=your-app-id
# WECHAT_APP_SECRET=your-app-secret
EOF

# 确保 .zshrc 已 source 项目根目录的 `.env` 文件
# （若尚未配置，在 ~/.zshrc 末尾添加：set -a; source 项目根目录的 `.env` 文件 2>/dev/null; set +a）
```

### 9.3 博客仓库准备

发布博客需要本地已克隆 Hugo 博客仓库。默认路径为 `~/code/github_repos/audio-paper-digest-blog`，可通过环境变量 `PAPER_DIGEST_BLOG_REPO` 自定义：

```bash
# 默认路径（不设置 env 时的默认值）
git clone https://github.com/nanless/audio-paper-digest-blog.git \
  ~/code/github_repos/audio-paper-digest-blog

# 或自定义路径
export PAPER_DIGEST_BLOG_REPO="~/my-blog-repo"
```

博客仓库要求：
- Hugo 站点，使用 PaperMod 主题（或其他支持的标准主题）
- 通过 GitHub Actions 自动部署到 GitHub Pages
- `content/posts/` 目录存放生成的 Markdown 文件
- 若博客部署在子路径下，设置 `PAPER_DIGEST_BLOG_BASE_PATH`（如 `/audio-paper-digest-blog`）

### 9.4 飞书凭据准备

发布飞书文档需要飞书自建应用的 `App ID` 和 `App Secret`：

```bash
# 写入 项目根目录的 `.env` 文件
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=your-full-app-secret
```

> 获取方式：飞书开放平台 → 开发者后台 → 创建企业自建应用 → 查看凭证。

---

---

## 日期安全策略（必须遵守）

1. **发布时优先显式指定 `--date`**
   - 不要依赖脚本的默认"今天"
   - 跨天运行时尤其要注意

2. **发布前确认输入数据文件里的论文日期分布**
   ```bash
   python3 - <<'PY'
   import json
   from collections import Counter
   with open('data/current/deep-analysis-result.json') as f:
       d = json.load(f)
   papers = d.get('papers', [])
   dates = [p.get('published', '')[:10] for p in papers if p.get('published')]
   print('总论文:', len(papers))
   print('日期分布:', Counter(dates))
   PY
   ```

3. **用户明确"不要动某天"时，禁止删除/覆盖该日期内容**
   - `publish-to-blog.py` 会全量重写目标日期的汇总页
   - 若数据文件包含多日期论文，请拆分数据或确认意图后再发布

4. **不要重复发布同一天**
   - 重复运行 `publish-to-blog.py --date 2026-04-21` 会覆盖该日期的博客文件
   - 如需追加论文，应重新生成完整数据后再发布

---
