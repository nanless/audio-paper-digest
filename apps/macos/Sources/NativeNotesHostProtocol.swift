import Foundation
import CoreFoundation

struct NativeNotesLayout { let owner:NativeTaskOwner;let sequence:Int64;let notes:Bool;let rectangle:NativeTaskRectangle }

struct NativeNotesHostContext: Equatable { let owner: NativeTaskOwner; let paperID:String }
@MainActor struct NativeNotesPresentRequest {
    let nonce:String,clientID:String,paperID:String,sequence:Int64,notes:Bool,focus:Bool
    let focusIntent:String?
    init(_ raw:[String:Any]) throws {
        guard (Set(raw.keys)==Set(["nonce","clientID","paperID","sequence","notes","focus"]) || Set(raw.keys)==Set(["nonce","clientID","paperID","sequence","notes","focus","focusIntent"])),let nonce=raw["nonce"] as? String,NativeNotesHostCoordinator.validID(nonce),let clientID=raw["clientID"] as? String,NativeNotesHostCoordinator.validID(clientID),let paperID=NativeTaskProjection.identifier(raw["paperID"],empty:true),let sequence=NativeTaskProjection.integer(raw["sequence"]),sequence>0,let notes=NativeTaskProjection.bool(raw["notes"]),let focus=NativeTaskProjection.bool(raw["focus"]) else {throw NativeNotesError.stale}
        self.nonce=nonce;self.clientID=clientID;self.paperID=paperID;self.sequence=sequence;self.notes=notes;self.focus=focus
        guard focus || raw["focusIntent"]==nil else{throw NativeNotesError.stale}
        self.focusIntent=focus ? (raw["focusIntent"] as? String).flatMap{NativeNotesHostCoordinator.validID($0) ? $0:nil}:nil
    }
    func permitsInitialFocus(_ observation:NativeNotesDOMObservation?)->Bool{guard focus,let focusIntent else{return false};return observation?.focusIntent==focusIntent}
}
@MainActor struct NativeNotesDOMObservation {
    let clientID:String,notesVisible:Bool,blocked:Bool,width:Double,height:Double,main:NativeTaskRectangle,toolbar:NativeTaskRectangle,sidebar:NativeTaskRectangle?,notes:NativeTaskRectangle
    let focusIntent:String?
    init(_ raw:[String:Any])throws {
        func number(_ value:Any?)->Double?{guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite else{return nil};return n.doubleValue}
        func rect(_ value:Any?)throws->NativeTaskRectangle{guard let d=value as? [String:Any],let x=number(d["x"]),let y=number(d["y"]),let w=number(d["width"]),let h=number(d["height"]) else{throw NativeNotesError.invalidLayout};return .init(x:x,y:y,width:w,height:h)}
        guard let client=raw["clientID"] as? String,NativeNotesHostCoordinator.validID(client),let visible=NativeTaskProjection.bool(raw["notesVisible"]),let blocked=NativeTaskProjection.bool(raw["blocked"]),let width=number(raw["width"]),let height=number(raw["height"]),width>0,height>0,let sideVisible=NativeTaskProjection.bool(raw["sidebarVisible"]) else{throw NativeNotesError.invalidLayout}
        focusIntent=(raw["focusIntent"] as? String).flatMap{NativeNotesHostCoordinator.validID($0) ? $0:nil}
        self.clientID=client;self.notesVisible=visible;self.blocked=blocked;self.width=width;self.height=height;main=try rect(raw["main"]);toolbar=try rect(raw["toolbar"]);notes=try rect(raw["notes"]);sidebar=sideVisible ? try rect(raw["sidebar"]):nil
    }
    func geometry(nativeFrame:NativeTaskRectangle,pageZoom:Double)throws->(notes:NativeTaskRectangle,allowed:NativeTaskRectangle){
        func close(_ a:Double,_ b:Double)->Bool{abs(a-b)<=0.75}
        let viewport=NativeTaskRectangle(x:0,y:0,width:width,height:height)
        guard nativeFrame.finite,pageZoom.isFinite,pageZoom>0,pageZoom<=5,close(width*pageZoom,nativeFrame.width),close(height*pageZoom,nativeFrame.height),viewport.contains(main),main.contains(toolbar),close(main.y,0),close(main.height,height),close(main.x+main.width,width),close(toolbar.x,main.x),close(toolbar.y,main.y),close(toolbar.width,main.width),toolbar.height>=32,toolbar.height<=160 else{throw NativeNotesError.invalidLayout}
        if let side=sidebar {guard viewport.contains(side),close(side.x,0),close(side.y,0),close(side.height,height),close(side.x+side.width,main.x),side.width>=100 else{throw NativeNotesError.invalidLayout}}
        else{guard close(main.x,0) else{throw NativeNotesError.invalidLayout}}
        let allowed=NativeTaskRectangle(x:main.x,y:toolbar.y+toolbar.height,width:main.width,height:main.y+main.height-toolbar.y-toolbar.height)
        guard notesVisible,!blocked,allowed.contains(notes),notes.width>=150,notes.height>=100 else{throw NativeNotesError.invalidLayout}
        func convert(_ r:NativeTaskRectangle)->NativeTaskRectangle{.init(x:nativeFrame.x+r.x*pageZoom,y:nativeFrame.y+nativeFrame.height-(r.y+r.height)*pageZoom,width:r.width*pageZoom,height:r.height*pageZoom)}
        return (convert(notes),convert(allowed))
    }
}
/// A private instance issued only after this Host reserves the current UI request. It grants no Core authorization.
@MainActor final class NativeNotesHostTicket {
    fileprivate let id=UUID(),context:NativeNotesHostContext
    let request:NativeNotesPresentRequest
    fileprivate init(_ request:NativeNotesPresentRequest,_ context:NativeNotesHostContext){self.request=request;self.context=context}
}
@MainActor struct NativeNotesHostInvocation {
    fileprivate let context:NativeNotesHostContext,nonce:String,sequence:Int64
}
@MainActor final class NativeNotesHostCoordinator {
    private(set) var context:NativeNotesHostContext
    private(set) var highestSequence:Int64=0
    private var clientID:String?,nonce:String?,pending:UUID?,acceptedSequence:Int64=0,showing=false
    init(context:NativeNotesHostContext){self.context=context}
    static func validID(_ value:String)->Bool{UUID(uuidString:value) != nil && value==value.lowercased() && value.utf8.count==36}
    static func sourceAllowed(isMainView:Bool,isMainFrame:Bool,url:URL?)->Bool{guard isMainView,isMainFrame,let u=url else{return false};return u.scheme=="paperapp" && u.host=="app" && u.path=="/index.html" && u.user==nil && u.password==nil && u.port==nil && u.query==nil && u.fragment==nil}
    var nonceForDisplay:String{nonce ?? ""}
    var clientForDisplay:String{clientID ?? ""}
    func replaceContext(_ next:NativeNotesHostContext){guard next != context else{return};context=next;clientID=nil;nonce=nil;highestSequence=0;retire()}
    func retire(){pending=nil;showing=false;acceptedSequence=0}
    func bootstrap(client:String,paperID:String,observedClient:String,current:NativeNotesHostContext)throws->[String:Any]{
        guard current==context,paperID==context.paperID,Self.validID(client),observedClient==client,clientID==nil || clientID==client else{throw NativeNotesError.stale}
        clientID=client;if nonce==nil{nonce=UUID().uuidString.lowercased()}
        return ["nonce":nonce!,"highestSequence":highestSequence]
    }
    func reserve(_ request:NativeNotesPresentRequest,current:NativeNotesHostContext)throws->NativeNotesHostTicket{
        guard current==context,request.paperID==context.paperID,request.nonce==nonce,request.clientID==clientID,request.sequence>highestSequence else{throw NativeNotesError.stale}
        highestSequence=request.sequence;showing=false;let ticket=NativeNotesHostTicket(request,context);pending=ticket.id;return ticket
    }
    func finish(_ ticket:NativeNotesHostTicket,current:NativeNotesHostContext,observation:NativeNotesDOMObservation?,nativeFrame:NativeTaskRectangle,pageZoom:Double)throws->(layout:NativeNotesLayout,allowed:NativeTaskRectangle)?{
        guard current==context,ticket.context==context,ticket.id==pending,ticket.request.sequence==highestSequence,ticket.request.nonce==nonce,ticket.request.clientID==clientID else{throw NativeNotesError.stale}
        if !ticket.request.notes {pending=nil;showing=false;acceptedSequence=ticket.request.sequence;return nil}
        guard let observation,observation.clientID==clientID else{retire();throw NativeNotesError.stale}
        do{let g=try observation.geometry(nativeFrame:nativeFrame,pageZoom:pageZoom);pending=nil;showing=true;acceptedSequence=ticket.request.sequence;return(.init(owner:context.owner,sequence:ticket.request.sequence,notes:true,rectangle:g.notes),g.allowed)}catch{retire();throw error}
    }
    func isLatest(_ ticket:NativeNotesHostTicket,current:NativeNotesHostContext)->Bool{current==context && ticket.context==context && ticket.request.nonce==nonce && ticket.request.clientID==clientID && ticket.request.sequence==highestSequence}
    func invocation()throws->NativeNotesHostInvocation{guard showing,pending==nil,acceptedSequence==highestSequence,let nonce else{throw NativeNotesError.stale};return .init(context:context,nonce:nonce,sequence:acceptedSequence)}
    func requireCurrent(_ token:NativeNotesHostInvocation,current:NativeNotesHostContext)throws{guard current==context,token.context==context,token.nonce==nonce,token.sequence==highestSequence,token.sequence==acceptedSequence,showing,pending==nil else{throw NativeNotesError.stale}}
}
