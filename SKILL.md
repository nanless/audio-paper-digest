---
name: audio-paper-digest
description: >
  语音/音乐/音频论文速递自动化技能。抓取 arXiv + HuggingFace Papers，使用环境变量配置的 LLM 做筛选与深度分析，
  输出结构化 JSON，并可发布到 GitHub Pages 博客、微信公众号草稿与小红书文案。
  适用场景：论文速递、论文摘要、每日追踪、重分析、博客发布、微信发布与小红书发布。
---

**[English](SKILL.en.md)** | 中文

# Paper Digest Skill（以当前代码为准）

## 1. 文档定位

- `SKILL.md`：给 Agent 的执行规则与安全约束
- `README.md`：给人的运行手册（命令、配置、排错）
- `prompts/filter.md`：筛选阶段 LLM prompt
- `prompts/deep-analysis.md`：深度分析阶段 LLM prompt（纯文本，输出格式、标签体系、评分标准）
- `prompts/image-supplement.md`：图像筛选与补充 prompt（双模型模式，最终文本修复后副模型看图选图并补充正文）
- `prompts/opensource-scan.md`：开源链接扫描 prompt（Round 2）
- `prompts/structure-repair.md`：审校结果缺少必要章节时的主模型局部结构修复 prompt
- `prompts/scoring-audit.md`：正文修复完成后的类型感知评分审计 prompt（主模型只输出 JSON 评分修订）

当文档与代码冲突时，**以 `scripts/*` 当前实现为准，并同步更新文档**。

---

## 2. 当前真实流程

主入口：`./run-full-fetch.sh`（或 `node scripts/full-fetch.js` / `npm run fetch`）

1. **自动归档**：检查 `data/current/deep-analysis-result.json` / `filtered-papers.json` / `analyzed.json`，若时间戳早于今天（北京时间）且 `data/archive/<日期>/` 下不存在，则复制后删除原文件。**`papers.json` 不归档。**
2. **加载去重库**：读取 `data/current/papers.json` 已有 ID；扫描 Hugo 博客仓库（`PAPER_DIGEST_BLOG_REPO`）中已发布论文的 arXiv ID，两者合并为统一去重集合
3. **arXiv 抓取**：7 个分类，每类最多 100 篇（可通过 `PD_ARXIV_MAX_RESULTS` 调整），遇连续 20 篇已有 ID 提前停止（去重集合包含 papers.json + 博客已发布 ID）
4. **HuggingFace 抓取**：`daily_papers` 分页（最多 20 页）+ `papers` API 补充，默认近 7 天，只排除历史去重集合/博客已发布 ID；同批 arXiv 重叠论文保留给合并阶段补齐 HF 元数据
5. **合并去重**：arXiv 优先，HF 补充 7 个特有字段，标记 `sources`；过滤掉博客已发布论文
6. **LLM 筛选**：按 `PAPER_ANALYZER_*` 配置逐篇判断语音/音乐/音频相关，`batchSize=5`（可通过 `PD_FILTER_BATCH_SIZE` 调整），单篇超时 60 秒，重试 5 次；每批写入 `data/current/filter-decisions.json`，中断后会按模型名和 `prompts/filter.md` hash 续跑；每条决策保存 `related`、`reason`、`rawResponse`、`parseSource`
7. **保存筛选结果**：`data/current/raw-candidates.json` 保存筛选输入，`data/current/filtered-papers.json` 保存筛选/归档去重后的输出
8. **更新去重库**：追加所有爬取论文 ID 到 `data/current/papers.json`（不仅筛选通过的，提前保存防止后续中断丢失）
9. **深度分析**：`deep-analyzer.js`。主模型完成纯文本分析、开源扫描、审校、表格/方法修复和最终类型感知评分审计；评分审计只输出 JSON，由代码更新文档类型、机器摘要分项、总分和评分理由，不改正文。双模型模式随后由副模型最终看图筛选高价值图片并只新增图片及图前/图后说明；单模型模式跳过图片。并发 3 篇（可通过 `PD_ANALYSIS_CONCURRENCY` 调整），每篇最多重试 2 次（可通过 `PD_ANALYSIS_MAX_RETRIES` 调整）
10. **增量保存**：每批分析后立即保存到 `data/current/deep-analysis-result.json`，自带失败结果保护（已有成功 analysis 的论文不会被无 analysis 的失败结果覆盖）；同时通过 `scripts/digest-status.js` 回写 `papers.json.digestStatus`。分析结果和论文库写入使用跨进程锁与 `generation` 校验，部分失败状态为 `partial_failed` 并返回非零退出码
11. **收尾合并**：去重合并历史结果，自动备份 bak 文件（保留最近 10 个）

`full-fetch.js` **不会自动发布博客/微信**，发布需单独运行 Python 脚本。

---

## 3. 数据路径规范

### 3.1 优先路径（当前）

| 文件 | 用途 | 归档行为 |
|------|------|---------|
| `data/current/papers.json` | 论文去重数据库（含 `digestStatus` 分析状态） | **不归档**，持续累积；`pending_analysis` / `analysis_failed` 不参与强去重，便于中断后重跑；所有分析入口通过 `scripts/digest-status.js` 同步状态；旧成功分析保留时用 `latestAttemptStatus` 记录最新失败尝试 |
| `data/current/raw-candidates.json` | 当日合并与博客去重后的筛选候选，含 `sourceHealth` | 每次全流程重写，用于排查筛选输入 |
| `data/current/filter-decisions.json` | 当日逐篇 LLM 筛选决策缓存，含 reason/rawResponse | 每批增量写入，模型或 prompt hash 变化后自动失效 |
| `data/current/filtered-papers.json` | 筛选后的论文元数据 | 每日归档移走后重新生成 |
| `data/current/deep-analysis-result.json` | 核心分析结果（含 analysis / parsed / selectedImageUrls / imageManifest / sourceHealth） | 每日归档移走后重新生成 |
| `data/current/analyzed.json` | 旧版已分析记录（兼容） | 每日归档移走后重新生成 |

### 3.2 兼容行为

部分脚本在读取时兼容 `data/*.json` 旧路径，但新产物应写入 `data/current/`。Python 发布入口通过 `path_config.resolve_deep_analysis_result_path()` 保持 current 优先、legacy 兜底。

### 3.3 归档目录

`data/archive/<YYYY-MM-DD>/` 按日期子目录存放当日归档文件。`deep-analysis-result-<时间戳>.bak.json` 备份文件也存放在此目录下，自动清理保留最近 10 个。

---

## 4. 模型与环境变量

### 4.1 统一存放位置

**所有项目配置统一放在 `项目根目录的 `.env` 文件`。**

这意味着：
- Node 脚本通过 `scripts/env-loader.js` / `loadEnvFile()` 读取项目根 `.env`
- Python 脚本通过 `scripts/project_env.py` 读取项目根 `.env`
- 脚本启动时会清理继承自 Trae/Codex/shell 的同名项目变量，再写入当前项目 `.env`；禁止外层环境变量与当前项目配置混用

### 4.2 筛选阶段（`fetch-papers.js`）

筛选统一调用 `PAPER_ANALYZER_*` 指定的 LLM：

- endpoint: `PAPER_ANALYZER_ENDPOINT`（必填）
- key: `PAPER_ANALYZER_API_KEY`（必填）
- model: `PAPER_ANALYZER_MODEL`（必填）
- **API 协议自动路由**：`scripts/utils.js` 中的 `detectApiType()` 会根据端点和模型名自动判断使用 OpenAI 还是 Anthropic 协议；完整优先级见第 4.2 节，DeepSeek 强制 OpenAI，`token-plan+mimo` / `coding+kimi` / 非 DeepSeek 的 `/anthropic` 走 Anthropic
  - **MiMo/Kimi Token Plan / Coding Plan**（端点含 `token-plan` 或 `coding`，模型含 `mimo`/`kimi`）→ 自动切换为 **Anthropic 协议**，伪装成 Claude Code 调用
    - **MiMo**: `https://token-plan-cn.xiaomimimo.com/v1` → `https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages`（替换 `/v1` 为 `/anthropic`）
    - **Kimi**: `https://api.kimi.com/coding/v1` → `https://api.kimi.com/coding/v1/messages`（直接加 `/messages`，无需 `/anthropic` 中间路径）
    - Headers: `x-api-key` + `anthropic-version: 2023-06-01` + `User-Agent: claude-cli/<version> (external, cli)`（版本号动态获取自本地 `claude --version`，失败回退到 `2.1.108`）
    - system message 自动提取为请求体顶级字段（Anthropic 要求）
  - **其他非 DeepSeek 的 `/anthropic` 端点** → 使用 Anthropic 协议并拼接 `/messages`
  - **其他情况**（包括 DeepSeek、MiMo 按量付费、通用 OpenAI 兼容端点）→ 使用标准 **OpenAI 协议**
    - URL: `/v1/chat/completions`
    - Headers: `Authorization: Bearer {key}`
- **agent: `false`** — LLM API 请求明确禁用连接复用，避免全局 agent 连接池被代理污染导致 MiMo 403（详见 9.2）
- 超时 60 秒，重试 5 次
- 指数退避：筛选 LLM 调用 `2^attempt * 1s`（2s/4s/8s/16s/32s）；arXiv 页面抓取 429 限流时 `60s * 2^(attempt-1)`，其他错误线性 `5s * attempt`
- prompt 来源：`prompts/filter.md`，运行时通过 `loadPrompt()` 读取并替换 `{title}`、`{abstract}`、`{categories}` 占位符
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
- 整体超时 20 分钟，按进程活跃时间记账；系统睡眠/长时间挂起从预算中排除，唤醒后的底层超时继续使用剩余预算重试
- max_tokens=64000，temperature=0.7
- **双层重试**：analysis-engine.js 层面每篇最多重试 2 次（总共最多 3 次尝试）；deep-analyzer.js 内部每次 API 调用再重试最多 3 次（指数退避：第一次 10 秒，之后翻倍，`2^attempt * 5s`）
- **抓取代理为强制项**：LLM API 固定 `agent: false` 直连，不得注入代理 agent/dispatcher；arXiv/HuggingFace 抓取缺少项目 `.env` 代理必须失败，禁止直接回退。Node arXiv 仅使用 `HTTPS_PROXY` / `HTTP_PROXY` 的 HTTP CONNECT 地址，HuggingFace curl 可额外使用 SOCKS `ALL_PROXY`；访问本机代理的网络命令必须在沙箱外运行。
- **LLM API 请求明确设置 `agent: false`，强制直连以绕过本地代理（避免 MiMo 403）；arXiv/HuggingFace 等外部抓取仍使用代理自动检测**
- arXiv HTML 解析使用 **cheerio** 结构化选择器，移除 script/style/nav/header/footer 等噪音元素
- 图片先按 caption/文件名/顺序启发式预筛（默认 `imageCandidateMax=20`）；HTML 正文与图注在同一次响应中解析并复用，预提供 URL 会按完整 URL或唯一文件名补全 caption。只有配置副模型的双模型模式才**串行下载**最多 `imageMaxCount=20` 张候选图片并送入副模型；成功内容写入 `data/current/image-cache/`，恢复时校验 MIME/文件头后复用。仅 408/425/429/5xx 和网络异常重试，404、非法 MIME、超限与安全拒绝立即终止
- 每篇分析结果写入 `imageManifest`，记录图片发现数、候选评分、逐 URL 下载结果、缓存命中、插图计划哈希、拒绝原因和最终选图，便于复盘图像筛选
- 每个分析阶段写入 `analysisManifest`；失败尝试保留 `analysisCheckpoint` 和独立的 `analysisRecoveryImageManifest`。失败合并会独立按完整契约重解析旧正文，不受最新失败 manifest 影响，连续多次失败也不能覆盖旧成功正文。arXiv HTML/图片发现默认单次 60 秒，PDF fallback 默认 180 秒；Demo 页面最多跟随 3 次重定向并逐跳重验公网 DNS/IP。只有严格的 `{"insertions":[]}` 才是有效空插图计划，缺字段、错误类型或非法 JSON 都保持为可重试失败
- 全文上限约 500K 字符（config.js 中 `fullTextMaxChars`）
- 所有分析配置集中管理于 `scripts/config.js`，支持在项目根 `.env` 中覆写

输出约束：
- prompt 来源：`prompts/deep-analysis.md`，运行时通过 `loadPrompt()` 读取并替换 `{hasFullText}`、`{title}`、`{authors}`、`{categories}`、`{arxivId}`、`{textForAnalysis}` 占位符
- arXiv 获取结果保存结构化来源：`analysisSource`、`sourceId`、原始/实际输入/全文字符数、`truncated`、`sourceSha256`、HTML 可用性和告警。稳定 400/403/404 不重复请求；版本化 ID 只读取指定版本；PDF 有 50MB 默认上限并校验 MIME、文件头与提取长度。全文不可用时优先使用完整摘要，不允许短错误页覆盖摘要
- checkpoint 的来源 SHA-256 变化时清除主分析及全部下游状态，避免旧全文正文被新一轮摘要审校。评分审计另保存模型、低温、prompt 模板哈希、证据哈希、尝试次数和最终 JSON；这些指纹变化只失效评分与插图阶段
- 固定一级标题：`## 评分`、`## 机器摘要`、`## 标签`、`## 作者与机构`、`## 毒舌点评`、`## 核心摘要`、`## 方法概述和架构`、`## 核心创新点`、`## 实验结果`、`## 细节详述`、`## 评分理由`、`## 局限与问题`、`## 开源详情`
- `## 评分` 下先输出总分（X.X/10）
- **代码后处理**：`parseAnalysis`/`parse_analysis` 仅在 `## 评分理由` 的八个分项完整、唯一、分母正确、数值有限且位于各自范围时重新计算总分；合计上限为 10，四舍五入到 0.1，覆盖 LLM 原始总分。缺失、重复、错误分母、负数、越界或非有限值会产生契约错误并阻断保存/发布，不存在最低 1 分保底
- `## 机器摘要` 包含 `document_type`、`rank_bucket`（带顶会映射）、`innovation`（创新性 0-2）、`technical_rigor`（技术严谨性 0-1.5）、`experimental_sufficiency`（实验充分性 0-1.5）、`clarity`（清晰度 0-1）、`impact`（影响力 0-1.5）、`open_source`（开源 0-1.5）、`reproducibility`（可复现性 0-0.5）、`engineering_score`（工程/实践价值 0-1.5）、`confidence`、`primary_task_tag`、`primary_method_tag` 等固定键
- 评分采用八维审稿人体系：创新性（0-2）+ 技术严谨性（0-1.5）+ 实验充分性（0-1.5）+ 清晰度（0-1）+ 影响力（0-1.5）+ 开源（0-1.5）+ 可复现性（0-0.5）+ 工程/实践价值（0-1.5），满分 11 分，总分上限 10
- 当前评分版本为 `type-aware-v1`：`document_type` 只能取方法研究、系统技术报告、模型报告、数据集与基准、综述、理论研究、应用研究。类型只决定适用证据，不改变八维权重，也不提供固定加分、保底或豁免
- 使用声明—证据匹配和“单一问题单一主维度扣分”：开源产物缺失、复现细节缺失、实验/证明证据不足、表达问题、技术逻辑错误分别归入对应维度；无法验证时降低 `confidence`
- 系统/模型报告按端到端质量、延迟、吞吐、成本、规模、压力测试、竞品公平性与失败案例评估；数据集/基准、综述、理论和应用研究按各自证据标准评估，不机械要求传统方法消融
- 正文修复后先按共享结构契约检查 13 个必要章节；缺失时使用 `prompts/structure-repair.md` 只修复当前论文结构，避免外层整篇重跑
- 主模型使用 `prompts/scoring-audit.md` 做最终 JSON 评分审计；校验失败会把精确错误反馈给下一次局部审计。无核心产物时，代码按“肯定语境承诺开放 0.5 / 明确 URL 或肯定结构化 Demo 0.2 / 否定或未提及 0”确定性归一化开源分和理由；理论研究按公开证明、推导和附录判断核心产物，不因代码/模型/数据标记为空而强制归零。代码只替换评分相关字段，副模型不参与评分
- 插图合并后再次执行完整分析契约；若插图计划破坏章节或解析结果，只丢弃该篇插图计划并保留已审计的主模型正文
- 候选编号不能直接作为展示图号；代码将无真实 caption 的通用 alt 和 `selectedImageUrls` 按最终正文顺序归一化。发布 review 必须保留 Markdown 表格中前导分组列为空的合法续行
- 副模型最多按价值顺序选择 4 张图（`PD_IMAGE_INSERTION_MAX` 可覆写），每张必须从代码生成的段落目录中选择稳定 `paragraph_id`；非法 ID、定位失败和超限图片由代码拒绝，不回退到章节末尾。旧自由文本 `anchor` 仅兼容历史响应。`[secondary]` 日志记录模型/协议/endpoint 与 key 来源、候选和下载数量、caption、缓存、段落 ID、JSON 解析状态、拒绝原因和最终选图；禁止打印 API key 内容
- 标签输出必须同时包含最终标签串、`主任务标签`、`主方法标签`、`补充标签`
- 缺失信息必须写"未说明/未提供/未提及"，禁止猜测作者机构、实验数字、开源状态或外部信息
- 修改 `prompts/deep-analysis.md` 或 `prompts/filter.md` 时，需同步检查 `scripts/utils.js` 与 `scripts/utils.py` 的解析逻辑是否仍能匹配新输出格式

### 4.3.1 双模型模式

配置 `PAPER_ANALYZER_SECONDARY_MODEL` 时启用双模型模式：

- **主模型**（`PAPER_ANALYZER_*`）：纯文本深度分析，使用 `prompts/deep-analysis.md`（Round 1a）
- **副模型**（`PAPER_ANALYZER_SECONDARY_*`）：多模态图像筛选与插图计划，使用 `prompts/image-supplement.md`（最终文本修复后执行），需要支持图片输入的多模态模型（如 `mimo-v2.5`、`gpt-4o` 等）
- 副模型的 `endpoint` / `key` 不设置时分别回退到主模型的对应值
- 未配置副模型时，自动退回单模型纯文本模式（不分析图片）
- 副模型任务：从候选图中筛选高价值图（流程图、模型图、语谱图、对比图、结果图等），丢弃无关/低信息图，按价值顺序输出最多 4 张的 JSON 插图计划（目标章节、稳定 `paragraph_id`、图前 `lead`、图后 `explanation`）。代码拒绝非法段落 ID 和超限计划，并忽略旧 `replacement` / `rewrite` 字段；副模型不得替换主模型任何原句，也不得输出完整分析报告或参与评分。

### 4.4 微信公众号（`publish-wechat-full.py`）

- `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET` 从 `os.environ` 读取
- `WECHAT_THUMB_MEDIA_ID`（可选）：封面图永久素材 ID，未设置时使用内置默认素材
- 图片上传：下载 arXiv 图片 → 上传到微信 CDN → 替换为微信 URL。缓存保存在系统临时目录下的 `wechat-image-cache.json`
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

# 方案 5: 双模型模式（主模型纯文本 + 副模型多模态图像筛选与插图计划）
# 主模型配置同上（选方案 1-4 之一）
# 副模型（可选，不设置则退回单模型纯文本模式）
# PAPER_ANALYZER_SECONDARY_MODEL=mimo-v2.5
# PAPER_ANALYZER_SECONDARY_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1
# PAPER_ANALYZER_SECONDARY_API_KEY=tp-your-token-plan-key
# 注：副模型 endpoint/key 不设置时默认复用主模型的对应值

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
# PAPER_DIGEST_BLOG_URL=https://nanless.github.io/audio-paper-digest-blog/posts
# PAPER_DIGEST_GITHUB_REMOTE=origin

# 微信公众号作者（可选）
# PAPER_DIGEST_AUTHOR=your-name

# 配置覆写（可选）
# PD_ANALYSIS_CONCURRENCY=3       # 深度分析并发度
# PD_ANALYSIS_MAX_RETRIES=2       # 深度分析重试次数
# PD_REANALYZE_CONCURRENCY=3      # 重分析并发度（默认与 ANALYSIS_CONFIG.concurrency 一致）
# PD_FILTER_BATCH_SIZE=5          # LLM 筛选每批篇数
# PD_ARXIV_MAX_RESULTS=100        # arXiv 每类抓取数量
# PD_ARXIV_PDF_MAX_BYTES=52428800 # PDF fallback 最大字节数
# PD_SCORING_AUDIT_TEMPERATURE=0.1
# PD_IMAGE_PLAN_TEMPERATURE=0.2

# 抓取代理（必需）：arXiv 的 Node 请求必须使用 HTTP CONNECT 地址
# HTTPS_PROXY=http://127.0.0.1:7897
# HTTP_PROXY=http://127.0.0.1:7897
# HuggingFace 的 curl 可额外使用 SOCKS；LLM 请求固定 agent:false 直连
# ALL_PROXY=socks5h://127.0.0.1:7897
```

**API 协议自动路由概览**：

| 端点特征 | 模型特征 | 自动路由 | URL 转换 |
|----------|----------|----------|----------|
| 含 `deepseek.com` 或模型含 `deepseek` | — | OpenAI | `/anthropic` → `/v1/chat/completions`（优先级最高） |
| 含 `token-plan` | 含 `mimo` | Anthropic | `/v1` → `/anthropic/v1/messages` |
| 含 `coding` | 含 `kimi` | Anthropic | `/coding/v1` → `/coding/v1/messages` |
| 含 `/anthropic` | — | Anthropic | `{base}/messages` |
| 其他 | 其他 | OpenAI | `/v1/chat/completions` |

端点配置格式统一为 `协议://域名/v1`，不管后续用哪种协议，配置方式一致。

---

## 5. 常用命令（当前可用）

```bash
cd /path/to/audio-paper-digest

# 全流程（抓取 + 筛选 + 深度分析）
npm run fetch
# 或 ./run-full-fetch.sh

# 仅深度分析续跑（跳过已有 analysis；若尚无分析结果，会从 filtered-papers.json 初始化）
npm run deep

# 全量重分析（默认读取 data/current/deep-analysis-result.json）
npm run reanalyze

# 指定并发度重分析
node scripts/reanalyze.js --concurrency 3 data/current/deep-analysis-result.json

# 按日期重新筛选 + 重新分析
node scripts/refilter-reanalyze-by-date.js 2026-07-01

# 运行单元测试
npm test

# 快速抓取测试（仅抓+筛选，不分析，输出 data/quick-test-result.json）
node scripts/quick-test.js

# 批量分析未分析论文（基于 deep-analysis-result.json）
npm run batch

# 单独分析一篇论文（命令行参数）
node scripts/analyze-single-paper.js 2604.16044 --force

# 补录历史 paper ID（不做深度分析）
npm run backfill

# 博客必须分三阶段执行
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD

# 使用自定义数据文件发布
npm run blog:generate -- --date YYYY-MM-DD data/current/deep-analysis-result.json

# 生成微信公众号草稿（默认读 data/current/deep-analysis-result.json）
npm run wechat

# 生成小红书文案（默认 TOP 5 精选版）
npm run xiaohongshu
npm run xiaohongshu -- --top 7     # 指定 TOP N
npm run xiaohongshu -- --all       # 完整汇总版
npm run xiaohongshu -- --date 2026-04-22
```

**小红书发布经验：**

- 小红书单帖正文限制约 1000 字，精选模式默认 TOP 5（可用 `--top 3` 调整），正文约 800-950 字符，适合单帖直接发布
- **每篇论文的一句话介绍调用发布阶段 LLM API 生成**（复用 `publish_common.py` 的协议路由并绕过代理），LLM 失败时回退到本地 `extract_one_liner()`（优先取 innovation 第一条，其次 summary 中含"提出了/解决了/旨在"的句子，最后 roast）
- LLM one-liner 优先使用深度分析的 `parsed.summary`、`parsed.results`、`parsed.limitations`、`parsed.opensource` 与主标签，再回退摘要，避免只复述标题
- 脚本会自动清理 Markdown 格式（`**加粗**`、`` 代码 ``）和学术化前缀（"这篇论文旨在"、"本文针对"等），避免平台渲染异常
- 文案自动附带 emoji 热度标识：🔥≥8 分、✅≥6 分、📝<6 分（与博客、微信统一）
- 末尾固定附博客链接和开源仓库链接，不输出标签和 `---` 分隔线
- `--all` 模式输出完整汇总文案，适合手动拆分或自选精华发布

---

## 6. 发布行为与日期安全

博客入口：`scripts/generate-blog.py` → `scripts/review-blog.py` → `scripts/push-blog.py`；`scripts/publish-to-blog.py` 只作生成兼容入口和共用实现。

### 核心原则：博客日期 = 爬取分析日期，≠ arXiv 上传日期

- `published` 字段是论文在 arXiv 上的原始发布日期，可能早于今天
- **博客的 `YYYY-MM-DD` 日期代表「今天爬取并分析」的批次**，不是论文原始发布日期
- `deep-analysis-result.json` 可能包含当日新增分析和合并保留的既有结果；博客、微信、飞书默认按 `fetchedAt == --date` 过滤，只有匹配批次日期的论文会发布到当天内容下

当前行为：

- 默认读 `data/current/deep-analysis-result.json`
- **按 `fetchedAt` 日期过滤**：只发布 `fetchedAt` 匹配 `--date` 指定日期的论文（默认今天），避免历史数据被重复发布
- 微信公众号和飞书同样默认按 `fetchedAt` 日期过滤；如需发布输入文件全部论文，显式传 `--all`
- 在 `~/code/github_repos/audio-paper-digest-blog/content/posts` 生成：
  - 汇总页：`YYYY-MM-DD.md`
  - 单篇页：`YYYY-MM-DD-<slug>.md`
- `generate-blog.py` 只生成并安装 `.md`，写入 generation manifest，禁止 review/commit/push
- `review-blog.py` 只审查 generation manifest 中的文件，通过严格 LLM/图片 review 与 Hugo gate 后写入逐文件 SHA-256 凭证，禁止 commit/push
- `push-blog.py` 只验证审查凭证和当前文件哈希，精确 stage 后使用中文详细提交信息 commit，再 `git push origin HEAD:main` 并验证远端 OID；禁止重新生成或 review
- 若需发布全部论文（不过滤），显式传 `--all`

Agent 执行约束：

- 默认只允许运行生成和 review 两个独立阶段
- 只有用户明确要求"正式发布 / 推送博客"时，才允许运行 `push-blog.py`
- 若只是检查格式、验证新字段或预览产物，禁止触发真实 `git push`

发布前保障：

- `full-fetch.js` 每天运行时会自动归档移走昨天的 `deep-analysis-result.json`、`filtered-papers.json` 和 `analyzed.json`，确保 `data/current/` 下只有当天新抓取的论文
- 发布默认按 `fetchedAt == --date` 过滤；仍需保持 `data/current/` 干净，避免 review、校验和显式 `--all` 发布时混入不同批次

### 重跑/修复当天的正确姿势

若当天结果需要清空重跑：

1. 若 `data/current/filtered-papers.json` 是今天且 `status: complete`，并且其中 `filterModel` / `filterPromptHash` 与当前 `.env` 和 `prompts/filter.md` 一致：不要删筛选结果，直接运行 `node scripts/full-fetch.js`，主流程会跳过抓取/筛选并续跑深度分析；若模型或 prompt 已变更，会重新抓取/筛选。
2. 若筛选未完成但 `data/current/filter-decisions.json` 是今天且模型/prompt hash 一致：直接运行 `node scripts/full-fetch.js`，筛选会复用已有逐篇决策继续。
3. 若要彻底重抓重筛，再删除 `data/current/raw-candidates.json`、`data/current/filter-decisions.json`、`data/current/filtered-papers.json`、`data/current/deep-analysis-result.json`
4. **必要时恢复 `papers.json` 到昨天状态**（推荐，比个删 ID 更可靠）：
   ```bash
   # 用昨天备份替换去重库（backupPapersJson 生成，格式为 papers-YYYY-MM-DD.json）
   cp data/archive/papers-2026-04-21.json data/current/papers.json
   ```
5. 删除博客仓库中当天的所有 `content/posts/YYYY-MM-DD-*.md` 文件
6. 重新运行 `node scripts/full-fetch.js`

**特殊场景——抓取或筛选 API 全面失败：**
- arXiv/HuggingFace 抓取器会区分“请求成功但结果为空”和“所有请求失败”；全失败会抛出带 `sourceHealth` 的异常，禁止生成完整空批次。
- 筛选 API 错误或无法判断的结果标记为 `retryable`，不会写入正式决定缓存，也不能把筛选产物标记为 `complete`；修复 API 后直接重跑主流程复用已有明确决定。

**关键教训——恢复 `papers.json` 前必须检查 `lastUpdated`：**

第一次运行中断后，不要盲目恢复任何备份！必须先确认 `papers.json` 的状态：

```bash
# 检查 papers.json 最后更新时间
ls -la data/current/papers.json
# 或读取 lastUpdated 字段
cat data/current/papers.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('lastUpdated'))"
```

判断规则：
| `papers.json` 的 `lastUpdated` | 正确操作 |
|-------------------------------|---------|
| **今天**（如 `2026-04-23T03:09:03`）| **不要恢复！** 它已经是最新状态；优先用今日 `filtered-papers.json` / `filter-decisions.json` 续跑 |
| **昨天或更早** | 可以恢复备份：`cp data/archive/papers-YYYY-MM-DD.json data/current/papers.json` |

推荐检查命令（可选）：

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

---

## 7. 日志与运行特性

- Node/Python 可执行脚本默认同时输出到终端和唯一的 `logs/<script>-YYYYMMDD-HHMMSS-<pid>-<seq>.log`；`backup-data.sh` 同样默认生成文件日志
- `PD_ENABLE_FILE_LOGS=1` / `PAPER_DIGEST_ENABLE_FILE_LOGS=1` 继续兼容，但不再是生成日志的必要条件
- 文件日志不做数量、总量或单文件大小限制，也不会自动清理旧日志；`PAPER_DIGEST_DISABLE_FILE_LOGS=1` 或 `PD_DISABLE_FILE_LOGS=1` 可强制禁用文件日志
- `backfill_papers.py` 复用统一的每次运行日志，不再额外追加 `logs/backfill.log`
- 日志均为 UTF-8 纯文本并使用 `0600` 权限；日志层统一脱敏 `Authorization`、`x-api-key`、Cookie、token、secret、password、任意已配置密钥实际值和 URL userinfo，并同步落盘，避免 `process.exit()` 丢失尾部日志
- `full-fetch.js` / `deep-analysis-only.js` / `batch-analyze.js` 采用重试、增量保存、跨进程锁和 `generation` 校验；损坏的 current JSON 会阻断写入，不会回退 legacy 后覆盖
- `full-fetch.js` 另有覆盖归档、清理、筛选和最终合并的单实例运行锁，内部论文分析仍保持配置的并发度；锁 owner 使用随机 token，旧 owner 不能释放后来者的同路径新锁
- `reanalyze.js` 每 5 篇保存一次中间结果（并发模式下自动调整保存间隔）
- 可运行 `npm run validate:data` 只读校验当前 `papers.json`、`raw-candidates.json`、`filter-decisions.json`、`filtered-papers.json`、`deep-analysis-result.json` 的结构、候选统计、筛选计数一致性，以及完整筛选决策对候选全集的覆盖；该命令不修复数据，发现问题会非零退出
- `full-fetch.js` 自动备份 bak 文件到 `data/archive/`，保留最近 10 个
- `full-fetch.js` 自动备份 `papers.json` 到 `data/archive/papers-<日期>.json`，保留最近 7 天

---

## 8. Agent 执行规则（强约束）

1. **先查再改**：先读取相关脚本确认当前行为，再更新文档或执行命令。
2. **发布需确认日期**：未明确日期时，先问用户；默认不要依赖"今天"。
3. **禁止危险操作**：未获明确授权，禁止 `git reset --hard`、`git push -f`、批量删除历史文章。
4. **不自动扩展流程**：运行 `full-fetch.js` 后，不要擅自追加博客/微信发布，除非用户明确要求。
5. **改动留痕**：流程、参数、路径变化后，同步更新 `SKILL.md`、`README.md`、`AGENTS.md` 和相关 `docs/` 文档。
6. **禁止硬编码密钥**：不要在任何脚本或文档中写入真实 API key；所有凭证（LLM、微信公众号、飞书）统一放在 `项目根目录的 `.env` 文件`，由脚本通过项目 env loader 加载。
7. **修改脚本时防止安全机制破坏**：本环境会静默替换 `API_KEY` 等敏感字符为 `***`。修改含有这类字符的脚本时，修改后必须重新读取文件验证关键行未被破坏。同时定期检查 `data/`、`logs/` 目录是否残留含密钥的备份文件或日志快照，发现立即清理。
8. **环境变量统一管理**：新增脚本需要读取 LLM 配置时，统一使用项目 `.env` 中的 `PAPER_ANALYZER_API_KEY`、`PAPER_ANALYZER_MODEL`、`PAPER_ANALYZER_ENDPOINT`，并复用 Node `scripts/env-loader.js` 或 Python `scripts/project_env.py`；禁止引入别名回退链、硬编码、base64 编码变量名 hack，或读取外层 shell/Codex/Trae 继承变量作为项目配置。
9. **新增可配置参数和运行数据路径放入统一配置**：新增 Node 脚本涉及可调整参数（并发度、超时、批次大小等）或 `data/current/*.json` 运行数据文件时，统一放入/复用 `scripts/config.js`（运行数据路径使用 `Config.FILES`），参数项按需添加项目 `.env` 覆写支持；新增 Python 发布/维护脚本涉及共享路径时，复用 `scripts/path_config.py`，禁止再次手写 `data/current/*.json` 默认路径。
10. **新增分析脚本复用 analysis-engine.js**：新增论文分析相关脚本时，优先复用 `analysis-engine.js` 的 `analyzeBatch()` / `analyzePaperWithRetry()`，避免重复实现重试、解析、保存逻辑；保存结果后必须通过 `scripts/digest-status.js` 同步 `papers.json.digestStatus`。
11. **博客三阶段不得合并**：`generate-blog.py` 只生成并写 generation manifest；`review-blog.py` 只执行严格 LLM/图片 review 和 Hugo gate，通过后写入逐文件 SHA-256 凭证；`push-blog.py` 只验证凭证后 commit/push，禁止调用生成或 review。未获用户明确授权时禁止运行 push 阶段。
12. **输出契约改动要同步 parser**：若修改 `prompts/deep-analysis.md` 中的 `## 机器摘要` 键名、章节顺序或标签输出格式，必须同步检查 `scripts/utils.js` 与 `scripts/utils.py` 的解析逻辑。
13. **变更后必须做产物级验证**：至少抽样检查一份 `data/current/deep-analysis-result.json`，确认 `analysis` 文本的机器摘要包含 `document_type`、`rank_bucket`、`primary_task_tag`、`primary_method_tag`，且 `parsed` 缓存包含 `documentType`、`scoringRubricVersion`、`rankBucket`、`primaryTaskTag`、`primaryMethodTag` 等字段，再运行博客/社媒脚本验证最终产物。
14. **变更后验证 prompt 加载**：修改 `prompts/` 目录下的 markdown 文件后，运行一次快速测试（`node scripts/quick-test.js` 或单篇分析）确认 `loadPrompt()` 能正确读取并替换占位符，无 `{变量名}` 残留。
15. **变更后运行单元测试**：修改 `scripts/utils.js`、`scripts/config.js` 或分析引擎核心逻辑后，必须运行 `npm test` 确保测试通过。
16. **MiMo API 请求必须禁用代理连接复用**：所有 Node LLM 调用（包括 `test-api-key.js`）的 `options.agent` 必须为 `false`（不是 `undefined`）。任何重构或修改 HTTP 请求逻辑时，禁止将 `agent: false` 改回 `agent: proxyAgent` 或 `agent: undefined`，否则 MiMo Token Plan 会在有系统代理的环境中返回 403。
17. **新增 LLM 端点必须接入 API 协议自动路由**：任何新增 Node 脚本调用 LLM 时，统一使用 `scripts/utils.js` 中的 `detectApiType()`、`buildApiUrl()`、`buildHeaders()`、`buildRequestBody()`、`parseResponseText()`；Python 发布阶段 LLM 调用必须复用 `publish_common.py` 的 `call_publish_llm_api()`，禁止硬编码特定协议的 URL/Header/Body。
18. **修改 API 协议路由逻辑时同步全链路**：修改 `detectApiType()` 的判定规则或 `buildApiUrl()`/`buildHeaders()` 等函数时，必须同步检查 `fetch-papers.js`、`deep-analyzer.js` 以及所有使用 `analysis-engine.js` 的脚本（`full-fetch.js`、`reanalyze.js`、`batch-analyze.js`、`deep-analysis-only.js`、`analyze-single-paper.js`），确保全链路行为一致。
19. **禁止将敏感文件提交到版本控制**：`data/`、`logs/`、`*.env`、`*.backup*`、缓存文件、含密钥的日志归档等严禁进入 git；提交前必须确认 `.gitignore` 已正确配置，且仓库中不存在历史遗留的敏感文件。
20. **CI 自动检查**：CI 会通过 `npm test`、`npm run validate:data`、`find scripts tests -name '*.js'`、`find scripts -name '*.py'`、`python3 -m unittest discover -s tests/python` 和全仓库 `.sh` 语法检查覆盖新增 JS/Python/shell 文件；新增特殊文件类型时再更新 `.github/workflows/ci.yml`。
21. **运行数据使用北京时间**：写入 `timestamp` / `lastUpdated` / `fetchedAt` 时使用 `getBeijingISOString()`；Python 发布侧使用北京时间 helper（如 `get_today_bj()`），避免 UTC 日期造成跨天归档或发布筛选错误。
22. **提交信息必须中文且详细**：提交信息必须用中文说明主要改动和影响范围；禁止只写“修复”“更新”这类无法追踪原因的短句。

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
   - 确保当前项目根 `.env` 中的 key/endpoint/model 三元组来自同一供应商，不依赖 `.zshrc` 或外层 shell 变量

2. **检查是否走对了协议**（终端输出或 `logs/*.log` 中查找 `[filter] API 类型: xxx` 或 `[api] → model | xxx` 行）
   - 若使用 MiMo/Kimi Token Plan 却显示 `openai`，检查端点是否含 `token-plan` 或 `coding`，模型是否含 `mimo` 或 `kimi`
   - 若输出显示 `anthropic` 但仍失败，检查 URL 是否正确：MiMo 是 `/anthropic/v1/messages`，Kimi 是 `/coding/v1/messages`，都不是 `/v1/chat/completions`

3. **Anthropic 协议专项检查**（输出显示 `anthropic` 时）
   - 请求头是否为 `x-api-key`（非 `Authorization: Bearer`）
   - 是否带 `anthropic-version: 2023-06-01`
   - 是否带 `User-Agent: claude-cli/<version> (external, cli)`（日志不会直接显示，可用代理工具验证）

4. **OpenAI 协议专项检查**（输出显示 `openai` 时）
   - 确认使用 `Authorization: Bearer {key}`
   - 确认 URL 路径是 `/v1/chat/completions`

5. **检查代理**（见 9.2 节）
   - MiMo Token Plan 在有系统代理时可能被屏蔽
   - 尝试用 `curl --noproxy "xiaomimimo.com"` 绕过代理测试

6. **查看输出**：优先查看 `logs/full-fetch-*.log`、`logs/deep-analyzer-*.log`，同时保留终端完整输出

### 9.2 MiMo API 返回 403 Illegal access / timeout / socket hang up

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

### 9.3 深度分析慢或频繁失败

- 查看 `logs/deep-analyzer-*.log`、`logs/full-fetch-*.log`，同时保留终端完整输出
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

优先使用 `data/current/deep-analysis-result.json`，仅在兼容场景下读取旧路径。

### 9.6 重分析启动报 key 未设置

- 在 `项目根目录的 `.env` 文件` 中配置 `PAPER_ANALYZER_API_KEY`、`PAPER_ANALYZER_MODEL`、`PAPER_ANALYZER_ENDPOINT`
- 重新运行脚本即可；不要依赖 `.zshrc` / Trae / Codex 外层环境变量补齐项目配置

### 9.7 微信公众号发布失败

- 检查 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` 是否已写入 `项目根目录的 `.env` 文件`
- 检查 `APP_SECRET` 是否过期
- 检查图片是否过大或被 arXiv 限制
- 微信图片上传有频率限制，大量图片可能需要分批执行

### 9.8 HuggingFace 抓取为空

- 检查网络连接（`curl https://huggingface.co/api/daily_papers?limit=10`）
- 检查是否被限流或需要代理
- `fetch-huggingface-papers.js` 使用 `curl` 命令，确保系统 `curl` 可用

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

### 9.10 后台运行 full-fetch 被 SIGTERM 中断 (exit code 143)

**根因**：npm 脚本在后台模式下尝试访问 TTY 交互，导致 bash 报错并终止进程。

**修复**：后台运行时使用直接 Node 命令，绕过 npm：
```bash
# ❌ 后台模式避免使用
npm run fetch

# ✅ 后台运行推荐方式
node scripts/full-fetch.js
```

如果已在筛选阶段中断，需要按第 6 节"重跑/修复当天的正确姿势"处理：
1. 检查 `papers.json` 的 `lastUpdated` 是否为今天（见 6 节判断矩阵）
2. 如果是今天，不要恢复 papers.json；优先用今日 `status: complete` 且筛选模型/hash 匹配的 `filtered-papers.json` 续跑，只有需要强制重筛时才删除 `filtered-papers.json` 后重跑
3. 如果是昨天或更早，恢复 `papers.json` 备份后重跑

---

## 10. 相关入口

当前仓库没有独立 `references/` 子技能目录，也没有 `scripts/fetch_papers.py` / `main.py` 等旧入口。维护和执行时以本文第 3 节列出的 Node/Python 脚本为准；新增会议或专题流程应在对应分支和文档中显式登记。
