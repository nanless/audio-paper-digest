# Mac 应用独立审查原始记录

以下按独立审查者的实际记录保留发现、修复和复验。局部源码或隔离测试通过，不授予真实模型、用户文库或全部Mac窗口通过；最终状态见[实施与验收记录](mac-app-validation.md)。

## 2026-10-24 续验：真实失败、修复与独立复验

本节更新此前五轮之后的续验结果。主任务已在真实原生应用中完成模型研究、导出和备份恢复，并继续发现问题；本节审查者核对源码及限定范围的隔离证据，没有并行操作真实窗口、钥匙串或用户文库。**69项验收矩阵没有整体通过，旧候选的实际结果不能自动继承给后续修复包。** 最新候选身份、真实操作和用量见[实施与验收记录](mac-app-validation.md)。

### 已确认的实际进展与仍然失败的旅程

- 主任务确认，`08:12:13` 候选真实完成一次完整模型检查及 MiCLA 物理第5页选区研究；实际返回模型、Responses协议、用量和封存输入均保留，相同材料再次发送实际复用。此前 `incomplete` 失败及原消耗没有改成成功或清零。这些真实服务证据与下表的测试凭据、模拟接口分别记账。
- 八种格式已通过原生保存窗口形成真实文件，备份与恢复也已实际执行；独立产物核验范围见验收记录。恢复后实际打开了固定离线快照，但没有完成断网重启全旅程，不能据此通过完整离线条件。
- 真实 Zotero 仅部分完成：专用验收分类中的原父书目、个人解析和笔记已回读；三个文件附件原先被拒绝。尚未取得修复后新包对 PDF、导读和原始元数据附件的完整逐文件回读，不能记完整归档成功。
- 真实个人解析中的 `[p.5]` 曾让子 iframe 载入整份应用，PDF没有正确定位。这次失败保留，尚须新包实机点击复验。主窗资料、导出等面板也曾视觉正常而系统辅助功能树为空；设置窗已有局部真实修复证据，不能替主窗授予通过。

### 本轮发现、修复和复验

| 发现与触发条件 | 修复及已有证据 | 本轮结论 |
|---|---|---|
| 个人解析页码链接让子 iframe 导航到应用页面；旧回答还可能指向错误材料 | 使用已注册的受控链接，由实际 `WKNavigationDelegate` 先取消子导航，再交父页面核活动 frame、论文代际、来源版本、材料页集合和实际 PDF SHA。导出克隆正文还原原公开链接，临时能力不外泄 | 作者实际隔离 WK/Library 21项、生产DOM及明确原生事件夹具8组；非作者另复跑 WK21项、安全3组和内容/辅助功能12组。源码及隔离范围已闭环；新包真实页码跳转待验 |
| 归档按需加载导读时先赋全局状态，随后才拒绝目录 v2 与当前 v1 不符，污染后续研究材料 | 先在局部核对 article 与当前论文来源，再安装 `currentArticle`；实际 Library 负例核旧身份不接受新稿，后续 guide 材料仍不可用，私人数据字节不变；相符版本正例可准备归档 | 已纳上述实际 WK/Library 21项，由非作者复验；没有冒充真实 Zotero 写入 |
| Zotero 的 imported-file 创建按字段顺序处理；旧排序在 linkMode 前处理 filename 而被拒。上传前 HTTP200 又可能返回尚不存在文件的 URL | 先正常JSON编码 linkMode，再拼接其余正常编码字段；保留原文件名。空文件只在已有实际创建及从未验证证明、且 marker 严格相等的应用槽中允许上传；文件存在仍核大小和 SHA | 非作者读取已安装 Zotero 应用的真实原函数，在隔离VM执行6项检查通过；这证明本机实现合同，不证明真实附件已上传 |
| 旧 journal 仅有 `verified=false`，无法证明“从未验证”；新 journal 接管旧附件也不能凭本次未验证就重传用户已删文件 | `everVerified` 使用未知、明确未验证、曾验证三态；只有当前实际创建成功的槽能记明确未验证，采用旧附件保持未知，同 key 已知状态保留，曾验证只升不降 | 独立聚焦复现先失败，修后重新编译实际 service：旧schema恢复、全新journal采用旧缺失附件均保持 partial 且上传POST为0。实现者150项模拟断言也通过。两个独审发现关闭，真实新包续传仍待验 |
| 本机资料读取、整理计划或清理完成的迟到回包覆盖新打开的帮助/导出面板 | 为每次显示捕获实际容器、代际和连接状态；失效结果不得覆盖新面板或重新打开旧资料界面 | 7组交错回归由非作者复验；限定生产DOM及受控桥接夹具，无真实文件删除 |
| 主窗详情面板视觉正常而系统辅助功能树为空；外容器来自曾隐藏的 dialog，只迁移控件仍未恢复读出 | 每次打开详情时仅更新外 wrapper，保留实际子节点与事件；帮助、导出、本机资料共用，资料请求在更新容器后捕获身份；Zotero原控件不重建 | 非作者读码及4组实际DOM/Chromium辅助功能检查通过，含8种导出命令、异步归档和嵌套返回。真实Mac主窗辅助功能仍待新包，不以Chrome结果代替 |
| 快速字号操作丢连续增量，未等阅读位置保存；隐藏导读读到 scrollY=0；旧字号回包又覆盖另一窗口的新外观设置 | 共享可等待字号队列，先保存实际阅读位置再提交；隐藏前捕获位置、显示后恢复；设置事件独立排序并在队列后重读最新配置；退出/备份前等待队列。失败可见且不乐观改字号 | 作者7组、非作者3组通过；非作者实际复现的隐藏位置与旧配置两项修后均关闭，连续边界16–24正常。实机字号旅程仍待验 |
| 研究卡片直接展示技术JSON、UTC时间和内部枚举，且真实 published-reader 来源曾漏映射 | 用真实顶层输入/输出/合计字段简洁显示，兼容两类协议；缺项保持未知，不推算合计或重复加 reasoning。状态和来源映射中文，本机时区显示日期，无效日期未知；原始用量记录保留，不改写或推算 | 作者展示回归核真实计数、0、缺项、无效值、时区及原始记录不变；来源漏映射经非作者指出后修复。实际模型、失败状态与来源证据仍保留 |
| 恢复资料后仍沿用恢复前的同步定时器；资料库说明暗示下载后的 PDF 已参与全文索引 | 新服务全部初始化成功后重新配置定时器，先使旧timer失效；搜索初始、成功、降级及空查询文案、Library返回范围和LIB-02统一明确不检索PDF原文 | 独立读回调用位置和范围一致；实现者Native27包含真实Timer interval与invalidate检查。没有新增PDF全文索引能力或声称全部离线检索完成 |

上述数量属于不同套件及作者/非作者边界，不相加当作新验收项目或审查轮数。读已安装 Zotero 应用源码、执行其隔离原函数，和向运行中的用户文库实际归档是不同证据；实际 WKNavigationDelegate 测试也不替代最终安装包的窗口操作。

独立性另作说明：本节记录者受主任务明确委托实施页码路由、归档导读校验顺序、部分辅助功能修复、字号及展示改动，对这些实现回避自我批准，已交另一位审查者复验；Zotero附件单调保护、详情 wrapper 和定时器等由其他实现者修改，本记录者按上述范围独审。临时夹具没有请求真实付费服务或操作用户文库。

### 本轮收口条件

完整隔离测试v3、v4已通过，后续界面改动再通过全部15个相关界面套件v5；原失败记录保留。当前安装包b4e843e7的505项清单、候选与安装版497文件、签名和新C图标已由非作者核验。主窗弹窗AX在该实机包仍失败，不能继承浏览器通过结论。以下三项明确继续待验：

1. 沿原归档检查点完成真实 Zotero 附件上传，并逐项回读父书目、PDF、导读、原始元数据、所选解析/笔记及实际文件字节；保留重复与用户编辑保护边界。
2. 在干净新进程检查主窗资料、导出、帮助和归档面板的系统辅助功能与键盘可达性。
3. 从真实个人解析点击页引用，确认仍是同一应用、同一材料版本，PDF定位正确且子frame不再载入应用。

其余尚未执行的69项边界继续按矩阵记录，不因完成五轮、代码审查或隔离测试数量足够就整体通过。


## 解锁后真实验收追加：已确认事实与本批修复

2026-10-24。以下真实操作由主任务执行并确认；本节记录者只整理已确认事实，没有读取用户私人应用目录、操作钥匙串、并行运行同一私人空间或请求真实服务。此前锁屏和旧候选包记录保留为当时状态，不再表示当前仍未解锁。69项 M 不整体记通过。

### 已确认的真实操作

- Mac 已解锁，构建时间标记为 `07:07:16` 的候选已安装并在真实原生窗口运行。完整 builtAt、签名后二进制SHA和随后修复包的启动对照由主任务补记；不沿用前一候选SHA冒充本包。
- Zotero 10.0.6 的原生持续授权已完成。授权成功不等于书目和所有附件已经完整写入、回读或完成云端同步。
- MiCLA 原 PDF 的物理第5页已实际阅读，已进行选区高亮；119字中文笔记与批注实际保存。
- MiCLA 离线包已实际创建。尚不据此认定断网重启阅读、所有导出格式或损坏恢复已完成。

### 真实发现、处置与复验边界

| 发现 | 原始证据 | 本批处置/已有测试 | 当前结论 |
|---|---|---|---|
| 模型检查HTTP200但不完整，旧UI丢失实际用量 | 首次真实check为 `incomplete`；供应商报告input155、output1024、reasoning1022。底层费用已经留账，旧客户端没有呈现该失败用量 | worker/ModelService保留截断及无正文失败的usage、协议、终态和实际模型未知状态；80项检查/25次loopback请求通过 | 真实失败记录和原消耗保留，不能写零或当完整成功；修复待新包真实复验，金额仍未知 |
| App没有明确承接项目现行的流式与推理配置 | 项目当前为Responses流式及low；旧worker没有显式应用这些参数 | 增加独立的responsesStream布尔和reasoningEffort枚举，实际预算/设置进入封存输入、复用身份、会话与归档来源记录；12组设置回归通过 | 配置和隔离回归已修，不推断为真实服务已经返回完整回答；不暗读生产.env，也不复制整个账号池 |
| 已发布评分字符串被当成缺失 | MiCLA线上结构化score为 `"7.5"`；首分片1,047,278字节、483记录及原SHA核对。Library旧实现只收NSNumber，原文仍有实际7.5分 | 只兼容已发布score字段中的有限0…10数字/数字字符串，拒布尔/越界/无效值；不解析正文猜分、不重新合计维度。Library130项通过 | 已交非作者源码独审，限定范围未发现新增问题；新包同步重读及真实显示仍待复验 |
| 旧式arXiv在目录和归档间规则不一致 | Library曾支持math/0101001，而归档版本提取及Zotero准入只覆盖现代编号；规范uppercase两字母分类还可能丢身份 | 新增共用纯验证器，三处一致保留规范大小写、月份和正版本，核原论文base与sourceVersion相同，拒尾串/注入；Library130、归档设置61、Zotero模拟106通过 | 本批由数据实现者修复，另由非作者只读独审，限定范围未发现新增问题；不将模拟测试说成所有历史论文真实归档成功 |
| 标题/锚点与科学DOM处理不完整 | 主任务在真实MiCLA阅读中发现目录/页首显示与正文处理问题 | 标题、锚点、重复标题及科学DOM修复正在review | 尚未记新包真实窗口通过 |
| 辅助功能树控件消失 | 真实原生辅助功能检查发现控件未正确保留 | 正在修复 | 未关闭，须另行review并在新包检查系统读出与键盘路径 |

上述130、61、106、80和12分别属于不同测试集，不是新增验收项目数或独立审查轮数。loopback使用测试凭据，不访问真实收费服务；模拟Zotero不操作真实文库。原生真实授权和第一笔真实模型失败是另行记录的实际操作，不能混为同一类通过证据。

### 下一次有效闭环

主任务完成科学DOM与辅助功能修复review后，集成并记录新包，复验真实模型完整检查/论文研究/复用、Zotero完整材料归档与逐项回读、离线重启，以及相应原生界面。新成功证据追加在原失败之后，保留原用量和费用；不改旧失败为成功，不以代码轮数或HTTP200授予全部69项通过。


---

## 主集成五轮独立审查

# 可安装 Mac 应用：独立审查记录

本记录从正式应用实施开始，区别于此前浏览器原型审查。审查者主要维护验收矩阵、执行只读检查和记录发现，修复交回实现者。第三轮明确受托实现 settings.js 保存排空模块，因此对此模块回避独立批准并交他人复审；其余模块保持独立，只新增隔离回归测试。

## 验收基线

已核对产品规划、静态数据合同、499 行 Mac 界面研究、原型验证与现有原型操作。用户新要求是完整可安装 Mac 应用，至少五轮修改、测试、独立审查和问题修复复验，尤其真实 Zotero 全资料归档。

仓库权威清单：`docs/mac-app-acceptance.md`，当前为 69 个唯一 M 项，全部初始待验。覆盖真正 `.app`/系统窗口、菜单与设置，真实全库与离线、单/双栏、正文图表公式、私人资料、钥匙串与真实模型/费用、任务恢复、导出备份和 14 项 Zotero 要求。

旧原型的 `e7fadd0e`/`6f041f85`、16 组 smoke、18 条独立记录仅为原型范围历史证据，不能授予新 `.app` 原生行为、真实 LLM 或 Zotero 完成。

## 逐轮记录

| 轮次 | 构建/实质修改 | 实现者测试 | 独立审查 | 发现与修复复验 | 当前状态 |
|---|---|---|---|---|---|
| 1 | 原生 AppKit/WebKit/PDFKit 集成，实际构建身份待主任务登记 | 已有底层测试和主任务原生单步操作，待定版结果 | 已完成滚动源码审查与真实窗口只读观察 | N-01…N-19 已提出，修复复核进行中 | 进行中，未记通过 |
| 2 | 2026-10-24T04-33-27.721744_00-00；来源、恢复、导出、设置与 native bridge 复审 | 主任务提供 Store22/Library59+线上引用6/Model41+8 loopback/DesktopNative22/DesktopUI15/Zotero53；本轮不重复无变化全量测试 | 已完成只读源码检查；锁屏期间未操作真实窗口 | 新发现 R2-01…R2-08 与能力缺口，已即时交主任务修复 | 修复/针对性复验进行中，不通过 |
| 3 | Round2 八项修正及持久研究上下文、进度、路径迁移集成；新统一构建待登记 | 主任务提供 Native22/Evidence8/Backup19/Library81+线上8/Zotero64/Model45+11 loopback；UI fixture 修订中 | 只读重查集成源码；2 项 Promise 交错独立复现 | R3-01…R3-05 已即时交回，修复复验待定版 | 进行中，不通过 |
| 4 | 真实离线包/容量/保护性缓存清理、原生维护互斥、按论文研究上下文、批注编辑/索引、v2包身份 | 设置保存模块10组隔离浏览器交错；其他矩阵由主任务登记 | 设置模块由本审查者受托修复后交别人审；其他模块只读独审，原生离线元数据正例独立执行 | R4-01…05修复源码复核；密码本地PDF/个人搜索范围/删除错误反馈3项待处理 | 修后复核进行中，真实服务与锁屏交互待验 |
| 5 | 本地密码PDF/个人搜索/删除反馈收口；来源新鲜度、v1/v2隔离、任务身份与真实模型记账修复；冻结源码见 round5-closure-evidence | 主任务综合发行构建另登记；本人实际 Native25、隔离DesktopUI18与个人搜索回归 | 最终来源/保存/取消/身份/异常链只读独审，真PDFKit提取；设置实现回避 | R5-01…07逐项修复与针对性复验；跨agent来源/worker loopback另注明范围 | 本轮已测代码范围收口；原生锁屏交互/真实LLM/Zotero闭环待验，不授予全部M项通过 |

五轮为最低要求，必要时继续追加。真实外部服务受阻与未测保持受阻/待验；不以重复截图、重复同版本测试或增加审查人数凑轮数。每轮结论限定实际构建和覆盖范围。

## 当前结论

已形成实际 arm64 原生安装构建，至少五轮实质变化及独立审查发现均已有记录；第五轮新增七项问题已修并按范围复验。当轮冻结源码及25项独立原生隔离测试见本文第五轮。后续 Mac 已解锁并执行真实原生操作，新增模型失败、评分/编号和辅助功能发现见本文开头的追加记录；真实模型完整研究、Zotero完整归档回读及全部原生旅程仍待端到端证据，69项不能整体授予通过。

## 第一轮：实现形成期间的独立代码审查

当前为滚动源码检查，尚未编译完整 `.app`，因此不把这一节算作已完成一轮应用验收。读取范围包括 `ZoteroService.swift`、`DesktopStore.swift`、`ModelService.swift`、`llm-worker.cjs`，并沿调用关系检查 `Main.swift`、`AppDocuments.swift` 和 `LibraryService` 初始化。未修改实现或测试源码，以下发现已交实现者修复。

| 编号 | 严重性/范围 | 发现与实际触发条件 | 当前处置 |
|---|---|---|---|
| N-01 | P1 / ZOT-11 | 已存在管理附件的当前 MD5 不同，直接以新读到的 MD5 为 If-Match 上传，会覆盖用户在 Zotero 改过的文件 | 实现者已改非空不符为冲突；还检查无 MD5 但已有真实文件的情况。待隔离和真实回读复验 |
| N-02 | P1 / ZOT-04/05/09 | 复用已有同身份条目只核身份即将 bibliography 标 verified，输入中额外摘要、日期、机构/来源元数据可能全部未保存 | 已交实现者；应保护原字段并用可回读的应用管理元数据材料保全输入，不能默覆盖人工编辑 |
| N-03 | P1 / READ-07、LLM-05 | 切到 B 后仍保留 A 的 PDF/文本；page/full 解析会以当前 B 身份标记 A 原文。晚返回的 A 导读可覆盖 B | 已加入清旧上下文、PDF owner、导读返回身份检查和模型 owner 捕获；继续检查所有 await 边界 |
| N-04 | P1 / READ-07、ZOT-03 | openPDF 下载前未捕获身份，返回后可将 A 文件的 owner 设为当前 B；archiveMaterials 先将旧 A 正文写入全局，之后才因切 B 拒绝 | 已交实现者，需先局部保存返回值并校验当前身份/版本，再安装 PDF 或正文 |
| N-05 | P1 / NOTE-01、LLM-08/09 | saveReading/upsertJob/appendSession 先改内存再落盘，失败不回滚；保存最终付费响应失败后 snapshot/复用仍可能看到未持久 complete | 实现者已为三个入口加回滚，并先写独立 response 恢复文件再保存 session；待故障注入 |
| N-06 | P2 / LLM-09 | 同一后台线程先读 stdout 到 EOF 再读 stderr，和注释“同时排空”不符；stderr 填满可阻塞子进程 | 已改 stderr 进入 0600 的独立日志，避免双管道互等；待运行验证 |
| N-07 | P1 / LLM-07 | 复用指纹未包含实际 system prompt、提取/模板版本；升级提示后可能错误复用旧回答 | 已交实现者；最终 messages 和版本应绑定同一指纹，source 用规范 JSON，避免 Swift 字典 description 顺序影响复用 |
| N-08 | P1 / LLM-04/05/09 | 会话只存 source 元数据和问题，未封存实际发送材料；无法准确重放当时输入。全文只截前 240000 字符仍可能被误称完整全文 | 已交实现者；保存真实输入/原字节 SHA、提取版本和实际范围，截断须在发送前与结果中披露 |
| N-09 | P1 / JOB-02/03 | jobs.cancel 无论传入何任务 ID 都调用 library.cancelSync，取消模型或无效 ID 可误取消独立同步 | 已交实现者，取消必须按真实任务种类与身份路由 |
| N-10 | P1 / EXP-03 | restoreData 替换 live 目录后才创建 LibraryService，坏 current.json 可在旧库移走后抛错，留下新旧服务混用且不回滚 | 已交实现者；须在 stage 验证全部合同并原子切换，或对目录与所有服务执行可回滚替换 |
| N-11 | P1 / NOTE-01、EXP-03 | DesktopStore.init 仅要求 JSON 字典，恢复仅查 schema=1；notes 等错误类型可被接受，下次编辑回落空字典导致资料丢失 | 已交实现者；需 schema 与各字段完整类型校验，未知版本和坏资料拒绝并保留原文件 |
| N-12 | P1 / ZOT-08、EXP-01 | analysisHTML/Markdown/HTML 研究导出只写问题和正文，丢 PDF SHA、页/范围、源版本/模型/用量关系 | 已交实现者；导出与归档必须携带真实来源和用量未知状态，不能断开 [p.N] 的原文绑定 |
| N-13 | P2 / LLM、ZOT-08 | model.check 的成功 session 与论文研究相同，按当前 paperID+complete 筛选可把“连接成功”检查归档成个人研究 | 已交实现者；连接检查应有单独种类并排除研究历史/归档 |
| N-14 | P1 / DATA-08、ZOT-07 | HTML 校验把所有 href=https 视为普通外链，SVG image/use 的远程 href 因而可通过“自包含”检查 | 已交实现者，明确负例为 svg image href=https；应按元素/属性语义拒绝外部资源，而不禁止正常 a 链接 |
| N-15 | P1 / DATA-08、LLM-10 | native.js 图像 src/xlink:href 允许 HTTPS，frame CSP 允许远程图；未缓存的 arXiv 图可由 WebKit 直连，绕过原生代理与下载检查 | 已交实现者；正文资源应显示经 native 核验的内嵌图，失败用明确占位，普通外链仍由用户主动打开 |
| N-16 | P1 / JOB-03、EXP-03 | pdf.open、archive.materials 未纳 runJob 时，jobs 判空不能证明没有网络/写盘，恢复目录可能与旧服务写入竞争 | 实现者已将两项纳真实任务；仍须结合数据代际隔离和取消测试复验 |
| N-17 | P1 / LLM-01、APP-03 | settings.save 先保存代理再调用网络校验，带凭据/格式错误的代理即使被拒仍落 personal.json，启动 bootstrap 可被坏配置阻断 | 已交实现者，需写入前校验或完整事务回滚，启动保留可修复界面，不能把凭据写进普通备份 |
| N-18 | P1 / EXP-03、NOTE-03 | 恢复仅清部分 native 状态，web 仍留恢复前笔记/正文和当前论文，可能用旧编辑覆盖新恢复内容 | 已交实现者；统一清当前上下文回库，或从恢复后真实库重新打开，native 与 web 同步代际 |
| N-19 | P1 / READ-07、LLM-05 | 仅按基础论文 ID 清理与 CAS，不覆盖同 ID 的来源版本变化及 A→B→A；旧 PDF/晚响应可被当新文 | 已交实现者；绑定 paperID、来源版本/文章修订和数据代际，输入与归档保存实际版本 |

修复通知只说明实现已改变；在独立重读、相应故障测试和真实应用操作之前仍不能把相应 M 项写为通过。完整 Zotero 和 LLM 仍需真正端到端验证，隔离 mock 只能证明其对应分支。

### 第一轮修正定版的针对性复核

已重读对应修复块，未重扫不变业务、未重跑无变化的全套。以下表示源码层确认，不能替代实际端到端通过：

- N-01：非空 MD5 不同即冲突；没有 MD5 时先读取真实附件，已有字节不符也拒绝。测试源码包含已同步/未同步用户编辑保护反例。
- N-02：新增必需 `source-metadata.json` 存储附件，包含原始 bibliography 和身份，走实际文件回读，复用旧父条目时不覆盖其人工字段。
- N-03/04/19：`contextGeneration` 在 setPaper 时递增，正文和 PDF await 返回核身份+代际后才安装，PDF 保存实际来源版本，模型 owner 在派发前捕获；归档正文局部保存且核代际。
- N-05/06：三种写入统一内存回滚；真实 messages 无 key 封存，最终响应先独立保存；stderr 为 0600 文件，去掉双管道互等。重启采纳恢复响应的可用路径仍待补。
- N-07：最终 system/user messages、规范 source JSON、提取版本和输出预算纳入桌面 v2 指纹，测试源码覆盖 source 字段顺序改变不新增请求、材料/预算变化不误复用。
- N-09/16：取消仅按目标任务路由同步取消；pdf.open 与 archive.materials 纳入真实 runJob；任务只保存结果摘要，不复制整篇资料。
- N-10/11：stage 先创建并验证 DesktopStore 与 LibraryService；个人 schema、外层集合与各笔记 text/revision 核验，坏资料保留。后置初始化失败的完整回滚仍待补。
- N-12/13：Zotero 解析 HTML 已带来源/用量/模型/时间，连接检测有单独 kind 且归档排除；Markdown/HTML 导出仍未带同等来源，待补。
- N-14：引号内 `>` 绕过 tagRegex 的补充反例已提出；当前实现改为先禁止 image/use/feImage 资源能力节点，涵盖有前缀节点，测试源码保留两种引号反例。
- N-15：正文 iframe 的资源 CSP 已收为 data，显示层不再允许未缓存 HTTPS img/SVG 资源；普通 a 外链与主动打开分开。
- N-17：设置写前原生校验，不含凭据的 HTTP CONNECT 代理及范围检查先行；保存失败回退网络配置。bootstrap 对坏网络设置保留启动路径。
- N-18：恢复后清理 native 论文/PDF/页身份/选区/批注和 web 当前论文、正文、笔记编辑区，回到资料库。

仍需处理或验证的具体问题：

1. **N-05**：个人 session 最终保存失败后，耐久 response spool 虽在，当前启动流程没有核对并采纳该文件的零请求恢复入口。恢复必须可被用户实际使用，不能只有磁盘文件。
2. **N-08**：全文提取超长仍截前 240000 字符，source.pages 却记录全部页，发送前没有明确截断选择；事后提示不能代替输入范围真实。应拒绝超限并缩范围，或准确说明实际页/字符范围并由用户选择。
3. **N-10**：stage 预验关闭了坏 current.json 的原触发，但 live 替换后的 service 构造/赋值仍在回滚边界外；后置 I/O 失败时仍应恢复完整旧目录与对象。
4. **N-12**：Markdown/HTML 研究导出仍只有问题与回答，无实际模型、时间、来源页/SHA、用量，且未排除连接探测。
5. **新增任务状态细节**：runJob catch 使用外层 `Task.isCancelled`，而取消的是内部 task；应按真正被取消的任务或明确错误判断，不把取消统一记录为 failed。

独立原生只读观察：通过 `getApp('论文速递')` 和 `getScreenshot()` 实际看到标准系统窗口、系统菜单、完整资料库列表与 15 条种子计数；辅助功能树读出筛选、多选表格及系统关闭/全屏/最小化控件。没有点击、切窗、写数据或干扰主任务单步交互。这只证明当时当前窗口和资料库，不授予全库同步、其他页面或全部辅助功能通过。

本次重读源码 SHA-256：

| 文件 | SHA-256 |
|---|---|
| ZoteroService.swift | `ed9b037f497fecc6181cebfa845d1c9840bdf419879809ef459e839496ea4d2f` |
| DesktopStore.swift | `942abe28beda8453c45114b39ac30c7d59c9a98264997b35e60dd12abe668533` |
| ModelService.swift | `d7438d72b403770a34ed764557dc82a6cffe5cfe831fddb6e4e76ab248c636bb` |
| Main.swift | `c0e5ff07d2f675b719c5cb9f84ca6b0003a89734c83d678f210002f463ab8524` |
| AppDocuments.swift | `c927eab65364b568485998fe03a2eb25ecb89c488a28ca77e5f3d356b2c52919` |
| native.js | `7b17c68292941d94e2ef347cc44031f170ce736ea1780af2050fdda04f5a480a` |


## 第二轮：定版构建后的来源、恢复与异步链独立审查

收到的构建为 `apps/macos/.qa/builds/2026-10-24T04-33-27.721744_00-00`，签名后原生二进制 SHA-256 为 `fa6aaf66a8eb48783983b34ffd2197d35c6b91e54a9947e7595e61155e626c02`，arm64、本机 ad-hoc、未公证。构建元数据列出的 sourceCommit 是旧基线 `6f041f85a9d19a7694a99421193576b412a10c68`；当时 app 文件尚未提交，真正源码身份须以该构建的 files SHA 清单为准，不能仅用旧提交代表新应用源码。

本轮只读重查 Main、AppDocuments、DesktopStore、ModelService、LibraryService、ZoteroService、worker、native/settings/library/zotero/dialogs UI，重点跟踪来源代际、恢复、导出、全窗口设置及公共桥异步边界。没有改实现、没有运行生产任务、没有使用真实模型凭据，也没有写入真实 Zotero。屏幕锁定后遵循工具要求，未绕过锁屏或操作真实窗口。

主任务提供实际安装与 CUA 观察：全库 8005 篇/8720 条记录、13 页 PDF 与 MathML。上述为主任务证据，不能冒充本审查者在锁屏期间亲自执行的交互。基础测试数量由实现者提供，详细日志属于对应构建；不同后续修复版本的测试结果不能混成一个已验收包。

### 当前新发现

下表为读到相应源码时的真实问题。已即时逐项通知主任务；实现者正在并行修复，表内“待复验”不能理解为修正后的文件仍一定存在同一问题。

| 编号 | 级别/验收项 | 触发与影响 | 需要的关闭证据 |
|---|---|---|---|
| R2-01 | P1 / NOTE-01、EXP-01/03、APP-08 | native.js 笔记延迟 700ms；applicationShouldTerminate 在 jobs 为空时直接退出，无编辑 flush。输入后立刻 ⌘Q 会丢最后输入。原生打开本地 PDF 直接替换 editor；原生导出/备份直接读取旧 store，也能漏尚未保存编辑 | 原生统一异步 flush/dirty 握手；成功才退出/替换/导出，失败保留编辑并取消破坏性动作；输入后立即退出、导入、导出、备份及写失败实测 |
| R2-02 | P2 / READ-07、LLM-03/05 | pdfSelectionChanged 对实际选区使用 text.prefix(60000)，却把整个选择的 pages 封为来源，既无 truncated 也无拒绝。长选区实际只发送前段，范围被误述 | 真 PDFKit 长选区完整保留或请求前拒绝；封存输入与来源范围一致，未发请求有证据 |
| R2-03 | P2 / NOTE-01/02 | addHighlight 先改 PDFAnnotation 再逐行落盘；removeAnnotation 先从画面移除再保存。存储失败时画面与耐久状态不同，多行还能部分保存，重启标注改变 | 完整集合事务落盘后再改画面，或全回滚；实际创建/删除、多行与写失败重启读回 |
| R2-04 | P1 / DATA-06/09/13、ZOT-07 | article 默认按 blogURL 缓存命中直接返回；同步不使正文缓存失效，界面重载也未传 refresh。网站同 URL 更正后可永久展示并归档旧导读；缺图失败被缓存后网络恢复仍不补 | 真实修订/过期/主动刷新策略，旧可用版本保留；相同 URL 正文更新与缺图恢复反例，导出/归档明确修订 |
| R2-05 | P2 / JOB-02/03、DATA-10 | cancelSync 不仅取消 syncTask，还取消整个 URLSession 的所有 tasks、terminate 全部 activeTransfers；取消同步会误杀并行独立 PDF/正文下载 | 下载按操作作用域归属，取消同步只影响同步；至少并行同步与独立 PDF/正文取消反例 |
| R2-06 | P1 / DATA-03/09、READ-07、ZOT-06 | seedArticle 与 seed PDF 只按基础 paperID 匹配，返回版本/来源却来自当前目录。MiCLA 同 ID 更新 v2 时，旧种子 v1 字节会被标成 v2，清缓存也不能消除 | 种子绑定精确来源/版本/构建 SHA，变化后走当前来源；模拟同 ID 新版本，核实际 PDF 字节与封存版本 |
| R2-07 | P2 / APP-03、EXP-03 | 独立 settings.js 仅 bootstrap 一次，不听 settings.changed/personal.changed；主窗菜单改字号或恢复资料后，设置窗继续提交整张旧表，下一处修改静默覆盖新值 | 字段级更新、版本冲突或安全重载；跨窗口改值和恢复后再改任意项不会回写旧配置，失败编辑保留 |
| R2-08 | P2 / EXP-03、DATA-08、ZOT-12 | 备份外层路径相对，但内部 PDFDownload.filePath、Article resource.localPath、Zotero journal.request 的 PDF/guide 路径是旧绝对路径。迁移到异用户名或隔离目录后原样恢复，缓存不能离线命中，归档恢复被 localData 的新目录限制拒绝 | 相对内部句柄或严格根迁移，不能任意替换用户文本；隔离目录离线恢复真实 PDF/图文与未完归档，原 SHA/来源/用户编辑保护不变 |

### 69 项中当前缺少的实际能力或有效证据

这些是后续轮需要完成/明确核验的项目，不能用更多重复测试掩盖。

- DATA-08/11：没有可用的一键完整离线包、容量统计、固定包与证据依赖保护性清理入口。按需阅读会缓存不等于完整缓存管理。
- DATA-06、NOTE-03：缺失目录记录仅在 summary；界面不显示保留的移除记录。旧笔记打开依赖当前 catalog，移除论文的保存资料无法正常从库重开，提示还可能错误称为本地导入 PDF。
- READ-08：已存页码和 guideScroll，但问题草稿、范围、分栏比例、重启重新打开上下文尚无完整持久化路径。只测开关布局不足以证明连续研究工作流。
- NOTE-02：标注有新增/删除，尚未见已保存摘录的实际页回跳及可编辑内容入口。保存 PDF SHA 的显示文字不等于定位功能。
- JOB-01/04：原生进度包含阶段/完成量，但 runJob 仅临时 emit；任务页读 store 时仍是“正在执行”，并未展示实际阶段/字节和相应下一动作。合法不支持的暂停可准确说明，不强造假暂停。
- LLM-02/04/09：个人 API 钥匙串→真实供应商研究→来源引用→取消/完整响应保存尚缺本轮端到端证据。当前明确只有 PDF 提取文字，不支持图片/扫描页；能力限制须如实保留，不能用 text-only 连接成功证明图像能力。
- ZOT-01…14：服务代码及隔离测试不能替代本机真实授权后父条目、真实存储附件、个人研究和自包含图文导读逐项回读、断网打开、重复与人工编辑保护。
- APP/READ/所有窗口视觉：锁屏期间未执行新定版的暗色、尺寸边界、完整键盘/辅助功能、困难 PDF 与实际设置/归档对话框操作，仍待解锁后的真实检查。

### 源码身份与证据边界

以下是本轮初次读到相应问题时记录的源码 SHA，不是签名构建内所有文件的统一快照。实现者随后开始修复，后续文件改变必须另记 SHA 后针对性复验。已见新增 flush 函数和长选区测试源码，但单独出现函数/测试不授予完整修复通过。

| 文件 | 本轮读取 SHA-256 |
|---|---|
| Main.swift | `93e4ed392c65562c70bd863da9fe7bb3317aedd7e93a543ad67bcf5ae42a52e2` |
| AppDocuments.swift | `bbfadcc7ca036b59dbbd1bbabc7680ece99ed81136f7b54c113702eed5f09845` |
| DesktopStore.swift | `942abe28beda8453c45114b39ac30c7d59c9a98264997b35e60dd12abe668533` |
| ModelService.swift | `e0ffb95260daf3079de1b96b02cbd1e0e6c18aac42e9f3377d11f7fe8303eb3d` |
| LibraryService.swift | `e4b1faa5ec44292f3883af1c7abc5f123a9231ece82adb82df04fea2e204a83d` |
| ZoteroService.swift | `a7e6c747ed99300aca3dc8ebb6ef9a07331dd9b0c62decd4715b2222e8a70ee4` |
| native.js | `0be9a745381726c17fdb1786f9a136141f7eccd41d5f23592e2505482b35b229` |
| settings.js | `6d8a2c8a2f53b3a0a0e2b9f8de6b7128134f34dffca0564b3f62cea14ceff86d` |
| library-ui.js | `ebb573eb58fcb5bd8388aa365a0f9775d9acd2349c92322d260db8e2131e18fd` |
| zotero-ui.js | `264fc8cb8a5a8eafbd0f7256cc9da00fbaec953637d67c1df617f29813272734` |
| dialogs.js | `26071a837089fc004e6c5c81893e517bc7f7e584dda566a363e2e533445a2a36` |
| llm-worker.cjs | `3afcc66ffa40fec62d48d542160cb451d478a5eb8522264f6b9884cb6c084ec1` |

本轮结论：**发现需修问题，尚不通过**。已按高风险优先即时给实现者。待接收修复定版及针对性证据后继续独立复验；未把第二轮提前算成完成，也未借本轮代码审查授予尚未完成的真实服务/界面项通过。


## 第三轮：第二轮修正的逐项复核与交错恢复独审

本轮先重读已修块，再沿 native flush、WebKit 回包、任务终态、研究上下文、BackupCodec 与来源缓存检查新增边界。DesktopStorage 作者仍在实现中的模块按主任务要求不读取，不对漂移中的半成品给结论。没有修改应用或测试实现，也没有在锁屏期间启动/操作真实窗口。

### 第二轮八项修正的当前复核

| 原发现 | 当前源码观察 | 结论边界 |
|---|---|---|
| R2-01 | 原生退出改 terminateLater，调用主窗 note/reading 与设置 flush，导入/导出/备份/恢复也先 flush；退出等待捕获任务。noteSaving 串联正在保存的笔记 | 原始直接退出/无保存路径已有实质修正；新增 await 身份、设置队列、退出闸门与设置窗 delegate 问题见本轮，尚不能整体关闭 |
| R2-02 | 选区保留完整实际文字；模型入口超过 240000 字符先拒绝，不再静默截 60000 | 源码层原截断缺陷关闭；主任务提供真实 PDFKit Evidence8，对应构建交互仍待核 |
| R2-03 | 创建整批标注先 replaceAnnotations 单次事务落盘，再添 PDFAnnotation；删除先保存成功再移除，新增批注字段保存 | 原先可见/耐久分叉路径源码关闭；隔离磁盘失败由 Evidence8 提供，真实重启操作仍待验 |
| R2-04 | 文章缓存绑定 catalog epoch、来源、6小时 TTL，资源重核 SHA；有显式刷新、旧稿标记与修订保存 | 原始永久缓存已有修正；PDF 同 URL 可变缓存仍有遗漏，见 R3-05 |
| R2-05 | cancelSync 仅 cancel 自己的 syncTask，URLSession/curl 按各自 cancellation 对象停止 | 源码已无全服务清场；并行取消测试由当前 Library 矩阵提供，不把全局退出取消与单任务混淆 |
| R2-06 | Seed 核基础 ID、absURL、PDFURL、blogURL 和版本；PDF 核原 SHA/字节/页数并复制进私人内容寻址缓存 | 原始把旧 Seed 标成新版本的分支源码关闭；对应变更版反例由 Library 矩阵提供 |
| R2-07 | 设置改脏字段提交并监听 settings.changed/personal.changed，保留未保存字段 | 原全表回写问题已改，新的跨字段保存队列交错见 R3-01，设置窗关闭 delegate 仍缺 |
| R2-08 | BackupCodec v2 保存原文件字节，原根与历史根单独写映射；重定位必须核原 SHA，Zotero 原 journal/fingerprint 不重写，Library pointer 与资源使用受控 resolver | 原跨目录路径拒绝已有正确修正方向；坏路径/别名/Unicode/大小/哈希/符号链接先验，stage 与 live rollback 仍保留。Backup19 等是底层/隔离证据，完整真实 App 异目录迁移仍待验 |

原生 `flushEdits` 等 WebKit 时允许其内部 personal.note/reading/settings.save 返回；未发现仅由调用结构形成的必然自等待死锁。新问题是等待期间上下文仍可变化、保存队列未完全等待和新任务闸门，而不是把每个嵌套 await 都当死锁。

### 本轮新发现

| 编号 | 严重性/验收项 | 当前触发与影响 | 修复/复验要求 |
|---|---|---|---|
| R3-01 | P2 / APP-03、LLM-01 | settings.save 遇 saving 直接返回；A字段写入等待期间编辑B，B定时器可先触发并被吞。A完成时 finally 仅检查本轮 keys 是否再改变，A没变就不安排B，B永远待保存。flushSettings 也未等待在途保存而立即 dirty 报错 | 可等待 Promise 与循环排空独立脏集，错误不吞；hold A→改 B→B timer→释放 A，验证 B 实际写入；关闭/检查等等待正确终态 |
| R3-02 | P1 / READ-07、LLM-03/05、EXP-01 | model.run 先 await flushEdits 后才捕当前 owner/source，原 payload 问题来自A，等待时切B可用B材料发送A问题。archive/export 同样在 flush 后捕身份；guide 导出二次 capture 还能形成A文件名+B内容。JS saveReading 回包后用当前 state.paper.id 写内存，A snapshot 可落到B | 第一次 await 前绑定请求论文、代际和相应来源预期；等待后 CAS，不符即零请求拒绝。reading 按 snapshot.paperID 更新，快速切篇/ABA 与导出反例 |
| R3-03 | P2 / READ-08、APP-03 | readingSnapshot 保存 mode/pdfOpen/chapter，却未恢复这些字段；openPaper 固定回guide。local.opened 没清/恢复 question/scope/range，上一篇草稿出现在新本地PDF。问题/范围输入没有自己的耐久触发，只靠滚动/切篇/flush。另 settings NSWindow 未设置 delegate=self，windowShouldClose 的统一 flush 对它并不生效 | 按论文保存/恢复草稿及确实承诺的上下文，首次默认单栏和恢复明确区分；本地导入清旧范围；设置窗接入实际关闭代理。真重启与A→本地B→A复验 |
| R3-04 | P2 / APP-08、JOB-03 | 退出设 terminationPending 后，只等待当时 closing 数组；dispatch/runJob 没禁止新增任务。等待旧任务时新解析/同步能启动，新增任务不在等待集合，reply(true) 会退出它 | quiescing 闸门先挡新任务/上下文切换，保存控制请求仍能完成；hold退出等待→尝试新job，断言未派发且原终态可读 |
| R3-05 | P2 / DATA-03/09/13、ZOT-06 | PDF指针永久按 sourceURL+version 命中。会议 sourceVersion 常为nil，OpenReview同 URL PDF可更新，目录/正文更新后仍把旧缓存当当前。文章TTL修复未覆盖此分支 | 有真实发布PDF SHA则核对；没有不可变版本见证的同URL资源需条件复验/TTL/显式刷新及旧缓存标记；保护已有回答依赖旧SHA，不要求不可变arXiv版无谓重下载 |

以上已逐项发回主任务。修复通知不等于本表已通过；后续读取修正块与相应反例后另记结果。

### 独立隔离负例证据

`round3-isolated-races.json` 保存两项实际复现，直接读取当时的原函数文本，在明确假 bridge 和受控 Promise 中安排回包顺序；0网络、0费用、无钥匙串、无真实窗口或生产资料操作。

1. R3-01：A在途、B另字段变脏、B保存调用先返回、释放A；实际仅写A，B仍dirty且没有后续定时器。
2. R3-02-reading：开始保存A，等待期间当前论文改B，再放行回包；实际 `readingState.B.paperID == A`，证明前端内存串篇，不把 native 已按正确 owner 保存误说成磁盘也串篇。

这种函数级交错实验只证明具体负例，不能代替完整 App、真实窗口与服务验收。没有对测试桩或截图授予真实 Zotero/模型调用通过。

### 本轮读取源码 SHA-256

这是独审读取时的源码身份。实现者并行修复，尚无本轮统一签名包的最终结论，不能把下面 SHA 与旧签名构建拼接成虚构定版。

| 文件 | SHA-256 |
|---|---|
| Main.swift | `f3b5849a716fdadb727cfcd9a4730c390867648be693ce543883001802b1b6e2` |
| AppDocuments.swift | `e1800fdfac9675c40aa9b746c1d8e5ca70c5f62f9fdbd9806ec06239c18af8e3` |
| DesktopStore.swift | `21ee711d13430c436aa697e8e61e8bf75a90b229697fd063b0e8b67486ff5205` |
| BackupCodec.swift | `c48afeb0337855e92254d7236015854fd65df82aa4a3ecf63dcac7c130f1eda7` |
| LibraryService.swift | `0236b6c440b84fce2f86f4a4315f2ab583757a573e740fb2579c55c28c90c7a2` |
| ModelService.swift | `b0f72942a782fc5c0335f51a04315d9aefaaea4f4c86a22ec582e7482a63497a` |
| native.js | `4aee58e287e880a68477672cac3b969b0e2cd663fb0a76b12070f3659bc8808c` |
| settings.js | `c4ede1fab9800a39c29e90765e17d171d07c1ea0145e4890ca3534ceaca45a50` |

本轮结论：发现新问题，**继续修复与针对性复验，尚不通过**。第二轮修复均有实质源码对应；新发现聚焦当前变化，没有重扫无变化生产管线或重跑全库来充数。69项中本轮新增的个人文献记忆、批注编辑、问题/范围保存和持久进度应按新路径继续验收，真实服务/锁屏交互待验状态保持不变。


## 第四轮：离线、保护清理与恢复界面的新增集成

### 角色调整与独立性

主任务明确委托本审查者实施 R3-01 的单独设置队列修正。因此仅修改了 `Resources/settings.js`、新增 `Tests/SettingsUI.test.cjs`，不再由本人给该设置模块授予独立 review 通过。模块已交主任务安排另一位审查者。其余 Main/AppDocuments/AppStorage/DesktopStorage/native/storage-ui 继续只读独审，没有替实现者改代码或混淆测试作者。

设置修复使用可 await 共享 Promise 循环排空脏字段；失败保留草稿、停止定时重试；放弃编辑先等待已派发写入，再从原生已提交状态恢复，期间阻止新编辑与等待 flush；缺省设置恢复真实默认值，过期 bootstrap 回包不能覆盖新提交 UI。实际 `settings.html`/`settings.js` 配合明确假 native bridge 的10组浏览器交错通过，包括 A在途B另字段、同字段再改、flush等待、失败停重试/恢复、放弃的成功失败、缺省字段、跨窗口更新与迟到回包。没有访问钥匙串、真实 Zotero、真实供应商或用户 profile。这些是实现者测试，不是本人对自己模块的独审通过。

### 本轮独立发现和源码复核

| 编号 | 严重性 | 原触发条件 | 修后读取结论 |
|---|---|---|---|
| R4-01 | P2 | calculateCleanup 把 Zotero 正常生成的 `.summary.json` 当成 journal，要求不存在的 id/request，做过归档就无法规划清理 | 已区分 UUID/匹配 archiveID/真实 companion journal；summary不授予保护能力，原journal仍完整读取。原失败分支源码关闭，真实service输出回归由主任务补 |
| R4-02 | P1 | maintenanceBusy 只挡 bridge，原生打开/备份/恢复 selectors 绕过；清理异步 recycle 期间恢复可替换目录，让旧URL作用于新库。openOffline await回包缺维护检查 | importLocalPDF/backupData/restoreData 最终方法均先拒退出/维护并持自身维护锁贯穿原生面板及事务；退出维护期拒绝；openOffline两次等待后重查维护状态。源码关闭原绕过，原生菜单与面板真实交错仍待解锁 |
| R4-03 | P1 | 打开旧离线 v1 包，archiveMaterials 无条件到当前 catalog 下载 v2 PDF，与 v1 导读/身份合档；只读旧 offlinePDF 对象也不能防外部修改原件 | 已按离线身份重新 `storage.openPackage`，逐文件冷验并核原 offlinePDF SHA，归档不取当前 catalog 替代包中原件；导出PDF也核 currentPDFSHA。源码关闭，实际旧包+新目录、破坏包后准备材料仍需对应集成结果 |
| R4-04 | P2 | annotation-only 研究不进“我的笔记”，个人搜索只搜notes.text；Markdown/HTML导出遗漏摘录/批注 | 只含摘录的paper加入笔记列表，个人搜索含 quote/comment，进入notes读取权威snapshot；研究文本导出带摘录、批注、实际页和PDF SHA。局部源码已见修正；搜索结果仍受catalog范围限制，见后文 |
| R4-05 | P2 | 离线包ID不含paper.json内容，只有目录译题/评分/标签更正时直接复用旧包，丢最新元数据 | 新包contract v2纳规范paper内容SHA，冷验重算并纳包ID；v1只读兼容。独立调用实际服务已验证仅paper元数据变化会生成新包并正确读回 |

### 独立原生隔离正例

为了避免并行改动造成证据漂移，将当时 DesktopStore/BackupCodec/DesktopStorage 的只读副本保存在 `round4-storage-evidence/`，用实际 Swift服务、真实 MiCLA PDF 和临时私有目录调用 register/openPackage。正文与原件不变，只把 paper.titleZh/score/tags 更正。实际输出：`sameID=false`、`reused=false`，新包读回 `corrected-title`、`9` 分，元数据更正保留。

冻结副本时已经读到 v2 修正，所以这是**修后正例**，没有冒称原问题的负例复现。0网络、无钥匙串、无用户 profile/生产IO。结果和实际源文件SHA保存在 `round4-storage-evidence/result.json`。单项原生隔离服务测试不等于真实 `.app` 全界面或整个离线旅程通过。

### 修后剩余问题，已一次汇总交回

1. **本地密码 PDF（P2，READ-09）**：importLocalPDF 直接安装 locked PDFDocument 并设置 owner。openPDF 的“owner相同且已有document”早返回绕过唯一密码解锁分支，首次本地导入可能空白且无法解锁；需导入也解锁或未解锁不安装，并以实际密码 fixture 验证。
2. **个人搜索结果范围（P2，LIB-02）**：native 已命中个人 notes/annotations，但 Library UI 只过滤当前 catalog；本地导入及网站已移除文献不在catalog，匹配ID也没有结果行。需把 personalPapers/保留记录形成个人结果区，或准确限制和提供可用的私人研究检索入口。
3. **删除标注失败反馈（P2，NOTE-01/02）**：renderAnnotations 移除按钮 await 写盘没有 try/catch；失败虽保留实际标注，却只形成未处理Promise，没有可见失败说明。需要保留编辑且显示错误，并用失败fixture核验没有pageerror。

还未进行锁屏后实际窗口、暗色、窗口边界、所有菜单/面板、密码PDF真实操作以及真实 LLM/Zotero 的端到端流程。本轮不能把“源码已修、隔离用例通过”写成这些项通过。主任务按原生发行包继续登记构建与至少第五轮实质测试/独审。

### 第四轮修后读取源码 SHA-256

| 文件 | SHA-256 |
|---|---|
| Main.swift | `9943be1cc9b47ed3525712ed012a96f216c58c273391f96129186e9d080ca9f5` |
| AppDocuments.swift | `517da105b80a5b6182b0b5f7063214db11a19747388301d3ab897c5e7c3d0112` |
| AppStorage.swift | `12e9327924345d5257feb79fe4c87e4abd316496be9bc292d65507812026c5c7` |
| DesktopStorage.swift（v2读取） | `ccc05a10196c1a825fa7ebd6de9bdca43d02ee595752cfef56577142a3e372ed` |
| native.js | `e833dbcd20bf9e8be1fd762b9ff89e069badca0d9c665a3484fa008ca7e5f219` |
| storage-ui.js | `ef80bd71f921bafa4a90bc082da0117683eb52cd956b6cad9894a3642b1673fc` |
| settings.js（本人实现，待他人独审） | `9407f508e57d793fa9e68e5887099536f415ba969011e1b2c7d5b324a2e820b2` |
| SettingsUI.test.cjs（10组） | `12587cf68bb83cd8272146f13b3031c0ac42778c647156165c346f4d3ecd937f` |

本轮结论：五项新增离线/维护缺陷均已见修正源码，R4-05有独立隔离正例；三项剩余问题已交回。**尚不授予完整通过**。下一轮仅针对最终变化与未闭环项目验证，不重复不变生产流程或无意义付费。


## 第五轮：最终来源、版本、真实记账与保存交错独审

本轮承接第四轮三个剩余问题，重新读取稳定后的 Main/AppDocuments/Store/Library/Model/Storage/Zotero 与 native/library UI 异步链。重点为同ID版本升级、当前材料新鲜度、草稿/请求返回、未初始化退出、模型真实性和后台归档身份。没有重复生产分析、没有访问真实密钥或真实 Zotero、没有操作锁屏中的原生窗口。

### 新发现与修后复验

| 编号 | 严重性 | 独立发现 | 当前处置与证据 |
|---|---|---|---|
| R5-01 | P2 | PDF选区和导读的模型输入缺当前来源新鲜度/离线/缓存字段；选区事件发生后来源变旧也沿用旧标记 | modelSource在实际准备请求时合并currentPDFReceipt；guide保存version/stale/offline/cache/notices/fetchedAt。本人实际PDFKit selection/page/range/full与guide正反例通过，包括不重发选区事件而改变receipt；不改旧历史 |
| R5-02 | P1 | personalPapers新集合在restore未校验，坏类型静默回落为空，可能丢私人论文索引 | 全成员与local路径/SHA严格验证，rememberPaper不吞坏集合。本人5组坏restore与坏remember均拒绝且原文件/内存字节保持，旧无索引库兼容 |
| R5-03 | P2 | 非Go服务401余额/认证丢失明确类别；错误字段先截断再脱敏可暴露跨边界密钥片段 | worker保留有界category/providerCode并先完整脱敏再截断。源码复核；另一审查者实际loopback覆盖401余额/认证、429及key跨115/1195截断边界，无真实key |
| R5-04 | P2 | 启动初始化失败后退出路径访问尚未初始化library/model | finishJobsForTermination使用可选服务，取消后等待在途终态。本人真实Swift nil服务及pending任务两项通过 |
| R5-05 | P1 | active v1遇全库同步v2，同baseID可取得新版正文/PDF后归入旧版身份 | 实际安装前verifyArticleBinding/verifyPDFBinding核URL/version/公开SHA；nil版mutable同时要求catalogEpoch。本人源码核全部调用；data审查者实际Library v1→v2四组通过：不装新正文/PDF、归档仅保v1+明确缺PDF提示、拒混offline包；不悄悄改当前身份 |
| R5-06 | P2 | Zotero恢复A时当前B，后台任务初始与终态从currentPaper借B标题/身份 | 全zotero任务初始通用且无paperID，真实service结果identity/title仅从journal.request派生；终态只按已知personalPapers映射。本人4组显式fake-operation runJob回归通过：pending、partialA→当前B、未知成功、失败均无错误归属；realcontent的实际service mock恢复夹带B仍回journal A |
| R5-07 | P2 | 服务无model字段和失败响应使用请求model填actualModel，导致实际模型被伪称已知 | worker实际body.model字符串才返回model，否则null；ModelService保存NSNull，UI/导出明示实际未知，requestedModel保留。源码复核，另一审查者实际loopback成功无model、失败、完成复用零重发均通过 |

第四轮三个剩余问题现已见修正：本地导入先解锁再安装且openPDF不复用locked document；个人检索合并私人/已移除论文而不改公开catalog；删除标注失败可见且保留状态。本人隔离个人搜索和删除失败回归通过；真实密码面板/菜单仍待解锁后操作。

data审查者额外复现的旧preview回包污染当前标签、WKflush期间取消归档丢取消也已修，分别由实际Chrome fixture与NativeContext复验。此处引用其结论，不冒称本人重跑。

### 本人实际执行与证据边界

- `DesktopProvenanceReviewTests.swift`：最终冻结全Swift源码实际编译，**25/25通过**；真实MiCLA PDFKit提取，无应用窗口、钥匙串、网络、付费请求或Zotero访问。前12项来源完整性与历史字节保护、其后9项坏库/退出、最后4项明确fake-operation任务归属。最后4项不证明外部归档成功。
- `round5-independent-desktop-ui.cjs`：当时稳定界面 **18/18通过**，含真实H1/4 MathML/3原图/4表与删除/草稿写失败恢复。native服务是明确fixture，未把fixture当真实服务。最终actualModel显示的静态变动另由realcontent最终UI20/20覆盖。
- `round5-independent-library-ui.cjs`：基础检索回归及私人本地/已移除论文检索扩展通过，公开catalog内容保持。
- 独立打开检查 `review-round5/review-desktop-ui-modal.png`，1440×960；中心帮助弹窗、可达底部按钮、背景禁用、长文布局清楚。这是浏览器fixture截图，不能授予原生标题栏/AX/窗口验收。
- 最终冻结证据 `round5-closure-evidence/` 包含Sources副本、test源、编译后的隔离binary、`result.log`、`source-sha256.json`与`current-source-check.json`。编译执行后再对当前捕获的全部文件核SHA，无漂移。

### 交叉审查者提供的最终结果

按实际来源归属列出，不把这些次数并入本人25项：

| 审查者 | 实际结果 | 边界 |
|---|---|---|
| mac_data_architecture | NativeContext13/13；Chrome旧refresh/PDF/preview回复3/3；Library85项+16实际loopback PDF | 实际服务代码、隔离目录与127.0.0.1；非真实用户库全旅程 |
| mac_real_content | ModelService60 checks/18实际HTTP；Zotero67项mock；最终UI20/20、Native25/25 | 显式test-only fake key、仅loopback；非真实provider或用户Zotero |
| mac_real_content对设置模块 | 独立复跑作者10组SettingsUI全过并静态review无新增问题 | 本人是settings.js保存排空实现者，对该模块回避独立签字；此处记录另一审查者的复验 |

### 最后3项修正的冻结源码SHA

| 文件 | SHA-256 |
|---|---|
| apps/macos/Sources/AppDocuments.swift | `765a14d55481e2384426af0d8edd7a5855ee827aeb1fa7e553c4014b75c97d76` |
| apps/macos/Sources/AppStorage.swift | `104a1b89230d184aea05b4e10fdeb324c869e3481d5f4d69bcf895c631dd2f72` |
| apps/macos/Sources/BackupCodec.swift | `63408acad4471891d62e5e1f65f892b2cfe1d076cdd6f9022f947be6fb9eff5e` |
| apps/macos/Sources/DesktopStorage.swift | `ccc05a10196c1a825fa7ebd6de9bdca43d02ee595752cfef56577142a3e372ed` |
| apps/macos/Sources/DesktopStore.swift | `410b187850c4b549f0d4fc265ab02d264f22be08ea2e512785c8301fa79ff84d` |
| apps/macos/Sources/LibraryService.swift | `e374db8f6b3c8eb162a0fc9166dab93dcb9d55b46192374820b99ab8f767eab5` |
| apps/macos/Sources/Main.swift | `dd4ebcd1bef1c2e92e79e30758e06abf433ac9711a0ee183cb085e174d028dd9` |
| apps/macos/Sources/ModelService.swift | `c293c62726efe9ac0e0b57a2db05ecabd2e8c034da6532732f4f1f8145cf07b6` |
| apps/macos/Sources/ZoteroService.swift | `f72cfcb60e6c26869f0d50d9c0198f24a4d1f913912945441d258a984c831c7f` |
| apps/macos/Tests/DesktopProvenanceReviewTests.swift | `fa4f01bf6d5a0b0351ebc27aafeb2b61590f0beb94ac29f9a7910747353707d5` |
| apps/macos/llm-worker.cjs | `74d82c463f3f9f2cb948e27bae458fbe53f18f5791ddc264e23a3176562d101c` |
| apps/macos/Resources/native.js | `63b49368d45ddcb5212e5c28a6083d80c6cb677cd32ce0b3a0a331dd92d0ca56` |
| apps/macos/Resources/settings.js | `107c5729d63da0ad2f1571c2179c3b739de248b6a0236e8ce48d9afae0fff3fa` |
| apps/macos/Resources/library-ui.js | `1742e26e31f481951081bf83aa46f805c4c1fe2bba6e9e0f5616a8fe0ff1964f` |

本轮限定结论：R5-01…07在上述稳定源码、独立测试及交叉审查覆盖范围内已关闭，最终三项修改没有再发现未解决P1/P2。不是全应用最终验收：最新发行构建/安装包身份由主任务继续登记；Mac解锁后的原生窗口、全部菜单/辅助功能/深浅色极限尺寸、真实LLM一次研究、真实Zotero全附件存档回读与重启恢复仍须实际执行。69项未因源码测试通过而整体改为通过，未启动任何生产论文重跑或私有文库写入。


---

## 来源、上下文及打包独立审查

# 第五轮：上下文、取消与来源版本独立审查

2026-10-24。审查者未修改 Root 的 Main、AppDocuments、AppStorage、ModelService、native.js 或公共 transport。先独立复现，再交由 Root 修复，最后重新编译执行。当前限定审查范围没有剩余可复现缺陷。

## 实际执行与边界

- `DesktopContextReviewTests.swift`：13/13。使用真实 WKWebView Promise 持有保存过程、真实 MainActor Task、真实 LibraryService 索引 v1→v2、PDFKit MiCLA 原字节和临时存储。凭据 provider 调用0；外部网络、模型、Zotero、用户资料写入均0。编译前后所有 Swift Sources、native.js、utils.js SHA相同。
- `DesktopContextUI.test.cjs`：实际 Chrome 1440×960，3/3。原生桥明确是隔离 fixture，延迟已经计算完成的 A 回复，先安装 B。两个截图已实际查看，B 身份、导读修订和单栏保持一致；B 正文明示 transition fixture，不冒充论文分析。这不是实际 PDFKit 窗口的视觉验收。
- `DesktopProtocolReview.test.cjs`：3/3。失败费用回执保留声明的 Responses 协议；错误 URL、公网 HTTP、用户信息端点不放行；非法枚举、大小写 Muse 非 Responses 在派发和留账前拒绝。全部是注入传输，无真实密钥。现有 `tests/llm-declared-protocol.test.js` 2/2 也实际通过。
- `DesktopStorageTests.swift` 本轮独立复编运行71/71，真实临时树、离线字节和保护性清理，没有执行删除。Library 85项、实际 loopback PDF 16项已在此前该修订完成，本轮不重复全站请求。

## 复现后关闭的问题

| 问题 | 原负例 | 修后结果 |
|---|---|---|
| A 刷新正文回复晚到覆盖 B | B paperID 配 A revision 和正文 | id/opening CAS 后忽略旧回复 |
| A PDF 回复晚到污染 B 双栏和版本 | B 被打成双栏并显示 A v1 | open/outline 后检查论文与 PDF 请求身份 |
| A 材料预览晚到污染 B 标签 | B 显示 A 物理页5、777字符 | 阅读身份和预览请求序号阻止 |
| 首次执行前取消缺少最终关口 | 源码缺少 operation 前取消检查 | 真实 queued Task 的 operation计数0 |
| 相同 SHA 复用文档保留旧版本 | 实际版本赋值在 early return 后 | 保留 PDFKit document，同时更新实际版本 |
| archive.materials 进行中取消被吞 | 持有 flush 后取消，仍返回成功材料 | 各等待边界核取消，PDF catch重新抛取消，作业不记complete |
| 后台同ID目录 v1→v2 跨阅读身份混装 | 旧 currentPaper 下取得新正文/PDF | 新稿拒装、PDF拒装、归档不夹错版PDF、离线拒混包，4/4通过 |

## 13项原生断言

A→B 保存交错；A→B→A 保存交错；晚到阅读位置只写原 owner；queued来源操作首次执行 CAS；退出最终打开/备份/恢复/切篇/新作业闸门；维护同组闸门；queued模型作业取消；同字节 PDF 实际版本；archive进行中取消；目录v2拒装旧身份正文；拒装错版 PDF；归档旧书目不夹新 PDF；离线拒混装版本。

## 冻结源码 SHA-256

| 文件 | SHA-256 |
|---|---|
| Main.swift | `78f8de176626aceb2a5efba80720506b32d8110816ce93eb192a447e13833d12` |
| AppDocuments.swift | `0aabf1c4e8530591af019a69f950f6a683a07647eaf4880912230645e4f3ae52` |
| AppStorage.swift | `104a1b89230d184aea05b4e10fdeb324c869e3481d5f4d69bcf895c631dd2f72` |
| LibraryService.swift | `e374db8f6b3c8eb162a0fc9166dab93dcb9d55b46192374820b99ab8f767eab5` |
| ModelService.swift | `ce0e5d03c308f04fe5d8e5398ec0a9354e0c30c032102dbbe274071b6796f089` |
| native.js | `41c244ca1bb318d02c4a690b30e5c84bb95d882e246ddded661179c3e5d963e5` |
| scripts/utils.js | `3ac154dd88700beaf311ddf65f9a9288db8f9ea951cdc113a514cab42561559e` |

这份结论不替代发行包启动、锁屏/解锁、所有原生面板、真实 Zotero 写入或收费模型服务验收。没有运行生产日更、会议、历史生成，没有重跑旧论文分析。


---

## 真实内容及归档合同独立审查

# Mac native content and integration review

2026-10-24. Scoped independent review; no production workflow, real library mutation, permission prompt, Keychain mutation, or personal browser interaction.

## Closed findings

1. Reopening a paper while note mode was active left the guide iframe hidden. Parent fixed openPaper to call setMode(guide); original transition regression now passes.
2. ModelService errors can be objects; session renderer showed [object Object]. Parent extracts actual message. Fixture uses the actual saved failure record shape and now checks error, actualModel, failed state and unknown money.
3. A failed settings save retained the previous saved confirmation. Parent updates saving/failure state; fixture verifies native store remains unchanged and saved text disappears.
4. Zotero inline SVG image/use href scanner was bypassable with a quoted greater-than character before href. Service now forbids inline image/use/feImage resource capabilities, including namespaced tags, before attribute scanning; quoted greater-than negatives pass.
5. DOI records were always preprints. Service now accepts explicit source itemType and validates actual server itemTypeFields before any collection/item write; unknown DOI type is refused, existing user types preserved, arxiv journal articles retain identity via Extra without unsupported archive fields.

## Verification

- Swift 6 strict compilation and 53 isolated service assertions pass. No real upload or authorization has been claimed.
- DesktopUI.test.cjs: 16 groups pass against actual native.js/settings.js/dialogs.js. Native/model/PDFKit/Zotero APIs are isolated fixtures, explicitly not proof of actual macOS native integration.
- Real published MiCLA content: original 4 TeX annotations equal source, MathML renders, 3 figures match public sample SHA and load, 4 original tables remain, title appears once, original eight-dimension score and uncertain author affiliation remain.
- iframe has no allow-scripts, scripts absent, CSP script-src none, child bridge absent in isolated fixture; native Main.swift origin/mainFrame guard is independently asserted as source boundary.
- Explicit PDF open/close, state preservation, modal hides overlay, role/aria-modal/inert semantics, note success/failure, note summary, annotation identities, model failure, export identity/revision transition and settings failure paths pass.
- Actual read-only Zotero 10.0.6 itemTypeFields for preprint/journalArticle/conferencePaper/webpage were fetched and inspected. Fields differ by type; the service does not guess unsupported venue/volume/type facts.
- Modal screenshot visually reviewed: dialog content legible, centered, background dimmed and inert; actual macOS accessibility and PDFKit remain parent native acceptance responsibilities.

## Files and SHA at verification

- apps/macos/Tests/DesktopUI.test.cjs 86c8c6503645593de664a682d7800d4e8d3a38dce25cc90c465be3e54783198d
- apps/macos/Sources/ZoteroService.swift a7e6c747ed99300aca3dc8ebb6ef9a07331dd9b0c62decd4715b2222e8a70ee4
- apps/macos/Tests/ZoteroServiceTests.swift 6124297b0ae96f9e76a191bac355e9b298cd1b40a42daf1044afc5e1fadcfdf6
- apps/macos/Resources/native.js 55e9a0d1087e2918d99df1c2c570ccb53f5bf54f47717d7c560b4e7c3ec338d0
- apps/macos/Resources/settings.js 6d8a2c8a2f53b3a0a0e2b9f8de6b7128134f34dffca0564b3f62cea14ceff86d
- apps/macos/Resources/dialogs.js 26071a837089fc004e6c5c81893e517bc7f7e584dda566a363e2e533445a2a36

Screenshot: desktop-ui-test/desktop-ui-modal.png

No remaining issue found within these exercised cases. Real Zotero writes, native authorization and native WKWebView/PDFKit acceptance are not covered by mocks.


## Native regression follow-up

Actual AppKit/PDFKit native Sources compiled with PAPER_DIGEST_TESTS and actual regression runner: 22/22 pass. Test app does not launch, create windows, invoke dialogs, or call external services. Native state and copied public PDF live only in a temporary test directory. Library network transport is explicitly blocked; model key provider returns nil; Zotero credential store is non-persistent.

The first actual native run reproduced seven source/settings boundary gaps, then latest run closed owner/SHA/scope/guide/settings failures. A further real PDFKit clear-selection test reproduced stale selection reuse and was closed by parent clearing source. True Foundation JSON tests reproduced bool-as-Int and number-as-Bool acceptance and were closed using CFBoolean type checks. Mixed text/blank source pages now return missingTextPages and completeTextCoverage=false. A repeated explicit PDF-open UI action was also reproduced closing the PDF and fixed idempotently; new UI test passes.

Native coverage: real current page, inclusive page range, all 13 physical pages, actual PDFKit text selection, source owner/SHA/version, stale-source refusal, absent/explicit outline fixture, oversize real PDF text before paid work, empty/wrong/oversize guide, URL credentials and transport restrictions, setting ranges/protocol/type including JSON booleans. Source-page selection jump is separately being implemented by parent; current UI test establishes keeping an already-open PDF visible, not exact jump correctness.

Latest code identities:

- apps/macos/Tests/DesktopNativeTests.swift c59740bd2a441877f43599d1da46f6bd57271ea6e4979166c56e16e1c8637c50
- apps/macos/Tests/DesktopUI.test.cjs edb012eabcfd1b7c4df3ab96ca098585c5120dc38090f03385d4b1a377577899
- apps/macos/Sources/Main.swift 93e4ed392c65562c70bd863da9fe7bb3317aedd7e93a543ad67bcf5ae42a52e2
- apps/macos/Sources/AppDocuments.swift bbfadcc7ca036b59dbbd1bbabc7680ece99ed81136f7b54c113702eed5f09845
- apps/macos/Resources/native.js 0be9a745381726c17fdb1786f9a136141f7eccd41d5f23592e2505482b35b229


## Latest queued integration tasks completed

- Desktop UI: 20/20 pass. Added actual source-reveal contract page/SHA match and no-selection no fake location, A reading/article delayed replies vs B, resume mode/PDF/draft, local source field reset, immutable quote + owner-bound annotation autosave/failure, annotation-only note index and offline modal fixtures. Confirmed stale excerpt visible after local import and parent fixed it; regression now passes.
- 52 labelled screenshots generated in apps/macos/.qa/desktop-ui, with manifest. Four desktop viewport/theme combinations. PDF pane explicitly says it is a native renderer test placeholder. Native model/job/offline/Zotero IO remains fixture-only. Main no horizontal overflow and Zotero modal footer checked in-screen. Visually inspected actual scientific figure reader and 1080×700 dark Zotero preview.
- Native: 25/25 pass including termination refusing new jobs/paper switches while saving note/reading, maintenance refusing actions except hidden layout, and real PDFKit password-encrypted MiCLA wrong/cancel/correct/unlocked cases. No system panels or app windows launched.
- ModelService/worker: 53 checks / 16 actual loopback requests pass. Explicit chat+coding/v1+mimo reaches chat/completions with messages; explicit Responses+deepseek reaches responses with input. Initial shared-transport protocol re-inference failure was reproduced and parent fixed controlled declaredProtocol. Non-Go 401 insufficient_balance vs 401 invalid_api_key vs 429 rate limit retain actual classification, bounded provider detail and redacted fake test key; no actual provider or paid credential.
- Zotero: 65 assertions pass including actual service-produced journal+summary consumed by DesktopStorage cleanup plan. AppSupport restore fixture now uses actual complete DesktopStore output. No real writes/authorization.
- BackupCodec: 20/20 pass including original/raw and POSIX/Foundation current-root spellings with true symlink rejection. Historical alias paths still require original content SHA.
- Settings queue independent review: all 10 author tests rerun and passed. Independently checked shared drain, retention on failure/no retry loop, discard waiting issued write then authoritative reload, stale bootstrap generation, cross-window dirty preservation, and flush entire drain. No actionable problem found in reviewed code/cases.

Latest tested file identities:

- apps/macos/Resources/settings.js 107c5729d63da0ad2f1571c2179c3b739de248b6a0236e8ce48d9afae0fff3fa
- apps/macos/Tests/SettingsUI.test.cjs 696568293591419315afc39abaad2e5b519277da8f5b36cc0da996e41240a638
- apps/macos/Tests/DesktopUI.test.cjs 2168dad3df15e8a1ec65b360db81fa21ae521cc786f2b50be19a27154f14af0d
- apps/macos/Tests/DesktopNativeTests.swift 9528b8f9981bcd3a194389761c0e224d9118354c1c125365c9e7324f41eeb040
- apps/macos/Tests/ModelWorker.test.cjs b9503504177ef34a7d4d305ea2aa31231c8f6641b6575e120aaf4e1a5a9a556c
- apps/macos/Tests/ModelServiceTests.swift a66ba8fb79167bda3a384737c7451a26c6d12f6bdc2512d46979f39c10b7ba85
- apps/macos/Tests/ZoteroServiceTests.swift 0325271f893298451b145802fc219bfd196f8995bf75d2c427ca2b97582c580b
- apps/macos/Sources/BackupCodec.swift 63408acad4471891d62e5e1f65f892b2cfe1d076cdd6f9022f947be6fb9eff5e


## Final Round 5 follow-ups

- ModelService 60 checks / 18 actual loopback requests pass. Added providerCode offset115/providerMessage offset1195 dummy-key truncation boundary; no dummy key prefix survives. Worker now redacts complete secrets before bounds. Added HTTP200 without returned model: actualModel remains null, requested model stays separate, charge stays unknown, exact completed result reuses without a duplicate request. All three HTTP failure classifications retain actualModel null.
- Zotero67 assertions pass, including service result identity/title from real journal and malicious resume payload carrying paperB identity/title still returning original journal paperA. Actual service journal+summary cleanup integration remains included.
- DesktopUI final20/20 pass against final label/unknown-model changes. Existing52 screenshots retained; only affected detail panels refreshed in12 screenshots and actual780×610 settings window added in10 screenshots (including model bottom). panels-manifest.json records this supplement.
- No true model service, private profile, Keychain or actual Zotero authorization/write used by these tests.

Final tested source identities:

- apps/macos/llm-worker.cjs 74d82c463f3f9f2cb948e27bae458fbe53f18f5791ddc264e23a3176562d101c
- apps/macos/Sources/ModelService.swift c293c62726efe9ac0e0b57a2db05ecabd2e8c034da6532732f4f1f8145cf07b6
- apps/macos/Sources/ZoteroService.swift f72cfcb60e6c26869f0d50d9c0198f24a4d1f913912945441d258a984c831c7f
- apps/macos/Resources/settings.js 107c5729d63da0ad2f1571c2179c3b739de248b6a0236e8ce48d9afae0fff3fa
- apps/macos/Tests/DesktopUI.test.cjs 883bfab9a5822897b8f6a40a848bd9cbfdef78aca29ffbf41734719bdf60ebdd
- apps/macos/Tests/ModelServiceTests.swift 994612084b67c294796d9412d1ecc5475dd1bc304a743854f68846cf7ae31fb2
- apps/macos/Tests/ModelWorker.test.cjs 4359971d9f65f82f5ce77f0335e4d623cf41f60729ebb78e844c07cc824ba187
- apps/macos/Tests/ZoteroServiceTests.swift ac645547b05746d859a5d4235a1bfc6a3bb92523058aecd0963e55f02869738b


---

## Packaging boundary review before final rebuild

# Mac 打包与安装边界独立审查

2026-10-24。只读取 build.sh、Info.plist、README、test.sh、实际候选包和安装包；修复只写 build.sh 与 README。没有操作用户界面、关闭应用、运行生产任务、构建或安装新应用。

独立性边界：本审查者亲自实施了下述build脚本修复，不能再自行给这些改动授予独立review通过，已请Root交另一位执行者复核差异和最终候选包。原生Sources全程未修改。

## 实际包状态

| 项目 | `.build/论文速递.app` | `~/Applications/论文速递.app` |
|---|---|---|
| builtAt UTC | 2026-10-24T05:26:05.977866Z | 2026-10-24T04:33:27.721744Z |
| Native SHA-256 | `a73c42abe4156264bb5793f0f5e770b4805616e7d0c6533e75f807985bf0dd2a` | `fa6aaf66a8eb48783983b34ffd2197d35c6b91e54a9947e7595e61155e626c02` |
| 最低 OS | 15.0 | 14.0 |
| Native/Node 架构 | arm64/arm64 | arm64/arm64 |
| 实际严格签名核验 | 通过 | 通过 |
| metadata所列包资源重核 | 全部一致 | 全部一致 |
| CFBundleVersion | 1 | 1 |

安装版进程 PID69225 的实际执行路径仍是 `~/Applications/论文速递.app/Contents/MacOS/PaperDigest`。安装版没有因候选包存在而自动升级。`.build` 的元数据可匹配 `.qa/builds/2026-10-24T05-26-05.977866_00-00/` 历史记录，但对比当前工作树有14份源码/界面/worker/transport文件不同，因此这份包也不能充当最终修复版本的执行证据。上述数字是本次检查时快照，后续构建应另记新的 builtAt 和 SHA。

## 已关闭的问题及验证

1. 原 `--install` 会移动并删除仍在运行的旧应用包，使旧进程继续执行旧代码，却可能找不到 Web/Runtime 资源。现在在安装开始、复制后和最终替换前拒绝存活的 `PaperDigest`，不强制退出进程。实际执行 `build.sh --install` 在 PID69225 存活时立即拒绝；旧安装 SHA 和进程执行路径均未改变。
2. 普通 build 仍允许在安装版运行时生成候选包，但如果当前运行的是 `.build` 中的应用，就不覆盖它的资源。
3. 原资产 SHA 只在编译前核对。现在复制到 bundle 后，直接读取包内 sample.json 和 PDF/3图实际字节再核 SHA。实际复制真实资产的正例通过；仅改变临时副本的 PDF 后，包内校验明确拒绝。
4. 自定义 Node 运行时现在按 lipo 真正架构列表匹配，不从含路径的 file 文本猜架构；同时执行公共实现的版本门槛检查。拒绝未复制的外部动态库、最低系统高于15的 Node。当前真实 Node 检查通过；外部 dylib 与更高 OS 的两个隔离模拟负例被拒绝。
5. `bash -n`、帮助入口和改动空白检查通过。当前 Node 的 Mach-O minos 为13.5，原生候选包为15.0；Node仅链接 Apple系统库，不依赖 Homebrew路径。

build.sh冻结SHA：`463f75e358b1685a63d2fb8fff777520c1727081277ea7a7def3878449857162`。

README冻结SHA：`f89ba19e75dbecef6de5e7f894e72ce49de27fee65473a898e22965e2bedf55c`。

## 干净检出、许可与私有边界

PDF和三张裁图被Git忽略；README明确要求从给定原始PDF按固定版本工具准备，构建缺失或SHA不符即失败，不能把不存在的资产当作干净检出可直接启动。Marked、Lucide、KaTeX和Node许可证实际在候选包中，Node许可157606字节。包路径检查未发现.env、data/runtime、personal.json或响应完整性密钥；常见长密钥文本模式扫描无命中。Shared输入来自Git已跟踪scripts/config，而不是生产数据。这里不把有限文本模式扫描称为对任意形式秘密的数学证明。

## 安装方案与限制

锁屏期间先普通build，核验新候选包的签名、actual metadata与当前源码SHA、Native/Node架构和最低OS，登记新的已签名二进制SHA。解锁后先在旧应用内保存并正常退出，等待任务停止，再运行安装；安装后另验实际新进程路径、包SHA和窗口。不能在旧进程运行时声称新版本已经启动。

当前为ad-hoc开发签名，没有Apple公证；只验证本机arm64/macOS26.6.1，没有把macOS15或Intel机器记作已实机通过。两包CFBundleVersion目前都为1，人工辨识需使用build-metadata和二进制SHA，不能只看1.0.0关于页。

另已向Root报告：默认test.sh尚未列入LibraryPDFRevalidation.test.cjs与DesktopProtocolReview.test.cjs两份专项，虽本次已另行运行，但未来npm test需补入或明确专项覆盖边界。当前权限未修改test.sh。新脚本还需由最终普通构建取得完整正例证据；本审查没有冒称已完成新包安装或启动。


### Independent verification after final rebuild

Candidate builtAt: 2026-10-24T05:54:21.918615Z. Signed binary SHA256: eea09589a421badfd5b8ad8051ef824f6912864053b9c79b7f822eb4b58ab6cd. A different reviewer checked 501 input entries against current Sources, Web, worker, Shared and Seed: 0 mismatches. Strict app and Node signatures, arm64, macOS minimum 15 / Node minimum 13.5 and system-only dynamic libraries passed. No environment credentials, production runtime, personal profile or private keys were found. Full local evidence: apps/macos/.qa/final-frozen-independent-audit.json. This validates the candidate package only; the older installed process remains running. No new install, launch, real model or Zotero authorization/write is claimed.

## 2026-10-24：主窗模态焦点候选，实机无障碍待验

Root 在标记为 09:25 的实际安装包中，从干净资料库打开“本机资料”后，截图正常，但系统无障碍树仍只显示 HTML 内容容器。此前刷新 `detail-content` 外层的改动没有解决这次实机问题。失败证据保留在本机 `apps/macos/.qa/live-e2e/storage-0925.ax.txt` 和同名 PNG；不能用浏览器行为测试替代这个失败结果。

本轮只修改 `dialogs.js` 和 `storage-ui.js`。模态插入后，先等渲染帧，再在独立定时任务中聚焦可见标题，避免把初始焦点放到从静态隐藏对话框搬出的旧关闭按钮。只有仍然连通、可见且位于栈顶的模态可以获取焦点；用户已经移入控件时，不再抢回焦点。Storage 加载完成替换标题后，再通过同一入口安排焦点。关闭嵌套模态时，若旧焦点已不属于剩余模态，则回到剩余模态的标题。原关闭按钮、事件、Tab 循环和 Escape 关闭合同保留。

[WebKit 官方修复说明](https://github.com/WebKit/WebKit/pull/65010)记录了新子树尚未进入无障碍树时，焦点通知可能先抵达 AppKit 的问题。这为本轮延后焦点提供候选依据，尚不能证明当前机器上的无障碍空树已经修复。

隔离行为回归实际通过 35 组：

- 新增 `DesktopModalFocus.test.cjs`：6/6。覆盖独立任务聚焦标题、同面板内容替换、Storage 延迟结果替换标题、保留用户主动焦点、嵌套栈顶与关闭恢复、关闭后重开拒绝旧焦点任务。
- `DesktopModalFacade.test.cjs`：6/6。
- `DesktopDetailContainer.test.cjs`：4/4。
- `StorageUIAsync.test.cjs`：7/7。
- `DesktopContentAXReview.test.cjs`：12/12。

这些测试使用真实界面模块和浏览器 DOM，原生调用为明确夹具；没有操作真实窗口、凭据、模型服务、Zotero 或用户资料。新增焦点测试已纳入 `apps/macos/test.sh`。记录与对应源码 SHA 保存在本机 `apps/macos/.qa/modal-focus/result.json`。

本轮冻结身份：

- `apps/macos/Resources/dialogs.js`：`86eb17d35cf684fdd4a8a40db1c44b47d8d1802c5709dccb39d6fb5eb782cd19`。
- `apps/macos/Resources/storage-ui.js`：`448f5dd79881f630b12cca8360623fa57083c608700b000f58e26231feae3456`。

剩余验收是新包中的实际 macOS 无障碍树、键盘焦点和控件操作。通过前，此项继续记为实机待验，不记为问题已经关闭。

### 行内科学公式、代码与转义符独立复验

真实个人解析的142字回答中，两处行内公式被二次渲染成块级公式，造成空白。最初修复保留显示模式后，独立审查又复现Markdown代码被替换成占位HTML、公式内转义美元符号被截断、重复渲染增加嵌套三个问题。原失败记录保留在本机QA目录。

改为局部Marked行内扩展，让Markdown词法分析器先保护代码；共用转义感知的数学分隔规则。旧HTML的TeX注释直接渲染，保留原行内或独立模式，替换为干净根节点；Markdown结果不再进入旧HTML二次处理。真实原回答、四种分隔符、旧KaTeX、原生MathML、重复调用、代码、双货币文本和安全负例均通过独立13项DOM检查，测试纳入完整入口。独立冻结native.js SHA为 `aa96003ef0175809ac40ab51842528aa32b72dc75b0f767d3cada5fe2237d3d0`。

完整隔离测试v4已通过；随后修改仅影响界面，所有15个相关界面套件v5再次全部通过，未重复调用付费模型或真实文库。公式实机显示和主窗弹窗AX仍须在安装新候选后核验，不能用浏览器测试代替。

## 2026-10-24：真实JSON附件传输与只读结构诊断

真实原归档同一父书目中，PDF与图文导读已上传并由独立GET、真实文件读取核验原字节；旧解析和笔记也保持原HTML。来源JSON附件创建成功，但上传返回HTTP400，原失败未清除。独立核对已安装Zotero的本地服务实现后，确认它先把application/json传输体解析为对象，文件接收器却只接受二进制流或字符串。修复仅将原始上传体Content-Type设为application/octet-stream；附件的实际application/json、文件名、原字节、授权、注册和哈希均保留。

旧实现已在模拟真实服务解析的隔离回归中复现失败，修复后Zotero156断言与非作者聚焦恢复测试通过：失败后沿原父项、原附件key续传，重复恢复零POST。完整隔离测试v6以0退出。本结论不替代新包对真实缺失JSON文件的续传与回读。

正式主窗AX问题尚未关闭。最小WK、完整生产资源、Main原生层级、以及不改DOM/焦点的被动探针在本机均可读出，不能据此把正式应用的空AX失败洗成通过。为定位实际差异，现有导出诊断增加无正文、无输入值、无URL或凭据的窗口/响应者/DOM结构快照；在保存窗口前只读采样，未知ID、ARIA、样式和任务文字均严格归为other。作者31项及非作者33项真实隔离WK隐私检查通过，未改变用户资料或焦点。

用户最终明确要求保留当前第三个C石墨图标；不执行先前B方向的候选替换。

## 2026-10-24：主窗 aria-modal 单变量兼容实验，待真实 Mac 对照

835c 正式应用中，本机资料、帮助和导出继续出现“截图正常，系统 AX 只剩 HTML 容器”的失败；搜索精确论文只显示一行后也未恢复。实际只读诊断确认 appActive/windowKey/documentHasFocus 全为 true，第一响应者为 WKWebView，活动 H2 可见；唯一 surface 的 role=dialog、aria-modal=true、inert=false，BODY/HTML 祖先均没有隐藏或 inert，矩形与样式正常。此前最小、完整生产资源、精确 Main 构造及无 DOM 写入的被动探针通过，均不能代替正式应用的失败。

按 Root 指令，本候选仅取消 generic surface 的 `aria-modal=true`。保留 `role=dialog`、背景与下层 surface 的 inert、仅栈顶焦点、Tab 循环、Escape 栈顶关闭、原关闭控件和原生 PDF 遮挡。它偏离 [WAI-ARIA APG 模态模式](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)建议的 aria-modal=true，是针对当前 WK 真机空树的单变量兼容实验。WebKit 的[动态 aria-modal 隔离树问题](https://bugs.webkit.org/show_bug.cgi?id=280643)和[模态过滤缓存实现](https://github.com/WebKit/WebKit/commit/b5639a26a2d81b24b253095bfaba536f2255987e)仅支持验证方向，尚未证明命中本机原因。

实机未恢复前，不宣称修复，不改变此前失败记录；Root 安装后立即对照实际 AX、键盘与控件。若无恢复，将撤销本实验。隔离回归与非作者结果随后按实际补记，不把 Chromium AX 结果计为 Mac AX 通过。

作者相关隔离回归实际 49/49 通过：Facade 6、Focus 6、Detail 4、Storage 异步 7、内容/AX 12、当前设置界面 14。原估 47 基于旧设置套件的 12 组，当前套件实际已有 14 组。新增断言在原用例中核对没有 aria-modal 时仍保留 role、背景 inert、下层 inert/仅栈顶交互和关闭后回退；完整 DesktopUI 的旧 aria-modal=true 期望也同步为本实验的明确缺省合同。日志在本机 `.qa/no-aria-*.log`，dialogs.js 冻结 SHA 为 `223f66528502360084ec4dcc2c9cfdbf0b5ccb40425323fd9bf88971589a9fc6`。非作者审查与新包真实验收仍分别记录。

非作者已按相同 SHA 完成精确源码差异审查，并独立实际复跑 Facade 6/6；未发现 role、inert、键盘栈或原生 PDF 遮挡守卫漂移。允许纳入实验候选包，不代表 macOS AX 问题已关闭。

### 真实结果与撤回：9f296220 的无 aria-modal 实验无效

Root 安装该候选后，本机资料仍只有空 HTML AX 容器。该实验未修复问题，现已恢复 `aria-modal=true` 及相应语义测试。此前实际失败、49 组行为通过及非作者通过均保留为各自范围的历史证据；不能把隔离测试通过解释成真实问题解决。

### 下一单变量：只取消主窗背景 root 的 inert，待实机

在恢复完整 aria 基线后，仅令主窗 `#app-window.inert=false`。已真实可访问的独立设置页继续使用 `.settings-body.inert=open`，动态 Zotero 对话框作为同包基线对照。两边均保留 `role=dialog`、`aria-modal=true`、下层 surface inert、仅栈顶焦点、Tab 循环、Escape 栈顶关闭，以及现有背景付费快捷键阻断与原生 PDF 遮挡。主窗背景仍有原遮罩；本实验不新增菜单、不改变用户资料和授权。

主窗与设置页还有以下已知差别：主窗初始 HTML 含静态 archive/detail dialog，设置页的 Zotero dialog 为模块动态创建；主窗有最多 100 行目录与阅读 iframe/原生 PDF sibling，设置页直接使用独立 WK；正式包的持久 WK 上下文与所有隔离 probe 也不相同。835c 的真实结构诊断已排除可见性、祖先隐藏、窗口激活和 DOM 焦点错误，本候选只验证主窗 inert 与引擎 AX 过滤之间的关系，不宣称任何上述差别已被证实为原因。

B 候选隔离回归 49/49；Facade 原用例还增加实际 settings.html 动态 Zotero 弹窗的对照，确认其 root inert=true、aria-modal=true，Escape 后恢复 root inert=false。非作者按 `54af2b6b181a03f4f2b438534591d568aa7b6e5b9c91333d6283379e883f6ce7` 核对源码并独立复跑 Facade 6/6，通过范围仅为单变量实现及隔离交互，不授予真实 AX 通过。未提交或安装该候选。

## 2026-10-24：原归档核验的界面语义

真实重复回读验收发现，resume 完全沿原 journal.request 执行，界面却仍显示不生效的材料勾选和可编辑分类，容易误以为能改变原归档。本轮仅修改 Zotero 前端模块：原归档模式显示“核验原归档”、原论文身份、原检查点保存时间及实际结果，隐藏材料、目标分类、新建和授权表单；新建入口恢复原有标题、说明与全部可用材料、分类编辑。失败后只允许用户显式按原 ID 重试；打开 Zotero 原项仍仅采用实际结果返回的 parentKey，不使用失败前的旧结果或未复验 summary key。

最近归档使用服务已有的 updatedAt 秒时间戳按本机时区显示“上次保存/核验”，保留真实来源身份和版本，行号区分同名记录；无时间则明确“时间未记录”，不填当前时间。按钮的无障碍名称包含标题、来源、时间及归档 ID，以区分同名和同版本记录，普通可见界面不展示内部归档 UUID。未改 Swift、归档服务、请求结构、模型、原 journal 或真实材料。

新增回归使用生产 settings.html/main index.html、真实界面模块及明确原生夹具，覆盖设置反复切换、原归档/新建来回切换、忙碌关闭不复活、A 成功后 B 失败不串项、明确原 ID 重试、未知被动许可态、迟到准备失败和缺时间，截图只属于隔离界面示例，不是实际 Zotero 回读证据。新套件为 `ZoteroResumePresentation.test.cjs`，已加入完整测试入口。

最终相关回归 39/39（原 Zotero UI 8、实际设置集成 2、新模式 9、设置 14、Facade 6）；非作者独立复跑新模式 9/9，并按 `6e851a89bccdf4ecbeaecb833e507fcb61fc9fff8aff68d2d7829333ff8edc12` 核对源码与 780×610 截图，未发现新增阻断。此结论限定于隔离界面；尚未提交、安装或授予新界面的真实 Mac/Zotero 验收。

非作者随后补查原生菜单对应的事件，发现模态期间搜索命令可把焦点移到背景输入框，实际输入会触发资料库搜索。背景鼠标遮挡和付费快捷键保护仍通过，但不足以维持完整模态隔离。Root已将B构建及精确实验源码保留在忽略的 `.qa/modal-inert-b/`，生产源码与测试恢复背景 inert；没有推送或安装此候选。若后续实机AX对照证明有效，须先修复焦点与命令隔离再独立复验。

## 2026-10-24：真实设置切换导致历史归档按钮未绑定

9f296220实机“最近归档”点击无反应。非作者使用真实settings.html、settings.js、dialogs.js与Zotero生产模块独立复现：`revealAccessiblePane`浅克隆外层并迁移原孩子，初始化保存的settingsPane已脱离DOM且为空，renderPending/updateControls在旧容器查询0个按钮，故没有onclick，实际resume请求0。此前单独可见section的8组回归漏掉该集成。

修复仅将两处查询限定到当前document里的实际pending/recent列表。新增真实设置集成先在旧实现复现2组失败，再验证首次reading→Zotero、3轮往返与刷新、精确resumeID、busy禁用与防重复，作者2/2及原模块8/8通过；非作者以自己的真实页面集成连续两轮独立复验通过，未发新归档、授权或准备当前论文材料请求。新套件已加入完整测试入口。实际新包GUI重复回读与重启续传仍须在解锁后执行。


## 2026-10-24：B 的真实主窗对照仍失败

Root 正常退出正式 83e4 后，直接运行忽略目录中封存的 B 实验应用，以实际进程路径及封存签名核定实验身份。打开本机资料后仍只有空 HTML AX 容器；可见弹窗并未恢复系统子控件。证据为本机 `.qa/live-e2e/storage-inert-b-actual.ax.txt` 与同名 PNG。非作者只读核对封存 dialogs SHA `54af2b6b181a03f4f2b438534591d568aa7b6e5b9c91333d6283379e883f6ce7`，并对照实际 AX 文本和截图确认此失败；没有把先前隔离回归通过计作真实 Mac AX 成功，也未自行操作 GUI。

B 已由 Root 正常关闭退出，正式安装的 83e4 和生产 dialogs 完整 ARIA/inert 基线均保留。结合此前已复现的背景搜索焦点泄漏，B 不作为交付修复。后续只改变主窗 WK websiteDataStore 的 C 对照另建独立 QA 包，不与本轮 Zotero 界面或笔记标题增量混合，也不提前记为通过。


## 2026-10-24：C 主窗非持久 WK 对照仍失败

C 从已审 83e4 精确快照构建，只将主窗 WK websiteDataStore 设为 nonPersistent，Settings 和所有网页资源保持原基线；候选有独立实验 metadata、源码差异和签名回执，未安装。另一名非作者核定 10 个 Swift 仅 Main 一项变化、505 条来源对应、497 个实体文件仅 native/metadata/CodeResources 三项不同。

Root 实际启动 C 并以进程路径确认运行忽略目录中的实验包，打开本机资料后 AX 仍只有 HTML 容器。证据为 `.qa/live-e2e/storage-store-c-actual.ax.txt` 与同名 PNG。非作者只读核对封存 native SHA `a2284500ec6b590eedb7324a6302eb929396038d5d91da10cb117d5d43eeed14` 和该 AX 失败记录。C 已由 Root 正常 Escape、退出，正式安装与工作区 Main 均未改变。该实验没有修复实际主窗 AX。后续 D 重新从 83e4 基线只避免对已隐藏 PDFView 重复设置 isHidden，不继承 C 的非持久设置；结果须另行实测。


## 2026-10-24：D 避免重复隐藏 PDFView 的对照仍失败

D 重新以已审 83e4 为唯一基线，只在 Main.positionPDF 的 visible:false 分支中，对原本已经隐藏的 PDFView 跳过同值 isHidden setter；原返回、几何处理、其他分支、持久 WK 设置及全部网页资源不变。独立 QA metadata 与回执明确标记实验和实际 Main SHA，包没有安装，未将 C 的 nonPersistent 改动混入。

Root 实际启动 D，并以运行路径确认其身份；打开本机资料后仍只有空 HTML AX 容器。证据为 `.qa/live-e2e/storage-hide-d-actual.ax.txt` 与同名 PNG。非作者只读核对封存 native SHA `41ffc9e40b715b4ed627c5ca02d95d3b9bd9615766ecd551fec60a622627dff3` 及 AX 记录，未将编译/签名或隔离行为通过冒作实际 AX 修复。D 已由 Root 正常 Escape、退出；正式安装和工作区 Main 均未改变。

B、C、D 均未解决实际主窗 AX；停止继续准备猜测性变量包。下一步仅扩展现有只读诊断，以受限角色和结构计数区分应用自己的原生 WK 树是否同样为空，以及外部提取的差异。不得收集 label、value、URL、description、正文、原始控制台或凭据，不因添加诊断改变 AX 可见性或焦点。该诊断与后续修复须另经独立审查及实际验证，当前 AX 失败保持未关闭。


## 2026-10-24：仅观察 own WK 的原生 AX 结构

B、C、D 均真实失败后，没有再改变窗口、ARIA、inert、焦点、持久数据、PDF 可见性或导航。现有「导出诊断」为已经存在的主窗与设置 WK 增加 `nativeAccessibility`：仅通过公开 `NSAccessibilityProtocol` 读取角色、子节点和 element 布尔，并单独记录 WK 公开但已弃用的 `accessibilityIsIgnored` 布尔。角色严格映射到固定白名单，其余为 `other`；不读取 label、title、value、description、URL、正文、输入、配置或凭据，不遍历其他应用或桌面，不调用 setter、AX notification 或私有 WebKit API。

节点以对象身份去重，最多 256 个节点、10 层、每节点 128 个子引用，并在每次 getter 前检查 250ms 循环预算。输出各项截断原因。同步 getter 本身没有硬超时，读取可使 WebKit 惰性初始化内部 AX 状态；不能声称它不会发生任何内部计算。

该观察只证明公开接口当时返回的结构。未实现现代协议的远程代理明确记为 `opaqueNodes`，不能将不可读代理冒称为 WebContent 空树；`remoteCoverageGuaranteed` 固定为 false。可对比主窗与设置的 rootChildCount、rootChildrenReturned、roleCounts 和 opaqueNodes；仍须结合真正失败窗口的诊断与系统 AX 结果解释。WebKit 的 remote token/PID 调试能力位于私有头文件，未使用。现代方法的公开范围见 [Apple NSAccessibilityProtocol](https://developer.apple.com/documentation/AppKit/NSAccessibilityProtocol)，旧接口弃用说明见 [Apple NSAccessibility](https://developer.apple.com/documentation/AppKit/nsaccessibility)。

实际全 Sources 编译和离屏 WK 隔离回归 48/48 通过，日志 `.qa/diagnostics-native-ax-privacy.log`：秘密正文、角色、原生 label/title/value/description 均不导出；实际 DOM、焦点及私有临时资料字节不变；循环、宽度、深度、节点和零时间预算分别覆盖；不可读边界与明确返回空数组分开表示。没有启动用户应用、读取用户资料或访问 Keychain/模型/Zotero。此处只记作者隔离证据，非作者审查和真实诊断结果另记；实际主窗 AX 故障仍未关闭。

非作者随后以同一 AppDocuments SHA `a47e776394033af1688a6a8480e3ba4c515fcfcbaa8f4ed2877a2a77a3be7976` 与测试 SHA `333d234155693eb18565e23da8067b4c1ddee8445871ce0507c1b5607a3aa893` 独立快照编译、实际执行 48/48，通过隐私、只读性及边界审查；仅有已声明的公开弃用接口警告。准许进入诊断包，不授予真实主窗 AX 修复或远程完整覆盖结论。

## 2026-10-24：宽度变化保持原文字阅读位置

83e4 实机阅读 MiCLA 时，关闭 PDF 后滚动像素未变，但顶部的“块级硬残差与类级软残差如何分工”跳到了前面的图与评测内容。作者先在真实公开导读、三张科学图、四个公式及四张原表的生产 DOM 中复现：PDF 关闭时同一标题由顶部 12.125px 移至 -1270.547px，iframe 宽度 562→1222px，scrollY 始终为 8090；原段落文字由 12.375px 移至 -1515.953px。侧栏和窗口缩放也使原节点离屏，隐藏导读或阅读器再返回会归零。切到新论文但正文仍在加载时，旧论文目录还保留 20 项。修复前的 12 组检查有 9 组失败，原记录保留。

修复只涉及网页阅读连续性：在当前实际 iframe、document、论文、修订和切篇代次内，记录顶部可见文本的字符 Range，不能取文字时使用当前块或图的可见位置；PDF 开关、分隔条、侧栏和窗口宽度变化后调整到原节点位置。隐藏内容保留原锚点而不采零几何，替换 iframe 时取消旧回调及观察器，不向新论文或新修订传递旧节点。滚动捕获使用固定数量的命中测试，不扫描全文，不重建阅读 iframe 或改写科学正文。新论文安装阅读上下文时立即清空旧目录，加载失败也不恢复旧目录。

首轮作者通过后，非作者实际复跑发现连续键盘调整分隔条的累计漂移：同宽往返后原段落从 12.375px 移至 82.375px，偏移 70px，超过原 40px 容差。这是实质失败，未按首轮通过放行。根因是布局恢复后再次取新行首字符，重复往返会换掉原锚点。后续增加实际 scrollY 见证：恢复后保存真实值，宽度与滚动均未变时继续保留原字符 Range，迟到的自身滚动事件也不能重新选锚点；没有扩大容差。

最终新增 `ReadingContinuity.test.cjs` 并加入 `test.sh`。实际 15 组行为检查全部通过，含快慢四轮共 48 次键盘调整、真实鼠标拖动、PDF 开关、侧栏、窗口与重复观察回调、隐藏页签、隐藏阅读器、A→B→A、加载与失败目录，以及同一 iframe 中科学 DOM 精确不变。独立几何证据单列，不增加检查计数：关闭 PDF 后原标题从 12.125px 到 12.453px，保持同一节点和可见位置，scrollY 正常由 8090 调整为 6807。相关主界面 20、导读 8、公式 13、内容/AX 12、字号 3、延迟上下文 3、导读链接 8、阅读安全 3 也全部通过，连同新套件共 85 组；日志在 `.qa/reading-final-*.log`。

非作者对修正后的相同实现独立复跑通过，并核对原字符 Range、隐藏恢复、帧/文档/来源绑定、旧观察器与回调清理、旧目录清除及原科学 DOM，无新增阻断。其早期报告的 16 条成功记录含 15 组行为检查和 1 条额外几何证据；当前测试已将几何证据移到独立字段，实际计数为 15。冻结 `native.js` SHA 为 `9547e6ffa0d867b1a41a849452bef369e0a3a21a0481308c0e52df5ac19027b9`，测试 SHA 为 `a80997d65cd7f431558e54bb77dfe0f0a201e448e08b207c159e2136bcdee5ca`。未操作用户 GUI、私人资料、Keychain、模型服务或 Zotero；该结论限定于隔离生产 DOM，新包实际 Mac 阅读连续性仍须单独验收。

## 2026-10-24：bdab09eb 实际诊断与新版原归档核验

已正常退出83e4，独审bdab09eb候选的505清单与497实体、签名及C图标后，原子安装同一完整包；非作者再次确认安装与候选全部文件大小、SHA一致。实际主窗Storage仍视觉可见而系统AX空；设置Zotero面板完整可读。两份原生保存的诊断都只读到AXGroup1与opaque1的相同边界，不能判定远端空树，问题保持开放。

用户在系统窗口处理此开发签名读取既有许可后，原602F归档完成真实续传核验。GET及实物验证99/99，操作前143907与后144855快照10/10，保留原父项与8子项完整JSON、3文件字节、journal正文、6个模型事件与3个会话，没有新子项或模型token。summary的最近核验时间正常更新，与journal正文未变分别记账。实际新版设置弹窗显示原论文、检查点保存时间、只读说明及六项“已保存并核验”，不再提供不生效的材料和分类编辑；已保存截图与AX，不借用旧界面证据。

## 2026-10-24：已发布自有会议原图的精确接入

TurnGuide真实导读的三张原图来自我方`nanless/audio-paper-digest-images`，此前均被外部来源白名单拒绝。修复只允许固定owner、仓库、main分支、16个已发布会议目录、12位hash和figure-N.png形态；另支持同一用户GitHub Pages图片仓库内icassp/iclr两个既有日期目录形态。没有开放raw全站、任意仓库、分支、路径、查询或编码绕过。重定向每跳重新核对策略、公网DNS与固定IP；仅这些受控资产可使用已配置的HTTP CONNECT，清理子进程环境，保留原大小和内容检查。

三张TurnGuide PNG经显式本机CONNECT真实GET均200、无重定向，逐字节SHA与我方已发布图片仓库一致。新套件默认纯离线78/78；带真实保存三PNG及本机博客公开内容树12256个唯一图URL的扩展82/82；原资料服务130/130。非作者独立快照编译并实际执行78/78、82/82通过；未将本地URL清单覆盖冒称逐URL联网探测。套件已加入正常测试入口。

该修复使原图可进入阅读、导读导出、完整离线包及Zotero自包含导读。模型当前仍只使用实际提取的文本，没有发送原图像素，不能声称模型读过图。新增测试还发现真实网站MathML在旧Foundation Tidy链中丢失，原失败记录保留并单独继续修复，本批不授予公式保真或实机图文验收通过。

## 2026-10-24：只验证主窗静态弹窗的初始生命周期

受限诊断同停在不透明边界后，本候选只对照主窗解析期静态dialog与真实已可访问设置页的初始化后动态创建差异。两个原dialog的完整markup逐字保留在template；app.bootstrap成功后实例化一次，微任务先让原facade绑定，再绑定原关闭和表单处理，随后仍按原顺序挂载各模块。仅help/export/storage三个初始化前命令FIFO暂存，成功后恰好执行一次；bootstrap失败明确报告并清除队列。不改变ARIA、inert、焦点、窗口、WK设置、PDF及网络服务。

作者相关97组与非作者独立生命周期8组均实际通过，原markup SHA与8种导出、取消、重复打开、迟到响应及模态隔离均核对。native冻结8c49b0d6、index冻结e6e2ac90，新套件加入正常测试入口。此结论只准许真实Mac对照，不代表AX故障已修；若仍空，即否定这个假说并撤回，不再继续猜测DOM变量。
