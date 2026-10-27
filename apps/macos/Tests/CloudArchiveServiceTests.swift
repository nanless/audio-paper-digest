import Foundation
import CryptoKit

private struct CloudTestError: Error { let message: String }
private final class CloudTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date: Date
    init(_ date: Date = Date(timeIntervalSince1970:1792886400)) { self.date = date }
    private var pauses: [TimeInterval] = []
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return date }
    func advance(_ seconds: TimeInterval) { lock.lock(); date.addTimeInterval(seconds); pauses.append(seconds); lock.unlock() }
    func slept() -> [TimeInterval] { lock.lock(); defer { lock.unlock() }; return pauses }
}
private actor CloudCredentialFixture {
    enum Mode: Sendable { case ready, unavailable, empty, cancelled, held }
    private var mode: Mode
    private var continuation: CheckedContinuation<CloudArchiveService.Credentials,Error>?
    init(_ mode: Mode) { self.mode=mode }
    func set(_ mode: Mode) { self.mode=mode }
    func isWaiting() -> Bool { continuation != nil }
    func credentials() async throws -> CloudArchiveService.Credentials {
        switch mode {
        case .ready: return .init(username:"fixture@example.invalid",password:"synthetic-app-password")
        case .empty: return .init(username:"fixture@example.invalid",password:"")
        case .cancelled: throw CancellationError()
        case .unavailable: throw CloudTestError(message:"LOCAL_PROVIDER_DECOY_SECRET_MUST_NOT_ESCAPE")
        case .held: return try await withCheckedThrowingContinuation { continuation=$0 }
        }
    }
    func release(genericError: Bool) {
        let pending=continuation;continuation=nil;mode = .ready
        if genericError { pending?.resume(throwing:CloudTestError(message:"LOCAL_PROVIDER_DECOY_SECRET_MUST_NOT_ESCAPE")) }
        else { pending?.resume(returning:.init(username:"fixture@example.invalid",password:"synthetic-app-password")) }
    }
}
private actor CloudCheckpointLog {
    var values: [CloudArchiveService.UploadCheckpoint] = []
    var failureAt: Int?
    func save(_ state: CloudArchiveService.UploadCheckpoint) throws {
        if let failureAt, values.count + 1 == failureAt { throw CloudTestError(message:"synthetic private write failure") }
        values.append(state)
    }
    func latest() -> CloudArchiveService.UploadCheckpoint? { values.last }
    func fail(at count: Int?) { failureAt = count }
    func count() -> Int { values.count }
}
/// In-memory HTTP origin, not user storage. It enforces create-only writes and
/// answers real DAV requests from the service's injected transport boundary.
private actor CloudTestDAV {
    struct Recorded: Sendable { let method: String; let path: String; let bytes: Int; let createOnly: Bool }
    struct Fault: Sendable {
        let method: String
        let suffix: String
        let status: Int?
        let headers: [String:String]
        let loseReplyAfterWrite: Bool
        init(_ method: String, _ suffix: String, status: Int? = nil, headers: [String:String] = [:], lose: Bool = false) {
            self.method=method; self.suffix=suffix; self.status=status; self.headers=headers; self.loseReplyAfterWrite=lose
        }
    }
    var files: [String:Data] = [:]
    var directories: Set<String> = ["/dav/"]
    var requests: [Recorded] = []
    var faults: [Fault] = []
    var overrideListing: Data?
    var omitCollectionSlash = false
    var responseURL: URL?
    var block = false
    var cancelledRequestOnce = false
    var blockedContinuation: CheckedContinuation<Void,Never>?
    func add(_ fault: Fault) { faults.append(fault) }
    func setFile(_ path: String, _ data: Data) { files[path]=data }
    func getFile(_ path: String) -> Data? { files[path] }
    func allFiles() -> [String:Data] { files }
    func remove(_ path: String) { files.removeValue(forKey:path) }
    func addDirectory(_ path: String) { directories.insert(path) }
    func listing(_ data: Data?) { overrideListing=data }
    func missingCollectionSlash(_ value: Bool) { omitCollectionSlash=value }
    func redirectResponse(_ url: URL?) { responseURL=url }
    func cancelNextRequest() { cancelledRequestOnce=true }
    func hold() { block=true }
    func release() { block=false; blockedContinuation?.resume(); blockedContinuation=nil }
    func records() -> [Recorded] { requests }
    func request(_ request: URLRequest, limit: Int) async throws -> CloudArchiveService.Response {
        guard let url=request.url, let components=URLComponents(url:url,resolvingAgainstBaseURL:false),
              components.scheme=="https", components.host=="dav.jianguoyun.com", components.user==nil,
              components.password==nil, request.value(forHTTPHeaderField:"Authorization")?.hasPrefix("Basic ")==true else { throw CloudTestError(message:"unsafe destination or missing authentication") }
        let path=components.path, method=request.httpMethod ?? "GET"
        requests.append(.init(method:method,path:path,bytes:request.httpBody?.count ?? 0,createOnly:request.value(forHTTPHeaderField:"If-None-Match")=="*"))
        if cancelledRequestOnce { cancelledRequestOnce=false; throw CancellationError() }
        if block { await withCheckedContinuation { blockedContinuation=$0 } }
        var fault: Fault?
        if let index=faults.firstIndex(where:{$0.method==method && path.hasSuffix($0.suffix)}) { fault=faults.remove(at:index) }
        func response(_ status: Int, _ data: Data=Data(), headers: [String:String]=[:]) -> CloudArchiveService.Response {
            .init(data:data,response:HTTPURLResponse(url:responseURL ?? url,statusCode:status,httpVersion:"HTTP/1.1",headerFields:headers)!)
        }
        if let status=fault?.status { return response(status,headers:fault?.headers ?? [:]) }
        switch method {
        case "MKCOL":
            if directories.contains(path) { return response(405) }
            directories.insert(path)
            if fault?.loseReplyAfterWrite==true { throw CloudTestError(message:"synthetic lost reply; not a credential") }
            return response(201)
        case "PUT":
            guard request.value(forHTTPHeaderField:"If-None-Match")=="*" else { return response(428) }
            if files[path] != nil { return response(412) }
            files[path]=request.httpBody ?? Data()
            if fault?.loseReplyAfterWrite==true { throw CloudTestError(message:"synthetic lost write reply") }
            return response(201)
        case "GET":
            if let data=files[path] { return response(200,data) }
            return response(404)
        case "PROPFIND":
            guard directories.contains(path) else { return response(404) }
            if let overrideListing { return response(207,overrideListing) }
            var members=[(path,true)]
            if request.value(forHTTPHeaderField:"Depth")=="1" {
                for directory in directories.sorted() where directory != path && directory.hasPrefix(path) {
                    let tail=String(directory.dropFirst(path.count))
                    if tail.hasSuffix("/") && !tail.dropLast().contains("/") { members.append((directory,true)) }
                }
                for file in files.keys.sorted() where file.hasPrefix(path) && !file.dropFirst(path.count).contains("/") { members.append((file,false)) }
            }
            return response(207,Self.xml(members.map { path, collection in
                (omitCollectionSlash && collection && path != "/dav/" ? String(path.dropLast()) : path, collection)
            }))
        default: return response(405)
        }
    }
    static func xml(_ members: [(String,Bool)]) -> Data {
        Data(("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\">"+members.map { path,collection in
            "<d:response><d:href>\(path)</d:href><d:propstat><d:prop><d:resourcetype>\(collection ? "<d:collection/>" : "")</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
        }.joined()+"</d:multistatus>").utf8)
    }
}
#if PAPER_DIGEST_TESTS
private final class CloudInterceptProtocol: URLProtocol, @unchecked Sendable {
    struct Reply: Sendable { let status: Int; let headers: [String:String]; let chunks: [Data]; let redirect: Bool }
    private static let lock=NSLock()
    nonisolated(unsafe) private static var reply=Reply(status:200,headers:[:],chunks:[],redirect:false)
    nonisolated(unsafe) private static var requests: [URLRequest]=[]
    static func configure(status: Int=200,headers: [String:String]=[:],chunks: [Data]=[],redirect: Bool=false) {
        lock.lock();reply=Reply(status:status,headers:headers,chunks:chunks,redirect:redirect);requests=[];lock.unlock()
    }
    static func recorded() -> [URLRequest] { lock.lock();defer{lock.unlock()};return requests }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock();let reply=Self.reply;Self.requests.append(request);Self.lock.unlock()
        let response=HTTPURLResponse(url:request.url!,statusCode:reply.status,httpVersion:"HTTP/1.1",headerFields:reply.headers)!
        if reply.redirect {
            client?.urlProtocol(self,wasRedirectedTo:URLRequest(url:URL(string:"https://evil.invalid/must-not-receive-basic")!),redirectResponse:response)
            return
        }
        client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
        for chunk in reply.chunks { client?.urlProtocol(self,didLoad:chunk) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
#endif
/// Hold the first chunk PUT from each independent client before forwarding to
/// the existing controlled HTTP origin. No production timing or transport changes.
private actor CloudIndependentPublishGate {
    private var clients: Set<String> = []
    private var waiting: [CheckedContinuation<Void,Never>] = []
    private var released=false
    func wait(_ request: URLRequest) async {
        guard request.httpMethod == "PUT", let path=request.url?.path,
              path.hasSuffix("chunk-000000.bin"),clients.insert(path).inserted else{return}
        if released{return}
        await withCheckedContinuation{waiting.append($0)}
    }
    func count()->Int{clients.count}
    func release(){released=true;let values=waiting;waiting=[];for value in values{value.resume()}}
}
@main struct CloudArchiveServiceTests {
    static func main() async throws {
        var passed=0, failures:[String]=[]
        func require(_ condition: Bool,_ text: String) throws { if !condition { throw CloudTestError(message:text) } }
        func check(_ name: String,_ action: () async throws -> Void) async {
            do { try await action(); passed += 1; print("PASS " + name) }
            catch let error as CloudTestError { failures.append(name+": "+error.message); print("FAIL "+name+": "+error.message) }
            catch let error as CloudArchiveService.CloudError { failures.append(name+": "+(error.errorDescription ?? "cloud failure")); print("FAIL "+name+": "+(error.errorDescription ?? "cloud failure")) }
            catch { failures.append(name+": unexpected test failure"); print("FAIL "+name+": unexpected test failure") }
        }
        func rejects(_ expected: CloudArchiveService.CloudError? = nil,_ action: () async throws -> Void) async throws {
            do { try await action() }
            catch let error as CloudArchiveService.CloudError { if let expected { try require(error==expected,"wrong safe error") }; return }
            catch { throw CloudTestError(message:"unexpected unsanitized error") }
            throw CloudTestError(message:"expected rejection")
        }
        func rejectsCancellation(_ action: () async throws -> Void) async throws {
            do { try await action() }
            catch is CancellationError { return }
            catch { throw CloudTestError(message:"cancellation was changed into a different failure") }
            throw CloudTestError(message:"expected cancellation")
        }
        let localCredentialHint="未能取得本机保存的坚果云应用密码；请在原生窗口处理 macOS 钥匙串许可或保存应用专用密码后重试"
        func rejectsLocalCredentials(_ action: () async throws -> Void) async throws {
            do { try await action() }
            catch let error as CloudArchiveService.CloudError {
                try require(error != .authentication,"local credential failure must not claim remote authentication rejection")
                try require(error.errorDescription==localCredentialHint,"local credential failure must use the fixed local permission hint")
                try require(error == .credentialsUnavailable,"typed local credential case must remain distinct from HTTP authentication")
                try require(!error.localizedDescription.contains("LOCAL_PROVIDER_DECOY_SECRET_MUST_NOT_ESCAPE"),"provider error text leaked")
                return
            }
            catch { throw CloudTestError(message:"local provider failure escaped the safe error contract") }
            throw CloudTestError(message:"expected local credential failure")
        }
        func hash(_ data: Data) -> String { SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined() }
        func backup(extraBytes: Int=0) throws -> Data {
            var entries=[BackupCodec.Entry(path:"personal.json",sha256:hash(Data("{\"notes\":{\"paper\":\"原字节\"},\"sessions\":[]}".utf8)),data:Data("{\"notes\":{\"paper\":\"原字节\"},\"sessions\":[]}".utf8))]
            if extraBytes>0 { let content=Data(repeating:0x5a,count:extraBytes); entries.append(.init(path:"files/research.pdf",sha256:hash(content),data:content)) }
            return try BackupCodec.encode(.init(sourceDirectory:"/synthetic-research-fixture",files:entries))
        }
        func service(_ dav: CloudTestDAV,_ log: CloudCheckpointLog, destination: UUID=UUID(), clock: CloudTestClock=CloudTestClock(), interval: TimeInterval=0) throws -> CloudArchiveService {
            try CloudArchiveService(destinationID:destination,credentials:{.init(username:"fixture@example.invalid",password:"synthetic-app-password")},checkpointSink:{try await log.save($0)},transport:{try await dav.request($0,limit:$1)},now:{clock.now()},sleep:{clock.advance($0)},minimumRequestInterval:interval)
        }
        func base(_ ref: CloudArchiveService.SnapshotReference) -> String { "/dav/PaperDigest/\(ref.month)/\(ref.id.uuidString.lowercased())/" }
        let small=try backup(), large=try backup(extraBytes:13*1024*1024)
        await check("real subsecond timestamps canonicalize and roundtrip through manifest and lost-ack resume") {
            let encoder=JSONEncoder();encoder.dateEncodingStrategy = .millisecondsSince1970
            let decoder=JSONDecoder();decoder.dateDecodingStrategy = .millisecondsSince1970
            var oldDrift=0
            for index in 0..<10000 {
                let original=Date(timeIntervalSinceReferenceDate:814671993.1234568+Double(index)/10000000)
                if try decoder.decode(Date.self,from:encoder.encode(original)) != original { oldDrift += 1 }
                let canonical=Date(timeIntervalSince1970:floor(original.timeIntervalSince1970))
                try require(try decoder.decode(Date.self,from:encoder.encode(canonical))==canonical,"integer UTC second remains exact")
            }
            try require(oldDrift>0,"negative demonstrates old exact-Date contract was broken")
            for index in 0..<12 {
                let clock=CloudTestClock(Date(timeIntervalSinceReferenceDate:814671993.1234568+Double(index)/10000000))
                let dav=CloudTestDAV(),log=CloudCheckpointLog(),destination=UUID(),s=try service(dav,log,destination:destination,clock:clock)
                if index.isMultiple(of:2) { await dav.add(.init("PUT","manifest.json",lose:true)) }
                if index.isMultiple(of:2) {
                    try await rejects(.transport) { _=try await s.upload(encodedBackup:small) }
                    guard let state=await log.latest() else { throw CloudTestError(message:"missing real-time checkpoint") }
                    let resumed=try service(dav,log,destination:destination,clock:clock)
                    let info=try await resumed.upload(encodedBackup:small,resuming:state)
                    try require(info.reference==state.reference,"same UUID after real-time lost acknowledgement")
                } else { _=try await s.upload(encodedBackup:small) }
                guard let state=await log.latest() else { throw CloudTestError(message:"missing canonical timestamp") }
                try require(state.createdAt.timeIntervalSince1970==floor(clock.now().timeIntervalSince1970),"createdAt is a canonical integer second")
                try require(state.manifestVerified,"real-time successful manifest durably persisted")
                try require(try await s.download(reference:state.reference)==small,"exact bytes retained under real-time timestamps")
            }
        }
        for (instant,expectedMonth) in [("2026-10-31T23:59:59Z","2026-10"),("2026-11-01T00:00:00Z","2026-11")] {
            await check("native snapshot reference uses UTC boundary "+instant) {
                let date=ISO8601DateFormatter().date(from:instant)!,clock=CloudTestClock(date),dav=CloudTestDAV(),log=CloudCheckpointLog(),destination=UUID()
                let original=try service(dav,log,destination:destination,clock:clock),info=try await original.upload(encodedBackup:small)
                try require(info.reference.month==expectedMonth && info.createdAt==date,"native minted snapshot reference and manifest retain exact UTC instant/month")
                guard let state=await log.latest() else{throw CloudTestError(message:"Missing native UTC checkpoint")}
                let priorFiles=await dav.allFiles(),priorPuts=await dav.records().filter{$0.method=="PUT"}.count
                clock.advance(2)
                let resumed=try service(dav,log,destination:destination,clock:clock),repeated=try await resumed.upload(encodedBackup:small,resuming:state)
                try require(repeated.reference==info.reference && repeated.createdAt==date,"resume after clock advances retains original month, UUID and timestamp")
                let afterFiles=await dav.allFiles(),afterPuts=await dav.records().filter{$0.method=="PUT"}.count
                try require(afterFiles==priorFiles && afterPuts==priorPuts,"UTC-boundary resume does not publish a new or overwritten version")
                try require(try await resumed.download(reference:info.reference)==small,"UTC-boundary completed version actual GET returns original bytes")
            }
        }
        await check("complete immutable multi-chunk upload, month listing and original BackupCodec bytes") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            let info=try await s.upload(encodedBackup:large)
            try require(info.encodedBytes==large.count && info.chunkCount==3,"8MiB chunk partition")
            let states=await log.values
            try require(states.first?.verifiedChunkIndices==[] && states.last?.manifestVerified==true,"durable initial and final states")
            let requests=await dav.records(),puts=requests.filter{$0.method=="PUT"}
            try require(puts.count==4 && puts.allSatisfy{$0.createOnly},"only create-only chunks then manifest")
            try require(puts.last?.path.hasSuffix("manifest.json")==true && puts.dropLast().allSatisfy{$0.bytes<=CloudArchiveService.chunkBytes},"manifest written last, each file below vendor limit")
            try require(try await s.download(reference:info.reference)==large,"download is exact original encoded bytes")
            try require(try await s.list(month:info.reference.month)==[info],"only complete verified manifest listed")
            try require(BackupCodec.maxEncodedBytes==CloudArchiveService.maxEncodedBytes && BackupCodec.maxDecodedBytes==CloudArchiveService.maxDecodedBytes,"same whole-backup limits")
        }
        await check("lost chunk acknowledgement resumes original UUID, no rewrite or duplicate snapshot") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),destination=UUID(),s=try service(dav,log,destination:destination)
            await dav.add(.init("PUT","chunk-000000.bin",lose:true))
            try await rejects(.transport) { _=try await s.upload(encodedBackup:large) }
            guard let state=await log.latest() else { throw CloudTestError(message:"missing initial durable checkpoint") }
            try require(!state.manifestVerified,"lost chunk not completion")
            try require(try await s.list(month:state.reference.month).isEmpty,"partial snapshot not listed")
            let resumed=try service(dav,log,destination:destination)
            let info=try await resumed.upload(encodedBackup:large,resuming:state)
            try require(info.reference==state.reference,"same snapshot identity")
            let puts=await dav.records().filter{$0.method=="PUT" && $0.path.hasSuffix("chunk-000000.bin")}
            try require(puts.count==1,"existing chunk GET verified instead of resent")
            try require(try await resumed.download(reference:info.reference)==large,"complete resumed byte proof")
        }
        await check("lost completion acknowledgement safely recognizes original manifest on explicit resume") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),destination=UUID(),s=try service(dav,log,destination:destination)
            await dav.add(.init("PUT","manifest.json",lose:true))
            try await rejects(.transport) { _=try await s.upload(encodedBackup:small) }
            guard let state=await log.latest() else { throw CloudTestError(message:"missing manifest checkpoint") }
            let oldFiles=await dav.allFiles(),resumed=try service(dav,log,destination:destination)
            let info=try await resumed.upload(encodedBackup:small,resuming:state)
            let newFiles=await dav.allFiles()
            try require(info.reference==state.reference && newFiles==oldFiles,"no new UUID, overwrite or remote deletion")
            try require(await log.latest()?.manifestVerified==true,"completion persisted after readback")
        }
        await check("checkpoint persistence failure stops before network and final save cannot claim success") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),destination=UUID()
            await log.fail(at:1);let s=try service(dav,log,destination:destination)
            try await rejects(.checkpointStore) { _=try await s.upload(encodedBackup:small) }
            try require(await dav.records().isEmpty,"no dispatch before durable identity")
            await log.fail(at:3)
            try await rejects(.checkpointStore) { _=try await s.upload(encodedBackup:small) }
            try require(await log.latest()?.manifestVerified==false,"persisted state never says completed")
            guard let state=await log.latest() else { throw CloudTestError(message:"missing resumable state") }
            await log.fail(at:nil)
            _=try await s.upload(encodedBackup:small,resuming:state)
            try require(await log.latest()?.manifestVerified==true,"same remote manifest can finish durable state later")
        }
        await check("resume binds exact account target, folder, original bytes and full chunk plan") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),destination=UUID(),s=try service(dav,log,destination:destination)
            await dav.add(.init("PUT","chunk-000000.bin",lose:true))
            try await rejects(.transport) { _=try await s.upload(encodedBackup:small) }
            guard let state=await log.latest() else { throw CloudTestError(message:"missing state") }
            let before=await dav.records().count
            let other=try service(dav,log)
            try await rejects(.invalidCheckpoint) { _=try await other.upload(encodedBackup:small,resuming:state) }
            try await rejects(.invalidCheckpoint) { _=try await s.upload(encodedBackup:large,resuming:state) }
            let differentFolder=try CloudArchiveService(folder:"Other",destinationID:destination,credentials:{.init(username:"fixture",password:"fixture")},checkpointSink:{try await log.save($0)},transport:{try await dav.request($0,limit:$1)},minimumRequestInterval:0)
            try await rejects(.invalidCheckpoint) { _=try await differentFolder.upload(encodedBackup:small,resuming:state) }
            var subsecondObject=try JSONSerialization.jsonObject(with:JSONEncoder().encode(state)) as! [String:Any]
            subsecondObject["createdAt"]=state.createdAt.timeIntervalSinceReferenceDate+0.5
            let noncanonical=try JSONDecoder().decode(CloudArchiveService.UploadCheckpoint.self,from:JSONSerialization.data(withJSONObject:subsecondObject))
            try await rejects(.invalidCheckpoint) { _=try await s.upload(encodedBackup:small,resuming:noncanonical) }
            try require(await dav.records().count==before,"mismatch rejected before remote access")
            let stateJSON=try JSONEncoder().encode(state)
            let text=String(decoding:stateJSON,as:UTF8.self)
            try require(!text.contains("fixture@example.invalid") && !text.contains("synthetic-app-password"),"no credentials in checkpoint")
        }
        await check("corrupt existing chunk and corrupt downloaded bytes fail closed without overwrite") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            let info=try await s.upload(encodedBackup:small)
            guard let state=await log.latest() else { throw CloudTestError(message:"missing state") }
            let path=base(info.reference)+"chunk-000000.bin",bad=Data("corrupted".utf8)
            await dav.setFile(path,bad)
            try await rejects(.integrity) { _=try await s.download(reference:info.reference) }
            try await rejects(.integrity) { _=try await s.upload(encodedBackup:small,resuming:state) }
            try require(await dav.getFile(path)==bad,"corrupt version not silently overwritten")
        }
        await check("new snapshots retain every prior object and never issue DELETE or MOVE") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            let first=try await s.upload(encodedBackup:small),old=await dav.allFiles()
            let second=try await s.upload(encodedBackup:large),all=await dav.allFiles()
            try require(first.reference != second.reference,"fresh random UUID")
            try require(old.allSatisfy{all[$0.key]==$0.value},"all old object bytes preserved")
            try require(await dav.records().allSatisfy{!["DELETE","MOVE","COPY"].contains($0.method)},"no deletion or version overwrite operation")
        }
        await check("two independent destination clients concurrently publish identical bytes without altering any prior version") {
            let dav=CloudTestDAV(),initialLog=CloudCheckpointLog(),initial=try service(dav,initialLog)
            let original=try await initial.upload(encodedBackup:small),old=await dav.allFiles()
            let gate=CloudIndependentPublishGate(),leftLog=CloudCheckpointLog(),rightLog=CloudCheckpointLog(),leftID=UUID(),rightID=UUID()
            func client(_ destination:UUID,_ log:CloudCheckpointLog)throws->CloudArchiveService{
                try CloudArchiveService(destinationID:destination,credentials:{.init(username:"fixture@example.invalid",password:"synthetic-app-password")},checkpointSink:{try await log.save($0)},transport:{request,limit in await gate.wait(request);return try await dav.request(request,limit:limit)},minimumRequestInterval:0)
            }
            let left=try client(leftID,leftLog),right=try client(rightID,rightLog)
            let leftTask=Task{try await left.upload(encodedBackup:small)},rightTask=Task{try await right.upload(encodedBackup:small)}
            let deadline=Date().addingTimeInterval(5)
            while await gate.count()<2 && Date()<deadline{try await Task.sleep(nanoseconds:10_000_000)}
            let bothActuallyHeld=await gate.count()==2,whileHeld=await dav.allFiles()
            await gate.release()
            // Consume both terminal results before any assertion can leave an owned task behind.
            let leftResult=await leftTask.result,rightResult=await rightTask.result
            let a=try leftResult.get(),b=try rightResult.get()
            try require(bothActuallyHeld && whileHeld==old,"both independent clients must reach their real chunk PUT before either writes")
            try require(Set([original.reference.id,a.reference.id,b.reference.id]).count==3,"identical bytes must retain three distinct immutable versions")
            let final=await dav.allFiles(),records=await dav.records()
            try require(old.allSatisfy{final[$0.key]==$0.value},"every old chunk and manifest byte remains")
            try require(records.allSatisfy{!["DELETE","MOVE","COPY"].contains($0.method)} && records.filter{$0.method=="PUT"}.allSatisfy{$0.createOnly},"no overwrite or destructive method")
            let leftCheckpoint=await leftLog.latest(),rightCheckpoint=await rightLog.latest()
            try require(leftCheckpoint?.destinationID==leftID && rightCheckpoint?.destinationID==rightID && leftCheckpoint?.manifestVerified==true && rightCheckpoint?.manifestVerified==true,"each independent client retains its own target/checkpoint and real final manifest")
            let leftBytes=try await left.download(reference:a.reference),rightBytes=try await right.download(reference:b.reference),oldBytes=try await initial.download(reference:original.reference)
            try require(leftBytes==small && rightBytes==small && oldBytes==small,"all three versions must GET back the original whole backup")
            let listed=try await left.list(month:a.reference.month)
            try require(Set(listed.map{$0.reference.id})==Set([original.reference.id,a.reference.id,b.reference.id]),"shared month lists every completed independent version")
        }
        await check("connection probe requires a real successful DAV root collection, not HTTP207 alone") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            await dav.listing(Data("not DAV".utf8))
            try await rejects(.incompleteListing) { try await s.probe() }
            await dav.listing(CloudTestDAV.xml([("/dav/",false)]))
            try await rejects(.incompleteListing) { try await s.probe() }
            await dav.listing(nil);try await s.probe()
            try require(await dav.records().count==3,"each probe used actual response")
        }
        await check("local credential provider error and empty password are safe, zero transport, and preserve the original frozen upload") {
            for mode in [CloudCredentialFixture.Mode.unavailable,.empty] {
                let dav=CloudTestDAV(),log=CloudCheckpointLog(),provider=CloudCredentialFixture(mode),destination=UUID()
                let s=try CloudArchiveService(destinationID:destination,credentials:{try await provider.credentials()},checkpointSink:{try await log.save($0)},transport:{try await dav.request($0,limit:$1)},minimumRequestInterval:0)
                try await rejectsLocalCredentials { _=try await s.upload(encodedBackup:small) }
                try require(await dav.records().isEmpty,"local failure must send zero HTTP requests")
                guard let state=await log.latest() else { throw CloudTestError(message:"original upload checkpoint missing") }
                try require(!state.manifestVerified && state.verifiedChunkIndices.isEmpty && state.retryAfter==nil,"local permission failure is neither upload success nor remote rate limit")
                await provider.set(.ready)
                let completed=try await s.upload(encodedBackup:small,resuming:state)
                try require(completed.reference==state.reference,"local permission retry retains original snapshot identity")
            }
        }
        await check("credential provider CancellationError remains cancellation and the actor can be reused") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),provider=CloudCredentialFixture(.cancelled)
            let s=try CloudArchiveService(destinationID:UUID(),credentials:{try await provider.credentials()},checkpointSink:{try await log.save($0)},transport:{try await dav.request($0,limit:$1)},minimumRequestInterval:0)
            try await rejectsCancellation { try await s.probe() }
            try require(await dav.records().isEmpty,"provider cancellation sends zero HTTP requests")
            await provider.set(.ready);try await s.probe()
            try require(await dav.records().count==1,"cancelled actor releases its operation gate")
        }
        await check("real task cancellation while waiting for credentials wins over late success or generic provider error") {
            for genericError in [false,true] {
                let dav=CloudTestDAV(),log=CloudCheckpointLog(),provider=CloudCredentialFixture(.held)
                let s=try CloudArchiveService(destinationID:UUID(),credentials:{try await provider.credentials()},checkpointSink:{try await log.save($0)},transport:{try await dav.request($0,limit:$1)},minimumRequestInterval:0)
                let task=Task { try await s.probe() }
                while !(await provider.isWaiting()) { await Task.yield() }
                task.cancel();await provider.release(genericError:genericError)
                try await rejectsCancellation { try await task.value }
                try require(await dav.records().isEmpty,"cancelled local permission wait sends zero HTTP requests")
                try await s.probe();try require(await dav.records().count==1,"operation gate released after late provider completion")
            }
        }
        await check("request pacing preserves real cancellation and keeps other sleep errors as safe transport failure") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),clock=CloudTestClock()
            let s=try CloudArchiveService(destinationID:UUID(),credentials:{.init(username:"fixture",password:"fixture")},checkpointSink:{try await log.save($0)},transport:{try await dav.request($0,limit:$1)},now:{clock.now()},sleep:{_ in throw CancellationError()},minimumRequestInterval:3.1)
            try await s.probe();try await rejectsCancellation { try await s.probe() }
            try require(await dav.records().count==1,"cancelled pacing cannot send next request")
            clock.advance(4);try await s.probe();try require(await dav.records().count==2,"pacing cancellation releases operation gate")
            let failing=try CloudArchiveService(destinationID:UUID(),credentials:{.init(username:"fixture",password:"fixture")},checkpointSink:{try await log.save($0)},transport:{try await dav.request($0,limit:$1)},now:{clock.now()},sleep:{_ in throw CloudTestError(message:"LOCAL_PROVIDER_DECOY_SECRET_MUST_NOT_ESCAPE")},minimumRequestInterval:3.1)
            try await failing.probe();try await rejects(.transport) { try await failing.probe() }
        }
        await check("transport CancellationError remains cancellation and later operations still work") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            await dav.cancelNextRequest();try await rejectsCancellation { try await s.probe() }
            try require(await dav.records().count==1,"exactly the cancelled transport was called")
            try await s.probe();try require(await dav.records().count==2,"transport cancellation releases actor gate")
        }
        await check("real task cancellation while transport waits cannot turn a late HTTP401 into authentication failure") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            await dav.add(.init("PROPFIND","/dav/",status:401));await dav.hold()
            let task=Task { try await s.probe() }
            while await dav.records().isEmpty { await Task.yield() }
            task.cancel();await dav.release();try await rejectsCancellation { try await task.value }
            try await s.probe();try require(await dav.records().count==2,"late HTTP401 cancellation did not leave a busy gate")
        }
        await check("genuine HTTP403 remains forbidden and is not a local credential error") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            await dav.add(.init("PROPFIND","/dav/",status:403));try await rejects(.forbidden) { try await s.probe() }
            try require(await dav.records().count==1,"one actual HTTP403 response")
        }
        await check("401 stops immediately and does not switch credentials or auto retry") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            await dav.add(.init("PROPFIND","/dav/",status:401))
            try await rejects(.authentication) { try await s.probe() }
            try require(await dav.records().count==1,"one actual auth request")
        }
        await check("429 and 503 stop dispatch and persist Retry-After across service recreation") {
            for status in [429,503] {
                let dav=CloudTestDAV(),log=CloudCheckpointLog(),clock=CloudTestClock(),destination=UUID(),s=try service(dav,log,destination:destination,clock:clock)
                await dav.add(.init("MKCOL","/PaperDigest/",status:status,headers:["Retry-After":"120"]))
                let until=clock.now().addingTimeInterval(120)
                try await rejects(.throttled(until)) { _=try await s.upload(encodedBackup:small) }
                guard let state=await log.latest() else { throw CloudTestError(message:"missing cooldown checkpoint") }
                let dispatched=await dav.records().count
                try require(state.retryAfter==until && dispatched==1,"cooldown durable, no new chunk")
                let resumed=try service(dav,log,destination:destination,clock:clock)
                try await rejects(.throttled(until)) { _=try await resumed.upload(encodedBackup:small,resuming:state) }
                try require(await dav.records().count==1,"relaunch cannot bypass saved cooldown")
                clock.advance(121)
                _=try await resumed.upload(encodedBackup:small,resuming:state)
            }
        }
        await check("Retry-After HTTP date and invalid/missing fallback are respected") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),clock=CloudTestClock(),s=try service(dav,log,clock:clock)
            let until=clock.now().addingTimeInterval(90),formatter=DateFormatter()
            formatter.locale=Locale(identifier:"en_US_POSIX");formatter.timeZone=TimeZone(secondsFromGMT:0);formatter.dateFormat="EEE, dd MMM yyyy HH:mm:ss zzz"
            await dav.add(.init("PROPFIND","/dav/",status:503,headers:["Retry-After":formatter.string(from:until)]))
            try await rejects(.throttled(until)) { try await s.probe() }
            let other=try service(dav,log,clock:clock)
            await dav.add(.init("PROPFIND","/dav/",status:429,headers:["Retry-After":"invalid"]))
            try await rejects(.throttled(clock.now().addingTimeInterval(60))) { try await other.probe() }
        }
        await check("serial actor gate rejects overlapping operations across await without touching old versions") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            await dav.hold()
            let operation=Task { try await s.probe() }
            while await dav.records().isEmpty { await Task.yield() }
            try await rejects(.busy) { _=try await s.list(month:"2026-10") }
            try require(await dav.records().count==1,"no second request during awaited transport")
            await dav.release();try await operation.value
        }
        await check("request pacing and 600 per 30 minute budget stop incomplete enumeration") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),clock=CloudTestClock(),s=try service(dav,log,clock:clock,interval:3.1)
            try await s.probe();try await s.probe()
            try require(clock.slept().count==1 && abs((clock.slept().first ?? 0)-3.1)<0.001,"actual pacing uses injected sleep")
            let many=CloudTestDAV(),manyLog=CloudCheckpointLog(),budget=try service(many,manyLog)
            let monthPath="/dav/PaperDigest/2026-10/"
            await many.addDirectory(monthPath)
            for _ in 0..<600 { await many.addDirectory(monthPath+UUID().uuidString.lowercased()+"/") }
            try await rejects { _=try await budget.list(month:"2026-10") }
            try require(await many.records().count==600,"never dispatch request 601 or claim prefix is complete")
        }
        await check("successful DAV collection aliases allow an immutable upload and month list without trailing slashes") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog();await dav.missingCollectionSlash(true)
            let s=try service(dav,log);let info=try await s.upload(encodedBackup:small)
            try require(try await s.list(month:info.reference.month)==[info],"collection aliases preserve exact completed snapshot")
            try require(try await s.download(reference:info.reference)==small,"original encoded bytes unchanged")
        }
        await check("trailing-slash aliases cannot hide duplicates or file-collection conflicts") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            let path="/dav/PaperDigest/2026-10/",id="00112233-4455-6677-8899-aabbccddeeff"
            await dav.addDirectory(path)
            let cases=[CloudTestDAV.xml([(path,true),(String(path.dropLast()),true)]),
                       CloudTestDAV.xml([(path,true),(path+id,true),(path+id+"/",true)]),
                       CloudTestDAV.xml([(path,true),(path+id,false),(path+id+"/",true)])]
            for xml in cases { await dav.listing(xml);try await rejects(.incompleteListing) { _=try await s.list(month:"2026-10") } }
        }
        await check("collection alias compatibility never accepts escaped or ambiguous URI paths") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            let path="/dav/PaperDigest/2026-10/"
            await dav.addDirectory(path)
            for bad in ["/dav/PaperDigest/2026-10//", "/dav/PaperDigest/%32%30%32%36-10", "/dav/PaperDigest%2F2026-10", "/dav/PaperDigest/../PaperDigest/2026-10", "dav/PaperDigest/2026-10", "//dav.jianguoyun.com/dav/PaperDigest/2026-10"] {
                await dav.listing(CloudTestDAV.xml([(bad,true)]))
                try await rejects(.incompleteListing) { _=try await s.list(month:"2026-10") }
            }
        }
        await check("750 DAV entries, missing root, evil href, duplicate and DTD refuse incomplete lists") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            let monthPath="/dav/PaperDigest/2026-10/";await dav.addDirectory(monthPath)
            let id=UUID().uuidString.lowercased()
            var limitMembers=[(monthPath,true)]
            for _ in 0..<749 { limitMembers.append((monthPath+UUID().uuidString.lowercased()+"/",true)) }
            let cases=[CloudTestDAV.xml(limitMembers),CloudTestDAV.xml([(monthPath+id+"/",true)]),CloudTestDAV.xml([(monthPath,true),("https://evil.invalid/steal/",true)]),CloudTestDAV.xml([(monthPath,true),(monthPath,true)]),Data("<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><d:multistatus xmlns:d='DAV:'/>".utf8)]
            for xml in cases { await dav.listing(xml);try await rejects(.incompleteListing) { _=try await s.list(month:"2026-10") } }
        }
        await check("uppercase UUID href is refused rather than silently probed as a different path") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            let path="/dav/PaperDigest/2026-10/",upper=UUID().uuidString
            await dav.addDirectory(path)
            await dav.listing(CloudTestDAV.xml([(path,true),(path+upper+"/",true)]))
            try await rejects(.incompleteListing) { _=try await s.list(month:"2026-10") }
            try require(await dav.records().count==1,"no lowercase GET of another remote path")
        }
        await check("failed resourcetype cannot borrow success from a different DAV propstat") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            let path="/dav/PaperDigest/2026-10/";await dav.addDirectory(path)
            let bad=Data(("<d:multistatus xmlns:d='DAV:'><d:response><d:href>"+path+"</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat><d:propstat><d:prop><d:displayname>not a collection</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>").utf8)
            await dav.listing(bad)
            try await rejects(.incompleteListing) { _=try await s.list(month:"2026-10") }
            try await rejects(.incompleteListing) { _=try await s.upload(encodedBackup:small) }
        }
        await check("missing month is empty, partial directories are excluded, valid absolute DAV href accepted") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            try require(try await s.list(month:"2026-09").isEmpty,"actual 404 month empty")
            let path="/dav/PaperDigest/2026-10/",id=UUID().uuidString.lowercased()
            await dav.addDirectory(path)
            await dav.listing(CloudTestDAV.xml([("https://dav.jianguoyun.com"+path,true),("https://dav.jianguoyun.com"+path+id+"/",true)]))
            try require(try await s.list(month:"2026-10").isEmpty,"no completion manifest not success")
        }
        await check("redirect and oversized injected responses stop without forwarding authentication") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            await dav.add(.init("PROPFIND","/dav/",status:302,headers:["Location":"https://evil.invalid/"]))
            try await rejects(.redirect) { try await s.probe() }
            try require(await dav.records().count==1,"no redirect follow")
            await dav.redirectResponse(URL(string:"https://evil.invalid/dav/"))
            try await rejects(.redirect) { try await s.probe() }
            await dav.redirectResponse(nil)
            await dav.listing(Data(repeating:0,count:4*1024*1024+1))
            try await rejects(.oversizedResponse) { try await s.probe() }
        }
        await check("reserved Zotero WebDAV directory is refused case-insensitively before HTTP") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog()
            for folder in ["zotero","ZoTeRo","ZOTERO"] {
                try await rejects(.invalidConfiguration) { _=try CloudArchiveService(folder:folder,destinationID:UUID(),credentials:{.init(username:"fixture",password:"fixture")},checkpointSink:{try await log.save($0)},transport:{try await dav.request($0,limit:$1)}) }
            }
            for folder in ["PaperDigest","Research.2026","zotero-backup"] {
                _=try CloudArchiveService(folder:folder,destinationID:UUID(),credentials:{.init(username:"fixture",password:"fixture")},checkpointSink:{try await log.save($0)},transport:{try await dav.request($0,limit:$1)})
            }
            try require(await dav.records().isEmpty,"no request or mutation in Zotero-owned directory")
        }
        await check("unsafe folders, invalid months and invalid backups fail before any dispatch") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog()
            for folder in ["",".","..","a/b","a\\b","中文","a b","a%2fb",String(repeating:"a",count:65)] {
                try await rejects(.invalidConfiguration) { _=try CloudArchiveService(folder:folder,destinationID:UUID(),credentials:{.init(username:"fixture",password:"fixture")},checkpointSink:{try await log.save($0)},transport:{try await dav.request($0,limit:$1)}) }
            }
            let s=try service(dav,log)
            for month in ["2026-00","2026-13","2026-1","../2026-01","1999-12","2026-10/x"] { try await rejects(.invalidConfiguration) { _=try await s.list(month:month) } }
            try await rejects(.invalidBackup) { _=try await s.upload(encodedBackup:Data("invalid backup".utf8)) }
            try require(await dav.records().isEmpty,"no network on invalid local inputs")
        }
        await check("malformed manifest bounds, chunk index/hash/count and total SHA are rejected") {
            let dav=CloudTestDAV(),log=CloudCheckpointLog(),s=try service(dav,log)
            let info=try await s.upload(encodedBackup:small),path=base(info.reference)+"manifest.json"
            guard let original=await dav.getFile(path),let object=try JSONSerialization.jsonObject(with:original) as? [String:Any] else { throw CloudTestError(message:"missing original manifest") }
            for mutation in 0..<6 {
                var bad=object
                if mutation==0 { bad["encodedBytes"]=CloudArchiveService.maxEncodedBytes+1 }
                if mutation==1 { bad["chunks"]=[] }
                if mutation==2 { var chunks=bad["chunks"] as! [[String:Any]];chunks[0]["index"]=1;bad["chunks"]=chunks }
                if mutation==3 { bad["sha256"]=String(repeating:"0",count:64) }
                if mutation==4 { bad["contract"]="foreign-app-backup" }
                if mutation==5 { bad["createdAt"]=(bad["createdAt"] as! Double)+500 }
                await dav.setFile(path,try JSONSerialization.data(withJSONObject:bad))
                try await rejects(.integrity) { _=try await s.download(reference:info.reference) }
            }
        }
        #if PAPER_DIGEST_TESTS
        await check("production URLSession bounds both announced and streamed response bodies") {
            let transport=CloudArchiveService.interceptedTransport(protocolClasses:[CloudInterceptProtocol.self])
            let request=URLRequest(url:URL(string:"https://dav.jianguoyun.com/dav/fixture")!)
            CloudInterceptProtocol.configure(headers:["Content-Length":"4"],chunks:[Data("test".utf8)])
            try require(try await transport(request,4).data==Data("test".utf8),"exact bounded bytes")
            CloudInterceptProtocol.configure(headers:["Content-Length":"5"],chunks:[])
            try await rejects(.oversizedResponse) { _=try await transport(request,4) }
            CloudInterceptProtocol.configure(chunks:[Data("test".utf8),Data("overflow".utf8)])
            try await rejects(.oversizedResponse) { _=try await transport(request,4) }
        }
        await check("production oversized error body cannot hide Retry-After or authentication status") {
            let clock=CloudTestClock(),log=CloudCheckpointLog(),transport=CloudArchiveService.interceptedTransport(protocolClasses:[CloudInterceptProtocol.self])
            let s=try CloudArchiveService(destinationID:UUID(),credentials:{.init(username:"fixture@example.invalid",password:"synthetic-app-password")},checkpointSink:{try await log.save($0)},transport:transport,now:{clock.now()},sleep:{clock.advance($0)},minimumRequestInterval:0)
            CloudInterceptProtocol.configure(status:429,headers:["Content-Length":"999999999","Retry-After":"180"],chunks:[])
            try await rejects(.throttled(clock.now().addingTimeInterval(180))) { _=try await s.upload(encodedBackup:small) }
            try require(await log.latest()?.retryAfter==clock.now().addingTimeInterval(180),"429 header persisted despite oversized error")
            let auth=try CloudArchiveService(destinationID:UUID(),credentials:{.init(username:"fixture",password:"fixture")},checkpointSink:{try await log.save($0)},transport:transport,minimumRequestInterval:0)
            CloudInterceptProtocol.configure(status:401,headers:["Content-Length":"999999999"],chunks:[])
            try await rejects(.authentication) { try await auth.probe() }
            try require(CloudInterceptProtocol.recorded().count==1,"401 still one request")
        }
        await check("production session refuses cross-origin redirects before another request") {
            CloudInterceptProtocol.configure(status:302,headers:["Location":"https://evil.invalid/must-not-receive-basic"],redirect:true)
            let transport=CloudArchiveService.interceptedTransport(protocolClasses:[CloudInterceptProtocol.self])
            var request=URLRequest(url:URL(string:"https://dav.jianguoyun.com/dav/")!)
            request.setValue("Basic synthetic-test-only",forHTTPHeaderField:"Authorization")
            try await rejects(.redirect) { _=try await transport(request,1024) }
            try require(CloudInterceptProtocol.recorded().count==1,"only original origin receives request")
            try require(CloudInterceptProtocol.recorded().first?.value(forHTTPHeaderField:"Cookie")==nil,"ephemeral request does not add cookie")
        }
        #endif
        print("CloudArchiveService: \(passed) passed, \(failures.count) failed")
        if !failures.isEmpty { exit(1) }
    }
}
