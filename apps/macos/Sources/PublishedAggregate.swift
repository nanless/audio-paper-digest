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
    let contract: String
    let snapshotSHA256: String
    let sourceRecordCount: Int
    let aggregateCount: Int
    let records: [PublishedAggregate]
}

struct AggregateDocument: Codable, Sendable, Equatable {
    struct Resource: Codable, Sendable, Equatable {
        let sourceURL: String
        let kind: String
        let missingReason: String
    }
    let contract: String
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
    static let site=URL(string:"https://nanless.github.io/audio-paper-digest-blog/")!
    static func sha(_ bytes:Data)->String {SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined()}
    static func require(_ condition:Bool,_ reason:String)throws {if !condition{throw AggregateFailure.invalid(reason)}}
    static func validSHA(_ value:String)->Bool {value.range(of:#"\A[a-f0-9]{64}\z"#,options:.regularExpression) != nil}
    static func pageURL(_ value:String,siteBase:URL=site)throws->URL {
        guard let components=URLComponents(string:value),components.user==nil,components.password==nil,components.query==nil,components.fragment==nil else{throw AggregateFailure.invalid("汇总页面地址无效")}
        let path=components.percentEncodedPath
        try require(!path.contains("%") && !path.contains("\\") && !path.contains("//") && !path.split(separator:"/",omittingEmptySubsequences:false).contains(where:{$0=="." || $0==".."}),"汇总页面路径不规范")
        let basePath=URLComponents(url:siteBase,resolvingAgainstBaseURL:false)!.percentEncodedPath
        let prefix=basePath.hasSuffix("/") ? basePath:basePath+"/"
        try require(path.hasPrefix(prefix) && path.count>prefix.count && path.hasSuffix("/"),"汇总页面超出资料站点")
        guard let url=URL(string:value,relativeTo:siteBase)?.absoluteURL else{throw AggregateFailure.invalid("汇总页面地址无法解析")}
        try require(url.scheme=="https" && url.host?.lowercased()==siteBase.host?.lowercased() && url.port==siteBase.port,"汇总页面不属于当前资料站点")
        return url
    }
    static func normalizedRow(_ row:[String:Any])throws->Data {try JSONSerialization.data(withJSONObject:row,options:[.sortedKeys])}
    static func manifest(_ raw:Data)throws->Manifest {
        try require(raw.count>0 && raw.count<=2*1024*1024 && String(data:raw,encoding:.utf8) != nil,"汇总清单编码或大小无效")
        let value=try JSONDecoder().decode(Manifest.self,from:raw)
        try require(value.contract=="paper-search-index-manifest-v1" && (1...128).contains(value.shards.count) && value.recordCount>0 && value.totalBytes>0 && value.totalBytes<=64*1024*1024,"汇总清单合同无效")
        var urls=Set<String>(),totalBytes=0,totalRows=0
        for shard in value.shards {
            try require(shard.url.range(of:#"\Asearch-index/part-[0-9]{4,}-[a-f0-9]{12}\.json\z"#,options:.regularExpression) != nil && validSHA(shard.sha256) && shard.url.hasSuffix("-"+shard.sha256.prefix(12)+".json") && (1...1024*1024).contains(shard.bytes) && shard.recordCount>0 && urls.insert(shard.url).inserted,"汇总分片描述无效")
            totalBytes+=shard.bytes;totalRows+=shard.recordCount
        }
        try require(totalBytes==value.totalBytes && totalRows==value.recordCount,"汇总清单总数不一致")
        return value
    }
    static func read(manifest raw:Data,siteBase:URL=site,shardBytes:(Shard)throws->Data)throws->PublishedAggregateCatalog {
        let m=try manifest(raw),snapshot=sha(raw)
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
                let source=PublishedAggregate.Source(manifestSHA256:snapshot,shardSHA256:shard.sha256,shardBytes:shard.bytes,shardURL:shard.url,rowIndex:position,normalizedRowSHA256:sha(try normalizedRow(row)),normalizedRowAlgorithm:"foundation-sorted-keys-json-v1")
                result.append(PublishedAggregate(id:"page:"+URLComponents(url:url,resolvingAgainstBaseURL:false)!.percentEncodedPath,kind:kind,conferenceScope:explicitScope,title:title,titleZh:row["titleZh"] as? String ?? title,summary:row["summary"] as? String ?? "",rawDate:rawDate,displayDate:displayDate,categories:row["categories"] as? [String] ?? [],tags:row["tags"] as? [String] ?? [],sourceURL:url.absoluteString,source:source))
            }
        }
        try require(rowsSeen==m.recordCount,"汇总原目录集合不完整")
        return PublishedAggregateCatalog(contract:"published-aggregate-index-v1",snapshotSHA256:snapshot,sourceRecordCount:rowsSeen,aggregateCount:result.count,records:result.sorted{$0.id<$1.id})
    }
}
