# 工作台 1.4.3 性能优化

Mac 和 Android 的源码版本均为 1.4.3，构建号均为 19。1.4.3 不改变内容生产与来源规则，集中处理两端打开、启动与同步时的重复工作。

## 目录与启动

Mac 的目录列表改为紧凑投影：列表不再逐篇携带完整 citation 与官网分类记录，改为按快照加载分类证据、打开论文时按 id 取完整行；列表行直接构造，不再逐篇编码再解码。大目录的解码移到后台，界面先显示 loading，就绪后自行刷新；载入失败后由命令级 `library.retryLoad` 显式重试，界面上的“重新读取本机目录”按钮已接入该命令；其他命令不会因失败反复触发全量读取。

Android 启动改用轻量离线索引，只读取小索引并核对文件集合、大小与时间；索引缺失或损坏时回退一次全扫重建。导读与指针保存时原子更新索引，坏指针保留为负条目，避免每次启动反复全扫。

## 导读与汇总解析

Mac 的 Markdown 只清洗一次，导读直接复用已清洗节点挂载，不再对序列化结果二次解析；链接重写、CSP 与 sandbox 契约不变。

Android 打开导读时按页面 SHA 缓存一次整页解析与重放结果，绑定前仍核对字节、身份与修订；汇总页一次解析同时产出文档与图片计划素材，文本提取不再复制整棵 DOM，命中缓存时仍复核原始字节。

## 同步与桥接

Mac 同步把已核验分片传给汇总暂存，省掉重复读取与解析，仍执行清单、字节、SHA 与记录数校验；分片总量超过 16 MiB 时回落到逐片读取。前端新增批量个人保存，一次提交笔记、批注与阅读位置；只有宿主明确不支持时才逐项降级。PDF 几何上报按动画帧合并并节流，可见性变化立即发送，失败后允许重发。

## 验证与发行

Mac 全套件、Android 全量单元测试与 lint 均通过，两端安装包完成包体校验。1.4.3 没有重新执行 69 项人工图形验收，也未新增实体机或完整辅助功能遍历；这些项目沿用原版本的通过记录和限制，不能写成本轮重新完成。

## 发行状态

1.4.3 已于 2026-11-05 公开发布，地址为 [v1.4.3](https://github.com/nanless/audio-paper-digest/releases/tag/v1.4.3)，标签 `v1.4.3` 指向提交 `47c30d98`。Release 含十二件附件：Mac 的 ZIP、DMG、RELEASE_NOTES、SHA256SUMS、build-info 与 release-manifest，Android 的正式签名 APK、ANDROID-SHA256SUMS、android-build-info、android-source-inputs、android-runtime-materials 与 android-release-manifest。

Android 签名使用项目发行签名库，公开 APK 的证书 SHA-256 为 `d7c680d9225c5b90ba960bf6c890f84d702c7bcc9a166951b56d01af08c40e00`，`apksigner verify` 通过，签名方案为 v3。签名口令保存在本机登录钥匙串的 `com.nanless.PaperDigest.android-release-signing.v1` 条目中；钥匙串只存口令，签名库和私钥在仓库外单独保存，口令没有写入仓库或发布材料。签名入口仍然要求终端交互，本次通过本机钥匙串提供口令完成。

1.4.4 重新生成了 Android 发布签名库，证书 SHA-256 为 `6a0c3138f9a49b01f868a123490a7e562f6d78d951160afb2ea5b1e44274e5bb`，与本版不同。已安装 1.4.3 的 Android 用户不能覆盖升级，需要先导出完整备份、卸载旧版，再安装 1.4.4 并恢复资料。两版的签名、附件与证书分别登记在[客户端发行核验](client-release-verification.md)，不能互相替代。

发布前已重新下载十二件附件，Mac 按 `SHA256SUMS`、Android 按 `ANDROID-SHA256SUMS` 复核通过；匿名访问 Release 页面与各附件均为 HTTP 200，文件大小与本地产物一致。签名对照、附件表与核验步骤见[客户端发行核验](client-release-verification.md)，性能改动的前后数据见[客户端性能](client-performance.md)。
