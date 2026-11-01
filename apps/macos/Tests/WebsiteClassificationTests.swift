import Foundation
import CryptoKit

actor WebsiteTransport {
    var files:[String:Data];var requests:[String]=[]
    init(_ files:[String:Data]){self.files=files}
    func read(_ url:URL)throws->Data{requests.append(url.path);guard let data=files[url.path] else{throw LibraryService.ServiceError.network("Explicit public fixture unavailable: \(url.path)")};return data}
    func remove(_ path:String){files.removeValue(forKey:path)}
    func count(_ suffix:String)->Int{requests.filter{$0.hasSuffix(suffix)}.count}
}
@main struct WebsiteClassificationTests {
    static var checks=0
    static let base=URL(string:"https://nanless.github.io/audio-paper-digest-blog/")!
    static func expect(_ value:Bool,_ text:String)throws{checks+=1;guard value else{throw LibraryService.ServiceError.invalid("TEST: "+text)}}
    static func data(_ value:Any)throws->Data{try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])}
    static func sha(_ bytes:Data)->String{SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined()}
    static func fixture(_ rows:[[String:Any]])throws->[String:Data]{let bytes=try data(rows),name="search-index/part-0001-\(sha(bytes).prefix(12)).json";return [(base.path+"/")+name:bytes,(base.path+"/")+"index.json":try data(["contract":"paper-search-index-manifest-v1","recordCount":rows.count,"totalBytes":bytes.count,"shards":[["url":name,"sha256":sha(bytes),"bytes":bytes.count,"recordCount":rows.count]]])]}
    static func service(_ root:URL,_ transport:WebsiteTransport)throws->LibraryService{try LibraryService(dataDirectory:root,siteBaseURL:base,transport:{url,_ in try await transport.read(url)})}
    static func main()async throws {
        let golden=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:"tests/fixtures/workbench-website-taxonomy-golden.json"))) as! [String:Any],display=golden["display"] as! [String:Any],cases=golden["cases"] as! [[String:Any]]
        let row=cases[0]["record"] as! [String:Any];var second=row;second["permalink"]=(base.path+"/")+"posts/explicit-duplicate-guide/";second["date"]="2026-10-31";second["title"]="Explicit newer representative"
        var files=try fixture([row,second]);let snapshotBytes=try data(display["snapshot"]!),versionsBytes=try data(display["versions"]!)
        files[(base.path+"/")+"data/tag-catalog-snapshot.json"]=snapshotBytes;files[(base.path+"/")+"data/tag-catalog-versions.json"]=versionsBytes
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("WebsiteClassification-\(UUID().uuidString)");defer{try? FileManager.default.removeItem(at:root)}
        let transport=WebsiteTransport(files),library=try service(root,transport);_ = try await library.sync()
        let response=try await library.handle(command:"library.list",payload:["limit":100]),papers=response["papers"] as! [[String:Any]],paper=papers[0],records=paper["websiteTagRecords"] as! [[String:Any]],assets=response["websiteTaxonomy"] as! [String:Any]
        try expect(papers.count==1 && records.count==2,"canonical duplicates preserve both original guide classifications")
        try expect(records[0]["tagCatalogSha256"] as? String==row["tagCatalogSha256"] as? String,"original issue SHA not replaced by current")
        try expect(records[0]["score"] as? String==row["score"] as? String && (records[0]["citation"] as? [String:Any])?["authors"] as? [String]==(row["citation"] as? [String:Any])?["authors"] as? [String],"per-guide query original score and citation authors retained")
        try expect(assets["snapshotContentSHA256"] as? String==sha(snapshotBytes)&&assets["versionsContentSHA256"] as? String==sha(versionsBytes),"paired display source bytes independently recorded")
        let snapshotRequests=await transport.count("tag-catalog-snapshot.json"),versionRequests=await transport.count("tag-catalog-versions.json");try expect(snapshotRequests==1 && versionRequests==1,"only one paired download per catalog sync")
        let tail=try await library.handle(command:"library.list",payload:["offset":1]);try expect(tail["websiteTaxonomy"]==nil,"large display assets sent only on first page")
        let cold=try service(root,transport),coldResponse=try await cold.handle(command:"library.list",payload:[:]);try expect((coldResponse["websiteTaxonomy"] as? [String:Any])?["snapshotContentSHA256"] as? String==sha(snapshotBytes),"official assets survive cold cache loading")
        await transport.remove((base.path+"/")+"data/tag-catalog-versions.json");_ = try await library.sync();let fallback=try await library.handle(command:"library.list",payload:[:]);try expect((fallback["papers"] as? [[String:Any]])?.count==1 && fallback["websiteTaxonomy"] is [String:Any],"failed update keeps papers and previous paired assets")
        try expect((fallback["websiteTaxonomyNotice"] as? String)?.contains("上次") == true,"cached taxonomy update failure explicit")
        let fresh=FileManager.default.temporaryDirectory.appendingPathComponent("WebsiteClassificationUnavailable-\(UUID().uuidString)");defer{try? FileManager.default.removeItem(at:fresh)};let noAssets=try service(fresh,transport);_ = try await noAssets.sync();let missing=try await noAssets.handle(command:"library.list",payload:[:]);try expect(missing["websiteTaxonomy"] is NSNull && (missing["papers"] as? [[String:Any]])?.count==1,"first resource failure retains readable catalog without invented tree")
        if CommandLine.arguments.count==3 {
            let site=URL(fileURLWithPath:CommandLine.arguments[1]),pair=URL(fileURLWithPath:CommandLine.arguments[2]);let manifest=try JSONSerialization.jsonObject(with:Data(contentsOf:site.appendingPathComponent("index.json"))) as! [String:Any];var full:[String:Data]=[(base.path+"/")+"index.json":try Data(contentsOf:site.appendingPathComponent("index.json"))]
            for shard in manifest["shards"] as! [[String:Any]]{let name=shard["url"] as! String;full[(base.path+"/")+name]=try Data(contentsOf:site.appendingPathComponent(name))}
            for name in ["tag-catalog-snapshot.json","tag-catalog-versions.json"]{full[(base.path+"/")+"data/"+name]=try Data(contentsOf:pair.appendingPathComponent(name))}
            let fullRoot=root.appendingPathComponent("full-public-site"),fullTransport=WebsiteTransport(full),fullLibrary=try service(fullRoot,fullTransport);let summary=try await fullLibrary.sync(),current=try Data(contentsOf:fullRoot.appendingPathComponent("PublishedLibrary/current.json"));let restarted=try service(fullRoot,fullTransport),coldSummary=await restarted.status()
            try expect(summary.recordCount==8875,"genuine full published fixture covers 8875 source rows");try expect(current.count<=64*1024*1024 && coldSummary.paperCount==summary.paperCount,"real full-site snapshot below unchanged 64MiB cold-load policy")
            print("REAL PUBLIC CATALOG: rows=\(summary.recordCount) papers=\(summary.paperCount) current.json=\(current.count) bytes coldPapers=\(coldSummary.paperCount)")
        }
        print("PASS WebsiteClassification native: \(checks) checks; source-bound paired taxonomy, per-guide originals, cold restart, bounded first-page bridge, update outage and no fabricated fallback")
    }
}
