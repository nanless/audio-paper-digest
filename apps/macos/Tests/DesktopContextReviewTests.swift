// Independent context/lifecycle regression: temporary store and isolated WKWebView.
// No application launch, Keychain, real model, Zotero or production runtime access.
import AppKit
import WebKit
import PDFKit
import Foundation
import Darwin

actor ContextPublishedFixture {
 var version=1
 let pdf:Data
 init(_ data:Data){pdf=data}
 func advance(){version=2}
 func read(_ url:URL,_ limit:Int) throws->Data {
  if url.path=="/blog/index.json" {
   let row:[String:Any] = ["permalink":"/blog/posts/context/","pageType":"paper","title":"Published context fixture","date":"2026-10-24","sourceKind":"arxiv","identityStatus":"verified","arxivId":"2610.27491","citation":["paperKey":"arxiv:2610.27491","identityStatus":"verified","verified":true,"complete":false,"authors":["Actual fixture author"],"title":"Published context fixture","arxivId":"2610.27491v\(version)","sourceKind":"arxiv","sourceUrl":"https://arxiv.org/abs/2610.27491v\(version)","pdfUrl":"https://arxiv.org/pdf/2610.27491v\(version).pdf"]]
   return try JSONSerialization.data(withJSONObject:[row],options:[.sortedKeys])
  }
  if url.path.contains("/posts/context"){return Data("<html><body><div id='article-body' class='post-content'><h1>Published context fixture</h1><h2>Actual local fixture v\(version)</h2><p>Version-bound public fixture text.</p></div></body></html>".utf8)}
  if url.path.hasPrefix("/pdf/"){return pdf}
  throw URLError(.fileDoesNotExist)
 }
}

@main struct DesktopContextReviewTests {
 @MainActor static func main() async throws {
  _=NSApplication.shared
  let dir=URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("apps/macos/.qa/DesktopContextReview-"+UUID().uuidString)
  defer{try? FileManager.default.removeItem(at:dir)}
  let app=PaperDigestApp();app.directory=dir;app.store=try DesktopStore(directory:dir)
  var credentials=0
  app.model=ModelService(directory:dir,store:app.store,keyProvider:{credentials+=1;return nil})
  app.library=try LibraryService(dataDirectory:dir,transport:{_,_ in throw URLError(.notConnectedToInternet)})
  app.storage=DesktopStorage(directory:dir,store:app.store)
  let a="arxiv:2610.27491",b="arxiv:2610.00001"
  func set(_ id:String){app.contextGeneration+=1;app.currentPaperID=id;app.currentPaper=["id":id,"title":id,"sourceKind":"arxiv"];app.currentArticle=["paperID":id,"plainText":"Actual isolated guide material for "+id,"revisionSHA256":id+"-revision"]}
  var passed=0,failures:[String]=[]
  func check(_ value:Bool,_ name:String){if value{passed+=1;print("PASS "+name)}else{failures.append(name);print("FAIL "+name)}}
  let view=WKWebView(frame:NSRect(x:0,y:0,width:800,height:600));app.web=view
  view.loadHTMLString("<html><body>Isolated context regression</body></html>",baseURL:nil)
  for _ in 0..<200{if (try? await view.evaluateJavaScript("document.body?.textContent.includes('Isolated context regression')")) as? Bool==true{break};try await Task.sleep(nanoseconds:20_000_000)}
  func heldFlush() async throws { _=try await view.evaluateJavaScript("window.entered=false;window.paperDigestFlushPendingNote=()=>{window.entered=true;return new Promise(r=>window.release=()=>r({saved:true}));};true") }
  func waitFlush() async throws {for _ in 0..<200{if (try? await view.evaluateJavaScript("window.entered")) as? Bool==true{return};try await Task.sleep(nanoseconds:10_000_000)};throw DesktopError.message("WK isolated flush gate timeout")}
  for aba in [false,true] {
   set(a);try await heldFlush()
   let request=Task{@MainActor in try await app.dispatch("model.run",payload:["paperID":a,"scope":"guide","question":"A question"]) }
   try await waitFlush();set(b);if aba{set(a)}
   _=try await view.evaluateJavaScript("window.release();true")
   var message="";do{_=try await request.value}catch{message=error.localizedDescription}
   check(message.contains("保存期间已切换") && credentials==0 && app.jobs.isEmpty,"model guide \(aba ? "ABA":"A-to-B") switch during actual WK flush rejects before credentials/worker")
  }
  _=try await view.evaluateJavaScript("window.paperDigestFlushPendingNote=()=>Promise.resolve({saved:true});true")
  set(a);try app.store.rememberPaper(app.currentPaper);set(b)
  _=try await app.dispatch("personal.reading",payload:["paperID":a,"question":"A draft","pdfPage":5])
  let readings=app.store.value["readingState"] as? [String:[String:Any]] ?? [:]
  check(readings[a]?["question"] as? String=="A draft" && readings[b]==nil && app.currentPaperID==b,"late A reading save remains owned by A after switching to B")
  // Queue outer operation first, then context switch. The created inner Task starts after the switch.
  set(a);var operations=0
  let queued=Task{@MainActor in try await app.runJob("storage.prepare",payload:[:],identifier:"queued-context") {_ in operations+=1;return [:]} }
  let change=Task{@MainActor in set(b)}
  await change.value
  var rejected=false;do{_=try await queued.value}catch{rejected=true}
  check(rejected && operations==0,"queued source-dependent job rejects context change before first operation")
  for maintenance in [false,true] {
   app.terminationPending = !maintenance;app.maintenanceBusy=maintenance
   var blocked=0
   do{try app.importLocalPDF()}catch{blocked+=1}
   do{try await app.backupData()}catch{blocked+=1}
   do{try await app.restoreData()}catch{blocked+=1}
   do{_=try await app.dispatch("app.setPaper",payload:["id":a])}catch{blocked+=1}
   do{_=try await app.runJob("model.run",payload:[:]){_ in operations+=1;return [:]}}catch{blocked+=1}
   check(blocked==5,"\(maintenance ? "maintenance":"termination") gates final import/backup/restore, context switch and new job before panel/operation")
  }
  app.terminationPending=false;app.maintenanceBusy=false;set(a)
  var cancelledOperations=0
  let beforeStart=Task{@MainActor in try await app.runJob("model.run",payload:[:],identifier:"cancel-before-first-operation") {_ in cancelledOperations+=1;return ["fixture":true]} }
  let cancelling=Task{@MainActor in app.terminationPending=true;for task in app.jobs.values{task.cancel()} }
  await cancelling.value
  _=try? await beforeStart.value
  check(cancelledOperations==0,"cancellation before first queued model operation prevents operation entry")
  app.terminationPending=false
  // Exact same PDF bytes may be assigned a different published revision identity.
  let resolved=realpath(dir.path,nil)!;app.directory=URL(fileURLWithPath:String(cString:resolved));free(resolved)
  let seed=URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research")
  app.library=try LibraryService(dataDirectory:app.directory,seedDirectory:seed,transport:{_,_ in throw URLError(.notConnectedToInternet)})
  let bytes=try Data(contentsOf:seed.appendingPathComponent("assets/micla-2610.27491v1.pdf")),sameDocument=PDFDocument(data:bytes)!
  set(a);let fullCatalog=try await app.library.handle(command:"library.list",payload:["limit":100]);app.currentPaper=(fullCatalog["papers"] as! [[String:Any]]).first{$0["id"] as? String==a}!;app.pdfOwner=a;app.pdfVersion="2610.27491v2";app.currentPDFSHA=sha256(bytes);app.pdfView.document=sameDocument
  try await app.openPDF()
  check(app.pdfVersion=="2610.27491v1" && app.pdfStatus()["version"] as? String=="2610.27491v1" && app.pdfView.document===sameDocument,"same-byte PDF reuse updates actual source version while retaining PDFKit document")
  app.currentArticle=try await app.library.handle(command:"library.article",payload:["paperID":a])
  try await heldFlush()
  let archiving=Task{@MainActor in try await app.dispatch("archive.materials",payload:[:])}
  try await waitFlush();for task in app.jobs.values{task.cancel()};_=try await view.evaluateJavaScript("window.release();true")
  var archiveCancelled=false;do{_=try await archiving.value}catch{archiveCancelled=error is CancellationError}
  check(archiveCancelled,"archive cancelled during flush does not continue optional cached PDF and return successful materials")
  _=try await view.evaluateJavaScript("window.paperDigestFlushPendingNote=()=>Promise.resolve({saved:true});true")
  let published=ContextPublishedFixture(bytes)
  app.library=try LibraryService(dataDirectory:app.directory.appendingPathComponent("VersionFixture"),siteBaseURL:URL(string:"https://fixture.example/blog/")!,transport:{url,limit in try await published.read(url,limit)})
  _=try await app.library.sync()
  let v1Catalog=try await app.library.handle(command:"library.list",payload:["limit":100]),v1Paper=(v1Catalog["papers"] as! [[String:Any]])[0]
  _=try await app.dispatch("app.setPaper",payload:v1Paper)
  _=try await app.dispatch("library.article",payload:["paperID":a]);try await app.openPDF()
  let beforeGeneration=app.contextGeneration,beforeArticle=app.currentArticle["revisionSHA256"] as? String
  await published.advance();_=try await app.library.sync()
  var articleRejected=false;do{_=try await app.dispatch("library.article",payload:["paperID":a])}catch{articleRejected=true}
  check(articleRejected && app.currentArticle["revisionSHA256"] as? String==beforeArticle && app.contextGeneration==beforeGeneration,"background same-ID catalog v1-to-v2 cannot install v2 guide under v1 reading identity")
  var pdfRejected=false;do{try await app.openPDF()}catch{pdfRejected=true}
  check(pdfRejected && app.pdfVersion=="2610.27491v1","background catalog v2 PDF cannot replace v1 reading original")
  let safeArchive=try await app.archiveMaterials([:])
  check(safeArchive["pdfPath"]==nil && !(safeArchive["pdfNotice"] as? String ?? "").isEmpty && safeArchive["identity"] as? String=="arxiv:2610.27491v1","archive retains v1 citation and refuses mismatched catalog v2 PDF")
  var offlineRejected=false;do{_=try await app.prepareOffline(progress:{_ in})}catch{offlineRejected=true}
  check(offlineRejected,"offline preparation refuses mixed catalog v2 and reading v1 materials")
  let readOnlyMessage="旧记录账号未绑定，仅回读；未继续写入"
  _=try await app.runJob("zotero.resume",payload:[:],identifier:"legacy-read-only-task"){_ in ["status":"partial","archiveID":"legacy-fixture","identity":a,"title":"Old fixture","readOnly":true,"warning":readOnlyMessage]}
  let legacyTask=(app.store.value["jobs"] as? [[String:Any]])?.first{$0["id"] as? String=="legacy-read-only-task"}
  let legacyResult=legacyTask?["result"] as? [String:Any]
  check(legacyTask?["status"] as? String=="partial" && legacyTask?["message"] as? String==readOnlyMessage && legacyResult?["readOnly"] as? Bool==true && legacyResult?["warning"] as? String==readOnlyMessage,"actual task projection preserves explicit legacy GET-only scope instead of reporting a new completed archive")
  print("Independent context/lifecycle review: \(passed) passed; \(failures.count) failed; credential provider calls \(credentials); no real network/model/Zotero")
  if !failures.isEmpty{exit(1)}
 }
}
