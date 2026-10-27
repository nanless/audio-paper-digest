import AppKit
import Foundation
import Darwin
import WebKit

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
@MainActor private final class ReadyWindow: NSWindow {
    var testVisible = true
    override var isVisible: Bool { testVisible }
}
@main @MainActor struct AggregateReadyTests {
    static var passed = 0, failed = 0
    static func check(_ value: @autoclosure () throws -> Bool, _ reason: String) throws { if try !value() { throw Failure(text: reason) } }
    static func run(_ label: String, _ body: () async throws -> Void) async { do { try await body(); passed += 1; print("PASS " + label) } catch { failed += 1; print("FAIL " + label + ": " + ((error as? Failure)?.text ?? String(describing: type(of: error)))) } }
    static func rejects(_ action: () throws -> Void) throws { do { try action() } catch is Failure { throw Failure(text: "assertion in rejection") } catch { return }; throw Failure(text: "expected rejection") }
    static func row(_ job: [String: Any], live: Set<String> = []) throws -> NativeTaskRow { try NativeTaskProjection.make(.init(jobs: [job], sessions: [], liveJobIDs: live)).rows[0] }
    static func main() async throws {
        setbuf(stdout, nil)
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let physical = realpath(FileManager.default.temporaryDirectory.path, nil)!; defer { free(physical) }
        let root = URL(fileURLWithPath: String(cString: physical)).appendingPathComponent("aggregate-ready71-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); defer { try? FileManager.default.removeItem(at: root) }
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
        let window = ReadyWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        app.window = window
        app.web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: { let value = WKWebViewConfiguration(); value.websiteDataStore = .nonPersistent(); return value }())
        window.contentView!.addSubview(app.web)
        var posts = 0
        let notify: (WKWebView) -> Void = { value in precondition(value === app.web); posts += 1 }
        func served() async throws -> (AggregateViewSession, [String: Any]) {
            let session = fresh()
            let value = try await app.dispatchAggregates("aggregates.document", payload: ["id": id, "sessionID": session.id])
            return (session, ["id": id, "sessionID": session.id, "documentReadyNonce": value["documentReadyNonce"]!, "displayBodySHA256": value["displayBodySHA256"]!])
        }
        func reject(_ payload: [String: Any]) async throws {
            let before = posts
            var rejected = false
            do { _ = try await app.dispatchAggregates("aggregates.viewReady", payload: payload, notifyLayout: notify) } catch { rejected = true }
            try check(rejected && before == posts, "invalid ready posted")
        }
        await run("unread native session cannot receive ready from self-reported JSON") {
            let session = fresh()
            try await reject(["id": id, "sessionID": session.id, "documentReadyNonce": UUID().uuidString.lowercased(), "displayBodySHA256": String(repeating: "a", count: 64)])
        }
        await run("actual actor document mints exact ticket; one current ready posts once") {
            let (session, payload) = try await served(), before = posts
            try check(UUID(uuidString: payload["documentReadyNonce"] as! String) != nil && payload["documentReadyNonce"] as? String == session.readyNonce && payload["displayBodySHA256"] as? String == PublishedAggregateReader.sha(Data(session.document!.displayHTML.utf8)), "ticket not derived from actual presentation")
            let result = try await app.dispatchAggregates("aggregates.viewReady", payload: payload, notifyLayout: notify)
            try check(result["accepted"] as? Bool == true && posts == before + 1, "current ready missing")
            try await reject(payload)
        }
        await run("extra URL text and malformed or mismatched nonce/hash reject") {
            let (_, payload) = try await served()
            for (key, value): (String, Any) in [("url", "https://example.invalid"), ("text", "self report"), ("documentReadyNonce", true), ("documentReadyNonce", UUID().uuidString.lowercased()), ("displayBodySHA256", String(repeating: "b", count: 64)), ("displayBodySHA256", NSNull())] {
                var invalid = payload; invalid[key] = value; try await reject(invalid)
            }
        }
        await run("old session and generation/ABA cannot notify a newer same-ID session") {
            let (old, payload) = try await served()
            _ = try await served(); try await reject(payload)
            app.aggregateSession = old; app.contextGeneration += 1; try await reject(payload)
            app.contextGeneration -= 1; app.aggregateSession = fresh(); try await reject(payload)
        }
        await run("leave invalidates old ready even before a different document is read") {
            let (_, payload) = try await served()
            _ = try await app.dispatchAggregates("aggregates.leave", payload: ["id": id, "sessionID": payload["sessionID"]!])
            try await reject(payload)
        }
        await run("re-read replaces ticket; prior served ready cannot notify") {
            let (session, old) = try await served()
            let value = try await app.dispatchAggregates("aggregates.document", payload: ["id": id, "sessionID": session.id])
            try check(value["documentReadyNonce"] as? String != old["documentReadyNonce"] as? String, "same ticket reused")
            try await reject(old)
            var latest = old; latest["documentReadyNonce"] = value["documentReadyNonce"]!
            _ = try await app.dispatchAggregates("aggregates.viewReady", payload: latest, notifyLayout: notify)
        }
        await run("failed real refresh clears old ticket before body failure") {
            let (_, payload) = try await served()
            let previous = app.library
            app.library = try LibraryService(dataDirectory: root.appendingPathComponent("failed-refresh"), transport: { url, limit in try await transport.read(url, limit: limit) })
            _ = try await app.library.sync(); await transport.failingBody(true)
            var failed = false
            do { _ = try await app.dispatchAggregates("aggregates.document", payload: ["id": id, "sessionID": payload["sessionID"]!]) } catch { failed = true }
            await transport.failingBody(false); app.library = previous
            try check(failed, "controlled uncached body did not fail")
            try await reject(payload)
        }
        await run("in-flight read and pending transition reject without consuming latest ticket") {
            let (session, payload) = try await served()
            session.loading = true; try await reject(payload); session.loading = false
            app.aggregateTransitionPending = true; try await reject(payload); app.aggregateTransitionPending = false
            try check(!session.readyPosted, "rejection consumed ticket")
        }
        await run("retired context and paper context reject") {
            let (_, payload) = try await served(); app.retireAggregateContext(); try await reject(payload)
            let (_, next) = try await served(); app.currentPaperID = "unrelated-paper"; try await reject(next); app.currentPaperID = ""
        }
        await run("native tasks/notes and readonly sheet reject") {
            let (_, payload) = try await served()
            app.nativeTasksRequestedVisible = true; try await reject(payload); app.nativeTasksRequestedVisible = false
            app.nativeNotesRequestedVisible = true; try await reject(payload); app.nativeNotesRequestedVisible = false
            app.storageDetailSession = StorageDetailSession(generation: app.contextGeneration, paperID: "", previousResponder: nil); try await reject(payload); app.storageDetailSession = nil
        }
        await run("maintenance and termination reject") {
            let (_, payload) = try await served()
            app.maintenanceBusy = true; try await reject(payload); app.maintenanceBusy = false
            app.terminationPending = true; try await reject(payload); app.terminationPending = false
        }
        await run("hidden detached or non-visible own web cannot notify") {
            let (_, payload) = try await served()
            app.web.isHidden = true; try await reject(payload); app.web.isHidden = false
            app.web.removeFromSuperview(); try await reject(payload); window.contentView!.addSubview(app.web)
            window.testVisible = false; try await reject(payload); window.testVisible = true
        }
        await run("missing actual access/document and source mismatch reject") {
            let (session, payload) = try await served(), original = session.access, doc = session.document
            session.access = nil; try await reject(payload); session.access = original
            session.document = nil; try await reject(payload); session.document = doc
            session.readyDisplaySHA = String(repeating: "c", count: 64); var changed = payload; changed["displayBodySHA256"] = session.readyDisplaySHA; try await reject(changed)
        }
        await run("no visible windows, credentials or extra paid services used") {
            try check(keyReads == 0 && !NSApp.windows.contains(where: { $0 !== window && $0.isVisible }) && !window.isKeyWindow, "test escaped isolated non-presented window")
        }
        app.web.removeFromSuperview(); window.close()
        print("RESULT \(passed) passed / \(failed) failed")
        exit(failed == 0 ? 0 : 1)
    }
}
