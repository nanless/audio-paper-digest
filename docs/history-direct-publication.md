# 历史重写结果的审查与发布

历史更新与日更、会议共用386项九维词表和多级路径展示。文章只列实际所选概念及祖先导航，祖先不写入直接标签，总目录保留完整。`history:publication` 在规划、生成、审查、激活和推送前核对站点双份词表目录及原快照；缺少本批SHA时先完成受控同步，不能让旧来源记录被重签或新标签被静默隐藏。详见[统一标签规则](tag-display-policy.md#三条流程共用的目录与呈现)。

`history:publication` 发布当前[全历史重写流程](history-rewrite.md)生成的页面。它读取 `historical-direct-rewrite-plan-v5`、对应执行记录、`historical-direct-aggregate-projection-v3`、完整单篇暂存页和 `historical-direct-aggregate-v2` 汇总，逐项核对实际文件。它不读取日更正式分析，不生成日更 schema-v3 凭证，旧私有发布文件仅供兼容核验，不能作为当前来源证明。

全历史发布在当前工作区进行，发布前停止其他日更、会议和历史发布任务，同步代码与博客最新远端 `main`，按 [AGENTS.md](../AGENTS.md) 核对角色、基线和任务范围。入口已经存在，不表示某次历史现场已完成重写或发布。

## 开始前确认

- 已完成同一历史计划的单篇、每日、会议及任务页暂存，范围与冻结清单一致。
- 代码和博客远端基线已同步，其他发布任务停止，目标页面没有未知人工修改。
- 已记录用户本次实际确认的视觉范围；命令示例不能替用户排除视觉或授予豁免。
- 使用这一轮实际生成的计划、执行记录和汇总对应文件，不拼接另一轮的成功状态。

## 发布顺序与页面覆盖

```text
记录用户确认的本次视觉范围
  → 建立不可变发布计划
  → 生成私有待发布文件
  → 检查文件和 Hugo 构建，审查文本及图片
  → publish --apply 持有共享博客锁
       ├─ 核对并写入目标页面，恢复中断写入
       ├─ 只提交允许的差异，生成单父提交
       ├─ 推送并核验远端身份及 main OID
       └─ 保存发布凭证
  → status 再次核验远端
  → 人工核验部署和所有目标网页
```

完整发布要求页面对应清单覆盖冻结 inventory 的全部页面。需重写的论文页、每日汇总、会议汇总和任务页数量由本次计划推导，不能拿既有某次计划的 107 个日汇总、3 个会议汇总及 193 个任务页作通用门槛。`retainedPages` 列出的保留页必须与原 Git 基线逐字一致。

缺页、未暂存论文、缺汇总、生成文件的 SHA 与原记录不同或博客基线前进都会拒绝发布。程序从实际 `content/posts` 页面文件重新计算“重写页数 + 保留原样页数 = `inventoryPageCount`”，并把完整 `pageCoverage` 写入输入证明。发布计划再次核对数量关系、精确差异的推导及保留/生成路径不交叠，不能只相信一个完成布尔值。

## 明确视觉范围

本入口要求先记录本次视觉处置。只有用户明确限定本次是正文发布、不包含视觉任务时，才可使用 `excluded`；只有用户明确豁免视觉时，才可使用 `waived`。单说“重写全历史”不自动授予其中任何一种处置。若没有相应范围或豁免，应先落实任务要求，不能照下面示例自行排除视觉。

两种状态都不表示图片已完成。程序将 `requestedBy` 记录为 `system-contract` 或 `user`，这只是范围声明，不能代替实际用户授权。最终事务状态会显示 `published-with-visual-excluded` 或 `published-with-visual-waived`，视觉仍为 `complete:false`。

下面示例仅适用于用户已经明确确认“本次只发布历史正文，视觉不在本次范围内”。`--reason` 必须替换为真实范围说明，不能把示例文字当授权；若用户明确豁免，应改用 `--mode waived` 并记录实际豁免。

```bash
npm run history:publication -- visual-disposition --apply \
  --plan-file /absolute/path/direct-plan.json \
  --mode excluded --scope full-history-publication \
  --reason '用户已明确确认本次只发布历史正文，视觉任务不属于本次范围。' \
  --output /absolute/project/data/runtime/historical-direct-visual-dispositions/full-history.json
```

输出必须直接位于配置的 `historical-direct-visual-dispositions` 目录。先写私有临时文件，再以不可覆盖链接保存；同一命令重跑时，先重新核验已有凭证自身的 SHA，以及计划、范围、模式、原因和声明来源，全部一致才保留原创建时间与字节。恢复只清理由已退出的同机写者留下、与已验证正式文件对应的临时硬链接；旧半截文件、未知链接或不同请求都保留并拒绝，不能因此推断新增视觉授权。下面 plan/generate 的 `--visual-disposition` 使用同一个实际输出文件。

## 生成、审查与发布命令

```bash
npm run history:publication -- plan --apply \
  --publication-id UUID \
  --plan-file /absolute/path/direct-plan.json \
  --registry-file /absolute/path/direct-registry.json \
  --projection-file /absolute/path/direct-aggregate-projection-v3.json \
  --visual-disposition /absolute/project/data/runtime/historical-direct-visual-dispositions/full-history.json

npm run history:publication -- generate --apply \
  --publication-id UUID \
  --plan-file /absolute/path/direct-plan.json \
  --registry-file /absolute/path/direct-registry.json \
  --projection-file /absolute/path/direct-aggregate-projection-v3.json \
  --visual-disposition /absolute/project/data/runtime/historical-direct-visual-dispositions/full-history.json

npm run history:publication -- review --apply --publication-id UUID
npm run history:publication -- publish --apply --publication-id UUID
npm run history:publication -- status --publication-id UUID
```

所有路径和 UUID 应使用该轮实际值。上述四个阶段都有 `--dry-run`，用于预览对应阶段；审查预览只执行程序检查与 Hugo 构建，不运行语义模型，不能当作正式审查通过。`--blog-repo ABS` 可显式指定博客仓库；review/publish 支持可选 `--message TEXT`，其中提交说明由发布阶段使用。

只有用户明确选择部分论文时，plan/generate 才传 `--paper-ids ID,ID,...`。此时视觉文件必须使用 `--scope selected-sample-publication`，且只能证明所选单篇的发布，不能冒充全部历史页面及汇总已覆盖。完整发布不传该参数，使用 `full-history-publication`。

## 审查内容和续跑

页面正文、图片、模型路由及展示规则复用日更的 `publish-to-blog.py`/`publish_common.py`；不可变文件读写、Git 基线和远端读取统一由 `publication-file-primitives.js` 执行。历史适配保留冻结 URL、论文与页面集合、来源及计划 SHA，因而使用与日更不同的外层凭证，不能把这份凭证冒充日更批次。

正常 Reader 若保存 `authenticatedPdfTableEvidence`，生成与发布须通过共用的只读来源桥重放原 PDF、原表引文和行列单位证明。历史的 arXiv 与保留会议 PDF 都使用本次真实直改来源身份，不伪装日更封存目录或官方会议执行。来源文件、快照、稿件或表绑定变化会使原证明失效；不从页面提交的 PDF 路径或布尔声明授予能力，详见[表绑定数据协议](data-format.md)。

历史审查生成独立的 `historical-semantic-multimodal-v1` 凭证。模型审查前，程序先核对逐文件 SHA、front matter、标签协议、链接协议及特殊来源的非会议终稿披露；之后执行真实 Hugo 构建检查，再由独立 Python 协调器通过发布公共模型接口审查逐页文本分块及存在图片时的图文关系。它不能复用或冒充日更 schema-v3 凭证。

`PD_HISTORY_REVIEW_CONCURRENCY` 默认 5，范围 1–5。历史 Python 审查只保留一个不超过并发数的活动页面窗口，读完本轮已结束结果后再补新页；普通内容拒稿继续其余页面，最后汇总为 blocked，不能签通过凭证。结构化 `scope=run` 错误先保存失败记录，再抛出异常并停止补新页，等待已经开始的页面结束。历史、日更和会议共享普通拒稿保留审计、运行级故障停止新派发的原则，具体异常分类由各发布适配器核验。

每个通过的分块和页面保存可恢复的检查点。失败尝试（`attempt`）完整保留，不作为通过记录。每次运行中，每个实际派发的审查单元最多调用一次审查器，请求层仍保留自己的重试限制。

同一字节的内容拒稿在旧、新审查协议相同、缺失或非法时，不再次请求模型；只有原审查已完成，且两份协议均为合法 SHA、确实不同时，才可正常重审。修正内容也会形成新的输入身份。不能删除失败记录来解除门槛。

服务、余额或可信程序协议故障与论文内容错误分开处理。网络或余额失败不会永久阻止正常恢复；模型提到“实验协议”“不可用资源”不自动成为服务故障。模型建议改写最终文件时，按内容阻断返回生成或修复阶段，审查器不写回页面。

逐页通过记录永久按相对路径与实际页面内容 SHA 查找。模型、服务地址 SHA、提示词或实现 SHA、预算、并发、Hugo 或页面生成清单、计划元数据变化时，须重新执行当前批次的程序检查与 Hugo 构建，并生成新的审查凭证（review receipt），但不能重审内容 SHA 未变的页。只有页面内容 SHA 改变才重新审查该页；文本块可以复用各自输入 SHA 的通过记录。图片子审查同时绑定整页内容 SHA，避免图片 URL 不变、周围解释却改变时沿用旧结论。

当前审查协议仍计入批次的审查指纹（`review fingerprint`），用于生成新凭证及推送前校验。通过页面缓存不代替当前批次凭证，来源、基线和远端检查也不能省略。

## 写入、推送和中断恢复

独立 `activate --apply` 已被 CLI 禁用。真正写博客须使用 `publish --apply`，在与日更相同的 Git common-dir 共享锁内完成页面写入、提交、推送及远端核验。

写入前的一致性检查（CAS）及 `activation intent` 允许中断后每条路径处于原基线或目标 SHA，发现第三种字节立即拒绝。提交只包含凭证精确允许的差异，Git add 分批执行以避免路径集合超系统 `ARG_MAX`。提交已完成而推送失败时，恢复复用已有提交凭证（commit receipt），不重复创建提交。

如果新审查凭证对应的页面字节未变、页面已写入但尚未推送，activation intent/receipt 可重新绑定新 review SHA；已有提交凭证也可重新绑定新 review/activation SHA。恢复仍严格核对博客 `main`、工作区角色、基线 HEAD、路径白名单、逐文件 SHA、Git 精确差异、远端身份和 OID，不能通过更新凭证间的对应关系，掩盖来源或文件内容已经变化的事实。

重绑定也属于写入操作。内部激活接口以 `apply: false` 预览时只返回拟保存的激活记录，不改写已有激活记录或凭证；独立激活 CLI 的禁用规则不变。

## 远端与网页验收

默认 `status` 再次查询真实远端，只有 receipt、远端身份及 `refs/heads/main` OID 对应，才允许进入 Git 发布终态。`status --live-remote false` 仅作离线诊断，不会给出完整发布状态。

状态输出的 `planSha256` 和 `publicationPlanSha256` 都指本次独立发布计划；`rewritePlanSha256` 指该计划绑定的历史重写计划。`history:status` 使用后者核对当前历史计划，不能直接比较两个不同用途的 SHA。重写身份缺失、无效或不匹配时仍阻断完成；新增状态字段不改写旧计划或发布凭证。

Git 发布状态 `complete` 不表示网站已上线，也不把视觉标成完成。向用户确认本次任务完成前，仍须人工检查发布提交（或保留本批已审页面字节的后续提交）对应的 GitHub Pages 构建和部署均成功，并逐页核验全部已发布单篇、每日、会议及任务汇总的 HTTP 200、正式地址和标题，保存部署与页面核验记录。当前历史 status 没有自动执行这些检查；部署失败时须读取日志、修复并继续验收。

视觉仅按用户实际确认的本次范围或有效豁免处理；它不豁免来源、审查、远端、部署或网页检查。任何后续发布改变状态后，都应重新查询并按最新字节核验。
