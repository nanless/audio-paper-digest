import Foundation
import CryptoKit

private final class MemoryCredentialStore: ZoteroCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    func load(serverID: String) throws -> Data? { lock.withLock { values[serverID] } }
    func save(_ data: Data, serverID: String) throws { lock.withLock { values[serverID] = data } }
    func remove(serverID: String) throws { _ = lock.withLock { values.removeValue(forKey: serverID) } }
    func seed() throws { try save(JSONSerialization.data(withJSONObject: ["key": String(repeating: "x", count: 32), "remember": true]), serverID: "test-instance") }
}
private final class ZoteroMockProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, [String: String], Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (status, headers, data) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
private final class MockZotero: @unchecked Sendable {
    var serverID = "test-instance"
    var version = "10.0.6"
    var denied = false
    var oneTime = false
    var unauthorized = false
    var failPDFUploadOnce = false
    var foreignUploadURL = false
    var notesCorrupt = false
    var objects: [String: [String: Any]] = [:]
    var collections: [String: [String: Any]] = [:]
    var files: [String: Data] = [:]
    var uploads: [String: String] = [:]
    var hashes: [String: String] = [:]
    var requests: [(String, String)] = []
    let storage: URL
    private var counter = 100
    init(storage: URL) { self.storage = storage }
    func key() -> String { counter += 1; return String(format: "ABCD%04d", counter) }
    func data(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object) }
    func body(_ r: URLRequest) throws -> Data {
        if let body = r.httpBody { return body }
        guard let stream = r.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var result = Data(); var buffer = [UInt8](repeating: 0, count: 8192)
        while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; result.append(contentsOf: buffer.prefix(n)) }
        return result
    }
    func response(_ request: URLRequest) throws -> (Int, [String: String], Data) {
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        requests.append((method, path))
        let headers = ["X-Zotero-Version": version, "Zotero-API-Version": "3", "Zotero-Server-ID": serverID, "Content-Type": "application/json"]
        func ok(_ object: Any, _ status: Int = 200) throws -> (Int, [String: String], Data) { (status, headers, try data(object)) }
        if path == "/api/" || path == "/api" { return (200, headers, Data("ready".utf8)) }
        if let requested = request.value(forHTTPHeaderField: "Zotero-Server-ID"), requested != serverID { return try ok([:], 412) }
        if method != "GET" && !path.hasPrefix("/api/local/uploads/") && path != "/api/local/authorize" {
            if unauthorized { return try ok([:], 401) }
            guard request.value(forHTTPHeaderField: "Zotero-API-Key")?.count == 32 else { return try ok([:], 401) }
        }
        if path == "/api/local/authorize" { return denied ? try ok(["denied": true],403) : try ok(["key": String(repeating: "x", count: 32), "remember": !oneTime]) }
        let components = path.split(separator: "/").map(String.init)
        if path == "/api/itemTypeFields" {
            let type = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first{$0.name == "itemType"}?.value ?? ""
            let common = ["title", "abstractNote", "date", "url", "extra", "language", "shortTitle", "rights"]
            let specific = ["preprint":["repository", "archiveID", "DOI", "genre"], "journalArticle":["publicationTitle", "volume", "issue", "pages", "DOI", "ISSN"], "conferencePaper":["proceedingsTitle", "conferenceName", "place", "pages", "DOI", "ISBN"], "webpage":["websiteTitle", "websiteType"]]
            return try ok((common + (specific[type] ?? [])).map{["field":$0]})
        }
        if path == "/api/users/0/collections" {
            if method == "GET" { return try ok(Array(collections.values)) }
            let entries = try JSONSerialization.jsonObject(with: body(request)) as! [[String: Any]]; let k = key()
            collections[k] = ["key": k, "version": 1, "data": entries[0]]
            return try ok(["success": ["0": k], "failed": [:]])
        }
        if components.count == 5 && components[3] == "collections", let object = collections[components[4]] { return try ok(object) }
        if path == "/api/users/0/items" {
            if method == "GET" { return try ok(objects.values.filter { ($0["data"] as? [String: Any])?["parentItem"] == nil }) }
            let entries = try JSONSerialization.jsonObject(with: body(request)) as! [[String: Any]]
            let k = key(); var object = entries[0]
            if notesCorrupt && object["itemType"] as? String == "note" { object["note"] = (object["note"] as! String).replacingOccurrences(of: "验收笔记正文", with: "已被改变") }
            objects[k] = ["key": k, "version": 1, "data": object]
            return try ok(["success": ["0": k], "failed": [:]])
        }
        if path.hasPrefix("/api/local/uploads/") {
            let uploadKey = components.last!, k = uploads[uploadKey]!
            if failPDFUploadOnce && ((objects[k]!["data"] as! [String: Any])["contentType"] as? String) == "application/pdf" {
                failPDFUploadOnce = false; return try ok([:],503)
            }
            files[k] = try body(request); return (201, headers, Data())
        }
        guard components.count >= 5, components[3] == "items" else { return try ok([:],404) }
        let k = components[4]
        if path.hasSuffix("/children") {
            return try ok(objects.values.filter { ($0["data"] as? [String: Any])?["parentItem"] as? String == k })
        }
        if path.hasSuffix("/file/view/url") {
            guard let file = files[k] else { return try ok([:],404) }
            let url = storage.appendingPathComponent(k)
            try file.write(to: url)
            return (200,headers,Data(url.absoluteString.utf8))
        }
        if path.hasSuffix("/file"), method == "POST" {
            let form = String(data: try body(request), encoding: .utf8)!
            let pairs = form.split(separator: "&").map { $0.split(separator: "=",maxSplits:1).map { String($0).removingPercentEncoding! } }
            let fields = Dictionary(uniqueKeysWithValues: pairs.map { ($0[0],$0[1]) })
            if let uploadKey = fields["upload"] {
                guard uploads[uploadKey] == k, let file = files[k] else { return try ok([:],400) }
                let actual = Insecure.MD5.hash(data:file).map { String(format:"%02x",$0) }.joined()
                guard actual == hashes[k] else { return try ok([:],400) }
                var object = objects[k]!, objectData = object["data"] as! [String: Any]
                objectData["md5"] = actual; object["data"] = objectData; objects[k] = object
                return (204,headers,Data())
            }
            let upload = UUID().uuidString; uploads[upload] = k; hashes[k] = fields["md5"]
            let host = foreignUploadURL ? "https://example.invalid/steal" : "http://127.0.0.1:23119/api/local/uploads/" + upload
            return try ok(["url": host, "uploadKey": upload, "prefix":"", "suffix":"", "contentType": "application/octet-stream"])
        }
        guard var object = objects[k] else { return try ok([:],404) }
        if method == "PATCH" {
            let patch = try JSONSerialization.jsonObject(with: body(request)) as! [String: Any]
            var objectData = object["data"] as! [String: Any]; objectData.merge(patch) { _, new in new }; object["data"] = objectData; objects[k] = object
            return (204,headers,Data())
        }
        return try ok(object)
    }
}

@main struct ZoteroTests {
    static func require(_ value: Bool, _ message: String) throws { if !value { throw NSError(domain: "ZoteroTest", code: 1, userInfo: [NSLocalizedDescriptionKey:message]) } }
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("zotero-service-tests-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let pdf = root.appendingPathComponent("paper.pdf"), html = root.appendingPathComponent("guide.html")
        try Data("%PDF-1.7\nunit fixture; not a real publication".utf8).write(to:pdf)
        try Data("<html><body><h1>公开导读测试</h1><math><mi>x</mi></math><img src=\"data:image/png;base64,AA==\"></body></html>".utf8).write(to:html)
        let b = ZoteroService.Bibliography(title:"MiCLA unit fixture",creators:[.init(firstName:"Kohei",lastName:"Yamamoto",name:nil)],abstract:"Fixture only",date:"2026-10-20",doi:nil,url:"https://arxiv.org/abs/2610.27491v1",extra:"fixture",tags:["音频分类"])
        let input = ZoteroService.ArchiveRequest(identity:"arxiv:2610.27491v1",bibliography:b,collectionKey:nil,collectionName:"论文速递｜应用验收",pdfPath:pdf.path,guideHTMLPath:html.path,analysisHTML:"<p>明确测试解析，非论文事实。</p>",noteHTML:"<p>验收笔记正文</p>")
        var passed = 0
        func fixture(seed: Bool = true) throws -> (ZoteroService,MockZotero,MemoryCredentialStore) {
            let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ZoteroMockProtocol.self]
            let backend = MockZotero(storage:root), store = MemoryCredentialStore()
            if seed { try store.seed() }
            ZoteroMockProtocol.handler = { try backend.response($0) }
            return (ZoteroService(dataDirectory:root,session:URLSession(configuration:config),credentialStore:store),backend,store)
        }
        do {
            let (service,backend,_) = try fixture()
            let status = try await service.status(); try require(status.writesSupported && status.authorized,"status")
            let first = try await service.archive(input)
            try require(first.status=="complete" && first.steps.count==6 && backend.collections.count==1 && backend.objects.count==6,"complete archive")
            // Consume the ACTUAL journal+summary pair emitted by this service, rather
            // than hand-crafting a projection that could miss cross-service schema bugs.
            let personal=try DesktopStore(directory:root)
            let storage=DesktopStorage(directory:root,store:personal,bundledSeedDirectory:root.appendingPathComponent("no-seed"))
            let cleanup=try await storage.cleanupPlan()
            try require(cleanup["requiresConfirmation"] as? Bool==true && (cleanup["planID"] as? String).flatMap(UUID.init(uuidString:)) != nil,"cleanup accepts actual service journal+summary companion and remains a confirmation plan")
            passed += 1
            try require(first.identity==input.identity && first.title==input.bibliography.title,"result identity/title are bound to actual journal request")
            let bridgeResume=try await service.handle(command:"zotero.resume",payload:["resumeID":first.archiveID,"identity":"arxiv:0000.00000","bibliography":["title":"Spoofed current paper B"]],progress:{_ in})
            try require(bridgeResume["identity"] as? String==input.identity && bridgeResume["title"] as? String==input.bibliography.title && bridgeResume["archiveID"] as? String==first.archiveID,"resume result ignores payload identity/title and reloads original journal owner")
            passed += 2
            let writes = backend.requests.filter { $0.0=="POST" }.count
            let resumed = try await service.archive(input,resumeID:first.archiveID)
            try require(resumed.status=="complete" && backend.requests.filter{$0.0=="POST"}.count==writes,"idempotent resume")
            let second = try await service.archive(input)
            try require(second.parentKey==first.parentKey && backend.objects.count==6,"global exact identity and child dedup")
            passed += 3
        }
        do {
            let (service,backend,_) = try fixture(); backend.failPDFUploadOnce=true
            let partial=try await service.archive(input)
            try require(partial.status=="partial" && partial.steps.first{$0.role=="pdf"}?.verified==false && partial.steps.first{$0.role=="guide"}?.verified==true,"partial file failure")
            let count=backend.objects.count
            let resumed=try await service.archive(input,resumeID:partial.archiveID)
            try require(resumed.status=="complete" && backend.objects.count==count,"partial resume only missing file")
            passed += 2
        }
        do {
            let (service,backend,_) = try fixture(seed:false);backend.denied=true
            let status=try await service.authorize();try require(!status.authorized && status.denied && backend.objects.isEmpty,"denied stays denied")
            backend.denied=false;backend.oneTime=true
            let once=try await service.authorize();try require(once.authorized && !once.remember,"one-time truthful status")
            do { _=try await service.archive(input);throw NSError(domain:"expected refusal",code:1) } catch ZoteroService.ServiceError.persistentAuthorizationRequired {}
            try require(backend.objects.isEmpty,"one-time stops before multistep write")
            passed += 3
        }
        do {
            let (service,backend,store)=try fixture();backend.unauthorized=true
            let result=try await service.archive(input)
            try require(result.status=="partial" && backend.objects.isEmpty && (try store.load(serverID:"test-instance"))==nil,"401 stops, no objects, clears own cache")
            passed += 1
        }
        do {
            let (service,backend,_) = try fixture();backend.foreignUploadURL=true
            let result=try await service.archive(input)
            try require(result.status=="partial" && backend.files.isEmpty && !backend.requests.contains{$0.1.contains("steal")},"foreign upload refused")
            passed += 1
        }
        do {
            let (service,backend,_) = try fixture();backend.notesCorrupt=true
            let result=try await service.archive(input)
            try require(result.status=="partial" && result.steps.first{$0.role=="note"}?.verified==false,"note body readback rejects modification")
            passed += 1
        }
        do {
            let (service,backend,_) = try fixture();_ = try await service.status();backend.serverID="changed-instance"
            do { _=try await service.status();throw NSError(domain:"expected server change",code:1) } catch ZoteroService.ServiceError.serverChanged {}
            let current=try await service.status();try require(current.serverID=="changed-instance" && !current.authorized,"new server starts clean partition")
            passed += 2
        }
        do {
            let (service,backend,_) = try fixture()
            var invalid=input; invalid.pdfPath="/etc/hosts"
            do { _=try await service.archive(invalid);throw NSError(domain:"expected path rejection",code:1) } catch ZoteroService.ServiceError.invalid {}
            let link=root.appendingPathComponent("linked.pdf");try FileManager.default.createSymbolicLink(at:link,withDestinationURL:pdf)
            invalid.pdfPath=link.path
            do { _=try await service.archive(invalid);throw NSError(domain:"expected symlink rejection",code:1) } catch ZoteroService.ServiceError.invalid {}
            try require(backend.objects.isEmpty,"invalid paths never write")
            let bad=root.appendingPathComponent("bad.html");try Data("<html><img src=\"https://example.com/leak.png\"></html>".utf8).write(to:bad)
            invalid=input;invalid.guideHTMLPath=bad.path
            do { _=try await service.archive(invalid);throw NSError(domain:"expected external resource rejection",code:1) } catch ZoteroService.ServiceError.invalid {}
            passed += 3
        }
        do {
            let (service,backend,_) = try fixture()
            let original = try await service.archive(input)
            let pdfKey = original.steps.first { $0.role == "pdf" }!.key!
            let edited = Data("%PDF-1.7\nUser annotated PDF: preserve this version".utf8)
            backend.files[pdfKey] = edited
            var pdfObject = backend.objects[pdfKey]!, item = pdfObject["data"] as! [String: Any]
            item["md5"] = Insecure.MD5.hash(data: edited).map { String(format:"%02x",$0) }.joined(); pdfObject["data"] = item; backend.objects[pdfKey] = pdfObject
            let before = backend.requests.filter { $0.0 == "POST" }.count
            let conflict = try await service.archive(input,resumeID:original.archiveID)
            try require(conflict.status == "partial" && conflict.steps.first{$0.role == "pdf"}?.verified == false,"user-edited PDF is a conflict")
            try require(backend.files[pdfKey] == edited && backend.requests.filter{$0.0 == "POST"}.count == before,"changed synced PDF never overwritten")
            item["md5"] = nil; pdfObject["data"] = item; backend.objects[pdfKey] = pdfObject
            let unsynced = try await service.archive(input,resumeID:original.archiveID)
            try require(unsynced.status == "partial" && backend.files[pdfKey] == edited && backend.requests.filter{$0.0 == "POST"}.count == before,"unsynced user-edited PDF never overwritten")
            passed += 3
        }
        do {
            let (service,backend,_) = try fixture()
            let userKey = "QWER2345"
            backend.objects[userKey] = ["key":userKey,"version":4,"data":["itemType":"preprint","archiveID":"2610.27491","title":"User curated title","abstractNote":"User curated abstract","date":"2020","extra":"User private annotation","creators":[["creatorType":"author","name":"User curated author"]],"collections":["ORIG2345"],"tags":[["tag":"User tag"]]]]
            let result = try await service.archive(input)
            let after = backend.objects[userKey]!["data"] as! [String: Any]
            try require(result.status == "complete" && result.parentKey == userKey && after["title"] as? String == "User curated title" && after["extra"] as? String == "User private annotation" && after["abstractNote"] as? String == "User curated abstract","reuse preserves user bibliography fields")
            let metaKey = result.steps.first{$0.role == "source-metadata"}!.key!
            let source = try JSONSerialization.jsonObject(with: backend.files[metaKey]!) as! [String: Any]
            let bibliography = source["bibliography"] as! [String: Any]
            try require(source["identity"] as? String == input.identity && bibliography["title"] as? String == input.bibliography.title && bibliography["abstract"] as? String == input.bibliography.abstract && bibliography["date"] as? String == input.bibliography.date && bibliography["extra"] as? String == input.bibliography.extra,"original source metadata stored fully and read back as real JSON file")
            let count = backend.objects.count
            let repeatResult = try await service.archive(input)
            try require(repeatResult.status == "complete" && backend.objects.count == count,"metadata preservation does not add duplicate child on repeated archive")
            passed += 3
        }
        do {
            let (service,backend,_) = try fixture()
            var conference = input; conference.identity = "conference:interspeech:2026:conference-paper-id:test26-interspeech"
            conference.bibliography.url = "https://www.isca-archive.org/interspeech_2026/test26_interspeech.html"
            let first = try await service.archive(conference), second = try await service.archive(conference)
            try require(first.status == "complete" && first.parentKey == second.parentKey && backend.objects.count == 6,"conference exact managed identity dedup")
            let parent = backend.objects[first.parentKey!]!["data"] as! [String: Any]
            try require(parent["itemType"] as? String == "conferencePaper" && parent["archiveID"] == nil,"conference never invents arxiv")
            passed += 2
        }
        do {
            let (service,backend,_) = try fixture()
            var page = input; page.identity = "page:/audio-paper-digest-blog/posts/unknown-paper/"
            page.bibliography.url = "https://nanless.github.io/audio-paper-digest-blog/posts/unknown-paper/"
            let first = try await service.archive(page), second = try await service.archive(page)
            try require(first.status == "complete" && first.parentKey == second.parentKey,"page fallback dedup exact managed marker")
            let parent = backend.objects[first.parentKey!]!["data"] as! [String: Any]
            try require(parent["itemType"] as? String == "webpage" && (parent["extra"] as? String ?? "").contains("original-paper-identity-unverified"),"fallback stays unverified webpage")
            passed += 2
        }
        do {
            let (service,backend,_) = try fixture()
            for malicious in ["<html><img src=https://example.com/leak></html>","<html><style>a{background:url(relative.png)}</style></html>","<html><a href=\"jav&#x61;script:alert(1)\">click</a></html>","<html><style>@import 'https://example.com/a.css'</style></html>","<html><svg><image href=\"https://example.org/tracker.png\"/></svg></html>","<html><svg><use xlink:href=\"https://example.org/external.svg#shape\"/></svg></html>","<html><svg><use xlink:href=\"#safe\" href=\"https://example.org/unsafe.svg#shape\"/></svg></html>","<html><svg><image title=\">\" href=\"https://example.org/remote.png\"/></svg></html>","<html><svg><svg:image title=\">\" href=\"https://example.org/remote.png\"/></svg></html>"] {
                let path=root.appendingPathComponent("unsafe.html"); try Data(malicious.utf8).write(to:path)
                var bad=input;bad.guideHTMLPath=path.path
                do { _=try await service.archive(bad);throw NSError(domain:"expected unsafe html refusal",code:1) } catch ZoteroService.ServiceError.invalid {}
            }
            try require(backend.objects.isEmpty,"unsafe HTML cases reject before any write")
            passed += 9
        }
        do {
            let (service,backend,_) = try fixture()
            var journal = input; journal.identity = "doi:10.1000/fixture-journal"
            journal.bibliography.doi = "10.1000/fixture-journal"; journal.bibliography.url = "https://doi.org/10.1000/fixture-journal"
            journal.bibliography.fields = ["itemType":"journalArticle", "publicationTitle":"Explicit fixture journal", "volume":"12", "issue":"3", "pages":"14–19", "language":"en"]
            let result = try await service.archive(journal)
            let data = backend.objects[result.parentKey!]!["data"] as! [String:Any]
            try require(result.status == "complete" && data["itemType"] as? String == "journalArticle" && data["publicationTitle"] as? String == "Explicit fixture journal" && data["volume"] as? String == "12" && data["archiveID"] == nil && data["repository"] == nil, "explicit DOI journal type and fields, no invented arxiv")
            passed += 1
        }
        do {
            let (service,backend,_) = try fixture()
            var published = input; published.bibliography.fields = ["itemType":"journalArticle", "publicationTitle":"Source stated journal"]
            let result = try await service.archive(published)
            let data = backend.objects[result.parentKey!]!["data"] as! [String:Any]
            try require(result.status == "complete" && data["itemType"] as? String == "journalArticle" && data["archiveID"] == nil && ZoteroService.matchesIdentity(published.identity,data:data), "arxiv identity can carry explicit published type without unsupported archive fields")
            passed += 1
        }
        do {
            let (service,backend,_) = try fixture()
            var unknown = input; unknown.identity = "doi:10.1000/unknown"; unknown.bibliography.doi = "10.1000/unknown"
            for fields: [String:String]? in [nil, ["itemType":"book"], ["itemType":"journalArticle", "proceedingsTitle":"incompatible"], ["itemType":"conferencePaper", "publicationTitle":"incompatible"], ["itemType":"preprint", "guessedFact":"unknown"]] {
                unknown.bibliography.fields = fields
                do { _=try await service.archive(unknown); throw NSError(domain:"expected type or field rejection",code:1) } catch ZoteroService.ServiceError.invalid {}
                try require(backend.objects.isEmpty && backend.collections.isEmpty, "unknown/incompatible source fields reject before writes")
                passed += 1
            }
        }
        try require(!ZoteroService.validIdentity("page:/audio-paper-digest-blog/posts/test/",sourceURL:"https://example.com/audio-paper-digest-blog/posts/test/"),"fallback refuses foreign origin")
        try require(!ZoteroService.validIdentity("page:/audio-paper-digest-blog/posts/test/",sourceURL:"https://nanless.github.io/audio-paper-digest-blog/posts/another/"),"fallback canonical path exact")
        try require(!ZoteroService.matchesIdentity("conference:icml:2026:forum:ABC",data:["title":"conference:icml:2026:forum:ABC","extra":"cites conference:icml:2026:forum:ABC"]),"conference title/mention never identity")
        try require(!ZoteroService.matchesIdentity("page:/audio-paper-digest-blog/posts/test/",data:["url":"https://nanless.github.io/audio-paper-digest-blog/posts/test/"]),"page URL alone is not managed identity")
        try require(!ZoteroService.matchesIdentity("conference:icml:2026:forum:ABC",data:["extra":"PaperDigest-ID: conference:icml:2026:forum:ABCD"]),"conference prefix mismatch")
        passed += 5
        try require(ZoteroService.matchesIdentity("arxiv:2610.27491v1",data:["url":"https://arxiv.org/abs/2610.27491v2"]),"arxiv versions share parent identity")
        try require(!ZoteroService.matchesIdentity("arxiv:2610.27491v1",data:["archiveID":"2610.274910"]),"ID prefix is not identity")
        try require(ZoteroService.matchesIdentity("doi:10.1000/test",data:["DOI":"https://doi.org/10.1000/TEST"]),"DOI normalization")
        try require(!ZoteroService.matchesIdentity("arxiv:2610.27491v1",data:["extra":"This different paper cites 2610.27491 in references"]),"cited ID is not parent identity")
        try require(!ZoteroService.matchesIdentity("arxiv:2610.27491v1",data:["url":"https://example.com/paper/2610.27491"]),"foreign URL is not arxiv identity")
        try require(ZoteroService.matchesIdentity("arxiv:2610.27491v1",data:["extra":"arXiv: 2610.27491v2 [cs.SD]"]),"explicit arxiv extra field")
        passed += 6
        do {
            let old = root.appendingPathComponent("support-old",isDirectory:true)
            try FileManager.default.createDirectory(at:old,withIntermediateDirectories:false)
            _=try DesktopStore(directory:old)
            let oldPDF=old.appendingPathComponent("paper.pdf"),oldHTML=old.appendingPathComponent("guide.html")
            try Data(contentsOf:pdf).write(to:oldPDF);try Data(contentsOf:html).write(to:oldHTML)
            var request=input;request.pdfPath=oldPDF.path;request.guideHTMLPath=oldHTML.path
            let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[ZoteroMockProtocol.self]
            let backend=MockZotero(storage:root),credentials=MemoryCredentialStore();try credentials.seed()
            ZoteroMockProtocol.handler={try backend.response($0)}
            let firstService=ZoteroService(dataDirectory:old,session:URLSession(configuration:config),credentialStore:credentials)
            backend.failPDFUploadOnce=true
            let first=try await firstService.archive(request)
            try require(first.status=="partial","cross-directory fixture is genuinely partial")
            let oldJournal=old.appendingPathComponent("zotero-archives/"+first.archiveID+".json")
            let originalBytes=try Data(contentsOf:oldJournal)
            let original=try JSONSerialization.jsonObject(with:originalBytes) as! [String:Any]
            let hashes=original["materialSHA256"] as? [String:String] ?? [:]
            try require(hashes["pdf"]==ZoteroService.sha256(try Data(contentsOf:oldPDF)) && hashes["guide"]==ZoteroService.sha256(try Data(contentsOf:oldHTML)),"journal records original material SHA by role")
            let staged=try BackupCodec.stage(BackupCodec.collect(sourceDirectory:old),parentDirectory:root)
            let restored=ZoteroService(dataDirectory:staged.stageDirectory,session:URLSession(configuration:config),credentialStore:credentials)
            let objectCount=backend.objects.count
            let resumed=try await restored.archive(request,resumeID:first.archiveID)
            try require(resumed.status=="complete" && resumed.parentKey==first.parentKey && backend.objects.count==objectCount,"restored appSupport resumes same journal/server without duplicating completed remote materials")
            let newJournal=staged.stageDirectory.appendingPathComponent("zotero-archives/"+first.archiveID+".json")
            let after=try JSONSerialization.jsonObject(with:Data(contentsOf:newJournal)) as! [String:Any]
            let oldRequest=original["request"] as! [String:Any],newRequest=after["request"] as! [String:Any]
            try require(original["fingerprint"] as? String==after["fingerprint"] as? String && oldRequest["pdfPath"] as? String==newRequest["pdfPath"] as? String && oldRequest["guideHTMLPath"] as? String==newRequest["guideHTMLPath"] as? String && (try Data(contentsOf:oldJournal))==originalBytes,"relocation never rewrites original request paths/fingerprint/history")
            passed += 3
            let writeCount=backend.requests.filter{$0.0 != "GET"}.count
            let currentPDF=staged.stageDirectory.appendingPathComponent("paper.pdf"),savedPDF=try Data(contentsOf:currentPDF)
            try Data("%PDF-1.7 changed after restore".utf8).write(to:currentPDF)
            do { _=try await restored.archive(request,resumeID:first.archiveID);throw NSError(domain:"expected restored material hash refusal",code:1) } catch ZoteroService.ServiceError.invalid {}
            try savedPDF.write(to:currentPDF)
            try require(backend.requests.filter{$0.0 != "GET"}.count==writeCount,"changed relocated bytes never dispatch writes")
            let map=staged.stageDirectory.appendingPathComponent(PrivateStoragePaths.aliasesFilename),savedMap=try Data(contentsOf:map)
            try FileManager.default.removeItem(at:map)
            do { _=try await restored.archive(request,resumeID:first.archiveID);throw NSError(domain:"expected absent root map refusal",code:1) } catch ZoteroService.ServiceError.invalid {}
            try Data("{\"contract\":\"paperdigest-storage-aliases-v1\",\"roots\":[\"/\"]}".utf8).write(to:map)
            do { _=try await restored.archive(request,resumeID:first.archiveID);throw NSError(domain:"expected root escape refusal",code:1) } catch ZoteroService.ServiceError.invalid {}
            try savedMap.write(to:map)
            try FileManager.default.removeItem(at:currentPDF);try FileManager.default.createSymbolicLink(at:currentPDF,withDestinationURL:oldPDF)
            do { _=try await restored.archive(request,resumeID:first.archiveID);throw NSError(domain:"expected alias symlink refusal",code:1) } catch ZoteroService.ServiceError.invalid {}
            try FileManager.default.removeItem(at:currentPDF);try savedPDF.write(to:currentPDF)
            var changed=request;changed.bibliography.title="changed request cannot reuse old fingerprint"
            do { _=try await restored.archive(changed,resumeID:first.archiveID);throw NSError(domain:"expected fingerprint refusal",code:1) } catch ZoteroService.ServiceError.invalid {}
            try require(backend.requests.filter{$0.0 != "GET"}.count==writeCount,"root map and mutable request never grant write eligibility")
            passed += 5
            // Backward-format fixture: removing the optional field does not mint old hashes.
            var legacy=original;legacy["materialSHA256"]=nil
            try JSONSerialization.data(withJSONObject:legacy,options:[.sortedKeys]).write(to:oldJournal)
            let sameDirectory=try await firstService.archive(request,resumeID:first.archiveID)
            try require(sameDirectory.status=="complete","legacy checkpoint still resumes at original directory under original fingerprint")
            let legacyStage=try BackupCodec.stage(BackupCodec.collect(sourceDirectory:old),parentDirectory:root)
            let legacyService=ZoteroService(dataDirectory:legacyStage.stageDirectory,session:URLSession(configuration:config),credentialStore:credentials)
            let writesBeforeLegacy=backend.requests.filter{$0.0 != "GET"}.count
            do { _=try await legacyService.archive(request,resumeID:first.archiveID);throw NSError(domain:"expected legacy alias missing SHA refusal",code:1) } catch ZoteroService.ServiceError.invalid {}
            try require(backend.requests.filter{$0.0 != "GET"}.count==writesBeforeLegacy,"missing old SHA cannot be supplied by a root map")
            passed += 2
            backend.serverID="other-server"
            let foreign=ZoteroService(dataDirectory:staged.stageDirectory,session:URLSession(configuration:config),credentialStore:credentials)
            do { _=try await foreign.archive(request,resumeID:first.archiveID);throw NSError(domain:"expected changed server authorization refusal",code:1) } catch ZoteroService.ServiceError.authorizationRequired {}
            try require(backend.requests.filter{$0.0 != "GET"}.count==writesBeforeLegacy,"restore does not grant another server authorization")
            passed += 1
        }
        print("Zotero mock assertions passed: \(passed). No live library writes, no native authorization requested, no real Keychain mutation.")
    }
}
