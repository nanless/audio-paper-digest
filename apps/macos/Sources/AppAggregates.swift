import AppKit
import WebKit

@MainActor final class AggregateViewSession {
    let id = UUID().uuidString.lowercased()
    let generation: Int
    let aggregateID: String
    var access: AggregateReadAccess?
    var document: AggregatePresentationDocument?
    var loading = false
    // Minted only for the latest native-served presentation; never a source capability.
    var readyNonce: String?
    var readyDisplaySHA: String?
    var readyPosted = false
    var imageTask: Task<AggregatePresentationDocument, Error>?
    var imageRequestID: UUID?
    var resumeScrollY: Double?
    func cancelImages() { imageRequestID = nil; imageTask?.cancel(); imageTask = nil }
    init(generation: Int, aggregateID: String) { self.generation = generation; self.aggregateID = aggregateID }
}

extension PaperDigestApp {
    func cancelAggregatePreload() {
        aggregatePreloadID = nil; aggregatePreloadTask?.cancel(); aggregatePreloadTask = nil
    }
    private func preloadAggregatePages() async throws -> [String: Any] {
        guard aggregatePreloadTask == nil, aggregatePreloadID == nil, !terminationPending, !maintenanceBusy else { return ["started": false] }
        // Claim before the first await: a foreground cancellation must also
        // invalidate a preload still waiting for its initial catalog.
        let id = UUID(); aggregatePreloadID = id
        defer { if aggregatePreloadID == id && aggregatePreloadTask == nil { aggregatePreloadID = nil } }
        let service = library!
        guard let catalog = try await service.aggregateCatalog() else { return ["started": false] }
        guard aggregatePreloadID == id, self.library === service, !terminationPending, !maintenanceBusy else { return ["started": false] }
        let records = catalog.records.sorted { ($0.displayDate ?? "") > ($1.displayDate ?? "") }
        let selected = Array(records.filter { $0.kind == .daily }.prefix(2))
            + Array(records.filter { $0.sourceURL == PublishedAggregateReader.site.appendingPathComponent("conferences", isDirectory: true).absoluteString }.prefix(1))
            + Array(records.filter { $0.kind == .conference && $0.conferenceScope != "task" && !($0.sourceURL.split(separator: "/").last?.contains("-task-") ?? false) }.prefix(1))
        aggregatePreloadTask = Task(priority: .utility) { [weak self] in
            guard let self else { return }
            defer { if self.aggregatePreloadID == id { self.aggregatePreloadTask = nil; self.aggregatePreloadID = nil } }
            for descriptor in selected {
                guard !Task.isCancelled, self.aggregatePreloadID == id, self.library === service, !self.terminationPending, !self.maintenanceBusy else { return }
                do {
                    if try await service.aggregateLatestVerifiedDocument(id: descriptor.id) != nil { continue }
                    try Task.checkCancellation()
                    guard self.aggregatePreloadID == id else { return }
                    _ = try await service.aggregateDocument(id: descriptor.id)
                } catch is CancellationError { return }
                catch { /* Optional public HTML prefetch never replaces foreground errors or downloads images/PDF. */ }
            }
        }
        return ["started": true, "pageLimit": 4]
    }
    private func aggregateScrollKey(_ document: AggregatePresentationDocument) -> String {
        document.source.descriptor.source.manifestSHA256 + ":" + document.source.descriptor.id + ":" + document.source.rawHTMLSHA256
    }
    private func rememberAggregatePosition(_ session: AggregateViewSession) async {
        guard aggregateSession === session, session.generation == contextGeneration,
              let document = session.document, let host = aggregateNativeHost else { return }
        let nonce = session.readyNonce
        guard let y = await host.scrollPosition(), aggregateSession === session,
              session.generation == contextGeneration, session.readyNonce == nonce,
              aggregateNativeHost === host else { return }
        aggregateScrollPositions[aggregateScrollKey(document)] = y
        if aggregateScrollPositions.count > 50, let oldest = aggregateScrollPositions.keys.sorted().first {
            aggregateScrollPositions.removeValue(forKey: oldest)
        }
    }
    func retireAggregateContext() {
        retireNativeAggregate()
        aggregateOpenSequence += 1
        aggregateTransitionPending = false
        if let session = aggregateSession { jobs[session.id]?.cancel(); session.cancelImages() }
        aggregateSession = nil
    }
    static func aggregateForbids(_ command: String) -> Bool {
        (command.hasPrefix("pdf.") && command != "pdf.frame") || ["library.article", "model.run", "model.preview", "archive.materials", "zotero.archive", "storage.prepare", "app.export", "reader.sourceNotices.show"].contains(command)
    }
    func aggregateSession(_ payload: [String: Any]) throws -> AggregateViewSession {
        guard let session = aggregateSession, payload["id"] as? String == session.aggregateID,
              payload["sessionID"] as? String == session.id, session.generation == contextGeneration,
              currentPaperID.isEmpty, currentArticle.isEmpty, !terminationPending, !maintenanceBusy else { throw DesktopError.message("汇总阅读视图已变化，请重新打开") }
        return session
    }
    func requireAggregateTransitionAvailable() throws {
        try requireMainContextAvailable()
        guard !nativeTasksRequestedVisible, !nativeNotesRequestedVisible,
              window.attachedSheet == nil, NSApp.modalWindow == nil,
              !terminationPending, !maintenanceBusy else { throw DesktopError.message("请先关闭当前原生面板，再打开汇总") }
    }
    // This is called only with the actor-minted access, after the await owner check.
    // It records provenance, not a capability to reopen a paper or invoke a provider.
    func recordAggregateJobSource(_ session: AggregateViewSession, access: AggregateReadAccess) throws {
        guard aggregateSession === session, session.generation == contextGeneration,
              session.access === access, access.descriptor.id == session.aggregateID,
              currentPaperID.isEmpty, currentArticle.isEmpty, !terminationPending, !maintenanceBusy,
              let records = store.value["jobs"] as? [[String: Any]],
              records.filter({ $0["id"] as? String == session.id }).count == 1,
              var row = records.first(where: { $0["id"] as? String == session.id }),
              row["command"] as? String == "aggregates.document", row["status"] as? String == "running" else {
            throw DesktopError.message("汇总任务或来源身份已变化，未写入其他记录")
        }
        let descriptor = access.descriptor
        let title = descriptor.titleZh.isEmpty ? descriptor.title : descriptor.titleZh
        row["paperID"] = ""
        row["title"] = title
        row["aggregateSource"] = try ClientProtocols.record("aggregate-task-source",fields:["id": descriptor.id,
            "title": title, "kind": descriptor.kind.rawValue,
            "manifestSHA256": descriptor.source.manifestSHA256, "shardSHA256": descriptor.source.shardSHA256,
            "normalizedRowSHA256": descriptor.source.normalizedRowSHA256])
        try store.upsertJob(row)
        emit("jobs.changed")
    }
    static func postAggregateLayoutChanged(_ web: WKWebView) {
        NSAccessibility.post(element: web, notification: .layoutChanged, userInfo: [.uiElements: [web]])
    }
    func dispatchAggregates(_ command: String, payload: [String: Any],
                            notifyLayout: @MainActor (WKWebView) -> Void = PaperDigestApp.postAggregateLayoutChanged) async throws -> [String: Any] {
        if command == "aggregates.list" {
            guard payload.isEmpty else { throw DesktopError.message("汇总目录不接受自报来源") }
            guard let catalog = try await library.aggregateCatalog() else { return ["records": [], "available": false, "notice": "当前目录没有可核验的汇总见证，请同步来源后读取已发布汇总"] }
            return try JSONSerialization.jsonObject(with: JSONEncoder().encode(catalog)) as! [String: Any]
        }
        if command == "aggregates.preload" {
            guard payload.isEmpty else { throw DesktopError.message("预载只读取当前网站目录，不接受自报地址") }
            try requireMainContextAvailable()
            return try await preloadAggregatePages()
        }
        try requireMainContextAvailable()
        if command == "aggregates.open" {
            guard Set(payload.keys) == ["id"], let id = payload["id"] as? String, id.hasPrefix("page:"), id.count > 5 else { throw DesktopError.message("请选择当前汇总目录中的页面") }
            try requireAggregateTransitionAvailable()
            cancelAggregatePreload()
            aggregateOpenSequence += 1
            let sequence = aggregateOpenSequence, generation = contextGeneration
            aggregateTransitionPending = true
            defer { if sequence == aggregateOpenSequence { aggregateTransitionPending = false } }
            try await flushEdits(); try Task.checkCancellation()
            guard sequence == aggregateOpenSequence, generation == contextGeneration, !terminationPending, !maintenanceBusy else { throw DesktopError.message("保存期间阅读资料已变化，汇总未打开") }
            try requireAggregateTransitionAvailable()
            if let previous = aggregateSession { await rememberAggregatePosition(previous) }
            guard sequence == aggregateOpenSequence, generation == contextGeneration, !terminationPending, !maintenanceBusy else { throw CancellationError() }
            try requireAggregateTransitionAvailable()
            // This is a real main-context transition. No old paper/PDF can supply a menu operation.
            aggregateSession?.cancelImages()
            contextGeneration += 1
            pdfView.document = nil; pdfView.isHidden = true
            currentPaperID = ""; currentPaper = [:]; currentArticle = [:]
            currentPDFSHA = ""; currentPDFPath = nil; pdfOwner = ""; pdfVersion = ""
            selectionSource = [:]; annotationsByID = [:]; offlinePDF = nil; currentPDFReceipt = [:]; pendingPDFPage = nil
            let session = AggregateViewSession(generation: contextGeneration, aggregateID: id)
            aggregateSession = session
            return ["id": id, "sessionID": session.id, "contextGeneration": session.generation]
        }
        if command == "aggregates.nativePresent" { return try await presentNativeAggregate(payload) }
        if command == "aggregates.viewReady" {
            guard Set(payload.keys) == ["id", "sessionID", "documentReadyNonce", "displayBodySHA256"] else { throw DesktopError.message("汇总就绪回执字段无效") }
            let session = try aggregateSession(payload)
            try requireAggregateTransitionAvailable()
            guard !aggregateTransitionPending, !session.loading, !session.readyPosted,
                  let access = session.access, let document = session.document,
                  document.source.descriptor == access.descriptor,
                  let nonce = session.readyNonce, payload["documentReadyNonce"] as? String == nonce,
                  let displaySHA = session.readyDisplaySHA, payload["displayBodySHA256"] as? String == displaySHA,
                  displaySHA == PublishedAggregateReader.sha(Data(document.displayHTML.utf8)),
                  let web = web, let window = window, web.window === window,
                  window.isVisible, !web.isHiddenOrHasHiddenAncestor else { throw DesktopError.message("汇总就绪回执已失效") }
            // No suspension between the current-owner check and the public layout notification.
            // This updates accessibility layout only; it grants no reading or write capability.
            session.readyPosted = true
            notifyLayout(web)
            return ["accepted": true]
        }
        guard Set(payload.keys).isSubset(of: ["id", "sessionID", "index"]) else { throw DesktopError.message("汇总操作不接受正文或任意地址") }
        if command == "aggregates.leave" {
            // A delayed leave for an older presentation cannot close a newer context.
            guard let current = aggregateSession, payload["id"] as? String == current.aggregateID, payload["sessionID"] as? String == current.id, current.generation == contextGeneration else { return ["left": false, "changed": true] }
            await rememberAggregatePosition(current)
            guard aggregateSession === current, current.generation == contextGeneration else { return ["left": false, "changed": true] }
            current.cancelImages()
            contextGeneration += 1; return ["left": true]
        }
        let session = try aggregateSession(payload)
        if command == "aggregates.images" {
            guard !session.loading, session.imageTask == nil, let access = session.access, let original = session.document, let nonce = session.readyNonce else {
                throw DesktopError.message("请先读取当前汇总正文，图片正在续载时无需重复操作")
            }
            let requestID = UUID()
            let task = Task { try await self.library.aggregatePresentationWithImages(access, document: original) }
            session.imageTask = task; session.imageRequestID = requestID
            defer { if session.imageRequestID == requestID { session.imageTask = nil; session.imageRequestID = nil } }
            let document = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
            try Task.checkCancellation()
            guard aggregateSession === session, session.generation == contextGeneration,
                  session.imageRequestID == requestID, !session.loading, session.readyNonce == nonce, session.access === access,
                  session.document?.source == original.source, !terminationPending, !maintenanceBusy else { throw CancellationError() }
            // Keep a scrolled native reader in place when images arrive. Capture
            // before replacing the nonce which invalidates the old native host.
            let position = await aggregateNativeHost?.scrollPosition()
            guard aggregateSession === session, session.generation == contextGeneration,
                  session.imageRequestID == requestID, !session.loading, session.readyNonce == nonce, session.access === access,
                  session.document?.source == original.source, !terminationPending, !maintenanceBusy else { throw CancellationError() }
            var value = try document.bridgeValue()
            if document.displayHTML == original.displayHTML {
                value["unchanged"] = true
                value["sessionID"] = session.id
                return value
            }
            session.resumeScrollY = position
            session.document = document
            session.readyNonce = UUID().uuidString.lowercased()
            session.readyDisplaySHA = PublishedAggregateReader.sha(Data(document.displayHTML.utf8))
            session.readyPosted = false
            value["documentReadyNonce"] = session.readyNonce
            value["sessionID"] = session.id; value["contextGeneration"] = session.generation
            return value
        }
        if command == "aggregates.document" || command == "aggregates.refresh" {
            guard !session.loading else { throw DesktopError.message("汇总正文正在读取") }
            session.cancelImages()
            session.readyNonce = nil; session.readyDisplaySHA = nil; session.readyPosted = false
            session.loading = true
            defer { session.loading = false }
            return try await runJob("aggregates.document", payload: [:], identifier: session.id) { _ in
                guard self.aggregateSession === session, session.generation == self.contextGeneration else { throw CancellationError() }
                // A view session grants no source capability. The actor resolves the actual row
                // only after the previous paper/PDF context is closed.
                let access = try await self.library.aggregateReadAccess(id: session.aggregateID)
                try Task.checkCancellation()
                guard self.aggregateSession === session, session.generation == self.contextGeneration else { throw CancellationError() }
                session.access = access
                try self.recordAggregateJobSource(session, access: access)
                let document = try await self.library.aggregatePresentation(access, preferCached: command != "aggregates.refresh", downloadImages: false)
                try Task.checkCancellation()
                guard self.aggregateSession === session, session.generation == self.contextGeneration, !self.terminationPending, !self.maintenanceBusy else { throw DesktopError.message("汇总已关闭，迟到正文未安装") }
                try self.requireMainContextAvailable()
                session.document = document
                session.resumeScrollY = self.aggregateScrollPositions[self.aggregateScrollKey(document)]
                var value = try document.bridgeValue()
                let nonce = UUID().uuidString.lowercased()
                session.readyNonce = nonce
                session.readyDisplaySHA = PublishedAggregateReader.sha(Data(document.displayHTML.utf8))
                value["documentReadyNonce"] = nonce
                value["sessionID"] = session.id; value["contextGeneration"] = session.generation
                return value
            }
        }
        if command == "aggregates.website" {
            guard let access = session.access else { throw DesktopError.message("请先等待目录中的真实来源") }
            let url = try PublishedAggregateReader.pageURL(access.descriptor.sourceURL)
            NSWorkspace.shared.open(url); return ["opened": true]
        }
        if command == "aggregates.link" {
            guard let index = payload["index"] as? Int, let document = session.document, let access = session.access else { throw DesktopError.message("请先等待真实汇总正文") }
            let destination = try await library.aggregateLink(access, document: document, index: index)
            guard aggregateSession === session, session.generation == contextGeneration else { throw DesktopError.message("汇总链接已失效") }
            if case .paper = destination { await rememberAggregatePosition(session) }
            if case .aggregate = destination { await rememberAggregatePosition(session) }
            guard aggregateSession === session, session.generation == contextGeneration else { throw CancellationError() }
            try requireMainContextAvailable()
            switch destination {
            case .anchor(let id): return ["kind": "anchor", "anchor": id]
            case .aggregate(let id): return ["kind": "aggregate", "id": id]
            case .paper(let id): return ["kind": "paper", "id": id]
            case .external(let url): NSWorkspace.shared.open(url); return ["kind": "external", "opened": true]
            }
        }
        throw DesktopError.message("未知汇总阅读操作")
    }
}
