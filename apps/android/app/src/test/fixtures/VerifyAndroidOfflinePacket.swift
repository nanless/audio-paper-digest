import Foundation
import CryptoKit
import PDFKit
func digest(_ d:Data)->String { SHA256.hash(data:d).map { String(format:"%02x",$0) }.joined() }
@main struct VerifyAndroidOfflinePacket {
 @MainActor static func main() async throws {
  let fm=FileManager.default, input=URL(fileURLWithPath:CommandLine.arguments[1]), output=URL(fileURLWithPath:CommandLine.arguments[2]), repo=URL(fileURLWithPath:CommandLine.arguments[3])
  let bytes=try Data(contentsOf:input)
  guard bytes.count <= 20*1024*1024, let report=try JSONSerialization.jsonObject(with:bytes) as? [String:Any], report["contract"] as? String == "paperdigest-android-offline-public-device-result-v1",let sdk=report["sdk"] as? Int,[28,35].contains(sdk),let packet=report["packet"] as? [String:Any],let id=packet["id"] as? String,id.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil,let files=packet["files"] as? [[String:Any]],[3,5].contains(files.count) else { fatalError("Invalid synthetic packet") }
  let root=fm.temporaryDirectory.appendingPathComponent("pd-android-offline-reverse-"+UUID().uuidString)
  try fm.createDirectory(at:root,withIntermediateDirectories:false);defer{try? fm.removeItem(at:root)}
  let folder=root.appendingPathComponent("Offline/"+id);try fm.createDirectory(at:folder,withIntermediateDirectories:true)
  var original=[String:String]()
  for entry in files {
   guard let path=entry["path"] as? String,(["paper.json","article.json","manifest.json","original.pdf"].contains(path) || path.range(of:"^resources/[a-f0-9]{64}\\.bin$",options:.regularExpression) != nil),original[path]==nil,let encoded=entry["data"] as? String,let data=Data(base64Encoded:encoded),let sha=entry["sha256"] as? String,digest(data)==sha else {fatalError("Packet original byte mismatch")}
   original[path]=sha;try fm.createDirectory(at:folder.appendingPathComponent(path).deletingLastPathComponent(),withIntermediateDirectories:true);try data.write(to:folder.appendingPathComponent(path),options:.atomic)
  }
  let store=try DesktopStore(directory:root),storage=DesktopStorage(directory:root,store:store,bundledSeedDirectory:root.appendingPathComponent("no-seed"))
  let verified=try await storage.verifyPackage(id:id),opened=try await storage.openPackage(id:id)
  guard let paper=opened["paper"] as? [String:Any],paper["id"] as? String == "fixture:paper",let article=opened["article"] as? [String:Any],article["paperID"] as? String == "fixture:paper" else {fatalError("Mac opened different synthetic material")}
  if files.count==5 {guard let pdf=opened["pdf"] as? [String:Any],let pdfPath=pdf["filePath"] as? String,PDFDocument(url:URL(fileURLWithPath:pdfPath))?.pageCount==1,let resources=article["resources"] as? [[String:Any]],resources.count==1,let imagePath=resources.first?["localPath"] as? String,digest(try Data(contentsOf:URL(fileURLWithPath:imagePath)))==resources.first?["sha256"] as? String else{fatalError("Mac did not open original synthetic PDF/image")}}
  for(path,sha) in original {guard digest(try Data(contentsOf:folder.appendingPathComponent(path)))==sha else{fatalError("Mac altered protected bytes")}}
  var sources=[String:String]();for name in ["DesktopStorage.swift","DesktopStore.swift","BackupCodec.swift"]{sources[name]=digest(try Data(contentsOf:repo.appendingPathComponent("apps/macos/Sources/"+name)))}
  let result:[String:Any] = ["contract":"paperdigest-android-to-mac-offline-independent-result-v1","inputSHA256":digest(bytes),"androidSDK":sdk,"packageID":id,"macSources":sources,"originalSHA256":original,"actualOriginalMacVerifyPassed":true,"actualOriginalMacOpenPassed":true,"allProtectedBytesUnchanged":true,"pdfPages":files.count==5 ? 1:0,"imageCount":files.count==5 ? 1:0,"verifiedSummary":verified,"qualification":"Actual unmodified Mac DesktopStorage verifies and opens an actual Android-created synthetic packet; no user data or network."]
  try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys,.prettyPrinted]).write(to:output,options:.atomic)
  print("PASS actual Android SDK \(sdk) packet -> original Mac verify/open; \(original.count) protected files unchanged")
 }
}
