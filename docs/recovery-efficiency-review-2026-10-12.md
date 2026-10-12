# 2026-10-12 离线恢复与重复计算审查

基准提交为 e788aa501fbba2bee1a8f79798df6e8f250f8fd3。本次只修改隔离源码与测试，不启动生产、模型或冷备恢复。没有端到端十倍加速的实测；本次修复消除已完成同反馈稿的分析入队，并避免预检拒绝丢失检查点造成后续重复计算。

## 审查范围与结论

| 文件 / 边界 | 结论 |
| --- | --- |
| `package.json`、`AGENTS.md`、`SKILL.md`、`scripts/README.md` | 以实际 npm 入口及封存来源规则为准。普通恢复和显式强制重分析不能共用跳过语义。 |
| `scripts/batch-analyze.js` | e788aa5 已有严格同反馈复用判断，初筛与锁内重读一致；原函数在 CLI 模块中，不适合供另一个入口反向加载。 |
| `scripts/deep-analysis-only.js` | 确定缺陷：初筛中 `feedback || ...` 无条件入队，锁内仅无反馈可跳过，导致同一已完成纠错重复执行。已修。 |
| `scripts/lib/completed-bound-fact-feedback.js` | 新公共库，逐字搬移原严格判定。仍要求完整资格、真实当前来源、所有活跃阶段证明、错误原句检查，以及 Reader 原始或公共渲染反馈 SHA。绑定无效仍抛错。 |
| `scripts/deep-analyzer.js`：恢复清单、事实预检、文本阶段指纹与保存 | 确定缺陷：恢复状态准备先删真实检查点，再拒绝事实范围；外层正常失败保存使旧合格正文缺失证明。已将准备动作隔离，预检接受后才应用。全文强制失效和后续阶段核验不变。 |
| `scripts/analysis-engine.js`：论文锁、重试、检查点回调、中央合并与失败保存 | 新反例经真实公共入口、论文锁与中央保存执行。修后继续记录失败，不把旧正文当作本次成功；原检查点与正文保留。锁、合并、generation 及重试分类未放宽。 |
| `scripts/lib/daily-fresh-source-plan.js`、`fresh-analysis-context.js` | 来源丢失/变化仍停止或按正常规则失效。`prepareDailyPaper` 仅在绑定失败时删除生成字段，未发现以“读不到来源”为换新理由的可复用漏洞；不缓存未核验来源。 |
| `scripts/lib/daily-fact-review.js`、`primary-fact-local-repair.js` | 原反馈、四源与当前正文 SHA 绑定不变。跳过不能只看错误原句消失，必须同时通过完整阶段证明。 |
| `scripts/reanalyze.js` | 明确强制全部重分析并停用旧 Reader 稿；未加入本次普通恢复跳过判断。 |
| `scripts/refresh-api-reader.js` | 显式 Reader / 评分刷新，未加入普通续跑跳过判断。 |
| `docs/reader-explicit-retry.md`、`docs/reader-writing.md`、`docs/reader-efficiency-plan.md` | 保留额度、来源及发布规则；既往试写提速目标不能当作当前实测。 |

## 冷备反例

06430 的 R14 与 R15，06074 的 R15 与 R16：manifest、正文与 Reader 完全相同，后一次仅增加事实范围预检错误，并删除原 `structureRepair`、`tagSelection` 检查点。05768、11057 在 R10 有与 R15 完全相同的正文、Reader、manifest 和真实检查点；丢失发生在 R14 以前。四份证据仅作只读回归依据，本轮未恢复记录。

对应只读报告保存在 `/tmp/reader-r261-early-manifest-checkpoint-loss.json`、`/tmp/reader-r261-three-cold-checkpoint-census.json`、`/tmp/reader-r261-real-checkpoint-restore-proof.json` 和 `/tmp/reader-offline-r16-06074-checkpoint-loss.json`，未纳入仓库，也未将正式数据复制为测试样例。

## 有效验证

新增三个公共反例使用生成的合法的完整测试样例和本地封存来源，不替换成功资格判断：

1. `deep` 完整资格且同反馈时不调用分析批次；新反馈必须入队，锁内再完成可跳过，正文再次出现错误后不可跳过。
2. 正常长文入口在事实范围预检拒绝后，原分析清单、真实检查点和读者长文 逐字不变。
3. 经实际 `deep`、正常论文锁和中央失败保存后，仍保留原正文、读者长文和检查点，且保留失败标记。

旧 e788aa5 源码运行这三个新测试为 0/3；修后 3/3。六个相关文件共 151/151：新增 deep、既有 batch 同反馈、daily fact review、primary local entry、analysis contract runtime regressions、analysis engine。仅离线测试，没有新的模型请求或正式数据写入。

## 未修项与限制

- 四篇旧 `revision.not_needed` 的 localFactValidation 来源、输入/输出 checkpoint 与 receipt 可对应，但原 revision fingerprint 尚未按真实原配方重算一致。保守拒绝自动改为 `complete`；未交付该迁移。新记录的终态单行修复已由主助手完成，不能据此假定旧记录合格。
- 本次保护的是任何付费请求前的事实范围预检。来源或正文实际变化后的正常失效仍会删除相关阶段；不能扩大为“所有失败都回滚所有状态”。
- 同反馈判定仍完整读取来源与核验资格，未为减少 I/O 缓存来源 SHA。按论文/阶段重复核验的耗时需独立测量后再优化，不能牺牲封存来源完整性。
- 自动恢复历史丢失检查点需要独立授权和公开锁内恢复协议；本轮仅保存证据，未安装或执行此前的恢复辅助脚本草稿。
- 请求费用、Reader 次数上限、尝试轮次、章节数、像素、数字、表格、公式来源及发布资格均未放宽。
