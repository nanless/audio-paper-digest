# AGENTS.md

## 这份文件给谁

本文供第一次进入仓库、需要运行或修改论文速递的执行者使用，列出容易遗漏的操作限制。按顺序操作见 [SKILL.md](SKILL.md)，按任务查文档见 [docs/README.md](docs/README.md)，定位代码见 [scripts/README.md](scripts/README.md)。本文保留执行时不可绕过的规则；修改说明文字时遵循[写作约定](docs/writing-guide.md)，不能借精简文案改变约束。

## 默认目标与最短路径

### 当前工作区（必须先核对 `pwd`）

- 每日速递、新会议整理和历史博客维护统一在 `/Users/francis7999/code/github_repos/audio-paper-digest` 执行。当前角色保持 `daily`；本机 `.env` 的 `PD_WORKSPACE_ALLOW_CROSS_ROLE=1` 允许历史入口在此运行，反向放行仍然禁止。
- 旧 `audio-paper-digest-rewrite-all` 工作区已废弃，不再进入、修改或启动任务；不从旧目录复制检查点或手工合并运行数据。
- 当前任务的运行数据保存在本项目 `data/runtime/`。日更、会议、历史任务的生成、审查和推送必须错峰，由执行者检查运行进程并安排；共享博客锁继续防止并发修改。
- 历史发布前先结束其他发布任务，同步代码仓库和博客仓库的最新远端 `main`，再以同步后的博客 Git 提交为依据生成审查与发布凭证。旧凭证不能因切换工作区而直接复用。

用户说“运行/进行 YYYY-MM-DD 论文速递”时，默认执行完整 LLM/API 日更：

```bash
npm run digest:prepare -- YYYY-MM-DD
# 仅用户已明确取消视觉时：npm run digest:prepare -- YYYY-MM-DD --no-visuals
# digest:api 是完全等价的显式别名
```

这项请求已授权联网抓取、关键词预筛、LLM 筛选、多阶段全文分析与评分、面向初学研究者的 API Reader 长文、博客生成与审查、推送与远端 OID 验证、发布后图片任务和最终验收。完成 Git 发布后还须核验部署及网页。不要在分析、审查或推送后提前结束，也不要再次询问是否发布博客。

整批 Manual 作者、任务与 spec/records 生产链已退役，新任务仅使用日更、官方会议和历史博客更新。普通单篇失败保留断点，先完成本轮其余论文，再仅对可重试失败集合走正常轮次；认证、配额、配置、保存或其它运行级故障停止新派发并保存在途结果，不另启写作流程。用户明确授权的单篇人工修正和独立审查仍可使用受控恢复入口；`manual/` 中剩余模块只核验旧来源、签名和正文记录。微信、飞书、小红书发布已退役。

## 运行前六项检查

0. 先运行 `npm run workspace:role -- status`。当前目录必须是 `daily`，历史命令须通过已配置的跨角色开关运行；角色标记缺失或真实路径不匹配时先停止，确认工作区用途后才用 `npm run workspace:role -- set daily|history [--force]` 绑定。
1. Node 满足 `>=20.18.1 <21 || >=22.3.0`，依赖已安装。
   npm 中的 Python 命令还要求 Python 3.11+ 与 OpenSSL；`scripts/python-runtime.sh` 优先使用项目 `.venv`，再选择并校验 `python3.11` / `python3`。
2. 项目根 `.env` 存在，加载器会将文件权限收紧为 `0600`。
3. `PAPER_ANALYZER_API_KEY/MODEL/ENDPOINT` 完整；用户已指定后续论文 LLM 统一使用 `muse-spark-1.3-contributor`，主、副模型配置均须核对；实际模型仍由项目配置指定。可选 `PAPER_ANALYZER_FALLBACK_API_KEYS` 为同一路由提供备用账号；切换后持续使用成功账号，不能代替副模型配置。
4. `HTTPS_PROXY` 或 `HTTP_PROXY` 是项目 `.env` 内的 HTTP CONNECT 地址；`muse-spark-*` 模型与 arXiv 缺代理立即失败，当前统一使用的 `muse-spark-1.3-contributor` 必须走该代理。
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
- `fetch-checkpoint.json`：逐来源候选数量、内容 SHA 与补抓覆盖窗口；运行前同步博客远端，以真正已发布日更续抓，详见[补抓边界](docs/daily-fetch-boundary.md)。
- `raw-candidates.json`：当日完整候选。
- `filter-decisions.json`：逐篇筛选决定、理由、响应和输入指纹。
- `filtered-papers.json`：当日正式入选集合。
- `deep-analysis-result.json`：正式分析结果、逐阶段检查点和发布资格证明。

默认 API 日更抓取须从上次已核验检查点派生每源旧获取见证并受控重叠，实际核对旧编号与时间后才能进入筛选和分析。每页与固定窗口仍须完整覆盖，不能见第一个重复编号就丢弃后续记录；仅已发布页参与去重，库内未发布仍参加补更。原精确起点与重叠理由纳入边界身份，不手改来源计数或凭证。

默认 API 日更在筛选完成后、进入深度分析前，必须为每个入选 arXiv ID 重新拉取官方 HTML 文本与 PDF，并封存为
`data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/` 下的
`source.txt`、`source.pdf`、`source-runtime.json` 与 `source-manifest.json`。分析只能读取这组封存文件。模型所需图片只可在当前调用的系统临时目录中准备，禁止写入 `data/current` 或运行目录的图片缓存。

检查完整性时，除了文件存在，还须确认候选、筛选决定、入选集和分析结果的日期、来源、候选指纹及论文集合相互对应。运行 `npm run validate:data` 做只读验证；只有干净检出的仓库才可显式加 `--allow-empty`。

## 模型、代理、并发与预算

`muse-spark-*` 模型使用 OpenAI Responses，`/v1` 转为 `/v1/responses`；兼容的 `mimo-v2.6-flash` 在 OpenCode Go 上走 OpenAI Chat Completions，基础端点原样使用。所有 Node LLM 请求必须经 `requestLlmJson()`；Python 发布请求必须经 `call_publish_llm_api()`。

- Muse：强制使用项目 HTTP CONNECT 代理。每次请求创建独立连接对象，请求结束后销毁；这里的 `agent` 指 HTTP 连接对象。禁止静默改为直连。
- 兼容的 `mimo-v2.6-flash` 不含 `muse-spark-` 前缀，按直连处理，不复用上面的代理设置。
- OpenCode Go 账号池：成功时持续使用当前账号。只有明确的 HTTP 429 `GoUsageLimitError` 或 HTTP 401 `Insufficient balance` 才在同一逻辑请求内按配置顺序向后切换，并保存冷却状态；不返回前面已冷却的账号。普通认证 401 会停止本次运行，不切换账号；普通 429、5xx、网络错误、输出截断和正文校验失败也不得切换。全部后续账号不可用时保存断点并停止新请求，避免整批论文反复遭遇同一服务故障。
- 其他 LLM：默认以 `agent:false` 直连，防止误用 Muse 的代理设置影响 MiMo/Kimi。
- arXiv 元数据、HTML、PDF、图片：强制项目 HTTP CONNECT。
- HuggingFace curl：继承 HTTP(S) 代理，可额外使用 `ALL_PROXY` SOCKS。
- 外部图片/Demo：仅允许 HTTPS。每次重定向都拒绝私网和保留地址，并连接已核验的固定公网 IP，防止 DNS 重绑定。

| 能力 | 默认值 | 覆写 |
|---|---:|---|
| 整篇分析并发 | 3 | `PD_ANALYSIS_CONCURRENCY` |
| 筛选配置批次 | 5；主模型同样使用配置值 | `PD_FILTER_BATCH_SIZE` |
| 批次总轮数 | 3，范围 1–10；旧额外重试 2 对应 3 轮 | `PD_ANALYSIS_BATCH_MAX_ROUNDS`；兼容 `PD_ANALYSIS_MAX_RETRIES` |
| 单阶段请求尝试 | 3 | `PD_ANALYSIS_API_MAX_RETRIES` |
| 人工建议的失败集合上限 | 5，范围 0–5；0关闭建议 | `PD_ANALYSIS_MANUAL_HANDOFF_MAX_ITEMS` |
| 人工建议最低失败轮 / 无进展观察轮 | 3 / 3，各范围 3–10 | `PD_ANALYSIS_MANUAL_HANDOFF_MIN_ROUNDS` / `PD_ANALYSIS_MANUAL_HANDOFF_NO_PROGRESS_ROUNDS` |
| 主分析输出 | 64000 tokens | `PD_ANALYSIS_API_MAX_TOKENS` |
| 完整正文审校重写输出 | 64000 tokens | `PD_ANALYSIS_REVISION_MAX_TOKENS` |
| 完整正文结构重写输出 | 64000 tokens | `PD_ANALYSIS_STRUCTURE_MAX_TOKENS` |
| 核心摘要修补输出 | 32000 tokens | `PD_ANALYSIS_CORE_SUMMARY_REPAIR_MAX_TOKENS` |
| 局部修复输出 | 16000 tokens | `PD_ANALYSIS_REPAIR_MAX_TOKENS` |
| 单次分析 LLM 响应 | 16 MiB | `PD_ANALYSIS_API_MAX_RESPONSE_BYTES` |
| API Reader 输出 | 48000 tokens | `PD_API_READER_MAX_TOKENS` |
| Reader 证据 / 总上下文 | 180000 / 240000 字符 | 对应 `PD_API_READER_*_MAX_CHARS` |
| Reader 重阶段并发 | 5，范围 1–60；积压批次可显式增加，运行中观察超时与限流 | `PD_API_READER_CONCURRENCY` |
| 独立博客页审查并发 | 5，范围 1–5 | `PD_BLOG_REVIEW_CONCURRENCY` |

主分析最多使用 200000 字符，并从全文均衡取样；后处理只接收任务相关证据。阶段指纹包含预算和证据选择版本。OpenAI Responses 只有 `PD_OPENAI_RESPONSES_STREAM=1` 时启用 SSE，`PD_OPENAI_RESPONSES_STREAM` 与 `PD_OPENAI_RESPONSES_REASONING_EFFORT` 对 Chat Completions 请求无效；`incomplete/max_output_tokens` 必须记为截断失败，不得接受半截 JSON。

## 恢复原则

### 先完成整轮，再续失败集合

- 普通批次先让选定集合统一走完整正常流程，首轮全部结束并保存结果后，再仅对可重试失败集合重复；每轮每篇一次，默认最多3轮，由来源和检查点指纹决定恢复阶段，不先对每篇做人工精改。通过当前资格检查的成功项保留。
- 共性校验误报先用真实保存稿、付费响应及封存来源复现；生产任务停止后统一修正规则，并验证真实正例与否定、假设、错误归属等负例。不能在运行中改解析实现、把构造正例当真实稿，或借实现升级重置请求次数及费用。
- 批次轮次不重置 Reader 候选、原尝试、失败或费用，不自动授权新的付费轮。运行级故障阻止新论文和新轮；预算、来源或身份阻断仍须受控处理。

### 原预算与有界人工修正

- 当前完整 Reader 解析已执行并发现不同问题时，旧连续失败的停止条件只约束原问题组。须核对旧问题与两种原签名完全一致、新阻断中不再含旧组、原内容响应额度仍有余额，才可继续使用原余额；完整长文已用完 2 次时，还须全部新问题均有明确路径并被 1–8 个旧 SHA 绑定的既有局部节点完整覆盖，来源不需整稿重试，禁止整组操作或任何全文回退；不清零历史计数、不安装新许可。同组新增缺项、数值阈值变化、缺失签名、归一化先失败或传输/来源阻断仍停止，详见[原余额恢复](docs/reader-explicit-retry.md#正常候选中的原余额)。
- 多轮后只剩少量顽固项时，`manualHandoff` 仅报告人工接手建议；须绑定原来源、失败稿SHA和获准修改范围，修正后重跑正常完整校验与审查。不能手填成功、删失败或跳过Source/Reader检查，详见 [三流程恢复](docs/three-workflows.md#全批轮次与失败集合)。
- 日更人工清单须覆盖完整当前失败集合，每篇仅改1–8个已有节点；通常最多10篇，大批次按原封存入选集10%取整增加且硬限15篇，超过10篇时重新核对原封存清单与完整唯一集合。原次数、无进展和费用不变，仍须通过正常整篇资格及博客审查，详见[人工修正约束](docs/reader-explicit-retry.md#少量顽固稿的来源绑定人工修正)。
- 已完整签名的日更 Reader 尾部修正可显式使用 `batch --reader-signed-corrections`，绑定完整父稿 CAS、严格 Reader-only 反馈及原退休付费稿。v1 只允许一项有界中文术语替换；v2 保存完整父稿，限定 1–8 个既有节点内受拒原句的精确范围，按真实付费稿与全部人工历史重放。默认不改变原公式、图片与表数量，表绑定变更另须同一完整 DOM 原表的逐项证明。不得复活退休候选、增加模型额度或手写通过状态，仍须通过正常解析、来源、整篇资格及独立博客审查，详见[签名稿修正](docs/reader-explicit-retry.md#已签稿的有界事实修正-v2)。

### 日更来源与恢复入口

- `npm run deep`、`npm run batch`、`npm run reanalyze` 和 `npm run api:reader:refresh` 都是**日更封存来源的恢复入口**。它们只读取当前正式分析结果的 `dailyFreshSourceRun`，并核验 `batchDate`、完整论文集合及每篇 `source.txt`、`source.pdf`、来源元数据和清单的对应关系。它们不重新抓取、不补建来源文件，也不读取旧文本或缓存。旧成功记录未绑定当前这组封存文件时必须重分析；Reader 刷新会直接拒绝。文件缺失或 SHA 不符时，在模型和图片请求前停止。目标日期仍为北京时间当天时，重新运行 `npm run digest:prepare -- YYYY-MM-DD`；历史日期保留失败记录，按历史维护流程处理，不重新抓取。
- 只续深度分析：`npm run deep -- --date YYYY-MM-DD`。
- 强制全量重分析：`npm run reanalyze -- --concurrency N`；本次首次准备每篇时执行获准的重置，后续失败轮继续同一候选和预算。选定重分析也不按轮重复重置。
- 刷新 Reader/评分：`npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader`；未传并发时使用配置默认5，可覆写1–60，总轮数默认3，可用 `--rounds N` 覆写1–10。只重跑明确可重试项，来源计划/运行级/存储故障停止补派；Reader 图片仍只在当前调用的系统临时目录中准备。
- 历史日期不能从抓取阶段开始；只可使用已有受控数据，运行 `./run-daily-digest.sh DATE --from generate|review|push|visual` 等代码允许的阶段。

### 锁、失败记录与事实反馈

- 失败记录必须保留 `analysisManifest`、检查点和恢复图片清单。旧成功正文可保留，但最新失败必须强制后续重试；成功后才清除失败标记。
- 来源绑定的定向事实反馈在模型请求前，须持论文锁核验并持久化原包与 `analysisFactReviewObligation`。旧正文或旧反馈已经通过不代表这次纠错完成；未完成义务及最新失败都阻断成功状态和发布。只有真实正常分析或受控修正返回、当前反馈和完整资格均通过后才清除；普通状态查询、无反馈续跑和合并不得洗掉失败或授予新额度。
- 同篇分析必须持有规范化 arXiv ID 锁，在锁内重读数据、合并结果并递增 `generation`，禁止用锁外读取的陈旧对象覆盖正式分析结果。
- ICML/OpenReview 默认不接受替代 PDF。唯一经用户授权的跨标题预印本例外是
  `conference:icml:2026:openreview-forum-id:n1mAjfRDZ6`：必须由代码白名单中负责保存来源的程序核验 poster/forum、
  固定 SSRN 标题、作者、DOI，以及 PDF、获取凭证和来源 SHA；浏览器下载只能经 `--import-file` 导入并记录
  `networkResponseObserved: false`。计划、模型输入和最终页面必须明确提示非 camera-ready；不得推广到其他论文。

## 内容与评分检查

### 会议恢复与已完成上游

会议完整结果只更新页面时，先核对原 process 全部成员已经完成，再用受控实现迁移重暂存单篇和完整汇总，复用原分析、Reader、评分及费用。来源计划按归档原词表 SHA 只读溯源；已完成会议的旧标签阶段须按原词表及原升级链完整重放，当前页面再按现行词表核验标签、主任务、主方法及概念 ID。原记录不得补签或改写；这种只读发布资格不能用于分析调度的成功或跳过判断。已有 `publish.json` 的 process 重复生成只返回原发布状态，更新已有正式页面须走历史维护入口。

完整会议迁移先统一后处理全体，再收集失败集合；旧完成稿的付费恢复须显式使用同一 `conference:migrate-process` 的 `--retry-failed`。恢复保留父稿和费用，在同一认证来源下创建可追溯子运行，复用公共失败轮次；上游可核验时先封存正常资源预检，资源字段不变则只刷新 Reader，影响原评分则正常刷新评分＋Reader；旧 Unicode 输入或核心分析不合格时正常完整分析。每篇成功即时保存；中断恢复核验父子连续链，不能把原完成稿改成未完成来绕检查，不能为重试清零旧预算或更换已绑定的预检及模式。详见[会议页面恢复](docs/conference-workflow.md#已有完整会议只更新页面)。

会议 `conference:process` 外层并发默认1、`conference:migrate-process` 默认3，均可显式设置 `--concurrency N`（1–60）。Reader 仍受原 `PD_API_READER_CONCURRENCY` 限制，正常完整分析修订最多占用原主分析配置下的3槽，每篇内部并发仍为1；调度并发不改变来源计划、模型、请求额度或整批轮次。

会议 Reader 的完成和冷启动资格检查都须重放已核验的真实来源上下文；确已保存的新子稿先复验，再增加尝试或请求模型，继承父稿不能替新失败作证。共享核心摘要修复的诊断按真实会议 ID、执行及来源 SHA 隔离，日更仍使用原 arXiv 身份，不为共享修复伪造来源身份。

显式独立恢复的正常完整分析先从已绑定原完成父稿重放原词表规则，不能要求待修复的未完成子稿已经具有完整标签证明。Reader-only 和评分＋Reader 的原子稿标签保护保持严格；最终新稿必须核验自己的正常标签阶段，不能借父稿规则手填通过。

显式会议失败迁移中，既有正常分析子运行的核心摘要被拒且原外层仍有余额时，可按重算的完整输入身份选择唯一最新原付费请求，调用同一公共严格重验；最新缺链或仍不合格即停止，不挑旧响应或追加摘要请求。其余十二节、原费用和各阶段预算保留；默认日更、历史及首次会议分析不启用索引，详见[会议恢复](docs/conference-workflow.md#已有完整会议只更新页面)。

独立追加窗口的再次恢复也须将原付费摘要重验开关传递到公共引擎，以当前新子稿的执行、来源和唯一最新原请求为准。原失败稿的 seed 复验不能替代新窗口后来保存的响应，外层余额也不能重授已用尽的摘要请求。

评分＋Reader 子运行没有新评分检查点且已有失败历史时，新增轮次和评分请求前直接阻断；继承的父稿完整评分不能证明本次评分刷新完成。即使最后错误是可重试传输失败，也可能已经消耗此前的内容响应，缺少可持久重放的消耗记录时不能重开三次评分。单次逻辑请求内部的正常传输重试不变；保存的新评分检查点通过真实来源重验后仍可只续 Reader。不能根据缺失原响应的错误文字改签评分或再次重付。

独立会议恢复窗口进入第二轮及以后正常分析时，在推进轮次前持久保存原失败非 Reader 阶段的模型请求禁令，后续只增不减；标签修复等不能因显式重入重新获得单阶段次数。允许该阶段正常纯校验或唯一原付费响应重验；纯校验后来通过也不解除已保存禁令。未失败的后续阶段仍受各自原上限控制，Reader 继续使用跨轮累计账本，不能用这份禁令代替预算证明。

会议最后完整失败集合的人工 Reader 修正使用同一迁移入口的显式 `--reader-corrections`，与真实已登记恢复许可及全部原 CAS 绑定；须在全轮结束、当前实现后处理完成后执行。每篇1–8个已有节点，硬禁模型/网络，保留原稿、候选、次数和费用，正常整篇资格及页面后处理通过后才采纳；无候选旧签稿及上游失败不适用。详见[会议零请求修正](docs/conference-workflow.md#最后失败集合的零请求-reader-修正)。

候选恢复还须保留历史直改的真实来源路线。会议子运行额度与 process 窗口分别核验，不能因实现变化自动授新付费许可；默认耗尽后只可对原已付候选做硬禁新模型请求的正常复验，仍失败则保留阻断。用户明确批准完整剩余集合的新付费恢复时，只能使用同一迁移入口的 `--retry-failed --recovery-manifest ABSOLUTE_PATH`：不可变登记原失败集合、来源与父子稿 CAS，另建独立窗口；最多3轮且 Reader 跨全部新轮累计6次内容响应、完整长文2次。原稿、次数、连续失败和费用不清零，中断使用同一许可，不自动追加第二笔；新窗口及冷发布仍走正常完整核验，见[会议追加恢复](docs/conference-workflow.md#原额度耗尽后的独立付费恢复)。摘要诊断也须使用历史直改本次运行和来源凭证，不借用日更身份。

旧活跃会议 Reader 的零请求恢复须核对唯一原付费链和归档 Prompt 字节，在私有禁模型范围内沿用原声明；真实来源及 PDF 能力贯穿正常解析与整篇资格。不能给旧稿补写新版 Prompt 身份，也不能把这份只读声明用于新请求或重置次数。

Reader-only 完成核验须按真实原父包与子包组合重放签发上下文，只读且禁止模型；原恢复型约束仍按原签名核验。旧父恢复须在进入分析前验证真实主分析检查点，保存前保护原主文、摘要、评分、标签和非 Reader 阶段，错误时恢复内存；不得先失效原上游再报错。详见 [Reader 事实反馈](docs/reader-explicit-retry.md#已完成主文的独立-reader-事实反馈)。

核心专用恢复使用 `reanalyzeSelected(ids, { coreFeedbackFiles })`。论文锁内由公共反馈保存器归档原包，再独立进入核心单节范围；没有主文父包时不能把核心包伪装成父包。普通续跑必须恢复同一范围，禁止主文模型；核心阶段逐字保护其余十二节，再正常复核八维评分与必要 Reader，保留历史、次数和费用。已清理临时检查点的完成稿须先在只读原事实上下文核验完整上游、四源和旧 Prompt，再恢复最终正文作为本次运行检查点；不得伪造历史中间稿或把旧阶段改签为当前版本。仅 Reader 中断时，须绑定已通过核心的当前事实包及评分输出 SHA 后复用真实新检查点，不能重复支付摘要和评分；不完整旧快照保留并跳过。

### Reader、来源与页面内容

默认 API 正式分析正文的 13 个一级标题用于机器解析。最终博客正文来自 `beginner-researcher-v3` API Reader；表格与公式的来源另由 `api-reader-source-bindings-v4` 记录和核验：

- 文章包含 12–18 节、5000–18000 中文字和 4–10 组术语组合解释。
- 首次出现的术语须用白话解释；介绍组合机制时须说明各部分的分工、搭配原因和新增作用。
- 表格前须说明比较问题，表格后须解释结果及其限制。原文证据充足时，应覆盖数据协议、主结果、消融/失败条件和训练/部署成本。
- 每个表格单元格必须对应原表 DOM 单元格，或用全文逐字引文覆盖全部数字与单位；展示公式只能由程序将结构化来源中的原始 TeX 写入正文。
- 会议及历史 PDF 的正常 Reader 表格补证须来自本次认证来源的真实 PDF，唯一核对原表范围、表头或明确表注、行标签及数值列，并保存可冷重放证明。不能伪造日更封存根目录、HTML DOM 或原 TeX，不能借另一张表、正文定义或图轴给未注明单位的原表补单位。旧完整会议的出版补证入口仍只接受其原完整分析，不能拿来为未完成稿签通过。
- 多层 PDF 表须先闭合完整原表、各层列路径和条件行带，再定位所选行列；不能按选中数字猜分组。PDF 资源脚注须从同篇真实 PDF 的同页同栏声明、附着上标和唯一同号 URL 重新导出证明。作者当前释放声明不等于网址可达；未来、否定、第三方及歧义声明不得当作已开放。旧资源身份纠正只能产生独立来源提案，不能就地改原预检、固定模式或评分签名。
- 作者姓名与机构须逐项对应 HTML DOM、论文元数据，或明确的不可得状态；资源链接须逐项对应原文/Demo 证据、重定向终点与可达状态，只有 `available` 可支撑“已开源/可用”声明。
- 汇总页 `reader-facing-v3` 中排行榜及中英文题目都指向独立博客；标签/评分不重复，排名、文档类型和 arXiv 位于评分后、作者机构前；汇总页和单篇页的可见 HTTPS URL 必须可点击。
- 新发布页面在 Hugo `tags` 扁平字段中只写当前词表中有效的中文首选标签。唯一例外是 `CNN/RNN/SFT/CTC/LoRA/Adapter/Transformer/Conformer` 这 8 个既定英文专名，可保留原形，但每个必须配至少一条中文别名。页面还须写入并验证 `paper-tag-flat-tags-v2`、词表 SHA、逐标签 `{id, facet, label}`、显式主任务与主方法。旧页面和旧标签 URL 不批量改写。兼容期汇总“热门方向”只统计主任务；标签页必须明确标示新旧混合，不能把扁平标签计数当作按九个分类维度统计的结果。
- 论文图须依次呈现导读、看图路径、原图、图注和解释；未传入像素不得猜坐标轴、曲线、颜色或模块。
- 日更、会议和历史更新共用新版目录的386项九维词表，禁止目录外标签。总目录保留零计数方向；文章及汇总卡片仅显示实际选中项与祖先路径，不显示空分面或兄弟概念，不把祖先写成额外直接标签。原262项仅纯追加升级，旧签名按归档原SHA只读重放。会议和历史发布须核对站点双份版本目录及本次快照，未同步先阻断，详见[统一标签规则](docs/tag-display-policy.md#三条流程共用的目录与呈现)。
- 源Markdown保留共享多级分类块用于审查及离线阅读；单篇网页仅在已核验页头分类确实呈现、正文恰有一对完整有序边界时去掉重复分类，汇总仍逐篇保留，缺失或异常标记不得猜测范围或手删Reader正文，详见[呈现与页面更新](docs/tag-display-policy.md#已发布页面切换到当前呈现)。
- 日更封存 SVG 缺失或循环引用绘图定义时，发布器可从同篇四源绑定的封存 PDF 恢复完整原页；须唯一匹配原图号和完整图注，标明 PDF 页码，并在 schema v3 清单保存、审查与推送重算 `reader-sealed-pdf-page-asset-v1` 派生证明。原 Reader、原 SVG 和原模型像素 SHA 保留，不能把新原页像素冒充旧模型输入，不能猜补图元、裁切边界或借用会议来源身份。
- 评分使用八个维度，按文档类型判断适用证据。每个缺陷只归一个主要维度，代码重算总分并封顶 10。缺失证据不得写成技术错误。
- 摘要级分析默认不可发布；只有显式 `allowAbstractAnalysisPublish: true` 才允许并显示降级提示。

## 博客三阶段与远端证明

严格顺序：

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

`generate` 生成页面和 schema v3 页面清单；`review` 只读审查最终文件，记录逐页 SHA、协议、审查所依据的博客 Git 提交与 Hugo 构建检查结果；`push` 只提交审查凭证允许的精确差异，并在推送后验证远端 `main` OID。

已有完整日批已发布、用户明确要求更新呈现时，显式使用 `npm run blog:generate -- --date YYYY-MM-DD --republish UUID`，之后仍正常 `review → push`。该入口核验原发布、当前远端祖先、完整同来源/分析和受控文件，按UUID不可变备份旧证据后退休旧活跃指针；不允许all、选定子集或自定义数据。待激活事务阻断普通生成/审查/推送，须以同日期同UUID恢复；不能手删凭证或伪造fresh提升。新发布后重新绑定部署、全页核验及已获准的视觉豁免，详见[重发布协议](docs/data-format.md#同来源同分析的日批重发布)。

发布器代码变化时仍须重新生成页面，以发现实际内容变化。逐页审查通过记录按“相对路径 + 页面内容 SHA”永久复用，只有内容 SHA 变化才重审已通过的文件。生成清单元数据、模型、发布器代码、审查协议指纹或 Hugo 运行时变化，只要求重跑当前批次检查并生成新的审查凭证，不能让字节未变的通过页重审。内容失败页没有通过凭证：原协议与当前协议均为合法 SHA 且确实不同时，可进入正常整页重审；相同、缺失或非法协议不授权重审。所有原失败、响应与费用须保留，不手填通过。审查所依据的博客 Git 提交、远端身份或凭证与当前批次不符时，仍须阻断推送。审查任务不得原地修改已审文件；修正建议须交回生成或修复阶段。

已授权的独立人工审查 v4 只将文章 Markdown 交给语义及逐图审查；清单内引用资料、词表和受控论文图以 `machineAssets` 复用正常来源、字节及已审引用页核验。最终发布凭证仍须精确覆盖完整并集，不能漏资产、将二进制当 Markdown 或伪造资产的人工身份。站内原图地址必须与当前清单及字节一致，见[独立审查](manual/README.md)。

单图审查输入须区分相邻图片共享的前图解释与本图导读，保留完整原段，不把前图特征强套给当前像素，也不因此豁免本图真正的图文冲突。

`digest:status` 里的 `remoteOidVerified` 只证明 Git 提交已到远端。对用户宣告博客已上线或任务已完成前，还必须确认 GitHub Pages workflow 的 build/deploy 均成功，并逐页核验目标日期汇总页及已发布单篇的 HTTP 200、正式地址和标题。部署 workflow 必须对应发布提交，或保留该批次已审页面字节的后续提交；保留部署与页面核验记录。部署失败时读取失败日志、修复并继续检查；`digest:status` 显示 complete 也不能代替上线核验。

新建独立人工审查须实际使用 `gpt-6.1-sol/high`，v4 声明和 `manual-agents-sol-high-v2` 如实绑定每页子代理身份；旧模型声明仅可读取原记录，不能给新审查补填身份。

图号审查区分送审位置“图片 K”、封存来源 DOM 条目“论文图 N”与作者印刷的“Figure M”。只有当前来源映射通过核验时才解释三者差异；N 不必连续或等于 K、M。原图注的概括性标题本身不能证明配错图，真实标签、资产与科学内容冲突仍阻断发布。

## 发布后视觉与完成定义

push 远端验证后才可规划视觉任务。TOP 10 论文各一张长图，另有一张汇总封面；实际生成只能由 Codex 内置 `image_gen` 完成，项目脚本不得调用图像 API。

用户已明确取消视觉时，`--no-visuals` 仍建立与真实发布绑定的任务清单再登记豁免，但不得执行 `visual:prepare` 或生图。封存来源的临时图片模式只核对已签图片身份，合法内联 SVG 按其来源与渲染证明校验，参考图片列表为空，不重新请求像素或恢复缓存。发布后规划失败按 [恢复说明](docs/troubleshooting.md#11-视觉-pending-或-record-失败)重建清单后登记豁免，保留已有发布凭证。

调用生图前运行 `npm run visual:prepare -- --date DATE`，只把输出的绝对 `referencedImagePaths` 交给工具。逐图目检标题、中文、箭头、指标方向、数字和排行榜后，才可用对应 `record --qa-attested true` 登记。最终重新运行：

```bash
npm run digest:status -- --date YYYY-MM-DD
```

只有数据、审查、远端发布、部署及网页核验全部通过，且论文长图与封面均完成，整批才算完成。只有用户明确同意取消视觉，并记录与当前发布绑定且仍有效的豁免时，才可省略视觉。状态报告只反映读取时的状态，尚未自动检查部署和网页；后续任何推送或图片登记后都须重新读取。

## 修改与验证

- 文件编辑使用可恢复方式，保留用户无关改动；禁止未授权 `git reset --hard`、强推或批量删除。
- 提示词文件的第一个围栏代码块是 `loadPrompt()` 实际读取的内容；修改后检查占位符、解析器、SHA 和阶段指纹。工作树只保留当前登记的 18 份模板；旧记录的提示词由 Git blob、原路径和原 SHA 受控只读核验，不修改旧声明或补签结果。
- 新 LLM 调用复用公共路由/请求封装；新分析入口复用 `analysis-engine.js`；新路径进入集中配置。
- CI 运行 `npm test`、`npm run validate:data -- --allow-empty`、三流程及旧记录兼容 JS/Python 检查及全仓 shell 语法检查。 普通 push 不触发远端 CI；稳定的一轮修改通过定向检查与交叉审查后主动运行一次，PR 仍自动检查。保留完整覆盖，按实际最终提交核验全部检查，见[维护指南](docs/maintenance.md#什么时候运行远端-ci)。
- 提交信息使用具体中文，说明原因、范围与影响；提交前确认 `data/`、`logs/`、`.env`、缓存和密钥未被跟踪。
