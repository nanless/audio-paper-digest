import Foundation

/// The published arXiv identifier grammar, shared by catalog and archive paths.
/// Legacy archive names remain lowercase; an optional subject class is two uppercase letters.
enum DesktopArxivIdentifier {
    private static let basePattern = #"(?:[0-9]{4}\.[0-9]{4,5}|[a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?/[0-9]{2}(?:0[1-9]|1[0-2])[0-9]{3})"#

    static func base(of identifier: String) -> String? {
        guard identifier.range(of: #"\A"# + basePattern + #"(?:v[1-9][0-9]*)?\z"#, options: .regularExpression) != nil else { return nil }
        return identifier.replacingOccurrences(of: #"v[1-9][0-9]*\z"#, with: "", options: .regularExpression)
    }

    static func isBase(_ identifier: String) -> Bool { base(of: identifier) == identifier }
}
