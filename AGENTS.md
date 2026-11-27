# AGENTS.md

## 这份文件给谁

本文面向运行或修改音频研究工作台（Audio Research Workbench）的执行者，只列不可绕过的限制与验收标准。操作顺序见 [SKILL.md](SKILL.md)，文档见 [docs/README.md](docs/README.md)，代码见 [scripts/README.md](scripts/README.md)。

改说明文字须同时遵循[把技术写清楚](skills/clear-technical-writing/SKILL.md)与[项目写作约定](docs/writing-guide.md)，禁借精简文案改变约束。须同时满足的条件不可只选其一；只读核验通过不授予模型请求、写入或发布权限。术语见[写作约定](docs/writing-guide.md#术语先解释再统一称呼)。

## 默认目标与授权

### 持续授权：以效率和效果为准

用户已持续授权：日更、会议与历史博客更新中，凡有助提升效率或成稿效果的必要付费轮次、失败恢复、局部修正、完整重生成与审查，执行者自行安排完成，不逐篇、逐轮或逐阶段再索付费确认，直至用户撤销或另设限制。旧任务“最多 3 轮、6 次响应、2 次全文”仅约束原已登记窗口，非禁止后续付费。

- 先跑完选定全批正常流程，再仅续完整失败集；优先复用已通过阶段，按根因选用正常付费恢复或来源绑定人工修正。
- 依本授权登记必要新窗口、清单或后续轮，保留原稿、来源、全部历史计数与费用，新增消耗另记；不改写旧许可、不删账清零。现有入口不能承接下一窗口时，先修实现并验证后继续。
- 技术窗口、并发与单次上限仅用于调度、恢复与记账，不是总付费授权上限；耗尽时先评根因选有效路径，不在已知无效条件下盲目循环。
- 检查按影响范围安排：纯文档改动不重分析论文；同一真实稿与实现未变时不重复全库检查。来源真实性、事实准确、质量门禁与费用记录不可绕过，付费授权不能将失败写成通过。

本节优先于仓库旧文档中要求逐次批准新增费用的表述。

### 当前工作区与默认日更

- 三条流程统一在 `$HOME/code/github_repos/audio-research-workbench` 执行，开跑前核对 `pwd`；角色保持 `daily`，本机 `.env` 的 `PD_WORKSPACE_ALLOW_CROSS_ROLE=1` 允许历史命令在此运行，反向放行禁止。旧 `audio-paper-digest-rewrite-all` 工作区已废弃，不再进入或复制数据。
- 运行数据存 `data/runtime/`。三流程的生成、审查与推送须错峰，共享博客锁防并发写。历史发布前须同步代码仓与博客仓远端 `main`，以同步后提交重生成审查与发布凭证。
- 用户要求“运行/进行 YYYY-MM-DD 日更（或音频研究日报 / 论文速递）”时，默认执行完整 LLM/API 日更：

```bash
npm run digest:prepare -- YYYY-MM-DD
# digest:api 为等价别名；日更默认不生图，旧 --no-visuals 参数仍兼容
```

- 用户于 2026-11-02 明确要求**以后日更都不再生图**（持续有效）：不生成论文长图与汇总封面，不调生图工具；论文原图获取、核源、展示与审查照常执行。该请求已授权全链分析、发布、远端 OID 核验、不生图登记与上线验收，不得提前结束。
- 整批 Manual 写作及微信、飞书、小红书发布已退役；`manual/` 仅保留旧记录核验与单篇独立人工审查（新独立审查用 `gpt-6.1-sol/high` 并登记真实身份）。

## 运行前六项检查

开跑前先运行 `npm run doctor -- --offline`（探测 arXiv 加 `--network`；doctor 为只读例外，仍拒 `CODEX_SANDBOX`），逐项核对：

0. `npm run workspace:role -- status`：目录角色须为 `daily` 且真实路径匹配；不符先停，确认后再 `set daily|history [--force]`。
1. Node 满足 `>=20.18.1 <21 || >=22.3.0`；Python `3.11+` 与 OpenSSL（`scripts/python-runtime.sh` 优先 `.venv`）。
2. 项目根 `.env` 存在（加载器收紧至 `0600`），`npm run config:check` 无失败。
3. `PAPER_ANALYZER_API_KEY/MODEL/ENDPOINT` 完整；主及启用的副模型均须在 `scripts/lib/env-schema.js` 的 `SUPPORTED_MODELS` 内（2026-11-16 起为 `muse-spark-1.3-contributor`，上限 `xhigh`）。同路由备用账号并入共享池，顺序不代表优先级，不代替副模型配置。
4. `HTTPS_PROXY` 或 `HTTP_PROXY` 为 `.env` 内 HTTP CONNECT 地址；`muse-spark-*` 与 arXiv 缺代理立即失败。
5. `PAPER_DIGEST_BLOG_REPO` 指向真实 Hugo 仓库，无与目标日期重叠的人工修改。

所有脚本、测试、语法与数据校验须在沙箱外执行（拒 `CODEX_SANDBOX`），生产命令经 npm 入口运行，禁止绕过角色守卫或伪造结果。

## 权威来源

| 问题 | 权威来源 |
|---|---|
| npm 命令 | `package.json.scripts` |
| Node / Python 路径与参数 | `config/runtime-paths.json`、`scripts/config.js`、`scripts/path_config.py` |
| 环境隔离与角色 | `config/workspace-roles.json`、`scripts/env-loader.js`、`scripts/project_env.py` |
| LLM 路由与封装 | `scripts/utils.js`、`scripts/publish_common.py`、`scripts/publish_llm_client.py`、`scripts/pinned_http_transport.py` |
| 脚本索引 | [scripts/README.md](scripts/README.md)、[scripts/INDEX.md](scripts/INDEX.md) |
| 客户端版本与发行 | `apps/macos/Info.plist`、`apps/android/app/build.gradle.kts`、[客户端发行核验](docs/client-release-verification.md) |
| 会议与旧记录 | [会议流程](docs/conference-workflow.md)、[manual/README.md](manual/README.md) |

文档与实现冲突时先遵当前实现，并在同次变更中修文档。

## 默认 API 数据链与来源封存

`scripts/full-fetch.js` 负责归档、已发布页去重、arXiv/HuggingFace 抓取、筛选与深度分析；`data/current/` 维护 `papers.json`（累积账本，不参与去重）及检查点、候选、筛选与分析结果（字段见[数据格式](docs/data-format.md)）。

- 日更抓取须先同步博客远端，仅以真正已发布独立论文页去重，并从上次已核验检查点派生每源见证受控重叠，覆盖完整窗口后才筛选。原分析输入字节不可得时默认拒绝，仅显式登记的旧检查点恢复可扩展重叠（见[补抓边界](docs/daily-fetch-boundary.md#published-input-drift-recovery)）。
- 筛选后、分析前，须为每篇入选 arXiv ID 重拉官方 HTML 与 PDF，封存至 `data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/`（`source.txt`、`source.pdf`、`source-runtime.json`、`source-manifest.json`）。分析与恢复只读这四文件；模型用图仅在当前调用的系统临时目录准备。
- 官方 PDF 全地址 404 时，封存阶段默认最多跳过 2 篇（`PD_DAILY_SOURCE_SKIP_MAX`，0–5）写 `daily-source-skips.json`，`digest:status` 单列 `analysis.skipped`；超限或 5xx/超时/认证/解析失败停整批。筛选 404 记入 `filter-decisions.json`。
- 只读完整性校验用 `npm run validate:data`（仅干净检出或 CI 可加 `--allow-empty`）。

## 模型、代理、并发与预算

`muse-spark-*` 与 `deepseek-v4.1-flash` 走 OpenAI Responses（`/v1` 转 `/v1/responses`）；兼容 `mimo-v2.6-flash` 直连 Chat Completions。Node 经 `requestLlmJson()`，Python 经 `call_publish_llm_api()`。

- **代理与超时**：Muse 与 arXiv 强制走项目 HTTP CONNECT 代理，每次请求建独立连接对象用后销毁，禁静默直连；Node CONNECT+TLS 共用 60 秒有效预算（不含长挂起），arXiv 经 `arxiv-origin-gate.js` 限并发（默认 `PD_ARXIV_MAX_CONCURRENCY=3`）并共享 `Retry-After` 退避。外部图片/Demo 仅 HTTPS，逐跳拒绝私网/保留地址并固定已验公网 IP。
- **账号池与认证排障**：OpenCode Go 同池 key 默认按月到期优先、同天选有效剩余月额度最多且三窗口有额调度（`PD_LLM_ACCOUNT_POOL_STRATEGY=expiry_priority`，可改 `equal_rotation`；默认经代理同步 `/zen/go/v1/usage`，`PD_LLM_ACCOUNT_POOL_LIVE_SYNC=0` 可关，见[账号池](docs/setup.md#账号池)）。仅 HTTP 429 `GoUsageLimitError` 或 HTTP 401 `Insufficient balance` 允许同请求换号并按窗冷却；普通 401 须即停产保存在途稿并逐号独立探测全池，禁因单号 401 要求更换全部密钥，严禁展示密钥或稳定凭据指纹。
- **留账与保存故障**：请求开始与终态同 `eventId` 落盘，支持北京时间 `YYYY-MM-DD/` 分片（`PD_LLM_USAGE_SHARD_BY_DATE=1`）并维护日索引；终态或采用保存失败须停发并保全真实响应，不返还已发次数。
- **分级推理与缓存**：`PD_OPENAI_RESPONSES_STREAM=1` 启 SSE 并开阶段稳定 `prompt_cache_key`（`PD_OPENAI_RESPONSES_PROMPT_CACHE_KEY=0` 可关）。按 2026-11-24 与 2026-11-26 授权默认启用按阶段分级推理（`PD_TIERED_REASONING_EFFORT=0` 可关），不超过环境上限：
  - `xhigh`：主分析（`primaryAnalysis`）、API Reader 长文（`apiReaderArticle`）
  - `high`：评分审计（`scoringAudit`）、Reader 局部修复（`apiReaderRepair`）、全文审校（`revision`）
  - `medium`：核心摘要/结构/表格/方法局部修补、插图计划与发布图片审查（`publish.figure`）
  - `low`：日更筛选（`dailyFilter`）、发布文本审查（`publish.text`）
  - `minimal`：机械结构化阶段（`openSourceScan`、`tagSelection`、`apiReaderConceptTerms`、`repair_review_payload`）
- 推理与可见输出共用 `max_output_tokens`（主分析/审校/结构 `192000`、Reader `128000`、局部修复 `96000`、核心摘要 `32000`，默认禁改小）；`incomplete/max_output_tokens` 须判截断失败。发布审查分块默认 `20000`（上限 `24000`）；记分卡用 `npm run digest:scorecard`（[运维 CLI](docs/maintenance.md#可选运维与按需-cli)）。

| 能力 | 默认值 | 覆写变量 |
|---|---:|---|
| 整篇分析并发 / Reader 并发 | 3（≥1）/ 5（1–60） | `PD_ANALYSIS_CONCURRENCY` / `PD_API_READER_CONCURRENCY` |
| 筛选批次 / 批次总轮数 | 5（≥1）/ 3（1–10） | `PD_FILTER_BATCH_SIZE` / `PD_ANALYSIS_BATCH_MAX_ROUNDS` |
| 主分析尝试 / Reader 传输尝试 | 3 / 2（固定） | `PD_ANALYSIS_API_MAX_RETRIES` |
| 博客独立页审查并发 | 日更 16（1–32），会议默认 5（1–32）；历史 5（1–16） | `PD_BLOG_REVIEW_CONCURRENCY` / `PD_HISTORY_REVIEW_CONCURRENCY` |
| arXiv 源站并发闸门 | 3（1–6） | `PD_ARXIV_MAX_CONCURRENCY` |
| 日更人工修正名额 | `min(15, max(10, floor(N/10)))` | `PD_DAILY_CORRECTION_LIMIT`（1–15，只允许抬高） |

## 恢复原则与内容门禁

- **先全轮，再失败集**：首轮跑完选定全批落盘，再仅续可重试失败集；保留通过项、来源、计数与费用。共性校验误报先用真实保存稿复现，停产修复并补正反回归后再重验，禁借改代码清零计数或费用。
- **日更恢复入口**：`npm run deep`、`npm run batch`、`npm run reanalyze`、`npm run api:reader:refresh` 只读当前 `dailyFreshSourceRun` 封存四文件，不重抓、不读旧缓存。历史日期禁重跑抓取，仅可沿受控数据跑 `--from generate|review|push|visual`。
- **原余额与人工修正**：完整重验出现新阻断且旧问题组消失可按[原余额恢复](docs/reader-explicit-retry.md#正常候选中的原余额)继续；少量顽固项人工清单须绑原来源、失败稿 SHA 与 1–8 既有节点，修正后仍须过完整资格与博客审查。已签稿尾修用 `batch --reader-signed-corrections`（见[签名稿修正](docs/reader-explicit-retry.md#已签稿的事实修正)）。
<a id="锁失败记录与事实反馈"></a>
- **锁与事实义务**：同篇写入须持规范化 arXiv ID 锁并递增 `generation`；来源绑定事实反馈须先锁内持久化 `analysisFactReviewObligation`，未完成义务与最新失败均阻断成功和发布。
- **会议恢复与迁移细则**：后处理池、本地超时复试、`--postprocess-only`、`--source-corrections`、混合追加窗口、零请求修正、博客拒稿维护与认证 PDF 出版视图见[会议恢复与迁移执行细则](docs/conference-workflow.md#会议恢复与迁移执行细则从-agentsmd-归口)。ICML/OpenReview 跨标题预印本唯一白名单仍仅 `conference:icml:2026:openreview-forum-id:n1mAjfRDZ6`，禁推广。
- **内容与来源契约**：
  - 主分析含 13 个一级标题，`核心摘要`（`executive-abstract`）为 `700–1,400` 汉字（目标 `850–1,150`）、`10–26` 句、3–4 段粗体引导全景导读。
  - 公开正文来自 `beginner-researcher` API Reader（`structured-pipeline`）：5–9 节（推荐 5–7 节）、5000–18000 中文字、0–4 术语桥（`conceptBridges`）、含 `implementationSpecs`；标题直写具体问题、机制或发现（禁空洞单名及强套“功能锚点 + 冒号”）；原图紧凑 4 段式自然衔接（不强插 `> **看图路径：**`）；历史归档按原 `schemaFingerprint` 冷核兼容（见[写作约定](docs/writing-guide.md#全景导读摘要与长文模块分节)）。
  - 表格单元格须对应原表 DOM 或逐字引文（覆盖全数字与单位），展示公式由程序写入原 TeX；作者机构与外部资源逐项核源，仅 `available` 可写“已开源/可用”。
  - 八维 `type-aware` 评分（全维 `0–10`，代码重算封顶 `10`，旧版冷核兼容）；400 项九维词表中文首选（仅 8 个既定英文专名留原形配中文别名）。封存 SVG 异常可派生四源 PDF 原页（`reader-sealed-pdf-page-asset-v1`）或走 `reader-official-inline-svg-pixels-v2` 裁切。摘要级分析默认不可发布。

## 博客三阶段与远端证明

严格顺序：

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

- `generate` 生成页面与来源清单；`review` 只读审查写逐页 SHA、协议、博客基线与 Hugo 门禁凭证；`push` 仅推凭证允许的精确差异并验远端 `main` OID。已发布日批仅更新呈现须走 `--republish UUID`（见[重发布协议](docs/data-format.md#同来源同分析的日批重发布)）。
- 通过页按“相对路径 + 内容 SHA”永久复用；内容拒稿页仅在新旧协议均合法且不同时可同字节重审。审查不得原地改文件，失败回生成或修复阶段。图号区分送审位置“图片 K”、DOM 序号“论文图 N”与印刷“Figure M”。
- `remoteOidVerified` 仅证 Git 已到远端；宣告上线前须确认对应提交（或保已审字节的后续提交）Pages 构建部署成功，逐页核验汇总与单篇 HTTP 200、正式地址与标题（`npm run verify:web`），再登记不生图并重读 `npm run digest:status -- --date YYYY-MM-DD`。

### 日更完成的六项

以下六项全部成立，默认日更才算完成；其他文档引用本清单，不另立编号：

1. **数据与来源**：正式分析、封存来源、解读长文、评分和标签通过当前检查。
2. **审查**：生成清单、正文、图片与 Hugo 审查通过，审查凭证覆盖完整目标集合。
3. **远端发布**：只推送凭证允许的精确差异，远端 `main` OID 与发布提交一致。
4. **部署**：对应发布提交（或保留本批已审页面字节的后续提交）的 Pages workflow `build` 与 `deploy` 均成功。
5. **网页核验**：逐页核验目标日期汇总页及已发布单篇的 HTTP 200、正式地址与标题，并保存记录。
6. **不生图登记与重读状态**：与当前发布绑定的不生图记录有效，最后重新运行 `npm run digest:status -- --date YYYY-MM-DD` 并读取结果。

## 修改与验证

- 保留用户无关改动，禁止未授权 `git reset --hard`、强推或批量删除；仓库最终只留 `main`。
- 修改 `prompts/current/*.md`（`loadPrompt()` 读首围栏代码块）后须核对占位符、解析器、阶段指纹，并将前序 Git blob 登记入 `scripts/lib/git-prompt-evidence-index.json` 保历史冷重放。
- CI 跑 `npm run verify`：主矩阵覆盖 Node `20.x`/`22.x`/`24.x`（JS 4 分片，Python 3 套单测与静态校验在 Node 22 跑一次），`client-android` 与 `client-macos` 独立作业（见[验证矩阵](docs/maintenance.md#完整覆盖与并行范围)）。普通 push 不触发远端 CI，稳定改动经定向测试与审查后主动触发或经 PR 验收。
- 提交信息用具体中文写明原因、范围与影响；提交前确认 `data/`、`logs/`、`.env`、缓存与密钥未跟踪。
