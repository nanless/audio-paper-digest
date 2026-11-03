import Foundation

/// Shows imported originals without granting any native Zotero resume capability.
enum SyncedArchiveHistory {
    static func read(directory: URL) -> [String: Any] {
        let root = directory.appendingPathComponent("SyncedArchiveHistory", isDirectory: true)
        var rows: [[String: Any]] = []
        var hashes = Set<String>()
        var unreadable = 0
        var truncated = false
        if !FileManager.default.fileExists(atPath: root.path) {
            let linked = (try? root.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true
            return ["records": rows, "unreadableCount": linked ? 1 : 0, "truncated": false]
        }
        func children(_ path: URL) throws -> [String] {
            let checked = try PrivateStoragePaths.checkedDirectory(path)
            return try FileManager.default.contentsOfDirectory(atPath: checked.path).sorted()
        }
        do {
            let snapshots = try children(root)
            scan: for snapshot in snapshots {
                guard PrivateStoragePaths.validSHA(snapshot) else { unreadable += 1; continue }
                let snapshotDirectory = root.appendingPathComponent(snapshot)
                do { _ = try PrivateStoragePaths.checkedDirectory(snapshotDirectory) }
                catch { unreadable += 1; continue }
                for family in ["zotero-archives", "ZoteroArchives", "ZoteroDavArchives"] {
                    let familyDirectory = snapshotDirectory.appendingPathComponent(family)
                    if !FileManager.default.fileExists(atPath: familyDirectory.path) { continue }
                    let names: [String]
                    do { names = try children(familyDirectory) }
                    catch { unreadable += 1; continue }
                    let mac = family == "zotero-archives"
                    for name in names {
                        let id: String
                        if mac {
                            guard name.hasSuffix(".json"), !name.hasSuffix(".summary.json") else { continue }
                            id = String(name.dropLast(5))
                        } else { id = name }
                        guard UUID(uuidString: id) != nil else { continue }
                        let suffix = mac ? name : name + "/journal.json"
                        do {
                            let file = try PrivateStoragePaths.checkedFile(relative: "\(snapshot)/\(family)/\(suffix)", directory: root)
                            let bytes = try PrivateStoragePaths.boundedData(file, limit: 8 * 1024 * 1024)
                            let digest = sha256(bytes)
                            guard !hashes.contains(digest) else { continue }
                            guard let journal = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                                  let recordedID = journal["id"] as? String, recordedID.lowercased() == id.lowercased() else {
                                unreadable += 1; continue
                            }
                            let request = journal["request"] as? [String: Any]
                            let bibliography = (request?["bibliography"] ?? journal["bibliography"]) as? [String: Any]
                            let title = (bibliography?["title"] ?? journal["paperID"]) as? String ?? id
                            let steps = journal["steps"] as? [[String: Any]] ?? []
                            let reportedComplete = mac
                                ? !steps.isEmpty && steps.allSatisfy { $0["verified"] as? Bool == true }
                                : journal["status"] as? String == "completed"
                            if rows.count == 200 { truncated = true; break scan }
                            hashes.insert(digest)
                            rows.append(["id": id, "origin": mac ? "Mac" : "Android",
                                         "title": String(title.prefix(512)), "sourceSHA256": digest,
                                         "reportedComplete": reportedComplete])
                        } catch { unreadable += 1 }
                    }
                }
            }
        } catch { unreadable += 1 }
        return ["records": rows, "unreadableCount": unreadable, "truncated": truncated]
    }
}
