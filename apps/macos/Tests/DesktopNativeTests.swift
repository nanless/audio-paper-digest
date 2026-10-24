// Compile all Sources with -D PAPER_DIGEST_TESTS. No application launch, windows,
// permission dialogs, real Keychain access, model requests, or personal profile IO.
import AppKit
import PDFKit
import Foundation
import Darwin

private struct NativeTestFailure: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
private struct NoNativeCredentials: ZoteroCredentialStore {
    func load(serverID: String) throws -> Data? { nil }
    func save(_ data: Data, serverID: String) throws { throw NativeTestFailure(message:"No credential writes in native integration tests") }
    func remove(serverID: String) throws {}
}

@main struct DesktopNativeTests {
    @MainActor static func main() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("paper-digest-native-tests-"+UUID().uuidString,isDirectory:true)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        defer { try? FileManager.default.removeItem(at:root) }
        let repository=URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
        let publicPDF=repository.appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf")
        let original=try Data(contentsOf:publicPDF)
        let expectedSHA="01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c"
        guard sha256(original)==expectedSHA else { throw NativeTestFailure(message:"Public MiCLA PDF content changed") }
        let pdf=root.appendingPathComponent("public-micla.pdf");try original.write(to:pdf)
        guard let document=PDFDocument(url:pdf),document.pageCount==13 else{throw NativeTestFailure(message:"Real MiCLA PDF must load all 13 pages")}
        _=NSApplication.shared
        let app=PaperDigestApp()
        app.directory=root;app.store=try DesktopStore(directory:root)
        let emptySeed=root.appendingPathComponent("empty-seed",isDirectory:true);try FileManager.default.createDirectory(at:emptySeed,withIntermediateDirectories:true)
        app.library=try LibraryService(dataDirectory:root,seedDirectory:emptySeed,transport:{_,_ in throw NativeTestFailure(message:"No network permitted in native integration tests")})
        app.zotero=ZoteroService(dataDirectory:root,credentialStore:NoNativeCredentials())
        app.model=ModelService(directory:root,store:app.store,keyProvider:{nil})
        let owner="arxiv:2610.27491",version="2610.27491v1"
        app.currentPaperID=owner;app.currentPaper=["id":owner,"title":"MiCLA","sourceVersion":version]
        app.currentPDFPath=pdf;app.currentPDFSHA=expectedSHA;app.pdfOwner=owner;app.pdfVersion=version
        app.pdfView.frame=NSRect(x:0,y:0,width:700,height:850);app.pdfView.document=document
        let plain=(document.string ?? "")
        let revision=sha256(Data(plain.utf8))
        app.currentArticle=["paperID":owner,"plainText":plain,"sourceURL":"https://nanless.github.io/audio-paper-digest-blog/posts/2026-10-21-micla-mixture-to-constituent-latent-alignment-for-2610-27491/","revisionSHA256":revision]
        var passed=0, failures:[String]=[]
        func require(_ value:Bool,_ message:String) throws {if !value{throw NativeTestFailure(message:message)}}
        func check(_ label:String,_ body:() throws->Void){do{try body();passed+=1;print("PASS "+label)}catch{failures.append(label+": "+error.localizedDescription);print("FAIL "+label+": "+error.localizedDescription)}}
        func checkAsync(_ label:String,_ body:() async throws->Void) async {do{try await body();passed+=1;print("PASS "+label)}catch{failures.append(label+": "+error.localizedDescription);print("FAIL "+label+": "+error.localizedDescription)}}
        func rejectsAsync(_ action:() async throws->Void) async throws {do{try await action()}catch{return};throw NativeTestFailure(message:"Expected native gate rejection")}
        func rejects(_ action:() throws->Void) throws {do{try action()}catch{return};throw NativeTestFailure(message:"Expected rejection before any paid request")}
        func source(_ scope:String,_ more:[String:Any]=[:]) throws->[String:Any]{var p=more;p["scope"]=scope;return try app.modelSource(p)}
        func assertIdentity(_ value:[String:Any],_ pages:[Int]) throws {
            try require(value["paperID"] as? String==owner,"source paper owner")
            try require(value["pdfSHA"] as? String==expectedSHA,"source actual PDF SHA")
            try require(value["sourceVersion"] as? String==version,"source version")
            try require(value["pages"] as? [Int]==pages,"physical source page range")
            try require(value["truncated"] as? Bool != true,"source not silently truncated")
        }
        check("real PDF current physical page, identity and extracted text") {
            app.pdfView.go(to:document.page(at:4)!)
            let value=try source("page");try assertIdentity(value,[5])
            let expected=document.page(at:4)!.string!
            try require((value["text"] as? String ?? "").contains(expected),"current page exact PDFKit extraction")
        }
        check("real PDF closed page range includes every selected physical page") {
            let value=try source("range",["from":4,"to":6]);try assertIdentity(value,[4,5,6])
            let text=value["text"] as? String ?? ""
            for number in 4...6 {try require(text.contains("[p.\(number)]") && text.contains(document.page(at:number-1)!.string!),"range retained real page \(number)")}
        }
        check("real PDF full text retains all 13 physical pages") {
            let value=try source("full");try assertIdentity(value,Array(1...13))
            for number in 1...13 {try require((value["text"] as? String ?? "").contains("[p.\(number)]"),"full source page \(number)")}
        }
        check("real PDF selected characters retain page owner/SHA/version") {
            let first=document.page(at:0)!,count=min(100,(first.string! as NSString).length)
            guard let selected=first.selection(for:NSRange(location:0,length:count)) else{throw NativeTestFailure(message:"Actual PDFKit selection could not be created")}
            app.pdfView.setCurrentSelection(selected,animate:false);app.pdfSelectionChanged()
            let value=try source("selection")
            try require(value["paperID"] as? String==owner && value["pdfSHA"] as? String==expectedSHA && value["sourceVersion"] as? String==version && value["pages"] as? [Int]==[1],"selected source ownership")
            try require(value["text"] as? String==selected.string,"actual selected text unchanged")
        }
        check("selection rejects different PDF owner") {
            let old=app.pdfOwner;defer{app.pdfOwner=old};app.pdfOwner="arxiv:another"
            try rejects{_=try source("selection")}
        }
        check("selection rejects stale PDF SHA for same paper") {
            let old=app.selectionSource;defer{app.selectionSource=old};app.selectionSource["pdfSHA"]=String(repeating:"0",count:64)
            try rejects{_=try source("selection")}
        }
        check("clearing real PDF selection invalidates previous source") {
            let previous=app.pdfView.currentSelection
            defer{app.pdfView.setCurrentSelection(previous,animate:false);app.pdfSelectionChanged()}
            app.pdfView.setCurrentSelection(nil,animate:false);app.pdfSelectionChanged()
            try rejects{_=try source("selection")}
        }
        check("page/range/full reject different document owner") {
            let old=app.pdfOwner;defer{app.pdfOwner=old};app.pdfOwner="arxiv:another"
            for scope in ["page","range","full"]{try rejects{_=try source(scope)}}
        }
        check("invalid physical page intervals rejected") {
            for value in [["from":0,"to":1],["from":4,"to":3],["from":1,"to":14]]{try rejects{_=try source("range",value)}}
        }
        check("unknown scope never broadens evidence to full PDF") {try rejects{_=try source("misspelled-selection")}}
        check("published guide keeps actual identity revision and text") {
            let value=try source("guide")
            try require(value["paperID"] as? String==owner && value["revision"] as? String==revision && value["text"] as? String==plain,"bound published guide")
        }
        check("guide rejects stale article owner") {
            let old=app.currentArticle;defer{app.currentArticle=old};app.currentArticle["paperID"]="arxiv:another"
            try rejects{_=try source("guide")}
        }
        check("empty guide cannot become paid evidence") {
            let old=app.currentArticle;defer{app.currentArticle=old};app.currentArticle["plainText"]=" \n "
            try rejects{_=try source("guide")}
        }
        check("oversized guide rejected before paid evidence") {
            let old=app.currentArticle;defer{app.currentArticle=old};app.currentArticle["plainText"]=String(repeating:"x",count:240001)
            try rejects{_=try source("guide")}
        }
        check("oversized real PDF text rejected rather than silently truncated") {
            let first=document.page(at:0)!,pageCharacters=first.string!.count
            try require(pageCharacters>500,"real source page must contain text")
            let long=PDFDocument(),count=240001/pageCharacters+2
            for index in 0..<count {long.insert(first.copy() as! PDFPage,at:index)}
            let old=app.pdfView.document;defer{app.pdfView.document=old}
            app.pdfView.document=long
            try rejects{_=try source("full")}
        }
        check("chapter scope uses real outline or explicitly refuses absent outline") {
            let chapters=app.pdfChapters()
            if let first=chapters.first,let start=first["page"] as? Int,let end=first["endPage"] as? Int {
                let value=try source("chapter",["chapter":0]);try assertIdentity(value,Array(start...end))
            } else { try rejects{_=try source("chapter",["chapter":0])} }
            try rejects{_=try source("chapter",["chapter":-1])}
            try rejects{_=try source("chapter",["chapter":chapters.count])}
        }
        check("chapter outline fixture selects actual underlying PDF pages") {
            let old=document.outlineRoot;defer{document.outlineRoot=old}
            let outline=PDFOutline(),first=PDFOutline(),second=PDFOutline()
            first.label="Explicit fixture chapter one";first.destination=PDFDestination(page:document.page(at:0)!,at:.zero)
            second.label="Explicit fixture chapter two";second.destination=PDFDestination(page:document.page(at:4)!,at:.zero)
            outline.insertChild(first,at:0);outline.insertChild(second,at:1);document.outlineRoot=outline
            let value=try source("chapter",["chapter":0]);try assertIdentity(value,[1,2,3,4])
            try require((value["text"] as? String ?? "").contains(document.page(at:3)!.string!),"outline keeps actual real page text")
        }
        check("mixed text/blank PDF reports missing physical page instead of complete coverage") {
            let mixed=PDFDocument();mixed.insert(document.page(at:0)!.copy() as! PDFPage,at:0);mixed.insert(PDFPage(),at:1)
            let old=app.pdfView.document,oldSHA=app.currentPDFSHA;defer{app.pdfView.document=old;app.currentPDFSHA=oldSHA}
            app.pdfView.document=mixed;app.currentPDFSHA=sha256(mixed.dataRepresentation()!)
            let value=try source("full")
            try require(value["missingTextPages"] as? [Int]==[2] && value["completeTextCoverage"] as? Bool==false,"missing page explicitly disclosed")
            try require((value["text"] as? String ?? "").contains(document.page(at:0)!.string!),"real page content retained")
        }
        check("valid local settings supported without reads/writes") {
            try app.validateSettings(["endpoint":"https://api.example.org/v1","httpProxy":"http://127.0.0.1:7890","font":18,"maxTokens":8192,"syncHours":12,"dailyRequests":50,"appearance":"system","protocol":"responses"])
            try app.validateSettings(["endpoint":"http://127.0.0.1:8000/v1"])
        }
        check("URL credentials/query/fragments and remote HTTP rejected") {
            for url in ["https://user:password@example.org/v1","https://example.org/v1?key=secret","https://example.org/v1#secret","http://example.org/v1"]{try rejects{try app.validateSettings(["endpoint":url])}}
            for url in ["http://user:password@127.0.0.1:7890","socks5://127.0.0.1:7890","http://127.0.0.1"]{try rejects{try app.validateSettings(["httpProxy":url])}}
        }
        check("settings out-of-range and wrong numeric types rejected") {
            for v:[String:Any] in [["font":25],["syncHours":0],["maxTokens":255],["dailyRequests":1001],["font":"18"],["maxTokens":8192.5]]{try rejects{try app.validateSettings(v)}}
        }
        check("settings wrong primitive types and unknown protocol rejected") {
            for v:[String:Any] in [["endpoint":42],["httpProxy":false],["appearance":3],["model":[]],["protocol":"unknown"],["reduceMotion":"false"],try JSONSerialization.jsonObject(with:Data("{\"dailyRequests\":true}".utf8)) as! [String:Any],try JSONSerialization.jsonObject(with:Data("{\"syncHours\":true}".utf8)) as! [String:Any],try JSONSerialization.jsonObject(with:Data("{\"reduceMotion\":1}".utf8)) as! [String:Any]]{try rejects{try app.validateSettings(v)}}
        }
        await checkAsync("termination gate refuses new jobs and paper switches while permitting final note/reading saves") {
            app.terminationPending=true;defer{app.terminationPending=false}
            let prior=app.currentPaperID
            for command in ["model.run","library.sync","app.setPaper","storage.prepare","app.backup","app.restore","app.openLocal"] {
                try await rejectsAsync{_=try await app.dispatch(command,payload:["id":"other-paper","question":"must never issue"])}
            }
            try require(app.currentPaperID==prior && app.jobs.isEmpty,"exit gate kept owner and job set")
            let note=try await app.dispatch("personal.note",payload:["paperID":owner,"text":"Final isolated draft", "baseRevision":0])
            try require(note["text"] as? String=="Final isolated draft","final note actually saved")
            _=try await app.dispatch("personal.reading",payload:["paperID":owner,"question":"Final isolated question","mode":"analysis"])
            try require((app.store.value["readingState"] as? [String:[String:Any]])?[owner]?["question"] as? String=="Final isolated question","final reading snapshot actually saved")
        }
        await checkAsync("maintenance gate blocks new actions and writes while allowing hidden PDF layout") {
            app.maintenanceBusy=true;defer{app.maintenanceBusy=false}
            for command in ["model.run","library.sync","app.setPaper","personal.note","personal.reading","app.bootstrap","app.backup","app.restore"] {
                try await rejectsAsync{_=try await app.dispatch(command,payload:[:])}
            }
            _=try await app.dispatch("pdf.frame",payload:["visible":false]);try require(app.pdfView.isHidden,"layout hidden without a native window")
        }
        check("actual encrypted PDF rejects wrong password and cancellation, unlocks real original content only on correct password") {
            let encrypted=root.appendingPathComponent("encrypted-micla.pdf")
            guard let fresh=PDFDocument(data:original),fresh.write(to:encrypted,withOptions:[.userPasswordOption:"fixture-reader",.ownerPasswordOption:"fixture-owner"]) else{throw NativeTestFailure(message:"Could not create actual password PDF")}
            for candidate:String? in [nil,"incorrect"] {
                guard let locked=PDFDocument(url:encrypted),locked.isEncrypted,locked.isLocked else{throw NativeTestFailure(message:"Fixture PDF is not really encrypted/locked")}
                try rejects{try app.unlockPDF(locked,passwordProvider:{candidate})}
                try require(locked.isLocked,"wrong/cancel retained locked document")
            }
            let locked=PDFDocument(url:encrypted)!
            try app.unlockPDF(locked,passwordProvider:{"fixture-reader"})
            try require(!locked.isLocked && locked.pageCount==13 && (locked.page(at:0)?.string ?? "").contains("MiCLA"),"correct password unlocks actual original 13 pages")
            var requested=false
            try app.unlockPDF(locked,passwordProvider:{requested=true;return nil})
            try require(!requested,"already unlocked document never asks for password")
        }
        try require(app.jobs.isEmpty && (app.store.value["sessions"] as? [[String:Any]] ?? []).isEmpty,"No paid jobs or sessions created")
        print("Native AppKit/PDFKit regression: \(passed) passed; \(failures.count) failed. Real PDF, isolated temporary state, no application launch or external service calls.")
        if !failures.isEmpty{FileHandle.standardError.write(Data((failures.joined(separator:"\n")+"\n").utf8));fflush(stdout);exit(1)}
    }
}
