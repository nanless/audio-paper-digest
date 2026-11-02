# 2026年11月2日文档与提示词审查

本轮按新建的 [clear-technical-writing skill](../skills/clear-technical-writing/SKILL.md)、[项目写作约定](writing-guide.md)和 [执行约束](../AGENTS.md)，审查当前仓库的全部自有说明文档与现用提示词。修正内容以真实实现和当前用户要求为依据；已发布论文、封存来源、历史费用和原凭证不在改写范围内。

主要问题集中在四处：旧版本验收被写成当前状态，规划能力和已实现功能混在一起，维护说明没有跟上恢复及发布实现，提示词中少数限制存在歧义。修改后继续由其他审查者对照代码复审；准确且清楚的内容保留。

## 范围与判断方法

基线为 `466d14345595a2692c30ed9d9c84f898283e5898`。初始清单包含 371 个已跟踪文本文件：64 份自有说明文档、18 份版本化提示词、262 份受保护许可文本、24 份受保护文本夹具和 3 份执行配置。扩展文件名检查后另纳入根目录 `LICENSE` 与一张文档 SVG，原始清单保留不改。新 skill 的 5 个文件和本报告另行审阅，不冒充原基线文件。

64 份自有文档和 18 份原提示词均有全文阅读记录。文档中的命令、状态、默认值、恢复条件与功能声明，分别对照实际登记、解析器、调用路径和保存守卫；代码中的动态提示词与终端帮助按实际相关函数和相邻解析代码阅读。静态审查不等于重新证明全部运行不变量，也不把旧验收复用写成新一轮实测。

四名执行者按文件分工：主执行者维护 skill 和六份入口文档；流程组负责 23 份运行与维护说明；客户端组负责 33 份两端文档；提示词组负责两份写作说明、18 个模板和版本登记。提示词组复审流程组，客户端组复审提示词组，流程组复审 skill、入口文档及进度提示；主执行者另读全部实际修改差异、复核关键代码依据和三个试写结果。

许可、冻结合同、文本夹具和原提示词按字节保护。初始保护范围中的 291 个文件已与真实基线 Git 内容逐字节比较，包含两份冻结 Manual 合同；补入的根许可证也保持原文。两份旧合同中八处退休链接不原地修订，现行 [Manual 导航](../manual/README.md)解释其历史用途。客户端组另核许可清单和内嵌许可原文，不把版权文本当作待润色文章。

## 新写作 skill 的内容与使用

通用规则分为六个判断：读者需要理解或完成什么；哪些事实与技术身份必须保护；黑话背后是否有具体对象和动作；机制怎样从输入走到输出；条件、数值、归因和确定程度是否齐全；交付状态是否有实际证据。篇幅和格式服从内容，不用缩字数量、禁词命中或检测器分数评价写作。

主文负责选择工作方式，三份参考文件分别展开技术解释、文档与提示词审计、编辑例子及 13 份社区资料的取舍。专业术语保留准确身份并在首次出现时解释；公式、逐字引用、命令、路径、协议字段和原表数据默认保护。通用 skill 不授予模型次数、费用、来源或发布权限。

仓库版本在 `skills/clear-technical-writing/`，本机安装副本在 `~/.codex/skills/clear-technical-writing/`，本次逐文件内容一致。后续需要同步更新安装副本；修改仓库文件不会自动替换本机已安装文件。

三次独立试写分别检查账号切换条件、客户端完成与计划状态、错误率与耗时的数值解释。主执行者复核后均符合来源：HTTP 状态与错误类型的共同条件没有丢失；未核验和计划项没有写成完成；20% 至 15% 正确解释为 5 个百分点、相对下降 25%，20 ms 至 30 ms 为耗时增加 50%，未检验显著性与没有跨数据集实验的限制保留。这些是明确的合成写作案例，不是论文来源或生产完成证明。

## 已修正的主要问题

### 入口与执行说明

- 六份入口和写作说明接入可复用 skill，区分通用方法与项目的来源、科学、恢复和发布限制。
- 文档导航与新人说明明确日更持续不生图，不逐批重新询问；原论文配图仍按正常来源和图片审查处理。
- 新人说明补清推送预览会拒绝审查清单外改动；预览不能替代正式凭证或远端核验，也不要求清除他人的工作。
- AGENTS 与操作手册的长会议章节增加任务小标题，原操作约束段落保留原文。
- 轻量进度显示改称“发布收尾”，建议进入日更正常收尾入口，不再建议准备生图，并明说轻量查询不核验豁免。

### 流程文档的逐项发现

- **PIPE-001**：收尾工具说明仍宣传图片准备，与当前只提示规划和登记不生图的实现不符。 位置：[docs/maintenance.md](../docs/maintenance.md)。依据：[scripts/publish-finish.js](../scripts/publish-finish.js) 第 74 行。
- **PIPE-002**：把可配置的默认 120 秒写成最长 120 秒，并把有限标题检查写成准确标题核验。 位置：[docs/maintenance.md](../docs/maintenance.md)。依据：[scripts/verify-web.js](../scripts/verify-web.js) 第 331 行；[scripts/verify-web.js](../scripts/verify-web.js) 第 140 行。
- **PIPE-003**：通用验收说明遗漏日更持续不生图设置。 位置：[docs/daily-performance.md](../docs/daily-performance.md)。依据：[run-daily-digest.sh](../run-daily-digest.sh) 第 203 行；[scripts/waive-post-publish-visuals.js](../scripts/waive-post-publish-visuals.js) 第 1 行。
- **PIPE-004**：OAI 恢复示例仍把不生图写成每次单独取消。 位置：[docs/daily-fetch-boundary.md](../docs/daily-fetch-boundary.md)。依据：[run-daily-digest.sh](../run-daily-digest.sh) 第 94 行；[run-daily-digest.sh](../run-daily-digest.sh) 第 203 行。
- **PIPE-005**：独立授权表述可能导致在已有持续授权下反复询问。 位置：[manual/README.md](../manual/README.md)。依据：[AGENTS.md](../AGENTS.md) 第 9 行；[docs/reader-explicit-retry.md](../docs/reader-explicit-retry.md) 第 5 行。
- **PIPE-006**：两份冻结合同有八处指向退休位置的旧链接；保留合同原文，从现行导航解释。 位置：[manual/docs/editorial-reference-contract.md](../manual/docs/editorial-reference-contract.md)。依据：[manual/README.md](../manual/README.md) 第 5 行；[manual/README.md](../manual/README.md) 第 11 行。
- **PIPE-007**：索引把筛选写在已发布去重前；实际先去重。 位置：[scripts/README.md](../scripts/README.md)。依据：[scripts/full-fetch.js](../scripts/full-fetch.js) 第 1923 行；[scripts/full-fetch.js](../scripts/full-fetch.js) 第 1984 行；[scripts/publish-finish.js](../scripts/publish-finish.js) 第 74 行。
- **PIPE-008**：旧聚合接口禁用描述容易被推广为现行会议不可发布。 位置：[scripts/README.md](../scripts/README.md)。依据：[scripts/lib/conference-run.js](../scripts/lib/conference-run.js) 第 472 行。
- **PIPE-009**：获取全文表述未区分恢复仅读本批封存源。 位置：[scripts/README.md](../scripts/README.md)。依据：[scripts/lib/daily-fresh-source-plan.js](../scripts/lib/daily-fresh-source-plan.js) 第 366 行；[scripts/lib/daily-fresh-source-plan.js](../scripts/lib/daily-fresh-source-plan.js) 第 376 行。
- **PIPE-010**：未区分说明与实现修改的验证范围。 位置：[docs/maintenance.md](../docs/maintenance.md)。依据：[AGENTS.md](../AGENTS.md) 第 16 行。
- **PIPE-011**：重复安装的cp可覆盖已有配置。 位置：[docs/setup.md](../docs/setup.md)。依据：[scripts/env-loader.js](../scripts/env-loader.js) 第 157 行。
- **PIPE-012**：文档仍说目录有更具体节点触发告警，与两端null/None不符。 位置：[docs/tag-system-design.md](../docs/tag-system-design.md)。依据：[scripts/lib/tag-rules.js](../scripts/lib/tag-rules.js) 第 159 行；[scripts/utils.py](../scripts/utils.py) 第 283 行。
- **PIPE-013**：阶段列表把Reader写在评分和标签前。 位置：[docs/three-workflows.md](../docs/three-workflows.md)。依据：[scripts/deep-analyzer.js](../scripts/deep-analyzer.js) 第 18728 行；[scripts/deep-analyzer.js](../scripts/deep-analyzer.js) 第 18878 行；[scripts/deep-analyzer.js](../scripts/deep-analyzer.js) 第 18906 行。
- **PIPE-014**：最终视觉范围没有区分日更持续设置和其他流程处置。 位置：[docs/workflow-sharing-plan.md](../docs/workflow-sharing-plan.md)。依据：[scripts/lib/analysis-failure-rounds.js](../scripts/lib/analysis-failure-rounds.js) 第 134 行；[scripts/analysis-engine.js](../scripts/analysis-engine.js) 第 2003 行；[run-daily-digest.sh](../run-daily-digest.sh) 第 203 行。
- **PIPE-015**：本次已授权模板升级后当前引用仍v6/v9。 位置：[docs/maintenance.md](../docs/maintenance.md)。依据：[scripts/lib/prompt-text-versions.js](../scripts/lib/prompt-text-versions.js) 第 173 行；[scripts/lib/prompt-text-versions.js](../scripts/lib/prompt-text-versions.js) 第 177 行。
- **PIPE-016**：新严格DOM投影的来源冷核与组件范围未说明。 位置：[docs/data-format.md](../docs/data-format.md)。依据：[scripts/lib/reader-table-pdf-evidence.js](../scripts/lib/reader-table-pdf-evidence.js) 第 128 行；[scripts/lib/reader-source-display.js](../scripts/lib/reader-source-display.js) 第 4 行。
- **PIPE-017**：新分析授权标题可能误读为须逐篇再次询问。 位置：[docs/conference-workflow.md](../docs/conference-workflow.md)。依据：[scripts/conference-process.js](../scripts/conference-process.js) 第 11 行；[scripts/migrate-conference-process.js](../scripts/migrate-conference-process.js) 第 15 行；[scripts/lib/conference-run.js](../scripts/lib/conference-run.js) 第 472 行。
- **PIPE-018**：轻量watch不读豁免，默认不生图仍可能显示视觉待办；原文已说明不核验。 位置：[docs/maintenance.md](../docs/maintenance.md)。依据：[scripts/lib/digest-live-status.js](../scripts/lib/digest-live-status.js) 第 481 行；[scripts/digest-run-report.js](../scripts/digest-run-report.js) 第 87 行。

交叉复审的三个新增问题修后已由原复审者复核：

- **PIPE-019**：当前 Reader 没有固定五列门槛，普通表数按可用证据在 2–4 张内确定。改正 [数据格式](data-format.md)，原宽表例外只保留为历史解释。依据：[Reader 合同](../scripts/lib/reader-contract.js)。
- **PIPE-020**：最终 URL 比较先去查询串、片段及尾斜杠，不是逐字节精确等式。[维护说明](maintenance.md)和[脚本索引](../scripts/README.md)已限定其能力。依据：[网页核验实现](../scripts/verify-web.js)。
- **PIPE-021**：现行标签设计导航仍链接已退休的主分析 v6，已改指当前 v7；原调查样本与历史结论不改。依据：[版本登记](../scripts/lib/prompt-text-versions.js)。

### 客户端文档的逐项发现

- **CLIENTS-01**：个人研究在本机管理不保证本机推理，补远程发送材料和仅文字能力。 位置：[docs/android-app-plan.md](../docs/android-app-plan.md)。依据：[apps/android/app/src/main/java/com/nanless/paperdigest/model/StudyService.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/model/StudyService.kt) 第 49 行。
- **CLIENTS-02**：PDFBox用于各版本文字提取/兼容查找及加密显示，不只旧系统。 位置：[docs/android-app-plan.md](../docs/android-app-plan.md)。依据：[apps/android/app/src/main/java/com/nanless/paperdigest/pdf/PdfRepository.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/pdf/PdfRepository.kt) 第 102 行；[apps/android/app/src/main/java/com/nanless/paperdigest/pdf/PdfReaderPane.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/pdf/PdfReaderPane.kt) 第 183 行。
- **CLIENTS-03**：消除把个人模型一律写成本机模型的歧义。 位置：[docs/android-zotero-research.md](../docs/android-zotero-research.md)。依据：[apps/android/app/src/main/java/com/nanless/paperdigest/model/StudyService.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/model/StudyService.kt) 第 49 行。
- **CLIENTS-04**：完整目录图补独立传输暂存，明确只有研究树进入备份。 位置：[docs/android-cloud-contract.md](../docs/android-cloud-contract.md)。依据：[apps/android/app/src/main/java/com/nanless/paperdigest/RootController.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/RootController.kt) 第 80 行。
- **CLIENTS-05**：改陈旧当前版本导航，保留1.1.0历史和备份复用限制。 位置：[docs/android-cloud-contract.md](../docs/android-cloud-contract.md)。依据：[apps/macos/Info.plist](../apps/macos/Info.plist) 第 12 行；[apps/android/app/build.gradle.kts](../apps/android/app/build.gradle.kts) 第 9 行。
- **CLIENTS-06**：笼统关闭明文与实际回环模型例外不符，明确只放行回环。 位置：[docs/android-feature-parity.md](../docs/android-feature-parity.md)。依据：[apps/android/app/src/main/res/xml/network_security_config.xml](../apps/android/app/src/main/res/xml/network_security_config.xml) 第 1 行；[apps/android/app/src/main/java/com/nanless/paperdigest/data/SafeHttp.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/data/SafeHttp.kt) 第 55 行。
- **CLIENTS-07**：旧审计表缺历史标记易误认为现行版本；保留当时扫描结论并加当前导航。 位置：[docs/client-security-audit.md](../docs/client-security-audit.md)。依据：[apps/macos/Info.plist](../apps/macos/Info.plist) 第 12 行；[apps/android/app/build.gradle.kts](../apps/android/app/build.gradle.kts) 第 9 行。
- **CLIENTS-08**：规划混用原型和现行引擎；加状态表及实现/后续图像能力边界。 位置：[docs/desktop-research-workbench-plan.md](../docs/desktop-research-workbench-plan.md)。依据：[apps/macos/Sources/ModelService.swift](../apps/macos/Sources/ModelService.swift) 第 80 行；[apps/android/app/src/main/java/com/nanless/paperdigest/pdf/PdfReaderPane.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/pdf/PdfReaderPane.kt) 第 183 行。
- **CLIENTS-09**：不存在已实现Zotero9兼容插件；保留后续设计并说明手动引用导入不是完整归档。 位置：[docs/desktop-research-workbench-plan.md](../docs/desktop-research-workbench-plan.md)。依据：[apps/macos/Sources/ZoteroService.swift](../apps/macos/Sources/ZoteroService.swift) 第 75 行。
- **CLIENTS-10**：现行适配导航误指尚未实现desktop/v1，分别链接现行实现与未来合同。 位置：[docs/mac-app-acceptance.md](../docs/mac-app-acceptance.md)。依据：[apps/macos/Sources/LibraryService.swift](../apps/macos/Sources/LibraryService.swift) 第 305 行。
- **CLIENTS-11**：Zotero 的真实授权和文库写入属于原版本证据；1.3.0 只复用未变服务，没有重新写入真实文库。 位置：[docs/mac-app-zotero.md](../docs/mac-app-zotero.md)。公开依据：[Mac 验证范围](mac-app-validation.md)与[1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)。
- **CLIENTS-12**：1.3.0 正式窗口和系统辅助功能树的增量检查，不等于重新完成全部 VoiceOver 遍历。 位置：[docs/macos-interface-design-research.md](../docs/macos-interface-design-research.md)。公开依据：[Mac 验证范围](mac-app-validation.md)与[1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)。
- **CLIENTS-13**：图标与 ICNS 静态检查不证明 Finder、Dock 实际显示已测；分别标明历史和新包操作范围。 位置：[docs/mac-app-icon-design.md](../docs/mac-app-icon-design.md)。公开依据：[Mac 验证范围](mac-app-validation.md)与[1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)。
- **CLIENTS-14**：1.0.1 准备包当时未图形启动，1.3.0 正式包另有窗口与升级记录；不能混为同一状态。 位置：[docs/mac-app-review-log.md](../docs/mac-app-review-log.md)。公开依据：[Mac 验证范围](mac-app-validation.md)与[1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)。
- **CLIENTS-15**：完整测试含固定Chrome路径，不能承诺Chromium安装/PD_MAC_BROWSER覆盖所有入口。 位置：[apps/macos/README.md](../apps/macos/README.md)。依据：[apps/macos/Tests/DesktopFontContinuity.test.cjs](../apps/macos/Tests/DesktopFontContinuity.test.cjs) 第 14 行；[apps/macos/test.sh](../apps/macos/test.sh) 第 59 行。
- **CLIENTS-16**：按现有锁文件安装，补与固定Playwright版本匹配的Chromium准备入口。 位置：[prototypes/macos-research/README.md](../prototypes/macos-research/README.md)。依据：[prototypes/macos-research/package-lock.json](../prototypes/macos-research/package-lock.json) 第 4 行；[prototypes/macos-research/smoke.mjs](../prototypes/macos-research/smoke.mjs) 第 12 行。
- **CLIENTS-17**：原11至15行被空行割裂成非表格；只删除间隔空行，逐行原字节和历史断言保留。 位置：[docs/workbench-usability-review-20261101.md](../docs/workbench-usability-review-20261101.md)。依据：[docs/workbench-usability-review-20261101.md](../docs/workbench-usability-review-20261101.md) 第 35 行。

客户端只修正文档。PDF 引擎、模型材料发送范围、网络回环例外和安装条件按实际代码说明；旧版本的安装、窗口、真实账户与备份验收保留各自范围。没有重新启动应用或访问真实文库来制造新的通过记录。

### 提示词与 Reader 说明的逐项发现

- **P-DOC-001**：只列两种source-cell-math-display，遗漏实际同系数/指数/精度科学计数双写kind。 说明文字已按真实代码同步，未改校验器。 依据：[scripts/lib/source-cell-math-display.js](../scripts/lib/source-cell-math-display.js) 第 18 行；[scripts/lib/reader-table-pdf-evidence.js](../scripts/lib/reader-table-pdf-evidence.js) 第 184 行。
- **P-DOC-002**：表格写作路线仅突出selection与连续引文，未清楚区分现成completeTable和独立pdfSourceQuotes；复杂表的入口容易误解。 说明文字已按真实代码同步，未改校验器。 依据：[原 Reader v9](https://github.com/nanless/audio-paper-digest/blob/466d14345595a2692c30ed9d9c84f898283e5898/prompts/api-reader-article-v9.md#L99) 第 99 行；[scripts/lib/reader-repair.js](../scripts/lib/reader-repair.js) 第 3214 行；[scripts/deep-analyzer.js](../scripts/deep-analyzer.js) 第 2320 行。
- **P-TEXT-003**：核心摘要只提取最重要1–2个结果数字可能被误读为限制比较对或成本数字；同段仍要求对象与范围。 主分析新v7，只改一句并验证所有其它原字节相同。 依据：[prompts/core-summary-repair-v7.md](../prompts/core-summary-repair-v7.md) 第 39 行；[scripts/analysis-contract.js](../scripts/analysis-contract.js) 第 1 行。
- **P-TEXT-004**：四种表型限定字段为HTML引文版，未说明只有运行时真实PDF全文证据明确提供时，恢复可额外含pdfSourceQuotes；当前修复动态协议已独立说明，不能把该能力泛化到首次请求。 Reader新v10，3处限定消歧，HTML/常规全文与独立PDF分开，不授新scope。 依据：[scripts/lib/reader-repair.js](../scripts/lib/reader-repair.js) 第 3214 行；[scripts/lib/reader-repair.js](../scripts/lib/reader-repair.js) 第 3304 行；[scripts/deep-analyzer.js](../scripts/deep-analyzer.js) 第 2320 行。
- **P-DOC-005**：数值、资源、图像、核心摘要规则按历史案例不断追加，重复限定掩盖一般规则，部分短段是技术碎片。 保留全部历史案例约束；按表格选择任务组织一般路线，并将同一恢复动作/设置判据的碎段接成连续段落。 依据：[docs/reader-writing.md](../docs/reader-writing.md) 第 240 行；[docs/reader-writing.md](../docs/reader-writing.md) 第 274 行；[docs/reader-writing.md](../docs/reader-writing.md) 第 300 行。

## 提示词升级与原记录保护

仅升级两份模板。主分析从 v6 到 v7，把“1–2 个结果数字”改为“1–2 组关键结果”，明确保留比较双方、单位、精度、条件和必要成本。Reader 从 v9 到 v10，区分常规全文引文与独立 PDF 原字符引文；后者同时要求本次真实提供材料、当前恢复明确允许，字段存在或过去的证明不产生权限。

原 v6/v9 的真实 Git blob、原路径、整文件及模板 SHA 进入退休登记，原记录继续从 Git 读取原字节。其余 16 个模板逐字不变，工作树仍只有 18 个现用模板。对应读取器保留旧合同，不给旧稿补签新版本；输出结构、占位符、来源核验、预算及历史次数不因这次文字澄清放宽。

选定全阶段重分析入口只同步两个当前模板路径。相关测试同步当前版本断言，另保留对旧路径、旧指纹、错误 SHA 和未知合同的检查；没有把历史恢复用例全量替换成新版本。

## 代码中的提示词与终端帮助

模板之外，提示词组定位并阅读了 25 个相关代码文件的实际构造、发送或受控准备路径：日更与会议筛选、共享主分析、Reader 及各类定向修复、Python 正文与逐图审查、可选图片准备、最小账号诊断、旧 Manual 只读记录，以及两端个人研究。可选图片准备代码保留原有受控用途，不在默认日更中执行；没有为了本次审查调用模型。

两端个人研究当前只发送提取文字，系统指令要求区分事实、推断和未证实内容，保留数值、条件、否定及局限，并定位物理页。客户端组独立核对构造与实际发送路径，未发现需要本次修改的提示词问题，原研究记录和身份保持不变。

流程组另枚举 101 个非测试 npm 别名、82 个唯一脚本，阅读实际帮助块及相邻参数解析；委托入口继续追到真实解析器。这项范围不声称通读 82 份完整实现。五类帮助或注释已修正，并由提示词组独立复核：

- **PIPE-022**：独立人工审查的说明不再局限于模型服务不可用，强调真实逐页与逐图记录和完整程序检查。
- **PIPE-023**：会议提取注释明确新会议的 daily 包装与旧直接入口各自的角色检查。
- **PIPE-024**：来源探测不再建议用 OAI 绕过尚未生成的目标日公告，仍须等待并核验公告覆盖。
- **PIPE-025**：恢复工具帮助补出已有的可选日期和 `--strict`。
- **PIPE-026**：网页核验帮助补出已有的等待、轮询和请求超时参数。

这些修改只涉及说明文字与注释，参数解析、来源、角色、恢复和发布条件保持原实现。

## 完整验收发现的遗漏与修复

首轮完整工程检查和远端 CI 发现了定向审查遗漏的问题。原失败日志与该提交的 CI 结果保留，不将它们改写为通过；修正内容经另一位执行者复核后，交由新的最终提交接受完整检查。

- Python 的现用模板清单漏同步了主分析 v7 和 Reader v10。现已只更新这两条当前路径，并以现有跨语言清单检查和新增旧 Git 原字节、错误 SHA 拒绝测试核验；旧路径读取保持原样。
- 文档测试仍以“只有……明确”的固定措辞判断授权。现改为检查持续授权、无需逐篇再问、来源与失败记录保留，以及人工建议不增加机器权限，原退役入口检查继续保留。
- 一项语义表格测试把旧模板 SHA 配上当前 v10 路径。现把旧 v9/v13 路径与当前生成路径分别绑定，保留原 SHA 和当前语义要求。
- 一项隔离仓库测试没有导入刚退休的真实 Git 对象。现从登记的原 Git 对象读取、核对完整 SHA 后补入测试仓库，原付费夹具不改，文件写入仍限制在隔离目录。
- 一项坏 JSON 渲染测试拿当前 v10 输出与历史 v9 原请求比较。现显式重建原 v9，保留原长度和发送 SHA；另测当前 v10 只替换诊断视图、保全来源并满足原上下文上限。
- 两组付费恢复测试原本验证“只变实现”，却通过当前登记同时改变了模板。现历史场景明确原 v9 上下文；另以真实 v10 输入证明正常守卫仍拒绝未经恢复授权的模板迁移，原候选、次数和费用字节不变。

修后定向结果为文档 6 项、语义表格 5 项、隔离仓库事实检查 10 项、JSON 渲染 35 项、两组付费恢复 29 项和 Python 证据 5 项通过。生产代码在这次修复中只补同步 Python 的两条现用路径，没有新增跳过检查、重签旧稿或清零次数的入口。新 skill 的审计参考也补入跨语言登记互核与隔离测试历史对象保护的检查方法。

## 各文件的处理结论

下面记录原 64 份自有文档的归属、改动或保留理由及主要实现依据。链接指向当前文件；行号和逐文件修改前后 SHA 保存在运行证据中。

### 入口和写作约定

- [AGENTS.md](../AGENTS.md)：接入通用skill、澄清持续不生图与预览范围，或增加任务导航；既有准确科学与执行限制保留。
- [README.md](../README.md)：接入通用skill、澄清持续不生图与预览范围，或增加任务导航；既有准确科学与执行限制保留。
- [SKILL.md](../SKILL.md)：接入通用skill、澄清持续不生图与预览范围，或增加任务导航；既有准确科学与执行限制保留。
- [docs/README.md](../docs/README.md)：接入通用skill、澄清持续不生图与预览范围，或增加任务导航；既有准确科学与执行限制保留。
- [docs/onboarding.md](../docs/onboarding.md)：接入通用skill、澄清持续不生图与预览范围，或增加任务导航；既有准确科学与执行限制保留。
- [docs/writing-guide.md](../docs/writing-guide.md)：接入通用skill、澄清持续不生图与预览范围，或增加任务导航；既有准确科学与执行限制保留。

### 运行和维护

- [docs/analysis-stop.md](../docs/analysis-stop.md)：当前关键说明与所列实现一致；未发现需改项，保留内容。 依据：[scripts/lib/analysis-stop-control.js](../scripts/lib/analysis-stop-control.js) 第 1 行；[scripts/analysis-engine.js](../scripts/analysis-engine.js) 第 1981 行。
- [docs/daily-fetch-boundary.md](../docs/daily-fetch-boundary.md)：修正文实差异或本次当前模板引用；操作条件与来源/费用约束保留。 依据：[scripts/lib/daily-fetch-boundary.js](../scripts/lib/daily-fetch-boundary.js) 第 47 行；[scripts/lib/daily-fetch-boundary.js](../scripts/lib/daily-fetch-boundary.js) 第 303 行。
- [docs/daily-performance.md](../docs/daily-performance.md)：修正文实差异或本次当前模板引用；操作条件与来源/费用约束保留。 依据：[scripts/lib/analysis-failure-rounds.js](../scripts/lib/analysis-failure-rounds.js) 第 134 行；[scripts/analysis-engine.js](../scripts/analysis-engine.js) 第 2003 行；[scripts/lib/daily-fresh-source-plan.js](../scripts/lib/daily-fresh-source-plan.js) 第 366 行。
- [docs/data-format.md](../docs/data-format.md)：修正文实差异或本次当前模板引用；操作条件与来源/费用约束保留。 依据：[scripts/lib/daily-fresh-source-plan.js](../scripts/lib/daily-fresh-source-plan.js) 第 366 行；[scripts/lib/daily-fresh-source-plan.js](../scripts/lib/daily-fresh-source-plan.js) 第 376 行；[run-daily-digest.sh](../run-daily-digest.sh) 第 203 行。
- [docs/locked-source-validation.md](../docs/locked-source-validation.md)：当前关键说明与所列实现一致；未发现需改项，保留内容。 依据：[scripts/lib/daily-fresh-source-plan.js](../scripts/lib/daily-fresh-source-plan.js) 第 366 行；[scripts/lib/daily-fresh-source-plan.js](../scripts/lib/daily-fresh-source-plan.js) 第 376 行。
- [docs/maintenance.md](../docs/maintenance.md)：修正文实差异或本次当前模板引用；操作条件与来源/费用约束保留。 依据：[scripts/verify-web.js](../scripts/verify-web.js) 第 139 行；[scripts/publish-finish.js](../scripts/publish-finish.js) 第 74 行；[scripts/lib/prompt-text-versions.js](../scripts/lib/prompt-text-versions.js) 第 173 行。
- [docs/setup.md](../docs/setup.md)：修正文实差异或本次当前模板引用；操作条件与来源/费用约束保留。 依据：[scripts/python-runtime.sh](../scripts/python-runtime.sh) 第 6 行；[scripts/config.js](../scripts/config.js) 第 101 行。
- [docs/troubleshooting.md](../docs/troubleshooting.md)：当前关键说明与所列实现一致；未发现需改项，保留内容。 依据：[scripts/llm-account-pool.js](../scripts/llm-account-pool.js) 第 774 行；[scripts/lib/llm-response-recovery.js](../scripts/lib/llm-response-recovery.js) 第 9 行；[scripts/lib/active-time-budget.js](../scripts/lib/active-time-budget.js) 第 4 行。
- [docs/three-workflows.md](../docs/three-workflows.md)：修正文实差异或本次当前模板引用；操作条件与来源/费用约束保留。 依据：[scripts/lib/analysis-failure-rounds.js](../scripts/lib/analysis-failure-rounds.js) 第 134 行；[scripts/analysis-engine.js](../scripts/analysis-engine.js) 第 2003 行；[scripts/lib/daily-fresh-source-plan.js](../scripts/lib/daily-fresh-source-plan.js) 第 366 行。
- [docs/conference-workflow.md](../docs/conference-workflow.md)：修正文实差异或本次当前模板引用；操作条件与来源/费用约束保留。 依据：[scripts/conference-process.js](../scripts/conference-process.js) 第 11 行；[scripts/migrate-conference-process.js](../scripts/migrate-conference-process.js) 第 15 行；[scripts/lib/conference-run.js](../scripts/lib/conference-run.js) 第 472 行。
- [docs/history-direct-publication.md](../docs/history-direct-publication.md)：当前关键说明与所列实现一致；未发现需改项，保留内容。 依据：[scripts/historical-direct-publication.js](../scripts/historical-direct-publication.js) 第 11 行；[scripts/lib/historical-direct-publication.js](../scripts/lib/historical-direct-publication.js) 第 194 行。
- [docs/history-rewrite.md](../docs/history-rewrite.md)：当前关键说明与所列实现一致；未发现需改项，保留内容。 依据：[scripts/lib/historical-direct-rewrite-runner.js](../scripts/lib/historical-direct-rewrite-runner.js) 第 57 行；[scripts/lib/fresh-arxiv-rewrite-source.js](../scripts/lib/fresh-arxiv-rewrite-source.js) 第 309 行。
- [docs/reader-explicit-retry.md](../docs/reader-explicit-retry.md)：当前关键说明与所列实现一致；未发现需改项，保留内容。 依据：[scripts/lib/explicit-reader-retry-round.js](../scripts/lib/explicit-reader-retry-round.js) 第 8 行；[scripts/lib/reader-target-ordinal-patch.js](../scripts/lib/reader-target-ordinal-patch.js) 第 466 行；[scripts/lib/daily-reader-operator-correction.js](../scripts/lib/daily-reader-operator-correction.js) 第 190 行。
- [docs/compatibility.md](../docs/compatibility.md)：当前关键说明与所列实现一致；未发现需改项，保留内容。 依据：[scripts/lib/prompt-text-versions.js](../scripts/lib/prompt-text-versions.js) 第 219 行；[scripts/lib/tag-rules.js](../scripts/lib/tag-rules.js) 第 159 行。
- [docs/repository-maintenance-review.md](../docs/repository-maintenance-review.md)：当前关键说明与所列实现一致；未发现需改项，保留内容。 依据：[scripts/lib/workflow-implementation-files.js](../scripts/lib/workflow-implementation-files.js) 第 17 行；[scripts/manual_agent_policy.py](../scripts/manual_agent_policy.py) 第 3 行。
- [docs/shared-workflow-review.md](../docs/shared-workflow-review.md)：当前关键说明与所列实现一致；未发现需改项，保留内容。 依据：[scripts/lib/reader-pdf-extraction-scope.js](../scripts/lib/reader-pdf-extraction-scope.js) 第 18 行；[scripts/lib/python-json-packet-bridge.js](../scripts/lib/python-json-packet-bridge.js) 第 1 行。
- [docs/workflow-sharing-plan.md](../docs/workflow-sharing-plan.md)：修正文实差异或本次当前模板引用；操作条件与来源/费用约束保留。 依据：[scripts/lib/analysis-failure-rounds.js](../scripts/lib/analysis-failure-rounds.js) 第 134 行；[scripts/analysis-engine.js](../scripts/analysis-engine.js) 第 2003 行；[run-daily-digest.sh](../run-daily-digest.sh) 第 203 行。
- [docs/tag-display-policy.md](../docs/tag-display-policy.md)：当前关键说明与所列实现一致；未发现需改项，保留内容。 依据：[scripts/tag_presentation.py](../scripts/tag_presentation.py) 第 40 行；[scripts/tag_catalog_publication.py](../scripts/tag_catalog_publication.py) 第 1 行。
- [docs/tag-system-design.md](../docs/tag-system-design.md)：修正文实差异或本次当前模板引用；操作条件与来源/费用约束保留。 依据：[scripts/lib/tag-rules.js](../scripts/lib/tag-rules.js) 第 159 行；[scripts/utils.py](../scripts/utils.py) 第 283 行。
- [scripts/README.md](../scripts/README.md)：修正文实差异或本次当前模板引用；操作条件与来源/费用约束保留。 依据：[scripts/full-fetch.js](../scripts/full-fetch.js) 第 1923 行；[scripts/full-fetch.js](../scripts/full-fetch.js) 第 1984 行；[scripts/publish-finish.js](../scripts/publish-finish.js) 第 74 行。
- [manual/README.md](../manual/README.md)：修正文实差异或本次当前模板引用；操作条件与来源/费用约束保留。 依据：[scripts/manual_agent_policy.py](../scripts/manual_agent_policy.py) 第 3 行；[scripts/lib/prompt-text-versions.js](../scripts/lib/prompt-text-versions.js) 第 219 行。
- [manual/docs/editorial-reference-contract-v2.md](../manual/docs/editorial-reference-contract-v2.md)：冻结旧合同证据：保留原字节和8个历史断链，由现行manual导航解释。 依据：[manual/README.md](../manual/README.md) 第 11 行。
- [manual/docs/editorial-reference-contract.md](../manual/docs/editorial-reference-contract.md)：冻结旧合同证据：保留原字节和8个历史断链，由现行manual导航解释。 依据：[manual/README.md](../manual/README.md) 第 11 行。

### 客户端与原型

- [apps/android/README.md](../apps/android/README.md)：源码版本、SDK/ABI、设备选择、调试/正式通道与当前代码一致；保留明确的设备预核对要求。 依据：[apps/android/app/build.gradle.kts](../apps/android/app/build.gradle.kts) 第 9 行；[apps/android/test.sh](../apps/android/test.sh) 第 7 行；[apps/android/install.sh](../apps/android/install.sh) 第 13 行。
- [apps/android/licenses.README.md](../apps/android/licenses.README.md)：123解析记录、120物料、632许可文件及固定SHA与真实清单一致；许可原文只读核字节。 依据：[apps/android/prepare-assets.mjs](../apps/android/prepare-assets.mjs) 第 9 行；[apps/android/prepare-assets.mjs](../apps/android/prepare-assets.mjs) 第 21 行。
- [apps/macos/Assets/README.md](../apps/macos/Assets/README.md)：PNG源和10层ICNS构建描述与脚本一致；未新增视觉验收。 依据：[apps/macos/build.sh](../apps/macos/build.sh) 第 98 行；[apps/macos/build.sh](../apps/macos/build.sh) 第 100 行。
- [apps/macos/README.md](../apps/macos/README.md)：更正完整测试的Google Chrome前提；Node版本、release/private-qa及安装拒绝活进程的限制保留。 依据：[apps/macos/Info.plist](../apps/macos/Info.plist) 第 12 行；[apps/macos/test.sh](../apps/macos/test.sh) 第 59 行；[apps/macos/Tests/DesktopFontContinuity.test.cjs](../apps/macos/Tests/DesktopFontContinuity.test.cjs) 第 14 行。
- [docs/android-app-plan.md](../docs/android-app-plan.md)：纠正远程/本机模型含义和PDFBox范围；两端生命周期与共同资料格式分别说明。 依据：[apps/android/app/src/main/java/com/nanless/paperdigest/model/StudyService.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/model/StudyService.kt) 第 49 行；[apps/android/app/src/main/java/com/nanless/paperdigest/pdf/PdfRepository.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/pdf/PdfRepository.kt) 第 102 行；[apps/android/app/src/main/java/com/nanless/paperdigest/pdf/PdfReaderPane.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/pdf/PdfReaderPane.kt) 第 183 行。
- [docs/android-cloud-contract.md](../docs/android-cloud-contract.md)：补传输暂存独立树，修正陈旧版本导航；所有字段、大小和固定示例未改。 依据：[apps/android/app/src/main/java/com/nanless/paperdigest/cloud/BackupCodec.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/cloud/BackupCodec.kt) 第 19 行；[apps/android/app/src/main/java/com/nanless/paperdigest/RootController.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/RootController.kt) 第 80 行；[apps/macos/Sources/BackupCodec.swift](../apps/macos/Sources/BackupCodec.swift) 第 138 行。
- [docs/android-cloud-portable-fixtures.md](../docs/android-cloud-portable-fixtures.md)：固定P01/P02代码块、SHA及原样向量保持；测试规格与已执行结果已有区分。 依据：[apps/android/app/src/test/fixtures/GenerateOfflineFixtures.swift](../apps/android/app/src/test/fixtures/GenerateOfflineFixtures.swift) 第 1 行；[apps/android/app/src/test/fixtures/VerifyAndroidOfflinePacket.swift](../apps/android/app/src/test/fixtures/VerifyAndroidOfflinePacket.swift) 第 1 行。
- [docs/android-feature-parity.md](../docs/android-feature-parity.md)：纠正回环HTTP例外；86原ID、历史结果和新版本增量边界未改。 依据：[apps/android/app/src/main/res/xml/network_security_config.xml](../apps/android/app/src/main/res/xml/network_security_config.xml) 第 1 行；[apps/android/app/src/main/java/com/nanless/paperdigest/data/SafeHttp.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/data/SafeHttp.kt) 第 55 行。
- [docs/android-validation.md](../docs/android-validation.md)：1.3.0版本与保存下载证据一致；API35/最低API28/实体机与历史真实服务区别明确，保留未重测限制。 依据：[apps/android/app/build.gradle.kts](../apps/android/app/build.gradle.kts) 第 9 行；本机保存的原始验收记录，公开范围见 [1.3.0 发行与升级检查](workbench-1.3.0-review.md#正式发行与升级检查)。
- [docs/android-zotero-research.md](../docs/android-zotero-research.md)：将本机模型改为自己配置的模型服务；Web API、本地API与官方客户端历史验收范围保留。 依据：[apps/android/app/src/main/java/com/nanless/paperdigest/model/StudyService.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/model/StudyService.kt) 第 49 行；[apps/android/app/src/main/java/com/nanless/paperdigest/zotero/ZoteroMaterials.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/zotero/ZoteroMaterials.kt) 第 1 行。
- [docs/blog-reading-tools.md](../docs/blog-reading-tools.md)：对照独立博客仓库reading-export.js、paper-toolbar.js、citation-source.js与share-tools.js；导出/分享与退役的本机助手、Zotero写入边界一致。
- [docs/client-security-audit.md](../docs/client-security-audit.md)：标清2026-10-29/1.0.1审计范围，增加现行1.3.0导航；没有声称本次重新扫描全部历史/安装资产。 依据：[apps/android/app/src/main/res/xml/network_security_config.xml](../apps/android/app/src/main/res/xml/network_security_config.xml) 第 1 行；[apps/macos/Info.plist](../apps/macos/Info.plist) 第 12 行。
- [docs/desktop-data-contract.md](../docs/desktop-data-contract.md)：desktop/v1始终明确尚未部署；与现行搜索协议、正文适配和专用出口目标分开，未将设计字段当现行数据。 依据：[apps/macos/Sources/LibraryService.swift](../apps/macos/Sources/LibraryService.swift) 第 305 行；[apps/macos/Resources/website-tags/website-tag-core.js](../apps/macos/Resources/website-tags/website-tag-core.js) 第 385 行。
- [docs/desktop-prototype-validation.md](../docs/desktop-prototype-validation.md)：2026-10-24原型历史报告保留；12045字符、15样本、3图、4表、4式、13页由样稿只读核对。未重跑历史测试。 依据：[prototypes/macos-research/sample.json](../prototypes/macos-research/sample.json) 第 1 行；[prototypes/macos-research/smoke.mjs](../prototypes/macos-research/smoke.mjs) 第 14 行。
- [docs/desktop-research-workbench-plan.md](../docs/desktop-research-workbench-plan.md)：新增现行/计划状态表，纠正PDF.js和Zotero9路线，保留图像/OCR/检索的后续设计目标。 依据：[apps/macos/Sources/ModelService.swift](../apps/macos/Sources/ModelService.swift) 第 35 行；[apps/macos/Sources/ZoteroService.swift](../apps/macos/Sources/ZoteroService.swift) 第 75 行；[apps/android/app/src/main/java/com/nanless/paperdigest/pdf/PdfRepository.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/pdf/PdfRepository.kt) 第 102 行。
- [docs/favorite-collections.md](../docs/favorite-collections.md)：核网站分类、同导读组合、增量收藏、真实时间、旧自建字段兼容；冻结JSON例子和边界未改。 依据：[apps/macos/Sources/FavoriteCollections.swift](../apps/macos/Sources/FavoriteCollections.swift) 第 79 行；[apps/macos/Resources/website-tags/website-tag-core.js](../apps/macos/Resources/website-tags/website-tag-core.js) 第 385 行；[apps/android/app/src/main/java/com/nanless/paperdigest/data/FavoriteCollections.kt](../apps/android/app/src/main/java/com/nanless/paperdigest/data/FavoriteCollections.kt) 第 1 行。
- [docs/mac-app-acceptance-status.md](../docs/mac-app-acceptance-status.md)：69原ID与历史1.0.1/新增1.3.0证据已经分清；保留方向键公式滚动、整机睡眠、账户实测等限制。 依据：[apps/macos/test.sh](../apps/macos/test.sh) 第 12 行；本机保存的原始验收记录，公开范围见 [1.3.0 发行与升级检查](workbench-1.3.0-review.md#正式发行与升级检查)。
- [docs/mac-app-acceptance.md](../docs/mac-app-acceptance.md)：现行数据链接指向mac-app-data，desktop/v1另标计划；69要求和失败/受阻判定不变。 依据：[apps/macos/Sources/LibraryService.swift](../apps/macos/Sources/LibraryService.swift) 第 305 行；[apps/macos/Resources/website-tags/website-tag-core.js](../apps/macos/Resources/website-tags/website-tag-core.js) 第 385 行。
- [docs/mac-app-cloud.md](../docs/mac-app-cloud.md)：12云端+5发行ID、512/750MiB/8MiB/自动间隔与代码一致；旧1.0.1矩阵及1.3.0增量分开，整机睡眠未实测仍保留。 依据：[apps/macos/Sources/CloudArchiveService.swift](../apps/macos/Sources/CloudArchiveService.swift) 第 7 行；[apps/macos/Sources/BackupCodec.swift](../apps/macos/Sources/BackupCodec.swift) 第 52 行；[apps/macos/Sources/AppCloud.swift](../apps/macos/Sources/AppCloud.swift) 第 87 行。
- [docs/mac-app-data.md](../docs/mac-app-data.md)：现行公开索引、缓存大小、时效、固定arXiv版本、备份和响应密钥保护与代码一致。 依据：[apps/macos/Sources/LibraryService.swift](../apps/macos/Sources/LibraryService.swift) 第 305 行；[apps/macos/Sources/LibraryService.swift](../apps/macos/Sources/LibraryService.swift) 第 473 行；[apps/macos/Sources/BackupCodec.swift](../apps/macos/Sources/BackupCodec.swift) 第 138 行。
- [docs/mac-app-icon-design.md](../docs/mac-app-icon-design.md)：保留图标身份与构建规则，只澄清历史静态校验与现行窗口/系统呈现不可互代。 依据：[apps/macos/build.sh](../apps/macos/build.sh) 第 98 行；[apps/macos/build.sh](../apps/macos/build.sh) 第 100 行。
- [docs/mac-app-release.md](../docs/mac-app-release.md)：检查实际inspect/prepare/verify、干净提交、固定许可、84/86与仅生成草稿/公开参数，命令与实现一致。未执行构建/签名/远端。 依据：[apps/macos/release_tools.py](../apps/macos/release_tools.py) 第 81 行；[apps/android/release_tools.py](../apps/android/release_tools.py) 第 459 行；[apps/android/release_tools.py](../apps/android/release_tools.py) 第 459 行。
- [docs/mac-app-requirements.md](../docs/mac-app-requirements.md)：现行功能、独立客户端与生产分离、文字模型、个人Zotero与备份限制一致。 依据：[apps/macos/Sources/ModelService.swift](../apps/macos/Sources/ModelService.swift) 第 35 行；[apps/macos/Sources/ZoteroService.swift](../apps/macos/Sources/ZoteroService.swift) 第 12 行；[apps/macos/Info.plist](../apps/macos/Info.plist) 第 12 行。
- [docs/mac-app-review-log.md](../docs/mac-app-review-log.md)：明确1.0.1图形未测是当时状态，导航1.3.0独立正式记录；未将旧服务测试改写为本版新做。 依据：本机保存的原始验收记录，公开范围见 [1.3.0 发行与升级检查](workbench-1.3.0-review.md#正式发行与升级检查)；[apps/macos/Sources/ZoteroService.swift](../apps/macos/Sources/ZoteroService.swift) 第 12 行。
- [docs/mac-app-validation.md](../docs/mac-app-validation.md)：当前1.3.0、build5、a39来源与保存发行证据一致；旧版本、正式窗口、系统树和真实服务边界保留。 依据：[apps/macos/Info.plist](../apps/macos/Info.plist) 第 12 行；本机保存的原始验收记录，公开范围见 [1.3.0 发行与升级检查](workbench-1.3.0-review.md#正式发行与升级检查)。
- [docs/mac-app-zotero.md](../docs/mac-app-zotero.md)：核本机个人库、授权、逐项回读与冲突；补清1.3.0复用旧真实服务证据，没有新增真实文库写入。 依据：[apps/macos/Sources/ZoteroService.swift](../apps/macos/Sources/ZoteroService.swift) 第 75 行；[apps/macos/Sources/ZoteroService.swift](../apps/macos/Sources/ZoteroService.swift) 第 120 行。
- [docs/macos-interface-design-research.md](../docs/macos-interface-design-research.md)：界面、长文与原文职责正确；补清1.0.1历史与1.3.0系统树增量不等于完整VoiceOver重验。 依据：[apps/macos/Sources/Main.swift](../apps/macos/Sources/Main.swift) 第 3 行；[apps/macos/Resources/native.js](../apps/macos/Resources/native.js) 第 1 行。
- [docs/workbench-1.1.0-review.md](../docs/workbench-1.1.0-review.md)：保留bb6来源、1.1.0历史计时、首次失败、正式升级及下载范围；现行代码仍有预载/有界文字预览实现，不追认历史实测。 依据：[apps/macos/Sources/PublishedAggregateStore.swift](../apps/macos/Sources/PublishedAggregateStore.swift) 第 1 行；[apps/macos/Tests/AggregateReadPreview.test.cjs](../apps/macos/Tests/AggregateReadPreview.test.cjs) 第 1 行。
- [docs/workbench-1.2.1-review.md](../docs/workbench-1.2.1-review.md)：保留5712来源、1.2.1六轮与跨端备份四腿原范围、首次35打包失败；未改历史数量或结论。 依据：[apps/macos/Resources/website-tags/website-tag-core.js](../apps/macos/Resources/website-tags/website-tag-core.js) 第 385 行；[tests/fixtures/workbench-website-taxonomy-golden.json](../tests/fixtures/workbench-website-taxonomy-golden.json) 第 1 行。
- [docs/workbench-1.3.0-review.md](../docs/workbench-1.3.0-review.md)：真实本机保存发布证据的release430957237/tagv1.3.0/12附件大小SHA与原文一致；保留三候选、首次AX失败、未新增完整屏幕阅读器和最低API实测限制。 依据：本机保存的原始验收记录，公开范围见 [1.3.0 发行与升级检查](workbench-1.3.0-review.md#正式发行与升级检查)；本机保存的原始验收记录，公开范围见 [1.3.0 发行与升级检查](workbench-1.3.0-review.md#正式发行与升级检查)。
- [docs/workbench-usability-review-20261101.md](../docs/workbench-usability-review-20261101.md)：仅连接15行Markdown表，原每一行事实字节、日期、SHA、数字和验收结论均未改。 依据：[apps/macos/Sources/FavoriteCollections.swift](../apps/macos/Sources/FavoriteCollections.swift) 第 79 行；[apps/android/install.sh](../apps/android/install.sh) 第 13 行。
- [prototypes/macos-research/README.md](../prototypes/macos-research/README.md)：依锁文件改npm ci并给明确Chromium准备命令；原型离线、本机服务、未连接模型/Zotero、真实样稿与正式App区分保留。 依据：[prototypes/macos-research/package.json](../prototypes/macos-research/package.json) 第 11 行；[prototypes/macos-research/smoke.mjs](../prototypes/macos-research/smoke.mjs) 第 12 行；[prototypes/macos-research/prepare_assets.py](../prototypes/macos-research/prepare_assets.py) 第 24 行。
- [prototypes/macos-research/assets/README.md](../prototypes/macos-research/assets/README.md)：资产来源URL与固定MiCLA版本、读取明确路径和图像SHA配方一致；不联网、不改来源或重新生成资产。 依据：[prototypes/macos-research/prepare_assets.py](../prototypes/macos-research/prepare_assets.py) 第 20 行；[prototypes/macos-research/sample.json](../prototypes/macos-research/sample.json) 第 263 行。

### 提示词导航与Reader说明

- [prompts/README.md](../prompts/README.md)：全文审阅后按对应发现同步说明，准确部分保留。
- [docs/reader-writing.md](../docs/reader-writing.md)：全文审阅后按对应发现同步说明，准确部分保留。

### 18份现用提示词

- [prompts/api-reader-article-v10.md](../prompts/api-reader-article-v10.md)：只澄清独立PDF原字符全文与恢复操作明确允许的共同条件；原JSON示例/占位符/其它全部字节不变。
- [prompts/api-reader-concept-terms-v1.md](../prompts/api-reader-concept-terms-v1.md)：仅唯一术语长度阻断，terms叶路径、2–48字符、完整原SHA、既有解释/来源只读；不扩大为概念解释改写。
- [prompts/api-reader-fact-local-v3.md](../prompts/api-reader-fact-local-v3.md)：句子替换JSON的path/oldSHA/claimSHA/start不变；禁换行/表图公式链接；全部错误须实际纠正且句外保护。
- [prompts/api-reader-repair-v13.md](../prompts/api-reader-repair-v13.md)：核对1–8旧SHA绑定目标、原子操作优先、非授权节点保护、术语叶/原句范围；operationProtocol实际附加复杂及PDF来源规则，未发现需要为语言统一升版的冲突。
- [prompts/core-summary-repair-v7.md](../prompts/core-summary-repair-v7.md)：核心摘要单节320–600中文字符/6–9句；同表跨方法同指标比较、完整单位精度和不补算；保护其余12节。
- [prompts/deep-analysis-v7.md](../prompts/deep-analysis-v7.md)：只将结果数字数目消歧为结果组，保护比较值及成本；其余全部字节不变。
- [prompts/digest-cover-v2.md](../prompts/digest-cover-v2.md)：仅用户显式恢复生图才可调用；给定题目/分数/标签/计数原样、最多10篇、独立素材不插博客；当前持续不生图不触发模板变更。
- [prompts/filter-v5.md](../prompts/filter-v5.md)：两行固定结论/解析兼容；实际声音方法或评测优先，音乐动作输入及说话人错误/口语交互保留，纯文本/固定通用基准排除。
- [prompts/gap-fill-v4.md](../prompts/gap-fill-v4.md)：完整13节审校，机器17键、四行标签、2表12行8指标列及全部缺陷归属；确认不将后续Reader协议混入主分析表约束。
- [prompts/image-supplement-v3.md](../prompts/image-supplement-v3.md)：副模型只插图，4张/允许章节/稳定段ID/本次像素/不改已有正文；replacement等item字段实际仅忽略，顶层仍仅insertions。
- [prompts/method-fill-v3.md](../prompts/method-fill-v3.md)：仅方法概述和架构600中文字；组件输入输出/未披露不补造/无像素不猜关系；完整单节输出。
- [prompts/opensource-scan-v3.md](../prompts/opensource-scan-v3.md)：逐字HTTPS URL与第三方归属，未提及/尚未网络核实不能写已验证；固定开源详情标题，未发现需升级的事实问题。
- [prompts/primary-fact-local-repair-v1.md](../prompts/primary-fact-local-repair-v1.md)：主文from/to受限段落；保护核心摘要、评分、标签及非授权字节；全文反馈不能扩权。
- [prompts/scoring-audit-v5.md](../prompts/scoring-audit-v5.md)：严格嵌套JSON、8维顺序上限/开源6固定分值、证据ID/类型上限/单缺陷单归属；理论证明与资源可达性分开。
- [prompts/structure-repair-v3.md](../prompts/structure-repair-v3.md)：文件v3/合同analysis-prompt-text-v4为真实登记，非错版；13节顺序/保留合格事实和评分/只扩反馈缺项；不改表数/来源。
- [prompts/table-fill-v2.md](../prompts/table-fill-v2.md)：仅实验结果；2表/12数据行/8指标列、识别列除外；至少3数据行2核对数字、保留负结果及未知值，不冒充Reader矩阵协议。
- [prompts/tag-repair-v3.md](../prompts/tag-repair-v3.md)：primaryTaskId/primaryMethodId/conceptIds恰3键；3–5active直接概念，祖先由程序推导；任务/方法易混边界完整。
- [prompts/visual-summary-v2.md](../prompts/visual-summary-v2.md)：仅用户显式恢复生图才可调用；4章解释图不冒充原图、本次referenceImages像素范围、220–360字符与给定数字；当前持续不生图不触发模板变更。

### 文档图与执行配置

- [docs/images/client-data-flow.svg](../docs/images/client-data-flow.svg)：完整读过文字与数据关系；三流程、已发布内容、两端研究、独立云备份与 Zotero 授权关系一致，原文件不改。
- [.github/workflows/ci.yml](../.github/workflows/ci.yml)：核对手动触发、PR 触发、两版 Node、JavaScript 分片、Python、静态检查及完整汇总，原配置不改。
- [requirements.txt](../requirements.txt)：核对固定 Python 依赖与项目运行器要求，不进行依赖升级。
- [apps/android/app/src/main/cpp/CMakeLists.txt](../apps/android/app/src/main/cpp/CMakeLists.txt)：编译与链接约束属于执行配置，保留原文，不作语言润色。

## 验证与实际边界

- 新 skill 通过创建工具的结构校验，两份副本逐文件相等；独立试写另由主执行者检查。
- 轻量进度合成与原有监控测试共 22 项通过，包括缺少视觉记录时仍保留待核验状态、正确提示不生图收尾及完整状态检查。
- 提示词版本、原字节、占位符、旧合同恢复和依赖指纹执行定向测试；首次测试中四项夹具仍固定旧“当前版本”，修正相应当前断言后复验通过，旧历史用例保留。
- 文档命令检查和差异格式检查通过；内部链接按文件与锚点另查。`docs:check` 本身只核对登记命令，不能替代参数、链接或业务一致性审查。
- 完整工程验收须核对最终提交的全部 CI 分片及汇总，入口为[仓库 CI](https://github.com/nanless/audio-paper-digest/actions/workflows/ci.yml)。本报告不把静态审查当作新一轮真实服务、设备或论文生产验收。

仍保留的实现边界已经在现行说明中写清：轻量监控不核验豁免；网页工具只执行有限标题和地址检查，准确标题、H1、canonical 及完整正文须按实际发布要求另核；Mac 完整界面测试仍含固定 Chrome 路径；未实现的 Zotero 9 兼容、OCR、图像上传与扩展接口继续标为规划。它们不是本次已经交付的新功能。

完整本机证据位于 `data/runtime/documentation-review-20261102/`：初始与补充清单、四组逐文件结论、三个合成试写及独立复核、原材料字节核验、交叉审查与实际测试日志。运行材料按项目规则不提交 Git；本报告保留可随仓库审阅的范围、发现、修法和依据。
