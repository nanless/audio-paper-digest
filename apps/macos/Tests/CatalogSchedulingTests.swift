import Foundation
import CryptoKit

private actor CatalogHeldTransport {
    private var released=false
    private var waiting:[CheckedContinuation<Void,Never>]=[]
    private(set) var started=false
    private(set) var calls=0
    private let files:[String:Data]
    init()throws {
        let row:[String:Any]=["permalink":"/blog/posts/synthetic-wake/","pageType":"paper","title":"Explicit synthetic scheduling fixture","titleZh":"明确合成目录夹具","date":"2026-01-01","score":7,"task":"语音识别","method":"对比学习","tags":["音频"],"sourceKind":"arxiv","identityStatus":"verified","arxivId":"2501.00001","citation":["paperKey":"arxiv:2501.00001","identityStatus":"verified","verified":true,"complete":false,"authors":["Synthetic fixture"],"title":"Explicit synthetic scheduling fixture","arxivId":"2501.00001v1","sourceKind":"arxiv","sourceUrl":"https://arxiv.org/abs/2501.00001v1","pdfUrl":"https://arxiv.org/pdf/2501.00001v1.pdf"]]
        let data=try JSONSerialization.data(withJSONObject:[row],options:.sortedKeys),hash=SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined(),name="search-index/part-0001-"+String(hash.prefix(12))+".json"
        let manifest:[String:Any]=["contract":"paper-search-index-manifest-v1","recordCount":1,"totalBytes":data.count,"shards":[["url":name,"sha256":hash,"bytes":data.count,"recordCount":1]]]
        files=["/blog/index.json":try JSONSerialization.data(withJSONObject:manifest,options:.sortedKeys),"/blog/"+name:data]
    }
    func release(){released=true;let old=waiting;waiting=[];for c in old{c.resume()}}
    func read(_ url:URL,_ limit:Int)async throws->Data {
        guard url.scheme=="https",url.host=="fixture.example",let data=files[url.path] else{throw DesktopError.message("Unexpected synthetic URL")}
        calls+=1
        if url.path=="/blog/index.json"{started=true;if !released{await withCheckedContinuation{waiting.append($0)}}}
        try Task.checkCancellation()
        return data
    }
}

@main struct CatalogSchedulingTests {
    @MainActor static func main()async {
        var reports:[[String:Any]]=[];var failures=0;var cleanupComplete=true
        for mode in ["wake","timer","automatic-then-manual","manual-then-manual"] {
            let root=FileManager.default.temporaryDirectory.appendingPathComponent("CatalogScheduling-"+UUID().uuidString)
            var app:PaperDigestApp?;let gate=try! CatalogHeldTransport();var manual:Task<[String:Any],Error>?;var follower:Task<[String:Any],Error>?
            do {
                try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
                let current=PaperDigestApp();app=current;current.directory=root;current.store=try DesktopStore(directory:root)
                current.library=try LibraryService(dataDirectory:root,siteBaseURL:URL(string:"https://fixture.example/blog/")!,transport:{url,limit in try await gate.read(url,limit)})
                current.model=ModelService(directory:root,store:current.store,keyProvider:{throw DesktopError.message("Synthetic catalog test forbids credentials")})
                if mode=="automatic-then-manual"{current.syncNow()}else{manual=Task{@MainActor in try await current.dispatch("library.sync",payload:[:])}}
                for _ in 0..<500{if await gate.started{break};try await Task.sleep(nanoseconds:2_000_000)}
                guard await gate.started else{throw DesktopError.message("Synthetic transport not entered")}
                let recordedAtManualStart=current.lastSyncAttempt>Date.distantPast
                let initialIDs=Set(current.jobs.keys)
                if mode=="wake"{current.didWake()}else if mode=="timer"{current.syncNow()}else{follower=Task{@MainActor in try await current.dispatch("library.sync",payload:[:])}}
                // A bounded opportunity for the actual unawaited native callback task to start.
                for _ in 0..<100{if current.jobs.count>initialIDs.count{break};try await Task.sleep(nanoseconds:2_000_000)}
                let during=current.jobs.count;let automatic=Set(current.jobs.keys).subtracting(initialIDs)
                if mode=="timer",automatic.count==1,let id=automatic.first{_=try await current.dispatch("jobs.cancel",payload:["id":id])}
                await gate.release()
                var manualCompleted=false
                do{if let manual{_=try await manual.value};if let follower{_=try await follower.value};manualCompleted=true}catch{}
                for _ in 0..<500{if current.jobs.isEmpty{break};try await Task.sleep(nanoseconds:2_000_000)}
                let rows=(current.store.value["jobs"] as? [[String:Any]] ?? []).filter{$0["command"] as? String=="library.sync"}
                let passed=recordedAtManualStart && during==1 && rows.count==1 && manualCompleted && current.jobs.isEmpty
                reports.append(["case":mode,"manualAttemptRecorded":recordedAtManualStart,"activeJobsAfterAutomaticCallback":during,"catalogJobRows":rows.count,"transportCalls":await gate.calls,"manualCompleted":manualCompleted,"drained":current.jobs.isEmpty,"passed":passed])
                if !passed{failures+=1}
            }catch{failures+=1;reports.append(["case":mode,"passed":false,"fixedError":"fixture-or-execution-failed"])}
            await gate.release()
            if let app {
                let owned=Array(app.jobs.values)
                for task in owned{task.cancel()}
                for task in owned{_=await task.result}
            }
            if let manual{_=await manual.result}
            if let follower{_=await follower.result}
            if let app {
                for _ in 0..<500{if app.jobs.isEmpty{break};try? await Task.sleep(nanoseconds:2_000_000)}
                if !app.jobs.isEmpty{cleanupComplete=false;continue}
            }
            do{try FileManager.default.removeItem(at:root)}catch{cleanupComplete=false}
        }
        if !cleanupComplete{failures+=1}
        let result:[String:Any]=["cleanupComplete":cleanupComplete,"scope":"Actual PaperDigestApp dispatch/didWake/syncNow with temporary store and held LibraryService transport; no app startup/windows/network/Keychain/provider/whole-machine sleep", "cases":reports,"failures":failures]
        if let data=try?JSONSerialization.data(withJSONObject:result,options:.sortedKeys),let text=String(data:data,encoding:.utf8){print(text)}
        print("CatalogScheduling RESULT \(reports.count-failures) passed / \(failures) failed")
        if failures>0{exit(1)}
    }
}
