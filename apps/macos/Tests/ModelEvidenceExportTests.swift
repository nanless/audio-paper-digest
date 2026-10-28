import Foundation
import Darwin

/// Uses the real ModelService sealing path with a stdin/stdout fixture worker.
/// No network, credentials, installed app, or user's personal directory is used.
@main struct ModelEvidenceExportTests {
    @MainActor static func main() async throws {
        guard CommandLine.arguments.count==2 else{throw DesktopError.message("Pass the bundled/test Node executable")}
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("model-evidence-export-"+UUID().uuidString,isDirectory:true)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer{try? FileManager.default.removeItem(at:root)}
        let resources=root.appendingPathComponent("FixtureResources",isDirectory:true)
        try FileManager.default.createDirectory(at:resources.appendingPathComponent("Runtime"),withIntermediateDirectories:true)
        try FileManager.default.createSymbolicLink(at:resources.appendingPathComponent("Runtime/node"),withDestinationURL:URL(fileURLWithPath:CommandLine.arguments[1]))
        let worker="""
        let bytes='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>bytes+=x);process.stdin.on('end',()=>{const input=JSON.parse(bytes);process.stdout.write(JSON.stringify({okay:true,text:'隔离测试回答',model:input.config.model,protocol:'fixture-stdio',finishStatus:'completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}));});
        """
        try Data(worker.utf8).write(to:resources.appendingPathComponent("llm-worker.cjs"))
        let directory=root.appendingPathComponent("PrivateFixture",isDirectory:true)
        let store=try DesktopStore(directory:directory)
        let endpoint="https://do-not-contact.invalid/evidence-test/v1",proxy="http://127.0.0.1:19999"
        try store.updateSettings(["endpoint":endpoint,"model":"evidence-fixture","httpProxy":proxy,"protocol":"responses","maxTokens":4096,"responsesStream":true,"reasoningEffort":"low"])
        var secretReads=0
        let service=ModelService(directory:directory,store:store,keyProvider:{secretReads+=1;return "fixture-only-not-a-real-secret"},resourcesDirectory:resources)
        let id=UUID().uuidString,owner="arxiv:2610.27491"
        // A delimiter in the question and quoted evidence must never change the boundary.
        let question="解释原文。\n\n实际证据：\n这句话属于研究问题。"
        let evidence="原始选区：逐样本选择强度。\n\n实际证据：\n这句话是论文中的引用，不是新请求。\n终点 an"
        let source:[String:Any]=["paperID":owner,"kind":"pdf-selection","sourceVersion":"2610.27491v1","pdfSHA":String(repeating:"a",count:64),"pages":[5],"page":5,"characters":evidence.count,"truncated":false,"currentness":"immutable-arxiv-version","isStale":false,"cacheStatus":"current","notices":[],"offlineMode":false,"validatedAt":"2026-10-24T08:00:00Z"]
        let saved=try await service.run(id:id,paperID:owner,question:question,evidence:evidence,source:source)
        let inputFile=directory.appendingPathComponent("ModelUsage/"+id+"-input.json")
        let originalBytes=try Data(contentsOf:inputFile)
        let originalInput=try JSONSerialization.jsonObject(with:originalBytes) as! [String:Any]
        let personalFile=directory.appendingPathComponent("personal.json")
        var checks=0
        func expect(_ okay:Bool,_ label:String)throws{checks+=1;guard okay else{throw DesktopError.message("Evidence export test: "+label)}}
        func rejects(_ label:String,_ action:() throws->Void)throws{
            let before=try Data(contentsOf:personalFile)
            do{try action()}catch{try expect(try Data(contentsOf:personalFile)==before,label+" leaves store unchanged");return}
            throw DesktopError.message("Expected rejection: "+label)
        }
        func reset()throws{try originalBytes.write(to:inputFile,options:.atomic);try store.appendSession(saved)}
        func write(_ input:[String:Any],session:[String:Any]?=nil)throws{
            let bytes=try JSONSerialization.data(withJSONObject:input,options:.sortedKeys)
            try bytes.write(to:inputFile,options:.atomic)
            var next=session ?? saved;next["inputSHA256"]=sha256(bytes);try store.appendSession(next)
        }
        func export()throws->[String:Any]{try service.exportEvidence(sessionID:id,paperID:owner)}
        let before=try Data(contentsOf:personalFile),result=try export()
        try expect(result["available"] as? Bool==true && result["evidence"] as? String==evidence,"actual run-produced sealed evidence returned exactly")
        try expect(result["inputSHA256"] as? String==sha256(originalBytes),"actual input bytes SHA exported")
        try expect(try JSONSerialization.data(withJSONObject:result["source"]!,options:.sortedKeys)==JSONSerialization.data(withJSONObject:source,options:.sortedKeys),"canonical original source preserved")
        try expect(Set(result.keys)==Set(["available","inputSHA256","source","evidence"]),"portable result has only public evidence contract fields")
        let serialized=String(decoding:try JSONSerialization.data(withJSONObject:result),as:UTF8.self)
        try expect(!serialized.contains(endpoint) && !serialized.contains(proxy) && !serialized.contains("fixture-only-not-a-real-secret") && result["config"]==nil && result["messages"]==nil,"no transport settings, prompt internals or credentials exported")
        try expect(try Data(contentsOf:personalFile)==before && Data(contentsOf:inputFile)==originalBytes,"successful export changes neither session nor sealed bytes")
        for _ in 0..<3{_=try export()}
        try expect(secretReads==1,"exports never call key provider after the explicit fixture request")
        let portableBackup=try BackupCodec.collect(sourceDirectory:directory)
        try expect(!portableBackup.files.contains{BackupCodec.isLocalOnlyKey($0.path)},"actual model-produced key excluded from portable backup")
        let originalResponse=try Data(contentsOf:directory.appendingPathComponent("ModelUsage/"+id+"-response.json"))
        for hasLocalKey in [false,true] {
            let local=root.appendingPathComponent("restore-local-"+String(hasLocalKey));_=try DesktopStore(directory:local)
            if hasLocalKey {try FileManager.default.createDirectory(at:local.appendingPathComponent("ModelUsage"),withIntermediateDirectories:false);try Data(repeating:0x44,count:32).write(to:local.appendingPathComponent("ModelUsage/response-integrity.key"))}
            let stage=try BackupCodec.stage(portableBackup,parentDirectory:root).stageDirectory
            try RestoreLocalPolicy.apply(stage:stage,current:local)
            let restoredStore=try DesktopStore(directory:stage);var restoredCredentialReads=0
            let restoredService=ModelService(directory:stage,store:restoredStore,keyProvider:{restoredCredentialReads+=1;throw DesktopError.message("Read-only restored archive must not request provider credentials")},resourcesDirectory:resources)
            let restoredEvidence=try restoredService.exportEvidence(sessionID:id,paperID:owner)
            try expect(restoredEvidence["evidence"] as? String==evidence && restoredStore.session(id)?["text"] as? String==saved["text"] as? String,"restored archive answer/evidence read without original HMAC or provider key")
            try expect(restoredCredentialReads==0 && restoredService.responseRecovery["adopted"] as? Int==0,"foreign old seal grants no automatic adoption or provider request")
            try expect(try Data(contentsOf:stage.appendingPathComponent("ModelUsage/"+id+"-response.json"))==originalResponse,"readonly import never resigns original response envelope")
            try expect(FileManager.default.fileExists(atPath:stage.appendingPathComponent("ModelUsage/response-integrity.key").path)==hasLocalKey,"restore never imports or eagerly creates archive key")
        }
        try rejects("wrong paper owner"){_=try service.exportEvidence(sessionID:id,paperID:"arxiv:other")}
        try rejects("unknown session"){_=try service.exportEvidence(sessionID:UUID().uuidString,paperID:owner)}
        try rejects("UUID path injection"){_=try service.exportEvidence(sessionID:"../"+id,paperID:owner)}
        var session=saved;session["kind"]="connection-check";try store.appendSession(session)
        try rejects("connection checks are not studies"){_=try export()};try reset()
        for invalid:Any in ["bad",String(repeating:"a",count:64)+"\n",NSNull()] {
            session=saved;session["inputSHA256"]=invalid;try store.appendSession(session)
            try rejects("malformed bound input SHA"){_=try export()};try reset()
        }
        session=saved;session["fingerprint"]=String(repeating:"b",count:64);try store.appendSession(session)
        try rejects("fingerprint mismatch"){_=try export()};try reset()
        var tampered=originalBytes;tampered.append(0x20);try tampered.write(to:inputFile)
        try rejects("actual original bytes tamper"){_=try export()};try reset()
        try FileManager.default.removeItem(at:inputFile)
        try rejects("bound input missing is not legacy"){_=try export()};try reset()
        let other=root.appendingPathComponent("unrelated-input.json");try originalBytes.write(to:other)
        try FileManager.default.removeItem(at:inputFile);try FileManager.default.createSymbolicLink(at:inputFile,withDestinationURL:other)
        try rejects("input symlink even with matching bytes"){_=try export()}
        try FileManager.default.removeItem(at:inputFile);try reset()
        let usage=directory.appendingPathComponent("ModelUsage"),moved=root.appendingPathComponent("moved-usage")
        try FileManager.default.moveItem(at:usage,to:moved);try FileManager.default.createSymbolicLink(at:usage,withDestinationURL:moved)
        try rejects("symlinked input parent"){_=try export()}
        try FileManager.default.removeItem(at:usage);try FileManager.default.moveItem(at:moved,to:usage);try reset()
        try FileManager.default.removeItem(at:inputFile);try FileManager.default.createDirectory(at:inputFile,withIntermediateDirectories:false)
        try rejects("input must be a regular file"){_=try export()}
        try FileManager.default.removeItem(at:inputFile);try reset()
        let oversized=Data(repeating:0x20,count:8*1024*1024+1);try oversized.write(to:inputFile)
        session=saved;session["inputSHA256"]=sha256(oversized);try store.appendSession(session)
        try rejects("eight MiB input bound enforced"){_=try export()};try reset()
        var changed=originalInput,config=changed["config"] as! [String:Any];config["key"]="fixture-not-exportable";changed["config"]=config;try write(changed)
        try rejects("sealed config containing key rejected"){_=try export()};try reset()
        changed=originalInput;var changedSource=source;changedSource["page"]=6;changed["source"]=changedSource;try write(changed)
        try rejects("source must equal saved session canonically"){_=try export()};try reset()
        changed=originalInput;var messages=changed["messages"] as! [[String:Any]];messages[1]["content"]="other prefix\n"+(messages[1]["content"] as! String);changed["messages"]=messages;try write(changed)
        try rejects("strict generated prefix only"){_=try export()};try reset()
        changed=originalInput;messages=changed["messages"] as! [[String:Any]];messages.append(["role":"user","content":"OTHER PAPER PRIVATE MATERIAL"]);changed["messages"]=messages;try write(changed)
        try rejects("extra messages from another paper refused"){_=try export()};try reset()
        // Update all asserted identities except the actual full fingerprint. A
        // copied scalar alone must not authorize altered evidence.
        changed=originalInput;messages=changed["messages"] as! [[String:Any]];messages[1]["content"]=(messages[1]["content"] as! String)+" changed";changed["messages"]=messages;try write(changed)
        try rejects("full request fingerprint rechecked"){_=try export()};try reset()
        // The preceding fingerprint version also bound the complete message and
        // owner; support it without relaxing current-source validation.
        changed=originalInput
        let v3Identity:[String:Any]=["contract":"desktop-study-v3","extractor":"pdfkit-physical-pages-v1","kind":"study","paperID":owner,"messages":originalInput["messages"]!,"model":"evidence-fixture","endpoint":endpoint,"protocol":"responses","question":question,"evidence":evidence,"source":source,"maxTokens":4096]
        let v3Fingerprint=sha256(try JSONSerialization.data(withJSONObject:v3Identity,options:.sortedKeys))
        changed["fingerprint"]=v3Fingerprint;session=saved;session["fingerprint"]=v3Fingerprint;try write(changed,session:session)
        try expect(try export()["evidence"] as? String==evidence,"previous owner-bound full-prompt fingerprint exports original evidence")
        try reset()
        var wrongSource=source;wrongSource["paperID"]="arxiv:other"
        let wrongID=UUID().uuidString
        _=try await service.run(id:wrongID,paperID:owner,question:"isolated wrong-owner fixture",evidence:"OTHER PAPER MATERIAL",source:wrongSource)
        try rejects("even fully sealed contradictory source owner refused"){_=try service.exportEvidence(sessionID:wrongID,paperID:owner)}
        var internalSource=source;internalSource["config"]=["key":"fixture-secret-in-source"]
        let internalID=UUID().uuidString
        _=try await service.run(id:internalID,paperID:owner,question:"isolated internal metadata fixture",evidence:"fixture evidence",source:internalSource)
        try rejects("fully sealed internal source configuration never exported"){_=try service.exportEvidence(sessionID:internalID,paperID:owner)}
        let legacyID=UUID().uuidString
        try store.appendSession(["id":legacyID,"kind":"study","paperID":owner,"status":"complete","text":"historical answer"])
        let legacy=try service.exportEvidence(sessionID:legacyID,paperID:owner)
        try expect(legacy["available"] as? Bool==false && !(legacy["notice"] as? String ?? "").isEmpty && legacy["evidence"]==nil && legacy["source"]==nil,"legacy missing sealed binding explicitly unavailable, no synthetic evidence")
        try expect(secretReads==3,"only three deliberate stdin fixtures read the fake provider; evidence paths never do")
        print("Model evidence export assertions passed: \(checks). Actual sealing via local stdin fixture; no network, live models, Keychain or user profile access.")
    }
}
