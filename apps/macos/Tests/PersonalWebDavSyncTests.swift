import Foundation

@main struct PersonalWebDavSyncTests {
    @MainActor static func main() throws {
        let mac = "00000000-0000-4000-8000-000000000001"
        let android = "00000000-0000-4000-8000-000000000002"
        let a = "arxiv:2601.00001", b = "arxiv:2601.00002"
        func local(_ ids: [String] = []) -> [String: Any] {
            ["schema":1, "favorites":ids, "reading":[String](), "notes":[String:[String:Any]](),
             "annotations":[String:[[String:Any]]](), "readingState":[String:[String:Any]](),
             "jobs":[[String:Any]](), "sessions":[[String:Any]](), "settings":["endpoint":"local-only"]]
        }
        func note(_ root: [String: Any], _ text: String) -> [String: Any] {
            var result = root
            result["notes"] = [a:["revision":1,"text":text]]
            return result
        }
        func text(_ plan: PersonalWebDavSync.Plan) -> String? {
            (plan.personal["notes"] as? [String:[String:Any]])?[a]?["text"] as? String
        }
        let fixture = try Data(contentsOf: URL(fileURLWithPath: "tests/fixtures/workbench/personal-webdav-sync-v1.json"))
        let wire = try JSONSerialization.jsonObject(with: fixture) as! [String:[String:Any]]
        let peerBytes = try wire.mapValues { try JSONSerialization.data(withJSONObject: $0) }
        let imported = try PersonalWebDavSync.plan(local: local(), device: "00000000-0000-4000-8000-000000000003", remote: peerBytes)
        precondition(imported.upload == nil && imported.personal["favorites"] as? [String] == [a])
        precondition(text(imported) == "跨设备笔记" && imported.conflicts == 0)

        var left = note(local([a,"local:pdf"]), "已读方法")
        left["reading"] = [a]
        left["annotations"] = [a:[["id":"highlight"]]]
        left["readingState"] = [a:["pdfPage":4]]
        left["favoriteCollections"] = ["version":1,"revision":0,"folders":[[String:Any]](),
            "items":[a:["addedAt":"2026-11-02T00:00:00.000Z","folderIDs":[String]()]]]
        let first = try PersonalWebDavSync.plan(local: left, device: mac, remote: [:])
        var remote = [mac:first.upload!]
        let right = try PersonalWebDavSync.plan(local: local([b]), device: android, remote: remote)
        precondition(right.personal["favorites"] as? [String] == [a,b])
        precondition(right.personal["reading"] as? [String] == [a])
        precondition(text(right) == "已读方法")
        precondition((right.personal["annotations"] as? [String:[[String:Any]]])?[a]?.first?["id"] as? String == "highlight")
        precondition((right.personal["readingState"] as? [String:[String:Any]])?[a]?["pdfPage"] as? Int == 4)
        precondition(!String(decoding: first.upload!, as: UTF8.self).contains("local-only"))
        remote[android] = right.upload!
        let pulled = try PersonalWebDavSync.plan(local: left, device: mac, remote: remote)
        precondition(pulled.upload == nil && pulled.personal["favorites"] as? [String] == [a,b,"local:pdf"])
        var removed = pulled.personal
        removed["favorites"] = [b,"local:pdf"]
        let removal = try PersonalWebDavSync.plan(local: removed, device: mac, remote: remote)
        let after = try PersonalWebDavSync.plan(local: right.personal, device: android, remote: remote.merging([mac:removal.upload!]) { _, new in new })
        precondition(after.personal["favorites"] as? [String] == [b] && after.upload == nil)

        let leftEdit = try PersonalWebDavSync.plan(local: note(pulled.personal, "Mac 编辑"), device: mac, remote: remote)
        let rightEdit = try PersonalWebDavSync.plan(local: note(right.personal, "Android 编辑"), device: android, remote: remote)
        let conflictRemote = [mac:leftEdit.upload!, android:rightEdit.upload!]
        let conflict = try PersonalWebDavSync.plan(local: leftEdit.personal, device: mac, remote: conflictRemote)
        precondition(conflict.conflicts == 1 && text(conflict) == "Mac 编辑")
        let resolution = try PersonalWebDavSync.plan(local: note(conflict.personal, "合并稿"), device: mac, remote: conflictRemote)
        let resolved = try PersonalWebDavSync.plan(local: rightEdit.personal, device: android,
            remote: [mac:resolution.upload!,android:rightEdit.upload!])
        precondition(resolved.conflicts == 0 && text(resolved) == "合并稿")
        func favorite(_ date: String) -> [String: Any] {
            var value = local([a])
            value["favoriteCollections"] = ["version":1, "revision":0, "folders":[[String:Any]](),
                "items":[a:["addedAt":date, "folderIDs":[String]()]]]
            return value
        }
        let exact = "2026-11-02T00:00:00Z"
        let later = "2026-11-02T00:00:00.000000001Z"
        let exactDoc = try PersonalWebDavSync.plan(local: favorite(exact), device: mac, remote: [:]).upload!
        precondition(!FavoriteCollections.validTime(later + "\n"))
        let laterDoc = try PersonalWebDavSync.plan(local: favorite(later), device: android, remote: [:]).upload!
        let dated = try PersonalWebDavSync.plan(local: local(), device: android, remote: [mac:exactDoc, android:laterDoc])
        let collection = dated.personal["favoriteCollections"] as! [String: Any]
        let items = collection["items"] as! [String: [String: Any]]
        precondition(items[a]?["addedAt"] as? String == exact)
        do {
            _ = try PersonalWebDavSync.plan(local: dated.personal, device: android, remote: [mac:exactDoc + Data([32]), android:laterDoc])
            preconditionFailure("accepted a rewritten document at the same revision")
        } catch let error as DesktopError {
            guard case .message(let message) = error, message.contains("版本未变") else { throw error }
        }
        var legacy = local()
        legacy["notes"] = [a:["text":"旧版笔记", "revision":0]]
        let legacyDoc = try PersonalWebDavSync.plan(local: legacy, device: mac, remote: [:]).upload!
        let adoptedLegacy = try PersonalWebDavSync.plan(local: local(), device: android, remote: [mac:legacyDoc])
        precondition((adoptedLegacy.personal["notes"] as! [String:[String:Any]])[a]?["revision"] as? Int == 1)
        var sameText = legacy
        sameText["notes"] = [a:["text":"旧版笔记", "revision":3]]
        let sameDoc = try PersonalWebDavSync.plan(local: sameText, device: android, remote: [:]).upload!
        let adoptedSame = try PersonalWebDavSync.plan(local: local(), device: android, remote: [mac:legacyDoc, android:sameDoc])
        precondition(adoptedSame.conflicts == 0 && text(adoptedSame) == "旧版笔记")
        let booleanDoc = Data(String(decoding: legacyDoc, as: UTF8.self)
            .replacingOccurrences(of: "\"revision\":0", with: "\"revision\":true").utf8)
        precondition(booleanDoc != legacyDoc)
        do {
            _ = try PersonalWebDavSync.plan(local: local(), device: android, remote: [mac:booleanDoc])
            preconditionFailure("accepted a boolean note revision")
        } catch let error as DesktopError {
            guard case .message(let message) = error, message.contains("结构无效") else { throw error }
        }
        do {
            _ = try PersonalWebDavSync.plan(local: note(local(), "恢复的旧文"), device: mac, remote: [mac:legacyDoc])
            preconditionFailure("overwrote a newer same-device note after restoring an older backup")
        } catch let error as DesktopError {
            guard case .message(let message) = error, message.contains("未确认") else { throw error }
        }
        var fields = local([a])
        fields.removeValue(forKey: "schema")
        let currentRoot = try ClientProtocols.record("paperdigest-personal-library", fields: fields)
        let currentSync = try PersonalWebDavSync.plan(local: currentRoot, device: mac, remote: [:])
        let currentFavorites = currentSync.personal["favoriteCollections"] as! [String: Any]
        precondition(currentFavorites["contract"] is String && currentFavorites["version"] == nil)
        let repeated = try PersonalWebDavSync.plan(local: currentSync.personal, device: mac, remote: [mac:currentSync.upload!])
        precondition(repeated.upload == nil && repeated.personal["favorites"] as? [String] == [a])
        print("WebDAV 双端合并、取消收藏、研究资料与冲突测试通过")
    }
}
