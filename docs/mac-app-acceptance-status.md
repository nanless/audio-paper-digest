# Mac应用69项实际验收状态

本页逐项记录[正式验收矩阵](mac-app-acceptance.md)的实际结果，不改变原69项要求。当前为 **42项通过、27项待验**；没有据此宣布全部功能和全部系统条件通过。只有原要求的全部适用条件已有对应证据才记为“通过”；任一必测条件未覆盖仍记为“待验”，并另列已完成范围。隔离测试、原生实机和文件回读分别标明。“待验”包含缺少实际条件或证据的项目，不一概表示功能已经失败。

## 当前安装与证据复用

记录日期为2026-10-25，时区Asia/Shanghai。当前安装于`~/Applications/论文速递.app`，来源提交`3880de596800b08654b7136e2ea664a61145a05c`，builtAt为`2026-10-24T18:15:23.755225+00:00`。原生SHA-256为`08285de6ff110684a0418c6accbc0adb615626f1dab6e9b061b0b4b7536e3a6a`，构建清单SHA-256为`c871c4e12bbde5127c8bb7bf504a344429a0b7fe5c8cdfda68dc43393e316062`。独立审查逐项核对502个候选/安装实物文件、420项Git输入、88项锁定依赖及样稿，严格签名与C图标字节均通过；仍为本机开发签名，未Apple公证。

9b1422f3已完成的真实网站读取、模型材料、八格式导出和Zotero回读，仅复用于未变化的材料及实现链。878取消结果及任务状态保护已实际复验。3880进一步加入20行任务分页和依据/用量展示；完整30套JS v16通过，79个冻结输入无变化，未变Swift链复用完整v14结果。878任务页曾截图正常而系统辅助功能树只读到工具栏；真实隔离WK复现大列表条件并验证分页后，3880正式App143条真实任务已逐8页实际打开，系统AX、分页和精确原会话关联独立44项回读通过。本次任务页缺失已关闭；另一路32项真实任务元数据独审与3会话/6事件不变核验通过，纯键盘等其他条件仍按APP-06记录；隔离QA与真实用户任务分开。各轮实施、测试和原失败记录见[验收记录](mac-app-validation.md)和[独立审查记录](mac-app-review-log.md)。

## 尚未关闭的实际条件

严格网络隔离并重启后读取离线包、从Zotero自身存储离线打开资料，仍缺实际记录。已检查的原生尺寸为1280×800、最小1080×700，以及全屏单/双栏和38–62%分隔极限；其他精确尺寸和系统全局辅助外观没有扩大授予通过。核心键盘编辑链、部分库检索/定时/目标变化和困难PDF条件继续逐项待验。

真实模型研究与复用已有原426字选区、142字回答和3124tokens账本，未为重复验收追加付费。878实际重启后，真实Zotero新版材料六角色99项回读和重复比较10项均通过，没有新增对象或模型事件；旧legacy材料的缺口单独保留。3880已另行发起原检查点回读，目前等待系统钥匙串确认，尚未记录新六角色完成；878的99/10不冒称此次3880新回读。另行独立GET及存储文件99项确认原归档完整，也不代表被系统确认阻挡的3880原生回读已结束。本机成功不表示云端文件同步完成。当前页不会用静态图、构造回答或相同版本反复测试替代未执行条件。

## 安装与原生桌面

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| APP-01 | 通过 | 3880真实.app已安装；502文件与审定候选相同，随包Node/资源。9b/878真实网站读取和PDF证据仅复用于未变化链。 | 限本机arm64/macOS26.6.1；不声称跨Mac发行、公证或自动更新。 | PKG, FINALGUI |
| APP-02 | 待验 | 真实系统窗口、菜单、激活、退出与9b原生全屏单/双栏已有实机证据；878通过正常退出旧版、安装及再次启动。 | 最小化→恢复、关闭主窗→Dock重开后的完整上下文记录仍未齐全。 | FINALGUI, SIZES, HISTORY |
| APP-03 | 待验 | 独立设置四组及⌘,、模型/网络/阅读/Zotero真实可读；51分类及持续授权已确认。 | 设置窗口缩小/拖动、关闭后重开的四组可达性及主阅读位置保留尚未完整记录。 | SETTINGS, HISTORY |
| APP-04 | 待验 | 9b实机1280×800、最小1080×700、全屏单/双栏、侧栏及38–62%分隔极限已检查，无主要动作裁切。 | 精确1440×900、1728×1117、1920×1080原生窗口条件尚未记录；已有浏览器截图及Retina像素不能作为这些点数的实机结果。 | SIZES |
| APP-05 | 待验 | ⌘,、原生导出/确认的Escape、真实⌘F章节居中和常用编辑入口已有证据。 | 真实Return换行、复制粘贴、撤销/重做与Tab/方向键作用域的完整编辑链尚未记录；输入法发送保护已有隔离检查。 | FINALGUI, TESTS |
| APP-06 | 待验 | 3880正式App的143条真实任务已逐8页操作，系统AX每页均读出任务及动作；第6页原研究材料/用量、第7页未知值和复用记录独立回读44/44通过。9b其他主窗、设置及原生详情AX证据保留。 | 本次任务页AX缺失已经关闭；核心纯键盘贯通尚未完整验证，因此APP-06整体仍待验。 | AX, TASK3880, FINALGUI |
| APP-07 | 待验 | 9b浅/深色、放大字号、原图/PDF原色已有实机画面。 | 系统级高对比度、减少透明度/动态和失焦状态尚未全覆盖；应用内配色设置不等同全部系统条件。 | APPEARANCE |
| APP-08 | 待验 | 多次正常退出/升级、旧83e4重启后资料及归档不丢；878安装/启动与重启后Zotero99项、重复比较10项通过。 | 878退出重开后的阅读/问题/笔记综合恢复及崩溃/睡眠条件尚未全部记录；普通退出和锁屏不能代替后两者。 | PKG, HISTORY |
| APP-09 | 通过 | 3880候选与安装副本独审：arm64、最低macOS15、主应用/Node严格签名、C图标不变，无私有运行目录/凭据模式命中；明确ad-hoc未公证。 | 只覆盖本机发行声明；未承诺的跨机、公证和自动更新不授予通过。 | PKG |

## 已发布数据与离线

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| DATA-01 | 通过 | 实际22分片逐字节/SHA/数量核验，8720页面记录/8005去重论文，本机全库目录真实加载。 | 这是当次快照计数，不自动意味着后续所有新部署已同步。 | DATA, HISTORY |
| DATA-02 | 待验 | MiCLA日更型arXiv与TurnGuide正式会议均直接读已发布正文，未发客户端重评/重写请求。 | 明确历史维护后的已发布文章及汇总入口的实际识别记录尚不完整；现有成果没有重新生成。 | DATA, FINALGUI |
| DATA-03 | 通过 | 实际arXiv明确版本及会议身份保留；原题/译题、未知DOI/作者机构不造值；旧式ID/版本/出现记录有独立反例。 | 结论限已核记录与来源规则，不推断所有论文机构完整。 | DATA, ZOT, TESTS |
| DATA-04 | 待验 | 实际完整MiCLA和TurnGuide导读、13/9页原PDF、原站链接与三种引用导出；旧离线公式未核验警告可见。 | 特殊非camera-ready来源及跨标题预印本例外尚未在实际App中完整验收；普通两篇完整阅读不能替代这一必测条件。 | FINALGUI, EXPORT, OFFLINE |
| DATA-05 | 通过 | 真实完整目录基线与Library事务/取消/坏分片/SHA/混版本/失败保旧等隔离反例均已核验。 | 反例是隔离真实HTTP/文件测试；不称整机断网同步实测。 | DATA, TESTS |
| DATA-06 | 通过 | 新增/更正/移除与私人资料保护有Library/Store隔离回归；真实个人笔记、旧回答、Zotero映射在实际同步/恢复后保留。 | 没有人为改线上发布内容或真实撤稿来凑验证。 | DATA, HISTORY, TESTS |
| DATA-07 | 通过 | 真实轻目录+按需2篇材料；反复浏览/导出/归档回读期间仍3会话6事件3124tokens，未新模型请求。 | 不把完整目录读取说成全库原文/PDF已离线。 | DATA, ZOT, MODEL |
| DATA-08 | 待验 | 两篇真实完整离线包已保存并从原生窗口打开；TurnGuide实际3原图/9页PDF，文件清单与原SHA均核。 | 严格可证明的网络隔离与退出重启后读取尚未执行；现有在线缓存读取不能替代该条件。 | OFFLINE, FINALGUI |
| DATA-09 | 通过 | 指定版本、SHA/MIME/404、缺图、坏包/缓存、同URL新版本及不静默替换有真实HTTP/文件反例；旧HTML公式缺口实机明确提示。 | 扫描/OCR不支持不得混入本项成功。 | OFFLINE, TESTS |
| DATA-10 | 待验 | 取消隔离、下载检查点及重启恢复规则已有测试，真实旧成功资料一直保留。 | 真实睡眠唤醒、同步/下载中断后仅恢复必要步骤尚无完整实机记录。 | TESTS, HISTORY |
| DATA-11 | 通过 | 真实容量/分类/离线快照均可读，清理预览0候选如实显示；临时实物测试核保护资料与删除/磁盘失败。 | 未执行真实用户库删除，不把0候选说成清理确认/删除成功。 | AX, OFFLINE, TESTS |
| DATA-12 | 通过 | 实际采用公开目录及明确HTML过渡适配，校验来源/科学DOM且不以LLM补缺；公开数据/包中不含费用账及凭据。 | 不冒称所有规划中的desktop/v1出口已部署。 | DATA, PKG, HISTORY |
| DATA-13 | 待验 | 手动真实全库同步与定时配置入口有效，日期使用网站日期且不本地重生成。 | 自动定时检查及新部署实际进入本机目录的实机见证尚未完成；没有为验收改动线上论文。 | DATA, SETTINGS, TESTS |

## 导读与PDF阅读

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| READ-01 | 通过 | 最终9b真实完整单栏，无空白PDF/永久聊天栏；长中英文题、缺会议作者、原来源信息保留。 | 以两篇真实长文为范围，不称所有未知稿式均验证。 | FINALGUI |
| READ-02 | 通过 | 实际单/双栏、解析/笔记左PDF右、最小窗口/侧栏与38–62%极限均工作。 | 更大精确窗口尺寸仍留APP-04；不扩大为所有屏幕。 | SIZES, FINALGUI |
| READ-03 | 待验 | 实际MiCLA含3原科学图、4完整MathML、4原表及原图注；真实页面、导出与Zotero原件分别核验。 | 同一真实论文的脚注及宽表/长公式局部交互尚未完整记录；3图/4表/4式和95科学块不代替这些条件。 | FINALGUI, EXPORT, ZOT |
| READ-04 | 通过 | 原方法图/图注、PDF物理页、原8维评分及7.5原值保留；新页首去重不删除原正文、链接、评分明细。 | 不将API目录缺失字段重算成新评分。 | EXPORT, ZOT, TESTS |
| READ-05 | 待验 | 真正PDFKit显示已核字节及13/9页，物理5页与真实图/正文对应；适宽和缩放有真实画面。 | 最终包页码输入、翻页、缩放、适宽、PDF查找、选择复制的完整短流程尚未逐动作留证。 | FINALGUI, HISTORY, TESTS |
| READ-06 | 通过 | 426字原选区绑定PDF SHA与物理5页，真实回答引用/笔记摘录回跳及原图对应，错版本/越界有反例。 | 只证明实际材料页与选区，不宣称未提供内容或句级定位。 | MODEL, FINALGUI, ZOT, TESTS |
| READ-07 | 通过 | 真实PDFKit选区来源与封存输入核验；原生/DOM交错反例覆盖跨篇、ABA、旧PDF/预览迟到及引用版本。 | 核心路径用实际PDFKit，不把浏览器占位当原生证据。 | MODEL, TESTS |
| READ-08 | 待验 | 最终9b单/双栏、字号、侧栏、真实Find与分隔极限已实际检查；独立Range/旧队列/同源暂停回归通过。 | 最终包退出重开后的综合上下文仍待记录；旧83e4重启结果不自动覆盖后来的字号/导航变化。 | SIZES, APPEARANCE, TESTS, HISTORY |
| READ-09 | 待验 | 真实双栏论文及附录、PDFKit密码/长选区等隔离文件检查已覆盖；帮助明确无OCR/无图像模型输入。 | 扫描、旋转、密码及超长原件的实际GUI组合尚未全记录；未支持OCR和图像模型输入，不能声称图像内容已分析。 | FINALGUI, TESTS |

## 论文库

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| LIB-01 | 待验 | 真实8005篇列表、ID定位，分页/多选/组合筛选/排序有1227项输入的隔离UI检查。 | 真库组合筛选、排序、清除条件、批量及上下文动作尚缺完整实机记录。 | DATA, TESTS |
| LIB-02 | 待验 | 标题/标签/导读/私人笔记检索和范围说明已有实现与隔离反例，真实ID搜索已使用。 | 真库1字/2字中文、缩写/标点、无结果及私人笔记命中尚未逐项记录；PDF原文不属于资料库全文索引。 | DATA, TESTS |
| LIB-03 | 待验 | 真实收藏1条、阅读记录/问题/PDF页在旧重启及备份恢复后保持；待读/计数/来源更正有隔离回归。 | 真实待读状态切换及退出重启后保持尚未完整记录；已有收藏和阅读恢复不能替代该条件。 | HISTORY, MODEL, TESTS |

## 个人笔记

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| NOTE-01 | 待验 | 119字中文笔记及批注已真实保存/再次打开；写盘失败不假报成功有原生/DOM反例。 | 实际输入法组合、复制粘贴、撤销/重做与选区编辑的完整流程尚未记录。 | HISTORY, FINALGUI, TESTS |
| NOTE-02 | 待验 | 真实物理5页摘录/个人批注创建编辑、恢复后回原文；删除/失败保护和版本绑定有原生隔离回归。 | 实际App标注删除并退出重启后的结果尚未完整验证；不虚构直接写回原PDF的能力。 | HISTORY, FINALGUI, TESTS |
| NOTE-03 | 通过 | 真实旧笔记与回答在网站重读/恢复后保留，CAS/坏恢复/冲突及跨篇保护已独审。 | 当前为单主阅读窗口；未支持的并行多文档编辑不冒称已测。 | HISTORY, TESTS |

## 导出与备份

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| EXP-01 | 通过 | 8格式已经真实原生保存窗口导出；研究3格式重新核426/142原封存材料、原题/问题/模型/来源/用量34项。 | 878取消与正常保存均已真实复验；八格式内容及34项封存研究证据沿用未变导出实现的9b结果。 | EXPORT, FINALGUI |
| EXP-02 | 通过 | 真实原PDF及自包含导读、研究MD/HTML/JSON逐格式核验；3图/4MathML/4表与正确PDF SHA保留。 | 研究HTML为可读保留文本，未声称额外富文本或未承诺归档格式。 | EXPORT |
| EXP-03 | 通过 | 真实GUI59069238B/62项v2备份与恢复，笔记/回答/依赖/映射相等；钥匙串不进包、原副本保留。9b新宿主到真实确认/取消；878从菜单取消备份没有错误NSAlert。 | 完整恢复沿用未变化核心的既有证据，9b/878分别复验新宿主及菜单取消；没有重复大备份恢复。 | BACKUP, HISTORY, TESTS |

## 本机模型研究

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| LLM-01 | 待验 | 真实项目指定模型/代理与一个可用账号经用户授权接入本应用钥匙串；真实读取调用成功，包/导出无密钥。 | 更新/删除后恢复及最终签名下重启读取的完整凭据CRUD尚未逐一实机记录；系统安全窗口由用户本人处理，未追加无意义付费请求。 | MODEL, PKG, HISTORY |
| LLM-02 | 通过 | 真实最小完整成功500tokens、先前incomplete失败1179tokens保留；项目代理确实生效，协议/能力不混为图像支持。 | 认证/配额/传输反例为25次本机HTTP/隔离测试，不假称真实账号均测遍。 | MODEL, TESTS |
| LLM-03 | 通过 | 真实主动选区研究426字载荷/原SHA完整绑定；浏览/同步/归档/复核没有增加模型事件；范围派发有PDFKit/worker检查。 | 没有默发全库、自动重评；真实付费只复用已有3次，其他范围反例透明标隔离。 | MODEL, ZOT, TESTS |
| LLM-04 | 通过 | 一次真实MiCLA物理5页选区返回142字完整回答，原问、输入、模型、时间、用量和响应存档并再次核验。 | 当前模型输入为提取文本，不宣称已读原图像素/OCR或完整未给公式。 | MODEL, EXPORT, ZOT |
| LLM-05 | 通过 | 真实回答明确原文/推断/不能确认范围，p.5受控引用可回原件，原网站评分/来源未改写。 | 未把引用存在等同所有科学断言独立事实审查。 | MODEL, FINALGUI, TESTS |
| LLM-06 | 待验 | 真实SSE配置/完整回答保留，输入区和复制文本可访问，Return/组合保护及滚动逻辑有隔离回归。 | 真实选择复制、保存到笔记、Return换行和发送键作用域的完整编辑链尚未记录；未以重复付费代替编辑验收。 | FINALGUI, MODEL, TESTS |
| LLM-07 | 通过 | 相同完整输入真实复用，保持3会话6事件3124tokens；来源/模型/提示等指纹变更及重做保父版本有真实worker回归。 | 没有为重复证明相同输入追加请求。 | MODEL, ZOT, TESTS |
| LLM-08 | 通过 | 真实3次请求计707输入/2417输出/3124总tokens，失败与成功账成对；金额未知；当前回读/导出事件0新增。 | 不把失败/取消记零，不从tokens推测费用金额；预算边界测试为隔离。 | MODEL, ZOT, TESTS |
| LLM-09 | 通过 | 真实incomplete未冒充成功且计真实用量，重启/重复未重发；取消、超时、保存故障、401/429和截断由隔离HTTP及文件反例验证。 | 不声称在真实付费请求上逐种制造故障。 | MODEL, HISTORY, TESTS |
| LLM-10 | 通过 | 受限iframe/CSP、真实frame/origin与原生能力门、输入和服务脱敏均审查；只导入获准一个账号，费用与生产分开。 | 不把全账号池复制进App；当前报告不读取或显示凭据。 | PKG, MODEL, TESTS |

## 后台任务

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| JOB-01 | 通过 | 3880正式App完整143条真实任务8页可达，真实对象、任务类型/状态、来源依据、费用状态及动作已显示；唯一原study关联物理5页、版本/PDF SHA和397/1048/1445tokens。未知费用与缺失依据不补零，复用不重复计量。工作区31项及元数据20项检查与正式App44项回读分别通过。 | 未把隔离构造任务当用户真实任务，也未声称143条每一字段都经人工逐字检查；完整集合保持另由分页遍历和存储不变检查支撑。 | TASK3880, TESTS, MODEL |
| JOB-02 | 待验 | 878真实保存窗口取消后提示正确；同分钟后台记录“已取消”和正常导出的“已完成”，实际生成final878-research.md。已有结果打开及原检查点重试也已真实使用。 | 基本取消与正常保存已关闭；其余已暴露任务类型的排队、继续、取消和有限重试仍以各自隔离证据及实际操作记录为界，尚未全部实机贯通。 | CANCEL878, FINALGUI, TESTS |
| JOB-03 | 待验 | 878真实重启后Zotero原检查点99项/重复10项通过，原模型记录未重发；早先真实部分恢复与隔离恢复均保已完成。 | 严格断网重启、睡眠和崩溃组合尚无实机全链；锁屏、正常退出不能替代这些条件。 | HISTORY, ZOT, TESTS |
| JOB-04 | 通过 | 9b曾把用户取消导出误记failed，原失败保留。878修复后实际取消提示“本次没有生成文件”，任务截图显示“已取消”；随后的真实Markdown保存成功并显示“已完成”。 | 本次已关闭取消误分类；其他进度/用量/未知终态仍复用未变实现的真实记录与隔离反例，不声称所有失败均在私人库制造过。 | CANCEL878, TESTS |
| JOB-05 | 通过 | 真实UI未因后台任务阻塞，已导出只读诊断；并发/磁盘不足/不可写/响应保存失败及脱敏有真实文件/HTTP隔离检查。 | 诊断不等于用户正文或凭据转储；没有在真实用户库注入磁盘故障。 | DIAGNOSTICS, TESTS |

## Zotero归档

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| ZOT-01 | 通过 | 实际Zotero10.0.6/API3，持续授权与当前51分类；可写能力经真实创建和六角色回读证明。 | 未运行/拒绝/只读目标反例为隔离；不把端口通当完整授权。 | ZOT, SETTINGS |
| ZOT-02 | 通过 | 真实父书目、3个存储文件、独立解析/个人笔记均完成写入与回读；后续9b沿相同真实检查点验证。 | 不是仅RIS/BibTeX导入；没有直接修改Zotero SQLite。 | ZOT, HISTORY |
| ZOT-03 | 通过 | 专用验收分类真实选择，来源/PDF/导读/解析/笔记范围预览及缺项控制有实际UI和隔离检查。 | 继续沿原材料与目标续传，历史界面不允许无效更改范围。 | ZOT, SETTINGS, TESTS |
| ZOT-04 | 通过 | 严格99项回读含原书目、顺序、URL/版本/实际未知字段；来源JSON与既有parent Extra保护分别核验。 | 限实际MiCLA，未知DOI/venue/日期/机构不造值，不称全库事实都齐全。 | ZOT |
| ZOT-05 | 通过 | 完整来源JSON10710B真实存储并匹配SHA，原评分7.5、结构字段、版本与来源未丢；旧字段不为美化追改。 | ORCID/许可等仅保存来源现有信息，缺项保持明确未知。 | ZOT |
| ZOT-06 | 通过 | 真实存储PDF489533B、SHA01ee…、13页，对应父项；Zotero客户端已实际打开物理5页。 | 不是临时链接或只探元数据；此记录之外的文件不授予成功。 | ZOT, HISTORY |
| ZOT-07 | 待验 | 真实导读存储870920B，3原SVG/4MathML/4表全内嵌；已在Zotero打开原图/图注。 | 明确断开App缓存或网络条件下从Zotero打开的记录仍未完成；自包含静态核验不能冒充严格断网实测。 | ZOT, HISTORY |
| ZOT-08 | 通过 | 真实新版解析含原426字选区、142字回答及问/模型/时间/页/SHA；研究笔记独立保存，旧父原摘要未替换。 | 旧legacy解析只按历史身份保留，不冒称也有426字新证据。 | ZOT, EXPORT, MODEL |
| ZOT-09 | 通过 | 9b原生六角色已全部显示成功；878重启后再次沿原检查点真实回读99项通过，原journal/操作身份可追溯。 | Zotero实际打开已有早先同材料证据；新宿主动作只按已留存证据记录，没有另建书目。 | ZOT, FINALGUI, HISTORY |
| ZOT-10 | 通过 | 878重启后重复比较10项通过，9对象/8子项/3文件/journal及模型账不变；早先实际重复/重启和隔离丢答反例仍保留。 | 重复比较10项不是10篇；不按中文标题合并，不声称真实逐种丢答均制造过。 | ZOT, HISTORY, TESTS |
| ZOT-11 | 通过 | 真实parent标题人工改后回读保完整JSON，再原生精确恢复；笔记/标签/删除附件等冲突保护另有隔离反例。 | 保留系统版本40→41及lastRead变化；不称从未修改、不删真实用户附件来凑测试。 | ZOT, HISTORY, TESTS |
| ZOT-12 | 通过 | 真实早期父/笔记已成而文件失败，原检查点保留并续为六角色成功；成功对象和旧费用未重建。 | 取消/应答不明等额外分支由隔离证据覆盖，不洗掉原失败历史。 | ZOT, HISTORY, TESTS |
| ZOT-13 | 待验 | 实际固定验收文库/分类正确；更换目标/权限/实例的拒绝与映射检查有隔离反例。 | 真实可编辑/不可编辑目标改变的UI见证尚缺；未为验收切换真实账号、改数据库或操作非验收资料。 | ZOT, SETTINGS, TESTS |
| ZOT-14 | 通过 | 真实成功始终限定本机文库，未宣称云文件同步；UI/报告与实现均未直接修改数据库。 | Zotero云同步状态不在本机回读结论内。 | ZOT, HISTORY |

## 证据索引与保存范围

日志、系统辅助功能树、截图、逐项回读和私人导出保存在本机忽略的`apps/macos/.qa/`，不随公开Git提交。以下路径用于本机查证；正式文档只记录结论与范围。外部独审产物保存在本聊天的本机产物目录，文件名对应构建身份。

- **PKG**：`apps/macos/.qa/live-e2e/installed-final-v17.json`；`外部独审产物 mac-final-3880de59-candidate-independent-audit.json`；`外部独审产物 mac-final-3880de59-installed-independent-audit.json`。
- **FINALGUI**：`apps/macos/.qa/live-e2e/guide-single-final9b.png`；`apps/macos/.qa/live-e2e/guide-split-final9b.ax.txt`；`apps/macos/.qa/live-e2e/analysis-pdf-final9b.ax.txt`；`apps/macos/.qa/live-e2e/export-native-final9b-saved.ax.txt`；`apps/macos/.qa/live-e2e/zotero-native-final9b-complete.ax.txt`；`apps/macos/.qa/live-e2e/help-native-final9b.ax.txt`。
- **TASK3880**：`apps/macos/.qa/final3880-task-metadata-review/result.json`（32项）；`apps/macos/.qa/live-e2e/tasks-final3880-independent-readback.json`；`apps/macos/.qa/live-e2e/tasks-final3880-page1-bottom.ax.txt`至`tasks-final3880-page8-bottom.ax.txt`及同名截图，另有第一页标题与筛选的顶部记录。
- **AX**：`apps/macos/.qa/live-e2e/tasks-native-final9b.ax.txt`；`apps/macos/.qa/live-e2e/notes-native-final9b.ax.txt`；`apps/macos/.qa/live-e2e/storage-native-final9b-ready.ax.txt`；`apps/macos/.qa/live-e2e/export-native-final9b.ax.txt`；`apps/macos/.qa/live-e2e/zotero-native-final9b-complete.ax.txt`。
- **SIZES**：`apps/macos/.qa/live-e2e/window-1280x800-split-final9b.ax.txt`；`apps/macos/.qa/live-e2e/window-min-single-final9b.png`；`apps/macos/.qa/live-e2e/window-min-split-final9b.ax.txt`；`apps/macos/.qa/live-e2e/window-min-divider-left-final9b.png`；`apps/macos/.qa/live-e2e/window-min-divider-right-final9b.png`；`apps/macos/.qa/live-e2e/fullscreen-single-final9b.ax.txt`；`apps/macos/.qa/live-e2e/fullscreen-split-final9b.ax.txt`；`apps/macos/.qa/live-e2e/find-native-final9b.ax.txt`。
- **SETTINGS**：`apps/macos/.qa/live-e2e/settings-model-final9b.ax.txt`；`apps/macos/.qa/live-e2e/settings-sync-final9b.ax.txt`；`apps/macos/.qa/live-e2e/settings-zotero-connected-final9b.ax.txt`。
- **APPEARANCE**：`apps/macos/.qa/live-e2e/guide-dark-final9b.png`；`apps/macos/.qa/live-e2e/guide-fontlarger-final9b.png`；`apps/macos/.qa/live-e2e/settings-dark-final9b.png`。
- **DATA**：`docs/mac-app-validation.md:公开网站全库/22分片8720记录8005论文`；`apps/macos/.qa/live-e2e/guide-single-final9b.ax.txt`；`apps/macos/.qa/live-e2e/turnguide-offline-native-e2742f10.ax.txt`。
- **OFFLINE**：`/Users/francis7999/.codex/visualizations/2026/10/22/01a162ed-db18-7000-8840-f9262fd79e83/turnguide-offline-package-readback.md`；`apps/macos/.qa/live-e2e/storage-native-final9b-ready.ax.txt`；`apps/macos/.qa/live-e2e/turnguide-offline-native-e2742f10.ax.txt`。
- **EXPORT**：`apps/macos/.qa/live-e2e/exports/final-v11-research-independent-readback.json`；`apps/macos/.qa/live-e2e/exports/final9b-guide.html`；`apps/macos/.qa/live-e2e/exports/final9b-original.pdf`；`apps/macos/.qa/live-e2e/exports/final9b-citation.bib`；`apps/macos/.qa/live-e2e/exports/final9b-citation.ris`；`apps/macos/.qa/live-e2e/exports/final9b-citation.json`。
- **BACKUP**：`/Users/francis7999/.codex/visualizations/2026/10/22/01a162ed-db18-7000-8840-f9262fd79e83/mac-native-exports-backup-independent-review.md`；`apps/macos/.qa/live-e2e/restore-native-final9b-confirm.ax.txt`。
- **MODEL**：`/Users/francis7999/.codex/visualizations/2026/10/22/01a162ed-db18-7000-8840-f9262fd79e83/mac-real-model-curated-independent-review.md`；`apps/macos/.qa/live-e2e/exports/final-v11-research-independent-readback.json`；`apps/macos/.qa/live-e2e/final9b-independent-evidence-review.json`。
- **ZOT**：`apps/macos/.qa/live-e2e/zotero-602F6E60-A78B-491D-8B0D-D3E07C95DD3C/readback-20261024T182412.048051Z/readback-result.json`（只读GET及文件，非新原生回读完成）；`apps/macos/.qa/live-e2e/zotero-602F6E60-A78B-491D-8B0D-D3E07C95DD3C/readback-20261024T174741.116180Z/readback-result.json`；`apps/macos/.qa/live-e2e/zotero-repeat-comparison-20261024T174744.854274Z.json`；`apps/macos/.qa/live-e2e/zotero-restart-final878-current.ax.txt`；`apps/macos/.qa/live-e2e/zotero-602F6E60-A78B-491D-8B0D-D3E07C95DD3C/readback-20261024T171751.075453Z/readback-result.json`；`apps/macos/.qa/live-e2e/zotero-repeat-comparison-20261024T171908.006176Z.json`；`apps/macos/.qa/live-e2e/final9b-independent-evidence-review.json`；`apps/macos/.qa/live-e2e/zotero-native-final9b-complete.ax.txt`。
- **DIAGNOSTICS**：`apps/macos/.qa/live-e2e/exports/final9b-diagnostics.json`；`apps/macos/.qa/live-e2e/help-native-final9b-diagnostics.ax.txt`。
- **HISTORY**：`docs/mac-app-validation.md`；`docs/mac-app-review-log.md`；`/Users/francis7999/.codex/visualizations/2026/10/22/01a162ed-db18-7000-8840-f9262fd79e83/mac-zotero-real-edit-protection-and-client-open.md`；`/Users/francis7999/.codex/visualizations/2026/10/22/01a162ed-db18-7000-8840-f9262fd79e83/mac-zotero-real-restart-repeat-83e4-success.md`。
- **TESTS**：`apps/macos/.qa/live-final-js-regression-v16.log`；`apps/macos/.qa/live-final-js-regression-v16-result.json`；`apps/macos/.qa/workspace-pagination-independent-final.log`；`apps/macos/.qa/live-final-source-regression-v11.log（保留旧DesktopUI19/20失败；原生/服务段已完成）`；`apps/macos/.qa/desktopui-final-find-fix.log`；`apps/macos/.qa/navigation-final-find-fix.log`；`apps/macos/.qa/reader-preamble/result.json`；`docs/mac-app-review-log.md（各轮独审、冻结SHA与适用范围）`；`apps/macos/.qa/live-final-source-regression-v14.log`；`apps/macos/.qa/live-final-source-regression-v14-result.json`；`完整取消保护独审记录见 docs/mac-app-validation.md`。
- **CANCEL878**：`apps/macos/.qa/live-e2e/export-cancel-final878.ax.txt`；`apps/macos/.qa/live-e2e/tasks-cancel-final878.png`；`apps/macos/.qa/live-e2e/tasks-cancel-final878.ax.txt`；`apps/macos/.qa/live-e2e/exports/final878-research.md`；`apps/macos/.qa/live-e2e/menu-backup-cancel-final878.ax.txt`。

本页没有修改旧失败、原费用、归档journal或来源身份。后续只在取得对应构建、条件及实际结果后更新该项状态；源要求仍以正式矩阵为准。
