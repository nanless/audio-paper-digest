# `scripts/` 运行时代码索引

返回[项目 README](../README.md) · 查看[完整文档导航](../docs/README.md) · 进入
[Manual 子系统](../manual/README.md)

这里保留默认 LLM/API 流程、共享发布与视觉模块，以及可选渠道入口。显式
Manual 子系统已经集中到 [`manual/`](../manual/README.md)，不要在本目录重新新增
`manual-*.js` 或 Manual 专属 prompt、文档与测试。

## 从哪里开始

- 完整日更由根目录 [`run-daily-digest.sh`](../run-daily-digest.sh) 编排；默认走
  LLM/API，使用 `npm run digest:prepare -- YYYY-MM-DD`。只有显式 `--manual` 或
  `digest:manual` 才进入 `manual/`。
- 全历史任务只在历史工作区运行。先准备来源、分析和私有页面，再使用独立的
  `history:direct-publication` 发布；命令存在不代表历史任务或发布已完成。
- `package.json` 是命令别名的权威清单。直接执行任意项目脚本仍必须遵守项目根
  `AGENTS.md` 的工作区角色、沙箱外运行、代理、凭据与发布要求。
- 本目录中的 `analysis-contract.js`、`validate-data-files.js` 和博客发布模块仍会读取
  `manual/`，用于复验已有 Manual 产物；这是共享兼容边界，不代表默认 API 会启动
  Manual 写作流程。

| 需求 | 推荐入口 |
|---|---|
| 跑完当天可脚本化阶段（博客发布 + 视觉输入准备） | `npm run digest:prepare -- YYYY-MM-DD` |
| 只续跑分析 | `npm run deep -- --date YYYY-MM-DD`，只读取当前批次绑定的封存来源 |
| 校验运行数据 | `npm run validate:data` |
| 完整离线验证代码、数据与 Hugo | `npm run verify`；CI/干净空 checkout 显式加 `-- --allow-empty` |
| 查整轮最终状态 | `npm run digest:status -- --date YYYY-MM-DD` |
| 查某个文件职责 | 继续阅读下方分类索引 |

单阶段命令适用于开发或明确的恢复任务，不能代替完整日更。最终完成还须人工核验部署与网页，并完成
或明确豁免发布后视觉；`digest:status` 尚未自动核验部署和网页。特殊重发步骤见本页末尾的
[同日全量重写后的重发](#同日全量重写后的重发)。

索引中的文件名、字段和协议名保持代码原形。SHA 用于核验文件内容和对应关系；CAS 指写入前核对
当前内容仍与读取时一致；`O_EXCL` 表示拒绝覆盖已存在文件。它们不能代替论文内容审查。

## 默认 LLM/API：抓取、筛选与分析

会议恢复与发布维护：

- `conference-queue.js`、`lib/conference-queue.js`：显式计划驱动的持久化会议总队列，逐会议推进处理、发布和验收，提供只读计划与状态。
- `conference-workspace.js`：只读工作区诊断，区分 Git 未提交改动、进程存活与旧运行状态；配置诊断不输出密钥。
- `lib/conference-process-recovery.js`：恢复批次寻址、失败分类、冷却与重试资格；迁移不能让已有完成记录被普通入口绕过。
- `lib/conference-source-upgrade.js`：显式来源升级计划与授权执行，绑定原批次和新解析版本，保留旧来源与分析；不静默重跑受影响论文。
- `conference_publication_gate.py`：最终 HTML 与已部署 URL 的机械验收；不冒充语义审查或人工视觉确认。

| 文件 | 类型 | 职责 |
|---|---|---|
| `full-fetch.js` | Node 入口 | 编排默认数据流程：归档、抓取、筛选、去重、深度分析，并逐篇保存结果。 |
| `lib/daily-fresh-source-plan.js` | Node 库 | 日更筛选结束后，为每篇 arXiv 论文封存本次官方 TXT、PDF 和清单；分析只读取这组文件，图片仅为当前请求临时准备。 |
| `lib/fresh-arxiv-rewrite-source.js` | Node 库 | 为每轮 arXiv 来源获取原子保存官方文本、PDF、无像素的来源元数据和清单。只有当前稿 PDF 明确返回 404，才允许使用同一论文的官方 `vN` PDF；文本必须从该 PDF 提取，并按条件生成可自校验的 `sourceVersion`。普通来源文件保持原结构兼容。 |
| `lib/direct-rewrite-analysis-context.js` | Node 库 | 用 AsyncLocalStorage 隔离历史重写和日更的来源文件，阻止旧正文或缓存进入分析，限制 Reader 图片只能临时使用；论文历史版本的身份 SHA 随来源记录进入所有分析阶段。 |
| `fetch-papers.js` | Node 模块/入口 | arXiv 抓取、摘要补全、关键词预筛和逐篇 LLM 筛选。 |
| `fetch-huggingface-papers.js` | Node 模块/入口 | 通过最小环境中的 `curl` 抓取 HuggingFace Papers。 |
| `deep-analyzer.js` | Node 核心 | 获取单篇全文，执行多阶段分析、评分审计、API Reader 写作和图片规划。结构修复后，只用原文证据核验 `core-summary-detailed-v3`；按阶段依赖、SHA 和旧检查点决定恢复范围，减少不必要的整篇重做。 |
| `analysis-engine.js` | Node 共享 | 管理论文锁、重试、检查点、批量并发与结果合并，并判断每篇是否完成。 |
| `analysis-contract.js` | Node 共享 | 核验 API 分析结构、评分、方法和表格要求，并兼容读取历史 Manual 结果。 |
| `editorial-quality.js` | Node 共享 | 检查 API/Manual 读者正文的语言、事实表述、评分和可读性。 |
| `digest-status.js` | Node 共享 | `papers.json` 的分析状态、批次日期和恢复状态同步。 |
| `lib/fetch-scheduler.js` | Node 库 | 按主机串行调度抓取，记录冷却时间并识别失败类型。 |
| `lib/filter-input-contract.js` | Node 库 | 计算筛选决定所对应的最小输入 SHA。 |
| `lib/tag-catalog.js` | Node 库 | `loadTagCatalog` 加载共享标签词表，`validateTagCatalog` 检查字段与层级；另提供别名解析和上下级查询。Node/Python 解析器及发布检查均使用词表原始字节计算的 SHA。 |
| `lib/tag-rules.js` | Node 库 | `createTagRules` 创建标签解析与选择规则，`getDefaultTagRules` 复用默认规则，`buildTagPromptText` 默认生成新版模型标签提示，也可按明确旧版生成核验文本。默认选择协议为 `paper-tag-selection-v2`，旧阶段按保存的版本读取，详见本页的分类词表维护说明。 |
| `lib/page-tag-metadata.js` | Node 库 | 解析页面的 YAML 页首字段，识别新旧标签字段，拒绝混用与重复键；只检查实际顶层字段，不把描述或正文中的文字当作标签声明。 |
| `lib/tag-catalog-change.js` | Node 库 | 比较两份词表，给出 `none/additive/destructive` 分类和理由；按 SHA 读取旧快照，核验 `registryUpgradeFrom`。沿用与确认条件见本页的分类词表维护说明。 |
| `lib/tag-stage-record.js` | Node 库 | 只读识别新旧标签阶段格式，返回原阶段及实际字段名；拒绝双格式混用，不改写或补签旧记录。 |
| `lib/tag-record-update.js` | Node 库 | 更新或核验分析中的标签阶段记录，所选概念 ID 必须仍与原记录一致；无法核验时拒绝并说明原因。另只读盘点旧分类文件，不调用模型。 |
| `lib/historical-tag-assignment.js` | Node 库 | 根据已完成且来源核验通过的历史分析结果解析标签，映射 concept ID、去除祖先标签并生成逐篇分类文件。文件名同时包含词表 SHA 与分类 SHA，分析升级不覆盖旧记录；旧版仅按词表 SHA 命名的文件，只有逐字段等于当前重建结果时才允许读取。 |
| `lib/historical-page-staging.js` | Node 库 | 按已核验的页面对应表（crosswalk）保留单篇路径，用完成的分析和当前标签记录生成私有页面。同一论文的多个历史页面共用分析结果；生成清单保存逐页 SHA，并核对恢复所用输入与生成器实现。 |
| `lib/historical-daily-aggregate.js` | Node 库 | 核对单篇私有页面、页面对应表、历史页面清单及当前分析和标签记录，按固定顺序生成每日汇总及清单。保留原汇总路径和网址，不读取旧汇总正文。 |
| `lib/historical-postprocess-scheduler.js` | Node 库 | 处理来源核验通过且已完成的旧历史分析队列，依次重新分类、生成单篇页面和完整日期汇总。检查点核验当前分析文件与分类 SHA；每次汇总读取同日全部当前成员，论文升级后其全部日期页面都须更新。最多并发 3，不写博客。 |
| `lib/conference-postprocess.js` | Node 库 | 只接受已认证的会议计划，逐篇核验计划、来源、完成结果、当前分类和页面渲染。单篇目录包含词表与渲染实现指纹，代码升级不覆盖旧页面；只有执行记录精确覆盖完整入选集时才生成私有会议汇总。 |
| `lib/historical-publication.js` | Node 库 | 核验旧路线的论文页与日汇总来源链，固定干净 main、远端、Hugo、Git 基线和阶段依赖，再生成不可变私有文件；此入口不写博客、不审查，也不提交或推送。 |
| `lib/keyword-prefilter.js` | Node 库 | 版本化高召回音频关键词预筛。 |
| `lib/reader-repair.js` | Node 库 | 保存失败 Reader 草稿，核验节点 SHA，应用有界局部补丁并检测无进展。表数量诊断使用结构字段选择修复，草稿不能作为允许发布的证明。 |
| `lib/reader-operator-patch.js` | Node 库 | 显式应用同一全新重写 run 的人工局部补丁，核验来源、节点 SHA 和完整 Reader 解析结果。只保存失败候选，保留预算、原始字节归档与重复执行记录，不生成成功正文证明。 |
| `lib/reader-signed-draft.js` | Node 库 | 将本次同源、已核验的 Reader 还原为严格等价输入。只有真实解析和原图注入后，正文、计划、图片 SHA 全部相同才返回；不写文件、不调用模型，也不把恢复稿当成原始 API JSON。 |
| `lib/reader-signed-operator.js` | Node 库 | 显式修订同一 run 的已核验 Reader，检查完整父稿 CAS，再还原、解析并按共同流程封存结果；通过不可变意图记录恢复输出。只写隔离分析并要求事实复核，不调用 API。 |
| `lib/reader-resource-binding.js` | Node 库 | 提取并规范化论文中的 GitHub、GitLab、Hugging Face 和 ModelScope 链接，保留原始 URL、逐字原文片段及资源类型，使换行 URL 也能准确核验来源。 |
| `lib/reader-resource-sync.js` | Node 库 | 将封存资源状态同步到分析结果、解析结果和末端检查点及证明，保留评分和 Reader 字节。评分所依赖的可用性证据变化时拒绝同步，要求正常评分审计；不联网、不写文件。 |
| `lib/reader-draft-order.js` | Node 库 | 调整同一草稿的小节顺序，同步表格绑定和标记，保存原始路径与调整后路径的 SHA 对应关系；无法唯一确定顺序时拒绝调整。 |
| `lib/reader-source-diagnostics.js` | Node 库 | 把数字或单位来源不匹配的问题定位到正文单元格与原表行列，给出百分号、千分位及可能舍入的只读修复建议；不自动改数字或放宽来源检查。 |
| `lib/reader-recovery-revision.js` | Node 库 | 显式迁移同源失败候选的诊断，保留付费请求计数、索引调整与旧无进展状态，归档原字节；表数量文案不能触发正文规范化。迁移不生成成功证明。 |
| `lib/reader-contract.js` | Node 库 | 集中规定读者文章的格式要求，按本次证据向模型说明写作要求，并检查不同小节的内容是否近似重复。 |
| `lib/reader-tables.js` | Node 库 | 将 TABLE 标记与原表行列选择展开为 Markdown 和逐格来源记录，保留表头对应关系，拒绝错位和越界。 |
| `lib/llm-usage.js` | Node 库 | 规范化真实请求用量，按论文和阶段归因；服务未提供的计费用量保持不可得。 |
| `lib/fresh-rewrite-run.js` | Node 库 | 从白名单中的原始元数据创建独立重写 run，准备同源文件，只恢复本 run 的分析，并在完整结果验证通过后更新正式数据。 |
| `workspace-role.js` | 入口与共享运行检查 | 用不跟踪入 Git、权限为 `0600` 且绑定仓库真实路径的标记区分 `daily` 与 `history`。`set` 原子保存或显式切换角色，`exec` 在 npm 生产入口启动前检查角色；直接 Node/Python 入口再由公共运行检查核验。 |
| `lib/fresh-analysis-context.js` | Node 库 | 隔离全新重写 run 的来源文件与深度分析上下文，重新核验来源 SHA；拒绝旧生成正文和其他 run 的检查点。 |
| `lib/fresh-rewrite-publication.js` | Node 库 | 重写前备份当前正式分析结果和博客基线；新结果完整且来源、基线 CAS 均通过后，才替换正式分析结果。 |
| `lib/conference-source-ledger.js` | Node 库 | 管理会议来源身份、四类文件 SHA 和审查证据；文件不可变保存，读取时重新核验本地来源。标题不能作为论文身份。 |
| `lib/conference-pdf-source.js` | Node 库 | 核验受控本机 PDF 的字节、路径和链接，生成可重新核验的来源描述；没有可靠结构化 TeX 时明确标记公式不可用。 |
| `lib/pdf-layout.js` / `pdf-layout-extract.py` | Node/Python 库 | 提供所有纯 PDF 来源共用的 PyMuPDF 提取与临时 PNG 渲染：按页记录正文、图片、表格、公式及论文图候选，供视觉审计使用。PDF 内嵌图片不自动等于论文图；会议 Reader 按证据最多临时取 6 页。保存的记录不含像素，无原始 TeX 时不生成可发布公式。 |
| `lib/conference-run.js` | Node 库 | 固定会议成员、分片、分类策略、选择策略版本和逐篇状态。通用状态接口拒绝直接写 `completed`；聚合发布接口仍要求尚未实现的认证完成证明，不能据此宣告会议可发布。 |
| `lib/conference-plan.js` | Node 库 | 只从已认证的导入记录、已审计划和当前词表生成 run 与计划凭证，核验相互对应的输入；拒绝任意路径、别名和不完整成员集。 |
| `lib/conference-importer.js` | Node 库 | 根据已认证的暂存记录，把会议元数据、PDF 和提取结果安全导入私有缓存，再保存来源清单和导入凭证；低层清单辅助函数仅供隔离测试。 |
| `lib/conference-execution.js` | Node 库 | 只从认证计划创建独立执行目录并保存不可变授权凭证。每次读取或推进都核验计划，以锁、CAS 和受控补丁保存结果；通用接口仍拒绝直接写入完成状态。 |
| `lib/conference-analysis-context.js` | Node 库 | 把已认证执行记录中一篇论文的来源放入仅在当前进程可用的分析上下文，固定 Reader 尝试目录；拒绝 arXiv 身份、其他执行目录和伪造的来源能力。 |
| `lib/conference-analysis-adapter.js` | Node 库 | 重新核验完整会议计划与来源后调用公共深度分析引擎。准备阶段先保存不可变意图，再用原子文件和精确前缀恢复分析结果、检查点与完成凭证。旧执行记录缺少意图记录时不自动迁移，须用同一认证计划新建执行记录和 UUID。 |
| `lib/conference-discovery.js` | Node 库 | 只读扫描 ICASSP/ICLR/ICML 或严格 `official-proceedings` 元数据快照和本机 PDF 目录，生成候选与匹配报告。新会议只按元数据稳定 official ID/`pdfFile` 匹配，标题不能作为身份。 |
| `analysis-waiver.js` | Node 库 | 核验用户针对当前日更批次的分析豁免，检查 deep、filtered、papers 三份文件的精确字节和逐篇来源 SHA；不修改分析正文。 |
| `recover-conference-process-locks.js` | CLI | 只在操作者确认本工作区且锁的 owner PID 已死亡时，按文件锁协议恢复旧 operation lock；活锁和不完整锁均跳过。 |
| `lib/conference-filter-evidence.js` | Node 库 | 从认证候选记录批量核验官方精确 PDF，由固定 PyMuPDF 提取页文本、视觉审计和原文摘要定位证据。保存可恢复的证据 run、候选及报告；非 ready 项不能直接排除，须交给 LLM。 |
| `lib/official-conference-acquisition.js` | Node 库 | 按固定 2026 官方 index/record/PDF 白名单抓取会议元数据与 PDF，`PROVIDERS` 是来源清单的唯一依据。AAAI volume 40 用固定 48-issue 清单，核验逐 issue 响应凭证、SHA 和跨 issue article ID 唯一性；其他来源用单索引。索引和逐篇下载以 `0600`、`O_EXCL` 保存，恢复时完整核验。 |
| `lib/official-conference-general-providers.js` | Node 库 | 解析通用 AI/ML/CV/NLP 官方单篇记录并核验身份；无网络、无写入，供来源适配和测试样例审查。 |
| `lib/conference-source-context.js` | Node 库 | 生产入口只能从已认证、不可伪造的计划句柄核验完整上游证明并读取会议全文；不导出 ledger/run 测试捷径。 |
| `lib/conference-filter.js` | Node 库 | 固定候选、认证证据文件、逐篇凭证、日更提示词、关键词策略、会议领域标签和模型/endpoint/词表指纹。ready 摘要进入关键词及提示词筛选，non-ready 项交给模型；按持久意图、请求凭证、决定与 CAS 保存结果。生产凭证只能由固定公共 LLM 路由生成，不接受请求实现注入；通过安全旧锁恢复避免重复执行。 |
| `lib/conference-process.js` | Node 库 | 编排新会议完整入选集的官方 PDF 封存、导入、公共深度分析、Reader、评分、当前分类页面和汇总。整批默认并发 1，可设为 1–5；每篇内部分析并发固定为 1。稳定 UUID、逐篇检查点和完成凭证用于恢复并核验整批结果。 |
| `migrate-conference-process.js` | CLI | 显式更新会议处理实现指纹，重新核验已完成页面或复用页面证明，归档旧完成凭证，再续跑未完成论文。 |
| `migrate-conference-images.js` | CLI | 将已发布 AISTATS/UAI 页面的本地 Figure 复制到专用图片仓库并更新链接；拒绝覆盖不同图片字节，不自动提交或推送。 |
| `publish-conference.py` | CLI | 按会议处理凭证执行 generate/review/push/status/verify。generate 只安装文件；push 核验实际 Git index 和 commit blob，先发布图床再发布博客；verify 检查线上 URL。机械检查不能代替语义审查或浏览器视觉确认。 |
| `waive-analysis-failures.js` | CLI | 记录用户明确同意跳过的当前日更分析失败项，保存对应现有文件的豁免记录；不覆盖失败尝试。 |
| `lib/conference-extraction-receipt.js` | Node 库 | 核验请求、来源和提取文件；每次加载时由固定 Python/PyMuPDF 临时重新提取并比较结果。视觉审计含逐页 PNG、内嵌图片、表格、Figure、公式候选和 SHA；无原始 TeX 时禁止绑定公式文本。 |
| `lib/conference-staging.js` | Node 库 | 将认证的会议入选集与人工复核的提取结果一一核验，生成导入清单和凭证；排除项或身份别名不能进入。 |
| `lib/paper-identity.js` | Node 库 | 实现 Node `paper-identity-v1` 身份规范化、官方来源 URL 检查和稳定 SHA；不替换既有 arXiv 辅助函数。 |
| `lib/paper-source-authority.js` | Node 库 | 核验规范论文身份、完整身份记录、来源快照、凭证和全文 SHA，返回只含来源且不可伪造的句柄。普通磁盘 arXiv 加载器不能恢复发布授权；会议路径还要求当前进程真实计划句柄。 |
| `lib/arxiv-source-authority.js` | Node 库 | 使用默认强制代理抓取器获取官方 arXiv 全文，依次保存请求、观察结果、全文、快照、凭证和授权依据。支持 `O_EXCL` 恢复，拒绝旧博客正文。 |
| `lib/arxiv-metadata-source.js` | Node 库 | 通过项目 HTTP CONNECT 获取单篇 arXiv Atom 元数据，核验原始响应 SHA，并提取白名单中的标题、摘要、作者与类别。 |
| `lib/historical-arxiv-publication-metadata.js` | Node 库 | 为历史直接重写计划的每篇 arXiv 论文封存仅用于发布的 Atom 附件。读取时核验原始 Atom、元数据、摘要 SHA、精确 `vN` 查询或无版本 ID 的观察时间窗，以及原来源获取序号、清单与快照；不修改四份原来源文件。 |
| `lib/page-source-crosswalk.js` | Node 库 | 跨运行核验历史页面清单，在锁内以 CAS 和只追加决定记录 pageId、页面 SHA 与发布授权来源。同一身份的多页确定性分组；标题不能用于 verified 判定。finalize 和每次读取最终凭证时都重新验证来源。 |
| `lib/history-conflict-identity.js` | Node 库 | 保留旧版冲突解析功能；当前直接重写策略不把状态为 `conflict/multiple` 的页面送入正式 crosswalk。 |
| `lib/historical-arxiv-analysis.js` | Node 库 | 将现场核验的 arXiv 全文和官方 Atom 元数据用于可恢复的独立原文分析 run，不读取旧生成正文。 |
| `lib/historical-arxiv-analysis-scheduler.js` | Node 库 | 仅用于旧备用路线：从 crosswalk 中 verified 的唯一 arXiv 身份组生成稳定 run ID；不调度正常 direct-local 历史重写。 |
| `lib/historical-arxiv-batch.js` | Node 库 | 备用路线只读取命名、不可变的新 arXiv 获取失败交接文件。核验其中的历史清单、页面 SHA 和非标题链接后，仅对其列出页面执行 CAS；不扫描 pending hint。 |
| `lib/historical-archive-crawl-authority.js` | Node 库 | 用已有归档抓取记录的稳定 arXiv ID 和输入 SHA 提供身份依据，不提供正文、图片或旧分析。 |
| `lib/historical-local-crawl-authority.js` | Node 库 | 汇总归档与当前本地抓取记录中的稳定 arXiv 身份；不联网，不读取正文。 |
| `lib/historical-archive-crawl-batch.js` | Node 库 | 只读审查已有归档抓取记录。旧 crosswalk 写入功能已停用，调用时直接拒绝。 |
| `lib/historical-conference-crawl-authority.js` | Node 库 | 用已有会议元数据和 PDF 的稳定会议 ID 提供身份依据，支持重新核验 ICASSP、ICLR 本地来源。 |
| `lib/historical-conference-crawl-batch.js` | Node 库 | 保留旧版只读辅助功能，crosswalk 写入功能已停用。会议标题指纹只能用于直接重写的页面对应，不得写入 crosswalk。 |
| `lib/historical-conference-local-sources.js` | Node 库 | 生成 `historical-conference-local-sources-v2`。除既有会议元数据和 PDF 外，还按认证 ICML poster→OpenReview forum ID 合并 ICML 来源；只读已有目录及运行目录中的新文件，新 PDF 必须对应唯一 OpenReview/替代来源凭证。逐项记录元数据、论文记录、PDF 获取与来源 SHA；缺 PDF 时明确标为 unavailable。 |
| `lib/historical-conference-page-projections.js` | Node 库 | 读取历史清单、页面标题和已保留的会议来源，核对文件 SHA 后确定论文对应哪些页面。页面文件参与校验，旧正文不作为重写输入。 |
| `lib/historical-direct-rewrite-input-catalog.js` | Node 库 | 结合历史清单中的唯一 arXiv 提示、严格主评分行身份、ICML poster 与可路由身份、会议本地来源清单，生成 `merged-good-historical-local-data-v5`。身份记录仅保存字节区间和哈希，不把旧正文送入写作。 |
| `lib/historical-daily-primary-arxiv-binding.js` | Node 库 | 核验冻结 Daily 页的 SHA，仅接受唯一合法评分元数据行中的规范 `[arxiv]` 主身份；保存对应字节区间和行哈希，拒绝把正文引用链接当成论文主身份。 |
| `lib/historical-icml-poster-authority.js` | Node 库 | 认证 ICML 2026 原始 poster→OpenReview forum 快照，核验 Daily 子条目与汇总小节的身份及 forum-ID 本地 PDF；旧页面正文不进入写作。 |
| `lib/historical-openreview-pdf-source.js` | Node 库 | 根据认证 ICML poster 记录固定 OpenReview forum 身份，经项目 HTTP CONNECT、手动受限重定向和流式字节上限获取缺失 PDF。以 `O_EXCL`、`0600` 保存 forum-ID PDF 和可自校验凭证，恢复时先核验已有字节。 |
| `lib/historical-icml-alternate-pdf-source.js` | Node 库 | OpenReview 被挑战页阻断时，只为代码白名单中的 poster/forum 使用固定替代 PDF，并核验快照标题和作者顺序。`n1mAjfRDZ6` 还可导入浏览器下载的 SSRN PDF，重新检查标题、作者、日期和跨页特征文本，对应固定 DOI，并用非网络获取凭证明示来源；不能当成 OpenReview 或 camera-ready 字节。 |
| `lib/historical-direct-rewrite-plan.js` | Node 库 | 从严格的当前来源目录、历史清单和会议页面对应记录生成可重新核验的路由计划，并以自身 SHA 记录未覆盖论文页及 scope/hint-status 汇总。唯一白名单跨标题预印本须有可自校验的来源披露；普通 v5 路由保持旧字节结构以恢复长任务。不调用模型、网络、crosswalk，也不读取旧正文。 |
| `lib/historical-direct-rewrite-runner.js` | Node 库 | 执行直接重写计划前核验同计划、同来源获取序号的 scheduler-ready 记录与来源字节，保存来源对应的分析恢复检查点以便跨进程续跑；只有原文分析和 Reader 都完整时才生成私有页面。 |
| `lib/historical-direct-control.js` | Node 库 | 按计划和来源获取序号管理不可变暂停请求、安全恢复与来源检查点，并只读汇总任务、registry、汇总和发布阻断项；不调用模型或修改博客。 |
| `lib/historical-direct-page-staging.js` | Node 库 | 用直接重写所保存的来源、分析和解读正文生成历史单篇私有页面，并核对输入、清单及页面 SHA。采用标题不同的早期预印本时，页首说明它不是会议定稿（camera-ready）；当前稿 PDF 返回 404 而采用同篇旧 `vN` 时，页首说明“当前稿不可用”。 |
| `lib/historical-direct-aggregate.js` | Node 库 | 根据直接重写记录和页面对应记录重建日汇总、会议汇总及会议任务私有页面，不读取旧正文。页面对应记录 v3 用冻结链接确定任务成员，无论文汇总记录为 `retain-unchanged`，并核验全部历史页面覆盖。`reader-facing-v3` 只按主任务统计热门方向，保留双语链接标题、八维评分、分档、文档类型、arXiv、作者机构与资源状态；采用旧 arXiv `vN` 时，排行榜与条目均显示当前稿不可用和实际官方链接。 |
| `lib/historical-direct-tag-supplement.js` | Node 库 | 只读核验已完成直接重写的来源、分析与私有页面，按原分类版本提取概念及主角色。补充记录对应历史页面整文件与正文 SHA，保留旧正文和标签，单列失败，不把未完成分析当成已核验结果。 |
| `lib/historical-source-identity-supplement.js` | Node 库 | 独立核验封存 arXiv 或会议元数据/PDF 的身份及旧页精确 SHA，仅补身份、官方来源和论文版本披露，不生成分类或正文完成证明。 |
| `lib/historical-source-tag-assignment.js` | Node 库 | 对尚无有效正式分类的历史页，用编号原文片段选择标签，程序填入逐字引文后再独立审核。模型请求使用公共路由；记录明确区分词表未覆盖、待审和账号耗尽后未处理的论文。 |
| `lib/source-evidence-snippets.js` | Node 库 | `buildSourceEvidenceSnippets` 按字符预算提取并编号连续原文片段；`fillConceptQuotesFromSnippets` 按模型选择的编号填入原文引文。保留原始空白及 UTF16 位置，拒绝未知编号。 |
| `lib/source-classification-scheduler.js` | Node 库 | 以 1–3 个并行任务处理来源分类。账号级失败或停止请求发生后不再派发新模型请求，保留已返回响应，按所选论文顺序合并并记录未完成项。 |
| `lib/source-classification-failures.js` | Node 库 | 只根据公共请求层的结构化错误识别账号或服务故障，并停止新请求。正文校验失败和输出截断仍按单篇处理，不根据错误文案猜故障或切账号。 |
| `lib/historical-tag-checkpoint-export.js` | Node 库 | 读取并核验分类检查点或部分运行记录、来源、原文引文及独立审核，按排除集合导出页面分类记录。支持原连续处理范围与并发已处理集合；采用集合格式时只读取决策对应文件名的缓存。 |
| `lib/historical-direct-publication.js` | Node 库 | 核验直接重写的全部私有页面、汇总对应记录 v3、汇总文件 v2 和显式视觉处置，执行可恢复的历史发布。固定博客基线；按路径与内容 SHA 复用逐页通过记录，重跑本批确定性/Hugo 检查并生成凭证，再处理激活回滚、Git 提交与远端 OID。 |

## 默认 LLM/API：恢复与维护入口

| 文件 | 职责 |
|---|---|
| `tag-tools.js` | 校验分类词表，并在回环地址提供仅四个只读路由的静态预览服务；不提供本机助手或正式数据迁移。 |
| `tag-record-update.js` | 仅重新生成分类记录，不重跑 Reader、评分或 LLM。默认预览，写入前核验 SHA 与原分类身份；参数、确认白名单及快照步骤见本页的分类词表维护说明。 |
| `tag-check-inventory.js` | 只读盘点会议、日更及历史分类记录，按词表 SHA 汇总状态、数量和示例论文，列出与当前词表的差异。扫描字段、路径和测试参数见本页的分类词表维护说明。 |
| `conference-tools.js` | 只读校验私有会议 ledger/run；只接受受控运行目录内的直接文件名，不导入 PDF、不联网、不调用模型。 |
| `conference-analyze.js` | 核验完整会议计划、导入、筛选与发现记录后，准备、运行或查看隔离的逐篇分析。恢复时重新认证实际来源，不写日更 `current`。 |
| `conference-import.js` | 仅接受暂存/导入双文件与完整发现、筛选记录，复制认证来源并成对保存来源清单和导入凭证；不接受任意路径。 |
| `conference-discover.js` | 只读扫描显式会议元数据/PDF 目录，按 `O_EXCL` 保存候选与报告；不确认身份，不调用模型。 |
| `official-conference-acquire.js` | 在日更工作区按集中配置执行 `catalog/download/status/verify`，固定来源身份、项目 CONNECT 代理和官方地址白名单，不接受任意输出目录。`download` 可显式配置 1–5 路并发和 0–5 次同 URL 瞬时网络重试。 |
| `conference-plan.js` | 核验发现、筛选、暂存、导入全链，以及已审计划与词表 SHA，成对生成不可覆盖的 run 和计划凭证。 |
| `conference-execution.js` | 核验 run、计划、导入、暂存、筛选、发现全链，再创建独立执行目录并用受控补丁/CAS 推进；不写日更 `current`。 |
| `conference-filter.js` | 用同一会议认证候选双文件和完整证据 run 创建专属 v5 spec，再创建、检查、应用受控筛选决定。手工入口不能构造或加载 LLM actor；生产模型记录只由受控 runner 生成。 |
| `conference-filter-run.js` | 只在显式 `--apply` 时核验与当前候选、报告及证据 run 精确对应的会议 v5 spec，再逐篇调用固定公共 `requestLlmJson()`。先处理 pending；failed 仅显式限次退避重试。崩溃后先恢复已有记录，不能自动重复计费。 |
| `conference-filter-evidence.js` | 模型筛选前，根据认证候选中的封存 PDF 提取全文和 `abstract-locator-v1` 原文摘要定位证据，保存可恢复的候选与报告；不作筛选决定，不请求模型。 |
| `conference-filter-evidence-extract.py` | 证据提取使用的固定 PyMuPDF 子进程，只从受控来源目录读取请求、元数据和 PDF，输出页文本、逐页 PNG 审计、图表及公式候选、摘要定位和可核验凭证；不联网，不调用模型。 |
| `conference-staging.js` | 将完整入选集和已审提取结果一一核验，生成不可覆盖的导入清单与凭证；不复制文件，不调用模型。 |
| `conference-extract.py` | 从暂存来源中的一篇显式 PDF 提取页文本和视觉审计。`--verify --source-root ABS` 用固定 PyMuPDF 临时重新提取，比较已有文件的全部字节；公式缺少原始 TeX 时仍不能作为展示公式发布。 |
| `conference_extractor.py` | 实现会议 PDF 提取：核验文件与 SHA，记录 UTF-8 字节偏移，生成页文本、PNG、图片与版面候选；以 `O_EXCL` 保存，按结构字段报告 blocked/integrity 状态。 |
| `icmc-proceedings.py` | 从官方 ICMC 2026 合并 proceedings PDF 的书签和目录提取论文顺序、页范围与作者元数据，并按页范围无栅格化拆分单篇 PDF；不调用模型、不改写原始图表公式。 |
| `history-inventory.py` | 只读扫描配置博客的历史页面、URL 和汇总关系。dry-run 不写文件，apply 在干净 main 上成对保存不可变页面清单与凭证。 |
| `historical_page_scan.py` | 按 `historical-page-ledger-v1` 扫描历史页面，不收集旧正文；记录稳定 pageId/cohort、逐次链接目标、待核分类、Git tree 与远端 main。扫描前后及 `O_EXCL` 保存前核验 CAS。 |
| `historical-page-render.py` | 根据上游核验过的历史论文输入生成单篇页面。普通历史路径使用标签分配记录，直接重写路径使用保存的分析和来源记录；正文从分析结果重新解析，不使用旧页面正文。 |
| `page-source-crosswalk.js` | 从直接命名的历史清单与凭证创建独立 crosswalk，管理受控决定和 CAS。普通磁盘 arXiv 来源文件不能获得发布授权；finalize 要求全体 verified，且来源可在现场重新核验。 |
| `history-conflict-identity.js` | 在同一进程核验官方 arXiv 来源，再将操作者明确选定的已有冲突提示记录为 verified 决定，并按 CAS 写入；不读取旧正文或标题。 |
| `arxiv-source-authority.js` | 按规范 arXiv ID 规划或获取官方全文，用于维护来源授权；不属于 direct 路线或 arXiv 获取失败备用批次的选择器。dry-run 不联网、不写文件。 |
| `historical-arxiv-analysis.js` | 用现场核验的 arXiv 全文和白名单原始抓取元数据创建独立原文分析 run。analyze 调用现有多阶段引擎，结果不写入日更 current。 |
| `historical-arxiv-analysis-scheduler.js` | 仅调度旧备用路线中 finalized crosswalk 的历史 arXiv 分析。`new-full`、`reader-recovery`、`all` 只维护旧队列，不能阻断或替代 direct-local。 |
| `historical-tag-assignment.js` | 对完成的历史分析逐篇或批量重新分类。dry-run 不写文件，apply 只保存独立分类结果，不调用模型。 |
| `historical-page-staging.js` | 按指定分析运行和当前词表 SHA 选择对应的标签记录，再依据已核验的页面对应表生成私有单篇页面，不写入博客。 |
| `historical-daily-aggregate.js` | 按 `--staging-runs UUID[,UUID...]` 合并多份单篇页面，重建私有日汇总清单，保留原路径与 URL。dry-run 不写文件，apply 也不写博客。 |
| `historical-publication.js` | plan 固定旧历史发布输入、博客基线与逐路径操作；generate 再核验生成来源，以 `O_EXCL` 保存私有文件。没有认证汇总时拒绝 conference refs。 |
| `historical-postprocess-scheduler.js` | 处理旧备用 crosswalk 分析的重新分类、单篇页面和日汇总，并保存恢复记录；direct-local 使用 `historical-direct-aggregate.js`。 |
| `conference-postprocess.js` | 用完整会议计划授权参数逐篇重新分类并生成私有页面，或为计划全部入选成员生成私有汇总；所有根目录来自项目配置。 |
| `conference-process.js` | 新会议唯一生产批处理入口。从完整入选集自动封存官方 proceedings 精确 PDF、导入、创建当前分类计划，以稳定逐篇 UUID 调用公共分析引擎；整批默认并发 1，可通过 `--concurrency` 设为 1–5，每篇内部分析并发固定为 1。生成单篇与全会私有页面，以检查点和完成凭证核验整个流程；不发布博客，来源升级选择规则见本页末尾。 |
| `conference-page-render.py` | 从已封存的会议 Reader 与已分配分类渲染会议单篇页，明确其 PDF 来源能力，不使用 arXiv 身份别名；不生成图片文件，不读取旧博客正文。 |
| `historical-arxiv-batch.js` | 备用入口只接收 `--handoffs NAME.json[,NAME.json...]` 命名、不可变的 arXiv 获取失败交接文件，逐页核验冻结清单、页面 SHA 和非标题链接；不扫描 crosswalk pending 页、不调用模型，也不阻断 direct 队列。 |
| `historical-archive-crawl-batch.js` | 已停用的兼容入口，调用时直接拒绝；已有归档抓取数据只能由 direct 路线读取。 |
| `historical-local-crawl-batch.js` | `historical-archive-crawl-batch.js` 已停用兼容入口的别名，调用时直接拒绝。 |
| `historical-conference-crawl-batch.js` | 已停用的兼容入口，调用时直接拒绝；会议元数据、PDF 和精确标题指纹只能用于 direct 本地来源与页面对应，不得写 crosswalk。 |
| `historical-conference-local-sources.js` | 只读生成本地会议来源清单 v2，必须显式传绝对 `--icml-poster-snapshot` 与已有 `--icml-pdf-root`。新 PDF 和获取凭证根目录由参数或集中配置提供；不接触历史页、crosswalk、模型、网络或发布。 |
| `historical-openreview-pdf-source.js` | 为一个已认证 ICML/OpenReview forum ID 规划或封存缺失官方 PDF。dry-run 不联网、不写文件；PDF 保存到本地来源清单实际读取的 ICML PDF 根，凭证单独进入运行目录。 |
| `historical-icml-alternate-pdf-source.js` | 只封存代码白名单中的 ICML 替代来源，固定 poster/forum、标题、作者与来源 URL。`--import-file` 仅允许 `n1mAjfRDZ6`，重新提取并匹配标题、作者、日期和跨页特征文本，以非网络获取凭证记录浏览器下载导入。 |
| `historical-conference-page-projections.js` | 从指定的本地来源目录和历史清单确定会议论文与页面的对应关系；核对页面文件 SHA，但不把旧正文用于重写。 |
| `historical-direct-rewrite-inputs.js` | 用冻结清单中的唯一 arXiv 提示、严格主评分行身份、ICML poster 全量/可路由身份、会议来源清单和博客根目录，生成范围固定的 v5 输入目录；不要求额外 arXiv 来源清单。 |
| `historical-direct-rewrite-plan.js` | 用直接重写的 v5 来源目录、历史清单与会议页面对应记录 v3 生成原文重写计划，核验 arXiv 主身份与 ICML 可路由身份；拒绝旧 v4/v3 文件，并报告未覆盖历史论文页。 |
| `historical-direct-rewrite-scheduler.js` | 只准备直接重写计划的 arXiv/会议来源队列和封存文件，支持固定论文集合/上限、计划及获取序号锁、暂停标记、安全信号停止与逐项进度。arXiv 原子保存 TXT、PDF、元数据、清单；失败只保存不可变 crosswalk 交接文件，不执行分析、Reader、crosswalk 或发布。 |
| `historical-direct-rewrite-run.js` | 运行仅使用原文的直接重写分析、Reader 和单篇私有页面生成。apply 要求所选项已有同计划、同获取序号的 scheduler-ready 状态；失败阶段按来源核验过的恢复文件跨进程续跑，不能当成已生成页面。 |
| `historical-arxiv-publication-metadata.js` | 默认对直接重写计划全部 arXiv 论文预览或批量封存官方 Atom 附件。只复用满足当前论文版本和时间窗的原始 Atom，其余按封存来源 ID 经公共 CONNECT 适配器精确获取，不调用模型。瞬时失败最多重试三次；单篇耗尽后继续整批，最后报告 partial 并非零退出。失败项不生成附件，重跑只补缺失项。 |
| `historical-direct-aggregate.js` | 为直接重写中已完成的论文记录生成可重新核验的日汇总或会议汇总私有页面。 |
| `historical-direct-tag-supplement.js` | 仅在历史工作区生成不可变分类补充和报告，不修改博客页面或发布状态。所需计划、词表、博客、快照及 run 参数见本页的历史补充维护说明。 |
| `historical-source-tag-assignment.js` | 仅在历史工作区按原文生成分类补充，逐请求保存选择、审查和决定的检查点。同 UUID 核验输入后续跑；账号耗尽只保存编号 partial，不占用最终产物。参数见本页的历史补充维护说明。 |
| `historical-source-identity-supplement.js` | 仅在历史工作区核验全部封存来源和没有正式分类记录的旧页，生成独立不可变身份证明，保留会议来源与论文版本披露，不请求模型。参数见本页的历史补充维护说明。 |
| `historical-tag-checkpoint-export.js` | 从分类检查点或部分运行记录导出页面分类记录和处理报告，保留原分类缓存，不调用模型。恢复、排除集合和新运行参数见本页的历史补充维护说明。 |
| `historical-direct-control.js` | 提供全历史长任务控制：`history:status` 单次或持续只读汇总 registry、暂停、锁、覆盖率、汇总和发布阻断项；`history:pause` 保存对应计划与获取序号的停止请求；`history:resume` 只在操作锁释放后恢复。 |
| `historical-direct-publication.js` | 全历史直接重写发布入口：按 `plan → generate → review → publish → status` 驱动单一 publication UUID；发布阶段独占共享博客锁并验证远端 `main` OID。 |
| `historical-direct-review.py` | 协调历史直接重写的逐页语义审查，复用正式发布的 LLM 与多模态审查，保存对应输入、模型、提示词和代码的检查点；全部页面通过后才生成最终凭证。 |
| `paper_identity.py` | 实现与 Node 相同的 `paper-identity-v1`，用共享测试向量核对身份与 SHA 结果。 |
| `tag_catalog.py` | 与 Node 共用分类词表，显式解析当前格式或旧格式标签并精确映射概念。新正式页面只接受有效的中文首选标签及 [既定英文专名例外](../AGENTS.md#内容与评分检查)；未知或歧义标签报错，不自行缩小含义。 |
| `tag_paths.py` | 集中定义标签词表及私有预览路径，按显式参数、环境变量和默认目录依次选择博客路径；目录存在与仓库身份由调用方另行检查。 |
| `build-tag-preview.py` | 根据历史页面元数据生成私有标签索引、旧标签处理表和待评审报告，不改写博客。按名称或别名作字面对照；七种处理状态和证据要求见本页的分类词表维护说明。 |
| `deep-analysis-only.js` | 只读取当前 `dailyFreshSourceRun` 的封存 PDF/TXT，继续分析筛选已完成但分析未完成的论文。来源缺失或不匹配时停止，不抓取，也不读取旧缓存。 |
| `batch-analyze.js` | 用当前正式分析结果绑定的日更 PDF/TXT 批量分析未完成论文。`--retry-failed-readers` 仅归档并停用这些论文的失败 Reader 候选；没有对应来源记录时停止。 |
| `reanalyze.js` | 归档并停用全部旧失败 Reader 候选，清空 Reader 和图片补充状态后强制全量重分析。仍只读取正式分析结果精确绑定的日更 PDF/TXT，不恢复旧分析、正文或缓存。 |
| `reanalyze-selected.js` | 只重分析指定 arXiv ID，并同步恢复统计。 |
| `analyze-single-paper.js` | 从论文库选择一篇论文分析，并合并回正式分析结果。 |
| `refilter-reanalyze-by-date.js` | 对历史日期重新筛选、分析并写入受控日期快照。 |
| `refresh-api-reader.js` | 刷新指定论文或日期批次的 Reader、评分、作者和图片阶段。只读取封存 PDF/TXT；图片只为本次调用在系统临时目录中准备。 |
| `evaluate-keyword-prefilter.js` | 只读回放金标准与历史正样本，报告关键词召回。 |
| `test-api-key.js` | 测试主模型或副模型的协议路由、代理和响应。 |
| `verify-project.js` | 沙箱外完整离线验证：固定 Hugo、全仓语法、默认/Manual JS 与 Python、只读数据检查；`--quick` 仅语法与数据，不是完整验收。 |
| `llm-usage-report.js` | 只读汇总真实请求用量，区分服务提供的 usage、不可得状态和字符估算，不推算未经证实的费用。 |
| `evaluate-reader-efficiency.js` | 在隔离目录中按明确限额开展单篇 Reader 效率实验。默认只预检，`--live` 才调用模型；不覆盖正式分析结果或发布博客。 |
| `rewrite-from-source.js` | 通过 `prepare/sources/analyze/status/patch/signed-patch/promote` 显式运行同源重写。`patch` 修复失败候选，`signed-patch` 局部修订本 run 的成功 Reader 并要求事实复核；两种补丁都不调用 API，也不接受任意路径。 |
| `paper-rethink-server.js` | 历史独立维护工具；博客已取消本机助手集成，不应为阅读、引用或复制 AI 提问启动此服务。旧接口实现仍保留供历史维护。 |
| `validate-data-files.js` | 只读核验当前数据、跨文件论文集合、评分及兼容结果的来源记录。 |
| `backfill_papers.py` | 只补录历史论文 ID，不执行深度分析。 |

## 配置、环境与通用工具

| 文件 | 职责 |
|---|---|
| `config.js` | Node 参数与运行数据路径的集中配置。 |
| `env-loader.js` | 从项目 `.env` 建立受控运行环境，检查直接 Node 和 Manual 入口的运行条件。 |
| `utils.js` | 提供 Node 原子文件写入、时间、ID、分析解析、提示词、LLM 协议和代理工具；`readTagValidation` 读取新旧解析结果中的标签检查对象，拒绝混用字段。 |
| `lib/analysis-section-titles.js` | 识别分析章节及代码围栏，读取唯一的论文评价章节，并兼容旧标题而不改写原文。 |
| `llm-account-pool.js` | 管理 Node OpenCode Go 账号池，持续使用成功账号，识别额度错误，并保存跨进程账号状态。 |
| `log-setup.js` | Node 终端/文件日志、时间戳和敏感信息脱敏。 |
| `runtime-storage.js` | 只读统计运行存储，按文件引用关系预览受控缓存或日志清理；只有显式 `--apply` 才清理。 |
| `project_env.py` | Python 项目环境、最小子进程环境与代理加载。 |
| `path_config.py` | Python 共享路径、日期与原子写配置。 |
| `blog_repository_lock.py` | 管理共享博客锁，以 Git common-dir 协调不同项目工作区；核对 PID、hostname、token、lease、inode 和 SHA 后才回收或释放，不污染博客 Git。 |
| `llm_account_pool.py` | 按与 Node 相同的数据格式和锁协议管理 OpenCode Go 账号池。 |
| `llm_usage.py` | 记录 Python 发布请求的用量与失败事件，沿用跨运行请求归因格式。 |
| `utils.py` | Python 分析与评分解析、发布侧通用文本工具；`read_tag_validation` 读取新旧解析结果中的标签检查对象，拒绝混用字段。 |
| `tag_stage_record.py` | 只读识别标签阶段的新旧保存格式，返回原阶段、检查点及实际字段名；格式可读不代表哈希或发布资格已经通过。 |
| `analysis_sections.py` | 在 Python 解析和发布检查中识别论文评价章节，兼容旧标题并拒绝重复或混用。 |
| `log_setup.py` | Python 统一日志与脱敏。 |
| `runtime_guard.py` | 拒绝在沙箱内运行 Python 项目入口。 |
| `python-runtime.sh` | 为默认博客/视觉入口选择并校验 Python 3.11+ 与 OpenSSL，可由 `PD_PYTHON_BIN` 覆写。 |

## 博客生成、审查与发布

| 文件 | 类型 | 职责 |
|---|---|---|
| `generate-blog.py` | Python 入口 | 只生成并安装 Hugo Markdown。 |
| `activate-fresh-publication.js` | Node 入口 | 显式接替同日已提升重写结果的旧发布，持有本 run 操作锁后调用 Python 归档旧凭证；不生成内容或推送。 |
| `publication_activation.py` | Python 入口/共享库 | 核验旧提交、博客基线和实时远端，归档六个精确状态文件。pending 状态阻断发布三阶段，支持中断恢复，不修改已提升的论文分析。 |
| `review-blog.py` | Python 入口 | 审查本批最终页面，执行确定性检查、LLM、图片和 Hugo 审查，通过后生成 receipt。 |
| `push-blog.py` | Python 入口 | 核验 receipt，提交并推送其允许的改动，确认远端 OID 后规划视觉任务。 |
| `publish-to-blog.py` | Python 核心 | 实现三阶段共用的页面模板、分类标签兼容映射、Git 事务、批次凭证及发布证明。`researcher-workbench-v1` 规定页面元数据、引用和 rethink 附件；逐页审查永久按“相对路径 + 内容 SHA”复用。发布器代码变化会重渲染，但最终字节未变的页面不重审。 |
| `publish_common.py` | Python 共享 | 提供发布数据、评分、Manual/API 来源核验及 LLM 审查的共用规则。 |
| `blog_entry_loader.py` | Python 桥 | 以固定路径加载文件名含连字符的 `publish-to-blog.py`。 |
| `markdown_hugo_gate.py` | Python 共享 | 检查 Markdown、页面元数据、公式和图片，并运行 Hugo 渲染检查。 |

## 发布后视觉与状态

| 文件 | 类型 | 职责 |
|---|---|---|
| `visual-summary-state.js` | Node 入口/状态机 | 规划、校验、登记和归档 TOP 10 论文长图。当前 v3 只使用已核验 Reader 的 thesis 与完整章节；日更核对官方论文图身份后返回空引用路径，不取旧缓存。QA 对应章节 SHA，不退回正式分析摘要。 |
| `digest-cover-state.js` | Node 入口/状态机 | 每日汇总封面任务规划、校验、登记、失败和历史归档。 |
| `visual-summary-integration.js` | Node 共享 | 在同一发布证明下协调论文长图与汇总封面。 |
| `plan-post-publish-visuals.py` | Python 入口 | 博客远端发布核验通过后调用共用视觉规划接口。 |
| `render-visual-summary.py` | Python 调试入口 | 按固定规则在本地渲染，仅用于调试或离线兜底，不替代正式生图工具。 |
| `waive-post-publish-visuals.js` | Node 入口 | 用户明确取消生图时，记录与当前发布绑定的视觉豁免。 |
| `digest-run-report.js` | Node 入口 | 汇总抓取、筛选、分析、远端发布和两类视觉状态；尚未自动核验部署与网页。 |

## 可选渠道

这些入口不属于默认日更；它们仍复用博客发布快照、公共数据和环境模块。

| 文件 | 职责 |
|---|---|
| `publish-wechat-full.py` | 生成或发布微信公众号内容。 |
| `publish-to-feishu.py` | 生成飞书文档。 |
| `publish-xiaohongshu.py` | 生成小红书文案与汇总内容。 |
| `xiaohongshu-publisher.py` | 小红书登录及浏览器自动发布入口。 |

## Manual 与历史兼容边界

- Manual 正式流程、v5 兼容、审查和 sealed-preview 实现均在
  [`manual/scripts/`](../manual/scripts/)；对应测试在
  [`manual/tests/`](../manual/tests/)。
- `scripts/analysis-contract.js` 与 `scripts/validate-data-files.js` 会导入 Manual
  validator，以确保默认工具能读取并拒绝损坏的历史产物。
- 博客共享层同样保留 Manual 只读验证，但默认 `digest:prepare` 不会调用 Manual 的
  写作、任务注册或结果写入入口。

## 同日全量重写后的重发

显式全量原文重写已达到 `promoted`，需要接替同日旧发布时，先运行
`npm run blog:activate-fresh -- --run-id UUID --dry-run` 查看结果，再去掉 `--dry-run` 执行。
此入口只处理基线中一个整批和一个单篇旧发布，精确归档其 6 个 manifest/receipt/pass 文件到该 run 的
`publication-archive/`。它不修改论文分析、博客页面或图片证据，不调用模型，也不推送。

执行前会核验旧凭证各自的原提交、当前 Hugo 仓库干净 HEAD、实时远端 OID 与身份、基线字节及已提升的
正式分析结果。中断时使用同一命令恢复。按日期设置的 pending 检查会持续阻断 generate/review/push，
不得手删标记或凭证。成功后按 `blog:generate → blog:review → blog:push` 重建发布依据。
旧视觉豁免不会自动适用于新发布；完成后再次调用此入口，也不会停用新一轮生成记录。

## 分类词表维护说明

标签预览的新索引、报告、文件清单和处置记录使用 `paper-tag-*-v2` 格式，词表版本字段为 `tagCatalogVersion`，默认输出目录为 `data/runtime/tag-preview/`。读取器在核对原文件 SHA 后检查整套版本、词表与来源；旧预览仍按原格式读取，新生成器不会覆盖旧目录中的 v1 文件。预览只核对已有页面的标签，不修改论文库、分析结果或博客。

当前默认词表版本为 `paper-tag-catalog-v2`。Node 的 `loadTagCatalog()`、默认标签规则和 Python 的
`load_tag_catalog()` 都要求这个版本；显式指定的历史快照仍可读取 `paper-taxonomy-v1`，并按原字节核对 SHA。
这两个已知版本使用相同的字段结构。版本名称的单向迁移本身不算破坏性变更，但升级说明必须分别对应真实旧快照和当前词表的版本及 SHA。
概念删除、替换、含义或维度变化仍按原规则判断，不能借版本改名绕过确认和标签阶段核验。反向降级及未知版本不在这个迁移范围内。

会议和历史处理的当前审查报告使用 `tagReview`、`tagReviewQueue`，有实际队列文件时才返回 `tagReviewQueueFile`。
会议新队列保存为 `tag-review-queue.json`，格式为 `conference-tag-review-queue-v2`，独立版本号为 2。
旧检查点先按原哈希核验，程序只在内存中转换报告名称，不修改旧状态。只读报告可以返回确实存在的旧队列路径；
重新生成队列时，程序先原子写入新文件，再移除旧队列缓存。标签未确定的论文仍不能自动重试或进入发布。

### 标签选择与具体程度

`lib/tag-rules.js` 默认使用 `paper-tag-selection-v2`：标签总数须为 3–5，任务类（`facet=task`）标签须有 1–3 个，
其中主任务恰好 1 个，次任务最多 2 个；祖先标签和后代标签不能同时存在。主任务必须是所选集合中最具体的
任务，否则报错。如果整个词表中还有未选的有效后代，只返回 `specificityWarning` 告警，不改变 `valid`。
这条告警仅供新的分类或修复步骤使用，不改变已核验阶段的恢复行为。别名只供显式旧格式解析。

Node 的 `parseAnalysis` 和 Python 的 `parse_analysis` 现在只输出 `tagValidation`，其中保存标签检查结果。
`readTagValidation` 和 `read_tag_validation` 兼容读取旧缓存中的 `taxonomyValidation`，读取时不改写缓存。
同一对象出现新旧两个字段会被拒绝，即使两值相同或其中一个为空；旧评分缓存缺少这项结果时，仍按各入口原规则处理。
正式发布仍重新解析原正文，旧缓存不能代替标签、阶段和来源核验，也不能绕过人工评分覆盖的检查。

标签更新工具的只读检查不迁移旧缓存。注记模式沿缓存原字段更新词表版本和 SHA；显式重新生成模式才在新输出副本中迁移标签字段，
并保留缓存中的其余内容和评分覆盖。解析结果的字段名与正式阶段记录的保存格式分别核验。

新的 API 标签阶段与正文检查点都使用 `tagSelection`。`contracts.tagSelectionRecord` 保存独立格式版本
`paper-tag-stage-record-v2`，阶段内另保存实际使用的标签选择协议。`tagSectionAndPrimaryTagsSha256` 记录标签章节
与机器摘要中主任务、主方法标签文本的哈希。

`lib/tag-stage-record.js` 与 `tag_stage_record.py` 按明确格式读取记录。旧记录继续使用原阶段名、检查点、合同字段
和十三字段绑定；新绑定只替换标签内容哈希的字段名，其余十二项和顺序保持。字段名参与绑定哈希，因此两种格式
分别按自己的原字段计算。同一记录的阶段、合同、检查点或哈希字段混用两种格式时会被拒绝，即使值相同或为空。
读取器不改写输入，保留原格式及内容哈希；完整正文、词表、前后阶段和检查点仍须通过原检查。

正常新执行或真正的显式重新生成写新格式。只读检查、同词表的 `already-current` 结果和注记模式保留原格式；
`reproject` 不会自动迁移全部同词表旧记录。新执行的标签指纹包含新保存格式及读取器源码身份，旧检查点仍按原失效规则处理。
人工流程的十一项阶段集合、提示身份和审查凭证保持。
显式重新生成前，还须核对原格式的十三项哈希绑定及原阶段合同。原哈希或合同不一致时，该篇论文返回阻断结果，不能通过重新计算哈希掩盖旧错误；正文、检查点、所选概念和词表升级情况仍须完整检查。

结构修复在标签段缺失或主标签字段为空时，使用“待选择主任务”“待选择主方法”和“待选择补充标签”标出待处理项。
这些临时标签不能通过正式词表检查。标签检查未通过时，机器摘要里的非空值仍会保留；检查通过时，程序仍以解析出的主标签为准。
结构修复的指纹包含这套输出规则的版本。版本不匹配时，程序按既有阶段关系重新处理；旧摘要可复用的阶段不因此增加。

历史来源分类的实际模型接口使用 `evidenceId` 返回片段编号，由程序填入引文；导出的直接引文接口使用 `quote`，
两者不能混用。独立审核只判断所给片段能否支持标签。新提示和实现会改变新请求及尝试缓存的身份，
但显式续跑仍按原规则排除已处理集合，不会因提示改写就重审或重签全部旧决策。

### 词表变更与确认范围

会议和历史页面的新临时渲染输入使用 `tagMetadata` 传递标签记录。读取器仍能读取旧包的 `taxonomy`，
但同一个包同时包含两个字段时会拒绝处理，即使两者值相同或为空。读取旧包不会改写保存记录或重算原绑定。
发布器的内部页面组合结果也使用 `tagMetadata`。新页面使用 `paper_digest_tags_*` 字段，网站仍能读取已有页面的旧字段；
新页面的扁平标签协议为 `paper-tag-flat-tags-v2`。新上下文文件使用 `paper-research-context-v2`、`schemaVersion=2`，标签信息保存在 `assessment.tagMetadata`。旧 `researcher-sidecars-v1`、`schemaVersion=1` 的 `assessment.taxonomy` 仍按原格式读取；搜索字段和词表资产后续分别迁移。
新上下文的页面附属文件记录带有明确的 `contract`；旧记录缺少这一标识时，核验器按旧格式重建原字节，不根据标签协议猜上下文格式。三个引用文件不因这项改名改变格式或内容。

新会议汇总使用 `conference-aggregate-staging-v2`、`version=2`，标签信息和层级统计分别保存在 `tagMetadata`、`tagHierarchy`，成员的标签分配 SHA 为 `tagAssignmentSha256`。层级格式为 `conference-tag-hierarchy-v2`。Python 发布器先核对汇总记录的规范对象 SHA、完成记录和 Markdown 原字节，再按明确版本读取字段；旧 v1 汇总按原字段读取，新旧字段混用会被拒绝。独立汇总版本不改变子论文页、标签分配或旧证明的格式，也不会重写已保存的阶段文件。

页面的标签字段有六项：`contract`、`selection_contract`、`registry_version`、`registry_sha256`、`concepts` 和 `scope`。
同一页只能使用 `paper_digest_tags_*` 或旧 `paper_digest_taxonomy_*` 中的一组，混用会被拒绝，即使值相同或为空。
历史补充和导出的字段判断不会改写旧页面或保存证明，原页面 SHA 与来源绑定仍须通过；网站模板也会阻止混用页面构建。
旧 `paper-taxonomy-flat-tags-compat-v1` 记录按原声明读取。新字段族可能包含上一批已保存的旧协议，读取时不改写；新生成只使用 `paper-tag-flat-tags-v2`。两版标签含义相同，未知协议不能通过已核验标签判断。会议汇总可以读取两版合法成员，但新汇总页面明确写新版，不沿用首篇成员的旧协议。
旧页面审查按页面声明的协议重建预期标签和附属资料字节；原页面、资料及来源 SHA 仍逐项核验。
新的历史扫描政策为 `historical-page-scan-policy-v4`，使用 `tagRoutes` 和 `schema-checked-hash-default-whitelist-v4`。
旧 v3 清单仍按完整原政策读取，不能用它声明新字段已受核验，也不会因此重签原清单。

分析的当前指纹分别用 `tagCatalogVersion`、`tagCatalogSha256`、`tagPromptContract`、`tagPromptSha256` 和 `tagSelectionContract`
记录词表、提示与选择规则。字段迁移会改变主分析、修订、结构修复和标签选择的输入指纹，旧检查点按原规则失效。
会议页面的实现指纹使用 `conference-page-projection-v2`、版本 2，`tagCatalogSourceSha256` 记录词表加载器的源码摘要；
分配和页面清单仍使用各自原版本。升级后生成新的实现目录，原页面和原证明保留，不通过改写旧字段来沿用旧指纹。
发布器的模板指纹用 `tagCatalogSha256` 记录词表内容摘要；临时文件许可用 `controlledTagFiles` 标明已核验的词表文件。

当前标签阶段和选择元数据写入 `paper-tag-selection-v2`。读取旧记录时仍接受明确的 `paper-taxonomy-selection-v1`，
但须按记录原字段和值核验全部绑定；新旧保存格式都可能包含旧选择协议，不能仅凭阶段格式判断选择协议。
旧格式的合同声明必须与阶段中保存的选择协议一致。重新生成才写新协议，只读核验和词表升级注记不会替换旧协议或重算旧绑定。
会议渲染可将已核验的旧选择阶段对应到当前新选择记录，因为两代规则的含义相同；词表版本、SHA、主标签和概念集合仍须精确相等，未知选择协议不能通过。

新生成的词表升级说明使用 `paper-tag-catalog-upgrade-v2`，版本号为 2。旧说明仍按 `paper-taxonomy-registry-upgrade-v1`、
版本号 1 读取；这两个标识和版本必须分别配对，未知标识或混用版本会被拒绝。两种格式都须完整核对真实旧快照、
新旧词表版本及 SHA、重算变更等级、允许的明确确认和所选概念，旧说明不因读取而改写。

新模型请求使用 `paper-tag-prompt-text-v2` 标签提示。Node 的 `buildTagPromptText(tagCatalog, promptTextContract)`
和 Python 的 `build_tag_prompt_text(tag_catalog, prompt_text_contract)` 默认使用新版；只有核验旧记录时才显式选择
`paper-taxonomy-prompt-projection-v1`。这次变化只改提示协议行和中文说明，词表、概念选择规则及输出字段保持。

词表 SHA 相同时，读取器按记录保存的提示版本精确核对全文 SHA。词表升级后，新版还须按旧词表快照核对提示 SHA，
并通过原有升级检查。旧版跨词表记录保留原兼容范围：Node 不单独核对提示 SHA，Python 只检查其格式；
两端仍核对旧快照、升级说明、确认范围和概念是否有效。不能把这条旧兼容分支当作旧提示全文的精确认证。
核验不会重写旧记录。显式重新分析时，新提示身份进入原阶段指纹；不匹配的旧检查点仍按原规则失效。

`lib/tag-catalog-change.js` 将变更分为 `none`、`additive`、`destructive`，按字节 SHA 从
`config/tag-catalog-history/` 读取升级前快照，并生成或核验 `registryUpgradeFrom`。
程序判为 `none` 或 `additive`、且原概念对应关系仍有效的变更，可以沿用已核验的标签阶段。`additive` 还包括部分定义、范围说明和状态修订，不只新增内容。读取时仍须核对旧快照、升级说明和原概念选择。破坏既有记录的变更（`destructive`）默认拒绝，并报告
`blocked` 与 `needsHuman`；只有明确确认且属于允许范围的改动才能重新生成分类记录。

`canAcknowledgeRegistryChange` 判断可确认范围；命令 `--classify` 输出 `acknowledgementEligible`、
`eligibleReasons` 和 `ineligibleReasons`，应先看结果再决定。允许确认的原因包括
`preferred-label-changed`、`broader-id-changed`、`alias-removed`、`label-collision` 以及定义或适用范围的修订。
新增概念本身不妨碍确认，但删除概念等白名单外的破坏性变更仍会被拒绝。
原 `conceptIds` 对应的概念仍须全部有效；旧快照须可读取，升级注记也须与复算结果一致。

以下原因不能确认，即使给出确认参数也仍然拒绝：`concept-removed`、`facet-removed`、
`status-deactivated`、`version-changed`、`concept-facet-changed`、`active-label-not-globally-unique`。
任何检查依据缺失也须停止，不能只靠一个确认布尔值继续。

### 重新生成分类记录

`tag-record-update.js --from PROCESS_UUID` 默认预览，输出逐篇新旧 conceptIds 差异及 `assigned/blocked`
报告；`--apply` 才依次保存分析、运行记录、进程状态和完成凭证，每次写入前都核对原文件 SHA，发现其他修改就停止，
并将已完成进程退回运行状态（`complete` → `running`）。不重跑 Reader、评分或 LLM；分类对应关系无法核验时拒绝写入。
`--mark-stale` 只读列出失效 assignment 文件；`--classify` 只分类词表变更。

新更新报告使用 `paper-tag-record-update-report-v2`、`version=2`，输出的命令名称为 `update-records`，更新方式记录在 `updateMode`。失效记录报告使用 `paper-tag-stale-assignment-report-v2`、`version=2`。`--report NAME.json` 将报告保存到 `data/runtime/tag-record-update-reports/`；同名文件拒绝覆盖，旧目录和报告保留。报告版本只描述输出格式，不改变原标签记录的核验规则或赋予发布资格。

破坏既有记录的变更（`destructive`）须显式使用 `--acknowledge-destructive`，且符合上面的原因白名单。可选
`--acknowledge-note TEXT` 接受 1–500 字符；不传时用含 from/to 字节 SHA 的默认说明。程序将
`destructiveAcknowledgement = {acknowledged:true, reasonsHash, conceptIdImpact:'none', note}` 写入
`registryUpgradeFrom`；`reasonsHash` 对应本次重新计算的变更原因，Node/Python 使用相同哈希规则。

确认参数只用于更新分类记录，不能与 `--archive-snapshot`、`--mark-stale` 或 `--classify` 一起使用；
`--acknowledge-note` 必须与 `--acknowledge-destructive` 一起使用。不传确认参数时仍按原规则拒绝
`destructive` 变更。确认记录不进入 `bindingSha256`；更新后仍须通过
`analysis-contract.validateTagStageProof` 与 Python `_validate_tag_catalog_upgrade` 的同一确认检查。

### 修改词表前保存快照

先运行 `npm run tags:update-records -- --archive-snapshot`，把当前 `config/tag-catalog.json` 原始字节保存为
`config/tag-catalog-history/<内容字节SHA>.json`，再修改词表。文件名与内容 SHA 不符时拒绝；同名文件
字节一致时可重复执行，字节不同则报错且不覆盖。未归档旧表时无法取得旧快照，已核验论文不能继续恢复。

`npm run tags:check-inventory [-- --json]` 只读扫描
`conference-analysis-executions/*/analysis.json` 中的新旧标签阶段词表 SHA 和状态、
`data/current/deep-analysis-result.json` 的逐篇分类记录，以及 `historical-taxonomy-assignments`。
按 registry SHA 汇总数量、示例 paperId 及与当前 `config/tag-catalog.json` SHA 的差集。
它不删除、改写、重新验证或调用模型。格式混用须明确报告为不可读，不能取其中一套字段继续统计。
当前盘点输出使用 `paper-tag-record-inventory-v2`；原分组、计数和退出码保持。
测试样例可用 `--executions/--deep/--assignments/--registry` 显式覆盖路径。

### 历史标签预览

`build-tag-preview.py` 按七种状态输出 `disposition` 与 `evidence`：
`keep/alias/broader/split_review/move_facet/deprecated/out_of_scope`，并保留
`status/conceptId/facet/semanticReview` 列。默认不重新判断语义。`deprecated/out_of_scope` 必须附上
跨会议零命中扫描证据和人工评审署名；`split_review` 必须列出候选词。缺少这些依据时停止。

标签预览的候选查找函数为 `find_contained_tag_concepts`，只按文字包含关系查找概念。Python 预览函数的可选词表路径参数为 `tag_catalog_path`；仓库内调用均按位置传参，使用旧关键词名的外部调用须同步修改。保存的 `source`、`upperConceptId` 等字段及七种状态保持原格式。

## 历史补充维护说明

下列命令只在历史工作区运行。它们生成独立补充记录，不替换历史正文或正式发布状态。

来源分类和证据片段库使用以下接口。直接引文接口要求模型返回 `quote`；当前历史分类流程要求模型返回片段编号 `evidenceId`，随后由程序填入原文引文，两种格式分别解析。公开的 `projection`、`evidence` 等选项和保存字段继续沿用原格式。

| 函数 | 作用 |
|---|---|
| `parseTagSelectionResponse` | 解析标签选择响应，并核对字段、概念、原文引文和主标签规则。 |
| `parseTagReviewResponse` | 解析独立审核响应，拒绝未通过或仍有问题的结果。 |
| `validateCachedTagSelection` | 核对分类缓存的内容哈希、来源、引文和独立审核记录，返回重新解析的选择结果。 |
| `loadPaperSourceDetails` | 读取指定论文的来源，返回正文、标题和来源记录。 |
| `buildConferenceSourceRecord` | 根据指定会议材料及提取结果构造来源记录，并检查两者是否对应。 |
| `buildQuotedTagSelectionPrompt` | 生成要求模型直接提供原文引文的标签选择提示。 |
| `buildSourceEvidenceSnippets` | 按字符预算提取、选择并编号连续原文片段。 |
| `fillConceptQuotesFromSnippets` | 根据片段编号填入原文引文，返回供后续解析的响应及片段选择记录。 |

完整命令入口继续调用 `exportCheckpoint`。库内的页面记录操作使用以下接口：

| 函数 | 作用 |
|---|---|
| `filterAndValidatePageRecords` | 跳过排除集合中的论文，随后核验保留的页面记录。 |
| `validatePageClassificationRecord` | 核对记录自身的内容哈希，以及它与分类记录的对应关系。 |
| `validatePageRecordsAgainstPlan` | 核对记录所在路径、论文、页面编号和页面 SHA 是否与计划对应。 |
| `buildPageClassificationRecord` | 从已读取的页面字节、分类记录和标签规则构造页面分类记录。 |

```bash
npm run history:tag-supplement -- --plan ABS --registry ABS --blog ABS --snapshot ABS --run-id UUID
npm run history:source-tags -- --plan ABS --registry ABS --blog ABS --snapshot ABS --run-id UUID
npm run history:source-identity -- --plan ABS --registry ABS --blog ABS --snapshot ABS --run-id UUID
npm run history:tag-checkpoint-export -- --plan ABS --registry ABS --blog ABS --snapshot ABS --run-id UUID --checkpoint ABS [--exclude-paper-ids ID,...]
```

运行保存论文选择集合，以及标签选择响应、独立审核和分类决策的检查点。使用同一 UUID 继续运行时，仍须核对输入；账号用量耗尽后保存编号的部分运行记录，不占用最终产物文件。导出器读取并核验分类检查点或部分运行记录，核验已接受的分类缓存后导出页面分类记录。报告同时保留失败项和未处理论文，不请求模型。

暂停后重跑原 UUID 可继续分类。要从正规 checkpoint 开始新的论文集合，使用
`--resume-after-checkpoint ABS --resume-after-export ABS`；partial 不能当作续跑 checkpoint。
分类 `--concurrency 1–3` 默认 1。特殊来源重做须使用独立 UUID，并显式给出 `--only-paper-ids ID,...`。

## 会议来源升级后的结果选择

`conference-process.js --source-upgrade-promote --plan-sha SHA` 提供三种互斥选择：

- 不传选择参数时，只有全体成员都已升级且状态为已完成（`complete`），才能采用升级结果；原来未完成的论文只要缺少升级结果就拒绝。
- `--preserve-original-complete` 优先保留原结果：原来已完成的论文全部采用原始结果，忽略扫描到的升级结果。
- `--prefer-upgrade` 优先采用升级结果：升级后已完成的论文采用升级结果，其余原来已完成的论文采用原结果。

同时提供后两个参数时，命令会报告用法错误。升级优先的凭证还记录 `preferUpgrade`、`upgradedPaperIds`
和 `preservedOriginalCompletePaperIds`，供再次核验。结果已提升（`promoted`）的进程只能查看 `--status`
或发布；再次执行 `--apply` 会抛出 `CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED`。保留原结果时，旧来源证明
`sourceProof` 也须保持原样，不能改成尚未核验的升级来源。
