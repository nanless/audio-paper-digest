---
name: audio-paper-digest
description: >
  ICASSP 2026 论文深度分析自动化技能。从本地 PDF 提取文本与图片，使用环境变量配置的 LLM 做筛选与多模态深度分析，
  输出结构化 JSON，并发布到 Hugo 博客（含任务分类汇总页）。
  适用场景：会议论文批量分析、任务分类归纳、博客发布。
  如需 arXiv / HuggingFace 每日论文速递，请切换至 main 分支。
---

# Paper Digest Skill（以当前代码为准）

## 1. 文档定位

- `SKILL.md`：给 Agent 的执行规则与安全约束
- `README.md`：给人的运行手册（命令、配置、排错）
- `prompts/filter.md`：筛选阶段 LLM prompt
- `prompts/deep-analysis.md`：深度分析阶段 LLM prompt（输出格式、标签体系、评分标准）

当文档与代码冲突时，**以 `scripts/*` 当前实现为准，并同步更新文档**。

---

## 2. ICASSP 2026 本地 PDF 分析流程

本分支（`icassp-2026-analysis`）与日常 arXiv 流程完全独立，用于分析会议本地 PDF 论文。已在 ICASSP 2026 全量 3693 篇论文上验证，筛选出 898 篇语音/音乐/音频相关论文。

**流程**：
1. **PDF 提取**（`pdf-extractor.py`）：PyMuPDF 提取文本（上限 100K）+ 图片（上限 10 张，过滤小图标，自动压缩）
2. **纯 LLM 筛选**（`icassp-batch-analyze.js` 前半段）：标题 + PDF 前 3000 字符摘要 → 单篇判断 → I/O 日志到 `filter_input_output/`
3. **多模态深度分析**（`icassp-batch-analyze.js` 后半段）：全文 + PDF 图片 → `deep-analyzer.js` → I/O 日志到 `deep_analyzer_input_output/`
4. **任务分类**（`icassp-categorize.js`）：按 `primaryTaskTag` / `primaryMethodTag` / 评分区间生成分类报告
5. **博客发布**（`publish-to-blog.py`）：ICASSP 分类 + 任务汇总页 + 单篇页，图片从 `icassp-images/` 复制到博客 static 目录

**关键差异点**：
- 无 `arxivId`，使用 `arnumber` 作为唯一标识
- 图片使用内部标识符 `icassp-img://{paperId}/{index}.{ext}`，非真实 URL
- 博客汇总页 slug 为 `icassp2026-summary`（非日期 slug），分类为 `ICASSP 2026`
- 任务汇总页使用 ASCII-safe 文件名 + `url:` frontmatter 设置中文路径
- `parsed` 字段优先于重新解析 `analysis` 文本（`publish_common.py` 中 `score_and_sort()` 逻辑）

**断点续传**：
- `ICASSP_OFFSET` / `ICASSP_LIMIT` 控制起始位置和数量上限
- `icassp-2026-snippets.json` 缓存 PDF 文本片段，避免重复提取
- 每篇分析完立即增量保存，已有 `analysis` 的论文不会被覆盖

---

## 3. 数据路径规范

### 3.1 优先路径（当前）

| 文件 | 用途 | 归档行为 |
|------|------|---------|
| `data/current/papers.json` | 论文去重数据库 | **不归档**，持续累积 |
| `data/current/filtered-papers.json` | 筛选后的论文元数据 | 每日归档移走后重新生成 |
| `data/current/deep-analysis-result.json` | 核心分析结果（含 analysis / parsed / imageUrls） | 每日归档移走后重新生成 |
| `data/current/analyzed.json` | 旧版已分析记录（兼容） | 每日归档移走后重新生成 |
| `data/current/icassp_2026_deep_analyzers.json` | ICASSP 2026 深度分析结果（当前分支） | 不参与每日归档，增量保存 |
| `data/current/icassp_2026_deep_analyzers-filtered.json` | ICASSP 筛选结果 | 随筛选更新 |
| `data/current/icassp-2026-snippets.json` | ICASSP PDF 文本片段缓存 | 随提取更新 |
| `data/current/icassp-images/` | ICASSP 论文图片（按 paperId 子目录） | 由 pdf-extractor / migrate 生成 |
| `data/current/filter_input_output/` | 筛选阶段 I/O 日志 | 调试用，不参与归档 |
| `data/current/deep_analyzer_input_output/` | 深度分析 I/O 日志 | 调试用，不参与归档 |

### 3.2 兼容行为

部分脚本在读取时兼容 `data/*.json` 旧路径，但新产物应写入 `data/current/`。

### 3.3 归档目录

`data/archive/<YYYY-MM-DD>/` 按日期子目录存放当日归档文件。`deep-analysis-result-<时间戳>.bak.json` 备份文件也存放在此目录下，自动清理保留最近 10 个。

---

## 4. 模型与环境变量

### 4.1 统一存放位置

**所有环境变量统一放在 `~/.hermes/.env`。** `.zshrc` 已配置：
```zsh
set -a; source ~/.hermes/.env 2>/dev/null; set +a
```

这意味着：
- shell 启动时自动注入所有变量
- Python 脚本直接通过 `os.environ` 读取
- Node 脚本通过 `loadEnvFile()` 二次兜底（仅补未设置的变量）

### 4.2 筛选阶段（`fetch-papers.js`）

筛选统一调用 `PAPER_ANALYZER_*` 指定的 LLM：

- endpoint: `PAPER_ANALYZER_ENDPOINT`（必填）
- key: `PAPER_ANALYZER_API_KEY`（必填）
- model: `PAPER_ANALYZER_MODEL`（必填）
- **API 协议自动路由**：`scripts/utils.js` 中的 `detectApiType()` 会根据端点和模型名自动判断使用 OpenAI 还是 Anthropic 协议
  - **MiMo/Kimi Token Plan / Coding Plan**（端点含 `token-plan` 或 `coding`，模型含 `mimo`/`kimi`）→ 自动切换为 **Anthropic 协议**，伪装成 Claude Code 调用
    - **MiMo**: `https://token-plan-cn.xiaomimimo.com/v1` → `https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages`（替换 `/v1` 为 `/anthropic`）
    - **Kimi**: `https://api.kimi.com/coding/v1` → `https://api.kimi.com/coding/v1/messages`（直接加 `/messages`，无需 `/anthropic` 中间路径）
    - Headers: `x-api-key` + `anthropic-version: 2023-06-01` + `User-Agent: claude-cli/<version> (external, cli)`（版本号动态获取自本地 `claude --version`，失败回退到 `2.1.108`）
    - system message 自动提取为请求体顶级字段（Anthropic 要求）
  - **其他情况**（包括 MiMo 按量付费、通用 OpenAI 兼容端点）→ 使用标准 **OpenAI 协议**
    - URL: `/v1/chat/completions`
    - Headers: `Authorization: Bearer {key}`
- **agent: `false`** — LLM API 请求明确禁用连接复用，避免全局 agent 连接池被代理污染导致 MiMo 403（详见 9.2）
- 超时 60 秒，重试 3 次，每次重试独立创建 AbortController
- 指数退避：抓取 4s/8s/16s（`2^attempt * 2s`，上限 60s），限流 10s/20s/40s（`2^attempt * 5s`，上限 60s）
- prompt 来源：`prompts/filter.md`，运行时通过 `loadPrompt()` 读取并替换 `{title}`、`{abstract}` 占位符
- 判定口径：多模态模型只要明确涉及语音/音乐/音频（输入、输出、训练目标、评测任务或核心能力之一）即判定为相关
- 冲突处理：若同时满足"多模态涉及语音/音乐/音频"和"其他领域"描述，优先判定为"是"

### 4.3 深度分析阶段（`deep-analyzer.js`）

深度分析统一使用 `PAPER_ANALYZER_*` 指定的 LLM，**与筛选阶段共用同一套 API 协议自动路由逻辑**：

- endpoint: `PAPER_ANALYZER_ENDPOINT`（必填）
- key: `PAPER_ANALYZER_API_KEY`（必填）
- model: `PAPER_ANALYZER_MODEL`（必填）
- `detectApiType()` 自动判断协议类型，行为与 4.2 节一致
  - **MiMo**: `/v1` → `/anthropic/v1/messages`
  - **Kimi**: `/coding/v1` → `/coding/v1/messages`

API 调用特性：
- 整体超时 20 分钟（AbortController）
- max_tokens=15000，temperature=0.7
- **双层重试**：analysis-engine.js 层面每篇最多重试 2 次（总共最多 3 次尝试）；deep-analyzer.js 内部每次 API 调用再重试最多 3 次（指数退避：第一次 10 秒，之后翻倍，`2^attempt * 5s`）
- **LLM API 请求明确设置 `agent: false`，强制直连以绕过本地代理（避免 MiMo 403）**
- 使用 **cheerio** 结构化选择器解析 HTML（通用能力），移除 script/style/nav/header/footer 等噪音元素
- 图片下载 **并行化（并发 3）**，下载论文全部图片（无数量限制）；单张 base64 上限 500K 字符；超时后自动降级为纯文本重试
- 全文上限 100K 字符
- 所有分析配置集中管理于 `scripts/config.js`，支持环境变量覆写

输出约束：
- prompt 来源：`prompts/deep-analysis.md`，运行时通过 `loadPrompt()` 读取并替换 `{hasFullText}`、`{title}`、`{authors}`、`{categories}`、`{paperInfo}`、`{textForAnalysis}` 占位符
- 固定一级标题：`## 评分`、`## 标签`、`## 作者与机构`、`## 毒舌点评`、`## 核心摘要`、`## 详细分析`、`## 开源详情`
- `## 评分` 下必须先输出总分，再输出 `## 机器摘要`，包含 `rank_bucket`、`quality_score`、`value_score`、`reproducibility_bonus`、`confidence`、`primary_task_tag`、`primary_method_tag` 等固定键
- 总分采用七维评分体系：创新性（0-3）+ 技术严谨性（0-1.5）+ 实验充分性（0-1.5）+ 清晰度（0-1）+ 影响力（0-2）+ 开源（0-1.5）+ 可复现性（0-0.5），四舍五入到 0.1 分，满分 10 分
- 标签输出必须同时包含最终标签串、`主任务标签`、`主方法标签`、`补充标签`
- 缺失信息必须写“未说明/未提供/未提及”，禁止猜测作者机构、实验数字、开源状态或外部信息
- 修改 `prompts/deep-analysis.md` 或 `prompts/filter.md` 时，需同步检查 `scripts/utils.js` 与 `scripts/utils.py` 的解析逻辑是否仍能匹配新输出格式

### 4.4 微信公众号（`publish-wechat-full.py`）

- `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET` 从 `os.environ` 读取
- `WECHAT_THUMB_MEDIA_ID`（可选）：封面图永久素材 ID，未设置时使用内置默认素材
- 图片上传：下载论文图片 → 上传到微信 CDN → 替换为微信 URL。缓存保存在系统临时目录下的 `wechat-image-cache.json`
- 该脚本会访问真实微信接口；除非用户明确要求生成或上传公众号草稿，否则不要执行
- **注意**：所有发布脚本统一从环境变量读取凭证，禁止硬编码

### 4.5 完整环境变量清单

```bash
# LLM API（筛选 + 深度分析，下面是 4 种常见配置方案，只能选一种启用）

# 方案 1: MiMo Token Plan（推荐，伪装 Claude Code 自动切换 Anthropic 协议）
PAPER_ANALYZER_API_KEY=tp-your-token-plan-key
PAPER_ANALYZER_MODEL=mimo-v2.5
PAPER_ANALYZER_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1

# 方案 2: MiMo 按量付费（通用 OpenAI 协议）
# PAPER_ANALYZER_API_KEY=sk-your-pay-as-you-go-key
# PAPER_ANALYZER_MODEL=mimo-v2.5
# PAPER_ANALYZER_ENDPOINT=https://api.xiaomimimo.com/v1

# 方案 3: Kimi Coding Plan（伪装 Claude Code 自动切换 Anthropic 协议）
# PAPER_ANALYZER_API_KEY=sk-your-kimi-key
# PAPER_ANALYZER_MODEL=kimi-for-coding
# PAPER_ANALYZER_ENDPOINT=https://api.kimi.com/coding/v1

# 方案 4: 通用 OpenAI 兼容端点
# PAPER_ANALYZER_API_KEY=sk-your-openai-key
# PAPER_ANALYZER_MODEL=gpt-4o
# PAPER_ANALYZER_ENDPOINT=https://api.openai.com/v1

# 微信公众号
WECHAT_APP_ID=your-app-id
WECHAT_APP_SECRET=your-app-secret
# WECHAT_THUMB_MEDIA_ID=your-thumb-media-id  # 封面图永久素材 ID（可选，未设置时使用默认素材）

# 飞书文档
FEISHU_APP_ID=your-feishu-app-id
FEISHU_APP_SECRET=your-feishu-app-secret

# 博客发布
# PAPER_DIGEST_BLOG_REPO=~/code/github_repos/audio-paper-digest-blog
# PAPER_DIGEST_BLOG_BASE_PATH=/audio-paper-digest-blog
# PAPER_DIGEST_BLOG_URL=https://your-username.github.io/your-repo
# PAPER_DIGEST_GITHUB_REMOTE=origin

# 微信公众号作者（可选）
# PAPER_DIGEST_AUTHOR=your-name

# 配置覆写（可选）
# PD_ANALYSIS_CONCURRENCY=3       # 深度分析并发度
# PD_ANALYSIS_MAX_RETRIES=2       # 深度分析重试次数
# PD_REANALYZE_CONCURRENCY=1      # 重分析并发度
# PD_FILTER_BATCH_SIZE=5          # LLM 筛选每批篇数
# PD_ARXIV_MAX_RESULTS=100        # arXiv 每类抓取数量（main 分支）

# 代理（可选，但建议为 MiMo Token Plan 关闭或绕过代理）
# https_proxy=http://127.0.0.1:7897
# http_proxy=http://127.0.0.1:7897
# all_proxy=socks5://127.0.0.1:7897
```

**API 协议自动路由概览**：

| 端点特征 | 模型特征 | 自动路由 | Anthropic URL 转换 |
|----------|----------|----------|-------------------|
| 含 `token-plan` | 含 `mimo` | Anthropic | `/v1` → `/anthropic/v1/messages` |
| 含 `coding` | 含 `kimi` | Anthropic | `/coding/v1` → `/coding/v1/messages` |
| 任意其他 | 任意其他 | OpenAI | `/v1/chat/completions` |

端点配置格式统一为 `协议://域名/v1`，不管后续用哪种协议，配置方式一致。

---

## 5. 常用命令（ICASSP 2026）

```bash
cd ~/.hermes/skills/openclaw-imports/audio-paper-digest

# 完整流程：筛选 + 深度分析（增量续传）
node scripts/icassp-batch-analyze.js

# 仅执行筛选
ICASSP_FILTER_ONLY=true node scripts/icassp-batch-analyze.js

# 跳过筛选，直接分析已筛选的论文
ICASSP_SKIP_FILTER=true node scripts/icassp-batch-analyze.js

# 从第 500 篇开始分析（断点续传）
ICASSP_OFFSET=500 node scripts/icassp-batch-analyze.js

# 只分析前 100 篇
ICASSP_LIMIT=100 node scripts/icassp-batch-analyze.js

# 提取 PDF 内容测试
python3 scripts/pdf-extractor.py /path/to/paper.pdf --max-images 10

# 生成分类报告
node scripts/icassp-categorize.js

# 重试无评分的论文
node scripts/retry-failed-analysis.js

# 文本-only 重试（绕过 API 安全过滤）
node scripts/retry-text-only.js

# 重试筛选失败的论文（降低并发）
node scripts/retry-failed-filters.js

# 从分析日志提取图片到 icassp-images/
node scripts/migrate-icassp-images.js

# 发布 ICASSP 博客（含任务分类汇总页）
python3 scripts/publish-to-blog.py --date 2026-04-29 data/current/icassp_2026_deep_analyzers.json

# 只生成 Markdown，不推送
python3 scripts/publish-to-blog.py --skip-push --date 2026-04-29 data/current/icassp_2026_deep_analyzers.json

# 运行单元测试
npm test
```

---

## 6. 发布行为与日期安全（ICASSP）

发布脚本：`scripts/publish-to-blog.py`

### 核心原则

- ICASSP 博客使用固定 slug `icassp2026-summary`，分类为 `ICASSP 2026`
- 日期参数 `--date` 用于图片目录组织和博客文件命名，不代表论文原始发布日期
- 全部 898 篇论文都会发布，不做任何过滤

当前行为：

- 读取 `data/current/icassp_2026_deep_analyzers.json`
- 在 `~/code/github_repos/audio-paper-digest-blog/content/posts` 生成：
  - 汇总页：`icassp2026-summary.md`
  - 任务汇总页：`icassp2026-task-XXX.md`
  - 单篇页：`YYYY-MM-DD-<slug>.md`
- 默认会执行 `git add -A`、`git commit`、`git push origin main`

Agent 执行约束：

- 默认仅允许使用 `--skip-push` 模式验证博客生成结果
- 只有用户明确要求“正式发布 / 推送博客”时，才允许去掉 `--skip-push`
- 若只是检查格式、验证新字段或预览产物，禁止触发真实 `git push`

### 发布前检查

```bash
python3 - <<'PY'
import json
with open('data/current/icassp_2026_deep_analyzers.json') as f:
    d = json.load(f)
papers = d.get('papers', [])
analyzed = sum(1 for p in papers if p.get('analysis'))
scored = sum(1 for p in papers if p.get('parsed', {}).get('score'))
print(f'总论文: {len(papers)}')
print(f'已分析: {analyzed}')
print(f'有评分: {scored}')
PY
```

---

## 7. 日志与运行特性

- Node 脚本统一通过 `scripts/log-setup.js` 输出日志到 `logs/<script>-YYYYMMDD-HHMMSS.log`
- Python 脚本统一通过 `scripts/log_setup.py` 输出日志到 `logs/<script>-YYYYMMDD-HHMMSS.log`
- **自动清理**：每次启动时清理旧日志，保留最近 50 个
- 主要 Node 脚本已处理后台 stdout 缓冲（`setBlocking`），便于实时查看进度
- `icassp-batch-analyze.js` 采用重试与增量保存，降低中断丢数风险
- 每篇分析完立即保存，已有 `analysis` 的论文不会被覆盖

---

## 8. Agent 执行规则（强约束）

1. **先查再改**：先读取相关脚本确认当前行为，再更新文档或执行命令。
2. **发布需确认日期**：未明确日期时，先问用户；默认不要依赖"今天"。
3. **禁止危险操作**：未获明确授权，禁止 `git reset --hard`、`git push -f`、批量删除历史文章。
4. **不自动扩展流程**：运行 `icassp-batch-analyze.js` 后，不要擅自追加博客发布，除非用户明确要求。
5. **改动留痕**：流程、参数、路径变化后，同步更新 `SKILL.md` 和 `README.md`。
6. **禁止硬编码密钥**：不要在任何脚本或文档中写入真实 API key；所有凭证（LLM、微信公众号、飞书）统一从环境变量读取，LLM 配置放在 `~/.hermes/.env`（由脚本自动 `source`），微信/飞书凭据也写入 `~/.hermes/.env`。
7. **修改脚本时防止安全机制破坏**：本环境会静默替换 `API_KEY` 等敏感字符为 `***`。修改含有这类字符的脚本时，修改后必须重新读取文件验证关键行未被破坏。同时定期检查 `data/`、`logs/` 目录是否残留含密钥的备份文件或日志快照，发现立即清理。
8. **环境变量统一管理**：新增脚本需要读取 LLM 配置时，统一使用 `PAPER_ANALYZER_API_KEY`、`PAPER_ANALYZER_MODEL`、`PAPER_ANALYZER_ENDPOINT`，禁止引入别名回退链、硬编码或 base64 编码变量名 hack。
9. **新增可配置参数放入 config.js**：新增脚本涉及可调整参数（并发度、超时、批次大小等）时，统一放入 `scripts/config.js` 并添加对应的环境变量覆写支持。
10. **新增分析脚本复用 analysis-engine.js**：新增论文分析相关脚本时，优先复用 `analysis-engine.js` 的 `analyzeBatch()` / `analyzePaperWithRetry()`，避免重复实现重试、解析、保存逻辑。
11. **博客验证默认不推送**：未获用户明确授权时，运行 `publish-to-blog.py` 必须带 `--skip-push`。
12. **输出契约改动要同步 parser**：若修改 `prompts/deep-analysis.md` 中的 `## 机器摘要` 键名、章节顺序或标签输出格式，必须同步检查 `scripts/utils.js` 与 `scripts/utils.py` 的解析逻辑。
13. **变更后必须做产物级验证**：至少抽样检查一份 `data/current/icassp_2026_deep_analyzers.json`，确认存在 `rank_bucket`、`primary_task_tag`、`primary_method_tag` 等字段，再运行博客脚本验证最终产物。
14. **变更后验证 prompt 加载**：修改 `prompts/` 目录下的 markdown 文件后，运行一次单篇分析测试确认 `loadPrompt()` 能正确读取并替换占位符，无 `{变量名}` 残留。
15. **变更后运行单元测试**：修改 `scripts/utils.js`、`scripts/config.js` 或分析引擎核心逻辑后，必须运行 `npm test` 确保测试通过。
16. **MiMo API 请求必须禁用代理连接复用**：`fetch-papers.js` 和 `deep-analyzer.js` 中调用 LLM API 时，`options.agent` 必须为 `false`（不是 `undefined`）。任何重构或修改 HTTP 请求逻辑时，禁止将 `agent: false` 改回 `agent: proxyAgent` 或 `agent: undefined`，否则 MiMo Token Plan 会在有系统代理的环境中返回 403。
17. **新增 LLM 端点必须接入 API 协议自动路由**：任何新增脚本调用 LLM 时，统一使用 `scripts/utils.js` 中的 `detectApiType()`、`buildApiUrl()`、`buildHeaders()`、`buildRequestBody()`、`parseResponseText()`，禁止硬编码特定协议的 URL/Header/Body。
18. **修改 API 协议路由逻辑时同步全链路**：修改 `detectApiType()` 的判定规则或 `buildApiUrl()`/`buildHeaders()` 等函数时，必须同步检查 `deep-analyzer.js`、`icassp-batch-analyze.js` 以及所有使用 `analysis-engine.js` 的脚本，确保全链路行为一致。
19. **禁止将敏感文件提交到版本控制**：`data/`、`logs/`、`*.env`、`*.backup*`、缓存文件、含密钥的日志归档等严禁进入 git；提交前必须确认 `.gitignore` 已正确配置，且仓库中不存在历史遗留的敏感文件。
20. **ICASSP 图片处理优先使用本地目录**：博客发布时，优先从 `data/current/icassp-images/{paperId}/` 复制图片；若不存在才回退到从 `deep_analyzer_input_output/{paperId}_input.json` 提取。禁止直接引用 `icassp-img://` 标识符到博客正文。
21. **ICASSP 任务页文件名必须 ASCII-safe**：Hugo 无法处理中文文件名，任务汇总页必须使用 ASCII-safe 文件名（如 `icassp2026-task-001.md`），通过 `url:` frontmatter 设置中文 URL 路径。
22. **ICASSP YAML 标签含 `#` 必须引号包裹**：标签如 `多音高估计 #音符跟踪` 在 YAML 中必须写成 `"多音高估计 #音符跟踪"`，否则 `#` 后内容被解析为注释。
23. **ICASSP 发布优先使用 `parsed` 字段**：`publish_common.py` 的 `score_and_sort()`、`extract_top_tags()` 等函数必须优先使用 `p.get('parsed')`，仅在缺失时才回退到 `parse_analysis()`，避免重新解析失败导致评分丢失。
24. **ICASSP 博客发布使用固定 slug**：ICASSP 汇总页 slug 固定为 `icassp2026-summary`，分类为 `ICASSP 2026`，不使用日期 slug。

---

## 9. 最小排错手册

### 9.1 模型调用失败 / API 返回 401 / 403 / timeout

**检查步骤**：

1. **检查 key/endpoint/model 三元组是否匹配**
   | 套餐类型 | 端点 | Key 前缀 | 协议 |
   |---------|------|----------|-------|
   | MiMo Token Plan | `token-plan-cn.xiaomimimo.com/v1` | `tp-` | Anthropic（自动切换） |
   | MiMo 按量付费 | `api.xiaomimimo.com/v1` | `sk-` | OpenAI |
   | Kimi Coding Plan | `api.kimi.com/coding/v1` | `sk-kimi-...` | Anthropic（自动切换） |
   | 通用 OpenAI | 自定义端点 | `sk-...` | OpenAI |

   - MiMo Token Plan key 前缀为 `tp-`，必须配合 Token Plan 端点，两者混用必返回 401
   - 确保 `.env` 已正确配置，且 `.zshrc` 已 source

2. **检查是否走对了协议**（日志中查找 `[filter] API 类型: xxx` 或 `[api] → model | xxx` 行）
   - 若使用 MiMo/Kimi Token Plan 却显示 `openai`，检查端点是否含 `token-plan` 或 `coding`，模型是否含 `mimo` 或 `kimi`
   - 若日志显示 `anthropic`但仍失败，检查是否走的是 `/anthropic/v1/messages` 路径（不是 `/v1/chat/completions`）

3. **Anthropic 协议专项检查**（日志显示 `anthropic` 时）
   - 请求头是否为 `x-api-key`（非 `Authorization: Bearer`）
   - 是否带 `anthropic-version: 2023-06-01`
   - 是否带 `User-Agent: claude-cli/<version> (external, cli)`（日志不会直接显示，可用代理工具验证）

4. **OpenAI 协议专项检查**（日志显示 `openai` 时）
   - 确认使用 `Authorization: Bearer {key}`
   - 确认 URL 路径是 `/v1/chat/completions`

5. **检查代理**（见 9.2 节）
   - MiMo Token Plan 在有系统代理时可能被屏蔽
   - 尝试用 `curl --noproxy "xiaomimimo.com"` 绕过代理测试

6. **查看日志**：`logs/icassp-batch-analyze-*.log`、`logs/deep-analyzer-*.log`

### 9.2 MiMo API 返回 403 Illegal access / timeout / socket hang up

**根因**：Node.js `https.request` 的 `agent: undefined` 仍会复用全局默认 agent 的连接池。当系统配置了代理（`https_proxy` 等环境变量）时，全局 agent 的连接可能被代理污染，导致 MiMo Token Plan 服务端拒绝请求。

**修复**：`fetch-papers.js` 和 `deep-analyzer.js` 中 LLM API 请求的 `options.agent` 必须设为 `false`（不是 `undefined`），彻底禁用连接复用，强制每个请求建立新连接：

```javascript
const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: headers,
    agent: false,  // ← 必须是 false，undefined 无效
    signal: controller.signal
};
```

**验证**：直接用 `curl --noproxy "xiaomimimo.com"` 测试，若绕过代理成功而脚本失败，即为此问题。

### 9.3 深度分析慢或频繁失败

- 查看日志：`logs/icassp-batch-analyze-*.log`、`logs/deep-analyzer-*.log`
- 检查 key/endpoint/model 三元组是否匹配（见 9.1 节）
- 若超时，脚本会自动降级为纯文本重试；若仍失败，检查代理或减小并发
- 可用 `node scripts/deep-analysis-only.js` 安全续跑

### 9.4 发布后无变更可推送

在博客仓库检查：
```bash
cd ~/code/github_repos/audio-paper-digest-blog
git status --short
ls -lt content/posts | head -20
```

### 9.5 路径混淆

优先使用 `data/current/icassp_2026_deep_analyzers.json`，仅在兼容场景下读取旧路径。

### 9.6 重分析启动报 key 未设置

- 在 `~/.hermes/.env` 中配置 `PAPER_ANALYZER_API_KEY`
- 重新 source：`source ~/.zshrc`

### 9.7 微信公众号发布失败

- 检查 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` 环境变量是否已设置（在 `~/.hermes/.env`）
- 检查 `APP_SECRET` 是否过期
- 检查图片是否过大
- 微信图片上传有频率限制，大量图片可能需要分批执行


### 9.9 验证 API 路由变更

当修改 `detectApiType()` 或 `buildApiUrl()` 后，必须用以下测试脚本验证两个端点都正常：

```bash
# 纯文本测试
node -e "
const u = require('./scripts/utils.js');
const cases = [
  ['MiMo', 'https://token-plan-cn.xiaomimimo.com/v1', 'mimo-v2.5'],
  ['Kimi', 'https://api.kimi.com/coding/v1', 'kimi-for-coding'],
  ['OpenAI', 'https://api.openai.com/v1', 'gpt-4o']
];
for (const [name, ep, model] of cases) {
  const t = u.detectApiType(ep, model);
  const url = u.buildApiUrl(t, ep);
  console.log(name + ': ' + t + ' -> ' + url);
}
"
```

确保输出符合预期：
- MiMo → `anthropic` → `.../anthropic/v1/messages`
- Kimi → `anthropic` → `.../coding/v1/messages`（无 `/anthropic` 中间路径）
- OpenAI → `openai` → `.../v1/chat/completions`

**重要经验**：Kimi 和 MiMo 的 Anthropic URL 结构不同，修改 `buildApiUrl()` 时必须分支处理。

### 9.10 ICASSP 图片无法显示在博客上

**排查步骤**：
1. 检查 `data/current/icassp-images/{paperId}/` 是否存在图片文件
2. 若不存在，运行 `node scripts/migrate-icassp-images.js` 从分析日志提取
3. 检查博客 `static/icassp-images/{date}/{paperId}/` 是否已复制
4. 检查分析文本中是否残留 `icassp-img://` 标识符（应已被替换为实际路径）
5. 检查是否有外部 URL（如 `https://ieeexplore.ieee.org/...`）被硬编码，这些域名通常返回 403，应降级为纯文本

### 9.11 ICASSP 任务汇总页 404

**根因**：Hugo 不支持中文文件名。
**修复**：任务汇总页文件名使用 ASCII-safe（如 `icassp2026-task-001.md`），通过 frontmatter 设置 `url: /posts/icassp2026-task-中文任务名/`。

### 9.12 ICASSP 汇总页评分数量少于实际

**根因**：`score_and_sort()` 重新解析 `analysis` 文本时，部分论文解析失败导致评分丢失。
**修复**：确保 `publish_common.py` 优先使用 `p.get('parsed')` 中的预解析数据。

### 9.13 ICASSP API 安全过滤拒绝（含图片的论文）

**根因**：部分论文图片触发 LLM API 安全机制（如 PerformSinger 的某些图片）。
**修复**：使用 `retry-text-only.js` 进行纯文本分析（跳过图片），通常可绕过安全过滤。

### 9.14 后台运行 icassp-batch-analyze 被 SIGTERM 中断 (exit code 143)

**根因**：npm 脚本在后台模式下尝试访问 TTY 交互，导致 bash 报错并终止进程。

**修复**：后台运行时使用直接 Node 命令，绕过 npm：
```bash
# ❌ 后台模式避免使用
# ✅ 后台运行推荐方式
node scripts/icassp-batch-analyze.js
```

如果已在筛选或分析阶段中断：
1. 检查 `icassp_2026_deep_analyzers.json` 中已有分析结果的论文数量
2. 设置 `ICASSP_OFFSET` 从断点处续跑：`ICASSP_OFFSET=N node scripts/icassp-batch-analyze.js`