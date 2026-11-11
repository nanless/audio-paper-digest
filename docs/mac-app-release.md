# 论文速递工作台 Mac 版：构建与发行

本页说明当前版本 1.4.4（构建号 20）的本地准备和联合发行操作。1.4.4 的改动与验证范围见 [1.4.4 记录](workbench-1.4.4-review.md)，该版已于 2026-11-05 公开发布，下载与实际状态见 [GitHub 发行页](https://github.com/nanless/audio-paper-digest/releases/tag/v1.4.4)，签名、附件和匿名下载的核对结果见[客户端发行核验](client-release-verification.md)。上一版 1.4.3 的发行记录保留在[1.4.3 记录](workbench-1.4.3-review.md#发行状态)。

| 项目 | 当前发行目标 |
|---|---|
| 应用 | 论文速递工作台.app |
| 版本、构建号 | 1.4.4、20 |
| 架构、最低系统 | arm64、macOS 15 |
| 运行时 | 随包 Node 24.19.0 |
| 签名 | 本地 ad-hoc 签名，未 Apple 公证 |
| 资源通道 | release，不捆绑论文样稿 |

本页面向准备发行包的维护者。普通使用者从发行页下载安装，不需要执行以下构建命令。这里的本地签名用于检查应用包在打包后是否被改变，不等于获得 Apple 开发者身份认证或完成公证；其他 Mac 的安装和系统安全提示仍须按实际情况判断。

## 1. 构建与安装

开发环境、官方 Node 运行时准备及 `PD_MAC_NODE_RUNTIME` 用法见[Mac 构建说明](../apps/macos/README.md#从源码构建)。默认 Node 若不是许可固定的 24.19.0，须显式指定正确运行时；不修改许可版本来容纳其他二进制。

先完成代码和文档、正常测试与独立审查，提交后再构建。保存该次构建输出的 `signed-build.json` 路径，以下用变量 `BUILD_RECORD` 表示。选择与应用实际对应的记录，不按文件时间猜测。

```sh
npm --prefix apps/macos run build
# 保存并正常退出旧应用后，按需执行安装：
npm --prefix apps/macos run install:app
```

构建输出为 `apps/macos/.build/论文速递工作台.app`；安装脚本写入 `~/Applications/论文速递工作台.app`。脚本检测到 `PaperDigest` 仍运行时拒绝替换，不强制退出。旧名称的应用包不自动删除，资料目录、应用标识与钥匙串服务保持兼容。

正式包使用 `release` 通道。`private-qa` 含科学样稿，仅用于本机测试，不能生成正式发行计划。新构建使用新的未签名暂存目录，不从旧签名包删除资源。

## 2. 核对并准备 ZIP、DMG

三个动作依次解决不同问题：`inspect` 核对应用和构建记录；`prepare` 在新的输出目录生成安装资产；`verify` 解包或挂载这些资产，检查得到的文件是否仍是原应用。它们都不能代替实际启动、升级和阅读操作。

```sh
apps/macos/release.sh inspect \
  --app 'apps/macos/.build/论文速递工作台.app' \
  --build-record "$BUILD_RECORD" \
  --version 1.4.4

apps/macos/release.sh prepare \
  --app 'apps/macos/.build/论文速递工作台.app' \
  --build-record "$BUILD_RECORD" \
  --version 1.4.4 \
  --output 'apps/macos/.build/releases/1.4.4-arm64' \
  --dmg

apps/macos/release.sh verify \
  --prepared 'apps/macos/.build/releases/1.4.4-arm64'
```

`inspect` 只读核对干净工作区、来源、实际输入、版本、签名、架构与最低系统。输出目录必须尚不存在，失败不覆盖原产物。`--dmg` 可省略；要求生成 DMG 时，失败不会自动改交 ZIP。

`inspect`、`prepare` 和 `verify` 的输出都带 `publicationEligible: false`。这是本地候选包的默认标记，表示这些命令只证明包体和来源，不表示已经公开；它不是失败，也不能手工改成 `true` 当作发布结论。是否公开以 Release 页面和实际公开操作为准。

| 输出 | 核对内容 |
|---|---|
| `PaperDigest-macOS-1.4.4-arm64.zip` | 保留应用结构、资源 fork 与签名；实际解包比对文件、模式、属性及签名 |
| 同名 DMG | 应用与指向 `/Applications` 的拖入目标；检查映像并只读挂载回读 |
| `build-info.json` | 版本、架构、时间、来源身份和相对文件摘要，无本机构建路径 |
| `RELEASE_NOTES.md` | 按真实范围生成的版本、安装、签名与支持说明 |
| `release-manifest.json`、`SHA256SUMS` | 完整附件集合与实际字节摘要 |

打包和回读不启动应用。本版没有重新执行安装、图形首启、升级和业务操作；最近一次完整人工范围属于 1.3.0，见[本轮记录](workbench-1.3.0-review.md#正式发行与升级检查)及[验证说明](mac-app-validation.md)，不能由构建成功推定界面验收通过。

## 3. 来源、许可与隐私

包内版本必须与发行版本相同。运行输入、原生源码、资源和实际包文件逐项核对；构建后的运行源码变化要求重新构建。工具仅允许明确的已提交 `docs/*.md`、独立 Android 树及两个指定发行验证文件作为非运行变更。其他说明文件也须遵守现有来源检查；例如两份 Mac README 修改后需正常重建，不因文字不执行就绕过检查。所有文档修改先提交，脏工作区不能准备发行。

正式包拒绝额外文件、链接、路径越界、私人扩展属性、生产配置、凭据、个人资料和运行记录。样稿只在显式私有测试通道按固定路径及 SHA 接受。Node 实际版本与离线许可匹配，许可全文和归属保留原样。KaTeX 从本机 npm 缓存按锁定版本、官方归档位置及 SHA-512 核验；需要时用 `PD_RELEASE_NPM_CACHE` 指定缓存，不联网补包或执行 npm 脚本。

准备工具不读取生产 `.env`、用户钥匙串或私人文库，不调用模型。附件校验值证明下载字节，Apple 签名、公证及实际功能另有各自验证范围。

## 4. Android 安装包的准备、签名与验证

Android 正式包按 `prepare → sign → verify` 单独处理，不修改已签名 APK：

```sh
python3 apps/android/release_tools.py --repo "$PWD" prepare \
  --output "$ANDROID_PREPARED" --version 1.4.4 --code 20

python3 apps/android/release_tools.py --repo "$PWD" sign \
  --prepared "$ANDROID_PREPARED" --output "$ANDROID_SIGNED" \
  --keystore "$ANDROID_KEYSTORE" --alias "$ANDROID_ALIAS" \
  --certificate "$ANDROID_CERTIFICATE_SHA256"

python3 apps/android/release_tools.py --repo "$PWD" verify \
  --prepared "$ANDROID_SIGNED" --certificate "$ANDROID_CERTIFICATE_SHA256"
```

签名入口要求本机终端交互，运行时提示输入签名库密码和密钥密码。1.4.4 的口令取自本机登录钥匙串的 `com.nanless.PaperDigest.android-release-signing.v1` 条目；该条目只保存口令，不保存签名库、私钥或证书。1.4.4 重新生成的签名库在仓库外以 `0600` 权限单独保存，父目录为 `0700`。不要把口令、签名库或私钥写入仓库、Release 或终端历史。

1.4.4 的证书 SHA-256 为 `6a0c3138f9a49b01f868a123490a7e562f6d78d951160afb2ea5b1e44274e5bb`，公开的 `android-build-info.json` 记录了这一值。1.4.3 的证书是 `d7c680d9225c5b90ba960bf6c890f84d702c7bcc9a166951b56d01af08c40e00`，两版不同，已安装 1.4.3 的用户不能覆盖升级到 1.4.4：先导出完整备份、卸载旧版，再安装 1.4.4、恢复资料并重新配置设备凭据。1.4.4 的公开 `android-build-info.json` 记录 `signingOrigin: apksigner-sign`、`buildTools 36.0.0`，签名工具指纹与实际发行包一致；本页只登记这些可复核的来源，签名方案与证书主题以发行机器上 `apksigner verify --print-certs` 的输出为准。Android 来源、版本、四种 ABI、16 KiB 对齐、许可与包体核验必须与 Mac 使用同一发行提交。

## 5. 私有草稿、下载核验与公开

这里的“计划”只是根据固定输入生成后续发行参数。生成计划不会自动上传或公开。整个过程先固定来源和安装包，再建立私有草稿、下载核验，最后针对同一个草稿 ID 生成公开参数；中途改包就必须重新核对来源与字节。

联合发行使用同一干净提交准备 Mac 与正式签名 Android 包，两端版本一致，Android 来源等于选定发行提交。1.4.4 的来源提交为 `aecf5c25`，公开的 `build-info.json` 与附注标签 `v1.4.4` 都指向该提交；1.4.3 的来源提交为 `47c30d98`。先整理版本说明，再正常生成并固定附件、清单与校验文件；之后不手工修改已固定的文件。

1.4.3 的公开记录由该轮自动测试、包体校验和未变化功能的原通过记录组成；该轮没有重新执行 69 项人工图形验收，不能把沿用记录写成重新完成。1.4.4 同样没有重新执行 69 项人工图形验收，其附件与签名核验见[客户端发行核验](client-release-verification.md)。[原69项功能检查](mac-app-acceptance.md)和[新增17项](mac-app-cloud.md)保留全部原 ID，状态唯一。创建私有草稿前须有 84 项通过记录；仅依赖真实草稿的 `REL-03`、`REL-04` 可为待验。公开前须有全部 86 项通过记录，失败、受阻或不适用不能替代通过。

先明确建立并核对远端版本标签。单端 `private-draft-plan` 只生成草稿参数；两端联合使用 Android 工具，以下路径变量代表已正常生成的对应产物和实际验收快照：

```sh
python3 apps/android/release_tools.py --repo "$PWD" joint-private-draft-plan \
  --prepared "$ANDROID_PREPARED" --certificate "$ANDROID_CERTIFICATE_SHA256" \
  --mac "$MAC_PREPARED" \
  --android-acceptance "$ANDROID_ACCEPTANCE" \
  --mac-acceptance "$MAC_ACCEPTANCE" --mac-cloud "$MAC_CLOUD_ACCEPTANCE"
```

工具只读查询固定仓库 `nanless/audio-paper-digest` 的标签，核对真实提交，生成带 `--draft`、`--verify-tag` 的参数。维护者复核后执行草稿命令，保留实际 Release ID；旧 `publish-plan`、`joint-plan` 同样只生成草稿计划，不能直接公开。

核对真实草稿、说明与全部上传附件后，完成 `REL-03`、`REL-04`（Android 侧为 `A-REL-03`、`A-REL-04`），用同一固定输入生成公开参数：

```sh
python3 apps/android/release_tools.py --repo "$PWD" joint-public-plan \
  --prepared "$ANDROID_PREPARED" --certificate "$ANDROID_CERTIFICATE_SHA256" \
  --mac "$MAC_PREPARED" --draft-id "$RELEASE_ID" \
  --android-acceptance "$ANDROID_ACCEPTANCE" \
  --mac-acceptance "$MAC_ACCEPTANCE" --mac-cloud "$MAC_CLOUD_ACCEPTANCE"
```

公开计划重新核对包和来源，查询指定草稿 ID，按固定资产 ID 下载全部文件并比较真实字节，之后再次核对标签与草稿未变化。检查通过只生成针对同一 ID 的公开参数，不创建、上传或自动公开。维护者最终复核后执行，并核对公开状态、标签和附件。

1.4.4 使用附注标签，标签对象指向提交 `aecf5c25`；其十二件附件的名称、字节与 SHA-256 见[客户端发行核验](client-release-verification.md)。1.4.3 于 2026-11-05 公开后，Release 页面与十二件附件在未登录状态下均返回 HTTP 200；Mac 按 `SHA256SUMS`、Android 按 `ANDROID-SHA256SUMS` 复核，远端大小与本地产物一致。1.4.3 的实际附件如下：

| 平台 | 附件 | 字节 | SHA-256 |
|---|---|---:|---|
| Mac | `PaperDigest-macOS-1.4.3-arm64.dmg` | 56327764 | `d5cf9a76140c7f98d4ce540338bac9d966cc1018dd33ccbdad7ee9338dea3589` |
| Mac | `PaperDigest-macOS-1.4.3-arm64.zip` | 48757474 | `a78973cc6963561c8680fb74d8e6c91ecb3b5890af97afa2c8aa769688e3c3a6` |
| Mac | `RELEASE_NOTES.md` | 2163 | `4c726b6d4e1c40cdef8426645019937178f928144a9f0bfd891c3f4744346e92` |
| Mac | `SHA256SUMS` | 453 | `1686ce94b9802576723248b15120be7a528b771512d345d829d95cc2afb726b9` |
| Mac | `build-info.json` | 1528 | `4cc4a2bca50a3f89bfe2625c59861ec1d49b03b6904f1ffcf0ee9e34a52be30e` |
| Mac | `release-manifest.json` | 687 | `1d28df674108f19056ddd6285eb9e2c9f3beff1bc8a290858075ce8cf9d47456` |
| Android | `paperdigest-android-1.4.3-19-universal.apk` | 75851334 | `8e30aad95e32483338b2b3d3cf10b103974ae9506cb0caea5569d94bacf72d1d` |
| Android | `ANDROID-SHA256SUMS` | 389 | `7c928bdf40740bc193370e4a4892cca820558240c43a4a14fbd5342b178cab9a` |
| Android | `android-build-info.json` | 346102 | `4c13d5b9660cbab455cdeae3c57ac63f429468c7a50d69821badc89729b806c2` |
| Android | `android-source-inputs.json` | 194743 | `a426a79a54a7cb48148190958560a8d5bebd6c88f2650e5b8069db44485ebdaa` |
| Android | `android-runtime-materials.json` | 31654 | `b22576c093c870d36e4f0d9b95eab83073a0f6a982dc845aa3591f1dd4b8160b` |
| Android | `android-release-manifest.json` | 591 | `f848e3f6a39067f57806cd61fab5c102a9454646f20b26f0906164bf2f2d1a06` |

两份校验表各自排除自身，也不覆盖全部十二件。`SHA256SUMS` 覆盖 DMG、ZIP、RELEASE_NOTES、build-info 与 release-manifest，不包含 `SHA256SUMS` 自己。`ANDROID-SHA256SUMS` 覆盖 APK、android-build-info、android-source-inputs 与 android-runtime-materials，不包含 `ANDROID-SHA256SUMS` 和 android-release-manifest。`release-manifest.json` 与 `android-release-manifest.json` 各自登记四个资产，同样不含清单自身和校验表。

晚到的草稿验收保存在受保护的实际快照中，最终公开后再提交公开状态说明；固定发行提交至公开之间不插入会破坏来源绑定的新提交。旧 Release 的清理在新版安装、升级及下载核验完成后执行；保留 Git 历史、原签名和升级验证凭据。

## 6. 打包测试

```sh
bash scripts/python-runtime.sh apps/macos/Tests/ReleasePackaging.test.py
```

该入口在系统临时目录中使用隔离仓库和最小应用，编译 Mach-O、实际签名、解包 ZIP、只读挂载 DMG，验证来源错配、路径、签名、清单与输出保护。它不启动用户应用、不访问私人资料，也不操作远端 Release。

接口依据：[GitHub CLI 创建草稿](https://cli.github.com/manual/gh_release_create)、[下载附件](https://cli.github.com/manual/gh_release_download)、[按 Release ID 更新](https://docs.github.com/en/rest/releases/releases#update-a-release)。
