import Foundation
import CryptoKit

enum NativeNotesError:Error { case unavailable,stale,invalidLayout }
struct NativeNotesRow:Equatable {
    let paperID:String,title:String,preview:String,time:String,fingerprint:String
    let annotationCount:Int
}
struct NativeNotesSnapshot {
    let rows:[NativeNotesRow]
    func page(_ requested:Int)->(rows:[NativeNotesRow],index:Int,count:Int,total:Int) {
        let count=max(1,(rows.count+19)/20),index=max(0,min(requested,count-1))
        return (Array(rows.dropFirst(index*20).prefix(20)),index,count,rows.count)
    }
}
/// Read-only projection. Exact source records bind callbacks; previews never replace original note text.
@MainActor enum NativeNotesProjection {
    static func make(_ value:[String:Any])throws->NativeNotesSnapshot {
        guard let notes=value["notes"] as? [String:[String:Any]],let marks=value["annotations"] as? [String:[[String:Any]]],
              value["personalPapers"]==nil || value["personalPapers"] is [String:[String:Any]] else{throw NativeNotesError.unavailable}
        let papers=value["personalPapers"] as? [String:[String:Any]] ?? [:]
        let ids=Set(notes.keys).union(marks.keys)
        guard ids.count<=100000 else{throw NativeNotesError.unavailable}
        var ordered:[(date:String,row:NativeNotesRow)]=[]
        for id in ids {
            guard NativeTaskProjection.identifier(id) != nil else{throw NativeNotesError.unavailable}
            let note=notes[id] ?? [:],annotations=marks[id] ?? []
            if notes[id] != nil {guard note["text"] is String,NativeTaskProjection.integer(note["revision"]) != nil else{throw NativeNotesError.unavailable}}
            let text=note["text"] as? String ?? ""
            guard !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || !annotations.isEmpty else{continue}
            let paper=papers[id]
            if let paper {guard paper["id"] as? String==id else{throw NativeNotesError.unavailable}}
            let title=NativeTaskProjection.text(paper?["titleZh"],limit:512) ?? NativeTaskProjection.text(paper?["title"],limit:512) ?? id
            let date=note["updatedAt"] as? String ?? annotations.last?["updatedAt"] as? String ?? ""
            let preview=text.isEmpty ? (annotations.first?["comment"] as? String ?? annotations.first?["text"] as? String ?? "") : text
            let original:[String:Any]=["paperID":id,"note":note,"annotations":annotations,"paper":paper ?? [:]]
            guard JSONSerialization.isValidJSONObject(original) else{throw NativeNotesError.unavailable}
            let bytes=try JSONSerialization.data(withJSONObject:original,options:[.sortedKeys])
            let fingerprint=SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined()
            ordered.append((date,.init(paperID:id,title:title,preview:String(preview.prefix(180)),time:NativeTaskProjection.time(date),fingerprint:fingerprint,annotationCount:annotations.count)))
        }
        ordered.sort{$0.date==$1.date ? $0.row.paperID<$1.row.paperID:$0.date>$1.date}
        return .init(rows:ordered.map(\.row))
    }
}

@MainActor final class NativeNotesLease {
    fileprivate let presentation:UUID,owner:NativeTaskOwner,sequence:Int64
    let row:NativeNotesRow
    fileprivate init(presentation:UUID,owner:NativeTaskOwner,sequence:Int64,row:NativeNotesRow){self.presentation=presentation;self.owner=owner;self.sequence=sequence;self.row=row}
}
@MainActor final class NativeNotesRouteGate {
    private(set) var owner:NativeTaskOwner
    private(set) var sequence:Int64=0,showing=false
    private var presentation=UUID()
    init(owner:NativeTaskOwner){self.owner=owner}
    func replaceOwner(_ next:NativeTaskOwner){guard next != owner else{return};owner=next;sequence=0;retire()}
    func accept(_ layout:NativeNotesLayout,allowed:NativeTaskRectangle)throws {
        guard layout.owner==owner,layout.sequence>sequence,layout.sequence<=9_007_199_254_740_991 else{throw NativeNotesError.stale}
        sequence=layout.sequence;retire()
        guard !layout.notes || (allowed.contains(layout.rectangle) && layout.rectangle.width>=150 && layout.rectangle.height>=100) else{throw NativeNotesError.invalidLayout}
        showing=layout.notes
    }
    func retire(){showing=false;presentation=UUID()}
    func renewPresentation(){presentation=UUID()}
    func issue(_ row:NativeNotesRow)throws->NativeNotesLease{guard showing else{throw NativeNotesError.stale};return .init(presentation:presentation,owner:owner,sequence:sequence,row:row)}
    func current(_ lease:NativeNotesLease)->Bool{showing && lease.presentation==presentation && lease.owner==owner && lease.sequence==sequence}
    func validate(_ lease:NativeNotesLease,snapshot:NativeNotesSnapshot)throws {
        guard current(lease),snapshot.rows.filter({$0.paperID==lease.row.paperID}) == [lease.row] else{throw NativeNotesError.stale}
    }
}
