// Non-author AppDocuments integration: real ModelService sealing, actual offscreen
// WK content and temporary LibraryService. The worker/source transport are explicit
// fixtures. No real GUI, user files, network, Keychain or Zotero writes.
import AppKit
import WebKit
import PDFKit
import Foundation

private actor AppDocsPublishedFixture {
 let pdf:Data
 init(_ data:Data){pdf=data}
 let body="<h1>MiCLA integration fixture</h1><p>Explicit isolated published guide fixture; scientific claims are not introduced.</p><table><tr><th>Fixture</th></tr><tr><td>Bound source</td></tr></table>"
 func read(_ url:URL,_ limit:Int)throws->Data {
  if url.path=="/blog/index.json" {
   let citation:[String:Any]=["paperKey":"arxiv:2610.27491","identityStatus":"verified","verified":true,"complete":false,"authors":["Kohei Yamamoto","Kosuke Okusa"],"title":"MiCLA integration fixture","arxivId":"2610.27491v1","sourceKind":"arxiv","sourceUrl":"https://arxiv.org/abs/2610.27491v1","pdfUrl":"https://arxiv.org/pdf/2610.27491v1.pdf"]
   return try JSONSerialization.data(withJSONObject:[["permalink":"/blog/posts/evidence/","pageType":"paper","title":"MiCLA integration fixture","date":"2026-10-24","sourceKind":"arxiv","identityStatus":"verified","arxivId":"2610.27491","citation":citation]])
  }
  if url.lastPathComponent=="citation.json" {return try JSONSerialization.data(withJSONObject:["contract":"researcher-sidecars-v1","arxivId":"2610.27491v1","title":"MiCLA integration fixture","authors":["Kohei Yamamoto","Kosuke Okusa"]])}
  if url.lastPathComponent=="citation.bib" {return Data("@article{MiCLA_fixture, title={MiCLA integration fixture}, eprint={2610.27491}}\n".utf8)}
  if url.lastPathComponent=="citation.ris" {return Data("TY  - JOUR\nTI  - MiCLA integration fixture\nER  - \n".utf8)}
  if url.path.contains("/posts/evidence") {return Data(("<html><body><div id='article-body' class='post-content'>"+body+"</div><a href='/blog/files/citation.json'>JSON</a><a href='/blog/files/citation.bib'>BibTeX</a><a href='/blog/files/citation.ris'>RIS</a></body></html>").utf8)}
  if url.path.hasPrefix("/pdf/"){return pdf}
  throw URLError(.fileDoesNotExist)
 }
}
@main struct DesktopAppDocsEvidenceTests {
 @MainActor static func main() async throws {
  guard CommandLine.arguments.count==2 else{throw DesktopError.message("Pass test Node executable")}
  _=NSApplication.shared
  let fm=FileManager.default,root=fm.temporaryDirectory.appendingPathComponent("AppDocsEvidence-"+UUID().uuidString,isDirectory:true)
  try fm.createDirectory(at:root,withIntermediateDirectories:true);defer{try? fm.removeItem(at:root)}
  let directory=root.appendingPathComponent("Private",isDirectory:true),resources=root.appendingPathComponent("FixtureResources",isDirectory:true)
  try fm.createDirectory(at:resources.appendingPathComponent("Runtime"),withIntermediateDirectories:true)
  try fm.createSymbolicLink(at:resources.appendingPathComponent("Runtime/node"),withDestinationURL:URL(fileURLWithPath:CommandLine.arguments[1]))
  let worker="""
  let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>b+=s);process.stdin.on('end',()=>{JSON.parse(b);process.stdout.write(JSON.stringify({okay:true,text:'Explicit isolated answer [p.5]',model:'fixture-reported-model',protocol:'fixture-stdio',finishStatus:'completed',usage:{input_tokens:9,output_tokens:7,total_tokens:16}}));});
  """
  try Data(worker.utf8).write(to:resources.appendingPathComponent("llm-worker.cjs"))
  let app=PaperDigestApp();app.directory=directory;app.store=try DesktopStore(directory:directory)
  let secret="fixture-only-api-secret-must-never-export",endpoint="https://do-not-contact.invalid/private-model/v1",proxy="http://127.0.0.1:19997"
  try app.store.updateSettings(["endpoint":endpoint,"httpProxy":proxy,"model":"fixture-requested-model","protocol":"responses","responsesStream":true,"reasoningEffort":"low","maxTokens":4096])
  var keyReads=0
  app.model=ModelService(directory:directory,store:app.store,keyProvider:{keyReads+=1;return secret},resourcesDirectory:resources)
  let pdf=try Data(contentsOf:URL(fileURLWithPath:fm.currentDirectoryPath).appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf")),transport=AppDocsPublishedFixture(pdf)
  app.library=try LibraryService(dataDirectory:directory,siteBaseURL:URL(string:"https://app-docs-fixture.test/blog/")!,transport:{url,limit in try await transport.read(url,limit)})
  _=try await app.library.sync()
  let rows=try await app.library.handle(command:"library.list",payload:["limit":10]);app.currentPaper=(rows["papers"] as! [[String:Any]])[0];app.currentPaperID=app.currentPaper["id"] as! String
  let owner=app.currentPaperID
  app.currentArticle=try await app.library.handle(command:"library.article",payload:["paperID":owner])
  let downloaded=try await app.library.handle(command:"library.downloadPDF",payload:["paperID":owner]);app.currentPDFPath=URL(fileURLWithPath:downloaded["filePath"] as! String);app.currentPDFSHA=downloaded["sha256"] as! String;app.pdfOwner=owner
  let view=WKWebView(frame:NSRect(x:0,y:0,width:900,height:700));app.web=view
  let body=transport.body,escaped=body.replacingOccurrences(of:"&",with:"&amp;").replacingOccurrences(of:"\"",with:"&quot;")
  let revision=app.currentArticle["revisionSHA256"] as! String
  let readyScript="window.paperDigestFlushPendingNote=async()=>({saved:true});window.paperDigestArchiveHTML=()=>({paperID:'\(owner)',revision:'\(revision)',html:document.querySelector('iframe').contentDocument.querySelector('main').innerHTML});"
  view.loadHTMLString("<html><body><iframe sandbox='allow-same-origin' srcdoc=\"<main>\(escaped)</main>\"></iframe><script>\(readyScript)</script></body></html>",baseURL:nil)
  for _ in 0..<200 {if (try? await view.evaluateJavaScript("!!document.querySelector('iframe')?.contentDocument?.querySelector('main')&&typeof paperDigestArchiveHTML==='function'")) as? Bool==true{break};try await Task.sleep(nanoseconds:10_000_000)}
  var checks=0
  func require(_ value:Bool,_ label:String)throws{guard value else{throw DesktopError.message("FAIL "+label)};checks+=1;print("PASS "+label)}
  try require((try await view.evaluateJavaScript("document.querySelector('iframe').contentDocument.querySelector('h1').textContent")) as? String=="MiCLA integration fixture","actual WK renders bounded guide document used by native archive preparation")
  let evidence="Explicit original selected evidence <tag> & quotation.\nSecond source paragraph.",question="Explain only this selection",sessionID=UUID().uuidString
  let source:[String:Any]=["kind":"pdf-selection","paperID":owner,"pdfSHA":app.currentPDFSHA,"sourceVersion":"2610.27491v1","pages":[5],"page":5,"characters":evidence.count,"truncated":false,"currentness":"immutable-arxiv-version","isStale":false,"notices":[]]
  let saved=try await app.model.run(id:sessionID,paperID:owner,question:question,evidence:evidence,source:source)
  _=try await app.model.run(id:UUID().uuidString,paperID:"arxiv:other-fixture",question:"OTHER_PAPER_QUESTION",evidence:"OTHER_PAPER_EVIDENCE",source:["kind":"guide","paperID":"arxiv:other-fixture"])
  var decorated=saved;decorated["config"]=["endpoint":endpoint,"key":secret];decorated["internalMarker"]="INTERNAL_SESSION_MUST_NOT_EXPORT";try app.store.appendSession(decorated)
  _=try app.store.saveNote(id:owner,text:"Owner note <note>",baseRevision:0);_=try app.store.saveNote(id:"arxiv:other-fixture",text:"OTHER_PAPER_NOTE",baseRevision:0)
  try app.store.replaceAnnotations(id:owner,entries:[["id":"fixture-annotation","page":5,"text":"Owner exact quotation","comment":"Owner comment","pdfSHA":app.currentPDFSHA]])
  let archiveFolder=directory.appendingPathComponent("zotero-archives",isDirectory:true);try fm.createDirectory(at:archiveFolder,withIntermediateDirectories:true)
  let journal=archiveFolder.appendingPathComponent("prior-journal.json"),journalBytes=Data("{\"fixture\":\"old journal remains unchanged\"}".utf8);try journalBytes.write(to:journal)
  let materials=try await app.archiveMaterials([:]),analysis=materials["analysisHTML"] as? String ?? ""
  try require(analysis.contains("Explicit original selected evidence &lt;tag&gt; &amp; quotation.")&&analysis.contains("Second source paragraph.")&&analysis.contains("Explicit isolated answer"),"Zotero analysis includes exact run-sealed evidence with HTML escaping and saved answer")
  try require(materials["analysisNotice"]==nil && materials["pdfPath"] is String && materials["guideHTMLPath"] is String && (materials["noteHTML"] as? String ?? "").contains("Owner comment"),"verified analysis coexists with original PDF, actual WK guide and personal notes")
  let archiveJSON=String(decoding:try JSONSerialization.data(withJSONObject:materials),as:UTF8.self)
  for forbidden in [secret,endpoint,proxy,"OTHER_PAPER_EVIDENCE","OTHER_PAPER_QUESTION","OTHER_PAPER_NOTE","INTERNAL_SESSION_MUST_NOT_EXPORT"]{try require(!archiveJSON.contains(forbidden),"archive does not export unrelated or internal value: "+(forbidden.hasPrefix("OTHER") ? forbidden:"private sentinel"))}
  for format in ["markdown","html","json"] {
   let built=try await app.buildCurrentExport(["format":format]),text=String(decoding:built.data,as:UTF8.self)
   try require(text.contains(format=="html" ? "Explicit original selected evidence &lt;tag&gt; &amp; quotation.":"Explicit original selected evidence <tag> & quotation."),"research "+format+" contains actual sealed evidence")
   for forbidden in [secret,endpoint,proxy,"OTHER_PAPER_EVIDENCE","OTHER_PAPER_QUESTION","OTHER_PAPER_NOTE","INTERNAL_SESSION_MUST_NOT_EXPORT"]{try require(!text.contains(forbidden),"research "+format+" excludes private/unrelated sentinel")}
   if format=="json" {let object=try JSONSerialization.jsonObject(with:built.data) as! [String:Any],sessions=object["sessions"] as! [[String:Any]];try require(sessions.count==1 && sessions[0]["config"]==nil && (sessions[0]["sealedEvidence"] as? [String:Any])?["evidence"] as? String==evidence,"research JSON whitelist preserves only owner study and exact portable evidence")}
  }
  let input=directory.appendingPathComponent("ModelUsage/"+sessionID+"-input.json"),original=try Data(contentsOf:input);var damaged=original;damaged.append(0x20);try damaged.write(to:input,options:.atomic)
  let rejected=try await app.archiveMaterials([:])
  try require(rejected["analysisHTML"]==nil && (rejected["analysisNotice"] as? String ?? "").contains("校验未通过"),"tampered bound input makes Zotero analysis explicitly unavailable without presenting saved answer as verified")
  try require(rejected["pdfPath"] is String && rejected["guideHTMLPath"] is String && rejected["bibliography"] is [String:Any] && rejected["noteHTML"] is String,"bad analysis does not block bibliography, PDF, actual guide or personal notes")
  // A guide-only operation must not even require the model subsystem. A swallowed
  // exportEvidence error would not satisfy this guard: model is deliberately absent.
  let originalModel=app.model;app.model=nil
  let guideOnly=try await app.archiveMaterials([:],includeAnalysis:false)
  try require(guideOnly["guideHTMLPath"] is String && guideOnly["analysisHTML"]==nil && guideOnly["analysisNotice"]==nil,"explicit guide-only native preparation never enters personal model evidence export")
  let guideWithoutModel=try await app.buildCurrentExport(["format":"guide"])
  try require(guideWithoutModel.ext=="html" && String(decoding:guideWithoutModel.data,as:UTF8.self).contains("MiCLA integration fixture"),"guide export succeeds with no model subsystem despite an existing corrupted bound study")
  app.model=originalModel
  for format in ["markdown","html","json"] {var blocked=false;do{_=try await app.buildCurrentExport(["format":format])}catch{blocked=true};try require(blocked,"tampered source never enters research "+format+" as success")}
  for format in ["pdf","bib","ris","citation","guide"] {let built=try await app.buildCurrentExport(["format":format]);try require(!built.data.isEmpty,"bad study input does not block independent "+format+" export");if format=="pdf"{try require(built.data==pdf,"PDF export remains byte-identical to real public original")}}
  try original.write(to:input,options:.atomic)
  let snapshot=app.store.snapshot();var withoutStudies=snapshot;withoutStudies["sessions"]=[];try app.store.restorePersonal(withoutStudies)
  let noStudies=try await app.archiveMaterials([:]);try require(noStudies["analysisHTML"]==nil && noStudies["analysisNotice"]==nil && noStudies["pdfPath"] is String && noStudies["noteHTML"] is String,"no study is an honest optional item and does not block independent archive materials")
  for format in ["markdown","json","pdf","bib","ris","citation"] {let built=try await app.buildCurrentExport(["format":format]);try require(!built.data.isEmpty,"no study still permits "+format+" export")}
  let legacySource:[String:Any]=["kind":"published-reader","paperID":"arxiv:other-fixture","config":["key":secret],"internalMarker":"LEGACY_INTERNAL_SOURCE_SENTINEL"]
  let legacy:[String:Any]=["id":UUID().uuidString,"kind":"study","paperID":owner,"question":"Legacy question","text":"Legacy answer retained","status":"complete","source":legacySource,"model":"legacy-requested","startedAt":"2026-10-20T00:00:00Z"]
  try app.store.appendSession(legacy)
  let legacyArchive=try await app.archiveMaterials([:]),legacyHTML=legacyArchive["analysisHTML"] as? String ?? ""
  try require(legacyHTML.contains("Legacy answer retained")&&legacyHTML.contains("此旧研究没有绑定封存输入"),"legacy study preserves saved answer with explicit unavailable original-material notice")
  for forbidden in [secret,"LEGACY_INTERNAL_SOURCE_SENTINEL","arxiv:other-fixture"] {try require(!legacyHTML.contains(forbidden),"legacy archive never trusts unsealed source metadata")}
  for format in ["markdown","html","json"] {
   let built=try await app.buildCurrentExport(["format":format]),text=String(decoding:built.data,as:UTF8.self)
   try require(text.contains("Legacy answer retained")&&text.contains("此旧研究没有绑定封存输入"),"legacy "+format+" preserves answer with material-unavailable notice")
   for forbidden in [secret,"LEGACY_INTERNAL_SOURCE_SENTINEL","arxiv:other-fixture"] {try require(!text.contains(forbidden),"legacy "+format+" omits unsealed source/internal metadata")}
  }
  // Exercise the real WK flush suspension rather than a synchronous state change.
  for kind in ["research-export","zotero-materials"] {
   _=try await view.evaluateJavaScript("window.paperDigestFlushPendingNote=()=>new Promise(resolve=>window.releaseDocsFlush=resolve);delete window.releaseDocsFlush")
   let beforeGeneration=app.contextGeneration
   let operation=Task { @MainActor in
    if kind=="research-export" { _=try await app.buildCurrentExport(["format":"pdf"]) }
    else { _=try await app.archiveMaterials([:]) }
   }
   for _ in 0..<200 {if (try? await view.evaluateJavaScript("typeof window.releaseDocsFlush==='function'")) as? Bool==true{break};try await Task.sleep(nanoseconds:10_000_000)}
   app.currentPaperID="arxiv:other-fixture";app.contextGeneration+=1
   _=try await view.evaluateJavaScript("window.releaseDocsFlush({saved:true})")
   var rejectedOwner=false
   do { try await operation.value } catch {rejectedOwner=error.localizedDescription.contains("保存期间论文已切换")}
   try require(rejectedOwner,kind+" refuses owner switch during actual WK flush before exporting bytes or material paths")
   app.currentPaperID=owner;app.contextGeneration=beforeGeneration
  }
  let configuration=WKWebViewConfiguration(),scheme=BundleScheme(root:URL(fileURLWithPath:fm.currentDirectoryPath).appendingPathComponent("apps/macos/Resources"));configuration.setURLSchemeHandler(scheme,forURLScheme:"paperapp")
  let preview=WKWebView(frame:NSRect(x:0,y:0,width:900,height:700),configuration:configuration)
  let preparedJSON=String(decoding:try JSONSerialization.data(withJSONObject:rejected,options:[.sortedKeys]),as:UTF8.self)
  let previewScript="""
  import {mountZotero} from 'paperapp://app/zotero-ui.js';
  import {installDialogs} from 'paperapp://app/dialogs.js';
  window.previewCalls=[];
  const app={state:{paper:{id:'\(owner)'},personal:{},settings:{}},toast:()=>{},error:e=>{window.previewError=e.message;},exportArchiveMaterials:async()=> (\(preparedJSON)),call:async command=>{previewCalls.push(command);if(command==='zotero.status')return {running:true,version:'explicit-fixture',writesSupported:true,authorized:false,authorizationState:'unknown',archives:[]};if(command==='zotero.collections')return [];throw Error('Unexpected fixture command '+command);}};
  window.previewAPI=mountZotero(app);installDialogs();await previewAPI.openArchive();window.previewReady=true;
  """
  preview.loadHTMLString("<html><body><section data-setting-pane='zotero'></section><script type='module'>"+previewScript+"</script></body></html>",baseURL:URL(string:"paperapp://app/"))
  for _ in 0..<200 {if (try? await preview.evaluateJavaScript("window.previewReady===true")) as? Bool==true{break};try await Task.sleep(nanoseconds:10_000_000)}
  try require((try await preview.evaluateJavaScript("window.previewReady===true&&!window.previewError")) as? Bool==true,"actual WK mounts production Zotero UI with native bad-analysis material result")
  try require((try await preview.evaluateJavaScript("document.getElementById('archive-analysis').disabled&&!document.getElementById('archive-analysis').checked&&document.getElementById('archive-analysis-detail').textContent.includes('校验未通过')")) as? Bool==true,"bad analysis is explicitly explained and cannot be selected in real production WK controls")
  try require((try await preview.evaluateJavaScript("['archive-pdf','archive-guide','archive-note'].every(id=>{const e=document.getElementById(id);return !e.disabled&&e.checked;})")) as? Bool==true,"independent PDF/guide/note options remain enabled and selected after bad study input")
  try require((try await preview.evaluateJavaScript("previewCalls.every(command=>['zotero.status','zotero.collections'].includes(command))")) as? Bool==true,"preview performs only explicit fixture read commands and no authorization/archive/resume")
  try require(try Data(contentsOf:journal)==journalBytes,"archive/export preparation never rewrites pre-existing Zotero journal bytes")
  try require(keyReads==2,"all exports and archive preparation make zero additional secret/provider reads")
  print("AppDocuments evidence integration: \(checks) passed; real sealed-input service + actual WK + public PDF; fixture worker/transport only")
 }
}
