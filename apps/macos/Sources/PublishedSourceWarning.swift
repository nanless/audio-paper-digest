import Foundation
import CoreFoundation

/// Presentation from the actual Article's own citation, never a latest-catalog lookup or a new source capability.
enum PublishedSourceWarning {
    struct Material {
        let paperID: String, blogURL: String?, sourceURL: String, pdfURL: String?, sourceVersion: String?
    }
    private static func text(_ value: Any?) -> String? { value as? String }
    private static func nonempty(_ value: String?) -> String? { value.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 } }
    private static func address(_ value: String?) -> String? {
        guard let value=nonempty(value),let u=URL(string:value),u.scheme=="https",u.host != nil,u.user==nil,u.password==nil,u.port==nil || u.port==443 else{return nil};return value
    }
    static func warning(citation: [String: Any], material: Material) -> String? {
        guard citation["contract"] as? String=="paper-citation-source-v1",
              let verified=citation["verified"] as? NSNumber,CFGetTypeID(verified)==CFBooleanGetTypeID(),verified.boolValue,
              citation["identityStatus"] as? String=="verified",nonempty(material.paperID) != nil,
              citation["paperKey"] as? String==material.paperID,
              let warning=citation["sourceVersionWarning"] as? String,nonempty(warning) != nil,
              let blog=address(material.blogURL),citation["pageUrl"] as? String==blog,
              let source=address(material.sourceURL),citation["sourceUrl"] as? String==source else{return nil}
        for key in ["paperId","url"] where citation[key] != nil {
            guard let value=citation[key] as? String,value==(key=="paperId" ? material.paperID:source) else{return nil}
        }
        guard let declaredPDF=citation["pdfUrl"] as? String,nonempty(declaredPDF)==nonempty(material.pdfURL) else{return nil}
        if let pdf=nonempty(material.pdfURL),address(pdf)==nil{return nil}
        guard let kind=nonempty(citation["sourceKind"] as? String) else{return nil}
        if material.paperID.hasPrefix("arxiv:") {
            guard kind=="arxiv",let version=nonempty(material.sourceVersion),citation["arxivId"] as? String==version else{return nil}
            let base=version.replacingOccurrences(of:#"v[1-9][0-9]*$"#,with:"",options:.regularExpression)
            guard material.paperID=="arxiv:"+base else{return nil}
        } else {
            guard kind != "arxiv",nonempty(material.sourceVersion)==nil else{return nil}
            if let value=citation["arxivId"] { guard let value=value as? String,nonempty(value)==nil else{return nil} }
        }
        return warning // Preserve the complete original text, including whitespace and markup as text.
    }
    static func merge(_ notices: [String], citation: [String:Any], material: Material) -> [String] {
        var seen=Set<String>(),result:[String]=[]
        for text in notices + (warning(citation:citation,material:material).map{[$0]} ?? []) where seen.insert(text).inserted {result.append(text)}
        return result
    }
    /// `manifestBlogURL` is allowed only from the same already-verified offline package, not from current Paper/catalog.
    static func project(_ article:[String:Any], manifestBlogURL:String?=nil)->[String:Any] {
        guard let paperID=article["paperID"] as? String,let source=article["sourceURL"] as? String,let citation=article["citation"] as? [String:Any] else{return article}
        for key in ["blogURL","pdfURL","sourceVersion"] { if let value=article[key],!(value is NSNull),!(value is String){return article} }
        var result=article
        result["notices"]=merge(article["notices"] as? [String] ?? [],citation:citation,material:.init(paperID:paperID,blogURL:article["blogURL"] as? String ?? manifestBlogURL,sourceURL:source,pdfURL:article["pdfURL"] as? String,sourceVersion:article["sourceVersion"] as? String))
        return result
    }
}
