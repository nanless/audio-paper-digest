import Foundation
import CoreFoundation

extension LibraryService {
    func matchingPapers(query: String, source: String?, minimumScore: Double?, sort: Sort, includeRetained: Bool = false) -> [Paper] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        var catalog = snapshot.papers
        if includeRetained {
            let current = Set(catalog.map(\.id))
            catalog.append(contentsOf: (snapshot.retiredPapers ?? []).filter { !current.contains($0.id) })
        }
        let filtered = catalog.filter { p in
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
        return filtered
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
        let matches = matchingPapers(query: query, source: source, minimumScore: score, sort: sort, includeRetained: true)
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
        return ["paper": Self.listRow(paper, retained: !currentIDs.contains(paper.id), compact: false), "snapshotID": snapshot.summary.snapshotID]
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
