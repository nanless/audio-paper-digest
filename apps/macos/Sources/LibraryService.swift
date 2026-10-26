import Foundation
import CryptoKit
import Darwin
import PDFKit

/// Published-site data and disposable caches. Personal notes and credentials never enter this store.
actor LibraryService {
    enum ServiceError: LocalizedError {
        case invalid(String), unavailable(String), network(String), cancelled
        var errorDescription: String? {
            switch self {
            case .invalid(let s), .unavailable(let s), .network(let s): return s
            case .cancelled: return "操作已取消，上一份完整资料库仍然可用。"
            }
        }
    }
    enum Sort: String, Sendable { case date, score, title }
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
    private struct StoredSnapshot: Codable {
        var format = "mac-published-library-v1"
        var summary: Summary
        var papers: [Paper]
        var retiredPapers: [Paper]? = nil
        var validationEpoch: String? = nil
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
    private let directory: URL
    private let privateDirectory: URL
    private let siteBaseURL: URL
    private let transport: Transport?
    private let session: URLSession
    private var snapshot: StoredSnapshot
    private var syncTask: Task<Summary, Error>?
    private var syncID: UUID?
    private var httpProxy: URL?
    private var activeTransfers: [UUID: Process] = [:]
    private var fullTextIndex: [String: String] = [:]
    private let seedDirectory: URL?
    private static let maxTotal = 64 * 1024 * 1024
    private static let approvedHosts: Set<String> = ["arxiv.org", "export.arxiv.org", "www.isca-archive.org", "isca-archive.org", "openreview.net", "proceedings.mlr.press", "papers.nips.cc", "proceedings.neurips.cc", "aclanthology.org"]
    // These are published image layouts, not a grant to arbitrary GitHub content.
    // Keep owner/repository/branch and every path component exact; each redirect
    // passes the same policy again before DNS validation and fixed-IP transfer.
    static func isOwnedPublishedImage(_ url:URL)->Bool {
        guard url.scheme=="https",url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,
              url.port==nil || url.port==443,let components=URLComponents(url:url,resolvingAgainstBaseURL:false),
              !components.percentEncodedPath.contains("%"),!components.percentEncodedPath.contains("\\"),!components.percentEncodedPath.contains("//") else{return false}
        let path=components.percentEncodedPath
        if url.host?.lowercased()=="raw.githubusercontent.com" {
            let parts=path.split(separator:"/",omittingEmptySubsequences:false)
            let conferences:Set<String>=["interspeech-2026","dafx-2026","acl-2026","eusipco-2026","cvpr-2026","nime-2026","speechprosody-2026","aaai-2026","odyssey-2026","icmc-2026","jep-2026","eacl-2026","iwslt-2026","chime-2026","uai-2026","aistats-2026"]
            guard parts.count==7,parts[0].isEmpty,parts[1]=="nanless",parts[2]=="audio-paper-digest-images",parts[3]=="main",conferences.contains(String(parts[4])) else{return false}
            return parts[5].range(of:#"\A[a-f0-9]{12}\z"#,options:.regularExpression) != nil && parts[6].range(of:#"\Afigure-[1-9][0-9]*\.png\z"#,options:.regularExpression) != nil
        }
        if url.host?.lowercased()=="nanless.github.io" {
            let parts=path.split(separator:"/",omittingEmptySubsequences:false)
            guard parts.count==5,parts[0].isEmpty,parts[1]=="audio-paper-digest-images",["icassp-2026","iclr-2026"].contains(parts[2]),parts[3].range(of:#"\A2026-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])\z"#,options:.regularExpression) != nil else{return false}
            let pattern=parts[2]=="icassp-2026" ? #"\A[0-9]{8}-[0-9]+\.(?:png|jpg)\z"# : #"\A[A-Za-z0-9]{10}-[0-9]+\.(?:png|jpg)\z"#
            return parts[4].range(of:pattern,options:.regularExpression) != nil
        }
        return false
    }
    static func isApprovedExternalResource(_ url:URL)->Bool {
        guard url.scheme=="https",let host=url.host?.lowercased(),url.user==nil,url.password==nil,url.port==nil || url.port==443 else{return false}
        return approvedHosts.contains(host) || isOwnedPublishedImage(url)
    }
    static func externalResourceProxy(_ url:URL,configured:URL?)->URL? {
        let host=url.host?.lowercased()
        return host=="arxiv.org" || host=="export.arxiv.org" || isOwnedPublishedImage(url) ? configured:nil
    }

    init(dataDirectory: URL, siteBaseURL: URL = URL(string: "https://nanless.github.io/audio-paper-digest-blog/")!, seedDirectory: URL? = nil, transport: Transport? = nil, sessionConfiguration: URLSessionConfiguration? = nil) throws {
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
        self.seedDirectory = seedDirectory ?? Bundle.main.resourceURL?.appendingPathComponent("Seed", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let current = directory.appendingPathComponent("current.json")
        if FileManager.default.fileExists(atPath: current.path) {
            let bytes = try Data(contentsOf: current)
            guard bytes.count <= Self.maxTotal else { throw ServiceError.invalid("本地目录超过大小限制，请保留原文件后恢复备份。") }
            let decoded = try JSONDecoder().decode(StoredSnapshot.self, from: bytes)
            guard decoded.format == "mac-published-library-v1" else { throw ServiceError.invalid("本地资料库版本尚不支持。") }
            snapshot = decoded
        } else {
            snapshot = StoredSnapshot(summary: Summary(paperCount: 0, recordCount: 0, shardCount: 0, snapshotID: "", syncedAt: nil, source: "尚未同步", syncing: false, missingFromLatest: []), papers: [])
        }
        if snapshot.papers.isEmpty, let seed = self.seedDirectory,
           let bytes = try? Data(contentsOf: seed.appendingPathComponent("sample.json")), bytes.count <= 8 * 1024 * 1024,
           let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], let rows = object["librarySample"] as? [[String: Any]] {
            let papers = rows.compactMap { row -> Paper? in
                guard let identifier = row["id"] as? String, let title = row["title"] as? String,
                      let blog = row["blogUrl"] as? String, let url = URL(string: blog), url.host == siteBaseURL.host,
                      url.path.hasPrefix(siteBaseURL.path + "/") else { return nil }
                let authors = (row["authors"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
                let source = row["absUrl"] as? String, pdf = row["pdfUrl"] as? String
                let version = source.flatMap(URL.init(string:))?.lastPathComponent
                let citation: [String: Any] = ["contract": "paper-citation-source-v1", "paperKey": "arxiv:" + identifier, "identityStatus": "verified", "verified": true, "complete": false, "title": title, "authors": authors, "arxivId": version ?? identifier, "sourceUrl": source ?? "", "pdfUrl": pdf ?? "", "date": "", "doi": "", "venue": "", "sourceKind": "arxiv"]
                return Paper(id: "arxiv:" + identifier, title: title, titleZh: row["titleZh"] as? String ?? title, authors: authors, date: row["date"] as? String ?? "", score: Self.publishedScore(row["score"]), task: row["task"] as? String ?? "", method: row["method"] as? String ?? "", tags: row["tags"] as? [String] ?? [], sourceKind: "arxiv", identityStatus: "verified", pageType: "paper", blogURL: blog, sourceURL: source, pdfURL: pdf, sourceVersion: version, appearances: [blog], citation: (try? JSONValue.from(citation)) ?? .null)
            }
            snapshot = StoredSnapshot(summary: Summary(paperCount: papers.count, recordCount: rows.count, shardCount: 0, snapshotID: Self.sha256(bytes), syncedAt: nil, source: "应用内已发布样稿（尚未全站同步）", syncing: false, missingFromLatest: []), papers: papers)
        }
        if let data = try? Data(contentsOf: directory.appendingPathComponent("fulltext.json")), data.count <= 32 * 1024 * 1024,
           let values = try? JSONDecoder().decode([String: String].self, from: data) { fullTextIndex = values }
    }

    func status() -> Summary {
        var value = snapshot.summary
        value.syncing = syncTask != nil
        return value
    }

    func list(query: String = "", source: String? = nil, minimumScore: Double? = nil, sort: Sort = .date, offset: Int = 0, limit: Int = 200) -> [Paper] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        let filtered = snapshot.papers.filter { p in
            (source == nil || source == "all" || p.sourceKind == source) &&
            (minimumScore == nil || (p.score ?? -.infinity) >= minimumScore!) &&
            (needle.isEmpty || ([p.id, p.title, p.titleZh, p.task, p.method] + p.authors + p.tags).joined(separator: " ").folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current).contains(needle))
        }.sorted { a, b in
            switch sort {
            case .score: if a.score != b.score { return (a.score ?? -.infinity) > (b.score ?? -.infinity) }
            case .title: if a.title != b.title { return a.title.localizedStandardCompare(b.title) == .orderedAscending }
            case .date: if a.date != b.date { return a.date > b.date }
            }
            return a.id < b.id
        }
        return Array(filtered.dropFirst(max(0, offset)).prefix(max(0, min(limit, 10000))))
    }

    func sync(progress: @escaping @Sendable (Progress) -> Void = { _ in }) async throws -> Summary {
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

    private func performSync(identifier: UUID, progress: @escaping @Sendable (Progress) -> Void) async throws -> Summary {
        progress(Progress(phase: "manifest", message: "正在读取网站目录清单", completed: 0, total: 0))
        let index = try await read(siteBaseURL.appendingPathComponent("index.json"), limit: Self.maxTotal)
        try Task.checkCancellation()
        let raw = try JSONSerialization.jsonObject(with: index)
        var records: [[String: Any]] = []
        var shardCount = 0
        if let legacy = raw as? [[String: Any]] {
            records = legacy
        } else {
            let manifest = try JSONDecoder().decode(Manifest.self, from: index)
            guard manifest.contract == "paper-search-index-manifest-v1", !manifest.shards.isEmpty,
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
                    data = try await read(try sameSite(shard.url), limit: 1024 * 1024)
                    guard data!.count == shard.bytes, Self.sha256(data!) == shard.sha256 else { throw ServiceError.invalid("网站分片内容与清单不符，保留上一份资料库。") }
                    try atomicWrite(data!, to: file)
                }
                guard let values = try JSONSerialization.jsonObject(with: data!) as? [[String: Any]], values.count == shard.recordCount else { throw ServiceError.invalid("网站分片记录数量不符。") }
                records.append(contentsOf: values)
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
                if paper.date > old.date { old = paper }
                old.appearances = appearances
                papersByID[paper.id] = old
            } else { papersByID[paper.id] = paper }
        }
        guard !papersByID.isEmpty else { throw ServiceError.invalid("网站目录没有可读取的论文，未覆盖现有资料。") }
        let currentIDs = Set(papersByID.keys)
        let previousIDs = Set(snapshot.papers.map(\.id))
        let missing = Set(snapshot.summary.missingFromLatest).union(previousIDs.subtracting(currentIDs)).subtracting(currentIDs)
        let summary = Summary(paperCount: papersByID.count, recordCount: records.count, shardCount: shardCount, snapshotID: Self.sha256(index), syncedAt: Self.now(), source: siteBaseURL.absoluteString, syncing: false, missingFromLatest: missing.sorted())
        var replacement = StoredSnapshot(summary: summary, papers: papersByID.values.sorted { $0.id < $1.id })
        replacement.validationEpoch = UUID().uuidString
        replacement.retiredPapers = Dictionary((snapshot.papers + (snapshot.retiredPapers ?? [])).filter { !currentIDs.contains($0.id) }.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }).values.sorted { $0.id < $1.id }
        try Task.checkCancellation()
        guard syncID == identifier else { throw CancellationError() }
        let encoded = try JSONEncoder().encode(replacement)
        guard encoded.count <= Self.maxTotal else { throw ServiceError.invalid("合并后的本地目录超过大小限制。") }
        try atomicWrite(encoded, to: directory.appendingPathComponent("current.json"))
        snapshot = replacement
        progress(Progress(phase: "complete", message: "已同步 \(summary.paperCount) 篇论文，\(summary.recordCount) 条页面记录", completed: shardCount, total: shardCount))
        return summary
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
                     sourceVersion: version?.isEmpty == false ? version : nil, appearances: [blog.absoluteString], citation: try JSONValue.from(citation), pdfSHA256: try Self.publishedPDFHash(row, citation: citation))
    }

    /// Hugo publishes the structured score as a decimal string; older indexes may use a JSON number.
    /// Only this declared field is read. Body prose, dimension totals and citation numbers are not scores.
    private static func publishedScore(_ value:Any?) -> Double? {
        let score:Double?
        if let number=value as? NSNumber {
            guard CFGetTypeID(number) != CFBooleanGetTypeID() else{return nil}
            score=number.doubleValue
        }else if let text=value as? String {
            score=Double(text.trimmingCharacters(in:.whitespacesAndNewlines))
        }else{return nil}
        guard let score,score.isFinite,(0...10).contains(score) else{return nil}
        return score
    }

    func article(for paperID: String, refresh: Bool = false, downloadImages: Bool = true, progress: @escaping @Sendable (Progress) -> Void = { _ in }) async throws -> Article {
        guard let paper = (snapshot.papers + (snapshot.retiredPapers ?? [])).first(where: { $0.id == paperID }) else { throw ServiceError.unavailable("论文不在已保存的发布资料库中。请先同步，或从论文库重新选择。") }
        let cache = cacheURL("articles", key: Self.sha256(Data(paper.blogURL.utf8)), extension: "json")
        var previous: Article?
        if let data = try? Data(contentsOf: cache), let cached = try? JSONDecoder().decode(Article.self, from: data), cached.paperID == paperID { previous = cached }
        if !refresh, var cached = previous {
            if cached.markdown==nil,cached.mathMLContract != "published-html-mathml-v1"{cached.notices.append("这份旧HTML缓存未经过公式结构保真读取，部分MathML可能缺失；原稿保留，请联网重新读取网站导读。")}
            let missing = !resourcesVerified(cached)
            if missing { cached.completeOffline = false }
            let parserCurrent=cached.markdown != nil || cached.mathMLContract=="published-html-mathml-v1"
            let current = parserCurrent && Self.sourceMatches(cached, paper: paper) && cached.catalogEpoch == snapshot.validationEpoch && Self.age(cached.fetchedAt) <= 6 * 3600
            if current && (!downloadImages || !missing), cached.isStale != true { return Self.presentSourceWarning(cached) }
            if cached.isStale == true, cached.catalogEpoch == snapshot.validationEpoch, cached.expectedSourceVersion == paper.sourceVersion, Self.age(cached.validationAttemptedAt) < 300 { return Self.presentSourceWarning(cached) }
        }
        if !refresh, snapshot.summary.syncedAt == nil, var seeded = try seedArticle(paper) {
            seeded.blogURL = paper.blogURL; seeded.cacheStatus = "bundled"; seeded.isStale = false
            indexText(seeded); return Self.presentSourceWarning(seeded)
        }
        do {
            return try await fetchArticle(paper, cache: cache, previous: previous, downloadImages: downloadImages, progress: progress)
        } catch {
            if Task.isCancelled || error is CancellationError { throw CancellationError() }
            guard var old = previous ?? (try? seedArticle(paper)) else { throw error }
            old.isStale = true; old.cacheStatus = "stale"; old.validationAttemptedAt = Self.now(); old.expectedSourceVersion = paper.sourceVersion; old.catalogEpoch = snapshot.validationEpoch
            old.completeOffline = old.completeOffline && resourcesVerified(old)
            if old.markdown==nil,old.mathMLContract != "published-html-mathml-v1"{old.notices.append("这份旧HTML缓存未经过公式结构保真读取，部分MathML可能缺失；原稿保留，请联网重新读取网站导读。")}
            old.notices = Array(Set(old.notices + ["网站当前修订复验失败，正在读取先前保存的旧导读；获取于\(old.fetchedAt)，旧来源版本\(old.sourceVersion ?? "未标版本")，目录期待版本\(paper.sourceVersion ?? "未标版本")。\(error.localizedDescription)"])).sorted()
            if previous != nil { try atomicWrite(try JSONEncoder().encode(old), to: cache) }
            return Self.presentSourceWarning(old)
        }
    }
    private func fetchArticle(_ paper: Paper, cache: URL, previous: Article?, downloadImages: Bool, progress: @escaping @Sendable (Progress) -> Void) async throws -> Article {
        let validationEpoch = snapshot.validationEpoch
        progress(Progress(phase: "article", message: "正在读取已发布图文导读", completed: 0, total: 0))
        let raw = try await read(try sameSite(paper.blogURL), limit: 8 * 1024 * 1024)
        guard let html = String(data: raw, encoding: .utf8) else { throw ServiceError.invalid("文章不是有效 UTF-8 文本。") }
        var article = try Self.extractArticle(html, paper: paper, pageURL: URL(string: paper.blogURL)!)
        var notices = article.notices
        let metadataDocument = try XMLDocument(xmlString: html, options: [.documentTidyHTML, .nodeLoadExternalEntitiesNever])
        let citationLinks = try metadataDocument.nodes(forXPath: "//a[@href]").compactMap { ($0 as? XMLElement)?.attribute(forName: "href")?.stringValue }
        if let path = citationLinks.first(where: { $0.hasSuffix("/citation.json") }), let citationURL = try? sameSite(path) {
            let root = citationURL.deletingLastPathComponent()
            article.citationFiles = Dictionary(uniqueKeysWithValues: ["citation.json", "citation.bib", "citation.ris", "rethink-context.json"].map { ($0, root.appendingPathComponent($0).absoluteString) })
            do {
                let data = try await read(citationURL, limit: 1024 * 1024)
                article.citationSidecar = try Self.validatedSidecar(data, paper: paper, context: false)
            } catch is CancellationError { throw CancellationError() }
            catch { notices.append("引用附加文件尚未读取，保留页面已核验字段。") }
            do {
                let data = try await read(root.appendingPathComponent("rethink-context.json"), limit: 1024 * 1024)
                article.researchContext = try Self.validatedSidecar(data, paper: paper, context: true)
            } catch is CancellationError { throw CancellationError() }
            catch { notices.append("研究上下文附加文件缺失或尚不可读。") }
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
        indexText(article)
        return article
    }
    private func preserveRevision(_ article: Article, blogURL: String) throws {
        let bytes = try JSONEncoder().encode(article), key = Self.sha256(Data(blogURL.utf8))
        var identity = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        for transient in ["fetchedAt", "catalogEpoch", "isStale", "cacheStatus", "validationAttemptedAt", "expectedSourceVersion", "notices"] { identity.removeValue(forKey: transient) }
        let revision = Self.sha256(try JSONSerialization.data(withJSONObject: identity, options: .sortedKeys))
        let file = directory.appendingPathComponent("article-revisions/" + key).appendingPathComponent(revision + ".json")
        if !FileManager.default.fileExists(atPath: file.path) { try atomicWrite(bytes, to: file) }
    }
    static func presentSourceWarning(_ article:Article, blogURL:String?=nil)->Article {
        guard case .object(let fields)=article.citation else{return article}
        var citation:[String:Any]=[:]
        for key in ["contract","verified","identityStatus","paperKey","paperId","pageUrl","sourceUrl","url","pdfUrl","sourceKind","arxivId","sourceVersionWarning"] {
            guard let field=fields[key] else{continue}
            switch field {case .string(let value):citation[key]=value;case .bool(let value):citation[key]=value;default:citation[key]=NSNull()}
        }
        var result=article
        result.notices=PublishedSourceWarning.merge(article.notices,citation:citation,material:.init(paperID:article.paperID,blogURL:article.blogURL ?? blogURL,sourceURL:article.sourceURL,pdfURL:article.pdfURL,sourceVersion:article.sourceVersion))
        return result
    }
    private static func sourceMatches(_ article: Article, paper: Paper) -> Bool {
        article.paperID == paper.id && article.blogURL == paper.blogURL && article.sourceURL == (paper.sourceURL ?? paper.blogURL) && article.pdfURL == paper.pdfURL && article.sourceVersion == paper.sourceVersion
    }
    private static func age(_ value: String?) -> TimeInterval {
        guard let value, let date = ISO8601DateFormatter().date(from: value) else { return .infinity }
        let interval = Date().timeIntervalSince(date)
        return interval < -300 ? .infinity:max(0, interval)
    }
    private func resourcesVerified(_ article: Article) -> Bool {
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
    private func indexText(_ article: Article) {
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
        let context: [String: Any] = ["contract": "desktop-bundled-research-context-v1", "origin": "bundled-published-sample", "sampleOnly": true,
                                      "sourceContract": object["contract"] ?? NSNull(), "paperID": paper.id, "sourceURL": paper.sourceURL ?? paper.blogURL,
                                      "blogURL": paper.blogURL, "sourceVersion": paper.sourceVersion ?? "", "originalTitle": paper.title, "readerTitle": paper.titleZh,
                                      "authors": primary["authors"] ?? [], "abstract": object["abstract"] ?? NSNull(),
                                      "oneSentenceThesis": primary["summary"] ?? NSNull(), "assessment": ["score": primary["score"] ?? NSNull(), "primaryTask": primary["task"] ?? "", "primaryMethod": primary["method"] ?? "", "tags": primary["tags"] ?? []]]
        result.researchContext = try JSONValue.from(context)
        return result
    }

    // Foundation HTML tidy removes unknown HTML5/MathML tags, including their
    // TeX annotation. Protect only complete, independently validated MathML;
    // the surrounding HTML still passes through the original HTML sanitizer.
    private static func htmlDocumentPreservingMath(_ raw:String)throws->XMLDocument {
        let bytes=Array(raw.utf8)
        guard bytes.count<=16*1024*1024 else{throw ServiceError.invalid("公式保真读取的页面超过16 MiB。")}
        guard !raw.localizedCaseInsensitiveContains("<!ENTITY") else{throw ServiceError.invalid("文章包含不允许的实体声明。")}
        struct Tag {let end:Int;let name:String;let closing:Bool;let empty:Bool}
        func starts(_ text:String,at index:Int)->Bool {
            let expected=Array(text.utf8);guard index+expected.count<=bytes.count else{return false}
            return expected.indices.allSatisfy{offset in let value=bytes[index+offset];return (65...90).contains(value) ? value+32==expected[offset]:value==expected[offset]}
        }
        func endOf(_ delimiter:String,from start:Int)throws->Int {
            let expected=Array(delimiter.utf8);var index=start
            while index+expected.count<=bytes.count {if bytes[index..<(index+expected.count)].elementsEqual(expected){return index+expected.count};index+=1}
            throw ServiceError.invalid("文章中的注释或CDATA没有完整闭合，未猜测公式边界。")
        }
        func tag(at start:Int)throws->Tag? {
            guard bytes[start]==60 else{return nil}
            var index=start+1,closing=false
            if index<bytes.count,bytes[index]==47{closing=true;index+=1}
            let nameStart=index
            while index<bytes.count,((65...90).contains(bytes[index]) || (97...122).contains(bytes[index]) || (48...57).contains(bytes[index]) || bytes[index]==45 || bytes[index]==58){index+=1}
            guard index>nameStart else{return nil}
            let name=String(decoding:bytes[nameStart..<index],as:UTF8.self).lowercased()
            var quote:UInt8?=nil
            while index<bytes.count,index-start<=65536 {
                let value=bytes[index]
                if let active=quote {if value==active{quote=nil}}
                else if value==34 || value==39{quote=value}
                else if value==62 {var previous=index-1;while previous>start,[9,10,13,32].contains(bytes[previous]){previous-=1};return Tag(end:index+1,name:name,closing:closing,empty:bytes[previous]==47)}
                index+=1
            }
            throw ServiceError.invalid("文章标签不完整或超过64 KiB，未猜测公式边界。")
        }
        func declarationEnd(at start:Int)throws->Int {
            var index=start+2,quote:UInt8?=nil
            while index<bytes.count,index-start<=65536 {
                let value=bytes[index]
                if let active=quote{if value==active{quote=nil}}
                else if value==34 || value==39{quote=value}
                else if value==62{return index+1}
                index+=1
            }
            throw ServiceError.invalid("文章声明不完整，未交给外部实体解析器。")
        }
        let nonce="paperdigest-math-"+UUID().uuidString.lowercased()+"-"
        guard !raw.contains(nonce) else{throw ServiceError.invalid("公式保真标记发生冲突。")}
        var position=0,last=0,output=Data(),rawText:String?=nil,formulas:[(String,XMLElement)]=[],formulaBytes=0
        while position<bytes.count {
            if let rawName=rawText {
                // Raw text follows HTML closing-tag rules, not JavaScript/string
                // quoting. Do not tokenize apparent formulas inside this text.
                if bytes[position]==60,starts("</"+rawName,at:position),let token=try tag(at:position),token.closing,token.name==rawName{rawText=nil;position=token.end}else{position+=1}
                continue
            }
            guard bytes[position]==60 else{position+=1;continue}
            if starts("<!--",at:position){position=try endOf("-->",from:position+4);continue}
            if starts("<![cdata[",at:position){position=try endOf("]]>",from:position+9);continue}
            if starts("<!",at:position){
                let end=try declarationEnd(at:position),declaration=String(decoding:bytes[position..<end],as:UTF8.self)
                guard declaration.range(of:#"\A<!DOCTYPE[\t\r\n ]+html[\t\r\n ]*>\z"#,options:[.regularExpression,.caseInsensitive]) != nil else{throw ServiceError.invalid("文章包含不支持的DOCTYPE或实体声明。")}
                position=end;continue
            }
            guard let token=try tag(at:position) else{position+=1;continue}
            if token.name.hasSuffix(":math"){throw ServiceError.invalid("暂不支持带前缀的MathML根节点，未静默丢弃公式。")}
            if !token.closing,token.name=="plaintext"{position=bytes.count;continue}
            if !token.closing,["script","style","textarea","title","xmp","iframe","noembed","noframes"].contains(token.name){rawText=token.name;position=token.end;continue}
            if token.name=="math",token.closing{throw ServiceError.invalid("文章包含没有对应起点的MathML结束标签。")}
            guard token.name=="math" else{position=token.end;continue}
            let beginning=position;var end=token.end,depth=token.empty ? 0:1
            while depth>0 {
                guard end<bytes.count,end-beginning<=256*1024 else{throw ServiceError.invalid("单个MathML超过256 KiB或未完整闭合。")}
                if bytes[end] != 60 {end+=1;continue}
                if starts("<!--",at:end){end=try endOf("-->",from:end+4);continue}
                if starts("<![cdata[",at:end){end=try endOf("]]>",from:end+9);continue}
                guard !starts("<!",at:end) else{throw ServiceError.invalid("MathML中不允许DOCTYPE或实体声明。")}
                if let child=try tag(at:end){if child.name=="math"{if child.closing{depth-=1}else if !child.empty{depth+=1}};end=child.end}else{end+=1}
            }
            guard end-beginning<=256*1024,formulas.count<512,formulaBytes+end-beginning<=2*1024*1024 else{throw ServiceError.invalid("MathML数量或总大小超过保真读取上限。")}
            let source=String(decoding:bytes[beginning..<end],as:UTF8.self)
            let parsed=try XMLDocument(xmlString:source,options:[.nodePreserveWhitespace,.nodeLoadExternalEntitiesNever])
            guard let math=parsed.rootElement(),math.name?.lowercased()=="math" else{throw ServiceError.invalid("MathML必须是独立且完整的math节点。")}
            var count=0;try sanitizeMathML(math,depth:0,count:&count)
            // In HTML, an unqualified <math> enters the MathML namespace even
            // without an explicit xmlns. Pin it before inserting into XHTML.
            if math.uri==nil{math.addNamespace(XMLNode.namespace(withName:"",stringValue:"http://www.w3.org/1998/Math/MathML") as! XMLNode)}
            let marker=nonce+String(formulas.count)
            output.append(contentsOf:bytes[last..<beginning]);output.append(contentsOf:"<span id=\"\(marker)\"></span>".utf8)
            formulas.append((marker,math.copy() as! XMLElement));formulaBytes+=end-beginning;last=end;position=end
        }
        output.append(contentsOf:bytes[last..<bytes.count])
        let doc=try XMLDocument(xmlString:String(decoding:output,as:UTF8.self),options:[.documentTidyHTML,.nodeLoadExternalEntitiesNever])
        for (marker,math) in formulas {
            let matches=try doc.nodes(forXPath:"//*[@id='\(marker)']")
            guard matches.count==1,let slot=matches.first as? XMLElement,slot.name?.lowercased()=="span",slot.childCount==0,let parent=slot.parent as? XMLElement else{throw ServiceError.invalid("HTML解析改变了公式占位，未静默丢弃或异位恢复公式。")}
            parent.replaceChild(at:slot.index,with:math)
        }
        guard !doc.xmlString.contains(nonce) else{throw ServiceError.invalid("公式保真占位没有完全恢复。")}
        return doc
    }
    private static func sanitizeMathML(_ element:XMLElement,depth:Int,count:inout Int)throws {
        count+=1;guard depth<=64,count<=8192 else{throw ServiceError.invalid("MathML层级或节点数量超过保真上限。")}
        let tags:Set<String>=["math","semantics","annotation","mrow","mi","mn","mo","mtext","ms","mspace","mfrac","msqrt","mroot","msup","msub","msubsup","mover","munder","munderover","mtable","mtr","mlabeledtr","mtd","mstyle","mpadded","mphantom","menclose","mmultiscripts","mprescripts","none","merror"]
        let attributes:Set<String>=["display","mathvariant","encoding","stretchy","fence","separator","accent","accentunder","symmetric","movablelimits","largeop","lspace","rspace","width","height","depth","voffset","minsize","maxsize","mathsize","mathcolor","mathbackground","displaystyle","scriptlevel","columnalign","rowalign","columnspacing","rowspacing","columnlines","rowlines","columnspan","rowspan","equalrows","equalcolumns","frame","framespacing","notation","linethickness","numalign","denomalign","bevelled","form","dir","id","class","title"]
        guard let rawName=element.name,!rawName.contains(":"),tags.contains(rawName.lowercased()),element.uri==nil || element.uri=="http://www.w3.org/1998/Math/MathML" else{throw ServiceError.invalid("MathML包含不支持的外来或活动节点。")}
        element.name=rawName.lowercased()
        for namespace in element.namespaces ?? [] {guard namespace.stringValue=="http://www.w3.org/1998/Math/MathML" else{throw ServiceError.invalid("MathML包含不支持的命名空间。")}}
        for attribute in element.attributes ?? [] {
            let rawName=attribute.name ?? "",name=rawName.lowercased(),value=attribute.stringValue ?? ""
            if name.hasPrefix("on") || ["href","src","xlink:href","style"].contains(name){element.removeAttribute(forName:rawName);continue}
            guard attributes.contains(name),!rawName.contains(":"),value.utf8.count<=4096,!value.localizedCaseInsensitiveContains("url("),!value.localizedCaseInsensitiveContains("javascript:") else{throw ServiceError.invalid("MathML包含不支持的属性，未猜测公式结构。")}
            attribute.name=name
        }
        if element.name=="annotation" {
            guard ["application/x-tex","application/x-latex","text/plain"].contains(element.attribute(forName:"encoding")?.stringValue ?? ""),!(element.children ?? []).contains(where:{$0 is XMLElement}) else{throw ServiceError.invalid("MathML annotation必须是受支持编码的纯文本，未将嵌套结构猜为TeX。")}
        }
        for child in element.children ?? [] {
            if let nested=child as? XMLElement {try sanitizeMathML(nested,depth:depth+1,count:&count)}
            else {
                count+=1;guard count<=8192 else{throw ServiceError.invalid("MathML节点数量超过保真上限。")}
                if child.kind == .text {element.replaceChild(at:child.index,with:XMLNode.text(withStringValue:child.stringValue ?? "") as! XMLNode)}else{child.detach()}
            }
        }
    }
    private static func articlePlainText(_ body:XMLElement)throws->String {
        let copy=body.copy() as! XMLElement
        let roots=try copy.nodes(forXPath:".//*[local-name()='math' and not(ancestor::*[local-name()='math'])]")
        for case let math as XMLElement in roots {
            let annotations=try math.nodes(forXPath:"./*[local-name()='semantics']/*[local-name()='annotation' and @encoding='application/x-tex']")
            guard annotations.count<=1 else{throw ServiceError.invalid("同一公式有多个TeX annotation，未猜测应采用哪个。")}
            let annotation=annotations.first?.stringValue
            let block=math.attribute(forName:"display")?.stringValue=="block"
            let text:String
            if let annotation,!annotation.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {
                text=block ? "\n\\["+annotation+"\\]\n":"\\("+annotation+"\\)"
            } else {
                // Annotation is not visible MathML content. Empty/missing TeX
                // does not authorize synthesizing a replacement formula.
                let visible=math.copy() as! XMLElement
                for node in try visible.nodes(forXPath:".//*[local-name()='annotation']"){node.detach()}
                let value=visible.stringValue ?? "";text=block ? "\n"+value+"\n":value
            }
            guard let parent=math.parent as? XMLElement else{throw ServiceError.invalid("公式文本投影失去原文位置。")}
            parent.replaceChild(at:math.index,with:XMLNode.text(withStringValue:text) as! XMLNode)
        }
        return copy.stringValue ?? ""
    }
    static func extractArticle(_ raw: String, paper: Paper, pageURL: URL) throws -> Article {
        let doc = try htmlDocumentPreservingMath(raw)
        // Foundation's HTML tidy removes HTML5 <article>/<section> wrappers on macOS;
        // the published body's exact id + class survive and must match uniquely.
        let nodes = try doc.nodes(forXPath: "//div[@id='article-body' and contains(concat(' ', normalize-space(@class), ' '), ' post-content ')]")
        guard nodes.count == 1, let body = nodes.first as? XMLElement else { throw ServiceError.invalid("网站正文结构已变化，未读取导航或用模型补写。请保留旧导读并更新适配器。") }
        var citation = paper.citation
        let citationNode = try doc.nodes(forXPath: "//script[@type='application/json' and contains(concat(' ', normalize-space(@class), ' '), ' paper-tools__citation-record ')]").first
        let attributeNode = try doc.nodes(forXPath: "//*[@data-citation-record]").first as? XMLElement
        if let rawCitation = (citationNode?.stringValue ?? attributeNode?.attribute(forName: "data-citation-record")?.stringValue)?.data(using: .utf8),
           let value = try? JSONDecoder().decode(JSONValue.self, from: rawCitation) {
            if case .object(let fields) = value, case .string(let key) = fields["paperKey"],
               paper.identityStatus == "verified", !key.isEmpty, key != paper.id {
                throw ServiceError.invalid("页面论文身份与目录不一致，未把其他论文的正文合并进来。")
            }
            if case .object(let fields) = value, paper.identityStatus == "verified", paper.sourceKind == "arxiv" {
                if case .string(let version) = fields["arxivId"], version.range(of: #"v[1-9][0-9]*$"#, options: .regularExpression) != nil, let expected = paper.sourceVersion, version != expected { throw ServiceError.invalid("页面原文版本与目录不同，未将旧稿标为当前版本。") }
                for (field, expected) in [("sourceUrl", paper.sourceURL), ("pdfUrl", paper.pdfURL)] {
                    if case .string(let address) = fields[field], !address.isEmpty, let expected, address != expected { throw ServiceError.invalid("页面来源地址与当前目录不一致，未授予当前版本身份。") }
                }
            }
            citation = value
        }
        try sanitize(body, pageURL: pageURL)
        let images = try body.nodes(forXPath: ".//img").compactMap { n -> Resource? in
            guard let element = n as? XMLElement, let source = element.attribute(forName: "src")?.stringValue else { return nil }
            return Resource(sourceURL: source, kind: "image", localPath: nil, sha256: nil, missingReason: nil)
        }
        guard images.count <= 32 else { throw ServiceError.invalid("单篇图片超过32张，未开始批量下载。") }
        let html = (body.children ?? []).map { $0.xmlString(options: [.nodePreserveWhitespace]) }.joined()
        return presentSourceWarning(Article(paperID: paper.id, html: html, markdown: nil, plainText: try articlePlainText(body), citation: citation,
                       resources: images, sourceURL: paper.sourceURL ?? paper.blogURL, pdfURL: paper.pdfURL, sourceVersion: paper.sourceVersion,
                       fetchedAt: now(), revisionSHA256: sha256(Data(html.utf8)), completeOffline: false,
                       notices: ["兼容读取现有网站正文；PDF页内定位仅在真实匹配后提供。"],mathMLContract:"published-html-mathml-v1"),blogURL:pageURL.absoluteString)
    }

    private static func sanitize(_ root: XMLElement, pageURL: URL) throws {
        let allowed: Set<String> = ["div", "p", "span", "a", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "img", "figure", "figcaption", "strong", "b", "em", "i", "u", "s", "sup", "sub", "br", "hr", "details", "summary", "dl", "dt", "dd", "math", "mrow", "mi", "mo", "mn", "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mtext", "mtable", "mtr", "mtd", "mover", "munder", "munderover", "semantics", "annotation"]
        let attributes: Set<String> = ["id", "class", "title", "alt", "width", "height", "colspan", "rowspan", "scope", "display", "mathvariant", "xmlns", "encoding"]
        for child in root.children ?? [] {
            guard let element = child as? XMLElement else { if child.kind != .text { child.detach() }; continue }
            let tag = (element.name ?? "").lowercased()
            guard allowed.contains(tag) else { element.detach(); continue }
            if tag=="math"{var count=0;try sanitizeMathML(element,depth:0,count:&count);continue}
            for attr in element.attributes ?? [] {
                let name = (attr.name ?? "").lowercased()
                if name == "href" && tag == "a" {
                    let raw = attr.stringValue ?? ""
                    if raw.hasPrefix("#") { continue }
                    if let url = URL(string: raw, relativeTo: pageURL)?.absoluteURL, url.scheme == "https", url.user == nil, url.password == nil {
                        attr.stringValue = url.absoluteString
                    } else { element.removeAttribute(forName: attr.name ?? "") }
                } else if name == "src" && tag == "img" {
                    if let url = URL(string: attr.stringValue ?? "", relativeTo: pageURL)?.absoluteURL, url.scheme == "https", url.user == nil, url.password == nil { attr.stringValue = url.absoluteString }
                    else { element.removeAttribute(forName: attr.name ?? "") }
                } else if !attributes.contains(name) { element.removeAttribute(forName: attr.name ?? "") }
            }
            if tag == "a" { element.addAttribute(XMLNode.attribute(withName: "rel", stringValue: "noopener noreferrer") as! XMLNode) }
            try sanitize(element, pageURL: pageURL)
        }
    }
    private static func localizeImages(_ fragment: String, replacements: [String: String]) throws -> String {
        let doc = try htmlDocumentPreservingMath("<html><body>\(fragment)</body></html>")
        for node in try doc.nodes(forXPath: "//img") {
            guard let image = node as? XMLElement, let source = image.attribute(forName: "src")?.stringValue else { continue }
            if let local = replacements[source] { image.attribute(forName: "src")?.stringValue = local }
            else { image.removeAttribute(forName: "src"); image.addAttribute(XMLNode.attribute(withName: "data-source-url", stringValue: source) as! XMLNode) }
        }
        return try doc.nodes(forXPath: "//body").first?.children?.map { $0.xmlString }.joined() ?? ""
    }

    func downloadPDF(for paperID: String, refresh: Bool = false, progress: @escaping @Sendable (Progress) -> Void = { _ in }) async throws -> PDFDownload {
        guard let paper = (snapshot.papers + (snapshot.retiredPapers ?? [])).first(where: { $0.id == paperID }), paper.identityStatus == "verified", let address = paper.pdfURL, let url = URL(string: address) else { throw ServiceError.unavailable("此记录没有经过核验的原文PDF链接。") }
        let sourceURL=paper.sourceURL.flatMap(URL.init(string:))
        let pdfVersion=(url.path.hasPrefix("/pdf/") ? String(url.path.dropFirst("/pdf/".count)):url.lastPathComponent).replacingOccurrences(of: #"\.pdf$"#, with: "", options: .regularExpression)
        let absVersion=sourceURL.map{$0.path.hasPrefix("/abs/") ? String($0.path.dropFirst("/abs/".count)):$0.lastPathComponent}
        let versionMatches = paper.sourceVersion?.range(of: #"v[1-9][0-9]*$"#, options: .regularExpression) != nil && paper.sourceVersion?.replacingOccurrences(of: #"v[1-9][0-9]*$"#, with: "", options: .regularExpression) == String(paperID.dropFirst("arxiv:".count)) && pdfVersion == paper.sourceVersion && absVersion == paper.sourceVersion
        let immutable = paper.sourceKind == "arxiv" && versionMatches && ["arxiv.org","export.arxiv.org"].contains(url.host?.lowercased() ?? "") && ["arxiv.org","export.arxiv.org"].contains(sourceURL?.host?.lowercased() ?? "")
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
                existing.isStale = false; existing.cacheStatus = "current"; existing.publicSHA256 = paper.pdfSHA256; existing.notices=nil
                existing.currentness = paper.pdfSHA256 != nil ? "published-sha256":immutable ? "immutable-arxiv-version":"bounded-revalidation"
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
            result.paperID=paperID;result.fetchedAt=Self.now();result.validatedAt=result.fetchedAt;result.catalogEpoch=snapshot.validationEpoch;result.cacheStatus="current";result.isStale=false;result.publicSHA256=paper.pdfSHA256;result.currentness="immutable-arxiv-version"
            try preservePDFReceipt(result, paperID: paperID)
            try atomicWrite(try JSONEncoder().encode(result), to: pointer)
            return result
        }
        let epoch=snapshot.validationEpoch
        do {
            progress(Progress(phase: "pdf", message: previous == nil ? "正在下载原始PDF并核对字节":"正在复核当前网站原文PDF，保留旧SHA副本", completed: 0, total: 0))
            let bytes = try await read(url, limit: 100 * 1024 * 1024)
            guard bytes.starts(with: Data("%PDF-".utf8)), let document = PDFDocument(data: bytes), document.pageCount > 0 else { throw ServiceError.invalid("原文链接未返回完整可读取PDF，没有缓存错误页面。") }
            let sha = Self.sha256(bytes), file = cacheURL("pdf", key: sha, extension: "pdf")
            guard paper.pdfSHA256 == nil || paper.pdfSHA256 == sha else { throw ServiceError.invalid("原文实际字节与已发布PDF SHA不符，未当作当前来源。") }
            try Task.checkCancellation()
            try atomicWrite(bytes, to: file)
            var result = PDFDownload(filePath: file.path, sha256: sha, version: paper.sourceVersion, sourceURL: address, bytes: bytes.count)
            result.paperID=paperID;result.fetchedAt=previous?.sha256 == sha ? previous?.fetchedAt ?? Self.now():Self.now();result.validatedAt=Self.now();result.validationAttemptedAt=result.validatedAt;result.catalogEpoch=epoch;result.cacheStatus=previous == nil ? "current":"revalidated";result.isStale=false;result.publicSHA256=paper.pdfSHA256
            result.currentness=paper.pdfSHA256 != nil ? "published-sha256":immutable ? "immutable-arxiv-version":"bounded-revalidation"
            let latest=(snapshot.papers + (snapshot.retiredPapers ?? [])).first{$0.id==paperID}
            let sourceChanged=latest?.pdfURL != paper.pdfURL || latest?.sourceURL != paper.sourceURL || latest?.sourceVersion != paper.sourceVersion || latest?.pdfSHA256 != paper.pdfSHA256
            if epoch != snapshot.validationEpoch && (!immutable || sourceChanged) { result.isStale=true;result.cacheStatus="stale";result.notices=["读取期间网站目录已更新；这份PDF保留原SHA与版本，请再次复核当前来源。"] }
            if let previous { try preservePDFReceipt(previous, paperID: paperID) }
            try preservePDFReceipt(result, paperID: paperID)
            try atomicWrite(try JSONEncoder().encode(result), to: pointer)
            progress(Progress(phase: "complete", message: "原文PDF已保存并校验实际字节", completed: bytes.count, total: bytes.count))
            return result
        } catch {
            if Task.isCancelled || error is CancellationError { throw CancellationError() }
            guard var old=previous else{throw error}
            try preservePDFReceipt(old,paperID:paperID)
            old.isStale=true;old.cacheStatus="stale";old.validationAttemptedAt=Self.now();old.catalogEpoch=epoch;old.publicSHA256=paper.pdfSHA256
            old.notices=Array(Set((old.notices ?? [])+["当前PDF复核失败，正在读取先前保存的旧SHA副本（\(old.sha256)，核对时间\(old.validatedAt ?? old.fetchedAt ?? "未知")），不代表网站当前原文。\(error.localizedDescription)"])).sorted()
            try atomicWrite(try JSONEncoder().encode(old),to:pointer)
            return old
        }
    }
    private func preservePDFReceipt(_ value:PDFDownload,paperID:String)throws {
        let file=directory.appendingPathComponent("pdf-receipts/"+Self.sha256(Data(paperID.utf8))).appendingPathComponent(value.sha256+".json")
        if !FileManager.default.fileExists(atPath:file.path) {try atomicWrite(try JSONEncoder().encode(value),to:file)}
    }
    private static func publishedPDFHash(_ row:[String:Any],citation:[String:Any])throws->String? {
        let values=[row["pdfSha256"],row["pdfSHA256"],citation["pdfSha256"],citation["pdfSHA256"]].compactMap{$0}.filter{!($0 is NSNull) && ($0 as? String) != ""}
        var hashes=Set<String>()
        for value in values {guard let text=value as? String,text.range(of:#"^[a-f0-9]{64}$"#,options:.regularExpression) != nil else{throw ServiceError.invalid("已发布PDF SHA字段无效。")};hashes.insert(text)}
        guard hashes.count<=1 else{throw ServiceError.invalid("已发布PDF SHA字段相互矛盾。")}
        return hashes.first
    }

    func configureNetwork(httpProxy: String?) throws {
        guard let value = httpProxy?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { self.httpProxy = nil; return }
        guard let url = URL(string: value), url.scheme == "http", url.host != nil, url.port != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else { throw ServiceError.invalid("代理请输入不含凭据的HTTP CONNECT地址，例如 http://127.0.0.1:7890。") }
        self.httpProxy = url
    }

    func citationFile(for paperID: String, format: String) async throws -> [String: Any] {
        let names = ["bib": "citation.bib", "ris": "citation.ris", "json": "citation.json"]
        guard let name = names[format], let paper = (snapshot.papers + (snapshot.retiredPapers ?? [])).first(where: { $0.id == paperID }) else { throw ServiceError.invalid("未选择可导出引用的论文或格式。") }
        var addresses: [String: String] = [:]
        let cache = cacheURL("articles", key: Self.sha256(Data(paper.blogURL.utf8)), extension: "json")
        if let data = try? Data(contentsOf: cache), let article = try? JSONDecoder().decode(Article.self, from: data), article.paperID == paperID { addresses = article.citationFiles ?? [:] }
        if addresses[name] == nil {
            // Discover the actual published download link; never synthesize BibTeX/RIS from metadata.
            let data = try await read(try sameSite(paper.blogURL), limit: 8 * 1024 * 1024)
            guard let html = String(data: data, encoding: .utf8) else { throw ServiceError.invalid("引用来源页面不是UTF-8。") }
            _ = try Self.extractArticle(html, paper: paper, pageURL: URL(string: paper.blogURL)!)
            let doc = try XMLDocument(xmlString: html, options: [.documentTidyHTML, .nodeLoadExternalEntitiesNever])
            let links = try doc.nodes(forXPath: "//a[@href]").compactMap { ($0 as? XMLElement)?.attribute(forName: "href")?.stringValue }
            for candidate in names.values {
                if let path = links.first(where: { $0.hasSuffix("/" + candidate) }), let url = try? sameSite(path) { addresses[candidate] = url.absoluteString }
            }
        }
        guard let address = addresses[name] else { throw ServiceError.unavailable("该已发布页面没有此格式的真实引用文件，未现场生成替代引用。") }
        let data = try await read(try sameSite(address), limit: 1024 * 1024)
        guard let text = String(data: data, encoding: .utf8), !text.isEmpty, !text.localizedCaseInsensitiveContains("<html") else { throw ServiceError.invalid("引用文件为空或返回了错误页面。") }
        if format == "bib" { guard text.range(of: #"(?m)^\s*@[A-Za-z]+\s*\{"#, options: .regularExpression) != nil else { throw ServiceError.invalid("已发布BibTeX文件格式无效。") } }
        if format == "ris" { guard text.hasPrefix("TY  - "), text.contains("ER  -") else { throw ServiceError.invalid("已发布RIS文件格式无效。") } }
        if format == "json" { _ = try Self.validatedSidecar(data, paper: paper, context: false) }
        return ["filename": name, "text": text, "sha256": Self.sha256(data), "sourceURL": address]
    }

    private static func validatedSidecar(_ data: Data, paper: Paper, context: Bool) throws -> JSONValue {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let contract = value["contract"] as? String,
              (context ? ["researcher-sidecars-v1", "paper-research-context-v2"].contains(contract) : contract == "researcher-sidecars-v1") else { throw ServiceError.invalid("引用附加文件合同不受支持。") }
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
        let notify: @Sendable (Progress) -> Void = { progress($0.json) }
        switch command {
        case "library.status": return try Self.dictionary(status())
        case "library.sync": return try Self.dictionary(try await sync(progress: notify))
        case "library.list":
            let query = payload["query"] as? String ?? "", source = payload["source"] as? String
            let score = payload["minimumScore"] as? Double
            let sort = Sort(rawValue: payload["sort"] as? String ?? "date") ?? .date
            let matches = list(query: query, source: source, minimumScore: score, sort: sort, limit: 10000)
            let papers = Array(matches.dropFirst(max(0, payload["offset"] as? Int ?? 0)).prefix(max(0, min(10000, payload["limit"] as? Int ?? 200))))
            let rows = try papers.map { p -> [String: Any] in
                var result = try Self.dictionary(p); result["paperID"] = p.id; result["blogURL"] = p.blogURL; result["pdfURL"] = p.pdfURL ?? NSNull(); return result
            }
            return ["papers": rows, "count": rows.count, "total": matches.count, "totalInLibrary": snapshot.papers.count, "offset": max(0, payload["offset"] as? Int ?? 0)]
        case "library.search": return ["ids": searchCachedText(payload["query"] as? String ?? ""), "scope": "仅本机已读取导读正文，不检索PDF原文"]
        case "library.citationFile":
            guard let id = payload["paperID"] as? String ?? payload["id"] as? String else { throw ServiceError.invalid("未选择论文。") }
            return try await citationFile(for: id, format: payload["format"] as? String ?? "json")
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

    private func sameSite(_ value: String) throws -> URL {
        guard !value.isEmpty, let url = URL(string: value, relativeTo: siteBaseURL)?.absoluteURL,
              url.scheme == "https", url.host?.lowercased() == siteBaseURL.host?.lowercased(), url.port == siteBaseURL.port,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.hasPrefix(siteBaseURL.path + "/"), !url.pathComponents.contains(".."), !url.path.contains("\\") else { throw ServiceError.invalid("资料地址超出可信站点目录。") }
        return url
    }
    private func cleanHTTPS(_ value: String?) -> String? {
        guard let value, let url = URL(string: value), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url.absoluteString
    }
    private func read(_ url: URL, limit: Int) async throws -> Data {
        try Task.checkCancellation()
        if let transport {
            let bytes = try await transport(url, limit)
            try Task.checkCancellation()
            guard bytes.count <= limit else { throw ServiceError.invalid("资料响应超过大小上限。") }
            return bytes
        }
        if url.host?.lowercased() == siteBaseURL.host?.lowercased(),!Self.isOwnedPublishedImage(url) {
            _ = try sameSite(url.absoluteString)
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let cancellation = LibraryTransferCancellation()
            return try await withTaskCancellationHandler(operation: {
                let (bytes, response) = try await session.bytes(for: request, delegate: LibraryRedirectBlocker())
                cancellation.install(bytes.task)
                defer { bytes.task.cancel() }
                try Task.checkCancellation()
                guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.url == url else { throw ServiceError.network("网站资料暂不可用，未覆盖已保存版本。") }
                guard response.expectedContentLength <= Int64(limit) else { throw ServiceError.invalid("资料响应超过大小上限。") }
                var data = Data()
                for try await byte in bytes {
                    guard data.count < limit else { throw ServiceError.invalid("资料响应超过大小上限。") }
                    data.append(byte)
                    if data.count % 8192 == 0 { try Task.checkCancellation() }
                }
                try Task.checkCancellation()
                return data
            }, onCancel: { cancellation.cancel() })
        }
        return try await externalBytes(url, limit: limit)
    }
    private func externalBytes(_ initial: URL, limit: Int) async throws -> Data {
        var url = initial
        for _ in 0..<6 {
            try Task.checkCancellation()
            guard Self.isApprovedExternalResource(url),let host=url.host?.lowercased() else { throw ServiceError.invalid("外部资源不在已支持的官方HTTPS来源中。") }
            let arxiv = host == "arxiv.org" || host == "export.arxiv.org"
            if arxiv && httpProxy == nil { throw ServiceError.unavailable("arXiv 原文与图片需要配置HTTP CONNECT代理；已有导读仍可阅读。") }
            let address = try Self.publicAddress(host)
            let temporary = directory.appendingPathComponent("transfer-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: temporary) }
            let output = temporary.appendingPathComponent("body"), headers = temporary.appendingPathComponent("headers"), status = temporary.appendingPathComponent("status"), diagnostic = temporary.appendingPathComponent("diagnostic")
            FileManager.default.createFile(atPath: status.path, contents: nil)
            FileManager.default.createFile(atPath: diagnostic.path, contents: nil)
            let stdout = try FileHandle(forWritingTo: status), stderr = try FileHandle(forWritingTo: diagnostic)
            defer { try? stdout.close(); try? stderr.close() }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
            let target = address.contains(":") ? "[\(address)]" : address
            process.arguments = ["-q", "--globoff", "--silent", "--show-error", "--max-time", "120", "--connect-timeout", "30", "--max-filesize", String(limit), "--proto", "=https", "--max-redirs", "0", "--connect-to", "\(host):443:\(target):443", "--proxy", Self.externalResourceProxy(url,configured:httpProxy)?.absoluteString ?? "", "--noproxy", "", "--dump-header", headers.path, "--output", output.path, "--write-out", "%{http_code}", "--url", url.absoluteString]
            process.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"]
            process.standardOutput = stdout; process.standardError = stderr
            let transferID = UUID()
            activeTransfers[transferID] = process
            defer { activeTransfers.removeValue(forKey: transferID) }
            try await Self.run(process)
            let code = Int((try String(contentsOf: status, encoding: .utf8)).trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
            if [301, 302, 303, 307, 308].contains(code) {
                let text = try String(contentsOf: headers, encoding: .utf8)
                let locations = text.components(separatedBy: .newlines).filter { $0.lowercased().hasPrefix("location:") }
                guard let value = locations.last?.dropFirst(9).trimmingCharacters(in: .whitespacesAndNewlines), let next = URL(string: value, relativeTo: url)?.absoluteURL else { throw ServiceError.network("资源重定向缺少有效地址。") }
                url = next; continue
            }
            guard code == 200 else { throw ServiceError.network("官方资源返回HTTP \(code)，没有缓存错误页面。") }
            let data = try Data(contentsOf: output)
            guard data.count <= limit else { throw ServiceError.invalid("资源超过大小上限。") }
            return data
        }
        throw ServiceError.network("官方资源重定向过多。")
    }
    private static func run(_ process: Process) async throws {
        try Task.checkCancellation()
        let cancellation = LibraryTransferCancellation()
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                process.terminationHandler = { finished in
                    if finished.terminationReason == .uncaughtSignal { continuation.resume(throwing: CancellationError()) }
                    else if finished.terminationStatus != 0 { continuation.resume(throwing: ServiceError.network("资源下载失败或超过限额；未保存不完整文件。")) }
                    else { continuation.resume() }
                }
                do { try cancellation.start(process) } catch { continuation.resume(throwing: error) }
            }
        }, onCancel: { cancellation.cancel() })
        try Task.checkCancellation()
    }
    private static func publicAddress(_ host: String) throws -> String {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM; hints.ai_flags = AI_ADDRCONFIG
        var list: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, "443", &hints, &list) == 0, let first = list else { throw ServiceError.network("官方资源DNS暂不可用。") }
        defer { freeaddrinfo(first) }
        var cursor: UnsafeMutablePointer<addrinfo>? = first
        var found: [String] = []
        while let node = cursor {
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(node.pointee.ai_addr, node.pointee.ai_addrlen, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: buffer)
                guard isPublicAddress(ip) else { throw ServiceError.invalid("官方资源解析到私网或保留地址，已停止下载。") }
                found.append(ip)
            }
            cursor = node.pointee.ai_next
        }
        guard let result = found.first(where: { !$0.contains(":") }) ?? found.first else { throw ServiceError.network("官方资源没有可用公网地址。") }
        return result
    }
    static func isPublicAddress(_ address: String) -> Bool {
        var ipv4 = in_addr()
        if inet_pton(AF_INET, address, &ipv4) == 1 {
            let n = UInt32(bigEndian: ipv4.s_addr), a = n >> 24, b = (n >> 16) & 255, c = (n >> 8) & 255
            return !(a == 0 || a == 10 || a == 127 || a >= 224 || (a == 100 && b >= 64 && b <= 127) || (a == 169 && b == 254) || (a == 172 && b >= 16 && b <= 31) || (a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99))) || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100))) || (a == 203 && b == 0 && c == 113))
        }
        var ipv6 = in6_addr()
        guard inet_pton(AF_INET6, address, &ipv6) == 1 else { return false }
        let bytes = withUnsafeBytes(of: &ipv6) { Array($0) }
        // Accept ordinary global-unicast IPv6 only; reject documentation, mapped IPv4 and special ranges.
        return bytes[0] & 0xe0 == 0x20 && !(bytes[0] == 0x20 && bytes[1] == 0x01 && (bytes[2] < 2 || (bytes[2] == 0x0d && bytes[3] == 0xb8))) && !(bytes[0] == 0x20 && bytes[1] == 0x02) && !(bytes[0] == 0x3f && bytes[1] == 0xff && bytes[2] < 16)
    }
    private static func imageExtension(_ data: Data, url: URL) throws -> String {
        if data.starts(with: [0x89, 0x50, 0x4e, 0x47]) { return "png" }
        if data.starts(with: [0xff, 0xd8, 0xff]) { return "jpg" }
        if data.starts(with: Data("GIF8".utf8)) { return "gif" }
        if data.count > 12, data.prefix(4) == Data("RIFF".utf8), data[8..<12] == Data("WEBP".utf8) { return "webp" }
        if let text = String(data: data, encoding: .utf8), text.contains("<svg"),
           !text.localizedCaseInsensitiveContains("<!ENTITY"), !text.localizedCaseInsensitiveContains("<script"),
           !text.localizedCaseInsensitiveContains("foreignObject"), !text.localizedCaseInsensitiveContains("javascript:"),
           text.range(of: #"\bon[a-z]+\s*=|(?:href|src)\s*=\s*[\"'](?!#)|url\(\s*(?!#)"#, options: [.regularExpression, .caseInsensitive]) == nil { return "svg" }
        throw ServiceError.invalid("图片内容不受支持或包含外部执行/引用。")
    }
    private static func imageMIME(_ ext: String) -> String {
        ["png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml"][ext] ?? "application/octet-stream"
    }
    private func cacheURL(_ name: String, key: String, extension ext: String) -> URL {
        directory.appendingPathComponent(name, isDirectory: true).appendingPathComponent("\(key).\(ext)")
    }
    private func atomicWrite(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try data.write(to: url, options: [.atomic])
    }
    private static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func now() -> String { ISO8601DateFormatter().string(from: Date()) }
    private static func dictionary<T: Encodable>(_ value: T) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any] ?? [:]
    }
}

private final class LibraryRedirectBlocker: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Per-operation cancellation: cancelling one task cannot terminate another transfer.
private final class LibraryTransferCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var task: URLSessionTask?
    private var process: Process?
    func install(_ value: URLSessionTask) {
        lock.lock(); defer { lock.unlock() }
        task = value
        if cancelled { value.cancel() }
    }
    func start(_ value: Process) throws {
        lock.lock(); defer { lock.unlock() }
        guard !cancelled else { throw CancellationError() }
        process = value
        try value.run()
    }
    func cancel() {
        lock.lock(); defer { lock.unlock() }
        cancelled = true; task?.cancel()
        if let process, process.isRunning { process.terminate() }
    }
}
