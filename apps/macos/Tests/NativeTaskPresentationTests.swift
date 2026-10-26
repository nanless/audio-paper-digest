import AppKit
import Foundation

struct TestFailure: Error { let message: String }
@MainActor final class Barrier {
    private var begun = false
    private var starters: [CheckedContinuation<Void, Never>] = []
    private var finish: CheckedContinuation<Void, Never>?
    func block() async { begun = true; starters.forEach { $0.resume() }; starters = []; await withCheckedContinuation { finish = $0 } }
    func waitStarted() async { if !begun { await withCheckedContinuation { starters.append($0) } } }
    func release() { finish?.resume(); finish = nil }
}
@main @MainActor struct NativeTasks22Tests {
    static var passed = 0, failed = 0
    static let hash = String(repeating: "a", count: 64)
    static func check(_ value: @autoclosure () throws -> Bool, _ message: String) throws { if try !value() { throw TestFailure(message: message) } }
    static func rejects(_ body: () throws -> Void) throws { do { try body() } catch is TestFailure { throw TestFailure(message: "assertion inside rejection") } catch { return }; throw TestFailure(message: "expected rejection") }
    static func run(_ name: String, _ body: () async throws -> Void) async { do { try await body(); passed += 1; print("PASS \(name)") } catch { failed += 1; print("FAIL \(name): \((error as? TestFailure)?.message ?? String(describing: type(of: error)))") } }
    static func job(_ id: String = "job-1", paper: String = "paper-a", command: String = "model.run", status: String = "complete") -> [String: Any] {
        ["id": id, "paperID": paper, "command": command, "status": status, "title": "合成任务 \(id)", "message": "合成原记录", "startedAt": "2026-10-25T08:05:03.123Z"]
    }
    static func session(_ id: String = "job-1", paper: String = "paper-a", kind: String = "study") -> [String: Any] {
        ["id": id, "paperID": paper, "kind": kind, "model": "requested-model", "actualModel": "actual-model", "usage": ["input_tokens": 12, "output_tokens": 34, "total_tokens": 46], "source": ["kind": "pdf-page", "pages": [5], "sourceVersion": "v1", "pdfSHA": hash]]
    }
    static func snapshot(_ jobs: [[String: Any]], sessions: [[String: Any]]? = [], live: Set<String> = []) throws -> NativeTaskSnapshot { try NativeTaskProjection.make(.init(jobs: jobs, sessions: sessions, liveJobIDs: live)) }
    static func details(_ job: [String: Any], _ sessions: [[String: Any]]?) -> String { NativeTaskProjection.metadata(job, sessions: sessions).joined(separator: "\n") }
    static func owner() -> NativeTaskOwner { .init(windowID: UUID(), documentID: UUID(), contextGeneration: 1) }
    static let bounds = NativeTaskRectangle(x: 220, y: 0, width: 850, height: 650)
    static func show(_ route: NativeTaskRouteGate, sequence: Int64 = 1, rectangle: NativeTaskRectangle = .init(x: 220, y: 0, width: 850, height: 650)) throws { try route.accept(.init(owner: route.owner, sequence: sequence, tasks: true, rectangle: rectangle), allowedContent: bounds) }
    static func callbacks(_ body: @escaping (NativeTaskAction, String, String?) async throws -> NativeTaskFeedback) -> NativeTaskCallbacks { .init(cancel: { try await body(.cancel, $0, nil) }, openSaved: { try await body(.openSaved, $0, $1) }, openCloud: { try await body(.openCloud, $0, nil) }, resync: { try await body(.resync, $0, nil) }) }
    static func allViews(_ root: NSView) -> [NSView] { [root] + root.subviews.flatMap(allViews) }
    static func main() async {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        await run("original session source and usage") {
            let s = details(job(), [session()]); try check(s.contains("物理页 5") && s.contains("版本 v1") && s.contains(hash), "original source not displayed")
            try check(s.contains("输入12 · 输出34 · 合计46 tokens") && s.contains("实际模型：actual-model") && s.contains("实际费用金额未知"), "usage/model attribution")
        }
        await run("measured zero and invalid numeric values") {
            for invalid: Any in [true, -1, 1.5, Double.nan, Double.infinity, "12", NSNumber(value: UInt64.max), NSDecimalNumber(string: "1")] { try check(NativeTaskProjection.integer(invalid) == nil, "invalid accepted") }
            try check(NativeTaskProjection.integer(0) == 0 && NativeTaskProjection.integer(9_007_199_254_740_991 as Int64) != nil, "valid boundary")
            try check(NativeTaskProjection.usage(["input_tokens": 0, "output_tokens": false]).contains("输入0 · 输出未知"), "zero unknown collapsed")
        }
        await run("usage aliases and requested model label") {
            var s = session(); s.removeValue(forKey: "actualModel"); s["usage"] = ["prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5]
            let d = details(job(), [s]); try check(d.contains("输入2 · 输出3 · 合计5") && d.contains("请求 requested-model · 实际模型未知"), "model guessed actual")
        }
        await run("cross-paper and wrong-kind no fee attribution") {
            for s in [session(paper: "paper-b"), session(kind: "connection-check")] { let d = details(job(), [s]); try check(d.contains("没有唯一匹配") && !d.contains("输入12"), "foreign usage bound") }
        }
        await run("duplicate session unknown") { let d = details(job(), [session(), session()]); try check(d.contains("没有唯一匹配") && !d.contains("物理页 5"), "duplicate authorized") }
        await run("empty owner only connection check") {
            try check(details(job(paper: ""), [session(paper: "")]).contains("没有唯一匹配"), "ownerless study")
            let d = details(job(paper: "", command: "model.check"), [session(paper: "", kind: "connection-check")]); try check(d.contains("材料依据：连接测试") && d.contains("输入12"), "real empty check rejected")
        }
        await run("session read failure remains unknown") { try check(details(job(), nil).contains("研究记录读取失败"), "failure false empty") }
        await run("reuse marker does not assert zero or repeat old usage") {
            var j = job(); j["result"] = ["reused": true]; let d = details(j, [session("other")]); try check(d.contains("新增派发未单独核验") && !d.contains("输入12") && !d.contains("未新增模型请求"), "reuse minted budget fact")
            j["result"] = ["reused": 1]; try check(!details(j, []).contains("记录标注复用"), "numeric bool accepted")
        }
        await run("unknown task fee not zero") { try check(details(job(command: "future.mystery"), []).contains("类别未识别"), "unknown zero fee") }
        await run("cloud snapshot strict and scoped") {
            var j = job(command: "cloud.upload"); j["material"] = ["kind": "workspace-snapshot", "createdAt": "2026-10-25T08:05:03Z", "fileCount": 83, "sha256": hash]
            try check(details(j, []).contains("实际文件数 83"), "snapshot missing")
            for bad: Any in [true, 0, -1, 100001, "83"] { var m = j["material"] as! [String: Any]; m["fileCount"] = bad; j["material"] = m; try check(!details(j, []).contains("实际文件数"), "bad snapshot count") }
            j["command"] = "model.run"; try check(!details(j, []).contains("完整研究空间快照"), "cloud claimed model")
        }
        await run("restore SHA not unrelated result") { var j = job(command: "app.export"); j["result"] = ["sha256": hash]; try check(!details(j, []).contains("原恢复材料"), "foreign restore marker"); j["command"] = "cloud.restore"; try check(details(j, []).contains("原恢复材料 SHA-256 " + hash), "restore hash missing") }
        await run("time parsing no fabricated now") { try check(NativeTaskProjection.date("not-a-date") == nil && NativeTaskProjection.time(nil) == "时间未知", "fabricated timestamp"); try check(NativeTaskProjection.date("2026-10-25T08:05:03+08:00") != nil, "valid offset") }
        await run("source flags and bad SHA") { var s = session(); s["source"] = ["kind": "pdf-full", "truncated": true, "missingTextPages": [2,3], "pdfSHA": "not-a-hash"]; let d = details(job(), [s]); try check(d.contains("输入已截断") && d.contains("无文字页 2、3 未分析图像") && d.contains("原版本未记录") && !d.contains("not-a-hash"), "basis overclaim") }
        await run("unknown JSON and raw body remain unchanged") {
            var j = job(); j["future"] = ["unknown": [true, "保留"]]; var s = session(); s["answer"] = "SHOULD_NOT_RENDER_PRIVATE_ANSWER"; s["unknown"] = ["original": 23]
            let before = try JSONSerialization.data(withJSONObject: [j,s], options: [.sortedKeys]); let rows = try snapshot([j], sessions: [s]); let after = try JSONSerialization.data(withJSONObject: [j,s], options: [.sortedKeys]); try check(before == after && !rows.rows[0].metadata.joined().contains("SHOULD_NOT_RENDER"), "mutated/exposed original")
        }
        await run("pagination stable original ordering") {
            let rows = (0..<43).map { job("job-\($0)") }; let s = try snapshot(rows)
            try check(s.page(filter: .all, requested: 0).rows.count == 20 && s.page(filter: .all, requested: 1).rows.count == 20 && s.page(filter: .all, requested: 2).rows.count == 3, "page size")
            try check(s.page(filter: .all, requested: 99).rows.last?.jobID == "job-42" && s.page(filter: .all, requested: -10).rows.first?.jobID == "job-0", "order/clamp")
        }
        await run("filter counts and empty page") { let s = try snapshot([job("a", status: "queued"), job("b", status: "running"), job("c", status: "failed"),job("d", status: "complete")]); try check(s.page(filter: .active, requested: 0).total == 2 && s.page(filter: .attention, requested: 0).total == 1, "filters"); try check(try snapshot([]).page(filter: .attention, requested: 10).summary == "0 条任务", "empty truth") }
        await run("duplicate job identities preserve rows disable actions") { let s = try snapshot([job(),job()], sessions: [session()]); try check(s.rows.count == 2 && s.rows.allSatisfy({ $0.actions.isEmpty }) && s.rows[0].rowKey != s.rows[1].rowKey, "duplicate action") }
        await run("actions only narrow original opportunities") {
            let s = try snapshot([job("live", status:"running"),job("cold",status:"running"),job("queued",status:"queued"),job("cloud",command:"cloud.upload"),job("sync",command:"library.sync"),job("saved")],live:["live"])
            try check(s.rows.map(\.actions) == [[.cancel],[],[],[.openCloud],[.resync],[.openSaved]], "action capability widened")
        }
        await run("progress real count bounded") { var j=job(status:"running"); j["progress"]=["completed":0,"total":10]; try check(try snapshot([j]).rows[0].progress == .init(completed:0,total:10), "zero progress"); for p in [["completed":11,"total":10],["completed":true,"total":10],["completed":0,"total":0]] as [[String:Any]] { j["progress"]=p; try check(try snapshot([j]).rows[0].progress == nil, "invalid progress") } }
        await run("record read unavailable not empty") { try rejects { _ = try NativeTaskProjection.make(.init(jobs:nil,sessions:[],liveJobIDs:[])) } }
        await run("native geometry rejects sidebar toolbar and nonfinite") {
            for r in [NativeTaskRectangle(x:0,y:0,width:850,height:650), .init(x:220,y:-1,width:850,height:650),.init(x:220,y:0,width:.nan,height:650),.init(x:220,y:0,width:149,height:650),.init(x:220,y:0,width:851,height:650)] { let g=NativeTaskRouteGate(owner:owner()); try rejects { try show(g,rectangle:r) }; try check(!g.showing,"bad rect left active") }
        }
        await run("sequence ABA and different owner rejected") { let g=NativeTaskRouteGate(owner:owner()); try show(g,sequence:2); try rejects{try show(g,sequence:1)}; try check(g.showing && g.sequence == 2,"old event retired current"); try rejects{try g.accept(.init(owner:owner(),sequence:3,tasks:true,rectangle:bounds),allowedContent:bounds)}; try check(g.showing,"foreign event retired current") }
        await run("new malformed layout retires old lease") { let g=NativeTaskRouteGate(owner:owner()); try show(g); let s=try snapshot([job()]); let lease=try g.issue(row:s.rows[0],action:.openSaved); try rejects{try show(g,sequence:2,rectangle:.init(x:0,y:0,width:20,height:20))}; try rejects{_ = try g.validate(lease,current:s)} }
        await run("owner change and same-owner replay remain invalid") { let g=NativeTaskRouteGate(owner:owner()); try show(g,sequence:5); let s=try snapshot([job()]); let l=try g.issue(row:s.rows[0],action:.openSaved); g.replaceOwner(g.owner); try rejects{try show(g,sequence:5)}; g.replaceOwner(owner()); try show(g); try rejects{_ = try g.validate(l,current:s)} }
        await run("current row mutation invalidates action") { let g=NativeTaskRouteGate(owner:owner()); try show(g); let s=try snapshot([job()],sessions:[session()]); let l=try g.issue(row:s.rows[0],action:.openSaved); var changed=session();changed["source"]=["kind":"pdf-page","pages":[6]]; try rejects{_ = try g.validate(l,current:snapshot([job()],sessions:[changed]))} }
        await run("real AppKit views and literal text") {
            var j=job();j["title"]="<script>literal</script>";let g=NativeTaskRouteGate(owner:owner());let c=NativeTasksController(route:g,provider:{.init(jobs:[j],sessions:[],liveJobIDs:[])},callbacks:callbacks{_,_,_ in .previewOnly});try c.apply(.init(owner:g.owner,sequence:1,tasks:true,rectangle:bounds),allowedContent:bounds)
            let views=allViews(c.view);try check(views.contains{$0 is NSScrollView} && views.contains{($0 as? NSTextField)?.stringValue == "<script>literal</script>"},"not literal native");try check(!views.contains{String(describing:type(of:$0)).contains("WKWebView")},"second WK")
            try check(c.actionButtons.count == 1 && c.actionButtons[0].isEnabled && c.view.accessibilityLabel() == "后台任务", "native button/label missing")
        }
        await run("real native button narrow callback") { var received:[String]=[];let g=NativeTaskRouteGate(owner:owner());let c=NativeTasksController(route:g,provider:{.init(jobs:[job()],sessions:[],liveJobIDs:[])},callbacks:callbacks{a,id,paper in received=[a.rawValue,id,paper ?? ""];return .previewOnly});try c.apply(.init(owner:g.owner,sequence:1,tasks:true,rectangle:bounds),allowedContent:bounds);c.actionButtons[0].performClick(nil);await c.lastActionTask?.value;try check(received == ["openSaved","job-1","paper-a"] && c.noticeText.contains("只读预览"),"button delegate") }
        await run("stale provider produces zero callbacks") { var jobs=[job()];var calls=0;let g=NativeTaskRouteGate(owner:owner());let c=NativeTasksController(route:g,provider:{.init(jobs:jobs,sessions:[],liveJobIDs:[])},callbacks:callbacks{_,_,_ in calls+=1;return .opened});try c.apply(.init(owner:g.owner,sequence:1,tasks:true,rectangle:bounds),allowedContent:bounds);let l=c.actionButtons[0].lease!;jobs=[job(paper:"other-paper")];await c.invoke(l);try check(calls == 0 && c.noticeText.contains("已经变化"),"late source callback") }
        await run("read failure retains original visible records disables actions") { var bad=false;let g=NativeTaskRouteGate(owner:owner());let c=NativeTasksController(route:g,provider:{if bad{throw NativeTaskPresentationError.recordsUnavailable};return .init(jobs:[job()],sessions:[],liveJobIDs:[])},callbacks:callbacks{_,_,_ in .opened});try c.apply(.init(owner:g.owner,sequence:1,tasks:true,rectangle:bounds),allowedContent:bounds);let fingerprint=c.snapshot!.rows[0].fingerprint;bad=true;c.reload();try check(c.readFailed && c.snapshot!.rows[0].fingerprint == fingerprint && c.actionButtons.allSatisfy{!$0.isEnabled},"read failure erased truth");bad=false;c.reload();try check(!c.readFailed && c.actionButtons.allSatisfy(\.isEnabled),"read recovery") }
        await run("duplicate pending callback cannot dispatch twice") { let gate=Barrier();var calls=0;let g=NativeTaskRouteGate(owner:owner());let c=NativeTasksController(route:g,provider:{.init(jobs:[job()],sessions:[],liveJobIDs:[])},callbacks:callbacks{_,_,_ in calls+=1;await gate.block();return .opened});try c.apply(.init(owner:g.owner,sequence:1,tasks:true,rectangle:bounds),allowedContent:bounds);let l=c.actionButtons[0].lease!;let task=Task{await c.invoke(l)};await gate.waitStarted();await c.invoke(l);try check(calls == 1,"double delegate");gate.release();await task.value }
        await run("late completion cannot reopen retired route") { let gate=Barrier();let g=NativeTaskRouteGate(owner:owner());let c=NativeTasksController(route:g,provider:{.init(jobs:[job()],sessions:[],liveJobIDs:[])},callbacks:callbacks{_,_,_ in await gate.block();return .opened});try c.apply(.init(owner:g.owner,sequence:1,tasks:true,rectangle:bounds),allowedContent:bounds);let l=c.actionButtons[0].lease!;let task=Task{await c.invoke(l)};await gate.waitStarted();c.retire();let notice=c.noticeText;gate.release();await task.value;try check(c.view.isHidden && c.noticeText == notice && !g.showing,"old completion revived UI") }
        await run("callback does not fabricate terminal state") {let j=job(status:"running");let g=NativeTaskRouteGate(owner:owner());let c=NativeTasksController(route:g,provider:{.init(jobs:[j],sessions:[],liveJobIDs:["job-1"])},callbacks:callbacks{_,_,_ in .requested});try c.apply(.init(owner:g.owner,sequence:1,tasks:true,rectangle:bounds),allowedContent:bounds);await c.invoke(c.actionButtons[0].lease!);try check(c.snapshot?.rows[0].status == "running" && c.noticeText.contains("查看实际状态"),"invented cancellation") }
        await run("initial unreadable source not false empty") { let g=NativeTaskRouteGate(owner:owner());let c=NativeTasksController(route:g,provider:{ throw NativeTaskPresentationError.recordsUnavailable },callbacks:callbacks{_,_,_ in .opened});_ = c.view;try check(c.snapshot == nil && c.readFailed && c.actionButtons.isEmpty && allViews(c.view).compactMap{$0 as? NSTextField}.contains{$0.stringValue.contains("暂时无法读取任务")},"initial false empty") }
        await run("cancelled UI task no delegate") { var calls=0;let g=NativeTaskRouteGate(owner:owner());let c=NativeTasksController(route:g,provider:{.init(jobs:[job()],sessions:[],liveJobIDs:[])},callbacks:callbacks{_,_,_ in calls+=1;return .opened});try c.apply(.init(owner:g.owner,sequence:1,tasks:true,rectangle:bounds),allowedContent:bounds);let lease=c.actionButtons[0].lease!;let t=Task{await Task.yield();await c.invoke(lease)};t.cancel();await t.value;try check(calls == 0,"cancelled delegate dispatched") }
        await run("callback failure does not expose raw error") { struct UnsafeError: Error,CustomStringConvertible {var description:String{"SYNTHETIC_RAW_DETAIL_NOT_FOR_UI"}};let g=NativeTaskRouteGate(owner:owner());let c=NativeTasksController(route:g,provider:{.init(jobs:[job()],sessions:[],liveJobIDs:[])},callbacks:callbacks{_,_,_ in throw UnsafeError()});try c.apply(.init(owner:g.owner,sequence:1,tasks:true,rectangle:bounds),allowedContent:bounds);await c.invoke(c.actionButtons[0].lease!);try check(c.noticeText.contains("本次入口未完成") && !c.noticeText.contains("SYNTHETIC_RAW"),"raw error exposed") }
        await run("native test opens no windows") {try check(NSApp.windows.isEmpty,"unexpected window")}
        await run("saved global sync records describe directory scope and retain raw context") {
            let fixture=URL(fileURLWithPath:#filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/native-library-sync-context.json")
            let original=try Data(contentsOf:fixture)
            let object=try JSONSerialization.jsonObject(with:original) as! [String:Any],raw=object["rows"] as! [[String:Any]]
            let value=try snapshot(raw)
            try check(value.rows.count==4,"actual redacted row count changed")
            for (row,job) in zip(value.rows,raw) {
                try check(row.title=="同步网站目录","saved reading title mislabels whole-directory operation")
                try check(row.metadata.first=="对象身份：全站目录","saved paper ID mislabels whole-directory scope")
                let metadata=row.metadata.joined(separator:"\n")
                for key in ["title","paperID","identity"] {if let text=job[key] as? String,!text.isEmpty{try check(metadata.contains(text),"original raw context disappeared")}}
                try check(row.paperID==NativeTaskProjection.identifier(job["paperID"]),"changed private lease owner instead of presentation")
                try check(row.actions==[.resync],"global action changed")
            }
            try check(try Data(contentsOf:fixture)==original,"source fixture bytes changed")
        }
        await run("only exact command controls global scope, never raw title or prefix") {
            for command in ["library.article","library.sync.single","model.run"] {
                var raw=job(command:command);raw["title"]="同步网站目录"
                let row=try snapshot([raw]).rows[0]
                try check(row.title=="同步网站目录" && row.metadata.first=="对象身份：paper-a","title or prefix incorrectly granted global scope")
                try check(!row.metadata.joined().contains("不代表同步范围"),"non-global metadata changed")
            }
        }
        await run("missing global raw context remains honestly absent") {
            let raw:[String:Any]=["id":"synthetic-empty-global","command":"library.sync","status":"complete"]
            let row=try snapshot([raw]).rows[0]
            try check(row.title=="同步网站目录" && row.metadata.first=="对象身份：全站目录","global scope needs invented paper")
            try check(!row.metadata.joined().contains("原记录上下文"),"invented unavailable history")
        }
        await run("duplicate global IDs do not gain resync authority") {
            let raw=job(command:"library.sync")
            let rows=try snapshot([raw,raw]).rows
            try check(rows.allSatisfy{$0.actions.isEmpty && $0.title=="同步网站目录"},"scope fix changed duplicate capability guard")
        }
        await run("global display ignores unrelated paid session but preserves unknown fee rules") {
            let row=try snapshot([job(command:"library.sync")],sessions:[session()]).rows[0]
            try check(row.metadata.contains("模型费用：本任务无需本地模型请求"),"global sync inherited model usage")
            try check(!row.metadata.joined().contains("输入12"),"paid record attached to global task")
        }
        await run("global projection never mutates original job JSON") {
            let raw=job(command:"library.sync")
            let before=try JSONSerialization.data(withJSONObject:raw,options:[.sortedKeys])
            _=try snapshot([raw])
            let after=try JSONSerialization.data(withJSONObject:raw,options:[.sortedKeys])
            try check(before==after,"rewrote original history")
        }
        let result:[String:Any] = ["passed":passed,"failed":failed,"syntheticOnly":true,"windowsOpened":NSApp.windows.count,"serviceCalls":0,"keychainAccess":false,"fullMainCompiled":false,"actualAXInspection":false]
        if CommandLine.arguments.count == 2 { let data=try! JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]);try! data.write(to:URL(fileURLWithPath:CommandLine.arguments[1])) }
        print("RESULT \(passed) passed / \(failed) failed");exit(failed == 0 ? 0:1)
    }
}
