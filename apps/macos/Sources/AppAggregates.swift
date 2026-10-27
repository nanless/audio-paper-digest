import AppKit
import WebKit

@MainActor final class AggregateViewSession {
    let id = UUID().uuidString.lowercased()
    let generation: Int
    let aggregateID: String
    var access: AggregateReadAccess?
    var document: AggregatePresentationDocument?
    var loading = false
    init(generation: Int, aggregateID: String) { self.generation = generation; self.aggregateID = aggregateID }
}

extension PaperDigestApp {
    func retireAggregateContext() {
        aggregateOpenSequence += 1
        aggregateTransitionPending = false
        if let session = aggregateSession { jobs[session.id]?.cancel() }
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
        row["aggregateSource"] = ["contract": "aggregate-task-source-v1", "id": descriptor.id,
            "title": title, "kind": descriptor.kind.rawValue,
            "manifestSHA256": descriptor.source.manifestSHA256, "shardSHA256": descriptor.source.shardSHA256,
            "normalizedRowSHA256": descriptor.source.normalizedRowSHA256]
        try store.upsertJob(row)
        emit("jobs.changed")
    }
    func dispatchAggregates(_ command: String, payload: [String: Any]) async throws -> [String: Any] {
        if command == "aggregates.list" {
            guard payload.isEmpty else { throw DesktopError.message("汇总目录不接受自报来源") }
            guard let catalog = try await library.aggregateCatalog() else { return ["records": [], "available": false, "notice": "当前目录没有可核验的汇总见证，请同步来源后读取已发布汇总"] }
            return try JSONSerialization.jsonObject(with: JSONEncoder().encode(catalog)) as! [String: Any]
        }
        try requireMainContextAvailable()
        if command == "aggregates.open" {
            guard Set(payload.keys) == ["id"], let id = payload["id"] as? String, id.hasPrefix("page:"), id.count > 5 else { throw DesktopError.message("请选择当前汇总目录中的页面") }
            try requireAggregateTransitionAvailable()
            aggregateOpenSequence += 1
            let sequence = aggregateOpenSequence, generation = contextGeneration
            aggregateTransitionPending = true
            defer { if sequence == aggregateOpenSequence { aggregateTransitionPending = false } }
            try await flushEdits(); try Task.checkCancellation()
            guard sequence == aggregateOpenSequence, generation == contextGeneration, !terminationPending, !maintenanceBusy else { throw DesktopError.message("保存期间阅读资料已变化，汇总未打开") }
            try requireAggregateTransitionAvailable()
            // This is a real main-context transition. No old paper/PDF can supply a menu operation.
            contextGeneration += 1
            pdfView.document = nil; pdfView.isHidden = true
            currentPaperID = ""; currentPaper = [:]; currentArticle = [:]
            currentPDFSHA = ""; currentPDFPath = nil; pdfOwner = ""; pdfVersion = ""
            selectionSource = [:]; annotationsByID = [:]; offlinePDF = nil; currentPDFReceipt = [:]; pendingPDFPage = nil
            let session = AggregateViewSession(generation: contextGeneration, aggregateID: id)
            aggregateSession = session
            return ["id": id, "sessionID": session.id, "contextGeneration": session.generation]
        }
        guard Set(payload.keys).isSubset(of: ["id", "sessionID", "index"]) else { throw DesktopError.message("汇总操作不接受正文或任意地址") }
        if command == "aggregates.leave" {
            // A delayed leave for an older presentation cannot close a newer context.
            guard let current = aggregateSession, payload["id"] as? String == current.aggregateID, payload["sessionID"] as? String == current.id, current.generation == contextGeneration else { return ["left": false, "changed": true] }
            contextGeneration += 1; return ["left": true]
        }
        let session = try aggregateSession(payload)
        if command == "aggregates.document" {
            guard !session.loading else { throw DesktopError.message("汇总正文正在读取") }
            session.loading = true
            defer { session.loading = false }
            return try await runJob(command, payload: [:], identifier: session.id) { _ in
                guard self.aggregateSession === session, session.generation == self.contextGeneration else { throw CancellationError() }
                // A view session grants no source capability. The actor resolves the actual row
                // only after the previous paper/PDF context is closed.
                let access = try await self.library.aggregateReadAccess(id: session.aggregateID)
                try Task.checkCancellation()
                guard self.aggregateSession === session, session.generation == self.contextGeneration else { throw CancellationError() }
                session.access = access
                try self.recordAggregateJobSource(session, access: access)
                let document = try await self.library.aggregatePresentation(access)
                try Task.checkCancellation()
                guard self.aggregateSession === session, session.generation == self.contextGeneration, !self.terminationPending, !self.maintenanceBusy else { throw DesktopError.message("汇总已关闭，迟到正文未安装") }
                try self.requireMainContextAvailable()
                session.document = document
                var value = try document.bridgeValue()
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
