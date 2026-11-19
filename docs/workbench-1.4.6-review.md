# 工作台 1.4.6 发版准备记录

[English](README.en.md) · 返回[文档索引](README.md)

当前源码将 Mac 与 Android 工作台统一准备为 **1.4.6（构建号 22）**。本次提交仅准备源码版本号、随包离线许可元数据、发版说明分支与配套文档，**尚未建立 `v1.4.6` 标签、尚未上传安装附件、尚未公开发布 Release**；当前已公开发行的安装包仍为 1.4.5 / 构建号 21（来源提交 `f9241190`，2026-11-12 发布），其签名、十二件附件与匿名下载核验见[客户端发行核验](client-release-verification.md)。

## 1.4.5 之后的客户端改动

1. **`client/details/manifest.json` 静态详情快照与跨端见证双向冷核恢复**（提交 `dcdc1da2`、`34df0949`、`9f200d75`、`cc1d51e8`）：两端同步时优先读取网站的 `client/details/manifest.json` 快照清单，以及按文件字节 SHA-256 内容指纹寻址的目录分片、删除记录分片、单篇详情 JSON 与 HTML 导读片段。只有服务器对该入口明确返回 HTTP 404 或 410（站点尚未部署该出口）时，才按过渡路径回退至 `client/index.json` 及原 `index.json`；一旦入口已存在但返回格式损坏、结构指纹不匹配、字节数或 SHA-256 不符、网络错误或 HTTP 5xx，客户端直接拒绝并保留本机上一份完整快照与已核验资料，不静默回退旧接口。跨端便携备份补齐对称恢复：当目的端缺少本端活跃状态文件时，从备份携带的另一端桌面详情状态见证与不可变分片重读原文件、逐字节核对长度与 SHA-256 后重建本地索引；若本端已有任一状态文件（含损坏文件或符号链接），仍直接拒绝，不静默覆盖。
2. **WebDAV 笔记冲突卡片、无损合并与核心控制器解耦**（提交 `6d28e178`、`17127ba2`、`126876e3`）：在不改动 WebDAV 远端线协议的前提下，为多设备并发修改的论文笔记补齐阅读页冲突对比卡片与 `NoteConflictMerger`，支持“保留本机”“采用远端”“合并保存”三种无损处理方式，并将原冲突副本归档保留。保存路径执行写入前核对原内容的双重 CAS（Compare-And-Swap）并发保护，同时比对基础修订号（`baseRevision`）与原稿文本，防止处理冲突期间覆盖较新编辑，并维持单篇 2 MiB、全库 32 MiB 容量上限与失败回滚。同批将 Mac `LibraryService` 拆分为图片传输、紧凑投影与正文提取子模块，将 Android `RootController` 拆分为六个职责独立的协调器，并将 `apps/macos/test.sh` 改为共享核心模块单次预编译与并行链接。
3. **全站真实导出语料对齐、SVG 白名单加固与 `client-macos` CI 恢复**（提交 `65b266cd`、`2ec17f0a`）：基于全站真实导出语料（9225 页导读片段、8863 篇去重论文）重放双端正文与详情核验。修复历史与会议文章正文及图片 `alt`/`title` 属性中合法 UTF-8 替换符 `U+FFFD` 被误拒的问题，同时拒绝含空字符、代理对或越界码点的非法数值字符实体，并在 URL、`style`、`xmlns` 与 SVG 中继续拒绝替换符；统一收紧内联与外部 SVG 静态白名单，禁止 CSS 注释，并拦截样式与呈现属性中指向非本页 `#id` 片段的 `url()` 与 `image-set()` 引用。同批修复 `DesktopNativeTests` 在 macOS 15 下的双页 PDF 回读差异，将 `client-macos` 独立作业重新接入 `.github/workflows/ci.yml`，并清理 Android `CatalogRepository.kt` 的冗余非空断言编译告警。
4. **版本、许可与发版说明同步**：Mac `Info.plist` 升为 `CFBundleShortVersionString` `1.4.6`、`CFBundleVersion` `22`，随包 `Resources/licenses/manifest.json` 与 `Resources/third-party-notices.html` 同步刷新；Android `app/build.gradle.kts` 升为 `versionName` `1.4.6`、`versionCode` `22`，沿用 1.4.4/1.4.5 发布签名库（证书 SHA-256 `6a0c3138…`），已安装 1.4.4 或 1.4.5 的用户可直接覆盖升级，1.4.3 用户仍需先导出备份、卸载旧版再安装；`apps/macos/release_tools.py` 补齐 `1.4.6` 的 `RELEASE_NOTES.md` 更新说明分支。

## 本轮已执行的自动化验证

- 协议与文档一致性：`npm run docs:check`、`node --test tests/documentation.test.js`（6 项测试）与 `bash scripts/python-runtime.sh apps/generate-client-protocols.py --check` 全部通过。
- macOS 客户端全量回归（`bash apps/macos/test.sh`）：`Tests/*Tests.swift` 共 60 个套件（Swift 循环执行 59 个、环境跳过 0 个；CJS 外壳 `ModelWorker` 执行 1 个；可选已安装 Zotero 契约审查跳过 0 个）、全部 Node/Playwright 界面与安全回归套件，以及 `Branding.test.py`（8 项）、`FinalizeBuild.test.py`（4 项）、`ReleasePackaging.test.py`（89 项）共 101 项 Python 许可、定稿与打包回读检查全部通过，0 失败。
- Android 客户端全量回归（`bash apps/android/test.sh`）：11 个 Python 发行、签名与安全资源检查脚本，`AssetsChannel.test.mjs` 17 项资产通道负例，129 个 JUnit 单元测试类共 966 项用例，以及 `lintDebug` 全部通过，0 失败。
- 真实语料兼容核验：双端导读与详情校验器已完成全站 9225 页导读片段、8863 篇去重论文的真实导出语料重放与对抗向量回归（见提交 `65b266cd`）。

## 尚未执行的项目与正式发布前步骤

1. **人工图形与设备验收矩阵未重跑**：本轮只执行自动化单元、集成、浏览器隔离渲染、真实语料重放与打包工具检查，**没有重新执行 84/86 项人工图形与实机验收矩阵**（含 Mac 69 项人工图形操作、云端与发行 17 项真实账号/草稿核验，以及 Android 实体机和完整 TalkBack 遍历）。安装、图形首启、旧资料升级和真实服务人工操作的最新完整范围仍属 1.3.0，见[1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)。
2. **提交干净工作区后再打包**：`apps/macos/release_tools.py` 与 `apps/android/release_tools.py` 均要求干净的 Git 提交作为 `sourceCommit`；需先提交本轮代码与文档修改，再构建并签名两端正式候选包。
3. **标签、十二件附件与公开核验待后续登记**：待完成正式候选包核验、创建附注标签 `v1.4.6`、上传 Mac 与 Android 共 12 件附件并公开 GitHub Release 后，再于后续提交在[客户端发行核验](client-release-verification.md)和[Mac 构建与发行](mac-app-release.md)中登记公开时间、标签指向提交、各附件字节与 SHA-256 以及未登录 HTTP 200 下载结果。
