import Foundation

/// Device connection and upload control live beside, never inside, the research
/// directory. Restoring an old research snapshot cannot change the cloud account
/// or recursively include the pending encoded backup in the next snapshot.
@MainActor final class CloudLocalStore {
    struct Completed: Codable, Sendable {
        let month: String
        let id: UUID
        let createdAt: String
        let encodedBytes: Int
    }
    struct Profile: Codable, Sendable {
        var contract = "paperdigest-cloud-profile-v1"
        var destinationID = UUID()
        var account = ""
        var folder = "PaperDigest"
        var automatic = false
        var intervalHours = 24
        var lastAttemptAt: Date?
        var lastBackup: Completed?
        var automaticPaused: Bool?
    }
    struct Pending: Codable, Sendable {
        let contract: String
        let destinationID: UUID
        let createdAt: String
        let fileCount: Int
        let encodedBytes: Int
        let sha256: String
        var checkpoint: CloudArchiveService.UploadCheckpoint?
    }
    let root: URL
    private(set) var profile: Profile
    private let encoder: JSONEncoder
    init(dataDirectory: URL) throws {
        root = dataDirectory.deletingLastPathComponent().appendingPathComponent(dataDirectory.lastPathComponent + "Cloud", isDirectory: true)
        encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        if FileManager.default.fileExists(atPath: root.path) {
            _ = try PrivateStoragePaths.checkedDirectory(root)
        } else {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        let file = root.appendingPathComponent("profile.json")
        if FileManager.default.fileExists(atPath: file.path) {
            let checked = try PrivateStoragePaths.checkedFile(relative: "profile.json", directory: root)
            profile = try JSONDecoder().decode(Profile.self, from: PrivateStoragePaths.boundedData(checked, limit: 64 * 1024))
            try Self.validate(profile)
        } else {
            guard (try? file.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) != true else { throw DesktopError.message("云连接配置不能是链接") }
            profile = Profile()
        }
    }
    static func validate(_ value: Profile) throws {
        guard value.contract == "paperdigest-cloud-profile-v1", value.account.utf8.count <= 320,
              !value.account.contains(":"), !value.account.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              value.folder.range(of: "\\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\z", options: .regularExpression) != nil,
              !value.folder.contains(".."), value.folder.lowercased() != "zotero", (6...168).contains(value.intervalHours) else {
            throw DesktopError.message("坚果云账号、独立目录或备份间隔无效")
        }
    }
    func save(account: String, folder: String, automatic: Bool, intervalHours: Int) throws {
        var next = profile
        let account = account.trimmingCharacters(in: .whitespacesAndNewlines)
        if account != next.account || folder != next.folder {
            guard try !hasPendingMaterials() else { throw DesktopError.message("原快照尚未完成，请先续传或原样保留材料，再更换账号或目录") }
            next.destinationID = UUID(); next.lastBackup = nil; next.lastAttemptAt = nil; next.automaticPaused = nil
        }
        next.account = account; next.folder = folder; next.automatic = automatic; next.intervalHours = intervalHours
        try Self.validate(next)
        guard !account.isEmpty || !automatic else { throw DesktopError.message("请先保存坚果云账号再开启自动备份") }
        try write(next, relative: "profile.json"); profile = next
    }
    func recordAttempt() throws {
        var next = profile; next.lastAttemptAt = Date()
        try write(next, relative: "profile.json"); profile = next
    }
    func pauseAutomatic(_ paused: Bool) throws {
        var next = profile; next.automaticPaused = paused
        try write(next, relative: "profile.json"); profile = next
    }
    private func pendingFolder(_ id: UUID) throws -> URL {
        let relative = id.uuidString
        let folder = root.appendingPathComponent(relative, isDirectory: true)
        if FileManager.default.fileExists(atPath: folder.path) { _ = try PrivateStoragePaths.checkedDirectory(folder) }
        else { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        return folder
    }
    func pending() throws -> Pending? {
        let relative = profile.destinationID.uuidString + "/pending.json"
        let file = root.appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: file.path) else {
            if (try? file.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true { throw DesktopError.message("云备份控制文件不能是链接") }
            return nil
        }
        let checked = try PrivateStoragePaths.checkedFile(relative: relative, directory: root)
        let value = try JSONDecoder().decode(Pending.self, from: PrivateStoragePaths.boundedData(checked, limit: 4 * 1024 * 1024))
        guard value.contract == "paperdigest-cloud-pending-v1", value.destinationID == profile.destinationID,
              value.encodedBytes > 0, value.encodedBytes <= BackupCodec.maxEncodedBytes,
              (1...BackupCodec.maxEntries).contains(value.fileCount), PrivateStoragePaths.validSHA(value.sha256) else {
            throw DesktopError.message("云备份续传记录无效；原材料已保留")
        }
        return value
    }
    func hasPendingMaterials() throws -> Bool {
        let folder = root.appendingPathComponent(profile.destinationID.uuidString, isDirectory: true)
        guard FileManager.default.fileExists(atPath: folder.path) else { return false }
        _ = try PrivateStoragePaths.checkedDirectory(folder)
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path)
        return names.contains("pending.json") || names.contains("snapshot.paperdigest")
    }
    func prepare(_ payload: BackupCodec.Payload) throws -> Pending {
        guard try !hasPendingMaterials() else { throw DesktopError.message("请先续传或原样保留未完成材料；不会覆盖原快照") }
        let bytes = try BackupCodec.encode(payload)
        let next = Pending(contract: "paperdigest-cloud-pending-v1", destinationID: profile.destinationID,
                           createdAt: ISO8601DateFormatter().string(from: Date()), fileCount: payload.files.count,
                           encodedBytes: bytes.count, sha256: PrivateStoragePaths.sha256(bytes), checkpoint: nil)
        let folder = try pendingFolder(profile.destinationID)
        try bytes.write(to: folder.appendingPathComponent("snapshot.paperdigest"), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: folder.appendingPathComponent("snapshot.paperdigest").path)
        try write(next, relative: profile.destinationID.uuidString + "/pending.json")
        return next
    }
    func bytes(for pending: Pending) throws -> Data {
        guard pending.destinationID == profile.destinationID else { throw DesktopError.message("云目标已变化，未读取其他目标的快照") }
        let file = try PrivateStoragePaths.checkedFile(relative: profile.destinationID.uuidString + "/snapshot.paperdigest", directory: root)
        let bytes = try PrivateStoragePaths.boundedData(file, limit: BackupCodec.maxEncodedBytes)
        guard bytes.count == pending.encodedBytes, PrivateStoragePaths.sha256(bytes) == pending.sha256 else {
            throw DesktopError.message("原续传快照字节已变化，未上传不同材料")
        }
        let payload = try BackupCodec.parse(bytes)
        guard payload.files.count == pending.fileCount else { throw DesktopError.message("原续传快照文件数与实际材料不符") }
        return bytes
    }
    func saveCheckpoint(_ checkpoint: CloudArchiveService.UploadCheckpoint, destinationID: UUID, sha256: String) throws {
        guard profile.destinationID == destinationID, var old = try pending(), old.sha256 == sha256 else {
            throw DesktopError.message("云目标或原快照已变化，未覆盖续传记录")
        }
        guard checkpoint.destinationID == destinationID, checkpoint.folder == profile.folder,
              checkpoint.sha256 == old.sha256, checkpoint.encodedBytes == old.encodedBytes else {
            throw DesktopError.message("云续传回执与原快照不符")
        }
        if let original = old.checkpoint {
            guard checkpoint.reference == original.reference, checkpoint.createdAt == original.createdAt, checkpoint.chunks == original.chunks else {
                throw DesktopError.message("云续传不能更换已绑定的原版本或分块")
            }
        }
        old.checkpoint = checkpoint
        try write(old, relative: destinationID.uuidString + "/pending.json")
    }
    func complete(_ info: CloudArchiveService.SnapshotInfo, destinationID: UUID, keepAutomaticPaused: Bool = false) throws {
        guard profile.destinationID == destinationID, let pending = try pending(),
              pending.sha256 == info.sha256, pending.encodedBytes == info.encodedBytes,
              let checkpoint = pending.checkpoint, checkpoint.manifestVerified,
              checkpoint.destinationID == destinationID, checkpoint.folder == profile.folder,
              checkpoint.reference == info.reference, checkpoint.createdAt == info.createdAt,
              checkpoint.chunks.count == info.chunkCount,
              Set(checkpoint.verifiedChunkIndices) == Set(checkpoint.chunks.indices) else { throw DesktopError.message("云端完成回执没有完整绑定原快照") }
        var next = profile
        next.automaticPaused = keepAutomaticPaused
        next.lastBackup = Completed(month: info.reference.month, id: info.reference.id, createdAt: ISO8601DateFormatter().string(from: info.createdAt), encodedBytes: info.encodedBytes)
        try write(next, relative: "profile.json"); profile = next
        // Remote manifest and every stored chunk have already been read back.
        // A cleanup failure keeps a resumable local record, never fakes success.
        let folder = try pendingFolder(destinationID)
        let finished = root.appendingPathComponent("completed-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.moveItem(at: folder, to: finished)
        try? FileManager.default.removeItem(at: finished)
    }
    func archivePending() throws -> URL {
        guard try hasPendingMaterials() else { throw DesktopError.message("当前没有未完成的云端快照") }
        let folder = try pendingFolder(profile.destinationID)
        let existing = try FileManager.default.contentsOfDirectory(atPath: folder.path)
        let connection = existing.contains("connection.json") ? "connection-" + UUID().uuidString + ".json" : "connection.json"
        try write(profile, relative: profile.destinationID.uuidString + "/" + connection)
        let retained = root.appendingPathComponent("archived-" + UUID().uuidString, isDirectory: true)
        // One atomic rename retains every original byte and checkpoint. No
        // remote request or deletion, credential copy or target change occurs.
        try FileManager.default.moveItem(at: folder, to: retained)
        return retained
    }
    private func write<T: Encodable>(_ value: T, relative: String) throws {
        try PrivateStoragePaths.path(relative)
        let parent = root.appendingPathComponent(relative).deletingLastPathComponent()
        _ = try PrivateStoragePaths.checkedDirectory(parent)
        let data = try encoder.encode(value), file = root.appendingPathComponent(relative)
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
