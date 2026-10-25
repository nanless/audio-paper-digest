# Android 的 Zotero 接入研究与首版建议

核查日期：2026-10-25。本页只依据 Zotero 官方文档、官方团队公告、官方 Android 仓库和 Android 开发文档。没有登录账户、读取密钥、写入真实文库或执行手机操作；以下是实现建议，不能作为已完成验收。Android 全功能映射见[功能对齐表](android-feature-parity.md)，Mac 已有归档要求仍见[原69项验收](mac-app-acceptance.md)。

本轮主任务已采纳：首版保留完整 Zotero 存档目标，使用 **Zotero Web API v3**，由 Android 自己取得专属授权；用户可选择是否启用，系统分享另作快捷入口。这样不要求 Mac 在线，也不依赖官方 Android 应用公开本地写入服务。未完成时保持待实现或待验，不能把分享成功当完整归档。

## 官方 Android 应用当前能做什么

官方[Android 功能页](https://www.zotero.org/support/android)明确支持个人与群组文库同步、书目信息与分类管理、研究笔记、PDF 阅读和高亮/注记/图像/手写标注，以及从其他应用分享 URL、按标识符添加和给直接导入的 PDF 检索书目。浏览器自动取 PDF 仍受需要登录的文章限制。这说明 Android 已有可配合使用的正式客户端，不代表第三方应用获得了其全部内部能力。

必须区分稳定版、测试版和源码。上述功能页仍把 EPUB/网页快照阅读列为后续能力，而[官方团队2026-06-24公告](https://forums.zotero.org/discussion/132371/available-for-beta-testing-on-android-epub-snapshot-support)明确介绍的是 beta 中的 EPUB/快照阅读与标注。因此不能仅看到 master 或 beta 就承诺用户当前正式客户端可以完整打开 HTML 导读。验收记录须包含真实安装版本和发布渠道。 本次核对[官方GitHub Releases](https://github.com/zotero/zotero-android/releases)未见任何发布资产；正式客户端应沿上述官方文档的Google Play入口获取，不能把自行编译的master或测试包作为稳定版验收。

官方[数据/文件同步说明](https://www.zotero.org/support/sync)区分书目、笔记等数据同步与附件文件同步；个人文库可使用 Zotero Storage 或 WebDAV，群组文件不能使用 WebDAV。官方团队另确认了[Android 内配置 WebDAV 的入口](https://forums.zotero.org/discussion/125242/how-to-setup-webdav-server-on-ios-or-in-webbrowser)：文库层级返回顶层，进入设置和账户，再选择个人文库文件同步方式。不能根据旧讨论误报“Android 不支持 WebDAV”。

## 本地端口不能从 Mac 搬到手机

官方[Local API](https://www.zotero.org/support/dev/web_api/v3/local_api)将 `localhost:23119/api/` 定位为桌面 Zotero、供同一台计算机使用的接口，并明确不应将端口转发暴露出去。本次没有找到官方 Android 对第三方提供等价本地读写服务的承诺；Android 的 localhost 指手机自己，不是用户的 Mac。

Mac 的本地许可、钥匙串条目、`Zotero-Server-ID`、本地对象版本与 Web API 的账户/API key/对象版本不是同一身份空间。Android 不复制旧许可、不把本地 user 0 当云端用户、不将 Mac 本地 key 当 Web API key。已有归档映射只能作为受保护历史材料；重新核对实际云账户、文库、对象和原附件后才能建立云端映射。

## 系统分享能提供的最小能力

核查官方 Android 源码时固定到提交 [`cbb929be2a6383906cce3d74408e24ca38f50be5`](https://github.com/zotero/zotero-android/commit/cbb929be2a6383906cce3d74408e24ca38f50be5)。以下是该源码的行为证据，不是已在用户手机测试的结论。

| 入口 | 官方源码证据 | 我们可以承诺到哪里 |
|---|---|---|
| 分享来源 URL | [Manifest](https://github.com/zotero/zotero-android/blob/cbb929be2a6383906cce3d74408e24ca38f50be5/app/src/main/AndroidManifest.xml)有单项 `ACTION_SEND`；[载入器](https://github.com/zotero/zotero-android/blob/cbb929be2a6383906cce3d74408e24ca38f50be5/app/src/main/java/org/zotero/android/screens/share/ShareRawAttachmentLoader.kt)接收 `EXTRA_TEXT` | 通过系统分享选择 Zotero，由用户在其界面确认保存；不承诺携带本站所有元数据 |
| 分享已有 PDF | 同一载入器接收 `EXTRA_STREAM` URI；Manifest 有 PDF 的 `VIEW` | 使用应用自己的 FileProvider 临时只读 URI 与准确 MIME，保留原版本文件；待真实设备确认能导入 |
| 同时发送 URL 与 PDF | 载入器先取文字中的首 URL，再处理文件流 | 不组合这两项来承诺“同一个导入同时保存全部材料”；PDF 分享使用文件流，避免附带含 URL 的 `EXTRA_TEXT` 抢先选择来源 |
| 多文件/完整研究包 | 本次 Manifest 未见 `ACTION_SEND_MULTIPLE`；`*/*` 只表示宽泛匹配 | 未证实RIS/BibTeX/任意ZIP或六角色一键合并导入，不因宽泛MIME宣布支持 |
| 直接打开原生指定条目 | 本次 Manifest 没有可据此保证任意条目定位的公开深链合同 | 可提供云端文库网页入口；原生条目跳转需另核官方协议及实际版本，不能绘制无效按钮 |

[RootViewModel](https://github.com/zotero/zotero-android/blob/cbb929be2a6383906cce3d74408e24ca38f50be5/app/src/main/java/org/zotero/android/screens/root/RootViewModel.kt)在未登录时进入登录引导。分享链还须测试未安装、未登录、用户取消、手机旋转和进程被回收，不把选择分享目标当接收方已持久写入。

我们使用[Android 系统 Sharesheet](https://developer.android.com/develop/ui/compose/sharing/send)，文件按[FileProvider](https://developer.android.com/reference/androidx/core/content/FileProvider)授予单个 URI 的临时读取权。交出文件后只能显示“已交给 Zotero 处理”；Sharesheet 的返回不是父项、附件和笔记的持久化回执。

## 完整存档为什么建议使用 Web API

官方[Web API 基础](https://www.zotero.org/support/dev/web_api/v3/basics)支持第三方专属 API key，推荐通过请求头传递。本次官方仍记载 OAuth 1.0a；不能直接套用 OAuth2/PKCE 流程。[OAuth 说明](https://www.zotero.org/support/dev/web_api/v3/oauth)要求注册应用并取得客户端身份，用户可以批准文库/笔记/写入及群组权限。为尽快得到可验证首版，可先提供用户自行创建的专属 key 输入；不要求用户交出 Zotero 登录密码，不暗中读取官方应用保存的授权。

保存凭据时，[Android Keystore](https://developer.android.com/privacy-and-security/keystore)保护的是加密密钥，不是一个可以直接塞入任意 API 字符串的跨应用密码仓库。建议用不可导出的设备密钥加密 token，密文放应用私有目录，并按[Auto Backup 规则](https://developer.android.com/identity/data/autobackup)排除密文、设备密钥控制记录与传输凭据，避免换机后出现不可解密或串账户的授权假象。清除凭据须先退休内存缓存，再处理可能失败的持久化；本地无法读取和真实 HTTP401分开。

按[官方同步文档](https://www.zotero.org/support/dev/web_api/v3/syncing)，连接后先 `GET /keys/current`核账户ID和实际权限，读取可访问文库及分类。界面显示真实目标，不能把“key 格式看似正确”当授权成功，也不能把权限限定说成只有一个分类。只维护本应用归档所需的对象和映射，首版不必实现整个 Zotero 文库的双向同步客户端。

### 复用六角色材料，替换传输与回读适配器

这里复用的是材料合同、来源绑定、选择预览、去重/冲突原则和 journal 状态机；不是将 Mac 的进程通信或授权实现原样搬过去。

| 角色 | Android 需要保留的材料 | 完成证据 |
|---|---|---|
| 书目 | 实际条目类型、英文原题、作者顺序、日期、摘要、DOI/arXiv/会议身份、URL、标准标签 | 重新GET父项，核来源身份、字段与目标文库；未知字段不补造 |
| 完整元数据 | 已确认机构、ORCID、许可、资源、原评分/量表/分类、版本与本站修订 | 结构化补充材料与必要说明保留，核实际下载字节及SHA |
| 原 PDF | 指定版本的真实原件 | 存储附件已上传/登记；再次下载核SHA-256及实际可打开 |
| 图文导读 | 自包含原HTML、原图/表/公式/图注与修订；必要时加可离线阅读的PDF派生件 | 两份按各自原始/派生身份核内容，真实稳定版Zotero Android断网后可读承诺的格式 |
| 用户所选个人解析 | 原问题、原封存输入、回答、模型/时间/页码/版本及实际用量 | 原会话绑定不变；子笔记或附件真实回读，不把AI回答写入原摘要 |
| 用户所选个人笔记 | 可编辑的私人笔记与必要来源关系 | 核父项、正文和版本；与正式论文正文区分 |

标准字段按[类型/字段及新项模板](https://www.zotero.org/support/dev/web_api/v3/types_and_fields)生成。作者机构等不能硬塞到不合法字段；标准书目之外的已确认信息用明确的补充材料保留。

稳定版HTML快照读取未证实时，导读PDF是用于移动端离线阅读的派生件，不能冒充原论文PDF。必须验证长公式、宽表和科学图完整；同时保存原HTML与原修订可追溯性。若不能完成这个实际阅读链，ZOT-07继续待验，不能仅因云端存在HTML就宣布齐全。

### 文件上传和恢复不是一次 POST

依据[官方附件上传合同](https://www.zotero.org/support/dev/web_api/v3/file_upload)，先创建子附件，再请求上传授权，按返回的地址传文件，最后登记上传；已存在分支也须核实际关联。协议使用MD5与毫秒mtime，我们仍为每份材料另外保留SHA-256。附件外域上传不得携带Zotero API key；只接受经核验的HTTPS上传/下载目标，防止将通用网页地址获得认证头。不能机械套用“所有跨域都拒绝”的桌面本地传输使官方文件流永远失败，也不能无条件转发凭据跟随重定向。

Zotero Storage 的文件额度与本应用坚果云备份是两笔独立的存储条件。达到配额、只有父项或部分子项成功时须保存真实部分状态，不能改成 linked URL 并宣称原文件存储完成。使用WebDAV的个人文库可能存在当前附件只在WebDAV的情况，应按该合同明确提示；不偷偷切换用户文件同步配置。完整首版建议先验明使用Zotero Storage的归档路线，再把其他文件后端作为单独接入条件，而不是借“支持WebDAV”假设所有Web API附件都可通用读取。

[写请求合同](https://www.zotero.org/support/dev/web_api/v3/write_requests)中HTTP200仍可能逐项部分失败；更新要携带对象版本，412后重新读并保护用户编辑。写token的防重复窗口是12小时，不能代替长期journal。建议先原子持久化操作ID、目标和待创建key，再请求；丢应答先查询原key和材料身份，不换key重建。官方允许新项自带key并用version0表达未存在，冲突仍须核实，不能盲覆盖。

任务完成后逐角色GET字段与文件，状态区分“云端已核验”与“官方 Android 客户端已同步并下载”。后一项必须在真实客户端打开验证。同步受[Backoff和429](https://www.zotero.org/support/dev/web_api/v3/basics#rate_limiting)约束，不能为重试连续创建对象；本地凭据不可用、云端拒绝、限流、网络、文件损坏和本地保存失败各自保留状态。

### 笔记、PDF标注和坚果云分别归谁管理

首版完整归档包括所选笔记、解析和可追溯摘录；不需要伪造“已实现所有Zotero标注的双向编辑”。本应用自己的PDF摘录/批注必须按Android功能表实现，绑定原PDF SHA与物理页；官方Zotero的标注同步由其客户端负责。若后续做双向标注，需要另外核官方schema、坐标/页标签、附件父项、冲突与删除规则，不能把另一份PDF里的屏幕坐标直接写回。

论文速递的坚果云目录用于整个研究空间不可变备份，继续使用独立`PaperDigest`目录、目标UUID、8MiB分块、清单和回读；它不是Zotero自己的附件同步协议。不要读取Zotero的WebDAV密码，不向其`zotero`目录写本应用快照，不把Zotero数据库直接同步到普通网盘文件夹。Zotero也明确[不应将数据库放入普通云同步目录](https://www.zotero.org/support/kb/using_multiple_computers)。

## 最小可用实现与真实验收顺序

1. 先完成无凭据的系统URL/PDF分享，验证前述文字优先规则和真实接收界面。没有返回写入回执时只标“已交接”，不创建绿色完整归档记录。
2. Web API专属key输入、加密存储、撤销/删除、重启后主动权限检查；真实只读文库与分类预览，未授权和群组只读目标都不能开始写入。
3. 用用户选定真实论文与专门验收分类完成六角色材料准备，逐项显示缺口；首次实际上传/登记/GET字节回读。图文导读另在真实稳定版Android Zotero读取，必要的派生PDF独立核验。
4. 从原journal测试取消、进程终止/重启、丢应答与续传；成功项不重建、原模型请求数不变。失败注入先在隔离服务完成，不为验收破坏用户现有文库或制造大量重复对象。
5. 真实用户修改字段/标签/笔记或删除附件后，重新读和提示差异；版本/权限变化不覆写。换账户、群组或分类时旧目标锁定，不回落到默认文库。
6. 在官方Android客户端和Mac客户端分别同步打开同一父项、原PDF、导读与笔记，明确本地/云端/另一客户端各自完成证据；测试断网后读取已下载材料。

研究证明接口路线可行，没有证明上述真机操作已经通过。若实施窗口不能完成第3–6步，应向主任务报告Zotero完整接入待验，让其记录首版范围决定；不得把第1步升级为完整存档的验收结果。

## 实施前仍需核实的事项

- 官方Android稳定版实际版本及HTML快照/PDF派生件表现；本次文档与beta公告存在渠道差异，已经明确保留该边界。
- 官方API文件上传、PDF/HTML MIME、图文资源与跨端查看在用户实际存储配额中的表现；群组权限与文件权限分别测。
- 无凭据的系统分享是否接受所需引用文件类型、是否保留原导入意图经过登录流程；本次不承诺RIS/多附件一键完成。
- OAuth正式应用注册与回调安全；最初采用专属key不代表永远不支持OAuth。
- 官方Android仓库采用[AGPLv3](https://github.com/zotero/zotero-android/blob/cbb929be2a6383906cce3d74408e24ca38f50be5/COPYING)，Manifest及源码还引用第三方PDF组件。这里研究接口而非复制客户端代码或SDK；若复用任何代码/二进制，另核对应许可证和分发权。技术研究不是许可证许可结论。
