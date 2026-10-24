import Foundation

@main struct DesktopStoreTests {
    @MainActor static func main() throws {
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("DesktopStoreTests-\(UUID().uuidString)")
        defer{try? FileManager.default.removeItem(at:directory)}
        let store=try DesktopStore(directory:directory)
        var failures:[String]=[],passes=0
        func check(_ name:String,_ condition:Bool){if condition{passes+=1}else{failures.append(name)}}
        func encoded(_ value:[String:Any])->Data{try! JSONSerialization.data(withJSONObject:value,options:.sortedKeys)}
        let file=directory.appendingPathComponent("personal.json")
        func blockedWrite(_ name:String,_ action:()throws->Void)throws{
            let before=encoded(store.snapshot()),disk=try Data(contentsOf:file)
            try FileManager.default.removeItem(at:file);try FileManager.default.createDirectory(at:file,withIntermediateDirectories:false)
            var failed=false;do{try action()}catch{failed=true}
            check(name+" actually fails",failed);check(name+" rolls back memory",encoded(store.snapshot())==before)
            try FileManager.default.removeItem(at:file);try disk.write(to:file,options:.atomic)
        }
        try store.setList("favorites",ids:["arxiv:1","arxiv:1"])
        check("deduplicate favorites",store.snapshot()["favorites"] as? [String]==["arxiv:1"])
        let note=try store.saveNote(id:"arxiv:1",text:"真实中文笔记",baseRevision:0)
        check("first note revision",note["revision"] as? Int==1)
        var conflict=false;do{_=try store.saveNote(id:"arxiv:1",text:"覆盖",baseRevision:0)}catch{conflict=true}
        check("stale note CAS rejected",conflict)
        check("stale note preserves body",((store.snapshot()["notes"] as? [String:[String:Any]])?["arxiv:1"]?["text"] as? String)=="真实中文笔记")
        try blockedWrite("settings"){try store.updateSettings(["font":20])}
        try blockedWrite("favorites"){try store.setList("favorites",ids:["other"])}
        try blockedWrite("notes"){_=try store.saveNote(id:"arxiv:1",text:"不能假保存",baseRevision:1)}
        try blockedWrite("reading state"){try store.saveReading(id:"arxiv:1",state:["page":5])}
        try blockedWrite("annotations"){_=try store.saveAnnotation(id:"arxiv:1",annotation:["id":"test","page":1])}
        try blockedWrite("jobs"){try store.upsertJob(["id":"job","status":"running"])}
        try blockedWrite("sessions"){try store.appendSession(["id":"session","status":"pending","charge":"unknown"])}
        let original=encoded(store.snapshot())
        var malformed=store.snapshot();malformed["favorites"]="invalid-array"
        var malformedRejected=false;do{try store.restorePersonal(malformed)}catch{malformedRejected=true}
        check("restore rejects malformed favorites",malformedRejected)
        check("malformed restore keeps memory",encoded(store.snapshot())==original)
        let diskBefore=try Data(contentsOf:file)
        let validPaper:[String:Any]=["id":"arxiv:test","title":"Actual source fixture","sourceKind":"arxiv","authors":["Author"]]
        let badIndexes:[Any]=[["bad-array"],["arxiv:test":["id":"other","title":"Wrong identity","sourceKind":"arxiv"]],["arxiv:test":["id":"arxiv:test","title":7,"sourceKind":"arxiv"]],["local:bad":["id":"local:bad","title":"Bad local","sourceKind":"local","localPDFPath":"relative","pdfSHA":"invalid"]]]
        for badIndex in badIndexes {var bad=store.snapshot();bad["personalPapers"]=badIndex;var refused=false;do{try store.restorePersonal(bad)}catch{refused=true};check("bad personal paper index rejected",refused);check("bad personal paper index preserves memory",encoded(store.snapshot())==original);check("bad personal paper index preserves original file bytes",try Data(contentsOf:file)==diskBefore)}
        try store.rememberPaper(validPaper)
        check("valid personal paper remembered",(store.snapshot()["personalPapers"] as? [String:[String:Any]])?["arxiv:test"]?["title"] as? String=="Actual source fixture")
        try blockedWrite("personal paper index"){try store.rememberPaper(["id":"arxiv:second","title":"Second","sourceKind":"arxiv"])}
        // Test a separate directory so no user data or existing store can be touched.
        let bad=directory.appendingPathComponent("bad-schema");try FileManager.default.createDirectory(at:bad,withIntermediateDirectories:true)
        let badBytes=try JSONSerialization.data(withJSONObject:["schema":999,"notes":[:],"settings":[:]],options:.sortedKeys)
        try badBytes.write(to:bad.appendingPathComponent("personal.json"))
        var rejected=false;do{_=try DesktopStore(directory:bad)}catch{rejected=true}
        check("unknown schema rejected",rejected)
        check("unknown schema bytes preserved",try Data(contentsOf:bad.appendingPathComponent("personal.json"))==badBytes)
        print("DesktopStore: \(passes) checks passed, \(failures.count) failed")
        for item in failures{print("FAIL: "+item)}
        if !failures.isEmpty{exit(1)}
    }
}
