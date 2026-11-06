# 客户端发行核验（1.4.4）

本文记录 1.4.4 公开发行后的签名、附件和下载核验结果；1.4.3 的结论保留在“上一版”一节，供下一次发行对照。两版的附件、签名和证书分别登记，不能互相替代。发行操作本身见 [Mac 构建与发行](mac-app-release.md)，性能改动见[客户端性能](client-performance.md)。

## 当前版本

当前源码版本为 1.4.4（构建号 20），改动与验证范围见 [1.4.4 记录](workbench-1.4.4-review.md)。下文先登记 1.4.4 的公开结果、签名与附件，再保留 1.4.3 的签名对照、附件表和校验表；1.4.4 的包只能对照 1.4.4 的表，不能用 1.4.3 的字节或证书核验。

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

## 两端签名对照（1.4.3）

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

## 证书与钥匙串

Android 正式签名库、私钥和证书在仓库外单独保存，签名库文件权限为 `0600`、父目录为 `0700`，且不能位于仓库内。签名入口要求终端交互，运行时提示输入签名库密码和密钥密码，不把口令放进命令行参数、环境文件或发布附件。

1.4.3 的签名口令保存在本机登录钥匙串的服务 `com.nanless.PaperDigest.android-release-signing.v1` 中。1.4.4 重新生成签名库后，口令仍保存在同一服务条目中。**钥匙串条目只存口令**，不存签名库、私钥或证书；删除或更换钥匙串条目不影响已发布 APK 的验证，但会让下一次签名无法取到口令。签名库和私钥需要单独备份，不能只依赖钥匙串。

Mac 包没有对应的发行证书或私钥。构建使用 ad-hoc 签名，签名身份由包内代码目录的 CDHash 表示；换一台机器重建会得到不同的 CDHash，因此发布记录以构建记录、来源提交和 ZIP/DMG 校验值为准。

## 1.4.3 的十二件附件

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

## 1.4.3 的两份校验表

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

1.4.3 公开后，用不带登录 Cookie 和认证头的请求逐个访问 Release 页面与十二件附件。Release 页面和各下载地址均返回 HTTP 200；`github.com` 的下载地址会重定向到 `release-assets.githubusercontent.com`，重定向后的响应仍为 200。GitHub 记录的十二件附件大小与上表一致；实际下载的 APK、ZIP、两份校验表和构建记录经 SHA-256 复核，也与上表一致。1.4.4 公开后按同一方法逐件核对，结果见上文结论；2026-11-06 复查 Release 页面与 `SHA256SUMS` 仍返回 HTTP 200。

```sh
curl -sS -L -o /dev/null -w '%{http_code} %{size_download}\n' \
  https://github.com/nanless/audio-paper-digest/releases/download/v1.4.4/SHA256SUMS
```

核验下载件时，先核对对应版本校验表自身的大小和 SHA，再用它核对同平台资产。不要只核对 Release 页面显示的文件大小；服务端对象存储和重定向都可能让“页面能打开”与“字节正确”成为两件事。

## 草稿到公开的顺序

1. 固定发行提交和附注标签，确认标签对象指向的提交就是两端构建使用的来源提交。
2. Mac 执行 `inspect → prepare → verify`；Android 执行 `prepare → sign → verify`。两端包体、版本、架构或 ABI、签名和来源必须一致。
3. 用同一份已核验产物生成 `joint-private-draft-plan`，人工复核后创建私有草稿，保存实际 Release ID。
4. 按资产 ID 从草稿下载全部附件，用 `verify-downloaded` 逐件核对大小和 SHA；完成 `REL-03`、`REL-04` 的草稿侧记录。
5. 用同一固定输入和同一草稿 ID 生成 `joint-public-plan`，人工复核后公开。
6. 公开后重新匿名核对 Release 页面、标签、草稿未变和全部附件；晚到的验收记录在公开后单独提交，不回头改已固定资产。

生成公开参数只说明检查通过，不会自动创建、上传或公开。中途换包、换标签或换草稿 ID 都要从第 1 步重新核对，不能把旧参数套到新资产上。

## 轮换与失效注意

- **Android 签名证书不能静默更换。** 同包名更换证书后，旧版本无法直接覆盖升级；用户需要先导出完整备份，再卸载旧版并安装新包，恢复资料后重新配置设备凭据。若不想要求用户卸载，只能更换包名。发行记录必须保留旧证书 SHA-256 和最后一次覆盖升级范围。1.4.4 已经发生一次这样的更换：1.4.3 的证书 `d7c680d9…` 与 1.4.4 的 `6a0c3138…` 不同，1.4.3 用户必须卸载重装。
- **钥匙串只保存口令。** 更换签名库密码时更新 `com.nanless.PaperDigest.android-release-signing.v1` 条目并重新签名；签名库、私钥和证书要单独备份。不要把口令写进仓库、脚本参数、环境文件或发布说明。
- **Mac ad-hoc 签名没有稳定身份。** 每次重建的 CDHash 可能不同，不能靠 CDHash 判断两个版本是否同一来源；应核对来源提交、构建记录和 ZIP/DMG 校验值。以后若改用 Apple 开发者签名或公证，属于新的分发条件，需要重新说明安装步骤和系统提示。
- **标签和附件一经公开不再改写。** 发现错误时发布新版本，不移动旧标签、不覆盖同 ID 资产，也不在原 UUID 或 Release 下替换字节。
- **`publicationEligible: false` 是工具默认标记。** Mac 的 `inspect`、`prepare`、`verify` 和 Android 的 `prepare`、`sign`、`finalize-signed`、`verify` 输出都会带这个字段，表示该输出只是本地候选包，不是公开结论，也不代表失败。公开状态以 Release 页面、标签和匿名下载核验为准，不能把该字段手工改成 `true` 当作发布结论。
