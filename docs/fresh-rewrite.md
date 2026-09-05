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
| `signed-patch` | 对同 run 已签名成功 Reader 做精确局部 operator 修订；无模型请求，复用生产封存，将隔离分析置为事实待审。 |
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

### 只恢复指定论文

`analyze` 可显式指定本 run 固定集合内的非空子集：

```bash
npm run rewrite:source -- analyze --run-id "$rewrite_run_id" --ids 2609.03586,2609.03620 --concurrency 2
```

`--ids` 仅供 `analyze` 使用，逗号分隔规范 arXiv ID，不含空项、空格、版本后缀或重复ID；集合外论文立即拒绝。它只选择交给现有分析引擎的论文，不改变 `inputs.json`、完整论文集合或 `sourceExpectations`。未选论文的状态、阶段checkpoint及Reader尝试预算保持不变；选中论文仍使用原来的锁、恢复指纹与尝试计数。

operator patch 后可只选已修论文，让该Reader候选先免费通过完整parser复验，避免顺带重试其他尚未修好的失败稿。未完成的其他阶段仍可能调用API。返回的 `complete/total`、`status` 和 promotion 条件始终按整个固定批次计算：子集成功而其他论文未完成时仍为 `analysis_partial`，退出码仍为1，不代表所选论文失败。

### 按原文审查后的失败候选局部修正

在当前新稿中发现具体事实错误时，可在本 run 的 `patches/` 内创建局部补丁，不必为同一篇重发整篇写作请求。该入口只处理活动的失败候选：先取得 run 的 `.operation` 锁（因此等待正在运行的 analyze 结束），再取得同篇分析锁。它不接受成功候选、已归档候选、跨 run 路径或陈旧 SHA；不直接编辑已签名文章。

候选允许两种既有身份：`reader-source-only-v1` 用于尚无成功 Reader 的首次新稿；`reader-source-signed-revision-v1` 用于已有成功 Reader 的未完成定向修订 scratch。后一种必须在同篇锁内重读本 run 当前父稿，经生产 `apiReaderV3BindsCanonical` 验证正文/计划/阶段来源签名，并核对完整 fresh provenance、source/artifact/sourceSnapshot SHA。没有有效同源父稿就拒绝；不能通过 CLI 布尔开关授权覆盖成功稿。前一种遇已有成功分析或有效签名 Reader 仍拒绝。

```bash
# 先按原文检查本 run 的新候选，生成 patches/reviewed.json，并 chmod 600。
npm run rewrite:source -- patch --run-id "$rewrite_run_id" --patch reviewed.json
# 再由正常分析恢复路径仅重验该已修论文（其余失败稿不进入引擎）：
npm run rewrite:source -- analyze --run-id "$rewrite_run_id" --ids 2609.03107 --concurrency 1
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

归档先持久化，再原子替换候选；同一补丁中断后可以原命令重入，重复应用不重复审计、不重置预算。archive损坏、候选已变化或补丁文件已被修改均失败关闭。首次 source-only 新稿后续由 `analyze` 在发起Reader请求前免费运行完整parser，通过后才沿正常流程形成结果；其余尚未完成的论文或阶段仍可能调用API。

signed-revision scratch 则必须回到原有定向修订服务，用当前已签名父稿与原 feedback 输入重新计算候选 identity，再免费完整解析接受。operator patch 不验证未知 feedback 的语义身份、不更新成功 paper；不能运行 `analyze` 看到旧成功稿被 skip 就声称修订完成。父稿/feedback 已变化时旧候选不可自动套用。两种模式都不绕过事实审查，不写 canonical/博客，也不能把 parser 通过称为事实通过。

### 已签名成功稿：零模型请求的局部修订

```bash
npm run rewrite:source -- signed-patch --run-id "$rewrite_run_id" --patch reviewed-success.json
```

这不是前述 failed scratch 的 `patch`。补丁仍只能是本 run `patches/` 直属 regular、单链接、0600 文件，其完整 envelope 为：

```json
{
  "version": 1,
  "runId": "原 run UUID",
  "paperId": "2609.xxxxx",
  "parentPaperSha256": "stableHash(当前完整 paper)",
  "parentArticleSha256": "当前 apiReaderArticleSha256",
  "parentPlanSha256": "当前 apiReaderPlanSha256",
  "sourceSha256": "封存原文 SHA",
  "reason": "基于原文的具体修改原因",
  "patch": { "version": 1, "draftSha256": "逆变换 proof.draftSha256", "replacements": [] }
}
```

先用 `recoverSignedReaderDraft({paper, sourceDetails, runId})` 获得 `{draft,proof}`；draft/node SHA 均使用 `reader-repair.hashDraft`（JSON 顺序语义），不是完整 paper/plan 的 stableHash。`replacements` 必须为 1–8 个既有节点，协议与前文相同。逆变换只恢复签名输出的严格等价合法输入，不能声称找回模型原始 JSON 空白或表格 selection 写法。

执行持有 operation→paper 锁，锁内重读当前父完整 paper 并做 CAS。真实 parser 复验表格、公式与正文；共用 API refresh 的最终化/签名函数注入原图，operator 仅重放路径与 SHA 验证的原图缓存，不下载、不请求模型、不伪造 readerCallModel 返回。原图缺失或漂移直接失败。新 stage 明确 `executionKind=operator`、`model=operator-local`、`protocol=local_operator`，完整原 API stage 留在 `originApiStage`；原尝试计数不清零，新增 provenance 绑定 parent/patch/sourceSnapshot/实现 SHA，并声明 `newApiRequests=0`。不会把当前 prompt SHA 签成旧稿的生成输入。

`patches/signed-operator-archive/<原补丁字节SHA>/` 保存不可变 before/request/intent/output。先封存可恢复输出，再将隔离 analysis 中的目标 paper 原子 CAS 安装，最后更新 run 的 analysis SHA。intent、output、analysis 安装、run 更新间中断都可以原命令重入；其他 paper 和 canonical/博客不改。输出具有生产结构签名，但 `readerFactReview.status=pending`，且 analysis/run 为 `fact_review_pending`，不能当作事实已通过。

### 正式接受 operator 稿的独立事实报告

无需手改状态。受授权的任务脚本在沙箱外调用 `scripts/lib/fresh-rewrite-run.js` 的 `acceptSignedReaderFactReview(request)`，其 request 必须精确包含：

```javascript
{
  runId, paperId,
  parentPaperSha256, // stableHash(当前待审 operator 完整 paper)
  articleSha256, planSha256, sourceSha256,
  reportFile,       // 同 run source-audits/ 直属 .md 文件名
  reportSha256,     // 独立报告的原始文件字节 SHA256
  reviewer, verdict: 'pass'
}
```

报告必须 regular、单链接、0600，并明确写出该 paper ID 与上述四个完整内容 SHA；只有事实/原图独立审查确已通过才可提交 `pass`。服务重验报告字节、封存源、签名父稿和完整 paper CAS，先持久化 `patches/signed-fact-reviews/<reportSHA>/<paperId>.json`，再安装该篇事实接受状态并更新 run SHA；中断可用同一 request 重入，不重写正文/计划、不增加 API 使用量。

单篇接受不代表全批事实已审完。首次 operator 修订保留全局 `operatorFactReviewBaseStatus`：原本已有的 API/signed 批次事实 pending/failed 不会被最后一个 operator 接受清除，当前新增失败也优先保留。只有 operator 自身从 complete 引入的待审、所有 operator 均已接受且全篇生产结构成功时，才能恢复原 complete。其他批次事实工作必须在操作层按全部最终 article/plan/source 与独立报告闭合后再显式恢复；状态完整性本身不是独立 QA 证书。任何仍为 `readerFactReview.pending` 的 paper 都会额外阻断 promote，即使一次普通 analyze 跳过成功稿后把整批状态改回 complete。

### 修复程序升级后的显式恢复

仅在确认修复定位或诊断实现有缺陷、修复并完成离线验证后，可以运行：

```bash
npm run rewrite:source -- analyze --run-id "$rewrite_run_id" --concurrency 3 --refresh-reader-diagnostics
```

此开关不是预算重置。它只允许同 run、同原文、同模型、同写作 prompt、同输出预算的失败候选迁移到新版诊断实现；来源、主 prompt 或其他身份漂移仍拒绝。内容尝试、整篇尝试和传输失败次数原样保留，只有确实升级诊断实现时才记录旧值并清除旧诊断产生的无进展计数。旧候选可恢复归档，新候选仍必须重新通过完整 parser。多个兼容候选或损坏证据失败关闭。普通续跑不加此开关。

结构/来源门禁通过不等于事实与视觉已审查通过。30 篇新结果的事实、图例对象、指标方向和结果覆盖仍需独立复验。promote 后再按历史日期安全入口执行 generate → review → push，最终发布与视觉状态另行验收；不能把本 run `complete` 当成整批博客已发布。
