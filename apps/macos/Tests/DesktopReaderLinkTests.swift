// Author native regression: actual isolated WKNavigationDelegate and temporary
// LibraryService. No user windows, Keychain, model, Zotero or public network.
import AppKit
import WebKit
import Foundation
import Darwin

private actor ReaderPublishedFixture {
 var version=1
 var pdfReads=0
 let pdf:Data
 init(_ bytes:Data){pdf=bytes}
 func advance(){version=2}
 func read(_ url:URL,_ limit:Int) throws->Data {
  if url.path=="/blog/index.json" {
   let row:[String:Any]=["permalink":"/blog/posts/reader/","pageType":"paper","title":"Explicit published reader fixture","date":"2026-10-24","sourceKind":"arxiv","identityStatus":"verified","arxivId":"2610.27491","citation":["paperKey":"arxiv:2610.27491","identityStatus":"verified","verified":true,"complete":false,"authors":["Explicit fixture author"],"title":"Explicit published reader fixture","arxivId":"2610.27491v\(version)","sourceKind":"arxiv","sourceUrl":"https://arxiv.org/abs/2610.27491v\(version)","pdfUrl":"https://arxiv.org/pdf/2610.27491v\(version).pdf"]]
   return try JSONSerialization.data(withJSONObject:[row])
  }
  if url.path.contains("/posts/reader"){return Data("<html><body><div id='article-body' class='post-content'><h1>Explicit published reader fixture</h1><h2>Actual isolated source v\(version)</h2><p>Version-bound fixture prose.</p></div></body></html>".utf8)}
  if url.path.hasPrefix("/pdf/"){pdfReads+=1;return pdf}
  throw URLError(.fileDoesNotExist)
 }
}
@main struct DesktopReaderLinkTests {
 @MainActor static func main() async throws {
  _=NSApplication.shared
  var passed=0
  func require(_ value:Bool,_ name:String)throws{guard value else{throw DesktopError.message("FAIL "+name)};passed+=1;print("PASS "+name)}
  let token="0496e0a2-b41b-4d8f-80dc-8c5a3c0cc714",valid="paperapp://app/reader-link/0496e0a2-b41b-4d8f-80dc-8c5a3c0cc714/0"
  try require(PaperDigestApp.readerLinkMessage(URL(string:valid)!,sourceIsMainFrame:false,linkActivated:true)?["token"] as? String==token,"only canonical child link yields narrow token/index message")
  let prefix="paperapp://app/reader-link/"+token+"/"
  for invalid in ["paperapp://app/reader-link/invalid/0",valid+"?q=1",valid+"#p",valid+"/tail",prefix+"00",prefix+"%30",prefix+"-1",prefix+"1000000","paperapp://user:secret@app/reader-link/"+token+"/0","paperapp://app:23119/reader-link/"+token+"/0"] {
   try require(PaperDigestApp.readerLinkMessage(URL(string:invalid)!,sourceIsMainFrame:false,linkActivated:true)==nil,"malformed link capability rejected: "+invalid.replacingOccurrences(of:"secret",with:"fixture"))
  }
  try require(PaperDigestApp.readerLinkMessage(URL(string:valid)!,sourceIsMainFrame:true,linkActivated:true)==nil,"main frame cannot impersonate a child navigation message")
  try require(PaperDigestApp.readerLinkMessage(URL(string:valid)!,sourceIsMainFrame:false,linkActivated:false)==nil,"non-link navigation cannot mint parent event")
  let app=PaperDigestApp(),configuration=WKWebViewConfiguration();let scheme=BundleScheme(root:URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("apps/macos/Resources"));configuration.setURLSchemeHandler(scheme,forURLScheme:"paperapp");let view=WKWebView(frame:NSRect(x:0,y:0,width:900,height:700),configuration:configuration);app.web=view
  let child="<a id='reference' href='\(valid)'>[p.5]</a>".replacingOccurrences(of:"&",with:"&amp;").replacingOccurrences(of:"\"",with:"&quot;")
  view.loadHTMLString("<html><body><h1>Isolated native reader test</h1><iframe sandbox='allow-same-origin' srcdoc=\"\(child)\"></iframe><script>window.receipts=[];window.addEventListener('reader.link',e=>receipts.push(e.detail));window.paperDigestFlushPendingNote=async()=>({saved:true});</script></body></html>",baseURL:nil)
  for _ in 0..<200 {if (try? await view.evaluateJavaScript("!!document.querySelector('iframe')?.contentDocument?.querySelector('#reference')&&Array.isArray(window.receipts)")) as? Bool==true{break};try await Task.sleep(nanoseconds:10_000_000)}
  view.navigationDelegate=app
  _=try await view.evaluateJavaScript("document.querySelector('iframe').contentDocument.querySelector('#reference').click();true")
  for _ in 0..<200 {if (try? await view.evaluateJavaScript("receipts.length")) as? Int==1{break};try await Task.sleep(nanoseconds:10_000_000)}
  let delivered=(try await view.evaluateJavaScript("receipts.length===1&&receipts[0].token==='\(token)'&&receipts[0].linkID==='0'")) as? Bool==true
  try require(delivered,"actual WK child link is canceled and delivered to parent event without child scripts")
  try require((try await view.evaluateJavaScript("document.querySelector('iframe').contentWindow.location.href")) as? String=="about:srcdoc","actual WK child remains its source document after capability navigation")
  for top in [false,true] {
   _=try await view.evaluateJavaScript("(()=>{const a=document.querySelector('iframe').contentDocument.querySelector('#reference');a.href='paperapp://app/index.html#pdf-page-5';a.target='\(top ? "_top":"_self")';a.click();})()")
   try await Task.sleep(nanoseconds:80_000_000)
   try require((try await view.evaluateJavaScript("!!document.querySelector('iframe')?.contentDocument?.querySelector('#reference')&&receipts.length===1")) as? Bool==true,"child cannot load entire application into \(top ? "top":"own") frame")
  }
  let directory=FileManager.default.temporaryDirectory.appendingPathComponent("ReaderBinding-"+UUID().uuidString);defer{try? FileManager.default.removeItem(at:directory)}
  let document=try Data(contentsOf:URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf")),published=ReaderPublishedFixture(document),study=PaperDigestApp()
  study.directory=directory;study.store=try DesktopStore(directory:directory);study.web=view
  study.library=try LibraryService(dataDirectory:directory,siteBaseURL:URL(string:"https://reader-fixture.test/blog/")!,transport:{url,limit in try await published.read(url,limit)})
  _=try await study.library.sync();let catalog=try await study.library.handle(command:"library.list",payload:["limit":100]),old=(catalog["papers"] as! [[String:Any]])[0]
  study.currentPaper=old;study.currentPaperID=old["id"] as! String;study.currentArticle=[:]
  let original=try JSONSerialization.data(withJSONObject:study.store.snapshot(),options:.sortedKeys)
  await published.advance();_=try await study.library.sync()
  var rejected=false;do{_=try await study.archiveMaterials([:])}catch{rejected=true}
  try require(rejected&&study.currentArticle.isEmpty,"archive lazy load validates v2 before publishing into empty v1 current article")
  var guideRejected=false;do{_=try study.modelSource(["scope":"guide"])}catch{guideRejected=true}
  try require(guideRejected,"failed archive never leaves unseen v2 prose available to v1 guide model source")
  try require(await published.pdfReads==0 && (try JSONSerialization.data(withJSONObject:study.store.snapshot(),options:.sortedKeys))==original,"rejected archive starts no PDF download and preserves personal history")
  let latest=try await study.library.handle(command:"library.list",payload:["limit":100]);study.currentPaper=(latest["papers"] as! [[String:Any]])[0]
  let accepted=try await study.archiveMaterials([:])
  try require(accepted["identity"] as? String=="arxiv:2610.27491v2" && study.currentArticle["sourceVersion"] as? String=="2610.27491v2","matching lazy archive source is installed and preserves normal preparation")
  print("Reader native regression: \(passed) passed; actual WK navigation and isolated Library source; no GUI, Keychain, provider or Zotero")
 }
}
