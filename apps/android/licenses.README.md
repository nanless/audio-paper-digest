# Android 离线开源许可资料

应用内“开源许可”页面提供运行依赖、字体、数据及其来源说明，可离线阅读。[许可目录](<licenses/index.html>)列出各项全文；[完整清单](<licenses/manifest.json>)记录材料与来源，[界面索引](<licenses/index.json>)供应用展示，原文保存在 `licenses/texts/`。阅读页不联网、不执行脚本。

当前 `releaseRuntimeClasspath` 包含 123 条解析记录、120 个唯一物料，重复的三条记录保留。清单还绑定 KaTeX 字体、PDFBox 资源和公共后缀数据。来源字段分别记录缓存原字节、官方获取记录、源码头部和必要抽取；来源 URL 用于追溯材料。

## 固定材料

构建时核对实际运行依赖、完整文件集合、每份文件的大小与 SHA-256。固定值与[资源准备代码](<prepare-assets.mjs>)一致：

| 材料 | SHA-256 |
|---|---|
| [manifest.json](<licenses/manifest.json>) | `b00a26f828bf9ddbca32caa2078ec75ffc3b1d04b281812dcfd6c0d2c788ac9d` |
| [bundle-files.json](<licenses/bundle-files.json>) | `b112c4d21a03940be8b52b470412ee7e390d1b0c3985c8215e9cb623f8dcecf4` |
| 规范化运行物料多重集 | `56423d42321b81dc83f6ff384b728d1b29e0ebe326e05faf5a5ec2980c392d3f` |

许可目录共 632 个文件。文件清单本身由构建代码中的固定值约束；运行物料的字段、排序和重复规则见完整清单的 `runtimeMaterialFingerprint`。

## 更新规则

- 原始许可全文、版权署名、年份、URL 与换行保持原样；客户端改名只更新应用的显示文字。
- 依赖版本、二进制、字体或数据变化后，重新核对实际物料和授权来源，再更新受审材料与构建固定值。仅重算清单自己的摘要不足以确认新材料。
- 新增、缺失或修改任何文件都会触发核验。调查记录、缓存归档和个人资料不放入许可目录。

正式 APK 的资源与许可核验范围见[Android 验证说明](<../../docs/android-validation.md>)。
