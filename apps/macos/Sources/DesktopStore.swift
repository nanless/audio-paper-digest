import Foundation
import Security
import CryptoKit

enum DesktopError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let text): return text } }
}

enum DesktopKeychain {
    static let service = "com.nanless.PaperDigest.models"
    static func load(_ account: String) throws -> String? {
        let query: [String:Any] = [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:account,kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]
        var value: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary,&value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else { throw DesktopError.message("无法读取钥匙串（\(status)）") }
        return String(data:data,encoding:.utf8)
    }
    static func save(_ text:String, account:String) throws {
        let query:[String:Any] = [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:account]
        let attributes:[String:Any] = [kSecValueData as String:Data(text.utf8),kSecAttrAccessible as String:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary,attributes as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(attributes){_,b in b} as CFDictionary,nil) }
        guard status == errSecSuccess else { throw DesktopError.message("无法保存钥匙串（\(status)）") }
    }
    static func remove(_ account:String) throws {
        let status = SecItemDelete([kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:account] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DesktopError.message("无法删除钥匙串（\(status)）") }
    }
}

@MainActor final class DesktopStore {
    let directory:URL
    private(set) var value:[String:Any]
    private let file:URL
    init(directory:URL) throws {
        self.directory=directory; file=directory.appendingPathComponent("personal.json")
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        if FileManager.default.fileExists(atPath:file.path) {
            let data=try Data(contentsOf:file)
            guard let object=try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw DesktopError.message("个人资料格式损坏，原文件已保留") }
            try Self.validate(object);value=object
        } else { value=["schema":1,"notes":[:],"favorites":[],"reading":[],"readingState":[:],"annotations":[:],"sessions":[],"jobs":[],"settings":["appearance":"system","font":18,"syncHours":12]] }
        var jobs=value["jobs"] as? [[String:Any]] ?? []
        for index in jobs.indices where ["running","queued"].contains(jobs[index]["status"] as? String ?? "") {
            jobs[index]["status"]="interrupted"; jobs[index]["message"]="上次运行中断；先核对已保存结果，付费请求不自动重发"
        }
        value["jobs"]=jobs
        try save()
    }
    static func validate(_ object:[String:Any]) throws {
        guard object["schema"] as? Int==1,object["notes"] is [String:[String:Any]],object["settings"] is [String:Any],object["favorites"] is [String],object["reading"] is [String],object["readingState"] is [String:[String:Any]],object["annotations"] is [String:[[String:Any]]],object["sessions"] is [[String:Any]],object["jobs"] is [[String:Any]] else{throw DesktopError.message("个人资料版本或结构不符，原文件已保留")}
        for note in (object["notes"] as? [String:[String:Any]] ?? [:]).values {guard note["text"] is String,let revision=note["revision"] as? Int,revision>=0 else{throw DesktopError.message("笔记结构损坏，原文件已保留")}}
        if let raw=object["personalPapers"] {
            guard let papers=raw as? [String:[String:Any]],papers.count<=100000 else{throw DesktopError.message("个人文献索引损坏，原资料已保留")}
            for(id,paper) in papers{try validatePaper(paper,id:id)}
        }
    }
    static func validatePaper(_ paper:[String:Any],id:String) throws {
        guard !id.isEmpty,id.count<=256,paper["id"] as? String==id,let title=paper["title"] as? String,!title.isEmpty,
              let kind=paper["sourceKind"] as? String,!kind.isEmpty,kind.count<=64 else{throw DesktopError.message("个人文献身份、标题或来源类型损坏")}
        for key in ["titleZh","sourceURL","blogURL","pdfURL","sourceVersion","offlinePackageID"]{if let value=paper[key],!(value is NSNull),!(value is String){throw DesktopError.message("个人文献字段类型损坏："+key)}}
        for key in ["authors","tags"]{if let value=paper[key],!(value is [String]){throw DesktopError.message("个人文献列表字段损坏："+key)}}
        if kind=="local"{guard id.hasPrefix("local:"),let path=paper["localPDFPath"] as? String,path.hasPrefix("/"),let hash=paper["pdfSHA"] as? String,hash.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil,id=="local:"+hash else{throw DesktopError.message("个人 PDF 路径或内容身份损坏")}}
    }
    func save() throws {
        let data=try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])
        try data.write(to:file,options:[.atomic]); try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
    }
    func snapshot()->[String:Any] { value }
    func setting(_ key:String)->Any? { (value["settings"] as? [String:Any])?[key] }
    func updateSettings(_ changes:[String:Any]) throws {
        let allowed:Set<String>=["appearance","font","reduceMotion","syncHours","httpProxy","endpoint","model","protocol","maxTokens","timeoutMs","dailyRequests","lastSettingPane"]
        var settings=value["settings"] as? [String:Any] ?? [:]
        for (key,item) in changes where allowed.contains(key) { settings[key]=item }
        let old=value; value["settings"]=settings
        do { try save() } catch { value=old; throw error }
    }
    func setList(_ key:String, ids:[String]) throws {
        guard ["favorites","reading"].contains(key),ids.count<=100000 else { throw DesktopError.message("资料清单无效") }
        let old=value; value[key]=Array(Set(ids)).sorted()
        do { try save() } catch { value=old; throw error }
    }
    func saveNote(id:String,text:String,baseRevision:Int) throws -> [String:Any] {
        guard !id.isEmpty,text.utf8.count<=2*1024*1024 else { throw DesktopError.message("笔记过长或文献身份缺失") }
        var notes=value["notes"] as? [String:[String:Any]] ?? [:]
        let previous=notes[id] ?? [:], revision=previous["revision"] as? Int ?? 0
        guard revision==baseRevision else { throw DesktopError.message("笔记已在其他视图更新，当前编辑仍保留；请先载入新版本或导出你的草稿") }
        let note:[String:Any]=["text":text,"revision":revision+1,"updatedAt":ISO8601DateFormatter().string(from:Date())]
        notes[id]=note; let old=value; value["notes"]=notes
        do { try save(); return note } catch { value=old; throw error }
    }
    func saveReading(id:String,state:[String:Any]) throws {
        var reading=value["readingState"] as? [String:[String:Any]] ?? [:]
        let old=value; var saved=state;saved["updatedAt"]=ISO8601DateFormatter().string(from:Date());reading[id]=saved; value["readingState"]=reading; do{try save()}catch{value=old;throw error}
    }
    func annotations(id:String)->[[String:Any]] { (value["annotations"] as? [String:[[String:Any]]])?[id] ?? [] }
    func saveAnnotation(id:String,annotation:[String:Any],remove:Bool=false) throws -> [[String:Any]] {
        var all=value["annotations"] as? [String:[[String:Any]]] ?? [:], entries=all[id] ?? []
        let key=annotation["id"] as? String ?? UUID().uuidString
        entries.removeAll{ $0["id"] as? String==key }
        if !remove { var entry=annotation; entry["id"]=key; if entry["createdAt"]==nil{entry["createdAt"]=ISO8601DateFormatter().string(from:Date())}; entries.append(entry) }
        all[id]=entries; let old=value; value["annotations"]=all
        do { try save(); return entries } catch { value=old; throw error }
    }
    func replaceAnnotations(id:String,entries:[[String:Any]]) throws {
        guard !id.isEmpty,entries.count<=100000 else{throw DesktopError.message("标注集合无效")}
        let old=value;var all=value["annotations"] as? [String:[[String:Any]]] ?? [:];all[id]=entries;value["annotations"]=all
        do{try save()}catch{value=old;throw error}
    }
    func rememberPaper(_ paper:[String:Any]) throws {
        guard let id=paper["id"] as? String else{throw DesktopError.message("文献身份缺失")}
        try Self.validatePaper(paper,id:id)
        let old=value;var papers:[String:[String:Any]]=[:]
        if let raw=value["personalPapers"]{guard let existing=raw as? [String:[String:Any]] else{throw DesktopError.message("个人文献索引损坏，未覆盖")};papers=existing}
        papers[id]=paper;value["personalPapers"]=papers
        do{try save()}catch{value=old;throw error}
    }
    func upsertJob(_ job:[String:Any]) throws {
        var jobs=value["jobs"] as? [[String:Any]] ?? []
        if let index=jobs.firstIndex(where:{$0["id"] as? String==job["id"] as? String}) { jobs[index]=job } else { jobs.insert(job,at:0) }
        let old=value;value["jobs"]=Array(jobs.prefix(1000)); do{try save()}catch{value=old;throw error}
    }
    func appendSession(_ session:[String:Any]) throws {
        var sessions=value["sessions"] as? [[String:Any]] ?? []
        if let index=sessions.firstIndex(where:{$0["id"] as? String==session["id"] as? String}) { sessions[index]=session } else { sessions.append(session) }
        let old=value;value["sessions"]=sessions; do{try save()}catch{value=old;throw error}
    }
    func session(_ id:String)->[String:Any]? { (value["sessions"] as? [[String:Any]])?.last{$0["id"] as? String==id} }
    func restorePersonal(_ object:[String:Any]) throws {
        guard object["schema"] as? Int==1,object["notes"] is [String:Any],object["settings"] is [String:Any] else { throw DesktopError.message("备份个人资料合同不符") }
        try Self.validate(object);let old=value; value=object; do { try save() } catch { value=old; throw error }
    }
}

func sha256(_ data:Data)->String { SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined() }
func htmlEscape(_ value:String)->String { value.replacingOccurrences(of:"&",with:"&amp;").replacingOccurrences(of:"<",with:"&lt;").replacingOccurrences(of:">",with:"&gt;").replacingOccurrences(of:"\"",with:"&quot;") }
