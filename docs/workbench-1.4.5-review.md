# 工作台 1.4.5 发版记录

[English](README.en.md) · 返回[文档索引](README.md)

版本 1.4.5（构建号 21）修复两个已发布版本里存在的问题，并修好了让测试静默少跑一半的脚本缺陷。本次只准备发版材料，**未建标签、未上传附件、未发布 Release**。

## 修了什么

- **Android 前台重复整站同步**：应用回到前台时会重复触发一次完整目录同步，已在 `16e62152` 修好，1.4.4 的公开包里仍带这个问题。
- **macOS 目录 JSON 损坏崩溃**：本地目录文件损坏时启动解码直接崩溃，改为进入可恢复的失败状态，`library.retryLoad` 与 `library.sync` 仍可执行，同步成功后清除失败状态。
- **`apps/macos/test.sh` 提前退出**：`NativeLibraryAccessibility` 套件返回 0 时脚本执行 `exit 0`，导致 57 个套件只跑 27 个、node 与 python 段整段跳过；现在只有 77 记为跳过，其它非零状态才终止。

## 版本与验证

- macOS `CFBundleShortVersionString` 1.4.5、`CFBundleVersion` 21；Android `versionName` 1.4.5、`versionCode` 21。两端版本一致。
- macOS 全量：57/57 个 Swift 套件执行完成（1 个环境跳过），node/python 全部通过，0 失败。
- Android 全量：11 个发行与签名检查、AssetsChannel 17 项负例、126 个测试类共 937 个用例、`lintDebug` 与 `assembleDebug` 全部通过。
- `node --test tests/documentation.test.js` 与 `node scripts/docs-consistency.js` 通过。

## 发布前还要做的事

1. 提交最终字节：发版工具按设计拒绝在有未提交修改的工作区准备发行产物。
2. 补做人工验收：`mac-app-release.md` 要求在公开前完成 86 项验收，1.4.3 与 1.4.4 都没有重做其中的 69 项图形验收。
3. 由用户确认后再建标签、上传 12 件附件并发布。
