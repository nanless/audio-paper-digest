# 从原文完整重写已有批次

`rewrite:source` 用于用户明确要求不使用以前生成的正文、重新解读一个既有日批次的情况。它先创建隔离运行，只用原论文信息、同源全文和实际图片开展新分析，全部成功后才替换正式分析结果。所有命令须在沙箱外执行；该入口及 `blog:activate-fresh` 要求 `history` 工作区，运行前先核对目录和角色。

```bash
pwd
npm run workspace:role -- status
```

本页处理一个既有批次。全历史重写使用[历史重写流程](history-rewrite.md)，不得把两套运行目录、计划或进度文件混用，也不能让旧 crosswalk 或试运行成为本地有效来源的前置条件。

当前新运行保存本次从官方 arXiv 获取的四文件来源，使用 `sealed-arxiv-bundle-v1`；每篇位于本运行的 `sources/<id>/generation-000001/`，包含 `source.txt`、`source.pdf`、`source-runtime.json`、`source-manifest.json`。`generation` 是获取序号，不是论文的 `vN` 修订号。旧 `fresh-source-cache-v1` 仅用于既有运行的兼容读取，不能拿来替代新来源。

## 分阶段入口

```bash
npm run rewrite:source -- prepare --date 2026-09-04
```

日期是已有批次示例。`prepare` 不抓取论文，也不调用模型：它先校验当前候选、入选和分析数据的日期及精确论文集合，备份旧分析、博客文件和本地 Git 基线，再从候选中提取入选论文的原始信息白名单。博客须干净且处于 `main`；这里仅核对本地 Git，尚未验证远端。命令返回新的 UUID `runId`，旧生成文本只留在基线备份中，不进入 `inputs.json` 或模型上下文。

```bash
rewrite_run_id='替换为 prepare 返回的 runId'
npm run rewrite:source -- status --run-id "$rewrite_run_id"
npm run rewrite:source -- sources --run-id "$rewrite_run_id" --concurrency 1
npm run rewrite:source -- analyze --run-id "$rewrite_run_id" --concurrency 3
npm run rewrite:source -- status --run-id "$rewrite_run_id"
npm run rewrite:source -- promote --run-id "$rewrite_run_id"
```

阶段必须显式指定，没有默认分析动作，也不接收任意输入、输出路径或 `--reset`。日期只在 `prepare` 指定，其后沿用同一 `runId`。`--concurrency` 只供 `sources` 和 `analyze` 使用，范围 1–5。重复准备会创建另一运行，不能用来绕过原运行预算或代替正常恢复。

| 阶段 | 作用和限制 |
|---|---|
| `prepare` | 校验原始数据，固定论文信息、精确备份及基线，不改正式分析或博客。 |
| `sources` | 为新运行获取官方文本和 PDF，保存并核验四文件；同一获取序号已有完整来源时只重验，不发模型请求。 |
| `analyze` | 全部来源齐全后进入共享分析引擎，产生新分析和只依据原文的解读，结果写入本运行。 |
| `status` | 核对输入、来源和本运行分析身份，不补抓、不修复、不调用模型。 |
| `patch` | 对符合旧运行身份条件的活动失败候选应用人工局部补丁；解析通过仍保留失败状态和预算，不能直接发布。 |
| `signed-patch` | 对符合旧运行身份条件的已核验成功解读作局部修订，无模型请求，修订后等待独立事实审查。 |
| `promote` | 全部论文成功、来源及事实状态符合要求后，按基线比较当前字节再替换正式结果，同步论文库，不生成或发布博客。 |

新来源通过官方 HTML/PDF 获取并逐文件保存，图片只在当前调用的系统临时目录准备，不持久保存到运行缓存。`analyze` 仍可能为模型、资源可达性和原图联网，但全文只读本运行已核验来源。来源变化、文件缺失或损坏、跨运行生成内容及陈旧输入都会阻止继续，不能用摘要或旧文章替代。

### 当前人工补丁的兼容限制

当前新 `prepare` 在 `sourceExpectations` 中保存 `sourceMode=sealed-arxiv-bundle-v1` 和 `sourceGeneration=1`，取得来源后把具体 SHA 写入 `sourceRecords`，不会回填原始期望。现有 `patch` 与 `signed-patch` 都要求补丁中的来源 SHA 等于 `sourceExpectations` 中的旧来源 SHA，因此不能直接用于这类新四文件运行。`signed-patch` 的正文恢复还只接受 `version=1`、`fresh-source-cache-v1` 来源描述。

以下补丁段落说明当前实现接受的旧运行维护方式。命令存在不代表任何新运行都能使用；不得手改运行清单、补入假 SHA、把新描述改成旧版本或复制旧像素缓存来绕过检查。普通新运行仍按 `sources`、`analyze` 和已有恢复规则处理，兼容能力的代码修改属于另一个任务。

### 已发布批次的记录交接

已发布日期的旧生成清单和审查记录是不可覆盖的历史依据，不能删除它们绕过生成保护。显式交接入口只支持基线中恰有一次整批及一次单篇发布的情况：

```bash
# 全部正文验收并 promote 后，先核验，不改发布记录
npm run blog:activate-fresh -- --run-id "$rewrite_run_id" --dry-run
# ready 后归档旧记录，再正常生成、审查和推送
npm run blog:activate-fresh -- --run-id "$rewrite_run_id"
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

交接仅归档两组生成清单、审查记录及逐页通过缓存，共六个精确路径。原字节保存在本运行的 `publication-archive/`，另记录 `publication-activation-intent.json` 和 `publication-activation.json`。原图、博客内容、视觉、封面及取消配图记录不在归档范围。

旧审查记录须在各自原提交中重验，当前博客须干净，`HEAD`、基线、实时远端 OID 和身份都须匹配。Node 先持运行操作锁，Python 再持博客仓库及日期锁；未完成交接的独立标记会阻止生成、审查和推送，须重入原命令恢复。

重写运行的 `status=promoted` 和 `run.json` 原字节不再改变，交接完成记录绑定它们及全部归档 SHA，不能把后续发布状态写回该文件。发布历史、来源、远端或文件情况不符时停止，不能扩展归档范围。

## 隔离文件与恢复

路径来自 `Config.FILES.freshRewriteRunsDir`，默认 `data/runtime/fresh-rewrites/<runId>/`。目录及私有文件禁止符号链接和路径越界，命令不允许改到任意位置。

| 文件或目录 | 用途 |
|---|---|
| `run.json` | 日期、论文集合、输入及基线 SHA、来源期望和阶段状态。 |
| `inputs.json` | 原始 arXiv ID、题目、摘要、作者、分类及抓取来源，不含分析、解读、解析缓存或旧反馈。 |
| `analysis.json` | 本运行分析、失败及阶段检查点，绑定固定 `runId` 和 `batchDate`。 |
| `sources/<id>/generation-000001/` | 新运行的文本、PDF、来源信息和清单四文件。旧运行的兼容来源目录仍按其原身份核验。 |
| `reader-attempts/` | 本运行解读失败候选、请求预算及无进展计数。 |
| `patches/` | 人工补丁 JSON，须为普通文件，硬链接数为 1 且权限为 `0600`，只接受该目录直属文件名。 |
| `patches/operator-archive/<patchSHA>/` | 原补丁、修改前完整候选字节及不可变应用记录，用于审计和中断恢复，不证明成功。 |
| `baseline.json`、`baseline-files/` | 旧数据和页面的恢复备份，不能作为新写作输入。 |
| `promotion.json` | 替换正式结果的操作记录和精确新字节，支持中断后重入。 |

失败后先查阶段及实际用量，再运行同一 `runId` 的相应阶段。每篇使用规范 arXiv ID 锁，拿锁后重读本运行 `analysis.json`，不与旧正式结果合并。只有同运行、同来源的生成状态可恢复；已接受的来源丢失时，程序不会隐式重新抓取来替换它。

解读内容预算和无进展计数保存在本运行，重新执行分析不清零。外层每次命令沿用分析引擎 `maxRetries`，累计进入次数写入 `run.diagnostics.outerAnalysisEntries`，跨命令保留并可由状态命令查看。它是审计计数，不是新的硬请求上限、token 数或解读内容尝试次数。

### 只恢复指定论文

`analyze` 可选择固定论文集合中的非空子集：

```bash
npm run rewrite:source -- analyze --run-id "$rewrite_run_id" --ids 2609.03586,2609.03620 --concurrency 2
```

`--ids` 只供分析阶段使用，以逗号分隔规范 arXiv ID，不含空项、空格、版本后缀或重复 ID；集合外论文会被拒绝。选择只影响交给引擎的论文，不改 `inputs.json`、完整集合或 `sourceExpectations`。未选论文的状态、检查点及预算不变，选中论文沿用原锁、恢复指纹和计数。

符合旧运行补丁条件时，可只恢复已经修正的论文，让解析器先本地重验候选，避免顺带重试其他失败稿；未完成的其他阶段仍可能请求模型。`complete/total`、`status` 和替换正式结果的条件仍按全批计算。所选论文成功而其他论文未完成时，结果仍为 `analysis_partial`、退出码为 1，不代表所选论文失败。

### 按原文修正失败候选

本段仅适用于前述兼容身份满足条件的旧运行。发现具体事实错误后，可在本运行 `patches/` 创建局部补丁。程序先取得运行操作锁，再取得同篇分析锁，等待正在执行的分析结束；不接受成功或已归档候选、跨运行路径及陈旧 SHA，也不直接修改已核验成功正文。

`reader-source-only-v1` 用于尚无成功解读的首次新稿，已有成功分析或有效解读时拒绝此方式。`reader-source-signed-revision-v1` 用于定向修订中尚未完成的草稿，必须在论文锁内重读父稿，通过 `hasValidApiReaderV3Records`，核验正文、计划、阶段来源及完整来源 SHA。没有有效同源父稿就拒绝，不能用布尔开关授权覆盖成功稿。

```bash
# 按原文审查本运行候选，创建 patches/reviewed.json 并 chmod 600
npm run rewrite:source -- patch --run-id "$rewrite_run_id" --patch reviewed.json
# 仅让正常分析恢复路径重验已修论文
npm run rewrite:source -- analyze --run-id "$rewrite_run_id" --ids 2609.03107 --concurrency 1
```

补丁对象必须且仅含以下字段：

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

说明字符串须换成真实 SHA。`candidateIdentitySha256` 是候选身份哈希，不是文件字节 SHA。草稿及节点可用 `reader-repair.hashDraft()` 计算；正文字符串也须经过 `JSON.stringify`，不能散列裸文本。最多 8 个互不重叠的替换，只允许已有标题、中心论点、`sections` 节点或正文，以及已有 `conceptBridges/figurePlacements/tableBindings/formulaBindings` 节点，不新增数组项或重造顶层格式。

完整生产解析器重验解析所得的来源证据、实际传入像素的图号、表格、公式和当前结构规则。最低表数取实际生成证据中的 `TABLE` 数量，不取未经裁剪的原始证据条目总数。失败不覆盖候选；通过后只保存修改后的原始草稿，仍为 `failed`，不清零 `attempts/fullAttempts/transportFailures/noProgress`、旧错误及其他恢复字段。`operatorPatches` 追加修改原因、原文 SHA、补丁 SHA、前后草稿 SHA、旧候选和补丁对象 SHA 及归档位置。

归档先持久保存，再原子替换候选。同一补丁中断后可重入原命令，不重复审计或重置预算；归档损坏、候选变化或补丁文件修改时停止。首次只依据原文的新稿，由后续分析在发解读请求前先本地完整解析，通过后才形成结果；其他未完成论文或阶段仍可能调用 API。

定向修订草稿须回到原修订服务，用当前父稿和原反馈重新计算身份后解析接受。人工补丁不核验未知反馈的语义身份，也不更新成功论文；普通分析跳过旧成功稿不代表修订完成。父稿或反馈改变后，不能自动套用旧候选。两种方式都不写正式数据或博客，解析通过也不等于事实审查通过。

### 已核验成功解读的局部修订

本段同样只用于满足旧来源身份及正文可恢复条件的运行：

```bash
npm run rewrite:source -- signed-patch --run-id "$rewrite_run_id" --patch reviewed-success.json
```

它处理成功稿，区别于失败草稿的 `patch`。补丁仍须是本运行 `patches/` 下的直属普通文件，硬链接数为 1 且权限为 `0600`，完整字段如下：

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

先用 `reconstructReaderDraftFromVerifiedArticle({paper, sourceDetails, runId})` 获得 `{draft,proof}`。草稿和节点 SHA 使用 `reader-repair.hashDraft` 的 JSON 顺序规则，不是完整论文或计划的 `stableHash`。`replacements` 须为 1–8 个已有节点，规则与前文相同。恢复出的输入须能重新生成相同正文、计划和图来源，不能声称找回模型原始 JSON 空白或表格选择写法。

执行先持运行锁，再持论文锁，锁内重读父论文并比较 SHA 后才修改。真实解析器核验表格、公式和正文，共用 API 刷新的最终处理函数；人工操作只重用路径和 SHA 已核验的旧原图缓存，不下载、不请求模型，也不伪造 `readerCallModel` 返回。原图缺失或变化时停止。

新阶段明确 `executionKind=operator`、`model=operator-local`、`protocol=local_operator`，保留完整原 API 阶段于 `originApiStage`，不清零原尝试次数。新增来源记录绑定父稿、补丁、来源快照及实现 SHA，声明 `newApiRequests=0`，不会把当前提示词 SHA 冒充旧稿生成输入。

`patches/signed-operator-archive/<原补丁字节SHA>/` 保存不可变的修改前数据、请求、操作记录和输出。先保存可恢复输出，再比较并原子更新隔离分析中的目标论文，最后更新运行的分析 SHA；各步骤间中断均可重入原命令。其他论文、正式数据和博客不改。输出通过结构及来源核验，但 `readerFactReview.status=pending`，分析及运行为 `fact_review_pending`，事实仍待独立审查。

### 接受独立事实审查报告

无需手改状态。获授权的任务脚本在沙箱外调用 `scripts/lib/fresh-rewrite-run.js` 的 `acceptReaderOperatorFactReview(request)`；这不是另一个命令行阶段。请求须精确包含：

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

报告须是普通文件，硬链接数为 1 且权限为 `0600`，明确写出论文 ID 及上述四个完整内容 SHA；事实和原图确已独立审查通过，才可提交 `pass`。服务重新核验报告字节、封存来源、父稿和完整论文 SHA，先持久保存 `patches/signed-fact-reviews/<reportSHA>/<paperId>.json`，再保存事实审查通过状态并更新运行 SHA。中断可用同一请求重入，不重写正文、计划或增加 API 用量。

单篇接受不代表全批已审完。首次人工修订保留 `operatorFactReviewBaseStatus`；原批次已有的事实待审或失败，不会被最后一篇人工稿接受清除，后来新增失败也优先保留。只有人工修订从 `complete` 引入的待审、所有人工稿都已接受且全篇结构检查成功时，才可恢复原完成态。其他批次事实工作须核对全部最终正文、计划、来源及独立报告后另行恢复。任何论文的 `readerFactReview.status=pending` 都额外阻止替换正式结果，普通分析跳过成功稿并把批次写成完成也不能绕过。

### 修复程序升级后的恢复

仅在确认修复定位或诊断实现有缺陷、完成修正和离线验证后，使用：

```bash
npm run rewrite:source -- analyze --run-id "$rewrite_run_id" --concurrency 3 --refresh-reader-diagnostics
```

此开关不是预算重置。它只允许同运行、同原文、同模型、同写作提示词和输出预算的失败候选迁到新版诊断实现，其他身份变化仍拒绝。内容、整篇及传输失败次数保留；只有确有诊断实现升级时，记录旧值并清除旧诊断的无进展计数。旧候选可归档恢复，新候选仍须完整解析，多候选歧义或损坏证据会停止，普通续跑不加此开关。

局部修复通常为 8000 tokens。精确在基础上限截断后先保存并停止，符合条件时下次显式续跑才可取得一次较高预算，默认最多 16000；与实现升级的额外次数共用，不可叠加。只要模型返回内容，就计入尝试次数，纯传输失败不耗内容次数，截断 JSON 无效，自定义上限仍受正文及基础预算约束。

结构和来源检查通过，不等于事实或视觉已通过。本批新结果的事实、图例对象、指标方向及实验覆盖须独立复核。替换正式结果后只从历史日期允许的安全发布阶段运行生成、审查和推送，不从抓取重跑；再核验远端、Pages 构建和部署、全部页面及视觉状态。重写运行完成不能当作博客已经上线。
