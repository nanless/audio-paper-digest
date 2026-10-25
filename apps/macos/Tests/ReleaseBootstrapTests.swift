import AppKit
import Foundation

@main struct ReleaseBootstrapTests {
    static func expect(_ condition:Bool,_ message:String)throws{if !condition{throw NSError(domain:message,code:1)}}
    @MainActor static func main()throws {
        let fm=FileManager.default,parent=fm.temporaryDirectory.appendingPathComponent("about-license-test-"+UUID().uuidString).resolvingSymlinksInPath()
        try fm.createDirectory(at:parent,withIntermediateDirectories:true);defer{try?fm.removeItem(at:parent)}
        let resources=parent.appendingPathComponent("Resources"),web=resources.appendingPathComponent("Web"),file=web.appendingPathComponent("third-party-notices.html")
        try fm.createDirectory(at:web,withIntermediateDirectories:true)
        try Data("<!doctype html><title>Offline full license fixture</title>".utf8).write(to:file)
        let expected=try AboutLicenses.licenseURL(resources:resources),credits=AboutLicenses.credits(resources:resources)
        try expect(expected==file,"same bundle resource URL");try expect(expected.isFileURL,"file only")
        let range=(credits.string as NSString).range(of:"关于与开源许可（离线全文）")
        try expect(range.location != NSNotFound,"offline credits action visible");try expect(credits.attribute(.link,at:range.location,effectiveRange:nil)as? URL==file,"trusted local URL attribute")
        try fm.removeItem(at:file);let missing=AboutLicenses.credits(resources:resources)
        try expect(missing.string.contains("不可公开分发"),"missing notice never appears ready")
        let outside=parent.appendingPathComponent("outside.html");try Data("outside fixture".utf8).write(to:outside)
        try fm.createSymbolicLink(at:file,withDestinationURL:outside)
        try expect((try?AboutLicenses.licenseURL(resources:resources))==nil,"symlink not trusted")
        print("PASS About offline notice: 6 assertions, no GUI/network/installed app")
    }
}
