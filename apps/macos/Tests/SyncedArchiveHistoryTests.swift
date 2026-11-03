import Foundation

@main struct SyncedArchiveHistoryTests {
    static func main() throws {
        let manager = FileManager.default
        let directory = manager.temporaryDirectory.appendingPathComponent("synced-archive-" + UUID().uuidString)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: directory) }
        let fixture = try Data(contentsOf: URL(fileURLWithPath: "tests/fixtures/workbench/full-webdav-sync-v1.json"))
        let root = try JSONSerialization.jsonObject(with: fixture) as! [String: Any]
        let sources = root["sources"] as! [[String: Any]]
        let base = directory.appendingPathComponent("SyncedArchiveHistory")
        precondition((SyncedArchiveHistory.read(directory: directory)["records"] as! [[String: Any]]).isEmpty)
        var originalHashes = Set<String>()
        for source in sources {
            let files = source["files"] as! [[String: String]]
            let archive = files.first { path in
                let name = path["path"]!
                return name.hasPrefix("zotero-archives/") || name.hasPrefix("ZoteroArchives/")
            }!
            let data = Data(base64Encoded: archive["data"]!)!
            originalHashes.insert(sha256(data))
            // Duplicate an immutable journal in a second snapshot, as happens
            // when a different paper changed between two full syncs.
            for duplicate in 0...1 {
                let parent = base.appendingPathComponent(sha256(data + Data([UInt8(duplicate)])))
                let target = parent.appendingPathComponent(archive["path"]!)
                try manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: target)
            }
        }
        let history = SyncedArchiveHistory.read(directory: directory)
        let records = history["records"] as! [[String: Any]]
        precondition(records.count == 2 && history["unreadableCount"] as? Int == 0)
        precondition(Set(records.compactMap { $0["origin"] as? String }) == ["Mac", "Android"])
        precondition(Set(records.compactMap { $0["sourceSHA256"] as? String }) == originalHashes)
        precondition(records.allSatisfy { $0["resumeID"] == nil && $0["path"] == nil })
        print("跨端归档历史的原件去重、来源与只读边界通过")
    }
}
