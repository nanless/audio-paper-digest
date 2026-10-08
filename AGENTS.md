# AGENTS.md

## 这份文件给谁

本文供第一次进入仓库、需要运行或修改论文速递的 Agent 使用，列出容易遗漏的操作限制。完整操作说明见 [SKILL.md](SKILL.md)，按任务查文档见 [docs/README.md](docs/README.md)，代码入口见 [scripts/README.md](scripts/README.md)。

## 默认目标与最短路径

### 工作区分工（必须先核对 `pwd`）

- `/Users/francis7999/code/github_repos/audio-paper-digest` 专用于新论文筛选、日更博客生成、审查和推送；不在这个工作区运行长时间全历史重写。
- `/Users/francis7999/code/github_repos/audio-paper-digest-rewrite-all` 专用于全历史论文页、每日汇总和会议汇总的来源核验、重写、重新分类、私有页面生成和历史发布。
- 两个工作区不得同时生成、审查、推送博客，或修改同一远端 `main`。历史工作区发布前，必须停止日更发布，同步代码仓库和博客仓库的最新远端 `main`，再基于最新 Git 基线重新生成发布凭证。
- 长期历史任务的运行数据只保存在 `audio-paper-digest-rewrite-all/data/runtime/`；不把检查点复制回日更工作区，也不手工合并两边的运行数据 JSON。

用户说“运行/进行 YYYY-MM-DD 论文速递”时，默认执行完整 LLM/API 日更：

```bash
npm run digest:prepare -- YYYY-MM-DD
# digest:api 是完全等价的显式别名
```

这项请求已授权联网抓取、关键词预筛、LLM 筛选、多阶段全文分析与评分、面向初学研究者的 API Reader 长文、博客生成与审查、推送与远端 OID 验证、发布后图片任务和最终验收。完成 Git 发布后还须核验部署及网页。不要在分析、审查或推送后提前结束，也不要再次询问是否发布博客。

只有用户明确说“Manual/人工流程”时才运行 `npm run digest:manual -- YYYY-MM-DD`。进入前完整阅读 [manual/README.md](manual/README.md)；API、网络或配额失败绝不自动切换 Manual。微信、飞书、小红书不属于默认日更。

## 运行前六项检查

0. 先运行 `npm run workspace:role -- status`。原日更目录必须是 `daily`，全历史副本必须是 `history`；角色标记缺失或真实路径不匹配时先停止，确认工作区用途后才用 `npm run workspace:role -- set daily|history [--force]` 绑定。
1. Node 满足 `>=20.18.1 <21 || >=22.3.0`，依赖已安装。
   默认博客/视觉 Python 入口还要求 Python 3.11+ 与 OpenSSL；`scripts/python-runtime.sh` 优先使用项目 `.venv`，再选择并校验 `python3.11` / `python3`。
2. 项目根 `.env` 存在，加载器会将文件权限收紧为 `0600`。
3. `PAPER_ANALYZER_API_KEY/MODEL/ENDPOINT` 完整；仓库文档当前推荐 OpenCode Go `mimo-v2.6-flash`，实际模型仍由项目配置指定。可选 `PAPER_ANALYZER_FALLBACK_API_KEYS` 为同一路由提供备用账号；切换后持续使用成功账号，不能代替副模型配置。
4. `HTTPS_PROXY` 或 `HTTP_PROXY` 是项目 `.env` 内的 HTTP CONNECT 地址；`muse-spark-*` 模型与 arXiv 缺代理立即失败，当前推荐的 `mimo-v2.6-flash` 不含该前缀，走直连。
5. `PAPER_DIGEST_BLOG_REPO` 指向真实 Hugo 仓库，工作区没有与目标日期重叠的人工修改。

所有项目脚本、测试、语法检查和数据校验必须在沙箱外执行。脚本会在业务逻辑、日志、网络和写入前拒绝可靠的 `CODEX_SANDBOX` 标志；生产 npm 入口和直接 Node/Python 入口还会核验工作区角色。不得绕过检查或伪造结果。

## 权威来源

| 问题 | 权威来源 |
|---|---|
| npm 命令是否存在 | `package.json.scripts` |
| Node 参数与 current 路径 | `scripts/config.js` |
| Python 发布路径 | `scripts/path_config.py` |
| 环境隔离 | `scripts/env-loader.js`、`scripts/project_env.py` |
| API 路由与 Node 请求 | `scripts/utils.js` |
| 发布 LLM 请求 | `scripts/publish_common.py` |
| 默认 API 脚本职责 | [scripts/README.md](scripts/README.md) |
| Manual 协议 | [manual/README.md](manual/README.md) |

文档与实现冲突时，先遵守当前实现；检查未通过时停止，并在同一变更中修正文档。

## 默认 API 数据链

`scripts/full-fetch.js` 负责归档、博客去重、arXiv/HuggingFace 抓取、筛选、论文库更新、深度分析和逐篇保存结果。关键状态位于 `data/current/`：

- `papers.json`：跨运行累积的去重库，永不随日批次移走。
- `fetch-checkpoint.json`：逐来源候选数量与内容 SHA。
- `raw-candidates.json`：当日完整候选。
- `filter-decisions.json`：逐篇筛选决定、理由、响应和输入指纹。
- `filtered-papers.json`：当日正式入选集合。
- `deep-analysis-result.json`：正式分析结果、逐阶段检查点和发布资格证明。

默认 API 日更在筛选完成后、进入深度分析前，必须为每个入选 arXiv ID 重新拉取官方 HTML 文本与 PDF，并封存为
`data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/` 下的
`source.txt`、`source.pdf`、`source-runtime.json` 与 `source-manifest.json`。分析只能读取这组封存文件。模型所需图片只可在当前调用的系统临时目录中准备，禁止写入 `data/current` 或运行目录的图片缓存。

检查完整性时，除了文件存在，还须确认候选、筛选决定、入选集和分析结果的日期、来源、候选指纹及论文集合相互对应。运行 `npm run validate:data` 做只读验证；只有干净检出的仓库才可显式加 `--allow-empty`。

## 模型、代理、并发与预算

`muse-spark-*` 模型使用 OpenAI Responses，`/v1` 转为 `/v1/responses`；当前推荐的 `mimo-v2.6-flash` 在 OpenCode Go 上走 OpenAI Chat Completions，基础端点原样使用。所有 Node LLM 请求必须经 `requestLlmJson()`；Python 发布请求必须经 `call_publish_llm_api()`。

- Muse：强制使用项目 HTTP CONNECT 代理。每次请求创建独立连接对象，请求结束后销毁；这里的 `agent` 指 HTTP 连接对象。禁止静默改为直连。
- 当前推荐的 `mimo-v2.6-flash` 不含 `muse-spark-` 前缀，按直连处理，不复用上面的代理设置。
- OpenCode Go 账号池：成功时持续使用当前账号。只有明确的 HTTP 429 `GoUsageLimitError` 或 HTTP 401 `Insufficient balance` 才在同一逻辑请求内按配置顺序向后切换，并保存冷却状态；不返回前面已冷却的账号。普通认证 401 会停止本次运行，不切换账号；普通 429、5xx、网络错误、输出截断和正文校验失败也不得切换。全部后续账号不可用时保存断点并停止新请求，避免整批论文反复遭遇同一服务故障。
- 其他 LLM：默认以 `agent:false` 直连，防止误用 Muse 的代理设置影响 MiMo/Kimi。
- arXiv 元数据、HTML、PDF、图片：强制项目 HTTP CONNECT。
- HuggingFace curl：继承 HTTP(S) 代理，可额外使用 `ALL_PROXY` SOCKS。
- 外部图片/Demo：仅允许 HTTPS。每次重定向都拒绝私网和保留地址，并连接已核验的固定公网 IP，防止 DNS 重绑定。

| 能力 | 默认值 | 覆写 |
|---|---:|---|
| 整篇分析并发 | 3 | `PD_ANALYSIS_CONCURRENCY` |
| 筛选配置批次 | 5；主模型同样使用配置值 | `PD_FILTER_BATCH_SIZE` |
| 整篇重试 / 单阶段尝试 | 2 / 3 | `PD_ANALYSIS_MAX_RETRIES` / `PD_ANALYSIS_API_MAX_RETRIES` |
| 主分析 / 局部修复输出 | 64000 / 16000 tokens | `PD_ANALYSIS_API_MAX_TOKENS` / `PD_ANALYSIS_REPAIR_MAX_TOKENS` |
| 单次分析 LLM 响应 | 16 MiB | `PD_ANALYSIS_API_MAX_RESPONSE_BYTES` |
| API Reader 输出 | 48000 tokens | `PD_API_READER_MAX_TOKENS` |
| Reader 证据 / 总上下文 | 180000 / 240000 字符 | 对应 `PD_API_READER_*_MAX_CHARS` |
| Reader 重阶段并发 | 5，范围 1–5 | `PD_API_READER_CONCURRENCY` |
| 独立博客页 review 并发 | 5，范围 1–5 | `PD_BLOG_REVIEW_CONCURRENCY` |

主分析最多使用 200000 字符，并从全文均衡取样；后处理只接收任务相关证据。阶段指纹包含预算和证据选择版本。OpenAI Responses 只有 `PD_OPENAI_RESPONSES_STREAM=1` 时启用 SSE，`PD_OPENAI_RESPONSES_STREAM` 与 `PD_OPENAI_RESPONSES_REASONING_EFFORT` 对 Chat Completions 请求无效；`incomplete/max_output_tokens` 必须记为截断失败，不得接受半截 JSON。

## 恢复原则

- 普通续跑：重新运行同一入口，由检查点指纹决定从哪个阶段继续。
- `npm run deep`、`npm run batch`、`npm run reanalyze` 和 `npm run api:reader:refresh` 都是**日更封存来源的恢复入口**。它们只读取当前正式分析结果的 `dailyFreshSourceRun`，并核验 `batchDate`、完整论文集合及每篇 `source.txt`、`source.pdf`、来源元数据和清单的对应关系。它们不重新抓取、不补建来源文件，也不读取旧文本或缓存。旧成功记录未绑定当前这组封存文件时必须重分析；Reader 刷新会直接拒绝。文件缺失或 SHA 不符时，在模型和图片请求前停止。目标日期仍为北京时间当天时，重新运行 `npm run digest:prepare -- YYYY-MM-DD`；历史日期保留失败记录，按历史维护流程处理，不重新抓取。
- 只续深度分析：`npm run deep -- --date YYYY-MM-DD`。
- 强制全量重分析：`npm run reanalyze -- --concurrency N`。
- 刷新 Reader/评分：`npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader`；Reader 图片仍只在当前调用的系统临时目录中准备。
- 历史日期不能从抓取阶段开始；只可使用已有受控数据，运行 `./run-daily-digest.sh DATE --from generate|review|push|visual` 等代码允许的阶段。
- 失败记录必须保留 `analysisManifest`、检查点和恢复图片清单。旧成功正文可保留，但最新失败必须强制后续重试；成功后才清除失败标记。
- 同篇分析必须持有规范化 arXiv ID 锁，在锁内重读数据、合并结果并递增 `generation`，禁止用锁外读取的陈旧对象覆盖正式分析结果。
- ICML/OpenReview 默认不接受替代 PDF。唯一经用户授权的跨标题预印本例外是
  `conference:icml:2026:openreview-forum-id:n1mAjfRDZ6`：必须由代码白名单中的来源封存器核验 poster/forum、
  固定 SSRN 标题、作者、DOI，以及 PDF、获取凭证和来源 SHA；浏览器下载只能经 `--import-file` 导入并记录
  `networkResponseObserved: false`。计划、模型输入和最终页面必须明确提示非 camera-ready；不得推广到其他论文。

## 内容与评分检查

默认 API 正式分析正文的 13 个一级标题用于机器解析。最终博客正文来自 `beginner-researcher-v3` API Reader；表格与公式的来源另由 `api-reader-source-bindings-v4` 记录和核验：

- 文章包含 12–18 节、5000–18000 中文字和 4–10 组术语组合解释。
- 首次出现的术语须用白话解释；介绍组合机制时须说明各部分的分工、搭配原因和新增作用。
- 表格前须说明比较问题，表格后须解释结果及其限制。原文证据充足时，应覆盖数据协议、主结果、消融/失败条件和训练/部署成本。
- 每个表格单元格必须对应原表 DOM 单元格，或用全文逐字引文覆盖全部数字与单位；展示公式只可由结构化原始 TeX 注入。
- 作者姓名与机构须逐项对应 HTML DOM、论文元数据，或明确的不可得状态；资源链接须逐项对应原文/Demo 证据、重定向终点与可达状态，只有 `available` 可支撑“已开源/可用”声明。
- 汇总页 `reader-facing-v3` 中排行榜及中英文题目都指向独立博客；标签/评分不重复，排名、文档类型和 arXiv 位于评分后、作者机构前；汇总页和单篇页的可见 HTTPS URL 必须可点击。
- 新发布页面在 Hugo `tags` 扁平字段中只写当前词表中有效的中文首选标签。唯一例外是 `CNN/RNN/SFT/CTC/LoRA/Adapter/Transformer/Conformer` 这 8 个既定英文专名，可保留原形，但每个必须配至少一条中文别名。页面还须写入并验证 `paper-tag-flat-tags-v2`、词表 SHA、逐标签 `{id, facet, label}`、显式主任务与主方法。旧页面和旧标签 URL 不批量改写。兼容期汇总“热门方向”只统计主任务；标签页必须明确标示新旧混合，不能把扁平标签计数当作按九个分类维度统计的结果。
- 论文图须依次呈现导读、看图路径、原图、图注和解释；未传入像素不得猜坐标轴、曲线、颜色或模块。
- 评分使用八个维度，按文档类型判断适用证据。每个缺陷只归一个主要维度，代码重算总分并封顶 10。缺失证据不得写成技术错误。
- 摘要级分析默认不可发布；只有显式 `allowAbstractAnalysisPublish: true` 才允许并显示降级提示。

## 博客三阶段与远端证明

严格顺序：

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

`generate` 生成页面和 schema v3 页面清单；`review` 只读审查最终文件，记录逐页 SHA、协议、Git 基线与 Hugo 检查结果；`push` 只提交审查凭证允许的精确差异，并在推送后验证远端 `main` OID。

发布器代码变化时仍须重新生成页面，以发现实际内容变化。逐页审查通过记录按“相对路径 + 页面内容 SHA”永久复用，只有内容 SHA 变化才重审该文件。生成清单元数据、模型、发布器代码、审查协议指纹或 Hugo 运行时变化，只要求重跑当前批次检查并生成新的审查凭证，不能让字节未变的页面重审。Git 基线、远端身份或凭证与当前批次不符时，仍须阻断推送。审查任务不得原地修改已审文件；修正建议须交回生成或修复阶段。

`digest:status` 里的 `remoteOidVerified` 只证明 Git 提交已到远端。对用户宣告博客已上线或任务已完成前，还必须确认 GitHub Pages workflow 的 build/deploy 均成功，并逐页核验目标日期汇总页及已发布单篇的 HTTP 200、正式地址和标题。部署 workflow 必须对应发布提交，或保留该批次已审页面字节的后续提交；保留部署与页面核验记录。部署失败时读取失败日志、修复并继续检查；`digest:status` 显示 complete 也不能代替上线核验。

## 发布后视觉与完成定义

push 远端验证后才可规划视觉任务。TOP 10 论文各一张长图，另有一张汇总封面；实际生成只能由 Codex 内置 `image_gen` 完成，项目脚本不得调用图像 API。

调用生图前运行 `npm run visual:prepare -- --date DATE`，只把输出的绝对 `referencedImagePaths` 交给工具。逐图目检标题、中文、箭头、指标方向、数字和排行榜后，才可用对应 `record --qa-attested true` 登记。最终重新运行：

```bash
npm run digest:status -- --date YYYY-MM-DD
```

只有数据、审查、远端发布、部署及网页核验全部通过，且论文长图与封面均完成，整批才算完成。只有用户明确同意取消视觉，并记录与当前发布绑定且仍有效的豁免时，才可省略视觉。状态报告只反映读取时的状态，尚未自动检查部署和网页；后续任何推送或图片登记后都须重新读取。

## 修改与验证

- 文件编辑使用可恢复方式，保留用户无关改动；禁止未授权 `git reset --hard`、强推或批量删除。
- 提示词文件的第一个围栏代码块是 `loadPrompt()` 实际读取的内容；修改后检查占位符、解析器、SHA 和阶段指纹。
- 新 LLM 调用复用公共路由/请求封装；新分析入口复用 `analysis-engine.js`；新路径进入集中配置。
- CI 运行 `npm test`、`npm run validate:data -- --allow-empty`、默认与 Manual JS/Python 检查及全仓 shell 语法检查。
- 提交信息使用具体中文，说明原因、范围与影响；提交前确认 `data/`、`logs/`、`.env`、缓存和密钥未被跟踪。
