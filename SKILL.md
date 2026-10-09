# Audio Paper Digest 操作手册

## 1. 受众、目标与入口

本文供运行、恢复、发布或维护默认 LLM/API 论文速递的 Agent 使用。关键操作限制见 [AGENTS.md](AGENTS.md)，按任务查文档见 [docs/README.md](docs/README.md)，代码入口见 [scripts/README.md](scripts/README.md)。

默认任务是完成北京时间当天的论文筛选、分析、博客发布、上线核验和发布后图片：

```bash
npm run digest:prepare -- YYYY-MM-DD
# 完全等价
npm run digest:api -- YYYY-MM-DD
```

`full-fetch.js` 只处理数据。“运行某日论文速递”还要求生成并审查博客、推送、核验部署与网页、用内置工具生图及最终验收。其他渠道不在默认范围。

Manual 使用独立的内容与来源记录，只在用户明确点名时进入：

```bash
npm run digest:manual -- YYYY-MM-DD
```

进入前完整阅读 [manual/README.md](manual/README.md)。默认 API 失败时不得切换为 Manual，也不得将失败标成 Manual 成功。

## 2. 第一次运行

```bash
npm install
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp env.example .env
```

先确认当前工作区用途，再运行 `npm run workspace:role -- status`。当前目录保持 `daily`，日更、会议与历史维护都在此执行。旧历史工作区已废弃。角色标记缺失或真实路径不符时先停止，确认用途后才用 `npm run workspace:role -- set daily|history [--force]` 绑定；不要无条件强制设置。

本机日更目录已在 `.env` 设 `PD_WORKSPACE_ALLOW_CROSS_ROLE=1`：`history:*` 入口会跨角色放行并打印提示。这个开关只放宽「daily 工作区执行 history 命令」，反向仍拒绝，也不允许日更、会议和历史任务同时生成、审查或推送博客；执行任务的 Agent 负责错峰。

在 `.env` 至少配置以下字段。仓库文档当前推荐模型为 `mimo-v2.6-flash`，实际模型由项目配置指定：

```dotenv
PAPER_ANALYZER_API_KEY=your-key
# 可选；同一 OpenCode Go 路由的备用账号，逗号分隔
PAPER_ANALYZER_FALLBACK_API_KEYS=your-second-key
PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY=your-third-key
PAPER_ANALYZER_MODEL=mimo-v2.6-flash
PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
PAPER_DIGEST_BLOG_REPO=/absolute/path/to/audio-paper-digest-blog
```

Node 要求 `>=20.18.1 <21 || >=22.3.0`。npm 中的 Python 命令要求 Python 3.11+ 且由 OpenSSL 提供 TLS；`scripts/python-runtime.sh` 依次选择项目 `.venv`、`python3.11`，最后才校验 `python3`。所有项目脚本、测试和检查必须在沙箱外执行；沙箱拒绝不能当成远端服务故障处理。

## 3. 默认流程概览

```text
归档 current
  → arXiv + HuggingFace 代理抓取
  → 博客已发布去重
  → 高召回关键词预筛
  → LLM 逐篇筛选
  → 多阶段全文分析
  → 类型感知评分审计
  → API Reader v3 长文、v4 图表来源核验与官方插图
  → generate
  → review
  → push + 远端 OID
  → 人工核验部署与网页
  → TOP 10 长图 + 汇总封面
  → digest:status
```

### 3.1 抓取与筛选完整性

`scripts/full-fetch.js` 先按日期归档当前数据，再抓取 7 个 arXiv 类别与 HuggingFace Papers。每个必需来源都须有完整检查点、候选数量和稳定内容 SHA，缺少其中任何一项都不能算抓取完成。arXiv/HF 均强制使用项目代理。

`raw-candidates.json` 保存合并且博客去重后的全集。关键词预筛只对摘要完整且明显未命中音频词族的补充类别判为不相关；`eess.AS` 和 `cs.SD` 这两个核心音频类别（`CORE_AUDIO_CATEGORIES`）、短摘要和词族命中项必须进入 LLM。抓取配置 `scripts/config.js` 的 `priority: 'core'` 还包含 `eess.SP`，那是抓取侧优先级，不豁免关键词预筛。筛选结果只有在 `filter-decisions.json` 完整覆盖 raw，且 `filtered-papers.json` 精确等于相关决定中的论文减去显式排除项时才算完成。

### 3.2 全文分析与 Reader

每篇论文优先使用可验证的 arXiv HTML，获取失败时按代码允许的条件改用 PDF。结构不足、错误页和只有摘要的页面不能当成全文。来源 SHA 变化后，主分析及其下游结果均须重新生成。

默认 API 日更在筛选完成后先封存本次来源：每个入选 arXiv 重新请求官方 HTML 文本和 PDF，通过原子写入保存
`data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/source.txt`、`source.pdf`、
`source-runtime.json` 与 `source-manifest.json`。深度分析与 Reader 只能使用这一组封存文件。同一天、同一入选集续跑时读取已封存的文本和 PDF，不改走旧的仅文本抓取流程，也不使用 `data/current` 图片缓存。图像仅在系统临时目录为当前模型调用准备，用完清理；运行目录不保存像素、base64、缓存路径或图片文件。单张 Figure 若超过响应上限可跳过该图并继续同篇，其余图片至少成功一张时不会因个别下载失败整篇报废；模型服务明确拒绝损坏或不兼容的 PNG 时，会转为白底 RGB JPEG 后重试。

默认阶段包括：主分析、开源扫描、Demo 扫描、审校、表格/方法/结构修复、分类核验、核心摘要核验、评分审计、API Reader 和论文图准备。各阶段记录并验证输入、模型、协议、提示词、温度、预算和输出 SHA；其中任何一项变化，只重跑受影响阶段及其下游。

主分析正文保留 13 个固定中文一级标题供机器解析。真正发布给读者的是 `beginner-researcher-v3`：

- 12–18 个小节，先解释必要的概念，再讲依赖这些概念的方法和机制；
- 5000–18000 中文字；
- 4–10 组术语组合桥；
- 用前后段落说明数据协议、主结果、消融/失败、训练或部署成本的表格；
- 官方插图依次呈现导读、看图路径、原图、图注和解释，相关段落须相邻；
- Markdown 表的每个单元格对应原表 DOM 单元格或逐字原文引文，展示公式由结构化原始 TeX 确定性注入；
- 作者姓名与机构逐项核验来源；开源资源逐项绑定原文或已验证 Demo、重定向终点与可达状态，暂时不可达不得冒充可用；
- 初学研究者能分清论文事实、有限解释和未验证推测。

### 3.3 评分

评分八维为：创新性 2、技术严谨性 1.5、实验充分性 1.5、清晰度 1、影响力 1.5、开源 1.5、可复现性 0.5、工程/实践价值 1.5。分项总和最大 11，发布总分由代码重算并封顶 10。

文档类型决定适用证据，不改变权重。一个缺陷只归一个主要维度：产物缺失归开源，配置缺失归可复现性，支撑声明的实验不足归实验充分性，表达问题归清晰度，真实逻辑/推导错误才归技术严谨性。评分审计必须引用证据记录，并保存 `evidenceProfile` 和代码计算的评分上限。评分变化超过 0.5 分时独立复审；前两次差异超过 0.3 分可再审一次，仅接受三次中差异不超过 0.3 分的一对。多次审计证明必须绑定最终采用的审计 SHA 和分数，并重算共识差值。

## 4. API、代理、并发和上下文

### 4.1 协议路由

| 优先条件 | 协议 | URL |
|---|---|---|
| DeepSeek 域名或模型 | OpenAI Chat | `/v1/chat/completions` |
| `muse-spark-*` 模型或显式 `/responses` 端点 | OpenAI Responses | 完整端点原样使用；基础端点追加 `/responses` |
| `token-plan` + MiMo | Anthropic | `/anthropic/v1/messages` |
| Kimi coding | Anthropic | `/coding/v1/messages` |
| 其他 `/anthropic` | Anthropic | `{base}/messages` |
| 其他（含当前推荐的 `mimo-v2.6-flash`） | OpenAI Chat | `/v1/chat/completions` |

所有 Node LLM 调用经 `requestLlmJson()`。`muse-spark-*` 每次请求都创建独立的 HTTP CONNECT 连接对象，结束后销毁；这里的 `agent` 指连接对象，并非分析子代理。其他模型默认以 `agent:false` 直连，当前推荐的 `mimo-v2.6-flash` 不含 `muse-spark-` 前缀，走直连。Python 发布请求遵守同样的 Muse 代理规则。

配置 `PAPER_ANALYZER_FALLBACK_API_KEYS` 后启用 OpenCode Go 备用账号。初始使用主密钥；明确 HTTP 429 `GoUsageLimitError` 或 HTTP 401 `Insufficient balance` 时，记录账号冷却并按配置顺序向后切换，不返回前面已冷却的账号。普通认证 401 不切号，而是上报运行级错误；所有后续账号不可用时停止派发并保留断点。

`PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY` 指定排在普通备用账号之后的账号，也支持逗号分隔的第三、第四等顺位。成功账号跨请求、跨 Node/Python、跨日期保持使用，旧账号冷却到期也不自动切回。普通 429、5xx、网络或代理错误、Responses 输出截断和内容校验失败都不切号。

状态保存在 `data/runtime/llm-account-pool.json`，不含原始密钥，但包含稳定凭据指纹，须以 `0600` 权限保护；损坏时停止。在请求中附加认证信息前，核验请求 URL 与 endpoint/model 推导的 API URL 精确相同。主副模型只有属于同一规范 OpenCode Go 服务时才可共享账号池，不同服务必须使用独立密钥（`PAPER_ANALYZER_SECONDARY_API_KEY`；副模型自己的多账号池为 `PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS`）。

### 4.2 默认预算

| 参数 | 默认 |
|---|---:|
| `PD_ANALYSIS_CONCURRENCY` | 3 |
| `PD_ANALYSIS_MAX_RETRIES` | 2 |
| `PD_ANALYSIS_API_MAX_RETRIES` | 3 |
| `PD_ANALYSIS_API_MAX_TOKENS` | 64000 |
| `PD_ANALYSIS_API_MAX_RESPONSE_BYTES` | 16777216（16 MiB） |
| `PD_ANALYSIS_REPAIR_MAX_TOKENS` | 16000 |
| `PD_ANALYSIS_FULL_TEXT_MAX_CHARS` | 200000 |
| `PD_API_READER_MAX_TOKENS` | 48000 |
| `PD_API_READER_REPAIR_MAX_TOKENS` | 8000；仅受限局部补丁 |
| `PD_API_READER_EVIDENCE_MAX_CHARS` | 180000 |
| `PD_API_READER_CONTEXT_MAX_CHARS` | 240000 |
| `PD_API_READER_CONCURRENCY` | 5，限制 1–5 |
| `PD_BLOG_REVIEW_CONCURRENCY` | 5，限制 1–5 |

筛选和整篇分析都按各自配置并发；`muse-spark-*` 每个请求有独立隧道，当前推荐的 `mimo-v2.6-flash` 直连。账号池状态更新仍通过短时间持锁串行完成。Responses 仅在 `PD_OPENAI_RESPONSES_STREAM=1` 时使用 SSE，Chat Completions 请求不受该变量影响。返回 `incomplete/max_output_tokens` 时不得接受半截 JSON。

## 5. 权威数据与恢复

### 5.1 current 文件

| 文件 | 含义 |
|---|---|
| `papers.json` | 不随每日批次移走的去重库和运行状态 |
| `fetch-checkpoint.json` | 每个抓取来源的恢复证明 |
| `raw-candidates.json` | 筛选全集 |
| `filter-decisions.json` | 逐篇筛选决定与缓存 |
| `filtered-papers.json` | 正式入选集 |
| `deep-analysis-result.json` | 正式分析结果、阶段检查点与发布资格证明 |
| `blog-generation-manifest-*.json` | 生成页面集合和 SHA |
| `blog-review-receipt-*.json` | 审查结果、Git 基线与远端发布证明 |
| `visual-summary-manifests/*.json` | TOP 10 长图任务 |
| `digest-cover-manifests/*.json` | 汇总封面任务 |

`data/archive/<date>/` 保存日期快照，不能仅因文件存在就替代当前数据。使用历史状态前，须核验各文件的日期、候选、筛选决定和论文集合相互对应。

### 5.2 恢复命令

```bash
# 同日完整续跑
npm run digest:prepare -- YYYY-MM-DD

# 从指定编排阶段恢复
./run-daily-digest.sh YYYY-MM-DD --from review

# 只续分析
npm run deep -- --date YYYY-MM-DD

# 只续正式分析结果中未完成的论文
npm run batch

# 只归档并停用当前未完成论文的失败 Reader 候选，然后续跑
npm run batch -- --retry-failed-readers

# 强制重分析
npm run reanalyze -- --concurrency 5

# 批量刷新评分与 Reader
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader

# 只读数据验证与最终状态
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

从 fetch 开始的日期必须是北京时间当天。历史批次只使用已有受控数据，从脚本允许的阶段续跑。不要手改检查点伪造完成状态。

`deep`、`batch`、`reanalyze` 与 `api:reader:refresh` 只恢复当前默认 API 日更的封存来源。它们读取 `deep-analysis-result.json.dailyFreshSourceRun` 指定的论文集合和每篇 PDF、TXT、来源元数据与清单，不重新抓取，也不使用旧文本或缓存。文件缺少、损坏，或与正式分析结果的 `batchDate`、论文集合不一致时，命令会在任何 LLM 或图片请求前停止。目标仍为北京时间当天时，重新执行 `npm run digest:prepare -- YYYY-MM-DD` 建立来源文件；历史日期保留失败记录，按历史维护流程处理。Reader 图片仅在本次调用的系统临时目录中准备。

`batch --retry-failed-readers` 只归档并停用当前未完成论文的失败 Reader 候选。`reanalyze` 则归档并停用全部旧失败候选，并显式清空 Reader 和图片补充状态，确保旧成功或旧失败记录不会跳过强制全量重分析。

## 6. 博客发布事务

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

`generate` 生成并安装本批页面，保存页面清单；`review` 只读审查最终文件，执行确定性、LLM、图片与 Hugo 检查，逐页保存检查点，再生成审查凭证；`push` 只提交凭证允许的精确 Git 差异，并在推送后验证远端 `main` OID。

远端 OID 和 `digest:status` 中的 `remoteOidVerified` 只证明 Git 提交已到远端。宣告上线或完成前，须另行确认对应发布提交（或保留本批已审页面字节的后续提交）的 GitHub Pages workflow 已成功 build/deploy，再逐页检查目标日期汇总页和单篇页面的 HTTP 200、正式地址与标题，并保存核验记录。部署失败时读取日志、修复并等待重新部署成功。状态命令尚未自动执行这些上线检查。

标签迁移期间，新发布页面继续写 Hugo 兼容的扁平 `tags`，同时必须保存并核验 `paper-tag-flat-tags-v2`、当前词表的版本与 SHA、逐标签 `{id, facet, label}`、`paper_digest_primary_task` 和 `paper_digest_primary_method`。旧页面与旧标签 URL 保持不变。汇总“热门方向”只按显式主任务统计，网页标签总表须说明其中包含新旧两种标签。

逐页审查通过记录按“相对路径 + 内容 SHA”持久复用，只有该文件的内容 SHA 变化才重审。发布器代码变化时仍要重新渲染页面，以发现真实字节变化。新的页面清单、发布资格证明、模型、发布器代码、审查协议指纹或 Hugo 运行时变化，只要求重跑当前批次的确定性/Hugo 检查并生成新的审查凭证，不得让字节未变的文件重审。博客基线、远端名称、推送 URL 身份或凭证与当前批次不符时，仍须阻断推送。审查不能修改已审页面；修正须回到生成阶段。

单篇 `--include-id` 与排除 `--exclude-id` 属于显式维护功能，参数必须在适用阶段保持一致；单篇发布不能作为整批发布或整批视觉完成的依据。旧 `sealed_tutorial_preview` 仅保留材料只读检查，新生成、审查声明与推送均已停用。

## 历史直接重写

全历史任务在当前 `audio-paper-digest` 工作区执行，运行资料保存在本项目 `data/runtime/`；不再使用旧历史工作区。当前路线 `direct-local-first` 先把来源和私有产物准备好，再独立发布：

```text
保留的会议元数据/PDF + 冻结的历史 arXiv 链接
  → direct-inputs → conference-projections → direct-plan
  → direct-scheduler → direct-run → 私有页面 / direct-aggregate
  → history:direct-publication: plan → generate → review → publish → status
```

每轮 arXiv 重写都会重新获取官方文本、PDF、运行元数据和清单，保存在 `data/runtime/fetched-arxiv-sources/` 下。保留的 arXiv 文本、PDF、图片、旧分析和旧博客正文都不进入写作输入。会议论文只有在 SHA 核验通过后，才使用保留的元数据和 PDF。同一篇论文只分析一次，再据此生成对应的全部历史页面。

备用 `history:arxiv-batch` 只接收新一轮 arXiv 获取失败后生成的命名且不可变交接文件。`history:crosswalk` 仍支持旧来源对照记录的显式维护，须经过来源授权和 CAS 检查。保留的会议来源不可用或损坏时，直接路线只在该论文上停止，不进入 arXiv 备用路线，也不影响队列中其余论文。独立发布入口要求来源和页面覆盖完整、审查通过、Git 基线与远端检查有效。`activate --apply` 已被禁用；激活、提交、推送和 OID 核验统一由 `publish --apply` 在共享博客锁内完成。入口存在不代表某次全历史重写或发布已经完成。参数细节见[历史重写](docs/history-rewrite.md)与[独立历史发布](docs/history-direct-publication.md)。

ICML/OpenReview 的替代 PDF 默认一律拒绝。唯一经用户授权的跨标题例外是 `conference:icml:2026:openreview-forum-id:n1mAjfRDZ6`：代码白名单必须核对它的 poster/forum、固定 SSRN 标题、作者、DOI、PDF、获取凭证和来源 SHA。浏览器下载只能通过 `--import-file` 导入，并记录 `networkResponseObserved: false`。计划、模型输入和最终页面都必须写明这不是 camera-ready，该例外不得推广到其他论文。

## 7. 发布后视觉

远端 OID 验证后，`push-blog.py` 规划 TOP 10 论文长图和一张汇总封面。项目脚本只管理图片任务、参考文件和状态，实际绘图只能由 Codex 内置 `image_gen` 完成。

```bash
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

采用 `ephemeral-no-persisted-figure-assets-v1` 的 Reader 页面保留已记录且核验通过的 arXiv 官方 HTTPS 图片 URL，供读者查看，不复制或缓存图片字节。`visual:prepare` 处理旧版任务清单时核验 `.bin` 缓存，输出带真实扩展名的绝对路径。当前日更则核验官方 URL、图编号、DOM SHA、像素 SHA 和 MIME，返回空的 `referencedImagePaths`；生图只使用已核验的 Reader 文本，不退回旧缓存。

只将 `visual:prepare` 输出的绝对 `referencedImagePaths` 交给工具。登记前逐图检查标题、中文、结构关系、指标方向、数字与排行榜；`record` 必须带 `--qa-attested true`。只有用户明确取消生图时，才使用 `digest:waive-visuals` 记录与当前发布和图片任务清单绑定的豁免，不能把待完成任务改成已完成。

数据、审查、远端发布、部署及网页核验都必须通过。长图和封面须已完成；只有用户明确取消视觉并记录仍有效的豁免时，才可省略图片。满足这些条件后，整批才算完成。最后一次推送或图片登记后重新运行 `digest:status`，确认数据与图片状态；该报告不能替代人工上线核验。

## 8. 维护与验证

```bash
npm run verify
# 仅 CI/干净 checkout 显式允许空数据：npm run verify -- --allow-empty
# 快速语法+数据子集（不是完整验收）：npm run verify -- --quick
```

完整验证使用固定 Hugo 0.160.1，并运行全部 JS 测试、默认/Manual Python 测试、全仓语法检查和只读数据验证。
Reader 局部修复、三种表格输入模式与实际请求用量见 [reader-writing](docs/reader-writing.md)。

- 新分析入口复用 `analysis-engine.js`，新 LLM 调用复用公共路由和请求封装。
- Node/Python 路径进入集中配置；写 JSON 使用原子写和跨进程锁。
- 提示词文件的第一个围栏代码块是运行时读取的正文；修改结构化输出时同步解析器、校验器、测试和指纹。
- 日志使用毫秒级北京时间、`0600` 权限并脱敏；不得记录密钥、认证头、Cookie 或 URL userinfo。
- `data/`、`logs/`、`.env`、缓存和运行产物不得提交。
- Git 提交信息用具体中文说明原因、范围和影响。
- 诊断、命令和字段细节见 [docs/README.md](docs/README.md) 中对应的文档，不在本文件复制 Manual 或渠道内部协议。
