# AGENTS.md

## 项目概述

自动化"语音/音乐/音频论文速递"流水线：arXiv + HuggingFace 抓取 → LLM 筛选 → 多模态深度分析 → 发布到 Hugo 博客 / 微信公众号 / 小红书 / 飞书。

**技术栈**：Node.js（核心流水线）+ Python（发布脚本）。要求 Node ≥ 18。`scripts/config.js` 集中管理 Node 端主要可调参数和当前运行数据文件路径（部分高频参数支持在项目根 `.env` 中用 `PD_*` 覆写）；`scripts/path_config.py` 集中管理 Python 发布/维护脚本共享路径。

详细执行规则见 `SKILL.md`，本文是紧凑版——只保留 Agent 不看代码就容易漏掉的要点。

## 常用命令

```bash
npm install              # 安装依赖（cheerio + pdf-parse）
npm test                 # 运行单元测试（node --test tests/*.test.js）
npm run fetch            # 全流程：抓取 + 筛选 + 深度分析
npm run deep             # 仅深度分析续跑（跳过已有 analysis；无分析结果时可从 filtered-papers.json 初始化）
npm run reanalyze        # 强制全量重分析（支持 --concurrency N）
npm run batch            # 批量分析未分析论文
npm run validate:data    # 只读校验候选/筛选/分析 JSON 数据、筛选决策缓存一致性和完整候选覆盖
npm run visual:post-publish -- --date YYYY-MM-DD # 在博客锁内建立 TOP 10 长图和汇总图任务
npm run visual:status -- --date YYYY-MM-DD # 只读校验 TOP 10 论文长图，不影响已经完成的博客发布
npm run cover:status -- --date YYYY-MM-DD  # 只读校验发布后的汇总图
npm run backfill         # 补录历史 paper ID（Python 脚本，不分析）
npm run blog:generate    # 只生成并安装 Hugo 博客文件
npm run blog:review      # 只 review 已生成文件并保存 SHA-256 凭证
npm run blog:push        # 只验证凭证并 commit/push，不生成、不 review
npm run wechat           # 生成微信公众号草稿
npm run xiaohongshu      # 生成小红书文案
npm run visual:archive -- --date YYYY-MM-DD # 仅迁移旧版论文图片到日期/排行榜归档，不创建任务
npm run cover:archive -- --date YYYY-MM-DD  # 仅迁移旧版汇总封面到日期归档
npm run xhs-login        # 小红书登录（获取 Cookie）
npm run xhs-publish      # 小红书自动发布单篇
npm run xhs-publish-all  # 小红书自动发布全部

# 直接调用（不在 package.json 中）
node scripts/quick-test.js              # 快速测试（抓+筛选，不分析）
node scripts/analyze-single-paper.js <arxiv-id> [--force]  # 单独分析一篇论文（--force 覆盖已有结果）
node scripts/reanalyze-selected.js <arxivId1> [arxivId2] ...  # 重分析指定论文
node scripts/refilter-reanalyze-by-date.js <date>  # 按日期重新筛选+分析
node scripts/validate-scores.js         # 验证并修复评分
node scripts/test-api-key.js            # 测试 LLM API key 可用性
python3 scripts/publish-to-feishu.py    # 生成飞书文档

# ICML 2026 专属流程（仅 icml-2026-analysis 分支可用）
npm run icml-fetch-openreview   # 从 OpenReview API 抓取论文元数据（需 Chrome Cookie）
npm run icml-filter             # LLM 筛选音频/语音/音乐相关论文
npm run icml-download-pdfs      # 下载筛选论文 PDF 并提取文本（含表格）
npm run icml-analyze            # 批量深度分析（基于 PDF 全文 + 自动注入图片）
npm run icml-retry              # 重试失败的分析
npm run icml-reanalyze-pdf      # 基于 PDF 全文重分析
python3 scripts/extract-icml-images.py   # 提取 PDF 图片到图床
# 会议博客也须依次运行 generate-blog.py、review-blog.py、push-blog.py；生成阶段传 category/date/data file
```

未配置 linter、typecheck 或 formatter。CI 会运行 `npm test`、`npm run validate:data`、所有 `scripts/` / `tests/` 下 JS 文件 `node -c` 语法检查、所有 `scripts/` 下 Python 文件 `py_compile` 语法检查、`tests/python` 下 Python 单测，以及所有 `.sh` 的 `bash -n`。

## 环境配置

复制 `env.example` → `.env`（已 gitignore）。

**抓取/筛选/分析必需变量**：`PAPER_ANALYZER_API_KEY` / `PAPER_ANALYZER_MODEL` / `PAPER_ANALYZER_ENDPOINT`

**博客相关变量**：`PAPER_DIGEST_BLOG_REPO` 可覆写 Hugo 博客仓库路径；未设置时使用默认路径，目录不存在会跳过博客已发布去重，真实博客发布仍需要本地仓库存在。
`PD_BLOG_REVIEW_CONCURRENCY` 控制博客独立论文页的三层 review 并发度，默认为 5；汇总页仍先完成审查。首次 review 失败会保存绑定生成清单、博客 `main` 基线和逐文件 SHA-256 的失败集状态；修复后仅复审已修改的失败文件，已通过文件或基线发生变化时自动退回全量 review。
`PD_XIAOHONGSHU_ONELINER_CONCURRENCY` 控制小红书 TOP N 一句话亮点的 LLM 并发度，默认 5，限制为 1–5；结果必须按原排名回填，单篇失败独立使用本地摘要回退。

**双模型（可选，多模态）**：设置 `PAPER_ANALYZER_SECONDARY_MODEL` 即启用副模型做图像筛选与插图计划（主模型仅做纯文本分析）；副模型只输出 JSON 计划，包含目标章节、代码提供的稳定 `paragraph_id`、图前 `lead` 和图后 `explanation`。代码只新增插图及相邻说明，忽略旧 `replacement` / `rewrite` 字段，禁止副模型替换主模型原文；每篇默认最多插入 4 张，非法段落 ID 直接丢弃，旧 `anchor` 格式仅保留兼容。不设置则跳过图片、退回单模型纯文本。`PAPER_ANALYZER_SECONDARY_ENDPOINT` / `PAPER_ANALYZER_SECONDARY_API_KEY` 未设置时默认复用主模型对应值。

**Codex 发布后视觉资产**：必须先完成全部论文深度分析，再依次完成博客 generate、全量/失败集 review、push，并由 `push-blog.py` 验证远端 `main` OID。只有发布凭证同时记录 `publicationCommit`、相同的 `remoteVerifiedOid` 和验证时间后，才可建立视觉任务。`push-blog.py` 会自动运行发布后规划器；论文长图只选择最终评分 TOP 10（同分按规范化 arXiv ID），每篇一张纵向 PNG，顶部为完整英文标题、正文为简体中文；另生成一张包含批次标题、热门方向和 TOP 5 排行榜的汇总图。Agent 必须目视核对标题、中文正文、论文数字与排行榜后才能执行 record。两类 manifest 按日期隔离并支持失败项续跑，但图片不进入本轮博客 generation/review/push，也不阻断已经完成的发布。项目脚本不得调用图像 API或读取 `OPENAI_API_KEY`，实际绘图只能由 Codex 内置 `image_gen` 完成。

Node 脚本通过 `scripts/env-loader.js` 加载当前项目根 `.env`：① `scripts/config.js` 模块级最先执行（任何 `require('config')` 即触发）；② `scripts/utils.js` 的 `loadEnvFile()` 二次兜底补漏。Python 脚本通过 `scripts/project_env.py` 加载同一个 `.env`。两端都会先清理继承自 Trae/Codex/shell 的项目同名变量（`PAPER_ANALYZER_*`、`PAPER_DIGEST_*`、`PD_*`、`WECHAT_*`、`FEISHU_*`、`XIAOHONGSHU_*`、`KIMI_API_KEY`）以及大小写代理变量，再写入项目 `.env`；代理不再回退 macOS `scutil`，加载器会把 `.env` 权限收紧为 `0600`。外部命令必须使用最小子进程环境，禁止把 LLM/发布凭据传给 curl、CLI、Git hook 或浏览器进程。

**所有项目脚本必须沙箱外执行**：任何直接执行的 `scripts/*.js`、`scripts/*.py`、`run-full-fetch.sh` 或 `scripts/*.sh` 都必须以沙箱外权限启动。Node `env-loader.js`、Python `project_env.py` 与 shell 入口会检测可靠的 `CODEX_SANDBOX` 标志并在业务逻辑、日志、网络和写入前失败退出；测试导入模块不触发守卫。`CODEX_SANDBOX_NETWORK_DISABLED` 可能被沙箱外权限包装保留，不能单独判定仍在沙箱内。

### LLM API 协议自动路由

`detectApiType()`（`scripts/utils.js`）根据 endpoint + model 自动判断协议：

| 端点含 | 模型含 | 协议 | URL 转换 |
|--------|--------|------|----------|
| `deepseek.com` 或模型含 `deepseek` | — | OpenAI | `/anthropic` → `/v1/chat/completions`（强制 OpenAI，优先级最高） |
| `token-plan` | `mimo` | Anthropic | `/v1` → `/anthropic/v1/messages` |
| `coding` | `kimi` | Anthropic | `/coding/v1` → `/coding/v1/messages` |
| `/anthropic` | — | Anthropic | `{base}/messages` |
| 其他 | 其他 | OpenAI | `/v1/chat/completions` |

**网络职责必须隔离**：LLM API 请求中 `options.agent` 必须显式设为 `false`（禁用连接复用且强制直连），否则在有系统代理时 MiMo Token Plan 返回 403。适用于 `fetch-papers.js`、`deep-analyzer.js`、`test-api-key.js` 以及后续新增的所有 Node LLM API 调用。arXiv 元数据、HTML、PDF、图片及 HuggingFace Papers 则必须通过当前项目 `.env` 的代理访问，缺少代理配置时必须报错，严禁静默直连；Node 的 arXiv 请求只接受 `HTTPS_PROXY` / `HTTP_PROXY` 中的 HTTP CONNECT 代理，HuggingFace 的 curl 可额外使用 SOCKS `ALL_PROXY`。

## 架构

### 入口脚本（Node.js）

| 文件 | 角色 |
|------|------|
| `scripts/full-fetch.js` | 主编排器（归档→去重含博客已发布→抓取→筛选→更新去重库→分析→增量保存） |
| `scripts/fetch-papers.js` | arXiv 网页抓取 + LLM 筛选 |
| `scripts/fetch-huggingface-papers.js` | HuggingFace Papers 抓取（curl 命令） |
| `scripts/deep-analyzer.js` | 单篇多模态深度分析（支持双模型模式：主模型做文本分析，副模型做图像筛选与局部插图计划；单模型模式向后兼容） |
| `scripts/analysis-engine.js` | 批量分析协调器，提供 `analyzePaperWithRetry()` + `analyzeBatch()` |
| `scripts/utils.js` | Node 端共用工具（API 路由、JSON 解析、prompt 加载、`normalizedId` 去重、代理检测、文件原子写入） |
| `scripts/config.js` | Node 端主要可调参数与运行数据路径集中配置 + 部分 `PD_*` 项目 `.env` 覆写 |

### 发布脚本（Python）

`generate-blog.py` / `review-blog.py` / `push-blog.py` 是博客生成、审查、推送的三个独立入口；`publish-to-blog.py` 仅保留生成兼容入口与共用实现。`publish-wechat-full.py` / `publish-xiaohongshu.py` / `xiaohongshu-publisher.py` / `publish-to-feishu.py` + 共用模块 `publish_common.py` / `path_config.py` / `utils.py`。生成前必须从 `analysis` 重解析评分并校验八维完整性，再与缓存 `parsed` 和顶层评分版本逐字段比较；人工修正必须声明 `parsedOverride.type=manual`、来源、原因和字段白名单。Python 侧默认运行数据路径统一从 `path_config.py` 取。

### 数据目录

```
data/current/           # 工作数据（gitignored）
  papers.json           # 论文去重数据库，跨运行累积，永不归档
  fetch-checkpoint.json # 按 arXiv 类别/HF 保存抓取断点、论文数量与内容 SHA；损坏时仅补对应来源
  raw-candidates.json   # 当日合并+博客去重后的筛选候选，便于排查筛选输入
  filter-decisions.json # 当日 LLM 筛选逐篇决策缓存（含 reason/rawResponse）；来源健康时续跑只重试未决论文，不重新抓取
  filtered-papers.json  # 当日筛选结果
  deep-analysis-result.json  # 当日分析结果
  visual-summary-manifests/<date>.json # 发布后评分 TOP 10 纵向长图的状态、排名、指纹和资产 SHA
  digest-cover-manifests/<date>.json # 发布后汇总图状态、上下文和指纹
  analyzed.json         # 分析状态（兼容）
data/archive/<date>/    # 每日快照（自动创建）
  visual-summaries/<两位排名>-<paper>/infographic.png # 发布后 TOP 10 论文长图，按排行榜编号归档
  digest-cover/cover.png # 发布后汇总封面，生成后直接按批次日期归档
logs/                   # 默认生成文件日志（gitignored；可用 PD_DISABLE_FILE_LOGS=1 强制关闭）
prompts/                # LLM prompt 模板
  filter.md             # 筛选阶段
  deep-analysis.md      # 深度分析主 prompt（Round 1，纯文本）
  image-supplement.md   # 图像筛选与插图计划（双模型模式副模型用）
  visual-summary.md     # GPT Image 2 编辑性论文视觉摘要（评分 TOP 10 各一张纵向长图）
  digest-cover.md       # 发布后汇总图（标题、热门方向、TOP 5 排行榜）
  opensource-scan.md    # 开源链接扫描（Round 2）
  gap-fill.md           # 审校重写（Round 3）
  method-fill.md        # 方法章节补充（后处理）
  table-fill.md         # 实验表格补充（后处理）
  structure-repair.md   # 缺失必要章节时的主模型局部结构修复
  scoring-audit.md      # 主模型最终类型感知评分审计（JSON）
  index.md              # Prompt 文档索引（含占位符规范）
  en/                   # 英文版 prompt（含 filter / deep-analysis / gap-fill / opensource-scan / index，不含 image-supplement / method-fill / table-fill / structure-repair / scoring-audit）
```

`papers.json` 同时支持 `data/current/papers.json` 和 `data/papers.json`（旧版路径），均被 `config.js` 引用。**`papers.json` 持久化去重数据库，永不归档**。`full-fetch.js` 每次运行自动备份 `papers.json` 到 `data/archive/papers-<日期>.json`，保留最近 7 天。条目可带 `digestStatus.status`：`pending_analysis` / `analysis_failed` 不参与强去重，便于中断后重跑；所有分析入口应通过 `scripts/digest-status.js` 将成功/失败同步为 `analyzed` / `analysis_failed`。若最新一次分析失败但旧成功分析仍可用，`status` 保持 `analyzed`，失败记录写入 `digestStatus.latestAttemptStatus` / `error`。

`filtered-papers.json` 只有在七个 arXiv 类别、HuggingFace 必需请求和筛选决定均覆盖完整时才能写为 `complete`。抓取按来源保存论文数量和稳定内容 SHA，篡改或截短只失效对应来源。checkpoint、raw、decisions、filtered 的候选/来源/博客去重指纹和北京时间批次日期必须一致。健康 raw 可从空决定续筛；模型/prompt/协议变化只重筛，不重新抓取。最终 filtered 集合必须精确对应 `related=true` 决定扣除显式归档排除项。

## 分支策略

- `main` — 每日论文速递流水线（arXiv + HuggingFace）
- `icml-2026-analysis` / `iclr-2026-analysis` / `icassp-2026-analysis` — 会议专用分析分支，含独立脚本和 prompt。**不要将会议脚本混入 main 分支**。

## 重要约定

- **资料权威性**：文档与代码冲突时，以 `scripts/*` 当前实现为准。详尽的执行规则与安全约束见 `SKILL.md`。
- **提交信息**：必须使用中文且描述要具体，说明主要修复点/影响范围；禁止只写“修复”“更新”这类空泛信息。可保留 `feat:` / `fix:` / `docs:` 前缀，但正文必须是中文详细描述。
- **测试框架**：Node.js 内置 `node:test`，非 Jest/Mocha。
- **CI**：运行 `npm test` + `npm run validate:data` + `find scripts tests -name '*.js'` 的 `node -c` 语法检查 + `find scripts -name '*.py'` 的 `py_compile` 语法检查 + `python3 -m unittest discover -s tests/python` + 所有 `.sh` 的 `bash -n`。新增 JS/Python/shell 文件会自动纳入检查。
- **新增分析脚本必须复用 `analysis-engine.js`**，使用 `analyzePaperWithRetry()` + `analyzeBatch()`，禁止重复实现重试/解析/保存逻辑；保存分析结果后必须复用 `scripts/digest-status.js` 同步 `papers.json.digestStatus`。
- **新增 Node LLM 调用必须通过 `utils.js` 的 `detectApiType()` / `buildApiUrl()` / `buildHeaders()` / `buildRequestBody()` / `parseResponseText()`**，禁止硬编码协议。Python 发布阶段 LLM 调用必须复用 `publish_common.py` 的 `call_publish_llm_api()`。
- **环境变量加载**：Node 端必须复用 `scripts/env-loader.js` / `loadEnvFile()`；Python 端必须复用 `scripts/project_env.py`。项目配置只允许来自当前项目根 `.env`，脚本启动时必须清理继承进程里的同名项目变量与代理变量，禁止 shell / Trae / Codex 外层变量覆盖或补齐当前项目配置。外部命令复用 `buildChildProcessEnv()` / `build_child_process_env()`；只有 Git 可显式追加 SSH/GPG agent。
- **所有脚本必须沙箱外运行**：凡是直接执行项目脚本的抓取、分析、发布、测试、语法检查或数据校验命令，Agent 必须以沙箱外权限启动；沙箱无法访问 `127.0.0.1:7897` 时不得把该失败误判为目标站点或代理故障。仅可在沙箱内阅读文件或由测试框架导入模块，禁止直接运行脚本入口。
- **`loadPrompt()` 从 markdown 文件内的第一个 fenced code block 提取 prompt**，并替换 `{变量名}` 占位符。内部示例代码块需使用比外层更短的 fence，修改 prompt 后需验证 `utils.js` 解析逻辑兼容。
- **原子与并发写入**：使用 `writeFileAtomic()` 保存普通数据；分析结果和 `papers.json` 的读改写必须使用跨进程文件锁并校验 `generation`，防止多个入口后写覆盖先写。Python 侧复用 `path_config.py` 的原子写入和 `update_json_file_locked()`，锁目录/owner/generation 协议必须与 Node 一致。
- **阶段恢复**：深度分析失败结果必须保留 `analysisManifest`、`analysisCheckpoint`、`analysisStageCheckpoints` 和 `analysisRecoveryImageManifest`。每个阶段绑定实际输入、模型/协议、prompt、温度和图像配置指纹；指纹变化时回退到上一阶段正文快照，只重跑当前及下游。`full-fetch`、`deep`、`batch`、单篇和重分析入口均须从 canonical deep result 合并失败 checkpoint，并逐论文持久化。只有下载、主分析、开源扫描、Demo 扫描、审校、表格/方法/结构修复、评分审计和插图阶段均处于终态时才算成功。
- **同篇分析互斥**：所有经 `analysis-engine.js` 的入口都必须按规范化 arXiv ID 取得异步共享运行锁，并在锁内完成“重读最新 canonical 记录 → 分析 → 写回结果和 digest 状态”；禁止在锁外用陈旧对象覆盖较新结果。单篇失败也必须合并 `r.result`，以保留 checkpoint。
- **博客推送凭证**：严格 review 凭证绑定 review 时博客 `main` 的 `baseHead`；push 只能从该基线创建清单对应的发布提交，或重试凭证记录的同一发布提交。禁止借由空清单、已有本地提交或无关 HEAD 推送未审查内容；生成前必须拒绝覆盖目标日期文章的人工 Git 修改。
- **arXiv 与 Demo 网络恢复**：深度分析的 arXiv HTML/图片发现默认超时 60 秒，PDF fallback 默认 180 秒且默认最大 50MB，分别支持 `PD_ARXIV_FETCH_TIMEOUT_MS` / `PD_ARXIV_PDF_TIMEOUT_MS` / `PD_ARXIV_PDF_MAX_BYTES`。arXiv 全文、PDF 和图片必须使用项目 HTTP CONNECT 代理 dispatcher；稳定 400/403/404 只尝试一轮；指定版本号不得静默回退到最新版。Demo 页面允许最多 3 次 HTTP 重定向，但每一跳都必须重新执行公网 DNS/IP 校验，严禁自动跟随到私网地址。
- **北京时间时间戳**：运行数据中的 `timestamp` / `lastUpdated` / `fetchedAt` 应使用 `getBeijingISOString()` 或 Python 端 `now_bj_iso()`，避免 UTC 日期导致跨天归档或发布筛选错误。
- **博客三阶段必须分离且必须沙箱外运行**：依次运行 `generate-blog.py` → `review-blog.py` → `push-blog.py`。生成阶段使用持久 journal；review 逐文件保存实际审查 SHA，内容失败只复审失败页，瞬时错误保持待重试。三个阶段同时使用日期级锁和博客仓库级全局锁；push 在 `git add` 后及 commit 前必须把 index blob/删除状态与 review 凭证逐项比较，防止不同日期共享 worktree/index/HEAD 时交叉提交或回滚。仅用户明确要求发博客时才允许运行 push。
- **小红书文案续跑**：TOP N one-liner 成功项按 normalized arXiv ID 写入日期缓存，绑定 analysis、prompt、模型/endpoint/温度和清洗契约；日期级锁内逐篇原子保存。坏缓存原子隔离后重建，只重试缺失、失败或指纹失效项；`--date` 必须严格为 `YYYY-MM-DD`。小红书自动发布不属于论文速递必需流程。
- **发布 review 不得删除合法表格续行**：Markdown 表格允许前导分组列为空，这通常表示沿用上一行模型/配置；不能把 `| | | | Filter2 ... |` 一类数据行当成子标题删除。普通模型名或技术术语未加反引号属于样式建议，不是格式问题。
- **图片展示顺序与质量门禁**：候选图编号不是最终展示图号；无真实 caption 的通用 `图N` alt 与 `selectedImageUrls` 必须按图片在最终正文中的出现顺序归一化。副模型每篇最多插入 4 张图（可用 `PD_IMAGE_INSERTION_MAX` 覆写），必须选择代码生成的稳定段落 ID；非法 ID 和超限图片一律拒绝，不得回退堆到章节末尾。HTML 正文和图注必须同次解析复用，成功下载写入 `data/current/image-cache/`，永久 HTTP/MIME/大小错误不得反复重试。
- **分析来源与发布门禁**：结果必须保存 `analysisSource`、全文/实际输入字符数、截断状态、来源 SHA-256、抓取告警和置信度。来源指纹变化时清除主分析及下游 checkpoint。仅摘要分析默认禁止发布；人工确认后必须显式设置 `allowAbstractAnalysisPublish: true`，博客同时显示醒目降级提示。最新一次重分析失败时禁止用陈旧正文发布。
- **评分稳定性**：最终评分审计默认低温 `0.1`（`PD_SCORING_AUDIT_TEMPERATURE`），副模型图片计划默认 `0.2`（`PD_IMAGE_PLAN_TEMPERATURE`）。评分 manifest 必须保留模型、温度、prompt 模板哈希、证据哈希、尝试次数、前后总分/差值和最终八维 JSON；变化超过 0.5 分必须打印稳定性告警，指纹变化时只失效评分及插图阶段。
- **副模型日志**：插图筛选必须记录 `[secondary]` 详细输入/输出摘要（模型、协议、endpoint/key 来源、候选和下载数量、图片安全标签/MIME/负载、Prompt/响应长度、活跃请求时长、计划解析状态、anchor 实际命中、拒绝原因和最终选图），只能记录 key 来源，严禁记录 API key 内容。统一日志必须是 UTF-8 纯文本、唯一文件名和 `0600` 权限；每个非空物理行均须以毫秒级北京时间戳（`[YYYY-MM-DD HH:mm:ss.SSS+08:00]`）开头，并脱敏认证头、Cookie、token、secret、password、任意已配置密钥实际值和 URL userinfo；不得轮转、限量或自动清理。
- **睡眠恢复**：LLM 的 20 分钟整体超时按进程活跃时间记账；检测到超过 30 秒的事件循环跳变时视为系统睡眠/长时间挂起，排除睡眠时长并记录 `[api]` 日志。唤醒后底层请求超时必须保留剩余预算进入正常重试，不能把睡眠墙钟时间算成 API 已用时间。
- **评分数值契约**：八个分项与总分最多一位小数；开源分仅允许 `0/0.2/0.5/1.0/1.2/1.5`。理论研究的完整证明、推导和附录可作为核心公开产物，不能因 `hasCode/hasModel/hasDataset` 均为否而被代码强制归零。Python 发布预检与人工覆盖也必须执行同一契约。
- **后台运行全流程时用 `node scripts/full-fetch.js`** 而非 `npm run fetch`（npm 可能因 TTY 导致 SIGTERM，exit code 143）。根目录 `run-full-fetch.sh` 即此包装（`cd` 到项目根后 `exec node`）。
- **`data/` 和 `logs/` 已 gitignore** — 禁止提交运行时产物。

### 致命 Bug 防御

**MiMo Token Plan 403**：所有 Node LLM 请求（包括 API 测试脚本）的 `options.agent` 必须为 `false`（不是 `undefined`）。这会彻底禁用连接复用，强制直连。任何重构 HTTP 代码时绝对不能改回 `agent: proxyAgent` 或 `undefined`。

### 长时间运行命令

命令 `npm run fetch`、`npm run reanalyze`、`npm run deep`、`batch-analyze.js` 等可能运行数十分钟到数小时。**必须：**
1. **禁止设置 Bash timeout**，确保命令永不超时。
2. **禁止检查进程状态**（`ps aux | grep`、`jobs`）。
3. **禁止过滤输出**（`grep`、`head`、`tail`），完整输出是判断是否正常的唯一依据。
4. **禁止 abort**，命令自然结束前严禁中止、取消或重启。
5. **启动后只等待结果**，不做其他操作。

## 评分体系速查

深度分析采用八维审稿人评分：创新性(2) + 技术严谨性(1.5) + 实验充分性(1.5) + 清晰度(1) + 影响力(1.5) + 开源(1.5) + 可复现性(0.5) + 工程/实践价值(1.5) = 满分 11 分，**总分上限 10**。

当前评分契约为 `type-aware-v1`。主模型必须先输出 `document_type`，且只能取：`方法研究` / `系统技术报告` / `模型报告` / `数据集与基准` / `综述` / `理论研究` / `应用研究`。类型只选择证据标准，不提供固定加分、保底或豁免；系统/模型报告按端到端质量、延迟、吞吐、成本、规模、压力测试、竞品公平性和失败案例评估，综述、理论和数据集论文也使用各自适配证据，不能机械套用方法论文的消融标准。

评分必须遵守“单一问题单一主维度扣分”：缺少开源产物只归开源，缺少超参数/复现步骤只归可复现性，证据不足只归实验充分性，表达问题只归清晰度，推导/假设/逻辑错误才归技术严谨性。信息不足时降低 `confidence`，不得把“无法验证”写成“技术错误”。副模型仍只负责插图，不得参与类型判断或评分。

最终评分审计会把精确校验错误反馈给下一次局部审计，避免相同违规输出造成整篇重跑。非理论论文无核心产物时，代码按资源状态固定开源分：明确肯定语境的未来开放承诺为 0.5、带可访问 URL 或肯定结构化状态的 Demo 为 0.2、否定/未提及且无承诺为 0；理论研究保留基于公开证明材料的判断。`parseAnalysis()` 只有在八个分项完整、唯一、分母正确、最多一位小数且分值有限并位于合法范围时才重算总分，否则返回契约错误并阻断保存或发布。

`rankBucket` 推断（基于最终 score）：≥9.0 → 前10%，≥7.5 → 前25%，≥5.5 → 前50%，<5.5 → 后50%。

## 发布日期安全

- 博客 `YYYY-MM-DD` 代表**爬取分析的批次日期**，不是论文 arXiv 发布日期
- `deep-analysis-result.json` 中的论文都是当日抓取+去重+筛选后的结果
- `full-fetch.js` 每天运行时自动归档移走昨日数据文件
- 重跑当天步骤见 `SKILL.md` §6（先检查 `papers.json` 的 `lastUpdated`）
- **恢复 `papers.json` 的关键判断**：`lastUpdated` 是今天→不要恢复；若今日 `filtered-papers.json` 已是 `status: complete`，直接运行 `node scripts/full-fetch.js` 会跳过抓取/筛选并续跑深度分析；是昨天或更早→可恢复 `data/archive/papers-<日期>.json` 备份
