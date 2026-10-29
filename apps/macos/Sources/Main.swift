import AppKit
import WebKit
import PDFKit
import UniformTypeIdentifiers
import CryptoKit

#if !PAPER_DIGEST_TESTS
@main enum PaperDigestMain {
    @MainActor static func main() {
        let app=NSApplication.shared; app.setActivationPolicy(.regular)
        let delegate=PaperDigestApp(); app.delegate=delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}

#endif

final class BundleScheme: NSObject,WKURLSchemeHandler {
    let root:URL
    init(root:URL){self.root=root}
    func webView(_ webView:WKWebView,start task:WKURLSchemeTask) {
        guard let url=task.request.url,url.host=="app" else { task.didFailWithError(URLError(.badURL)); return }
        let relative=url.path=="/" ? "index.html":String(url.path.dropFirst())
        let file=root.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(root.resolvingSymlinksInPath().path+"/"),!relative.contains(".."),!relative.contains("\\") else {task.didFailWithError(URLError(.noPermissionsToReadFile));return}
        do {
            let bytes=try Data(contentsOf:file)
            let mime=["html":"text/html","js":"text/javascript","mjs":"text/javascript","css":"text/css","json":"application/json","png":"image/png","svg":"image/svg+xml","woff2":"font/woff2","woff":"font/woff","ttf":"font/ttf","pdf":"application/pdf"][file.pathExtension] ?? "application/octet-stream"
            let response=HTTPURLResponse(url:url,statusCode:200,httpVersion:"HTTP/1.1",headerFields:["Content-Type":mime+(["html","js","mjs","css","json"].contains(file.pathExtension) ? "; charset=utf-8":""),"Access-Control-Allow-Origin":"paperapp://app","Cache-Control":"no-store"])!
            task.didReceive(response); task.didReceive(bytes); task.didFinish()
        } catch {task.didFailWithError(error)}
    }
    func webView(_ webView:WKWebView,stop task:WKURLSchemeTask) {}
}

@MainActor final class PaperDigestApp:NSObject,NSApplicationDelegate,WKScriptMessageHandlerWithReply,WKNavigationDelegate,NSWindowDelegate,NSMenuItemValidation {
    var window:NSWindow!, web:WKWebView!, toolbar:NSToolbar!, settingsWindow:NSWindow?
    var pdfObserversInstalled=false
    var directory:URL!, store:DesktopStore!, library:LibraryService!, zotero:ZoteroService!, model:ModelService!, storage:DesktopStorage!
    var terminationPending=false {didSet{if terminationPending{suspendNativeAggregate();nativeNotesRequestedVisible=false;retireNativeNotes(restoreFocus:false)}else if oldValue{emit("nativeNotes.layout");restoreNativeAggregateLayout()}}}
    var maintenanceBusy=false {didSet{if maintenanceBusy{suspendNativeAggregate();nativeNotesRequestedVisible=false;retireNativeNotes(restoreFocus:true)}else if oldValue{emit("nativeNotes.layout");restoreNativeAggregateLayout()}}}
    var cloudLocal:CloudLocalStore?,cloudArchive:CloudArchiveService?
    var cloudBusy=false,cloudCredentialState="unknown"
    var cloudAutomaticPausedInMemory=false
    var cloudActiveJobID:String?,cloudLastError:String?
    var cloudSchedule:Timer?
    let cloudSessionCredentials=CloudSessionCredentials()
    var cloudPasswordPrompt:((NSAlert,NSSecureTextField)->NSApplication.ModalResponse)?
    var cloudServiceTransportOverride:CloudArchiveService.Transport?
    var cloudVaultLoadOverride:(@Sendable(UUID) async throws->String?)?
    var cloudVaultSaveOverride:((String,UUID)throws->Void)?
    var cloudVaultRemoveOverride:((UUID)throws->Void)?
    var offlinePDF:[String:Any]?
    var currentPDFReceipt:[String:Any]=[:]
    var pendingPDFPage:Int?
    var nativeTaskWindowID=UUID(),nativeTaskDocumentID=UUID()
    var nativeTaskController:NativeTasksController?,nativeTaskCoordinator:NativeTaskHostCoordinator?
    var nativeTasksRequestedVisible=false {didSet{if nativeTasksRequestedVisible{retireNativeAggregate()}}}
    var nativeNotesWindowID=UUID()
    var nativeNotesController:NativeNotesController?,nativeNotesCoordinator:NativeNotesHostCoordinator?
    var nativeNotesRequestedVisible=false {didSet{if nativeNotesRequestedVisible{retireNativeAggregate()}}}
    var aggregateSession:AggregateViewSession?,aggregateOpenSequence=0,aggregateTransitionPending=false
    var aggregateNativeHost:NativeAggregateController?, aggregateNativeSequence:Int64=0
    var contextGeneration=0 {didSet{if oldValue != contextGeneration{nativeWorkspaceContextDidChange()}}}
    var pdfOwner="",pdfVersion=""
    var pdfView=PDFView(), currentPDFSHA="", currentPaperID="", currentPDFPath:URL?, currentPaper:[String:Any]=[:], currentArticle:[String:Any]=[:]
    var selectionSource:[String:Any]=[:], annotationsByID:[String:PDFAnnotation]=[:], jobs:[String:Task<[String:Any],Error>]=[:]
    var schedule:Timer?, lastSyncAttempt=Date.distantPast
    var catalogSyncFlight:(id:UUID,task:Task<[String:Any],Error>)?
    var scheme:BundleScheme!
    var settingsWeb:WKWebView?
    var settingsPaneRequest:String?
    var settingsPaneRequestID=UUID()
    var storageDetailWindow:NSWindow?,storageDetailWeb:WKWebView?
    var storageDetailSession:StorageDetailSession? {didSet{if storageDetailSession != nil{suspendNativeAggregate();nativeNotesRequestedVisible=false;retireNativeNotes(restoreFocus:true)}else if oldValue != nil{emit("nativeNotes.layout");restoreNativeAggregateLayout()}}}
    var storageDetailBusy=false,storageDetailSystemPanel=false
    var storageDetailDocumentAccess:DetailDocumentAccess?
    var storageDetailArchiveMaterials:[String:Any]?
    var storageCleanupConfirmation:((NSAlert,NSWindow?) async ->NSApplication.ModalResponse)?
    func applicationDidFinishLaunching(_ notification:Notification) {
        do {
            directory=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("PaperDigest",isDirectory:true)
            store=try DesktopStore(directory:directory)
            library=try LibraryService(dataDirectory:directory)
            zotero=ZoteroService(dataDirectory:directory)
            model=ModelService(directory:directory,store:store)
            storage=DesktopStorage(directory:directory,store:store)
            applyApplicationAppearance();buildMenu(); buildWindow(); configureSchedule(); configureCloudSchedule()
            NSWorkspace.shared.notificationCenter.addObserver(self,selector:#selector(didWake),name:NSWorkspace.didWakeNotification,object:nil)
            NSApp.activate(ignoringOtherApps:true)
        } catch { showError(error); NSApp.terminate(nil) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{false}
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows flag:Bool)->Bool {window.makeKeyAndOrderFront(nil);emit("nativeTasks.layout");emit("nativeNotes.layout");restoreNativeAggregateLayout();return true}
    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply {
        guard !terminationPending,!maintenanceBusy,!storageDetailBusy,!storageDetailSystemPanel else{return .terminateCancel}
        if !jobs.isEmpty {
            let alert=NSAlert();alert.messageText="仍有任务在进行";alert.informativeText="退出会中断传输。已经完成的步骤会保留，模型消费可能仍然发生。";alert.addButton(withTitle:"继续运行");alert.addButton(withTitle:"保存状态并退出")
            if alert.runModal() == .alertFirstButtonReturn{return .terminateCancel}
        }
        terminationPending=true
        Task{do{try await flushEdits();await finishJobsForTermination();NSApp.reply(toApplicationShouldTerminate:true)}catch{terminationPending=false;showError(error);NSApp.reply(toApplicationShouldTerminate:false)}}
        return .terminateLater
    }
    func finishJobsForTermination() async {
        let closing=Array(jobs.values)
        for(id,task) in jobs{task.cancel();model?.cancel(id)}
        await library?.cancelSync()
        for task in closing{_=try? await task.value}
        cloudSessionCredentials.clear();cloudArchive=nil;cloudAutomaticPausedInMemory=true
    }
    func flushEdits() async throws {
        guard let web=web else{return}
        _=try await web.callAsyncJavaScript("return window.paperDigestFlushPendingNote ? await window.paperDigestFlushPendingNote() : {saved:true}",arguments:[:],in:nil,contentWorld:.page)
        if let detail=storageDetailWeb{_=try await detail.callAsyncJavaScript("return window.paperDigestFlushDetails ? await window.paperDigestFlushDetails() : {saved:true}",arguments:[:],in:nil,contentWorld:.page)}
        if let settings=settingsWeb{_=try await settings.callAsyncJavaScript("return window.paperDigestFlushSettings ? await window.paperDigestFlushSettings() : {saved:true}",arguments:[:],in:nil,contentWorld:.page)}
    }
    func windowShouldClose(_ sender:NSWindow)->Bool {
        if sender===storageDetailWindow {_=closeStorageDetails();return false}
        if sender===window,storageDetailsActive {_=mainContextMenuAvailable();return false}
        guard sender===window || sender===settingsWindow else{return true}
        Task{do{try await flushEdits();if sender===self.window{self.suspendNativeAggregate();self.nativeTasksRequestedVisible=false;self.retireNativeTasks(restoreFocus:true);self.nativeNotesRequestedVisible=false;self.retireNativeNotes(restoreFocus:true)};sender.orderOut(nil)}catch{showError(error)}};return false
    }
    func buildWindow() {
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:1440,height:900),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.minSize=NSSize(width:1080,height:700);window.title="论文速递工作台";window.titleVisibility = .hidden
        window.setFrameAutosaveName("PaperDigestMain");window.center();window.delegate=self
        let configuration=WKWebViewConfiguration();scheme=BundleScheme(root:Bundle.main.resourceURL!.appendingPathComponent("Web"))
        configuration.setURLSchemeHandler(scheme,forURLScheme:"paperapp")
        configuration.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"desktop")
        configuration.preferences.javaScriptCanOpenWindowsAutomatically=false
        web=WKWebView(frame:window.contentView!.bounds,configuration:configuration);web.autoresizingMask=[.width,.height];web.navigationDelegate=self
        web.allowsBackForwardNavigationGestures=false
        let content=NSView(frame:window.contentView!.bounds);content.autoresizingMask=[.width,.height];window.contentView=content;content.addSubview(web)
        pdfView.isHidden=true;pdfView.autoScales=true;pdfView.displayMode = .singlePageContinuous;pdfView.displaysPageBreaks=true;pdfView.backgroundColor = .windowBackgroundColor
        window.contentView!.addSubview(pdfView)
        installNativeTasks();installNativeNotes()
        installPDFObservers()
        web.load(URLRequest(url:URL(string:"paperapp://app/index.html")!))
        window.makeKeyAndOrderFront(nil)
    }
    func buildMenu() {
        let menu=NSMenu();NSApp.mainMenu=menu
        func group(_ title:String)->NSMenu{let item=NSMenuItem();menu.addItem(item);let child=NSMenu(title:title);item.submenu=child;return child}
        func action(_ menu:NSMenu,_ title:String,_ selector:Selector,_ key:String="",_ modifiers:NSEvent.ModifierFlags = .command){let item=NSMenuItem(title:title,action:selector,keyEquivalent:key);item.target=self;item.keyEquivalentModifierMask=modifiers;menu.addItem(item)}
        let app=group("论文速递工作台");action(app,"关于论文速递工作台",#selector(about));app.addItem(.separator());action(app,"设置…",#selector(openSettings),",");app.addItem(.separator());action(app,"隐藏论文速递工作台",#selector(hideApp),"h");app.addItem(.separator());action(app,"退出论文速递工作台",#selector(quit),"q")
        let file=group("文件");action(file,"打开本地 PDF…",#selector(openLocal),"o");action(file,"同步已发布论文",#selector(syncNow),"r",[.command,.shift]);file.addItem(.separator());action(file,"导出当前研究…",#selector(exportResearch),"e");action(file,"备份个人资料…",#selector(backup));action(file,"恢复个人资料…",#selector(restore));file.addItem(.separator());action(file,"打印原文…",#selector(printPDF),"p");action(file,"关闭窗口",#selector(closeWindow),"w")
        let edit=group("编辑")
        for (title,selector,key) in [("撤销",Selector(("undo:")),"z"),("重做",Selector(("redo:")),"Z"),("剪切",#selector(NSText.cut(_:)),"x"),("复制",#selector(NSText.copy(_:)),"c"),("粘贴",#selector(NSText.paste(_:)),"v"),("全选",#selector(NSText.selectAll(_:)),"a")] {edit.addItem(withTitle:title,action:selector,keyEquivalent:key)}
        edit.addItem(.separator());action(edit,"查找当前文档…",#selector(findCurrent),"f");action(edit,"搜索全部论文",#selector(findLibrary),"f",[.command,.shift])
        let view=group("显示");action(view,"页面操作",#selector(focusAggregateToolbar));action(view,"阅读正文",#selector(focusAggregateBody),"\t",[.control]);action(view,"返回页面导航",#selector(focusAggregateNavigation),"\t",[.control,.shift]);action(view,"显示/隐藏侧栏",#selector(toggleSidebar),"s",[.command,.control]);action(view,"打开/关闭 PDF",#selector(togglePDF),"d",[.command,.shift]);action(view,"放大正文",#selector(fontLarger),"+");action(view,"缩小正文",#selector(fontSmaller),"-");action(view,"进入/退出全屏",#selector(fullScreen),"f",[.command,.control])
        let win=group("窗口");win.addItem(withTitle:"最小化",action:#selector(NSWindow.performMiniaturize(_:)),keyEquivalent:"m");win.addItem(withTitle:"缩放",action:#selector(NSWindow.performZoom(_:)),keyEquivalent:"");NSApp.windowsMenu=win
        let help=group("帮助");action(help,"使用说明",#selector(helpPage));action(help,"导出诊断…",#selector(exportDiagnostics));action(help,"在 Finder 查看资料",#selector(revealData))
    }
    func webView(_ webView:WKWebView,decidePolicyFor action:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){
        guard let url=action.request.url else{decisionHandler(.cancel);return}
        if url.scheme=="paperapp",url.host=="app",url.path.hasPrefix("/reader-link/") {
            decisionHandler(.cancel)
            if let message=Self.readerLinkMessage(url,sourceIsMainFrame:action.sourceFrame.isMainFrame,linkActivated:action.navigationType == .linkActivated){emit("reader.link",message)}
            return
        }
        if url.scheme=="paperapp",url.host=="app"{decisionHandler(action.sourceFrame.isMainFrame && action.targetFrame?.isMainFrame != false ? .allow:.cancel);return}
        if action.targetFrame?.isMainFrame==false, url.scheme=="about"{decisionHandler(.allow);return}
        if action.navigationType == .linkActivated, ["https","zotero"].contains(url.scheme ?? ""){NSWorkspace.shared.open(url)}
        decisionHandler(.cancel)
    }
    static func readerLinkMessage(_ url:URL,sourceIsMainFrame:Bool,linkActivated:Bool)->[String:Any]? {
        guard !sourceIsMainFrame,linkActivated,url.scheme=="paperapp",url.host=="app",url.user==nil,url.password==nil,url.port==nil,url.query==nil,url.fragment==nil,
              URLComponents(url:url,resolvingAgainstBaseURL:false)?.percentEncodedPath==url.path else{return nil}
        let pieces=url.path.split(separator:"/",omittingEmptySubsequences:false)
        guard pieces.count==4,pieces[0].isEmpty,pieces[1]=="reader-link",UUID(uuidString:String(pieces[2])) != nil,
              String(pieces[3]).range(of:#"\A(?:0|[1-9][0-9]{0,5})\z"#,options:.regularExpression) != nil else{return nil}
        return ["token":String(pieces[2]).lowercased(),"linkID":String(pieces[3])]
    }
    func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage,replyHandler:@escaping(Any?,String?)->Void){
        guard message.frameInfo.isMainFrame,message.frameInfo.securityOrigin.protocol=="paperapp",message.frameInfo.securityOrigin.host=="app",let body=message.body as? [String:Any],let command=body["command"] as? String else{replyHandler(nil,"已拒绝非应用主界面的操作");return}
        let payload=body["payload"] as? [String:Any] ?? [:]
        guard let source=message.webView else{replyHandler(nil,"操作来源窗口不可用");return}
        if command=="nativeNotes.bootstrap" || command=="nativeNotes.present" {
            let frameURL=message.frameInfo.request.url,isMainFrame=message.frameInfo.isMainFrame
            Task{do{replyHandler(try await nativeNotesMessage(command,payload:payload,source:source,frameURL:frameURL,isMainFrame:isMainFrame),nil)}catch{replyHandler(nil,"笔记视图已变化，请重新选择我的笔记")}}
            return
        }
        if command=="nativeTasks.bootstrap" || command=="nativeTasks.present" {
            let frameURL=message.frameInfo.request.url,isMainFrame=message.frameInfo.isMainFrame
            Task{do{replyHandler(try await nativeTasksMessage(command,payload:payload,source:source,frameURL:frameURL,isMainFrame:isMainFrame),nil)}catch{replyHandler(nil,"任务视图已变化，请重新选择后台任务")}}
            return
        }
        if command.hasPrefix("aggregates."),source !== web {replyHandler(nil,"汇总阅读只支持当前主窗口");return}
        if command=="reader.sourceNotices.show",source !== web {replyHandler(nil,"来源说明只支持当前主阅读窗口");return}
        if source===storageDetailWeb {
            Task{do{replyHandler(try await storageDetailCommand(command,payload:payload,source:source),nil)}catch{replyHandler(nil,error.localizedDescription)}}
            return
        }
        guard source===web || source===settingsWeb else{replyHandler(nil,"已拒绝过期或未知窗口的操作");return}
        Task{do{
            let result=try await dispatch(command,payload:payload)
            replyHandler(result,nil)
            // settings.js installs its pane hook before its first bootstrap.
            // This authenticated same-view round trip is the readiness signal;
            // didFinish alone may precede module initialization in WKWebView.
            if source===settingsWeb,command=="app.bootstrap"{applySettingsPaneRequest(documentReady:true)}
        }catch{
            if let cancelled=Self.cloudCancellationReply(error,command:command){replyHandler(cancelled,nil)}
            else{replyHandler(nil,error.localizedDescription)}
        }}
    }
    /// Only native cancellation types produce this outcome; server/error text cannot grant it.
    static func cloudCancellationReply(_ error:Error,command:String)->[String:Any]? {
        guard command.hasPrefix("cloud."),error is CancellationError || error is DesktopOperationCancelled else{return nil}
        return ["cancelled":true,"message":(error as? DesktopOperationCancelled)?.localizedDescription ?? "已取消本次云端操作；原快照和已完成步骤保留。"]
    }
    func emit(_ name:String,_ object:[String:Any]=[:],to targets:[WKWebView]?=nil) {
        if name=="jobs.changed"{nativeTaskController?.reload()}
        if name=="personal.changed"{nativeWorkspaceContextDidChange()}
        if name=="settings.changed"{applyApplicationAppearance();updateNativeTasksAppearance();updateNativeNotesAppearance();updateNativeAggregateAppearance()}
        guard JSONSerialization.isValidJSONObject(object),let data=try? JSONSerialization.data(withJSONObject:object),let text=String(data:data,encoding:.utf8),let event=try? JSONSerialization.data(withJSONObject:[name]),let json=String(data:event,encoding:.utf8) else{return}
        for target in (targets ?? [web,settingsWeb,storageDetailWeb].compactMap({$0})) {target.evaluateJavaScript("window.dispatchEvent(new CustomEvent(\(json).at(0),{detail:\(text)}));",completionHandler:nil)}
    }
    func dispatch(_ command:String,payload:[String:Any]) async throws->[String:Any] {
        let readingCommands:Set<String>=["app.setPaper","library.article","pdf.open","pdf.close","pdf.page","pdf.fit","pdf.zoom","pdf.locate","pdf.highlight","pdf.removeAnnotation","storage.open","storage.prepare","model.run","archive.materials","zotero.archive","storage.cleanupPlan","storage.cleanup","app.openLocal","app.restore","app.export","app.backup","app.diagnostics","app.findQuery","model.preview","pdf.selection","pdf.outline","pdf.find","pdf.openExternal"]
        if readingCommands.contains(command){try requireMainContextAvailable()}
        let savingCommands:Set<String>=["personal.note","personal.reading","personal.annotationNote","settings.save","pdf.frame","personal.snapshot"]
        if maintenanceBusy {guard ["pdf.frame","cloud.state","cloud.revealTransfers"].contains(command) else{throw DesktopError.message("正在整理资料，请稍后再操作")}}
        if terminationPending {
            guard savingCommands.contains(command) else{throw DesktopError.message("正在保存并退出或整理资料，请稍后再操作")}
        }
        if (aggregateSession != nil || aggregateTransitionPending), Self.aggregateForbids(command){throw DesktopError.message("汇总页面只供阅读，请先打开单篇论文再使用这项研究功能")}
        if command.hasPrefix("aggregates."){return try await dispatchAggregates(command,payload:payload)}
        if command.hasPrefix("cloud."){return try await dispatchCloud(command,payload:payload)}
        if command=="app.bootstrap" {
            let settings=model.configuration()
            _=try? await library.handle(command:"library.network",payload:["httpProxy":settings["httpProxy"] ?? ""])
            return ["personal":store.snapshot(),"settings":settings,"paper":currentPaper,"library":try await library.handle(command:"library.status",payload:[:]),"version":"1.0.0","nativeTasks":true,"nativeNotes":true,"nativeSourceNotices":true,"nativeAggregateHost":true,"build":Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") ?? "development"]
        }
        if command.hasPrefix("library.") {
            if command=="library.article",let id=payload["paperID"] as? String {
                guard currentPaperID==id else{throw DesktopError.message("论文已切换")}
                let generation=contextGeneration,paper=currentPaper
                let result=try await runJob(command,payload:payload){notify in try await self.library.handle(command:command,payload:payload,progress:notify)}
                guard currentPaperID==id,contextGeneration==generation else{throw DesktopError.message("论文已切换，旧正文未覆盖当前论文")}
                try requireMainContextAvailable()
                try verifyArticleBinding(result,paper:paper);currentArticle=result;return result
            }
            if command=="library.sync"{return try await syncCatalog(payload:payload)}
            if command=="library.downloadPDF"{return try await runJob(command,payload:payload){notify in try await self.library.handle(command:command,payload:payload,progress:notify)}}
            return try await library.handle(command:command,payload:payload)
        }
        switch command {
        case "app.setPaper":
            let next=payload["id"] as? String ?? ""
            contextGeneration+=1;pdfView.document=nil;pdfView.isHidden=true;currentPDFSHA="";currentPDFPath=nil;pdfOwner="";pdfVersion="";selectionSource=[:];currentArticle=[:];offlinePDF=nil;currentPDFReceipt=[:]
            try store.rememberPaper(payload);currentPaper=payload;currentPaperID=next;emit("paper.changed");return [:]
        case "personal.snapshot":return store.snapshot()
        case "personal.setList":try store.setList(payload["key"] as? String ?? "",ids:payload["ids"] as? [String] ?? []);return store.snapshot()
        case "personal.note":return try store.saveNote(id:payload["paperID"] as? String ?? currentPaperID,text:payload["text"] as? String ?? "",baseRevision:payload["baseRevision"] as? Int ?? 0)
        case "personal.reading":guard let owner=payload["paperID"] as? String,!owner.isEmpty,owner==currentPaperID || (store.value["personalPapers"] as? [String:[String:Any]])?[owner] != nil else{throw DesktopError.message("阅读身份缺失，未覆盖其他文献状态")};try store.saveReading(id:owner,state:payload);return [:]
        case "personal.annotations":return ["annotations":store.annotations(id:currentPaperID)]
        case "personal.search":
            let query=(payload["query"] as? String ?? "").lowercased();let notes=store.value["notes"] as? [String:[String:Any]] ?? [:]
            let annotations=store.value["annotations"] as? [String:[[String:Any]]] ?? [:]
            var ids=Set(notes.filter{($0.value["text"] as? String ?? "").lowercased().contains(query)}.map(\.key))
            for(id,marks) in annotations where marks.contains(where:{(($0["text"] as? String ?? "")+"\n"+($0["comment"] as? String ?? "")).lowercased().contains(query)}){ids.insert(id)}
            return ["ids":ids.sorted()]
        case "settings.save":
            try validateSettings(payload)
            _=try await library.handle(command:"library.network",payload:["httpProxy":payload["httpProxy"] ?? store.setting("httpProxy") ?? ""])
            do{try store.updateSettings(payload)}catch{_=try? await library.handle(command:"library.network",payload:["httpProxy":store.setting("httpProxy") ?? ""]);throw error}
            configureSchedule();emit("settings.changed");return model.configuration()
        case "settings.open":
            if let requested=payload["pane"] {
                guard let pane=requested as? String,["reading","model","zotero","storage","cloud"].contains(pane) else{throw DesktopError.message("设置分类无效")}
                showSettingsWindow(initialPane:pane)
            }else{openSettings()}
            return [:]
        case "model.setKey":try setModelKey();model.credentialDidChange(present:true);return model.configuration()
        case "model.deleteKey":try DesktopKeychain.remove("primary");model.credentialDidChange(present:false);return model.configuration()
        case "model.preview":let source=try modelSource(payload);var result=source.filter{$0.key != "text"};result["characters"]=(source["text"] as? String ?? "").count;return result
        case "model.run","model.check":
            let id=UUID().uuidString,check=command=="model.check",owner=currentPaperID,generation=contextGeneration
            if !check,let requested=payload["paperID"] as? String,requested != owner{throw DesktopError.message("提问所属论文已切换，未请求模型")}
            let source=check ? ["kind":"connection-check"] : try modelSource(payload)
            try await flushEdits()
            guard check || (owner==currentPaperID && generation==contextGeneration) else{throw DesktopError.message("论文在保存期间已切换，未发送模型请求")}
            if !check{try requireMainContextAvailable()}
            guard !terminationPending,!maintenanceBusy else{throw DesktopError.message("正在退出或整理资料，未发送模型请求")}
            if let expected=payload["expectedPDFSHA"] as? String,expected != source["pdfSHA"] as? String{throw DesktopError.message("原始解析使用了不同 PDF 版本，请打开对应原文后重做")}
            if let expected=payload["expectedRevision"] as? String,expected != source["revision"] as? String{throw DesktopError.message("导读修订已变化，请基于当前导读重新提问")}
            return try await runJob(command,payload:payload,identifier:id){_ in
                try await self.model.run(id:id,paperID:owner,question:check ? "请仅回复：连接成功":payload["question"] as? String ?? "",evidence:check ? "":source["text"] as? String ?? "",source:source.filter{$0.key != "text"},force:payload["force"] as? Bool ?? false,check:check)
            }
        case "jobs.list":return ["jobs":store.value["jobs"] ?? []]
        case "jobs.cancel":
            let id=payload["id"] as? String ?? "";if let task=jobs[id]{task.cancel();model.cancel(id);let row=(store.value["jobs"] as? [[String:Any]])?.first{$0["id"] as? String==id};if row?["command"] as? String=="library.sync"{await library.cancelSync()}};return ["cancelRequested":true]
        case "pdf.open":return try await runJob(command,payload:payload){_ in try await self.openPDF();return self.pdfStatus()}
        case "pdf.close":pdfView.isHidden=true;return [:]
        case "pdf.frame":positionPDF(payload);return [:]
        case "pdf.outline":return ["chapters":pdfChapters()]
        case "pdf.locate":
            guard pdfOwner==currentPaperID,payload["pdfSHA"] as? String==currentPDFSHA,let doc=pdfView.document,let number=payload["page"] as? Int,number>=1,number<=doc.pageCount,let page=doc.page(at:number-1) else{throw DesktopError.message("引用来自不同 PDF 版本或页码无效，未进行错误定位")};pdfView.go(to:page);return pdfStatus()
        case "pdf.page":
            if let doc=pdfView.document,let page=payload["page"] as? Int,let target=doc.page(at:max(0,min(doc.pageCount-1,page-1))){pdfView.go(to:target)};return pdfStatus()
        case "pdf.zoom":if let factor=payload["factor"] as? Double{pdfView.autoScales=false;pdfView.scaleFactor=max(0.25,min(5,factor))};return pdfStatus()
        case "pdf.fit":pdfView.autoScales=true;return pdfStatus()
        case "pdf.find":
            guard let doc=pdfView.document else{throw DesktopError.message("请先打开原文")}
            let matches=doc.findString(payload["query"] as? String ?? "",withOptions:.caseInsensitive)
            if let first=matches.first{pdfView.setCurrentSelection(first,animate:true);pdfView.go(to:first)}
            return ["count":matches.count]
        case "pdf.highlight":return try addHighlight()
        case "personal.annotationNote":
            let owner=payload["paperID"] as? String ?? currentPaperID
            guard let id=payload["id"] as? String,let original=store.annotations(id:owner).first(where:{$0["id"] as? String==id}),let comment=payload["comment"] as? String,comment.count<=20000 else{throw DesktopError.message("标注或批注内容无效")}
            var entry=original;entry["comment"]=comment;entry["updatedAt"]=ISO8601DateFormatter().string(from:Date());let entries=try store.saveAnnotation(id:owner,annotation:entry);if owner==currentPaperID{annotationsByID[id]?.contents=(original["text"] as? String ?? "")+"\n我的批注："+comment};return ["annotations":entries]
        case "pdf.removeAnnotation":
            let id=payload["id"] as? String ?? "";let entries=try store.saveAnnotation(id:currentPaperID,annotation:["id":id],remove:true);if let annotation=annotationsByID.removeValue(forKey:id){annotation.page?.removeAnnotation(annotation)}
            return ["annotations":entries]
        case "pdf.selection":return selectionSource
        case "pdf.openExternal":if let file=currentPDFPath{NSWorkspace.shared.open(file)};return [:]
        case "archive.materials":return try await runJob(command,payload:payload){_ in try await self.archiveMaterials(payload)}
        case "zotero.open":
            guard let key=payload["key"] as? String,key.range(of:"^[A-Z0-9]{8}$",options:.regularExpression) != nil else{throw DesktopError.message("Zotero 条目身份无效")}
            NSWorkspace.shared.open(URL(string:"zotero://select/library/items/\(key)")!);return [:]
        case "app.findQuery":return findQuery(payload["target"] as? String ?? "当前文档")
        case "app.external":
            guard let raw=payload["url"] as? String,let url=URL(string:raw),url.scheme=="https",url.user==nil,url.password==nil else{throw DesktopError.message("链接无效")};NSWorkspace.shared.open(url);return [:]
        case "app.openLocal":openLocal();return [:]
        case "app.export":return try await runJob(command,payload:payload){_ in try await self.exportCurrent(payload);return ["saved":true]}
        case "app.backup":try await flushEdits();try await backupData();return ["saved":true]
        case "app.restore":try await flushEdits();try await restoreData();return ["restored":true]
        case "app.diagnostics":try await diagnostics();return ["saved":true]
        case "app.revealData":revealData();return [:]
        case "storage.show":try await showStorageDetails();return [:]
        case "details.show":
            guard let raw=payload["kind"] as? String,let kind=NativeDetailKind(rawValue:raw),kind != .storage,kind != .sourceNotices else{throw DesktopError.message("未知详情窗口")}
            try await showNativeDetails(kind);return [:]
        case "reader.sourceNotices.show":
            try requireMainContextAvailable()
            let request=try ReaderSourceNoticeRequest(payload)
            try await showNativeDetails(.sourceNotices,sourceRequest:request)
            return try sourceNoticePresentation(request)
        case "storage.status":return try await storage.capacity()
        case "storage.packages":return ["packages":try await storage.listPackages()]
        case "storage.prepare":return try await runJob(command,payload:payload){notify in try await self.prepareOffline(progress:notify)}
        case "storage.open":return try await openOffline(payload)
        case "storage.cleanupPlan":return try await storage.cleanupPlan()
        case "storage.cleanup":return try await cleanupStorage(payload)
        default:
            if command.hasPrefix("zotero.") {
                return try await runJob(command,payload:payload){notify in try await self.zotero.handle(command:command,payload:payload,progress:notify)}
            }
            throw DesktopError.message("应用不支持此操作")
        }
    }
    func runJob(_ command:String,payload:[String:Any],identifier:String=UUID().uuidString,material:[String:Any]?=nil,operation:@escaping(@escaping @Sendable([String:Any])->Void) async throws->[String:Any]) async throws->[String:Any] {
        guard !terminationPending,!maintenanceBusy else{throw DesktopError.message("正在退出或整理资料，未启动新任务")}
        let isZotero=command.hasPrefix("zotero."),isCloud=command.hasPrefix("cloud.")
        let cloudTitle=["cloud.check":"检查坚果云连接","cloud.upload":"备份完整研究空间","cloud.list":"读取云端备份版本","cloud.restore":"恢复云端研究空间"][command] ?? "坚果云资料"
        var row:[String:Any]=["id":identifier,"command":command,"paperID":(isZotero || isCloud || command=="aggregates.document") ? "":currentPaperID,"title":isCloud ? cloudTitle:isZotero ? (command=="zotero.resume" ? "继续 Zotero 归档":"Zotero 操作"):(currentPaper["titleZh"] ?? currentPaper["title"] ?? command),"status":"running","startedAt":ISO8601DateFormatter().string(from:Date()),"message":"正在执行"]
        if command=="aggregates.document"{row["title"]="读取网站汇总"}
        if isCloud {
            let profile=try cloudLocalStore().profile
            row["identity"]="坚果云 · "+profile.account+" / "+profile.folder
            row["cloudDestinationID"]=profile.destinationID.uuidString
            if let material{row["material"]=material}
        }
        try store.upsertJob(row);emit("jobs.changed")
        let owner=currentPaperID,generation=contextGeneration
        let task=Task{try Task.checkCancellation();guard !self.terminationPending,!self.maintenanceBusy else{throw DesktopError.message("任务启动前已退出或整理资料，未派发请求")};if ["archive.materials","app.export","storage.prepare","pdf.open"].contains(command){guard owner==self.currentPaperID,generation==self.contextGeneration else{throw DesktopError.message("任务开始前论文已切换，未使用其他材料")}};return try await operation{update in Task{@MainActor in self.recordProgress(id:identifier,update:update)}}}
        jobs[identifier]=task
        do {
            let result=try await task.value;if task.isCancelled{throw CancellationError()};jobs[identifier]=nil;row=(store.value["jobs"] as? [[String:Any]])?.first{$0["id"] as? String==identifier} ?? row
            if isZotero,let identity=result["identity"] as? String,let title=result["title"] as? String {
                row["identity"]=identity;row["title"]=title
                let base=identity.hasPrefix("arxiv:") ? identity.replacingOccurrences(of:"v[1-9][0-9]*$",with:"",options:.regularExpression):identity
                if (store.value["personalPapers"] as? [String:[String:Any]])?[base] != nil{row["paperID"]=base}
            }
            row["status"]=(result["status"] as? String=="partial" || result["isStale"] as? Bool==true) ? "partial":"complete";row["message"]=result["readOnly"] as? Bool==true ? (result["warning"] as? String ?? "旧记录账号未绑定，本次仅只读回读，未继续写入") : result["isStale"] as? Bool==true ? "当前来源复验失败，保留可读旧缓存，请核对提示":"操作已结束，请查看实际结果";row["result"]=result.filter{["status","archiveID","parentKey","retryable","reused","sha256","paperCount","recordCount","identity","title","readOnly","warning"].contains($0.key)};row["endedAt"]=ISO8601DateFormatter().string(from:Date());try store.upsertJob(row);emit("jobs.changed");return result
        } catch {jobs[identifier]=nil;row=(store.value["jobs"] as? [[String:Any]])?.first{$0["id"] as? String==identifier} ?? row;row["status"]=(task.isCancelled || error is CancellationError || error is DesktopOperationCancelled) ? "cancelled":"failed";row["message"]=error is CancellationError ? "已取消；已完成的步骤和原材料保留。":error.localizedDescription;row["endedAt"]=ISO8601DateFormatter().string(from:Date());try store.upsertJob(row);emit("jobs.changed");throw error}
    }
    func recordProgress(id:String,update:[String:Any]) {
        guard var row=(store.value["jobs"] as? [[String:Any]])?.first(where:{$0["id"] as? String==id}) else{return}
        guard row["status"] as? String=="running" else{return}
        row["progress"]=update;row["message"]=update["message"] ?? update["phase"] ?? "处理中"
        do{try store.upsertJob(row);emit("job.progress",["id":id,"progress":update]);emit("jobs.changed")}catch{jobs[id]?.cancel();model.cancel(id);emit("app.error",["message":"任务进度未能保存，已请求停止："+error.localizedDescription])}
    }
    func positionPDF(_ payload:[String:Any]) {
        guard !nativeTasksRequestedVisible,!nativeNotesRequestedVisible else{pdfView.isHidden=true;return}
        guard payload["visible"] as? Bool==true else{pdfView.isHidden=true;return}
        let x=payload["x"] as? Double ?? 0,y=payload["y"] as? Double ?? 0,w=payload["width"] as? Double ?? 0,h=payload["height"] as? Double ?? 0
        guard w>=150,h>=100,x>=0,y>=0 else{pdfView.isHidden=true;return}
        pdfView.frame=NSRect(x:x,y:web.bounds.height-y-h,width:min(w,web.bounds.width-x),height:min(h,web.bounds.height-y));pdfView.isHidden=false
        if let page=pendingPDFPage,let target=pdfView.document?.page(at:max(0,page-1)){pendingPDFPage=nil;pdfView.go(to:target);pdfPageChanged()}
    }
    func openPDF() async throws {
        let owner=currentPaperID,generation=contextGeneration,paper=currentPaper,article=currentArticle
        let result:[String:Any]
        if owner.hasPrefix("local:"),let raw=currentPaper["localPDFPath"] as? String,let expected=currentPaper["pdfSHA"] as? String {let file=try PrivateStoragePaths.resolve(raw,directory:directory,expectedSHA256:expected);result=["filePath":file.path,"sha256":expected,"version":""]}
        else if currentArticle["offlineMode"] as? Bool==true {guard let identifier=currentPaper["offlinePackageID"] as? String,let saved=try await storage.openPackage(id:identifier)["pdf"] as? [String:Any] else{throw DesktopError.message("这个离线包没有已核验原文 PDF；读取网站当前版本后可下载")};result=saved}
        else {result=try await library.handle(command:"library.downloadPDF",payload:["paperID":owner])}
        guard owner==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换，旧 PDF 未安装到当前文献")}
        try requireMainContextAvailable()
        if !owner.hasPrefix("local:"){try verifyPDFBinding(result,paper:paper,article:article)}
        guard let path=result["filePath"] as? String else{throw DesktopError.message("原文文件未准备好")}
        let url=URL(fileURLWithPath:path).resolvingSymlinksInPath()
        guard url.path.hasPrefix(directory.path+"/") || url.path.hasPrefix(Bundle.main.resourceURL!.path+"/") else{throw DesktopError.message("原文不在应用资料范围内")}
        guard let doc=PDFDocument(url:url) else{throw DesktopError.message("原文无法作为 PDF 打开")}
        try unlockPDF(doc)
        let actualSHA=sha256(try Data(contentsOf:url));if let expected=result["sha256"] as? String,expected != actualSHA{throw DesktopError.message("PDF 实际字节与下载校验不符，未打开")};currentPDFReceipt=result.filter{["validatedAt","isStale","cacheStatus","currentness","notices","publicSHA256","offlineMode"].contains($0.key)};if pdfOwner==owner,currentPDFSHA==actualSHA,pdfView.document?.isLocked==false{let nextVersion=result["version"] as? String ?? "";if nextVersion != pdfVersion{selectionSource=[:]};pdfVersion=nextVersion;currentPDFPath=url;return};selectionSource=[:];currentPDFSHA=actualSHA;currentPDFPath=url;pdfOwner=owner;pdfVersion=result["version"] as? String ?? "";pdfView.document=doc;pendingPDFPage=((store.value["readingState"] as? [String:[String:Any]])?[owner]?["pdfPage"] as? Int) ?? 1;annotationsByID=[:]
        for entry in store.annotations(id:currentPaperID) where entry["pdfSHA"] as? String==currentPDFSHA {
            guard let page=entry["page"] as? Int,let target=doc.page(at:page-1),let rect=entry["rect"] as? String,let id=entry["id"] as? String else{continue}
            let mark=PDFAnnotation(bounds:NSRectFromString(rect),forType:.highlight,withProperties:nil);mark.color=NSColor.systemYellow.withAlphaComponent(0.35);mark.contents=entry["text"] as? String;target.addAnnotation(mark);annotationsByID[id]=mark
        }
    }
    func pdfStatus()->[String:Any]{
        let doc=pdfView.document
        let pageTextStatus:String
        if pdfOwner==currentPaperID,let doc,!doc.isLocked,let page=pdfView.currentPage,doc.index(for:page) != NSNotFound {
            pageTextStatus=(page.string ?? "").trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ? "empty":"available"
        }else{pageTextStatus="unknown"}
        return ["pageTextStatus":pageTextStatus,"paperID":currentPaperID,"contextGeneration":contextGeneration,"pageCount":doc?.pageCount ?? 0,"page":pdfView.currentPage.flatMap{doc?.index(for:$0)}.map{$0+1} ?? 1,"scale":pdfView.scaleFactor,"sha256":currentPDFSHA,"version":pdfVersion,"currentness":currentPDFReceipt["currentness"] ?? "not-checked","isStale":currentPDFReceipt["isStale"] ?? false,"notices":currentPDFReceipt["notices"] ?? []]}
    func installPDFObservers() {
        guard !pdfObserversInstalled else{return};pdfObserversInstalled=true
        NotificationCenter.default.addObserver(self,selector:#selector(pdfPageChanged),name:.PDFViewPageChanged,object:pdfView)
        NotificationCenter.default.addObserver(self,selector:#selector(pdfSelectionChanged),name:.PDFViewSelectionChanged,object:pdfView)
        NotificationCenter.default.addObserver(self,selector:#selector(pdfScaleChanged),name:.PDFViewScaleChanged,object:pdfView)
    }
    @objc func pdfScaleChanged(_ notification:Notification) {
        guard notification.object as? PDFView === pdfView,!pdfOwner.isEmpty,pdfOwner==currentPaperID,!currentPDFSHA.isEmpty,let document=pdfView.document,!document.isLocked else{return}
        emit("pdf.scaleChanged",["paperID":pdfOwner,"contextGeneration":contextGeneration,"sha256":currentPDFSHA,"scale":pdfView.scaleFactor],to:[web].compactMap{$0})
    }
    @objc func pdfPageChanged(){emit("pdf.changed",pdfStatus())}
    @objc func pdfSelectionChanged(){
        guard let selection=pdfView.currentSelection,let text=selection.string,!text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,let doc=pdfView.document,pdfOwner==currentPaperID,selection.pages.allSatisfy({doc.index(for:$0) != NSNotFound}) else{selectionSource=[:];emit("pdf.selection",["paperID":currentPaperID,"cleared":true,"pages":[]]);return}
        let pages=selection.pages.map{doc.index(for:$0)+1};selectionSource=["paperID":currentPaperID,"text":text,"characters":text.count,"truncated":false,"pages":pages,"page":pages.first ?? 1,"pdfSHA":currentPDFSHA,"sourceVersion":pdfVersion,"kind":"pdf-selection","currentness":currentPDFReceipt["currentness"] ?? "not-checked","isStale":currentPDFReceipt["isStale"] ?? false,"notices":currentPDFReceipt["notices"] ?? []]
        emit("pdf.selection",selectionSource)
    }
    func addHighlight() throws->[String:Any]{
        guard pdfOwner==currentPaperID,let selected=pdfView.currentSelection,let doc=pdfView.document else{throw DesktopError.message("请先在当前 PDF 中选择实际文字")}
        var entries=store.annotations(id:currentPaperID),pending:[(String,PDFPage,PDFAnnotation)]=[]
        for line in selected.selectionsByLine(){for page in line.pages{
            guard doc.index(for:page) != NSNotFound else{throw DesktopError.message("选区不属于当前 PDF")};let id=UUID().uuidString,rect=line.bounds(for:page)
            entries.append(["id":id,"text":line.string ?? "","page":doc.index(for:page)+1,"rect":NSStringFromRect(rect),"pdfSHA":currentPDFSHA,"createdAt":ISO8601DateFormatter().string(from:Date())])
            let annotation=PDFAnnotation(bounds:rect,forType:.highlight,withProperties:nil);annotation.color=NSColor.systemYellow.withAlphaComponent(0.35);annotation.contents=line.string;pending.append((id,page,annotation))
        }}
        try store.replaceAnnotations(id:currentPaperID,entries:entries)
        for(id,page,annotation) in pending{page.addAnnotation(annotation);annotationsByID[id]=annotation}
        return ["annotations":entries]
    }
    func pdfChapters()->[[String:Any]] {
        guard pdfOwner==currentPaperID,let doc=pdfView.document,let root=doc.outlineRoot else{return []}
        var rows:[[String:Any]]=[]
        func visit(_ node:PDFOutline,depth:Int){if let page=node.destination?.page,let title=node.label,!title.isEmpty{rows.append(["title":title,"page":doc.index(for:page)+1,"depth":depth])};for index in 0..<node.numberOfChildren{if let child=node.child(at:index){visit(child,depth:depth+1)}}}
        for index in 0..<root.numberOfChildren{if let node=root.child(at:index){visit(node,depth:0)}}
        for index in rows.indices {let start=rows[index]["page"] as! Int;let depth=rows[index]["depth"] as! Int;let next=rows.dropFirst(index+1).first{($0["depth"] as? Int ?? 0)<=depth && ($0["page"] as? Int ?? 0)>start}?["page"] as? Int;rows[index]["endPage"]=next.map{$0-1} ?? doc.pageCount}
        return rows
    }
    func modelSource(_ payload:[String:Any]) throws->[String:Any]{
        let scope=payload["scope"] as? String ?? "selection"
        guard ["selection","guide","page","range","chapter","full"].contains(scope) else{throw DesktopError.message("材料范围无效，未发送请求")}
        if scope=="selection"{guard pdfOwner==currentPaperID,selectionSource["paperID"] as? String==currentPaperID,selectionSource["pdfSHA"] as? String==currentPDFSHA,selectionSource["sourceVersion"] as? String==pdfVersion,!selectionSource.isEmpty,(selectionSource["text"] as? String ?? "").count<=240000 else{throw DesktopError.message("选区缺失、版本已变化或超过材料上限；请先选择当前 PDF 中的文字，或改用当前页/全文/网站导读")};var source=selectionSource;let defaults:[String:Any]=["currentness":"not-checked","isStale":false,"cacheStatus":"unknown","notices":[],"validatedAt":"","offlineMode":false];for(key,fallback) in defaults{source[key]=currentPDFReceipt[key] ?? fallback};return source}
        if scope=="guide"{guard currentArticle["paperID"] as? String==currentPaperID,let text=currentArticle["plainText"] as? String,!text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,text.count<=240000 else{throw DesktopError.message("当前导读未准备好或超过材料上限，请选择有效的 PDF 范围")};return ["kind":"published-reader","paperID":currentPaperID,"text":currentArticle["plainText"] ?? "","sourceURL":currentArticle["sourceURL"] ?? "","revision":currentArticle["revisionSHA256"] ?? "","sourceVersion":currentArticle["sourceVersion"] ?? "","isStale":currentArticle["isStale"] ?? false,"offlineMode":currentArticle["offlineMode"] ?? false,"cacheStatus":currentArticle["cacheStatus"] ?? "unknown","notices":currentArticle["notices"] ?? [],"fetchedAt":currentArticle["fetchedAt"] ?? ""]}
        guard pdfOwner==currentPaperID,let doc=pdfView.document,!doc.isLocked else{throw DesktopError.message("请先打开当前论文的原始 PDF")}
        var pages:[Int]=[];if scope=="chapter"{let chapters=pdfChapters();guard let index=payload["chapter"] as? Int,index>=0,index<chapters.count,let first=chapters[index]["page"] as? Int,let last=chapters[index]["endPage"] as? Int else{throw DesktopError.message("此 PDF 没有可核对的章节目录，请使用实际页范围")};pages=Array((first-1)..<last)}else if scope=="page"{guard let page=pdfView.currentPage,doc.index(for:page) != NSNotFound else{throw DesktopError.message("当前 PDF 页面尚未准备好，未回退发送全文")};pages=[doc.index(for:page)]}else if scope=="range"{let from=payload["from"] as? Int ?? 1,to=payload["to"] as? Int ?? from;guard from>=1,to>=from,to<=doc.pageCount else{throw DesktopError.message("请输入当前 PDF 中有效的物理页范围")};pages=Array((from-1)..<to)}else{pages=Array(0..<doc.pageCount)}
        var text="",missing:[Int]=[];for index in pages{guard let contents=doc.page(at:index)?.string,!contents.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{missing.append(index+1);continue};text+="\n[p.\(index+1)]\n\(contents)\n"}
        guard !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{throw DesktopError.message("此 PDF 未提取到可用文字；可继续阅读原件，当前模型输入不支持扫描图像 OCR")}
        guard text.count<=240000 else{throw DesktopError.message("所选材料超过 240000 字符，未发送付费请求；请使用选区、当前页或较小页范围")};let truncated=false
        return ["kind":scope,"paperID":currentPaperID,"pdfSHA":currentPDFSHA,"sourceVersion":pdfVersion,"pages":pages.map{$0+1},"text":text,"truncated":truncated,"missingTextPages":missing,"completeTextCoverage":missing.isEmpty,"currentness":currentPDFReceipt["currentness"] ?? "not-checked","isStale":currentPDFReceipt["isStale"] ?? false,"cacheStatus":currentPDFReceipt["cacheStatus"] ?? "unknown","validatedAt":currentPDFReceipt["validatedAt"] ?? "","notices":currentPDFReceipt["notices"] ?? [],"offlineMode":currentPDFReceipt["offlineMode"] ?? false]
    }
    func findQuery(_ target:String)->[String:Any] {
        let alert=NSAlert();alert.messageText="查找"+target;let field=NSSearchField(frame:NSRect(x:0,y:0,width:330,height:26));field.placeholderString="输入要查找的原文文字";alert.accessoryView=field;alert.addButton(withTitle:"查找");alert.addButton(withTitle:"取消")
        guard alert.runModal() == .alertFirstButtonReturn else{return ["cancelled":true]};return ["query":field.stringValue,"cancelled":false]
    }
    func setModelKey() throws {
        let alert=NSAlert();alert.messageText="保存模型 API 密钥";alert.informativeText="密钥只进入 macOS 钥匙串，不返回网页内容、日志或备份。";let field=NSSecureTextField(frame:NSRect(x:0,y:0,width:360,height:26));field.placeholderString="输入你自己的 API 密钥";alert.accessoryView=field;alert.addButton(withTitle:"保存到钥匙串");alert.addButton(withTitle:"取消")
        guard alert.runModal() == .alertFirstButtonReturn else{throw DesktopOperationCancelled("已取消，原配置保留")};guard !field.stringValue.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{throw DesktopError.message("密钥不能为空")};try DesktopKeychain.save(field.stringValue,account:"primary");field.stringValue=""
    }
    func configureSchedule(){schedule?.invalidate();let hours=max(1,min(168,store.setting("syncHours") as? Int ?? 12));schedule=Timer.scheduledTimer(withTimeInterval:Double(hours)*3600,repeats:true){[weak self]_ in Task{@MainActor in self?.syncNow()}}}
    @objc func didWake(){if Date().timeIntervalSince(lastSyncAttempt)>300{syncNow()}}
    func syncCatalog(payload:[String:Any])async throws->[String:Any] {
        if let flight=catalogSyncFlight{return try await flight.task.value}
        let id=UUID();lastSyncAttempt=Date()
        let task=Task{@MainActor in
            defer{if self.catalogSyncFlight?.id==id{self.catalogSyncFlight=nil}}
            let result=try await self.runJob("library.sync",payload:payload){notify in try await self.library.handle(command:"library.sync",payload:payload,progress:notify)}
            self.emit("library.changed")
            return result
        }
        catalogSyncFlight=(id,task)
        return try await task.value
    }
    @objc func syncNow(){
        guard catalogSyncFlight==nil else{return}
        lastSyncAttempt=Date()
        Task{
            guard catalogSyncFlight==nil else{return}
            do{_=try await dispatch("library.sync",payload:[:])}catch{emit("app.error",["message":error.localizedDescription])}
        }
    }
    @objc func openSettings(){showSettingsWindow()}
    @objc func toggleSidebar(){guard mainContextMenuAvailable() else{return};emit("menu.command",["action":"sidebar"])}
    @objc func togglePDF(){guard mainContextMenuAvailable() else{return};emit("menu.command",["action":"pdf"])}
    @objc func findCurrent(){guard mainContextMenuAvailable() else{return};if findNativeAggregate(){return};let focused=(window.firstResponder as? NSView).map{$0 === pdfView || $0.isDescendant(of:pdfView)} ?? false;emit("menu.command",["action":"find","pdfFocused":focused])}
    @objc func findLibrary(){guard mainContextMenuAvailable() else{return};emit("menu.command",["action":"search"])}
    @objc func fontLarger(){guard mainContextMenuAvailable() else{return};emit("menu.command",["action":"font","delta":1])}
    @objc func fontSmaller(){guard mainContextMenuAvailable() else{return};emit("menu.command",["action":"font","delta":-1])}
    @objc func fullScreen(){guard mainContextMenuAvailable() else{return};window.toggleFullScreen(nil)}
    @objc func hideApp(){NSApp.hide(nil)}
    @objc func quit(){NSApp.terminate(nil)}
    @objc func closeWindow(){NSApp.keyWindow?.performClose(nil)}
    @objc func about(){NSApp.orderFrontStandardAboutPanel(options:[.applicationName:"论文速递工作台",.version:Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "1.0.1",.credits:AboutLicenses.credits()])}
    @objc func helpPage(){guard mainContextMenuAvailable() else{return};emit("menu.command",["action":"help"])}
    @objc func revealData(){NSWorkspace.shared.activateFileViewerSelecting([directory])}
    @objc func openLocal(){guard mainContextMenuAvailable() else{return};Task{do{try await flushEdits();try importLocalPDF()}catch{showError(error)}}}
    @objc func exportResearch(){guard mainContextMenuAvailable() else{return};emit("menu.command",["action":"export"])}
    @objc func backup(){guard mainContextMenuAvailable() else{return};Task{do{try await flushEdits();try await backupData()}catch{showError(error)}}}
    @objc func restore(){guard mainContextMenuAvailable() else{return};Task{do{try await flushEdits();try await restoreData();emit("personal.changed")}catch{showError(error)}}}
    @objc func exportDiagnostics(){guard mainContextMenuAvailable() else{return};Task{do{try await diagnostics()}catch{showError(error)}}}
    @objc func printPDF(){guard mainContextMenuAvailable() else{return};guard let doc=pdfView.document else{showError(DesktopError.message("请先打开原文 PDF"));return};doc.printOperation(for:NSPrintInfo.shared,scalingMode:.pageScaleToFit,autoRotate:true)?.runModal(for:window,delegate:nil,didRun:nil,contextInfo:nil)}
    func showError(_ error:Error){guard !(error is DesktopOperationCancelled) else{return};let alert=NSAlert();alert.messageText="操作未能完成";alert.informativeText=error.localizedDescription;alert.runModal()}
}
