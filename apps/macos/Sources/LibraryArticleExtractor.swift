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

    static func validateHTMLSafetyGuards(_ text: String, _ textBytes: [UInt8]) throws {
        guard !asciiCaseInsensitiveContains(text, "<!ENTITY") else { throw ServiceError.invalid("文章包含不允许的实体声明。") }
        guard !asciiCaseInsensitiveContains(text, "<?xml") else { throw ServiceError.invalid("文章包含不支持的XML声明，未绕过HTML解析。") }
        let doctypePat = Array("<!doctype".utf8)
        var di = 0
        while di + doctypePat.count <= textBytes.count {
            if textBytes[di] == 60 {
                var matched = true
                for k in 0..<doctypePat.count {
                    let b = textBytes[di + k]
                    let lc = (65...90).contains(b) ? b + 32 : b
                    if lc != doctypePat[k] { matched = false; break }
                }
                if matched {
                    var dj = di + doctypePat.count
                    while dj < textBytes.count, dj - di <= 65536, textBytes[dj] != 62 { dj += 1 }
                    guard dj < textBytes.count, textBytes[dj] == 62 else { throw ServiceError.invalid("文章声明不完整，未交给外部实体解析器。") }
                    let decl = String(decoding: textBytes[di...dj], as: UTF8.self)
                    guard decl.range(of: #"\A<!DOCTYPE[\t\r\n ]+html[\t\r\n ]*>\z"#, options: [.regularExpression, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")) != nil else {
                        throw ServiceError.invalid("文章包含不支持的DOCTYPE或实体声明。")
                    }
                    di = dj + 1
                    continue
                }
            }
            di += 1
        }
    }

    static func tidyHTMLDocumentSafely(_ raw: String) throws -> XMLDocument {
        let cleaned = stripHTMLControlBytesForTidy(raw)
        let rawBytes = Array(cleaned.utf8)
        guard rawBytes.count <= 16 * 1024 * 1024 else { throw ServiceError.invalid("读取的HTML页面超过16 MiB。") }
        try validateHTMLSafetyGuards(cleaned, rawBytes)
        let adapted = try rewriteHTML5TagsForTidyStrict(
            raw,
            tagMarker: "data-meta-v1-unused",
            preserveTags: [],
            containerTags: html5BlockContainerTags,
            inlineContainerTags: html5InlineContainerTags,
            preserveClientSidecarsScript: true
        )
        return try htmlDocumentPreservingMath(adapted, preserveClientSidecarsScript: true)
    }

    // Foundation HTML tidy removes unknown HTML5/MathML tags, including their
    // TeX annotation. Protect only complete, independently validated MathML;
    // the surrounding HTML still passes through the original HTML sanitizer.
    static func htmlDocumentPreservingMath(_ raw: String, preserveClientSidecarsScript: Bool = false) throws -> XMLDocument {
        let cleanedRaw = stripHTMLControlBytesForTidy(raw)
        let bytes = Array(cleanedRaw.utf8)
        guard bytes.count <= 16 * 1024 * 1024 else { throw ServiceError.invalid("公式保真读取的页面超过16 MiB。") }
        try validateHTMLSafetyGuards(cleanedRaw, bytes)
        struct Tag { let end: Int; let name: String; let closing: Bool; let empty: Bool; let validDelim: Bool }
        enum MathScanToken {
            case notATag
            case bogusComment(Int)
            case tag(Tag)
        }
        func starts(_ text: String, at index: Int) -> Bool {
            let expected = Array(text.utf8); guard index + expected.count <= bytes.count else { return false }
            return expected.indices.allSatisfy { offset in let value = bytes[index + offset]; return (65...90).contains(value) ? value + 32 == expected[offset] : value == expected[offset] }
        }
        func startsExact(_ text: String, at index: Int) -> Bool {
            let expected = Array(text.utf8); guard index + expected.count <= bytes.count else { return false }
            return bytes[index..<(index + expected.count)].elementsEqual(expected)
        }
        func endOf(_ delimiter: String, from start: Int) throws -> Int {
            let expected = Array(delimiter.utf8); var index = start
            while index + expected.count <= bytes.count {
                if bytes[index..<(index + expected.count)].elementsEqual(expected) { return index + expected.count }
                index += 1
            }
            throw ServiceError.invalid("文章中的注释或CDATA没有完整闭合，未猜测公式边界。")
        }
        func scanToken(at start: Int) throws -> MathScanToken {
            switch scanHTML5ByteTag(bytes, at: start, maxLength: 65536) {
            case .notATag:
                return .notATag
            case .bogusComment(let end):
                return .bogusComment(end)
            case .unquotedLessThan:
                throw ServiceError.invalid("文章标签包含不安全或未加引号的尖括号属性值，未猜测解析边界。")
            case .unclosedEOF, .tooLong:
                throw ServiceError.invalid("文章标签不完整或超过64 KiB，未猜测公式边界。")
            case .tag(let name, _, let end, let closing, let selfClosing, let validDelim):
                return .tag(Tag(end: end, name: name, closing: closing, empty: selfClosing, validDelim: validDelim))
            }
        }
        func declarationEnd(at start: Int) throws -> Int {
            // Non-PHP PI / DOCTYPE: terminates at the first '>' without quote toggling (matches libtidy).
            var index = start + 2
            while index < bytes.count, index - start <= 65536 {
                if bytes[index] == 62 { return index + 1 }
                index += 1
            }
            throw ServiceError.invalid("文章声明不完整，未交给外部实体解析器。")
        }
        let nonce = "paperdigest-math-" + UUID().uuidString.lowercased() + "-"
        guard !cleanedRaw.contains(nonce) else { throw ServiceError.invalid("公式保真标记发生冲突。") }
        let rcdataElements: Set<String> = ["textarea", "title", "xmp", "iframe", "noembed", "noframes"]
        let ltEntity = Array("&lt;".utf8)
        let ltJSON = Array("\\u003c".utf8)
        let inertComment = Array("<!-- -->".utf8)
        var position = 0, last = 0, output = Data(), formulas: [(String, XMLElement)] = [], formulaBytes = 0
        while position < bytes.count {
            guard bytes[position] == 60 else { position += 1; continue }
            if starts("<!--", at: position) {
                let cScan = scanHTML5CommentEnd(bytes, from: position)
                guard cScan.closed else { throw ServiceError.invalid("文章中的注释或CDATA没有完整闭合，未猜测公式边界。") }
                if cScan.needsRewrite {
                    output.append(contentsOf: bytes[last..<position])
                    output.append(contentsOf: inertComment)
                    last = cScan.end
                }
                position = cScan.end
                continue
            }
            if startsExact("<![CDATA[", at: position) {
                // Outside foreign content (SVG/MathML), WHATWG §13.2.5.42 parses `<![CDATA[...>` as a bogus comment ending at the first '>'.
                var cEnd = position + 9
                while cEnd < bytes.count && bytes[cEnd] != 62 { cEnd += 1 }
                guard cEnd < bytes.count else { throw ServiceError.invalid("文章中的注释或CDATA没有完整闭合，未猜测公式边界。") }
                let endAfter = cEnd + 1
                output.append(contentsOf: bytes[last..<position])
                output.append(contentsOf: inertComment)
                last = endAfter
                position = endAfter
                continue
            }
            if startsExact("<?php", at: position) || startsExact("<%", at: position) || startsExact("<#", at: position) {
                throw ServiceError.invalid("文章包含不支持的服务器脚本或模板标签，未交给HTML解析。")
            }
            if starts("<!", at: position) {
                let end = try declarationEnd(at: position), declaration = String(decoding: bytes[position..<end], as: UTF8.self)
                guard declaration.range(of: #"\A<!DOCTYPE[\t\r\n ]+html[\t\r\n ]*>\z"#, options: [.regularExpression, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")) != nil else { throw ServiceError.invalid("文章包含不支持的DOCTYPE或实体声明。") }
                position = end; continue
            }
            if starts("<?", at: position) {
                position = try declarationEnd(at: position); continue
            }
            let token: Tag
            switch try scanToken(at: position) {
            case .notATag:
                position += 1; continue
            case .bogusComment(let end):
                position = end; continue
            case .tag(let parsed):
                token = parsed
            }
            if token.name.hasSuffix(":math") { throw ServiceError.invalid("暂不支持带前缀的MathML根节点，未静默丢弃公式。") }
            if !token.closing, !token.empty, token.name == "plaintext" {
                output.append(contentsOf: bytes[last..<token.end])
                if token.end > position && bytes[token.end - 1] != 62 {
                    if bytes[token.end - 1] == 47 { output.append(32) }
                    output.append(62)
                }
                appendEscapingLessThan(bytes[token.end..<bytes.count], replacement: ltEntity, to: &output)
                last = bytes.count
                position = bytes.count
                continue
            }
            if !token.closing, token.name == "script" || token.name == "style" || token.name == "server" {
                if token.empty {
                    output.append(contentsOf: bytes[last..<position])
                    output.append(contentsOf: inertComment)
                    last = token.end
                    position = token.end
                    continue
                }
                let bodyEnd: Int
                let closeEnd: Int
                switch scanRawTextElementEnd(bytes, rawName: token.name, from: token.end) {
                case .closed(let bEnd, let cEnd):
                    bodyEnd = bEnd; closeEnd = cEnd
                case .unclosed(let bEnd):
                    bodyEnd = bEnd; closeEnd = bytes.count
                case .unsafe:
                    throw ServiceError.invalid("文章原始文本结束标签包含不安全的非ASCII截断字符，未猜测解析边界。")
                }
                output.append(contentsOf: bytes[last..<position])
                if token.name == "script", isJSONCitationScriptOpenTag(bytes[position..<token.end]) {
                    output.append(contentsOf: "<script type=\"application/json\" class=\"paper-tools__citation-record\">".utf8)
                    appendEscapingLessThan(bytes[token.end..<bodyEnd], replacement: ltJSON, to: &output)
                    output.append(contentsOf: "</script>".utf8)
                } else if preserveClientSidecarsScript, token.name == "script", isJSONClientSidecarsScriptOpenTag(bytes[position..<token.end]) {
                    output.append(contentsOf: "<script type=\"application/json\" class=\"paper-tools__client-sidecars\">".utf8)
                    appendEscapingLessThan(bytes[token.end..<bodyEnd], replacement: ltJSON, to: &output)
                    output.append(contentsOf: "</script>".utf8)
                } else {
                    output.append(contentsOf: inertComment)
                }
                last = closeEnd
                position = closeEnd
                continue
            }
            if !token.closing, !token.empty, rcdataElements.contains(token.name) {
                let bodyEnd: Int
                let closeEnd: Int
                switch scanRawTextElementEnd(bytes, rawName: token.name, from: token.end) {
                case .closed(let bEnd, let cEnd):
                    bodyEnd = bEnd; closeEnd = cEnd
                case .unclosed(let bEnd):
                    bodyEnd = bEnd; closeEnd = bytes.count
                case .unsafe:
                    throw ServiceError.invalid("文章原始文本结束标签包含不安全的非ASCII截断字符，未猜测解析边界。")
                }
                output.append(contentsOf: bytes[last..<token.end])
                if token.end > position && bytes[token.end - 1] != 62 {
                    if bytes[token.end - 1] == 47 { output.append(32) }
                    output.append(62)
                }
                appendEscapingLessThan(bytes[token.end..<bodyEnd], replacement: ltEntity, to: &output)
                if closeEnd > bodyEnd {
                    output.append(contentsOf: "</\(token.name)>".utf8)
                }
                last = closeEnd
                position = closeEnd
                continue
            }
            if token.name == "math", token.closing { throw ServiceError.invalid("文章包含没有对应起点的MathML结束标签。") }
            guard token.name == "math" else { position = token.end; continue }
            let beginning = position; var end = token.end, depth = token.empty ? 0 : 1
            while depth > 0 {
                guard end < bytes.count, end - beginning <= 256 * 1024 else { throw ServiceError.invalid("单个MathML超过256 KiB或未完整闭合。") }
                if bytes[end] != 60 { end += 1; continue }
                if starts("<!--", at: end) { end = try endOf("-->", from: end + 4); continue }
                if startsExact("<![CDATA[", at: end) { end = try endOf("]]>", from: end + 9); continue }
                guard !starts("<!", at: end) else { throw ServiceError.invalid("MathML中不允许DOCTYPE或实体声明。") }
                guard !starts("<?", at: end) else { throw ServiceError.invalid("MathML中不允许处理指令。") }
                switch try scanToken(at: end) {
                case .notATag:
                    end += 1
                case .bogusComment(let nextEnd):
                    end = nextEnd
                case .tag(let child):
                    if child.name == "math" {
                        if child.closing { depth -= 1 } else if !child.empty { depth += 1 }
                    }
                    end = child.end
                }
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
        let finalHTML = String(decoding: output, as: UTF8.self)
        try validateHTMLSafetyGuards(finalHTML, Array(output))
        let doc = try XMLDocument(xmlString: finalHTML, options: [.documentTidyHTML, .nodeLoadExternalEntitiesNever])
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
            guard attributes.contains(name), !rawName.contains(":"), value.utf8.count <= 4096, !asciiCaseInsensitiveContains(value, "url("), !asciiCaseInsensitiveContains(value, "javascript:") else { throw ServiceError.invalid("MathML包含不支持的属性，未猜测公式结构。") }
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

    static func articlePlainText(_ body: XMLElement) throws -> String {
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

    private static func isConferenceDirectoryURL(_ url: URL, siteBaseURL: URL) -> Bool {
        if url.absoluteString == siteBaseURL.appendingPathComponent("conferences", isDirectory: true).absoluteString {
            return true
        }
        return siteBaseURL.host?.lowercased() == "nanless.github.io"
            && LibraryService.expectedSiteBasePath(siteBaseURL) == "/audio-research-portal/"
            && url.absoluteString == "https://nanless.github.io/audio-paper-digest-blog/conferences/"
    }

    /// Website aggregates have their own descriptor/body contract and never pass through Paper extraction.
    static func extractAggregateHTML(_ bytes: Data, descriptor: PublishedAggregate, responseURL: URL, fetchedAt: String, siteBaseURL: URL = PublishedAggregateReader.site, format: AggregateDocumentFormat? = nil) throws -> AggregateDocument {
        guard bytes.count > 0, bytes.count <= 16 * 1024 * 1024, let raw = String(data: bytes, encoding: .utf8), (ISO8601DateFormatter().date(from: fetchedAt) != nil || { let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return format.date(from: fetchedAt) != nil }()) else { throw AggregateFailure.invalid("汇总网页原件编码、时间或大小无效") }
        let expected = try PublishedAggregateReader.pageURL(descriptor.sourceURL, siteBase: siteBaseURL)
        try PublishedAggregateReader.require(responseURL.absoluteString == expected.absoluteString, "汇总实际响应地址不一致")
        // Preserve ordinary HTML5 grouping in Foundation tidy via tag-aware rewriting (never corrupting attributes/comments/raw text).
        let adapted = try rewriteHTML5TagsForTidyStrict(
            raw,
            tagMarker: "data-aggregate-v1-unused",
            preserveTags: [],
            containerTags: html5BlockContainerTags,
            inlineContainerTags: html5InlineContainerTags
        )
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
            if isConferenceDirectoryURL(expected, siteBaseURL: siteBaseURL) { selector = "//div[@id='conference-directory' and contains(concat(' ',normalize-space(@class),' '),' conference-directory ')]" }
            else { selector = "//div[contains(concat(' ',normalize-space(@class),' '),' reader-guide-content ') and contains(concat(' ',normalize-space(@class),' '),' post-content ')]" }
        }
        let nodes = try doc.nodes(forXPath: selector)
        guard nodes.count == 1, let body = nodes.first as? XMLElement else { throw AggregateFailure.invalid("汇总正文结构缺失或重复，未读取导航/首页代替") }
        guard (try body.nodes(forXPath: "ancestor-or-self::*[@hidden]")).isEmpty else { throw AggregateFailure.invalid("汇总正文容器或其祖先被标记为隐藏，未读取隐藏正文") }
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
        try PublishedAggregateReader.require(resources.count <= 512, "汇总图片数量超过本入口上限")
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
        let adapted = try rewriteHTML5TagsForTidyStrict(
            raw,
            tagMarker: marker,
            preserveTags: ["figure", "figcaption"],
            containerTags: html5BlockContainerTags,
            inlineContainerTags: html5InlineContainerTags
        )
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
            if isConferenceDirectoryURL(expected, siteBaseURL: siteBaseURL) { selector = "//div[@id='conference-directory' and contains(concat(' ',normalize-space(@class),' '),' conference-directory ')]" }
            else { selector = "//div[contains(concat(' ',normalize-space(@class),' '),' reader-guide-content ') and contains(concat(' ',normalize-space(@class),' '),' post-content ')]" }
        }
        let nodes = try doc.nodes(forXPath: selector)
        guard nodes.count == 1, let body = nodes.first as? XMLElement else { throw AggregateFailure.invalid("汇总正文结构缺失或重复，未读取导航/首页代替") }
        guard (try body.nodes(forXPath: "ancestor-or-self::*[@hidden]")).isEmpty else { throw AggregateFailure.invalid("汇总正文容器或其祖先被标记为隐藏，未读取隐藏正文") }
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
        guard nodes.count == 1, let body = nodes.first as? XMLElement else { throw ServiceError.invalid("网站正文结构已变化，未读取导航或用模型补写。请保留旧导读并更新适配器。") }
        guard (try body.nodes(forXPath: "ancestor-or-self::*[@hidden]")).isEmpty else { throw ServiceError.invalid("网站正文容器或其祖先被标记为隐藏，拒绝读取。") }
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
        let marker = "data-article-tag-" + UUID().uuidString.lowercased()
        let protectedTags: Set<String> = ["figure", "figcaption", "details", "summary"]
        let adapted = try rewriteHTML5TagsForTidyStrict(
            raw,
            tagMarker: marker,
            preserveTags: protectedTags,
            containerTags: html5BlockContainerTags,
            inlineContainerTags: html5InlineContainerTags
        )
        let doc = try htmlDocumentPreservingMath(adapted)
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
        guard (try body.nodes(forXPath: "ancestor-or-self::*[@hidden]")).isEmpty else { throw ServiceError.invalid("网站正文容器或其祖先被标记为隐藏，拒绝读取。") }
        for hidden in try body.nodes(forXPath: ".//*[@hidden]") { hidden.detach() }
        for anchor in try body.nodes(forXPath: ".//*[self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6]//a[contains(concat(' ', normalize-space(@class), ' '), ' anchor ')]") {
            anchor.detach()
        }
        let groups = try body.nodes(forXPath: ".//div[@" + marker + "]").compactMap { node -> (XMLElement, String, Bool)? in
            guard let el = node as? XMLElement,
                  let tag = el.attribute(forName: marker)?.stringValue?.lowercased(),
                  protectedTags.contains(tag) else { return nil }
            return (el, tag, tag == "details" && el.attribute(forName: "open") != nil)
        }
        try sanitize(body, pageURL: pageURL)
        for (el, tag, hadOpen) in groups {
            el.name = tag
            if hadOpen && el.attribute(forName: "open") == nil {
                el.addAttribute(XMLNode.attribute(withName: "open", stringValue: "") as! XMLNode)
            }
        }
        let images = try body.nodes(forXPath: ".//img").compactMap { n -> Resource? in
            guard let element = n as? XMLElement, let source = element.attribute(forName: "src")?.stringValue else { return nil }
            return Resource(sourceURL: source, kind: "image", localPath: nil, sha256: nil, missingReason: nil)
        }
        guard images.count <= 64 else { throw ServiceError.invalid("单篇图片超过64张，未开始批量下载。") }
        let html = (body.children ?? []).map { $0.xmlString(options: [.nodePreserveWhitespace]) }.joined()
        return presentSourceWarning(Article(paperID: paper.id, html: html, markdown: nil, plainText: try articlePlainText(body), citation: citation,
                       resources: images, sourceURL: paper.sourceURL ?? paper.blogURL, pdfURL: paper.pdfURL, sourceVersion: paper.sourceVersion,
                       fetchedAt: now(), revisionSHA256: sha256(Data(html.utf8)), completeOffline: false,
                       notices: ["兼容读取现有网站正文；PDF页内定位仅在真实匹配后提供。"], mathMLContract: "published-html-mathml"), blogURL: pageURL.absoluteString)
    }

    static func sanitize(_ root: XMLElement, pageURL: URL) throws {
        let allowed: Set<String> = ["div", "p", "span", "a", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "img", "figure", "figcaption", "strong", "b", "em", "i", "u", "s", "del", "ins", "small", "kbd", "abbr", "cite", "sup", "sub", "br", "hr", "details", "summary", "dl", "dt", "dd", "math", "mrow", "mi", "mo", "mn", "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mtext", "mtable", "mtr", "mtd", "mover", "munder", "munderover", "semantics", "annotation"]
        let attributes: Set<String> = ["id", "class", "title", "alt", "width", "height", "colspan", "rowspan", "scope", "display", "mathvariant", "xmlns", "encoding"]
        for child in root.children ?? [] {
            guard let element = child as? XMLElement else { if child.kind != .text { child.detach() }; continue }
            let tag = (element.name ?? "").lowercased()
            guard allowed.contains(tag) else { element.detach(); continue }
            if tag == "math" { var count = 0; try sanitizeMathML(element, depth: 0, count: &count); continue }
            var cellAlignClass: String? = nil
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
                } else if name == "style" && (tag == "td" || tag == "th") {
                    let rawStyle = (attr.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    if let alignRange = rawStyle.range(of: #"\Atext-align\s*:\s*(left|center|right)\s*;?\z"#, options: .regularExpression) {
                        let matched = String(rawStyle[alignRange])
                        if matched.contains("right") { cellAlignClass = "ta-right" }
                        else if matched.contains("center") { cellAlignClass = "ta-center" }
                        else if matched.contains("left") { cellAlignClass = "ta-left" }
                    }
                    element.removeAttribute(forName: attr.name ?? "")
                } else if name == "open" && tag == "details" {
                    continue
                } else if (name == "start" && tag == "ol") || (name == "value" && tag == "li") {
                    let rawNumber = (attr.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if rawNumber.range(of: #"\A-?[0-9]{1,9}\z"#, options: .regularExpression) != nil {
                        attr.stringValue = rawNumber
                    } else {
                        element.removeAttribute(forName: attr.name ?? "")
                    }
                } else if !attributes.contains(name) { element.removeAttribute(forName: attr.name ?? "") }
            }
            if let alignClass = cellAlignClass {
                let existing = (element.attribute(forName: "class")?.stringValue ?? "").split(whereSeparator: { $0.isWhitespace }).map(String.init)
                if !existing.contains(alignClass) {
                    let nextClass = (existing + [alignClass]).joined(separator: " ")
                    element.removeAttribute(forName: "class")
                    element.addAttribute(XMLNode.attribute(withName: "class", stringValue: nextClass) as! XMLNode)
                }
            }
            if tag == "a" { element.addAttribute(XMLNode.attribute(withName: "rel", stringValue: "noopener noreferrer") as! XMLNode) }
            try sanitize(element, pageURL: pageURL)
        }
    }

    static func localizeImages(_ fragment: String, replacements: [String: String]) throws -> String {
        let marker = "data-loc-tag-" + UUID().uuidString.lowercased()
        let protectedTags: Set<String> = ["figure", "figcaption", "details", "summary"]
        let adapted = try rewriteHTML5TagsForTidyStrict(fragment, tagMarker: marker, preserveTags: protectedTags, containerTags: [])
        let doc = try htmlDocumentPreservingMath("<html><body>\(adapted)</body></html>")
        for node in try doc.nodes(forXPath: "//div[@" + marker + "]") {
            guard let el = node as? XMLElement,
                  let tag = el.attribute(forName: marker)?.stringValue?.lowercased(),
                  protectedTags.contains(tag) else { continue }
            el.removeAttribute(forName: marker)
            el.name = tag
        }
        for node in try doc.nodes(forXPath: "//img") {
            guard let image = node as? XMLElement, let source = image.attribute(forName: "src")?.stringValue else { continue }
            if let local = replacements[source] { image.attribute(forName: "src")?.stringValue = local }
            else { image.removeAttribute(forName: "src"); image.addAttribute(XMLNode.attribute(withName: "data-source-url", stringValue: source) as! XMLNode) }
        }
        return try doc.nodes(forXPath: "//body").first?.children?.map { $0.xmlString }.joined() ?? ""
    }
}
