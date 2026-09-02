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
- `prompts/api-reader-article.md`：评分闭环后的初学研究者连续长文 prompt（动态问题标题与去模板门禁）

当文档与代码冲突时，**以 `scripts/*` 当前实现为准，并同步更新文档**。

---

## 2. 当前真实流程

默认日更入口：`./run-daily-digest.sh YYYY-MM-DD` 或 `npm run digest:prepare -- YYYY-MM-DD`，默认走 LLM/API 自动抓取、筛选、深度分析和普通博客 review；`digest:api` 是显式同义入口。只有用户明确要求 Manual/人工路线时才运行 `npm run digest:manual -- YYYY-MM-DD` 或 `./run-daily-digest.sh YYYY-MM-DD --manual`，并在 raw 筛选、task runner、逐论文 records v4 和逐页 review 边界停下供 Agent 创建独立 subagent。从 fetch 开始时目标日期必须是北京时间当天；历史批次可从对应安全阶段续跑已有数据。

1. **自动归档**：逐文件检查 `data/current/raw-candidates.json` / `filter-decisions.json` / `filtered-papers.json` / `deep-analysis-result.json` / `analyzed.json`；若记录日期早于今天（北京时间），则写入同日归档并在校验成功后移走 current 原文件。canonical 归档冲突时保留带时间戳的冲突副本，不能静默覆盖或丢弃任一版本。**`papers.json` 不归档。**
2. **加载去重库**：读取 `data/current/papers.json` 已有 ID；扫描 Hugo 博客仓库（`PAPER_DIGEST_BLOG_REPO`）中已发布论文的 arXiv ID，两者合并为统一去重集合
3. **arXiv 抓取**：7 个分类，目标返回数默认每类 100 篇（可通过 `PD_ARXIV_MAX_RESULTS` 调整）。recent HTML 固定最多读取两页、最多提供 100 篇；不足目标时继续由严格分类 search 页面和 Atom API 补足，因此把配置调高不会扩大 recent 的两页窗口。每个分类完成后原子写入 `fetch-checkpoint.json`；中断后只补抓未完成分类，任一必需分页或摘要请求失败均不能标记该分类健康
4. **HuggingFace 抓取**：`daily_papers` 分页（最多 20 页）+ `papers` API 补充；默认 `days=7` 的实现以“北京时间今天减 7 天”为含端点截止线，实际覆盖今天及此前 7 个日历日期。来源完成后独立 checkpoint，必需请求、分页覆盖或日期截断不完整时整体失败并等待下次续跑
5. **合并去重**：arXiv 优先，HF 补充 7 个特有字段，标记 `sources`；过滤掉博客已发布论文
6. **关键词预筛 + LLM 筛选**：先用版本化高召回词表检查标题、摘要和类别；eess.AS/cs.SD、摘要不足 80 字符的证据不足项，以及命中语音、音频、音乐、声学信号、情感与副语言、生物声学、听觉健康、视听语音、常见模型/数据集词族的论文进入 LLM，只有摘要完整且未命中的补充类别论文才保存 `keyword_prefilter` 否定决定。随后按 `PAPER_ANALYZER_*` 配置逐篇判断余下论文相关性，每批写入 `filter-decisions.json`。`fetch-checkpoint`、raw、decisions、filtered 共同绑定来源配置、历史去重集合、博客已发布集合、关键词词表版本/开关的指纹；健康 raw 即使尚无 decisions 也能从空集合续跑，模型/prompt/关键词契约变化只重筛该批候选，不重复抓取；只有关键词与 LLM 的明确决定共同完整覆盖候选全集时才可完成
7. **保存筛选结果**：`data/current/raw-candidates.json` 保存筛选输入，`data/current/filtered-papers.json` 保存筛选/归档去重后的输出
8. **更新去重库**：追加所有爬取论文 ID 到 `data/current/papers.json`（不仅筛选通过的，提前保存防止后续中断丢失）
9. **深度分析**：`deep-analyzer.js` 完成全部论文的文本分析与评分审计；该阶段不建立或等待视觉任务。
10. **增量保存**：每篇分析完成或失败后立即保存到 `data/current/deep-analysis-result.json`，自带失败结果保护（已有成功 analysis 的论文不会被无 analysis 的失败结果覆盖）；同时通过 `scripts/digest-status.js` 回写 `papers.json.digestStatus`。写入在跨进程锁内重读最新 canonical 对象、合并本次结果并把 `generation` 递增 1；`generation` 是提交后的版本记录，不是锁外携带 expected-generation 做乐观 CAS。部分失败状态为 `partial_failed` 并返回非零退出码
11. **收尾合并**：去重合并历史结果，自动备份 bak 文件（保留最近 10 个）
12. **全部博客发布后生成视觉摘要**：依次完成博客 generate、review 和 push；远端 `main` OID 验证成功后，`push-blog.py` 自动建立最终评分 TOP 10 论文长图和一张批次汇总图任务。图片不进入或阻断本轮博客发布。Codex 使用内置 `image_gen` 处理 pending/failed 项，项目脚本只管理规划、验证、复制和 checkpoint，禁止调用图像 API。论文长图使用约 220–360 个中文字符，不得退化为口号式概念海报；若深度分析已选中并完整缓存论文关键图，任务按“方法总览/架构/流程优先，关键实验其次”绑定最多两张参考图、caption、MIME、缓存路径和 SHA。内置生图直接完成英文标题、中文说明、结构图、实验数据和纸张拼贴艺术的一体化最终构图，禁止再经过旧的确定性文字卡片合成器；登记前逐项目检标题、文字、箭头关系、指标方向和数值，不可读或存在实质错误必须重生成。两类图片统一采用暖白底与低饱和色的清新纸张编辑风，通过细微纸纹、纸片叠层、局部毛边、少量胶带和柔和投影建立层次；禁止脏旧复古、拥挤手账、深蓝霓虹、赛博 HUD、金属边框和仪表盘风格。

**视觉能力兼容边界**：标准日更在任何 Git 变更前要求 generation schema v3 及 `publishedPapers` 权威快照。schema v1/v2 只允许不带 `--require-visual-plan` 的显式历史维护 push，receipt 将视觉能力标记为 `not_applicable_legacy_maintenance`；不能等远端发布成功后才发现版本不兼容。

`full-fetch.js` 只负责默认 LLM/API 路线的数据阶段，不单独发布博客。用户说“运行/进行某日论文速递”时，`run-daily-digest.sh` 默认调用它并继续普通 LLM review、push 和发布后视觉；只有用户明确指定 Manual/人工流程时才切换 production Manual v6。Agent 必须继续工作，直到论文长图与汇总封面均为 `complete`。

### 2.1 显式 Manual/人工流程

Manual 只在用户明确选择时启用，绝不是默认 LLM/API 路线的错误降级。开始前必须完整阅读 [`manual/README.md`](manual/README.md)，并按其导航阅读 [`manual/docs/workflow.md`](manual/docs/workflow.md)、[`manual/docs/architecture.md`](manual/docs/architecture.md) 与 [`manual/docs/editorial-reference-contract.md`](manual/docs/editorial-reference-contract.md)。Manual 的命令、角色 DAG、逐篇 Terra-high 调度、ArtifactIndex、records/spec、fresh authoring、逐页 review、metrics、shadow、legacy 和恢复规则仅在该目录维护。

项目 runner 不创建 subagent 或写正文；主 Agent 直接调度逐篇隔离的 Terra-high leaf，production provenance 不完整时失败关闭。默认 `digest:prepare` / `digest:api` 不得读取或伪造 Manual lineage。

---

## 3. 数据路径规范

### 3.1 优先路径（当前）

| 文件 | 用途 | 归档行为 |
|------|------|---------|
| `data/current/papers.json` | 论文去重数据库（含 `digestStatus` 分析状态） | **不归档**，持续累积；`pending_analysis` / `analysis_failed` 不参与强去重，便于中断后重跑；所有分析入口通过 `scripts/digest-status.js` 同步状态；旧成功分析保留时用 `latestAttemptStatus` 记录最新失败尝试 |
| `data/current/fetch-checkpoint.json` | 逐来源抓取 checkpoint，绑定候选指纹、论文数量和稳定内容 SHA-256 | 同日原子更新；篡改或截短只重抓对应来源 |
| `data/current/raw-candidates.json` | 当日合并与博客去重后的筛选候选，含 `sourceHealth` | 每次全流程重写，用于排查筛选输入 |
| `data/current/filter-decisions.json` | 当日逐篇 LLM 筛选决策缓存，含 reason/rawResponse | 每批增量写入，模型或 prompt hash 变化后自动失效 |
| `data/current/filtered-papers.json` | 筛选后的论文元数据 | 每日归档移走后重新生成 |
| `data/current/deep-analysis-result.json` | 核心分析结果（含逐阶段 checkpoint、指纹、analysis / parsed / 图片与来源状态） | 每篇完成或失败后立即锁内保存；下次从首个未完成或指纹失效阶段续跑 |
| `data/current/visual-summary-manifests/YYYY-MM-DD.json` | 全部博客发布后评分 TOP 10 的纵向长图状态，绑定排名、分析/prompt SHA 和资产 SHA | 仅失败、缺失或指纹变化的长图回到 pending |
| `data/current/digest-cover-manifests/YYYY-MM-DD.json` | 全部博客发布后的批次汇总图状态 | 绑定论文集合、热门方向、排行榜和 prompt SHA |
| `data/current/xiaohongshu-oneliners-YYYY-MM-DD.json` | 小红书逐篇一句话文案缓存，绑定分析、prompt、模型配置和清洗契约 | 每篇成功后原子保存；仅失败或输入变化的论文重跑 |
| `data/current/analyzed.json` | 旧版已分析记录（兼容） | 每日归档移走后重新生成 |

### 3.2 兼容行为

部分脚本在读取时兼容 `data/*.json` 旧路径，但新产物应写入 `data/current/`。Python 发布入口通过 `path_config.resolve_deep_analysis_result_path()` 保持 current 优先、legacy 兜底。

### 3.3 归档目录

`data/archive/<YYYY-MM-DD>/` 按日期子目录存放当日归档文件。发布后生成的全部图片扁平保存到同一个 `visual-summaries/` 目录：汇总封面名为 `00-digest-cover-<date>.png`，TOP 10 论文长图按最终排行榜编号命名为 `<rank>-<paper-id>-<title-slug>.png`。文件名同时包含排名、论文 ID 和英文标题短名，禁止再为每篇论文建立只含 `infographic.png` 的子目录。旧版 current/归档图片在下一次视觉 plan 时校验 SHA 后原子迁移。`deep-analysis-result-<时间戳>.bak.json` 备份文件也存放在归档目录，自动清理保留最近 10 个。

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
- endpoint 必须使用 HTTPS；HTTP 只允许 `localhost` / `*.localhost` / `127.0.0.0/8` / `::1` 上的本地测试服务，公网明文 HTTP 在附加认证头前即被拒绝；Python 发布阶段的 `publish_common.py` 执行同一门禁
- key: `PAPER_ANALYZER_API_KEY`（必填）
- model: `PAPER_ANALYZER_MODEL`（必填）
- **API 协议自动路由**：`scripts/utils.js` 中的 `detectApiType()` 会根据端点和模型名自动判断使用 OpenAI Chat、OpenAI Responses 还是 Anthropic 协议；完整优先级见第 4.2 节。DeepSeek 强制 OpenAI Chat；精确模型 `muse-spark-1.2-contributor` 走 OpenAI Responses；MiMo Token Plan、Kimi Coding Plan（含 `k3`）及非 DeepSeek 的 `/anthropic` 走 Anthropic
  - **OpenCode Go Muse Spark Contributor**：`https://opencode.ai/zen/go/v1` → `https://opencode.ai/zen/go/v1/responses`，请求体使用 `input` / `max_output_tokens`，响应读取 `output_text` 或 `output[].content[].output_text`
  - **MiMo/Kimi Token Plan / Coding Plan**（MiMo 由 `token-plan` + MiMo 域名/模型识别；Kimi 由 `coding` + `kimi.com` 域名或 Kimi 模型识别）→ 自动切换为 **Anthropic 协议**，伪装成 Claude Code 调用
    - **MiMo**: `https://token-plan-cn.xiaomimimo.com/v1` → `https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages`（替换 `/v1` 为 `/anthropic`）
    - **Kimi**: `https://api.kimi.com/coding` 或 `https://api.kimi.com/coding/v1` → `https://api.kimi.com/coding/v1/messages`（自动补齐 `/v1`，无需 `/anthropic` 中间路径）
    - Headers: `x-api-key` + `anthropic-version: 2023-06-01` + `User-Agent: claude-cli/<version> (external, cli)`（版本号动态获取自本地 `claude --version`，失败回退到 `2.1.108`）
    - system message 自动提取为请求体顶级字段（Anthropic 要求）
  - **其他非 DeepSeek 的 `/anthropic` 端点** → 使用 Anthropic 协议并拼接 `/messages`
  - **其他情况**（包括 DeepSeek、MiMo 按量付费、通用 OpenAI 兼容端点）→ 使用标准 **OpenAI 协议**
    - URL: `/v1/chat/completions`
    - Headers: `Authorization: Bearer {key}`
- **网络隔离**：所有 Node LLM 请求统一走 `requestLlmJson()`。默认 `agent:false` 直连；精确模型 `muse-spark-1.2-contributor` 无条件使用项目 `.env` 的 HTTP CONNECT 代理，缺代理立即失败，并在请求结束销毁 one-shot agent。Python 发布 LLM 使用相同例外。
- 超时 60 秒，重试 5 次
- 筛选配置批次默认 5；精确模型 `muse-spark-1.2-contributor` 由 `getEffectiveFilterBatchSize()` 强制为 1，`PD_FILTER_BATCH_SIZE` 不能绕过该代理稳定性边界
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
  - **Kimi**: `/coding` 或 `/coding/v1` → `/coding/v1/messages`

API 调用特性：
- 整体超时 20 分钟，按进程活跃时间记账；系统睡眠/长时间挂起从预算中排除，唤醒后的底层超时继续使用剩余预算重试
- 主分析 max_tokens=64000，审校/表格/方法/结构局部修复默认 max_tokens=16000（`PD_ANALYSIS_REPAIR_MAX_TOKENS` 可覆写），temperature=0.7。OpenAI Responses 只有在 `PD_OPENAI_RESPONSES_STREAM=1` 时使用 SSE；未设置时等待普通 JSON 响应
- 主分析输入默认上限 200K 字符；超过时使用 `task-focused-v1` 跨全文均衡取样，不再只保留开头。开源/审校/评分/表格与方法/结构后处理证据默认上限分别为 16K/60K/40K/30K/40K 字符，且使用任务关键词优先的证据块，避免重复发送完整全文。对应 `PD_*_EVIDENCE_MAX_CHARS` 和 `PD_ANALYSIS_FULL_TEXT_MAX_CHARS` 会进入阶段指纹
- 主分析与审校只保留支撑结论的关键表格。新 API 分析/重分析必须写入 `analysisManifest.contracts.experimentTables=evidence-rich-v2` 并通过 Node/Python 双端硬校验：沿用每篇最多 2 张、每张最多 12 个数据行和 8 个指标列的上限，同时要求设置/数据集/基线标识、至少 3 行证据和 2 个数字、指标方向、表前具体比较问题、表后关键差异与证据边界；全文明确提供消融或负面结果时必须覆盖。历史 `bounded-v1` 只校验旧上限，不追溯执行深度门禁。全文编号表缺失、已有表格过浅或非法省略标记会进入表格修复
- **双层重试**：analysis-engine.js 层面每篇默认最多重试 2 次（总共最多 3 次尝试，`PD_ANALYSIS_MAX_RETRIES`）；deep-analyzer.js 内部每个 LLM API 阶段默认最多尝试 3 次（`PD_ANALYSIS_API_MAX_RETRIES`，指数退避：第一次等待 10 秒，之后翻倍，`2^attempt * 5s`）
- **抓取代理为强制项**：arXiv/HuggingFace 抓取缺少项目 `.env` 代理必须失败，禁止直接回退。Node arXiv 使用 `HTTPS_PROXY` 或 `HTTP_PROXY` 中至少一项 HTTP CONNECT 地址，HuggingFace curl 可额外使用 SOCKS `ALL_PROXY`。LLM 默认直连；精确模型 `muse-spark-1.2-contributor` 强制使用同一项目 HTTP CONNECT 代理且禁止静默直连。访问本机代理的网络命令必须在沙箱外运行。
- arXiv HTML 解析使用 **cheerio** 结构化选择器，移除 script/style/nav/header/footer 等噪音元素
- HTML 全文不能只靠字符数判定：还要满足有效长段落数及论文章节/结构标记；`too_short`、`metadata_shell`、`missing_paper_structure` 都继续 PDF fallback，并记录结构计数
- 图片先按 caption/文件名/顺序启发式预筛（默认 `imageCandidateMax=20`）；HTML 正文与图注在同一次响应中解析并复用，预提供 URL 会按完整 URL或唯一文件名补全 caption。只有配置副模型的双模型模式才**串行下载**最多 `imageMaxCount=20` 张候选图片并送入副模型；成功内容写入 `data/current/image-cache/`，恢复时校验 MIME/文件头后复用。仅 408/425/429/5xx 和网络异常重试，404、非法 MIME、超限与安全拒绝立即终止
- 每篇分析结果写入 `imageManifest`，记录图片发现数、候选评分、逐 URL 下载结果、缓存命中、插图计划哈希、拒绝原因和最终选图，便于复盘图像筛选
- 每个分析阶段写入 `analysisManifest`；失败尝试保留 `analysisCheckpoint` 和独立的 `analysisRecoveryImageManifest`。失败合并会独立按完整契约重解析旧正文，不受最新失败 manifest 影响，连续多次失败也不能覆盖旧成功正文，但最新失败标记会强制下一轮继续重试，成功后才清理。arXiv HTML/图片发现默认单次 60 秒，PDF fallback 默认 180 秒；瞬时全文失败不得降级成摘要成功，Demo 的 408/425/429/5xx 与网络错误保持可重试。Demo 页面最多跟随 3 次重定向并逐跳重验公网 DNS/IP。插图输出若破坏正文契约，整份插图计划作废并保留审计后的纯文本正文
- 主分析全文输入上限约 200K 字符（config.js 中 `fullTextMaxChars`）；来源原始长度与实际取样长度分别保存
- 所有分析配置集中管理于 `scripts/config.js`，支持在项目根 `.env` 中覆写

输出约束：
- prompt 来源：`prompts/deep-analysis.md`，运行时通过 `loadPrompt()` 读取并替换 `{hasFullText}`、`{title}`、`{authors}`、`{categories}`、`{arxivId}`、`{textForAnalysis}` 占位符
- arXiv 获取结果保存结构化来源：`analysisSource`、`sourceId`、原始/实际输入/全文字符数、`truncated`、`sourceSha256`、HTML 可用性和告警。稳定 400/403/404 不重复请求；版本化 ID 只读取指定版本；PDF 有 50MB 默认上限并校验 MIME、文件头与提取长度。全文不可用时优先使用完整摘要，不允许短错误页覆盖摘要
- checkpoint 的来源 SHA-256 变化时清除主分析及全部下游状态，避免旧全文正文被新一轮摘要审校。评分审计另保存模型、低温、prompt 模板哈希、证据哈希、尝试次数、结构化证据画像、代码上限和最终 JSON；这些指纹变化失效评分、API 读者文章与插图阶段
- 自动 API canonical 的固定一级标题仍是解析锚点；评分完成后另用 `prompts/api-reader-article.md` 生成 `beginner-researcher-v3` 连续长文。新生成强制 plan v3：12–18 节、5000–18000 中文字、4–10 组术语桥，按原文表格可用性动态要求 2–4 张叙事闭环表，至少 2 张宽表需有 5 列以上。若有真实 Figure，可安全下载的图先作为多模态像素输入，模型按教学价值选图并写入唯一 marker 和 2–4 个 `focusPoints`；代码物化“导读—看图路径—原图—图注—解释”相邻闭环。未传入像素的 Figure 只能用图注/原文，不得猜测坐标轴、曲线、颜色或模块位置。长文独立使用 48000 输出 tokens、180000 证据字符和 240000 完整请求字符默认上限，v1/v2 只作历史只读兼容。日期级升级使用 `npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader`：单进程最多 5 个重阶段槽位，成功项逐篇锁内持久化并做提交时身份校验，续跑仅处理尚未达到正文/计划/阶段 SHA 闭环的论文；`PD_API_READER_CONCURRENCY` 只影响调度，不进入内容指纹。若只是最终正文规范化引起标题或术语桥引用字节漂移，改用 `--surface-bindings-only`，该模式不抓取、不调用 LLM，只确定性重绑计划并更新 SHA。production Manual v6 发布仍使用 `reader-longform-v2`。
- `## 评分` 下先输出总分（X.X/10）
- **代码后处理**：`parseAnalysis`/`parse_analysis` 仅在 `## 评分理由` 的八个分项完整、唯一、各自带具体理由、分母正确、数值有限且位于各自范围时重新计算总分；合计上限为 10，四舍五入到 0.1，覆盖 LLM 原始总分。缺失、重复、缺少理由、错误分母、负数、越界或非有限值会产生契约错误并阻断保存/发布，不存在最低 1 分保底
- `## 机器摘要` 包含 `document_type`、`rank_bucket`（带顶会映射）、`innovation`（创新性 0-2）、`technical_rigor`（技术严谨性 0-1.5）、`experimental_sufficiency`（实验充分性 0-1.5）、`clarity`（清晰度 0-1）、`impact`（影响力 0-1.5）、`open_source`（开源 0-1.5）、`reproducibility`（可复现性 0-0.5）、`engineering_score`（工程/实践价值 0-1.5）、`confidence`、`primary_task_tag`、`primary_method_tag` 等固定键
- 评分采用八维审稿人体系：创新性（0-2）+ 技术严谨性（0-1.5）+ 实验充分性（0-1.5）+ 清晰度（0-1）+ 影响力（0-1.5）+ 开源（0-1.5）+ 可复现性（0-0.5）+ 工程/实践价值（0-1.5），满分 11 分，总分上限 10
- 当前评分版本为 `type-aware-v1`：`document_type` 只能取方法研究、系统技术报告、模型报告、数据集与基准、综述、理论研究、应用研究。类型只决定适用证据，不改变八维权重，也不提供固定加分、保底或豁免
- 使用声明—证据匹配和“单一问题单一主维度扣分”：开源产物缺失、复现细节缺失、实验/证明证据不足、表达问题、技术逻辑错误分别归入对应维度；无法验证时降低 `confidence`
- 系统/模型报告按端到端质量、延迟、吞吐、成本、规模、压力测试、竞品公平性与失败案例评估；数据集/基准、综述、理论和应用研究按各自证据标准评估，不机械要求传统方法消融
- 正文修复后先按共享结构契约检查 13 个必要章节；缺失时使用 `prompts/structure-repair.md` 只修复当前论文结构，避免外层整篇重跑
- 主模型使用 `prompts/scoring-audit.md` 做最终 JSON 评分审计；送审前由代码移除旧“评分理由”段，避免模型照抄待纠正的跨维度扣分，正文与原文证据账本保持不变。输出必须带引用账本 ID 的 `evidenceProfile`；代码会对多组件无直接消融、内部评测未报告样本规模、只有工程主张而无测量/可复用产物等情形应用可解释上限，并把评分契约、cap 规则版本、audit/output SHA 和上限写入 manifest。校验失败会把精确错误及违规分句反馈给下一次局部审计。无核心产物时，代码按“肯定语境承诺开放 0.5 / 明确 URL 或肯定结构化 Demo 0.2 / 否定或未提及 0”确定性归一化开源分和理由；理论研究按公开证明、推导和附录判断核心产物，不因代码/模型/数据标记为空而强制归零。代码只替换评分相关字段，副模型不参与评分
- 插图合并后再次执行完整分析契约；若插图计划破坏章节或解析结果，只丢弃该篇插图计划并保留已审计的主模型正文
- 候选编号不能直接作为展示图号；代码将无真实 caption 的通用 alt 和 `selectedImageUrls` 按最终正文顺序归一化。发布 review 必须保留 Markdown 表格中前导分组列为空的合法续行
- 副模型默认最多按价值顺序选择 4 张图（`PD_IMAGE_INSERTION_MAX` 可用正整数覆写），每张必须从代码生成的段落目录中选择稳定 `paragraph_id`；非法 ID、定位失败和超限图片由代码拒绝，不回退到章节末尾。旧自由文本 `anchor` 仅兼容历史响应。`[secondary]` 日志记录模型/协议/endpoint 与 key 来源、候选和下载数量、caption、缓存、段落 ID、JSON 解析状态、拒绝原因和最终选图；禁止打印 API key 内容
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
- `WECHAT_THUMB_MEDIA_ID`：封面图永久素材 ID；真实草稿发布必填，`--dry-run` 可不配置，项目不再内置可能过期的素材 ID
- 图片上传：下载 arXiv 图片 → 上传到微信 CDN → 替换为微信 URL。缓存保存在系统临时目录下的 `wechat-image-cache.json`
- 该脚本会访问真实微信接口；除非用户明确要求生成或上传公众号草稿，否则不要执行
- **注意**：所有发布脚本统一从环境变量读取凭证，禁止硬编码

### 4.5 完整环境变量清单

```bash
# LLM API（筛选 + 深度分析，下面配置只能选一种启用）

# 方案 1: OpenCode Go Muse Spark Contributor（OpenAI Responses；必须配置 HTTP CONNECT 代理）
PAPER_ANALYZER_API_KEY=your-opencode-go-key
PAPER_ANALYZER_MODEL=muse-spark-1.2-contributor
PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897

# 方案 2: MiMo Token Plan（Anthropic 协议，保持直连）
# PAPER_ANALYZER_API_KEY=tp-your-token-plan-key
# PAPER_ANALYZER_MODEL=mimo-v2.5
# PAPER_ANALYZER_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1

# 方案 3: MiMo 按量付费（通用 OpenAI 协议）
# PAPER_ANALYZER_API_KEY=sk-your-pay-as-you-go-key
# PAPER_ANALYZER_MODEL=mimo-v2.5
# PAPER_ANALYZER_ENDPOINT=https://api.xiaomimimo.com/v1

# 方案 4: Kimi Coding Plan（自动切换 Anthropic 协议）
# PAPER_ANALYZER_API_KEY=sk-your-kimi-key
# PAPER_ANALYZER_MODEL=kimi-for-coding
# PAPER_ANALYZER_ENDPOINT=https://api.kimi.com/coding/v1

# 方案 5: 通用 OpenAI 兼容端点
# PAPER_ANALYZER_API_KEY=sk-your-openai-key
# PAPER_ANALYZER_MODEL=gpt-4o
# PAPER_ANALYZER_ENDPOINT=https://api.openai.com/v1

# 方案 6: 双模型模式（主模型纯文本 + 副模型多模态图像筛选与插图计划）
# 主模型配置同上（选方案 1-5 之一）
# 副模型（可选，不设置则退回单模型纯文本模式）
# PAPER_ANALYZER_SECONDARY_MODEL=mimo-v2.5
# PAPER_ANALYZER_SECONDARY_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1
# PAPER_ANALYZER_SECONDARY_API_KEY=tp-your-token-plan-key
# 注：副模型 endpoint/key 不设置时默认复用主模型的对应值

# 微信公众号
WECHAT_APP_ID=your-app-id
WECHAT_APP_SECRET=your-app-secret
# 封面图永久素材 ID（真实草稿发布必填；只有 --dry-run 可省略）
WECHAT_THUMB_MEDIA_ID=your-thumb-media-id

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
# 深度分析并发度
# PD_ANALYSIS_CONCURRENCY=3
# 深度分析重试次数
# PD_ANALYSIS_MAX_RETRIES=2
# 单次分析内部每个 LLM API 阶段的最大尝试次数
# PD_ANALYSIS_API_MAX_RETRIES=3
# 审校/表格/方法/结构局部修复输出上限
# PD_ANALYSIS_REPAIR_MAX_TOKENS=16000
# PD_ANALYSIS_FULL_TEXT_MAX_CHARS=200000
# PD_OPENSOURCE_EVIDENCE_MAX_CHARS=16000
# PD_REVISION_EVIDENCE_MAX_CHARS=60000
# PD_SCORING_EVIDENCE_MAX_CHARS=40000
# PD_REPAIR_EVIDENCE_MAX_CHARS=30000
# PD_STRUCTURE_EVIDENCE_MAX_CHARS=40000
# 博客文本 review 分块，范围 4000-16000
# PD_BLOG_REVIEW_CHUNK_CHARS=8000
# 单次博客 review 输出预算；隐藏推理耗尽时只做一次纯 JSON 恢复，默认最高 8000
# PD_BLOG_REVIEW_MAX_TOKENS=4000
# 重分析并发度（默认与 ANALYSIS_CONFIG.concurrency 一致）
# PD_REANALYZE_CONCURRENCY=3
# LLM 筛选每批篇数
# PD_FILTER_BATCH_SIZE=5
# arXiv 每类抓取数量
# PD_ARXIV_MAX_RESULTS=100
# PD_ARXIV_FETCH_MAX_RETRIES=5
# PD_ARXIV_FETCH_RETRY_BASE_DELAY_MS=5000
# PD_ARXIV_RATE_LIMIT_BASE_DELAY_MS=60000
# PD_ARXIV_FETCH_MAX_WAIT_MS=600000
# Manual raw 同 host 自适应冷却（健康/瞬时失败/429）与健康抖动
# PD_ARXIV_HEALTHY_COOLDOWN_MS=1000
# PD_ARXIV_TRANSIENT_COOLDOWN_MS=5000
# PD_ARXIV_RATE_LIMIT_COOLDOWN_MS=60000
# PD_ARXIV_COOLDOWN_JITTER_MS=1000
# 单类 HTTP 429 累计退避上限（毫秒）
# PD_ARXIV_RATE_LIMIT_MAX_WAIT_MS=120000
# PD_ARXIV_METADATA_TIMEOUT_MS=60000
# PD_ARXIV_METADATA_MAX_BYTES=8388608
# PD_ARXIV_USER_AGENT=paper-digest/1.0
# PDF fallback 最大字节数
# PD_ARXIV_PDF_MAX_BYTES=52428800
# PD_SCORING_AUDIT_TEMPERATURE=0.1
# PD_IMAGE_PLAN_TEMPERATURE=0.2

# 抓取代理（必需）：arXiv 的 Node 请求至少配置 HTTPS_PROXY 或 HTTP_PROXY，且必须是 HTTP CONNECT 地址
# HTTPS_PROXY=http://127.0.0.1:7897
# HTTP_PROXY=http://127.0.0.1:7897
# HuggingFace 的 curl 可额外使用 SOCKS；LLM 默认直连，Muse Spark Contributor 强制复用 HTTP CONNECT 代理
# ALL_PROXY=socks5h://127.0.0.1:7897
```

**API 协议自动路由概览**：

| 端点特征 | 模型特征 | 自动路由 | URL 转换 |
|----------|----------|----------|----------|
| 含 `deepseek.com` 或模型含 `deepseek` | — | OpenAI | `/anthropic` → `/v1/chat/completions`（优先级最高） |
| 含 `token-plan` | 含 `mimo` | Anthropic | `/v1` → `/anthropic/v1/messages` |
| 含 `coding` | 端点含 `kimi.com` 或模型含 `kimi` | Anthropic | `/coding` 或 `/coding/v1` → `/coding/v1/messages`；兼容 `k3` |
| 含 `/anthropic` | — | Anthropic | `{base}/messages` |
| 其他 | 其他 | OpenAI | `/v1/chat/completions` |

端点配置格式统一为 `协议://域名/v1`，不管后续用哪种协议，配置方式一致。

---

## 5. 常用命令（当前可用）

```bash
cd /path/to/audio-paper-digest

# 默认日更脚本阶段（数据流程 + 博客生成/review/push + 视觉输入准备）
npm run digest:prepare -- YYYY-MM-DD
# review 失败并修正后可从指定阶段续跑
./run-daily-digest.sh YYYY-MM-DD --from review

# 仅数据流程（抓取 + 筛选 + 深度分析）
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

# 该入口逐批保存目标目录下的 refilter-filter-decisions.json；
# 日期、模型/端点/协议、prompt、温度、输出上限、决定契约、关键词版本或
# 单篇筛选输入变化时自动失效，续跑只调用尚无确定性决定的论文
# 筛选完整后会从 raw 候选与确定性决定原子重建同日正式
# filter-decisions.json / filtered-papers.json，避免历史状态继续引用旧筛选集合
# API 重分析入口会剥离旧 Manual-only 顶层字段与合同，禁止把新 API 正文
# 错误包装成 Manual v6 产物，也禁止旧 Manual lineage 污染发布门禁
# 收尾时 canonical 结果按本轮入选 ID 收敛：入选失败项保留恢复 checkpoint，
# 本轮明确落选的旧分析从该批次 deep-analysis-result.json 移除

# 运行单元测试
npm test

# 批量分析未分析论文（基于 deep-analysis-result.json）
npm run batch

# 单独分析一篇论文（命令行参数）
node scripts/analyze-single-paper.js 2604.16044 --force

# 补录历史 paper ID（不做深度分析）
npm run backfill

# 博客必须分三阶段执行
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:generate -- --date YYYY-MM-DD --exclude-id 2607.12345  # 明确排除单篇，可重复传入
npm run blog:generate -- --date YYYY-MM-DD --include-id 2607.12345 # 单篇灰度，只生成该论文页
npm run blog:generate -- --date YYYY-MM-DD --include-id 2607.12345 --sealed-tutorial-preview # 密封 tutorial 原字节单页灰度，不读 canonical 正文
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD

# 显式 Manual 的内部命令与单篇灰度见 manual/README.md
npm run digest:manual -- YYYY-MM-DD

# push 验证远端 main OID 后会自动建立发布后视觉任务；可幂等重跑
npm run visual:post-publish -- --date YYYY-MM-DD
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
npm run digest:status -- --date YYYY-MM-DD

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
- TOP N 一句话默认以 5 并发生成，可通过项目 `.env` 的 `PD_XIAOHONGSHU_ONELINER_CONCURRENCY` 调整为 1–5；完成顺序不会改变最终排名顺序，单篇异常只回退该篇
- 每篇成功的一句话在日期级锁内立即写入缓存；坏缓存原子隔离后重建，只复用指纹完全一致的成功项；`--date` 严格校验为 `YYYY-MM-DD`。本流程只生成文案，不触发自动发布
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
- `deep-analysis-result.json` 可能包含当日新增分析和合并保留的既有结果；博客、微信、飞书和小红书默认按不可变 `fetchBatchDate`/`batchDate` 过滤，旧数据才回退严格北京时间 `fetchedAt`，只有匹配批次日期的论文会发布到当天内容下

当前行为：

- schema v3 generation 中每个页面的 SHA/删除状态在 review 开始、receipt 签发和 push 重验时都必须与当前文件一致；generation 后的任何字节漂移在 LLM/Hugo 前 fail closed。`content/posts` 的现存项和删除项都必须绑定目标日期。

- 默认读 `data/current/deep-analysis-result.json`
- **按批次日期过滤**：优先使用抓取阶段写入的 `fetchBatchDate` 或 `batchDate`，旧数据才使用严格北京时间 `fetchedAt` 的日期；只发布匹配 `--date` 指定日期的论文（默认今天），避免历史数据被重复发布
- 生成阶段可重复传入 `--exclude-id <arXiv ID>`，只从本次 generation 权威快照排除明确命中的论文；ID 未命中会阻断，分析数据本身不变
- 显式 Manual 的单篇灰度、sealed preview 与 legacy promotion 边界统一见 [`manual/README.md`](manual/README.md)，不得由默认 API 发布说明推导或复制。
- 微信公众号、飞书和小红书默认绑定目标博客发布日期的 generation manifest 与远端验证 receipt，并严格按 `publishedPapers` 的 ID、内容和顺序发布；论文自身 `fetchBatchDate` 可以早于博客发布日期。current 已滚动时自动回退 `data/archive/<日期>/deep-analysis-result.json`，显式自定义数据文件也不会隐式绕过快照。只有明确独立运行时才传 `--ignore-blog-snapshot`。微信/飞书的 `--all` 在独立模式表示使用全部输入；小红书的 `--all` 仅表示生成完整汇总文案
- 在 `~/code/github_repos/audio-paper-digest-blog/content/posts` 生成：
  - 汇总页：`YYYY-MM-DD.md`
  - 单篇页：`YYYY-MM-DD-<slug>.md`
- `generate-blog.py` 在日期级跨进程锁内逐页生成、安装并写 journal；崩溃后可收养已完成的同 SHA 页面，全部论文完成后才生成汇总页和严格 generation manifest，禁止 review/commit/push
- `review-blog.py` 在同一日期锁内逐文件审查；每次尝试开始时构造绑定 SHA/YAML/body/门禁结果的不可变 page artifact，正文解析、确定性 dry-run、LLM 和图片审查共用它，收口前仍重新读取/哈希以检测并发变化。checkpoint 绑定 worker 实际审查的 SHA，并立即写入 `data/current/blog-review-checkpoints/<date>/`。以博客仓库相对路径 + SHA-256 复用，只审查新增、字节变化、瞬时失败或内容失败修复后的文件；批次 receipt 收口时只线性扫描 shard 一次。终轮 LLM review 是只读校验，任何修复建议都使页面失败并返回生成/修复阶段，禁止 worker 在审查后原地改写。代码、脚本、文档、模型、协议、generation manifest 或博客基线变化只要求重建整批 receipt，不得重审 SHA 未变的页面；页面消失或 Hugo 前后 SHA 变化仍阻断凭证；禁止 commit/push
- 完全相同的非空 generation 只有在当前 review 协议、文件、发布提交、remote 名称/push URL 哈希身份及实时远端 `main` OID 全部仍匹配时才保留既有严格发布凭证；网络失败、远端漂移或 `origin` 换仓一律 fail closed
- review 的 HTTP 重试优先使用 `Retry-After`，否则指数退避并加短抖动；协议格式修复和完整协议重试使用收紧的独立预算。对仅有隐藏推理、没有最终 JSON 的 `length/max_tokens` 响应，仅追加纯 JSON 指令并恢复一次，默认从 4000 提到最多 8000，再失败不继续翻倍。发布派生 Markdown 必须剥离 `[A_*]` / `[SCORING_SOURCE_*]` 内部评分锚点而不改 canonical analysis。代码预检去除完全重复段落；近重复长段仅在数字、URL 和否定词签名一致时删除，并修复反引号包裹的 LaTeX、处理 120 字以上疑似截在英文半词的图片说明、阻断英文占主导的“毒舌点评”、校验表格列数；合法空分组列续行不得删除
- `push-blog.py` 验证审查凭证和当前文件哈希，并在 Git 变更前完成视觉能力 preflight；标准日更拒绝 schema v1/v2，显式历史维护 push 跳过视觉并报告 N/A。随后精确 stage，并在 commit 前逐项校验 index blob SHA/删除状态，再提交、推送并核对远端 OID；禁止重新生成或 review
- push 成功后 receipt 同时保存当前 Git remote 名称和 push URL 的 SHA-256 身份，防止同名 remote 被换仓后继续信任旧发布证据
- 三阶段除日期锁外还共享博客仓库级全局锁，防止不同日期并发污染共同的 worktree、index、HEAD 或回滚状态
- **三个阶段及兼容 `publish-to-blog.py` 必须在沙箱外运行**：入口检测到可靠沙箱标志 `CODEX_SANDBOX` 会立即拒绝执行；沙箱外权限包装会保留网络禁用环境标志，不能据此误拒绝。原因是 review 会直连 LLM、下载图片并运行 Hugo，push 需要真实 Git 网络；不得在沙箱内跳过 review、伪造凭证或改用无网络降级路径。
- 若需发布全部论文（不过滤），显式传 `--all`

Agent 执行约束：

- 用户说“运行/进行某日论文速递”即授权完整 LLM/API 标准链路，包括自动筛选/分析、普通 review、`push-blog.py` 与视觉验收；只有明确要求 Manual/人工流程才切换 production Manual v6。
- 若只是检查格式、验证新字段或预览产物，禁止触发真实 `git push`

发布前保障：

- `full-fetch.js` 每天运行时会逐文件自动归档移走昨日的 `raw-candidates.json`、`filter-decisions.json`、`filtered-papers.json`、`deep-analysis-result.json` 和 `analyzed.json`，确保 current 的批次伴随快照不会混日；`papers.json` 始终保留
- `digest:status --date` 对历史日期可回退同日 archive，但必须实际取得 raw/decisions/filtered/deep，并校验 decisions 精确覆盖 raw、filtered 精确等于 `related=true` 扣除显式排除项、全部论文属于目标批次且 deep 无混批；不得仅凭汇总统计推导完整状态。当前日期仍只认 current
- 发布默认优先按 `fetchBatchDate`/`batchDate`、旧数据回退严格北京时间 `fetchedAt` 的 `--date` 过滤；仍需保持 `data/current/` 干净，避免 review、校验和显式 `--all` 发布时混入不同批次

### 重跑/修复当天的正确姿势

若当天结果需要清空重跑：

1. 若 `data/current/filtered-papers.json` 是今天且 `status: complete`，并且筛选指纹与当前配置一致：不要删筛选结果，直接运行 `node scripts/full-fetch.js`，主流程会跳过抓取/筛选并续跑深度分析；若仅筛选模型/prompt/协议参数变化且健康 raw 候选仍匹配，只重新筛选，不重复抓取。
2. 若筛选未完成且 `data/current/raw-candidates.json` / `filter-decisions.json` 是今天、来源健康且模型/prompt hash 一致：直接运行 `node scripts/full-fetch.js`，主流程跳过抓取，只重试未决论文；不能删除这两个 checkpoint。
3. 若要彻底重抓重筛，再删除 `data/current/fetch-checkpoint.json`、`data/current/raw-candidates.json`、`data/current/filter-decisions.json`、`data/current/filtered-papers.json`、`data/current/deep-analysis-result.json`
4. **必要时恢复 `papers.json` 到昨天状态**（推荐，比个删 ID 更可靠）：
   ```bash
   # 用昨天备份替换去重库（backupPapersJson 生成，格式为 papers-YYYY-MM-DD.json）
   cp data/archive/papers-2026-04-21.json data/current/papers.json
   ```
5. 删除博客仓库中当天的所有 `content/posts/YYYY-MM-DD-*.md` 文件
6. 重新运行 `node scripts/full-fetch.js`

**特殊场景——抓取或筛选 API 全面失败：**
- arXiv/HuggingFace 抓取器会区分“请求成功但结果为空”和“所有请求失败”；全失败会抛出带 `sourceHealth` 的异常，禁止生成完整空批次。
- 筛选 API 错误或无法判断的结果标记为 `retryable`，不会写入正式决定缓存，也不能把筛选产物标记为 `complete`；若同日候选来源健康，重跑主流程只复用候选和明确决定、重试未决项，禁止为此重新抓取全部来源。

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

- Node/Python 可执行脚本默认同时输出到终端和唯一的 `logs/<script>-YYYYMMDD-HHMMSS-<pid>-<seq>.log`
- `PD_ENABLE_FILE_LOGS=1` / `PAPER_DIGEST_ENABLE_FILE_LOGS=1` 继续兼容，但不再是生成日志的必要条件
- 文件日志不做数量、总量或单文件大小限制，也不会自动清理旧日志；`PAPER_DIGEST_DISABLE_FILE_LOGS=1` 或 `PD_DISABLE_FILE_LOGS=1` 可强制禁用文件日志
- `backfill_papers.py` 复用统一的每次运行日志，不再额外追加 `logs/backfill.log`
- 日志均为 UTF-8 纯文本并使用 `0600` 权限；每个非空物理日志行均以毫秒级北京时间戳（`[YYYY-MM-DD HH:mm:ss.SSS+08:00]`）开头。日志层统一脱敏 `Authorization`、`x-api-key`、Cookie、token、secret、password、任意已配置密钥实际值和 URL userinfo，并同步落盘，避免 `process.exit()` 丢失尾部日志
- `full-fetch.js` / `deep-analysis-only.js` / `batch-analyze.js` 采用重试、逐阶段锁内 checkpoint 和跨进程锁；每次写入在锁内重读 canonical、合并并递增 `generation`，不使用锁外 expected-generation 乐观比较。损坏的 current JSON 会阻断写入，不会回退 legacy 后覆盖。长时间单篇锁使用 heartbeat 续租，远程主机遗留锁只在租约超龄后回收
- `full-fetch.js` 另有覆盖归档、清理、筛选和最终合并的单实例运行锁，内部论文分析仍保持配置的并发度；锁 owner 使用随机 token，旧 owner 不能释放后来者的同路径新锁
- `reanalyze.js` 在每篇成功或失败回调中立即锁内合并保存，并同步该篇 `papers.json.digestStatus`；最终汇总只更新顶层统计，不会把累计旧快照重新覆盖正文
- 可运行 `npm run validate:data` 只读校验当前 `papers.json`、`raw-candidates.json`、`filter-decisions.json`、`filtered-papers.json`、`deep-analysis-result.json` 的结构、候选统计、筛选计数一致性，以及完整筛选决策对候选全集的覆盖；该命令不修复数据，发现问题会非零退出。没有运行数据的干净 checkout 仅可显式使用 `npm run validate:data -- --allow-empty`；CI 使用该空仓模式，实际数据校验由单测夹具覆盖
- `full-fetch.js` 自动备份 bak 文件到 `data/archive/`，保留最近 10 个
- `full-fetch.js` 自动备份 `papers.json` 到 `data/archive/papers-<日期>.json`，保留最近 7 天

---

## 8. Agent 执行规则（强约束）

1. **先查再改**：先读取相关脚本确认当前行为，再更新文档或执行命令。
2. **发布需确认日期**：未明确日期时，先问用户；默认不要依赖"今天"。
3. **禁止危险操作**：未获明确授权，禁止 `git reset --hard`、`git push -f`、批量删除历史文章。
4. **默认日更必须用 LLM/API 跑完整链路**：用户说“运行/进行某日论文速递”即明确授权博客发布，并要求自动抓取、筛选、全文分析、评分校准、读者长文、普通 LLM review/修正、push、TOP 10 论文长图、汇总封面和最终状态验收。只有用户显式点名 Manual/人工流程才改走 production Manual v6；不得把 API 失败伪装成 Manual 通过。
5. **改动留痕**：流程、参数、路径变化后，同步更新 `SKILL.md`、`README.md`、`AGENTS.md` 和相关 `docs/` 文档。
6. **禁止硬编码密钥**：不要在任何脚本或文档中写入真实 API key；所有凭证（LLM、微信公众号、飞书）统一放在 `项目根目录的 `.env` 文件`，由脚本通过项目 env loader 加载。
7. **修改脚本时防止安全机制破坏**：本环境会静默替换 `API_KEY` 等敏感字符为 `***`。修改含有这类字符的脚本时，修改后必须重新读取文件验证关键行未被破坏。同时定期检查 `data/`、`logs/` 目录是否残留含密钥的备份文件或日志快照，发现立即清理。
8. **环境变量统一管理**：新增脚本需要读取 LLM 配置时，统一使用项目 `.env` 中的 `PAPER_ANALYZER_API_KEY`、`PAPER_ANALYZER_MODEL`、`PAPER_ANALYZER_ENDPOINT`，并复用 Node `scripts/env-loader.js` 或 Python `scripts/project_env.py`；禁止引入别名回退链、硬编码、base64 编码变量名 hack，或读取外层 shell/Codex/Trae 继承变量作为项目配置。
8.1 **所有脚本必须沙箱外执行**：直接运行任意 `scripts/*`、`manual/scripts/*`、`run-daily-digest.sh`、`run-full-fetch.sh` 或其他项目 shell 入口时，必须使用沙箱外权限。Node/Python 公共环境加载器和 shell 入口会在检测到 `CODEX_SANDBOX` 后、任何业务逻辑/日志/网络/写入之前失败退出；不得在沙箱内换命令、手动取消检查或伪造结果。单元测试导入模块不会触发该守卫。
9. **新增可配置参数和运行数据路径放入统一配置**：新增 Node 脚本涉及可调整参数（并发度、超时、批次大小等）或 `data/current/*.json` 运行数据文件时，统一放入/复用 `scripts/config.js`（运行数据路径使用 `Config.FILES`），参数项按需添加项目 `.env` 覆写支持；新增 Python 发布/维护脚本涉及共享路径时，复用 `scripts/path_config.py`，禁止再次手写 `data/current/*.json` 默认路径。
10. **新增分析脚本复用 analysis-engine.js**：新增论文分析相关脚本时，优先复用 `analysis-engine.js` 的 `analyzeBatch()` / `analyzePaperWithRetry()`，避免重复实现重试、解析、保存逻辑；保存结果后必须通过 `scripts/digest-status.js` 同步 `papers.json.digestStatus`。
11. **博客三阶段不得合并**：`generate-blog.py` 只生成并写 generation manifest；`review-blog.py` 只执行严格 LLM/图片 review 和 Hugo gate，通过后写入逐文件 SHA-256 凭证；`push-blog.py` 只验证凭证后 commit/push，禁止调用生成或 review。“运行/进行某日论文速递”视为明确 push 授权；其他请求未获明确授权时禁止运行 push 阶段。
11.1 **博客发布必须沙箱外执行**：运行 `generate-blog.py`、`review-blog.py`、`push-blog.py` 或兼容 `publish-to-blog.py` 时，Agent 必须使用沙箱外权限。脚本检测到 Codex 沙箱标志会失败退出；该失败不是内容问题，不得在沙箱内重复执行或绕过 LLM/图片/Hugo/Git 检查。
12. **输出契约改动要同步 parser**：若修改 `prompts/deep-analysis.md` 中的 `## 机器摘要` 键名、章节顺序或标签输出格式，必须同步检查 `scripts/utils.js` 与 `scripts/utils.py` 的解析逻辑。
13. **变更后必须做产物级验证**：至少抽样检查一份 `data/current/deep-analysis-result.json`，确认 `analysis` 文本的机器摘要包含 `document_type`、`rank_bucket`、`primary_task_tag`、`primary_method_tag`，且 `parsed` 缓存包含 `documentType`、`scoringRubricVersion`、`rankBucket`、`primaryTaskTag`、`primaryMethodTag` 等字段，再运行博客/社媒脚本验证最终产物。
14. **变更后验证 prompt 加载**：修改 `prompts/` 或 `manual/prompts/` 下的 markdown 文件后，运行对应测试；需要产物级验证时再执行单篇分析，确认加载、占位符替换和生产 SHA 绑定正确。
15. **变更后运行单元测试**：修改 `scripts/utils.js`、`scripts/config.js` 或分析引擎核心逻辑后，必须运行 `npm test` 确保测试通过。
16. **LLM 代理策略必须由公共封装决定**：所有 Node LLM 调用（包括 `test-api-key.js`）必须通过 `requestLlmJson()`。MiMo/Kimi 等默认路径的 `options.agent` 必须为 `false`（不是 `undefined`）；精确模型 `muse-spark-1.2-contributor` 则必须创建并销毁项目 HTTP CONNECT one-shot agent。禁止调用方自行选择或复用 agent。
17. **新增 LLM 端点必须接入 API 协议自动路由**：任何新增 Node 脚本调用 LLM 时，统一使用 `scripts/utils.js` 中的 `detectApiType()`、`buildApiUrl()`、`buildHeaders()`、`buildRequestBody()`、`parseResponseText()`；Python 发布阶段 LLM 调用必须复用 `publish_common.py` 的 `call_publish_llm_api()`，禁止硬编码特定协议的 URL/Header/Body。
17.1 **视觉资产由 Codex 内置图像工具在发布后生成**：绝不在项目脚本中调用图像 API，也不读取或要求 `OPENAI_API_KEY`。全部博客页通过 review、push 且远端 OID 验证后，视觉 CLI 才可启动。登记前必须逐项核对 `generationContext.qaClaims`、标题、中文正文、数字和排行榜；论文图与封面 `record` 都必须传 `--qa-attested true`，该声明会写入 manifest。两类任务用 token 登记并独立续跑；同批次图片扁平保存到 `data/archive/<date>/visual-summaries/`，只保留 canonical 文件。

17.2 **参考图必须先规范化输入路径**：深度分析缓存使用 `.bin` 保存原始字节，不能直接作为内置生图的上传路径。每轮视觉生成前运行 `npm run visual:prepare -- --date YYYY-MM-DD`（可加 `--paper ID`）；命令在远端发布凭证和当前 manifest 校验通过后，逐图复核受控缓存路径、SHA-256、字节数、MIME 与魔数，并原子物化为 `data/current/visual-reference-inputs/<日期>/<排名-论文>/` 下的 `.png/.jpg/.webp`，输出绝对 `referencedImagePaths` 和仅供展示的 `relativePath`。内置 `image_gen` 只接收这些绝对规范路径；缓存损坏、MIME 不一致或路径逃逸必须失败，不得手工复制或伪造扩展名绕过。
18. **修改 API 协议路由逻辑时同步全链路**：修改 `detectApiType()` 的判定规则或 `buildApiUrl()`/`buildHeaders()` 等函数时，必须同步检查 `fetch-papers.js`、`deep-analyzer.js` 以及所有使用 `analysis-engine.js` 的脚本（`full-fetch.js`、`reanalyze.js`、`batch-analyze.js`、`deep-analysis-only.js`、`analyze-single-paper.js`），确保全链路行为一致。
19. **禁止将敏感文件提交到版本控制**：`data/`、`logs/`、`*.env`、`*.backup*`、缓存文件、含密钥的日志归档等严禁进入 git；提交前必须确认 `.gitignore` 已正确配置，且仓库中不存在历史遗留的敏感文件。
20. **CI 自动检查**：CI 会运行 `npm test`、`npm run validate:data -- --allow-empty`，检查 `scripts tests manual/scripts manual/tests` 下的 JS、`scripts manual/scripts` 下的 Python，运行默认与 Manual 两处 Python 单测，并检查全仓 shell 语法；新增特殊文件类型时同步更新 `.github/workflows/ci.yml`。
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

**修复**：调用方统一使用 `requestLlmJson()`；它对 MiMo 将 `options.agent` 设为 `false`（不是 `undefined`），彻底禁用连接复用：

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

此诊断只适用于 MiMo/Kimi 等默认直连模型；`muse-spark-1.2-contributor` 的预期行为相反，必须由 `requestLlmJson()` 使用项目 HTTP CONNECT 代理。

### 9.3 深度分析慢或频繁失败

- 查看 `logs/deep-analyzer-*.log`、`logs/full-fetch-*.log`，同时保留终端完整输出
- 检查 key/endpoint/model 三元组是否匹配（见 9.1 节）
- 主分析从一开始就是纯文本，不存在“超时后降级为纯文本”的第二种主分析模式。超时按剩余活跃时间预算进入正常 API 重试；图片下载或副模型插图失败则保留已审计的纯文本 checkpoint，并只从未完成的图片/插图阶段续跑。持续失败时检查代理、模型服务和并发度
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
