import Foundation

enum ReaderSourceNoticeError:LocalizedError {
    case invalidRequest, unavailable, changed
    var errorDescription:String? {switch self {
    case .invalidRequest:return "来源说明请求缺少当前导读身份，请重新打开导读"
    case .unavailable:return "当前导读没有完整的来源说明，请重新读取后再试"
    case .changed:return "导读来源已经变化，请关闭后重新打开来源说明"
    }}
}

/// UI supplies identity only. Notice text, source URLs and paths never enter this request.
struct ReaderSourceNoticeRequest:Equatable {
    let paperID:String,revisionSHA256:String
    init(_ payload:[String:Any])throws {
        guard Set(payload.keys)==Set(["paperID","revisionSHA256"]),
              let paper=payload["paperID"] as? String,!paper.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
              let revision=payload["revisionSHA256"] as? String,
              revision.range(of:#"\A[0-9a-f]{64}\z"#,options:.regularExpression) != nil else{throw ReaderSourceNoticeError.invalidRequest}
        paperID=paper;revisionSHA256=revision
    }
}

/// A value snapshot of the Core's actual loaded Article, not current catalog or JS text.
struct ReaderSourceNoticeSnapshot:Equatable {
    let paperID:String,revisionSHA256:String,notices:[String]
    init(paperID:String,article:[String:Any])throws {
        guard !paperID.isEmpty,article["paperID"] as? String==paperID,
              let revision=article["revisionSHA256"] as? String,
              revision.range(of:#"\A[0-9a-f]{64}\z"#,options:.regularExpression) != nil,
              let original=article["notices"] as? [String] else{throw ReaderSourceNoticeError.unavailable}
        var seen=Set<String>(),ordered:[String]=[]
        for text in original where !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && seen.insert(text).inserted {ordered.append(text)}
        guard !ordered.isEmpty else{throw ReaderSourceNoticeError.unavailable}
        self.paperID=paperID;revisionSHA256=revision;notices=ordered
    }
    func requireRequest(_ request:ReaderSourceNoticeRequest)throws {
        guard request.paperID==paperID,request.revisionSHA256==revisionSHA256 else{throw ReaderSourceNoticeError.changed}
    }
    func requireCurrent(paperID:String,article:[String:Any])throws {
        guard (try? Self(paperID:paperID,article:article))==self else{throw ReaderSourceNoticeError.changed}
    }
    var json:[String:Any] {[
        "contract":"reader-source-notice-snapshot-v1","paperID":paperID,"revisionSHA256":revisionSHA256,"notices":notices
    ]}
}
