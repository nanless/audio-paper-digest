// Isolated published-image policy and real LibraryService cache integration.
// No network by default. Optional public PNG copies are independently SHA-bound.
import Foundation
import CryptoKit

actor PublishedImageFixture {
    var files:[String:Data]
    var requests:[String]=[]
    init(_ files:[String:Data]){self.files=files}
    func read(_ url:URL,_ limit:Int)throws->Data {
        requests.append(url.absoluteString)
        guard let data=files[url.absoluteString],data.count<=limit else{throw LibraryService.ServiceError.network("isolated published fixture unavailable")}
        return data
    }
    func put(_ url:String,_ data:Data){files[url]=data}
}

@main struct LibraryImageSourcesTests {
    static var checks=0
    static let prefix="https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/"
    static let images=(1...3).map{prefix+"interspeech-2026/11ff0ce7b961/figure-\($0).png"}
    static func hash(_ data:Data)->String{SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()}
    static func expect(_ result:Bool,_ name:String)throws{guard result else{throw LibraryService.ServiceError.invalid("FAIL "+name)};checks+=1;print("PASS "+name)}
    static func approved(_ address:String)->Bool{URL(string:address).map{LibraryService.isApprovedExternalResource($0)} ?? false}
    static func policy()throws {
        for address in images {try expect(approved(address),"actual TurnGuide public figure allowed")}
        for conference in ["dafx-2026","acl-2026","eusipco-2026","cvpr-2026","nime-2026","speechprosody-2026","aaai-2026","odyssey-2026","icmc-2026","jep-2026","eacl-2026","iwslt-2026","chime-2026","uai-2026","aistats-2026"] {
            try expect(approved(prefix+conference+"/0123456789ab/figure-1.png"),"published conference image layout supported: "+conference)
        }
        let historical=["https://nanless.github.io/audio-paper-digest-images/icassp-2026/2026-04-29/11462137-0.png","https://nanless.github.io/audio-paper-digest-images/iclr-2026/2026-05-04/HQMVRQUEaM-11.jpg"]
        for address in historical {try expect(approved(address),"published historical GitHub Pages image allowed outside blog prefix")}
        let rejected=[
            "https://raw.githubusercontent.com/another/audio-paper-digest-images/main/interspeech-2026/11ff0ce7b961/figure-1.png",
            "https://raw.githubusercontent.com/nanless/other/main/interspeech-2026/11ff0ce7b961/figure-1.png",
            images[0].replacingOccurrences(of:"/main/",with:"/dev/"),
            images[0].replacingOccurrences(of:"/main/",with:"/refs/heads/main/"),
            prefix+"unknown-2026/11ff0ce7b961/figure-1.png",
            prefix+"interspeech-2026/11ff0ce7b961/../../README.md",
            prefix+"interspeech-2026/11ff0ce7b961/%2e%2e/figure-1.png",
            prefix+"interspeech-2026%2f11ff0ce7b961/figure-1.png",
            prefix+"interspeech-2026/11ff0ce7b961/figure-1.png%00",
            prefix+"interspeech-2026//11ff0ce7b961/figure-1.png",
            prefix+"interspeech-2026/11ff0ce7b961/figure-1.png/extra",
            prefix+"interspeech-2026/11ff0ce7b961/figure-0.png",
            prefix+"interspeech-2026/11ff0ce7b961/figure-1.svg",
            prefix+"interspeech-2026/11FF0ce7b961/figure-1.png",
            prefix+"interspeech-2026/11ff0ce7b961/figure-1.png?raw=1",
            images[0]+"#fragment",images[0].replacingOccurrences(of:"https:",with:"http:"),
            images[0].replacingOccurrences(of:"raw.githubusercontent.com/",with:"raw.githubusercontent.com.evil.invalid/"),
            images[0].replacingOccurrences(of:"raw.githubusercontent.com/",with:"user@raw.githubusercontent.com/"),
            images[0].replacingOccurrences(of:"raw.githubusercontent.com/",with:"raw.githubusercontent.com:8443/"),
            "https://127.0.0.1/nanless/audio-paper-digest-images/main/interspeech-2026/11ff0ce7b961/figure-1.png",
            historical[0].replacingOccurrences(of:"audio-paper-digest-images",with:"other-repo"),
            historical[0].replacingOccurrences(of:"icassp-2026",with:"unknown-2026"),
            historical[0].replacingOccurrences(of:"/2026-04-29/",with:"/../"),
            historical[0].replacingOccurrences(of:"/2026-04-29/",with:"/2026-99-99/"),
            historical[0]+"?download=1",historical[1].replacingOccurrences(of:".jpg",with:".html")
        ]
        for address in rejected{try expect(!approved(address),"untrusted owner branch path alias or redirect target rejected")}
        for address in ["https://arxiv.org/pdf/2610.27491v1.pdf","https://www.isca-archive.org/interspeech_2026/cui26_interspeech.pdf","https://openreview.net/pdf?id=fixture"]{try expect(approved(address),"existing official source policy retained")}
        let proxy=URL(string:"http://127.0.0.1:7897")!
        for address in images+historical+["https://arxiv.org/pdf/2610.27491v1.pdf"]{try expect(LibraryService.externalResourceProxy(URL(string:address)!,configured:proxy)==proxy,"explicit configured CONNECT used only for supported route")}
        try expect(LibraryService.externalResourceProxy(URL(string:images[0])!,configured:nil)==nil,"no environment proxy or implicit connection is invented")
        try expect(LibraryService.externalResourceProxy(URL(string:"https://www.isca-archive.org/interspeech_2026/cui26_interspeech.pdf")!,configured:proxy)==nil,"ordinary official source keeps existing direct route")
        try expect(LibraryService.externalResourceProxy(URL(string:rejected[0])!,configured:proxy)==nil,"unapproved GitHub repository receives no proxy capability")
        // These are the same per-hop checks used before every production DNS lookup.
        try expect(approved(images[0]) && !approved(rejected[0]) && !approved("https://169.254.169.254/latest/meta-data/"),"approved first hop does not authorize repository or metadata-service redirect")
        for address in ["127.0.0.1","10.0.0.1","169.254.169.254","192.168.1.1","::1","fc00::1"]{try expect(!LibraryService.isPublicAddress(address),"existing SSRF public-IP boundary retained")}
    }
    static func integration()async throws {
        let fm=FileManager.default,folder=fm.temporaryDirectory.appendingPathComponent("PublishedImageSources-"+UUID().uuidString)
        try fm.createDirectory(at:folder,withIntermediateDirectories:true);defer{try? fm.removeItem(at:folder)}
        let base="https://nanless.github.io/audio-paper-digest-blog/",identity="conference:interspeech:2026:conference-paper-id:cui26_interspeech"
        let record:[String:Any]=["permalink":base+"posts/turnguide/","pageType":"paper","title":"TurnGuide","titleZh":"TurnGuide fixture","sourceKind":"conference","identityStatus":"verified","paperId":identity,"date":"2026-10-16","citation":["paperKey":identity,"sourceUrl":"https://www.isca-archive.org/interspeech_2026/cui26_interspeech.html","pdfUrl":"https://www.isca-archive.org/interspeech_2026/cui26_interspeech.pdf"]]
        let shard=try JSONSerialization.data(withJSONObject:[record],options:[.sortedKeys]),shardName="search-index/part-0001-"+hash(shard).prefix(12)+".json"
        let manifest:[String:Any]=["contract":"paper-search-index-manifest-v1","recordCount":1,"totalBytes":shard.count,"shards":[["url":shardName,"sha256":hash(shard),"bytes":shard.count,"recordCount":1]]]
        // MathML's pre-existing HTML-tidy loss is tracked separately, not counted
        // as an image-policy success. TurnGuide itself has no source formulas.
        let html="<html><body><div id='article-body' class='post-content'><h2>Published figure fixtures</h2><p>Original caption and source warning retained.</p>"+images.enumerated().map{"<figure><img src='\($0.element)' alt='Figure \($0.offset+1)'><figcaption>Original figure caption \($0.offset+1)</figcaption></figure>"}.joined()+"<table><tr><td>Preserved table</td></tr></table></div></body></html>"
        let transport=PublishedImageFixture([base+"index.json":try JSONSerialization.data(withJSONObject:manifest),base+shardName:shard,base+"posts/turnguide/":Data(html.utf8)])
        let library=try LibraryService(dataDirectory:folder,transport:{url,limit in try await transport.read(url,limit)})
        _=try await library.sync()
        let incomplete=try await library.article(for:identity)
        try expect(incomplete.resources.count==3 && !incomplete.completeOffline && incomplete.resources.allSatisfy{$0.localPath==nil},"missing three figures remain explicit incomplete cache, never a successful offline article")
        let fixturePNG=Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LAAAAABJRU5ErkJggg==")!
        var payloads=[Data](repeating:fixturePNG,count:3)
        if CommandLine.arguments.count>1 {
            let originals=URL(fileURLWithPath:CommandLine.arguments[1]),hashes=["41ac8150e663bbca97fdeb8ffc1a04faba8d328f2d657c5fa0fdfd8ae006545d","3572acbbbc46967f10aab0ef5b1e05368eae145d5606837e166c020c1affeea6","0e033cf52e168df9c61e2197565a2f16123a15ec71a48dc8c4d603e7c2797536"]
            payloads=try (1...3).map{try Data(contentsOf:originals.appendingPathComponent("figure-\($0).png"))}
            for (index,bytes) in payloads.enumerated(){try expect(hash(bytes)==hashes[index],"real public TurnGuide PNG SHA verified before isolated integration")}
        }
        for (index,address) in images.enumerated(){await transport.put(address,payloads[index])}
        let complete=try await library.article(for:identity)
        try expect(complete.completeOffline && complete.resources.count==3,"next normal article open repairs prior missing scientific figures")
        try expect(complete.html.components(separatedBy:"data:image/png;base64,").count-1==3,"all three figure resources become self-contained HTML")
        try expect(complete.html.contains("Original figure caption 1") && complete.html.contains("Original caption and source warning retained.") && complete.html.contains("Preserved table"),"image repair retains scientific captions source warning and original table")
        for (index,resource) in complete.resources.enumerated(){
            guard let path=resource.localPath else{throw LibraryService.ServiceError.invalid("missing repaired resource")}
            try expect(resource.sourceURL==images[index] && resource.sha256==hash(payloads[index]) && (try Data(contentsOf:URL(fileURLWithPath:path)))==payloads[index],"cache original URL SHA and actual PNG bytes remain bound")
            try expect(complete.html.contains(payloads[index].base64EncodedString()),"renderable/exportable HTML embeds the exact source PNG bytes")
        }
        let cached=try await library.article(for:identity)
        try expect(cached.completeOffline && cached.resources.map{$0.sha256}==complete.resources.map{$0.sha256},"complete offline cache reopens with original figure identities")
        let damaged=URL(fileURLWithPath:complete.resources[0].localPath!)
        try Data("damaged fixture bytes".utf8).write(to:damaged)
        let repaired=try await library.article(for:identity)
        try expect(repaired.completeOffline && (try Data(contentsOf:URL(fileURLWithPath:repaired.resources[0].localPath!)))==payloads[0],"modified cached image is rechecked and repaired rather than trusted as complete")
    }
    static func main()async throws {
        try policy()
        if CommandLine.arguments.count>2 {
            let inventory=try JSONDecoder().decode([String].self,from:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2])))
            try expect(!inventory.isEmpty && inventory.allSatisfy{approved($0)},"actual published image URL inventory entirely fits the constrained source policy")
            print("Published image inventory verified: \(inventory.count) public URLs; no network")
        }
        try await integration();print("LibraryImageSources PASS \(checks) checks; isolated fixture, no model/Keychain/user profile/network")
    }
}
