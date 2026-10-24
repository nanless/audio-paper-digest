// Independent provenance tests use actual PDFKit text and an isolated temporary store.
// No app windows, Keychain, provider request, Zotero or production state is accessed.
import AppKit
import PDFKit
import Foundation
import Darwin

private struct ProvenanceReviewFailure: Error, LocalizedError {
    let message:String
    var errorDescription:String?{message}
}
@main struct DesktopProvenanceReviewTests {
    @MainActor static func main() async throws {
        _=NSApplication.shared
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("IndependentProvenance-"+UUID().uuidString)
        defer{try? FileManager.default.removeItem(at:directory)}
        let app=PaperDigestApp();app.directory=directory;app.store=try DesktopStore(directory:directory)
        let data=try Data(contentsOf:URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf")),hash=sha256(data)
        guard let document=PDFDocument(data:data),let page=document.page(at:0),let text=page.string,let selection=page.selection(for:NSRange(location:0,length:min(160,(text as NSString).length))) else{throw ProvenanceReviewFailure(message:"Actual PDFKit selection unavailable")}
        let owner="arxiv:2610.27491",version="2610.27491v1",revision=sha256(Data("explicit isolated guide fixture".utf8))
        app.currentPaperID=owner;app.currentPaper=["id":owner,"sourceVersion":version];app.pdfOwner=owner;app.pdfVersion=version;app.currentPDFSHA=hash;app.pdfView.document=document
        let history:[String:Any]=["id":"explicit-isolated-history-fixture","paperID":owner,"status":"failed","source":["pdfSHA":hash,"pages":[7],"isStale":false],"charge":"unknown","question":"Preserve original historical metadata"]
        try app.store.appendSession(history)
        let original=try Data(contentsOf:directory.appendingPathComponent("personal.json")),originalMemory=try JSONSerialization.data(withJSONObject:app.store.snapshot(),options:.sortedKeys)
        var passed=0,failures:[String]=[]
        func check(_ name:String,_ action:()throws->Void){do{try action();passed+=1;print("PASS "+name)}catch{failures.append(name+": "+error.localizedDescription);print("FAIL "+name+": "+error.localizedDescription)}}
        func require(_ condition:Bool,_ message:String)throws{if !condition{throw ProvenanceReviewFailure(message:message)}}
        func reject(_ action:()throws->Void)throws{do{try action()}catch{return};throw ProvenanceReviewFailure(message:"Expected source refusal")}
        let fresh:[String:Any]=["currentness":"bounded-revalidation","isStale":false,"cacheStatus":"current","validatedAt":"2026-10-24T04:00:00Z","notices":["Explicit successful receipt fixture"],"offlineMode":false]
        app.currentPDFReceipt=fresh;app.pdfView.setCurrentSelection(selection,animate:false);app.pdfSelectionChanged()
        check("real selection keeps complete actual text, paper, physical page, SHA and version"){
            let source=try app.modelSource(["scope":"selection"])
            try require(source["text"] as? String==selection.string && source["paperID"] as? String==owner && source["pdfSHA"] as? String==hash && source["sourceVersion"] as? String==version && source["pages"] as? [Int]==[1],"Selection ownership or bytes changed")
        }
        check("selection carries current verified receipt without inventing unknown state"){
            let source=try app.modelSource(["scope":"selection"])
            for key in ["currentness","isStale","cacheStatus","validatedAt","notices","offlineMode"]{
                try require(NSDictionary(dictionary:["value":source[key] as Any]).isEqual(to:["value":fresh[key] as Any]),"Receipt field lost: "+key)
            }
        }
        let stale:[String:Any]=["currentness":"unverified-cache","isStale":true,"cacheStatus":"stale","validatedAt":"2026-10-20T01:00:00Z","notices":["Explicit failed revalidation fixture"],"offlineMode":false]
        app.currentPDFReceipt=stale // Do not trigger a new selection event: the cached selection predates this receipt.
        check("same selected bytes reflect later stale receipt, not old selection-event flags"){
            let source=try app.modelSource(["scope":"selection"])
            try require(source["isStale"] as? Bool==true && source["currentness"] as? String=="unverified-cache" && source["notices"] as? [String]==stale["notices"] as? [String] && source["validatedAt"] as? String==stale["validatedAt"] as? String,"Stale source metadata was omitted or cached")
            try require(source["text"] as? String==selection.string,"Revalidation altered selected original evidence")
        }
        check("stale receipt never bypasses selected paper ownership"){
            let previous=app.pdfOwner;defer{app.pdfOwner=previous};app.pdfOwner="arxiv:other"
            try reject{_=try app.modelSource(["scope":"selection"])}
        }
        app.currentArticle=["paperID":owner,"plainText":"Explicit isolated published guide fixture","sourceURL":"https://example.org/published/","sourceVersion":version,"revisionSHA256":revision,"isStale":false,"offlineMode":false,"cacheStatus":"current","notices":["Current guide fixture"],"fetchedAt":"2026-10-24T04:00:00Z"]
        check("guide preserves actual revision, source version and current metadata"){
            let source=try app.modelSource(["scope":"guide"])
            try require(source["revision"] as? String==revision && source["sourceVersion"] as? String==version && source["isStale"] as? Bool==false && source["offlineMode"] as? Bool==false && source["notices"] as? [String]==["Current guide fixture"] && source["fetchedAt"] as? String=="2026-10-24T04:00:00Z","Current guide provenance missing")
        }
        app.currentArticle["isStale"]=true;app.currentArticle["offlineMode"]=true;app.currentArticle["cacheStatus"]="offline";app.currentArticle["notices"]=["Old saved revision; website freshness unverified"]
        check("old offline guide exposes stale/offline/source version to actual request input"){
            let source=try app.modelSource(["scope":"guide"])
            try require(source["isStale"] as? Bool==true && source["offlineMode"] as? Bool==true && source["cacheStatus"] as? String=="offline" && source["sourceVersion"] as? String==version && source["notices"] as? [String]==["Old saved revision; website freshness unverified"],"Old offline guide masquerades current")
        }
        check("offline guide still rejects mismatched paper"){
            let old=app.currentArticle;defer{app.currentArticle=old};app.currentArticle["paperID"]="arxiv:other"
            try reject{_=try app.modelSource(["scope":"guide"])}
        }
        app.currentArticle["offlineMode"]=false;app.currentPDFReceipt=stale;app.pdfView.go(to:page)
        for scope in ["page","range","full"]{
            check(scope+" shares receipt fields without silently treating stale PDF as current"){
                let source=try app.modelSource(["scope":scope,"from":1,"to":1])
                try require(source["isStale"] as? Bool==true && source["currentness"] as? String=="unverified-cache" && source["validatedAt"] as? String==stale["validatedAt"] as? String && source["notices"] as? [String]==stale["notices"] as? [String],"PDF scope lost actual receipt")
            }
        }
        app.currentPDFReceipt=["offlineMode":true,"currentness":"offline-snapshot","isStale":false]
        check("PDF evidence offline status comes from loaded PDF receipt, independently of refreshed guide"){
            let source=try app.modelSource(["scope":"range","from":1,"to":1])
            try require(source["offlineMode"] as? Bool==true,"Actual offline PDF incorrectly inherited refreshed guide's online flag")
        }
        check("source extraction leaves original history, fees and personal file byte-for-byte unchanged"){
            try require(try Data(contentsOf:directory.appendingPathComponent("personal.json"))==original,"Original personal file changed")
            try require(try JSONSerialization.data(withJSONObject:app.store.snapshot(),options:.sortedKeys)==originalMemory,"Original history or fee metadata changed")
            try require(app.jobs.isEmpty,"Provenance extraction created a request job")
        }
        check("older personal store without retained-paper index remains valid"){
            try DesktopStore.validate(app.store.snapshot())
        }
        let malformedPapers:[Any]=[
            [] as [Any],
            [owner:["id":"arxiv:different","title":"Explicit fixture","sourceKind":"arxiv"]],
            [owner:["id":owner,"title":42,"sourceKind":"arxiv"]],
            ["local:"+hash:["id":"local:"+hash,"title":"Explicit local fixture","sourceKind":"local","localPDFPath":"relative/file.pdf","pdfSHA":hash]],
            [owner:["id":owner,"title":"Explicit fixture","sourceKind":"arxiv","authors":[42]]]
        ]
        for(index,bad) in malformedPapers.enumerated(){
            check("malformed retained-paper restore \(index+1) refuses before mutating existing history or file"){
                var candidate=app.store.snapshot();candidate["personalPapers"]=bad
                try reject{try app.store.restorePersonal(candidate)}
                try require(try Data(contentsOf:directory.appendingPathComponent("personal.json"))==original,"Rejected restore changed original file")
                try require(try JSONSerialization.data(withJSONObject:app.store.snapshot(),options:.sortedKeys)==originalMemory,"Rejected restore changed original memory")
            }
        }
        check("invalid newly remembered paper is rejected without swallowing the retained index"){
            try reject{try app.store.rememberPaper(["id":owner,"title":false,"sourceKind":"arxiv"])}
            try require(try Data(contentsOf:directory.appendingPathComponent("personal.json"))==original,"Rejected paper changed original file")
        }
        let uninitialized=PaperDigestApp()
        await uninitialized.finishJobsForTermination()
        check("shutdown safely handles uninitialized library and model"){
            try require(uninitialized.jobs.isEmpty,"Empty shutdown invented pending jobs")
        }
        var cancellationFinished=false
        let pending=Task<[String:Any],Error>{
            defer{cancellationFinished=true}
            try Task.checkCancellation()
            return [:]
        }
        uninitialized.jobs["explicit-isolated-shutdown-fixture"]=pending
        await uninitialized.finishJobsForTermination()
        check("partially initialized shutdown cancels and awaits pending tasks without model or library"){
            try require(pending.isCancelled,"Pending task was not cancelled")
            try require(cancellationFinished,"Shutdown returned before the pending task finished")
        }
        // Explicit fake operation results exercise native task accounting only.
        // They are not Zotero service responses and do not prove external archival.
        let jobApp=PaperDigestApp();jobApp.directory=directory.appendingPathComponent("fake-operation-jobs")
        jobApp.store=try DesktopStore(directory:jobApp.directory)
        let a="arxiv:2610.27491",b="arxiv:2610.99999"
        try jobApp.store.rememberPaper(["id":a,"title":"Explicit remembered paper A","sourceKind":"arxiv"])
        try jobApp.store.rememberPaper(["id":b,"title":"Explicit current paper B","sourceKind":"arxiv"])
        jobApp.currentPaperID=b;jobApp.currentPaper=["id":b,"title":"Explicit current paper B"]
        func job(_ id:String)->[String:Any]{(jobApp.store.snapshot()["jobs"] as? [[String:Any]])?.first{$0["id"] as? String==id} ?? [:]}
        let partialID="explicit-fake-partial-A-while-current-B"
        var initialPartial:[String:Any]=[:]
        _=try await jobApp.runJob("zotero.resume",payload:[:],identifier:partialID){_ in
            initialPartial=job(partialID)
            return ["identity":a+"v1","title":"Explicit fake operation paper A","status":"partial","archiveID":"explicit-fake-no-zotero","retryable":true]
        }
        check("fake Zotero pending task never borrows unrelated current paper B"){
            try require(initialPartial["paperID"] as? String=="" && initialPartial["title"] as? String=="继续 Zotero 归档","Pending row borrowed B identity or title")
        }
        check("fake partial result A maps verified result identity to remembered base A while B stays current"){
            let row=job(partialID)
            try require(row["paperID"] as? String==a && row["identity"] as? String==a+"v1" && row["title"] as? String=="Explicit fake operation paper A" && row["status"] as? String=="partial","Partial row identity did not come from explicit result")
            try require(jobApp.currentPaperID==b && jobApp.currentPaper["title"] as? String=="Explicit current paper B","Task result changed current B context")
        }
        let unknownID="explicit-fake-unremembered-result"
        _=try await jobApp.runJob("zotero.archive",payload:[:],identifier:unknownID){_ in
            ["identity":"arxiv:2610.00001v2","title":"Explicit fake unremembered result","status":"complete"]
        }
        check("fake unknown complete result stays unlinked instead of attributing it to current B"){
            let row=job(unknownID)
            try require(row["paperID"] as? String=="" && row["title"] as? String=="Explicit fake unremembered result" && row["status"] as? String=="complete","Unknown result falsely mapped to current B")
        }
        let failedID="explicit-fake-failed-operation"
        do{_=try await jobApp.runJob("zotero.resume",payload:[:],identifier:failedID){_ in throw ProvenanceReviewFailure(message:"Explicit fake operation failure; no Zotero accessed")}}catch{}
        check("fake failed operation preserves generic unowned task, never unrelated current B"){
            let row=job(failedID)
            try require(row["paperID"] as? String=="" && row["title"] as? String=="继续 Zotero 归档" && row["status"] as? String=="failed" && row["identity"]==nil,"Failed task borrowed current paper identity")
            try require(jobApp.jobs.isEmpty,"Finished fake operation left running tasks")
        }
        print("Independent provenance review: \(passed) passed; \(failures.count) failed; real PDFKit, no windows, credentials, network or paid requests")
        if !failures.isEmpty{for failure in failures{FileHandle.standardError.write(Data((failure+"\n").utf8))};exit(1)}
    }
}
