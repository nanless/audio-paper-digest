import Foundation
import CryptoKit
import Darwin

private struct BackupTestError: Error, LocalizedError {
    let text:String
    var errorDescription:String?{text}
}
@main struct BackupCodecTests {
    static func main() throws {
        let fm=FileManager.default
        let root=fm.temporaryDirectory.appendingPathComponent("paperdigest-backup-tests-"+UUID().uuidString,isDirectory:true)
        try fm.createDirectory(at:root,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);defer{try? fm.removeItem(at:root)}
        let live=root.appendingPathComponent("original",isDirectory:true)
        try fm.createDirectory(at:live,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        let personal=Data("{\"schema\":1,\"notes\":{\"fixture\":{\"text\":\"原笔记原字节\",\"revision\":2}},\"sessions\":[{\"status\":\"failed\"}]}\n".utf8)
        let material=Data("%PDF-1.7\nExplicit backup fixture, not a publication.\n".utf8)
        let journal=Data("{\"pdfPath\":\"\(live.path)/files/paper.pdf\",\"status\":\"partial\",\"attempts\":3,\"fee\":\"unknown\"}\n".utf8)
        try personal.write(to:live.appendingPathComponent("personal.json"))
        try fm.createDirectory(at:live.appendingPathComponent("files"),withIntermediateDirectories:false)
        try material.write(to:live.appendingPathComponent("files/paper.pdf"))
        try journal.write(to:live.appendingPathComponent("files/archive.json"))
        try Data("hidden private data".utf8).write(to:live.appendingPathComponent(".hidden"))
        var passed=0,failures:[String]=[]
        func require(_ value:Bool,_ message:String) throws{if !value{throw BackupTestError(text:message)}}
        func check(_ name:String,_ action:() throws->Void){do{try action();passed+=1;print("PASS "+name)}catch{failures.append(name+": "+error.localizedDescription);print("FAIL "+name+": "+error.localizedDescription)}}
        func rejects(_ action:() throws->Void) throws{do{try action()}catch{return};throw BackupTestError(text:"Expected rejection")}
        func hash(_ data:Data)->String{SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()}
        func entry(_ path:String,_ data:Data=Data("fixture".utf8))->BackupCodec.Entry{.init(path:path,sha256:hash(data),data:data)}
        func payload(_ entries:[BackupCodec.Entry],source:String=live.path)->BackupCodec.Payload{.init(sourceDirectory:source,files:[entry("personal.json",personal)]+entries)}
        func unchanged() throws {try require(try Data(contentsOf:live.appendingPathComponent("personal.json"))==personal,"live personal data unchanged");try require(try Data(contentsOf:live.appendingPathComponent("files/archive.json"))==journal,"live historical journal unchanged")}
        func stages()->[String]{(try? fm.contentsOfDirectory(atPath:root.path).filter{$0.hasPrefix(".paperdigest-restore-")}) ?? []}
        let original=try BackupCodec.collect(sourceDirectory:live)
        check("collect includes hidden files and complete immutable journal bytes") {
            try require(original.contract=="paperdigest-backup-v2" && original.files.count==4,"complete files contract")
            try require(original.files.contains{$0.path==".hidden"},"hidden file included")
            try require(original.files.first{$0.path=="files/archive.json"}?.data==journal,"original journal unchanged")
            for file in original.files{try require(file.sha256==hash(file.data),"real file SHA")}
        }
        check("encode/parse preserves source directory and exact original data") {
            let encoded=try BackupCodec.encode(original),decoded=try BackupCodec.parse(encoded)
            try require(decoded.sourceDirectory==live.path && decoded.files.map(\.path)==original.files.map(\.path),"roundtrip identity")
            for (old,new) in zip(original.files,decoded.files){try require(old.data==new.data && old.sha256==new.sha256,"byte-preserving JSON base64 roundtrip")}
        }
        let restored=try BackupCodec.stage(original,parentDirectory:root)
        check("different-directory restore keeps scientific/archive JSON exact and emits separate aliases") {
            try require(restored.stageDirectory != live && restored.personalStoreData==personal,"distinct staged directory and original store")
            try require(try Data(contentsOf:restored.stageDirectory.appendingPathComponent("files/archive.json"))==journal,"scientific history not rewritten")
            try require(try PrivateStoragePaths.loadRoots(directory:restored.stageDirectory)==[live.path],"source root recorded separately")
            try unchanged()
        }
        check("stage files/directories have restricted permissions") {
            for file in original.files {
                let permissions=try fm.attributesOfItem(atPath:restored.stageDirectory.appendingPathComponent(file.path).path)[.posixPermissions] as! NSNumber
                try require(permissions.intValue & 0o777 == 0o600,"restored file 0600")
            }
            for directory in [restored.stageDirectory,restored.stageDirectory.appendingPathComponent("files")] {
                let p=try fm.attributesOfItem(atPath:directory.path)[.posixPermissions] as! NSNumber;try require(p.intValue & 0o777 == 0o700,"staged directory 0700")
            }
        }
        check("current directory resolution accepts existing verification policy or verifies supplied SHA") {
            let path=restored.stageDirectory.appendingPathComponent("files/paper.pdf").path
            try require(try PrivateStoragePaths.resolve(path,directory:restored.stageDirectory).path==path,"current path resolved")
            _=try PrivateStoragePaths.resolve(path,directory:restored.stageDirectory,expectedSHA256:hash(material))
            try rejects{_=try PrivateStoragePaths.resolve(path,directory:restored.stageDirectory,expectedSHA256:String(repeating:"0",count:64))}
        }
        check("current-directory Foundation and POSIX canonical aliases resolve without old-root authority") {
            let d=restored.stageDirectory
            guard let pointer=realpath(d.path,nil) else{throw BackupTestError(text:"realpath unavailable")}
            let posix=String(cString:pointer);free(pointer)
            let foundation=d.standardizedFileURL.resolvingSymlinksInPath().path
            for prefix in Set([d.path,posix,foundation]) {
                let file=try PrivateStoragePaths.resolve(prefix+"/files/paper.pdf",directory:d)
                try require(try Data(contentsOf:file)==material,"current canonical alias content")
            }
            let link=root.appendingPathComponent("real-directory-link")
            try fm.createSymbolicLink(at:link,withDestinationURL:d);defer{try? fm.removeItem(at:link)}
            try rejects{_=try PrivateStoragePaths.resolve(link.path+"/files/paper.pdf",directory:d)}
            try rejects{_=try PrivateStoragePaths.resolve(link.path+"/files/paper.pdf",directory:link)}
        }
        check("old absolute path relocates only with matching original SHA") {
            let raw=live.appendingPathComponent("files/paper.pdf").path
            let resolved=try PrivateStoragePaths.resolve(raw,directory:restored.stageDirectory,expectedSHA256:hash(material))
            try require(resolved.path==restored.stageDirectory.appendingPathComponent("files/paper.pdf").path,"exact relative file relocated")
            try rejects{_=try PrivateStoragePaths.resolve(raw,directory:restored.stageDirectory)}
            try rejects{_=try PrivateStoragePaths.resolve(raw,directory:restored.stageDirectory,expectedSHA256:String(repeating:"0",count:64))}
        }
        check("second restore retains all legitimate historical roots without rewriting journals") {
            let again=try BackupCodec.collect(sourceDirectory:restored.stageDirectory)
            let second=try BackupCodec.stage(again,parentDirectory:root);defer{try? fm.removeItem(at:second.stageDirectory)}
            try require(Set(try PrivateStoragePaths.loadRoots(directory:second.stageDirectory))==Set([live.path,restored.stageDirectory.path]),"both old roots retained")
            let resolved=try PrivateStoragePaths.resolve(live.appendingPathComponent("files/archive.json").path,directory:second.stageDirectory,expectedSHA256:hash(journal))
            try require(try Data(contentsOf:resolved)==journal,"multi-hop alias preserves historical bytes")
        }
        check("all dangerous relative paths rejected before stage/live mutation") {
            let before=stages()
            for bad in ["",".","..","./a","a/../b","a//b","/absolute","a/","a\\b","a\nfile","a\u{0000}b"] {
                try rejects{_=try BackupCodec.stage(payload([entry(bad)]),parentDirectory:root)}
            }
            try require(stages()==before,"no stage created on malformed paths");try unchanged()
        }
        check("duplicate file, case alias, Unicode alias and directory component aliases rejected") {
            for paths in [["a","a"],["Case","case"],["café","cafe\u{0301}"],["Dir/one","dir/two"],["file","file/child"]] {
                try rejects{_=try BackupCodec.stage(payload(paths.map{entry($0)}),parentDirectory:root)}
            }
            try unchanged()
        }
        check("hash corruption rejected in full parse before any stage write") {
            var object=try JSONSerialization.jsonObject(with:BackupCodec.encode(original)) as! [String:Any]
            var entries=object["files"] as! [[String:Any]];entries[0]["sha256"]=String(repeating:"0",count:64);object["files"]=entries
            let before=stages();try rejects{_=try BackupCodec.stage(data:JSONSerialization.data(withJSONObject:object),parentDirectory:root)}
            try require(stages()==before,"hash corruption creates no stage");try unchanged()
        }
        check("contract, personal store and malformed source roots rejected") {
            var object=try JSONSerialization.jsonObject(with:BackupCodec.encode(original)) as! [String:Any];object["contract"]="paperdigest-backup-v1"
            try rejects{_=try BackupCodec.parse(JSONSerialization.data(withJSONObject:object))}
            try rejects{_=try BackupCodec.stage(.init(sourceDirectory:live.path,files:[entry("unrelated")]),parentDirectory:root)}
            try rejects{_=try BackupCodec.stage(payload([entry("x")],source:"/bad//root"),parentDirectory:root)}
            try rejects{_=try BackupCodec.stage(payload([entry("x")],source:"/"),parentDirectory:root)}
        }
        check("root map contract, duplicate aliases and overlapping aliases rejected") {
            for map:[String:Any] in [["contract":"wrong","roots":["/old/root"]],["contract":"paperdigest-storage-aliases-v1","roots":["/old/root","/old/root"]],["contract":"paperdigest-storage-aliases-v1","roots":["/old/root","/OLD/ROOT"]],["contract":"paperdigest-storage-aliases-v1","roots":["/old/root","/old/root-else","/old/root/child"]],["contract":"paperdigest-storage-aliases-v1","roots":["/old/../escape"]],["contract":"paperdigest-storage-aliases-v1","roots":["/"]]] {
                let data=try JSONSerialization.data(withJSONObject:map)
                try rejects{_=try BackupCodec.stage(payload([entry(PrivateStoragePaths.aliasesFilename,data)]),parentDirectory:root)}
            }
        }
        check("reserved root-map filename alias and parent conflicts rejected") {
            for path in ["restoredpathroots.json","RestoredPathRoots.json/child"]{try rejects{_=try BackupCodec.stage(payload([entry(path)]),parentDirectory:root)}}
        }
        check("collect rejects file/directory/dangling symlinks and symlink root") {
            let outside=root.appendingPathComponent("outside");try Data("outside".utf8).write(to:outside)
            for target in [outside,root,root.appendingPathComponent("missing")] {
                let link=live.appendingPathComponent("symbolic");try fm.createSymbolicLink(at:link,withDestinationURL:target)
                try rejects{_=try BackupCodec.collect(sourceDirectory:live)};try fm.removeItem(at:link)
            }
            let link=root.appendingPathComponent("source-link");try fm.createSymbolicLink(at:link,withDestinationURL:live)
            try rejects{_=try BackupCodec.collect(sourceDirectory:link)}
            try unchanged()
        }
        check("resolver rejects symlink material and symlink ancestor even with matching hash") {
            let file=restored.stageDirectory.appendingPathComponent("files/paper.pdf")
            let link=restored.stageDirectory.appendingPathComponent("file-link");try fm.createSymbolicLink(at:link,withDestinationURL:file)
            try rejects{_=try PrivateStoragePaths.resolve(link.path,directory:restored.stageDirectory,expectedSHA256:hash(material))}
            let directoryLink=restored.stageDirectory.appendingPathComponent("dir-link");try fm.createSymbolicLink(at:directoryLink,withDestinationURL:restored.stageDirectory.appendingPathComponent("files"))
            try rejects{_=try PrivateStoragePaths.resolve(directoryLink.appendingPathComponent("paper.pdf").path,directory:restored.stageDirectory,expectedSHA256:hash(material))}
            try fm.removeItem(at:link);try fm.removeItem(at:directoryLink)
        }
        check("resolver rejects root-prefix tricks, directory escape and nonregular files") {
            for raw in [live.path+"-other/files/paper.pdf",live.path+"/../original/files/paper.pdf",live.path+"//files/paper.pdf",live.path+"/files",restored.stageDirectory.path+"/files/./paper.pdf"] {
                try rejects{_=try PrivateStoragePaths.resolve(raw,directory:restored.stageDirectory,expectedSHA256:hash(material))}
            }
        }
        check("resolver rejects corrupt and symlinked root map") {
            let map=restored.stageDirectory.appendingPathComponent(PrivateStoragePaths.aliasesFilename),saved=try Data(contentsOf:map)
            defer{try? fm.removeItem(at:map);try? saved.write(to:map)}
            try Data("{\"contract\":\"wrong\",\"roots\":[]}".utf8).write(to:map)
            try rejects{_=try PrivateStoragePaths.resolve(live.path+"/files/paper.pdf",directory:restored.stageDirectory,expectedSHA256:hash(material))}
            try fm.removeItem(at:map);try fm.createSymbolicLink(at:map,withDestinationURL:root.appendingPathComponent("missing-map"))
            try rejects{_=try PrivateStoragePaths.resolve(live.path+"/files/paper.pdf",directory:restored.stageDirectory,expectedSHA256:hash(material))}
        }
        check("decoded, encoded and entry-count bounds reject without loading huge buffers") {
            let sparse=root.appendingPathComponent("oversize-sparse");fm.createFile(atPath:sparse.path,contents:nil)
            let handle=try FileHandle(forWritingTo:sparse);try handle.truncate(atOffset:UInt64(BackupCodec.maxEncodedBytes+1));try handle.close()
            let mapped=try Data(contentsOf:sparse,options:[.alwaysMapped])
            try rejects{_=try BackupCodec.parse(mapped)}
            try rejects{_=try BackupCodec.stage(payload([.init(path:"large",sha256:String(repeating:"0",count:64),data:mapped)]),parentDirectory:root)}
            let tooMany=Array(repeating:entry("repeated",Data()),count:BackupCodec.maxEntries)
            try rejects{_=try BackupCodec.stage(payload(tooMany),parentDirectory:root)}
            try fm.removeItem(at:sparse)
            let file=live.appendingPathComponent("too-large");fm.createFile(atPath:file.path,contents:nil)
            let oversized=try FileHandle(forWritingTo:file);try oversized.truncate(atOffset:UInt64(BackupCodec.maxDecodedBytes+1));try oversized.close()
            try rejects{_=try BackupCodec.collect(sourceDirectory:live)};try fm.removeItem(at:file)
            try unchanged()
        }
        check("filesystem write failure cleans only temporary stage, leaving live untouched") {
            let before=Set(stages())
            try rejects{_=try BackupCodec.stage(payload([entry(String(repeating:"x",count:300))]),parentDirectory:root)}
            try require(Set(stages())==before,"failed stage removed");try unchanged()
        }
        check("capture excludes only two local ModelUsage seals before reading bytes, preserving other research") {
            let d=root.appendingPathComponent("local-seals");try fm.createDirectory(at:d,withIntermediateDirectories:false)
            try personal.write(to:d.appendingPathComponent("personal.json"))
            try fm.createDirectory(at:d.appendingPathComponent("ModelUsage"),withIntermediateDirectories:false)
            let keep=[".hidden","other.key","response-integrity.key","ModelUsage/input.json","ModelUsage/response.json","ModelUsage/receipt.json","ModelUsage/usage.json","ModelUsage/other.key"]
            for path in keep { try Data("ordinary synthetic research".utf8).write(to:d.appendingPathComponent(path)) }
            for path in BackupCodec.localOnlyKeyPaths {
                let key=d.appendingPathComponent(path);try Data().write(to:key)
                let handle=try FileHandle(forWritingTo:key);try handle.truncate(atOffset:UInt64(BackupCodec.maxDecodedBytes+1));try handle.close()
            }
            let result=try BackupCodec.collect(sourceDirectory:d)
            try require(result.files.count==keep.count+1 && !result.files.contains{BackupCodec.isLocalOnlyKey($0.path)},"no local key entry or per-file fingerprint; oversize key bytes never read")
            try require(Set(result.files.map(\.path))==Set(keep+["personal.json"]),"all other hidden/key-named/input/response/receipt/usage files retained")
            _=try BackupCodec.encode(result)
        }
        check("legacy key-containing archives fully verify then stage skips keys without changing response bytes") {
            let response=Data("original sealed response fixture".utf8)
            let legacy=payload(BackupCodec.localOnlyKeyPaths.map{entry($0,Data("synthetic old device key".utf8))}+[entry("ModelUsage/response.json",response)])
            // JSONEncoder is deliberate test-only legacy construction; production encode must refuse.
            let bytes=try JSONEncoder().encode(legacy),decoded=try BackupCodec.parse(bytes)
            let oldFile=root.appendingPathComponent("legacy-original.paperdigest");try bytes.write(to:oldFile)
            let staged=try BackupCodec.stage(decoded,parentDirectory:root);defer{try? fm.removeItem(at:staged.stageDirectory)}
            try require(decoded.files.count==4,"old entries not rewritten during parse")
            for path in BackupCodec.localOnlyKeyPaths{try require(!fm.fileExists(atPath:staged.stageDirectory.appendingPathComponent(path).path),"old key not imported")}
            try require(try Data(contentsOf:staged.stageDirectory.appendingPathComponent("ModelUsage/response.json"))==response,"old response byte preserved without reseal")
            try rejects{_=try BackupCodec.encode(decoded)}
            try require(try Data(contentsOf:oldFile)==bytes,"legacy encoded archive remains byte-exact and locally usable")
        }
        check("reserved local seal case aliases cannot bypass portable export or restore policy") {
            for path in ["modelusage/RESPONSE-INTEGRITY.KEY","MODELUSAGE/response-integrity.ANDROID.key"] {
                let legacy=payload([entry(path)])
                try require(BackupCodec.isLocalOnlyKey(path),"case alias recognized")
                try rejects{_=try BackupCodec.encode(legacy)}
                let staged=try BackupCodec.stage(legacy,parentDirectory:root);defer{try? fm.removeItem(at:staged.stageDirectory)}
                try require(!fm.fileExists(atPath:staged.stageDirectory.appendingPathComponent(path).path),"alias key skipped")
            }
        }
        check("reserved local seal slots cannot become directories even with no parent key entry") {
            let before=stages()
            for path in ["ModelUsage/response-integrity.key/child","ModelUsage/response-integrity.android.key/child","modelusage/RESPONSE-INTEGRITY.KEY/child","MODELUSAGE/response-integrity.ANDROID.KEY/deep/child"] {
                let value=payload([entry(path)]),bytes=try JSONEncoder().encode(value)
                try rejects{try BackupCodec.validate(value)}
                try rejects{_=try BackupCodec.encode(value)}
                try rejects{_=try BackupCodec.parse(bytes)}
                try rejects{_=try BackupCodec.stage(data:bytes,parentDirectory:root)}
            }
            try require(stages()==before,"no fresh key directory stage created")
            let ordinary=payload([entry("foo.key/child"),entry("ModelUsage/ordinary.key/child"),entry("nested/ModelUsage/response-integrity.key/child")])
            let staged=try BackupCodec.stage(data:BackupCodec.encode(ordinary),parentDirectory:root);defer{try? fm.removeItem(at:staged.stageDirectory)}
            for file in ordinary.files {try require(try Data(contentsOf:staged.stageDirectory.appendingPathComponent(file.path))==file.data,"ordinary key-named directories remain portable")}
        }
        check("even skipped legacy key bytes must pass original SHA before staging") {
            let bad=BackupCodec.Entry(path:BackupCodec.localOnlyKeyPaths[0],sha256:String(repeating:"0",count:64),data:Data("synthetic damaged key".utf8))
            let bytes=try JSONEncoder().encode(payload([bad])),before=stages()
            try rejects{_=try BackupCodec.parse(bytes)};try rejects{_=try BackupCodec.stage(data:bytes,parentDirectory:root)}
            try require(stages()==before,"corrupt skipped secret never bypasses integrity or writes stage")
        }
        print("Backup codec regression: \(passed) passed; \(failures.count) failed. Temporary fixtures only; no live app, network, or Keychain access.")
        if !failures.isEmpty{FileHandle.standardError.write(Data((failures.joined(separator:"\n")+"\n").utf8));fflush(stdout);exit(1)}
    }
}
