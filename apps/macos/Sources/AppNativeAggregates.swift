import AppKit
import WebKit
import CoreFoundation

extension PaperDigestApp {
    var aggregateReadingAppearance:AggregateReadingAppearance{.init(scheme:store?.setting("appearance") as? String ?? "system",font:(store?.setting("font") as? NSNumber)?.doubleValue ?? 18)}
    func updateNativeAggregateAppearance(){aggregateNativeHost?.updateAppearance(aggregateReadingAppearance)}
    func suspendNativeAggregate(){aggregateNativeHost?.suspend()}
    func restoreNativeAggregateLayout(){emit("aggregates.layout")}
    @objc func focusAggregateBody(){_=aggregateNativeHost?.focusBody()}
    /// Returns true for an aggregate host even while unready, so no old paper is searched.
    func findNativeAggregate()->Bool {
        guard let host=aggregateNativeHost else{return aggregateSession != nil || aggregateTransitionPending}
        guard let lease=host.findLease else{return true}
        let answer=findQuery(host.findTitle)
        guard aggregateNativeHost === host,host.findLease==lease,answer["cancelled"] as? Bool==false,let query=answer["query"] as? String,!query.isEmpty else{return true}
        Task{_=try? await host.find(query,lease:lease)}
        return true
    }
    @objc func focusAggregateNavigation(){_=aggregateNativeHost?.focusNavigation()}

    func retireNativeAggregate() {
        aggregateNativeSequence = 0
        aggregateNativeHost?.retire(); aggregateNativeHost = nil
    }
    func presentNativeAggregate(_ payload: [String: Any], bundleWeb: URL? = nil) async throws -> [String: Any] {
        guard Set(payload.keys) == ["id", "sessionID", "documentReadyNonce", "sequence"],
              let number = payload["sequence"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue > Double(aggregateNativeSequence), number.doubleValue < 9_007_199_254_740_991 else { throw DesktopError.message("汇总布局请求已失效") }
        let session = try aggregateSession(payload)
        try requireAggregateTransitionAvailable()
        guard !aggregateTransitionPending, !session.loading, let document = session.document,
              let access = session.access, access.descriptor == document.source.descriptor,
              let documentNonce = session.readyNonce, payload["documentReadyNonce"] as? String == documentNonce else { throw DesktopError.message("请先读取当前真实汇总正文") }
        aggregateNativeSequence = number.int64Value
        let sequence = aggregateNativeSequence, generation = contextGeneration
        guard let main = web else { throw DesktopError.message("主阅读视图未就绪") }
        let script = """
        const e=document.getElementById('aggregate-view'),m=document.querySelector('.main-pane'),b=document.querySelector('.toolbar');
        const r=x=>{if(!x)return null;const v=x.getBoundingClientRect();return {x:v.x,y:v.y,width:v.width,height:v.height}};
        return {visible:!!e&&!e.hidden&&getComputedStyle(e).display!=='none',blocked:!!document.querySelector('[data-dialog-surface][open]'),width:innerWidth,height:innerHeight,rect:r(e),main:r(m),toolbar:r(b)};
        """
        guard let observed = try await main.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .defaultClient) as? [String: Any] else { throw DesktopError.message("汇总布局未就绪") }
        try Task.checkCancellation(); try requireAggregateTransitionAvailable()
        guard aggregateNativeSequence == sequence, web === main, aggregateSession === session,
              generation == contextGeneration, session.readyNonce == documentNonce, !aggregateTransitionPending else { throw CancellationError() }
        func scalar(_ value: Any?) -> CGFloat? { guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }; return CGFloat(n.doubleValue) }
        func rect(_ raw: Any?) throws -> CGRect { guard let d = raw as? [String: Any], let x = scalar(d["x"]), let y = scalar(d["y"]), let w = scalar(d["width"]), let h = scalar(d["height"]), w > 0, h > 0 else { throw DesktopError.message("汇总布局无效") }; return CGRect(x:x,y:y,width:w,height:h) }
        if observed["blocked"] as? Bool == true { suspendNativeAggregate();return ["native":false,"blocked":true] }
        guard observed["visible"] as? Bool == true, observed["blocked"] as? Bool == false,
              let width = scalar(observed["width"]), let height = scalar(observed["height"]),
              abs(width * main.pageZoom - main.frame.width) <= 0.75, abs(height * main.pageZoom - main.frame.height) <= 0.75 else { throw DesktopError.message("汇总布局已变化") }
        let target = try rect(observed["rect"]), area = try rect(observed["main"]), toolbar = try rect(observed["toolbar"])
        let viewport = CGRect(x:0,y:0,width:width,height:height), allowed = CGRect(x:area.minX,y:toolbar.maxY,width:area.width,height:area.maxY-toolbar.maxY)
        guard viewport.insetBy(dx:-0.75,dy:-0.75).contains(area), area.insetBy(dx:-0.75,dy:-0.75).contains(toolbar), allowed.insetBy(dx:-0.75,dy:-0.75).contains(target), target.width >= 150, target.height >= 120,
              let parent = window?.contentView else { throw DesktopError.message("汇总不能覆盖主导航或工具栏") }
        let frame = CGRect(x:main.frame.minX+target.minX*main.pageZoom,y:main.frame.minY+main.frame.height-target.maxY*main.pageZoom,width:target.width*main.pageZoom,height:target.height*main.pageZoom)
        let binding = session.id + ":" + documentNonce
        if let host = aggregateNativeHost, host.binding == binding { host.updateAppearance(aggregateReadingAppearance);host.attach(in:parent,frame:frame); return ["native":true] }
        aggregateNativeHost?.retire(); aggregateNativeHost = nil
        let hostID = UUID()
        func current() -> Bool { self.aggregateSession === session && self.contextGeneration == generation && session.readyNonce == documentNonce && self.aggregateNativeHost?.id == hostID && !self.terminationPending && !self.maintenanceBusy && !self.storageDetailsActive && !self.nativeTasksRequestedVisible && !self.nativeNotesRequestedVisible }
        let host = try NativeAggregateController(id:hostID,binding:binding,document:document,bundleWeb:bundleWeb ?? Bundle.main.resourceURL!.appendingPathComponent("Web"),navigationSource:main,current:current,link:{[weak self] index in
            guard let self,current() else { throw CancellationError() }
            return try await self.dispatchAggregates("aggregates.link",payload:["id":session.aggregateID,"sessionID":session.id,"index":index])
        },navigate:{[weak self] kind,id in
            guard let self,current(),let source=self.web else { throw CancellationError() }
            let result=try await source.callAsyncJavaScript("return typeof window.paperDigestNativeAggregateNavigate==='function' ? await window.paperDigestNativeAggregateNavigate(sessionID,kind,id) : false",arguments:["sessionID":session.id,"kind":kind,"id":id as Any? ?? NSNull()],in:nil,contentWorld:.page)
            guard result as? Bool == true else { throw CancellationError() }
        },openWebsite:{[weak self] in
            guard let self,current() else { throw CancellationError() }
            _=try await self.dispatchAggregates("aggregates.website",payload:["id":session.aggregateID,"sessionID":session.id])
        },appearance:aggregateReadingAppearance,failed:{[weak self] in
            guard let self,current(),let source=self.web else{return}
            self.retireNativeAggregate()
            Task{[weak self,weak source] in
                guard let self,let source,self.web===source,self.aggregateSession===session,self.contextGeneration==generation,session.readyNonce==documentNonce else{return}
                _=try? await source.callAsyncJavaScript("return window.paperDigestNativeAggregateFailed?.(sessionID,documentNonce) ?? false",arguments:["sessionID":session.id,"documentNonce":documentNonce],in:nil,contentWorld:.page)
            }
        })
        aggregateNativeHost = host; pdfView.isHidden = true; host.attach(in:parent,frame:frame)
        return ["native":true]
    }
}
