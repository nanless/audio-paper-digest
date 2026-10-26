import Foundation

/// Issued by the native window/document lifecycle, never reconstructed from task-row JSON.
struct NativeTaskOwner: Equatable {
    let windowID: UUID, documentID: UUID
    let contextGeneration: Int
}
struct NativeTaskRectangle: Equatable {
    let x: Double, y: Double, width: Double, height: Double
    var finite: Bool { [x, y, width, height].allSatisfy(\.isFinite) }
    func contains(_ other: Self) -> Bool {
        finite && other.finite && width > 0 && height > 0 && other.width > 0 && other.height > 0 && other.x >= x && other.y >= y && other.x + other.width <= x + width && other.y + other.height <= y + height
    }
}
struct NativeTaskLayout {
    let owner: NativeTaskOwner
    let sequence: Int64
    let tasks: Bool
    let rectangle: NativeTaskRectangle
}
/// A callback is valid only while its exact native presentation is current.
@MainActor final class NativeTaskLease {
    fileprivate let presentation: UUID, owner: NativeTaskOwner, sequence: Int64
    let jobID: String, paperID: String?, action: NativeTaskAction
    fileprivate let fingerprint: String
    fileprivate init(presentation: UUID, owner: NativeTaskOwner, sequence: Int64, row: NativeTaskRow, action: NativeTaskAction) {
        self.presentation = presentation; self.owner = owner; self.sequence = sequence
        self.jobID = row.jobID!; self.paperID = row.paperID; self.action = action; self.fingerprint = row.fingerprint
    }
}
@MainActor final class NativeTaskRouteGate {
    private(set) var owner: NativeTaskOwner
    private(set) var sequence: Int64 = 0
    private(set) var showing = false
    private var presentation = UUID()
    init(owner: NativeTaskOwner) { self.owner = owner }
    func replaceOwner(_ next: NativeTaskOwner) { if next == owner { retire(); return }; owner = next; sequence = 0; showing = false; presentation = UUID() }
    func accept(_ layout: NativeTaskLayout, allowedContent: NativeTaskRectangle) throws {
        guard layout.owner == owner, layout.sequence > sequence, layout.sequence <= 9_007_199_254_740_991 else { throw NativeTaskPresentationError.stale }
        // A newer malformed layout retires the old UI rather than leaving it actionable.
        sequence = layout.sequence; showing = false; presentation = UUID()
        guard !layout.tasks || (allowedContent.contains(layout.rectangle) && layout.rectangle.width >= 150 && layout.rectangle.height >= 100) else { throw NativeTaskPresentationError.invalidLayout }
        showing = layout.tasks
    }
    func retire() { showing = false; presentation = UUID() }
    func issue(row: NativeTaskRow, action: NativeTaskAction) throws -> NativeTaskLease {
        guard showing, row.jobID != nil, row.actions.contains(action) else { throw NativeTaskPresentationError.actionUnavailable }
        return NativeTaskLease(presentation: presentation, owner: owner, sequence: sequence, row: row, action: action)
    }
    func validate(_ lease: NativeTaskLease, current: NativeTaskSnapshot) throws -> NativeTaskRow {
        guard showing, lease.presentation == presentation, lease.owner == owner, lease.sequence == sequence else { throw NativeTaskPresentationError.stale }
        let rows = current.rows.filter { $0.jobID == lease.jobID }
        guard rows.count == 1, rows[0].fingerprint == lease.fingerprint, rows[0].paperID == lease.paperID, rows[0].actions.contains(lease.action) else { throw NativeTaskPresentationError.stale }
        return rows[0]
    }
    func current(_ lease: NativeTaskLease) -> Bool { showing && lease.presentation == presentation && lease.owner == owner && lease.sequence == sequence }
}
