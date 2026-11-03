import Foundation

/// Synchronizes immutable artifacts additively. Originals of remote versions
/// are stored outside the active workspace before adopting any files.
@MainActor enum FullWebDavWorkspace {
    typealias Object = [String: Any]
    struct Result: Codable {
        var files = 0
        var conflicts = 0
    }

    static func group(_ path: String) -> String? {
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 2, !BackupCodec.isLocalOnlyKey(path) else { return nil }
        switch parts[0] {
        case "Imports":
            let name = parts[1]
            guard parts.count == 2, name.hasSuffix(".pdf"), PrivateStoragePaths.validSHA(String(name.dropLast(4))) else { return nil }
            return path
        case "Exports":
            return path
        case "Offline":
            guard parts.count >= 3, PrivateStoragePaths.validSHA(parts[1]) else { return nil }
            return "Offline/" + parts[1]
        case "ModelUsage":
            let suffixes = ["-input.json", "-response.json", "-usage.json", "-response.raw", "-response.bin"]
            guard parts.count == 2 else { return nil }
            if let suffix = suffixes.first(where: { parts[1].hasSuffix($0) }) {
                let id = String(parts[1].dropLast(suffix.count))
                if UUID(uuidString: id) != nil { return "ModelUsage/" + id }
            }
            if parts[1].hasSuffix(".json"), UUID(uuidString: String(parts[1].dropLast(5))) != nil {
                return "ModelUsage/" + String(parts[1].dropLast(5))
            }
            return nil
        case "zotero-archives", "ZoteroArchives", "ZoteroDavArchives":
            return parts.prefix(2).joined(separator: "/")
        case "PublishedLibrary":
            guard parts.count == 3, parts[1] == "pdf", parts[2].hasSuffix(".pdf"),
                  PrivateStoragePaths.validSHA(String(parts[2].dropLast(4))) else { return nil }
            return path
        default: return nil
        }
    }

    static func capture(directory: URL) throws -> BackupCodec.Payload {
        let captured = try BackupCodec.collect(sourceDirectory: directory) {
            $0 == "personal.json" || $0 == PrivateStoragePaths.aliasesFilename || group($0) != nil
        }
        guard let original = captured.files.first(where: { $0.path == "personal.json" }) else { throw CloudArchiveService.CloudError.invalidBackup }
        let personal = try object(original.data)
        var shared = personal.filter { ["contract", "schemaFingerprint", "schema", "personalPapers", "sessions"].contains($0.key) }
        shared["sessions"] = (shared["sessions"] as? [Object] ?? []).filter { record in
            record["syncedHistory"] as? Bool != true && !["pending", "running", "queued"].contains(record["status"] as? String ?? "")
        }
        shared["jobs"] = [Object]()
        shared["notes"] = Object()
        shared["annotations"] = Object()
        shared["readingState"] = Object()
        shared["reading"] = [String]()
        shared["favorites"] = [String]()
        shared["settings"] = Object()
        try DesktopStore.validate(shared)
        let data = try json(shared)
        let personalEntry = BackupCodec.Entry(path: "personal.json", sha256: sha256(data), data: data)
        return BackupCodec.Payload(sourceDirectory: captured.sourceDirectory,
            files: (captured.files.filter { $0.path != "personal.json" } + [personalEntry]).sorted { $0.path < $1.path })
    }

    static func merge(_ payload: BackupCodec.Payload, directory: URL, store: DesktopStore, retainedFolder: URL? = nil, payloadSHA: String? = nil) throws -> Result {
        try BackupCodec.validate(payload)
        try BackupCodec.requirePortable(payload)
        let remote = try object(payload.files.first { $0.path == "personal.json" }!.data)
        try DesktopStore.validate(remote)
        var result = Result()
        var groups: [String: [BackupCodec.Entry]] = [:]
        for entry in payload.files where entry.path != "personal.json" && entry.path != PrivateStoragePaths.aliasesFilename {
            guard let key = group(entry.path) else { result.conflicts += 1; continue }
            groups[key, default: []].append(entry)
        }
        var conflicted = Set<String>()
        func preserveConflict(_ entries: [BackupCodec.Entry]) throws {
            guard let retainedFolder else { return }
            let root = try makeDirectories("冲突原件", root: retainedFolder)
            for entry in entries {
                switch try existing(entry, directory: root) {
                case .same: continue
                case .different: throw CloudArchiveService.CloudError.integrity
                case .absent: try install(entry.data, relative: entry.path, root: root)
                }
            }
        }
        var archiveVersion = payloadSHA
        for key in groups.keys.sorted() {
            try Task.checkCancellation()
            let entries = groups[key]!
            if ["zotero-archives/", "ZoteroArchives/", "ZoteroDavArchives/"].contains(where: key.hasPrefix) {
                if try entries.allSatisfy({ try existing($0, directory: directory) == .same }) { continue }
                if archiveVersion == nil { archiveVersion = sha256(try BackupCodec.encode(payload)) }
                guard let version = archiveVersion, PrivateStoragePaths.validSHA(version) else { throw CloudArchiveService.CloudError.integrity }
                let root = try makeDirectories("SyncedArchiveHistory/" + version, root: directory)
                for entry in entries {
                    switch try existing(entry, directory: root) {
                    case .same: continue
                    case .different: throw CloudArchiveService.CloudError.integrity
                    case .absent:
                        try install(entry.data, relative: entry.path, root: root)
                        result.files += 1
                    }
                }
                continue
            }
            if key.hasPrefix("Imports/") || key.hasPrefix("PublishedLibrary/pdf/") {
                guard let entry = entries.first, key.hasSuffix(entry.sha256 + ".pdf"),
                      entry.data.starts(with: Data("%PDF-".utf8)) else {
                    result.conflicts += 1; conflicted.insert(key); try preserveConflict(entries); continue
                }
            }
            let inventory = try entries.map { entry in
                try (entry, existing(entry, directory: directory))
            }
            if inventory.contains(where: { $0.1 == .different }) {
                result.conflicts += 1
                conflicted.insert(key)
                try preserveConflict(entries)
                continue
            }
            if key.hasPrefix("Offline/") {
                // A package is exposed only after every registered file is
                // written and the entire package passes the normal reader check.
                let missing = inventory.filter { $0.1 == .absent }.count
                if missing == 0 { continue }
                let package = directory.appendingPathComponent(key)
                let installed = !present(package) ? try installOffline(entries, key: key, directory: directory) : false
                if !installed {
                    result.conflicts += 1
                    conflicted.insert(key)
                    try preserveConflict(entries)
                } else { result.files += missing }
                continue
            }
            for (entry, state) in inventory where state == .absent {
                try install(entry.data, relative: entry.path, root: directory)
                result.files += 1
            }
        }

        var current = store.snapshot()
        var papers = current["personalPapers"] as? [String: Object] ?? [:]
        for (id, record) in remote["personalPapers"] as? [String: Object] ?? [:] {
            var record = record
            if record["sourceKind"] as? String == "local" {
                guard let sha = record["pdfSHA"] as? String, PrivateStoragePaths.validSHA(sha),
                      let file = try? PrivateStoragePaths.checkedFile(relative: "Imports/" + sha + ".pdf", directory: directory),
                      try PrivateStoragePaths.sha256File(file) == sha else { result.conflicts += 1; continue }
                record["localPDFPath"] = file.path
            }
            if let prior = papers[id] {
                if try json(prior) != json(record) { result.conflicts += 1 }
            } else {
                try DesktopStore.validatePaper(record, id: id)
                papers[id] = record
            }
        }
        if !papers.isEmpty { current["personalPapers"] = papers }
        var sessions = current["sessions"] as? [Object] ?? []
        let ids = sessions.reduce(into: [String: Object]()) { map, row in
            if let id = row["id"] as? String { map[id] = row }
        }
        var seen = Set(ids.keys)
        for row in remote["sessions"] as? [Object] ?? [] {
            guard let id = row["id"] as? String, UUID(uuidString: id) != nil,
                  let state = row["status"] as? String, ["completed", "failed", "complete", "error", "interrupted", "cancelled", "canceled"].contains(state),
                  !conflicted.contains("ModelUsage/" + id) else { result.conflicts += 1; continue }
            var history = row
            history["syncedHistory"] = true
            if let prior = ids[id] {
                if try json(prior) != json(row) && json(prior) != json(history) { result.conflicts += 1 }
            } else if seen.insert(id).inserted {
                sessions.append(history)
            } else { result.conflicts += 1 }
        }
        current["sessions"] = sessions
        let inherited = try payload.files.first { $0.path == PrivateStoragePaths.aliasesFilename }
            .map { try PrivateStoragePaths.decodeRoots($0.data) } ?? []
        try addSourceRoots([payload.sourceDirectory] + inherited, directory: directory)
        try store.restorePersonal(current)
        return result
    }

    static func run(directory: URL, store: DesktopStore, local: CloudLocalStore, service: CloudArchiveService,
                    beforeCapture: () async throws -> Void = {}, beforeReceive: () async throws -> Void = {},
                    exclusive: (Bool) -> Void = { _ in }) async throws -> Result {
        let inbox = try local.fullSyncInbox()
        let generation = try local.fullSyncGeneration()
        let originalUpload = try local.lastFullSyncUpload()
        if try local.pending(fullSync: true) == nil {
            try await beforeCapture()
            exclusive(true)
            do {
                let snapshot = try capture(directory: directory)
                let sha = sha256(try BackupCodec.encode(snapshot))
                if originalUpload?.sha256 != sha {
                    _ = try local.prepare(snapshot, fullSync: true)
                }
                exclusive(false)
            } catch { exclusive(false); throw error }
        }
        if let pending = try local.pending(fullSync: true) {
            let bytes = try local.bytes(for: pending, fullSync: true)
            let snapshot = try await service.upload(encodedBackup: bytes, resuming: pending.checkpoint)
            // Upload completion cannot imply adoption into a restored workspace.
            _ = try retain(bytes, snapshot: snapshot, inbox: inbox)
            try local.complete(snapshot, destinationID: pending.destinationID, fullSync: true)
        }
        var expected = [originalUpload, try local.lastFullSyncUpload()].compactMap { $0 }
        var combined = Result()
        for month in try await service.fullSyncMonths() {
            for (snapshot, manifestSHA) in try await service.listIdentities(month: month) {
                expected.removeAll { upload in
                    upload.sha256 == snapshot.sha256 && (upload.reference == nil || upload.reference == snapshot.reference)
                }
                try Task.checkCancellation()
                if try alreadyReceived(snapshot, inbox: inbox, generation: generation, manifestSHA: manifestSHA) { continue }
                let bytes: Data
                if let cached = try retained(snapshot, inbox: inbox) { bytes = cached }
                else { bytes = try await service.download(reference: snapshot.reference, expectedManifestSHA: manifestSHA) }
                try await beforeReceive()
                try Task.checkCancellation()
                exclusive(true)
                let result: Result
                do {
                    result = try receive(bytes, snapshot: snapshot, directory: directory, store: store,
                        inbox: inbox, generation: generation, manifestSHA: manifestSHA)
                    exclusive(false)
                } catch { exclusive(false); throw error }
                combined.files += result.files
                combined.conflicts += result.conflicts
            }
        }
        guard expected.isEmpty else {
            throw DesktopError.message("云端列表缺少本机已核验的同步版本；本机原件已保留")
        }
        return combined
    }

    static func receive(_ bytes: Data, snapshot: CloudArchiveService.SnapshotInfo,
                        directory: URL, store: DesktopStore, inbox: URL, generation: String = "initial", manifestSHA: String? = nil) throws -> Result {
        let payload = try BackupCodec.parse(bytes)
        try BackupCodec.requirePortable(payload)
        let folder = try retain(bytes, snapshot: snapshot, inbox: inbox)
        let result = try merge(payload, directory: directory, store: store, retainedFolder: folder, payloadSHA: snapshot.sha256)
        try record(result, snapshot: snapshot, folder: folder, generation: generation, manifestSHA: manifestSHA)
        return result
    }

    private static let retainedName = "原始资料.paperdigest"
    private static func retain(_ bytes: Data, snapshot: CloudArchiveService.SnapshotInfo, inbox: URL) throws -> URL {
        guard sha256(bytes) == snapshot.sha256, bytes.count == snapshot.encodedBytes else { throw CloudArchiveService.CloudError.integrity }
        let id = snapshot.reference.id.uuidString.lowercased()
        let folder = try makeDirectories(id, root: inbox)
        if try retained(snapshot, inbox: inbox, loadBytes: false) == nil {
            try install(bytes, relative: retainedName, root: folder)
        }
        return folder
    }

    private static func retained(_ snapshot: CloudArchiveService.SnapshotInfo, inbox: URL, loadBytes: Bool = true) throws -> Data? {
        let relative = snapshot.reference.id.uuidString.lowercased() + "/" + retainedName
        guard present(inbox.appendingPathComponent(relative)) else { return nil }
        let file = try PrivateStoragePaths.checkedFile(relative: relative, directory: inbox)
        if loadBytes {
            let bytes = try PrivateStoragePaths.boundedData(file, limit: BackupCodec.maxEncodedBytes)
            guard bytes.count == snapshot.encodedBytes, sha256(bytes) == snapshot.sha256 else { throw CloudArchiveService.CloudError.integrity }
            return bytes
        }
        guard try PrivateStoragePaths.sha256File(file) == snapshot.sha256 else { throw CloudArchiveService.CloudError.integrity }
        return Data()
    }

    private static func record(_ result: Result, snapshot: CloudArchiveService.SnapshotInfo, folder: URL, generation: String,
                               manifestSHA: String?) throws {
        if let manifestSHA, !PrivateStoragePaths.validSHA(manifestSHA) { throw CloudArchiveService.CloudError.integrity }
        let receipt = try JSONEncoder().encode(Receipt(sha256: snapshot.sha256, generation: generation, result: result, manifestSHA: manifestSHA))
        try receipt.write(to: folder.appendingPathComponent("receipt.json"), options: [.atomic])
    }

    struct Receipt: Codable { let sha256: String; let generation: String; let result: Result; let manifestSHA: String? }
    static func alreadyReceived(_ snapshot: CloudArchiveService.SnapshotInfo, inbox: URL, generation: String = "initial",
                                manifestSHA: String? = nil) throws -> Bool {
        let id = snapshot.reference.id.uuidString.lowercased()
        let relative = id + "/receipt.json"
        guard present(inbox.appendingPathComponent(relative)) else { return false }
        let file = try PrivateStoragePaths.checkedFile(relative: relative, directory: inbox)
        let record = try JSONDecoder().decode(Receipt.self, from: PrivateStoragePaths.boundedData(file, limit: 4096))
        guard record.sha256 == snapshot.sha256, try retained(snapshot, inbox: inbox, loadBytes: false) != nil else {
            throw CloudArchiveService.CloudError.integrity
        }
        if let accepted = record.manifestSHA, let manifestSHA, accepted != manifestSHA {
            throw CloudArchiveService.CloudError.selectionChanged
        }
        return record.generation == generation && (manifestSHA == nil || record.manifestSHA != nil)
    }

    private static func addSourceRoots(_ incoming: [String], directory: URL) throws {
        let original = try PrivateStoragePaths.loadRoots(directory: directory)
        var roots = original
        // A source root is only a path hint. Readers still require the exact
        // digest before relocating original PDF or sealed research input.
        for source in incoming where source != directory.path && !roots.contains(source) {
            if (try? PrivateStoragePaths.validateRoots([directory.path] + roots + [source])) != nil {
                roots.append(source)
            }
        }
        guard roots != original else { return }
        let map = directory.appendingPathComponent(PrivateStoragePaths.aliasesFilename)
        let data = try JSONEncoder().encode(PrivateStoragePaths.RootMap(roots: roots.sorted()))
        try data.write(to: map, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: map.path)
    }

    private enum Existing { case absent, same, different }
    private static func existing(_ entry: BackupCodec.Entry, directory: URL) throws -> Existing {
        let url = directory.appendingPathComponent(entry.path)
        guard present(url) else { return .absent }
        guard let file = try? PrivateStoragePaths.checkedFile(relative: entry.path, directory: directory) else { return .different }
        return try PrivateStoragePaths.sha256File(file) == entry.sha256 ? .same : .different
    }

    private static func present(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true ||
            FileManager.default.fileExists(atPath: url.path)
    }

    private static func makeDirectories(_ relative: String, root: URL) throws -> URL {
        try PrivateStoragePaths.path(relative)
        var cursor = try PrivateStoragePaths.checkedDirectory(root)
        for part in relative.split(separator: "/") {
            cursor.appendPathComponent(String(part), isDirectory: true)
            if !present(cursor) {
                try FileManager.default.createDirectory(at: cursor, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            }
            _ = try PrivateStoragePaths.checkedDirectory(cursor)
        }
        return cursor
    }

    private static func install(_ data: Data, relative: String, root: URL) throws {
        try PrivateStoragePaths.path(relative)
        let target = root.appendingPathComponent(relative)
        let parent = (relative as NSString).deletingLastPathComponent
        if !parent.isEmpty { _ = try makeDirectories(parent, root: root) }
        let temp = target.deletingLastPathComponent().appendingPathComponent(".full-sync-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temp) }
        try data.write(to: temp, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp.path)
        // A hard link atomically creates the final name without replacing an existing name.
        try FileManager.default.linkItem(at: temp, to: target)
    }

    private static func installOffline(_ entries: [BackupCodec.Entry], key: String, directory: URL) throws -> Bool {
        let offline = try makeDirectories("Offline", root: directory)
        let stage = try makeDirectories(".prepare-full-sync-" + UUID().uuidString, root: offline)
        defer { try? FileManager.default.removeItem(at: stage) }
        for entry in entries {
            try install(entry.data, relative: String(entry.path.dropFirst(key.count + 1)), root: stage)
        }
        let id = String(key.dropFirst("Offline/".count))
        guard (try? DesktopStorage.validateSynchronizedPackage(stage, id: id)) != nil else { return false }
        try FileManager.default.moveItem(at: stage, to: directory.appendingPathComponent(key))
        return true
    }

    private static func object(_ data: Data) throws -> Object {
        guard let value = try JSONSerialization.jsonObject(with: data) as? Object else { throw CloudArchiveService.CloudError.invalidBackup }
        return value
    }
    private static func json(_ value: Object) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
}
