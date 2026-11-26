# 工作台 1.5.0 发版记录

[English](README.en.md) · 返回[文档索引](README.md)

版本 **1.5.0（构建号 24）** 带来双端原生每日音频播客播放器、Wave 12 / Track 13.3 音频速览与评分审计排版、离线检索/筛选对齐、全仓库及线上门户品牌统一（**音频研究工作台** / **音频研究门户**）及默认站点路径迁移，同时冻结 `client/details/*` 既有公开契约与 Android 发行权限/依赖边界。1.5.0 已于 2026-11-26 10:12（北京时间）公开发布：附注标签 `v1.5.0`（`24a48710…`）指向发行提交 `5b5a8e79`，[发行页](https://github.com/nanless/audio-research-workbench/releases/tag/v1.5.0)含 12 件附件；签名、附件与匿名下载核验见[客户端发行核验](client-release-verification.md)。

## 1.4.7 之后的改动

1. **双端原生每日音频播客播放器**：
   - 在 `config/protocols/clients-v15.json` 新增独立可选协议 `paper-daily-podcast-feed`（`client/podcast/feed.json`），`config/protocols/clients.json` 保持零改动；HTTP 404/410 静默降级、HTTP 200 严格闭环校验，不中断目录同步且遵守离线模式。
   - macOS（`PodcastPlayerService.swift`、`AppPodcast.swift`、`podcast-ui.js`、`podcast.css`）使用 `AVAudioPlayer` 与 `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter`，Android（`PodcastRepository.kt`、`PodcastCoordinator.kt`、`PodcastPlayerBar.kt`、`SafeHttp.podcastRelease`）使用内置 `android.media.MediaPlayer`、`AudioAttributes`、`AudioFocusRequest` 与 `PlaybackParams`，零新增 Gradle 依赖、零修改 `AndroidManifest.xml` 与 WebView CSP。
   - 音频先下载再校验（严格限制 `nanless/audio-research-workbench`、`nanless/audio-research-portal` 及旧仓 `audio-paper-digest`、`audio-paper-digest-blog` 的受控 Release HTTPS 四仓库白名单、最多 4 次受控域名重定向、40 MiB 上限、精确字节数 + 流式 SHA-256 + MP3 魔数校验），并写入排除备份与 WebDAV 的 150 MiB / 5 期 LRU 本地缓存，支持 0.75x–2.0x 倍速、章节跳转与规范论文编号跳读。
2. **品牌更名与站点路径迁移（兼容旧址）**：
   - 工作台客户端全量更名为“音频研究工作台”（macOS 应用包为 `音频研究工作台.app`，继续共用 `com.nanless.PaperDigest` 标识、原资料目录与钥匙串服务；Android 应用标识仍为 `com.nanless.paperdigest`），默认发布站点迁移至 `https://nanless.github.io/audio-research-portal/`，彻底恢复 1.4.7 因站点改名 301 中断的在线同步，并保留旧路径 `/audio-paper-digest-blog/` 的便携备份恢复、桌面见证与会议目录过渡兼容。
3. **Wave 12 音频速览卡片与 Track 13.3 评分审计视觉升级**：
   - 双端阅读样式（macOS `native.js`、`aggregate-native-body.css`、`aggregate-ui.js`、`AppDocuments.swift`；Android `ReaderDocumentStyle.kt`）补齐 Wave 12 音频参数速览与摘要卡片及 Track 13.3 评分审计卡片样式，同时保留严格 WebView CSP；修复 Android 汇总图注中 `.katex-html` 视觉噪声净化。
   - macOS `LibraryDesktopDetails.swift` 解析并透传 `assessment.rankBucket` 与 `assessment.documentType`；双端论文页眉与论文库卡片新增分层评分徽章（精选/高分/推荐）、排名档位、论文类型、会议标识与已核验资源徽章。
4. **离线多词检索、相关度排序、会议/评分/开源资源筛选对齐**：
   - 双端实现 NFKC 与变音符归一化多词空格 AND 检索、有查询时的“相关度”排序、按 `paperId` 离线解析的会议筛选（带篇数计数）、评分快捷档位（全部 / 精选 ≥ 8.0 / 高分 ≥ 7.0 / 推荐 ≥ 6.0 / 仅含评分），以及 Tier 1 离线开源/权重/数据集/本机缓存音频 Demo 筛选与 Tier 2 可选 `client/signals/resource-badges.json`（`paper-resource-badges-index`，404/410 静默降级、200 闭环校验）。
5. **服务端管线、质量门禁、分级推理与文档重塑**：
   - 同步收拢工作台服务端锁机制、安全边界、LLM 账本按日分片、分级推理强度（`PD_TIERED_REASONING_EFFORT`）、缓存与提取确定性加固、CI 门禁补齐、`AGENTS.md` 瘦身，以及中英文旗舰版图文 README 重塑；“音频研究门户”已于同日同步更新并完成线上部署（提交 `ef496bcf`）。
6. **版本、签名与许可同步**：
   - macOS `Info.plist` 升为 `1.5.0` / 构建号 `24`，刷新随包许可清单与 `release_tools.py` `1.5.0` 说明分支；Android `app/build.gradle.kts` 升为 `versionName = "1.5.0"`、`versionCode = 24`，沿用 1.4.4–1.4.7 发布签名库（证书 SHA-256 `6a0c3138…`），已安装 1.4.4–1.4.7 的用户可直接覆盖升级，1.4.3（`d7c680d9…`）用户仍需先导出备份、卸载旧版再安装。

## 本轮已执行的自动化验证

- 协议、配置与文档一致性：`npm run doctor -- --offline`（12 项通过 / 0 失败）、`npm run config:check`（135/135）、`npm run validate:data`、`npm run docs:check`、`node scripts/generate-scripts-index.js --check`、`node --test tests/documentation.test.js tests/docs-consistency-real.test.js` 与 `bash scripts/python-runtime.sh apps/generate-client-protocols.py --check` 全部通过。
- 服务端 JS 与 Python 全量回归：服务端 JS 测试套件（约 8,158 项测试，含全部提示词契约、分析恢复、计费账本、安全边界与门户生成测试）及 Python 2,640 项单元测试全部通过，0 失败。
- macOS 客户端全量回归（`bash apps/macos/test.sh`）：含 `PodcastPlayerServiceTests`、`LibraryFiltersV15Tests` 与 `PodcastUI.test.cjs` 在内的 62 个 Swift/CJS 套件（0 跳过）、Playwright 与 89 项 Python 发版/品牌测试全部通过，0 失败。
- Android 客户端全量回归（`bash apps/android/test.sh`）：含 `PodcastRepositoryTest`、`LibraryV15FiltersTest`、`ReaderDocumentStyleV15Test` 在内的全量 JUnit 单元测试、`lintDebug`、`AssetsChannel.test.mjs` 与全部 Python 发行/安全资源检查通过，0 失败。

## 发行结果

- 发布时间：2026-11-26 10:12（北京时间，`2026-11-26T02:12:48Z`）。
- 标签与提交：附注标签 `v1.5.0`（标签对象 `24a48710db724898cd89c0b73f0ac054f68fb697`），指向冻结发行提交 `5b5a8e79e5e70290cb650fd37e71417f46946a2b`（`5b5a8e79`）。
- 附件：12 件，Mac 6 件（DMG、ZIP、`RELEASE_NOTES.md`、`build-info.json`、`release-manifest.json`、`SHA256SUMS`），Android 6 件（APK、`android-build-info.json`、`android-source-inputs.json`、`android-runtime-materials.json`、`android-release-manifest.json`、`ANDROID-SHA256SUMS`）；发行页与 12 件附件未登录请求均返回 HTTP 200，下载字节数、SHA-256 与 `verify-downloaded` 包体/签名回读完全一致，详见[客户端发行核验](client-release-verification.md)。
- Android 签名：沿用 1.4.4–1.4.7 发布签名库（证书 SHA-256 `6a0c3138…`，APK Signature Scheme v3，`signingOrigin: provided-signed-apk`）；已安装 1.4.4–1.4.7 的用户可直接覆盖升级，1.4.3（`d7c680d9…`）用户仍需先导出备份、卸载旧版再安装。
- 人工验收：没有重新执行 84/86 项人工图形与实机验收矩阵；本版通过双端及服务端全量自动测试、打包回读、匿名下载签名核验与线上门户核验覆盖。

## 发行范围与遗留

`mac-app-release.md` 要求在公开前完成 86 项人工验收；1.5.0 实际没有重新执行 84/86 项人工矩阵，只在自动化测试、打包回读、匿名下载签名复核与线上门户核验层面覆盖上述改动。1.4.3 至 1.4.7 同样没有重做其中的 69 项图形验收，安装、图形首启、旧资料升级和业务操作的最新完整人工范围仍属 1.3.0，见[1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查)。最终字节已随 `5b5a8e79` 冻结提交，附注标签、12 件附件与公开匿名下载核验已按发行流程完成。
