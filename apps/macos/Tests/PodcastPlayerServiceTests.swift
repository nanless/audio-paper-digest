import Foundation
import CryptoKit

private actor PodcastFixtureTransport {
    var feedStatus: Int = 404
    var feedData: Data = Data()
    var audioResponses: [String: (status: Int, headers: [String: String], data: Data)] = [:]
    var requestedURLs: [String] = []

    func setFeed(status: Int, data: Data) {
        feedStatus = status
        feedData = data
    }

    func setAudio(_ url: String, status: Int, headers: [String: String] = [:], data: Data = Data()) {
        audioResponses[url] = (status, headers, data)
    }

    func fetchFeed(_ url: URL, _ limit: Int) async throws -> (statusCode: Int, data: Data) {
        requestedURLs.append(url.absoluteString)
        return (feedStatus, feedData)
    }

    func fetchAudio(_ url: URL, _ limit: Int) async throws -> (statusCode: Int, headers: [String: String], data: Data) {
        requestedURLs.append(url.absoluteString)
        if let entry = audioResponses[url.absoluteString] {
            return (entry.status, entry.headers, entry.data)
        }
        return (404, [:], Data())
    }

    func paths() -> [String] { requestedURLs }
}

@main struct PodcastPlayerServiceTests {
    static let base = URL(string: "https://fixture.example/blog/")!

    static func check(_ condition: Bool, _ message: String) throws {
        if !condition {
            throw PodcastPlayerService.PodcastError.invalid("TEST FAIL: \(message)")
        }
    }

    static func expectThrows(_ message: String, _ work: () async throws -> Void) async throws {
        var threw = false
        do {
            try await work()
        } catch {
            threw = true
        }
        try check(threw, message)
    }

    static func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("podcast-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func makeMP3Data(seed: UInt8, size: Int = 256) -> Data {
        // Valid ID3v2.3 header (10 bytes) + valid MPEG-1 Layer III frame header + deterministic payload
        var bytes: [UInt8] = [0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFB, 0x90, 0x00]
        while bytes.count < size {
            bytes.append(seed &+ UInt8(bytes.count & 0xFF))
        }
        return Data(bytes)
    }

    static func makeFeedJSON(episodes: [[String: Any]]) throws -> Data {
        var payload = try ClientProtocols.recordHeader("paper-daily-podcast-feed", "paper-daily-podcast-feed")
        payload["generatedAt"] = "2026-11-24T06:00:00Z"
        payload["episodes"] = episodes
        return try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    }

    static func episodeDict(
        id: String,
        date: String,
        title: String,
        audioUrl: String,
        data: Data,
        shaOverride: String? = nil,
        bytesOverride: Int? = nil
    ) -> [String: Any] {
        [
            "id": id,
            "date": date,
            "title": title,
            "summary": "测试每日播客简介",
            "audioUrl": audioUrl,
            "bytes": bytesOverride ?? data.count,
            "sha256": shaOverride ?? PodcastPlayerService.sha256Hex(data),
            "durationSeconds": 420,
            "mimeType": "audio/mpeg",
            "chapters": [
                ["title": "开场导读", "startSeconds": 0, "endSeconds": 60, "paperId": NSNull()],
                ["title": "精选论文 A", "startSeconds": 60, "endSeconds": 240, "paperId": "2611.00001v1"]
            ],
            "paperIds": ["arxiv:2611.00001"]
        ]
    }

    static func main() async throws {
        // 1. Strict initial GitHub Release HTTPS URL validation
        let goodMainRepo = URL(string: "https://github.com/nanless/audio-paper-digest/releases/download/podcast-2026-11-24/daily-2026-11-24.mp3")!
        let goodBlogRepo = URL(string: "https://github.com/nanless/audio-paper-digest-blog/releases/download/v1.5.0/daily-2026-11-24.mp3")!
        try check(PodcastPlayerService.isValidInitialAudioURL(goodMainRepo), "accepts nanless/audio-paper-digest release mp3")
        try check(PodcastPlayerService.isValidInitialAudioURL(goodBlogRepo), "accepts nanless/audio-paper-digest-blog release mp3")

        let badInitials = [
            "http://github.com/nanless/audio-paper-digest/releases/download/v1/ep.mp3",
            "https://github.com/other/audio-paper-digest/releases/download/v1/ep.mp3",
            "https://github.com/nanless/other-repo/releases/download/v1/ep.mp3",
            "https://github.com/nanless/audio-paper-digest/releases/download/v1/ep.wav",
            "https://github.com/nanless/audio-paper-digest/releases/download/v1/ep.mp3?token=1",
            "https://github.com/nanless/audio-paper-digest/releases/download/v1/ep.mp3#frag",
            "https://github.com/nanless/audio-paper-digest/releases/download/v1/%2e%2e/ep.mp3",
            "https://objects.githubusercontent.com/nanless/ep.mp3"
        ]
        for raw in badInitials {
            try check(!PodcastPlayerService.isValidInitialAudioURL(URL(string: raw)!), "rejects invalid initial URL: \(raw)")
        }

        // 2. Redirect target host validation
        try check(PodcastPlayerService.isValidRedirectAudioURL(URL(string: "https://release-assets.githubusercontent.com/github-production-release-asset/123?sig=ok")!), "accepts release-assets redirect")
        try check(PodcastPlayerService.isValidRedirectAudioURL(URL(string: "https://objects.githubusercontent.com/github-production-release-asset/123?sig=ok")!), "accepts objects.githubusercontent redirect")
        try check(PodcastPlayerService.isValidRedirectAudioURL(goodBlogRepo), "accepts github.com valid initial release URL")
        try check(!PodcastPlayerService.isValidRedirectAudioURL(URL(string: "https://evil.example/a.mp3")!), "rejects evil host redirect")
        try check(!PodcastPlayerService.isValidRedirectAudioURL(URL(string: "https://raw.githubusercontent.com/nanless/a.mp3")!), "rejects raw.githubusercontent.com redirect")
        try check(!PodcastPlayerService.isValidRedirectAudioURL(URL(string: "http://objects.githubusercontent.com/a.mp3")!), "rejects http redirect")

        // 3. MP3 magic byte validation
        try check(PodcastPlayerService.isValidMP3Magic(makeMP3Data(seed: 1)), "accepts ID3v2 header")
        try check(PodcastPlayerService.isValidMP3Magic(Data([0xFF, 0xFB, 0x90, 0x00, 0x11, 0x22])), "accepts raw MPEG frame sync")
        try check(!PodcastPlayerService.isValidMP3Magic(Data("<html>not audio</html>".utf8)), "rejects HTML masquerading as mp3")
        try check(!PodcastPlayerService.isValidMP3Magic(Data("{\"error\":\"nope\"}".utf8)), "rejects JSON masquerading as mp3")
        try check(!PodcastPlayerService.isValidMP3Magic(Data("%PDF-1.7\n".utf8)), "rejects PDF masquerading as mp3")
        try check(!PodcastPlayerService.isValidMP3Magic(Data([0xFF, 0xE1, 0xFF, 0xFF])), "rejects invalid MPEG sync bits")

        let root = try tempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let transport = PodcastFixtureTransport()
        let service = try PodcastPlayerService(
            cacheDirectory: root.appendingPathComponent("PodcastCache", isDirectory: true),
            siteBaseURL: base,
            feedTransport: { url, limit in try await transport.fetchFeed(url, limit) },
            audioTransport: { url, limit in try await transport.fetchAudio(url, limit) },
            enableMediaCenter: false,
            maxCacheBytes: 150 * 1024 * 1024,
            maxCachedEpisodes: 5
        )

        // Verify cache directory is excluded from backup
        let rv = try service.cacheDirectory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        try check(rv.isExcludedFromBackup == true, "podcast cache directory must be excluded from backup")

        // 4. Feed HTTP 404 & 410 silent-graceful
        await transport.setFeed(status: 404, data: Data("Not Found".utf8))
        let res404 = try await service.fetchFeed(forceRefresh: true)
        try check((res404["available"] as? Bool) == false, "404 feed returns available=false")
        try check(((res404["episodes"] as? [[String: Any]]) ?? []).isEmpty, "404 feed returns empty episodes")

        await transport.setFeed(status: 410, data: Data("Gone".utf8))
        let res410 = try await service.fetchFeed(forceRefresh: true)
        try check((res410["available"] as? Bool) == false, "410 feed returns available=false")

        // 5. Feed HTTP 200 fail-closed on invalid JSON / wrong schemaFingerprint / bad audioUrl / oversize
        await transport.setFeed(status: 200, data: Data("not json".utf8))
        try await expectThrows("corrupt 200 feed must fail closed") {
            _ = try await service.fetchFeed(forceRefresh: true)
        }

        var badFP = try ClientProtocols.recordHeader("paper-daily-podcast-feed", "paper-daily-podcast-feed")
        badFP["schemaFingerprint"] = String(repeating: "0", count: 64)
        badFP["generatedAt"] = "2026-11-24T06:00:00Z"
        badFP["episodes"] = []
        await transport.setFeed(status: 200, data: try JSONSerialization.data(withJSONObject: badFP))
        try await expectThrows("wrong schemaFingerprint feed must fail closed") {
            _ = try await service.fetchFeed(forceRefresh: true)
        }

        let mp3A = makeMP3Data(seed: 10, size: 512)
        let badRepoFeed = try makeFeedJSON(episodes: [
            episodeDict(id: "ep-bad-url", date: "2026-11-24", title: "Bad URL", audioUrl: "https://github.com/evil/repo/releases/download/v1/x.mp3", data: mp3A)
        ])
        await transport.setFeed(status: 200, data: badRepoFeed)
        try await expectThrows("non-allowlisted audioUrl must fail closed") {
            _ = try await service.fetchFeed(forceRefresh: true)
        }

        let oversizeFeed = try makeFeedJSON(episodes: [
            episodeDict(id: "ep-oversize", date: "2026-11-24", title: "Oversize", audioUrl: goodMainRepo.absoluteString, data: mp3A, bytesOverride: 40 * 1024 * 1024 + 1)
        ])
        await transport.setFeed(status: 200, data: oversizeFeed)
        try await expectThrows("declared bytes > 40 MiB must fail closed") {
            _ = try await service.fetchFeed(forceRefresh: true)
        }

        // 6. Valid 200 feed + 4-hop redirect download + integrity verification
        let urlHop0 = "https://github.com/nanless/audio-paper-digest/releases/download/podcast-2026-11-24/ep-a.mp3"
        let urlHop1 = "https://release-assets.githubusercontent.com/hop1/ep-a.mp3?sig=1"
        let urlHop2 = "https://objects.githubusercontent.com/hop2/ep-a.mp3?sig=2"
        let urlHop3 = "https://objects.githubusercontent.com/hop3/ep-a.mp3?sig=3"
        let urlHop4 = "https://release-assets.githubusercontent.com/hop4/ep-a.mp3?sig=4"

        let url5Hops = "https://github.com/nanless/audio-paper-digest/releases/download/podcast-2026-11-24/ep-5hops.mp3"
        let urlEvilRedirect = "https://github.com/nanless/audio-paper-digest/releases/download/podcast-2026-11-24/ep-evil.mp3"
        let urlBadSHA = "https://github.com/nanless/audio-paper-digest/releases/download/podcast-2026-11-24/ep-badsha.mp3"
        let urlBadBytes = "https://github.com/nanless/audio-paper-digest/releases/download/podcast-2026-11-24/ep-badbytes.mp3"
        let urlBadMagic = "https://github.com/nanless/audio-paper-digest/releases/download/podcast-2026-11-24/ep-badmagic.mp3"

        let fakeHtmlBytes = Data(repeating: 0x41, count: 512) // "AAA..." valid sha/len, invalid MP3 magic
        let mp3_5Hops = makeMP3Data(seed: 21, size: 512)
        let mp3_Evil = makeMP3Data(seed: 22, size: 512)
        let mp3_BadSHA = makeMP3Data(seed: 23, size: 512)
        let mp3_BadBytes = makeMP3Data(seed: 24, size: 512)

        let validFeed = try makeFeedJSON(episodes: [
            episodeDict(id: "ep-a", date: "2026-11-24", title: "4跳成功节目", audioUrl: urlHop0, data: mp3A),
            episodeDict(id: "ep-5hops", date: "2026-11-23", title: "5跳超限", audioUrl: url5Hops, data: mp3_5Hops),
            episodeDict(id: "ep-evil", date: "2026-11-22", title: "非法重定向", audioUrl: urlEvilRedirect, data: mp3_Evil),
            episodeDict(id: "ep-badsha", date: "2026-11-21", title: "SHA不符", audioUrl: urlBadSHA, data: mp3_BadSHA),
            episodeDict(id: "ep-badbytes", date: "2026-11-20", title: "字节数不符", audioUrl: urlBadBytes, data: mp3_BadBytes),
            episodeDict(id: "ep-badmagic", date: "2026-11-19", title: "伪造魔数", audioUrl: urlBadMagic, data: fakeHtmlBytes)
        ])
        await transport.setFeed(status: 200, data: validFeed)
        let fetched = try await service.fetchFeed(forceRefresh: true)
        try check((fetched["available"] as? Bool) == true, "valid 200 feed is available")
        let epList = (fetched["episodes"] as? [[String: Any]]) ?? []
        try check(epList.count == 6, "parsed all 6 episodes")
        try check((epList.first?["id"] as? String) == "ep-a", "sorted descending by date")

        // Configure 4-hop chain (succeeds)
        await transport.setAudio(urlHop0, status: 302, headers: ["Location": urlHop1])
        await transport.setAudio(urlHop1, status: 302, headers: ["Location": urlHop2])
        await transport.setAudio(urlHop2, status: 307, headers: ["Location": urlHop3])
        await transport.setAudio(urlHop3, status: 302, headers: ["Location": urlHop4])
        await transport.setAudio(urlHop4, status: 200, data: mp3A)

        let cachedA = try await service.downloadEpisode(id: "ep-a")
        try check(FileManager.default.fileExists(atPath: cachedA.path), "4-hop valid MP3 cached locally")
        try check((try Data(contentsOf: cachedA)) == mp3A, "cached MP3 bytes match exact payload")

        // 5-hop chain must fail
        let h5_1 = "https://objects.githubusercontent.com/h5/1"
        let h5_2 = "https://objects.githubusercontent.com/h5/2"
        let h5_3 = "https://objects.githubusercontent.com/h5/3"
        let h5_4 = "https://objects.githubusercontent.com/h5/4"
        let h5_5 = "https://objects.githubusercontent.com/h5/5"
        await transport.setAudio(url5Hops, status: 302, headers: ["Location": h5_1])
        await transport.setAudio(h5_1, status: 302, headers: ["Location": h5_2])
        await transport.setAudio(h5_2, status: 302, headers: ["Location": h5_3])
        await transport.setAudio(h5_3, status: 302, headers: ["Location": h5_4])
        await transport.setAudio(h5_4, status: 302, headers: ["Location": h5_5])
        await transport.setAudio(h5_5, status: 200, data: mp3A)
        try await expectThrows("5-hop redirect must be rejected") {
            _ = try await service.downloadEpisode(id: "ep-5hops")
        }

        // Redirect to untrusted host must fail
        await transport.setAudio(urlEvilRedirect, status: 302, headers: ["Location": "https://evil.example/stolen.mp3"])
        try await expectThrows("redirect to evil host must be rejected") {
            _ = try await service.downloadEpisode(id: "ep-evil")
        }

        // SHA mismatch must fail (same size, different bytes)
        await transport.setAudio(urlBadSHA, status: 200, data: makeMP3Data(seed: 99, size: 512))
        try await expectThrows("SHA-256 mismatch must fail closed") {
            _ = try await service.downloadEpisode(id: "ep-badsha")
        }

        // Byte-length mismatch must fail
        await transport.setAudio(urlBadBytes, status: 200, data: makeMP3Data(seed: 10, size: 400))
        try await expectThrows("byte-length mismatch must fail closed") {
            _ = try await service.downloadEpisode(id: "ep-badbytes")
        }

        // Non-MP3 magic must fail even when bytes & SHA match
        await transport.setAudio(urlBadMagic, status: 200, data: fakeHtmlBytes)
        try await expectThrows("non-MP3 magic bytes must fail closed") {
            _ = try await service.downloadEpisode(id: "ep-badmagic")
        }

        // 7. Rate validation
        for validRate in [0.75, 1.0, 1.25, 1.5, 2.0] {
            let state = try await service.setRate(validRate)
            try check(abs(((state["rate"] as? Double) ?? 0) - validRate) < 0.001, "accepts rate \(validRate)")
        }
        for invalidRate in [0.5, 3.0, Double.nan] {
            try await expectThrows("rejects unsupported rate \(invalidRate)") {
                _ = try await service.setRate(invalidRate)
            }
        }

        // 8. LRU cache eviction (max 5 episodes)
        let lruTransport = PodcastFixtureTransport()
        let lruDir = root.appendingPathComponent("LRUCount", isDirectory: true)
        let lruService = try PodcastPlayerService(
            cacheDirectory: lruDir,
            siteBaseURL: base,
            feedTransport: { url, limit in try await lruTransport.fetchFeed(url, limit) },
            audioTransport: { url, limit in try await lruTransport.fetchAudio(url, limit) },
            enableMediaCenter: false,
            maxCacheBytes: 150 * 1024 * 1024,
            maxCachedEpisodes: 5
        )
        var lruEpisodes: [[String: Any]] = []
        for idx in 1...6 {
            let data = makeMP3Data(seed: UInt8(idx * 17), size: 300)
            let url = "https://github.com/nanless/audio-paper-digest-blog/releases/download/v1.5/ep-\(idx).mp3"
            lruEpisodes.append(episodeDict(id: "ep-\(idx)", date: String(format: "2026-11-%02d", idx), title: "Ep \(idx)", audioUrl: url, data: data))
            await lruTransport.setAudio(url, status: 200, data: data)
        }
        await lruTransport.setFeed(status: 200, data: try makeFeedJSON(episodes: lruEpisodes))
        _ = try await lruService.fetchFeed(forceRefresh: true)
        for idx in 1...6 {
            _ = try await lruService.downloadEpisode(id: "ep-\(idx)")
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        let cachedAfter6 = await lruService.cachedEpisodeIDs()
        try check(cachedAfter6.count == 5, "LRU enforces 5-episode cap, got \(cachedAfter6.count)")
        try check(!cachedAfter6.contains("ep-1"), "LRU evicted oldest ep-1")
        try check(cachedAfter6.contains("ep-6"), "LRU retained newest ep-6")

        // 9. Byte-budget LRU eviction & clearCache
        let budgetDir = root.appendingPathComponent("LRUBudget", isDirectory: true)
        let budgetService = try PodcastPlayerService(
            cacheDirectory: budgetDir,
            siteBaseURL: base,
            feedTransport: { url, limit in try await lruTransport.fetchFeed(url, limit) },
            audioTransport: { url, limit in try await lruTransport.fetchAudio(url, limit) },
            enableMediaCenter: false,
            maxCacheBytes: 650, // fits 2 x 300B episodes, not 3
            maxCachedEpisodes: 5
        )
        _ = try await budgetService.fetchFeed(forceRefresh: true)
        _ = try await budgetService.downloadEpisode(id: "ep-1")
        try await Task.sleep(nanoseconds: 5_000_000)
        _ = try await budgetService.downloadEpisode(id: "ep-2")
        try await Task.sleep(nanoseconds: 5_000_000)
        _ = try await budgetService.downloadEpisode(id: "ep-3")
        try check(await budgetService.cachedTotalBytes() <= 650, "LRU enforces byte budget")
        try check(await budgetService.cachedEpisodeIDs() == Set(["ep-2", "ep-3"]), "byte-budget LRU evicted ep-1")

        let cleared = await budgetService.clearCache()
        try check((cleared["cachedBytes"] as? Int) == 0, "clearCache resets cachedBytes to 0")
        try check(((cleared["cachedEpisodeIds"] as? [String]) ?? []).isEmpty, "clearCache removes all cached IDs")
        await budgetService.shutdown()

        // 10. Regression tests for P1/P2 adversarial review findings:
        // #8: loadCacheIndex rejects traversal/malformed SHA entries
        let badIndexDir = root.appendingPathComponent("BadIndex", isDirectory: true)
        try FileManager.default.createDirectory(at: badIndexDir, withIntermediateDirectories: true)
        let badIndexJSON = """
        {"entries":[
          {"sha256":"../../escape","episodeId":"evil","bytes":100,"lastAccessedAt":1},
          {"sha256":"\(String(repeating: "a", count: 64))","episodeId":"","bytes":100,"lastAccessedAt":2},
          {"sha256":"\(String(repeating: "b", count: 64))","episodeId":"zero","bytes":0,"lastAccessedAt":3},
          {"sha256":"\(String(repeating: "c", count: 64))","episodeId":"ok","bytes":256,"lastAccessedAt":4}
        ]}
        """
        try Data(badIndexJSON.utf8).write(to: badIndexDir.appendingPathComponent("cache-index.json"))
        let loadedIdx = PodcastPlayerService.loadCacheIndex(at: badIndexDir)
        try check(loadedIdx.entries.count == 1 && loadedIdx.entries[0].episodeId == "ok", "loadCacheIndex drops traversal/invalid entries")

        // #9: parseFinalHTTPHeaderBlock ignores proxy CONNECT preamble block
        let multiBlockHeaders = "HTTP/1.1 200 Connection Established\r\nLocation: https://evil.example/connect\r\n\r\nHTTP/2 302 \r\nLocation: https://objects.githubusercontent.com/final.mp3\r\nContent-Type: audio/mpeg\r\n\r\n"
        let parsedFinal = PodcastPlayerService.parseFinalHTTPHeaderBlock(multiBlockHeaders)
        try check(parsedFinal["location"] == "https://objects.githubusercontent.com/final.mp3", "parseFinalHTTPHeaderBlock reads ONLY final HTTP response block")

        // #9: encoded traversal in redirect URL rejected
        try check(!PodcastPlayerService.isValidRedirectAudioURL(URL(string: "https://objects.githubusercontent.com/%2e%2e/secret.mp3")!), "rejects %2e%2e in redirect URL")

        // #10: strict calendar date, durationSeconds > 0, exact mimeType == audio/mpeg, no extra keys, strict float bytes
        try check(PodcastPlayerService.isValidDate("2024-02-29"), "accepts leap day 2024-02-29")
        try check(!PodcastPlayerService.isValidDate("2025-02-29"), "rejects non-leap 2025-02-29")
        try check(!PodcastPlayerService.isValidDate("2026-02-30"), "rejects impossible calendar date 2026-02-30")
        try check(!PodcastPlayerService.isValidDate("2026-04-31"), "rejects impossible calendar date 2026-04-31")

        var extraRootObj = try ClientProtocols.recordHeader("paper-daily-podcast-feed", "paper-daily-podcast-feed")
        extraRootObj["generatedAt"] = "2026-11-24T06:00:00Z"
        extraRootObj["episodes"] = []
        extraRootObj["unexpectedRootKey"] = true
        try await expectThrows("unexpected root key must fail closed") {
            _ = try PodcastPlayerService.parseFeed(try JSONSerialization.data(withJSONObject: extraRootObj))
        }

        var zeroDurEp = episodeDict(id: "ep-zero-dur", date: "2026-11-24", title: "Zero Dur", audioUrl: goodMainRepo.absoluteString, data: mp3A)
        zeroDurEp["durationSeconds"] = 0
        try await expectThrows("durationSeconds == 0 must fail closed") {
            _ = try PodcastPlayerService.parseFeed(try makeFeedJSON(episodes: [zeroDurEp]))
        }

        var wrongMimeEp = episodeDict(id: "ep-bad-mime", date: "2026-11-24", title: "Bad Mime", audioUrl: goodMainRepo.absoluteString, data: mp3A)
        wrongMimeEp["mimeType"] = "audio/mp3"
        try await expectThrows("mimeType audio/mp3 must fail closed (audio/mpeg only)") {
            _ = try PodcastPlayerService.parseFeed(try makeFeedJSON(episodes: [wrongMimeEp]))
        }

        var floatBytesEp = episodeDict(id: "ep-float-bytes", date: "2026-11-24", title: "Float Bytes", audioUrl: goodMainRepo.absoluteString, data: mp3A)
        floatBytesEp["bytes"] = 512.5
        try await expectThrows("float bytes must fail closed") {
            _ = try PodcastPlayerService.parseFeed(try makeFeedJSON(episodes: [floatBytesEp]))
        }

        var extraEpKey = episodeDict(id: "ep-extra", date: "2026-11-24", title: "Extra Key", audioUrl: goodMainRepo.absoluteString, data: mp3A)
        extraEpKey["rogueField"] = 123
        try await expectThrows("unexpected episode key must fail closed") {
            _ = try PodcastPlayerService.parseFeed(try makeFeedJSON(episodes: [extraEpKey]))
        }

        try await expectThrows("negative startSeconds in play must be rejected") {
            _ = try await service.play(episodeId: "ep-a", startSeconds: -5.0)
        }

        // #6: streamVerifyAudioFile rejects symlink
        let realMP3 = root.appendingPathComponent("real.mp3")
        try mp3A.write(to: realMP3)
        let symMP3 = root.appendingPathComponent("sym.mp3")
        try FileManager.default.createSymbolicLink(at: symMP3, withDestinationURL: realMP3)
        try PodcastPlayerService.streamVerifyAudioFile(at: realMP3, expectedBytes: mp3A.count, expectedSHA256: PodcastPlayerService.sha256Hex(mp3A))
        try await expectThrows("streamVerifyAudioFile rejects symlinks") {
            try PodcastPlayerService.streamVerifyAudioFile(at: symMP3, expectedBytes: mp3A.count, expectedSHA256: PodcastPlayerService.sha256Hex(mp3A))
        }

        // CL-P1-6: re-published episode with same ID and new SHA-256 must NOT be marked cached
        let repubTransport = PodcastFixtureTransport()
        let repubDir = root.appendingPathComponent("RepublishedSHA", isDirectory: true)
        let repubService = try PodcastPlayerService(
            cacheDirectory: repubDir,
            siteBaseURL: base,
            feedTransport: { url, limit in try await repubTransport.fetchFeed(url, limit) },
            audioTransport: { url, limit in try await repubTransport.fetchAudio(url, limit) },
            enableMediaCenter: false
        )
        let mp3V1 = makeMP3Data(seed: 55, size: 320)
        let mp3V2 = makeMP3Data(seed: 88, size: 320)
        let repubURL = "https://github.com/nanless/audio-paper-digest-blog/releases/download/v1.5/repub.mp3"
        await repubTransport.setFeed(status: 200, data: try makeFeedJSON(episodes: [
            episodeDict(id: "ep-repub", date: "2026-11-25", title: "Repub V1", audioUrl: repubURL, data: mp3V1)
        ]))
        await repubTransport.setAudio(repubURL, status: 200, data: mp3V1)
        _ = try await repubService.fetchFeed(forceRefresh: true)
        _ = try await repubService.downloadEpisode(id: "ep-repub")
        let stateV1 = await repubService.stateSnapshot()
        try check((stateV1["cachedEpisodeIds"] as? [String]) == ["ep-repub"], "V1 episode is marked cached after download")
        try check(((stateV1["episodes"] as? [[String: Any]])?.first?["cached"] as? Bool) == true, "V1 serialized episode has cached=true")

        // Feed re-publishes ep-repub with new audio bytes & SHA-256
        await repubTransport.setFeed(status: 200, data: try makeFeedJSON(episodes: [
            episodeDict(id: "ep-repub", date: "2026-11-25", title: "Repub V2", audioUrl: repubURL, data: mp3V2)
        ]))
        let stateV2 = try await repubService.fetchFeed(forceRefresh: true)
        try check(((stateV2["cachedEpisodeIds"] as? [String]) ?? []).isEmpty, "re-published episode with new sha256 must NOT appear in cachedEpisodeIds")
        try check(((stateV2["episodes"] as? [[String: Any]])?.first?["cached"] as? Bool) == false, "re-published episode with new sha256 must serialize cached=false")
        await repubService.shutdown()

        // 11. Round-5 P1: PodcastPlayerService.play() actor reentrancy across installRemoteCommandsIfNeeded suspension
        // Must NOT kill newly switched playback or paused playback when an older play() resumes from suspension.
        func makePlayableSilentMP3(seed: UInt8) -> Data {
            // 20 valid MPEG-1 Layer III 128 kbps 44.1 kHz stereo silent frames (417 bytes each, ~0.52s)
            // plus a valid ID3v2.3 tag so different episodes have distinct SHA-256 while AVAudioPlayer plays cleanly.
            let frameHeader: [UInt8] = [0xFF, 0xFB, 0x90, 0x00]
            let singleFrame = frameHeader + [UInt8](repeating: 0x00, count: 413)
            var tagPayload = [UInt8](repeating: 0x00, count: 16)
            tagPayload[0] = seed
            var data = Data([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10])
            data.append(contentsOf: tagPayload)
            for _ in 0..<20 { data.append(contentsOf: singleFrame) }
            return data
        }
        actor PlayGate {
            private var hitA: CheckedContinuation<Void, Never>?
            private var releaseA: CheckedContinuation<Void, Never>?
            private var armed = true
            private var entered = false
            func waitUntilEntered() async {
                if entered { return }
                await withCheckedContinuation { hitA = $0 }
            }
            func onHook() async {
                guard armed else { return }
                armed = false
                entered = true
                hitA?.resume(); hitA = nil
                await withCheckedContinuation { releaseA = $0 }
            }
            func release() {
                releaseA?.resume(); releaseA = nil
            }
        }
        let reentTransport = PodcastFixtureTransport()
        let reentDir = root.appendingPathComponent("ReentrancyPlay", isDirectory: true)
        let reentService = try PodcastPlayerService(
            cacheDirectory: reentDir,
            siteBaseURL: base,
            feedTransport: { url, limit in try await reentTransport.fetchFeed(url, limit) },
            audioTransport: { url, limit in try await reentTransport.fetchAudio(url, limit) },
            enableMediaCenter: false
        )
        let playableA = makePlayableSilentMP3(seed: 0x41)
        let playableB = makePlayableSilentMP3(seed: 0x42)
        let urlPlayA = "https://github.com/nanless/audio-paper-digest-blog/releases/download/v1.5/play-a.mp3"
        let urlPlayB = "https://github.com/nanless/audio-paper-digest-blog/releases/download/v1.5/play-b.mp3"
        await reentTransport.setFeed(status: 200, data: try makeFeedJSON(episodes: [
            episodeDict(id: "ep-play-a", date: "2026-11-26", title: "Play A", audioUrl: urlPlayA, data: playableA),
            episodeDict(id: "ep-play-b", date: "2026-11-25", title: "Play B", audioUrl: urlPlayB, data: playableB)
        ]))
        await reentTransport.setAudio(urlPlayA, status: 200, data: playableA)
        await reentTransport.setAudio(urlPlayB, status: 200, data: playableB)
        _ = try await reentService.fetchFeed(forceRefresh: true)
        // Pre-cache both so play() hits installRemoteCommandsIfNeeded directly without download latency.
        _ = try await reentService.downloadEpisode(id: "ep-play-a")
        _ = try await reentService.downloadEpisode(id: "ep-play-b")

        // Case A: Task 1 suspends inside installRemoteCommandsIfNeeded() for ep-play-a;
        // Task 2 switches to ep-play-b and starts playing; Task 1 resumes and MUST NOT kill ep-play-b!
        let gateSwitch = PlayGate()
        await reentService.setInstallRemoteCommandsHook { await gateSwitch.onHook() }
        let taskPlayA = Task { try await reentService.play(episodeId: "ep-play-a") }
        await gateSwitch.waitUntilEntered()
        let stateB = try await reentService.play(episodeId: "ep-play-b")
        try check((stateB["activeEpisodeId"] as? String) == "ep-play-b" && (stateB["isPlaying"] as? Bool) == true, "ep-play-b starts playing while ep-play-a is suspended")
        await gateSwitch.release()
        var staleCancelled = false
        do { _ = try await taskPlayA.value } catch is CancellationError { staleCancelled = true }
        try check(staleCancelled, "stale play(ep-play-a) throws CancellationError after reentrancy")
        let afterSwitch = await reentService.stateSnapshot()
        try check((afterSwitch["activeEpisodeId"] as? String) == "ep-play-b" && (afterSwitch["isPlaying"] as? Bool) == true, "stale play(ep-play-a) must NOT kill newly switched ep-play-b")

        // Case B: ep-play-b is paused while stale play(ep-play-a) is suspended inside installRemoteCommandsIfNeeded();
        // releasing stale play(ep-play-a) MUST NOT clear the paused ep-play-b state!
        let pausedB = await reentService.pause()
        try check((pausedB["activeEpisodeId"] as? String) == "ep-play-b" && (pausedB["isPlaying"] as? Bool) == false, "ep-play-b is paused")
        let gatePause = PlayGate()
        await reentService.setInstallRemoteCommandsHook { await gatePause.onHook() }
        let taskPlayA2 = Task { try await reentService.play(episodeId: "ep-play-a") }
        await gatePause.waitUntilEntered()
        _ = await reentService.pause()
        await gatePause.release()
        var stalePauseCancelled = false
        do { _ = try await taskPlayA2.value } catch is CancellationError { stalePauseCancelled = true }
        try check(stalePauseCancelled, "stale play(ep-play-a) throws CancellationError when paused mid-suspension")
        let afterPause = await reentService.stateSnapshot()
        try check((afterPause["activeEpisodeId"] as? String) == "ep-play-b" && (afterPause["isPlaying"] as? Bool) == false, "stale play(ep-play-a) must NOT destroy paused ep-play-b playback")
        await reentService.setInstallRemoteCommandsHook(nil)
        await reentService.shutdown()

        print("PodcastPlayerServiceTests: ALL CHECKS PASSED")
    }
}
