// Strict published arXiv grammar and archive/settings contract; no Keychain or paid/network calls.
import AppKit
import WebKit
import Foundation
import Darwin

@main struct DesktopArchiveIdentityTests {
 @MainActor static func main() async throws {
  var checks=0
  func expect(_ value:Bool,_ label:String)throws{checks+=1;if !value{throw DesktopError.message("TEST: "+label)}}
  func rejects(_ label:String,_ action:()throws->Void)throws{var rejected=false;do{try action()}catch{rejected=true};try expect(rejected,label)}
  let legal=["math/0101001","hep-th/9901001","math.GT/0301001","cs.SE/0601001","nlin.CD/0201001","1501.00001","0706.0001"]
  for base in legal {
   try expect(try PaperDigestApp.archiveIdentity(paperID:"arxiv:"+base,sourceVersion:base+"v12")=="arxiv:"+base+"v12","archive retains exact canonical source version "+base)
   try expect(try PaperDigestApp.archiveIdentity(paperID:"arxiv:"+base,sourceVersion:base)=="arxiv:"+base,"unversioned metadata never invents fixed version "+base)
  }
  for bad in ["Math/0101001","math.gt/0101001","math.Gt/0101001","math/0113001","math/0101001v0","math/0101001v01","math/0101001v1tail","math/0101001\n","math/0101001/extra","math%2F0101001","../math/0101001"] {
   try rejects("invalid base cannot acquire archive identity "+bad.debugDescription){_=try PaperDigestApp.archiveIdentity(paperID:"arxiv:"+bad,sourceVersion:nil)}
  }
  for bad in ["math/0101001v0","math/0101001v01","math/0101001v1tail","math/0101001v1\n","math/0101001v1 ","math/0101001v1/extra","math/0101001v1?x=1","math/0101001v1#x","math/0101001v1/../x","https://arxiv.org/abs/math/0101001v1","math/0101002v1"] {
   try rejects("invalid or different paper version rejected "+bad.debugDescription){_=try PaperDigestApp.archiveIdentity(paperID:"arxiv:math/0101001",sourceVersion:bad)}
  }
  try expect(try PaperDigestApp.archiveIdentity(paperID:"arxiv:math/0101001",sourceVersion:nil)=="arxiv:math/0101001","missing version remains unknown")
  try expect(try PaperDigestApp.archiveIdentity(paperID:"conference:icml:2026:fixture",sourceVersion:"unrelated")=="conference:icml:2026:fixture","conference identity unchanged")
  _=NSApplication.shared
  let app=PaperDigestApp()
  for flag in [false,true]{try app.validateSettings(["responsesStream":flag]);checks+=1}
  for flag:Any in [0,1,"true",NSNull()]{try rejects("stream setting requires actual boolean"){try app.validateSettings(["responsesStream":flag])}}
  for effort in ["default","low","medium","high"]{try app.validateSettings(["reasoningEffort":effort]);checks+=1}
  for effort:Any in ["none","minimal","xhigh","LOW","",1,NSNull()]{try rejects("unsupported/invalid effort is not silently accepted"){try app.validateSettings(["reasoningEffort":effort])}}
  let root=FileManager.default.temporaryDirectory.appendingPathComponent("DesktopArchiveIdentity-"+UUID().uuidString)
  defer{try? FileManager.default.removeItem(at:root)}
  app.directory=root;app.store=try DesktopStore(directory:root)
  let seed=root.appendingPathComponent("empty-seed");try FileManager.default.createDirectory(at:seed,withIntermediateDirectories:true)
  app.library=try LibraryService(dataDirectory:root,seedDirectory:seed,transport:{_,_ in throw URLError(.notConnectedToInternet)})
  let web=WKWebView(frame:NSRect(x:0,y:0,width:700,height:500));app.web=web
  web.loadHTMLString("<html><body>Isolated archive identity fixture</body></html>",baseURL:nil)
  for _ in 0..<300{if (try? await web.evaluateJavaScript("document.body?.textContent.includes('Isolated archive identity fixture')")) as? Bool==true{break};try await Task.sleep(nanoseconds:20_000_000)}
  for base in ["math/0101001","math.GT/0301001"] {
   let id="arxiv:"+base,version=base+"v1",source="https://arxiv.org/abs/"+version,pdf="https://arxiv.org/pdf/"+version+".pdf"
   app.currentPaperID=id;app.currentPaper=["id":id,"title":"Explicit archive contract fixture","sourceKind":"arxiv","sourceURL":source,"pdfURL":pdf,"sourceVersion":version]
   app.currentArticle=["paperID":id,"sourceURL":source,"pdfURL":pdf,"sourceVersion":version,"citation":["title":"Explicit archive contract fixture","authors":["Fixture Author"],"sourceUrl":source],"revisionSHA256":String(repeating:"a",count:64),"completeOffline":false]
   try app.store.appendSession(["id":UUID().uuidString,"paperID":id,"kind":"study","status":"complete","question":"Explicit fixture provenance, no model invocation","text":"Explicit fixture only","responsesStream":true,"reasoningEffort":"low","maxTokens":4096,"finishStatus":"completed"])
   let result=try await app.archiveMaterials([:])
   try expect(result["identity"] as? String=="arxiv:"+version,"actual archive preparation retains canonical legacy v1: "+base)
   try expect(result["pdfPath"]==nil && result["pdfNotice"] is String,"missing unpublished fixture PDF stays explicit rather than fabricating attachment")
   let analysis=result["analysisHTML"] as? String ?? ""
   try expect(analysis.contains("responsesStream") && analysis.contains("reasoningEffort") && analysis.contains("4096") && analysis.contains("completed"),"archive keeps actual stored request policy and finish state")
  }
  print("DesktopArchiveIdentity PASS \(checks) checks; real WK archive assembly, temporary store, no Keychain/model/Zotero/production calls")
 }
}
