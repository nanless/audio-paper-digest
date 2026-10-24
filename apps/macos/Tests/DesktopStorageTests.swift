import Foundation
import CryptoKit
import Darwin

@main struct DesktopStorageTests {
    @MainActor static func main() async {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("DesktopStorageTests-"+UUID().uuidString)
        defer{try? FileManager.default.removeItem(at:root)}
        var checks=0
        func expect(_ condition:Bool,_ message:String)throws{checks+=1;if !condition{throw DesktopError.message("TEST: "+message)}}
        func rejects(_ label:String,_ action:()async throws->Void)async throws{var failed=false;do{try await action()}catch{failed=true};try expect(failed,label)}
        func hash(_ data:Data)->String{PrivateStoragePaths.sha256(data)}
        func json(_ value:Any)throws->Data{try JSONSerialization.data(withJSONObject:value,options:.sortedKeys)}
        func put(_ path:String,_ bytes:Data)throws{let file=root.appendingPathComponent(path);try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true);try bytes.write(to:file)}
        func snapshot()throws->[String:Data]{let files=FileManager.default.enumerator(at:root,includingPropertiesForKeys:[.isRegularFileKey])!.allObjects as! [URL];return try Dictionary(uniqueKeysWithValues:files.filter{(try? $0.resourceValues(forKeys:[.isRegularFileKey]).isRegularFile)==true}.map{(String($0.path.dropFirst({let p=realpath(root.path,nil)!;defer{free(p)};return String(cString:p).count+1}())),try Data(contentsOf:$0))})}
        do {
            let store=try DesktopStore(directory:root),storage=DesktopStorage(directory:root,store:store)
            let pdfBytes=try Data(contentsOf:URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf")),pdfSHA=hash(pdfBytes)
            let imageBytes=Data([0x89,0x50,0x4e,0x47,1,2,3,4]),imageSHA=hash(imageBytes),imagePath="PublishedLibrary/assets/"+imageSHA+".png",pdfPath="PublishedLibrary/pdf/"+pdfSHA+".pdf"
            try put(imagePath,imageBytes);try put(pdfPath,pdfBytes)
            let blog="https://example.org/blog/micla/",source="https://arxiv.org/abs/2610.27491v1",pdfURL="https://arxiv.org/pdf/2610.27491v1.pdf",owner="arxiv:2610.27491"
            let paper:[String:Any]=["id":owner,"title":"MiCLA","blogURL":blog,"sourceURL":source,"pdfURL":pdfURL,"sourceVersion":"2610.27491v1"]
            var article:[String:Any]=["paperID":owner,"html":"<p>真实本机测试正文</p>","plainText":"真实本机测试正文","citation":["paperKey":owner],"sourceURL":source,"pdfURL":pdfURL,"sourceVersion":"2610.27491v1","revisionSHA256":hash(Data("实际导读修订".utf8)),"completeOffline":true,"isStale":false,"resources":[["kind":"image","sourceURL":"https://example.org/blog/figure.png","localPath":root.appendingPathComponent(imagePath).path,"sha256":imageSHA]]]
            let cachePath="PublishedLibrary/articles/"+hash(Data(blog.utf8))+".json"
            try put(cachePath,json(article))
            let pdf:[String:Any]=["filePath":root.appendingPathComponent(pdfPath).path,"sha256":pdfSHA,"bytes":pdfBytes.count,"version":"2610.27491v1","sourceURL":pdfURL]
            let original=try snapshot(),registered=try await storage.register(paper:paper,article:article,pdf:pdf),identifier=registered["id"] as! String
            try expect(registered["status"] as? String=="verified" && registered["hasPDF"] as? Bool==true,"offline package validates real PDF and complete article")
            for(path,bytes) in original{try expect(try Data(contentsOf:root.appendingPathComponent(path))==bytes,"register preserves original private bytes "+path)}
            try expect(try Data(contentsOf:root.appendingPathComponent("Offline/"+identifier+"/original.pdf"))==pdfBytes,"offline PDF retains original bytes")
            try expect(try Data(contentsOf:root.appendingPathComponent("Offline/"+identifier+"/article.json"))==json(article),"offline article retains supplied actual canonical values")
            let beforeRepeat=try snapshot(),repeated=try await storage.register(paper:paper,article:article,pdf:pdf)
            try expect(repeated["reused"] as? Bool==true && repeated["id"] as? String==identifier && (try snapshot())==beforeRepeat,"same package registration is idempotent without extra files")
            try expect(try await storage.listPackages().count==1,"verified offline package listed")
            let beforeLegacyOpen=try snapshot(),legacyOpen=try await storage.openPackage(id:identifier),legacyArticle=legacyOpen["article"] as! [String:Any]
            try expect((legacyArticle["notices"] as? [String] ?? []).contains(where:{$0.contains("旧离线HTML快照")}),"legacy HTML snapshot discloses unverified formula structure")
            try expect(try snapshot()==beforeLegacyOpen,"legacy formula warning is a read-only projection preserving every original byte")
            var invalid=article;invalid["isStale"]=true
            try await rejects("stale guide never grants current offline package"){_=try await storage.register(paper:paper,article:invalid,pdf:pdf)}
            invalid=article;invalid["plainText"]="伪造的普通JSON正文"
            try await rejects("ordinary supplied JSON cannot self-grant origin"){_=try await storage.register(paper:paper,article:invalid,pdf:pdf)}
            var wrongPDF=pdf;wrongPDF["version"]="2610.27491v2"
            try await rejects("mismatched PDF version rejected"){_=try await storage.register(paper:paper,article:article,pdf:wrongPDF)}
            article["citation"]=["paperKey":owner,"doi":"metadata-correction-fixture"];try put(cachePath,json(article))
            let next=try await storage.register(paper:paper,article:article,pdf:pdf)
            let updatedPackages=try await storage.listPackages()
            try expect(next["id"] as? String != identifier && updatedPackages.count==2,"changed actual metadata retains distinct immutable offline revision")
            var metadataOnly=paper;metadataOnly["titleZh"]="仅目录译题更正";metadataOnly["score"]=8.7;metadataOnly["tags"]=["目录新分类"]
            let metadataPackage=try await storage.register(paper:metadataOnly,article:article,pdf:pdf)
            try expect(metadataPackage["id"] as? String != next["id"] as? String,"paper-only title score and taxonomy changes create a distinct snapshot")
            let metadataOpened=try await storage.openPackage(id:metadataPackage["id"] as! String)
            try expect((metadataOpened["paper"] as? [String:Any])?["titleZh"] as? String=="仅目录译题更正","metadata-only snapshot reads its own corrected paper fields")
            var formulaVerified=article;formulaVerified["mathMLContract"]="published-html-mathml-v1";try put(cachePath,json(formulaVerified))
            let verifiedPackage=try await storage.register(paper:paper,article:formulaVerified,pdf:pdf)
            let verifiedOpen=try await storage.openPackage(id:verifiedPackage["id"] as! String),verifiedArticle=verifiedOpen["article"] as! [String:Any]
            try expect(!(verifiedArticle["notices"] as? [String] ?? []).contains(where:{$0.contains("旧离线HTML快照")}),"formula-verified HTML snapshot does not receive legacy warning")
            for emptyMarkdown:Any in ["",NSNull()] {
                var legacyFallback=article;legacyFallback["markdown"]=emptyMarkdown;try put(cachePath,json(legacyFallback))
                let fallbackPackage=try await storage.register(paper:paper,article:legacyFallback,pdf:pdf)
                let fallbackOpen=try await storage.openPackage(id:fallbackPackage["id"] as! String),fallbackArticle=fallbackOpen["article"] as! [String:Any]
                try expect((fallbackArticle["notices"] as? [String] ?? []).contains(where:{$0.contains("旧离线HTML快照")}),"empty or null Markdown follows actual legacy HTML render branch")
            }
            try expect(try Data(contentsOf:root.appendingPathComponent("Offline/"+identifier+"/article.json"))==beforeLegacyOpen["Offline/"+identifier+"/article.json"],"new formula snapshot retains original legacy package bytes")
            let orphan=Data("orphan disposable image".utf8),orphanSHA=hash(orphan),orphanPath="PublishedLibrary/assets/"+orphanSHA+".png"
            try put(orphanPath,orphan)
            let usedImage=Data("referenced by prior study".utf8),usedSHA=hash(usedImage),usedPath="PublishedLibrary/assets/"+usedSHA+".png"
            try put(usedPath,usedImage)
            let usedRevision=hash(Data("prior study revision".utf8)),unusedRevision=hash(Data("unused revision".utf8))
            let protectedRevision:[String:Any]=["paperID":"arxiv:study","revisionSHA256":usedRevision,"resources":[["kind":"image","sourceURL":"https://example.org/old.png","localPath":root.appendingPathComponent(usedPath).path,"sha256":usedSHA]],"html":"<p>old used</p>"]
            let disposableRevision:[String:Any]=["paperID":"arxiv:unused","revisionSHA256":unusedRevision,"resources":[],"html":"<p>old unused</p>"]
            let usedRevisionPath="PublishedLibrary/article-revisions/test/"+hash(try json(protectedRevision))+".json",unusedRevisionPath="PublishedLibrary/article-revisions/test/"+hash(try json(disposableRevision))+".json"
            try put(usedRevisionPath,json(protectedRevision));try put(unusedRevisionPath,json(disposableRevision))
            try store.appendSession(["id":UUID().uuidString,"paperID":"arxiv:study","status":"failed","source":["revision":usedRevision,"pdfSHA":pdfSHA]])
            let journalImage=Data("actual pending archive reference".utf8),journalSHA=hash(journalImage),journalPath="PublishedLibrary/assets/"+journalSHA+".png"
            try put(journalPath,journalImage);try put("zotero-archives/actual.json",json(["id":UUID().uuidString,"request":["guideHTMLPath":root.appendingPathComponent(journalPath).path],"steps":[["role":"guide","verified":false]]]))
            for(path,data) in ["Imports/original.pdf":pdfBytes,"Exports/source.html":Data("original export".utf8),"ModelUsage/actual-usage.json":Data("actual immutable cost event".utf8)] {try put(path,data)}
            let beforePlan=try snapshot(),plan=try await storage.cleanupPlan(),files=plan["files"] as! [[String:Any]],candidates=Set(files.compactMap{$0["path"] as? String})
            try expect(candidates==Set([orphanPath,unusedRevisionPath]),"cleanup plan only lists unreferenced image and old revision")
            try expect(plan["requiresConfirmation"] as? Bool==true && plan["bytes"] as? Int==orphan.count+(try json(disposableRevision)).count,"cleanup byte estimate exact and confirmation required")
            try expect(try snapshot()==beforePlan,"capacity planning never modifies any private bytes")
            let capacity=try await storage.capacity(),actualBytes=beforePlan.values.reduce(0){$0+$1.count}
            try expect(capacity["totalBytes"] as? Int==actualBytes,"capacity equals actual regular-file bytes")
            let categories=capacity["categories"] as! [[String:Any]]
            try expect(categories.first{$0["key"] as? String=="modelUsage"}?["bytes"] as? Int==beforePlan["ModelUsage/actual-usage.json"]!.count,"fee material accounted separately")
            let checked=try await storage.validateCleanupPlan(planID:plan["planID"] as! String)
            try expect(checked["count"] as? Int==2 && (try snapshot())==beforePlan,"native confirmation validation returns actual files without deletion")
            try await rejects("ordinary JSON or guessed plan ID cannot grant deletion list"){_=try await storage.validateCleanupPlan(planID:UUID().uuidString)}
            let oldPlan=try await storage.cleanupPlan();try store.updateSettings(["font":19])
            try await rejects("changed real personal state invalidates issued plan"){_=try await storage.validateCleanupPlan(planID:oldPlan["planID"] as! String)}
            let packagePDF=root.appendingPathComponent("Offline/"+identifier+"/original.pdf"),saved=try Data(contentsOf:packagePDF)
            try Data("bad PDF".utf8).write(to:packagePDF)
            try await rejects("offline PDF corruption detected"){_=try await storage.verifyPackage(id:identifier)}
            try await rejects("corrupt offline authority blocks cleanup, does not skip its protection"){_=try await storage.cleanupPlan()}
            try saved.write(to:packagePDF)
            let manifestFile=root.appendingPathComponent("Offline/"+identifier+"/manifest.json"),manifestOriginal=try Data(contentsOf:manifestFile)
            var manifest=try JSONSerialization.jsonObject(with:manifestOriginal) as! [String:Any];manifest["sourceURL"]="https://evil.example/other"
            try json(manifest).write(to:manifestFile)
            try await rejects("manifest provenance tamper rejected against actual article"){_=try await storage.verifyPackage(id:identifier)}
            try manifestOriginal.write(to:manifestFile)
            manifest=try JSONSerialization.jsonObject(with:manifestOriginal) as! [String:Any];manifest["pdfURL"]="https://evil.example/fake.pdf"
            try json(manifest).write(to:manifestFile)
            try await rejects("manifest PDF provenance cannot be swapped independently"){_=try await storage.verifyPackage(id:identifier)}
            try manifestOriginal.write(to:manifestFile)
            manifest=try JSONSerialization.jsonObject(with:manifestOriginal) as! [String:Any]
            var entries=manifest["files"] as! [[String:Any]];entries[0]["role"]="arbitrary-private-file";manifest["files"]=entries
            try json(manifest).write(to:manifestFile)
            try await rejects("unknown file roles cannot grant offline package authority"){_=try await storage.verifyPackage(id:identifier)}
            try manifestOriginal.write(to:manifestFile)
            try await rejects("package traversal rejected"){_=try await storage.verifyPackage(id:"../personal.json")}
            let symlink=root.appendingPathComponent("PublishedLibrary/assets/symlink.png")
            try FileManager.default.createSymbolicLink(at:symlink,withDestinationURL:root.appendingPathComponent("personal.json"))
            try await rejects("symlink prevents misleading capacity result"){_=try await storage.capacity()}
            try await rejects("symlink prevents cleanup qualification"){_=try await storage.cleanupPlan()}
            try FileManager.default.removeItem(at:symlink)
            try expect(try await storage.verifyPackage(id:identifier)["status"] as? String=="verified","restored original bytes recover package validity without network")
            let seed=URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research")
            let realLibrary=try LibraryService(dataDirectory:root,seedDirectory:seed,transport:{_,_ in throw DesktopError.message("No network in storage tests")})
            let realPaper=await realLibrary.list().first{$0.id==owner}!
            let seedPaper=try JSONSerialization.jsonObject(with:JSONEncoder().encode(realPaper)) as! [String:Any]
            let seedArticle=try await realLibrary.handle(command:"library.article",payload:["paperID":owner]),seedPDF=try await realLibrary.handle(command:"library.downloadPDF",payload:["paperID":owner])
            let seededStorage=DesktopStorage(directory:root,store:store,bundledSeedDirectory:seed)
            let actualPackage=try await seededStorage.register(paper:seedPaper,article:seedArticle,pdf:seedPDF)
            try expect(actualPackage["status"] as? String=="verified" && actualPackage["hasPDF"] as? Bool==true,"actual LibraryService MiCLA seed creates complete offline package without network")
            var forgedSeed=seedArticle;forgedSeed["markdown"]="伪造的种子正文"
            try await rejects("plain seed-shaped JSON cannot replace genuine Markdown"){_=try await seededStorage.register(paper:seedPaper,article:forgedSeed,pdf:seedPDF)}
            let actualID=actualPackage["id"] as! String,actualDirectory=root.appendingPathComponent("Offline/"+actualID)
            let beforeOfflineOpen=try snapshot()
            try FileManager.default.removeItem(at:root.appendingPathComponent("PublishedLibrary"))
            let detached=DesktopStorage(directory:root,store:store,bundledSeedDirectory:root.appendingPathComponent("missing-bundle-seed"))
            let opened=try await detached.openPackage(id:actualID),openedPaper=opened["paper"] as! [String:Any],openedArticle=opened["article"] as! [String:Any],openedPDF=opened["pdf"] as! [String:Any]
            try expect(opened["offlineMode"] as? Bool==true && openedPaper["id"] as? String==owner && opened["websiteFreshness"] as? String=="not-checked","removed website record still opens actual package with explicit offline identity")
            try expect(openedArticle["plainText"] as? String==seedArticle["plainText"] as? String && openedArticle["revisionSHA256"] as? String==seedArticle["revisionSHA256"] as? String && openedArticle["fetchedAt"] as? String==seedArticle["fetchedAt"] as? String,"offline open retains original scientific text revision and retrieval time")
            try expect((openedArticle["markdown"] as? String ?? "").contains("data:image/png;base64,") && (openedArticle["notices"] as? [String] ?? []).contains(where:{$0.contains("不代表当前网站最新")}),"self-contained real MiCLA graphics remain readable with truthful freshness notice")
            try expect(!(openedArticle["notices"] as? [String] ?? []).contains(where:{$0.contains("旧离线HTML快照")}),"Markdown snapshot does not receive HTML parser warning")
            try expect(openedPDF["sha256"] as? String==pdfSHA && openedPDF["version"] as? String=="2610.27491v1" && (openedPDF["filePath"] as? String ?? "").contains("/Offline/"+actualID+"/"),"offline PDF returns actual package path precise source version and SHA")
            for resource in openedArticle["resources"] as! [[String:Any]] {let path=resource["localPath"] as! String;try expect(path.contains("/Offline/"+actualID+"/resources/") && (try PrivateStoragePaths.sha256File(URL(fileURLWithPath:path)))==resource["sha256"] as? String,"detached package resource points to actual verified package bytes")}
            let afterOfflineOpen=try snapshot()
            for(path,bytes) in beforeOfflineOpen where !path.hasPrefix("PublishedLibrary/"){try expect(afterOfflineOpen[path]==bytes,"offline reading does not modify existing package or personal bytes "+path)}
            let detachedArticle=actualDirectory.appendingPathComponent("article.json"),detachedOriginal=try Data(contentsOf:detachedArticle)
            try Data("{\"paperID\":\"forged\"}".utf8).write(to:detachedArticle)
            try await rejects("offline open rejects actual article byte tamper"){_=try await detached.openPackage(id:actualID)}
            try detachedOriginal.write(to:detachedArticle)
            let detachedPDF=actualDirectory.appendingPathComponent("original.pdf"),detachedPDFBytes=try Data(contentsOf:detachedPDF)
            try Data("bad".utf8).write(to:detachedPDF)
            try await rejects("offline open rejects actual PDF byte tamper"){_=try await detached.openPackage(id:actualID)}
            try detachedPDFBytes.write(to:detachedPDF)
            try expect(try await detached.openPackage(id:actualID)["offlineMode"] as? Bool==true,"restoring exact package bytes recovers offline reading without website or bundle")
            print("DesktopStorage PASS \(checks) checks; real temporary tree, immutable source bytes, zero deletion/network/model/credential requests")
        }catch{fputs("DesktopStorage FAIL after \(checks) checks: \(error.localizedDescription)\n",stderr);exit(1)}
    }
}
