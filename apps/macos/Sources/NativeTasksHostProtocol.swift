import Foundation
import CoreFoundation

struct NativeTaskHostContext: Equatable { let owner: NativeTaskOwner; let paperID:String }
@MainActor struct NativeTaskPresentRequest {
    let nonce:String,clientID:String,paperID:String,sequence:Int64,tasks:Bool,focus:Bool
    init(_ raw:[String:Any]) throws {
        guard Set(raw.keys)==Set(["nonce","clientID","paperID","sequence","tasks","focus"]),let nonce=raw["nonce"] as? String,NativeTaskHostCoordinator.validID(nonce),let clientID=raw["clientID"] as? String,NativeTaskHostCoordinator.validID(clientID),let paperID=NativeTaskProjection.identifier(raw["paperID"],empty:true),let sequence=NativeTaskProjection.integer(raw["sequence"]),sequence>0,let tasks=NativeTaskProjection.bool(raw["tasks"]),let focus=NativeTaskProjection.bool(raw["focus"]) else {throw NativeTaskPresentationError.stale}
        self.nonce=nonce;self.clientID=clientID;self.paperID=paperID;self.sequence=sequence;self.tasks=tasks;self.focus=focus
    }
}
@MainActor struct NativeTaskDOMObservation {
    let clientID:String,tasksVisible:Bool,blocked:Bool,width:Double,height:Double,main:NativeTaskRectangle,toolbar:NativeTaskRectangle,sidebar:NativeTaskRectangle?,tasks:NativeTaskRectangle
    init(_ raw:[String:Any])throws {
        func number(_ value:Any?)->Double?{guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite else{return nil};return n.doubleValue}
        func rect(_ value:Any?)throws->NativeTaskRectangle{guard let d=value as? [String:Any],let x=number(d["x"]),let y=number(d["y"]),let w=number(d["width"]),let h=number(d["height"]) else{throw NativeTaskPresentationError.invalidLayout};return .init(x:x,y:y,width:w,height:h)}
        guard let client=raw["clientID"] as? String,NativeTaskHostCoordinator.validID(client),let visible=NativeTaskProjection.bool(raw["tasksVisible"]),let blocked=NativeTaskProjection.bool(raw["blocked"]),let width=number(raw["width"]),let height=number(raw["height"]),width>0,height>0,let sideVisible=NativeTaskProjection.bool(raw["sidebarVisible"]) else{throw NativeTaskPresentationError.invalidLayout}
        self.clientID=client;self.tasksVisible=visible;self.blocked=blocked;self.width=width;self.height=height;main=try rect(raw["main"]);toolbar=try rect(raw["toolbar"]);tasks=try rect(raw["tasks"]);sidebar=sideVisible ? try rect(raw["sidebar"]):nil
    }
    func geometry(nativeFrame:NativeTaskRectangle,pageZoom:Double)throws->(task:NativeTaskRectangle,allowed:NativeTaskRectangle){
        func close(_ a:Double,_ b:Double)->Bool{abs(a-b)<=0.75}
        let viewport=NativeTaskRectangle(x:0,y:0,width:width,height:height)
        guard nativeFrame.finite,pageZoom.isFinite,pageZoom>0,pageZoom<=5,close(width*pageZoom,nativeFrame.width),close(height*pageZoom,nativeFrame.height),viewport.contains(main),main.contains(toolbar),close(main.y,0),close(main.height,height),close(main.x+main.width,width),close(toolbar.x,main.x),close(toolbar.y,main.y),close(toolbar.width,main.width),toolbar.height>=32,toolbar.height<=160 else{throw NativeTaskPresentationError.invalidLayout}
        if let side=sidebar {guard viewport.contains(side),close(side.x,0),close(side.y,0),close(side.height,height),close(side.x+side.width,main.x),side.width>=100 else{throw NativeTaskPresentationError.invalidLayout}}
        else{guard close(main.x,0) else{throw NativeTaskPresentationError.invalidLayout}}
        let allowed=NativeTaskRectangle(x:main.x,y:toolbar.y+toolbar.height,width:main.width,height:main.y+main.height-toolbar.y-toolbar.height)
        guard tasksVisible,!blocked,allowed.contains(tasks),tasks.width>=150,tasks.height>=100 else{throw NativeTaskPresentationError.invalidLayout}
        func convert(_ r:NativeTaskRectangle)->NativeTaskRectangle{.init(x:nativeFrame.x+r.x*pageZoom,y:nativeFrame.y+nativeFrame.height-(r.y+r.height)*pageZoom,width:r.width*pageZoom,height:r.height*pageZoom)}
        return (convert(tasks),convert(allowed))
    }
}
/// A private instance issued only after this Host reserves the current UI request. It grants no Core authorization.
@MainActor final class NativeTaskHostTicket {
    fileprivate let id=UUID(),context:NativeTaskHostContext
    let request:NativeTaskPresentRequest
    fileprivate init(_ request:NativeTaskPresentRequest,_ context:NativeTaskHostContext){self.request=request;self.context=context}
}
@MainActor struct NativeTaskHostInvocation {
    fileprivate let context:NativeTaskHostContext,nonce:String,sequence:Int64
}
@MainActor final class NativeTaskHostCoordinator {
    private(set) var context:NativeTaskHostContext
    private(set) var highestSequence:Int64=0
    private var clientID:String?,nonce:String?,pending:UUID?,acceptedSequence:Int64=0,showing=false
    init(context:NativeTaskHostContext){self.context=context}
    static func validID(_ value:String)->Bool{UUID(uuidString:value) != nil && value==value.lowercased() && value.utf8.count==36}
    static func sourceAllowed(isMainView:Bool,isMainFrame:Bool,url:URL?)->Bool{guard isMainView,isMainFrame,let u=url else{return false};return u.scheme=="paperapp" && u.host=="app" && u.path=="/index.html" && u.user==nil && u.password==nil && u.port==nil && u.query==nil && u.fragment==nil}
    var nonceForDisplay:String{nonce ?? ""}
    var clientForDisplay:String{clientID ?? ""}
    func replaceContext(_ next:NativeTaskHostContext){guard next != context else{return};context=next;clientID=nil;nonce=nil;highestSequence=0;retire()}
    func retire(){pending=nil;showing=false;acceptedSequence=0}
    func bootstrap(client:String,paperID:String,observedClient:String,current:NativeTaskHostContext)throws->[String:Any]{
        guard current==context,paperID==context.paperID,Self.validID(client),observedClient==client,clientID==nil || clientID==client else{throw NativeTaskPresentationError.stale}
        clientID=client;if nonce==nil{nonce=UUID().uuidString.lowercased()}
        return ["nonce":nonce!,"highestSequence":highestSequence]
    }
    func reserve(_ request:NativeTaskPresentRequest,current:NativeTaskHostContext)throws->NativeTaskHostTicket{
        guard current==context,request.paperID==context.paperID,request.nonce==nonce,request.clientID==clientID,request.sequence>highestSequence else{throw NativeTaskPresentationError.stale}
        highestSequence=request.sequence;showing=false;let ticket=NativeTaskHostTicket(request,context);pending=ticket.id;return ticket
    }
    func finish(_ ticket:NativeTaskHostTicket,current:NativeTaskHostContext,observation:NativeTaskDOMObservation?,nativeFrame:NativeTaskRectangle,pageZoom:Double)throws->(layout:NativeTaskLayout,allowed:NativeTaskRectangle)?{
        guard current==context,ticket.context==context,ticket.id==pending,ticket.request.sequence==highestSequence,ticket.request.nonce==nonce,ticket.request.clientID==clientID else{throw NativeTaskPresentationError.stale}
        if !ticket.request.tasks {pending=nil;showing=false;acceptedSequence=ticket.request.sequence;return nil}
        guard let observation,observation.clientID==clientID else{retire();throw NativeTaskPresentationError.stale}
        do{let g=try observation.geometry(nativeFrame:nativeFrame,pageZoom:pageZoom);pending=nil;showing=true;acceptedSequence=ticket.request.sequence;return(.init(owner:context.owner,sequence:ticket.request.sequence,tasks:true,rectangle:g.task),g.allowed)}catch{retire();throw error}
    }
    func isLatest(_ ticket:NativeTaskHostTicket,current:NativeTaskHostContext)->Bool{current==context && ticket.context==context && ticket.request.nonce==nonce && ticket.request.clientID==clientID && ticket.request.sequence==highestSequence}
    func invocation()throws->NativeTaskHostInvocation{guard showing,pending==nil,acceptedSequence==highestSequence,let nonce else{throw NativeTaskPresentationError.stale};return .init(context:context,nonce:nonce,sequence:acceptedSequence)}
    func requireCurrent(_ token:NativeTaskHostInvocation,current:NativeTaskHostContext)throws{guard current==context,token.context==context,token.nonce==nonce,token.sequence==highestSequence,token.sequence==acceptedSequence,showing,pending==nil else{throw NativeTaskPresentationError.stale}}
}
