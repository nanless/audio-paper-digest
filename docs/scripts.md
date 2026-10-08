# 默认 API 命令与脚本职责

## 如何使用本页

本页按任务列出操作命令。逐文件职责见 [scripts/README.md](../scripts/README.md)，别名以 `package.json` 为准；Manual 内部命令见 [manual/README.md](../manual/README.md)。示例中的 DATE、ID、UUID 和大写路径是待填写参数，方括号表示可选参数，竖线表示择一。

## 工作区角色

生产命令前先运行：

```bash
npm run workspace:role -- status
```

日更 `digest:*`、`fetch`、`blog:generate/review/push` 和新会议 `conference:new:*` 使用 `daily`。历史 `history:*`、旧会议 `conference:*` 维护入口、`rewrite:source` 和 `blog:activate-fresh` 使用 `history`；不能把新旧会议命令混用。

首次确认用途后，用 `npm run workspace:role -- set daily|history` 绑定。整库复制后，角色标记仍指向旧真实路径；确认副本用于历史工作后才执行 `npm run workspace:role -- set history --force`。标记是 Git 忽略、权限为 `0600` 的本机文件。

默认不允许跨角色执行：`daily` 工作区跑 `history:*` 会被拒绝，反过来也一样。用户已决定在当前日更目录跑历史功能，所以本机 `.env` 设了 `PD_WORKSPACE_ALLOW_CROSS_ROLE=1`。值为 `1` 时放行「daily 工作区执行 history 命令」，脚本会打印一条跨角色提示；反向仍然拒绝，`workspaceRealpath` 与真实路径不符也照旧拒绝。开关只放宽入口检查，不解除两个工作区不得同时生成、审查、推送博客的约束，时间要由使用者自己错开。

## 日更脚本阶段与最终状态

| 命令 | 用途 |
|---|---|
| `npm run digest:prepare -- DATE` | 完成默认数据与 Git 发布阶段，准备视觉输入 |
| `npm run digest:api -- DATE` | 上一命令的等价别名 |
| `./run-daily-digest.sh DATE --from STAGE` | 从程序允许的阶段恢复 |
| `npm run digest:status -- --date DATE` | 读取当前最终状态 |
| `npm run digest:waive-visuals -- --date DATE --reason TEXT` | 用户明确取消生图时记录视觉豁免 |

`digest:manual` 只在用户明确选择人工流程时使用。默认入口退出 0 只表示脚本阶段通过，不代表整批完成。

完成还要求对应发布提交，或保留本批已审页面字节的后续提交，已成功完成 GitHub Pages build/deploy；人工逐页核验汇总和单篇页面的 HTTP 200、正式地址与标题，保存记录。长图和封面须由内置工具生成、目检并 record，或有仅针对视觉的有效用户豁免。最后重读 `digest:status`；它尚未自动核验部署或网页。

## 数据阶段

| 命令 | 行为 |
|---|---|
| `npm run fetch` | 归档、抓取、筛选和分析，不发布 |
| `npm run deep -- --date DATE` | 只读取当前已保存的文本/PDF，续跑未完成分析 |
| `npm run batch` | 批量处理正式分析结果中未完成的论文 |
| `npm run batch -- --retry-failed-readers` | 归档并停用未完成论文的失败 Reader 候选，然后续跑，不影响已完成论文 |
| `npm run reanalyze -- --concurrency N` | 归档并停用全部旧失败 Reader 候选，清空 Reader/图片补充状态，再用绑定来源强制重分析 |
| `node scripts/reanalyze-selected.js ID...` | 重分析指定集合；统计口径实现见 `scripts/lib/reanalysis-helpers.js` |
| `node scripts/refilter-reanalyze-by-date.js DATE` | 受控的历史日期重筛与重分析；实现见 `scripts/lib/reanalysis-helpers.js` |
| `npm run api:reader:refresh -- --all --date DATE --concurrency N --scoring-and-reader` | 从绑定来源批量刷新评分和 Reader，图片只为本次调用临时准备 |
| `npm run validate:data` | 只读核验当前数据 |
| `npm run keyword:recall` | 按金标准重跑关键词预筛 |
| `npm run backfill` | 只补录历史论文 ID |
| `npm run paper:rethink` | 历史独立维护工具，博客已取消集成，读者无需启动；见[历史说明](paper-rethink-companion.md) |

`full-fetch.js` 只抓取其启动时的北京时间当天。后台只处理数据时可直接运行 `node scripts/full-fetch.js`，避免 npm/TTY 包装干扰；仍须遵守相同环境、角色和沙箱外运行要求。

`deep`、`batch`、`reanalyze` 和 `api:reader:refresh` 只读取 `deep-analysis-result.json.dailyFreshSourceRun` 指定的文件，并核验 `batchDate`、论文集合及每篇 `source.txt`、`source.pdf`、runtime 和 manifest。它们不补抓来源或使用旧缓存。这些文件缺失、损坏或 SHA 不符时，程序在发出模型或图片请求前停止。目标仍为北京时间当天才重新运行 `npm run digest:prepare -- DATE`；历史日期保留失败记录，按历史维护处理，不能手改检查点。

## 博客事务

| 命令或参数 | 职责 |
|---|---|
| `npm run blog:generate -- --date DATE` | 生成页面和 generation manifest |
| `npm run blog:review -- --date DATE` | 只读审查、Hugo 检查并生成审查凭证 |
| `npm run blog:push -- --date DATE` | 提交精确改动、推送并核验远端 OID |
| `--include-id ID` | 限定单篇范围，适用阶段保持同一 ID |
| `--exclude-id ID` | 生成时显式排除，可重复 |

页面清单以 `generation-input-source-reference-v1` 记录实际选择的 current、日期 archive 或 `--data-file`，其绝对路径、字节数和 SHA-256 都进入输入指纹。review 与 push 只重读这个文件及其 `dailyFreshSourceRun`，不退回当时的 `DEEP_ANALYSIS_RESULT_FILE`。输入或已保存的文本/PDF 不符时必须重新 generate。

通过的逐页审查永久按“相对路径 + 内容 SHA”复用。发布器变化仍重新渲染；清单、代码、模型、协议或 Hugo 变化须执行本批检查并生成新的审查凭证。只有页面内容 SHA 变化才重审该页，基线和远端身份检查仍不能省略。

三个入口先取得博客 Git common-dir 下的共享锁，再取得项目日期锁。两个工作区指向同一博客时，不能同时修改工作树、index 或 HEAD。共享锁不进入博客工作树或提交；回收和释放只删除 inode、token、SHA 仍匹配的锁文件。`publish-to-blog.py` 是共同实现与生成兼容入口，不能绕过三阶段。

默认博客与视觉入口经 `scripts/python-runtime.sh` 选择 Python，优先项目 `.venv`，要求 Python 3.11+ 与 OpenSSL。

## 会议论文

新会议在日更工作区获取官方来源、发现候选、准备全文证据并筛选。筛选后统一使用 `conference:new:process`，由它完成 PDF 的保存与核验、导入、逐篇分析、Reader、评分、分类和私有页面生成；不能使用已禁用的 `conference:new:execution/analyze/postprocess` 别名绕开它。

process 的整批并发默认 1，可用 `--concurrency` 设为 1–5，每篇内部分析并发固定 1。先用已通过核验的候选清单、报告文件名和筛选任务 UUID 预览：

```bash
npm run conference:new:process -- --dry-run --catalog catalog.json --report report.json --filter UUID
```

页面生成后，独立的 `conference:new:publish:generate/review/push/status/verify` 处理发布与检查；这些入口均须提供 `--conference-id` 和 `--process-id`。命令存在不代表来源、审查或线上验收已通过。

旧 `conference:*` 保留在历史工作区用于已有独立发现、筛选、提取、暂存、导入、计划、执行、分析和后处理记录的维护；旧后处理并发上限 3，不是新 process 的配置。准确参数、恢复条件与审查文件格式见[会议论文工作流](conference-workflow.md)。

## 全历史重写

### 来源与计划

`npm run history:inventory -- --dry-run` 只读扫描历史页面、URL、汇总链接、Git tracked tree、日期/cohort 和待核旧标签 URL，只保存正文 SHA，不保存旧正文或附属文件路径。确认博客处于干净 `main` 后才写入：

```bash
npm run history:inventory -- --apply \
  --ledger all-history.json --receipt all-history.receipt.json
```

两份文件保存到受保护的 `data/runtime/historical-page-inventories`。当前 `direct-local-first` 从冻结页面的唯一 arXiv 提示和已核验会议来源创建计划，不等待来源对照表（crosswalk）结果。arXiv 每个 `generation` 都重新保存并核验官方文本、PDF、来源元数据与清单；会议核验保留的本地元数据/PDF。这里的 generation 是获取序号，与论文修订号 `vN` 不同。

下面文件参数使用绝对路径；先预览，再显式写入。首次生成本地来源清单前须准备缺失 PDF，不能覆盖旧不可变文件名。OpenReview 可达时优先官方来源；替代来源仅限代码白名单。

```bash
npm run history:openreview-pdf-source -- --apply \
  --snapshot /abs/data/icml2026/papers.json --forum-id OPENREVIEW_ID
npm run history:icml-alternate-pdf-source -- --apply \
  --snapshot /abs/data/icml2026/papers.json --forum-id jfpkqjhex4
npm run history:icml-alternate-pdf-source -- --apply \
  --snapshot /abs/data/icml2026/papers.json --forum-id n1mAjfRDZ6 \
  --import-file /abs/downloads/ssrn-6288899.pdf
npm run history:conference-local-sources -- --apply \
  --icml-poster-snapshot /abs/data/icml2026/papers.json \
  --icml-pdf-root /abs/data/pdfs/icml2026 \
  --icml-fresh-pdf-root /abs/data/runtime/historical-icml-pdf-sources \
  --openreview-receipt-root /abs/data/runtime/historical-openreview-pdf-sources \
  --alternate-receipt-root /abs/data/runtime/historical-icml-alternate-pdf-sources \
  [--output conference-local-sources-v2.json]
npm run history:direct-inputs -- --apply --conference-manifest /abs/conference-local-sources-v2.json \
  --inventory /abs/all-history.json --blog-root /abs/audio-paper-digest-blog [--name scoped-historical-local-data-v5.json]
npm run history:conference-projections -- --apply --catalog /abs/scoped-historical-local-data-v5.json \
  --inventory /abs/all-history.json [--output conference-page-projections-v3.json]
npm run history:direct-plan -- --apply --catalog /abs/scoped-historical-local-data-v5.json \
  --inventory /abs/all-history.json --conference-projections /abs/conference-page-projections-v3.json \
  [--output direct-rewrite-plan-v5.json]
```

只有无版本 current arXiv PDF 明确返回 HTTP 404，才允许使用同一论文的官方历史 `vN` PDF。这条路径拒绝跨 ID、query、fragment 或非官方主机，并从实际选择的 PDF 提取文本。`sourceVersion` 记录尝试的 URL/状态和选定版本 URL，核验它与来源清单、分析来源及页面清单的对应关系；分析和页面 front matter 下方须提示当前稿 PDF 不可用。普通来源文件保持原有字节和格式兼容。

唯一允许跨标题预印本的 `n1mAjfRDZ6` 可在 SSRN 经代理可达时直接获取；只能浏览器下载时用 `--import-file`。导入器核验固定标题、作者、日期、多个跨页特征文本及白名单 DOI，记录 `operator-browser-download` 和 `networkResponseObserved: false`，不伪造 HTTP 200。计划、模型输入和页面须说明非 camera-ready。输入副本在保存并核验后可删除；恢复核验运行目录中的 PDF 和核验记录，不修改旧 JSON。普通会议 plan v5 结构保持兼容。

### 执行、暂停与状态

```bash
npm run history:direct-scheduler -- --apply --plan /abs/direct-rewrite-plan-v5.json \
  [--queue all|arxiv|conference] [--generation N] [--paper-ids ID[,ID...]] [--max-papers N] \
  [--arxiv-concurrency 1-8] [--conference-concurrency 1-8]
npm run history:direct-run -- --apply --plan /abs/direct-rewrite-plan-v5.json \
  [--queue all|arxiv|conference] [--generation N] [--paper-ids ID[,ID...]] \
  [--max-papers N] [--concurrency 1-8]
npm run history:status -- --plan /abs/direct-rewrite-plan-v5.json [--generation N] [--watch-seconds N]
npm run history:status -- --plan /abs/direct-rewrite-plan-v5.json [--generation N] --verify-sources true
npm run history:status -- --plan /abs/direct-rewrite-plan-v5.json --publication-id UUID
npm run history:pause -- --plan /abs/direct-rewrite-plan-v5.json --phase source|analysis [--generation N]
npm run history:resume -- --plan /abs/direct-rewrite-plan-v5.json --phase source|analysis [--generation N]
```

`direct-run --apply` 要求同一 plan/generation 的 scheduler status 已保存，且所选论文全部 `ready`；它不补做来源获取。分析失败可保存来源对应的检查点并跨进程续跑，只有 analysis、Reader 和来源证明完整时才生成私有页面。scheduler 的 arXiv/会议并发分别默认 3/5，范围 1–8；direct-run 默认 3，范围 1–8。

暂停请求等待已开始的来源或论文处理完成；相应操作锁释放后才用同 phase 的 resume。普通 status 是只读快照，`--watch-seconds` 持续输出 NDJSON。`--verify-sources true` 单次重新计算所有本地来源 SHA，不能与 watch 同用。

未传 `--publication-id` 时，普通/watch 状态完全离线，只说明未选择发布。传入后默认现场核对远端 main 与审查凭证中记录的远端身份/OID；`--live-remote false` 只作离线诊断，不能得到 complete。发布状态是单次检查，不能与 watch 同用，并会深核全部 arXiv 文件和会议来源 SHA。

完整状态取决于计划的全部论文、来源、日汇总、会议汇总和精确任务页覆盖，以及绑定同一 plan SHA 的发布完成状态。数量从 plan/projection 推导，并非固定要求 4185 篇、109 日加 3 会或 193 任务；这些数字只能说明特定历史计划，不能当通用阈值。`completion.blockers` 会列出未覆盖页面、失败或未生成页面的论文、缺失汇总，以及未选择、未完成或计划不符的发布。

### 汇总与独立发布

```bash
npm run history:direct-aggregate -- projection --apply --plan-file /abs/direct-rewrite-plan-v5.json \
  --inventory-file /abs/all-history.json --output-name direct-aggregate-projection-v3.json
npm run history:direct-aggregate -- aggregate --apply --plan-file /abs/direct-rewrite-plan-v5.json \
  --registry-file /abs/direct-rewrite-registry.json --projection-file /abs/direct-aggregate-projection-v3.json \
  (--daily YYYY-MM-DD|--conference conference-key)
```

projection v3 按冻结的 `outboundPostLinks` 将会议任务页对应到论文成员，并保存逐页来源 SHA 和完整覆盖记录。选择会议汇总时，任务页与会议总页在同一运行生成，任务页先写，总页最后写。没有论文成员的日汇总明确标为 `retain-unchanged`，仍纳入覆盖检查。

实际发布使用 `history:direct-publication`，依次 plan、generate、review、publish、status。逐页通过记录只按路径与内容 SHA 复用，本批仍执行确定性/Hugo 检查并生成审查凭证。`activate --apply` 被禁用；`publish --apply` 在共享博客锁内处理激活、提交、推送和远端 OID。精确参数与视觉处置见[独立历史发布](history-direct-publication.md)。旧 `history:publication` 只提供 plan/generate 私有文件，不能用来真正发布。

正常 direct 任务不依赖来源对照表。`history:crosswalk` 仍可显式维护旧来源对照表：`prepare --apply`、`apply`、`apply-verified` 和 `finalize` 可以按来源授权及 CAS 检查写入状态或凭证，并非全部只读。备用 `history:arxiv-batch` 必须给出 `--handoffs NAME.json[,NAME.json...]`，只接受 scheduler/run 保存的命名、不可变的新 arXiv 获取失败交接文件，不枚举 pending 页面。会议本地来源缺失或损坏只使该项失败，不进入这条备用批处理。`history:local-crawl-batch`、`archive-crawl-batch` 和 `history:conference-crawl-batch` 已停用，不能写状态记录。详见[历史重写底座](history-rewrite.md)。

## 视觉任务状态

| 命令 | 行为 |
|---|---|
| `npm run visual:post-publish -- --date DATE` | 从已验证发布规划两类图片任务 |
| `npm run visual:prepare -- --date DATE` | 旧清单核验参考缓存并输出绝对图片路径；当前临时图像日更核验论文图身份后返回空引用路径 |
| `npm run visual:status -- --date DATE` | TOP 10 长图只读状态 |
| `npm run visual:record -- --date DATE --paper ID --kind infographic --file /abs/result.png --token TOKEN --qa-attested true` | 登记已目检长图；`--file` 可换成 `--output-hint HINT` |
| `npm run visual:fail -- ...` | 保存长图失败状态 |
| `npm run cover:status -- --date DATE` | 封面只读状态 |
| `npm run cover:record -- --date DATE --file /abs/cover.png --token TOKEN --qa-attested true` | 登记已目检封面；`--file` 可换成 `--output-hint HINT` |
| `npm run cover:fail -- ...` | 保存封面失败状态 |

只有 Codex 内置 `image_gen` 生成正式图片；`visual:render:debug` 仅用于调试或离线兜底。TOKEN 来自对应 visual/cover status 待办项的 `taskToken`，不能复用旧任务 token。

## 配置与公共实现

| 文件 | 职责 |
|---|---|
| `scripts/config.js` | Node 参数与当前数据路径 |
| `scripts/env-loader.js`、`scripts/project_env.py` | 项目环境及沙箱外运行检查 |
| `scripts/utils.js` | API 路由、代理、提示词、原子写入、时间与 ID |
| `scripts/llm-account-pool.js`、`scripts/llm_account_pool.py` | Node/Python 共用账号选择与冷却状态 |
| `scripts/analysis-engine.js` | 论文锁、重试、检查点与正式分析合并 |
| `scripts/deep-analyzer.js` | 单篇多阶段分析与 Reader |
| `scripts/path_config.py` | Python 发布路径 |
| `scripts/publish_common.py` | 发布数据、评分、LLM 与来源核验 |
| `scripts/publish-to-blog.py` | 博客生成、审查和推送的共同事务 |
| `scripts/python-runtime.sh` | 选择项目 Python 3.11+ 与 OpenSSL 环境 |

## 运行存储

| 命令 | 行为 |
|---|---|
| `npm run storage:status` | 只读统计 current、archive、logs 与重点缓存的大小和文件数 |
| `npm run storage:prune` | 扫描正式 JSON 引用，输出预计删除清单，不删文件 |
| `npm run storage:prune -- --apply` | 停止全部写入者并通过安全预检后，仅删除白名单中的超期未引用文件 |

`scripts/runtime-storage.js` 不删除正式分析 JSON、发布/视觉清单、博客或归档成品。status 和预览可在活动任务期间使用，真正删除前须停写；完整条件见[维护指南](maintenance.md#运行存储诊断与清理)。

## 可选渠道

`npm run wechat`、`npm run xiaohongshu`、`npm run xhs-login`、`npm run xhs-publish` 和 `python3 scripts/publish-to-feishu.py` 不属于默认日更。只有用户明确要求时才执行真实渠道写入。

## 测试

```bash
npm test
npm run test:default
npm run test:manual
npm run validate:data -- --allow-empty
```

`--allow-empty` 仅用于 CI 或干净无数据检出。CI 还检查默认/Manual JS 与 Python、两处 Python 单测和全仓 shell 语法。所有项目检查都在沙箱外运行；完整 verify 与 quick 的差别见维护指南。
