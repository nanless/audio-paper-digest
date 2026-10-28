// Independent native review: actual PDFKit evidence and real disk failures, no model or user profile IO.
import AppKit
import PDFKit
import Foundation
import Darwin

@main struct DesktopEvidenceReviewTests {
    @MainActor static func main() async throws {
        _=NSApplication.shared
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("DesktopEvidenceReview-"+UUID().uuidString)
        defer{try? FileManager.default.removeItem(at:directory)}
        let app=PaperDigestApp();app.directory=directory;app.store=try DesktopStore(directory:directory)
        let data=try Data(contentsOf:URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototypes/macos-research/assets/micla-2610.27491v1.pdf"))
        let doc=PDFDocument(data:data)!,owner="arxiv:2610.27491",version="2610.27491v1"
        app.currentPaperID=owner;app.currentPaper=["id":owner,"title":"MiCLA"]
        app.currentPDFSHA=sha256(data);app.pdfOwner=owner;app.pdfVersion=version;app.pdfView.document=doc
        var passed=0,failures:[String]=[]
        func check(_ value:Bool,_ label:String){if value{passed+=1;print("PASS "+label)}else{failures.append(label);print("FAIL "+label)}}
        for page in [1,5,13] {
            let source=try app.modelSource(["scope":"range","from":page,"to":page])
            check(source["pages"] as? [Int]==[page] && (source["text"] as? String ?? "").contains(doc.page(at:page-1)!.string!),"actual complete physical page \(page)")
        }
        let oldOutline=doc.outlineRoot,outline=PDFOutline(),chapter1=PDFOutline(),chapter2=PDFOutline(),subsection=PDFOutline(),chapter3=PDFOutline()
        for(node,title,page) in [(chapter1,"Chapter one",0),(chapter2,"Chapter two",4),(subsection,"Subsection two.one",6),(chapter3,"Chapter three",12)] {node.label=title;node.destination=PDFDestination(page:doc.page(at:page)!,at:.zero)}
        outline.insertChild(chapter1,at:0);outline.insertChild(chapter2,at:1);chapter2.insertChild(subsection,at:0);outline.insertChild(chapter3,at:2);doc.outlineRoot=outline
        let source=try app.modelSource(["scope":"chapter","chapter":1])
        check(source["pages"] as? [Int]==Array(5...12),"parent chapter includes nested subsections through next peer chapter")
        doc.outlineRoot=oldOutline
        check(app.pdfStatus()["version"] as? String==version,"PDF status uses actual loaded PDF version")
        let previousDocument=app.pdfView.document,previousOwner=app.pdfOwner,previousPage=app.pdfView.currentPage
        let mixed=PDFDocument(),sourcePage=doc.page(at:0)!
        mixed.insert(sourcePage.copy() as! PDFPage,at:0)
        let pageBounds=sourcePage.bounds(for:.mediaBox)
        let raster=NSImage(size:pageBounds.size,flipped:false){rect in
            NSColor.white.setFill();rect.fill();sourcePage.draw(with:.mediaBox,to:NSGraphicsContext.current!.cgContext);return true
        }
        mixed.insert(PDFPage(image:raster)!,at:1)
        let blank=PDFPage();blank.setBounds(pageBounds,for:.mediaBox);mixed.insert(blank,at:2)
        app.pdfView.document=mixed
        for(index,status)in [(0,"available"),(1,"empty"),(2,"empty"),(0,"available")] {
            app.pdfView.go(to:mixed.page(at:index)!)
            let actual=app.pdfStatus()
            check(actual["page"] as? Int==index+1 && actual["pageTextStatus"] as? String==status,"current physical page \(index+1) text status \(status), including mixed-document return")
        }
        app.pdfOwner="different-owner"
        check(app.pdfStatus()["pageTextStatus"] as? String=="unknown","another owner's PDF is not granted current-page text capability")
        app.pdfOwner=previousOwner;app.pdfView.document=nil
        check(app.pdfStatus()["pageTextStatus"] as? String=="unknown","missing current PDF reports uninspected rather than selectable")
        app.pdfView.document=previousDocument;if let previousPage{app.pdfView.go(to:previousPage)}
        let long=PDFDocument(),firstPage=doc.page(at:0)!,copies=70000/firstPage.string!.count+2
        for index in 0..<copies {long.insert(firstPage.copy() as! PDFPage,at:index)}
        let longSelection=PDFSelection(document:long)
        for index in 0..<long.pageCount {let p=long.page(at:index)!;longSelection.add(p.selection(for:NSRange(location:0,length:(p.string! as NSString).length))!)}
        app.pdfView.document=long;app.currentPDFSHA=sha256(long.dataRepresentation()!);app.pdfView.setCurrentSelection(longSelection,animate:false);app.pdfSelectionChanged()
        do {
            let value=try app.modelSource(["scope":"selection"])
            check(value["text"] as? String==longSelection.string,"long actual PDF selection is retained completely or explicitly refused")
        }catch {check(true,"long actual PDF selection is retained completely or explicitly refused")}
        app.pdfView.document=doc;app.currentPDFSHA=sha256(data)
        let page=doc.page(at:0)!,mark=PDFAnnotation(bounds:NSRect(x:30,y:30,width:60,height:20),forType:.highlight,withProperties:nil),id=UUID().uuidString
        page.addAnnotation(mark);app.annotationsByID[id]=mark
        _=try app.store.saveAnnotation(id:owner,annotation:["id":id,"page":1,"text":"disk failure fixture","rect":NSStringFromRect(mark.bounds),"pdfSHA":app.currentPDFSHA])
        let personal=directory.appendingPathComponent("personal.json"),before=try Data(contentsOf:personal)
        try FileManager.default.removeItem(at:personal);try FileManager.default.createDirectory(at:personal,withIntermediateDirectories:false)
        var rejected=false;do{_=try await app.dispatch("pdf.removeAnnotation",payload:["id":id])}catch{rejected=true}
        check(rejected && app.annotationsByID[id] != nil && page.annotations.contains(where:{$0===mark}),"failed annotation deletion preserves PDFKit and stored state")
        let selection=page.selection(for:NSRange(location:0,length:80))!;app.pdfView.setCurrentSelection(selection,animate:false)
        let initialCount=page.annotations.count
        rejected=false;do{_=try app.addHighlight()}catch{rejected=true}
        check(rejected && page.annotations.count==initialCount,"failed highlight persistence does not leave unsaved visual annotations")
        try FileManager.default.removeItem(at:personal);try before.write(to:personal,options:.atomic)
        print("Independent evidence review: \(passed) passed, \(failures.count) failed; no paid request, Keychain or production IO")
        if !failures.isEmpty{exit(1)}
    }
}
