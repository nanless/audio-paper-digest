import Foundation
import CryptoKit
import Darwin

/// Storage metadata supplies path relocation only. It never grants source eligibility,
/// authorization, successful task status, or permission to skip a caller's checks.
public enum PrivateStoragePaths {
    public static let aliasesFilename = "RestoredPathRoots.json"
    public struct RootMap: Codable, Sendable {
        public let contract: String
        public let roots: [String]
        public init(roots: [String]) { self.contract="paperdigest-storage-aliases-v1"; self.roots=roots }
    }
    public enum StorageError: Error, LocalizedError {
        case invalid(String)
        public var errorDescription: String? { switch self { case .invalid(let text): return text } }
    }
    /// A file inside the current directory retains the caller's existing verification
    /// policy. A path relocated from an old root MUST be bound to the expected bytes.
    public static func resolve(_ raw: String, directory: URL, expectedSHA256: String? = nil) throws -> URL {
        try absolute(raw)
        let root = try checkedDirectory(directory)
        let current = root.standardizedFileURL.path
        let canonical = root.resolvingSymlinksInPath().path
        var prefixes=[directory.path,current,canonical]
        if let resolved=realpath(directory.path,nil){prefixes.append(String(cString:resolved));free(resolved)}
        let directRoots = Array(Set(prefixes)).sorted { $0.count > $1.count }
        var relative: String?, relocated = false
        for prefix in directRoots where raw.hasPrefix(prefix+"/") { relative=String(raw.dropFirst(prefix.count+1)); break }
        if relative == nil {
            let roots = try loadRoots(directory:root)
            for prefix in roots where raw.hasPrefix(prefix+"/") { relative=String(raw.dropFirst(prefix.count+1)); relocated=true; break }
        }
        guard let relative else { throw StorageError.invalid("文件不在当前私有资料目录或受控旧目录内") }
        try path(relative)
        if relocated && expectedSHA256 == nil { throw StorageError.invalid("旧目录重定位必须绑定原文件 SHA256") }
        let file = try checkedFile(relative:relative, directory:root)
        if let expectedSHA256 {
            guard validSHA(expectedSHA256), try sha256File(file) == expectedSHA256 else { throw StorageError.invalid("资料文件内容与原 SHA256 不符") }
        }
        return file
    }
    public static func loadRoots(directory: URL) throws -> [String] {
        let root = try checkedDirectory(directory)
        let path = root.appendingPathComponent(aliasesFilename)
        guard FileManager.default.fileExists(atPath:path.path) else {
            // A dangling symlink also fails; fileExists alone would hide it.
            if (try? path.resourceValues(forKeys:[.isSymbolicLinkKey]).isSymbolicLink) == true { throw StorageError.invalid("路径映射不能是符号链接") }
            return []
        }
        let file=try checkedFile(relative:aliasesFilename,directory:root)
        let data=try boundedData(file,limit:BackupCodec.maxDecodedBytes)
        return try decodeRoots(data)
    }
    static func decodeRoots(_ data: Data) throws -> [String] {
        let object=try JSONSerialization.jsonObject(with:data)
        guard let dictionary=object as? [String:Any], Set(dictionary.keys)==["contract","roots"],
              dictionary["contract"] as? String == "paperdigest-storage-aliases-v1",
              let roots=dictionary["roots"] as? [String], roots.count <= BackupCodec.maxEntries else { throw StorageError.invalid("私有路径映射合同无效") }
        try validateRoots(roots)
        return roots
    }
    static func validateRoots(_ roots:[String]) throws {
        var seen=Set<String>()
        for root in roots {
            try absolute(root)
            let key=aliasKey(root)
            guard seen.insert(key).inserted else { throw StorageError.invalid("路径映射存在重复或别名冲突") }
        }
        for key in seen {
            var prefix=""
            for part in key.split(separator:"/").dropLast() {
                prefix += "/"+part
                guard !seen.contains(prefix) else{throw StorageError.invalid("旧目录相互包含，路径映射有歧义")}
            }
        }
    }
    static func path(_ raw:String) throws {
        guard !raw.isEmpty, !raw.hasPrefix("/"), !raw.hasSuffix("/"), !raw.contains("\\"),
              raw.utf8.count <= 4096, !raw.unicodeScalars.contains(where:{$0.value<32 || $0.value==127}) else { throw StorageError.invalid("私有资料相对路径无效") }
        let parts=raw.split(separator:"/",omittingEmptySubsequences:false)
        guard parts.allSatisfy({!$0.isEmpty && $0 != "." && $0 != ".."}) else { throw StorageError.invalid("私有资料路径含空片段或目录穿越") }
    }
    static func absolute(_ raw:String) throws {
        guard raw.hasPrefix("/"),raw != "/" else { throw StorageError.invalid("私有资料根目录须为绝对目录") }
        try path(String(raw.dropFirst()))
    }
    static func aliasKey(_ path:String)->String {
        path.precomposedStringWithCanonicalMapping.folding(options:[.caseInsensitive],locale:Locale(identifier:"en_US_POSIX"))
    }
    static func checkedDirectory(_ directory:URL) throws -> URL {
        guard directory.isFileURL else { throw StorageError.invalid("私有资料目录须为本机目录") }
        let root=directory.standardizedFileURL
        try absolute(root.path)
        let info=try root.resourceValues(forKeys:[.isDirectoryKey,.isSymbolicLinkKey])
        guard info.isDirectory==true,info.isSymbolicLink != true else { throw StorageError.invalid("私有资料根目录不能是符号链接或普通文件") }
        return root
    }
    static func checkedFile(relative:String,directory:URL) throws -> URL {
        try path(relative)
        let root=try checkedDirectory(directory)
        var target=root
        let parts=relative.split(separator:"/").map(String.init)
        for (index,part) in parts.enumerated() {
            target.appendPathComponent(part)
            let info=try target.resourceValues(forKeys:[.isDirectoryKey,.isRegularFileKey,.isSymbolicLinkKey])
            guard info.isSymbolicLink != true else { throw StorageError.invalid("私有资料路径不能经过符号链接") }
            if index == parts.count-1 { guard info.isRegularFile==true else { throw StorageError.invalid("私有资料必须为普通文件") } }
            else { guard info.isDirectory==true else { throw StorageError.invalid("私有资料父路径不是目录") } }
        }
        let canonical=target.resolvingSymlinksInPath(),canonicalRoot=root.resolvingSymlinksInPath()
        guard canonical.path.hasPrefix(canonicalRoot.path+"/") else { throw StorageError.invalid("私有资料路径逃逸") }
        return target
    }
    static func validSHA(_ value:String)->Bool { value.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil }
    static func sha256(_ bytes:Data)->String { SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined() }
    static func sha256File(_ file:URL) throws->String {
        let handle=try FileHandle(forReadingFrom:file);defer{try? handle.close()}
        var digest=SHA256(),count=0
        while let chunk=try handle.read(upToCount:1024*1024),!chunk.isEmpty { count+=chunk.count;guard count<=BackupCodec.maxDecodedBytes else{throw StorageError.invalid("资料文件超过大小限制")};digest.update(data:chunk) }
        return digest.finalize().map{String(format:"%02x",$0)}.joined()
    }
    static func boundedData(_ file:URL,limit:Int) throws -> Data {
        let size=try file.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? -1
        guard size>=0,size<=limit else{throw StorageError.invalid("资料文件超过大小限制")}
        let bytes=try Data(contentsOf:file)
        guard bytes.count<=limit else{throw StorageError.invalid("资料文件读取后超过大小限制")}
        return bytes
    }
}

public enum BackupCodec {
    public static let maxDecodedBytes=512*1024*1024
    public static let maxEncodedBytes=750*1024*1024
    public static let maxEntries=100_000
    public struct Entry: Codable, Sendable {
        public let path:String
        public let sha256:String
        public let data:Data
        public init(path:String,sha256:String,data:Data){self.path=path;self.sha256=sha256;self.data=data}
    }
    public struct Payload: Codable, Sendable {
        public let contract:String
        public let sourceDirectory:String
        public let files:[Entry]
        public init(sourceDirectory:String,files:[Entry]){self.contract="paperdigest-backup-v2";self.sourceDirectory=sourceDirectory;self.files=files}
    }
    public struct StagedRestore: Sendable {
        public let stageDirectory:URL
        public let personalStoreData:Data
        public let sourceDirectory:String
        public let historicalRoots:[String]
    }
    public static func collect(sourceDirectory:URL) throws -> Payload {
        let root=try PrivateStoragePaths.checkedDirectory(sourceDirectory)
        let fm=FileManager.default
        var enumerationError:Error?
        guard let enumerator=fm.enumerator(at:root,includingPropertiesForKeys:[.isSymbolicLinkKey,.isRegularFileKey,.isDirectoryKey],options:[],errorHandler:{_,error in enumerationError=error;return false}) else{throw PrivateStoragePaths.StorageError.invalid("无法读取私有资料目录")}
        var files:[Entry]=[],total=0
        for case let file as URL in enumerator {
            let info=try file.resourceValues(forKeys:[.isSymbolicLinkKey,.isRegularFileKey,.isDirectoryKey])
            guard info.isSymbolicLink != true else{throw PrivateStoragePaths.StorageError.invalid("备份不能包含符号链接")}
            if info.isDirectory==true{continue}
            guard info.isRegularFile==true else{throw PrivateStoragePaths.StorageError.invalid("备份不能包含非普通文件")}
            let prefix=root.resolvingSymlinksInPath().path+"/"
            let actual=file.resolvingSymlinksInPath().path
            guard actual.hasPrefix(prefix) else{throw PrivateStoragePaths.StorageError.invalid("备份枚举逃逸")}
            let relative=String(actual.dropFirst(prefix.count))
            _=try PrivateStoragePaths.checkedFile(relative:relative,directory:root)
            let bytes=try PrivateStoragePaths.boundedData(file,limit:maxDecodedBytes-total)
            total+=bytes.count
            files.append(Entry(path:relative,sha256:PrivateStoragePaths.sha256(bytes),data:bytes))
            guard files.count<=maxEntries else{throw PrivateStoragePaths.StorageError.invalid("备份条目超过100000项")}
        }
        if let enumerationError{throw enumerationError}
        let payload=Payload(sourceDirectory:sourceDirectory.path,files:files.sorted{$0.path<$1.path})
        try validate(payload)
        return payload
    }
    public static func encode(_ payload:Payload) throws -> Data {
        try validate(payload)
        let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys]
        let data=try encoder.encode(payload)
        guard data.count<=maxEncodedBytes else{throw PrivateStoragePaths.StorageError.invalid("备份编码超过750MiB")}
        return data
    }
    public static func parse(_ data:Data) throws -> Payload {
        guard data.count<=maxEncodedBytes else{throw PrivateStoragePaths.StorageError.invalid("备份输入超过750MiB")}
        let payload=try JSONDecoder().decode(Payload.self,from:data)
        try validate(payload)
        return payload
    }
    /// Every path, file hash, root map and aggregate bound is checked BEFORE a
    /// stage directory is created. Failure removes only our newly created stage.
    public static func stage(_ payload:Payload,parentDirectory:URL) throws -> StagedRestore {
        try validate(payload)
        let parent=try PrivateStoragePaths.checkedDirectory(parentDirectory)
        let inherited=try roots(in:payload)
        var combined=[payload.sourceDirectory]
        for root in inherited where root != payload.sourceDirectory{combined.append(root)}
        try PrivateStoragePaths.validateRoots(combined)
        let result=parent.appendingPathComponent(".paperdigest-restore-"+UUID().uuidString,isDirectory:true)
        let fm=FileManager.default
        try fm.createDirectory(at:result,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        do {
            for entry in payload.files {
                let file=result.appendingPathComponent(entry.path)
                try fm.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
                try entry.data.write(to:file,options:[.atomic])
                try fm.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
            }
            let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys]
            let map=try encoder.encode(PrivateStoragePaths.RootMap(roots:combined))
            let mapFile=result.appendingPathComponent(PrivateStoragePaths.aliasesFilename)
            try map.write(to:mapFile,options:[.atomic]);try fm.setAttributes([.posixPermissions:0o600],ofItemAtPath:mapFile.path)
            // Stage readback does not turn arbitrary JSON into source credentials.
            for entry in payload.files where entry.path != PrivateStoragePaths.aliasesFilename {
                let file=try PrivateStoragePaths.checkedFile(relative:entry.path,directory:result)
                guard try PrivateStoragePaths.sha256File(file)==entry.sha256 else{throw PrivateStoragePaths.StorageError.invalid("恢复暂存文件回读不符")}
            }
            let personal=payload.files.first{$0.path=="personal.json"}!.data
            return StagedRestore(stageDirectory:result,personalStoreData:personal,sourceDirectory:payload.sourceDirectory,historicalRoots:combined)
        } catch {try? fm.removeItem(at:result);throw error}
    }
    public static func stage(data:Data,parentDirectory:URL) throws -> StagedRestore {try stage(parse(data),parentDirectory:parentDirectory)}
    public static func validate(_ payload:Payload) throws {
        guard payload.contract=="paperdigest-backup-v2",payload.files.count<=maxEntries else{throw PrivateStoragePaths.StorageError.invalid("备份合同或条目数量无效")}
        try PrivateStoragePaths.absolute(payload.sourceDirectory)
        var paths=Set<String>(),total=0
        var componentAliases:[String:String]=[:]
        let reserved=PrivateStoragePaths.aliasKey(PrivateStoragePaths.aliasesFilename)
        for entry in payload.files {
            try PrivateStoragePaths.path(entry.path)
            let key=PrivateStoragePaths.aliasKey(entry.path)
            var literalPrefix=""
            for part in entry.path.split(separator:"/") {
                literalPrefix=literalPrefix.isEmpty ? String(part):literalPrefix+"/"+part
                let alias=PrivateStoragePaths.aliasKey(literalPrefix)
                if let previous=componentAliases[alias],previous != literalPrefix{throw PrivateStoragePaths.StorageError.invalid("备份目录片段存在名称别名冲突")}
                componentAliases[alias]=literalPrefix
            }
            guard paths.insert(key).inserted else{throw PrivateStoragePaths.StorageError.invalid("备份存在重复路径或文件名别名冲突")}
            guard key != reserved || entry.path == PrivateStoragePaths.aliasesFilename,
                  !key.hasPrefix(reserved+"/") else{throw PrivateStoragePaths.StorageError.invalid("路径映射文件名存在歧义")}
            guard entry.data.count<=maxDecodedBytes-total else{throw PrivateStoragePaths.StorageError.invalid("备份原文件总量超过512MiB")}
            total+=entry.data.count
            guard PrivateStoragePaths.validSHA(entry.sha256),PrivateStoragePaths.sha256(entry.data)==entry.sha256 else{throw PrivateStoragePaths.StorageError.invalid("备份文件SHA256损坏")}
        }
        for key in paths {
            var prefix=""
            for part in key.split(separator:"/").dropLast() {
                prefix=prefix.isEmpty ? String(part):prefix+"/"+part
                guard !paths.contains(prefix) else{throw PrivateStoragePaths.StorageError.invalid("备份文件与父目录冲突")}
            }
        }
        guard let personal=payload.files.first(where:{$0.path=="personal.json"}),
              (try JSONSerialization.jsonObject(with:personal.data)) is [String:Any] else{throw PrivateStoragePaths.StorageError.invalid("备份缺少原始个人资料对象")}
        let inherited=try roots(in:payload)
        var combined=[payload.sourceDirectory]
        for root in inherited where root != payload.sourceDirectory{combined.append(root)}
        try PrivateStoragePaths.validateRoots(combined)
    }
    private static func roots(in payload:Payload) throws -> [String] {
        guard let map=payload.files.first(where:{$0.path==PrivateStoragePaths.aliasesFilename}) else{return []}
        return try PrivateStoragePaths.decodeRoots(map.data)
    }
}
