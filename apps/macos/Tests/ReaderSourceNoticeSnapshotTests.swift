import Foundation
@main struct ReaderSourceNoticeSnapshotTests {
 static func main()throws {
  let id="arxiv:2610.27491",rev=String(repeating:"a",count:64),text="  完整原说明\n<script>literal only</script>  "
  let article:[String:Any]=["paperID":id,"revisionSHA256":rev,"notices":[text,"第二条",text," \n"]]
  let original=try ReaderSourceNoticeSnapshot(paperID:id,article:article)
  var passed=0
  func check(_ ok:Bool,_ name:String){if !ok{fatalError(name)};passed+=1;print("PASS "+name)}
  func refuse(_ name:String,_ body:()throws->Void){do{try body();fatalError(name)}catch{passed+=1;print("PASS "+name)}}
  check(original.notices==[text,"第二条"],"complete original whitespace and literal markup preserved; duplicate/blank display rows excluded")
  let request=try ReaderSourceNoticeRequest(["paperID":id,"revisionSHA256":rev]);try original.requireRequest(request);check(true,"identity-only current request accepted")
  check(original.json["notices"] as? [String]==original.notices,"snapshot JSON contains original native-owned strings")
  for field in ["notices","source","text","url","path","kind","presentationID"] {refuse("request rejects extra "+field){_=try ReaderSourceNoticeRequest(["paperID":id,"revisionSHA256":rev,field:"unowned"])}}
  for bad:[String:Any] in [[:],["paperID":id],["paperID":" ","revisionSHA256":rev],["paperID":id,"revisionSHA256":12],["paperID":id,"revisionSHA256":"missing"],["paperID":NSNull(),"revisionSHA256":rev]]{refuse("request rejects missing or mistyped identity"){_=try ReaderSourceNoticeRequest(bad)}}
  refuse("request for different paper does not match"){try original.requireRequest(ReaderSourceNoticeRequest(["paperID":"arxiv:other","revisionSHA256":rev]))}
  refuse("request for different revision does not match"){try original.requireRequest(ReaderSourceNoticeRequest(["paperID":id,"revisionSHA256":String(repeating:"b",count:64)]))}
  try original.requireCurrent(paperID:id,article:article);check(true,"current full snapshot replay accepted")
  refuse("after-await paper change rejected"){try original.requireCurrent(paperID:"arxiv:other",article:article)}
  for (key,value) in [("paperID","other" as Any),("revisionSHA256",String(repeating:"b",count:64) as Any),("notices",["changed"] as Any)]{var changed=article;changed[key]=value;refuse("after-await "+key+" change rejected"){try original.requireCurrent(paperID:id,article:changed)}}
  for notices:Any in [[],[" \n"],["text",12],NSNull()] {var bad=article;bad["notices"]=notices;refuse("missing or mistyped native notice unavailable"){_=try ReaderSourceNoticeSnapshot(paperID:id,article:bad)}}
  var missing=article;missing.removeValue(forKey:"revisionSHA256");refuse("missing revision cannot mint source sheet"){_=try ReaderSourceNoticeSnapshot(paperID:id,article:missing)}
  print("Source notice snapshot assertions: \(passed), failures: 0")
 }
}
