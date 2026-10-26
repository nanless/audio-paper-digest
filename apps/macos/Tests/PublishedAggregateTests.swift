import Foundation
import Darwin

/// Small controlled fixtures belong to ordinary CI; large observed website snapshots stay in QA.
@main struct PublishedAggregateTests {
    static func main() throws {
        let kinds = ["daily", "conference", "page"]
        let rows: [[String: Any]] = kinds.map { kind in
            ["pageType": kind, "permalink": "/audio-paper-digest-blog/ci-\(kind)/", "title": "受控\(kind)页面", "date": "0001-01-01", "citation": ["complete": false], "futurePublisherField": ["preserve": true]]
        }
        let shard = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
        let hash = PublishedAggregateReader.sha(shard)
        let manifest = try JSONSerialization.data(withJSONObject: ["contract": "paper-search-index-manifest-v1", "recordCount": 3, "totalBytes": shard.count, "shards": [["url": "search-index/part-0001-\(hash.prefix(12)).json", "bytes": shard.count, "sha256": hash, "recordCount": 3]]], options: [.sortedKeys])
        let catalog = try PublishedAggregateReader.read(manifest: manifest) { _ in shard }
        var passed = 0
        func check(_ condition: Bool, _ label: String) throws {
            guard condition else { throw AggregateFailure.invalid(label) }
            passed += 1; print("PASS " + label)
        }
        func rejects(_ action: () throws -> Void) -> Bool { do { try action(); return false } catch { return true } }
        try check(catalog.records.count == 3 && Set(catalog.records.map { $0.kind.rawValue }) == Set(kinds) && catalog.records.allSatisfy { $0.displayDate == nil }, "three explicit aggregate kinds preserve unknown dates")
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(catalog.records[0])) as! [String: Any]
        try check(["pdfURL", "authors", "arxivId", "citation", "sourceVersion"].allSatisfy { encoded[$0] == nil }, "aggregate metadata grants no single-paper capabilities")
        let changedShard = Data(String(decoding: shard, as: UTF8.self).replacingOccurrences(of: "受控", with: "授控").utf8)
        guard changedShard.count == shard.count, PublishedAggregateReader.sha(changedShard) != hash, let changedRows = try JSONSerialization.jsonObject(with: changedShard) as? [[String: Any]], changedRows.count == rows.count else { throw AggregateFailure.invalid("Invalid equal-length JSON corruption fixture") }
        try check(rejects { _ = try PublishedAggregateReader.read(manifest: manifest) { _ in changedShard } }, "equal-length valid JSON shard cannot borrow original SHA witness")
        let fm = FileManager.default, physical = realpath(fm.temporaryDirectory.path, nil)!
        defer { free(physical) }
        let directory = URL(fileURLWithPath: String(cString: physical)).appendingPathComponent("aggregate-ci-" + UUID().uuidString)
        try fm.createDirectory(at: directory.appendingPathComponent("index"), withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: directory) }
        try shard.write(to: directory.appendingPathComponent("index/\(hash).json"))
        let store = PublishedAggregateStore(directory: directory), epoch = "00000000-0000-0000-0000-000000000001", other = "00000000-0000-0000-0000-000000000002"
        _ = try store.stage(manifest: manifest, validationEpoch: epoch)
        try check(try store.load(activeSnapshotSHA256: catalog.snapshotSHA256, validationEpoch: nil) == nil && store.load(activeSnapshotSHA256: catalog.snapshotSHA256, validationEpoch: other) == nil && store.load(activeSnapshotSHA256: catalog.snapshotSHA256, validationEpoch: epoch) == catalog, "same manifest requires its exact current validation epoch")
        let original = try store.originalRow(for: catalog.records[0])
        let row = try JSONSerialization.jsonObject(with: original) as! [String: Any]
        try check(row["futurePublisherField"] != nil && PublishedAggregateReader.sha(original) == catalog.records[0].source.normalizedRowSHA256, "original publisher fields retain their row witness")
        var allBodiesVerified = true
        for descriptor in catalog.records {
            let attributes = descriptor.kind == .page ? "class='reader-guide-content post-content'" : "id='article-body' class='post-content'"
            let html = Data("<html><body><div \(attributes)><h2 id='anchor'>正文</h2><table><tr><td>7.5</td></tr></table><math><mi>x</mi></math><img src='https://example.org/image.png' onerror='bad()'><script>bad()</script><p onclick='bad()'>说明</p></div></body></html>".utf8)
            let document = try store.cacheDocument(html, descriptor: descriptor, responseURL: URL(string: descriptor.sourceURL)!, fetchedAt: "2026-10-27T00:00:00Z")
            let cold = try PublishedAggregateStore(directory: directory).cachedDocument(descriptor: descriptor, rawHTMLSHA256: document.rawHTMLSHA256)
            allBodiesVerified = allBodiesVerified && document == cold && document.bodyHTML.contains("<table") && document.bodyHTML.contains("<math") && document.bodyHTML.contains("anchor") && !document.bodyHTML.contains("script") && !document.bodyHTML.contains("onclick") && !document.bodyHTML.contains("src=") && document.resources.count == 1 && !document.completeOffline
        }
        try check(allBodiesVerified, "three body selectors preserve content and cold replay without executable or offline claims")
        // Exact UTF8 source vector is shared byte-for-byte with the Android normal test.
        let legacyVector = #"[{"pageType":"paper","permalink":"/audio-paper-digest-blog/ci-alias-paper/","title":"Existing paper"},{"pageType":"daily-summary","permalink":"/audio-paper-digest-blog/ci-alias-daily/","title":"Legacy summary","identityStatus":"verified","pdfURL":"https://arxiv.org/pdf/2501.00001","paperId":"arxiv:2501.00001","citation":{"pdfUrl":"https://arxiv.org/pdf/2501.00001"},"futurePublisherField":{"preserve":true}}]"#
        func legacyRead(_ value:String)throws->PublishedAggregateCatalog {
            let bytes=Data(value.utf8),hash=PublishedAggregateReader.sha(bytes)
            let witness=try JSONSerialization.data(withJSONObject:["contract":"paper-search-index-manifest-v1","recordCount":2,"totalBytes":bytes.count,"shards":[["url":"search-index/part-0001-"+hash.prefix(12)+".json","bytes":bytes.count,"sha256":hash,"recordCount":2]]],options:.sortedKeys)
            return try PublishedAggregateReader.read(manifest:witness){_ in bytes}
        }
        let legacy=try legacyRead(legacyVector),legacyRow=(try JSONSerialization.jsonObject(with:Data(legacyVector.utf8)) as! [[String:Any]])[1],legacyDTO=legacy.records[0]
        let legacyJSON=try JSONSerialization.jsonObject(with:JSONEncoder().encode(legacyDTO)) as! [String:Any]
        try check(legacy.sourceRecordCount==2&&legacy.records.count==1&&legacyDTO.kind == .daily&&legacyDTO.rawDate.isEmpty&&legacyDTO.displayDate==nil&&legacyDTO.conferenceScope==nil&&legacyDTO.source.rowIndex==1&&legacyDTO.source.normalizedRowSHA256==PublishedAggregateReader.sha(try PublishedAggregateReader.normalizedRow(legacyRow))&&["pdfURL","paperId","citation","identityStatus"].allSatisfy{legacyJSON[$0]==nil}&&legacyRow["pageType"] as? String=="daily-summary","legacy daily-summary aliases display kind only; raw row witness and unknown date survive")
        try check(["conference-summary","conference-task","future-summary","DAILY-SUMMARY","daily-summary "].allSatisfy{kind in rejects{_=try legacyRead(legacyVector.replacingOccurrences(of:"daily-summary",with:kind))}},"unsupported scan kinds and unknown page types still reject with a valid original witness")
        print("RESULT passed=\(passed) failed=0")
    }
}
