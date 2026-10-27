import Foundation

/// Images are a separate derivation of one already cold-verified HTML revision. Never a Paper capability.
struct AggregateImageSlot: Codable, Sendable, Equatable {
    let index: Int
    let sourceURL: String?
    let alternative: String
    let caption: String
}
struct AggregateImagePlan: Codable, Sendable, Equatable {
    let contract: String
    let descriptor: PublishedAggregate
    let rawHTMLSHA256: String
    let originalBodySHA256: String
    let slots: [AggregateImageSlot]
    let templateBodyHTML: String
    let templateBodySHA256: String
}
struct AggregateImageRecord: Codable, Sendable, Equatable {
    let slot: AggregateImageSlot
    let sha256: String?
    let mime: String?
    let bytes: Int?
    let missingReason: String?
}
struct AggregateResourceManifest: Codable, Sendable, Equatable {
    let contract: String
    let plan: AggregateImagePlan
    let observedAt: String
    let images: [AggregateImageRecord]
    let renderedBodySHA256: String
    let completeOffline: Bool
}
struct AggregateImageBytes: Sendable {let data: Data; let mime: String}
struct AggregateResourceRender: Sendable {
    let manifest: AggregateResourceManifest
    let manifestSHA256: String
    let bodyHTML: String
}

enum AggregateResources {
    static let contract = "published-aggregate-image-render-v1"
    static let renderDirectory = "aggregate-resource-renders-macos-v1"
    static let maxImageBytes = 16 * 1024 * 1024
    static let maxTotalBytes = 64 * 1024 * 1024
    // Each embedded reference consumes display bytes even when transport and storage deduplicate it.
    static let maxReferencedBytes = 64 * 1024 * 1024
    static func html(_ root: XMLElement) -> String {(root.children ?? []).map{$0.xmlString(options:[.nodePreserveWhitespace])}.joined()}
    static func fragment(_ source: AggregateDocument,plan:AggregateImagePlan) throws -> (XMLDocument,XMLElement) {
        try PublishedAggregateReader.require(PublishedAggregateReader.sha(Data(source.bodyHTML.utf8)) == source.sanitizedBodySHA256, "原汇总正文身份不符")
        try PublishedAggregateReader.require(PublishedAggregateReader.sha(Data(plan.templateBodyHTML.utf8))==plan.templateBodySHA256,"图片正文派生身份不符")
        let doc = try XMLDocument(xmlString:"<div>"+plan.templateBodyHTML+"</div>",options:[.nodeLoadExternalEntitiesNever,.nodePreserveWhitespace])
        guard let root=doc.rootElement() else{throw AggregateFailure.invalid("汇总图片正文缺失")};return (doc,root)
    }
    /// `body` comes from the normal native HTML extraction and sanitizer; no bridge-supplied tree or URL.
    static func plan(source: AggregateDocument, sanitizedBody: XMLElement) throws -> AggregateImagePlan {
        let images=try sanitizedBody.nodes(forXPath:".//img");try PublishedAggregateReader.require(images.count<=128,"汇总图片超过上限")
        let slots=images.enumerated().map { index,node -> AggregateImageSlot in
            let image=node as! XMLElement
            var parent=image.parent;var caption=""
            while let element=parent as? XMLElement {
                if element.name?.lowercased()=="figure"{caption=(try? element.nodes(forXPath:".//figcaption").map{$0.stringValue ?? ""}.joined(separator:"\n")) ?? "";break};parent=element.parent
            }
            caption=caption.trimmingCharacters(in:.whitespacesAndNewlines)
            let source=image.attribute(forName:"src")?.stringValue
            image.removeAttribute(forName:"src")
            return .init(index:index,sourceURL:source,alternative:image.attribute(forName:"alt")?.stringValue ?? "",caption:caption)
        }
        // This is explicitly a new source-bound body derivation; the immutable v1 body stays unchanged.
        let template=html(sanitizedBody)
        return .init(contract:contract,descriptor:source.descriptor,rawHTMLSHA256:source.rawHTMLSHA256,originalBodySHA256:source.sanitizedBodySHA256,slots:slots,templateBodyHTML:template,templateBodySHA256:PublishedAggregateReader.sha(Data(template.utf8)))
    }
    static func validateReferenceBudget(_ images:[AggregateImageRecord]) throws {
        try PublishedAggregateReader.require(images.count<=128,"汇总图片超过上限")
        // Reject the whole cold observation before allocating any base64 or rendered image nodes.
        var referencedBytes=0
        for record in images where record.sha256 != nil {
            guard let size=record.bytes,size>0,size<=maxImageBytes,size<=maxReferencedBytes-referencedBytes else{throw AggregateFailure.invalid("页面图片引用累计超过64 MiB")}
            referencedBytes+=size
        }
    }
    static func render(source: AggregateDocument,plan: AggregateImagePlan,images: [AggregateImageRecord],assets: [String:AggregateImageBytes]) throws -> String {
        try PublishedAggregateReader.require(plan.contract==contract&&plan.descriptor==source.descriptor&&plan.rawHTMLSHA256==source.rawHTMLSHA256&&plan.originalBodySHA256==source.sanitizedBodySHA256&&images.map{$0.slot}==plan.slots,"图片清单与原HTML/目录/位置不一致")
        try validateReferenceBudget(images)
        let (document,root)=try fragment(source,plan:plan);defer{withExtendedLifetime(document){}};let nodes=try root.nodes(forXPath:".//img")
        try PublishedAggregateReader.require(nodes.count==images.count&&plan.slots.enumerated().allSatisfy{$0.offset==$0.element.index},"图片位置清单无效")
        for (index,node) in nodes.enumerated() {
            let image=node as! XMLElement,record=images[index]
            image.removeAttribute(forName:"src")
            if let sha=record.sha256,let mime=record.mime,let size=record.bytes {
                guard record.missingReason==nil,record.slot.sourceURL != nil,PublishedAggregateReader.validSHA(sha),let asset=assets[sha],asset.mime==mime,asset.data.count==size,size>0,size<=maxImageBytes,PublishedAggregateReader.sha(asset.data)==sha else{throw AggregateFailure.invalid("图片真实字节或类型身份不一致")}
                try PublishedAggregateReader.require(LibraryService.aggregateImageMIME(asset.data)==mime,"图片内容类型不符")
                image.addAttribute(XMLNode.attribute(withName:"src",stringValue:"data:"+mime+";base64,"+asset.data.base64EncodedString()) as! XMLNode)
            }else{
                try PublishedAggregateReader.require(record.sha256==nil&&record.mime==nil&&record.bytes==nil&&record.missingReason?.isEmpty==false,"图片缺项状态无效")
                let placeholder=XMLNode.text(withStringValue:"[图片未缓存"+(record.slot.alternative.isEmpty ? "":"："+record.slot.alternative)+"]") as! XMLNode
                if let parent=image.parent as? XMLElement{parent.insertChild(placeholder,at:image.index);image.detach()}
            }
        }
        return html(root)
    }
}
