import Foundation
import CryptoKit

actor ReleaseCatalogFixture {
    let files:[String:Data]
    var calls=0
    init(_ files:[String:Data]){self.files=files}
    func read(_ url:URL,_ limit:Int)throws->Data {calls+=1;guard let bytes=files[url.path],bytes.count<=limit else{throw NSError(domain:"fixture",code:1)};return bytes}
    func count()->Int{calls}
}
@main struct ReleaseEmptyLibraryTests {
    static func expect(_ value:Bool,_ message:String)throws{if !value{throw NSError(domain:message,code:1)}}
    @MainActor static func main()async throws {
        let base = CommandLine.arguments.count==2 ? URL(fileURLWithPath:CommandLine.arguments[1]) : FileManager.default.temporaryDirectory.appendingPathComponent("missing-formal-resources-"+UUID().uuidString)
        let seed=base.appendingPathComponent("Seed")
        try expect(!FileManager.default.fileExists(atPath:seed.path),"formal Seed absent")
        let dir=FileManager.default.temporaryDirectory.appendingPathComponent("release-empty-library-"+UUID().uuidString)
        defer{try?FileManager.default.removeItem(at:dir)}
        let row:[String:Any]=["permalink":"/blog/posts/synthetic/","pageType":"paper","title":"Explicit synthetic published record","titleZh":"明确合成目录夹具","date":"2026-01-01","score":7,"sourceKind":"arxiv","identityStatus":"verified","arxivId":"2501.00001","citation":["title":"Explicit synthetic published record","authors":["Synthetic Author"],"arxivId":"2501.00001v1","sourceKind":"arxiv","sourceUrl":"https://arxiv.org/abs/2501.00001v1","pdfUrl":"https://arxiv.org/pdf/2501.00001v1.pdf"]]
        let bytes=try JSONSerialization.data(withJSONObject:[row],options:.sortedKeys),hash=SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined(),path="search-index/part-0001-"+String(hash.prefix(12))+".json"
        let manifest=try JSONSerialization.data(withJSONObject:["contract":"paper-search-index-manifest-v1","recordCount":1,"totalBytes":bytes.count,"shards":[["url":path,"sha256":hash,"bytes":bytes.count,"recordCount":1]]],options:.sortedKeys)
        let transport=ReleaseCatalogFixture(["/blog/index.json":manifest,"/blog/"+path:bytes])
        let service=try LibraryService(dataDirectory:dir,siteBaseURL:URL(string:"https://fixture.invalid/blog/")!,seedDirectory:seed,transport:{url,limit in try await transport.read(url,limit)})
        let initial=await service.status();try expect(initial.paperCount==0&&initial.syncedAt==nil,"fresh library truly empty unsynced");try expect(initial.source=="尚未同步","honest unsynced source")
        let before=await transport.count();try expect(before==0,"no implicit website/model call")
        let actual=try await service.sync();try expect(actual.paperCount==1&&actual.recordCount==1,"on-demand actual fixture catalog count")
        let after=await transport.count();try expect(after==2,"exactly manifest and one shard, no model")
        print("PASS formal empty bootstrap and explicit fixture sync: 6 assertions; no external HTTP/LLM/user data")
    }
}
