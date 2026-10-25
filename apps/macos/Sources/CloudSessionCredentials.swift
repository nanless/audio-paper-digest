import Foundation

/// Explicit, process-local credential only. Never Codable, file-backed, logged or sent to the web bridge.
@MainActor final class CloudSessionCredentials {
    struct Target: Equatable, Sendable {
        let destination: UUID
        let account: String
    }
    private struct Entry {
        let target: Target
        let password: String
    }
    private var entry: Entry?
    private var verifiedGeneration: UUID?
    private(set) var generation = UUID()
    static func validate(_ password: String, for target: Target) throws {
        guard !password.isEmpty, password.utf8.count <= 4096,
              !password.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              !target.account.isEmpty, !target.account.contains(":"), target.account.utf8.count <= 320,
              !target.account.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
            throw CloudArchiveService.CloudError.invalidConfiguration
        }
        }
    func install(_ password: String, for target: Target) throws {
        try Self.validate(password, for: target)
        entry = Entry(target: target, password: password); generation = UUID(); verifiedGeneration = nil
    }
    func clear() { entry = nil; generation = UUID(); verifiedGeneration = nil }
    func available(for target: Target) -> Bool { entry?.target == target }
    func invalidateVerification() { verifiedGeneration = nil }
    func verified(for target: Target) -> Bool { available(for: target) && verifiedGeneration == generation }
    func confirm(for target: Target, generation expected: UUID) throws {
        guard generation == expected, available(for: target) else { throw CloudArchiveService.CloudError.credentialsUnavailable }
        verifiedGeneration = expected
    }
    func credentials(for target: Target, generation expected: UUID) throws -> CloudArchiveService.Credentials? {
        guard generation == expected else { throw CloudArchiveService.CloudError.credentialsUnavailable }
        guard let entry else { return nil }
        guard entry.target == target else { throw CloudArchiveService.CloudError.credentialsUnavailable }
        return .init(username: target.account, password: entry.password)
    }
}
