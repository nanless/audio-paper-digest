# Android 与 Mac：资料包样例和测试规格

本文提供固定合成数据，用于验证资料包的字节、路径、分块和恢复行为。输入由公开文本、固定字节模式和合成 UUID 组成。测试矩阵列出操作与预期结果，实际通过范围见[验证说明](<android-validation.md>)，完整字段与限制见[备份合同](<android-cloud-contract.md>)。

P01/P02 的原代码块、字节配方与 SHA 保持固定。新备份排除两份本机响应完整性密钥，旧包仍完整解码并保留原件；密钥不安装到有效恢复目录，当前设备密钥保留。其余普通研究文件及隐藏文件按合同保留。

## 固定字节向量 P01

以下一行JSON代码块的内容按UTF-8取字节，**不包含代码块首尾换行**。其中personal.json原字节为下列紧凑JSON；Opaque/binary.bin恰为从0到255各一个字节。该文件只用于测试任意二进制原样保留，不能称作有效PDF。

```json
{"annotations":{},"favorites":["fixture:paper-1"],"jobs":[],"notes":{"fixture:paper-1":{"revision":2,"text":"Synthetic fixture only.\n","updatedAt":"2026-01-01T00:00:00Z"}},"reading":[],"readingState":{},"schema":1,"sessions":[],"settings":{"appearance":"system","font":18,"syncHours":12}}
```

个人文件SHA-256：`a5c9764c6c0e6d26a0ea1f4ba173fc63b62fac79217ac6f53a6c8eba8cb71e7f`。

```json
{"contract":"paperdigest-backup-v2","files":[{"data":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/w==","path":"Opaque/binary.bin","sha256":"40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880"},{"data":"eyJhbm5vdGF0aW9ucyI6e30sImZhdm9yaXRlcyI6WyJmaXh0dXJlOnBhcGVyLTEiXSwiam9icyI6W10sIm5vdGVzIjp7ImZpeHR1cmU6cGFwZXItMSI6eyJyZXZpc2lvbiI6MiwidGV4dCI6IlN5bnRoZXRpYyBmaXh0dXJlIG9ubHkuXG4iLCJ1cGRhdGVkQXQiOiIyMDI2LTAxLTAxVDAwOjAwOjAwWiJ9fSwicmVhZGluZyI6W10sInJlYWRpbmdTdGF0ZSI6e30sInNjaGVtYSI6MSwic2Vzc2lvbnMiOltdLCJzZXR0aW5ncyI6eyJhcHBlYXJhbmNlIjoic3lzdGVtIiwiZm9udCI6MTgsInN5bmNIb3VycyI6MTJ9fQ==","path":"personal.json","sha256":"a5c9764c6c0e6d26a0ea1f4ba173fc63b62fac79217ac6f53a6c8eba8cb71e7f"}],"sourceDirectory":"/portable-fixture/PaperDigest"}
```

P01编码总长：`1054 bytes`；完整SHA-256：`950f67a2b59f41c8d664ac33a799081729f1f4f439258b9212549420cb782d62`。对应远端manifest语义如下；比较manifest解析字段和绑定关系，勿把另一份排版的manifest JSON SHA当本向量包SHA。

```json
{
  "contract": "paperdigest-cloud-snapshot-v1",
  "reference": {
    "month": "2026-01",
    "id": "00000000-0000-4000-8000-000000000001"
  },
  "createdAt": 1767225600000,
  "encodedBytes": 1054,
  "sha256": "950f67a2b59f41c8d664ac33a799081729f1f4f439258b9212549420cb782d62",
  "chunks": [
    {
      "index": 0,
      "bytes": 1054,
      "sha256": "950f67a2b59f41c8d664ac33a799081729f1f4f439258b9212549420cb782d62"
    }
  ]
}
```

## 真实跨8 MiB边界的向量 P02

P02保留P01的personal.json与sourceDirectory，把Opaque/binary.bin改为6291456字节：第i字节为`i % 251`，从i=0开始。它的Base64和包编码按下方明确配方生成，不把大文件提交Git。这里约定的排序/紧凑JSON只为生成固定样例，并不宣称它是Foundation历史指纹的通用canonical JSON算法。

```python
import base64, hashlib, json
encode = lambda obj: json.dumps(obj, ensure_ascii=False, sort_keys=True,
                                separators=(",", ":")).encode("utf-8")
# personal 是P01第一段紧凑JSON的原字节，不加换行。
binary = bytes(i % 251 for i in range(6 * 1024 * 1024))
entry = lambda path, data: {"path": path,
    "sha256": hashlib.sha256(data).hexdigest(),
    "data": base64.b64encode(data).decode("ascii")}
encoded = encode({"contract": "paperdigest-backup-v2",
    "sourceDirectory": "/portable-fixture/PaperDigest",
    "files": [entry("Opaque/binary.bin", binary), entry("personal.json", personal)]})
```

P02编码总长：`8389318 bytes`；完整SHA-256：`c085074731741f5a62b02949e4ae30ce7c355668b63ce6c827b230db2c366455`。块数组必须恰为：

```json
[
  {
    "index": 0,
    "bytes": 8388608,
    "sha256": "77a3035e5154e2bb1d810bf13ca13e11913bfe7674309e1a0c42afb2c1098140"
  },
  {
    "index": 1,
    "bytes": 710,
    "sha256": "f98accd18c78fa1c47c197ed9ec85bfdadd1b68fd21998e4cf19156b66d1f5e0"
  }
]
```

## 测试矩阵

各端按以下操作核对结果，保留实现版本、样例 SHA、运行环境和实际输出。编号用于定位测试条件，具体执行范围见[功能表](<android-feature-parity.md>)。

| ID | 修改/操作 | 必须观察到的结果 |
|---|---|---|
| B01 | P01逐文件导入→导出→再次导入 | 解码文件的路径/字节/SHA不变；新导出JSON排版可不同，不伪称续传原编码 |
| B02 | P02传输及下载 | 正好两个块，第一块8388608字节；块SHA及总SHA匹配，原文件字节全保留 |
| B03 | 改一个 Base64 解码字节，保持旧文件 SHA | 暂存或安装前拒绝，当前研究目录不变 |
| B04 | 文件路径../x、/x、a//b、a/./b、a\b、控制字符、尾斜杠 | 全部拒绝；不在目标树外创建文件 |
| B05 | personal.json重复、A/x与a/y、NFC/NFD同名、文件a与a/b共存 | 名称/目录片段/父文件冲突拒绝，不由平台文件系统决定 |
| B06 | 缺personal.json、非对象、坏schema1、坏note revision | 恢复拒绝，原文件保留；不能仅用JSON可解析判断通过 |
| B07 | 原始总量512MiB+1、编码750MiB+1、100001条 | 各自整体拒绝，不生成部分成功快照；以有界流/虚拟输入测试，不提交大文件 |
| B08 | 符号链接、父目录链接、特殊文件 | 采集与恢复都拒绝；隐藏普通文件仍完整进入快照 |
| B09 | RestoredPathRoots的大小写别名、重复或互相包含根 | 拒绝歧义；有效旧绝对路径只有绑定实际SHA才可重定位 |
| C01 | PUT块成功但客户端丢回复，取消后重启 | 恢复同UUID/同编码；先GET核已有块，不覆盖、不重采集后续笔记 |
| C02 | 在块GET回读中损坏1 byte | 停止，manifest不作为完整成功；本机pending仍在 |
| C03 | manifest PUT 丢失回复 | 继续原版本，GET 清单及全部块，不为同一次恢复另建 UUID |
| C04 | checkpoint原子写失败 | 停止新网络派发，不以内存回执报成功 |
| C05 | 修改待传快照/账号/目录/目标ID | 绑定校验拒绝；保留旧材料后才能创建新目标 |
| C06 | manifest 错月份、错 UUID、非整秒毫秒、少/多/乱序/重复块、错总长 | 整体拒绝，不替换当前研究目录 |
| C07 | HTTP401/403/429/503及Retry-After日期/秒数 | 正确分类；401不重试；限流停止派发且上传重启仍等待 |
| C08 | 本机凭据异常含诱饵文本、缺密码、取消读密码 | 固定安全本机提示或取消；0HTTP；不泄露诱饵、不误当401 |
| C09 | 固定HTTPS以外的地址、任意重定向、超限响应 | 凭据不转发，响应流及时停止，TLS不放宽 |
| C10 | DAV达到750项、DTD/entity、错误namespace/propstat、重复/越级href | 报不完整，不返回前缀或“没有备份”；坏propstat不拼接成成功collection |
| C11 | 月目录中部分UUID无manifest，另一些有效；中途GET失败/达到请求预算 | 无manifest不列成功；中途异常使整体列表报错 |
| R01 | Mac→Android→Mac与反向全空间恢复 | 原文件/费用/来源/未知字段完整保留，本机cloud目标/凭据不被快照替换 |
| R02 | 恢复前本机route-A，包里route-B，本机已有API key | 当前有效配置仍route-A；原personal字节旁存，恢复本身不发模型请求 |
| R03 | 本机已派发请求X，旧包只有Y；同ID不同UTC时间 | 正常合并X/Y不清零；冲突整体拒绝，不重写原时间或用量 |
| R04 | 下载结束后用户取消、安装第二次重命名失败或服务初始化失败 | 当前研究目录或回滚副本完整，终态为取消或失败；下载完成后仍须完成确认与安装 |
| R05 | 原pending/坏checkpoint/孤立snapshot，保留退出 | 全部原字节旁存；旧connection不覆盖，云端不删，损坏材料不保证可恢复 |
| M01 | 旧桌面与 Android 研究记录、两份本机响应完整性密钥的导出和恢复 | 新导出排除两个精确本机密钥路径及大小写别名；其他隐藏文件保留。旧包完整解码、原输入/响应/费用与原包不改；有效恢复目录保留当前设备密钥，不安装包内密钥。缺少本机证明的历史只读保留，不重新签署或自动复用 |
| M02 | 中文/emoji/组合字符/斜杠/小数配置参与旧指纹 | 原输入不重编码重签；Foundation.sortedKeys不等同JCS，旧指纹验真需明确互认实现 |
| M03 | Android实际提取器的新研究 | 不伪装PDFKit；新合同在Mac证据导出互认前明确待验，不偷偷复用旧desktop-study指纹 |
| N01 | 两设备同一笔记revision并行编辑 | 各自快照不丢；显式选择恢复时点/冲突，不用时间戳静默覆盖 |
| N02 | PDF旋转0/90/180/270、非零CropBox，摘录跨两页 | PDF SHA与从1开始物理页一致；PDFKit NSRect和Android页坐标转换往返定位准确 |
| A01 | Worker进程被杀/网络取消/系统停止/重启 | 同字节同UUID续传；后台状态真实，不能自动重发付费模型请求 |
| A02 | 开关自动、401后暂停、显式修正恢复、已存在手动上传 | 唯一计划与互斥锁有效，不并发采集或自动重试凭据失败 |
| A03 | Android系统备份/设备迁移及Keystore失效 | 不倒灌云目标/设备ID/密文凭据/待传包；凭据需本机修正，研究原件不丢 |

## 结果怎样记录

后续自动化结果至少包含：实现/测试源提交，向量ID及SHA，操作方向，操作前后文件数与原字节核验，当前有效模型路由和请求连续性是否保留，取消/失败/成功终态，所用设备/Android API和签名包身份。真实网盘报告另记实际服务回读，禁止写账号、密码、稳定凭据指纹、研究正文或私有文件摘要到公开验收材料。

样例生成检查核对固定字节与校验值；平台恢复、系统文件操作和真实网盘分别记录运行结果。

## 可复现的旧 Mac 离线包向量

[offline-swift-vectors.json](<../apps/android/app/src/test/resources/offline-swift-vectors.json>)由[公开 Swift 生成器](<../apps/android/app/src/test/fixtures/GenerateOfflineFixtures.swift>)在全新临时目录调用现有 `DesktopStorage.register/verifyPackage/openPackage` 生成，未改 Mac 产品源码，也不读取用户缓存。它包含 v1、v2、缺 MathML 合同的旧 HTML，以及一张真实生成 PNG 加一页合法 PDF 的 v2，共4包；另有2份真正 Foundation JSON 字节向量，覆盖中文、emoji、斜杠、键排序和二进制小数。它们都是合成文献，不能当作 MiCLA 或其他真实论文验收。

在仓库根目录以当前 Mac 构建所用 Swift 默认语言模式编译生成器，输入只需上述脚本、`apps/macos/Sources/BackupCodec.swift`、`DesktopStore.swift`、`DesktopStorage.swift`，链接 PDFKit/Security。运行时传仓库绝对路径和输出 JSON 路径。输出 JSON 含实际3份 Mac 源 SHA、每个原文件的 Base64/SHA，以及 Foundation 期望字节；PDF/PNG字节由本次生成，重新生成的日期和 PDF 元数据可能不同，不能据此重写既有包身份。

Android 的 `OfflineStoreTest` 与 `OfflineStoreDeviceTest` 共享这同一公开资源。设备测试先读取并逐字节保护原包，再从实际匹配缓存正常新注册；断言新包不是复用任何 Mac 原包，输出的合成 packet 可交[原 Mac 反向读取器](<../apps/android/app/src/test/fixtures/VerifyAndroidOfflinePacket.swift>)。该读取器同样只与上述原3份 Mac 源编译，在私有临时目录核 Base64、SHA、路径白名单，执行原 verify/open，含图/PDF时另核真实页数和图 SHA，最后确认全部原文件没有被读取过程改写。它不安装应用、不调用网络或凭据。

API 28、API 35 已读取上述四份 Mac 合成包及两份 Foundation 向量，并正常新注册 Android 离线包。Android 生成包经 Mac 原读取器执行 verify/open，含图和 PDF 的包保留五个文件 SHA、实际一页 PDF 与图片身份。真实研究空间恢复、模型记录和网盘操作的验证范围另见[验证说明](<android-validation.md>)。
