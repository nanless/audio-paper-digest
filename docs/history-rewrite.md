# 全历史博客重写底座

状态：已接通页面 inventory、crosswalk 和单篇官方 arXiv 来源授权；它们不会调用模型、不会改博客，
也不能单独证明已经具备全量重写能力。

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

## 已接通的来源身份基础

单篇 arXiv 页面在进入 `verified` 前，先从官方来源生成不可变授权束：

```bash
npm run history:arxiv-source -- --dry-run --id 2609.03622 --authority arxiv-2609.03622.json
npm run history:arxiv-source -- --apply --id 2609.03622 --authority arxiv-2609.03622.json
# 试点：同一进程完成官方抓取、verified decision 与 crosswalk CAS apply
npm run history:arxiv-source -- --apply --id 2609.03622 --authority arxiv-2609.03622.json \
  --crosswalk UUID --page-key page:SHA256 --decision page-verified.json --owner reviewer.1
# 页面已有多个/冲突 ID 时，操作者必须明确选择 inventory 中已有的非标题 hint
npm run history:resolve-conflict -- --apply --crosswalk UUID --page-key page:SHA256 \
  --scheme arxiv --value 2608.26786 --authority arxiv-2608.26786.json \
  --decision page-conflict-resolved.json --owner reviewer.1 --operation-id UUID
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

`history:resolve-conflict` 只适用于 `identityHints.status=conflict|multiple`。它在联网前先确认
`--scheme/--value` 精确存在于该页冻结的非标题 hints，再现场取得完全相同身份的 production
authority，最后写入 verified decision 并 CAS apply。它不读取博客正文、不按标题猜测，也不会把
单一 hint 页导入这条人工例外路径；目前 CLI 只接通已有官方适配器支持的 arXiv 身份。

`history:arxiv-analyze prepare` 通过项目代理重新抓取精确单篇 arXiv Atom 元数据，并以 live
官方全文 authority 创建独立 source-only run；原始 Atom XML 一并按 SHA 封存，旧博客正文、旧
analysis、旧 Reader 和旧 checkpoint 都不会进入输入。`analyze` 才调用现有多阶段分析引擎并产生
LLM 用量，结果留在该 run 的 `analysis.json`，不会覆盖 `data/current/deep-analysis-result.json`。

批量分析必须先用 dry-run 核对队列和精确论文范围：

```bash
npm run history:analyze-batch -- --dry-run --crosswalk UUID --stage analyze \
  --queue new-full --limit pilot --concurrency 1
npm run history:analyze-batch -- --apply --crosswalk UUID --stage analyze \
  --queue reader-recovery --paper-ids arxiv:2512.09066 --limit pilot --concurrency 1
```

`new-full` 只选择从未进入分析的完整来源，`reader-recovery` 只选择上游已完成但 Reader 未封口的
记录，`all` 才合并两者。`--paper-ids` 支持重复 flag 或逗号列表，但每项必须是规范
`arxiv:YYMM.NNNNN`；空项、重复或 crosswalk 未验证 ID 都会在联网前失败。实现升级只为旧失败
候选签发一次带 archive/SHA 的局部修复额度；dry-run 不消费额度，来源、模型、Prompt 或像素漂移
不能迁移。

API 分析的核心摘要使用 `core-summary-detailed-v3`：6–9 句、320–600 个中文/标点字符，必须交代
实际问题、2–4 步方法链及分工、原文关键定量结果（原文确无时显式声明不可得）、结论边界以及
训练/推理/部署成本（未披露时显式说明）。摘要修复只读取 source-only 证据，只替换该节并逐字
保护其余 12 节；顺序固定为 structure repair → core summary → scoring。旧 v2 fresh checkpoint 只有
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
稳定派生单篇 staging run ID。每日汇总只有在该日期的全部历史论文页面都能由已验证 staging 覆盖时
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

`history:arxiv-batch` 可安全续跑 pending single-hint 页面。SIGINT/SIGTERM 只在 token、PID、hostname、
锁目录 inode、owner inode 与 owner SHA 均仍属于当前进程时释放锁；换主或 inode 漂移时拒绝删除。
遗留死锁仍必须等 lease 到期并由脚本双重校验回收，禁止手工删除。

```bash
npm run history:crosswalk -- prepare --dry-run \
  --ledger all-history.json --receipt all-history.receipt.json --crosswalk UUID
npm run history:crosswalk -- prepare --apply \
  --ledger all-history.json --receipt all-history.receipt.json --crosswalk UUID
npm run history:crosswalk -- status --crosswalk UUID
npm run history:crosswalk -- apply --crosswalk UUID \
  --decision page-review.json --owner reviewer.1
npm run history:crosswalk -- apply-verified --crosswalk UUID \
  --decision page-verified.json --authority paper-authority.json --owner reviewer.1
npm run history:crosswalk -- finalize --crosswalk UUID
```

decision 文件只能放在 `data/runtime/page-source-crosswalks/<UUID>/decisions/`，authority 文件及其
直接命名的 proof 文件只能放在受保护的 `data/runtime/paper-source-authorities/`。生产 CLI 不接受
任意路径或序列化伪 handle；`apply-verified` 会先现场重放 bundle，普通 `apply` 拒绝 verified。
通用 `history:crosswalk apply-verified` 重新加载磁盘 arXiv bundle 时始终得到
`productionAuthorized=false`；必须使用上述组合命令，让实际官方抓取产生的 module-private opaque
handle 在同一进程完成 decision 与 apply。旧式 fixture 和自行拼出的新式磁盘链同样不能升级权限。
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
marker 下回收。跨主机、刚死亡、被篡改或带额外内容的锁都不会被猜测删除。

后续仍需实现批量 arXiv authority/decision 编排、会议 plan authority 的耐久跨进程装载，以及按
final receipt 中唯一 identity group 获取完整来源。完成这些以后，才能按唯一论文分析一次，再向
重复页面和各类汇总做确定性投影。

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
