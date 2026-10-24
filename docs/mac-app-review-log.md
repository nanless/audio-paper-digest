# Mac 应用独立审查原始记录

以下按独立审查者的实际记录保留发现、修复和复验。局部源码或隔离测试通过，不授予真实模型、用户文库或全部Mac窗口通过；最终状态见[实施与验收记录](mac-app-validation.md)。


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

已形成实际 arm64 原生安装构建，至少五轮实质变化及独立审查发现均已有记录；第五轮新增七项问题已修并按范围复验。最终冻结源码及25项独立原生隔离测试见本文第五轮。真实 LLM 研究、Zotero 完整归档回读及锁屏后的原生界面旅程仍待端到端证据；69项不能整体授予通过。

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
