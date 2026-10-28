// Real leaf WK/NSWindow and cancellation of this test's own system panels.
// Temporary personal data only; no installed profile, credentials or network.
import AppKit
import WebKit
import PDFKit

private final class NativeDetailOfflineProtocol:URLProtocol,@unchecked Sendable {
 override class func canInit(with request:URLRequest)->Bool{true}
 override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
 override func startLoading(){client?.urlProtocol(self,didFailWithError:URLError(.notConnectedToInternet))}
 override func stopLoading(){}
}
private struct NativeDetailNoCredentials:ZoteroCredentialStore {
 func load(serverID:String)throws->Data?{throw DesktopError.message("Fixture forbids credential reads")}
 func save(_ data:Data,serverID:String)throws{throw DesktopError.message("Fixture forbids credential writes")}
 func remove(serverID:String)throws{throw DesktopError.message("Fixture forbids credential removal")}
}

@MainActor private final class NativeErrorPresentationProbe {var shown=0}

@main struct DesktopNativeDetailsTests {
 static func main() {
    _=NSApplication.shared
    Task { @MainActor in do {try await run();exit(0)} catch {fputs("FAIL \(error)\n",stderr);exit(1)} }
    NSApplication.shared.run()
    fputs("FAIL native detail loop ended before final summary\n",stderr);exit(2)
 }
 @MainActor static func run() async throws {
    _=NSApplication.shared;NSApp.setActivationPolicy(.prohibited)
    let root=FileManager.default.temporaryDirectory.appendingPathComponent("NativeDetails-"+UUID().uuidString)
    try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
    defer{try? FileManager.default.removeItem(at:root)}
    let app=PaperDigestApp();app.directory=root;app.store=try DesktopStore(directory:root);app.storage=DesktopStorage(directory:root,store:app.store)
    var credentialReads=0
    app.model=ModelService(directory:root,store:app.store,keyProvider:{credentialReads+=1;throw DesktopError.message("No credentials in native detail fixture")})
    app.library=try LibraryService(dataDirectory:root,seedDirectory:root)
    let offline=URLSessionConfiguration.ephemeral;offline.protocolClasses=[NativeDetailOfflineProtocol.self]
    app.zotero=ZoteroService(dataDirectory:root,session:URLSession(configuration:offline),credentialStore:NativeDetailNoCredentials())
    app.scheme=BundleScheme(root:URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("apps/macos/Resources"))
    app.window=NSWindow(contentRect:NSRect(x:0,y:0,width:1200,height:800),styleMask:[.titled,.closable],backing:.buffered,defer:false);app.window.alphaValue=0
    app.web=WKWebView(frame:app.window.contentView!.bounds);app.window.contentView=app.web;app.window.delegate=app
    app.web.loadHTMLString("<html><body><h1>Real isolated original reader</h1><script>window.paperDigestFlushPendingNote=async()=>({saved:true});window.paperDigestPauseForDetails=()=>({paused:true});</script></body></html>",baseURL:nil)
    for _ in 0..<200 {if (try? await app.web.evaluateJavaScript("typeof paperDigestFlushPendingNote==='function'")) as? Bool==true{break};try await Task.sleep(nanoseconds:10_000_000)}
    app.currentPaperID="local:"+String(repeating:"a",count:64);app.currentPaper=["id":app.currentPaperID,"title":"Isolated source <literal> title","sourceKind":"local"];app.contextGeneration=7
    var count=0
    func check(_ ok:Bool,_ name:String)throws{guard ok else{throw DesktopError.message("FAIL "+name)};count+=1;print("PASS "+name)}
    func rejects(_ name:String,_ action:()async throws->Void)async throws {do{try await action()}catch{try check(true,name);return};throw DesktopError.message("FAIL expected rejection "+name)}
    func blockedModel(_ kind:String)async throws {
        let before=try JSONSerialization.data(withJSONObject:app.store.snapshot(),options:.sortedKeys),jobs=Set(app.jobs.keys)
        var message=""
        do{_=try await app.dispatch("model.run",payload:["scope":"guide","question":"Must not dispatch behind real native sheet"])}catch{message=error.localizedDescription}
        try check(message.contains("请先关闭详情窗口"),"actual "+kind+" native sheet rejects main model dispatch at context gate")
        try check(credentialReads==0 && jobs==Set(app.jobs.keys) && before == (try JSONSerialization.data(withJSONObject:app.store.snapshot(),options:.sortedKeys)),"blocked "+kind+" model operation reads no credentials and creates no job or stored request")
    }
    func wait(_ action:()async throws->Bool)async throws{for _ in 0..<400{if try await action(){return};try await Task.sleep(nanoseconds:10_000_000)};throw DesktopError.message("Timed out waiting for own isolated detail")}
    func show(_ kind:NativeDetailKind)async throws->(WKWebView,String){try await app.showNativeDetails(kind);guard let view=app.storageDetailWeb,let id=app.storageDetailSession?.id else{throw DesktopError.message("Missing actual detail")};try await wait{(try? await view.evaluateJavaScript("!!document.querySelector('#detail-content h1,#detail-content h2')")) as? Bool==true};return(view,id)}
    // Own modal windows only. The watchdog also makes a regression fail rather
    // than hanging this isolated harness inside NSAlert.runModal().
    func errorPresentation(_ error:Error,expected:Bool)throws {
        let probe=NativeErrorPresentationProbe()
        let timer=Timer(timeInterval:0.04,repeats:true){_ in MainActor.assumeIsolated {
            if let modal=NSApp.modalWindow {probe.shown+=1;modal.alphaValue=0;NSApp.abortModal()}
        }}
        RunLoop.main.add(timer,forMode:.modalPanel);RunLoop.main.add(timer,forMode:.common)
        app.showError(error);timer.invalidate()
        try check(expected ? probe.shown>0:probe.shown==0,expected ? "ordinary cancellation-looking failure still presents its real native error":"explicit user cancellation does not open an operation-failed alert")
    }
    try errorPresentation(DesktopOperationCancelled("已取消导出"),expected:false)
    try errorPresentation(DesktopError.message("已取消导出"),expected:true)
    let (help,id)=try await show(.help)
    let originalHelpContentSize=app.storageDetailWindow!.contentView!.bounds.size,originalHelpMinimum=app.storageDetailWindow!.minSize
    try await wait{(try? await help.evaluateJavaScript("!!document.querySelector('[data-detail-command=\"app.backup\"]')")) as? Bool==true}
    try check(app.storageDetailWindow?.title=="使用说明" && app.storageDetailWindow?.sheetParent===app.window,"help is real direct native sheet with its own title")
    try check((try await help.evaluateJavaScript("document.querySelectorAll('dialog,[data-dialog-surface]').length")) as? Int==0,"help has no hidden/nested modal facade")
    try check((try await help.evaluateJavaScript("[...document.querySelectorAll('button')].filter(b=>!b.hidden&&b.textContent==='完成').length")) as? Int==1,"help has one unified visible completion action")
    try check((try await help.evaluateJavaScript("document.querySelector('#details-title').textContent")) as? String=="论文速递 · 使用说明","help toolbar reflects actual presentation kind")
    for command in ["storage.status","app.export","archive.materials","zotero.authorize"]{try await rejects("help rejects foreign kind command "+command){_=try await app.storageDetailCommand(command,payload:["presentationID":id],source:help)}}
    try await blockedModel("help")
    let oldAccess=app.storageDetailDocumentAccess
    _=app.closeStorageDetails()
    let (export,exportID)=try await show(.export)
    try await wait{(try? await export.evaluateJavaScript("document.querySelectorAll('[data-format]').length===8")) as? Bool==true}
    try check(app.storageDetailWindow?.title=="导出当前研究","export has actual kind native title")
    try check((try await export.evaluateJavaScript("document.querySelectorAll('[data-format]').length")) as? Int==8,"all eight real export choices mounted in leaf document")
    try check((try await export.evaluateJavaScript("document.querySelector('#detail-content').textContent.includes('Isolated source <literal> title')")) as? Bool==true,"native source title is literal text")
    try await rejects("old help capability cannot construct export after reopening"){_=try await app.buildCurrentExport(["format":"markdown"],access:oldAccess)}
    try await blockedModel("export")
    guard let exportAccess=app.storageDetailDocumentAccess else{throw DesktopError.message("No actual access")}
    let built=try await app.buildCurrentExport(["format":"markdown"],access:exportAccess)
    try check(built.ext=="md" && String(data:built.data,encoding:.utf8)?.contains(app.currentPaperID)==true,"actual bound current research export builds without a JS source payload")
    try await rejects("main export remains blocked by actual native sheet"){_=try await app.buildCurrentExport(["format":"markdown"])}
    let save=Task{@MainActor in try await app.storageDetailCommand("app.export",payload:["presentationID":exportID,"format":"markdown","paperID":"forged-other-source"],source:export)}
    try await wait{app.storageDetailWindow?.attachedSheet != nil}
    let attached=app.storageDetailWindow!.attachedSheet
    try check(attached is NSSavePanel && attached?.sheetParent===app.storageDetailWindow,"real save panel is attached to actual export leaf owner")
    try check(!app.closeStorageDetails(),"owner cannot close while its actual save panel is pending")
    (attached as? NSSavePanel)?.cancel(nil)
    try await rejects("cancelled actual save cannot report saved"){_=try await save.value}
    try check(!app.storageDetailBusy && !app.storageDetailSystemPanel && app.currentPaperID.hasPrefix("local:"),"actual save cancellation releases busy flags and keeps original source")
    let exportJob=(app.store.value["jobs"] as? [[String:Any]] ?? []).last{$0["command"] as? String=="app.export"}
    try check(exportJob?["status"] as? String=="cancelled" && exportJob?["message"] as? String=="已取消导出","real save-panel cancellation persists a cancelled job with original Chinese reason")
    let ended=ISO8601DateFormatter().date(from:exportJob?["endedAt"] as? String ?? ""),started=ISO8601DateFormatter().date(from:exportJob?["startedAt"] as? String ?? "")
    try check(ended != nil && started != nil && ended! >= started! && exportJob?["result"]==nil && app.jobs.isEmpty,"cancelled export has valid terminal time, no saved result and no active task")

    _=app.closeStorageDetails()
    for command in ["app.backup","app.restore","app.diagnostics"] {
        let (view,owner)=try await show(.help)
        let originalStore=try JSONSerialization.data(withJSONObject:app.store.snapshot(),options:.sortedKeys)
        let operation=Task{@MainActor in try await app.storageDetailCommand(command,payload:["presentationID":owner],source:view)}
        try await wait{app.storageDetailWindow?.attachedSheet != nil}
        let panel=app.storageDetailWindow!.attachedSheet
        try check(panel is NSSavePanel && panel?.sheetParent===app.storageDetailWindow,"actual "+command+" system panel is parented to help leaf")
        (panel as? NSSavePanel)?.cancel(nil)
        var cancelled:DesktopOperationCancelled?
        do{_=try await operation.value}catch{cancelled=error as? DesktopOperationCancelled}
        let expected=command=="app.backup" ? "已取消备份":command=="app.restore" ? "已取消恢复":"已取消导出"
        try check(cancelled?.localizedDescription==expected,"actual "+command+" cancellation has a structured type and preserves Chinese reason")
        try check(!app.storageDetailBusy && !app.maintenanceBusy && !app.storageDetailSystemPanel,"actual "+command+" cancellation releases all operation flags")
        try check(originalStore == (try JSONSerialization.data(withJSONObject:app.store.snapshot(),options:.sortedKeys)),"actual "+command+" cancellation leaves personal store exactly unchanged")
        _=app.closeStorageDetails()
    }
    // Exercise the actual persistent job closure, not a label-only fixture.
    // Cancellation-looking ordinary failures must remain failures.
    for (name,issue) in [("message",DesktopError.message("已取消导出") as Error),("io",CocoaError(.fileWriteOutOfSpace) as Error),("source",DesktopError.message("来源核验失败，未写入") as Error)] {
        let identifier="ordinary-failure-"+name
        do{_=try await app.runJob("app.export",payload:[:],identifier:identifier){_ in throw issue}}catch{}
        let row=(app.store.value["jobs"] as? [[String:Any]] ?? []).first{$0["id"] as? String==identifier}
        try check(row?["status"] as? String=="failed" && row?["message"] as? String==issue.localizedDescription && row?["result"]==nil,"actual job keeps ordinary "+name+" error failed without parsing cancellation words")
    }
    do{_=try await app.runJob("app.export",payload:[:],identifier:"genuine-task-cancel"){_ in throw CancellationError()}}catch{}
    try check((app.store.value["jobs"] as? [[String:Any]] ?? []).first{$0["id"] as? String=="genuine-task-cancel"}?["status"] as? String=="cancelled","genuine Swift task cancellation still records cancelled")
    let (zotero,zoteroID)=try await show(.zotero)
    try await wait{(try? await zotero.evaluateJavaScript("document.querySelector('#zotero-result')?.textContent.includes('本地 PDF 缺少已核验书目')")) as? Bool==true}
    try await blockedModel("Zotero")
    try check(app.storageDetailWindow?.title=="存入 Zotero","main Zotero opens actual native kind window")
    try check((try await zotero.evaluateJavaScript("document.querySelectorAll('dialog,[data-dialog-surface]').length")) as? Int==0,"Zotero shares real archive controls in an ordinary leaf section")
    try check((try await zotero.evaluateJavaScript("document.querySelector('#zotero-archive-start').disabled")) as? Bool==true,"unavailable genuine materials keep archive start disabled")
    try await rejects("Zotero cannot inject arbitrary archive paths before preparation"){_=try await app.storageDetailCommand("zotero.archive",payload:["presentationID":zoteroID,"pdfPath":"/tmp/unowned.pdf"],source:zotero)}
    try check(app.storageDetailArchiveMaterials==nil && app.currentPaperID.hasPrefix("local:"),"failed genuine source preparation grants no material authority")
    _=app.closeStorageDetails()
    // Exact two public-source notices observed in the reviewed offline source
    // sheet. The timestamp remains an explicit historical fixture string.
    let shortNotices=["兼容读取现有网站正文；PDF页内定位仅在真实匹配后提供。","网站当前修订复验失败，正在读取先前保存的旧导读；获取于2026-10-27T22:38:54Z，旧来源版本2610.27491v1，目录期待版本2610.27491v1。未能完成该操作。操作不被允许"]
    func sourceSheet(_ notices:[String])async throws->WKWebView {
        app.currentArticle=["paperID":app.currentPaperID,"revisionSHA256":String(repeating:"c",count:64),"notices":notices]
        let request=try ReaderSourceNoticeRequest(["paperID":app.currentPaperID,"revisionSHA256":String(repeating:"c",count:64)])
        try await app.showNativeDetails(.sourceNotices,sourceRequest:request)
        guard let view=app.storageDetailWeb else{throw DesktopError.message("Missing own source sheet")}
        try await wait{(try? await view.evaluateJavaScript("document.querySelectorAll('.native-source-notice-text').length")) as? Int==notices.count}
        return view
    }
    func snapshot(_ view:WKWebView,_ name:String)async throws {
        guard let output=ProcessInfo.processInfo.environment["PD_READER_LAYOUT_OUTPUT"] else{return}
        let image:NSImage=try await withCheckedThrowingContinuation{continuation in view.takeSnapshot(with:nil){image,error in if let error{continuation.resume(throwing:error)}else if let image{continuation.resume(returning:image)}else{continuation.resume(throwing:DesktopError.message("No own source sheet snapshot"))}}}
        guard let tiff=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let png=bitmap.representation(using:.png,properties:[:]) else{throw DesktopError.message("Own snapshot encoding failed")}
        let location=URL(fileURLWithPath:output);try FileManager.default.createDirectory(at:location,withIntermediateDirectories:true);try png.write(to:location.appendingPathComponent(name+".png"))
    }
    let shortView=try await sourceSheet(shortNotices)
    print("OWN_SOURCE_GEOMETRY",app.storageDetailWindow!.frame,app.storageDetailWindow!.contentView!.bounds,app.storageDetailWindow!.contentLayoutRect,app.storageDetailWindow!.minSize)
    try check(app.storageDetailWindow?.contentView?.bounds.size==NSSize(width:740,height:380) && app.storageDetailWindow?.minSize==NSSize(width:640,height:300),"source notices use their own compact real native initial and minimum size")
    let rendered=try await shortView.evaluateJavaScript("[...document.querySelectorAll('.native-source-notice-text')].map(e=>e.textContent)") as? [String]
    try check(rendered==shortNotices,"compact source window preserves both original public notice strings")
    let shortVisible=try await shortView.evaluateJavaScript("(()=>{const nodes=[document.querySelector('.native-source-notices h1'),...document.querySelectorAll('.native-source-notice-text'),document.querySelector('#details-close')];return nodes.every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})})()") as? Bool==true
    try check(shortVisible,"real short source text, heading and completion button fit the compact WK viewport")
    try await snapshot(shortView,"compact-source-notices")
    _=try await shortView.evaluateJavaScript("document.querySelector('#details-close').click();true")
    try await wait{app.storageDetailWindow==nil&&app.storageDetailSession==nil}
    try check(!app.storageDetailsActive && app.currentArticle["notices"] as? [String]==shortNotices,"normal actual completion closes the source sheet without changing notice source")
    let longNotices=[String(repeating:"明确的长来源说明，用于受控可滚动窗口；原句与资料身份保持。",count:120),"可滚动到达的最后一条来源说明。"]
    let longView=try await sourceSheet(longNotices)
    guard let ownWindow=app.storageDetailWindow else{throw DesktopError.message("Missing own long notice window")}
    ownWindow.setFrame(NSRect(origin:ownWindow.frame.origin,size:ownWindow.minSize),display:true)
    try await wait{(try? await longView.evaluateJavaScript("document.documentElement.scrollHeight>innerHeight")) as? Bool==true}
    _=try await longView.evaluateJavaScript("document.querySelector('.native-source-notice-text:last-child').scrollIntoView({block:'end'});true")
    let endVisible=try await longView.evaluateJavaScript("(()=>{const last=document.querySelector('.native-source-notice-text:last-child'),r=last.getBoundingClientRect(),b=document.querySelector('#details-close').getBoundingClientRect();return scrollY>0&&last.textContent==='可滚动到达的最后一条来源说明。'&&r.top>=0&&r.bottom<=innerHeight&&b.top>=0&&b.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth})()") as? Bool==true
    try check(endVisible,"long source notices scroll to the real last text at native minimum size while the actual completion button stays reachable")
    try await snapshot(longView,"long-source-notices-end")
    _=try await longView.evaluateJavaScript("document.querySelector('#details-close').click();true")
    try await wait{app.storageDetailSession==nil}
    let (_,unchangedHelpID)=try await show(.help)
    try check(app.storageDetailWindow?.contentView?.bounds.size==originalHelpContentSize && originalHelpContentSize==NSSize(width:820,height:700) && app.storageDetailWindow?.minSize==originalHelpMinimum && unchangedHelpID==app.storageDetailSession?.id,"other native detail kinds retain original full initial/minimum dimensions and live session")
    _=app.closeStorageDetails();app.window.orderOut(nil)
    print("Native details assertions: \(count), failures: 0")
 }
}
