import AppKit
import WebKit

extension PaperDigestApp {
    var nativeTasksContext:NativeTaskHostContext{.init(owner:.init(windowID:nativeTaskWindowID,documentID:nativeTaskDocumentID,contextGeneration:contextGeneration),paperID:currentPaperID)}
    func installNativeTasks(){
        retireNativeTasks(restoreFocus:true);nativeTaskWindowID=UUID()
        let coordinator=NativeTaskHostCoordinator(context:nativeTasksContext);nativeTaskCoordinator=coordinator
        let route=NativeTaskRouteGate(owner:nativeTasksContext.owner)
        let controller=NativeTasksController(route:route,provider:{[weak self] in guard let self,let store=self.store else{throw NativeTaskPresentationError.recordsUnavailable};return .init(jobs:store.value["jobs"] as? [[String:Any]],sessions:store.value["sessions"] as? [[String:Any]],liveJobIDs:Set(self.jobs.keys))},callbacks:.init(sourceBound:{[weak self,weak coordinator] lease in guard let self,let coordinator else{throw NativeTaskPresentationError.stale};return try await self.performNativeTaskAction(lease,coordinator:coordinator)}))
        nativeTaskController=controller;let view=controller.view;view.isHidden=true
        updateNativeTasksAppearance()
    }
    func updateNativeTasksAppearance(){let name=store?.setting("appearance") as? String ?? "system";nativeTaskController?.view.appearance=name=="dark" ? NSAppearance(named:.darkAqua):name=="light" ? NSAppearance(named:.aqua):nil}
    func nativeTasksContextDidChange(){
        nativeTasksRequestedVisible=false;guard let coordinator=nativeTaskCoordinator else{return};coordinator.replaceContext(nativeTasksContext);if nativeTaskController?.route.owner != nativeTasksContext.owner{nativeTaskController?.route.replaceOwner(nativeTasksContext.owner)};retireNativeTasks(restoreFocus:true)
        emit("nativeTasks.layout")
    }
    func retireNativeTasks(restoreFocus:Bool){
        nativeTaskCoordinator?.retire()
        if restoreFocus,let root=nativeTaskController?.view,let responder=window?.firstResponder as? NSView,responder===root || responder.isDescendant(of:root){window?.makeFirstResponder(web)}
        nativeTaskController?.retire()
        nativeTaskController?.view.removeFromSuperview()
    }
    func nativeTasksObservedDOM(source:WKWebView)async throws->NativeTaskDOMObservation{
        let script="""
        const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
        const t=document.getElementById('tasks-view'),s=document.querySelector('.sidebar'),m=document.querySelector('.main-pane'),bar=document.querySelector('.toolbar');
        return {clientID:document.documentElement.getAttribute('data-native-tasks-document')||'',focusIntent:document.documentElement.getAttribute('data-native-tasks-focus-intent')||'',tasksVisible:!!t&&!t.hidden&&getComputedStyle(t).display!=='none',blocked:!!document.querySelector('[data-dialog-surface][open]'),width:innerWidth,height:innerHeight,main:rect(m),toolbar:rect(bar),sidebarVisible:!!s&&getComputedStyle(s).display!=='none',sidebar:rect(s),tasks:rect(t)};
        """
        guard let raw=try await source.callAsyncJavaScript(script,arguments:[:],in:nil,contentWorld:.defaultClient) as? [String:Any] else{throw NativeTaskPresentationError.invalidLayout};return try .init(raw)
    }
    func nativeTasksMessage(_ command:String,payload:[String:Any],source:WKWebView,frameURL:URL?,isMainFrame:Bool)async throws->[String:Any]{
        guard NativeTaskHostCoordinator.sourceAllowed(isMainView:source===web,isMainFrame:isMainFrame,url:frameURL),let coordinator=nativeTaskCoordinator,let controller=nativeTaskController else{throw DesktopError.message("任务视图只能由当前应用主页面显示")}
        let context=nativeTasksContext;coordinator.replaceContext(context);if controller.route.owner != context.owner{controller.route.replaceOwner(context.owner)}
        guard !terminationPending,!maintenanceBusy,!storageDetailsActive,window?.attachedSheet==nil,NSApp?.modalWindow==nil else{retireNativeTasks(restoreFocus:false);throw DesktopError.message("请先完成当前保存或资料操作，再打开任务")}
        if command=="nativeTasks.bootstrap"{
            guard Set(payload.keys)==Set(["clientID","paperID"]),let client=payload["clientID"] as? String,let paper=NativeTaskProjection.identifier(payload["paperID"],empty:true) else{throw NativeTaskPresentationError.stale}
            let observed=try await nativeTasksObservedDOM(source:source)
            guard source===web,nativeTasksContext==context,!terminationPending,!maintenanceBusy,!storageDetailsActive else{throw NativeTaskPresentationError.stale}
            return try coordinator.bootstrap(client:client,paperID:paper,observedClient:observed.clientID,current:nativeTasksContext)
        }
        guard command=="nativeTasks.present" else{throw NativeTaskPresentationError.stale}
        let request=try NativeTaskPresentRequest(payload)
        guard !request.tasks || !nativeNotesRequestedVisible else{throw NativeTaskPresentationError.stale}
        let ticket=try coordinator.reserve(request,current:context)
        nativeTasksRequestedVisible=request.tasks
        if request.tasks{controller.prepareForLayout(sequence:request.sequence,focusIntent:request.focusIntent,keyboardSource:source)}else{
            guard nativeTaskController===controller,nativeTaskCoordinator===coordinator,nativeTasksContext==context,coordinator.isLatest(ticket,current:nativeTasksContext) else{throw NativeTaskPresentationError.stale}
            if let responder=window?.firstResponder as? NSView,responder===controller.view || responder.isDescendant(of:controller.view){window?.makeFirstResponder(web)}
            controller.retire()
        }
        do{
            let observation=request.tasks ? try await nativeTasksObservedDOM(source:source):nil
            guard source===web,nativeTasksContext==context,!terminationPending,!maintenanceBusy,!storageDetailsActive else{throw NativeTaskPresentationError.stale}
            let f=web.frame,frame=NativeTaskRectangle(x:f.minX,y:f.minY,width:f.width,height:f.height)
            if let ready=try coordinator.finish(ticket,current:nativeTasksContext,observation:observation,nativeFrame:frame,pageZoom:web.pageZoom){
                guard let content=window?.contentView,controller.view.superview==nil || controller.view.superview===content else{throw NativeTaskPresentationError.stale}
                if controller.view.superview==nil{content.addSubview(controller.view)}
                pdfView.isHidden=true;try controller.apply(ready.layout,allowedContent:ready.allowed)

            }else{retireNativeTasks(restoreFocus:true)}
            return ["accepted":true]
        }catch{if coordinator.isLatest(ticket,current:nativeTasksContext){retireNativeTasks(restoreFocus:true)};throw DesktopError.message("任务视图布局已变化，请重新选择后台任务")}
    }
    func performNativeTaskAction(_ lease:NativeTaskLease,coordinator:NativeTaskHostCoordinator)async throws->NativeTaskFeedback{
        try Task.checkCancellation();try requireMainContextAvailable()
        guard nativeTaskCoordinator===coordinator,let controller=nativeTaskController,!terminationPending,!maintenanceBusy,window?.attachedSheet==nil,NSApp?.modalWindow==nil else{throw NativeTaskPresentationError.stale}
        let context=nativeTasksContext,token=try coordinator.invocation()
        try coordinator.requireCurrent(token,current:context)
        guard let raw=store?.value["jobs"] as? [[String:Any]] else{throw NativeTaskPresentationError.recordsUnavailable}
        let current=try NativeTaskProjection.make(.init(jobs:raw,sessions:store.value["sessions"] as? [[String:Any]],liveJobIDs:Set(jobs.keys)))
        _=try controller.route.validate(lease,current:current)
        guard let sourceView=web else{throw NativeTaskPresentationError.stale}
        let observed=try await nativeTasksObservedDOM(source:sourceView)
        try Task.checkCancellation();try requireMainContextAvailable()
        guard sourceView===web,nativeTaskController===controller,nativeTaskCoordinator===coordinator,!terminationPending,!maintenanceBusy,window?.attachedSheet==nil,NSApp?.modalWindow==nil,observed.clientID==coordinator.clientForDisplay else{throw NativeTaskPresentationError.stale}
        try coordinator.requireCurrent(token,current:nativeTasksContext)
        let f=web.frame;_ = try observed.geometry(nativeFrame:.init(x:f.minX,y:f.minY,width:f.width,height:f.height),pageZoom:web.pageZoom)
        let refreshed=try NativeTaskProjection.make(.init(jobs:store.value["jobs"] as? [[String:Any]],sessions:store.value["sessions"] as? [[String:Any]],liveJobIDs:Set(jobs.keys)))
        _=try controller.route.validate(lease,current:refreshed)
        // Exact original lease, current DOM route and Core state are rechecked after the only UI await.
        switch lease.action{
        case .cancel:
            _=try await dispatch("jobs.cancel",payload:["id":lease.jobID]);try coordinator.requireCurrent(token,current:nativeTasksContext);return .requested
        case .openCloud:
            showSettingsWindow(initialPane:"cloud");return .opened
        case .resync:
            _=try await dispatch("library.sync",payload:[:]);return .requested
        case .openSaved:
            guard let paperID=lease.paperID,let view=web else{throw NativeTaskPresentationError.stale}
            let result=try await view.callAsyncJavaScript("return typeof window.paperDigestNativeTasksOpenSaved==='function' ? await window.paperDigestNativeTasksOpenSaved(nonce,sequence,paperID) : false",arguments:["nonce":coordinator.nonceForDisplay,"sequence":coordinator.highestSequence,"paperID":paperID],in:nil,contentWorld:.page)
            guard result as? Bool==true else{throw DesktopError.message("原论文当前不可达，已保存的请求与费用记录仍保留")};return .opened
        }
    }
    func webView(_ view:WKWebView,didStartProvisionalNavigation navigation:WKNavigation!){guard view===web else{return};nativeTaskDocumentID=UUID();nativeWorkspaceContextDidChange()}
    func webViewWebContentProcessDidTerminate(_ view:WKWebView){guard view===web else{return};nativeTaskDocumentID=UUID();nativeWorkspaceContextDidChange()}
}
