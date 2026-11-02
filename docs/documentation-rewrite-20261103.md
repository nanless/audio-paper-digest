# 2026年11月3日文档、图示与双语整理

本轮按初学者的阅读需要，整理整个仓库的自有说明文档：补充必要背景和中间步骤，分清段落职责，解释内部术语，维护准确图示，并为全部 README 提供完整中英文版本。事实、条件、原始记录和程序限制继续按原范围核对。

这次修改沿用并扩充了[把技术写清楚](../skills/clear-technical-writing/SKILL.md)，项目特有要求同步到[写作约定](writing-guide.md)。审阅发现问题后，由原作者修正，再交回另一位执行者复核；自审和自动检查分别记录，不互相代替。

## 范围与分工

起点为 `aaaa700db16a9ad318be1a6886d2256ad90db9eb`。原有项目说明共65份，其中两份是绑定历史记录的冻结合同；另有4份原写作 skill 文档和18份现用提示词。它们都有本轮阅读与处理结论。许可原文、测试夹具、已发表论文和运行记录按各自身份保护，不能当作普通说明润色。

主执行者负责首页、导航、新人步骤、执行规则、写作 skill、图示和总报告；流程组负责23份流程与维护说明，客户端组负责33份应用与设计说明，提示词组负责两份写作说明及18份模板。新增11份完整英文 README、新项目导读、两份 skill 参考，以及本报告。

逐份记录区分全文阅读、修改内容、保留理由和代码依据。独立复审覆盖实际修改与相邻条件、双语版本和图像；它不冒充把全部历史长文再次逐字重读，也不把本次文案检查写成新的设备或真实服务验收。

工作区同期出现的 Android 功能源码与新增应用测试属于另一路开发，本轮保留其工作，不把它们写成已经通过本轮验收的新功能。提交范围按本轮明确文件确定。

## 写作方法怎样更新

新的成稿标准要求读者能回答：现在处理什么对象，为什么需要这一步，使用什么输入，怎样得到结果，哪些条件与限制继续成立。复杂内容按理解所需展开，不靠缩写、空泛判断或反复概括代替解释。

新增[初学者文档方法](../skills/clear-technical-writing/references/beginner-documentation.md)，具体说明背景、机制、操作、中间步骤、段落和术语。新增[图示与双语方法](../skills/clear-technical-writing/references/diagrams-and-bilingual.md)，说明真实关系、视觉检查、完整翻译与语言版本对照。例子中还补入原子保存和自然英文表达，避免用宽泛词或逐字翻译丢掉技术含义。

代码、字段、命令、模型名和正式专名仍保持精确。中文足以表达时不强制附英文；需要与原资料对应时才给官方名称或缩写，并解释作用。数学或工程中的准确术语不因词形相同就删去，原子保存也不能只换成“完整保存”。

三组分别用真实规则片段独立试写，主执行者对照原材料复核。内容包括补充传输账、个人研究的当前能力与计划、表格选择与 PDF 引文的中文和英文说明。试写保留全部数值、共同条件、否定、原预算与程序专用字段；英文出现生硬复合词后，保留初稿并增加自然英文修订，再独立复核。试写没有发起模型请求，也不是来源或发布证明。

## 先让读者找到正确入口

首页分开网站阅读、应用使用、内容生产与维护。第一次执行任务的人可先读[项目导读](project-guide.md)，理解三条来源流程、内部分析与解读长文、推送与上线、个人研究与备份之间的关系。

新人步骤分开环境检查、实际运行、观察进度、推送后核验和失败恢复。长恢复规则先说明对象与适用范围，再讲共同条件和保存结果。内部简称按实际动作解释，例如从原文件重新核验、将合格新稿保存为正式结果、只更新解读长文的子运行。

表格继续用于比较同类属性；脚本索引里过长的操作规程移到同组表后，原条件保留。历史规划与已实现功能分开，旧验收继续注明原版本、环境、失败和未测范围。

## 全部 README 的语言对应

每份中文和英文说明独立成篇，开头互相链接。英文版完整覆盖对应中文的用途、前提、功能、操作、命令、默认值、恢复条件与验证限制；详细资料只有中文时明确标示，不虚构英文页面。

| 中文版本 | 英文版本 | 用途 |
|---|---|---|
| [README.md](../README.md) | [README.en.md](../README.en.md) | 项目用途、三条生产流程与完成条件 |
| [docs/README.md](../docs/README.md) | [docs/README.en.md](../docs/README.en.md) | 按任务找到说明与历史记录 |
| [scripts/README.md](../scripts/README.md) | [scripts/README.en.md](../scripts/README.en.md) | 375项脚本与模块职责、操作和维护规则 |
| [manual/README.md](../manual/README.md) | [manual/README.en.md](../manual/README.en.md) | 旧记录核验与已授权独立审查 |
| [prompts/README.md](../prompts/README.md) | [prompts/README.en.md](../prompts/README.en.md) | 18份现用提示词、来源与历史版本 |
| [apps/macos/README.md](../apps/macos/README.md) | [apps/macos/README.en.md](../apps/macos/README.en.md) | Mac使用、配置、构建与验证范围 |
| [apps/android/README.md](../apps/android/README.md) | [apps/android/README.en.md](../apps/android/README.en.md) | Android使用、配置、构建与验证范围 |
| [apps/macos/Assets/README.md](../apps/macos/Assets/README.md) | [apps/macos/Assets/README.en.md](../apps/macos/Assets/README.en.md) | 图标源资产与生成方法 |
| [apps/android/licenses.README.md](../apps/android/licenses.README.md) | [apps/android/licenses.README.en.md](../apps/android/licenses.README.en.md) | 许可清单的维护说明，许可原文不翻写 |
| [prototypes/macos-research/README.md](../prototypes/macos-research/README.md) | [prototypes/macos-research/README.en.md](../prototypes/macos-research/README.en.md) | 浏览器原型与本机验证 |
| [prototypes/macos-research/assets/README.md](../prototypes/macos-research/assets/README.md) | [prototypes/macos-research/assets/README.en.md](../prototypes/macos-research/assets/README.en.md) | 公开样稿资产与来源核对 |

## 图示的关系与实际显示

两组图分别解释“论文来源到博客上线”和“公开阅读与个人资料”。每组都有中英文版本，使用相同关系、形状和布局：

- 来源与发布：[docs/images/pipeline-overview.zh.svg](../docs/images/pipeline-overview.zh.svg)、[docs/images/pipeline-overview.en.svg](../docs/images/pipeline-overview.en.svg)。
- 阅读与个人资料：[docs/images/client-data-flow.svg](../docs/images/client-data-flow.svg)、[docs/images/client-data-flow.en.svg](../docs/images/client-data-flow.en.svg)。

来源图明确三条流程各自保存和核验来源，共用分析与写作，再生成、审查、推送、部署和核验网页。个人资料图明确网站内容只读进入工作台；模型研究只发送确认的提取文字；Mac 与 Android 分别使用自己的 Zotero 接口；云端备份按版本保存，虚线返回表示确认后恢复，不自动合并。

主执行者与独立审阅者实际看过四份图的桌面和375像素宽预览，检查文字、对比、遮挡和箭头。四份图无文字出界，手机宽度没有横向溢出。复审发现英文漏写“与网站生产任务分开”后，补全句子，并同步两语容器高度与连接线，再查看受影响的图。

这些图由可编辑 SVG 表达真实关系，没有调用生图，也不改变日更持续不生图的设置。论文原图继续按正常来源、像素和正文要求核验。

## 提示词的必要修改与原版本保护

四份模板仍要求每个术语首次出现都附英文，与本次避免无必要混杂的要求冲突。本次只在新版本中澄清：先用自然中文解释，确实需要对应原文时再给官方英文名或缩写，正式专名和字段仍保持准确。

| 原文件 | 新文件 | 本次实际变化 |
|---|---|---|
| `deep-analysis-v7.md` | `deep-analysis-v8.md` | 修正两处相互关联的强制附英文要求 |
| `api-reader-article-v10.md` | `api-reader-article-v11.md` | 术语按理解需要附官方英文或缩写 |
| `gap-fill-v4.md` | `gap-fill-v5.md` | 审校正文采用相同术语原则 |
| `structure-repair-v3.md` | `structure-repair-v4.md` | 结构修复采用相同原则；文件v4对应合同v5，二者不混淆 |

原四版的真实 Git 对象、原路径、整文件 SHA 与模板身份保留，其他14份模板逐字不变，工作树仍只有18份现用模板。JavaScript、Python和选定重分析入口同步当前路径；旧付费稿继续按原身份读取，不重签、清零或增加请求次数。

升级时发现版本判断还决定阶段指纹中的输出预算。仅给原有完整审校和结构修复两个阶段的既有白名单补入合同v5，维持原64000 tokens；其他阶段的预算与实际请求分支不变。相应新旧版本、预算、原稿恢复和拒绝越权的正反例均按实际影响验证。

## 独立复审发现的问题怎样关闭

- 完全无法写盘时，响应保存可能失败。说明改为真实尝试并如实报告，不能保证必然保存成功。
- Manual英文说明一度把调用旧核验器的模块写成目录中的被调用模块，已按实际调用关系改正。
- Android备份说明一度把“原子保存”换成“完整保存”，已恢复准确术语，并解释读取者不能看到半份状态。
- Mac“自动保存”与实际自动备份机制不一致，已在两种语言中明确为自动备份。
- 根操作规则改成中文后出现的悬空空格、重复修饰和缺谓语句，已逐句接顺，原条件、链接、标题和代码块保留。
- 英文图、平台最低系统要求、资料语言标记及个别生硬英文，修后回到原复审者核对。
- 新增英文README使两个测试的目录枚举需要同步。它们只明确排除中英文两份README，18模板的约束与未知文件拒绝继续执行。

上轮审查报告还发现一处汇总错误：文档定向测试原日志为5项通过，曾误写为6项。因此对应旧定向合计应为89项，不是90项。[旧报告](documentation-review-20261102.md)已给出更正与依据，原日志和旧汇总文件保留不变；没有把它们算作本轮新测试。

## 原有各文档的处理结论

下面记录原65份项目文档的具体改进或保护理由。更细的逐章节结论、文件修改前后指纹及代码依据保存在本机运行记录中。

### 首页、导航与执行规则

- [README.md](../README.md)：分开阅读、应用、生产与维护，解释解读长文和模型服务，补完整英文对应。
- [AGENTS.md](../AGENTS.md)：先给阅读路线与术语解释，拆开长段，接顺内部简称；原来源、预算与执行条件保留。
- [SKILL.md](../SKILL.md)：按任务解释正常操作与专项恢复，拆开适用条件和核验结果；原命令、标题与代码块保留。
- [docs/README.md](../docs/README.md)：按初次了解、应用、生产、失败、开发和历史记录分组导航，补完整英文。
- [docs/onboarding.md](../docs/onboarding.md)：解释准备、输入、观察、结果及故障后的下一步，区分轻量进度与正式核验。
- [docs/writing-guide.md](../docs/writing-guide.md)：明确本轮成稿标准、术语解释、段落、原子性、图示及完整双语规则。
- [docs/documentation-review-20261102.md](../docs/documentation-review-20261102.md)：补历史阅读说明，保留原结果和旧版本链接，并按原日志明确计数更正。

### 流程与维护

- [docs/analysis-stop.md](../docs/analysis-stop.md)：解释排队与在途区别，将停止顺序放在具体子节。解释错误作用范围，保留最后成功仍停止后续流程。
- [docs/daily-fetch-boundary.md](../docs/daily-fetch-boundary.md)：在使用见证之前说明对象、目的及去重区别。按归档前激活、允许范围、重启核验三个问题分段解释，保留全部拒绝条件。
- [docs/daily-performance.md](../docs/daily-performance.md)：解释时间口径为何不能混算，而非只要求同口径。将内部投影名解释为有限诊断视图，保留容量及未实现状态。
- [docs/data-format.md](../docs/data-format.md)：解释异常响应保存的用途，并说明它不授予请求或发布权限。先定义表格选择证明，再分清解析时检查与保存后重读原文件核验。
- [docs/locked-source-validation.md](../docs/locked-source-validation.md)：把最终整批事务、零待办与逐篇保存的区别拆开说明。
- [docs/maintenance.md](../docs/maintenance.md)：按现行登记更新模板导航，保留历史模板字节与事实。分清文档、实现和提示词改动分别需要的检查。
- [docs/setup.md](../docs/setup.md)：解释配置隔离原因及0600含义，保留变量清理范围。解释三种限制之间的因果关系。
- [docs/troubleshooting.md](../docs/troubleshooting.md)：说明重新读取哪些原文件，以及为什么本地核验不能当作模型请求。把启动前特殊问题定位到具体小节，并解释原父稿包。
- [docs/three-workflows.md](../docs/three-workflows.md)：解释共享引擎和适配器传递的对象。拆清事实反馈的登记、续跑、清除及发布阻断顺序。
- [docs/conference-workflow.md](../docs/conference-workflow.md)：解释会议处理任务、原稿、只更新解读长文的模式，以及从原文件重新核验。将原条件分组但保留共同限制，明确临时检查视图不改写原文件。
- [docs/history-direct-publication.md](../docs/history-direct-publication.md)：先说明覆盖计算，再列失败条件，不减少拒绝项。解释第三种字节与CAS的作用，将提交恢复分段。
- [docs/history-rewrite.md](../docs/history-rewrite.md)：说明从原记录派生的临时视图包含什么，以及怎样保证处理范围完整。分别解释调度、预算、页面暂存状态与来源限制。
- [docs/reader-explicit-retry.md](../docs/reader-explicit-retry.md)：集中解释恢复所需术语，分清重读原文件核验和将新稿保存为正式结果。把必须同时满足的三个条件编号，保留原始与规范化的两种问题签名。
- [docs/compatibility.md](../docs/compatibility.md)：说明兼容表只描述原记录，不自行允许新的请求或发布。分开通过页复用、失败绑定与尚未完成的维护义务，解释通过缓存和正式当前稿。
- [docs/repository-maintenance-review.md](../docs/repository-maintenance-review.md)：说明跨语言桥实际职责。解释同步范围和正式采纳动作，保留禁止范围。
- [docs/shared-workflow-review.md](../docs/shared-workflow-review.md)：先解释计算复用与资格核验、私有句柄的区别。解释错误字段用途，区分论文叙述与程序故障。
- [docs/workflow-sharing-plan.md](../docs/workflow-sharing-plan.md)：为计划/共享规则页说明关键对象。还原英文动作与投影的具体输入输出。
- [docs/tag-display-policy.md](../docs/tag-display-policy.md)：解释展示投影不改原数据的具体含义。将三流程的完整更新规程从长表移到表后，原命令、条件和链接逐字保留。
- [docs/tag-system-design.md](../docs/tag-system-design.md)：解释查询且或关系并保留原示例。将身份规则和版本维护分开，不改变历史设计状态或数量。
- [scripts/README.md](../scripts/README.md)：补完整英文版，解释内部模块、程序核验后的来源对象，以及从原文件重读核验的作用。长规程移到各组表后，保留全部条件、参数、链接和不生图设置。
- [manual/README.md](../manual/README.md)：说明退役目录的当前职责并加入独立英文互链。把退役范围、恢复顺序和建议工具的边界分段解释。
- [manual/docs/editorial-reference-contract-v2.md](../manual/docs/editorial-reference-contract-v2.md)：冻结的旧协议证据，所有说明、旧模型、原链接及SHA约束均按其当时版本保留；现行解释写在manual/README双语导航。
- [manual/docs/editorial-reference-contract.md](../manual/docs/editorial-reference-contract.md)：冻结的旧协议证据，所有说明、旧模型、原链接及SHA约束均按其当时版本保留；现行解释写在manual/README双语导航。

### 客户端、设计与原型

- [apps/android/README.md](../apps/android/README.md)：按同步、发送材料、任务与失败重排首次使用；解释模型端点、物理页、次数与未知费用。把单篇 Zotero 归档和全空间备份拆开，解释调试构建与设备实测、16 KiB 对齐的区别。
- [apps/android/licenses.README.md](../apps/android/licenses.README.md)：解释运行依赖记录、重复项与内容指纹；说明更新依赖时必须重新核对来源和授权。
- [apps/macos/Assets/README.md](../apps/macos/Assets/README.md)：解释负形、透明通道和多尺寸 ICNS；保留静态图标与不入包边界。
- [apps/macos/README.md](../apps/macos/README.md)：按找论文、配置模型、保存笔记组织首次使用；解释分面组合、目录浏览与筛选差异。拆分 Zotero 与坚果云用途，保留原系统、版本、Node 精确版本、浏览器前提和全部构建命令。
- [docs/android-app-plan.md](../docs/android-app-plan.md)：解释目录分片全量校验、模型请求前先保存材料和派发事实。说明资料包与云清单各自作用，同一字节续传不能改成新快照。
- [docs/android-cloud-contract.md](../docs/android-cloud-contract.md)：解释合同、Base64、SHA、请求连续性与费用的不同作用。将上传英文简写改为中文步骤，恢复分检查、确认、替换；限定云传输 HTTPS，不抹掉本机模型回环 HTTP 例外。
- [docs/android-cloud-portable-fixtures.md](../docs/android-cloud-portable-fixtures.md)：解释先小包、后分块边界、再破坏与中断的检查顺序；解释测试编号与预期表不等于实测报告。
- [docs/android-feature-parity.md](../docs/android-feature-parity.md)：说明要求、历史状态与实际证据的关系，解释功能编号。在模型和 Zotero 组中解释私人研究边界、回读与仅交付文件的区别。
- [docs/android-validation.md](../docs/android-validation.md)：解释 Android API 级别与应用版本、模拟器与实体设备证据的区别。说明备份取回材料与保留本机授权是两项要求。
- [docs/android-zotero-research.md](../docs/android-zotero-research.md)：解释授权密钥与对象编号、父书目与子材料、回读和部分完成。解释丢失应答、12 小时去重、系统文件共享与接收方保存的区别。
- [docs/blog-reading-tools.md](../docs/blog-reading-tools.md)：按原 PDF、引用、单篇 Markdown、批量清单、外部研究和分享任务拆解原长表。解释引用格式用途与下载不等于文库归档，保持退役助手与浏览器正常保存的区别。
- [docs/client-security-audit.md](../docs/client-security-audit.md)：区分生产凭据、个人服务凭据、本机响应完整性密钥。解释实际安装包字符串检查能证明的范围，说明私人备份与传输加密；保留原未确认历史材料与路径限制。
- [docs/desktop-data-contract.md](../docs/desktop-data-contract.md)：解释可变入口与按内容寻址对象、论文/版本/导读/出现记录各自用途。解释移除记录 tombstone，保留 desktop/v1 尚未部署状态。
- [docs/desktop-prototype-validation.md](../docs/desktop-prototype-validation.md)：解释实际渲染页和字节指纹，明确固定原型样本结论不能授予正式应用通过。
- [docs/desktop-research-workbench-plan.md](../docs/desktop-research-workbench-plan.md)：在研究流程内分开当前文字能力与后续图像、检索；说明离线等待不是自动重发。解释原始功能优先级是规划顺序，不能当现行交付清单。
- [docs/favorite-collections.md](../docs/favorite-collections.md)：解释分面组合、直接/子树、主要/全部角色与现行网站分类。解释可选历史字段与原子增量、修订比较、重复执行不改结果；原 JSON 示例不变。
- [docs/mac-app-acceptance-status.md](../docs/mac-app-acceptance-status.md)：解释历史通过状态、适用条件与不同证据方法；说明任务保存、回读、未知终态。
- [docs/mac-app-acceptance.md](../docs/mac-app-acceptance.md)：解释先定要求后操作判定与主动失败测试；说明本机配置不等于本机推理。解释独立审查与实际安装、源码阅读的不同作用。
- [docs/mac-app-cloud.md](../docs/mac-app-cloud.md)：解释不可变版本、仅本次密码与钥匙串、分块回读及完整清单。解释无备份与未完成列表差异，历史通过不能套到新账户与安装包。
- [docs/mac-app-data.md](../docs/mac-app-data.md)：解释目录分片完整核验后切换、可变 PDF 复核与退避、网页缓存与完整离线。解释请求保存顺序、JSON 备份的两种上限与内部桥接命令边界。
- [docs/mac-app-icon-design.md](../docs/mac-app-icon-design.md)：解释负形、RGBA 与不同显示尺寸的 ICNS，不改变图标身份或静态格式范围。
- [docs/mac-app-release.md](../docs/mac-app-release.md)：区分普通下载安装与维护者构建，说明本地签名与公证不同。解释 inspect/prepare/verify 和草稿/公开计划各自行为，保留全部命令及 84/86 约束。
- [docs/mac-app-requirements.md](../docs/mac-app-requirements.md)：解释阅读、研究、归档和备份的连贯任务，网站适配与未来接口区别。说明文字提取/OCR、PDF 搜索、本地 Zotero 回读与整空间备份各自边界。
- [docs/mac-app-review-log.md](../docs/mac-app-review-log.md)：解释隔离测试、原生窗口、真实服务及静态包检查的证据区别。
- [docs/mac-app-validation.md](../docs/mac-app-validation.md)：解释自动化、实际窗口和包检查各自作用，标明本次文字修改未重跑历史表。以扫描页和 Zotero 同步示例解释已知限制。
- [docs/mac-app-zotero.md](../docs/mac-app-zotero.md)：解释可连接与可写入、父书目和附件回读、个人账号标识。解释回环 API、内容指纹与不改数据库的实际含义。
- [docs/macos-interface-design-research.md](../docs/macos-interface-design-research.md)：解释导航到导读再核对 PDF 的阅读顺序，导读重组为何不能按滚动百分比联动。解释真实字节进度、不确定模型等待和受限文档与原生命令边界。
- [docs/workbench-1.1.0-review.md](../docs/workbench-1.1.0-review.md)：解释预载、文字预览、完整核验三种不同加载状态；解释十四轮记录与性能条件。
- [docs/workbench-1.2.1-review.md](../docs/workbench-1.2.1-review.md)：解释分面、多级、父方向包含与直接标签区别，保持旧方案纠正记录。
- [docs/workbench-1.3.0-review.md](../docs/workbench-1.3.0-review.md)：解释浏览与勾选筛选，说明同分面任选与跨分面同时满足。解释操作系统辅助功能树，不扩大为完整语音朗读与焦点认证。
- [docs/workbench-usability-review-20261101.md](../docs/workbench-usability-review-20261101.md)：说明 1.2.0 自建分类属于历史，现行 1.2.1 以后改用网站分类。拆解四步备份往返，明确 Mac 隔离引擎与界面恢复不同。
- [prototypes/macos-research/README.md](../prototypes/macos-research/README.md)：解释本机服务、显式 PDF 绝对路径、指纹与科学审查区别。按样稿、阅读与来源、任务未连接状态组织评审，保留测试和依赖原版本。
- [prototypes/macos-research/assets/README.md](../prototypes/macos-research/assets/README.md)：把来源 URL 改为可读链接，解释固定裁图准备及按实际字节检查。

### 提示词导航与解读写作

- [prompts/README.md](../prompts/README.md)：按读者任务分组介绍18份模板，逐项说明输出与使用范围。分清模板请求、运行时补充指令、原论文图，以及日更已经取消的生图任务。
- [docs/reader-writing.md](../docs/reader-writing.md)：先解释解读正文、结构化计划、内容指纹与保存后复验，再按任务说明输入、概念、比较和来源规则。区分使用实际运行时不可得信息的理想参考与可运行策略；英文名称按理解需要附注。

## 验证与证据

文档检查核对命令、相对路径、章节锚点、代码块、README语言对应和实际修改范围。图示另作真实渲染与独立目检；不能把语法检查当作图像正确或全文易懂。

提示词和代码变更执行新旧版本、跨语言登记、预算与历史恢复的定向检查。真实旧稿的恢复、保存、完成检查与出版调用路径使用原夹具和隔离模拟服务，不发真实模型请求。目录测试保留严格18模板边界。

最终完整工程验收按同一提交的全部 CI 分片及汇总确认，记录见[仓库 CI](https://github.com/nanless/audio-paper-digest/actions/workflows/ci.yml)。本页不把文档检查称为新的应用构建、设备操作、真实账户测试或论文重分析。

本机证据在 `data/runtime/documentation-rewrite-20261103/`，包含原清单、逐文件和逐章节记录、独立试写及修订、交叉复审、图片预览、边界与链接检查、实际测试日志。最终 CI 完成后另存其结果记录。按项目规则不把运行材料、日志、凭据或正式论文数据提交到仓库。
