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
    let (help,id)=try await show(.help)
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
    _=app.closeStorageDetails()
    for command in ["app.backup","app.restore","app.diagnostics"] {
        let (view,owner)=try await show(.help)
        let operation=Task{@MainActor in try await app.storageDetailCommand(command,payload:["presentationID":owner],source:view)}
        try await wait{app.storageDetailWindow?.attachedSheet != nil}
        let panel=app.storageDetailWindow!.attachedSheet
        try check(panel is NSSavePanel && panel?.sheetParent===app.storageDetailWindow,"actual "+command+" system panel is parented to help leaf")
        (panel as? NSSavePanel)?.cancel(nil)
        try await rejects("actual "+command+" cancellation never reports completion"){_=try await operation.value}
        try check(!app.storageDetailBusy && !app.maintenanceBusy && !app.storageDetailSystemPanel,"actual "+command+" cancellation releases all operation flags")
        _=app.closeStorageDetails()
    }
    let (zotero,zoteroID)=try await show(.zotero)
    try await wait{(try? await zotero.evaluateJavaScript("document.querySelector('#zotero-result')?.textContent.includes('本地 PDF 缺少已核验书目')")) as? Bool==true}
    try await blockedModel("Zotero")
    try check(app.storageDetailWindow?.title=="存入 Zotero","main Zotero opens actual native kind window")
    try check((try await zotero.evaluateJavaScript("document.querySelectorAll('dialog,[data-dialog-surface]').length")) as? Int==0,"Zotero shares real archive controls in an ordinary leaf section")
    try check((try await zotero.evaluateJavaScript("document.querySelector('#zotero-archive-start').disabled")) as? Bool==true,"unavailable genuine materials keep archive start disabled")
    try await rejects("Zotero cannot inject arbitrary archive paths before preparation"){_=try await app.storageDetailCommand("zotero.archive",payload:["presentationID":zoteroID,"pdfPath":"/tmp/unowned.pdf"],source:zotero)}
    try check(app.storageDetailArchiveMaterials==nil && app.currentPaperID.hasPrefix("local:"),"failed genuine source preparation grants no material authority")
    _=app.closeStorageDetails();app.window.orderOut(nil)
    print("Native details assertions: \(count), failures: 0")
 }
}
