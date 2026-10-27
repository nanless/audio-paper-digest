import AppKit
import WebKit

extension PaperDigestApp {
    var nativeNotesContext:NativeNotesHostContext{.init(owner:.init(windowID:nativeNotesWindowID,documentID:nativeTaskDocumentID,contextGeneration:contextGeneration),paperID:currentPaperID)}
    func nativeWorkspaceContextDidChange(){retireAggregateContext();nativeTasksContextDidChange();nativeNotesContextDidChange()}
    func nativeNotesSnapshot()throws->NativeNotesSnapshot{guard let store else{throw NativeNotesError.unavailable};return try NativeNotesProjection.make(store.value)}
    func installNativeNotes(){
        retireNativeNotes(restoreFocus:true);nativeNotesWindowID=UUID()
        let coordinator=NativeNotesHostCoordinator(context:nativeNotesContext);nativeNotesCoordinator=coordinator
        let controller=NativeNotesController(route:.init(owner:nativeNotesContext.owner),provider:{[weak self] in guard let self else{throw NativeNotesError.unavailable};return try self.nativeNotesSnapshot()},open:{[weak self,weak coordinator] lease in guard let self,let coordinator else{throw NativeNotesError.stale};try await self.performNativeNotesOpen(lease,coordinator:coordinator)},close:{[weak self,weak coordinator] in guard let self,let coordinator else{throw NativeNotesError.stale};try await self.performNativeNotesClose(coordinator:coordinator)})
        nativeNotesController=controller;controller.view.isHidden=true;updateNativeNotesAppearance()
    }
    func updateNativeNotesAppearance(){let name=store?.setting("appearance") as? String ?? "system";nativeNotesController?.view.appearance=name=="dark" ? NSAppearance(named:.darkAqua):name=="light" ? NSAppearance(named:.aqua):nil}
    func retireNativeNotes(restoreFocus:Bool){
        nativeNotesCoordinator?.retire()
        if restoreFocus,let root=nativeNotesController?.view,let responder=window?.firstResponder as? NSView,responder===root || responder.isDescendant(of:root){window?.makeFirstResponder(web)}
        nativeNotesController?.retire()
        nativeNotesController?.view.removeFromSuperview()
    }
    func nativeNotesContextDidChange(){
        nativeNotesRequestedVisible=false
        guard let coordinator=nativeNotesCoordinator else{return}
        coordinator.replaceContext(nativeNotesContext);nativeNotesController?.route.replaceOwner(nativeNotesContext.owner);retireNativeNotes(restoreFocus:true);emit("nativeNotes.layout")
    }
    func nativeNotesObservedDOM(source:WKWebView)async throws->NativeNotesDOMObservation {
        let script="""
        const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
        const n=document.getElementById('notes-view'),s=document.querySelector('.sidebar'),m=document.querySelector('.main-pane'),bar=document.querySelector('.toolbar');
        return {clientID:document.documentElement.getAttribute('data-native-notes-document')||'',focusIntent:document.documentElement.getAttribute('data-native-notes-focus-intent')||'',notesVisible:!!n&&!n.hidden&&getComputedStyle(n).display!=='none',blocked:!!document.querySelector('[data-dialog-surface][open]'),width:innerWidth,height:innerHeight,main:rect(m),toolbar:rect(bar),sidebarVisible:!!s&&getComputedStyle(s).display!=='none',sidebar:rect(s),notes:rect(n)};
        """
        guard let raw=try await source.callAsyncJavaScript(script,arguments:[:],in:nil,contentWorld:.defaultClient) as? [String:Any] else{throw NativeNotesError.invalidLayout};return try .init(raw)
    }
    func nativeNotesMessage(_ command:String,payload:[String:Any],source:WKWebView,frameURL:URL?,isMainFrame:Bool)async throws->[String:Any]{
        guard NativeNotesHostCoordinator.sourceAllowed(isMainView:source===web,isMainFrame:isMainFrame,url:frameURL),let coordinator=nativeNotesCoordinator,let controller=nativeNotesController else{throw NativeNotesError.stale}
        let context=nativeNotesContext;coordinator.replaceContext(context);controller.route.replaceOwner(context.owner)
        guard !terminationPending,!maintenanceBusy,!storageDetailsActive,window?.attachedSheet==nil,NSApp?.modalWindow==nil else{nativeNotesRequestedVisible=false;retireNativeNotes(restoreFocus:false);throw NativeNotesError.stale}
        if command=="nativeNotes.bootstrap"{
            guard Set(payload.keys)==Set(["clientID","paperID"]),let client=payload["clientID"] as? String,let paper=NativeTaskProjection.identifier(payload["paperID"],empty:true) else{throw NativeNotesError.stale}
            let observed=try await nativeNotesObservedDOM(source:source)
            guard source===web,nativeNotesContext==context,!terminationPending,!maintenanceBusy,!storageDetailsActive else{throw NativeNotesError.stale}
            return try coordinator.bootstrap(client:client,paperID:paper,observedClient:observed.clientID,current:nativeNotesContext)
        }
        guard command=="nativeNotes.present" else{throw NativeNotesError.stale}
        let request=try NativeNotesPresentRequest(payload)
        guard !request.notes || !nativeTasksRequestedVisible else{throw NativeNotesError.stale}
        let ticket=try coordinator.reserve(request,current:context);nativeNotesRequestedVisible=request.notes;if request.notes{controller.prepareForLayout(sequence:request.sequence,focusIntent:request.focusIntent,keyboardSource:source)}else{
            guard nativeNotesController===controller,nativeNotesCoordinator===coordinator,nativeNotesContext==context,coordinator.isLatest(ticket,current:nativeNotesContext) else{throw NativeNotesError.stale}
            if let responder=window?.firstResponder as? NSView,responder===controller.view || responder.isDescendant(of:controller.view){window?.makeFirstResponder(web)}
            controller.retire()
        }
        do{
            let observation=request.notes ? try await nativeNotesObservedDOM(source:source):nil
            guard source===web,nativeNotesContext==context,!terminationPending,!maintenanceBusy,!storageDetailsActive,!request.notes || !nativeTasksRequestedVisible else{throw NativeNotesError.stale}
            let f=web.frame,frame=NativeTaskRectangle(x:f.minX,y:f.minY,width:f.width,height:f.height)
            if let ready=try coordinator.finish(ticket,current:nativeNotesContext,observation:observation,nativeFrame:frame,pageZoom:web.pageZoom){
                guard let content=window?.contentView,controller.view.superview==nil || controller.view.superview===content else{throw NativeNotesError.stale}
                if controller.view.superview==nil{content.addSubview(controller.view)}
                pdfView.isHidden=true;try controller.apply(ready.layout,allowed:ready.allowed);
            }
            else{retireNativeNotes(restoreFocus:true)}
            return ["accepted":true]
        }catch{if coordinator.isLatest(ticket,current:nativeNotesContext){nativeNotesRequestedVisible=false;retireNativeNotes(restoreFocus:true)};throw NativeNotesError.stale}
    }
    private func currentNativeNotesInvocation(_ coordinator:NativeNotesHostCoordinator,_ controller:NativeNotesController)async throws->NativeNotesHostInvocation{
        try Task.checkCancellation();try requireMainContextAvailable()
        guard nativeNotesCoordinator===coordinator,nativeNotesController===controller,!terminationPending,!maintenanceBusy,window?.attachedSheet==nil,NSApp?.modalWindow==nil,let source=web else{throw NativeNotesError.stale}
        let token=try coordinator.invocation();try coordinator.requireCurrent(token,current:nativeNotesContext)
        let observed=try await nativeNotesObservedDOM(source:source)
        try Task.checkCancellation();try requireMainContextAvailable()
        guard source===web,nativeNotesController===controller,nativeNotesCoordinator===coordinator,!terminationPending,!maintenanceBusy,window?.attachedSheet==nil,NSApp?.modalWindow==nil,!nativeTasksRequestedVisible,observed.clientID==coordinator.clientForDisplay else{throw NativeNotesError.stale}
        try coordinator.requireCurrent(token,current:nativeNotesContext)
        let f=web.frame;_=try observed.geometry(nativeFrame:.init(x:f.minX,y:f.minY,width:f.width,height:f.height),pageZoom:web.pageZoom);return token
    }
    func performNativeNotesOpen(_ lease:NativeNotesLease,coordinator:NativeNotesHostCoordinator)async throws{
        guard let controller=nativeNotesController else{throw NativeNotesError.stale}
        try controller.route.validate(lease,snapshot:nativeNotesSnapshot())
        _=try await currentNativeNotesInvocation(coordinator,controller)
        try controller.route.validate(lease,snapshot:nativeNotesSnapshot())
        let result=try await web.callAsyncJavaScript("return typeof window.paperDigestNativeNotesOpen==='function' ? await window.paperDigestNativeNotesOpen(nonce,sequence,paperID) : false",arguments:["nonce":coordinator.nonceForDisplay,"sequence":coordinator.highestSequence,"paperID":lease.row.paperID],in:nil,contentWorld:.page)
        guard result as? Bool==true else{throw NativeNotesError.stale}
    }
    func performNativeNotesClose(coordinator:NativeNotesHostCoordinator)async throws{
        guard let controller=nativeNotesController else{throw NativeNotesError.stale};_=try await currentNativeNotesInvocation(coordinator,controller)
        let result=try await web.callAsyncJavaScript("return typeof window.paperDigestNativeNotesClose==='function' ? await window.paperDigestNativeNotesClose(nonce,sequence) : false",arguments:["nonce":coordinator.nonceForDisplay,"sequence":coordinator.highestSequence],in:nil,contentWorld:.page)
        guard result as? Bool==true else{throw NativeNotesError.stale}
    }
}
