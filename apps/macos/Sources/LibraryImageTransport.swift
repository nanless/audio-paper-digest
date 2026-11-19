import Foundation
import Darwin

extension LibraryService {
    private static let approvedHosts: Set<String> = [
        "arxiv.org", "export.arxiv.org", "www.isca-archive.org", "isca-archive.org",
        "openreview.net", "proceedings.mlr.press", "papers.nips.cc", "proceedings.neurips.cc",
        "aclanthology.org"
    ]

    // These are published image layouts, not a grant to arbitrary GitHub content.
    // Keep owner/repository/branch and every path component exact; each redirect
    // passes the same policy again before DNS validation and fixed-IP transfer.
    static func isOwnedPublishedImage(_ url: URL) -> Bool {
        guard url.scheme == "https", url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.port == nil || url.port == 443, let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              !components.percentEncodedPath.contains("%"), !components.percentEncodedPath.contains("\\"), !components.percentEncodedPath.contains("//") else { return false }
        let path = components.percentEncodedPath
        if url.host?.lowercased() == "raw.githubusercontent.com" {
            let parts = path.split(separator: "/", omittingEmptySubsequences: false)
            let conferences: Set<String> = ["interspeech-2026", "dafx-2026", "acl-2026", "eusipco-2026", "cvpr-2026", "nime-2026", "speechprosody-2026", "aaai-2026", "odyssey-2026", "icmc-2026", "jep-2026", "eacl-2026", "iwslt-2026", "chime-2026", "uai-2026", "aistats-2026"]
            guard parts.count == 7, parts[0].isEmpty, parts[1] == "nanless", parts[2] == "audio-paper-digest-images", parts[3] == "main", conferences.contains(String(parts[4])) else { return false }
            return parts[5].range(of: #"\A[a-f0-9]{12}\z"#, options: .regularExpression) != nil && parts[6].range(of: #"\Afigure-[1-9][0-9]*\.png\z"#, options: .regularExpression) != nil
        }
        if url.host?.lowercased() == "nanless.github.io" {
            let parts = path.split(separator: "/", omittingEmptySubsequences: false)
            guard parts.count == 5, parts[0].isEmpty, parts[1] == "audio-paper-digest-images", ["icassp-2026", "iclr-2026"].contains(parts[2]), parts[3].range(of: #"\A2026-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])\z"#, options: .regularExpression) != nil else { return false }
            let pattern = parts[2] == "icassp-2026" ? #"\A[0-9]{8}-[0-9]+\.(?:png|jpg)\z"# : #"\A[A-Za-z0-9]{10}-[0-9]+\.(?:png|jpg)\z"#
            return parts[4].range(of: pattern, options: .regularExpression) != nil
        }
        return false
    }

    static func isApprovedExternalResource(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host?.lowercased(), url.user == nil, url.password == nil, url.port == nil || url.port == 443 else { return false }
        return approvedHosts.contains(host) || isOwnedPublishedImage(url)
    }

    static func externalResourceProxy(_ url: URL, configured: URL?) -> URL? {
        let host = url.host?.lowercased()
        return host == "arxiv.org" || host == "export.arxiv.org" || isOwnedPublishedImage(url) ? configured : nil
    }

    func configureNetwork(httpProxy: String?) throws {
        guard let value = httpProxy?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { self.httpProxy = nil; return }
        guard let url = URL(string: value), url.scheme == "http", url.host != nil, url.port != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else { throw ServiceError.invalid("代理请输入不含凭据的HTTP CONNECT地址，例如 http://127.0.0.1:7890。") }
        self.httpProxy = url
    }

    func sameSite(_ value: String) throws -> URL {
        guard !value.isEmpty, let url = URL(string: value, relativeTo: siteBaseURL)?.absoluteURL,
              url.scheme == "https", url.host?.lowercased() == siteBaseURL.host?.lowercased(), url.port == siteBaseURL.port,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.hasPrefix(siteBaseURL.path + "/"), !url.pathComponents.contains(".."), !url.path.contains("\\") else { throw ServiceError.invalid("资料地址超出可信站点目录。") }
        return url
    }

    func cleanHTTPS(_ value: String?) -> String? {
        guard let value, let url = URL(string: value), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url.absoluteString
    }

    func read(_ url: URL, limit: Int) async throws -> Data {
        try Task.checkCancellation()
        if let transport {
            let bytes = try await transport(url, limit)
            try Task.checkCancellation()
            guard bytes.count <= limit else { throw ServiceError.invalid("资料响应超过大小上限。") }
            return bytes
        }
        if url.host?.lowercased() == siteBaseURL.host?.lowercased(), !Self.isOwnedPublishedImage(url) {
            _ = try sameSite(url.absoluteString)
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let cancellation = LibraryTransferCancellation()
            return try await withTaskCancellationHandler(operation: {
                let (bytes, response) = try await session.bytes(for: request, delegate: LibraryRedirectBlocker())
                cancellation.install(bytes.task)
                defer { bytes.task.cancel() }
                try Task.checkCancellation()
                guard let http = response as? HTTPURLResponse, http.url == url else { throw ServiceError.network("网站响应地址不一致，未覆盖已保存版本。") }
                guard http.statusCode == 200 else { throw ServiceError.httpStatus(http.statusCode) }
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

    func externalBytes(_ initial: URL, limit: Int) async throws -> Data {
        var url = initial
        for _ in 0..<6 {
            try Task.checkCancellation()
            guard Self.isApprovedExternalResource(url), let host = url.host?.lowercased() else { throw ServiceError.invalid("外部资源不在已支持的官方HTTPS来源中。") }
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
            process.arguments = ["-q", "--globoff", "--silent", "--show-error", "--max-time", "120", "--connect-timeout", "30", "--max-filesize", String(limit), "--proto", "=https", "--max-redirs", "0", "--connect-to", "\(host):443:\(target):443", "--proxy", Self.externalResourceProxy(url, configured: httpProxy)?.absoluteString ?? "", "--noproxy", "", "--dump-header", headers.path, "--output", output.path, "--write-out", "%{http_code}", "--url", url.absoluteString]
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

    static func imageExtension(_ data: Data, url: URL) throws -> String {
        if data.starts(with: [0x89, 0x50, 0x4e, 0x47]) { return "png" }
        if data.starts(with: [0xff, 0xd8, 0xff]) { return "jpg" }
        if data.starts(with: Data("GIF8".utf8)) { return "gif" }
        if data.count > 12, data.prefix(4) == Data("RIFF".utf8), data[8..<12] == Data("WEBP".utf8) { return "webp" }
        if let text = String(data: data, encoding: .utf8), text.contains("<svg"),
           !text.localizedCaseInsensitiveContains("<!ENTITY"), !text.localizedCaseInsensitiveContains("<script"),
           !text.localizedCaseInsensitiveContains("foreignObject"), !text.localizedCaseInsensitiveContains("javascript:"),
           text.range(of: #"\bon[a-z]+\s*=|(?:href|src)\s*=\s*[\"'](?!#)|image-set\s*\(|url\s*\((?!\s*(?:'\s*#[A-Za-z_][A-Za-z0-9_.-]*\s*'|"\s*#[A-Za-z_][A-Za-z0-9_.-]*\s*"|#[A-Za-z_][A-Za-z0-9_.-]*)\s*\))"#, options: [.regularExpression, .caseInsensitive]) == nil { return "svg" }
        throw ServiceError.invalid("图片内容不受支持或包含外部执行/引用。")
    }

    static func imageMIME(_ ext: String) -> String {
        ["png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml"][ext] ?? "application/octet-stream"
    }

    static func aggregateImageMIME(_ bytes: Data) -> String? {
        guard !bytes.isEmpty, let ext = try? imageExtension(bytes, url: PublishedAggregateReader.site) else { return nil }
        return imageMIME(ext)
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
