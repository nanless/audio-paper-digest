import Foundation
import Darwin

/// Sidecars activate only with the actual paper current.json snapshot; a legacy cache cannot grant a manifest.
struct PublishedAggregateStore {
    let directory: URL
    let siteBase: URL
    init(directory: URL, siteBase: URL = PublishedAggregateReader.site) { self.directory = directory; self.siteBase = siteBase }
    private let fm=FileManager.default
    /// Only macOS root-owned system aliases are translated; no cache subtree is resolved.
    private func trustedSystemPath(_ url: URL) throws -> URL {
        let path = url.path
        for (alias, physical) in [("/var", "/private/var"), ("/tmp", "/private/tmp")] where path == alias || path.hasPrefix(alias + "/") {
            var entry = stat()
            guard lstat(alias, &entry) == 0 else { throw AggregateFailure.invalid("系统缓存根不可核验") }
            if entry.st_mode & S_IFMT != S_IFLNK { return url }
            var parent = stat(), target = stat()
            guard entry.st_uid == 0, lstat("/private", &parent) == 0, parent.st_uid == 0, parent.st_mode & S_IFMT == S_IFDIR,
                  lstat(physical, &target) == 0, target.st_uid == 0, target.st_mode & S_IFMT == S_IFDIR else { throw AggregateFailure.invalid("系统缓存根链接不受信任") }
            var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
            let count = buffer.withUnsafeMutableBufferPointer { readlink(alias, $0.baseAddress!, $0.count - 1) }
            guard count > 0, count < Int(PATH_MAX) else { throw AggregateFailure.invalid("系统缓存根链接不可核验") }
            buffer[count] = 0
            let destination = buffer.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
            guard destination == physical || destination == String(physical.dropFirst()) else { throw AggregateFailure.invalid("系统缓存根链接目标已变化") }
            return URL(fileURLWithPath: physical + String(path.dropFirst(alias.count)), isDirectory: url.hasDirectoryPath)
        }
        return url
    }
    private func child(_ components:[String])throws->URL {
        var result=try trustedSystemPath(directory)
        try noLinks(result)
        for component in components {
            try PublishedAggregateReader.require(!component.isEmpty && component != "." && component != ".." && !component.contains("/") && !component.contains("\\"),"汇总缓存路径无效")
            result.appendPathComponent(component);try noLinks(result)
        }
        return result
    }
    private func noLinks(_ url:URL)throws {
        var path=try trustedSystemPath(url)
        while path.path != "/" {
            var info=stat()
            if lstat(path.path,&info)==0 {try PublishedAggregateReader.require(info.st_mode & S_IFMT != S_IFLNK,"汇总缓存不能含链接")}
            else if errno != ENOENT {throw AggregateFailure.invalid("汇总缓存路径不可读")}
            path.deleteLastPathComponent()
        }
    }
    func read(_ url:URL,limit:Int)throws->Data {
        let url=try trustedSystemPath(url)
        try noLinks(url)
        let fd=open(url.path,O_RDONLY|O_NOFOLLOW)
        guard fd>=0 else{throw AggregateFailure.invalid("汇总缓存文件不可读")};defer{close(fd)}
        var before=stat();guard fstat(fd,&before)==0,before.st_mode & S_IFMT == S_IFREG,before.st_size>=0,before.st_size<=limit else{throw AggregateFailure.invalid("汇总缓存大小或文件类型无效")}
        var result=Data(count:Int(before.st_size));var offset=0
        try result.withUnsafeMutableBytes { buffer in
            while offset<buffer.count {try Task.checkCancellation();let n=Darwin.read(fd,buffer.baseAddress!.advanced(by:offset),min(65536,buffer.count-offset));guard n>0 else{throw AggregateFailure.invalid("汇总缓存在读取时变化")};offset+=n}
        }
        var extra:UInt8=0;var after=stat()
        try PublishedAggregateReader.require(Darwin.read(fd,&extra,1)==0 && fstat(fd,&after)==0 && before.st_dev==after.st_dev && before.st_ino==after.st_ino && before.st_size==after.st_size && before.st_mtimespec.tv_sec==after.st_mtimespec.tv_sec && before.st_mtimespec.tv_nsec==after.st_mtimespec.tv_nsec,"汇总缓存在读取时变化")
        try noLinks(url);return result
    }
    private func immutable(_ data:Data,to url:URL)throws {
        let url=try trustedSystemPath(url)
        try Task.checkCancellation();try noLinks(url)
        let parent=url.deletingLastPathComponent()
        try fm.createDirectory(at:parent,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);try noLinks(parent)
        if fm.fileExists(atPath:url.path) {try PublishedAggregateReader.require(try read(url,limit:max(data.count,1))==data,"已有汇总原件冲突，未覆盖")}
        else {
            let temporary=parent.appendingPathComponent(".aggregate-"+UUID().uuidString)
            let fd=open(temporary.path,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0o600)
            guard fd>=0 else{throw AggregateFailure.invalid("汇总原件无法独占保存")}
            var owned=stat();guard fstat(fd,&owned)==0 else{close(fd);throw AggregateFailure.invalid("汇总临时文件身份不可确认")}
            defer{close(fd);var current=stat();if lstat(temporary.path,&current)==0 && current.st_dev==owned.st_dev && current.st_ino==owned.st_ino {unlink(temporary.path)}}
            try data.withUnsafeBytes { buffer in
                var offset=0;while offset<buffer.count {try Task.checkCancellation();let n=Darwin.write(fd,buffer.baseAddress!.advanced(by:offset),min(65536,buffer.count-offset));guard n>0 else{throw AggregateFailure.invalid("汇总原件未完整保存")};offset+=n}
            }
            guard fsync(fd)==0 else{throw AggregateFailure.invalid("汇总原件尚未持久保存")}
            try Task.checkCancellation();try noLinks(url)
            if link(temporary.path,url.path) != 0 {
                guard errno==EEXIST else{throw AggregateFailure.invalid("汇总原件未能原子注册")}
                try PublishedAggregateReader.require(try read(url,limit:max(data.count,1))==data,"并发汇总原件冲突")
            }
        }
        let directoryFD=open(parent.path,O_RDONLY|O_NOFOLLOW);guard directoryFD>=0 else{throw AggregateFailure.invalid("汇总目录不可确认")};defer{close(directoryFD)}
        guard fsync(directoryFD)==0 else{throw AggregateFailure.invalid("汇总目录尚未持久保存")}
        try PublishedAggregateReader.require(try read(url,limit:max(data.count,1))==data,"汇总原件保存后不一致")
    }
    private func json<T:Encodable>(_ value:T)throws->Data {let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys];return try encoder.encode(value)}
    private struct Activation:Codable {let contract:String;let snapshotSHA256:String;let validationEpoch:String;let catalogSHA256:String}
    private func epoch(_ value:String)throws->String {guard let id=UUID(uuidString:value) else{throw AggregateFailure.invalid("汇总目录验证代无效")};return id.uuidString.lowercased()}
    func stage(manifest:Data,validationEpoch:String)throws->PublishedAggregateCatalog {
        let identity=try epoch(validationEpoch)
        let catalog=try PublishedAggregateReader.read(manifest:manifest,siteBase:siteBase){shard in try read(try child(["index",shard.sha256+".json"]),limit:shard.bytes)}
        try immutable(manifest,to:child(["aggregate-manifests",catalog.snapshotSHA256+".json"]))
        let sidecar=try child(["aggregate-index",catalog.snapshotSHA256+".json"])
        try immutable(json(catalog),to:sidecar)
        let actual=try read(sidecar,limit:8*1024*1024)
        let activation=Activation(contract:"published-aggregate-activation-v1",snapshotSHA256:catalog.snapshotSHA256,validationEpoch:identity,catalogSHA256:PublishedAggregateReader.sha(actual))
        try immutable(json(activation),to:child(["aggregate-activations",catalog.snapshotSHA256,identity+".json"]))
        return catalog
    }
    /// Neither a matching manifest nor an orphan activation from a cancelled same-SHA sync can grant currentness.
    func load(activeSnapshotSHA256:String,validationEpoch:String?)throws->PublishedAggregateCatalog? {
        guard PublishedAggregateReader.validSHA(activeSnapshotSHA256),let validationEpoch,let identity=try? epoch(validationEpoch) else{return nil}
        let manifest=try child(["aggregate-manifests",activeSnapshotSHA256+".json"]),sidecar=try child(["aggregate-index",activeSnapshotSHA256+".json"]),marker=try child(["aggregate-activations",activeSnapshotSHA256,identity+".json"])
        guard fm.fileExists(atPath:manifest.path),fm.fileExists(atPath:sidecar.path),fm.fileExists(atPath:marker.path) else{return nil}
        let raw=try read(manifest,limit:2*1024*1024)
        try PublishedAggregateReader.require(PublishedAggregateReader.sha(raw)==activeSnapshotSHA256,"汇总原清单与当前目录不一致")
        let catalog=try PublishedAggregateReader.read(manifest:raw,siteBase:siteBase){shard in try read(try child(["index",shard.sha256+".json"]),limit:shard.bytes)}
        let actual=try read(sidecar,limit:8*1024*1024),saved=try JSONDecoder().decode(PublishedAggregateCatalog.self,from:actual),activation=try JSONDecoder().decode(Activation.self,from:read(marker,limit:4096))
        try PublishedAggregateReader.require(saved==catalog && activation.contract=="published-aggregate-activation-v1" && activation.snapshotSHA256==activeSnapshotSHA256 && activation.validationEpoch==identity && activation.catalogSHA256==PublishedAggregateReader.sha(actual),"汇总sidecar或激活代与原来源不一致")
        return catalog
    }
    private func sourceCatalog(snapshot:String)throws->PublishedAggregateCatalog {
        try PublishedAggregateReader.require(PublishedAggregateReader.validSHA(snapshot),"汇总来源清单身份无效")
        let raw=try read(try child(["aggregate-manifests",snapshot+".json"]),limit:2*1024*1024)
        try PublishedAggregateReader.require(PublishedAggregateReader.sha(raw)==snapshot,"汇总原清单已变化")
        return try PublishedAggregateReader.read(manifest:raw,siteBase:siteBase){shard in try read(try child(["index",shard.sha256+".json"]),limit:shard.bytes)}
    }
    func originalRow(for descriptor:PublishedAggregate)throws->Data {
        guard try sourceCatalog(snapshot:descriptor.source.manifestSHA256).records.contains(descriptor) else{throw AggregateFailure.invalid("汇总原目录身份未核验")}
        let bytes=try read(try child(["index",descriptor.source.shardSHA256+".json"]),limit:descriptor.source.shardBytes)
        guard let rows=try JSONSerialization.jsonObject(with:bytes) as? [[String:Any]],rows.indices.contains(descriptor.source.rowIndex) else{throw AggregateFailure.invalid("汇总原行位置无效")}
        let normalized=try PublishedAggregateReader.normalizedRow(rows[descriptor.source.rowIndex])
        try PublishedAggregateReader.require(PublishedAggregateReader.sha(normalized)==descriptor.source.normalizedRowSHA256,"汇总原行身份不符")
        return normalized
    }
    func cacheDocument(_ rawHTML:Data,descriptor:PublishedAggregate,responseURL:URL,fetchedAt:String)throws->AggregateDocument {
        _=try originalRow(for:descriptor)
        let document=try LibraryService.extractAggregateHTML(rawHTML,descriptor:descriptor,responseURL:responseURL,fetchedAt:fetchedAt,siteBaseURL:siteBase)
        let documentBytes=try json(document)
        try PublishedAggregateReader.require(documentBytes.count<=20*1024*1024,"汇总缓存记录超过大小限制")
        let folder=["aggregate-documents",PublishedAggregateReader.sha(Data(descriptor.id.utf8)),descriptor.source.manifestSHA256,document.rawHTMLSHA256]
        try immutable(rawHTML,to:child(folder+["original.html"]))
        try immutable(Data(document.bodyHTML.utf8),to:child(folder+["body.html"]))
        if fm.fileExists(atPath:try child(folder+["document.json"]).path) {
            // Refill only absent source bytes from this validated response; preserve the first immutable observation.
            return try cachedDocument(descriptor:descriptor,rawHTMLSHA256:document.rawHTMLSHA256)
        }
        try immutable(documentBytes,to:child(folder+["document.json"]))
        return document
    }
    func cachedDocument(descriptor:PublishedAggregate,rawHTMLSHA256:String)throws->AggregateDocument {
        _=try originalRow(for:descriptor);try PublishedAggregateReader.require(PublishedAggregateReader.validSHA(rawHTMLSHA256),"汇总网页修订无效")
        let folder=["aggregate-documents",PublishedAggregateReader.sha(Data(descriptor.id.utf8)),descriptor.source.manifestSHA256,rawHTMLSHA256]
        let raw=try read(try child(folder+["original.html"]),limit:16*1024*1024)
        let saved=try JSONDecoder().decode(AggregateDocument.self,from:read(try child(folder+["document.json"]),limit:20*1024*1024))
        try PublishedAggregateReader.require(PublishedAggregateReader.sha(raw)==rawHTMLSHA256 && saved.descriptor==descriptor,"汇总原HTML或目录绑定不一致")
        guard let responseURL=URL(string:saved.responseURL) else{throw AggregateFailure.invalid("汇总原响应地址无效")}
        let actual=try LibraryService.extractAggregateHTML(raw,descriptor:descriptor,responseURL:responseURL,fetchedAt:saved.fetchedAt,siteBaseURL:siteBase)
        try PublishedAggregateReader.require(actual==saved && (try read(try child(folder+["body.html"]),limit:16*1024*1024))==Data(actual.bodyHTML.utf8),"汇总派生正文与原HTML不一致")
        return actual
    }
}


extension PublishedAggregateStore {
    /// Only the exact original ID + manifest scope may select a previously verified HTML revision.
    func latestVerifiedDocument(for descriptor: PublishedAggregate) throws -> AggregateDocument? {
        _ = try originalRow(for: descriptor)
        let folder = try child(["aggregate-documents", PublishedAggregateReader.sha(Data(descriptor.id.utf8)), descriptor.source.manifestSHA256])
        guard fm.fileExists(atPath: folder.path) else { return nil }
        try noLinks(folder)
        let revisions = try fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        var latest: AggregateDocument?, latestTime: Date?
        func observationTime(_ value: String) throws -> Date {
            let formatter = ISO8601DateFormatter()
            if let date = formatter.date(from: value) { return date }
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = formatter.date(from: value) else { throw AggregateFailure.invalid("汇总修订观察时间无效") }
            return date
        }
        for revision in revisions.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            try Task.checkCancellation()
            let sha = revision.lastPathComponent
            try PublishedAggregateReader.require(PublishedAggregateReader.validSHA(sha), "汇总修订目录含未知条目，未挑选旧稿代替")
            // Any corrupt same-scope revision fails the read, even when an older one is intact.
            let document = try cachedDocument(descriptor: descriptor, rawHTMLSHA256: sha)
            let time = try observationTime(document.fetchedAt)
            if latestTime == nil || time > latestTime! { latest = document; latestTime = time }
        }
        try noLinks(folder)
        return latest
    }
}

extension PublishedAggregateStore {
    func imagePlan(_ source:AggregateDocument)throws->AggregateImagePlan {
        try PublishedAggregateReader.require(try cachedDocument(descriptor:source.descriptor,rawHTMLSHA256:source.rawHTMLSHA256)==source,"图片计划必须重放原网页修订")
        let folder=["aggregate-documents",PublishedAggregateReader.sha(Data(source.descriptor.id.utf8)),source.descriptor.source.manifestSHA256,source.rawHTMLSHA256]
        return try LibraryService.aggregateImagePlan(source,rawHTML:read(child(folder+["original.html"]),limit:16*1024*1024),siteBaseURL:siteBase)
    }
    private func resourceFolder(_ source:AggregateDocument)throws->[String] {
        try PublishedAggregateReader.require(PublishedAggregateReader.validSHA(source.rawHTMLSHA256),"图片原网页SHA无效")
        return [AggregateResources.renderDirectory,PublishedAggregateReader.sha(Data(source.descriptor.id.utf8)),source.descriptor.source.manifestSHA256,source.rawHTMLSHA256,AggregateResources.contract]
    }
    func cacheResourceRendering(source:AggregateDocument,plan:AggregateImagePlan,images:[Int:AggregateImageBytes],missing:[Int:String],observedAt:String)throws->AggregateResourceRender {
        try PublishedAggregateReader.require(try imagePlan(source)==plan,"图片位置或原来源已变化")
        let valid=Set(plan.slots.map{$0.index});try PublishedAggregateReader.require(Set(images.keys).isSubset(of:valid)&&Set(missing.keys).isSubset(of:valid)&&Set(images.keys).isDisjoint(with:Set(missing.keys)),"图片结果含未知或冲突位置")
        var assets:[String:AggregateImageBytes]=[:]
        let records=plan.slots.map { slot -> AggregateImageRecord in
            if let asset=images[slot.index]{let sha=PublishedAggregateReader.sha(asset.data);assets[sha]=asset;return .init(slot:slot,sha256:sha,mime:asset.mime,bytes:asset.data.count,missingReason:nil)}
            return .init(slot:slot,sha256:nil,mime:nil,bytes:nil,missingReason:missing[slot.index] ?? "该图片尚未保存")
        }
        let html=try AggregateResources.render(source:source,plan:plan,images:records,assets:assets)
        let manifest=AggregateResourceManifest(contract:AggregateResources.contract,plan:plan,observedAt:observedAt,images:records,renderedBodySHA256:PublishedAggregateReader.sha(Data(html.utf8)),completeOffline:false)
        try validResourceTime(observedAt)
        let bytes=try json(manifest),sha=PublishedAggregateReader.sha(bytes)
        try PublishedAggregateReader.require(bytes.count<=4*1024*1024,"图片资源清单超过大小限制")
        for (sha,asset) in assets.sorted(by:{$0.key<$1.key}) {try immutable(asset.data,to:child(["aggregate-image-bytes-v1",sha]))}
        try immutable(bytes,to:child(resourceFolder(source)+[sha+".json"]))
        return try cachedResourceRendering(source:source,manifestSHA256:sha)
    }
    private func validResourceTime(_ value:String)throws {
        let formatter=ISO8601DateFormatter();var time=formatter.date(from:value)
        if time==nil{formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds];time=formatter.date(from:value)}
        try PublishedAggregateReader.require(time != nil,"图片资源观察时间无效")
    }
    func cachedResourceRendering(source:AggregateDocument,manifestSHA256:String)throws->AggregateResourceRender {
        let plan=try imagePlan(source)
        try PublishedAggregateReader.require(PublishedAggregateReader.validSHA(manifestSHA256),"图片资源修订SHA无效")
        let bytes=try read(child(resourceFolder(source)+[manifestSHA256+".json"]),limit:4*1024*1024)
        try PublishedAggregateReader.require(PublishedAggregateReader.sha(bytes)==manifestSHA256,"图片资源清单真实字节已变化")
        let manifest=try JSONDecoder().decode(AggregateResourceManifest.self,from:bytes)
        try PublishedAggregateReader.require(manifest.contract==AggregateResources.contract&&manifest.plan==plan&&manifest.completeOffline==false,"图片资源原HTML、目录或派生版本不符")
        try validResourceTime(manifest.observedAt)
        try AggregateResources.validateReferenceBudget(manifest.images)
        var assets:[String:AggregateImageBytes]=[:]
        for record in manifest.images {
            if let sha=record.sha256,let mime=record.mime {
                try PublishedAggregateReader.require(PublishedAggregateReader.validSHA(sha),"图片字节SHA无效")
                guard let size=record.bytes else{throw AggregateFailure.invalid("图片字节长度缺失")}
                let data=try read(child(["aggregate-image-bytes-v1",sha]),limit:size)
                try PublishedAggregateReader.require(data.count==size,"图片字节长度与清单不一致")
                assets[sha] = .init(data:data,mime:mime)
            }
        }
        let html=try AggregateResources.render(source:source,plan:plan,images:manifest.images,assets:assets)
        try PublishedAggregateReader.require(PublishedAggregateReader.sha(Data(html.utf8))==manifest.renderedBodySHA256,"图片渲染派生身份不符")
        return .init(manifest:manifest,manifestSHA256:manifestSHA256,bodyHTML:html)
    }
}

extension PublishedAggregateStore {
    /// Strict same-HTML scope. Every peer is cold-verified; damaged peers cannot be skipped for an older render.
    func latestResourceRendering(source:AggregateDocument)throws->AggregateResourceRender? {
        _=try imagePlan(source)
        let folder=try child(resourceFolder(source));try noLinks(folder)
        guard fm.fileExists(atPath:folder.path) else{return nil}
        let files=try fm.contentsOfDirectory(at:folder,includingPropertiesForKeys:nil)
        var latest:AggregateResourceRender?
        for file in files.sorted(by:{$0.lastPathComponent<$1.lastPathComponent}) {
            let name=file.lastPathComponent
            try PublishedAggregateReader.require(name.hasSuffix(".json")&&PublishedAggregateReader.validSHA(String(name.dropLast(5))),"图片修订目录含未知项，未挑选旧修订")
            let value=try cachedResourceRendering(source:source,manifestSHA256:String(name.dropLast(5)))
            let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
            func time(_ text:String)->Date{formatter.date(from:text) ?? ISO8601DateFormatter().date(from:text)!}
            if latest==nil || time(value.manifest.observedAt)>time(latest!.manifest.observedAt){latest=value}
        }
        try noLinks(folder);return latest
    }
}
