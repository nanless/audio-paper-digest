import AppKit
import WebKit
import Foundation
import Darwin

private struct Failure: Error { let message: String }
// No visible/key user window: only key-state eligibility is simulated. Actual AppKit
// hierarchy, responder changes, NSEvent local monitor and Main adapters are exercised.
@MainActor private final class PrivateWindow: NSWindow { override var isKeyWindow: Bool { true } }
@main @MainActor struct NativeWorkspaceAttachmentTests {
    static var passed = 0, failed = 0
    static let client = "11111111-1111-4111-8111-111111111111"
    static func check(_ value: @autoclosure () throws -> Bool, _ text: String) throws { if try !value() { throw Failure(message: text) } }
    static func run(_ label: String, _ action: () async throws -> Void) async { do { try await action(); passed += 1; print("PASS " + label) } catch { failed += 1; print("FAIL " + label + ": " + ((error as? Failure)?.message ?? String(describing: type(of: error)))) } }
    static func monitorPresent(_ controller: Any) -> Bool {
        guard let item = Mirror(reflecting: controller).children.first(where: { $0.label == "inputEventMonitor" }) else { return false }
        return !Mirror(reflecting: item.value).children.isEmpty
    }
    static func sendControlTab(_ window: NSWindow) throws {
        let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .control, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: "\t", charactersIgnoringModifiers: "\t", isARepeat: false, keyCode: 48)!
        NSApp.sendEvent(event)
    }
    static func owned(_ window: NSWindow, _ root: NSView) -> Bool { guard let view = window.firstResponder as? NSView else { return false }; return view === root || view.isDescendant(of: root) }
    static func main() async throws {
        setbuf(stdout, nil); _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let physical = realpath(FileManager.default.temporaryDirectory.path, nil)!; defer { free(physical) }
        let directory = URL(fileURLWithPath: String(cString: physical)).appendingPathComponent("pd-lifecycle-C-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true); defer { try? FileManager.default.removeItem(at: directory) }
        let html = """
        <!doctype html><html data-native-tasks-document="\(client)" data-native-notes-document="\(client)"><head><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}.sidebar{position:absolute;left:0;top:0;width:220px;height:100%}.main-pane{position:absolute;left:220px;right:0;top:0;height:100%}.toolbar{height:60px}.pane{position:absolute;left:0;right:0;top:60px;bottom:0}[hidden]{display:none!important}</style></head><body><aside class="sidebar"></aside><main class="main-pane"><header class="toolbar">controlled geometry</header><section class="pane" id="tasks-view" hidden>tasks geometry fixture</section><section class="pane" id="notes-view" hidden>notes geometry fixture</section></main></body></html>
        """
        try Data(html.utf8).write(to: directory.appendingPathComponent("index.html"))
        let app = PaperDigestApp(); app.directory = directory; app.store = try DesktopStore(directory: directory)
        var keyReads = 0; app.model = ModelService(directory: directory, store: app.store, keyProvider: { keyReads += 1; return nil })
        try app.store.upsertJob(["id": "qa-task", "command": "library.article", "paperID": "", "status": "complete", "title": "controlled own task"])
        _ = try app.store.saveNote(id: "qa-note", text: "controlled own note", baseRevision: 0)
        let window = PrivateWindow(contentRect: .init(x: 0, y: 0, width: 1280, height: 809), styleMask: [.titled], backing: .buffered, defer: false); window.isReleasedWhenClosed = false; app.window = window
        defer { app.retireNativeTasks(restoreFocus: false); app.retireNativeNotes(restoreFocus: false); window.close() }
        let root = NSView(frame: .init(x: 0, y: 0, width: 1280, height: 809)); window.contentView = root
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent(); let scheme = BundleScheme(root: directory); configuration.setURLSchemeHandler(scheme, forURLScheme: "paperapp")
        let web = WKWebView(frame: root.bounds, configuration: configuration); app.web = web; root.addSubview(web); app.pdfView.isHidden = true; root.addSubview(app.pdfView)
        let url = URL(string: "paperapp://app/index.html")!; web.load(URLRequest(url: url))
        var ready = false
        for _ in 0..<200 { if (try? await web.evaluateJavaScript("document.readyState==='complete' && innerWidth===1280 && !!document.getElementById('tasks-view')")) as? Bool == true { ready = true; break }; try await Task.sleep(nanoseconds: 50_000_000) }
        try check(ready, "controlled real WK geometry did not load")
        func controller(_ kind: String) -> Any { kind == "tasks" ? app.nativeTaskController! : app.nativeNotesController! }
        func hostView(_ kind: String) -> NSView { kind == "tasks" ? app.nativeTaskController!.view : app.nativeNotesController!.view }
        func message(_ kind: String, _ command: String, _ payload: [String: Any]) async throws -> [String: Any] {
            if kind == "tasks" { return try await app.nativeTasksMessage(command, payload: payload, source: web, frameURL: url, isMainFrame: true) }
            return try await app.nativeNotesMessage(command, payload: payload, source: web, frameURL: url, isMainFrame: true)
        }
        func reset(_ kind: String) async throws -> String {
            app.nativeTasksContextDidChange(); app.nativeNotesContextDidChange()
            app.installNativeTasks(); app.installNativeNotes()
            _ = try await web.evaluateJavaScript("document.getElementById('tasks-view').hidden=true;document.getElementById('notes-view').hidden=true")
            let bootstrap = try await message(kind, kind == "tasks" ? "nativeTasks.bootstrap" : "nativeNotes.bootstrap", ["clientID": client, "paperID": ""])
            return bootstrap["nonce"] as! String
        }
        func present(_ kind: String, _ nonce: String, _ sequence: Int, _ visible: Bool) async throws {
            _ = try await web.evaluateJavaScript("document.getElementById('\(kind)-view').hidden=\(visible ? "false" : "true")")
            let response = try await message(kind, kind == "tasks" ? "nativeTasks.present" : "nativeNotes.present", ["nonce": nonce, "clientID": client, "paperID": "", "sequence": sequence, kind: visible, "focus": false])
            try check(response["accepted"] as? Bool == true, "not acknowledged")
        }
        for kind in ["tasks", "notes"] {
            await run(kind + " initial install and ready=false leave both native hosts physically detached") {
                let nonce = try await reset(kind)
                try check(app.nativeTaskController!.view.superview == nil && app.nativeNotesController!.view.superview == nil, "install attached a hidden view")
                try await present(kind, nonce, 1, false)
                try check(hostView(kind).superview == nil && !monitorPresent(controller(kind)), "false ready attached or monitored")
            }
            await run(kind + " first true ready attaches after actual DOM+coordinator validation and registers working Control-Tab monitor") {
                let nonce = try await reset(kind); try check(hostView(kind).window == nil, "host attached before ready")
                try await present(kind, nonce, 1, true)
                try check(hostView(kind).superview === root && !hostView(kind).isHidden && monitorPresent(controller(kind)), "ready host or monitor missing")
                try check(window.makeFirstResponder(web), "WK responder unavailable"); try sendControlTab(window)
                try check(owned(window, hostView(kind)), "first Control-Tab did not enter actual native controls")
            }
            await run(kind + " retire restores source before detach; monitor removed and hidden group cannot capture Control-Tab") {
                let nonce = try await reset(kind); try await present(kind, nonce, 1, true); _ = window.makeFirstResponder(web); try sendControlTab(window); try check(owned(window, hostView(kind)), "positive entry missing")
                try await present(kind, nonce, 2, false)
                try check(hostView(kind).superview == nil && !monitorPresent(controller(kind)) && owned(window, web), "retirement did not restore/detach/clear monitor")
                let previous = window.firstResponder; try sendControlTab(window); try check(window.firstResponder === previous, "retired group captured input")
            }
            await run(kind + " same coordinator reentry reattaches and installs a fresh working own-window monitor") {
                let nonce = try await reset(kind); try await present(kind, nonce, 1, true); try await present(kind, nonce, 2, false)
                try await present(kind, nonce, 3, true); _ = window.makeFirstResponder(web); try sendControlTab(window)
                try check(hostView(kind).superview === root && monitorPresent(controller(kind)) && owned(window, hostView(kind)), "reentry lost monitor or hierarchy")
            }
            await run(kind + " actual apply refusal cleans up the newly attached view via current-ticket catch") {
                let nonce = try await reset(kind), rectangle = NativeTaskRectangle(x: 220, y: 0, width: 1060, height: 749)
                if kind == "tasks" { try app.nativeTaskController!.route.accept(.init(owner: app.nativeTasksContext.owner, sequence: 100, tasks: true, rectangle: rectangle), allowedContent: rectangle) }
                else { try app.nativeNotesController!.route.accept(.init(owner: app.nativeNotesContext.owner, sequence: 100, notes: true, rectangle: rectangle), allowed: rectangle) }
                var rejected = false; do { try await present(kind, nonce, 1, true) } catch { rejected = true }
                try check(rejected && hostView(kind).superview == nil && !monitorPresent(controller(kind)), "apply refusal left attached view/monitor")
            }
            await run(kind + " repeated actual install retires old visible controller and leaves no orphan native subview") {
                let nonce = try await reset(kind); try await present(kind, nonce, 1, true); let old = hostView(kind), oldController = controller(kind)
                _ = window.makeFirstResponder(web); try sendControlTab(window); try check(owned(window, old), "positive entry missing")
                if kind == "tasks" { app.installNativeTasks() } else { app.installNativeNotes() }
                try check(old.superview == nil && !monitorPresent(oldController) && hostView(kind).superview == nil && owned(window, web), "reinstall left old host/monitor/focus")
                try check(root.subviews.count == 2, "unexpected native orphan subview")
            }
        }
        await run("all lifecycle cases use own unshown window/local fixture and no credentials") { try check(keyReads == 0 && NSApp.windows.allSatisfy { !$0.isVisible }, "visible or credential side effect") }
        print("RESULT \(passed) passed / \(failed) failed"); exit(failed == 0 ? 0 : 1)
    }
}
