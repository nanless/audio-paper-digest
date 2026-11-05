# 工作台 1.4.2 导读上下文声明修复

Mac 和 Android 的源码版本均为 1.4.2，构建号均为 18。1.4.2 修复打开 2026 年 11 月 3 日、4 日论文导读时的“当前上下文文件的结构声明无效”。

## 问题现象与根因

用户在 Mac 上打开 11 月 3 日任一篇论文，报错“导读暂未载入 / 当前上下文文件的结构声明无效”。原因不在论文页面本身，而在页面内嵌的客户端资料声明：`rethink-context.json` 的记录里，`schemaFingerprint` 被写成了小写 `schemafingerprint`。

Hugo 会把 front matter 解析成参数 map，并把嵌套 map 的键递归小写。博客模板对 `.Params.paper_digest_sidecars` 直接 `jsonify`，小写键因此进入页面。11 月 2 日及更早页面使用旧的 workbench 契约，不输出这段声明，所以没有暴露；11 月 3 日起换用当前契约才开始输出。附属文件 `client/papers/.../rethink-context.json` 本身的键是正确的，只有页面声明出错。

## 网站模板的修复

博客模板改为按白名单逐字段重建声明，不再直接序列化参数 map：

- `layouts/partials/client_sidecars.html` 重建四个文件记录，上下文记录写回 `contract` 与 `schemaFingerprint`，并用 `protocol_header_valid.html` 校验头。
- `paper_toolbar.html` 与 `layouts/_default/index.json` 共用这份重建结果；索引侧按站点前缀和发布日期核对目录，不再接受任意来源地址。
- `scripts/verify-build.js` 在构建后解析这段声明，检查四个文件齐全、地址同目录、SHA 与实际文件一致、上下文头含 `schemaFingerprint` 且不含小写变体。
- `tests/paper-toolbar.test.js` 用真实 Hugo 构建并解析产物，断言键名与键集合。

模板改动提交后，博客构建会按新模板重新生成页面字节。已发布的 11 月 3 日、4 日页面在重新构建和部署完成后，旧版客户端也能正常打开导读；这部分按博客的构建、部署和逐页核验流程执行。

## 客户端的兼容

已安装的 1.4.1 在网站修复部署前仍会报错，因此 1.4.2 同时接受 11 月 3 日、4 日页面的唯一已知别名：声明里只有小写 `schemafingerprint` 时，客户端把它归一到 `schemaFingerprint` 再走原有严格校验；两个键同时存在且值不同则拒绝。Mac 与 Android 使用同一规则，其他字段、目录、SHA 和历史格式的校验不变。

Android 此前遇到同一写法会静默跳过导读上下文，1.4.2 按正常资料读取。

## 发行状态

Mac 1.4.2 已按发行流程构建、检查并打包：`PaperDigest-macOS-1.4.2-arm64.zip`、同名 DMG 与六件发布材料通过 `prepare` 与 `verify`，源码提交 `328981ab`，标签 `v1.4.2` 指向该提交。GitHub 上已创建 1.4.2 草稿 Release，下载附件后按 `SHA256SUMS` 复核通过；尚未公开。

Android 1.4.2 的源码与 Mac 同期升级，正式 APK 仍需在本机用发行签名库签名，签名口令只能由维护者手动输入；公开前还须完成 69 项适用验收和云端/发行 17 项记录。草稿 Release 当前只含 Mac 附件，公开与补入 Android 附件按这两项的实际完成情况处理。

## 验证

- Mac：`PublicProtocolEndpointsTests` 覆盖小写别名通过、小写错指纹拒绝、驼峰与小写冲突拒绝，并断言不是回退到旧缓存。
- Android：`PublishedCitationRepositoryTest` 覆盖同一组正反例。
- 博客：`tests/paper-toolbar.test.js` 12 项通过，包含产物 JSON 键名断言；构建校验在产物上检查声明与实际文件 SHA。
- 版本升级后两端构建测试与发行材料按当次运行结果登记，未完成的实测项目如实保留为待办。

## 后续

1.4.2 的草稿状态只属于 1.4.2。1.4.3 已于 2026-11-05 公开发布，两端版本与构建号为 1.4.3、19，标签 `v1.4.3` 指向提交 `47c30d98`；实际发行状态见 [1.4.3 记录](workbench-1.4.3-review.md#发行状态)。
