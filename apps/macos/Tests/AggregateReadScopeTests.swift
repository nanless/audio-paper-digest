import Foundation
import Darwin

@main struct AggregateReadScopeTests {
    static var checks = 0
    static func expect(_ condition: Bool, _ reason: String) throws {
        checks += 1
        guard condition else { throw AggregateFailure.invalid("TEST: " + reason) }
        print("PASS " + reason)
    }
    static func rejects<T>(_ body: () throws -> T) -> Bool { do { _ = try body(); return false } catch { return true } }
    static func main() throws {
        setbuf(stdout, nil)
        let physical = realpath(FileManager.default.temporaryDirectory.path, nil)!
        defer { free(physical) }
        let root = URL(fileURLWithPath: String(cString:physical)).appendingPathComponent("aggregate-read-scope-"+UUID().uuidString)
        let fm=FileManager.default
        try fm.createDirectory(at:root.appendingPathComponent("index"),withIntermediateDirectories:true)
        defer { try? fm.removeItem(at:root) }
        let prefix="/audio-paper-digest-blog/",epoch=UUID().uuidString
        var descriptors:[[String:Any]]=[],firstShard:URL?,firstBytes:Data?
        var allRows:[[String:Any]]=[["pageType":"daily","permalink":prefix+"scope-summary/","title":"隔离同步读取基准","date":"2026-11-01"]]
        // Synthetic 10,001-record/21-shard public catalog. These are metadata
        // fixtures, not claims about the user's website or scientific papers.
        allRows += (0..<10_000).map { ["pageType":"paper","permalink":prefix+"papers/scope-\($0)/","title":"受控目录条目 \($0)","date":"2026-11-01"] }
        var totalBytes=0
        for start in stride(from:0,to:allRows.count,by:500) {
            let rows=Array(allRows[start..<min(start+500,allRows.count)])
            let bytes=try JSONSerialization.data(withJSONObject:rows,options:.sortedKeys),sha=PublishedAggregateReader.sha(bytes)
            let part="part-"+String(format:"%04d",descriptors.count+1)+"-"+sha.prefix(12)+".json"
            let file=root.appendingPathComponent("index/"+sha+".json")
            try bytes.write(to:file)
            if firstShard==nil { firstShard=file;firstBytes=bytes }
            descriptors.append(["url":"search-index/"+part,"bytes":bytes.count,"sha256":sha,"recordCount":rows.count]);totalBytes += bytes.count
        }
        let manifest=try JSONSerialization.data(withJSONObject:["contract":"paper-search-index-manifest-v1","recordCount":allRows.count,"totalBytes":totalBytes,"shards":descriptors],options:.sortedKeys)
        let plain=PublishedAggregateStore(directory:root),catalog=try plain.stage(manifest:manifest,validationEpoch:epoch),record=catalog.records[0]
        let url=URL(string:record.sourceURL)!
        // Eight immutable HTML revisions exercise the real latest-version reader.
        try plain.withVerifiedReadScope { store in
            for revision in 0..<8 {
                let html=Data("<html><body><div id='article-body' class='post-content'><h2>受控修订 \(revision)</h2><p>仅检验本地来源读取。</p></div></body></html>".utf8)
                _ = try store.cacheDocument(html,descriptor:record,responseURL:url,fetchedAt:String(format:"2026-11-01T00:00:%02dZ",revision))
            }
        }
        let baselineMetrics=AggregateReadMetrics(),baseline=PublishedAggregateStore(directory:root,metrics:baselineMetrics)
        let before=Date()
        let baselineCatalog=try baseline.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:epoch)!
        let baselineDocument=try baseline.latestVerifiedDocument(for:baselineCatalog.records[0])!
        let baselineSeconds=Date().timeIntervalSince(before)
        let scopedMetrics=AggregateReadMetrics(),scoped=PublishedAggregateStore(directory:root,metrics:scopedMetrics)
        let started=Date()
        let optimized=try scoped.withVerifiedReadScope { store -> AggregateDocument in
            let current=try store.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:epoch)!
            return try store.latestVerifiedDocument(for:current.records[0])!
        }
        let scopedSeconds=Date().timeIntervalSince(started)
        try expect(optimized==baselineDocument,"scoped latest-version reader returns exactly the normally cold-verified document")
        try expect(baselineMetrics.sourceParses>=9 && scopedMetrics.sourceParses==1,"10,001-row source catalog is parsed once per synchronous operation")
        try expect(scopedMetrics.fileReads<baselineMetrics.fileReads,"complete entry/exit guards still reduce actual source file reads")
        print(String(format:"BENCH synthetic records=%d shards=%d revisions=8 baseline parses=%d reads=%d seconds=%.3f scoped parses=%d reads=%d seconds=%.3f",allRows.count,descriptors.count,baselineMetrics.sourceParses,baselineMetrics.fileReads,baselineSeconds,scopedMetrics.sourceParses,scopedMetrics.fileReads,scopedSeconds))

        var escaped:PublishedAggregateStore?
        _ = try scoped.withVerifiedReadScope { store in escaped=store; return try store.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:epoch) }
        try expect(rejects { try escaped!.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:epoch) },"escaped store value cannot reuse the ended private scope")
        let originalFile=firstShard!,originalBytes=firstBytes!
        let byteMutationRejected=rejects {
            try scoped.withVerifiedReadScope { store in
                _ = try store.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:epoch)
                var changed=originalBytes;changed[changed.startIndex] ^= 1;try changed.write(to:originalFile)
                // The in-scope memo is allowed to exist, but cannot return a
                // successful result past the final full original-byte guard.
                _ = try store.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:epoch)
            }
        }
        try originalBytes.write(to:originalFile)
        try expect(byteMutationRejected,"same-size source mutation fails at scope exit despite a memoized catalog")
        let backup=root.appendingPathComponent("first-shard-copy.json")
        try originalBytes.write(to:backup)
        let symlinkRejected=rejects {
            try scoped.withVerifiedReadScope { store in
                _ = try store.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:epoch)
                try fm.removeItem(at:originalFile);try fm.createSymbolicLink(at:originalFile,withDestinationURL:backup)
            }
        }
        try fm.removeItem(at:originalFile);try originalBytes.write(to:originalFile)
        try expect(symlinkRejected,"replacing an observed original with a symlink fails the final ordinary path guard")
        var retainedEpoch:String?
        try scoped.withVerifiedReadScope { store in
            retainedEpoch=epoch
            _ = try store.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:epoch)
            try expect(try store.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:UUID().uuidString)==nil,"equal snapshot bytes do not activate an unrelated validation epoch")
        }
        try expect(retainedEpoch==epoch && (try scoped.load(activeSnapshotSHA256:catalog.snapshotSHA256,validationEpoch:epoch)) != nil,"later independent calls reverify current source normally")
        print("RESULT \(checks) passed")
    }
}
