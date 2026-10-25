# Android 离线开源许可资料

`licenses/` 保存本次实际运行依赖及其字体、数据和来源的离线许可资料。它不是个人研究资料，不含本机缓存路径、账号或凭据。应用内入口和正式安装包的接入、逐字节核对另行验收；资料存在不表示 APK 或 GitHub Release 已通过。

从 `licenses/index.html` 查看目录，再打开单项全文。完整对应关系在 `manifest.json`，小型界面索引在 `index.json`；原始文本位于 `texts/`，阅读页不会请求网络或执行脚本。保持原始文本、版权声明、年份及换行，不在许可原文中整理措辞。

本次 `releaseRuntimeClasspath` 有 123 条解析记录、120 个唯一物料，重复的三条记录保留。清单另绑定 KaTeX 字体、PDFBox 资源和公共后缀数据。`manifest.json` 的来源字段分别说明缓存原字节、官方获取记录、源码头部和必要抽取；公开来源地址不等于本轮重新抓取。未检查的上游材料不授予完成。

固定材料身份如下：

- `manifest.json` SHA-256：`b00a26f828bf9ddbca32caa2078ec75ffc3b1d04b281812dcfd6c0d2c788ac9d`。
- `bundle-files.json` SHA-256：`b112c4d21a03940be8b52b470412ee7e390d1b0c3985c8215e9cb623f8dcecf4`；共 632 个文件，清单自身由此处和构建代码的固定值约束。
- 规范化运行物料多重集 SHA-256：`56423d42321b81dc83f6ff384b728d1b29e0ebe326e05faf5a5ec2980c392d3f`；字段、排序和重复规则见 `manifest.json` 的 `runtimeMaterialFingerprint`。

更换依赖版本、二进制、字体或数据后，应重新核对实际材料与来源，不能仅改清单的自报摘要。新增或缺失文件也需重新检查；不要把调查目录、原缓存归档或个人资料加入此目录。
