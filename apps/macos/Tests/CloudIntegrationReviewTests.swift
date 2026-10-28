// Independent integration fixtures: temporary data, in-memory DAV transport,
// real application job/restore paths and only our own invisible NSAlert sheets.
// No installed profile, real account, Keychain operation or network transport.
import AppKit
import WebKit

private final class IntegrationOfflineProtocol:URLProtocol,@unchecked Sendable {
    override class func canInit(with request:URLRequest)->Bool{true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    override func startLoading(){client?.urlProtocol(self,didFailWithError:URLError(.notConnectedToInternet))}
    override func stopLoading(){}
}
private struct IntegrationNoCredentials:ZoteroCredentialStore {
    func load(serverID:String)throws->Data?{throw DesktopError.message("Isolated settings fixture forbids credential reads")}
    func save(_ data:Data,serverID:String)throws{throw DesktopError.message("Isolated settings fixture forbids credential writes")}
    func remove(serverID:String)throws{throw DesktopError.message("Isolated settings fixture forbids credential removal")}
}
@MainActor private final class IntegrationMetadataCapture {
    var pending:[UUID:CloudLocalStore.Pending]=[:]
}
private actor IntegrationCredentialWait {
    private var started=false
    func enter(){started=true}
    func entered()->Bool{started}
}

private actor IntegrationDAV {
    var files:[String:Data]=[:]
    var requests:[String]=[]
    var failGET=false
    var authDenied=false
    func failDownloads(){failGET=true}
    func denyCredentials(){authDenied=true}
    func allFiles()->[String:Data]{files}
    func count()->Int{requests.count}
    func records()->[String]{requests}
    func request(_ request:URLRequest,_ limit:Int)throws->CloudArchiveService.Response {
        guard let url=request.url,url.host=="dav.jianguoyun.com" else{throw DesktopError.message("Fixture rejects external destination")}
        let method=request.httpMethod ?? "GET",path=URLComponents(url:url,resolvingAgainstBaseURL:false)!.path;requests.append(method+" "+path)
        func response(_ status:Int,_ bytes:Data=Data())->CloudArchiveService.Response {
            .init(data:bytes,response:HTTPURLResponse(url:url,statusCode:status,httpVersion:"HTTP/1.1",headerFields:[:])!)
        }
        if authDenied{return response(401)}
        switch method {
        case "MKCOL":return response(201)
        case "PROPFIND":
            return response(207,Data("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>\(path)</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>".utf8))
        case "PUT":
            guard request.value(forHTTPHeaderField:"If-None-Match")=="*",let body=request.httpBody else{throw DesktopError.message("Fixture requires immutable writes")}
            if files[path] != nil{return response(412)};files[path]=body;return response(201)
        case "GET":
            if failGET{throw URLError(.networkConnectionLost)}
            guard let bytes=files[path] else{return response(404)}
            guard bytes.count<=limit else{throw DesktopError.message("Fixture bound exceeded")}
            return response(200,bytes)
        default:throw DesktopError.message("Unexpected fixture DAV verb")
        }
    }
}

@main struct CloudIntegrationReviewTests {
    static func main(){
        _=NSApplication.shared;NSApp.setActivationPolicy(.prohibited)
        Task{@MainActor in do{try await run();exit(0)}catch{fputs("FAIL Cloud integration: \(error)\n",stderr);exit(1)}}
        NSApplication.shared.run();fputs("FAIL Cloud integration exited before complete summary\n",stderr);exit(2)
    }
    @MainActor static func run()async throws {
        let fm=FileManager.default,root=fm.temporaryDirectory.appendingPathComponent("CloudIntegration-"+UUID().uuidString)
        try fm.createDirectory(at:root,withIntermediateDirectories:true)
        var apps:[PaperDigestApp]=[];defer{for app in apps{app.schedule?.invalidate();app.cloudSchedule?.invalidate();for job in app.jobs.values{job.cancel()};app.settingsWindow?.delegate=nil;app.settingsWindow?.close();app.window?.delegate=nil;app.window?.close()};try? fm.removeItem(at:root)}
        let captured=IntegrationMetadataCapture()
        var passed=0
        func check(_ ok:Bool,_ name:String)throws{guard ok else{throw DesktopError.message(name)};passed+=1;print("PASS "+name)}
        func rejected(_ name:String,_ action:()async throws->Void)async throws{do{try await action()}catch{try check(true,name);return};throw DesktopError.message("Expected rejection: "+name)}
        func folder(_ name:String)throws->URL{let d=root.appendingPathComponent(name+"-"+UUID().uuidString);try fm.createDirectory(at:d,withIntermediateDirectories:true);return d}
        func canonical(_ object:Any)throws->Data{try JSONSerialization.data(withJSONObject:object,options:.sortedKeys)}
        func bytes(_ d:URL)throws->Data{try BackupCodec.encode(BackupCodec.collect(sourceDirectory:d))}
        func note(_ store:DesktopStore,_ text:String)throws{_=try store.saveNote(id:"fixture-paper",text:text,baseRevision:0)}
        let today=String(ISO8601DateFormatter().string(from:Date()).prefix(10)),time="2026-10-24T12:00:00Z"
        func issued(_ id:String,_ date:String)->[String:Any]{["id":id,"requestIssued":true,"startedAt":date,"status":"failed","usage":NSNull()]}
        func floor(_ requests:[RequestBudgetContinuity.Issued],_ d:URL)throws{
            let e=JSONEncoder();e.outputFormatting=[.sortedKeys];try e.encode(RequestBudgetContinuity.Record(contract:"paperdigest-request-continuity-v1",requests:requests)).write(to:d.appendingPathComponent(RequestBudgetContinuity.filename),options:.atomic)
        }
        func makeApp(_ name:String)throws->PaperDigestApp{
            let d=try folder(name),app=PaperDigestApp();app.directory=d;app.store=try DesktopStore(directory:d)
            app.library=try LibraryService(dataDirectory:d,seedDirectory:d.appendingPathComponent("NoSeed"));app.storage=DesktopStorage(directory:d,store:app.store)
            app.model=ModelService(directory:d,store:app.store,keyProvider:{throw DesktopError.message("Fixture forbids model credentials")})
            app.window=NSWindow(contentRect:NSRect(x:0,y:0,width:1100,height:750),styleMask:[.titled,.closable],backing:.buffered,defer:false);app.window.alphaValue=0;app.window.isReleasedWhenClosed=false;app.window.title="Isolated cloud integration fixture"
            apps.append(app);return app
        }
        func wait(_ name:String,_ condition:()async throws->Bool)async throws{
            for _ in 0..<500{if try await condition(){return};try await Task.sleep(nanoseconds:10_000_000)}
            throw DesktopError.message("Fixture timeout: "+name)
        }
        func service(_ app:PaperDigestApp,_ dav:IntegrationDAV)throws->CloudArchiveService {
            let local=try app.cloudLocalStore();try local.save(account:"fixture@example.invalid",folder:"PaperDigestFixture",automatic:false,intervalHours:24)
            let destination=local.profile.destinationID
            return try CloudArchiveService(folder:local.profile.folder,destinationID:destination,
                credentials:{.init(username:"fixture@example.invalid",password:"explicit-in-memory-fixture")},checkpointSink:{checkpoint in
                    try await MainActor.run{try local.saveCheckpoint(checkpoint,destinationID:destination,sha256:checkpoint.sha256);if let pending=try local.pending(){captured.pending[destination]=pending}}
                },transport:{request,limit in try await dav.request(request,limit)},minimumRequestInterval:0)
        }
        func checkpoint(_ local:CloudLocalStore,_ pending:CloudLocalStore.Pending,reference:CloudArchiveService.SnapshotReference?=nil,verified:[Int]=[0],manifest:Bool=true)->CloudArchiveService.UploadCheckpoint {
            .init(contract:"paperdigest-cloud-transfer-v1",destinationID:local.profile.destinationID,folder:local.profile.folder,
                  reference:reference ?? .init(month:"2026-10",id:UUID()),createdAt:Date(timeIntervalSince1970:1792800000),encodedBytes:pending.encodedBytes,sha256:pending.sha256,
                  chunks:[.init(index:0,bytes:pending.encodedBytes,sha256:pending.sha256)],verifiedChunkIndices:verified,manifestVerified:manifest,retryAfter:nil)
        }

        // Credential-only mode has no NSWindow, WK, NSAlert, actual credential
        // store or network. It can run while the user handles their own system
        // security window; the default run still retains every original case.
        func credentialApp(_ name:String)throws->PaperDigestApp {
            let d=try folder(name),app=PaperDigestApp();app.directory=d;app.store=try DesktopStore(directory:d)
            app.model=ModelService(directory:d,store:app.store,keyProvider:{throw DesktopError.message("Credential fixture forbids model keys")})
            apps.append(app);return app
        }
        // Public synthetic fixtures only: restore keeps destination-local seals,
        // legacy payloads remain readable, and unsafe pending bytes never resume.
        do {
            let source=try folder("seal-old-source"),current=try folder("seal-destination")
            _=try DesktopStore(directory:source);_=try DesktopStore(directory:current)
            for d in [source,current] { try fm.createDirectory(at:d.appendingPathComponent("ModelUsage"),withIntermediateDirectories:false) }
            let oldKey=Data(repeating:0x11,count:32),localKey=Data(repeating:0x22,count:32),response=Data("original synthetic response, never resealed".utf8)
            for p in BackupCodec.localOnlyKeyPaths { try oldKey.write(to:source.appendingPathComponent(p));try localKey.write(to:current.appendingPathComponent(p)) }
            try response.write(to:source.appendingPathComponent("ModelUsage/response.json"))
            let portable=try BackupCodec.collect(sourceDirectory:source)
            let entries=portable.files + BackupCodec.localOnlyKeyPaths.map { BackupCodec.Entry(path:$0,sha256:PrivateStoragePaths.sha256(oldKey),data:oldKey) }
            let legacy=BackupCodec.Payload(sourceDirectory:source.path,files:entries),legacyBytes=try JSONEncoder().encode(legacy)
            let stage=try BackupCodec.stage(data:legacyBytes,parentDirectory:root).stageDirectory
            try RestoreLocalPolicy.apply(stage:stage,current:current)
            for p in BackupCodec.localOnlyKeyPaths {
                try check(try Data(contentsOf:stage.appendingPathComponent(p))==localKey && Data(contentsOf:current.appendingPathComponent(p))==localKey,"restore preserves destination seal in staged new-live root, not source archive seal")
                let permissions=try fm.attributesOfItem(atPath:stage.appendingPathComponent(p).path)[.posixPermissions] as! NSNumber
                try check(permissions.intValue & 0o777 == 0o600,"preserved destination seal stays0600")
            }
            try check(try Data(contentsOf:stage.appendingPathComponent("ModelUsage/response.json"))==response,"restore does not resign or rewrite old response")
            let recaptured=try BackupCodec.collect(sourceDirectory:stage)
            try check(!recaptured.files.contains{BackupCodec.isLocalOnlyKey($0.path)},"preserved local seals never reenter export/cloud manifest")
            let fresh=try folder("seal-fresh-destination");_=try DesktopStore(directory:fresh)
            let freshStage=try BackupCodec.stage(data:legacyBytes,parentDirectory:root).stageDirectory
            try RestoreLocalPolicy.apply(stage:freshStage,current:fresh)
            try check(BackupCodec.localOnlyKeyPaths.allSatisfy{!fm.fileExists(atPath:freshStage.appendingPathComponent($0).path)},"fresh restore imports no archive seal, normal model use may create its own later")

            let local=try CloudLocalStore(dataDirectory:source)
            try local.save(account:"fixture@example.invalid",folder:"PaperDigestFixture",automatic:false,intervalHours:24)
            let legacyPending=CloudLocalStore.Pending(contract:"paperdigest-cloud-pending-v1",destinationID:local.profile.destinationID,createdAt:"2026-10-24T12:00:00Z",fileCount:legacy.files.count,encodedBytes:legacyBytes.count,sha256:PrivateStoragePaths.sha256(legacyBytes),checkpoint:nil)
            var originalPending=legacyPending;originalPending.checkpoint=checkpoint(local,legacyPending,verified:[0],manifest:false)
            let pendingFolder=local.root.appendingPathComponent(local.profile.destinationID.uuidString);try fm.createDirectory(at:pendingFolder,withIntermediateDirectories:false)
            let pendingBytes=try JSONEncoder().encode(originalPending)
            try pendingBytes.write(to:pendingFolder.appendingPathComponent("pending.json"));try legacyBytes.write(to:pendingFolder.appendingPathComponent("snapshot.paperdigest"))
            try await rejected("legacy pending with local seals is blocked without reencoding original UUID/SHA"){_=try local.bytes(for:originalPending)}
            let credential=IntegrationCredentialWait(),checkpointTouch=IntegrationCredentialWait(),dav=IntegrationDAV()
            let engine=try CloudArchiveService(folder:local.profile.folder,destinationID:local.profile.destinationID,credentials:{await credential.enter();throw DesktopError.message("Forbidden credential access")},checkpointSink:{_ in await checkpointTouch.enter()},transport:{request,limit in try await dav.request(request,limit)},minimumRequestInterval:0)
            try await rejected("raw legacy service upload is blocked before credential and transport"){_=try await engine.upload(encodedBackup:legacyBytes,resuming:originalPending.checkpoint)}
            let credentialEntered=await credential.entered(),checkpointWritten=await checkpointTouch.entered(),requestCount=await dav.count()
            try check(!credentialEntered && !checkpointWritten && requestCount==0,"unsafe legacy upload has zero credential reads/checkpoint writes/remote requests")
            try check(try Data(contentsOf:pendingFolder.appendingPathComponent("pending.json"))==pendingBytes && Data(contentsOf:pendingFolder.appendingPathComponent("snapshot.paperdigest"))==legacyBytes,"blocked old pending and original encoded bytes stay exact")
            let retained=try local.archivePending()
            try check(try Data(contentsOf:retained.appendingPathComponent("pending.json"))==pendingBytes && Data(contentsOf:retained.appendingPathComponent("snapshot.paperdigest"))==legacyBytes,"local retain remains available for unsafe legacy materials, no remote deletion")
            let next=try local.prepare(portable)
            try check(next.sha256 != originalPending.sha256 && next.checkpoint == nil && !(try BackupCodec.parse(local.bytes(for:next))).files.contains{BackupCodec.isLocalOnlyKey($0.path)},"new clean snapshot is separate from original retained checkpoint and has no keys")
            if CommandLine.arguments.contains("--local-secrets-only") { print("Local secret backup/restore/cloud integration: \(passed) passed;0failed; synthetic fixtures only");return }
        }
        if !CommandLine.arguments.contains("--credentials-only") {
            // Run the actual scheduled callback once; no wall clock wait, system
            // clock mutation, real account, credential store or network is used.
            func scheduledApp(_ name:String)throws->(PaperDigestApp,CloudLocalStore,IntegrationDAV) {
                let app=try credentialApp("schedule-"+name),dav=IntegrationDAV()
                let transportService=try service(app,dav),local=try app.cloudLocalStore()
                try local.save(account:local.profile.account,folder:local.profile.folder,automatic:true,intervalHours:24)
                app.cloudArchive=transportService
                app.cloudVaultLoadOverride={_ in throw DesktopError.message("Scheduled fixture forbids real credential access")}
                return(app,local,dav)
            }
            let (scheduled,scheduledLocal,scheduledDAV)=try scheduledApp("actual-timer")
            scheduled.currentPaperID="unrelated-current-paper"
            scheduled.configureCloudSchedule();let retiredTimer=scheduled.cloudSchedule!
            scheduled.configureCloudSchedule();let actualTimer=scheduled.cloudSchedule!
            try check(!retiredTimer.isValid && actualTimer.isValid && actualTimer.timeInterval==300,"cloud configuration invalidates old timer and installs actual300s repeating callback")
            actualTimer.fire()
            try await wait("actual timer-created cloud upload terminal") {
                !scheduled.cloudBusy && scheduled.jobs.isEmpty && scheduled.cloudActiveJobID==nil &&
                (scheduled.store.snapshot()["jobs"] as! [[String:Any]]).contains{$0["command"] as? String=="cloud.upload" && $0["status"] as? String=="complete"}
            }
            let taskRows=scheduled.store.snapshot()["jobs"] as! [[String:Any]],uploadRows=taskRows.filter{$0["command"] as? String=="cloud.upload"}
            try check(uploadRows.count==1 && uploadRows[0]["paperID"] as? String=="" && uploadRows[0]["endedAt"] != nil,"real timer uses one normal global workspace upload job and actual terminal status")
            let calls=await scheduledDAV.records(),remoteFiles=await scheduledDAV.allFiles()
            try check(calls.contains{$0.hasPrefix("PUT ")} && calls.contains{$0.hasPrefix("GET ")} && remoteFiles.keys.contains{$0.hasSuffix("manifest.json")},"actual timer completes original service PUT and full GET/manifest path")
            guard let backup=scheduledLocal.profile.lastBackup else{throw DesktopError.message("Actual scheduled upload did not save completion")}
            let downloaded=try await scheduled.cloudService().download(reference:.init(month:backup.month,id:backup.id)),decoded=try BackupCodec.parse(downloaded)
            try check(decoded.files.contains{$0.path=="personal.json"} && (try scheduledLocal.pending())==nil,"actual scheduled snapshot is normally decodable and pending only clears after complete")
            let completedCalls=await scheduledDAV.count(),completedJobs=try canonical(scheduled.store.snapshot()["jobs"]!)
            await scheduled.performScheduledCloudBackupIfDue()
            try check(await scheduledDAV.count()==completedCalls && (try canonical(scheduled.store.snapshot()["jobs"]!))==completedJobs,"awaited scheduled callback does not dispatch again before interval is due")
            actualTimer.invalidate()
            for guardName in ["cloudBusy","maintenance","termination","jobs","details","memoryPause","durablePause","notDue","disabled"] {
                let (guarded,local,dav)=try scheduledApp(guardName)
                switch guardName {
                case "cloudBusy":guarded.cloudBusy=true
                case "maintenance":guarded.maintenanceBusy=true
                case "termination":guarded.terminationPending=true
                case "jobs":guarded.jobs["owned-fixture-job"]=Task<[String:Any],Error>{[: ]}
                case "details":guarded.storageDetailSession=StorageDetailSession(generation:0,paperID:"fixture-paper",previousResponder:nil)
                case "memoryPause":guarded.cloudAutomaticPausedInMemory=true
                case "durablePause":try local.pauseAutomatic(true)
                case "notDue":try local.recordAttempt()
                case "disabled":try local.save(account:local.profile.account,folder:local.profile.folder,automatic:false,intervalHours:24)
                default:throw DesktopError.message("Unknown scheduled fixture guard")
                }
                let before=try canonical(guarded.store.snapshot()),profile=try Data(contentsOf:local.root.appendingPathComponent("profile.json"))
                await guarded.performScheduledCloudBackupIfDue()
                let requestCount=await dav.count()
                try check(requestCount==0 && (try canonical(guarded.store.snapshot()))==before && (try Data(contentsOf:local.root.appendingPathComponent("profile.json")))==profile && (try local.pending())==nil,"awaited original callback guard "+guardName+" sends0transport and preserves personal/profile/pending")
                if guardName=="disabled" {guarded.configureCloudSchedule();try check(guarded.cloudSchedule==nil,"disabled cloud automation creates no timer")}
                guarded.jobs.removeAll();guarded.storageDetailSession=nil
            }
            print("Cloud schedule native focused: actualTimer1 normal callback plus nine independent guards completed; no real credentials/network")
            if CommandLine.arguments.contains("--schedule-only") { print("Cloud schedule focused: \(passed) passed;0failed");return }
        }
        for kind in ["missing-local-permission","private-provider-error"] {
            let app=try credentialApp(kind),local=try app.cloudLocalStore(),dav=IntegrationDAV()
            try local.save(account:"credential-fixture@example.invalid",folder:"CredentialFixture",automatic:true,intervalHours:24)
            let bait="ISOLATED_PROVIDER_PRIVATE_DETAIL_MUST_NOT_ESCAPE_"+kind
            app.cloudArchive=try CloudArchiveService(folder:local.profile.folder,destinationID:local.profile.destinationID,
                credentials:{throw DesktopError.message(bait)},checkpointSink:{_ in throw DesktopError.message("No upload checkpoint expected")},
                transport:{request,limit in try await dav.request(request,limit)},minimumRequestInterval:0)
            var localCause:CloudArchiveService.CloudError?,safeError=""
            do{_=try await app.dispatch("cloud.upload",payload:[:])}catch{localCause=error as? CloudArchiveService.CloudError;safeError=error.localizedDescription}
            try check(localCause == .credentialsUnavailable,kind+" actual dispatch identifies local credential access failure instead of remote HTTP authentication")
            let row=(app.store.snapshot()["jobs"] as! [[String:Any]]).first{$0["command"] as? String=="cloud.check"}!
            try check(!safeError.contains(bait) && !(app.cloudLastError ?? "").contains(bait) && !(row["message"] as? String ?? "").contains(bait),kind+" hides provider private detail in returned state and persisted task error")
            try check(app.cloudAutomaticPausedInMemory && local.profile.automaticPaused==true && (try CloudLocalStore(dataDirectory:app.directory)).profile.automaticPaused==true,kind+" pauses automatic retries both in memory and in device profile")
            let transports=await dav.count()
            try check(transports==0 && (try local.pending())==nil && !app.cloudBusy && app.jobs.isEmpty,kind+" fails before transport or snapshot creation and releases job/busy locks")
            try check(row["status"] as? String=="failed" && app.window==nil && app.settingsWindow==nil,kind+" persists failure without creating any window or panel")
        }
        let cancelledApp=try credentialApp("cancelled-provider"),cancelledLocal=try cancelledApp.cloudLocalStore(),cancelledDAV=IntegrationDAV(),providerWait=IntegrationCredentialWait()
        try cancelledLocal.save(account:"cancel-fixture@example.invalid",folder:"CancelFixture",automatic:true,intervalHours:24)
        cancelledApp.cloudArchive=try CloudArchiveService(folder:cancelledLocal.profile.folder,destinationID:cancelledLocal.profile.destinationID,
            credentials:{await providerWait.enter();try await Task.sleep(nanoseconds:60_000_000_000);return .init(username:"fixture",password:"never-issued")},
            checkpointSink:{_ in throw DesktopError.message("No checkpoint expected")},transport:{request,limit in try await cancelledDAV.request(request,limit)},minimumRequestInterval:0)
        let cancelOperation=Task{@MainActor in try await cancelledApp.dispatch("cloud.upload",payload:[:])}
        try await wait("actual credential provider awaiting cancellation"){await providerWait.entered()}
        guard let cancelJob=cancelledApp.cloudActiveJobID else{throw DesktopError.message("Actual cancellable cloud job missing")}
        _=try await cancelledApp.dispatch("jobs.cancel",payload:["id":cancelJob])
        var nativeCancellation=false
        do{_=try await cancelOperation.value}catch{nativeCancellation=error is CancellationError}
        try check(nativeCancellation,"actual jobs.cancel during credential await preserves CancellationError rather than authentication")
        let cancelledRow=(cancelledApp.store.snapshot()["jobs"] as! [[String:Any]]).first{$0["id"] as? String==cancelJob}!
        try check(cancelledRow["status"] as? String=="cancelled" && cancelledRow["endedAt"] != nil,"provider cancellation reaches real persisted cancelled job terminal state")
        try check(!cancelledApp.cloudAutomaticPausedInMemory && cancelledLocal.profile.automaticPaused != true && (try CloudLocalStore(dataDirectory:cancelledApp.directory)).profile.automaticPaused != true,"user cancellation is not treated as authentication fault or persistent automatic pause")
        let cancelledTransports=await cancelledDAV.count()
        try check(cancelledTransports==0 && (try cancelledLocal.pending())==nil && cancelledApp.jobs.isEmpty && !cancelledApp.cloudBusy,"provider cancellation sends no request and leaves no snapshot or busy lock")
        try check(cancelledApp.window==nil && cancelledApp.settingsWindow==nil,"credential integration does not create any native window or security prompt")
        if CommandLine.arguments.contains("--credentials-only") {
            print("Cloud credential native integration: \(passed) passed; 0 failed; no windows/panels, real credentials or network")
            return
        }

        // Pure continuity is a set of historical issued request identities, not
        // another token/price ledger or a replacement for original raw records.
        let a=RequestBudgetContinuity.Issued(id:"issued-A",startedAt:today+"T01:00:00Z"),b=RequestBudgetContinuity.Issued(id:"issued-B",startedAt:today+"T02:00:00Z")
        try check(try RequestBudgetContinuity.union([[a],[a,b]]).count==2,"issued histories union same id once without resetting the floor")
        try await rejected("conflicting timestamp for same issued id is rejected"){_=try RequestBudgetContinuity.union([[a],[.init(id:a.id,startedAt:time)]])}
        try await rejected("issued session missing identity is rejected"){_=try RequestBudgetContinuity.fromSessions([["requestIssued":true,"startedAt":time]])}
        for valid in ["2024-02-29T23:59:59Z","2024-02-29T23:59:59.1Z","2024-02-29T23:59:59.123456789Z"] {
            try check(try RequestBudgetContinuity.union([[.init(id:"valid-time",startedAt:valid)]])[0].startedAt==valid,"valid leap and fractional UTC time retains exact original string "+valid)
        }
        for invalid in ["2026-99-99Tbad","2025-02-29T01:00:00Z","2024-02-30T01:00:00Z","2026-10-24T24:00:00Z","2026-10-24T01:60:00Z","2026-10-24T01:00:60Z","2026-10-24T01:00:00+08:00","2026-10-24T01:00Z","2026-10-24T01:00:00.Z","2026-10-24T01:00:00.1234567890Z","2026-10-24T01:00:00Z\n"] {
            try await rejected("malformed original issued time refuses continuity: "+invalid.replacingOccurrences(of:"\n",with:"<newline>")){_=try RequestBudgetContinuity.union([[.init(id:"invalid-time",startedAt:invalid)]])}
        }
        let countDir=try folder("count");try floor([a,b,.init(id:"older-day",startedAt:"2000-01-01T00:00:00Z")],countDir)
        try check(try RequestBudgetContinuity.count(on:today,directory:countDir,sessions:[issued(a.id,a.startedAt),["id":"not-issued","requestIssued":false,"startedAt":today+"T03:00:00Z"]])==2,"daily budget deduplicates local sessions and excludes other days or unissued sessions")

        let current=try folder("policy-current"),stage=try folder("policy-stage"),currentStore=try DesktopStore(directory:current),stagedStore=try DesktopStore(directory:stage)
        let localSettings:[String:Any]=["endpoint":"https://local-fixture.invalid/v1","model":"local-fixture-model","protocol":"responses","httpProxy":"http://127.0.0.1:18080","dailyRequests":2,"timeoutMs":12345,"maxTokens":256,"responsesStream":false,"reasoningEffort":"low","appearance":"dark"]
        try currentStore.updateSettings(localSettings);try stagedStore.updateSettings(["endpoint":"https://old-untrusted.invalid/v1","model":"old-model","protocol":"chat","dailyRequests":999,"appearance":"light"])
        try note(currentStore,"current-note");try note(stagedStore,"restored-old-note")
        try currentStore.appendSession(issued(a.id,a.startedAt));try stagedStore.appendSession(issued(b.id,b.startedAt));try floor([a],current);try floor([.init(id:"prior-restored",startedAt:"2000-01-01T00:00:00Z")],stage)
        let currentRaw=try bytes(current),originalPersonal=try Data(contentsOf:stage.appendingPathComponent("personal.json")),originalSessions=try canonical(stagedStore.snapshot()["sessions"]!)
        try RestoreLocalPolicy.apply(stage:stage,current:current)
        let effective=try DesktopStore(directory:stage),settings=effective.snapshot()["settings"] as! [String:Any]
        try check(try canonical(settings.filter{RestoreLocalPolicy.connectionKeys.contains($0.key)})==canonical(localSettings.filter{RestoreLocalPolicy.connectionKeys.contains($0.key)}),"restore keeps every local route protocol proxy model and request-budget setting")
        try check(settings["appearance"] as? String=="light","research display preference may follow snapshot while local connection stays")
        try check(try canonical(effective.snapshot()["sessions"]!)==originalSessions,"restored original sessions and usage are not rewritten")
        try check(try bytes(current)==currentRaw,"policy staging leaves all live research bytes unchanged")
        let receipts=try fm.contentsOfDirectory(at:stage.appendingPathComponent("RestorationReceipts"),includingPropertiesForKeys:nil)
        try check(receipts.count==1 && (try Data(contentsOf:receipts[0]))==originalPersonal,"effective route adjustment retains exact original backed-up personal bytes as receipt")
        try check(try RequestBudgetContinuity.count(on:today,directory:stage,sessions:effective.snapshot()["sessions"] as! [[String:Any]])==2,"restoring older sessions cannot roll back already-issued daily count")
        var keyReads=0;let capped=ModelService(directory:stage,store:effective,keyProvider:{keyReads+=1;throw DesktopError.message("No real credentials")})
        var capMessage="";do{_=try await capped.run(id:UUID().uuidString,paperID:"fixture-paper",question:"Explicit budget fixture",evidence:"",source:["kind":"published-reader"])}catch{capMessage=error.localizedDescription}
        try check(capMessage.contains("每日") && keyReads==0,"actual model admission enforces restored union floor before credentials or worker")
        let emptyLocal=try folder("empty-local"),oldRoute=try folder("old-route");_=try DesktopStore(directory:emptyLocal);let oldRouteStore=try DesktopStore(directory:oldRoute);try oldRouteStore.updateSettings(["endpoint":"https://must-not-get-primary.invalid","model":"old-model","dailyRequests":999])
        try RestoreLocalPolicy.apply(stage:oldRoute,current:emptyLocal);let cleaned=try DesktopStore(directory:oldRoute).snapshot()["settings"] as! [String:Any]
        try check(RestoreLocalPolicy.connectionKeys.allSatisfy{cleaned[$0]==nil},"local absence removes old snapshot connection keys rather than sending local primary to old endpoint")
        for corrupt in ["bad-contract","bad-json","conflict"] {
            let live=try folder("reject-live"),pending=try folder("reject-stage"),l=try DesktopStore(directory:live),s=try DesktopStore(directory:pending)
            try note(l,"protected-live");try note(s,"protected-stage")
            if corrupt=="bad-contract"{try Data("{\"contract\":\"wrong\",\"requests\":[]}".utf8).write(to:live.appendingPathComponent(RequestBudgetContinuity.filename))}
            else if corrupt=="bad-json"{try Data("not-json".utf8).write(to:live.appendingPathComponent(RequestBudgetContinuity.filename))}
            else{try l.appendSession(issued(a.id,a.startedAt));try s.appendSession(issued(a.id,time))}
            let beforeLive=try bytes(live),beforeStage=try bytes(pending)
            try await rejected("bad original continuity "+corrupt+" rejects before mutation"){try RestoreLocalPolicy.apply(stage:pending,current:live)}
            try check(try bytes(live)==beforeLive && bytes(pending)==beforeStage,"failed "+corrupt+" policy keeps both original live and staged bytes")
        }

        let controlApp=try makeApp("control"),local=try controlApp.cloudLocalStore();try local.save(account:"fixture@example.invalid",folder:"PaperDigestFixture",automatic:false,intervalHours:24)
        let pending=try local.prepare(BackupCodec.collect(sourceDirectory:controlApp.directory)),encoded=try local.bytes(for:pending),payload=try BackupCodec.parse(encoded)
        try check(local.root.deletingLastPathComponent()==controlApp.directory.deletingLastPathComponent() && local.root != controlApp.directory && !local.root.path.hasPrefix(controlApp.directory.path+"/"),"cloud profile and encoded pending live outside research root")
        try check(!payload.files.contains{$0.path.contains("pending.json") || $0.path.contains("snapshot.paperdigest") || $0.path.contains("profile.json")},"complete snapshot never recursively collects its own cloud control bytes")
        let cp=checkpoint(local,pending);try local.saveCheckpoint(cp,destinationID:local.profile.destinationID,sha256:pending.sha256)
        let originalPending=try Data(contentsOf:local.root.appendingPathComponent(local.profile.destinationID.uuidString+"/pending.json"))
        let badReference=CloudArchiveService.SnapshotReference(month:cp.reference.month,id:UUID())
        for variant in ["reference","createdAt","chunkCount"] {
            let bad=CloudArchiveService.SnapshotInfo(reference:variant=="reference" ? badReference:cp.reference,createdAt:variant=="createdAt" ? cp.createdAt.addingTimeInterval(1):cp.createdAt,encodedBytes:pending.encodedBytes,sha256:pending.sha256,chunkCount:variant=="chunkCount" ? 2:1)
            try await rejected("completed receipt cannot change original "+variant){try local.complete(bad,destinationID:local.profile.destinationID)}
            try check(try Data(contentsOf:local.root.appendingPathComponent(local.profile.destinationID.uuidString+"/pending.json"))==originalPending && local.bytes(for:pending)==encoded,"bad "+variant+" completion retains original pending and encoded bytes")
        }
        try await rejected("continuation checkpoint cannot replace original remote UUID"){try local.saveCheckpoint(checkpoint(local,pending,reference:badReference),destinationID:local.profile.destinationID,sha256:pending.sha256)}
        let previousDestination=local.profile.destinationID,originalProfile=try Data(contentsOf:local.root.appendingPathComponent("profile.json"))
        try await rejected("unfinished original snapshot forbids retargeting account or folder"){try local.save(account:"other-fixture@example.invalid",folder:"OtherFixture",automatic:false,intervalHours:24)}
        try check(local.profile.destinationID==previousDestination && (try Data(contentsOf:local.root.appendingPathComponent("profile.json")))==originalProfile && local.bytes(for:pending)==encoded,"retarget rejection protects original profile identity and exact encoded pending bytes")
        try check(fm.fileExists(atPath:local.root.appendingPathComponent(previousDestination.uuidString+"/snapshot.paperdigest").path),"rejected target change preserves previous incomplete materials")
        try local.complete(.init(reference:cp.reference,createdAt:cp.createdAt,encodedBytes:pending.encodedBytes,sha256:pending.sha256,chunkCount:1),destinationID:previousDestination)
        try local.save(account:"other-fixture@example.invalid",folder:"OtherFixture",automatic:false,intervalHours:24)
        try check(local.profile.destinationID != previousDestination && (try local.pending())==nil,"completed snapshot permits a new independent cloud control identity")
        try await rejected("new destination cannot read prior destination encoded bytes"){_=try local.bytes(for:pending)}

        let retainedApp=try makeApp("retained-transfer"),retainedLocal=try retainedApp.cloudLocalStore();try retainedLocal.save(account:"typo-fixture@example.invalid",folder:"ReadOnlyFixture",automatic:false,intervalHours:24)
        let retainedPending=try retainedLocal.prepare(BackupCodec.collect(sourceDirectory:retainedApp.directory)),retainedBytes=try retainedLocal.bytes(for:retainedPending),retainedCP=checkpoint(retainedLocal,retainedPending,verified:[],manifest:false)
        try retainedLocal.saveCheckpoint(retainedCP,destinationID:retainedLocal.profile.destinationID,sha256:retainedPending.sha256)
        let retainedPendingRaw=try Data(contentsOf:retainedLocal.root.appendingPathComponent(retainedLocal.profile.destinationID.uuidString+"/pending.json")),retainedProfileRaw=try Data(contentsOf:retainedLocal.root.appendingPathComponent("profile.json")),oldTarget=retainedLocal.profile.destinationID
        let archived=try retainedLocal.archivePending()
        try check(try Data(contentsOf:archived.appendingPathComponent("snapshot.paperdigest"))==retainedBytes && Data(contentsOf:archived.appendingPathComponent("pending.json"))==retainedPendingRaw,"explicit stop-and-retain preserves exact original full snapshot and incomplete checkpoint bytes")
        try check(try Data(contentsOf:archived.appendingPathComponent("connection.json"))==retainedProfileRaw && retainedLocal.profile.destinationID==oldTarget,"retained transfer records original target identity without changing current profile or copying a credential")
        try retainedLocal.save(account:"corrected-fixture@example.invalid",folder:"WritableFixture",automatic:false,intervalHours:24)
        try check(retainedLocal.profile.destinationID != oldTarget && (try retainedLocal.pending())==nil,"account or read-only target can be corrected after explicit original-transfer retention")
        try check(try BackupCodec.parse(Data(contentsOf:archived.appendingPathComponent("snapshot.paperdigest"))).files.count==retainedPending.fileCount,"retained full bytes remain normal restorable BackupCodec payload without any network or new model request")

        for damage in ["encoded","pending","orphan"] {
            let damagedApp=try makeApp("damaged-"+damage),damagedLocal=try damagedApp.cloudLocalStore();try damagedLocal.save(account:"damaged-fixture@example.invalid",folder:"DamagedFixture",automatic:false,intervalHours:24)
            let original=try damagedLocal.prepare(BackupCodec.collect(sourceDirectory:damagedApp.directory)),identity=damagedLocal.profile.destinationID,control=damagedLocal.root.appendingPathComponent(identity.uuidString)
            if damage=="encoded"{try Data("explicit corrupted snapshot fixture".utf8).write(to:control.appendingPathComponent("snapshot.paperdigest"))}
            if damage=="pending"{try Data("explicit corrupted pending fixture".utf8).write(to:control.appendingPathComponent("pending.json"))}
            if damage=="orphan"{try fm.removeItem(at:control.appendingPathComponent("pending.json"))}
            let originalEncoded=try Data(contentsOf:control.appendingPathComponent("snapshot.paperdigest")),originalPending=try? Data(contentsOf:control.appendingPathComponent("pending.json"))
            try check(try damagedLocal.hasPendingMaterials(),damage+" material presence is detected without parsing damaged bytes")
            try await rejected(damage+" original materials cannot be overwritten by preparing a fresh snapshot"){_=try damagedLocal.prepare(BackupCodec.collect(sourceDirectory:damagedApp.directory))}
            try await rejected(damage+" original materials cannot be silently retargeted"){try damagedLocal.save(account:"new-target@example.invalid",folder:"NewTarget",automatic:false,intervalHours:24)}
            let damagedState=try damagedApp.cloudState()
            if damage != "encoded"{try check((damagedState["pending"] as? [String:Any])?["damaged"] as? Bool==true,"cloud state exposes "+damage+" as damaged without claiming a complete backup")}
            else{try await rejected("corrupt encoded bytes are not accepted as a recoverable complete snapshot"){_=try damagedLocal.bytes(for:original)}}
            let retainedDamage=try damagedLocal.archivePending()
            try check(try Data(contentsOf:retainedDamage.appendingPathComponent("snapshot.paperdigest"))==originalEncoded && (try? Data(contentsOf:retainedDamage.appendingPathComponent("pending.json")))==originalPending,damage+" stop-and-retain moves exact raw bytes without inventing a checkpoint or repairing content")
            try damagedLocal.save(account:"corrected-target@example.invalid",folder:"CorrectedTarget",automatic:false,intervalHours:24)
            try check(damagedLocal.profile.destinationID != identity && (try damagedLocal.pending())==nil,damage+" retained materials permit safely configuring a new target")
            try check(fm.fileExists(atPath:retainedDamage.appendingPathComponent("connection.json").path),damage+" original target connection metadata remains with retained materials")
        }
        let previousConnectionApp=try makeApp("prior-connection"),previousConnectionLocal=try previousConnectionApp.cloudLocalStore();try previousConnectionLocal.save(account:"connection-fixture@example.invalid",folder:"ConnectionFixture",automatic:false,intervalHours:24)
        let previousConnectionPending=try previousConnectionLocal.prepare(BackupCodec.collect(sourceDirectory:previousConnectionApp.directory)),previousConnectionFolder=previousConnectionLocal.root.appendingPathComponent(previousConnectionLocal.profile.destinationID.uuidString)
        let priorConnection=Data("explicit original connection bytes from a prior failed rename; do not overwrite".utf8)
        try priorConnection.write(to:previousConnectionFolder.appendingPathComponent("connection.json"))
        let originalConnectionPending=try Data(contentsOf:previousConnectionFolder.appendingPathComponent("pending.json")),originalConnectionEncoded=try previousConnectionLocal.bytes(for:previousConnectionPending)
        let archivedConnection=try previousConnectionLocal.archivePending()
        try check(try Data(contentsOf:archivedConnection.appendingPathComponent("connection.json"))==priorConnection,"retrying retention preserves preexisting original connection.json bytes")
        let appendedConnections=try fm.contentsOfDirectory(at:archivedConnection,includingPropertiesForKeys:nil).filter{$0.lastPathComponent.hasPrefix("connection-") && $0.pathExtension=="json"}
        try check(appendedConnections.count==1,"new current profile is appended under a distinct connection UUID instead of replacing original")
        let currentConnection=try JSONSerialization.jsonObject(with:Data(contentsOf:appendedConnections[0])) as! [String:Any]
        try check(currentConnection["destinationID"] as? String==previousConnectionLocal.profile.destinationID.uuidString && currentConnection["account"] as? String=="connection-fixture@example.invalid","appended connection snapshot preserves exact current target identity without a secret")
        try check(try Data(contentsOf:archivedConnection.appendingPathComponent("pending.json"))==originalConnectionPending && Data(contentsOf:archivedConnection.appendingPathComponent("snapshot.paperdigest"))==originalConnectionEncoded,"existing-connection recovery keeps original pending and encoded snapshot unchanged")

        // Real upload dispatch: immutable snapshot before its own runJob record.
        let uploadApp=try makeApp("upload"),dav=IntegrationDAV();try note(uploadApp.store,"upload-note");uploadApp.cloudArchive=try service(uploadApp,dav)
        uploadApp.currentPaperID="arxiv:wrong-foreground";uploadApp.currentPaper=["id":uploadApp.currentPaperID,"title":"Unrelated foreground fixture paper"]
        _=try await uploadApp.dispatch("cloud.upload",payload:["paperID":"arxiv:forged-owner","identity":"forged frontend target","material":["kind":"forged","fileCount":99999,"sha256":String(repeating:"f",count:64)]])
        let cloudFiles=await dav.allFiles(),chunks=cloudFiles.keys.filter{$0.hasSuffix(".bin")}.sorted(),uploaded=chunks.reduce(into:Data()){$0.append(cloudFiles[$1]!)}
        let uploadedPayload=try BackupCodec.parse(uploaded),uploadedPersonal=try JSONSerialization.jsonObject(with:uploadedPayload.files.first{$0.path=="personal.json"}!.data) as! [String:Any]
        try check(!(uploadedPersonal["jobs"] as! [[String:Any]]).contains{$0["command"] as? String=="cloud.upload"},"cloud upload freezes BackupCodec before creating and collecting its own job")
        try check((uploadApp.store.snapshot()["jobs"] as! [[String:Any]]).first{$0["command"] as? String=="cloud.upload"}?["status"] as? String=="complete" && !uploadApp.cloudBusy && uploadApp.jobs.isEmpty,"real upload only completes after local finalization and releases busy/job locks")
        try check(try uploadApp.cloudLocalStore().pending()==nil,"verified upload clears only original completed pending state")
        let actualUpload=(uploadApp.store.snapshot()["jobs"] as! [[String:Any]]).first{$0["command"] as? String=="cloud.upload"}!,actualProfile=try uploadApp.cloudLocalStore().profile
        let originalPendingProof=captured.pending[actualProfile.destinationID]!,taskMaterial=actualUpload["material"] as! [String:Any]
        try check(actualUpload["paperID"] as? String=="" && actualUpload["identity"] as? String=="坚果云 · fixture@example.invalid / PaperDigestFixture" && actualUpload["cloudDestinationID"] as? String==actualProfile.destinationID.uuidString,"cloud task identity is actual device destination and never unrelated foreground paper or frontend identity")
        try check(taskMaterial["kind"] as? String=="workspace-snapshot" && taskMaterial["createdAt"] as? String==originalPendingProof.createdAt && taskMaterial["fileCount"] as? Int==uploadedPayload.files.count,"cloud task material is exact verified original pending collection time and actual file count")
        try check(taskMaterial["sha256"] as? String==PrivateStoragePaths.sha256(uploaded) && taskMaterial["sha256"] as? String==originalPendingProof.sha256,"cloud upload material binds original encoded snapshot bytes rather than current paper or frontend fields")
        let busyApp=try makeApp("upload-busy"),busyDAV=IntegrationDAV();busyApp.cloudArchive=try service(busyApp,busyDAV)
        busyApp.jobs["other-job"]=Task{try await Task.sleep(nanoseconds:60_000_000_000);return [:]}
        try await rejected("new cloud freeze rejects other active work before collecting"){_=try await busyApp.dispatchCloud("cloud.upload",payload:[:])}
        let busyRequests=await busyDAV.records()
        try check(try busyApp.cloudLocalStore().pending()==nil && busyRequests.allSatisfy{$0.hasPrefix("PROPFIND ")} && !busyApp.maintenanceBusy && !busyApp.cloudBusy,"busy upload may preflight but sends no remote writes and leaves no pending or maintenance lock")
        busyApp.jobs["other-job"]?.cancel();busyApp.jobs.removeAll()

        let badAccount=try makeApp("bad-account"),badAccountDAV=IntegrationDAV();badAccount.cloudArchive=try service(badAccount,badAccountDAV);await badAccountDAV.denyCredentials()
        try await rejected("wrong account preflight fails before immutable snapshot is prepared"){_=try await badAccount.dispatchCloud("cloud.upload",payload:[:])}
        let oldBadID=try badAccount.cloudLocalStore().profile.destinationID
        try check(try badAccount.cloudLocalStore().pending()==nil && !badAccount.cloudBusy && !badAccount.maintenanceBusy,"authentication preflight failure leaves account recoverable without a locked pending snapshot")
        try badAccount.cloudLocalStore().save(account:"corrected-fixture@example.invalid",folder:"PaperDigestFixture",automatic:false,intervalHours:24)
        try check(try badAccount.cloudLocalStore().profile.destinationID != oldBadID,"actual preflight authentication failure permits correcting the account")

        let headerApp=try makeApp("wrong-header"),headerDAV=IntegrationDAV();headerApp.cloudArchive=try service(headerApp,headerDAV)
        let headerLocal=try headerApp.cloudLocalStore(),header=try headerLocal.prepare(BackupCodec.collect(sourceDirectory:headerApp.directory)),headerFile=headerLocal.root.appendingPathComponent(headerLocal.profile.destinationID.uuidString+"/pending.json")
        var headerObject=try JSONSerialization.jsonObject(with:Data(contentsOf:headerFile)) as! [String:Any];headerObject["fileCount"]=header.fileCount+1;try canonical(headerObject).write(to:headerFile)
        try await rejected("self-reported file count cannot become a cloud upload material proof"){_=try await headerApp.dispatch("cloud.upload",payload:[:])}
        let headerRequests=await headerDAV.count()
        try check(headerRequests==0 && !(headerApp.store.snapshot()["jobs"] as! [[String:Any]]).contains{$0["command"] as? String=="cloud.upload"},"invalid pending header is rejected before upload job proof or transport")

        // Reuse the actual isolated uploaded bytes through service.download and
        // the real shared restore confirmation; no synthetic download success.
        let remote=try XCTFindManifest(cloudFiles),restoreApp=try makeApp("restore"),restoreDAV=IntegrationDAV()
        restoreApp.cloudArchive=try service(restoreApp,restoreDAV)
        for (path,data) in cloudFiles{await restoreDAV.install(path,data)}
        try note(restoreApp.store,"newer-live-note")
        try restoreApp.store.updateSettings(localSettings)
        try restoreApp.store.appendSession(issued("after-snapshot-issued",today+"T04:00:00Z"))
        let rawFee=Data("explicit immutable local usage fixture; amount unknown".utf8),feeDirectory=restoreApp.directory.appendingPathComponent("ModelUsage")
        try fm.createDirectory(at:feeDirectory,withIntermediateDirectories:true);try rawFee.write(to:feeDirectory.appendingPathComponent("fixture-original-event.txt"))
        let beforeRestorePersonal=try Data(contentsOf:restoreApp.directory.appendingPathComponent("personal.json"))
        var firstRestoreError:Error?
        let restoring=Task{@MainActor in do{return try await restoreApp.dispatchCloud("cloud.restore",payload:["month":remote.month,"id":remote.id.uuidString])}catch{firstRestoreError=error;throw error}}
        try await wait("own restore confirmation"){if let error=firstRestoreError{throw error};return restoreApp.window.attachedSheet != nil}
        let restoreJobID=restoreApp.cloudActiveJobID!
        try check(restoreApp.maintenanceBusy && restoreApp.jobs.keys.allSatisfy{$0==restoreJobID},"downloaded restore enters maintenance with only its own job")
        try check((restoreApp.store.snapshot()["jobs"] as! [[String:Any]]).first{$0["id"] as? String==restoreJobID}?["status"] as? String=="running","download completion is not reported as restore success while confirmation pending")
        restoreApp.window.endSheet(restoreApp.window.attachedSheet!,returnCode:.alertSecondButtonReturn)
        try await rejected("actual own native restore confirmation can cancel"){_=try await restoring.value}
        try check((restoreApp.store.snapshot()["notes"] as! [String:[String:Any]])["fixture-paper"]?["text"] as? String=="newer-live-note" && !restoreApp.maintenanceBusy && !restoreApp.cloudBusy && restoreApp.jobs.isEmpty,"cancelled cloud restore preserves latest note and releases own maintenance/job flags")
        try check((restoreApp.store.snapshot()["jobs"] as! [[String:Any]]).first{$0["id"] as? String==restoreJobID}?["status"] as? String=="cancelled","cancelled restore task reaches cancelled rather than download-complete")
        var secondRestoreError:Error?
        let restoreAgain=Task{@MainActor in do{return try await restoreApp.dispatchCloud("cloud.restore",payload:["month":remote.month,"id":remote.id.uuidString])}catch{secondRestoreError=error;throw error}}
        try await wait("own successful restore confirmation"){if let error=secondRestoreError{throw error};return restoreApp.window.attachedSheet != nil}
        let successJobID=restoreApp.cloudActiveJobID!
        restoreApp.window.endSheet(restoreApp.window.attachedSheet!,returnCode:.alertFirstButtonReturn)
        _=try await restoreAgain.value
        try check((restoreApp.store.snapshot()["notes"] as! [String:[String:Any]])["fixture-paper"]?["text"] as? String=="upload-note","actual confirmed cloud restore installs original research note")
        try check((restoreApp.store.snapshot()["jobs"] as! [[String:Any]]).first{$0["id"] as? String==successJobID}?["status"] as? String=="complete" && restoreApp.jobs.isEmpty && !restoreApp.maintenanceBusy && !restoreApp.cloudBusy,"restore success job is persisted only after real restore commit and job cleanup")
        let restoredTask=(restoreApp.store.snapshot()["jobs"] as! [[String:Any]]).first{$0["id"] as? String==successJobID}!
        try check((restoredTask["result"] as? [String:Any])?["sha256"] as? String==PrivateStoragePaths.sha256(uploaded),"successful cloud restore task records exact original downloaded encoded material SHA")
        try check((restoredTask["result"] as? [String:Any])?["sha256"] as? String != PrivateStoragePaths.sha256(try bytes(restoreApp.directory)),"restore material SHA is original source rather than reserialized effective live space")
        let preserved=try fm.contentsOfDirectory(at:root,includingPropertiesForKeys:nil).filter{$0.lastPathComponent.hasPrefix("PaperDigest-before-restore-")}
        try check(preserved.contains{(try? Data(contentsOf:$0.appendingPathComponent("personal.json"))) != nil},"actual restore keeps a recovery-before directory with original personal bytes")
        let restoredSettings=restoreApp.store.snapshot()["settings"] as! [String:Any]
        try check(restoredSettings["endpoint"] as? String==localSettings["endpoint"] as? String && restoredSettings["dailyRequests"] as? Int==2,"cloud restore uses same local endpoint and budget protection as file restore")
        let preservedNotes=try preserved.map{try JSONSerialization.jsonObject(with:Data(contentsOf:$0.appendingPathComponent("personal.json"))) as! [String:Any]}
        try check(preservedNotes.contains{($0["notes"] as? [String:[String:Any]])?["fixture-paper"]?["text"] as? String=="newer-live-note"},"snapshot-after notes remain recoverable in untouched before-restore personal record")
        try check(preserved.contains{(try? Data(contentsOf:$0.appendingPathComponent("ModelUsage/fixture-original-event.txt")))==rawFee},"original post-snapshot raw usage is preserved unchanged in before-restore copy")
        try check(try RequestBudgetContinuity.count(on:today,directory:restoreApp.directory,sessions:restoreApp.store.snapshot()["sessions"] as! [[String:Any]])==1,"actual committed cloud restore retains issued request floor despite older snapshot sessions")
        try check(try restoreApp.cloudLocalStore().profile.account=="fixture@example.invalid","shared restore cannot overwrite current device cloud destination with snapshot settings")

        let failedApp=try makeApp("failed-restore"),failedDAV=IntegrationDAV();failedApp.cloudArchive=try service(failedApp,failedDAV);await failedDAV.failDownloads();try note(failedApp.store,"unchanged-on-download-failure")
        try await rejected("failed actual download cannot create restore success"){_=try await failedApp.dispatchCloud("cloud.restore",payload:["month":remote.month,"id":remote.id.uuidString])}
        try check((failedApp.store.snapshot()["jobs"] as! [[String:Any]]).first{$0["command"] as? String=="cloud.restore"}?["status"] as? String=="failed" && !failedApp.cloudBusy && !failedApp.maintenanceBusy && failedApp.jobs.isEmpty && failedApp.window.attachedSheet==nil,"download failure stays failed without maintenance or a confirmation sheet")
        try check((failedApp.store.snapshot()["notes"] as! [String:[String:Any]])["fixture-paper"]?["text"] as? String=="unchanged-on-download-failure","failed download leaves live note unchanged")

        let concurrent=try makeApp("concurrent-restore"),concurrentDAV=IntegrationDAV();concurrent.cloudArchive=try service(concurrent,concurrentDAV);for(path,data) in cloudFiles{await concurrentDAV.install(path,data)}
        try note(concurrent.store,"protected-by-other-job");concurrent.jobs["other"]=Task{try await Task.sleep(nanoseconds:60_000_000_000);return [:]}
        try await rejected("downloaded restore refuses commit while another real job remains"){_=try await concurrent.dispatchCloud("cloud.restore",payload:["month":remote.month,"id":remote.id.uuidString])}
        try check(Set(concurrent.jobs.keys)==Set(["other"]),"restore rejection does not consume the unrelated task")
        try check(!concurrent.maintenanceBusy && !concurrent.cloudBusy && concurrent.window.attachedSheet==nil && (concurrent.store.snapshot()["notes"] as! [String:[String:Any]])["fixture-paper"]?["text"] as? String=="protected-by-other-job","other-job rejection is atomic before native confirmation and live replacement")
        concurrent.jobs["other"]?.cancel();concurrent.jobs.removeAll()

        let corruptApp=try makeApp("corrupt-floor-restore"),corruptDAV=IntegrationDAV();corruptApp.cloudArchive=try service(corruptApp,corruptDAV);for(path,data) in cloudFiles{await corruptDAV.install(path,data)}
        try note(corruptApp.store,"protected-corrupt-floor");try Data("bad continuity fixture".utf8).write(to:corruptApp.directory.appendingPathComponent(RequestBudgetContinuity.filename))
        try await rejected("corrupt original floor blocks actual cloud commit"){_=try await corruptApp.dispatchCloud("cloud.restore",payload:["month":remote.month,"id":remote.id.uuidString])}
        try check(!corruptApp.maintenanceBusy && !corruptApp.cloudBusy && corruptApp.window.attachedSheet==nil && (corruptApp.store.snapshot()["notes"] as! [String:[String:Any]])["fixture-paper"]?["text"] as? String=="protected-corrupt-floor","corrupt-floor restore failure leaves live research and releases maintenance")

        // Real production settings HTML/modules and native IPC, never the
        // installed application. Every possible Zotero request is intercepted;
        // credential methods explicitly throw instead of consulting Keychain.
        let settingsApp=try makeApp("settings-link"),settingsDAV=IntegrationDAV();settingsApp.cloudArchive=try service(settingsApp,settingsDAV)
        let isolated=URLSessionConfiguration.ephemeral;isolated.protocolClasses=[IntegrationOfflineProtocol.self]
        settingsApp.zotero=ZoteroService(dataDirectory:settingsApp.directory,session:URLSession(configuration:isolated),credentialStore:IntegrationNoCredentials())
        var settingsKeyReads=0;settingsApp.model=ModelService(directory:settingsApp.directory,store:settingsApp.store,keyProvider:{settingsKeyReads+=1;throw DesktopError.message("Settings fixture forbids model credentials")})
        let publicRepo=URL(fileURLWithPath:fm.currentDirectoryPath),webRoot=try folder("settings-web")
        let sourceWeb=publicRepo.appendingPathComponent("apps/macos/Resources")
        for file in try fm.contentsOfDirectory(at:sourceWeb,includingPropertiesForKeys:nil){try fm.copyItem(at:file,to:webRoot.appendingPathComponent(file.lastPathComponent))}
        let vendor=webRoot.appendingPathComponent("vendor");try fm.createDirectory(at:vendor,withIntermediateDirectories:true)
        for name in ["marked.esm.js","lucide.min.js"]{try fm.copyItem(at:publicRepo.appendingPathComponent("prototypes/macos-research/vendor/"+name),to:vendor.appendingPathComponent(name))}
        try fm.copyItem(at:publicRepo.appendingPathComponent("apps/macos/node_modules/katex/dist"),to:vendor.appendingPathComponent("katex"))
        settingsApp.scheme=BundleScheme(root:webRoot)
        let mainWK=WKWebView(frame:settingsApp.window.contentView!.bounds);settingsApp.web=mainWK;settingsApp.window.contentView=mainWK
        mainWK.loadHTMLString("<html><body>Isolated settings owner<script>window.paperDigestFlushPendingNote=async()=>({saved:true});</script></body></html>",baseURL:nil)
        try await wait("isolated settings main flush"){(try? await mainWK.evaluateJavaScript("typeof paperDigestFlushPendingNote==='function'")) as? Bool==true}
        _=try await settingsApp.dispatch("settings.open",payload:["pane":"cloud"]);settingsApp.settingsWindow?.alphaValue=0
        do{try await wait("first actual settings cloud navigation"){
            guard let view=settingsApp.settingsWeb else{return false}
            return (try? await view.evaluateJavaScript("!!document.querySelector('#cloud-account') && document.querySelector('[data-pane=cloud]').getAttribute('aria-current')==='page'")) as? Bool==true && settingsApp.settingsPaneRequest==nil
        }}catch{
            if let view=settingsApp.settingsWeb{let state=try? await view.evaluateJavaScript("JSON.stringify({ready:document.readyState,hook:typeof paperDigestShowSettingsPane,account:!!document.querySelector('#cloud-account'),selected:document.querySelector('[data-pane][aria-current=page]')?.dataset.pane,toast:document.querySelector('#toast')?.textContent})");print("ISOLATED_SETTINGS_DIAGNOSTIC \(String(describing:state)) request=\(String(describing:settingsApp.settingsPaneRequest)) loading=\(view.isLoading) url=\(String(describing:view.url))")};throw error
        }
        guard let realSettings=settingsApp.settingsWeb,let realSettingsWindow=settingsApp.settingsWindow else{throw DesktopError.message("Actual settings window missing")}
        try check(realSettings.url?.absoluteString=="paperapp://app/settings.html","first settings deep link loads actual production settings document and selects cloud")
        _=try await realSettings.evaluateJavaScript("window.__retainedDraftInput=document.querySelector('#cloud-account');window.__retainedDraftInput.value='unsaved-draft@example.invalid';window.__retainedDraftInput.dispatchEvent(new Event('input',{bubbles:true}));window.__retainedDraftSentinel='retained-without-reload';true")
        for pane in ["reading","model","zotero","storage","cloud"] {
            _=try await settingsApp.dispatch("settings.open",payload:["pane":pane]);settingsApp.settingsWindow?.alphaValue=0
            try await wait("native existing settings pane "+pane){
                let selected=try await realSettings.callAsyncJavaScript("return document.querySelector('[data-pane=\"'+pane+'\"]')?.getAttribute('aria-current')==='page'",arguments:["pane":pane],in:nil,contentWorld:.page)
                return selected as? Bool==true && settingsApp.settingsPaneRequest==nil
            }
            try check(settingsApp.settingsWindow===realSettingsWindow && settingsApp.settingsWeb===realSettings,"settings "+pane+" reuses exact existing native window and WK without reload")
        }
        try check((try await realSettings.evaluateJavaScript("window.__retainedDraftInput===document.querySelector('#cloud-account') && __retainedDraftInput.value==='unsaved-draft@example.invalid' && __retainedDraftSentinel==='retained-without-reload'")) as? Bool==true,"all native deep links retain original cloud input node and its unsaved draft")
        try check(try settingsApp.cloudLocalStore().profile.account=="fixture@example.invalid","deep-link navigation never commits unsaved cloud connection draft")
        for payload:[String:Any] in [["pane":"unknown"],["pane":7],["pane":NSNull()]] {
            try await rejected("native settings.open refuses unknown or nonstring pane"){_=try await settingsApp.dispatch("settings.open",payload:payload)}
        }
        try check((try await realSettings.evaluateJavaScript("paperDigestShowSettingsPane('unknown')===false && document.querySelector('[data-pane=cloud]').getAttribute('aria-current')==='page'")) as? Bool==true,"production JS pane hook rejects unknown target without changing selected pane")

        // Real WK promise returns delay ONLY the completion of the actual sync
        // production click. Native IPC order is not replaced or fabricated.
        _=try await realSettings.evaluateJavaScript("window.__originalPaneHook=paperDigestShowSettingsPane;window.__paneHolds=[];window.paperDigestShowSettingsPane=pane=>{const applied=__originalPaneHook(pane);let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});__paneHolds.push({pane,applied,promise,resolve,reject});return promise;};true")
        var requestIDs:[UUID]=[]
        for (index,pane) in ["cloud","model","cloud"].enumerated(){
            _=try await settingsApp.dispatch("settings.open",payload:["pane":pane]);settingsApp.settingsWindow?.alphaValue=0
            try await wait("actual WK held settings completion"){(try await realSettings.evaluateJavaScript("__paneHolds.length")) as? Int==index+1}
            requestIDs.append(settingsApp.settingsPaneRequestID)
        }
        try check(Set(requestIDs).count==3,"cloud model cloud ABA uses distinct native request identities despite repeated target")
        _=try await realSettings.evaluateJavaScript("__paneHolds[0].resolve(__paneHolds[0].applied);true")
        _=try await realSettings.callAsyncJavaScript("return await __paneHolds[0].promise",arguments:[:],in:nil,contentWorld:.page)
        try await Task.sleep(nanoseconds:80_000_000)
        try check(settingsApp.settingsPaneRequest=="cloud" && settingsApp.settingsPaneRequestID==requestIDs[2],"actual old cloud WK completion cannot clear new cloud request after ABA")
        _=try await realSettings.evaluateJavaScript("__paneHolds[1].resolve(__paneHolds[1].applied);true")
        _=try await realSettings.callAsyncJavaScript("return await __paneHolds[1].promise",arguments:[:],in:nil,contentWorld:.page)
        try await Task.sleep(nanoseconds:80_000_000)
        try check(settingsApp.settingsPaneRequest=="cloud" && settingsApp.settingsPaneRequestID==requestIDs[2],"actual intermediate model callback cannot consume pending final cloud request")
        _=try await realSettings.evaluateJavaScript("__paneHolds[2].resolve(__paneHolds[2].applied);true")
        try await wait("current actual settings completion clears own request"){settingsApp.settingsPaneRequest==nil}
        try check((try await realSettings.evaluateJavaScript("document.querySelector('[data-pane=cloud]').getAttribute('aria-current')==='page' && __retainedDraftInput===document.querySelector('#cloud-account') && __retainedDraftInput.value==='unsaved-draft@example.invalid'")) as? Bool==true,"latest real WK cloud request completes while original draft node and actual selected pane remain intact")
        _=try await settingsApp.dispatch("settings.open",payload:["pane":"model"]);settingsApp.settingsWindow?.alphaValue=0
        try await wait("old WK held before replacement"){(try await realSettings.evaluateJavaScript("__paneHolds.length")) as? Int==4}
        let oldViewRequestID=settingsApp.settingsPaneRequestID,replacement=WKWebView(frame:.zero)
        settingsApp.settingsWeb=replacement
        _=try await realSettings.evaluateJavaScript("__paneHolds[3].resolve(__paneHolds[3].applied);true")
        _=try await realSettings.callAsyncJavaScript("return await __paneHolds[3].promise",arguments:[:],in:nil,contentWorld:.page)
        try await Task.sleep(nanoseconds:80_000_000)
        try check(settingsApp.settingsWeb===replacement && settingsApp.settingsPaneRequest=="model" && settingsApp.settingsPaneRequestID==oldViewRequestID,"actual old WK completion cannot consume a pending request now owned by replacement WK")
        settingsApp.settingsWeb=realSettings;settingsApp.settingsPaneRequest=nil
        _=try await realSettings.evaluateJavaScript("window.paperDigestShowSettingsPane=__originalPaneHook;true")
        let settingsRequests=await settingsDAV.count()
        try check(settingsKeyReads==0 && settingsRequests==0,"real settings bootstrap and deep links issue no model credential read or cloud transport request")

        // Exercise the real WK -> native job -> typed cancellation -> cloud UI path.
        // A service error containing a cancellation word remains an ordinary failure.
        _=try await settingsApp.dispatch("settings.open",payload:["pane":"cloud"]);settingsApp.settingsWindow?.alphaValue=0
        try await wait("cloud pane for cancellation presentation"){(try? await realSettings.evaluateJavaScript("document.querySelector('[data-pane=cloud]').getAttribute('aria-current')==='page'")) as? Bool==true}
        _=try await realSettings.evaluateJavaScript("document.querySelector('#cloud-discard').click();true")
        try await wait("cancel fixture destination draft discarded"){(try? await realSettings.evaluateJavaScript("!document.querySelector('#cloud-check').disabled")) as? Bool==true}
        let cancelProfile=try settingsApp.cloudLocalStore().profile
        settingsApp.cloudArchive=try CloudArchiveService(folder:cancelProfile.folder,destinationID:cancelProfile.destinationID,
            credentials:{.init(username:"fixture@example.invalid",password:"in-memory-cancel-fixture")},checkpointSink:{_ in},
            transport:{_,_ in throw CancellationError()},minimumRequestInterval:0)
        _=try await realSettings.evaluateJavaScript("document.querySelector('#cloud-check').click();true")
        try await wait("actual WK receives cancelled job result"){
            (try? await realSettings.evaluateJavaScript("!document.querySelector('#cloud-check').disabled && (document.querySelector('#cloud-message').textContent.includes('已取消') || !!document.querySelector('#cloud-error').textContent)")) as? Bool==true
        }
        try check((try await realSettings.evaluateJavaScript("document.querySelector('#cloud-error').textContent==='' && document.querySelector('#cloud-message').textContent.includes('已取消')")) as? Bool==true,"actual native cancellation is a readable status, not Swift framework error or completed backup")
        let cancelledCloudJobs=(settingsApp.store.snapshot()["jobs"] as! [[String:Any]]).filter{$0["command"] as? String=="cloud.check" && $0["status"] as? String=="cancelled"}
        try check(cancelledCloudJobs.count==1 && !(cancelledCloudJobs[0]["message"] as? String ?? "").contains("Swift.CancellationError"),"actual cancelled job preserves its cancelled state with a human-readable task message")
        try check(settingsApp.cloudLastError==nil && settingsApp.jobs.isEmpty && !settingsApp.cloudBusy,"cancelled request leaves no persistent cloud error or active native job")
        settingsApp.cloudArchive=try CloudArchiveService(folder:cancelProfile.folder,destinationID:cancelProfile.destinationID,
            credentials:{.init(username:"fixture@example.invalid",password:"in-memory-cancel-fixture")},checkpointSink:{_ in},
            transport:{_,_ in throw DesktopError.message("cancelled appears in a real fixture service failure")},minimumRequestInterval:0)
        _=try await realSettings.evaluateJavaScript("document.querySelector('#cloud-check').click();true")
        try await wait("actual WK receives ordinary service failure"){
            (try? await realSettings.evaluateJavaScript("!document.querySelector('#cloud-check').disabled && !!document.querySelector('#cloud-error').textContent")) as? Bool==true
        }
        let serviceFailureText=try await realSettings.evaluateJavaScript("document.querySelector('#cloud-error').textContent") as? String
        let ordinaryFailureHasNoOutcome=(try await realSettings.evaluateJavaScript("document.querySelector('#cloud-message').textContent===''") as? Bool)==true
        try check(serviceFailureText==CloudArchiveService.CloudError.transport.localizedDescription && ordinaryFailureHasNoOutcome,"ordinary service failure remains an error while private provider text stays redacted")
        try check((settingsApp.store.snapshot()["jobs"] as! [[String:Any]]).contains{$0["command"] as? String=="cloud.check" && $0["status"] as? String=="failed"},"ordinary service failure remains a failed job")
        try check(PaperDigestApp.cloudCancellationReply(DesktopError.message("cancelled appears in an ordinary failure"),command:"cloud.check")==nil,"ordinary error words cannot grant a native cancellation outcome")
        try check(PaperDigestApp.cloudCancellationReply(CancellationError(),command:"model.run")==nil,"cloud cancellation presentation cannot change a non-cloud command protocol")
        _=beforeRestorePersonal // Exact original research material is retained; jobs legitimately advance.
        print("Cloud integration review: \(passed) passed; 0 failed; temporary sources only; no real credentials/network")
    }
    static func XCTFindManifest(_ files:[String:Data])throws->CloudArchiveService.SnapshotReference{
        guard let raw=files.first(where:{$0.key.hasSuffix("manifest.json")})?.value,let value=try JSONSerialization.jsonObject(with:raw) as? [String:Any],let reference=value["reference"] as? [String:Any],let month=reference["month"] as? String,let id=(reference["id"] as? String).flatMap(UUID.init(uuidString:)) else{throw DesktopError.message("Isolated actual upload manifest missing")}
        return .init(month:month,id:id)
    }
}

private extension IntegrationDAV {
    func install(_ path:String,_ bytes:Data){files[path]=bytes}
}
