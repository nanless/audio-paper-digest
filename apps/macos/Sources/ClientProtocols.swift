import Foundation
import CoreFoundation

/// Format recognition only. Callers retain their original byte, identity,
/// signature, path and permission checks; no imported record is rewritten here.
public enum ClientProtocols {
    public enum FormatError: Error, LocalizedError {
        case unknownFamily, unknownFormat, invalidHeader, reservedField, catalogUnavailable
        /// Only a corrupt embedded registry is user-actionable; the other cases are caller bugs.
        public var errorDescription: String? {
            guard case .catalogUnavailable = self else { return nil }
            return "客户端协议注册表无法读取；请重试当前操作，若仍失败请重新安装应用。"
        }
    }
    /// Decoded once. A malformed embedded registry is reported as a recoverable error at the
    /// operation boundary instead of trapping during app start or a background sync.
    private static let catalog: Result<[String: [String: Any]], FormatError> = parseCatalog(GeneratedClientProtocols.json)
    /// `nil` while the embedded registry is usable; otherwise a retryable user-facing reason.
    public static var catalogError: String? {
        guard case .failure = catalog else { return nil }
        return FormatError.catalogUnavailable.localizedDescription
    }
    public static var isCatalogAvailable: Bool {
        if case .success = catalog { return true }
        return false
    }
    /// Exposed so a regression test can prove corrupt bytes return an error instead of trapping.
    static func parseCatalog(_ json: String) -> Result<[String: [String: Any]], FormatError> {
        do {
            guard let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: [String: Any]] else {
                return .failure(.catalogUnavailable)
            }
            return .success(object)
        } catch {
            return .failure(.catalogUnavailable)
        }
    }
    private static func entries() throws -> [String: [String: Any]] { try catalog.get() }
    private static func formats(_ name: String) throws -> [[String: Any]] {
        guard let formats = try entry(name)["formats"] as? [[String: Any]] else { throw FormatError.catalogUnavailable }
        return formats
    }
    public static var catalogSHA256: String { GeneratedClientProtocols.catalogSHA256 }
    private static let reserved: Set<String> = ["contract", "schemaFingerprint", "version", "schemaVersion", "policyVersion", "__proto__"]

    private static func entry(_ name: String) throws -> [String: Any] {
        guard let value = try entries()[name] else { throw FormatError.unknownFamily }
        return value
    }
    private static func choices(_ raw: Any?, _ name: String) throws -> [[String:Any]] {
        guard let raw else { return [] }
        return try formats(name).filter { format in
            guard let tag = format["tag"] else { return false }
            return sameJSONValue(tag, raw)
        }
    }
    private static func select(_ raw: Any?,_ name:String,_ selectors:[String?]) throws->[String:Any] {
        guard selectors.count<=1 else { throw FormatError.unknownFormat }
        let found=try choices(raw,name).filter { selectors.isEmpty || ($0["fp"] as? String)==selectors[0] }
        guard found.count==1 else { throw FormatError.unknownFormat };return found[0]
    }
    public static func contract(_ name: String) -> String {
        // A corrupt registry cannot be checked here; record()/recordHeader() still throw
        // catalogUnavailable so no record is written without a verified header.
        if let available = try? entries() { precondition(available[name] != nil, "Unknown client protocol family") }
        return name
    }
    public static func isContract(_ raw: Any?, _ name: String, variant: String? = nil, fingerprints:String?...) -> Bool {
        guard fingerprints.count<=1,let found=try? choices(raw,name).filter({fingerprints.isEmpty || ($0["fp"] as? String)==fingerprints[0]}),!found.isEmpty else { return false }
        return variant == nil || found.allSatisfy { $0["variant"] as? String == variant }
    }
    public static func format(_ raw: Any?, _ name: String, _ fingerprints:String?...) throws -> String {
        guard let variant = try select(raw,name,fingerprints)["variant"] as? String else { throw FormatError.catalogUnavailable }
        return variant
    }
    public static func identityDomain(_ raw: String?, _ name: String, _ fingerprints:String?...) throws -> String {
        _ = try select(raw, name,fingerprints)
        return raw!
    }
    public static func historicalContract(_ name: String, variant: String) throws -> String {
        let found=try formats(name).filter {$0["historical"] as? Bool == true && $0["variant"] as? String == variant}
        guard found.count==1,found[0]["fp"] is NSNull,let raw=found[0]["tag"] as? String,try choices(raw,name).count==1 else { throw FormatError.unknownFormat };return raw
    }
    public static func historicalHeader(_ name:String,variant:String,fingerprints:String?...) throws->[String:Any] {
        guard fingerprints.count<=1 else { throw FormatError.unknownFormat }
        let found=try formats(name).filter {$0["historical"] as? Bool == true && $0["variant"] as? String == variant && (fingerprints.isEmpty || ($0["fp"] as? String)==fingerprints[0])}
        guard found.count==1,let header=found[0]["header"] as? [String:Any] else { throw FormatError.unknownFormat };return header
    }
    public static func schemaFingerprint(_ name: String) -> String {
        guard let available = try? entries() else { return "" }
        precondition(available[name] != nil, "Unknown client protocol family")
        return available[name]?["schemaFingerprint"] as? String ?? ""
    }
    public static func declaredSchema(_ raw:Any?,_ name:String,_ fingerprint:String?) throws->[String:Any] {
        guard let schema=try select(raw,name,[fingerprint])["schema"] as? [String:Any] else { throw FormatError.unknownFormat }
        guard let object = try JSONSerialization.jsonObject(with:JSONSerialization.data(withJSONObject:schema)) as? [String:Any] else { throw FormatError.catalogUnavailable }
        return object
    }
    public static func recordHeader(_ raw: Any?, _ name: String, _ fingerprints:String?...) throws -> [String: Any] {
        try header(raw,name,fingerprints)
    }
    private static func header(_ raw:Any?,_ name:String,_ selectors:[String?]) throws->[String:Any] {
        if selectors.isEmpty,raw as? String == name {
            guard let headers = try entry(name)["headers"] as? [String:[String:Any]], let header = headers[name] else { throw FormatError.catalogUnavailable }
            return header
        }
        guard let header = try select(raw,name,selectors)["header"] as? [String:Any] else { throw FormatError.catalogUnavailable }
        return header
    }
    public static func record(_ name: String, fields: [String: Any] = [:]) throws -> [String: Any] {
        guard Set(fields.keys).isDisjoint(with: reserved) else { throw FormatError.reservedField }
        return try recordHeader(contract(name), name).merging(fields) { _, new in new }
    }
    /// Current records must carry the exact declared schema fingerprint. Legacy
    /// headers remain exact; adding a current fingerprint cannot upgrade them.
    public static func hasValidHeader(_ object: [String: Any], _ name: String, field: String = "contract") -> Bool {
        guard let raw = object[field], let expected = try? header(raw, name,[object["schemaFingerprint"] as? String]) else { return false }
        for key in reserved.union(expected.keys) {
            if let value = expected[key] {
                guard let actual = object[key], sameJSONValue(value, actual) else { return false }
            } else if object[key] != nil { return false }
        }
        return true
    }
    public static func recordKeys(_ raw: Any?, _ name: String, fields: Set<String>,fingerprints:String?...) throws -> Set<String> {
        fields.union(try header(raw, name,fingerprints).keys)
    }
    public static func isCurrentHeader(_ object:[String:Any],_ name:String,field:String="contract")->Bool {
        hasValidHeader(object,name,field:field) && object[field] as? String == name && object["schemaFingerprint"] as? String == schemaFingerprint(name)
    }
    public static func hasValidHeader(_ raw: String, fingerprint: String?, _ name: String) -> Bool {
        var header: [String: Any] = ["contract":raw]
        if let fingerprint { header["schemaFingerprint"]=fingerprint }
        return hasValidHeader(header,name)
    }
    private struct HeaderKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue=stringValue }
        init?(intValue: Int) { return nil }
    }
    /// Read the original header from the decoder before a typed model can drop
    /// unknown reserved fields. This does not decode a second copy of file data.
    public static func decodeHeader(_ decoder: Decoder, _ name: String, field: String = "contract") throws -> (raw: String, fingerprint: String?) {
        let values=try decoder.container(keyedBy:HeaderKey.self)
        let raw=try values.decode(String.self,forKey:HeaderKey(stringValue:field))
        let fingerprint=try values.decodeIfPresent(String.self,forKey:HeaderKey(stringValue:"schemaFingerprint"))
        let expected=try recordHeader(raw,name,fingerprint)
        for field in reserved.union(expected.keys) where field != "__proto__" {
            let key=HeaderKey(stringValue:field)
            guard let value=expected[field] else {
                if values.contains(key) { throw FormatError.invalidHeader }
                continue
            }
            if let text=value as? String {
                guard try values.decode(String.self,forKey:key)==text else { throw FormatError.invalidHeader }
            } else if let number=value as? NSNumber {
                if CFGetTypeID(number)==CFBooleanGetTypeID() {
                    guard try values.decode(Bool.self,forKey:key)==number.boolValue else { throw FormatError.invalidHeader }
                } else {
                    guard try values.decode(Int.self,forKey:key)==number.intValue else { throw FormatError.invalidHeader }
                }
            } else { throw FormatError.invalidHeader }
        }
        if values.contains(HeaderKey(stringValue:"__proto__")) { throw FormatError.invalidHeader }
        return (raw,expected["schemaFingerprint"] as? String)
    }
    private static func sameJSONValue(_ expected: Any, _ actual: Any) -> Bool {
        guard JSONSerialization.isValidJSONObject([expected]), JSONSerialization.isValidJSONObject([actual]),
              let a = try? JSONSerialization.data(withJSONObject: [expected], options: [.sortedKeys]),
              let b = try? JSONSerialization.data(withJSONObject: [actual], options: [.sortedKeys]) else { return false }
        return a == b
    }
}
