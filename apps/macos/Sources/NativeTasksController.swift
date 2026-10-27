import AppKit

/// The host resolves IDs again through its existing guarded core. No arbitrary command, payload, path or credential callback.
enum NativeTaskFeedback { case requested, opened, previewOnly }
@MainActor struct NativeTaskCallbacks {
    let cancel: (String) async throws -> NativeTaskFeedback
    let openSaved: (String, String) async throws -> NativeTaskFeedback
    let openCloud: (String) async throws -> NativeTaskFeedback
    let resync: (String) async throws -> NativeTaskFeedback
    let sourceBound: ((NativeTaskLease) async throws -> NativeTaskFeedback)?
    init(cancel:@escaping(String)async throws->NativeTaskFeedback,openSaved:@escaping(String,String)async throws->NativeTaskFeedback,openCloud:@escaping(String)async throws->NativeTaskFeedback,resync:@escaping(String)async throws->NativeTaskFeedback){self.cancel=cancel;self.openSaved=openSaved;self.openCloud=openCloud;self.resync=resync;sourceBound=nil}
    init(sourceBound:@escaping(NativeTaskLease)async throws->NativeTaskFeedback){self.sourceBound=sourceBound;cancel={_ in throw NativeTaskPresentationError.stale};openSaved={_,_ in throw NativeTaskPresentationError.stale};openCloud={_ in throw NativeTaskPresentationError.stale};resync={_ in throw NativeTaskPresentationError.stale}}
}
@MainActor final class NativeTaskActionButton: NSButton { var lease: NativeTaskLease? }
@MainActor private final class TaskFlippedView: NSView { override var isFlipped: Bool { true } }
@MainActor private final class TaskCardView: NSView {
    override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true; layer?.cornerRadius = 10; layer?.borderWidth = 1; updatePalette() }
    required init?(coder: NSCoder) { fatalError("Not archived") }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); updatePalette() }
    private func updatePalette() { effectiveAppearance.performAsCurrentDrawingAppearance { layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor; layer?.borderColor = NSColor.separatorColor.cgColor } }
}

@MainActor final class NativeTasksController: NSViewController {
    typealias SnapshotProvider = () throws -> NativeTaskInput
    let route: NativeTaskRouteGate
    private var pendingLayoutSequence:Int64?,keyboardSequence:Int64=0,inputEpoch:UInt64=0,keyboardGestureEpoch:UInt64?
    private var keyboardOwner:NativeTaskOwner?,inputEventMonitor:Any?
    private weak var keyboardSource:NSView?,observedKeyboardWindow:NSWindow?

    private let provider: SnapshotProvider, callbacks: NativeTaskCallbacks
    private let progressFactory: @MainActor () -> NSProgressIndicator
    private var indicators: [NSProgressIndicator] = []
    private(set) var snapshot: NativeTaskSnapshot?
    private(set) var readFailed = false
    private(set) var filter: NativeTaskFilter = .all
    private(set) var pageIndex = 0
    private var renderedFilter: NativeTaskFilter?, renderedPage: Int?
    private(set) var actionButtons: [NativeTaskActionButton] = []
    private(set) var lastActionTask: Task<Void, Never>?
    private(set) var noticeText = ""
    private var pendingActions = Set<String>()
    private let stack = NSStackView(), header = NSTextField(labelWithString: "后台任务"), summary = NSTextField(labelWithString: ""), notice = NSTextField(wrappingLabelWithString: "")
    private let filters = NSSegmentedControl(labels: NativeTaskFilter.allCases.map(\.title), trackingMode: .selectOne, target: nil, action: nil)
    private let previous = NSButton(title: "上一页", target: nil, action: nil), next = NSButton(title: "下一页", target: nil, action: nil), reread = NSButton(title: "重新读取", target: nil, action: nil)
    private let scroll = NSScrollView(), document = TaskFlippedView()

    init(route: NativeTaskRouteGate, provider: @escaping SnapshotProvider, callbacks: NativeTaskCallbacks, progressFactory: @escaping @MainActor () -> NSProgressIndicator = { NSProgressIndicator() }) {
        self.route = route; self.provider = provider; self.callbacks = callbacks; self.progressFactory = progressFactory
        super.init(nibName: nil, bundle: nil)
    }
    deinit { NotificationCenter.default.removeObserver(self);if let inputEventMonitor{NSEvent.removeMonitor(inputEventMonitor)} }
    required init?(coder: NSCoder) { fatalError("Not archived") }
    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 850, height: 650))
        header.font = .systemFont(ofSize: 24, weight: .semibold)
        let help = label("同步、原文、个人研究与存档的原记录。Control-Tab 进入操作区，Tab 或 Shift-Tab 切换。", size: 13, secondary: true)
        view.setAccessibilityHelp("Control-Tab 进入操作区，Control-Shift-Tab 从末项进入；Tab 或 Shift-Tab 到边界时返回页面。")
        filters.target = self; filters.action = #selector(changeFilter); filters.selectedSegment = 0; filters.setAccessibilityLabel("任务筛选")
        previous.target = self; previous.action = #selector(previousPage); previous.bezelStyle = .rounded
        next.target = self; next.action = #selector(nextPage); next.bezelStyle = .rounded
        reread.target = self; reread.action = #selector(rereadRows); reread.bezelStyle = .rounded
        summary.font = .systemFont(ofSize: 12); summary.textColor = .secondaryLabelColor
        notice.font = .systemFont(ofSize: 12); notice.textColor = .secondaryLabelColor; notice.maximumNumberOfLines = 0
        let toolbar = NSStackView(views: [filters, NSView(), previous, next, reread]); toolbar.orientation = .horizontal; toolbar.spacing = 8
        let chrome = NSStackView(views: [header, help, toolbar, summary, notice]); chrome.orientation = .vertical; chrome.alignment = .leading; chrome.spacing = 10
        chrome.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(chrome)
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true; scroll.drawsBackground = false; scroll.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(scroll)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12; stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = document; document.translatesAutoresizingMaskIntoConstraints = false; document.addSubview(stack)
        NSLayoutConstraint.activate([
            chrome.topAnchor.constraint(equalTo: view.topAnchor, constant: 24), chrome.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24), chrome.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            toolbar.widthAnchor.constraint(equalTo: chrome.widthAnchor), notice.widthAnchor.constraint(equalTo: chrome.widthAnchor),
            scroll.topAnchor.constraint(equalTo: chrome.bottomAnchor, constant: 16), scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor), scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor), stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 4), stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -24), stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -24)
        ])
        view.setAccessibilityLabel("后台任务"); view.setAccessibilityRole(.group)
        reload()
    }
    func reload() {
        do { snapshot = try NativeTaskProjection.make(provider()); if readFailed { setNotice("") }; readFailed = false }
        catch { readFailed = true; setNotice("任务记录暂时不可读，保留上次视图；未开始新的操作。") }
        if isViewLoaded { render() }
    }
    func apply(_ layout: NativeTaskLayout, allowedContent: NativeTaskRectangle) throws {
        guard layout.owner==route.owner,layout.sequence>route.sequence,pendingLayoutSequence==nil || pendingLayoutSequence==layout.sequence else{throw NativeTaskPresentationError.stale}
        do { try route.accept(layout, allowedContent: allowedContent) }
        catch { if isViewLoaded { view.isHidden = !route.showing }; throw error }
        pendingLayoutSequence=nil
        _ = view
        view.isHidden = !route.showing
        if route.showing {
            view.frame = NSRect(x: layout.rectangle.x, y: layout.rectangle.y, width: layout.rectangle.width, height: layout.rectangle.height)
            reload()
        }
    }

    private func stopIndicators() { indicators.forEach { $0.stopAnimation(nil) }; indicators.removeAll() }
    func retire(){pendingLayoutSequence=nil;keyboardOwner=nil;keyboardSequence=0;keyboardSource=nil;keyboardGestureEpoch=nil;monitorKeyboardWindow(nil);deactivateForLayout()}

    private func keyboardControls()->[NSControl]{let controls:[NSControl]=[filters,previous,next,reread]+actionButtons;return controls.filter{$0.isEnabled && !$0.isHiddenOrHasHiddenAncestor && $0.window===view.window}}
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
    private func deactivateForLayout(){stopIndicators();route.retire();if isViewLoaded{view.isHidden=true};actionButtons.forEach{$0.isEnabled=false}}
    func setFilter(_ value: NativeTaskFilter) { filter = value; pageIndex = 0; if isViewLoaded { filters.selectedSegment = NativeTaskFilter.allCases.firstIndex(of: value)!; render() } }
    func setPage(_ value: Int) { pageIndex = value; if isViewLoaded { render() } }
    @objc private func changeFilter() { guard NativeTaskFilter.allCases.indices.contains(filters.selectedSegment) else { return }; setFilter(NativeTaskFilter.allCases[filters.selectedSegment]) }
    @objc private func previousPage() { setPage(pageIndex - 1) }
    @objc private func nextPage() { setPage(pageIndex + 1) }
    @objc private func rereadRows() { reload() }
    private func label(_ text: String, size: CGFloat = 13, secondary: Bool = false) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text); field.font = .systemFont(ofSize: size); field.textColor = secondary ? .secondaryLabelColor : .labelColor
        field.isSelectable = true; field.maximumNumberOfLines = 0; field.lineBreakMode = .byWordWrapping; field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }
    private func setNotice(_ text: String) { noticeText = text; notice.stringValue = text }
    private func render() {
        stopIndicators()
        let oldFocus = (view.window?.firstResponder as? NativeTaskActionButton)?.lease.map { ($0.jobID, $0.action) }
        let oldOrigin = scroll.contentView.bounds.origin
        for child in stack.arrangedSubviews { stack.removeArrangedSubview(child); child.removeFromSuperview() }
        actionButtons = []
        guard let snapshot else { summary.stringValue = "任务记录尚未读取"; stack.addArrangedSubview(label("暂时无法读取任务。请重新读取，原记录保留。")); previous.isEnabled = false; next.isEnabled = false; return }
        let page = snapshot.page(filter: filter, requested: pageIndex); pageIndex = page.page
        let samePage = renderedFilter == filter && renderedPage == page.page
        renderedFilter = filter; renderedPage = page.page
        summary.stringValue = page.summary + (readFailed ? " · 未刷新，显示上次原记录" : "")
        previous.isEnabled = page.page > 0; next.isEnabled = page.page + 1 < page.pageCount
        if page.rows.isEmpty { stack.addArrangedSubview(label("没有此类任务", size: 17)); stack.addArrangedSubview(label("同步、原文下载、个人解析与存档的实际记录会出现在这里。", secondary: true)) }
        for row in page.rows {
            let card = TaskCardView(); card.translatesAutoresizingMaskIntoConstraints = false
            let title = label(row.title, size: 15); title.font = .systemFont(ofSize: 15, weight: .semibold)
            let fields = NSStackView(views: [title, label(row.subtitle, size: 12, secondary: true), label(row.message)]); fields.orientation = .vertical; fields.alignment = .leading; fields.spacing = 7; fields.translatesAutoresizingMaskIntoConstraints = false; card.addSubview(fields)
            for text in row.metadata { fields.addArrangedSubview(label(text, size: 12, secondary: true)) }
            if row.running {
                let progress = progressFactory(); indicators.append(progress); progress.style = .bar; progress.isIndeterminate = row.progress == nil; progress.setAccessibilityLabel("实际任务进度")
                if let actual = row.progress { progress.minValue = 0; progress.maxValue = Double(actual.total); progress.doubleValue = Double(actual.completed); fields.addArrangedSubview(label("\(actual.completed) / \(actual.total)", size: 12, secondary: true)) }
                fields.addArrangedSubview(progress); progress.widthAnchor.constraint(equalTo: fields.widthAnchor).isActive = true
                if progress.isIndeterminate && route.showing && !readFailed { progress.startAnimation(nil) }
            }
            for action in row.actions {
                let button = NativeTaskActionButton(title: action.title, target: self, action: #selector(clicked(_:))); button.bezelStyle = .rounded
                button.lease = try? route.issue(row: row, action: action); button.isEnabled = !readFailed && button.lease != nil
                button.setAccessibilityHelp("\(action.title)：\(row.title)"); actionButtons.append(button); fields.addArrangedSubview(button)
            }
            stack.addArrangedSubview(card)
            NSLayoutConstraint.activate([card.widthAnchor.constraint(equalTo: stack.widthAnchor), fields.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16), fields.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16), fields.topAnchor.constraint(equalTo: card.topAnchor, constant: 14), fields.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -14)])
            for field in fields.arrangedSubviews.compactMap({ $0 as? NSTextField }) { field.widthAnchor.constraint(equalTo: fields.widthAnchor).isActive = true }
        }
        view.layoutSubtreeIfNeeded()
        let maxY = max(0, document.bounds.height - scroll.contentView.bounds.height)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: min(maxY, max(0, samePage ? oldOrigin.y : 0)))); scroll.reflectScrolledClipView(scroll.contentView)
        if samePage, let oldFocus, let button = actionButtons.first(where: { $0.lease?.jobID == oldFocus.0 && $0.lease?.action == oldFocus.1 }),button.isEnabled,!button.isHiddenOrHasHiddenAncestor { view.window?.makeFirstResponder(button) }
    }
    @objc private func clicked(_ sender: NativeTaskActionButton) {
        guard let lease = sender.lease else { return }
        lastActionTask = Task { [weak self] in guard let self else { return }; await self.invoke(lease) }
    }
    func invoke(_ lease: NativeTaskLease) async {
        guard !Task.isCancelled else { return }
        let pendingKey = lease.jobID + "\u{0}" + lease.action.rawValue
        guard pendingActions.insert(pendingKey).inserted else { return }
        defer { pendingActions.remove(pendingKey) }
        do { let current = try NativeTaskProjection.make(provider()); _ = try route.validate(lease, current: current) }
        catch { if route.current(lease) { setNotice("这项操作对应的记录或视图已经变化，请重新读取后选择。") }; return }
        let feedback: NativeTaskFeedback
        do {
            if let bound=callbacks.sourceBound {feedback=try await bound(lease)} else {
            switch lease.action {
            case .cancel: feedback = try await callbacks.cancel(lease.jobID)
            case .openSaved:
                guard let owner = lease.paperID else { throw NativeTaskPresentationError.actionUnavailable }
                feedback = try await callbacks.openSaved(lease.jobID, owner)
            case .openCloud: feedback = try await callbacks.openCloud(lease.jobID)
            case .resync: feedback = try await callbacks.resync(lease.jobID)
            }
            }
        } catch { if route.current(lease) { reload(); setNotice("本次入口未完成，请查看任务实际状态；原记录保留。") }; return }
        guard route.current(lease) else { return }
        reload()
        switch feedback { case .requested: setNotice("请求已交给后台任务，请查看实际状态。"); case .opened: setNotice("已打开相应入口，原任务记录保留。"); case .previewOnly: setNotice("只读预览：未执行任务操作，没有更改任何记录。") }
    }
}
