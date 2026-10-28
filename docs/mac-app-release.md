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

## 先准备草稿，再核验公开条件

发行分为本地固定安装资产、远端私有草稿、核验后公开三个阶段。工具只生成上传或公开的参数，不执行这些写操作；新阶段会只读查询固定仓库的标签或草稿，并在公开计划检查时下载资产到独立临时目录。查询失败即停止，不根据手填远端回执放行。

先完成最终代码、正常测试、独立审查与两端安装验收，在同一干净提交 `H` 准备 Mac 和正式签名 Android 包，核对版本、签名和全部资产。Mac 记录运行源码和发行提交，Android 来源提交须等于 `H`；两端版本须一致。版本说明在打包前据实整理，清单与校验文件一起固定。此后不要手改已封存的版本说明、清单、源码或包。

本地验收必须保留各端全部86个原ID且唯一。创建私有草稿前，原69项、`CLOUD-01`至`CLOUD-12`以及`REL-01`、`REL-02`、`REL-05`共84项必须真实通过；只有依赖实际草稿的`REL-03`、`REL-04`可如实保留“待验”，也可已经通过。这两项若失败、受阻或不适用，仍拒绝；任何业务项待验也拒绝。这里没有通用的“允许未完成”开关，不得修改状态来替代实际验收。

维护者先明确建立并核对远端版本标签。以下 Mac 单端入口只生成草稿计划：

```bash
apps/macos/release.sh private-draft-plan \
  --prepared 'apps/macos/.build/releases/1.0.0-arm64' \
  --acceptance-status '/实际验收快照/mac-status.md' \
  --cloud-acceptance '/实际验收快照/mac-cloud.md' \
  --repository nanless/audio-paper-digest
```

两端同一 Release 使用 Android 工具的 `joint-private-draft-plan`，额外核 Android 正式签名包、两端来源与版本、资产名不冲突和各自完整状态：

```bash
python3 apps/android/release_tools.py --repo "$PWD" joint-private-draft-plan \
  --prepared '/已核Android签名产物' --certificate '正式证书SHA256' \
  --mac '/已核Mac产物' \
  --android-acceptance '/实际验收快照/android.md' \
  --mac-acceptance '/实际验收快照/mac-status.md' \
  --mac-cloud '/实际验收快照/mac-cloud.md'
```

新入口真实只读查询固定的 `nanless/audio-paper-digest` 远端标签，轻量标签直接提交、附注标签剥离后的提交都必须精确等于 `H`。不存在、重复、错误标签或错误OID均拒绝。生成的创建参数必须同时包含`--draft`和`--verify-tag`，不会隐式创建标签或直接公开。原`publish-plan`及`joint-plan`保持兼容：仍要求全部86项通过，仍只生成草稿命令，不能拿它们绕过新阶段。

维护者复核后执行草稿命令，保留真实 Release ID。核对该私有草稿、标签、说明、上传资产及下载实包后，才将`REL-04`登记为通过，再依据完整验收和固定输入关闭`REL-03`。这些晚到的状态可以写在仓库已忽略目录中的实际验收快照，保留原失败、真实证据和哈希；不要在固定 `H` 与最终公开之间先提交公开状态文档，否则现有严格来源检查会要求重新准备包。

公开前使用同一签名产物与全部86项真实通过的快照，明确传入实际草稿ID：

```bash
python3 apps/android/release_tools.py --repo "$PWD" joint-public-plan \
  --prepared '/已核Android签名产物' --certificate '正式证书SHA256' \
  --mac '/已核Mac产物' --draft-id 12345 \
  --android-acceptance '/实际验收快照/android.md' \
  --mac-acceptance '/实际验收快照/mac-status.md' \
  --mac-cloud '/实际验收快照/mac-cloud.md'
```

此阶段重新执行全部两端包与来源检查，真实查询指定ID，要求标签相符、`draft=true`、尚无公开时间、全部资产名/大小/ID/上传状态正确，说明与固定版本说明相符。随后按该草稿已核对的固定资产ID只读下载全部文件，不按标签重新选择另一个Release，以现有`verify-downloaded`逐字节比较并重新核验 Mac 包和 Android APK；下载后再次读取同一草稿和剥离标签OID，任何实质变化都拒绝。正常增加的下载计数不算资产变化。它只生成针对该固定 Release ID 的 `draft=false` 参数，不创建新草稿、不上传、不改标签，也不自动执行公开。

主任务在原授权范围内完成最终独立复核后，立即执行刚核验生成的公开参数，并核实同一ID的公开状态、标签和资产。发生变化就重新检查，不复用过期计划。公开后再提交公开验收文档，保留发行提交 `H`、实际记录与旧失败；这项顺序安排不放宽`source_state`、HEAD相等或任何业务验收条件。模拟器、签名和公证的实际范围须如实保留，不能把`prerelease`、私有草稿或下载SHA当作未测业务通过。

命令与阶段依据 GitHub 官方[创建草稿](https://cli.github.com/manual/gh_release_create)、[下载资产](https://cli.github.com/manual/gh_release_download)及[按Release ID更新](https://docs.github.com/en/rest/releases/releases#update-a-release)的接口；工具输出参数不代表远端写操作已发生。

## 隔离回归

```bash
bash scripts/python-runtime.sh apps/macos/Tests/ReleasePackaging.test.py
```

测试只在系统临时目录建立无私人资料的Git仓库与明确标注的最小应用，编译真实Mach-O、实际ad-hoc签名，并执行真实ZIP解包和DMG只读挂载。它不启动真实应用，不访问用户文库、密钥或付费服务，不创建远端Release。测试覆盖正常产物、签名/源码/版本/架构错配、未验发布门、路径越界、包或校验和篡改、脏工作区及输出保护；隔离样本通过不代表真实最终包或69项已通过。
