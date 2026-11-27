# 音频研究工作台操作手册

本手册用于执行日更、官方会议和历史博客更新。先完成运行前检查，再进入对应流程；失败恢复与专项约束放在正常步骤之后。执行限制见 [AGENTS.md](AGENTS.md)，实际代码与 Prompt 对应见 [三流程表](docs/three-workflows.md)，配置参数见 [安装配置](docs/setup.md)。

修改文档或提示词时，先按[把技术写清楚](skills/clear-technical-writing/SKILL.md)核对事实与表达，再按[项目写作约定](docs/writing-guide.md)检查术语、图表和操作说明；写作调整不改变下述执行限制。

本页与 [AGENTS.md](AGENTS.md) 有规则重叠时，以 `AGENTS.md` 为准；本页只按执行顺序重述必要步骤，不新增或放宽约束。

## 初次阅读时怎样使用本页

先看[项目导读](docs/project-guide.md)，分清公开网站、个人阅读应用和内容生产。执行任务时按正常流程进入；只有实际失败或维护旧记录时，才使用对应恢复章节。

本页保留代码中需要精确对应的名称。Reader 是论文解读长文；父稿是本次修改所依据的原稿，子稿是由它派生的新稿；CAS 是写入前核对原稿是否已变化的保护方式。“从原文件重新核验”表示实际重读保存的材料，不只相信过去的通过状态。更多术语见[写作约定](docs/writing-guide.md#术语先解释再统一称呼)。

规则中的“仅”“必须”“禁止”、次数和来源范围各有具体作用。多个条件须同时满足时，不能只选其中一条；只读核验通过也不自动授予模型请求、写入或发布权限。下面的正常流程、恢复条件与完成要求分别阅读，不能互相替代。

## 持续授权与执行选择

用户已授权三条流程中为提高效率和效果所需的全部付费轮次，包括失败恢复、局部修复、必要的完整重生成和审查。不要再次逐篇、逐轮或逐阶段询问费用授权；仅用户后续明确撤销或另设限制才改变此授权。执行细则见 [AGENTS.md](AGENTS.md#持续授权以效率和效果为准)。

先全批正常处理，再集中续跑失败集合；优先复用合格来源、检查点、成功稿及已付响应。遇到持续无进展，判断应修共性规则、正常付费修复还是来源绑定人工收尾，选择更快获得合格结果的路径。旧清单的轮数和响应上限是单窗口技术限制，不是用户的总授权上限；必要时由执行者登记有完整前序历史的新窗口，实现不支持则修正验证后继续。旧许可、原计数和费用不得改写或清零，新增调用另记，正常来源、质量和发布核验仍须通过。

## 运行前

Reader 指面向初学研究者的解读长文；内部主分析、来源和发布凭证分别核验。常见术语见[写作约定](docs/writing-guide.md#术语先解释再统一称呼)。下列检查未通过时，先停止，不用生产任务测试配置。

1. 先跑只读体检 `npm run doctor -- --offline`（需要探测 arXiv 时用 `--network`），再核对 `pwd`，将 `$HOME/code/github_repos/audio-research-workbench` 展开为真实绝对路径并确认当前工作区一致，执行 `npm run workspace:role -- status`；角色保持 `daily`。历史操作通过已配置跨角色开关运行，不进入废弃工作区。
2. Node、Python 和依赖有效，项目 `.env` 权限为 `0600`。主模型及启用的副模型按项目配置统一为 `muse-spark-1.3-contributor`（2026-11-16 起，环境上限 `xhigh`，默认按阶段分级推理：主分析与 Reader 长文保持 `xhigh`，审校与 Reader 局部修复为 `high`，图片与摘要/表格/结构修补为 `medium`，日更筛选与发布文本审查为 `low`，纯机械结构化阶段为 `minimal`）；arXiv 抓取强制使用项目 HTTP CONNECT 代理。多账号共享池默认启用到期优先调度（`PD_LLM_ACCOUNT_POOL_STRATEGY=expiry_priority`，三窗口均有额时按北京时间月到期最早、同天剩余月额度最多优先；运行时经代理自动同步官方 `/zen/go/v1/usage` 实时额度，也可用 `npm run llm:accounts:quota -- sync` 立即同步与 `npm run llm:accounts` 查看状态）。
3. 确认真实博客仓库与目标页面没有人工修改冲突，检查其他生成、审查与发布进程，三流程错峰运行。
4. 所有脚本、检查和测试在沙箱外执行，不绕过环境、角色或来源检查，不把 `data/`、日志、缓存、密钥纳入 Git。

Node CONNECT/TLS 使用与模型请求相同的有效时间计量，握手总预算仍为 60 秒。“系统睡眠/长时间挂起”也可能来自本地同步核验阻塞，须按[连接排障](docs/troubleshooting.md#2-主模型请求失败超时或空响应)区分原因；共性故障先停稳、修复并验证，再沿同一清单与原账续跑。

费用开始或终态记录无法保存时停止新请求，保留实际响应和原消费，不把保存失败当成传输重试。Node/Python 的开始、终态共用请求 ID，异常响应仅在故障时进入私有受保护目录；见[费用故障](docs/troubleshooting.md#费用记录保存失败)。

认证故障先停止生产新派发并保存结果；配置了多个账号时，在独立诊断中逐个使用真实模型、路由和代理做最小请求，按正常方式保存用量，找出实际可用账号后备份并修复主副配置。不要把单账号 401 推断成全部凭据失效，也不要未核对完整账号池就让用户更新密钥。此诊断已获持续付费授权；不改原冷却记录、不显示密钥或稳定凭据指纹，不改变同一论文逻辑请求遇普通 401 即停止的规则。HTTP 200 截断不等于完整内容通过，恢复前确认所选账号能返回完整响应。

## 1. 日更

```bash
npm run digest:prepare -- YYYY-MM-DD
# 日更默认不生图；旧 --no-visuals 参数仍兼容，无须每次添加
# digest:api 完全等价
```

仅北京时间当天允许从抓取开始。默认入口要求实际遇到各来源以前获取过的论文：保留已核验的原窗口，向前重叠覆盖旧编号及时间见证，完整处理每页与窗口后才进入模型流程。缺完整旧证明、时间漂移或未遇见证须停止，详见[抓取边界](docs/daily-fetch-boundary.md)。

上一已发布批次的原分析输入字节不可重放时，先保留失败。若更早的完整五文件及其真实发布页面仍可核验，可用 `npm run fetch:witness:prepare -- --date YYYY-MM-DD --source-date YYYY-MM-DD` 显式登记恢复，再将输出的绝对清单路径传给同日日更的 `--fetch-witness-recovery-manifest`。

该路径扩大来源重叠范围，最新已发布与去重基线不变；旧漂移稿不取得原稿资格，来源、次数及费用不重置。恢复与后续从原文件重新核验必须重放封存材料，详见[显式旧检查点恢复](docs/daily-fetch-boundary.md#published-input-drift-recovery)。

用户于 2026-11-02 持续要求以后日更不再生图。入口执行候选抓取、关键词预筛、LLM 筛选、当次官方 HTML/PDF 封存、分析、Reader、评分、标签、生成、审查与推送；真实发布后自动登记本次不生图，最后继续完成部署和网页验收。论文原图仍正常核验、展示和审查。

当次封存位于 `data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/`；分析只读其中 TXT、PDF、元数据和清单。图片仅在当前调用的系统临时目录准备。来源缺失或 SHA 不符须在模型请求前停止。

```bash
npm run deep -- --date YYYY-MM-DD
npm run batch
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader
./run-daily-digest.sh YYYY-MM-DD --from generate
./run-daily-digest.sh YYYY-MM-DD --from review
./run-daily-digest.sh YYYY-MM-DD --from push
```

日更恢复命令不重新抓取历史日期，也不补建来源或读取旧缓存。日更分析和 Reader 刷新按后文的[批次恢复顺序](#批次与失败恢复顺序)执行。Reader 刷新未传 `--concurrency` 时使用配置并发，默认 5，显式范围 1–60；总轮数默认 3，可用 `--rounds N` 覆写为 1–10。Reader 只续明确可重试项，来源计划、运行级或存储故障停止新派发。

显式追加有限付费重试须使用绑定当前来源、失败草稿与额度的清单，见[恢复预算](docs/reader-explicit-retry.md)。人工修正只能使用已授权、来源绑定的受控恢复入口；不得把失败伪装成成功、清零费用或重试次数。

已签名日更稿的显式 `--reader-signed-corrections` 沿用原退休付费稿、完整父稿 CAS 和正常最终校验：术语修正只替换明确指定的中文术语。事实修正保存完整父稿，限定既有节点内受拒原句的逐字范围，并重放全部真实人工历史，不增加请求。表绑定修正另须完整原 DOM 表证明，详见[签名稿修正](docs/reader-explicit-retry.md#已签稿的事实修正)。

`reanalyze` 是显式强制全量重分析，会保留归档并停用旧候选；本次每篇只在首次准备时执行获准的重置，后续失败轮继续原候选和预算，选定重分析同样不按轮重复重置。普通恢复优先同入口和原稿。

## 2. 官方会议

```text
conference:acquire → conference:discover → 全文证据与每会筛选
  → conference:process → conference:publish:generate
  → conference:publish:review → conference:publish:push
  → conference:publish:verify
```

参数、官方来源、账本、导入、并发和恢复见[会议流程](docs/conference-workflow.md)。新会议统一从 `conference:process` 分析，内部调用公共 `analysis-engine.js`；页面维护使用下述 `conference:migrate-process`。

### 调度、迁移与常见恢复入口

会议处理和迁移按以下核心门禁执行；完整低层边界与证明格式统一维护在[会议流程](docs/conference-workflow.md)与[会议恢复与迁移执行细则](docs/conference-workflow.md#会议恢复与迁移执行细则从-agentsmd-归口)：

1. **外层并发与私有后处理池**：`conference:process` 外层并发默认 1、`conference:migrate-process` 默认 3，均可显式传 `--concurrency N`（1–60）；`--postprocess-concurrency 1–5` 单独控制硬禁模型的完成稿重暂存与完整汇总私有线程池，不改变 Reader 调度、阶段上限、次数或费用。单篇固定本地 PDF 提取器或会议页面渲染器的真实子进程超时先收集，首轮结束后仅对该组超时项各串行正常重试一次（不递归），见[本地超时单次恢复](docs/conference-workflow.md#固定本地程序超时后的单次恢复)。
2. **仅更新完整会议页面与后处理减权**：已有完整会议需更新页面时，先核全成员状态再显式迁移并重暂存单篇与汇总，复用合格分析与费用；已有 `publish.json` 的旧 process 不重复 generate，既有 URL 改走历史维护，见[只更新会议页面](docs/conference-workflow.md#已有完整会议只更新页面)。需先统一检查且硬禁模型时加 `--postprocess-only`（准备人工收尾前保留失败稿另加 `--preserve-failed-readers`，不得与重试或清单混用）；调度前先在锁内零请求采纳已保存完成子稿或复验活跃付费候选，不重复购买合格稿。
3. **失败集合续跑与追加付费窗口**：全体后处理并报告完整失败集合后，显式加 `--retry-failed` 续跑；原窗口耗尽后，按[持续授权](AGENTS.md#持续授权以效率和效果为准)显式登记并执行后续独立窗口（`--retry-failed --recovery-manifest ABSOLUTE_PATH`，使用 `conference-recovery-grant` 及其结构指纹，旧版清单格式兼容读取不变）。每窗最多 3 轮、Reader 累计 6 次内容响应及 2 次完整长文，新旧窗口分账、原稿与费用保留；从第二轮起持久保存已失败非 Reader 阶段的请求禁令，详见[原额度耗尽后的独立付费恢复](docs/conference-workflow.md#原额度耗尽后的独立付费恢复)。
4. **零请求修正与认证来源纠正**：原许可全轮后少量完整失败集仍有真实活跃候选时，使用同迁移入口的 `--reader-corrections`（每篇 1–8 个已有节点、硬禁模型与网络、绑定原 CAS 与完整资格），见[零请求 Reader 修正](docs/conference-workflow.md#最后失败集合的零请求-reader-修正)。认证 PDF 的资源归属或唯一核心句确需零请求纠正时，使用 `--postprocess-only --source-corrections ABSOLUTE_PATH`（资源权限与核心权限分离），见[认证来源纠正](docs/conference-workflow.md#认证来源事实的零请求纠正)。
5. **博客拒稿后的正常 Reader 维护与独立 PDF 出版视图**：会议发布审查出现普通内容拒稿时先等全批结束（会议审查默认 5 并发、支持 1–32，先全批单篇后汇总以复用零告警已审图，单页分块串行），再将正文及未解决格式问题的完整失败集合交正常 Reader 维护（`pending` 期间不得另跑普通迁移漂移基线）：

```bash
npm run conference:migrate-process -- --apply --catalog CATALOG.json --report REPORT.json --filter FILTER_UUID --from PROCESS_UUID --concurrency 5 --reader-review-feedback /absolute/process/review-reader-maintenance/BATCH_UUID/manifest.json
# 原独立维护窗口确已停止后，绑定完整实际失败集合追加下一窗：
npm run conference:migrate-process -- --apply --catalog CATALOG.json --report REPORT.json --filter FILTER_UUID --from PROCESS_UUID --concurrency 5 --reader-review-feedback /absolute/process/review-reader-maintenance/BATCH_UUID/manifest.json --reader-review-window /absolute/process/review-reader-maintenance/BATCH_UUID/windows/WINDOW_UUID/manifest.json
```

示例清单路径取自本次任务核验并安装的材料，每窗最多 3 轮、6 次内容响应及 2 次全文，保留原主文、核心摘要、评分、标签与费用，完成后统一重暂存全会单篇与汇总再 `generate → review → push → verify`，详见[博客拒稿后的正常 Reader 维护](docs/conference-workflow.md#博客拒稿后的正常-reader-维护)。图片拒稿可先绑定同篇认证 PDF 完整页展示并正常重审，残余图文语义再进入 Reader 维护，见[认证 PDF 的独立出版视图](docs/conference-workflow.md#认证-pdf-的独立出版视图)；复杂来源批核超时与预算边界见[本地页面排障](docs/troubleshooting.md#本地页面冷核超时)。论文必须具备真实会议身份、官方 PDF 与来源 SHA，只有 PDF 时不推断 HTML DOM 能力，也不为会议补造 arXiv ID。

## 3. 历史博客更新

```text
history:inventory / conference-local-sources → history:inputs
  → conference-projections → history:plan → history:sources
  → history:metadata → history:run → history:aggregate
  → history:publication: plan → generate → review → publish → status
```

完整参数见 [历史重写](docs/history-rewrite.md)与[独立历史发布](docs/history-direct-publication.md)。历史按冻结页面范围去重，同篇只分析一次；每轮arXiv重新获取官方TXT/PDF/运行元数据/清单，保留的会议元数据和PDF必须SHA核验。旧分析、旧博客、旧图片不进入写作输入。

独立发布要求完整来源/页面覆盖、当前Git基线、审查与精确差异证明。`publish --apply` 统一在共享博客锁内激活、提交、推送和OID验证。禁止用旧 `activate --apply` 绕过凭证。

暂停后 `history:resume -- --plan ...` 继续当前直接计划；旧已存在来源任务通过 `history:resume -- status|analyze --run-id ...` 恢复，不能新建旧任务、重新获取来源或重置预算。旧状态适配仅为已有断点核验，不是另一条生产链。

ICML/OpenReview替代PDF默认拒绝；唯一用户授权例外 `conference:icml:2026:openreview-forum-id:n1mAjfRDZ6` 仍核验固定SSRN标题、作者、DOI、获取凭证与PDF SHA，必须说明非camera-ready；不可推广。

## 批次与失败恢复顺序

先让本次选定论文全部按正常流程处理，等整轮结果保存后，再只处理仍可重试的失败集合；默认最多 3 轮。通过当前资格核验的成功项保留，原来源、阶段检查点、Reader 草稿与费用沿用。并发和批次轮数不增加单阶段或 Reader 的原预算；运行级故障和温和停止都会阻止新轮。

共性校验误报应在整轮结束、生产进程停止后统一修复。验证同时使用原付费失败稿、封存来源及正反回归；构造例须与真实原稿区分。修复后仍交回正常完整检查，额度用尽的稿件沿用受控恢复协议，不因改代码获得新次数。

正常候选完整重验后出现新的阻断问题，可在严格核对原问题双签名、旧组不再出现且原内容响应额度仍有余额时继续原余额。完整长文已用完 2 次时，仅全部新问题有明确路径、由 1–8 个旧 SHA 绑定的既有节点完整覆盖且无需来源整稿重试的安全局部补丁可继续；空目标、重叠、整组操作和任何全文回退仍阻断。历史次数和连续失败记录不清零，同组缺项或阈值变化不算新组；归一化、传输、来源及已耗尽预算仍阻断，见[原余额恢复](docs/reader-explicit-retry.md#正常候选中的原余额)。

PDF 表格的来源适配不改变这项原则。正常生成、候选恢复和发布从原文件重新核验须使用同一认证 PDF 取证能力；只有原表表头或明确表注与目标行列唯一对应时才支持单位。原表缺少单位、重复列无法定位或跨表借证仍须失败，不能因补证适配而放宽。历史来源保持真实直改身份，旧完整会议的出版补证仍不能给未完成分析授予资格。

原表同名方法若以明确的 `Dim` 输入维度列区分，展示须保留全部原数值列并核对完整条件身份。平表中的维度、容量或微调行带由真实 PDF 几何、完整字形及分隔线重放；条件路径与原行名一并保留，不用结果值选行。共用资源校验逐项区分复现前待验证的条件、明确缺少公开证据、经核验的第三方链接与作者资源发布；局部否定或第三方归属不能替相邻的作者公开声明作证。

表格已有的逐字引文完整通过数字、单位与原 PDF 行列核验时，正常自动补证保留这些引文，不再加入数字相同的其他表片段。只有证据不完整时才派生补证；这项修复不增加候选额度，旧稿仍须正常完整重验。

来源绑定的定向事实反馈先在论文锁内核验并保存原包和未完成义务，再发模型请求。保留旧成功正文不表示新纠错已经完成；最新失败或未完成义务必须阻断完成与发布。只有真实正常恢复、付费响应重验或受控修正通过当前反馈和全部资格后才清除，状态查询和合并不能自行抹掉失败；保存故障按整次运行故障停止新请求。

多轮后只剩少量顽固项，才进行受控人工修正：核对真实来源、原失败稿、具体反馈和修改范围，再交回正常校验及博客审查。`manualHandoff` 只报告建议，不改状态或授予新请求额度。共享参数与三流程边界见 [批次规则](docs/three-workflows.md#全批轮次与失败集合)，有界付费追加见 [Reader 恢复](docs/reader-explicit-retry.md)。

会议人工清单默认核对原窗口全部正常轮次；显式历史技术停止声明另核当前与直接前驱至少2次真实同源执行的内容响应、失败与材料树，不把单次多响应当作多轮。原完整付费JSON的版本4→3投影及原2个已绑定TABLE占位的0→2恢复，均须独立声明并保留原候选，合计最多8个已有节点；随后正常核验整稿及所有来源，不自动扩展日更或历史人工范围。详细字段与执行时与重读原文件时的回执见[会议人工收尾](docs/conference-workflow.md#最后失败集合的零请求-reader-修正)。

### 日更耗时控制与尾部收尾

按以下顺序处理尾部失败，集中核对完整集合并复用已经合格的结果。性能观测的方法和适用范围见[性能说明](docs/daily-performance.md)。

1. 生产期间冻结共享实现；一次正常轮次结束后收集完整当前失败集合。把内容错误、来源/格式问题、系统校验误报、身份/父稿问题和服务故障分清，再选择已有恢复入口。系统规则不能由当前正文补丁改变时，不为同一误报反复追加模型请求。
2. 恢复方案同时核对当前原稿 CAS、全部阻断问题、来源、原父稿包及尚未完成的义务、候选选择和原预算；身份核验与原记录重放工具只证明其声明的身份，不能当作实际下一请求的完整预检。正常执行的 `[reader-next-request-plan]` 报告实际选择的全文重写（full）或局部补丁（patch）、问题集合指纹和剩余次数，但明确不是最终资格或请求许可，后续全部守卫继续生效。获准范围仅有局部响应时可在同一正常操作外使用 `withReaderLocalRequestsOnly` 减权，不能因预览预期为局部补丁（patch）就允许实际全文重写（full）。
3. 人工清单一次覆盖当前失败集合，逐篇说明具体原节点和来源。名额按原封存入选集篇数 `N` 计算为 `min(15, max(10, floor(N/10)))`：`N<110` 时固定 10 篇，`N≥110` 才随批次增大，硬限 15 篇；用户明确授权的批次可用 `PD_DAILY_CORRECTION_LIMIT`（1–15）把名额抬高，该变量只允许抬高、不能降低默认值。任务内新增付费已获持续授权，必要的新轮、清单或后续窗口由执行者准备并执行，不重复索取确认。保留新旧范围、来源与费用记录；用户明确改变目标或撤销授权时才按新指示调整，不把同一次收尾切成连续确认。
4. 进度更新读取实际阶段日志、请求记录和已保存检查点。`digest:status` 是从原文件开始的完整核验，不能当作秒级进度轮询；在发布、视觉登记/豁免等最终状态变化后按要求重新运行。入口日志记录各大阶段开始、结束及失败耗时，模型累计时间与本地等待分开报告。
5. 共性代码修正先以真实保存稿重现，再跑必要正反回归；稳定后完成一次完整工程验收。代码分批中文提交并及时推送；纯 CI 可以取消已被后续提交取代的执行，最终版本全部分片仍须通过。站点同一组模板/工作流改动在完整验证后合并一次推送，避免不可取消的旧全站部署排在最终版本前面。
6. 常规测试使用系统临时目录和独立夹具，不依赖会换日的 `data/current`；真实付费稿性能/恢复回放放在显式输入、SHA 绑定的运行证据中，与可移植单测区分。提速实验不改正式数据、不重置费用，也不把局部微基准比例宣称为全日更降幅。

### 已完成主文的专项恢复

仅更新解读长文的纠错完成后，使用原父包与子包的实际签发上下文只读核验；此检查不能写包或发模型请求。旧父恢复先检查完整主分析，保存前阻断 Reader 之外的上游变化（图片下载阶段、图片清单与图片叙述合同属于同一次纠错的合法产物），错误则还原内存。不能为了恢复 Reader 删除或重签原摘要、评分和标签，详见[事实反馈恢复](docs/reader-explicit-retry.md#已完成主文的独立-reader-事实反馈)。

只修核心摘要时，使用 `reanalyzeSelected(ids, { coreFeedbackFiles })`：锁内先归档原反馈包，再独立进入核心单节范围。没有主文父反馈时，不能把核心包当成自己的父包；普通续跑仍恢复原单节范围，禁止主文模型。核心阶段逐字保护其余十二节，随后正常复核八维评分及必要 Reader，保留全部旧历史、次数和费用。成功稿已清理临时检查点时，先只读核验原完整父稿与真实来源，仅在核心恢复中保留原已完成上游；不把最终正文冒充各阶段的历史中间稿。

<a id="共享内容与prompt"></a>

## 共享内容与 Prompt

三条流程共用 `analysis-engine.js`、`deep-analyzer.js`、当前Prompt登记、Reader/评分/标签与来源守卫。正式分析13个一级标题用于机器解析，其中 `核心摘要` 现行规范（`executive-abstract`）为 `700–1,400` 汉字（目标 `850–1,150` 汉字、`10–26` 句）的 3–4 段全景导读摘要；Reader使用 `beginner-researcher`（现行契约 `structured-pipeline`）与 `api-reader-source-bindings`，新稿要求 5–9 节（推荐 5–7 个职责清晰、直接面向论文具体问题或机制的模块小节，不再使用“功能锚点 + 冒号”套话前缀）、5000–18000 中文字（散文汉字建议不少于 4500，不阻断）、0–4 个可选术语桥（`conceptBridges`，优先在正文首次交汇处自然解释）、结构化实现规格（`implementationSpecs`）及按语义位置与自然 4 段式衔接嵌入的论文原图（不再强制注入机械 `> **看图路径：**` 引用框）。评分现行规则为 `type-aware`（全维度统一 0–10 分制，7 项核心加权与有界开源加分求和封顶 10）。历史已存记录在冷核验时继续按原登记 `schemaFingerprint`（如旧版单段核心摘要、`executive-abstract-v4`、`structured-pipeline-v5`、`cohesive-functional-v4`、Reader 8–18 节 / 12–18 节、4–10 组术语解释、看图路径框及 `type-aware-v2`/`type-aware-v1` 评分）兼容核验。

标签从新版目录的400项九维词表选择。总目录保留完整；每篇只展示所选项及父级导航，不加入兄弟方向或空分面，祖先不写入直接标签。三种页面生成器使用同一多级展示函数，旧分类仅按真实归档原SHA重放。会议与历史发布先核验站点成对版本目录及本次快照，首次同步和旧记录兼容见[标签规则](docs/tag-display-policy.md#三条流程共用的目录与呈现)。

验收同时核对源Markdown保留的共享多级分类块和网页呈现：已核验的单篇页头分类只显示一次，正文去重须有唯一完整有序边界，汇总仍逐篇展示，旧无标记或异常标记不能用来手删Reader正文，详见[页面切换规则](docs/tag-display-policy.md#已发布页面切换到当前呈现)。

表格单元格对应原DOM或完整数字/单位引文，公式由结构化原TeX写入；作者机构逐项绑定来源，资源宣称与当前可达状态/类型一致。八维评分按文档类型判断，同一缺陷不重复扣分，总分代码重算封顶10。当前标签必须中文首选且含明确主任务/主方法，既定英文专名须有中文别名。

表格按真实来源保留条件、方法、指标与单位，原表只有3或4列时不凑5列。禁止从任意引文抽数字合成“来源句／量化值一”结果表，参考文献编号、年份、页码不能充作实验结果，少量数字重叠不能决定原表身份。缺真实表交正常 Reader 修复；已存稿经当前完整校验报告实际失败集合后统一恢复，保留合格上游和原费用。

这条语义检查同时适用于新响应和保存稿。日更、会议与历史共用保存稿资格检查，旧正文、计划与阶段 SHA 一致也不能绕过；命中的 `reader_placeholder_result_table` 应作为当前失败保存，再集中正常恢复。来源身份重放不代替正文资格，也不应提前触发正文失败而中断全批检查。

日更内嵌SVG的绘图定义缺失、成环，或封存几何证明不透明黑底与默认 HTML 黑字同色不可读时，发布器只可按同篇四份封存来源、唯一图号与完整图注，从原PDF派生完整原页并明确标示页码。独立派生证明进入生成清单及审查、推送重验；保留原Reader和原模型像素身份，新像素仍须正常图片审查，不猜补SVG或裁图边界。旧清单仅按原来源与原像素身份只读兼容，不能用缺少新字段为新的替代资产签发凭证。

当前Prompt路径以 `scripts/lib/prompt-contracts.js` 为准，读取第一个围栏代码块。旧提示词正文不再保存在工作树；`scripts/lib/git-prompt-evidence-index.json` 只登记原路径、Git blob OID 和整文件 SHA。

旧记录通过受控读取器从 Git 取回原字节，复核整文件及首围栏模板 SHA，并保留原声明、来源、检查点和付费记录；缺失或不符就停止，不能用当前正文补签旧结果。新请求只读取当前登记的 Prompt。新共享代码变化进入传递依赖指纹，不靠手工漏项清单。

## 审查、发布与完成

日更发布顺序：

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

审查只读最终文件，逐页通过记录按路径和内容SHA复用；当前批次仍执行程序与Hugo检查并生成新凭证。发布器变化后重新生成，但不强制重审字节未变的通过页。已完成的内容失败页仅在保存的旧协议与当前协议均为合法SHA且确实不同时，才进入正常整页重审；原失败、响应与费用保留，缺失或非法协议不能授权重审。单图审查不能根据局部输入推断整篇缺图，须核对图例、分组及计数与比例，并保留发现原文与图自身矛盾的能力。

会议后续完整审查可含真实旧协议通过页；按 canonical 路径/页 SHA 缓存及 result 自哈希复用，不把通过项改签成当前协议，失败项仍绑定当前协议。审查Git基线、远端身份、来源、页面清单或凭证不符必须阻断。

已授权的独立人工审查只为文章记录真实语义及逐图结论；引用资料、词表和受控论文图以 `machineAssets` 沿用正常来源、字节及已审引用页核验，完整并集仍必须等于生成清单。不得把二进制资产当 Markdown 或伪造其人工审查身份，具体声明和站内原图边界见[独立审查](manual/README.md)。

相邻原图共用解释/导读段时，单图审查输入须标明这段的双重归属，并保留完整原文及本图真实冲突的检查；独立上下文不变，不为审查误报改正确科学结论。

审查输入中的图片 K 是本次位置，论文图 N 是已核验封存 DOM 条目，Figure M 是作者印刷编号；三者可以不同，N 也可以不连续。共享说明只适用于当前签名与原来源映射均通过的文章，不能豁免实际配图或科学事实错误。新独立人工审查实际配置 `gpt-6.1-sol/high` 并按现行格式如实登记逐页审查身份；旧模型记录只读，详见[独立审查](manual/README.md)。

用户要求已发布完整日批只更新呈现时，生成命令显式增加 `--republish UUID`：`npm run blog:generate -- --date YYYY-MM-DD --republish UUID`，随后正常审查和推送。只允许当前正式完整日批；原发布及同来源/分析核验通过后，旧证据按UUID不可变备份，原通过缓存和检查点保留，不重跑付费分析。

事务未完成时用同日期同UUID恢复，不能删旧凭证、混用all/选定子集/自定义数据，或冒用fresh提升；新提交仍需部署、逐页核验及当前发布视觉豁免，详见[重发布协议](docs/data-format.md#同来源同分析的日批重发布)。

普通内容拒稿先保存审计并继续本批其余页面，最后汇总阻断；服务、存储、字节变化或凭证损坏停止新派发并等待在途结果。修正后再正常审查，失败项不能写通过凭证；分析轮次参数不授权同次审查反复请求拒稿页。

推送仅提交凭证允许的精确差异，并核对远端main OID。宣告完成前，还须确认对应提交或保留本批已审字节的后续提交已成功build/deploy，逐页HTTP200、正式URL与标题一致，并保存核验记录。

日更持续遵循用户“以后日更不再生图”的要求。入口在核对远端提交后，直接登记本次发布不生图，记录绑定生成清单、审查凭证的完整 SHA-256 及真实发布提交；不再创建长图或封面任务。旧 `--no-visuals` 参数仍兼容，无须添加。旧 `--from visual` 只执行收尾登记。

不生图不取消论文原图的获取、来源核验、展示和审查。旧成图仅保留只读核验，不能运行已经退役的写入流程。登记失败按[恢复说明](docs/troubleshooting.md#11-不生图登记失败)核对凭证后重试；不重发字节未变的博客。

```bash
npm run digest:status -- --date YYYY-MM-DD
npm run verify
```

完成判定按 [AGENTS.md 的六项完成定义](AGENTS.md#日更完成的六项)逐项核对：数据与来源、审查、远端发布、部署、网页核验、不生图登记与重读状态；上面几段只是执行顺序，不另立一套编号。状态报告不自动检查部署与网页，不能据其complete单独宣告上线。`verify` 的验证计划是固定Hugo（`--suite static` 与 `--quick` 跳过）、全仓语法、JavaScript测试、三组Python单测（`tests/python`、`manual/tests/python` 与顶层 `tests/reader_pdf_*_test.py`）、文档一致性检查（`docs-consistency.js`）和只读数据检查，不含客户端构建或测试；客户端版本一致性由 `npm run docs:check` 与 `tests/docs-consistency-real.test.js` 核对，Android 与 macOS 客户端测试分别由独立作业 `client-android`、`client-macos` 覆盖（均不进 `verify` 分片矩阵，也不并入 `test` 汇总检查）。只有CI/干净检出显式允许空数据。

用 `npm run verify:web -- --date YYYY-MM-DD --deploy OID` 将网页记录和正式发布提交绑定。需要等待时加 `--wait` 并按实际部署耗时设置等待上限。结束前确认部署任务通过、记录为完整验收、所有目标页面已检查，并按[维护指南](docs/maintenance.md#发布后网页核验与收尾)核对完整标题等网页要求。

整批Manual作者任务、旧拆分分析链和社交渠道发布已退役；单篇独立审查及旧记录来源/签名/正文核验留在 [兼容目录](manual/README.md)。
