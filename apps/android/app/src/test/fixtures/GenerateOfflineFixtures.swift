import Foundation
import CryptoKit
import AppKit
import PDFKit
func digest(_ d:Data)->String{SHA256.hash(data:d).map{String(format:"%02x",$0)}.joined()}
func encoded(_ obj:Any)throws->Data{try JSONSerialization.data(withJSONObject:obj,options:.sortedKeys)}
@main struct GenerateOfflineFixtures {
 @MainActor static func main() async throws {
  let fm=FileManager.default,repo=URL(fileURLWithPath:CommandLine.arguments[1]),output=URL(fileURLWithPath:CommandLine.arguments[2])
  let root=fm.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("pd-public-offline-fixture-"+UUID().uuidString)
  try fm.createDirectory(at:root,withIntermediateDirectories:false);defer{try? fm.removeItem(at:root)}
  let store=try DesktopStore(directory:root),storage=DesktopStorage(directory:root,store:store,bundledSeedDirectory:root.appendingPathComponent("no-seed"))
  let blog="https://example.invalid/published/synthetic/",source="https://example.invalid/paper/synthetic"
  let citation:[String:Any] = ["title":"合成文献 / Synthetic", "authors":["Example Author"],"contract":"fixture-only-not-real-paper"]
  let paper:[String:Any] = ["id":"fixture:paper","title":"合成文献 / Synthetic","titleZh":"合成文献","authors":["Example Author"],"date":"2026-01-01","score":9.2,"task":"fixture","method":"fixture","tags":["fixture"],"sourceKind":"fixture","identityStatus":"unverified","pageType":"paper","blogURL":blog,"sourceURL":source,"sourceVersion":"fixture-v1","appearances":[blog],"citation":citation]
  let html="<h2>合成材料</h2><p>Only synthetic content: \\ 中文🙂.</p>"
  let article:[String:Any] = ["paperID":"fixture:paper","html":html,"plainText":"Only synthetic content.","citation":citation,"resources":[[String:Any]](),"sourceURL":source,"sourceVersion":"fixture-v1","fetchedAt":"2026-01-01T00:00:00Z","revisionSHA256":digest(Data(html.utf8)),"completeOffline":true,"isStale":false,"notices":["合成测试资料，不是真实论文"],"blogURL":blog,"mathMLContract":"published-html-mathml-v1","syntheticNumbers":[9.2,0.000001,Double(1e17),0.0],"syntheticKeys":["a2":1,"a10":2,"ab":3,"aB":4,"é":5]]
  let cache=root.appendingPathComponent("PublishedLibrary/articles");try fm.createDirectory(at:cache,withIntermediateDirectories:true)
  try encoded(article).write(to:cache.appendingPathComponent(digest(Data(blog.utf8))+".json"))
  let registered=try await storage.register(paper:paper,article:article)
  let v2id=registered["id"] as! String,v2=root.appendingPathComponent("Offline/"+v2id)
  _=try await storage.verifyPackage(id:v2id)
  var manifest=try JSONSerialization.jsonObject(with:Data(contentsOf:v2.appendingPathComponent("manifest.json"))) as! [String:Any]
  let identity:[String:Any] = ["articleSHA256":manifest["articleContentSHA256"]!,"paperID":manifest["paperID"]!,"revision":manifest["articleRevisionSHA256"]!,"sourceURL":manifest["sourceURL"]!,"sourceVersion":manifest["sourceVersion"] ?? NSNull(),"pdfSHA256":"","images":[String]()]
  let v1id=digest(try encoded(identity));manifest["contract"]="paperdigest-offline-package-v1";manifest["id"]=v1id;manifest.removeValue(forKey:"paperContentSHA256")
  let v1=root.appendingPathComponent("Offline/"+v1id);try fm.copyItem(at:v2,to:v1);try encoded(manifest).write(to:v1.appendingPathComponent("manifest.json"));_=try await storage.verifyPackage(id:v1id)
  var legacy=article;legacy.removeValue(forKey:"mathMLContract")
  try encoded(legacy).write(to:cache.appendingPathComponent(digest(Data(blog.utf8))+".json"))
  let legacyRegistered=try await storage.register(paper:paper,article:legacy),legacyID=legacyRegistered["id"] as! String
  let legacyOpened=try await storage.openPackage(id:legacyID)
  guard let legacyArticle=legacyOpened["article"] as? [String:Any],let notices=legacyArticle["notices"] as? [String],notices.contains(where:{$0.contains("旧离线HTML")})else{fatalError("Mac legacy warning absent")}
  // Generate genuine, public-only image/PDF bytes and pass the normal Mac
  // register path. Neither file is a user paper or a copied private cache.
  let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:2,pixelsHigh:2,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:8,bitsPerPixel:32)!
  for y in 0..<2 {for x in 0..<2 {bitmap.setColor(NSColor(calibratedRed:0.2,green:0.4,blue:0.8,alpha:1),atX:x,y:y)}}
  let png=bitmap.representation(using:.png,properties:[:])!,imageHash=digest(png),imageURL="https://example.invalid/figure/synthetic.png"
  let imageFile=root.appendingPathComponent("PublishedLibrary/assets/"+imageHash+".png");try fm.createDirectory(at:imageFile.deletingLastPathComponent(),withIntermediateDirectories:true);try png.write(to:imageFile)
  let pdfData=NSMutableData(),consumer=CGDataConsumer(data:pdfData as CFMutableData)!
  var media=CGRect(x:0,y:0,width:200,height:240);let graphics=CGContext(consumer:consumer,mediaBox:&media,nil)!
  graphics.beginPDFPage(nil);graphics.setFillColor(CGColor(red:0.2,green:0.4,blue:0.8,alpha:1));graphics.fill(CGRect(x:20,y:30,width:160,height:180));graphics.endPDFPage();graphics.closePDF()
  let pdfBytes=pdfData as Data,pdfHash=digest(pdfBytes),pdfURL="https://example.invalid/pdf/synthetic.pdf",pdfFile=root.appendingPathComponent("PublishedLibrary/pdf/"+pdfHash+".pdf")
  try fm.createDirectory(at:pdfFile.deletingLastPathComponent(),withIntermediateDirectories:true);try pdfBytes.write(to:pdfFile)
  guard PDFDocument(data:pdfBytes)?.pageCount==1 else{fatalError("Synthetic PDF is not a real one-page PDF")}
  var illustratedPaper=paper;illustratedPaper["pdfURL"]=pdfURL;illustratedPaper["pdfSHA256"]=pdfHash
  var illustrated=article;let illustratedHTML=html+"<figure><img src='"+imageURL+"'><figcaption>Public synthetic two-pixel figure</figcaption></figure>"
  illustrated["html"]=illustratedHTML;illustrated["revisionSHA256"]=digest(Data(illustratedHTML.utf8));illustrated["pdfURL"]=pdfURL
  illustrated["resources"]=[["sourceURL":imageURL,"kind":"image","localPath":imageFile.path,"sha256":imageHash]]
  try encoded(illustrated).write(to:cache.appendingPathComponent(digest(Data(blog.utf8))+".json"))
  let illustratedRegistered=try await storage.register(paper:illustratedPaper,article:illustrated,pdf:["filePath":pdfFile.path,"sha256":pdfHash,"bytes":pdfBytes.count,"sourceURL":pdfURL,"version":"fixture-v1"]),illustratedID=illustratedRegistered["id"] as! String
  _=try await storage.verifyPackage(id:illustratedID);let illustratedOpened=try await storage.openPackage(id:illustratedID)
  guard let openedPDF=illustratedOpened["pdf"] as? [String:Any],openedPDF["sha256"] as? String==pdfHash else{fatalError("Mac did not open the original synthetic PDF")}
  var packets:[[String:Any]]=[]
  for(id,folder)in[(v1id,v1),(v2id,v2),(legacyID,root.appendingPathComponent("Offline/"+legacyID)),(illustratedID,root.appendingPathComponent("Offline/"+illustratedID))]{
   var files:[[String:Any]]=[]
   let storedManifest=try JSONSerialization.jsonObject(with:Data(contentsOf:folder.appendingPathComponent("manifest.json"))) as! [String:Any]
   let names=((storedManifest["files"] as! [[String:Any]]).map{$0["path"] as! String}+["manifest.json"]).sorted()
   for name in names{let d=try Data(contentsOf:folder.appendingPathComponent(name));files.append(["path":name,"sha256":digest(d),"data":d.base64EncodedString()])}
   packets.append(["id":id,"files":files,"actualMacVerificationPassed":true,"legacyHTML":id==legacyID,"hasPDF":id==illustratedID,"hasImages":id==illustratedID])
  }
  let vectors:[Any] = [["slash":"https://example.invalid/a/b","text":"中文🙂\u{2028}\u{2029}","n":[9.2,0.000001,0.0000001,Double(1e15),Double(1e16),Double(1e17),-0.0]], ["aB":1,"ab":2,"a2":3,"a10":4,"z":5,"Z":6,"é":7]]
  let canonicalVectors=try vectors.map{value->[String:Any]in let raw=try encoded(value);let parsed=try JSONSerialization.jsonObject(with:raw);let data=try encoded(parsed);return ["input":parsed,"inputUTF8":String(decoding:raw,as:UTF8.self),"expectedUTF8":String(decoding:data,as:UTF8.self),"sha256":digest(data)]}
  var hashes:[String:String]=[:];for name in ["DesktopStorage.swift","DesktopStore.swift","BackupCodec.swift"]{hashes[name]=digest(try Data(contentsOf:repo.appendingPathComponent("apps/macos/Sources/"+name)))}
  let result:[String:Any] = ["contract":"paperdigest-public-offline-fixtures-v1","producer":"Actual macOS DesktopStorage.register and verifyPackage; temporary synthetic data only; not Android acceptance","macSources":hashes,"packets":packets,"foundationVectors":canonicalVectors]
  try fm.createDirectory(at:output.deletingLastPathComponent(),withIntermediateDirectories:true)
  try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys,.prettyPrinted]).write(to:output)
  print("Actual Mac v1/v2 verification passed; synthetic fixture packets: \(packets.count), canonical vectors: \(canonicalVectors.count)")
 }
}
