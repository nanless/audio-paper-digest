import Foundation

// This access is minted from the actor's current source-bound catalog, never from bridge JSON.
final class AggregateReadAccess: Sendable {
    let descriptor: PublishedAggregate
    fileprivate init(_ descriptor: PublishedAggregate) { self.descriptor = descriptor }
}

struct AggregatePresentationDocument: Sendable {
    let source: AggregateDocument
    let isStale: Bool
    let readNotice: String
    let validatedAt: String?
    let displayHTML: String
    fileprivate let links: [String]

    fileprivate init(source: AggregateDocument, access: AggregateReadAccess, stale: Bool, notice: String) throws {
        try PublishedAggregateReader.require(source.descriptor == access.descriptor, "汇总正文与原目录不一致")
        try PublishedAggregateReader.require(PublishedAggregateReader.sha(Data(source.bodyHTML.utf8)) == source.sanitizedBodySHA256, "汇总正文派生身份无效")
        let tree = try XMLDocument(xmlString: "<div>" + source.bodyHTML + "</div>", options: [.nodeLoadExternalEntitiesNever, .nodePreserveWhitespace])
        guard let root = tree.rootElement() else { throw AggregateFailure.invalid("汇总正文为空") }
        var addresses: [String] = []
        for node in try root.nodes(forXPath: ".//a[@href]") {
            guard let anchor = node as? XMLElement, let href = anchor.attribute(forName: "href")?.stringValue else { continue }
            anchor.removeAttribute(forName: "target")
            guard Self.allowedLink(href) else { anchor.removeAttribute(forName: "href"); continue }
            let index = addresses.count; addresses.append(href)
            anchor.attribute(forName: "href")?.stringValue = "#aggregate-link-\(index)"
            anchor.removeAttribute(forName: "data-aggregate-link")
            anchor.addAttribute(XMLNode.attribute(withName: "data-aggregate-link", stringValue: String(index)) as! XMLNode)
        }
        // No network resource or executable capability enters the aggregate frame.
        for node in try root.nodes(forXPath: ".//*") {
            guard let element = node as? XMLElement else { continue }
            for attribute in element.attributes ?? [] {
                let key = (attribute.name ?? "").lowercased()
                if key.hasPrefix("on") || ["src", "srcset", "poster", "srcdoc", "action", "formaction", "style"].contains(key) { element.removeAttribute(forName: attribute.name!) }
            }
        }
        for node in try root.nodes(forXPath: ".//script | .//iframe | .//object | .//embed | .//form | .//style | .//link | .//meta | .//base") { node.detach() }
        for node in try root.nodes(forXPath: ".//img") {
            guard let image = node as? XMLElement, let parent = image.parent as? XMLElement else { continue }
            let description = image.attribute(forName: "alt")?.stringValue ?? ""
            let placeholder = XMLNode.text(withStringValue: "[图片未缓存" + (description.isEmpty ? "" : "：" + description) + "]") as! XMLNode
            parent.insertChild(placeholder, at: image.index); image.detach()
        }
        self.source = source; self.isStale = stale; self.readNotice = notice
        self.validatedAt = stale ? nil : ISO8601DateFormatter().string(from: Date())
        self.displayHTML = (root.children ?? []).map { $0.xmlString(options: [.nodePreserveWhitespace]) }.joined()
        self.links = addresses
    }
    fileprivate static func allowedLink(_ value: String) -> Bool {
        guard !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return false }
        if value.hasPrefix("#") { return value.count > 1 }
        guard let url = URL(string: value), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.port == nil || url.port == 443 else { return false }
        return true
    }
    func bridgeValue() throws -> [String: Any] {
        guard var value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(source)) as? [String: Any] else { throw AggregateFailure.invalid("汇总正文无法呈现") }
        value["displayHTML"] = displayHTML
        value["displayBodySHA256"] = PublishedAggregateReader.sha(Data(displayHTML.utf8))
        value["isStale"] = isStale; value["readNotice"] = readNotice; value["linkCount"] = links.count
        value["validatedAt"] = validatedAt ?? NSNull()
        return value
    }
}

enum AggregateLinkDestination: Sendable, Equatable {
    case anchor(String), aggregate(String), paper(String), external(URL)
}

extension LibraryService {
    func aggregateReadAccess(id: String) throws -> AggregateReadAccess {
        guard let catalog = try aggregateCatalog(), let descriptor = catalog.records.first(where: { $0.id == id }) else { throw AggregateFailure.invalid("当前来源尚未同步该汇总页面") }
        _ = try aggregateOriginalRow(id: id)
        return AggregateReadAccess(descriptor)
    }
    private func requireAggregateAccess(_ access: AggregateReadAccess) throws {
        guard let current = try aggregateCatalog(), current.records.contains(access.descriptor) else { throw AggregateFailure.invalid("原汇总目录已变化，请重新打开") }
        _ = try aggregateOriginalRow(id: access.descriptor.id)
    }
    func aggregatePresentation(_ access: AggregateReadAccess) async throws -> AggregatePresentationDocument {
        try requireAggregateAccess(access)
        // Strict cache replay occurs before fallback selection; corruption is never silently skipped.
        let cached = try aggregateLatestVerifiedDocument(id: access.descriptor.id)
        do {
            let source = try await aggregateDocument(id: access.descriptor.id)
            try Task.checkCancellation(); try requireAggregateAccess(access)
            return try AggregatePresentationDocument(source: source, access: access, stale: false, notice: "已读取并核对网站当前正文")
        } catch {
            if error is CancellationError || Task.isCancelled { throw CancellationError() }
            try requireAggregateAccess(access)
            guard let cached else { throw error }
            return try AggregatePresentationDocument(source: cached, access: access, stale: true, notice: "网站当前正文未能读取；显示本机已核验的旧快照，未声称当前版本")
        }
    }
    func aggregateLink(_ access: AggregateReadAccess, document: AggregatePresentationDocument, index: Int) throws -> AggregateLinkDestination {
        try requireAggregateAccess(access)
        try PublishedAggregateReader.require(document.source.descriptor == access.descriptor && document.links.indices.contains(index), "汇总链接已失效")
        let href = document.links[index]
        if href.hasPrefix("#") { return .anchor(String(href.dropFirst())) }
        guard let url = URL(string: href), AggregatePresentationDocument.allowedLink(href) else { throw AggregateFailure.invalid("汇总链接无效") }
        var page = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        page.fragment = nil; page.query = nil
        if let exact = page.url?.absoluteString {
            if exact == document.source.responseURL, let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment, !fragment.isEmpty { return .anchor(fragment) }
            if let record = try aggregateCatalog()?.records.first(where: { $0.sourceURL == exact }) { return .aggregate(record.id) }
            if let paper = list(limit: 10000).first(where: { $0.identityStatus == "verified" && ($0.blogURL == exact || $0.appearances.contains(exact)) }) { return .paper(paper.id) }
        }
        return .external(url)
    }
}
