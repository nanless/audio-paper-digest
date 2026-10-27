import Foundation
import Darwin
@main struct AggregateResourcesTests {
 static var passed=0
 static func check(_ value:Bool,_ message:String)throws{if !value{throw AggregateFailure.invalid("TEST "+message)};passed+=1;print("PASS "+message)}
 static func rejects(_ body:()throws->Void)->Bool{do{try body();return false}catch{return true}}
 static func main() async throws {
  setbuf(stdout,nil)
  let fm=FileManager.default,root=fm.temporaryDirectory.appendingPathComponent("aggregate-images45-"+UUID().uuidString);defer{try?fm.removeItem(at:root)}
  try fm.createDirectory(at:root.appendingPathComponent("index"),withIntermediateDirectories:true)
  let shard=try JSONSerialization.data(withJSONObject:[["pageType":"daily","permalink":"/audio-paper-digest-blog/ci-images/","title":"Controlled image fixture","date":"2026-10-24"]],options:.sortedKeys),sha=PublishedAggregateReader.sha(shard)
  let rawManifest=try JSONSerialization.data(withJSONObject:["contract":"paper-search-index-manifest-v1","recordCount":1,"totalBytes":shard.count,"shards":[["url":"search-index/part-0001-"+sha.prefix(12)+".json","sha256":sha,"bytes":shard.count,"recordCount":1]]],options:.sortedKeys)
  try shard.write(to:root.appendingPathComponent("index/"+sha+".json"));let store=PublishedAggregateStore(directory:root),catalog=try store.stage(manifest:rawManifest,validationEpoch:UUID().uuidString),descriptor=catalog.records[0]
  let html=Data("<html><head><link rel='canonical' href='https://nanless.github.io/audio-paper-digest-blog/ci-images/'/></head><body><div id='article-body' class='post-content'><p>Before</p><figure><img src='https://arxiv.org/html/2610.30682/x1.png' alt='First'/><figcaption>Real slot caption A</figcaption></figure><p>Between</p><figure><img src='https://arxiv.org/html/2610.30682/x1.png' alt='Second'/><figcaption>Real slot caption B</figcaption></figure><p>After</p></div></body></html>".utf8)
  let source=try store.cacheDocument(html,descriptor:descriptor,responseURL:URL(string:descriptor.sourceURL)!,fetchedAt:"2026-10-24T00:00:00Z"),plan=try store.imagePlan(source)
  try check(plan.slots.count==2&&plan.slots[0].index==0&&plan.slots[1].index==1&&plan.slots[0].caption=="Real slot caption A"&&plan.slots[1].caption=="Real slot caption B","original HTML binds each position/alternative/caption despite duplicate URL")
  let png=Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlYQAAAAASUVORK5CYII=")!,asset=AggregateImageBytes(data:png,mime:"image/png"),hash=PublishedAggregateReader.sha(png)
  let originalFolder=root.appendingPathComponent("aggregate-documents/"+PublishedAggregateReader.sha(Data(descriptor.id.utf8))+"/"+descriptor.source.manifestSHA256+"/"+source.rawHTMLSHA256)
  let before=try ["original.html","body.html","document.json"].map{try Data(contentsOf:originalFolder.appendingPathComponent($0))}
  let full=try store.cacheResourceRendering(source:source,plan:plan,images:[0:asset,1:asset],missing:[:],observedAt:"2026-10-27T00:00:00Z")
  try check(full.bodyHTML.components(separatedBy:"data:image/png;base64,").count==3&&full.bodyHTML.contains("caption A")&&full.bodyHTML.contains("caption B") && !full.manifest.completeOffline,"two original slots render typed bytes in place with captions and conservative offline state")
  try check(try store.cachedResourceRendering(source:source,manifestSHA256:full.manifestSHA256).bodyHTML==full.bodyHTML,"resource rendering cold replays source, whole manifest and every image")
  let partial=try store.cacheResourceRendering(source:source,plan:plan,images:[0:asset],missing:[1:"Controlled missing image"],observedAt:"2026-10-27T00:00:01Z")
  try check(partial.manifestSHA256 != full.manifestSHA256&&partial.bodyHTML.contains("图片未缓存：Second")&&partial.bodyHTML.contains("caption B"),"partial observation is separate immutable manifest and keeps missing position/caption")
  try check(try ["original.html","body.html","document.json"].enumerated().allSatisfy{try Data(contentsOf:originalFolder.appendingPathComponent($0.element))==before[$0.offset]},"resource observations do not overwrite any original HTML/document/body")
  let changed=AggregateImagePlan(contract:plan.contract,descriptor:plan.descriptor,rawHTMLSHA256:String(repeating:"a",count:64),originalBodySHA256:plan.originalBodySHA256,slots:plan.slots,templateBodyHTML:plan.templateBodyHTML,templateBodySHA256:plan.templateBodySHA256)
  try check(rejects{_=try store.cacheResourceRendering(source:source,plan:changed,images:[0:asset],missing:[:],observedAt:"2026-10-27T00:00:02Z")},"another HTML identity cannot borrow resource plan")
  try check(rejects{_=try store.cacheResourceRendering(source:source,plan:plan,images:[3:asset],missing:[:],observedAt:"2026-10-27T00:00:02Z")},"unknown resource position is rejected")
  try check(rejects{_=try store.cacheResourceRendering(source:source,plan:plan,images:[0:asset],missing:[0:"conflict"],observedAt:"2026-10-27T00:00:02Z")},"success and failure cannot both claim same slot")
  try check(rejects{_=try store.cacheResourceRendering(source:source,plan:plan,images:[0:.init(data:png,mime:"image/jpeg")],missing:[:],observedAt:"2026-10-27T00:00:02Z")},"declared MIME must match actual supported image bytes")
  try check(rejects{_=try LibraryService.aggregateImagePlan(source,rawHTML:html+Data("changed".utf8))},"changed raw HTML cannot produce a plan under prior SHA")
  func declaredLengthError(_ length:Int)throws->String {
   let absent=String(repeating:"b",count:64)
   guard !fm.fileExists(atPath:root.appendingPathComponent("aggregate-image-bytes-v1/"+absent).path) else{throw AggregateFailure.invalid("TEST missing asset precondition failed")}
   let records=[AggregateImageRecord(slot:plan.slots[0],sha256:hash,mime:"image/png",bytes:length,missingReason:nil),AggregateImageRecord(slot:plan.slots[1],sha256:absent,mime:"image/png",bytes:png.count,missingReason:nil)]
   let bad=AggregateResourceManifest(contract:AggregateResources.contract,plan:plan,observedAt:"2026-10-27T00:00:03Z",images:records,renderedBodySHA256:full.manifest.renderedBodySHA256,completeOffline:false)
   let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys,.withoutEscapingSlashes];let bytes=try encoder.encode(bad),sha=PublishedAggregateReader.sha(bytes)
   let path=root.appendingPathComponent(AggregateResources.renderDirectory+"/"+PublishedAggregateReader.sha(Data(descriptor.id.utf8))+"/"+descriptor.source.manifestSHA256+"/"+source.rawHTMLSHA256+"/"+AggregateResources.contract+"/"+sha+".json")
   try bytes.write(to:path);defer{try?fm.removeItem(at:path)}
   do{_=try store.cachedResourceRendering(source:source,manifestSHA256:sha);return "accepted"}catch{return String(describing:error)}
  }
  try check(try declaredLengthError(1).contains("汇总缓存大小或文件类型无效"),"understated first asset is rejected before allocation or touching later absent asset")
  try check(try declaredLengthError(png.count+1).contains("图片字节长度与清单不一致"),"overstated first asset is immediately length-checked before later absent asset")
  let imagePath=root.appendingPathComponent("aggregate-image-bytes-v1/"+hash),saved=root.appendingPathComponent("saved-image")
  try fm.moveItem(at:imagePath,to:saved);try fm.createSymbolicLink(at:imagePath,withDestinationURL:saved)
  try check(rejects{_=try store.cachedResourceRendering(source:source,manifestSHA256:full.manifestSHA256)},"asset symlink is rejected even with matching referred bytes")
  try fm.removeItem(at:imagePath);try fm.moveItem(at:saved,to:imagePath);try Data("BROKEN".utf8).write(to:imagePath)
  try check(rejects{_=try store.cachedResourceRendering(source:source,manifestSHA256:full.manifestSHA256)},"corrupt image bytes reject complete rendering instead of silent omission")
  try fm.removeItem(at:imagePath);try png.write(to:imagePath)
  let manifestPath=root.appendingPathComponent(AggregateResources.renderDirectory+"/"+PublishedAggregateReader.sha(Data(descriptor.id.utf8))+"/"+descriptor.source.manifestSHA256+"/"+source.rawHTMLSHA256+"/"+AggregateResources.contract+"/"+full.manifestSHA256+".json")
  let originalManifestBytes=try Data(contentsOf:manifestPath);var damaged=originalManifestBytes;damaged[damaged.count-2] ^= 1;try damaged.write(to:manifestPath)
  try check(rejects{_=try store.cachedResourceRendering(source:source,manifestSHA256:full.manifestSHA256)},"changed resource manifest is rejected by whole-byte SHA")
  try check(rejects{_=try store.latestResourceRendering(source:source)},"corrupt peer prevents selecting another intact resource rendering")
  try originalManifestBytes.write(to:manifestPath)
  try check(try store.latestResourceRendering(source:source)?.manifestSHA256==partial.manifestSHA256,"all valid same-HTML resource observations select actual latest timestamp")
  try Data("{}".utf8).write(to:root.appendingPathComponent("personal.json"))
  let payload=try BackupCodec.collect(sourceDirectory:root),encoded=try BackupCodec.encode(payload)
  let parent=fm.temporaryDirectory.appendingPathComponent("aggregate-resource-restore45-"+UUID().uuidString);try fm.createDirectory(at:parent,withIntermediateDirectories:true);defer{try?fm.removeItem(at:parent)}
  let staged=try BackupCodec.stage(data:encoded,parentDirectory:parent),restored=PublishedAggregateStore(directory:staged.stageDirectory)
  try check(try restored.cachedResourceRendering(source:source,manifestSHA256:full.manifestSHA256).bodyHTML==full.bodyHTML,"normal whole-backup encode/stage restores original source and source-bound image bytes")
  try check(rejects{_=try store.cacheResourceRendering(source:source,plan:plan,images:[:],missing:[:],observedAt:"invalid")},"resource observation time is validated")
  try check(try AggregateForeignFixtures.nativeRawImport(),"foreign Android raw is natively rederived without rewriting foreign sidecar or observation")
  try check(try AggregateForeignFixtures.badForeignBody(),"foreign damaged body witness fails before native publication")
  try check(try AggregateForeignFixtures.badForeignDescriptor(),"foreign descriptor cannot borrow another original manifest row")
  try check(try AggregateForeignFixtures.foreignImageSourceMismatch(),"foreign image slot mismatch cannot grant a native image rendering")
  print("RESULT passed=\(passed) failed=0; controlled graphics, no real image network claims")
 }
}


private enum AggregateForeignFixtures {
 struct Fixture {
  let root:URL,store:PublishedAggregateStore,descriptor:PublishedAggregate,raw:String,folder:URL
 }
 static func require(_ value:Bool)throws{if !value{throw AggregateFailure.invalid("TEST foreign fixture assertion")}}
 static func make()throws->Fixture {
  let fm=FileManager.default,root=fm.temporaryDirectory.appendingPathComponent("aggregate-foreign51-"+UUID().uuidString)
  try fm.createDirectory(at:root.appendingPathComponent("index"),withIntermediateDirectories:true)
  let shard=try JSONSerialization.data(withJSONObject:[["pageType":"daily","permalink":"/audio-paper-digest-blog/foreign51/","title":"Controlled foreign source","date":"2026-10-24"]],options:.sortedKeys),sha=PublishedAggregateReader.sha(shard)
  let manifest=try JSONSerialization.data(withJSONObject:["contract":"paper-search-index-manifest-v1","recordCount":1,"totalBytes":shard.count,"shards":[["url":"search-index/part-0001-"+sha.prefix(12)+".json","sha256":sha,"bytes":shard.count,"recordCount":1]]],options:.sortedKeys)
  try shard.write(to:root.appendingPathComponent("index/"+sha+".json"));let store=PublishedAggregateStore(directory:root),descriptor=try store.stage(manifest:manifest,validationEpoch:UUID().uuidString).records[0]
  let bytes=Data("<html><body><div id='article-body' class='post-content'><p>Before</p><figure><img src='https://arxiv.org/html/2501.00001v1/a.png' alt='Slot'/><figcaption>Original caption</figcaption></figure><p>After</p></div></body></html>".utf8)
  let native=try LibraryService.extractAggregateHTML(bytes,descriptor:descriptor,responseURL:URL(string:descriptor.sourceURL)!,fetchedAt:"2026-10-24T00:00:00Z")
  var foreign=try JSONSerialization.jsonObject(with:JSONEncoder().encode(native)) as! [String:Any]
  let body="<p>Before</p><figure><img alt=\"Slot\"><figcaption>Original caption</figcaption></figure><p>After</p>"
  foreign["parserContract"]="published-aggregate-jsoup-v1";foreign["bodyHTML"]=body;foreign["sanitizedBodySHA256"]=PublishedAggregateReader.sha(Data(body.utf8))
  let folder=root.appendingPathComponent("aggregate-documents-android/"+PublishedAggregateReader.sha(Data(descriptor.id.utf8))+"/"+descriptor.source.manifestSHA256+"/"+native.rawHTMLSHA256)
  try fm.createDirectory(at:folder,withIntermediateDirectories:true);try bytes.write(to:folder.appendingPathComponent("original.html"));try Data(body.utf8).write(to:folder.appendingPathComponent("body.html"));try JSONSerialization.data(withJSONObject:foreign,options:.sortedKeys).write(to:folder.appendingPathComponent("document.json"))
  return .init(root:root,store:store,descriptor:descriptor,raw:native.rawHTMLSHA256,folder:folder)
 }
 static func nativeRawImport()throws->Bool {
  let f=try make();defer{try?FileManager.default.removeItem(at:f.root)}
  let original=try Data(contentsOf:f.folder.appendingPathComponent("document.json"));guard let native=try f.store.latestVerifiedDocument(for:f.descriptor)else{return false}
  let again=try f.store.cachedDocument(descriptor:f.descriptor,rawHTMLSHA256:f.raw)
  let unchanged=try Data(contentsOf:f.folder.appendingPathComponent("document.json"))==original
  return native==again&&native.parserContract=="published-aggregate-html-v1"&&native.fetchedAt=="2026-10-24T00:00:00Z"&&native.bodyHTML.contains("Original caption")&&native.rawHTMLSHA256==f.raw&&unchanged
 }
 static func badForeignBody()throws->Bool {
  let f=try make();defer{try?FileManager.default.removeItem(at:f.root)};try Data("bad".utf8).write(to:f.folder.appendingPathComponent("body.html"))
  do{_=try f.store.latestVerifiedDocument(for:f.descriptor);return false}catch{return String(describing:error).contains("Android原网页派生见证未通过核验") && !FileManager.default.fileExists(atPath:f.root.appendingPathComponent("aggregate-documents").path)}
 }
 static func badForeignDescriptor()throws->Bool {
  let f=try make();defer{try?FileManager.default.removeItem(at:f.root)};let path=f.folder.appendingPathComponent("document.json");var row=try JSONSerialization.jsonObject(with:Data(contentsOf:path)) as! [String:Any];var descriptor=row["descriptor"] as! [String:Any];descriptor["title"]="Other title";row["descriptor"]=descriptor;try JSONSerialization.data(withJSONObject:row).write(to:path)
  do{_=try f.store.cachedDocument(descriptor:f.descriptor,rawHTMLSHA256:f.raw);return false}catch{return String(describing:error).contains("Android原网页来源或格式不受支持") && !FileManager.default.fileExists(atPath:f.root.appendingPathComponent("aggregate-documents").path)}
 }
 static func foreignImageSourceMismatch()throws->Bool {
  let f=try make();defer{try?FileManager.default.removeItem(at:f.root)};let native=try f.store.cachedDocument(descriptor:f.descriptor,rawHTMLSHA256:f.raw),plan=try f.store.imagePlan(native)
  let foreign=try JSONSerialization.jsonObject(with:Data(contentsOf:f.folder.appendingPathComponent("document.json"))) as! [String:Any]
  var foreignPlan=try JSONSerialization.jsonObject(with:JSONEncoder().encode(plan)) as! [String:Any]
  foreignPlan["originalBodySHA256"]=foreign["sanitizedBodySHA256"];var slots=foreignPlan["slots"] as! [[String:Any]];slots[0]["sourceURL"]="https://arxiv.org/html/2501.00001v1/other.png";foreignPlan["slots"]=slots
  let record:[String:Any]=["slot":slots[0],"missingReason":"controlled missing"]
  let witness:[String:Any]=["contract":AggregateResources.contract,"parserContract":"published-aggregate-jsoup-images-v1","plan":foreignPlan,"images":[record],"observedAt":"2026-10-24T00:00:00Z","renderedBodySHA256":String(repeating:"a",count:64),"completeOffline":false]
  let bytes=try JSONSerialization.data(withJSONObject:witness,options:.sortedKeys),sha=PublishedAggregateReader.sha(bytes)
  let folder=f.root.appendingPathComponent("aggregate-resource-renders-android-v1/"+PublishedAggregateReader.sha(Data(f.descriptor.id.utf8))+"/"+f.descriptor.source.manifestSHA256+"/"+f.raw+"/"+AggregateResources.contract)
  try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true);try bytes.write(to:folder.appendingPathComponent(sha+".json"))
  do{_=try f.store.importAndroidResourceRendering(native);return false}catch{return String(describing:error).contains("两端图片位置或图注不同") && !FileManager.default.fileExists(atPath:f.root.appendingPathComponent(AggregateResources.renderDirectory).path)}
 }
}
