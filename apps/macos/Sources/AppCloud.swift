import AppKit
import Security

enum CloudCredentialVault {
    private static let service = "com.nanless.PaperDigest.cloud"
    static func load(_ destination: UUID) throws -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: destination.uuidString, kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw DesktopError.message("系统未允许读取本应用的网盘密码，请处理 macOS 钥匙串提示")
        }
        return value
    }
    static func save(_ text: String, destination: UUID) throws {
        guard !text.isEmpty, text.utf8.count <= 4096, !text.contains("\r"), !text.contains("\n") else { throw DesktopError.message("应用专用密码不能为空或含换行") }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: destination.uuidString]
        let attributes: [String: Any] = [kSecValueData as String: Data(text.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(attributes) { _, value in value } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw DesktopError.message("未能保存网盘应用密码，原资料保留") }
    }
    static func remove(_ destination: UUID) throws {
        let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: destination.uuidString] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DesktopError.message("未能移除本应用保存的网盘密码") }
    }
}

private actor CloudCredentialSession {
    let destination: UUID
    let account: String
    var cached: CloudArchiveService.Credentials?
    init(destination: UUID, account: String) { self.destination = destination; self.account = account }
    func credentials() async throws -> CloudArchiveService.Credentials {
        if let cached { return cached }
        let destination = destination
        let password = try await Task.detached(priority: .userInitiated) { try CloudCredentialVault.load(destination) }.value
        try Task.checkCancellation()
        guard let password, !password.isEmpty else { throw DesktopError.message("请先使用安全输入保存坚果云应用专用密码") }
        let value = CloudArchiveService.Credentials(username: account, password: password); cached = value
        return value
    }
}

@MainActor extension PaperDigestApp {
    func cloudLocalStore() throws -> CloudLocalStore {
        if let cloudLocal { return cloudLocal }
        let value = try CloudLocalStore(dataDirectory: directory); cloudLocal = value; return value
    }
    func cloudState() throws -> [String: Any] {
        let local = try cloudLocalStore(), profile = local.profile
        var state: [String: Any] = ["account": profile.account, "folder": profile.folder, "automatic": profile.automatic,
                                    "intervalHours": profile.intervalHours, "credentialState": cloudCredentialState,
                                    "busy": cloudBusy]
        if let cloudActiveJobID { state["activeJobID"] = cloudActiveJobID }
        if let cloudLastError { state["lastError"] = cloudLastError }
        else if profile.automaticPaused == true || cloudAutomaticPausedInMemory { state["lastError"] = "自动备份已暂停，请主动检查连接后继续" }
        do {
            if let pending = try local.pending() { state["pending"] = ["createdAt": pending.createdAt, "encodedBytes": pending.encodedBytes, "fileCount": pending.fileCount] }
            else if try local.hasPendingMaterials() { state["pending"] = ["damaged": true]; state["lastError"] = "未完成材料缺少有效检查点；可原样保留并停止续传，不能认定这份材料已完整" }
        } catch {
            state["pending"] = ["damaged": true]; state["lastError"] = "未完成材料无法正常读取；可在本机原样保留并停止续传，损坏文件需要手动核对"
        }
        if let backup = profile.lastBackup { state["lastBackup"] = ["month": backup.month, "id": backup.id.uuidString, "createdAt": backup.createdAt, "encodedBytes": backup.encodedBytes] }
        return state
    }
    func cloudService() throws -> CloudArchiveService {
        if let cloudArchive { return cloudArchive }
        let local = try cloudLocalStore(), profile = local.profile
        guard !profile.account.isEmpty else { throw DesktopError.message("请先保存坚果云账号") }
        let access = CloudCredentialSession(destination: profile.destinationID, account: profile.account)
        let service = try CloudArchiveService(folder: profile.folder, destinationID: profile.destinationID,
            credentials: { try await access.credentials() }, checkpointSink: { [weak self] checkpoint in
                guard let owner = self else { throw DesktopError.message("应用已退出，未保存续传记录") }
                try await owner.saveCloudCheckpoint(checkpoint, destinationID: profile.destinationID)
            })
        cloudArchive = service; return service
    }
    func saveCloudCheckpoint(_ checkpoint: CloudArchiveService.UploadCheckpoint, destinationID: UUID) throws {
        try cloudLocalStore().saveCheckpoint(checkpoint, destinationID: destinationID, sha256: checkpoint.sha256)
        if let job = cloudActiveJobID {
            recordProgress(id: job, update: ["phase": "cloud-readback", "message": checkpoint.manifestVerified ? "云端完整清单已回读" : "逐块上传并回读核验", "completed": checkpoint.verifiedChunkIndices.count, "total": checkpoint.chunks.count])
        }
        emit("cloud.changed")
    }
    func performCloudJob(_ command: String, material: [String: Any]? = nil, operation: @escaping () async throws -> [String: Any]) async throws -> [String: Any] {
        let identifier = UUID().uuidString
        cloudActiveJobID = identifier; emit("cloud.changed")
        defer { cloudActiveJobID = nil; emit("cloud.changed") }
        return try await runJob(command, payload: [:], identifier: identifier, material: material) { _ in try await operation() }
    }
    func dispatchCloud(_ command: String, payload: [String: Any]) async throws -> [String: Any] {
        if command == "cloud.state" { return try cloudState() }
        try requireMainContextAvailable()
        if command == "cloud.revealTransfers" {
            NSWorkspace.shared.activateFileViewerSelecting([try cloudLocalStore().root]); return ["opened": true]
        }
        guard !cloudBusy, !terminationPending, !maintenanceBusy else { throw DesktopError.message("已有云端操作或资料整理正在进行，请稍后再操作") }
        let local = try cloudLocalStore()
        if command == "cloud.save" {
            guard let account = payload["account"] as? String, let folder = payload["folder"] as? String,
                  let automatic = payload["automatic"] as? Bool, let interval = payload["intervalHours"] as? Int,
                  let rawAutomatic = payload["automatic"], let rawInterval = payload["intervalHours"],
                  CFGetTypeID(rawAutomatic as CFTypeRef) == CFBooleanGetTypeID(),
                  CFGetTypeID(rawInterval as CFTypeRef) != CFBooleanGetTypeID() else { throw DesktopError.message("坚果云连接设置无效") }
            let previous = local.profile.destinationID
            try local.save(account: account, folder: folder, automatic: automatic, intervalHours: interval)
            if local.profile.destinationID != previous { cloudArchive = nil; cloudCredentialState = "unknown"; cloudLastError = nil; cloudAutomaticPausedInMemory = false }
            configureCloudSchedule(); emit("cloud.changed"); return try cloudState()
        }
        if command == "cloud.setPassword" {
            guard !local.profile.account.isEmpty else { throw DesktopError.message("请先保存坚果云账号和独立目录") }
            let destination = local.profile.destinationID
            let alert = NSAlert(); alert.messageText = "保存坚果云应用专用密码"
            alert.informativeText = "请为论文速递单独生成应用密码。密码只保存在本应用的 macOS 钥匙串，不进入网页、备份、诊断或仓库。"
            let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 26)); field.placeholderString = "输入坚果云应用专用密码"; alert.accessoryView = field
            alert.addButton(withTitle: "保存到钥匙串"); alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else { throw DesktopOperationCancelled("已取消，原网盘连接保留") }
            defer { field.stringValue = "" }
            guard destination == local.profile.destinationID else { throw DesktopError.message("云目标已变化，未保存到其他账号") }
            try CloudCredentialVault.save(field.stringValue, destination: destination)
            cloudArchive = nil; cloudCredentialState = "confirmed"; emit("cloud.changed"); return try cloudState()
        }
        if command == "cloud.deletePassword" {
            try CloudCredentialVault.remove(local.profile.destinationID)
            cloudArchive = nil; cloudCredentialState = "missing"; cloudAutomaticPausedInMemory = true
            emit("cloud.changed")
            try local.pauseAutomatic(true); return try cloudState()
        }
        if command == "cloud.archivePending" {
            guard try local.hasPendingMaterials() else { throw DesktopError.message("当前没有未完成的云备份") }
            let destination = local.profile.destinationID
            cloudBusy = true; emit("cloud.changed"); defer { cloudBusy = false; emit("cloud.changed") }
            let alert = NSAlert(); alert.messageText = "保留原快照并停止本次续传？"
            alert.informativeText = "原材料、检查点和连接信息将原样保存在本机传输资料中，云端已上传部分和其他版本均保留。之后可以修改连接并新建备份。完整的 snapshot.paperdigest 可使用“文件 → 恢复个人资料”恢复；缺失或损坏的材料需要手动核对，不保证可以恢复。"
            alert.addButton(withTitle: "保留快照并停止续传"); alert.addButton(withTitle: "继续保留当前续传")
            guard alert.runModal() == .alertFirstButtonReturn else { throw DesktopOperationCancelled("已取消，原快照仍可继续上传") }
            try requireMainContextAvailable()
            guard local.profile.destinationID == destination, try local.hasPendingMaterials() else { throw DesktopError.message("原续传目标已变化，未移动其他材料") }
            cloudAutomaticPausedInMemory = true
            try local.pauseAutomatic(true)
            _ = try local.archivePending(); cloudLastError = nil; return ["retained": true]
        }
        guard ["cloud.check", "cloud.upload", "cloud.list", "cloud.restore"].contains(command) else { throw DesktopError.message("不支持此云端操作") }
        cloudBusy = true; cloudLastError = nil; emit("cloud.changed")
        defer { cloudBusy = false; emit("cloud.changed") }
        do {
            if command == "cloud.upload" { return try await uploadCloudSnapshot() }
            let service = try cloudService()
            if command == "cloud.check" {
                _ = try await performCloudJob(command) { try await service.probe(); return ["status": "complete"] }
                try local.pauseAutomatic(false); cloudAutomaticPausedInMemory = false; cloudCredentialState = "confirmed"; return try cloudState()
            }
            if command == "cloud.list" {
                guard let month = payload["month"] as? String else { throw DesktopError.message("请选择要查看的备份月份") }
                return try await performCloudJob(command) {
                    let rows = try await service.list(month: month)
                    self.cloudCredentialState = "confirmed"
                    return ["snapshots": rows.map { ["month": $0.reference.month, "id": $0.reference.id.uuidString, "createdAt": ISO8601DateFormatter().string(from: $0.createdAt), "encodedBytes": $0.encodedBytes, "sha256": $0.sha256, "chunkCount": $0.chunkCount] }]
                }
            }
            guard let month = payload["month"] as? String, let rawID = payload["id"] as? String, let id = UUID(uuidString: rawID) else { throw DesktopError.message("请选择已回读的真实云端快照") }
            let reference = CloudArchiveService.SnapshotReference(month: month, id: id)
            return try await performCloudJob(command) {
                let downloaded = try await service.download(reference: reference)
                self.cloudCredentialState = "confirmed"
                try await self.flushEdits(); try self.requireMainContextAvailable()
                guard let ownJob = self.cloudActiveJobID, self.jobs.keys.allSatisfy({ $0 == ownJob }), !self.terminationPending, !self.maintenanceBusy else {
                    throw DesktopError.message("下载已完成；请先结束其他任务再恢复")
                }
                self.maintenanceBusy = true; defer { self.maintenanceBusy = false }
                try await self.applyRestorePayload(BackupCodec.parse(downloaded), activeCloudJob: ownJob)
                return ["restored": true, "sha256": PrivateStoragePaths.sha256(downloaded)]
            }
        } catch {
            cloudLastError = error.localizedDescription
            if case CloudArchiveService.CloudError.authentication = error {
                cloudAutomaticPausedInMemory = true; cloudCredentialState = "unknown"
                try local.pauseAutomatic(true)
            }
            throw error
        }
    }
    func uploadCloudSnapshot() async throws -> [String: Any] {
        let local = try cloudLocalStore(), destination = local.profile.destinationID
        guard !local.profile.account.isEmpty else { throw DesktopError.message("请先保存坚果云账号") }
        try local.recordAttempt()
        if try local.pending() == nil {
            let service = try cloudService()
            _ = try await performCloudJob("cloud.check") { try await service.probe(); return ["status": "complete"] }
            cloudCredentialState = "confirmed"
            try await flushEdits(); try requireMainContextAvailable()
            guard jobs.isEmpty, !terminationPending, !maintenanceBusy else { throw DesktopError.message("请等当前任务结束再生成完整云备份") }
            maintenanceBusy = true
            do { _ = try local.prepare(BackupCodec.collect(sourceDirectory: directory)); maintenanceBusy = false }
            catch { maintenanceBusy = false; throw error }
        }
        guard let pending = try local.pending() else { throw DesktopError.message("原快照没有保存，未开始云端上传") }
        let bytes = try local.bytes(for: pending), service = try cloudService()
        let material:[String:Any] = ["kind":"workspace-snapshot", "createdAt":pending.createdAt, "fileCount":pending.fileCount, "sha256":pending.sha256]
        let result = try await performCloudJob("cloud.upload", material:material) {
            let info = try await service.upload(encodedBackup: bytes, resuming: pending.checkpoint)
            try local.complete(info, destinationID: destination)
            return ["status": "complete", "sha256": info.sha256]
        }
        cloudAutomaticPausedInMemory = false; cloudCredentialState = "confirmed"; return result
    }
    func configureCloudSchedule() {
        cloudSchedule?.invalidate(); cloudSchedule = nil
        guard let local = try? cloudLocalStore(), local.profile.automatic else { return }
        cloudSchedule = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.cloudBusy, !self.maintenanceBusy, !self.terminationPending, !self.cloudAutomaticPausedInMemory,
                      self.jobs.isEmpty, !self.storageDetailsActive,
                      let local = try? self.cloudLocalStore(), local.profile.automatic, local.profile.automaticPaused != true,
                      Date().timeIntervalSince(local.profile.lastAttemptAt ?? .distantPast) >= Double(local.profile.intervalHours) * 3600 else { return }
                do { _ = try await self.dispatchCloud("cloud.upload", payload: [:]) }
                catch { self.emit("cloud.changed") }
            }
        }
    }
}
