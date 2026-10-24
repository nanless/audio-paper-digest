# Mac 应用与 Zotero 的本机归档

## 当前核对结论

2026-10-24 按 Zotero 技能先运行 `status --json`：本机为 Zotero 10.0.6，本地 API v3、schema44 与 Connector 均可用；本地 API 偏好已开启。没有升级 Zotero、安装扩展或更改用户偏好。没有直接读取或修改 Zotero SQLite。

技能附带旧路由说明将本地 API 描述为只读。当前官方文档和实际客户端版本已经支持 Zotero 10 的写入及存储附件，因此本应用以当前官方协议和实际能力检测为准，不将旧版本限制当成现版本结论。

官方依据：

- [Local API](https://www.zotero.org/support/dev/web_api/v3/local_api)
- [Write Requests](https://www.zotero.org/support/dev/web_api/v3/write_requests)
- [File Uploads](https://www.zotero.org/support/dev/web_api/v3/file_upload)
- [Connector HTTP Server](https://www.zotero.org/support/dev/client_coding/connector_http_server)

## 授权由用户完成

读取文库不代表已经获得写入许可。应用显示本机连接状态、真实可用集合后，只有用户发起连接才请求 Zotero 的原生授权对话框。用户可以拒绝、单次允许或持续允许。持续许可的权限覆盖本机可编辑文库，不能在界面中误写为“仅此分类权限”。应用本身仍将一次归档限制到用户明确选择的目标集合和论文。

应用不得读取用户 profile 中别的程序的授权密钥，不把密钥写进普通偏好、日志、仓库或导出文件。授权失效时停止并请求用户重新授权，不循环弹窗。主程序用钥匙串保存用户明确选择持续允许的密钥；单次密钥只保留在内存，消费后作废。

授权与检查点必须绑定当前 Zotero Server ID。更换文库实例后，旧集合、条目Key、版本及归档检查点不能直接复用。

启动、读取设置、检查 Zotero 连接和列出分类不会读取钥匙串密钥。首次显示“已保存许可尚未检查”，不将未知状态当作未保存或已授权。用户点击“检查已保存许可”时，应用才读取当前文库实例下自己的凭据；系统可能要求用户确认。已有持续许可会直接复用，不请求新的 Zotero 密钥；钥匙串读取被拒绝时保留原凭据，不自动创建替代许可。用户明确归档、继续归档或请求授权时也可恢复原许可。

模型设置同样只显示本次会话已确认的状态。完整来源及配置指纹相同的既有成功解析可直接复用，不读取密钥、不新增请求；真正新请求才读取一次密钥。保存或删除密钥成功后直接更新状态，不为刷新界面再次读取。服务名、钥匙串域、ACL和可访问性策略保持原样。

## 归档合同

一次完整归档至少区分以下内容，不将一个RIS导入成功称为整套归档完成：

1. 正式书目父条目：原题、作者、原文摘要、论文日期、arXiv版本/DOI、来源URL、真实标签。网站发表日期与论文发表日期分别记录，评分明确是本项目评价。
2. 存储型原PDF附件：指定版本、真实文件内容，不能只保存远程URL或本机临时文件链接。
3. 自包含图文导读HTML附件：包含实际图片像素、MathML、原表格、来源地址和导读版本；不会在离线打开时依赖应用临时服务。
4. 用户要求保存的个人解析和笔记：作为同父条目的子笔记，明确个人内容与网站导读的区别。没有个人解析时不生成虚构内容。
5. 归档结果：逐项完成/失败、真实Key、回读结果、可重试项；部分完成必须明确显示。

去重依据是精确论文身份，不只比较标题相似。复用既有父条目时保留用户原有字段，不用网站样本覆盖人工信息；需要加入新集合时采用实际版本前提。附件与子笔记有独立内容身份，重试先回读已经保存的材料，再只补未完成的步骤。

## 本机协议适配

本机10.0.6的 `/api/items/new` 模板路由实测返回404；应用不能因为读到Web API文档就假设所有模板路由都存在。`/api/itemTypeFields` 的 preprint、journalArticle、conferencePaper、webpage 四类均已实际只读获取，可核对当前类型支持的字段。

写请求携带本机实例身份和用户授权。写多对象的HTTP200不是每个对象成功，必须检查逐项失败集合。版本前提冲突不能静默覆写。

存储附件按正式三阶段协议提交文件授权、真实字节与登记。只接受同一个固定loopback服务器返回的上传地址，不把本地密钥发送到远程重定向。上传完成后回读实际子条目和存储文件，核对MD5以及应用自己的SHA256；仅返回201/204不能替代附件可读验收。

## 真实验收边界

实际写入仅使用用户指定的独立集合“论文速递｜应用验收”和公开MiCLA论文，保留无关文库条目。验收报告只记录完成事实及非敏感内容身份，不记录授权密钥、用户profile路径或整个文库。

当前本段记录的是能力调研与实现合同。尚未触发原生写入授权，也未宣告真实归档通过；正式服务与逐轮测试结果将在实现后补充。

## 已实现的服务与原生桥

`apps/macos/Sources/ZoteroService.swift` 提供 Foundation actor，通过 `handle(command:payload:progress:)` 接入原生桥。网页拿不到本地API密钥。固定本机地址为127.0.0.1:23119，拒绝HTTP跳转和非同源上传地址。存储文件路径只接受应用资料目录中的普通文件，并拒绝符号链接和目录逃逸。

支持命令：

- `zotero.status`：真实客户端版本、API、实例身份、内存中的授权状态（未检查时明确为 unknown）及该实例下的未完成归档摘要；不读取凭据。
- `zotero.checkAuthorization`：用户明确检查当前实例的已保存许可，不请求新许可或写入条目。
- `zotero.collections`：真实个人文库集合，支持分页与父级关系。
- `zotero.authorize`：请求Zotero原生授权。拒绝返回真实denied状态；单次允许如实返回remember=false，不自动连弹或偷换成持续许可。
- `zotero.archive`：归档明确选择的书目与材料，返回逐步回读结果。
- `zotero.resume`：按原检查点继续。材料指纹或文库实例变化时拒绝复用。

身份支持日更arXiv、DOI、会议规范标识与旧网页降级身份。会议没有DOI时使用真实 `conference:...` 身份，不编造arXiv；网页降级只接受本项目canonical博客路径，存为webpage并明确原论文身份未核验。管理标记为Extra独立整行和对应身份SHA标签；标题相似、正文引用了某编号、外国网站恰好含相同路径，都不能充当同一论文证明。

创建书目时读取来源明确提供的 `bibliography.fields.itemType`，仅允许 journalArticle、conferencePaper、preprint、webpage。arXiv、规范会议和降级网页可按真实身份使用相应默认；只有 DOI 而没有来源类型时拒绝，不能把 DOI 论文统一猜成预印本。出版物、会议论文集、卷期、页码、语言等只接受来源实际给出的字段，并在任何集合或条目写入前按真实类型的字段列表检查。arXiv 身份的已发表期刊文章使用 journalArticle，Extra 保留 arXiv 标记，不写该类型不支持的 archiveID/repository。复用用户已有条目时不擅自改其类型，完整来源信息仍随元数据附件保存。

归档现在包含一份必需的 `source-metadata.json` 存储附件：完整保留归档输入Bibliography、身份及身份限定。它与PDF和HTML一样走正式上传并按实际字节回读。复用已有父条目时保留用户人工编辑，原始摘要、作者、日期、评分等输入不会因父条目已存在而丢失。元数据附件没有本机路径或密钥。

附件具有不可变内容身份。若管理附件的实际MD5或文件字节已经被用户改变，报告冲突并保留用户版本；即使MD5为空，也先检查真实文件，不将空hash解释为覆盖许可。服务不拿“当前MD5”自授If-Match覆盖权限。个人笔记回读同时核对管理标记和真实正文，不能仅凭标记认定内容完整。

`Resources/zotero-ui.js` 提供主窗与独立设置窗共用的真实状态、分类选择、原生许可入口、材料勾选、部分结果、原检查点重试及Zotero条目打开功能。没有真实个人解析时，解析项保持不可选。缺PDF或自包含导读时明确显示缺失，不把书目成功当完整材料成功。

## 当前验证结果与限制

- Swift6严格编译通过，67项隔离服务断言通过。
- 隔离mock验证覆盖完整归档、逐步失败恢复、重复归档、401失效、拒绝/单次许可、跨文库实例、用户PDF修改保护、复用父字段保护、原始元数据附件完整性、目录逃逸/符号链接、精确身份负例和非自包含HTML。
- HTML负例包含远程图片、未加引号的src、相对CSS资源、@import、编码脚本链接、SVG image/use以及同一标签两个href、引号内大于号提前截断的绕过。inline SVG image/use/feImage能力在属性扫描前整体拒绝；科学SVG使用内嵌img data URI。HTTPS仅对普通a链接开放，资源href不能依赖远程服务器。
- 用同一Swift服务实际只读访问本机10.0.6成功，识别X-Zotero-Version/API3和50个分类；没有把schema模板404或HTTP200逐对象失败误当成功。
- 本阶段尚未请求真实写入授权，也尚未在验收集合保存条目。所有上传/恢复通过结果当前来自隔离mock，不是实际Zotero写库验收。真实写库必须等用户在原生授权窗口决定，并在应用中选择独立验收集合后继续。

独立测试入口：

```sh
swiftc -parse-as-library \
  apps/macos/Sources/DesktopArxivIdentifier.swift \
  apps/macos/Sources/BackupCodec.swift apps/macos/Sources/DesktopStore.swift \
  apps/macos/Sources/LibraryService.swift apps/macos/Sources/DesktopStorage.swift \
  apps/macos/Sources/ZoteroService.swift apps/macos/Tests/ZoteroServiceTests.swift \
  -o /tmp/paper-digest-zotero-tests
/tmp/paper-digest-zotero-tests
```

该入口使用临时目录、模拟HTTP和内存授权存储，不写真实文库、profile或系统钥匙串。测试PDF明确是单元测试夹具，不能当成真实公开论文验收。


## 隔离桌面界面验证

`node apps/macos/Tests/DesktopUI.test.cjs` 使用独立 headless Chrome 临时 profile，加载实际 native.js/settings.js/dialogs.js 与已发布 MiCLA 的真实 Markdown、4个原公式、3张核 SHA 科学图和4张原表。原生桥、PDFKit、模型请求、用户笔记存储和 Zotero 状态为明确隔离夹具，不连接真实个人资料、模型或 Zotero。

当前20组验证全部通过，覆盖标题去重、MathML原公式、评分八维明细与机构保留、iframe脚本隔离与原生主frame守卫、显式PDF打开/关闭保留阅读状态、重复显式打开保持双栏、对话框role/inert与PDF遮挡、笔记写入成功/失败路径、笔记汇总、标注来源身份与移除、模型错误对象与未知费用、导出正文身份/版本绑定及加载中拒绝旧正文、设置保存失败消除旧成功提示。该结果证明实际网页模块与桥合同集成，不代替真实WKWebView/PDFKit/原生授权验收。


`apps/macos/Tests/DesktopNativeTests.swift` 将实际原生 Sources 与测试入口共同编译，在临时资料目录注入 Store、拒绝联网的 Library、无持久凭据的 Zotero 和无密钥的 ModelService；不调用应用启动、不建立窗口或打开授权对话框。当前25组实际 AppKit/PDFKit 回归通过，使用核SHA的真实13页MiCLA PDF，验证当前页/范围/全文/真实文字选区、物理页码/SHA/版本、旧owner与旧SHA拒绝、取消选区失效、超长导读/真实页组成的超长PDF在付费前拒绝、章节目录范围、混合空白页明确披露、设置URL/范围/枚举/真实JSON布尔与数字类型边界。备份恢复的系统对话框不在自动点击范围内。

```sh
swiftc -D PAPER_DIGEST_TESTS -parse-as-library \
  apps/macos/Sources/*.swift apps/macos/Tests/DesktopNativeTests.swift \
  -o /tmp/paper-digest-native-tests
/tmp/paper-digest-native-tests
```


## 私有资料异目录恢复

`BackupCodec` 仅收集应用私有资料目录中的实际普通文件（包含隐藏文件），不读取系统钥匙串。`paperdigest-backup-v2` 记录原目录、相对路径、SHA256和完整文件字节；512MiB限制指原文件总量，编码JSON另限750MiB，条目最多100000。合同、大小、全部SHA和完整路径/别名冲突先统一核验，再写入独立0700暂存目录，文件为0600；失败不触碰live目录。科学、归档历史JSON不重写，单独生成 `RestoredPathRoots.json` 保存原根及合法历史根。20组Codec回归通过。

Zotero新归档检查点在创建时记录pdf/guide真实SHA。恢复原检查点时先读取原记录，再用旧路径、旧SHA及严格rootmap重定位当前私有文件，最后仍核对原完整请求指纹。没有改写request中的路径或历史fingerprint；rootmap不授予来源资格、授权或成功状态。旧记录未保存材料SHA时，同目录仍按原指纹验证，跨目录拒绝自动迁移。新增11项服务断言覆盖异目录部分恢复、篡改/缺map/越界/符号链接/请求变化、旧SHA缺失和换实例授权，连同原53项共64项通过；全部为隔离mock。


最新跨服务回归直接使用ZoteroService真实mock归档生成的journal与summary，再调用DesktopStorage.cleanupPlan，确认合法summary不会被误判损坏检查点，仍只生成需确认的计划，不删除文件。总服务断言现67项通过。当前目录同时接受原始directory.path、Foundation规范路径与POSIX realpath的等价形式；真正旧目录仍必须映射与原SHA，不能借此把任意符号链接或旧根变成当前根。

桌面隔离UI最新20组通过，新增阅读A/B异步交错、继续阅读模式/PDF/草稿、local导入清除旧引句、批注自动保存/失败保留与原owner、离线资料modals。52张1440×900/1080×700浅深截图位于忽略的 `.qa/desktop-ui`，PDF区域及任务/离线状态明确标作夹具。原生新增退出/维护gate与实际加密PDF密码回归，合计25组通过。


最终增补验证：Zotero真实journal结果提供identity/title；resume请求夹带另一论文的identity/title仍返回原journal来源，累计67项通过。模型worker实际本机HTTP回归60项检查、18次loopback请求，覆盖显式Chat/Responses、错误分类、跨截断边界脱敏以及200未返回模型名时actualModel未知、相同完整结果复用不重发。界面最终20组通过；仅受影响模态补拍12张、实际780×610设置四页及模型底部浅深补拍10张，另存panels-manifest.json。未使用真实API key、付费端点或Zotero许可。
