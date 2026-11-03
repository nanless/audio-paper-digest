import Foundation
import CoreFoundation

/// Peer documents use the same versioned JSON contract as Android.
enum PersonalWebDavSync {
    static let limit = 8 * 1024 * 1024
    static let directory = "personal-sync-v1"
    static let revisionDirectory = "personal-sync-revisions-v1"
    static let revisionsPerBucket = 256
    static let bucketLimit = 748
    static let deviceLimit = 24
    private static let format = "paperdigest-personal-sync-v1"
    private static let baselineKey = "webDavSyncBaseline"
    private static let fields = ["favorites", "reading", "notes", "annotations", "readingState"]
    private static let sets = ["favorites", "reading"]
    private static let maps = ["notes", "annotations", "readingState"]
    typealias Object = [String: Any]
    typealias Projection = [String: Object]

    struct Plan {
        let personal: Object
        let upload: Data?
        let conflicts: Int
    }
    struct RemoteRevision {
        let device: String
        let number: Int
        let digest: String

        var bucket: Int { (number - 1) / revisionsPerBucket }
        var filename: String { "\(device)-\(number)-\(digest).json" }

        init?(filename: String) {
            guard filename.hasSuffix(".json"), filename.utf8.count >= 108 else { return nil }
            let device = String(filename.prefix(36))
            let fields = filename.dropFirst(36).dropLast(5).split(separator: "-", omittingEmptySubsequences: false)
            guard fields.count == 3, fields[0].isEmpty, Self.validDevice(device),
                  let number = Int(fields[1]), String(number) == fields[1],
                  (1...9_007_199_254_740_991).contains(number),
                  PrivateStoragePaths.validSHA(String(fields[2])) else { return nil }
            self.device = device
            self.number = number
            self.digest = String(fields[2])
        }

        init(device: String, bytes: Data) throws {
            self.device = device
            self.number = try PersonalWebDavSync.documentHeader(bytes, device: device).revision
            self.digest = sha256(bytes)
        }

        private static func validDevice(_ id: String) -> Bool { PersonalWebDavSync.validDevice(id) }
    }

    static func documentHeader(_ bytes: Data, device: String) throws -> (revision: Int, legacySHA256: Any?) {
        guard validDevice(device), (1...limit).contains(bytes.count),
              let document = try JSONSerialization.jsonObject(with: bytes) as? Object,
              document["format"] as? String == format, document["device"] as? String == device else { throw invalid() }
        return (try revision(document["revision"]), document["legacySHA256"])
    }
    private struct Edit {
        let device: String
        let revision: Int
        let seen: [String: Int]
        let value: Any
    }

    static func validDevice(_ id: String) -> Bool { UUID(uuidString: id)?.uuidString.lowercased() == id }
    private static func validPaper(_ id: String) -> Bool {
        !id.isEmpty && id.utf16.count <= 2048 && !id.hasPrefix("local:")
    }
    private static func invalid() -> DesktopError { .message("WebDAV 同步资料结构无效，已保留本机资料") }
    private static func revision(_ raw: Any?) throws -> Int {
        guard let raw = raw as? NSNumber, CFGetTypeID(raw) != CFBooleanGetTypeID(),
              let number = raw as? Int, number > 0, number <= 9_007_199_254_740_991 else { throw invalid() }
        return number
    }
    private static func encoded(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
    }

    private static func project(_ personal: Object) throws -> Projection {
        var result: Projection = [:]
        let favorites = try FavoriteCollections.editable(personal["favoriteCollections"], root: personal)
        let items = favorites["items"] as? [String: Object] ?? [:]
        for field in sets {
            var rows: Object = [:]
            for id in (personal[field] as? [String] ?? []) where validPaper(id) {
                if field == "reading" { rows[id] = true }
                else { rows[id] = ["addedAt": items[id]?["addedAt"] ?? NSNull()] }
            }
            result[field] = rows
        }
        for field in maps {
            result[field] = (personal[field] as? Object ?? [:]).filter { validPaper($0.key) }
        }
        return result
    }
    private static func hashes(_ projection: Projection) throws -> [String: [String: String]] {
        try projection.mapValues { rows in try rows.mapValues { sha256(try encoded($0)) } }
    }

    private static func favoriteTimeKey(_ value: Any?) -> String {
        guard let date = value as? String, date.last == "Z" else { return "~" }
        let fraction = date.dropFirst(19).dropLast().dropFirst()
        return date.prefix(19) + "." + fraction + String(repeating: "0", count: 9 - fraction.count)
    }

    @MainActor static func plan(local: Object, device: String, remote: [String: Data]) throws -> Plan {
        guard validDevice(device), remote.count <= deviceLimit else { throw invalid() }
        var documents: [String: Object] = [:]
        for (owner, bytes) in remote {
            guard validDevice(owner), (1...limit).contains(bytes.count),
                  let document = try JSONSerialization.jsonObject(with: bytes) as? Object,
                  document["format"] as? String == format, document["device"] as? String == owner,
                  let records = document["records"] as? [String: [String: Object]],
                  Set(records.keys) == Set(fields) else { throw invalid() }
            let version = try revision(document["revision"])
            for (field, rows) in records {
                guard rows.count <= 100_000 else { throw invalid() }
                for (id, row) in rows {
                    guard validPaper(id), try revision(row["revision"]) <= version,
                          let seen = row["seen"] as? Object, seen.count <= deviceLimit, seen[owner] == nil,
                          let value = row["value"] else { throw invalid() }
                    for (peer, counter) in seen {
                        guard validDevice(peer) else { throw invalid() }
                        _ = try revision(counter)
                    }
                    if value is NSNull { continue }
                    switch field {
                    case "favorites":
                        guard let item = value as? Object, item.count == 1,
                              let date = item["addedAt"], date is NSNull || FavoriteCollections.validTime(date) else { throw invalid() }
                    case "reading":
                        guard let flag = value as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID(),
                              flag.boolValue else { throw invalid() }
                    case "annotations": guard value is [Object] else { throw invalid() }
                    case "notes":
                        guard let note = value as? Object, note["text"] is String,
                              let raw = note["revision"] as? NSNumber, CFGetTypeID(raw) != CFBooleanGetTypeID(),
                              let rev = raw as? Int, (0..<Int(Int32.max)).contains(rev) else { throw invalid() }
                    default: guard value is Object else { throw invalid() }
                    }
                }
            }
            documents[owner] = document
        }
        let previous = (local[baselineKey] as? Object).flatMap { $0["device"] as? String == device ? $0 : nil }
        let observed = previous?["observed"] as? [String: Int] ?? [:]
        let observedDigests = previous?["digests"] as? [String: String] ?? [:]
        var digests = remote.mapValues { sha256($0) }
        for (peer, version) in observed {
            let current = documents[peer]?["revision"] as? Int ?? 0
            guard current >= version else {
                throw DesktopError.message("云端同步记录缺失或回退，已保留本机资料")
            }
            if current == version, let digest = observedDigests[peer], digest != digests[peer] {
                throw DesktopError.message("云端同步记录版本未变但内容已更改，已保留本机资料")
            }
        }
        for document in documents.values {
            for rows in (document["records"] as! [String: [String: Object]]).values {
                for row in rows.values {
                    for (peer, version) in row["seen"] as! [String: Int] {
                        guard (documents[peer]?["revision"] as? Int ?? 0) >= version else { throw invalid() }
                    }
                }
            }
        }
        let baseline = previous?["hashes"] as? [String: [String: String]] ?? [:]
        let projection = try project(local)
        let currentHashes = try hashes(projection)
        let own = documents[device]
        let ownVersion = own?["revision"] as? Int ?? 0
        var records = own?["records"] as? [String: [String: Object]] ??
            Dictionary(uniqueKeysWithValues: fields.map { ($0, [:]) })
        let next = ownVersion + 1
        _ = try revision(next)
        var seen = observed
        seen.removeValue(forKey: device)
        var changed = false
        for field in fields {
            var rows = records[field]!
            let before = baseline[field] ?? [:]
            let after = currentHashes[field] ?? [:]
            for (id, row) in rows where (row["revision"] as! Int) > (observed[device] ?? 0) {
                let current = projection[field]?[id]
                // A restored workspace or an interrupted upload may predate this same-device edit.
                if (previous != nil || current != nil), try encoded(current ?? NSNull()) != encoded(row["value"]!) {
                    throw DesktopError.message("同一设备有未确认的云端编辑，本机与云端资料均已保留")
                }
            }
            for id in Set(before.keys).union(after.keys) where before[id] != after[id] {
                let value = projection[field]?[id] ?? NSNull()
                if ownVersion > (observed[device] ?? 0), let old = rows[id]?["value"],
                   try encoded(old) == encoded(value) { continue }
                rows[id] = ["revision": next, "seen": seen, "value": value]
                changed = true
            }
            records[field] = rows
        }
        var upload: Data?
        if changed {
            let legacy: Any = own?["legacySHA256"] ?? (remote[device].map { sha256($0) as Any } ?? NSNull())
            let document: Object = ["format": format, "device": device, "revision": next, "records": records, "legacySHA256": legacy]
            let bytes = try encoded(document)
            guard bytes.count <= limit, documents.count < deviceLimit || documents[device] != nil else {
                throw DesktopError.message("WebDAV 同步资料或设备数量超过上限")
            }
            upload = bytes
            digests[device] = sha256(bytes)
            documents[device] = document
        }
        var merged: Projection = [:]
        var conflicts = 0
        for field in fields {
            var byPaper: [String: [Edit]] = [:]
            for (owner, document) in documents {
                let rows = (document["records"] as! [String: [String: Object]])[field]!
                for (id, row) in rows {
                    byPaper[id, default: []].append(Edit(device: owner, revision: row["revision"] as! Int,
                        seen: row["seen"] as! [String: Int], value: row["value"]!))
                }
            }
            var output: Object = [:]
            for (id, edits) in byPaper {
                let heads = edits.filter { a in !edits.contains { ($0.seen[a.device] ?? 0) >= a.revision } }
                guard !heads.isEmpty else { throw invalid() }
                let value: Any
                if ["notes", "annotations"].contains(field),
                   try Set(heads.map { edit in
                       let text = field == "notes" ? (edit.value as? Object)?["text"] : nil
                       return try encoded(text ?? edit.value)
                   }).count > 1 {
                    conflicts += 1
                    value = projection[field]?[id] ?? NSNull()
                } else if sets.contains(field), heads.contains(where: { $0.value is NSNull }) {
                    value = NSNull()
                } else if field == "favorites" {
                    value = heads.map { $0.value as! Object }.min {
                        (favoriteTimeKey($0["addedAt"]), $0["addedAt"] as? String ?? "") <
                        (favoriteTimeKey($1["addedAt"]), $1["addedAt"] as? String ?? "")
                    }!
                } else {
                    value = heads.max {
                        ($0.revision, $0.device) < ($1.revision, $1.device)
                    }!.value
                }
                if !(value is NSNull) { output[id] = value }
            }
            merged[field] = output
        }
        var result = local
        for field in sets {
            let localOnly = (local[field] as? [String] ?? []).filter { !validPaper($0) }
            result[field] = (localOnly + Array(merged[field]!.keys)).sorted()
        }
        for field in maps {
            let old = local[field] as? Object ?? [:]
            var rows = merged[field]!.merging(old.filter { !validPaper($0.key) }) { first, _ in first }
            if field == "notes" {
                for (id, raw) in rows {
                    guard var note = raw as? Object, let revision = note["revision"] as? Int else { continue }
                    let previous = old[id] as? Object
                    let previousRevision = previous?["revision"] as? Int ?? 0
                    let textChanged = (note["text"] as? String ?? "") != (previous?["text"] as? String ?? "")
                    if textChanged && revision <= previousRevision {
                        guard previousRevision < Int(Int32.max) - 1 else { throw invalid() }
                        note["revision"] = previousRevision + 1
                    } else if revision < previousRevision {
                        note["revision"] = previousRevision
                    }
                    rows[id] = note
                }
            }
            result[field] = rows
        }
        var favorites = try FavoriteCollections.editable(result["favoriteCollections"], root: result)
        var items = favorites["items"] as! [String: Object]
        let originalItems = try encoded(items)
        let mergedFavorites = merged["favorites"]!
        for id in (local["favorites"] as? [String] ?? []) where validPaper(id) && mergedFavorites[id] == nil {
            items.removeValue(forKey: id)
        }
        for (id, value) in mergedFavorites {
            var item = items[id] ?? ["folderIDs": [String]()]
            item["addedAt"] = (value as! Object)["addedAt"]
            items[id] = item
        }
        if try encoded(items) != originalItems { try FavoriteCollections.advance(&favorites) }
        favorites["items"] = items
        result["favoriteCollections"] = favorites
        result[baselineKey] = ["device": device, "observed": documents.mapValues { $0["revision"] as! Int },
                               "digests": digests, "hashes": try hashes(project(result))]
        try DesktopStore.validate(result)
        return Plan(personal: result, upload: upload, conflicts: conflicts)
    }

    static func unchanged(_ before: Object, _ after: Object) throws -> Bool {
        try (fields + ["favoriteCollections", baselineKey]).allSatisfy {
            try encoded(before[$0] ?? NSNull()) == encoded(after[$0] ?? NSNull())
        }
    }
    static func apply(_ plan: Plan, to current: Object) -> Object {
        var result = current
        for field in fields + ["favoriteCollections", baselineKey] { result[field] = plan.personal[field] }
        return result
    }
}
