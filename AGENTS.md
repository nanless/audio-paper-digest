# AGENTS.md

## 这份文件给谁

给第一次进入仓库、需要运行或修改论文速递的 Agent。它只保留不看代码最容易遗漏的强约束；完整操作说明见 [SKILL.md](SKILL.md)，按任务查文档见 [docs/README.md](docs/README.md)，代码入口见 [scripts/README.md](scripts/README.md)。

## 默认目标与最短路径

### 工作区分工（必须先核对 `pwd`）

- `/Users/francis7999/code/github_repos/audio-paper-digest` 专用于新论文筛选、日更博客生成、review 和推送；不在这个工作区运行长时间全历史重写。
- `/Users/francis7999/code/github_repos/audio-paper-digest-rewrite-all` 专用于全历史单篇、每日汇总和会议汇总的来源闭合、重写、重标、staging 与最终历史发布。
- 两个工作区不得同时执行博客 generate/review/push 或修改同一远端 `main`。历史工作区真正发布前，必须停止日更发布，同步代码仓库和博客仓库的最新远端 `main`，并重新生成绑定最新基线的发布证明。
- 长时间历史运行只保存在 `audio-paper-digest-rewrite-all/data/runtime/`；不把 checkpoint 反向复制回日更工作区，不手工合并两边的 runtime JSON。

用户说“运行/进行 YYYY-MM-DD 论文速递”时，默认且唯一隐含路线是完整 LLM/API 日更：

```bash
npm run digest:prepare -- YYYY-MM-DD
# digest:api 是完全等价的显式别名
```

这项请求已经授权：联网抓取 → 关键词预筛 → LLM 筛选 → 多阶段全文分析与评分 → API Reader 初学研究者长文 → 博客 generate → review → push 与远端 OID 验证 → 发布后视觉任务 → 最终状态验收。不要在分析、review 或 push 后提前结束，也不要再次询问是否发布博客。

只有用户明确说“Manual/人工流程”时才运行 `npm run digest:manual -- YYYY-MM-DD`。进入前完整阅读 [manual/README.md](manual/README.md)；API、网络或配额失败绝不自动切换 Manual。微信、飞书、小红书不属于默认日更。

## 运行前六项检查

0. 先运行 `npm run workspace:role -- status`。原日更目录必须是 `daily`，全历史副本必须是 `history`；marker 缺失或 realpath 不匹配时先停止，只在确认工作区用途后用 `npm run workspace:role -- set daily|history [--force]` 绑定。
1. Node 满足 `>=20.18.1 <21 || >=22.3.0`，依赖已安装。
   默认博客/视觉 Python 入口还要求 Python 3.11+ 与 OpenSSL；`scripts/python-runtime.sh` 优先使用项目 `.venv`，再选择并校验 `python3.11` / `python3`。
2. 项目根 `.env` 存在，权限由 loader 收紧为 `0600`。
3. `PAPER_ANALYZER_API_KEY/MODEL/ENDPOINT` 完整；当前默认文档配置是 OpenCode Go `muse-spark-1.3-contributor`。可选 `PAPER_ANALYZER_FALLBACK_API_KEYS` 只提供同一路由的长期 sticky 备用账号，不能替代副模型变量。
4. `HTTPS_PROXY` 或 `HTTP_PROXY` 是项目 `.env` 内的 HTTP CONNECT 地址；Muse 与 arXiv 缺代理立即失败。
5. `PAPER_DIGEST_BLOG_REPO` 指向真实 Hugo 仓库，工作区没有与目标日期重叠的人工修改。

所有项目脚本、测试、语法检查和数据校验必须在沙箱外执行。脚本会在业务逻辑、日志、网络和写入前拒绝可靠的 `CODEX_SANDBOX` 标志；生产 npm 入口和直接 Node/Python 入口还会重放工作区角色。不得绕过或伪造结果。

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

文档与实现冲突时，先按当前 fail-closed 实现处理，再在同一变更中修正文档。

## 默认 API 数据链

`scripts/full-fetch.js` 负责归档、博客去重、arXiv/HuggingFace 抓取、筛选、论文库更新、深度分析和逐篇持久化。关键状态位于 `data/current/`：

- `papers.json`：跨运行累积的去重库，永不随日批次移走。
- `fetch-checkpoint.json`：逐来源候选数量与内容 SHA。
- `raw-candidates.json`：当日完整候选。
- `filter-decisions.json`：逐篇筛选决定、理由、响应和输入指纹。
- `filtered-papers.json`：当日正式入选集合。
- `deep-analysis-result.json`：canonical 分析、逐阶段 checkpoint 和 production proof。

默认 API 日更在筛选完成后、进入深度分析前，必须为每个入选 arXiv ID 重新拉取官方 HTML 文本与 PDF，并封存为
`data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/` 下的
`source.txt`、`source.pdf`、`source-runtime.json` 与 `source-manifest.json`。分析只能读取该 sealed bundle；图像只可在 OS 临时目录按当前调用物化，禁止写入 `data/current` 或 runtime 图片缓存。

完整性不是“文件存在”：raw、decision、filtered、deep 的日期、来源、候选指纹和论文集合必须闭合。运行 `npm run validate:data` 做只读验证；干净 checkout 才可显式加 `--allow-empty`。

## 模型、代理、并发与预算

默认 Muse 精确模型走 OpenAI Responses，`/v1` 转为 `/v1/responses`。所有 Node LLM 请求必须经 `requestLlmJson()`；Python 发布请求必须经 `call_publish_llm_api()`。

- Muse：强制项目 HTTP CONNECT，一次请求一个 one-shot agent，请求后销毁，禁止静默直连。
- OpenCode Go 账号池：成功时持续使用当前账号；仅明确 `GoUsageLimitError` 才在同一逻辑请求内切换并持久化冷却。普通 429、5xx、网络错误、输出截断和正文门禁不得切号；切换后不自动切回。
- 其他 LLM：默认 `agent:false` 直连，避免继承代理污染 MiMo/Kimi。
- arXiv 元数据、HTML、PDF、图片：强制项目 HTTP CONNECT。
- HuggingFace curl：继承 HTTP(S) 代理，可额外使用 `ALL_PROXY` SOCKS。
- 外部图片/Demo：仅 HTTPS；逐跳拒绝私网/保留地址并固定已校验公网 IP，防止 DNS 重绑定。

| 能力 | 默认值 | 覆写 |
|---|---:|---|
| 整篇分析并发 | 3 | `PD_ANALYSIS_CONCURRENCY` |
| 筛选配置批次 | 5；Muse 同样使用配置值 | `PD_FILTER_BATCH_SIZE` |
| 整篇重试 / 单阶段尝试 | 2 / 3 | `PD_ANALYSIS_MAX_RETRIES` / `PD_ANALYSIS_API_MAX_RETRIES` |
| 主分析 / 局部修复输出 | 64000 / 16000 tokens | `PD_ANALYSIS_API_MAX_TOKENS` / `PD_ANALYSIS_REPAIR_MAX_TOKENS` |
| 单次分析 LLM 响应 | 16 MiB | `PD_ANALYSIS_API_MAX_RESPONSE_BYTES` |
| API Reader 输出 | 48000 tokens | `PD_API_READER_MAX_TOKENS` |
| Reader 证据 / 总上下文 | 180000 / 240000 字符 | 对应 `PD_API_READER_*_MAX_CHARS` |
| Reader 重阶段并发 | 5，范围 1–5 | `PD_API_READER_CONCURRENCY` |
| 独立博客页 review 并发 | 5，范围 1–5 | `PD_BLOG_REVIEW_CONCURRENCY` |

主分析最多使用 200000 字符并跨全文均衡取样；后处理只接收任务相关证据。预算和证据选择版本进入阶段指纹。OpenAI Responses 只有 `PD_OPENAI_RESPONSES_STREAM=1` 时启用 SSE；`incomplete/max_output_tokens` 必须记为截断失败，不得接受半截 JSON。

## 恢复原则

- 普通续跑：重新运行同一入口；checkpoint 指纹决定从哪个阶段继续。
- `npm run deep`、`npm run batch`、`npm run reanalyze` 和 `npm run api:reader:refresh` 都是**日更 sealed source 恢复入口**：只重放当前 canonical 的 `dailyFreshSourceRun`，要求 batchDate、完整论文集合及每篇 `source.txt`、`source.pdf`、runtime/manifest 全部精确闭合。它们不抓取、不补建 source run、不读取 legacy text/cache；未绑定当前 generation 的旧成功记录必须重分析，Reader refresh 则直接拒绝。缺失或漂移时在模型/图片请求前失败。此时重新运行 `npm run digest:prepare -- YYYY-MM-DD`。
- 只续深度分析：`npm run deep -- --date YYYY-MM-DD`。
- 强制全量重分析：`npm run reanalyze -- --concurrency N`。
- 刷新 Reader/评分：`npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader`；Reader 图像仍只在当前调用的 OS 临时目录物化。
- 历史日期不能从 fetch 开始；只可从已有安全阶段运行 `./run-daily-digest.sh DATE --from generate|review|push|visual` 等代码允许的阶段。
- 失败记录必须保留 `analysisManifest`、checkpoint 和恢复图片清单。旧成功正文可保留，但最新失败必须强制后续重试；成功后才清除失败标记。
- 同篇分析必须持有规范化 arXiv ID 锁，并在锁内重读、合并、递增 generation，禁止用锁外陈旧对象覆盖 canonical。
- ICML/OpenReview 替代 PDF 默认失败关闭。唯一经用户授权的跨标题预印本例外是
  `conference:icml:2026:openreview-forum-id:n1mAjfRDZ6`：必须由代码白名单 sealer 绑定 poster/forum、
  固定 SSRN 标题、作者、DOI、PDF/receipt/source SHA；浏览器下载只能经 `--import-file` 导入并记录
  `networkResponseObserved: false`。plan、模型输入和最终页面必须显式显示非 camera-ready 提示；不得推广到其他论文。

## 内容与评分门禁

默认 API canonical 的 13 个一级标题是解析锚点；最终博客正文来自 `beginner-researcher-v3` API Reader，并以正交的 `api-reader-source-bindings-v4` 绑定表格与公式来源：

- 12–18 节、5000–18000 中文字、4–10 组术语桥。
- 术语首次白话解释；组合机制必须说明分工、搭配原因和新增作用。
- 表格必须与前后论证闭环，原文证据充足时覆盖数据协议、主结果、消融/失败条件和训练/部署成本。
- 每个表格单元格必须重放到原表 DOM cell，或由全文逐字 quote 覆盖全部数字与单位；展示公式只可由结构化原始 TeX 注入。
- 作者姓名与机构逐项绑定 HTML DOM、论文 metadata 或显式不可得状态；资源链接逐项绑定原文/Demo 证据、重定向终点与可达状态，只有 `available` 可支撑“已开源/可用”声明。
- 汇总页 `reader-facing-v3` 中排行榜及中英文题目都指向独立博客；标签/评分不重复，排名、文档类型和 arXiv 位于评分后、作者机构前；汇总页和单篇页的可见 HTTPS URL 必须可点击。
- 新 production 页面在 Hugo `tags` 扁平字段中只写 current taxonomy 的 active 中文首选标签，同时签发 `paper-taxonomy-flat-tags-compat-v1`、registry SHA、逐标签 concept/facet、显式主任务与主方法；旧页面和旧标签 URL 不批量改写。兼容期汇总“热门方向”只统计主任务，标签页必须明确标示新旧混合，不能把扁平计数冒充九分面统计。
- Figure 必须形成“导读 → 看图路径 → 原图 → 图注 → 解释”；未传入像素不得猜坐标轴、曲线、颜色或模块。
- 评分使用八维、类型感知、单一缺陷单一主维度原则；代码重算总分并封顶 10。缺失证据不得写成技术错误。
- 摘要级分析默认不可发布；只有显式 `allowAbstractAnalysisPublish: true` 才允许并显示降级提示。

## 博客三阶段与远端证明

严格顺序：

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

generate 只生成并签发 schema v3 generation manifest；review 只读审查最终字节并绑定逐页 SHA、协议、Git 基线和 Hugo gate；push 只提交 receipt 精确允许的 delta，推送后验证远端 `main` OID。发布器代码变化仍会使 generate 重新渲染，以便真实字节变化被发现；但逐页通过证据永久只按“相对路径 + 页面内容 SHA”复用。generation manifest 元数据、模型、发布器代码、review 协议指纹或 Hugo 运行时变化不得让最终字节未变的文件重审；它们只要求重跑当前批次 gate 并重签 receipt。只有页面内容 SHA 变化才重审该文件。基线、remote 身份或 receipt 与当前批次不匹配仍会阻断 push。review worker 不得原地修改已审字节；修正建议返回生成/修复阶段。

## 发布后视觉与完成定义

push 远端验证后才可规划视觉任务。TOP 10 论文各一张长图，另有一张汇总封面；实际生成只能由 Codex 内置 `image_gen` 完成，项目脚本不得调用图像 API。

调用生图前运行 `npm run visual:prepare -- --date DATE`，只把输出的绝对 `referencedImagePaths` 交给工具。逐图目检标题、中文、箭头、指标方向、数字和排行榜后，才可用对应 `record --qa-attested true` 登记。最终重新运行：

```bash
npm run digest:status -- --date YYYY-MM-DD
```

只有数据、review、远端发布、论文视觉和封面全部 complete，或用户明确签发仍有效的视觉 waiver，整批才完成。状态报告是读取时快照；任何后续 push/record 后必须重跑。

## 修改与验证

- 文件编辑使用可恢复方式，保留用户无关改动；禁止未授权 `git reset --hard`、强推或批量删除。
- Prompt 的第一个 fenced block 是 `loadPrompt()` 实际读取内容；修改后检查占位符、解析器、SHA 和阶段指纹。
- 新 LLM 调用复用公共路由/请求封装；新分析入口复用 `analysis-engine.js`；新路径进入集中配置。
- CI 运行 `npm test`、`npm run validate:data -- --allow-empty`、默认与 Manual JS/Python 检查及全仓 shell 语法检查。
- 提交信息使用具体中文，说明原因、范围与影响；提交前确认 `data/`、`logs/`、`.env`、缓存和密钥未被跟踪。
