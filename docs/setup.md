# 环境变量与配置

## 环境变量与模型配置

### 6.1 统一存放位置

**所有环境变量统一放在 `项目根目录的 `.env` 文件`。**

这样设计的好处：
- 敏感配置集中管理，不写入脚本
- Node 脚本通过 `scripts/env-loader.js` / `loadEnvFile()` 读取项目根 `.env`
- Python 脚本通过 `scripts/project_env.py` 读取项目根 `.env`
- 脚本启动时会清理继承自 Trae/Codex/shell 的同名项目变量，再写入当前项目 `.env`，避免不同供应商 key/model/endpoint 混用

### 6.2 环境变量清单

#### 筛选与深度分析（统一使用 `PAPER_ANALYZER_*`）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PAPER_ANALYZER_API_KEY` | LLM API Key | **必填** |
| `PAPER_ANALYZER_ENDPOINT` | LLM API 基路径（如 `/v1`、`/coding/v1`、`/anthropic`，脚本自动拼接最终请求路径） | **必填** |
| `PAPER_ANALYZER_MODEL` | LLM 模型名 | **必填** |
| `PAPER_ANALYZER_SECONDARY_MODEL` | 副模型名；设置后启用图像筛选与插图计划 | 可选 |
| `PAPER_ANALYZER_SECONDARY_ENDPOINT` | 副模型 API 基路径；未设置时复用主模型 endpoint | 可选 |
| `PAPER_ANALYZER_SECONDARY_API_KEY` | 副模型 API Key；未设置时复用主模型 key | 可选 |
| `PD_ANALYSIS_CONCURRENCY` | 深度分析并发度 | 3 |
| `PD_ANALYSIS_MAX_RETRIES` | 深度分析单篇重试次数 | 2 |
| `PD_ANALYSIS_REPAIR_MAX_TOKENS` | 审校、表格、方法与结构局部修复的输出 token 上限 | 16000 |
| `PD_ANALYSIS_FULL_TEXT_MAX_CHARS` | 主分析超长全文的跨文档取样字符预算 | 200000 |
| `PD_OPENSOURCE_EVIDENCE_MAX_CHARS` | 开源扫描的任务相关证据字符预算 | 16000 |
| `PD_REVISION_EVIDENCE_MAX_CHARS` | 审校重写的任务相关证据字符预算 | 60000 |
| `PD_SCORING_EVIDENCE_MAX_CHARS` | 最终评分审计的任务相关证据字符预算 | 40000 |
| `PD_REPAIR_EVIDENCE_MAX_CHARS` | 方法与表格局部修复的任务相关证据字符预算 | 30000 |
| `PD_STRUCTURE_EVIDENCE_MAX_CHARS` | 最终结构修复的任务相关证据字符预算 | 40000 |
| `PD_REANALYZE_CONCURRENCY` | 重分析并发度 | 3（与 `ANALYSIS_CONFIG.concurrency` 一致） |
| `PD_FILTER_BATCH_SIZE` | LLM 筛选每批篇数 | 5 |
| `PD_ARXIV_MAX_RESULTS` | arXiv 每类抓取数量 | 100 |
| `PD_KEYWORD_PREFILTER_ENABLED` | 是否启用高召回关键词预筛；设为 `0` 可临时禁用 | 1 |
| `PD_ARXIV_RATE_LIMIT_MAX_WAIT_MS` | 单类遇到 HTTP 429 时的累计退避上限（毫秒） | 120000 |
| `PD_IMAGE_MAX_BYTES` | 深度分析单张图片原始字节上限 | 6291456 |
| `PD_IMAGE_DOWNLOAD_TIMEOUT_MS` | 深度分析单张候选图片下载超时（毫秒） | 60000 |
| `PD_ARXIV_FETCH_TIMEOUT_MS` | arXiv HTML 与图片发现请求超时（毫秒） | 60000 |
| `PD_ARXIV_PDF_TIMEOUT_MS` | arXiv PDF 全文 fallback 下载超时（毫秒） | 180000 |
| `PD_ARXIV_PDF_MAX_BYTES` | arXiv PDF fallback 最大字节数 | 52428800 |
| `PD_SCORING_AUDIT_TEMPERATURE` | 最终评分审计温度 | 0.1 |
| `PD_IMAGE_PLAN_TEMPERATURE` | 副模型图片计划温度 | 0.2 |
| `PD_IMAGE_MAX_BASE64_CHARS` | 深度分析单张图片 base64 字符上限 | 8388608 |
| `PD_IMAGE_TOTAL_BASE64_CHARS` | 深度分析单篇论文所有图片 base64 总上限 | 20971520 |
| `PD_IMAGE_INSERTION_MAX` | 副模型每篇默认最多实际插入的高价值图片数；可用正整数覆写 | 4 |
| `PD_VISUAL_CJK_FONT` | 本地确定性视觉调试渲染器使用的 CJK 字体绝对路径 | 未设置时自动探测 |
| `PAPER_DIGEST_ENABLE_FILE_LOGS` / `PD_ENABLE_FILE_LOGS` | 兼容旧配置；文件日志现在默认启用 | 已启用 |
| `PAPER_DIGEST_DISABLE_FILE_LOGS` / `PD_DISABLE_FILE_LOGS` | 设为 `1` 时强制禁用文件日志 | 未启用 |

**API 协议自动路由**：`scripts/utils.js` 中的 `detectApiType()` 会根据端点和模型名自动判断使用 OpenAI 还是 Anthropic 协议，优先级如下：
- **DeepSeek**：端点含 `deepseek.com` 或模型含 `deepseek` 时强制 OpenAI 协议，`/anthropic` 路径也会转为 `/v1/chat/completions`
- **MiMo Token Plan**：端点含 `token-plan` 且模型含 `mimo` 时走 Anthropic 协议，`https://token-plan-cn.xiaomimimo.com/v1` → `https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages`
- **Kimi Coding Plan**：`api.kimi.com` 的 `coding` 端点（包括 `k3` 等不含 `kimi` 字样的模型名）走 Anthropic 协议；`https://api.kimi.com/coding` 与 `https://api.kimi.com/coding/v1` 都会归一化为 `https://api.kimi.com/coding/v1/messages`，不需要 `/anthropic` 中间路径
- **普通 `/anthropic` 端点**：非 DeepSeek endpoint 中含 `/anthropic` 时走 Anthropic 协议并拼接 `/messages`
- **其他端点/模型**：走 OpenAI 协议并拼接 `/v1/chat/completions`

#### 博客发布

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PAPER_DIGEST_BLOG_REPO` | Hugo 博客仓库本地路径 | `~/code/github_repos/audio-paper-digest-blog` |
| `PAPER_DIGEST_BLOG_BASE_PATH` | 博客站点 base URL 路径（影响内部链接） | `/audio-paper-digest-blog` |
| `PAPER_DIGEST_BLOG_URL` | 博客部署后的访问地址（如 `https://nanless.github.io/audio-paper-digest-blog/posts`） | `https://nanless.github.io/audio-paper-digest-blog/posts` |
| `PAPER_DIGEST_REPO_URL` | 小红书等文案中附带的项目仓库地址 | `github.com/nanless/audio-paper-digest` |
| `PAPER_DIGEST_GITHUB_REMOTE` | Git 远程仓库名称 | `origin` |
| `PD_BLOG_REVIEW_CONCURRENCY` | 独立论文页三层 review 并发度，限制 1–5（汇总页仍先串行审查） | `5` |
| `PD_BLOG_REVIEW_CHUNK_CHARS` | 文本 review 分块字符数；限制为 4000–16000，值变化会刷新整批协议凭证，但 SHA 未变页面的逐文件通过记录仍可复用 | `8000` |
| `PD_BLOG_REVIEW_MAX_TOKENS` | 单次博客 LLM review 输出预算；隐藏推理耗尽且无最终 JSON 时只执行一次纯 JSON 恢复，默认最高 8000 | `4000` |

发布阶段的 LLM 调用会记录请求开始、响应/异常、单次耗时、prompt 长度和图片数；日志不会输出 API key、认证头或正文内容。若日志只出现 `→` 而没有 `✓` 或失败行，表示进程在 HTTP 请求尚未返回时被外部终止，不能据此签发审查凭证或推送。

#### 微信公众号

| 变量 | 说明 |
|------|------|
| `WECHAT_APP_ID` | 微信公众号 AppID |
| `WECHAT_APP_SECRET` | 微信公众号 AppSecret |
| `WECHAT_THUMB_MEDIA_ID` | 封面图永久素材 ID（真实发布必填；`--dry-run` 可省略） |
| `PAPER_DIGEST_AUTHOR` | 微信公众号文章作者名（可选） |

#### 小红书

| 变量 | 说明 |
|------|------|
| `XIAOHONGSHU_COOKIES` | 小红书自动发布 Cookie；可通过 `npm run xhs-login` 获取 |
| `PD_XIAOHONGSHU_ONELINER_CONCURRENCY` | TOP N 一句话亮点的 LLM 并发度，范围 1–5，默认 `5` |

#### 飞书文档

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 App ID（如 `cli_xxx`） |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret |

> 写入项目根目录的 `.env` 文件即可（不需要 `export` 前缀）。脚本运行时会直接读取当前项目 `.env`。

Node/Python 加载器会先清除外层进程中的同名项目变量，再加载该文件，并把 `.env` 权限收紧为 `0600`。LLM 调用要求 API key、endpoint、model 三项同时存在；任何入口都不会用硬编码 OpenAI endpoint/model 补齐残缺配置。

#### 执行环境

**所有项目脚本必须在沙箱外运行**，包括直接执行的 `scripts/*.js`、`scripts/*.py`、`run-daily-digest.sh`、`run-full-fetch.sh` 和 `scripts/*.sh`。Node 的 `env-loader.js`、Python 的 `project_env.py` 与 shell 入口会在检测到 `CODEX_SANDBOX` 时，在日志、网络请求、文件写入和业务逻辑前拒绝执行；模块被单元测试导入不触发该守卫。沙箱外权限包装可能保留网络禁用标志，不能单独据此判定仍在沙箱内。

#### 代理

| 变量 | 说明 |
|------|------|
| `HTTPS_PROXY` / `HTTP_PROXY` | **至少配置一项**。arXiv Node 抓取使用的 HTTP CONNECT 代理，例如 `http://127.0.0.1:7897` |
| `ALL_PROXY` | 可选。HuggingFace `curl` 可使用的 SOCKS/全局代理，例如 `socks5h://127.0.0.1:7897` |
| `NO_PROXY` | 本地地址白名单，例如 `localhost,127.0.0.1,::1` |

抓取代理是必需项：arXiv 元数据、HTML/PDF/图片和 HuggingFace Papers 都会拒绝无代理直连；历史补录与微信的 arXiv 图片下载也使用同一项目代理。`HTTPS_PROXY` 或 `HTTP_PROXY` 至少配置一项，且必须是 HTTP CONNECT 地址；HuggingFace 的 Node `curl` 可以额外使用 `ALL_PROXY=socks5h://...`，调用时会显式指定代理并清空 `NO_PROXY` 绕过列表。LLM 请求始终直连，不会走抓取代理。代理变量只从项目根 `.env` 加载；脚本会清除 shell/IDE 继承的同名代理变量，不再读取 macOS `scutil` 系统代理。使用本机代理时，抓取、深度分析和重分析命令必须在沙箱外运行，沙箱内无法连接 `127.0.0.1` 不能作为网络故障依据。

博客的生成、审查和推送同样必须在沙箱外运行，即使生成阶段没有直接调用 LLM。`generate-blog.py`、`review-blog.py`、`push-blog.py` 与兼容 `publish-to-blog.py` 会拒绝可靠沙箱标志 `CODEX_SANDBOX`；沙箱外权限包装可能保留网络禁用标志，不能单独据此拒绝执行。这样可确保后续 LLM 审查、图片下载、Hugo 和 Git 网络操作不会因沙箱受限而产生误判。

### 6.3 配置示例

项目根目录的 `.env` 文件格式（**不需要 `export` 前缀**）：

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

所有主脚本默认同时输出到终端和 `logs/*.log`。如需关闭文件日志，在项目根 `.env` 中设置 `PD_DISABLE_FILE_LOGS=1` 或 `PAPER_DIGEST_DISABLE_FILE_LOGS=1`。

- **Node 脚本**：通过 `scripts/log-setup.js`
- **Python 脚本**：通过 `scripts/log_setup.py`
- **默认输出位置**：`logs/<script-name>-YYYYMMDD-HHMMSS-<pid>-<seq>.log`
- **默认特性**：UTF-8 纯文本、`0600` 权限、同时输出到终端和日志文件、唯一文件名、同步落盘；每个非空物理日志行以毫秒级北京时间戳（`[YYYY-MM-DD HH:mm:ss.SSS+08:00]`）开头（`backup-data.sh` 在退出汇总日志时补写）；统一脱敏认证头、Cookie、token、secret、password、任意项目密钥实际值和 URL userinfo
- **无上限与无自动清理**：日志不做数量、总量或单文件大小限制，也不会自动删除旧日志

`backfill_papers.py` 复用相同统一日志，不再额外追加 `logs/backfill.log`。`logs/full-fetch-*.log` 可用于排查抓取/分析问题；终端仍会保留完整输出。

**后台缓冲处理**：所有主要 Node 脚本已调用 `process.stdout._handle.setBlocking(true)`，确保后台运行时日志实时 flush。

---

---

## 安装与初始化

### 9.1 依赖

- **Node.js** `>=20.18.1 <21 || >=22.3.0`（`node` / `npm`；Node 21 不在锁定依赖支持范围内）
- **Python** 3.x（`python3` / `pip3`）
- Node.js 依赖：`cheerio`（arXiv HTML 结构化解析）
- Python 第三方库：见根目录 `requirements.txt`（`requests`、`playwright`、`PyYAML`、`Pillow`）。`PyYAML` 是博客 frontmatter 确定性门禁的必需依赖，`Pillow` 是视觉调试渲染器和对应测试的必需依赖，缺失时相关阶段必须失败关闭

### 9.2 初始化

```bash
cd /path/to/audio-paper-digest

# 安装 Node.js 依赖
npm install

# 安装 Python 依赖（博客发布流程也必需）
pip3 install -r requirements.txt

# 创建必要目录
mkdir -p data/current data/archive logs

# 配置 API Key
cat >> 项目根目录的 `.env` 文件 << 'EOF'
PAPER_ANALYZER_API_KEY=your-llm-key
PAPER_ANALYZER_MODEL=your-llm-model
PAPER_ANALYZER_ENDPOINT=https://your-llm-endpoint/v1

# 如需发布微信公众号，额外设置：
# WECHAT_APP_ID=your-app-id
# WECHAT_APP_SECRET=your-app-secret
EOF

# 保存后直接运行脚本即可；脚本会读取当前项目根 `.env`
```

### 9.3 博客仓库准备

发布博客需要本地已克隆 Hugo 博客仓库。默认路径为 `~/code/github_repos/audio-paper-digest-blog`，可通过项目根 `.env` 中的 `PAPER_DIGEST_BLOG_REPO` 自定义：

```bash
# 默认路径（不设置 env 时的默认值）
git clone https://github.com/nanless/audio-paper-digest-blog.git \
  ~/code/github_repos/audio-paper-digest-blog

# 或自定义路径
PAPER_DIGEST_BLOG_REPO="~/my-blog-repo"
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
   dates = [p.get('fetchedAt', '')[:10] for p in papers if p.get('fetchedAt')]
   print('总论文:', len(papers))
   print('fetchedAt 批次日期分布:', Counter(dates))
   PY
   ```

3. **用户明确"不要动某天"时，禁止删除/覆盖该日期内容**
   - 博客 generation/review/push 不依赖视觉图；`generate-blog.py` 只安装目标日期的汇总页和全部单篇页
   - `push-blog.py` 验证远端 OID 后才自动建立 TOP 10 论文长图和汇总图任务
   - 若数据文件包含多日期论文，请拆分数据或确认意图后再发布

4. **不要重复发布同一天**
   - 重复运行 `generate-blog.py --date 2026-04-21` 会覆盖该日期的博客文件；随后必须重新运行 `review-blog.py` 以刷新整批凭证，但路径与 SHA-256 均未变化的已通过页面不会再次调用三层 review。`push-blog.py` 只接受与当前文件完全一致的 SHA-256 审查凭证。
   - 如需追加论文，应重新生成完整数据后再发布

5. **发布后视觉资产必须断点续跑，不要全量重画**
   - 必须先存在远端验证成功的博客发布凭证；`npm run visual:post-publish -- --date YYYY-MM-DD` 只规划最终评分 TOP 10
   - 规划后运行 `npm run visual:prepare -- --date YYYY-MM-DD`，校验 `.bin` 参考缓存并输出内置生图可直接上传的绝对 `referencedImagePaths`
   - `visual:post-publish` 在博客事务锁内统一规划两类图片；只把缺失、失败、损坏、发布版本/分析/prompt 指纹失效或进入 TOP 10 的论文长图置为 pending
   - 批次汇总图只在已发布论文快照、热门方向、排名、category、发布提交或 prompt 变化时重建任务
   - 用各自 `record` 命令登记后重新运行两个 `status`；不得手写 manifest 或跳过 SHA/task token 校验

---
