import AppKit
import WebKit
import Foundation
private struct Failure:Error{let text:String}
@main @MainActor struct NativeTasksHostMainTests{
 static var passed=0,failed=0
 static func check(_ condition:Bool,_ text:String)throws{if !condition{throw Failure(text:text)}}
 static func rejects(_ body:()async throws->Void)async throws{do{try await body()}catch is Failure{throw Failure(text:"assertion failed inside rejection")}catch{return};throw Failure(text:"expected rejection")}
 static func run(_ label:String,_ body:()async throws->Void)async{do{try await body();passed+=1;print("PASS "+label)}catch{failed+=1;print("FAIL "+label+": "+((error as? Failure)?.text ?? String(describing:type(of:error))))}}
 static func main()async throws{
  _=NSApplication.shared;NSApp.setActivationPolicy(.prohibited)
  let root=FileManager.default.temporaryDirectory.appendingPathComponent("pd-native-host-"+UUID().uuidString);try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);defer{try? FileManager.default.removeItem(at:root)}
  let app=PaperDigestApp();app.directory=root;app.store=try DesktopStore(directory:root);var keyReads=0;app.model=ModelService(directory:root,store:app.store,keyProvider:{keyReads+=1;return nil})
  app.currentPaperID="paper-a"
  let raw:[String:Any] = ["id":"saved-job","paperID":"paper-a","command":"model.run","status":"complete","title":"合成原任务","startedAt":"2026-10-25T08:05:03Z"]
  try app.store.upsertJob(raw)
  let file=root.appendingPathComponent("personal.json"),before=try Data(contentsOf:file)
  let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
  let mainView=WKWebView(frame:NSRect(x:0,y:0,width:1200,height:800),configuration:config),foreignView=WKWebView(frame:.zero,configuration:WKWebViewConfiguration());app.web=mainView
  let url=URL(string:"paperapp://app/index.html")!,client="11111111-1111-4111-8111-111111111111"
  func reset()throws->(NativeTaskHostCoordinator,NativeTaskLease,String){
   app.terminationPending=false;app.maintenanceBusy=false;app.storageDetailSession=nil;app.currentPaperID="paper-a";app.web=mainView
   let c=NativeTaskHostCoordinator(context:app.nativeTasksContext);app.nativeTaskCoordinator=c
   let route=NativeTaskRouteGate(owner:app.nativeTasksContext.owner)
   let ctrl=NativeTasksController(route:route,provider:{.init(jobs:app.store.value["jobs"] as? [[String:Any]],sessions:[],liveJobIDs:[])},callbacks:.init(sourceBound:{_ in throw NativeTaskPresentationError.stale}));app.nativeTaskController=ctrl
   let boot=try c.bootstrap(client:client,paperID:"paper-a",observedClient:client,current:app.nativeTasksContext),nonce=boot["nonce"] as! String
   let req=try NativeTaskPresentRequest(["nonce":nonce,"clientID":client,"paperID":"paper-a","sequence":1,"tasks":true,"focus":false])
   let ticket=try c.reserve(req,current:app.nativeTasksContext)
   let o=try NativeTaskDOMObservation(["clientID":client,"tasksVisible":true,"blocked":false,"width":1200,"height":800,"main":["x":220,"y":0,"width":980,"height":800],"toolbar":["x":220,"y":0,"width":980,"height":60],"sidebarVisible":true,"sidebar":["x":0,"y":0,"width":220,"height":800],"tasks":["x":220,"y":60,"width":980,"height":740]])
   let ready=try c.finish(ticket,current:app.nativeTasksContext,observation:o,nativeFrame:.init(x:0,y:0,width:1200,height:800),pageZoom:1)!
   try ctrl.apply(ready.layout,allowedContent:ready.allowed)
   let snapshot=try NativeTaskProjection.make(.init(jobs:[raw],sessions:[],liveJobIDs:[]));let lease=try route.issue(row:snapshot.rows[0],action:.openSaved)
   return(c,lease,nonce)
  }
  for (label,source,frame,top) in [("foreign settings view",foreignView,url,true),("subframe",mainView,url,false),("different source URL",mainView,URL(string:"paperapp://app/settings.html")!,true),("HTTP document",mainView,URL(string:"https://app/index.html")!,true)]{
   await run("actual Main rejects "+label){let(_,_,nonce)=try reset();try await rejects{_=try await app.nativeTasksMessage("nativeTasks.present",payload:["nonce":nonce,"clientID":client,"paperID":"paper-a","sequence":2,"tasks":false,"focus":false],source:source,frameURL:frame,isMainFrame:top)}}
  }
  await run("actual Main refuses termination before DOM or business"){let(c,lease,_)=try reset();app.terminationPending=true;try await rejects{_=try await app.performNativeTaskAction(lease,coordinator:c)}}
  await run("actual Main refuses maintenance before DOM or business"){let(c,lease,_)=try reset();app.maintenanceBusy=true;try await rejects{_=try await app.performNativeTaskAction(lease,coordinator:c)}}
  await run("actual Main refuses native detail context"){let(c,lease,_)=try reset();app.storageDetailSession = .init(generation:1,paperID:"paper-a",previousResponder:nil);try await rejects{_=try await app.performNativeTaskAction(lease,coordinator:c)}}
  await run("actual Main rejects different coordinator"){let(_,lease,_)=try reset();let old=NativeTaskHostCoordinator(context:app.nativeTasksContext);try await rejects{_=try await app.performNativeTaskAction(lease,coordinator:old)}}
  await run("actual Main context generation retires exact original route"){let(c,lease,_)=try reset();app.contextGeneration+=1;try check(!app.nativeTaskController!.route.current(lease),"old route retained");try await rejects{_=try await app.performNativeTaskAction(lease,coordinator:c)}}
  await run("actual Main paper mismatch refuses even without generation write"){let(c,lease,_)=try reset();app.currentPaperID="paper-b";try await rejects{_=try await app.performNativeTaskAction(lease,coordinator:c)}}
  await run("actual Main handles native retirement without DOM or a window"){let(c,lease,nonce)=try reset();let result=try await app.nativeTasksMessage("nativeTasks.present",payload:["nonce":nonce,"clientID":client,"paperID":"paper-a","sequence":2,"tasks":false,"focus":false],source:mainView,frameURL:url,isMainFrame:true);try check(result["accepted"] as? Bool==true && !app.nativeTaskController!.route.current(lease),"not retired");try await rejects{_=try await c.invocation()}}
  await run("sourceBound callback receives exact original capability"){let(c,_,_)=try reset();let route=NativeTaskRouteGate(owner:app.nativeTasksContext.owner);var received:NativeTaskLease?;let ctrl=NativeTasksController(route:route,provider:{.init(jobs:[raw],sessions:[],liveJobIDs:[])},callbacks:.init(sourceBound:{received=$0;return .previewOnly}));try ctrl.apply(.init(owner:route.owner,sequence:1,tasks:true,rectangle:.init(x:220,y:0,width:800,height:600)),allowedContent:.init(x:220,y:0,width:800,height:600));let lease=try route.issue(row:ctrl.snapshot!.rows[0],action:.openSaved);await ctrl.invoke(lease);try check(received===lease,"lease replaced by id");_ = c}
  await run("Host checks preserve original bytes and do not read credentials"){try check(try Data(contentsOf:file)==before,"original job changed");try check(keyReads==0,"credential read");try check(NSApp.windows.isEmpty,"window opened")}
  print("RESULT \(passed) passed / \(failed) failed");exit(failed==0 ? 0:1)
 }
}
