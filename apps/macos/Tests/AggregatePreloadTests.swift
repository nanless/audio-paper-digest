import AppKit
import Foundation
import Darwin

private actor PreloadTransport {
    var files: [String: Data]
    var requests: [String] = []
    var slow = false
    init(_ files: [String: Data]) { self.files = files }
    func setSlow() { slow = true }
    func read(_ url: URL, _ limit: Int) async throws -> Data {
        requests.append(url.absoluteString)
        if slow && !url.path.hasSuffix(".json") { try await Task.sleep(nanoseconds: 5_000_000_000) }
        guard let bytes = files[url.absoluteString], bytes.count <= limit else { throw URLError(.fileDoesNotExist) }
        return bytes
    }
}

@main @MainActor struct AggregatePreloadTests {
    static var checks = 0
    static func check(_ value: Bool, _ message: String) throws {
        guard value else { throw AggregateFailure.invalid("TEST: " + message) }
        checks += 1; print("PASS " + message)
    }
    static func main() async throws {
        setbuf(stdout, nil)
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("aggregate-preload-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let base = PublishedAggregateReader.site.absoluteString
        var rows: [[String: Any]] = []
        for (path, kind, date) in [("daily-new/", "daily", "2026-10-30"), ("daily-before/", "daily", "2026-10-29"), ("daily-old/", "daily", "2026-10-28"), ("conferences/", "page", "0001-01-01"), ("conference-a/", "conference", "2026-10-25"), ("conference-a-task-one/", "conference", "2026-10-31")] {
            rows.append(["pageType": kind, "permalink": base + path, "title": path, "date": date])
        }
        rows.append(["pageType": "paper", "permalink": base + "papers/one/", "title": "Controlled paper", "date": "2026-10-30", "sourceKind": "arxiv", "identityStatus": "verified", "arxivId": "2610.00001"])
        let shard = try JSONSerialization.data(withJSONObject: rows, options: .sortedKeys)
        let sha = PublishedAggregateReader.sha(shard), shardPath = "search-index/part-0001-" + sha.prefix(12) + ".json"
        let manifest = try JSONSerialization.data(withJSONObject: ["contract": "paper-search-index-manifest-v1", "recordCount": rows.count, "totalBytes": shard.count, "shards": [["url": shardPath, "sha256": sha, "bytes": shard.count, "recordCount": rows.count]]], options: .sortedKeys)
        var files = [base + "index.json": manifest, base + shardPath: shard]
        for row in rows where row["pageType"] as? String != "paper" {
            let url = row["permalink"] as! String
            let attrs = url.hasSuffix("conferences/") ? "id='conference-directory' class='conference-directory'" : "id='article-body' class='post-content'"
            files[url] = Data(("<html><body><div " + attrs + "><p>Controlled public page</p><img src='" + base + "images/not-prefetched.png'/></div></body></html>").utf8)
        }
        let transport = PreloadTransport(files)
        let app = PaperDigestApp(); app.directory = root; app.store = try DesktopStore(directory: root)
        app.window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        app.window.isReleasedWhenClosed = false
        defer { app.window.close() }
        var keyReads = 0
        app.model = ModelService(directory: root, store: app.store, keyProvider: { keyReads += 1; return nil })
        app.library = try LibraryService(dataDirectory: root, transport: { url, limit in try await transport.read(url, limit) })
        _ = try await app.library.sync()
        let result = try await app.dispatchAggregates("aggregates.preload", payload: [:])
        let task = app.aggregatePreloadTask
        await task?.value
        let read = await transport.requests.filter { !$0.hasSuffix(".json") }
        try check(result["started"] as? Bool == true && Set(read) == Set([base + "daily-new/", base + "daily-before/", base + "conferences/", base + "conference-a/"]), "bounded prefetch reads two latest daily pages, conference directory and overview only")
        try check(read.count == 4 && keyReads == 0 && app.currentPaperID.isEmpty && app.aggregateSession == nil, "prefetch opens no paper, image, PDF, model or visible session")
        _ = try await app.dispatchAggregates("aggregates.preload", payload: [:]); await app.aggregatePreloadTask?.value
        let after = await transport.requests.filter { !$0.hasSuffix(".json") }
        try check(after == read, "already verified saved pages are not downloaded again")
        var rejected = false
        do { _ = try await app.dispatchAggregates("aggregates.preload", payload: ["url": "https://example.invalid/"]) } catch { rejected = true }
        try check(rejected, "prefetch rejects caller supplied addresses")
        let slow = PreloadTransport(files); await slow.setSlow()
        app.library = try LibraryService(dataDirectory: root.appendingPathComponent("slow"), transport: { url, limit in try await slow.read(url, limit) })
        _ = try await app.library.sync()
        _ = try await app.dispatchAggregates("aggregates.preload", payload: [:])
        let cancelled = app.aggregatePreloadTask
        _ = try await app.dispatchAggregates("aggregates.open", payload: ["id": "page:/audio-paper-digest-blog/daily-new/"])
        await cancelled?.value
        try check(app.aggregatePreloadTask == nil && app.aggregatePreloadID == nil && app.aggregateSession?.aggregateID.hasSuffix("daily-new/") == true, "foreground opening cancels optional preload and keeps its own reading session")
        try check(keyReads == 0, "all preload cases leave credentials and paid services untouched")
        print("RESULT passed=\(checks) failed=0")
    }
}
