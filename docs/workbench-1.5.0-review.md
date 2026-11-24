# 工作台 1.5.0 审改记录

[English](README.en.md) · 返回[文档索引](README.md)

版本 **1.5.0（构建号 24）** 在源码中新增双端原生每日音频播客播放器、Wave 12 / Track 13.3 音频速览与评分审计排版以及离线检索/筛选对齐，同时冻结 `client/details/*` 既有公开契约与 Android 发行权限/依赖边界。本版本当前处于源码验证阶段，尚未正式打包、签名或公开发布；最近已公开发布的安装包仍为 [1.4.7 / 构建号 23](workbench-1.4.7-review.md)。

## 1.4.7 之后的客户端改动

1. **双端原生每日音频播客播放器**：
   - 在 `config/protocols/clients-v15.json` 新增独立可选协议 `paper-daily-podcast-feed`（`client/podcast/feed.json`），`config/protocols/clients.json` 保持零改动；HTTP 404/410 静默降级、HTTP 200 严格闭环校验，不中断目录同步且遵守离线模式。
   - macOS（`PodcastPlayerService.swift`、`AppPodcast.swift`、`podcast-ui.js`、`podcast.css`）使用 `AVAudioPlayer` 与 `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter`，Android（`PodcastRepository.kt`、`PodcastCoordinator.kt`、`PodcastPlayerBar.kt`、`SafeHttp.podcastRelease`）使用内置 `android.media.MediaPlayer`、`AudioAttributes`、`AudioFocusRequest` 与 `PlaybackParams`，零新增 Gradle 依赖、零修改 `AndroidManifest.xml` 与 WebView CSP。
   - 音频先下载再校验（严格限制 `github.com/nanless/audio-paper-digest` 与 `audio-paper-digest-blog` Release HTTPS 链接、最多 4 次受控域名重定向、40 MiB 上限、精确字节数 + 流式 SHA-256 + MP3 魔数校验），并写入排除备份与 WebDAV 的 150 MiB / 5 期 LRU 本地缓存，支持 0.75x–2.0x 倍速、章节跳转与规范论文编号跳读。
2. **Wave 12 音频速览卡片与 Track 13.3 评分审计视觉升级**：
   - 双端阅读样式（macOS `native.js`、`aggregate-native-body.css`、`aggregate-ui.js`、`AppDocuments.swift`；Android `ReaderDocumentStyle.kt`）补齐 Wave 12 音频参数速览与摘要卡片及 Track 13.3 评分审计卡片样式，同时保留严格 WebView CSP。
   - macOS `LibraryDesktopDetails.swift` 解析并透传 `assessment.rankBucket` 与 `assessment.documentType`；双端论文页眉与论文库卡片新增分层评分徽章（精选/高分/推荐）、会议标识与已核验资源徽章。
3. **离线多词检索、相关度排序、会议/评分/开源资源筛选对齐**：
   - 双端实现 NFKC 与变音符归一化多词空格 AND 检索、有查询时的“相关度”排序、按 `paperId` 离线解析的会议筛选（带篇数计数）、评分快捷档位（全部 / 精选 ≥ 8.0 / 高分 ≥ 7.0 / 推荐 ≥ 6.0 / 仅含评分），以及 Tier 1 离线开源/权重/数据集/本机缓存音频 Demo 筛选与 Tier 2 可选 `client/signals/resource-badges.json`（`paper-resource-badges-index`，404/410 静默降级、200 闭环校验）。
4. **版本与许可同步**：
   - macOS `Info.plist` 升为 `1.5.0` / 构建号 `24`，刷新随包许可清单与 `release_tools.py` `1.5.0` 说明分支；Android `app/build.gradle.kts` 仅升为 `versionName = "1.5.0"`、`versionCode = 24`。

## 本轮已执行的自动化验证

- 协议与文档一致性：`bash scripts/python-runtime.sh apps/generate-client-protocols.py --check`、`node scripts/docs-consistency.js`、`node --test tests/workflow-implementation-files.test.js`、`bash scripts/python-runtime.sh -m unittest -v tests/python/test_client_protocol_generation.py` 全部通过。
- macOS 隔离自动测试（`bash apps/macos/test.sh`）：含新增 `PodcastPlayerServiceTests`、`LibraryFiltersV15Tests` 与 `PodcastUI.test.cjs` 在内的 62 个 Swift/CJS 套件、全部 Playwright 与 Python 发版/品牌测试通过。
- Android 隔离自动测试与静态检查（`bash apps/android/test.sh`）：含新增 `PodcastRepositoryTest`、`LibraryV15FiltersTest`、`ReaderDocumentStyleV15Test` 在内的全量 JUnit 单元测试、`lintDebug`、`AssetsChannel.test.mjs` 与全部 Python 发行/安全资源检查通过。

## 发行状态与未覆盖范围

1.5.0 当前仅完成源码实现与双端隔离自动化验证，尚未执行正式打包、签名、实体机/图形验收矩阵或公开发布；正式发行前的手动矩阵与最新完整图形验收范围仍以 [1.3.0 记录](workbench-1.3.0-review.md#正式发行与升级检查) 及 [1.4.7 记录](workbench-1.4.7-review.md) 为准。
