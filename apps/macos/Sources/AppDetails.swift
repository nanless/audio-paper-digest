import AppKit
import WebKit

enum NativeDetailKind:String,Hashable { case storage,help,export,zotero
    case sourceNotices="source-notices"
    var title:String {switch self {case .storage:return "本机资料";case .help:return "使用说明";case .export:return "导出当前研究";case .zotero:return "存入 Zotero";case .sourceNotices:return "导读来源说明"}}
}
// Only this file can mint a document operation capability. JSON/session strings
// alone cannot authorize source-dependent work or native panels.
@MainActor final class DetailDocumentAccess {
    fileprivate let sessionID:String,generation:Int,paperID:String,kind:NativeDetailKind
    fileprivate weak var source:WKWebView?
    fileprivate init(session:StorageDetailSession,source:WKWebView){sessionID=session.id;generation=session.generation;paperID=session.paperID;kind=session.kind;self.source=source}
}
@MainActor struct StorageDetailSession {
    let id=UUID().uuidString
    let generation:Int
    let paperID:String
    let previousResponder:NSResponder?
    var kind:NativeDetailKind = .storage
    var sourceNoticeSnapshot:ReaderSourceNoticeSnapshot? = nil
}

extension PaperDigestApp {
    var storageDetailsActive:Bool { storageDetailSession != nil }

    func requireMainContextAvailable() throws {
        guard !storageDetailsActive else { throw DesktopError.message("请先关闭详情窗口，再操作主阅读视图") }
    }
    func mainContextMenuAvailable()->Bool {
        guard storageDetailsActive else{return true}
        if window?.isVisible==true {storageDetailWindow?.makeKeyAndOrderFront(nil)}
        if NSApp.isRunning{NSSound.beep()};return false
    }
    func validateMenuItem(_ item:NSMenuItem)->Bool {
        if item.action == #selector(focusAggregateBody){return aggregateNativeHost?.bodyFocusAvailable == true}
        if item.action == #selector(focusAggregateNavigation){return aggregateNativeHost?.navigationFocusAvailable == true}
        if aggregateSession != nil || aggregateTransitionPending {let paperActions:[Selector]=[#selector(togglePDF),#selector(printPDF),#selector(exportResearch)];if paperActions.contains(where:{item.action==$0}){return false}}
        guard storageDetailsActive else{return true}
        let actions:[Selector]=[#selector(toggleSidebar),#selector(togglePDF),#selector(findCurrent),#selector(findLibrary),#selector(fontLarger),#selector(fontSmaller),#selector(fullScreen),#selector(helpPage),#selector(openLocal),#selector(exportResearch),#selector(restore),#selector(printPDF),#selector(backup),#selector(exportDiagnostics)]
        return !actions.contains{item.action==$0}
    }
    func validateStorageDetail(_ source:WKWebView,id:String?=nil) throws ->StorageDetailSession {
        guard let session=storageDetailSession,source===storageDetailWeb,
              id==nil || id==session.id else{throw DesktopError.message("详情窗口已关闭或更新，请重新打开")}
        return session
    }
    func requireDocumentContext(_ access:DetailDocumentAccess?,kinds:Set<NativeDetailKind>) throws {
        guard let access else{try requireMainContextAvailable();return}
        guard let session=storageDetailSession,let view=storageDetailWeb,
              storageDetailDocumentAccess===access,access.source===view,
              session.id==access.sessionID,session.generation==access.generation,
              session.paperID==access.paperID,session.kind==access.kind,kinds.contains(access.kind),
              contextGeneration==access.generation,currentPaperID==access.paperID,
              !terminationPending else{throw DesktopError.message("详情窗口的原始资料已变化或关闭，操作未继续")}
    }
    func showStorageDetails() async throws {try await showNativeDetails(.storage)}
    func showNativeDetails(_ kind:NativeDetailKind,sourceRequest:ReaderSourceNoticeRequest?=nil) async throws {
        guard !terminationPending,!maintenanceBusy else{throw DesktopError.message("正在退出或整理资料，请稍后打开本机资料")}
        if storageDetailsActive {
            if kind == .sourceNotices {throw ReaderSourceNoticeError.changed}
            if window?.isVisible==true{storageDetailWindow?.makeKeyAndOrderFront(nil)};return
        }
        let generation=contextGeneration
        let sourceNoticeSnapshot:ReaderSourceNoticeSnapshot?
        if kind == .sourceNotices {
            guard let sourceRequest else{throw ReaderSourceNoticeError.invalidRequest}
            let original=try ReaderSourceNoticeSnapshot(paperID:currentPaperID,article:currentArticle)
            try original.requireRequest(sourceRequest);sourceNoticeSnapshot=original
        }else{sourceNoticeSnapshot=nil}
        try await flushEdits()
        try Task.checkCancellation()
        guard generation==contextGeneration,!terminationPending,!maintenanceBusy else{throw DesktopError.message("保存期间阅读资料已变化，请重新打开本机资料")}
        try sourceNoticeSnapshot?.requireCurrent(paperID:currentPaperID,article:currentArticle)
        // Another request may have completed its flush while this one awaited it.
        if storageDetailsActive {if kind == .sourceNotices {throw ReaderSourceNoticeError.changed};return}
        guard let window,let scheme else{throw DesktopError.message("主阅读窗口尚未准备完成")}
        guard window.attachedSheet==nil else{throw DesktopError.message("请先完成主阅读窗口的当前确认")}
        if kind == .export || kind == .zotero {guard !currentPaperID.isEmpty else{throw DesktopError.message("请先选择论文")}}
        let session=StorageDetailSession(generation:generation,paperID:currentPaperID,previousResponder:window.firstResponder,kind:kind,sourceNoticeSnapshot:sourceNoticeSnapshot)
        let detail=NSWindow(contentRect:NSRect(x:0,y:0,width:820,height:700),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        detail.title=kind.title;detail.minSize=NSSize(width:700,height:520);detail.isReleasedWhenClosed=false;detail.delegate=self
        let configuration=WKWebViewConfiguration()
        configuration.setURLSchemeHandler(scheme,forURLScheme:"paperapp")
        configuration.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"desktop")
        let view=WKWebView(frame:detail.contentView!.bounds,configuration:configuration)
        view.autoresizingMask=[.width,.height];view.navigationDelegate=self;detail.contentView=view
        storageDetailSession=session;storageDetailWindow=detail;storageDetailWeb=view
        storageDetailDocumentAccess = kind == .sourceNotices ? nil:DetailDocumentAccess(session:session,source:view);storageDetailArchiveMaterials=nil
        do {
            // Session reservation and native final guards block source changes.
            // Same-source main callbacks may still settle without invalidating
            // existing reader links, anchors, or pending UI controls.
            let paused=try await web.callAsyncJavaScript("if(typeof window.paperDigestPauseForDetails!=='function')throw new Error('主阅读视图尚未准备完成');return window.paperDigestPauseForDetails(paperID);",arguments:["paperID":session.paperID],in:nil,contentWorld:.page) as? [String:Any]
            try Task.checkCancellation();_=try validateStorageDetail(view,id:session.id)
            guard paused?["paused"] as? Bool==true,generation==contextGeneration,!terminationPending,!maintenanceBusy else{throw DesktopError.message("阅读上下文已变化，本机资料未打开")}
            try sourceNoticeSnapshot?.requireCurrent(paperID:currentPaperID,article:currentArticle)
            view.load(URLRequest(url:URL(string:"paperapp://app/details.html")!))
            window.beginSheet(detail){[weak self,weak detail] _ in
                guard let self,let detail,self.storageDetailWindow===detail else{return}
                self.finishStorageDetails(sessionID:session.id)
            }
        }catch{finishStorageDetails(sessionID:session.id);throw error}
    }
    func sourceNoticePresentation(_ request:ReaderSourceNoticeRequest)throws->[String:Any] {
        guard let session=storageDetailSession,session.kind == .sourceNotices,
              session.generation==contextGeneration,session.paperID==currentPaperID,
              let view=storageDetailWeb,let detail=storageDetailWindow,
              detail.contentView===view,detail.sheetParent===window,
              let original=session.sourceNoticeSnapshot else{throw ReaderSourceNoticeError.changed}
        try original.requireRequest(request)
        try original.requireCurrent(paperID:currentPaperID,article:currentArticle)
        return ["presented":true,"paperID":original.paperID,"revisionSHA256":original.revisionSHA256]
    }
    func finishStorageDetails(sessionID:String){
        guard let session=storageDetailSession,session.id==sessionID else{return}
        let view=storageDetailWeb
        view?.evaluateJavaScript("window.dispatchEvent(new Event('details.closed'))",completionHandler:nil)
        storageDetailSession=nil;storageDetailDocumentAccess=nil;storageDetailArchiveMaterials=nil;storageDetailWindow?.orderOut(nil)
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
        guard command=="details.bootstrap" || payload["presentationID"] as? String==session.id else{throw DesktopError.message("详情窗口身份缺失")}
        guard !terminationPending else{throw DesktopError.message("正在保存并退出，未开始新操作")}
        if command=="details.bootstrap" {
            guard session.generation==contextGeneration,session.paperID==currentPaperID else{throw DesktopError.message("原阅读资料已变化，请关闭后重新打开详情")}
            if session.kind == .sourceNotices {
                guard let original=session.sourceNoticeSnapshot else{throw ReaderSourceNoticeError.unavailable}
                try original.requireCurrent(paperID:currentPaperID,article:currentArticle)
                return ["presentationID":session.id,"kind":session.kind.rawValue,"title":session.kind.title,"appearance":store.setting("appearance") as? String ?? "system","context":["title":currentPaper["titleZh"] ?? currentPaper["title"] ?? "","paperID":original.paperID,"revision":original.revisionSHA256],"sourceNotices":original.json]
            }
            return ["presentationID":session.id,"kind":session.kind.rawValue,"title":session.kind.title,"appearance":store.setting("appearance") as? String ?? "system","paper":currentPaper,"context":["title":currentPaper["titleZh"] ?? currentPaper["title"] ?? "","paperID":session.paperID,"revision":currentArticle["revisionSHA256"] ?? ""]]
        }
        if command=="details.close" {return ["closed":closeStorageDetails()]}
        guard !maintenanceBusy,!storageDetailBusy else{throw DesktopError.message("正在整理资料，请等待当前操作完成")}
        let allowed:[NativeDetailKind:Set<String>]=[
            .storage:["storage.status","storage.packages","storage.cleanupPlan","storage.cleanup","storage.open","app.revealData"],
            .help:["app.backup","app.restore","app.diagnostics"],
            .export:["app.export"],
            .sourceNotices:[],
            .zotero:["archive.materials","zotero.status","zotero.collections","zotero.authorize","zotero.checkAuthorization","zotero.archive","zotero.resume","zotero.open"]]
        guard allowed[session.kind]?.contains(command)==true else{throw DesktopError.message("此详情窗口不支持该操作")}
        guard let access=storageDetailDocumentAccess else{throw DesktopError.message("详情资料权限不可用")}
        try requireDocumentContext(access,kinds:[session.kind])
        let result:[String:Any]
        switch command {
        case "app.export":
            storageDetailBusy=true;defer{storageDetailBusy=false}
            result=try await runJob(command,payload:payload){_ in try await self.exportCurrent(payload,access:access);return ["saved":true]}
        case "app.backup":
            storageDetailBusy=true;defer{storageDetailBusy=false}
            try await flushEdits();try await backupData(access:access);result=["saved":true]
        case "app.restore":
            storageDetailBusy=true;defer{storageDetailBusy=false}
            try await flushEdits();try await restoreData(access:access)
            // Restore intentionally replaces the native context. Retire the
            // old presentation rather than allowing any callbacks to use it.
            storageDetailBusy=false;_=closeStorageDetails();return ["restored":true]
        case "app.diagnostics":
            storageDetailBusy=true;defer{storageDetailBusy=false}
            try await diagnostics(access:access);result=["saved":true]
        case "archive.materials":
            storageDetailBusy=true;defer{storageDetailBusy=false}
            let prepared=try await archiveMaterials([:],access:access)
            try requireDocumentContext(access,kinds:[.zotero])
            storageDetailArchiveMaterials=prepared;result=prepared
        case "zotero.archive":
            guard let prepared=storageDetailArchiveMaterials else{throw DesktopError.message("请先准备当前论文的真实归档材料")}
            var request=prepared
            for field in ["pdfPath","guideHTMLPath","analysisHTML","noteHTML"] {
                if payload[field]==nil{request[field]=nil}
                else{guard let original=prepared[field] as? String,payload[field] as? String==original else{throw DesktopError.message("归档材料不是本窗口准备的原始内容")}}
            }
            for field in ["collectionKey","collectionName"] {if let value=payload[field] as? String {request[field]=value}}
            storageDetailBusy=true;defer{storageDetailBusy=false}
            result=try await runJob(command,payload:request){notify in try self.requireDocumentContext(access,kinds:[.zotero]);return try await self.zotero.handle(command:command,payload:request,progress:notify)}
        case "zotero.status","zotero.collections","zotero.authorize","zotero.checkAuthorization","zotero.resume":
            storageDetailBusy=true;defer{storageDetailBusy=false}
            let request=command=="zotero.resume" ? ["resumeID":payload["resumeID"] ?? ""]:[:]
            result=try await runJob(command,payload:request){notify in try self.requireDocumentContext(access,kinds:[.zotero]);return try await self.zotero.handle(command:command,payload:request,progress:notify)}
        case "zotero.open":
            guard let key=payload["key"] as? String,key.range(of:#"\A[A-Z0-9]{8}\z"#,options:.regularExpression) != nil else{throw DesktopError.message("Zotero 条目标识无效")}
            NSWorkspace.shared.open(URL(string:"zotero://select/library/items/\(key)")!);result=[:]

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
        default:throw DesktopError.message("详情窗口不支持此操作")
        }
        try Task.checkCancellation()
        _=try validateStorageDetail(source,id:session.id)
        try requireDocumentContext(access,kinds:[session.kind])
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

extension PaperDigestApp {
    // Real system sheets are attached to the actual owner. The capability is
    // checked before display and again after dismissal, including cancellation.
    func documentPanel(_ panel:NSSavePanel,access:DetailDocumentAccess?,kinds:Set<NativeDetailKind>) async throws->NSApplication.ModalResponse {
        try requireDocumentContext(access,kinds:kinds)
        guard let parent=access == nil ? window:storageDetailWindow else{throw DesktopError.message("保存窗口的原始宿主已关闭")}
        guard parent.attachedSheet==nil else{throw DesktopError.message("请先完成当前系统窗口")}
        storageDetailSystemPanel = access != nil
        defer{if access != nil{storageDetailSystemPanel=false}}
        let result=await withCheckedContinuation{continuation in panel.beginSheetModal(for:parent){continuation.resume(returning:$0)}}
        try Task.checkCancellation();try requireDocumentContext(access,kinds:kinds)
        return result
    }
    func documentConfirmation(_ alert:NSAlert,access:DetailDocumentAccess?,kinds:Set<NativeDetailKind>) async throws->NSApplication.ModalResponse {
        try requireDocumentContext(access,kinds:kinds)
        guard let parent=access == nil ? window:storageDetailWindow else{throw DesktopError.message("确认窗口的原始宿主已关闭")}
        guard parent.attachedSheet==nil else{throw DesktopError.message("请先完成当前系统窗口")}
        storageDetailSystemPanel = access != nil
        defer{if access != nil{storageDetailSystemPanel=false}}
        let result=await withCheckedContinuation{continuation in alert.beginSheetModal(for:parent){continuation.resume(returning:$0)}}
        try Task.checkCancellation();try requireDocumentContext(access,kinds:kinds)
        return result
    }
}
