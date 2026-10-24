import Foundation
import Darwin

@main struct ModelServiceTests {
    @MainActor static func main() async {
        let resolved=realpath(FileManager.default.temporaryDirectory.path,nil)!
        let directory=URL(fileURLWithPath:String(cString:resolved)).appendingPathComponent("ModelServiceTests-\(UUID().uuidString)")
        free(resolved)
        defer{try? FileManager.default.removeItem(at:directory)}
        var checks=0
        func expect(_ value:Bool,_ message:String)throws{checks+=1;if !value{throw DesktopError.message("TEST: "+message)}}
        do {
            guard CommandLine.arguments.count==3 else{throw DesktopError.message("requires mock URL and test resources")}
            let server=CommandLine.arguments[1],resources=URL(fileURLWithPath:CommandLine.arguments[2])
            let store=try DesktopStore(directory:directory)
            try store.updateSettings(["endpoint":server+"/good/v1","model":"desktop-local-test","protocol":"auto","maxTokens":2048,"dailyRequests":50])
            let service=ModelService(directory:directory,store:store,keyProvider:{"test-only-not-a-real-key"},resourcesDirectory:resources)
            let source:[String:Any]=["pdfSHA":String(repeating:"a",count:64),"pages":[1,5]]
            let firstID=UUID().uuidString
            let first=try await service.run(id:firstID,paperID:"test:paper",question:"解释这个实际片段",evidence:"这是一段本地测试材料",source:source)
            try expect(first["status"] as? String=="complete" && (first["text"] as? String ?? "").contains("本地"),"actual worker Chat result saved")
            let repeated=try await service.run(id:UUID().uuidString,paperID:"test:paper",question:"解释这个实际片段",evidence:"这是一段本地测试材料",source:["pages":[1,5],"pdfSHA":String(repeating:"a",count:64)])
            try expect(repeated["reused"] as? Bool==true && repeated["id"] as? String==firstID,"same canonical complete prompt reused without another request")
            let changed=try await service.run(id:UUID().uuidString,paperID:"test:paper",question:"解释这个实际片段",evidence:"改变了证据，必须重新请求",source:source)
            try expect(changed["reused"] as? Bool==false && changed["fingerprint"] as? String != first["fingerprint"] as? String,"changed evidence never reuses old result")
            try store.updateSettings(["maxTokens":4096])
            let changedBudget=try await service.run(id:UUID().uuidString,paperID:"test:paper",question:"解释这个实际片段",evidence:"这是一段本地测试材料",source:source)
            try expect(changedBudget["fingerprint"] as? String != first["fingerprint"] as? String,"request output budget included in fingerprint")
            let inputFile=directory.appendingPathComponent("ModelUsage/"+firstID+"-input.json")
            let bytes=try Data(contentsOf:inputFile),input=try JSONSerialization.jsonObject(with:bytes) as! [String:Any]
            try expect((input["messages"] as? [[String:Any]])?.first?["role"] as? String=="system","full actual system prompt sealed")
            try expect(!String(decoding:bytes,as:UTF8.self).contains("test-only-not-a-real-key"),"sealed input excludes API key")
            try expect(first["inputSHA256"] as? String==sha256(bytes),"saved input bytes bound by SHA")
            let defaultConfig=input["config"] as! [String:Any]
            try expect(defaultConfig["responsesStream"] as? Bool==false && defaultConfig["reasoningEffort"] as? String=="default","absent settings seal explicit app defaults without production environment")
            for invalid:[String:Any] in [["responsesStream":"true"],["reasoningEffort":"minimal"]] {
                try store.updateSettings(invalid);let before=(store.value["sessions"] as? [[String:Any]] ?? []).count;var rejected=false
                do{_=try await service.run(id:UUID().uuidString,paperID:"test:invalid-config",question:"不能发送非法配置",evidence:"本机材料",source:source)}catch{rejected=true}
                try expect(rejected && (store.value["sessions"] as? [[String:Any]] ?? []).count==before,"invalid Responses parameter rejects before request ledger or HTTP")
                try store.updateSettings(["responsesStream":false,"reasoningEffort":"default"])
            }
            try store.updateSettings(["endpoint":server+"/responses/v1","protocol":"responses"])
            let responses=try await service.run(id:UUID().uuidString,paperID:"test:paper",question:"Responses兼容",evidence:"本地材料",source:source)
            try expect(responses["status"] as? String=="complete" && responses["protocol"] as? String=="openai_responses","actual worker Responses route")
            try store.updateSettings(["endpoint":server+"/configured/v1","responsesStream":true,"reasoningEffort":"low"])
            let streaming=try await service.run(id:UUID().uuidString,paperID:"test:config",question:"显式配置",evidence:"本机材料",source:source)
            try expect(streaming["status"] as? String=="complete" && streaming["responsesStream"] as? Bool==true && streaming["reasoningEffort"] as? String=="low","actual SSE terminal result preserves explicit app parameters")
            let streamingReuse=try await service.run(id:UUID().uuidString,paperID:"test:config",question:"显式配置",evidence:"本机材料",source:source)
            try expect(streamingReuse["reused"] as? Bool==true,"same explicit stream/effort result reused without HTTP")
            try store.updateSettings(["reasoningEffort":"medium"])
            let effortChanged=try await service.run(id:UUID().uuidString,paperID:"test:config",question:"显式配置",evidence:"本机材料",source:source)
            try expect(effortChanged["fingerprint"] as? String != streaming["fingerprint"] as? String,"reasoning effort belongs to paid request fingerprint")
            try store.updateSettings(["responsesStream":false])
            let streamChanged=try await service.run(id:UUID().uuidString,paperID:"test:config",question:"显式配置",evidence:"本机材料",source:source)
            try expect(streamChanged["fingerprint"] as? String != effortChanged["fingerprint"] as? String,"stream setting belongs to request fingerprint")
            for route in ["reasoning-only","empty-only"] {
                try store.updateSettings(["endpoint":server+"/"+route+"/v1","responsesStream":route=="reasoning-only","reasoningEffort":"low"])
                let id=UUID().uuidString;var failure=""
                do{_=try await service.run(id:id,paperID:"test:reasoning",question:"短连接验证",evidence:"只要求简短确认",source:source,check:true)}catch{failure=error.localizedDescription}
                let saved=store.session(id)!,usage=saved["usage"] as? [String:Any] ?? [:],error=saved["error"] as? [String:Any] ?? [:]
                try expect(!failure.isEmpty && saved["status"] as? String=="failed" && saved["text"] as? String=="","no visible text never becomes success")
                try expect(saved["actualModel"] as? String=="reported-reasoning-fixture" && saved["protocol"] as? String=="openai_responses" && usage["input_tokens"] as? Int==155,"no-text response retains actual model, protocol and real raw token usage")
                try expect((usage["output_tokens_details"] as? [String:Any])?["reasoning_tokens"] as? Int==(route=="reasoning-only" ? 4094:5),"reasoning token detail survives incomplete/empty response")
                try expect(error["code"] as? String==(route=="reasoning-only" ? "MODEL_OUTPUT_TRUNCATED":"MODEL_EMPTY_OUTPUT") && saved["finishStatus"] as? String==(route=="reasoning-only" ? "incomplete":"completed"),"accurate reason precedes empty output classification")
                try expect(failure.contains("155") && failure.contains("reported-reasoning-fixture") && failure.contains("不会自动重发"),"native error exposes retained usage rather than generic empty body")
                let recovered=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent("ModelUsage/"+id+"-response.json"))) as! [String:Any]
                try expect((recovered["session"] as? [String:Any])?["usage"] as? NSDictionary==usage as NSDictionary,"signed recovery preserves same failed response usage")
            }
            try store.updateSettings(["responsesStream":false,"reasoningEffort":"default"])
            try store.updateSettings(["endpoint":server+"/incomplete-other/v1"])
            let otherIncomplete=UUID().uuidString;var incompleteRejected=false
            do{_=try await service.run(id:otherIncomplete,paperID:"test:partial",question:"保留部分响应",evidence:"本机夹具",source:source)}catch{incompleteRejected=true}
            let incomplete=store.session(otherIncomplete)!
            try expect(incompleteRejected && incomplete["status"] as? String=="failed" && incomplete["text"] as? String=="真实返回但未完成的部分正文" && (incomplete["error"] as? [String:Any])?["code"] as? String=="MODEL_RESPONSE_INCOMPLETE","other incomplete reason preserves actual partial text without granting completion")
            try store.updateSettings(["endpoint":server+"/coding/v1","model":"mimo-desktop-test","protocol":"chat"])
            let explicitChat=try await service.run(id:UUID().uuidString,paperID:"test:protocol-chat",question:"显式Chat协议",evidence:"只发本机测试材料",source:source)
            try expect(explicitChat["status"] as? String=="complete" && explicitChat["protocol"] as? String=="openai","explicit chat overrides endpoint/model auto inference")
            try store.updateSettings(["endpoint":server+"/deepseek-explicit/v1","model":"deepseek-desktop-test","protocol":"responses"])
            let explicitResponses=try await service.run(id:UUID().uuidString,paperID:"test:protocol-responses",question:"显式Responses协议",evidence:"只发本机测试材料",source:source)
            try expect(explicitResponses["status"] as? String=="complete" && explicitResponses["protocol"] as? String=="openai_responses","explicit Responses overrides deepseek model-name inference")
            try store.updateSettings(["endpoint":server+"/model-unreported/v1","model":"requested-only-fixture","protocol":"chat"])
            let unknownModel=try await service.run(id:UUID().uuidString,paperID:"test:unknown-actual-model",question:"服务未回模型名",evidence:"本机夹具",source:source)
            try expect(unknownModel["status"] as? String=="complete" && unknownModel["actualModel"] is NSNull && unknownModel["model"] as? String=="requested-only-fixture" && unknownModel["charge"] as? String=="amount_unknown","200 without model preserves requested identity separately and actual model unknown")
            let reusedUnknown=try await service.run(id:UUID().uuidString,paperID:"test:unknown-actual-model",question:"服务未回模型名",evidence:"本机夹具",source:source)
            try expect(reusedUnknown["reused"] as? Bool==true && reusedUnknown["actualModel"] is NSNull,"unknown actual model does not prompt a duplicate paid request")
            try store.updateSettings(["model":"desktop-local-test"])
            for (route,category,provider) in [("non-go-balance","quota","insufficient_balance"),("non-go-auth","authentication","invalid_api_key"),("non-go-rate","rate_limit","rate_limit_exceeded")] {
                try store.updateSettings(["endpoint":server+"/"+route+"/v1","model":"desktop-local-test","protocol":"chat"])
                let id=UUID().uuidString
                var rejected=false
                do{_=try await service.run(id:id,paperID:"test:diagnostic",question:"本机错误分类",evidence:"本机夹具，不访问真实服务",source:source)}catch{rejected=true}
                let saved=store.session(id)!,error=saved["error"] as? [String:Any] ?? [:]
                try expect(rejected && saved["status"] as? String=="failed" && error["category"] as? String==category && error["providerCode"] as? String==provider,"non-Go \(route) preserves accurate bounded category/provider detail")
                try expect(saved["actualModel"] is NSNull,"failed HTTP response never invents actual model from requested model")
                let message=error["message"] as? String ?? ""
                try expect(message.count<=1500 && !message.contains("test-only-not-a-real-key") && message.contains("[redacted]"),"provider diagnostic redacts test credential and bounds message")
            }
            try store.updateSettings(["endpoint":server+"/non-go-redact-boundary/v1","protocol":"chat"])
            let boundaryID=UUID().uuidString
            var boundaryRejected=false
            do{_=try await service.run(id:boundaryID,paperID:"test:diagnostic-boundary",question:"截断边界脱敏",evidence:"只有假key本机测试",source:source)}catch{boundaryRejected=true}
            let boundaryError=store.session(boundaryID)?["error"] as? [String:Any] ?? [:]
            let boundaryMessage=boundaryError["message"] as? String ?? "",boundaryProvider=boundaryError["providerCode"] as? String ?? ""
            try expect(boundaryRejected && boundaryError["category"] as? String=="authentication","boundary diagnostic stays failed authentication")
            try expect(!boundaryMessage.contains("test-") && !boundaryProvider.contains("test-") && boundaryMessage.count<=1500 && boundaryProvider.count<=120,"redact full dummy key before truncation; no stable secret prefix survives 1195/115 boundary")
            for mode in ["truncate-chat","truncate-responses"] {
                try store.updateSettings(["endpoint":server+"/"+mode+"/v1","protocol":mode.hasSuffix("responses") ? "responses":"auto"])
                let id=UUID().uuidString
                var failed=false;do{_=try await service.run(id:id,paperID:"test:paper",question:"不能采纳截断",evidence:"本地材料",source:source)}catch{failed=true}
                try expect(failed,"\(mode) returns failure")
                try expect(store.session(id)?["status"] as? String=="failed","\(mode) persisted as failed rather than complete")
                try expect(store.session(id)?["requestIssued"] as? Bool==true,"\(mode) does not refund issued request")
                try expect(store.session(id)?["charge"] as? String=="amount_unknown","\(mode) unknown amount not zero")
            }
            try store.updateSettings(["endpoint":server+"/slow/v1","protocol":"auto"])
            let cancelID=UUID().uuidString
            let operation=Task{@MainActor in try await service.run(id:cancelID,paperID:"test:paper",question:"取消真实在途测试",evidence:"本地材料",source:source)}
            try await Task.sleep(nanoseconds:700_000_000);service.cancel(cancelID)
            var cancelled=false;do{_=try await operation.value}catch{cancelled=true}
            try expect(cancelled,"cancelled request not reported as success")
            try expect(store.session(cancelID)?["status"] as? String=="interrupted","cancel terminal persisted")
            try expect(store.session(cancelID)?["requestIssued"] as? Bool==true && store.session(cancelID)?["charge"] as? String=="unknown","cancel preserves possible consumption")
            let configuration=service.configuration()
            try expect(configuration["key"]==nil && configuration["hasKey"] as? Bool==true,"configuration returns key presence only")
            let all=try String(contentsOf:directory.appendingPathComponent("personal.json"),encoding:.utf8)
            try expect(!all.contains("test-only-not-a-real-key"),"personal persistence never contains API key")
            try store.updateSettings(["endpoint":server+"/good/v1","protocol":"auto","maxTokens":2048])
            let forced=try await service.run(id:UUID().uuidString,paperID:"test:paper",question:"解释这个实际片段",evidence:"这是一段本地测试材料",source:source,force:true)
            try expect(forced["parentSessionID"] as? String==firstID && store.session(firstID)?["status"] as? String=="complete","explicit regeneration preserves original result and parent lineage")
            var duplicateRejected=false;do{_=try await service.run(id:firstID,paperID:"test:paper",question:"重复身份不能覆盖",evidence:"本地材料",source:source,force:true)}catch{duplicateRejected=true}
            try expect(duplicateRejected && store.session(firstID)?["text"] as? String==first["text"] as? String,"duplicate task ID rejected before transport")
            let checked=try await service.run(id:UUID().uuidString,paperID:"test:paper",question:"连接与研究隔离",evidence:"相同证据",source:source,check:true)
            let studied=try await service.run(id:UUID().uuidString,paperID:"test:paper",question:"连接与研究隔离",evidence:"相同证据",source:source)
            try expect(checked["kind"] as? String=="connection-check" && studied["kind"] as? String=="study" && studied["reused"] as? Bool==false,"connection checks cannot become reused research results")
            try expect(checked["fingerprint"] as? String != studied["fingerprint"] as? String,"request purpose and actual check budget have distinct fingerprint")
            let checkedInput=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent("ModelUsage/"+(checked["id"] as! String)+"-input.json"))) as! [String:Any]
            try expect((checkedInput["config"] as? [String:Any])?["maxTokens"] as? Int==4096,"sealed connection input records actual 4096 budget")
            let otherPaper=try await service.run(id:UUID().uuidString,paperID:"test:other-paper",question:"解释这个实际片段",evidence:"这是一段本地测试材料",source:source)
            try expect(otherPaper["reused"] as? Bool==false && otherPaper["paperID"] as? String=="test:other-paper" && otherPaper["fingerprint"] as? String != first["fingerprint"] as? String,"identical evidence from another paper cannot reuse a different paper session")
            // Recreate the crash boundary after a valid response was sealed but before personal.json adopted it.
            let usage=directory.appendingPathComponent("ModelUsage"),responseFile=usage.appendingPathComponent(firstID+"-response.json")
            let recoveryBytes=try Data(contentsOf:responseFile),inputBytes=try Data(contentsOf:inputFile)
            let savedFirst=store.session(firstID)!
            func pendingVersion(_ saved:[String:Any])->[String:Any] {
                var result=saved;result["status"]="pending";result["charge"]="unknown"
                for key in ["response","text","usage","actualModel","protocol","error","reused","endedAt"] {result.removeValue(forKey:key)}
                return result
            }
            let pendingFirst=pendingVersion(savedFirst)
            try store.appendSession(pendingFirst)
            let recovered=try service.recoverSavedResponses()
            try expect(recovered["adopted"] as? Int==1 && store.session(firstID)?["status"] as? String=="complete","valid sealed response adopted with no worker")
            let personalFile=directory.appendingPathComponent("personal.json"),beforeRepeat=try Data(contentsOf:personalFile)
            let repeatedRecovery=try service.recoverSavedResponses()
            try expect(repeatedRecovery["adopted"] as? Int==0 && (repeatedRecovery["alreadyPresent"] as? Int ?? 0)>=1,"recovery is idempotent")
            try expect(try Data(contentsOf:personalFile)==beforeRepeat,"repeat recovery leaves exact store bytes unchanged")
            try store.appendSession(pendingFirst)
            var changedEnvelope=try JSONSerialization.jsonObject(with:recoveryBytes) as! [String:Any]
            var changedSession=changedEnvelope["session"] as! [String:Any];changedSession["text"]="伪造结果";changedSession["response"]="伪造结果";changedEnvelope["session"]=changedSession
            try JSONSerialization.data(withJSONObject:changedEnvelope,options:.sortedKeys).write(to:responseFile,options:.atomic)
            let tampered=try service.recoverSavedResponses()
            try expect((tampered["rejected"] as? [String])?.contains(firstID)==true && store.session(firstID)?["status"] as? String=="pending","response content tamper rejected without state change")
            try expect(FileManager.default.fileExists(atPath:responseFile.path),"tampered recovery evidence retained")
            try recoveryBytes.write(to:responseFile,options:.atomic)
            var changedInput=inputBytes;changedInput.append(0x20);try changedInput.write(to:inputFile,options:.atomic)
            let tamperedInput=try service.recoverSavedResponses()
            try expect((tamperedInput["rejected"] as? [String])?.contains(firstID)==true,"actual original input byte SHA enforced")
            try inputBytes.write(to:inputFile,options:.atomic)
            var otherTerminal=savedFirst;otherTerminal["text"]="已有其他终态";otherTerminal["response"]="已有其他终态"
            try store.appendSession(otherTerminal)
            let conflict=try service.recoverSavedResponses()
            try expect((conflict["rejected"] as? [String])?.contains(firstID)==true && store.session(firstID)?["text"] as? String=="已有其他终态","different existing complete result never overwritten")
            try store.appendSession(pendingFirst)
            let blockedStoreBytes=try Data(contentsOf:personalFile)
            try FileManager.default.removeItem(at:personalFile);try FileManager.default.createDirectory(at:personalFile,withIntermediateDirectories:false)
            let writeFailure=try service.recoverSavedResponses()
            try expect((writeFailure["writeFailures"] as? [String])?.contains(firstID)==true && store.session(firstID)?["status"] as? String=="pending","failed adoption transaction rolls back in-memory state")
            try expect(try Data(contentsOf:responseFile)==recoveryBytes,"failed adoption retains exact paid response bytes")
            try FileManager.default.removeItem(at:personalFile);try blockedStoreBytes.write(to:personalFile,options:.atomic)
            _=try service.recoverSavedResponses()
            try expect(store.session(firstID)?["status"] as? String=="complete","recovery retries persistence without requesting again")
            try store.appendSession(pendingFirst)
            let restarted=ModelService(directory:directory,store:store,keyProvider:{"test-only-not-a-real-key"},resourcesDirectory:resources)
            try expect(restarted.responseRecovery["adopted"] as? Int==1 && store.session(firstID)?["status"] as? String=="complete","startup automatically adopts authenticated saved response")
            let failedSession=(store.value["sessions"] as! [[String:Any]]).first{$0["status"] as? String=="failed"}!
            let failedID=failedSession["id"] as! String
            try store.appendSession(pendingVersion(failedSession));_=try service.recoverSavedResponses()
            try expect(store.session(failedID)?["status"] as? String=="failed" && store.session(failedID)?["charge"] as? String=="amount_unknown","saved failed response recovered without false success or refunded usage")
            try store.appendSession(pendingFirst)
            try JSONSerialization.data(withJSONObject:savedFirst,options:.sortedKeys).write(to:responseFile,options:.atomic)
            let unsigned=try service.recoverSavedResponses()
            try expect((unsigned["rejected"] as? [String])?.contains(firstID)==true && store.session(firstID)?["status"] as? String=="pending","unsigned legacy response cannot grant success")
            try recoveryBytes.write(to:responseFile,options:.atomic);_=try service.recoverSavedResponses()
            let integrityFile=usage.appendingPathComponent("response-integrity.key"),integrityAttributes=try FileManager.default.attributesOfItem(atPath:integrityFile.path)
            try expect(integrityAttributes[.posixPermissions] as? Int==0o600 && (try Data(contentsOf:integrityFile)).count==32,"non-credential integrity material is private and included by normal backup enumeration")
            // Real shared transport journal links each logical request to its start and terminal events.
            var journal:[[String:Any]]=[]
            for file in try FileManager.default.contentsOfDirectory(at:usage,includingPropertiesForKeys:nil) where file.pathExtension=="json" {
                if let value=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as? [String:Any],value["version"] as? String=="llm-usage-v1" {journal.append(value)}
            }
            try expect(!journal.isEmpty,"actual transport journal exists")
            try expect(journal.allSatisfy{($0["runId"] as? String)?.count==36 && ($0["unitId"] as? String)?.count==64},"actual journal keeps normalized session and unit identities")
            let starts=journal.filter{$0["kind"] as? String=="request_started"},terminals=journal.filter{$0["kind"] as? String=="request"}
            try expect(starts.count==24 && terminals.count==23 && terminals.allSatisfy{terminal in starts.contains{$0["eventId"] as? String==terminal["eventId"] as? String}},"actual usage start and terminal share eventID, cancelled request remains honestly unresolved")
            var orphan=pendingFirst;orphan["id"]=UUID().uuidString;try store.appendSession(orphan)
            _=ModelService(directory:directory,store:store,keyProvider:{nil},resourcesDirectory:resources)
            try expect(store.session(orphan["id"] as! String)?["status"] as? String=="interrupted" && store.session(orphan["id"] as! String)?["charge"] as? String=="unknown","restart marks unrecovered pending sessions interrupted without resending")
            print("ModelService PASS \(checks) checks: actual local worker Chat/Responses, full-prompt reuse, truncation, cancel, unknown cost, private key isolation, authenticated zero-request recovery")
        } catch {fputs("ModelService FAIL: \(error.localizedDescription)\n",stderr);exit(1)}
    }
}
