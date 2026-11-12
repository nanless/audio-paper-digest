# 工作台 1.4.5 发版记录

[English](README.en.md) · 返回[文档索引](README.md)

版本 1.4.5（构建号 21）修复两个已发布版本里存在的问题，并修好了让测试静默少跑一半的脚本缺陷。1.4.5 已于 2026-11-12 公开发布：附注标签 `v1.4.5` 指向发行提交 `f9241190`，Release 含 12 件附件；签名、附件与匿名下载核验见[客户端发行核验](client-release-verification.md)。

## 修了什么

- **Android 前台重复整站同步**：应用回到前台时会重复触发一次完整目录同步，已在 `16e62152` 修好，1.4.4 的公开包里仍带这个问题。
- **macOS 目录 JSON 损坏崩溃**：本地目录文件损坏时启动解码直接崩溃，改为进入可恢复的失败状态，`library.retryLoad` 与 `library.sync` 仍可执行，同步成功后清除失败状态。
- **`apps/macos/test.sh` 提前退出**：`NativeLibraryAccessibility` 套件返回 0 时脚本执行 `exit 0`，导致 57 个套件只跑 27 个、node 与 python 段整段跳过；现在只有 77 记为跳过，其它非零状态才终止。

## 版本与验证

- macOS `CFBundleShortVersionString` 1.4.5、`CFBundleVersion` 21；Android `versionName` 1.4.5、`versionCode` 21。两端版本一致。
- macOS 全量：57/57 个 Swift 套件执行完成（1 个环境跳过），node/python 全部通过，0 失败。
- Android 全量：11 个发行与签名检查、AssetsChannel 17 项负例、126 个测试类共 937 个用例、`lintDebug` 与 `assembleDebug` 全部通过。
- `node --test tests/documentation.test.js` 与 `node scripts/docs-consistency.js` 通过。

## 发行结果

- 发布时间：2026-11-12 03:35（北京时间）。
- 标签与提交：附注标签 `v1.4.5`，标签对象指向提交 `f9241190`。
- 附件：12 件，Mac 6 件（DMG、ZIP、`RELEASE_NOTES.md`、`build-info.json`、`release-manifest.json`、`SHA256SUMS`），Android 6 件（APK、`android-build-info.json`、`android-source-inputs.json`、`android-runtime-materials.json`、`android-release-manifest.json`、`ANDROID-SHA256SUMS`）。逐件名称、字节与 SHA-256 见[客户端发行核验](client-release-verification.md)。
- Android 签名：沿用 1.4.4 的发布签名库，证书 SHA-256 为 `6a0c3138…`；已安装 1.4.4 的用户可以直接覆盖升级，1.4.3 用户仍需先导出备份、卸载旧版再安装。
- 人工验收：没有重新执行 84/86 项人工矩阵；受影响项（Mac `APP-03`、`DATA-01`、`DATA-05`、`DATA-11`，Android `DATA-05`、`DATA-13`，两端 `APP-01`、`APP-09`、`REL-01`、`REL-02`、`REL-05`）只完成自动测试与包体层面覆盖。

## 发行范围与遗留

`mac-app-release.md` 要求在公开前完成 86 项验收；1.4.5 实际没有重新执行 84/86 项人工矩阵，只在自动测试与包体层面覆盖上节列出的受影响项。1.4.3 与 1.4.4 同样没有重做其中的 69 项图形验收，安装、图形首启、旧资料升级和业务操作的最新完整范围仍属 1.3.0，见[1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)。最终字节已随 `f9241190` 提交，标签、12 件附件与公开状态已按发行流程完成。
