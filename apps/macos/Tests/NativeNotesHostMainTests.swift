import AppKit
import WebKit
private struct NotesMainFailure:Error{let message:String}
@main @MainActor struct NativeNotesHostMainTests {
    static var passed=0,failed=0
    static func check(_ ok:Bool,_ message:String)throws{if !ok{throw NotesMainFailure(message:message)}}
    static func rejects(_ body:()async throws->Void)async throws{do{try await body()}catch is NotesMainFailure{throw NotesMainFailure(message:"assertion inside refusal")}catch{return};throw NotesMainFailure(message:"expected refusal")}
    static func run(_ name:String,_ body:()async throws->Void)async{do{try await body();passed+=1;print("PASS "+name)}catch{failed+=1;print("FAIL "+name+": "+String(describing:error))}}
    static func main()async throws{
        _=NSApplication.shared;NSApp.setActivationPolicy(.prohibited)
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("native-notes-main-"+UUID().uuidString);defer{try? FileManager.default.removeItem(at:root)}
        let app=PaperDigestApp();app.directory=root;app.store=try DesktopStore(directory:root)
        _=try app.store.saveNote(id:"paper-a",text:"明确隔离笔记，不访问用户文库",baseRevision:0)
        var keyReads=0;app.model=ModelService(directory:root,store:app.store,keyProvider:{keyReads+=1;return nil})
        let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
        let web=WKWebView(frame:.init(x:0,y:0,width:1200,height:800),configuration:config),foreign=WKWebView(frame:.zero,configuration:config)
        let url=URL(string:"paperapp://app/index.html")!,client="11111111-1111-4111-8111-111111111111"
        func reset()throws->(NativeNotesHostCoordinator,NativeNotesLease,String){
            app.terminationPending=false;app.maintenanceBusy=false;app.storageDetailSession=nil;app.nativeTasksRequestedVisible=false;app.currentPaperID="paper-a";app.web=web
            let c=NativeNotesHostCoordinator(context:app.nativeNotesContext);app.nativeNotesCoordinator=c
            let ctrl=NativeNotesController(route:.init(owner:app.nativeNotesContext.owner),provider:{try app.nativeNotesSnapshot()},open:{_ in throw NativeNotesError.stale},close:{throw NativeNotesError.stale});app.nativeNotesController=ctrl
            let nonce=try c.bootstrap(client:client,paperID:"paper-a",observedClient:client,current:c.context)["nonce"] as! String
            let request=try NativeNotesPresentRequest(["nonce":nonce,"clientID":client,"paperID":"paper-a","sequence":1,"notes":true,"focus":false]),ticket=try c.reserve(request,current:c.context)
            let observation=try NativeNotesDOMObservation(["clientID":client,"notesVisible":true,"blocked":false,"width":1200,"height":800,"main":["x":220,"y":0,"width":980,"height":800],"toolbar":["x":220,"y":0,"width":980,"height":60],"sidebarVisible":true,"sidebar":["x":0,"y":0,"width":220,"height":800],"notes":["x":220,"y":60,"width":980,"height":740]])
            let ready=try c.finish(ticket,current:c.context,observation:observation,nativeFrame:.init(x:0,y:0,width:1200,height:800),pageZoom:1)!
            try ctrl.apply(ready.layout,allowed:ready.allowed);app.nativeNotesRequestedVisible=true
            return(c,try ctrl.route.issue(app.nativeNotesSnapshot().rows[0]),nonce)
        }
        let file=root.appendingPathComponent("personal.json"),before=try Data(contentsOf:file)
        for (name,source,frame,top) in [("foreign settings view",foreign,url,true),("subframe",web,url,false),("non-main application page",web,URL(string:"paperapp://app/settings.html")!,true),("HTTP source",web,URL(string:"https://app/index.html")!,true)]{
            await run("actual notes bridge rejects "+name){let(_,_,nonce)=try reset();try await rejects{_=try await app.nativeNotesMessage("nativeNotes.present",payload:["nonce":nonce,"clientID":client,"paperID":"paper-a","sequence":2,"notes":false,"focus":false],source:source,frameURL:frame,isMainFrame:top)}}
        }
        await run("actual retirement ACK needs no DOM and invalidates open lease"){let(c,lease,nonce)=try reset();let reply=try await app.nativeNotesMessage("nativeNotes.present",payload:["nonce":nonce,"clientID":client,"paperID":"paper-a","sequence":2,"notes":false,"focus":false],source:web,frameURL:url,isMainFrame:true);try check(reply["accepted"] as? Bool==true && !app.nativeNotesController!.route.current(lease),"retirement not acknowledged");try await rejects{_=try c.invocation()}}
        await run("context generation retires actual original note presentation"){let(c,lease,_)=try reset();app.contextGeneration+=1;try check(!app.nativeNotesController!.route.current(lease),"old note route retained");try await rejects{try await app.performNativeNotesOpen(lease,coordinator:c)}}
        await run("termination retires native note actions before any DOM or business"){let(c,lease,_)=try reset();app.terminationPending=true;try await rejects{try await app.performNativeNotesOpen(lease,coordinator:c)}}
        await run("maintenance retires native note actions before any DOM or business"){let(c,lease,_)=try reset();app.maintenanceBusy=true;try await rejects{try await app.performNativeNotesOpen(lease,coordinator:c)}}
        await run("detail sheet reservation retires native note actions"){let(c,lease,_)=try reset();app.storageDetailSession = .init(generation:app.contextGeneration,paperID:"paper-a",previousResponder:nil);try check(!app.nativeNotesController!.route.current(lease),"detail left actions current");try await rejects{try await app.performNativeNotesOpen(lease,coordinator:c)}}
        await run("different coordinator cannot use a current row lease"){let(_,lease,_)=try reset();let old=NativeNotesHostCoordinator(context:app.nativeNotesContext);try await rejects{try await app.performNativeNotesOpen(lease,coordinator:old)}}
        await run("Tasks visible forbids a competing Notes presentation"){let(_,_,nonce)=try reset();app.nativeTasksRequestedVisible=true;try await rejects{_=try await app.nativeNotesMessage("nativeNotes.present",payload:["nonce":nonce,"clientID":client,"paperID":"paper-a","sequence":2,"notes":true,"focus":false],source:web,frameURL:url,isMainFrame:true)}}
        await run("Notes visible forbids a competing Tasks presentation"){
            _=try reset();let c=NativeTaskHostCoordinator(context:app.nativeTasksContext);app.nativeTaskCoordinator=c
            app.nativeTaskController=NativeTasksController(route:.init(owner:c.context.owner),provider:{.init(jobs:[],sessions:[],liveJobIDs:[])},callbacks:.init(sourceBound:{_ in throw NativeTaskPresentationError.stale}))
            let nonce=try c.bootstrap(client:client,paperID:"paper-a",observedClient:client,current:c.context)["nonce"] as! String
            try await rejects{_=try await app.nativeTasksMessage("nativeTasks.present",payload:["nonce":nonce,"clientID":client,"paperID":"paper-a","sequence":1,"tasks":true,"focus":false],source:web,frameURL:url,isMainFrame:true)}
        }
        await run("page render and reread invalidate removed AX button leases without changing host sequence"){let(_,lease,_)=try reset();let ctrl=app.nativeNotesController!,sequence=ctrl.route.sequence;ctrl.setPage(0);try check(!ctrl.route.current(lease) && ctrl.route.sequence==sequence && ctrl.route.showing,"render kept old AX lease or reset host");let next=ctrl.buttons[0].lease!;try ctrl.route.validate(next,snapshot:app.nativeNotesSnapshot());ctrl.reload();try check(!ctrl.route.current(next),"reread kept removed button lease")}
        await run("ordinary native notes checks preserve source bytes and never read credentials"){try check(try Data(contentsOf:file)==before,"source note changed");try check(keyReads==0,"credential read");try check(NSApp.windows.isEmpty,"opened a window")}
        await run("changed note rejects exact previous lease before DOM") {let(c,lease,_)=try reset();_=try app.store.saveNote(id:"paper-a",text:"受控新修订",baseRevision:1);try await rejects{try await app.performNativeNotesOpen(lease,coordinator:c)}}
        print("RESULT \(passed) passed / \(failed) failed");exit(failed==0 ? 0:1)
    }
}
