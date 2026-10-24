import Foundation
import CryptoKit
import Security

/// Zotero 10 local API only. No SQLite access, connector import fallback, or cloud writes.
actor ZoteroService {
    struct Status: Codable, Sendable {
        let running: Bool
        let version: String
        let apiVersion: String
        let serverID: String
        let writesSupported: Bool
        let authorized: Bool
        let remember: Bool
        let denied: Bool
        let authorizationState: String
    }
    struct Collection: Codable, Sendable {
        let key: String
        let name: String
        let parentKey: String?
    }
    struct Creator: Codable, Sendable {
        var firstName: String?
        var lastName: String?
        var name: String?
    }
    struct Bibliography: Codable, Sendable {
        var title: String
        var creators: [Creator]
        var abstract: String
        var date: String
        var doi: String?
        var url: String
        var extra: String
        var tags: [String]
        var fields: [String: String]? = nil
    }
    struct ArchiveRequest: Codable, Sendable {
        var identity: String
        var bibliography: Bibliography
        var collectionKey: String?
        var collectionName: String?
        var pdfPath: String?
        var guideHTMLPath: String?
        var analysisHTML: String?
        var noteHTML: String?
    }
    struct Step: Codable, Sendable {
        let role: String
        var key: String?
        var verified: Bool
        var error: String?
        var everVerified: Bool? = nil
    }
    struct ArchiveResult: Codable, Sendable {
        let archiveID: String
        let identity: String
        let title: String
        let parentKey: String?
        let status: String
        let steps: [Step]
        let retryable: Bool
        let serverID: String
    }
    enum ServiceError: Error, LocalizedError {
        case unavailable, unsupported, authorizationRequired, persistentAuthorizationRequired
        case denied, serverChanged, invalid(String), http(Int), conflict, ambiguousDuplicate
        case verification(String), missingArchive
        var errorDescription: String? {
            switch self {
            case .unavailable: return "Zotero 本机服务不可用，请打开客户端并启用本地 API。"
            case .unsupported: return "完整归档需要 Zotero 10 或更新版本的本地写入 API。"
            case .authorizationRequired: return "需要在 Zotero 中明确授权此应用写入。"
            case .persistentAuthorizationRequired: return "完整归档包含多步写入；请在 Zotero 中选择持续允许后重试。"
            case .denied: return "Zotero 写入授权已被拒绝，未继续写入。"
            case .serverChanged: return "Zotero 文库实例已变化；旧授权和归档检查点不能复用。"
            case .invalid(let value): return "归档输入无效：\(value)"
            case .http(let code): return "Zotero 请求失败（HTTP \(code)），已保留完成步骤。"
            case .conflict: return "Zotero 内容版本发生变化，已停止覆盖，请重新核对。"
            case .ambiguousDuplicate: return "发现多条相同论文身份，请先在 Zotero 中处理重复项。"
            case .verification(let value): return "Zotero 回读核验未通过：\(value)"
            case .missingArchive: return "找不到本机归档检查点。"
            }
        }
    }
    private struct Authorization: Codable { let key: String; let remember: Bool }
    private struct Journal: Codable {
        let id: String
        let serverID: String
        let fingerprint: String
        let request: ArchiveRequest
        var collectionKey: String?
        var parentKey: String?
        var steps: [Step]
        var createdParentPayload: Data? = nil
        var materialSHA256: [String: String]? = nil
    }
    private struct Material {
        let role: String
        let filename: String
        let contentType: String
        let data: Data
        var sha256: String { ZoteroService.sha256(data) }
        var md5: String { Insecure.MD5.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    }
    private let directory: URL
    private let pathDirectory: URL
    private let session: URLSession
    private let credentialStore: any ZoteroCredentialStore
    private let base = URL(string: "http://127.0.0.1:23119")!
    private var serverID: String?
    private var authorization: Authorization?
    private var authorizationDenied = false
    private var authorizationState = "unknown"
    private var operationInProgress = false
    private static let keychainService = "com.nanless.PaperDigest.zotero"

    init(dataDirectory: URL, session: URLSession? = nil, credentialStore: any ZoteroCredentialStore = ZoteroKeychainCredentialStore()) {
        self.credentialStore = credentialStore
        pathDirectory = dataDirectory.standardizedFileURL
        directory = dataDirectory.standardizedFileURL.resolvingSymlinksInPath()
        if let session { self.session = session }
        else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 40
            configuration.timeoutIntervalForResource = 120
            configuration.httpShouldSetCookies = false
            configuration.httpCookieStorage = nil
            self.session = URLSession(configuration: configuration, delegate: ZoteroNoRedirectDelegate(), delegateQueue: nil)
        }
    }

    func status() async throws -> Status {
        let (_, response) = try await request("/api/", requireServer: false)
        let currentID = response.value(forHTTPHeaderField: "Zotero-Server-ID") ?? ""
        if let previous = serverID, previous != currentID {
            authorization = nil; authorizationDenied = false; authorizationState = "unknown"; serverID = currentID
            throw ServiceError.serverChanged
        }
        serverID = currentID
        let version = response.value(forHTTPHeaderField: "X-Zotero-Version") ?? response.value(forHTTPHeaderField: "Zotero-Version") ?? ""
        return Status(running: true, version: version,
                      apiVersion: response.value(forHTTPHeaderField: "Zotero-API-Version") ?? "",
                      serverID: currentID,
                      writesSupported: (Int(version.split(separator: ".").first ?? "0") ?? 0) >= 10 && !currentID.isEmpty,
                      authorized: authorization != nil, remember: authorization?.remember ?? false, denied: authorizationDenied,
                      authorizationState: authorizationState)
    }

    /// Explicit user action only: inspect this instance's saved permission without
    /// requesting a new Zotero API key or changing its library permissions.
    func checkAuthorization() async throws -> Status {
        guard !operationInProgress else { throw ServiceError.invalid("归档进行中，请完成后再检查许可") }
        let current = try await status()
        guard current.writesSupported else { throw ServiceError.unsupported }
        try restoreAuthorization(serverID: current.serverID)
        return try await status()
    }
    private func restoreAuthorization(serverID: String) throws {
        guard authorization == nil, !authorizationDenied else { return }
        do {
            authorization = try loadAuthorization(serverID)
            authorizationState = authorization == nil ? "missing" : "authorized"
        } catch {
            authorizationState = "unavailable"
            throw ServiceError.verification("已保存许可无法读取；请在系统钥匙串窗口自行决定是否允许，然后主动重试")
        }
    }

    /// Call only after the user's explicit Connect action. Zotero itself displays the approval dialog.
    func authorize(appName: String = "论文速递") async throws -> Status {
        guard !operationInProgress else { throw ServiceError.invalid("归档进行中，请完成后再变更授权") }
        let current = try await status()
        guard current.writesSupported else { throw ServiceError.unsupported }
        // Reuse an existing persistent grant after a deliberate user action. A
        // Keychain denial must not mint a replacement Zotero credential.
        try restoreAuthorization(serverID: current.serverID)
        if authorization?.remember == true { return try await status() }
        let data: Data
        do {
            (data, _) = try await request("/api/local/authorize", method: "POST",
                                          body: try json(["appName": appName]), authenticated: false,
                                          contentType: "application/json")
        } catch ServiceError.denied {
            authorization = nil; authorizationDenied = true; authorizationState = "denied"
            try? credentialStore.remove(serverID: current.serverID)
            return try await status()
        }
        let granted = try JSONDecoder().decode(Authorization.self, from: data)
        guard granted.key.count == 32 else { throw ServiceError.verification("授权响应格式") }
        authorization = granted; authorizationDenied = false; authorizationState = "authorized"
        if granted.remember { try saveAuthorization(granted, serverID: current.serverID) }
        else { try? credentialStore.remove(serverID: current.serverID) }
        return try await status()
    }

    func collections() async throws -> [Collection] {
        _ = try await status()
        let objects = try await readArray("/api/users/0/collections")
        return try objects.map { object in
            guard let data = object["data"] as? [String: Any], let key = object["key"] as? String,
                  let name = data["name"] as? String else { throw ServiceError.verification("分类响应格式") }
            return Collection(key: key, name: name, parentKey: data["parentCollection"] as? String)
        }
    }

    /// A partial result is a saved checkpoint, never reported as a completed archive.
    func archive(_ input: ArchiveRequest, resumeID: String? = nil,
                 progress: @escaping ([String: Any]) -> Void = { _ in }) async throws -> ArchiveResult {
        guard !operationInProgress else { throw ServiceError.invalid("另一归档正在进行") }
        operationInProgress = true
        defer { operationInProgress = false }
        let current = try await status()
        guard current.writesSupported else { throw ServiceError.unsupported }
        try validate(input)
        // Read the original checkpoint before resolving old paths. The optional hashes
        // are captured only when the job was created; a root map cannot mint them.
        let previous = try resumeID.map { try loadJournal($0) }
        if let previous, previous.serverID != current.serverID { throw ServiceError.serverChanged }
        let parentPayload = try await bibliographyPayload(input)
        let materials = try [sourceMetadataMaterial(input)] + materialsFor(input, expectedSHA256: previous?.materialSHA256)
        let fingerprint = try requestFingerprint(input, materials: materials)
        if let previous, previous.fingerprint != fingerprint { throw ServiceError.invalid("重试材料已变化，请新建归档") }
        try restoreAuthorization(serverID: current.serverID)
        guard let auth = authorization else { throw ServiceError.authorizationRequired }
        guard auth.remember else { throw ServiceError.persistentAuthorizationRequired }
        var journal: Journal
        if let previous {
            journal = previous
            guard journal.fingerprint == fingerprint else { throw ServiceError.invalid("重试材料已变化，请新建归档") }
        } else {
            journal = Journal(id: UUID().uuidString, serverID: current.serverID, fingerprint: fingerprint,
                              request: input, collectionKey: input.collectionKey, parentKey: nil,
                              steps: [Step(role: "bibliography", key: nil, verified: false, error: nil)] +
                                materials.map { Step(role: $0.role, key: nil, verified: false, error: nil) } +
                                [("analysis", input.analysisHTML), ("note", input.noteHTML)].compactMap { role, text in
                                    guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                                    return Step(role: role, key: nil, verified: false, error: nil)
                                })
            journal.materialSHA256 = Dictionary(uniqueKeysWithValues: materials.filter { ["pdf", "guide"].contains($0.role) }.map { ($0.role, $0.sha256) })
            try saveJournal(journal)
        }
        do {
            journal.collectionKey = try await resolveCollection(input, existing: journal.collectionKey)
            try saveJournal(journal)
            let parent = try await ensureParent(input, payload: parentPayload, journal: &journal)
            try saveJournal(journal)
            progress(["archiveID": journal.id, "role": "bibliography", "state": "verified", "key": parent])
            var stopped = false
            for material in materials where !stopped {
                do {
                    try await archiveMaterial(material, parent: parent, journal: &journal)
                    progress(["archiveID": journal.id, "role": material.role, "state": "verified"])
                } catch {
                    markFailure(material.role, error: error, journal: &journal)
                    try saveJournal(journal)
                    progress(["archiveID": journal.id, "role": material.role, "state": "failed", "message": safe(error)])
                    if isRunFailure(error) { stopped = true; break }
                }
            }
            for (role, html) in [("analysis", input.analysisHTML), ("note", input.noteHTML)] where !stopped {
                guard let html, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                do {
                    try await archiveNote(html, role: role, parent: parent, journal: &journal)
                    progress(["archiveID": journal.id, "role": role, "state": "verified"])
                } catch {
                    markFailure(role, error: error, journal: &journal); try saveJournal(journal)
                    if isRunFailure(error) { break }
                }
            }
        } catch {
            markFailure("bibliography", error: error, journal: &journal); try saveJournal(journal)
        }
        return result(journal)
    }

    func handle(command: String, payload: [String: Any], progress: @escaping ([String: Any]) -> Void) async throws -> [String: Any] {
        switch command {
        case "zotero.status":
            var value = try dictionary(await status())
            value["archives"] = try archiveSummaries()
            return value
        case "zotero.collections": return ["collections": try await collections().map { try dictionary($0) }]
        case "zotero.authorize": return try dictionary(await authorize())
        case "zotero.checkAuthorization": return try dictionary(await checkAuthorization())
        case "zotero.archive", "zotero.resume":
            let resumeID = payload["resumeID"] as? String
            if command == "zotero.resume", let resumeID {
                let journal = try loadJournal(resumeID)
                return try dictionary(await archive(journal.request, resumeID: resumeID, progress: progress))
            }
            let request = try decodeRequest(payload)
            return try dictionary(await archive(request, resumeID: resumeID, progress: progress))
        default: throw ServiceError.invalid("未知 Zotero 命令")
        }
    }

    private func decodeRequest(_ payload: [String: Any]) throws -> ArchiveRequest {
        try JSONDecoder().decode(ArchiveRequest.self, from: json(payload))
    }
    private func validate(_ input: ArchiveRequest) throws {
        guard Self.validIdentity(input.identity, sourceURL: input.bibliography.url),
              !input.bibliography.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let url = URL(string: input.bibliography.url), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil else { throw ServiceError.invalid("论文身份或书目不完整") }
        if input.identity.hasPrefix("doi:"), let doi = input.bibliography.doi,
           Self.normalizedDOI(doi) != Self.normalizedDOI(String(input.identity.dropFirst(4))) { throw ServiceError.invalid("DOI 字段与归档身份不一致") }
        for creator in input.bibliography.creators {
            guard !(creator.name ?? creator.lastName ?? "").isEmpty else { throw ServiceError.invalid("作者姓名为空") }
        }
        if let key = input.collectionKey { try validateKey(key) }
        guard input.collectionKey != nil || !(input.collectionName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ServiceError.invalid("请选择目标分类") }
        for html in [input.analysisHTML, input.noteHTML].compactMap({ $0 }) { try validateHTML(html, document: false) }
    }
    private func materialsFor(_ input: ArchiveRequest, expectedSHA256: [String: String]? = nil) throws -> [Material] {
        var result: [Material] = []
        if let path = input.pdfPath {
            let data = try localData(path, expectedSHA256: expectedSHA256?["pdf"])
            guard data.starts(with: Data("%PDF-".utf8)) else { throw ServiceError.invalid("原文不是 PDF") }
            result.append(Material(role: "pdf", filename: "paper.pdf", contentType: "application/pdf", data: data))
        }
        if let path = input.guideHTMLPath {
            let data = try localData(path, expectedSHA256: expectedSHA256?["guide"])
            guard let text = String(data: data, encoding: .utf8) else { throw ServiceError.invalid("导读不是 UTF-8") }
            try validateHTML(text, document: true)
            result.append(Material(role: "guide", filename: "research-guide.html", contentType: "text/html", data: data))
        }
        return result
    }
    private func localData(_ path: String, expectedSHA256: String? = nil) throws -> Data {
        let actual: URL
        do { actual = try PrivateStoragePaths.resolve(path, directory: pathDirectory, expectedSHA256: expectedSHA256) }
        catch { throw ServiceError.invalid("材料路径或原 SHA256 校验未通过") }
        let values = try actual.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, let size = values.fileSize, size > 0, size <= 100 * 1024 * 1024 else { throw ServiceError.invalid("文件类型或大小不支持") }
        let bytes = try Data(contentsOf: actual, options: .mappedIfSafe)
        guard bytes.count > 0, bytes.count <= 100 * 1024 * 1024 else { throw ServiceError.invalid("文件读取后大小不支持") }
        // The path helper verifies the file; bind the bytes consumed by this request too.
        if let expectedSHA256, Self.sha256(bytes) != expectedSHA256 { throw ServiceError.invalid("材料字节与原 SHA256 不符") }
        return bytes
    }
    private func validateHTML(_ html: String, document: Bool) throws {
        guard html.utf8.count <= 40 * 1024 * 1024 else { throw ServiceError.invalid("HTML 超出本地归档大小") }
        if document && !html.lowercased().contains("<html") { throw ServiceError.invalid("导读须为完整自包含 HTML") }
        // Inline SVG resource dereferencing is unnecessary: scientific SVG is stored as an
        // already-contained img data URI. Reject these capabilities before inspecting attrs.
        let svgResources = #"(?is)<\s*(?:[A-Za-z][A-Za-z0-9_-]*:)?(?:image|use|feImage)\b"#
        guard html.range(of: svgResources, options: .regularExpression) == nil else { throw ServiceError.invalid("导读不接受内联 SVG 外部资源节点，请使用已内嵌图片") }
        let forbidden = #"(?is)<\s*(script|iframe|object|embed|link|form|input|button|base)\b|\son\w+\s*=|javascript\s*:|http-equiv\s*=|\bsrcset\s*=|@import\b"#
        guard html.range(of: forbidden, options: .regularExpression) == nil else { throw ServiceError.invalid("HTML 含脚本或非自包含资源") }
        let tagRegex = try NSRegularExpression(pattern: #"(?is)<\s*([A-Za-z][A-Za-z0-9:_-]*)\b([^<>]*)>"#)
        let hrefRegex = try NSRegularExpression(pattern: #"(?is)(?:^|\s)(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#)
        let htmlText = html as NSString
        for tag in tagRegex.matches(in: html, range: NSRange(location: 0, length: htmlText.length)) {
            let element = htmlText.substring(with: tag.range(at: 1)).lowercased()
            let attributes = htmlText.substring(with: tag.range(at: 2)) as NSString
            for match in hrefRegex.matches(in: attributes as String, range: NSRange(location: 0, length: attributes.length)) {
                let range = (1..<match.numberOfRanges).map { match.range(at: $0) }.first { $0.location != NSNotFound }!
                let value = attributes.substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines)
                let internalReference = value.hasPrefix("#")
                let valid = element == "a" ? internalReference || value.lowercased().hasPrefix("https://") : internalReference || value.lowercased().hasPrefix("data:")
                guard valid else { throw ServiceError.invalid("HTML 含不安全链接或外部 SVG/数学资源") }
            }
        }
        for pattern in [#"(?is)\b(?:src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#,
                        #"(?is)url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)"#] {
            let regex = try NSRegularExpression(pattern: pattern)
            let text = html as NSString
            for match in regex.matches(in: html, range: NSRange(location: 0, length: text.length)) {
                let range = (1..<match.numberOfRanges).map { match.range(at: $0) }.first { $0.location != NSNotFound }!
                let value = text.substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines)
                guard value.lowercased().hasPrefix("data:") else { throw ServiceError.invalid("HTML 资源必须内嵌，不能依赖远程或本机路径") }
            }
        }

    }
    private func resolveCollection(_ input: ArchiveRequest, existing: String?) async throws -> String {
        let available = try await collections()
        if let key = existing {
            guard available.contains(where: { $0.key == key }) else { throw ServiceError.invalid("目标分类不存在") }
            return key
        }
        let matches = available.filter { $0.name == input.collectionName }
        guard matches.count <= 1 else { throw ServiceError.invalid("目标分类重名，请选择具体分类") }
        if let match = matches.first { return match.key }
        let name = input.collectionName!.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = try await createObject(["name": name, "parentCollection": false], endpoint: "collections")
        let check = try await readObject("/api/users/0/collections/\(key)")
        guard (check["data"] as? [String: Any])?["name"] as? String == name else { throw ServiceError.verification("目标分类") }
        return key
    }
    private static func itemType(for input: ArchiveRequest) throws -> String {
        let explicit = input.bibliography.fields?["itemType"]
        let allowed = ["journalArticle", "conferencePaper", "preprint", "webpage"]
        if let explicit {
            guard allowed.contains(explicit) else { throw ServiceError.invalid("不支持的原始文献类型") }
            if input.identity.hasPrefix("page:"), explicit != "webpage" { throw ServiceError.invalid("仅网页身份不能冒充已核验论文类型") }
            return explicit
        }
        if input.identity.hasPrefix("page:") { return "webpage" }
        if input.identity.hasPrefix("conference:") { return "conferencePaper" }
        if input.identity.hasPrefix("arxiv:") { return "preprint" }
        throw ServiceError.invalid("DOI 不能证明文献类型，请提供来源中的真实类型")
    }
    /// Validate the real server schema before creating even the destination collection.
    private func bibliographyPayload(_ input: ArchiveRequest) async throws -> [String: Any] {
        let b = input.bibliography, itemType = try Self.itemType(for: input)
        let supported = try await readArray("/api/itemTypeFields", query: ["itemType": itemType])
        let allowed = Set(supported.compactMap { $0["field"] as? String })
        guard !allowed.isEmpty else { throw ServiceError.verification("文献类型字段列表") }
        var extra = b.extra + "\nPaperDigest-ID: " + input.identity
        if input.identity.hasPrefix("page:") { extra += "\nPaperDigest-Identity-Status: page-only; original-paper-identity-unverified" }
        // A published arXiv paper can be a journalArticle, whose schema has no archiveID.
        if input.identity.hasPrefix("arxiv:") { extra += "\narXiv: " + String(input.identity.dropFirst(6)) }
        var data: [String: Any] = ["itemType": itemType, "title": b.title, "abstractNote": b.abstract,
            "date": b.date, "url": b.url, "extra": extra,
            "creators": b.creators.map { creator -> [String: Any] in
                if let name = creator.name, !name.isEmpty { return ["creatorType": "author", "name": name] }
                return ["creatorType": "author", "firstName": creator.firstName ?? "", "lastName": creator.lastName ?? ""]
            }, "tags": Array(Set(b.tags + [Self.identityTag(input.identity)])).sorted().map { ["tag": $0] }, "collections": [] as [String]]
        if input.identity.hasPrefix("arxiv:") {
            if allowed.contains("repository") { data["repository"] = "arXiv" }
            if allowed.contains("archiveID") { data["archiveID"] = String(input.identity.dropFirst(6)) }
        }
        for (field, value) in b.fields ?? [:] where field != "itemType" {
            guard allowed.contains(field), data[field] == nil, !["DOI", "archiveID", "repository"].contains(field) else { throw ServiceError.invalid("扩展书目字段不适用于当前类型：" + field) }
            data[field] = value
        }
        let doi = input.identity.hasPrefix("doi:") ? Self.normalizedDOI(String(input.identity.dropFirst(4))) : b.doi
        if let doi, !doi.isEmpty {
            guard allowed.contains("DOI") else { throw ServiceError.invalid("当前文献类型不支持 DOI 字段") }
            data["DOI"] = doi
        }
        for field in ["title", "abstractNote", "date", "url", "extra"] {
            guard allowed.contains(field) else { throw ServiceError.verification("文献类型缺少通用字段：" + field) }
        }
        return data
    }
    private func ensureParent(_ input: ArchiveRequest, payload: [String: Any], journal: inout Journal) async throws -> String {
        var key = journal.parentKey
        var createdData: [String: Any]?
        if key == nil {
            let identityTag = Self.identityTag(input.identity)
            var objects = try await readArray("/api/users/0/items", query: ["tag": identityTag])
            if input.identity.hasPrefix("arxiv:") || input.identity.hasPrefix("doi:") {
                let query = input.identity.replacingOccurrences(of: "arxiv:", with: "").replacingOccurrences(of: "doi:", with: "")
                let baseID = query.replacingOccurrences(of: #"v\d+$"#, with: "", options: .regularExpression)
                let found = try await readArray("/api/users/0/items", query: ["q": baseID, "qmode": "everything"])
                var seen = Set(objects.compactMap { $0["key"] as? String })
                for object in found { if let key = object["key"] as? String, seen.insert(key).inserted { objects.append(object) } }
            }
            let candidates = objects.filter { object in
                guard let data = object["data"] as? [String: Any], !["attachment", "note", "annotation"].contains(data["itemType"] as? String ?? "") else { return false }
                return Self.matchesIdentity(input.identity, data: data)
            }
            guard candidates.count <= 1 else { throw ServiceError.ambiguousDuplicate }
            key = candidates.first?["key"] as? String
        }
        if key == nil {
            var data = payload
            data["collections"] = [journal.collectionKey!]
            key = try await createObject(data)
            createdData = data
            journal.createdParentPayload = try json(data)
            journal.parentKey = key; setStep("bibliography", key: key, verified: false, journal: &journal)
            try saveJournal(journal)
        }
        let parent = try await readObject("/api/users/0/items/\(key!)")
        guard let data = parent["data"] as? [String: Any], Self.matchesIdentity(input.identity, data: data) else { throw ServiceError.verification("父条目论文身份") }
        if createdData == nil, let stored = journal.createdParentPayload {
            createdData = try JSONSerialization.jsonObject(with: stored) as? [String: Any]
        }
        if let expected = createdData {
            for (field, value) in expected {
                if let text = value as? String {
                    // Zotero omits empty scalar fields in real item responses.
                    // Only absence equals an expected empty string: null, other
                    // primitive types, and nonempty edits remain strict failures.
                    if text.isEmpty, data[field] == nil { continue }
                    guard data[field] as? String == text else { throw ServiceError.verification("新书目字段回读：" + field) }
                }
            }
            let expectedCreators = expected["creators"] as? [[String: String]] ?? []
            let actualCreators = data["creators"] as? [[String: String]] ?? []
            guard expectedCreators == actualCreators else { throw ServiceError.verification("新书目作者回读") }
            let expectedTags = Set((expected["tags"] as? [[String: String]] ?? []).compactMap { $0["tag"] })
            let actualTags = Set((data["tags"] as? [[String: Any]] ?? []).compactMap { $0["tag"] as? String })
            guard expectedTags.isSubset(of: actualTags) else { throw ServiceError.verification("新书目标签回读") }
        }
        let collections = data["collections"] as? [String] ?? []
        if !collections.contains(journal.collectionKey!) {
            guard let version = parent["version"] as? Int else { throw ServiceError.verification("父条目版本") }
            _ = try await request("/api/users/0/items/\(key!)", method: "PATCH",
                                  body: try json(["collections": collections + [journal.collectionKey!], "version": version]),
                                  authenticated: true, contentType: "application/json")
            let check = try await readObject("/api/users/0/items/\(key!)")
            guard let membership = (check["data"] as? [String: Any])?["collections"] as? [String], membership.contains(journal.collectionKey!) else { throw ServiceError.verification("分类成员关系") }
        }
        journal.parentKey = key; setStep("bibliography", key: key, verified: true, journal: &journal)
        return key!
    }
    static func validIdentity(_ identity: String, sourceURL: String) -> Bool {
        if identity.hasPrefix("arxiv:") { return validArxivIdentifier(String(identity.dropFirst(6))) }
        if identity.range(of: #"^(doi:10\.[0-9]{4,9}/[^\s]+|conference:[A-Za-z0-9][A-Za-z0-9._:-]{2,500})$"#, options: .regularExpression) != nil { return true }
        guard identity.hasPrefix("page:"), let url = URL(string: sourceURL),
              url.scheme == "https", url.host == "nanless.github.io", url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else { return false }
        let path = String(identity.dropFirst(5))
        return path.hasPrefix("/audio-paper-digest-blog/posts/") && !path.contains("..") &&
            path.hasSuffix("/") && URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath == path &&
            !(path.removingPercentEncoding ?? path).split(separator: "/").contains("..") && !path.contains("\n") && !path.contains("\r")
    }
    // Legacy archive names are lowercase, with an optional canonical uppercase
    // subject class (math.GT, cs.SE). The slash is identifier syntax, never a path.
    private static func validArxivIdentifier(_ value: String) -> Bool {
        DesktopArxivIdentifier.base(of:value) != nil
    }
    static func identityTag(_ identity: String) -> String { "paper-digest:identity:" + sha256(Data(identity.utf8)) }
    static func matchesIdentity(_ identity: String, data: [String: Any]) -> Bool {
        if identity.hasPrefix("conference:") || identity.hasPrefix("page:") {
            let marker = "PaperDigest-ID: " + identity
            return (data["extra"] as? String ?? "").split(whereSeparator: { $0.isNewline }).contains { $0.trimmingCharacters(in: .whitespaces) == marker }
        }
        if identity.hasPrefix("doi:") {
            return normalizedDOI(data["DOI"] as? String ?? "") == normalizedDOI(String(identity.dropFirst(4)))
        }
        guard identity.hasPrefix("arxiv:"), validArxivIdentifier(String(identity.dropFirst(6))) else { return false }
        let expected = String(identity.dropFirst(6)).replacingOccurrences(of: #"v[1-9][0-9]*$"#, with: "", options: .regularExpression)
        let idPattern = NSRegularExpression.escapedPattern(for: expected) + #"(?:v[1-9][0-9]*)?"#
        let archiveID = (data["archiveID"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if archiveID.range(of: #"\A"# + idPattern + #"\z"#, options: .regularExpression) != nil { return true }
        if let raw = data["url"] as? String, let url = URL(string: raw),
           ["arxiv.org", "export.arxiv.org"].contains(url.host?.lowercased() ?? ""),
           ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
           url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
           URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath == url.path,
           url.path.range(of: #"\A/(?:abs|pdf)/"# + idPattern + #"(?:\.pdf)?\z"#, options: .regularExpression) != nil { return true }
        let extra = data["extra"] as? String ?? ""
        return extra.range(of: #"(?m)^[\t ]*(?i:PaperDigest-ID:[\t ]*arxiv:|arXiv:[\t ]*)"# + idPattern + #"(?:[\t ]+\[[^\]\r\n]+\])?[\t ]*$"#, options: .regularExpression) != nil
    }
    private static func normalizedDOI(_ text: String) -> String {
        text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)"#, with: "", options: .regularExpression)
    }

    private func archiveMaterial(_ material: Material, parent: String, journal: inout Journal) async throws {
        var key = journal.steps.first { $0.role == material.role }?.key
        if key == nil {
            var createdNow=false
            let children = try await readArray("/api/users/0/items/\(parent)/children")
            let marker = "PaperDigest-Asset: \(material.role):\(material.sha256)"
            let matches = children.filter { (($0["data"] as? [String: Any])?["note"] as? String ?? "").contains(marker) }
            guard matches.count <= 1 else { throw ServiceError.verification("重复应用附件") }
            key = matches.first?["key"] as? String
            if key == nil {
                key = try await createObject(["itemType": "attachment", "parentItem": parent, "linkMode": "imported_file",
                                              "title": material.role == "pdf" ? "原始论文 PDF" : material.role == "guide" ? "论文速递 · 图文导读" : "论文速递 · 原始书目与网站评估",
                                              "contentType": material.contentType, "filename": material.filename,
                                              "note": marker, "tags": [["tag": "论文速递"]]])
                createdNow=true
            }
            setStep(material.role, key: key, verified: false, journal: &journal, unverifiedCreation:createdNow); try saveJournal(journal)
        }
        let item = try await readObject("/api/users/0/items/\(key!)")
        guard let data = item["data"] as? [String: Any], data["parentItem"] as? String == parent,
              data["linkMode"] as? String == "imported_file" else { throw ServiceError.verification("存储附件归属") }
        let storedMD5 = data["md5"] as? String ?? ""
        if !storedMD5.isEmpty && storedMD5 != material.md5 { throw ServiceError.conflict }
        if storedMD5.isEmpty {
            let marker = "PaperDigest-Asset: \(material.role):\(material.sha256)"
            let step=journal.steps.first { $0.role == material.role }
            let unfinishedOwnedSlot = step?.verified != true && step?.everVerified == false && data["note"] as? String == marker
            // A missing synced hash does not grant permission to replace a real user-edited file.
            do {
                let (pathData, _) = try await request("/api/users/0/items/\(key!)/file/view/url")
                guard let raw = String(data: pathData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                      let file = URL(string: raw), file.isFileURL else { throw ServiceError.verification("已有附件文件位置") }
                let values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                guard values.isRegularFile == true, values.fileSize == material.data.count,
                      Self.sha256(try Data(contentsOf: file)) == material.sha256 else { throw ServiceError.conflict }
            } catch ServiceError.http(404) {
                guard unfinishedOwnedSlot else { throw ServiceError.conflict }
            }
            catch let error as NSError where error.domain == NSCocoaErrorDomain &&
                [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code) {
                // Zotero 10 can return a file URL before the first upload even
                // though that path does not exist yet. Only an unfinished,
                // application-owned slot may receive its original bytes.
                guard unfinishedOwnedSlot else { throw ServiceError.conflict }
            }
            let precondition = ["If-None-Match": "*"]
            let form = ["md5": material.md5, "filename": material.filename, "filesize": String(material.data.count),
                        "mtime": String(Int64(Date().timeIntervalSince1970 * 1000))]
            let (authData, _) = try await request("/api/users/0/items/\(key!)/file", method: "POST", body: formData(form), authenticated: true,
                                                 contentType: "application/x-www-form-urlencoded", headers: precondition)
            let upload = try JSONSerialization.jsonObject(with: authData) as? [String: Any] ?? [:]
            if upload["exists"] as? Int != 1 {
                guard let raw = upload["url"] as? String, let url = URL(string: raw), isLocalUpload(url),
                      let uploadKey = upload["uploadKey"] as? String,
                      upload["prefix"] as? String == "", upload["suffix"] as? String == "" else { throw ServiceError.verification("上传地址不属于本机 Zotero") }
                _ = try await request(url.path, method: "POST", body: material.data,
                                      contentType: upload["contentType"] as? String ?? material.contentType, upload: true)
                _ = try await request("/api/users/0/items/\(key!)/file", method: "POST", body: formData(["upload": uploadKey]), authenticated: true,
                                      contentType: "application/x-www-form-urlencoded", headers: precondition)
            }
        }
        try await verifyMaterial(material, itemKey: key!, parent: parent)
        setStep(material.role, key: key, verified: true, journal: &journal); try saveJournal(journal)
    }
    private func verifyMaterial(_ material: Material, itemKey: String, parent: String) async throws {
        let object = try await readObject("/api/users/0/items/\(itemKey)")
        guard let data = object["data"] as? [String: Any], data["parentItem"] as? String == parent,
              data["md5"] as? String == material.md5, data["contentType"] as? String == material.contentType else { throw ServiceError.verification("附件元数据") }
        let (pathData, _) = try await request("/api/users/0/items/\(itemKey)/file/view/url")
        guard let text = String(data: pathData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let file = URL(string: text), file.isFileURL else { throw ServiceError.verification("附件本机文件") }
        let values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, values.fileSize == material.data.count else { throw ServiceError.verification("附件存储大小") }
        let actual = try Data(contentsOf: file, options: .mappedIfSafe)
        guard actual.count == material.data.count, Self.sha256(actual) == material.sha256 else { throw ServiceError.verification("附件实际字节") }
    }
    private func sourceMetadataMaterial(_ input: ArchiveRequest) throws -> Material {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let bibliography = try JSONSerialization.jsonObject(with: encoder.encode(input.bibliography))
        let source: [String: Any] = ["identity": input.identity, "identityStatus": input.identity.hasPrefix("page:") ? "page-only-unverified" : "source-identifier",
                                   "bibliography": bibliography, "contract": "paper-digest-source-metadata-v1"]
        return Material(role: "source-metadata", filename: "source-metadata.json", contentType: "application/json",
                        data: try JSONSerialization.data(withJSONObject: source, options: [.sortedKeys, .prettyPrinted]))
    }
    private func archiveNote(_ html: String, role: String, parent: String, journal: inout Journal) async throws {
        let marker = "PaperDigest-Note: \(role):\(Self.sha256(Data(html.utf8)))"
        let content = "<div><p>\(marker)</p>\(html)</div>"
        var key = journal.steps.first { $0.role == role }?.key
        if key == nil {
            let children = try await readArray("/api/users/0/items/\(parent)/children")
            let matches = children.filter { (($0["data"] as? [String: Any])?["note"] as? String ?? "").contains(marker) }
            guard matches.count <= 1 else { throw ServiceError.verification("重复个人笔记") }
            key = matches.first?["key"] as? String
            if key == nil { key = try await createObject(["itemType": "note", "parentItem": parent, "note": content, "tags": [["tag": "论文速递"]]]) }
            setStep(role, key: key, verified: false, journal: &journal); try saveJournal(journal)
        }
        let check = try await readObject("/api/users/0/items/\(key!)")
        guard let data = check["data"] as? [String: Any], data["parentItem"] as? String == parent,
              data["itemType"] as? String == "note", (data["note"] as? String ?? "").contains(marker), (data["note"] as? String ?? "").contains(html) else { throw ServiceError.verification("个人笔记正文") }
        setStep(role, key: key, verified: true, journal: &journal); try saveJournal(journal)
    }
    private func createObject(_ object: [String: Any], endpoint: String = "items") async throws -> String {
        let body: Data
        if endpoint == "items", object["itemType"] as? String == "attachment", let mode = object["linkMode"] as? String {
            // Zotero 10 applies JSON fields in wire order. Its filename setter
            // requires linkMode first, while ordinary sorted JSON puts filename
            // first. Encode both pieces normally, joining only object delimiters.
            var remaining = object; remaining.removeValue(forKey: "linkMode")
            let leading = try json(["linkMode": mode]), trailing = try json(remaining)
            var ordered = Data("[".utf8)
            ordered.append(leading.dropLast()); ordered.append(Data(",".utf8))
            ordered.append(trailing.dropFirst()); ordered.append(Data("]".utf8))
            body = ordered
        } else { body = try json([object]) }
        let (data, _) = try await request("/api/users/0/\(endpoint)", method: "POST", body: body,
                                         authenticated: true, contentType: "application/json", headers: ["Zotero-Write-Token": UUID().uuidString.replacingOccurrences(of: "-", with: "")])
        let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        if let failures = result["failed"] as? [String: Any], !failures.isEmpty { throw ServiceError.verification("Zotero 拒绝保存对象") }
        if let key = (result["success"] as? [String: String])?["0"] { return key }
        if let object = (result["successful"] as? [String: [String: Any]])?["0"], let key = object["key"] as? String { return key }
        throw ServiceError.verification("写入回执缺少对象 Key")
    }
    private func readObject(_ path: String) async throws -> [String: Any] {
        let (data, _) = try await request(path)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ServiceError.verification("对象响应") }
        return object
    }
    private func readArray(_ path: String, query: [String: String] = [:]) async throws -> [[String: Any]] {
        var output: [[String: Any]] = []; var start = 0
        repeat {
            var page = query; page["limit"] = "100"; page["start"] = String(start)
            let (data, _) = try await request(path, query: page)
            guard let objects = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { throw ServiceError.verification("列表响应") }
            output.append(contentsOf: objects)
            if objects.count < 100 { return output }
            start += objects.count
            guard start <= 100_000 else { throw ServiceError.verification("列表超出受控范围") }
        } while true
    }
    private func request(_ path: String, method: String = "GET", body: Data? = nil, authenticated: Bool = false,
                         contentType: String? = nil, headers: [String: String] = [:], requireServer: Bool = true,
                         query: [String: String] = [:], upload: Bool = false) async throws -> (Data, HTTPURLResponse) {
        guard path.hasPrefix("/api/"), !path.contains("..") else { throw ServiceError.invalid("本地 API 路径") }
        var components = URLComponents(url: base.appendingPathComponent(String(path.dropFirst())), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: components.url!); request.httpMethod = method; request.httpBody = body
        request.setValue("3", forHTTPHeaderField: "Zotero-API-Version")
        if requireServer && !upload {
            guard let serverID, !serverID.isEmpty else { throw ServiceError.unavailable }
            request.setValue(serverID, forHTTPHeaderField: "Zotero-Server-ID")
        }
        if authenticated {
            guard let authorization else { throw ServiceError.authorizationRequired }
            request.setValue(authorization.key, forHTTPHeaderField: "Zotero-API-Key")
        }
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        let data: Data; let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw ServiceError.unavailable }
        guard let http = response as? HTTPURLResponse else { throw ServiceError.unavailable }
        if requireServer && !upload {
            guard let received = http.value(forHTTPHeaderField: "Zotero-Server-ID"), received == serverID else {
                authorization = nil; authorizationState = "unknown"; throw ServiceError.serverChanged
            }
        }
        if authenticated, authorization?.remember == false { authorization = nil; authorizationState = "unknown" }
        switch http.statusCode {
        case 200..<300: return (data, http)
        case 401:
            guard authenticated, request.value(forHTTPHeaderField: "Zotero-API-Key") != nil else {
                throw ServiceError.http(401)
            }
            authorization = nil; authorizationState = "missing"
            if let serverID { try? credentialStore.remove(serverID: serverID) }
            throw ServiceError.authorizationRequired
        case 403 where path == "/api/local/authorize": throw ServiceError.denied
        case 412: throw ServiceError.conflict
        default: throw ServiceError.http(http.statusCode)
        }
    }
    private func isLocalUpload(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == base.host && url.port == base.port && url.user == nil && url.password == nil &&
        url.query == nil && url.fragment == nil && url.path.hasPrefix("/api/local/uploads/")
    }
    private func setStep(_ role: String, key: String?, verified: Bool, journal: inout Journal, unverifiedCreation:Bool=false) {
        if let index = journal.steps.firstIndex(where: { $0.role == role }) {
            let old=journal.steps[index]
            // A newly adopted existing attachment has unknown history even in a
            // brand-new journal. Only an acknowledged creation proves an empty
            // slot has never held verified bytes.
            let knownUnverified:Bool? = unverifiedCreation ? false : old.key == nil ? nil : old.everVerified
            let ever:Bool? = old.everVerified == true || old.verified || verified ? true : knownUnverified
            journal.steps[index] = Step(role: role, key: key, verified: verified, error: nil, everVerified: ever)
        }
    }
    private func markFailure(_ role: String, error: Error, journal: inout Journal) {
        if let index = journal.steps.firstIndex(where: { $0.role == role }) {
            if journal.steps[index].verified { journal.steps[index].everVerified = true }
            journal.steps[index].verified = false; journal.steps[index].error = safe(error)
        }
    }
    private func result(_ journal: Journal) -> ArchiveResult {
        let complete = journal.steps.allSatisfy(\.verified)
        return ArchiveResult(archiveID: journal.id, identity: journal.request.identity, title: journal.request.bibliography.title, parentKey: journal.parentKey, status: complete ? "complete" : "partial",
                             steps: journal.steps, retryable: !complete, serverID: journal.serverID)
    }
    private func isRunFailure(_ error: Error) -> Bool {
        guard let error = error as? ServiceError else { return true }
        switch error { case .authorizationRequired, .denied, .serverChanged, .unavailable: return true; default: return false }
    }
    private func safe(_ error: Error) -> String {
        if let error = error as? ServiceError { return error.localizedDescription }
        return "本机存储或解析失败，已停止相关步骤。"
    }
    private func requestFingerprint(_ input: ArchiveRequest, materials: [Material]) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        var data = try encoder.encode(input)
        for material in materials { data.append(Data((material.role + ":" + material.sha256).utf8)) }
        return Self.sha256(data)
    }
    private func journalURL(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw ServiceError.invalid("归档检查点编号") }
        return directory.appendingPathComponent("zotero-archives", isDirectory: true).appendingPathComponent(id + ".json")
    }
    private func saveJournal(_ journal: Journal) throws {
        let file = try journalURL(journal.id)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(journal).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let summary: [String: Any] = ["archiveID": journal.id, "serverID": journal.serverID, "identity": journal.request.identity,
                                      "title": journal.request.bibliography.title, "status": journal.steps.allSatisfy(\.verified) ? "complete" : "partial",
                                      "parentKey": journal.parentKey ?? "", "updatedAt": Date().timeIntervalSince1970]
        let summaryURL = file.deletingPathExtension().appendingPathExtension("summary.json")
        try json(summary).write(to: summaryURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: summaryURL.path)
    }
    private func archiveSummaries() throws -> [[String: Any]] {
        let location = directory.appendingPathComponent("zotero-archives", isDirectory: true)
        guard FileManager.default.fileExists(atPath: location.path) else { return [] }
        let files = try FileManager.default.contentsOfDirectory(at: location, includingPropertiesForKeys: [.fileSizeKey])
        var summaries: [[String: Any]] = []
        for file in files where file.lastPathComponent.hasSuffix(".summary.json") {
            guard let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size < 32_768,
                  let object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
                  object["serverID"] as? String == serverID else { continue }
            summaries.append(object)
        }
        return Array(summaries.sorted { ($0["updatedAt"] as? Double ?? 0) > ($1["updatedAt"] as? Double ?? 0) }.prefix(100))
    }
    private func loadJournal(_ id: String) throws -> Journal {
        let file = try journalURL(id)
        guard FileManager.default.fileExists(atPath: file.path) else { throw ServiceError.missingArchive }
        return try JSONDecoder().decode(Journal.self, from: Data(contentsOf: file))
    }
    private func validateKey(_ key: String) throws {
        guard key.range(of: #"^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$"#, options: .regularExpression) != nil else { throw ServiceError.invalid("Zotero 对象 Key") }
    }
    private func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    private func dictionary<T: Encodable>(_ value: T) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any] ?? [:]
    }
    private func formData(_ values: [String: String]) -> Data {
        var allowed = CharacterSet.alphanumerics; allowed.insert(charactersIn: "-._~")
        return Data(values.sorted { $0.key < $1.key }.map { "\($0.key.addingPercentEncoding(withAllowedCharacters: allowed)!)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed)!)" }.joined(separator: "&").utf8)
    }
    static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func loadAuthorization(_ serverID: String) throws -> Authorization? {
        guard let data = try credentialStore.load(serverID: serverID) else { return nil }
        let value = try JSONDecoder().decode(Authorization.self, from: data)
        return value.remember && value.key.count == 32 ? value : nil
    }
    private func saveAuthorization(_ value: Authorization, serverID: String) throws {
        try credentialStore.save(JSONEncoder().encode(value), serverID: serverID)
    }

}

private final class ZoteroNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}


/// Opaque bytes stay native. Tests inject an in-memory store; the application uses Keychain.
protocol ZoteroCredentialStore: Sendable {
    func load(serverID: String) throws -> Data?
    func save(_ data: Data, serverID: String) throws
    func remove(serverID: String) throws
}
struct ZoteroKeychainCredentialStore: ZoteroCredentialStore {
    private let service = "com.nanless.PaperDigest.zotero"
    func load(serverID: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                   kSecAttrAccount as String: serverID, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var found: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw ZoteroService.ServiceError.verification("钥匙串读取") }
        return found as? Data
    }
    func remove(serverID: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: serverID]
        let result = SecItemDelete(query as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw ZoteroService.ServiceError.verification("本机授权缓存清理") }
    }
    func save(_ data: Data, serverID: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: serverID]
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw ZoteroService.ServiceError.verification("钥匙串保存") }
        var create = query; create[kSecValueData as String] = data; create[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(create as CFDictionary, nil) == errSecSuccess else { throw ZoteroService.ServiceError.verification("钥匙串保存") }
    }
}
