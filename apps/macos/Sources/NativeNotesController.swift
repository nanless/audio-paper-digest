import AppKit

@MainActor private final class NotesCanvas:NSView {override var isFlipped:Bool{true}}
@MainActor final class NativeNotesButton:NSButton {var lease:NativeNotesLease?}
@MainActor private final class NotesCard:NSView {
    override init(frame:NSRect){super.init(frame:frame);wantsLayer=true;layer?.cornerRadius=10;layer?.borderWidth=1;palette()}
    required init?(coder:NSCoder){fatalError("Not archived")}
    override func viewDidChangeEffectiveAppearance(){super.viewDidChangeEffectiveAppearance();palette()}
    private func palette(){effectiveAppearance.performAsCurrentDrawingAppearance{layer?.backgroundColor=NSColor.controlBackgroundColor.cgColor;layer?.borderColor=NSColor.separatorColor.cgColor}}
}

/// Native read-only index. Its only external effects are the fixed existing open-note path and leaving this view.
@MainActor final class NativeNotesController:NSViewController {
    let route:NativeNotesRouteGate
    private var pendingLayoutSequence:Int64?,keyboardSequence:Int64=0,inputEpoch:UInt64=0,keyboardGestureEpoch:UInt64?
    private var keyboardOwner:NativeTaskOwner?,inputEventMonitor:Any?
    private weak var keyboardSource:NSView?,observedKeyboardWindow:NSWindow?

    private let provider:()throws->NativeNotesSnapshot
    private let open:(NativeNotesLease)async throws->Void,close:()async throws->Void
    private let stack=NSStackView(),summary=NSTextField(labelWithString:""),notice=NSTextField(wrappingLabelWithString:"")
    private let scroll=NSScrollView(),document=NotesCanvas()
    private let previous=NSButton(title:"上一页",target:nil,action:nil),next=NSButton(title:"下一页",target:nil,action:nil),reread=NSButton(title:"重新读取",target:nil,action:nil),back=NSButton(title:"返回资料库",target:nil,action:nil)
    private(set) var snapshot:NativeNotesSnapshot?,pageIndex=0,readFailed=false,buttons:[NativeNotesButton]=[]
    private var renderedPage:Int?
    private(set) var lastActionTask:Task<Void,Never>?
    private var pending=Set<String>()
    init(route:NativeNotesRouteGate,provider:@escaping()throws->NativeNotesSnapshot,open:@escaping(NativeNotesLease)async throws->Void,close:@escaping()async throws->Void){self.route=route;self.provider=provider;self.open=open;self.close=close;super.init(nibName:nil,bundle:nil)}
    deinit { NotificationCenter.default.removeObserver(self);if let inputEventMonitor{NSEvent.removeMonitor(inputEventMonitor)} }
    required init?(coder:NSCoder){fatalError("Not archived")}
    private func label(_ text:String,size:CGFloat=13,secondary:Bool=false)->NSTextField{let f=NSTextField(wrappingLabelWithString:text);f.font = .systemFont(ofSize:size);f.textColor=secondary ? .secondaryLabelColor:.labelColor;f.maximumNumberOfLines=0;f.isSelectable=true;f.lineBreakMode = .byWordWrapping;f.setContentCompressionResistancePriority(.defaultLow,for:.horizontal);return f}
    override func loadView(){
        view=NSView(frame:.init(x:0,y:0,width:850,height:650));view.setAccessibilityRole(.group);view.setAccessibilityLabel("我的笔记")
        let heading=label("我的笔记",size:24);heading.font = .systemFont(ofSize:24,weight:.semibold)
        let help=label("从读过的论文中，找回自己的问题和判断。Control-Tab 进入操作区，Tab 或 Shift-Tab 切换。",secondary:true)
        view.setAccessibilityHelp("Control-Tab 进入操作区，Control-Shift-Tab 从末项进入；Tab 或 Shift-Tab 到边界时返回页面。")
        for (button,selector) in [(previous,#selector(previousPage)),(next,#selector(nextPage)),(reread,#selector(rereadRows)),(back,#selector(closeIndex))]{button.target=self;button.action=selector;button.bezelStyle = .rounded}
        let toolbar=NSStackView(views:[back,NSView(),previous,next,reread]);toolbar.orientation = .horizontal;toolbar.spacing=8
        summary.font = .systemFont(ofSize:12);summary.textColor = .secondaryLabelColor;notice.font = .systemFont(ofSize:12);notice.textColor = .secondaryLabelColor;notice.maximumNumberOfLines=0
        let chrome=NSStackView(views:[heading,help,toolbar,summary,notice]);chrome.orientation = .vertical;chrome.alignment = .leading;chrome.spacing=10;chrome.translatesAutoresizingMaskIntoConstraints=false;view.addSubview(chrome)
        scroll.hasVerticalScroller=true;scroll.autohidesScrollers=true;scroll.drawsBackground=false;scroll.translatesAutoresizingMaskIntoConstraints=false;view.addSubview(scroll)
        stack.orientation = .vertical;stack.alignment = .leading;stack.spacing=12;stack.translatesAutoresizingMaskIntoConstraints=false;document.translatesAutoresizingMaskIntoConstraints=false;scroll.documentView=document;document.addSubview(stack)
        NSLayoutConstraint.activate([chrome.topAnchor.constraint(equalTo:view.topAnchor,constant:24),chrome.leadingAnchor.constraint(equalTo:view.leadingAnchor,constant:24),chrome.trailingAnchor.constraint(equalTo:view.trailingAnchor,constant:-24),toolbar.widthAnchor.constraint(equalTo:chrome.widthAnchor),notice.widthAnchor.constraint(equalTo:chrome.widthAnchor),scroll.topAnchor.constraint(equalTo:chrome.bottomAnchor,constant:16),scroll.leadingAnchor.constraint(equalTo:view.leadingAnchor),scroll.trailingAnchor.constraint(equalTo:view.trailingAnchor),scroll.bottomAnchor.constraint(equalTo:view.bottomAnchor),document.widthAnchor.constraint(equalTo:scroll.contentView.widthAnchor),stack.topAnchor.constraint(equalTo:document.topAnchor,constant:4),stack.leadingAnchor.constraint(equalTo:document.leadingAnchor,constant:24),stack.trailingAnchor.constraint(equalTo:document.trailingAnchor,constant:-24),stack.bottomAnchor.constraint(equalTo:document.bottomAnchor,constant:-24)])
        reload()
    }
    func reload(){do{snapshot=try provider();readFailed=false;notice.stringValue=""}catch{readFailed=true;notice.stringValue="笔记记录暂时不可读，显示上次只读列表；未打开其他材料。"};if isViewLoaded{render()}}
    func apply(_ layout:NativeNotesLayout,allowed:NativeTaskRectangle)throws{
        guard layout.owner==route.owner,layout.sequence>route.sequence,pendingLayoutSequence==nil || pendingLayoutSequence==layout.sequence else{throw NativeNotesError.stale}
        do{try route.accept(layout,allowed:allowed)}catch{retire();throw error}
        pendingLayoutSequence=nil;_=view;view.isHidden = !route.showing
        if route.showing{view.frame = .init(x:layout.rectangle.x,y:layout.rectangle.y,width:layout.rectangle.width,height:layout.rectangle.height);reload()}
    }
    func retire(){pendingLayoutSequence=nil;keyboardOwner=nil;keyboardSequence=0;keyboardSource=nil;keyboardGestureEpoch=nil;monitorKeyboardWindow(nil);deactivateForLayout()}


    private func keyboardControls()->[NSControl]{let controls:[NSControl]=buttons+[back,previous,next,reread];return controls.filter{$0.isEnabled && !$0.isHiddenOrHasHiddenAncestor && $0.window===view.window}}
    private func keyboardContext()->(NSWindow,NSView)?{
        guard route.showing,pendingLayoutSequence==nil,keyboardOwner==route.owner,keyboardSequence==route.sequence,!view.isHidden,inputEventMonitor != nil,let window=observedKeyboardWindow,window===view.window,window.isKeyWindow,let source=keyboardSource,source.window===window else{return nil}
        return(window,source)
    }
    /// Only a current, synchronous native keyboard event may grant this operation. Page requests never grant it.
    func focusInitialControl(backwards:Bool=false){
        guard keyboardGestureEpoch==inputEpoch,keyboardGestureEpoch != nil,let(window,source)=keyboardContext(),let responder=window.firstResponder,(responder===window || (responder as? NSView).map{$0===source || $0.isDescendant(of:source)}==true),let target=backwards ? keyboardControls().last:keyboardControls().first else{return}
        _=focusKeyboardControl(target,window:window)
    }
    private func focusKeyboardControl(_ control:NSControl,window:NSWindow)->Bool{
        _=control.scrollToVisible(control.bounds)
        return window.makeFirstResponder(control)
    }
    private func navigateKeyboard(_ event:NSEvent)->Bool{
        guard event.type == .keyDown,event.keyCode==48,!event.modifierFlags.contains(.command),!event.modifierFlags.contains(.option),let(window,source)=keyboardContext() else{return false}
        let backwards=event.modifierFlags.contains(.shift),group=event.modifierFlags.contains(.control),controls=keyboardControls(),before=window.firstResponder
        keyboardGestureEpoch=inputEpoch;defer{keyboardGestureEpoch=nil}
        if let index=controls.firstIndex(where:{$0===before}){
            if group{return window.makeFirstResponder(source)}
            let next=index+(backwards ? -1:1)
            if controls.indices.contains(next){return focusKeyboardControl(controls[next],window:window)}
            return window.makeFirstResponder(source)
        }
        guard group else{return false}
        if before===window || (before as? NSView).map({$0===source || $0.isDescendant(of:source)})==true{focusInitialControl(backwards:backwards);return window.firstResponder !== before}
        return false
    }
    private func monitorKeyboardWindow(_ window:NSWindow?){
        guard observedKeyboardWindow !== window else{return}
        if let inputEventMonitor{NSEvent.removeMonitor(inputEventMonitor);self.inputEventMonitor=nil}
        if let old=observedKeyboardWindow{NotificationCenter.default.removeObserver(self,name:NSWindow.didResignKeyNotification,object:old)}
        observedKeyboardWindow=window
        if let window{
            NotificationCenter.default.addObserver(self,selector:#selector(keyboardWindowResigned(_:)),name:NSWindow.didResignKeyNotification,object:window)
            inputEventMonitor=NSEvent.addLocalMonitorForEvents(matching:[.keyDown,.leftMouseDown,.rightMouseDown,.otherMouseDown]){[weak self] event in
                guard let self,let own=self.observedKeyboardWindow,event.window===own else{return event}
                self.inputEpoch &+= 1;self.keyboardGestureEpoch=nil
                return self.navigateKeyboard(event) ? nil:event
            }
        }
    }
    @objc private func keyboardWindowResigned(_ note:Notification){inputEpoch &+= 1;keyboardGestureEpoch=nil}
    func prepareForLayout(sequence:Int64,focusIntent:String?=nil,keyboardSource:NSView?=nil){
        guard sequence>route.sequence,sequence>(pendingLayoutSequence ?? route.sequence),sequence<=9_007_199_254_740_991 else{return}
        self.keyboardSource=keyboardSource;keyboardOwner=route.owner;keyboardSequence=sequence;pendingLayoutSequence=sequence;keyboardGestureEpoch=nil
        monitorKeyboardWindow(isViewLoaded ? view.window:nil);deactivateForLayout()
    }
    private func deactivateForLayout(){route.retire();if isViewLoaded{view.isHidden=true};buttons.forEach{$0.isEnabled=false}}
    func setPage(_ requested:Int){pageIndex=requested;if isViewLoaded{render()}}
    @objc private func previousPage(){setPage(pageIndex-1)}
    @objc private func nextPage(){setPage(pageIndex+1)}
    @objc private func rereadRows(){reload()}
    private func render(){
        let focused=(view.window?.firstResponder as? NativeNotesButton)?.lease?.row.paperID,origin=scroll.contentView.bounds.origin
        route.renewPresentation()
        stack.arrangedSubviews.forEach{stack.removeArrangedSubview($0);$0.removeFromSuperview()};buttons=[]
        guard let snapshot else{summary.stringValue="笔记记录尚未读取";stack.addArrangedSubview(label("暂时无法读取笔记。原研究记录保留，请重新读取。"));previous.isEnabled=false;next.isEnabled=false;return}
        let page=snapshot.page(pageIndex);pageIndex=page.index
        let samePage=renderedPage==page.index;renderedPage=page.index
        summary.stringValue="\(page.total) 篇笔记 · 第 \(page.index+1) / \(page.count) 页"+(readFailed ? " · 未刷新":"")
        previous.isEnabled=page.index>0;next.isEnabled=page.index+1<page.count
        if page.rows.isEmpty{stack.addArrangedSubview(label("留住你的思考",size:17));stack.addArrangedSubview(label("研究笔记、原文摘录和个人批注会按论文汇集在这里。",secondary:true))}
        for row in page.rows{
            let card=NotesCard();card.translatesAutoresizingMaskIntoConstraints=false
            let title=label(row.title,size:15);title.font = .systemFont(ofSize:15,weight:.semibold)
            let fields=NSStackView(views:[title,label(row.time+" · \(row.annotationCount) 处原文摘录",size:12,secondary:true),label(row.preview)]);fields.orientation = .vertical;fields.alignment = .leading;fields.spacing=8;fields.translatesAutoresizingMaskIntoConstraints=false;card.addSubview(fields)
            let button=NativeNotesButton(title:"打开笔记",target:self,action:#selector(clicked(_:)));button.bezelStyle = .rounded;button.lease=try? route.issue(row);button.isEnabled = !readFailed && button.lease != nil;button.setAccessibilityHelp("打开笔记："+row.title);fields.addArrangedSubview(button);buttons.append(button);stack.addArrangedSubview(card)
            NSLayoutConstraint.activate([card.widthAnchor.constraint(equalTo:stack.widthAnchor),fields.leadingAnchor.constraint(equalTo:card.leadingAnchor,constant:16),fields.trailingAnchor.constraint(equalTo:card.trailingAnchor,constant:-16),fields.topAnchor.constraint(equalTo:card.topAnchor,constant:14),fields.bottomAnchor.constraint(equalTo:card.bottomAnchor,constant:-14)])
            for field in fields.arrangedSubviews.compactMap({$0 as? NSTextField}){field.widthAnchor.constraint(equalTo:fields.widthAnchor).isActive=true}
        }
        view.layoutSubtreeIfNeeded();scroll.contentView.scroll(to:.init(x:0,y:min(max(0,document.bounds.height-scroll.contentView.bounds.height),max(0,samePage ? origin.y:0))));scroll.reflectScrolledClipView(scroll.contentView)
        if samePage,let focused,let button=buttons.first(where:{$0.lease?.row.paperID==focused}),button.isEnabled,!button.isHiddenOrHasHiddenAncestor{view.window?.makeFirstResponder(button)}
    }
    @objc private func clicked(_ sender:NativeNotesButton){guard let lease=sender.lease else{return};lastActionTask=Task{[weak self] in await self?.invoke(lease)}}
    func invoke(_ lease:NativeNotesLease)async{
        guard !Task.isCancelled,pending.insert(lease.row.paperID).inserted else{return};defer{pending.remove(lease.row.paperID)}
        do{try route.validate(lease,snapshot:provider());try await open(lease)}catch{if route.current(lease){reload();notice.stringValue="笔记或阅读视图已经变化，请重新读取后打开。原文保留。"}}
    }
    @objc private func closeIndex(){guard route.showing else{return};lastActionTask=Task{[weak self] in guard let self else{return};do{try await close()}catch{if route.showing{notice.stringValue="视图正在变化，请重新选择返回资料库。"}}}}
}
