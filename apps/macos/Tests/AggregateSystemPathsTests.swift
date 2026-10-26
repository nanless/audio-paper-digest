import Foundation
import Darwin
@main struct AggregateSystemPathsTests {
 static var count=0
 static func check(_ value:Bool,_ label:String)throws{guard value else{throw AggregateFailure.invalid("TEST "+label)};count+=1;print("PASS "+label)}
 static func rejects(_ body:()throws->Void)->Bool{do{try body();return false}catch{return true}}
 static func fixture(_ prefix:String)throws->(Data,Data,String){let rows=["daily","conference","page"].map{["pageType":$0,"permalink":prefix+"ci-"+$0+"/","title":"Controlled "+$0,"date":"2026-10-24"]};let shard=try JSONSerialization.data(withJSONObject:rows,options:.sortedKeys),hash=PublishedAggregateReader.sha(shard);let manifest=try JSONSerialization.data(withJSONObject:["contract":"paper-search-index-manifest-v1","recordCount":3,"totalBytes":shard.count,"shards":[["url":"search-index/part-0001-"+hash.prefix(12)+".json","sha256":hash,"bytes":shard.count,"recordCount":3]]],options:.sortedKeys);return(manifest,shard,hash)}
 static func main()throws{
  let fm=FileManager.default;print("FOUNDATION_TMP "+fm.temporaryDirectory.path)
  let (manifest,shard,hash)=try fixture("/audio-paper-digest-blog/")
  for prefix in [fm.temporaryDirectory.path,"/tmp"]{
   let dir=URL(fileURLWithPath:prefix,isDirectory:true).appendingPathComponent("alias44-"+UUID().uuidString);try fm.createDirectory(at:dir.appendingPathComponent("index"),withIntermediateDirectories:true);defer{try?fm.removeItem(at:dir)};try shard.write(to:dir.appendingPathComponent("index/"+hash+".json"));let epoch=UUID().uuidString,store=PublishedAggregateStore(directory:dir);let catalog=try store.stage(manifest:manifest,validationEpoch:epoch)
   try check(catalog.records.count==3,"system alias root "+prefix+" stages real descriptors")
   let raw=realpath(dir.path,nil)!;defer{free(raw)};let physical=PublishedAggregateStore(directory:URL(fileURLWithPath:String(cString:raw)))
   try check(try physical.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:epoch)==catalog,"physical and system alias retain exact same catalog identity")
   let baseLink=dir.appendingPathComponent("base-link");try fm.createSymbolicLink(at:baseLink,withDestinationURL:dir);try check(rejects{_=try PublishedAggregateStore(directory:baseLink).stage(manifest:manifest,validationEpoch:UUID().uuidString)},"arbitrary cache-base symlink still rejected");try fm.removeItem(at:baseLink)
   let index=dir.appendingPathComponent("index"),saved=dir.appendingPathComponent("real-index");try fm.moveItem(at:index,to:saved);try fm.createSymbolicLink(at:index,withDestinationURL:saved);try check(rejects{_=try store.stage(manifest:manifest,validationEpoch:UUID().uuidString)},"internal index directory symlink still rejected");try fm.removeItem(at:index);try fm.moveItem(at:saved,to:index)
   let leaf=index.appendingPathComponent(hash+".json"),backup=dir.appendingPathComponent("saved-shard.json");try fm.moveItem(at:leaf,to:backup);try fm.createSymbolicLink(at:leaf,withDestinationURL:backup);try check(rejects{_=try store.stage(manifest:manifest,validationEpoch:UUID().uuidString)},"internal shard file symlink still rejected");try fm.removeItem(at:leaf);try fm.moveItem(at:backup,to:leaf)
  }
  let root=fm.temporaryDirectory.appendingPathComponent("alias44-custom-"+UUID().uuidString);defer{try?fm.removeItem(at:root)};let (customManifest,customShard,customHash)=try fixture("/blog/");try fm.createDirectory(at:root.appendingPathComponent("index"),withIntermediateDirectories:true);try customShard.write(to:root.appendingPathComponent("index/"+customHash+".json"));let base=URL(string:"https://fixture.invalid/blog/")!,store=PublishedAggregateStore(directory:root,siteBase:base);let catalog=try store.stage(manifest:customManifest,validationEpoch:UUID().uuidString),descriptor=catalog.records.first{$0.kind == .daily}!
  let html=Data("<html><head><link rel='canonical' href='https://fixture.invalid/blog/ci-daily/'></head><body><div id='article-body' class='post-content'><p>Controlled body</p></div></body></html>".utf8);let doc=try store.cacheDocument(html,descriptor:descriptor,responseURL:URL(string:descriptor.sourceURL)!,fetchedAt:"2026-10-24T00:00:00Z")
  try check(try store.cachedDocument(descriptor:descriptor,rawHTMLSHA256:doc.rawHTMLSHA256)==doc,"configured native HTTPS base binds stage, HTML canonical and cold replay")
  try check(rejects{_=try PublishedAggregateStore(directory:root,siteBase:URL(string:"https://foreign.invalid/blog/")!).originalRow(for:descriptor)},"other base cannot borrow original descriptor")
  let bad=Data(String(decoding:html,as:UTF8.self).replacingOccurrences(of:"href='https://fixture.invalid/",with:"href='https://foreign.invalid/").utf8)
  try check(rejects{_=try store.cacheDocument(bad,descriptor:descriptor,responseURL:URL(string:descriptor.sourceURL)!,fetchedAt:"2026-10-24T00:00:00Z")},"wrong-host canonical remains rejected")
  print("RESULT passed=\(count) failed=0")
 }
}
