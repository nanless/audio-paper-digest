import AppKit
import Foundation
import WebKit

@main struct NoteConflictMergerTests {
    @MainActor static func main() async throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)

        let mac = "00000000-0000-4000-8000-000000000011"
        let android = "00000000-0000-4000-8000-000000000022"
        let tablet = "00000000-0000-4000-8000-000000000033"
        let paperA = "arxiv:2610.27491"
        let paperB = "arxiv:2610.27492"

        var passes = 0
        var failures: [String] = []
        func check(_ name: String, _ condition: Bool) {
            if condition {
                passes += 1
            } else {
                failures.append(name)
                fputs("FAIL: \(name)\n", stderr)
            }
        }
        func expectsThrow(_ name: String, _ action: () throws -> Void) {
            do {
                try action()
                failures.append(name)
                fputs("FAIL (expected throw): \(name)\n", stderr)
            } catch {
                passes += 1
            }
        }
        func expectsThrowAsync(_ name: String, _ action: () async throws -> Void) async {
            do {
                try await action()
                failures.append(name)
                fputs("FAIL (expected async throw): \(name)\n", stderr)
            } catch {
                passes += 1
            }
        }

        let tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("NoteConflictMergerTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        func emptyPersonal() throws -> [String: Any] {
            try ClientProtocols.record("paperdigest-personal-library", fields: [
                "notes": [String: [String: Any]](),
                "favorites": [String](),
                "reading": [String](),
                "readingState": [String: [String: Any]](),
                "annotations": [String: [[String: Any]]](),
                "sessions": [[String: Any]](),
                "jobs": [[String: Any]](),
                "settings": ["appearance": "system", "font": 18, "syncHours": 12]
            ])
        }
        func withNote(_ root: [String: Any], id: String = paperA, text: String?, revision: Int = 1) -> [String: Any] {
            var next = root
            var notes = next["notes"] as? [String: [String: Any]] ?? [:]
            if let text {
                notes[id] = ["text": text, "revision": revision]
            } else {
                notes.removeValue(forKey: id)
            }
            next["notes"] = notes
            return next
        }

        // 1. Same-text concurrent edits & "" vs NSNull empty-note normalization emit zero false/ghost conflicts.
        let sameMac = try PersonalWebDavSync.plan(
            local: withNote(try emptyPersonal(), text: "完全一致的跨端研究笔记", revision: 1),
            device: mac,
            remote: [:]
        )
        let sameAndroid = try PersonalWebDavSync.plan(
            local: withNote(try emptyPersonal(), text: "完全一致的跨端研究笔记", revision: 4),
            device: android,
            remote: [:]
        )
        let sameMerged = try PersonalWebDavSync.plan(
            local: sameMac.personal,
            device: mac,
            remote: [mac: sameMac.upload!, android: sameAndroid.upload!]
        )
        check("idempotent identical concurrent note has zero conflict count", sameMerged.conflicts == 0)
        check("idempotent identical concurrent note emits no conflict snapshot", sameMerged.noteConflicts.isEmpty)

        // Ghost conflict test: Mac deleted note (NSNull in WebDAV record) while Android saved empty string ""!
        let seedNonEmpty = try PersonalWebDavSync.plan(
            local: withNote(try emptyPersonal(), text: "待清空初稿", revision: 1),
            device: mac,
            remote: [:]
        )
        let androidPulledSeed = try PersonalWebDavSync.plan(
            local: try emptyPersonal(),
            device: android,
            remote: [mac: seedNonEmpty.upload!]
        )
        let macDeleted = try PersonalWebDavSync.plan(
            local: withNote(seedNonEmpty.personal, text: nil),
            device: mac,
            remote: [mac: seedNonEmpty.upload!]
        )
        let androidClearedEmpty = try PersonalWebDavSync.plan(
            local: withNote(androidPulledSeed.personal, text: "", revision: 2),
            device: android,
            remote: [mac: seedNonEmpty.upload!]
        )
        let nullVsEmptyPlan = try PersonalWebDavSync.plan(
            local: macDeleted.personal,
            device: mac,
            remote: [mac: macDeleted.upload!, android: androidClearedEmpty.upload!]
        )
        check("NSNull deletion vs empty string note produces zero ghost conflicts",
              nullVsEmptyPlan.conflicts == 0 && nullVsEmptyPlan.noteConflicts.isEmpty)

        // Empty local "" vs non-empty remote note produces a real conflict snapshot with localNote == "".
        let androidWroteBody = try PersonalWebDavSync.plan(
            local: withNote(androidPulledSeed.personal, text: "远端保留的实验笔记", revision: 2),
            device: android,
            remote: [mac: seedNonEmpty.upload!]
        )
        let emptyVsBodyPlan = try PersonalWebDavSync.plan(
            local: macDeleted.personal,
            device: mac,
            remote: [mac: macDeleted.upload!, android: androidWroteBody.upload!]
        )
        check("empty/deleted local vs non-empty remote records conflict snapshot",
              emptyVsBodyPlan.conflicts == 1 &&
              emptyVsBodyPlan.noteConflicts.first?.localNote == "" &&
              emptyVsBodyPlan.noteConflicts.first?.remoteNote == "远端保留的实验笔记")
        check("mergeBoth on empty local + single non-empty remote yields clean remote text",
              (try? NoteConflictMerger.merge(emptyVsBodyPlan.noteConflicts[0], strategy: .mergeBoth)) == "远端保留的实验笔记")

        // 2. Heterogeneous concurrent edits + consecutive unresolved sync + multi-remote (3 devices) lossless merge.
        let basePlan = try PersonalWebDavSync.plan(
            local: withNote(try emptyPersonal(), text: "初始共同基线笔记", revision: 1),
            device: mac,
            remote: [:]
        )
        let remoteSeed = [mac: basePlan.upload!]
        let androidPulled = try PersonalWebDavSync.plan(local: try emptyPersonal(), device: android, remote: remoteSeed)
        let tabletPulled = try PersonalWebDavSync.plan(local: try emptyPersonal(), device: tablet, remote: remoteSeed)

        let macConcurrent = try PersonalWebDavSync.plan(
            local: withNote(basePlan.personal, text: "Mac 本机并发推导笔记", revision: 2),
            device: mac,
            remote: remoteSeed
        )
        let androidConcurrent = try PersonalWebDavSync.plan(
            local: withNote(androidPulled.personal, text: "Android 远端并发实验记录", revision: 2),
            device: android,
            remote: remoteSeed
        )
        let tabletConcurrent = try PersonalWebDavSync.plan(
            local: withNote(tabletPulled.personal, text: "Tablet 第三端并发补充推导", revision: 2),
            device: tablet,
            remote: remoteSeed
        )
        let wireObject = try JSONSerialization.jsonObject(with: macConcurrent.upload!) as? [String: Any] ?? [:]
        check(
            "WebDAV wire format and top-level keys remain strictly unchanged",
            wireObject["format"] as? String == "paperdigest-personal-sync-v1" &&
            Set(wireObject.keys) == Set(["format", "device", "revision", "records", "legacySHA256"])
        )

        let conflictHeads = [mac: macConcurrent.upload!, android: androidConcurrent.upload!]
        let conflictPlan = try PersonalWebDavSync.plan(
            local: macConcurrent.personal,
            device: mac,
            remote: conflictHeads
        )
        check("heterogeneous concurrent note increments conflicts", conflictPlan.conflicts == 1)
        check(
            "heterogeneous concurrent note preserves local text in merged personal",
            ((conflictPlan.personal["notes"] as? [String: [String: Any]])?[paperA]?["text"] as? String) == "Mac 本机并发推导笔记"
        )
        check("structured noteConflicts contains exact single snapshot", conflictPlan.noteConflicts.count == 1)
        let detected = conflictPlan.noteConflicts[0]
        check(
            "snapshot records paperID, localNote, remoteNote, remoteDeviceID, remoteRevision",
            detected == NoteConflictSnapshot(
                paperID: paperA,
                localNote: "Mac 本机并发推导笔记",
                remoteNote: "Android 远端并发实验记录",
                remoteDeviceID: android,
                remoteRevision: 1
            )
        )

        // Consecutive second sync while conflict is still unresolved must NOT drop the conflict!
        let secondUnresolvedSync = try PersonalWebDavSync.plan(
            local: conflictPlan.personal,
            device: mac,
            remote: conflictHeads
        )
        check("consecutive sync before user resolution retains unresolved conflict snapshot",
              secondUnresolvedSync.conflicts == 1 && secondUnresolvedSync.noteConflicts == [detected])

        // 3-device concurrent conflict captures primary + additionalRemotes and merges all 3 losslessly!
        let threeWayPlan = try PersonalWebDavSync.plan(
            local: macConcurrent.personal,
            device: mac,
            remote: [mac: macConcurrent.upload!, android: androidConcurrent.upload!, tablet: tabletConcurrent.upload!]
        )
        check("3-device heterogeneous note conflict captures primary and additionalRemotes",
              threeWayPlan.conflicts == 1 &&
              threeWayPlan.noteConflicts.count == 1 &&
              threeWayPlan.noteConflicts[0].additionalRemotes.count == 1)
        let threeWayMerged = try NoteConflictMerger.merge(threeWayPlan.noteConflicts[0], strategy: .mergeBoth)
        check("3-device mergeBoth preserves all three texts and both remote device headers",
              threeWayMerged.contains("Mac 本机并发推导笔记") &&
              threeWayMerged.contains("Android 远端并发实验记录") &&
              threeWayMerged.contains("Tablet 第三端并发补充推导") &&
              threeWayMerged.contains(android) &&
              threeWayMerged.contains(tablet))

        // 3-device where local is empty "" and two remotes wrote distinct non-empty notes!
        let emptyLocalThreeWay = NoteConflictSnapshot(
            paperID: paperA,
            localNote: "",
            remoteNote: "Android 远端并发实验记录",
            remoteDeviceID: android,
            remoteRevision: 2,
            additionalRemotes: [.init(text: "Tablet 第三端并发补充推导", deviceID: tablet, revision: 1)]
        )
        let emptyLocalThreeMerged = try NoteConflictMerger.merge(emptyLocalThreeWay, strategy: .mergeBoth)
        check("empty local + two distinct remotes preserves both remote notes and headers",
              emptyLocalThreeMerged.contains("Android 远端并发实验记录") &&
              emptyLocalThreeMerged.contains("Tablet 第三端并发补充推导") &&
              emptyLocalThreeMerged.contains(android) &&
              emptyLocalThreeMerged.contains(tablet))

        // 3. Pure function merge strategies (keepLocal, adoptRemote, mergeBoth) & idempotency.
        let kept = try NoteConflictMerger.merge(detected, strategy: .keepLocal)
        check("keepLocal strategy returns exact localNote", kept == "Mac 本机并发推导笔记")

        let adopted = try NoteConflictMerger.merge(detected, strategy: .adoptRemote)
        check("adoptRemote strategy returns exact remoteNote", adopted == "Android 远端并发实验记录")

        let both = try NoteConflictMerger.merge(detected, strategy: .mergeBoth)
        check(
            "mergeBoth strategy losslessly preserves both notes and remote provenance",
            both.hasPrefix("Mac 本机并发推导笔记\n\n--- 云端并发版本（设备 \(android) · 版本 1）---\n") &&
            both.hasSuffix("Android 远端并发实验记录")
        )
        let repeatedBoth = try NoteConflictMerger.merge(
            NoteConflictSnapshot(paperID: paperA, localNote: both, remoteNote: detected.remoteNote, remoteDeviceID: android, remoteRevision: 1),
            strategy: .mergeBoth
        )
        check("mergeBoth is idempotent on already-merged conflict section", repeatedBoth == both)
        check("Strategy.parse accepts cross-platform aliases",
              NoteConflictMerger.Strategy.parse("keepLocal") == .keepLocal &&
              NoteConflictMerger.Strategy.parse("KEEP_LOCAL") == .keepLocal &&
              NoteConflictMerger.Strategy.parse("ADOPT_REMOTE") == .adoptRemote &&
              NoteConflictMerger.Strategy.parse("merge_both") == .mergeBoth &&
              NoteConflictMerger.Strategy.parse("truncate") == nil)

        // 4. 2 MiB UTF-8 per-note bound (ASCII + multi-byte UTF-8 CJK without truncation).
        let nearLimitLocal = String(repeating: "甲", count: 400_000) // 1,200,000 UTF-8 bytes
        let nearLimitRemote = String(repeating: "乙", count: 350_000) // 1,050,000 UTF-8 bytes
        let oversizedConflict = NoteConflictSnapshot(
            paperID: paperA,
            localNote: nearLimitLocal,
            remoteNote: nearLimitRemote,
            remoteDeviceID: android,
            remoteRevision: 2
        )
        check("keepLocal under 2 MiB UTF-8 succeeds", (try? NoteConflictMerger.merge(oversizedConflict, strategy: .keepLocal)) == nearLimitLocal)
        expectsThrow("mergeBoth exceeding 2 MiB UTF-8 throws instead of truncating") {
            _ = try NoteConflictMerger.merge(oversizedConflict, strategy: .mergeBoth)
        }
        let over2MiBRemote = NoteConflictSnapshot(
            paperID: paperA,
            localNote: "短笔记",
            remoteNote: String(repeating: "丙", count: 700_000), // 2,100,000 UTF-8 bytes (< 2M chars, > 2 MiB UTF-8!)
            remoteDeviceID: android,
            remoteRevision: 3
        )
        expectsThrow("adoptRemote exceeding 2 MiB UTF-8 CJK bytes throws") {
            _ = try NoteConflictMerger.merge(over2MiBRemote, strategy: .adoptRemote)
        }

        // 5. DesktopStore CAS, localNote consistency guard, ordinary saveNote / restorePersonal cleanup,
        //    incremental recordNoteConflicts duplicate-key safety, and WebDAV causal convergence for ALL 3 strategies!
        let storeDir = tempRoot.appendingPathComponent("store-cas", isDirectory: true)
        let store = try DesktopStore(directory: storeDir)
        try store.restorePersonal(conflictPlan.personal)
        store.reconcileSyncedNoteConflicts(conflictPlan.noteConflicts)
        let personalFile = storeDir.appendingPathComponent("personal.json")
        let diskBeforeReject = try Data(contentsOf: personalFile)
        let currentRev = ((store.snapshot()["notes"] as? [String: [String: Any]])?[paperA]?["revision"] as? Int) ?? 0

        expectsThrow("stale baseRevision CAS rejected during conflict resolution") {
            _ = try store.resolveNoteConflict(paperID: paperA, strategy: .mergeBoth, baseRevision: currentRev + 99)
        }
        check("stale CAS leaves disk bytes unchanged", (try Data(contentsOf: personalFile)) == diskBeforeReject)
        check("stale CAS preserves pending conflict snapshot for retry", store.noteConflict(for: paperA) == detected)

        // Local-note consistency guard: if stored note text differs from conflict.localNote, reject even with matching baseRevision!
        let mismatchedSnapshot = NoteConflictSnapshot(
            paperID: paperA,
            localNote: "过期的旧本机快照文本",
            remoteNote: "Android 远端并发实验记录",
            remoteDeviceID: android,
            remoteRevision: 1
        )
        expectsThrow("NoteConflictMerger.resolve rejects stale conflict.localNote even if baseRevision matches") {
            _ = try NoteConflictMerger.resolve(mismatchedSnapshot, strategy: .keepLocal, baseRevision: currentRev, store: store)
        }
        check("localNote mismatch leaves stored note text untouched",
              ((store.snapshot()["notes"] as? [String: [String: Any]])?[paperA]?["text"] as? String) == "Mac 本机并发推导笔记")

        // Incremental recordNoteConflicts neither traps on duplicate paperID nor wipes unrelated paperB conflict.
        let conflictB = NoteConflictSnapshot(paperID: paperB, localNote: "B 本机", remoteNote: "B 远端", remoteDeviceID: android, remoteRevision: 1)
        store.recordNoteConflicts([conflictB])
        store.recordNoteConflicts([detected, NoteConflictSnapshot(paperID: paperA, localNote: "Mac 本机并发推导笔记", remoteNote: "Android 更新异文", remoteDeviceID: android, remoteRevision: 2)])
        check("recordNoteConflicts handles duplicate paperID without trapping and keeps other paper conflicts",
              store.noteConflicts().count == 2 &&
              store.noteConflict(for: paperB) == conflictB &&
              store.noteConflict(for: paperA)?.remoteRevision == 2)

        // Ordinary saveNote (and clearing note to "") clears only that paper's conflict AFTER save succeeds; failed saveNote preserves it!
        expectsThrow("failed ordinary saveNote (stale CAS) preserves conflict") {
            _ = try store.saveNote(id: paperA, text: "手工编辑失败", baseRevision: currentRev + 50)
        }
        check("failed ordinary saveNote did not clear conflict", store.noteConflict(for: paperA) != nil)
        _ = try store.saveNote(id: paperA, text: "用户直接在编辑器重写保存的新笔记", baseRevision: currentRev)
        check("successful ordinary saveNote clears paperA conflict while keeping paperB",
              store.noteConflict(for: paperA) == nil && store.noteConflict(for: paperB) == conflictB)
        _ = try store.saveNote(id: paperB, text: "", baseRevision: 0)
        check("clearing note via ordinary saveNote also removes paperB conflict", store.noteConflicts().isEmpty)

        // restorePersonal prunes conflicts whose restored note text changed, while preserving unchanged ones (FullWebDavWorkspace compatibility).
        var restoreCandidate = conflictPlan.personal
        var candidateNotes = restoreCandidate["notes"] as? [String: [String: Any]] ?? [:]
        candidateNotes[paperB] = ["text": "B 本机", "revision": 1]
        restoreCandidate["notes"] = candidateNotes
        try store.restorePersonal(restoreCandidate)
        store.recordNoteConflicts([detected, conflictB])
        // Simulate FullWebDavWorkspace.merge updating personalPapers while leaving notes unchanged:
        var workspaceMerged = store.snapshot()
        workspaceMerged["personalPapers"] = [paperA: ["id": paperA, "title": "Synced Paper", "sourceKind": "arxiv"]]
        try store.restorePersonal(workspaceMerged)
        check("restorePersonal with unchanged notes preserves all pending noteConflicts",
              store.noteConflicts().count == 2)
        // Simulate backup restore that changes paperA's note text while keeping paperB's text:
        var backupRestored = workspaceMerged
        var backupNotes = backupRestored["notes"] as! [String: [String: Any]]
        backupNotes[paperA] = ["text": "从旧备份恢复的不同文本", "revision": 1]
        backupRestored["notes"] = backupNotes
        try store.restorePersonal(backupRestored)
        check("restorePersonal prunes conflict whose note text changed while keeping unchanged paperB",
              store.noteConflict(for: paperA) == nil && store.noteConflict(for: paperB) == conflictB)

        // Verify 2 MiB rejection inside DesktopStore.resolveNoteConflict:
        _ = try store.saveNote(id: paperA, text: nearLimitLocal, baseRevision: 1)
        store.reconcileSyncedNoteConflicts([oversizedConflict])
        let revAfterLocal = ((store.snapshot()["notes"] as? [String: [String: Any]])?[paperA]?["revision"] as? Int)!
        let diskBefore2MiB = try Data(contentsOf: personalFile)
        expectsThrow("DesktopStore resolveNoteConflict rejects >2 MiB mergeBoth before writing") {
            _ = try store.resolveNoteConflict(paperID: paperA, strategy: .mergeBoth, baseRevision: revAfterLocal)
        }
        check("2 MiB rejection leaves disk bytes unchanged", (try Data(contentsOf: personalFile)) == diskBefore2MiB)
        check("2 MiB rejection keeps pending conflict snapshot intact", store.noteConflict(for: paperA) == oversizedConflict)

        // End-to-end WebDAV causal convergence across ALL THREE strategies: mergeBoth, keepLocal, adoptRemote!
        for (strategy, expectedFinalText) in [
            (NoteConflictMerger.Strategy.mergeBoth, both),
            (NoteConflictMerger.Strategy.keepLocal, "Mac 本机并发推导笔记"),
            (NoteConflictMerger.Strategy.adoptRemote, "Android 远端并发实验记录")
        ] {
            try store.restorePersonal(conflictPlan.personal)
            store.reconcileSyncedNoteConflicts(conflictPlan.noteConflicts)
            let baseRev = ((store.snapshot()["notes"] as? [String: [String: Any]])?[paperA]?["revision"] as? Int) ?? 0
            let saved = try store.resolveNoteConflict(paperID: paperA, strategy: strategy, baseRevision: baseRev)
            check("\(strategy.rawValue) advances note revision by 1 and clears local conflict",
                  saved["revision"] as? Int == baseRev + 1 && store.noteConflicts().isEmpty)
            let macAfterResolve = try PersonalWebDavSync.plan(
                local: store.snapshot(),
                device: mac,
                remote: conflictHeads
            )
            check("\(strategy.rawValue) produces causal WebDAV upload with 0 conflicts",
                  macAfterResolve.upload != nil && macAfterResolve.conflicts == 0 && macAfterResolve.noteConflicts.isEmpty)
            let androidAfterResolve = try PersonalWebDavSync.plan(
                local: androidConcurrent.personal,
                device: android,
                remote: [mac: macAfterResolve.upload!, android: androidConcurrent.upload!]
            )
            check("\(strategy.rawValue) converges Android peer to exact resolved text with 0 conflicts",
                  androidAfterResolve.conflicts == 0 &&
                  androidAfterResolve.noteConflicts.isEmpty &&
                  ((androidAfterResolve.personal["notes"] as? [String: [String: Any]])?[paperA]?["text"] as? String) == expectedFinalText)
        }

        // 6. Bridge dispatch verification: emits `personal.synced` (NEVER `personal.changed`) and preserves active reading session!
        let bridgeDir = tempRoot.appendingPathComponent("bridge-store", isDirectory: true)
        let app = PaperDigestApp()
        app.directory = bridgeDir
        app.store = try DesktopStore(directory: bridgeDir)
        app.library = try LibraryService(dataDirectory: bridgeDir, seedDirectory: bridgeDir)
        app.model = ModelService(directory: bridgeDir, store: app.store, keyProvider: { nil })
        app.storage = DesktopStorage(directory: bridgeDir, store: app.store)
        let probeWeb = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        app.web = probeWeb
        probeWeb.loadHTMLString("<!doctype html><html><body><script>window.__events=[];for(const n of ['personal.synced','personal.changed'])window.addEventListener(n,()=>window.__events.push(n));</script></body></html>", baseURL: nil)
        for _ in 0..<200 {
            if (try? await probeWeb.evaluateJavaScript("Array.isArray(window.__events)")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        app.currentPaperID = paperA
        app.currentPaper = ["id": paperA, "title": "Active Reading Paper", "sourceKind": "arxiv"]
        let generationBeforeResolve = app.contextGeneration

        _ = try app.store.saveNote(id: paperA, text: "本机版本 A", baseRevision: 0)
        _ = try app.store.saveNote(id: paperB, text: "本机版本 B", baseRevision: 0)
        app.store.recordNoteConflicts([
            NoteConflictSnapshot(paperID: paperA, localNote: "本机版本 A", remoteNote: "云端版本 A", remoteDeviceID: android, remoteRevision: 5),
            NoteConflictSnapshot(paperID: paperB, localNote: "本机版本 B", remoteNote: "云端版本 B", remoteDeviceID: android, remoteRevision: 6)
        ])
        let listed = try await app.dispatch("personal.noteConflicts", payload: [:])
        let listedConflicts = listed["conflicts"] as? [[String: Any]] ?? []
        check("bridge personal.noteConflicts lists sorted conflicts", listedConflicts.count == 2)
        check("bridge personal.noteConflicts enriches baseRevision from stored note",
              listedConflicts.first?["baseRevision"] as? Int == 1 && listedConflicts.last?["baseRevision"] as? Int == 1)
        let singleListed = try await app.dispatch("personal.noteConflicts", payload: ["paperID": paperA])
        check("bridge single-paper personal.noteConflicts enriches baseRevision",
              ((singleListed["conflicts"] as? [[String: Any]])?.first?["baseRevision"] as? Int) == 1)
        await expectsThrowAsync("bridge rejects unknown strategy") {
            _ = try await app.dispatch("personal.resolveNoteConflict", payload: ["paperID": paperA, "strategy": "truncate", "baseRevision": 1])
        }
        await expectsThrowAsync("bridge rejects boolean baseRevision") {
            let badPayload = try JSONSerialization.jsonObject(
                with: Data("{\"paperID\":\"\(paperA)\",\"strategy\":\"keepLocal\",\"baseRevision\":true}".utf8)
            ) as! [String: Any]
            _ = try await app.dispatch("personal.resolveNoteConflict", payload: badPayload)
        }
        let adoptReply = try await app.dispatch(
            "personal.resolveNoteConflict",
            payload: ["paperID": paperA, "strategy": "adoptRemote", "baseRevision": 1]
        )
        check("bridge adoptRemote saves remote text", (adoptReply["note"] as? [String: Any])?["text"] as? String == "云端版本 A")
        check("bridge adoptRemote leaves remaining conflict intact", (adoptReply["conflicts"] as? [[String: Any]])?.count == 1)
        check("bridge resolveNoteConflict preserves currentPaperID and contextGeneration",
              app.currentPaperID == paperA && app.contextGeneration == generationBeforeResolve)

        let keepReply = try await app.dispatch(
            "personal.resolveNoteConflict",
            payload: ["paperID": paperB, "strategy": "keepLocal", "baseRevision": 1]
        )
        check("bridge keepLocal saves local text and empties conflicts",
              (keepReply["note"] as? [String: Any])?["text"] as? String == "本机版本 B" &&
              (keepReply["conflicts"] as? [[String: Any]])?.isEmpty == true)
        try await Task.sleep(nanoseconds: 50_000_000)
        let emittedEvents = (try? await probeWeb.evaluateJavaScript("window.__events")) as? [String] ?? []
        check("bridge emits personal.synced and never emits workspace-resetting personal.changed",
              emittedEvents == ["personal.synced", "personal.synced"] && !emittedEvents.contains("personal.changed"))

        // Dual-CAS WebView payload contract: { paperID, strategy, expectedRevision, expectedLocalNote }
        app.store.recordNoteConflicts([
            NoteConflictSnapshot(paperID: paperA, localNote: "云端版本 A", remoteNote: "再次并发远端 A", remoteDeviceID: tablet, remoteRevision: 7)
        ])
        await expectsThrowAsync("bridge rejects boolean expectedRevision") {
            let badExpectedRev = try JSONSerialization.jsonObject(
                with: Data("{\"paperID\":\"\(paperA)\",\"strategy\":\"merge_both\",\"expectedRevision\":true,\"expectedLocalNote\":\"云端版本 A\"}".utf8)
            ) as! [String: Any]
            _ = try await app.dispatch("personal.resolveNoteConflict", payload: badExpectedRev)
        }
        await expectsThrowAsync("bridge rejects non-string expectedLocalNote") {
            let badExpectedLocal = try JSONSerialization.jsonObject(
                with: Data("{\"paperID\":\"\(paperA)\",\"strategy\":\"merge_both\",\"expectedRevision\":2,\"expectedLocalNote\":123}".utf8)
            ) as! [String: Any]
            _ = try await app.dispatch("personal.resolveNoteConflict", payload: badExpectedLocal)
        }
        await expectsThrowAsync("bridge rejects mismatched expectedLocalNote without clearing conflict") {
            _ = try await app.dispatch(
                "personal.resolveNoteConflict",
                payload: ["paperID": paperA, "strategy": "merge_both", "expectedRevision": 2, "expectedLocalNote": "过期的旧基线文本"]
            )
        }
        check("mismatched expectedLocalNote preserves pending conflict", app.store.noteConflict(for: paperA) != nil)
        let dualCASReply = try await app.dispatch(
            "personal.resolveNoteConflict",
            payload: ["paperID": paperA, "strategy": "merge_both", "expectedRevision": 2, "expectedLocalNote": "云端版本 A"]
        )
        check("bridge dual-CAS merge_both saves merged note at revision 3 and clears conflict",
              (dualCASReply["note"] as? [String: Any])?["revision"] as? Int == 3 &&
              ((dualCASReply["note"] as? [String: Any])?["text"] as? String)?.contains("再次并发远端 A") == true &&
              (dualCASReply["conflicts"] as? [[String: Any]])?.isEmpty == true)

        // 7. 32 MiB personal.json total capacity guard (rolls back memory & preserves disk file).
        let capDir = tempRoot.appendingPathComponent("store-32mib", isDirectory: true)
        let capStore = try DesktopStore(directory: capDir)
        let chunk = String(repeating: "x", count: 1_900_000) // ~1.9 MB <= 2 MiB per note
        for idx in 0..<17 {
            _ = try capStore.saveNote(id: "arxiv:2601.\(String(format: "%05d", idx))", text: chunk, baseRevision: 0)
        }
        let capFile = capDir.appendingPathComponent("personal.json")
        let capDiskBefore = try Data(contentsOf: capFile)
        let capConflict = NoteConflictSnapshot(
            paperID: "arxiv:2601.99999",
            localNote: "",
            remoteNote: chunk,
            remoteDeviceID: android,
            remoteRevision: 1
        )
        capStore.recordNoteConflicts([capConflict])
        expectsThrow("32 MiB personal.json cap rejects oversized total store without corrupting disk") {
            _ = try capStore.resolveNoteConflict(paperID: "arxiv:2601.99999", strategy: .adoptRemote, baseRevision: 0)
        }
        check("32 MiB rejection leaves personal.json bytes untouched", (try Data(contentsOf: capFile)) == capDiskBefore)
        check("32 MiB rejection rolls back in-memory notes", (capStore.snapshot()["notes"] as? [String: [String: Any]])?["arxiv:2601.99999"] == nil)
        check("32 MiB rejection retains conflict snapshot", capStore.noteConflict(for: "arxiv:2601.99999") == capConflict)

        // 8. Regression check for decomposed LibraryService submodules.
        check("LibraryImageTransport keeps SSRF guard", !LibraryService.isPublicAddress("127.0.0.1") && !LibraryService.isPublicAddress("169.254.169.254"))
        check("LibraryImageTransport keeps approved arXiv HTTPS check",
              LibraryService.isApprovedExternalResource(URL(string: "https://arxiv.org/pdf/2610.27491v1.pdf")!))
        let libDir = tempRoot.appendingPathComponent("lib-regression", isDirectory: true)
        let row: [String: Any] = [
            "permalink": "/blog/posts/p1/",
            "pageType": "paper",
            "title": "Modular Library Paper",
            "titleZh": "模块化资料库回归",
            "date": "2026-10-24",
            "score": 8.5,
            "task": "语音合成",
            "method": "流匹配",
            "tags": ["TTS"],
            "sourceKind": "arxiv",
            "identityStatus": "verified",
            "arxivId": "2610.27491",
            "citation": [
                "paperKey": paperA,
                "identityStatus": "verified",
                "verified": true,
                "complete": false,
                "authors": ["Alice"],
                "title": "Modular Library Paper",
                "arxivId": "2610.27491v1",
                "sourceKind": "arxiv",
                "sourceUrl": "https://arxiv.org/abs/2610.27491v1",
                "pdfUrl": "https://arxiv.org/pdf/2610.27491v1.pdf"
            ]
        ]
        let shardBytes = try JSONSerialization.data(withJSONObject: [row], options: [.sortedKeys])
        let shardHash = LibraryService.sha256(shardBytes)
        let shardName = "search-index/part-0001-\(shardHash.prefix(12)).json"
        let manifestBytes = try JSONSerialization.data(withJSONObject: [
            "contract": "paper-search-index-manifest-v1",
            "recordCount": 1,
            "totalBytes": shardBytes.count,
            "shards": [["url": shardName, "sha256": shardHash, "bytes": shardBytes.count, "recordCount": 1]]
        ], options: [.sortedKeys])
        let fixtureMap: [String: Data] = [
            "/blog/index.json": manifestBytes,
            "/blog/" + shardName: shardBytes
        ]
        let lib = try LibraryService(
            dataDirectory: libDir,
            siteBaseURL: URL(string: "https://fixture.example/blog/")!,
            transport: { url, _ in
                if url.path.contains("/client/") { throw LibraryService.ServiceError.httpStatus(404) }
                guard let bytes = fixtureMap[url.path] else { throw LibraryService.ServiceError.httpStatus(404) }
                return bytes
            }
        )
        _ = try await lib.sync()
        let compactList = try await lib.handle(command: "library.list", payload: ["compact": true])
        let compactPaper = (compactList["papers"] as? [[String: Any]])?.first
        let detail = try await lib.handle(command: "library.paperDetail", payload: ["paperID": paperA])
        let tagIdx = try await lib.handle(command: "library.tagIndex", payload: [:])
        check("LibraryCompactProjection omits citation in compact list", compactPaper?["citation"] == nil && compactPaper?["id"] as? String == paperA)
        check("LibraryCompactProjection includes citation in paperDetail", ((detail["paper"] as? [String: Any])?["citation"] as? [String: Any]) != nil)
        check("LibraryCompactProjection builds inherited tagIndex", (tagIdx["count"] as? Int) == 1)

        let samplePaper = await lib.list().first!
        let extracted = try LibraryService.extractArticle(
            "<!doctype html><html><body><div id='article-body' class='post-content'><p>公式：</p><math xmlns='http://www.w3.org/1998/Math/MathML'><semantics><mrow><mi>x</mi></mrow><annotation encoding='application/x-tex'>x_1</annotation></semantics></math></div></body></html>",
            paper: samplePaper,
            pageURL: URL(string: samplePaper.blogURL)!
        )
        check("LibraryArticleExtractor preserves MathML and TeX plainText", extracted.html.contains("<math") && extracted.plainText.contains("\\(x_1\\)"))

        print("NoteConflictMerger: \(passes) checks passed, \(failures.count) failed")
        if !failures.isEmpty { exit(1) }
    }
}
