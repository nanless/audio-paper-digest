import AppKit
import WebKit

@MainActor struct StorageDetailSession {
    let id=UUID().uuidString
    let generation:Int
    let paperID:String
    let previousResponder:NSResponder?
}

extension PaperDigestApp {
    var storageDetailsActive:Bool { storageDetailSession != nil }

    func requireMainContextAvailable() throws {
        guard !storageDetailsActive else { throw DesktopError.message("请先关闭本机资料窗口，再操作主阅读视图") }
    }
    func mainContextMenuAvailable()->Bool {
        guard storageDetailsActive else{return true}
        if window?.isVisible==true {storageDetailWindow?.makeKeyAndOrderFront(nil)}
        if NSApp.isRunning{NSSound.beep()};return false
    }
    func validateMenuItem(_ item:NSMenuItem)->Bool {
        guard storageDetailsActive else{return true}
        let actions:[Selector]=[#selector(toggleSidebar),#selector(togglePDF),#selector(findCurrent),#selector(findLibrary),#selector(fontLarger),#selector(fontSmaller),#selector(fullScreen),#selector(helpPage),#selector(openLocal),#selector(exportResearch),#selector(restore),#selector(printPDF),#selector(backup),#selector(exportDiagnostics)]
        return !actions.contains{item.action==$0}
    }
    func validateStorageDetail(_ source:WKWebView,id:String?=nil) throws ->StorageDetailSession {
        guard let session=storageDetailSession,source===storageDetailWeb,
              id==nil || id==session.id else{throw DesktopError.message("本机资料窗口已关闭或更新，请重新打开")}
        return session
    }
    func showStorageDetails() async throws {
        guard !terminationPending,!maintenanceBusy else{throw DesktopError.message("正在退出或整理资料，请稍后打开本机资料")}
        if storageDetailsActive {if window?.isVisible==true{storageDetailWindow?.makeKeyAndOrderFront(nil)};return}
        let generation=contextGeneration
        try await flushEdits()
        try Task.checkCancellation()
        guard generation==contextGeneration,!terminationPending,!maintenanceBusy else{throw DesktopError.message("保存期间阅读资料已变化，请重新打开本机资料")}
        // Another request may have completed its flush while this one awaited it.
        if storageDetailsActive {return}
        guard let window,let scheme else{throw DesktopError.message("主阅读窗口尚未准备完成")}
        guard window.attachedSheet==nil else{throw DesktopError.message("请先完成主阅读窗口的当前确认")}
        let session=StorageDetailSession(generation:generation,paperID:currentPaperID,previousResponder:window.firstResponder)
        let detail=NSWindow(contentRect:NSRect(x:0,y:0,width:820,height:700),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        detail.title="本机资料";detail.minSize=NSSize(width:700,height:520);detail.isReleasedWhenClosed=false;detail.delegate=self
        let configuration=WKWebViewConfiguration()
        configuration.setURLSchemeHandler(scheme,forURLScheme:"paperapp")
        configuration.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"desktop")
        let view=WKWebView(frame:detail.contentView!.bounds,configuration:configuration)
        view.autoresizingMask=[.width,.height];view.navigationDelegate=self;detail.contentView=view
        storageDetailSession=session;storageDetailWindow=detail;storageDetailWeb=view
        do {
            // Session reservation blocks native context-changing commands while
            // the real main WK invalidates older article/PDF continuations.
            let paused=try await web.callAsyncJavaScript("if(typeof window.paperDigestPauseForDetails!=='function')throw new Error('主阅读视图尚未准备完成');return window.paperDigestPauseForDetails(paperID);",arguments:["paperID":session.paperID],in:nil,contentWorld:.page) as? [String:Any]
            try Task.checkCancellation();_=try validateStorageDetail(view,id:session.id)
            guard paused?["paused"] as? Bool==true,generation==contextGeneration,!terminationPending,!maintenanceBusy else{throw DesktopError.message("阅读上下文已变化，本机资料未打开")}
            view.load(URLRequest(url:URL(string:"paperapp://app/details.html")!))
            window.beginSheet(detail){[weak self,weak detail] _ in
                guard let self,let detail,self.storageDetailWindow===detail else{return}
                self.finishStorageDetails(sessionID:session.id)
            }
        }catch{finishStorageDetails(sessionID:session.id);throw error}
    }
    func finishStorageDetails(sessionID:String){
        guard let session=storageDetailSession,session.id==sessionID else{return}
        let view=storageDetailWeb
        view?.evaluateJavaScript("window.dispatchEvent(new Event('details.closed'))",completionHandler:nil)
        storageDetailSession=nil;storageDetailWindow?.orderOut(nil)
        storageDetailWindow=nil;storageDetailWeb=nil
        if window?.isVisible==true {
            if let previous=session.previousResponder as? NSView,previous.window===window{window.makeFirstResponder(previous)}
            else{window.makeFirstResponder(web)}
        }
    }
    @discardableResult func closeStorageDetails()->Bool {
        guard let session=storageDetailSession,let detail=storageDetailWindow else{return true}
        guard !storageDetailBusy,!storageDetailSystemPanel else{if NSApp.isRunning{NSSound.beep()};return false}
        if let parent=detail.sheetParent{parent.endSheet(detail)}
        finishStorageDetails(sessionID:session.id);return true
    }
    func storageDetailCommand(_ command:String,payload:[String:Any],source:WKWebView) async throws->[String:Any] {
        let session=try validateStorageDetail(source,id:command=="details.bootstrap" ? nil:payload["presentationID"] as? String)
        guard command=="details.bootstrap" || payload["presentationID"] as? String==session.id else{throw DesktopError.message("本机资料窗口身份缺失")}
        guard !terminationPending else{throw DesktopError.message("正在保存并退出，未开始新操作")}
        if command=="details.bootstrap" {
            return ["presentationID":session.id,"title":"本机资料","appearance":store.setting("appearance") as? String ?? "system"]
        }
        if command=="details.close" {return ["closed":closeStorageDetails()]}
        guard !maintenanceBusy,!storageDetailBusy else{throw DesktopError.message("正在整理资料，请等待当前操作完成")}
        let result:[String:Any]
        switch command {
        case "storage.status": result=try await storage.capacity()
        case "storage.packages": result=["packages":try await storage.listPackages()]
        case "storage.cleanupPlan": result=try await storage.cleanupPlan()
        case "app.revealData":revealData();result=[:]
        case "storage.cleanup":
            storageDetailBusy=true
            defer{storageDetailBusy=false}
            result=try await cleanupStorage(payload)
        case "storage.open":
            guard let identifier=payload["id"] as? String else{throw DesktopError.message("请选择真实离线快照")}
            // Validate the actual private package before leaving a useful window.
            // openOffline revalidates actual bytes again; this JSON is not authority.
            _=try await storage.openPackage(id:identifier)
            try Task.checkCancellation()
            _=try validateStorageDetail(source,id:session.id)
            guard !terminationPending,!maintenanceBusy,session.generation==contextGeneration else{throw DesktopError.message("阅读上下文已变化，请重新打开本机资料")}
            var handoff=false
            do {
                _=try await openOffline(["id":identifier],beforeInstall:{actual in
                    _=try self.validateStorageDetail(source,id:session.id)
                    guard session.generation==self.contextGeneration else{throw DesktopError.message("阅读上下文已变化，离线包未安装")}
                    self.storageDetailBusy=true;handoff=true
                    let acknowledgement=try await self.web.callAsyncJavaScript("if(typeof window.paperDigestInstallOfflineReceipt!=='function')throw new Error('主阅读视图未能接收离线快照');return await window.paperDigestInstallOfflineReceipt(receipt,presentationID,previousPaperID);",arguments:["receipt":actual,"presentationID":session.id,"previousPaperID":session.paperID],in:nil,contentWorld:.page) as? [String:Any]
                    _=try self.validateStorageDetail(source,id:session.id)
                    guard self.contextGeneration==session.generation,acknowledgement?["installed"] as? Bool==true,acknowledgement?["paperID"] as? String==(actual["paper"] as? [String:Any])?["id"] as? String,acknowledgement?["offlinePackageID"] as? String==identifier else{throw DesktopError.message("主阅读视图没有确认同一离线快照，未完成打开")}
                },afterInstall:{
                    self.storageDetailBusy=false
                    _=self.closeStorageDetails()
                    self.web.callAsyncJavaScript("window.paperDigestFinishOfflineReceipt?.(presentationID);",arguments:["presentationID":session.id],in:nil,in:.page,completionHandler:nil)
                })
                return ["opened":true]
            }catch{
                if handoff {
                    _=try? await web.callAsyncJavaScript("return await window.paperDigestCancelOfflineReceipt?.(presentationID,current);",arguments:["presentationID":session.id,"current":["paper":currentPaper,"article":currentArticle]],in:nil,contentWorld:.page)
                }
                storageDetailBusy=false
                throw error
            }
        default:throw DesktopError.message("本机资料窗口不支持此操作")
        }
        try Task.checkCancellation()
        _=try validateStorageDetail(source,id:session.id)
        return result
    }
    func confirmStorageCleanup(_ alert:NSAlert) async ->NSApplication.ModalResponse {
        let parent=storageDetailWindow ?? window
        if let injected=storageCleanupConfirmation{return await injected(alert,parent)}
        guard let parent else{return .alertSecondButtonReturn}
        storageDetailSystemPanel=true;defer{storageDetailSystemPanel=false}
        return await withCheckedContinuation{continuation in
            alert.beginSheetModal(for:parent){response in continuation.resume(returning:response)}
        }
    }
}
