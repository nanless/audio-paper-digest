# Paper Digest Workbench for Android

[简体中文](README.md)

This native Android client reads the Paper Digest website's published paper catalog, illustrated explanations, daily digests, and conference overviews. It supports original PDFs, notes, offline reading, personal study, Zotero archiving, and Nutstore backup. Reading or synchronizing existing articles does not request new model analysis.

The source version is **1.4.3, build 19**. Public package availability is determined by [GitHub Releases](https://github.com/nanless/audio-paper-digest/releases). Android 9 / API 28 or later is supported, with `armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64` architectures. The application identifier remains `com.nanless.paperdigest`, and formal packages retain the previous signing identity. See [validation and release scope (Chinese)](../../docs/android-validation.md) and the [1.3.0 review (Chinese)](../../docs/workbench-1.3.0-review.md).

Quoted interface labels below refer to the application's Chinese interface. Detailed linked documents are in Chinese unless stated otherwise.

## Get started

### Synchronize and open a paper

1. A new installation opens “日更” (Daily Digest) and obtains the website catalog automatically. Returning to the app checks for updates at the configured interval; manual synchronization remains available in the menu. Bottom navigation provides Daily Digest, Library, Conferences, Tasks, and Settings. Conferences include the complete catalog, each conference overview, and research directions.
2. Open a paper to see its explanation, original, study responses, and notes in Reading. Phones primarily use one column. With a PDF open and enough available width, side-by-side or focused layouts are available. Wide tables and long formulas scroll locally rather than shrinking the whole article.
3. After entering from a daily or conference overview, return with the overview action or system Back. Conference catalog, overview, and topic pages support stepwise return. Position is retained for the same revision.

The current source reads `client/index.json` first and uses the original catalog endpoint only after an explicit HTTP 404 or 410. Sidecars in the new format are checked against the paper identity, date, and SHA declared by the reading page; the original public addresses remain available to released applications. Corrupt formats and network failures do not trigger fallback to the original endpoint; existing data is preserved on failure. This describes source-level interface compatibility, not a newly released installation package. See the [website data adapter guide (Chinese)](../../docs/mac-app-data.md) for the full boundary.

While idle, at most four public overview HTML pages and two recent paper explanations preload. Opening an explanation shows verified text before optional images finish; user actions take priority over background synchronization and preloading. PDFs still download on demand, and offline mode does not use the network. Explicitly opening a saved historical version does not fetch additional images, avoiding material from another revision. See the [1.3.2 review (Chinese)](../../docs/android-1.3.2-review.md) for automatic updates, phone typography, and error recovery.

The app checks for new catalog entries in the foreground and after connectivity recovers. It downloads catalog shards when the index changes and keeps the configured background sync interval. Opening an older saved overview displays its text first, then checks the website version. The daily page also offers manual refresh. The app can use a synthetic IP route supplied by the network for the public publisher site, with normal HTTPS certificate validation.

Phone reading now uses compact typography: a 14 px body, an approximately 18 px main title, and tighter spacing and list indents. Use the paper or website page menu to decrease, increase, or reset text size without leaving the page. This shares the reading setting and preserves system font scaling; exports keep their separate layout. See the [1.3.3 typography review (Chinese)](../../docs/android-1.3.3-review.md).

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

Filters and Sorting provides source, minimum score, and website publication-date ranges. That date belongs to the published explanation and is separate from favorite time. All papers, favorites, and the reading list retain their own search, classification, and reading position. System Back returns from a paper to the previous list. For papers with multiple explanations, “论文信息与全部已发布导读” lists the actual matching explanation and each explanation's information; official website entries explicitly open in a browser.

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

Nutstore research backup saves independent versions of the whole research space. It supports cancellation, continuation of the same version, version selection, verification, and confirmed restoration. The default directory is `PaperDigest`, separate from Zotero attachments. Later edits do not overwrite saved versions, and notes from two devices do not merge automatically. Restoration selects an explicit point in time.

Backups preserve originals, article versions, notes, annotations, study inputs, responses, usage, and history. Model keys, connection passwords, device authorization, and both local response-integrity keys do not migrate. Those materials belong to the device: another device's backup must not take over authorization or re-sign historical responses. Restoring an old package preserves the original package and uses the current device's integrity keys in the effective research space.

Transfer uses HTTPS without additional end-to-end encryption for the stored package. Treat it as a private file. See the [backup contract (Chinese)](../../docs/android-cloud-contract.md) for fields, size limits, and restoration safeguards.

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

Formal release checks cover source, version, signing identity, all four architectures, 16 KiB alignment, licenses, resources, fresh installation, and in-place upgrade. Alignment is a native-library package-layout requirement, not proof of testing on every device. Signing keys and passwords stay outside the repository and release package. Download actual packages from this repository's [GitHub Releases](https://github.com/nanless/audio-paper-digest/releases). See the [feature and validation matrix (Chinese)](../../docs/android-feature-parity.md).

In the library, choose **一键同步 WebDAV**. Use the same saved Nutstore account and folder on both devices. The action synchronizes personal reading data separately from PDFs, saved offline guides, research originals, exports, and archive history. You can retry from settings and see a separate result for each part. A retry after interruption uses the original pending snapshot. Full backup and restore remain separate actions. If the same record or path has different contents, the workbench keeps the local version and the other device’s original. Imported archive history is read-only. Resume an archive from the device that created it.
