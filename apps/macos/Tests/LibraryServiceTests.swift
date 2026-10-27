import Foundation
import CryptoKit
import PDFKit

actor LibraryFixtureTransport {
    var files: [String: Data]
    var requests: [String] = []
    var delay: UInt64 = 0
    init(_ files: [String: Data]) { self.files = files }
    func read(_ url: URL, _ limit: Int) async throws -> Data {
        requests.append(url.path)
        if delay > 0 { try await Task.sleep(nanoseconds: delay) }
        guard let data = files[url.path] ?? files[url.path + "/"] else { throw LibraryService.ServiceError.network("fixture missing: \(url.path)") }
        return data
    }
    func update(_ path: String, _ data: Data) { files[path] = data }
    func setDelay(_ value: UInt64) { delay = value }
    func count() -> Int { requests.count }
}

final class LibraryURLFixtureProtocol: URLProtocol, @unchecked Sendable {
    static let lock=NSLock()
    static var files:[String:Data]=[:],delays:[String:Double]=[:],cancelled:[String]=[]
    private let stateLock=NSLock()
    private var finished=false
    override class func canInit(with request:URLRequest)->Bool {request.url?.host=="fixture.example"}
    override class func canonicalRequest(for request:URLRequest)->URLRequest {request}
    override func startLoading() {
        let path=request.url!.path
        Self.lock.lock();let data=Self.files[path] ?? Self.files[path+"/"],delay=Self.delays[path] ?? Self.delays[path.trimmingCharacters(in:CharacterSet(charactersIn:"/"))] ?? Self.delays[path.hasSuffix("/") ? String(path.dropLast()):path+"/"] ?? 0;Self.lock.unlock()
        DispatchQueue.global().asyncAfter(deadline:.now()+delay) {
            self.stateLock.lock();defer{self.stateLock.unlock()};guard !self.finished else{return};self.finished=true
            guard let data else{self.client?.urlProtocol(self,didFailWithError:URLError(.fileDoesNotExist));return}
            let response=HTTPURLResponse(url:self.request.url!,statusCode:200,httpVersion:"HTTP/1.1",headerFields:["Content-Length":String(data.count)])!
            self.client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed);self.client?.urlProtocol(self,didLoad:data);self.client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {
        stateLock.lock();defer{stateLock.unlock()};guard !finished else{return};finished=true
        Self.lock.lock();Self.cancelled.append(request.url!.path);Self.lock.unlock()
    }
    static func configure(_ values:[String:Data],_ timing:[String:Double]) {lock.lock();defer{lock.unlock()};files=values;delays=timing;cancelled=[]}
    static func stopped()->[String] {lock.lock();defer{lock.unlock()};return cancelled}
}

@main struct LibraryServiceTests {
    static let base = URL(string: "https://fixture.example/blog/")!
    static var assertions = 0
    static func expect(_ condition: Bool, _ message: String) throws {
        assertions += 1
        if !condition { throw LibraryService.ServiceError.invalid("TEST: " + message) }
    }
    static func temporary() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("LibraryServiceTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    static func expectFailure(_ message: String, operation: () async throws -> Void) async throws {
        var failed = false
        do { try await operation() } catch { failed = true }
        try expect(failed, message)
    }
    static func sha(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }
    static func row(_ identifier: String, slug: String, title: String, date: String, score: Double = 7) -> [String: Any] {
        ["permalink": "/blog/posts/\(slug)/", "pageType": "paper", "title": title, "titleZh": "中文 " + title,
         "date": date, "score": score, "task": "语音识别", "method": "对比学习", "tags": ["音频", "中文"],
         "sourceKind": "arxiv", "identityStatus": "verified", "arxivId": identifier,
         "citation": ["paperKey": "arxiv:" + identifier, "identityStatus": "verified", "verified": true, "complete": false,
                      "authors": ["Author 中文"], "title": title, "arxivId": identifier + "v1", "sourceKind": "arxiv",
                      "sourceUrl": "https://arxiv.org/abs/\(identifier)v1", "pdfUrl": "https://arxiv.org/pdf/\(identifier)v1.pdf"]]
    }
    static func fixture(_ groups: [[[String: Any]]]) throws -> [String: Data] {
        var files: [String: Data] = [:], shards: [[String: Any]] = []
        for (i, group) in groups.enumerated() {
            let bytes = try JSONSerialization.data(withJSONObject: group, options: [.sortedKeys])
            let hash = sha(bytes), name = "search-index/part-\(String(format: "%04d", i + 1))-\(hash.prefix(12)).json"
            files["/blog/" + name] = bytes
            shards.append(["url": name, "sha256": hash, "bytes": bytes.count, "recordCount": group.count])
        }
        let manifest: [String: Any] = ["contract": "paper-search-index-manifest-v1", "recordCount": groups.reduce(0) { $0 + $1.count }, "totalBytes": files.values.reduce(0) { $0 + $1.count }, "shards": shards]
        files["/blog/index.json"] = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
        return files
    }
    static func service(_ folder: URL, _ transport: LibraryFixtureTransport) throws -> LibraryService {
        try LibraryService(dataDirectory: folder, siteBaseURL: base, transport: { url, limit in try await transport.read(url, limit) })
    }
    static func testCatalogAndIncremental() async throws {
        let folder = try temporary(); defer { try? FileManager.default.removeItem(at: folder) }
        let a = row("2501.00001", slug: "a", title: "Alpha", date: "2026-01-01", score: 8)
        let newer = row("2501.00001", slug: "a-new", title: "Alpha corrected", date: "2026-02-01", score: 9)
        let b = row("2501.00002", slug: "b", title: "Beta", date: "2026-01-02", score: 7)
        let summary: [String: Any] = ["permalink": "/blog/posts/summary/", "pageType": "daily-summary", "title": "汇总"]
        let transport = LibraryFixtureTransport(try fixture([[a, summary], [b, newer]])), library = try service(folder, transport)
        let initial = try await library.sync()
        try expect(initial.recordCount == 4 && initial.paperCount == 2 && initial.shardCount == 2, "page/paper counts separated")
        let papers = await library.list(sort: .score)
        try expect(papers[0].title == "Alpha corrected" && papers[0].appearances.count == 2, "stable identity merges appearances and selects latest")
        try expect(await library.list(query: "中文").count == 2, "Chinese metadata search")
        try expect(await library.list(query: "Author").count == 2, "author search")
        try expect(await library.list(minimumScore: 8).count == 1, "minimum score")
        let firstRequests = await transport.count()
        _ = try await library.sync()
        try expect(await transport.count() == firstRequests + 1, "unchanged immutable shards reused with bytes/SHA validation")
        let listing = try await library.handle(command: "library.list", payload: ["query": "Beta", "limit": 100])
        try expect(listing["total"] as? Int == 1, "search pagination total matches filter")
        let restarted = try service(folder, transport)
        try expect(await restarted.list().count == 2, "atomic snapshot survives restart")
        print("ROUND 1 catalog/incremental: PASS")
    }
    static func testFailuresAndRetirement() async throws {
        let folder = try temporary(); defer { try? FileManager.default.removeItem(at: folder) }
        let a = row("2501.00001", slug: "a", title: "Alpha", date: "2026-01-01")
        let b = row("2501.00002", slug: "b", title: "Beta", date: "2026-01-02")
        let transport = LibraryFixtureTransport(try fixture([[a, b]])), library = try service(folder, transport)
        let good = try await library.sync()
        await transport.update("/blog/index.json", Data("{\"contract\":\"unknown-v99\"}".utf8))
        try await expectFailure("invalid manifest rejected") { _ = try await library.sync() }
        try expect(await library.status().snapshotID == good.snapshotID, "failed sync retains in-memory snapshot")
        let restarted = try service(folder, transport)
        try expect(await restarted.status().snapshotID == good.snapshotID, "failed sync retains persisted snapshot")
        let replacement = try fixture([[b]])
        for (path, bytes) in replacement { await transport.update(path, bytes) }
        let removed = try await library.sync()
        try expect(removed.missingFromLatest == ["arxiv:2501.00001"], "completed full snapshot records removal without calling it retraction")
        let again = try await library.sync()
        try expect(again.missingFromLatest == removed.missingFromLatest, "removal notice not erased on next unchanged sync")
        let restored = try fixture([[a, b]])
        for (path, bytes) in restored { await transport.update(path, bytes) }
        try expect(try await library.sync().missingFromLatest.isEmpty, "restoration clears active missing state")
        await transport.setDelay(3_000_000_000)
        let operation = Task { try await library.sync() }
        try await Task.sleep(nanoseconds: 30_000_000)
        await library.cancelSync()
        try await expectFailure("cancel must fail pending sync") { _ = try await operation.value }
        try expect(await library.status().snapshotID == good.snapshotID, "cancel retains previous complete snapshot")
        print("ROUND 2 failure/cancel/removal: PASS")
    }
    static func testHTML() async throws {
        let folder = try temporary(); defer { try? FileManager.default.removeItem(at: folder) }
        let a = row("2501.00001", slug: "a", title: "Alpha", date: "2026-01-01")
        let transport = LibraryFixtureTransport(try fixture([[a]])), library = try service(folder, transport)
        _ = try await library.sync()
        let p = await library.list()[0]
        let raw = """
        <!doctype html><html><head><meta charset="utf-8"></head><body><nav>NAVIGATION SECRET</nav><article class="post-single research-workbench"><div id="article-body" class="post-content md-content"><h2>真实中文方法</h2><p onclick="danger()">正文保留，公式 \\(x=1\\)</p><script>stealSecrets()</script><iframe src="https://evil.test"></iframe><a href="javascript:danger()">危险链接</a><img src="https://arxiv.org/html/2501.00001v1/figure.svg" onerror="danger()"><table><tr><td>真实表</td></tr></table></div></article><footer>FOOTER SECRET</footer></body></html>
        """
        let article = try LibraryService.extractArticle(raw, paper: p, pageURL: URL(string: p.blogURL)!)
        try expect(article.plainText.contains("真实中文方法"), "UTF8 Chinese survives XML HTML parsing")
        try expect(!article.html.contains("NAVIGATION") && !article.html.contains("FOOTER"), "precise body selector excludes chrome")
        try expect(!article.html.contains("stealSecrets") && !article.html.contains("onclick") && !article.html.contains("onerror") && !article.html.contains("javascript:") && !article.html.contains("iframe"), "active content stripped")
        try expect(article.html.contains("<table") && article.html.contains("x=1"), "table and original math retained")
        try expect(article.resources.count == 1, "actual image inventory")
        try await expectFailure("selector failure rejected") { _ = try LibraryService.extractArticle("<html><body><p>Wrong template</p></body></html>", paper: p, pageURL: URL(string: p.blogURL)!) }
        let mismatch = raw.replacingOccurrences(of: "<div id=", with: "<script type='application/json' class='paper-tools__citation-record'>{\"paperKey\":\"arxiv:2501.99999\"}</script><div id=")
        try await expectFailure("identity mismatch rejected") { _ = try LibraryService.extractArticle(mismatch, paper: p, pageURL: URL(string: p.blogURL)!) }
        print("ROUND 3 article selection/sanitization: PASS")
    }
    static func testAddressAndProxy() async throws {
        for bad in ["0.0.0.0", "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.2", "169.254.169.254", "100.64.1.2", "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "2001:db8::1", "2001::1", "2002:7f00:1::", "3fff::1"] {
            try expect(!LibraryService.isPublicAddress(bad), "reject reserved IP \(bad)")
        }
        for good in ["8.8.8.8", "151.101.3.42", "2001:4860:4860::8888", "2606:4700::1111"] { try expect(LibraryService.isPublicAddress(good), "allow global IP \(good)") }
        let folder = try temporary(); defer { try? FileManager.default.removeItem(at: folder) }
        let library = try LibraryService(dataDirectory: folder)
        try await library.configureNetwork(httpProxy: "http://127.0.0.1:7890")
        try await expectFailure("credential proxy rejected") { try await library.configureNetwork(httpProxy: "http://secret:key@127.0.0.1:7890") }
        print("ROUND 4 address/proxy guards: PASS")
    }
    static func testSeed() async throws {
        let folder = try temporary(); defer { try? FileManager.default.removeItem(at: folder) }
        let seed = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research")
        let library = try LibraryService(dataDirectory: folder, seedDirectory: seed, transport: { _, _ in throw LibraryService.ServiceError.network("seed must not need network") })
        try expect(await library.list().count == 15, "installed bundle seed contains 15 true publications")
        let article = try await library.article(for: "arxiv:2610.27491")
        try expect(article.markdown?.contains("data:image/png;base64,") == true && article.resources.count == 3, "three checksum-verified seed images embedded offline")
        try expect(article.completeOffline && article.plainText.contains("MiCLA"), "full seed text available without repository runtime")
        try expect(await library.searchCachedText("MiCLA").contains("arxiv:2610.27491"), "cached full text searchable")
        let citationText=String(data:try JSONEncoder().encode(article.citationSidecar),encoding:.utf8) ?? ""
        let contextText=String(data:try JSONEncoder().encode(article.researchContext),encoding:.utf8) ?? ""
        try expect(citationText.contains("Oki Electric") && citationText.contains("Kohei Yamamoto"), "seed citation keeps actual author affiliation metadata")
        try expect(contextText.contains("desktop-bundled-research-context-v1") && contextText.contains("abstract") && !contextText.contains("paper-research-context-v2"), "seed abstract context truthfully uses own bundled contract")
        let pdf = try await library.downloadPDF(for: "arxiv:2610.27491")
        try expect(pdf.sha256 == "01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c" && pdf.bytes == 489533, "actual 13-page seed PDF bytes verified")
        try expect(pdf.filePath.hasPrefix(folder.path+"/PublishedLibrary/pdf/"),"bundled PDF copied into private support directory for Zotero")
        let restored=try temporary();defer{try? FileManager.default.removeItem(at:restored)}
        try FileManager.default.removeItem(at:restored);try FileManager.default.copyItem(at:folder,to:restored)
        let aliases=try JSONEncoder().encode(PrivateStoragePaths.RootMap(roots:[folder.path]));try aliases.write(to:restored.appendingPathComponent(PrivateStoragePaths.aliasesFilename))
        let pointers=restored.appendingPathComponent("PublishedLibrary/pdf-pointers"),pointer=try FileManager.default.contentsOfDirectory(at:pointers,includingPropertiesForKeys:nil).first!,originalPointer=try Data(contentsOf:pointer)
        let relocated=try LibraryService(dataDirectory:restored,seedDirectory:seed,transport:{_,_ in throw LibraryService.ServiceError.network("relocation must not request")})
        let relocatedPDF=try await relocated.downloadPDF(for:"arxiv:2610.27491")
        try expect(relocatedPDF.filePath.hasPrefix(restored.path+"/") && relocatedPDF.sha256==pdf.sha256,"SHA-bound restored PDF pointer resolves to new private root")
        try expect(try Data(contentsOf:pointer)==originalPointer,"path relocation does not rewrite historical PDF pointer bytes")
        print("ROUND 5 packaged real-content seed: PASS")
    }
    static func testCitationFiles() async throws {
        let folder = try temporary(); defer { try? FileManager.default.removeItem(at: folder) }
        let a = row("2501.00001", slug: "a", title: "Alpha", date: "2026-01-01")
        var files = try fixture([[a]])
        let html = "<html><body><a href='/blog/data/papers/a/citation.bib'>BibTeX</a><div id='article-body' class='post-content'><p>原文导读</p></div></body></html>"
        let original = Data("@misc{actual_published_record,\n title = {Alpha},\n eprint = {2501.00001v1}\n}\n".utf8)
        files["/blog/posts/a/"] = Data(html.utf8); files["/blog/data/papers/a/citation.bib"] = original
        let transport = LibraryFixtureTransport(files), library = try service(folder, transport)
        _ = try await library.sync()
        let result = try await library.citationFile(for: "arxiv:2501.00001", format: "bib")
        try expect(result["text"] as? String == String(data: original, encoding: .utf8), "actual published BibTeX bytes retained without regeneration")
        try expect(result["sha256"] as? String == sha(original), "export SHA binds exact source bytes")
        try await expectFailure("missing RIS refused, not manufactured") { _ = try await library.citationFile(for: "arxiv:2501.00001", format: "ris") }
        print("ROUND 6 actual citation-file export: PASS")
    }
    static func testFreshnessAndIsolation() async throws {
        let folder=try temporary();defer{try? FileManager.default.removeItem(at:folder)}
        var a=row("2501.00001",slug:"a",title:"Alpha",date:"2026-01-01")
        var files=try fixture([[a]])
        func body(_ text:String,_ image:Bool=false)->Data {Data(("<html><body><div id='article-body' class='post-content'><p>"+text+"</p>"+(image ? "<img src='/blog/figure.png'>":"")+"</div></body></html>").utf8)}
        files["/blog/posts/a/"]=body("原始修订")
        let transport=LibraryFixtureTransport(files),library=try service(folder,transport)
        _=try await library.sync();let first=try await library.article(for:"arxiv:2501.00001")
        let initialCount=await transport.count();_=try await library.article(for:"arxiv:2501.00001")
        try expect(await transport.count()==initialCount,"fresh exact-source cached article reused")
        await transport.update("/blog/posts/a/",body("同URL新的真实修订"));_=try await library.sync()
        let newer=try await library.article(for:"arxiv:2501.00001")
        try expect(newer.plainText.contains("新的真实修订") && newer.revisionSHA256 != first.revisionSHA256 && newer.isStale==false,"even unchanged manifest sync revalidates same URL body")
        let archives=folder.appendingPathComponent("PublishedLibrary/article-revisions")
        let revisions=(FileManager.default.enumerator(at:archives,includingPropertiesForKeys:nil)?.allObjects as? [URL] ?? []).filter{$0.pathExtension=="json"}
        try expect(revisions.count>=2,"both scientific body revisions retained")
        let cacheFile=folder.appendingPathComponent("PublishedLibrary/articles/"+sha(Data("https://fixture.example/blog/posts/a/".utf8))+".json")
        var expired=try JSONSerialization.jsonObject(with:Data(contentsOf:cacheFile)) as! [String:Any];expired["fetchedAt"]="2020-01-01T00:00:00Z"
        try JSONSerialization.data(withJSONObject:expired).write(to:cacheFile,options:.atomic)
        await transport.update("/blog/posts/a/",body("期限到达的新正文"))
        let expiredRefresh=try await library.article(for:"arxiv:2501.00001")
        try expect(expiredRefresh.plainText.contains("期限到达"),"expired cache revalidates without another directory sync")
        await transport.update("/blog/posts/a/",Data("<html><p>invalid new template</p></html>".utf8))
        let stale=try await library.article(for:"arxiv:2501.00001",refresh:true)
        try expect(stale.isStale==true && stale.plainText==expiredRefresh.plainText && stale.notices.contains(where:{$0.contains("旧导读")}),"failed refresh preserves and clearly labels old offline revision")
        await transport.update("/blog/posts/a/",body("显式刷新恢复"))
        try expect(try await library.article(for:"arxiv:2501.00001",refresh:true).isStale==false,"explicit refresh recovers stale cache without waiting backoff")
        let imageBytes=Data([0x89,0x50,0x4e,0x47,1,2,3])
        await transport.update("/blog/posts/a/",body("缺图可恢复",true))
        let incomplete=try await library.article(for:"arxiv:2501.00001",refresh:true)
        try expect(!incomplete.completeOffline && incomplete.resources[0].missingReason != nil,"missing image is not falsely complete")
        await transport.update("/blog/figure.png",imageBytes)
        let repaired=try await library.article(for:"arxiv:2501.00001")
        try expect(repaired.completeOffline && repaired.html.contains("data:image/png;base64,"),"next normal open retries missing image and becomes complete")
        var citation=a["citation"] as! [String:Any];citation["arxivId"]="2501.00001v2";citation["sourceUrl"]="https://arxiv.org/abs/2501.00001v2";citation["pdfUrl"]="https://arxiv.org/pdf/2501.00001v2.pdf";a["citation"]=citation
        for(path,data) in try fixture([[a]]){await transport.update(path,data)}
        _=try await library.sync();await transport.update("/blog/posts/a/",Data("bad".utf8))
        let mismatchedPage=body("原文还是v1")
        let rawMismatch=String(decoding:mismatchedPage,as:UTF8.self).replacingOccurrences(of:"<body>",with:"<body><script type='application/json' class='paper-tools__citation-record'>{\"paperKey\":\"arxiv:2501.00001\",\"arxivId\":\"2501.00001v1\"}</script>")
        let currentPaper=await library.list()[0]
        try await expectFailure("page citation v1 cannot be labelled catalog v2"){_=try LibraryService.extractArticle(rawMismatch,paper:currentPaper,pageURL:URL(string:currentPaper.blogURL)!)}
        let versionStale=try await library.article(for:"arxiv:2501.00001")
        try expect(versionStale.isStale==true && versionStale.sourceVersion=="2501.00001v1" && versionStale.expectedSourceVersion=="2501.00001v2","v1 offline fallback never relabelled as current v2")
        // Native URLSession tasks, not only an injected async transport: cancel sync while article and PDF run.
        let isolationFolder=try temporary();defer{try? FileManager.default.removeItem(at:isolationFolder)}
        let pdf=try Data(contentsOf:URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf"))
        var nativeRow=row("2501.00001",slug:"a",title:"Native session fixture",date:"2026-01-01"),nativeCitation=row("2501.00001",slug:"a",title:"Native session fixture",date:"2026-01-01")["citation"] as! [String:Any]
        nativeCitation["pdfUrl"]="https://fixture.example/blog/2501.00001v1.pdf";nativeRow["citation"]=nativeCitation
        var nativeFiles=try fixture([[nativeRow]]);nativeFiles["/blog/posts/a/"]=body("独立阅读任务");nativeFiles["/blog/2501.00001v1.pdf"]=pdf
        LibraryURLFixtureProtocol.configure(nativeFiles,[:]);let configuration=URLSessionConfiguration.ephemeral;configuration.protocolClasses=[LibraryURLFixtureProtocol.self]
        let native=try LibraryService(dataDirectory:isolationFolder,siteBaseURL:base,sessionConfiguration:configuration);_=try await native.sync()
        LibraryURLFixtureProtocol.configure(nativeFiles,["/blog/index.json":0.8,"/blog/posts/a":0.4,"/blog/2501.00001v1.pdf":0.4])
        let sync=Task{try await native.sync()},article=Task{try await native.article(for:"arxiv:2501.00001")},download=Task{try await native.downloadPDF(for:"arxiv:2501.00001")}
        try await Task.sleep(nanoseconds:80_000_000);await native.cancelSync()
        try await expectFailure("native cancelled sync aborts only sync task"){_=try await sync.value}
        try expect(try await article.value.plainText.contains("独立阅读任务"),"simultaneous native article survives sync cancellation")
        try expect(try await download.value.bytes==pdf.count,"simultaneous native PDF survives sync cancellation")
        let stopped=LibraryURLFixtureProtocol.stopped()
        try expect(stopped.contains("/blog/index.json") && !stopped.contains("/blog/2501.00001v1.pdf"),"native URLSession cancellation is scoped to manifest transport")
        LibraryURLFixtureProtocol.configure(nativeFiles,["/blog/posts/a":0.8])
        let cancelledArticle=Task{try await native.article(for:"arxiv:2501.00001",refresh:true)}
        try await Task.sleep(nanoseconds:80_000_000);cancelledArticle.cancel()
        try await expectFailure("direct article task cancellation does not return stale success"){_=try await cancelledArticle.value}
        try await Task.sleep(nanoseconds:80_000_000)
        try expect(LibraryURLFixtureProtocol.stopped().contains(where:{$0.trimmingCharacters(in:CharacterSet(charactersIn:"/"))=="blog/posts/a"}),"direct article cancellation actually stops its own URLSession task: \(LibraryURLFixtureProtocol.stopped())")
        print("ROUND 7 revalidation/version/cancellation isolation: PASS")
    }
    static func testSeedVersionMismatch() async throws {
        let folder=try temporary();defer{try? FileManager.default.removeItem(at:folder)}
        let seed=URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research")
        let sample=try JSONSerialization.jsonObject(with:Data(contentsOf:seed.appendingPathComponent("sample.json"))) as! [String:Any],primary=sample["paper"] as! [String:Any]
        var changed=row("2610.27491",slug:"ignored",title:"MiCLA v2 current",date:"2026-10-24"),citation=changed["citation"] as! [String:Any]
        changed["permalink"]=primary["blogUrl"];citation["arxivId"]="2610.27491v2";citation["sourceUrl"]="https://arxiv.org/abs/2610.27491v2";citation["pdfUrl"]="https://arxiv.org/pdf/2610.27491v2.pdf";changed["citation"]=citation
        let index=try JSONSerialization.data(withJSONObject:[changed]),fixture=LibraryFixtureTransport(["/audio-paper-digest-blog/index.json":index])
        let library=try LibraryService(dataDirectory:folder,seedDirectory:seed,transport:{url,limit in try await fixture.read(url,limit)})
        _=try await library.sync()
        try await expectFailure("bundled v1 article cannot impersonate catalog v2"){_=try await library.article(for:"arxiv:2610.27491")}
        try await expectFailure("bundled v1 PDF cannot impersonate catalog v2"){_=try await library.downloadPDF(for:"arxiv:2610.27491")}
        try expect(await fixture.count()>=3,"v2 paths attempted rather than silently returning bundled v1")
        print("ROUND 8 exact bundled version binding: PASS")
    }
    static func testPDFVersionContract() async throws {
        let folder=try temporary();defer{try? FileManager.default.removeItem(at:folder)}
        let original=try Data(contentsOf:URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf"))
        let legacy=row("math/0101001",slug:"legacy",title:"Explicit legacy arXiv fixture",date:"2026-01-01")
        var files=try fixture([[legacy]]);files["/pdf/math/0101001v1.pdf"]=original
        let transport=LibraryFixtureTransport(files),library=try service(folder,transport);_=try await library.sync()
        try expect(try await library.downloadPDF(for:"arxiv:math/0101001").version=="math/0101001v1","legacy slash arXiv identity keeps exact official version")
        _=try await library.sync();let count=await transport.count();_=try await library.downloadPDF(for:"arxiv:math/0101001")
        try expect(await transport.count()==count,"explicit legacy arXiv version remains immutable across directory sync")
        var wrong=row("2501.00001",slug:"wrong",title:"Wrong PDF version fixture",date:"2026-01-01"),citation=row("2501.00001",slug:"wrong",title:"Wrong PDF version fixture",date:"2026-01-01")["citation"] as! [String:Any]
        citation["arxivId"]="2501.00001v2";citation["sourceUrl"]="https://arxiv.org/abs/2501.00001v2";wrong["citation"]=citation
        for(path,data) in try fixture([[wrong]]){await transport.update(path,data)}
        _=try await library.sync();let before=await transport.count()
        try await expectFailure("v1 official PDF cannot receive v2 source label"){_=try await library.downloadPDF(for:"arxiv:2501.00001")}
        try expect(await transport.count()==before,"contradictory exact source version rejected before PDF transport")
        print("ROUND 9 precise PDF source-version contract: PASS")
    }
    static func testMutablePDFLoopback(_ origin:String) async throws {
        let folder=try temporary();defer{try? FileManager.default.removeItem(at:folder)}
        let original=try Data(contentsOf:URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf"))
        let edited=PDFDocument(data:original)!;edited.removePage(at:12);let second=edited.dataRepresentation()!;edited.removePage(at:11);let third=edited.dataRepresentation()!
        func control(_ pdf:Data,offline:Bool=false,publicHash:String?=nil,kind:String="conference") async throws {
            var request=URLRequest(url:URL(string:origin+"/control")!);request.httpMethod="POST";let payload:[String:Any]=["pdf":pdf.base64EncodedString(),"offline":offline,"publicSHA":publicHash ?? NSNull(),"kind":kind];request.httpBody=try JSONSerialization.data(withJSONObject:payload);request.setValue("application/json",forHTTPHeaderField:"Content-Type")
            let(_,response)=try await URLSession.shared.data(for:request);guard (response as? HTTPURLResponse)?.statusCode==200 else{throw LibraryService.ServiceError.invalid("loopback control failed")}
        }
        let library=try LibraryService(dataDirectory:folder,siteBaseURL:base,transport:{url,limit in let(data,response)=try await URLSession.shared.data(from:URL(string:origin+url.path)!);guard (response as? HTTPURLResponse)?.statusCode==200,data.count<=limit else{throw LibraryService.ServiceError.network("real loopback PDF unavailable")};return data})
        _=try await library.sync();let id=await library.list()[0].id
        let first=try await library.downloadPDF(for:id)
        let receiptFile=folder.appendingPathComponent("PublishedLibrary/pdf-receipts/"+sha(Data(id.utf8))+"/"+first.sha256+".json"),originalReceipt=try Data(contentsOf:receiptFile)
        try expect(first.version==nil && first.cacheStatus=="current" && first.isStale==false && first.sha256==sha(original),"nil-version conference first PDF is actually fetched and current")
        let cached=try await library.downloadPDF(for:id)
        try expect(cached.sha256==first.sha256 && cached.isStale==false,"mutable PDF reuses its bounded current receipt")
        try await control(second);_=try await library.sync()
        let updated=try await library.downloadPDF(for:id)
        try expect(updated.sha256==sha(second) && updated.sha256 != first.sha256 && updated.cacheStatus=="revalidated" && updated.version==nil,"unchanged manifest new epoch revalidates same URL nil-version PDF")
        try expect(PDFDocument(url:URL(fileURLWithPath:updated.filePath))?.pageCount==12 && (try Data(contentsOf:URL(fileURLWithPath:first.filePath)))==original,"actual changed PDF pages installed while old source SHA bytes retained")
        try expect(try await library.downloadPDF(for:id,refresh:true).cacheStatus=="revalidated","explicit refresh performs a real PDF revalidation")
        let pointer=folder.appendingPathComponent("PublishedLibrary/pdf-pointers/"+sha(Data("https://fixture.example/blog/shared.pdf".utf8))+".json")
        var receipt=try JSONSerialization.jsonObject(with:Data(contentsOf:pointer)) as! [String:Any];receipt["validatedAt"]="2020-01-01T00:00:00Z";try JSONSerialization.data(withJSONObject:receipt).write(to:pointer,options:.atomic)
        try await control(third);let expired=try await library.downloadPDF(for:id)
        try expect(expired.sha256==sha(third) && PDFDocument(url:URL(fileURLWithPath:expired.filePath))?.pageCount==11,"mutable PDF TTL revalidates without another catalog sync")
        receipt=try JSONSerialization.jsonObject(with:Data(contentsOf:pointer)) as! [String:Any];receipt["validatedAt"]="2020-02-02T00:00:00Z";try JSONSerialization.data(withJSONObject:receipt).write(to:pointer,options:.atomic)
        try await control(third,offline:true);_=try await library.sync();let stale=try await library.downloadPDF(for:id)
        try expect(stale.sha256==expired.sha256 && stale.isStale==true && stale.cacheStatus=="stale" && stale.notices?.contains(where:{$0.contains("不代表网站当前")})==true,"offline mutable cache stays readable but explicitly stale")
        try expect(stale.validatedAt=="2020-02-02T00:00:00Z" && (try Data(contentsOf:URL(fileURLWithPath:stale.filePath)))==third,"failed revalidation does not fake validation time or overwrite original bytes")
        try await control(third);try expect(try await library.downloadPDF(for:id).isStale==true,"bounded failure backoff does not relabel cached old receipt current")
        try expect(try await library.downloadPDF(for:id,refresh:true).isStale==false,"explicit refresh recovers actual current PDF after offline failure")
        try await control(third,publicHash:String(repeating:"f",count:64));_=try await library.sync();let rejected=try await library.downloadPDF(for:id)
        try expect(rejected.isStale==true && rejected.sha256==sha(third) && rejected.notices?.contains(where:{$0.contains("已发布PDF SHA不符")})==true,"published PDF SHA mismatch never becomes current success")
        try await control(third,publicHash:sha(third));_=try await library.sync();let pinned=try await library.downloadPDF(for:id)
        try expect(pinned.isStale==false && pinned.publicSHA256==sha(third) && pinned.currentness=="published-sha256","actual matching published hash proves exact cached bytes without redundant fetch")
        try await control(original,kind:"arxiv");_=try await library.sync();let arxiv=try await library.downloadPDF(for:"arxiv:2610.27491")
        try await control(second,kind:"arxiv");_=try await library.sync();let immutable=try await library.downloadPDF(for:"arxiv:2610.27491")
        try expect(immutable.sha256==arxiv.sha256 && immutable.sha256==sha(original) && immutable.currentness=="immutable-arxiv-version","official explicit arXiv version avoids needless redownload on unrelated sync")
        try expect(try Data(contentsOf:receiptFile)==originalReceipt,"first actual PDF receipt remains byte-identical through subsequent currentness changes")
        let retained=await library.status().snapshotID
        try await control(second,publicHash:"malformed",kind:"arxiv")
        try await expectFailure("malformed published SHA cannot silently grant a content witness"){_=try await library.sync()}
        try expect(await library.status().snapshotID==retained,"malformed PDF SHA preserves previous complete catalog")
        print("PDF LOOPBACK: mutable URL nil-version, changed real PDF pages, epoch/TTL/refresh/offline/SHA/immutable checks passed")
    }
    static func testStrictLegacyIdentifiers() async throws {
        let folder=try temporary();defer{try? FileManager.default.removeItem(at:folder)}
        let pdf=try Data(contentsOf:URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf"))
        let legal=["math/0101001","hep-th/9901001","math.GT/0301001","cs.SE/0601001","nlin.CD/0201001"]
        let bad=["Math/0101001","hep-TH/9901001","math.gt/0101001","math.Gt/0101001","math/0113001","math/0101001/extra","math/0101001\n","../math/0101001","math%2F0101001","math/0101001v0","math/0101001v01","math/0101001v1tail"]
        var rows:[[String:Any]]=[]
        for(index,id) in (legal+bad).enumerated(){var value=row(id,slug:"strict-\(index)",title:"Strict identifier fixture \(index)",date:"2026-10-24");value["paperId"]="arxiv:"+id;rows.append(value)}
        var files=try fixture([rows]);for id in legal{files["/pdf/"+id+"v1.pdf"]=pdf}
        let transport=LibraryFixtureTransport(files),library=try service(folder,transport);_=try await library.sync()
        let papers=await library.list(limit:10000)
        for id in legal {
            let paper=papers.first{$0.id=="arxiv:"+id}
            try expect(paper?.sourceVersion==id+"v1","canonical legacy casing stays exact in catalog: "+id)
            try expect(try await library.downloadPDF(for:"arxiv:"+id).version==id+"v1","canonical legacy subject archive downloads exact version: "+id)
        }
        for index in bad.indices {
            let blog=base.appendingPathComponent("posts/strict-\(index+legal.count)/").absoluteString
            let paper=papers.first{$0.blogURL==blog}
            try expect(paper?.id.hasPrefix("page:")==true,"invalid legacy identity cannot bypass validation through explicit paperId: "+bad[index].debugDescription)
        }
        print("ROUND 10 strict legacy catalog/archive grammar: PASS")
    }
    static func testPublishedScoreScalar() async throws {
        let folder=try temporary();defer{try? FileManager.default.removeItem(at:folder)}
        let accepted:[(Any,Double)]=[(0,0),("0",0),(7.5,7.5),("7.5",7.5),(10,10),("10.0",10),(" 7.5 ",7.5)]
        let invalid:[Any]=[true,false,"","评分7.5/10","7.5/10","NaN","Infinity","11","-0.1",-1,11,NSNull(),[7.5],["score":7.5]]
        var rows:[[String:Any]]=[]
        for(index,value) in (accepted.map{$0.0}+invalid).enumerated(){var item=row("2501."+String(format:"%05d",index+1),slug:"score-\(index)",title:"Published scalar score fixture \(index)",date:"2026-10-24");item["score"]=value;rows.append(item)}
        var missing=row("2501.99999",slug:"score-missing",title:"No declared score fixture",date:"2026-10-24");missing["score"]=nil;missing["summary"]="A sentence that mentions 7.5/10 is not the structured score.";rows.append(missing)
        let transport=LibraryFixtureTransport(try fixture([rows])),library=try service(folder,transport);_=try await library.sync()
        let papers=await library.list(limit:10000)
        for(index,pair) in accepted.enumerated(){let paper=papers.first{$0.id=="arxiv:2501."+String(format:"%05d",index+1)};try expect(paper?.score==pair.1,"published declared string/number score retained exactly: \(pair.0)")}
        for index in invalid.indices {let paper=papers.first{$0.id=="arxiv:2501."+String(format:"%05d",index+accepted.count+1)};try expect(paper?.score==nil,"invalid/out-of-range/boolean score stays missing rather than inferred")}
        try expect(papers.first{$0.id=="arxiv:2501.99999"}?.score==nil,"missing structured score never scraped from prose")
        try expect(await library.list(minimumScore:7.5).count==5,"score filters use published decimal strings and numeric values consistently")
        print("ROUND 11 published score scalar: PASS")
    }
    @MainActor static func testPersonalCatalogJoin() async throws {
        let folder=try temporary();defer{try? FileManager.default.removeItem(at:folder)}
        let a=row("2501.00001",slug:"join-a",title:"Alpha",date:"2026-01-01"),b=row("2501.00002",slug:"join-b",title:"Beta",date:"2026-01-02")
        let aid="arxiv:2501.00001",bid="arxiv:2501.00002"
        let transport=LibraryFixtureTransport(try fixture([[a,b]])),library=try service(folder,transport)
        _=try await library.sync()
        let store=try DesktopStore(directory:folder)
        try store.setList("favorites",ids:[aid]);try store.setList("reading",ids:[aid,bid])
        _=try store.saveNote(id:aid,text:"Personal A remains A",baseRevision:0)
        _=try store.saveNote(id:bid,text:"Personal B remains B",baseRevision:0)
        try store.saveReading(id:aid,state:["guideScroll":1234,"pdfPage":5,"pdfOpen":true])
        try store.saveReading(id:bid,state:["guideScroll":22,"pdfPage":2,"pdfOpen":false])
        try store.rememberPaper(["id":aid,"title":"Alpha","sourceKind":"arxiv"])
        let personalFile=folder.appendingPathComponent("personal.json"),original=try Data(contentsOf:personalFile)
        func unchanged(_ phase:String)throws {
            try expect(try Data(contentsOf:personalFile)==original,phase+" normal catalog sync preserves every personal file byte")
            let cold=try DesktopStore(directory:folder),state=cold.snapshot()
            try expect(state["favorites"] as? [String]==[aid] && (state["reading"] as? [String])?.count==2 && Set(state["reading"] as? [String] ?? [])==Set([aid,bid]),phase+" cold list counts and exact identities remain1/2")
            let notes=state["notes"] as! [String:[String:Any]],reading=state["readingState"] as! [String:[String:Any]]
            try expect(notes[aid]?["text"] as? String=="Personal A remains A" && notes[bid]?["text"] as? String=="Personal B remains B",phase+" no cross-paper note reassignment")
            try expect(reading[aid]?["pdfPage"] as? Int==5 && reading[aid]?["guideScroll"] as? Int==1234 && reading[bid]?["pdfPage"] as? Int==2,phase+" reading positions stay with their original IDs")
            try expect((state["personalPapers"] as? [String:[String:Any]])?[aid]?["title"] as? String=="Alpha",phase+" original saved-paper fallback remains available")
        }
        let renamed=row("2501.00001",slug:"join-a",title:"Alpha corrected",date:"2026-02-01")
        for(path,bytes) in try fixture([[renamed,b]]){await transport.update(path,bytes)}
        let corrected=try await library.sync(),correctedRows=await library.list()
        try expect(corrected.paperCount==2 && correctedRows.first{$0.id==aid}?.title=="Alpha corrected","normal renamed catalog retains stable A identity and updated public title")
        try unchanged("rename")
        for(path,bytes) in try fixture([[b]]){await transport.update(path,bytes)}
        let removed=try await library.sync(),remaining=await library.list()
        try expect(removed.missingFromLatest==[aid] && remaining.map(\.id)==[bid],"normal full snapshot removal flags only A without turning it into B or a retraction")
        try unchanged("remove")
        for(path,bytes) in try fixture([[renamed,b]]){await transport.update(path,bytes)}
        let restored=try await library.sync(),coldLibrary=try service(folder,transport),coldRows=await coldLibrary.list()
        try expect(restored.missingFromLatest.isEmpty && Set(coldRows.map(\.id))==Set([aid,bid]) && coldRows.first{$0.id==aid}?.title=="Alpha corrected","normal restore and new LibraryService reload expose the same two public identities")
        try unchanged("restore")
        print("ROUND 12 seeded personal/catalog rename-remove-restore join: PASS")
    }
    static func liveArticle() async throws {
        let folder=try temporary();defer{try? FileManager.default.removeItem(at:folder)}
        let seed=URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research")
        let library=try LibraryService(dataDirectory:folder,seedDirectory:seed)
        let article=try await library.article(for:"arxiv:2610.27491",refresh:true,downloadImages:false)
        try expect(article.markdown==nil && article.isStale==false && article.plainText.contains("MiCLA"),"real current HTML passes strict source and version checks")
        try expect(article.citationSidecar != nil && article.researchContext != nil,"real current sidecars pass strict original version checks")
        print("LIVE ARTICLE: actual MiCLA HTML and both sidecars verified; no PDF or model request")
    }
    static func liveCitations() async throws {
        let folder = try temporary(); defer { try? FileManager.default.removeItem(at: folder) }
        let seed = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research")
        let library = try LibraryService(dataDirectory: folder, seedDirectory: seed)
        for format in ["bib", "ris", "json"] {
            let value = try await library.citationFile(for: "arxiv:2610.27491", format: format)
            try expect((value["text"] as? String)?.contains("2610.27491") == true, "published \(format) belongs to actual paper")
            try expect((value["sha256"] as? String)?.count == 64, "published \(format) byte SHA present")
            print("LIVE CITATION \(format): actual source read and SHA checked")
        }
    }
    static func live() async throws {
        let folder = try temporary(); defer { try? FileManager.default.removeItem(at: folder) }
        let library = try LibraryService(dataDirectory: folder)
        let summary = try await library.sync { p in print("LIVE \(p.phase) \(p.completed)/\(p.total) \(p.message)") }
        try expect(summary.recordCount > 8000 && summary.shardCount >= 20 && summary.paperCount > 5000, "whole real website imported")
        let matches = await library.list(query: "RubatoCodec")
        try expect(matches.count >= 1, "real published paper searchable")
        let article = try await library.article(for: matches[0].id, downloadImages: false)
        try expect(article.plainText.contains("RubatoCodec") && article.html.contains("<table") && !article.html.contains("giscus"), "real full article preserves science and strips site navigation")
        try expect(article.citationSidecar != nil && article.researchContext != nil && article.resources.count == 4, "real bibliography, context and four figures discovered")
        print("LIVE RESULT \(summary.recordCount) page records / \(summary.paperCount) unique papers / \(summary.shardCount) shards / \(article.plainText.count) article characters")
    }
    static func main() async {
        do {
            if let option=CommandLine.arguments.firstIndex(of:"--pdf-loopback"),CommandLine.arguments.count>option+1 {try await testMutablePDFLoopback(CommandLine.arguments[option+1])}
            else if CommandLine.arguments.contains("--personal-sync-only") { try await testPersonalCatalogJoin() }
            else if CommandLine.arguments.contains("--live") { try await live() }
            else if CommandLine.arguments.contains("--article-live") { try await liveArticle() }
            else if CommandLine.arguments.contains("--citations-live") { try await liveCitations() }
            else {
                try await testCatalogAndIncremental()
                try await testFailuresAndRetirement()
                try await testHTML()
                try await testAddressAndProxy()
                try await testSeed()
                try await testCitationFiles()
                try await testFreshnessAndIsolation()
                try await testSeedVersionMismatch()
                try await testPDFVersionContract()
                try await testStrictLegacyIdentifiers()
                try await testPublishedScoreScalar()
                try await testPersonalCatalogJoin()
            }
            print("PASS \(assertions) assertions")
        } catch { fputs("FAIL: \(error.localizedDescription)\n", stderr); exit(1) }
    }
}
