import Foundation

struct WarningTestFailure:Error{let message:String}
@main struct PublishedSourceWarningTests {
 static var count=0,failed=0
 static let id="conference:test:2026:paper:synthetic",blog="https://nanless.github.io/audio-paper-digest-blog/posts/synthetic-warning/",source="https://openreview.net/forum?id=synthetic"
 static let warning="  早期预印本，不是 camera-ready。\n<script>只作原文，不执行</script> & 原说明保留。  "
 static func citation()->[String:Any]{["contract":"paper-citation-source-v1","verified":true,"identityStatus":"verified","paperKey":id,"paperId":id,"sourceKind":"conference","pageUrl":blog,"sourceUrl":source,"url":source,"pdfUrl":"","arxivId":"","sourceVersionWarning":warning,"complete":false]}
 static var material:PublishedSourceWarning.Material{.init(paperID:id,blogURL:blog,sourceURL:source,pdfURL:nil,sourceVersion:nil)}
 static func encode<T:Encodable>(_ value:T)throws->Data{let e=JSONEncoder();e.outputFormatting=[.sortedKeys];return try e.encode(value)}
 static func check(_ b:@autoclosure()throws->Bool,_ m:String)throws{if try !b(){throw WarningTestFailure(message:m)}}
 static func run(_ name:String,_ f:()async throws->Void)async{do{try await f();count+=1;print("PASS "+name)}catch{failed+=1;print("FAIL "+name+": "+((error as? WarningTestFailure)?.message ?? String(describing:type(of:error))))}}
 static func article(_ c:[String:Any]?=nil)throws->LibraryService.Article{LibraryService.Article(paperID:id,html:"<p>原导读</p>",markdown:nil,plainText:"原导读",citation:try LibraryService.JSONValue.from(c ?? citation()),resources:[],sourceURL:source,pdfURL:nil,sourceVersion:nil,fetchedAt:"2026-01-01T00:00:00Z",revisionSHA256:String(repeating:"a",count:64),completeOffline:true,notices:["原提示"],blogURL:blog,mathMLContract:"published-html-mathml-v1")}
 static func main()async{
  await run("complete false exact full original warning"){try check(PublishedSourceWarning.warning(citation:citation(),material:material)==warning,"dropped incomplete citation or changed text")}
  await run("missing blank wrong-type warning no fabricated notice"){for value:Any in [NSNull(),false,9,""]{var c=citation();c["sourceVersionWarning"]=value;try check(PublishedSourceWarning.warning(citation:c,material:material)==nil,"invalid text")};var c=citation();c.removeValue(forKey:"sourceVersionWarning");try check(PublishedSourceWarning.warning(citation:c,material:material)==nil,"missing text")}
  await run("unverified wrong contract and numeric bool reject"){for (k,v):(String,Any) in [("verified",1),("verified",false),("identityStatus","unverified"),("contract","future-v1")]{var c=citation();c[k]=v;try check(PublishedSourceWarning.warning(citation:c,material:material)==nil,"unverified")}}
  await run("foreign owner or declared alias rejects"){for key in ["paperKey","paperId"]{var c=citation();c[key]="conference:test:other";try check(PublishedSourceWarning.warning(citation:c,material:material)==nil,"cross owner")}}
  await run("foreign page and source aliases reject"){for key in ["pageUrl","sourceUrl","url"]{var c=citation();c[key]="https://example.org/other";try check(PublishedSourceWarning.warning(citation:c,material:material)==nil,"cross source")}}
  await run("PDF binding no invented link"){var c=citation();c["pdfUrl"]="https://openreview.net/pdf?id=other";try check(PublishedSourceWarning.warning(citation:c,material:material)==nil,"foreign pdf");try check(PublishedSourceWarning.warning(citation:citation(),material:material)==warning,"missing PDF must not hide warning")}
  await run("arxiv actual stored version only"){var c=citation();c["sourceKind"]="arxiv";c["paperKey"]="arxiv:2601.00001";c["paperId"]="arxiv:2601.00001";c["arxivId"]="2601.00001v1";c["sourceUrl"]="https://arxiv.org/abs/2601.00001v1";c["url"]=c["sourceUrl"];c["pdfUrl"]="https://arxiv.org/pdf/2601.00001v1";let m=PublishedSourceWarning.Material(paperID:"arxiv:2601.00001",blogURL:blog,sourceURL:c["sourceUrl"] as! String,pdfURL:c["pdfUrl"] as? String,sourceVersion:"2601.00001v1");try check(PublishedSourceWarning.warning(citation:c,material:m)==warning,"valid version");c["arxivId"]="2601.00001v2";try check(PublishedSourceWarning.warning(citation:c,material:m)==nil,"new version graft")}
  await run("non-arxiv invalid version type rejects"){var c=citation();c["arxivId"]=false;try check(PublishedSourceWarning.warning(citation:c,material:material)==nil,"type coerced")}
  await run("stable merge exact dedup retains existing"){try check(PublishedSourceWarning.merge(["原提示",warning,"原提示"],citation:citation(),material:material)==["原提示",warning],"dedup lost text/order")}
  await run("actual Article projection preserves body revision and original"){let a=try article(),before=try encode(a);let p=LibraryService.presentSourceWarning(a);try check(p.notices==["原提示",warning] && p.html==a.html && p.plainText==a.plainText && p.revisionSHA256==a.revisionSHA256,"changed material");try check(try encode(a)==before,"mutated original")}
  await run("cold decode adds stored old warning never new catalog"){var c=citation();c["sourceVersionWarning"]="旧材料自身警告";let a=try article(c),bytes=try encode(a);let loaded=try JSONDecoder().decode(LibraryService.Article.self,from:bytes);let p=LibraryService.presentSourceWarning(loaded);let latestUnused="新版目录警告";try check(p.notices.contains("旧材料自身警告") && !p.notices.contains(latestUnused),"grafted latest");try check(p.revisionSHA256==loaded.revisionSHA256,"changed revision")}
  await run("offline dictionary manifest fallback same artifact only"){let a=try article();var raw=try JSONSerialization.jsonObject(with:encode(a)) as! [String:Any];raw.removeValue(forKey:"blogURL");let before=try JSONSerialization.data(withJSONObject:raw,options:.sortedKeys);let p=PublishedSourceWarning.project(raw,manifestBlogURL:blog);try check((p["notices"] as? [String])==["原提示",warning],"manifest binding missing");try check(try JSONSerialization.data(withJSONObject:raw,options:.sortedKeys)==before,"changed packet source");let bad=PublishedSourceWarning.project(raw,manifestBlogURL:"https://nanless.github.io/audio-paper-digest-blog/posts/other/");try check(!(bad["notices"] as! [String]).contains(warning),"foreign manifest")}
  await run("actual HTML parser keeps warning notices and literal body"){let c=try JSONSerialization.data(withJSONObject:citation(),options:.sortedKeys);let html="<html><body><div id='article-body' class='post-content'><p>原导读</p></div><script type='application/json' class='paper-tools__citation-record'>"+String(data:c,encoding:.utf8)!+"</script></body></html>";let p=LibraryService.Paper(id:id,title:"合成题目",titleZh:"合成题目",authors:[],date:"2026-01-01",score:nil,task:"",method:"",tags:[],sourceKind:"conference",identityStatus:"verified",pageType:"paper",blogURL:blog,sourceURL:source,pdfURL:nil,sourceVersion:nil,appearances:[blog],citation:try LibraryService.JSONValue.from(citation()));let a=try LibraryService.extractArticle(html,paper:p,pageURL:URL(string:blog)!);try check(a.notices.contains(warning),"parser warning missing");try check(a.plainText.contains("原导读") && !a.html.contains("只作原文"),"warning injected into body")}
  await run("SSRN generic host still denied"){try check(!LibraryService.isApprovedExternalResource(URL(string:"https://papers.ssrn.com/sol3/Delivery.cfm/6288899.pdf")!),"expanded SSRN host")}
  await run("actual fast cache does not graft latest catalog warning"){
   let fm=FileManager.default,root=fm.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("source-warning24-cache-"+UUID().uuidString,isDirectory:true);try fm.createDirectory(at:root,withIntermediateDirectories:true);defer{try? fm.removeItem(at:root)}
   let lib=root.appendingPathComponent("PublishedLibrary",isDirectory:true),cache=lib.appendingPathComponent("articles",isDirectory:true);try fm.createDirectory(at:cache,withIntermediateDirectories:true)
   var oldCitation=citation();oldCitation["sourceVersionWarning"]="旧材料自身警告";var old=try article(oldCitation);old.catalogEpoch="synthetic-epoch";old.fetchedAt=ISO8601DateFormatter().string(from:Date());let bytes=try encode(old)
   let file=cache.appendingPathComponent(PrivateStoragePaths.sha256(Data(blog.utf8))+".json");try bytes.write(to:file)
   var latest=citation();latest["sourceVersionWarning"]="新版目录警告";let paper:[String:Any]=["id":id,"title":"合成","titleZh":"合成","authors":[],"date":"2026-01-01","task":"","method":"","tags":[],"sourceKind":"conference","identityStatus":"verified","pageType":"paper","blogURL":blog,"sourceURL":source,"appearances":[blog],"citation":latest]
   let current:[String:Any]=["format":"mac-published-library-v1","validationEpoch":"synthetic-epoch","papers":[paper],"summary":["paperCount":1,"recordCount":1,"shardCount":1,"snapshotID":"synthetic","source":"https://nanless.github.io/audio-paper-digest-blog/","syncing":false,"missingFromLatest":[]]]
   try JSONSerialization.data(withJSONObject:current).write(to:lib.appendingPathComponent("current.json"))
   let service=try LibraryService(dataDirectory:root,transport:{_,_ in throw WarningTestFailure(message:"unexpected transport")})
   let returned=try await service.article(for:id,downloadImages:false)
   try check(returned.notices.contains("旧材料自身警告") && !returned.notices.contains("新版目录警告"),"latest grafted onto cache")
   try check(try Data(contentsOf:file)==bytes,"fast cache file rewritten")
  }
  await run("actual offline package derives own warning leaves all packet bytes"){
   let fm=FileManager.default,root=fm.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("source-warning24-package-"+UUID().uuidString,isDirectory:true);try fm.createDirectory(at:root,withIntermediateDirectories:true);defer{try? fm.removeItem(at:root)}
   let store=try await MainActor.run{try DesktopStore(directory:root)};let storage=DesktopStorage(directory:root,store:store)
   let a=try article();var raw=try JSONSerialization.jsonObject(with:encode(a)) as! [String:Any];raw.removeValue(forKey:"blogURL")
   let paper:[String:Any]=["id":id,"title":"合成","titleZh":"合成","blogURL":blog,"sourceURL":source,"sourceKind":"conference","identityStatus":"verified"]
   let cache=root.appendingPathComponent("PublishedLibrary/articles",isDirectory:true);try fm.createDirectory(at:cache,withIntermediateDirectories:true);let cacheFile=cache.appendingPathComponent(PrivateStoragePaths.sha256(Data(blog.utf8))+".json");let cacheBytes=try JSONSerialization.data(withJSONObject:raw,options:.sortedKeys);try cacheBytes.write(to:cacheFile)
   let registered=try await storage.register(paper:paper,article:raw);let packageID=registered["id"] as! String,folder=root.appendingPathComponent("Offline/"+packageID)
   var before:[String:Data]=[:];for name in ["paper.json","article.json","manifest.json"]{before[name]=try Data(contentsOf:folder.appendingPathComponent(name))}
   let opened=try await storage.openPackage(id:packageID),actual=opened["article"] as! [String:Any]
   try check((actual["notices"] as! [String]).contains(warning),"offline warning absent")
   for(name,bytes)in before{try check(try Data(contentsOf:folder.appendingPathComponent(name))==bytes,"offline original changed")}
   try check(try Data(contentsOf:cacheFile)==cacheBytes,"source cache rewritten")
  }
  let result:[String:Any]=["passed":count,"failed":failed,"syntheticOnly":true,"networkCalls":0,"pdfFetched":false,"GUIStarted":false,"fullMainCompiled":false]
  if CommandLine.arguments.count==2{try! JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:CommandLine.arguments[1]))};print("RESULT \(count) passed / \(failed) failed");exit(failed==0 ? 0:1)
 }
}
