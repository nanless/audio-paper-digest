import AppKit
import Foundation

/// The standard About panel links only to the current app's bundled offline notices.
@MainActor enum AboutLicenses {
    static func licenseURL(resources: URL?) throws -> URL {
        guard let resources else { throw CocoaError(.fileNoSuchFile) }
        let root = resources.resolvingSymlinksInPath()
        let web = root.appendingPathComponent("Web", isDirectory: true)
        let file = web.appendingPathComponent("third-party-notices.html")
        for item in [resources, web, file] {
            let values = try item.resourceValues(forKeys: [.isSymbolicLinkKey])
            guard values.isSymbolicLink != true else { throw CocoaError(.fileReadNoPermission) }
        }
        guard file.isFileURL, file.resolvingSymlinksInPath().path.hasPrefix(root.path + "/Web/"),
              try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]).isRegularFile == true,
              let bytes = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize, bytes > 0, bytes <= 4 * 1024 * 1024 else { throw CocoaError(.fileReadCorruptFile) }
        return file
    }
    static func credits(resources: URL? = Bundle.main.resourceURL) -> NSAttributedString {
        let result = NSMutableAttributedString(string: "阅读已发布成果 · 原文研究 · Zotero 完整归档\n本机 arm64 构建；使用系统窗口与 PDFKit。\n\n")
        if let url = try? licenseURL(resources: resources) {
            result.append(NSAttributedString(string: "关于与开源许可（离线全文）", attributes: [.link: url, .foregroundColor: NSColor.linkColor, .underlineStyle: NSUnderlineStyle.single.rawValue]))
        } else {
            result.append(NSAttributedString(string: "离线许可资料缺失；本构建不可公开分发。"))
        }
        return result
    }
}
