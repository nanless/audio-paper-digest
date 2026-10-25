# Android 与 Mac 的研究资料、备份和坚果云合同

本文规定 Android 与 Mac 必须兼容的数据边界。2026-10-25 依据 Mac 功能源提交 `ac7f8099be23e82d0e17cf23172bdf3f7af63e07` 核对；后续说明文档提交不改变该基线。Android 已有对应实现和隔离测试，实际互通、账户及发行状态以[验收记录](android-validation.md)为准，不能仅凭本合同授予通过。Zotero 已选用 Android 完整 Web API v3 方案；现有 Mac 本地归档材料仍须完整保留，不能自动执行 Mac 的旧授权。

操作范围与现有验收见 [Mac 坚果云说明](mac-app-cloud.md)、[原69项](mac-app-acceptance.md)和[发行机制](mac-app-release.md)。完全合成、可提交的字节向量与正反例见[兼容性向量](android-cloud-portable-fixtures.md)。这些材料只说明各自覆盖的合同与测试范围，不证明真实网盘已完成首存、续传或恢复。

## 1. 共用什么，哪些由设备自己管理

两端共用数据合同和同一组兼容性向量；平台的存储、密码保护、后台任务和 PDF 提取器分别实现。不能把 Swift/Node 运行组件原样复制后称为 Android 已完成，也不能只因可读 JSON 就认为恢复和科学来源核验已经互通。

| 层 | 现有权威合同/入口 | Android 必须做到 | 不得借此获得的资格 |
|---|---|---|---|
| 整个研究空间 | `BackupCodec`，`paperdigest-backup-v2` | 读写全部原始文件、逐文件 SHA、整体上限、路径冲突检查 | JSON 校验不授予论文来源真实性、模型付费或远端授权 |
| 云端完成版本 | `CloudArchiveService`，`paperdigest-cloud-snapshot-v1` | 同一路径、UTC月份、分块索引/大小/哈希、完成清单和逐块回读 | 存在目录或 PUT 成功不等于完整备份 |
| 研究数据 | `personal.json` schema 1、离线包 v1/v2、原始 ModelUsage | 保持原 ID、版本、原文/图/输入/回答/费用字节；未知字段保留 | 恢复不能重签旧模型输入、给旧缓存升级“最新”状态 |
| 恢复政策 | `RestoreLocalPolicy`、请求连续性 v1、`applyRestorePayload` | 保本机路由与预算、原资料旁存、暂存/确认/回滚 | 下载完成不等于恢复完成；不自动合并两台设备的笔记 |
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
    …全部其他实际普通文件，包括隐藏文件
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

Android 系统 Auto Backup 不是本项目的坚果云快照；官方为它设置独立容量与排除规则。建议研究、凭据、云账号/设备ID/待传材料均置于 `noBackupFilesDir`，同时为适用系统提供明确的 backup/data-extraction 排除规则；不能仅设置 `allowBackup=false` 就宣称所有厂商设备间迁移均关闭。设备更换后重新设置本机凭据和云目标，再显式导入研究快照。[Android Auto Backup](https://developer.android.com/identity/data/autobackup)

用户从系统文件选择器提供的 `content://` PDF，先有界复制成内部研究目录下的普通文件，验证实际 PDF 与 SHA，再分配 `local:<原PDF SHA>`。不把 URI 假写成绝对文件路径；不在恢复时凭旧设备路径访问外部文件。备份导入/导出用 `ACTION_OPEN_DOCUMENT` / `ACTION_CREATE_DOCUMENT`，将得到的流复制到内部暂存后完整校验，取消选择不创建成功任务。[Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files)

## 3. `paperdigest-backup-v2` 的字节合同

现有实现为 [BackupCodec.swift](../apps/macos/Sources/BackupCodec.swift)，不是 ZIP，也没有额外压缩或端到端加密。

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
5. 全部校验通过后才创建新的 stage；文件按私有权限写入，再逐文件回读。拒绝符号链接、特殊文件及经过链接的父目录。

原 SHA 基于文件原字节，不能因为 Kotlin 重新排 JSON 键、转义斜杠、归一 Unicode、重排数组或更改换行而重算旧文件 SHA 后冒充同一材料。保留未知文件和字段；对不能理解的未来合同明确拒绝执行恢复，原包可保留。

`RestoredPathRoots.json` 会在 stage 中派生更新；旧 `personal.json` 会由恢复政策派生为当前有效配置。派生副本与下载原包分开记录，不能把派生空间的哈希叫作原下载哈希。旧绝对路径重定位时必须有对应文件原 SHA；映射文件自身不提供来源、模型或授权能力。

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

Mac的600次计数属于同目标服务实例的运行期预算，不是账号的全设备分布式总计。Android独立计数也不能保证两台机器合计不超600；真实服务的429/503必须服从，不宣称已有跨设备额度锁。Android建议把本机请求窗口与冷却落盘防进程重启突发，仍不得修改旧Mac的网盘合同或用账号/凭据哈希作为分布式身份。

两端拒绝任意重定向，包括同域重定向；TLS正常验证，不接受自签异常或关闭主机核验。Basic认证只发固定HTTPS来源，无cookie/全局凭据缓存；HTTP正文、底层异常、账号和密码不写可分享日志。Android可用声明式Network Security Configuration保持明文关闭，但仍需在HTTP客户端禁止自动重定向，限制响应流大小与超时；XML解析另关闭实体。[Android网络安全配置](https://developer.android.com/privacy-and-security/security-config)

## 7. 跨设备恢复不搬运本机授权

模型API key、网盘应用密码、Zotero许可、Android Keystore私钥及Mac系统Keychain条目不在研究目录，不随快照迁移。Android的模型与云密码分别由本机Keystore生成的加密密钥包装，密文、随机nonce及目标引用置于独立控制目录；不是把密码文本当作Keystore条目。Keystore密钥不可导出，硬件保护是否成立取决于设备，不能笼统保证每台设备都有StrongBox。[Android Keystore](https://developer.android.com/privacy-and-security/keystore)、[官方AES密钥生成示例](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec)

有一个必须保留的区别：研究目录内的 `ModelUsage/response-integrity.key` 是32字节**响应恢复HMAC完整性材料**，不是API/网盘登录凭据。现有完整备份包含它，用于验证原恢复信封；不能按`.key`后缀盲删导致已付响应恢复失效，也不能把它导入Android系统Keystore后删除原文件、破坏Mac回迁。它应按研究敏感材料处理，不输出/写日志；Android新实现另用 `ModelUsage/response-integrity.android.key` 封存 `android-model-response-v1` 信封，与旧Mac文件并存不覆盖。新设备自己的凭据保护密钥仍独立。

本机Keystore若要求用户认证，后台不能偷偷绕过或持续弹窗；暂停并显示可在前台处理的本机许可提示。首次导入另一台设备的快照也不能自动把未知模型端点和本机已有密钥组合发送请求。

恢复必须完成：下载全部块→核每块/整体SHA→完整BackupCodec/个人资料检查→建立stage并回读→派生本机保护策略→显示所选时点和影响→用户确认→原空间移入恢复前副本→安装stage并初始化全部服务。取消、其他任务活跃或校验失败保持live不变；后续安装/初始化失败回滚，前副本不主动清除。Android跨目录事务必须在同一内部文件系统实现可验证替换，不依赖SAF云provider具备原子rename。

## 8. 模型配置、已派发请求和真实费用

[RestoreLocalPolicy.swift](../apps/macos/Sources/RestoreLocalPolicy.swift)的当前设备保护字段为：

```text
endpoint model protocol httpProxy responsesStream reasoningEffort
maxTokens timeoutMs dailyRequests
```

恢复目标空间的这些字段由本机当前值覆盖；当前没有的字段也不从旧包偷偷引入。原始 `personal.json` 原字节旁存到 `RestorationReceipts/<随机UUID>-original-personal.json`。原输入、来源、回答、notes与ModelUsage原文件不因此改写。字体/阅读界面等其他设置不属于这份路由保护清单；不能把扩大或缩小字段集合叫作无影响的实现差异。

`RequestBudgetContinuity.json` 合同为 `paperdigest-request-continuity-v1`，内容为 `requests:[{id,startedAt}]`。恢复将当前空间、待恢复空间两份连续性记录与两边 `requestIssued:true` 会话合并：按全局唯一请求ID去重，同ID不同原时间拒绝。每ID非空、UTF-8≤256 bytes，时间必须是真实Gregorian日期的UTC ISO8601字符串，可含1–9位小数；不归一化原时间来掩盖冲突，最多100000项。

每日准入按UTC日计算，保留当前设备的 `dailyRequests`，并把恢复得到的已派发历史纳入计数，防止恢复旧包清零。此做法是保守防回退，既不是重算账单，也不是实时全设备原子配额。两台同时离线发请求时没有统一服务器锁，不能承诺全账号始终只发某个精确总数。

Android新模型请求也必须先封存精确输入并持久化pending/requestIssued记录，后发网络；同一次发起和终态使用同一事件ID。中断/未知费用保留未知，不自动重发付费请求，不把token估算为实际费用，复用结果不再加一次真实调用。原用量事件、完整provider usage、实际模型/协议、截断及失败响应、父会话、起止时间和金额未知状态都必须保留。生产共享请求与账本实现见 [llm-worker.cjs](../apps/macos/llm-worker.cjs)及其调用的仓库共享模块。

历史 `desktop-study-v3/v4` 指纹覆盖纸面身份、实际messages、model/endpoint/protocol、问题/证据/来源和输出预算；v4另含stream/reasoning，且写死 `extractor=pdfkit-physical-pages-v1`。Android不能伪装成PDFKit来命中复用，也不能重编码旧输入再重签SHA。Android新提取器/协议须有新的明确合同及可移植规范向量；旧Mac目前的 `exportEvidence` 只验证原v3/v4指纹，对新Android提取器不会自动认可。**文件可恢复与新研究会话在两端可导出证据是两道验收门**，后续需要显式扩展双方读取器。

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

自动备份使用持久任务调度器并按本机目标去重，推荐WorkManager唯一任务名仅包含随机本机ID，输入仅携带控制记录引用；不要把密码、整份快照或研究正文放进任务参数/通知。网络、低电量、存储余量等约束符合后才读本机pending；同目标手动/自动与设置更换共享一把锁。

WorkManager的周期最小间隔为15分钟，执行时间受系统约束，不能保证精确到指定时刻。项目仍可维持用户6–168小时范围及24小时默认，但文案应为“系统条件允许时执行”，不是Mac“退出后完全不运行”的承诺。用户关闭自动或认证失败后应取消/暂停对应周期工作；取消不能清除原续传材料。[WorkManager工作定义](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work)

长传输不能依赖无限后台存活。Android16上，WorkManager前台长任务仍可能耗尽job quota；手动发起的大传输可评估Android14起的user-initiated data transfer job，需可见通知和真实取消入口。选择该路径不授予自动定时任务同等待遇。分块应支持系统中止后恢复原字节/原UUID；实现者须按最终minSdk/targetSdk和通知/前台服务要求实测，而不是复制一项API后宣称所有版本均可用。[长任务官方说明](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running)、[用户发起的数据传输](https://developer.android.com/develop/background-work/background-tasks/uidt)

## 11. 兼容发布的验收门

共用Release可以包含Mac和Android资产，但每端独立记录版本、构建、源提交、架构/系统范围、签名、公证或未公证状态及SHA。既有Mac包审计与原69/新增17不能为Android签发通过。2026-10-25 的开发APK已在API28/API35模拟器实际执行测试；这不等于发行签名、公开发布、实体设备、真实云端成功或完整研究空间双向恢复通过。

已实际覆盖的跨端子集是：compile9 的原3份公开合成离线包及2份Foundation JSON向量由两API读取，两API新注册无PDF/无图片v2包又通过未改Mac的正常verify/open。compile10 进一步在两API读取第4份含PNG/一页PDF的原Mac合成包、新注册非复用包，再由原Mac核全部5文件SHA、PDFKit实际1页与图SHA，均通过。没有把这些子集扩大为真实论文、全部研究空间恢复或所有设备通过。复现材料见 [Swift生成器](../apps/android/app/src/test/fixtures/GenerateOfflineFixtures.swift)、[公开向量](../apps/android/app/src/test/resources/offline-swift-vectors.json)及[原Mac反向读取器](../apps/android/app/src/test/fixtures/VerifyAndroidOfflinePacket.swift)。

必须先完成portable spec的所有适用案例，再做同一份合成研究空间的Mac→Android→Mac和Android→Mac→Android互通：逐项核原字节/路径/SHA、标注几何、原模型证据/费用可读及不可伪复用、本机配置/凭据/预算保留、恢复取消/失败原子保旧。真实云账号采用两端独立应用密码，验证服务响应、断点及实际GET；不将隔离HTTP模拟或可下载APK等同真实验收。

当前明确未闭的设计门：新Android提取器与旧Mac证据读取互认、PDF坐标互转、Android自身应用数据向Mac兼容写出、跨设备并行编辑冲突处理、后台被系统停止后的真实续传。快照v1提供不可变版本和显式恢复，没有自动双向合并；若产品需要同时自动同步两端当前空间，须另立操作日志/冲突协议，不能默默覆盖旧合同。
