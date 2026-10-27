import Foundation
import CoreGraphics
import ImageIO
import Darwin
private actor RepeatTransport {
 let manifest:Data,shard:Data,image:Data,shardName:String
 var requests=0
 init(image:Data)throws{
  self.image=image
  let paper:[String:Any]=["pageType":"paper","permalink":"/audio-paper-digest-blog/repeat-paper/","title":"Controlled paper","date":"2026-10-24","sourceKind":"arxiv","identityStatus":"verified","arxivId":"2501.00001","citation":["identityStatus":"verified","sourceKind":"arxiv","arxivId":"2501.00001v1","sourceUrl":"https://arxiv.org/abs/2501.00001v1","pdfUrl":"https://arxiv.org/pdf/2501.00001v1.pdf"]]
  shard=try JSONSerialization.data(withJSONObject:[paper,["pageType":"daily","permalink":"/audio-paper-digest-blog/repeat-images/","title":"Repeated large image","date":"2026-10-24"]],options:.sortedKeys)
  let sha=PublishedAggregateReader.sha(shard);shardName="search-index/part-0001-"+sha.prefix(12)+".json"
  manifest=try JSONSerialization.data(withJSONObject:["contract":"paper-search-index-manifest-v1","recordCount":2,"totalBytes":shard.count,"shards":[["url":shardName,"sha256":sha,"bytes":shard.count,"recordCount":2]]],options:.sortedKeys)
 }
 func read(_ url:URL,_ limit:Int)throws->Data {
  if url.path.hasSuffix("/index.json"){return manifest};if url.path.hasSuffix(shardName){return shard}
  if url.host=="arxiv.org"{requests+=1;return image}
  return Data(("<html><body><div id='article-body' class='post-content'><p>Five actual positions</p>"+Array(repeating:"<figure><img src='https://arxiv.org/html/2501.00001v1/shared.png' alt='Repeated actual image'/><figcaption>Same original image at a separate position.</figcaption></figure>",count:5).joined()+"</div></body></html>").utf8)
 }
 func count()->Int{requests}
}
@main struct AggregateResourceBudgetTests {
 static let table:[UInt32]=(0..<256).map{value in var c=UInt32(value);for _ in 0..<8{c=(c&1)==1 ? 0xedb88320^(c>>1):c>>1};return c}
 static func crc(_ bytes:Data)->UInt32 {var c:UInt32=0xffffffff;for b in bytes{c=table[Int((c^UInt32(b))&255)]^(c>>8)};return c^0xffffffff}
 static func integer(_ value:UInt32)->Data{var v=value.bigEndian;return withUnsafeBytes(of:&v){Data($0)}}
 static func validPaddedPNG()throws->Data {
  let color=CGColorSpaceCreateDeviceRGB(),ctx=CGContext(data:nil,width:1,height:1,bitsPerComponent:8,bytesPerRow:4,space:color,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(CGColor(red:0.2,green:0.4,blue:0.6,alpha:1));ctx.fill(CGRect(x:0,y:0,width:1,height:1))
  let result=NSMutableData(),dest=CGImageDestinationCreateWithData(result,"public.png" as CFString,1,nil)!;CGImageDestinationAddImage(dest,ctx.makeImage()!,nil);guard CGImageDestinationFinalize(dest) else{throw AggregateFailure.invalid("PNG fixture failed")}
  let small=result as Data;let amount=16*1024*1024-small.count-12;var chunk=Data("paDd".utf8);chunk.append(Data(repeating:0,count:amount));var large=Data(small.dropLast(12));large.append(integer(UInt32(amount)));large.append(chunk);large.append(integer(crc(chunk)));large.append(small.suffix(12))
  guard large.count==16*1024*1024,let image=CGImageSourceCreateWithData(large as CFData,nil),let decoded=CGImageSourceCreateImageAtIndex(image,0,nil),decoded.width==1,decoded.height==1 else{throw AggregateFailure.invalid("Padded PNG does not decode")};return large
 }
 static func main()async throws {
  setbuf(stdout,nil);let fm=FileManager.default,temporary=CommandLine.arguments.count<2
  let out=temporary ? fm.temporaryDirectory.appendingPathComponent("aggregate-reference-budget-"+UUID().uuidString):URL(fileURLWithPath:CommandLine.arguments[1]),root=out.appendingPathComponent("Research")
  defer{if temporary{try? fm.removeItem(at:out)}}
  try fm.createDirectory(at:root,withIntermediateDirectories:true)
  let bytes=try validPaddedPNG(),fixture=try RepeatTransport(image:bytes),library=try LibraryService(dataDirectory:root,seedDirectory:out.appendingPathComponent("NoSeed"),transport:{url,limit in try await fixture.read(url,limit)})
  _=try await library.sync();let id="page:/audio-paper-digest-blog/repeat-images/",source=try await library.aggregateDocument(id:id),store=PublishedAggregateStore(directory:root.appendingPathComponent("PublishedLibrary"))
  var render:AggregateResourceRender?=try await library.aggregateResourceRendering(source)
  let sha=render!.manifestSHA256,records=render!.manifest.images,embedded=records.compactMap{$0.bytes}.reduce(0,+),bodyBytes=render!.bodyHTML.utf8.count,success=records.filter{$0.sha256 != nil}.count,missing=records.filter{$0.missingReason != nil}.count
  let normalBounded=embedded<=64*1024*1024&&success==4&&missing==1;render=nil
  // First v1 observation remains for a cold replay under revised code. No fields are changed or re-signed.
  try JSONSerialization.data(withJSONObject:["descriptor":try JSONSerialization.jsonObject(with:JSONEncoder().encode(source.descriptor)),"rawHTMLSHA256":source.rawHTMLSHA256,"resourceManifestSHA256":sha],options:[.sortedKeys,.prettyPrinted]).write(to:out.appendingPathComponent("observation.json"))
  var coldRejected=false;do{_=try store.cachedResourceRendering(source:source,manifestSHA256:sha)}catch{coldRejected=true}
  // A revised normal partial manifest must stay readable; the legacy all-five manifest must be rejected.
  let coldExpected=normalBounded ? !coldRejected:coldRejected
  let plan=try store.imagePlan(source),asset=AggregateImageBytes(data:bytes,mime:"image/png")
  var directRejected=false
  do{_=try store.cacheResourceRendering(source:source,plan:plan,images:Dictionary(uniqueKeysWithValues:plan.slots.map{($0.index,asset)}),missing:[:],observedAt:"2026-10-27T00:00:01Z")}catch{directRejected=String(describing:error).contains("页面图片引用累计超过64 MiB")}
  // Optional independent replay of the original v1 RED without modifying or re-signing its files.
  var legacyRejected:Bool?=nil
  if CommandLine.arguments.count>2 {
   let legacy=URL(fileURLWithPath:CommandLine.arguments[2]),observation=try JSONSerialization.jsonObject(with:Data(contentsOf:legacy.appendingPathComponent("observation.json"))) as! [String:Any]
   let descriptor=try JSONDecoder().decode(PublishedAggregate.self,from:JSONSerialization.data(withJSONObject:observation["descriptor"]!)),oldStore=PublishedAggregateStore(directory:legacy.appendingPathComponent("Research/PublishedLibrary"))
   let oldSource=try oldStore.cachedDocument(descriptor:descriptor,rawHTMLSHA256:observation["rawHTMLSHA256"] as! String)
   do{_=try oldStore.cachedResourceRendering(source:oldSource,manifestSHA256:observation["resourceManifestSHA256"] as! String);legacyRejected=false}catch{legacyRejected=String(describing:error).contains("页面图片引用累计超过64 MiB")}
  }
  let requestCount=await fixture.count()
  let allPassed=normalBounded&&coldExpected&&directRejected&&(legacyRejected ?? true)&&requestCount==1
  var result:[String:Any]=["validPNGDecoded1x1":true,"PNGBytes":bytes.count,"sameSourceSlots":5,"normalRequests":await fixture.count(),"normalSavedSlots":success,"normalMissingSlots":missing,"normalEmbeddedRawBytes":embedded,"normalBodyUTF8Bytes":bodyBytes,"normalPerReferenceBudgetPassed":normalBounded,"coldRejected":coldRejected,"coldBudgetGatePassed":coldExpected,"allPassed":allPassed,"directAllFiveCacheRejected":directRejected]
  if let legacyRejected{result["originalV1ColdObservationRejected"]=legacyRejected}
  try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys,.prettyPrinted]).write(to:out.appendingPathComponent("result.json"));print(String(decoding:try JSONSerialization.data(withJSONObject:result,options:.sortedKeys),as:UTF8.self));if !allPassed{exit(1)}
 }
}
