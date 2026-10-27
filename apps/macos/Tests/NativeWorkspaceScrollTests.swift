import AppKit

private struct ScrollFailure:Error { let message:String }
@MainActor final class ScrollWindow:NSWindow { override var isKeyWindow:Bool {true} }
@MainActor final class ScrollSource:NSView { override var acceptsFirstResponder:Bool {true} }
@main @MainActor struct NativeWorkspaceScrollTests {
    static var passed=0,failed=0
    static func check(_ value:Bool,_ message:String)throws {if !value{throw ScrollFailure(message:message)}}
    static func run(_ name:String,_ body:()throws->Void){do{try body();passed+=1;print("PASS "+name)}catch{failed+=1;print("FAIL "+name+": "+String(describing:error))}}
    @MainActor struct Harness {
        let window:ScrollWindow, source:ScrollSource, controller:NativeTasksController, scroll:NSScrollView
        func close(){controller.retire();window.close()}
        func bottom()throws {
            window.makeFirstResponder(source)
            let e=NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:[.control,.shift],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:window.windowNumber,context:nil,characters:"\t",charactersIgnoringModifiers:"\t",isARepeat:false,keyCode:48)!
            NSApp.sendEvent(e);controller.view.layoutSubtreeIfNeeded()
            try check(window.firstResponder===controller.actionButtons.last,"real reverse native entry missed last row")
            try check(scroll.contentView.bounds.origin.y>100,"fixture did not reach bottom")
        }
        func next()throws {let button=findButtons(controller.view).first{$0.title=="下一页"}!;window.makeFirstResponder(button);button.performClick(nil);controller.view.layoutSubtreeIfNeeded()}
    }
    static func findScroll(_ v:NSView)->NSScrollView?{if let s=v as? NSScrollView{return s};return v.subviews.compactMap{findScroll($0)}.first}
    static func findButtons(_ v:NSView)->[NSButton]{(v as? NSButton).map{[$0]} ?? v.subviews.flatMap{findButtons($0)}}
    static func make()throws->Harness {
        let w=ScrollWindow(contentRect:.init(x:0,y:0,width:1000,height:700),styleMask:[.titled],backing:.buffered,defer:false);w.isReleasedWhenClosed=false
        let root=NSView(frame:.init(x:0,y:0,width:1000,height:700));w.contentView=root
        let source=ScrollSource(frame:root.bounds);root.addSubview(source);w.makeFirstResponder(source)
        let owner=NativeTaskOwner(windowID:UUID(),documentID:UUID(),contextGeneration:0)
        let c=NativeTasksController(route:.init(owner:owner),provider:{.init(jobs:(1...60).map{["id":"scroll-\(String(format:"%03d",$0))","paperID":"A","command":"library.article","status":"failed","error":"Isolated scroll fixture, no operation or user material"]},sessions:[],liveJobIDs:[])},callbacks:.init(sourceBound:{_ in .previewOnly}))
        root.addSubview(c.view);c.prepareForLayout(sequence:1,keyboardSource:source)
        let rect=NativeTaskRectangle(x:0,y:0,width:800,height:600)
        try c.apply(.init(owner:owner,sequence:1,tasks:true,rectangle:rect),allowedContent:rect);c.view.layoutSubtreeIfNeeded()
        return .init(window:w,source:source,controller:c,scroll:findScroll(c.view)!)
    }
    @MainActor struct NotesHarness {
        let window:ScrollWindow,source:ScrollSource,controller:NativeNotesController,scroll:NSScrollView
        func close(){controller.retire();window.close()}
        func bottom()throws {
            window.makeFirstResponder(source)
            for i in 0..<20 {let e=NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:i==0 ? [.control]:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:window.windowNumber,context:nil,characters:"\t",charactersIgnoringModifiers:"\t",isARepeat:false,keyCode:48)!;NSApp.sendEvent(e)}
            controller.view.layoutSubtreeIfNeeded();try check(window.firstResponder===controller.buttons.last,"notes actual Tab missed last row");try check(scroll.contentView.bounds.origin.y>100,"notes fixture not bottom")
        }
        func next()throws {let b=findButtons(controller.view).first{$0.title=="下一页"}!;window.makeFirstResponder(b);b.performClick(nil);controller.view.layoutSubtreeIfNeeded()}
    }
    static func makeNotes()throws->NotesHarness {
        let w=ScrollWindow(contentRect:.init(x:0,y:0,width:1000,height:700),styleMask:[.titled],backing:.buffered,defer:false);w.isReleasedWhenClosed=false
        let root=NSView(frame:.init(x:0,y:0,width:1000,height:700));w.contentView=root;let source=ScrollSource(frame:root.bounds);root.addSubview(source);w.makeFirstResponder(source)
        let owner=NativeTaskOwner(windowID:UUID(),documentID:UUID(),contextGeneration:0)
        let c=NativeNotesController(route:.init(owner:owner),provider:{let notes=Dictionary(uniqueKeysWithValues:(1...60).map{("N-\(String(format:"%03d",$0))",["text":"Synthetic isolated notes viewport fixture, never user records.","revision":0] as [String:Any])});return try NativeNotesProjection.make(["notes":notes,"annotations":[:]])},open:{_ in},close:{})
        root.addSubview(c.view);c.prepareForLayout(sequence:1,keyboardSource:source);let rect=NativeTaskRectangle(x:0,y:0,width:800,height:600);try c.apply(.init(owner:owner,sequence:1,notes:true,rectangle:rect),allowed:rect);c.view.layoutSubtreeIfNeeded()
        return .init(window:w,source:source,controller:c,scroll:findScroll(c.view)!)
    }
    static func main()throws {
        _=NSApplication.shared;NSApp.setActivationPolicy(.prohibited)
        run("real reverse entry then header Next Page resets new-page viewport") {let h=try make();defer{h.close()};try h.bottom();let old=h.scroll.contentView.bounds.origin.y;try h.next();try check(h.controller.pageIndex==1,"next page not applied");print("MEASURE next old=\(old) new=\(h.scroll.contentView.bounds.origin.y)");try check(h.scroll.contentView.bounds.origin.y<1,"new page retained old bottom");try check(h.scroll.documentVisibleRect.contains(h.controller.actionButtons.first!.convert(h.controller.actionButtons.first!.bounds,to:h.scroll.documentView!)),"new first task action not visible")}
        run("filter change resets viewport even when matching rows remain scrollable") {let h=try make();defer{h.close()};try h.bottom();h.controller.setFilter(.attention);try check(h.controller.filter == .attention && h.controller.pageIndex==0,"filter failed");try check(h.scroll.contentView.bounds.origin.y<1,"new filter retained old bottom")}
        run("same-page reread preserves exact scroll position and row focus") {let h=try make();defer{h.close()};try h.bottom();let old=h.scroll.contentView.bounds.origin.y;let id=(h.window.firstResponder as? NativeTaskActionButton)?.lease?.jobID;h.controller.reload();try check(abs(h.scroll.contentView.bounds.origin.y-old)<1,"same-page reread jumped");try check((h.window.firstResponder as? NativeTaskActionButton)?.lease?.jobID==id,"same-page row focus lost")}
        run("same effective page no-op preserves position") {let h=try make();defer{h.close()};try h.bottom();let old=h.scroll.contentView.bounds.origin.y;h.controller.setPage(0);try check(abs(h.scroll.contentView.bounds.origin.y-old)<1,"no-op page jumped")}
        run("previous page resets viewport after bottom entry on later page") {let h=try make();defer{h.close()};try h.next();try h.bottom();h.controller.setPage(0);try check(h.controller.pageIndex==0 && h.scroll.contentView.bounds.origin.y<1,"previous page retained bottom")}
        run("same-page accepted passive layout preserves position without asynchronous focus restore") {let h=try make();defer{h.close()};try h.bottom();let old=h.scroll.contentView.bounds.origin.y;h.controller.prepareForLayout(sequence:2,keyboardSource:h.source);let rect=NativeTaskRectangle(x:0,y:0,width:800,height:600);try h.controller.apply(.init(owner:h.controller.route.owner,sequence:2,tasks:true,rectangle:rect),allowedContent:rect);try check(abs(h.scroll.contentView.bounds.origin.y-old)<1,"same-page layout jumped");try check(!(h.window.firstResponder is NativeTaskActionButton),"passive layout restored row focus")}
        run("notes actual Tab to last row then header next resets top") {let h=try makeNotes();defer{h.close()};try h.bottom();let old=h.scroll.contentView.bounds.origin.y;try h.next();print("MEASURE notes next old=\(old) new=\(h.scroll.contentView.bounds.origin.y)");try check(h.controller.pageIndex==1 && h.scroll.contentView.bounds.origin.y<1,"notes next page retained bottom");try check(h.scroll.documentVisibleRect.contains(h.controller.buttons.first!.convert(h.controller.buttons.first!.bounds,to:h.scroll.documentView!)),"notes new first action not visible")}
        run("notes previous page resets top") {let h=try makeNotes();defer{h.close()};try h.next();try h.bottom();h.controller.setPage(0);try check(h.controller.pageIndex==0 && h.scroll.contentView.bounds.origin.y<1,"notes previous retained bottom")}
        run("notes same-page reread and no-op retain position and focused row") {let h=try makeNotes();defer{h.close()};try h.bottom();let old=h.scroll.contentView.bounds.origin.y,id=(h.window.firstResponder as? NativeNotesButton)?.lease?.row.paperID;h.controller.reload();h.controller.setPage(0);try check(abs(h.scroll.contentView.bounds.origin.y-old)<1 && (h.window.firstResponder as? NativeNotesButton)?.lease?.row.paperID==id,"notes same page lost scroll/focus")}
        run("notes passive same-page layout retains position without restoring focus") {let h=try makeNotes();defer{h.close()};try h.bottom();let old=h.scroll.contentView.bounds.origin.y;h.controller.prepareForLayout(sequence:2,keyboardSource:h.source);let rect=NativeTaskRectangle(x:0,y:0,width:800,height:600);try h.controller.apply(.init(owner:h.controller.route.owner,sequence:2,notes:true,rectangle:rect),allowed:rect);try check(abs(h.scroll.contentView.bounds.origin.y-old)<1 && !(h.window.firstResponder is NativeNotesButton),"notes passive layout changed scroll or restored focus")}
        print("RESULT \(passed) passed / \(failed) failed");if failed>0{exit(1)}
    }
}
