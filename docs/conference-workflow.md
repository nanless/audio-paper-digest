# 会议论文：受控来源、分片重写与汇总

状态：`conference-source-ledger-v1` 与 `conference-run-v1` 是主分支中的基础
契约。它们用于把已下载的会议 PDF 变成可审计的**候选来源**；它们不自动调用
模型、不自动改历史页面，也不把某个会议全集自动发布到博客。

## 为什么不能把会议 PDF 当作普通日更

默认日更的身份和来源是 arXiv 批次。历史会议页中存在没有可靠 arXiv ID 的记录；
而一份本机 PDF 的文件名、标题相似度或旧博客标题都不足以证明它与某篇页面是同一
论文。会议论文必须先冻结会议主身份、PDF 字节和与历史页面的匹配证据。

```text
会议元数据 + 本机 PDF
  → source ledger（身份、SHA、来源状态）
  → 受控 PDF 缓存与结构化来源工件
  → 同源 fresh analysis / Reader / 评分
  → taxonomy 证据 sidecar
  → 独立论文页
  → 确定性会议汇总投影
  → generate → review → push（远端 main OID）
```

会议汇总不会重新让模型总结整批论文：它只消费已经通过来源和 Reader 门禁的单篇
投影，因此每篇深度理解只生成一次。

## `conference-source-ledger-v1`

每个 ledger 固定一个会议与年份，并对每个成员记录：

- 主身份：IEEE `arnumber`、OpenReview `forumId` 或会议官方 paper ID；标题只可作
  人工发现候选，不能充当身份或去重键。
- 官方元数据的 SHA、受控缓存内 PDF 的相对路径与字节 SHA、提取文本 SHA、结构化
  工件 SHA、提取器版本。
- 明确的来源/身份审查状态和证据。无身份、无全文或来源冲突必须保持 blocked，不能
  被投影为可分析或可发布。

本机 PDF 必须先复制到项目控制的私有运行缓存，再由相对路径引用。账本、缓存、运行
状态和绝对本机路径均是运行数据，位于 `data/runtime/`，不会提交 Git；提交到 `main`
的是契约、校验器、CLI、测试和文档。

当前只读维护命令为：

```bash
npm run conference:validate-ledger -- --ledger icassp-2026.json
npm run conference:verify-ledger -- --ledger icassp-2026.json
npm run conference:validate-run -- --run icassp-2026-pilot.json --ledger icassp-2026.json
```

名称只能是对应私有运行目录下的直接 `.json` 文件名；命令不接收任意路径、不导入文件、
不联网、不调用模型。`verify-ledger` 会重放账本中 metadata、PDF、文本与结构化工件的
字节 SHA。run 校验还会重放指定 ledger 的 SHA、会议身份和可执行成员，不能只靠
手写的 `ledgerSha256` 字段通过。

## P1：显式导入与隔离执行

导入不是日更抓取，也不会扫描下载目录。操作者必须准备一份身份优先的 manifest，其中
逐项指定官方主身份和 metadata/PDF/文本/工件的相对源路径；标题只能是 manifest 外的
人工发现线索。先用 dry-run 检查，再以不可覆盖的 ledger 输出显式写入：

```bash
npm run conference:import -- --dry-run --manifest /absolute/import.json \
  --source-root /absolute/source --cache-root /absolute/private-cache \
  --updated-at 2026-09-06T00:00:00.000Z

npm run conference:import -- --apply --manifest /absolute/import.json \
  --source-root /absolute/source --cache-root /absolute/private-cache \
  --ledger-output /absolute/private-ledger.json \
  --updated-at 2026-09-06T00:00:00.000Z
```

`--apply` 仅把 manifest 列出的单链接常规文件复制进受控 cache，并以 O_EXCL 防止覆盖；
它不联网、不调用模型。缺 PDF、文本或工件的成员会成为 `blocked`，而不是伪造
`verified`。

执行器只能从已验证 ledger 派生的 run 创建，状态文件放在
`data/runtime/conference-executions/<UUID>/`。它使用操作锁、状态 SHA CAS 和受控 patch
保证可恢复；此阶段仍不运行模型：

```bash
npm run conference:execution -- prepare --run icassp-2026-pilot.json \
  --ledger icassp-2026.json --execution 00000000-0000-4000-8000-000000000001
```

模型分析、taxonomy 分类和博客发布是后续独立阶段；它们不得通过向 execution JSON 手填
`completed` 来绕过来源和 Reader 证明。

PDF 是弱结构来源：不能可靠复原原始 TeX 时，不展示“可验证公式”；不能定位完整表格
和数值时，不展示表格；图片必须记录页码/图号及工件 SHA。不得从旧博客正文反向补造
这些证据。

## `conference-run-v1`

一个会议运行冻结以下输入 SHA：ledger、成员清单、选择策略和 taxonomy 版本。成员可
按主题、session 或连续编号分片，但分片必须不重叠且完整覆盖固定成员清单。论文状态为
来源、分析、分类、发布的逐层状态；`blocked`、未完成或尚未分类的成员不会进入可发布
聚合输入。

会议页是独立 `conference` scope，不伪装成某一天的日更。它至少应说明目录总数、身份
已核数、来源可用数、深度理解完成数、未纳入/阻断原因，以及按唯一会议身份统计的任务
分布。长文解读仍只放在单篇页。

## 与历史重写的关系

已有完整 arXiv 原文、数据闭环和简单发布拓扑的历史日期，可继续使用
[`rewrite:source`](fresh-rewrite.md)。会议记录必须先经过 ledger 和本地 PDF 来源适配器；
不能临时把 `fullText`、文件路径或旧 Reader 文本塞进 canonical。

历史重写的顺序是：来源身份闭合 → source-only 重写 → 事实/分类审核 → promotion →
旧发布凭证交接 → generate/review/push。旧 URL 与旧 receipt 不能被删除或覆盖。

## Token 与批次控制

先从覆盖不同会议、PDF 质量、任务类型与页面长度的小批试点开始。每次请求都使用既有
用量账本和 checkpoint；来源 SHA、Reader 或 taxonomy 规则发生变化才失效必要下游。
不要依据历史页面数量或一次会议目录总数直接启动全量模型调用。
