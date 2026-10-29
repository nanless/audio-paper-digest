# 全历史博客重写流程

本页说明如何从论文原文重新分析全部历史论文，生成单篇页、每日汇总、会议汇总和会议任务页。当前流程称为 `direct-local-first`：会议论文使用通过核验的本地论文信息和 PDF，arXiv 论文在新一轮来源获取时重新保存官方文本和 PDF。正常任务不以旧对照表（`npm run history:crosswalk`）的身份确认或抽样试运行通过为前提。

全历史任务在当前 `audio-paper-digest` 工作区执行，先按 [AGENTS.md](../AGENTS.md) 核对 `daily` 角色与 `PD_WORKSPACE_ALLOW_CROSS_ROLE=1`。旧历史工作区已废弃，不再读取或迁移其中的运行资料。当前进度保存在本项目 `data/runtime/`。执行者须安排日更、会议、历史发布错峰；历史发布前同步代码和博客的最新远端基线，重新生成对应凭证。

```text
冻结现有博客清单 ─┬─ 提取已有的单一 arXiv ID 线索 ─┐
                  └─ 核对本地会议论文信息和 PDF ───┤
                                                  ↓
建立来源清单 → 确认论文与历史页面的对应关系 → 建立重写计划
                                                  ↓
                        准备来源 → 分析并生成暂存页 → 生成汇总
                                                  ↓
                                      审查、发布和网页验收
```

同一论文只进入一个分析任务，再为它对应的全部冻结历史页面生成新稿。以下绝对路径、UUID、日期和文件名须替换为真实任务输出；命令存在不代表历史现场已经完成。实际发布见[历史重写结果的审查与发布](history-direct-publication.md)。

## 正常执行路线

| 步骤 | 输入与动作 | 得到什么 |
|---|---|---|
| 冻结页面 | 在干净博客 main 上运行 inventory | 页面与 URL 范围、原字节 SHA 和清单凭证 |
| 建立对应关系 | 核对会议本地来源，合并 arXiv 身份，建立页面对应及计划 | 固定论文集、队列与未覆盖页报告 |
| 准备来源和元数据 | sources 核真实论文来源，metadata 补官方 Atom 发布资料 | ready 来源状态及可核验元数据 |
| 分析和暂存 | run 调用公共分析引擎 | 当前实现生成的合格单篇私有页面 |
| 生成汇总 | aggregate 核完整成员和页面覆盖 | 每日、会议及任务汇总 |
| 发布并验收 | 转到[历史发布](history-direct-publication.md) | 审查、精确推送、部署和网页证据 |

来源准备、分析和发布分别完成；不能用某一步 complete 代替其他步骤。下文先讲主链，特殊来源、补充维护、备用获取和旧断点恢复放在后面。

## 冻结现有博客清单

`history:inventory` 扫描配置的 Hugo 博客 `content/posts`，保存后续要保留的页面集合、公开地址及原字节指纹。它要求本机可以运行 `hugo`；permalink 和已发布集合以同次扫描的 Hugo 输出为准，不能由脚本猜测。

```bash
npm run history:inventory -- --dry-run
npm run history:inventory -- --apply \
  --ledger all-history.json --receipt all-history.receipt.json
```

清单记录 Git `main`、HEAD、离线可读取的 `refs/remotes/<remote>/main`、`content/posts` 的 tree OID、每页 Git blob 和工作树状态、远端身份、Hugo 配置及 base URL。每页记录稳定 `pageId`、相对路径，整页、页头（front matter）和正文各自的字节数与 SHA，以及已有 URL、aliases、发布日期、会议日期、旧任务键和 draft/published 状态、页面类型。正文和页头全文不写入清单，受限元数据另按白名单保存。Hugo 版本与 `list all/published` 集合 SHA 也进入记录；手写的 URL 对应关系必须逐页等于 Hugo permalink。

汇总页的每次行内内部链接都会记录字节位置、类型和解析后的目标 `pageId`、路径及快照 SHA。解析器要求方括号平衡，也处理标题内部的 `[]`。清单还记录受限论文身份线索、已有发布标记和旧标签的未核验候选 URL；候选 URL 不能当作已验证来源。

清单文件（`ledger`）不保存标题、描述或 Markdown 正文。旧正文只用于计算 SHA，以及提取上述受限身份和链接信息，不能进入后续分析或 Reader 请求。发布证据按字段白名单保存，字符串通常只保留哈希；只有逐项校验的少量枚举值和 ID 保留原值。附属文件、任意路径或 URL、未知 `paper_digest_*` 值只保留哈希或忽略。

`--apply` 要求博客位于干净 `main`。扫描前后只要 HEAD、状态、配置或页面字节改变，就拒绝写入。脚本在预留双文件之前、预留之后及写完之后重新核对同一仓库快照，防止扫描和保存之间发生变化。清单与凭证（`receipt`）以 `0600` 权限成对独占创建（`O_EXCL`），不能覆盖不同字节。

## 建立来源清单和重写计划

先用 `history:conference-local-sources` 建立会议论文信息与 PDF 的来源清单。该步不联网、不读博客正文、不调用模型；缺失 PDF 的处理见[会议 PDF 与特殊来源](#会议-pdf-与特殊来源)。随后 `history:inputs` 从冻结清单中已有的单一 arXiv ID 线索建立获取任务，并合并会议来源。

```bash
npm run history:conference-local-sources -- --apply \
  --icml-poster-snapshot /absolute/path/data/icml2026/papers.json \
  --icml-pdf-root /absolute/path/data/pdfs/icml2026

npm run history:inputs -- --apply \
  --conference-manifest /absolute/path/conference-local-sources-v2.json \
  --inventory /absolute/path/all-history.json \
  --blog-root /absolute/path/audio-paper-digest-blog

npm run history:conference-projections -- --apply \
  --catalog /absolute/path/scoped-historical-local-data-v5.json \
  --inventory /absolute/path/all-history.json

npm run history:plan -- --apply \
  --catalog /absolute/path/scoped-historical-local-data-v5.json \
  --inventory /absolute/path/all-history.json \
  --conference-projections /absolute/path/conference-page-projections-v3.json
```

后三个命令也接受 `--dry-run`，可以先检查再保存。不要向 `history:inputs` 传 `--arxiv-manifest`；它不接受另一份本地 arXiv 来源清单，也不会把旧 TXT、PDF、图片、分析或 Reader 当作重写输入。会议部分先核对冻结页面 SHA，再读取 front matter 的标题指纹，与本地论文信息精确匹配，不把正文用于创作。

会议来源优先使用工作区爬虫保存的记录。`accepted-local-iclr-*` 只有在它是某个冻结 ICLR 页唯一且标题精确对应的来源时才保留，不能带入外部 accepted corpus 的其他记录。输出协议为 `merged-good-historical-local-data-v5`，只保存来源类型、路径和 SHA，默认文件是 `data/runtime/direct-local-inputs/scoped-historical-local-data-v5.json`。旧 `historical-direct-rewrite-input-catalog-v1` 合并器输出不能用于当前计划。

`history:inputs --name` 可指定不可变来源清单的文件名，但不能使用 `current.json`。这个名字专供当前清单指针使用；程序在创建输出目录前拒绝该保留名，防止指针覆盖清单自身。

`history:conference-projections` 记录论文与历史会议页面的对应关系。它核对冻结页面、论文信息和 PDF 的 SHA；如果完整 inline TeX 曾被 Hugo 确定性省略，还会检查论文信息中对应省略形式的指纹。任一形式对应多个会议论文身份时都会拒绝，不能用标题相似度选择。这种页面对应关系不赋予旧 crosswalk 身份确认权限。

`history:plan` 生成 `historical-direct-rewrite-plan-v5`。页面对应关系和计划都使用生成来源清单时使用的完整严格校验，v3 及更旧清单会被拒绝。v5 对部分 `conflict/multiple` 日汇总页，只使用唯一严格评分行中的主 arXiv 链接，并记录字节区间和 SHA。计划重新核对该记录的自哈希、页面 SHA、原身份状态及候选集合，不能按候选优先级猜测。

主评分行路线抓取失败时写入 v2 备用记录，附完整评分行绑定；原单提示路线仍使用原字节格式的 v1 备用记录。备用 `history:arxiv-batch` 在新请求前读取当前配置下的冻结清单与凭证，核对 crosswalk 的完整候选集合，再按原页面 SHA 和评分行字节重建绑定。只有这些检查全部通过，才生成携带该绑定的 v2 crosswalk 决策，并在锁内应用前再次重核；普通多候选页面仍须走显式身份裁定。缺少冻结清单、原页或证明时明确停止，不按候选优先级选择论文。

没有冻结历史页面对应关系的来源记录不进入抓取、crosswalk 或模型队列。反过来，没有可用来源的冻结论文页须出现在 `uncoveredFrozenPaperPages` 和 `paperPageCoverage`，记录页面与内容 SHA、范围及身份线索状态，并按范围和状态统计。`none/conflict/multiple` 是待处理问题，不能据此猜身份。`--apply` 还会保存与计划 SHA 绑定的不可变 `historical-direct-rewrite-unprojected-catalog-report-v1`，记录未找到对应冻结历史页面的来源所涉及的论文 ID、来源类型和原因；该报告不是待执行任务清单。

## 获取和检查论文来源

`history:sources` 准备来源，不调用分析或 Reader，也不生成博客。arXiv 的 `generation` 是来源获取序号，不是论文修订号；新序号重新获取官方正文和 PDF，保存到 `data/runtime/fetched-arxiv-sources/<arxivId>/generation-000001/`。该目录只能有 `source.txt`、`source.pdf`、`source-runtime.json` 和 `source-manifest.json` 四文件。标题来自同批官方来源保存的运行信息，不能沿用旧博客标题。会议论文核对清单已绑定的本地论文信息及 PDF SHA，标题取自对应论文信息。

```bash
npm run history:sources -- --apply --plan /absolute/path/direct-rewrite-plan-v5.json \
  --queue all --generation 1 --max-papers 100 --arxiv-concurrency 3 --conference-concurrency 5
```

arXiv 来源并发默认 3，会议来源并发默认 5，各可设为 1–8。未显式选择 ID 的限量续跑会严格核验并跳过同一获取序号已有的 arXiv 四文件，会议项按稳定计划顺序继续检查。本地会议文件缺失或损坏只使对应项失败，不能进入 arXiv 备用获取或写入 crosswalk。只有新 arXiv 获取失败、由 scheduler/run 保存的有固定名称、保存后不再改写的备用记录文件可进入后文备用流程，其余会议来源继续处理。

每项结果在同一调度锁内更新带自哈希的 `historical-direct-source-status-v1`，另一进程的 `history:status` 可查看会议核验和 arXiv 文件状态。该记录也是分析的必需前提：`history:run --apply` 在任何来源抓取、PDF 提取或模型调用前，要求选中论文在同一计划及获取序号中均为 `ready`。缺记录、`handoff` 或 `failed` 都拒绝；后续仍核对实际来源字节，不能只信状态记录。

### 当前 PDF 不可用时的历史版本

通常保存不带版本号的当前官方 PDF，已有普通 v2 来源文件保持兼容。只有该 PDF 明确返回 HTTP 404，才允许尝试同一规范化 arXiv ID 的官方 `vN` PDF。跨 ID、带 query 或 fragment、非官方主机、没有当前 PDF 404 记录的版本回退均拒绝。选择历史版本后，`source.txt` 必须从选中 PDF 字节重新提取，不能分析撤稿页、当前 HTML 或混用其他版本 HTML 证据。

`source-runtime.json` 此时增加自哈希 `sourceVersion`，记录当前 URL/status、选中 `vN` 的身份和 URL、文本与 PDF 同版本关系及“当前稿不可用”的说明。运行信息 SHA 进入来源 manifest、分析来源描述、来源证明和页面 manifest。版本说明既是 `source.txt` 顶部的实际分析输入，也须在最终单篇页 front matter 后第一位置显示。确定性页面检查拒绝删除、移动或改写该说明。普通当前版本来源不增加此字段，兼容规则不变。

## 分析、图片和发布用元数据

历史更新与日更共用 `analysis-engine.js` 和 `deep-analyzer.js`，采用同一当前提示词登记表、正式分析、八维评分、标签、`beginner-researcher-v3` Reader 与来源核验。新模型请求使用当前登记版本；已保存阶段继续按其原版本、内容 SHA、来源与费用恢复，不把旧调用冒充新版本。

页面渲染通过 `paper-page-staging.js` 使用同一日更发布器；真实会议身份的作者、资源、摘要和评分展示通过 `paper_reader_presentation.py` 复用，保留历史 URL、论文身份与特殊来源披露。渲染实现 SHA 根据实际本地依赖闭包计算，包含共享 Python/Node 校验器；共享修复升级后旧暂存页重新生成。

标签使用当前386项九维词表，单篇与汇总成员均通过 `tag_presentation.py` 呈现所选概念及祖先路径；总目录保留零计数方向，文章不展示空分面或兄弟项，不把祖先写成直接标签。旧阶段只读核验原SHA和原选择，不能为显示升级重签付费记录。新的页面暂存与汇总生成完成后，还须走历史独立审查、发布及上线核验，不能只更新站点目录就宣告旧文章已切换；站点版本目录和本批快照的发布检查见[统一标签规则](tag-display-policy.md#三条流程共用的目录与呈现)。

日更、会议和历史单篇共用研究工作区及四份导出：`citation.json`、`citation.bib`、`citation.ris`、`rethink-context.json`。会议导出绑定真实会议 ID、来源全文 SHA、题目、原作者和 Reader 计划；路径按日期及会议 ID 的 SHA 隔离。暂存和恢复均校验固定文件集合、导出内容及页面声明的 SHA，不接受异篇引用或额外 JSON。未保存独立原摘要或公开来源 URL 时如实记录 `unavailable`，不造 arXiv 别名、不猜链接，也不把私有文件路径公开。

### 官方摘要与论文信息

arXiv 单篇页研究工作区展示的原始摘要统一来自官方 Atom 附属文件。从 `source.txt` 中限定范围提取 Abstract 只作诊断，不能替代发布来源。计划中的 arXiv 论文都不得使用旧博客、爬虫或模型生成的摘要。

```bash
npm run history:metadata -- --dry-run --plan /absolute/path/direct-rewrite-plan-v5.json \
  --generation 1 --all-plan-arxiv
npm run history:metadata -- --apply --plan /absolute/path/direct-rewrite-plan-v5.json \
  --generation 1 --all-plan-arxiv --concurrency 3
```

不写选择参数时也默认处理 `--all-plan-arxiv`。并发默认 1，范围 1–5，示例显式使用 3。命令只复用与本次封存来源时间及版本兼容的官方原始 Atom 响应；其余请求调用公共 `fetchOfficialArxivMetadata()`，要求项目 HTTP CONNECT、官方精确 ID 单项响应，并遵守主机调度及 429 策略。

socket、DNS、超时和 HTTP 408/425/429/5xx 在共享主机调度器内最多尝试三次。单篇暂时错误耗尽后记为 `failed`，继续同批其他论文，最终输出 `partial` 并非零退出。失败项不创建 generation 目录，原命令续跑时核验已有项并报告 `recovered`，只重新抓取缺失项。身份、解析、代理配置或附属文件完整性错误仍立即拒绝，不当作可忽略的单项网络失败。

普通无版本号来源要求 Atom `entryUpdatedAt` 不晚于来源最早捕获时间，响应 `observedAt` 不早于来源最晚捕获时间。历史 `vN` 来源须用同一 `vN` 查询并匹配 Atom 条目的论文修订号，另要求 `publishedAt <= entryUpdatedAt`。附属文件位于 `data/runtime/historical-arxiv-publication-metadata/<arxivId>/generation-000001/`，包含原始 Atom 响应、正式论文信息和 manifest，绑定原来源获取序号、来源 manifest 与快照 SHA、全文 SHA、查询/source ID、条目论文修订号及 published/updated/observed 时间、响应、论文信息及摘要 SHA；不增加或改写原来源目录四文件。

`direct-run` 在分析前预检、暂存时再次读取这些文件。已暂存任务恢复、汇总及最终发布也重新读取并校验原始 Atom 响应；缺失、额外文件、权限不符、硬链接、ID、获取序号或 SHA 与原记录不同均拒绝。

现行 `official-arxiv-atom-metadata-v1` 提取字段时保留原 XML 实体写法及作者空白，避免改变已封存记录的 SHA。解析仍先严格核验完整 XML 与论文身份；命名空间或属性写法无法按既有字段规则重新解析并得到原记录时，明确拒绝。正常日更抓取使用解码后的 XML 字段；若更改从官方元数据提取字段的规则，须另立协议版本并保留 v1 读取，不能直接重算旧记录证明。

### 分析与暂存页面

```bash
npm run history:run -- --apply --plan /absolute/path/direct-rewrite-plan-v5.json \
  --queue all --generation 1 --max-papers 50 --concurrency 3
```

分析并发默认 3，范围 1–8，每篇内部分析引擎并发为 1。本次选定集合先统一走正常首轮，每篇本轮只进入一次流水线；全部在途结果、registry和恢复记录保存后，才按公共总轮配置（默认3，范围1–10）继续可重试失败子集。成功暂存项不再请求模型，失败项仍保持原来源和同一 Reader 候选身份，不以尝试数递增自动创建新 epoch 或追加费用许可。正式分析、API Reader 和来源证明全部完成且对应同一来源快照后，论文才标为 `staged`。暂存目录的 `historical-direct-paper-page-staging-v1` 为每个冻结单篇路径记录新 Markdown、逐页 SHA，以及来源、分析、Reader、页面对应关系和渲染实现的绑定。它不读取旧 crosswalk、旧隔离分析任务、旧标签分配或旧博客正文作为创作输入。

暂存目录按 `runId/sourceIdentity/renderer-<renderer SHA>/` 隔离。Reader SHA、历史页面对应关系或单页内容与原记录不同，都会阻止恢复。已 `staged` 但渲染 SHA 不是当前实现的项，在状态中不计为当前完成，并重新进入无显式 ID 的限量队列。执行器核验已封存来源和分析后重新生成页面，不重复调用模型、不增加分析尝试次数，也不覆盖或删除旧渲染目录。汇总读取页面时再次要求全部成员使用当前渲染实现。

每次阶段断点记录（checkpoint）都原子写入 execution 目录的 `analysis-recovery.json`，绑定论文 ID、run ID 和来源快照 SHA。失败后若仍有 `analysisManifest`、`analysisCheckpoint`、`analysisStageCheckpoints` 或 `analysisRecoveryImageManifest`，执行记录进入 `analysis_partial` 并记录恢复文件 SHA，不写暂存页。同来源续跑按文件与阶段指纹恢复；来源身份或记录自身的 SHA 与原记录不同，会拒绝恢复。

### 本次调用使用的论文图

图像像素只在当前调用的系统临时目录准备，不写来源目录或 runtime。arXiv Reader 的某张可选图若明确永久失败，例如响应超硬字节上限、不可重试 4xx、格式或尺寸检查失败，只排除该图并保留同篇其余成功图片。socket、DNS、超时、408/425/429/5xx 等暂时失败仍使本次执行失败，不能当成“没有图继续写”。成功或排除之后都不能把像素或临时路径写入持久运行记录。

## 按批次执行、暂停与恢复

来源准备和分析均支持 `--paper-ids ID[,ID...]` 精确选择，或按稳定 `plan.queue` 顺序用 `--max-papers N` 限量；`--limit N` 是后者别名，两种限量参数不能同时传入。ID 与限量同时使用时先限定 ID 集合再截取。重复、空、未知或不属于所选 `--queue` 的 ID 在来源和模型请求前拒绝。`--dry-run` 报告最终 `selectedPaperIds` 及默认暂停标记、操作锁路径。

未显式指定 ID 的分析始终跳过已经由当前 renderer 合格暂存的成员，不论是否限量；显式 ID 仍完整冷核验已有结果。`--queue`、ID及限量在取得操作锁后只确定首轮范围，同次调用的失败轮不重新选择新论文、不扩大范围。处理完本次范围后，重跑原限量入口再推进下一批；仍失败的成员须先按正常恢复与原预算处理，不能删除其记录来推进队列。来源阶段同样核验已有 arXiv 四文件，并根据来源状态推进会议批次。来源和分析分别使用与计划 SHA、获取序号绑定的暂停标记和操作锁：来源标记在 `fetched-arxiv-sources` 根目录，分析标记为该轮执行记录文件加 `.pause`，不能自行改路径脱离控制命令。

```bash
npm run history:pause -- --plan /absolute/path/direct-rewrite-plan-v5.json --phase source --generation 1
npm run history:resume -- --plan /absolute/path/direct-rewrite-plan-v5.json --phase source --generation 1
# 分析阶段将 --phase source 改为 --phase analysis
```

`history:pause` 创建权限 `0600`、写入后不再改动的暂停记录，保存计划 SHA 和获取序号，并计算该记录自身的 SHA；已经开始的来源或模型请求继续执行。SIGINT/SIGTERM 同样只阻止领取新论文；正在处理的论文保存本项状态及已完成的暂存页面后，运行退出并报告 `paused`，信号原因也写入暂停记录。`history:resume` 先确认对应阶段操作锁已释放，再核验并删除暂停记录，之后原样重跑。空文件不能代替合法暂停记录，正在处理的论文尚未结束时不能先恢复。

Node 历史分析读取错误代码和作用范围，识别账号池耗尽、认证失效等影响本轮运行的故障，停止领取新论文并保存暂停原因。普通论文正文错误、未标记为影响整轮运行的网络错误或输出截断，不作为账号故障暂停整批。异常退出前等待所有已开始的论文处理结束，再释放操作锁；暂停和运行级故障也阻止开始新的失败轮。

同一计划 SHA 与获取序号的 `history:run --apply` 全程持有跨进程操作锁，覆盖执行记录的创建、重读、更新及最终计数，第二个执行器不能并发写同一记录。最终选篇、来源 `ready` 检查和官方元数据预检也在该锁内进行，防止预检和实际执行选了不同批次。

来源和分析每项完成后分别在 stderr 输出 `historical-direct-source-progress-v1` 与 `historical-direct-rewrite-progress-v1`。最终 stdout JSON 报告选择、已处理/剩余数量、`registryCounts`、`pauseFile` 和 `operationLockTarget`。更新时间取实际状态转换时刻，最近失败包含 `analysis_partial`，错误摘要保留脱敏后的开头和末端根因。`completedThisRun` 是已处理尝试数，不是成功数；进度日志不能代替当前暂存、审查及发布证明。

`rounds` 返回每轮固定输入及成功、失败、未启动集合；`manualHandoff` 使用公共阈值报告多轮后的少量持续失败，不能把 partial/analysis_partial 改成 staged 或授予发布资格。额度耗尽和不可重试项保留原阻断，受控人工修正仍须绑定本篇来源、失败稿与限定范围，再正常重验和暂存。来源准备和官方元数据获取仍使用各自原恢复规则，不因分析失败轮重新抓取，见 [统一批次规则](three-workflows.md#全批轮次与失败集合)。

## 生成每日和会议汇总

`history:aggregate projection` 从计划与冻结博客清单生成 `historical-direct-aggregate-projection-v3`。随后 `aggregate` 读取该文件、执行记录和完整单篇暂存 manifest，核对同一日期或会议的完整论文集合与每页 SHA，生成 `historical-direct-aggregate-v2` 汇总及 `pages/content/posts/...` 的实际暂存 Markdown。仅有 `analysis.json` 或 `staging-input.json` 不能生成汇总，旧汇总正文也不能用于补写内容。

```bash
npm run history:aggregate -- projection --apply \
  --plan-file /absolute/path/direct-rewrite-plan-v5.json \
  --inventory-file /absolute/path/all-history.json --output-name direct-aggregate-projection-v3.json
npm run history:aggregate -- aggregate --apply \
  --plan-file /absolute/path/direct-rewrite-plan-v5.json \
  --registry-file /absolute/path/direct-run-registry.json \
  --projection-file /absolute/path/direct-aggregate-projection-v3.json --daily YYYY-MM-DD
# 会议汇总将 --daily YYYY-MM-DD 改为 --conference conference-key
```

`registryFile` 与汇总页面对应文件以命令实际输出为准。每日集合可同时包含本次 arXiv 来源与通过核验的本地会议 PDF；纯来源集合沿用各自协议，混合集合记录自哈希 `historical-direct-mixed-source-v1`，分别绑定同一 arXiv 获取序号的逐篇 manifest 和逐篇会议 PDF SHA。会议集合仅允许本地会议 PDF。获取序号、manifest 或 PDF 的 SHA、论文成员集合及每篇来源身份，只要与原记录不一致，就拒绝汇总。

v3 汇总页面对应文件保留冻结会议任务页的路径、URL、旧字节 SHA、会议及任务键（`task key`），只按冻结链接关系确定论文成员。链接集合、目标页 SHA、渲染实现及任务覆盖情况均有自哈希。会议汇总先生成全部任务页，再生成会议总页作为同一轮完成标记。没有重写论文成员的冻结每日页记录为 `retain-unchanged`；`pageCoverage` 覆盖清单每一页，才允许 `publicationReady=true`。

汇总使用 `reader-facing-v3`。排行榜和中英文题目都链接冻结历史单篇 URL；详情只显示一次标签及八维评分，评分后依次放分档、文档类型和可用 arXiv 原文，再放作者机构、核心摘要与逐项可点击的 HTTPS 资源状态。“热门方向”只统计每篇当前标签注册表的主任务。

每日、会议总页和会议任务页均通过同一次有界 Python 桥，调用 `tag_presentation.py` 生成成员的多级标签块，避免逐篇额外启动进程。汇总页首显式记录 `aggregate-primary-task-counts` 范围和去重主任务的 `paper_digest_tags_concepts`；正文仍按各论文自己的完整所选集合显示，不用汇总主任务集合替代单篇分类。

若来源含通过核验的 `arxiv-historical-version-source-v1`，汇总保存其 `identitySha256`、实际 `vN` 和官方带版本 PDF URL，并在排行榜及双语标题条目旁明确显示“当前稿不可用/分析官方历史版本 vN”。普通来源不增加这些字段，沿用原生成分支。

## 查看状态和验收结果

```bash
npm run history:status -- --plan /absolute/path/direct-rewrite-plan-v5.json --generation 1
npm run history:status -- --plan /absolute/path/direct-rewrite-plan-v5.json --generation 1 --watch-seconds 5
npm run history:status -- --plan /absolute/path/direct-rewrite-plan-v5.json --generation 1 --verify-sources true
npm run history:status -- --plan /absolute/path/direct-rewrite-plan-v5.json --generation 1 --publication-id UUID
```

`history:status` 只读运行记录，报告全部执行状态、完成百分比、最近失败、暂停与锁、各类汇总缺口、会议任务页及发布阻断。普通或 watch 查询对会议来源只检查路径、普通文件和 PDF 大小；单次 `--verify-sources true` 才重算全部论文信息及 PDF SHA，不能与 watch 同用。

完成数量由当前计划和页面对应文件推导，不能拿某次计划的 4490 页、107 个日汇总、3 个会议汇总或 193 个任务页作通用门槛。完整任务要求来源状态全 `ready`、全部封存/本地来源仍有效、计划论文全部由当前实现暂存、精确的每日/会议/任务汇总集合齐全，以及 `pageCoverage` 覆盖每个冻结页面。额外或缺失任务、页面丢失或内容变化、未覆盖页面均阻断；`staged`、汇总 `complete` 或私有文件存在不足以说明全历史已发布。

不传 `--publication-id` 时，不读取发布事务或访问远端，状态不会把未选择发布的任务算作完整发布。指定后深核全部来源，要求发布计划 SHA 对应当前历史计划，默认实时核验远端身份及 OID；发布终验不能与 watch 同用。`--live-remote false` 仅作离线诊断，不能产生完整发布状态。

当前 `history:publication` 已有会议和任务汇总发布能力；实际页面或汇总文件缺失、校验失败时仍拒绝发布。Git 远端 OID 只证明推送，不证明网页已上线。向用户确认完成前，还须按[历史发布说明](history-direct-publication.md)核验对应部署及全部目标页面，并完成用户本次范围内的视觉要求。状态是读取时快照，发布后应重新查询。

## 会议 PDF 与特殊来源

### 会议页面与 PDF 的对应关系

ICML Daily 页使用 catalog v5 保存的 poster 对应记录。冻结单篇页须有唯一官方 poster URL；`tau-Voice` 的空单篇页只允许从同一冻结 Daily 汇总中，按精确单篇 URL 所属段落找到唯一 poster。poster 再唯一对应 OpenReview forum ID 与按 forum ID 命名的 PDF，不能按标题猜测。旧正文仅提供字节区间及 SHA，不进入分析、Reader 或新稿。

来源清单保存全部论文身份记录和当前已有可用 PDF 的子集；页面对应关系和计划只处理后者。缺 PDF 的身份仍可审计，但页面保持未覆盖。PDF 经专用来源程序核验保存、并重建清单之后，才能进入任务。

缺失 PDF 必须在首次 `history:conference-local-sources --apply` 之前处理。会议来源清单、catalog、页面对应关系和计划均不可覆盖；如果已有一轮保存了缺 PDF 状态，应使用新的唯一文件名，从会议来源清单开始重建整条链，不能只改下游文件。

历史保留 PDF 只从显式 `--icml-pdf-root` 读取。新下载保存到 `data/runtime/historical-icml-pdf-sources/`，通过 `--icml-fresh-pdf-root` 作为补充来源读取，不回写旧 `data/pdfs/`。每个新 PDF 必须恰有一份 OpenReview 或替代来源凭证；缺凭证、双凭证、孤立凭证、旧新 PDF 字节冲突都会拒绝。凭证文件 SHA、自哈希、版本关系和 PDF SHA 共同绑定来源，catalog、计划与执行器每层重新检查，不能只看字段是否像 SHA。

### 两项固定替代来源

优先通过官方 OpenReview 来源程序获取 PDF。公开端点被浏览器挑战页阻断时，`history:icml-alternate-pdf-source` 只允许代码已审查的固定 poster、forum 和来源 URL 组合：`jfpkqjhex4` 对应同标题、同作者的官方 arXiv v3；`n1mAjfRDZ6` 对应作者在 SSRN 发布的早期预印本。后者凭证须保留两个标题、作者显示名差异、DOI 和 `author-prior-preprint-cross-version`，不能声称 PDF 来自 OpenReview 响应或是 ICML 会议终稿（camera-ready）。

不同标题的作者早期预印本默认不能进入写作队列。唯一例外是用户已明确授权、代码精确列入白名单的 `conference:icml:2026:openreview-forum-id:n1mAjfRDZ6`。来源必须重新核对 poster/forum、凭证、PDF SHA、固定预印本标题、作者、DOI 及来源绑定，计划须包含带自哈希的 `sourceDisclosure`。分析执行器把“并非会议终稿”的警告放入所有模型读取的全文前缀，暂存页在 Hugo front matter 后第一位置放入同样的醒目中文说明。披露和最终页面字节都进入 manifest、`pageSet` 及其 SHA。任一字段缺失或与原记录不同都会拒绝，其他 forum 不得套用例外。

如果 SSRN 自动下载被 Cloudflare 阻断，但浏览器能够下载 PDF，可通过 `--import-file ABSOLUTE.pdf` 导入。该入口仅对 `n1mAjfRDZ6` 开放，会重新提取 PDF 文本，要求固定来源标题、作者、预印本日期及多个跨页特征文本全部匹配。PDF 自身不含 DOI，因此 SSRN DOI 由固定来源记录绑定。导入凭证记录 `operator-browser-download` 和 `networkResponseObserved: false`，不能伪造网络响应状态。原网络下载凭证与普通 plan v5 来源仍按既有方式核验，暂停、状态查询和恢复要求不变。

具体操作见[会议工作流](conference-workflow.md)。

## 已有页面的补充维护

### 补充旧页面的标签和来源身份

已经发布的历史页面正文里没有标签元数据时，用下面四个入口生成补充记录。它们只读计划、执行登记、博客快照和已暂存的分析结果，产出独立记录，不改写页面正文，也不改变正式发布状态。

```bash
npm run history:tag-supplement -- --plan ABS --registry ABS --blog ABS --snapshot ABS --run-id UUID [--limit N]
npm run history:source-tags -- --plan ABS --registry ABS --blog ABS --snapshot ABS --run-id UUID \
  [--concurrency 1|2|3] [--only-paper-ids ID,...] [--include-paper-ids ID,...] \
  [--resume-after-checkpoint ABS --resume-after-export ABS]
npm run history:source-identity -- --plan ABS --registry ABS --blog ABS --snapshot ABS --run-id UUID
npm run history:tag-checkpoint-export -- --plan ABS --registry ABS --blog ABS --snapshot ABS --run-id UUID \
  --checkpoint ABS [--exclude-paper-ids ID,...]
```

`history:tag-supplement` 对已由当前渲染实现暂存、且页面缺少标签元数据的论文，从已核验的分析记录和当前词表确定性分类，不请求模型；按运行标识写入 `historical-direct-tag-supplement-v2` 的 `tag-history.json` 和 `report.json`，文件不可覆盖。

`history:source-tags` 是没有可用正式分析记录时按来源证据请求模型的分类入口，也是这四个入口里唯一调用模型的。它保存论文选择集合、标签选择响应、独立审核和分类决策的检查点，写入 `historical-source-tag-classification-v2`；同一运行标识可续跑，`--concurrency` 只接受 1–3，默认 1。`partial` 部分运行记录不能当作续跑检查点；要从正规检查点开始新的论文集合，须同时给出 `--resume-after-checkpoint` 和 `--resume-after-export`。特殊来源重做须换新的运行标识，并显式给出 `--only-paper-ids`。

`history:source-identity` 只核验来源身份，写入 `historical-source-identity-supplement-v2`，不请求模型。重跑同一运行标识时，若已有完整总文件和报告，会先核对原摘要、来源、页面、正文和计划再按原格式复算，全部字节一致才复用；缺少完整输出、只有旧格式的部分检查点或校验失败时命令停止，保留原文件并换新的运行标识。

`history:tag-checkpoint-export` 读取并核验分类检查点或部分运行记录，核验已接受的分类缓存后导出页面分类记录，同样不请求模型；报告同时保留失败项和未处理论文。

## arXiv 获取失败的备用处理

仅当计划中已对应历史页的 arXiv 本次获取失败，scheduler/run 才保存 `historical-arxiv-fresh-failure-crosswalk-handoff-v1`。它绑定计划、catalog、inventory SHA、获取序号、失败摘要 SHA、冻结页面路径及 SHA、规范化 arXiv URL 和原始身份线索来源，不自行写 crosswalk。会议文件缺失或损坏不能生成这类备用记录，其他会议队列继续执行。

`history:arxiv-batch` 必须显式指定一个或多个备用记录文件名，不枚举其他 `pending` 页面，也不能凭单一 ID 线索扩大选择。每个备用记录重新核对计划、清单、页面 SHA、规范化 arXiv URL 及非标题身份线索，只处理备用记录列出的页面键。该备用队列默认并发 2，范围 1–3。

```bash
npm run history:arxiv-batch -- --dry-run --crosswalk UUID --owner fallback.worker \
  --handoffs arxiv-fresh-failure-2609.03622-g000001-0123456789abcdef01234567.json --concurrency 2
```

正常重写不调用任意 `crosswalk` 或单篇 `arxiv-source --crosswalk` 组合。备用批处理只有在核验本次获取失败的命名备用记录及冻结页面身份后才可写入；标题不能作为论文身份依据。

## 已保存旧运行的恢复

历史更新只有上面的当前主链。旧的独立分析、调度、标签、暂存、汇总及私有发布命令已移除；真实已有运行的来源、失败候选、费用、预算及凭证继续保留，内部兼容读取不赋予新任务发布资格。

`history:resume` 有两种明确模式。现行计划仍使用原控制协议恢复暂停阶段：

```bash
npm run history:resume -- --plan /absolute/path/direct-rewrite-plan-v5.json --phase analysis --generation 1
```

旧 `fresh-rewrite-run-v1` 必须已经保存在当前项目 `data/runtime/fresh-rewrites/<runId>/`；先只读查询，再恢复原分析：

```bash
npm run history:resume -- status --run-id UUID
npm run history:resume -- analyze --run-id UUID --concurrency 3
# 同一旧运行中只恢复已存在的失败子集
npm run history:resume -- analyze --run-id UUID --ids 2609.03586 --concurrency 1
```

旧 scheduler/postprocess 记录可先只读定位现存运行：

```bash
npm run history:resume -- locate --scheduler /absolute/path/data/runtime/historical-analysis-schedulers/UUID.json
```

该入口只接受当前项目两个已保存调度目录，核对结构、后处理记录自哈希及真实运行论文身份。缺失或损坏运行列为 `unavailable` 并非零退出，不新建运行、不重新执行旧队列。取得真实 `runId` 后使用上面的查询/分析恢复。

恢复沿用原 `run/inputs/analysis`、精确论文集及封存来源，完整核验 SHA 与锁后进入同一个分析引擎。不接受 `prepare`、`sources`、任意路径、日期变更或预算重置。缺失、损坏或跨运行来源须停止；不能创建一个新的运行来冒充旧断点续跑。只恢复分析不会修改当前正式日更数据或博客，不生成新的发布凭证。

旧 crosswalk、标签、暂存、私有发布及调度数据文件保留原样；已退休的新建、调度和发布写入实现已删除。旧成功或通过凭证不能冒充当前来源及当前页面的发布资格。新历史更新始终由冻结页面、当前计划与本次核验来源建立直接对应关系。

锁恢复仍检查完整 owner、PID、主机、有效期、inode 与 SHA；活 PID、新鲜或畸形锁不自动删除。特定远主机旧四字段论文锁回收仅在已核验的同篇直接来源运行内开放，事件绑定 paper/run/source 并保留不可变审计，不向普通分析或来源维护推广。
