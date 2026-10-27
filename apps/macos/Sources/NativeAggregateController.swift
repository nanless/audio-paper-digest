import AppKit
import WebKit

private final class AggregateDocumentScheme: NSObject, WKURLSchemeHandler {
    let url: URL, bytes: Data
    private let lock = NSLock()
    private var active = true
    init(url: URL, bytes: Data) { self.url = url; self.bytes = bytes }
    func invalidate() { lock.lock(); active = false; lock.unlock() }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        lock.lock(); let allowed = active; lock.unlock()
        guard allowed, task.request.url == url else { task.didFailWithError(URLError(.noPermissionsToReadFile)); return }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store"])!
        task.didReceive(response); task.didReceive(bytes); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
private final class AggregateContainerView: NSView {
    var changed: (() -> Void)?
    override var isFlipped: Bool { true }
    override func layout() { super.layout(); changed?() }
    override func viewDidChangeEffectiveAppearance(){super.viewDidChangeEffectiveAppearance();updatePalette()}
    override func viewDidMoveToWindow(){super.viewDidMoveToWindow();updatePalette()}
    func updatePalette(){effectiveAppearance.performAsCurrentDrawingAppearance{layer?.backgroundColor=NSColor.windowBackgroundColor.cgColor}}
}

struct AggregateReadingAppearance:Equatable {
    let scheme:String
    let font:CGFloat
    init(scheme:String="system",font:Double=18){self.scheme=["light","dark"].contains(scheme) ? scheme:"system";self.font=CGFloat(font.isFinite ? min(24,max(16,font)):18)}
}

/// A visible read-only component. Only Core can construct it from its canonical presentation.
@MainActor final class NativeAggregateController: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    let id: UUID, binding: String
    let view: NSView
    private let container: AggregateContainerView
    private let title = NSTextField(wrappingLabelWithString: "")
    private let status = NSTextField(wrappingLabelWithString: "")
    private let back = NSButton(title: "返回", target: nil, action: nil)
    private let website = NSButton(title: "打开原站", target: nil, action: nil)
    private let source = NSButton(title: "来源与离线状态", target: nil, action: nil)
    private let outline = NSPopUpButton(frame:.zero,pullsDown:true)
    private let sourceText = NSTextView()
    private let readBody = NSButton(title: "阅读正文", target: nil, action: nil)
    private weak var navigationSource: WKWebView?
    private let sourceScroll = NSScrollView()
    private let web: WKWebView
    private let scheme: AggregateDocumentScheme
    private let documentURL: URL
    private let nonce: String
    private var eventNonce:String?
    private var bodyFailurePending=false
    private let current: () -> Bool
    private let link: (Int) async throws -> [String: Any]
    private let navigate: (String, String?) async throws -> Void
    private let openWebsite: () async throws -> Void
    private var retired = false, ready = false
    private var keyboardMonitor:Any?
    private weak var keyboardWindow:NSWindow?
    private let notice: String
    private let shortStatus:String
    private let sourceContents:String
    private let headings:[String]
    private var readingAppearance:AggregateReadingAppearance
    private var appearanceSequence=0
    private var findSequence=0
    #if PAPER_DIGEST_TESTS
    var beforeFindCompletion:(() async -> Void)?
    #endif
    private var layingOut=false
    private let failed:()->Void


    init(id: UUID, binding: String, document: AggregatePresentationDocument, bundleWeb: URL, navigationSource: WKWebView,
         current: @escaping () -> Bool, link: @escaping (Int) async throws -> [String: Any],
         navigate: @escaping (String, String?) async throws -> Void,
         openWebsite: @escaping () async throws -> Void, appearance:AggregateReadingAppearance = .init(), failed:@escaping()->Void = {}) throws {
        self.id = id; self.binding = binding; self.navigationSource = navigationSource; self.current = current; self.readingAppearance=appearance; self.failed=failed; self.link = link; self.navigate = navigate; self.openWebsite = openWebsite
        let summary=Self.summary(document)
        shortStatus=summary.status;sourceContents=summary.source
        let tree=try XMLDocument(xmlString:"<div>"+document.displayHTML+"</div>",options:[.nodeLoadExternalEntitiesNever,.nodePreserveWhitespace])
        headings=try tree.nodes(forXPath:".//*").compactMap{node in guard let e=node as? XMLElement,["h2","h3"].contains(e.name?.lowercased() ?? "") else{return nil};return e.stringValue ?? ""}
        nonce = UUID().uuidString.lowercased();eventNonce=nonce
        documentURL = URL(string: "paperapp://aggregate/document/" + nonce)!
        let css = try String(contentsOf: bundleWeb.appendingPathComponent("aggregate-native-body.css"), encoding: .utf8)
        let renderer = try String(contentsOf: bundleWeb.appendingPathComponent("aggregate-native-renderer.js"), encoding: .utf8)
        let katex = try String(contentsOf: bundleWeb.appendingPathComponent("vendor/katex/katex.min.js"), encoding: .utf8)
        let html = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'\"><title>" + htmlEscape(document.source.descriptor.titleZh.isEmpty ? document.source.descriptor.title : document.source.descriptor.titleZh) + "</title><style>" + css + "</style></head><body><main>" + document.displayHTML + "</main></body></html>"
        scheme = AggregateDocumentScheme(url: documentURL, bytes: Data(html.utf8))
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.setURLSchemeHandler(scheme, forURLScheme: "paperapp")
        let initialAppearance=String(data:try JSONSerialization.data(withJSONObject:["scheme":appearance.scheme,"font":Double(appearance.font)]),encoding:.utf8)!
        configuration.userContentController.addUserScript(WKUserScript(source: "window.__nativeAggregateNonce='" + nonce + "';window.__nativeAggregateInitialAppearance="+initialAppearance+";\n" + katex + "\n" + renderer, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        web = WKWebView(frame: .zero, configuration: configuration)
        container = AggregateContainerView(frame: .zero); view = container
        notice = document.readNotice
        super.init()
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .defaultClient, name: "aggregateReader")
        web.navigationDelegate = self
        title.stringValue = document.source.descriptor.titleZh.isEmpty ? document.source.descriptor.title : document.source.descriptor.titleZh
        title.font = .systemFont(ofSize: 22, weight: .semibold)
        status.stringValue = "正在呈现正文 · " + notice; status.font = .systemFont(ofSize: 12)
        back.target = self; back.action = #selector(goBack)
        website.target = self; website.action = #selector(goWebsite)
        source.target = self; source.action = #selector(toggleSource)
        readBody.target = self; readBody.action = #selector(goBody); readBody.isEnabled = false
        readBody.setAccessibilityHelp("按 Control-Tab 阅读正文；按 Control-Shift-Tab 返回页面导航。")
        readBody.toolTip = "阅读正文（Control-Tab）；返回页面导航（Control-Shift-Tab）"
        back.nextKeyView = website; website.nextKeyView = source; source.nextKeyView = readBody; readBody.nextKeyView = web; web.nextKeyView = navigationSource
        title.isSelectable=true;title.maximumNumberOfLines=0;title.lineBreakMode = .byWordWrapping
        status.maximumNumberOfLines=0;status.lineBreakMode = .byWordWrapping
        sourceText.isEditable=false;sourceText.isSelectable=true;sourceText.isRichText=false;sourceText.isHorizontallyResizable=false
        sourceText.textContainerInset=NSSize(width:10,height:10);sourceText.textContainer?.widthTracksTextView=true
        sourceText.string=sourceContents;sourceScroll.documentView=sourceText;sourceScroll.hasVerticalScroller=true;sourceScroll.isHidden=true
        outline.addItem(withTitle:"本页目录");outline.item(at:0)?.tag = -1;outline.item(at:0)?.isEnabled=false
        for (index,value) in headings.prefix(2048).enumerated(){outline.addItem(withTitle:value);outline.lastItem?.tag=index}
        if headings.count>2048{outline.addItem(withTitle:"其余章节可在正文中阅读");outline.lastItem?.isEnabled=false}
        outline.target=self;outline.action=#selector(goOutline);outline.isEnabled=false;outline.setAccessibilityLabel("本页目录")
        source.nextKeyView=outline;outline.nextKeyView=readBody
        container.wantsLayer = true; container.updatePalette()
        for child in [title, status, back, website, source, outline, readBody, sourceScroll, web] as [NSView] { container.addSubview(child) }
        container.changed = { [weak self] in self?.layout() }; applyNativeAppearance()
    }
    func attach(in parent: NSView, frame: NSRect) {
        guard !retired, current(), view.superview == nil || view.superview === parent else { return }
        if view.superview == nil { parent.addSubview(view) }
        if bodyFailurePending{presentationFailed();return}
        view.frame = frame; layout(); monitorKeyboardWindow(view.window)
        if web.url == nil {eventNonce=nonce;web.load(URLRequest(url: documentURL))}
        else {applyBodyAppearance();if !ready {requestReady()}}
    }
    private static func summary(_ document:AggregatePresentationDocument)->(status:String,source:String){
        let d=document.source.descriptor
        let kind:[PublishedAggregate.Kind:String]=[.daily:"日更汇总",.conference:"会议汇总与专题",.page:"网站页面"]
        let rows=document.imageRender?.manifest.images
        let saved=rows?.filter{$0.sha256 != nil}.count ?? 0,total=rows?.count ?? document.source.resources.count
        var short=[kind[d.kind]!,d.displayDate ?? "网站日期未记录",document.readNotice]
        if total>0{short.append("图片 \(saved)/\(total) 已保存");if saved<total{short.append("仍有 \(total-saved) 项图片未保存")}}
        var source=["类别："+kind[d.kind]!,"网站日期："+(d.displayDate ?? "未记录"),"原始日期字段："+d.rawDate,"网站原页："+d.sourceURL,"原快照保存时间："+document.source.fetchedAt,"本次网站核验："+(document.validatedAt ?? "未重新核验"),"原始网页 SHA-256："+document.source.rawHTMLSHA256,"正文 SHA-256："+document.source.sanitizedBodySHA256,"目录清单 SHA-256："+d.source.manifestSHA256,"目录分片 SHA-256："+d.source.shardSHA256,document.readNotice]
        source += document.source.notices.map{document.imageRender != nil && $0=="部分图片尚未保存，不能称为完整离线页面。" ? "原正文修订首次保存时未含图片；独立图片修订状态见下。":$0}
        if !document.imageNotice.isEmpty{source.append(document.imageNotice)}
        if let render=document.imageRender{
            source += ["图片资源修订 SHA-256："+render.manifestSHA256,"图片派生版本："+render.manifest.contract,"图片保存观察时间："+render.manifest.observedAt,"图文派生正文 SHA-256："+render.manifest.renderedBodySHA256]
            for r in render.manifest.images{
                var row=["图片 \(r.slot.index+1)："+(r.missingReason ?? "已核验保存"),"原图片地址："+(r.slot.sourceURL ?? "原图片地址无效"),"替代文字："+r.slot.alternative,"图注："+r.slot.caption]
                if let bytes=r.bytes{row.append("字节数：\(bytes)")};if let mime=r.mime{row.append("类型："+mime)};if let sha=r.sha256{row.append("SHA-256："+sha)}
                source.append(row.joined(separator:"\n"))
            }
        }else{for r in document.source.resources{source.append(r.missingReason+" · "+r.sourceURL)}}
        source.append("已保存原始网页与正文；图片 \(saved)/\(total) 已核验保存。全部网页资源尚未封存，此页不是完整离线包。")
        return(short.joined(separator:" · "),source.joined(separator:"\n\n"))
    }
    private func applyNativeAppearance(){
        view.appearance=readingAppearance.scheme=="dark" ? NSAppearance(named:.darkAqua):readingAppearance.scheme=="light" ? NSAppearance(named:.aqua):nil
        container.updatePalette()
        title.font = .systemFont(ofSize:readingAppearance.font+4,weight:.semibold)
        status.font = .systemFont(ofSize:max(12,readingAppearance.font-5));sourceText.font = .systemFont(ofSize:max(12,readingAppearance.font-4))
        title.textColor = .labelColor;status.textColor = .secondaryLabelColor;sourceText.textColor = .labelColor;sourceText.backgroundColor = .textBackgroundColor
    }
    func updateAppearance(_ value:AggregateReadingAppearance){
        guard !retired,value != readingAppearance else{return};readingAppearance=value;applyNativeAppearance();layout();applyBodyAppearance()
    }
    private func applyBodyAppearance(){
        guard !retired,current(),web.url==documentURL else{return}
        appearanceSequence+=1;let version=appearanceSequence,style=readingAppearance
        Task{[weak self] in guard let self,!retired,current() else{return}
            _=try? await web.callAsyncJavaScript("return window.__nativeAggregateSetAppearance?.(nonce,scheme,font,version) ?? false",arguments:["nonce":nonce,"scheme":style.scheme,"font":Double(style.font),"version":version],in:nil,contentWorld:.defaultClient)
        }
    }
    private func requestReady(){
        if eventNonce==nil{eventNonce=UUID().uuidString.lowercased()}
        guard let lease=eventNonce else{return}
        Task{[weak self] in guard let self,!retired,current(),eventNonce==lease else{return};_=try? await web.callAsyncJavaScript("return window.__nativeAggregateResume?.(nonce,lease) ?? false",arguments:["nonce":nonce,"lease":lease],in:nil,contentWorld:.defaultClient)}
    }
    func suspend(){
        guard !retired else{return};eventNonce=nil;ready=false;readBody.isEnabled=false;outline.isEnabled=false;monitorKeyboardWindow(nil)
        if let window=view.window,ownsResponder(window.firstResponder),let source=navigationSource,source.window===window{window.makeFirstResponder(source)}
        view.removeFromSuperview()
    }
    private func layout() {
        guard !layingOut else{return};layingOut=true;defer{layingOut=false}
        let width=max(150,view.bounds.width),height=view.bounds.height,padding:CGFloat=16,available=max(50,width-2*padding)
        func measured(_ field:NSTextField)->CGFloat{let h=(field.stringValue as NSString).boundingRect(with:NSSize(width:available,height:10000),options:[.usesLineFragmentOrigin,.usesFontLeading],attributes:[.font:field.font!]).height;return max(field.font!.pointSize*1.4,ceil(h)+6)}
        var y:CGFloat=10
        let th=measured(title);title.frame=NSRect(x:padding,y:y,width:available,height:th);y+=th+6
        let sh=measured(status);status.frame=NSRect(x:padding,y:y,width:available,height:sh);y+=sh+8
        var x=padding
        for button in [back,website,source,outline,readBody] as [NSControl]{
            let natural=button.fittingSize.width,w=min(available,max(92,natural+6))
            if x>padding && x+w>width-padding{y+=36;x=padding}
            button.frame=NSRect(x:x,y:y,width:w,height:30);x+=w+8
        }
        y+=38
        let extra:CGFloat=sourceScroll.isHidden ? 0:min(230,max(90,(height-y)*0.42))
        sourceScroll.frame=NSRect(x:padding,y:y,width:available,height:extra)
        sourceText.frame.size.width=sourceScroll.contentSize.width
        if let textContainer=sourceText.textContainer,let manager=sourceText.layoutManager{
            textContainer.containerSize=NSSize(width:sourceScroll.contentSize.width,height:CGFloat.greatestFiniteMagnitude);manager.ensureLayout(for:textContainer)
            sourceText.frame.size.height=max(sourceScroll.contentSize.height,ceil(manager.usedRect(for:textContainer).height)+20)
        }
        if extra>0{y+=extra+8}
        web.frame=NSRect(x:0,y:y,width:width,height:max(40,height-y))
    }
    func retire() {
        guard !retired else { return }
        monitorKeyboardWindow(nil)
        // Return only focus still owned by the retiring component, before detaching it.
        if let window=view.window,ownsResponder(window.firstResponder),let source=navigationSource,source.window===window,!source.isHiddenOrHasHiddenAncestor {window.makeFirstResponder(source)}
        retired = true; eventNonce=nil;readBody.isEnabled = false; outline.isEnabled=false; scheme.invalidate(); web.stopLoading(); web.nextKeyView = nil
        web.configuration.userContentController.removeScriptMessageHandler(forName: "aggregateReader", contentWorld: .defaultClient)
        web.navigationDelegate = nil; view.removeFromSuperview()
    }
    private func monitorKeyboardWindow(_ window:NSWindow?) {
        guard keyboardWindow !== window || (window != nil && keyboardMonitor == nil) || (window == nil && keyboardMonitor != nil) else{return}
        if let token=keyboardMonitor{NSEvent.removeMonitor(token);keyboardMonitor=nil}
        keyboardWindow=window
        guard let window else{return}
        keyboardMonitor=NSEvent.addLocalMonitorForEvents(matching:.keyDown){[weak self,weak window] event in
            guard let self,let window,event.window===window,self.view.window===window,
                  event.type == .keyDown,event.keyCode==48,event.modifierFlags.contains(.control),
                  !event.modifierFlags.contains(.command),!event.modifierFlags.contains(.option),
                  self.bodyFocusAvailable else{return event}
            // A real current native event grants only this synchronous focus move.
            let moved=event.modifierFlags.contains(.shift) ? self.focusNavigation():self.focusBody()
            return moved ? nil:event
        }
    }
    var bodyFocusAvailable: Bool {
        guard !retired, ready, eventNonce != nil,current(), !view.isHiddenOrHasHiddenAncestor,
              let window=view.window,window.isKeyWindow,window.attachedSheet==nil,NSApp.modalWindow==nil,
              let source=navigationSource,source.window===window,!source.isHiddenOrHasHiddenAncestor,
              web.window===window,!web.isHiddenOrHasHiddenAncestor else {return false}
        return true
    }
    private func ownsResponder(_ responder:NSResponder?)->Bool {
        guard let value=responder as? NSView else{return false}
        return value===view || value.isDescendant(of:view)
    }
    var navigationFocusAvailable:Bool {bodyFocusAvailable && ownsResponder(view.window?.firstResponder)}
    /// Synchronous native menu/button action only. Ready/layout messages never invoke it.
    @discardableResult func focusBody()->Bool {
        guard bodyFocusAvailable,let window=view.window else{return false}
        return window.makeFirstResponder(web)
    }
    var findTitle:String {title.stringValue}
    var findLease:String? {bodyFocusAvailable ? eventNonce:nil}
    /// Only a native Find confirmation invokes this; no page message accepts a query.
    func find(_ query:String,lease:String) async throws -> Bool {
        try Task.checkCancellation()
        guard bodyFocusAvailable,eventNonce==lease,!query.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,query.count<=4096 else {throw CancellationError()}
        findSequence+=1;let sequence=findSequence
        let configuration=WKFindConfiguration();configuration.caseSensitive=false;configuration.wraps=true
        do {
            let result=try await web.find(query,configuration:configuration)
            #if PAPER_DIGEST_TESTS
            if let beforeFindCompletion {await beforeFindCompletion()}
            #endif
            try Task.checkCancellation()
            guard bodyFocusAvailable,eventNonce==lease,sequence==findSequence else {throw CancellationError()}
            status.stringValue=result.matchFound ? "已定位当前汇总中的匹配文字":"当前汇总未找到该文字"
            layout();return result.matchFound
        } catch {
            if !(error is CancellationError),bodyFocusAvailable,eventNonce==lease,sequence==findSequence {status.stringValue="查找未完成，请重试";layout()}
            throw error
        }
    }
    @discardableResult func focusNavigation()->Bool {
        guard navigationFocusAvailable,let window=view.window,let source=navigationSource else{return false}
        return window.makeFirstResponder(source)
    }
    @objc private func goBody(){_=focusBody()}
    @objc private func goOutline(){
        let index=outline.selectedItem?.tag ?? -1;outline.selectItem(at:0)
        guard bodyFocusAvailable,let lease=eventNonce,index>=0,index<min(headings.count,2048) else{return}
        _=focusBody()
        Task{[weak self] in guard let self,!retired,current(),eventNonce==lease else{return};_=try? await web.callAsyncJavaScript("return window.__nativeAggregateScrollHeading?.(nonce,index) ?? false",arguments:["nonce":nonce,"index":index],in:nil,contentWorld:.defaultClient)}
    }
    private func presentationFailed(){guard !retired else{return};bodyFailurePending=true;ready=false;readBody.isEnabled=false;outline.isEnabled=false;status.stringValue="正文未能显示，请返回后重新打开";if current(){failed()}}
    private func action(_ body: @escaping () async throws -> Void) {guard let lease=eventNonce else{return};Task { do { guard !retired, current(),eventNonce==lease else { return }; try await body() } catch { if !retired, current() { status.stringValue = "本次操作未完成，请重新打开页面" } } } }
    @objc private func goBack() { action { [self] in try await navigate("back", nil) } }
    @objc private func goWebsite() { action { [self] in try await openWebsite() } }
    @objc private func toggleSource() { guard !retired, eventNonce != nil, current() else { return }; sourceScroll.isHidden.toggle(); layout() }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard !retired, current(), message.webView === web, message.frameInfo.isMainFrame,
              message.frameInfo.request.url == documentURL, message.frameInfo.securityOrigin.protocol == "paperapp", message.frameInfo.securityOrigin.host == "aggregate",
              let raw = message.body as? [String: Any], let lease=eventNonce,raw["nonce"] as? String == lease, let kind = raw["kind"] as? String else { replyHandler(nil, "阅读页面已变化"); return }
        if kind == "ready", Set(raw.keys) == ["nonce", "kind"] { ready = true; readBody.isEnabled = true; outline.isEnabled = !headings.isEmpty; status.stringValue = shortStatus; layout(); applyBodyAppearance(); replyHandler(["accepted": true], nil); return }
        if kind == "failed",Set(raw.keys)==["nonce","kind"]{presentationFailed();replyHandler(["accepted":true],nil);return}
        guard ready, kind == "link", Set(raw.keys) == ["nonce", "kind", "index"], let number = raw["index"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= 0, number.doubleValue < 100000 else { replyHandler(nil, "链接已失效"); return }
        Task { do {
            guard !retired, current(),eventNonce==lease else { throw CancellationError() }
            let result = try await link(number.intValue)
            guard !retired, current(),eventNonce==lease else { throw CancellationError() }
            if let kind = result["kind"] as? String, ["paper", "aggregate"].contains(kind), let id = result["id"] as? String { try await navigate(kind, id) }
            replyHandler(result, nil)
        } catch { replyHandler(nil, "链接已失效") } }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) { decisionHandler(webView === web && !retired && current() && action.request.url == documentURL && action.targetFrame?.isMainFrame == true ? .allow : .cancel) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {if webView === web{presentationFailed()}}
    func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error){if webView === web,(error as NSError).code != NSURLErrorCancelled{presentationFailed()}}
}
