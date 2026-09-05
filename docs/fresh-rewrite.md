# 从原文完整重写已有批次

适用于用户明确要求“完全重写，不使用以前生成的正文”。这不是普通 `reanalyze` 或 `api:reader:refresh`：先创建隔离 run，只把原论文元数据、同源原文与原图送入新分析，全部成功后才提升 canonical。所有命令必须沙箱外执行。

## 分阶段入口

```bash
npm run rewrite:source -- prepare --date 2026-09-04
```

`prepare` 无网络、无 LLM 调用。它先只读复验 current 数据，固定 raw/filtered/canonical 的日期与精确论文集合，备份旧 canonical、博客文件和 Git 基线，再从 raw 中提取已筛选论文的元数据白名单。输出新的 UUID `runId`。旧生成文本仅保存在基线备份中供恢复和差异验证，不进入 `inputs.json` 或模型上下文。

```bash
rewrite_run_id='替换为 prepare 返回的 runId'
npm run rewrite:source -- status --run-id "$rewrite_run_id"
npm run rewrite:source -- sources --run-id "$rewrite_run_id" --concurrency 1
npm run rewrite:source -- analyze --run-id "$rewrite_run_id" --concurrency 3
npm run rewrite:source -- status --run-id "$rewrite_run_id"
npm run rewrite:source -- promote --run-id "$rewrite_run_id"
```

必须显式指定阶段。没有默认分析动作，不接受任意 input/output 路径，也不提供 `--reset`。日期只在 prepare 时指定，后续阶段必须沿用 runId。重复 prepare 会创建另一运行，不能用它绕过本 run 已消耗的预算或替代正常恢复。

| 阶段 | 作用与边界 |
|---|---|
| `prepare` | 本地准备、元数据白名单、精确备份与基线；不改 canonical 或博客。 |
| `sources` | 显式联网获取同源原文，按 source/artifact SHA 校验后缓存；已有完整缓存只读重放，不发 LLM。 |
| `analyze` | 只有所有原文缓存齐全才开始；调用共享分析引擎，产生全新 canonical 与 source-only Reader，结果只写本 run。 |
| `status` | 只读核对输入、原文缓存和本 run 分析身份；不补抓、不修复、不调用模型。 |
| `promote` | 全部论文成功且 fresh 来源证明完整后，由基线 CAS 模块提升 canonical 并同步论文库状态；不生成、审查或发布博客。 |

`analyze` 阶段仍可能为 LLM、资源可达性和原图进行联网，但全文读取走本 run 已验证缓存。来源 SHA 漂移、源缓存丢失或损坏、跨 run 生成内容、陈旧输入等都会失败关闭，不能用摘要或旧文章继续冒充成功。

## 隔离工件与恢复

所有路径来自 `Config.FILES.freshRewriteRunsDir`，默认 `data/runtime/fresh-rewrites/<runId>/`。目录和私有文件拒绝 symlink/path escape，不允许 CLI 改到任意位置。

| 文件 | 用途 |
|---|---|
| `run.json` | 日期、论文集合、输入/基线 SHA、来源期望和阶段状态。 |
| `inputs.json` | 仅原始 arXiv ID、题目、摘要、作者、分类和抓取来源；没有 analysis、Reader、parsed 或旧反馈。 |
| `analysis.json` | 本 run 的 canonical、失败与阶段 checkpoint；带固定 runId/batchDate。 |
| `sources/<id>/` | A 模块的原始全文、结构化工件及完整 sourceDetails 缓存，逐字节重放。 |
| `reader-attempts/` | 仅本 run 的 Reader 失败候选、请求预算与无进展计数。 |
| `baseline.json`、`baseline-files/` | 旧数据/页面恢复备份；不得作为新写作输入。 |
| `promotion.json` | 提升意图与确切新 canonical 字节，支持中断后受控重入。 |

失败后先检查失败阶段与实际 usage，再重新运行同一 runId 的相应阶段。每篇分析继续使用规范 arXiv ID 锁；拿锁后重新读取本 run 的 `analysis.json`，不与旧 canonical 合并。只有同 run、同源快照的生成状态可恢复。Reader 持久内容预算与无进展计数保存在本 run，重新执行 analyze 不会清除这些候选。外层每次命令仍按现有 analysis-engine 的 `maxRetries` 执行，累计进入次数写入 `run.diagnostics.outerAnalysisEntries`，跨命令不归零且在 status 可见；它是审计数据，不是新的硬请求上限、Token 数或 Reader 内容尝试数。

结构/来源门禁通过不等于事实与视觉已审查通过。30 篇新结果的事实、图例对象、指标方向和结果覆盖仍需独立复验。promote 后再按历史日期安全入口执行 generate → review → push，最终发布与视觉状态另行验收；不能把本 run `complete` 当成整批博客已发布。
