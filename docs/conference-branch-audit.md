# 历史会议分支审计与迁移边界

审计日期：2026-09-06。目标分支为 `icassp-2026-analysis`、
`iclr-2026-analysis`、`icml-2026-analysis`；目标落点是当前 `main` 的受控会议流程。

## 总结

三个分支都从较早主线分叉，并通过复制当时的共享文件进行“同步”。它们与当前
`main` 的身份、来源、Reader、评分、taxonomy、账号池、锁、manifest、review 和远端
OID 协议已经不兼容。禁止整体 merge、整文件覆盖或批量 cherry-pick；只迁移经过重写
和测试的会议专属算法与产品经验。

分支中没有受版本控制的正式会议数据。旧筛选、全文、分析与图片主要是本机运行数据，
因此 Git 提交历史不能证明某次会议处理完整或可重放。

## ICASSP 2026

- 本机候选为 3,694 条 `{arnumber,title}` 元数据及 3,694 份 PDF。标题归一化当前可找到
  全部文件，但标题只允许用于候选发现；最终身份必须是 IEEE `arnumber`。
- 旧入选/分析约 898 篇，但旧筛选闭包存在 6 篇没有决定、5 篇同时入选和排除。旧结果
  没有 source SHA、Reader、analysis manifest 或 generation proof，只能作为对照语料。
- 远端分支的筛选 Prompt 与解析器格式已经冲突；图片配置也会导致实际发送 0 张图。
- 可借鉴：批量 PDF 候选定位、分页提取、任务分组和会议总览设计。
- 禁止迁移：标题作为身份、直接 HTTPS 模型请求、失败即排除、标题/摘要降级发布、
  `git add -A`、宽泛删除博客图片、无凭证图床上传。

## ICLR 2026

- 本机有 5,352 条 OpenReview 元数据和 5,352 份以 `forum_id` 命名的 PDF；旧音频候选
  957 篇，旧历史入选/分析 133 篇。133 篇的 forum ID、标题、作者和 PDF 能精确对应。
- 旧 133 篇没有 source SHA、usage、Reader 或筛选 I/O 证明，不能作为新正文来源。
- 最终分支已把会议 PDF 入口与 arXiv-only analyzer 错配；筛选 Prompt 和解析器同样
  冲突，当前分支 HEAD 不能正确重跑。
- 可借鉴：OpenReview ID 文件布局、PyMuPDF 图注/绘图区域候选、会议任务视图。
- 禁止迁移：`arnumber=forum_id` 兼容伪装、自由标签、`data/current` 会议状态和旧发布器。

## ICML 2026

- 当前官方元数据缓存为 6,567 篇；旧分支快照只有 6,341 篇，漏 226 篇，旧会议总数和
  筛选集合不能继续作为完整真值。
- 历史入选 137 篇实际都有本机 OpenReview PDF 和文本；目录中共 139 份 PDF，额外 2 份
  需要身份复核。所谓“只有 47 篇 PDF”只指额外 arXiv 副本，不是正文总覆盖。
- 旧 137 篇仍缺来源/provenance；19 篇文本命中过时的 120k 前缀截断。旧标签还存在
  26 篇空标签、9 篇缺主任务、4 篇缺主方法。
- 可借鉴：OpenReview forum ID 与会议 numeric ID crosswalk、元数据先筛再下载、逐页
  提取和会议排行榜投影。
- 禁止迁移：读取 Chrome Cookie/Keychain、模糊标题映射 arXiv、覆盖式下载、任意
  `fullText/imageUrls` 注入、摘要降级以及混合 generate/review/push 的旧发布器。

## 统一迁移顺序

1. `conference:discover` 冻结官方 catalog、主身份和本地 PDF 候选报告。
2. 会议筛选保存全集逐篇决定；失败保持 pending/failed，不得等于 excluded。
3. included 论文经固定提取器、人工复核 staging、受控 importer 和 opaque ledger handle
   形成完整来源快照；任何阶段都重放上游 receipt。
4. 会议 production source context 只接受完整上游链签发的 opaque plan handle；低层
   ledger/run builder 仅供 unauthorized fixture。后续 analysis adapter 只写隔离 execution，
   复用当前 Reader、评分和 usage 基础设施，不写 daily `data/current`。
5. taxonomy evidence sidecar 绑定当前 registry SHA、原文证据和 unknown/conflict 审核。
6. conference publication scope 生成稳定单篇 URL、任务视图和会议汇总，经
   generate → review → exact push → remote OID。
7. 先做 3–5 篇试点，再重写历史入选集；最后对会议全集重新筛选并更新完整汇总。

旧分析和旧博客正文只用于差异检查，任何新 Reader、标签、评分或汇总都不得把它们作为
生成上下文。
