// Actual offscreen AppKit sheet + production leaf WK + private temporary storage.
// No installed app/profile, Keychain, public network, model or Zotero calls.
import AppKit
import WebKit
import PDFKit
import Foundation

extension DesktopStorage {
    func isolatedDetailActorDelay(_ entered:@Sendable ()->Void) { entered();Thread.sleep(forTimeInterval:0.3) }
}
extension LibraryService {
    func isolatedStorageArticleDelay(){Thread.sleep(forTimeInterval:0.3)}
}
actor StorageDetailPublishedFixture {
    var entered=false
    var continuation:CheckedContinuation<Void,Never>?
    func read(_ url:URL) async throws ->Data {
        if url.path=="/blog/index.json" {
            let row:[String:Any]=["permalink":"/blog/posts/detail-context/","pageType":"paper","title":"Isolated detail context fixture","date":"2026-10-24","sourceKind":"arxiv","arxivId":"2601.00001","identityStatus":"verified","citation":["paperKey":"arxiv:2601.00001","title":"Isolated detail context fixture","authors":["Actual fixture author"],"arxivId":"2601.00001v1","sourceKind":"arxiv","sourceUrl":"https://arxiv.org/abs/2601.00001v1","pdfUrl":"https://arxiv.org/pdf/2601.00001v1.pdf","verified":true,"identityStatus":"verified","complete":false]]
            return try JSONSerialization.data(withJSONObject:[row],options:.sortedKeys)
        }
        if url.path.contains("/posts/detail-context") {
            entered=true;await withCheckedContinuation{continuation=$0}
            return Data("<html><body><div id='article-body' class='post-content'><h1>Isolated late old guide</h1><p>Actual transport fixture held until native sheet exists.</p></div></body></html>".utf8)
        }
        throw URLError(.fileDoesNotExist)
    }
    func release(){continuation?.resume();continuation=nil}
}

@main struct DesktopStorageDetailTests {
 @MainActor static func main() async throws {
    _=NSApplication.shared;NSApp.setActivationPolicy(.prohibited)
    let root=FileManager.default.temporaryDirectory.appendingPathComponent("DesktopStorageDetail-"+UUID().uuidString)
    try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
    defer{try? FileManager.default.removeItem(at:root)}
    let repo=URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
    let app=PaperDigestApp();app.directory=root;app.store=try DesktopStore(directory:root);app.storage=DesktopStorage(directory:root,store:app.store)
    app.scheme=BundleScheme(root:repo.appendingPathComponent("apps/macos/Resources"))
    app.window=NSWindow(contentRect:NSRect(x:0,y:0,width:1200,height:800),styleMask:[.titled,.closable],backing:.buffered,defer:false);app.window.alphaValue=0
    app.web=WKWebView(frame:app.window.contentView!.bounds);app.window.contentView=app.web;app.window.delegate=app
    app.web.loadHTMLString("<html><body><h1>Explicit isolated main reader</h1><script>window.offlineReceipts=[];window.flushReleases=[];window.holdMainFlush=false;window.addEventListener('storage.opened',e=>offlineReceipts.push(e.detail));window.paperDigestFlushPendingNote=async()=>{if(holdMainFlush)await new Promise(resolve=>flushReleases.push(resolve));return {saved:true};};window.paperDigestPauseForDetails=()=>({paused:true});window.handoffEntered=false;window.holdHandoff=false;window.failHandoff=false;window.rollbackCount=0;window.paperDigestInstallOfflineReceipt=async(receipt)=>{handoffEntered=true;if(holdHandoff)await new Promise(resolve=>window.releaseHandoff=resolve);if(failHandoff)throw new Error('Explicit isolated main WK handoff failure');offlineReceipts.push(receipt);return {installed:true,paperID:receipt.paper.id,offlinePackageID:receipt.paper.offlinePackageID};};window.paperDigestCancelOfflineReceipt=(id,current)=>{rollbackCount++;window.rollbackNativeOwner=current.paper.id;return {restored:true};};window.paperDigestFinishOfflineReceipt=()=>{};</script></body></html>",baseURL:nil)
    for _ in 0..<200 {if (try? await app.web.evaluateJavaScript("typeof paperDigestFlushPendingNote==='function'")) as? Bool==true{break};try await Task.sleep(nanoseconds:10_000_000)}
    app.currentPaperID="arxiv:2601.00001";app.currentPaper=["id":app.currentPaperID,"title":"Explicit original reader fixture","sourceKind":"arxiv"];app.contextGeneration=7
    var assertions=0
    func expect(_ condition:Bool,_ name:String)throws {guard condition else{throw DesktopError.message("FAIL "+name)};assertions+=1;print("PASS "+name)}
    func rejects(_ name:String,_ action:()async throws->Void)async throws {do{try await action()}catch{try expect(true,name);return};throw DesktopError.message("FAIL expected rejection: "+name)}
    func json(_ value:Any)throws->Data {try JSONSerialization.data(withJSONObject:value,options:.sortedKeys)}
    func put(_ name:String,_ data:Data)throws {let f=root.appendingPathComponent(name);try FileManager.default.createDirectory(at:f.deletingLastPathComponent(),withIntermediateDirectories:true);try data.write(to:f)}
    let originalPDF=try Data(contentsOf:repo.appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf")),pdfSHA=sha256(originalPDF)
    try expect(PDFDocument(data:originalPDF)?.pageCount==13,"public fixture is an actual thirteen-page PDF")
    let owner="arxiv:2610.27491",source="https://arxiv.org/abs/2610.27491v1",pdfURL="https://arxiv.org/pdf/2610.27491v1.pdf",blog="https://fixture.invalid/published/micla/"
    let paper:[String:Any]=["id":owner,"title":"MiCLA public PDF with isolated native guide fixture","sourceKind":"arxiv","sourceURL":source,"blogURL":blog,"pdfURL":pdfURL,"sourceVersion":"2610.27491v1"]
    let article:[String:Any]=["paperID":owner,"html":"<h1>Isolated immutable offline guide</h1><p>Actual public PDF bytes; no model claim.</p>","plainText":"Actual public PDF bytes; no model claim.","sourceURL":source,"pdfURL":pdfURL,"sourceVersion":"2610.27491v1","revisionSHA256":sha256(Data("isolated-native-guide-v1".utf8)),"completeOffline":true,"isStale":false,"resources":[],"citation":["paperKey":owner]]
    try put("PublishedLibrary/articles/"+sha256(Data(blog.utf8))+".json",json(article));try put("PublishedLibrary/pdf/"+pdfSHA+".pdf",originalPDF)
    let record=try await app.storage.register(paper:paper,article:article,pdf:["filePath":root.appendingPathComponent("PublishedLibrary/pdf/"+pdfSHA+".pdf").path,"sha256":pdfSHA,"bytes":originalPDF.count,"version":"2610.27491v1","sourceURL":pdfURL])
    let packageID=record["id"] as! String,manifest=root.appendingPathComponent("Offline/"+packageID+"/manifest.json"),manifestBytes=try Data(contentsOf:manifest)
    let published=StorageDetailPublishedFixture(),emptySeed=root.appendingPathComponent("empty-seed")
    try FileManager.default.createDirectory(at:emptySeed,withIntermediateDirectories:true)
    app.library=try LibraryService(dataDirectory:root.appendingPathComponent("LateArticleFixture"),siteBaseURL:URL(string:"https://fixture.invalid/blog/")!,seedDirectory:emptySeed,transport:{url,_ in try await published.read(url)})
    _=try await app.library.sync()
    let catalog=try await app.library.handle(command:"library.list",payload:["limit":100])
    app.currentPaper=(catalog["papers"] as! [[String:Any]])[0]
    let oldArticle=Task{@MainActor in try await app.dispatch("library.article",payload:["paperID":app.currentPaperID])}
    for _ in 0..<200 {if await published.entered{break};try await Task.sleep(nanoseconds:5_000_000)}
    try expect(await published.entered,"actual old library article is held in isolated transport")
    try await app.showStorageDetails();await published.release()
    try await rejects("old article await cannot install even before offline handoff while sheet active"){_=try await oldArticle.value}
    try expect(app.currentArticle.isEmpty && app.contextGeneration==7,"late old article leaves native source revision and generation unchanged")
    _=app.closeStorageDetails()
    let libraryDelay=Task{await app.library.isolatedStorageArticleDelay()}
    try await Task.sleep(nanoseconds:20_000_000)
    let oldArchive=Task{@MainActor in try await app.archiveMaterials([:])}
    try await Task.sleep(nanoseconds:30_000_000)
    try await app.showStorageDetails();_=await libraryDelay.value
    try await rejects("archive's own pending article load cannot change source while sheet active"){_=try await oldArchive.value}
    try expect(app.currentArticle.isEmpty,"archive late-load guard protects native revision before assignment")
    _=app.closeStorageDetails()
    // These old main commands start while no detail exists, then the actual
    // native sheet wins the flush race. They must stop before any panel/source
    // mutation, not merely pass their initial dispatch/selector check.
    for command in ["app.backup","app.restore","app.export","isolated.openLocal","isolated.openOffline","isolated.archive"] {
        _=try await app.web.evaluateJavaScript("holdMainFlush=true;flushReleases=[]")
        let old=Task{@MainActor () throws ->Void in
            switch command {
            case "isolated.openLocal":try await app.flushEdits();try app.importLocalPDF()
            case "isolated.openOffline":_=try await app.openOffline(["id":packageID])
            case "isolated.archive":_=try await app.archiveMaterials([:])
            default:_=try await app.dispatch(command,payload:["format":"markdown"])
            }
        }
        for _ in 0..<200 {if (try? await app.web.evaluateJavaScript("flushReleases.length")) as? Int==1{break};try await Task.sleep(nanoseconds:5_000_000)}
        let showing=Task{@MainActor in try await app.showStorageDetails()}
        for _ in 0..<200 {if (try? await app.web.evaluateJavaScript("flushReleases.length")) as? Int==2{break};try await Task.sleep(nanoseconds:5_000_000)}
        try expect((try await app.web.evaluateJavaScript("flushReleases.length")) as? Int==2,"both real WK flushes held before presentation: "+command)
        _=try await app.web.evaluateJavaScript("flushReleases[1]()");try await showing.value
        try expect(app.storageDetailsActive,"native sheet wins delayed old operation: "+command)
        _=try await app.web.evaluateJavaScript("holdMainFlush=false;flushReleases[0]()")
        try await rejects("old operation cannot cross native detail after flush: "+command){try await old.value}
        try expect(app.currentPaperID=="arxiv:2601.00001" && app.contextGeneration==7 && !app.maintenanceBusy,"old operation preserves original reader without a panel/source install: "+command)
        _=app.closeStorageDetails()
    }
    try await app.showStorageDetails()
    guard let view=app.storageDetailWeb,let detail=app.storageDetailWindow,let session=app.storageDetailSession else{throw DesktopError.message("No native storage detail")}
    for _ in 0..<400 {if (try? await view.evaluateJavaScript("!!document.querySelector('#storage-plan')")) as? Bool==true{break};try await Task.sleep(nanoseconds:10_000_000)}
    try expect(detail.contentView===view,"native detail has one direct leaf WK contentView")
    try expect(detail.sheetParent===app.window && app.window.attachedSheet===detail,"real native sheet relationship blocks original document")
    try expect(app.web !== view && app.settingsWeb==nil,"main reader and settings are not reparented")
    try expect((try await view.evaluateJavaScript("!!document.querySelector('#storage-plan')&&document.querySelectorAll('[data-offline]').length===1")) as? Bool==true,"production detail page actually renders capacity and actual private package")
    try expect((try await view.evaluateJavaScript("document.querySelectorAll('dialog,[data-dialog-surface]').length")) as? Int==0,"leaf document does not create a hidden or facaded modal")
    let initial=try await app.storageDetailCommand("details.bootstrap",payload:[:],source:view)
    try expect(initial["presentationID"] as? String==session.id,"bootstrap reference comes from actual native view session")
    func call(_ command:String,_ more:[String:Any]=[:])async throws->[String:Any] {var p=more;p["presentationID"]=session.id;return try await app.storageDetailCommand(command,payload:p,source:view)}
    let capacity=try await call("storage.status"),packages=try await call("storage.packages")
    try expect((capacity["totalBytes"] as? Int ?? 0)>originalPDF.count,"capacity reads actual controlled private files")
    try expect((packages["packages"] as? [[String:Any]])?.first?["id"] as? String==packageID,"package list uses actual immutable package identity")
    let fakeView=WKWebView(frame:.zero)
    try await rejects("same session string from unrelated WK is rejected"){_=try await app.storageDetailCommand("storage.status",payload:["presentationID":session.id],source:fakeView)}
    try await rejects("missing session reference is rejected"){_=try await app.storageDetailCommand("storage.status",payload:[:],source:view)}
    try await rejects("stale session reference is rejected"){_=try await app.storageDetailCommand("storage.status",payload:["presentationID":UUID().uuidString],source:view)}
    try await rejects("detail view cannot dispatch model or arbitrary services"){_=try await call("model.run")}
    for command in ["app.setPaper","library.article","pdf.open","pdf.close","pdf.page","pdf.fit","pdf.zoom","pdf.locate","pdf.highlight","pdf.removeAnnotation","storage.open","storage.prepare","archive.materials","zotero.archive","app.openLocal","app.restore","app.export","app.backup","app.diagnostics","app.findQuery","model.preview","storage.cleanupPlan","storage.cleanup"] {
        try await rejects("main dispatch blocked while native sheet active: "+command){_=try await app.dispatch(command,payload:[:])}
    }
    for selector in [#selector(PaperDigestApp.openLocal),#selector(PaperDigestApp.togglePDF),#selector(PaperDigestApp.toggleSidebar),#selector(PaperDigestApp.restore),#selector(PaperDigestApp.exportResearch),#selector(PaperDigestApp.helpPage),#selector(PaperDigestApp.printPDF)] {
        let item=NSMenuItem(title:"Isolated menu fixture",action:selector,keyEquivalent:"");try expect(!app.validateMenuItem(item),"native menu disabled before final selector guard")
    }
    var confirmationParent:NSWindow?,confirmationCalls=0
    app.storageCleanupConfirmation={_,parent in confirmationParent=parent;confirmationCalls+=1;return .alertSecondButtonReturn}
    let plan=try await call("storage.cleanupPlan")
    try await rejects("cancelled native cleanup is not successful deletion"){_=try await call("storage.cleanup",["planID":plan["planID"]!])}
    try expect(confirmationParent===detail && confirmationCalls==1,"cleanup confirmation receives actual detail as direct native parent")
    try expect(!app.maintenanceBusy && !app.storageDetailBusy,"cancelled confirmation clears native maintenance and busy gates")
    app.storageCleanupConfirmation={_,parent in confirmationParent=parent;confirmationCalls+=1;return .alertFirstButtonReturn}
    let emptyPlan=try await call("storage.cleanupPlan"),cleaned=try await call("storage.cleanup",["planID":emptyPlan["planID"]!])
    try expect(cleaned["movedToTrash"] as? Int==0,"real zero-candidate plan passes controlled cleanup without recycle")
    try expect(try Data(contentsOf:manifest)==manifestBytes,"storage cleanup preserves exact original offline manifest")
    var release:CheckedContinuation<NSApplication.ModalResponse,Never>?
    app.storageCleanupConfirmation={_,_ in await withCheckedContinuation{release=$0}}
    let busyPlan=try await call("storage.cleanupPlan")
    let pending=Task{@MainActor in try await call("storage.cleanup",["planID":busyPlan["planID"]!])}
    for _ in 0..<200 {if release != nil{break};try await Task.sleep(nanoseconds:5_000_000)}
    try expect(app.storageDetailBusy && !app.closeStorageDetails(),"native close cannot dismiss pending destructive confirmation")
    release?.resume(returning:.alertSecondButtonReturn);_=try? await pending.value
    try expect(!app.storageDetailBusy && !app.maintenanceBusy,"pending cancellation restores all native gates")
    let packagePDF=root.appendingPathComponent("Offline/"+packageID+"/original.pdf")
    try Data("tampered isolated PDF".utf8).write(to:packagePDF)
    try await rejects("corrupt actual package rejected before leaving current useful detail"){_=try await call("storage.open",["id":packageID])}
    try expect(app.storageDetailsActive && app.currentPaperID=="arxiv:2601.00001","corrupt package does not switch current paper or close detail")
    try originalPDF.write(to:packagePDF)
    try await rejects("package traversal cannot become a reading source"){_=try await call("storage.open",["id":"../personal.json"])}
    // Main WK failure leaves Native A and the useful detail intact. No source
    // commit or successful-open receipt is inferred from a verified disk package.
    _=try await app.web.evaluateJavaScript("failHandoff=true;handoffEntered=false")
    try await rejects("main WK handoff failure cannot commit a native source"){_=try await call("storage.open",["id":packageID])}
    try expect(app.currentPaperID=="arxiv:2601.00001" && app.contextGeneration==7 && app.storageDetailsActive && !app.storageDetailBusy,"failed main handoff preserves native A and releases useful detail controls")
    try expect((try await app.web.evaluateJavaScript("rollbackCount")) as? Int==1,"failed main handoff requests actual main rollback")
    _=try await app.web.evaluateJavaScript("failHandoff=false;holdHandoff=true;handoffEntered=false")
    let cancelledHandoff=Task{@MainActor in try await call("storage.open",["id":packageID])}
    for _ in 0..<200 {if (try? await app.web.evaluateJavaScript("handoffEntered")) as? Bool==true{break};try await Task.sleep(nanoseconds:5_000_000)}
    try expect(app.storageDetailBusy && !app.closeStorageDetails() && app.applicationShouldTerminate(NSApp) == .terminateCancel,"native close and quit refuse during real main WK handoff")
    try expect(app.currentPaperID=="arxiv:2601.00001" && detail.sheetParent===app.window,"native A and OS document isolation stay until main confirmation")
    cancelledHandoff.cancel();_=try await app.web.evaluateJavaScript("holdHandoff=false;releaseHandoff()")
    try await rejects("cancellation after main acknowledgement rejects final native commit"){_=try await cancelledHandoff.value}
    try expect(app.currentPaperID=="arxiv:2601.00001" && app.contextGeneration==7 && app.storageDetailsActive && !app.storageDetailBusy,"cancelled handoff rolls main back and leaves native A unchanged")
    try FileManager.default.removeItem(at:root.appendingPathComponent("PublishedLibrary"))
    _=try await app.web.evaluateJavaScript("holdMainFlush=true;flushReleases=[]")
    let installing=Task{@MainActor in try await call("storage.open",["id":packageID,"paper":["id":"forged-paper"],"article":["html":"forged source"]])}
    for _ in 0..<200 {if (try? await app.web.evaluateJavaScript("flushReleases.length")) as? Int==1{break};try await Task.sleep(nanoseconds:5_000_000)}
    try expect(app.storageDetailsActive && detail.sheetParent===app.window && app.currentPaperID=="arxiv:2601.00001","detail remains document-modal throughout final flush and package verification")
    _=try await app.web.evaluateJavaScript("holdMainFlush=false;flushReleases[0]()")
    let opened=try await installing.value
    try expect(opened["opened"] as? Bool==true && !app.storageDetailsActive,"verified actual package atomically leaves detail before controlled reading installation")
    try expect(app.currentPaperID==owner && app.currentPaper["offlinePackageID"] as? String==packageID && app.contextGeneration==8,"actual private package source installed through existing openOffline CAS")
    try expect(app.currentArticle["html"] as? String==article["html"] as? String && app.currentArticle["mathMLContract"]==nil,"original sealed guide remains faithful without invented parser upgrade")
    try expect(app.offlinePDF?["sha256"] as? String==pdfSHA && sha256(try Data(contentsOf:packagePDF))==pdfSHA,"offline original PDF is exact after cache removal")
    try expect(try Data(contentsOf:manifest)==manifestBytes,"offline open preserves old seal bytes")
    try await rejects("closed view cannot continue private operations"){_=try await call("storage.status")}
    try await app.showStorageDetails()
    guard let nextView=app.storageDetailWeb,let next=app.storageDetailSession else{throw DesktopError.message("No reopened native detail")}
    try expect(nextView !== view && next.id != session.id,"reopened detail creates distinct native view and session")
    try await rejects("old actual view cannot borrow new session ID"){_=try await app.storageDetailCommand("storage.status",payload:["presentationID":next.id],source:view)}
    try await rejects("new actual view cannot use old session ID"){_=try await app.storageDetailCommand("storage.status",payload:["presentationID":session.id],source:nextView)}
    _=try await app.web.evaluateJavaScript("holdHandoff=true;handoffEntered=false")
    let staleHandoff=Task{@MainActor in try await app.storageDetailCommand("storage.open",payload:["id":packageID,"presentationID":next.id],source:nextView)}
    for _ in 0..<200 {if (try? await app.web.evaluateJavaScript("handoffEntered")) as? Bool==true{break};try await Task.sleep(nanoseconds:5_000_000)}
    app.contextGeneration+=1;app.currentPaperID="arxiv:2601.99999";app.currentPaper=["id":app.currentPaperID,"title":"Explicit newer native context C","sourceKind":"arxiv"];app.currentArticle=[:]
    let newerGeneration=app.contextGeneration
    _=try await app.web.evaluateJavaScript("holdHandoff=false;releaseHandoff()")
    try await rejects("native C installed during held acknowledgement rejects old B final CAS"){_=try await staleHandoff.value}
    try expect(app.currentPaperID=="arxiv:2601.99999" && app.contextGeneration==newerGeneration && app.storageDetailsActive,"failed B handoff never overwrites actual newer native C")
    try expect((try await app.web.evaluateJavaScript("rollbackNativeOwner")) as? String==app.currentPaperID,"main recovery receives only actual current native source C, not stale A or JS source")
    let storage=app.storage!
    let actorDelay=Task{await storage.isolatedDetailActorDelay({})}
    try await Task.sleep(nanoseconds:20_000_000)
    var late:Task<[String:Any],Error>?
    await withCheckedContinuation{(started:CheckedContinuation<Void,Never>) in late=Task{@MainActor in started.resume();return try await app.storageDetailCommand("storage.status",payload:["presentationID":next.id],source:nextView)}}
    _=app.closeStorageDetails()
    _=await actorDelay.value
    try await rejects("real capacity reply after closing cannot be adopted by a later session"){_=try await late!.value}
    try expect(!app.storageDetailsActive,"late reply does not recreate native window")
    try expect(app.validateMenuItem(NSMenuItem(title:"Open",action:#selector(PaperDigestApp.openLocal),keyEquivalent:"")),"native main menus restore after final close")
    print("Native storage detail: \(assertions) assertions passed; actual isolated AppKit/WK/temp storage; no user GUI/services")
 }
}
