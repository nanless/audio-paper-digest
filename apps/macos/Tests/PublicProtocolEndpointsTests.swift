import Foundation
import CryptoKit

private actor EndpointFixture {
    var files:[String:Data]
    var statuses:[String:Int]
    var requests:[String]=[]
    init(_ files:[String:Data],_ statuses:[String:Int]=[:]){self.files=files;self.statuses=statuses}
    func read(_ url:URL,_ limit:Int)throws->Data {
        requests.append(url.path)
        if let bytes=files[url.path] ?? files[url.path+"/"] {return bytes}
        throw LibraryService.ServiceError.httpStatus(statuses[url.path] ?? 404)
    }
    func paths()->[String]{requests}
    func update(_ path:String,_ bytes:Data){files[path]=bytes}
}

@main struct PublicProtocolEndpointsTests {
    static let base=URL(string:"https://fixture.example/blog/")!
    static func bytes(_ value:Any)throws->Data {try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])}
    static func hash(_ value:Data)->String{SHA256.hash(data:value).map{String(format:"%02x",$0)}.joined()}
    static func check(_ condition:Bool,_ message:String)throws {if !condition {throw LibraryService.ServiceError.invalid("TEST: "+message)}}
    static func folder()throws->URL {
        let url=FileManager.default.temporaryDirectory.appendingPathComponent("public-endpoints-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:url,withIntermediateDirectories:true);return url
    }
    static func row()->[String:Any] {[
        "permalink":"/blog/posts/paper/","pageType":"paper","title":"Original paper","date":"2026-11-02",
        "sourceKind":"arxiv","identityStatus":"verified","arxivId":"2610.41381",
        "citation":["paperKey":"arxiv:2610.41381","identityStatus":"verified","sourceKind":"arxiv","arxivId":"2610.41381v1",
                    "sourceUrl":"https://arxiv.org/abs/2610.41381v1","pdfUrl":"https://arxiv.org/pdf/2610.41381v1.pdf"]]}
    private static func service(_ folder:URL,_ fixture:EndpointFixture)throws->LibraryService {
        try LibraryService(dataDirectory:folder,siteBaseURL:base,transport:{url,limit in try await fixture.read(url,limit)})
    }
    static func main()async throws {
        let original=try bytes([row()]),sha=hash(original),name="search-index/part-0001-"+String(sha.prefix(12))+".json"
        let header=try ClientProtocols.recordHeader("paper-search-index-manifest","paper-search-index-manifest")
        let manifest=header.merging(["recordCount":1,"totalBytes":original.count,"shards":[["url":name,"bytes":original.count,"recordCount":1,"sha256":sha]]]){_,new in new}
        let root=try folder();defer{try? FileManager.default.removeItem(at:root)}
        let fixture=EndpointFixture(["/blog/client/index.json":try bytes(manifest),"/blog/client/"+name:original])
        let library=try service(root,fixture)
        let summary=try await library.sync()
        try check(summary.paperCount==1,"new endpoint must load the actual new-directory shard")
        try check(await fixture.paths()==["/blog/client/index.json","/blog/client/"+name],"new index cannot fetch old shards")
        let currentPath=root.appendingPathComponent("PublishedLibrary/current.json")
        let currentBytes=try Data(contentsOf:currentPath)
        var currentJSON=try JSONSerialization.jsonObject(with:currentBytes) as! [String:Any]
        try check(ClientProtocols.isCurrentHeader(currentJSON,"paperdigest-published-library"),"normal sync saves a fingerprinted local catalog")
        try check(try await service(root,fixture).status().paperCount==1,"current native catalog cold reopens")
        currentJSON.removeValue(forKey:"contract");currentJSON.removeValue(forKey:"schemaFingerprint")
        currentJSON["format"]="mac-published-library-v1"
        let oldLocal=try bytes(currentJSON)
        try oldLocal.write(to:currentPath)
        try check(try await service(root,fixture).status().paperCount==1 && Data(contentsOf:currentPath)==oldLocal,"original local catalog remains readable and unmodified")
        currentJSON["schemaFingerprint"]=ClientProtocols.schemaFingerprint("paperdigest-published-library")
        let mixedLocal=try bytes(currentJSON)
        try mixedLocal.write(to:currentPath)
        var mixedRejected=false
        do{_=try service(root,fixture)}catch{mixedRejected=true}
        try check(mixedRejected && (try Data(contentsOf:currentPath))==mixedLocal,"mixed local format is refused without replacing the original")
        try currentBytes.write(to:currentPath)
        // Explicitly synthetic published files exercise the real HTML reader,
        // source owner checks and exact-page response hashes, without HTTP.
        let sidecarRoot="/blog/client/papers/2026-11-02/2610-41381/"
        let common:[String:Any]=["arxivId":"2610.41381","arxivVersionedId":"2610.41381v1","id":"2610.41381v1",
                                 "absUrl":"https://arxiv.org/abs/2610.41381v1","pdfUrl":"https://arxiv.org/pdf/2610.41381v1.pdf",
                                 "originalTitle":"Original paper","type":"preprint"]
        let contextHeader=try ClientProtocols.recordHeader("paper-research-context","paper-research-context")
        let content:[String:Data]=[
            "citation.json":try bytes(ClientProtocols.record("researcher-sidecars",fields:common)),
            "citation.bib":Data("@misc{synthetic, title={Original paper}}\n".utf8),
            "citation.ris":Data("TY  - UNPB\nTI  - Original paper\nER  - \n".utf8),
            "rethink-context.json":try bytes(ClientProtocols.record("paper-research-context",fields:common.merging(["abstract":"Synthetic public endpoint fixture"]){_,new in new}))]
        var descriptors:[String:Any]=[:]
        for (filename,raw) in content {
            var descriptor:[String:Any]=["url":sidecarRoot+filename,"sha256":hash(raw)]
            if filename=="rethink-context.json" {descriptor.merge(contextHeader){_,new in new}}
            descriptors[filename]=descriptor;await fixture.update(sidecarRoot+filename,raw)
        }
        let declaration=String(data:try bytes(descriptors),encoding:.utf8)!
        let html="<html><body><div id='article-body' class='post-content'><p>Synthetic published guide.</p></div><a href='/blog/data/papers/2026-11-02/2610-41381/citation.json'>Legacy</a><script type='application/json' class='paper-tools__client-sidecars'>"+declaration+"</script></body></html>"
        await fixture.update("/blog/posts/paper/",Data(html.utf8))
        let article=try await library.article(for:"arxiv:2610.41381",refresh:true,downloadImages:false)
        try check(article.citationSidecar != nil && article.researchContext != nil,"both canonical JSON originals must pass normal parsing")
        try check(article.citationFiles?.values.allSatisfy{$0.contains("/client/papers/")} == true,"new declaration must win over old anchors")
        try check(article.citationFileSHA256?["citation.json"]==hash(content["citation.json"]!),"the loaded article preserves its actual page-declared SHA")
        _=try await library.citationFile(for:"arxiv:2610.41381",format:"json")
        await fixture.update(sidecarRoot+"citation.json",try bytes(ClientProtocols.record("researcher-sidecars",fields:common.merging(["extra":"synthetic changed response"]){_,new in new})))
        var changedRejected=false
        do{_=try await library.citationFile(for:"arxiv:2610.41381",format:"json")}catch{changedRejected=true}
        try check(changedRejected,"changed canonical file bytes must fail even with a valid format and owner")
        try check(!(await fixture.paths()).contains(where:{$0.contains("/data/papers/")}),"failed new material cannot silently use the old anchor")
        for status in [404,410] {
            let directory=try folder();defer{try? FileManager.default.removeItem(at:directory)}
            let old=EndpointFixture(["/blog/index.json":original],["/blog/client/index.json":status])
            _=try await service(directory,old).sync()
            try check(await old.paths()==["/blog/client/index.json","/blog/index.json"],"explicit missing endpoint must preserve the old array route")
        }
        for invalid in [try bytes(manifest.merging(["schemaFingerprint":String(repeating:"0",count:64)]){_,new in new}),original,Data("{broken".utf8)] {
            let directory=try folder();defer{try? FileManager.default.removeItem(at:directory)}
            let bad=EndpointFixture(["/blog/client/index.json":invalid,"/blog/index.json":original])
            var rejected=false;do{_=try await service(directory,bad).sync()}catch{rejected=true}
            try check(rejected,"new endpoint corruption must reject")
            try check(await bad.paths()==["/blog/client/index.json"],"corruption cannot request the old endpoint")
        }
        let oldManifest=manifest.filter{$0.key != "schemaFingerprint"}.merging(["contract":"paper-search-index-manifest-v1"]){_,new in new}
        for (suffix,body,accepted) in [("index.json",manifest,false),("client/index.json",oldManifest,false),("index.json",oldManifest,true)] {
            let directory=try folder();defer{try? FileManager.default.removeItem(at:directory)}
            let indexPath="/blog/"+suffix
            let shardPath=suffix.hasPrefix("client/") ? "/blog/client/"+name : "/blog/"+name
            let transport=EndpointFixture([indexPath:try bytes(body),shardPath:original])
            var success=false;do{_=try await service(directory,transport).sync();success=true}catch{}
            try check(success==accepted,"public endpoint accepts only its own original manifest namespace")
            try check((await transport.paths()).contains(shardPath)==accepted,"wrong manifest namespace is rejected before shards")
        }
        let registrySHA=String(repeating:"a",count:64)
        let tagRow=row().merging(["tagConcepts":[["id":"task.asr","facet":"task","label":"识别"]]]){_,new in new}
        let indexedTags=try bytes([tagRow])
        let saved=try ClientProtocols.record("paper-tag-catalog-snapshot",fields:["registrySha256":registrySHA,"concepts":[["id":"task.asr","facet":"task","zh":"识别","aliases":[],"ancestorIds":[]]]])
        let versions=try ClientProtocols.record("paper-tag-catalog-versions",fields:["currentSha256":registrySHA,"snapshots":[saved]])
        func originalHeader(_ value:[String:Any],_ family:String,_ variant:String)throws->[String:Any] {
            try ClientProtocols.historicalHeader(family,variant:variant,fingerprints:nil).merging(value.filter{!["contract","schemaFingerprint"].contains($0.key)}){old,_ in old}
        }
        let legacySaved=try originalHeader(saved,"paper-tag-catalog-snapshot","public-concept-hierarchy")
        let legacyVersions=try originalHeader(versions,"paper-tag-catalog-versions","sha-keyed-snapshot-set").merging(["snapshots":[legacySaved]]){_,new in new}
        for (prefix,display,available,expectLegacyRequests) in [
            ("client/data/",[saved,versions],true,false),("client/data/",[legacySaved,legacyVersions],false,false),
            ("data/",[legacySaved,legacyVersions],true,true),("data/",[saved,versions],false,true)] {
            let directory=try folder();defer{try? FileManager.default.removeItem(at:directory)}
            let transport=EndpointFixture(["/blog/index.json":indexedTags,"/blog/"+prefix+"tag-catalog-snapshot.json":try bytes(display[0]),"/blog/"+prefix+"tag-catalog-versions.json":try bytes(display[1])])
            let service=try service(directory,transport);_=try await service.sync()
            let local=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent("PublishedLibrary/current.json"))) as! [String:Any]
            try check((local["websiteTaxonomy"] != nil)==available,"taxonomy endpoints cannot swap registered stable and historical headers")
            try check((await transport.paths()).contains("/blog/data/tag-catalog-snapshot.json")==expectLegacyRequests,"wrong current taxonomy does not trigger legacy fallback")
        }
        let unavailableRoot=try folder();defer{try? FileManager.default.removeItem(at:unavailableRoot)}
        let unavailable=EndpointFixture(["/blog/index.json":original],["/blog/client/index.json":500])
        var rejected=false;do{_=try await service(unavailableRoot,unavailable).sync()}catch{rejected=true}
        let unavailablePaths=await unavailable.paths()
        try check(rejected && unavailablePaths==["/blog/client/index.json"],"HTTP500 cannot become a missing-endpoint fallback")
        print("PASS public endpoint positive and negative assertions")
    }
}
