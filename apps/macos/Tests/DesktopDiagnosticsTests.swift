// Actual isolated WK privacy regression. Never orders a window on screen, reads
// production profiles/Keychain, invokes a model/Zotero service or opens a save panel.
import AppKit
import WebKit
import Foundation

@main struct DesktopDiagnosticsTests {
 @MainActor static func main() async throws {
  _=NSApplication.shared
  let fm=FileManager.default,root=fm.temporaryDirectory.appendingPathComponent("DiagnosticsPrivacy-"+UUID().uuidString,isDirectory:true)
  try fm.createDirectory(at:root,withIntermediateDirectories:true);defer{try? fm.removeItem(at:root)}
  let app=PaperDigestApp();app.directory=root;app.store=try DesktopStore(directory:root)
  let secret="PRIVATE_CREDENTIAL_FIXTURE_DO_NOT_EXPORT",personal="PRIVATE_RESEARCH_TEXT_FIXTURE_DO_NOT_EXPORT",address="https://private-fixture.invalid/credential-path"
  try app.store.updateSettings(["endpoint":address,"httpProxy":"http://127.0.0.1:19997","model":secret])
  _=try app.store.saveNote(id:"arxiv:fixture",text:personal,baseRevision:0)
  try app.store.appendSession(["id":"fixture-session","text":personal,"question":personal,"config":["key":secret,"endpoint":address]])
  try app.store.upsertJob(["id":"fixture-job","command":secret,"status":personal,"message":secret,"title":personal,"sourceURL":address])
  try app.store.upsertJob(["id":"known-job","command":"model.run","status":"complete","message":personal])
  let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
  let web=WKWebView(frame:NSRect(x:0,y:0,width:1080,height:700),configuration:config);app.web=web
  let html="""
  <!doctype html><html><head><title>\(personal)</title></head><body data-secret="\(secret)">
  <main id="app-window" inert><input id="question" value="\(secret)"/><a href="\(address)">\(personal)</a><textarea>\(personal)</textarea></main>
  <div id="\(secret)" role="\(secret)" aria-hidden="\(secret)" data-url="\(address)">\(personal)</div>
  <dialog id="detail-dialog-facade" aria-hidden="true" style="display:none"></dialog>
  <section id="detail-dialog" role="dialog" aria-modal="true" data-dialog-surface open style="position:fixed;left:10px;top:20px;width:400px;pointer-events:auto"><h2>\(personal)</h2><button id="detail-close">\(personal)</button><input id="model" value="\(secret)"></section>
  <script>
   window.diagnosticReady=false;window.mutationCount=0;window.focusCount=0;
   document.addEventListener('focusin',()=>window.focusCount++);
   document.querySelector('#detail-close').focus();
   const observer=new MutationObserver(changes=>window.mutationCount+=changes.length);observer.observe(document.body,{subtree:true,attributes:true,childList:true,characterData:true});
   window.paperDigestFlushPendingNote=()=>{throw Error('diagnostics must not flush private material')};
   Object.defineProperty(document,'title',{get(){throw Error('must not read title')}});
   for(const input of document.querySelectorAll('input,textarea'))Object.defineProperty(input,'value',{get(){throw Error('must not read input values')}});
   window.diagnosticReady=true;
  </script></body></html>
  """
  web.loadHTMLString(html,baseURL:nil)
  for _ in 0..<200{if (try? await web.evaluateJavaScript("window.diagnosticReady===true")) as? Bool==true{break};try await Task.sleep(nanoseconds:10_000_000)}
  var checks=0
  func expect(_ result:Bool,_ label:String)throws{guard result else{throw DesktopError.message("FAIL "+label)};checks+=1;print("PASS "+label)}
  try expect((try await web.evaluateJavaScript("window.diagnosticReady")) as? Bool==true,"actual offscreen WK fixture ready")
  let before=try await web.evaluateJavaScript("JSON.stringify({html:document.body.innerHTML,focus:document.activeElement.id,mutations:mutationCount,focusEvents:focusCount})") as! String
  let storeBefore=try Data(contentsOf:root.appendingPathComponent("personal.json")),report=await app.diagnosticsReport()
  let encoded=try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]),text=String(decoding:encoded,as:UTF8.self)
  for marker in [secret,personal,address,"127.0.0.1:19997",root.path,"fixture-session","fixture-job","arxiv:fixture"]{try expect(!text.contains(marker),"private marker excluded from structural diagnostic")}
  try expect(report["credentialsIncluded"] as? Bool==false && report["personalTextIncluded"] as? Bool==false,"explicit diagnostic privacy contract")
  let counts=report["counts"] as! [String:Int];try expect(counts["jobs"]==2 && counts["notes"]==1 && counts["sessions"]==1,"only aggregate personal counts retained")
  let jobs=report["jobStates"] as! [[String:String]]
  try expect(jobs.contains(["command":"other","status":"other"]),"untrusted job labels never exported as arbitrary strings")
  try expect(jobs.contains(["command":"model.run","status":"complete"]),"known real job command and terminal status preserved")
  let ui=report["uiStructure"] as! [String:Any],main=ui["main"] as! [String:Any],dom=main["dom"] as! [String:Any],native=main["native"] as! [String:Any]
  try expect(dom["contract"] as? String=="paperdigest-ui-structure-v1","actual WK returns structured DOM contract")
  try expect(dom["documentHasFocus"] is Bool,"document focus is a boolean observation only")
  let active=dom["activeElement"] as! [String:Any];try expect(active["tag"] as? String=="BUTTON" && active["id"] as? String=="detail-close","active element only reports safe static identity")
  let children=dom["bodyChildren"] as! [[String:Any]],unknown=children.first{$0["id"] as? String=="other"}!
  try expect(unknown["ariaHidden"] as? String=="other" && unknown["role"] as? String=="other","untrusted aria and role values projected to fixed enum")
  let surfaces=dom["surfaces"] as! [[String:Any]],surface=surfaces[0]["element"] as! [String:Any]
  try expect(surface["id"] as? String=="detail-dialog" && surface["ariaModal"] as? String=="true","visible modal identity and semantics included")
  try expect(surface["display"] as? String=="block" && surface["visibility"] as? String=="visible" && surface["pointerEvents"] as? String=="auto","computed structural styles included")
  try expect((surface["clientRectsCount"] as? Int ?? 0)>0 && surface["bounds"] is [String:Any],"actual client rectangles included without text")
  try expect((surfaces[0]["ancestors"] as? [[String:Any]])?.count==2,"modal body and HTML ancestor states included")
  try expect(native["firstResponderClass"] as? String=="none" && native["webAttached"] as? Bool==false && native["windowKey"] as? Bool==false,"unattached native view state represented without window titles")
  let bounds=native["webBounds"] as! [String:Double];try expect(bounds["width"]==1080 && bounds["height"]==700,"native WK bounds preserved")
  let after=try await web.evaluateJavaScript("JSON.stringify({html:document.body.innerHTML,focus:document.activeElement.id,mutations:mutationCount,focusEvents:focusCount})") as! String
  try expect(before==after,"diagnostic does not mutate DOM or change DOM focus")
  try expect(storeBefore==(try Data(contentsOf:root.appendingPathComponent("personal.json"))),"diagnostic leaves private fixture bytes unchanged")
  try expect(ui["settings"]==nil,"absent settings window omitted without opening it")
  let settings=WKWebView(frame:NSRect(x:0,y:0,width:780,height:610),configuration:config);app.settingsWeb=settings
  settings.loadHTMLString("<body><div id='detail-dialog' data-dialog-surface open role='dialog'><h2>\(personal)</h2></div></body>",baseURL:nil)
  for _ in 0..<200{if (try? await settings.evaluateJavaScript("document.querySelector('[data-dialog-surface]')!==null")) as? Bool==true{break};try await Task.sleep(nanoseconds:10_000_000)}
  let both=await app.diagnosticsReport(),bothUI=both["uiStructure"] as! [String:Any]
  try expect(bothUI["main"] != nil && bothUI["settings"] != nil,"existing settings WK captured separately without creating a new window")
  try expect(!String(decoding:try JSONSerialization.data(withJSONObject:both),as:UTF8.self).contains(personal),"settings DOM text excluded too")
  // A private, never-ordered NSWindow exercises native responder ancestry too.
  let window=NSWindow(contentRect:NSRect(x:0,y:0,width:1080,height:700),styleMask:.borderless,backing:.buffered,defer:false)
  window.isReleasedWhenClosed=false;let container=NSView(frame:web.bounds);window.contentView=container;container.addSubview(web);app.window=window
  let webField=NSTextView(frame:NSRect(x:0,y:0,width:100,height:30));web.addSubview(webField);window.makeFirstResponder(webField)
  let webResponder=app.diagnosticNativeState(web,window:window)
  try expect(webResponder["firstResponderClass"] as? String=="NSTextView" && webResponder["firstResponderIsWebDescendant"] as? Bool==true && webResponder["firstResponderIsPDFDescendant"] as? Bool==false,"native responder reports exact class and WK ancestry without its content")
  container.addSubview(app.pdfView);let pdfField=NSTextView(frame:NSRect(x:0,y:0,width:100,height:30));app.pdfView.addSubview(pdfField);window.makeFirstResponder(pdfField)
  let pdfResponder=app.diagnosticNativeState(web,window:window)
  try expect(pdfResponder["firstResponderIsWebDescendant"] as? Bool==false && pdfResponder["firstResponderIsPDFDescendant"] as? Bool==true,"native PDF responder ancestry is independent of WK")
  try expect(!window.isVisible && pdfResponder["windowKey"] as? Bool==false,"native regression never presents or activates its fixture window")
  print("DesktopDiagnostics PASS \(checks) checks; actual isolated WK, read-only geometry/semantics, no GUI/services/Keychain/save panel")
 }
}
