import Foundation
import CoreFoundation

/// Structured in-memory/local snapshot of a heterogeneous concurrent WebDAV note edit.
/// Never alters the remote WebDAV wire protocol or `personal.json` schema.
struct NoteConflictSnapshot: Equatable, Sendable {
    let paperID: String
    let localNote: String
    let remoteNote: String
    let remoteDeviceID: String
    let remoteRevision: Int
    let additionalRemotes: [NoteConflictMerger.RemoteNoteVersion]

    init(
        paperID: String,
        localNote: String,
        remoteNote: String,
        remoteDeviceID: String,
        remoteRevision: Int,
        additionalRemotes: [NoteConflictMerger.RemoteNoteVersion] = []
    ) {
        self.paperID = paperID
        self.localNote = localNote
        self.remoteNote = remoteNote
        self.remoteDeviceID = remoteDeviceID
        self.remoteRevision = remoteRevision
        self.additionalRemotes = additionalRemotes
    }

    var dictionary: [String: Any] {
        var result: [String: Any] = [
            "paperID": paperID,
            "localNote": localNote,
            "remoteNote": remoteNote,
            "remoteDeviceID": remoteDeviceID,
            "remoteRevision": remoteRevision
        ]
        if !additionalRemotes.isEmpty {
            result["additionalRemotes"] = additionalRemotes.map(\.dictionary)
        }
        return result
    }
}

enum NoteConflictMerger {
    static let maxNoteBytes = 2 * 1024 * 1024
    static let maxPersonalBytes = 32 * 1024 * 1024

    struct RemoteNoteVersion: Equatable, Sendable {
        let text: String
        let deviceID: String
        let revision: Int

        var dictionary: [String: Any] {
            [
                "remoteNote": text,
                "remoteDeviceID": deviceID,
                "remoteRevision": revision
            ]
        }
    }

    enum Strategy: String, Sendable, CaseIterable {
        case keepLocal
        case adoptRemote
        case mergeBoth

        static func parse(_ raw: String) -> Strategy? {
            switch raw.trimmingCharacters(in: .whitespacesAndNewlines) {
            case "keepLocal", "KEEP_LOCAL", "keep_local", "keep-local": return .keepLocal
            case "adoptRemote", "ADOPT_REMOTE", "adopt_remote", "adopt-remote": return .adoptRemote
            case "mergeBoth", "MERGE_BOTH", "merge_both", "merge-both": return .mergeBoth
            default: return nil
            }
        }
    }

    static func validPaperID(_ id: String) -> Bool {
        !id.isEmpty && id.utf16.count <= 2048 && !id.hasPrefix("local:")
    }

    static func validDeviceID(_ id: String) -> Bool {
        UUID(uuidString: id)?.uuidString.lowercased() == id
    }

    private static func remoteSection(_ version: RemoteNoteVersion) -> String {
        "--- 云端并发版本（设备 \(version.deviceID) · 版本 \(version.revision)）---\n" + version.text
    }

    /// Pure lossless merge function. Rejects invalid identities or >2 MiB UTF-8 results without truncating.
    static func merge(_ conflict: NoteConflictSnapshot, strategy: Strategy) throws -> String {
        guard validPaperID(conflict.paperID) else {
            throw DesktopError.message("冲突笔记的文献身份无效")
        }
        guard validDeviceID(conflict.remoteDeviceID), conflict.remoteRevision > 0 else {
            throw DesktopError.message("冲突笔记的远端设备身份或版本无效")
        }
        for extra in conflict.additionalRemotes {
            guard validDeviceID(extra.deviceID), extra.revision > 0 else {
                throw DesktopError.message("多端冲突笔记的远端设备身份或版本无效")
            }
        }
        let merged: String
        switch strategy {
        case .keepLocal:
            merged = conflict.localNote
        case .adoptRemote:
            merged = conflict.remoteNote
        case .mergeBoth:
            let primary = RemoteNoteVersion(
                text: conflict.remoteNote,
                deviceID: conflict.remoteDeviceID,
                revision: conflict.remoteRevision
            )
            let allRemotes = [primary] + conflict.additionalRemotes
            var uniqueNonEmptyRemotes: [RemoteNoteVersion] = []
            var seenTexts: Set<String> = [conflict.localNote]
            for remote in allRemotes where !remote.text.isEmpty {
                if seenTexts.insert(remote.text).inserted {
                    uniqueNonEmptyRemotes.append(remote)
                }
            }
            if uniqueNonEmptyRemotes.isEmpty {
                merged = conflict.localNote
            } else if conflict.localNote.isEmpty && uniqueNonEmptyRemotes.count == 1 {
                merged = uniqueNonEmptyRemotes[0].text
            } else {
                var result = conflict.localNote
                for remote in uniqueNonEmptyRemotes {
                    let section = remoteSection(remote)
                    if result.isEmpty {
                        result = section
                    } else if !result.contains("\n\n" + section) && !result.hasPrefix(section) {
                        result += "\n\n" + section
                    }
                }
                merged = result
            }
        }
        guard merged.utf8.count <= maxNoteBytes else {
            throw DesktopError.message("合并后的笔记超过 2 MiB 上限，未截断或覆盖原稿；请精简内容后再保存")
        }
        return merged
    }

    /// Validates local-note consistency against current stored text, UTF-8 note limit (`<= 2 MiB`),
    /// `baseRevision` CAS, and `personal.json <= 32 MiB` atomically through `DesktopStore`.
    @MainActor static func resolve(
        _ conflict: NoteConflictSnapshot,
        strategy: Strategy,
        baseRevision: Int,
        store: DesktopStore
    ) throws -> [String: Any] {
        let currentLocalText = ((store.value["notes"] as? [String: [String: Any]])?[conflict.paperID]?["text"] as? String) ?? ""
        guard currentLocalText == conflict.localNote else {
            throw DesktopError.message("本机笔记原稿已变化，拒绝用旧冲突快照覆盖当前内容；请重新同步或核对最新笔记")
        }
        let merged = try merge(conflict, strategy: strategy)
        return try store.saveNote(id: conflict.paperID, text: merged, baseRevision: baseRevision)
    }
}
