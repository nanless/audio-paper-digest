import Foundation
import Darwin

actor AggregateFixtureTransport {
    var files: [String: Data]
    var failure = false
    var delayed = false
    init(_ files: [String: Data]) { self.files = Dictionary(uniqueKeysWithValues: files.map { ("https://nanless.github.io" + $0.key, $0.value) }) }
    func setFailure(_ value: Bool) { failure = value }
    func replace(_ files: [String: Data]) { self.files = Dictionary(uniqueKeysWithValues: files.map { ("https://nanless.github.io" + $0.key, $0.value) }) }
    func setDelayed(_ value: Bool) { delayed = value }
    func read(_ url: URL, _ limit: Int) async throws -> Data {
        if delayed { try await Task.sleep(nanoseconds: 100_000_000) }
        if failure { throw URLError(.notConnectedToInternet) }
        guard let data = files[url.absoluteString], data.count <= limit else { FileHandle.standardError.write(Data(("MISSING " + url.absoluteString + " keys=" + files.keys.sorted().joined(separator:",") + "\n").utf8)); throw URLError(.fileDoesNotExist) }
        return data
    }
}

@main struct AggregatePresentationTests {
    static var checks = 0
    static func expect(_ value: Bool, _ reason: String) throws { checks += 1; if !value { throw AggregateFailure.invalid("TEST: " + reason) }; print("PASS " + reason) }
    static func rejects(_ action: () async throws -> Void) async -> Bool { do { try await action(); return false } catch { return true } }
    static func temp() throws -> URL { let p = realpath(FileManager.default.temporaryDirectory.path, nil)!; defer { free(p) }; let u = URL(fileURLWithPath: String(cString:p)).appendingPathComponent("aggregate-ui34-" + UUID().uuidString); try FileManager.default.createDirectory(at:u,withIntermediateDirectories:true);return u }
    static func fixture(title: String = "受控日更") throws -> (Data, Data, String, [String: Data]) {
        let prefix = "/audio-paper-digest-blog/"
        var rows: [[String: Any]] = ["daily", "conference", "page"].map { kind in ["pageType": kind, "permalink": prefix + "ci-" + kind + "/", "title": kind == "daily" ? title:kind, "date": "0001-01-01"] }
        rows.append(["pageType":"paper", "permalink":prefix+"papers/ci-paper/", "title":"Controlled paper", "titleZh":"受控论文", "date":"2026-10-24", "sourceKind":"arxiv", "identityStatus":"verified", "arxivId":"2510.00001", "citation":["paperKey":"arxiv:2510.00001", "identityStatus":"verified", "verified":true, "complete":false, "authors":["Author"], "title":"Controlled paper", "arxivId":"2510.00001v1", "sourceKind":"arxiv", "sourceUrl":"https://arxiv.org/abs/2510.00001v1", "pdfUrl":"https://arxiv.org/pdf/2510.00001v1.pdf"]])
        let shard = try JSONSerialization.data(withJSONObject:rows,options:[.sortedKeys]), sha = PublishedAggregateReader.sha(shard), path = "search-index/part-0001-" + sha.prefix(12) + ".json"
        let manifest = try JSONSerialization.data(withJSONObject:["contract":"paper-search-index-manifest-v1", "recordCount":rows.count, "totalBytes":shard.count, "shards":[["url":path, "sha256":sha, "bytes":shard.count, "recordCount":rows.count]]],options:[.sortedKeys])
        var files = [prefix+"index.json":manifest, prefix+path:shard]
        let html = "<html><body><div id='article-body' class='post-content'><h2 id='dest'>真实正文</h2><table><tr><td>7.5</td></tr></table><math><mi>x</mi></math><a href='#dest'>本页</a><a href='"+prefix+"ci-conference/'>会议</a><a href='"+prefix+"papers/ci-paper/'>论文</a><a href='https://example.org/reference/'>外链</a><a href='javascript:bad()'>拒绝</a><img src='https://example.org/image.png'/><script>bad()</script></div></body></html>"
        files[prefix+"ci-daily/"] = Data(html.utf8)
        return (manifest,shard,sha,files)
    }
    static func routingRegressions(_ root: URL) async throws {
        let fm=FileManager.default,base="https://nanless.github.io/audio-paper-digest-blog/"
        let fixtureRoot=CommandLine.arguments.count>1 ? URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true) : URL(fileURLWithPath:fm.currentDirectoryPath).appendingPathComponent("apps/macos/Tests/Fixtures")
        let original=try Data(contentsOf:fixtureRoot.appendingPathComponent("aggregate-daily24-links-original.html"))
        let rowBytes=try Data(contentsOf:fixtureRoot.appendingPathComponent("aggregate-daily24-links-rows.json"))
        try expect(PublishedAggregateReader.sha(original)=="c51f3797c5e9036ddb5afef60fab0463c6a2ab48991980639f557d915fe9ab1a","real published daily24 original bytes retained")
        try expect(PublishedAggregateReader.sha(rowBytes)=="378f31b189af4c9066adb5ec81fbf54b7fd355d89f075642e1bcce94e39de851","two real directory rows retained as exported fixture")
        func install(_ rows:[[String:Any]],_ html:Data,_ page:String,_ suffix:String) async throws -> (LibraryService,AggregateReadAccess,AggregatePresentationDocument) {
            let shard=try JSONSerialization.data(withJSONObject:rows,options:.sortedKeys),sha=PublishedAggregateReader.sha(shard),path="search-index/part-0001-"+sha.prefix(12)+".json"
            let manifest=try JSONSerialization.data(withJSONObject:["contract":"paper-search-index-manifest-v1","recordCount":rows.count,"totalBytes":shard.count,"shards":[["url":path,"sha256":sha,"bytes":shard.count,"recordCount":rows.count]]],options:.sortedKeys)
            let transport=AggregateFixtureTransport(["/audio-paper-digest-blog/index.json":manifest,"/audio-paper-digest-blog/"+path:shard,page:html])
            let service=try LibraryService(dataDirectory:root.appendingPathComponent(suffix),transport:{url,limit in try await transport.read(url,limit)})
            _=try await service.sync()
            let access=try await service.aggregateReadAccess(id:"page:"+page),doc=try await service.aggregatePresentation(access)
            return(service,access,doc)
        }
        let rows=try JSONSerialization.jsonObject(with:rowBytes) as! [[String:Any]]
        let(real,access,document)=try await install(rows,original,"/audio-paper-digest-blog/posts/2026-10-24/","real")
        for index in [1,3] {try expect(try await real.aggregateLink(access,document:document,index:index) == .paper("arxiv:2610.30682"),"real original daily24 link \(index) opens verified local paper with single final slash alias")}
        try expect(document.source.rawHTMLSHA256==PublishedAggregateReader.sha(original)&&PublishedAggregateReader.sha(Data(document.source.bodyHTML.utf8))==document.source.sanitizedBodySHA256,"routing leaves original raw and body witness untouched")
        let(_,shard,_,_)=try fixture();var controlledRows=try JSONSerialization.jsonObject(with:shard) as! [[String:Any]]
        controlledRows.append(["pageType":"paper","permalink":"/audio-paper-digest-blog/papers/unverified/","title":"Unverified controlled paper","identityStatus":"unknown"])
        let tests:[(String,AggregateLinkDestination)]=[
            (base+"papers/ci-paper",.paper("arxiv:2510.00001")),
            (base+"ci-conference",.aggregate("page:/audio-paper-digest-blog/ci-conference/")),
            (base+"ci-daily#dest",.anchor("dest")),
            (base+"papers/ci-paper/",.paper("arxiv:2510.00001")),
            (base+"papers/ci-paper/?existing=1",.paper("arxiv:2510.00001")),
        ]
        let negatives=[
            "https://example.invalid/audio-paper-digest-blog/papers/ci-paper",
            "https://nanless.github.io.example.invalid/audio-paper-digest-blog/papers/ci-paper",
            base+"papers/ci-paper-extra",base+"papers/ci-paper?new=1",base+"papers/ci-%70aper",
            base+"papers/ci-paper//",base+"papers/unverified",base+"papers/unknown",
            base+"ci-daily?new=1#dest",base+"ci-conference?new=1",
            "https://nanless.github.io:443/audio-paper-digest-blog/papers/ci-paper",
            "https://example.invalid/reference/?q=1#original",
        ]
        let all=tests+negatives.map{($0,.external(URL(string:$0)!))}
        let cachedOffsite="https://example.invalid/archive/cold-paper",cachedOtherProject="https://nanless.github.io/another-project/cold-paper"
        let coldCases:[(String,AggregateLinkDestination)]=[
            (cachedOffsite+"/",.paper("arxiv:2510.00991")),(cachedOffsite,.external(URL(string:cachedOffsite)!)),
            (cachedOtherProject+"/",.paper("arxiv:2510.00992")),(cachedOtherProject,.external(URL(string:cachedOtherProject)!)),
        ]
        let links=(all+coldCases).enumerated().map{"<a href='"+$0.element.0.replacingOccurrences(of:"&",with:"&amp;")+"'>route"+String($0.offset)+"</a>"}.joined()
        let html=Data(("<html><body><div id='article-body' class='post-content'><h2 id='dest'>Controlled routing</h2>"+links+"</div></body></html>").utf8)
        let(service,own,presented)=try await install(controlledRows,html,"/audio-paper-digest-blog/ci-daily/","boundaries")
        for(index,test) in all.enumerated(){let actual=try await service.aggregateLink(own,document:presented,index:index);try expect(actual==test.1,"bounded route \(index) keeps same-site single-slash and original authority")}
        // Cold snapshots were historically decoded directly: do not assume every saved paper
        // was freshly minted by sameSite. Preserve old exact behavior, refuse only new aliases.
        let current=root.appendingPathComponent("boundaries/PublishedLibrary/current.json")
        var snapshot=try JSONSerialization.jsonObject(with:Data(contentsOf:current)) as! [String:Any]
        var saved=snapshot["papers"] as! [[String:Any]]
        let template=saved.first{$0["identityStatus"] as? String=="verified"}!
        for (index,address) in [cachedOffsite,cachedOtherProject].enumerated() {
            var paper=template;paper["id"]="arxiv:2510.0099"+String(index+1);paper["blogURL"]=address+"/";paper["appearances"]=[address+"/"];saved.append(paper)
        }
        snapshot["papers"]=saved
        try JSONSerialization.data(withJSONObject:snapshot,options:.sortedKeys).write(to:current,options:.atomic)
        let cold=try LibraryService(dataDirectory:root.appendingPathComponent("boundaries"),transport:{_,_ in throw URLError(.notConnectedToInternet)})
        let coldAccess=try await cold.aggregateReadAccess(id:"page:/audio-paper-digest-blog/ci-daily/"),coldDocument=try await cold.aggregatePresentation(coldAccess)
        for (index,test) in coldCases.enumerated(){try expect(try await cold.aggregateLink(coldAccess,document:coldDocument,index:all.count+index)==test.1,"cold snapshot route \(index) preserves exact but never extends offsite or other-project authority")}
        try expect(coldDocument.source==presented.source,"cold routing keeps the same verified aggregate source")
        try expect(try Data(contentsOf:fixtureRoot.appendingPathComponent("aggregate-daily24-links-original.html"))==original&&Data(contentsOf:fixtureRoot.appendingPathComponent("aggregate-daily24-links-rows.json"))==rowBytes,"routing never rewrites source or catalog fixture")
    }
    static func main() async throws {
        setbuf(stdout,nil)
        let fm = FileManager.default, root = try temp(); defer { try? fm.removeItem(at:root) }
        let (manifest,shard,sha,files) = try fixture(), storage = root.appendingPathComponent("store")
        try fm.createDirectory(at:storage.appendingPathComponent("index"),withIntermediateDirectories:true);try shard.write(to:storage.appendingPathComponent("index/"+sha+".json"))
        let store = PublishedAggregateStore(directory:storage), catalog = try store.stage(manifest:manifest,validationEpoch:UUID().uuidString), descriptor = catalog.records.first { $0.kind == .daily }!
        try expect(try store.latestVerifiedDocument(for:descriptor) == nil,"no fabricated cached revision")
        let first = try store.cacheDocument(files["/audio-paper-digest-blog/ci-daily/"]!,descriptor:descriptor,responseURL:URL(string:descriptor.sourceURL)!,fetchedAt:"2026-10-24T12:00:00Z")
        let secondBytes = Data(String(decoding:files["/audio-paper-digest-blog/ci-daily/"]!,as:UTF8.self).replacingOccurrences(of:"真实正文",with:"新正文").utf8)
        let second = try store.cacheDocument(secondBytes,descriptor:descriptor,responseURL:URL(string:descriptor.sourceURL)!,fetchedAt:"2026-10-24T12:00:00.900Z")
        try expect(try store.latestVerifiedDocument(for:descriptor) == second,"latest selection uses actual fractional observation time")
        let folder = storage.appendingPathComponent("aggregate-documents/"+PublishedAggregateReader.sha(Data(descriptor.id.utf8))+"/"+descriptor.source.manifestSHA256+"/"+first.rawHTMLSHA256)
        try Data("corrupt".utf8).write(to:folder.appendingPathComponent("body.html"))
        try expect(await rejects { _ = try store.latestVerifiedDocument(for:descriptor) },"corrupt older same-scope cache is not silently skipped")
        try fm.removeItem(at:folder)
        let secondFolder = storage.appendingPathComponent("aggregate-documents/"+PublishedAggregateReader.sha(Data(descriptor.id.utf8))+"/"+descriptor.source.manifestSHA256+"/"+second.rawHTMLSHA256)
        try fm.createSymbolicLink(at:folder,withDestinationURL:secondFolder)
        try expect(await rejects { _ = try store.latestVerifiedDocument(for:descriptor) },"same-scope symlink cannot alias another valid revision")
        try fm.removeItem(at:folder)
        let unexpected = secondFolder.deletingLastPathComponent().appendingPathComponent("unregistered")
        try fm.createDirectory(at:unexpected,withIntermediateDirectories:false)
        try expect(await rejects { _ = try store.latestVerifiedDocument(for:descriptor) },"unknown same-scope revision is an explicit error")
        let changed = try fixture(title:"当前新见证"), current = try PublishedAggregateReader.read(manifest:changed.0) { _ in changed.1 }
        try changed.1.write(to:storage.appendingPathComponent("index/"+changed.2+".json"));_ = try store.stage(manifest:changed.0,validationEpoch:UUID().uuidString)
        try expect(try store.latestVerifiedDocument(for:current.records.first{$0.kind == .daily}!) == nil,"new manifest never borrows old same-ID document")

        let serviceRoot = root.appendingPathComponent("service"), transport = AggregateFixtureTransport(files)
        let service = try LibraryService(dataDirectory:serviceRoot,transport:{url,limit in try await transport.read(url,limit)})
        _ = try await service.sync()
        let id = "page:/audio-paper-digest-blog/ci-daily/", access = try await service.aggregateReadAccess(id:id), presentation = try await service.aggregatePresentation(access)
        try expect(await rejects { _ = try await service.aggregateReadAccess(id:"page:/audio-paper-digest-blog/not-in-manifest/") },"unlisted aggregate ID cannot mint source access")
        let otherAccess = try await service.aggregateReadAccess(id:"page:/audio-paper-digest-blog/ci-conference/")
        try expect(await rejects { _ = try await service.aggregateLink(otherAccess,document:presentation,index:0) },"another real descriptor cannot borrow this document link table")
        let value = try presentation.bridgeValue()
        try expect(!presentation.isStale && presentation.validatedAt != nil && presentation.source.descriptor.id == id && (value["linkCount"] as? Int) == 4,"fresh actor document binds real access and four actual links")
        try expect(presentation.displayHTML.contains("<table") && presentation.displayHTML.contains("<math") && presentation.displayHTML.contains("[图片未缓存") && !presentation.displayHTML.contains("javascript:") && !presentation.displayHTML.contains("src="),"display preserves table and math without executable or resource URL")
        try expect(PublishedAggregateReader.sha(Data(presentation.source.bodyHTML.utf8)) == presentation.source.sanitizedBodySHA256 && (value["displayBodySHA256"] as? String) != presentation.source.sanitizedBodySHA256,"source and rewritten display retain distinct exact digests")
        try expect(try await service.aggregateLink(access,document:presentation,index:0) == .anchor("dest"),"actual local anchor")
        try expect(try await service.aggregateLink(access,document:presentation,index:1) == .aggregate("page:/audio-paper-digest-blog/ci-conference/"),"actual link resolves another typed aggregate")
        try expect(try await service.aggregateLink(access,document:presentation,index:2) == .paper("arxiv:2510.00001"),"actual link resolves verified catalog paper by original URL")
        try expect(try await service.aggregateLink(access,document:presentation,index:3) == .external(URL(string:"https://example.org/reference/")!),"actual external link remains its source URL")
        try expect(await rejects { _ = try await service.aggregateLink(access,document:presentation,index:4) },"no arbitrary extra link index")
        await transport.setFailure(true)
        let stale = try await service.aggregatePresentation(access)
        try expect(stale.isStale && stale.validatedAt == nil && stale.source == presentation.source && !stale.source.completeOffline,"network failure returns exact verified old revision with stale and incomplete claims")
        await transport.setFailure(false);await transport.setDelayed(true)
        let task = Task { try await service.aggregatePresentation(access) }; task.cancel()
        try expect(await rejects { _ = try await task.value },"cancellation cannot become a stale success")
        await transport.setDelayed(false);await transport.replace(changed.3);_ = try await service.sync()
        try expect(await rejects { _ = try await service.aggregatePresentation(access) },"retired access cannot borrow replacement manifest")
        let replacement = try await service.aggregateReadAccess(id:id);await transport.setFailure(true)
        try expect(await rejects { _ = try await service.aggregatePresentation(replacement) },"new witness plus network failure never opens old-manifest HTML")
        try await routingRegressions(root.appendingPathComponent("routing"))
        print("RESULT passed=\(checks) failed=0")
    }
}
