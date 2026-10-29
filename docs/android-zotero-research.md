# Android 的 Zotero 接入与使用

论文速递工作台通过 **Zotero Web API v3** 将所选论文与个人研究保存到文库。Android 独立配置专用授权，不要求 Mac 在线。Zotero 是可选连接；不配置它也可阅读论文、使用本机模型和备份研究资料。

## 配置与归档

1. 在 Zotero 创建本应用使用的专用 API key，按需要授权个人文库、笔记、写入及群组权限。在本应用的 Zotero 设置中填写授权，不填写 Zotero 登录密码。
2. 主动检查连接。应用通过 `GET /keys/current` 核对当前账户和实际权限，读取可访问文库与分类。
3. 选择目标和论文，预览来源、原 PDF、导读、研究与笔记。材料、目标或凭据变化后重新准备；确认页面反映本次实际选择。
4. 确认归档后，应用保存对象 key 和检查点，逐项写入、下载并核对结果。在任务页查看完整、部分、取消或失败状态。
5. 在其他 Zotero 客户端同步并下载附件。云端回读与另一客户端离线阅读分别完成，后者需要相应客户端的账户和附件设置。

授权由 Android Keystore 的设备密钥加密保存在应用私有目录，排除系统备份。删除授权先撤销内存缓存，再处理持久化。本机凭据不可读、HTTP 401、权限不足、限流和网络失败分别显示；认证失败后由用户修正连接。

官方协议依据：[Web API 基础](https://www.zotero.org/support/dev/web_api/v3/basics)、[权限与 OAuth](https://www.zotero.org/support/dev/web_api/v3/oauth)、[字段与类型](https://www.zotero.org/support/dev/web_api/v3/types_and_fields)。当前使用专用 key；OAuth 应用注册和回调是独立的接入工作。

## 保存哪些材料

| 材料 | 保存内容与核验 |
|---|---|
| 书目 | 原题、作者顺序、日期、摘要、DOI/arXiv/会议身份、URL 与标准标签，回读核对实际父项 |
| 来源元数据 | 已确认机构、ORCID、许可、评分量表、分类、版本及网站修订，下载补充文件核 SHA |
| 原 PDF | 指定版本原件，完成上传和登记后重新下载核 SHA |
| 图文导读 | 自包含 HTML、图片、表格、公式、图注和修订，保留原材料身份 |
| 所选研究 | 问题、输入、回答、模型、时间、物理页、版本及实际用量，独立于论文原摘要 |
| 所选笔记 | 可编辑笔记及来源关系，核对父项、正文和版本 |

缺失元数据保持缺失。标准书目以外的信息使用补充材料，不写入不合法字段。个人回答与论文原文分别保存。

## 文件后端与坚果云

Zotero 的书目、笔记同步和附件同步是不同服务。个人文库附件可用 Zotero Storage 或 WebDAV；**群组附件不使用 WebDAV**。官方说明见[数据与文件同步](https://www.zotero.org/support/sync)。

Zotero Storage 空间不足时，本应用可请求用户明确确认，沿原归档改用已配置的坚果云附件连接。原父项、Storage 记录及成功材料保留，新附件按对应后端重新核验。更改连接或重启后需要再次确认；权限不足、目录不符或材料不全时保留原状态。

Zotero 的附件目录与本应用的研究备份目录分开。本应用的 `PaperDigest` 目录保存整个研究空间的不可变版本，不能写入 Zotero 的 `zotero` 附件目录。其他 Zotero 客户端须独立设置相同 WebDAV 并同步下载；本应用不读取它们保存的密码。Zotero 数据库也不放进普通云同步目录，见[官方说明](https://www.zotero.org/support/kb/using_multiple_computers)。

## 取消、继续与远端修改

归档记录长期保存操作身份、目标、对象 key、版本和材料。取消后继续同一操作，成功项不重建；丢失应答先查询原对象。官方写请求的 12 小时去重 token 只作辅助，长期恢复依赖本应用的记录。

更新前读取对象版本。HTTP 412、远端用户修改或附件删除会停止覆盖并提示差异；切换账户、文库、群组、分类或权限后，旧映射不能直接继续。部分写入保留已成功材料和断点。

文件上传按[官方协议](https://www.zotero.org/support/dev/web_api/v3/file_upload)依次授权、传输、登记和回读。协议使用 MD5 与毫秒时间，本应用另核 SHA-256。外域附件传输只使用核验后的 HTTPS 目标，不携带 Zotero API key；重定向不得泄漏认证信息。[写请求](https://www.zotero.org/support/dev/web_api/v3/write_requests)和[限流](https://www.zotero.org/support/dev/web_api/v3/basics#rate_limiting)返回的部分错误、Backoff 与等待时间分别处理。

## 官方 Android 客户端的阅读范围

已在官网稳定版 **1.0.0-247** 实际同步打开同一归档的 MiCLA 原始 PDF、导读与笔记，断网冷启动后仍可读取；指定导读的混合公式和方法图实际可见。因此这一归档不需要额外生成导读 PDF。其他 HTML、EPUB 或客户端版本按其实际支持范围使用。

安装官方客户端可使用 [Google Play 或官网 APK](https://www.zotero.org/download/android/)。官方[功能页](https://www.zotero.org/support/android)和[快照测试版公告](https://forums.zotero.org/discussion/132371/available-for-beta-testing-on-android-epub-snapshot-support)对应不同渠道，选择时核对实际版本。

本应用自己的 PDF 摘录和批注绑定原 PDF SHA 与物理页，不直接修改官方数据库。当前不提供 Zotero 标注的双向编辑；官方标注同步由 Zotero 客户端负责。

## 系统分享与 Mac 本地接口

系统分享将 URL 或单个 PDF 交给接收方处理，界面显示交出结果；完整书目和多角色附件归档使用本页的 Web API 流程。PDF 使用 FileProvider 的临时只读 URI，避免同时附带来源 URL 使接收方优先处理文字。当前不承诺 RIS、多附件或任意 ZIP 的一键导入。

分享行为的源码依据固定在官方提交 [cbb929be](https://github.com/zotero/zotero-android/tree/cbb929be2a6383906cce3d74408e24ca38f50be5)，系统行为见 [Sharesheet](https://developer.android.com/develop/ui/compose/sharing/send) 与 [FileProvider](https://developer.android.com/reference/androidx/core/content/FileProvider)。

Mac 的 `localhost:23119` 是同机桌面接口，不能移植为 Android 本地服务或向外转发。Mac 的许可、`Zotero-Server-ID` 与对象版本不作为 Android API 授权；导入的旧记录只作历史，建立 Web 映射时重新核对账户和对象。见 [Zotero Local API](https://www.zotero.org/support/dev/web_api/v3/local_api)。

本应用采用公开接口，不复制官方 Android 客户端。其源码采用 [AGPLv3](https://github.com/zotero/zotero-android/blob/cbb929be2a6383906cce3d74408e24ca38f50be5/COPYING)，如后续复用代码或二进制，需单独核对相应授权。验证范围见[Android 验证说明](<android-validation.md>)和[功能表](<android-feature-parity.md>)。
