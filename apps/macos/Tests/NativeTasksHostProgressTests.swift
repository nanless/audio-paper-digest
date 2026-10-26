import AppKit
private struct ProgressFailure:Error{}
@MainActor private final class ProbeIndicator:NSProgressIndicator{
 var starts=0,stops=0
 override func startAnimation(_ sender:Any?){starts+=1;super.startAnimation(sender)}
 override func stopAnimation(_ sender:Any?){stops+=1;super.stopAnimation(sender)}
}
@main @MainActor struct NativeTasksHostProgressTests{
 static func main()throws{
  _=NSApplication.shared;NSApp.setActivationPolicy(.prohibited)
  var passed=0
  func check(_ c:Bool)throws{if !c{throw ProgressFailure()};passed+=1}
  let owner=NativeTaskOwner(windowID:UUID(),documentID:UUID(),contextGeneration:0),route=NativeTaskRouteGate(owner:.init(windowID:UUID(),documentID:UUID(),contextGeneration:0))
  route.replaceOwner(owner)
  var fail=false,actual=false;var probes:[ProbeIndicator]=[]
  let ctrl=NativeTasksController(route:route,provider:{if fail{throw ProgressFailure()};var job:[String:Any]=["id":"synthetic-running","command":"library.sync","status":"running","title":"合成同步","startedAt":"2026-10-25T08:05:03Z"];if actual{job["progress"]=["completed":1,"total":3]};return .init(jobs:[job],sessions:[],liveJobIDs:["synthetic-running"])},callbacks:.init(sourceBound:{_ in .previewOnly}),progressFactory:{let p=ProbeIndicator();probes.append(p);return p})
  _=ctrl.view;try check(probes.allSatisfy{$0.starts==0});print("PASS hidden native controller does not start animation")
  let rect=NativeTaskRectangle(x:220,y:0,width:800,height:600)
  try ctrl.apply(.init(owner:owner,sequence:1,tasks:true,rectangle:rect),allowedContent:rect)
  let displayed=probes.last!;try check(displayed.isIndeterminate && displayed.starts==1 && displayed.stops==0);print("PASS visible running unknown starts public AppKit animation")
  ctrl.reload();let refreshed=probes.last!;try check(displayed.stops==1 && refreshed !== displayed && refreshed.starts==1);print("PASS render replacement stops old indicator")
  ctrl.retire();let stopped=refreshed.stops;ctrl.retire();try check(stopped==1 && refreshed.stops==stopped);print("PASS retire stops and repeated retire is idempotent")
  ctrl.reload();try check(probes.last!.starts==0);print("PASS hidden reload does not restart animation")
  actual=true;try ctrl.apply(.init(owner:owner,sequence:2,tasks:true,rectangle:rect),allowedContent:rect);try check(!probes.last!.isIndeterminate && probes.last!.starts==0);print("PASS measured progress remains actual determinate fraction")
  actual=false;ctrl.reload();let beforeFailure=probes.last!;fail=true;ctrl.reload();try check(beforeFailure.stops==1 && ctrl.readFailed && probes.last!.starts==0);print("PASS read failure stops prior animation and preserves stale-source warning")
  ctrl.retire();try check(NSApp.windows.isEmpty);print("PASS lifecycle unit creates no windows")
  print("RESULT \(passed) passed / 0 failed; public overrides inspect lifecycle only, not actual Main visible animation")
 }
}
