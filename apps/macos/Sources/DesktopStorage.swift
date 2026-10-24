import Foundation
import CryptoKit
import PDFKit
import Darwin

/// Local storage accounting and reviewable plans. Existing user data is never deleted; no model is requested.
actor DesktopStorage {
    enum StorageError: Error, LocalizedError {
        case invalid(String)
        var errorDescription: String? {if case .invalid(let message)=self{return message};return "本机资料检查失败"}
    }
    private struct Entry: Codable {var path:String;var bytes:Int;var sha256:String;var role:String;var sourceURL:String?}
    private struct Manifest: Codable {
        var contract="paperdigest-offline-package-v2"
        var id:String;var paperID:String;var title:String;var createdAt:String
        var blogURL:String;var sourceURL:String;var sourceVersion:String?;var articleRevisionSHA256:String;var articleContentSHA256:String
        var pdfURL:String?;var pdfSHA256:String?;var paperContentSHA256:String?;var files:[Entry]
    }
    private struct Candidate: Codable {var path:String;var filePath:String;var bytes:Int;var sha256:String;var category:String}
    private struct Plan {var files:[Candidate];var evidence:String;var createdAt:Date}
    private let directory:URL
    private let store:DesktopStore
    private let seed:URL?
    private var plans:[String:Plan]=[:]
    private var protectionRoots:[String]=[]
    init(directory:URL,store:DesktopStore,bundledSeedDirectory:URL?=nil) {
        self.directory=directory;self.store=store
        seed=bundledSeedDirectory ?? Bundle.main.resourceURL?.appendingPathComponent("Seed")
    }
    func capacity() throws->[String:Any] {
        var totals:[String:Int]=[:],counts:[String:Int]=[:]
        for(file,path) in try inventory() {
            let category=Self.category(path),bytes=try size(file)
            totals[category,default:0]+=bytes;counts[category,default:0]+=1
        }
        let labels=["articles":"网站导读","pdf":"网站原文 PDF","images":"科学图","revisions":"旧导读修订","catalog":"网站目录与索引","offline":"离线研究包","imports":"个人导入","exports":"个人导出","modelUsage":"模型响应与真实用量","personal":"个人笔记与设置","zotero":"Zotero 归档检查点","other":"其他私有资料"]
        let rows=labels.keys.sorted().map{["key":$0,"label":labels[$0]!,"bytes":totals[$0] ?? 0,"files":counts[$0] ?? 0] as [String:Any]}
        return ["directory":directory.path,"totalBytes":totals.values.reduce(0,+),"categories":rows,"files":counts.values.reduce(0,+)]
    }
    func register(paper:[String:Any],article:[String:Any],pdf:[String:Any]?=nil) throws->[String:Any] {
        let root=try PrivateStoragePaths.checkedDirectory(directory)
        guard let paperID=paper["id"] as? String ?? paper["paperID"] as? String,!paperID.isEmpty,
              article["paperID"] as? String==paperID,article["completeOffline"] as? Bool==true,article["isStale"] as? Bool != true,
              let blog=paper["blogURL"] as? String,let source=article["sourceURL"] as? String,Self.https(blog),Self.https(source),
              source==(paper["sourceURL"] as? String ?? blog),
              let revision=article["revisionSHA256"] as? String,PrivateStoragePaths.validSHA(revision),
              (article["sourceVersion"] as? String)==(paper["sourceVersion"] as? String),
              let resources=article["resources"] as? [[String:Any]] else {throw StorageError.invalid("离线包须来自当前已核验、完整图文导读；陈旧或不同版本材料不能冒充当前包")}
        try verifyArticleOrigin(paper:paper,article:article)
        var payloads:[(String,Data,String,String?)]=[]
        payloads.append(("paper.json",try Self.json(paper),"paper",blog))
        payloads.append(("article.json",try Self.json(article),"article",blog))
        var pdfHash:String?
        if let pdf {
            guard let path=pdf["filePath"] as? String,let hash=pdf["sha256"] as? String,PrivateStoragePaths.validSHA(hash),
                  let address=pdf["sourceURL"] as? String,address==paper["pdfURL"] as? String,Self.https(address),
                  (pdf["version"] as? String)==(paper["sourceVersion"] as? String) else {throw StorageError.invalid("离线原文地址或版本与导读不一致")}
            let file=try PrivateStoragePaths.resolve(path,directory:root,expectedSHA256:hash),data=try PrivateStoragePaths.boundedData(file,limit:100*1024*1024)
            guard Self.sha(data)==hash,pdf["bytes"] as? Int==data.count,data.starts(with:Data("%PDF-".utf8)),let document=PDFDocument(data:data),document.pageCount>0 else {throw StorageError.invalid("离线原文真实字节、大小或 PDF 格式校验失败")}
            pdfHash=hash;payloads.append(("original.pdf",data,"pdf",address))
        }
        guard resources.count<=32 else{throw StorageError.invalid("离线科学图数量超过上限")}
        var seen=Set<String>(),imageBytes=0
        for resource in resources {
            guard resource["kind"] as? String=="image",let path=resource["localPath"] as? String,let hash=resource["sha256"] as? String,PrivateStoragePaths.validSHA(hash),let address=resource["sourceURL"] as? String,Self.https(address) else {throw StorageError.invalid("离线科学图缺少实际来源或校验材料")}
            let file=try sourceFile(path,hash:hash),bytes=try PrivateStoragePaths.boundedData(file,limit:16*1024*1024)
            guard Self.sha(bytes)==hash else{throw StorageError.invalid("离线科学图原字节不符")}
            imageBytes+=bytes.count;guard imageBytes<=64*1024*1024 else{throw StorageError.invalid("离线科学图总量超过64MiB")}
            if seen.insert(hash).inserted {payloads.append(("resources/"+hash+".bin",bytes,"image",address))}
        }
        let contentHash=try Self.articleContentHash(article)
        let paperHash=Self.sha(try Self.json(paper.filter{!["offlineMode","offlinePackageID"].contains($0.key)}))
        let identity:[String:Any]=["paperSHA256":paperHash,"articleSHA256":contentHash,"paperID":paperID,"revision":revision,"sourceURL":source,"sourceVersion":article["sourceVersion"] ?? NSNull(),"pdfSHA256":pdfHash ?? "","images":seen.sorted()]
        let identifier=Self.sha(try Self.json(identity)),offline=root.appendingPathComponent("Offline",isDirectory:true)
        try makeDirectory(offline)
        let target=offline.appendingPathComponent(identifier,isDirectory:true)
        if FileManager.default.fileExists(atPath:target.path) {var result=try verifyPackage(id:identifier);result["reused"]=true;return result}
        let staging=offline.appendingPathComponent(".prepare-"+UUID().uuidString,isDirectory:true)
        try makeDirectory(staging);defer{try? FileManager.default.removeItem(at:staging)}
        var entries:[Entry]=[]
        for(path,data,role,url) in payloads {
            let file=staging.appendingPathComponent(path);try makeDirectory(file.deletingLastPathComponent());try write(data,file)
            entries.append(Entry(path:path,bytes:data.count,sha256:Self.sha(data),role:role,sourceURL:url))
        }
        let manifest=Manifest(id:identifier,paperID:paperID,title:paper["titleZh"] as? String ?? paper["title"] as? String ?? paperID,createdAt:ISO8601DateFormatter().string(from:Date()),blogURL:blog,sourceURL:source,sourceVersion:article["sourceVersion"] as? String,articleRevisionSHA256:revision,articleContentSHA256:contentHash,pdfURL:pdf?["sourceURL"] as? String,pdfSHA256:pdfHash,paperContentSHA256:paperHash,files:entries)
        try write(try JSONEncoder().encode(manifest),staging.appendingPathComponent("manifest.json"))
        _=try verifyDirectory(staging,expectedID:identifier)
        try FileManager.default.moveItem(at:staging,to:target)
        var result=try verifyPackage(id:identifier);result["reused"]=false;return result
    }
    func listPackages() throws->[[String:Any]] {
        let offline=directory.appendingPathComponent("Offline")
        guard FileManager.default.fileExists(atPath:offline.path) else{return []}
        _=try PrivateStoragePaths.checkedDirectory(offline)
        return try FileManager.default.contentsOfDirectory(at:offline,includingPropertiesForKeys:[.isDirectoryKey,.isSymbolicLinkKey]).sorted{$0.lastPathComponent<$1.lastPathComponent}.filter{!$0.lastPathComponent.hasPrefix(".prepare-")}.map { file in
            do{return try verifyPackage(id:file.lastPathComponent)}catch{return ["id":file.lastPathComponent,"status":"corrupt","message":error.localizedDescription]}
        }
    }
    func verifyPackage(id:String) throws->[String:Any] {
        guard PrivateStoragePaths.validSHA(id) else{throw StorageError.invalid("离线包身份无效")}
        let manifest=try verifyDirectory(directory.appendingPathComponent("Offline/"+id),expectedID:id)
        return ["id":id,"paperID":manifest.paperID,"title":manifest.title,"sourceVersion":manifest.sourceVersion ?? "","revisionSHA256":manifest.articleRevisionSHA256,"pdfSHA256":manifest.pdfSHA256 ?? "","files":manifest.files.count,"bytes":manifest.files.reduce(0){$0+$1.bytes},"createdAt":manifest.createdAt,"status":"verified","directory":directory.appendingPathComponent("Offline/"+id).path,"hasPDF":manifest.pdfSHA256 != nil]
    }
    /// Read an actual self-contained package. This is a reading snapshot, never a publication/model capability.
    func openPackage(id:String) throws->[String:Any] {
        guard PrivateStoragePaths.validSHA(id) else{throw StorageError.invalid("离线包身份无效")}
        let folder=directory.appendingPathComponent("Offline/"+id)
        let manifestFile=try PrivateStoragePaths.checkedFile(relative:"manifest.json",directory:folder)
        let originalManifest=try PrivateStoragePaths.boundedData(manifestFile,limit:2*1024*1024)
        let manifest=try verifyDirectory(folder,expectedID:id)
        let captured=try JSONDecoder().decode(Manifest.self,from:originalManifest)
        guard try Self.json(Self.object(manifest))==Self.json(Self.object(captured)) else{throw StorageError.invalid("离线清单在开始读取时变化，请重试")}
        let paperFile=try PrivateStoragePaths.checkedFile(relative:"paper.json",directory:folder),articleFile=try PrivateStoragePaths.checkedFile(relative:"article.json",directory:folder)
        let paperBytes=try PrivateStoragePaths.boundedData(paperFile,limit:8*1024*1024),articleBytes=try PrivateStoragePaths.boundedData(articleFile,limit:128*1024*1024)
        guard var paper=try JSONSerialization.jsonObject(with:paperBytes) as? [String:Any],var article=try JSONSerialization.jsonObject(with:articleBytes) as? [String:Any],
              manifest.files.first(where:{$0.path=="paper.json"})?.sha256==Self.sha(paperBytes),manifest.files.first(where:{$0.path=="article.json"})?.sha256==Self.sha(articleBytes) else{throw StorageError.invalid("离线读取的实际JSON与原包SHA不符")}
        var resources=article["resources"] as? [[String:Any]] ?? []
        for index in resources.indices {
            guard let hash=resources[index]["sha256"] as? String,let entry=manifest.files.first(where:{$0.role=="image" && $0.sha256==hash}) else{throw StorageError.invalid("离线图缺少相符包内文件")}
            let image=try PrivateStoragePaths.checkedFile(relative:entry.path,directory:folder)
            resources[index]["localPath"]=image.path
        }
        article["resources"]=resources
        article["offlineMode"]=true;article["offlinePackageID"]=id;article["cacheStatus"]="offline";article["websiteFreshness"]="not-checked"
        var notices=article["notices"] as? [String] ?? []
        notices.append("正在阅读离线包原始快照，来源版本\(manifest.sourceVersion ?? "未提供版本")；未联网核对网站后续修订、移除或撤稿状态，不代表当前网站最新内容。")
        if (article["markdown"] as? String)?.isEmpty != false,article["html"] is String,article["mathMLContract"] as? String != "published-html-mathml-v1" {
            notices.append("这份旧离线HTML快照未经过公式结构保真读取，部分MathML可能缺失。原包保持不变；如需核对，请对照包内原始PDF，或联网读取网站当前导读。")
        }
        article["notices"]=Array(Set(notices)).sorted()
        paper["offlineMode"]=true;paper["offlinePackageID"]=id
        var result:[String:Any]=["paper":paper,"article":article,"offlineMode":true,"packageID":id,"sourceVersion":manifest.sourceVersion ?? NSNull(),"createdAt":manifest.createdAt,"websiteFreshness":"not-checked","articleFileSHA256":Self.sha(articleBytes)]
        if let hash=manifest.pdfSHA256,let entry=manifest.files.first(where:{$0.role=="pdf" && $0.sha256==hash}),let source=manifest.pdfURL {
            let file=try PrivateStoragePaths.checkedFile(relative:entry.path,directory:folder)
            let pdf:[String:Any]=["filePath":file.path,"sha256":hash,"bytes":entry.bytes,"sourceURL":source,"version":manifest.sourceVersion ?? NSNull(),"offlineMode":true]
            result["pdf"]=pdf
        }
        // Re-read and re-hash the actual package before exposing any result; summary JSON is not a capability.
        _=try verifyDirectory(folder,expectedID:id)
        guard try PrivateStoragePaths.boundedData(manifestFile,limit:2*1024*1024)==originalManifest else{throw StorageError.invalid("离线包在读取期间变化，未安装到当前阅读空间")}
        return result
    }
    /// Creates a private capability for a later native confirmation. No payload can self-declare a safe file list.
    func cleanupPlan() async throws->[String:Any] {
        let proposed=try await calculateCleanup(),identifier=UUID().uuidString
        plans=plans.filter{Date().timeIntervalSince($0.value.createdAt)<600}
        plans[identifier]=Plan(files:proposed.0,evidence:proposed.1,createdAt:Date())
        return ["planID":identifier,"files":try proposed.0.map{try Self.object($0)},"bytes":proposed.0.reduce(0){$0+$1.bytes},"count":proposed.0.count,"requiresConfirmation":true,"scope":"仅未引用的科学图与旧导读缓存；个人来源、离线包、导出和费用均保留"]
    }
    /// Call immediately before NSWorkspace.recycle after confirmation; unknown/stale plans fail closed.
    func validateCleanupPlan(planID:String) async throws->[String:Any] {
        guard let issued=plans[planID],Date().timeIntervalSince(issued.createdAt)<600 else{throw StorageError.invalid("清理计划不存在或已过期，请重新检查")}
        let current=try await calculateCleanup()
        guard current.1==issued.evidence,try Self.json(current.0.map{try Self.object($0)})==Self.json(issued.files.map{try Self.object($0)}) else{throw StorageError.invalid("清理计划之后资料或引用发生变化，请重新检查；没有删除任何文件")}
        plans.removeValue(forKey:planID)
        return ["files":try current.0.map{try Self.object($0)},"bytes":current.0.reduce(0){$0+$1.bytes},"count":current.0.count]
    }
    private func calculateCleanup() async throws->([Candidate],String) {
        let all=try inventory()
        let personal=await store.snapshot()
        try await DesktopStore.validate(personal)
        let personalFile=try PrivateStoragePaths.checkedFile(relative:"personal.json",directory:directory),personalBytes=try PrivateStoragePaths.boundedData(personalFile,limit:32*1024*1024)
        guard let persisted=try JSONSerialization.jsonObject(with:personalBytes) as? [String:Any],try Self.json(persisted)==Self.json(personal) else{throw StorageError.invalid("个人资料尚未形成一致持久快照，未提供清理候选")}
        protectionRoots=Array(Set([directory.path,directory.resolvingSymlinksInPath().path,try Self.canonical(directory)]+(try PrivateStoragePaths.loadRoots(directory:directory)))).sorted{$0.count>$1.count}
        var protected=Set<String>(),paths=Set<String>(),owners=Set<String>(),evidence=[Self.sha(personalBytes)]
        collect(personal,hashes:&protected,paths:&paths)
        for key in ["notes","annotations","readingState"] {if let records=personal[key] as? [String:Any]{for(owner,value) in records{if !(value is NSNull){owners.insert(owner)}}}}
        for key in ["favorites","reading"] {owners.formUnion(personal[key] as? [String] ?? [])}
        for package in try listPackages() {
            guard package["status"] as? String=="verified",let id=package["id"] as? String else{throw StorageError.invalid("有离线包无法核验，保护引用范围尚不完整，未提供清理候选")}
            let manifestFile=try PrivateStoragePaths.checkedFile(relative:"Offline/"+id+"/manifest.json",directory:directory),bytes=try Data(contentsOf:manifestFile),manifest=try JSONDecoder().decode(Manifest.self,from:bytes)
            evidence.append(Self.sha(bytes));owners.insert(manifest.paperID);protected.insert(manifest.articleRevisionSHA256)
            manifest.files.forEach{protected.insert($0.sha256)}
        }
        // Read actual pending/completed archive journals, never caller-supplied protection JSON.
        for(file,path) in all where path.hasPrefix("zotero-archives/") && path.hasSuffix(".json") {
            let bytes=try PrivateStoragePaths.boundedData(file,limit:32*1024*1024)
            if path.hasSuffix(".summary.json") {
                let name=file.lastPathComponent.replacingOccurrences(of:".summary.json",with:"")
                guard UUID(uuidString:name) != nil,let summary=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],summary["archiveID"] as? String==name,
                      all.contains(where:{$0.1=="zotero-archives/"+name+".json"}) else{throw StorageError.invalid("Zotero 摘要与原归档检查点不符，未提供清理候选")}
                // Summary is only a UI projection. The companion journal below supplies actual protected references.
                continue
            }
            guard let journal=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],journal["id"] is String,journal["request"] is [String:Any] else{throw StorageError.invalid("Zotero 归档检查点损坏，未提供清理候选")}
            evidence.append(Self.sha(bytes));collect(journal,hashes:&protected,paths:&paths)
        }
        var revisions:[(URL,String,[String:Any])]=[]
        for(file,path) in all where (path.hasPrefix("PublishedLibrary/articles/") || path.hasPrefix("PublishedLibrary/article-revisions/")) && path.hasSuffix(".json") {
            let bytes=try PrivateStoragePaths.boundedData(file,limit:128*1024*1024)
            guard let article=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],let owner=article["paperID"] as? String,let revision=article["revisionSHA256"] as? String,PrivateStoragePaths.validSHA(revision),article["resources"] is [[String:Any]] else{throw StorageError.invalid("导读缓存无法核验，未提供清理候选")}
            evidence.append(Self.sha(bytes));revisions.append((file,path,article))
            if path.hasPrefix("PublishedLibrary/articles/") || owners.contains(owner) || protected.contains(revision) {collect(article,hashes:&protected,paths:&paths);protected.insert(revision)}
        }
        // References discovered from a current article may protect another old revision's resources.
        for(_,_,article) in revisions where protected.contains(article["revisionSHA256"] as? String ?? "") {collect(article,hashes:&protected,paths:&paths)}
        var candidates:[Candidate]=[]
        for(file,path) in all {
            let image=path.hasPrefix("PublishedLibrary/assets/") && file.deletingPathExtension().lastPathComponent.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil && ["png","jpg","jpeg","webp","gif","svg"].contains(file.pathExtension.lowercased())
            let revision=path.hasPrefix("PublishedLibrary/article-revisions/") && file.pathExtension=="json" && PrivateStoragePaths.validSHA(file.deletingPathExtension().lastPathComponent)
            guard image || revision else{continue}
            let hash=try PrivateStoragePaths.sha256File(file)
            guard !protected.contains(hash),!protected.contains(file.deletingPathExtension().lastPathComponent),!paths.contains(file.path),!paths.contains(file.resolvingSymlinksInPath().path) else{continue}
            if revision,let record=revisions.first(where:{$0.1==path})?.2,owners.contains(record["paperID"] as? String ?? "") || protected.contains(record["revisionSHA256"] as? String ?? "") {continue}
            candidates.append(Candidate(path:path,filePath:file.path,bytes:try size(file),sha256:hash,category:image ? "images":"revisions"))
        }
        candidates.sort{$0.path<$1.path}
        evidence.append(contentsOf:protected.sorted());evidence.append(contentsOf:paths.sorted())
        evidence.append(Self.sha(try Self.json(candidates.map{try Self.object($0)})))
        return(candidates,Self.sha(Data(evidence.sorted().joined(separator:"\n").utf8)))
    }
    private func collect(_ value:Any,hashes:inout Set<String>,paths:inout Set<String>) {
        if let string=value as? String {
            if PrivateStoragePaths.validSHA(string){hashes.insert(string)}
            for root in protectionRoots where string.hasPrefix(root+"/") {
                let relative=String(string.dropFirst(root.count+1))
                if (try? PrivateStoragePaths.path(relative)) != nil {let mapped=directory.appendingPathComponent(relative);paths.insert(mapped.path);paths.insert(mapped.resolvingSymlinksInPath().path);if let actual=try? Self.canonical(mapped){paths.insert(actual)}}
                break
            }
        }else if let object=value as? [String:Any] {for v in object.values{collect(v,hashes:&hashes,paths:&paths)}}
        else if let array=value as? [Any] {for v in array{collect(v,hashes:&hashes,paths:&paths)}}
    }
    private func verifyArticleOrigin(paper:[String:Any],article:[String:Any]) throws {
        guard let blog=paper["blogURL"] as? String else{throw StorageError.invalid("缺少实际发布页面")}
        let cachePath="PublishedLibrary/articles/"+Self.sha(Data(blog.utf8))+".json"
        if let file=try? PrivateStoragePaths.checkedFile(relative:cachePath,directory:directory),let bytes=try? PrivateStoragePaths.boundedData(file,limit:128*1024*1024),let cached=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any] {
            let fields=["paperID","html","markdown","plainText","citation","sourceURL","pdfURL","sourceVersion","revisionSHA256","resources"]
            let lhs=Dictionary(uniqueKeysWithValues:fields.map{($0,cached[$0] ?? NSNull())}),rhs=Dictionary(uniqueKeysWithValues:fields.map{($0,article[$0] ?? NSNull())})
            guard try Self.json(lhs)==Self.json(rhs),cached["isStale"] as? Bool != true else{throw StorageError.invalid("离线导读与本机真实发布缓存不一致")}
            return
        }
        if let seed,let sampleFile=try? trustedSeedFile(seed.appendingPathComponent("sample.json").path),let bytes=try? PrivateStoragePaths.boundedData(sampleFile,limit:8*1024*1024),let sample=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any],let record=sample["paper"] as? [String:Any],let markdown=sample["articleMarkdown"] as? String,
           "arxiv:"+(record["id"] as? String ?? "")==article["paperID"] as? String,record["blogUrl"] as? String==blog,record["absUrl"] as? String==article["sourceURL"] as? String,record["pdfUrl"] as? String==article["pdfURL"] as? String,markdown==article["plainText"] as? String,Self.sha(Data(markdown.utf8))==article["revisionSHA256"] as? String {
            var expected=markdown
            let figures=sample["figures"] as? [[String:Any]] ?? [],resources=article["resources"] as? [[String:Any]] ?? []
            guard resources.count==figures.count,article["html"] as? String=="",paper["title"] as? String==record["title"] as? String,
                  let citation=article["citationSidecar"],let originalCitation=sample["citation"],try Self.json(citation)==Self.json(originalCitation) else{throw StorageError.invalid("种子导读或实际书目内容不符")}
            for (index,figure) in figures.enumerated() {
                guard let name=figure["src"] as? String,!name.contains("/"),!name.contains(".."),let hash=figure["sha256"] as? String,resources[index]["sha256"] as? String==hash,
                      resources[index]["sourceURL"] as? String==figure["sourceUrl"] as? String else{throw StorageError.invalid("种子图与真实样稿清单不符")}
                let image=try trustedSeedFile(seed.appendingPathComponent("assets/"+name).path),data=try PrivateStoragePaths.boundedData(image,limit:16*1024*1024)
                guard Self.sha(data)==hash else{throw StorageError.invalid("种子图原字节不符")}
                let mime=data.starts(with:[0x89,0x50,0x4e,0x47]) ? "image/png":data.starts(with:[0xff,0xd8,0xff]) ? "image/jpeg":""
                guard !mime.isEmpty else{throw StorageError.invalid("种子图类型未获支持")}
                expected=expected.replacingOccurrences(of:"](\(name))",with:"](data:\(mime);base64,\(data.base64EncodedString()))")
            }
            guard article["markdown"] as? String==expected else{throw StorageError.invalid("种子完整正文与真实材料不符")}
            return
        }
        throw StorageError.invalid("未找到相符的真实网站缓存或应用内种子；普通JSON不能自行授予离线来源资格")
    }
    private func sourceFile(_ path:String,hash:String) throws->URL {
        if let seed,path.hasPrefix(seed.path+"/") {let file=try trustedSeedFile(path);guard try PrivateStoragePaths.sha256File(file)==hash else{throw StorageError.invalid("种子科学图不符")};return file}
        return try PrivateStoragePaths.resolve(path,directory:directory,expectedSHA256:hash)
    }
    private func trustedSeedFile(_ path:String)throws->URL {
        guard let seed,path.hasPrefix(seed.path+"/") else{throw StorageError.invalid("种子路径越界")}
        return try PrivateStoragePaths.checkedFile(relative:String(path.dropFirst(seed.path.count+1)),directory:seed)
    }
    private func verifyDirectory(_ folder:URL,expectedID:String)throws->Manifest {
        _=try PrivateStoragePaths.checkedDirectory(folder)
        let manifestFile=try PrivateStoragePaths.checkedFile(relative:"manifest.json",directory:folder),bytes=try PrivateStoragePaths.boundedData(manifestFile,limit:2*1024*1024),manifest=try JSONDecoder().decode(Manifest.self,from:bytes)
        guard ["paperdigest-offline-package-v1","paperdigest-offline-package-v2"].contains(manifest.contract),manifest.id==expectedID,!manifest.paperID.isEmpty,Self.https(manifest.blogURL),Self.https(manifest.sourceURL),PrivateStoragePaths.validSHA(manifest.articleRevisionSHA256),manifest.files.count>=2,manifest.files.count<=35 else{throw StorageError.invalid("离线包清单合同无效")}
        var names=Set<String>()
        for entry in manifest.files {
            guard names.insert(entry.path).inserted,PrivateStoragePaths.validSHA(entry.sha256),entry.bytes>=0 else{throw StorageError.invalid("离线包清单有重复或无效文件")}
            let limits=["paper":8*1024*1024,"article":128*1024*1024,"pdf":100*1024*1024,"image":16*1024*1024]
            guard let limit=limits[entry.role],entry.bytes<=limit,
                  (entry.role=="paper" && entry.path=="paper.json") || (entry.role=="article" && entry.path=="article.json") || (entry.role=="pdf" && entry.path=="original.pdf") || (entry.role=="image" && entry.path=="resources/"+entry.sha256+".bin"),
                  entry.sourceURL.map(Self.https)==true else{throw StorageError.invalid("离线包文件角色、来源或大小无效")}
            let file=try PrivateStoragePaths.checkedFile(relative:entry.path,directory:folder)
            guard try size(file)==entry.bytes,try PrivateStoragePaths.sha256File(file)==entry.sha256 else{throw StorageError.invalid("离线包文件SHA或大小损坏，原包保留")}
        }
        guard names.contains("paper.json"),names.contains("article.json"),manifest.files.filter({$0.role=="pdf"}).count==(manifest.pdfSHA256==nil ? 0:1),manifest.pdfSHA256==nil || manifest.files.contains(where:{$0.role=="pdf" && $0.path=="original.pdf" && $0.sha256==manifest.pdfSHA256}) else{throw StorageError.invalid("离线包缺少实际材料")}
        let articleFile=try PrivateStoragePaths.checkedFile(relative:"article.json",directory:folder),paperFile=try PrivateStoragePaths.checkedFile(relative:"paper.json",directory:folder)
        guard let article=try JSONSerialization.jsonObject(with:PrivateStoragePaths.boundedData(articleFile,limit:128*1024*1024)) as? [String:Any],let paper=try JSONSerialization.jsonObject(with:PrivateStoragePaths.boundedData(paperFile,limit:8*1024*1024)) as? [String:Any],
              article["paperID"] as? String==manifest.paperID,(paper["id"] as? String ?? paper["paperID"] as? String)==manifest.paperID,
              paper["blogURL"] as? String==manifest.blogURL,article["sourceURL"] as? String==manifest.sourceURL,
              (paper["sourceURL"] as? String ?? manifest.blogURL)==manifest.sourceURL,
              paper["sourceVersion"] as? String==manifest.sourceVersion,article["pdfURL"] as? String==paper["pdfURL"] as? String,
              manifest.pdfSHA256==nil ? manifest.pdfURL==nil:manifest.pdfURL==paper["pdfURL"] as? String,
              article["sourceVersion"] as? String==manifest.sourceVersion,article["revisionSHA256"] as? String==manifest.articleRevisionSHA256,
              article["completeOffline"] as? Bool==true,article["isStale"] as? Bool != true else{throw StorageError.invalid("离线清单与实际导读来源不一致")}
        guard let resources=article["resources"] as? [[String:Any]],manifest.files.filter({$0.role=="image"}).count==Set(resources.compactMap{$0["sha256"] as? String}).count else{throw StorageError.invalid("离线包科学图数量与导读不符")}
        for entry in manifest.files {
            if entry.role=="pdf",entry.sourceURL != manifest.pdfURL{throw StorageError.invalid("离线原文清单来源不符")}
            if entry.role=="image",!resources.contains(where:{$0["sha256"] as? String==entry.sha256 && $0["sourceURL"] as? String==entry.sourceURL}){throw StorageError.invalid("离线科学图清单来源不符")}
        }
        let images=manifest.files.filter{$0.role=="image"}.map(\.sha256).sorted()
        guard try Self.articleContentHash(article)==manifest.articleContentSHA256 else{throw StorageError.invalid("离线导读元数据指纹不符")}
        var identity:[String:Any]=["articleSHA256":manifest.articleContentSHA256,"paperID":manifest.paperID,"revision":manifest.articleRevisionSHA256,"sourceURL":manifest.sourceURL,"sourceVersion":manifest.sourceVersion ?? NSNull(),"pdfSHA256":manifest.pdfSHA256 ?? "","images":images]
        if manifest.contract=="paperdigest-offline-package-v2" {
            let paperHash=Self.sha(try Self.json(paper.filter{!["offlineMode","offlinePackageID"].contains($0.key)}))
            guard paperHash==manifest.paperContentSHA256 else{throw StorageError.invalid("离线目录元数据指纹不符")};identity["paperSHA256"]=paperHash
        }else{guard manifest.paperContentSHA256==nil else{throw StorageError.invalid("旧离线合同含不支持的新身份字段")}}
        guard Self.sha(try Self.json(identity))==manifest.id else{throw StorageError.invalid("离线包身份与实际版本指纹不符")}
        var enumerationError:Error?
        guard let actual=FileManager.default.enumerator(at:folder,includingPropertiesForKeys:[.isRegularFileKey,.isSymbolicLinkKey,.isDirectoryKey],options:[],errorHandler:{_,error in enumerationError=error;return false}) else{throw StorageError.invalid("离线包无法枚举")}
        for case let file as URL in actual {let info=try file.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey,.isDirectoryKey]);guard info.isSymbolicLink != true,info.isRegularFile==true || info.isDirectory==true else{throw StorageError.invalid("离线包不允许符号链接或特殊文件")};if info.isRegularFile==true{let base=try Self.canonical(folder),actual=try Self.canonical(file);guard actual.hasPrefix(base+"/") else{throw StorageError.invalid("离线包枚举路径越界")};let path=String(actual.dropFirst(base.count+1));guard path=="manifest.json" || names.contains(path) else{throw StorageError.invalid("离线包存在未登记文件："+path)}}}
        if let enumerationError{throw enumerationError}
        return manifest
    }
    private func inventory() throws->[(URL,String)] {
        let root=try PrivateStoragePaths.checkedDirectory(directory),fm=FileManager.default
        var failure:Error?
        guard let enumerator=fm.enumerator(at:root,includingPropertiesForKeys:[.isRegularFileKey,.isSymbolicLinkKey,.isDirectoryKey],options:[],errorHandler:{_,error in failure=error;return false}) else{throw StorageError.invalid("私有资料目录无法枚举")}
        var result:[(URL,String)]=[]
        for case let file as URL in enumerator {
            let info=try file.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey,.isDirectoryKey])
            guard info.isSymbolicLink != true else{throw StorageError.invalid("私有资料含符号链接，未生成容量或清理结论")}
            if info.isDirectory==true{continue}
            guard info.isRegularFile==true else{throw StorageError.invalid("私有资料含非普通文件")}
            let base=try Self.canonical(root),actual=try Self.canonical(file)
            guard actual.hasPrefix(base+"/") else{throw StorageError.invalid("容量枚举路径越界")}
            let path=String(actual.dropFirst(base.count+1));_=try PrivateStoragePaths.checkedFile(relative:path,directory:root)
            result.append((file,path));guard result.count<=100000 else{throw StorageError.invalid("私有资料文件数量超过检查上限")}
        }
        if let failure{throw failure};return result
    }
    private func makeDirectory(_ file:URL)throws {
        let root=try PrivateStoragePaths.checkedDirectory(directory)
        guard file.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path+"/") else{throw StorageError.invalid("写入路径越界")}
        var cursor=root
        for component in file.path.dropFirst(root.path.count+1).split(separator:"/") {
            guard component != ".",component != ".." else{throw StorageError.invalid("写入路径穿越")};cursor.appendPathComponent(String(component))
            if FileManager.default.fileExists(atPath:cursor.path){_=try PrivateStoragePaths.checkedDirectory(cursor)}else{if (try? cursor.resourceValues(forKeys:[.isSymbolicLinkKey]).isSymbolicLink)==true{throw StorageError.invalid("写入路径不能为符号链接")};try FileManager.default.createDirectory(at:cursor,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])}
        }
    }
    private func write(_ bytes:Data,_ file:URL)throws {try bytes.write(to:file,options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)}
    private func size(_ file:URL)throws->Int {try file.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? 0}
    private static func canonical(_ url:URL)throws->String {
        guard let value=realpath(url.path,nil) else{throw StorageError.invalid("本机路径无法解析")}
        defer{free(value)};return String(cString:value)
    }
    private static func articleContentHash(_ article:[String:Any])throws->String {
        var content=article
        for key in ["fetchedAt","catalogEpoch","cacheStatus","isStale","validationAttemptedAt","expectedSourceVersion","notices"]{content.removeValue(forKey:key)}
        if let resources=content["resources"] as? [[String:Any]] {content["resources"]=resources.map{r in r.filter{$0.key != "localPath"}}}
        return sha(try json(content))
    }
    private static func https(_ text:String)->Bool {guard let u=URL(string:text),u.scheme=="https",u.host != nil,u.user==nil,u.password==nil else{return false};return true}
    private static func sha(_ bytes:Data)->String {PrivateStoragePaths.sha256(bytes)}
    private static func json(_ value:Any)throws->Data {try JSONSerialization.data(withJSONObject:value,options:.sortedKeys)}
    private static func object<T:Encodable>(_ value:T)throws->[String:Any] {try JSONSerialization.jsonObject(with:JSONEncoder().encode(value)) as! [String:Any]}
    private static func category(_ path:String)->String {
        if path.hasPrefix("PublishedLibrary/articles/"){return "articles"};if path.hasPrefix("PublishedLibrary/pdf/"){return "pdf"};if path.hasPrefix("PublishedLibrary/assets/"){return "images"};if path.hasPrefix("PublishedLibrary/article-revisions/"){return "revisions"};if path.hasPrefix("PublishedLibrary/"){return "catalog"}
        if path.hasPrefix("Offline/"){return "offline"};if path.hasPrefix("Imports/"){return "imports"};if path.hasPrefix("Exports/"){return "exports"};if path.hasPrefix("ModelUsage/"){return "modelUsage"};if path.hasPrefix("zotero-archives/"){return "zotero"};if path=="personal.json"{return "personal"};return "other"
    }
}
