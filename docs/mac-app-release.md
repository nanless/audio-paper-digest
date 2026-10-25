# Mac应用发行产物准备

这套工具先把审定的 `.app` 制成可回读的本地产物，不创建 GitHub Release、不推标签、不上传文件。正式验收条件仍以[验收矩阵](mac-app-acceptance.md)及其实际状态为准。只要还有适用必测项未通过，不能把本地候选称作正式交付。

当前包内版本为 `1.0.0`、构建号 `1`；发行版本必须与包内版本相同。不能仅给 ZIP 换个版本名。当前构建为单架构 Apple Silicon `arm64`、最低 macOS 15，使用本机 ad-hoc 开发签名，未经过 Apple 公证。2026-10-25检查时没有可用的 Developer ID 签名身份，仓库也没有既有 GitHub Release。此记录不承诺未来证书、其他架构或其他 Mac 的安装体验。

## 检查与打包

先完成业务修改、测试、独立审查与中文提交，再重新构建、安装并验收最终候选。不要把旧包的验收结论套到包含新业务源码的提交上。明确选定该次构建保留的 `signed-build.json`，不要仅根据文件时间挑最近一个。

构建默认使用`release`通道：新用户从空目录主动同步网站成果，不内嵌科学样稿。`--channel private-qa`只用于保留原PDF、科学图及完整图文的私有验收。元数据记录实际通道；私有QA即使验收表全部通过，也不能生成正式发布计划。缺少通道字段的历史包仅可`inspect`，不能据其准备新发行产物。

```bash
apps/macos/release.sh inspect \
  --app 'apps/macos/.build/论文速递.app' \
  --build-record '/该次构建记录的绝对路径/signed-build.json' \
  --version 1.0.0
```

`inspect`只读核对工作区、来源提交、清单、主程序、包内文件、实际签名、架构与最低系统。工作区须干净，包括文档。构建提交之后，只接受已提交的 `docs/*.md`、独立的 `apps/android/` 树，以及未打入应用的 `apps/macos/release_tools.py` 和 `apps/macos/Tests/ReleasePackaging.test.py` 两个发行验证文件。文档变化与其他运行外变化分别记录在 `documentationOnlyChanges`、`otherNonRuntimeChanges`，运行源码提交与最终发行提交也分别保留；Android代码不能冒称文档。

这项放行仍逐项比较 Mac 清单中的原 Git 字节、当前检出字节和实际包内文件，并核完整原生源码、构建输入、签名和包文件集合。Mac 业务、资源、构建、依赖锁或其他测试文件变化仍要求重新构建。2026-10-25 新增的 Android 独立树、共享输入变更拒绝及验证文件分类已通过45项隔离测试和非作者复核；这不证明 Android APK 或真实业务验收已经通过。Android 仍按[自己的功能表](android-feature-parity.md)及最终安装包独立核验。

```bash
apps/macos/release.sh prepare \
  --app 'apps/macos/.build/论文速递.app' \
  --build-record '/该次构建记录的绝对路径/signed-build.json' \
  --version 1.0.0 \
  --output 'apps/macos/.build/releases/1.0.0-arm64' \
  --dmg

apps/macos/release.sh verify \
  --prepared 'apps/macos/.build/releases/1.0.0-arm64'
```

输出目录必须尚不存在，失败不会覆盖先前产物或修改原应用。`--dmg`可省略；需要DMG时不在失败后悄悄降成ZIP。最终产物为：

- `PaperDigest-macOS-1.0.0-arm64.zip`：使用 macOS `ditto`保留应用结构、资源fork和签名，实际解包后再次核对全部文件、模式、资源fork及签名。
- 同名 `.dmg`（显式要求时）：包含原应用和指向 `/Applications`的拖入目标；生成后先检查映像，再仅只读挂载自己生成的临时映像，核对内部实际应用和拖入目标，随后卸载。不会启动包内应用或打开 Finder 窗口。
- `build-info.json`：仅含版本、架构、时间、Git身份、相对文件摘要及签名声明，不复制私有构建记录中的本机路径。
- `RELEASE_NOTES.md`：如实写明本地候选、未公证及尚需正式验收，供维护者整理最终说明。
- `release-manifest.json`和`SHA256SUMS`：分别核对每个资产及全部文件。校验和不替代Apple身份签名、来源审查或产品验收。

应用包拒绝额外文件、越界清单、符号链接及 `.env`、`.qa`、个人资料、模型费用目录、归档journal等私人运行内容；根应用、目录及文件都拒绝私人下载位置、Finder注释或未知扩展属性，许可属性摘要与目录模式也参与往返比较。正式包拒绝Seed、改名论文原件及内嵌样稿图片；私有QA的未跟踪PDF和图片只允许Git中`sample.json`逐项列明的原路径和SHA。每个包还核随包许可清单、完整原文页面与实际Node版本；外层重新计算校验和不能改变签名包的通道或身份。

KaTeX只读本机npm内容缓存，按Git锁文件的版本、官方归档路径及SHA512验证原tar，再逐项核对完整`dist`及LICENSE，不能凭应用清单自报信任额外文件。默认缓存为`~/.npm`；自定义缓存可显式设置`PD_RELEASE_NPM_CACHE`，不会联网补包或执行npm脚本。ZIP回读在解包前检查路径和链接，DMG回读只接受规定内容。工具不会读取生产`.env`、用户钥匙串或私人文库，也不调用模型。现有公开源码、锁定前端组件和完整许可继续保留；忽略的科学原件只用于显式私有QA。

## 从本地候选到远端草稿

当前工具没有上传或发布子命令。`publish-plan`只生成结构化 `gh` 参数数组，也不会执行它：

```bash
apps/macos/release.sh publish-plan \
  --prepared 'apps/macos/.build/releases/1.0.0-arm64' \
  --acceptance-status 'docs/mac-app-acceptance-status.md' \
  --cloud-acceptance 'docs/mac-app-cloud.md' \
  --repository nanless/audio-paper-digest \
  --prerelease
```

此步骤要求69个原ID以及新增`CLOUD-01`至`CLOUD-12`、`REL-01`至`REL-05`共17个ID分别齐全且唯一、全部适用必测项明确通过；云端验收路径省略时使用当前仓库`docs/mac-app-cloud.md`。原69项即便通过，也不能绕过新增网盘与发行条件。待验、失败、受阻、缺项、重复或用别的ID替换都会拒绝。不得编辑状态表来代替实际验收。最终HEAD还必须等于准备产物时记录的发行提交。工具只判断这些本地边界，维护者仍须独立核对该包的真实验收、最终版本说明和签名限制。

是否声明 `prerelease`由维护者根据最终实测状态决定，不由打包工具把未验项自动洗成正式通过。生成的命令始终包含`--draft`及`--verify-tag`，后者要求远端已经有维护者明确创建、核对的版本标签，防止`gh release create`默认从分支自动建标签。工具本身不会创建或推送标签，也不会将草稿发布。产物说明保持“本地候选”直到维护者完成最终说明审查，不能把自动生成的候选说明当成正式版本公告。

确需创建或发布时，由主任务在用户原授权、全部验收及最终包独审均完成后，使用GitHub官方`gh` CLI独立执行并核对远端标签提交、草稿资产SHA、说明和最终公开状态。本工具不会因为生成了命令就提前执行；本地校验失败时也不会绕过门槛上传。

## 隔离回归

```bash
bash scripts/python-runtime.sh apps/macos/Tests/ReleasePackaging.test.py
```

测试只在系统临时目录建立无私人资料的Git仓库与明确标注的最小应用，编译真实Mach-O、实际ad-hoc签名，并执行真实ZIP解包和DMG只读挂载。它不启动真实应用，不访问用户文库、密钥或付费服务，不创建远端Release。测试覆盖正常产物、签名/源码/版本/架构错配、未验发布门、路径越界、包或校验和篡改、脏工作区及输出保护；隔离样本通过不代表真实最终包或69项已通过。
