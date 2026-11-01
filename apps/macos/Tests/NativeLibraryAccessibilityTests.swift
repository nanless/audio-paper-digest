import AppKit
import WebKit
import ApplicationServices

private final class LibraryAXScheme:NSObject,WKURLSchemeHandler {
 let resources:URL,html:Data
 init(_ resources:URL,_ html:Data){self.resources=resources;self.html=html}
 func webView(_ w:WKWebView,start task:WKURLSchemeTask){do{
  guard let url=task.request.url,url.scheme=="paperapp",url.host=="app" else{throw URLError(.unsupportedURL)}
  let repository=resources.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  let resourceBase:URL,relative:String
  if url.path.hasPrefix("/vendor/katex/"){resourceBase=resources.deletingLastPathComponent().appendingPathComponent("node_modules/katex/dist");relative=String(url.path.dropFirst("/vendor/katex/".count))}
  else if url.path.hasPrefix("/vendor/"){resourceBase=repository.appendingPathComponent("prototypes/macos-research/vendor");relative=String(url.path.dropFirst("/vendor/".count))}
  else{resourceBase=resources;relative=String(url.path.dropFirst())}
  let file=resourceBase.appendingPathComponent(relative).standardizedFileURL
  guard file.path.hasPrefix(resourceBase.path+"/") else{throw URLError(.noPermissionsToReadFile)}
  let bytes=url.path=="/fixture.html" ? html:try Data(contentsOf:file)
  let mime=["html":"text/html","css":"text/css","js":"text/javascript","woff2":"font/woff2"][file.pathExtension] ?? "application/octet-stream"
  task.didReceive(HTTPURLResponse(url:url,statusCode:200,httpVersion:"HTTP/1.1",headerFields:["Content-Type":mime+"; charset=utf-8"])!);task.didReceive(bytes);task.didFinish()
 }catch{task.didFailWithError(error)}}
 func webView(_ w:WKWebView,stop task:WKURLSchemeTask){}
}
@MainActor private final class LibraryAXProbe:NSObject,WKNavigationDelegate,WKScriptMessageHandlerWithReply {
 var fixture:[String:Any]=[:];var blocked:[String]=[]
 let summary:[String:Any]=["paperCount":3,"recordCount":3]
 let personal:[String:Any]=["favorites":["qa:0","qa:1"],"reading":[],"notes":[:],"annotations":[:],"sessions":[],"readingState":[:]]
 func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage,replyHandler:@escaping(Any?,String?)->Void){guard message.frameInfo.isMainFrame,let body=message.body as? [String:Any],let command=body["command"] as? String else{replyHandler(nil,"Own fixture main frame only");return};Task{@MainActor in await Task.yield();switch command {
 case "app.bootstrap":replyHandler(["personal":personal,"settings":["font":18,"appearance":"light","reduceMotion":true],"library":summary,"initialView":"today"],nil)
 case "library.status":replyHandler(summary,nil)
 case "library.list":replyHandler(fixture,nil)
 case "personal.snapshot":replyHandler(personal,nil)
 case "personal.annotations":replyHandler(["annotations":[]],nil)
 case "library.article":replyHandler(["paperID":"qa:0","html":"<h2>Explicit isolated reader body</h2><p>Not scientific output or source eligibility.</p>","markdown":"","revisionSHA256":String(repeating:"a",count:64),"completeOffline":false,"notices":[]],nil)
 case "library.search","personal.search":replyHandler(["ids":[]],nil)
 case "aggregates.list":replyHandler(["records":[["id":"page:/qa-daily/","kind":"daily","title":"Isolated daily fixture","displayDate":"2026-10-30","sourceURL":"https://nanless.github.io/audio-paper-digest-blog/qa-daily/","tags":[]]],"available":true],nil)
 case "app.setPaper","pdf.close","personal.reading","pdf.frame","aggregates.preload":replyHandler([:],nil)
 default:blocked.append(command);replyHandler(nil,"Own isolated fixture prohibits command: "+command)
 }}}
 var window:NSWindow!,web:WKWebView!,scheme:LibraryAXScheme!
 let root:URL
 init(_ root:URL){self.root=root}
 func wait(_ script:String)async throws{for _ in 0..<200{if (try? await web.evaluateJavaScript(script)) as? Bool==true{return};try await Task.sleep(nanoseconds:20_000_000)};throw NSError(domain:"probe",code:1,userInfo:[NSLocalizedDescriptionKey:"readiness timeout"])}
 func ownAX()->[String:Any]{let app=AXUIElementCreateApplication(getpid());AXUIElementSetMessagingTimeout(app,0.5);var value:CFTypeRef?;let error=AXUIElementCopyAttributeValue(app,kAXWindowsAttribute as CFString,&value);let windows=(value as? [AXUIElement]) ?? [];guard let root=windows.first else{return ["validWindow":false,"trusted":AXIsProcessTrusted(),"windowError":error.rawValue,"windowCount":windows.count]};var windowRole:CFTypeRef?;let roleError=AXUIElementCopyAttributeValue(root,kAXRoleAttribute as CFString,&windowRole);guard roleError == .success,(windowRole as? String)=="AXWindow" else{return ["validWindow":false,"observedRole":windowRole as? String ?? "unavailable","trusted":AXIsProcessTrusted()]};var queue:[(AXUIElement,Int)]=[(root,0)],seen=Set<CFHashCode>(),roles:[String:Int]=[:],errors:[String:Int]=[:],position=0
  while position<queue.count&&position<600{let(node,depth)=queue[position];position+=1;guard seen.insert(CFHash(node)).inserted else{continue};var role:CFTypeRef?;let result=AXUIElementCopyAttributeValue(node,kAXRoleAttribute as CFString,&role);if result != .success{errors[String(result.rawValue),default:0]+=1;continue};if let role=role as? String{roles[role,default:0]+=1};if depth<20{var children:CFTypeRef?;let result=AXUIElementCopyAttributeValue(node,kAXChildrenAttribute as CFString,&children);if result != .success{errors[String(result.rawValue),default:0]+=1};if let children=children as? [AXUIElement]{queue.append(contentsOf:children.prefix(200).map{($0,depth+1)})}}}
  return ["validWindow":true,"trusted":AXIsProcessTrusted(),"windowCount":windows.count,"nodes":seen.count,"roles":roles,"errors":errors,"truncated":position<queue.count]
 }
 func capture(_ stage:String)async throws->[String:Any]{
  let modern=web.accessibilityChildren() ?? []
  try await Task.sleep(nanoseconds:200_000_000)
  let dom=try await web.evaluateJavaScript("""
  (()=>{const results=document.querySelector('.library-results');return {stage:'\(stage)',panelHidden:document.querySelector('.classification-panel')?.hidden,visibleRows:document.querySelectorAll('[data-library-row]').length,inputs:[...results.querySelectorAll('input,select,button')].filter(n=>n.getClientRects().length).length,ancestors:[results,...function*(node){for(let p=node.parentElement;p;p=p.parentElement)yield p}(results)].map(node=>({tag:node.tagName,id:node.id,classes:node.className,hidden:node.hidden,inert:node.inert,ariaHidden:node.getAttribute('aria-hidden'),display:getComputedStyle(node).display,bounds:[node.getBoundingClientRect().width,node.getBoundingClientRect().height]}))};})()
  """)
  return ["stage":stage,"dom":dom ?? NSNull(),"modernImmediateChildCount":modern.count,"ownPIDAX":ownAX()]
 }
 func run()async throws{
  let resources=URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("apps/macos/Resources");fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("native-fixture.json"))) as! [String:Any];let config=WKWebViewConfiguration();config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"desktop");config.websiteDataStore = .nonPersistent();scheme=LibraryAXScheme(resources,try Data(contentsOf:root.appendingPathComponent("fixture.html")));config.setURLSchemeHandler(scheme,forURLScheme:"paperapp")
  window=NSWindow(contentRect:NSRect(x:-8000,y:-8000,width:1440,height:900),styleMask:[.titled,.closable],backing:.buffered,defer:false);window.title="PD own-PID offscreen WK AX probe";window.alphaValue=0;window.isReleasedWhenClosed=false
  web=WKWebView(frame:window.contentView!.bounds,configuration:config);web.navigationDelegate=self;window.contentView?.addSubview(web);window.orderBack(nil);web.load(URLRequest(url:URL(string:"paperapp://app/fixture.html")!));try await wait("document.querySelector('[data-view=today]')?.classList.contains('is-active')===true && document.querySelector('#aggregate-index')?.hidden===false")
  var results:[[String:Any]]=[];results.append(try await capture("native-cold-daily-aggregate-browser-hidden"))
  if (results[0]["ownPIDAX"] as? [String:Any])?["validWindow"] as? Bool != true {let report:[String:Any]=["status":"blocked","reason":"Own-PID AXWindow unavailable; desktop unlock required; no accessibility pass","records":results];try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:root.appendingPathComponent("result.json"));window.close();fputs("BLOCKED: own-PID AXWindow unavailable; no accessibility pass.\n",stderr);exit(77)}
  // This in-page mode switch intentionally does not call native setView. Observe
  // its actual AX projection independently instead of assuming the route fix covers it.
  _=try await web.evaluateJavaScript("document.querySelector('[data-aggregate-mode=papers]').click();true");try await wait("!document.querySelector('#library-view').classList.contains('aggregate-list-selected')");results.append(try await capture("native-daily-same-page-paper-mode"))
  _=try await web.evaluateJavaScript("document.querySelector('[data-aggregate-mode=aggregates]').click();true");try await wait("!document.querySelector('#aggregate-index').hidden");results.append(try await capture("native-daily-same-page-aggregate-mode"))
  _=try await web.evaluateJavaScript("document.querySelector('[data-view=directions]').click();true");try await wait("document.querySelector('[data-view=directions]').classList.contains('is-active')&&!document.querySelector('.classification-panel').hidden&&document.querySelectorAll('[data-library-row]').length===3")
  results.append(try await capture("native-directions-directory-open"))
  _=try await web.evaluateJavaScript("document.querySelector('[data-library-open]').click();true");try await wait("Boolean(document.querySelector('#guide-frame')?.contentDocument?.querySelector('main')) && document.querySelector('#reader-view').hidden===false");results.append(try await capture("native-reader-open"))
  _=try await web.evaluateJavaScript("document.querySelector('#back').click();true");try await wait("document.querySelector('[data-view=directions]').classList.contains('is-active')&&!document.querySelector('.classification-panel').hidden");results.append(try await capture("native-reader-return-directions"))
  _=try await web.evaluateJavaScript("document.querySelector('[data-view=favorites]').click();true");try await wait("document.querySelector('[data-view=favorites]').classList.contains('is-active')&&document.querySelector('.classification-panel').hidden&&document.querySelectorAll('[data-library-row]').length===2")
  results.append(try await capture("native-favorites-panel-closed"))
  _=try await web.evaluateJavaScript("document.querySelector('#library-browse-classifications').click();true");results.append(try await capture("native-favorites-panel-open"))
  _=try await web.evaluateJavaScript("document.querySelector('#classification-close').click();true");results.append(try await capture("native-favorites-panel-closed-again"))
  _=try await web.evaluateJavaScript("document.querySelector('[data-view=library]').click();true");try await wait("document.querySelector('[data-view=library]').classList.contains('is-active')&&document.querySelectorAll('[data-library-row]').length===3");results.append(try await capture("native-all-library-panel-closed"))
  _=try await web.evaluateJavaScript("document.querySelector('[data-view=pages]').click();true");try await wait("document.querySelectorAll('[data-website-resource]').length===9");results.append(try await capture("native-pages-resource-hub"))
  _=try await web.evaluateJavaScript("document.querySelector('[data-view=library]').click();true");try await wait("document.querySelector('[data-view=library]').classList.contains('is-active')");
  results.append(try await capture("native-after-pages-return-library-before-clone"));try await Task.sleep(nanoseconds:500_000_000);results.append(try await capture("native-library-same-DOM-delayed-second-AX-read"));try await Task.sleep(nanoseconds:500_000_000);results.append(try await capture("native-library-same-DOM-delayed-third-AX-read"))
  let tableStages:Set<String>=["native-daily-same-page-paper-mode","native-directions-directory-open","native-reader-return-directions","native-favorites-panel-closed","native-favorites-panel-open","native-favorites-panel-closed-again","native-all-library-panel-closed","native-after-pages-return-library-before-clone","native-library-same-DOM-delayed-second-AX-read","native-library-same-DOM-delayed-third-AX-read"]
  let unavailable=results.filter{($0["ownPIDAX"] as? [String:Any])?["validWindow"] as? Bool != true}
  let failures=results.filter{record in guard tableStages.contains(record["stage"] as? String ?? "") else{return false};return (((record["ownPIDAX"] as? [String:Any])?["roles"] as? [String:Int])?["AXTable"] ?? 0)<1}
  let pages=results.first{$0["stage"] as? String=="native-pages-resource-hub"},pageSearch=(((pages?["ownPIDAX"] as? [String:Any])?["roles"] as? [String:Int])?["AXTextField"] ?? 0)>0
  let modeAggregate=results.first{$0["stage"] as? String=="native-daily-same-page-aggregate-mode"},modeSearch=(((modeAggregate?["ownPIDAX"] as? [String:Any])?["roles"] as? [String:Int])?["AXTextField"] ?? 0)>0
  let status=unavailable.isEmpty ? (failures.isEmpty&&pageSearch&&modeSearch&&blocked.isEmpty ? "passed":"failed"):"blocked"
  let output:[String:Any]=["status":status,"scope":"Production native.js and local async WK bridge with explicit public/synthetic display fixtures; own CLI PID, prohibited activation, offscreen transparent window, ephemeral data. No installed application, user root, account, model, native Core qualification or VoiceOver claim.","records":results,"blockedCommands":blocked,"failedTableStages":failures.map{$0["stage"]!},"pagesSearchExposed":pageSearch,"samePageAggregateSearchExposed":modeSearch,"validWindowUnavailableStages":unavailable.map{$0["stage"]!}]
  try JSONSerialization.data(withJSONObject:output,options:[.prettyPrinted,.sortedKeys]).write(to:root.appendingPathComponent("result.json"));window.close()
  if status=="blocked"{fputs("BLOCKED: own-PID native AXWindow unavailable; no accessibility pass. Unlock the desktop for this bounded regression.\n",stderr);exit(77)}
  guard status=="passed" else{throw NSError(domain:"NativeLibraryAccessibility",code:2,userInfo:[NSLocalizedDescriptionKey:"Visible library table/resource search missing from actual WK accessibility tree"])}
  print("PASS native library AX: actual async production route, reader/back, closed/open directory, table and resource search survive dynamic reveals")

 }
 func webView(_ w:WKWebView,decidePolicyFor action:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){decisionHandler(["paperapp","about"].contains(action.request.url?.scheme ?? "") ? .allow:.cancel)}
}
@main enum NativeLibraryAccessibilityTests {
 @MainActor static func main(){
  let app=NSApplication.shared;app.setActivationPolicy(.prohibited)
  let repository=URL(fileURLWithPath:FileManager.default.currentDirectoryPath),root=CommandLine.arguments.count>1 ? URL(fileURLWithPath:CommandLine.arguments[1]):FileManager.default.temporaryDirectory.appendingPathComponent("PD-Library-AX-"+UUID().uuidString)
  do{
   try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
   let golden=try JSONSerialization.jsonObject(with:Data(contentsOf:repository.appendingPathComponent("tests/fixtures/workbench-website-taxonomy-golden.json"))) as! [String:Any],cases=golden["cases"] as! [[String:Any]]
   let rows=[0,1,2].map{cases[$0]["record"] as! [String:Any]},papers=rows.enumerated().map{i,row->[String:Any] in ["id":"qa:\(i)","title":row["title"]!,"titleZh":"Explicit isolated AX fixture \(i)","date":row["date"]!,"score":7,"sourceKind":"arxiv","task":row["task"] ?? "","method":row["method"] ?? "","authors":[],"tags":row["tags"] ?? [],"websiteTagRecords":[row]]}
   try JSONSerialization.data(withJSONObject:["papers":papers,"websiteTaxonomy":golden["display"]!]).write(to:root.appendingPathComponent("native-fixture.json"))
   try Data(contentsOf:repository.appendingPathComponent("apps/macos/Resources/index.html")).write(to:root.appendingPathComponent("fixture.html"))
  }catch{fputs("Native AX fixture setup failed: \(error)\n",stderr);exit(1)}
  let probe=LibraryAXProbe(root);Task{@MainActor in do{try await probe.run();exit(0)}catch{fputs("Native AX regression failed: \(error)\n",stderr);exit(1)}};app.run()
 }
}
