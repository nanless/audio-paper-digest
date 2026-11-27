import Foundation
import CryptoKit

private actor FiltersFixtureTransport {
    var files: [String: Data] = [:]
    var statuses: [String: Int] = [:]
    var networkErrors: Set<String> = []
    var requests: [String] = []

    func set(_ path: String, data: Data) {
        files[path] = data
        statuses.removeValue(forKey: path)
        networkErrors.remove(path)
    }

    func setStatus(_ path: String, status: Int) {
        statuses[path] = status
        files.removeValue(forKey: path)
        networkErrors.remove(path)
    }

    func setNetworkError(_ path: String) {
        networkErrors.insert(path)
        statuses.removeValue(forKey: path)
        files.removeValue(forKey: path)
    }

    func requestCount(_ path: String) -> Int {
        requests.filter { $0 == path }.count
    }

    func read(_ url: URL, _ limit: Int) throws -> Data {
        requests.append(url.path)
        if networkErrors.contains(url.path) {
            throw LibraryService.ServiceError.network("simulated offline network error")
        }
        if let code = statuses[url.path] {
            throw LibraryService.ServiceError.httpStatus(code)
        }
        if let bytes = files[url.path] {
            guard bytes.count <= limit else { throw LibraryService.ServiceError.invalid("too large") }
            return bytes
        }
        throw LibraryService.ServiceError.httpStatus(404)
    }
}

@main struct LibraryFiltersTests {
    static let base = URL(string: "https://fixture.example/blog/")!

    static func check(_ condition: Bool, _ message: String) throws {
        if !condition {
            throw LibraryService.ServiceError.invalid("TEST FAIL: \(message)")
        }
    }

    static func expectThrows(_ message: String, _ work: () async throws -> Void) async throws {
        var threw = false
        do { try await work() } catch { threw = true }
        try check(threw, message)
    }

    static func sha(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func jsonBytes(_ obj: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    }

    static func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("filters-v15-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func main() async throws {
        // 1. Offline deterministic conference venue parsing & canonical display parity
        let interspeech = LibraryService.parseConferenceVenue("conference:interspeech:2026:paper-01")
        try check(interspeech?.key == "conference:interspeech:2026" && interspeech?.label == "Interspeech 2026", "parses Interspeech 2026")
        let venueParityCases: [(String, String)] = [
            ("conference:INTERSPEECH:2026:paper-02", "Interspeech 2026"),
            ("conference:icassp:2026:999", "ICASSP 2026"),
            ("conference:speech_prosody:2026:sp1", "Speech Prosody 2026"),
            ("conference:speech-prosody:2026:sp2", "Speech Prosody 2026"),
            ("conference:speechprosody:2026:sp3", "Speech Prosody 2026"),
            ("conference:Speech-Prosody:2026:sp4", "Speech Prosody 2026"),
            ("conference:waspaa:2025:w1", "WASPAA 2025"),
            ("conference:asru:2025:a1", "ASRU 2025"),
            ("conference:slt:2026:s1", "SLT 2026"),
            ("conference:ismir:2026:i1", "ISMIR 2026"),
            ("conference:dcase:2026:d1", "DCASE 2026"),
            ("conference:taslp:2026:t1", "TASLP 2026"),
            ("conference:ieee_acm_taslp:2026:t2", "TASLP 2026"),
            ("conference:ieee-acm-taslp:2026:t3", "TASLP 2026"),
            ("conference:ieee-acm_taslp:2026:t4", "TASLP 2026"),
            ("conference:neurips:2025:abc", "NeurIPS 2025"),
            ("conference:nips:2024:n1", "NeurIPS 2024"),
            ("conference:icml:2026:m1", "ICML 2026"),
            ("conference:iclr:2026:l1", "ICLR 2026"),
            ("conference:acl:2026:acl1", "ACL 2026"),
            ("conference:emnlp:2026:e1", "EMNLP 2026"),
            ("conference:naacl:2026:na1", "NAACL 2026"),
            ("conference:aaai:2026:aa1", "AAAI 2026"),
            ("conference:ijcai:2026:ij1", "IJCAI 2026"),
            ("conference:cvpr:2026:cv1", "CVPR 2026"),
            ("conference:iccv:2025:ic1", "ICCV 2025"),
            ("conference:eccv:2026:ec1", "ECCV 2026"),
            ("conference:acmmm:2026:mm1", "ACM MM 2026"),
            ("conference:acm_mm:2026:mm2", "ACM MM 2026"),
            ("conference:acm-mm:2026:mm3", "ACM MM 2026"),
            ("conference:mm:2026:mm4", "ACM MM 2026"),
            ("conference:siggraph:2026:sg1", "SIGGRAPH 2026"),
            ("conference:chi:2026:ch1", "CHI 2026"),
            ("conference:ubicomp:2026:ub1", "UbiComp 2026"),
            ("conference:mobicom:2026:mc1", "MobiCom 2026"),
            ("conference:mobisys:2026:ms1", "MobiSys 2026"),
            ("conference:sensys:2026:sn1", "SenSys 2026"),
            ("conference:odyssey:2026:od1", "Odyssey 2026"),
            ("conference:lrec:2026:lr1", "LREC 2026"),
            ("conference:coling:2026:co1", "COLING 2026"),
            ("conference:eacl:2026:ea1", "EACL 2026"),
            ("conference:kdd:2026:kd1", "KDD 2026"),
            ("conference:www:2026:ww1", "WWW 2026"),
            ("conference:icra:2026:ir1", "ICRA 2026"),
            ("conference:iros:2026:io1", "IROS 2026"),
            ("conference:corl:2026:cl1", "CoRL 2026"),
            ("conference:jmlr:2026:jm1", "JMLR 2026"),
            ("conference:tmlr:2026:tm1", "TMLR 2026"),
            ("conference:tacl:2026:ta1", "TACL 2026"),
            ("conference:spl:2026:sp5", "SPL 2026"),
            ("conference:dafx:2026:df1", "DAFx 2026"),
            ("conference:chime:2026:cm1", "CHiME 2026"),
            ("conference:custom_venue:2026:u1", "CUSTOM_VENUE 2026")
        ]
        for (paperID, expectedLabel) in venueParityCases {
            let parsed = LibraryService.parseConferenceVenue(paperID)
            try check(parsed?.label == expectedLabel, "parses \(paperID) as \(expectedLabel) (got \(parsed?.label ?? "nil"))")
        }
        let neurips = LibraryService.parseConferenceVenue("conference:neurips:2025:abc")
        try check(neurips?.key == "conference:neurips:2025" && neurips?.label == "NeurIPS 2025", "parses NeurIPS 2025")
        try check(LibraryService.parseConferenceVenue("arxiv:2611.00001") == nil, "arxiv paper has no conference venue")
        try check(LibraryService.parseConferenceVenue("conference:bad:notayear:1") == nil, "rejects invalid year")
        try check(LibraryService.parseConferenceVenue("conference:icassp:20٢٦:1") == nil, "rejects non-ASCII Unicode digits in year")
        try check(LibraryService.parseConferenceVenue("conference:icassp:20２６:1") == nil, "rejects fullwidth digits in year")

        // 2. Build catalog fixture with varied scores, venues, authors, and Tier 1 artifact concepts
        let rows: [[String: Any]] = [
            [
                "permalink": "/blog/posts/p1/",
                "pageType": "paper",
                "title": "Streaming TTS Codec with Low Latency",
                "titleZh": "低延迟流式语音合成编解码器",
                "date": "2026-11-24",
                "score": 8.6,
                "sourceKind": "arxiv",
                "identityStatus": "verified",
                "arxivId": "2611.00001",
                "authors": ["Alice Résumé", "Bob Chen"],
                "tags": ["TTS", "Neural Codec"],
                "task": "语音合成",
                "method": "Flow Matching",
                "tagConcepts": [["id": "artifact.open-source-tool", "label": "开源工具"]],
                "citation": [
                    "paperKey": "arxiv:2611.00001", "identityStatus": "verified",
                    "sourceKind": "arxiv", "arxivId": "2611.00001v1",
                    "authors": ["Alice Résumé", "Bob Chen"],
                    "sourceUrl": "https://arxiv.org/abs/2611.00001v1", "pdfUrl": "https://arxiv.org/pdf/2611.00001v1.pdf"
                ]
            ],
            [
                "permalink": "/blog/posts/p2/",
                "pageType": "paper",
                "title": "Robust Speech Recognition under Noise",
                "titleZh": "强噪声下的鲁棒语音识别",
                "date": "2026-11-20",
                "score": 7.4,
                "sourceKind": "conference",
                "identityStatus": "verified",
                "paperId": "conference:interspeech:2026:asr-42",
                "authors": ["Carol Lin"],
                "tags": ["ASR", "TTS"],
                "task": "语音识别",
                "method": "Conformer",
                "tagConcepts": [["id": "artifact.model-weights", "label": "模型权重"]],
                "citation": [
                    "paperId": "conference:interspeech:2026:asr-42",
                    "paperKey": "conference:interspeech:2026:asr-42", "identityStatus": "verified",
                    "sourceKind": "conference",
                    "authors": ["Carol Lin"],
                    "sourceUrl": "https://www.isca-archive.org/interspeech_2026/asr42.html"
                ]
            ],
            [
                "permalink": "/blog/posts/p3/",
                "pageType": "paper",
                "title": "Audio Benchmark Corpus",
                "titleZh": "音频评测基准数据集",
                "date": "2026-11-18",
                "score": 6.2,
                "sourceKind": "conference",
                "identityStatus": "verified",
                "paperId": "conference:icassp:2026:bench-7",
                "authors": ["Dave Wu"],
                "tags": ["Benchmark"],
                "tagConcepts": [["id": "artifact.dataset", "label": "数据集"]],
                "citation": [
                    "paperId": "conference:icassp:2026:bench-7",
                    "paperKey": "conference:icassp:2026:bench-7", "identityStatus": "verified",
                    "sourceKind": "conference",
                    "authors": ["Dave Wu"],
                    "sourceUrl": "https://ieeexplore.ieee.org/document/1234567"
                ]
            ],
            [
                "permalink": "/blog/posts/p4/",
                "pageType": "paper",
                "title": "Unscored Survey on Music Generation",
                "titleZh": "音乐生成综述",
                "date": "2026-11-10",
                "sourceKind": "arxiv",
                "identityStatus": "verified",
                "arxivId": "2611.00004",
                "authors": ["Eve Zhang"],
                "tags": ["Music"],
                "citation": [
                    "paperKey": "arxiv:2611.00004", "identityStatus": "verified",
                    "sourceKind": "arxiv", "arxivId": "2611.00004v1",
                    "authors": ["Eve Zhang"],
                    "sourceUrl": "https://arxiv.org/abs/2611.00004v1", "pdfUrl": "https://arxiv.org/pdf/2611.00004v1.pdf"
                ]
            ]
        ]

        let shardData = try jsonBytes(rows)
        let shardSHA = sha(shardData)
        let shardName = "search-index/part-0001-\(shardSHA.prefix(12)).json"
        var manifest = try ClientProtocols.recordHeader("paper-search-index-manifest", "paper-search-index-manifest")
        manifest["recordCount"] = rows.count
        manifest["totalBytes"] = shardData.count
        manifest["shards"] = [["url": shardName, "bytes": shardData.count, "recordCount": rows.count, "sha256": shardSHA]]

        let root = try tempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let transport = FiltersFixtureTransport()
        await transport.set("/blog/client/index.json", data: try jsonBytes(manifest))
        await transport.set("/blog/client/\(shardName)", data: shardData)

        let service = try LibraryService(dataDirectory: root, siteBaseURL: base, transport: { url, limit in
            try await transport.read(url, limit)
        })
        _ = try await service.sync()

        // 3. Multi-token NFKC search + relevance sorting
        // Fullwidth ASCII + diacritic-insensitive author + title token
        let nfkcMatches = await service.matchingPapers(query: "ＴＴＳ  resume", source: nil, minimumScore: nil, sort: .relevance)
        try check(nfkcMatches.map(\.id) == ["arxiv:2611.00001"], "NFKC fullwidth + diacritic multi-token AND matches p1 only")

        // Relevance ranking: "TTS" appears in p1 title AND tags, vs p2 tags only -> p1 MUST rank first
        let relMatches = await service.matchingPapers(query: "TTS", source: nil, minimumScore: nil, sort: .relevance)
        try check(relMatches.count == 2 && relMatches[0].id == "arxiv:2611.00001", "relevance sort ranks title match before tag-only match")

        // Multi-token search including parsed conference venue label ("Interspeech 2026")
        let venueQueryMatches = await service.matchingPapers(query: "interspeech carol", source: nil, minimumScore: nil, sort: .date)
        try check(venueQueryMatches.map(\.id) == ["conference:interspeech:2026:asr-42"], "search includes parsed conference venue label")

        // 4. Conference venue filter
        let interspeechOnly = await service.matchingPapers(query: "", source: nil, minimumScore: nil, sort: .date, conferenceVenue: "conference:interspeech:2026")
        try check(interspeechOnly.map(\.id) == ["conference:interspeech:2026:asr-42"], "conferenceVenue filter isolates Interspeech 2026")

        // 5. Score tier quick presets (scoredOnly & thresholds 8.0 / 7.0 / 6.0)
        let scoredOnly = await service.matchingPapers(query: "", source: nil, minimumScore: nil, sort: .score, scoredOnly: true)
        try check(scoredOnly.count == 3 && !scoredOnly.contains(where: { $0.id == "arxiv:2611.00004" }), "scoredOnly excludes unscored paper")
        let tier8 = await service.matchingPapers(query: "", source: nil, minimumScore: 8.0, sort: .score)
        try check(tier8.map(\.id) == ["arxiv:2611.00001"], "tier >= 8.0 selects featured paper")
        let tier7 = await service.matchingPapers(query: "", source: nil, minimumScore: 7.0, sort: .score)
        try check(tier7.count == 2, "tier >= 7.0 selects 2 papers")
        let tier6 = await service.matchingPapers(query: "", source: nil, minimumScore: 6.0, sort: .score)
        try check(tier6.count == 3, "tier >= 6.0 selects 3 papers")

        // 6. Tier 1 offline resource filter + cached .audio-demo-cta-btn scan
        let articlesDir = root.appendingPathComponent("PublishedLibrary/articles", isDirectory: true)
        try FileManager.default.createDirectory(at: articlesDir, withIntermediateDirectories: true)
        let demoArticleObj: [String: Any] = [
            "paperID": "arxiv:2611.00004",
            "html": "<div class=\"audio-spec-quick-card\"><a class=\"audio-demo-cta-btn\" href=\"https://demo.example\">试听 Demo</a></div>"
        ]
        try jsonBytes(demoArticleObj).write(to: articlesDir.appendingPathComponent("demo-p4.json"))

        // Tier 2 HTTP 404 silent-graceful while still returning cachedDemoIds
        await transport.setStatus("/blog/client/signals/resource-badges.json", status: 404)
        let res404 = try await service.resourceBadgesResponse(forceRefresh: true)
        try check((res404["available"] as? Bool) == false, "resource-badges 404 is silent-graceful")
        try check((res404["cachedDemoIds"] as? [String]) == ["arxiv:2611.00004"], "local scan detects cached audio-demo-cta-btn")

        await transport.setStatus("/blog/client/signals/resource-badges.json", status: 410)
        let res410 = try await service.resourceBadgesResponse(forceRefresh: true)
        try check((res410["available"] as? Bool) == false, "resource-badges 410 is silent-graceful")

        let codeOnly = await service.listResponse(payload: ["resource": "code"])
        try check(((codeOnly["papers"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String } == ["arxiv:2611.00001"], "Tier 1 code filter matches artifact.open-source-tool")

        let modelOnly = await service.listResponse(payload: ["resource": "model"])
        try check(((modelOnly["papers"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String } == ["conference:interspeech:2026:asr-42"], "Tier 1 model filter matches artifact.model-weights")

        let datasetOnly = await service.listResponse(payload: ["resource": "dataset"])
        try check(((datasetOnly["papers"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String } == ["conference:icassp:2026:bench-7"], "Tier 1 dataset filter matches artifact.dataset")

        let demoOnly = await service.listResponse(payload: ["resource": "demo"])
        try check(((demoOnly["papers"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String } == ["arxiv:2611.00004"], "Tier 1 demo filter matches cached audio-demo-cta-btn")

        // 7. Tier 2 HTTP 200 fail-closed on bad schemaFingerprint or non-HTTPS url
        var badBadges = try ClientProtocols.recordHeader("paper-resource-badges-index", "paper-resource-badges-index")
        badBadges["schemaFingerprint"] = String(repeating: "f", count: 64)
        badBadges["generatedAt"] = "2026-11-24T06:00:00Z"
        badBadges["papers"] = [:]
        await transport.set("/blog/client/signals/resource-badges.json", data: try jsonBytes(badBadges))
        try await expectThrows("bad schemaFingerprint in resource-badges must fail closed") {
            _ = try await service.resourceBadgesResponse(forceRefresh: true)
        }

        var nonHttpsBadges = try ClientProtocols.recordHeader("paper-resource-badges-index", "paper-resource-badges-index")
        nonHttpsBadges["generatedAt"] = "2026-11-24T06:00:00Z"
        nonHttpsBadges["papers"] = [
            "arxiv:2611.00001": ["hasCode": true, "codeUrls": ["http://github.com/insecure/repo"]]
        ]
        await transport.set("/blog/client/signals/resource-badges.json", data: try jsonBytes(nonHttpsBadges))
        try await expectThrows("non-HTTPS codeUrl in resource-badges must fail closed") {
            _ = try await service.resourceBadgesResponse(forceRefresh: true)
        }

        // Valid Tier 2 HTTP 200 resource-badges augments p3 with hasCode + hasProjectPage
        var goodBadges = try ClientProtocols.recordHeader("paper-resource-badges-index", "paper-resource-badges-index")
        goodBadges["generatedAt"] = "2026-11-24T06:00:00Z"
        goodBadges["papers"] = [
            "conference:icassp:2026:bench-7": [
                "hasCode": true,
                "hasModel": false,
                "hasDataset": true,
                "hasDemo": false,
                "hasProjectPage": true,
                "codeUrls": ["https://github.com/nanless/bench-code"],
                "projectUrls": ["https://bench.example.org/project"]
            ]
        ]
        await transport.set("/blog/client/signals/resource-badges.json", data: try jsonBytes(goodBadges))
        let res200 = try await service.resourceBadgesResponse(forceRefresh: true)
        try check((res200["available"] as? Bool) == true, "valid 200 resource-badges loads cleanly")
        let codeAfterTier2 = await service.listResponse(payload: ["resource": "code"])
        let codeIDs = Set(((codeAfterTier2["papers"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String })
        try check(codeIDs == Set(["arxiv:2611.00001", "conference:icassp:2026:bench-7"]), "Tier 2 resource-badges merges with Tier 1 signals")

        // Tier 2 offline / network-down and 503 fallback: returns Tier 1 cachedDemoIds, does not mark loaded, and recovers on retry
        let offlineRoot = try tempDir()
        defer { try? FileManager.default.removeItem(at: offlineRoot) }
        let offlineArticlesDir = offlineRoot.appendingPathComponent("PublishedLibrary/articles", isDirectory: true)
        try FileManager.default.createDirectory(at: offlineArticlesDir, withIntermediateDirectories: true)
        try jsonBytes(demoArticleObj).write(to: offlineArticlesDir.appendingPathComponent("demo-p4.json"))
        let offlineService = try LibraryService(dataDirectory: offlineRoot, siteBaseURL: base, transport: { url, limit in
            try await transport.read(url, limit)
        })
        _ = try await offlineService.sync()
        await transport.setNetworkError("/blog/client/signals/resource-badges.json")
        let resOffline = try await offlineService.resourceBadgesResponse(forceRefresh: false)
        try check((resOffline["available"] as? Bool) == false, "offline network error falls back gracefully")
        try check((resOffline["cachedDemoIds"] as? [String]) == ["arxiv:2611.00004"], "offline network error still returns Tier 1 cachedDemoIds")

        // Because Tier 2 was NOT marked loaded on network failure, next non-forced call retries and loads Tier 2 once network recovers
        await transport.set("/blog/client/signals/resource-badges.json", data: try jsonBytes(goodBadges))
        let resRecovered = try await offlineService.resourceBadgesResponse(forceRefresh: false)
        try check((resRecovered["available"] as? Bool) == true, "Tier 2 recovers cleanly on next non-forced load after network failure")
        try check((resRecovered["cachedDemoIds"] as? [String]) == ["arxiv:2611.00004"], "Tier 1 cachedDemoIds preserved after recovery")

        // Subsequent forced refresh hitting 503 preserves previously loaded Tier 2 cachedSignals AND Tier 1 cachedDemoIds
        await transport.setStatus("/blog/client/signals/resource-badges.json", status: 503)
        let res503 = try await offlineService.resourceBadgesResponse(forceRefresh: true)
        try check((res503["available"] as? Bool) == true, "transient 503 preserves prior Tier 2 cachedSignals")
        let papers503 = (res503["papers"] as? [String: Any]) ?? [:]
        try check(papers503["conference:icassp:2026:bench-7"] != nil, "prior Tier 2 badge entry retained on transient 503")
        try check((res503["cachedDemoIds"] as? [String]) == ["arxiv:2611.00004"], "Tier 1 cachedDemoIds still returned on transient 503")

        // 8. VerifiedDesktopDetail parses & forwards assessment.rankBucket & assessment.documentType
        let articleHTML = Data("<div id='article-body'><p>Detail body</p></div>".utf8)
        let articleRevSHA = sha(articleHTML)
        let citationRecord = try ClientProtocols.record("paper-citation-source", fields: [
            "paperKey": "arxiv:2611.00001",
            "paperId": "",
            "identityStatus": "verified",
            "verified": true,
            "complete": true,
            "sourceKind": "arxiv",
            "title": "Streaming TTS Codec",
            "authors": ["Alice Résumé"],
            "date": "2026-11-24",
            "doi": "",
            "venue": "",
            "arxivId": "2611.00001v1",
            "url": "https://arxiv.org/abs/2611.00001v1",
            "sourceUrl": "https://arxiv.org/abs/2611.00001v1",
            "pdfUrl": "https://arxiv.org/pdf/2611.00001v1.pdf",
            "pageUrl": "/blog/posts/p1/",
            "pageType": "paper"
        ])
        let detailObj = try ClientProtocols.record("paper-desktop-detail", fields: [
            "appearanceId": "posts/p1/",
            "paperId": "arxiv:2611.00001",
            "identityStatus": "verified",
            "sourceKind": "arxiv",
            "sourceVersion": [
                "sourceVersionId": "2611.00001v1",
                "versionLabel": "v1",
                "sourceUrl": "https://arxiv.org/abs/2611.00001v1",
                "pdfUrl": "https://arxiv.org/pdf/2611.00001v1.pdf",
                "pdfSha256": NSNull(),
                "sourceVersionWarning": NSNull(),
                "provenanceDisclosure": NSNull()
            ] as [String: Any],
            "appearance": [
                "appearanceId": "posts/p1/",
                "pageUrl": "posts/p1/",
                "pageType": "paper",
                "publicationStatus": "active",
                "articleRevisionId": articleRevSHA,
                "retraction": NSNull()
            ] as [String: Any],
            "articleRevision": [
                "articleRevisionId": articleRevSHA,
                "appearanceId": "posts/p1/",
                "articleDescriptor": [
                    "url": "client/details/articles/\(articleRevSHA).html",
                    "bytes": articleHTML.count,
                    "sha256": articleRevSHA
                ] as [String: Any],
                "hasGuideContent": true,
                "resourceCount": 0
            ] as [String: Any],
            "titles": [
                "originalTitle": "Streaming TTS Codec",
                "readerTitle": "低延迟流式语音合成编解码器",
                "displayTitle": "Streaming TTS Codec"
            ],
            "authors": [["position": 1, "name": "Alice Résumé"]],
            "dates": [
                "paperPublishedAt": "2026-11-24",
                "blogPublishedAt": "2026-11-24",
                "articleUpdatedAt": NSNull()
            ] as [String: Any],
            "bibliographic": [
                "venue": NSNull(),
                "doi": NSNull(),
                "arxivId": "2611.00001",
                "arxivVersionedId": "2611.00001v1",
                "categories": ["cs.SD"]
            ] as [String: Any],
            "abstract": "Abstract text",
            "oneSentenceThesis": "One sentence thesis",
            "classification": [
                "primaryTask": "语音合成",
                "primaryTaskId": "task.tts",
                "primaryMethod": "Flow Matching",
                "primaryMethodId": "method.flow-matching",
                "tagConceptIds": ["task.tts"],
                "tags": ["TTS"]
            ] as [String: Any],
            "assessment": [
                "score": 8.6,
                "rankBucket": "top-pick",
                "documentType": "research-paper"
            ] as [String: Any],
            "citation": [
                "sourceRecord": citationRecord,
                "verified": true,
                "complete": true,
                "missingFields": [String](),
                "fieldStatus": ["title": "verified"]
            ] as [String: Any],
            "sidecars": [
                "available": false,
                "files": [
                    "citation.json": NSNull(),
                    "citation.bib": NSNull(),
                    "citation.ris": NSNull(),
                    "rethink-context.json": NSNull()
                ]
            ] as [String: Any],
            "resources": [[String: Any]]()
        ])

        let detailBytes = try jsonBytes(detailObj)
        let detailSHA = sha(detailBytes)
        let appearanceEntry = LibraryService.DesktopAppearanceEntry(
            appearanceId: "posts/p1/",
            blogURL: "posts/p1/",
            pageType: "paper",
            publicationStatus: "active",
            blogPublishedAt: "2026-11-24",
            articleUpdatedAt: nil,
            sourceVersionId: "2611.00001v1",
            articleRevisionId: articleRevSHA,
            detail: LibraryService.DesktopFileDescriptor(url: "client/details/papers/\(detailSHA).json", bytes: detailBytes.count, sha256: detailSHA)
        )
        let verified = try LibraryService.parseAndVerifyDesktopDetail(
            detailBytes,
            expectedAppearance: appearanceEntry,
            expectedPaperID: "arxiv:2611.00001",
            expectedIdentityStatus: "verified"
        )
        try check(verified.assessmentRankBucket == "top-pick", "VerifiedDesktopDetail parses assessment.rankBucket")
        try check(verified.assessmentDocumentType == "research-paper", "VerifiedDesktopDetail parses assessment.documentType")

        // 9. Regression tests for #10, #11, #18, #19
        for dangerousKey in ["__proto__", "constructor", "prototype"] {
            var badKeyBadges = try ClientProtocols.recordHeader("paper-resource-badges-index", "paper-resource-badges-index")
            badKeyBadges["generatedAt"] = "2026-11-24T06:00:00Z"
            badKeyBadges["papers"] = [dangerousKey: ["hasCode": true]]
            try await expectThrows("dangerous badge key \(dangerousKey) must be rejected") {
                _ = try LibraryService.parseResourceBadgesIndex(try jsonBytes(badKeyBadges))
            }
        }
        var extraRootBadge = try ClientProtocols.recordHeader("paper-resource-badges-index", "paper-resource-badges-index")
        extraRootBadge["generatedAt"] = "2026-11-24T06:00:00Z"
        extraRootBadge["papers"] = [:]
        extraRootBadge["extraKey"] = 1
        try await expectThrows("unexpected root key in resource-badges must fail closed") {
            _ = try LibraryService.parseResourceBadgesIndex(try jsonBytes(extraRootBadge))
        }
        var extraEntryBadge = try ClientProtocols.recordHeader("paper-resource-badges-index", "paper-resource-badges-index")
        extraEntryBadge["generatedAt"] = "2026-11-24T06:00:00Z"
        extraEntryBadge["papers"] = ["arxiv:2611.00001": ["hasCode": true, "rogue": true]]
        try await expectThrows("unexpected entry key in resource-badges must fail closed") {
            _ = try LibraryService.parseResourceBadgesIndex(try jsonBytes(extraEntryBadge))
        }

        // #19: query token deduplication & 32-token cap
        let noisyQuery = (1...50).map { "tok\($0) tok\($0)" }.joined(separator: " ")
        let cappedTokens = LibraryService.searchTokens(noisyQuery)
        try check(cappedTokens.count == 32 && Set(cappedTokens).count == 32, "searchTokens deduplicates and caps at 32")

        // #18: scanCachedAudioDemoPaperIDs memoizes and refreshes on forceRescan
        let firstScan = await service.scanCachedAudioDemoPaperIDs()
        try check(firstScan == ["arxiv:2611.00004"], "initial memoized demo scan")
        try jsonBytes(["paperID": "arxiv:2611.00001", "html": "<a class=\"audio-demo-cta-btn\">demo</a>"]).write(to: articlesDir.appendingPathComponent("demo-p1.json"))
        let memoizedScan = await service.scanCachedAudioDemoPaperIDs(forceRescan: false)
        try check(memoizedScan == ["arxiv:2611.00004"], "subsequent scan uses memoized cache")
        let rescanned = await service.scanCachedAudioDemoPaperIDs(forceRescan: true)
        try check(rescanned == ["arxiv:2611.00001", "arxiv:2611.00004"], "forceRescan picks up newly written demo article")

        // CL-P1-3: desktop-details/ cache detection resolves articleRevision.articleDescriptor.sha256
        // even when primaryArticleRevisionId differs from articleDescriptor.sha256.
        let desktopHTML = Data("<div id='article-body'><a class=\"audio-demo-cta-btn\" href=\"https://demo.example\">试听</a></div>".utf8)
        let desktopArticleSHA = sha(desktopHTML)
        let distinctRevisionID = sha(Data("distinct-revision-id-v2".utf8))
        try check(distinctRevisionID != desktopArticleSHA, "fixture revision ID differs from article descriptor SHA")
        var desktopDetailObj = detailObj
        desktopDetailObj["paperId"] = "conference:interspeech:2026:asr-42"
        desktopDetailObj["appearanceId"] = "posts/p2/"
        desktopDetailObj["articleRevision"] = [
            "articleRevisionId": distinctRevisionID,
            "appearanceId": "posts/p2/",
            "articleDescriptor": [
                "url": "client/details/articles/\(desktopArticleSHA).html",
                "bytes": desktopHTML.count,
                "sha256": desktopArticleSHA
            ] as [String: Any],
            "hasGuideContent": true,
            "resourceCount": 0
        ] as [String: Any]
        let desktopDetailBytes = try jsonBytes(desktopDetailObj)
        let desktopDetailSHA = sha(desktopDetailBytes)
        let pubDir = root.appendingPathComponent("PublishedLibrary", isDirectory: true)
        let ddRootDir = pubDir.appendingPathComponent("desktop-details", isDirectory: true)
        let ddPapersDir = ddRootDir.appendingPathComponent("papers", isDirectory: true)
        let ddArticlesDir = ddRootDir.appendingPathComponent("articles", isDirectory: true)
        try FileManager.default.createDirectory(at: ddPapersDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: ddArticlesDir, withIntermediateDirectories: true)
        try desktopDetailBytes.write(to: ddPapersDir.appendingPathComponent("\(desktopDetailSHA).json"))
        try desktopHTML.write(to: ddArticlesDir.appendingPathComponent("\(desktopArticleSHA).html"))
        let snap = await service.snapshot
        let snapID = snap.summary.snapshotID
        guard let snapEpoch = snap.validationEpoch else {
            throw LibraryService.ServiceError.invalid("TEST FAIL: synced snapshot must have validationEpoch")
        }
        let ddDesc = LibraryService.DesktopFileDescriptor(url: "client/details/papers/\(desktopDetailSHA).json", bytes: desktopDetailBytes.count, sha256: desktopDetailSHA)
        let ddApp = LibraryService.DesktopAppearanceEntry(
            appearanceId: "posts/p2/",
            blogURL: "posts/p2/",
            pageType: "paper",
            publicationStatus: "active",
            blogPublishedAt: "2026-11-20",
            articleUpdatedAt: nil,
            sourceVersionId: nil,
            articleRevisionId: distinctRevisionID,
            detail: ddDesc
        )
        let ddEntry = LibraryService.DesktopPaperDetailEntry(
            paperID: "conference:interspeech:2026:asr-42",
            primaryAppearanceId: "posts/p2/",
            primaryBlogURL: "posts/p2/",
            primaryArticleRevisionId: distinctRevisionID,
            primaryPublicationStatus: "active",
            primaryDetail: ddDesc,
            appearances: [ddApp]
        )
        let ddState = LibraryService.DesktopDetailsState(
            snapshotID: snapID,
            validationEpoch: snapEpoch,
            sourceCommit: String(repeating: "a", count: 40),
            generatedAt: "2026-11-24T06:00:00Z",
            basePath: "/blog/",
            paperDetails: ["conference:interspeech:2026:asr-42": ddEntry],
            aggregateDetails: [:],
            activeTombstones: [],
            tombstoneHistory: []
        )
        try JSONEncoder().encode(ddState).write(to: ddRootDir.appendingPathComponent("state.json"))
        let reloaded = try LibraryService(dataDirectory: root, siteBaseURL: base, transport: { url, limit in
            try await transport.read(url, limit)
        })
        try await reloaded.waitUntilReady()
        let activeDD = await reloaded.activeDesktopDetails()
        try check(activeDD != nil, "reloaded service activates matching desktop-details state")
        let desktopDemoScan = await reloaded.scanCachedAudioDemoPaperIDs(forceRescan: true)
        try check(desktopDemoScan.contains("conference:interspeech:2026:asr-42"), "desktop-details demo scan resolves articleDescriptor.sha256 even when primaryArticleRevisionId differs")
        await reloaded.invalidateSession()

        print("LibraryFiltersTests: ALL CHECKS PASSED")
    }
}
