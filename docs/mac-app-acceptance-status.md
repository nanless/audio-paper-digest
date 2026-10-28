# Mac应用69项实际验收状态

## 当前结果

截至2026年10月28日，实际安装的是107包，来源提交为`9c503127…`，构建时间为北京时间15:40。原生程序和构建说明文件的SHA-256分别以`3b2955d2…`、`9cc8b7f7…`开头。候选包和安装后的文件、权限、扩展属性及签名已经独立核对。应用保留第三个石墨图标，支持本机arm64、macOS 15及以上；使用本机临时签名，尚未公证，也尚未发布GitHub Release。

正式矩阵共有69项。按下文逐项表，目前为**61项通过、7项待验、1项发现问题**。本次发现的问题是窄栏、大字号下的长公式无法完整横向阅读；修复代码正在验证，不能将尚未安装的修复计为实际通过。其他新完成的检查也须在逐项核对后更新计数。

| 本轮检查 | 实际结果 | 后续工作 |
|---|---|---|
| Zotero完整归档 | Qwen论文的书目、完整来源、原PDF和新版自包含导读均已逐项回读；在Zotero自身打开新导读，完整中文题名正常显示。原父条目及旧附件保留。 | 没有个人解析和笔记时明确不选这两项；不把四项现有材料说成六项。 |
| 模型配置 | 在应用自己的安全输入框保存、删除并恢复选定账号，正常退出后重新启动，一次真实连接检查成功。原用量记录保留。 | 检查状态可能被迟到的设置读取结果覆盖；修复已通过针对性测试，待新包界面复验。 |
| 单栏与PDF双栏 | Qwen与SoFilNet真实导读均已实际查看；关闭PDF后使用单栏，重新打开后恢复双栏。SoFilNet原PDF为13页。 | SoFilNet长公式在最窄阅读栏及24号字时裁切，READ-03记为发现问题。 |
| 目录同步与任务 | 已实际从旧任务行重新同步，新增一条完成记录，旧记录及16份模型用量文件保持。手动、定时和唤醒重叠时重复建任务的问题已修复。 | 新同步实现已通过正常原生入口测试，待新包安装后登记版本。 |
| 每日更新 | 一小时间隔的定时检查已实际执行，随后恢复原12小时间隔。 | 仍须观察一次新网站部署的论文进入本机目录；不在本机重新生成论文来代替这项检查。 |

107的安装及实际检查记录位于`apps/macos/.qa/integration107/`。Qwen归档、模型密钥操作、单栏/双栏、任务行重新同步和SoFilNet长文检查分别保存，保留各自的原始失败及适用范围。这些本机记录不公开个人正文或凭据。下文101及更早版本继续保留历史结果，其中“当前”仅指相应检查当时的版本。

本页对应[正式验收矩阵](mac-app-acceptance.md)，不修改原69项要求。受控测试、原生实际操作和远端文件回读分别标明；缺少条件记为“待验”，已经实际复现的缺陷记为“发现问题”。

## 较早记录：101安装、正常回归与归档回读

当前使用的101安装包来自提交`95326632…`，构建于UTC 04:03:39（北京时间12:03:39）。原生程序与构建说明文件分别以`5a6f5f96…`、`67b740b3…`开头；候选、实际安装的完整文件、权限、扩展属性及签名已经独立核对，原17份资料和记录保持。仍是本机ad-hoc签名、未公证、未发布Release的正式资源通道包，不内嵌论文样稿。下文96和更早安装的“当前”只指各自当时的记录。

101对应源码的完整正常入口已完成44组Swift、58条Node入口（含4组TAP）及当时75项打包检查，均无失败或跳过。后来发行工具104的检查另有专项结果；106导出标题样式另通过79项真实WebKit与资料导出测试，不能将这些追加专项写成重新跑过完整入口。106尚待最终新包中重新导出，并在Zotero中查看题名；已有附件没有改写。

实际新账号绑定归档已保存Qwen论文当时存在的四项材料：书目、完整来源、原PDF及自包含导读；没有虚构个人解析或笔记。在Zotero自身打开31页PDF与导读后，正常退出应用，再由新进程回读同一归档，四项均核对成功，原条目、附件与检查点保留。MiCLA另一次新归档遇到多个既有父条目时安全停止，保留断点和原条目，没有合并或删除它们；这条拒绝记录不算新归档成功。

网站目录的一小时间隔定时检查已实际完成，并恢复原12小时间隔；尚未观察到新的线上部署进入本机目录，DATA-13继续待验。以上补事实不增加通过行，总表仍为61项通过、8项待验。安装与正常回归见`integration101/installation.json`、`full-normal-v1/independent-post-test-review-v1.json`；归档冷回读见同目录`actual/root-qwen-cold-readback-v1.json`及独立复核，定时记录见`actual/temporary-sync-schedule.json`。这些记录均位于`apps/macos/.qa/`，不公开个人正文或凭据。

该次记录为61项通过、8项待验。以下历史说明保留当时的检查范围；最新计数和已知问题见本页开头及逐项表。

## 2026-10-28：按原验收要求补齐尺寸、键盘与中文笔记

APP-04补入三个要求的精确原生窗口尺寸及9张公开MiCLA图文/PDF截图，与旧1280×800、实际最小窗、全屏、侧栏和分隔极限记录合并。APP-05与NOTE-01将已安装版的实际键盘/编辑记录，同93真实原生标记中文提交、发送保护及正常保存回读合并核对。原状态中“全部控件×全部输入法”超出原条款，不再将它当作新门；受控原生组合仍不冒系统候选窗口认证。前三项据此改记通过；101另补既有回答的实际向上阅读与问题框可达见证，LLM-06随之改记通过。旧记录与失败保留；这不代表实时逐字输出场景通过。

较早安装为 `9490c4f3…` 汇总原图、任务翻页和同步刷新修复包，采用正式资源通道。40 组 Swift、49 条 Node 命令及 59 项打包检查完整通过后，已独立核包、安装并检查真实任务分页、同页重读、目录同步和日更图片。当时的候选继续调整汇总正文读出、任务来源记录、继续阅读及公式显示，42 组 Swift、51 条 Node 命令和 59 项打包检查已通过；这些自动化结果没有关闭后续正式安装的正文读出失败，最新结论见下节。版本和适用范围见[测试记录](mac-app-validation.md)。此前坚果云快照的取消、重启、续传、完整回读与恢复，以及 Zotero 的既有回读结果，仍按原材料和未变化的服务实现复用；本轮没有把这些旧结果说成新包重新执行。[17 项专项验收](mac-app-cloud.md)继续分别记录。

2026-10-26新增a081原生资料库检索补验及非作者复核，仅将LIB-02改为通过。中文单字/双字、标题缩写、作者、编号、标点、标签、无结果、缓存导读和私人笔记均有实际界面记录；两种正文特有短语另与全部22份目录文件核对。操作结束返回原导读及PDF第5页，九组个人字段与同一原基准逐值相同；不扩展其他资料库、键盘、离线或冷启动条件。

同日129新增库内完整文献信息展开，并修复库条目和右键入口没有恢复原阅读页签/PDF的问题。真实编号、来源、完整作者、方法和标签可读，Space展开及多选保持通过，结合前次真库组合筛选、排序、批量和分页结果，仅再将LIB-01改为通过。实际跨论文返回保导读位置5168、PDF第5页与50%比例；右键返回亦恢复原笔记页签，主动关闭PDF后再进仍单栏。原185项任务完整保留，只新增10项正常读取任务，三个会话与原笔记等不变；READ-08整体仍待验。

797已修复设置不同分组沿用旧滚动位置的问题，并完成缩窗原生复验；同页重选和关闭重开仍保位置，APP-03整体不扩大通过。另在App不运行、其缓存路径已断开的条件下，从Zotero重开原导读附件并查看原图/图注/正文，原文件的图表公式和自包含性另经独核，缓存54项全部恢复；仅ZOT-07再升为通过。网络没有禁用，没有新建归档或声称重跑99项。

## 2026-10-28 困难PDF检查发现文字能力提示错误

同一安装包实际打开了四份明确标注的验收副本：13页旋转原文、13页加密原文、重复组成的390页长册，以及两页只有图像的扫描件。旋转显示、取消或错误密码保留旧资料、正确解锁，以及输入390后显示对应末页均已核对。长册由原13页重复组成，不是原论文有390页。

扫描件能显示，但页脚仍固定写着“可选择文字”。本机PDFKit对该页实际提取到的文字数为0，这项提示与文件不符；READ-09改记失败，须修正、安装并复验后才能关闭。取消解锁后多弹一次错误提示的问题也已登记。没有为检查调用OCR、模型或重新存档Zotero；原16份模型及归档JSON的字节和集合保持。Mac重启后设备号变化单独记录，没有据此误报资料损坏或重写旧基准。证据见PDF92。

## 2026-10-28 异常退出、阅读连续性与并发备份

在同一安装包中补验了进程被强制结束后的恢复。先从界面确认进行中任务为0、自动云备份暂停，再仅结束该应用的进程。17份个人资料、模型记录和Zotero归档记录在结束前后字节和文件状态相同。正常重启后，资料库先显示原8005篇论文；点击“继续阅读”，Qwen导读恢复原段落，PDF仍为第1/31页、108%比例。原笔记、摘录和已完成回答均可重新打开，16份模型及归档记录在这些操作后仍保持原字节。个人资料的后续阅读状态允许正常保存，不将其声称为重启后整文件未变。独立审查后，APP-08的异常退出缺口关闭；没有据此覆盖睡眠或所有运行中断时点。

READ-08结合既有真实切换、编辑和重启记录，与当前实现相同的阅读位置、字号及迟到回调测试，按原连续性要求补记通过。坚果云CLOUD-03结合既有真实传输及两个独立客户端同时上传的受控测试补记通过；这不是在用户云端制造并发，也不代表两台实体Mac实测。原要求未要求所有操作排列或实体多机穷举，不能将这些额外条件当作未完成的原要求。来源及检查范围见READCONT88与CRASH84。

## 较早安装：2026-10-28 操作栏键盘复验

当时安装来源为 `90887df3b6aa53865b02e871343bc3298778859c`，构建时间为北京时间2026年10月28日05:07。原生程序 SHA-256 为 `a76fd2238eef49cb370702a1bfe8083f1357c45ee6b887a557f5e371baf1b32b`，构建说明文件 SHA-256 为 `2164ddb7c451dad0445402275d308e98d9fd49586a5c3cb8c3d471632bf917c6`。候选和实际安装的515份文件、533个节点、550份输入、权限、扩展属性及签名均经独立核对；退出旧版后，个人资料原字节保持，旧应用另存以便恢复。仍为arm64、macOS 15起、本机ad-hoc签名，未公证、未发布Release，沿用第三个石墨图标。

本次修复了系统关闭“键盘导航”时，汇总页原生操作栏无法通过键盘到达的问题。实际冷启动后，全程用键盘从资料库进入网站页面及“关于与使用方法”，读出目录加载状态和3页结果，再进入正文、操作栏及只读来源说明。Tab、Shift-Tab、空格、目录末项的Return选择、正文查找和Escape退出均有系统读出记录。此前正文缺少读出区域及操作栏不可达的失败继续按各自版本保留；本次仅将APP-06改为通过，当时输入法组合仍归APP-05待验；本页后续结合EDIT93另行核对。

真实Qwen导读在单栏与PDF双栏之间切换后，阅读段落、PDF第1/31页及108%比例保持。三组受影响的独立回归分别通过36、49和13项，随后核包、安装及原生操作记录分别复核。没有为这轮界面复验追加模型请求或重新归档Zotero资料。

## 较早安装：2026-10-28 核对结果

当时安装来源为 `1a56ff9b9de5bf0da91d36d0588a34416a9f81c1`，构建时间为北京时间 2026-10-27 21:36。原生程序 SHA-256 为 `1a4262c8788a7581562bcc550eca1060dab7baf4fec0229b9f0327198cd21b85`，构建说明文件 SHA-256 为 `762376a0218d161fcc787ff36b26ebd8eae08178f1b7f27aaaa345721df8adf1`；仍为 arm64、macOS 15 起、本机 ad-hoc 签名，未公证、未发布 Release，保留第三个石墨图标。

本次核对既有实际操作和正常回归的39份记录，将 APP-03、DATA-04、LIB-03、NOTE-02 及云端表的5项补记为通过。它们分别补齐设置窗重开、特殊来源提示、列表更新关联、个人批注删除后冷启动，以及完整快照和故障保护；没有重复请求模型或重新上传资料。受控 HTTP、文件和时钟测试用于验证边界，不写成真实账号逐项故障。较早失败和各自构建身份继续保留。

该次安装在冷启动后打开“关于”页面时，完整正文可见，但系统辅助功能树缺少正文区域，APP-06当时改记失败。随后独立原生阅读区域先在隔离应用中验证，再进入正式安装包；本节保留当时的失败，最新结果见上节。

## 较早安装与证据复用

记录日期为 2026-10-27，时区为 Asia/Shanghai。实际应用位于 `~/Applications/论文速递.app`，来源提交为 `9490c4f3ae44b374e961f8d49a773e0bbd530e81`，构建于北京时间 08:24，08:28 安装。原生程序 SHA-256 为 `6a7b5887bce61b692c9efc55564e3edccf734f7766d0ac4f7fcc206c2c8fe23a`，构建说明文件 SHA-256 为 `8454f25366550c1322f91c370c694f341dbf7f0f276062396f53ab13617ed45d`。候选和实际安装的 513 份文件、531 个节点、546 份输入、权限、属性及签名均经独立核对。原第三个 C 图标、七组完整离线许可和不内嵌论文样稿的正式资源通道保持。仍为本机 ad-hoc 签名，未通过 Apple 公证，也未创建公开 Release。以下较早记录保留各自版本身份。

129覆盖当前33组Node回归和59项打包检查，原23套原生结果按17份Swift、测试与依赖逐字节相同复用，未虚称重新编译执行。Node首次在旧笔记重开测试前提失败，改为等待新frame及已恢复笔记页签后该组20项通过，其余已通过11组与后21组分别保留精确来源。阅读恢复原27项继续保留其实际版本身份。89的ZIP/DMG往返回核仍保留原版本身份，129尚未生成公开发行产物。实际启动仍读到原8005篇/8720条、收藏1及待读0；原个人资料保持。

797按实际引用补跑8组Node检查，其余25组按未变依赖复用；23套原生与59项打包规则保留原已验身份，不冒连续全跑。与129相比522输入仅Web/settings.js变化。新包正常冷启动整份个人文件与退出基准相同，原195项任务及三个会话保留，只新增3项正常读取完成记录；原导读位置5168、第5页、50%比例及单/双栏再次核对。797尚未生成公开ZIP/DMG。

以下8dd云操作及较早模型、Zotero结果保留其真实包身份。最终取消修复的完整回归为21套原生、31套Node测试命令及45项发行工具测试，退出0、五个冻结变更文件不变，远端CI通过。本应用原生安全框仅本次使用现有坚果云应用密码，不读写钥匙串；实际正常退出重启后内存密码消失、自动保存继续暂停，原快照及两个已核验块保留。8dd实际取消提示已正确显示，随后原九块及完成清单全部成功，独立核验器仅10次GET完成83项解码和原编码全字节比对。

真实恢复第一次在原生确认窗口取消，当前资料不替换；第二次确认后成功重新载入。83个原路径、82个非personal文件原字节、三个会话、16份模型材料、九项本机配置及原三条已派发身份和时间均保留；personal按正常保护合并且原字节另存。恢复前副本83项完整，云连接文件不变。非作者26项独立复核全通过。详细来源、旧失败及适用边界见[最新记录](mac-app-validation.md)。

原网站读取、模型、八格式导出等结果只按未变化材料及实现复用。8dd实际单栏及PDF双栏已再次查看；旧3880真实143任务逐八页AX通过仍保留原版本身份。a081实际一次进程中九页176条任务和原笔记正文均读出，但后续冷启动直接进任务页仍缺正文，其他真实导读/PDF路径也未稳定消除差异。正负证据同时保留，当时不能仅以逐页正例关闭冷启动问题，APP-06整体仍待验；后续修复及正式安装复验见本页最新一节。

## 较早待验记录（当前以逐项表为准）

当时，严格网络隔离并重启后读取离线包、从Zotero自身存储离线打开资料仍缺实际记录；后续补验见本页和测试记录，以下保留当时范围。已检查的原生尺寸为1280×800、最小1080×700，以及全屏单/双栏和38–62%分隔极限；其他精确尺寸和系统全局辅助外观没有扩大授予通过。核心键盘编辑链、部分库检索/定时/目标变化和困难PDF条件继续逐项待验。

真实模型研究与复用已有原426字选区、142字回答和3124tokens账本，未为重复验收追加付费。878与3880分别实际重启后完成六角色原生回读，各自新增99项实际回读和10项重复比较均通过；3880另由非作者回读33项通过。原journal、8子项、3文件、3会话及6条模型事件保持，旧legacy缺口单独保留。3880及ac7的早期系统钥匙串等待均已关闭；ac7于本机时间11:45完成本次原生六角色回读及只读GET99项核验。8dd的真实坚果云完整传输、续传、原生确认取消及实际恢复现已完成，独立回读范围见上文；自动定时、所有故障与多设备条件仍按专项表待验。本机Zotero回读不表示Zotero自身云端文件同步已经完成。

## 安装与原生桌面

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| APP-01 | 通过 | 96真实.app已安装；515份文件、533个节点与审定候选一致并独审，随包Node与完整许可，正式通道不含论文样稿。正常退出84后替换，17份个人、模型及归档JSON保持原字节与文件状态，旧包保留。原8005篇网站论文和个人资料仍可读。 | 限本机arm64/macOS26.6.1；不声称跨Mac发行、公证或自动更新。 | PKG96, PKG84, PKG797, FINALGUI |
| APP-02 | 待验 | 真实系统窗口、菜单、激活、退出与9b原生全屏单/双栏已有实机证据；878通过正常退出旧版、安装及再次启动。 | 最小化→恢复、关闭主窗→Dock重开后的完整上下文记录仍未齐全。 | FINALGUI, SIZES, HISTORY |
| APP-03 | 通过 | 旧小设置窗与五组读出，加f4真实五组切换、移动、缩窗、Cloud到底、关闭后主note/PDF保留、⌘,重开同Cloud组。 | 不要求逐组逐尺寸的关闭排列穷举；截图像素不等于NSWindow精确点数。新宿主若改变互斥只补接点。 |SETTINGS, HISTORY, CHECK74 |
| APP-04 | 通过 | 原1280×800、最小1080×700、全屏/侧栏及38–62%分隔结果保留；另以真实原生窗口和公开MiCLA图文/PDF检查1440×900、1728×1117、1920×1080，9张原图经非作者核对，主要动作未裁切。 | 限原要求的点数、主要控件与不重叠；不扩大为所有显示器/整页同屏，旧缩放标签问题另按101修复和实测记录。 | SIZES, SIZE94 |
| APP-05 | 通过 | 实际已安装版的当前文档/全库查找、⌘,、Return/Escape、Tab/方向键及复制粘贴/撤销重做，与93原生标记中文提交和组合期间发送保护共同覆盖原作用域要求。 | 93为macOS原生文本输入接口的标记/提交与正常处理链，不冒系统候选窗口或所有输入法认证；不新增“全部控件×全部IME”穷举门。 | FINALGUI, TESTS, EDIT93 |
| APP-06 | 通过 | 84正式安装已完成冷启动资料库、网站页面、汇总正文、来源说明、目录、查找及返回的连续键盘操作和系统读出；真实目录加载中与3页终态均可读。任务、笔记的选中及禁用状态沿用未变化实现的既有实证。 | 使用等价系统读出验证本机核心流程；不扩展为输入法组合或所有系统外观通过。旧正文缺区及80版操作栏不可达的失败保留。 | AX84, AX, TASK3880 |
| APP-07 | 通过 | 原浅/深色、放大字号、原图/PDF原色及设置失焦画面保留；96安装版另在系统增强对比度、减少透明度时实际检查阅读/PDF。系统减少动态效果开启时，正常原生阅读窗口读到相同偏好，网页计算样式显示滚动采用直接定位，检查的三个控件过渡为零；关闭后恢复原行为。 | 代表性系统条件与既有外观结果合并核验，不称每个控件的所有组合均已穷举。增强对比度会同时开启系统减少透明度，分别记录；三项系统设置均恢复原值。 | APPEAR96, APPEARANCE |
| APP-08 | 通过 | 既有首次启动、正常重启、升级、版本及资料位置记录保持；84新增真实强制结束进程后重启，17份个人/模型/归档JSON原字节保留，继续阅读恢复Qwen段落与PDF1/31、108%，原笔记与已完成回答可读，独立复核通过。 | 本次为无在途任务的异常退出；运行中断、睡眠及断网继续按DATA-10与JOB-03核验。升级和卸载说明保留私人库，不称所有时点均实际制造过。 | CRASH84, PKG, HISTORY |
| APP-09 | 通过 | 96候选与安装副本独审：arm64、最低macOS15、主应用/Node严格签名、C图标不变；550项实际输入与构建提交、当前检出及包内文件逐项核验。正式通道不含论文样稿，七组许可完整，明确ad-hoc未公证。 | 只覆盖本机发行声明；未承诺的跨机、公证和自动更新不授予通过。 | PKG96, PKG84, PKG |

## 已发布数据与离线

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| DATA-01 | 通过 | 实际22分片逐字节/SHA/数量核验，8720页面记录/8005去重论文，本机全库目录真实加载。 | 这是当次快照计数，不自动意味着后续所有新部署已同步。 | DATA, HISTORY |
| DATA-02 | 通过 | MiCLA日更、TurnGuide正式会议及既有日更/网站汇总的实际读取保留；96新增正常搜索并打开历史重写后的AllMusicCaps。真实重写提交、公开来源身份、当前目录与实际缓存文章逐项对应；正文原4个标签、9.1分及八维明细可读，未调用客户端LLM补写。 | 代表已记录的来源流程，不声称全8005篇都逐页检查。该历史页目录评分缺失时仍显示未知，正文保留原值；来源身份凭证不授予新的科学质量或评分结论。 | HISTORY96, DATA, FINALGUI |
| DATA-03 | 通过 | 实际arXiv明确版本及会议身份保留；原题/译题、未知DOI/作者机构不造值；旧式ID/版本/出现记录有独立反例。 | 结论限已核记录与来源规则，不推断所有论文机构完整。 | DATA, ZOT, TESTS |
| DATA-04 | 通过 | 原MiCLA/TurnGuide完整Reader、13/9页PDF、3引用格式和原站；special实际来源/非camera-ready警告与缺核链接时正常PDF拒绝已补。 | 不将special725B摘要称完整Reader，不造不存在的已核PDF；原要求保警告，不是强迫为特例补写全文。 |FINALGUI, EXPORT, OFFLINE, CHECK74 |
| DATA-05 | 通过 | 真实完整目录基线与Library事务/取消/坏分片/SHA/混版本/失败保旧等隔离反例均已核验。 | 反例是隔离真实HTTP/文件测试；不称整机断网同步实测。 | DATA, TESTS |
| DATA-06 | 通过 | 新增/更正/移除与私人资料保护有Library/Store隔离回归；真实个人笔记、旧回答、Zotero映射在实际同步/恢复后保留。 | 没有人为改线上发布内容或真实撤稿来凑验证。 | DATA, HISTORY, TESTS |
| DATA-07 | 通过 | 真实轻目录+按需2篇材料；反复浏览/导出/归档回读期间仍3会话6事件3124tokens，未新模型请求。 | 不把完整目录读取说成全库原文/PDF已离线。 | DATA, ZOT, MODEL |
| DATA-08 | 通过 | 96安装版正常退出后，在仅限制本应用网络的系统环境中冷启动，从既有完整离线包读出MiCLA导读、原方法图及PDF第5/13页。主动刷新明确失败并提示正在读旧导读；退出后19份离线文件及16份模型、归档JSON的字节和文件状态保持。 | 网络限制先用正常与受限的原生请求、子进程及网页请求分别核验。恢复正常启动后刷新成功，原云设置恢复；不扩大为睡眠恢复、运行中断或全机断网测试。 | OFFLINE96, OFFLINE, FINALGUI |
| DATA-09 | 通过 | 指定版本、SHA/MIME/404、缺图、坏包/缓存、同URL新版本及不静默替换有真实HTTP/文件反例；旧HTML公式缺口实机明确提示。 | 扫描/OCR不支持不得混入本项成功。 | OFFLINE, TESTS |
| DATA-10 | 待验 | 取消隔离、下载检查点及重启恢复规则已有测试，真实旧成功资料一直保留。 | 真实睡眠唤醒、同步/下载中断后仅恢复必要步骤尚无完整实机记录。 | TESTS, HISTORY |
| DATA-11 | 通过 | 真实容量/分类/离线快照均可读，清理预览0候选如实显示；临时实物测试核保护资料与删除/磁盘失败。 | 未执行真实用户库删除，不把0候选说成清理确认/删除成功。 | AX, OFFLINE, TESTS |
| DATA-12 | 通过 | 实际采用公开目录及明确HTML过渡适配，校验来源/科学DOM且不以LLM补缺；公开数据/包中不含费用账及凭据。 | 不冒称所有规划中的desktop/v1出口已部署。 | DATA, PKG, HISTORY |
| DATA-13 | 待验 | 手动全库同步与真实一小时间隔自动检查已完成，随后恢复原12小时间隔；日期使用网站日期且不本地重生成。 | 新的线上部署实际进入本机目录尚未取得见证；没有为验收改动线上论文。 | DATA, SETTINGS, TESTS, TIMER101 |

## 导读与PDF阅读

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| READ-01 | 通过 | 最终9b真实完整单栏，无空白PDF/永久聊天栏；长中英文题、缺会议作者、原来源信息保留。 | 以两篇真实长文为范围，不称所有未知稿式均验证。 | FINALGUI |
| READ-02 | 通过 | 实际单/双栏、解析/笔记左PDF右、最小窗口/侧栏与38–62%极限均工作。 | 精确窗口尺寸另见APP-04；不扩大为所有屏幕。 | SIZES, FINALGUI |
| READ-03 | 发现问题 | 原MiCLA图、表、式和原图注记录保留；107另用同一篇已发布SoFilNet实际查看方法图及完整原图注、4个公式、结果表、表下注和原文来源，并正常打开13页原PDF。 | 在38%阅读栏及24号字时，第四个长公式右端裁切，无法完整横向阅读；修复、安装及同篇复验完成前不能通过。 | SOFILNET107, FINALGUI, EXPORT, ZOT |
| READ-04 | 通过 | 原方法图/图注、PDF物理页、原8维评分及7.5原值保留；新页首去重不删除原正文、链接、评分明细。 | 不将API目录缺失字段重算成新评分。 | EXPORT, ZOT, TESTS |
| READ-05 | 通过 | 3880真实PDFKit原件：输入页码5、下一页6、上一页5，98%放大112%再适宽98%；原文查找MiCLA实际78处匹配，选择复制后粘贴MiCLA，再撤销恢复原问题。 | 原13/9页材料及SHA保持；扫描件/OCR和其他困难PDF条件仍按READ-09待验。 | FINALGUI, HISTORY, TESTS |
| READ-06 | 通过 | 426字原选区绑定PDF SHA与物理5页，真实回答引用/笔记摘录回跳及原图对应，错版本/越界有反例。 | 只证明实际材料页与选区，不宣称未提供内容或句级定位。 | MODEL, FINALGUI, ZOT, TESTS |
| READ-07 | 通过 | 真实PDFKit选区来源与封存输入核验；原生/DOM交错反例覆盖跨篇、ABA、旧PDF/预览迟到及引用版本。 | 核心路径用实际PDFKit，不把浏览器占位当原生证据。 | MODEL, TESTS |
| READ-08 | 通过 | 129真实跨论文返回、重开保原导读位置/PDF5/比例50及笔记页签；f4真实选区复制、保存、替换和撤销后恢复原笔记。84的Qwen单栏、双栏往返保持段落及PDF1/31、108%；当前同源27项连续性、6项导航交错、7项字号回归通过。 | 代表性真实操作与正常迟到回调、字号及布局反例结合核验，不要求所有排列穷举；输入法、严格离线及崩溃仍按各自项目记录，旧失败保留。 | READCONT88, LIBRARY21, AX84, HISTORY |
| READ-09 | 通过 | 原84实际旋转13页、加密文件错密保旧、正确解锁和390页重复测试册末页的结果保留。96安装版补验扫描件两页，均准确显示未提取文字、无OCR；取消解锁直接返回原扫描件第2页，正确解锁13页文字文档后提示随之改变。源码、正常混页测试、实际记录与截图均经独审。 | 390页是明确的重复测试册；扫描件只保证原件可读和提示准确，不声称OCR、图片解析或每页都能提取文字。旧84错误提示及取消后冗余弹窗的失败记录保留。 | PDF96, PDF92, FINALGUI, TESTS |

## 论文库

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| LIB-01 | 通过 | 真实8005篇组合375→22→13→4、评分排序、清除、多选批量待读2→1→0与分页已验；129库内可展开原编号/来源/全部作者/方法/标签，Space及多选保持通过，右键动作真实有效。原筛选/排序/清单函数未变，当前1227项组件回归通过，非作者复核。 | 限已测真实条件与未变逻辑，不声称每个日期值及每种排序都逐项实机穷举。 | LIBRARY21, DATA, TESTS |
| LIB-02 | 通过 | a081实际单字1569项、双字3016项、任务标签469项；MiCLA缩写、含标点名称、作者和arXiv编号各命中原论文1项，无结果0项。仅在私人笔记中的短语命中原arXiv论文，仅在缓存导读中的短语命中原会议身份；22份目录及其他文本来源均排除。清除后回到8005项，原个人字段及阅读位置保持，非作者复核通过。 | 限当次目录、既有缓存及笔记；PDF原文仍在阅读器内查找，不参与资料库全文索引。 | SEARCH18, DATA, TESTS |
| LIB-03 | 通过 | 真实待读1→冷启1→正常移出0及跨论文阅读保留；正常Library全148含新18：seeded收藏/待读/notes经正常catalog更名/移除/恢复和cold join，wholepersonal字节不变。 | 新reading只Set精确两ID+count2，不依赖Array(Set)顺序；不是人为改线上撤稿/用户资料。 |WANTED18, HISTORY, MODEL, TESTS, CHECK74 |

## 个人笔记

| ID | 状态 | 已有证据 | 未关闭条件或适用范围 | 证据组 |
|---|---|---|---|---|
| NOTE-01 | 通过 | 原119字笔记的系统粘贴/撤销重做/重开、实际中文选区编辑及回答存笔记，结合93原生中文组合提交、正常保存与重新打开资料存储后回读，以及已有写盘失败保留编辑反例覆盖原要求。 | 当前笔记承诺Markdown文本，链接/标记按原字符保存，不另承诺富文本编辑；不扩大为所有输入法与所有格式认证。 | HISTORY, FINALGUI, TESTS, EDIT93 |
| NOTE-02 | 通过 | 原创建/编辑/版本/来源回跳，加actual296真实PDF选3行→3新annotation→只删3→退出进程实停→新PID恢复原119与原singleannotation，e333非作者核保护。 | 限个人annotation store，不声称写回原PDF。无需重复删除或冷启。 |HISTORY, FINALGUI, TESTS, CHECK74 |
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
| LLM-06 | 通过 | 既有真实回答的选取/复制/存笔记、Return换行、输入区可达及组合发送保护已有合并记录；101另实际下读后向上滚回，延后聚焦问题框仍停留上部，固定输入区可见，PDF第5页保持。 | 本次只查看既有回答，12份模型使用记录未变，没有新请求；不冒实时逐字输出或所有输入法认证。 | FINALGUI, TESTS, EDIT93, UPSCROLL101 |
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
| ZOT-07 | 通过 | App不运行且自身缓存路径断开时，从Zotero重开原870920B导读附件，原图1/图注/正文可见；原SHA、条目身份与既有归档一致，3图/4MathML/4表及无自动外源独核，54项缓存和个人文件原样恢复。 | 按原“App缓存或网络”替代条件完成；网络未禁用，不声称新增逐表/逐式截图、99项重跑、Zotero云同步或Android通过。 | ZOTCACHE25, ZOT, HISTORY |
| ZOT-08 | 通过 | 真实新版解析含原426字选区、142字回答及问/模型/时间/页/SHA；研究笔记独立保存，旧父原摘要未替换。 | 旧legacy解析只按历史身份保留，不冒称也有426字新证据。 | ZOT, EXPORT, MODEL |
| ZOT-09 | 通过 | ac7本次原生六角色已完成，2026-10-25本机时间11:45后独立只读GET99项通过；9b、878与3880结果继续按原包身份保留，原journal/操作身份可追溯。 | Zotero实际打开已有早先同材料证据；新宿主动作只按已留存证据记录，没有另建书目。 | ZOT, FINALGUI, HISTORY |
| ZOT-10 | 通过 | 878重启后重复比较10项通过，9对象/8子项/3文件/journal及模型账不变；早先实际重复/重启和隔离丢答反例仍保留。 | 重复比较10项不是10篇；不按中文标题合并，不声称真实逐种丢答均制造过。 | ZOT, HISTORY, TESTS |
| ZOT-11 | 通过 | 真实parent标题人工改后回读保完整JSON，再原生精确恢复；笔记/标签/删除附件等冲突保护另有隔离反例。 | 保留系统版本40→41及lastRead变化；不称从未修改、不删真实用户附件来凑测试。 | ZOT, HISTORY, TESTS |
| ZOT-12 | 通过 | 真实早期父/笔记已成而文件失败，原检查点保留并续为六角色成功；成功对象和旧费用未重建。 | 取消/应答不明等额外分支由隔离证据覆盖，不洗掉原失败历史。 | ZOT, HISTORY, TESTS |
| ZOT-13 | 待验 | 实际固定验收文库/分类正确；更换目标/权限/实例的拒绝与映射检查有隔离反例。 | 真实可编辑/不可编辑目标改变的UI见证尚缺；未为验收切换真实账号、改数据库或操作非验收资料。 | ZOT, SETTINGS, TESTS |
| ZOT-14 | 通过 | 真实成功始终限定本机文库，未宣称云文件同步；UI/报告与实现均未直接修改数据库。 | Zotero云同步状态不在本机回读结论内。 | ZOT, HISTORY |

## 证据索引与保存范围

日志、系统辅助功能树、截图、逐项回读和私人导出保存在本机忽略的`apps/macos/.qa/`，不随公开Git提交。以下路径用于本机查证；正式文档只记录结论与范围。外部独审产物保存在本聊天的本机产物目录，文件名对应构建身份。

- **SOFILNET107**：`apps/macos/.qa/integration107/actual/read03-sofilnet/root-progress-v1.json`及同目录原图、系统读出和已发布正文副本。方法图、图注、表下注、来源和13页PDF已实际查看；长公式的裁切作为未解决问题保留，不以系统读出能读到文字代替屏幕可完整阅读。
- **QWEN107**：`apps/macos/.qa/integration107/qwen-new-guide-independent-v1/actual-closure-review-v1.json`；同一父条目的四项材料经独立只读回读，新增导读和既有附件分别核对；实际新导读题名截图保存在`actual/zotero-new-guide-ready.jpg`。
- **MODEL107**：`apps/macos/.qa/integration107/actual/root-model-credential-crud-cold-v1.json`；记录实际保存、删除、恢复、退出重开及一次真实连接检查，原用量文件保持。原检查状态显示问题与109修复的针对性测试分别保留，不混称新包界面已通过。
- **RESYNC107**：`apps/macos/.qa/integration107/actual/task-resync110/`；保存从任务行点击重新同步前后及新任务完成的实际系统读出，原模型用量文件没有新增或变化。
- **READCONT88**：`apps/macos/.qa/continuity-cloud-evidence88-v1/review.json`；当前读层函数与保存、PDF、草稿实现逐字节保护，`reading-continuity`、`navigation-reflow`、`font-continuity`三组当前源码正常结果，结合原LIBRARY21、f4编辑与84真实单双栏记录复用。隔离原生桥不冒充PDFKit或实际输入法。
- **APPEAR96**：`apps/macos/.qa/integration96/actual/root-system-appearance-v1.json`及`independent-system-appearance-review-v1.json`；系统偏好前后读出与实际截图分别留存，减少动态效果的正常原生观察另经Root核对源码及原始结果。既有浅深色、字号和失焦画面保留原版本。
- **OFFLINE96**：`apps/macos/.qa/integration96/offline/root-actual-v1.json`及`independent-actual-offline-review-v1.json`；20份明确操作材料、4张实际截图、进程身份及文件前后回读分别核对。网络限制预检见`apps/macos/.qa/offline-scope94-v1/`；只限制本次应用进程及其相关请求，没有改全机代理或网络。
- **TIMER101**：`apps/macos/.qa/integration101/actual/temporary-sync-schedule.json`及同目录`automatic-one-hour-sync-tasks.ax.txt`、`automatic-sync-original-12-hours-restored.ax.txt`；真实一小时定时检查完成并恢复12小时，不含新部署进入目录的结论。
- **UPSCROLL101**：`apps/macos/.qa/integration101/actual/root-existing-answer-upscroll-v1.json`，SHA-256 `efcdfbc8982ce2f776a000eedd9cb24eb142d96d90f36eab2f627224de820ecd`；非作者4张原图与8份明示材料复核为`apps/macos/.qa/integration101/actual/independent-existing-answer-upscroll-review-v1.json`，SHA-256 `be71e4b2d58f7869b77dbc03dd0d25766bbfdb82239a6870d08d5acbd483d307`。12份模型使用记录仅按完整集合、原字节和文件状态核对，没有解析或复制私人回答正文。
- **SIZE94**：`apps/macos/.qa/native-size94-v1/revision5/root-independent-review-v1.json`，SHA-256 `7bf939021f8074f06d62e92f91a1700759650d618c12a24a1e460eea71bda98c`；精确原生窗口和9原图的非作者复核，原PDF缩放标签问题不在该记录的通过范围。
- **EDIT93**：`apps/macos/.qa/acceptance-scope93-v1/keyboard-note-answer-contract-join-v1.json`，SHA-256 `af3d6404273c481ec409f6cf99ccd03194a6993bdf7d78c62c930de2c299af0c`；原生组合独立完整复核为`apps/macos/.qa/native-composition93-v1/root-independent-final-review-v1.json`，SHA-256 `044bb04da9a1c9846b46acfa1a1d6d6365ee8b51416851c9fce4a92e8e905fea`。已安装编辑/快捷键与受控原生组合分别标注，不含新模型请求。

- **HISTORY96**：`apps/macos/.qa/acceptance-scope93-v1/data02-zot13-readonly-review-v1.json`及`data02-actual-public-cache-join-v2.json`；实际操作的查询、加载、完整正文读出及截图保存在`apps/macos/.qa/integration96/actual/history-*`。同一历史页的重写提交、公开身份凭证、目录、缓存与实际文章对应，旧日更、会议及汇总结果保留原版本身份。
- **PDF96**：`apps/macos/.qa/integration96/actual/root-pdf92-recheck-v1.json`及同目录`independent-pdf92-recheck-v1.json`；7份材料、2张实际截图，补验扫描件两页的文字提示、取消解锁保留原页和正确解锁。正常混页测试见`apps/macos/.qa/pdf-text-status92-v1/independent-source-review-v1.json`，不冒称混页也走过实际GUI。
- **PKG96**：`apps/macos/.qa/integration96/independent-package-v1/candidate-review.json`、同目录`installed-review.json`及`apps/macos/.qa/integration96/installation.json`；候选、实际安装和保留旧84的完整树、签名、550项输入与17份资料保护核验。
- **PDF92**：`apps/macos/.qa/integration84/actual/root-difficult-pdf-actual-v1.json`；19份明确记录、4份原生截图，四份验收副本来源及原件身份另见`apps/macos/.qa/pdf-difficult92-v1/fixtures.json`及`independent-fixture-review-v1.json`。副本不当作新的科学来源，不进入发行包；系统重启与工具连接中断分别留证。
- **CRASH84**：`apps/macos/.qa/integration84/actual/root-crash-actual-v1.json`及`independent-crash-actual-review-v1.json`；16份显式记录、真实恢复截图、结束前后完整字节核对与重启后原模型/归档文件核对。个人原件仅私有保存，不解析或公开其正文，不读取钥匙串和完整性密钥。
- **PKG84**：`apps/macos/.qa/integration84/independent-package-v1/candidate-review.json`、同目录`installed-review.json`及`apps/macos/.qa/integration84/installation.json`；完整候选与实际安装清单、签名、旧应用及退出时个人文件的逐字节保护核验。
- **AX84**：`apps/macos/.qa/integration84/actual/root-actual-progress-v1.json`（68份记录、18项检查）及`apps/macos/.qa/integration84/independent-actual-review-v1/review.json`；四份截图逐图核对，系统读出及键盘路径保持原始记录。此前失败见`apps/macos/.qa/integration80/actual/root-keyboard-toolbar-failure-v1.json`。正常回归见`apps/macos/.qa/aggregate-toolbar84-v1/root-normal-v1/result-v2.json`，保留两次已执行结果并只续未执行的第三组，没有重复声明整套重跑。

- **PKG**：`apps/macos/.qa/live-e2e/installed-cloud-ac7f8099.json`；`外部独审产物 mac-cloud-ac7f8099-candidate-independent-audit.json`；`外部独审产物 mac-cloud-ac7f8099-installed-independent-audit.json`；`apps/macos/.qa/live-e2e/installed-final-v17.json`；`外部独审产物 mac-final-3880de59-candidate-independent-audit.json`；`外部独审产物 mac-final-3880de59-installed-independent-audit.json`。
- **PKG129**：`apps/macos/.qa/mac129-candidate-independent/result.json`、`installed-result.json`及`source-reuse-and-tests.json`；`apps/macos/.qa/library-metadata21/root-precommit-v5.json`、候选和实际安装回执。
- **PKG797**：`apps/macos/.qa/mac797-candidate-independent/result.json`、`installed-result.json`及`source-reuse-final-v2.json`；`apps/macos/.qa/settings-scroll25/native-installed25/result-v1.json`及对应独审。
- **ZOTCACHE25**：`apps/macos/.qa/zotero-cache-independent25/result-v1.json`及原子断开/恢复、原附件、原生截图记录；非作者`apps/macos/.qa/zotero-cache-independent25-review/review.json`。
- **LIBRARY21**：`apps/macos/.qa/library-metadata21/native-installed21/result-v1.json`及原生AX/截图/各阶段私人对照，独审`apps/macos/.qa/library-metadata21-independent/native-installed21/review-v1.json`；`apps/macos/.qa/library-combination18/result-v1.json`保前次真实组合、批量与分页范围。私人正文不随公开提交。
- **FINALGUI**：`apps/macos/.qa/live-e2e/guide-single-final9b.png`；`apps/macos/.qa/live-e2e/guide-split-final9b.ax.txt`；`apps/macos/.qa/live-e2e/analysis-pdf-final9b.ax.txt`；`apps/macos/.qa/live-e2e/export-native-final9b-saved.ax.txt`；`apps/macos/.qa/live-e2e/zotero-native-final9b-complete.ax.txt`；`apps/macos/.qa/live-e2e/help-native-final9b.ax.txt`。
- **TASK3880**：`apps/macos/.qa/final3880-task-metadata-review/result.json`（32项）；`apps/macos/.qa/live-e2e/tasks-final3880-independent-readback.json`；`apps/macos/.qa/live-e2e/tasks-final3880-page1-bottom.ax.txt`至`tasks-final3880-page8-bottom.ax.txt`及同名截图，另有第一页标题与筛选的顶部记录。
- **AX**：`apps/macos/.qa/live-e2e/tasks-native-final9b.ax.txt`；`apps/macos/.qa/live-e2e/notes-native-final9b.ax.txt`；`apps/macos/.qa/live-e2e/storage-native-final9b-ready.ax.txt`；`apps/macos/.qa/live-e2e/export-native-final9b.ax.txt`；`apps/macos/.qa/live-e2e/zotero-native-final9b-complete.ax.txt`。
- **SIZES**：`apps/macos/.qa/live-e2e/window-1280x800-split-final9b.ax.txt`；`apps/macos/.qa/live-e2e/window-min-single-final9b.png`；`apps/macos/.qa/live-e2e/window-min-split-final9b.ax.txt`；`apps/macos/.qa/live-e2e/window-min-divider-left-final9b.png`；`apps/macos/.qa/live-e2e/window-min-divider-right-final9b.png`；`apps/macos/.qa/live-e2e/fullscreen-single-final9b.ax.txt`；`apps/macos/.qa/live-e2e/fullscreen-split-final9b.ax.txt`；`apps/macos/.qa/live-e2e/find-native-final9b.ax.txt`。
- **SETTINGS**：`apps/macos/.qa/live-e2e/settings-ac7-min-reading.*`；`settings-ac7-min-model-{top,bottom}.*`；`settings-ac7-min-storage-{top,bottom}.*`；`settings-ac7-min-cloud-top.*`；`cloud-ac7-settings-min.*`与`cloud-ac7-settings-bottom.*`（均位于同一live-e2e目录）；`apps/macos/.qa/live-e2e/settings-model-final9b.ax.txt`；`apps/macos/.qa/live-e2e/settings-sync-final9b.ax.txt`；`apps/macos/.qa/live-e2e/settings-zotero-connected-final9b.ax.txt`。
- **APPEARANCE**：`apps/macos/.qa/live-e2e/guide-dark-final9b.png`；`apps/macos/.qa/live-e2e/guide-fontlarger-final9b.png`；`apps/macos/.qa/live-e2e/settings-dark-final9b.png`。
- **DATA**：`docs/mac-app-validation.md:公开网站全库/22分片8720记录8005论文`；`apps/macos/.qa/live-e2e/guide-single-final9b.ax.txt`；`apps/macos/.qa/live-e2e/turnguide-offline-native-e2742f10.ax.txt`。
- **OFFLINE**：`/Users/francis7999/.codex/visualizations/2026/10/22/01a162ed-db18-7000-8840-f9262fd79e83/turnguide-offline-package-readback.md`；`apps/macos/.qa/live-e2e/storage-native-final9b-ready.ax.txt`；`apps/macos/.qa/live-e2e/turnguide-offline-native-e2742f10.ax.txt`。
- **EXPORT**：`apps/macos/.qa/live-e2e/exports/final-v11-research-independent-readback.json`；`apps/macos/.qa/live-e2e/exports/final9b-guide.html`；`apps/macos/.qa/live-e2e/exports/final9b-original.pdf`；`apps/macos/.qa/live-e2e/exports/final9b-citation.bib`；`apps/macos/.qa/live-e2e/exports/final9b-citation.ris`；`apps/macos/.qa/live-e2e/exports/final9b-citation.json`。
- **BACKUP**：`/Users/francis7999/.codex/visualizations/2026/10/22/01a162ed-db18-7000-8840-f9262fd79e83/mac-native-exports-backup-independent-review.md`；`apps/macos/.qa/live-e2e/restore-native-final9b-confirm.ax.txt`。
- **MODEL**：`/Users/francis7999/.codex/visualizations/2026/10/22/01a162ed-db18-7000-8840-f9262fd79e83/mac-real-model-curated-independent-review.md`；`apps/macos/.qa/live-e2e/exports/final-v11-research-independent-readback.json`；`apps/macos/.qa/live-e2e/final9b-independent-evidence-review.json`。
- **ZOT**：`apps/macos/.qa/live-e2e/zotero-602F6E60-A78B-491D-8B0D-D3E07C95DD3C/readback-20261024T182412.048051Z/readback-result.json`（只读GET及文件，非新原生回读完成）；`apps/macos/.qa/live-e2e/zotero-602F6E60-A78B-491D-8B0D-D3E07C95DD3C/readback-20261024T174741.116180Z/readback-result.json`；`apps/macos/.qa/live-e2e/zotero-repeat-comparison-20261024T174744.854274Z.json`；`apps/macos/.qa/live-e2e/zotero-restart-final878-current.ax.txt`；`apps/macos/.qa/live-e2e/zotero-602F6E60-A78B-491D-8B0D-D3E07C95DD3C/readback-20261024T171751.075453Z/readback-result.json`；`apps/macos/.qa/live-e2e/zotero-repeat-comparison-20261024T171908.006176Z.json`；`apps/macos/.qa/live-e2e/final9b-independent-evidence-review.json`；`apps/macos/.qa/live-e2e/zotero-native-final9b-complete.ax.txt`。
- **DIAGNOSTICS**：`apps/macos/.qa/live-e2e/exports/final9b-diagnostics.json`；`apps/macos/.qa/live-e2e/help-native-final9b-diagnostics.ax.txt`。
- **SEARCH18**：`apps/macos/.qa/library-native18/results-v1.json`及追加作者/编号的`results-v2.json`、逐次原生AX和两份保存前后对照；非作者报告为`apps/macos/.qa/library-native18-independent/review.json`及`review-v2-delta.json`。私人检索短语和正文只保存在本机忽略目录。
- **WANTED18**：`apps/macos/.qa/library-wanted18/result-v2.json`、加入/退出/冷启动/移出/返回阅读的AX与原保存件；非作者报告为`apps/macos/.qa/library-wanted18-independent/review-v2.json`。原v1阶段开始与最终保存位置不等的观察继续保留。
- **HISTORY**：`docs/mac-app-validation.md`；`docs/mac-app-review-log.md`；`/Users/francis7999/.codex/visualizations/2026/10/22/01a162ed-db18-7000-8840-f9262fd79e83/mac-zotero-real-edit-protection-and-client-open.md`；`/Users/francis7999/.codex/visualizations/2026/10/22/01a162ed-db18-7000-8840-f9262fd79e83/mac-zotero-real-restart-repeat-83e4-success.md`。
- **TESTS**：`apps/macos/.qa/cloud-full-v6-result.json`；`cloud-js-v7-result.json`；`cloud-settings-v11-144-independent-result.json`；`settings-recovery-v11-final-independent-result.json`（均在同一.qa目录）；`apps/macos/.qa/live-final-js-regression-v16.log`；`apps/macos/.qa/live-final-js-regression-v16-result.json`；`apps/macos/.qa/workspace-pagination-independent-final.log`；`apps/macos/.qa/live-final-source-regression-v11.log（保留旧DesktopUI19/20失败；原生/服务段已完成）`；`apps/macos/.qa/desktopui-final-find-fix.log`；`apps/macos/.qa/navigation-final-find-fix.log`；`apps/macos/.qa/reader-preamble/result.json`；`docs/mac-app-review-log.md（各轮独审、冻结SHA与适用范围）`；`apps/macos/.qa/live-final-source-regression-v14.log`；`apps/macos/.qa/live-final-source-regression-v14-result.json`；`完整取消保护独审记录见 docs/mac-app-validation.md`。
- **CANCEL878**：`apps/macos/.qa/live-e2e/export-cancel-final878.ax.txt`；`apps/macos/.qa/live-e2e/tasks-cancel-final878.png`；`apps/macos/.qa/live-e2e/tasks-cancel-final878.ax.txt`；`apps/macos/.qa/live-e2e/exports/final878-research.md`；`apps/macos/.qa/live-e2e/menu-backup-cancel-final878.ax.txt`。

本页没有修改旧失败、原费用、归档journal或来源身份。后续只在取得对应构建、条件及实际结果后更新该项状态；源要求仍以正式矩阵为准。

CHECK74：2026-10-28 对既有验收记录逐项核对；39份引用文件的 SHA-256 与原记录相同。仅补记上述4项，云端另表记5项；没有重跑付费服务、改变69项要求或授予未测试条件。
