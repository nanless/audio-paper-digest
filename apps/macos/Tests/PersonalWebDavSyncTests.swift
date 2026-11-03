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
        print("WebDAV 双端合并、取消收藏、研究资料与冲突测试通过")
    }
}
