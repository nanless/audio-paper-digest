import Foundation
import CryptoKit
import PDFKit

/// Published-site data and disposable caches. Personal notes and credentials never enter this store.
actor LibraryService {
    enum ServiceError: LocalizedError {
        case invalid(String), unavailable(String), network(String), httpStatus(Int), cancelled
        var errorDescription: String? {
            switch self {
            case .invalid(let s), .unavailable(let s), .network(let s): return s
            case .httpStatus: return "网站资料暂不可用，未覆盖已保存版本。"
            case .cancelled: return "操作已取消，上一份完整资料库仍然可用。"
            }
        }
    }
    enum Sort: String, Sendable { case date, score, title, relevance }
    struct Paper: Codable, Sendable, Identifiable {
        var id: String
        var title: String
        var titleZh: String
        var authors: [String]
        var date: String
        var score: Double?
        var task: String
        var method: String
        var tags: [String]
        var sourceKind: String
        var identityStatus: String
        var pageType: String
        var blogURL: String
        var sourceURL: String?
        var pdfURL: String?
        var sourceVersion: String?
        var appearances: [String]
        var citation: JSONValue
        var websiteTagRecords: [JSONValue]? = nil
        var pdfSHA256: String? = nil
        var paperID: String { id }
    }
    struct Resource: Codable, Sendable {
        var sourceURL: String
        var kind: String
        var localPath: String?
        var sha256: String?
        var missingReason: String?
    }
    struct Article: Codable, Sendable {
        var paperID: String
        var html: String
        var markdown: String?
        var plainText: String
        var citation: JSONValue
        var resources: [Resource]
        var sourceURL: String
        var pdfURL: String?
        var sourceVersion: String?
        var fetchedAt: String
        var revisionSHA256: String
        var completeOffline: Bool
        var notices: [String]
        var citationSidecar: JSONValue? = nil
        var researchContext: JSONValue? = nil
        var citationFiles: [String: String]? = nil
        var citationFileSHA256: [String: String]? = nil
        var blogURL: String? = nil
        var catalogEpoch: String? = nil
        var isStale: Bool? = nil
        var cacheStatus: String? = nil
        var validationAttemptedAt: String? = nil
        var expectedSourceVersion: String? = nil
        var mathMLContract: String? = nil
    }
    struct PDFDownload: Codable, Sendable {
        var filePath: String
        var sha256: String
        var version: String?
        var sourceURL: String
        var bytes: Int
        var paperID: String? = nil
        var fetchedAt: String? = nil
        var validatedAt: String? = nil
        var validationAttemptedAt: String? = nil
        var catalogEpoch: String? = nil
        var cacheStatus: String? = nil
        var isStale: Bool? = nil
        var publicSHA256: String? = nil
        var currentness: String? = nil
        var notices: [String]? = nil
    }
    struct Summary: Codable, Sendable {
        var paperCount: Int
        var recordCount: Int
        var shardCount: Int
        var snapshotID: String
        var syncedAt: String?
        var source: String
        var syncing: Bool
        var missingFromLatest: [String]
        /// Set only while the published catalog is still being decoded, so a status read is
        /// never mistaken for an empty library. Persisted catalogs never carry it.
        var loading: Bool? = nil
        var message: String? = nil
        var syncProtocol: String? = nil
    }
    struct Progress: Sendable {
        var phase: String
        var message: String
        var completed: Int
        var total: Int
        var json: [String: Any] { ["phase": phase, "message": message, "completed": completed, "total": total] }
    }
    enum JSONValue: Codable, Sendable {
        case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if c.decodeNil() { self = .null }
            else if let v = try? c.decode(Bool.self) { self = .bool(v) }
            else if let v = try? c.decode(String.self) { self = .string(v) }
            else if let v = try? c.decode(Double.self) { self = .number(v) }
            else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
            else { self = .array(try c.decode([JSONValue].self)) }
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .object(let v): try c.encode(v)
            case .array(let v): try c.encode(v)
            case .string(let v): try c.encode(v)
            case .number(let v): try c.encode(v)
            case .bool(let v): try c.encode(v)
            case .null: try c.encodeNil()
            }
        }
        static func from(_ value: Any) throws -> JSONValue {
            try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]))
        }
    }
    struct StoredSnapshot: Codable, Sendable {
        static let family = "paperdigest-published-library"
        var format: String?
        var contract: String?
        var schemaFingerprint: String?
        var summary: Summary
        var papers: [Paper]
        var retiredPapers: [Paper]?
        var validationEpoch: String?
        var websiteTaxonomy: JSONValue?
        var websiteTaxonomyNotice: String?

        init(summary: Summary, papers: [Paper]) {
            contract = ClientProtocols.contract(Self.family)
            schemaFingerprint = ClientProtocols.schemaFingerprint(Self.family)
            self.summary = summary
            self.papers = papers
        }
        private enum CodingKeys: String, CodingKey {
            case format, contract, schemaFingerprint, summary, papers, retiredPapers, validationEpoch, websiteTaxonomy, websiteTaxonomyNotice
        }
        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            let legacy = fields.contains(.format)
            let header = try ClientProtocols.decodeHeader(decoder, Self.family, field: legacy ? "format" : "contract")
            if legacy { format = header.raw } else { contract = header.raw }
            schemaFingerprint = header.fingerprint
            summary = try fields.decode(Summary.self, forKey: .summary)
            papers = try fields.decode([Paper].self, forKey: .papers)
            retiredPapers = try fields.decodeIfPresent([Paper].self, forKey: .retiredPapers)
            validationEpoch = try fields.decodeIfPresent(String.self, forKey: .validationEpoch)
            websiteTaxonomy = try fields.decodeIfPresent(JSONValue.self, forKey: .websiteTaxonomy)
            websiteTaxonomyNotice = try fields.decodeIfPresent(String.self, forKey: .websiteTaxonomyNotice)
        }
    }
    private struct Shard: Decodable, Sendable {
        var url: String
        var bytes: Int
        var sha256: String
        var recordCount: Int
    }
    private struct Manifest: Decodable {
        var contract: String
        var recordCount: Int
        var totalBytes: Int
        var shards: [Shard]
    }
    typealias Transport = @Sendable (URL, Int) async throws -> Data
    /// The complete published state decoded off the calling thread during startup.
    private struct LoadedLibrary: Sendable {
        let snapshot: StoredSnapshot
        let fullTextIndex: [String: String]
        let desktopDetails: DesktopDetailsState?
    }
    /// Startup reads only the small local catalog eagerly. The published catalog can be tens of
    /// megabytes, so a larger one stays pending until `ensureReady()` waits for the background
    /// decode. Commands never treat that pending state as an empty library.
    private enum LoadPhase: Equatable { case loading, ready, failed(String) }
    let directory: URL
    let privateDirectory: URL
    let siteBaseURL: URL
    let transport: Transport?
    let session: URLSession
    var snapshot: StoredSnapshot
    var desktopDetails: DesktopDetailsState?
    private var loadPhase: LoadPhase = .loading
    private var loadTask: Task<LoadedLibrary, Error>?
    private var loadID: UUID?
    private var syncTask: Task<Summary, Error>?
    var syncID: UUID?
    var httpProxy: URL?
    var cachedResourceBadges: [String: [String: Any]]?
    var resourceBadgesLoaded: Bool = false
    var cachedDemoPaperIDs: [String]?
    private var fullTextIndex: [String: String] = [:]
    private let seedDirectory: URL?
    static let maxTotal = 64 * 1024 * 1024
    /// Small catalogs are decoded by the initializer exactly as before: a restart is immediate and
    /// a malformed local file is reported at launch. Only the large published catalog is deferred.
    private static let eagerDecodeLimit = 8 * 1024 * 1024

    init(dataDirectory: URL, siteBaseURL: URL = URL(string: "https://nanless.github.io/audio-research-portal/")!, seedDirectory: URL? = nil, transport: Transport? = nil, sessionConfiguration: URLSessionConfiguration? = nil) throws {
        guard siteBaseURL.scheme == "https", siteBaseURL.host != nil, siteBaseURL.user == nil,
              siteBaseURL.password == nil, siteBaseURL.query == nil, siteBaseURL.fragment == nil,
              siteBaseURL.absoluteString.hasSuffix("/") else { throw ServiceError.invalid("资料站点必须为不含凭据的 HTTPS 目录。") }
        privateDirectory = dataDirectory
        directory = dataDirectory.appendingPathComponent("PublishedLibrary", isDirectory: true)
        self.siteBaseURL = siteBaseURL
        self.transport = transport
        let config = sessionConfiguration ?? URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 45
        config.timeoutIntervalForResource = 120
        config.urlCache = nil
        config.httpCookieStorage = nil
        session = URLSession(configuration: config)
        let seedDirectory = seedDirectory ?? Bundle.main.resourceURL?.appendingPathComponent("Seed", isDirectory: true)
        self.seedDirectory = seedDirectory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // The window's first frame must not wait for the published catalog: only a small local
        // catalog is decoded eagerly. A large one stays pending until a command awaits the gate.
        let current = directory.appendingPathComponent("current.json")
        let currentExists = FileManager.default.fileExists(atPath: current.path)
        var eagerSnapshot: StoredSnapshot?
        if currentExists {
            let size = ((try FileManager.default.attributesOfItem(atPath: current.path))[.size] as? NSNumber)?.intValue ?? 0
            if size <= Self.eagerDecodeLimit {
                let bytes = try Data(contentsOf: current)
                guard bytes.count <= Self.maxTotal else { throw ServiceError.invalid("本地目录超过大小限制，请保留原文件后恢复备份。") }
                if bytes.count <= Self.eagerDecodeLimit {
                    let decoded = try JSONDecoder().decode(StoredSnapshot.self, from: bytes)
                    eagerSnapshot = decoded
                    desktopDetails = try Self.loadDesktopDetailsState(directory: directory, snapshot: decoded, siteBaseURL: siteBaseURL)
                }
            }
        }
        if let eagerSnapshot { snapshot = eagerSnapshot }
        else if !currentExists, let seeded = Self.seedSnapshot(seedDirectory: seedDirectory, siteBaseURL: siteBaseURL) { snapshot = seeded }
        else { snapshot = Self.emptySnapshot() }
        let libraryDirectory = directory
        let eagerlyLoaded = eagerSnapshot
        let eagerDetails = desktopDetails
        loadID = UUID()
        loadTask = Task.detached(priority: .utility) {
            try Self.loadContent(directory: libraryDirectory, seedDirectory: seedDirectory, siteBaseURL: siteBaseURL, eagerlyLoaded: eagerlyLoaded, eagerlyLoadedDetails: eagerDetails)
        }
    }

    /// The pending state used before the catalog is available. It is not a claim that the library is empty.
    private static func emptySnapshot() -> StoredSnapshot {
        StoredSnapshot(summary: Summary(paperCount: 0, recordCount: 0, shardCount: 0, snapshotID: "", syncedAt: nil, source: "尚未同步", syncing: false, missingFromLatest: []), papers: [])
    }
    /// The small bundled publication sample. It is a local cache, not a full website catalog.
    private static func seedSnapshot(seedDirectory: URL?, siteBaseURL: URL) -> StoredSnapshot? {
        guard let seed = seedDirectory, let bytes = try? Data(contentsOf: seed.appendingPathComponent("sample.json")), bytes.count <= 8 * 1024 * 1024,
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], let rows = object["librarySample"] as? [[String: Any]] else { return nil }
        let papers = rows.compactMap { row -> Paper? in
            guard let identifier = row["id"] as? String, let title = row["title"] as? String,
                  let blog = row["blogUrl"] as? String, let url = URL(string: blog), url.host == siteBaseURL.host,
                  url.path.hasPrefix(siteBaseURL.path + "/") else { return nil }
            let authors = (row["authors"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
            let source = row["absUrl"] as? String, pdf = row["pdfUrl"] as? String
            let version = source.flatMap(URL.init(string:))?.lastPathComponent
            guard let citation = try? ClientProtocols.record("paper-citation-source", fields: ["paperKey": "arxiv:" + identifier, "identityStatus": "verified", "verified": true, "complete": false, "title": title, "authors": authors, "arxivId": version ?? identifier, "sourceUrl": source ?? "", "pdfUrl": pdf ?? "", "date": "", "doi": "", "venue": "", "sourceKind": "arxiv"]) else { return nil }
            return Paper(id: "arxiv:" + identifier, title: title, titleZh: row["titleZh"] as? String ?? title, authors: authors, date: row["date"] as? String ?? "", score: Self.publishedScore(row["score"]), task: row["task"] as? String ?? "", method: row["method"] as? String ?? "", tags: row["tags"] as? [String] ?? [], sourceKind: "arxiv", identityStatus: "verified", pageType: "paper", blogURL: blog, sourceURL: source, pdfURL: pdf, sourceVersion: version, appearances: [blog], citation: (try? JSONValue.from(citation)) ?? .null)
        }
        return StoredSnapshot(summary: Summary(paperCount: papers.count, recordCount: rows.count, shardCount: 0, snapshotID: Self.sha256(bytes), syncedAt: nil, source: "应用内已发布样稿（尚未全站同步）", syncing: false, missingFromLatest: []), papers: papers)
    }
    /// Reads the published catalog and the disposable full-text cache away from the calling
    /// thread. A catalog already decoded eagerly by the initializer is reused, not read again.
    private static func loadContent(directory: URL, seedDirectory: URL?, siteBaseURL: URL, eagerlyLoaded: StoredSnapshot?, eagerlyLoadedDetails: DesktopDetailsState?) throws -> LoadedLibrary {
        var snapshot = eagerlyLoaded
        if snapshot == nil {
            let current = directory.appendingPathComponent("current.json")
            if FileManager.default.fileExists(atPath: current.path) {
                let bytes = try Data(contentsOf: current)
                guard bytes.count <= maxTotal else { throw ServiceError.invalid("本地目录超过大小限制，请保留原文件后恢复备份。") }
                do { snapshot = try JSONDecoder().decode(StoredSnapshot.self, from: bytes) }
                catch { throw ServiceError.invalid("本机已发布资料目录无法读取（\(error.localizedDescription)）。原文件保留；可再次尝试或从备份恢复。") }
            } else {
                snapshot = emptySnapshot()
            }
        }
        if let loaded = snapshot, loaded.papers.isEmpty, let seeded = seedSnapshot(seedDirectory: seedDirectory, siteBaseURL: siteBaseURL) { snapshot = seeded }
        let effectiveSnapshot = snapshot ?? emptySnapshot()
        let details: DesktopDetailsState?
        if eagerlyLoaded != nil {
            details = eagerlyLoadedDetails
        } else {
            details = try loadDesktopDetailsState(directory: directory, snapshot: effectiveSnapshot, siteBaseURL: siteBaseURL)
        }
        var fullTextIndex: [String: String] = [:]
        if let data = try? Data(contentsOf: directory.appendingPathComponent("fulltext.json")), data.count <= 32 * 1024 * 1024,
           let values = try? JSONDecoder().decode([String: String].self, from: data) { fullTextIndex = values }
        return LoadedLibrary(snapshot: effectiveSnapshot, fullTextIndex: fullTextIndex, desktopDetails: details)
    }

    /// Every command that reads the published snapshot awaits this gate first. A failed load is
    /// reported to the caller (so the app can show it and retry) rather than as an empty catalog.
    func waitUntilReady() async throws {
        try await ensureReady()
    }
    /// Explicit retry after a failed load; ordinary commands stay failed instead of re-reading
    /// the whole catalog on every call.
    func retryLoad() async throws {
        loadPhase = .loading
        startLoad()
        try await ensureReady()
    }
    func promoteLoadPhaseAfterSync() {
        if case .failed = loadPhase { loadPhase = .ready }
    }
    private func ensureReady() async throws {
        while true {
            switch loadPhase {
            case .ready: return
            case .loading: break
            case .failed(let message):
                throw ServiceError.invalid(message)
            }
            guard let task = loadTask, let identity = loadID else { throw ServiceError.unavailable("本机资料目录尚未开始载入，请稍后重试。") }
            do {
                let loaded = try await task.value
                guard loadID == identity else { continue }
                snapshot = loaded.snapshot
                fullTextIndex = loaded.fullTextIndex
                desktopDetails = loaded.desktopDetails
                loadPhase = .ready
                loadTask = nil
                loadID = nil
                return
            } catch {
                guard loadID == identity else { continue }
                loadTask = nil
                loadID = nil
                loadPhase = .failed(error.localizedDescription)
                if error is ServiceError { throw error }
                throw ServiceError.invalid("本机资料目录载入失败：\(error.localizedDescription)。原文件保留；可再次尝试或从备份恢复。")
            }
        }
    }
    private func startLoad() {
        let identity = UUID()
        loadID = identity
        loadPhase = .loading
        let directory = self.directory, seedDirectory = self.seedDirectory, siteBaseURL = self.siteBaseURL
        loadTask = Task.detached(priority: .utility) {
            try Self.loadContent(directory: directory, seedDirectory: seedDirectory, siteBaseURL: siteBaseURL, eagerlyLoaded: nil, eagerlyLoadedDetails: nil)
        }
    }

    func status() async -> Summary {
        _ = try? await ensureReady()
        var value = snapshot.summary
        value.syncing = syncTask != nil
        switch loadPhase {
        case .ready: break
        case .loading: value.loading = true; value.message = "正在载入本机目录…"
        case .failed(let message): value.loading = false; value.message = "本机目录载入失败：\(message)"
        }
        return value
    }
    /// `library.status` answers before the catalog is decoded. A pending load is reported as an
    /// explicit loading result without `snapshotID`: a summary read racing the first list can
    /// never be mistaken for a different, empty catalog.
    private func statusResponse() async throws -> [String: Any] {
        switch loadPhase {
        case .ready: return try Self.dictionary(await status())
        case .loading:
            return ["loading": true, "message": "正在载入本机目录…",
                    "syncing": syncTask != nil, "missingFromLatest": [String]()]
        case .failed(let message):
            return ["loading": false, "error": message, "message": "本机目录载入失败：\(message)"]
        }
    }

    func sync(progress: @escaping @Sendable (Progress) -> Void = { _ in }) async throws -> Summary {
        // A full published sync replaces the local catalog, so it is also a repair path for a
        // failed startup decode: rejecting it at the ready gate would leave the app stuck on the
        // old error with only `library.retryLoad` as a way back. A pending decode is still awaited
        // so the merge below starts from the real saved catalog rather than a placeholder.
        if case .failed = loadPhase {} else { try await ensureReady() }
        if let syncTask { return try await withTaskCancellationHandler(operation: { try await syncTask.value }, onCancel: { syncTask.cancel() }) }
        let identifier = UUID()
        syncID = identifier
        let task = Task { try await self.performSync(identifier: identifier, progress: progress) }
        syncTask = task
        do {
            let result = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
            if syncID == identifier { syncTask = nil; syncID = nil }
            return result
        } catch {
            if syncID == identifier { syncTask = nil; syncID = nil }
            if error is CancellationError { throw ServiceError.cancelled }
            throw error
        }
    }
    func cancelSync() {
        syncTask?.cancel()
    }
    func invalidateSession() {
        syncTask?.cancel()
        session.invalidateAndCancel()
    }

    private func performSync(identifier: UUID, progress: @escaping @Sendable (Progress) -> Void) async throws -> Summary {
        progress(Progress(phase: "manifest", message: "正在读取网站目录清单", completed: 0, total: 0))
        if let desktopSummary = try await syncDesktopDetailsIfAvailable(identifier: identifier, progress: progress) {
            return desktopSummary
        }
        var indexURL = siteBaseURL.appendingPathComponent("client/index.json")
        let index: Data
        do { index = try await read(indexURL, limit: Self.maxTotal) }
        catch ServiceError.httpStatus(let status) where [404, 410].contains(status) {
            indexURL = siteBaseURL.appendingPathComponent("index.json")
            index = try await read(indexURL, limit: Self.maxTotal)
        }
        try Task.checkCancellation()
        let raw = try JSONSerialization.jsonObject(with: index)
        var records: [[String: Any]] = []
        var shardCount = 0
        // Shard bytes and rows already read and checked here; staging the aggregate catalog
        // re-verifies both instead of reading and parsing the same shards a second time.
        var preparedShards: [String: PublishedAggregateReader.PreparedShard] = [:]
        var preparedBytes = 0
        if let legacy = raw as? [[String: Any]] {
            guard indexURL.path == siteBaseURL.appendingPathComponent("index.json").path else { throw ServiceError.invalid("新网站目录缺少完整格式声明。") }
            records = legacy
        } else {
            let manifest = try JSONDecoder().decode(Manifest.self, from: index)
            let family = "paper-search-index-manifest"
            let expectedContract = indexURL.path == siteBaseURL.appendingPathComponent("client/index.json").path
                ? ClientProtocols.contract(family)
                : try ClientProtocols.historicalContract(family, variant: "sha-bound-ordered-shards")
            guard let header = raw as? [String: Any], ClientProtocols.hasValidHeader(header, family),
                  manifest.contract == expectedContract, !manifest.shards.isEmpty,
                  manifest.shards.count <= 128, manifest.recordCount > 0,
                  manifest.totalBytes > 0, manifest.totalBytes <= Self.maxTotal else { throw ServiceError.invalid("网站目录协议或大小不受支持。") }
            var urls = Set<String>()
            var bytes = 0, count = 0
            for shard in manifest.shards {
                guard shard.bytes > 0, shard.bytes <= 1024 * 1024, shard.recordCount > 0,
                      shard.url.range(of: #"^search-index/part-[0-9]{4,}-[a-f0-9]{12}\.json$"#, options: .regularExpression) != nil,
                      shard.sha256.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
                      shard.url.hasSuffix("-" + shard.sha256.prefix(12) + ".json"), urls.insert(shard.url).inserted else { throw ServiceError.invalid("网站目录分片描述无效。") }
                bytes += shard.bytes; count += shard.recordCount
            }
            guard bytes == manifest.totalBytes, count == manifest.recordCount else { throw ServiceError.invalid("网站目录总数量或字节不一致。") }
            shardCount = manifest.shards.count
            for (i, shard) in manifest.shards.enumerated() {
                try Task.checkCancellation()
                let file = cacheURL("index", key: shard.sha256, extension: "json")
                var data = try? Data(contentsOf: file)
                if data?.count != shard.bytes || data.map(Self.sha256) != shard.sha256 {
                    data = try await read(try sameSite(URL(string: shard.url, relativeTo: indexURL)!.absoluteURL.absoluteString), limit: 1024 * 1024)
                    guard data!.count == shard.bytes, Self.sha256(data!) == shard.sha256 else { throw ServiceError.invalid("网站分片内容与清单不符，保留上一份资料库。") }
                    try atomicWrite(data!, to: file)
                }
                guard let values = try JSONSerialization.jsonObject(with: data!) as? [[String: Any]], values.count == shard.recordCount else { throw ServiceError.invalid("网站分片记录数量不符。") }
                records.append(contentsOf: values)
                preparedShards[shard.url] = PublishedAggregateReader.PreparedShard(bytes: data!, rows: values)
                preparedBytes += data!.count
                progress(Progress(phase: "catalog", message: "正在同步论文目录（\(i + 1)/\(shardCount) 分片）", completed: i + 1, total: shardCount))
            }
        }
        guard !records.isEmpty else { throw ServiceError.invalid("网站返回空目录，未替换现有资料。") }
        var papersByID: [String: Paper] = [:]
        var pages = Set<String>()
        for record in records {
            try Task.checkCancellation()
            guard let permalink = record["permalink"] as? String, pages.insert(permalink).inserted else { throw ServiceError.invalid("网站目录存在重复或缺失页面地址。") }
            guard let paper = try parsePaper(record) else { continue }
            if var old = papersByID[paper.id] {
                let appearances = Array(Set(old.appearances + paper.appearances)).sorted()
                let tagRecords = (old.websiteTagRecords ?? []) + (paper.websiteTagRecords ?? [])
                if paper.date > old.date { old = paper }
                old.appearances = appearances
                old.websiteTagRecords = tagRecords
                papersByID[paper.id] = old
            } else { papersByID[paper.id] = paper }
        }
        guard !papersByID.isEmpty else { throw ServiceError.invalid("网站目录没有可读取的论文，未覆盖现有资料。") }
        let currentIDs = Set(papersByID.keys)
        let previousIDs = Set(snapshot.papers.map(\.id))
        let missing = Set(snapshot.summary.missingFromLatest).union(previousIDs.subtracting(currentIDs)).subtracting(currentIDs)
        let summary = Summary(paperCount: papersByID.count, recordCount: records.count, shardCount: shardCount, snapshotID: Self.sha256(index), syncedAt: Self.now(), source: siteBaseURL.absoluteString, syncing: false, missingFromLatest: missing.sorted())
        var replacement = StoredSnapshot(summary: summary, papers: papersByID.values.sorted { $0.id < $1.id })
        if records.contains(where: { ($0["tagConcepts"] as? [Any])?.isEmpty == false || ($0["taxonomyConcepts"] as? [Any])?.isEmpty == false }) {
            do { replacement.websiteTaxonomy = try await readWebsiteTaxonomy() }
            catch is CancellationError { throw CancellationError() }
            catch { replacement.websiteTaxonomy = snapshot.websiteTaxonomy; replacement.websiteTaxonomyNotice = snapshot.websiteTaxonomy == nil ? "网页分类词表暂不可读；论文目录已保留，未借用其他版本分类。" : "分类资源更新未完成，当前使用上次可核对的词表；不在该词表版本中的分类暂不可核验。" }
        } else { replacement.websiteTaxonomyNotice = "网站目录未提供可核对的多级分类。" }
        replacement.validationEpoch = UUID().uuidString
        replacement.retiredPapers = Dictionary((snapshot.papers + (snapshot.retiredPapers ?? [])).filter { !currentIDs.contains($0.id) }.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }).values.sorted { $0.id < $1.id }
        try Task.checkCancellation()
        guard syncID == identifier else { throw CancellationError() }
        let encoded = try JSONEncoder().encode(replacement)
        guard encoded.count <= Self.maxTotal else { throw ServiceError.invalid("合并后的本地目录超过大小限制。") }
        if shardCount > 0 {
            // 保留全部分片会在 manifest 之外再占一份总字节；超过 16MiB 时回落到逐片读取路径。
            let reusableShards = preparedBytes <= 16 * 1024 * 1024 ? preparedShards : nil
            _ = try PublishedAggregateStore(directory: directory, siteBase: siteBaseURL).stage(manifest: index, validationEpoch: replacement.validationEpoch!, preparedShards: reusableShards)
            try Task.checkCancellation(); guard syncID == identifier else { throw CancellationError() }
        }
        try atomicWrite(encoded, to: directory.appendingPathComponent("current.json"))
        snapshot = replacement
        desktopDetails = nil
        cleanupDesktopDetailsStateFilesAfterLegacyFallback()
        // The replacement catalog is now both persisted and in memory, so an earlier decode
        // failure no longer describes what this service serves: promote it to ready and the
        // ordinary commands stop rethrowing the old error. Only the failed phase is promoted; a
        // concurrent retry owns `.loading` and publishes that read itself.
        if case .failed = loadPhase { loadPhase = .ready }
        progress(Progress(phase: "complete", message: "已同步 \(summary.paperCount) 篇论文，\(summary.recordCount) 条页面记录", completed: shardCount, total: shardCount))
        return summary
    }

    func aggregateCatalog() throws -> PublishedAggregateCatalog? {
        try PublishedAggregateStore(directory: directory, siteBase: siteBaseURL).load(activeSnapshotSHA256: snapshot.summary.snapshotID, validationEpoch: snapshot.validationEpoch)
    }
    /// A synchronous current-source operation; neither the scoped store nor its
    /// qualification may escape the closure or cross a network await.
    func withCurrentAggregateReadScope<T>(_ body: (PublishedAggregateStore, PublishedAggregateCatalog) throws -> T) throws -> T {
        try PublishedAggregateStore(directory: directory, siteBase: siteBaseURL).withVerifiedReadScope { store in
            guard let catalog = try store.load(activeSnapshotSHA256: snapshot.summary.snapshotID, validationEpoch: snapshot.validationEpoch) else { throw AggregateFailure.invalid("当前汇总目录未核验") }
            return try body(store, catalog)
        }
    }
    func aggregateOriginalRow(id: String) throws -> Data {
        try PublishedAggregateStore(directory: directory, siteBase: siteBaseURL).withVerifiedReadScope { store in
            guard let catalog = try store.load(activeSnapshotSHA256: snapshot.summary.snapshotID, validationEpoch: snapshot.validationEpoch), let descriptor = catalog.records.first(where: { $0.id == id }) else { throw AggregateFailure.invalid("汇总目录尚未同步或条目不存在") }
            return try store.originalRow(for: descriptor)
        }
    }

    func aggregateDocument(id: String) async throws -> AggregateDocument {
        guard let catalog = try aggregateCatalog(), let descriptor = catalog.records.first(where: { $0.id == id }) else { throw AggregateFailure.invalid("汇总目录尚未同步或条目不存在") }
        let epoch = snapshot.validationEpoch, sourceSnapshot = snapshot.summary.snapshotID
        let url = try PublishedAggregateReader.pageURL(descriptor.sourceURL, siteBase: siteBaseURL)
        let raw = try await read(url, limit: 16 * 1024 * 1024)
        try Task.checkCancellation()
        guard snapshot.validationEpoch == epoch, snapshot.summary.snapshotID == sourceSnapshot else { throw AggregateFailure.invalid("读取期间目录验证代已变化，未拼接新目录与旧网页") }
        // Production read() accepts only HTTP200 with the actual response URL equal to this same-site URL.
        return try PublishedAggregateStore(directory: directory, siteBase: siteBaseURL).cacheDocument(raw, descriptor: descriptor, responseURL: url, fetchedAt: Self.now())
    }
    func aggregateCachedDocument(id: String, rawHTMLSHA256: String) throws -> AggregateDocument {
        try PublishedAggregateStore(directory: directory, siteBase: siteBaseURL).withVerifiedReadScope { store in
            guard let catalog = try store.load(activeSnapshotSHA256: snapshot.summary.snapshotID, validationEpoch: snapshot.validationEpoch), let descriptor = catalog.records.first(where: { $0.id == id }) else { throw AggregateFailure.invalid("当前汇总目录未核验") }
            return try store.cachedDocument(descriptor: descriptor, rawHTMLSHA256: rawHTMLSHA256)
        }
    }

    private func parsePaper(_ row: [String: Any]) throws -> Paper? {
        guard let pageType = row["pageType"] as? String else { throw ServiceError.invalid("目录记录缺少页面类型。") }
        guard pageType == "paper" else { return nil }
        let citation = row["citation"] as? [String: Any] ?? [:]
        let status = row["identityStatus"] as? String ?? citation["identityStatus"] as? String ?? "unverified"
        let blog = try sameSite(row["permalink"] as? String ?? "")
        let kind = row["sourceKind"] as? String ?? citation["sourceKind"] as? String ?? "unknown"
        let explicit = row["paperId"] as? String ?? citation["paperId"] as? String ?? ""
        let arxiv = row["arxivId"] as? String ?? citation["arxivId"] as? String ?? ""
        let parsedBase = DesktopArxivIdentifier.base(of: arxiv)
        let base = parsedBase ?? arxiv
        let validArxiv = parsedBase != nil
        let id = status == "verified" && kind == "arxiv" && validArxiv ? "arxiv:\(base)" : status == "verified" && kind != "arxiv" && !explicit.isEmpty ? explicit : "page:\(blog.path)"
        let title = row["originalTitle"] as? String ?? citation["title"] as? String ?? row["title"] as? String ?? ""
        guard !title.isEmpty else { throw ServiceError.invalid("论文目录缺少题名。") }
        let source = cleanHTTPS(citation["sourceUrl"] as? String ?? citation["url"] as? String)
        let pdf = status == "verified" ? cleanHTTPS(citation["pdfUrl"] as? String) : nil
        let version = citation["arxivId"] as? String
        return Paper(id: id, title: title, titleZh: row["titleZh"] as? String ?? row["title"] as? String ?? title,
                     authors: citation["authors"] as? [String] ?? [], date: row["date"] as? String ?? "", score: Self.publishedScore(row["score"]),
                     task: row["task"] as? String ?? "", method: row["method"] as? String ?? "", tags: row["tags"] as? [String] ?? [],
                     sourceKind: kind, identityStatus: status, pageType: pageType, blogURL: blog.absoluteString, sourceURL: source, pdfURL: pdf,
                     sourceVersion: version?.isEmpty == false ? version : nil, appearances: [blog.absoluteString], citation: try JSONValue.from(citation), websiteTagRecords: [try JSONValue.from(Self.websiteTagRecord(row))], pdfSHA256: try Self.publishedPDFHash(row, citation: citation))
    }

    private func readWebsiteTaxonomy() async throws -> JSONValue {
        var snapshotURL = try sameSite("client/data/tag-catalog-snapshot.json"), versionsURL = try sameSite("client/data/tag-catalog-versions.json")
        func optional404(_ url: URL, _ limit: Int) async throws -> Data? {
            do { return try await read(url, limit: limit) }
            catch ServiceError.httpStatus(404) { return nil }
        }
        let firstSnapshot = try await optional404(snapshotURL, 2 * 1024 * 1024), firstVersions = try await optional404(versionsURL, 8 * 1024 * 1024)
        let snapshotBytes: Data, versionsBytes: Data
        if firstSnapshot == nil && firstVersions == nil {
            snapshotURL = try sameSite("data/tag-catalog-snapshot.json"); versionsURL = try sameSite("data/tag-catalog-versions.json")
            snapshotBytes = try await read(snapshotURL, limit: 2 * 1024 * 1024); versionsBytes = try await read(versionsURL, limit: 8 * 1024 * 1024)
        } else {
            guard let firstSnapshot, let firstVersions else { throw ServiceError.invalid("新网页分类资源不成对，未改用另一份来源。") }
            snapshotBytes = firstSnapshot; versionsBytes = firstVersions
        }
        let snapshotFamily = "paper-tag-catalog-snapshot", versionsFamily = "paper-tag-catalog-versions"
        let legacy = firstSnapshot == nil
        let snapshotContract = legacy ? try ClientProtocols.historicalContract(snapshotFamily, variant: "public-concept-hierarchy") : ClientProtocols.contract(snapshotFamily)
        let versionsContract = legacy ? try ClientProtocols.historicalContract(versionsFamily, variant: "sha-keyed-snapshot-set") : ClientProtocols.contract(versionsFamily)
        guard let current = try JSONSerialization.jsonObject(with: snapshotBytes) as? [String: Any],
              let versions = try JSONSerialization.jsonObject(with: versionsBytes) as? [String: Any],
              ClientProtocols.hasValidHeader(current, snapshotFamily), ClientProtocols.hasValidHeader(versions, versionsFamily),
              current["contract"] as? String == snapshotContract, versions["contract"] as? String == versionsContract,
              let hash = current["registrySha256"] as? String, hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              versions["currentSha256"] as? String == hash, current["concepts"] is [[String: Any]], versions["snapshots"] is [[String: Any]] else {
            throw ServiceError.invalid("网页分类显示资源缺失或当前词表不一致。")
        }
        let snapshotHash = Self.sha256(snapshotBytes), versionsHash = Self.sha256(versionsBytes)
        try atomicWrite(snapshotBytes, to: cacheURL("taxonomy", key: snapshotHash, extension: "json")); try atomicWrite(versionsBytes, to: cacheURL("taxonomy", key: versionsHash, extension: "json"))
        return try JSONValue.from(["snapshot": current, "versions": versions, "snapshotSourceURL": snapshotURL.absoluteString, "versionsSourceURL": versionsURL.absoluteString, "snapshotContentSHA256": snapshotHash, "versionsContentSHA256": versionsHash])
    }

    func article(for paperID: String, refresh: Bool = false, downloadImages: Bool = true, progress: @escaping @Sendable (Progress) -> Void = { _ in }) async throws -> Article {
        try await ensureReady()
        guard let paper = (snapshot.papers + (snapshot.retiredPapers ?? [])).first(where: { $0.id == paperID }) else { throw ServiceError.unavailable("论文不在已保存的发布资料库中。请先同步，或从论文库重新选择。") }
        let cache = cacheURL("articles", key: Self.sha256(Data(paper.blogURL.utf8)), extension: "json")
        var previous: Article?
        if let data = try? Data(contentsOf: cache), let cached = try? JSONDecoder().decode(Article.self, from: data), cached.paperID == paperID { previous = cached }
        if let detailEntry = activeDesktopDetails()?.paperDetails[paperID] {
            if !refresh, var cached = previous {
                let fastCheck = try verifyDesktopArticleFastPath(paper: paper, detailEntry: detailEntry, cached: cached)
                let missing = !fastCheck.allAssetsPresent || !resourcesVerified(cached)
                if missing { cached.completeOffline = false }
                let current = fastCheck.verified
                    && cached.revisionSHA256 == detailEntry.primaryArticleRevisionId
                    && cached.catalogEpoch == snapshot.validationEpoch
                    && cached.isStale != true
                    && (!downloadImages || !missing)
                if current { return mergeActiveTombstoneNotices(Self.presentSourceWarning(cached), paper: paper) }
            }
            do {
                let fresh = try await fetchDesktopDetailArticle(paper, detailEntry: detailEntry, cache: cache, previous: previous, downloadImages: downloadImages, progress: progress)
                return mergeActiveTombstoneNotices(fresh, paper: paper)
            } catch let epochErr as DesktopEpochChangedError {
                throw ServiceError.invalid(epochErr.localizedDescription)
            } catch let storageErr as PrivateStoragePaths.StorageError {
                throw ServiceError.invalid(storageErr.localizedDescription)
            } catch let svcErr as ServiceError {
                switch svcErr {
                case .invalid, .cancelled:
                    throw svcErr
                case .httpStatus(let code) where code == 404 || code == 410:
                    throw svcErr
                default:
                    if refresh { throw svcErr }
                    guard var old = previous ?? (try? seedArticle(paper)) else { throw svcErr }
                    old.isStale = true; old.cacheStatus = "stale"; old.validationAttemptedAt = Self.now(); old.expectedSourceVersion = paper.sourceVersion; old.catalogEpoch = snapshot.validationEpoch
                    old.completeOffline = old.completeOffline && resourcesVerified(old)
                    old.notices = Array(Set(old.notices + ["网站当前修订复验失败，正在读取先前保存的旧导读；获取于\(old.fetchedAt)，旧来源版本\(old.sourceVersion ?? "未标版本")，目录期待版本\(paper.sourceVersion ?? "未标版本")。\(svcErr.localizedDescription)"])).sorted()
                    if previous != nil { try atomicWrite(try JSONEncoder().encode(old), to: cache) }
                    return mergeActiveTombstoneNotices(Self.presentSourceWarning(old), paper: paper)
                }
            } catch {
                if Task.isCancelled || error is CancellationError { throw CancellationError() }
                if refresh { throw error }
                guard var old = previous ?? (try? seedArticle(paper)) else { throw error }
                old.isStale = true; old.cacheStatus = "stale"; old.validationAttemptedAt = Self.now(); old.expectedSourceVersion = paper.sourceVersion; old.catalogEpoch = snapshot.validationEpoch
                old.completeOffline = old.completeOffline && resourcesVerified(old)
                old.notices = Array(Set(old.notices + ["网站当前修订复验失败，正在读取先前保存的旧导读；获取于\(old.fetchedAt)，旧来源版本\(old.sourceVersion ?? "未标版本")，目录期待版本\(paper.sourceVersion ?? "未标版本")。\(error.localizedDescription)"])).sorted()
                if previous != nil { try atomicWrite(try JSONEncoder().encode(old), to: cache) }
                return mergeActiveTombstoneNotices(Self.presentSourceWarning(old), paper: paper)
            }
        }
        if !refresh, var cached = previous {
            if cached.markdown == nil, !ClientProtocols.isContract(cached.mathMLContract, "published-html-mathml") { cached.notices.append("这份旧HTML缓存未经过公式结构保真读取，部分MathML可能缺失；原稿保留，请联网重新读取网站导读。") }
            let missing = !resourcesVerified(cached)
            if missing { cached.completeOffline = false }
            let parserCurrent = cached.markdown != nil || ClientProtocols.isContract(cached.mathMLContract, "published-html-mathml")
            let current = parserCurrent && Self.sourceMatches(cached, paper: paper) && cached.catalogEpoch == snapshot.validationEpoch && Self.age(cached.fetchedAt) <= 6 * 3600
            if current && (!downloadImages || !missing), cached.isStale != true { return mergeActiveTombstoneNotices(Self.presentSourceWarning(cached), paper: paper) }
            if cached.isStale == true, cached.catalogEpoch == snapshot.validationEpoch, cached.expectedSourceVersion == paper.sourceVersion, Self.age(cached.validationAttemptedAt) < 300 { return mergeActiveTombstoneNotices(Self.presentSourceWarning(cached), paper: paper) }
        }
        if !refresh, snapshot.summary.syncedAt == nil, var seeded = try seedArticle(paper) {
            seeded.blogURL = paper.blogURL; seeded.cacheStatus = "bundled"; seeded.isStale = false
            indexText(seeded); return Self.presentSourceWarning(seeded)
        }
        do {
            return mergeActiveTombstoneNotices(try await fetchArticle(paper, cache: cache, previous: previous, downloadImages: downloadImages, progress: progress), paper: paper)
        } catch {
            if Task.isCancelled || error is CancellationError { throw CancellationError() }
            guard var old = previous ?? (try? seedArticle(paper)) else { throw error }
            old.isStale = true; old.cacheStatus = "stale"; old.validationAttemptedAt = Self.now(); old.expectedSourceVersion = paper.sourceVersion; old.catalogEpoch = snapshot.validationEpoch
            old.completeOffline = old.completeOffline && resourcesVerified(old)
            if old.markdown == nil, !ClientProtocols.isContract(old.mathMLContract, "published-html-mathml") { old.notices.append("这份旧HTML缓存未经过公式结构保真读取，部分MathML可能缺失；原稿保留，请联网重新读取网站导读。") }
            old.notices = Array(Set(old.notices + ["网站当前修订复验失败，正在读取先前保存的旧导读；获取于\(old.fetchedAt)，旧来源版本\(old.sourceVersion ?? "未标版本")，目录期待版本\(paper.sourceVersion ?? "未标版本")。\(error.localizedDescription)"])).sorted()
            if previous != nil { try atomicWrite(try JSONEncoder().encode(old), to: cache) }
            return mergeActiveTombstoneNotices(Self.presentSourceWarning(old), paper: paper)
        }
    }
    private func fetchArticle(_ paper: Paper, cache: URL, previous: Article?, downloadImages: Bool, progress: @escaping @Sendable (Progress) -> Void) async throws -> Article {
        let validationEpoch = snapshot.validationEpoch
        progress(Progress(phase: "article", message: "正在读取已发布图文导读", completed: 0, total: 0))
        let raw = try await read(try sameSite(paper.blogURL), limit: 8 * 1024 * 1024)
        guard let html = String(data: raw, encoding: .utf8) else { throw ServiceError.invalid("文章不是有效 UTF-8 文本。") }
        var article = try Self.extractArticle(html, paper: paper, pageURL: URL(string: paper.blogURL)!)
        var notices = article.notices
        let metadataDocument = try Self.tidyHTMLDocumentSafely(html)
        let citationFiles = try publishedSidecarLinks(metadataDocument, paper: paper, allowLegacySiblings: true)
        if let address = citationFiles.urls["citation.json"] {
            article.citationFiles = citationFiles.urls
            article.citationFileSHA256 = citationFiles.hashes.isEmpty ? nil : citationFiles.hashes
            do {
                let data = try await read(try sameSite(address), limit: 1024 * 1024)
                if let expected = citationFiles.hashes["citation.json"], Self.sha256(data) != expected { throw ServiceError.invalid("引用文件与已读取页面中的SHA不符。 ") }
                article.citationSidecar = try Self.validatedSidecar(data, paper: paper, context: false)
            } catch is CancellationError { throw CancellationError() }
            catch { notices.append("引用附加文件尚未读取，保留页面已核验字段。") }
            if let contextAddress = citationFiles.urls["rethink-context.json"] {
                do {
                    let data = try await read(try sameSite(contextAddress), limit: 1024 * 1024)
                    if let expected = citationFiles.hashes["rethink-context.json"], Self.sha256(data) != expected { throw ServiceError.invalid("上下文文件与已读取页面中的SHA不符。 ") }
                    article.researchContext = try Self.validatedSidecar(data, paper: paper, context: true)
                } catch is CancellationError { throw CancellationError() }
                catch { notices.append("研究上下文附加文件缺失或尚不可读。") }
            }
        }
        var imageBytes = 0
        var replacements: [String: String] = [:]
        for i in article.resources.indices where article.resources[i].kind == "image" {
            try Task.checkCancellation()
            guard downloadImages else { article.resources[i].missingReason = "尚未下载图片"; continue }
            do {
                let url = URL(string: article.resources[i].sourceURL)!
                progress(Progress(phase: "images", message: "正在保存科学图（\(i + 1)/\(article.resources.count)）", completed: i, total: article.resources.count))
                let bytes = try await read(url, limit: 16 * 1024 * 1024)
                guard imageBytes + bytes.count <= 64 * 1024 * 1024 else { throw ServiceError.invalid("单篇图片累计超过64 MiB，停止下载其余图片。") }
                let ext = try Self.imageExtension(bytes, url: url)
                imageBytes += bytes.count
                let sha = Self.sha256(bytes), file = cacheURL("assets", key: sha, extension: ext)
                try atomicWrite(bytes, to: file)
                article.resources[i].localPath = file.path
                article.resources[i].sha256 = sha
                replacements[article.resources[i].sourceURL] = "data:\(Self.imageMIME(ext));base64,\(bytes.base64EncodedString())"
            } catch is CancellationError { throw CancellationError() }
            catch { article.resources[i].missingReason = error.localizedDescription; notices.append("部分图片未离线保存：\(error.localizedDescription)") }
        }
        article.html = try Self.localizeImages(article.html, replacements: replacements)
        article.completeOffline = article.resources.allSatisfy { $0.localPath != nil }
        article.notices = Array(Set(notices)).sorted()
        article.blogURL = paper.blogURL; article.catalogEpoch = validationEpoch; article.isStale = false; article.cacheStatus = "current"; article.validationAttemptedAt = Self.now(); article.expectedSourceVersion = paper.sourceVersion
        try Task.checkCancellation()
        if validationEpoch != snapshot.validationEpoch {
            article.isStale = true; article.cacheStatus = "stale"; article.notices.append("读取期间目录已更新，这份导读保留其原来源版本，请再次刷新核对当前修订。")
        }
        if let previous { try preserveRevision(previous, blogURL: paper.blogURL) }
        try preserveRevision(article, blogURL: paper.blogURL)
        try atomicWrite(try JSONEncoder().encode(article), to: cache)
        cachedDemoPaperIDs = nil
        indexText(article)
        return article
    }
    func preserveRevision(_ article: Article, blogURL: String) throws {
        let bytes = try JSONEncoder().encode(article), key = Self.sha256(Data(blogURL.utf8))
        var identity = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        for transient in ["fetchedAt", "catalogEpoch", "isStale", "cacheStatus", "validationAttemptedAt", "expectedSourceVersion", "notices"] { identity.removeValue(forKey: transient) }
        let revision = Self.sha256(try JSONSerialization.data(withJSONObject: identity, options: .sortedKeys))
        let file = directory.appendingPathComponent("article-revisions/" + key).appendingPathComponent(revision + ".json")
        if !FileManager.default.fileExists(atPath: file.path) { try atomicWrite(bytes, to: file) }
    }
    private static func sourceMatches(_ article: Article, paper: Paper) -> Bool {
        article.paperID == paper.id && article.blogURL == paper.blogURL && article.sourceURL == (paper.sourceURL ?? paper.blogURL) && article.pdfURL == paper.pdfURL && article.sourceVersion == paper.sourceVersion
    }
    private static func age(_ value: String?) -> TimeInterval {
        guard let value, let date = ISO8601DateFormatter().date(from: value) else { return .infinity }
        let interval = Date().timeIntervalSince(date)
        return interval < -300 ? .infinity : max(0, interval)
    }
    func resourcesVerified(_ article: Article) -> Bool {
        article.resources.allSatisfy { resource in
            guard let path = resource.localPath, let hash = resource.sha256 else { return false }
            let file: URL
            if let seed = seedDirectory, path.hasPrefix(seed.path + "/") { file = URL(fileURLWithPath: path) }
            else { guard let resolved = try? PrivateStoragePaths.resolve(path, directory: privateDirectory, expectedSHA256: hash) else { return false }; file = resolved }
            guard let bytes = try? Data(contentsOf: file) else { return false }
            return bytes.count <= 16 * 1024 * 1024 && Self.sha256(bytes) == hash
        }
    }
    private func seedObject(for paper: Paper) -> [String: Any]? {
        guard let seed = seedDirectory, let bytes = try? Data(contentsOf: seed.appendingPathComponent("sample.json")), bytes.count <= 8 * 1024 * 1024,
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], let primary = object["paper"] as? [String: Any],
              "arxiv:" + (primary["id"] as? String ?? "") == paper.id,
              primary["absUrl"] as? String == paper.sourceURL, primary["pdfUrl"] as? String == paper.pdfURL,
              primary["blogUrl"] as? String == paper.blogURL,
              let source = paper.sourceURL.flatMap(URL.init(string:)), source.lastPathComponent == paper.sourceVersion else { return nil }
        return object
    }
    func searchCachedText(_ query: String) -> [String] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        guard !needle.isEmpty else { return [] }
        return fullTextIndex.filter { $0.value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current).contains(needle) }.map(\.key).sorted()
    }
    func indexText(_ article: Article) {
        let text = String(article.plainText.prefix(1_000_000))
        guard fullTextIndex[article.paperID] != text else { return }
        var updated = fullTextIndex
        updated[article.paperID] = text
        guard let bytes = try? JSONEncoder().encode(updated), bytes.count <= 32 * 1024 * 1024,
              (try? atomicWrite(bytes, to: directory.appendingPathComponent("fulltext.json"))) != nil else { return }
        fullTextIndex = updated
    }

    private func seedArticle(_ paper: Paper) throws -> Article? {
        guard let seed = seedDirectory, let object = seedObject(for: paper), let primary = object["paper"] as? [String: Any],
              var markdown = object["articleMarkdown"] as? String else { return nil }
        var resources: [Resource] = []
        for row in object["figures"] as? [[String: Any]] ?? [] {
            guard let name = row["src"] as? String, !name.contains("/"), !name.contains(".."),
                  let sha = row["sha256"] as? String else { throw ServiceError.invalid("应用内样稿图片描述无效。") }
            let file = seed.appendingPathComponent("assets").appendingPathComponent(name)
            let data = try Data(contentsOf: file)
            guard data.count <= 16 * 1024 * 1024, Self.sha256(data) == sha else { throw ServiceError.invalid("应用内科学图缺失或内容不符。") }
            let ext = try Self.imageExtension(data, url: file)
            markdown = markdown.replacingOccurrences(of: "](\(name))", with: "](data:\(Self.imageMIME(ext));base64,\(data.base64EncodedString()))")
            resources.append(Resource(sourceURL: row["sourceUrl"] as? String ?? "", kind: "image", localPath: file.path, sha256: sha, missingReason: nil))
        }
        var result = Article(paperID: paper.id, html: "", markdown: markdown, plainText: object["articleMarkdown"] as? String ?? "", citation: paper.citation, resources: resources, sourceURL: paper.sourceURL ?? paper.blogURL, pdfURL: paper.pdfURL, sourceVersion: paper.sourceVersion, fetchedAt: Self.now(), revisionSHA256: Self.sha256(Data((object["articleMarkdown"] as? String ?? "").utf8)), completeOffline: true, notices: ["应用内已发布样稿；正式网站修订可通过刷新读取。"])
        if let citation = object["citation"] as? [String: Any] {
            result.citationSidecar = try Self.validatedSidecar(JSONSerialization.data(withJSONObject: citation), paper: paper, context: false)
        }
        let context = try ClientProtocols.record("desktop-bundled-research-context", fields: [
            "origin": "bundled-published-sample", "sampleOnly": true,
            "sourceContract": object["contract"] ?? NSNull(), "paperID": paper.id, "sourceURL": paper.sourceURL ?? paper.blogURL,
            "blogURL": paper.blogURL, "sourceVersion": paper.sourceVersion ?? "", "originalTitle": paper.title, "readerTitle": paper.titleZh,
            "authors": primary["authors"] ?? [], "abstract": object["abstract"] ?? NSNull(),
            "oneSentenceThesis": primary["summary"] ?? NSNull(), "assessment": ["score": primary["score"] ?? NSNull(), "primaryTask": primary["task"] ?? "", "primaryMethod": primary["method"] ?? "", "tags": primary["tags"] ?? []]
        ])
        result.researchContext = try JSONValue.from(context)
        return result
    }

    /// The same normal network/type guards as paper images, without a paper or model capability.
    private func aggregateImageData(_ slot: AggregateImageSlot, limit: Int) async throws -> Data {
        guard let address = slot.sourceURL, let url = URL(string: address), url.scheme == "https", url.user == nil, url.password == nil, url.port == nil || url.port == 443, url.fragment == nil else { throw AggregateFailure.invalid("原图片地址不受支持") }
        if url.host?.lowercased() == siteBaseURL.host?.lowercased(), !Self.isOwnedPublishedImage(url) { _ = try sameSite(address) }
        else { guard Self.isApprovedExternalResource(url) else { throw AggregateFailure.invalid("原图片不在已支持的官方来源") } }
        return try await read(url, limit: limit)
    }
    func aggregatePresentationImages(_ source: AggregateDocument, allowNetwork: Bool) async throws -> AggregateResourceRender? {
        let store = PublishedAggregateStore(directory: directory, siteBase: siteBaseURL)
        let cached = try store.withVerifiedReadScope { scoped in
            try scoped.latestResourceRendering(source: source) ?? scoped.importAndroidResourceRendering(source)
        }
        if !allowNetwork { return cached }
        if let cached, cached.manifest.images.allSatisfy({ $0.sha256 != nil }) { return cached }
        return try await aggregateResourceRendering(source)
    }
    func aggregateResourceRendering(_ source: AggregateDocument) async throws -> AggregateResourceRender {
        let store = PublishedAggregateStore(directory: directory, siteBase: siteBaseURL)
        let epoch = snapshot.validationEpoch, snapshotID = snapshot.summary.snapshotID
        // One synchronous admission replays the complete source catalog once.
        // The scope ends before the first transport await and is never retained.
        let (plan, cached) = try store.withVerifiedReadScope { scoped in
            guard try scoped.load(activeSnapshotSHA256: snapshotID, validationEpoch: epoch)?.records.contains(source.descriptor) == true else { throw AggregateFailure.invalid("图片原目录已变化") }
            let current = try scoped.cachedDocument(descriptor: source.descriptor, rawHTMLSHA256: source.rawHTMLSHA256)
            try PublishedAggregateReader.require(current == source, "图片必须绑定已核验的原网页修订")
            let plan = try scoped.imagePlan(source)
            let cached = try scoped.latestResourceRendering(source: source) ?? scoped.importAndroidResourceRendering(source)
            if let cached { try PublishedAggregateReader.require(cached.manifest.plan == plan.replayHeader(of: cached.manifest.plan), "已存图片与当前网页位置不符") }
            return (plan, cached)
        }
        let retained = Dictionary(uniqueKeysWithValues: (cached?.manifest.images ?? []).filter { $0.sha256 != nil }.map { ($0.slot.index, $0) })
        let retainedByURL = plan.slots.reduce(into: [String: AggregateImageRecord]()) { result, slot in
            if let address = slot.sourceURL, let record = retained[slot.index], result[address] == nil { result[address] = record }
        }
        let retainedBytes = retained.values.reduce(0) { $0 + ($1.bytes ?? 0) }
        try PublishedAggregateReader.require(retainedBytes <= AggregateResources.maxReferencedBytes, "已有图片引用累计超过64 MiB")
        var assets: [Int: AggregateImageBytes] = [:], missing: [Int: String] = [:], downloaded: [String: AggregateImageBytes] = [:], total = 0, referencedBytes = retainedBytes
        for slot in plan.slots {
            try Task.checkCancellation()
            if let record = retained[slot.index] {
                try PublishedAggregateReader.require(record.slot == slot, "已存图片位置不符")
                let asset = try store.retainedResourceBytes(record, legacy: cached?.manifest.schemaFingerprint == nil); assets[slot.index] = asset
                if let address = slot.sourceURL { downloaded[address] = asset }
                continue
            }
            do {
                guard referencedBytes < AggregateResources.maxReferencedBytes else { throw AggregateFailure.invalid("页面图片引用预算已耗尽") }
                let asset: AggregateImageBytes
                if let address = slot.sourceURL, let cached = downloaded[address] { asset = cached }
                else if let address = slot.sourceURL, let record = retainedByURL[address] {
                    asset = try store.retainedResourceBytes(record, legacy: cached?.manifest.schemaFingerprint == nil); downloaded[address] = asset
                }
                else {
                    guard total < AggregateResources.maxTotalBytes else { throw AggregateFailure.invalid("页面图片累计或保守传输预算已耗尽") }
                    let bytes: Data
                    do { bytes = try await aggregateImageData(slot, limit: min(AggregateResources.maxImageBytes, AggregateResources.maxTotalBytes - total, AggregateResources.maxReferencedBytes - referencedBytes)) }
                    catch is CancellationError { throw CancellationError() }
                    catch { if !(error is AggregateFailure) { total = AggregateResources.maxTotalBytes }; throw error }
                    total += bytes.count
                    guard let mime = Self.aggregateImageMIME(bytes) else { throw AggregateFailure.invalid("原图片字节类型不受支持") }
                    asset = .init(data: bytes, mime: mime)
                    if let address = slot.sourceURL { downloaded[address] = asset }
                }
                guard asset.data.count <= AggregateResources.maxReferencedBytes - referencedBytes else { throw AggregateFailure.invalid("页面图片引用累计超过64 MiB") }
                referencedBytes += asset.data.count
                assets[slot.index] = asset
            } catch is CancellationError { throw CancellationError() }
            catch { missing[slot.index] = "该图片未保存；原地址不可用、类型不支持或超出安全限额" }
        }
        try Task.checkCancellation()
        guard snapshot.validationEpoch == epoch, snapshot.summary.snapshotID == snapshotID else { throw AggregateFailure.invalid("保存图片期间目录已变化") }
        // Start a fresh complete scope after transport. A changed catalog or
        // source still rejects; no pre-network qualification crosses the await.
        return try store.withVerifiedReadScope { scoped in
            guard try scoped.load(activeSnapshotSHA256: snapshotID, validationEpoch: epoch)?.records.contains(source.descriptor) == true else { throw AggregateFailure.invalid("保存图片时原目录已变化") }
            return try scoped.cacheResourceRendering(source: source, plan: plan, images: assets, missing: missing, observedAt: Self.now())
        }
    }

    func downloadPDF(for paperID: String, refresh: Bool = false, progress: @escaping @Sendable (Progress) -> Void = { _ in }) async throws -> PDFDownload {
        try await ensureReady()
        if let existingPaper = snapshot.papers.first(where: { $0.id == paperID }),
           existingPaper.identityStatus == "verified",
           (existingPaper.pdfURL == nil || (existingPaper.sourceKind == "arxiv" && existingPaper.sourceVersion == nil)),
           activeDesktopDetails()?.paperDetails[paperID] != nil {
            do {
                _ = try await resolveDesktopDetailForPaper(paperID)
            } catch let epochErr as DesktopEpochChangedError {
                throw ServiceError.invalid(epochErr.localizedDescription)
            }
        }
        guard let paper = (snapshot.papers + (snapshot.retiredPapers ?? [])).first(where: { $0.id == paperID }), paper.identityStatus == "verified", let address = paper.pdfURL, let url = URL(string: address) else { throw ServiceError.unavailable("此记录没有经过核验的原文PDF链接。") }
        let sourceURL = paper.sourceURL.flatMap(URL.init(string:))
        let pdfVersion = (url.path.hasPrefix("/pdf/") ? String(url.path.dropFirst("/pdf/".count)) : url.lastPathComponent).replacingOccurrences(of: #"\.pdf$"#, with: "", options: .regularExpression)
        let absVersion = sourceURL.map { $0.path.hasPrefix("/abs/") ? String($0.path.dropFirst("/abs/".count)) : $0.lastPathComponent }
        let versionMatches = paper.sourceVersion?.range(of: #"v[1-9][0-9]*$"#, options: .regularExpression) != nil && paper.sourceVersion?.replacingOccurrences(of: #"v[1-9][0-9]*$"#, with: "", options: .regularExpression) == String(paperID.dropFirst("arxiv:".count)) && pdfVersion == paper.sourceVersion && absVersion == paper.sourceVersion
        let immutable = paper.sourceKind == "arxiv" && versionMatches && ["arxiv.org", "export.arxiv.org"].contains(url.host?.lowercased() ?? "") && ["arxiv.org", "export.arxiv.org"].contains(sourceURL?.host?.lowercased() ?? "")
        if paper.sourceKind == "arxiv", !versionMatches { throw ServiceError.unavailable("该记录没有一致且明确的arXiv原文版本，不能静默下载或标记最新版。") }
        let pointer = cacheURL("pdf-pointers", key: Self.sha256(Data(address.utf8)), extension: "json")
        var previous: PDFDownload?
        if let data = try? Data(contentsOf: pointer), var existing = try? JSONDecoder().decode(PDFDownload.self, from: data),
           existing.sourceURL == address, existing.version == paper.sourceVersion,
           existing.paperID == nil || existing.paperID == paperID,
           let file = try? PrivateStoragePaths.resolve(existing.filePath, directory: privateDirectory, expectedSHA256: existing.sha256),
           let bytes = try? Data(contentsOf: file), bytes.count == existing.bytes, Self.sha256(bytes) == existing.sha256 {
            existing.filePath = file.path
            previous = existing
            let publishedMatches = paper.pdfSHA256.map { $0 == existing.sha256 } ?? true
            let witnessed = immutable || paper.pdfSHA256 == existing.sha256
            let withinWindow = existing.catalogEpoch == snapshot.validationEpoch && Self.age(existing.validatedAt ?? existing.fetchedAt) <= 6 * 3600
            if !refresh && publishedMatches && (witnessed || withinWindow), existing.isStale != true || witnessed {
                existing.isStale = false; existing.cacheStatus = "current"; existing.publicSHA256 = paper.pdfSHA256; existing.notices = nil
                existing.currentness = paper.pdfSHA256 != nil ? "published-sha256" : immutable ? "immutable-arxiv-version" : "bounded-revalidation"
                return existing // Relocation alone never rewrites original receipt/pointer bytes.
            }
            if !refresh, existing.isStale == true, existing.catalogEpoch == snapshot.validationEpoch, existing.publicSHA256 == paper.pdfSHA256, Self.age(existing.validationAttemptedAt) < 300 { return existing }
        }
        if !refresh, let seed = seedDirectory, let object = seedObject(for: paper), let description = object["pdf"] as? [String: Any],
           let name = description["src"] as? String, !name.contains("/"), !name.contains(".."), let expected = description["sha256"] as? String,
           paper.pdfSHA256 == nil || paper.pdfSHA256 == expected {
            let file = seed.appendingPathComponent("assets").appendingPathComponent(name), bytes = try Data(contentsOf: file)
            guard Self.sha256(bytes) == expected, bytes.count == description["bytes"] as? Int, let pdf = PDFDocument(data: bytes), pdf.pageCount == description["pageCount"] as? Int else { throw ServiceError.invalid("应用内原文PDF缺失或内容不符。") }
            let local = cacheURL("pdf", key: expected, extension: "pdf")
            try atomicWrite(bytes, to: local)
            var result = PDFDownload(filePath: local.path, sha256: expected, version: paper.sourceVersion, sourceURL: address, bytes: bytes.count)
            result.paperID = paperID; result.fetchedAt = Self.now(); result.validatedAt = result.fetchedAt; result.catalogEpoch = snapshot.validationEpoch; result.cacheStatus = "current"; result.isStale = false; result.publicSHA256 = paper.pdfSHA256; result.currentness = "immutable-arxiv-version"
            try preservePDFReceipt(result, paperID: paperID)
            try atomicWrite(try JSONEncoder().encode(result), to: pointer)
            return result
        }
        let epoch = snapshot.validationEpoch
        do {
            progress(Progress(phase: "pdf", message: previous == nil ? "正在下载原始PDF并核对字节" : "正在复核当前网站原文PDF，保留旧SHA副本", completed: 0, total: 0))
            let bytes = try await read(url, limit: 100 * 1024 * 1024)
            guard bytes.starts(with: Data("%PDF-".utf8)), let document = PDFDocument(data: bytes), document.pageCount > 0 else { throw ServiceError.invalid("原文链接未返回完整可读取PDF，没有缓存错误页面。") }
            let sha = Self.sha256(bytes), file = cacheURL("pdf", key: sha, extension: "pdf")
            guard paper.pdfSHA256 == nil || paper.pdfSHA256 == sha else { throw ServiceError.invalid("原文实际字节与已发布PDF SHA不符，未当作当前来源。") }
            try Task.checkCancellation()
            try atomicWrite(bytes, to: file)
            var result = PDFDownload(filePath: file.path, sha256: sha, version: paper.sourceVersion, sourceURL: address, bytes: bytes.count)
            result.paperID = paperID; result.fetchedAt = previous?.sha256 == sha ? previous?.fetchedAt ?? Self.now() : Self.now(); result.validatedAt = Self.now(); result.validationAttemptedAt = result.validatedAt; result.catalogEpoch = epoch; result.cacheStatus = previous == nil ? "current" : "revalidated"; result.isStale = false; result.publicSHA256 = paper.pdfSHA256
            result.currentness = paper.pdfSHA256 != nil ? "published-sha256" : immutable ? "immutable-arxiv-version" : "bounded-revalidation"
            let latest = (snapshot.papers + (snapshot.retiredPapers ?? [])).first { $0.id == paperID }
            let sourceChanged = latest?.pdfURL != paper.pdfURL || latest?.sourceURL != paper.sourceURL || latest?.sourceVersion != paper.sourceVersion || latest?.pdfSHA256 != paper.pdfSHA256
            if epoch != snapshot.validationEpoch && (!immutable || sourceChanged) { result.isStale = true; result.cacheStatus = "stale"; result.notices = ["读取期间网站目录已更新；这份PDF保留原SHA与版本，请再次复核当前来源。"] }
            if let previous { try preservePDFReceipt(previous, paperID: paperID) }
            try preservePDFReceipt(result, paperID: paperID)
            try atomicWrite(try JSONEncoder().encode(result), to: pointer)
            progress(Progress(phase: "complete", message: "原文PDF已保存并校验实际字节", completed: bytes.count, total: bytes.count))
            return result
        } catch {
            if Task.isCancelled || error is CancellationError { throw CancellationError() }
            guard var old = previous else { throw error }
            try preservePDFReceipt(old, paperID: paperID)
            old.isStale = true; old.cacheStatus = "stale"; old.validationAttemptedAt = Self.now(); old.catalogEpoch = epoch; old.publicSHA256 = paper.pdfSHA256
            old.notices = Array(Set((old.notices ?? []) + ["当前PDF复核失败，正在读取先前保存的旧SHA副本（\(old.sha256)，核对时间\(old.validatedAt ?? old.fetchedAt ?? "未知")），不代表网站当前原文。\(error.localizedDescription)"])).sorted()
            try atomicWrite(try JSONEncoder().encode(old), to: pointer)
            return old
        }
    }
    private func preservePDFReceipt(_ value: PDFDownload, paperID: String) throws {
        let file = directory.appendingPathComponent("pdf-receipts/" + Self.sha256(Data(paperID.utf8))).appendingPathComponent(value.sha256 + ".json")
        if !FileManager.default.fileExists(atPath: file.path) { try atomicWrite(try JSONEncoder().encode(value), to: file) }
    }

    func citationFile(for paperID: String, format: String) async throws -> [String: Any] {
        try await ensureReady()
        let names = ["bib": "citation.bib", "ris": "citation.ris", "json": "citation.json"]
        guard let name = names[format], let initialPaper = (snapshot.papers + (snapshot.retiredPapers ?? [])).first(where: { $0.id == paperID }) else { throw ServiceError.invalid("未选择可导出引用的论文或格式。") }
        var addresses: [String: String] = [:], hashes: [String: String] = [:], sizes: [String: Int] = [:]
        if activeDesktopDetails()?.paperDetails[paperID] != nil {
            do {
                if let detailSidecars = try await desktopDetailSidecarAddresses(for: initialPaper) {
                    addresses = detailSidecars.urls
                    hashes = detailSidecars.hashes
                    sizes = detailSidecars.sizes
                }
            } catch let epochErr as DesktopEpochChangedError {
                throw ServiceError.invalid(epochErr.localizedDescription)
            }
        } else {
            let cache = cacheURL("articles", key: Self.sha256(Data(initialPaper.blogURL.utf8)), extension: "json")
            if let data = try? Data(contentsOf: cache), let article = try? JSONDecoder().decode(Article.self, from: data), article.paperID == paperID {
                addresses = article.citationFiles ?? [:]
                hashes = article.citationFileSHA256 ?? [:]
            }
            if addresses[name] == nil {
                // Discover the actual published download link; never synthesize BibTeX/RIS from metadata.
                let data = try await read(try sameSite(initialPaper.blogURL), limit: 8 * 1024 * 1024)
                guard let html = String(data: data, encoding: .utf8) else { throw ServiceError.invalid("引用来源页面不是UTF-8。") }
                let doc = try Self.tidyHTMLDocumentSafely(html)
                try Self.validatePublishedPageIdentity(doc, paper: initialPaper)
                let declared = try publishedSidecarLinks(doc, paper: initialPaper)
                addresses = declared.urls; hashes = declared.hashes
            }
        }
        guard let address = addresses[name] else { throw ServiceError.unavailable("该已发布页面没有此格式的真实引用文件，未现场生成替代引用。") }
        let readLimit = min(sizes[name] ?? 1024 * 1024, 1024 * 1024)
        let data = try await read(try sameSite(address), limit: readLimit)
        if let expectedSize = sizes[name], data.count != expectedSize { throw ServiceError.invalid("引用原件字节长度与已核验详情声明不符。") }
        if let expected = hashes[name], Self.sha256(data) != expected { throw ServiceError.invalid("引用原件与该阅读版本保存的页面声明SHA不符。 ") }
        guard let text = String(data: data, encoding: .utf8), !text.isEmpty, !text.localizedCaseInsensitiveContains("<html") else { throw ServiceError.invalid("引用文件为空或返回了错误页面。") }
        if format == "bib" { guard text.range(of: #"(?m)^\s*@[A-Za-z]+\s*\{"#, options: .regularExpression) != nil else { throw ServiceError.invalid("已发布BibTeX文件格式无效。") } }
        if format == "ris" { guard text.hasPrefix("TY  - "), text.contains("ER  -") else { throw ServiceError.invalid("已发布RIS文件格式无效。") } }
        let latestPaper = (snapshot.papers + (snapshot.retiredPapers ?? [])).first(where: { $0.id == paperID }) ?? initialPaper
        if format == "json" { _ = try Self.validatedSidecar(data, paper: latestPaper, context: false) }
        return ["filename": name, "text": text, "sha256": Self.sha256(data), "sourceURL": address]
    }

    private func publishedSidecarLinks(_ document: XMLDocument, paper: Paper, allowLegacySiblings: Bool = false) throws -> (urls: [String: String], hashes: [String: String]) {
        let declarations = try document.nodes(forXPath: "//script[contains(concat(' ', normalize-space(@class), ' '), ' paper-tools__client-sidecars ')]")
        let names: Set<String> = ["citation.json", "citation.bib", "citation.ris", "rethink-context.json"]
        if !declarations.isEmpty {
            guard declarations.count == 1, let text = declarations[0].stringValue,
                  let bytes = text.data(using: .utf8), bytes.count <= 8192,
                  let descriptors = try JSONSerialization.jsonObject(with: bytes) as? [String: [String: Any]], Set(descriptors.keys) == names else { throw ServiceError.invalid("当前引用文件声明不完整，未改读另一份材料。") }
            guard paper.identityStatus == "verified", String(paper.date.prefix(10)).range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { throw ServiceError.invalid("当前引用声明没有明确的已发布论文身份或日期。") }
            let identifier = paper.sourceKind == "arxiv" ? String(paper.id.dropFirst("arxiv:".count)).replacingOccurrences(of: ".", with: "-").replacingOccurrences(of: "/", with: "-") : "conference-" + String(Self.sha256(Data(paper.id.utf8)).prefix(24))
            let ownerRoot = siteBaseURL.appendingPathComponent("client/papers/" + String(paper.date.prefix(10)) + "/" + identifier + "/")
            var result: [String: String] = [:], hashes: [String: String] = [:]
            for (name, record) in descriptors {
                guard let address = record["url"] as? String, let hash = record["sha256"] as? String,
                      hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw ServiceError.invalid("当前引用文件缺少真实地址或SHA。") }
                let url = try sameSite(address)
                guard url.deletingLastPathComponent().path == (ownerRoot.path.hasSuffix("/") ? String(ownerRoot.path.dropLast()) : ownerRoot.path), url.lastPathComponent == name else { throw ServiceError.invalid("当前引用文件超出已发布资料目录。") }
                if name == "rethink-context.json" {
                    // 2026-11-03 与 11-04 的页面曾把 schemaFingerprint 写成小写
                    // schemafingerprint（Hugo 参数键小写化）。这里只接受这一个已知别名，
                    // 归一化后仍走严格头校验，不放开其他键或历史格式。
                    var context = record
                    if let legacyValue = context["schemafingerprint"] {
                        guard let legacy = legacyValue as? String else { throw ServiceError.invalid("当前上下文文件的结构声明无效。") }
                        if let currentValue = context["schemaFingerprint"] {
                            guard let current = currentValue as? String, current == legacy else { throw ServiceError.invalid("当前上下文文件的结构声明无效。") }
                        } else { context["schemaFingerprint"] = legacy }
                        context.removeValue(forKey: "schemafingerprint")
                    }
                    guard ClientProtocols.hasValidHeader(context, "paper-research-context"), context["contract"] as? String == ClientProtocols.contract("paper-research-context") else { throw ServiceError.invalid("当前上下文文件的结构声明无效。") }
                }
                result[name] = url.absoluteString; hashes[name] = hash
            }
            guard Set(result.values.compactMap { URL(string: $0)?.deletingLastPathComponent().absoluteString }).count == 1 else { throw ServiceError.invalid("当前引用文件混用了不同目录。") }
            return (result, hashes)
        }
        let links = try document.nodes(forXPath: "//a[@href]").compactMap { ($0 as? XMLElement)?.attribute(forName: "href")?.stringValue }
        var result: [String: String] = [:]
        for name in names {
            if let address = links.first(where: { $0.hasSuffix("/" + name) }), let url = try? sameSite(address) { result[name] = url.absoluteString }
        }
        if allowLegacySiblings, let address = result["citation.json"], let url = URL(string: address) {
            // Keep the old article-reader behavior; explicit export still needs its actual link.
            let root = url.deletingLastPathComponent()
            for name in names where result[name] == nil { result[name] = root.appendingPathComponent(name).absoluteString }
        }
        return (result, [:])
    }

    static func validatedSidecar(_ data: Data, paper: Paper, context: Bool) throws -> JSONValue {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              ClientProtocols.hasValidHeader(value, context ? "paper-research-context" : "researcher-sidecars") else { throw ServiceError.invalid("引用附加文件合同不受支持。") }
        if paper.identityStatus == "verified" {
            if paper.sourceKind == "arxiv" {
                let id = (value["arxivId"] as? String ?? value["id"] as? String ?? "").replacingOccurrences(of: #"v[1-9][0-9]*$"#, with: "", options: .regularExpression)
                guard "arxiv:" + id == paper.id else { throw ServiceError.invalid("引用附加文件属于其他论文。") }
                if let expected = paper.sourceVersion {
                    let identifiers = [value["arxivVersionedId"] as? String, value["id"] as? String, value["arxivId"] as? String].compactMap { $0 }
                    guard identifiers.allSatisfy({ $0.range(of: #"v[1-9][0-9]*$"#, options: .regularExpression) == nil || $0 == expected }) else { throw ServiceError.invalid("引用附加文件对应其他原文版本。") }
                }
                for (field, expected) in [("absUrl", paper.sourceURL), ("pdfUrl", paper.pdfURL)] {
                    if let address = value[field] as? String, !address.isEmpty, let expected, address != expected { throw ServiceError.invalid("引用附加文件来源与当前原文版本不一致。") }
                }
            } else {
                guard value["paperId"] as? String == paper.id || value["id"] as? String == paper.id else { throw ServiceError.invalid("引用附加文件属于其他会议论文。") }
            }
        }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    func handle(command: String, payload: sending [String: Any], progress: @escaping @Sendable ([String: Any]) -> Void = { _ in }) async throws -> sending [String: Any] {
        switch command {
        case "library.status": return try await statusResponse()
        // `library.retryLoad` and `library.sync` are the commands that repair a failed load;
        // gating them behind `ensureReady()` would rethrow the old failure before their own
        // branches could re-read. `sync()` still awaits a decode that is genuinely pending.
        case "library.network", "library.cancel", "library.retryLoad", "library.sync": break
        default: try await ensureReady()
        }
        let notify: @Sendable (Progress) -> Void = { progress($0.json) }
        switch command {
        case "library.sync": return try Self.dictionary(try await sync(progress: notify))
        case "library.list": return listResponse(payload: payload)
        case "library.search":
            let hits = searchCachedText(payload["query"] as? String ?? "")
            return ["ids": hits, "cachedTextIDs": hits, "scope": "仅本机已读取导读正文，不检索PDF原文"]
        case "library.retryLoad":
            try await retryLoad()
            return try Self.dictionary(await status())
        case "library.citationFile":
            guard let id = payload["paperID"] as? String ?? payload["id"] as? String else { throw ServiceError.invalid("未选择论文。") }
            return try await citationFile(for: id, format: payload["format"] as? String ?? "json")
        case "library.paperDetail":
            guard let id = payload["paperID"] as? String ?? payload["id"] as? String else { throw ServiceError.invalid("未选择论文。") }
            return try await paperDetailResponse(id: id)
        case "library.tagIndex":
            return tagIndex()
        case "library.resourceBadges":
            return try await resourceBadgesResponse(forceRefresh: payload["refresh"] as? Bool ?? false)
        case "library.article":
            guard let id = payload["paperID"] as? String ?? payload["id"] as? String else { throw ServiceError.invalid("未选择论文。") }
            return try Self.dictionary(try await article(for: id, refresh: payload["refresh"] as? Bool ?? false, downloadImages: payload["downloadImages"] as? Bool ?? true, progress: notify))
        case "library.downloadPDF":
            guard let id = payload["paperID"] as? String ?? payload["id"] as? String else { throw ServiceError.invalid("未选择论文。") }
            return try Self.dictionary(try await downloadPDF(for: id, refresh: payload["refresh"] as? Bool ?? false, progress: notify))
        case "library.cancel": cancelSync(); return ["cancelRequested": true, "message": "已请求停止目录同步；其他阅读和原文任务不受影响，旧资料库保留。"]
        case "library.network": try configureNetwork(httpProxy: payload["httpProxy"] as? String); return ["proxyConfigured": httpProxy != nil]
        default: throw ServiceError.invalid("不支持的资料命令。")
        }
    }

    func cacheURL(_ name: String, key: String, extension ext: String) -> URL {
        directory.appendingPathComponent(name, isDirectory: true).appendingPathComponent("\(key).\(ext)")
    }
    func atomicWrite(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try data.write(to: url, options: [.atomic])
        if url.path.contains("/articles/") {
            cachedDemoPaperIDs = nil
        }
    }
    static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func now() -> String { ISO8601DateFormatter().string(from: Date()) }

    func aggregateLatestVerifiedDocument(id: String) throws -> AggregateDocument? {
        try PublishedAggregateStore(directory: directory, siteBase: siteBaseURL).withVerifiedReadScope { store in
            guard let catalog = try store.load(activeSnapshotSHA256: snapshot.summary.snapshotID, validationEpoch: snapshot.validationEpoch), let descriptor = catalog.records.first(where: { $0.id == id }) else { throw AggregateFailure.invalid("当前汇总目录未核验") }
            return try store.latestVerifiedDocument(for: descriptor)
        }
    }
}
