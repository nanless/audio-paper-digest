import Foundation

private enum TestFailure: Error { case fixture, simulatedDisconnect, unsafeLiveArguments }

private actor SyncDAVFixture {
    private var folders: Set<String> = ["/dav/"]
    private var files: [String: Data] = [:]
    private var loseManifestReply = true
    func forget(_ id: UUID) {
        let suffix = "/" + id.uuidString.lowercased() + "/manifest.json"
        files = files.filter { !$0.key.hasSuffix(suffix) }
    }
    func changeManifest(_ path: String) throws -> Data {
        guard let previous = files[path] else { throw TestFailure.fixture }
        files[path] = previous + Data([32])
        return previous
    }
    func restoreManifest(_ path: String, bytes: Data) { files[path] = bytes }
    func committed() -> [String] { files.keys.filter { $0.hasSuffix("/manifest.json") }.sorted() }
    func request(_ request: URLRequest, limit: Int) throws -> CloudArchiveService.Response {
        guard let url = request.url, let method = request.httpMethod else { throw TestFailure.fixture }
        let path = url.path + (url.absoluteString.hasSuffix("/") && !url.path.hasSuffix("/") ? "/" : "")
        var status = 200
        var data = Data()
        switch method {
        case "MKCOL": status = folders.insert(path).inserted ? 201 : 405
        case "PROPFIND":
            if !folders.contains(path) { status = 404; break }
            var members = [path]
            if request.value(forHTTPHeaderField: "Depth") == "1" {
                members += folders.filter {
                    guard $0.hasPrefix(path), $0 != path else { return false }
                    return !$0.dropFirst(path.count).dropLast().contains("/")
                }.sorted()
            }
            let rows = members.map {
                "<d:response><d:href>\($0)</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
            }.joined()
            status = 207
            data = Data(("<d:multistatus xmlns:d=\"DAV:\">"+rows+"</d:multistatus>").utf8)
        case "GET":
            if let body = files[path] { data = body } else { status = 404 }
        case "PUT":
            guard request.value(forHTTPHeaderField: "If-None-Match") == "*", let body = request.httpBody else { throw TestFailure.fixture }
            if files[path] != nil { status = 412 }
            else {
                files[path] = body
                status = 201
                if path.hasSuffix("/manifest.json"), loseManifestReply {
                    loseManifestReply = false
                    throw TestFailure.simulatedDisconnect
                }
            }
        default: throw TestFailure.fixture
        }
        guard data.count <= limit,
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:]) else {
            throw TestFailure.fixture
        }
        return .init(data: data, response: response)
    }
}

@main struct FullWebDavSyncTests {
    struct Source: Decodable {
        let platform: String
        let files: [BackupCodec.Entry]
    }
    struct Expected: Decodable {
        struct PDF: Decodable { let path: String; let sha256: String }
        let pdf: PDF
        let studyID: String
        let offlinePackageIDs: [String]
        let excludedSHA256: [String]
        let preservedSHA256: [String: [String]]
    }
    struct Fixture: Decodable {
        let sources: [Source]
        let expected: Expected
    }
    struct Credentials: Decodable {
        let account: String
        let password: String
        let folder: String
    }

    @MainActor static func main() async throws {
        let args = Array(CommandLine.arguments.dropFirst())
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf:
            URL(fileURLWithPath: "tests/fixtures/workbench/full-webdav-sync-v1.json")))
        if args.first == "--live" {
            do { try await live(args, fixture: fixture) }
            catch {
                // Live credentials are never written to logs or the test workspace.
                FileHandle.standardError.write(Data("LIVE FULL-SYNC FAILED\n".utf8))
                exit(1)
            }
            return
        }
        guard args.isEmpty else { throw TestFailure.unsafeLiveArguments }
        let sandbox = FileManager.default.temporaryDirectory.appendingPathComponent("pd-full-sync-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let roots = try fixture.sources.map { source in
            let root = sandbox.appendingPathComponent(source.platform)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
            return try seed(root, source: source)
        }
        guard roots.count == 2 else { throw TestFailure.fixture }
        let dav = SyncDAVFixture()
        let pairs = try roots.map { root in try configuration(root, folder: "PaperDigest", account: "fixture", password: "fixture",
            transport: { try await dav.request($0, limit: $1) }) }
        let interrupted = "8cdbd88f-45b0-49f9-ad97-1328469870c5"
        try pairs[1].0.appendSession(["id": interrupted, "kind": "study", "status": "interrupted", "requestIssued": true])
        do {
            _ = try await run(roots[0], pairs[0])
            throw TestFailure.fixture
        } catch let error as CloudArchiveService.CloudError where error == .transport { }
        let oldManifest = await dav.committed()
        guard oldManifest.count == 1, let firstPending = try pairs[0].1.pending(fullSync: true),
              firstPending.checkpoint != nil else { throw TestFailure.fixture }

        // Recover an older local workspace while the pre-restore upload remains pending.
        try FileManager.default.removeItem(at: roots[0].appendingPathComponent(fixture.expected.pdf.path))
        try pairs[0].1.invalidateFullSyncReceipts()
        _ = try await run(roots[1], pairs[1])
        _ = try await run(roots[0], pairs[0])
        let committed = await dav.committed()
        guard committed.count == 2, oldManifest.allSatisfy(committed.contains), try pairs[0].1.pending(fullSync: true) == nil else {
            throw TestFailure.fixture
        }
        for (index, root) in roots.enumerated() { try verify(root, source: fixture.sources[index], fixture: fixture) }
        guard let history = pairs[0].0.session(interrupted), history["status"] as? String == "interrupted",
              history["syncedHistory"] as? Bool == true,
              try RequestBudgetContinuity.fromSessions([history]).isEmpty else { throw TestFailure.fixture }
        // Publishing the post-merge workspace may add one version per device. Thereafter
        // an identical source snapshot must not create more versions.
        for (index, root) in roots.enumerated() { _ = try await run(root, pairs[index]) }
        let stable = await dav.committed()
        for (index, root) in roots.enumerated() { _ = try await run(root, pairs[index]) }
        guard await dav.committed() == stable else { throw TestFailure.fixture }
        guard let last = try pairs[0].1.lastFullSyncUpload()?.reference,
              let path = stable.first(where: { $0.contains(last.id.uuidString.lowercased()) }) else { throw TestFailure.fixture }
        let acceptedManifest = try await dav.changeManifest(path)
        do { _ = try await run(roots[0], pairs[0]); throw TestFailure.fixture }
        catch let error as CloudArchiveService.CloudError where error == .selectionChanged { }
        await dav.restoreManifest(path, bytes: acceptedManifest)
        await dav.forget(last.id)
        do { _ = try await run(roots[0], pairs[0]); throw TestFailure.fixture }
        catch let error as DesktopError {
            guard error.localizedDescription.contains("缺少本机已核验") else { throw TestFailure.fixture }
        }
        guard await dav.committed().count == stable.count - 1 else { throw TestFailure.fixture }
        print("Mac 全资料同步验证通过（共享离线包、冲突原稿、丢回执续传、恢复后重放、幂等）")
    }

    @MainActor private static func live(_ args: [String], fixture: Fixture) async throws {
        guard args.count == 3, args[2].hasPrefix("/") else { throw TestFailure.unsafeLiveArguments }
        let root = URL(fileURLWithPath: args[2], isDirectory: true).standardizedFileURL
        let fm = FileManager.default
        let temporaryRoot = fm.temporaryDirectory.resolvingSymlinksInPath().path
        guard root.resolvingSymlinksInPath().path.hasPrefix(temporaryRoot + "/"),
              root.lastPathComponent.hasPrefix("pd-") else { throw TestFailure.unsafeLiveArguments }
        guard let mac = fixture.sources.first(where: { $0.platform.lowercased() == "macos" || $0.platform.lowercased() == "mac" }) else {
            throw TestFailure.fixture
        }
        switch args[1] {
        case "seed":
            let directory = try seed(root, source: mac)
            let export = directory.appendingPathComponent("Exports/macos-full-sync.txt")
            try fm.createDirectory(at: export.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("Mac full-sync original\n".utf8).write(to: export, options: .withoutOverwriting)
            print("LIVE MAC SEEDED")
        case "sync":
            let directory = try verifiedWorkspace(root)
            let input = FileHandle.standardInput.readData(ofLength: 8193)
            guard input.count <= 8192 else { throw TestFailure.unsafeLiveArguments }
            let credentials = try JSONDecoder().decode(Credentials.self, from: input)
            guard credentials.folder.range(of: #"\APD-FullSync-QA-[a-f0-9]{12,32}\z"#, options: .regularExpression) != nil,
                  !credentials.account.isEmpty, !credentials.password.isEmpty else { throw TestFailure.unsafeLiveArguments }
            let context = try configuration(directory, folder: credentials.folder, account: credentials.account, password: credentials.password)
            let result = try await run(directory, context)
            print("LIVE MAC SYNC files=\(result.files) conflicts=\(result.conflicts)")
        case "verify":
            let directory = try verifiedWorkspace(root)
            try verify(directory, source: mac, fixture: fixture)
            let export = try PrivateStoragePaths.checkedFile(relative: "Exports/android-full-sync.txt", directory: directory)
            guard try PrivateStoragePaths.boundedData(export, limit: 4096) == Data("Android full-sync original\n".utf8) else { throw TestFailure.fixture }
            print("LIVE MAC VERIFIED")
        default: throw TestFailure.unsafeLiveArguments
        }
    }

    private static func verifiedWorkspace(_ root: URL) throws -> URL {
        let marker = try PrivateStoragePaths.checkedFile(relative: "fixture-seeded", directory: root)
        guard try Data(contentsOf: marker) == Data("full-sync-v1-fixture".utf8) else { throw TestFailure.unsafeLiveArguments }
        return try PrivateStoragePaths.checkedDirectory(root.appendingPathComponent("Research"))
    }

    private static func seed(_ root: URL, source: Source) throws -> URL {
        _ = try PrivateStoragePaths.checkedDirectory(root)
        let fm = FileManager.default
        guard try fm.contentsOfDirectory(atPath: root.path).isEmpty else { throw TestFailure.unsafeLiveArguments }
        let directory = root.appendingPathComponent("Research")
        try fm.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        for entry in source.files {
            try PrivateStoragePaths.path(entry.path)
            guard sha256(entry.data) == entry.sha256 else { throw TestFailure.fixture }
            let file = directory.appendingPathComponent(entry.path)
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            try entry.data.write(to: file, options: .withoutOverwriting)
        }
        try Data("full-sync-v1-fixture".utf8).write(to: root.appendingPathComponent("fixture-seeded"), options: .withoutOverwriting)
        return directory
    }

    typealias Context = (DesktopStore, CloudLocalStore, CloudArchiveService)
    @MainActor private static func configuration(_ root: URL, folder: String, account: String, password: String,
        transport: CloudArchiveService.Transport? = nil) throws -> Context {
        let store = try DesktopStore(directory: root)
        let local = try CloudLocalStore(dataDirectory: root)
        try local.save(account: account, folder: folder, automatic: false, intervalHours: 24)
        let destination = local.profile.destinationID
        let service = try CloudArchiveService(folder: folder, destinationID: destination,
            credentials: { .init(username: account, password: password) },
            checkpointSink: { checkpoint in
                try await local.saveCheckpoint(checkpoint, destinationID: destination, sha256: checkpoint.sha256, fullSync: true)
            }, transport: transport, minimumRequestInterval: transport == nil ? 3.1 : 0,
            initialRetryAfter: local.profile.retryAfter, cooldownSink: { until in
                try await local.recordCooldown(until, destinationID: destination)
            }, fullSync: true)
        return (store, local, service)
    }

    @MainActor private static func run(_ root: URL, _ context: Context) async throws -> FullWebDavWorkspace.Result {
        try await FullWebDavWorkspace.run(directory: root, store: context.0, local: context.1, service: context.2)
    }

    @MainActor private static func verify(_ root: URL, source: Source, fixture: Fixture) throws {
        let expected = fixture.expected
        let pdf = try PrivateStoragePaths.checkedFile(relative: expected.pdf.path, directory: root)
        guard try PrivateStoragePaths.sha256File(pdf) == expected.pdf.sha256 else { throw TestFailure.fixture }
        for id in expected.offlinePackageIDs {
            try DesktopStorage.validateSynchronizedPackage(root.appendingPathComponent("Offline/" + id), id: id)
        }
        let local = try CloudLocalStore(dataDirectory: root)
        let inbox = try local.fullSyncInbox()
        let snapshots = try FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)
        var seen = Set<String>()
        for snapshot in snapshots {
            let file = try PrivateStoragePaths.checkedFile(relative: snapshot.lastPathComponent + "/原始资料.paperdigest", directory: inbox)
            let payload = try BackupCodec.parse(PrivateStoragePaths.boundedData(file, limit: BackupCodec.maxEncodedBytes))
            seen.formUnion(payload.files.map(\.sha256))
        }
        guard expected.preservedSHA256.values.flatMap({$0}).allSatisfy(seen.contains),
              !expected.excludedSHA256.contains(where: seen.contains) else { throw TestFailure.fixture }
        for entry in source.files where entry.path.hasPrefix("ModelUsage/" + expected.studyID + "-") {
            let file = try PrivateStoragePaths.checkedFile(relative: entry.path, directory: root)
            guard try PrivateStoragePaths.sha256File(file) == entry.sha256 else { throw TestFailure.fixture }
        }
    }
}
