# 工作台 1.4.4 目录恢复与测试补全

Mac 和 Android 的源码版本均为 1.4.4，构建号均为 20。1.4.4 不改变内容生产、来源与发布规则，处理客户端目录载入失败后的恢复路径，并把客户端测试所需的固定资产和 macOS 套件补到能在干净检出上直接运行。

## 目录载入失败后的恢复

Mac 的目录服务在启动时于后台解码已保存目录。解码失败后阶段停在失败，普通命令会重新返回该错误；此前只有 `library.retryLoad` 不受这道关口限制，`library.sync` 仍会在关口被拒，用户只剩重新读取本机文件一条路。

1.4.4 让 `library.sync` 与 `library.retryLoad` 一起放行：整站同步本来就会替换本机目录，因此也是启动解码失败的修复路径；真正挂起的解码仍会等待，合并从已保存目录开始，而不是占位数据。同步成功写入磁盘并替换内存目录后，失败阶段提升为就绪，`library.status` 与后续命令不再返回旧错误；并发中的重试仍持有 loading 阶段，并自行发布这次读取的结果。

新增的回归用例构造损坏的已保存目录，依次确认普通命令仍报错、`library.sync` 能跑通、列表与状态指向同步发布的新快照，且重启后仍可读取。

## 测试资产与 CI

Mac 的多个测试套件直接读取 `prototypes/macos-research/assets` 下的公开论文 PDF 与三张裁图。这些文件此前被 `.gitignore` 排除，只能在准备过的本机运行，干净检出上必然缺失。

1.4.4 把四份文件入库：`micla-2610.27491v1.pdf`、`figure-1.png`、`figure-2.png`、`figure-3.png`，来源是公开论文 [MiCLA v1（arXiv:2610.27491v1）](https://arxiv.org/abs/2610.27491v1)。`.gitignore` 只继续忽略 `assets/` 下的其他本机材料，四个资产与两份说明保留；测试仍逐字节核对 `sample.json` 记录的 SHA-256，不联网、不下载，也不能换成生产数据或来源不明的同名文件。

1.4.4 曾新增 `client-macos` CI 作业，在 `macos-15` 上准备 Node 22、Python 3.11 和两端依赖，安装 playwright 的 Chromium 后运行 `bash apps/macos/test.sh`；作业固定 macOS 15，是因为应用最低支持 15.0，较早的运行器可能无法编译或启动。该作业随后退出 CI（`63b9339c`）：本机 `bash apps/macos/test.sh` 通过，但 GitHub 的 macos-15 runner 在虚拟显示器压缩 820x700 原生详情窗口、PDFKit 提取混合文字/空白页文本两处与本机不同，属于 runner 环境差异，需要专门适配后再加回，不能用跳过套件的方式让作业变绿。macOS 测试现在仍在本机运行。

客户端 CI 现在只保留 `client-android` 作业，运行 `./gradlew :app:testDebugUnitTest --no-daemon`。该作业保留完整的 debug 资产准备（`92086447`）：单元测试会读取打包后的已发布样本，排除 `:app:prepareDebugPublishedAssets` 会让测试读不到资产；资产已入库，katex 依赖也在作业中单独安装。作业不运行 `apps/android/test.sh`。

## macOS 套件修补

- `NativeLibraryAccessibilityTests` 的隔离 fixture 补上 `library.paperDetail`：列表行不再携带完整引用，打开某行时宿主按论文标识返回完整记录；缺少该命令会走进“prohibited command”分支。
- `LibraryPDFRevalidation.test.cjs` 编译 `LibraryServiceTests` 时补 `-D PAPER_DIGEST_TESTS`，使该二进制与 `test.sh` 编译同一套测试启用分支；此前缺少这个宏。
- `test.sh` 把 `NativeLibraryAccessibility` 的退出码 77 记为跳过：该套件读取本进程的 AppKit 辅助功能树，需要已解锁桌面和可用的 AXWindow，环境不具备时不算断言失败。其他非零退出仍终止。
- 套件清单包含 `AggregatePreload` 与 `ZoteroInstalledContractReview`；后者只读核验本机已安装 Zotero 的源码，未安装时显式跳过，不把缺少第三方应用当成回归。

## 验证范围

本轮发布准备运行版本与文档一致性检查：`npm run docs:check`、Branding 离线测试（`bash scripts/python-runtime.sh apps/macos/Tests/Branding.test.py`）和 `node --test tests/documentation.test.js`。macOS 全套件在本机运行；Android 单元测试、lint 与 CI 作业的实际结果以构建和发行记录为准，本页不代替这些结果。

## 发行状态

本版未重跑 69 项人工图形验收。安装、图形首启、升级和业务操作的最新完整范围仍属 1.3.0，见[1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)。1.4.4 已于 2026-11-05 公开发布，标签 `v1.4.4` 指向提交 `aecf5c25`，Android 证书已换成 `6a0c3138…`；十二件附件、证书和匿名下载的核验见[客户端发行核验](client-release-verification.md)。
