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

actor CloudCredentialSession {
    let destination: UUID
    let account: String
    let session: @Sendable () async throws -> CloudArchiveService.Credentials?
    let isCurrent: @Sendable () async -> Bool
    let load: @Sendable (UUID) async throws -> String?
    var cached: CloudArchiveService.Credentials?
    init(destination: UUID, account: String,
         session: @escaping @Sendable () async throws -> CloudArchiveService.Credentials?,
         isCurrent: @escaping @Sendable () async -> Bool,
         load: @escaping @Sendable (UUID) async throws -> String?) {
        self.destination = destination; self.account = account; self.session = session; self.isCurrent = isCurrent; self.load = load
    }
    func credentials() async throws -> CloudArchiveService.Credentials {
        try Task.checkCancellation()
        let initiallyCurrent = await isCurrent()
        try Task.checkCancellation()
        guard initiallyCurrent else { throw CloudArchiveService.CloudError.credentialsUnavailable }
        // Check cancellation and the lease again after each asynchronous boundary:
        // a cancelled/retired memory lookup must never initiate a Keychain fallback.
        let memory = try await session()
        try Task.checkCancellation()
        let stillCurrent = await isCurrent()
        try Task.checkCancellation()
        guard stillCurrent else { throw CloudArchiveService.CloudError.credentialsUnavailable }
        if let memory { return memory }
        if let cached { return cached }
        let password = try await load(destination)
        try Task.checkCancellation()
        let loadedForCurrentTarget = await isCurrent()
        try Task.checkCancellation()
        guard loadedForCurrentTarget else { throw CloudArchiveService.CloudError.credentialsUnavailable }
        guard let password, !password.isEmpty else { throw CloudArchiveService.CloudError.credentialsUnavailable }
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
        let target = CloudSessionCredentials.Target(destination: profile.destinationID, account: profile.account)
        let available = cloudSessionCredentials.available(for: target)
        state["sessionPasswordAvailable"] = available
        state["sessionPasswordVerified"] = cloudSessionCredentials.verified(for: target)
        state["credentialMode"] = available ? "memory" : "keychain"
        if let cloudActiveJobID { state["activeJobID"] = cloudActiveJobID }
        if let cloudLastError { state["lastError"] = cloudLastError }
        else if !cloudAutomaticPermitted(profile: profile) { state["lastError"] = "自动备份已暂停，请主动检查连接后继续" }
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
        let target = CloudSessionCredentials.Target(destination: profile.destinationID, account: profile.account)
        let generation = cloudSessionCredentials.generation
        let load = cloudVaultLoadOverride ?? { destination in
            try await Task.detached(priority: .userInitiated) { try CloudCredentialVault.load(destination) }.value
        }
        let access = CloudCredentialSession(destination: profile.destinationID, account: profile.account,
            session: { [weak self] in
                guard let self else { throw CloudArchiveService.CloudError.credentialsUnavailable }
                return try await self.cloudSessionValue(target: target, generation: generation)
            }, isCurrent: { [weak self] in
                guard let self else { return false }
                return await self.cloudCredentialContextCurrent(target: target, generation: generation)
            }, load: load)
        let service = try CloudArchiveService(folder: profile.folder, destinationID: profile.destinationID,
            credentials: { try await access.credentials() }, checkpointSink: { [weak self] checkpoint in
                guard let owner = self else { throw DesktopError.message("应用已退出，未保存续传记录") }
                try await owner.saveCloudCheckpoint(checkpoint, destinationID: profile.destinationID)
            }, transport: cloudServiceTransportOverride, minimumRequestInterval: cloudServiceTransportOverride == nil ? 3.1 : 0)
        cloudArchive = service; return service
    }
    func cloudCredentialContextCurrent(target: CloudSessionCredentials.Target, generation: UUID) -> Bool {
        guard !terminationPending, cloudSessionCredentials.generation == generation,
              let profile = try? cloudLocalStore().profile else { return false }
        return profile.destinationID == target.destination && profile.account == target.account
    }
    func cloudConfirmCredential(target: CloudSessionCredentials.Target, generation: UUID) throws {
        guard cloudCredentialContextCurrent(target: target, generation: generation) else { throw CloudArchiveService.CloudError.credentialsUnavailable }
        if cloudSessionCredentials.available(for: target) { try cloudSessionCredentials.confirm(for: target, generation: generation) }
        cloudCredentialState = "confirmed"
    }
    func cloudSessionValue(target: CloudSessionCredentials.Target, generation: UUID) throws -> CloudArchiveService.Credentials? {
        guard cloudCredentialContextCurrent(target: target, generation: generation) else { throw CloudArchiveService.CloudError.credentialsUnavailable }
        return try cloudSessionCredentials.credentials(for: target, generation: generation)
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
        if ["cloud.setSessionPassword", "cloud.clearSessionPassword"].contains(command), !payload.isEmpty {
            throw DesktopError.message("本次密码只能通过原生安全输入设置，不接受网页传入的密码或目标")
        }
        if command == "cloud.save" {
            guard let account = payload["account"] as? String, let folder = payload["folder"] as? String,
                  let automatic = payload["automatic"] as? Bool, let interval = payload["intervalHours"] as? Int,
                  let rawAutomatic = payload["automatic"], let rawInterval = payload["intervalHours"],
                  CFGetTypeID(rawAutomatic as CFTypeRef) == CFBooleanGetTypeID(),
                  CFGetTypeID(rawInterval as CFTypeRef) != CFBooleanGetTypeID() else { throw DesktopError.message("坚果云连接设置无效") }
            let previous = local.profile.destinationID
            let hadMemory = cloudSessionCredentials.available(for: .init(destination: previous, account: local.profile.account))
            try local.save(account: account, folder: folder, automatic: automatic, intervalHours: interval)
            if local.profile.destinationID != previous { cloudSessionCredentials.clear(); cloudArchive = nil; cloudCredentialState = "unknown"; cloudLastError = nil; cloudAutomaticPausedInMemory = hadMemory; if hadMemory { try local.pauseAutomatic(true) } }
            configureCloudSchedule(); emit("cloud.changed"); return try cloudState()
        }
        if command == "cloud.setPassword" || command == "cloud.setSessionPassword" {
            guard !local.profile.account.isEmpty else { throw DesktopError.message("请先保存坚果云账号和独立目录") }
            let memoryOnly = command == "cloud.setSessionPassword"
            let target = CloudSessionCredentials.Target(destination: local.profile.destinationID, account: local.profile.account)
            let generation = cloudSessionCredentials.generation
            cloudBusy = true; emit("cloud.changed"); defer { cloudBusy = false; emit("cloud.changed") }
            let alert = NSAlert(); alert.messageText = memoryOnly ? "仅本次使用坚果云应用密码" : "保存坚果云应用专用密码"
            alert.informativeText = memoryOnly ? "密码只保留在论文速递本次运行的内存中，退出或更换账号后清除；不读取或写入钥匙串，不进入网页、备份、诊断或仓库。设置后仍需单独检查连接。" : "请为论文速递单独生成应用密码。密码只保存在本应用的 macOS 钥匙串，不进入网页、备份、诊断或仓库。"
            let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 26)); field.placeholderString = "输入坚果云应用专用密码"; alert.accessoryView = field
            alert.addButton(withTitle: memoryOnly ? "仅本次使用" : "保存到钥匙串"); alert.addButton(withTitle: "取消")
            defer { field.stringValue = "" }
            let reply = cloudPasswordPrompt?(alert, field) ?? alert.runModal()
            guard reply == .alertFirstButtonReturn else { throw DesktopOperationCancelled("已取消，原网盘连接和本次密码保留") }
            try Task.checkCancellation(); try requireMainContextAvailable()
            guard !terminationPending, !maintenanceBusy,
                  cloudCredentialContextCurrent(target: target, generation: generation) else { throw DesktopError.message("云目标或凭据已变化，未采用迟到的密码") }
            if memoryOnly {
                let password = field.stringValue
                try CloudSessionCredentials.validate(password, for: target)
                cloudAutomaticPausedInMemory = true
                try local.pauseAutomatic(true)
                try cloudSessionCredentials.install(password, for: target)
                cloudArchive = nil; cloudCredentialState = "session-unverified"; cloudLastError = nil; emit("cloud.changed")
            } else {
                if let save = cloudVaultSaveOverride { try save(field.stringValue, target.destination) }
                else { try CloudCredentialVault.save(field.stringValue, destination: target.destination) }
                cloudSessionCredentials.clear(); cloudArchive = nil; cloudCredentialState = "unknown"
                guard local.profile.destinationID == target.destination, local.profile.account == target.account else { throw DesktopError.message("原目标密码已保存，但当前云连接已变化；请重新检查当前连接") }
                cloudCredentialState = "confirmed"; emit("cloud.changed")
            }
            return try cloudState()
        }
        if command == "cloud.clearSessionPassword" {
            cloudSessionCredentials.clear(); cloudArchive = nil; cloudCredentialState = "unknown"
            cloudAutomaticPausedInMemory = true; emit("cloud.changed")
            try local.pauseAutomatic(true); return try cloudState()
        }
        if command == "cloud.deletePassword" {
            if let remove = cloudVaultRemoveOverride { try remove(local.profile.destinationID) }
            else { try CloudCredentialVault.remove(local.profile.destinationID) }
            cloudSessionCredentials.clear(); cloudArchive = nil; cloudCredentialState = "missing"; cloudAutomaticPausedInMemory = true
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
        let credentialTarget = CloudSessionCredentials.Target(destination: local.profile.destinationID, account: local.profile.account)
        let credentialGeneration = cloudSessionCredentials.generation
        do {
            if command == "cloud.upload" { return try await uploadCloudSnapshot() }
            let service = try cloudService()
            if command == "cloud.check" {
                _ = try await performCloudJob(command) { try await service.probe(); return ["status": "complete"] }
                try cloudConfirmCredential(target: credentialTarget, generation: credentialGeneration)
                try local.pauseAutomatic(cloudSessionCredentials.available(for: credentialTarget)); cloudAutomaticPausedInMemory = false; return try cloudState()
            }
            if command == "cloud.list" {
                guard let month = payload["month"] as? String else { throw DesktopError.message("请选择要查看的备份月份") }
                return try await performCloudJob(command) {
                    let rows = try await service.list(month: month)
                    try self.cloudConfirmCredential(target: credentialTarget, generation: credentialGeneration)
                    return ["snapshots": rows.map { ["month": $0.reference.month, "id": $0.reference.id.uuidString, "createdAt": ISO8601DateFormatter().string(from: $0.createdAt), "encodedBytes": $0.encodedBytes, "sha256": $0.sha256, "chunkCount": $0.chunkCount] }]
                }
            }
            guard let month = payload["month"] as? String, let rawID = payload["id"] as? String, let id = UUID(uuidString: rawID) else { throw DesktopError.message("请选择已回读的真实云端快照") }
            let reference = CloudArchiveService.SnapshotReference(month: month, id: id)
            return try await performCloudJob(command) {
                let downloaded = try await service.download(reference: reference)
                try self.cloudConfirmCredential(target: credentialTarget, generation: credentialGeneration)
                try await self.flushEdits(); try self.requireMainContextAvailable()
                guard let ownJob = self.cloudActiveJobID, self.jobs.keys.allSatisfy({ $0 == ownJob }), !self.terminationPending, !self.maintenanceBusy else {
                    throw DesktopError.message("下载已完成；请先结束其他任务再恢复")
                }
                self.maintenanceBusy = true; defer { self.maintenanceBusy = false }
                try await self.applyRestorePayload(BackupCodec.parse(downloaded), activeCloudJob: ownJob)
                return ["restored": true, "sha256": PrivateStoragePaths.sha256(downloaded)]
            }
        } catch {
            // A retired request cannot overwrite the new target/session's state.
            if cloudCredentialContextCurrent(target: credentialTarget, generation: credentialGeneration) {
                cloudLastError = error is CancellationError || error is DesktopOperationCancelled ? nil : error.localizedDescription
                if let cause = error as? CloudArchiveService.CloudError, cause == .authentication || cause == .credentialsUnavailable {
                    cloudSessionCredentials.invalidateVerification()
                    cloudAutomaticPausedInMemory = true; cloudCredentialState = "unknown"
                    try local.pauseAutomatic(true)
                }
            }
            throw error
        }
    }
    func uploadCloudSnapshot() async throws -> [String: Any] {
        let local = try cloudLocalStore(), destination = local.profile.destinationID
        let credentialTarget = CloudSessionCredentials.Target(destination: destination, account: local.profile.account), credentialGeneration = cloudSessionCredentials.generation
        guard !local.profile.account.isEmpty else { throw DesktopError.message("请先保存坚果云账号") }
        try local.recordAttempt()
        if try local.pending() == nil {
            let service = try cloudService()
            _ = try await performCloudJob("cloud.check") { try await service.probe(); return ["status": "complete"] }
            try cloudConfirmCredential(target: credentialTarget, generation: credentialGeneration)
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
            try self.cloudConfirmCredential(target: credentialTarget, generation: credentialGeneration)
            try local.complete(info, destinationID: destination, keepAutomaticPaused: self.cloudSessionCredentials.available(for: .init(destination: local.profile.destinationID, account: local.profile.account)))
            return ["status": "complete", "sha256": info.sha256]
        }
        cloudAutomaticPausedInMemory = false; return result
    }
    func cloudAutomaticPermitted(profile: CloudLocalStore.Profile) -> Bool {
        guard !cloudAutomaticPausedInMemory else { return false }
        let memoryVerified = cloudSessionCredentials.verified(for: .init(destination: profile.destinationID, account: profile.account))
        return profile.automaticPaused != true || memoryVerified
    }
    func configureCloudSchedule() {
        cloudSchedule?.invalidate(); cloudSchedule = nil
        guard let local = try? cloudLocalStore(), local.profile.automatic else { return }
        cloudSchedule = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.performScheduledCloudBackupIfDue() }
        }
    }
    func performScheduledCloudBackupIfDue() async {
        guard !cloudBusy, !maintenanceBusy, !terminationPending, !cloudAutomaticPausedInMemory,
              jobs.isEmpty, !storageDetailsActive,
              let local = try? cloudLocalStore(), local.profile.automatic, cloudAutomaticPermitted(profile: local.profile),
              Date().timeIntervalSince(local.profile.lastAttemptAt ?? .distantPast) >= Double(local.profile.intervalHours) * 3600 else { return }
        do { _ = try await dispatchCloud("cloud.upload", payload: [:]) }
        catch { emit("cloud.changed") }
    }
}
