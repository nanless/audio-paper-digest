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
| `patch` | 显式应用同 run、同源、同失败候选 SHA 的人工局部补丁；完整 parser 通过后仍保存为 failed，保留预算，不改分析/发布状态。 |
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
| `patches/` | 显式人工补丁 JSON；文件必须 regular、单链接、0600，CLI只接受此目录直属文件名。 |
| `patches/operator-archive/<patchSHA>/` | 原补丁、修改前完整候选字节与不可变应用意图；用于审计和崩溃重入，不是成功凭证。 |
| `baseline.json`、`baseline-files/` | 旧数据/页面恢复备份；不得作为新写作输入。 |
| `promotion.json` | 提升意图与确切新 canonical 字节，支持中断后受控重入。 |

失败后先检查失败阶段与实际 usage，再重新运行同一 runId 的相应阶段。每篇分析继续使用规范 arXiv ID 锁；拿锁后重新读取本 run 的 `analysis.json`，不与旧 canonical 合并。只有同 run、同源快照的生成状态可恢复。Reader 持久内容预算与无进展计数保存在本 run，重新执行 analyze 不会清除这些候选。外层每次命令仍按现有 analysis-engine 的 `maxRetries` 执行，累计进入次数写入 `run.diagnostics.outerAnalysisEntries`，跨命令不归零且在 status 可见；它是审计数据，不是新的硬请求上限、Token 数或 Reader 内容尝试数。

### 按原文审查后的失败候选局部修正

在当前新稿中发现具体事实错误时，可在本 run 的 `patches/` 内创建局部补丁，不必为同一篇重发整篇写作请求。该入口只处理活动的失败候选：先取得 run 的 `.operation` 锁（因此等待正在运行的 analyze 结束），再取得同篇分析锁。它不接受成功文章、已归档候选、跨 run 路径或陈旧 SHA。

```bash
# 先按原文检查本 run 的新候选，生成 patches/reviewed.json，并 chmod 600。
npm run rewrite:source -- patch --run-id "$rewrite_run_id" --patch reviewed.json
# 再由正常分析恢复路径免费重验该 Reader 候选：
npm run rewrite:source -- analyze --run-id "$rewrite_run_id" --concurrency 3
```

补丁 envelope 必须且仅含：

```json
{
  "paperId": "2609.03107",
  "candidateIdentitySha256": "活动候选文件名中的64位identity SHA",
  "sourceSha256": "本run封存的原文SHA",
  "reason": "指出审查依据、原文位置及修正原因",
  "patch": {
    "version": 1,
    "draftSha256": "SHA256(JSON.stringify(payload.draft))",
    "replacements": [
      {
        "path": "/sections/0/body",
        "oldSha256": "SHA256(JSON.stringify(该旧节点))",
        "value": "该小节修正后的完整正文"
      }
    ]
  }
}
```

这些说明字符串须替换为真实 SHA。`candidateIdentitySha256` 是 identity 的哈希，不是文件内容 SHA。已有节点的 SHA 可使用 `reader-repair.hashDraft()` 计算；body字符串也必须经过 JSON.stringify，不能直接散列裸文本。最多8个互不重叠替换，只允许已有标题/中心论点、sections节点或body，以及已有conceptBridges/figurePlacements/tableBindings/formulaBindings节点；不支持新增数组项或重造顶层schema。

完整生产 parser 会复验来源工件、真实传入像素的图号、表格/公式绑定和当前机械契约。最低表数按生成器实际证据中的TABLE数量计算，而不是未经裁剪的工件总表数。任何失败不覆盖候选；通过后只保存修改后的原始draft，状态仍是 `failed`，attempts/fullAttempts/transportFailures/noProgress、旧错误及其他恢复字段不清零。`operatorPatches`追加原因、原文SHA、补丁文件SHA、前后draftSHA、旧payload/envelope SHA及归档位置。

归档先持久化，再原子替换候选；同一补丁中断后可以原命令重入，重复应用不重复审计、不重置预算。archive损坏、候选已变化或补丁文件已被修改均失败关闭。后续 `analyze` 在发起Reader请求前免费运行完整parser，通过后才沿正常流程形成结果；其余尚未完成的论文或阶段仍可能调用API。该入口不绕过事实审查，不写canonical/博客，也不能把parser通过称为事实通过。

### 修复程序升级后的显式恢复

仅在确认修复定位或诊断实现有缺陷、修复并完成离线验证后，可以运行：

```bash
npm run rewrite:source -- analyze --run-id "$rewrite_run_id" --concurrency 3 --refresh-reader-diagnostics
```

此开关不是预算重置。它只允许同 run、同原文、同模型、同写作 prompt、同输出预算的失败候选迁移到新版诊断实现；来源、主 prompt 或其他身份漂移仍拒绝。内容尝试、整篇尝试和传输失败次数原样保留，只有确实升级诊断实现时才记录旧值并清除旧诊断产生的无进展计数。旧候选可恢复归档，新候选仍必须重新通过完整 parser。多个兼容候选或损坏证据失败关闭。普通续跑不加此开关。

结构/来源门禁通过不等于事实与视觉已审查通过。30 篇新结果的事实、图例对象、指标方向和结果覆盖仍需独立复验。promote 后再按历史日期安全入口执行 generate → review → push，最终发布与视觉状态另行验收；不能把本 run `complete` 当成整批博客已发布。
