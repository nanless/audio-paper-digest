import Foundation
import AVFoundation
import CoreFoundation
import CryptoKit
import Darwin
import MediaPlayer

private final class PodcastRedirectBlocker: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

private final class PodcastTransferCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var task: URLSessionTask?
    private var process: Process?

    func install(_ value: URLSessionTask) {
        lock.lock()
        defer { lock.unlock() }
        task = value
        if cancelled { value.cancel() }
    }

    func start(_ value: Process) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !cancelled else { throw CancellationError() }
        process = value
        try value.run()
    }

    func cancel() {
        lock.lock()
        defer { lock.unlock() }
        cancelled = true
        task?.cancel()
        if let process, process.isRunning {
            process.terminate()
        }
    }
}

@MainActor private final class PodcastRemoteCommandRegistry {
    private var targets: [(MPRemoteCommand, Any)] = []

    func install(service: PodcastPlayerService) {
        guard targets.isEmpty else { return }
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.isEnabled = true
        let playToken = center.playCommand.addTarget { [weak service] _ in
            guard let service else { return .commandFailed }
            Task { _ = try? await service.play(episodeId: nil) }
            return .success
        }
        center.pauseCommand.isEnabled = true
        let pauseToken = center.pauseCommand.addTarget { [weak service] _ in
            guard let service else { return .commandFailed }
            Task { _ = await service.pause() }
            return .success
        }
        center.changePlaybackPositionCommand.isEnabled = true
        let posToken = center.changePlaybackPositionCommand.addTarget { [weak service] event in
            guard let service, let posEvent = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            Task { _ = try? await service.seek(seconds: posEvent.positionTime) }
            return .success
        }
        targets = [
            (center.playCommand, playToken),
            (center.pauseCommand, pauseToken),
            (center.changePlaybackPositionCommand, posToken)
        ]
    }

    func removeAllAndClearNowPlaying() {
        for (cmd, token) in targets {
            cmd.removeTarget(token)
        }
        targets.removeAll()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
}

/// Native daily audio podcast downloader, verified LRU cache, and AVFoundation player.
/// Audio fetching and playback run 100% natively (never via WebView); cached MP3 files live
/// in a backup-excluded cache directory outside Application Support / WebDAV.
actor PodcastPlayerService {
    static let maxFeedBytes = 2 * 1024 * 1024
    static let maxAudioBytes = 40 * 1024 * 1024
    static let maxRedirects = 4
    static let maxEpisodes = 120
    static let maxCacheBytes = 150 * 1024 * 1024
    static let maxCachedEpisodes = 5
    static let allowedRates: [Double] = [0.75, 1.0, 1.25, 1.5, 2.0]
    static let allowedRedirectHosts: Set<String> = [
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com"
    ]
    private static let allowedRootKeys: Set<String> = [
        "contract", "schemaFingerprint", "generatedAt", "episodes"
    ]
    private static let allowedEpisodeKeys: Set<String> = [
        "id", "date", "title", "summary", "audioUrl", "bytes", "sha256",
        "durationSeconds", "mimeType", "chapters", "paperIds"
    ]
    private static let allowedChapterKeys: Set<String> = [
        "title", "startSeconds", "endSeconds", "paperId"
    ]

    enum PodcastError: LocalizedError, Equatable {
        case invalid(String)
        case unavailable(String)
        case network(String)
        case httpStatus(Int)

        var errorDescription: String? {
            switch self {
            case .invalid(let s), .unavailable(let s), .network(let s): return s
            case .httpStatus(let code): return "播客资源返回 HTTP \(code)，未覆盖已保存缓存。"
            }
        }
    }

    struct Chapter: Codable, Sendable, Equatable {
        let title: String
        let startSeconds: Double
        let endSeconds: Double?
        let paperId: String?

        func dictionary() -> [String: Any] {
            var dict: [String: Any] = ["title": title, "startSeconds": startSeconds]
            if let endSeconds { dict["endSeconds"] = endSeconds }
            if let paperId, !paperId.isEmpty { dict["paperId"] = paperId }
            return dict
        }
    }

    struct Episode: Codable, Sendable, Equatable {
        let id: String
        let date: String
        let title: String
        let summary: String
        let audioUrl: String
        let bytes: Int
        let sha256: String
        let durationSeconds: Double
        let mimeType: String
        let chapters: [Chapter]
        let paperIds: [String]

        func dictionary(cached: Bool) -> [String: Any] {
            [
                "id": id,
                "date": date,
                "title": title,
                "summary": summary,
                "audioUrl": audioUrl,
                "bytes": bytes,
                "sha256": sha256,
                "durationSeconds": durationSeconds,
                "mimeType": mimeType,
                "chapters": chapters.map { $0.dictionary() },
                "paperIds": paperIds,
                "cached": cached
            ]
        }
    }

    struct Feed: Codable, Sendable, Equatable {
        let generatedAt: String
        let episodes: [Episode]
    }

    struct CacheEntry: Codable, Sendable, Equatable {
        var sha256: String
        var episodeId: String
        var bytes: Int
        var lastAccessedAt: Double
    }

    struct CacheIndex: Codable, Sendable, Equatable {
        var entries: [CacheEntry]
    }

    typealias FeedTransport = @Sendable (URL, Int) async throws -> (statusCode: Int, data: Data)
    typealias AudioTransport = @Sendable (URL, Int) async throws -> (statusCode: Int, headers: [String: String], data: Data)

    nonisolated let cacheDirectory: URL
    nonisolated let episodesDirectory: URL
    nonisolated let siteBaseURL: URL
    private let feedTransportOverride: FeedTransport?
    private let audioTransportOverride: AudioTransport?
    private let enableMediaCenter: Bool
    private let maxCacheBytesLimit: Int
    private let maxCachedEpisodesLimit: Int

    private var httpProxy: URL?
    private var feed: Feed?
    private var feedAvailable: Bool = false
    private var lastError: String?
    private var cacheIndex: CacheIndex = CacheIndex(entries: [])
    private var activeEpisodeId: String?
    private var downloadingEpisodeId: String?
    private var isPlaying: Bool = false
    private var currentTime: Double = 0
    private var duration: Double = 0
    private var rate: Double = 1.0
    private var player: AVAudioPlayer?
    private var progressTask: Task<Void, Never>?
    private var playbackGeneration: UInt64 = 0
    private var activeDownloadTask: Task<URL, Error>?
    private var activeDownloadId: UUID?
    private var onStateChange: (@Sendable ([String: Any]) -> Void)?
    private var remoteCommandsInstalled = false
    private var remoteRegistry: PodcastRemoteCommandRegistry?
    private var isShutDown = false
    private static let dnsQueue = DispatchQueue(
        label: "com.nanless.PaperDigest.dns.podcast",
        qos: .userInitiated,
        attributes: .concurrent
    )

    init(
        cacheDirectory: URL,
        siteBaseURL: URL = URL(string: "https://nanless.github.io/audio-research-portal/")!,
        feedTransport: FeedTransport? = nil,
        audioTransport: AudioTransport? = nil,
        enableMediaCenter: Bool = true,
        maxCacheBytes: Int = PodcastPlayerService.maxCacheBytes,
        maxCachedEpisodes: Int = PodcastPlayerService.maxCachedEpisodes
    ) throws {
        guard siteBaseURL.scheme == "https", siteBaseURL.host != nil,
              siteBaseURL.user == nil, siteBaseURL.password == nil,
              siteBaseURL.query == nil, siteBaseURL.fragment == nil,
              siteBaseURL.absoluteString.hasSuffix("/") else {
            throw PodcastError.invalid("播客站点地址必须为不含凭据的 HTTPS 目录。")
        }
        self.cacheDirectory = cacheDirectory.standardizedFileURL
        self.episodesDirectory = self.cacheDirectory.appendingPathComponent("episodes", isDirectory: true)
        self.siteBaseURL = siteBaseURL
        self.feedTransportOverride = feedTransport
        self.audioTransportOverride = audioTransport
        self.enableMediaCenter = enableMediaCenter
        self.maxCacheBytesLimit = maxCacheBytes
        self.maxCachedEpisodesLimit = maxCachedEpisodes

        try FileManager.default.createDirectory(at: self.episodesDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        var mutableRoot = self.cacheDirectory
        try? mutableRoot.setResourceValues(excluded)

        self.cacheIndex = Self.loadCacheIndex(at: self.cacheDirectory)
        if let savedFeed = Self.loadCachedFeed(at: self.cacheDirectory) {
            self.feed = savedFeed
            self.feedAvailable = !savedFeed.episodes.isEmpty
        }
    }

    func setStateObserver(_ observer: (@Sendable ([String: Any]) -> Void)?) {
        self.onStateChange = observer
    }

    func configureProxy(_ raw: String?) {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty,
              let url = URL(string: trimmed), url.scheme == "http", url.host != nil, url.port != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            self.httpProxy = nil
            return
        }
        self.httpProxy = url
    }

    // MARK: - Static Validation Helpers

    static func isValidInitialAudioURL(_ url: URL) -> Bool {
        guard url.scheme == "https",
              url.host?.lowercased() == "github.com",
              url.port == nil || url.port == 443,
              url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return false
        }
        let encodedPath = components.percentEncodedPath
        guard !encodedPath.contains("%"), !encodedPath.contains("\\"),
              !encodedPath.contains("//"), !encodedPath.contains("..") else {
            return false
        }
        let pattern = #"\Ahttps://github\.com/nanless/(?:audio-paper-digest|audio-paper-digest-blog|audio-research-workbench|audio-research-portal)/releases/download/[A-Za-z0-9._-]{1,128}/[A-Za-z0-9._-]{1,128}\.mp3\z"#
        return url.absoluteString.range(of: pattern, options: .regularExpression) != nil
    }

    static func isValidRedirectAudioURL(_ url: URL) -> Bool {
        guard url.scheme == "https",
              let host = url.host?.lowercased(),
              allowedRedirectHosts.contains(host),
              url.port == nil || url.port == 443,
              url.user == nil, url.password == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return false
        }
        if host == "github.com" {
            return isValidInitialAudioURL(url)
        }
        let rawPath = components.percentEncodedPath
        let lowerRaw = rawPath.lowercased()
        let decodedPath = url.path
        guard !rawPath.isEmpty, !decodedPath.isEmpty,
              !rawPath.contains(".."), !decodedPath.contains(".."),
              !rawPath.contains("\\"), !decodedPath.contains("\\"),
              !lowerRaw.contains("%2e"), !lowerRaw.contains("%5c"), !lowerRaw.contains("%00"),
              !decodedPath.contains("\0") else {
            return false
        }
        return true
    }

    static func isValidMP3Magic(_ data: Data) -> Bool {
        guard data.count >= 4 else { return false }
        // ID3v2 header: "ID3" + version (<0xFF) + flags + 4 synchsafe size bytes
        if data.count >= 10,
           data[0] == 0x49, data[1] == 0x44, data[2] == 0x33,
           data[3] < 0xFF, data[4] < 0xFF,
           (data[6] & 0x80) == 0, (data[7] & 0x80) == 0,
           (data[8] & 0x80) == 0, (data[9] & 0x80) == 0 {
            return true
        }
        // Raw MPEG audio frame sync: 11 sync bits (0xFF, 0xE0..0xFF), valid version/layer/bitrate/samplerate
        let b0 = data[0], b1 = data[1], b2 = data[2]
        guard b0 == 0xFF, (b1 & 0xE0) == 0xE0 else { return false }
        let version = (b1 >> 3) & 0x03
        let layer = (b1 >> 1) & 0x03
        let bitrate = (b2 >> 4) & 0x0F
        let sampleRate = (b2 >> 2) & 0x03
        return version != 0x01 && layer != 0x00 && bitrate != 0x0F && sampleRate != 0x03
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func isValidSHA256(_ value: String) -> Bool {
        value.range(of: #"\A[a-f0-9]{64}\z"#, options: .regularExpression) != nil
    }

    static func isValidDate(_ value: String) -> Bool {
        guard value.range(of: #"\A\d{4}-\d{2}-\d{2}\z"#, options: .regularExpression) != nil else {
            return false
        }
        let parts = value.split(separator: "-")
        guard parts.count == 3,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
              (1970...9999).contains(y), (1...12).contains(m), (1...31).contains(d) else {
            return false
        }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let comps = DateComponents(year: y, month: m, day: d)
        guard let date = cal.date(from: comps) else { return false }
        let roundTrip = cal.dateComponents([.year, .month, .day], from: date)
        return roundTrip.year == y && roundTrip.month == m && roundTrip.day == d
    }

    /// Parses ONLY the last non-empty HTTP header block so HTTP CONNECT proxy preambles are ignored.
    static func parseFinalHTTPHeaderBlock(_ raw: String) -> [String: String] {
        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n")
        let blocks = normalized
            .components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard let finalBlock = blocks.last else { return [:] }
        var headers: [String: String] = [:]
        for line in finalBlock.components(separatedBy: "\n") {
            if line.hasPrefix("HTTP/") { continue }
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colon]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let val = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty { headers[key] = val }
        }
        return headers
    }

    /// Stream-verifies a regular file on disk in 64 KiB chunks (no 40 MiB RAM allocation).
    static func streamVerifyAudioFile(at fileURL: URL, expectedBytes: Int, expectedSHA256: String) throws {
        var info = stat()
        guard lstat(fileURL.path, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFREG else {
            throw PodcastError.invalid("播客缓存文件不是有效普通文件。")
        }
        guard expectedBytes >= 1, expectedBytes <= maxAudioBytes,
              info.st_size == Int64(expectedBytes) else {
            throw PodcastError.invalid("播客音频实际字节数与清单声明不符（期望 \(expectedBytes)，实际 \(info.st_size)）。")
        }
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        var hasher = SHA256()
        var magicPrefix = Data()
        magicPrefix.reserveCapacity(10)
        var totalRead = 0
        while true {
            guard let chunk = try handle.read(upToCount: 65_536), !chunk.isEmpty else { break }
            totalRead += chunk.count
            guard totalRead <= expectedBytes, totalRead <= maxAudioBytes else {
                throw PodcastError.invalid("播客音频文件超过声明大小上限。")
            }
            if magicPrefix.count < 10 {
                let need = min(10 - magicPrefix.count, chunk.count)
                magicPrefix.append(chunk.prefix(need))
            }
            hasher.update(data: chunk)
        }
        guard totalRead == expectedBytes else {
            throw PodcastError.invalid("播客音频实际读取字节数不完整（期望 \(expectedBytes)，实际 \(totalRead)）。")
        }
        let actualSHA = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard actualSHA == expectedSHA256 else {
            throw PodcastError.invalid("播客音频 SHA-256 校验失败，已拒绝播放并丢弃下载文件。")
        }
        guard isValidMP3Magic(magicPrefix) else {
            throw PodcastError.invalid("播客下载内容不是有效 MP3 音频文件头，已拒绝缓存。")
        }
    }

    static func parseFeed(_ data: Data) throws -> Feed {
        guard data.count <= maxFeedBytes else {
            throw PodcastError.invalid("播客订阅清单超过 2 MiB 上限。")
        }
        guard String(data: data, encoding: .utf8) != nil,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PodcastError.invalid("播客订阅清单不是有效 UTF-8 JSON 对象。")
        }
        guard ClientProtocols.hasValidHeader(obj, "paper-daily-podcast-feed") else {
            throw PodcastError.invalid("播客订阅清单协议头或 schemaFingerprint 无效。")
        }
        guard Set(obj.keys).isSubset(of: allowedRootKeys) else {
            throw PodcastError.invalid("播客订阅清单包含未声明字段。")
        }
        guard let generatedAt = obj["generatedAt"] as? String, !generatedAt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let rawEpisodes = obj["episodes"] as? [Any],
              rawEpisodes.count <= maxEpisodes else {
            throw PodcastError.invalid("播客订阅清单缺少有效 episodes 列表或数量超限。")
        }
        var seenIDs = Set<String>()
        var episodes: [Episode] = []
        episodes.reserveCapacity(rawEpisodes.count)
        for rawItem in rawEpisodes {
            guard let row = rawItem as? [String: Any],
                  Set(row.keys).isSubset(of: allowedEpisodeKeys) else {
                throw PodcastError.invalid("播客节目条目格式无效或包含未声明字段。")
            }
            guard let id = row["id"] as? String,
                  id.range(of: #"\A[A-Za-z0-9._:-]{1,128}\z"#, options: .regularExpression) != nil,
                  seenIDs.insert(id).inserted else {
                throw PodcastError.invalid("播客节目编号无效或重复。")
            }
            guard let date = row["date"] as? String, isValidDate(date) else {
                throw PodcastError.invalid("播客节目日期格式或日历日期无效：\(id)")
            }
            guard let title = (row["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !title.isEmpty else {
                throw PodcastError.invalid("播客节目标题为空：\(id)")
            }
            let summary: String
            if let rawSummary = row["summary"], !(rawSummary is NSNull) {
                guard let s = rawSummary as? String else {
                    throw PodcastError.invalid("播客节目摘要字段类型无效：\(id)")
                }
                summary = s.trimmingCharacters(in: .whitespacesAndNewlines)
            } else {
                summary = ""
            }
            guard let audioUrlStr = row["audioUrl"] as? String,
                  let audioURL = URL(string: audioUrlStr),
                  isValidInitialAudioURL(audioURL) else {
                throw PodcastError.invalid("播客音频地址不在受控 GitHub Release HTTPS 白名单内：\(id)")
            }
            guard let bytesNum = row["bytes"] as? NSNumber,
                  CFGetTypeID(bytesNum) != CFBooleanGetTypeID(),
                  !CFNumberIsFloatType(bytesNum),
                  let bytes = bytesNum as? Int,
                  Double(bytes) == bytesNum.doubleValue,
                  bytes >= 1, bytes <= maxAudioBytes else {
                throw PodcastError.invalid("播客音频声明大小必须为 1..\(maxAudioBytes) 的整数：\(id)")
            }
            guard let sha = row["sha256"] as? String, isValidSHA256(sha) else {
                throw PodcastError.invalid("播客音频 SHA-256 无效：\(id)")
            }
            guard let durNum = row["durationSeconds"] as? NSNumber,
                  CFGetTypeID(durNum) != CFBooleanGetTypeID() else {
                throw PodcastError.invalid("播客节目时长无效：\(id)")
            }
            let durationVal = durNum.doubleValue
            guard durationVal.isFinite, durationVal > 0, durationVal <= 86400 else {
                throw PodcastError.invalid("播客节目时长必须大于 0 且不超过 86400 秒：\(id)")
            }
            guard let rawMime = row["mimeType"] as? String,
                  rawMime == "audio/mpeg" else {
                throw PodcastError.invalid("播客仅支持标准 audio/mpeg 格式：\(id)")
            }
            var chapters: [Chapter] = []
            if let rawChapters = row["chapters"], !(rawChapters is NSNull) {
                guard let chapterList = rawChapters as? [Any] else {
                    throw PodcastError.invalid("播客章节列表格式无效：\(id)")
                }
                for rawCh in chapterList {
                    guard let ch = rawCh as? [String: Any],
                          Set(ch.keys).isSubset(of: allowedChapterKeys),
                          let chTitle = (ch["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                          !chTitle.isEmpty,
                          let startNum = ch["startSeconds"] as? NSNumber,
                          CFGetTypeID(startNum) != CFBooleanGetTypeID(),
                          startNum.doubleValue.isFinite, startNum.doubleValue >= 0 else {
                        throw PodcastError.invalid("播客章节字段无效或包含未声明字段：\(id)")
                    }
                    var endVal: Double? = nil
                    if let rawEnd = ch["endSeconds"], !(rawEnd is NSNull) {
                        guard let endNum = rawEnd as? NSNumber,
                              CFGetTypeID(endNum) != CFBooleanGetTypeID(),
                              endNum.doubleValue.isFinite, endNum.doubleValue >= startNum.doubleValue else {
                            throw PodcastError.invalid("播客章节结束时间无效：\(id)")
                        }
                        endVal = endNum.doubleValue
                    }
                    var paperId: String? = nil
                    if let rawPid = ch["paperId"], !(rawPid is NSNull) {
                        guard let pidStr = rawPid as? String else {
                            throw PodcastError.invalid("播客章节论文编号类型无效：\(id)")
                        }
                        let trimmed = pidStr.trimmingCharacters(in: .whitespacesAndNewlines)
                        paperId = trimmed.isEmpty ? nil : trimmed
                    }
                    chapters.append(Chapter(title: chTitle, startSeconds: startNum.doubleValue, endSeconds: endVal, paperId: paperId))
                }
            }
            var paperIds: [String] = []
            if let rawPids = row["paperIds"], !(rawPids is NSNull) {
                guard let pidList = rawPids as? [Any] else {
                    throw PodcastError.invalid("播客论文列表格式无效：\(id)")
                }
                for item in pidList {
                    guard let s = item as? String else {
                        throw PodcastError.invalid("播客论文编号必须为字符串：\(id)")
                    }
                    let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty { paperIds.append(trimmed) }
                }
            }
            episodes.append(Episode(
                id: id,
                date: date,
                title: title,
                summary: summary,
                audioUrl: audioUrlStr,
                bytes: bytes,
                sha256: sha,
                durationSeconds: durationVal,
                mimeType: rawMime,
                chapters: chapters,
                paperIds: paperIds
            ))
        }
        episodes.sort { a, b in
            if a.date != b.date { return a.date > b.date }
            return a.id > b.id
        }
        return Feed(generatedAt: generatedAt, episodes: episodes)
    }

    // MARK: - Feed Loading (404/410 silent-graceful, 200 fail-closed)

    func fetchFeed(forceRefresh: Bool = false) async throws -> [String: Any] {
        if !forceRefresh, let existing = feed {
            return stateSnapshot(extra: ["available": feedAvailable, "episodes": serializedEpisodes(existing.episodes)])
        }
        let feedURL = try LibraryService.sameSiteURL("client/podcast/feed.json", siteBaseURL: siteBaseURL)
        do {
            let (status, data) = try await fetchFeedBytes(feedURL, limit: Self.maxFeedBytes)
            if status == 404 || status == 410 {
                self.feed = nil
                self.feedAvailable = false
                self.lastError = nil
                try? FileManager.default.removeItem(at: cacheDirectory.appendingPathComponent("feed.json"))
                notifyState()
                return stateSnapshot(extra: ["available": false, "episodes": [[String: Any]]()])
            }
            guard status == 200 else {
                throw PodcastError.httpStatus(status)
            }
            let parsed = try Self.parseFeed(data)
            try atomicWrite(data, to: cacheDirectory.appendingPathComponent("feed.json"))
            self.feed = parsed
            self.feedAvailable = !parsed.episodes.isEmpty
            self.lastError = nil
            notifyState()
            return stateSnapshot(extra: ["available": feedAvailable, "episodes": serializedEpisodes(parsed.episodes)])
        } catch {
            self.lastError = error.localizedDescription
            notifyState()
            throw error
        }
    }

    // MARK: - Download & Verified LRU Cache

    func episodeFileURL(sha256: String) -> URL {
        episodesDirectory.appendingPathComponent("\(sha256).mp3")
    }

    func verifiedCachedAudioURL(for episode: Episode) -> URL? {
        guard Self.isValidSHA256(episode.sha256) else { return nil }
        let target = episodeFileURL(sha256: episode.sha256)
        do {
            try Self.streamVerifyAudioFile(at: target, expectedBytes: episode.bytes, expectedSHA256: episode.sha256)
            touchCacheEntry(sha256: episode.sha256, episodeId: episode.id, bytes: episode.bytes)
            return target
        } catch {
            if FileManager.default.fileExists(atPath: target.path) {
                try? FileManager.default.removeItem(at: target)
            }
            cacheIndex.entries.removeAll { $0.sha256 == episode.sha256 }
            saveCacheIndex()
            return nil
        }
    }

    func downloadEpisode(id: String) async throws -> URL {
        guard let episode = feed?.episodes.first(where: { $0.id == id }) else {
            throw PodcastError.unavailable("未找到指定的播客节目：\(id)")
        }
        if let cached = verifiedCachedAudioURL(for: episode) {
            notifyState()
            return cached
        }
        activeDownloadTask?.cancel()
        let downloadID = UUID()
        activeDownloadId = downloadID
        downloadingEpisodeId = episode.id
        lastError = nil
        notifyState()

        let task = Task<URL, Error> {
            try await self.performVerifiedDownload(episode: episode)
        }
        activeDownloadTask = task
        defer {
            if activeDownloadId == downloadID {
                activeDownloadTask = nil
                activeDownloadId = nil
                if downloadingEpisodeId == episode.id {
                    downloadingEpisodeId = nil
                }
            }
            notifyState()
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func performVerifiedDownload(episode: Episode) async throws -> URL {
        guard let initialURL = URL(string: episode.audioUrl),
              Self.isValidInitialAudioURL(initialURL),
              Self.isValidSHA256(episode.sha256) else {
            throw PodcastError.invalid("播客音频地址未通过 GitHub Release HTTPS 校验。")
        }
        let tempDir = cacheDirectory.appendingPathComponent("download-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let downloadedFile = try await fetchVerifiedReleaseAudioFile(
            initialURL: initialURL,
            expectedBytes: episode.bytes,
            tempDir: tempDir
        )
        try Task.checkCancellation()
        try Self.streamVerifyAudioFile(at: downloadedFile, expectedBytes: episode.bytes, expectedSHA256: episode.sha256)

        let target = episodeFileURL(sha256: episode.sha256)
        try moveFileAtomically(from: downloadedFile, to: target)
        touchCacheEntry(sha256: episode.sha256, episodeId: episode.id, bytes: episode.bytes)
        evictCacheIfNeeded(protectSHA: episode.sha256)
        return target
    }

    private func fetchVerifiedReleaseAudioFile(initialURL: URL, expectedBytes: Int, tempDir: URL) async throws -> URL {
        var currentURL = initialURL
        let limit = min(Self.maxAudioBytes, max(expectedBytes, 1))
        for hop in 0...Self.maxRedirects {
            try Task.checkCancellation()
            if hop == 0 {
                guard Self.isValidInitialAudioURL(currentURL) else {
                    throw PodcastError.invalid("播客初始音频链接不在受控仓库 Release 白名单内。")
                }
            } else {
                guard Self.isValidRedirectAudioURL(currentURL) else {
                    throw PodcastError.invalid("播客音频重定向地址超出允许域名范围。")
                }
            }
            let hopBody = tempDir.appendingPathComponent("hop-\(hop).body")
            let (status, headers) = try await fetchAudioHopToFile(currentURL, outputFile: hopBody, limit: Self.maxAudioBytes)
            if [301, 302, 303, 307, 308].contains(status) {
                try? FileManager.default.removeItem(at: hopBody)
                guard hop < Self.maxRedirects else {
                    throw PodcastError.network("播客音频重定向超过最大 4 次上限。")
                }
                let locKey = headers.keys.first { $0.lowercased() == "location" }
                guard let locVal = locKey.flatMap({ headers[$0] })?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !locVal.isEmpty,
                      let nextURL = URL(string: locVal, relativeTo: currentURL)?.absoluteURL,
                      Self.isValidRedirectAudioURL(nextURL) else {
                    throw PodcastError.invalid("播客音频重定向目标地址无效或不受信任。")
                }
                currentURL = nextURL
                continue
            }
            guard status == 200 else {
                throw PodcastError.httpStatus(status)
            }
            let attrs = try FileManager.default.attributesOfItem(atPath: hopBody.path)
            let fileSize = (attrs[.size] as? NSNumber)?.int64Value ?? -1
            guard fileSize >= 1, fileSize <= Int64(Self.maxAudioBytes), fileSize <= Int64(limit) else {
                throw PodcastError.invalid("播客音频响应超过允许大小上限。")
            }
            return hopBody
        }
        throw PodcastError.network("播客音频重定向过多。")
    }

    private func touchCacheEntry(sha256: String, episodeId: String, bytes: Int) {
        let now = Date().timeIntervalSince1970
        if let idx = cacheIndex.entries.firstIndex(where: { $0.sha256 == sha256 }) {
            cacheIndex.entries[idx].lastAccessedAt = now
            cacheIndex.entries[idx].episodeId = episodeId
            cacheIndex.entries[idx].bytes = bytes
        } else {
            cacheIndex.entries.append(CacheEntry(sha256: sha256, episodeId: episodeId, bytes: bytes, lastAccessedAt: now))
        }
        saveCacheIndex()
    }

    private func evictCacheIfNeeded(protectSHA: String?) {
        let playingSHA = activeEpisodeId.flatMap { id in feed?.episodes.first(where: { $0.id == id })?.sha256 }
        let protected = Set([protectSHA, playingSHA].compactMap { $0 })
        cacheIndex.entries.removeAll { entry in
            !Self.isValidSHA256(entry.sha256) || !FileManager.default.fileExists(atPath: episodeFileURL(sha256: entry.sha256).path)
        }
        var totalBytes = cacheIndex.entries.reduce(0) { $0 + $1.bytes }
        while cacheIndex.entries.count > maxCachedEpisodesLimit || totalBytes > maxCacheBytesLimit {
            let candidates = cacheIndex.entries
                .enumerated()
                .filter { !protected.contains($0.element.sha256) }
                .sorted { $0.element.lastAccessedAt < $1.element.lastAccessedAt }
            guard let victim = candidates.first else { break }
            let removed = cacheIndex.entries.remove(at: victim.offset)
            totalBytes -= removed.bytes
            if Self.isValidSHA256(removed.sha256) {
                try? FileManager.default.removeItem(at: episodeFileURL(sha256: removed.sha256))
            }
        }
        saveCacheIndex()
    }

    func clearCache() async -> [String: Any] {
        playbackGeneration &+= 1
        activeDownloadTask?.cancel()
        activeDownloadTask = nil
        activeDownloadId = nil
        downloadingEpisodeId = nil
        stopPlaybackInternal()
        await clearNowPlaying()
        if let files = try? FileManager.default.contentsOfDirectory(at: episodesDirectory, includingPropertiesForKeys: nil) {
            for file in files {
                try? FileManager.default.removeItem(at: file)
            }
        }
        cacheIndex = CacheIndex(entries: [])
        saveCacheIndex()
        lastError = nil
        notifyState()
        return stateSnapshot()
    }

    func cachedSHAs() -> Set<String> {
        var shas = Set<String>()
        for entry in cacheIndex.entries where Self.isValidSHA256(entry.sha256) {
            if FileManager.default.fileExists(atPath: episodeFileURL(sha256: entry.sha256).path) {
                shas.insert(entry.sha256)
            }
        }
        return shas
    }

    func cachedEpisodeIDs() -> Set<String> {
        let validSHAs = cachedSHAs()
        if let episodes = feed?.episodes {
            var ids = Set<String>()
            for ep in episodes where validSHAs.contains(ep.sha256) {
                ids.insert(ep.id)
            }
            return ids
        }
        var ids = Set<String>()
        for entry in cacheIndex.entries where validSHAs.contains(entry.sha256) {
            ids.insert(entry.episodeId)
        }
        return ids
    }

    func cachedTotalBytes() -> Int {
        cacheIndex.entries
            .filter { Self.isValidSHA256($0.sha256) && FileManager.default.fileExists(atPath: episodeFileURL(sha256: $0.sha256).path) }
            .reduce(0) { $0 + $1.bytes }
    }

    // MARK: - Playback Controls

    func play(episodeId: String?, startSeconds: Double? = nil) async throws -> [String: Any] {
        guard !isShutDown else {
            throw CancellationError()
        }
        if let startSeconds {
            guard startSeconds.isFinite, startSeconds >= 0 else {
                throw PodcastError.invalid("播客起始播放时间无效。")
            }
        }
        let targetId = episodeId ?? activeEpisodeId ?? feed?.episodes.first?.id
        guard let targetId, let episode = feed?.episodes.first(where: { $0.id == targetId }) else {
            throw PodcastError.unavailable("当前没有可播放的播客节目。")
        }
        playbackGeneration &+= 1
        let myGen = playbackGeneration

        if activeEpisodeId == targetId, let existing = player {
            if let seekTo = startSeconds {
                let clamped = max(0, min(seekTo, existing.duration))
                existing.currentTime = clamped
                currentTime = clamped
            }
            existing.rate = Float(rate)
            guard existing.play() else {
                stopPlaybackInternal()
                await clearNowPlaying()
                lastError = "系统音频播放器未能恢复播放。"
                notifyState()
                throw PodcastError.invalid("系统音频播放器未能恢复播放。")
            }
            isPlaying = true
            lastError = nil
            startProgressLoop()
            await updateNowPlaying(episode: episode)
            notifyState()
            return stateSnapshot()
        }
        let localFile = try await downloadEpisode(id: targetId)
        guard !isShutDown, myGen == playbackGeneration, !Task.isCancelled else {
            throw CancellationError()
        }
        stopPlaybackInternal()
        let audioPlayer: AVAudioPlayer
        do {
            audioPlayer = try AVAudioPlayer(contentsOf: localFile)
            audioPlayer.enableRate = true
            audioPlayer.rate = Float(rate)
            audioPlayer.prepareToPlay()
            if let seekTo = startSeconds {
                audioPlayer.currentTime = max(0, min(seekTo, audioPlayer.duration))
            }
            guard audioPlayer.play() else {
                throw PodcastError.invalid("系统音频播放器未能启动。")
            }
        } catch {
            stopPlaybackInternal()
            await clearNowPlaying()
            lastError = error.localizedDescription
            notifyState()
            throw error
        }
        self.player = audioPlayer
        self.activeEpisodeId = episode.id
        self.duration = audioPlayer.duration > 0 ? audioPlayer.duration : episode.durationSeconds
        self.currentTime = audioPlayer.currentTime
        self.isPlaying = true
        self.lastError = nil
        await installRemoteCommandsIfNeeded()
        guard !isShutDown, myGen == playbackGeneration else {
            stopPlaybackInternal()
            await clearNowPlaying()
            throw CancellationError()
        }
        startProgressLoop()
        await updateNowPlaying(episode: episode)
        notifyState()
        return stateSnapshot()
    }

    func pause() async -> [String: Any] {
        playbackGeneration &+= 1
        player?.pause()
        isPlaying = false
        if let p = player { currentTime = p.currentTime }
        progressTask?.cancel()
        progressTask = nil
        if let id = activeEpisodeId, let ep = feed?.episodes.first(where: { $0.id == id }) {
            await updateNowPlaying(episode: ep)
        }
        notifyState()
        return stateSnapshot()
    }

    func stop() async -> [String: Any] {
        playbackGeneration &+= 1
        activeDownloadTask?.cancel()
        activeDownloadTask = nil
        activeDownloadId = nil
        downloadingEpisodeId = nil
        stopPlaybackInternal()
        await clearNowPlaying()
        notifyState()
        return stateSnapshot()
    }

    func seek(seconds: Double) async throws -> [String: Any] {
        guard seconds.isFinite, seconds >= 0 else {
            throw PodcastError.invalid("跳转时间无效。")
        }
        guard let p = player else {
            throw PodcastError.unavailable("尚未开始播放播客节目。")
        }
        let maxDuration = p.duration > 0 ? p.duration : duration
        let clamped = max(0, min(seconds, maxDuration))
        p.currentTime = clamped
        currentTime = clamped
        if let id = activeEpisodeId, let ep = feed?.episodes.first(where: { $0.id == id }) {
            await updateNowPlaying(episode: ep)
        }
        notifyState()
        return stateSnapshot()
    }

    func setRate(_ nextRate: Double) async throws -> [String: Any] {
        guard Self.allowedRates.contains(where: { abs($0 - nextRate) < 0.001 }) else {
            throw PodcastError.invalid("播放倍速仅支持 0.75 / 1.0 / 1.25 / 1.5 / 2.0。")
        }
        let canonical = Self.allowedRates.first(where: { abs($0 - nextRate) < 0.001 }) ?? 1.0
        rate = canonical
        if let p = player {
            p.enableRate = true
            p.rate = Float(canonical)
        }
        if let id = activeEpisodeId, let ep = feed?.episodes.first(where: { $0.id == id }) {
            await updateNowPlaying(episode: ep)
        }
        notifyState()
        return stateSnapshot()
    }

    func shutdown() async {
        isShutDown = true
        playbackGeneration &+= 1
        activeDownloadTask?.cancel()
        activeDownloadTask = nil
        activeDownloadId = nil
        downloadingEpisodeId = nil
        stopPlaybackInternal()
        if enableMediaCenter {
            let registry = remoteRegistry
            remoteRegistry = nil
            remoteCommandsInstalled = false
            await MainActor.run {
                registry?.removeAllAndClearNowPlaying()
                MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            }
        }
    }

    private func stopPlaybackInternal() {
        progressTask?.cancel()
        progressTask = nil
        player?.stop()
        player = nil
        isPlaying = false
        currentTime = 0
        duration = 0
        activeEpisodeId = nil
    }

    private func startProgressLoop() {
        progressTask?.cancel()
        progressTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard !Task.isCancelled, let self else { break }
                await self.pollProgressTick()
            }
        }
    }

    private func pollProgressTick() async {
        guard let p = player else {
            isPlaying = false
            activeEpisodeId = nil
            progressTask?.cancel()
            progressTask = nil
            notifyState()
            return
        }
        currentTime = p.currentTime
        if p.duration > 0 { duration = p.duration }
        if !p.isPlaying && isPlaying {
            stopPlaybackInternal()
            await clearNowPlaying()
        }
        notifyState()
    }

    private func installRemoteCommandsIfNeeded() async {
        guard enableMediaCenter, !remoteCommandsInstalled, !isShutDown else { return }
        remoteCommandsInstalled = true
        let registry = await MainActor.run { () -> PodcastRemoteCommandRegistry in
            let reg = PodcastRemoteCommandRegistry()
            reg.install(service: self)
            return reg
        }
        if isShutDown {
            remoteCommandsInstalled = false
            await MainActor.run {
                registry.removeAllAndClearNowPlaying()
            }
            return
        }
        self.remoteRegistry = registry
    }

    private func clearNowPlaying() async {
        guard enableMediaCenter else { return }
        await MainActor.run {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        }
    }

    private func updateNowPlaying(episode: Episode) async {
        guard enableMediaCenter else { return }
        let title = episode.title
        let date = episode.date
        let playbackDuration = duration > 0 ? duration : episode.durationSeconds
        let elapsed = currentTime
        let playbackRate = isPlaying ? rate : 0.0
        await MainActor.run {
            let info: [String: Any] = [
                MPMediaItemPropertyTitle: title,
                MPMediaItemPropertyArtist: "音频研究工作台 · 每日播客",
                MPMediaItemPropertyAlbumTitle: date,
                MPMediaItemPropertyPlaybackDuration: playbackDuration,
                MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
                MPNowPlayingInfoPropertyPlaybackRate: playbackRate
            ]
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        }
    }

    func stateSnapshot(extra: [String: Any] = [:]) -> [String: Any] {
        let cachedIDs = cachedEpisodeIDs()
        var snapshot: [String: Any] = [
            "available": feedAvailable,
            "episodes": serializedEpisodes(feed?.episodes ?? []),
            "activeEpisodeId": activeEpisodeId ?? NSNull(),
            "downloadingEpisodeId": downloadingEpisodeId ?? NSNull(),
            "isPlaying": isPlaying,
            "currentTime": currentTime,
            "duration": duration,
            "rate": rate,
            "cachedEpisodeIds": cachedIDs.sorted(),
            "cachedBytes": cachedTotalBytes(),
            "maxCacheBytes": maxCacheBytesLimit,
            "maxCachedEpisodes": maxCachedEpisodesLimit
        ]
        if let lastError { snapshot["error"] = lastError }
        for (k, v) in extra { snapshot[k] = v }
        return snapshot
    }

    private func serializedEpisodes(_ episodes: [Episode]) -> [[String: Any]] {
        let validSHAs = cachedSHAs()
        return episodes.map { $0.dictionary(cached: validSHAs.contains($0.sha256)) }
    }

    private func notifyState() {
        onStateChange?(stateSnapshot())
    }

    // MARK: - Network Transport (Redirect-Blocked & Stream-Capped)

    private func fetchFeedBytes(_ url: URL, limit: Int) async throws -> (statusCode: Int, data: Data) {
        if let override = feedTransportOverride {
            let result = try await override(url, limit)
            guard result.data.count <= limit else { throw PodcastError.invalid("播客清单超过大小上限。") }
            return result
        }
        if let proxy = httpProxy {
            let tempDir = cacheDirectory.appendingPathComponent("feed-transfer-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            defer { try? FileManager.default.removeItem(at: tempDir) }
            let bodyFile = tempDir.appendingPathComponent("feed.body")
            let statusFile = tempDir.appendingPathComponent("status")
            let errFile = tempDir.appendingPathComponent("stderr")
            FileManager.default.createFile(atPath: statusFile.path, contents: nil)
            FileManager.default.createFile(atPath: errFile.path, contents: nil)
            let stdout = try FileHandle(forWritingTo: statusFile)
            let stderr = try FileHandle(forWritingTo: errFile)
            defer { try? stdout.close(); try? stderr.close() }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
            process.arguments = [
                "-q", "--globoff", "--silent", "--show-error",
                "--max-time", "60", "--connect-timeout", "30",
                "--max-filesize", String(limit),
                "--proto", "=https", "--max-redirs", "0",
                "--proxy", proxy.absoluteString, "--noproxy", "",
                "--output", bodyFile.path, "--write-out", "%{http_code}", "--url", url.absoluteString
            ]
            process.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"]
            process.standardOutput = stdout
            process.standardError = stderr
            try await runProcess(process)
            let code = Int((try? String(contentsOf: statusFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
            let attrs = (try? FileManager.default.attributesOfItem(atPath: bodyFile.path)) ?? [:]
            let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
            guard size <= Int64(limit) else { throw PodcastError.invalid("播客清单超过大小上限。") }
            let data = (try? Data(contentsOf: bodyFile)) ?? Data()
            return (code, data)
        }

        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        config.urlCache = nil
        config.httpCookieStorage = nil
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let cancellation = PodcastTransferCancellation()
        return try await withTaskCancellationHandler {
            let (bytes, response) = try await session.bytes(for: request, delegate: PodcastRedirectBlocker())
            cancellation.install(bytes.task)
            defer { bytes.task.cancel() }
            try Task.checkCancellation()
            guard let http = response as? HTTPURLResponse, http.url == url else {
                throw PodcastError.network("播客清单响应地址不一致或存在未允许重定向。")
            }
            if http.statusCode == 404 || http.statusCode == 410 {
                return (http.statusCode, Data())
            }
            guard http.statusCode == 200 else {
                return (http.statusCode, Data())
            }
            guard response.expectedContentLength <= Int64(limit) else {
                throw PodcastError.invalid("播客清单超过大小上限。")
            }
            var data = Data()
            for try await byte in bytes {
                guard data.count < limit else {
                    throw PodcastError.invalid("播客清单超过大小上限。")
                }
                data.append(byte)
                if data.count % 8192 == 0 { try Task.checkCancellation() }
            }
            try Task.checkCancellation()
            return (http.statusCode, data)
        } onCancel: {
            cancellation.cancel()
        }
    }

    private func fetchAudioHopToFile(_ url: URL, outputFile: URL, limit: Int) async throws -> (statusCode: Int, headers: [String: String]) {
        if let override = audioTransportOverride {
            let (code, headers, data) = try await override(url, limit)
            guard data.count <= limit else {
                throw PodcastError.invalid("播客音频响应超过允许大小上限。")
            }
            try data.write(to: outputFile, options: [.atomic])
            return (code, headers)
        }
        guard let host = url.host?.lowercased(), Self.allowedRedirectHosts.contains(host) else {
            throw PodcastError.invalid("播客音频域名不在白名单内。")
        }
        let tempDir = outputFile.deletingLastPathComponent()
        let headersFile = tempDir.appendingPathComponent("headers-\(UUID().uuidString)")
        let statusFile = tempDir.appendingPathComponent("status-\(UUID().uuidString)")
        let errFile = tempDir.appendingPathComponent("stderr-\(UUID().uuidString)")
        defer {
            try? FileManager.default.removeItem(at: headersFile)
            try? FileManager.default.removeItem(at: statusFile)
            try? FileManager.default.removeItem(at: errFile)
        }
        FileManager.default.createFile(atPath: statusFile.path, contents: nil)
        FileManager.default.createFile(atPath: errFile.path, contents: nil)
        let stdout = try FileHandle(forWritingTo: statusFile)
        let stderr = try FileHandle(forWritingTo: errFile)
        defer { try? stdout.close(); try? stderr.close() }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        var args = [
            "-q", "--globoff", "--silent", "--show-error",
            "--max-time", "180", "--connect-timeout", "30",
            "--max-filesize", String(limit),
            "--proto", "=https", "--max-redirs", "0"
        ]
        if let proxy = httpProxy {
            args += ["--proxy", proxy.absoluteString, "--noproxy", ""]
        } else {
            let ip = try await Self.resolvePublicOrTunIP(host: host)
            let formatted = ip.contains(":") ? "[\(ip)]" : ip
            args += ["--connect-to", "\(host):443:\(formatted):443", "--proxy", "", "--noproxy", "*"]
        }
        args += ["--dump-header", headersFile.path, "--output", outputFile.path, "--write-out", "%{http_code}", "--url", url.absoluteString]
        process.arguments = args
        process.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"]
        process.standardOutput = stdout
        process.standardError = stderr
        try await runProcess(process)

        let code = Int((try? String(contentsOf: statusFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
        let rawHeaders = (try? String(contentsOf: headersFile, encoding: .utf8)) ?? ""
        let parsedHeaders = Self.parseFinalHTTPHeaderBlock(rawHeaders)
        return (code, parsedHeaders)
    }

    private func runProcess(_ process: Process) async throws {
        try Task.checkCancellation()
        let cancellation = PodcastTransferCancellation()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                process.terminationHandler = { finished in
                    if finished.terminationReason == .uncaughtSignal {
                        continuation.resume(throwing: CancellationError())
                    } else if finished.terminationStatus != 0 {
                        continuation.resume(throwing: PodcastError.network("播客音频下载失败或超过 40 MiB 限制。"))
                    } else {
                        continuation.resume()
                    }
                }
                do { try cancellation.start(process) } catch { continuation.resume(throwing: error) }
            }
        } onCancel: {
            cancellation.cancel()
        }
        try Task.checkCancellation()
    }

    private static func resolvePublicOrTunIP(host: String) async throws -> String {
        try Task.checkCancellation()
        let ip: String = try await withCheckedThrowingContinuation { continuation in
            dnsQueue.async {
                do {
                    continuation.resume(returning: try resolvePublicOrTunIPSync(host: host))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
        try Task.checkCancellation()
        return ip
    }

    private static func resolvePublicOrTunIPSync(host: String) throws -> String {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        hints.ai_flags = AI_ADDRCONFIG
        var list: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, "443", &hints, &list) == 0, let first = list else {
            throw PodcastError.network("播客音频域名 DNS 暂不可用。")
        }
        defer { freeaddrinfo(first) }
        var cursor: UnsafeMutablePointer<addrinfo>? = first
        var found: [String] = []
        while let node = cursor {
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(node.pointee.ai_addr, node.pointee.ai_addrlen, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: buffer)
                guard LibraryService.isPublicAddress(ip) || LibraryService.isSyntheticTunFakeIP(ip) else {
                    throw PodcastError.invalid("播客音频域名解析到私网或保留地址，已拒绝下载。")
                }
                found.append(ip)
            }
            cursor = node.pointee.ai_next
        }
        guard let result = found.first(where: { !$0.contains(":") }) ?? found.first else {
            throw PodcastError.network("播客音频域名无可用公网地址。")
        }
        return result
    }

    // MARK: - Persistence Helpers

    private func atomicWrite(_ data: Data, to target: URL) throws {
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var info = stat()
        if lstat(target.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFLNK {
            throw PodcastError.invalid("播客缓存目标不能是符号链接。")
        }
        try data.write(to: target, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
    }

    private func moveFileAtomically(from source: URL, to target: URL) throws {
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var info = stat()
        if lstat(target.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFLNK {
            throw PodcastError.invalid("播客缓存目标不能是符号链接。")
        }
        if FileManager.default.fileExists(atPath: target.path) {
            _ = try FileManager.default.replaceItemAt(target, withItemAt: source)
        } else {
            try FileManager.default.moveItem(at: source, to: target)
        }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
    }

    static func loadCacheIndex(at dir: URL) -> CacheIndex {
        let file = dir.appendingPathComponent("cache-index.json")
        guard let data = try? Data(contentsOf: file),
              let decoded = try? JSONDecoder().decode(CacheIndex.self, from: data) else {
            return CacheIndex(entries: [])
        }
        var seen = Set<String>()
        let sanitized = decoded.entries.filter { entry in
            isValidSHA256(entry.sha256) &&
                !entry.episodeId.isEmpty &&
                entry.bytes > 0 &&
                entry.bytes <= maxAudioBytes &&
                entry.lastAccessedAt.isFinite &&
                seen.insert(entry.sha256).inserted
        }
        return CacheIndex(entries: sanitized)
    }

    private func saveCacheIndex() {
        guard let data = try? JSONEncoder().encode(cacheIndex) else { return }
        try? atomicWrite(data, to: cacheDirectory.appendingPathComponent("cache-index.json"))
    }

    private static func loadCachedFeed(at dir: URL) -> Feed? {
        let file = dir.appendingPathComponent("feed.json")
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? parseFeed(data)
    }
}
