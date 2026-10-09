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

## 冻结现有博客清单

`history:inventory` 扫描配置的 Hugo 博客 `content/posts`，保存后续要保留的页面集合、公开地址及原字节指纹。它要求本机可以运行 `hugo`；permalink 和已发布集合以同次扫描的 Hugo 输出为准，不能由脚本猜测。

```bash
npm run history:inventory -- --dry-run
npm run history:inventory -- --apply \
  --ledger all-history.json --receipt all-history.receipt.json
```

清单记录 Git `main`、HEAD、离线可读取的 `refs/remotes/<remote>/main`、`content/posts` 的 tree OID、每页 Git blob 和工作树状态、远端身份、Hugo 配置及 base URL。每页保留稳定 `pageId`、相对路径、正文、front matter 和整页 SHA、已有 URL 与 aliases，以及发布日期、会议日期、旧任务键、draft/published 状态和页面类型。Hugo 版本与 `list all/published` 集合 SHA 也进入记录；手写的 URL 对应关系必须逐页等于 Hugo permalink。

汇总页的每次行内内部链接都会记录字节位置、类型和解析后的目标 `pageId`、路径及快照 SHA。解析器要求方括号平衡，也处理标题内部的 `[]`。清单还记录受限论文身份线索、已有发布标记和旧标签的未核验候选 URL；候选 URL 不能当作已验证来源。

清单文件（`ledger`）不保存标题、描述或 Markdown 正文。旧正文只用于计算 SHA，以及提取上述受限身份和链接信息，不能进入后续分析或 Reader 请求。发布证据按字段白名单保存，字符串通常只保留哈希；只有逐项校验的少量枚举值和 ID 保留原值。附属文件、任意路径或 URL、未知 `paper_digest_*` 值只保留哈希或忽略。

`--apply` 要求博客位于干净 `main`。扫描前后只要 HEAD、状态、配置或页面字节改变，就拒绝写入。脚本在预留双文件之前、预留之后及写完之后重新核对同一仓库快照，防止扫描和保存之间发生变化。清单与凭证（`receipt`）以 `0600` 权限成对独占创建（`O_EXCL`），不能覆盖不同字节。

## 建立来源清单和重写计划

先用 `history:conference-local-sources` 建立会议论文信息与 PDF 的来源清单。该步不联网、不读博客正文、不调用模型；缺失 PDF 的处理见下一节。随后 `history:direct-inputs` 从冻结清单中已有的单一 arXiv ID 线索建立获取任务，并合并会议来源。

```bash
npm run history:conference-local-sources -- --apply \
  --icml-poster-snapshot /absolute/path/data/icml2026/papers.json \
  --icml-pdf-root /absolute/path/data/pdfs/icml2026

npm run history:direct-inputs -- --apply \
  --conference-manifest /absolute/path/conference-local-sources-v2.json \
  --inventory /absolute/path/all-history.json \
  --blog-root /absolute/path/audio-paper-digest-blog

npm run history:conference-projections -- --apply \
  --catalog /absolute/path/scoped-historical-local-data-v5.json \
  --inventory /absolute/path/all-history.json

npm run history:direct-plan -- --apply \
  --catalog /absolute/path/scoped-historical-local-data-v5.json \
  --inventory /absolute/path/all-history.json \
  --conference-projections /absolute/path/conference-page-projections-v3.json
```

后三个命令也接受 `--dry-run`，可以先检查再保存。不要向 `direct-inputs` 传 `--arxiv-manifest`；它不接受另一份本地 arXiv 来源清单，也不会把旧 TXT、PDF、图片、分析或 Reader 当作重写输入。会议部分先核对冻结页面 SHA，再读取 front matter 的标题指纹，与本地论文信息精确匹配，不把正文用于创作。

会议来源优先使用工作区爬虫保存的记录。`accepted-local-iclr-*` 只有在它是某个冻结 ICLR 页唯一且标题精确对应的来源时才保留，不能带入外部 accepted corpus 的其他记录。输出协议为 `merged-good-historical-local-data-v5`，只保存来源类型、路径和 SHA，默认文件是 `data/runtime/direct-local-inputs/scoped-historical-local-data-v5.json`。旧 `historical-direct-rewrite-input-catalog-v1` 合并器输出不能用于当前计划。

`direct-inputs --name` 可指定不可变来源清单的文件名，但不能使用 `current.json`。这个名字专供当前清单指针使用；程序在创建输出目录前拒绝该保留名，防止指针覆盖清单自身。

`history:conference-projections` 记录论文与历史会议页面的对应关系。它核对冻结页面、论文信息和 PDF 的 SHA；如果完整 inline TeX 曾被 Hugo 确定性省略，还会检查论文信息中对应省略形式的指纹。任一形式对应多个会议论文身份时都会拒绝，不能用标题相似度选择。这种页面对应关系不赋予旧 crosswalk 身份确认权限。

`history:direct-plan` 生成 `historical-direct-rewrite-plan-v5`。页面对应关系和计划都使用生成来源清单时使用的完整严格校验，v3 及更旧清单会被拒绝。v5 对部分 `conflict/multiple` 日汇总页，只使用唯一严格评分行中的主 arXiv 链接，并记录字节区间和 SHA。计划重新核对该记录的自哈希、页面 SHA、原身份状态及候选集合，不能按候选优先级猜测。

主评分行路线抓取失败时写入 v2 交接，附完整评分行绑定；原单提示路线仍使用原字节格式的 v1 交接。备用 `history:arxiv-batch` 在新请求前读取当前配置下的冻结清单与凭证，核对 crosswalk 的完整候选集合，再按原页面 SHA 和评分行字节重建绑定。只有这些检查全部通过，才生成携带该绑定的 v2 crosswalk 决策，并在锁内应用前再次重核；普通多候选页面仍须走显式身份裁定。缺少冻结清单、原页或证明时明确停止，不按候选优先级选择论文。

没有冻结历史页面对应关系的来源记录不进入抓取、crosswalk 或模型队列。反过来，没有可用来源的冻结论文页须出现在 `uncoveredFrozenPaperPages` 和 `paperPageCoverage`，记录页面与内容 SHA、范围及身份线索状态，并按范围和状态统计。`none/conflict/multiple` 是待处理问题，不能据此猜身份。`--apply` 还会保存与计划 SHA 绑定的不可变 `historical-direct-rewrite-unprojected-catalog-report-v1`，记录未找到对应冻结历史页面的来源所涉及的论文 ID、来源类型和原因；该报告不是待执行任务清单。

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

## 获取和检查论文来源

`history:direct-scheduler` 准备来源，不调用分析或 Reader，也不生成博客。arXiv 的 `generation` 是来源获取序号，不是论文修订号；新序号重新获取官方正文和 PDF，保存到 `data/runtime/fetched-arxiv-sources/<arxivId>/generation-000001/`。该目录只能有 `source.txt`、`source.pdf`、`source-runtime.json` 和 `source-manifest.json` 四文件。标题来自同批官方来源保存的运行信息，不能沿用旧博客标题。会议论文核对清单已绑定的本地论文信息及 PDF SHA，标题取自对应论文信息。

```bash
npm run history:direct-scheduler -- --apply --plan /absolute/path/direct-rewrite-plan-v5.json \
  --queue all --generation 1 --max-papers 100 --arxiv-concurrency 3 --conference-concurrency 5
```

arXiv 来源并发默认 3，会议来源并发默认 5，各可设为 1–8。未显式选择 ID 的限量续跑会严格核验并跳过同一获取序号已有的 arXiv 四文件，会议项按稳定计划顺序继续检查。本地会议文件缺失或损坏只使对应项失败，不能进入 arXiv 备用获取或写入 crosswalk。只有新 arXiv 获取失败、由 scheduler/run 保存的有固定名称、保存后不再改写的交接文件可进入后文备用流程，其余会议来源继续处理。

每项结果在同一调度锁内更新带自哈希的 `historical-direct-source-status-v1`，另一进程的 `history:status` 可查看会议核验和 arXiv 文件状态。该记录也是分析的必需前提：`history:direct-run --apply` 在任何来源抓取、PDF 提取或模型调用前，要求选中论文在同一计划及获取序号中均为 `ready`。缺记录、`handoff` 或 `failed` 都拒绝；后续仍核对实际来源字节，不能只信状态记录。

### 当前 PDF 不可用时的历史版本

通常保存不带版本号的当前官方 PDF，已有普通 v2 来源文件保持兼容。只有该 PDF 明确返回 HTTP 404，才允许尝试同一规范化 arXiv ID 的官方 `vN` PDF。跨 ID、带 query 或 fragment、非官方主机、没有当前 PDF 404 记录的版本回退均拒绝。选择历史版本后，`source.txt` 必须从选中 PDF 字节重新提取，不能分析撤稿页、当前 HTML 或混用其他版本 HTML 证据。

`source-runtime.json` 此时增加自哈希 `sourceVersion`，记录当前 URL/status、选中 `vN` 的身份和 URL、文本与 PDF 同版本关系及“当前稿不可用”的说明。运行信息 SHA 进入来源 manifest、分析来源描述、来源证明和页面 manifest。版本说明既是 `source.txt` 顶部的实际分析输入，也须在最终单篇页 front matter 后第一位置显示。确定性页面检查拒绝删除、移动或改写该说明。普通当前版本来源不增加此字段，兼容规则不变。

## 分析、图片和发布用元数据

### 官方摘要与论文信息

arXiv 单篇页研究工作区展示的原始摘要统一来自官方 Atom 附属文件。从 `source.txt` 中限定范围提取 Abstract 只作诊断，不能替代发布来源。计划中的 arXiv 论文都不得使用旧博客、爬虫或模型生成的摘要。

```bash
npm run history:publication-metadata -- --dry-run --plan /absolute/path/direct-rewrite-plan-v5.json \
  --generation 1 --all-plan-arxiv
npm run history:publication-metadata -- --apply --plan /absolute/path/direct-rewrite-plan-v5.json \
  --generation 1 --all-plan-arxiv --concurrency 3
```

不写选择参数时也默认处理 `--all-plan-arxiv`。并发默认 1，范围 1–5，示例显式使用 3。命令只复用与本次封存来源时间及版本兼容的官方原始 Atom 响应；其余请求调用公共 `fetchOfficialArxivMetadata()`，要求项目 HTTP CONNECT、官方精确 ID 单项响应，并遵守主机调度及 429 策略。

socket、DNS、超时和 HTTP 408/425/429/5xx 在共享主机调度器内最多尝试三次。单篇暂时错误耗尽后记为 `failed`，继续同批其他论文，最终输出 `partial` 并非零退出。失败项不创建 generation 目录，原命令续跑时核验已有项并报告 `recovered`，只重新抓取缺失项。身份、解析、代理配置或附属文件完整性错误仍立即拒绝，不当作可忽略的单项网络失败。

普通无版本号来源要求 Atom `entryUpdatedAt` 不晚于来源最早捕获时间，响应 `observedAt` 不早于来源最晚捕获时间。历史 `vN` 来源须用同一 `vN` 查询并匹配 Atom 条目的论文修订号，另要求 `publishedAt <= entryUpdatedAt`。附属文件位于 `data/runtime/historical-arxiv-publication-metadata/<arxivId>/generation-000001/`，包含原始 Atom 响应、正式论文信息和 manifest，绑定原来源获取序号、来源 manifest 与快照 SHA、全文 SHA、查询/source ID、条目论文修订号及 published/updated/observed 时间、响应、论文信息及摘要 SHA；不增加或改写原来源目录四文件。

`direct-run` 在分析前预检、暂存时再次读取这些文件。已暂存任务恢复、汇总及最终发布也重新读取并校验原始 Atom 响应；缺失、额外文件、权限不符、硬链接、ID、获取序号或 SHA 与原记录不同均拒绝。

现行 `official-arxiv-atom-metadata-v1` 提取字段时保留原 XML 实体写法及作者空白，避免改变已封存记录的 SHA。解析仍先严格核验完整 XML 与论文身份；命名空间或属性写法无法按既有字段规则重新解析并得到原记录时，明确拒绝。正常日更抓取使用解码后的 XML 字段；若更改从官方元数据提取字段的规则，须另立协议版本并保留 v1 读取，不能直接重算旧记录证明。

### 分析与暂存页面

```bash
npm run history:direct-run -- --apply --plan /absolute/path/direct-rewrite-plan-v5.json \
  --queue all --generation 1 --max-papers 50 --concurrency 3
```

分析并发默认 3，范围 1–8，每篇内部分析引擎并发为 1。正式分析、API Reader 和来源证明全部完成且对应同一来源快照后，论文才标为 `staged`。暂存目录的 `historical-direct-paper-page-staging-v1` 为每个冻结单篇路径记录新 Markdown、逐页 SHA，以及来源、分析、Reader、页面对应关系和渲染实现的绑定。它不读取旧 crosswalk、旧隔离分析任务、旧标签分配或旧博客正文作为创作输入。

暂存目录按 `runId/sourceIdentity/renderer-<renderer SHA>/` 隔离。Reader SHA、历史页面对应关系或单页内容与原记录不同，都会阻止恢复。已 `staged` 但渲染 SHA 不是当前实现的项，在状态中不计为当前完成，并重新进入无显式 ID 的限量队列。执行器核验已封存来源和分析后重新生成页面，不重复调用模型、不增加分析尝试次数，也不覆盖或删除旧渲染目录。汇总读取页面时再次要求全部成员使用当前渲染实现。

每次阶段断点记录（checkpoint）都原子写入 execution 目录的 `analysis-recovery.json`，绑定论文 ID、run ID 和来源快照 SHA。失败后若仍有 `analysisManifest`、`analysisCheckpoint`、`analysisStageCheckpoints` 或 `analysisRecoveryImageManifest`，执行记录进入 `analysis_partial` 并记录恢复文件 SHA，不写暂存页。同来源续跑按文件与阶段指纹恢复；来源身份或记录自身的 SHA 与原记录不同，会拒绝恢复。

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

### 本次调用使用的论文图

图像像素只在当前调用的系统临时目录准备，不写来源目录或 runtime。arXiv Reader 的某张可选图若明确永久失败，例如响应超硬字节上限、不可重试 4xx、格式或尺寸检查失败，只排除该图并保留同篇其余成功图片。socket、DNS、超时、408/425/429/5xx 等暂时失败仍使本次执行失败，不能当成“没有图继续写”。成功或排除之后都不能把像素或临时路径写入持久运行记录。

## 按批次执行、暂停与恢复

来源准备和分析均支持 `--paper-ids ID[,ID...]` 精确选择，或按稳定 `plan.queue` 顺序用 `--max-papers N` 限量；`--limit N` 是后者别名，两种限量参数不能同时传入。ID 与限量同时使用时先限定 ID 集合再截取。重复、空、未知或不属于所选 `--queue` 的 ID 在来源和模型请求前拒绝。`--dry-run` 报告最终 `selectedPaperIds` 及默认暂停标记、操作锁路径。

未显式指定 ID 的限量分析跳过已经由当前实现暂存的前项，原命令重复运行会推进下一批；显式 ID 则核验已有结果以支持定向检查。来源阶段同样核验已有 arXiv 四文件，并根据来源状态推进会议批次。来源和分析分别使用与计划 SHA、获取序号绑定的暂停标记和操作锁：来源标记在 `fetched-arxiv-sources` 根目录，分析标记为该轮执行记录文件加 `.pause`，不能自行改路径脱离控制命令。

```bash
npm run history:pause -- --plan /absolute/path/direct-rewrite-plan-v5.json --phase source --generation 1
npm run history:resume -- --plan /absolute/path/direct-rewrite-plan-v5.json --phase source --generation 1
# 分析阶段将 --phase source 改为 --phase analysis
```

`history:pause` 创建权限 `0600`、与计划及获取序号自哈希绑定的不可变标记，不终止已开始的来源或模型请求。一次 SIGINT/SIGTERM 也只阻止领取新项；在途论文完成原子状态/暂存边界后退出为 `paused`，信号原因会持久化。`history:resume` 只在对应阶段操作锁已释放后删除经过核验的标记，之后原样重跑。空文件不能伪装合法暂停，暂停尚未结束不能先恢复。

Node 历史分析根据结构化错误识别账号池耗尽、认证失效等运行级故障，停止领取新论文并保存暂停原因。普通论文正文错误、网络错误或输出截断不作为全局账号故障。异常退出前会等全部在途工作任务收尾，再释放操作锁；其他发布入口是否停派，应按其自身实现判断。

同一计划 SHA 与获取序号的 `direct-run --apply` 全程持有跨进程操作锁，覆盖执行记录的创建、重读、更新及最终计数，第二个执行器不能并发写同一记录。最终选篇、来源 `ready` 检查和官方元数据预检也在该锁内进行，防止预检和实际执行选了不同批次。

来源和分析每项完成后分别在 stderr 输出 `historical-direct-source-progress-v1` 与 `historical-direct-rewrite-progress-v1`。最终 stdout JSON 报告选择、已处理/剩余数量、`registryCounts`、`pauseFile` 和 `operationLockTarget`。更新时间取实际状态转换时刻，最近失败包含 `analysis_partial`，错误摘要保留脱敏后的开头和末端根因。`completedThisRun` 是已处理尝试数，不是成功数；进度日志不能代替当前暂存、审查及发布证明。

## 生成每日和会议汇总

`history:direct-aggregate projection` 从计划与冻结博客清单生成 `historical-direct-aggregate-projection-v3`。随后 `aggregate` 读取该文件、执行记录和完整单篇暂存 manifest，核对同一日期或会议的完整论文集合与每页 SHA，生成 `historical-direct-aggregate-v2` 汇总及 `pages/content/posts/...` 的实际暂存 Markdown。仅有 `analysis.json` 或 `staging-input.json` 不能生成汇总，旧汇总正文也不能用于补写内容。

```bash
npm run history:direct-aggregate -- projection --apply \
  --plan-file /absolute/path/direct-rewrite-plan-v5.json \
  --inventory-file /absolute/path/all-history.json --output-name direct-aggregate-projection-v3.json
npm run history:direct-aggregate -- aggregate --apply \
  --plan-file /absolute/path/direct-rewrite-plan-v5.json \
  --registry-file /absolute/path/direct-run-registry.json \
  --projection-file /absolute/path/direct-aggregate-projection-v3.json --daily YYYY-MM-DD
# 会议汇总将 --daily YYYY-MM-DD 改为 --conference conference-key
```

`registryFile` 与汇总页面对应文件以命令实际输出为准。每日集合可同时包含本次 arXiv 来源与通过核验的本地会议 PDF；纯来源集合沿用各自协议，混合集合记录自哈希 `historical-direct-mixed-source-v1`，分别绑定同一 arXiv 获取序号的逐篇 manifest 和逐篇会议 PDF SHA。会议集合仅允许本地会议 PDF。获取序号、manifest、PDF 或成员身份漂移均拒绝汇总。

v3 汇总页面对应文件保留冻结会议任务页的路径、URL、旧字节 SHA、会议及任务键（`task key`），只按冻结链接关系确定论文成员。链接集合、目标页 SHA、渲染实现及任务覆盖情况均有自哈希。会议汇总先生成全部任务页，再生成会议总页作为同一轮完成标记。没有重写论文成员的冻结每日页记录为 `retain-unchanged`；`pageCoverage` 覆盖清单每一页，才允许 `publicationReady=true`。

汇总使用 `reader-facing-v3`。排行榜和中英文题目都链接冻结历史单篇 URL；详情只显示一次标签及八维评分，评分后依次放分档、文档类型和可用 arXiv 原文，再放作者机构、核心摘要与逐项可点击的 HTTPS 资源状态。“热门方向”只统计每篇当前标签注册表的主任务。

若来源含通过核验的 `arxiv-historical-version-source-v1`，汇总保存其 `identitySha256`、实际 `vN` 和官方带版本 PDF URL，并在排行榜及双语标题条目旁明确显示“当前稿不可用/分析官方历史版本 vN”。普通来源不增加这些字段，沿用原生成分支。

## 查看状态和验收结果

```bash
npm run history:status -- --plan /absolute/path/direct-rewrite-plan-v5.json --generation 1
npm run history:status -- --plan /absolute/path/direct-rewrite-plan-v5.json --generation 1 --watch-seconds 5
npm run history:status -- --plan /absolute/path/direct-rewrite-plan-v5.json --generation 1 --verify-sources true
npm run history:status -- --plan /absolute/path/direct-rewrite-plan-v5.json --generation 1 --publication-id UUID
```

`history:status` 只读运行记录，报告全部执行状态、完成百分比、最近失败、暂停与锁、各类汇总缺口、会议任务页及发布阻断。普通或 watch 查询对会议来源只检查路径、普通文件和 PDF 大小；单次 `--verify-sources true` 才重算全部论文信息及 PDF SHA，不能与 watch 同用。

完成数量由当前计划和页面对应文件推导，不能拿某次计划的 4490 页、107 个日汇总、3 个会议汇总或 193 个任务页作通用门槛。完整任务要求来源状态全 `ready`、全部封存/本地来源仍有效、计划论文全部由当前实现暂存、精确的每日/会议/任务汇总集合齐全，以及 `pageCoverage` 覆盖每个冻结页面。额外或缺失任务、页面丢失/漂移、未覆盖页面均阻断；`staged`、汇总 `complete` 或私有文件存在不足以说明全历史已发布。

不传 `--publication-id` 时，不读取发布事务或访问远端，状态不会把未选择发布的任务算作完整发布。指定后深核全部来源，要求发布计划 SHA 对应当前历史计划，默认实时核验远端身份及 OID；发布终验不能与 watch 同用。`--live-remote false` 仅作离线诊断，不能产生完整发布状态。

当前 `history:direct-publication` 已有会议和任务汇总发布能力；实际页面或汇总文件缺失、校验失败时仍拒绝发布。Git 远端 OID 只证明推送，不证明网页已上线。向用户确认完成前，还须按[历史发布说明](history-direct-publication.md)核验对应部署及全部目标页面，并完成用户本次范围内的视觉要求。状态是读取时快照，发布后应重新查询。

## arXiv 获取失败的备用处理

仅当计划中已对应历史页的 arXiv 本次获取失败，scheduler/run 才保存 `historical-arxiv-fresh-failure-crosswalk-handoff-v1`。它绑定计划、catalog、inventory SHA、获取序号、失败摘要 SHA、冻结页面路径及 SHA、规范化 arXiv URL 和原始身份线索来源，不自行写 crosswalk。会议文件缺失或损坏不能生成这类交接，其他会议队列继续执行。

`history:arxiv-batch` 必须显式指定一个或多个交接文件名，不枚举其他 `pending` 页面，也不能凭单一 ID 线索扩大选择。每个交接重新核对计划、清单、页面 SHA、规范化 arXiv URL 及非标题身份线索，只处理交接列出的页面键。该备用队列默认并发 2，范围 1–3。

```bash
npm run history:arxiv-batch -- --dry-run --crosswalk UUID --owner fallback.worker \
  --handoffs arxiv-fresh-failure-2609.03622-g000001-0123456789abcdef01234567.json --concurrency 2
```

正常重写不调用 `history:crosswalk prepare/apply/apply-verified/finalize`，也不调用任意单篇 `arxiv-source --crosswalk` 组合。当前备用批处理的写入由 `history:arxiv-batch` 在核验命名交接之后完成；显式旧状态维护仍可按下一节限制写入，不能泛称 crosswalk 全部只读。

## 旧来源和 crosswalk 状态维护

以下入口维护既有旧状态，不代替当前计划、来源准备与分析。`history:resolve-conflict` 也属于旧工具；当前任务不能把 `conflict/multiple` 页面交给它自动恢复身份，须取得明确可用来源或保留阻断。运行快照见[全历史重写交接](historical-rewrite-handoff-2026-09-07.md)，仅供定位旧记录，不能照旧命令建立当前队列。

### 官方来源与旧隔离分析

旧 arXiv 页面标为 `verified` 前须取得官方来源的完整授权记录。以下 `--dry-run` 不联网、不写盘，`--apply` 使用项目 HTTP CONNECT 获取公共全文来源：

```bash
npm run history:arxiv-source -- --dry-run --id 2609.03622 --authority arxiv-2609.03622.json
npm run history:arxiv-source -- --apply --id 2609.03622 --authority arxiv-2609.03622.json
npm run history:arxiv-analyze -- prepare --apply --id 2609.03622 --date 2026-09-04 \
  --authority arxiv-2609.03622.json
npm run history:arxiv-analyze -- analyze --run-id UUID --concurrency 1
npm run history:arxiv-analyze -- status --run-id UUID
```

抓取原子保存请求、来源响应观测、全文、快照、来源凭证和授权记录（`authority`），权限均为 `0600`，拒绝覆盖不同字节。新写入还先保存私有的 `.<authority 名称去掉 .json>.source-pair.json`，其中完整观测与全文绑定原请求 SHA；它保留一份来源副本，供中断后逐字补齐原有两份正式文件，恢复时不重新抓取。重试写入只回收同机已退出写者留下、与正式文件 inode 相同的临时硬链接；旧半截文件、未知或仍活跃写者的文件均保留并拒绝继续。续跑已有完整文件只能恢复磁盘完整性证据；组合命令再次访问官方来源并逐字比较后，才在本进程取得不能序列化的生产授权对象。如果 HTTP 已返回但来源配对记录尚未保存，下次可再次抓取该非模型公共来源。孤立请求不表示成功，不能据此标 `verified` 或生成最终凭证；旧来源只保存了一侧且没有合格配对记录时，仍须人工检查。旧博客、分析、Reader 或自行拼出的快照/receipt 均不能获得生产授权。

`arxiv-analyze prepare` 经项目代理重新获取精确单篇 Atom 元数据，结合本进程核验的官方全文创建独立、只含论文来源的分析任务，按 SHA 保存原始 Atom XML，不读旧正文、分析、Reader 或 checkpoint。`analyze` 才调用多阶段模型并产生用量；结果保存在该任务 `analysis.json`，不覆盖 `data/current/deep-analysis-result.json`。

`history:analyze-batch` 与 `history:postprocess` 只维护旧备用任务。`new-full` 选择尚未进入旧分析的完整备用来源，`reader-recovery` 选择上游已完成而 Reader 尚未完整保存的记录。其 `--paper-ids` 支持重复 flag 或逗号列表，每项必须为规范 `arxiv:YYMM.NNNNN`；空、重复或身份未解决的项在联网前拒绝。正常任务仍用 `direct-scheduler/direct-run`。

核心摘要遵守 `core-summary-detailed-v3`。正文写 6–9 句，按程序规定的汉字、中文标点及全角字符计数，共 320–600 个字符，说明实际问题、2–4 步方法及分工、原文关键定量结果、结论边界和训练/推理/部署成本。无定量证据或成本未披露时须明说。修复只读论文来源，只替摘要节并逐字保护其余 12 节，顺序为结构修复、标签确认、核心摘要、评分。旧 v2 checkpoint 只有旧/新 Prompt 双白名单、模型、来源、证据与阶段 SHA 均可核验时才迁移摘要。阶段失效前最多保留两份有 SHA 校验的旧分析快照，替代全链成功后才清除。

### 旧任务后处理

后处理不再调用模型或写博客，仅接受调度器状态 `complete` 且实际来源/分析能核验为 `sealed-complete` 的单篇任务：

```bash
npm run history:postprocess -- --dry-run --crosswalk UUID --concurrency 3
npm run history:postprocess -- --apply --crosswalk UUID --concurrency 3
# 指定日期有任一论文未暂存时，仍保持 blocked
npm run history:postprocess -- --apply --crosswalk UUID --date YYYY-MM-DD --concurrency 3
```

预演只略过明确尚未封存或尚未完成的分析；磁盘读取、权限和内容完整性错误会中止并保留原原因。暂存后的完成集合复查也遵守这一规则，已保存的单篇成果保留，不能把读取失败报成普通缺页。

每篇先按当前标签注册表生成以 SHA 命名的标签分配记录；`blocked` 记录保留供审计，不能写入页面。暂存 run ID 由 crosswalk、分析任务、注册表、调度项及渲染实现 SHA 稳定推导，后者包括页面渲染、发布页面对应关系、标签生成、每日汇总和直接配置。实现改变会建立新的不可变暂存文件和 checkpoint，旧文件保留，但不能当作当前结果。

渲染先在内存完成，复核实现身份后原子写入；若写文件后、保存 manifest 前中断，同一写入计划（intent）及分析任务只能续用逐字一致的部分文件，未知或漂移文件会拒绝。每日汇总要求全部成员使用同一渲染 SHA，且该日期全部历史论文页已核验暂存；它合并逐篇 manifest，只写受保护 runtime。后处理 checkpoint 按 crosswalk 及注册表 SHA 隔离并自哈希，注册表升级不能覆盖旧审计记录。

暂存文件先完整写入临时文件并同步，再以不可覆盖的硬链接建立正式路径。显式续跑先核对原输入、来源、页面集合和完整 SHA，才可清理同机已退出写者留下的已知同 inode 临时硬链接；只读检查、未知链接和活写者链接仍拒绝。正式路径建立前留下的未知临时文件保留并阻断续跑；运行目录顶层的未知条目会报告绝对路径，不能自动删除；此次实现变化正常进入渲染指纹，旧页面须按正常路径重新生成。

### 旧 crosswalk 标签、暂存与日汇总

旧后处理链上的三个入口也可以手工分步运行。它们只写私有 runtime，不发布博客：

```bash
npm run history:tags -- assign --dry-run --analysis-run UUID [--paper-id arxiv:YYMM.NNNNN]
npm run history:tags -- assign --apply --analysis-run UUID [--paper-id arxiv:YYMM.NNNNN]
npm run history:stage -- --dry-run --crosswalk UUID --analysis-run UUID [--limit pilot|N]
npm run history:stage -- --apply --crosswalk UUID --analysis-run UUID --run-id UUID [--limit pilot|N]
npm run history:aggregate -- --dry-run --staging-runs UUID[,UUID...] [--date YYYY-MM-DD]
npm run history:aggregate -- --apply --staging-runs UUID[,UUID...] [--date YYYY-MM-DD]
```

`history:tags assign` 从已完成的历史分析按当前词表逐篇或批量生成独立标签分配记录；dry-run 不写文件，apply 只保存分类结果，不调用模型。`history:stage` 按指定的分析运行和词表 SHA 选取标签记录，再依据已核验的页面对应表生成私有单篇页面。`history:aggregate` 读取一份或多份已生成的暂存结果，重建每日汇总及清单并保留原路径与网址，默认只检查，加 `--apply` 才写入私有目录。

`history:tags` 当前只实现 `assign`。[实施路线图](history-rewrite-roadmap.md) 7.3 节列出的 `snapshot-routes`、`prepare`、`classify`、`review`、`status` 和 `finalize` 属于那份已废止的 crosswalk 方案，不是现在的入口，不能照抄执行。

### 页面身份与写入限制

`page-source-crosswalk-v1` 核验原清单/凭证字节及自哈希，以本进程受控对象为每个 `kind=paper` 页面建立独立、可恢复的 `pending` 状态。页面分配记录（`assignment`）只保存页面路径与整页 SHA，不保存标题、标签或旧正文。受控修改记录（`decision`）与写前一致性检查（CAS）可记录 `needs-review`、`blocked` 或 `conflict`；只有核验 `paper-source-authority-v1` 的受控来源对象后才可记 `verified`。

来源授权记录须绑定完整 `paper-identity-v1`、身份核心与完整记录 SHA、authority 文件 SHA/自哈希、证据类型、全文及来源快照 SHA。arXiv 兼容测试来源核对官方摘要页（abs）URL、来源快照、receipt 与全部全文字节；会议来源核对真实计划、导入记录、清单和来源上下文对象（`plan/import/ledger/source-context`）的逐级对应关系。页面须有与来源精确对应的 ID 线索，来自文件名、显式 front matter ID 或正文官方链接；标题永远不能作为 `verified` 身份证据。

`history:crosswalk prepare --apply`、`apply`、`apply-verified` 和 `finalize` 仍可显式维护旧状态，均受来源授权与一致性检查限制。decision 只能位于 `data/runtime/page-source-crosswalks/<UUID>/decisions/`，authority 及其直接命名证明文件只能位于 `data/runtime/paper-source-authorities/`。CLI 不接受任意路径或序列化伪授权对象，普通 `apply` 拒绝 `verified`。

通用 `apply-verified` 从磁盘重载 arXiv 来源时得到 `productionAuthorized=false`，不能以旧测试文件或自行构造的新磁盘链取得生产权限。会议来源还须本进程内已核验的 plan 对象，CLI 不能凭文件恢复这项能力，相应写入或 finalize 会拒绝。旧流程所需页面 decision 必须精确绑定，不能按标题自动确认。

同论文的多个页面按 `paperId`、`pageKey` 排序形成 `identityGroups`，只有全部页面通过授权核验且为 `verified` 才算完整。`finalize` 逐项核对来源，独占创建不可变 `page-source-crosswalk-final-receipt-v1`；证明缺失、替换或 SHA 漂移均拒绝。会议来源在命令行下无法核验时直接拒绝：用于加载会议计划授权文件的生产代码还没有接入，只要完成状态里出现会议来源上下文（`conference-plan-source-context`），`finalize` 就直接报错退出，不会写出最终凭证。后续使用最终凭证（`final receipt`）仍须当前生产授权解析器/对象再次核验，只持有状态和凭证文件不构成持久生产授权。

### 锁与中断恢复

`prepare --apply` 只可自动恢复三种已核实中断状态：安全空目录、只有空 `decisions/` 的目录、或只有初始规范 `state.json` 的目录。额外文件、非空孤立 decision、符号链接及不可核验状态均拒绝。

旧修改记录写入使用目录锁和规范 `owner.json`，记录持锁者（`owner`）、PID、主机名（`hostname`）、UUID token、开始/心跳时间、租期（`lease`）与自哈希。活 PID 永不抢占；同机死 PID 只有在证据完整、文件时间和心跳都超过 lease 时，才在独占 reclaim marker 下回收。远主机不能用本机 PID 探测，但也要求完整 owner、心跳与 mtime 均过期，再以 marker、inode 和 SHA 的 CAS 检查回收。新建、心跳新鲜、篡改或多余内容的锁不能猜测删除。SIGINT/SIGTERM 释放锁时须 token、PID、hostname、锁目录/owner inode 和 owner SHA 仍属于本进程，换主或漂移则拒绝删除；不得手工删除旧死锁。

单篇历史分析另有范围很窄、不能序列化的恢复权限：只在已有封存分析任务和来源的当前单篇上下文中，处理超过 24 小时、hostname 已改变、严格保持旧 `0755/0644` 四字段格式的论文锁。回收逐次检查目录及 owner 的 inode、SHA、mtime、硬链接、符号链接、额外项及 reclaim marker，事件原子保存到该篇 execution 目录并绑定 paper/run/source SHA。先按锁 inode 与 owner SHA 追加不可变 intent，回收后再追加 completion；后者保存中断时，下一次同来源任务只有在公共锁快照证明原 owner 已离开规范路径后才补写记录，不能覆盖旧事件或猜测仍存在的 owner 已回收。近期旧锁、当前 `0700/0600` 锁和普通论文分析调用均无此权限。

`history:local-crawl-batch` 是 `history:archive-crawl-batch` 的别名，两者在 `package.json` 里各有一个入口，调用同一个已停用的实现。它们和 `history:conference-crawl-batch` 都已停用并拒绝写入，不启用旧本地/会议爬虫的特殊锁恢复能力。通用 crosswalk CLI 也不能猜测删除远程、活 PID、权限不明、空或畸形锁；前述受控 lease 恢复和特殊单篇权限不能扩大到这些调用。

## 旧私有发布文件

旧 `history:publication` 仅支持 plan/generate，保存计划及私有文件，不写博客，不执行审查、提交或推送。它不能代替当前 `history:direct-publication`：

```bash
npm run history:publication -- plan --dry-run --plan-id UUID \
  --page-staging-runs UUID[,UUID...] --daily-aggregates UUID@YYYY-MM-DD[,UUID@YYYY-MM-DD...]
npm run history:publication -- plan --apply --plan-id UUID \
  --page-staging-runs UUID[,UUID...] --daily-aggregates UUID@YYYY-MM-DD[,UUID@YYYY-MM-DD...]
npm run history:publication -- generate --apply --plan-id UUID --batch-id daily-YYYY-MM-DD
```

plan/generate 核验 `selectedBindings`、crosswalk/inventory、封存分析来源、当前标签注册表及确定性每日汇总。plan 固定干净 `main`、HEAD/tree、远端身份及 OID、Hugo 配置、逐路径 Git/工作树基线及创建、替换、保留原样（`create/replace/unchanged`）操作；未知资产只允许目标不存在或已有完全同 SHA。generate 再核生成文件及前序批次完整 manifest，独占写入 `data/runtime/historical-publications/`，保存 manifest 前再次检查基线一致性及私有文件集合。

`oldGeneratedTextIncluded:false` 表示旧正文不进入创作或新生成的页面，事务仍会短暂读取旧 Git/工作树字节计算基线 SHA。旧入口不支持会议汇总，非空会议引用（`conference refs`）被拒绝；这项限制不适用于当前独立历史发布。私有文件完整不等于已允许改写博客或已发布。

当前历史发布按相对路径与最终内容 SHA 复用逐页通过记录；模型、代码、Hugo、审查协议或生成清单元数据变化仍须重做当前批次检查并生成新的审查凭证。只有内容 SHA 改变才重审页面，基线及远端校验不放宽。完整发布与上线验收见[历史发布说明](history-direct-publication.md)。
