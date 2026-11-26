import Foundation
import CryptoKit
import Darwin

/// A website page, deliberately independent of Paper/Article/PDF/citation/model/Zotero capabilities.
struct PublishedAggregate: Codable, Sendable, Equatable, Identifiable {
    enum Kind: String, Codable, Sendable { case daily, conference, page }
    struct Source: Codable, Sendable, Equatable {
        let manifestSHA256: String
        let shardSHA256: String
        let shardBytes: Int
        let shardURL: String
        let rowIndex: Int
        let normalizedRowSHA256: String
        let normalizedRowAlgorithm: String
    }
    let id: String
    let kind: Kind
    let conferenceScope: String?
    let title: String
    let titleZh: String
    let summary: String
    let rawDate: String
    let displayDate: String?
    let categories: [String]
    let tags: [String]
    let sourceURL: String
    let source: Source
}

struct PublishedAggregateCatalog: Codable, Sendable, Equatable {
    let snapshotSHA256: String
    let sourceRecordCount: Int
    let aggregateCount: Int
    let records: [PublishedAggregate]
}

struct AggregateDocumentFormat {
    static let family="published-aggregate-document"
    enum Platform:String {case macos,android}
    let contract:String
    let schemaFingerprint:String?
    let parser:String
    private init(header:[String:Any], platform:Platform)throws {
        guard ClientProtocols.hasValidHeader(header,Self.family),let raw=header["contract"] as? String else {
            throw AggregateFailure.invalid("汇总正文格式无效")
        }
        contract=raw
        schemaFingerprint=header["schemaFingerprint"] as? String
        if let schemaFingerprint {
            let schema=try ClientProtocols.declaredSchema(raw,Self.family,schemaFingerprint)
            guard let profiles=schema["parserProfiles"] as? [String:String],let profile=profiles[platform.rawValue] else {
                throw AggregateFailure.invalid("汇总正文缺少实际平台解析声明")
            }
            parser=profile
        } else {
            parser=try ClientProtocols.historicalContract("published-aggregate-parser-profile",variant:platform.rawValue)
        }
    }
    static func current(_ platform:Platform)throws->Self {
        try Self(header:ClientProtocols.record(Self.family),platform:platform)
    }
    static func read(_ bytes:Data, platform:Platform)throws->(AggregateDocument,Self) {
        guard let object=try JSONSerialization.jsonObject(with:bytes) as? [String:Any] else {
            throw AggregateFailure.invalid("汇总正文格式无效")
        }
        let format=try Self(header:object,platform:platform)
        guard object["parserContract"] as? String == format.parser else {
            throw AggregateFailure.invalid("汇总正文平台解析声明无效")
        }
        return (try JSONDecoder().decode(AggregateDocument.self,from:bytes),format)
    }
}

struct AggregateDocument: Codable, Sendable, Equatable {
    struct Resource: Codable, Sendable, Equatable {
        let sourceURL: String
        let kind: String
        let missingReason: String
    }
    let contract: String
    let schemaFingerprint: String?
    let descriptor: PublishedAggregate
    let responseURL: String
    let fetchedAt: String
    let rawHTMLSHA256: String
    let rawHTMLBytes: Int
    let sanitizedBodySHA256: String
    let bodyHTML: String
    let plainText: String
    let parserContract: String
    let resources: [Resource]
    let completeOffline: Bool
    let notices: [String]
}

enum AggregateFailure: Error, LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let message)=self {return message};return nil }
}

/// A single shard at a time. Never constructs a second complete index or gives non-papers scientific identity.
enum PublishedAggregateReader {
    struct Shard: Codable, Sendable {let url:String;let bytes:Int;let sha256:String;let recordCount:Int}
    struct Manifest: Codable {let contract:String;let recordCount:Int;let totalBytes:Int;let shards:[Shard]}
    struct DesktopSnapshot: Codable {let contract:String;let recordCount:Int;let paperCount:Int;let appearanceCount:Int;let catalogShards:[Shard]}
    static let site=URL(string:"https://nanless.github.io/audio-research-portal/")!
    static let canonicalDesktopPagesShardURL = "desktop-canonical-pages"
    private struct CanonicalPortalPage {
        let slug: String
        let title: String
        let summary: String
    }
    private static let canonicalDesktopPages: [CanonicalPortalPage] = [
        .init(slug: "about/", title: "关于与使用方法", summary: "找到值得读的论文，核对原文与证据，使用专题导航、快捷键与引用工具高效精读。"),
        .init(slug: "conferences/", title: "会议论文集", summary: "先按会议档次浏览，再按年份与举办月日查找语音、音乐、音频和相关领域研究。"),
        .init(slug: "links/", title: "研究资源指南", summary: "按发现论文、核对来源、整理阅读和研究写作的顺序，选择真正能进入日常工作的工具。")
    ]
    static func isOfficialPortalSite(_ siteBase: URL) -> Bool {
        guard siteBase.scheme?.lowercased() == "https",
              siteBase.host?.lowercased() == "nanless.github.io",
              siteBase.port == nil || siteBase.port == 443,
              let basePath = URLComponents(url: siteBase, resolvingAgainstBaseURL: false)?.percentEncodedPath else { return false }
        let prefix = basePath.hasSuffix("/") ? basePath : basePath + "/"
        return prefix == "/audio-research-portal/" || prefix == "/audio-paper-digest-blog/"
    }
    static func canonicalDesktopPageRow(at index: Int, siteBase: URL = site) throws -> [String: Any] {
        guard isOfficialPortalSite(siteBase), canonicalDesktopPages.indices.contains(index) else {
            throw AggregateFailure.invalid("桌面规范站点页面索引无效")
        }
        let item = canonicalDesktopPages[index]
        let basePath = URLComponents(url: siteBase, resolvingAgainstBaseURL: false)!.percentEncodedPath
        let prefix = basePath.hasSuffix("/") ? basePath : basePath + "/"
        let permalink = prefix + item.slug
        _ = try pageURL(permalink, siteBase: siteBase)
        return [
            "pageType": "page",
            "permalink": permalink,
            "title": item.title,
            "titleZh": item.title,
            "summary": item.summary,
            "date": "",
            "categories": [] as [String],
            "tags": [] as [String],
            "canonicalPortalPage": true
        ]
    }
    static func supplementCanonicalDesktopPages(_ catalog: PublishedAggregateCatalog, manifestRaw: Data, siteBase: URL = site) throws -> PublishedAggregateCatalog {
        guard isDesktopSnapshotManifest(manifestRaw), isOfficialPortalSite(siteBase) else { return catalog }
        let rowEncoding = ClientProtocols.contract("foundation-sorted-keys-json")
        let basePath = URLComponents(url: siteBase, resolvingAgainstBaseURL: false)!.percentEncodedPath
        let prefix = basePath.hasSuffix("/") ? basePath : basePath + "/"
        var existingURLs = Set(catalog.records.map(\.sourceURL))
        var merged = catalog.records
        for (index, item) in canonicalDesktopPages.enumerated() {
            let url = try pageURL(prefix + item.slug, siteBase: siteBase)
            guard existingURLs.insert(url.absoluteString).inserted else { continue }
            let row = try canonicalDesktopPageRow(at: index, siteBase: siteBase)
            let source = PublishedAggregate.Source(
                manifestSHA256: catalog.snapshotSHA256,
                shardSHA256: catalog.snapshotSHA256,
                shardBytes: 0,
                shardURL: canonicalDesktopPagesShardURL,
                rowIndex: index,
                normalizedRowSHA256: sha(try normalizedRow(row)),
                normalizedRowAlgorithm: rowEncoding
            )
            merged.append(PublishedAggregate(
                id: "page:" + URLComponents(url: url, resolvingAgainstBaseURL: false)!.percentEncodedPath,
                kind: .page,
                conferenceScope: nil,
                title: item.title,
                titleZh: item.title,
                summary: item.summary,
                rawDate: "",
                displayDate: nil,
                categories: [],
                tags: [],
                sourceURL: url.absoluteString,
                source: source
            ))
        }
        guard merged.count != catalog.records.count else { return catalog }
        return PublishedAggregateCatalog(
            snapshotSHA256: catalog.snapshotSHA256,
            sourceRecordCount: catalog.sourceRecordCount,
            aggregateCount: merged.count,
            records: merged.sorted { $0.id < $1.id }
        )
    }
    static func sha(_ bytes:Data)->String {SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined()}
    static func require(_ condition:Bool,_ reason:String)throws {if !condition{throw AggregateFailure.invalid(reason)}}
    static func validSHA(_ value:String)->Bool {value.range(of:#"\A[a-f0-9]{64}\z"#,options:.regularExpression) != nil}
    static func isDesktopSnapshotShard(_ url:String, sha256:String)->Bool {
        validSHA(sha256) && url == "client/details/catalog/\(sha256).json"
    }
    static func isDesktopSnapshotManifest(_ raw:Data)->Bool {
        guard raw.count>0, raw.count<=1024*1024, String(data:raw,encoding:.utf8) != nil,
              let obj=(try? JSONSerialization.jsonObject(with:raw)) as? [String:Any] else { return false }
        return obj["contract"] as? String == ClientProtocols.contract("paper-desktop-snapshot")
            && ClientProtocols.hasValidHeader(obj, "paper-desktop-snapshot")
    }
    static func desktopSnapshot(_ raw:Data)throws->DesktopSnapshot {
        try require(raw.count>0 && raw.count<=1024*1024, "汇总桌面快照大小无效")
        guard let text=String(data:raw,encoding:.utf8) else { throw AggregateFailure.invalid("汇总桌面快照编码无效") }
        let selfSHA=sha(raw)
        try require(!text.localizedCaseInsensitiveContains(selfSHA), "汇总桌面快照不能包含自身SHA")
        guard let obj=try JSONSerialization.jsonObject(with:raw) as? [String:Any],
              obj["contract"] as? String == ClientProtocols.contract("paper-desktop-snapshot"),
              ClientProtocols.hasValidHeader(obj, "paper-desktop-snapshot") else {
            throw AggregateFailure.invalid("汇总桌面快照合同无效")
        }
        let value=try JSONDecoder().decode(DesktopSnapshot.self, from:raw)
        try require((1...128).contains(value.catalogShards.count) && value.recordCount>0 && value.appearanceCount==value.recordCount && value.paperCount>0 && value.paperCount<=value.recordCount, "汇总桌面快照计数无效")
        var urls=Set<String>(), totalBytes=0, totalRows=0
        for shard in value.catalogShards {
            try require(isDesktopSnapshotShard(shard.url, sha256:shard.sha256) && (1...1024*1024).contains(shard.bytes) && shard.recordCount>0 && urls.insert(shard.url).inserted, "汇总桌面分片描述无效")
            totalBytes += shard.bytes; totalRows += shard.recordCount
        }
        try require(totalBytes>0 && totalBytes<=64*1024*1024 && totalRows==value.recordCount, "汇总桌面快照总字节或条数不一致")
        return value
    }
    static func readDesktopSnapshot(raw:Data, siteBase:URL=site, shardBytes:(Shard)throws->Data)throws->PublishedAggregateCatalog {
        let s=try desktopSnapshot(raw), snapshot=sha(raw)
        let rowEncoding=ClientProtocols.contract("foundation-sorted-keys-json")
        let basePath=URLComponents(url:siteBase,resolvingAgainstBaseURL:false)!.percentEncodedPath
        let prefix=basePath.hasSuffix("/") ? basePath : basePath+"/"
        var result:[PublishedAggregate]=[], pages=Set<String>(), rowsSeen=0
        for shard in s.catalogShards {
            try Task.checkCancellation()
            let bytes=try shardBytes(shard)
            try require(bytes.count==shard.bytes && sha(bytes)==shard.sha256 && String(data:bytes,encoding:.utf8) != nil, "汇总桌面分片原件与快照不一致")
            guard let rows=try JSONSerialization.jsonObject(with:bytes) as? [[String:Any]], rows.count==shard.recordCount else {
                throw AggregateFailure.invalid("汇总桌面分片记录数量无效")
            }
            result.append(contentsOf: try parseDesktopAggregateRows(rows, shard:shard, snapshot:snapshot, prefix:prefix, siteBase:siteBase, rowEncoding:rowEncoding, pages:&pages, rowsSeen:&rowsSeen))
        }
        try require(rowsSeen==s.recordCount, "汇总桌面目录集合不完整")
        return PublishedAggregateCatalog(snapshotSHA256:snapshot, sourceRecordCount:rowsSeen, aggregateCount:result.count, records:result.sorted{$0.id<$1.id})
    }
    static func parseDesktopAggregateRows(_ rows:[[String:Any]], shard:Shard, snapshot:String, prefix:String, siteBase:URL, rowEncoding:String, pages:inout Set<String>, rowsSeen:inout Int)throws->[PublishedAggregate] {
        var chunk:[PublishedAggregate]=[]
        for (position,row) in rows.enumerated() {
            try Task.checkCancellation(); rowsSeen += 1
            guard let pageType=row["pageType"] as? String,
                  let appearanceId=row["appearanceId"] as? String,
                  let pageUrl=row["pageUrl"] as? String,
                  appearanceId == pageUrl,
                  appearanceId.range(of:#"\Aposts/[a-z0-9][a-z0-9._-]*/\z"#, options:.regularExpression) != nil else {
                throw AggregateFailure.invalid("桌面目录缺少有效页面类型或appearanceId")
            }
            let url=try pageURL(prefix+pageUrl, siteBase:siteBase)
            try require(pages.insert(url.absoluteString).inserted, "桌面目录页面地址重复")
            if pageType=="paper" { continue }
            try require(row["identityStatus"] as? String == "aggregate-page" && (row["paperId"] == nil || row["paperId"] is NSNull), "桌面汇总记录不能携带单篇论文身份")
            guard let kind=PublishedAggregate.Kind(rawValue:pageType), kind == .daily || kind == .conference else {
                throw AggregateFailure.invalid("桌面目录出现不支持的非论文类型")
            }
            guard let title=row["title"] as? String, !title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else {
                throw AggregateFailure.invalid("桌面汇总缺少标题")
            }
            let rawDate=row["blogPublishedAt"] as? String ?? ""
            let displayDate=rawDate.isEmpty || rawDate.hasPrefix("0001-01-01") ? nil : rawDate
            let explicitScope=row["conferenceScope"] as? String
            try require(explicitScope==nil || (kind == .conference && ["overview","task"].contains(explicitScope!)), "会议范围字段无效")
            let tags: [String] = {
                if let conceptIds = row["tagConceptIds"] as? [String], !conceptIds.isEmpty { return conceptIds }
                if let flat = row["flatTags"] as? [String], !flat.isEmpty { return flat }
                return row["tags"] as? [String] ?? []
            }()
            let source=PublishedAggregate.Source(manifestSHA256:snapshot, shardSHA256:shard.sha256, shardBytes:shard.bytes, shardURL:shard.url, rowIndex:position, normalizedRowSHA256:sha(try normalizedRow(row)), normalizedRowAlgorithm:rowEncoding)
            chunk.append(PublishedAggregate(id:"page:"+URLComponents(url:url,resolvingAgainstBaseURL:false)!.percentEncodedPath, kind:kind, conferenceScope:explicitScope, title:title, titleZh:row["titleZh"] as? String ?? title, summary:row["summary"] as? String ?? "", rawDate:rawDate, displayDate:displayDate, categories:row["categories"] as? [String] ?? [], tags:tags, sourceURL:url.absoluteString, source:source))
        }
        return chunk
    }
    static func pageURL(_ value:String,siteBase:URL=site)throws->URL {
        guard let components=URLComponents(string:value),components.user==nil,components.password==nil,components.query==nil,components.fragment==nil else{throw AggregateFailure.invalid("汇总页面地址无效")}
        let path=components.percentEncodedPath
        try require(!path.contains("%") && !path.contains("\\") && !path.contains("//") && !path.split(separator:"/",omittingEmptySubsequences:false).contains(where:{$0=="." || $0==".."}),"汇总页面路径不规范")
        let basePath=URLComponents(url:siteBase,resolvingAgainstBaseURL:false)!.percentEncodedPath
        let prefix=basePath.hasSuffix("/") ? basePath:basePath+"/"
        let legacyPrefix=(siteBase.host?.lowercased()=="nanless.github.io" && prefix=="/audio-research-portal/") ? "/audio-paper-digest-blog/" : nil
        let matchedPrefix = path.hasPrefix(prefix) ? prefix : (legacyPrefix != nil && path.hasPrefix(legacyPrefix!) ? legacyPrefix! : nil)
        try require(matchedPrefix != nil && path.count>matchedPrefix!.count && path.hasSuffix("/"),"汇总页面超出资料站点")
        guard let url=URL(string:value,relativeTo:siteBase)?.absoluteURL else{throw AggregateFailure.invalid("汇总页面地址无法解析")}
        try require(url.scheme=="https" && url.host?.lowercased()==siteBase.host?.lowercased() && url.port==siteBase.port,"汇总页面不属于当前资料站点")
        return url
    }
    static func normalizedRow(_ row:[String:Any])throws->Data {try JSONSerialization.data(withJSONObject:row,options:[.sortedKeys])}
    static func manifest(_ raw:Data)throws->Manifest {
        try require(raw.count>0 && raw.count<=2*1024*1024 && String(data:raw,encoding:.utf8) != nil,"汇总清单编码或大小无效")
        let value=try JSONDecoder().decode(Manifest.self,from:raw)
        try require((try JSONSerialization.jsonObject(with:raw) as? [String:Any]).map{ClientProtocols.hasValidHeader($0,"paper-search-index-manifest")} == true && (1...128).contains(value.shards.count) && value.recordCount>0 && value.totalBytes>0 && value.totalBytes<=64*1024*1024,"汇总清单合同无效")
        var urls=Set<String>(),totalBytes=0,totalRows=0
        for shard in value.shards {
            try require(shard.url.range(of:#"\Asearch-index/part-[0-9]{4,}-[a-f0-9]{12}\.json\z"#,options:.regularExpression) != nil && validSHA(shard.sha256) && shard.url.hasSuffix("-"+shard.sha256.prefix(12)+".json") && (1...1024*1024).contains(shard.bytes) && shard.recordCount>0 && urls.insert(shard.url).inserted,"汇总分片描述无效")
            totalBytes+=shard.bytes;totalRows+=shard.recordCount
        }
        try require(totalBytes==value.totalBytes && totalRows==value.recordCount,"汇总清单总数不一致")
        return value
    }
    static func read(manifest raw:Data,siteBase:URL=site,shardBytes:(Shard)throws->Data)throws->PublishedAggregateCatalog {
        if isDesktopSnapshotManifest(raw) {
            return try readDesktopSnapshot(raw:raw, siteBase:siteBase, shardBytes:shardBytes)
        }
        let m=try manifest(raw),snapshot=sha(raw)
        let rowEncodingFamily="foundation-sorted-keys-json"
        let rowEncoding=m.contract=="paper-search-index-manifest" ? ClientProtocols.contract(rowEncodingFamily)
            : try ClientProtocols.historicalContract(rowEncodingFamily,variant:"original-row-canonical-byte-encoding")
        var result:[PublishedAggregate]=[],pages=Set<String>(),rowsSeen=0
        for shard in m.shards {
            try Task.checkCancellation()
            let bytes=try shardBytes(shard)
            try require(bytes.count==shard.bytes && sha(bytes)==shard.sha256 && String(data:bytes,encoding:.utf8) != nil,"汇总分片原件与清单不一致")
            guard let rows=try JSONSerialization.jsonObject(with:bytes) as? [[String:Any]],rows.count==shard.recordCount else{throw AggregateFailure.invalid("汇总分片记录数量无效")}
            for (position,row) in rows.enumerated() {
                try Task.checkCancellation();rowsSeen+=1
                guard let pageType=row["pageType"] as? String,let permalink=row["permalink"] as? String else{throw AggregateFailure.invalid("原目录缺少页面类型或地址")}
                let url=try pageURL(permalink,siteBase:siteBase)
                try require(pages.insert(url.absoluteString).inserted,"原目录页面地址重复")
                if pageType=="paper"{continue}
                // The old search input daily-summary is an explicit display-only alias; raw row stays untouched.
                guard let kind=PublishedAggregate.Kind(rawValue:pageType=="daily-summary" ? "daily":pageType) else{throw AggregateFailure.invalid("目录出现尚未支持的非论文类型")}
                guard let title=row["title"] as? String,!title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{throw AggregateFailure.invalid("汇总缺少标题")}
                let rawDate=row["date"] as? String ?? ""
                let displayDate=rawDate.isEmpty || rawDate.hasPrefix("0001-01-01") ? nil:rawDate
                let explicitScope=row["conferenceScope"] as? String
                try require(explicitScope==nil || kind == .conference && ["overview","task"].contains(explicitScope!),"会议范围字段无效")
                let citation=row["citation"] as? [String:Any]
                if let declared=citation?["pageUrl"] as? String,!declared.isEmpty {try require(try pageURL(declared,siteBase:siteBase)==url,"汇总声明地址与原页面不一致")}
                let source=PublishedAggregate.Source(manifestSHA256:snapshot,shardSHA256:shard.sha256,shardBytes:shard.bytes,shardURL:shard.url,rowIndex:position,normalizedRowSHA256:sha(try normalizedRow(row)),normalizedRowAlgorithm:rowEncoding)
                result.append(PublishedAggregate(id:"page:"+URLComponents(url:url,resolvingAgainstBaseURL:false)!.percentEncodedPath,kind:kind,conferenceScope:explicitScope,title:title,titleZh:row["titleZh"] as? String ?? title,summary:row["summary"] as? String ?? "",rawDate:rawDate,displayDate:displayDate,categories:row["categories"] as? [String] ?? [],tags:row["tags"] as? [String] ?? [],sourceURL:url.absoluteString,source:source))
            }
        }
        try require(rowsSeen==m.recordCount,"汇总原目录集合不完整")
        return PublishedAggregateCatalog(snapshotSHA256:snapshot,sourceRecordCount:rowsSeen,aggregateCount:result.count,records:result.sorted{$0.id<$1.id})
    }
}
