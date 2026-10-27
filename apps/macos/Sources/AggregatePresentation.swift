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
    let imageRender: AggregateResourceRender?
    let imageNotice: String

    fileprivate init(source: AggregateDocument, access: AggregateReadAccess, stale: Bool, notice: String, images:AggregateResourceRender?=nil, imageNotice:String="") throws {
        try PublishedAggregateReader.require(source.descriptor == access.descriptor, "汇总正文与原目录不一致")
        try PublishedAggregateReader.require(PublishedAggregateReader.sha(Data(source.bodyHTML.utf8)) == source.sanitizedBodySHA256, "汇总正文派生身份无效")
        if let images {
            try PublishedAggregateReader.require(images.manifest.plan.descriptor==source.descriptor&&images.manifest.plan.rawHTMLSHA256==source.rawHTMLSHA256&&images.manifest.plan.originalBodySHA256==source.sanitizedBodySHA256&&images.manifest.completeOffline==false&&PublishedAggregateReader.sha(Data(images.bodyHTML.utf8))==images.manifest.renderedBodySHA256,"图片呈现与原网页身份不符")
        }
        let tree = try XMLDocument(xmlString: "<div>" + (images?.bodyHTML ?? source.bodyHTML) + "</div>", options: [.nodeLoadExternalEntitiesNever, .nodePreserveWhitespace])
        guard let root = tree.rootElement() else { throw AggregateFailure.invalid("汇总正文为空") }
        var imageSources:[Int:String]=[:]
        if let images {
            let available=images.manifest.images.filter{$0.sha256 != nil},nodes=try root.nodes(forXPath:".//img")
            try PublishedAggregateReader.require(nodes.count==available.count,"图片呈现数量不符")
            for (index,node) in nodes.enumerated() {
                guard let image=node as? XMLElement,let dataURL=image.attribute(forName:"src")?.stringValue,let mime=available[index].mime,dataURL.hasPrefix("data:"+mime+";base64,"),let data=Data(base64Encoded:String(dataURL.dropFirst(("data:"+mime+";base64,").count))),data.count==available[index].bytes,PublishedAggregateReader.sha(data)==available[index].sha256,LibraryService.aggregateImageMIME(data)==mime else{throw AggregateFailure.invalid("图片呈现没有匹配真实核验字节")}
                imageSources[index]=dataURL
            }
        }
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
        for (index,node) in try root.nodes(forXPath: ".//img").enumerated() {
            guard let image = node as? XMLElement, let parent = image.parent as? XMLElement else { continue }
            if let dataURL=imageSources[index]{image.addAttribute(XMLNode.attribute(withName:"src",stringValue:dataURL) as! XMLNode);continue}
            let description = image.attribute(forName: "alt")?.stringValue ?? ""
            let placeholder = XMLNode.text(withStringValue: "[图片未缓存" + (description.isEmpty ? "" : "：" + description) + "]") as! XMLNode
            parent.insertChild(placeholder, at: image.index); image.detach()
        }
        self.source = source; self.isStale = stale; self.readNotice = notice;self.imageRender=images;self.imageNotice=imageNotice
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
        value["imageNotice"]=imageNotice
        if let render=imageRender {
            value["resourceManifestSHA256"]=render.manifestSHA256;value["resourceContract"]=render.manifest.contract;value["resourceObservedAt"]=render.manifest.observedAt;value["resourceBodySHA256"]=render.manifest.renderedBodySHA256
            value["resourceImages"]=render.manifest.images.map{row -> [String:Any] in ["position":row.slot.index,"sourceURL":row.slot.sourceURL as Any? ?? NSNull(),"alternative":row.slot.alternative,"caption":row.slot.caption,"sha256":row.sha256 as Any? ?? NSNull(),"mime":row.mime as Any? ?? NSNull(),"bytes":row.bytes as Any? ?? NSNull(),"missingReason":row.missingReason as Any? ?? NSNull()]}
            value["notices"]=source.notices.map{$0=="部分图片尚未保存，不能称为完整离线页面。" ? "原正文修订首次保存时未含图片；独立图片修订状态见下。":$0}
        }
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
            let images=try await presentationImageResult(source,allowNetwork:true)
            try Task.checkCancellation();try requireAggregateAccess(access)
            return try AggregatePresentationDocument(source: source, access: access, stale: false, notice: "已读取并核对网站当前正文",images:images.0,imageNotice:images.1)
        } catch {
            if error is CancellationError || Task.isCancelled { throw CancellationError() }
            try requireAggregateAccess(access)
            guard let cached else { throw error }
            let images=try await presentationImageResult(cached,allowNetwork:false)
            try Task.checkCancellation();try requireAggregateAccess(access)
            return try AggregatePresentationDocument(source: cached, access: access, stale: true, notice: "网站当前正文未能读取；显示本机已核验的旧快照，未声称当前版本",images:images.0,imageNotice:images.1)
        }
    }
    private func presentationImageResult(_ source:AggregateDocument,allowNetwork:Bool) async throws->(AggregateResourceRender?,String) {
        do{let images=try await aggregatePresentationImages(source,allowNetwork:allowNetwork);return(images,images==nil ? "没有已核验的独立图片修订":"图片按独立保存时刻核验；未声称全部网页资源完整离线")}
        catch is CancellationError{throw CancellationError()}
        catch{return(nil,"图片资源核验未完成；保留只读正文，没有挑选其他资源修订")}
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
            func matchesKnownPage(_ known: String) -> Bool {
                if exact == known { return true }
                // Only one final slash may differ, on an already known same-site page.
                // Query-bearing, encoded, traversal or repeated-slash paths gain no alias.
                guard exact+"/"==known || exact==known+"/",
                      URLComponents(url:url,resolvingAgainstBaseURL:false)?.query == nil,
                      (try? sameSite(exact)) != nil,(try? sameSite(known)) != nil,
                      let origin=URLComponents(string:document.source.responseURL),
                      let candidate=URLComponents(string:exact),let expected=URLComponents(string:known),
                      candidate.scheme=="https",candidate.host==origin.host,candidate.port==origin.port,
                      candidate.host==expected.host,candidate.port==expected.port,
                      expected.query==nil,expected.fragment==nil else{return false}
                for path in [candidate.percentEncodedPath,expected.percentEncodedPath] {
                    guard !path.contains("%"),!path.contains("\\"),!path.contains("//"),
                          !path.split(separator:"/",omittingEmptySubsequences:false).contains(where:{$0=="." || $0==".."}) else{return false}
                }
                return true
            }
            if matchesKnownPage(document.source.responseURL), let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment, !fragment.isEmpty { return .anchor(fragment) }
            if let record = try aggregateCatalog()?.records.first(where: { matchesKnownPage($0.sourceURL) }) { return .aggregate(record.id) }
            if let paper = list(limit: 10000).first(where: { $0.identityStatus == "verified" && (matchesKnownPage($0.blogURL) || $0.appearances.contains(where:matchesKnownPage)) }) { return .paper(paper.id) }
        }
        return .external(url)
    }
}
