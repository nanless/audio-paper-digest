# 论文速递工作台 Mac 版：构建与发行

本页说明版本 1.0.1 的本地准备和联合发行操作。1.0.1 已与 Android 安装包一同公开，见 [v1.0.1](https://github.com/nanless/audio-paper-digest/releases/tag/v1.0.1)；旧版本保留在同一发行页。

| 项目 | 当前发行目标 |
|---|---|
| 应用 | 论文速递工作台.app |
| 版本、构建号 | 1.0.1、1 |
| 架构、最低系统 | arm64、macOS 15 |
| 运行时 | 随包 Node 24.19.0 |
| 签名 | 本地 ad-hoc 签名，未 Apple 公证 |
| 资源通道 | release，不捆绑论文样稿 |

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

```sh
apps/macos/release.sh inspect \
  --app 'apps/macos/.build/论文速递工作台.app' \
  --build-record "$BUILD_RECORD" \
  --version 1.0.1

apps/macos/release.sh prepare \
  --app 'apps/macos/.build/论文速递工作台.app' \
  --build-record "$BUILD_RECORD" \
  --version 1.0.1 \
  --output 'apps/macos/.build/releases/1.0.1-arm64' \
  --dmg

apps/macos/release.sh verify \
  --prepared 'apps/macos/.build/releases/1.0.1-arm64'
```

`inspect` 只读核对干净工作区、来源、实际输入、版本、签名、架构与最低系统。输出目录必须尚不存在，失败不覆盖原产物。`--dmg` 可省略；要求生成 DMG 时，失败不会自动改交 ZIP。

| 输出 | 核对内容 |
|---|---|
| `PaperDigest-macOS-1.0.1-arm64.zip` | 保留应用结构、资源 fork 与签名；实际解包比对文件、模式、属性及签名 |
| 同名 DMG | 应用与指向 `/Applications` 的拖入目标；检查映像并只读挂载回读 |
| `build-info.json` | 版本、架构、时间、来源身份和相对文件摘要，无本机构建路径 |
| `RELEASE_NOTES.md` | 按真实范围生成的版本、安装、签名与支持说明 |
| `release-manifest.json`、`SHA256SUMS` | 完整附件集合与实际字节摘要 |

打包和回读不启动应用。实际安装、图形首启与业务操作分别记录，1.0.1 新包的已执行范围见[验证说明](mac-app-validation.md)。

## 3. 来源、许可与隐私

包内版本必须与发行版本相同。运行输入、原生源码、资源和实际包文件逐项核对；构建后的运行源码变化要求重新构建。工具仅允许明确的已提交 `docs/*.md`、独立 Android 树及两个指定发行验证文件作为非运行变更。其他说明文件也须遵守现有来源检查；例如两份 Mac README 修改后需正常重建，不因文字不执行就绕过检查。所有文档修改先提交，脏工作区不能准备发行。

正式包拒绝额外文件、链接、路径越界、私人扩展属性、生产配置、凭据、个人资料和运行记录。样稿只在显式私有测试通道按固定路径及 SHA 接受。Node 实际版本与离线许可匹配，许可全文和归属保留原样。KaTeX 从本机 npm 缓存按锁定版本、官方归档位置及 SHA-512 核验；需要时用 `PD_RELEASE_NPM_CACHE` 指定缓存，不联网补包或执行 npm 脚本。

准备工具不读取生产 `.env`、用户钥匙串或私人文库，不调用模型。附件校验值证明下载字节，Apple 签名、公证及实际功能另有各自验证范围。

## 4. 私有草稿、下载核验与公开

联合发行使用同一干净提交准备 Mac 与正式签名 Android 包，两端版本一致，Android 来源等于选定发行提交。先整理版本说明，再正常生成并固定附件、清单与校验文件；之后不手工修改已固定的文件。

[原69项功能检查](mac-app-acceptance.md)和[新增17项](mac-app-cloud.md)保留全部原 ID，状态唯一。创建私有草稿前须有 84 项通过；仅依赖真实草稿的 `REL-03`、`REL-04` 可为待验。公开前全部 86 项必须通过，失败、受阻或不适用不能替代通过。

先明确建立并核对远端版本标签。单端 `private-draft-plan` 只生成草稿参数；两端联合使用 Android 工具，以下路径变量代表已正常生成的对应产物和实际验收快照：

```sh
python3 apps/android/release_tools.py --repo "$PWD" joint-private-draft-plan \
  --prepared "$ANDROID_PREPARED" --certificate "$ANDROID_CERTIFICATE_SHA256" \
  --mac "$MAC_PREPARED" \
  --android-acceptance "$ANDROID_ACCEPTANCE" \
  --mac-acceptance "$MAC_ACCEPTANCE" --mac-cloud "$MAC_CLOUD_ACCEPTANCE"
```

工具只读查询固定仓库 `nanless/audio-paper-digest` 的标签，核对真实提交，生成带 `--draft`、`--verify-tag` 的参数。维护者复核后执行草稿命令，保留实际 Release ID；旧 `publish-plan`、`joint-plan` 同样只生成草稿计划，不能直接公开。

核对真实草稿、说明与全部上传附件后，完成 `REL-03`、`REL-04`，用同一固定输入生成公开参数：

```sh
python3 apps/android/release_tools.py --repo "$PWD" joint-public-plan \
  --prepared "$ANDROID_PREPARED" --certificate "$ANDROID_CERTIFICATE_SHA256" \
  --mac "$MAC_PREPARED" --draft-id "$RELEASE_ID" \
  --android-acceptance "$ANDROID_ACCEPTANCE" \
  --mac-acceptance "$MAC_ACCEPTANCE" --mac-cloud "$MAC_CLOUD_ACCEPTANCE"
```

公开计划重新核对包和来源，查询指定草稿 ID，按固定资产 ID 下载全部文件并比较真实字节，之后再次核对标签与草稿未变化。检查通过只生成针对同一 ID 的公开参数，不创建、上传或自动公开。维护者最终复核后执行，并核对公开状态、标签和附件。

晚到的草稿验收保存在受保护的实际快照中，最终公开后再提交公开状态说明；固定发行提交至公开之间不插入会破坏来源绑定的新提交。旧 v1.0.0 Release、标签及资产保持不变。

## 5. 打包测试

```sh
bash scripts/python-runtime.sh apps/macos/Tests/ReleasePackaging.test.py
```

该入口在系统临时目录中使用隔离仓库和最小应用，编译 Mach-O、实际签名、解包 ZIP、只读挂载 DMG，验证来源错配、路径、签名、清单与输出保护。它不启动用户应用、不访问私人资料，也不操作远端 Release。

接口依据：[GitHub CLI 创建草稿](https://cli.github.com/manual/gh_release_create)、[下载附件](https://cli.github.com/manual/gh_release_download)、[按 Release ID 更新](https://docs.github.com/en/rest/releases/releases#update-a-release)。
