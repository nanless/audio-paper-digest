import Foundation
import CoreFoundation

extension LibraryService {
    static let maxResourceBadgesBytes = 8 * 1024 * 1024

    private static let conferenceVenueDisplayNames: [String: String] = [
        "interspeech": "INTERSPEECH",
        "icassp": "ICASSP",
        "iclr": "ICLR",
        "icml": "ICML",
        "neurips": "NeurIPS",
        "acl": "ACL",
        "emnlp": "EMNLP",
        "naacl": "NAACL",
        "eacl": "EACL",
        "cvpr": "CVPR",
        "aaai": "AAAI",
        "dafx": "DAFx",
        "eusipco": "EUSIPCO",
        "speechprosody": "SpeechProsody",
        "nime": "NIME",
        "odyssey": "Odyssey",
        "icmc": "ICMC",
        "jep": "JEP",
        "iwslt": "IWSLT",
        "chime": "CHiME",
        "uai": "UAI",
        "aistats": "AISTATS",
        "waspaa": "WASPAA",
        "asru": "ASRU",
        "slt": "SLT",
        "ismir": "ISMIR"
    ]

    /// Offline deterministic parser for `conference:<venue>:<year>...` paper IDs.
    static func parseConferenceVenue(_ paperID: String) -> (key: String, label: String)? {
        guard paperID.hasPrefix("conference:") else { return nil }
        let parts = paperID.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3 else { return nil }
        let rawVenue = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let rawYear = String(parts[2]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawVenue.isEmpty,
              rawVenue.range(of: #"\A[a-z0-9][a-z0-9._-]{0,63}\z"#, options: .regularExpression) != nil,
              rawYear.range(of: #"\A(19|20)\d{2}\z"#, options: .regularExpression) != nil else {
            return nil
        }
        let display = conferenceVenueDisplayNames[rawVenue] ?? rawVenue.uppercased()
        return (key: "conference:\(rawVenue):\(rawYear)", label: "\(display) \(rawYear)")
    }

    static func normalizedSearchText(_ value: String) -> String {
        value.precomposedStringWithCompatibilityMapping
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
    }

    static let maxSearchTokens = 32

    static func searchTokens(_ query: String) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for piece in normalizedSearchText(query).split(whereSeparator: { $0.isWhitespace }) {
            let token = String(piece)
            if token.isEmpty || !seen.insert(token).inserted { continue }
            result.append(token)
            if result.count >= maxSearchTokens { break }
        }
        return result
    }

    static func containsSearchToken(_ haystack: String, _ token: String) -> Bool {
        guard !token.isEmpty else { return true }
        let isShortNumber = token.count <= 2 && token.allSatisfy { $0.isASCII && $0.isNumber }
        if !isShortNumber {
            return haystack.contains(token)
        }
        var searchStart = haystack.startIndex
        while searchStart < haystack.endIndex,
              let range = haystack.range(of: token, range: searchStart..<haystack.endIndex) {
            let beforeOK = range.lowerBound == haystack.startIndex || !haystack[haystack.index(before: range.lowerBound)].isNumber
            let afterOK = range.upperBound == haystack.endIndex || !haystack[range.upperBound].isNumber
            if beforeOK && afterOK { return true }
            searchStart = range.upperBound
        }
        return false
    }

    static func paperConceptIDs(_ paper: Paper) -> Set<String> {
        var ids = Set<String>()
        for record in paper.websiteTagRecords ?? [] {
            guard case .object(let obj) = record else { continue }
            for key in ["tagConcepts", "taxonomyConcepts"] {
                guard case .array(let arr)? = obj[key] else { continue }
                for item in arr {
                    if case .object(let node) = item, case .string(let id)? = node["id"] {
                        ids.insert(id)
                    }
                }
            }
            if case .array(let arr)? = obj["tagConceptIds"] {
                for item in arr {
                    if case .string(let id) = item { ids.insert(id) }
                }
            }
        }
        return ids
    }

    static func tier1ResourceSignals(for paper: Paper, cachedDemoIDs: Set<String> = []) -> (hasCode: Bool, hasModel: Bool, hasDataset: Bool, hasDemo: Bool) {
        let conceptIDs = paperConceptIDs(paper)
        let hasCode = conceptIDs.contains { $0 == "artifact.open-source-tool" || $0 == "artifact.software" || $0.hasPrefix("artifact.open-source-tool.") || $0.hasPrefix("artifact.software.") }
        let hasModel = conceptIDs.contains { $0 == "artifact.model-weights" || $0.hasPrefix("artifact.model-weights.") }
        let hasDataset = conceptIDs.contains { $0 == "artifact.dataset" || $0 == "artifact.benchmark" || $0.hasPrefix("artifact.dataset.") || $0.hasPrefix("artifact.benchmark.") }
        let hasDemo = cachedDemoIDs.contains(paper.id)
        return (hasCode, hasModel, hasDataset, hasDemo)
    }

    static func matchesResourceFilter(
        _ paper: Paper,
        filter: String?,
        resourceBadges: [String: [String: Any]] = [:],
        cachedDemoIDs: Set<String> = []
    ) -> Bool {
        guard let filter, !filter.isEmpty, filter != "all" else { return true }
        let t1 = tier1ResourceSignals(for: paper, cachedDemoIDs: cachedDemoIDs)
        let t2 = resourceBadges[paper.id]
        let hasCode = t1.hasCode || (t2?["hasCode"] as? Bool == true)
        let hasModel = t1.hasModel || (t2?["hasModel"] as? Bool == true)
        let hasDataset = t1.hasDataset || (t2?["hasDataset"] as? Bool == true)
        let hasDemo = t1.hasDemo || (t2?["hasDemo"] as? Bool == true)
        let hasProject = t2?["hasProjectPage"] as? Bool == true
        switch filter {
        case "open-source", "any": return hasCode || hasModel || hasDataset || hasDemo || hasProject
        case "code": return hasCode
        case "model": return hasModel
        case "dataset": return hasDataset
        case "demo": return hasDemo
        case "project": return hasProject
        default: return true
        }
    }

    static func paperRelevanceScore(_ paper: Paper, query: String, tokens: [String]) -> Int {
        guard !tokens.isEmpty else { return 0 }
        let phrase = normalizedSearchText(query).trimmingCharacters(in: .whitespacesAndNewlines)
        let titleNorm = normalizedSearchText(paper.title + " " + paper.titleZh)
        let idNorm = normalizedSearchText(paper.id + " " + (paper.sourceVersion ?? "") + " " + (parseConferenceVenue(paper.id)?.label ?? ""))
        let authorsNorm = normalizedSearchText(paper.authors.joined(separator: " "))
        let tagsNorm = normalizedSearchText(([paper.task, paper.method] + paper.tags).joined(separator: " "))
        var score = 0
        if !phrase.isEmpty {
            if titleNorm.contains(phrase) { score += 100 }
            if idNorm.contains(phrase) { score += 80 }
        }
        for token in tokens {
            if titleNorm.contains(token) { score += 40 }
            if idNorm.contains(token) { score += 35 }
            if tagsNorm.contains(token) { score += 20 }
            if authorsNorm.contains(token) { score += 18 }
        }
        return score
    }

    func matchingPapers(
        query: String,
        source: String?,
        minimumScore: Double?,
        sort: Sort,
        includeRetained: Bool = false,
        conferenceVenue: String? = nil,
        scoredOnly: Bool = false,
        resourceFilter: String? = nil,
        resourceBadges: [String: [String: Any]] = [:],
        cachedDemoIDs: Set<String> = []
    ) -> [Paper] {
        let tokens = Self.searchTokens(query)
        var catalog = snapshot.papers
        if includeRetained {
            let current = Set(catalog.map(\.id))
            catalog.append(contentsOf: (snapshot.retiredPapers ?? []).filter { !current.contains($0.id) })
        }
        let filtered = catalog.filter { p in
            guard source == nil || source == "all" || source == "" || p.sourceKind == source else { return false }
            if scoredOnly && p.score == nil { return false }
            if let minimumScore, (p.score ?? -.infinity) < minimumScore { return false }
            if let venue = conferenceVenue, !venue.isEmpty, venue != "all" {
                guard Self.parseConferenceVenue(p.id)?.key == venue else { return false }
            }
            guard Self.matchesResourceFilter(p, filter: resourceFilter, resourceBadges: resourceBadges, cachedDemoIDs: cachedDemoIDs) else {
                return false
            }
            if tokens.isEmpty { return true }
            let venueLabel = Self.parseConferenceVenue(p.id)?.label ?? ""
            let haystack = Self.normalizedSearchText(([p.id, p.sourceVersion ?? "", venueLabel, p.title, p.titleZh, p.task, p.method] + p.authors + p.tags).joined(separator: " "))
            return tokens.allSatisfy { Self.containsSearchToken(haystack, $0) }
        }
        let relevanceMap: [String: Int] = (sort == .relevance && !tokens.isEmpty)
            ? Dictionary(uniqueKeysWithValues: filtered.map { ($0.id, Self.paperRelevanceScore($0, query: query, tokens: tokens)) })
            : [:]
        return filtered.sorted { a, b in
            switch sort {
            case .relevance:
                let ra = relevanceMap[a.id] ?? 0, rb = relevanceMap[b.id] ?? 0
                if ra != rb { return ra > rb }
                if a.score != b.score { return (a.score ?? -.infinity) > (b.score ?? -.infinity) }
                if a.date != b.date { return a.date > b.date }
            case .score: if a.score != b.score { return (a.score ?? -.infinity) > (b.score ?? -.infinity) }
            case .title: if a.title != b.title { return a.title.localizedStandardCompare(b.title) == .orderedAscending }
            case .date: if a.date != b.date { return a.date > b.date }
            }
            return a.id < b.id
        }
    }

    private static let allowedBadgeRootKeys: Set<String> = [
        "contract", "schemaFingerprint", "generatedAt", "papers"
    ]
    private static let allowedBadgeEntryKeys: Set<String> = [
        "hasCode", "hasModel", "hasDataset", "hasDemo", "hasProjectPage",
        "codeUrls", "demoUrls", "projectUrls"
    ]
    private static let dangerousBadgeKeys: Set<String> = [
        "__proto__", "constructor", "prototype"
    ]

    static func parseResourceBadgesIndex(_ data: Data) throws -> [String: [String: Any]] {
        guard data.count <= maxResourceBadgesBytes else {
            throw ServiceError.invalid("开源与资源信号索引超过 8 MiB 上限。")
        }
        guard String(data: data, encoding: .utf8) != nil,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ServiceError.invalid("开源与资源信号索引不是有效 UTF-8 JSON 对象。")
        }
        guard ClientProtocols.isCurrentHeader(obj, "paper-resource-badges-index") else {
            throw ServiceError.invalid("开源与资源信号索引协议头或 schemaFingerprint 无效。")
        }
        guard Set(obj.keys).isSubset(of: allowedBadgeRootKeys) else {
            throw ServiceError.invalid("开源与资源信号索引包含未声明顶层字段。")
        }
        guard let generatedAt = obj["generatedAt"] as? String, !generatedAt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let rawPapers = obj["papers"] as? [String: Any] else {
            throw ServiceError.invalid("开源与资源信号索引缺少有效 papers 映射。")
        }
        var sanitized: [String: [String: Any]] = [:]
        sanitized.reserveCapacity(rawPapers.count)
        for (paperId, rawEntry) in rawPapers {
            guard !paperId.isEmpty,
                  !dangerousBadgeKeys.contains(paperId),
                  let entry = rawEntry as? [String: Any],
                  Set(entry.keys).isSubset(of: allowedBadgeEntryKeys) else {
                throw ServiceError.invalid("开源与资源信号条目格式无效或包含危险/未声明字段：\(paperId)")
            }
            func boolField(_ key: String) throws -> Bool {
                guard let val = entry[key], !(val is NSNull) else { return false }
                guard let num = val as? NSNumber, CFGetTypeID(num) == CFBooleanGetTypeID() else {
                    throw ServiceError.invalid("开源与资源信号布尔字段无效：\(paperId).\(key)")
                }
                return num.boolValue
            }
            func httpsList(_ key: String) throws -> [String] {
                guard let raw = entry[key], !(raw is NSNull) else { return [] }
                guard let list = raw as? [Any] else {
                    throw ServiceError.invalid("开源与资源信号链接列表无效：\(paperId).\(key)")
                }
                var out: [String] = []
                for rawItem in list {
                    guard let item = rawItem as? String,
                          let u = URL(string: item), u.scheme == "https", u.host != nil, u.user == nil, u.password == nil else {
                        throw ServiceError.invalid("开源与资源信号链接必须为不含凭据的 HTTPS：\(paperId).\(key)")
                    }
                    out.append(u.absoluteString)
                }
                return out
            }
            sanitized[paperId] = [
                "hasCode": try boolField("hasCode"),
                "hasModel": try boolField("hasModel"),
                "hasDataset": try boolField("hasDataset"),
                "hasDemo": try boolField("hasDemo"),
                "hasProjectPage": try boolField("hasProjectPage"),
                "codeUrls": try httpsList("codeUrls"),
                "demoUrls": try httpsList("demoUrls"),
                "projectUrls": try httpsList("projectUrls")
            ]
        }
        return sanitized
    }

    func scanCachedAudioDemoPaperIDs(forceRescan: Bool = false) -> [String] {
        if !forceRescan, let memoized = cachedDemoPaperIDs {
            return memoized
        }
        var hits = Set<String>()
        let articlesDir = directory.appendingPathComponent("articles", isDirectory: true)
        if let files = try? FileManager.default.contentsOfDirectory(at: articlesDir, includingPropertiesForKeys: nil) {
            for file in files where file.pathExtension == "json" {
                guard let data = try? Data(contentsOf: file), data.count <= 32 * 1024 * 1024,
                      let raw = String(data: data, encoding: .utf8),
                      raw.contains("audio-demo-cta-btn"),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let paperID = obj["paperID"] as? String, !paperID.isEmpty else { continue }
                hits.insert(paperID)
            }
        }
        if let state = activeDesktopDetails() {
            for (paperID, entry) in state.paperDetails where !hits.contains(paperID) {
                guard Self.isValidSHA256(entry.primaryDetail.sha256) else { continue }
                let detailRel = "desktop-details/papers/\(entry.primaryDetail.sha256).json"
                guard let detailHit = try? Self.verifiedOptionalLocalFile(
                    relative: detailRel,
                    directory: directory,
                    expectedBytes: entry.primaryDetail.bytes,
                    maxBytes: Self.maxDesktopDetailBytes,
                    expectedSHA256: entry.primaryDetail.sha256
                ),
                      let detailObj = try? JSONSerialization.jsonObject(with: detailHit.bytes) as? [String: Any],
                      let revObj = detailObj["articleRevision"] as? [String: Any],
                      let descObj = revObj["articleDescriptor"] as? [String: Any],
                      let articleSHA = descObj["sha256"] as? String,
                      Self.isValidSHA256(articleSHA) else { continue }
                let rel = "desktop-details/articles/\(articleSHA).html"
                let expectedArticleBytes: Int? = (descObj["bytes"] as? NSNumber).flatMap {
                    CFGetTypeID($0) != CFBooleanGetTypeID() ? $0.intValue : nil
                }
                if let hit = try? Self.verifiedOptionalLocalFile(
                    relative: rel,
                    directory: directory,
                    expectedBytes: expectedArticleBytes,
                    maxBytes: Self.maxDesktopArticleBytes,
                    expectedSHA256: articleSHA
                ),
                   let html = String(data: hit.bytes, encoding: .utf8),
                   html.contains("audio-demo-cta-btn") {
                    hits.insert(paperID)
                }
            }
        }
        let sorted = hits.sorted()
        cachedDemoPaperIDs = sorted
        return sorted
    }

    func resourceBadgesResponse(forceRefresh: Bool = false) async throws -> [String: Any] {
        let cachedDemoIds = scanCachedAudioDemoPaperIDs(forceRescan: forceRefresh)
        if !forceRefresh && resourceBadgesLoaded {
            return [
                "available": cachedResourceBadges != nil,
                "papers": cachedResourceBadges ?? [:],
                "cachedDemoIds": cachedDemoIds
            ]
        }
        let url = try sameSite("client/signals/resource-badges.json")
        let bytes: Data
        do {
            bytes = try await read(url, limit: Self.maxResourceBadgesBytes)
        } catch is CancellationError {
            throw CancellationError()
        } catch ServiceError.httpStatus(404), ServiceError.httpStatus(410) {
            // Optional Tier 2 endpoint: HTTP 404/410 is silent-graceful.
            cachedResourceBadges = nil
            resourceBadgesLoaded = true
            return [
                "available": false,
                "papers": [:],
                "cachedDemoIds": cachedDemoIds
            ]
        } catch ServiceError.invalid(let message) {
            // HTTP 200 payload exceeding the size limit still fails closed.
            throw ServiceError.invalid(message)
        } catch ServiceError.responseTooLarge(let message) {
            throw ServiceError.responseTooLarge(message)
        } catch {
            // Optional Tier 2 network / transient HTTP error: do not mark loaded,
            // preserve prior cachedSignals, and still return Tier 1 local cachedDemoIds.
            return [
                "available": cachedResourceBadges != nil,
                "papers": cachedResourceBadges ?? [:],
                "cachedDemoIds": cachedDemoIds
            ]
        }
        let parsed = try Self.parseResourceBadgesIndex(bytes)
        cachedResourceBadges = parsed
        resourceBadgesLoaded = true
        return [
            "available": true,
            "papers": parsed,
            "cachedDemoIds": cachedDemoIds
        ]
    }

    /// Synchronous current-source read. Command entry points await `ensureReady()` first; the only
    /// in-app synchronous callers are reached from an already gated aggregate command.
    func list(query: String = "", source: String? = nil, minimumScore: Double? = nil, sort: Sort = .date, offset: Int = 0, limit: Int = 200) -> [Paper] {
        Array(matchingPapers(query: query, source: source, minimumScore: minimumScore, sort: sort).dropFirst(max(0, offset)).prefix(max(0, min(limit, 10000))))
    }

    func listResponse(payload: [String: Any]) -> [String: Any] {
        let query = payload["query"] as? String ?? "", source = payload["source"] as? String
        let score = payload["minimumScore"] as? Double
        let sort = Sort(rawValue: payload["sort"] as? String ?? "date") ?? .date
        let venue = payload["venue"] as? String
        let scoredOnly = payload["scoredOnly"] as? Bool ?? false
        let resourceFilter = payload["resource"] as? String
        let demoIDs: Set<String> = (resourceFilter != nil && !resourceFilter!.isEmpty) ? Set(scanCachedAudioDemoPaperIDs()) : []
        let matches = matchingPapers(
            query: query,
            source: source,
            minimumScore: score,
            sort: sort,
            includeRetained: true,
            conferenceVenue: venue,
            scoredOnly: scoredOnly,
            resourceFilter: resourceFilter,
            resourceBadges: cachedResourceBadges ?? [:],
            cachedDemoIDs: demoIDs
        )
        let currentIDs = Set(snapshot.papers.map(\.id))
        let papers = Array(matches.dropFirst(max(0, payload["offset"] as? Int ?? 0)).prefix(max(0, min(10000, payload["limit"] as? Int ?? 200))))
        // `compact` is the browsing projection: neither the per-guide records nor the full
        // citation repeat in every list refresh. `library.tagIndex` and `library.paperDetail`
        // return them when the app needs them; the default keeps the published row contract.
        let compact = payload["compact"] as? Bool ?? false
        let rows = papers.map { Self.listRow($0, retained: !currentIDs.contains($0.id), compact: compact) }
        var response: [String: Any] = [
            "papers": rows, "count": rows.count, "total": matches.count,
            "totalInLibrary": snapshot.papers.count, "snapshotID": snapshot.summary.snapshotID,
            "retainedCount": (snapshot.retiredPapers ?? []).count, "offset": max(0, payload["offset"] as? Int ?? 0)
        ]
        if (payload["offset"] as? Int ?? 0) == 0 {
            response["websiteTaxonomyNotice"] = snapshot.websiteTaxonomyNotice ?? (snapshot.websiteTaxonomy == nil ? "旧版目录缓存尚未保存网页分类；同步网站目录后可显示。" : "")
            if compact {
                // The display assets travel with the guide evidence. Only their identity is
                // repeated here so a cached copy is reused solely while they are unchanged.
                response["websiteTaxonomyIdentity"] = Self.taxonomyIdentity(snapshot.websiteTaxonomy)
            } else if let assets = snapshot.websiteTaxonomy {
                response["websiteTaxonomy"] = Self.jsonObject(assets)
            } else {
                response["websiteTaxonomy"] = NSNull()
            }
        }
        return response
    }

    /// One paper exactly as the published row states it: full citation and every published guide
    /// record. The browsing list omits them, so a detail view asks by identity instead.
    func paperDetail(id: String) throws -> [String: Any] {
        let currentIDs = Set(snapshot.papers.map(\.id))
        guard let paper = snapshot.papers.first(where: { $0.id == id }) ?? (snapshot.retiredPapers ?? []).first(where: { $0.id == id }) else {
            throw ServiceError.invalid("资料库中没有这篇论文。")
        }
        var response: [String: Any] = ["paper": Self.listRow(paper, retained: !currentIDs.contains(paper.id), compact: false), "snapshotID": snapshot.summary.snapshotID]
        if let state = activeDesktopDetails() {
            let appearanceURLs = Set(paper.appearances + [paper.blogURL])
            let matchingTombstones = state.activeTombstones.filter { tomb in
                if tomb.paperId == paper.id { return true }
                if let url = try? sameSite(tomb.appearanceId).absoluteString, appearanceURLs.contains(url) { return true }
                return false
            }
            if !matchingTombstones.isEmpty,
               let tombArray = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(matchingTombstones))) as? [[String: Any]] {
                response["tombstones"] = tombArray
            }
            if let entry = state.paperDetails[id],
               let hit = try Self.verifiedOptionalLocalFile(
                   relative: "desktop-details/papers/\(entry.primaryDetail.sha256).json",
                   directory: directory,
                   expectedBytes: entry.primaryDetail.bytes,
                   maxBytes: entry.primaryDetail.bytes,
                   expectedSHA256: entry.primaryDetail.sha256
               ) {
                response["desktopDetail"] = try Self.parseUTF8JSONObject(hit.bytes, label: entry.primaryDetail.url)
            }
        }
        return response
    }

    /// Per-guide browsing evidence for every paper the list can show. The app asks once per
    /// snapshot and keeps the answer, so a personal-only refresh never resends it.
    func tagIndex() -> [String: Any] {
        var papersByID: [String: Paper] = [:]
        for paper in snapshot.papers { papersByID[paper.id] = paper }
        for paper in snapshot.retiredPapers ?? [] where papersByID[paper.id] == nil { papersByID[paper.id] = paper }
        var records: [String: [Any]] = [:]
        for (id, paper) in papersByID {
            guard let values = paper.websiteTagRecords, !values.isEmpty else { continue }
            records[id] = values.map { Self.compactTagRecord($0, paper: paper) }
        }
        var result: [String: Any] = [
            "papers": records, "count": records.count, "snapshotID": snapshot.summary.snapshotID,
            "websiteTaxonomyIdentity": Self.taxonomyIdentity(snapshot.websiteTaxonomy)
        ]
        result["websiteTaxonomy"] = snapshot.websiteTaxonomy.map { Self.jsonObject($0) } ?? NSNull()
        return result
    }

    /// Identity of the published display assets, so the app reuses a cached copy only while the
    /// published taxonomy itself is unchanged.
    static func taxonomyIdentity(_ assets: JSONValue?) -> Any {
        guard case .object(let fields)? = assets else { return NSNull() }
        var identity: [String: Any] = [:]
        for key in ["snapshotContentSHA256", "versionsContentSHA256"] {
            if case .string(let value)? = fields[key] { identity[key] = value }
        }
        return identity.isEmpty ? NSNull() : identity
    }

    static func websiteTagRecord(_ row: [String: Any]) -> [String: Any] {
        let keys: Set<String> = ["pageType", "permalink", "paperId", "arxivId", "identityStatus", "sourceKind", "title", "titleZh", "originalTitle", "summary", "date", "score", "citation", "task", "method", "tags", "categories", "primaryTaskId", "primaryMethodId", "researchType", "domainScope", "primaryResearchRole", "primaryScientificTopicId", "primaryScientificTopicLabel", "methodNotApplicable", "methodNotApplicableReason"]
        return row.filter { keys.contains($0.key) || $0.key.hasPrefix("tag") || $0.key.hasPrefix("taxonomy") }
    }

    /// Hugo publishes the structured score as a decimal string; older indexes may use a JSON number.
    /// Only this declared field is read. Body prose, dimension totals and citation numbers are not scores.
    static func publishedScore(_ value: Any?) -> Double? {
        let score: Double?
        if let number = value as? NSNumber {
            guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
            score = number.doubleValue
        } else if let text = value as? String {
            score = Double(text.trimmingCharacters(in: .whitespacesAndNewlines))
        } else {
            return nil
        }
        guard let score, score.isFinite, (0...10).contains(score) else { return nil }
        return score
    }

    static func publishedPDFHash(_ row: [String: Any], citation: [String: Any]) throws -> String? {
        let values = [row["pdfSha256"], row["pdfSHA256"], citation["pdfSha256"], citation["pdfSHA256"]].compactMap { $0 }.filter { !($0 is NSNull) && ($0 as? String) != "" }
        var hashes = Set<String>()
        for value in values {
            guard let text = value as? String, text.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil else { throw ServiceError.invalid("已发布PDF SHA字段无效。") }
            hashes.insert(text)
        }
        guard hashes.count <= 1 else { throw ServiceError.invalid("已发布PDF SHA字段相互矛盾。") }
        return hashes.first
    }

    /// For one small response value. List rows are built as dictionaries below so a page of papers
    /// is never encoded and decoded again per row.
    static func dictionary<T: Encodable>(_ value: T) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any] ?? [:]
    }

    /// The browsing row. `compact` leaves out the full citation and the published guide records;
    /// both stay available through `library.paperDetail` and `library.tagIndex`.
    static func listRow(_ paper: Paper, retained: Bool, compact: Bool) -> [String: Any] {
        var row: [String: Any] = [
            "id": paper.id, "paperID": paper.id, "title": paper.title, "titleZh": paper.titleZh,
            "authors": paper.authors, "date": paper.date, "task": paper.task, "method": paper.method,
            "tags": paper.tags, "sourceKind": paper.sourceKind, "identityStatus": paper.identityStatus,
            "pageType": paper.pageType, "blogURL": paper.blogURL, "appearances": paper.appearances,
            "pdfURL": paper.pdfURL ?? NSNull(), "localRetained": retained
        ]
        if let score = paper.score { row["score"] = score }
        if let sourceURL = paper.sourceURL { row["sourceURL"] = sourceURL }
        if let sourceVersion = paper.sourceVersion { row["sourceVersion"] = sourceVersion }
        if let pdfSHA256 = paper.pdfSHA256 { row["pdfSHA256"] = pdfSHA256 }
        if !compact {
            row["citation"] = Self.jsonObject(paper.citation)
            if let records = paper.websiteTagRecords { row["websiteTagRecords"] = records.map { Self.jsonObject($0) } }
        }
        return row
    }

    /// Guide values the list row already carries verbatim. The web layer restores them from the
    /// row, so a title, task or tag list is not repeated for every published guide.
    private static func inheritedTagValue(_ key: String, paper: Paper) -> Any? {
        switch key {
        case "pageType": return paper.pageType
        case "sourceKind": return paper.sourceKind
        case "identityStatus": return paper.identityStatus
        case "title": return paper.title
        case "titleZh": return paper.titleZh
        case "task": return paper.task
        case "method": return paper.method
        case "tags": return paper.tags
        case "arxivId":
            guard let version = paper.sourceVersion else { return nil }
            return version
        case "paperId": return paper.id
        default: return nil
        }
    }

    /// One published guide record without the values its row repeats. The `citation` object keeps
    /// only the author names the browsing index searches; `library.paperDetail` returns the whole
    /// published record. `inherit` names every field the web layer takes back from the row.
    static func compactTagRecord(_ record: JSONValue, paper: Paper) -> Any {
        guard case .object(let fields) = record else { return Self.jsonObject(record) }
        var compact: [String: Any] = [:]
        var inherited: [String] = []
        for (key, value) in fields {
            if key == "citation" {
                var authors: [Any] = []
                if case .object(let citation) = value, case .array(let names)? = citation["authors"] { authors = names.map { Self.jsonObject($0) } }
                compact["citation"] = ["authors": authors]
                continue
            }
            if let rowValue = Self.inheritedTagValue(key, paper: paper), Self.sameJSON(value, rowValue) {
                inherited.append(key)
                continue
            }
            compact[key] = Self.jsonObject(value)
        }
        if !inherited.isEmpty { compact["inherit"] = inherited.sorted() }
        return compact
    }

    /// A decoded JSON value as the bridge expects it, without a JSON round trip.
    static func jsonObject(_ value: JSONValue) -> Any {
        switch value {
        case .object(let fields): return fields.mapValues { Self.jsonObject($0) }
        case .array(let values): return values.map { Self.jsonObject($0) }
        case .string(let text): return text
        case .number(let number): return number
        case .bool(let flag): return flag
        case .null: return NSNull()
        }
    }

    /// Only the inherited value shapes matter here: strings and string lists.
    private static func sameJSON(_ value: JSONValue, _ other: Any) -> Bool {
        switch value {
        case .string(let text): return (other as? String) == text
        case .array(let values):
            guard let other = other as? [String], values.count == other.count else { return false }
            return zip(values, other).allSatisfy { inner, text in
                if case .string(let value) = inner { return value == text }
                return false
            }
        default: return false
        }
    }
}
