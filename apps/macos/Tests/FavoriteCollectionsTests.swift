import Foundation

@main struct FavoriteCollectionsTests {
    @MainActor static func main() throws {
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("Favorites-\(UUID().uuidString)")
        defer{try? FileManager.default.removeItem(at:directory)}
        let store=try DesktopStore(directory:directory),file=directory.appendingPathComponent("personal.json")
        var passed=0,failures=[String]()
        func check(_ name:String,_ condition:Bool){if condition{passed+=1}else{failures.append(name)}}
        func encoded(_ object:[String:Any])->Data{try! JSONSerialization.data(withJSONObject:object,options:.sortedKeys)}
        func rejected(_ name:String,_ action:()throws->Void){let before=encoded(store.snapshot());do{try action();check(name,false)}catch{check(name,true)};check(name+" keeps memory",before==encoded(store.snapshot()))}
        func metadata()->[String:Any]{store.snapshot()["favoriteCollections"] as? [String:Any] ?? [:]}
        func revision()->Int{metadata()["revision"] as? Int ?? 0}
        func items()->[String:[String:Any]]{metadata()["items"] as? [String:[String:Any]] ?? [:]}
        func edit(_ action:String,_ more:[String:Any]=[:])throws{try store.editFavorites(["action":action,"expectedRevision":revision()].merging(more){_,b in b})}
        let t1=Date(timeIntervalSince1970:1_700_000_000.123),t2=t1.addingTimeInterval(600)
        let fresh=store.snapshot()
        check("new independent root uses current protocol",ClientProtocols.isCurrentHeader(fresh,"paperdigest-personal-library") && fresh["schema"]==nil)
        try store.editList(["key":"favorites","action":"add","ids":["stable"]],now:t1)
        check("new independent root writes current collection format",ClientProtocols.isCurrentHeader(metadata(),"paperdigest-favorite-collections") && store.browserSnapshot()["favoriteCollectionsWritable"] as? Bool == true && store.snapshot()["favoriteCollectionsWritable"]==nil)
        var legacy=fresh;legacy.removeValue(forKey:"contract");legacy.removeValue(forKey:"schemaFingerprint");legacy["schema"]=1;legacy["favorites"]=["old"]
        var mixedNested=legacy;mixedNested["favoriteCollections"]=metadata()
        rejected("released root cannot import stable nested collection"){try store.restorePersonal(mixedNested)}
        try store.restorePersonal(legacy)
        check("legacy extension absent",store.snapshot()["favoriteCollections"]==nil)
        try store.editList(["key":"favorites","action":"add","ids":["new"]],now:t1)
        check("released root and collection header remain writable",store.snapshot()["schema"] as? Int==1 && store.snapshot()["contract"]==nil && metadata()["version"] as? Int==1 && metadata()["contract"]==nil)
        check("native clock millis",items()["new"]?["addedAt"] as? String=="2023-11-14T22:13:20.123Z")
        check("old favorite timestamp remains absent",items()["old"]==nil)
        let r=revision();try store.editList(["key":"favorites","action":"add","ids":["new"]],now:t2)
        check("repeat add idempotent",revision()==r && items()["new"]?["addedAt"] as? String==FavoriteCollections.timestamp(t1))
        try edit("folder.create",["name":"  阅读 e\u{301}  "])
        var folders=metadata()["folders"] as! [[String:Any]];let folder=folders[0]["id"] as! String
        check("name normalized NFC",folders[0]["name"] as? String=="阅读 é")
        rejected("normalized duplicate rejected"){try edit("folder.create",["name":"阅读 é"])}
        try edit("folder.create",["name":"reading"]);try edit("folder.create",["name":"Reading"])
        check("case sensitive distinct names",(metadata()["folders"] as! [[String:Any]]).count==3)
        rejected("mixed missing assignment is atomic rejection"){try edit("items.assign",["ids":["old","new","not-favorite"],"folderIDs":[folder],"mode":"replace"])}
        try edit("items.assign",["ids":["old","new"],"folderIDs":[folder],"mode":"replace"])
        check("classifying legacy uses null time",items()["old"]?["addedAt"] is NSNull)
        check("classification does not add missing",!(store.snapshot()["favorites"] as! [String]).contains("not-favorite"))
        check("classification preserves new timestamp",items()["new"]?["addedAt"] as? String==FavoriteCollections.timestamp(t1))
        let classified=revision();try edit("items.assign",["ids":["old","new"],"folderIDs":[folder],"mode":"replace"])
        check("repeat assignment no revision",revision()==classified)
        rejected("stale CAS rejected"){try store.editFavorites(["action":"folder.create","name":"stale","expectedRevision":0])}
        rejected("boolean CAS rejected"){try store.editFavorites(["action":"folder.create","name":"bool","expectedRevision":true])}
        rejected("number addMissing rejected"){try edit("items.assign",["ids":["missing"],"folderIDs":[folder],"mode":"add","addMissing":1])}
        try edit("items.assign",["ids":["missing"],"folderIDs":[folder],"mode":"add","addMissing":true])
        check("explicit favorite and classify adds",(store.snapshot()["favorites"] as! [String]).contains("missing") && FavoriteCollections.validTime(items()["missing"]!["addedAt"]!))
        try edit("folder.delete",["folderID":folder])
        check("delete only removes category references",(store.snapshot()["favorites"] as! [String]).contains("old") && (items()["old"]?["folderIDs"] as? [String])==[])
        try store.editList(["key":"favorites","action":"remove","ids":["new"]])
        check("remove drops metadata",items()["new"]==nil)
        var orphan=store.snapshot(),ext=metadata(),all=items();all["new"]=["addedAt":"2000-01-01T00:00:00Z","folderIDs":[],"futureItem":"keep"];ext["items"]=all;ext["futureField"]=["kept":true];orphan["favoriteCollections"]=ext
        try store.restorePersonal(orphan);try store.editList(["key":"favorites","action":"add","ids":["new"]],now:t2)
        check("orphan does not supply old timestamp",items()["new"]?["addedAt"] as? String==FavoriteCollections.timestamp(t2))
        check("re-add preserves orphan unknown fields",items()["new"]?["futureItem"] as? String=="keep")
        rejected("name C1 control rejected"){try edit("folder.create",["name":"bad\u{0085}name"])}
        check("unknown extension field preserved",(metadata()["futureField"] as? [String:Bool])?["kept"]==true)
        let beforeReading=revision();try store.editList(["key":"reading","action":"add","ids":["one"]]);_=try store.saveNote(id:"old",text:"notes independent",baseRevision:0)
        check("notes and reading do not change favorite revision",revision()==beforeReading)
        for id in ["concurrent-a","concurrent-b"]{try store.editList(["key":"favorites","action":"add","ids":[id]])}
        check("sequential actor intents merge current lists",Set(store.snapshot()["favorites"] as! [String]).isSuperset(of:["concurrent-a","concurrent-b"]))
        rejected("out-of-contract native clock refuses new metadata"){try store.editList(["key":"favorites","action":"add","ids":["bad-clock"]],now:Date(timeIntervalSince1970:253_402_300_800))}
        rejected("blank paper identity refused"){try store.editList(["key":"favorites","action":"add","ids":["  "]])}
        let original=store.snapshot(),disk=try Data(contentsOf:file)
        try FileManager.default.removeItem(at:file);try FileManager.default.createDirectory(at:file,withIntermediateDirectories:false)
        let beforeNoop=encoded(store.snapshot());try store.editList(["key":"favorites","action":"add","ids":["old"]]);check("no-op needs no disk write",beforeNoop==encoded(store.snapshot()))
        rejected("failed favorite save rolls back all metadata"){try store.editList(["key":"favorites","action":"add","ids":["failed"]])}
        try FileManager.default.removeItem(at:file);try disk.write(to:file,options:.atomic)
        var future=original;future["favoriteCollections"]=["version":2,"opaque":["revision":"new format"]]
        try store.restorePersonal(future);let futureBytes=encoded(store.snapshot()["favoriteCollections"] as! [String:Any])
        rejected("future favorite writes require upgrade"){try store.editList(["key":"favorites","action":"remove","ids":["old"]])}
        try store.editList(["key":"reading","action":"add","ids":["two"]]);_=try store.saveNote(id:"old",text:"future notes still editable",baseRevision:1)
        check("future opaque extension unchanged",encoded(store.snapshot()["favoriteCollections"] as! [String:Any])==futureBytes)
        try store.restorePersonal(original)
        var mixed=original;mixed["contract"]="paperdigest-personal-library";mixed["schemaFingerprint"]=ClientProtocols.schemaFingerprint("paperdigest-personal-library")
        rejected("mixed personal header cannot import"){try store.restorePersonal(mixed)}
        for bad in ["1500-02-29T00:00:00Z","1900-02-29T00:00:00Z","2025-02-29T00:00:00Z","2024-02-30T00:00:00Z","2024-01-01T00:00:60Z","0000-01-01T00:00:00Z","2024-01-01T00:00:00+00:00"]{check("reject invalid UTC "+bad,!FavoriteCollections.validTime(bad))}
        for good in ["1582-10-10T00:00:00Z","1600-02-29T00:00:00Z","2000-02-29T00:00:00Z","2024-02-29T00:00:00Z","2024-02-29T00:00:00.123456789Z","2024-02-29T23:59:59.999999999Z"]{check("accept real UTC "+good,FavoriteCollections.validTime(good))}
        for bad:Any in [true,"1",1.5,-1,2_147_483_648] {var malformed=original,m=metadata();m["revision"]=bad;malformed["favoriteCollections"]=m;rejected("invalid revision rejected"){try store.restorePersonal(malformed)}}
        var max=original,m=metadata();m["revision"]=2_147_483_647;max["favoriteCollections"]=m;try store.restorePersonal(max)
        let maxDisk=try Data(contentsOf:file);try store.editList(["key":"favorites","action":"add","ids":["old"]]);check("max revision noop accepted",revision()==2_147_483_647)
        rejected("max revision change rejected"){try store.editList(["key":"favorites","action":"add","ids":["overflow"]])};check("max rejection keeps disk",try Data(contentsOf:file)==maxDisk)
        folders=metadata()["folders"] as! [[String:Any]]
        let name=folders[0]["name"] as! String,id=folders[0]["id"] as! String
        try edit("folder.rename",["folderID":id,"name":name]);check("rename own name idempotent at max revision",revision()==2_147_483_647)
        try store.restorePersonal(original)
        let collected=try BackupCodec.collect(sourceDirectory:directory)
        let parsed=try BackupCodec.parse(BackupCodec.encode(collected))
        let staged=try BackupCodec.stage(parsed,parentDirectory:directory.deletingLastPathComponent())
        defer{try? FileManager.default.removeItem(at:staged.stageDirectory)}
        check("backup preserves exact favorite metadata bytes",staged.personalStoreData == (try Data(contentsOf:file)))
        let restored=try DesktopStore(directory:staged.stageDirectory)
        check("restored folders and times unchanged",encoded(restored.snapshot()["favoriteCollections"] as! [String:Any])==encoded(original["favoriteCollections"] as! [String:Any]))
        let malformedDirectory=directory.appendingPathComponent("corrupt")
        try FileManager.default.createDirectory(at:malformedDirectory,withIntermediateDirectories:true)
        var malformed=original,badMetadata=metadata(),badItems=items();badItems["old"]=["addedAt":"2024-02-30T00:00:00Z","folderIDs":[]];badMetadata["items"]=badItems;malformed["favoriteCollections"]=badMetadata
        let malformedBytes=encoded(malformed),malformedFile=malformedDirectory.appendingPathComponent("personal.json");try malformedBytes.write(to:malformedFile)
        var refused=false;do{_=try DesktopStore(directory:malformedDirectory)}catch{refused=true}
        check("malformed v1 refuses bootstrap",refused);check("malformed bootstrap keeps original bytes",try Data(contentsOf:malformedFile)==malformedBytes)
        let fixtureURL=URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("tests/fixtures/workbench-favorite-collections-v1.json")
        let shared=try JSONSerialization.jsonObject(with:Data(contentsOf:fixtureURL)) as! [String:Any]
        for fixture in shared["validationCases"] as! [[String:Any]] {
            let name=fixture["name"] as! String,object=fixture["personal"] as! [String:Any],valid=fixture["valid"] as! Bool
            var accepted=true;do{try DesktopStore.validate(object)}catch{accepted=false}
            check("shared validation "+name,accepted==valid)
            if valid,let editable=(fixture["expected"] as? [String:Any])?["editable"] as? Bool {
                var actual=true;do{_=try FavoriteCollections.editable(object["favoriteCollections"],root:object)}catch{actual=false}
                check("shared editability "+name,actual==editable)
            }
        }
        for fixture in shared["editCases"] as! [[String:Any]] {
            let name=fixture["name"] as! String,initial=fixture["initialPersonal"] as! [String:Any]
            try store.restorePersonal(initial);let before=encoded(store.snapshot()),beforeDisk=try Data(contentsOf:file)
            var didError=false;do{try store.editFavorites(fixture["payload"] as! [String:Any],now:t2)}catch{didError=true}
            check("shared edit error "+name,didError==fixture["expectedError"] as! Bool)
            if fixture["expectedUnchanged"] as? Bool==true{let afterDisk=try Data(contentsOf:file);check("shared edit unchanged "+name,encoded(store.snapshot())==before && afterDisk==beforeDisk)}
        }
        let bulkIDs=(0..<10000).map{"synthetic:bulk-"+String($0)},bulkStart=Date()
        try store.editList(["key":"favorites","action":"add","ids":bulkIDs],now:t1)
        check("bulk add all IDs without dropping existing favorites",(store.snapshot()["favorites"] as! [String]).count==10001)
        let firstBatchItems=items(),firstBatchTime=FavoriteCollections.timestamp(t1)
        check("bulk add has one native operation timestamp",bulkIDs.allSatisfy{firstBatchItems[$0]?["addedAt"] as? String==firstBatchTime})
        let missing=(0..<1000).map{"synthetic:assigned-"+String($0)}
        try store.editFavorites(["action":"items.assign","expectedRevision":revision(),"ids":missing,"folderIDs":["11111111-1111-4111-8111-111111111111"],"mode":"add","addMissing":true],now:t2)
        let batchItems=items(),expectedTime=FavoriteCollections.timestamp(t2)
        check("bulk favorite and assign uses same native timestamp",missing.allSatisfy{batchItems[$0]?["addedAt"] as? String==expectedTime})
        print("Bulk native favorite add10000 + favorite-and-classify1000: "+String(format:"%.3f",Date().timeIntervalSince(bulkStart))+"s (synthetic isolated profile; no latency assertion)")
        print("FavoriteCollections: \(passed) checks passed, \(failures.count) failed");for name in failures{print("FAIL: "+name)};if !failures.isEmpty{exit(1)}
    }
}
