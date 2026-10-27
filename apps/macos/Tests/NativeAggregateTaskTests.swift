import AppKit
import Foundation
import Darwin

private struct Failure: Error { let text: String }
private actor FixtureTransport {
    let files: [String: Data]
    var failBody = false
    var bodyRequests = 0
    init(_ files: [String: Data]) { self.files = files }
    func failingBody(_ value: Bool) { failBody = value }
    func read(_ url: URL, limit: Int) throws -> Data {
        if url.absoluteString.hasSuffix("/ci-summary/") { bodyRequests += 1; if failBody { throw URLError(.notConnectedToInternet) } }
        guard let data = files[url.absoluteString], data.count <= limit else { throw URLError(.fileDoesNotExist) }
        return data
    }
}
@main @MainActor struct NativeAggregateTaskTests {
    static var passed = 0, failed = 0
    static func check(_ value: @autoclosure () throws -> Bool, _ reason: String) throws { if try !value() { throw Failure(text: reason) } }
    static func run(_ label: String, _ body: () async throws -> Void) async { do { try await body(); passed += 1; print("PASS " + label) } catch { failed += 1; print("FAIL " + label + ": " + ((error as? Failure)?.text ?? String(describing: type(of: error)))) } }
    static func rejects(_ action: () throws -> Void) throws { do { try action() } catch is Failure { throw Failure(text: "assertion in rejection") } catch { return }; throw Failure(text: "expected rejection") }
    static func row(_ job: [String: Any], live: Set<String> = []) throws -> NativeTaskRow { try NativeTaskProjection.make(.init(jobs: [job], sessions: [], liveJobIDs: live)).rows[0] }
    static let hash = String(repeating: "a", count: 64)
    static let legacy: [String: Any] = ["id": "old-summary", "command": "aggregates.document", "paperID": "arxiv:2501.00001", "identity": "old-paper-identity", "title": "旧论文上下文", "status": "complete"]
    static let source: [String: Any] = ["contract": "aggregate-task-source-v1", "id": "page:/audio-paper-digest-blog/ci-summary/", "title": "实际汇总标题", "kind": "daily", "manifestSHA256": hash, "shardSHA256": hash, "normalizedRowSHA256": hash]
    static func main() async throws {
        setbuf(stdout, nil)
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let physical = realpath(FileManager.default.temporaryDirectory.path, nil)!; defer { free(physical) }
        let root = URL(fileURLWithPath: String(cString: physical)).appendingPathComponent("aggregate-task53-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); defer { try? FileManager.default.removeItem(at: root) }
        await run("legacy aggregate never borrows old paper action or identity; raw remains exact") {
            let before = try JSONSerialization.data(withJSONObject: legacy, options: .sortedKeys), projected = try row(legacy)
            let metadata = projected.metadata.joined(separator: "\n")
            try check(projected.paperID == nil && projected.actions.isEmpty && projected.title == "读取网站汇总", "old paper capability/title retained")
            try check(metadata.contains("对象身份：网站汇总 · 原聚合身份未记录") && metadata.contains("原记录上下文（不代表聚合身份）：") && metadata.contains("旧论文上下文") && metadata.contains("本任务无需本地模型请求"), "legacy attribution or exact known class missing")
            try check(try JSONSerialization.data(withJSONObject: legacy, options: .sortedKeys) == before, "legacy raw rewritten")
        }
        await run("only exact document command is newly classified; fake aggregate and model commands stay unknown") {
            for command in ["aggregates.document.extra", "aggregates.documents", "aggregates.model", "model.mystery"] {
                var job = legacy; job["command"] = command; job["aggregateSource"] = source
                let metadata = try row(job).metadata.joined(separator: "\n")
                try check(metadata.contains("任务类别未识别") && !metadata.contains("原聚合目录"), "prefix or self-reported source granted classification")
            }
        }
        await run("versioned native witness supplies title and provenance without paper action") {
            var job = legacy; job["aggregateSource"] = source
            let value = try row(job), metadata = value.metadata.joined(separator: "\n")
            try check(value.title == "实际汇总标题" && value.paperID == nil && value.actions.isEmpty && metadata.contains(source["id"] as! String) && metadata.contains("原行 SHA-256 " + hash) && !metadata.contains("old-paper-identity"), "typed attribution wrong")
            for (kind, label) in [("daily", "日更汇总"), ("conference", "会议汇总与专题"), ("page", "网站页面")] {
                var witness = source; witness["kind"] = kind; job["aggregateSource"] = witness
                let display = try row(job).metadata.joined(separator: "\n")
                try check(display.contains("类别 " + label + " ·") && !display.contains("类别 " + kind + " ·") && (job["aggregateSource"] as! [String: Any])["kind"] as? String == kind, "kind label leaked enum or rewrote raw witness")
            }
        }
        await run("malformed witnesses do not invent an aggregate identity") {
            for (key, bad): (String, Any) in [("contract", "future-v9"), ("id", "arxiv:1"), ("kind", "paper"), ("title", true), ("manifestSHA256", "bad"), ("shardSHA256", NSNull()), ("normalizedRowSHA256", "A" + hash.dropFirst()), ("extra", "self report")] {
                var job = legacy, value = source; value[key] = bad; job["aggregateSource"] = value
                let valueRow = try row(job)
                try check(valueRow.title == "读取网站汇总" && valueRow.metadata[0].contains("原聚合身份未记录") && valueRow.actions.isEmpty, "malformed metadata accepted at " + key)
            }
        }
        await run("live aggregate retains only normal cancel, never paper open") {
            var job = legacy; job["status"] = "running"
            try check(try row(job, live: ["old-summary"]).actions == [.cancel], "live cancel lost")
            try check(try row(job).actions.isEmpty, "cold running row got action")
        }
        let base = "https://nanless.github.io/audio-paper-digest-blog/"
        let rows: [[String: Any]] = [["pageType": "daily", "permalink": "/audio-paper-digest-blog/ci-summary/", "title": "受控真实目录汇总", "titleZh": "受控目录中文标题", "date": "0001-01-01"],
            ["pageType":"paper", "permalink":"/audio-paper-digest-blog/papers/ci-paper/", "title":"Controlled paper", "titleZh":"受控论文", "date":"2026-10-24", "sourceKind":"arxiv", "identityStatus":"verified", "arxivId":"2510.00001", "citation":["paperKey":"arxiv:2510.00001", "identityStatus":"verified", "verified":true, "complete":false, "authors":["Author"], "title":"Controlled paper", "arxivId":"2510.00001v1", "sourceKind":"arxiv", "sourceUrl":"https://arxiv.org/abs/2510.00001v1", "pdfUrl":"https://arxiv.org/pdf/2510.00001v1.pdf"]]]
        let shard = try JSONSerialization.data(withJSONObject: rows, options: .sortedKeys), shardSHA = PublishedAggregateReader.sha(shard), shardPath = "search-index/part-0001-" + shardSHA.prefix(12) + ".json"
        let manifest = try JSONSerialization.data(withJSONObject: ["contract": "paper-search-index-manifest-v1", "recordCount": rows.count, "totalBytes": shard.count, "shards": [["url": shardPath, "sha256": shardSHA, "bytes": shard.count, "recordCount": rows.count]]], options: .sortedKeys)
        let html = Data("<html><body><div id='article-body' class='post-content'><p>受控纯文本</p></div></body></html>".utf8)
        let transport = FixtureTransport([base + "index.json": manifest, base + shardPath: shard, base + "ci-summary/": html])
        let app = PaperDigestApp(); app.directory = root; app.store = try DesktopStore(directory: root)
        var keyReads = 0; app.model = ModelService(directory: root, store: app.store, keyProvider: { keyReads += 1; return nil })
        app.library = try LibraryService(dataDirectory: root.appendingPathComponent("library"), transport: { url, limit in try await transport.read(url, limit: limit) })
        _ = try await app.library.sync()
        let id = "page:/audio-paper-digest-blog/ci-summary/", access = try await app.library.aggregateReadAccess(id: id)
        func fresh() -> AggregateViewSession { app.currentPaperID = ""; app.currentPaper = [:]; app.currentArticle = [:]; let session = AggregateViewSession(generation: app.contextGeneration, aggregateID: id); app.aggregateSession = session; return session }
        await run("actual Main runJob excludes inherited paper only for exact aggregate command") {
            app.currentPaperID = "old-paper"; app.currentPaper = ["title": "旧论文上下文"]
            _ = try await app.runJob("aggregates.document", payload: [:], identifier: "initial-owner") { _ in
                let stored = (app.store.value["jobs"] as! [[String: Any]]).first { $0["id"] as? String == "initial-owner" }!
                try check(stored["paperID"] as? String == "" && stored["title"] as? String == "读取网站汇总", "Main borrowed paper")
                return [:]
            }
            _ = try await app.runJob("model.mystery", payload: [:], identifier: "other-owner") { _ in [:] }
            try check((app.store.value["jobs"] as! [[String: Any]]).first { $0["id"] as? String == "other-owner" }?["paperID"] as? String == "old-paper", "unrelated producer changed")
        }
        await run("real dispatch mints actor access then persists its exact descriptor on the same job") {
            let session = fresh()
            _ = try await app.dispatchAggregates("aggregates.document", payload: ["id": id, "sessionID": session.id])
            let job = (app.store.value["jobs"] as! [[String: Any]]).first { $0["id"] as? String == session.id }!, witness = job["aggregateSource"] as! [String: Any]
            try check(job["status"] as? String == "complete" && job["paperID"] as? String == "" && job["title"] as? String == access.descriptor.titleZh && witness["id"] as? String == access.descriptor.id && witness["manifestSHA256"] as? String == access.descriptor.source.manifestSHA256 && witness["normalizedRowSHA256"] as? String == access.descriptor.source.normalizedRowSHA256, "producer did not bind real descriptor")
            try check(try row(job).title == access.descriptor.titleZh && row(job).actions.isEmpty, "normal projection lost source")
        }
        await run("body failure preserves actual minted identity without claiming completion") {
            // Separate fresh source store has no cached body, so a failed transport cannot fall back.
            let isolated = root.appendingPathComponent("body-failure")
            app.library = try LibraryService(dataDirectory: isolated, transport: { url, limit in try await transport.read(url, limit: limit) }); _ = try await app.library.sync(); await transport.failingBody(true)
            let session = fresh(); var rejected = false
            do { _ = try await app.dispatchAggregates("aggregates.document", payload: ["id": id, "sessionID": session.id]) } catch { rejected = true }
            await transport.failingBody(false)
            let job = (app.store.value["jobs"] as! [[String: Any]]).first { $0["id"] as? String == session.id }!
            try check(rejected && job["status"] as? String == "failed" && NativeTaskProjection.aggregateSource(job)?.id == id && job["paperID"] as? String == "", "failure fabricated completion or lost proven source")
        }
        await run("unlisted source fails before metadata mint; payload title cannot supply provenance") {
            let bad = AggregateViewSession(generation: app.contextGeneration, aggregateID: "page:/audio-paper-digest-blog/not-listed/"); app.aggregateSession = bad
            var rejected = false
            do { _ = try await app.dispatchAggregates("aggregates.document", payload: ["id": bad.aggregateID, "sessionID": bad.id]) } catch { rejected = true }
            let job = (app.store.value["jobs"] as! [[String: Any]]).first { $0["id"] as? String == bad.id }!
            try check(rejected && job["status"] as? String == "failed" && job["aggregateSource"] == nil, "unlisted ID got provenance")
            do { _ = try await app.dispatchAggregates("aggregates.document", payload: ["id": bad.aggregateID, "sessionID": bad.id, "title": "自报标题"]) ; throw Failure(text: "payload accepted") } catch is Failure { throw Failure(text: "payload accepted") } catch {}
        }
        await run("source producer rejects stale owner, generation, access and ended task without changing raw jobs") {
            let session = fresh(); session.access = access
            try app.store.upsertJob(["id": session.id, "command": "aggregates.document", "status": "running", "paperID": ""])
            @MainActor func original() throws -> Data { try JSONSerialization.data(withJSONObject: app.store.value["jobs"]!, options: .sortedKeys) }
            let before = try original()
            app.aggregateSession = nil; try rejects { try app.recordAggregateJobSource(session, access: access) }; app.aggregateSession = session
            app.contextGeneration += 1; try rejects { try app.recordAggregateJobSource(session, access: access) }; app.contextGeneration -= 1; app.aggregateSession = session
            session.access = nil; try rejects { try app.recordAggregateJobSource(session, access: access) }; session.access = access
            app.currentPaperID = "different"; try rejects { try app.recordAggregateJobSource(session, access: access) }; app.currentPaperID = ""
            try check(try original() == before, "guard wrote unrelated job")
            try app.store.upsertJob(["id": session.id, "command": "aggregates.document", "status": "complete"])
            try rejects { try app.recordAggregateJobSource(session, access: access) }
        }
        await run("metadata disk failure throws and leaves original in-memory record unchanged") {
            let session = fresh(); session.access = access
            try app.store.upsertJob(["id": session.id, "command": "aggregates.document", "status": "running", "paperID": ""])
            let before = try JSONSerialization.data(withJSONObject: app.store.value, options: .sortedKeys), file = root.appendingPathComponent("personal.json"), saved = try Data(contentsOf: file)
            try FileManager.default.removeItem(at: file); try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
            defer { try? FileManager.default.removeItem(at: file); try? saved.write(to: file) }
            try rejects { try app.recordAggregateJobSource(session, access: access) }
            try check(try JSONSerialization.data(withJSONObject: app.store.value, options: .sortedKeys) == before, "failed save minted in-memory provenance")
        }
        await run("all producer and presentation checks use no credentials or visible windows") { try check(keyReads == 0 && NSApp.windows.isEmpty, "credential or window access") }
        print("RESULT \(passed) passed / \(failed) failed")
        exit(failed == 0 ? 0 : 1)
    }
}
