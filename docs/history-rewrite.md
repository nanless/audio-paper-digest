# 全历史博客重写底座

状态：当前执行路线是 direct-local-first。inventory、legacy crosswalk 和单篇 authority 仍保留作来源
fallback/审计；它们不再是本地好数据重写的门槛。

## 当前执行路线：本地会议输入直达，arXiv fresh source

先由 `history:conference-local-sources` 建立本地会议 metadata/PDF manifest；`history:direct-inputs` 再从
冻结 inventory 的已有单一 arXiv hint 加入 arXiv route，并合并会议 manifest。它不读取旧正文，也不使用
本地 arXiv TXT/PDF/图作为写作输入。一个 canonical paper 只进入一个 direct run，随后投影到全部冻结历史页。

```text
conference local metadata/PDF ─┐
                               ├→ direct-inputs → conference-projections → direct-plan
frozen inventory arXiv links ─┘                                      ├→ scheduler → run → staging
                                                                       └→ direct-aggregate
```

```bash
# 只建本地会议来源 manifest；不联网、不读博客正文、不调用模型
npm run history:conference-local-sources -- --apply \
  --icml-poster-snapshot /absolute/path/data/icml2026/papers.json \
  --icml-pdf-root /absolute/path/data/pdfs/icml2026

# arXiv route 从 inventory 内已有链接建立；不传 --arxiv-manifest
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

`history:direct-scheduler` 对 arXiv 每个 generation 重新拉取官方文本/PDF，原子封存
`data/runtime/fetched-arxiv-sources/<arxivId>/generation-000001/source.txt`、`source.pdf`、runtime metadata 与
manifest；像素只在本次调用的 OS 临时目录存在。会议 route 只重放其 catalog 已绑定的本地 PDF/metadata SHA。
本地会议文件缺失/损坏会令该 direct item 失败关闭；它不能写 crosswalk。只有 arXiv fresh fetch 失败后由
direct scheduler/run 写出的 named immutable handoff 才可进入 crosswalk；它不会阻断其余 direct items。

## 已冻结的对象

`history:inventory` 从配置的 Hugo 博客 `content/posts` 逐页记录：

- Git `main`、HEAD、无网络时可用的 `refs/remotes/<remote>/main` 状态、`content/posts`
  tree OID、逐页 tracked blob、工作树、remote identity、Hugo 配置和 base URL；
- 稳定 `pageId`、页面相对路径、正文/Frontmatter/整页 SHA、现有公开 URL 和 aliases；
- Hugo runtime 版本、`list all/published` 集合 SHA；手写 URL 投影必须逐页等于 Hugo permalink；
- frontmatter 发布日期、会议 cohort 日期、旧 task key 及 draft/published 状态；
- 论文页、日更汇总、会议汇总和会议任务页类型；
- 受限身份线索；聚合页每一次严格、方括号平衡的 inline 内部链接（含标题内嵌 `[]`）的字节位置、类型和已解析目标
  `pageId/path/snapshot SHA`；现有发布 marker；旧标签的**未核验候选 URL**。

扫描要求本机 `hugo` 可执行；URL 和 published 集合以同一次扫描中 Hugo 的输出为准，
不是 Python 自己猜出的 permalink。

ledger 不保存标题、描述或 Markdown 正文；旧正文只参与 SHA 和受限链接/身份线索提取。
发布证据采用显式字段白名单，字符串也默认只留 hash；只有逐字段校验的极小 enum/ID 集合保留原值，
sidecar、任意路径/URL 和未知 `paper_digest_*` 值只留 hash 或完全忽略，
后续不得进入新的分析或 Reader 请求。apply 要求博客位于干净 `main`，扫描前后任一 HEAD、
状态、配置或页面字节变化都会失败；写入 O_EXCL 双文件前、预留后和写完后还会重放同一
repository snapshot，关闭 scan→write 竞态。ledger/receipt 以 `0600` 成对写入。

```bash
npm run history:inventory -- --dry-run
npm run history:inventory -- --apply \
  --ledger all-history.json --receipt all-history.receipt.json
```

## 仅处理坏数据的 legacy source/crosswalk fallback

本节只处理 direct route 已写出的 named immutable fresh-arXiv failure handoff。本地会议 metadata/PDF 缺失或
损坏时对应 direct item 失败关闭，不能进入 crosswalk。fallback 不能用于正常的历史 arXiv/会议重写，也没有抽样
通过后才放量的门槛。

单篇 arXiv 页面在进入 `verified` 前，先从官方来源生成不可变授权束：

```bash
npm run history:arxiv-source -- --dry-run --id 2609.03622 --authority arxiv-2609.03622.json
npm run history:arxiv-source -- --apply --id 2609.03622 --authority arxiv-2609.03622.json
# 从已核来源和原始抓取元数据建立隔离分析 run；prepare 不调用 LLM
npm run history:arxiv-analyze -- prepare --apply --id 2609.03622 --date 2026-09-04 \
  --authority arxiv-2609.03622.json
npm run history:arxiv-analyze -- analyze --run-id UUID --concurrency 1
npm run history:arxiv-analyze -- status --run-id UUID
```

`--dry-run` 不联网也不写盘。`--apply` 复用默认全文抓取器，因此仍强制项目 HTTP CONNECT
代理；依次保存 request、来源 observation、全文、snapshot、receipt 和 authority，全部为
`0600` 且拒绝覆盖不同字节。中断后重跑同一命令：已有完整束只能作磁盘完整性重放；组合命令
会再次访问官方来源并逐字比较后，才在本进程取得不可序列化的 production handle。若 HTTP 已返回
但进程在 observation 落盘前退出，下一次会重复抓取这个非 LLM 公共来源；孤立 request 不代表成功，
也不能据此签发 verified/final。只有单边 source 工件时失败关闭等待人工检查。旧博客正文、分析、
Reader 或自行拼出的 legacy snapshot/receipt 都不能取得 production authorization。

`history:resolve-conflict` 是保留旧 runtime 的 legacy 工具，不是当前 production fallback entrypoint。
当前 direct policy 不会把 conflict/multiple 页面送入 crosswalk；它们必须先获得 direct route 或保持失败关闭。

`history:arxiv-analyze prepare` 通过项目代理重新抓取精确单篇 arXiv Atom 元数据，并以 live
官方全文 authority 创建独立 source-only run；原始 Atom XML 一并按 SHA 封存，旧博客正文、旧
analysis、旧 Reader 和旧 checkpoint 都不会进入输入。`analyze` 才调用现有多阶段分析引擎并产生
LLM 用量，结果留在该 run 的 `analysis.json`，不会覆盖 `data/current/deep-analysis-result.json`。

`history:analyze-batch` 与 `history:postprocess` 只维护既有 fallback run，不能从本节建立新的 direct
队列。`new-full` 只选择从未进入 legacy analysis 的完整 fallback 来源，`reader-recovery` 只选择上游已完成
但 Reader 未封口的 fallback 记录；正常历史 arXiv/会议条目始终由 `history:direct-scheduler` 和
`history:direct-run` 处理。`--paper-ids` 支持重复 flag 或逗号列表，但每项必须是规范
`arxiv:YYMM.NNNNN`；空项、重复或未解决 fallback identity 都会在联网前失败。

API 分析的核心摘要使用 `core-summary-detailed-v3`：6–9 句、320–600 个中文/标点字符，必须交代
实际问题、2–4 步方法链及分工、原文关键定量结果（原文确无时显式声明不可得）、结论边界以及
训练/推理/部署成本（未披露时显式说明）。摘要修复只读取 source-only 证据，只替换该节并逐字
保护其余 12 节；顺序固定为 structure repair → taxonomy seal → core summary → scoring。旧 v2 fresh checkpoint 只有
在旧/新 Prompt 双 allowlist、模型、来源、证据和阶段 SHA 全部可重放时才做摘要-only 迁移；阶段
失效前保存最多两份 SHA 封口的 fresh-analysis stale snapshot，替代全链成功后再清除。

完成历史分析后，后处理使用单一可恢复入口；它不再调用 LLM，也不写博客仓库：

```bash
npm run history:postprocess -- --dry-run --crosswalk UUID --concurrency 3
npm run history:postprocess -- --apply --crosswalk UUID --concurrency 3
# 只尝试一个日期；当日任一历史论文尚未完成单篇 staging 时保持 blocked
npm run history:postprocess -- --apply --crosswalk UUID --date YYYY-MM-DD --concurrency 3
```

该入口只接受 analysis scheduler 中状态为 complete、且实际 run 可重放为 sealed-complete 的
per-paper 项。每篇先按当前 registry 确定性生成 SHA 命名的 taxonomy assignment；blocked assignment
仍保留审计，但不会进入页面。随后由 crosswalk、analysis run、registry 与 scheduler item SHA
以及 renderer implementation SHA 稳定派生单篇 staging run ID。该实现身份覆盖页面 renderer、
发布投影、taxonomy producer、daily aggregate 及其直接配置；代码变化会创建新的不可变 staging 与
checkpoint，旧产物保留但不能冒充当前。渲染先在内存完成并复验实现身份，再原子写入；进程在文件
写完、manifest 签发前中断时，同一 intent/run 只可续用逐字一致的部分文件，未知或漂移内容失败关闭。
每日汇总还要求所有成员绑定同一 renderer SHA。每日汇总只有在该日期的全部历史论文页面都能由已验证 staging 覆盖时
才生成；它合并多份 per-paper manifest，仍只写受保护的 runtime staging。postprocess checkpoint
按 crosswalk 与 registry SHA 隔离，自带 self-SHA，registry 升级不会覆盖旧审计链。

`page-source-crosswalk-v1` 会严格重放 canonical ledger/receipt 字节与自校验 SHA，再以 opaque
handle 为每个 `kind=paper` 页面建立隔离、可恢复的 pending 状态。assignment 只含页面路径和
整页 SHA，不带标题、标签或旧正文；受控 decision/CAS 可以记录 `needs-review`、`blocked`、
`conflict`，也可以在已重放 `paper-source-authority-v1` opaque handle 时记录 `verified`。

authority bundle 必须同时绑定 canonical `paper-identity-v1` 完整记录、身份核心 SHA、完整记录
SHA、authority 文件 SHA/self-SHA、证据类型、全文 SHA 与来源快照 SHA。arXiv fixture 合同会重放
official abs URL、source snapshot、receipt 和完整全文字节；会议合同会重放真实 plan/import/ledger/
source-context opaque 链。页面还必须有一个与 authority 精确相同、来自文件名、显式 frontmatter
ID 或正文官方链接的 identity hint；标题永远不能成为 verified 证据。

`history:arxiv-batch` 只可消费 direct scheduler/run 写出的 named immutable fresh-failure handoff，不会续跑或
枚举 pending single-hint 页面。每个 handoff 都重放 plan/inventory/page SHA、canonical arXiv URL 和非标题 hint，
并且只可选择 handoff 中列出的 page key。SIGINT/SIGTERM 只在 token、PID、hostname、锁目录 inode、owner inode
与 owner SHA 均仍属于当前进程时释放锁；换主或 inode 漂移时拒绝删除。
遗留死锁仍必须等 lease 到期并由脚本双重校验回收，禁止手工删除。

当前执行路线不运行 `history:crosswalk prepare/apply/apply-verified/finalize`，也不运行任意单篇
`arxiv-source --crosswalk` 组合。唯一 production fallback mutation 由 `history:arxiv-batch` 在读取
named immutable fresh-failure handoff 后执行；其命令和逐页绑定要求见本节后文。

既有 decision 文件只能放在 `data/runtime/page-source-crosswalks/<UUID>/decisions/`，authority 文件及其
直接命名的 proof 文件只能放在受保护的 `data/runtime/paper-source-authorities/`。生产 CLI 不接受
任意路径或序列化伪 handle；`apply-verified` 会先现场重放 bundle，普通 `apply` 拒绝 verified。
通用 `history:crosswalk apply-verified` 重新加载磁盘 arXiv bundle 时始终得到
`productionAuthorized=false`；当前 production policy 不使用它。旧式 fixture 和自行拼出的新式磁盘链同样不能升级权限。
会议 authority 还要求当前进程中的 authenticated plan
handle，因此命令行消费同样会有意失败关闭。当前仍需人工生成与页面绑定的 verified decision，
不会按标题自动确认身份。

同一 canonical identity 的多个页面形成按 `paperId`、`pageKey` 排序的确定性 `identityGroups`。
只有全部页面都是 authenticated verified 时状态才为 complete；`finalize` 会逐项重新加载来源
authority，并以 O_EXCL 写入不可变 `page-source-crosswalk-final-receipt-v1`。任一来源 proof 缺失、
替换、SHA 漂移或会议上游 handle 不可重放都会拒绝 finalize。后续读取 final receipt 也必须传入
当前 production-authorized authority resolver/opaque handles 并再次重放；只持有 receipt/state 文件
不能作为持久来源授权。

`prepare --apply` 可重放并自愈三种可验证的中断状态：安全空目录、仅含空 `decisions/`
的目录、或仅含 canonical 初始 `state.json` 的目录；任意额外文件、非空孤立 decision、
symlink 或不可重放状态都会失败关闭。decision apply 使用目录锁和 canonical `owner.json`，
绑定 owner、PID、hostname、UUID token、开始/心跳时间、lease 与 self-SHA。活 PID 永不被抢占；
只有同机死 PID、owner 证据完整且文件时间和 heartbeat 都超过 lease 时，才在独占 reclaim
marker 下回收。远程 owner 无法以本机 PID 探测存活，但只有 owner 证据完整、heartbeat 和文件
mtime 均已超过 lease 时，才会在独占 reclaim marker、inode 与 SHA 的 compare-and-swap 校验下
回收；刚建立、心跳新鲜、被篡改或带额外内容的锁都不会被猜测删除。
当前生产 CLI 不使用 local/conference legacy lock-recovery capability；本地或会议 crawler batch 兼容入口已退休且
失败关闭。通用 crosswalk CLI、远程、活 PID、权限不明、空或畸形锁均不能猜测删除锁。

`history:arxiv-batch` 是唯一可写的 fallback batch，并且必须显式指定一个或多个 handoff 名称：

```bash
npm run history:arxiv-batch -- --dry-run --crosswalk UUID --owner fallback.worker \
  --handoffs arxiv-fresh-failure-2609.03622-g000001-0123456789abcdef01234567.json --concurrency 2
```

`history:local-crawl-batch`（及 archive alias）与 `history:conference-crawl-batch` 都是 retired fail-closed
compatibility endpoints。会议页面的 exact normalized frontmatter title fingerprint 只用于 `history:conference-projections`：
它必须唯一匹配 catalog 的 metadata record，inline TeX 省略形式也必须唯一；不能做标题相似度匹配，更不能创建
crosswalk assignment。

### 本地直达重写计划

`history:direct-inputs` 从冻结 inventory 的已有 arXiv 链接直接建立 arXiv route；它不要求、也不接受另一个
“arXiv good-data manifest”，不会把本地 arXiv TXT/PDF/图片或旧分析送入重写。每个 arXiv route 在本次
generation 才重新获取官方文本/PDF 并封存。会议部分读取 conference local-source manifest、重放 inventory
页面 SHA，并只读取会议页 frontmatter title fingerprint 来选择精确的 canonical conference record；它不会读取
正文。workspace crawler 来源优先；`accepted-local-iclr-*` 只有在它是某个冻结 ICLR 页唯一的精确 title-bound
来源时才保留，不能把外部 accepted corpus 的其余记录带入。输出是 `merged-good-historical-local-data-v5`，只保存
source route、路径和 SHA，不把旧博客正文、旧 analysis 或旧 Reader 内容交给写作链路。默认写到
`data/runtime/direct-local-inputs/scoped-historical-local-data-v5.json`；旧的
`historical-direct-rewrite-input-catalog-v1` collector merger 不能用于 direct plan。

```bash
npm run history:direct-inputs -- --dry-run \
  --conference-manifest /absolute/path/conference-local-sources-v2.json \
  --inventory /absolute/path/all-history.json \
  --blog-root /absolute/path/audio-paper-digest-blog

npm run history:conference-projections -- --dry-run \
  --catalog /absolute/path/scoped-historical-local-data-v5.json \
  --inventory /absolute/path/all-history.json

npm run history:direct-plan -- --dry-run \
  --catalog /absolute/path/scoped-historical-local-data-v5.json \
  --inventory /absolute/path/all-history.json \
  --conference-projections /absolute/path/conference-page-projections-v3.json

# source phase 与 LLM/staging 分离；两条队列可并发，单篇 canonical 只由一个 writer 执行
npm run history:direct-scheduler -- --apply --plan /absolute/path/direct-rewrite-plan-v5.json \
  --queue all --generation 1 --max-papers 100 --arxiv-concurrency 3 --conference-concurrency 5
npm run history:direct-run -- --apply --plan /absolute/path/direct-rewrite-plan-v5.json \
  --queue all --generation 1 --max-papers 50 --concurrency 3

# 只读进度快照；--watch-seconds 5 可持续输出 NDJSON 快照
npm run history:status -- --plan /absolute/path/direct-rewrite-plan-v5.json --generation 1
npm run history:status -- --plan /absolute/path/direct-rewrite-plan-v5.json --generation 1 --watch-seconds 5

# 请求安全暂停；活动论文完成原子落盘并释放 operation lock 后，才允许 resume
npm run history:pause -- --plan /absolute/path/direct-rewrite-plan-v5.json --phase source --generation 1
npm run history:resume -- --plan /absolute/path/direct-rewrite-plan-v5.json --phase source --generation 1
# LLM/direct-run 阶段把 --phase source 换成 --phase analysis

# direct-run 输出的 registryFile 与 aggregate projection 均使用命令实际输出的绝对路径
npm run history:direct-aggregate -- projection --apply \
  --plan-file /absolute/path/direct-rewrite-plan-v5.json \
  --inventory-file /absolute/path/all-history.json \
  --output-name direct-aggregate-projection-v2.json
npm run history:direct-aggregate -- aggregate --apply \
  --plan-file /absolute/path/direct-rewrite-plan-v5.json \
  --registry-file /absolute/path/direct-rewrite-registry.json \
  --projection-file /absolute/path/direct-aggregate-projection-v2.json \
  --daily YYYY-MM-DD
# 或把最后一项替换为 --conference conference-key
```

`history:conference-projections` 只重放冻结页面 SHA 后的 frontmatter title
指纹和本地 metadata/PDF SHA；完整 inline TeX 在 Hugo 历史 title 中被确定性省略时，metadata 会额外
提供该省略形式的指纹。两种形式只要映射到多个 conference identity 就失败，不做标题相似度匹配；projection 是 direct
route 的页面投影证据，绝不是 crosswalk identity recovery。

projection v3 对 ICML Daily 页只消费 catalog v5 已封存的 poster authority binding：冻结 child 页必须含唯一
官方 poster URL；`tau-Voice` 的空 child 页只允许由同一冻结 Daily 汇总中“精确 child URL section → 唯一 poster”
桥接。poster 再唯一绑定 OpenReview forum ID 与 forum-ID PDF，不按标题猜测。catalog 同时保存全部身份 binding 和
当前 PDF-routable 子集；projection/plan 只投影后者。PDF 缺失时身份仍可审计但页面继续留在 uncovered，PDF 经专用
sealer 封存并重建 manifest 后才自动进入 route。旧正文只贡献字节区间和 SHA，绝不进入分析、Reader 或新稿。
默认优先使用 OpenReview 官方 sealer。公开端点被浏览器挑战页阻断时，
`history:icml-alternate-pdf-source` 只允许代码内审查过的固定 poster/forum/来源 URL 组合。
`jfpkqjhex4` 绑定同标题同作者的官方 arXiv v3；`n1mAjfRDZ6` 只有作者在 SSRN 发布的早期预印本，
receipt 必须保留两个标题、作者显示名差异、DOI 和 `author-prior-preprint-cross-version`，
不得声称该字节是 OpenReview 响应或 ICML camera-ready。
默认情况下，这种“标题不同的作者早期预印本”仍不进入 direct writer route。唯一例外是用户明确授权、
代码精确白名单的 `conference:icml:2026:openreview-forum-id:n1mAjfRDZ6`：来源必须重放 poster/forum、
receipt、PDF SHA、固定预印本标题/作者/DOI 和 source binding；plan 必须附带自哈希 `sourceDisclosure`。
runner 会把非 camera-ready 警告写入所有模型实际消费的全文前缀，单篇 staging 会在 Hugo front matter
之后插入同样的中文醒目提示，并把 disclosure 与最终页面字节一起纳入 manifest/pageSet/manifest SHA。
任一字段缺失或漂移即失败关闭，其他 forum 不能套用这项例外。

SSRN 若被 Cloudflare 阻断自动下载，但浏览器能取得 PDF，可用 `--import-file ABSOLUTE.pdf` 走受控导入。
该入口只对白名单 `n1mAjfRDZ6` 开放，会重新提取 PDF 文本并要求固定来源标题、作者、预印本日期和
多个跨页特征文本全部命中；SSRN DOI 由固定来源记录绑定，因为下载 PDF 自身不内嵌 DOI。
import receipt 记录 `operator-browser-download` 与 `networkResponseObserved: false`，不伪造网络响应状态。
旧的网络下载 receipt 和普通 plan v5 路由继续原样重放，避免破坏长任务暂停、状态查询和恢复。

顺序是强约束：缺失 PDF 必须在 `history:conference-local-sources --apply` 之前封存。local manifest、
catalog、projection 和 plan 都是 immutable 证明；如果已签发过含缺失 PDF 的旧一轮，必须使用新的、
唯一的 artifact 名称从 local manifest 开始重放整条链，不得覆盖或只改下游文件。
历史保留 PDF 只从显式 `--icml-pdf-root` 读取；本轮新下载只写
`data/runtime/historical-icml-pdf-sources/`，由 `--icml-fresh-pdf-root` 作为 overlay 重放，不回写 legacy `data/pdfs/`。
fresh overlay 中的每个 PDF 必须有且只有一份 OpenReview 或 alternate receipt；无 receipt、双 receipt、
receipt 孤儿或 retained/fresh 字节冲突都失败关闭。receipt 文件 SHA、self-SHA、版本关系和 PDF SHA
进入 PDF identity/source binding，catalog、plan 和 runner 每层都重放，不只检查它“长得像 SHA”。

`history:direct-plan` 生成 `historical-direct-rewrite-plan-v5`。projection 与 plan 都复用
`history:direct-inputs` producer 的完整 strict catalog validator；所有 v3 及更旧 catalog 都会失败关闭。
v5 另把 conflict/multiple daily 页中唯一严格评分行的主 arXiv 链接封存为只含字节区间与 SHA 的 binding；
plan 会重放 binding self-SHA、page SHA、原 identity status/candidates，绝不按候选优先级猜测。plan 除了 catalog
中无历史投影的 source 记录，还会把每个未进入 direct route 的 frozen paper page 及其 page/content SHA、
scope 和 identity-hint 状态写入自哈希覆盖审计，并汇总逐 scope 与逐 hint-status 数量；它只报告
`none/conflict/multiple` 等缺口，不据此猜测或自动解决身份。

队列中的 arXiv canonical paper 每个
generation 都重新从官方 arXiv 获取正文和 PDF，并持久化 `source.txt`、`source.pdf`、`source-runtime.json`
和 `source-manifest.json`；generation 目录只能有这四件文件。图片只在当前调用的系统临时目录存在。来自同一
fresh source 的标题进入 runtime metadata，供新稿
identity 使用；它不来自冻结博客页面。队列中的 conference paper 只重放 catalog 已绑定的本地
metadata/PDF SHA，并从该 metadata record 取得标题。两条队列都不以 legacy crosswalk 为前置条件。

来源阶段也支持 `--paper-ids`和 `--max-papers`（或 `--limit`）；未显式指定 ID 的
bounded 续跑会先严格重放并跳过同 generation 已封存的 arXiv 四文件 bundle，会议项则按稳定 plan 顺序分批
重放 metadata/PDF SHA。默认 source pause marker 与 scheduler operation lock 位于
`fetched-arxiv-sources` 根，文件名绑定 plan SHA 与 generation。SIGINT/SIGTERM 或安全普通 pause marker
只阻止领取下一项；stderr 逐项输出 `historical-direct-source-progress-v1`，最终 JSON 报告 selected、processed、
remaining 及 pause/lock 路径。每项结果还会在同一 scheduler lock 内更新自哈希
`historical-direct-source-status-v1`；因此会议 SHA 验证和 arXiv sealed bundle 都可由 `history:status` 跨进程查看，
重复 bounded 命令会推进下一批。该 checkpoint 是进度证据，direct-run 仍会现场重放来源字节后才使用。

`history:direct-run --apply` 只有在 canonical analysis、API Reader 和 direct source provenance 都完成并
逐项绑定同一 source snapshot 后，才会把一个 canonical paper 标为 `staged`。它同时在该 paper 的
direct staging 目录生成 `historical-direct-paper-page-staging-v1`：每个冻结的历史单篇路径都有新 Markdown
字节、逐页 SHA，以及 source / analysis / Reader / projection / renderer implementation 的闭环 manifest。
这里不读取 crosswalk、旧 fresh run、旧 taxonomy assignment 或任何旧博客正文。Renderer 实现变更、Reader
SHA 漂移、历史页 projection 漂移和任何单页字节替换都会拒绝恢复。

长任务使用 `--paper-ids ID[,ID...]` 做显式集合，或用 `--max-papers N`（兼容别名 `--limit N`）按
`plan.queue` 的稳定顺序截取；两者同时使用时先限定 ID 集合、再稳定截取。重复、未知或不属于所选
`--queue` 的 ID 都会在来源和模型请求前失败。dry-run 会报告最终 `selectedPaperIds`、默认 pause marker 和
operation-lock 路径。未显式给 ID 的 `--max-papers` 会跳过 registry 中已经 `staged` 的前项，因此原命令
重复运行会稳定推进下一批；显式 ID 仍会重放已完成工件以支持定向复验。默认 pause marker 是同一 plan SHA 与 arXiv generation 的 registry 文件加 `.pause`；
不允许覆写 pause 路径，避免脱离 `history:pause/resume/status` 控制面。marker 必须是由 `history:pause` 签发、绑定同一 plan/generation 的
自哈希私有普通文件，不能用空文件伪造。签发 marker，或向运行进程发送
一次 `SIGINT`/`SIGTERM`，只会阻止领取下一篇；已经开始的并发论文会完成其原子 registry/staging 边界后退出为
`paused`。移走 marker 后原样重跑即可续跑。

同一 plan SHA 与 generation 的 apply 全程持有跨进程 operation lock；锁覆盖 registry 的首次创建、重读、
所有状态写入和最终计数。第二个 direct-run 不得并发抢写同一 registry。每篇结束后 stderr 输出一行
`historical-direct-rewrite-progress-v1`，最终 stdout JSON 提供 selection、processed/remaining、完整
`registryCounts`、pauseFile 和 operationLockTarget，供外部只读 status 聚合；进度流本身不是完成证明。

`history:pause --phase source|analysis` 以 `0600`、plan SHA 与 generation 自哈希绑定的独立 immutable marker 请求停机；它不杀死
活动来源或模型请求。`history:resume` 只在对应 phase 的 operation lock 已释放后移除经过重放的 marker，避免
“暂停尚未落稳就继续领任务”。`history:status` 不写 runtime，可单次输出或用 `--watch-seconds N`
持续输出；它汇总 registry 全状态、完成百分比、最近失败、pause/lock、daily/conference aggregate
缺口、conference-task 阻断和 publication 收尾 blocker。`staged`、aggregate complete 或私有 bundle
存在都不会单独把全历史状态标成 complete。

`history:direct-aggregate projection` 先从 plan 与冻结 inventory 签发
`historical-direct-aggregate-projection-v2`；`aggregate` 只消费该 projection、direct-run registry 和上述
完成的单页 staging manifest，先重放同一 daily 或 conference cohort
的完整成员集合和单页 SHA，再渲染汇总页。排行榜和二级条目都使用冻结历史页的内部 URL，因此链接可点击；
汇总 Markdown 及其真实 `pages/content/posts/...` staging 字节会一起写入 aggregate run。它不从旧汇总正文
补内容，也不能用只有 analysis.json 或 staging-input.json 的半成品伪造汇总。

Daily cohort 可以由 fresh arXiv 与已认证 conference-local PDF 成员共同组成。纯来源 cohort 沿用各自来源合同；
混合 cohort 必须签发 `historical-direct-mixed-source-v1` 自哈希绑定，分别封存同一 arXiv generation 的逐篇
source manifest 集合和逐篇会议 PDF SHA 集合。Conference cohort 仍只允许 conference-local PDF；任一 arXiv
generation、manifest、PDF 或成员身份漂移都会拒绝生成汇总。

projection v2 还逐页保留冻结 inventory 中的 `conference-task` 路径、URL、旧字节 SHA、会议 key 与 task key，
并以 `conferenceTaskPageSetSha256`、`conferenceTaskCoverageSha256` 和 projection self-SHA 封口。当前没有 task
renderer，因此这些页面明确记录为 `pending` / `unsupported` / publication `blocked`；它们不进入 daily 或
conference 汇总的论文成员、排名和正文，也不能因汇总 staging 完成而冒充已重写。后续历史 publication 必须
重放该 coverage，并在 `publicationReady=false` 时失败关闭。

catalog 中没有任何冻结历史页投影的记录绝不进入 fresh fetch、crosswalk 或 LLM 队列。反方向上，
frozen paper page 没有 direct source route 时也必须出现在 plan 的 `uncoveredFrozenPaperPages` 与
`paperPageCoverage`，不能因非会议页没有单一 arXiv hint 就静默消失。`--apply`
会把它们写为与 plan SHA 绑定、不可变的
`historical-direct-rewrite-unprojected-catalog-report-v1`，记录 paper ID、route 和原因。该 report 是
缺投影审计，不是待处理任务清单。

若一个已投影 arXiv paper 的本次新抓取失败，scheduler 只写
`historical-arxiv-fresh-failure-crosswalk-handoff-v1`：它绑定 plan/catalog/inventory SHA、generation、
失败摘要 SHA、冻结 page SHA/path、canonical arXiv URL 与原始 identity-hint 来源。handoff 不写
crosswalk；后续 `history:arxiv-batch` 必须显式传入其文件名才可重放，且不会扩大到任何其他 pending 页。该失败不会
中断本地 conference source 队列。
`history:analyze-batch` 与 `history:postprocess` 仍可按已验证 fallback identity group 维护旧 run，不能取代
direct 投影。direct 路径已具有 conference page projection；尚未实现的是全历史专属 review、activation、
commit/push receipt 与 remote-OID publication。任何 catalog 未投影条目会单独出现在 immutable unprojected
report，不能被伪装为已重写。运行快照仅供定位旧 runtime，见[全历史重写交接](historical-rewrite-handoff-2026-09-07.md)。

历史 publication transaction 的第一阶段只生成 plan 与私有 bundle，不写博客，也不执行 review、
commit 或 push：

```bash
npm run history:publication -- plan --dry-run --plan-id UUID \
  --page-staging-runs UUID[,UUID...] --daily-aggregates UUID@YYYY-MM-DD[,UUID@YYYY-MM-DD...]
npm run history:publication -- plan --apply --plan-id UUID \
  --page-staging-runs UUID[,UUID...] --daily-aggregates UUID@YYYY-MM-DD[,UUID@YYYY-MM-DD...]
npm run history:publication -- generate --apply --plan-id UUID --batch-id daily-YYYY-MM-DD
```

plan/generate 都会重放 selectedBindings、crosswalk/inventory、sealed analysis source、当前 taxonomy
和 daily aggregate 的确定性整件。plan 冻结 clean `main`、HEAD/tree、remote identity/OID、Hugo config、
逐路径 Git/worktree baseline 和 create/replace/unchanged 操作；未知资产只允许目标不存在，或已存在完全
相同 SHA。generate 再次重放 producer，要求前序 batch 的完整 generation/bundle proof，以 O_EXCL 写入
`data/runtime/historical-publications/`，并在封 manifest 前完成 closing CAS 与 bundle 精确文件集检查。
`oldGeneratedTextIncluded:false` 的准确含义是：旧正文不进入创作输入或任何新产物；事务只短暂读取旧
Git/worktree 字节计算 baseline SHA。conference aggregate 尚未接入，非空 conference refs 会失败关闭。

后续仍需实现历史专属 review/activation/push receipt，保证所有旧 URL 继续可达，并把新增的 ICML
任务页或兼容 redirect 作为受授权 addition。plan/bundle complete 仍不等于允许改写或发布历史博客。
