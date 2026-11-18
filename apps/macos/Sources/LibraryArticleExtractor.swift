import Foundation

extension LibraryService {
    static func presentSourceWarning(_ article: Article, blogURL: String? = nil) -> Article {
        guard case .object(let fields) = article.citation else { return article }
        var citation: [String: Any] = [:]
        for key in ["contract", "schemaFingerprint", "version", "schemaVersion", "policyVersion", "verified", "identityStatus", "paperKey", "paperId", "pageUrl", "sourceUrl", "url", "pdfUrl", "sourceKind", "arxivId", "sourceVersionWarning"] {
            guard let field = fields[key] else { continue }
            switch field {
            case .string(let value): citation[key] = value
            case .bool(let value): citation[key] = value
            default: citation[key] = NSNull()
            }
        }
        var result = article
        result.notices = PublishedSourceWarning.merge(article.notices, citation: citation, material: .init(paperID: article.paperID, blogURL: article.blogURL ?? blogURL, sourceURL: article.sourceURL, pdfURL: article.pdfURL, sourceVersion: article.sourceVersion))
        return result
    }

    // Foundation HTML tidy removes unknown HTML5/MathML tags, including their
    // TeX annotation. Protect only complete, independently validated MathML;
    // the surrounding HTML still passes through the original HTML sanitizer.
    static func htmlDocumentPreservingMath(_ raw: String) throws -> XMLDocument {
        let bytes = Array(raw.utf8)
        guard bytes.count <= 16 * 1024 * 1024 else { throw ServiceError.invalid("公式保真读取的页面超过16 MiB。") }
        guard !raw.localizedCaseInsensitiveContains("<!ENTITY") else { throw ServiceError.invalid("文章包含不允许的实体声明。") }
        struct Tag { let end: Int; let name: String; let closing: Bool; let empty: Bool }
        func starts(_ text: String, at index: Int) -> Bool {
            let expected = Array(text.utf8); guard index + expected.count <= bytes.count else { return false }
            return expected.indices.allSatisfy { offset in let value = bytes[index + offset]; return (65...90).contains(value) ? value + 32 == expected[offset] : value == expected[offset] }
        }
        func endOf(_ delimiter: String, from start: Int) throws -> Int {
            let expected = Array(delimiter.utf8); var index = start
            while index + expected.count <= bytes.count {
                if bytes[index..<(index + expected.count)].elementsEqual(expected) { return index + expected.count }
                index += 1
            }
            throw ServiceError.invalid("文章中的注释或CDATA没有完整闭合，未猜测公式边界。")
        }
        func tag(at start: Int) throws -> Tag? {
            guard bytes[start] == 60 else { return nil }
            var index = start + 1, closing = false
            if index < bytes.count, bytes[index] == 47 { closing = true; index += 1 }
            let nameStart = index
            while index < bytes.count, ((65...90).contains(bytes[index]) || (97...122).contains(bytes[index]) || (48...57).contains(bytes[index]) || bytes[index] == 45 || bytes[index] == 58) { index += 1 }
            guard index > nameStart else { return nil }
            let name = String(decoding: bytes[nameStart..<index], as: UTF8.self).lowercased()
            var quote: UInt8? = nil
            while index < bytes.count, index - start <= 65536 {
                let value = bytes[index]
                if let active = quote { if value == active { quote = nil } }
                else if value == 34 || value == 39 { quote = value }
                else if value == 62 {
                    var previous = index - 1
                    while previous > start, [9, 10, 13, 32].contains(bytes[previous]) { previous -= 1 }
                    return Tag(end: index + 1, name: name, closing: closing, empty: bytes[previous] == 47)
                }
                index += 1
            }
            throw ServiceError.invalid("文章标签不完整或超过64 KiB，未猜测公式边界。")
        }
        func declarationEnd(at start: Int) throws -> Int {
            var index = start + 2, quote: UInt8? = nil
            while index < bytes.count, index - start <= 65536 {
                let value = bytes[index]
                if let active = quote { if value == active { quote = nil } }
                else if value == 34 || value == 39 { quote = value }
                else if value == 62 { return index + 1 }
                index += 1
            }
            throw ServiceError.invalid("文章声明不完整，未交给外部实体解析器。")
        }
        let nonce = "paperdigest-math-" + UUID().uuidString.lowercased() + "-"
        guard !raw.contains(nonce) else { throw ServiceError.invalid("公式保真标记发生冲突。") }
        var position = 0, last = 0, output = Data(), rawText: String? = nil, formulas: [(String, XMLElement)] = [], formulaBytes = 0
        while position < bytes.count {
            if let rawName = rawText {
                // Raw text follows HTML closing-tag rules, not JavaScript/string
                // quoting. Do not tokenize apparent formulas inside this text.
                if bytes[position] == 60, starts("</" + rawName, at: position), let token = try tag(at: position), token.closing, token.name == rawName {
                    rawText = nil; position = token.end
                } else { position += 1 }
                continue
            }
            guard bytes[position] == 60 else { position += 1; continue }
            if starts("<!--", at: position) { position = try endOf("-->", from: position + 4); continue }
            if starts("<![cdata[", at: position) { position = try endOf("]]>", from: position + 9); continue }
            if starts("<!", at: position) {
                let end = try declarationEnd(at: position), declaration = String(decoding: bytes[position..<end], as: UTF8.self)
                guard declaration.range(of: #"\A<!DOCTYPE[\t\r\n ]+html[\t\r\n ]*>\z"#, options: [.regularExpression, .caseInsensitive]) != nil else { throw ServiceError.invalid("文章包含不支持的DOCTYPE或实体声明。") }
                position = end; continue
            }
            guard let token = try tag(at: position) else { position += 1; continue }
            if token.name.hasSuffix(":math") { throw ServiceError.invalid("暂不支持带前缀的MathML根节点，未静默丢弃公式。") }
            if !token.closing, token.name == "plaintext" { position = bytes.count; continue }
            if !token.closing, ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"].contains(token.name) { rawText = token.name; position = token.end; continue }
            if token.name == "math", token.closing { throw ServiceError.invalid("文章包含没有对应起点的MathML结束标签。") }
            guard token.name == "math" else { position = token.end; continue }
            let beginning = position; var end = token.end, depth = token.empty ? 0 : 1
            while depth > 0 {
                guard end < bytes.count, end - beginning <= 256 * 1024 else { throw ServiceError.invalid("单个MathML超过256 KiB或未完整闭合。") }
                if bytes[end] != 60 { end += 1; continue }
                if starts("<!--", at: end) { end = try endOf("-->", from: end + 4); continue }
                if starts("<![cdata[", at: end) { end = try endOf("]]>", from: end + 9); continue }
                guard !starts("<!", at: end) else { throw ServiceError.invalid("MathML中不允许DOCTYPE或实体声明。") }
                if let child = try tag(at: end) {
                    if child.name == "math" {
                        if child.closing { depth -= 1 } else if !child.empty { depth += 1 }
                    }
                    end = child.end
                } else { end += 1 }
            }
            guard end - beginning <= 256 * 1024, formulas.count < 512, formulaBytes + end - beginning <= 2 * 1024 * 1024 else { throw ServiceError.invalid("MathML数量或总大小超过保真读取上限。") }
            let source = String(decoding: bytes[beginning..<end], as: UTF8.self)
            let parsed = try XMLDocument(xmlString: source, options: [.nodePreserveWhitespace, .nodeLoadExternalEntitiesNever])
            guard let math = parsed.rootElement(), math.name?.lowercased() == "math" else { throw ServiceError.invalid("MathML必须是独立且完整的math节点。") }
            var count = 0; try sanitizeMathML(math, depth: 0, count: &count)
            // In HTML, an unqualified <math> enters the MathML namespace even
            // without an explicit xmlns. Pin it before inserting into XHTML.
            if math.uri == nil { math.addNamespace(XMLNode.namespace(withName: "", stringValue: "http://www.w3.org/1998/Math/MathML") as! XMLNode) }
            let marker = nonce + String(formulas.count)
            output.append(contentsOf: bytes[last..<beginning]); output.append(contentsOf: "<span id=\"\(marker)\"></span>".utf8)
            formulas.append((marker, math.copy() as! XMLElement)); formulaBytes += end - beginning; last = end; position = end
        }
        output.append(contentsOf: bytes[last..<bytes.count])
        let doc = try XMLDocument(xmlString: String(decoding: output, as: UTF8.self), options: [.documentTidyHTML, .nodeLoadExternalEntitiesNever])
        for (marker, math) in formulas {
            let matches = try doc.nodes(forXPath: "//*[@id='\(marker)']")
            guard matches.count == 1, let slot = matches.first as? XMLElement, slot.name?.lowercased() == "span", slot.childCount == 0, let parent = slot.parent as? XMLElement else { throw ServiceError.invalid("HTML解析改变了公式占位，未静默丢弃或异位恢复公式。") }
            parent.replaceChild(at: slot.index, with: math)
        }
        guard !doc.xmlString.contains(nonce) else { throw ServiceError.invalid("公式保真占位没有完全恢复。") }
        return doc
    }

    private static func sanitizeMathML(_ element: XMLElement, depth: Int, count: inout Int) throws {
        count += 1; guard depth <= 64, count <= 8192 else { throw ServiceError.invalid("MathML层级或节点数量超过保真上限。") }
        let tags: Set<String> = ["math", "semantics", "annotation", "mrow", "mi", "mn", "mo", "mtext", "ms", "mspace", "mfrac", "msqrt", "mroot", "msup", "msub", "msubsup", "mover", "munder", "munderover", "mtable", "mtr", "mlabeledtr", "mtd", "mstyle", "mpadded", "mphantom", "menclose", "mmultiscripts", "mprescripts", "none", "merror"]
        let attributes: Set<String> = ["display", "mathvariant", "encoding", "stretchy", "fence", "separator", "accent", "accentunder", "symmetric", "movablelimits", "largeop", "lspace", "rspace", "width", "height", "depth", "voffset", "minsize", "maxsize", "mathsize", "mathcolor", "mathbackground", "displaystyle", "scriptlevel", "columnalign", "rowalign", "columnspacing", "rowspacing", "columnlines", "rowlines", "columnspan", "rowspan", "equalrows", "equalcolumns", "frame", "framespacing", "notation", "linethickness", "numalign", "denomalign", "bevelled", "form", "dir", "id", "class", "title"]
        guard let rawName = element.name, !rawName.contains(":"), tags.contains(rawName.lowercased()), element.uri == nil || element.uri == "http://www.w3.org/1998/Math/MathML" else { throw ServiceError.invalid("MathML包含不支持的外来或活动节点。") }
        element.name = rawName.lowercased()
        for namespace in element.namespaces ?? [] { guard namespace.stringValue == "http://www.w3.org/1998/Math/MathML" else { throw ServiceError.invalid("MathML包含不支持的命名空间。") } }
        for attribute in element.attributes ?? [] {
            let rawName = attribute.name ?? "", name = rawName.lowercased(), value = attribute.stringValue ?? ""
            if name.hasPrefix("on") || ["href", "src", "xlink:href", "style"].contains(name) { element.removeAttribute(forName: rawName); continue }
            guard attributes.contains(name), !rawName.contains(":"), value.utf8.count <= 4096, !value.localizedCaseInsensitiveContains("url("), !value.localizedCaseInsensitiveContains("javascript:") else { throw ServiceError.invalid("MathML包含不支持的属性，未猜测公式结构。") }
            attribute.name = name
        }
        if element.name == "annotation" {
            guard ["application/x-tex", "application/x-latex", "text/plain"].contains(element.attribute(forName: "encoding")?.stringValue ?? ""), !(element.children ?? []).contains(where: { $0 is XMLElement }) else { throw ServiceError.invalid("MathML annotation必须是受支持编码的纯文本，未将嵌套结构猜为TeX。") }
        }
        for child in element.children ?? [] {
            if let nested = child as? XMLElement { try sanitizeMathML(nested, depth: depth + 1, count: &count) }
            else {
                count += 1; guard count <= 8192 else { throw ServiceError.invalid("MathML节点数量超过保真上限。") }
                if child.kind == .text { element.replaceChild(at: child.index, with: XMLNode.text(withStringValue: child.stringValue ?? "") as! XMLNode) } else { child.detach() }
            }
        }
    }

    private static func articlePlainText(_ body: XMLElement) throws -> String {
        let copy = body.copy() as! XMLElement
        let roots = try copy.nodes(forXPath: ".//*[local-name()='math' and not(ancestor::*[local-name()='math'])]")
        for case let math as XMLElement in roots {
            let annotations = try math.nodes(forXPath: "./*[local-name()='semantics']/*[local-name()='annotation' and @encoding='application/x-tex']")
            guard annotations.count <= 1 else { throw ServiceError.invalid("同一公式有多个TeX annotation，未猜测应采用哪个。") }
            let annotation = annotations.first?.stringValue
            let block = math.attribute(forName: "display")?.stringValue == "block"
            let text: String
            if let annotation, !annotation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                text = block ? "\n\\[" + annotation + "\\]\n" : "\\(" + annotation + "\\)"
            } else {
                // Annotation is not visible MathML content. Empty/missing TeX
                // does not authorize synthesizing a replacement formula.
                let visible = math.copy() as! XMLElement
                for node in try visible.nodes(forXPath: ".//*[local-name()='annotation']") { node.detach() }
                let value = visible.stringValue ?? ""; text = block ? "\n" + value + "\n" : value
            }
            guard let parent = math.parent as? XMLElement else { throw ServiceError.invalid("公式文本投影失去原文位置。") }
            parent.replaceChild(at: math.index, with: XMLNode.text(withStringValue: text) as! XMLNode)
        }
        return copy.stringValue ?? ""
    }

    /// Website aggregates have their own descriptor/body contract and never pass through Paper extraction.
    static func extractAggregateHTML(_ bytes: Data, descriptor: PublishedAggregate, responseURL: URL, fetchedAt: String, siteBaseURL: URL = PublishedAggregateReader.site, format: AggregateDocumentFormat? = nil) throws -> AggregateDocument {
        guard bytes.count > 0, bytes.count <= 16 * 1024 * 1024, let raw = String(data: bytes, encoding: .utf8), (ISO8601DateFormatter().date(from: fetchedAt) != nil || { let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return format.date(from: fetchedAt) != nil }()) else { throw AggregateFailure.invalid("汇总网页原件编码、时间或大小无效") }
        let expected = try PublishedAggregateReader.pageURL(descriptor.sourceURL, siteBase: siteBaseURL)
        try PublishedAggregateReader.require(responseURL.absoluteString == expected.absoluteString, "汇总实际响应地址不一致")
        // Preserve ordinary HTML5 grouping in Foundation tidy; this changes only tag names, never attributes or boundaries.
        let containers = try NSRegularExpression(pattern: "(?i)<(/?)(section|article|main)(?=[\\s/>])")
        let adapted = containers.stringByReplacingMatches(in: raw, range: NSRange(raw.startIndex..<raw.endIndex, in: raw), withTemplate: "<$1div")
        let doc = try htmlDocumentPreservingMath(adapted)
        let canonical = try doc.nodes(forXPath: "//link[translate(@rel,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')='canonical']")
        try PublishedAggregateReader.require(canonical.count <= 1, "汇总网页声明多个规范地址")
        if let element = canonical.first as? XMLElement {
            guard let value = element.attribute(forName: "href")?.stringValue else { throw AggregateFailure.invalid("汇总规范地址缺失") }
            try PublishedAggregateReader.require(try PublishedAggregateReader.pageURL(value, siteBase: siteBaseURL) == expected, "汇总规范地址与目录不一致")
        }
        let selector: String
        switch descriptor.kind {
        case .daily, .conference: selector = "//div[@id='article-body' and contains(concat(' ',normalize-space(@class),' '),' post-content ')]"
        case .page:
            if expected.absoluteString == siteBaseURL.appendingPathComponent("conferences", isDirectory: true).absoluteString { selector = "//div[@id='conference-directory' and contains(concat(' ',normalize-space(@class),' '),' conference-directory ')]" }
            else { selector = "//div[contains(concat(' ',normalize-space(@class),' '),' reader-guide-content ') and contains(concat(' ',normalize-space(@class),' '),' post-content ')]" }
        }
        let nodes = try doc.nodes(forXPath: selector)
        guard nodes.count == 1, let body = nodes.first as? XMLElement else { throw AggregateFailure.invalid("汇总正文结构缺失或重复，未读取导航/首页代替") }
        for hidden in try body.nodes(forXPath: ".//*[@hidden]") { hidden.detach() }
        let originalImages = try body.nodes(forXPath: ".//img").compactMap { ($0 as? XMLElement)?.attribute(forName: "src")?.stringValue }
        try sanitize(body, pageURL: expected)
        var resources: [AggregateDocument.Resource] = []
        for source in originalImages {
            if let url = URL(string: source, relativeTo: expected)?.absoluteURL, url.scheme == "https", url.user == nil, url.password == nil {
                resources.append(.init(sourceURL: url.absoluteString, kind: "image", missingReason: "尚未保存该图片；没有声称完整离线"))
            } else { resources.append(.init(sourceURL: source, kind: "image", missingReason: "原图片地址不受本入口支持，未下载或隐藏缺项")) }
        }
        for node in try body.nodes(forXPath: ".//img") { (node as? XMLElement)?.removeAttribute(forName: "src") }
        try PublishedAggregateReader.require(resources.count <= 128, "汇总图片数量超过本入口上限")
        let plain = try articlePlainText(body)
        try PublishedAggregateReader.require(!plain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "汇总没有连续可读正文")
        let html = (body.children ?? []).map { $0.xmlString(options: [.nodePreserveWhitespace]) }.joined()
        let selected = try format ?? AggregateDocumentFormat.current(.macos)
        return AggregateDocument(contract: selected.contract, schemaFingerprint: selected.schemaFingerprint, descriptor: descriptor, responseURL: responseURL.absoluteString, fetchedAt: fetchedAt, rawHTMLSHA256: PublishedAggregateReader.sha(bytes), rawHTMLBytes: bytes.count, sanitizedBodySHA256: PublishedAggregateReader.sha(Data(html.utf8)), bodyHTML: html, plainText: plain, parserContract: selected.parser, resources: resources, completeOffline: false, notices: ["网站汇总只读正文；不具有单篇论文、PDF、模型或Zotero资格。", "原HTML与派生正文分别保存；目录当前性不代表旧网页已重新核验。"] + (resources.isEmpty ? [] : ["部分图片尚未保存，不能称为完整离线页面。"]))
    }

    static func aggregateImagePlan(_ source: AggregateDocument, rawHTML: Data, siteBaseURL: URL = PublishedAggregateReader.site) throws -> AggregateImagePlan {
        try PublishedAggregateReader.require(PublishedAggregateReader.sha(rawHTML) == source.rawHTMLSHA256, "图片原HTML身份不符")
        let bytes = rawHTML, descriptor = source.descriptor, fetchedAt = source.fetchedAt
        guard let responseURL = URL(string: source.responseURL) else { throw AggregateFailure.invalid("图片原响应地址无效") }
        guard bytes.count > 0, bytes.count <= 16 * 1024 * 1024, let raw = String(data: bytes, encoding: .utf8), (ISO8601DateFormatter().date(from: fetchedAt) != nil || { let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return format.date(from: fetchedAt) != nil }()) else { throw AggregateFailure.invalid("汇总网页原件编码、时间或大小无效") }
        let expected = try PublishedAggregateReader.pageURL(descriptor.sourceURL, siteBase: siteBaseURL)
        try PublishedAggregateReader.require(responseURL.absoluteString == expected.absoluteString, "汇总实际响应地址不一致")
        // Independent resource-body derivation retains figure/caption boundaries; the v1 extractor above is unchanged.
        let marker = "data-aggregate-tag-" + UUID().uuidString.lowercased()
        let figures = try NSRegularExpression(pattern: "(?i)<(figure|figcaption)(?=[\\s/>])")
        let figureBody = figures.stringByReplacingMatches(in: raw, range: NSRange(raw.startIndex..<raw.endIndex, in: raw), withTemplate: "<div " + marker + "=\"$1\"")
        let closes = try NSRegularExpression(pattern: "(?i)</(?:figure|figcaption)\\s*>")
        let grouped = closes.stringByReplacingMatches(in: figureBody, range: NSRange(figureBody.startIndex..<figureBody.endIndex, in: figureBody), withTemplate: "</div>")
        let containers = try NSRegularExpression(pattern: "(?i)<(/?)(section|article|main)(?=[\\s/>])")
        let adapted = containers.stringByReplacingMatches(in: grouped, range: NSRange(grouped.startIndex..<grouped.endIndex, in: grouped), withTemplate: "<$1div")
        let doc = try htmlDocumentPreservingMath(adapted); defer { withExtendedLifetime(doc) {} }
        let canonical = try doc.nodes(forXPath: "//link[translate(@rel,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')='canonical']")
        try PublishedAggregateReader.require(canonical.count <= 1, "汇总网页声明多个规范地址")
        if let element = canonical.first as? XMLElement {
            guard let value = element.attribute(forName: "href")?.stringValue else { throw AggregateFailure.invalid("汇总规范地址缺失") }
            try PublishedAggregateReader.require(try PublishedAggregateReader.pageURL(value, siteBase: siteBaseURL) == expected, "汇总规范地址与目录不一致")
        }
        let selector: String
        switch descriptor.kind {
        case .daily, .conference: selector = "//div[@id='article-body' and contains(concat(' ',normalize-space(@class),' '),' post-content ')]"
        case .page:
            if expected.absoluteString == siteBaseURL.appendingPathComponent("conferences", isDirectory: true).absoluteString { selector = "//div[@id='conference-directory' and contains(concat(' ',normalize-space(@class),' '),' conference-directory ')]" }
            else { selector = "//div[contains(concat(' ',normalize-space(@class),' '),' reader-guide-content ') and contains(concat(' ',normalize-space(@class),' '),' post-content ')]" }
        }
        let nodes = try doc.nodes(forXPath: selector)
        guard nodes.count == 1, let body = nodes.first as? XMLElement else { throw AggregateFailure.invalid("汇总正文结构缺失或重复，未读取导航/首页代替") }
        for hidden in try body.nodes(forXPath: ".//*[@hidden]") { hidden.detach() }
        let groups = try body.nodes(forXPath: ".//div[@" + marker + "]").compactMap { node -> (XMLElement, String)? in
            guard let element = node as? XMLElement, let tag = element.attribute(forName: marker)?.stringValue?.lowercased(), ["figure", "figcaption"].contains(tag) else { return nil }; return (element, tag)
        }
        try sanitize(body, pageURL: expected)
        for (element, tag) in groups { element.name = tag }
        return try AggregateResources.plan(source: source, sanitizedBody: body)
    }

    // 真实已发布页面的身份校验：正文唯一、citation 记录与目录一致。引用导出也走这里，
    // 不能因为只取 sidecar 就跳过页面身份检查。
    static func validatePublishedPageIdentity(_ doc: XMLDocument, paper: Paper) throws {
        // Foundation's HTML tidy removes HTML5 <article>/<section> wrappers on macOS;
        // the published body's exact id + class survive and must match uniquely.
        let nodes = try doc.nodes(forXPath: "//div[@id='article-body' and contains(concat(' ', normalize-space(@class), ' '), ' post-content ')]")
        guard nodes.count == 1, nodes.first is XMLElement else { throw ServiceError.invalid("网站正文结构已变化，未读取导航或用模型补写。请保留旧导读并更新适配器。") }
        let citationNode = try doc.nodes(forXPath: "//script[@type='application/json' and contains(concat(' ', normalize-space(@class), ' '), ' paper-tools__citation-record ')]").first
        let attributeNode = try doc.nodes(forXPath: "//*[@data-citation-record]").first as? XMLElement
        guard let rawCitation = (citationNode?.stringValue ?? attributeNode?.attribute(forName: "data-citation-record")?.stringValue)?.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: rawCitation),
              case .object(let fields) = value else { return }
        if case .string(let key) = fields["paperKey"], paper.identityStatus == "verified", !key.isEmpty, key != paper.id {
            throw ServiceError.invalid("页面论文身份与目录不一致，未把其他论文的正文合并进来。")
        }
        if paper.identityStatus == "verified", paper.sourceKind == "arxiv" {
            if case .string(let version) = fields["arxivId"], version.range(of: #"v[1-9][0-9]*$"#, options: .regularExpression) != nil, let expected = paper.sourceVersion, version != expected { throw ServiceError.invalid("页面原文版本与目录不同，未将旧稿标为当前版本。") }
            for (field, expected) in [("sourceUrl", paper.sourceURL), ("pdfUrl", paper.pdfURL)] {
                if case .string(let address) = fields[field], !address.isEmpty, let expected, address != expected { throw ServiceError.invalid("页面来源地址与当前目录不一致，未授予当前版本身份。") }
            }
        }
    }

    static func extractArticle(_ raw: String, paper: Paper, pageURL: URL) throws -> Article {
        let doc = try htmlDocumentPreservingMath(raw)
        try Self.validatePublishedPageIdentity(doc, paper: paper)
        let nodes = try doc.nodes(forXPath: "//div[@id='article-body' and contains(concat(' ', normalize-space(@class), ' '), ' post-content ')]")
        guard let body = nodes.first as? XMLElement else { throw ServiceError.invalid("网站正文结构已变化，未读取导航或用模型补写。请保留旧导读并更新适配器。") }
        var citation = paper.citation
        let citationNode = try doc.nodes(forXPath: "//script[@type='application/json' and contains(concat(' ', normalize-space(@class), ' '), ' paper-tools__citation-record ')]").first
        let attributeNode = try doc.nodes(forXPath: "//*[@data-citation-record]").first as? XMLElement
        if let rawCitation = (citationNode?.stringValue ?? attributeNode?.attribute(forName: "data-citation-record")?.stringValue)?.data(using: .utf8),
           let value = try? JSONDecoder().decode(JSONValue.self, from: rawCitation) {
            citation = value
        }
        try sanitize(body, pageURL: pageURL)
        let images = try body.nodes(forXPath: ".//img").compactMap { n -> Resource? in
            guard let element = n as? XMLElement, let source = element.attribute(forName: "src")?.stringValue else { return nil }
            return Resource(sourceURL: source, kind: "image", localPath: nil, sha256: nil, missingReason: nil)
        }
        guard images.count <= 32 else { throw ServiceError.invalid("单篇图片超过32张，未开始批量下载。") }
        let html = (body.children ?? []).map { $0.xmlString(options: [.nodePreserveWhitespace]) }.joined()
        return presentSourceWarning(Article(paperID: paper.id, html: html, markdown: nil, plainText: try articlePlainText(body), citation: citation,
                       resources: images, sourceURL: paper.sourceURL ?? paper.blogURL, pdfURL: paper.pdfURL, sourceVersion: paper.sourceVersion,
                       fetchedAt: now(), revisionSHA256: sha256(Data(html.utf8)), completeOffline: false,
                       notices: ["兼容读取现有网站正文；PDF页内定位仅在真实匹配后提供。"], mathMLContract: "published-html-mathml"), blogURL: pageURL.absoluteString)
    }

    private static func sanitize(_ root: XMLElement, pageURL: URL) throws {
        let allowed: Set<String> = ["div", "p", "span", "a", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "img", "figure", "figcaption", "strong", "b", "em", "i", "u", "s", "sup", "sub", "br", "hr", "details", "summary", "dl", "dt", "dd", "math", "mrow", "mi", "mo", "mn", "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mtext", "mtable", "mtr", "mtd", "mover", "munder", "munderover", "semantics", "annotation"]
        let attributes: Set<String> = ["id", "class", "title", "alt", "width", "height", "colspan", "rowspan", "scope", "display", "mathvariant", "xmlns", "encoding"]
        for child in root.children ?? [] {
            guard let element = child as? XMLElement else { if child.kind != .text { child.detach() }; continue }
            let tag = (element.name ?? "").lowercased()
            guard allowed.contains(tag) else { element.detach(); continue }
            if tag == "math" { var count = 0; try sanitizeMathML(element, depth: 0, count: &count); continue }
            for attr in element.attributes ?? [] {
                let name = (attr.name ?? "").lowercased()
                if name == "href" && tag == "a" {
                    let raw = attr.stringValue ?? ""
                    if raw.hasPrefix("#") { continue }
                    if let url = URL(string: raw, relativeTo: pageURL)?.absoluteURL, url.scheme == "https", url.user == nil, url.password == nil {
                        attr.stringValue = url.absoluteString
                    } else { element.removeAttribute(forName: attr.name ?? "") }
                } else if name == "src" && tag == "img" {
                    if let url = URL(string: attr.stringValue ?? "", relativeTo: pageURL)?.absoluteURL, url.scheme == "https", url.user == nil, url.password == nil { attr.stringValue = url.absoluteString }
                    else { element.removeAttribute(forName: attr.name ?? "") }
                } else if !attributes.contains(name) { element.removeAttribute(forName: attr.name ?? "") }
            }
            if tag == "a" { element.addAttribute(XMLNode.attribute(withName: "rel", stringValue: "noopener noreferrer") as! XMLNode) }
            try sanitize(element, pageURL: pageURL)
        }
    }

    static func localizeImages(_ fragment: String, replacements: [String: String]) throws -> String {
        let doc = try htmlDocumentPreservingMath("<html><body>\(fragment)</body></html>")
        for node in try doc.nodes(forXPath: "//img") {
            guard let image = node as? XMLElement, let source = image.attribute(forName: "src")?.stringValue else { continue }
            if let local = replacements[source] { image.attribute(forName: "src")?.stringValue = local }
            else { image.removeAttribute(forName: "src"); image.addAttribute(XMLNode.attribute(withName: "data-source-url", stringValue: source) as! XMLNode) }
        }
        return try doc.nodes(forXPath: "//body").first?.children?.map { $0.xmlString }.joined() ?? ""
    }
}
