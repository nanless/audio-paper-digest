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
        let marker = directory.appendingPathComponent("aggregate-activations/\(catalog.snapshotSHA256)/\(epoch).json")
        let current = try Data(contentsOf: marker)
        var markerJSON = try JSONSerialization.jsonObject(with: current) as! [String:Any]
        let family = "published-aggregate-activation"
        try check(ClientProtocols.isCurrentHeader(markerJSON,family),"new activation carries the current schema fingerprint")
        let sidecar=directory.appendingPathComponent("aggregate-index/\(catalog.snapshotSHA256).json")
        let currentSidecar=try Data(contentsOf:sidecar)
        var sidecarJSON=try JSONSerialization.jsonObject(with:currentSidecar) as! [String:Any]
        try check(ClientProtocols.isCurrentHeader(sidecarJSON,"published-aggregate-index"),"new catalog carries the current schema fingerprint")
        sidecarJSON.removeValue(forKey:"schemaFingerprint")
        sidecarJSON["contract"]="published-aggregate-index-v1"
        let historicalSidecar=try JSONSerialization.data(withJSONObject:sidecarJSON,options:[.sortedKeys])
        try historicalSidecar.write(to:sidecar)
        markerJSON["catalogSHA256"]=PublishedAggregateReader.sha(historicalSidecar)
        markerJSON.removeValue(forKey:"schemaFingerprint")
        markerJSON["contract"] = "published-aggregate-activation-v1"
        let historical = try JSONSerialization.data(withJSONObject:markerJSON,options:[.sortedKeys])
        try historical.write(to:marker)
        let coldStore = PublishedAggregateStore(directory:directory)
        try check(try coldStore.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:epoch)==catalog && coldStore.stage(manifest:manifest,validationEpoch:epoch)==catalog && Data(contentsOf:marker)==historical && Data(contentsOf:sidecar)==historicalSidecar,"cold and repeated staging preserve original activation bytes")
        markerJSON["schemaFingerprint"] = ClientProtocols.schemaFingerprint(family)
        try JSONSerialization.data(withJSONObject:markerJSON).write(to:marker)
        try check(rejects { _ = try coldStore.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:epoch) },"mixed historical and current activation header is refused")
        try currentSidecar.write(to:sidecar)
        try current.write(to:marker)
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
        let item=catalog.records.first!
        let prefix=directory.appendingPathComponent("aggregate-documents/\(PublishedAggregateReader.sha(Data(item.id.utf8)))/\(catalog.snapshotSHA256)")
        let revision=try FileManager.default.contentsOfDirectory(atPath:prefix.path).first!
        let documentPath=prefix.appendingPathComponent(revision+"/document.json")
        var originalDocument=try JSONSerialization.jsonObject(with:Data(contentsOf:documentPath)) as! [String:Any]
        try check(ClientProtocols.isCurrentHeader(originalDocument,"published-aggregate-document"),"new body uses a fingerprinted platform-parser declaration")
        originalDocument.removeValue(forKey:"schemaFingerprint")
        originalDocument["contract"]="published-aggregate-document-v1"
        originalDocument["parserContract"]="published-aggregate-html-v1"
        let originalDocumentBytes=try JSONSerialization.data(withJSONObject:originalDocument,options:[.sortedKeys])
        try originalDocumentBytes.write(to:documentPath)
        let originalRead=try coldStore.cachedDocument(descriptor:item,rawHTMLSHA256:revision)
        try check(originalRead.parserContract=="published-aggregate-html-v1" && (try Data(contentsOf:documentPath))==originalDocumentBytes,"old native parser observation cold replays without rewriting")
        originalDocument["parserContract"]="published-aggregate-jsoup-v1"
        try JSONSerialization.data(withJSONObject:originalDocument).write(to:documentPath)
        try check(rejects { _ = try coldStore.cachedDocument(descriptor:item,rawHTMLSHA256:revision) },"foreign parser cannot act as a native cold replay")
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
        let legacyConferencesDescriptor = PublishedAggregate(
            id: "page:/audio-paper-digest-blog/conferences/",
            kind: .page,
            conferenceScope: nil,
            title: "Conferences",
            titleZh: "会议目录",
            summary: "",
            rawDate: "2026-10-27",
            displayDate: "2026-10-27",
            categories: [],
            tags: [],
            sourceURL: "https://nanless.github.io/audio-paper-digest-blog/conferences/",
            source: catalog.records[0].source
        )
        let legacyConferencesHTML = Data("<html><link rel='canonical' href='https://nanless.github.io/audio-paper-digest-blog/conferences/'/><body><div id='conference-directory' class='conference-directory'><p>旧路径会议总目录</p><figure><img src='https://arxiv.org/html/2501.00001v1/fig1.png' alt='fig'/><figcaption>图注</figcaption></figure></div></body></html>".utf8)
        let legacyConferencesDoc = try LibraryService.extractAggregateHTML(
            legacyConferencesHTML,
            descriptor: legacyConferencesDescriptor,
            responseURL: URL(string: legacyConferencesDescriptor.sourceURL)!,
            fetchedAt: "2026-10-27T00:00:00Z"
        )
        let legacyConferencesPlan = try LibraryService.aggregateImagePlan(legacyConferencesDoc, rawHTML: legacyConferencesHTML)
        try check(legacyConferencesDoc.plainText.contains("旧路径会议总目录") && legacyConferencesPlan.slots.count == 1 && legacyConferencesPlan.slots[0].caption == "图注", "legacy /audio-paper-digest-blog/conferences/ selects #conference-directory on both extractAggregateHTML and aggregateImagePlan")
        // Track-1 Item 4: desktop-details sync against official portal supplements canonical /about/, /conferences/, /links/ pages
        // and falls back from empty tagConceptIds to flatTags/tags, while non-portal test fixtures stay untouched.
        let desktopDir = FileManager.default.temporaryDirectory.appendingPathComponent("DesktopCanonicalPages-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: desktopDir.appendingPathComponent("desktop-details/catalog", isDirectory: true), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: desktopDir) }
        let desktopRows: [[String: Any]] = [
            ["pageType": "paper", "appearanceId": "posts/2026-11-26-sample-paper/", "pageUrl": "posts/2026-11-26-sample-paper/", "paperId": "arxiv:2611.00001", "identityStatus": "verified", "title": "Sample Paper"],
            ["pageType": "daily", "appearanceId": "posts/2026-11-26-daily/", "pageUrl": "posts/2026-11-26-daily/", "identityStatus": "aggregate-page", "title": "2026-11-26 Audio Daily", "titleZh": "2026-11-26 音频日更", "summary": "日更汇总", "blogPublishedAt": "2026-11-26", "tagConceptIds": [] as [String], "flatTags": ["语音合成", "音频编解码"]]
        ]
        let desktopShardBytes = try JSONSerialization.data(withJSONObject: desktopRows, options: [.sortedKeys])
        let desktopShardSHA = PublishedAggregateReader.sha(desktopShardBytes)
        let desktopShardURL = "client/details/catalog/\(desktopShardSHA).json"
        try desktopShardBytes.write(to: desktopDir.appendingPathComponent("desktop-details/catalog/\(desktopShardSHA).json"))
        let desktopManifestObj = try ClientProtocols.record("paper-desktop-snapshot", fields: [
            "recordCount": 2,
            "paperCount": 1,
            "appearanceCount": 2,
            "catalogShards": [["url": desktopShardURL, "sha256": desktopShardSHA, "bytes": desktopShardBytes.count, "recordCount": 2]]
        ])
        let desktopManifestBytes = try JSONSerialization.data(withJSONObject: desktopManifestObj, options: [.sortedKeys])
        let desktopEpoch = UUID().uuidString
        let portalStore = PublishedAggregateStore(directory: desktopDir, siteBase: PublishedAggregateReader.site)
        let stagedPortal = try portalStore.stage(manifest: desktopManifestBytes, validationEpoch: desktopEpoch)
        let loadedPortal = try portalStore.load(activeSnapshotSHA256: stagedPortal.snapshotSHA256, validationEpoch: desktopEpoch)
        try check(stagedPortal == loadedPortal && stagedPortal.sourceRecordCount == 2 && stagedPortal.aggregateCount == 4, "official portal desktop snapshot stages & cold-loads 1 daily + 3 canonical pages")
        let pageURLs = Set(stagedPortal.records.filter { $0.kind == .page }.map(\.sourceURL))
        try check(pageURLs == Set(["https://nanless.github.io/audio-research-portal/about/", "https://nanless.github.io/audio-research-portal/conferences/", "https://nanless.github.io/audio-research-portal/links/"]), "canonical portal pages include /about/, /conferences/, /links/")
        let dailyRecord = stagedPortal.records.first { $0.kind == .daily }
        try check(dailyRecord?.tags == ["语音合成", "音频编解码"], "desktop aggregate row falls back to flatTags when tagConceptIds is empty")
        let confPage = stagedPortal.records.first { $0.sourceURL.hasSuffix("/conferences/") }!
        let aboutPage = stagedPortal.records.first { $0.sourceURL.hasSuffix("/about/") }!
        _ = try portalStore.originalRow(for: confPage)
        let confHTML = Data("<html><link rel='canonical' href='https://nanless.github.io/audio-research-portal/conferences/'/><body><div id='conference-directory' class='conference-directory'><h2>会议总目录</h2><p>ICASSP / Interspeech / NeurIPS</p></div></body></html>".utf8)
        let cachedConf = try portalStore.cacheDocument(confHTML, descriptor: confPage, responseURL: URL(string: confPage.sourceURL)!, fetchedAt: "2026-11-26T00:00:00Z")
        let replayedConf = try portalStore.cachedDocument(descriptor: confPage, rawHTMLSHA256: cachedConf.rawHTMLSHA256)
        try check(replayedConf == cachedConf && replayedConf.plainText.contains("会议总目录"), "canonical /conferences/ page passes originalRow, cacheDocument, and cold cachedDocument replay")
        let aboutHTML = Data("<html><link rel='canonical' href='https://nanless.github.io/audio-research-portal/about/'/><body><div class='reader-guide-content post-content'><h2>关于与使用方法</h2><p>使用指南正文</p></div></body></html>".utf8)
        let cachedAbout = try portalStore.cacheDocument(aboutHTML, descriptor: aboutPage, responseURL: URL(string: aboutPage.sourceURL)!, fetchedAt: "2026-11-26T00:00:00Z")
        try check((try portalStore.cachedDocument(descriptor: aboutPage, rawHTMLSHA256: cachedAbout.rawHTMLSHA256)).plainText.contains("使用指南正文"), "canonical /about/ page passes cacheDocument and cold replay")
        let nonPortalDir = FileManager.default.temporaryDirectory.appendingPathComponent("NonPortalDesktop-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: nonPortalDir.appendingPathComponent("desktop-details/catalog", isDirectory: true), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: nonPortalDir) }
        try desktopShardBytes.write(to: nonPortalDir.appendingPathComponent("desktop-details/catalog/\(desktopShardSHA).json"))
        let fixtureStore = PublishedAggregateStore(directory: nonPortalDir, siteBase: URL(string: "https://fixture.example/blog/")!)
        let stagedFixture = try fixtureStore.stage(manifest: desktopManifestBytes, validationEpoch: desktopEpoch)
        try check(stagedFixture.aggregateCount == 1 && stagedFixture.records.allSatisfy { $0.kind != .page }, "non-portal fixture siteBase does not inject canonical portal pages")
        print("RESULT passed=\(passed) failed=0")
    }
}
