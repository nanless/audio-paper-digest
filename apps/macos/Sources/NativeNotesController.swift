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
    private let provider:()throws->NativeNotesSnapshot
    private let open:(NativeNotesLease)async throws->Void,close:()async throws->Void
    private let stack=NSStackView(),summary=NSTextField(labelWithString:""),notice=NSTextField(wrappingLabelWithString:"")
    private let scroll=NSScrollView(),document=NotesCanvas()
    private let previous=NSButton(title:"上一页",target:nil,action:nil),next=NSButton(title:"下一页",target:nil,action:nil),reread=NSButton(title:"重新读取",target:nil,action:nil),back=NSButton(title:"返回资料库",target:nil,action:nil)
    private(set) var snapshot:NativeNotesSnapshot?,pageIndex=0,readFailed=false,buttons:[NativeNotesButton]=[]
    private(set) var lastActionTask:Task<Void,Never>?
    private var pending=Set<String>()
    init(route:NativeNotesRouteGate,provider:@escaping()throws->NativeNotesSnapshot,open:@escaping(NativeNotesLease)async throws->Void,close:@escaping()async throws->Void){self.route=route;self.provider=provider;self.open=open;self.close=close;super.init(nibName:nil,bundle:nil)}
    required init?(coder:NSCoder){fatalError("Not archived")}
    private func label(_ text:String,size:CGFloat=13,secondary:Bool=false)->NSTextField{let f=NSTextField(wrappingLabelWithString:text);f.font = .systemFont(ofSize:size);f.textColor=secondary ? .secondaryLabelColor:.labelColor;f.maximumNumberOfLines=0;f.isSelectable=true;f.lineBreakMode = .byWordWrapping;f.setContentCompressionResistancePriority(.defaultLow,for:.horizontal);return f}
    override func loadView(){
        view=NSView(frame:.init(x:0,y:0,width:850,height:650));view.setAccessibilityRole(.group);view.setAccessibilityLabel("我的笔记")
        let heading=label("我的笔记",size:24);heading.font = .systemFont(ofSize:24,weight:.semibold)
        let help=label("从读过的论文中，找回自己的问题和判断。",secondary:true)
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
    func apply(_ layout:NativeNotesLayout,allowed:NativeTaskRectangle)throws{do{try route.accept(layout,allowed:allowed)}catch{retire();throw error};_=view;view.isHidden = !route.showing;if route.showing{view.frame = .init(x:layout.rectangle.x,y:layout.rectangle.y,width:layout.rectangle.width,height:layout.rectangle.height);reload()}}
    func retire(){route.retire();if isViewLoaded{view.isHidden=true};buttons.forEach{$0.isEnabled=false}}
    func focusInitialControl(){guard route.showing,!view.isHidden else{return};view.window?.makeFirstResponder(buttons.first ?? back)}
    func setPage(_ requested:Int){pageIndex=requested;if isViewLoaded{render()}}
    @objc private func previousPage(){setPage(pageIndex-1)}
    @objc private func nextPage(){setPage(pageIndex+1)}
    @objc private func rereadRows(){reload()}
    private func render(){
        let focused=(view.window?.firstResponder as? NativeNotesButton)?.lease?.row.paperID,origin=scroll.contentView.bounds.origin
        route.renewPresentation()
        stack.arrangedSubviews.forEach{stack.removeArrangedSubview($0);$0.removeFromSuperview()};buttons=[]
        guard let snapshot else{summary.stringValue="笔记记录尚未读取";stack.addArrangedSubview(label("暂时无法读取笔记。原研究记录保留，请重新读取。"));previous.isEnabled=false;next.isEnabled=false;return}
        let page=snapshot.page(pageIndex);pageIndex=page.index;summary.stringValue="\(page.total) 篇笔记 · 第 \(page.index+1) / \(page.count) 页"+(readFailed ? " · 未刷新":"")
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
        view.layoutSubtreeIfNeeded();scroll.contentView.scroll(to:.init(x:0,y:min(max(0,document.bounds.height-scroll.contentView.bounds.height),max(0,origin.y))));scroll.reflectScrolledClipView(scroll.contentView)
        if let focused,let button=buttons.first(where:{$0.lease?.row.paperID==focused}){view.window?.makeFirstResponder(button)}
    }
    @objc private func clicked(_ sender:NativeNotesButton){guard let lease=sender.lease else{return};lastActionTask=Task{[weak self] in await self?.invoke(lease)}}
    func invoke(_ lease:NativeNotesLease)async{
        guard !Task.isCancelled,pending.insert(lease.row.paperID).inserted else{return};defer{pending.remove(lease.row.paperID)}
        do{try route.validate(lease,snapshot:provider());try await open(lease)}catch{if route.current(lease){reload();notice.stringValue="笔记或阅读视图已经变化，请重新读取后打开。原文保留。"}}
    }
    @objc private func closeIndex(){guard route.showing else{return};lastActionTask=Task{[weak self] in guard let self else{return};do{try await close()}catch{if route.showing{notice.stringValue="视图正在变化，请重新选择返回资料库。"}}}}
}
