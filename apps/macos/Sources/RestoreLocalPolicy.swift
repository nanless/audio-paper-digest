import Foundation

/// A snapshot restores research at a point in time. It must neither select a
/// new recipient for this Mac's Keychain credentials nor reset issued requests.
enum RequestBudgetContinuity {
    static let filename = "RequestBudgetContinuity.json"
    struct Issued: Codable, Equatable { let id: String; let startedAt: String }
    struct Record: Codable { let contract: String; let requests: [Issued] }
    static func entries(directory: URL) throws -> [Issued] {
        let file = directory.appendingPathComponent(filename)
        guard FileManager.default.fileExists(atPath: file.path) else {
            if (try? file.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true { throw DesktopError.message("请求历史不能是链接") }
            return []
        }
        let checked = try PrivateStoragePaths.checkedFile(relative: filename, directory: directory)
        let record = try JSONDecoder().decode(Record.self, from: PrivateStoragePaths.boundedData(checked, limit: 32 * 1024 * 1024))
        guard record.contract == "paperdigest-request-continuity-v1", record.requests.count <= 100_000 else { throw DesktopError.message("请求连续性记录无效") }
        _ = try union([record.requests]); return record.requests
    }
    static func fromSessions(_ sessions: [[String: Any]]) throws -> [Issued] {
        try sessions.filter { $0["requestIssued"] as? Bool == true }.map {
            guard let id = $0["id"] as? String, let started = $0["startedAt"] as? String else { throw DesktopError.message("原已派发请求缺少身份或时间，未清零使用记录") }
            return Issued(id: id, startedAt: started)
        }
    }
    static func union(_ groups: [[Issued]]) throws -> [Issued] {
        var all: [String: Issued] = [:]
        for item in groups.flatMap({ $0 }) {
            guard !item.id.isEmpty, item.id.utf8.count <= 256,
                  validTime(item.startedAt),
                  item.startedAt.utf8.count <= 64 else { throw DesktopError.message("原请求身份或时间无效") }
            if let old = all[item.id], old != item { throw DesktopError.message("同一原请求的派发时间冲突，未覆盖历史") }
            all[item.id] = item
            guard all.count <= 100_000 else { throw DesktopError.message("请求连续性记录超限，原资料已保留") }
        }
        return all.values.sorted { $0.id < $1.id }
    }
    static func validTime(_ value: String) -> Bool {
        guard value.range(of: "\\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z\\z", options: .regularExpression) != nil else { return false }
        let parts = value.prefix(19).split(whereSeparator: { "-T:".contains($0) }).compactMap { Int($0) }
        guard parts.count == 6, parts[0] > 0, (1...12).contains(parts[1]), (1...31).contains(parts[2]),
              (0...23).contains(parts[3]), (0...59).contains(parts[4]), (0...59).contains(parts[5]) else { return false }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let requested = DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: parts[3], minute: parts[4], second: parts[5])
        guard let date = calendar.date(from: requested) else { return false }
        let actual = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return actual.year == parts[0] && actual.month == parts[1] && actual.day == parts[2] && actual.hour == parts[3] && actual.minute == parts[4] && actual.second == parts[5]
    }
    static func count(on day: String, directory: URL, sessions: [[String: Any]]) throws -> Int {
        try union([entries(directory: directory), fromSessions(sessions)]).filter { $0.startedAt.hasPrefix(day) }.count
    }
}

@MainActor enum RestoreLocalPolicy {
    static let connectionKeys: Set<String> = ["endpoint", "model", "protocol", "httpProxy", "responsesStream", "reasoningEffort", "maxTokens", "timeoutMs", "dailyRequests"]
    static func apply(stage: URL, current: URL) throws {
        let currentFile = try PrivateStoragePaths.checkedFile(relative: "personal.json", directory: current)
        let stagedFile = try PrivateStoragePaths.checkedFile(relative: "personal.json", directory: stage)
        let currentData = try PrivateStoragePaths.boundedData(currentFile, limit: BackupCodec.maxDecodedBytes)
        let original = try PrivateStoragePaths.boundedData(stagedFile, limit: BackupCodec.maxDecodedBytes)
        guard let local = try JSONSerialization.jsonObject(with: currentData) as? [String: Any],
              var restored = try JSONSerialization.jsonObject(with: original) as? [String: Any] else { throw DesktopError.message("恢复资料无法读取，当前空间保留") }
        try DesktopStore.validate(local); try DesktopStore.validate(restored)
        let localSettings = local["settings"] as! [String: Any]
        var restoredSettings = restored["settings"] as! [String: Any]
        for key in connectionKeys { restoredSettings.removeValue(forKey: key); if let value = localSettings[key] { restoredSettings[key] = value } }
        restored["settings"] = restoredSettings
        let requests = try RequestBudgetContinuity.union([
            RequestBudgetContinuity.entries(directory: current), RequestBudgetContinuity.entries(directory: stage),
            RequestBudgetContinuity.fromSessions(local["sessions"] as! [[String: Any]]),
            RequestBudgetContinuity.fromSessions(restored["sessions"] as! [[String: Any]])
        ])
        // Keep the exact original personal bytes alongside the derived effective
        // settings. No source, response, input, note or usage entry is rewritten.
        let receipts = stage.appendingPathComponent("RestorationReceipts", isDirectory: true)
        if FileManager.default.fileExists(atPath: receipts.path) { _ = try PrivateStoragePaths.checkedDirectory(receipts) }
        else { try FileManager.default.createDirectory(at: receipts, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        let receipt = receipts.appendingPathComponent(UUID().uuidString + "-original-personal.json")
        try original.write(to: receipt, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receipt.path)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let continuity = try encoder.encode(RequestBudgetContinuity.Record(contract: "paperdigest-request-continuity-v1", requests: requests))
        try continuity.write(to: stage.appendingPathComponent(RequestBudgetContinuity.filename), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stage.appendingPathComponent(RequestBudgetContinuity.filename).path)
        try JSONSerialization.data(withJSONObject: restored, options: .sortedKeys).write(to: stagedFile, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stagedFile.path)
    }
}
