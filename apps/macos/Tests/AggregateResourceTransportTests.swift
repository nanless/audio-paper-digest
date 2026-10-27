import Foundation
import Darwin
private actor ImageTransportFixture {
 let manifest:Data,shard:Data,shardPath:String,image:Data
 var html:String,failHTML=false,blockImages=false,imageStarted=false,addresses:[String]=[],overrides:[String:Data]=[:],imageLimits:[Int]=[]
 init()throws{
  let paper:[String:Any]=["pageType":"paper","permalink":"/audio-paper-digest-blog/ci-paper/","title":"Controlled source paper","date":"2026-10-24","sourceKind":"arxiv","identityStatus":"verified","arxivId":"2501.00001","citation":["identityStatus":"verified","sourceKind":"arxiv","arxivId":"2501.00001v1","sourceUrl":"https://arxiv.org/abs/2501.00001v1","pdfUrl":"https://arxiv.org/pdf/2501.00001v1.pdf"]]
  shard=try JSONSerialization.data(withJSONObject:[paper,["pageType":"daily","permalink":"/audio-paper-digest-blog/ci-images/","title":"Controlled normal transport","date":"2026-10-24"]],options:.sortedKeys)
  let sha=PublishedAggregateReader.sha(shard);shardPath="search-index/part-0001-"+sha.prefix(12)+".json"
  manifest=try JSONSerialization.data(withJSONObject:["contract":"paper-search-index-manifest-v1","recordCount":2,"totalBytes":shard.count,"shards":[["url":shardPath,"sha256":sha,"bytes":shard.count,"recordCount":2]]],options:.sortedKeys)
  image=Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlYQAAAAASUVORK5CYII=")!
  html=Self.page("<figure><img src='https://arxiv.org/html/2610.30682/x1.png' alt='A'/><figcaption>Caption A</figcaption></figure><figure><img src='https://arxiv.org/html/2610.30682/x1.png' alt='B'/><figcaption>Caption B</figcaption></figure>")
 }
 static func page(_ body:String)->String{"<html><head><link rel='canonical' href='https://nanless.github.io/audio-paper-digest-blog/ci-images/'/></head><body><div id='article-body' class='post-content'><p>Controlled normal transport body.</p>"+body+"</div></body></html>"}
 func data(_ url:URL,_ limit:Int) async throws->Data {
  addresses.append(url.absoluteString)
  if url.path.hasSuffix("/index.json"){return manifest}
  if url.path.hasSuffix(shardPath){return shard}
  if url.host=="arxiv.org"{imageStarted=true;imageLimits.append(limit);if blockImages{try await Task.sleep(nanoseconds:30_000_000_000)};return overrides[url.absoluteString] ?? image}
  if (url.path.hasSuffix("/ci-images/")||url.path.hasSuffix("/ci-images")){if failHTML{throw URLError(.notConnectedToInternet)};return Data(html.utf8)}
  throw AggregateFailure.invalid("Unexpected controlled transport URL")
 }
 func setOffline(_ value:Bool){failHTML=value}
 func change(_ body:String,block:Bool=false){html=Self.page(body);failHTML=false;blockImages=block;imageStarted=false}
 func override(_ path:String,_ bytes:Data){overrides["https://arxiv.org/html/2610.30682/"+path]=bytes}
 func limits()->[Int]{imageLimits}
 func imageBytes()->Data{image}
 func countImages()->Int{addresses.filter{$0.hasPrefix("https://arxiv.org/")}.count}
 func sawForbidden()->Bool{addresses.contains{$0.contains("127.0.0.1")||$0.contains("unapproved.invalid")}}
 func started()->Bool{imageStarted}
}
@main struct AggregateResourceTransportTests {
 static var passed=0
 static func check(_ value:Bool,_ message:String)throws{guard value else{throw AggregateFailure.invalid("TEST "+message)};passed+=1;print("PASS "+message)}
 static func main()async throws {
  setbuf(stdout,nil)
  let fm=FileManager.default,root=fm.temporaryDirectory.appendingPathComponent("aggregate-resource-transport45-"+UUID().uuidString);defer{try?fm.removeItem(at:root)}
  let fixture=try ImageTransportFixture(),library=try LibraryService(dataDirectory:root,seedDirectory:root.appendingPathComponent("NoSeed"),transport:{url,limit in try await fixture.data(url,limit)})
  let summary=try await library.sync();try check(summary.paperCount==1&&summary.recordCount==2,"normal catalog precondition includes one genuine typed paper fixture and one aggregate");let catalog=try await library.aggregateCatalog()!,access=try await library.aggregateReadAccess(id:catalog.records[0].id)
  let first=try await library.aggregatePresentation(access),bridge=try first.bridgeValue()
  try check(first.displayHTML.components(separatedBy:"data:image/png;base64,").count==3&&first.displayHTML.contains("<figcaption>Caption A")&&bridge["resourceManifestSHA256"] is String,"normal native presentation fetches typed images and preserves actual figure/caption positions")
  try check(await fixture.countImages()==1,"duplicate image URL is fetched once for two distinct original slots")
  _=try await library.aggregatePresentation(access)
  try check(await fixture.countImages()==1,"reopening identical HTML reuses cold-verified independent image revision")
  await fixture.setOffline(true);let offline=try await library.aggregatePresentation(access)
  try check(offline.isStale&&offline.displayHTML==first.displayHTML&&offline.imageRender?.manifestSHA256==first.imageRender?.manifestSHA256,"network-failed body fallback replays same original HTML and same image revision without refetch")
  try check(await fixture.countImages()==1,"offline fallback performs no new image requests")
  await fixture.change("<img src='https://127.0.0.1/private.png' alt='No private request'/><img src='https://unapproved.invalid/image.png' alt='No unknown host'/><img src='https://arxiv.org/html/2610.30682/x1.png' alt='Valid'/>")
  let guarded=try await library.aggregatePresentation(access)
  try check(!(await fixture.sawForbidden())&&guarded.imageRender?.manifest.images.filter{$0.sha256 != nil}.count==1,"source-bound private/unsupported URL is rejected before transport; a supported image still reads")
  await fixture.override("unsafe.svg",Data("<svg><script>unsafe()</script></svg>".utf8))
  await fixture.change("<p>Type boundary</p><img src='https://arxiv.org/html/2610.30682/unsafe.svg' alt='Unsupported executable SVG'/><img src='https://arxiv.org/html/2610.30682/x1.png' alt='Supported PNG'/>")
  let typed=try await library.aggregatePresentation(access)
  try check(typed.imageRender?.manifest.images[0].sha256==nil&&typed.imageRender?.manifest.images[1].mime=="image/png","byte-derived MIME refuses executable SVG and retains explicit missing slot")
  var padded=await fixture.imageBytes();padded.append(Data(repeating:0,count:AggregateResources.maxImageBytes-padded.count))
  await fixture.override("oversized.png",padded+Data([0]))
  let beforeOversize=await fixture.countImages()
  await fixture.change("<p>Per-image limit</p><img src='https://arxiv.org/html/2610.30682/oversized.png'/><img src='https://arxiv.org/html/2610.30682/after-overflow.png'/>")
  let perImageSource=try await library.aggregateDocument(id:catalog.records[0].id),perImage=try await library.aggregateResourceRendering(perImageSource)
  let afterOversize=await fixture.countImages()
  try check(perImage.manifest.images.allSatisfy{$0.sha256==nil} && afterOversize==beforeOversize+1,"response beyond16MiB is not cached and conservative exhausted budget prevents subsequent requests")
  for i in 0..<5{await fixture.override("budget-\(i).png",padded)}
  let beforeTotal=await fixture.countImages()
  await fixture.change("<p>Total limit</p>"+(0..<5).map{"<img src='https://arxiv.org/html/2610.30682/budget-\($0).png'/>"}.joined())
  let totalSource=try await library.aggregateDocument(id:catalog.records[0].id),total=try await library.aggregateResourceRendering(totalSource)
  let afterTotal=await fixture.countImages()
  try check(total.manifest.images.filter{$0.sha256 != nil}.count==4&&total.manifest.images.last?.missingReason != nil && afterTotal==beforeTotal+4,"64MiB page transfer budget admits four bounded images and stops before fifth request")
  try check(await fixture.limits().allSatisfy{$0>0&&$0<=AggregateResources.maxImageBytes},"every normal image request receives a positive bounded remaining-byte limit")
  await fixture.change("<p>Cancellation scope</p><img src='https://arxiv.org/html/2610.30682/x1.png' alt='Cancellation'/>",block:true)
  let task=Task{try await library.aggregatePresentation(access)}
  for _ in 0..<200{if await fixture.started(){break};try await Task.sleep(nanoseconds:5_000_000)}
  try check(await fixture.started(),"cancellation probe reached actual injected normal image transport")
  task.cancel();var cancelled=false;do{_=try await task.value}catch is CancellationError{cancelled=true}
  try check(cancelled,"cancellation drains image await and does not return a success document")
  let source=try await library.aggregateCachedDocument(id:catalog.records[0].id,rawHTMLSHA256:PublishedAggregateReader.sha(Data(ImageTransportFixture.page("<p>Cancellation scope</p><img src='https://arxiv.org/html/2610.30682/x1.png' alt='Cancellation'/>").utf8)))
  let store=PublishedAggregateStore(directory:root.appendingPathComponent("PublishedLibrary"))
  try check(try store.latestResourceRendering(source:source)==nil,"cancelled image transfer publishes no false complete or partial resource revision")
  print("RESULT passed=\(passed) failed=0; injected normal transport only, no network/provider/model/credentials")
 }
}
