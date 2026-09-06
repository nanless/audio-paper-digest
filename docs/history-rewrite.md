# 全历史博客重写底座

状态：当前只接通 `historical-page-ledger-v1` 页面 inventory；它不会调用模型、不会改博客，
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

`page-source-crosswalk-v1` 会严格重放 canonical ledger/receipt 字节与自校验 SHA，再以 opaque
handle 为每个 `kind=paper` 页面建立隔离、可恢复的 pending 状态。assignment 只含页面路径和
整页 SHA，不带标题、标签或旧正文；受控 decision/CAS 可以记录 `needs-review`、`blocked`、
`conflict`，也可以在已重放 `paper-source-authority-v1` opaque handle 时记录 `verified`。

authority bundle 必须同时绑定 canonical `paper-identity-v1` 完整记录、身份核心 SHA、完整记录
SHA、authority 文件 SHA/self-SHA、证据类型、全文 SHA 与来源快照 SHA。arXiv fixture 合同会重放
official abs URL、source snapshot、receipt 和完整全文字节；会议合同会重放真实 plan/import/ledger/
source-context opaque 链。页面还必须有一个与 authority 精确相同、来自文件名、显式 frontmatter
ID 或正文官方链接的 identity hint；标题永远不能成为 verified 证据。

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
当前尚未提供自动生成 arXiv authority/decision 的生产 runner，因此 CLI 会明确拒绝自包含的 arXiv
fixture；会议 authority 还要求当前进程中的 authenticated plan handle，因此命令行消费同样会有意
失败关闭。测试 fixture 只证明合同与重放机制，不能当作真实历史来源收集已完成。

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

后续仍需实现真实 arXiv authority 采集 runner、会议 plan authority 的耐久跨进程装载，以及按
final receipt 中唯一 identity group 获取完整来源。完成这些以后，才能按唯一论文分析一次，再向
重复页面和各类汇总做确定性投影。

发布前还需要历史专属 completion proof 与 publication transaction，保证所有旧 URL
继续可达，并把新增的 ICML 任务页或兼容 redirect 作为受授权 addition。当前 inventory
通过不等于允许改写或发布历史博客。
