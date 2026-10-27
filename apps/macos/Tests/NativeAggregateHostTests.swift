import AppKit
import Foundation
import Darwin
import WebKit

private struct Failure: Error { let text: String }
private actor FixtureTransport {
    let files: [String: Data]
    var failBody = false
    var bodyRequests = 0
    var requests=0
    init(_ files: [String: Data]) { self.files = files }
    func failingBody(_ value: Bool) { failBody = value }
    func read(_ url: URL, limit: Int) throws -> Data {
        requests+=1
        if url.absoluteString.hasSuffix("/ci-summary/") { bodyRequests += 1; if failBody { throw URLError(.notConnectedToInternet) } }
        guard let data = files[url.absoluteString], data.count <= limit else { throw URLError(.fileDoesNotExist) }
        return data
    }
}
@MainActor private final class ReadyWindow: NSWindow {
    var testVisible = true
    var testKey = true
    override var isKeyWindow:Bool {testKey}
    override var isVisible: Bool { testVisible }
}
@MainActor private final class FindCompletionGate {
    var entered=false,released=false
    private var continuation:CheckedContinuation<Void,Never>?
    func wait() async {entered=true;if released{return};await withCheckedContinuation{continuation=$0}}
    func release(){released=true;continuation?.resume();continuation=nil}
}
@main @MainActor struct NativeAggregateHostTests {
    static var passed = 0, failed = 0
    static func check(_ value: @autoclosure () throws -> Bool, _ reason: String) throws { if try !value() { throw Failure(text: reason) } }
    static func run(_ label: String, _ body: () async throws -> Void) async { do { try await body(); passed += 1; print("PASS " + label) } catch { failed += 1; print("FAIL " + label + ": " + ((error as? Failure)?.text ?? String(describing: type(of: error)))) } }
    static func rejects(_ action: () throws -> Void) throws { do { try action() } catch is Failure { throw Failure(text: "assertion in rejection") } catch { return }; throw Failure(text: "expected rejection") }
    static func main() async throws {
        setbuf(stdout, nil)
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let physical = realpath(FileManager.default.temporaryDirectory.path, nil)!; defer { free(physical) }
        let root = URL(fileURLWithPath: String(cString: physical)).appendingPathComponent("aggregate-native-host-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); defer { try? FileManager.default.removeItem(at: root) }
        let base = "https://nanless.github.io/audio-paper-digest-blog/"
        let rows: [[String: Any]] = [["pageType": "daily", "permalink": "/audio-paper-digest-blog/ci-summary/", "title": "受控真实目录汇总", "titleZh": String(repeating:"受控界面长标题：完整显示与来源归属。",count:7), "date": "0001-01-01"],
            ["pageType":"paper", "permalink":"/audio-paper-digest-blog/papers/ci-paper/", "title":"Controlled paper", "titleZh":"受控论文", "date":"2026-10-24", "sourceKind":"arxiv", "identityStatus":"verified", "arxivId":"2510.00001", "citation":["paperKey":"arxiv:2510.00001", "identityStatus":"verified", "verified":true, "complete":false, "authors":["Author"], "title":"Controlled paper", "arxivId":"2510.00001v1", "sourceKind":"arxiv", "sourceUrl":"https://arxiv.org/abs/2510.00001v1", "pdfUrl":"https://arxiv.org/pdf/2510.00001v1.pdf"]]]
        let shard = try JSONSerialization.data(withJSONObject: rows, options: .sortedKeys), shardSHA = PublishedAggregateReader.sha(shard), shardPath = "search-index/part-0001-" + shardSHA.prefix(12) + ".json"
        let manifest = try JSONSerialization.data(withJSONObject: ["contract": "paper-search-index-manifest-v1", "recordCount": rows.count, "totalBytes": shard.count, "shards": [["url": shardPath, "sha256": shardSHA, "bytes": shard.count, "recordCount": rows.count]]], options: .sortedKeys)
        let html = Data(("<html><body><div id='article-body' class='post-content'><h2 id='original-anchor'>第一节 原有锚点</h2><p>受控纯文本</p><figure><img src='"+base+"images/native-host-ui-only.png' alt='界面测试项目图标'/><figcaption>仅界面测试，不是论文配图</figcaption></figure><img src='"+base+"images/native-host-missing.png' alt='受控缺项'/><h3>第二节 自动锚点</h3>"+String(repeating:"<p>受控长段落，确认本页目录真实滚动而不发来源请求。</p>",count:120)+"<h2>最后一节 只读边界</h2><p>受控尾部</p><a href='#original-anchor'>返回原锚点</a></div></body></html>").utf8)
        let repository=URL(fileURLWithPath:FileManager.default.currentDirectoryPath,isDirectory:true)
        let icon=try Data(contentsOf:repository.appendingPathComponent("apps/macos/Assets/AppIcon.png"))
        let transport = FixtureTransport([base + "index.json": manifest, base + shardPath: shard, base + "ci-summary/": html,base+"images/native-host-ui-only.png":icon])
        let app = PaperDigestApp(); app.directory = root; app.store = try DesktopStore(directory: root)
        var keyReads = 0; app.model = ModelService(directory: root, store: app.store, keyProvider: { keyReads += 1; return nil })
        app.library = try LibraryService(dataDirectory: root.appendingPathComponent("library"), transport: { url, limit in try await transport.read(url, limit: limit) })
        _ = try await app.library.sync()
        let id = "page:/audio-paper-digest-blog/ci-summary/"
        let window = ReadyWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        app.window = window
        app.web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: { let value = WKWebViewConfiguration(); value.websiteDataStore = .nonPersistent(); return value }())
        window.contentView!.addSubview(app.web)
        let resources=root.appendingPathComponent("Web",isDirectory:true)
        try FileManager.default.createDirectory(at:resources.appendingPathComponent("vendor/katex"),withIntermediateDirectories:true)
        let mac=repository.appendingPathComponent("apps/macos")
        let resourceSource=CommandLine.arguments.count>1 ? URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true):mac.appendingPathComponent("Resources")
        for name in ["aggregate-native-renderer.js","aggregate-native-body.css"]{try FileManager.default.copyItem(at:resourceSource.appendingPathComponent(name),to:resources.appendingPathComponent(name))}
        let katex=mac.appendingPathComponent("node_modules/katex/dist/katex.min.js")
        try FileManager.default.copyItem(at:katex,to:resources.appendingPathComponent("vendor/katex/katex.min.js"))
        app.web.loadHTMLString("<!doctype html><style>html,body{margin:0;width:800px;height:600px}.main-pane{position:absolute;left:180px;top:0;width:620px;height:600px}.toolbar{height:60px}#aggregate-view{height:540px}</style><main class='main-pane'><div class='toolbar'></div><section id='aggregate-view'></section></main>", baseURL:nil)
        func domReady() async throws {
            let deadline = Date().addingTimeInterval(10)
            while Date() < deadline {
                do { if try await app.web.callAsyncJavaScript("return !!document.getElementById('aggregate-view')", arguments:[:], in:nil, contentWorld:.defaultClient) as? Bool == true { return } } catch { print("FIXTURE_EVAL",String(describing:error)) }
                try await Task.sleep(nanoseconds:10_000_000)
            }
            throw Failure(text:"main geometry fixture not loaded")
        }
        try await domReady()
        func opened() async throws -> (AggregateViewSession,[String:Any]) {
            let opened = try await app.dispatchAggregates("aggregates.open",payload:["id":id])
            let session = app.aggregateSession!
            try check(opened["sessionID"] as? String == session.id,"not actual open")
            let value = try await app.dispatchAggregates("aggregates.document",payload:["id":id,"sessionID":session.id])
            return (session,["id":id,"sessionID":session.id,"documentReadyNonce":value["documentReadyNonce"]!,"sequence":1])
        }
        func rejected(_ payload:[String:Any]) async throws {
            do { _ = try await app.presentNativeAggregate(payload,bundleWeb:resources) }
            catch { return }
            throw Failure(text:"invalid native presentation accepted")
        }
        await run("normal Core open context retirement accepts first client sequence1") {
            let (_,payload)=try await opened()
            try check(app.aggregateNativeSequence==0,"native retirement consumed client sequence")
            _=try await app.presentNativeAggregate(payload,bundleWeb:resources)
            try check(app.aggregateNativeHost != nil && app.aggregateNativeHost!.view.superview === window.contentView,"native host not attached")
        }
        await run("same actual document layout preserves host and bodyWK without another read") {
            let host=app.aggregateNativeHost!, before=await transport.bodyRequests
            let s=app.aggregateSession!;let result=try await app.presentNativeAggregate(["id":id,"sessionID":s.id,"documentReadyNonce":s.readyNonce!,"sequence":2],bundleWeb:resources)
            try check(result["native"] as? Bool==true && app.aggregateNativeHost === host,"layout replaced canonical document")
            let after=await transport.bodyRequests;try check(after==before,"layout refetched")
        }
        await run("client replay and arbitrary HTML URL or changed ticket reject") {
            let s=app.aggregateSession!, payload:[String:Any]=["id":id,"sessionID":s.id,"documentReadyNonce":s.readyNonce!,"sequence":1]
            try await rejected(payload)
            for key in ["html","url","source"] {var invalid=payload;invalid["sequence"]=3;invalid[key]="self report";try await rejected(invalid)}
            var invalid=payload;invalid["sequence"]=3;invalid["documentReadyNonce"]=UUID().uuidString;try await rejected(invalid)
        }
        await run("own isolated WK presents real canonical text with no content script capability") {
            let host=app.aggregateNativeHost!,body=host.view.subviews.compactMap{$0 as? WKWebView}.first!
            let deadline=Date().addingTimeInterval(15);var observed=false
            while Date()<deadline {
                if let result=try? await body.callAsyncJavaScript("return {text:document.querySelector('body>main')?.textContent||'',ready:!!window.__nativeAggregateNonce}",arguments:[:],in:nil,contentWorld:.defaultClient) as? [String:Any],result["ready"] as? Bool==true,(result["text"] as? String)?.contains("受控纯文本")==true,host.bodyFocusAvailable {observed=true;break}
                try await Task.sleep(nanoseconds:10_000_000)
            }
            try check(observed,"own WK did not show canonical body / trusted renderer")
            try check(!body.configuration.defaultWebpagePreferences.allowsContentJavaScript,"author scripts enabled")
        }
        await run("leave physically detaches and old presentation cannot revive") {
            let s=app.aggregateSession!,host=app.aggregateNativeHost!,old:[String:Any]=["id":id,"sessionID":s.id,"documentReadyNonce":s.readyNonce!,"sequence":3]
            _=try await app.dispatchAggregates("aggregates.leave",payload:["id":id,"sessionID":s.id])
            try check(host.view.superview==nil && app.aggregateNativeHost==nil,"retired host still attached")
            try await rejected(old)
            let (_,fresh)=try await opened();_=try await app.presentNativeAggregate(fresh,bundleWeb:resources)
            try check(app.aggregateNativeHost !== host,"same-ID ABA borrowed old host")
        }
        func readyBody(_ host:NativeAggregateController) async throws -> WKWebView {
            let body=host.view.subviews.compactMap{$0 as? WKWebView}.first!
            let deadline=Date().addingTimeInterval(15)
            while Date()<deadline {
                if host.bodyFocusAvailable{return body}
                try await Task.sleep(nanoseconds:10_000_000)
            }
            throw Failure(text:"native body not actually ready")
        }
        func owns(_ responder:NSResponder?,_ root:NSView)->Bool {guard let r=responder as? NSView else{return false};return r===root || r.isDescendant(of:root)}
        await run("ready and ordinary same-document layout never automatically take focus") {
            window.makeFirstResponder(app.web);let before=window.firstResponder
            let host=app.aggregateNativeHost!;_=try await readyBody(host)
            try check(window.firstResponder === before,"ready automatically focused body")
            let s=app.aggregateSession!;_=try await app.presentNativeAggregate(["id":id,"sessionID":s.id,"documentReadyNonce":s.readyNonce!,"sequence":2],bundleWeb:resources)
            try check(window.firstResponder === before,"layout stole focus")
        }
        await run("actual native menu actions and visible button synchronously enter and leave body") {
            let previous=NSApp.mainMenu;defer{NSApp.mainMenu=previous};app.buildMenu()
            let items=(NSApp.mainMenu?.items.compactMap{$0.submenu}.flatMap{$0.items}) ?? []
            let read=items.first{$0.title=="阅读正文"}!,back=items.first{$0.title=="返回页面导航"}!
            try check(read.keyEquivalent=="\t" && read.keyEquivalentModifierMask==[.control] && back.keyEquivalent=="\t" && back.keyEquivalentModifierMask==[.control,.shift],"menu keys changed")
            let host=app.aggregateNativeHost!,body=try await readyBody(host)
            try check(app.validateMenuItem(read) && !app.validateMenuItem(back),"menu availability before entry")
            _=NSApp.sendAction(read.action!,to:app,from:read)
            try check(owns(window.firstResponder,body) && app.validateMenuItem(back),"native menu did not focus actual ownWK")
            _=NSApp.sendAction(back.action!,to:app,from:back)
            try check(owns(window.firstResponder,app.web),"native return failed")
            let button=host.view.subviews.compactMap{$0 as? NSButton}.first{$0.title=="阅读正文"}!
            try check(button.isEnabled && button.accessibilityHelp()?.contains("Control-Tab")==true,"visible body action/help absent")
            button.performClick(nil);try check(owns(window.firstResponder,body),"visible native button did not focus body")
            _=host.focusNavigation()
        }
        await run("body and header use native next-key chain without replacing main chain") {
            let host=app.aggregateNativeHost!,body=try await readyBody(host),buttons=host.view.subviews.compactMap{$0 as? NSButton}
            let source=buttons.first{$0.title=="来源与离线状态"}!,read=buttons.first{$0.title=="阅读正文"}!,outline=host.view.subviews.compactMap{$0 as? NSPopUpButton}.first!
            try check(source.nextKeyView===outline && outline.nextKeyView===read && read.nextKeyView===body && body.nextKeyView===app.web,"native exit key chain absent")
        }
        await run("disabled unready or detached component cannot grant focus") {
            let doc=app.aggregateSession!.document!,before=window.firstResponder
            let h=try NativeAggregateController(id:UUID(),binding:"unready",document:doc,bundleWeb:resources,navigationSource:app.web,current:{true},link:{_ in throw CancellationError()},navigate:{_,_ in throw CancellationError()},openWebsite:{throw CancellationError()})
            defer{h.retire()}
            let button=h.view.subviews.compactMap{$0 as? NSButton}.first{$0.title=="阅读正文"}!
            try check(!button.isEnabled && !h.focusBody() && window.firstResponder===before,"unready component stole focus")
        }
        await run("nonkey window and sheet ownership disable body commands") {
            let h=app.aggregateNativeHost!,before=window.firstResponder
            window.testKey=false;try check(!h.focusBody() && window.firstResponder===before,"inactive window focused");window.testKey=true
            app.storageDetailSession=StorageDetailSession(generation:app.contextGeneration,paperID:"",previousResponder:nil)
            try check(!h.focusBody() && !h.bodyFocusAvailable && window.firstResponder===before,"readonly sheet owner ignored");app.storageDetailSession=nil
        }
        await run("return command and retirement do not steal an unrelated input responder") {
            let h=app.aggregateNativeHost!,field=NSTextField(frame:NSRect(x:5,y:5,width:100,height:20));window.contentView!.addSubview(field)
            window.makeFirstResponder(field);let before=window.firstResponder
            try check(!h.focusNavigation() && window.firstResponder===before,"return stole unrelated text input")
            app.retireAggregateContext();try check(window.firstResponder===before && h.view.superview==nil,"retirement stole unrelated input")
            field.removeFromSuperview();window.makeFirstResponder(app.web)
        }
        await run("owned body focus returns before physical retirement and stale ABA commands reject") {
            let (_,p)=try await opened();_=try await app.presentNativeAggregate(p,bundleWeb:resources)
            let old=app.aggregateNativeHost!,body=try await readyBody(old);try check(old.focusBody() && owns(window.firstResponder,body),"explicit body entry failed")
            app.retireAggregateContext();try check(owns(window.firstResponder,app.web) && old.view.superview==nil && !old.focusBody(),"owned retirement or stale focus wrong")
            let (_,next)=try await opened();_=try await app.presentNativeAggregate(next,bundleWeb:resources)
            try check(!old.focusBody(),"same ID new session revived old focus")
        }
        func event(_ modifiers:NSEvent.ModifierFlags,in owner:NSWindow)->NSEvent {
            NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:modifiers,timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:owner.windowNumber,context:nil,characters:"\t",charactersIgnoringModifiers:"\t",isARepeat:false,keyCode:48)!
        }
        await run("actual NSApp event pipeline Control-Tab and reverse move real responders") {
            let h=app.aggregateNativeHost!,body=try await readyBody(h)
            window.makeFirstResponder(app.web)
            NSApp.sendEvent(event(.control,in:window))
            try check(owns(window.firstResponder,body),"Control-Tab native event did not enter ownWK")
            NSApp.sendEvent(event([.control,.shift],in:window))
            try check(owns(window.firstResponder,app.web),"Control-Shift-Tab native event did not return")
        }
        await run("plain Tab OptionTab CommandTab and another window do not invoke body shortcut") {
            let h=app.aggregateNativeHost!,body=try await readyBody(h)
            for modifiers:NSEvent.ModifierFlags in [[],.option,.command,[.control,.option],[.control,.command]] {
                window.makeFirstResponder(app.web);NSApp.sendEvent(event(modifiers,in:window))
                try check(!owns(window.firstResponder,body),"unrelated native event entered body")
            }
            let other=NSWindow(contentRect:NSRect(x:0,y:0,width:300,height:200),styleMask:[.titled],backing:.buffered,defer:false);other.isReleasedWhenClosed=false;defer{other.close()}
            window.makeFirstResponder(app.web);NSApp.sendEvent(event(.control,in:other))
            try check(!owns(window.firstResponder,body),"another window event entered body")
        }
        await run("native group events reject inactive window and source modal ownership") {
            let h=app.aggregateNativeHost!,body=try await readyBody(h)
            window.makeFirstResponder(app.web);window.testKey=false;NSApp.sendEvent(event(.control,in:window))
            try check(!owns(window.firstResponder,body),"inactive native event entered body");window.testKey=true
            app.storageDetailSession=StorageDetailSession(generation:app.contextGeneration,paperID:"",previousResponder:nil)
            NSApp.sendEvent(event(.control,in:window));try check(!owns(window.firstResponder,body),"modal native event entered body");app.storageDetailSession=nil
        }
        await run("replaced served document nonce immediately revokes old body action") {
            let h=app.aggregateNativeHost!,s=app.aggregateSession!,before=window.firstResponder
            _=try await app.dispatchAggregates("aggregates.document",payload:["id":id,"sessionID":s.id])
            try check(!h.focusBody() && !h.bodyFocusAvailable && window.firstResponder===before,"new document borrowed old focus")
            NSApp.sendEvent(event(.control,in:window));try check(window.firstResponder===before,"stale native event borrowed old document")
        }
        await run("long canonical title and status wrap with reachable actions at representative minimum width") {
            let (_,p)=try await opened();_=try await app.presentNativeAggregate(p,bundleWeb:resources)
            let host=app.aggregateNativeHost!;_=try await readyBody(host)
            let labels=host.view.subviews.compactMap{$0 as? NSTextField}
            try check(labels.first!.frame.height>34 && labels.first!.isSelectable,"long title not actually wrapped/selectable")
            let body=host.view.subviews.compactMap{$0 as? WKWebView}.first!
            try check(host.view.subviews.compactMap{$0 as? NSControl}.allSatisfy{host.view.bounds.contains($0.frame)} && body.frame.height>=100,"header actions or body clipped")
            try check(labels.contains{$0.stringValue.contains("日更汇总")&&$0.stringValue.contains("网站日期未记录")&&$0.stringValue.contains("图片 1/2")},"typed date/partial status missing")
        }
        await run("complete native provenance and partial-image last line are really scrollable") {
            let h=app.aggregateNativeHost!,button=h.view.subviews.compactMap{$0 as? NSButton}.first{$0.title=="来源与离线状态"}!
            button.performClick(nil)
            let scroll=h.view.subviews.compactMap{$0 as? NSScrollView}.first!,text=scroll.documentView as! NSTextView
            for value in ["图片资源修订 SHA-256","图片派生版本","图文派生正文 SHA-256","替代文字：界面测试项目图标","仅界面测试，不是论文配图","图片 2","不是完整离线包"]{try check(text.string.contains(value),"missing source image field: "+value)}
            try check(text.frame.height>scroll.contentSize.height,"source document height did not grow")
            let count=(text.string as NSString).length;text.scrollRangeToVisible(NSRange(location:count-1,length:1))
            try check(scroll.documentVisibleRect.maxY>=text.frame.height-30,"last source line not reachable")
            button.performClick(nil)
        }
        await run("native canonical outline scrolls actual final heading and preserves original anchor") {
            let h=app.aggregateNativeHost!,body=try await readyBody(h),outline=h.view.subviews.compactMap{$0 as? NSPopUpButton}.first!
            try check(outline.numberOfItems==4 && outline.isEnabled,"canonical heading count changed")
            outline.selectItem(withTag:2);_=NSApp.sendAction(outline.action!,to:outline.target,from:outline)
            let deadline=Date().addingTimeInterval(10);var scrolled=false
            while Date()<deadline {
                if (try? await body.callAsyncJavaScript("const r=document.querySelectorAll('h2,h3')[2].getBoundingClientRect();return window.scrollY>0 && !!document.getElementById('original-anchor') && r.top>=0 && r.bottom<=innerHeight",arguments:[:],in:nil,contentWorld:.defaultClient)) as? Bool==true{scrolled=true;break}
                try await Task.sleep(nanoseconds:10_000_000)
            }
            try check(scrolled,"outline did not scroll current canonical heading")
        }
        await run("normal appearance settings update same ownWK/document without transport or focus takeover") {
            let h=app.aggregateNativeHost!,body=try await readyBody(h),nonce=app.aggregateSession!.readyNonce!,before=await transport.requests
            window.makeFirstResponder(app.web);let responder=window.firstResponder
            try app.store.updateSettings(["appearance":"dark","font":24]);app.emit("settings.changed")
            let deadline=Date().addingTimeInterval(10);var styled=false
            while Date()<deadline {
                if let value=try? await body.callAsyncJavaScript("return {scheme:document.documentElement.style.colorScheme,font:document.documentElement.style.getPropertyValue('--font')}",arguments:[:],in:nil,contentWorld:.defaultClient) as? [String:Any],value["scheme"] as? String=="dark",value["font"] as? String=="24px"{styled=true;break}
                try await Task.sleep(nanoseconds:10_000_000)
            }
            let after=await transport.requests
            try check(styled && app.aggregateNativeHost===h && app.aggregateSession!.readyNonce==nonce && after==before && window.firstResponder===responder,"settings replaced/re-read document or stole focus")
            try app.store.updateSettings(["appearance":"system","font":16]);app.emit("settings.changed")
        }
        await run("native layer palette follows explicit and inherited effective appearance without replacing body or focus") {
            let h=app.aggregateNativeHost!,body=try await readyBody(h),before=await transport.requests,url=body.url
            window.makeFirstResponder(app.web);let responder=window.firstResponder
            func resolved()->NSColor{var result=NSColor.clear;h.view.effectiveAppearance.performAsCurrentDrawingAppearance{result=NSColor.windowBackgroundColor.usingColorSpace(.sRGB)!};return result}
            func layerColor()->NSColor{NSColor(cgColor:h.view.layer!.backgroundColor!)!.usingColorSpace(.sRGB)!}
            func equal(_ a:NSColor,_ b:NSColor)->Bool{zip([a.redComponent,a.greenComponent,a.blueComponent,a.alphaComponent],[b.redComponent,b.greenComponent,b.blueComponent,b.alphaComponent]).allSatisfy{abs($0-$1)<0.000001}}
            func settled(_ name:NSAppearance.Name)async throws{let deadline=Date().addingTimeInterval(2);while Date()<deadline{if h.view.effectiveAppearance.bestMatch(from:[.aqua,.darkAqua])==name{return};try await Task.sleep(nanoseconds:10_000_000)};throw Failure(text:"owned effective appearance did not settle")}
            window.appearance=NSAppearance(named:.aqua);h.updateAppearance(.init(scheme:"light",font:18));try await settled(.aqua)
            let light=layerColor(),lightCorrect=equal(light,resolved())
            h.updateAppearance(.init(scheme:"dark",font:18));try await settled(.darkAqua)
            let dark=layerColor(),darkCorrect=equal(dark,resolved()),explicitChanged = !equal(light,dark)
            h.updateAppearance(.init(scheme:"system",font:18));window.appearance=NSAppearance(named:.darkAqua);try await settled(.darkAqua)
            let inheritedDark=layerColor(),inheritedDarkCorrect=equal(inheritedDark,resolved())
            window.appearance=NSAppearance(named:.aqua);try await settled(.aqua)
            let inheritedLight=layerColor(),inheritedLightCorrect=equal(inheritedLight,resolved()),inheritedChanged = !equal(inheritedDark,inheritedLight)
            let after=await transport.requests
            print("PALETTE",lightCorrect,darkCorrect,explicitChanged,inheritedDarkCorrect,inheritedLightCorrect,inheritedChanged)
            try check(lightCorrect && darkCorrect && explicitChanged && inheritedDarkCorrect && inheritedLightCorrect && inheritedChanged,"fixed native layer did not follow actual effective appearance")
            try check(app.aggregateNativeHost===h && h.view.subviews.contains{$0===body} && body.url==url && after==before && window.firstResponder===responder,"palette change replaced/re-read body or moved focus")
            window.appearance=nil;h.updateAppearance(.init())
        }
        await run("maintenance and readonly modal physically suspend then reattach same immutable body") {
            let h=app.aggregateNativeHost!,s=app.aggregateSession!,body=try await readyBody(h),before=await transport.requests
            app.maintenanceBusy=true;try check(h.view.superview==nil && !h.focusBody(),"maintenance left overlay interactive")
            app.maintenanceBusy=false;_=try await app.presentNativeAggregate(["id":id,"sessionID":s.id,"documentReadyNonce":s.readyNonce!,"sequence":2],bundleWeb:resources)
            try check(app.aggregateNativeHost===h && h.view.subviews.contains{$0===body},"maintenance rebuilt document")
            app.storageDetailSession=StorageDetailSession(generation:app.contextGeneration,paperID:"",previousResponder:nil)
            try check(h.view.superview==nil,"modal retained overlay")
            app.storageDetailSession=nil;_=try await app.presentNativeAggregate(["id":id,"sessionID":s.id,"documentReadyNonce":s.readyNonce!,"sequence":3],bundleWeb:resources)
            _=try await readyBody(h)
            let oldAccepted=try await body.callAsyncJavaScript("try{await window.webkit.messageHandlers.aggregateReader.postMessage({nonce:window.__nativeAggregateNonce,kind:'ready'});return true}catch(_){return false}",arguments:[:],in:nil,contentWorld:.defaultClient) as? Bool
            let after=await transport.requests;try check(app.aggregateNativeHost===h && after==before && oldAccepted==false && h.bodyFocusAvailable,"modal re-read source or revived old presentation event")
        }
        await run("main Web dialog open physically suspends overlay and close restores same body without source read") {
            let h=app.aggregateNativeHost!,s=app.aggregateSession!,body=try await readyBody(h),before=await transport.requests
            _=try await app.web.callAsyncJavaScript("const d=document.createElement('dialog');d.id='controlled-dialog';d.setAttribute('data-dialog-surface','');d.setAttribute('open','');document.body.append(d)",arguments:[:],in:nil,contentWorld:.defaultClient)
            let result=try await app.presentNativeAggregate(["id":id,"sessionID":s.id,"documentReadyNonce":s.readyNonce!,"sequence":4],bundleWeb:resources)
            try check(result["blocked"] as? Bool==true && h.view.superview==nil && !h.focusBody(),"main Web dialog kept native overlay or focus entry")
            _=try await app.web.callAsyncJavaScript("document.getElementById('controlled-dialog').remove()",arguments:[:],in:nil,contentWorld:.defaultClient)
            _=try await app.presentNativeAggregate(["id":id,"sessionID":s.id,"documentReadyNonce":s.readyNonce!,"sequence":5],bundleWeb:resources)
            _=try await readyBody(h)
            let after=await transport.requests;try check(app.aggregateNativeHost===h && h.view.subviews.contains{$0===body} && h.view.superview===window.contentView && after==before,"closing main dialog replaced/read body or failed restore")
        }
        await run("Tasks Notes intents physically retire old aggregate and stale delegate cannot clear newer host") {
            let old=app.aggregateNativeHost!,oldBody=try await readyBody(old)
            app.nativeTasksRequestedVisible=true;try check(app.aggregateNativeHost==nil && old.view.superview==nil,"tasks intent kept old overlay");app.nativeTasksRequestedVisible=false
            let (_,p)=try await opened();_=try await app.presentNativeAggregate(p,bundleWeb:resources);let latest=app.aggregateNativeHost!
            old.webViewWebContentProcessDidTerminate(oldBody);try check(app.aggregateNativeHost===latest,"old process event cleared new host")
            app.nativeNotesRequestedVisible=true;try check(app.aggregateNativeHost==nil && latest.view.superview==nil,"notes intent kept overlay");app.nativeNotesRequestedVisible=false
        }
        await run("current body failure revokes handler/view before reporting same document error") {
            let (_,p)=try await opened();_=try await app.presentNativeAggregate(p,bundleWeb:resources);let h=app.aggregateNativeHost!,body=try await readyBody(h)
            let source=app.aggregateSession!.document!.source
            h.webViewWebContentProcessDidTerminate(body)
            try check(app.aggregateNativeHost==nil && h.view.superview==nil && !h.focusBody() && app.aggregateSession!.document!.source==source,"render failure left stale overlay or changed source")
        }
        func newFindHost() async throws -> NativeAggregateController {
            let (_,payload)=try await opened();_=try await app.presentNativeAggregate(payload,bundleWeb:resources)
            let h=app.aggregateNativeHost!;_=try await readyBody(h);return h
        }
        func findRefused(_ body:() async throws -> Void) async -> Bool {do{try await body();return false}catch{return true}}
        await run("aggregate loading and failed contexts disable Find without falling back to old paper") {
            let item=NSMenuItem(title:"查找当前文档…",action:#selector(PaperDigestApp.findCurrent),keyEquivalent:"f")
            try check(app.aggregateSession != nil && app.aggregateNativeHost==nil,"fixture not failed current aggregate")
            try check(!app.validateMenuItem(item) && app.findNativeAggregate(),"failed aggregate opened old guide Find")
            app.retireAggregateContext();try check(app.validateMenuItem(item) && !app.findNativeAggregate(),"non-aggregate Find changed")
            app.aggregateTransitionPending=true;try check(!app.validateMenuItem(item) && app.findNativeAggregate(),"pending aggregate borrowed old guide");app.aggregateTransitionPending=false
        }
        await run("actual ownWK Find selects and scrolls to final section without source read or focus move") {
            let h=try await newFindHost(),body=try await readyBody(h),before=await transport.requests,source=app.aggregateSession!.document!.source
            window.makeFirstResponder(app.web);let focus=window.firstResponder
            let found=try await h.find("最后一节",lease:h.findLease!)
            let observed=try await body.callAsyncJavaScript("const s=getSelection();return {selection:s?.toString()||'',scroll:scrollY}",arguments:[:],in:nil,contentWorld:.defaultClient) as! [String:Any]
            let after=await transport.requests
            try check(found && (observed["selection"] as? String)=="最后一节" && (observed["scroll"] as? Double ?? 0)>0,"native Find did not select/reveal actual match")
            try check(window.firstResponder === focus && before==after && app.aggregateSession!.document!.source==source,"Find moved focus or source")
            try check(h.findTitle==source.descriptor.titleZh,"Find title not current aggregate")
        }
        await run("actual ownWK missing Find reports no match and preserves document") {
            let h=app.aggregateNativeHost!,before=await transport.requests,source=app.aggregateSession!.document!.source
            let found=try await h.find("CONTROLLED_ABSENT_FIND",lease:h.findLease!)
            let after=await transport.requests
            try check(!found && h.view.subviews.compactMap{$0 as? NSTextField}.contains{$0.stringValue=="当前汇总未找到该文字"},"missing Find did not report actual negative")
            try check(before==after && app.aggregateSession!.document!.source==source,"negative Find fetched or changed source")
        }
        await run("Find refuses invalid nonce empty oversized and nonkey window before search") {
            let h=app.aggregateNativeHost!,lease=h.findLease!
            for (query,token) in [("最后一节",UUID().uuidString),("",lease),(String(repeating:"x",count:4097),lease)] {let refused=await findRefused{_=try await h.find(query,lease:token)};try check(refused,"invalid Find accepted")}
            window.testKey=false;defer{window.testKey=true}
            let refused=await findRefused{_=try await h.find("最后一节",lease:lease)};try check(h.findLease==nil && refused,"nonkey Find accepted")
        }
        await run("suspend and restore revoke old Find nonce while keeping own body") {
            let h=app.aggregateNativeHost!,oldLease=h.findLease!,s=app.aggregateSession!,body=try await readyBody(h)
            app.suspendNativeAggregate();try check(h.findLease==nil,"suspended Find available")
            let suspendedRefused=await findRefused{_=try await h.find("最后一节",lease:oldLease)};try check(suspendedRefused,"suspended Find accepted")
            _=try await app.presentNativeAggregate(["id":id,"sessionID":s.id,"documentReadyNonce":s.readyNonce!,"sequence":2],bundleWeb:resources);_=try await readyBody(h)
            try check(h.findLease != oldLease && h.view.subviews.contains{$0===body},"resume did not revoke lease or rebuilt body")
            let oldRefused=await findRefused{_=try await h.find("最后一节",lease:oldLease)};try check(oldRefused,"old Find lease revived")
        }
        await run("held actual WKFindResult cannot update replacement same-ID aggregate after leave ABA") {
            let h=app.aggregateNativeHost!,s=app.aggregateSession!,lease=h.findLease!,gate=FindCompletionGate()
            h.beforeFindCompletion={await gate.wait()};defer{gate.release();h.beforeFindCompletion=nil}
            let pending=Task{do{_=try await h.find("最后一节",lease:lease);return false}catch is CancellationError{return true}catch{return false}}
            let deadline=Date().addingTimeInterval(5)
            while !gate.entered && Date()<deadline {try await Task.sleep(nanoseconds:10_000_000)}
            try check(gate.entered,"actual WKFindResult did not arrive")
            _=try await app.dispatchAggregates("aggregates.leave",payload:["id":id,"sessionID":s.id])
            let latest=try await newFindHost(),body=try await readyBody(latest),source=app.aggregateSession!.document!.source
            let labels=latest.view.subviews.compactMap{$0 as? NSTextField}.map{$0.stringValue};window.makeFirstResponder(app.web);let focus=window.firstResponder
            gate.release();let refused=await pending.value
            try check(refused && app.aggregateNativeHost === latest && latest !== h && h.view.superview==nil,"late Find borrowed replacement")
            try check(labels==latest.view.subviews.compactMap{$0 as? NSTextField}.map{$0.stringValue} && window.firstResponder === focus && app.aggregateSession!.document!.source==source && latest.view.subviews.contains{$0===body},"late Find changed new status/focus/body/source")
        }
        app.retireAggregateContext();app.web.removeFromSuperview();window.close()
        try check(keyReads==0,"credentials read")
        print("RESULT \(passed) passed / \(failed) failed")
        exit(failed==0 ? 0:1)
    }
}
