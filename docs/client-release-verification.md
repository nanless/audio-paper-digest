# 客户端发行核验（1.5.0）

## 1.5.0 公开结果

| 项 | 值 |
|---|---|
| 标签 | `v1.5.0`（附注标签 `24a48710db724898cd89c0b73f0ac054f68fb697`），指向发行提交 `5b5a8e79e5e70290cb650fd37e71417f46946a2b`（`5b5a8e79`） |
| 发布时间 | 2026-11-26 10:12（北京时间，`2026-11-26T02:12:48Z`） |
| 发行页 | https://github.com/nanless/audio-research-workbench/releases/tag/v1.5.0（Release ID `458861899`，`draft: false`，`prerelease: false`） |
| 版本、构建号 | 两端均为 1.5.0、24（Android `versionName` 1.5.0、`versionCode` 24） |
| 附件 | 12 件：Mac 6 件（ZIP、DMG、`build-info.json`、`RELEASE_NOTES.md`、`release-manifest.json`、`SHA256SUMS`），Android 6 件（APK、`android-build-info.json`、`android-source-inputs.json`、`android-runtime-materials.json`、`android-release-manifest.json`、`ANDROID-SHA256SUMS`） |
| 匿名下载 | 发行页与 12 件附件未登录请求（无 Cookie、无 `Authorization` 头）均返回 HTTP 200（2026-11-26 复核），下载文件字节数、SHA-256 与双端 `verify-downloaded` 包体回读均一致 |
| Android 签名 | 沿用 1.4.4–1.4.7 发布签名库（`apksigner` 36.0.0 以 APK Signature Scheme v3 签名并经 `finalize-signed` 封存核验，`signingOrigin: provided-signed-apk`），证书 SHA-256 `6a0c3138…`；1.4.4–1.4.7 用户可直接覆盖升级，1.4.3（`d7c680d9…`）用户仍需备份后卸载重装 |
| 人工验收 | 未重新执行 84/86 项人工图形与实机验收矩阵；本版完成双端全量自动测试、服务端 JS/Python 回归、打包回读、匿名下载签名核验与“音频研究门户”线上部署核验 |

1.5.0 的改动与验证范围见 [1.5.0 记录](workbench-1.5.0-review.md)。

## 1.5.0 的十二件附件

以下字节与 SHA-256 于 2026-11-26 对公开 Release 页面及 12 件附件执行未登录下载复核；按 `SHA256SUMS` 与 `ANDROID-SHA256SUMS` 对照，逐件字节数与 SHA-256 与下表一致。两份校验表都不包含自身；`SHA256SUMS` 覆盖其余五件 Mac 资产（含 `release-manifest.json`），`ANDROID-SHA256SUMS` 覆盖 APK 与三份 Android 构建记录，不包含 `android-release-manifest.json`，核对时以表内条目为准。

| 平台 | 附件 | 字节 | SHA-256 |
|---|---|---:|---|
| Mac | `PaperDigest-macOS-1.5.0-arm64.dmg` | 58640859 | `ab3758f18f975fd441134fb30ee4e933ab7efc3413d41a20ad58983ee4ec1269` |
| Mac | `PaperDigest-macOS-1.5.0-arm64.zip` | 50252065 | `0bfa261a233cb8025b3db473b8a5537ea9cbad4d7db7246f48b7e9aa7ca19321` |
| Mac | `RELEASE_NOTES.md` | 3744 | `0c21bcfe489260f1e9648c8a207888c2a74f27b5849afa7772900eb181d9ebe9` |
| Mac | `SHA256SUMS` | 453 | `1cb239f27fbd8d184d8433dbd2f94aa4b9a7ccb4edbe9c118a72dc0b5bc7faab` |
| Mac | `build-info.json` | 1528 | `b3a954de2d81adb9ceab5441ce133c6c175be89d18dda166f8272419483a3e26` |
| Mac | `release-manifest.json` | 687 | `0a6b020fe112fd4f9f54b0eec919f0c8e16673f8e40d115e44fb8495fc56e37f` |
| Android | `paperdigest-android-1.5.0-24-universal.apk` | 76482118 | `980cf5e628e4712f441ab73f2e38a0f19a4e37967c6e3f7adf6b0ec6eba85443` |
| Android | `ANDROID-SHA256SUMS` | 389 | `d37720934d05b61bb3383375f2ff734b52bd679c34f348e761be316d1e49b243` |
| Android | `android-build-info.json` | 346263 | `b302163cb32cd184a9452c0c5d316af8437343062c9f4d83e6fe1f0be5c75d68` |
| Android | `android-source-inputs.json` | 198252 | `b43e2fbef292385801c95f99ea9625d658325b3489b17b414b6da3699e365eb5` |
| Android | `android-runtime-materials.json` | 31654 | `b22576c093c870d36e4f0d9b95eab83073a0f6a982dc845aa3591f1dd4b8160b` |
| Android | `android-release-manifest.json` | 591 | `752f077090aa1ee4719c9f8eba7e2f8dc67dfd99ed8f5fa61ca356e3d68f7955` |

## 1.5.0 的签名

Mac 应用自 1.5.0 起更名为 `音频研究工作台.app`，继续使用应用标识 `com.nanless.PaperDigest` 与本地 `ad-hoc; not notarized` 签名（未经过 Apple 公证）。公开 ZIP 中的应用包经 `codesign -dv --verbose=4` 核对：格式为 arm64 Mach-O，`Signature=adhoc`，`TeamIdentifier=not set`，CDHash `f694ae0ba15e9f9db97f76febc3d607ea85cb6da`；`build-info.json` 记录 `sourceCommit` 与 `releaseHead` 均为 `5b5a8e79e5e70290cb650fd37e71417f46946a2b`，版本 1.5.0（构建号 24）、`arm64`、最低系统 macOS 15.0、随包 Node `24.19.0`。ad-hoc 签名只证明包在打包后没有被改动，不提供 Apple 开发者身份。

公开 APK 沿用 1.4.4–1.4.7 的发布签名库（使用 `apksigner` 36.0.0 签名并经 `finalize-signed` 封存核验，`signingOrigin: provided-signed-apk`）。经 `apksigner verify --print-certs --verbose` 核对，证书 DN 为 `CN=Paper Digest, OU=Release, O=nanless, L=Shanghai, ST=Shanghai, C=CN`，证书 SHA-256 为 `6a0c3138f9a49b01f868a123490a7e562f6d78d951160afb2ea5b1e44274e5bb`（RSA 4096），实际通过 **APK Signature Scheme v3** 验证（`v1/v2/v3.1/v4` 为 `false`）；`android-build-info.json` 记录 `versionName` 1.5.0、`versionCode` 24、`minSdk` 28、`targetSdk` 37，应用标识 `com.nanless.paperdigest`，四种 ABI 齐全且原生库符合 16 KiB ELF 对齐。已安装 1.4.4–1.4.7 的用户可以直接覆盖升级；1.4.3 的证书是 `d7c680d9…`，仍需先导出完整备份、卸载旧版再安装。

# 1.4.7 发行核验（历史存档）

本节记录上一版 1.4.7 的公开结果、附件与签名；当前公开发行版本 1.5.0 的核验结果见上文。各版本的包只能对照同版本的校验表核对。

## 1.4.7 公开结果

| 项 | 值 |
|---|---|
| 标签 | `v1.4.7`（附注标签 `3ca347ac10dcb80937a5cb3d081121126576ae6e`），指向发行提交 `520e93c37cad726ca5a32d0cc79f78db29fe1e22`（`520e93c3`） |
| 发布时间 | 2026-11-23 09:43（北京时间，`2026-11-23T01:43:38Z`） |
| 发行页 | https://github.com/nanless/audio-paper-digest/releases/tag/v1.4.7（Release ID `454892656`，`draft: false`，`prerelease: false`） |
| 版本、构建号 | 两端均为 1.4.7、23（Android `versionName` 1.4.7、`versionCode` 23） |
| 附件 | 12 件：Mac 6 件（ZIP、DMG、`build-info.json`、`RELEASE_NOTES.md`、`release-manifest.json`、`SHA256SUMS`），Android 6 件（APK、`android-build-info.json`、`android-source-inputs.json`、`android-runtime-materials.json`、`android-release-manifest.json`、`ANDROID-SHA256SUMS`） |
| 匿名下载 | 发行页与 12 件附件未登录请求（无 Cookie、无 `Authorization` 头）均返回 HTTP 200（2026-11-23 复核），下载文件字节数与 SHA-256 均与校验表一致 |
| Android 签名 | 沿用 1.4.4–1.4.6 发布签名库（`apksigner` v2 + v3 签名并经 `finalize-signed` 封存核验，`signingOrigin: provided-signed-apk`），证书 SHA-256 `6a0c3138…`；1.4.4、1.4.5 与 1.4.6 用户可直接覆盖升级，1.4.3（`d7c680d9…`）用户仍需备份后卸载重装 |
| 人工验收 | 未重新执行 84/86 项人工图形与实机验收矩阵；本版改动只完成双端自动测试、打包回读与全站 9276 页导读片段 / 8551 篇去重论文真实导出语料重放覆盖 |

1.4.7 的改动与验证范围见 [1.4.7 记录](workbench-1.4.7-review.md)。

## 1.4.7 的十二件附件

以下字节与 SHA-256 于 2026-11-23 对公开 Release 页面及 12 件附件执行未登录下载复核；按 `SHA256SUMS` 与 `ANDROID-SHA256SUMS` 对照，逐件字节数与 SHA-256 与下表一致。两份校验表都不包含自身；`SHA256SUMS` 覆盖其余五件 Mac 资产（含 `release-manifest.json`），`ANDROID-SHA256SUMS` 覆盖 APK 与三份 Android 构建记录，不包含 `android-release-manifest.json`，核对时以表内条目为准。

| 平台 | 附件 | 字节 | SHA-256 |
|---|---|---:|---|
| Mac | `PaperDigest-macOS-1.4.7-arm64.dmg` | 58302415 | `6ece716f4e000fc5eb47bd22e04b9f42fc03bd34810580056c1adc6444cbfdfc` |
| Mac | `PaperDigest-macOS-1.4.7-arm64.zip` | 49686034 | `9be93a54e01436d18472b3681ce7dd4872eb85fc9639a10c07b566f2d83ba3a7` |
| Mac | `RELEASE_NOTES.md` | 2422 | `42c1f2adb181855ffbcfc8457905efda27f1492b1db16857f1c4741425d0cfd8` |
| Mac | `SHA256SUMS` | 453 | `d979696edbf03339473cb271ad1d6407c21e31485d7e103dd3801748a6668fcf` |
| Mac | `build-info.json` | 1528 | `79601cf4900c968b419449791694a262e7698d40cdaeed3b8b5255c54e5eec1f` |
| Mac | `release-manifest.json` | 687 | `693a2d523c18431d480c0094ef6db7a18eb12a2adf93ce09414633b66236e658` |
| Android | `paperdigest-android-1.4.7-23-universal.apk` | 76232262 | `6093f529b021a81ad344bdc1d90de2aa21e8179d98e31611a7eafc1bf5b98ed1` |
| Android | `ANDROID-SHA256SUMS` | 389 | `f15064ea2cdb40d0ebdd0ce34d5ba188b0cfc62143b966491397407c5b11739c` |
| Android | `android-build-info.json` | 346263 | `f2f895eed7a5948e3d0749b529f804bbfbafcc7e718367d8b8895c9bde8f21a7` |
| Android | `android-source-inputs.json` | 196967 | `a7e5ec65600d35fe70540e3fad838c13bdf781dad09da3181d88934a72dccafd` |
| Android | `android-runtime-materials.json` | 31654 | `b22576c093c870d36e4f0d9b95eab83073a0f6a982dc845aa3591f1dd4b8160b` |
| Android | `android-release-manifest.json` | 591 | `892efd0affaf95d5e0f8bedb2d7f55871996abe39cde8c889c425bca10d31999` |

## 1.4.7 的签名

Mac 包使用本地 `ad-hoc; not notarized` 签名，未经过 Apple 公证；`build-info.json` 记录 `sourceCommit` 与 `releaseHead` 均为 `520e93c37cad726ca5a32d0cc79f78db29fe1e22`，版本 1.4.7（构建号 23）、`arm64`、最低系统 macOS 15.0、随包 Node `24.19.0`。ad-hoc 签名只证明包在打包后没有被改动，不提供 Apple 开发者身份。

公开 APK 沿用 1.4.4–1.4.6 的发布签名库（使用 `apksigner` 36.0.0 以 v2 + v3 签名并经 `finalize-signed` 封存核验，`signingOrigin: provided-signed-apk`）。`android-build-info.json` 记录证书 SHA-256 为 `6a0c3138f9a49b01f868a123490a7e562f6d78d951160afb2ea5b1e44274e5bb`，APK Signature Scheme v2 + v3，`versionName` 1.4.7、`versionCode` 23、`minSdk` 28、`targetSdk` 37，应用标识 `com.nanless.paperdigest`，四种 ABI 齐全且原生库符合 16 KiB ELF 对齐。已安装 1.4.4、1.4.5 或 1.4.6 的用户可以直接覆盖升级；1.4.3 的证书是 `d7c680d9…`，仍需先导出完整备份、卸载旧版再安装。

# 1.4.6 发行核验（历史存档）

本节记录上一版 1.4.6 的公开结果、附件与签名；当前公开发行版本 1.4.7 的核验结果见上文。各版本的包只能对照同版本的校验表核对。

## 1.4.6 公开结果

| 项 | 值 |
|---|---|
| 标签 | `v1.4.6`（附注标签 `29f9e269be981f266bc161a7e070fc4f65d5b132`），指向发行提交 `fcf7e05bf44f06e7c3416636445cdda4391fe695`（`fcf7e05b`） |
| 发布时间 | 2026-11-20 00:36（北京时间，`2026-11-19T16:36:37Z`） |
| 发行页 | https://github.com/nanless/audio-paper-digest/releases/tag/v1.4.6（Release ID `451609415`，`draft: false`，`prerelease: false`） |
| 版本、构建号 | 两端均为 1.4.6 / 22（Android `versionName` 1.4.6、`versionCode` 22） |
| 附件 | 12 件：Mac 6 件（ZIP、DMG、`build-info.json`、`RELEASE_NOTES.md`、`release-manifest.json`、`SHA256SUMS`），Android 6 件（APK、`android-build-info.json`、`android-source-inputs.json`、`android-runtime-materials.json`、`android-release-manifest.json`、`ANDROID-SHA256SUMS`） |
| 匿名下载 | 发行页与 12 件附件未登录请求（无 Cookie、无 `Authorization` 头）均返回 HTTP 200（2026-11-20 复核），下载文件字节数与 SHA-256 均与校验表一致 |
| Android 签名 | 沿用 1.4.4/1.4.5 发布签名库（`signingOrigin: apksigner-sign`），证书 SHA-256 `6a0c3138…`，APK Signature Scheme v2 + v3；1.4.4 与 1.4.5 用户可直接覆盖升级，1.4.3（`d7c680d9…`）用户仍需备份后卸载重装 |
| 人工验收 | 未重新执行 84/86 项人工图形与实机验收矩阵；本版改动只完成双端自动测试、打包回读与全站 9225 页导读片段 / 8863 篇去重论文真实导出语料重放覆盖 |

1.4.6 的改动与验证范围见 [1.4.6 记录](workbench-1.4.6-review.md)。

## 1.4.6 的十二件附件

以下字节与 SHA-256 于 2026-11-20 对公开 Release 页面及 12 件附件执行未登录下载复核；按 `SHA256SUMS` 与 `ANDROID-SHA256SUMS` 对照，逐件字节数与 SHA-256 与下表一致。两份校验表都不包含自身；`SHA256SUMS` 覆盖其余五件 Mac 资产（含 `release-manifest.json`），`ANDROID-SHA256SUMS` 覆盖 APK 与三份 Android 构建记录，不包含 `android-release-manifest.json`，核对时以表内条目为准。

| 平台 | 附件 | 字节 | SHA-256 |
|---|---|---:|---|
| Mac | `PaperDigest-macOS-1.4.6-arm64.dmg` | 57331482 | `633cd2864aaee2f428448e7fb7e1bb2b59dbfb54cc0456d74e0d1b1bd9090148` |
| Mac | `PaperDigest-macOS-1.4.6-arm64.zip` | 49302663 | `d56a4b70e3309e70c715a221ac9e4bb3e230e2e7f71c9519005272c3d6c76a3d` |
| Mac | `RELEASE_NOTES.md` | 2749 | `ed26ca11c47e80d1247e9226e85c82ee69c3d58987b2527c5aabf87f0b017754` |
| Mac | `SHA256SUMS` | 453 | `e219c59bcac43168914bca29212e49a9a453f094dc10244fe740a4acc9c461d6` |
| Mac | `build-info.json` | 1528 | `b5b62b45e4c4d1d2dff24d1e65b3e680a9cfbb1720e6920d1659f3721df7d1cb` |
| Mac | `release-manifest.json` | 687 | `971329e45d5291f03dba158f823a12eaf2b5c002fadd677429408d2cf625d087` |
| Android | `paperdigest-android-1.4.6-22-universal.apk` | 76183110 | `fbc7b83419e5dc7f585c53166b99b929aa2336970671085c5b8c227b709797e8` |
| Android | `ANDROID-SHA256SUMS` | 389 | `dcf98c6075ece9cfd2103633f6880df88b2aa8808c2d206cf91a04657a358ea9` |
| Android | `android-build-info.json` | 346102 | `57807f24f0dc19b3c8f08fcbd12ed82b1f3cc12621c64617af5fb883b3c6c8ce` |
| Android | `android-source-inputs.json` | 196965 | `68c8f40ddfa2f0aed700176bcd646b28fd9c9c1ec7729d886fe9b23f9939466b` |
| Android | `android-runtime-materials.json` | 31654 | `b22576c093c870d36e4f0d9b95eab83073a0f6a982dc845aa3591f1dd4b8160b` |
| Android | `android-release-manifest.json` | 591 | `749d92b8dc242992691d89ff850d9b534eaed011e11e0e71c170b0f9a5f1d628` |

## 1.4.6 的签名

Mac 包使用本地 `ad-hoc; not notarized` 签名，未经过 Apple 公证；`build-info.json` 记录 `sourceCommit` 与 `releaseHead` 均为 `fcf7e05bf44f06e7c3416636445cdda4391fe695`，版本 1.4.6 / 构建号 22、`arm64`、最低系统 macOS 15.0、随包 Node `24.19.0`。ad-hoc 签名只证明包在打包后没有被改动，不提供 Apple 开发者身份。

公开 APK 沿用 1.4.4/1.4.5 的发布签名库（`signingOrigin: apksigner-sign`）。`android-build-info.json` 记录证书 SHA-256 为 `6a0c3138f9a49b01f868a123490a7e562f6d78d951160afb2ea5b1e44274e5bb`，APK Signature Scheme v2 + v3，`versionName` 1.4.6、`versionCode` 22、`minSdk` 28、`targetSdk` 37，应用标识 `com.nanless.paperdigest`，四种 ABI 齐全且原生库符合 16 KiB ELF 对齐。已安装 1.4.4 或 1.4.5 的用户可以直接覆盖升级；1.4.3 的证书是 `d7c680d9…`，仍需先导出完整备份、卸载旧版再安装。

# 1.4.5 发行核验（历史存档）

本节记录上一版 1.4.5 的公开结果、附件与签名；当前公开发行版本 1.4.6 的核验结果见上文。各版本的包只能对照同版本的校验表核对。

## 1.4.5 公开结果

| 项 | 值 |
|---|---|
| 标签 | `v1.4.5`（附注标签），指向发行提交 `f9241190` |
| 发布时间 | 2026-11-12 03:35（北京时间） |
| 发行页 | https://github.com/nanless/audio-paper-digest/releases/tag/v1.4.5 |
| 版本、构建号 | 两端均为 1.4.5 / 21（Android `versionName` 1.4.5、`versionCode` 21） |
| 附件 | 12 件：Mac 6 件（ZIP、DMG、`build-info.json`、`RELEASE_NOTES.md`、`release-manifest.json`、`SHA256SUMS`），Android 6 件（APK、`android-build-info.json`、`android-source-inputs.json`、`android-runtime-materials.json`、`android-release-manifest.json`、`ANDROID-SHA256SUMS`） |
| 匿名下载 | 发行页与 12 件附件未登录请求均返回 HTTP 200（2026-11-13 复核） |
| Android 签名 | 沿用 1.4.4 签名库，证书 SHA-256 `6a0c3138…`；1.4.4 用户可直接覆盖升级，1.4.3 用户仍需备份后卸载重装 |
| 人工验收 | 未重新执行 84/86 项人工矩阵；受影响项（Mac `APP-03`、`DATA-01`、`DATA-05`、`DATA-11`，Android `DATA-05`、`DATA-13`，两端 `APP-01`、`APP-09`、`REL-01`、`REL-02`、`REL-05`）只完成自动测试与包体层面覆盖 |

1.4.5 的改动与验证范围见 [1.4.5 记录](workbench-1.4.5-review.md)。

## 1.4.5 的十二件附件

以下字节与 SHA-256 于 2026-11-13 从公开 Release API 读取，并逐件下载复核；按 `SHA256SUMS` 与 `ANDROID-SHA256SUMS` 对照，下载得到的摘要与下表一致。两份校验表都不包含自身；`SHA256SUMS` 覆盖其余五件 Mac 资产（含 `release-manifest.json`），`ANDROID-SHA256SUMS` 覆盖 APK 与三份 Android 构建记录，不包含 `android-release-manifest.json`，核对时以表内条目为准。

| 平台 | 附件 | 字节 | SHA-256 |
|---|---|---:|---|
| Mac | `PaperDigest-macOS-1.4.5-arm64.dmg` | 57307256 | `27919a5016fafea3bf2c6f53f265a239c48711459708e3fbab1067fa90060985` |
| Mac | `PaperDigest-macOS-1.4.5-arm64.zip` | 48829736 | `a3f6eebd0b00706c2f7ef3e86069119ef33fe7845765bab9741a51f30aaeeb09` |
| Mac | `RELEASE_NOTES.md` | 2344 | `14e4f8ed85e0b6b1feabd5fc9c955810d291b0e33bdd2582e0fbd491b790c688` |
| Mac | `SHA256SUMS` | 453 | `3c5bb1acecc5555e85a5f9566675f6832edf3f6585d75374471b413d6253ae2c` |
| Mac | `build-info.json` | 1528 | `a28849ffde39a0a3d9eacca96f29dde3f83d1a4197a4c8acd70181b0c3ed3fab` |
| Mac | `release-manifest.json` | 687 | `68924ea789615d6618b00d59769e82c21bde070350d943874edf8200fcdcda5c` |
| Android | `paperdigest-android-1.4.5-21-universal.apk` | 75855430 | `a4e0573730b7dd10c868408bd70d69a7ff93258a08a726fa6b90812f7f620401` |
| Android | `ANDROID-SHA256SUMS` | 389 | `edf7e77cf48e5d62b0899d83605310bebcc2e61d3016f8f30f819443cb5ece02` |
| Android | `android-build-info.json` | 346102 | `a386749140fc709118d66ec9e4b7c64cd19a47cebd9dee6d4f6cb60a916a08f7` |
| Android | `android-source-inputs.json` | 194923 | `4cab650c464c8635efd2bbc2caf53493ce08e6277fd702f131075f5bf70f488b` |
| Android | `android-runtime-materials.json` | 31654 | `b22576b093c870d36e4f0d9b95eab83073a0f6a982dc845aa3591f1dd4b8160b` |
| Android | `android-release-manifest.json` | 591 | `eaec499d397337724d8e0bd272551d7babd89ef7579b03e50433b0d0d8bdcbb3` |

## 1.4.5 的签名

Mac 包使用本地 ad-hoc 签名，未经过 Apple 公证；`build-info.json` 记录 `sourceCommit` 与 `releaseHead` 均为 `f9241190cad0fdcf68a043263ae6268e7cf1c1c6`，版本 1.4.5 / 构建号 21、arm64，最低系统 macOS 15.0。ad-hoc 签名只证明包在打包后没有被改动，不提供 Apple 开发者身份。

公开 APK 沿用 1.4.4 的发布签名库。`android-build-info.json` 记录证书 SHA-256 为 `6a0c3138f9a49b01f868a123490a7e562f6d78d951160afb2ea5b1e44274e5bb`，`versionName` 1.4.5、`versionCode` 21、minSdk 28、targetSdk 37，应用标识 `com.nanless.paperdigest`，四种 ABI 齐全。签名方案与验证结果以该记录的 `signature` 字段和发行机器上 `apksigner verify` 的输出为准。已安装 1.4.4 的用户可以直接覆盖升级；1.4.3 的证书是 `d7c680d9…`，仍需先导出完整备份、卸载旧版再安装。

# 1.4.4 发行核验（历史存档）

本文记录 1.4.4 公开发行后的签名、附件和下载核验结果；1.4.3 的结论保留在“上一版”一节，供下一次发行对照。两版的附件、签名和证书分别登记，不能互相替代。发行操作本身见 [Mac 构建与发行](mac-app-release.md)，性能改动见[客户端性能](client-performance.md)。

## 存档说明

本节起为 1.4.4 与 1.4.3 的历史发行记录，当前公开发行版本 1.4.6 及上一版 1.4.5 的结果见上文。下文先登记 1.4.4 的公开结果、签名与附件，再保留 1.4.3 的签名对照、附件表和校验表；1.4.4 的包只能对照 1.4.4 的表，不能用 1.4.3 的字节或证书核验。

1.4.4 重新生成了 Android 发布签名库（1.4.3 使用的签名库不在本机，也没有可用备份），因此 1.4.4 的签名证书 SHA-256 为 `6a0c3138f9a49b01f868a123490a7e562f6d78d951160afb2ea5b1e44274e5bb`，与 1.4.3 的 `d7c680d9…` 不同。已安装 1.4.3 的 Android 用户不能覆盖升级，需要先导出完整备份、卸载旧版，再安装 1.4.4、恢复资料并重新配置设备凭据。签名库在仓库外以 `0600` 权限单独保存，口令保存在本机登录钥匙串的服务条目 `com.nanless.PaperDigest.android-release-signing.v1` 中；签名库、私钥和证书都需要单独备份。公开的 `android-build-info.json` 记录的证书 SHA-256 也是 `6a0c3138…`。

## 结论

1.4.4 已于 2026-11-05 公开，地址为 <https://github.com/nanless/audio-paper-digest/releases/tag/v1.4.4>。附注标签 `v1.4.4` 指向提交 `aecf5c25eeccabae0602316486168141d94a02e0`。Release 共十二件附件，Mac 六件、Android 六件；公开后未登录访问 Release 页面和每件附件均返回 HTTP 200，文件大小与两份校验表一致。Android 包用新签名库签发，证书 SHA-256 为 `6a0c3138f9a49b01f868a123490a7e562f6d78d951160afb2ea5b1e44274e5bb`，已安装 1.4.3 的用户需要卸载重装。

## 1.4.4 的十二件附件

以下字节与 SHA-256 于 2026-11-06 从公开 Release API 读取；下载的两份校验表与各自登记的同名条目逐一相符：`SHA256SUMS` 覆盖 Mac 的 DMG、ZIP、说明、构建记录与发行清单，`ANDROID-SHA256SUMS` 覆盖 APK 与三份 Android 构建记录。两份表都不包含自身；`android-release-manifest.json` 不在 `ANDROID-SHA256SUMS` 中。

| 平台 | 附件 | 字节 | SHA-256 |
|---|---|---:|---|
| Mac | `PaperDigest-macOS-1.4.4-arm64.dmg` | 56554309 | `dd0a7da9eb70a5e49a773d712b63ee7ea112724e3f1e8cfec945da159133a98d` |
| Mac | `PaperDigest-macOS-1.4.4-arm64.zip` | 48792265 | `445a0f878e4a826f66fe18dfe77bd30bf9d5e399f5b5ebf12a6f6701df653dff` |
| Mac | `RELEASE_NOTES.md` | 2105 | `72f08ad2d7bf3cbcad0ba94055066ba92f7394862b69e1b648615f80f76aad57` |
| Mac | `SHA256SUMS` | 453 | `2df937e118dfdba288e1934cda8b147ad91f332ae456120f4782ed6d2a0e1553` |
| Mac | `build-info.json` | 1528 | `74005efe9ec4f6b808dce6505c1aba2577b4d0ef530a2bf7e14bcf7be91b83b2` |
| Mac | `release-manifest.json` | 687 | `44e1542ffa25962946c497f3cefd7b7445a3fb59be083d8eac75579e3d91b7a0` |
| Android | `paperdigest-android-1.4.4-20-universal.apk` | 75855430 | `e366ce714739c6f81d5fce59d1933511576a84e045d6f31ff97c85ded7d2c45a` |
| Android | `ANDROID-SHA256SUMS` | 389 | `420309acf39915b9ae2cc09c80fa789b9d2921ae8bcd016a56b0cae85170e6d6` |
| Android | `android-build-info.json` | 346102 | `b9978aa5d320f8088a0444b8b926bd924ea1d554efb8178d30ef1bc0fcd8e9eb` |
| Android | `android-source-inputs.json` | 194743 | `ac32273018d2f3080a2d5282c2abcf98797bd641562b38941072efdfdbf557a1` |
| Android | `android-runtime-materials.json` | 31654 | `b22576b093c870d36e4f0d9b95eab83073a0f6a982dc845aa3591f1dd4b8160b` |
| Android | `android-release-manifest.json` | 591 | `0405979c66eaa4f11bb69c8f8e9745c23f652fe3df8fd42b009e19877d3925d4` |

## 1.4.4 的签名

Mac 包是本地 ad-hoc 签名。公开 ZIP 中的应用包经 `codesign -dv --verbose=4` 核对：标识 `com.nanless.PaperDigest`，格式为 arm64 的 Mach-O，签名 `adhoc`，`TeamIdentifier=not set`，CDHash `41bf313e955d3e95fcadc9fc0ca9398427dea737`。ad-hoc 签名只证明包在打包后没有被改动，不提供 Apple 开发者身份，也不能代替公证；换一台机器重建会得到不同的 CDHash，版本来源以 `build-info.json`、附注标签和 ZIP/DMG 校验值为准。

公开 APK 用新签名库签发，经 `apksigner verify --print-certs` 核对：

```text
Signer #1 certificate DN: CN=Paper Digest, OU=Release, O=nanless, L=Shanghai, ST=Shanghai, C=CN
Signer #1 certificate SHA-256 digest: 6a0c3138f9a49b01f868a123490a7e562f6d78d951160afb2ea5b1e44274e5bb
Signer #1 certificate SHA-1 digest: de65bb1ed6ba93137e36e75eab18d4d2ca1da67b
```

签名验证通过，实际使用 v3 方案；`apksigner verify --verbose` 对 v1、v2、v3.1、v4 均返回 false。APK 的身份为 `com.nanless.paperdigest`、versionName `1.4.4`、versionCode `20`、minSdk 28、targetSdk 37，四种 ABI（`armeabi-v7a`、`arm64-v8a`、`x86`、`x86_64`）齐全，原生库按 16 KiB 对齐。证书 DN 与 1.4.3 的 `CN=PaperDigest` 不同，这是换签名库的直接结果。

## 证书与钥匙串

Android 正式签名库、私钥和证书在仓库外单独保存，签名库文件权限为 `0600`、父目录为 `0700`，且不能位于仓库内。签名入口要求终端交互，运行时提示输入签名库密码和密钥密码，不把口令放进命令行参数、环境文件或发布附件。

签名口令保存在本机登录钥匙串的服务 `com.nanless.PaperDigest.android-release-signing.v1` 中；1.4.4 重新生成签名库后仍使用同一服务条目。**钥匙串条目只存口令**，不存签名库、私钥或证书；删除或更换钥匙串条目不影响已发布 APK 的验证，但会让下一次签名无法取到口令。签名库和私钥需要单独备份，不能只依赖钥匙串。

Mac 包没有对应的发行证书或私钥。构建使用 ad-hoc 签名，签名身份由包内代码目录的 CDHash 表示；换一台机器重建会得到不同的 CDHash，因此发布记录以构建记录、来源提交和 ZIP/DMG 校验值为准。

## 上一版 1.4.3

2026-11-05 公开，地址为 <https://github.com/nanless/audio-paper-digest/releases/tag/v1.4.3>；附注标签 `v1.4.3` 的对象为 `975a9a2334e4b81294897fafae6c5e7412460a98`，指向提交 `47c30d98c323f56e988215fe5148e59aa6fa8a56`。Release 共十二件附件，公开后未登录访问 Release 页面和每件附件均返回 HTTP 200，文件大小与两份校验表一致。以下保留该版的签名对照、两种包的实际核对输出、附件表和校验表。

### 两端签名对照

下表逐项记录 1.4.3 的核对结果。1.4.4 的应用标识与签名方式不变，但 Android 证书换成 `6a0c3138…`，所以 1.4.3 不能覆盖升级到 1.4.4。

| 项目 | Mac | Android |
|---|---|---|
| 版本、构建号 | 1.4.3、19 | 1.4.3、19（versionCode 19） |
| 应用标识 | `com.nanless.PaperDigest` | `com.nanless.paperdigest` |
| 签名方式 | 本地 ad-hoc 签名 | `apksigner` 签名，APK Signature Scheme v3 |
| 可核对身份 | 无签名证书；`codesign` 显示 `Signature=adhoc`、`TeamIdentifier=not set` | 证书 DN `CN=PaperDigest`，SHA-256 见下 |
| 公证或商店 | 未通过 Apple 公证 | 未通过 Google Play 分发 |
| 覆盖升级 | 同标识、同资料目录；旧包不自动删除 | 同标识、同证书且 versionCode 递增时覆盖升级 |

公开 ZIP 中的应用包经 `codesign -dv --verbose=4` 核对：标识 `com.nanless.PaperDigest`，格式为 arm64 的 Mach-O，签名 `adhoc`，CDHash `c9be63ab9be06c4bf37435a88eebc81e5447a07f`，没有 TeamIdentifier。ad-hoc 签名只证明包在打包后没有被改动，不提供 Apple 开发者身份，也不能代替公证。

公开 APK 经 `apksigner verify --print-certs` 核对：

```text
Signer #1 certificate DN: CN=PaperDigest
Signer #1 certificate SHA-256 digest: d7c680d9225c5b90ba960bf6c890f84d702c7bcc9a166951b56d01af08c40e00
Signer #1 certificate SHA-1 digest: 208f7e44c00650750bd65e22fd786830492d840c
```

签名验证通过，实际使用 v3 方案，v1、v2、v4 未用于该包；minSdk 28 对应 Android 9，支持 v3 验证。APK 的身份为 `com.nanless.paperdigest`、versionName `1.4.3`、versionCode `19`、minSdk 28、targetSdk 37，四种 ABI 齐全。

### 十二件附件

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

### 两份校验表

Mac 的 `SHA256SUMS`：

```text
d5cf9a76140c7f98d4ce540338bac9d966cc1018dd33ccbdad7ee9338dea3589  PaperDigest-macOS-1.4.3-arm64.dmg
a78973cc6963561c8680fb74d8e6c91ecb3b5890af97afa2c8aa769688e3c3a6  PaperDigest-macOS-1.4.3-arm64.zip
4c726b6d4e1c40cdef8426645019937178f928144a9f0bfd891c3f4744346e92  RELEASE_NOTES.md
4cc4a2bca50a3f89bfe2625c59861ec1d49b03b6904f1ffcf0ee9e34a52be30e  build-info.json
1d28df674108f19056ddd6285eb9e2c9f3beff1bc8a290858075ce8cf9d47456  release-manifest.json
```

Android 的 `ANDROID-SHA256SUMS`：

```text
4c13d5b9660cbab455cdeae3c57ac63f429468c7a50d69821badc89729b806c2  android-build-info.json
b22576c093c870d36e4f0d9b95eab83073a0f6a982dc845aa3591f1dd4b8160b  android-runtime-materials.json
a426a79a54a7cb48148190958560a8d5bebd6c88f2650e5b8069db44485ebdaa  android-source-inputs.json
8e30aad95e32483338b2b3d3cf10b103974ae9506cb0caea5569d94bacf72d1d  paperdigest-android-1.4.3-19-universal.apk
```

两份表都不包含自身。`SHA256SUMS` 包含 `release-manifest.json`，但不包含 `SHA256SUMS` 自身、Android 附件和 `android-release-manifest.json`。`ANDROID-SHA256SUMS` 不包含 `ANDROID-SHA256SUMS` 自身和 `android-release-manifest.json`。两个 manifest 各登记四个资产，也不包含清单自身与校验表。核对时以表内条目为准，不要假设一张表覆盖全部十二件。

## 匿名下载核验

1.4.4 公开后，用不带登录 Cookie 和认证头的请求逐个访问 Release 页面与十二件附件。Release 页面和各下载地址均返回 HTTP 200；`github.com` 的下载地址会重定向到 `release-assets.githubusercontent.com`，重定向后的响应仍为 200。2026-11-06 重新下载全部十二件附件，字节数与上表一致，SHA-256 也逐件相符；`SHA256SUMS` 与 `ANDROID-SHA256SUMS` 的每一行都在对应资产上复现。

1.4.3 在 2026-11-05 公开后按同一方法核对，Release 页面与十二件附件均返回 HTTP 200，文件大小与两份校验表一致，实际下载的 APK、ZIP、两份校验表和构建记录经 SHA-256 复核也与该版上表一致。

```sh
curl -sS -L -o /dev/null -w '%{http_code} %{size_download}\n' \
  https://github.com/nanless/audio-paper-digest/releases/download/v1.4.4/SHA256SUMS
```

核验下载件时，先核对对应版本校验表自身的大小和 SHA，再用它核对同平台资产。不要只核对 Release 页面显示的文件大小；服务端对象存储和重定向都可能让“页面能打开”与“字节正确”成为两件事。

## 草稿到公开的顺序

1. 固定发行提交和附注标签，确认标签对象指向的提交就是两端构建使用的来源提交。
2. Mac 执行 `inspect → prepare → verify`；Android 执行 `prepare → sign → verify`。两端包体、版本、架构或 ABI、签名和来源必须一致。
3. 用同一份已核验产物生成 `joint-private-draft-plan`，人工复核后创建私有草稿，保存实际 Release ID。
4. 按资产 ID 从草稿下载全部附件，用 `verify-downloaded` 逐件核对大小和 SHA；完成 Mac 的 `REL-03`、`REL-04` 与 Android 的 `A-REL-03`、`A-REL-04` 草稿侧记录。
5. 用同一固定输入和同一草稿 ID 生成 `joint-public-plan`，人工复核后公开。
6. 公开后重新匿名核对 Release 页面、标签、草稿未变和全部附件；晚到的验收记录在公开后单独提交，不回头改已固定资产。

生成公开参数只说明检查通过，不会自动创建、上传或公开。中途换包、换标签或换草稿 ID 都要从第 1 步重新核对，不能把旧参数套到新资产上。

## 轮换与失效注意

- **Android 签名证书不能静默更换。** 同包名更换证书后，旧版本无法直接覆盖升级；用户需要先导出完整备份，再卸载旧版并安装新包，恢复资料后重新配置设备凭据。若不想要求用户卸载，只能更换包名。发行记录必须保留旧证书 SHA-256 和最后一次覆盖升级范围。1.4.4 已经发生一次这样的更换：1.4.3 的证书 `d7c680d9…` 与 1.4.4 的 `6a0c3138…` 不同，1.4.3 用户必须卸载重装。
- **钥匙串只保存口令。** 更换签名库密码时更新 `com.nanless.PaperDigest.android-release-signing.v1` 条目并重新签名；签名库、私钥和证书要单独备份。不要把口令写进仓库、脚本参数、环境文件或发布说明。
- **Mac ad-hoc 签名没有稳定身份。** 每次重建的 CDHash 可能不同，不能靠 CDHash 判断两个版本是否同一来源；应核对来源提交、构建记录和 ZIP/DMG 校验值。以后若改用 Apple 开发者签名或公证，属于新的分发条件，需要重新说明安装步骤和系统提示。
- **标签和附件一经公开不再改写。** 发现错误时发布新版本，不移动旧标签、不覆盖同 ID 资产，也不在原 UUID 或 Release 下替换字节。
- **`publicationEligible: false` 是工具默认标记。** Mac 的 `inspect`、`prepare`、`verify` 和 Android 的 `prepare`、`sign`、`finalize-signed`、`verify` 输出都会带这个字段，表示该输出只是本地候选包，不是公开结论，也不代表失败。公开状态以 Release 页面、标签和匿名下载核验为准，不能把该字段手工改成 `true` 当作发布结论。
