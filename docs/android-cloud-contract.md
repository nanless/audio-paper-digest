# Android 与 Mac 的研究资料、备份和坚果云合同

Mac 与 Android 的论文速递工作台使用共同的资料包和坚果云版本格式。本文说明字段、大小限制、传输顺序、恢复保护与兼容范围；实际验证和发行状态见[验证说明](<android-validation.md>)。Android 的 Zotero 归档使用 Web API v3，Mac 本地归档记录作为历史保留，两端分别配置授权。

操作入口见 [Mac 坚果云说明](<mac-app-cloud.md>)，固定合成数据与正反例见[兼容性样例](<android-cloud-portable-fixtures.md>)。备份保存研究材料，不搬运设备凭据和本机完整性密钥；多设备采用独立版本与明确恢复，不提供实时自动合并。

## 1. 共用什么，哪些由设备自己管理

两端共用格式和兼容性样例，平台存储、密码保护、后台任务与 PDF 提取器分别实现。研究文件的恢复、来源核验和模型结果复用分别检查各自条件。Android 实现见 [BackupCodec.kt](<../apps/android/app/src/main/java/com/nanless/paperdigest/cloud/BackupCodec.kt>)、[CloudArchive.kt](<../apps/android/app/src/main/java/com/nanless/paperdigest/cloud/CloudArchive.kt>)与 [RestorePolicy.kt](<../apps/android/app/src/main/java/com/nanless/paperdigest/cloud/RestorePolicy.kt>)。

| 层 | 合同或入口 | 保存与恢复规则 | 范围 |
|---|---|---|---|
| 研究空间 | `BackupCodec`，`paperdigest-backup-v2` | 保留研究原件、逐文件 SHA、整体上限与路径检查；新导出排除两份本机完整性密钥 | 来源真实性、模型请求与远端授权分别核验 |
| 云端完成版本 | `CloudArchiveService`，`paperdigest-cloud-snapshot-v1` | 同一路径、UTC月份、分块索引/大小/哈希、完成清单和逐块回读 | 全部块、清单与本机回执均核验后完成 |
| 研究数据 | `personal.json` schema 1、离线包 v1/v2、原始 ModelUsage | 保持原 ID、版本、原文/图/输入/回答/费用字节；未知字段保留 | 恢复不能重签旧模型输入、给旧缓存升级“最新”状态 |
| 恢复政策 | `RestoreLocalPolicy`、请求连续性 v1、`applyRestorePayload` | 保本机路由与预算、原资料旁存、暂存/确认/回滚 | 下载后经用户确认再恢复；不自动合并两台设备的笔记 |
| 本机云控制 | `CloudLocalStore` profile/pending/checkpoint | Android 使用独立私有控制目录和独立凭据引用 | 不从快照替换账号、设备目标ID、自动计划或待传快照 |
| 密码与授权 | Mac Keychain；Android Keystore 适配 | 各设备主动配置自己的 API key、应用密码与授权 | 不迁移系统钥匙串、Keystore 私钥或其他应用的许可 |

“同功能”要求相同的结果和错误边界，不要求相同窗口布局或后台保证。Android 的系统调度与 Mac 的“应用运行期间到期检查”不是同一个生命周期；界面须分别说明真实行为。

## 2. 研究目录与设备控制目录

Android 当前实现采用以下独立子树；备份内相对路径仍按现有合同保留：

```text
noBackupFilesDir/
  PaperDigest/                 ← 完整研究空间；只此树进入 BackupCodec
    personal.json
    ModelUsage/ …
    Offline/ …
    Imports/ …
    Exports/ …
    RestoredPathRoots.json
    RequestBudgetContinuity.json
    RestorationReceipts/ …
    …其他研究普通文件，包括隐藏文件；两份本机完整性密钥除外
  PaperDigestCloud/            ← 本机控制；永不递归进入研究快照
    profile.json
    destination-UUID/
      snapshot.paperdigest
      pending.json
    archived-UUID/ …
  PaperDigestSecrets/         ← Keystore 包装后的本机凭据，不进入研究快照
  PaperDigestDevice/          ← 设备派发 epoch、模型密钥端点绑定，不进入研究快照
```

研究目录不能放在系统可能回收的 `cacheDir`。使用内部 app 专用目录，不需要申请读写整个共享存储；卸载仍可能删除 app 专用资料，因此必须提供用户主动导出及云端完整备份。[Android app 专用存储](https://developer.android.com/training/data-storage/app-specific)

研究、凭据、云账号、设备标识和待传材料均位于 `noBackupFilesDir`。应用设置 `allowBackup=false`，并提供系统备份与设备迁移的排除规则；正式包核对编译后的实际 XML。更换设备后，重新设置本机凭据和云目标，再主动导入研究快照。[Android Auto Backup](https://developer.android.com/identity/data/autobackup)

用户从系统文件选择器提供的 `content://` PDF，先有界复制成内部研究目录下的普通文件，验证实际 PDF 与 SHA，再分配 `local:<原PDF SHA>`。不把 URI 假写成绝对文件路径；不在恢复时凭旧设备路径访问外部文件。备份导入/导出用 `ACTION_OPEN_DOCUMENT` / `ACTION_CREATE_DOCUMENT`，将得到的流复制到内部暂存后完整校验，取消选择不创建成功任务。[Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files)

## 3. `paperdigest-backup-v2` 的字节合同

现有实现为 [BackupCodec.swift](<../apps/macos/Sources/BackupCodec.swift>)，不是 ZIP，也没有额外压缩或端到端加密。

| 字段 | 类型与解释 |
|---|---|
| `contract` | 精确字符串 `paperdigest-backup-v2` |
| `sourceDirectory` | 原研究目录的有效绝对路径；仅作为受控旧路径映射信息，不是恢复写入目的地 |
| `files` | 文件条目数组，最多100000项；新导出按相对路径排序 |
| `files[].path` | 非空、无尾斜杠的相对路径，UTF-8最多4096 bytes |
| `files[].sha256` | 原始解码文件字节的64位小写十六进制 SHA-256 |
| `files[].data` | 标准 Base64 编码的原文件字节，对应 Swift `Data` 的 JSON 表达 |

上限为原文件合计 **536870912 bytes（512 MiB）**、整个 JSON 编码 **786432000 bytes（750 MiB）**，以及100000个文件条目。每个文件也受剩余总额约束；先检查输入大小，再流式/有界解码，不能先无限分配 Base64 对象。超限整体拒绝，不能删除图片、账本、旧导读或隐藏文件后把子集叫完整成功。Android 应避免同时保留多份750 MiB字符串、Base64副本及全部解码字节，可在私有临时文件逐项校验并保持同一最终编码字节。

解析顺序必须保留这些检查：

1. 验合同、条目数量、原根路径；拒绝空段、`.`、`..`、反斜杠、控制字符、绝对条目路径和尾斜杠。
2. 路径及每一级目录片段，按现有 NFC 归一及大小写折叠检查别名碰撞；不能只依赖 Android 的大小写敏感文件系统。重复文件、`A/x` 与 `a/y`、文件与其子路径并存均拒绝。
3. 每份 Base64 解码字节计入总额，核原 SHA。`personal.json` 必须存在且可解析为对象；进入应用恢复前还须通过 `DesktopStore` 对 schema/notes/settings/list/sessions/jobs 等结构的校验。
4. 如有 `RestoredPathRoots.json`，只允许原两个键 `contract` / `roots`，合同为 `paperdigest-storage-aliases-v1`。旧根不能重复、大小写/NFC碰撞或互相包含；保护保留名本身及其目录别名。
5. 全部校验通过后才创建新的暂存目录；文件按私有权限写入，再逐文件回读。拒绝符号链接、特殊文件及经过链接的父目录。

原 SHA 基于文件原字节，不能因为 Kotlin 重新排 JSON 键、转义斜杠、归一 Unicode、重排数组或更改换行而重算旧文件 SHA 后冒充同一材料。保留未知文件和字段；对不能理解的未来合同明确拒绝执行恢复，原包可保留。

`RestoredPathRoots.json` 在暂存目录中派生更新；旧 `personal.json` 按恢复政策生成当前有效配置。派生副本与下载原包分别记录校验值。旧绝对路径重定位须有对应文件原 SHA；映射文件只解决路径，不提供来源、模型或授权能力。

## 4. 坚果云远端版本合同

固定服务为 `https://dav.jianguoyun.com/dav/`。两端可使用相同用户指定的独立目录，默认 `PaperDigest`；目录限定 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，禁止含 `..`，并大小写不敏感地拒绝整个目录名 `zotero`。账号不得含冒号或控制字符。使用各自创建的第三方应用密码，不采用网页登录密码。[坚果云应用密码说明](https://help.jianguoyun.com/?p=2064)

```text
/dav/PaperDigest/
  2026-01/                    ← UTC年月，精确 YYYY-MM
    00000000-0000-4000-8000-000000000001/
      chunk-000000.bin
      chunk-000001.bin
      …
      manifest.json           ← 最后创建，回读成功后才是完成版本
```

上例只有公开合成标识。实际每份新版本随机生成 UUID，目录采用小写规范形式；月份在2000–9999年内。现有布局没有设备子目录，不能给 Android 擅自插入 `android/deviceID/` 后声称原 Mac 可以发现它。不同设备的新 UUID 版本自然并存，设备身份目前不作为远端清单字段。

远端 `manifest.json` 为以下固定语义：

| 字段 | 约束 |
|---|---|
| `contract` | `paperdigest-cloud-snapshot-v1` |
| `reference.month` / `reference.id` | 与请求所在UTC月份/UUID完全相符 |
| `createdAt` | **Unix毫秒数值**；当前实现先规范到UTC整秒，因此必须对应整数秒、与月份一致 |
| `encodedBytes` | 完整 BackupCodec 编码的实际字节数，范围1–786432000 |
| `sha256` | 完整编码原字节的SHA，不是解码文件总SHA或JSON语义SHA |
| `chunks` | 顺序数组，数量恰为向上取整 `encodedBytes / 8388608` |
| `chunks[].index` | 从0连续递增，无重复、缺失和重排 |
| `chunks[].bytes` | 每块8388608 bytes，最后一块为实际余数；均大于0 |
| `chunks[].sha256` | 对应该块实际字节的SHA |

远端 manifest 最多128 KiB；DAV 列表响应最多4 MiB。传输按原编码从第0字节分块，最后下载拼接必须完全等于上传时的编码字节。新编码允许使用不同 JSON 键顺序，但同一次续传绝不能重新编码。清单/块保持原对象，不在原UUID下改写成新研究空间。

**时间不能混用。** `CloudArchiveService` 显式采用 `.millisecondsSince1970` 编远端清单。Mac 的本机 `CloudLocalStore` 使用默认 `JSONEncoder` 保存 `Date`，例如嵌套 checkpoint 的日期是2001-01-01参考纪元的秒；而 pending 的 `createdAt`、完成摘要是 ISO8601 字符串。本机控制不是跨端迁移合同。Android可采用自己明确版本化的控制编码，不把这些本机数值当 Unix毫秒，不把JS `SnapshotInfo`展示字符串当远端清单原值。

## 5. 同一上传、续传和完整性判断

Android 手动保存和后台保存必须汇合到同一执行路径，顺序与Mac一致：

1. 主动连接检查；flush笔记/设置/批注；核无其他活跃任务，短维护窗口冻结完整研究目录。
2. 采集、校验并把最终编码保存至研究目录之外，原子保存目标ID、编码长度/SHA、文件数等 pending；此后上传只读这份固定文件。
3. 原子保存随机快照身份及分块 checkpoint，然后才创建远端目录。`MKCOL 405` 本身不证明目录存在，必须用精确 `PROPFIND Depth:0` 证实 collection。
4. 对每一块，先 GET 已存在对象；缺失时 PUT 加 `If-None-Match:*`，随后 GET 回读原字节。已有对象、412或丢应答均不能直接覆盖；若字节不同即停止并保留材料。
5. 每个已核块的检查点必须先持久化再继续。全部块完成后才 create-only 写 manifest、GET核完整合同，最后持久化 `manifestVerified`；本机写入失败不报成功。
6. 即使旧 checkpoint 写着完成，重试也须回读远端 manifest 和全部块；原目标、快照、创建时间、分块、总SHA/长度都不能换。后来的本地编辑只属于下一份快照。

暂停/取消保留原 snapshot 和 checkpoint，取消是独立终态。更换账号或目录时生成新的本机 `destinationID`，不能让同一旧许可把待传材料投向新目标。存在未完成/损坏/孤立材料时，先由用户明确“保留并结束本次续传”；整体移动保留所有原文件、旧 connection 另存不覆盖、暂停自动任务，云端半成品和旧完成版本均不删。仅完整并正常校验的保留包才可恢复，不能承诺损坏包一定救回。

排队工作携带的原目标也必须绑定到实际上传：在云服务取得操作锁后、读取密码/生成快照/联网之前核对原 `destinationID`。不能只在 worker 开始或申请前台通知之前检查；通知、维护锁或系统调度等待期间保存了新目标时，旧任务须明确拒绝，不能自动采用新账号。

SHA和HMAC核验用于完整性与原材料绑定；当前云包经HTTPS传输但没有额外端到端加密，不能把哈希清单叫作加密或由独立可信方签名。任何新增加密外层都需要新合同与两端实现，不能让旧Mac在同一v1清单下拿到无法解析的密文。

## 6. 列表、认证和请求预算

坚果云官方当前说明默认单文件500M、免费账户每30分钟600次请求、付费账户1500次，以及单次目录最多750项。两端继续采用更保守的600次本机窗口与最小3.1秒间隔；8 MiB分块避免将整个编码包作为单个大文件上传。不能把官方500M简单换写成500 MiB，或把分块解释为本项目无限容量。[坚果云WebDAV限制](https://help.jianguoyun.com/?tag=webdav)

查询必须由用户指定明确UTC月份，`PROPFIND Depth:1` 读其直接成员。当前Mac没有实现官方分页扩展；响应成员数达到750就拒绝“不完整列表”，包括根目录项，不从750项中挑一个前缀。XML拒绝外部实体/DTD/错误namespace；同一个成功propstat内的collection才成立。路径必须精确属于固定服务/当月，拒绝重复、越级、大小写不规范UUID、错误月份或混入其他目标。

每个UUID目录再GET完成清单：404是未完成，不列成功；其他失败/限流使整个查询报错，不能显示“没有备份”。这会增加请求数；如果中途达到600次预算，保留错误，不将已读取部分当完整结果。后续分页/索引需要单独可验证的新设计，不能用尚不存在的索引省略枚举核验。

| 情况 | 对外状态与后续 |
|---|---|
| 本机密码缺失、Keystore不可用或未获本机许可 | `credentialsUnavailable`，固定安全提示；不发HTTP、不谎称服务拒绝 |
| HTTP401 | `authentication`；停止并暂停自动计划，不自动换账号或重试 |
| HTTP403 | `forbidden`；明确目录拒绝，不改写成网络离线 |
| HTTP429/503 | 解析 `Retry-After` 秒数或HTTP日期，停止新请求；上传冷却持久化到原checkpoint |
| 用户/系统任务取消 | 保持取消语义，不改写认证或传输失败，不重置原快照 |
| 重定向、响应超限、坏SHA、保存失败 | 安全停止，保留原材料，不发送凭据到新地址 |

600 次为各端本机预算，Mac 按同目标服务实例的运行期计数；两台设备独立计数，没有跨设备额度锁。服务返回的 429/503 与等待时间仍须服从。上传冷却保存在原检查点，重启后继续等待；账号或凭据哈希不得作为跨设备身份。

两端拒绝任意重定向，包括同域重定向；TLS正常验证，不接受自签异常或关闭主机核验。Basic认证只发固定HTTPS来源，无cookie/全局凭据缓存；HTTP正文、底层异常、账号和密码不写可分享日志。Android 使用声明式网络安全配置关闭明文连接，HTTP 客户端禁止自动重定向并限制响应流大小与超时，XML 解析关闭实体。[Android网络安全配置](https://developer.android.com/privacy-and-security/security-config)

## 7. 跨设备恢复不搬运本机授权

模型API key、网盘应用密码、Zotero许可、Android Keystore私钥及Mac系统Keychain条目不在研究目录，不随快照迁移。Android的模型与云密码分别由本机Keystore生成的加密密钥包装，密文、随机nonce及目标引用置于独立控制目录；不是把密码文本当作Keystore条目。Keystore密钥不可导出，硬件保护是否成立取决于设备，不能笼统保证每台设备都有StrongBox。[Android Keystore](https://developer.android.com/privacy-and-security/keystore)、[官方AES密钥生成示例](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec)

`ModelUsage/response-integrity.key` 与 `ModelUsage/response-integrity.android.key` 是两份**仅限本机的响应完整性密钥**，不同于模型或网盘登录凭据，但同样不随新备份、导出或云上传迁移。排除只针对这两个精确研究相对路径及其大小写别名，其他 `.key` 和隐藏研究文件仍按原规则保留。

旧包仍按原清单完整解码，逐项核对原字节和 SHA；在生成有效恢复目录时，不安装包内这两份密钥，而保留当前设备已有的对应密钥。原下载包与历史记录不改写。历史输入、响应、回答与费用可继续阅读；跨设备材料不因恢复自动取得本机验证、复用或付费请求权限。

旧待传、待导出快照若含这两份密钥，继续操作会停止并保留原包在本机，不在原 UUID 下删项、重编码或覆盖；用户可先保留并结束旧操作，再从当前研究空间建立符合现行规则的新快照。

本机Keystore若要求用户认证，后台不能偷偷绕过或持续弹窗；暂停并显示可在前台处理的本机许可提示。首次导入另一台设备的快照也不能自动把未知模型端点和本机已有密钥组合发送请求。

恢复按以下顺序执行：下载全部块 → 核每块与整体 SHA → 检查资料包和个人数据 → 建立暂存目录并回读 → 派生本机保护策略 → 显示所选时点和影响 → 用户确认 → 原空间移入恢复前副本 → 安装暂存目录并初始化服务。取消、其他任务活跃或校验失败时保持当前资料不变；安装或初始化失败回滚，恢复前副本保留。目录替换在同一内部文件系统完成，不依赖系统文件提供方支持原子重命名。

## 8. 模型配置、已派发请求和真实费用

[RestoreLocalPolicy.swift](<../apps/macos/Sources/RestoreLocalPolicy.swift>)的当前设备保护字段为：

```text
endpoint model protocol httpProxy responsesStream reasoningEffort
maxTokens timeoutMs dailyRequests
```

恢复目标空间的这些字段由本机当前值覆盖；当前没有的字段也不从旧包偷偷引入。原始 `personal.json` 原字节旁存到 `RestorationReceipts/<随机UUID>-original-personal.json`。原输入、来源、回答、notes与ModelUsage原文件不因此改写。字体/阅读界面等其他设置不属于这份路由保护清单；不能把扩大或缩小字段集合叫作无影响的实现差异。

`RequestBudgetContinuity.json` 合同为 `paperdigest-request-continuity-v1`，内容为 `requests:[{id,startedAt}]`。恢复将当前空间、待恢复空间两份连续性记录与两边 `requestIssued:true` 会话合并：按全局唯一请求ID去重，同ID不同原时间拒绝。每ID非空、UTF-8≤256 bytes，时间必须是真实Gregorian日期的UTC ISO8601字符串，可含1–9位小数；不归一化原时间来掩盖冲突，最多100000项。

每日准入按UTC日计算，保留当前设备的 `dailyRequests`，并把恢复得到的已派发历史纳入计数，防止恢复旧包清零。此做法是保守防回退，既不是重算账单，也不是实时全设备原子配额。两台同时离线发请求时没有统一服务器锁，不能承诺全账号始终只发某个精确总数。

Android新模型请求也必须先封存精确输入并持久化pending/requestIssued记录，后发网络；同一次发起和终态使用同一事件ID。中断/未知费用保留未知，不自动重发付费请求，不把token估算为实际费用，复用结果不再加一次真实调用。原用量事件、完整provider usage、实际模型/协议、截断及失败响应、父会话、起止时间和金额未知状态都必须保留。Mac 的请求与账本实现见 [llm-worker.cjs](<../apps/macos/llm-worker.cjs>)及其调用的共享模块；Android 使用独立 Kotlin 实现，保持同样的记录与恢复规则。

历史 `desktop-study-v3/v4` 指纹覆盖论文身份、实际 messages、model/endpoint/protocol、问题、证据、来源和输出预算；v4 另含 stream/reasoning，并绑定 `extractor=pdfkit-physical-pages-v1`。Android 使用实际提取器身份，不重新编码或重签旧输入。Mac 的 `exportEvidence` 按其支持的合同验证指纹；外端或未知合同作为历史保留，只有双方明确支持并通过原材料核验时才可导出相应证据或复用。

## 9. 笔记、标注、论文和离线来源

| 材料 | 当前结构/必须保留 | Android适配边界 |
|---|---|---|
| 文献身份 | 原 `paperID`；arXiv、完整conference ID及 `local:<PDF SHA>` | 不把会议ID强转arXiv，不因标题相同合并论文 |
| 笔记 | `notes[paperID]={text,revision,updatedAt}`；按baseRevision CAS，最大2 MiB文本 | 保留修订号和原更新时间；本机CAS不能自动解决另一设备同号并行编辑 |
| 收藏/待读 | `favorites` / `reading` 的ID列表 | 恢复保持所选时点；不要声称快照替换会自动union两台列表 |
| 阅读状态 | `readingState[paperID]`，guideScroll/pdfPage/question/scope/mode及附加字段 | 原字段保留；像素滚动值跨屏幕仅作提示，物理PDF页码不改编号 |
| PDF标注 | id/text/page/rect/pdfSHA/createdAt，可含comment/updatedAt；page为从1开始物理页 | `rect`是PDFKit页坐标的NSRect字符串；不可写Android屏幕像素，必须有cropbox/rotation/坐标转换互认测试 |
| 本地PDF | `personalPapers`内id/title/sourceKind/localPDFPath/pdfSHA等 | 私有路径通过原SHA受控重定位；找不到文件保留缺失状态，不改PDF SHA补洞 |
| 网站导读 | Article保留paperID、原html/markdown/plainText、revisionSHA256、resources、sourceVersion、citation/researchContext、notices | 渲染净化在展示副本进行；旧来源或未核版本警告不能因移动平台隐藏 |
| 离线研究包 | `Offline/<内容ID>/manifest.json`；`paperdigest-offline-package-v1/v2`、paper/article/PDF/images及各SHA | 保留packageID与原文件，重新核全部资源；没有PDF的阅读包不能冒充完整原文材料 |
| 任务 | 原id/command/status/identity/material/result及时间；最多1000条的Mac显示存储策略 | 崩溃重启把运行态按真实中断处理；不得自动重发模型/Zotero/付费或恢复操作 |
| Zotero材料 | app自己保存的journal、材料与目标绑定 | Android走Web API v3；Mac本地journal作为不透明历史保留。Android Web journal须独立核目标/权限，不将Mac本地许可变成Web API key或自动续传 |

Mac重新装载标注时只显示与当前PDF SHA一致的标注；定位回答中的 `[p.N]` 也必须属于当次已封存pages且PDF SHA/来源版本一致。不能因为Android重新分页/屏幕适配就把N解释为阅读器屏幕页。

离线包v2绑定原paper内容、article内容、网站修订、来源版本、可选PDF及科学图哈希。阅读快照是阅读材料，不是网站生产分析、出版或付费请求的来源能力。Android对PDF/OCR/图片分析的扩展也必须如实记录实际提取器、缺文字页、截断和是否包含图片；不能承诺保留网站解析就等于重新分析过PDF。

## 10. Android后台任务的必要差异

自动备份使用 WorkManager 持久调度，按本机目标去重；任务名使用本机目标标识，参数仅携带控制记录引用。密码、整份快照和研究正文不进入任务参数或通知。网络、电量和存储条件符合后才处理本机待传记录；同目标的手动、自动保存与设置更换共享操作锁。

WorkManager的周期最小间隔为15分钟，执行时间受系统约束，不能保证精确到指定时刻。项目仍可维持用户6–168小时范围及24小时默认，但文案应为“系统条件允许时执行”，不是Mac“退出后完全不运行”的承诺。用户关闭自动或认证失败后应取消/暂停对应周期工作；取消不能清除原续传材料。[WorkManager工作定义](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work)

长传输提供前台通知和取消入口，系统中止后保留原字节与 UUID 以便继续。Android 16 的 WorkManager 前台长任务也受作业配额限制，执行时间和后台存活不作固定保证；当前采用持久调度与分块恢复处理这些中断。[长任务官方说明](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running)。

## 11. 兼容范围与验证

Android 在 API 28、API 35 模拟器上验证了系统保存、重新选择、预检与取消，保存包由 Mac 解析器逐文件核验。实际 Mac 研究包也已在两代 Android 上确认恢复，原用量、会话、本机连接配置与恢复前副本保持。真实坚果云另完成分块取消、冷启动续传、全部块与清单回读，以及确认恢复。当前新导出使用本机完整性密钥排除规则。

固定合成离线包和 Foundation JSON 向量用于核对跨语言字节、路径、PNG 与 PDF。材料见 [Swift 生成器](<../apps/android/app/src/test/fixtures/GenerateOfflineFixtures.swift>)、[公开向量](<../apps/android/app/src/test/resources/offline-swift-vectors.json>)及 [Mac 反向读取器](<../apps/android/app/src/test/fixtures/VerifyAndroidOfflinePacket.swift>)，操作与预期结果见[样例规格](<android-cloud-portable-fixtures.md>)。固定历史向量保持原字节。

模型记录的文件恢复与模型证据合同验证分别处理：原合同受支持且输入、响应、来源与完整性条件全部满足时才可复用。未知或外端合同保留为历史，不改签为本机新研究。PDF 坐标按原物理页、裁切框和旋转转换，不使用屏幕像素代替。

多设备采用不可变版本与显式恢复时点，当前不自动合并并行编辑；强制停止应用后也不保证后台任务继续运行。发行记录分别写明两端实际版本、来源、最低系统、签名及文件校验值。当前 1.0.1 已完成本地安装包核验和 Android 同签名升级，公开下载状态见[验证说明](<android-validation.md>)。
