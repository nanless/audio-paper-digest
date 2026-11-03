import Foundation
import CryptoKit

/// Immutable Nutstore snapshots. Credentials and local transfer files belong to the
/// caller's separate private control directory, never to the research backup.
public actor CloudArchiveService {
    public static let chunkBytes = 8 * 1024 * 1024
    public static let maxEncodedBytes = BackupCodec.maxEncodedBytes
    public static let maxDecodedBytes = BackupCodec.maxDecodedBytes
    private static let endpoint = URL(string: "https://dav.jianguoyun.com/dav/")!
    private static let manifestLimit = 128 * 1024
    private static let listingLimit = 4 * 1024 * 1024

    public struct Credentials: Sendable {
        public let username: String
        public let password: String
        public init(username: String, password: String) { self.username = username; self.password = password }
    }
    public struct Response: @unchecked Sendable {
        public let data: Data
        public let response: HTTPURLResponse
        public init(data: Data, response: HTTPURLResponse) { self.data = data; self.response = response }
    }
    public typealias Transport = @Sendable (URLRequest, Int) async throws -> Response
    public typealias CheckpointSink = @Sendable (UploadCheckpoint) async throws -> Void

    public struct SnapshotReference: Codable, Sendable, Equatable {
        public let month: String
        public let id: UUID
        public init(month: String, id: UUID) { self.month = month; self.id = id }
    }
    public struct Chunk: Codable, Sendable, Equatable {
        public let index: Int
        public let bytes: Int
        public let sha256: String
        public init(index: Int, bytes: Int, sha256: String) { self.index = index; self.bytes = bytes; self.sha256 = sha256 }
    }
    public struct UploadCheckpoint: Codable, Sendable, Equatable {
        public let contract: String
        public var schemaFingerprint: String? = nil
        public let destinationID: UUID
        public let folder: String
        public let reference: SnapshotReference
        public let createdAt: Date
        public let encodedBytes: Int
        public let sha256: String
        public let chunks: [Chunk]
        public var verifiedChunkIndices: [Int]
        public var manifestVerified: Bool
        public var retryAfter: Date?
    }
    public struct SnapshotInfo: Codable, Sendable, Equatable {
        public let reference: SnapshotReference
        public let createdAt: Date
        public let encodedBytes: Int
        public let sha256: String
        public let chunkCount: Int
    }
    public enum CloudError: Error, LocalizedError, Sendable, Equatable {
        case invalidConfiguration, invalidBackup, invalidCheckpoint, integrity, incompleteListing, localOnlySecret, selectionChanged
        case personalDocumentChanged, personalDocumentUnsafe
        case credentialsUnavailable, authentication, forbidden, transport, redirect, oversizedResponse, busy, checkpointStore
        case httpStatus(Int), throttled(Date)
        public var errorDescription: String? {
            switch self {
            case .personalDocumentChanged: return "此设备的云端同步记录已变化，请重新同步"
            case .personalDocumentUnsafe: return "WebDAV 服务未提供可安全更新的版本标记，本机资料已保留"
            case .selectionChanged: return "云端版本清单已变化，请重新读取该月份后选择要恢复的版本"
            case .invalidConfiguration: return "坚果云配置无效；请使用单级英文目录和应用专用密码"
            case .invalidBackup: return "研究备份无效或超过完整备份上限（原资料512MiB、编码750MiB）"
            case .localOnlySecret: return "旧快照含本机专用校验密钥，已停止上传；原快照与检查点保留在本机，请先原样保留后新建备份"
            case .invalidCheckpoint: return "续传记录与当前云目标或原备份不一致"
            case .integrity: return "云端快照内容校验失败；原本地资料未改变"
            case .incompleteListing: return "云端月份列表不完整，不能据此判断备份是否存在"
            case .credentialsUnavailable: return "未能取得本机保存的坚果云应用密码；请在原生窗口处理 macOS 钥匙串许可或保存应用专用密码后重试"
            case .authentication: return "坚果云认证失败；请检查账号与应用专用密码"
            case .forbidden: return "坚果云拒绝访问此目录"
            case .transport: return "云端传输未完成；请保留原续传记录后重试"
            case .redirect: return "云端返回重定向，已停止发送认证信息"
            case .oversizedResponse: return "云端响应超过允许大小"
            case .busy: return "已有云端操作正在进行"
            case .checkpointStore: return "续传记录保存失败，已停止云端操作"
            case .httpStatus(let code): return "坚果云请求未完成（HTTP \(code)）"
            case .throttled: return "坚果云访问需等待；请在限流等待结束后续传"
            }
        }
    }
    fileprivate struct Manifest: Codable, Sendable, Equatable {
        let contract: String
        var schemaFingerprint: String? = nil
        let reference: SnapshotReference
        let createdAt: Date
        let encodedBytes: Int
        let sha256: String
        let chunks: [Chunk]
        var info: SnapshotInfo { .init(reference: reference, createdAt: createdAt, encodedBytes: encodedBytes, sha256: sha256, chunkCount: chunks.count) }
    }
    private let folder: String
    private let fullSync: Bool
    private var scope: String { fullSync ? folder + "/full-sync-v1" : folder }
    private var scopePath: String { "/dav/" + scope + "/" }
    private let destinationID: UUID
    private let credentials: @Sendable () async throws -> Credentials
    private let checkpointSink: CheckpointSink
    private let cooldownSink: @Sendable (Date) async throws -> Void
    private let transport: Transport
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (TimeInterval) async throws -> Void
    private let minimumRequestInterval: TimeInterval
    private var active = false
    private var requestTimes: [Date] = []
    private var retryAfter: Date?
    private var currentCheckpoint: UploadCheckpoint?

    /// destinationID is an opaque locally generated identifier. Replace it whenever
    /// account/folder changes; do not use a username, password or credential hash.
    public init(folder: String = "PaperDigest", destinationID: UUID,
                credentials: @escaping @Sendable () async throws -> Credentials,
                checkpointSink: @escaping CheckpointSink,
                transport: Transport? = nil,
                now: @escaping @Sendable () -> Date = { Date() },
                sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in
                    try await Task.sleep(for: .seconds(seconds))
                }, minimumRequestInterval: TimeInterval = 3.1,
                initialRetryAfter: Date? = nil,
                cooldownSink: @escaping @Sendable (Date) async throws -> Void = { _ in },
                fullSync: Bool = false) throws {
        guard Self.validFolder(folder), minimumRequestInterval.isFinite, minimumRequestInterval >= 0, transport != nil || minimumRequestInterval >= 3.1 else { throw CloudError.invalidConfiguration }
        self.folder = folder; self.destinationID = destinationID; self.fullSync = fullSync
        self.credentials = credentials; self.checkpointSink = checkpointSink
        self.retryAfter = initialRetryAfter; self.cooldownSink = cooldownSink
        self.transport = transport ?? { request, limit in try await CloudBoundedRequest.perform(request, limit: limit) }
        self.now = now; self.sleep = sleep; self.minimumRequestInterval = minimumRequestInterval
    }
    #if PAPER_DIGEST_TESTS
    /// Runs the production bounded/redirect-blocking session with an intercepted
    /// origin for tests; unavailable in the shipped application.
    public static func interceptedTransport(protocolClasses: [AnyClass]) -> Transport {
        { request, limit in try await CloudBoundedRequest.perform(request, limit:limit, protocolClasses:protocolClasses) }
    }
    #endif
    public func probe() async throws {
        try begin(); defer { end() }
        let response = try await request("PROPFIND", path: "/dav/", body: Self.propfind, headers: ["Depth":"0", "Content-Type":"application/xml; charset=utf-8"], limit: Self.listingLimit, accepted: [207])
        try CloudDAVListing.requireCollection(response.data, path:"/dav/")
    }
    public func upload(encodedBackup data: Data, resuming checkpoint: UploadCheckpoint? = nil) async throws -> SnapshotInfo {
        try begin(); defer { end() }
        let payload: BackupCodec.Payload
        do { payload = try BackupCodec.parse(data) } catch { throw CloudError.invalidBackup }
        do { try BackupCodec.requirePortable(payload) } catch { throw CloudError.localOnlySecret }
        let chunks = Self.makeChunks(data)
        var state: UploadCheckpoint
        if let checkpoint {
            guard ClientProtocols.hasValidHeader(checkpoint.contract,fingerprint:checkpoint.schemaFingerprint,"paperdigest-cloud-transfer"), checkpoint.destinationID == destinationID,
                  checkpoint.folder == scope, Self.validReference(checkpoint.reference), checkpoint.encodedBytes == data.count,
                  checkpoint.sha256 == Self.hash(data), checkpoint.chunks == chunks,
                  Set(checkpoint.verifiedChunkIndices).count == checkpoint.verifiedChunkIndices.count,
                  checkpoint.verifiedChunkIndices.allSatisfy({ chunks.indices.contains($0) }),
                  checkpoint.createdAt.timeIntervalSince1970.isFinite, Self.month(checkpoint.createdAt) == checkpoint.reference.month, checkpoint.createdAt == Self.canonicalDate(checkpoint.createdAt) else { throw CloudError.invalidCheckpoint }
            state = checkpoint
            if let cooldown = checkpoint.retryAfter, cooldown > now() { retryAfter = max(retryAfter ?? cooldown, cooldown) }
        } else {
            let createdAt = Self.canonicalDate(now())
            state = .init(contract: ClientProtocols.contract("paperdigest-cloud-transfer"), schemaFingerprint: ClientProtocols.schemaFingerprint("paperdigest-cloud-transfer"), destinationID: destinationID, folder: scope,
                          reference: .init(month: Self.month(createdAt), id: UUID()), createdAt: createdAt,
                          encodedBytes: data.count, sha256: Self.hash(data), chunks: chunks,
                          verifiedChunkIndices: [], manifestVerified: false, retryAfter: nil)
        }
        currentCheckpoint = state
        try await save(state) // durable identity before any remote mutation
        let base = snapshotPath(state.reference)
        // An old checkpoint resumes the original remote header, never a rewritten manifest.
        let snapshotHeader:[String:Any]
        if let fingerprint=state.schemaFingerprint {
            let originalSchema=try ClientProtocols.declaredSchema(state.contract,"paperdigest-cloud-transfer",fingerprint)
            guard let original=originalSchema["snapshotFormat"] as? [String:Any],ClientProtocols.hasValidHeader(original,"paperdigest-cloud-snapshot") else { throw CloudError.invalidCheckpoint }
            snapshotHeader=original
        } else {
            snapshotHeader=try ClientProtocols.historicalHeader("paperdigest-cloud-snapshot",variant:"chunked-immutable-snapshot",fingerprints:nil)
        }
        let manifest = Manifest(contract: snapshotHeader["contract"] as! String, schemaFingerprint: snapshotHeader["schemaFingerprint"] as? String, reference: state.reference, createdAt: state.createdAt,
                                encodedBytes: state.encodedBytes, sha256: state.sha256, chunks: state.chunks)
        try await ensureCollection("/dav/\(folder)/")
        if fullSync { try await ensureCollection(scopePath) }
        try await ensureCollection(scopePath + state.reference.month + "/")
        // UUID paths are unique. Resume may encounter the directory created before a lost reply.
        try await ensureCollection(base)
        if let completed = try await optionalGet(base + "manifest.json", limit: Self.manifestLimit) {
            let remote = try Self.decodeManifest(completed, reference: state.reference)
            guard remote == manifest else { throw CloudError.integrity }
            // Even a saved completion flag never skips remote byte verification.
            try await verifyAll(data: data, state: &state, base: base)
            state.manifestVerified = true; state.retryAfter = nil
            try await save(state)
            return manifest.info
        }
        for chunk in chunks {
            try Task.checkCancellation()
            let bytes = Self.bytes(data, chunk: chunk), path = base + Self.chunkName(chunk.index)
            if let existing = try await optionalGet(path, limit: chunk.bytes) {
                guard existing.count == chunk.bytes, Self.hash(existing) == chunk.sha256 else { throw CloudError.integrity }
            } else {
                // Never overwrite even an uncommitted remote object. If the reply is
                // lost, a later explicit resume GET checks what actually reached it.
                let result = try await request("PUT", path: path, body: bytes, headers: ["If-None-Match":"*", "Content-Type":"application/octet-stream"], limit: 64 * 1024, accepted: [200,201,204,412])
                guard [200,201,204,412].contains(result.response.statusCode) else { throw CloudError.integrity }
                let readback = try await request("GET", path: path, limit: chunk.bytes, accepted: [200]).data
                guard readback == bytes else { throw CloudError.integrity }
            }
            state.verifiedChunkIndices = Array(Set(state.verifiedChunkIndices + [chunk.index])).sorted()
            state.retryAfter = nil; try await save(state)
        }
        let encoded = try Self.encode(manifest)
        _ = try await request("PUT", path: base + "manifest.json", body: encoded,
                              headers: ["If-None-Match":"*", "Content-Type":"application/json"], limit: 64 * 1024, accepted: [200,201,204,412])
        let readback = try await request("GET", path: base + "manifest.json", limit: Self.manifestLimit, accepted: [200]).data
        guard try Self.decodeManifest(readback, reference: state.reference) == manifest else { throw CloudError.integrity }
        state.manifestVerified = true; state.retryAfter = nil
        try await save(state) // caller must atomically persist this before success
        return manifest.info
    }
    public func list(month: String) async throws -> [SnapshotInfo] {
        try await listIdentities(month: month).map(\.info)
    }
    func listIdentities(month: String) async throws -> [(info: SnapshotInfo, manifestSHA: String)] {
        try begin(); defer { end() }
        guard Self.validMonth(month) else { throw CloudError.invalidConfiguration }
        let path = scopePath + month + "/"
        let response = try await request("PROPFIND", path: path, body: Self.propfind,
                                         headers: ["Depth":"1", "Content-Type":"application/xml; charset=utf-8"],
                                         limit: Self.listingLimit, accepted: [207,404])
        if response.response.statusCode == 404 {
            if fullSync { throw CloudError.incompleteListing }
            return []
        }
        let references = try CloudDAVListing.parse(response.data, path: path, month: month)
        var snapshots: [(info: SnapshotInfo, manifestSHA: String)] = []
        // A partial UUID directory has no manifest and is deliberately not success.
        // Rate budget exhaustion throws; never return an apparently complete prefix.
        for reference in references {
            if let bytes = try await optionalGet(snapshotPath(reference) + "manifest.json", limit: Self.manifestLimit) {
                snapshots.append((try Self.decodeManifest(bytes, reference: reference).info, Self.hash(bytes)))
            }
        }
        return snapshots.sorted { $0.info.createdAt == $1.info.createdAt ? $0.info.reference.id.uuidString < $1.info.reference.id.uuidString : $0.info.createdAt > $1.info.createdAt }
    }
    func fullSyncMonths() async throws -> [String] {
        try begin(); defer { end() }
        guard fullSync else { throw CloudError.invalidConfiguration }
        let result = try await request("PROPFIND", path: scopePath, body: Self.propfind,
            headers: ["Depth": "1", "Content-Type": "application/xml; charset=utf-8"],
            limit: Self.listingLimit, accepted: [207,404])
        if result.response.statusCode == 404 { return [] }
        return try CloudDAVListing.months(result.data, path: scopePath)
    }

    func personalDocuments() async throws -> [String: Data] {
        try begin(); defer { end() }
        let path = "/dav/\(folder)/\(PersonalWebDavSync.directory)/"
        let response = try await request("PROPFIND", path: path, body: Self.propfind,
            headers: ["Depth":"1", "Content-Type":"application/xml; charset=utf-8"],
            limit: Self.listingLimit, accepted: [207,404])
        if response.response.statusCode == 404 { return [:] }
        let devices = try CloudDAVListing.personalDevices(response.data, path: path)
        var result: [String: Data] = [:]
        var total = 0
        for id in devices {
            let bytes = try await request("GET", path: path + id + ".json", limit: PersonalWebDavSync.limit, accepted: [200]).data
            total += bytes.count
            guard total <= 32 * 1024 * 1024 else { throw CloudError.oversizedResponse }
            result[id] = bytes
        }
        return result
    }

    func writePersonalDocument(_ bytes: Data, expected: Data?, directoryExists: Bool) async throws {
        try begin(); defer { end() }
        let directory = "/dav/\(folder)/\(PersonalWebDavSync.directory)/"
        guard (1...PersonalWebDavSync.limit).contains(bytes.count) else { throw CloudError.oversizedResponse }
        if !directoryExists {
            try await ensureCollection("/dav/\(folder)/")
            try await ensureCollection(directory)
        }
        let path = directory + destinationID.uuidString.lowercased() + ".json"
        let current = try await request("GET", path: path, limit: PersonalWebDavSync.limit, accepted: [200,404])
        let missing = current.response.statusCode == 404
        guard (missing ? nil : current.data) == expected else { throw CloudError.personalDocumentChanged }
        var headers = ["Content-Type": "application/json"]
        if missing {
            headers["If-None-Match"] = "*"
        } else {
            guard let tag = current.response.value(forHTTPHeaderField: "ETag"),
                  Self.strongETag(tag) else { throw CloudError.personalDocumentUnsafe }
            headers["If-Match"] = tag
        }
        let written = try await request("PUT", path: path, body: bytes, headers: headers,
                                        limit: 64 * 1024, accepted: [200,201,204,412])
        guard written.response.statusCode != 412 else { throw CloudError.personalDocumentChanged }
        guard try await request("GET", path: path, limit: bytes.count, accepted: [200]).data == bytes else {
            throw CloudError.integrity
        }
    }

    private static func strongETag(_ value: String) -> Bool {
        let bytes = value.utf8
        guard (2...1024).contains(bytes.count), bytes.first == 0x22, bytes.last == 0x22 else { return false }
        return bytes.dropFirst().dropLast().allSatisfy { $0 == 0x21 || (0x23...0x7E).contains($0) }
    }

    public func download(reference: SnapshotReference) async throws -> Data {
        try await download(reference: reference, expectedManifestSHA: nil)
    }
    func download(reference: SnapshotReference, expectedManifestSHA: String?) async throws -> Data {
        try begin(); defer { end() }
        guard Self.validReference(reference) else { throw CloudError.invalidConfiguration }
        let base = snapshotPath(reference)
        let bytes = try await request("GET", path: base + "manifest.json", limit: Self.manifestLimit, accepted: [200]).data
        if let expectedManifestSHA, Self.hash(bytes) != expectedManifestSHA {
            throw CloudError.selectionChanged
        }
        let manifest = try Self.decodeManifest(bytes, reference: reference)
        var data = Data(); data.reserveCapacity(manifest.encodedBytes)
        for chunk in manifest.chunks {
            let received = try await request("GET", path: base + Self.chunkName(chunk.index), limit: chunk.bytes, accepted: [200]).data
            guard received.count == chunk.bytes, Self.hash(received) == chunk.sha256 else { throw CloudError.integrity }
            data.append(received)
        }
        guard data.count == manifest.encodedBytes, Self.hash(data) == manifest.sha256 else { throw CloudError.integrity }
        do { _ = try BackupCodec.parse(data) } catch { throw CloudError.invalidBackup }
        return data
    }
    private func begin() throws { guard !active else { throw CloudError.busy }; active = true }
    private func end() { active = false; currentCheckpoint = nil }
    private func save(_ state: UploadCheckpoint) async throws {
        do { try await checkpointSink(state); currentCheckpoint = state }
        catch { try Self.preserveCancellation(error); throw CloudError.checkpointStore }
    }
    private func ensureCollection(_ path: String) async throws {
        _ = try await request("MKCOL", path: path, limit: 64 * 1024, accepted: [201,405])
        // 405 alone is not evidence a collection exists (it may be a file or a
        // server denying MKCOL). Probe the actual exact collection in that case.
        let response = try await request("PROPFIND", path: path, body: Self.propfind,
                                         headers:["Depth":"0", "Content-Type":"application/xml; charset=utf-8"], limit: Self.listingLimit, accepted:[207])
        try CloudDAVListing.requireCollection(response.data, path: path)
    }
    private func optionalGet(_ path: String, limit: Int) async throws -> Data? {
        let result = try await request("GET", path: path, limit: limit, accepted: [200,404])
        return result.response.statusCode == 404 ? nil : result.data
    }
    private func verifyAll(data: Data, state: inout UploadCheckpoint, base: String) async throws {
        for chunk in state.chunks {
            let received = try await request("GET", path: base + Self.chunkName(chunk.index), limit: chunk.bytes, accepted:[200]).data
            guard received == Self.bytes(data, chunk: chunk) else { throw CloudError.integrity }
            state.verifiedChunkIndices = Array(Set(state.verifiedChunkIndices + [chunk.index])).sorted()
            try await save(state)
        }
    }
    private func request(_ method: String, path: String, body: Data? = nil, headers: [String:String] = [:], limit: Int, accepted: Set<Int>) async throws -> Response {
        try Task.checkCancellation()
        if let until = retryAfter, until > now() { throw CloudError.throttled(until) }
        requestTimes.removeAll { now().timeIntervalSince($0) >= 1800 }
        guard requestTimes.count < 600 else {
            let until = (requestTimes.first ?? now()).addingTimeInterval(1800)
            try await recordCooldown(until); throw CloudError.throttled(until)
        }
        if let last = requestTimes.last {
            let delay = minimumRequestInterval - now().timeIntervalSince(last)
            if delay > 0 {
                do { try await sleep(delay) } catch { try Self.preserveCancellation(error); throw CloudError.transport }
                try Task.checkCancellation()
            }
        }
        guard let url = URL(string: path, relativeTo: Self.endpoint)?.absoluteURL,
              Self.validURL(url), URLComponents(url:url,resolvingAgainstBaseURL:false)?.path == path else { throw CloudError.invalidConfiguration }
        let access: Credentials
        do { access = try await credentials() }
        catch { try Self.preserveCancellation(error); throw CloudError.credentialsUnavailable }
        try Task.checkCancellation()
        guard !access.password.isEmpty else { throw CloudError.credentialsUnavailable }
        guard !access.username.isEmpty, !access.username.contains(":"),
              !access.username.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              !access.password.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw CloudError.invalidConfiguration }
        try Task.checkCancellation()
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        request.httpMethod = method; request.httpBody = body
        request.setValue("Basic " + Data((access.username + ":" + access.password).utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        for (key,value) in headers { request.setValue(value, forHTTPHeaderField:key) }
        requestTimes.append(now())
        let result: Response
        do { result = try await transport(request, limit) }
        catch {
            try Self.preserveCancellation(error)
            if let cloudError = error as? CloudError { throw cloudError }
            throw CloudError.transport
        }
        try Task.checkCancellation()
        guard let responseURL = result.response.url, Self.validURL(responseURL), responseURL.absoluteString == url.absoluteString else { throw CloudError.redirect }
        guard result.data.count <= limit else { throw CloudError.oversizedResponse }
        let status = result.response.statusCode
        if status == 401 { throw CloudError.authentication }
        if status == 403 { throw CloudError.forbidden }
        if (300...399).contains(status) { throw CloudError.redirect }
        if status == 429 || status == 503 {
            let until = Self.parseRetryAfter(result.response.value(forHTTPHeaderField:"Retry-After"), now:now())
            try await recordCooldown(until); throw CloudError.throttled(until)
        }
        guard accepted.contains(status) else { throw CloudError.httpStatus(status) }
        return result
    }
    /// A local permission failure is not a provider rejection. Likewise an
    /// explicit cancellation must not become authentication or transport error.
    private static func preserveCancellation(_ error: Error) throws {
        if error is CancellationError { throw CancellationError() }
        try Task.checkCancellation()
    }
    private func recordCooldown(_ until: Date) async throws {
        retryAfter = until
        var cooldownSaved = true
        do { try await cooldownSink(until) } catch { try Self.preserveCancellation(error); cooldownSaved = false }
        if var state = currentCheckpoint { state.retryAfter = until; try await save(state) }
        guard cooldownSaved else { throw CloudError.checkpointStore }
    }
    private func snapshotPath(_ reference: SnapshotReference) -> String { scopePath + "\(reference.month)/\(reference.id.uuidString.lowercased())/" }
    private static func validFolder(_ value: String) -> Bool {
        guard value.utf8.count >= 1, value.utf8.count <= 64, !value.contains(".."), value.lowercased() != "zotero",
              let first = value.utf8.first, (65...90).contains(first) || (97...122).contains(first) || (48...57).contains(first) else { return false }
        return value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 || $0 == 46 }
    }
    fileprivate static func validURL(_ value: URL) -> Bool {
        let c = URLComponents(url:value,resolvingAgainstBaseURL:false)
        return c?.scheme == "https" && c?.host == "dav.jianguoyun.com" && (c?.port == nil || c?.port == 443) && c?.user == nil && c?.password == nil && c?.query == nil && c?.fragment == nil && (c?.path.hasPrefix("/dav/") ?? false)
    }
    fileprivate static func validMonth(_ value: String) -> Bool {
        let parts = value.split(separator:"-",omittingEmptySubsequences:false)
        guard parts.count == 2, parts[0].count == 4, parts[1].count == 2,
              value.utf8.allSatisfy({ (48...57).contains($0) || $0 == 45 }),
              let year = Int(parts[0]), (2000...9999).contains(year), let month = Int(parts[1]), (1...12).contains(month) else { return false }
        return true
    }
    private static func validReference(_ value: SnapshotReference) -> Bool { validMonth(value.month) }
    // Date uses a different epoch internally. Multiplying arbitrary subsecond
    // timestamps by 1000 can lose a bit across JSON and break exact manifests.
    // Whole UTC seconds are sufficient for display; UUID distinguishes same-second versions.
    private static func canonicalDate(_ date: Date) -> Date {
        Date(timeIntervalSince1970:floor(date.timeIntervalSince1970))
    }
    private static func month(_ date: Date) -> String {
        var calendar = Calendar(identifier:.gregorian); calendar.timeZone = TimeZone(secondsFromGMT:0)!
        let components = calendar.dateComponents([.year,.month],from:date)
        return String(format:"%04d-%02d",components.year ?? 0,components.month ?? 0)
    }
    private static func hash(_ data: Data) -> String { SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined() }
    private static func validSHA(_ value: String) -> Bool { value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
    private static func chunkName(_ index: Int) -> String { String(format:"chunk-%06d.bin",index) }
    private static func bytes(_ data: Data, chunk: Chunk) -> Data { data.subdata(in:(chunk.index * chunkBytes)..<(chunk.index * chunkBytes + chunk.bytes)) }
    private static func makeChunks(_ data: Data) -> [Chunk] {
        stride(from:0,to:data.count,by:chunkBytes).enumerated().map { index,offset in
            let end = min(data.count,offset + chunkBytes)
            return Chunk(index:index,bytes:end-offset,sha256:hash(data.subdata(in:offset..<end)))
        }
    }
    private static func encode<T:Encodable>(_ value:T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .millisecondsSince1970
        return try encoder.encode(value)
    }
    private static func decodeManifest(_ bytes: Data, reference: SnapshotReference) throws -> Manifest {
        guard bytes.count <= manifestLimit else { throw CloudError.oversizedResponse }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .millisecondsSince1970
        let manifest: Manifest
        do { manifest = try decoder.decode(Manifest.self,from:bytes) } catch { throw CloudError.integrity }
        guard ClientProtocols.hasValidHeader(manifest.contract,fingerprint:manifest.schemaFingerprint,"paperdigest-cloud-snapshot"), manifest.reference == reference,
              validReference(reference), manifest.createdAt.timeIntervalSince1970.isFinite, manifest.createdAt == canonicalDate(manifest.createdAt),
              month(manifest.createdAt) == reference.month,
              manifest.encodedBytes > 0, manifest.encodedBytes <= maxEncodedBytes, validSHA(manifest.sha256),
              manifest.chunks.count == (manifest.encodedBytes + chunkBytes - 1) / chunkBytes else { throw CloudError.integrity }
        var count = 0
        for (index,chunk) in manifest.chunks.enumerated() {
            guard chunk.index == index, validSHA(chunk.sha256), chunk.bytes > 0,
                  chunk.bytes == min(chunkBytes,manifest.encodedBytes-count) else { throw CloudError.integrity }
            count += chunk.bytes
        }
        guard count == manifest.encodedBytes else { throw CloudError.integrity }
        return manifest
    }
    private static func parseRetryAfter(_ value: String?, now: Date) -> Date {
        if let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty {
            // Delay-seconds is decimal digits. Bound the resulting date to the
            // same four-digit year range as the absolute HTTP date.
            let maximum = Date(timeIntervalSince1970: 253_402_300_799)
            if value.utf8.allSatisfy({ (0x30...0x39).contains($0) }),
               let seconds = UInt64(value), Double(seconds) <= maximum.timeIntervalSince(now) {
                return now.addingTimeInterval(max(1, Double(seconds)))
            }
            let formatter = DateFormatter(); formatter.locale = Locale(identifier:"en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT:0)
            formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
            if let date = formatter.date(from:value), date > now, date <= maximum { return date }
        }
        return now.addingTimeInterval(60)
    }
    private static let propfind = Data("<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>".utf8)
}

private final class CloudDAVListing: NSObject, XMLParserDelegate {
    struct Member { var href = ""; var collection = false; var success = false }
    var members: [Member] = []
    private var member: Member?
    private var stack: [String] = []
    private var text = ""
    private var invalid = false
    private var propstatCollection = false
    private var propstatSuccess = false
    private var inPropstat = false
    private var rootSeen = false
    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String:String] = [:]) {
        guard namespaceURI == "DAV:" else { invalid = true; return }
        if stack.isEmpty {
            guard !rootSeen, elementName == "multistatus" else { invalid = true; return }
            rootSeen = true
        }
        if elementName == "response" {
            if member != nil || stack != ["multistatus"] { invalid = true }
            member = Member()
        }
        if elementName == "propstat" {
            if inPropstat || member == nil { invalid = true }
            inPropstat = true; propstatCollection = false; propstatSuccess = false
        }
        if elementName == "collection", inPropstat, stack.suffix(2) == ["prop", "resourcetype"] { propstatCollection = true }
        stack.append(elementName); text = ""
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) { text += string }
    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        guard stack.last == elementName else { invalid = true; return }
        if elementName == "href", stack.suffix(2) == ["response", "href"] {
            if member?.href.isEmpty != true { invalid = true }
            member?.href = text.trimmingCharacters(in:.whitespacesAndNewlines)
        }
        if elementName == "status", stack.suffix(2) == ["propstat", "status"] {
            let fields = text.split(whereSeparator: { $0.isWhitespace })
            propstatSuccess = fields.count >= 2 && fields[0].hasPrefix("HTTP/") && fields[1] == "200"
        }
        if elementName == "propstat" {
            if propstatSuccess { member?.success = true; if propstatCollection { member?.collection = true } }
            inPropstat = false
        }
        if elementName == "response", let value = member {
            members.append(value); member = nil
            if members.count >= 750 { invalid = true; parser.abortParsing() }
        }
        stack.removeLast(); text = ""
    }
    private static func read(_ data: Data) throws -> [Member] {
        guard let source = String(data:data,encoding:.utf8), !source.localizedCaseInsensitiveContains("<!DOCTYPE"), !source.localizedCaseInsensitiveContains("<!ENTITY") else { throw CloudArchiveService.CloudError.incompleteListing }
        let delegate = CloudDAVListing(), parser = XMLParser(data:data)
        parser.shouldProcessNamespaces = true; parser.shouldResolveExternalEntities = false; parser.delegate = delegate
        guard parser.parse(), !delegate.invalid, delegate.rootSeen, delegate.stack.isEmpty, !delegate.members.isEmpty, delegate.members.count < 750 else { throw CloudArchiveService.CloudError.incompleteListing }
        return delegate.members
    }
    private static func checkedPath(_ href: String) throws -> String {
        guard !href.contains("\\"), let raw = URLComponents(string: href),
              (raw.scheme != nil || (raw.host == nil && href.hasPrefix("/"))),
              raw.percentEncodedPath == raw.path, !raw.path.contains("//"),
              !raw.path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }),
              let url = URL(string: href, relativeTo: URL(string: "https://dav.jianguoyun.com")!)?.absoluteURL,
              let actual = URLComponents(url: url, resolvingAgainstBaseURL: false),
              actual.scheme == "https", actual.host == "dav.jianguoyun.com", (actual.port == nil || actual.port == 443),
              actual.user == nil, actual.password == nil, actual.query == nil, actual.fragment == nil,
              actual.path == raw.path, actual.path == "/dav" || actual.path.hasPrefix("/dav/") else {
            throw CloudArchiveService.CloudError.incompleteListing
        }
        return actual.path
    }
    /// A successful DAV collection may identify itself without its final slash.
    /// Do not normalize files, repeated slashes, escaped separators, or dot paths.
    private static func collectionPath(_ path: String) -> String { path.hasSuffix("/") ? path : path + "/" }
    static func requireCollection(_ data: Data, path: String) throws {
        let members = try read(data)
        guard members.count == 1, members[0].collection, members[0].success,
              try collectionPath(checkedPath(members[0].href)) == path else { throw CloudArchiveService.CloudError.incompleteListing }
    }
    static func months(_ data: Data, path: String) throws -> [String] {
        let members = try read(data)
        var root = false
        var months = Set<String>()
        for member in members {
            let actual = try collectionPath(checkedPath(member.href))
            guard member.success, member.collection, actual.hasPrefix(path) else {
                throw CloudArchiveService.CloudError.incompleteListing
            }
            if actual == path {
                guard !root else { throw CloudArchiveService.CloudError.incompleteListing }
                root = true
            } else {
                let month = String(actual.dropFirst(path.count).dropLast())
                guard CloudArchiveService.validMonth(month), months.insert(month).inserted else {
                    throw CloudArchiveService.CloudError.incompleteListing
                }
            }
        }
        guard root else { throw CloudArchiveService.CloudError.incompleteListing }
        return months.sorted()
    }
    static func personalDevices(_ data: Data, path: String) throws -> [String] {
        let members = try read(data)
        guard members.count <= 25 else { throw CloudArchiveService.CloudError.incompleteListing }
        var root = false, ids = Set<String>()
        for member in members {
            let raw = try checkedPath(member.href)
            guard member.success else { throw CloudArchiveService.CloudError.incompleteListing }
            if member.collection && collectionPath(raw) == path {
                guard !root else { throw CloudArchiveService.CloudError.incompleteListing }
                root = true
                continue
            }
            guard !member.collection, raw.hasPrefix(path), raw.hasSuffix(".json") else {
                throw CloudArchiveService.CloudError.incompleteListing
            }
            let id = String(raw.dropFirst(path.count).dropLast(5))
            guard PersonalWebDavSync.validDevice(id), ids.insert(id).inserted else {
                throw CloudArchiveService.CloudError.incompleteListing
            }
        }
        guard root else { throw CloudArchiveService.CloudError.incompleteListing }
        return ids.sorted()
    }
    static func parse(_ data: Data, path: String, month: String) throws -> [CloudArchiveService.SnapshotReference] {
        let members = try read(data)
        var root = false, references: [CloudArchiveService.SnapshotReference] = [], seen = Set<String>()
        for member in members {
            let raw = try checkedPath(member.href)
            let actual = member.collection ? collectionPath(raw) : raw
            // No resource may appear twice through the trailing-slash alias,
            // including a file/collection disagreement for the same URI.
            guard seen.insert(collectionPath(raw)).inserted, member.success else { throw CloudArchiveService.CloudError.incompleteListing }
            if actual == path { guard member.collection else { throw CloudArchiveService.CloudError.incompleteListing }; root = true; continue }
            guard actual.hasPrefix(path) else { throw CloudArchiveService.CloudError.incompleteListing }
            let tail = String(actual.dropFirst(path.count))
            if member.collection {
                guard tail.hasSuffix("/"), let id = UUID(uuidString:String(tail.dropLast())), String(tail.dropLast()) == id.uuidString.lowercased() else { throw CloudArchiveService.CloudError.incompleteListing }
                references.append(.init(month:month,id:id))
            } else if tail.contains("/") { throw CloudArchiveService.CloudError.incompleteListing }
        }
        guard root else { throw CloudArchiveService.CloudError.incompleteListing }
        return references
    }
}

/// Each request gets an ephemeral session and bounded streaming accumulator. No
/// cookies, credential persistence, redirect following or TLS exceptions.
private final class CloudBoundedRequest: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let limit: Int
    private let lock = NSLock()
    private var bytes = Data()
    private var response: HTTPURLResponse?
    private var continuation: CheckedContinuation<CloudArchiveService.Response, Error>?
    private var session: URLSession?
    private init(limit: Int) { self.limit = limit }
    static func perform(_ request: URLRequest, limit: Int, protocolClasses: [AnyClass]? = nil) async throws -> CloudArchiveService.Response {
        let connection = CloudBoundedRequest(limit:limit)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                connection.lock.lock()
                connection.continuation = continuation
                let configuration = URLSessionConfiguration.ephemeral
                if let protocolClasses { configuration.protocolClasses = protocolClasses }
                configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil
                configuration.urlCredentialStorage = nil; configuration.urlCache = nil
                configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
                configuration.timeoutIntervalForRequest = 60; configuration.timeoutIntervalForResource = 300
                let session = URLSession(configuration:configuration,delegate:connection,delegateQueue:nil)
                connection.session = session
                connection.lock.unlock()
                session.dataTask(with:request).resume()
                if Task.isCancelled { connection.finish(.failure(CancellationError())) }
            }
        } onCancel: { connection.finish(.failure(CancellationError())) }
    }
    private func finish(_ result: Result<CloudArchiveService.Response,Error>) {
        lock.lock(); let continuation = self.continuation; self.continuation = nil
        let session = self.session; self.session = nil; lock.unlock()
        continuation?.resume(with:result); session?.invalidateAndCancel()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil); finish(.failure(CloudArchiveService.CloudError.redirect))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust { completionHandler(.performDefaultHandling,nil) }
        else { completionHandler(.cancelAuthenticationChallenge,nil); finish(.failure(CloudArchiveService.CloudError.authentication)) }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else { completionHandler(.cancel); finish(.failure(CloudArchiveService.CloudError.transport)); return }
        // Error/redirect bodies are never needed. Preserve status and Retry-After
        // even when a provider's error page declares an enormous body.
        if !(200...299).contains(http.statusCode) {
            completionHandler(.cancel); finish(.success(.init(data:Data(),response:http))); return
        }
        guard response.expectedContentLength < 0 || response.expectedContentLength <= limit else { completionHandler(.cancel); finish(.failure(CloudArchiveService.CloudError.oversizedResponse)); return }
        self.response = http; completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard bytes.count <= limit, data.count <= limit - bytes.count else { finish(.failure(CloudArchiveService.CloudError.oversizedResponse)); return }
        bytes.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if error != nil { finish(.failure(CloudArchiveService.CloudError.transport)) }
        else if let response { finish(.success(.init(data:bytes,response:response))) }
        else { finish(.failure(CloudArchiveService.CloudError.transport)) }
    }
}

// Validate the original format header before decoding its body.
extension CloudArchiveService.UploadCheckpoint {
    public init(from decoder: Decoder) throws {
        let header=try ClientProtocols.decodeHeader(decoder,"paperdigest-cloud-transfer")
        let values=try decoder.container(keyedBy:CodingKeys.self)
        contract=header.raw;schemaFingerprint=header.fingerprint
        destinationID=try values.decode(UUID.self,forKey:.destinationID)
        folder=try values.decode(String.self,forKey:.folder)
        reference=try values.decode(CloudArchiveService.SnapshotReference.self,forKey:.reference)
        createdAt=try values.decode(Date.self,forKey:.createdAt)
        encodedBytes=try values.decode(Int.self,forKey:.encodedBytes)
        sha256=try values.decode(String.self,forKey:.sha256)
        chunks=try values.decode([CloudArchiveService.Chunk].self,forKey:.chunks)
        verifiedChunkIndices=try values.decode([Int].self,forKey:.verifiedChunkIndices)
        manifestVerified=try values.decode(Bool.self,forKey:.manifestVerified)
        retryAfter=try values.decodeIfPresent(Date.self,forKey:.retryAfter)
    }
}

// Validate the original format header before decoding its body.
extension CloudArchiveService.Manifest {
    init(from decoder: Decoder) throws {
        let header=try ClientProtocols.decodeHeader(decoder,"paperdigest-cloud-snapshot")
        let values=try decoder.container(keyedBy:CodingKeys.self)
        contract=header.raw;schemaFingerprint=header.fingerprint
        reference=try values.decode(CloudArchiveService.SnapshotReference.self,forKey:.reference)
        createdAt=try values.decode(Date.self,forKey:.createdAt)
        encodedBytes=try values.decode(Int.self,forKey:.encodedBytes)
        sha256=try values.decode(String.self,forKey:.sha256)
        chunks=try values.decode([CloudArchiveService.Chunk].self,forKey:.chunks)
    }
}
