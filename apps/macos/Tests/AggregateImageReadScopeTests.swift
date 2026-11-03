import Foundation
import Darwin

private actor PublicFixtureTransport {
    let files:[String:Data]
    var requests=0
    init(_ files:[String:Data]){self.files=files}
    func read(_ url:URL,_ limit:Int)throws->Data {
        requests += 1
        if url.path.contains("/client/"){throw LibraryService.ServiceError.httpStatus(404)}
        guard let bytes=files[url.absoluteString],bytes.count<=limit else{throw URLError(.fileDoesNotExist)}
        return bytes
    }
}

@main struct AggregateImageReadScopeTests {
    static var checks=0
    static func expect(_ value:Bool,_ reason:String)throws {
        guard value else{throw AggregateFailure.invalid("TEST: "+reason)}
        checks += 1;print("PASS "+reason)
    }
    static func rejects<T>(_ body:()throws->T)->Bool{do{_=try body();return false}catch{return true}}
    static func main()async throws {
        setbuf(stdout,nil)
        let fm=FileManager.default,physical=realpath(fm.temporaryDirectory.path,nil)!
        defer{free(physical)}
        let dataRoot=URL(fileURLWithPath:String(cString:physical)).appendingPathComponent("aggregate-image-read-scope-"+UUID().uuidString)
        let root=dataRoot.appendingPathComponent("PublishedLibrary")
        try fm.createDirectory(at:root.appendingPathComponent("index"),withIntermediateDirectories:true)
        defer{try?fm.removeItem(at:dataRoot)}
        let base="https://nanless.github.io/audio-paper-digest-blog/",prefix="/audio-paper-digest-blog/"
        var rows:[[String:Any]]=[["pageType":"daily","permalink":prefix+"image-scope/","title":"受控大图文热读","date":"2026-11-01"]]
        rows += (0..<9_000).map{["pageType":"paper","permalink":prefix+"papers/image-scope-\($0)/","title":"受控元数据 \($0)"]}
        var shards:[[String:Any]]=[],files:[String:Data]=[:],total=0
        for start in stride(from:0,to:rows.count,by:500) {
            let entries=Array(rows[start..<min(start+500,rows.count)]),bytes=try JSONSerialization.data(withJSONObject:entries,options:.sortedKeys),sha=PublishedAggregateReader.sha(bytes)
            let path="search-index/part-"+String(format:"%04d",shards.count+1)+"-"+sha.prefix(12)+".json"
            try bytes.write(to:root.appendingPathComponent("index/"+sha+".json"))
            files[base+path]=bytes;total += bytes.count
            shards.append(["url":path,"bytes":bytes.count,"sha256":sha,"recordCount":entries.count])
        }
        let manifest=try JSONSerialization.data(withJSONObject:["contract":"paper-search-index-manifest-v1","recordCount":rows.count,"totalBytes":total,"shards":shards],options:.sortedKeys)
        files[base+"index.json"]=manifest
        let store=PublishedAggregateStore(directory:root),epoch=UUID().uuidString
        let catalog=try store.stage(manifest:manifest,validationEpoch:epoch),descriptor=catalog.records[0]
        let paragraph="<p>这是用于检验来源重读与完整排版的大图文受控段落。没有论文事实，也不调用网络或模型。012345678901234567890123456789</p>"
        let figure=(0..<3).map{"<figure><img src='"+base+"images/scope-\($0).png' alt='受控一像素图'/><figcaption>受控位置 \($0)，不是论文配图。</figcaption></figure>"}.joined()
        let html=Data(("<html><body><div id='article-body' class='post-content'><h2>大图文热读</h2>"+String(repeating:paragraph,count:4_000)+figure+"</div></body></html>").utf8)
        let source=try store.withVerifiedReadScope{try $0.cacheDocument(html,descriptor:descriptor,responseURL:URL(string:descriptor.sourceURL)!,fetchedAt:"2026-11-01T00:00:00Z")}
        let image=Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlYQAAAAASUVORK5CYII=")!
        let asset=AggregateImageBytes(data:image,mime:"image/png")

        let absentMetrics=AggregateReadMetrics(),absent=PublishedAggregateStore(directory:root,metrics:absentMetrics)
        try expect(try absent.latestResourceRendering(source:source)==nil && absent.importAndroidResourceRendering(source)==nil,"missing native/foreign image folders return no rendering")
        try expect(absentMetrics.sourceParses==0 && absentMetrics.fileReads==0,"a missing image cache performs no full catalog/HTML image-plan replay")

        var firstSHA=""
        try store.withVerifiedReadScope { scoped in
            let plan=try scoped.imagePlan(source)
            try expect(plan.slots.count==3,"large sealed HTML retains all three genuine image slots")
            for revision in 0..<6 {
                let value=try scoped.cacheResourceRendering(source:source,plan:plan,images:[0:asset,1:asset,2:asset],missing:[:],observedAt:String(format:"2026-11-01T00:01:%02dZ",revision))
                if revision==0{firstSHA=value.manifestSHA256}
            }
        }
        let baselineMetrics=AggregateReadMetrics(),baseline=PublishedAggregateStore(directory:root,metrics:baselineMetrics)
        let before=Date(),normal=try baseline.latestResourceRendering(source:source)!,baselineSeconds=Date().timeIntervalSince(before)
        let optimizedMetrics=AggregateReadMetrics(),optimized=PublishedAggregateStore(directory:root,metrics:optimizedMetrics)
        let started=Date(),scoped=try optimized.withVerifiedReadScope{try $0.latestResourceRendering(source:source)!},scopedSeconds=Date().timeIntervalSince(started)
        try expect(scoped.manifest==normal.manifest && scoped.bodyHTML==normal.bodyHTML && scoped.manifestSHA256==normal.manifestSHA256,"all six real image revisions remain cold-verified and the selected rendering is unchanged")
        try expect(baselineMetrics.sourceParses==7 && optimizedMetrics.sourceParses==1,"nine-thousand-row catalog is parsed once for the complete image-cache operation")
        print(String(format:"BENCH image-cache synthetic rows=%d shards=%d htmlBytes=%d slots=3 revisions=6 baseline parses=%d reads=%d seconds=%.3f scoped parses=%d reads=%d seconds=%.3f",rows.count,shards.count,html.count,baselineMetrics.sourceParses,baselineMetrics.fileReads,baselineSeconds,optimizedMetrics.sourceParses,optimizedMetrics.fileReads,scopedSeconds))

        let transport=PublicFixtureTransport(files)
        let library=try LibraryService(dataDirectory:dataRoot,seedDirectory:dataRoot.appendingPathComponent("NoSeed"),transport:{url,limit in try await transport.read(url,limit)})
        _=try await library.sync()
        let access=try await library.aggregateReadAccess(id:descriptor.id),requests=await transport.requests
        let warmStart=Date(),presentation=try await library.aggregatePresentation(access,preferCached:true,downloadImages:false),warmSeconds=Date().timeIntervalSince(warmStart)
        try expect(presentation.imageRender?.manifestSHA256==normal.manifestSHA256 && presentation.isStale && presentation.displayHTML.contains("data:image/png;base64,"),"complete cache-only public presentation preserves exact sealed HTML and image provenance")
        try expect(await transport.requests==requests,"complete warm presentation makes no network or image requests")
        print(String(format:"BENCH complete-warm-presentation synthetic rows=%d htmlBytes=%d seconds=%.3f (compile optimization is selected by the test caller)",rows.count,html.count,warmSeconds))

        let blob=root.appendingPathComponent(AggregateResources.blobDirectory+"/"+PublishedAggregateReader.sha(image))
        var brokenImage=image;brokenImage[brokenImage.startIndex] ^= 1;try brokenImage.write(to:blob)
        try expect(rejects{try optimized.withVerifiedReadScope{try $0.latestResourceRendering(source:source)}},"bad saved image bytes still reject the complete image-cache read")
        try image.write(to:blob)
        let peer=root.appendingPathComponent(AggregateResources.renderDirectory+"/"+PublishedAggregateReader.sha(Data(descriptor.id.utf8))+"/"+descriptor.source.manifestSHA256+"/"+source.rawHTMLSHA256+"/"+AggregateResources.contract+"/"+firstSHA+".json")
        let original=try Data(contentsOf:peer);var damaged=original;damaged[damaged.startIndex] ^= 1;try damaged.write(to:peer)
        try expect(rejects{try optimized.withVerifiedReadScope{try $0.latestResourceRendering(source:source)}},"a damaged older image peer cannot be skipped in favor of a newer valid revision")
        let readable=try await library.aggregatePresentation(access,preferCached:true,downloadImages:false)
        try expect(readable.source==source && readable.imageRender==nil && readable.imageNotice.contains("未完成"),"cache-only presentation retains qualified text and reports damaged images without granting success")
        try original.write(to:peer)
        let catalogFolder=root.appendingPathComponent("aggregate-activations/"+catalog.snapshotSHA256)
        let markers=try fm.contentsOfDirectory(at:catalogFolder,includingPropertiesForKeys:nil),savedMarkers=try markers.map{($0,try Data(contentsOf:$0))}
        for marker in markers{try fm.removeItem(at:marker)}
        var epochRejected=false
        do{_=try await library.aggregatePresentation(access,preferCached:true,downloadImages:false)}catch{epochRejected=true}
        for (file,bytes) in savedMarkers{try bytes.write(to:file)}
        try expect(epochRejected,"warm presentation still requires the current catalog activation epoch")
        print("RESULT \(checks) passed; synthetic public metadata/HTML/images only, no provider, credentials or private library")
    }
}
