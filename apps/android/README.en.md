# Audio Research Workbench for Android

[简体中文](README.md)

This native Android client reads the Audio Research Portal website's published paper catalog, illustrated explanations, daily editions, and conference overviews. It supports original PDFs, daily audio podcasts, notes, offline reading, personal study, Zotero archiving, and Nutstore backup. Reading or synchronizing existing articles does not request new model analysis.

The current source version is **1.5.1 (build 25) (not yet published)** (see the [1.5.1 pre-release record (Chinese)](../../docs/workbench-1.5.1-review.md)); the latest published release is **1.5.0 / build 24**, published on 26 November 2026 (Beijing time, commit `5b5a8e79`), downloadable from [GitHub Releases](https://github.com/nanless/audio-research-workbench/releases/tag/v1.5.0). Android 9 / API 28 or later is supported, with `armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64` architectures. The application identifier remains `com.nanless.paperdigest`. Since 1.4.4 the formal package uses a new signing key with certificate SHA-256 `6a0c3138f9a49b01f868a123490a7e562f6d78d951160afb2ea5b1e44274e5bb`, different from 1.4.3's `d7c680d9…`; users on 1.4.3 must export a backup, uninstall, and then install. Versions 1.4.5 through 1.5.1 keep the 1.4.4 signing key, so 1.4.4–1.5.0 users can upgrade in place. See [validation and release scope (Chinese)](../../docs/android-validation.md), the [1.5.1 pre-release record (Chinese)](../../docs/workbench-1.5.1-review.md), [1.5.0 record (Chinese)](../../docs/workbench-1.5.0-review.md), [1.4.7 record (Chinese)](../../docs/workbench-1.4.7-review.md), [1.4.6 record (Chinese)](../../docs/workbench-1.4.6-review.md), and [1.4.5 record (Chinese)](../../docs/workbench-1.4.5-review.md) for changes and tested scope, [client performance](../../docs/client-performance.md), and [client release verification](../../docs/client-release-verification.md) for signing and assets. The [1.4.4 review (Chinese)](../../docs/workbench-1.4.4-review.md), [1.4.3 record (Chinese)](../../docs/workbench-1.4.3-review.md#发行状态), [1.4.2 review (Chinese)](../../docs/workbench-1.4.2-review.md), and [1.3.0 review (Chinese)](../../docs/workbench-1.3.0-review.md) cover earlier changes.

Quoted interface labels below refer to the application's Chinese interface. Detailed linked documents are in Chinese unless stated otherwise.

## Get started

### Synchronize and open a paper

1. A new installation opens “日更” (Daily Digest) and obtains the website catalog automatically. Returning to the app checks for updates at the configured interval; manual synchronization remains available in the menu. Bottom navigation provides Daily Digest, Library, Conferences, Tasks, and Settings. Conferences include the complete catalog, each conference overview, and research directions.
2. Open a paper to see its explanation, original, study responses, and notes in Reading. Phones primarily use one column. With a PDF open and enough available width, side-by-side or focused layouts are available. Wide tables and long formulas scroll locally rather than shrinking the whole article.
3. After entering from a daily or conference overview, return with the overview action or system Back. Conference catalog, overview, and topic pages support stepwise return. Position is retained for the same revision.

From 1.4.6 onward, released packages and the current source read `client/details/manifest.json` and its content-addressed snapshot and detail artifacts first, falling back to `client/index.json` (and then `index.json`) only when `client/details/manifest.json` explicitly returns HTTP 404 or 410. Sidecars in the new format are checked against the paper identity, date, byte length, and SHA-256 declared by the verified detail record or reading page; the original public addresses remain available to released applications. Corrupt formats, unknown schema fingerprints, and network or HTTP 5xx failures never trigger fallback; existing local data is preserved on failure. Released packages 1.4.3 through 1.4.5 read `client/index.json`, while 1.4.2 and earlier continue to use the original endpoint. See the [website data and recovery guide (Chinese)](../../docs/mac-app-data.md) for the full boundary.

While idle, at most four public overview HTML pages and two recent paper explanations preload. Opening an explanation shows verified text before optional images finish; user actions take priority over background synchronization and preloading. PDFs still download on demand, and offline mode does not use the network. Explicitly opening a saved historical version does not fetch additional images, avoiding material from another revision. Since 1.4.3, startup reads a lightweight offline index and checks the file set, sizes, and times instead of parsing every saved explanation JSON; a missing or damaged index triggers one full scan and rebuild. See the [1.3.2 review (Chinese)](../../docs/android-1.3.2-review.md) for automatic updates, phone typography, and error recovery.

The app checks for new catalog entries in the foreground and after connectivity recovers. It downloads catalog shards when the index changes and keeps the configured background sync interval. Opening an older saved overview displays its text first, then checks the website version. The daily page also offers manual refresh. The app can use a synthetic IP route supplied by the network for the public publisher site, with normal HTTPS certificate validation.

Phone reading uses compact typography: a 14 px body, an approximately 18 px main title, and tighter spacing and list indents. Version 1.5.0 adopts the **Studio Monograph** Material 3 visual refinement along with Wave 12 audio-spec summary cards, Track 13.3 score-audit cards, tiered score badges, rank buckets, and verified resource badges. Use the paper or website page menu to decrease, increase, or reset text size without leaving the page. This shares the reading setting and preserves system font scaling; exports keep their separate layout. See the [1.3.3 typography review (Chinese)](../../docs/android-1.3.3-review.md).

### Daily Audio Podcast (1.5.0)

The Android client includes a native daily audio podcast player built on Android's built-in `MediaPlayer`, `AudioAttributes`, `AudioFocusRequest`, and `PlaybackParams` with zero added third-party dependencies or extra manifest permissions:

- **Read-only feed & verified downloads**: Reads the portal's optional `client/podcast/feed.json` (silently hides on HTTP 404/410 and respects offline mode). Audio files download strictly from the allowlisted GitHub Release HTTPS repositories and must pass the 40 MiB cap, exact byte-length check, streaming SHA-256 verification, and MP3 header check before playback.
- **Commute playback & paper links**: Supports `0.75×–2.0×` playback speed, chapter-timestamp seeking, audio-focus handling, and jumping directly from a chapter to its matching paper guide.
- **Isolated LRU cache**: Maintains a `150 MiB / 5-episode` local audio cache that is explicitly excluded from full-space backups and one-click WebDAV sync.

### Configure a model and review the material

Personal study uses the service connection and key you enter in model settings. The endpoint receives requests, and the protocol defines the message format; use the service's actual configuration. Research is managed locally, but selected material is sent to the service when you use a remote endpoint. Local management does not imply on-device inference.

Before starting, confirm the question, selection or page range, model, and budget. Current requests contain text extracted from the explanation or PDF. There is no OCR or image understanding. Page ranges use physical pages counted from the beginning of the PDF file and may differ from printed page labels. Matching inputs can reuse existing responses. Explicit regeneration creates a new record while keeping the original response and fees.

### Follow tasks and handle failures

Tasks shows synchronization, study, archiving, and backup progress, with the cancellation or continuation actions available for the actual task. Already-issued model requests with unknown results are not automatically resent after restart or restoration. Unreported amounts remain unknown; cancellation or failure does not establish that no charge occurred.

API keys and connection passwords use local secure storage. Export research data through the system file picker. Uninstalling or clearing application data removes private local material, so back up first.

The first reminder opens Settings → “连接与开始” for WebDAV backup or Zotero, or lets you configure them later and start reading. Each connection has the relevant official authorization entry, secure storage, and a connection check. If a credential was saved but the network check failed, retry only the check without entering the password again.

## Browse all research directions in 1.3.0

Open Research Directions in the library. Phones show an expandable catalog panel; wide windows place it beside the papers. All nine website classification facets and their full hierarchy are retained, including directions with zero papers. Catalog search supports Chinese and English names, aliases, and identifiers and is separate from paper search.

Tap a direction name to browse its next level and use breadcrumbs to return upward. Checking a direction applies a filter; browsing does not change selected conditions. On phones, “查看论文” closes the panel and returns to the results.

Tasks, methods, and other facets are different classification perspectives. Selections within a facet use OR, while facets combine with AND. Two tasks and one method therefore mean either selected task together with that method. Descendants are included by default. Advanced options can limit matching to direct labels, primary roles, research type, or domain. Direction details show the definition, aliases, and full path.

Filters and Sorting provides source, offline conference filters (with paper counts), quick score tiers (All / Featured ≥ 8.0 / High ≥ 7.0 / Recommended ≥ 6.0 / Scored), open-source / weights / dataset / locally cached audio-demo filters, and website publication-date ranges. Since 1.5.0, paper search supports NFKC and diacritic-normalized multi-word AND matching with relevance sorting while a query is active. That date belongs to the published explanation and is separate from favorite time. All papers, favorites, and the reading list retain their own search, classification, and reading position. System Back returns from a paper to the previous list. For papers with multiple explanations, “论文信息与全部已发布导读” lists the actual matching explanation and each explanation's information; official website entries explicitly open in a browser.

The library menu's “网站全部成果” collects daily digests, conferences, About, and research resources, with entries for the website library, search, archives, and RSS. Website-specific functions remain in a browser; explanations, PDFs, notes, and personal study remain in the workbench.

## Organize favorites

Switch directly to Favorites at the top of the library. Items group by actual favorite time, with an optional month view. Older favorites without a timestamp appear under unknown favorite time. The paper publication date is shown separately and is not used as a substitute.

Favorites use the classification of each published explanation. Expand tasks, methods, and other facets; a parent includes its children, and cards show the original paths. Synchronize if an old cache lacks structured classification. Unverifiable classification is explained instead of inferred from flat tags.

The interface no longer creates, renames, or manually assigns personal categories. Version 1.2.0 custom-category fields remain in data and backups, and favorite times are retained. See [favorites and compatibility (Chinese)](../../docs/favorite-collections.md).

## Zotero and Nutstore

### Archive selected papers in Zotero

Zotero manages references and attachments. Android communicates through the official Web API and requires its own dedicated authorization; a Mac need not be online. Confirm the target library, collection, and materials, then save and read back bibliographic data, provenance, PDFs, explanations, study responses, and notes separately. Existing records prevent duplicate creation and support continuation, while protecting remote user edits.

Bibliographic synchronization and attachment storage are separate. Personal libraries can use Zotero Storage or configured WebDAV storage; group attachments do not use WebDAV.

If Zotero Storage is full, you can explicitly confirm switching the existing archive to the application's configured Nutstore attachment connection. Original bibliographic and Storage records remain, and new materials are read back again. A changed connection or restart requires confirmation again. Other Zotero clients need their own matching attachment-sync configuration. See [Zotero instructions (Chinese)](../../docs/android-zotero-research.md).

### Back up the complete workbench to Nutstore

Nutstore research backup saves independent versions of the whole research space. It supports cancellation, continuation of the same version, version selection, verification, and confirmed restoration. The default directory is `PaperDigest`, separate from Zotero attachments. Later edits do not overwrite saved full snapshots, and restoration selects an explicit point in time; for day-to-day bidirectional sync and lossless note conflict merging, use **One-click WebDAV sync** below.

Backups preserve originals, article versions, notes, annotations, study inputs, responses, usage, and history. Model keys, connection passwords, device authorization, and both local response-integrity keys do not migrate. Those materials belong to the device: another device's backup must not take over authorization or re-sign historical responses. Restoring an old package preserves the original package and uses the current device's integrity keys in the effective research space.

Transfer uses HTTPS without additional end-to-end encryption for the stored package. Treat it as a private file. See the [backup contract (Chinese)](../../docs/android-cloud-contract.md) for fields, size limits, and restoration safeguards.

### One-click bidirectional WebDAV sync

In the library, choose **一键同步 WebDAV**. Use the same saved Nutstore account and folder on both devices. The action synchronizes personal reading data separately from PDFs, saved offline guides, research originals, exports, and archive history. You can retry from settings and see a separate result for each part. A retry after interruption uses the original pending snapshot. Full backup and restore remain separate actions. If the same record or path has different contents, the workbench keeps the local version and the other device’s original; when a paper's note has concurrent edits, the reading view shows a conflict card to keep the local text, adopt the remote text, or save a lossless merge while archiving the original conflict backup. Imported archive history is read-only. Resume an archive from the device that created it.

## Build locally

Use a Node version supported by the root project, JDK 17, Android SDK platform 37, Build Tools 36.0.0, NDK 27.2.12479018, CMake 3.22.1, and the Mac subproject's locked KaTeX dependency. The build script uses existing `JAVA_HOME` and `ANDROID_HOME` values, recognizes local Homebrew locations, and does not modify global settings.

Run these commands from the repository root. The first builds a debug APK; the second runs host tests and static checks. They do not replace device operations below. KaTeX is a bundled formula-layout dependency, not a model service.

```bash
./apps/android/build.sh :app:assembleDebug
./apps/android/test.sh
```

The default debug APK is `apps/android/app/build/outputs/apk/debug/app-debug.apk`. The debug asset channel, `private-qa`, includes a fixed public MiCLA sample. The formal `release` channel contains only an empty bootstrap catalog, layout resources, and complete open-source licenses. Outputs and manifests are separate. Formal packages exclude acceptance pages, user data, production runtime data, and `.env`.

## Test on a device

Use a dedicated acceptance emulator that you created without personal data. Check `adb devices` and the AVD name, then replace `SERIAL` with the selected device's serial number:

```bash
./apps/android/install.sh SERIAL
./apps/android/test.sh --device SERIAL
```

Installation and device tests require one explicit serial, either as an argument or through `ANDROID_SERIAL`. With no selection they stop rather than installing on an old emulator. Installation targets only that device, checks readiness, and checks emulator names against `PaperDigest_QA_API35` and `PaperDigest_QA_API28`. Tests also use only the chosen serial. The operator must separately verify that the device has no personal data. Do not substitute a user's existing phone or research emulator, and do not dispatch to all connected devices.

Formal release checks cover source, version, signing identity, all four architectures, 16 KiB alignment, licenses, resources, fresh installation, and in-place upgrade. Alignment is a native-library package-layout requirement, not proof of testing on every device. Signing keys and passwords stay outside the repository and release package; since 1.4.4 the regenerated signing key still uses the same login Keychain entry, and the signing entry requires a terminal. The signing scheme and verification result follow `android-build-info.json` and the actual `apksigner verify` output. Download actual packages from this repository's [GitHub Releases](https://github.com/nanless/audio-research-workbench/releases). See the [feature and validation matrix (Chinese)](../../docs/android-feature-parity.md) and [client release verification](../../docs/client-release-verification.md).
