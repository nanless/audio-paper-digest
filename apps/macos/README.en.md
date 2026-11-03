# Paper Digest Workbench for Mac

[简体中文](README.md)

The workbench brings published Paper Digest articles, original PDFs, and your personal research into one reading environment. Read the illustrated explanation first, open the paper to check it, save questions, model responses, excerpts, and notes, then archive selected material in Zotero.

The installed application runs independently. You do not need the source repository, a development server, or a separate Node installation. Reading and synchronizing published content does not analyze papers again. Only an explicit personal study request or connection test calls your configured model service.

The interface labels quoted below are Chinese labels in the application. Linked detailed documentation is in Chinese unless stated otherwise.

## Install and upgrade

| Item | Supported configuration |
|---|---|
| Source version | 1.4.0, build 16; see the release page for available public packages |
| Operating system | macOS 15 or later |
| Processor | Apple Silicon, arm64; the current package does not contain both Intel and Apple Silicon architectures |
| Signing | Local ad-hoc signing; not notarized by Apple |
| Bundled runtime | Node 24.19.0; users do not install it separately |

Mac and Android packages and checksums are available on the same [GitHub Releases page](https://github.com/nanless/audio-paper-digest/releases). Drag the extracted `论文速递工作台.app`, or the application inside the DMG, into Applications. If macOS blocks the first launch, verify the download source and published checksum, then use the appropriate Privacy & Security action to allow the application to open.

Version 1.3.0 adds site-wide hierarchical classification, reorganizes desktop navigation, and aligns query rules with Android. See the [implementation and acceptance record (Chinese)](../../docs/workbench-1.3.0-review.md). A source version does not by itself establish that an installation package is public or has passed acceptance; download a version actually offered on the release page.

Save edits and quit the old application normally before upgrading. Applications with the old name are not removed automatically. Old and new packages share the existing data directory and Keychain service, so do not run them simultaneously. Removing the application package leaves your personal research data in place. Export a backup before separately clearing that data.

## First use

### Find a paper and compare it with the PDF

1. The default view is “日更速递” (Daily Digest). Synchronize to load the complete website catalog. The sidebar provides daily digests, all papers, research directions, conference collections, and website resources. Conferences have a catalog, overview, and research topics; they do not depend on a digest being published that day.
2. Select a paper from a daily or conference overview. The explanation initially occupies one column. “打开 PDF” opens the original on the right. Drag the divider to adjust the widths, and close the PDF column when you no longer need it.
3. “返回原汇总” returns to the overview from which you entered. Reading position is restored for the same page revision. “继续阅读” restores the paper's saved PDF page, reading tab, and question draft.

Library search covers metadata, explanations already read, and personal notes. Use search inside the PDF reader for the original paper; PDF text is not part of the library-wide full-text index.

The current source reads `client/index.json` first and uses the original catalog endpoint only after an explicit HTTP 404 or 410. Sidecars in the new format are checked against the paper identity, date, and SHA declared by the reading page; the original public addresses remain available to released applications. Corrupt formats and network failures do not trigger fallback to the original endpoint; existing data is preserved on failure. This describes source-level interface compatibility, not a newly released installation package. See the [website data adapter guide (Chinese)](../../docs/mac-app-data.md) for the full boundary.

### Configure a model and ask a question

“个人解析” is personal follow-up research. It does not rewrite the published explanation or original paper. In Settings, enter your own API endpoint, model, protocol, budget, and any required HTTP CONNECT proxy. The endpoint is the service address that receives requests; the protocol determines their format. Use values supplied by the actual service. A native secure-entry window stores the key in this application's Keychain. Connection tests also send real requests.

Choose the explanation, a PDF text selection, the current physical page, a page range, a chapter, or the full paper as evidence. Physical pages count from the first page in the PDF file and may differ from printed page labels. Current input consists of extracted text. There is no OCR or image understanding; scanned pages without extractable text produce a notice. The question, actual evidence, pages, version, response, and usage are saved together.

Completed responses can be reused for exactly matching study inputs. Explicit regeneration keeps old responses and fee records. Cancellation or failure may still incur a charge. Amounts not reported by the service remain unknown, and requests with unknown charges are not automatically resent.

### Keep notes and their sources

Notes, excerpts, and annotations save automatically. “我的笔记” groups them by paper. Source links return to positions in the same version and exact PDF file. When a source changes, old notes, responses, and citations remain attached to their original version. Existing copies remain readable after a network failure, with their update time or stale status shown.

The first-connection reminder can open WebDAV backup or Zotero setup, or you can choose to configure them later. “连接与开始” explains the two connections separately. Reading does not require setting up an account first.

## Browse all research directions in 1.3.0

“研究方向” opens the complete website hierarchy, with matching papers on the right. The same catalog is available from all papers, favorites, and the reading list. Each scope retains its own search, classification, and position. Directions with zero papers remain visible and have descriptions.

Catalog search finds directions by Chinese or English names, aliases, and identifiers. The paper search on the right searches papers, local explanations, and notes. The arrow expands a level; the direction name opens that direction. Checking directions applies a combined filter.

A facet is one classification perspective, such as task or method. Selections within one facet use OR; different facets use AND. Selecting two tasks and one method means either selected task together with that method. Descendants are included by default. Advanced options can restrict matching to direct labels, primary roles, research type, and domain. Expanding a hierarchy does not add labels to papers.

Breadcrumbs and descriptions show complete paths, definitions, and scope. Source, score, and website date are in Filters; active classification rules have a summary and a reset action. Opening a paper and returning preserves classification, page, and scroll position. If a paper has several explanations, complete information shows each explanation's date, score, classification, and official website entry. A match in another explanation is identified explicitly and must not be interpreted as the default explanation's score.

## Organize favorites

“已收藏” initially lists items by their actual favorite time, newest first, grouped into today, the last seven days, and earlier items. You can also browse by month. Old items with no recorded favorite time appear as unknown; publication dates are not substituted.

Favorites use the website's existing hierarchical classification. Expand task, method, and other facets to browse children. Papers retain their published paths; you do not create or manually maintain a second classification system. Synchronize if an old catalog lacks classification data. Unverifiable records are explained separately rather than inferred from titles or flat labels.

Favorite times and personal data survive complete backup and cross-platform restoration. Version 1.2.0 custom-folder fields remain in the original data, but the current interface does not display or manually assign them as classifications. See [favorites and compatibility (Chinese)](../../docs/favorite-collections.md).

## Website resources and offline reading

Daily Digest and conference collections initially show overviews. “网站与资源” includes About and resource pages plus nine entries such as the website library, search, archives, and RSS. Recognized paper links open in local reading; other HTTPS links open in a browser. Website-specific functions remain in the browser.

The catalog warms up while idle, preloading at most four public overview HTML pages. Text appears before images, and PDFs download on demand. Saved overviews first display a locally verified snapshot. “重新读取网站” checks the current page; a local copy is not presented as the latest website version.

Use View → “页面操作” for the action bar. Control-Tab enters the document, Control-Shift-Tab returns to navigation, and Escape leaves the action bar. Edit → “查找当前文档” searches the current document.

“保存离线” saves the complete illustrated explanation and original PDF for a specified version. “本机资料” shows versions, storage use, and a cleanup preview. Only snapshots containing all required materials are marked fully offline. Ordinary web caches and complete paper offline packages are managed separately.

## Zotero and Nutstore

### Archive one paper in Zotero

Zotero manages references and attachments. Start Zotero Desktop and enable its local API so the workbench can communicate with Zotero on the same computer. Check the connection in Settings. Review the collection and materials for the current paper, then decide authorization in Zotero's native window. The current implementation supports the local personal library; persistent authorization has library-wide scope.

Bibliographic data, complete provenance, the PDF, a self-contained explanation, and selected study responses and notes are saved and read back separately. A self-contained explanation includes the content and images needed to read it without the workbench cache. Partial failures keep successful items and can continue from their existing records. See [Zotero instructions (Chinese)](../../docs/mac-app-zotero.md).

### Back up the complete research space

WebDAV is a protocol for accessing files on a remote service. The workbench uses it to back up the entire research space to Nutstore; this differs from archiving one paper in Zotero. In Settings → WebDAV Backup, enter the account, create a third-party application password, and check the connection. The server address is built in, and the default directory is `PaperDigest`. Passwords can be used only for the current session or saved in this application's Keychain. This directory is separate from Zotero attachment storage.

Backups contain research data, original model inputs and responses, usage, offline materials, and archive records. Keychain entries and local response-integrity keys do not migrate. Restoration keeps a copy of current data, preserves local model connection settings, and retains already-issued request counts. Transfer uses HTTPS without additional end-to-end encryption. Devices save independent versions and do not automatically merge notes. See [backup and restoration (Chinese)](../../docs/mac-app-cloud.md).

Tasks may continue after the main window closes while the application remains running. Quitting stops tasks and automatic backup.

## Build from source

Use macOS 15+, Xcode Command Line Tools, and a development Node version supported by the root project. The complete test entry also requires Google Chrome because some interface tests use its fixed installation path. **The packaged Node binary must exactly match the fixed offline-license version, 24.19.0**, rather than an arbitrary 24.x release.

Obtain `node-v24.19.0-darwin-arm64` from the [official Node 24.19.0 directory](https://nodejs.org/dist/v24.19.0/), verify the archive against the official checksums, and extract it. Point `PD_MAC_NODE_RUNTIME` to its `bin/node`. This example assumes extraction under `~/Tools/`:

```sh
cd apps/macos
export PD_MAC_NODE_RUNTIME="$HOME/Tools/node-v24.19.0-darwin-arm64/bin/node"
npm ci
npm test
npm run build
# Save your work and quit the old application before installing in ~/Applications:
npm run install:app
```

Some interface tests accept `PD_MAC_BROWSER`. The complete `npm test` still includes tests using `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` directly. Installing Playwright Chromium or setting that variable alone does not meet the complete test prerequisite. Scientific-layout tests require the public MiCLA PDF and three original figures, prepared using the [sample instructions (Chinese)](../../prototypes/macos-research/README.md). Expected checksums come from the controlled sample manifest. These local assets are not included in a formal package.

The default build uses the `release` channel and produces `.build/论文速递工作台.app` without paper samples. `--channel private-qa` includes samples for local testing in an isolated data directory. The channel rejects `--install`. The build checks Node's version, architecture, minimum OS, external dynamic-library dependencies, and matching license. Installation refuses to replace an application while `PaperDigest` is running; it does not force the process to quit.

The application identifier `com.nanless.PaperDigest`, executable `PaperDigest`, Keychain service, and data root `~/Library/Application Support/PaperDigest/` remain compatible. About provides the bundled third-party license texts. Runtime updates require matching license material through the maintenance process; original license text must not be edited to bypass version checks.

AppKit provides native windows, WebKit lays out explanations, and PDFKit displays original papers. These components work within the application; users do not set up a web server.

Further documentation, in Chinese: [data and recovery](../../docs/mac-app-data.md), [validation scope](../../docs/mac-app-validation.md), and [release operations](../../docs/mac-app-release.md).

In the library, choose **一键同步 WebDAV**. Use the same saved Nutstore account and folder on both devices. The action synchronizes personal reading data separately from PDFs, saved offline guides, research originals, exports, and archive history. Either part can be retried from settings. A retry after interruption uses the original pending snapshot. Full backup and restore remain separate actions. If the same record or path has different contents, the workbench keeps the local version and the other device’s original. Imported archive history is read-only. Resume an archive from the device that created it.
