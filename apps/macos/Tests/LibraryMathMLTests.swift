// Real published MiCLA TeX, rendered by the locked KaTeX 0.19.1 into MathML.
// These are source-derived formulas, not a claim that HTTP HTML contained KaTeX.
// Source: https://nanless.github.io/audio-paper-digest-blog/posts/2026-10-21-micla-mixture-to-constituent-latent-alignment-for-2610-27491/
// Public Markdown SHA256: c64e56e59eedffc314dc9382413d4af59a9046397676e0f09e5f1817088fdb38
// Isolated Foundation/XML + actual Library cache, no network/GUI/Keychain/model.
import Foundation
import CryptoKit
import Darwin
import AppKit
import WebKit

actor MathMLFixtureTransport {
 var files:[String:Data]
 init(_ files:[String:Data]){self.files=files}
 func read(_ url:URL,_ limit:Int)throws->Data {guard let data=files[url.absoluteString],data.count<=limit else{throw LibraryService.ServiceError.network("isolated fixture unavailable")};return data}
 func put(_ address:String,_ data:Data?){files[address]=data}
}

@main struct LibraryMathMLTests {
 static var checks=0
 static let sourceURL="https://nanless.github.io/audio-paper-digest-blog/posts/2026-10-21-micla-mixture-to-constituent-latent-alignment-for-2610-27491/"
 static let formulas:[String]=[
#"""
<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><msub><mi mathvariant="bold">x</mi><mrow><mi mathvariant="normal">m</mi><mi mathvariant="normal">i</mi><mi mathvariant="normal">x</mi></mrow></msub><mo>=</mo><mi>μ</mi><msub><mi mathvariant="bold">x</mi><mi>a</mi></msub><mo>+</mo><mo stretchy="false">(</mo><mn>1</mn><mo>−</mo><mi>μ</mi><mo stretchy="false">)</mo><msub><mi mathvariant="bold">x</mi><mi>b</mi></msub><mi mathvariant="normal">.</mi></mrow><annotation encoding="application/x-tex">\mathbf{x}_{\mathrm{mix}}=\mu\mathbf{x}_{a}+(1-\mu)\mathbf{x}_{b}.</annotation></semantics></math></span>
"""#,
#"""
<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><msub><mi>ρ</mi><mi>α</mi></msub><mo stretchy="false">(</mo><mi mathvariant="bold">u</mi><mo separator="true">,</mo><mi mathvariant="bold">v</mi><mo stretchy="false">)</mo><mo>=</mo><mi mathvariant="bold">u</mi><mo>−</mo><mi>α</mi><mfrac><mrow><msup><mi mathvariant="bold">u</mi><mi mathvariant="normal">⊤</mi></msup><mi mathvariant="bold">v</mi></mrow><mrow><mi mathvariant="normal">∥</mi><mi mathvariant="bold">v</mi><msubsup><mi mathvariant="normal">∥</mi><mn>2</mn><mn>2</mn></msubsup></mrow></mfrac><mi mathvariant="bold">v</mi><mi mathvariant="normal">.</mi></mrow><annotation encoding="application/x-tex">\rho_{\alpha}(\mathbf{u},\mathbf{v})=\mathbf{u}-\alpha\frac{\mathbf{u}^{\top}\mathbf{v}}{\|\mathbf{v}\|_{2}^{2}}\mathbf{v}.</annotation></semantics></math></span>
"""#,
#"""
<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><msub><mi mathvariant="normal">ℓ</mi><mrow><mi mathvariant="normal">p</mi><mi mathvariant="normal">a</mi><mi mathvariant="normal">t</mi><mi mathvariant="normal">c</mi><mi mathvariant="normal">h</mi></mrow></msub><mo stretchy="false">(</mo><msub><mi mathvariant="bold">x</mi><mi>a</mi></msub><mo separator="true">,</mo><msub><mi mathvariant="bold">x</mi><mi>b</mi></msub><mo stretchy="false">)</mo><mo>=</mo><mfrac><mn>1</mn><mrow><mi mathvariant="normal">∣</mi><mi mathvariant="script">M</mi><mi mathvariant="normal">∣</mi></mrow></mfrac><munder><mo>∑</mo><mrow><mi>j</mi><mo>∈</mo><mi mathvariant="script">M</mi></mrow></munder><msubsup><mrow><mo fence="true">∥</mo><msubsup><mi mathvariant="bold">h</mi><mrow><mi>a</mi><mi mathvariant="normal">∣</mi><mi>b</mi></mrow><mrow><mo stretchy="false">(</mo><mi>j</mi><mo stretchy="false">)</mo></mrow></msubsup><mo>−</mo><mi mathvariant="normal">sg</mi><mo>⁡</mo><mrow><mo fence="true">(</mo><msubsup><mi mathvariant="bold">p</mi><mi>a</mi><mrow><mo stretchy="false">(</mo><mi>j</mi><mo stretchy="false">)</mo></mrow></msubsup><mo fence="true">)</mo></mrow><mo fence="true">∥</mo></mrow><mn>2</mn><mn>2</mn></msubsup><mi mathvariant="normal">.</mi></mrow><annotation encoding="application/x-tex">\ell_{\mathrm{patch}}(\mathbf{x}_{a},\mathbf{x}_{b})=\frac{1}{|\mathcal{M}|}\sum_{j\in\mathcal{M}}\left\|\mathbf{h}_{a|b}^{(j)}-\operatorname{sg}\left(\mathbf{p}_{a}^{(j)}\right)\right\|_{2}^{2}.</annotation></semantics></math></span>
"""#,
#"""
<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><msub><mi mathvariant="normal">ℓ</mi><mrow><mi mathvariant="normal">c</mi><mi mathvariant="normal">l</mi><mi mathvariant="normal">i</mi><mi mathvariant="normal">p</mi></mrow></msub><mo stretchy="false">(</mo><msub><mi mathvariant="bold">x</mi><mi>a</mi></msub><mo separator="true">,</mo><msub><mi mathvariant="bold">x</mi><mi>b</mi></msub><mo stretchy="false">)</mo><mo>=</mo><msubsup><mrow><mo fence="true">∥</mo><msub><mi>ρ</mi><msubsup><mi>α</mi><mrow><mi>a</mi><mi mathvariant="normal">∣</mi><mi>b</mi></mrow><mo lspace="0em" rspace="0em">⋆</mo></msubsup></msub><mrow><mo fence="true">(</mo><msub><mi mathvariant="bold">z</mi><mrow><mi mathvariant="normal">m</mi><mi mathvariant="normal">i</mi><mi mathvariant="normal">x</mi></mrow></msub><mo separator="true">,</mo><msub><mi mathvariant="bold">z</mi><mi>b</mi></msub><mo fence="true">)</mo></mrow><mo>−</mo><mi mathvariant="normal">sg</mi><mo>⁡</mo><mrow><mo fence="true">(</mo><msub><mi mathvariant="bold">t</mi><mi>a</mi></msub><mo fence="true">)</mo></mrow><mo fence="true">∥</mo></mrow><mn>2</mn><mn>2</mn></msubsup><mi mathvariant="normal">.</mi></mrow><annotation encoding="application/x-tex">\ell_{\mathrm{clip}}(\mathbf{x}_{a},\mathbf{x}_{b})=\left\|\rho_{\alpha_{a|b}^{\star}}\left(\mathbf{z}_{\mathrm{mix}},\mathbf{z}_{b}\right)-\operatorname{sg}\left(\mathbf{t}_{a}\right)\right\|_{2}^{2}.</annotation></semantics></math></span>
"""#
 ]
 static let tex:[String]=[
#"""
\mathbf{x}_{\mathrm{mix}}=\mu\mathbf{x}_{a}+(1-\mu)\mathbf{x}_{b}.
"""#,
#"""
\rho_{\alpha}(\mathbf{u},\mathbf{v})=\mathbf{u}-\alpha\frac{\mathbf{u}^{\top}\mathbf{v}}{\|\mathbf{v}\|_{2}^{2}}\mathbf{v}.
"""#,
#"""
\ell_{\mathrm{patch}}(\mathbf{x}_{a},\mathbf{x}_{b})=\frac{1}{|\mathcal{M}|}\sum_{j\in\mathcal{M}}\left\|\mathbf{h}_{a|b}^{(j)}-\operatorname{sg}\left(\mathbf{p}_{a}^{(j)}\right)\right\|_{2}^{2}.
"""#,
#"""
\ell_{\mathrm{clip}}(\mathbf{x}_{a},\mathbf{x}_{b})=\left\|\rho_{\alpha_{a|b}^{\star}}\left(\mathbf{z}_{\mathrm{mix}},\mathbf{z}_{b}\right)-\operatorname{sg}\left(\mathbf{t}_{a}\right)\right\|_{2}^{2}.
"""#
 ]
 static let base="https://fixture.example/blog/",identity="arxiv:2610.27491"
 static func hash(_ data:Data)->String{SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()}
 static func expect(_ result:Bool,_ label:String)throws{guard result else{throw LibraryService.ServiceError.invalid("FAIL "+label)};checks+=1;print("PASS "+label)}
 static func rejects(_ label:String,_ operation:()throws->Void)throws{var failed=false;do{try operation()}catch{failed=true};try expect(failed,label)}
 static func paper()->LibraryService.Paper {
  LibraryService.Paper(id:identity,title:"MiCLA: Mixture-to-Constituent Latent Alignment for Polyphonic Audio Representation Learning",titleZh:"MiCLA",authors:["Kohei Yamamoto","Kosuke Okusa"],date:"2026-10-21",score:7.5,task:"音频分类",method:"自监督学习",tags:[],sourceKind:"arxiv",identityStatus:"verified",pageType:"paper",blogURL:base+"posts/micla/",sourceURL:"https://arxiv.org/abs/2610.27491v1",pdfURL:"https://arxiv.org/pdf/2610.27491v1.pdf",sourceVersion:"2610.27491v1",appearances:[],citation:.object([:]))
 }
 static func page(_ body:String)->String{"<!doctype html><html><head><meta charset='utf-8'><title>Published fixture</title></head><body><div id='article-body' class='post-content'>"+body+"</div></body></html>"}
 static func extract(_ body:String)throws->LibraryService.Article {try LibraryService.extractArticle(page(body),paper:paper(),pageURL:URL(string:paper().blogURL)!)}
 static func document(_ fragment:String)throws->XMLDocument {try XMLDocument(xmlString:"<root>"+fragment+"</root>",options:[.nodePreserveWhitespace,.nodeLoadExternalEntitiesNever])}
 static func math(_ fragment:String)throws->[XMLElement] {try document(fragment).nodes(forXPath:"//*[local-name()='math']").compactMap{$0 as? XMLElement}}
 static func signature(_ element:XMLElement)->String {
  let attributes=(element.attributes ?? []).map{($0.name ?? "")+"="+($0.stringValue ?? "")}.sorted().joined(separator:"|")
  let children=(element.children ?? []).map{child in (child as? XMLElement).map{signature($0)} ?? (child.kind == .text ? "text:"+(child.stringValue ?? ""):"")}.joined()
  return "<"+(element.name ?? "")+" ns="+(element.uri ?? "")+" "+attributes+">"+children+"</>"
 }
 static func normal()throws {
  let body="<h2>Original method</h2><p>Source warning: do not infer unavailable structure.</p>"+formulas.enumerated().map{"<p id='before-\($0.offset)'>before \($0.offset)</p>"+$0.element+"<p id='after-\($0.offset)'>after \($0.offset)</p>"}.joined()+"<table><tr><td>Original table value</td></tr></table>"
  let old=try XMLDocument(xmlString:page(body),options:[.documentTidyHTML,.nodeLoadExternalEntitiesNever])
  try expect(try old.nodes(forXPath:"//*[local-name()='math']").isEmpty,"actual former HTML tidy loses all four real formula trees")
  let article=try extract(body),restored=try math(article.html),original=try math(formulas.joined())
  try expect(restored.count==4 && original.count==4,"four complete published-source KaTeX MathML formulas survive extraction")
  for index in 0..<4 {
   try expect(signature(restored[index])==signature(original[index]),"original MathML tree namespace attributes operators and Unicode preserved")
   let annotation=try restored[index].nodes(forXPath:".//*[local-name()='annotation']").first?.stringValue
   try expect(annotation==tex[index],"annotation remains bound to exact published original TeX")
   try expect(restored[index].attribute(forName:"display")?.stringValue=="block","original block display retained")
   try expect(article.plainText.components(separatedBy:tex[index]).count-1==1 && article.plainText.contains("\\["+tex[index]+"\\]"),"guide model evidence projects exact bound original TeX once, never visual-token plus annotation duplication")
   let before=article.plainText.range(of:"before \(index)")!,formula=article.plainText.range(of:tex[index])!,after=article.plainText.range(of:"after \(index)")!
   try expect(before.upperBound<=formula.lowerBound && formula.upperBound<=after.lowerBound,"surrounding original scientific text stays in order in model evidence")
  }
  let parsed=try document(article.html)
  for index in 0..<4 {
   let before=try parsed.nodes(forXPath:"//*[@id='before-\(index)']").first!,after=try parsed.nodes(forXPath:"//*[@id='after-\(index)']").first!
   try expect(before.nextSibling?.name=="span" && after.previousSibling?.name=="span","formula restored at its exact sibling position")
  }
  try expect(article.html.contains("Original table value") && article.html.contains("Source warning: do not infer unavailable structure."),"original table and certified-source warning survive")
  try expect(!article.html.contains("paperdigest-math-"),"no internal random placeholder leaks into article or exportable HTML")
  let inline=formulas[0].replacingOccurrences(of:"display=\"block\"",with:"display=\"inline\"")
  try expect(try math(extract("<p>inline "+inline+" suffix</p>").html).first?.attribute(forName:"display")?.stringValue=="inline","inline formula does not become a display block")
  try expect(try extract("<p>inline "+inline+" suffix</p>").plainText.contains("inline \\("+tex[0]+"\\) suffix"),"inline TeX projection preserves actual inline evidence boundary")
  try expect(try math(extract("<MATH><MI>x</MI></MATH>").html).first?.name=="math","HTML uppercase MathML is normalized safely")
  try expect(try math(extract("<math/>").html).count==1,"self-closing math does not consume following HTML")
  let nested="<math><mrow><math><mi>y</mi></math></mrow></math>"
  try expect(try math(extract(nested).html).count==2,"nested complete math boundaries remain balanced")
  let entities="<math xmlns='http://www.w3.org/1998/Math/MathML' title='a &gt; b'><semantics><mrow><mi>α</mi><mo>&lt;</mo><mi>β</mi></mrow><annotation encoding='application/x-tex'>α &lt; β &amp; x</annotation></semantics></math>"
  try expect(try signature(math(extract(entities).html)[0])==signature(math(entities)[0]),"quoted greater-than and escaped TeX entities preserve exact semantic tree")
  try expect(try extract(entities).plainText=="\\(α < β & x\\)","TeX annotation XML entities and Unicode decode exactly once in evidence")
  try expect(try extract("<p>left<math display='block'><semantics><mi>x</mi><annotation encoding='application/x-tex'> </annotation></semantics></math>right</p>").plainText.trimmingCharacters(in:.whitespacesAndNewlines)=="left\nx\nright","empty TeX annotation falls back to actual visible math, without invented TeX")
  try expect(try extract("<p>left<math><mi>x</mi></math>right</p>").plainText.trimmingCharacters(in:.whitespacesAndNewlines)=="leftxright","no annotation preserves normal visible text and does not synthesize TeX")
  if CommandLine.arguments.count>1 {
   let output=URL(fileURLWithPath:CommandLine.arguments[1]);try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
   let before=(try old.nodes(forXPath:"//*[@id='article-body']").first?.children ?? []).map{$0.xmlString}.joined()
   let css="<meta charset='utf-8'><style>body{font:18px/1.8 -apple-system,sans-serif;margin:40px;max-width:1000px}math{font-size:1.15em;margin:24px 0}table{border-collapse:collapse}td{border:1px solid #999;padding:8px}</style>"
   try Data(("<!doctype html><html>"+css+"<body><h1>旧HTML Tidy路径：公式结构丢失</h1>"+before+"</body></html>").utf8).write(to:output.appendingPathComponent("before.html"))
   try Data(("<!doctype html><html>"+css+"<body><h1>修复后：真实MiCLA四式</h1><p>公开发布TeX经锁定KaTeX 0.19.1派生的MathML；隔离回归。</p>"+article.html+"</body></html>").utf8).write(to:output.appendingPathComponent("after.html"))
  }
 }
 static func safety()throws {
  let fake="<math><mi>should-not-be-recovered</mi></math>"
  let tricky="<script>const x='"+fake+"';</script><style>/* "+fake+" */</style><textarea>"+fake+"</textarea><!-- "+fake+" --><p title='"+fake+"'>safe attribute text</p>"+formulas[0]
  let article=try extract(tricky)
  try expect(try math(article.html).count==1 && !article.html.contains("<script"),"script style textarea comment and quoted attribute fake formulas are never restored")
  try expect(try math(LibraryService.extractArticle("<!doctype html><html><head><title>"+fake+"</title></head><body><div id='article-body' class='post-content'>"+formulas[0]+"</div></body></html>",paper:paper(),pageURL:URL(string:paper().blogURL)!).html).count==1,"raw title text cannot manufacture a formula")
  let preseed=try extract("<p id='paperdigest-math-fixture-0'>original source node</p>"+formulas[0])
  try expect(preseed.html.contains("paperdigest-math-fixture-0") && (try math(preseed.html)).count==1,"source-provided placeholder-like identity never acquires restoration capability")
  let event=try extract("<math onclick='steal()' style='background:url(https://evil.invalid)'><mi onload='steal()' href='https://evil.invalid'>x</mi></math>")
  try expect(!event.html.contains("onclick") && !event.html.contains("onload") && !event.html.contains("href=") && !event.html.contains("style=") && !event.html.contains("evil.invalid"),"event style and external-link attributes cannot survive safe MathML restoration")
  let inert=try extract("<math><semantics><mi>x</mi><annotation encoding='application/x-tex'>&lt;img src='https://evil.invalid/tracker' onerror='steal()'&gt;</annotation></semantics></math>")
  try expect(inert.resources.isEmpty && !inert.html.contains("<img") && inert.html.contains("&lt;img") && inert.plainText.contains("<img src="),"hostile-looking annotation remains exact inert evidence text, never an image request or HTML injection")
  for unsafe in [
   "<math><script>steal()</script></math>","<math><foreignObject><div>foreign</div></foreignObject></math>",
   "<math><annotation-xml encoding='application/xhtml+xml'><div>foreign</div></annotation-xml></math>",
   "<math xmlns='https://evil.invalid'><mi>x</mi></math>",
   "<math xmlns:xlink='http://www.w3.org/1999/xlink'><mi xlink:href='https://evil.invalid'>x</mi></math>",
   "<math><mi mathcolor='url(https://evil.invalid)'>x</mi></math>",
   "<math><annotation encoding='text/html'>&lt;script&gt;steal()&lt;/script&gt;</annotation></math>",
   "<math><semantics><mi>x</mi><annotation encoding='application/x-tex'><script>steal()</script></annotation></semantics></math>",
   "<math><semantics><mi>x</mi><annotation encoding='application/x-tex'><mi>ambiguous nested text</mi></annotation></semantics></math>",
   "<math><semantics><mi>x</mi><annotation encoding='application/x-tex'>x</annotation><annotation encoding='application/x-tex'>y</annotation></semantics></math>",
   "<m:math xmlns:m='http://www.w3.org/1998/Math/MathML'><m:mi>x</m:mi></m:math>",
   "<math><mi>x</math>","<math><mi>x</mi>","</math><p>stray closing</p>",
   "<math><![DOCTYPE math SYSTEM 'https://evil.invalid/a.dtd'><mi>x</mi></math>",
   "<math><!-- missing comment end</math>","<math><mi title='missing>x</mi></math>"
  ]{try rejects("unsafe foreign active malformed or externally interpreted MathML explicitly rejected"){_=try extract(unsafe)}}
  for raw in [
   "<!DOCTYPE html SYSTEM 'https://evil.invalid/external.dtd'><html><div id='article-body' class='post-content'>x</div></html>",
   "<!DOCTYPE html PUBLIC 'public' 'file:///etc/hosts'><html><div id='article-body' class='post-content'>x</div></html>",
   "<!DOCTYPE html [<!ENTITY leak SYSTEM 'file:///etc/hosts'>]><html><div id='article-body' class='post-content'>&leak;</div></html>"
  ]{try rejects("external DOCTYPE and entity declaration never reaches HTML or XML entity resolution"){_=try LibraryService.extractArticle(raw,paper:paper(),pageURL:URL(string:paper().blogURL)!)}}
  try rejects("single formula size bounded before XML parsing"){_=try extract("<math><mtext>"+String(repeating:"x",count:256*1024)+"</mtext></math>")}
  try rejects("formula count bounded without silent truncation"){_=try extract(String(repeating:"<math><mi>x</mi></math>",count:513))}
  try rejects("total retained formula bytes bounded"){_=try extract(String(repeating:"<math><mtext>"+String(repeating:"x",count:240*1024)+"</mtext></math>",count:9))}
  try rejects("MathML tree depth bounded"){_=try extract("<math>"+String(repeating:"<mrow>",count:66)+"<mi>x</mi>"+String(repeating:"</mrow>",count:66)+"</math>")}
  try rejects("MathML node count bounded"){_=try extract("<math>"+String(repeating:"<mi>x</mi>",count:5000)+"</math>")}
 }
 static func integration()async throws {
  let folder=FileManager.default.temporaryDirectory.appendingPathComponent("MathMLArticleCache-"+UUID().uuidString);try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true);defer{try? FileManager.default.removeItem(at:folder)}
  let sealed=folder.appendingPathComponent("old-sealed-model-input.fixture"),sealedBytes=Data("old sealed evidence must not be reconstructed or rewritten".utf8);try sealedBytes.write(to:sealed)
  let p=paper(),row:[String:Any]=["permalink":p.blogURL,"pageType":"paper","paperId":identity,"sourceKind":"arxiv","identityStatus":"verified","title":p.title,"arxivId":"2610.27491","citation":["paperKey":identity,"arxivId":"2610.27491v1","sourceUrl":p.sourceURL!,"pdfUrl":p.pdfURL!]]
  let shard=try JSONSerialization.data(withJSONObject:[row],options:[.sortedKeys]),shardName="search-index/part-0001-"+hash(shard).prefix(12)+".json"
  let manifest:[String:Any]=["contract":"paper-search-index-manifest-v1","recordCount":1,"totalBytes":shard.count,"shards":[["url":shardName,"sha256":hash(shard),"bytes":shard.count,"recordCount":1]]]
  let body=formulas.joined()+"<img src='/blog/figure.png' alt='isolated cache fixture'><table><tr><td>retained value</td></tr></table>",html=page(body)
  let png=Data([0x89,0x50,0x4e,0x47,1,2,3]),transport=MathMLFixtureTransport([base+"index.json":try JSONSerialization.data(withJSONObject:manifest),base+shardName:shard,p.blogURL:Data(html.utf8),base+"figure.png":png])
  let library=try LibraryService(dataDirectory:folder,siteBaseURL:URL(string:base)!,transport:{url,limit in try await transport.read(url,limit)})
  _=try await library.sync()
  let article=try await library.article(for:identity),expected=try math(formulas.joined()).map{signature($0)}
  try expect(article.completeOffline && article.mathMLContract=="published-html-mathml-v1","new scientific HTML cache records actual preservation contract")
  try expect(try math(article.html).map{signature($0)}==expected,"second image-localization HTML parse retains all four original formula trees")
  try expect(article.html.contains("data:image/png;base64,") && article.html.contains("retained value"),"formula preservation and image embedding/table rendering work together")
  let reopened=try await library.article(for:identity)
  try expect(try math(reopened.html).map{signature($0)}==expected,"complete current cache reopens with exact MathML semantics")
  let cache=folder.appendingPathComponent("PublishedLibrary/articles/"+hash(Data(p.blogURL.utf8))+".json")
  var legacy=try JSONSerialization.jsonObject(with:Data(contentsOf:cache)) as! [String:Any];legacy.removeValue(forKey:"mathMLContract");legacy["html"]="<p>old HTML tidy lost formulas</p>";legacy["revisionSHA256"]=hash(Data("legacy-fixture".utf8));try JSONSerialization.data(withJSONObject:legacy).write(to:cache)
  let revisions=folder.appendingPathComponent("PublishedLibrary/article-revisions/"+hash(Data(p.blogURL.utf8))),oldFiles=try FileManager.default.contentsOfDirectory(at:revisions,includingPropertiesForKeys:nil).reduce(into:[String:Data]()){result,url in result[url.lastPathComponent]=try? Data(contentsOf:url)}
  let renewed=try await library.article(for:identity)
  try expect(renewed.mathMLContract=="published-html-mathml-v1" && (try math(renewed.html)).map{signature($0)}==expected,"legacy cache without scientific-parser witness rereads source rather than blessing old loss")
  for (name,data) in oldFiles{try expect(try Data(contentsOf:revisions.appendingPathComponent(name))==data,"existing scientific revision bytes remain unchanged")}
  let revisionValues=try FileManager.default.contentsOfDirectory(at:revisions,includingPropertiesForKeys:nil).map{try JSONSerialization.jsonObject(with:Data(contentsOf:$0)) as! [String:Any]}
  try expect(revisionValues.contains{$0["mathMLContract"]==nil && $0["html"] as? String=="<p>old HTML tidy lost formulas</p>"},"old lossy cache preserved as a distinct historical revision")
  try JSONSerialization.data(withJSONObject:legacy).write(to:cache);await transport.put(p.blogURL,nil)
  let offline=try await library.article(for:identity)
  try expect(offline.isStale==true && offline.notices.contains{$0.contains("部分MathML可能缺失")},"unavailable source leaves old cache readable with explicit old-formula warning, no fabricated upgrade")
  try expect(try Data(contentsOf:sealed)==sealedBytes,"published-library reads never rewrite an unrelated pre-existing evidence fixture")
 }
 @MainActor static func wk()async throws {
  _=NSApplication.shared
  let configuration=WKWebViewConfiguration();configuration.websiteDataStore = .nonPersistent()
  let web=WKWebView(frame:NSRect(x:0,y:0,width:1080,height:700),configuration:configuration)
  let literal="<math><semantics><mi>x</mi><annotation encoding='application/x-tex'><![CDATA[</annotation><script>window.injected=true</script>]]></annotation></semantics></math>"
  let article=try extract("<p id='source-before'>before actual formulas</p>"+formulas.joined()+literal+"<p id='source-after'>after actual formulas</p>")
  web.loadHTMLString("<!doctype html><html><head><meta charset='utf-8'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'\"></head><body>"+article.html+"</body></html>",baseURL:nil)
  for _ in 0..<200 {if (try? await web.evaluateJavaScript("document.readyState==='complete'&&document.querySelectorAll('math').length===5")) as? Bool==true{break};try await Task.sleep(nanoseconds:10_000_000)}
  let observed=try await web.evaluateJavaScript("({math:document.querySelectorAll('math').length,annotations:[...document.querySelectorAll('math')].slice(0,4).map(e=>e.querySelector('annotation').textContent),namespaces:[...document.querySelectorAll('math')].map(e=>e.namespaceURI),scripts:document.querySelectorAll('script').length,external:document.querySelectorAll('[src],[href]').length,injected:window.injected===true,before:document.body.firstElementChild.id,after:document.body.lastElementChild.id})") as! [String:Any]
  try expect(observed["math"] as? Int==5 && observed["annotations"] as? [String]==tex,"actual offscreen WebKit receives all four original semantic MathML annotations")
  try expect((observed["namespaces"] as? [String])?.allSatisfy{$0=="http://www.w3.org/1998/Math/MathML"}==true,"actual WebKit recognizes restored formulas as MathML, not generic HTML")
  try expect(observed["scripts"] as? Int==0 && observed["external"] as? Int==0 && observed["injected"] as? Bool==false,"literal hostile CDATA annotation creates no active HTML or external resource in actual WebKit")
  try expect(observed["before"] as? String=="source-before" && observed["after"] as? String=="source-after","actual WebKit keeps scientific text around formulas in source order")
  try expect(web.window==nil,"native MathML regression never orders or focuses a user window")
 }
 @MainActor static func displayOverflow()async throws {
  let mac=URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("apps/macos")
  let fixtureURL=URL(fileURLWithPath:#filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/sofilnet-display-math.json")
  let fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:fixtureURL)) as! [String:Any]
  let real=fixture["formulas"] as! [[String:String]],annotations=real.map{$0["tex"]!}
  try expect(real.count==4,"four source-bound SoFilNet display formulas used for actual WebKit overflow regression")
  func source(_ relative:String)throws->String {try String(contentsOf:mac.appendingPathComponent(relative),encoding:.utf8)}
  func between(_ value:String,_ start:String,_ end:String)throws->String {
   guard let a=value.range(of:start),let z=value.range(of:end,range:a.upperBound..<value.endIndex) else{throw LibraryService.ServiceError.invalid("missing actual production renderer boundary")}
   return String(value[a.upperBound..<z.lowerBound])
  }
  let native=try source("Resources/native.js"),aggregate=try source("Resources/aggregate-native-renderer.js")
  let helperStart="function escapedAt",helperEnd="const readerCSS=",aggregateEnd="const nonce=window.__nativeAggregateNonce"
  guard let start=native.range(of:helperStart),let markdown=native.range(of:"function markdownHTML"),let rendering=native.range(of:"function renderMath(body)"),let end=native.range(of:helperEnd),let aggregateStart=aggregate.range(of:helperStart),let aggregateTail=aggregate.range(of:aggregateEnd) else{throw LibraryService.ServiceError.invalid("missing actual scientific renderer")}
  let helper=String(native[start.lowerBound..<markdown.lowerBound])+String(native[rendering.lowerBound..<end.lowerBound]),aggregateHelper=String(aggregate[aggregateStart.lowerBound..<aggregateTail.lowerBound])
  try expect(helper.trimmingCharacters(in:.whitespacesAndNewlines)==aggregateHelper.trimmingCharacters(in:.whitespacesAndNewlines),"reader and native aggregate execute the same actual scientific rendering helpers")
  let katex=try source("node_modules/katex/dist/katex.min.js")
  let variants=[("reader",try between(native,"const readerCSS=`","`;")),("web-aggregate",try between(source("Resources/aggregate-ui.js"),"const frameCSS=`","`;")),("native-aggregate",try source("Resources/aggregate-native-body.css")),("standalone-guide",try between(source("Sources/AppDocuments.swift"),"<style>","</style>"))]
  let controls="<p id='inline-control'>前文<math><mi>x</mi></math>后文</p><math id='nested-control'><mrow><math display='block'><mi>y</mi></math></mrow></math><pre id='code-control'><code><math display='block'><mi>z</mi></math></code></pre><table><tr>"+(0..<12).map{"<td>受控宽表列\($0)</td>"}.joined()+"</tr></table>"
  for (name,css) in variants {for raw in [false,true] {for width in [430,700] {
   let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
   let web=WKWebView(frame:NSRect(x:0,y:0,width:CGFloat(width),height:1000),configuration:config)
   let html="<!doctype html><html><head><meta charset='utf-8'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none';script-src 'none';style-src 'unsafe-inline'\"><style>"+css+":root{--font:24px}</style></head><body><main></main></body></html>"
   web.loadHTMLString(html,baseURL:nil);var ready=false
   for _ in 0..<400 {if (try? await web.evaluateJavaScript("document.readyState==='complete'&&!!document.querySelector('main')")) as? Bool==true{ready=true;break};try await Task.sleep(nanoseconds:10_000_000)}
   try expect(ready,"actual script-free WebKit document loaded for "+name)
   // Native test inspection runs the exact trusted renderer; page content remains script-free.
   _=try await web.evaluateJavaScript(katex+";true")
   _=try await web.evaluateJavaScript(helper+";true")
   let payload:[String:Any]=["formulas":real.map{$0["html"]!},"tex":annotations,"controls":controls,"raw":raw]
   let encoded=String(decoding:try JSONSerialization.data(withJSONObject:payload,options:.sortedKeys),as:UTF8.self)
   let observed=try await web.evaluateJavaScript("const fixture112="+encoded+";" + #"""
   (()=>{
    const main=document.querySelector('main');main.innerHTML=fixture112.formulas.map((html,i)=>'<section id="formula-'+i+'">'+html+'</section>').join('')+fixture112.controls;
    if(fixture112.raw)for(const s of main.querySelectorAll('section')){const math=s.querySelector('math');s.replaceChildren(math);}
    const formulas=[...main.querySelectorAll('section math')],before=formulas.map(m=>m.outerHTML),expected=fixture112.raw?before:fixture112.tex.map(tex=>{const host=document.createElement('span');katex.render(tex,host,{displayMode:true,throwOnError:false,output:'mathml',trust:false,strict:'warn'});return host.querySelector('math').outerHTML;}),controlBefore=['inline-control','nested-control','code-control'].map(id=>document.getElementById(id).outerHTML);
    renderMath(main);const once=main.innerHTML;renderMath(main);
    const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
    const metrics=formulas.map((old,i)=>{const m=document.querySelector('#formula-'+i+' math'),parent=m.parentElement,box=rect(parent),glyphs=[...m.querySelectorAll('mi,mn,mo')].filter(n=>!n.closest('annotation')),first=glyphs[0],last=glyphs[glyphs.length-1];parent.scrollLeft=0;const firstLeft=rect(first).left;parent.scrollLeft=100000;const lastRight=rect(last).right;const value={client:parent.clientWidth,scroll:parent.scrollWidth,left:parent.scrollLeft,firstVisible:firstLeft>=box.left-1,lastVisible:lastRight<=box.right+1,local:parent!==main&&parent.clientWidth>0&&getComputedStyle(parent).overflowX==='auto',preserved:m.outerHTML===expected[i],rawNodePreserved:!fixture112.raw||m===old,originalMarkupExact:m.outerHTML===before[i],annotation:m.querySelector('annotation').textContent};parent.scrollLeft=0;parent.focus();value.focused=document.activeElement===parent;value.accessible=parent.tabIndex===0&&parent.getAttribute('role')==='region'&&parent.getAttribute('aria-label')==='数学公式'&&parent.getAttribute('aria-description')==='内容较宽时可左右滚动';return value;});
    const direct=document.createElement('span');renderScientificMath(fixture112.tex[0],direct,true);const display=direct.querySelector('math[display=block]').parentElement;const markdownDisplayAccessible=display.tabIndex===0&&display.getAttribute('aria-label')==='数学公式'&&display.getAttribute('aria-description')==='内容较宽时可左右滚动';
    const inline=document.querySelector('#inline-control'),range=document.createRange();range.selectNodeContents(inline.firstChild);const text=range.getBoundingClientRect(),mathRect=inline.querySelector('math').getBoundingClientRect();
    const table=main.querySelector('table');table.scrollLeft=100000;
    return {metrics,markdownDisplayAccessible,idempotent:once===main.innerHTML,controlsExact:controlBefore.every((x,i)=>x===document.getElementById(['inline-control','nested-control','code-control'][i]).outerHTML),inlineSameLine:Math.min(text.bottom,mathRect.bottom)>Math.max(text.top,mathRect.top),docWidth:document.documentElement.scrollWidth,viewport:innerWidth,katex:katex.version,table:{client:table.clientWidth,scroll:table.scrollWidth,left:table.scrollLeft}};
   })()
   """#) as! [String:Any]
   let metrics=observed["metrics"] as! [[String:Any]]
   try expect(observed["katex"] as? String=="0.19.1" && metrics.map{$0["annotation"] as! String}==annotations,"actual locked renderer retains all four exact public TeX annotations")
   try expect(metrics.allSatisfy{$0["preserved"] as? Bool==true && $0["rawNodePreserved"] as? Bool==true} && observed["controlsExact"] as? Bool==true && observed["idempotent"] as? Bool==true,"display wrapping preserves direct original MathML nodes/trees, canonical KaTeX DOM result and controls idempotently")
   try expect(metrics.allSatisfy{v in let overflow=(v["scroll"] as! Int)-(v["client"] as! Int);return v["local"] as? Bool==true && v["firstVisible"] as? Bool==true && v["lastVisible"] as? Bool==true && (overflow<=1 || (v["left"] as! Int)>0)},"actual WebKit local horizontal scroll reaches first and last visible glyph in "+name+" raw=\(raw) width=\(width)")
   try expect((observed["docWidth"] as! Int)<=(observed["viewport"] as! Int)+1 && observed["inlineSameLine"] as? Bool==true,"display overflow stays local; inline math remains on its prose line")
   let table=observed["table"] as! [String:Any]
   try expect((table["scroll"] as! Int)>(table["client"] as! Int)+1 ? (table["left"] as! Int)>0 : (table["left"] as! Int)==0,"ordinary table is naturally fitted or locally scrollable when its actual width requires it")
   try expect(metrics.allSatisfy{$0["focused"] as? Bool==true && $0["accessible"] as? Bool==true} && observed["markdownDisplayAccessible"] as? Bool==true,"actual WK formula HTML containers accept DOM focus with Chinese instructions, including Markdown direct rendering")
   try expect(web.window==nil,"overflow test never opens or focuses a window")
   print("WK_DISPLAY_MATH "+String(decoding:try JSONSerialization.data(withJSONObject:["variant":name,"raw":raw,"width":width,"observed":observed],options:.sortedKeys),as:UTF8.self))
   web.stopLoading()
  }}}
 }
 @MainActor static func main()async throws {setbuf(stdout,nil);try normal();try safety();try await integration();try await wk();try await displayOverflow();print("LibraryMathML PASS \(checks) checks; real published-source four formulas, actual isolated WK and cache, no network/user GUI/model/Keychain")}
}
