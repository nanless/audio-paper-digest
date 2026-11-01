import Foundation
import CryptoKit

private actor PagingTransport {
    var files:[String:Data]=[:]
    func install(_ rows:[[String:Any]])throws {
        var shards=[[String:Any]](),bytesTotal=0
        for start in stride(from:0,to:rows.count,by:500){
            let bytes=try JSONSerialization.data(withJSONObject:Array(rows[start..<min(start+500,rows.count)]),options:.sortedKeys)
            let sha=SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined(),path="search-index/part-\(String(format:"%04d",start/500+1))-\(sha.prefix(12)).json"
            files["/blog/"+path]=bytes;bytesTotal+=bytes.count;shards.append(["url":path,"sha256":sha,"bytes":bytes.count,"recordCount":min(500,rows.count-start)])
        }
        files["/blog/index.json"]=try JSONSerialization.data(withJSONObject:["contract":"paper-search-index-manifest-v1","recordCount":rows.count,"totalBytes":bytesTotal,"shards":shards],options:.sortedKeys)
    }
    func read(_ url:URL)throws->Data{guard let data=files[url.path] else{throw DesktopError.message("Synthetic fixture has no such resource")};return data}
}
@main struct LibraryCatalogPagingTests {
    static func main()async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("LibraryCatalogPaging-\(UUID().uuidString)");defer{try? FileManager.default.removeItem(at:root)}
        let rows:[[String:Any]]=(0..<10005).map{i in
            let id="2501."+String(format:"%05d",i)
            return ["permalink":"/blog/posts/synthetic-\(i)/","pageType":"paper","sourceKind":"arxiv","identityStatus":"verified","title":"Synthetic entry \(i)","date":"2026-01-01","arxivId":id,"citation":["paperKey":"arxiv:"+id,"arxivId":id,"sourceKind":"arxiv","identityStatus":"verified","verified":true,"complete":false,"authors":["Synthetic author"],"title":"Synthetic entry \(i)","sourceUrl":"https://arxiv.org/abs/\(id)","pdfUrl":"https://arxiv.org/pdf/\(id).pdf"]]
        }
        let transport=PagingTransport();try await transport.install(rows)
        let library=try LibraryService(dataDirectory:root,siteBaseURL:URL(string:"https://fixture.example/blog/")!,transport:{url,_ in try await transport.read(url)})
        var passes=0
        func check(_ name:String,_ condition:Bool)throws{guard condition else{throw DesktopError.message("FAIL "+name)};passes+=1}
        let synced=try await library.sync();try check("all source rows installed",synced.paperCount==10005)
        let first=try await library.handle(command:"library.list",payload:["limit":10000]),second=try await library.handle(command:"library.list",payload:["offset":10000,"limit":10000])
        let firstRows=first["papers"] as! [[String:Any]],secondRows=second["papers"] as! [[String:Any]]
        try check("full matching total exceeds page cap",first["total"] as? Int==10005)
        try check("page cap remains bounded",firstRows.count==10000 && secondRows.count==5)
        try check("tail page offset applied to full results",secondRows.first?["id"] as? String=="arxiv:2501.10000")
        try check("same native source stamp in every page",first["snapshotID"] as? String==synced.snapshotID && second["snapshotID"] as? String==synced.snapshotID)
        try check("no current row marked retained",firstRows.allSatisfy{$0["localRetained"] as? Bool==false})
        try await transport.install(Array(rows.dropFirst()));let removed=try await library.sync()
        let retained=try await library.handle(command:"library.list",payload:["query":"Synthetic entry 0","limit":100])
        let retiredRow=(retained["papers"] as! [[String:Any]]).first{$0["id"] as? String=="arxiv:2501.00000"}
        try check("published count remains current source only",removed.paperCount==10004 && retained["totalInLibrary"] as? Int==10004)
        try check("removed never-opened favorite remains discoverable",retiredRow?["localRetained"] as? Bool==true)
        try check("retained source identity unchanged",retiredRow?["sourceURL"] as? String=="https://arxiv.org/abs/2501.00000")
        let currentOnly=await library.list(limit:10000);try check("internal current source API does not gain retired rows",!currentOnly.contains{$0.id=="arxiv:2501.00000"})
        let cold=try LibraryService(dataDirectory:root,siteBaseURL:URL(string:"https://fixture.example/blog/")!,transport:{url,_ in try await transport.read(url)})
        let coldRetained=try await cold.handle(command:"library.list",payload:["query":"Synthetic entry 0"])
        try check("retained catalog survives cold launch",(coldRetained["papers"] as? [[String:Any]])?.first?["localRetained"] as? Bool==true)
        try await transport.install(rows);_=try await library.sync();let restored=try await library.handle(command:"library.list",payload:["query":"Synthetic entry 0"])
        let restoredRows=restored["papers"] as! [[String:Any]]
        try check("restored current record wins without duplicate",restoredRows.count==1 && restoredRows[0]["localRetained"] as? Bool==false)
        print("LibraryCatalogPaging: \(passes) checks passed, 0 failed; 10005 synthetic rows, no real transport/account/model")
    }
}
