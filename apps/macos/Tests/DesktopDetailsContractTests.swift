import Foundation
import CryptoKit
import PDFKit
import AppKit
import WebKit

actor DesktopDetailsFixtureServer {
    var files: [String: Data] = [:]
    var statuses: [String: Int] = [:]
    var requestPaths: [String] = []
    var onRead: (@Sendable (String) async throws -> Void)? = nil

    func put(_ path: String, _ data: Data) {
        files[path] = data
        statuses.removeValue(forKey: path)
    }

    func setStatus(_ path: String, _ status: Int) {
        statuses[path] = status
        files.removeValue(forKey: path)
    }

    func remove(_ path: String) {
        files.removeValue(forKey: path)
        statuses.removeValue(forKey: path)
    }

    func setHook(_ hook: (@Sendable (String) async throws -> Void)?) {
        onRead = hook
    }

    func clearRequests() {
        requestPaths.removeAll()
    }

    func requests() -> [String] {
        requestPaths
    }

    func count(for path: String) -> Int {
        requestPaths.filter { $0 == path }.count
    }

    func read(_ url: URL, _ limit: Int) async throws -> Data {
        let key: String
        if url.host == "fixture.example" {
            key = url.path
        } else {
            key = url.absoluteString
        }
        requestPaths.append(key)
        if let hook = onRead {
            try await hook(key)
        }
        if let status = statuses[key] {
            if url.host == "fixture.example" {
                throw LibraryService.ServiceError.httpStatus(status)
            }
            throw LibraryService.ServiceError.network("external status \(status)")
        }
        guard let bytes = files[key] ?? files[key + "/"] else {
            if url.host == "fixture.example" {
                throw LibraryService.ServiceError.httpStatus(404)
            }
            throw LibraryService.ServiceError.network("external missing \(key)")
        }
        guard bytes.count <= limit else {
            throw LibraryService.ServiceError.invalid("资料响应超过大小上限。")
        }
        return bytes
    }
}

@main struct DesktopDetailsContractTests {
    static let siteBase = URL(string: "https://fixture.example/blog/")!
    static let commitA = String(repeating: "a", count: 40)
    static let commitB = String(repeating: "b", count: 40)
    static let commitC = String(repeating: "c", count: 40)
    static let registrySHA = String(repeating: "7", count: 64)
    static let tinyPNG = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlYQAAAAASUVORK5CYII=")!
    static var checks = 0

    static func sha(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func jsonBytes(_ object: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    static func expect(_ condition: Bool, _ message: String) throws {
        guard condition else {
            throw LibraryService.ServiceError.invalid("FAIL: \(message)")
        }
        checks += 1
    }

    static func expectThrows(_ message: String, _ block: () async throws -> Void) async throws {
        var threw = false
        do {
            try await block()
        } catch {
            threw = true
        }
        try expect(threw, message)
    }

    static func makeTempDir(_ prefix: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return dir
    }

    static func makeService(_ dir: URL, _ server: DesktopDetailsFixtureServer) throws -> LibraryService {
        try LibraryService(
            dataDirectory: dir,
            siteBaseURL: siteBase,
            seedDirectory: dir.appendingPathComponent("NoSeed", isDirectory: true),
            transport: { url, limit in try await server.read(url, limit) }
        )
    }

    struct BuiltAppearance {
        let catalogRow: [String: Any]
        let detailRelativePath: String
        let detailBytes: Data
        let detailSHA: String
        let articleRelativePath: String
        let articleBytes: Data
        let articleSHA: String
        let extraSiteFiles: [String: Data]
    }

    static func makeTaxonomyPair() throws -> (snapBytes: Data, snapSHA: String, versBytes: Data, versSHA: String, tagCatalogsField: [String: Any]) {
        let concepts: [[String: Any]] = [
            ["id": "task.asr", "facet": "task", "zh": "语音识别", "aliases": ["ASR"], "ancestorIds": []],
            ["id": "task.codec", "facet": "task", "zh": "神经音频编解码", "aliases": ["Codec"], "ancestorIds": []],
            ["id": "method.transformer", "facet": "method", "zh": "Transformer 架构", "aliases": [], "ancestorIds": []]
        ]
        let snapObj = try ClientProtocols.record("paper-tag-catalog-snapshot", fields: [
            "registrySha256": registrySHA,
            "concepts": concepts
        ])
        let versObj = try ClientProtocols.record("paper-tag-catalog-versions", fields: [
            "currentSha256": registrySHA,
            "snapshots": [snapObj]
        ])
        let snapBytes = try jsonBytes(snapObj)
        let versBytes = try jsonBytes(versObj)
        let snapSHA = sha(snapBytes)
        let versSHA = sha(versBytes)
        let tagCatalogs: [String: Any] = [
            "snapshot": [
                "url": "client/data/tag-catalog-snapshot.json",
                "bytes": snapBytes.count,
                "sha256": snapSHA,
                "contract": ClientProtocols.contract("paper-tag-catalog-snapshot"),
                "schemaFingerprint": ClientProtocols.schemaFingerprint("paper-tag-catalog-snapshot"),
                "registrySha256": registrySHA
            ],
            "versions": [
                "url": "client/data/tag-catalog-versions.json",
                "bytes": versBytes.count,
                "sha256": versSHA,
                "contract": ClientProtocols.contract("paper-tag-catalog-versions"),
                "schemaFingerprint": ClientProtocols.schemaFingerprint("paper-tag-catalog-versions"),
                "currentSha256": registrySHA
            ]
        ]
        return (snapBytes, snapSHA, versBytes, versSHA, tagCatalogs)
    }

    static func buildPaperAppearance(
        appearanceId: String,
        paperId: String?,
        identityStatus: String,
        sourceKind: String?,
        sourceVersionId: String?,
        versionLabel: String? = nil,
        sourceUrl: String? = nil,
        pdfUrl: String? = nil,
        pdfSha256: String? = nil,
        sourceVersionWarning: String? = nil,
        provenanceDisclosure: String? = nil,
        publicationStatus: String = "active",
        retraction: [String: Any]? = nil,
        originalTitle: String?,
        readerTitle: String,
        authors: [String],
        blogPublishedAt: String,
        articleUpdatedAt: String? = nil,
        score: Double? = 8.5,
        tagConceptIds: [String] = ["task.asr", "method.transformer"],
        htmlFragment: String,
        hasGuideContent: Bool = true,
        sidecars: [String: Data]? = nil,
        sidecarDateFolder: String? = nil,
        sidecarOwnerSlug: String? = nil,
        resources: [[String: Any]] = []
    ) throws -> BuiltAppearance {
        let articleBytes = Data(htmlFragment.utf8)
        let articleSHA = sha(articleBytes)
        let articleRel = "client/details/articles/\(articleSHA).html"
        let displayTitle = originalTitle ?? readerTitle
        let arxivVersioned = (sourceKind == "arxiv" && versionLabel != nil && paperId != nil)
            ? "\(String(paperId!.dropFirst(6)))\(versionLabel!)"
            : nil

        var citationFields: [String: Any] = [
            "paperKey": paperId ?? "page:/blog/\(appearanceId)",
            "paperId": (identityStatus == "verified" && sourceKind != "arxiv") ? (paperId ?? "") : "",
            "identityStatus": identityStatus,
            "verified": identityStatus == "verified",
            "complete": identityStatus == "verified" && !authors.isEmpty,
            "sourceKind": sourceKind ?? "",
            "title": displayTitle,
            "authors": authors,
            "date": blogPublishedAt,
            "doi": "",
            "venue": sourceKind == "conference" ? "ICASSP 2026" : "",
            "arxivId": arxivVersioned ?? (paperId?.hasPrefix("arxiv:") == true ? String(paperId!.dropFirst(6)) : ""),
            "url": sourceUrl ?? "",
            "sourceUrl": sourceUrl ?? "",
            "pdfUrl": pdfUrl ?? "",
            "pageUrl": "/blog/\(appearanceId)",
            "pageType": "paper"
        ]
        if let sourceVersionWarning {
            citationFields["sourceVersionWarning"] = sourceVersionWarning
        }
        let citationRecord = try ClientProtocols.record("paper-citation-source", fields: citationFields)

        var extraFiles: [String: Data] = [:]
        var sidecarsObj: [String: Any]
        if let sidecars, let folder = sidecarDateFolder, let slug = sidecarOwnerSlug {
            var filesMap: [String: Any] = [:]
            for name in ["citation.json", "citation.bib", "citation.ris", "rethink-context.json"] {
                let raw = sidecars[name]!
                let rel = "client/papers/\(folder)/\(slug)/\(name)"
                extraFiles["/blog/" + rel] = raw
                var entry: [String: Any] = [
                    "url": rel,
                    "bytes": raw.count,
                    "sha256": sha(raw)
                ]
                if name == "citation.json" {
                    entry["contract"] = ClientProtocols.contract("researcher-sidecars")
                    entry["schemaFingerprint"] = ClientProtocols.schemaFingerprint("researcher-sidecars")
                } else if name == "rethink-context.json" {
                    entry["contract"] = ClientProtocols.contract("paper-research-context")
                    entry["schemaFingerprint"] = ClientProtocols.schemaFingerprint("paper-research-context")
                }
                filesMap[name] = entry
            }
            sidecarsObj = ["available": true, "files": filesMap]
        } else {
            sidecarsObj = [
                "available": false,
                "files": [
                    "citation.json": NSNull(),
                    "citation.bib": NSNull(),
                    "citation.ris": NSNull(),
                    "rethink-context.json": NSNull()
                ]
            ]
        }

        let authorObjs: [[String: Any]] = authors.enumerated().map { idx, name in
            ["position": idx + 1, "name": name]
        }
        var appDict: [String: Any] = [
            "appearanceId": appearanceId,
            "pageUrl": appearanceId,
            "pageType": "paper",
            "publicationStatus": publicationStatus,
            "articleRevisionId": articleSHA
        ]
        if let retraction {
            appDict["retraction"] = retraction
        } else {
            appDict["retraction"] = NSNull()
        }

        let sourceVersionDict: [String: Any] = [
            "sourceVersionId": (sourceVersionId as Any?) ?? NSNull(),
            "versionLabel": (versionLabel as Any?) ?? NSNull(),
            "sourceUrl": (sourceUrl as Any?) ?? NSNull(),
            "pdfUrl": (pdfUrl as Any?) ?? NSNull(),
            "pdfSha256": (pdfSha256 as Any?) ?? NSNull(),
            "sourceVersionWarning": (sourceVersionWarning as Any?) ?? NSNull(),
            "provenanceDisclosure": (provenanceDisclosure as Any?) ?? NSNull()
        ]
        let articleRevisionDict: [String: Any] = [
            "articleRevisionId": articleSHA,
            "appearanceId": appearanceId,
            "articleDescriptor": [
                "url": articleRel,
                "bytes": articleBytes.count,
                "sha256": articleSHA
            ] as [String: Any],
            "hasGuideContent": hasGuideContent,
            "resourceCount": resources.count
        ]
        let titlesDict: [String: Any] = [
            "originalTitle": (originalTitle as Any?) ?? NSNull(),
            "readerTitle": readerTitle,
            "displayTitle": displayTitle
        ]
        let datesDict: [String: Any] = [
            "paperPublishedAt": blogPublishedAt,
            "blogPublishedAt": blogPublishedAt,
            "articleUpdatedAt": (articleUpdatedAt as Any?) ?? NSNull()
        ]
        let venueVal: Any = sourceKind == "conference" ? "ICASSP 2026" : NSNull()
        let arxivBareVal: Any = paperId?.hasPrefix("arxiv:") == true ? String(paperId!.dropFirst(6)) : NSNull()
        let bibliographicDict: [String: Any] = [
            "venue": venueVal,
            "doi": NSNull(),
            "arxivId": arxivBareVal,
            "arxivVersionedId": (arxivVersioned as Any?) ?? NSNull(),
            "categories": ["cs.SD"]
        ]
        let classificationDict: [String: Any] = [
            "primaryTask": "语音识别",
            "primaryTaskId": "task.asr",
            "primaryMethod": "Transformer 架构",
            "primaryMethodId": "method.transformer",
            "tagConceptIds": tagConceptIds,
            "tags": ["语音识别", "Transformer 架构"]
        ]
        let assessmentDict: [String: Any] = [
            "score": (score as Any?) ?? NSNull()
        ]
        let citationWrapperDict: [String: Any] = [
            "sourceRecord": citationRecord,
            "verified": identityStatus == "verified",
            "complete": identityStatus == "verified" && !authors.isEmpty,
            "missingFields": [String](),
            "fieldStatus": ["title": "verified"]
        ]
        let detailFields: [String: Any] = [
            "appearanceId": appearanceId,
            "paperId": (paperId as Any?) ?? NSNull(),
            "identityStatus": identityStatus,
            "sourceKind": (sourceKind as Any?) ?? NSNull(),
            "sourceVersion": sourceVersionDict,
            "appearance": appDict,
            "articleRevision": articleRevisionDict,
            "titles": titlesDict,
            "authors": authorObjs,
            "dates": datesDict,
            "bibliographic": bibliographicDict,
            "abstract": "Fixture abstract for \(displayTitle).",
            "oneSentenceThesis": "One-sentence thesis for \(displayTitle).",
            "classification": classificationDict,
            "assessment": assessmentDict,
            "citation": citationWrapperDict,
            "sidecars": sidecarsObj,
            "resources": resources
        ]
        let detailObj = try ClientProtocols.record("paper-desktop-detail", fields: detailFields)

        let detailBytes = try jsonBytes(detailObj)
        let detailSHA = sha(detailBytes)
        let detailRel = "client/details/papers/\(detailSHA).json"

        let catalogRow: [String: Any] = [
            "appearanceId": appearanceId,
            "paperId": (paperId as Any?) ?? NSNull(),
            "identityStatus": identityStatus,
            "sourceKind": (sourceKind as Any?) ?? NSNull(),
            "sourceVersionId": (sourceVersionId as Any?) ?? NSNull(),
            "pageType": "paper",
            "publicationStatus": publicationStatus,
            "title": displayTitle,
            "titleZh": readerTitle,
            "summary": "Summary for \(readerTitle)",
            "blogPublishedAt": blogPublishedAt,
            "articleUpdatedAt": (articleUpdatedAt as Any?) ?? NSNull(),
            "pageUrl": appearanceId,
            "score": (score as Any?) ?? NSNull(),
            "tagConceptIds": tagConceptIds,
            "articleRevisionId": articleSHA,
            "detail": [
                "url": detailRel,
                "bytes": detailBytes.count,
                "sha256": detailSHA
            ]
        ]

        return BuiltAppearance(
            catalogRow: catalogRow,
            detailRelativePath: detailRel,
            detailBytes: detailBytes,
            detailSHA: detailSHA,
            articleRelativePath: articleRel,
            articleBytes: articleBytes,
            articleSHA: articleSHA,
            extraSiteFiles: extraFiles
        )
    }

    static func buildAggregateAppearance(
        appearanceId: String,
        pageType: String,
        conferenceScope: String? = nil,
        title: String,
        titleZh: String,
        blogPublishedAt: String
    ) throws -> BuiltAppearance {
        let html = "<div id=\"article-body\" class=\"post-content\"><p>\(titleZh) 汇总导览正文。</p></div>"
        let articleBytes = Data(html.utf8)
        let articleSHA = sha(articleBytes)
        let articleRel = "client/details/articles/\(articleSHA).html"
        let dummyDetail = try jsonBytes(["aggregate": appearanceId])
        let detailSHA = sha(dummyDetail)
        let detailRel = "client/details/papers/\(detailSHA).json"
        var row: [String: Any] = [
            "appearanceId": appearanceId,
            "paperId": NSNull(),
            "identityStatus": "aggregate-page",
            "sourceKind": NSNull(),
            "sourceVersionId": NSNull(),
            "pageType": pageType,
            "publicationStatus": "active",
            "title": title,
            "titleZh": titleZh,
            "summary": "\(titleZh) 摘要",
            "blogPublishedAt": blogPublishedAt,
            "articleUpdatedAt": NSNull(),
            "pageUrl": appearanceId,
            "score": NSNull(),
            "tagConceptIds": [String](),
            "articleRevisionId": articleSHA,
            "detail": [
                "url": detailRel,
                "bytes": dummyDetail.count,
                "sha256": detailSHA
            ]
        ]
        if let conferenceScope {
            row["conferenceScope"] = conferenceScope
        }
        return BuiltAppearance(
            catalogRow: row,
            detailRelativePath: detailRel,
            detailBytes: dummyDetail,
            detailSHA: detailSHA,
            articleRelativePath: articleRel,
            articleBytes: articleBytes,
            articleSHA: articleSHA,
            extraSiteFiles: [
                "/blog/" + appearanceId: Data("<html><head><link rel='canonical' href='https://fixture.example/blog/\(appearanceId)'/></head><body><div id='article-body' class='post-content'><p>\(titleZh) 完整汇总网页正文。</p></div></body></html>".utf8)
            ]
        )
    }

    struct BuiltSnapshotBundle {
        let snapshotId: String
        let snapshotRelativePath: String
        let snapshotBytes: Data
        let manifestBytes: Data
        let siteFiles: [String: Data]
    }

    static func buildSnapshotBundle(
        appearances: [BuiltAppearance],
        paperCount: Int,
        tombstones: [[String: Any]] = [],
        sourceCommit: String = commitA,
        generatedAt: String = "2026-11-19T06:00:00Z",
        shardSize: Int = 3
    ) throws -> BuiltSnapshotBundle {
        let tax = try makeTaxonomyPair()
        var siteFiles: [String: Data] = [
            "/blog/client/data/tag-catalog-snapshot.json": tax.snapBytes,
            "/blog/client/data/tag-catalog-versions.json": tax.versBytes
        ]
        for app in appearances {
            siteFiles["/blog/" + app.detailRelativePath] = app.detailBytes
            siteFiles["/blog/" + app.articleRelativePath] = app.articleBytes
            for (k, v) in app.extraSiteFiles { siteFiles[k] = v }
        }

        var catalogShardDescs: [[String: Any]] = []
        let rows = appearances.map(\.catalogRow)
        var offset = 0
        while offset < rows.count {
            let chunk = Array(rows[offset..<min(offset + shardSize, rows.count)])
            let bytes = try jsonBytes(chunk)
            let h = sha(bytes)
            let rel = "client/details/catalog/\(h).json"
            siteFiles["/blog/" + rel] = bytes
            catalogShardDescs.append([
                "url": rel,
                "bytes": bytes.count,
                "sha256": h,
                "recordCount": chunk.count
            ])
            offset += shardSize
        }

        var tombstoneShardDescs: [[String: Any]] = []
        if !tombstones.isEmpty {
            let bytes = try jsonBytes(tombstones)
            let h = sha(bytes)
            let rel = "client/details/tombstones/\(h).json"
            siteFiles["/blog/" + rel] = bytes
            tombstoneShardDescs.append([
                "url": rel,
                "bytes": bytes.count,
                "sha256": h,
                "recordCount": tombstones.count
            ])
        }

        let snapshotObj = try ClientProtocols.record("paper-desktop-snapshot", fields: [
            "sourceCommit": sourceCommit,
            "catalogShards": catalogShardDescs,
            "recordCount": rows.count,
            "paperCount": paperCount,
            "appearanceCount": rows.count,
            "tombstoneShards": tombstoneShardDescs,
            "tombstoneCount": tombstones.count,
            "tagCatalogs": tax.tagCatalogsField
        ])
        let snapshotBytes = try jsonBytes(snapshotObj)
        let snapshotId = sha(snapshotBytes)
        let snapshotRel = "client/details/snapshots/\(snapshotId).json"
        siteFiles["/blog/" + snapshotRel] = snapshotBytes

        let manifestObj = try ClientProtocols.record("paper-desktop-manifest", fields: [
            "snapshotId": snapshotId,
            "snapshot": [
                "url": snapshotRel,
                "bytes": snapshotBytes.count,
                "sha256": snapshotId
            ],
            "generatedAt": generatedAt,
            "sourceCommit": sourceCommit,
            "basePath": "/blog/"
        ])
        let manifestBytes = try jsonBytes(manifestObj)
        siteFiles["/blog/client/details/manifest.json"] = manifestBytes

        return BuiltSnapshotBundle(
            snapshotId: snapshotId,
            snapshotRelativePath: snapshotRel,
            snapshotBytes: snapshotBytes,
            manifestBytes: manifestBytes,
            siteFiles: siteFiles
        )
    }

    static func installBundle(_ bundle: BuiltSnapshotBundle, on server: DesktopDetailsFixtureServer) async {
        for (path, data) in bundle.siteFiles {
            await server.put(path, data)
        }
    }

    // MARK: - Test 1: End-to-End Sync, Aggregates, Deduplication, Conference PDF, Notices & Content-Addressed Caching

    static func testEndToEndSyncAndContentAddressedReading() async throws {
        let dir = try makeTempDir("desktop-details-e2e")
        defer { try? FileManager.default.removeItem(at: dir) }
        let server = DesktopDetailsFixtureServer()

        // Prepare real local PDF bytes from repo prototype asset
        let samplePDF = try Data(contentsOf: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf"))
        let samplePDFSHA = sha(samplePDF)
        let confPDFURL = "https://www.isca-archive.org/icassp_2026/11462137.pdf"
        await server.put(confPDFURL, samplePDF)

        // Bundled image on site
        let figRel = "images/papers/2610-41381/fig1.png"
        let figSHA = sha(tinyPNG)
        await server.put("/blog/" + figRel, tinyPNG)

        // 4 sidecar files for verified arXiv paper
        let sidecarCommon: [String: Any] = [
            "arxivId": "2610.41381",
            "arxivVersionedId": "2610.41381v2",
            "id": "2610.41381v2",
            "absUrl": "https://arxiv.org/abs/2610.41381v2",
            "pdfUrl": "https://arxiv.org/pdf/2610.41381v2.pdf",
            "originalTitle": "Streaming Codec Modeling for Neural Speech",
            "type": "preprint"
        ]
        let sidecars: [String: Data] = [
            "citation.json": try jsonBytes(ClientProtocols.record("researcher-sidecars", fields: sidecarCommon)),
            "citation.bib": Data("@misc{arxiv261041381, title={Streaming Codec Modeling for Neural Speech}}\n".utf8),
            "citation.ris": Data("TY  - UNPB\nTI  - Streaming Codec Modeling for Neural Speech\nER  - \n".utf8),
            "rethink-context.json": try jsonBytes(ClientProtocols.record("paper-research-context", fields: sidecarCommon.merging(["abstract": "Verified sidecar context"]) { _, n in n }))
        ]

        // 1a & 1b: Multi-appearance verified arXiv paper (older + newer appearance)
        let arxivOlder = try buildPaperAppearance(
            appearanceId: "posts/2026-10-20-streaming-codec-v1/",
            paperId: "arxiv:2610.41381",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2610.41381v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2610.41381v1",
            pdfUrl: "https://arxiv.org/pdf/2610.41381v1.pdf",
            originalTitle: "Streaming Codec Draft Title",
            readerTitle: "流式神经编解码初版导读",
            authors: ["Alice Chen"],
            blogPublishedAt: "2026-10-20",
            score: 8.0,
            tagConceptIds: ["task.codec"],
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>初版导读正文。</p></div>"
        )
        let arxivNewer = try buildPaperAppearance(
            appearanceId: "posts/2026-11-02-streaming-codec-v2/",
            paperId: "arxiv:2610.41381",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2610.41381v2",
            versionLabel: "v2",
            sourceUrl: "https://arxiv.org/abs/2610.41381v2",
            pdfUrl: "https://arxiv.org/pdf/2610.41381v2.pdf",
            originalTitle: "Streaming Codec Modeling for Neural Speech",
            readerTitle: "面向神经语音的流式编解码建模",
            authors: ["Alice Chen", "Bob Lin"],
            blogPublishedAt: "2026-11-02",
            articleUpdatedAt: "2026-11-03T09:30:00Z",
            score: 9.2,
            tagConceptIds: ["task.codec", "method.transformer"],
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><h2>方法结构</h2><p>新版导读含公式 <math xmlns=\"http://www.w3.org/1998/Math/MathML\"><semantics><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow><annotation encoding=\"application/x-tex\">x + 1</annotation></semantics></math>。</p><figure><img src=\"/blog/\(figRel)\" alt=\"架构图\"/><figcaption>图1 流式架构</figcaption></figure></div>",
            sidecars: sidecars,
            sidecarDateFolder: "2026-11-02",
            sidecarOwnerSlug: "2610-41381",
            resources: [
                [
                    "resourceId": "res:fig-1",
                    "kind": "image",
                    "mediaType": "image/png",
                    "sourceUrl": "/blog/\(figRel)",
                    "availability": "bundled",
                    "requiredForOffline": true,
                    "descriptor": ["url": figRel, "bytes": tinyPNG.count, "sha256": figSHA],
                    "expectedSha256": figSHA
                ],
                [
                    "resourceId": "res:mathjax",
                    "kind": "math-renderer",
                    "mediaType": "application/javascript",
                    "sourceUrl": "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js",
                    "availability": "external",
                    "requiredForOffline": false,
                    "descriptor": NSNull(),
                    "expectedSha256": NSNull()
                ]
            ]
        )

        // 2: Verified conference paper (pdfUrl & authors only in detail JSON, enriched on demand)
        let confPaper = try buildPaperAppearance(
            appearanceId: "posts/icassp-2026-beamforming-11462137/",
            paperId: "conference:icassp:2026:paper:11462137",
            identityStatus: "verified",
            sourceKind: "conference",
            sourceVersionId: "conference:icassp:2026:paper:11462137@sha256:\(samplePDFSHA)",
            sourceUrl: "https://www.isca-archive.org/icassp_2026/11462137.html",
            pdfUrl: confPDFURL,
            pdfSha256: samplePDFSHA,
            provenanceDisclosure: "本文依据 ICASSP 2026 官方公开论文集 PDF 整理，含封存原文 SHA-256 核验。",
            originalTitle: "Low-Latency Neural Beamforming in Reverberant Rooms",
            readerTitle: "混响房间低延迟神经波束形成",
            authors: [" Clara Wu ", "David Zhang"].map { $0.trimmingCharacters(in: .whitespaces) },
            blogPublishedAt: "2026-10-28",
            score: 8.8,
            tagConceptIds: ["task.asr"],
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>ICASSP 会议论文精读正文。</p></div>"
        )

        // 3: Verified arXiv SHA-bound paper with sourceVersionWarning
        let warningText = "该导读生成时未锁死显式 vN 后缀，仅绑定当时分析的原文 PDF SHA-256。"
        let shaBoundArxiv = try buildPaperAppearance(
            appearanceId: "posts/2026-09-15-legacy-sha-bound/",
            paperId: "arxiv:2605.12345",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2605.12345@sha256:\(samplePDFSHA)",
            sourceUrl: "https://arxiv.org/abs/2605.12345",
            pdfSha256: samplePDFSHA,
            sourceVersionWarning: warningText,
            originalTitle: "Legacy SHA-Bound Acoustic Pretraining",
            readerTitle: "旧版哈希绑定声学预训练导读",
            authors: ["Eve Zhao"],
            blogPublishedAt: "2026-09-15",
            score: 7.9,
            tagConceptIds: ["task.asr"],
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>哈希绑定历史论文正文。</p></div>"
        )

        // 4a & 4b: Two unverified historical papers with IDENTICAL readerTitle (must NOT merge by title, originalTitle stays nil)
        let unverifiedA = try buildPaperAppearance(
            appearanceId: "posts/2025-12-01-unverified-note-a/",
            paperId: nil,
            identityStatus: "unverified-historical",
            sourceKind: nil,
            sourceVersionId: nil,
            provenanceDisclosure: "早期历史归档缺少可核验官方编号，按独立页面身份保留。",
            originalTitle: nil,
            readerTitle: "早期语音前端实验综述",
            authors: [],
            blogPublishedAt: "2025-12-01",
            score: nil,
            tagConceptIds: ["task.asr"],
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>第一篇未核验历史文章。</p></div>"
        )
        let unverifiedB = try buildPaperAppearance(
            appearanceId: "posts/2025-12-02-unverified-note-b/",
            paperId: nil,
            identityStatus: "unverified-historical",
            sourceKind: nil,
            sourceVersionId: nil,
            originalTitle: nil,
            readerTitle: "早期语音前端实验综述",
            authors: [],
            blogPublishedAt: "2025-12-02",
            score: nil,
            tagConceptIds: ["task.asr"],
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>第二篇同名但不同页面的未核验历史文章。</p></div>"
        )

        // 5a & 5b: Aggregate summary pages (daily & conference) — MUST NOT become Paper entries!
        let dailyAgg = try buildAggregateAppearance(
            appearanceId: "posts/2026-11-02-daily-digest/",
            pageType: "daily",
            title: "2026-11-02 Audio Paper Digest",
            titleZh: "2026-11-02 每日音频论文速递汇总",
            blogPublishedAt: "2026-11-02"
        )
        let confAgg = try buildAggregateAppearance(
            appearanceId: "posts/icassp-2026-overview/",
            pageType: "conference",
            conferenceScope: "overview",
            title: "ICASSP 2026 Speech Overview",
            titleZh: "ICASSP 2026 语音方向全景导览",
            blogPublishedAt: "2026-10-28"
        )

        // Total appearances = 8 (6 paper appearances -> 5 unique papers + 2 aggregate pages)
        let bundle1 = try buildSnapshotBundle(
            appearances: [arxivOlder, arxivNewer, confPaper, shaBoundArxiv, unverifiedA, unverifiedB, dailyAgg, confAgg],
            paperCount: 5,
            shardSize: 3
        )
        await installBundle(bundle1, on: server)

        let service = try makeService(dir, server)
        let summary1 = try await service.sync()
        try expect(summary1.recordCount == 8, "recordCount equals all 8 appearances")
        try expect(summary1.paperCount == 5, "paperCount deduplicates multi-appearance paper and excludes aggregates")
        try expect(summary1.shardCount == 3, "3 catalog shards verified")
        try expect(summary1.snapshotID == bundle1.snapshotId, "snapshotID matches verified snapshotId")
        try expect(!(await server.requests()).contains("/blog/client/index.json"), "desktop-details sync never falls back to client/index.json")

        let papers = await service.list(limit: 100)
        try expect(papers.count == 5, "5 distinct Paper entries in library")
        try expect(!papers.contains(where: { $0.title.contains("Digest") || $0.titleZh.contains("汇总") || $0.pageType != "paper" }), "aggregate pages never polluted Paper list")

        // Verify multi-appearance deduplication picked newer appearance & merged both appearances
        let mergedArxiv = papers.first(where: { $0.id == "arxiv:2610.41381" })!
        try expect(mergedArxiv.appearances.count == 2, "both appearances recorded on deduplicated paper")
        try expect(mergedArxiv.blogURL.hasSuffix("/posts/2026-11-02-streaming-codec-v2/"), "latest appearance selected as primary blogURL")
        try expect(mergedArxiv.sourceVersion == "2610.41381v2", "latest versioned arXiv sourceVersion selected")

        // Verify two same-title unverified papers remained distinct by page:... identity
        let unverifiedPapers = papers.filter { $0.identityStatus == "unverified-historical" }
        try expect(unverifiedPapers.count == 2 && Set(unverifiedPapers.map(\.id)).count == 2, "unverified historical papers never merged by title")

        // Verify aggregate catalog & aggregate document reading work 100% from paper-desktop-snapshot!
        let aggCatalog = try await service.aggregateCatalog()
        try expect(aggCatalog?.aggregateCount == 2 && aggCatalog?.sourceRecordCount == 8, "PublishedAggregateStore staged daily & conference aggregates from desktop snapshot")
        let dailyDescriptor = aggCatalog!.records.first(where: { $0.kind == .daily })!
        let originalAggRow = try await service.aggregateOriginalRow(id: dailyDescriptor.id)
        try expect(!originalAggRow.isEmpty, "aggregate originalRow cold-verified from desktop-details/catalog shard")
        let aggDoc = try await service.aggregateDocument(id: dailyDescriptor.id)
        try expect(aggDoc.plainText.contains("完整汇总网页正文"), "aggregate HTML page fetched and verified")

        // On-demand article reading for verified arXiv paper (bundled image + MathML + 4 sidecars)
        let arxivArticle = try await service.article(for: "arxiv:2610.41381")
        try expect(arxivArticle.revisionSHA256 == arxivNewer.articleSHA, "article revisionSHA256 bound to content-addressed articleRevisionId")
        try expect(arxivArticle.completeOffline == true, "bundled verified image grants honest completeOffline == true")
        try expect(arxivArticle.html.contains("data:image/png;base64,"), "bundled image localized to data URI")
        try expect(arxivArticle.plainText.contains("\\(x + 1\\)"), "MathML TeX annotation preserved in plainText")
        try expect(arxivArticle.citationSidecar != nil && arxivArticle.researchContext != nil, "sidecars verified and loaded")

        // Detail enrichment check via library.paperDetail
        let detailReply = try await service.handle(command: "library.paperDetail", payload: ["id": "arxiv:2610.41381"])
        let enrichedDict = detailReply["paper"] as? [String: Any]
        let rawDetailDict = detailReply["desktopDetail"] as? [String: Any]
        try expect((enrichedDict?["authors"] as? [String]) == ["Alice Chen", "Bob Lin"], "author order preserved from detail JSON")
        try expect(((rawDetailDict?["titles"] as? [String: Any])?["originalTitle"] as? String) == "Streaming Codec Modeling for Neural Speech", "originalTitle preserved in desktopDetail")
        try expect(((rawDetailDict?["titles"] as? [String: Any])?["readerTitle"] as? String) == "面向神经语音的流式编解码建模", "readerTitle kept distinct from originalTitle")

        // Unverified paper detail keeps originalTitle == null
        let unvID = "page:/blog/posts/2025-12-01-unverified-note-a/"
        let unvArticle = try await service.article(for: unvID)
        try expect(unvArticle.notices.contains(where: { $0.contains("早期历史归档缺少可核验官方编号") }), "provenanceDisclosure surfaced in notices")
        let unvDetailReply = try await service.handle(command: "library.paperDetail", payload: ["id": unvID])
        let unvRawDetail = unvDetailReply["desktopDetail"] as? [String: Any]
        try expect(((unvRawDetail?["titles"] as? [String: Any])?["originalTitle"]) is NSNull, "unverified paper never fabricates originalTitle from readerTitle")

        // Source-version warning preserved on SHA-bound arXiv paper
        let shaBoundArticle = try await service.article(for: "arxiv:2605.12345")
        try expect(shaBoundArticle.notices.contains(where: { $0.contains("未锁死显式 vN 后缀") }), "sourceVersionWarning preserved in article notices")

        // Conference paper: downloadPDF enriches pdfURL/sourceURL/pdfSHA256 on demand from papers/<sha>.json!
        let confDownload = try await service.downloadPDF(for: "conference:icassp:2026:paper:11462137")
        try expect(confDownload.sha256 == samplePDFSHA && confDownload.currentness == "published-sha256", "conference paper enriched on demand and verified against published pdfSha256")
        let confArticle = try await service.article(for: "conference:icassp:2026:paper:11462137")
        try expect(confArticle.notices.contains(where: { $0.contains("ICASSP 2026 官方公开论文集") }), "conference provenanceDisclosure preserved")

        // Citation sidecar export (bib & ris) directly from desktop detail without scraping HTML page
        await server.clearRequests()
        let bibExport = try await service.citationFile(for: "arxiv:2610.41381", format: "bib")
        let risExport = try await service.citationFile(for: "arxiv:2610.41381", format: "ris")
        try expect((bibExport["text"] as? String)?.contains("@misc{arxiv261041381") == true, "BibTeX exported via verified sidecar descriptor")
        try expect((risExport["text"] as? String)?.hasPrefix("TY  - UNPB") == true, "RIS exported via verified sidecar descriptor")
        try expect(!(await server.requests()).contains("/blog/posts/2026-11-02-streaming-codec-v2/"), "sidecar export did not scrape HTML page")

        // Snapshot update with unchanged detail/article SHAs -> 0 duplicate downloads of unchanged detail/article!
        let extraPaper = try buildPaperAppearance(
            appearanceId: "posts/2026-11-18-new-paper/",
            paperId: "arxiv:2611.09999",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.09999v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.09999v1",
            pdfUrl: "https://arxiv.org/pdf/2611.09999v1.pdf",
            originalTitle: "Zero-Shot Audio Foley Synthesis",
            readerTitle: "零样本拟音合成",
            authors: ["Frank Li"],
            blogPublishedAt: "2026-11-18",
            score: 8.6,
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>新增论文导读。</p></div>"
        )
        let bundle2 = try buildSnapshotBundle(
            appearances: [arxivOlder, arxivNewer, confPaper, shaBoundArxiv, unverifiedA, unverifiedB, extraPaper, dailyAgg, confAgg],
            paperCount: 6,
            sourceCommit: commitB,
            generatedAt: "2026-11-19T07:00:00Z",
            shardSize: 3
        )
        await installBundle(bundle2, on: server)
        await server.clearRequests()

        let summary2 = try await service.sync()
        try expect(summary2.paperCount == 6 && summary2.snapshotID == bundle2.snapshotId, "second snapshot synced cleanly")
        _ = try await service.article(for: "arxiv:2610.41381", refresh: true)
        try expect(await server.count(for: "/blog/" + arxivNewer.detailRelativePath) == 0, "0 duplicate downloads for unchanged content-addressed detail JSON across snapshot update")
        try expect(await server.count(for: "/blog/" + arxivNewer.articleRelativePath) == 0, "0 duplicate downloads for unchanged content-addressed article HTML across snapshot update")

        // Cold restart persistence check
        let restarted = try makeService(dir, server)
        try await restarted.waitUntilReady()
        let activeState = try await restarted.desktopDetailsSnapshot()
        try expect(await restarted.list(limit: 100).count == 6 && activeState?.snapshotID == bundle2.snapshotId, "cold restart restores StoredSnapshot and matching desktop-details/state.json")
        print("PASS 1: end-to-end sync, aggregates, multi-appearance deduplication, conference PDF, sidecars & 0-duplicate SHA cache")
    }

    // MARK: - Test 2: Offline Honesty, Dangerous HTML Rejection & Mid-Download Epoch Consistency

    static func testOfflineHonestyAndHTMLSecurityAndEpochGuard() async throws {
        let dir = try makeTempDir("desktop-details-security")
        defer { try? FileManager.default.removeItem(at: dir) }
        let server = DesktopDetailsFixtureServer()

        // 1. Paper with external uncached image -> completeOffline MUST be false!
        let missingExternalURL = "https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/0123456789ab/figure-1.png"
        await server.setStatus(missingExternalURL, 503)
        let extImagePaper = try buildPaperAppearance(
            appearanceId: "posts/2026-11-10-uncached-image/",
            paperId: "arxiv:2611.00001",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00001v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.00001v1",
            pdfUrl: "https://arxiv.org/pdf/2611.00001v1.pdf",
            originalTitle: "External Figure Paper",
            readerTitle: "外部图片未缓存测试",
            authors: ["Grace Ho"],
            blogPublishedAt: "2026-11-10",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>含外部图片。</p><img src=\"\(missingExternalURL)\" alt=\"ext\"/></div>",
            resources: [
                [
                    "resourceId": "res:ext-1",
                    "kind": "image",
                    "mediaType": "image/png",
                    "sourceUrl": missingExternalURL,
                    "availability": "external",
                    "requiredForOffline": true,
                    "descriptor": NSNull(),
                    "expectedSha256": NSNull()
                ]
            ]
        )

        // 2. Dangerous HTML payloads -> every single one MUST fail closed!
        let dangerousPayloads: [(String, String)] = [
            ("script", "<div id=\"article-body\"><p>Safe</p><script>alert(1)</script></div>"),
            ("iframe", "<div id=\"article-body\"><iframe src=\"https://evil.example/\"></iframe></div>"),
            ("object", "<div id=\"article-body\"><object data=\"https://evil.example/x\"></object></div>"),
            ("embed", "<div id=\"article-body\"><embed src=\"https://evil.example/x\"/></div>"),
            ("form", "<div id=\"article-body\"><form action=\"https://evil.example/\"></form></div>"),
            ("onclick", "<div id=\"article-body\"><p onclick=\"alert(1)\">Click</p></div>"),
            ("javascript-href", "<div id=\"article-body\"><a href=\"java&#x09;script:alert(1)\">Bad</a></div>"),
            ("file-src", "<div id=\"article-body\"><img src=\"file:///etc/passwd\"/></div>"),
            ("data-html", "<div id=\"article-body\"><a href=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">Bad</a></div>")
        ]
        var dangerousAppearances: [BuiltAppearance] = []
        for (idx, item) in dangerousPayloads.enumerated() {
            let num = String(format: "%05d", idx + 10)
            dangerousAppearances.append(try buildPaperAppearance(
                appearanceId: "posts/2026-11-10-bad-\(item.0)/",
                paperId: "arxiv:2611.\(num)",
                identityStatus: "verified",
                sourceKind: "arxiv",
                sourceVersionId: "arxiv:2611.\(num)v1",
                versionLabel: "v1",
                sourceUrl: "https://arxiv.org/abs/2611.\(num)v1",
                pdfUrl: "https://arxiv.org/pdf/2611.\(num)v1.pdf",
                originalTitle: "Unsafe \(item.0)",
                readerTitle: "危险标签测试 \(item.0)",
                authors: ["Mallory"],
                blogPublishedAt: "2026-11-10",
                htmlFragment: item.1
            ))
        }

        let allApps = [extImagePaper] + dangerousAppearances
        let bundle = try buildSnapshotBundle(appearances: allApps, paperCount: allApps.count)
        await installBundle(bundle, on: server)

        let service = try makeService(dir, server)
        _ = try await service.sync()

        let partialArticle = try await service.article(for: "arxiv:2611.00001", downloadImages: true)
        try expect(partialArticle.completeOffline == false, "uncached external image forces completeOffline == false")
        try expect(partialArticle.resources.first?.localPath == nil, "failed external image has nil localPath")

        for (idx, item) in dangerousPayloads.enumerated() {
            let pid = String(format: "arxiv:2611.%05d", idx + 10)
            let badApp = dangerousAppearances[idx]
            try await expectThrows("dangerous HTML (\(item.0)) must fail closed") {
                _ = try await service.article(for: pid)
            }
            let cachedHTMLFile = dir.appendingPathComponent("PublishedLibrary/desktop-details/articles/\(badApp.articleSHA).html")
            try expect(!FileManager.default.fileExists(atPath: cachedHTMLFile.path), "dangerous HTML (\(item.0)) never written to local article cache")
        }

        // 3. Mid-download epoch change: sync switches snapshot while article HTML is in flight -> must fail closed!
        let slowPaper1 = try buildPaperAppearance(
            appearanceId: "posts/2026-11-11-epoch-race/",
            paperId: "arxiv:2611.00200",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00200v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.00200v1",
            pdfUrl: "https://arxiv.org/pdf/2611.00200v1.pdf",
            originalTitle: "Epoch Race v1",
            readerTitle: "快照并发切换测试一",
            authors: ["Author"],
            blogPublishedAt: "2026-11-11",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>旧快照导读正文。</p></div>"
        )
        let slowPaper2 = try buildPaperAppearance(
            appearanceId: "posts/2026-11-11-epoch-race/",
            paperId: "arxiv:2611.00200",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00200v2",
            versionLabel: "v2",
            sourceUrl: "https://arxiv.org/abs/2611.00200v2",
            pdfUrl: "https://arxiv.org/pdf/2611.00200v2.pdf",
            originalTitle: "Epoch Race v2",
            readerTitle: "快照并发切换测试二",
            authors: ["Author"],
            blogPublishedAt: "2026-11-11",
            articleUpdatedAt: "2026-11-12T00:00:00Z",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>新快照导读正文。</p></div>"
        )
        let raceBundle1 = try buildSnapshotBundle(appearances: [slowPaper1], paperCount: 1, sourceCommit: commitA)
        let raceBundle2 = try buildSnapshotBundle(appearances: [slowPaper2], paperCount: 1, sourceCommit: commitB)
        await installBundle(raceBundle1, on: server)
        _ = try await service.sync()

        let targetArticlePath = "/blog/" + slowPaper1.articleRelativePath
        await server.setHook { path in
            guard path == targetArticlePath else { return }
            await server.setHook(nil)
            await installBundle(raceBundle2, on: server)
            _ = try await service.sync()
        }
        try await expectThrows("mid-download snapshot change must reject cross-epoch article") {
            _ = try await service.article(for: "arxiv:2611.00200", refresh: true)
        }
        await server.setHook(nil)
        let afterRaceArticle = try await service.article(for: "arxiv:2611.00200", refresh: true)
        try expect(afterRaceArticle.revisionSHA256 == slowPaper2.articleSHA, "subsequent read cleanly loads new snapshot revision")
        print("PASS 2: honest completeOffline, dangerous HTML rejection & mid-download epoch consistency")
    }

    // MARK: - Test 3: Fail-Closed Tamper/Error Rejection (Preserving Intact Previous Snapshot) vs 404/410 Fallback

    static func testFailClosedPreservationAnd404Fallback() async throws {
        // Part A: Transitional 404 / 410 fallback to client/index.json, vs HTTP 500 / invalid JSON never falling back!
        for fallbackStatus in [404, 410] {
            let dir = try makeTempDir("desktop-fallback-\(fallbackStatus)")
            defer { try? FileManager.default.removeItem(at: dir) }
            let server = DesktopDetailsFixtureServer()
            await server.setStatus("/blog/client/details/manifest.json", fallbackStatus)
            let legacyRow: [String: Any] = [
                "permalink": "/blog/posts/legacy-paper/",
                "pageType": "paper",
                "title": "Legacy Index Paper",
                "date": "2026-10-01",
                "sourceKind": "arxiv",
                "identityStatus": "verified",
                "arxivId": "2501.00009",
                "citation": [
                    "paperKey": "arxiv:2501.00009",
                    "identityStatus": "verified",
                    "sourceKind": "arxiv",
                    "arxivId": "2501.00009v1",
                    "sourceUrl": "https://arxiv.org/abs/2501.00009v1",
                    "pdfUrl": "https://arxiv.org/pdf/2501.00009v1.pdf"
                ]
            ]
            let shardBytes = try jsonBytes([legacyRow])
            let shardSHA = sha(shardBytes)
            let shardRel = "search-index/part-0001-\(shardSHA.prefix(12)).json"
            let clientManifest = try ClientProtocols.record("paper-search-index-manifest", fields: [
                "recordCount": 1,
                "totalBytes": shardBytes.count,
                "shards": [["url": shardRel, "bytes": shardBytes.count, "sha256": shardSHA, "recordCount": 1]]
            ])
            await server.put("/blog/client/index.json", try jsonBytes(clientManifest))
            await server.put("/blog/client/" + shardRel, shardBytes)

            let svc = try makeService(dir, server)
            let sum = try await svc.sync()
            try expect(sum.paperCount == 1, "HTTP \(fallbackStatus) on client/details/manifest.json cleanly falls through to client/index.json")
            try expect(try await svc.desktopDetailsSnapshot() == nil, "legacy fallback leaves activeDesktopDetails nil")
        }

        // HTTP 500 on client/details/manifest.json MUST NOT fall back to client/index.json!
        do {
            let dir = try makeTempDir("desktop-500-nofallback")
            defer { try? FileManager.default.removeItem(at: dir) }
            let server = DesktopDetailsFixtureServer()
            await server.setStatus("/blog/client/details/manifest.json", 500)
            await server.put("/blog/index.json", Data("[]".utf8))
            let svc = try makeService(dir, server)
            await server.clearRequests()
            try await expectThrows("HTTP 500 on client/details/manifest.json must fail closed") {
                _ = try await svc.sync()
            }
            try expect(await server.requests() == ["/blog/client/details/manifest.json"], "HTTP 500 did NOT fall back to client/index.json or index.json")
        }

        // Invalid JSON on client/details/manifest.json MUST NOT fall back to client/index.json!
        do {
            let dir = try makeTempDir("desktop-badjson-nofallback")
            defer { try? FileManager.default.removeItem(at: dir) }
            let server = DesktopDetailsFixtureServer()
            await server.put("/blog/client/details/manifest.json", Data("{truncated".utf8))
            await server.put("/blog/index.json", Data("[]".utf8))
            let svc = try makeService(dir, server)
            await server.clearRequests()
            try await expectThrows("invalid JSON on client/details/manifest.json must fail closed") {
                _ = try await svc.sync()
            }
            try expect(await server.requests() == ["/blog/client/details/manifest.json"], "invalid manifest JSON did NOT fall back to client/index.json")
        }

        // Part B: Establish a valid desktop-details snapshot on disk, then verify every tamper/404 case keeps it byte-for-byte intact!
        let dir = try makeTempDir("desktop-tamper-preserve")
        defer { try? FileManager.default.removeItem(at: dir) }
        let server = DesktopDetailsFixtureServer()

        let goodPaper = try buildPaperAppearance(
            appearanceId: "posts/2026-11-01-good/",
            paperId: "arxiv:2611.00301",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00301v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.00301v1",
            pdfUrl: "https://arxiv.org/pdf/2611.00301v1.pdf",
            originalTitle: "Baseline Intact Paper",
            readerTitle: "基线完好论文",
            authors: ["Author One"],
            blogPublishedAt: "2026-11-01",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>基线正文。</p></div>"
        )
        let goodBundle = try buildSnapshotBundle(appearances: [goodPaper], paperCount: 1, sourceCommit: commitA)
        await installBundle(goodBundle, on: server)

        let service = try makeService(dir, server)
        let goodSummary = try await service.sync()
        let goodState = try await service.desktopDetailsSnapshot()!
        let currentURL = dir.appendingPathComponent("PublishedLibrary/current.json")
        let stateRel = try LibraryService.desktopDetailsStateRelativePath(snapshotID: goodState.snapshotID, validationEpoch: goodState.validationEpoch)
        try expect(stateRel.hasPrefix("desktop-details/macos-states/"), "macOS state writes to desktop-details/macos-states/<snapshotID>-<epoch>.json")
        let stateURL = dir.appendingPathComponent("PublishedLibrary/" + stateRel)
        let savedCurrentBytes = try Data(contentsOf: currentURL)
        let savedStateBytes = try Data(contentsOf: stateURL)

        let candidatePaper2 = try buildPaperAppearance(
            appearanceId: "posts/2026-11-05-next/",
            paperId: "arxiv:2611.00302",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00302v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.00302v1",
            pdfUrl: "https://arxiv.org/pdf/2611.00302v1.pdf",
            originalTitle: "Candidate Next Paper",
            readerTitle: "候选新快照论文",
            authors: ["Author Two"],
            blogPublishedAt: "2026-11-05",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>新快照正文。</p></div>"
        )
        let nextBundle = try buildSnapshotBundle(appearances: [goodPaper, candidatePaper2], paperCount: 2, sourceCommit: commitB)

        func assertBaselineIntact(_ label: String) async throws {
            let status = await service.status()
            try expect(status.snapshotID == goodSummary.snapshotID && status.paperCount == 1, "\(label): in-memory snapshot preserved")
            try expect(try Data(contentsOf: currentURL) == savedCurrentBytes, "\(label): current.json bytes preserved")
            try expect(try Data(contentsOf: stateURL) == savedStateBytes, "\(label): epoch-scoped state JSON bytes preserved")
        }

        // Case 1: Unknown schemaFingerprint in manifest.json
        await installBundle(nextBundle, on: server)
        var badFPManifest = try JSONSerialization.jsonObject(with: nextBundle.manifestBytes) as! [String: Any]
        badFPManifest["schemaFingerprint"] = String(repeating: "f", count: 64)
        await server.put("/blog/client/details/manifest.json", try jsonBytes(badFPManifest))
        try await expectThrows("unknown manifest schemaFingerprint rejected") { _ = try await service.sync() }
        try await assertBaselineIntact("unknown-manifest-fingerprint")

        // Case 2: Mismatched basePath in manifest.json (while legacy /audio-paper-digest-blog/ is strictly accepted on nanless.github.io/audio-research-portal/)
        let portalSiteURL = URL(string: "https://nanless.github.io/audio-research-portal/")!
        let foreignSiteURL = URL(string: "https://evil.example/audio-research-portal/")!
        try expect(LibraryService.isAcceptedSiteBasePath("/audio-research-portal/", siteBaseURL: portalSiteURL), "current portal basePath accepted")
        try expect(LibraryService.isAcceptedSiteBasePath("/audio-paper-digest-blog/", siteBaseURL: portalSiteURL), "legacy v1.4.7 basePath accepted on nanless.github.io")
        try expect(!LibraryService.isAcceptedSiteBasePath("/other-blog/", siteBaseURL: portalSiteURL), "arbitrary basePath rejected")
        try expect(!LibraryService.isAcceptedSiteBasePath("/audio-paper-digest-blogging/", siteBaseURL: portalSiteURL), "prefix-spoofed basePath rejected")
        try expect(!LibraryService.isAcceptedSiteBasePath("/audio-paper-digest-blog/", siteBaseURL: foreignSiteURL), "legacy basePath rejected on foreign host")
        let legacyPaperURL = try LibraryService.sameSiteURL("https://nanless.github.io/audio-paper-digest-blog/posts/2026-11-18-demo/", siteBaseURL: portalSiteURL)
        try expect(legacyPaperURL.path == "/audio-paper-digest-blog/posts/2026-11-18-demo", "sameSiteURL accepts legacy v1.4.7 post URL on nanless.github.io")
        var badBaseManifest = try JSONSerialization.jsonObject(with: nextBundle.manifestBytes) as! [String: Any]
        badBaseManifest["basePath"] = "/other-blog/"
        await server.put("/blog/client/details/manifest.json", try jsonBytes(badBaseManifest))
        try await expectThrows("mismatched basePath rejected") { _ = try await service.sync() }
        try await assertBaselineIntact("mismatched-basePath")

        // Case 3: 1-byte SHA tamper on snapshot JSON
        await installBundle(nextBundle, on: server)
        var tamperedSnapshot = nextBundle.snapshotBytes
        tamperedSnapshot[tamperedSnapshot.count - 2] ^= 0x01
        await server.put("/blog/" + nextBundle.snapshotRelativePath, tamperedSnapshot)
        try await expectThrows("1-byte snapshot tamper rejected before JSON acceptance") { _ = try await service.sync() }
        try await assertBaselineIntact("snapshot-1byte-tamper")

        // Case 4: 1-byte SHA tamper on catalog shard
        await installBundle(nextBundle, on: server)
        let nextCatalogPath = nextBundle.siteFiles.keys.first(where: { $0.contains("/client/details/catalog/") })!
        var tamperedShard = nextBundle.siteFiles[nextCatalogPath]!
        tamperedShard[0] ^= 0x01
        await server.put(nextCatalogPath, tamperedShard)
        try await expectThrows("1-byte catalog shard tamper rejected") { _ = try await service.sync() }
        try await assertBaselineIntact("catalog-1byte-tamper")

        // Case 5: Missing (404) catalog shard
        await installBundle(nextBundle, on: server)
        await server.setStatus(nextCatalogPath, 404)
        try await expectThrows("404 catalog shard rejected") { _ = try await service.sync() }
        try await assertBaselineIntact("catalog-404")

        // Case 6: 1-byte SHA tamper & 404 on detail JSON and article HTML
        await installBundle(goodBundle, on: server)
        var tamperedDetail = goodPaper.detailBytes
        tamperedDetail[tamperedDetail.count - 2] ^= 0x01
        await server.put("/blog/" + goodPaper.detailRelativePath, tamperedDetail)
        try await expectThrows("1-byte detail tamper rejected") {
            _ = try await service.article(for: "arxiv:2611.00301", refresh: true)
        }
        await server.setStatus("/blog/" + goodPaper.detailRelativePath, 404)
        try await expectThrows("404 detail rejected") {
            _ = try await service.article(for: "arxiv:2611.00301", refresh: true)
        }
        await server.put("/blog/" + goodPaper.detailRelativePath, goodPaper.detailBytes)
        var tamperedArticle = goodPaper.articleBytes
        tamperedArticle[10] ^= 0x01
        await server.put("/blog/" + goodPaper.articleRelativePath, tamperedArticle)
        try await expectThrows("1-byte article HTML tamper rejected") {
            _ = try await service.article(for: "arxiv:2611.00301", refresh: true)
        }
        await server.setStatus("/blog/" + goodPaper.articleRelativePath, 404)
        try await expectThrows("404 article HTML rejected") {
            _ = try await service.article(for: "arxiv:2611.00301", refresh: true)
        }

        // Case 7: Crash-consistent state guard — missing or corrupt epoch-scoped state file fails closed on cold load,
        // while legacy macOS state at desktop-details/states/<snapshotID>-<epoch>.json still loads cleanly!
        try FileManager.default.removeItem(at: stateURL)
        try await expectThrows("missing epoch-scoped state file must fail closed on cold start") {
            let broken = try makeService(dir, server)
            try await broken.waitUntilReady()
        }
        let legacyStateDir = dir.appendingPathComponent("PublishedLibrary/desktop-details/states")
        try FileManager.default.createDirectory(at: legacyStateDir, withIntermediateDirectories: true)
        let legacyStateURL = legacyStateDir.appendingPathComponent("\(goodState.snapshotID)-\(goodState.validationEpoch).json")
        try savedStateBytes.write(to: legacyStateURL)
        do {
            let legacyReopened = try makeService(dir, server)
            try await legacyReopened.waitUntilReady()
            try expect(try await legacyReopened.desktopDetailsSnapshot()?.snapshotID == goodState.snapshotID, "legacy macOS state path in desktop-details/states loads cleanly")
        }
        try FileManager.default.removeItem(at: legacyStateURL)
        try Data("{corrupt".utf8).write(to: stateURL)
        try await expectThrows("corrupt epoch-scoped state file must fail closed on cold start") {
            let broken = try makeService(dir, server)
            try await broken.waitUntilReady()
        }
        try savedStateBytes.write(to: stateURL)

        // Case 8: 404 fallback after desktop-details snapshot cleans up desktopDetails & state files
        await server.setStatus("/blog/client/details/manifest.json", 404)
        let fallbackRow: [String: Any] = [
            "permalink": "/blog/posts/fallback-after-desktop/",
            "pageType": "paper",
            "title": "Fallback After Desktop",
            "date": "2026-11-19",
            "sourceKind": "arxiv",
            "identityStatus": "verified",
            "arxivId": "2501.00099",
            "citation": [
                "paperKey": "arxiv:2501.00099",
                "identityStatus": "verified",
                "sourceKind": "arxiv",
                "arxivId": "2501.00099v1",
                "sourceUrl": "https://arxiv.org/abs/2501.00099v1",
                "pdfUrl": "https://arxiv.org/pdf/2501.00099v1.pdf"
            ]
        ]
        let fbShard = try jsonBytes([fallbackRow])
        let fbSHA = sha(fbShard)
        let fbRel = "search-index/part-0001-\(fbSHA.prefix(12)).json"
        let fbManifest = try ClientProtocols.record("paper-search-index-manifest", fields: [
            "recordCount": 1,
            "totalBytes": fbShard.count,
            "shards": [["url": fbRel, "bytes": fbShard.count, "sha256": fbSHA, "recordCount": 1]]
        ])
        await server.put("/blog/client/index.json", try jsonBytes(fbManifest))
        await server.put("/blog/client/" + fbRel, fbShard)
        let fbSummary = try await service.sync()
        try expect(fbSummary.syncProtocol == nil, "404 fallback clears syncProtocol")
        try expect(try await service.desktopDetailsSnapshot() == nil, "404 fallback clears in-memory desktopDetails")
        try expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("PublishedLibrary/desktop-details/macos-states").path), "404 fallback cleans up desktop-details/macos-states")
        try expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("PublishedLibrary/desktop-details/states").path), "404 fallback cleans up desktop-details/states")
        let reopenedAfterFallback = try makeService(dir, server)
        try await reopenedAfterFallback.waitUntilReady()
        try expect(await reopenedAfterFallback.list(limit: 10).count == 1, "cold restart after 404 fallback succeeds cleanly")
        print("PASS 3: fail-closed tamper/404/500/missing-state preservation and clean 404/410 fallback")
    }

    // MARK: - Test 4: Tombstones (site-removed, retracted with evidenceUrl, replaced, restoration) & Personal Data Preservation

    static func testTombstonesAndPersonalDataPreservation() async throws {
        let dir = try makeTempDir("desktop-tombstones")
        defer { try? FileManager.default.removeItem(at: dir) }
        let server = DesktopDetailsFixtureServer()

        let paperKeep = try buildPaperAppearance(
            appearanceId: "posts/2026-11-01-keep/",
            paperId: "arxiv:2611.00400",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00400v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.00400v1",
            pdfUrl: "https://arxiv.org/pdf/2611.00400v1.pdf",
            originalTitle: "Permanent Paper",
            readerTitle: "常驻保留论文",
            authors: ["Author Keep"],
            blogPublishedAt: "2026-11-01",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>常驻论文正文。</p></div>"
        )
        let paperRemoved = try buildPaperAppearance(
            appearanceId: "posts/2026-11-01-removed/",
            paperId: "arxiv:2611.00401",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00401v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.00401v1",
            pdfUrl: "https://arxiv.org/pdf/2611.00401v1.pdf",
            originalTitle: "Temporarily Removed Paper",
            readerTitle: "临时下线后恢复的论文",
            authors: ["Author Removed"],
            blogPublishedAt: "2026-11-01",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>下线前导读正文。</p></div>"
        )
        let paperRetracted = try buildPaperAppearance(
            appearanceId: "posts/2026-11-01-retracted/",
            paperId: "arxiv:2611.00402",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00402v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.00402v1",
            pdfUrl: "https://arxiv.org/pdf/2611.00402v1.pdf",
            originalTitle: "Retracted Benchmark Paper",
            readerTitle: "撤稿基准测试论文",
            authors: ["Author Retracted"],
            blogPublishedAt: "2026-11-01",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>撤稿前保存的导读正文。</p></div>"
        )
        let paperOldSlug = try buildPaperAppearance(
            appearanceId: "posts/2026-11-01-old-slug/",
            paperId: "arxiv:2611.00403",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00403v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.00403v1",
            pdfUrl: "https://arxiv.org/pdf/2611.00403v1.pdf",
            originalTitle: "Slug Migrated Paper",
            readerTitle: "路径迁移替换论文",
            authors: ["Author Migrated"],
            blogPublishedAt: "2026-11-01",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>迁移前正文。</p></div>"
        )

        // Sync 1: All 4 papers active; read articles & seed personal notes, annotations, readingState, sessions, favorites, and Zotero mapping!
        let bundle1 = try buildSnapshotBundle(
            appearances: [paperKeep, paperRemoved, paperRetracted, paperOldSlug],
            paperCount: 4,
            sourceCommit: commitA,
            generatedAt: "2026-11-19T01:00:00Z"
        )
        await installBundle(bundle1, on: server)
        let service = try makeService(dir, server)
        _ = try await service.sync()
        _ = try await service.article(for: "arxiv:2611.00401")
        _ = try await service.article(for: "arxiv:2611.00402")

        let zoteroDir = dir.appendingPathComponent("zotero-archives", isDirectory: true)
        try FileManager.default.createDirectory(at: zoteroDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let zoteroSummaryURL = zoteroDir.appendingPathComponent("\(UUID().uuidString).summary.json")
        let zoteroBytes = try jsonBytes([
            "identity": "arxiv:2611.00402",
            "parentKey": "ZOTKEY01",
            "status": "complete"
        ])
        try zoteroBytes.write(to: zoteroSummaryURL, options: [.atomic])

        try await MainActor.run {
            let store = try DesktopStore(directory: dir)
            _ = try store.saveNote(id: "arxiv:2611.00401", text: "针对被移除论文的重要研究笔记", baseRevision: 0)
            _ = try store.saveNote(id: "arxiv:2611.00402", text: "针对撤稿论文的复现实验记录", baseRevision: 0)
            _ = try store.saveAnnotation(id: "arxiv:2611.00402", annotation: ["id": "ann-1", "page": 2, "quote": "Baseline WER", "note": "核对数据泄漏"])
            try store.saveReading(id: "arxiv:2611.00402", state: ["page": 4, "zoom": 1.25])
            try store.appendSession(["id": "sess-1", "paperID": "arxiv:2611.00402", "question": "实验对照是否成立？"])
            try store.setList("favorites", ids: ["arxiv:2611.00401", "arxiv:2611.00402"])
            try store.setList("reading", ids: ["arxiv:2611.00401"])
        }

        // Negative Tombstone Checks:
        // (a) retracted WITHOUT HTTPS evidenceUrl MUST fail closed!
        let paperNewSlug = try buildPaperAppearance(
            appearanceId: "posts/2026-11-10-new-slug/",
            paperId: "arxiv:2611.00403",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00403v2",
            versionLabel: "v2",
            sourceUrl: "https://arxiv.org/abs/2611.00403v2",
            pdfUrl: "https://arxiv.org/pdf/2611.00403v2.pdf",
            originalTitle: "Slug Migrated Paper",
            readerTitle: "路径迁移替换论文（新版）",
            authors: ["Author Migrated"],
            blogPublishedAt: "2026-11-10",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>迁移后新版正文。</p></div>"
        )
        let badRetractedBundle = try buildSnapshotBundle(
            appearances: [paperKeep, paperNewSlug],
            paperCount: 2,
            tombstones: [[
                "appearanceId": "posts/2026-11-01-retracted/",
                "paperId": "arxiv:2611.00402",
                "previousArticleRevisionId": paperRetracted.articleSHA,
                "reason": "retracted",
                "effectiveAt": "2026-11-19T02:00:00Z",
                "sourceCommit": commitB,
                "replacementAppearanceId": NSNull(),
                "evidenceUrl": NSNull(),
                "note": "缺少证据链接"
            ]],
            sourceCommit: commitB
        )
        await installBundle(badRetractedBundle, on: server)
        try await expectThrows("retracted tombstone without HTTPS evidenceUrl must fail closed") {
            _ = try await service.sync()
        }

        // (b) active/tombstone overlap (non-disjoint appearanceId) MUST fail closed!
        let overlapBundle = try buildSnapshotBundle(
            appearances: [paperKeep],
            paperCount: 1,
            tombstones: [[
                "appearanceId": "posts/2026-11-01-keep/",
                "paperId": "arxiv:2611.00400",
                "previousArticleRevisionId": paperKeep.articleSHA,
                "reason": "site-removed",
                "effectiveAt": "2026-11-19T02:00:00Z",
                "sourceCommit": commitB,
                "replacementAppearanceId": NSNull(),
                "evidenceUrl": NSNull(),
                "note": NSNull()
            ]],
            sourceCommit: commitB
        )
        await installBundle(overlapBundle, on: server)
        try await expectThrows("non-disjoint active and tombstone appearanceId must fail closed") {
            _ = try await service.sync()
        }

        // Sync 2: Valid tombstones for site-removed, retracted (with HTTPS evidenceUrl & note), and replaced!
        let validTombstones: [[String: Any]] = [
            [
                "appearanceId": "posts/2026-11-01-removed/",
                "paperId": "arxiv:2611.00401",
                "previousArticleRevisionId": paperRemoved.articleSHA,
                "reason": "site-removed",
                "effectiveAt": "2026-11-19T03:00:00Z",
                "sourceCommit": commitB,
                "replacementAppearanceId": NSNull(),
                "evidenceUrl": NSNull(),
                "note": "站点整理暂时下线"
            ],
            [
                "appearanceId": "posts/2026-11-01-retracted/",
                "paperId": "arxiv:2611.00402",
                "previousArticleRevisionId": paperRetracted.articleSHA,
                "reason": "retracted",
                "effectiveAt": "2026-11-19T03:00:00Z",
                "sourceCommit": commitB,
                "replacementAppearanceId": NSNull(),
                "evidenceUrl": "https://arxiv.org/abs/2611.00402v2",
                "note": "作者于 arXiv v2 正式声明撤稿"
            ],
            [
                "appearanceId": "posts/2026-11-01-old-slug/",
                "paperId": "arxiv:2611.00403",
                "previousArticleRevisionId": paperOldSlug.articleSHA,
                "reason": "replaced",
                "effectiveAt": "2026-11-19T03:00:00Z",
                "sourceCommit": commitB,
                "replacementAppearanceId": "posts/2026-11-10-new-slug/",
                "evidenceUrl": NSNull(),
                "note": "迁移至新规范路径"
            ]
        ]
        let bundle2 = try buildSnapshotBundle(
            appearances: [paperKeep, paperNewSlug],
            paperCount: 2,
            tombstones: validTombstones,
            sourceCommit: commitB,
            generatedAt: "2026-11-19T03:05:00Z"
        )
        await installBundle(bundle2, on: server)
        await server.remove("/blog/posts/2026-11-01-retracted/")
        await server.remove("/blog/posts/2026-11-01-removed/")

        let summary2 = try await service.sync()
        try expect(summary2.paperCount == 2, "active paperCount reflects 2 remaining papers")
        try expect(summary2.missingFromLatest == ["arxiv:2611.00401", "arxiv:2611.00402"], "removed & retracted papers recorded in missingFromLatest while replaced paper stays active")

        let listWithRetained = try await service.handle(command: "library.list", payload: ["limit": 100])
        try expect((listWithRetained["retainedCount"] as? Int) == 2, "retiredPapers retains both tombstoned papers locally")

        let state2 = try await service.desktopDetailsSnapshot()!
        try expect(state2.activeTombstones.count == 3, "all 3 tombstones recorded in state.json")
        try expect(state2.tombstoneHistory.filter { $0.kind == "removed" }.count == 3, "3 removal events recorded in tombstoneHistory")

        // Retracted paper detail & cached offline article surface retraction notice + evidenceUrl
        let retractedDetail = try await service.handle(command: "library.paperDetail", payload: ["id": "arxiv:2611.00402"])
        let tombArray = retractedDetail["tombstones"] as? [[String: Any]]
        try expect(tombArray?.first?["reason"] as? String == "retracted" && tombArray?.first?["evidenceUrl"] as? String == "https://arxiv.org/abs/2611.00402v2", "paperDetail exposes verified retraction tombstone and evidenceUrl")
        let retractedArticle = try await service.article(for: "arxiv:2611.00402")
        try expect(retractedArticle.notices.contains(where: { $0.contains("撤稿提示") && $0.contains("https://arxiv.org/abs/2611.00402v2") }), "cached article for retracted paper surfaces retraction notice and evidenceUrl")

        // Verify ALL personal data & Zotero mappings remained 100% intact!
        try await MainActor.run {
            let store = try DesktopStore(directory: dir)
            let snap = store.snapshot()
            let notes = snap["notes"] as? [String: [String: Any]]
            try expect((notes?["arxiv:2611.00401"]?["text"] as? String) == "针对被移除论文的重要研究笔记", "personal note on site-removed paper preserved")
            try expect((notes?["arxiv:2611.00402"]?["text"] as? String) == "针对撤稿论文的复现实验记录", "personal note on retracted paper preserved")
            try expect(store.annotations(id: "arxiv:2611.00402").count == 1, "PDF annotations on retracted paper preserved")
            try expect(((snap["readingState"] as? [String: [String: Any]])?["arxiv:2611.00402"]?["page"] as? Int) == 4, "readingState preserved")
            try expect(store.session("sess-1")?["question"] as? String == "实验对照是否成立？", "study session preserved")
            try expect((snap["favorites"] as? [String]) == ["arxiv:2611.00401", "arxiv:2611.00402"], "favorites preserved")
            try expect((snap["reading"] as? [String]) == ["arxiv:2611.00401"], "reading list preserved")
        }
        try expect(try Data(contentsOf: zoteroSummaryURL) == zoteroBytes, "Zotero archive mapping file untouched by tombstones")

        // Sync 3: Restore `posts/2026-11-01-removed/` back into active catalog -> exits activeTombstones & missingFromLatest while keeping history!
        let remainingTombstones = validTombstones.filter { ($0["appearanceId"] as? String) != "posts/2026-11-01-removed/" }
        let bundle3 = try buildSnapshotBundle(
            appearances: [paperKeep, paperRemoved, paperNewSlug],
            paperCount: 3,
            tombstones: remainingTombstones,
            sourceCommit: commitC,
            generatedAt: "2026-11-19T05:00:00Z"
        )
        await installBundle(bundle3, on: server)
        let summary3 = try await service.sync()
        try expect(summary3.paperCount == 3, "restored paper returned to active paperCount")
        try expect(summary3.missingFromLatest == ["arxiv:2611.00402"], "restored paper exited missingFromLatest")
        let state3 = try await service.desktopDetailsSnapshot()!
        try expect(state3.activeTombstones.count == 2 && !state3.activeTombstones.contains(where: { $0.appearanceId == "posts/2026-11-01-removed/" }), "restored appearance exited activeTombstones")
        let restoredEvents = state3.tombstoneHistory.filter { $0.kind == "restored" && $0.appearanceId == "posts/2026-11-01-removed/" }
        let priorRemovedEvents = state3.tombstoneHistory.filter { $0.kind == "removed" && $0.appearanceId == "posts/2026-11-01-removed/" }
        try expect(restoredEvents.count == 1 && priorRemovedEvents.count == 1, "tombstoneHistory preserves both removal and restoration audit events")
        print("PASS 4: tombstones (site-removed, retracted, replaced, restored) & personal data preservation")
    }

    // MARK: - Test 5: Real Exporter Legacy data/tag-catalog-*.json Pair (schemaFingerprint: null) Compatibility

    static func testLegacyTagCatalogNullSchemaFingerprintPair() async throws {
        let dir = try makeTempDir("desktop-legacy-taxonomy")
        defer { try? FileManager.default.removeItem(at: dir) }
        let server = DesktopDetailsFixtureServer()

        let concepts: [[String: Any]] = [
            ["id": "task.asr", "facet": "task", "zh": "语音识别", "aliases": ["ASR"], "ancestorIds": []]
        ]
        let snapHeader = try ClientProtocols.historicalHeader("paper-tag-catalog-snapshot", variant: "public-concept-hierarchy", fingerprints: nil)
        let snapObj = snapHeader.merging([
            "registrySha256": registrySHA,
            "concepts": concepts
        ]) { _, n in n }
        let versHeader = try ClientProtocols.historicalHeader("paper-tag-catalog-versions", variant: "sha-keyed-snapshot-set", fingerprints: nil)
        let versObj = versHeader.merging([
            "currentSha256": registrySHA,
            "snapshots": [snapObj]
        ]) { _, n in n }

        let snapBytes = try jsonBytes(snapObj)
        let versBytes = try jsonBytes(versObj)
        let snapSHA = sha(snapBytes)
        let versSHA = sha(versBytes)

        let paper = try buildPaperAppearance(
            appearanceId: "posts/2026-11-19-legacy-tax/",
            paperId: "arxiv:2611.00501",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00501v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.00501v1",
            pdfUrl: "https://arxiv.org/pdf/2611.00501v1.pdf",
            originalTitle: "Null Fingerprint Taxonomy Export Paper",
            readerTitle: "兼容旧路径无指纹分类词表快照测试",
            authors: ["Author Tax"],
            blogPublishedAt: "2026-11-19",
            tagConceptIds: ["task.asr"],
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>正文。</p></div>"
        )
        let shardBytes = try jsonBytes([paper.catalogRow])
        let shardSHA = sha(shardBytes)
        let shardRel = "client/details/catalog/\(shardSHA).json"

        let snapshotObj = try ClientProtocols.record("paper-desktop-snapshot", fields: [
            "sourceCommit": commitA,
            "catalogShards": [[
                "url": shardRel,
                "bytes": shardBytes.count,
                "sha256": shardSHA,
                "recordCount": 1
            ]],
            "recordCount": 1,
            "paperCount": 1,
            "appearanceCount": 1,
            "tombstoneShards": [[String: Any]](),
            "tombstoneCount": 0,
            "tagCatalogs": [
                "snapshot": [
                    "url": "data/tag-catalog-snapshot.json",
                    "bytes": snapBytes.count,
                    "sha256": snapSHA,
                    "contract": try ClientProtocols.historicalContract("paper-tag-catalog-snapshot", variant: "public-concept-hierarchy"),
                    "schemaFingerprint": NSNull(),
                    "registrySha256": registrySHA
                ] as [String: Any],
                "versions": [
                    "url": "data/tag-catalog-versions.json",
                    "bytes": versBytes.count,
                    "sha256": versSHA,
                    "contract": try ClientProtocols.historicalContract("paper-tag-catalog-versions", variant: "sha-keyed-snapshot-set"),
                    "schemaFingerprint": NSNull(),
                    "currentSha256": registrySHA
                ] as [String: Any]
            ] as [String: Any]
        ])
        let snapshotBytes = try jsonBytes(snapshotObj)
        let snapshotId = sha(snapshotBytes)
        let snapshotRel = "client/details/snapshots/\(snapshotId).json"
        let manifestObj = try ClientProtocols.record("paper-desktop-manifest", fields: [
            "snapshotId": snapshotId,
            "snapshot": ["url": snapshotRel, "bytes": snapshotBytes.count, "sha256": snapshotId],
            "generatedAt": "2026-11-19T06:30:00Z",
            "sourceCommit": commitA,
            "basePath": "/blog/"
        ])

        await server.put("/blog/client/details/manifest.json", try jsonBytes(manifestObj))
        await server.put("/blog/" + snapshotRel, snapshotBytes)
        await server.put("/blog/" + shardRel, shardBytes)
        await server.put("/blog/data/tag-catalog-snapshot.json", snapBytes)
        await server.put("/blog/data/tag-catalog-versions.json", versBytes)
        await server.put("/blog/" + paper.detailRelativePath, paper.detailBytes)
        await server.put("/blog/" + paper.articleRelativePath, paper.articleBytes)

        let service = try makeService(dir, server)
        let summary = try await service.sync()
        let listed = await service.list(limit: 10)
        try expect(summary.paperCount == 1 && listed.first?.task == "语音识别", "data/tag-catalog-*.json with JSON null schemaFingerprint verified cleanly")
        print("PASS 5: real exporter data/tag-catalog-*.json (schemaFingerprint: null) compatibility")
    }

    // MARK: - Test 6: Adversarial HTML5 State Machine, Positive Allowlists, Comment Ban & Hardened Inline SVG

    static func testAdversarialHTML5StateMachineAndAllowlists() throws {
        let pngB64 = tinyPNG.base64EncodedString()
        let cleanSVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 10 10\"><metadata>LaTeXML</metadata><defs><clipPath id=\"c1\"><rect width=\"10\" height=\"10\"/></clipPath><circle id=\"dot\" cx=\"5\" cy=\"5\" r=\"4\"/></defs><g style=\"clip-path: url('#c1'); --ltx-stroke-color:#000000\"><use xlink:href=\"#dot\"/></g></svg>"
        let cleanSVGB64 = Data(cleanSVG.utf8).base64EncodedString()
        let percentEncodedSVG = "data:image/svg+xml,%3Csvg%20id=%22S5.T1.pic1%22%20class=%22ltx_picture%22%20height=%229.84%22%20overflow=%22visible%22%20style=%22vertical-align:2.98px%22%20viewBox=%220%200%2078.74%209.84%22%20width=%2278.74%22%3E%3Cg%20style=%22--ltx-stroke-color:%23000000%22%3E%3Cpath%20style=%22stroke:none%22%20d=%22M0%200V9.84H.87V0z%22/%3E%3C/g%3E%3C/svg%3E"

        // Valid positive fragments that MUST pass (including valid UTF-8 U+FFFD in prose/alt and LaTeXML percent-encoded SVG)
        let validFragments: [(String, String)] = [
            ("table-align", "<table><tr><th style=\"text-align: center;\">Metric</th><td style=\"text-align: right\">98.4</td></tr></table>"),
            ("prose-valid-utf8-fffd", "<p>历史清洗文本（如表格中的“\u{FFFD}”字符）正常展示。</p><img src=\"https://fixture.example/a.png\" alt=\"字符 \u{FFFD} 示例\" title=\"标题 \u{FFFD}\"/>"),
            ("mailto-link", "<p><a href=\"mailto:author@example.edu\" rel=\"noopener\">Contact</a></p>"),
            ("data-png-img", "<figure><img src=\"data:image/png;base64,\(pngB64)\" alt=\"plot\"/></figure>"),
            ("data-svg-img", "<figure><img src=\"data:image/svg+xml;base64,\(cleanSVGB64)\" alt=\"diagram\"/></figure>"),
            ("data-svg-charset-b64", "<figure><img src=\"data:image/svg+xml;charset=utf-8;base64,\(cleanSVGB64)\" alt=\"diagram2\"/></figure>"),
            ("data-svg-percent-latexml", "<p><img src=\"\(percentEncodedSVG)\" alt=\"LaTeXML inline diagram\"/></p>"),
            ("icassp-placeholder-img", "<p><img src=\"icassp-img:fig-1\" alt=\"placeholder\"/></p>"),
            ("srcset-valid", "<img src=\"https://fixture.example/a.png\" srcset=\"https://fixture.example/a.png 1x, https://fixture.example/b.png 2x\" alt=\"x\"/>")
        ]
        for (name, html) in validFragments {
            try LibraryService.verifySafeDesktopArticleHTML("<div id=\"article-body\">\(html)</div>")
            checks += 1
            _ = name
        }

        // Adversarial fragments that MUST fail closed
        let badSVGSet = Data("<svg xmlns=\"http://www.w3.org/2000/svg\"><set attributeName=\"href\" to=\"javascript:alert(1)\"/></svg>".utf8).base64EncodedString()
        let badSVGAnimate = Data("<svg xmlns=\"http://www.w3.org/2000/svg\"><animate attributeName=\"x\" values=\"0;10\"/></svg>".utf8).base64EncodedString()
        let badSVGComment = Data("<svg xmlns=\"http://www.w3.org/2000/svg\"><!-- hidden --><circle cx=\"1\" cy=\"1\" r=\"1\"/></svg>".utf8).base64EncodedString()
        let badSVGExtRef = Data("<svg xmlns=\"http://www.w3.org/2000/svg\"><use href=\"https://evil.example/sprite.svg#x\"/></svg>".utf8).base64EncodedString()
        let badSVGStyleURL = Data("<svg xmlns=\"http://www.w3.org/2000/svg\"><g style=\"clip-path:url(https://evil.example/#c)\"><rect width=\"1\" height=\"1\"/></g></svg>".utf8).base64EncodedString()
        let badSVGCommentDesync = Data("<svg xmlns=\"http://www.w3.org/2000/svg\"><g style=\"clip-path: url('#a/*'); background-image: url(https://evil.example/leak.png); --x: ('*/b')\"><rect width=\"1\" height=\"1\"/></g></svg>".utf8).base64EncodedString()
        let badSVGImageSet = Data("<svg xmlns=\"http://www.w3.org/2000/svg\"><g style=\"background-image: image-set('leak.png' 1x)\"><rect width=\"1\" height=\"1\"/></g></svg>".utf8).base64EncodedString()
        let badSVGPresentationURL = Data("<svg xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(https://evil.example/sprite.svg#c)\"><rect width=\"1\" height=\"1\"/></g></svg>".utf8).base64EncodedString()
        let badSVGXlinkNS = Data("<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"https://evil.example/ns\"><rect width=\"1\" height=\"1\"/></svg>".utf8).base64EncodedString()
        let badSVGUnquoted = Data("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=0><circle cx=\"1\" cy=\"1\" r=\"1\"/></svg>".utf8).base64EncodedString()

        let invalidFragments: [(String, String)] = [
            ("xmp-tag", "<div id=\"article-body\"><xmp><img src=x onerror=alert(1)></xmp></div>"),
            ("numeric-nul-entity", "<div id=\"article-body\"><p>bad &#0; nul</p></div>"),
            ("numeric-surrogate-entity", "<div id=\"article-body\"><p>bad &#xd800; surrogate</p></div>"),
            ("numeric-overflow-attr", "<div id=\"article-body\"><img src=\"https://fixture.example/a.png\" alt=\"&#x110000;\"/></div>"),
            ("url-literal-fffd", "<div id=\"article-body\"><a href=\"https://fixture.example/\u{FFFD}\">X</a></div>"),
            ("named-sol-protocol-relative", "<div id=\"article-body\"><a href=\"&sol;&sol;evil.example/path\">X</a></div>"),
            ("named-bsol-url", "<div id=\"article-body\"><img src=\"&bsol;&bsol;evil.example/a.png\"/></div>"),
            ("svg-style-external-url", "<div id=\"article-body\"><img src=\"data:image/svg+xml;base64,\(badSVGStyleURL)\"/></div>"),
            ("svg-style-comment-desync", "<div id=\"article-body\"><img src=\"data:image/svg+xml;base64,\(badSVGCommentDesync)\"/></div>"),
            ("svg-style-image-set", "<div id=\"article-body\"><img src=\"data:image/svg+xml;base64,\(badSVGImageSet)\"/></div>"),
            ("svg-presentation-attr-url", "<div id=\"article-body\"><img src=\"data:image/svg+xml;base64,\(badSVGPresentationURL)\"/></div>"),
            ("svg-bad-xmlns-xlink", "<div id=\"article-body\"><img src=\"data:image/svg+xml;base64,\(badSVGXlinkNS)\"/></div>"),
            ("noscript-tag", "<div id=\"article-body\"><noscript>bad</noscript></div>"),
            ("template-tag", "<div id=\"article-body\"><template><script>alert(1)</script></template></div>"),
            ("inline-svg-tag", "<div id=\"article-body\"><svg><circle cx=\"1\" cy=\"1\" r=\"1\"/></svg></div>"),
            ("foreignobject-tag", "<div id=\"article-body\"><foreignobject>bad</foreignobject></div>"),
            ("comment-normal", "<div id=\"article-body\"><!-- stripped on export, forbidden in fragment --><p>Hi</p></div>"),
            ("comment-short", "<div id=\"article-body\"><!--><p>Hi</p></div>"),
            ("comment-bang", "<div id=\"article-body\"><!-- --!><p>Hi</p></div>"),
            ("unquoted-quote-smuggle", "<div id=\"article-body\"><a title=foo\"onclick=\"alert(1) href=\"https://fixture.example/\">X</a></div>"),
            ("unquoted-eq", "<div id=\"article-body\"><p class=a=b>X</p></div>"),
            ("duplicate-attr", "<div id=\"article-body\"><a href=\"https://fixture.example/1\" href=\"https://fixture.example/2\">X</a></div>"),
            ("closing-tag-attr", "<div id=\"article-body\"><p>X</p class=\"y\"></div>"),
            ("closing-tag-slash", "<div id=\"article-body\"><p>X</p/></div>"),
            ("void-closing-tag", "<div id=\"article-body\"><img src=\"https://fixture.example/a.png\"></img></div>"),
            ("ping-attr", "<div id=\"article-body\"><a href=\"https://fixture.example/\" ping=\"https://evil.example/track\">X</a></div>"),
            ("arbitrary-td-style", "<div id=\"article-body\"><table><tr><td style=\"background:url(https://evil.example)\">1</td></tr></table></div>"),
            ("p-style-disallowed", "<div id=\"article-body\"><p style=\"text-align: center\">1</p></div>"),
            ("zotero-scheme", "<div id=\"article-body\"><a href=\"zotero://select/items/0_ABC\">Z</a></div>"),
            ("smb-scheme", "<div id=\"article-body\"><a href=\"smb://fileserver/share\">S</a></div>"),
            ("paperapp-scheme", "<div id=\"article-body\"><a href=\"paperapp://app/index.html\">P</a></div>"),
            ("protocol-relative", "<div id=\"article-body\"><img src=\"//evil.example/x.png\"/></div>"),
            ("anchor-data-image", "<div id=\"article-body\"><a href=\"data:image/png;base64,\(pngB64)\">Download</a></div>"),
            ("srcset-data-image", "<div id=\"article-body\"><img srcset=\"data:image/png;base64,\(pngB64) 1x\"/></div>"),
            ("anchor-icassp-scheme", "<div id=\"article-body\"><a href=\"icassp-img:fig-1\">X</a></div>"),
            ("svg-set", "<div id=\"article-body\"><img src=\"data:image/svg+xml;base64,\(badSVGSet)\"/></div>"),
            ("svg-animate", "<div id=\"article-body\"><img src=\"data:image/svg+xml;base64,\(badSVGAnimate)\"/></div>"),
            ("svg-comment", "<div id=\"article-body\"><img src=\"data:image/svg+xml;base64,\(badSVGComment)\"/></div>"),
            ("svg-external-use", "<div id=\"article-body\"><img src=\"data:image/svg+xml;base64,\(badSVGExtRef)\"/></div>"),
            ("svg-unquoted-attr", "<div id=\"article-body\"><img src=\"data:image/svg+xml;base64,\(badSVGUnquoted)\"/></div>")
        ]
        for (name, html) in invalidFragments {
            var rejected = false
            do {
                try LibraryService.verifySafeDesktopArticleHTML(html)
            } catch {
                rejected = true
            }
            try expect(rejected, "adversarial HTML5 vector (\(name)) must fail closed")
        }
        print("PASS 6: adversarial HTML5 state machine, positive allowlists, comment ban & hardened inline SVG")
    }

    // MARK: - Test 7: Fail-Closed Error Propagation, expectedSha256, Trailing-Slash Path & Historical Sidecars

    static func testErrorPropagationAndExpectedShaAndHistoricalSidecars() async throws {
        try expect(!LibraryService.isSafeRelativePath("client/details/papers/abc/"), "trailing slash rejected by isSafeRelativePath")
        try expect(LibraryService.isSafeRelativePath("client/details/papers/abc.json"), "clean relative file path accepted")

        let dir = try makeTempDir("desktop-strict-errors")
        defer { try? FileManager.default.removeItem(at: dir) }
        let server = DesktopDetailsFixtureServer()

        // 1. Historical sidecar descriptors (researcher-sidecars-v1 & paper-research-context-v2 with null schemaFingerprint)
        let histCitationObj: [String: Any] = [
            "contract": "researcher-sidecars-v1",
            "schemaVersion": 1,
            "arxivId": "2611.00701",
            "arxivVersionedId": "2611.00701v1",
            "id": "2611.00701v1",
            "absUrl": "https://arxiv.org/abs/2611.00701v1",
            "pdfUrl": "https://arxiv.org/pdf/2611.00701v1.pdf",
            "originalTitle": "Historical Sidecar Paper",
            "type": "preprint"
        ]
        let histContextObj: [String: Any] = [
            "contract": "paper-research-context-v2",
            "schemaVersion": 2,
            "arxivId": "2611.00701",
            "arxivVersionedId": "2611.00701v1",
            "id": "2611.00701v1",
            "absUrl": "https://arxiv.org/abs/2611.00701v1",
            "pdfUrl": "https://arxiv.org/pdf/2611.00701v1.pdf",
            "originalTitle": "Historical Sidecar Paper",
            "abstract": "Historical v2 context abstract."
        ]
        let histCitBytes = try jsonBytes(histCitationObj)
        let histCtxBytes = try jsonBytes(histContextObj)
        let histBibBytes = Data("@misc{hist261100701, title={Historical Sidecar Paper}}\n".utf8)
        let histRisBytes = Data("TY  - UNPB\nTI  - Historical Sidecar Paper\nER  - \n".utf8)

        let extImgURL = "https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/fedcba987654/figure-1.png"
        await server.put(extImgURL, tinyPNG)
        let extBadImgURL = "https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/fedcba987654/figure-2.png"
        await server.put(extBadImgURL, tinyPNG)
        let wrongExpectedSHA = String(repeating: "e", count: 64)

        var baseApp = try buildPaperAppearance(
            appearanceId: "posts/2026-11-15-hist-sidecars/",
            paperId: "arxiv:2611.00701",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00701v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.00701v1",
            pdfUrl: "https://arxiv.org/pdf/2611.00701v1.pdf",
            originalTitle: "Historical Sidecar Paper",
            readerTitle: "历史附属文件与外部图哈希核验",
            authors: ["Hist Author"],
            blogPublishedAt: "2026-11-15",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>正文。</p><img src=\"\(extImgURL)\" alt=\"ext\"/></div>",
            resources: [[
                "resourceId": "res:ext-pinned",
                "kind": "image",
                "mediaType": "image/png",
                "sourceUrl": extImgURL,
                "availability": "external",
                "requiredForOffline": true,
                "descriptor": NSNull(),
                "expectedSha256": sha(tinyPNG)
            ]]
        )
        let mismatchExtApp = try buildPaperAppearance(
            appearanceId: "posts/2026-11-15-ext-sha-mismatch/",
            paperId: "arxiv:2611.00702",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00702v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.00702v1",
            pdfUrl: "https://arxiv.org/pdf/2611.00702v1.pdf",
            originalTitle: "External SHA Mismatch Paper",
            readerTitle: "外部图 expectedSha256 拒绝验证",
            authors: ["Ext Author"],
            blogPublishedAt: "2026-11-15",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>正文。</p><img src=\"\(extBadImgURL)\" alt=\"bad\"/></div>",
            resources: [[
                "resourceId": "res:ext-mismatch",
                "kind": "image",
                "mediaType": "image/png",
                "sourceUrl": extBadImgURL,
                "availability": "external",
                "requiredForOffline": true,
                "descriptor": NSNull(),
                "expectedSha256": wrongExpectedSHA
            ]]
        )
        // Patch detail JSON to carry historical sidecar descriptors (schemaFingerprint: null)
        var detailMut = try JSONSerialization.jsonObject(with: baseApp.detailBytes) as! [String: Any]
        let sideRoot = "client/papers/2026-11-15/2611-00701"
        detailMut["sidecars"] = [
            "available": true,
            "files": [
                "citation.json": ["url": "\(sideRoot)/citation.json", "bytes": histCitBytes.count, "sha256": sha(histCitBytes), "contract": "researcher-sidecars-v1", "schemaFingerprint": NSNull()],
                "citation.bib": ["url": "\(sideRoot)/citation.bib", "bytes": histBibBytes.count, "sha256": sha(histBibBytes)],
                "citation.ris": ["url": "\(sideRoot)/citation.ris", "bytes": histRisBytes.count, "sha256": sha(histRisBytes)],
                "rethink-context.json": ["url": "\(sideRoot)/rethink-context.json", "bytes": histCtxBytes.count, "sha256": sha(histCtxBytes), "contract": "paper-research-context-v2", "schemaFingerprint": NSNull()]
            ]
        ]
        let newDetailBytes = try jsonBytes(detailMut)
        let newDetailSHA = sha(newDetailBytes)
        let newDetailRel = "client/details/papers/\(newDetailSHA).json"
        var rowMut = baseApp.catalogRow
        rowMut["detail"] = ["url": newDetailRel, "bytes": newDetailBytes.count, "sha256": newDetailSHA]
        baseApp = BuiltAppearance(
            catalogRow: rowMut,
            detailRelativePath: newDetailRel,
            detailBytes: newDetailBytes,
            detailSHA: newDetailSHA,
            articleRelativePath: baseApp.articleRelativePath,
            articleBytes: baseApp.articleBytes,
            articleSHA: baseApp.articleSHA,
            extraSiteFiles: [
                "/blog/\(sideRoot)/citation.json": histCitBytes,
                "/blog/\(sideRoot)/citation.bib": histBibBytes,
                "/blog/\(sideRoot)/citation.ris": histRisBytes,
                "/blog/\(sideRoot)/rethink-context.json": histCtxBytes
            ]
        )

        let unenrichedConf = try buildPaperAppearance(
            appearanceId: "posts/2026-11-15-conf-err/",
            paperId: "conference:icassp:2026:paper:99999999",
            identityStatus: "verified",
            sourceKind: "conference",
            sourceVersionId: "conference:icassp:2026:paper:99999999@sha256:\(sha(tinyPNG))",
            sourceUrl: "https://www.isca-archive.org/icassp_2026/99999999.html",
            pdfUrl: "https://www.isca-archive.org/icassp_2026/99999999.pdf",
            pdfSha256: sha(tinyPNG),
            originalTitle: "Conference Error Propagation Paper",
            readerTitle: "会议详情错误传播验证",
            authors: ["Conf Author"],
            blogPublishedAt: "2026-11-15",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>正文。</p></div>"
        )

        let bundle = try buildSnapshotBundle(appearances: [baseApp, mismatchExtApp, unenrichedConf], paperCount: 3)
        await installBundle(bundle, on: server)
        let service = try makeService(dir, server)
        _ = try await service.sync()

        // Historical sidecars succeed + valid expectedSha256 external image succeeds, while mismatched expectedSha256 throws fail-closed!
        let histArt = try await service.article(for: "arxiv:2611.00701", downloadImages: true)
        try expect(histArt.citationSidecar != nil && histArt.researchContext != nil && histArt.completeOffline == true, "historical sidecar descriptors accepted and valid pinned external image cached")
        try await expectThrows("external image failing expectedSha256 throws fail-closed") {
            _ = try await service.article(for: "arxiv:2611.00702", downloadImages: true)
        }

        // Overwrite stale cached article JSON on disk with a bogus sidecar URL — citationFile MUST still use verified desktopDetail!
        let articleCacheURL = dir.appendingPathComponent("PublishedLibrary/articles/\(sha(Data("https://fixture.example/blog/posts/2026-11-15-hist-sidecars/".utf8))).json")
        var staleArticleJSON = try JSONSerialization.jsonObject(with: Data(contentsOf: articleCacheURL)) as! [String: Any]
        staleArticleJSON["citationFiles"] = ["citation.bib": "https://fixture.example/blog/bogus.bib"]
        staleArticleJSON["citationFileSHA256"] = ["citation.bib": String(repeating: "0", count: 64)]
        try jsonBytes(staleArticleJSON).write(to: articleCacheURL)
        let exportedBib = try await service.citationFile(for: "arxiv:2611.00701", format: "bib")
        try expect((exportedBib["text"] as? String)?.contains("@misc{hist261100701") == true, "citationFile prioritizes verified desktopDetail over stale cached article JSON")

        // Tamper conference detail with HTTP 500 -> paperDetail and downloadPDF MUST propagate failure (never swallow via try?)!
        await server.setStatus("/blog/" + unenrichedConf.detailRelativePath, 500)
        try await expectThrows("library.paperDetail propagates HTTP 500 on detail fetch") {
            _ = try await service.handle(command: "library.paperDetail", payload: ["id": "conference:icassp:2026:paper:99999999"])
        }
        try await expectThrows("downloadPDF propagates HTTP 500 on unenriched conference detail fetch") {
            _ = try await service.downloadPDF(for: "conference:icassp:2026:paper:99999999")
        }
        print("PASS 7: fail-closed detail error propagation, expectedSha256 enforcement & historical sidecars")
    }

    // MARK: - Test 8: @MainActor PaperDigestApp Conference Paper Bindings & Post-Await Paper-Switch Race Isolation

    @MainActor static func testMainActorConferenceBindingsAndPaperSwitchRace() async throws {
        _ = NSApplication.shared
        let dir = try makeTempDir("desktop-mainactor-race")
        defer { try? FileManager.default.removeItem(at: dir) }
        let server = DesktopDetailsFixtureServer()

        let samplePDF = try Data(contentsOf: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf"))
        let samplePDFSHA = sha(samplePDF)
        let confPDFURL = "https://www.isca-archive.org/icassp_2026/88888888.pdf"
        await server.put(confPDFURL, samplePDF)

        let confApp = try buildPaperAppearance(
            appearanceId: "posts/icassp-2026-conf-88888888/",
            paperId: "conference:icassp:2026:paper:88888888",
            identityStatus: "verified",
            sourceKind: "conference",
            sourceVersionId: "conference:icassp:2026:paper:88888888@sha256:\(samplePDFSHA)",
            sourceUrl: "https://www.isca-archive.org/icassp_2026/88888888.html",
            pdfUrl: confPDFURL,
            pdfSha256: samplePDFSHA,
            originalTitle: "MainActor Conference Binding Paper",
            readerTitle: "主线程会议绑定与离线归档测试",
            authors: ["Alice Conf", "Bob Conf"],
            blogPublishedAt: "2026-11-16",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>会议精读导读正文。</p></div>"
        )
        let otherApp = try buildPaperAppearance(
            appearanceId: "posts/2026-11-16-other-paper/",
            paperId: "arxiv:2611.00888",
            identityStatus: "verified",
            sourceKind: "arxiv",
            sourceVersionId: "arxiv:2611.00888v1",
            versionLabel: "v1",
            sourceUrl: "https://arxiv.org/abs/2611.00888v1",
            pdfUrl: "https://arxiv.org/pdf/2611.00888v1.pdf",
            originalTitle: "Other Paper B",
            readerTitle: "切换目标论文 B",
            authors: ["Carol"],
            blogPublishedAt: "2026-11-16",
            htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>论文 B 导读。</p></div>"
        )

        let bundle = try buildSnapshotBundle(appearances: [confApp, otherApp], paperCount: 2)
        await installBundle(bundle, on: server)

        let app = PaperDigestApp()
        app.directory = dir
        app.store = try DesktopStore(directory: dir)
        app.library = try makeService(dir, server)
        app.storage = DesktopStorage(directory: dir, store: app.store)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 700), configuration: config)
        web.loadHTMLString("<html><body><script>window.paperDigestFlushPendingNote=async()=>({saved:true});window.paperDigestArchiveHTML=()=>null;</script></body></html>", baseURL: nil)
        for _ in 0..<100 {
            if (try? await web.evaluateJavaScript("typeof window.paperDigestFlushPendingNote === 'function'")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        app.web = web

        _ = try await app.library.sync()
        let listing = try await app.library.handle(command: "library.list", payload: ["limit": 10])
        let rows = listing["papers"] as! [[String: Any]]
        let unenrichedConfRow = rows.first { $0["id"] as? String == "conference:icassp:2026:paper:88888888" }!
        let otherRow = rows.first { $0["id"] as? String == "arxiv:2611.00888" }!
        try expect(unenrichedConfRow["pdfURL"] is NSNull, "catalog row starts unenriched before detail load")

        // 1. Select unenriched conference paper via app.setPaper, then call openPDF() directly BEFORE library.article!
        _ = try await app.dispatch("app.setPaper", payload: unenrichedConfRow)
        try await app.openPDF()
        try expect(app.currentPDFSHA == samplePDFSHA && app.currentPaper["pdfURL"] as? String == confPDFURL, "openPDF refreshes same-snapshot conference paper and passes verifyPDFBinding")

        // 2. Fresh service directory to verify prepareOffline & archiveMaterials from unenriched conference row!
        let dir2 = try makeTempDir("desktop-mainactor-offline")
        defer { try? FileManager.default.removeItem(at: dir2) }
        let app2 = PaperDigestApp()
        app2.directory = dir2
        app2.store = try DesktopStore(directory: dir2)
        app2.library = try makeService(dir2, server)
        app2.storage = DesktopStorage(directory: dir2, store: app2.store)
        app2.web = web
        _ = try await app2.library.sync()
        let rows2 = (try await app2.library.handle(command: "library.list", payload: ["limit": 10]))["papers"] as! [[String: Any]]
        let unenrichedConfRow2 = rows2.first { $0["id"] as? String == "conference:icassp:2026:paper:88888888" }!

        _ = try await app2.dispatch("app.setPaper", payload: unenrichedConfRow2)
        let archived = try await app2.archiveMaterials([:])
        try expect(archived["pdfPath"] as? String != nil && (app2.currentPaper["authors"] as? [String]) == ["Alice Conf", "Bob Conf"], "archiveMaterials enriches conference paper and passes verifyArticleBinding + verifyPDFBinding")

        let dir3 = try makeTempDir("desktop-mainactor-pkg")
        defer { try? FileManager.default.removeItem(at: dir3) }
        let app3 = PaperDigestApp()
        app3.directory = dir3
        app3.store = try DesktopStore(directory: dir3)
        app3.library = try makeService(dir3, server)
        app3.storage = DesktopStorage(directory: dir3, store: app3.store)
        app3.web = web
        _ = try await app3.library.sync()
        let rows3 = (try await app3.library.handle(command: "library.list", payload: ["limit": 10]))["papers"] as! [[String: Any]]
        let unenrichedConfRow3 = rows3.first { $0["id"] as? String == "conference:icassp:2026:paper:88888888" }!
        _ = try await app3.dispatch("app.setPaper", payload: unenrichedConfRow3)
        let pkg = try await app3.prepareOffline { _ in }
        try expect(pkg["paperID"] as? String == "conference:icassp:2026:paper:88888888", "prepareOffline enriches conference paper and seals offline package")

        // 3. Post-await paper-switch race: switch to Paper B while Paper A's library.article is awaiting transport!
        let dir4 = try makeTempDir("desktop-mainactor-switch")
        defer { try? FileManager.default.removeItem(at: dir4) }
        let app4 = PaperDigestApp()
        app4.directory = dir4
        app4.store = try DesktopStore(directory: dir4)
        app4.library = try makeService(dir4, server)
        app4.storage = DesktopStorage(directory: dir4, store: app4.store)
        app4.web = web
        _ = try await app4.library.sync()
        let rows4 = (try await app4.library.handle(command: "library.list", payload: ["limit": 10]))["papers"] as! [[String: Any]]
        let confRow4 = rows4.first { $0["id"] as? String == "conference:icassp:2026:paper:88888888" }!
        _ = try await app4.dispatch("app.setPaper", payload: confRow4)

        let confArticlePath = "/blog/" + confApp.articleRelativePath
        await server.setHook { path in
            guard path == confArticlePath else { return }
            await server.setHook(nil)
            _ = try await app4.dispatch("app.setPaper", payload: otherRow)
        }
        try await expectThrows("in-flight library.article must abort when paper switched to B") {
            _ = try await app4.dispatch("library.article", payload: ["paperID": "conference:icassp:2026:paper:88888888"])
        }
        await server.setHook(nil)
        try expect(app4.currentPaperID == "arxiv:2611.00888" && app4.currentPaper["id"] as? String == "arxiv:2611.00888" && app4.currentArticle.isEmpty, "late Paper A completion never clobbered Paper B state")
        print("PASS 8: @MainActor conference bindings (openPDF, prepareOffline, archiveMaterials) & paper-switch race isolation")
    }

    // MARK: - Test 9: Round 3 Cross-Platform Android Backup Restore, Local Tamper/Symlink Cold-Replay Rejection & Strict Asset/Sidecar Gates

    static func testRound3PortableAndroidRestoreLocalTamperAndStrictAssetGates() async throws {
        // Part 9A: Portable .paperdigest Android state witness cold-verification & deterministic reconstruction on macOS
        do {
            let dir = try makeTempDir("desktop-android-portable")
            defer { try? FileManager.default.removeItem(at: dir) }
            let server = DesktopDetailsFixtureServer()

            let p1 = try buildPaperAppearance(
                appearanceId: "posts/2026-11-18-android-p1/",
                paperId: "arxiv:2611.00901",
                identityStatus: "verified",
                sourceKind: "arxiv",
                sourceVersionId: "arxiv:2611.00901v1",
                versionLabel: "v1",
                sourceUrl: "https://arxiv.org/abs/2611.00901v1",
                pdfUrl: "https://arxiv.org/pdf/2611.00901v1.pdf",
                originalTitle: "Android Portable Paper One",
                readerTitle: "跨端备份恢复测试论文一",
                authors: ["Portable Alice"],
                blogPublishedAt: "2026-11-18",
                htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>跨端恢复导读正文。</p></div>"
            )
            let p2 = try buildPaperAppearance(
                appearanceId: "posts/icassp-2026-android-p2/",
                paperId: "conference:icassp:2026:paper:90000001",
                identityStatus: "verified",
                sourceKind: "conference",
                sourceVersionId: "conference:icassp:2026:paper:90000001@sha256:\(sha(tinyPNG))",
                sourceUrl: "https://www.isca-archive.org/icassp_2026/90000001.html",
                pdfUrl: "https://www.isca-archive.org/icassp_2026/90000001.pdf",
                pdfSha256: sha(tinyPNG),
                originalTitle: "Android Portable Conference Paper",
                readerTitle: "跨端会议备份测试",
                authors: ["Portable Bob"],
                blogPublishedAt: "2026-11-18",
                htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>跨端会议导读。</p></div>"
            )
            let agg1 = try buildAggregateAppearance(
                appearanceId: "posts/2026-11-18-daily-summary/",
                pageType: "daily",
                title: "2026-11-18 Daily Digest",
                titleZh: "2026-11-18 每日论文速递",
                blogPublishedAt: "2026-11-18"
            )
            let tombRow: [String: Any] = [
                "appearanceId": "posts/2026-11-10-retracted-old/",
                "paperId": "arxiv:2611.00909",
                "previousArticleRevisionId": sha(Data("old-retracted-article".utf8)),
                "reason": "retracted",
                "effectiveAt": "2026-11-19T05:00:00Z",
                "sourceCommit": commitA,
                "replacementAppearanceId": NSNull(),
                "evidenceUrl": "https://arxiv.org/abs/2611.00909v2",
                "note": "Authors retracted results."
            ]
            let bundle = try buildSnapshotBundle(appearances: [p1, p2, agg1], paperCount: 2, tombstones: [tombRow], sourceCommit: commitA)
            await installBundle(bundle, on: server)

            let initialSvc = try makeService(dir, server)
            _ = try await initialSvc.sync()
            let macState = try await initialSvc.desktopDetailsSnapshot()!

            // Remove macOS state directory completely and install Android's state witness + tombstone history witness
            let pubLib = dir.appendingPathComponent("PublishedLibrary")
            try FileManager.default.removeItem(at: pubLib.appendingPathComponent("desktop-details/macos-states"))

            let androidAppearances: [[String: Any]] = [
                [
                    "appearanceId": "posts/2026-11-18-android-p1/",
                    "paperKey": "arxiv:2611.00901",
                    "blogURL": "https://fixture.example/blog/posts/2026-11-18-android-p1/",
                    "identityStatus": "verified",
                    "sourceKind": "arxiv",
                    "sourceVersionId": "arxiv:2611.00901v1",
                    "pageType": "paper",
                    "publicationStatus": "active",
                    "blogPublishedAt": "2026-11-18",
                    "articleUpdatedAt": NSNull(),
                    "articleRevisionId": p1.articleSHA,
                    "detail": ["url": p1.detailRelativePath, "bytes": p1.detailBytes.count, "sha256": p1.detailSHA]
                ],
                [
                    "appearanceId": "posts/icassp-2026-android-p2/",
                    "paperKey": "conference:icassp:2026:paper:90000001",
                    "blogURL": "https://fixture.example/blog/posts/icassp-2026-android-p2/",
                    "identityStatus": "verified",
                    "sourceKind": "conference",
                    "sourceVersionId": "conference:icassp:2026:paper:90000001@sha256:\(sha(tinyPNG))",
                    "pageType": "paper",
                    "publicationStatus": "active",
                    "blogPublishedAt": "2026-11-18",
                    "articleUpdatedAt": NSNull(),
                    "articleRevisionId": p2.articleSHA,
                    "detail": ["url": p2.detailRelativePath, "bytes": p2.detailBytes.count, "sha256": p2.detailSHA]
                ]
            ]
            let androidWitness: [String: Any] = [
                "format": "paperdigest-android-desktop-details-state",
                "version": 1,
                "snapshotId": macState.snapshotID,
                "sourceCommit": macState.sourceCommit,
                "validationEpoch": macState.validationEpoch,
                "appearances": androidAppearances,
                "primaryAppearanceIds": [
                    "arxiv:2611.00901": "posts/2026-11-18-android-p1/",
                    "conference:icassp:2026:paper:90000001": "posts/icassp-2026-android-p2/"
                ]
            ]
            let androidTombHistory: [String: Any] = [
                "format": "paperdigest-android-desktop-tombstone-history",
                "version": 1,
                "latestSnapshotId": macState.snapshotID,
                "validationEpoch": macState.validationEpoch,
                "latestSourceCommit": macState.sourceCommit,
                "events": [[
                    "eventType": "tombstone",
                    "snapshotId": macState.snapshotID,
                    "appearanceId": "posts/2026-11-10-retracted-old/",
                    "paperId": "arxiv:2611.00909",
                    "previousArticleRevisionId": sha(Data("old-retracted-article".utf8)),
                    "reason": "retracted",
                    "effectiveAt": "2026-11-19T05:00:00Z",
                    "sourceCommit": commitA,
                    "evidenceUrl": "https://arxiv.org/abs/2611.00909v2",
                    "note": "Authors retracted results.",
                    "observedAt": "2026-11-19T06:00:00Z"
                ]]
            ]
            let androidStatesDir = pubLib.appendingPathComponent("desktop-details/states")
            let androidTombStatesDir = pubLib.appendingPathComponent("desktop-details/tombstone-states")
            try FileManager.default.createDirectory(at: androidStatesDir, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: androidTombStatesDir, withIntermediateDirectories: true)
            let witnessFile = androidStatesDir.appendingPathComponent("\(macState.snapshotID)-\(macState.validationEpoch).json")
            let tombHistFile = androidTombStatesDir.appendingPathComponent("\(macState.snapshotID)-\(macState.validationEpoch).json")
            let savedWitnessBytes = try jsonBytes(androidWitness)
            try savedWitnessBytes.write(to: witnessFile)
            try jsonBytes(androidTombHistory).write(to: tombHistFile)

            // Cold-open LibraryService from Android portable state witness!
            let restoredSvc = try makeService(dir, server)
            try await restoredSvc.waitUntilReady()
            let restoredState = try await restoredSvc.desktopDetailsSnapshot()
            try expect(restoredState != nil, "Android portable desktop-details state witness reconstructed cleanly on macOS")
            try expect(restoredState?.paperDetails.count == 2 && restoredState?.aggregateDetails.count == 1, "reconstructed paperDetails & aggregateDetails match")
            try expect(restoredState?.activeTombstones.count == 1 && restoredState?.tombstoneHistory.count == 1, "reconstructed activeTombstones & imported tombstoneHistory match")
            let restoredArt = try await restoredSvc.article(for: "arxiv:2611.00901")
            try expect(restoredArt.plainText.contains("跨端恢复导读正文"), "on-demand article reading works after Android backup restore")

            // Negative 9A-1: Corrupt 1 byte of local catalog shard -> cold-open from Android witness MUST fail closed!
            let catDir = pubLib.appendingPathComponent("desktop-details/catalog")
            let catFile = try FileManager.default.contentsOfDirectory(at: catDir, includingPropertiesForKeys: nil).first!
            let origCatBytes = try Data(contentsOf: catFile)
            var badCatBytes = origCatBytes
            badCatBytes[0] ^= 0x01
            try badCatBytes.write(to: catFile)
            try await expectThrows("1-byte tampered catalog shard rejected during Android witness cold-verification") {
                let svc = try makeService(dir, server)
                try await svc.waitUntilReady()
            }
            try origCatBytes.write(to: catFile)

            // Negative 9A-2: Replace local tombstone shard with symlink -> cold-open MUST fail closed!
            let tombDir = pubLib.appendingPathComponent("desktop-details/tombstones")
            let tombFile = try FileManager.default.contentsOfDirectory(at: tombDir, includingPropertiesForKeys: nil).first!
            let origTombBytes = try Data(contentsOf: tombFile)
            let decoyFile = dir.appendingPathComponent("decoy-tomb.json")
            try origTombBytes.write(to: decoyFile)
            try FileManager.default.removeItem(at: tombFile)
            try FileManager.default.createSymbolicLink(at: tombFile, withDestinationURL: decoyFile)
            try await expectThrows("symlinked tombstone shard rejected during Android witness cold-verification") {
                let svc = try makeService(dir, server)
                try await svc.waitUntilReady()
            }
            try FileManager.default.removeItem(at: tombFile)
            try origTombBytes.write(to: tombFile)

            // Negative 9A-3: Missing local snapshot JSON -> cold-open MUST fail closed!
            let snapFile = pubLib.appendingPathComponent("desktop-details/snapshots/\(macState.snapshotID).json")
            let origSnapBytes = try Data(contentsOf: snapFile)
            try FileManager.default.removeItem(at: snapFile)
            try await expectThrows("missing snapshot JSON rejected during Android witness cold-verification") {
                let svc = try makeService(dir, server)
                try await svc.waitUntilReady()
            }
            try origSnapBytes.write(to: snapFile)

            // Negative 9A-4: Corrupted primaryAppearanceIds in Android witness -> cold-open MUST fail closed!
            var badWitness = androidWitness
            badWitness["primaryAppearanceIds"] = [
                "arxiv:2611.00901": "posts/nonexistent-appearance/",
                "conference:icassp:2026:paper:90000001": "posts/icassp-2026-android-p2/"
            ]
            try jsonBytes(badWitness).write(to: witnessFile)
            try await expectThrows("mismatched primaryAppearanceIds in Android witness rejected") {
                let svc = try makeService(dir, server)
                try await svc.waitUntilReady()
            }
            try savedWitnessBytes.write(to: witnessFile)
        }

        // Part 9B: Fail-closed rejection on corrupted or symlinked local content-addressed files (never silently re-download!)
        do {
            let dir = try makeTempDir("desktop-local-tamper-symlink")
            defer { try? FileManager.default.removeItem(at: dir) }
            let server = DesktopDetailsFixtureServer()

            let bundledRel = "client/details/assets/\(sha(tinyPNG)).png"
            await server.put("/blog/" + bundledRel, tinyPNG)
            let paperB = try buildPaperAppearance(
                appearanceId: "posts/2026-11-19-local-cache/",
                paperId: "arxiv:2611.00910",
                identityStatus: "verified",
                sourceKind: "arxiv",
                sourceVersionId: "arxiv:2611.00910v1",
                versionLabel: "v1",
                sourceUrl: "https://arxiv.org/abs/2611.00910v1",
                pdfUrl: "https://arxiv.org/pdf/2611.00910v1.pdf",
                originalTitle: "Local Cache Integrity Paper",
                readerTitle: "本地缓存防篡改与防符号链接验证",
                authors: ["Cache Guard"],
                blogPublishedAt: "2026-11-19",
                htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>缓存正文。</p><img src=\"https://fixture.example/blog/\(bundledRel)\" alt=\"fig\"/></div>",
                resources: [[
                    "resourceId": "res:bundled-png",
                    "kind": "image",
                    "mediaType": "image/png",
                    "sourceUrl": "https://fixture.example/blog/\(bundledRel)",
                    "availability": "bundled",
                    "requiredForOffline": true,
                    "descriptor": ["url": bundledRel, "bytes": tinyPNG.count, "sha256": sha(tinyPNG)],
                    "expectedSha256": sha(tinyPNG)
                ]]
            )
            let bundle = try buildSnapshotBundle(appearances: [paperB], paperCount: 1)
            await installBundle(bundle, on: server)
            let svc = try makeService(dir, server)
            _ = try await svc.sync()

            let firstArt = try await svc.article(for: "arxiv:2611.00910", downloadImages: true)
            try expect(firstArt.completeOffline == true, "initial bundled article + image cached cleanly")

            let pubLib = dir.appendingPathComponent("PublishedLibrary")
            let cachedArtHTML = pubLib.appendingPathComponent("desktop-details/articles/\(paperB.articleSHA).html")
            let cachedDetailJSON = pubLib.appendingPathComponent("desktop-details/papers/\(paperB.detailSHA).json")
            let cachedAssetPNG = pubLib.appendingPathComponent("assets/\(sha(tinyPNG)).png")

            // 9B-1: Tamper 1 byte of cached articles/<sha>.html while server still has valid bytes -> MUST throw fail-closed on BOTH refresh:false and refresh:true!
            let origHTML = try Data(contentsOf: cachedArtHTML)
            var tamperedHTML = origHTML
            tamperedHTML[5] ^= 0x01
            try tamperedHTML.write(to: cachedArtHTML)
            try await expectThrows("corrupted local cached article HTML fails closed on cold replay (refresh: false)") {
                _ = try await svc.article(for: "arxiv:2611.00910", refresh: false, downloadImages: true)
            }
            try await expectThrows("corrupted local cached article HTML fails closed instead of silent re-download (refresh: true)") {
                _ = try await svc.article(for: "arxiv:2611.00910", refresh: true, downloadImages: true)
            }
            try origHTML.write(to: cachedArtHTML)

            // 9B-2: Replace cached assets/<sha>.png with live symlink AND dangling symlink -> BOTH MUST throw fail-closed!
            let decoyPNG = dir.appendingPathComponent("decoy.png")
            try tinyPNG.write(to: decoyPNG)
            try FileManager.default.removeItem(at: cachedAssetPNG)
            try FileManager.default.createSymbolicLink(at: cachedAssetPNG, withDestinationURL: decoyPNG)
            try await expectThrows("live symlink at cached asset path fails closed (refresh: false)") {
                _ = try await svc.article(for: "arxiv:2611.00910", refresh: false, downloadImages: true)
            }
            try await expectThrows("live symlink at cached asset path fails closed (refresh: true)") {
                _ = try await svc.article(for: "arxiv:2611.00910", refresh: true, downloadImages: true)
            }
            try FileManager.default.removeItem(at: cachedAssetPNG)
            try FileManager.default.createSymbolicLink(atPath: cachedAssetPNG.path, withDestinationPath: dir.appendingPathComponent("dangling-missing.png").path)
            try await expectThrows("dangling symlink at cached asset path fails closed (refresh: false)") {
                _ = try await svc.article(for: "arxiv:2611.00910", refresh: false, downloadImages: true)
            }
            try await expectThrows("dangling symlink at cached asset path fails closed (refresh: true)") {
                _ = try await svc.article(for: "arxiv:2611.00910", refresh: true, downloadImages: true)
            }
            try FileManager.default.removeItem(at: cachedAssetPNG)
            try tinyPNG.write(to: cachedAssetPNG)

            // 9B-3: Tamper 1 byte of cached papers/<sha>.json -> paperDetail AND article(refresh: false / true) MUST throw fail-closed!
            var tamperedDetail = try Data(contentsOf: cachedDetailJSON)
            tamperedDetail[2] ^= 0x01
            try tamperedDetail.write(to: cachedDetailJSON)
            do {
                _ = try await svc.paperDetail(id: "arxiv:2611.00910")
                throw NSError(domain: "DesktopDetailsContractTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "Expected paperDetail to throw on tampered local detail JSON"])
            } catch {
                checks += 1
            }
            try await expectThrows("tampered local papers/<sha>.json fails closed on cold replay (refresh: false)") {
                _ = try await svc.article(for: "arxiv:2611.00910", refresh: false, downloadImages: true)
            }
            try await expectThrows("tampered local papers/<sha>.json fails closed on article refresh (refresh: true)") {
                _ = try await svc.article(for: "arxiv:2611.00910", refresh: true, downloadImages: true)
            }
        }

        // Part 9C: Strict fail-closed gates on declared sidecars, bundled assets, expectedSha256 404, and >64 MiB asset overflow
        do {
            let dir = try makeTempDir("desktop-strict-asset-sidecar-gates")
            defer { try? FileManager.default.removeItem(at: dir) }
            let server = DesktopDetailsFixtureServer()

            // 1. Paper with declared sidecars where citation.json is tampered / 404
            let sideCommon9C: [String: Any] = [
                "arxivId": "2611.00921",
                "arxivVersionedId": "2611.00921v1",
                "id": "2611.00921v1",
                "absUrl": "https://arxiv.org/abs/2611.00921v1",
                "pdfUrl": "https://arxiv.org/pdf/2611.00921v1.pdf",
                "originalTitle": "Tampered Sidecar Paper",
                "type": "preprint"
            ]
            let sidecars9C: [String: Data] = [
                "citation.json": try jsonBytes(ClientProtocols.record("researcher-sidecars", fields: sideCommon9C)),
                "citation.bib": Data("@misc{arxiv261100921, title={Tampered Sidecar Paper}}\n".utf8),
                "citation.ris": Data("TY  - UNPB\nTI  - Tampered Sidecar Paper\nER  - \n".utf8),
                "rethink-context.json": try jsonBytes(ClientProtocols.record("paper-research-context", fields: sideCommon9C.merging(["abstract": "Sidecar context"]) { _, n in n }))
            ]
            let badSidecarPaper = try buildPaperAppearance(
                appearanceId: "posts/2026-11-19-bad-sidecar/",
                paperId: "arxiv:2611.00921",
                identityStatus: "verified",
                sourceKind: "arxiv",
                sourceVersionId: "arxiv:2611.00921v1",
                versionLabel: "v1",
                sourceUrl: "https://arxiv.org/abs/2611.00921v1",
                pdfUrl: "https://arxiv.org/pdf/2611.00921v1.pdf",
                originalTitle: "Tampered Sidecar Paper",
                readerTitle: "附属文件防吞错验证",
                authors: ["Sidecar Author"],
                blogPublishedAt: "2026-11-19",
                htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>正文。</p></div>",
                sidecars: sidecars9C,
                sidecarDateFolder: "2026-11-19",
                sidecarOwnerSlug: "2611-00921"
            )

            // 2. Paper with bundled image asset returning 404 / 1-byte SHA tamper
            let bundledAssetRel = "client/details/assets/\(sha(tinyPNG)).png"
            await server.put("/blog/" + bundledAssetRel, tinyPNG)
            let bundledFailPaper = try buildPaperAppearance(
                appearanceId: "posts/2026-11-19-bundled-fail/",
                paperId: "arxiv:2611.00922",
                identityStatus: "verified",
                sourceKind: "arxiv",
                sourceVersionId: "arxiv:2611.00922v1",
                versionLabel: "v1",
                sourceUrl: "https://arxiv.org/abs/2611.00922v1",
                pdfUrl: "https://arxiv.org/pdf/2611.00922v1.pdf",
                originalTitle: "Bundled Asset Failure Paper",
                readerTitle: "捆绑资源防降级验证",
                authors: ["Bundled Author"],
                blogPublishedAt: "2026-11-19",
                htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>正文。</p><img src=\"https://fixture.example/blog/\(bundledAssetRel)\" alt=\"b\"/></div>",
                resources: [[
                    "resourceId": "res:bundled-must-verify",
                    "kind": "image",
                    "mediaType": "image/png",
                    "sourceUrl": "https://fixture.example/blog/\(bundledAssetRel)",
                    "availability": "bundled",
                    "requiredForOffline": true,
                    "descriptor": ["url": bundledAssetRel, "bytes": tinyPNG.count, "sha256": sha(tinyPNG)],
                    "expectedSha256": sha(tinyPNG)
                ]]
            )

            // 3. Paper with 5 x 16 MiB unpinned external PNGs (total 80 MiB > 64 MiB cap!)
            var largePNG = tinyPNG
            largePNG.append(Data(count: (16 * 1024 * 1024) - tinyPNG.count))
            var overflowResources: [[String: Any]] = []
            var overflowImgsHTML = ""
            for i in 1...5 {
                let u = "https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/00000000000\(i)/figure-1.png"
                await server.put(u, largePNG)
                overflowImgsHTML += "<img src=\"\(u)\" alt=\"f\(i)\"/>"
                overflowResources.append([
                    "resourceId": "res:large-\(i)",
                    "kind": "image",
                    "mediaType": "image/png",
                    "sourceUrl": u,
                    "availability": "external",
                    "requiredForOffline": true,
                    "descriptor": NSNull(),
                    "expectedSha256": NSNull()
                ])
            }
            let overflowPaper = try buildPaperAppearance(
                appearanceId: "posts/2026-11-19-overflow-64mib/",
                paperId: "arxiv:2611.00923",
                identityStatus: "verified",
                sourceKind: "arxiv",
                sourceVersionId: "arxiv:2611.00923v1",
                versionLabel: "v1",
                sourceUrl: "https://arxiv.org/abs/2611.00923v1",
                pdfUrl: "https://arxiv.org/pdf/2611.00923v1.pdf",
                originalTitle: "Cumulative 64 MiB Overflow Paper",
                readerTitle: "单篇 64 MiB 资源上限验证",
                authors: ["Overflow Author"],
                blogPublishedAt: "2026-11-19",
                htmlFragment: "<div id=\"article-body\" class=\"post-content\"><p>正文。</p>\(overflowImgsHTML)</div>",
                resources: overflowResources
            )

            let bundle = try buildSnapshotBundle(appearances: [badSidecarPaper, bundledFailPaper, overflowPaper], paperCount: 3)
            await installBundle(bundle, on: server)
            let svc = try makeService(dir, server)
            _ = try await svc.sync()

            // 9C-1: Declared citation.json sidecar 404 or 1-byte tamper MUST throw fail-closed (never swallowed into notices)!
            let citPath = badSidecarPaper.extraSiteFiles.keys.first(where: { $0.hasSuffix("/citation.json") })!
            await server.setStatus(citPath, 404)
            try await expectThrows("declared citation.json 404 fails closed") {
                _ = try await svc.article(for: "arxiv:2611.00921")
            }
            var tamperedCit = badSidecarPaper.extraSiteFiles[citPath]!
            tamperedCit[tamperedCit.count - 2] ^= 0x01
            await server.put(citPath, tamperedCit)
            try await expectThrows("declared citation.json 1-byte SHA tamper fails closed") {
                _ = try await svc.article(for: "arxiv:2611.00921")
            }

            // 9C-2: Bundled station asset 404 or 1-byte SHA tamper MUST throw fail-closed!
            await server.setStatus("/blog/" + bundledAssetRel, 404)
            try await expectThrows("bundled image HTTP 404 fails closed") {
                _ = try await svc.article(for: "arxiv:2611.00922", downloadImages: true)
            }
            var tamperedBundledPNG = tinyPNG
            tamperedBundledPNG[tamperedBundledPNG.count - 1] ^= 0x01
            await server.put("/blog/" + bundledAssetRel, tamperedBundledPNG)
            try await expectThrows("bundled image 1-byte SHA mismatch fails closed") {
                _ = try await svc.article(for: "arxiv:2611.00922", downloadImages: true)
            }

            // 9C-3: Cumulative image bytes exceeding 64 MiB MUST throw fail-closed out of article(for:)!
            try await expectThrows(">64 MiB cumulative article image bytes fails closed") {
                _ = try await svc.article(for: "arxiv:2611.00923", downloadImages: true)
            }

            // E-H2: Literal <figure> inside quoted attribute must not cause attribute breakout
            let attrHtml = #"<div id="article-body" class="post-content"><p title="see <figure> label">Safe prose</p><details open><summary>展开</summary><p>折叠内容</p></details></div>"#
            try LibraryService.verifySafeDesktopArticleHTML(attrHtml)
            let rewritten = LibraryService.rewriteHTML5TagsForTidy(attrHtml, tagMarker: "data-m", preserveTags: ["figure", "figcaption", "details", "summary"], containerTags: ["section", "article", "main"])
            try expect(rewritten.contains(#"title="see <figure> label""#), "E-H2: quoted attribute containing <figure> stays untouched")
            try expect(rewritten.contains(#"data-m="details""#), "E-H2: real <details> tag tokenized cleanly")
        }

        print("PASS 9: portable Android backup cold-verification, local tamper/symlink rejection & strict sidecar/bundled/64MiB gates")
    }

    static func testOptionalRealBlogCorpusSweepIfPresent() async throws {
        guard let rawDir = ProcessInfo.processInfo.environment["PD_REAL_BLOG_PUBLIC_DIR"], !rawDir.isEmpty else {
            return
        }
        let publicRoot = URL(fileURLWithPath: rawDir, isDirectory: true)
        let manifestFile = publicRoot.appendingPathComponent("client/details/manifest.json")
        guard FileManager.default.fileExists(atPath: manifestFile.path) else {
            throw LibraryService.ServiceError.invalid("PD_REAL_BLOG_PUBLIC_DIR 缺少 client/details/manifest.json: \(rawDir)")
        }

        let dir = try makeTempDir("desktop-real-blog-corpus")
        defer { try? FileManager.default.removeItem(at: dir) }
        let realSiteBase = URL(string: "https://nanless.github.io/audio-paper-digest-blog/")!

        let svc = try LibraryService(
            dataDirectory: dir,
            siteBaseURL: realSiteBase,
            seedDirectory: dir.appendingPathComponent("NoSeed", isDirectory: true),
            transport: { url, limit in
                let prefix = "/audio-paper-digest-blog/"
                guard url.host == "nanless.github.io", url.path.hasPrefix(prefix) else {
                    throw LibraryService.ServiceError.httpStatus(404)
                }
                let rel = String(url.path.dropFirst(prefix.count))
                let local = publicRoot.appendingPathComponent(rel)
                guard FileManager.default.fileExists(atPath: local.path) else {
                    throw LibraryService.ServiceError.httpStatus(404)
                }
                let bytes = try Data(contentsOf: local)
                guard bytes.count <= limit else {
                    throw LibraryService.ServiceError.invalid("Real file exceeds limit: \(rel)")
                }
                return bytes
            }
        )

        let summary = try await svc.sync()
        try expect(summary.paperCount > 8000, "real blog sync loaded >8000 deduplicated papers (\(summary.paperCount))")

        // Verify EVERY SINGLE exported HTML fragment & paper detail JSON in the real blog export!
        let articlesDir = publicRoot.appendingPathComponent("client/details/articles", isDirectory: true)
        let articleFiles = try FileManager.default.contentsOfDirectory(at: articlesDir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "html" }
        try expect(articleFiles.count > 8500, "real blog has >8500 content-addressed HTML fragments (\(articleFiles.count))")
        for file in articleFiles {
            let bytes = try Data(contentsOf: file)
            guard let html = String(data: bytes, encoding: .utf8) else {
                throw LibraryService.ServiceError.invalid("Invalid UTF-8 in real article: \(file.lastPathComponent)")
            }
            try LibraryService.verifySafeDesktopArticleHTML(html)
        }

        // End-to-end article(for:) checks on real edge-case papers (ICML conference w/ U+FFFD prose, percent-encoded SVG, base64 SVG, verified arXiv w/ bundled image & sidecars)
        let fffdArticle = try await svc.article(for: "conference:icml:2026:openreview-forum-id:aComqAqP6j", downloadImages: false)
        try expect(fffdArticle.plainText.contains("\u{FFFD}"), "real U+FFFD ICML conference article loads cleanly on macOS")

        let pctSvgArticle = try await svc.article(for: "arxiv:2606.26968", downloadImages: false)
        try expect(pctSvgArticle.html.contains("data:image/svg+xml,"), "real percent-encoded LaTeXML SVG preserved in macOS reader HTML")

        let b64SvgArticle = try await svc.article(for: "arxiv:2607.00548", downloadImages: false)
        try expect(b64SvgArticle.html.contains("data:image/svg+xml;base64,"), "real base64 LaTeXML SVG preserved in macOS reader HTML")

        let arxivBundled = try await svc.article(for: "arxiv:2611.19145", downloadImages: true)
        try expect(arxivBundled.completeOffline && arxivBundled.citationSidecar != nil && arxivBundled.researchContext != nil, "real 2026-11-17 arXiv paper with sidecars & bundled PNG reaches completeOffline")

        print("PASS 10 (REAL BLOG CORPUS): synced \(summary.paperCount) papers and verified all \(articleFiles.count) real HTML fragments")
    }

    static func main() async throws {
        setbuf(stdout, nil)
        try await testEndToEndSyncAndContentAddressedReading()
        try await testOfflineHonestyAndHTMLSecurityAndEpochGuard()
        try await testFailClosedPreservationAnd404Fallback()
        try await testTombstonesAndPersonalDataPreservation()
        try await testLegacyTagCatalogNullSchemaFingerprintPair()
        try testAdversarialHTML5StateMachineAndAllowlists()
        try await testErrorPropagationAndExpectedShaAndHistoricalSidecars()
        try await testMainActorConferenceBindingsAndPaperSwitchRace()
        try await testRound3PortableAndroidRestoreLocalTamperAndStrictAssetGates()
        try await testOptionalRealBlogCorpusSweepIfPresent()
        print("DesktopDetailsContractTests ALL PASS (\(checks) assertions)")
    }
}
