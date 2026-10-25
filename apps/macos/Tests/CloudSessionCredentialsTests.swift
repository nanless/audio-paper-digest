import AppKit

private actor SessionProbe {
 var loads=0,requests=0
 let password:String
 var files:[String:Data]=[:]
 init(_ password:String){self.password=password}
 func load()->String?{loads+=1;return "persistent-fixture"}
 func counts()->(Int,Int){(loads,requests)}
 func request(_ r:URLRequest,_ limit:Int)throws->CloudArchiveService.Response {
  requests+=1
  guard let url=r.url,url.host=="dav.jianguoyun.com" else{throw DesktopError.message("Fixture forbids real destinations")}
  let expected="Basic "+Data(("fixture@example.test:"+password).utf8).base64EncodedString(),path=url.path
  func reply(_ status:Int,_ data:Data=Data())->CloudArchiveService.Response{.init(data:data,response:HTTPURLResponse(url:url,statusCode:status,httpVersion:"HTTP/1.1",headerFields:[:])!)}
  guard r.value(forHTTPHeaderField:"Authorization")==expected else{return reply(401)}
  switch r.httpMethod {
  case "PROPFIND":return reply(207,Data("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>\(path)</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>".utf8))
  case "MKCOL":return reply(201)
  case "PUT":guard r.value(forHTTPHeaderField:"If-None-Match")=="*",let bytes=r.httpBody else{throw DesktopError.message("Expected immutable fixture PUT")};if files[path] != nil{return reply(412)};files[path]=bytes;return reply(201)
  case "GET":if let data=files[path]{guard data.count<=limit else{throw DesktopError.message("Fixture bound")};return reply(200,data)};return reply(404)
  default:throw DesktopError.message("Unexpected fixture method")
  }
 }
}
private actor HeldSessionResponse {
 private var ready=false
 private var arrivals:[CheckedContinuation<Void,Never>]=[]
 private var completion:CheckedContinuation<Void,Never>?
 func waitUntilRequested()async{if ready{return};await withCheckedContinuation{arrivals.append($0)}}
 func release(){completion?.resume();completion=nil}
 func respond(_ r:URLRequest)async->CloudArchiveService.Response{
  ready=true;for a in arrivals{a.resume()};arrivals=[]
  await withCheckedContinuation{completion=$0}
  let url=r.url!,path=URLComponents(url:url,resolvingAgainstBaseURL:false)!.path
  return .init(data:Data("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>\(path)</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>".utf8),response:HTTPURLResponse(url:url,statusCode:200+7,httpVersion:"HTTP/1.1",headerFields:[:])!)
 }
}
private actor FocusCredentialGate {
 var continuation:CheckedContinuation<CloudArchiveService.Credentials?,Never>?
 var entered=false
 var signal:CheckedContinuation<Void,Never>?
 func wait()async->CloudArchiveService.Credentials? {entered=true;signal?.resume();signal=nil;return await withCheckedContinuation{continuation=$0}}
 func waitForEntry()async{if entered{return};await withCheckedContinuation{signal=$0}}
 func release(){continuation?.resume(returning:nil);continuation=nil}
}
private actor FocusCredentialCounters {
 var current=true,reads=0
 func load()->String?{reads+=1;return "synthetic-persistent-fixture"}
 func retarget(){current=false}
}
@main struct CloudSessionCredentialsTests {
 static func main(){_=NSApplication.shared;NSApp.setActivationPolicy(.prohibited);Task{@MainActor in do{try await run();exit(0)}catch{fputs("FAIL Cloud session focused test\n",stderr);exit(1)}};NSApplication.shared.run()}
 @MainActor static func run() async throws {
  var failures=0,passed=0
  func check(_ value:Bool,_ label:String){if value{passed+=1;print("PASS "+label)}else{failures+=1;print("FAIL "+label)}}
  func rejects(_ label:String,_ operation:()async throws->Void)async {do{try await operation();check(false,label)}catch{check(true,label)}}
  let fm=FileManager.default,root=fm.temporaryDirectory.appendingPathComponent("cloud-session-focused-"+UUID().uuidString)
  try fm.createDirectory(at:root,withIntermediateDirectories:true);var apps:[PaperDigestApp]=[]
  defer{for a in apps{a.cloudSchedule?.invalidate();a.schedule?.invalidate()};try?fm.removeItem(at:root)}
  func make(_ name:String,_ password:String="memory-fixture")throws->(PaperDigestApp,CloudLocalStore,SessionProbe){
   let app=PaperDigestApp();app.directory=root.appendingPathComponent(name).appendingPathComponent("Research");app.store=try DesktopStore(directory:app.directory)
   let local=try app.cloudLocalStore();try local.save(account:"fixture@example.test",folder:"PaperDigest",automatic:true,intervalHours:24)
   let probe=SessionProbe(password);app.cloudVaultLoadOverride={_ in await probe.load()};app.cloudServiceTransportOverride={r,l in try await probe.request(r,l)};apps.append(app);return(app,local,probe)
  }
  func target(_ local:CloudLocalStore)->CloudSessionCredentials.Target{.init(destination:local.profile.destinationID,account:local.profile.account)}
  func prompt(_ app:PaperDigestApp,_ text:String)->()->Bool{
   var field:NSSecureTextField?;app.cloudPasswordPrompt={_,secure in field=secure;secure.stringValue=text;return .alertFirstButtonReturn};return{field?.stringValue.isEmpty==true}
  }
  let(app,local,probe)=try make("base")
  let before=try Data(contentsOf:app.directory.appendingPathComponent("personal.json"))
  check(try app.cloudState()["sessionPasswordAvailable"] as? Bool == false,"state explicitly distinguishes absent memory credential without reading a vault")
  do{_=try await app.dispatchCloud("cloud.clearSessionPassword",payload:[:]);check(local.profile.automaticPaused==true&&app.cloudAutomaticPausedInMemory,"clear memory password is local and pauses automatic backup")}catch{check(false,"clear memory password is local and pauses automatic backup")}
  check(try Data(contentsOf:app.directory.appendingPathComponent("personal.json"))==before,"local credential actions do not write research, jobs or model materials")
  let fieldCleared=prompt(app,"memory-fixture")
  _=try await app.dispatchCloud("cloud.setSessionPassword",payload:[:]);check(fieldCleared(),"secure input field is cleared after memory adoption")
  check(local.profile.automaticPaused==true&&app.cloudAutomaticPausedInMemory,"memory installation durably pauses automatic before use")
  check(try app.cloudState()["sessionPasswordVerified"] as? Bool == false,"memory installation does not claim a checked connection")
  _=try await app.dispatchCloud("cloud.check",payload:[:]);let first=await probe.counts()
  check(first.0==0&&first.1==1,"actual session-first service probe uses exact memory password and zero vault loads")
  check(local.profile.automaticPaused==true&&app.cloudAutomaticPermitted(profile:local.profile),"verified current process may run automatic while durable cold-start state stays paused")
  let stateData=try JSONSerialization.data(withJSONObject:app.cloudState()),profileData=try Data(contentsOf:local.root.appendingPathComponent("profile.json"))
  check(!String(decoding:stateData,as:UTF8.self).contains("memory-fixture") && !String(decoding:profileData,as:UTF8.self).contains("memory-fixture"),"neither bridge state nor profile serializes memory password")
  let oldService=try app.cloudService(),oldGeneration=app.cloudSessionCredentials.generation
  var cancelField:NSSecureTextField?;app.cloudPasswordPrompt={_,field in cancelField=field;field.stringValue="replacement-never-adopted";return .alertSecondButtonReturn}
  await rejects("native prompt cancellation preserves original lease"){_=try await app.dispatchCloud("cloud.setSessionPassword",payload:[:])}
  check(app.cloudSessionCredentials.generation==oldGeneration&&cancelField?.stringValue.isEmpty==true,"cancel clears secure field but does not retire the original generation")
  await rejects("secret fields in web payload are rejected before any prompt"){_=try await app.dispatchCloud("cloud.setSessionPassword",payload:["password":"forbidden-web-value"])}
  app.cloudBusy=true;await rejects("busy operation forbids replacement"){_=try await app.dispatchCloud("cloud.setSessionPassword",payload:[:])};await rejects("busy operation forbids clearing active credential"){_=try await app.dispatchCloud("cloud.clearSessionPassword",payload:[:])};app.cloudBusy=false
  app.maintenanceBusy=true;await rejects("maintenance forbids memory mutation"){_=try await app.dispatchCloud("cloud.setSessionPassword",payload:[:])};app.maintenanceBusy=false
  app.terminationPending=true;await rejects("termination forbids memory mutation"){_=try await app.dispatchCloud("cloud.setSessionPassword",payload:[:])};app.terminationPending=false
  _=try await app.dispatchCloud("cloud.clearSessionPassword",payload:[:]);await rejects("a held service cannot reuse a retired memory lease"){try await oldService.probe()}
  check((await probe.counts()).0==0&&local.profile.automaticPaused==true,"clear and stale service never fall through to Keychain")
  let(cold,coldLocal,coldProbe)=try make("cold")
  try coldLocal.pauseAutomatic(true);let coldCounts=await coldProbe.counts();check(!cold.cloudAutomaticPermitted(profile:coldLocal.profile)&&coldCounts.0==0,"fresh process has no memory credential and cannot bypass durable pause")
  let(persist,persistLocal,persistProbe)=try make("persistent","persistent-fixture")
  try await persist.cloudService().probe();check((await persistProbe.counts()).0==1,"unchanged persistent mode retains the explicit vault loader path")
  let stalePersistent=try persist.cloudService();_=prompt(persist,"memory-fixture");_=try await persist.dispatchCloud("cloud.setSessionPassword",payload:[:]);await rejects("memory replacement retires a previously cached persistent service"){try await stalePersistent.probe()}
  var saved=0;persist.cloudVaultSaveOverride={_,_ in saved+=1};_=prompt(persist,"new-persistent-fixture");_=try await persist.dispatchCloud("cloud.setPassword",payload:[:]);check(saved==1 && !persist.cloudSessionCredentials.available(for:target(persistLocal)),"successful persistent save retires the memory password")
  try persist.cloudSessionCredentials.install("memory-fixture",for:target(persistLocal));let beforeFailedSave=persist.cloudSessionCredentials.generation;persist.cloudVaultSaveOverride={_,_ in throw DesktopError.message("Synthetic save failure")};_=prompt(persist,"not-saved")
  await rejects("failed persistent save leaves existing memory intact"){_=try await persist.dispatchCloud("cloud.setPassword",payload:[:])};check(persist.cloudSessionCredentials.generation==beforeFailedSave,"failed persistent save cannot retire the original generation")
  persist.cloudVaultRemoveOverride={_ in throw DesktopError.message("Synthetic remove failure")};let kept=persist.cloudSessionCredentials.generation
  await rejects("failed persistent removal preserves existing memory generation"){_=try await persist.dispatchCloud("cloud.deletePassword",payload:[:])};check(persist.cloudSessionCredentials.generation==kept,"failed removal does not silently retire memory")
  persist.cloudVaultRemoveOverride={_ in};_=try await persist.dispatchCloud("cloud.deletePassword",payload:[:]);check(!persist.cloudSessionCredentials.available(for:target(persistLocal))&&persist.cloudAutomaticPausedInMemory,"successful persistent removal clears memory before future work")
  let(aba,abaLocal,abaProbe)=try make("aba");try aba.cloudSessionCredentials.install("memory-fixture",for:target(abaLocal));let originalTarget=target(abaLocal)
  aba.cloudPasswordPrompt={_,field in aba.cloudSessionCredentials.clear();try!aba.cloudSessionCredentials.install("retained-fixture",for:originalTarget);field.stringValue="late-never-adopted";return .alertFirstButtonReturn}
  await rejects("same-target ABA generation rejects late native prompt"){_=try await aba.dispatchCloud("cloud.setSessionPassword",payload:[:])};check((await abaProbe.counts()).0==0,"ABA never touches vault")
  let(retarget,retargetLocal,retargetProbe)=try make("retarget");try retarget.cloudSessionCredentials.install("memory-fixture",for:target(retargetLocal));let retainedService=try retarget.cloudService()
  _=try await retarget.dispatchCloud("cloud.save",payload:["account":"other@example.test","folder":"PaperDigest","automatic":true,"intervalHours":24]);check(retargetLocal.profile.automaticPaused==true && !retarget.cloudSessionCredentials.available(for:target(retargetLocal)),"retarget clears memory and preserves durable automatic pause")
  await rejects("old-target service cannot load credentials after retarget"){try await retainedService.probe()};check((await retargetProbe.counts()).0==0,"retarget stale service has zero vault access")
  let(failed,failedLocal,_)=try make("pause-failure");try failed.cloudSessionCredentials.install("retained-fixture",for:target(failedLocal));let prior=failed.cloudSessionCredentials.generation;let pf=failedLocal.root.appendingPathComponent("profile.json");try fm.moveItem(at:pf,to:failedLocal.root.appendingPathComponent("original-profile.json"));try fm.createDirectory(at:pf,withIntermediateDirectories:false);_=prompt(failed,"new-never-adopted")
  await rejects("durable pause failure refuses adoption of a new memory secret"){_=try await failed.dispatchCloud("cloud.setSessionPassword",payload:[:])};check(failed.cloudSessionCredentials.generation==prior,"failed durable pause keeps original lease rather than installing unrecorded state")
  await rejects("clear reports persistence failure honestly"){_=try await failed.dispatchCloud("cloud.clearSessionPassword",payload:[:])};check(!failed.cloudSessionCredentials.available(for:target(failedLocal))&&failed.cloudAutomaticPausedInMemory,"clear retires memory immediately even when pause cannot be persisted")
  let(cancelled,cancelledLocal,cancelledProbe)=try make("cancelled-prompt");try cancelled.cloudSessionCredentials.install("retained-fixture",for:target(cancelledLocal));let cancelGeneration=cancelled.cloudSessionCredentials.generation
  cancelled.cloudPasswordPrompt={_,field in field.stringValue="cancelled-never-adopted";withUnsafeCurrentTask{$0?.cancel()};return .alertFirstButtonReturn}
  let cancelledTask=Task{@MainActor in try await cancelled.dispatchCloud("cloud.setSessionPassword",payload:[:])}
  do{_=try await cancelledTask.value;check(false,"task cancellation before adoption preserves cancellation")}catch{check(error is CancellationError,"task cancellation before adoption preserves cancellation")}
  let cancelledCounts=await cancelledProbe.counts();check(cancelled.cloudSessionCredentials.generation==cancelGeneration&&cancelledCounts.0==0,"task cancellation preserves original memory and has zero vault loads")
  let invalid=CloudSessionCredentials(),invalidTarget=CloudSessionCredentials.Target(destination:UUID(),account:"fixture@example.test")
  for value in ["", "bad\nvalue", "bad\u{0000}value", String(repeating:"x",count:4097)] {do{try invalid.install(value,for:invalidTarget);check(false,"invalid memory password rejected without persistence")}catch{check(!invalid.available(for:invalidTarget),"invalid memory password rejected without persistence")}}
  let bound=CloudSessionCredentials();try bound.install("fixture",for:invalidTarget);let verifiedLease=bound.generation;try bound.confirm(for:invalidTarget,generation:verifiedLease);check(bound.verified(for:invalidTarget),"verification belongs to the exact installed generation")
  try bound.install("fixture-replacement",for:invalidTarget);check(!bound.verified(for:invalidTarget),"replacement never inherits a prior generation's verification")
  do{try bound.confirm(for:invalidTarget,generation:verifiedLease);check(false,"late verification cannot confirm a replacement generation")}catch{check(!bound.verified(for:invalidTarget),"late verification cannot confirm a replacement generation")}
  let(late,lateLocal,lateProbe)=try make("late-probe");_=prompt(late,"memory-fixture");_=try await late.dispatchCloud("cloud.setSessionPassword",payload:[:]);let held=HeldSessionResponse();late.cloudServiceTransportOverride={r,_ in await held.respond(r)}
  let pending=Task{@MainActor in try await late.dispatchCloud("cloud.check",payload:[:])};await held.waitUntilRequested()
  late.cloudSessionCredentials.clear();try late.cloudSessionCredentials.install("replacement",for:target(lateLocal));let replacementGeneration=late.cloudSessionCredentials.generation;late.cloudArchive=nil;late.cloudCredentialState="session-unverified";late.cloudAutomaticPausedInMemory=true
  await held.release();await rejects("successful HTTP from a retired lease is not adopted"){_=try await pending.value}
  check(late.cloudSessionCredentials.generation==replacementGeneration && !late.cloudSessionCredentials.verified(for:target(lateLocal)),"late probe cannot revive or verify a different lease")
  check(late.cloudLastError==nil&&lateLocal.profile.automaticPaused==true,"retired callback does not overwrite current session state or disk pause")
  check((await lateProbe.counts()).0==0,"retired memory probe has zero vault reads")
  for retire in [false,true] {
   let gate=FocusCredentialGate(),values=FocusCredentialCounters()
   let access=CloudCredentialSession(destination:UUID(),account:"fixture@example.test",session:{await gate.wait()},isCurrent:{await values.current},load:{_ in await values.load()})
   let request=Task{try await access.credentials()};await gate.waitForEntry();if retire{await values.retarget()}else{request.cancel()};await gate.release()
   do{_=try await request.value;check(false,"retired or cancelled suspended lookup rejects credentials")}catch{check(retire ? (error as? CloudArchiveService.CloudError == .credentialsUnavailable) : error is CancellationError,"retired or cancelled suspended lookup rejects credentials")}
   check(await values.reads==0,retire ? "retarget during suspended session lookup cannot initiate vault access" : "cancel during suspended session lookup cannot initiate vault access")
  }
  let(upload,uploadLocal,uploadProbe)=try make("upload");_=prompt(upload,"memory-fixture");_=try await upload.dispatchCloud("cloud.setSessionPassword",payload:[:]);_=try await upload.dispatchCloud("cloud.upload",payload:[:])
  let reloaded=try CloudLocalStore(dataDirectory:upload.directory)
  check(reloaded.profile.lastBackup != nil&&reloaded.profile.automaticPaused==true,"memory upload completion atomically keeps cold-start pause and actual complete record")
  check((await uploadProbe.counts()).0==0,"full in-memory fixture backup and readback never reads Keychain")
  await upload.finishJobsForTermination();check(!upload.cloudSessionCredentials.available(for:target(uploadLocal)) && !upload.cloudAutomaticPermitted(profile:uploadLocal.profile),"termination clears memory and cannot authorize a cold-start automatic request")
  print("Cloud session focused: \(passed) passed; \(failures) failed");if failures>0{throw DesktopError.message("focused failures")}
 }
}
