import Foundation
import CoreFoundation
import Darwin

extension LibraryService {
    static let maxDesktopManifestBytes = 64 * 1024
    static let maxDesktopSnapshotBytes = 1024 * 1024
    static let maxDesktopShardBytes = 1024 * 1024
    static let maxDesktopShards = 128
    static let maxDesktopTotalCatalogBytes = 64 * 1024 * 1024
    static let maxDesktopDetailBytes = 2 * 1024 * 1024
    static let maxDesktopArticleBytes = 16 * 1024 * 1024
    static let maxDesktopAssetBytes = 16 * 1024 * 1024
    static let maxDesktopArticleResources = 512
    static let maxDesktopBundledArticleAssetsBytes = 64 * 1024 * 1024
    static let maxDesktopSidecarBytes = 1024 * 1024

    struct DesktopEpochChangedError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    struct DesktopFileDescriptor: Codable, Sendable, Equatable {
        var url: String
        var bytes: Int
        var sha256: String
    }

    struct DesktopShardDescriptor: Codable, Sendable, Equatable {
        var url: String
        var bytes: Int
        var sha256: String
        var recordCount: Int
    }

    struct DesktopAppearanceEntry: Codable, Sendable, Equatable {
        var appearanceId: String
        var blogURL: String
        var pageType: String
        var publicationStatus: String
        var blogPublishedAt: String
        var articleUpdatedAt: String?
        var sourceVersionId: String?
        var articleRevisionId: String
        var detail: DesktopFileDescriptor
    }

    struct DesktopPaperDetailEntry: Codable, Sendable, Equatable {
        var paperID: String
        var primaryAppearanceId: String
        var primaryBlogURL: String
        var primaryArticleRevisionId: String
        var primaryPublicationStatus: String
        var primaryDetail: DesktopFileDescriptor
        var appearances: [DesktopAppearanceEntry]
    }

    struct DesktopTombstoneRecord: Codable, Sendable, Equatable {
        var appearanceId: String
        var paperId: String?
        var previousArticleRevisionId: String
        var reason: String
        var effectiveAt: String
        var sourceCommit: String
        var replacementAppearanceId: String?
        var evidenceUrl: String?
        var note: String?
    }

    struct DesktopTombstoneEvent: Codable, Sendable, Equatable {
        var kind: String
        var appearanceId: String
        var paperId: String?
        var previousArticleRevisionId: String?
        var restoredArticleRevisionId: String?
        var reason: String?
        var effectiveAt: String
        var sourceCommit: String
        var replacementAppearanceId: String?
        var evidenceUrl: String?
        var note: String?
        var observedSnapshotId: String
        var observedAt: String
    }

    struct DesktopDetailsState: Codable, Sendable, Equatable {
        static let macosContract = "paperdigest-macos-desktop-details-state"
        static let androidFormat = "paperdigest-android-desktop-details-state"
        static let androidTombstoneFormat = "paperdigest-android-desktop-tombstone-history"

        var contract: String = Self.macosContract
        var snapshotID: String
        var validationEpoch: String
        var sourceCommit: String
        var generatedAt: String
        var basePath: String
        var paperDetails: [String: DesktopPaperDetailEntry]
        var aggregateDetails: [String: DesktopAppearanceEntry]
        var activeTombstones: [DesktopTombstoneRecord]
        var tombstoneHistory: [DesktopTombstoneEvent]

        init(
            contract: String = Self.macosContract,
            snapshotID: String,
            validationEpoch: String,
            sourceCommit: String,
            generatedAt: String,
            basePath: String,
            paperDetails: [String: DesktopPaperDetailEntry],
            aggregateDetails: [String: DesktopAppearanceEntry],
            activeTombstones: [DesktopTombstoneRecord],
            tombstoneHistory: [DesktopTombstoneEvent]
        ) {
            self.contract = contract
            self.snapshotID = snapshotID
            self.validationEpoch = validationEpoch
            self.sourceCommit = sourceCommit
            self.generatedAt = generatedAt
            self.basePath = basePath
            self.paperDetails = paperDetails
            self.aggregateDetails = aggregateDetails
            self.activeTombstones = activeTombstones
            self.tombstoneHistory = tombstoneHistory
        }

        private enum CodingKeys: String, CodingKey {
            case format, contract, snapshotID, validationEpoch, sourceCommit, generatedAt
            case basePath, paperDetails, aggregateDetails, activeTombstones, tombstoneHistory
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            if c.contains(.format) {
                throw DecodingError.dataCorruptedError(forKey: .format, in: c, debugDescription: "Foreign desktop-details state format")
            }
            if let explicitContract = try c.decodeIfPresent(String.self, forKey: .contract) {
                guard explicitContract == Self.macosContract else {
                    throw DecodingError.dataCorruptedError(forKey: .contract, in: c, debugDescription: "Unsupported macOS desktop-details state contract")
                }
                self.contract = explicitContract
            } else {
                self.contract = Self.macosContract
            }
            snapshotID = try c.decode(String.self, forKey: .snapshotID)
            validationEpoch = try c.decode(String.self, forKey: .validationEpoch)
            sourceCommit = try c.decode(String.self, forKey: .sourceCommit)
            generatedAt = try c.decode(String.self, forKey: .generatedAt)
            basePath = try c.decode(String.self, forKey: .basePath)
            paperDetails = try c.decode([String: DesktopPaperDetailEntry].self, forKey: .paperDetails)
            aggregateDetails = try c.decode([String: DesktopAppearanceEntry].self, forKey: .aggregateDetails)
            activeTombstones = try c.decode([DesktopTombstoneRecord].self, forKey: .activeTombstones)
            tombstoneHistory = try c.decode([DesktopTombstoneEvent].self, forKey: .tombstoneHistory)
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(Self.macosContract, forKey: .contract)
            try c.encode(snapshotID, forKey: .snapshotID)
            try c.encode(validationEpoch, forKey: .validationEpoch)
            try c.encode(sourceCommit, forKey: .sourceCommit)
            try c.encode(generatedAt, forKey: .generatedAt)
            try c.encode(basePath, forKey: .basePath)
            try c.encode(paperDetails, forKey: .paperDetails)
            try c.encode(aggregateDetails, forKey: .aggregateDetails)
            try c.encode(activeTombstones, forKey: .activeTombstones)
            try c.encode(tombstoneHistory, forKey: .tombstoneHistory)
        }
    }

    struct VerifiedDesktopDetail {
        let rawBytes: Data
        let rawObject: [String: Any]
        let appearanceId: String
        let paperId: String?
        let identityStatus: String
        let sourceKind: String?
        let sourceVersionId: String?
        let versionLabel: String?
        let officialSourceURL: String?
        let officialPDFURL: String?
        let pdfSHA256: String?
        let sourceVersionWarning: String?
        let provenanceDisclosure: String?
        let publicationStatus: String
        let retractionEvidenceURL: String?
        let retractionNote: String?
        let articleRevisionId: String
        let articleDescriptor: DesktopFileDescriptor
        let hasGuideContent: Bool
        let originalTitle: String?
        let readerTitle: String
        let displayTitle: String
        let authorNames: [String]
        let paperPublishedAt: String?
        let blogPublishedAt: String
        let articleUpdatedAt: String?
        let arxivVersionedId: String?
        let abstractText: String?
        let oneSentenceThesis: String?
        let citationSourceRecord: [String: Any]
        let sidecarsAvailable: Bool
        let sidecarDescriptors: [String: DesktopSidecarDescriptor]
        let resources: [DesktopResourceEntry]
    }

    struct DesktopSidecarDescriptor: Sendable {
        let name: String
        let url: String
        let bytes: Int
        let sha256: String
        let contract: String?
        let schemaFingerprint: String?
    }

    struct DesktopResourceEntry: Sendable {
        let resourceId: String
        let kind: String
        let mediaType: String
        let sourceUrl: String
        let availability: String
        let requiredForOffline: Bool
        let descriptor: DesktopFileDescriptor?
        let expectedSha256: String?
    }

    // MARK: - Active State & Persistence

    func activeDesktopDetails() -> DesktopDetailsState? {
        guard let state = desktopDetails,
              let epoch = snapshot.validationEpoch,
              state.snapshotID == snapshot.summary.snapshotID,
              state.validationEpoch == epoch else { return nil }
        return state
    }

    func desktopDetailsSnapshot() async throws -> DesktopDetailsState? {
        try await waitUntilReady()
        return activeDesktopDetails()
    }

    func currentCatalogStamp() -> String {
        "\(snapshot.summary.snapshotID):\(snapshot.validationEpoch ?? "")"
    }

    static func desktopDetailsStateRelativePath(snapshotID: String, validationEpoch: String) throws -> String {
        guard isValidSHA256(snapshotID),
              !validationEpoch.isEmpty,
              validationEpoch != ".",
              validationEpoch != "..",
              validationEpoch.range(of: #"\A[A-Za-z0-9._-]{1,128}\z"#, options: .regularExpression) != nil else {
            throw ServiceError.invalid("桌面详情本地快照或验证代标识格式无效。")
        }
        return "desktop-details/macos-states/\(snapshotID)-\(validationEpoch).json"
    }

    static func sameSiteURL(_ value: String, siteBaseURL: URL) throws -> URL {
        guard !value.isEmpty,
              let url = URL(string: value, relativeTo: siteBaseURL)?.absoluteURL,
              url.scheme == "https",
              url.host?.lowercased() == siteBaseURL.host?.lowercased(),
              url.port == siteBaseURL.port,
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil,
              url.path.hasPrefix(siteBaseURL.path + "/"),
              !url.pathComponents.contains(".."),
              !url.path.contains("\\") else {
            throw ServiceError.invalid("资料地址超出可信站点目录。")
        }
        return url
    }

    /// Returns `nil` ONLY when `relative` genuinely does not exist (`lstat` `ENOENT`).
    /// Any symlink (including dangling), non-regular file, oversize file, byte-length mismatch,
    /// or SHA-256 mismatch throws `ServiceError.invalid` fail-closed.
    static func verifiedOptionalLocalFile(
        relative: String,
        directory: URL,
        expectedBytes: Int? = nil,
        maxBytes: Int,
        expectedSHA256: String? = nil
    ) throws -> (file: URL, bytes: Data)? {
        try PrivateStoragePaths.path(relative)
        let root = try PrivateStoragePaths.checkedDirectory(directory)
        var cursor = root
        let parts = relative.split(separator: "/").map(String.init)
        for (idx, part) in parts.enumerated() {
            cursor.appendPathComponent(part)
            var info = stat()
            if lstat(cursor.path, &info) != 0 {
                if errno == ENOENT { return nil }
                throw ServiceError.invalid("本地缓存路径状态不可核验：\(relative)")
            }
            let mode = info.st_mode & S_IFMT
            if mode == S_IFLNK {
                throw ServiceError.invalid("本地内容寻址缓存路径禁止经过符号链接：\(relative)")
            }
            if idx < parts.count - 1 {
                guard mode == S_IFDIR else {
                    throw ServiceError.invalid("本地内容寻址缓存父路径不是普通目录：\(relative)")
                }
            } else {
                guard mode == S_IFREG else {
                    throw ServiceError.invalid("本地内容寻址缓存必须为普通文件：\(relative)")
                }
            }
        }
        let checked = try PrivateStoragePaths.checkedFile(relative: relative, directory: root)
        let bytes = try PrivateStoragePaths.boundedData(checked, limit: maxBytes)
        if let expectedBytes, bytes.count != expectedBytes {
            throw ServiceError.invalid("本地内容寻址缓存字节长度与声明不符（已损坏或被篡改）：\(relative)")
        }
        if let expectedSHA256, Self.sha256(bytes) != expectedSHA256 {
            throw ServiceError.invalid("本地内容寻址缓存 SHA-256 与声明不符（已损坏或被篡改）：\(relative)")
        }
        return (checked, bytes)
    }

    func atomicWriteChecked(_ data: Data, relative: String) throws {
        try PrivateStoragePaths.path(relative)
        let root = try PrivateStoragePaths.checkedDirectory(directory)
        let parts = relative.split(separator: "/").map(String.init)
        var cursor = root
        for (idx, part) in parts.enumerated() {
            cursor.appendPathComponent(part)
            var info = stat()
            if lstat(cursor.path, &info) == 0 {
                let mode = info.st_mode & S_IFMT
                if mode == S_IFLNK {
                    throw ServiceError.invalid("写入目标路径禁止包含符号链接：\(relative)")
                }
                if idx < parts.count - 1 {
                    guard mode == S_IFDIR else {
                        throw ServiceError.invalid("写入目标父路径不是普通目录：\(relative)")
                    }
                } else {
                    guard mode == S_IFREG else {
                        throw ServiceError.invalid("写入目标已存在但不是普通文件：\(relative)")
                    }
                }
            } else if errno != ENOENT {
                throw ServiceError.invalid("写入目标路径状态不可核验：\(relative)")
            } else if idx < parts.count - 1 {
                try FileManager.default.createDirectory(at: cursor, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            }
        }
        try data.write(to: cursor, options: [.atomic])
    }

    private static func decodeVerifiedMacOSStateBytes(
        _ bytes: Data,
        expectedSnapshotID: String,
        expectedEpoch: String
    ) throws -> DesktopDetailsState {
        guard String(data: bytes, encoding: .utf8) != nil else {
            throw ServiceError.invalid("桌面详情本地索引不是有效 UTF-8。")
        }
        let decoded: DesktopDetailsState
        do {
            decoded = try JSONDecoder().decode(DesktopDetailsState.self, from: bytes)
        } catch {
            throw ServiceError.invalid("桌面详情本地索引损坏（\(error.localizedDescription)），原文件已保留。")
        }
        guard decoded.snapshotID == expectedSnapshotID, decoded.validationEpoch == expectedEpoch else {
            throw ServiceError.invalid("桌面详情本地索引与当前目录快照或验证代不匹配。")
        }
        return decoded
    }

    /// Deterministically reconstructs macOS `DesktopDetailsState` from a portable `.paperdigest` backup
    /// created on Android (`"format": "paperdigest-android-desktop-details-state"`), cold-verifying the
    /// raw byte length and SHA-256 of the immutable snapshot, catalog shards, and tombstone shards on disk.
    private static func reconstructDesktopDetailsStateFromAndroidWitness(
        witnessObj: [String: Any],
        directory: URL,
        snapshot: StoredSnapshot,
        siteBaseURL: URL
    ) throws -> DesktopDetailsState {
        let snapshotId = snapshot.summary.snapshotID
        guard let epoch = snapshot.validationEpoch,
              !epoch.isEmpty,
              isValidSHA256(snapshotId),
              witnessObj["format"] as? String == DesktopDetailsState.androidFormat,
              (try? strictNonNegativeInt(witnessObj["version"], label: "androidState.version")) == 1,
              witnessObj["snapshotId"] as? String == snapshotId,
              witnessObj["validationEpoch"] as? String == epoch,
              let sourceCommit = witnessObj["sourceCommit"] as? String,
              isValidCommitOID(sourceCommit),
              let witnessAppearances = witnessObj["appearances"] as? [[String: Any]],
              let witnessPrimary = witnessObj["primaryAppearanceIds"] as? [String: String] else {
            throw ServiceError.invalid("跨端 Android 桌面状态见证格式、版本、快照或验证代无效。")
        }

        // 1. Cold-verify immutable snapshot JSON on disk
        let snapRel = "desktop-details/snapshots/\(snapshotId).json"
        guard let snapHit = try verifiedOptionalLocalFile(
            relative: snapRel,
            directory: directory,
            maxBytes: maxDesktopSnapshotBytes,
            expectedSHA256: snapshotId
        ), !snapHit.bytes.isEmpty else {
            throw ServiceError.invalid("跨端恢复缺少已核验的桌面快照原件：\(snapRel)")
        }
        guard let snapshotText = String(data: snapHit.bytes, encoding: .utf8),
              !snapshotText.localizedCaseInsensitiveContains(snapshotId) else {
            throw ServiceError.invalid("桌面快照原件编码无效或包含自引用 SHA。")
        }
        let snapshotObj = try parseUTF8JSONObject(snapHit.bytes, label: snapRel)
        let snapshotRequired: Set<String> = [
            "sourceCommit", "catalogShards", "recordCount", "paperCount",
            "appearanceCount", "tombstoneShards", "tombstoneCount", "tagCatalogs"
        ]
        guard ClientProtocols.hasValidHeader(snapshotObj, "paper-desktop-snapshot"),
              snapshotObj["contract"] as? String == ClientProtocols.contract("paper-desktop-snapshot"),
              Set(snapshotObj.keys).isSuperset(of: snapshotRequired),
              snapshotObj["sourceCommit"] as? String == sourceCommit else {
            throw ServiceError.invalid("跨端恢复的桌面快照协议头或 sourceCommit 与状态见证不一致。")
        }
        let expectedRecordCount = try strictNonNegativeInt(snapshotObj["recordCount"], label: "snapshot.recordCount")
        let expectedPaperCount = try strictNonNegativeInt(snapshotObj["paperCount"], label: "snapshot.paperCount")
        let expectedAppearanceCount = try strictNonNegativeInt(snapshotObj["appearanceCount"], label: "snapshot.appearanceCount")
        let expectedTombstoneCount = try strictNonNegativeInt(snapshotObj["tombstoneCount"], label: "snapshot.tombstoneCount")
        guard expectedRecordCount > 0,
              expectedAppearanceCount == expectedRecordCount,
              expectedPaperCount > 0,
              expectedPaperCount <= expectedRecordCount else {
            throw ServiceError.invalid("跨端恢复的桌面快照计数无效。")
        }

        // 2. Cold-verify every catalog shard on disk
        guard let rawCatalogShards = snapshotObj["catalogShards"] as? [Any],
              !rawCatalogShards.isEmpty,
              rawCatalogShards.count <= maxDesktopShards else {
            throw ServiceError.invalid("跨端恢复的目录分片列表无效。")
        }
        var catalogShards: [DesktopShardDescriptor] = []
        var seenCatURLs = Set<String>()
        var catTotalBytes = 0
        var catRowsSum = 0
        for rawShard in rawCatalogShards {
            let shard = try parseShardDescriptor(rawShard, expectedPrefix: "client/details/catalog", label: "catalogShard")
            guard seenCatURLs.insert(shard.url).inserted else {
                throw ServiceError.invalid("跨端恢复存在重复目录分片。")
            }
            catTotalBytes += shard.bytes
            catRowsSum += shard.recordCount
            catalogShards.append(shard)
        }
        guard catTotalBytes <= maxDesktopTotalCatalogBytes, catRowsSum == expectedRecordCount else {
            throw ServiceError.invalid("跨端恢复的目录分片总字节或记录总数不闭合。")
        }

        var allCatalogRows: [[String: Any]] = []
        allCatalogRows.reserveCapacity(expectedRecordCount)
        for shard in catalogShards {
            let shardRel = "desktop-details/catalog/\(shard.sha256).json"
            guard let shardHit = try verifiedOptionalLocalFile(
                relative: shardRel,
                directory: directory,
                expectedBytes: shard.bytes,
                maxBytes: maxDesktopShardBytes,
                expectedSHA256: shard.sha256
            ) else {
                throw ServiceError.invalid("跨端恢复缺少目录分片文件：\(shardRel)")
            }
            let rows = try parseUTF8JSONArray(shardHit.bytes, label: shard.url)
            guard rows.count == shard.recordCount else {
                throw ServiceError.invalid("跨端恢复目录分片记录条数不符：\(shard.url)")
            }
            allCatalogRows.append(contentsOf: rows)
        }

        // 3. Cold-verify every tombstone shard on disk
        guard let rawTombstoneShards = snapshotObj["tombstoneShards"] as? [Any] else {
            throw ServiceError.invalid("跨端恢复快照缺少 tombstoneShards。")
        }
        var tombstoneShards: [DesktopShardDescriptor] = []
        if expectedTombstoneCount == 0 {
            guard rawTombstoneShards.isEmpty else {
                throw ServiceError.invalid("跨端恢复快照 tombstoneCount 为 0 但包含非空分片。")
            }
        } else {
            guard !rawTombstoneShards.isEmpty, rawTombstoneShards.count <= maxDesktopShards else {
                throw ServiceError.invalid("跨端恢复删除分片数量无效。")
            }
            var seenTombURLs = Set<String>()
            var tombTotalBytes = 0
            var tombRowsSum = 0
            for rawShard in rawTombstoneShards {
                let shard = try parseShardDescriptor(rawShard, expectedPrefix: "client/details/tombstones", label: "tombstoneShard")
                guard seenTombURLs.insert(shard.url).inserted else {
                    throw ServiceError.invalid("跨端恢复存在重复删除分片。")
                }
                tombTotalBytes += shard.bytes
                tombRowsSum += shard.recordCount
                tombstoneShards.append(shard)
            }
            guard tombTotalBytes <= maxDesktopTotalCatalogBytes, tombRowsSum == expectedTombstoneCount else {
                throw ServiceError.invalid("跨端恢复删除分片总字节或数量不闭合。")
            }
        }

        var allTombstoneRows: [[String: Any]] = []
        allTombstoneRows.reserveCapacity(expectedTombstoneCount)
        for shard in tombstoneShards {
            let shardRel = "desktop-details/tombstones/\(shard.sha256).json"
            guard let shardHit = try verifiedOptionalLocalFile(
                relative: shardRel,
                directory: directory,
                expectedBytes: shard.bytes,
                maxBytes: maxDesktopShardBytes,
                expectedSHA256: shard.sha256
            ) else {
                throw ServiceError.invalid("跨端恢复缺少删除分片文件：\(shardRel)")
            }
            let rows = try parseUTF8JSONArray(shardHit.bytes, label: shard.url)
            guard rows.count == shard.recordCount else {
                throw ServiceError.invalid("跨端恢复删除分片记录条数不符：\(shard.url)")
            }
            allTombstoneRows.append(contentsOf: rows)
        }

        // 4. Rebuild paperDetails & aggregateDetails from verified catalog shards and cross-check Android witness
        let catalogRequiredKeys: Set<String> = [
            "appearanceId", "paperId", "identityStatus", "sourceKind", "sourceVersionId",
            "pageType", "publicationStatus", "title", "titleZh", "summary",
            "blogPublishedAt", "articleUpdatedAt", "pageUrl", "score",
            "tagConceptIds", "articleRevisionId", "detail"
        ]
        var activeAppearanceIDs = Set<String>()
        var paperDetails: [String: DesktopPaperDetailEntry] = [:]
        var aggregateDetails: [String: DesktopAppearanceEntry] = [:]
        var primarySortKeyByPaperID: [String: (String, String, String)] = [:]

        for row in allCatalogRows {
            guard Set(row.keys).isSuperset(of: catalogRequiredKeys),
                  let appearanceId = row["appearanceId"] as? String,
                  isValidAppearanceID(appearanceId),
                  activeAppearanceIDs.insert(appearanceId).inserted,
                  let pageUrl = row["pageUrl"] as? String,
                  pageUrl == appearanceId,
                  let pageType = row["pageType"] as? String,
                  let publicationStatus = row["publicationStatus"] as? String,
                  ["active", "retracted"].contains(publicationStatus),
                  let blogPublishedAt = row["blogPublishedAt"] as? String,
                  isValidDateOnly(blogPublishedAt),
                  let articleRevisionId = row["articleRevisionId"] as? String,
                  isValidSHA256(articleRevisionId),
                  row["tagConceptIds"] is [String] else {
                throw ServiceError.invalid("跨端恢复轻量目录记录字段缺失或格式无效。")
            }
            let articleUpdatedAt: String?
            if let rawUpd = row["articleUpdatedAt"], !(rawUpd is NSNull) {
                guard let text = rawUpd as? String,
                      isValidDateOnly(text) || isValidISOTimestampWithTZ(text) else {
                    throw ServiceError.invalid("跨端恢复目录 articleUpdatedAt 无效。")
                }
                articleUpdatedAt = text
            } else {
                articleUpdatedAt = nil
            }
            let blogURL = try sameSiteURL(pageUrl, siteBaseURL: siteBaseURL)
            let detailDesc = try parseFileDescriptor(row["detail"], maxBytes: maxDesktopDetailBytes, label: "catalog.detail")
            guard detailDesc.url == "client/details/papers/\(detailDesc.sha256).json" else {
                throw ServiceError.invalid("跨端恢复目录详情路径无效。")
            }
            let sourceVersionId: String?
            if let rawSV = row["sourceVersionId"], !(rawSV is NSNull) {
                guard let sv = rawSV as? String, !sv.isEmpty else {
                    throw ServiceError.invalid("跨端恢复目录 sourceVersionId 无效。")
                }
                sourceVersionId = sv
            } else {
                sourceVersionId = nil
            }
            let appEntry = DesktopAppearanceEntry(
                appearanceId: appearanceId,
                blogURL: blogURL.absoluteString,
                pageType: pageType,
                publicationStatus: publicationStatus,
                blogPublishedAt: blogPublishedAt,
                articleUpdatedAt: articleUpdatedAt,
                sourceVersionId: sourceVersionId,
                articleRevisionId: articleRevisionId,
                detail: detailDesc
            )
            if pageType == "daily" || pageType == "conference" {
                guard (row["paperId"] == nil || row["paperId"] is NSNull),
                      row["identityStatus"] as? String == "aggregate-page" else {
                    throw ServiceError.invalid("跨端恢复汇总记录携带非法单篇身份。")
                }
                aggregateDetails[appearanceId] = appEntry
                continue
            }
            guard pageType == "paper",
                  let identityStatus = row["identityStatus"] as? String,
                  !identityStatus.isEmpty else {
                throw ServiceError.invalid("跨端恢复目录包含未知页面类型或缺失 identityStatus。")
            }
            let paperID: String
            if identityStatus == "verified" {
                guard let declaredID = row["paperId"] as? String, !declaredID.isEmpty,
                      let kind = row["sourceKind"] as? String, !kind.isEmpty else {
                    throw ServiceError.invalid("跨端恢复已核验论文缺少 paperId 或 sourceKind。")
                }
                if kind == "arxiv" {
                    guard declaredID.hasPrefix("arxiv:"),
                          DesktopArxivIdentifier.isBase(String(declaredID.dropFirst(6))) else {
                        throw ServiceError.invalid("跨端恢复 arXiv paperId 无效：\(declaredID)")
                    }
                }
                paperID = declaredID
            } else {
                guard row["paperId"] == nil || row["paperId"] is NSNull else {
                    throw ServiceError.invalid("跨端恢复未核验论文不得携带 paperId。")
                }
                let canonicalPath = URLComponents(url: blogURL, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? blogURL.path
                paperID = "page:\(canonicalPath)"
            }

            let sortKey = (blogPublishedAt, articleUpdatedAt ?? "", appEntry.appearanceId)
            if var existingDetail = paperDetails[paperID],
               let prevKey = primarySortKeyByPaperID[paperID] {
                var allEntries = existingDetail.appearances
                allEntries.append(appEntry)
                allEntries.sort { $0.appearanceId < $1.appearanceId }
                if sortKey > prevKey {
                    primarySortKeyByPaperID[paperID] = sortKey
                    existingDetail.primaryAppearanceId = appEntry.appearanceId
                    existingDetail.primaryBlogURL = appEntry.blogURL
                    existingDetail.primaryArticleRevisionId = appEntry.articleRevisionId
                    existingDetail.primaryPublicationStatus = appEntry.publicationStatus
                    existingDetail.primaryDetail = appEntry.detail
                }
                existingDetail.appearances = allEntries
                paperDetails[paperID] = existingDetail
            } else {
                primarySortKeyByPaperID[paperID] = sortKey
                paperDetails[paperID] = DesktopPaperDetailEntry(
                    paperID: paperID,
                    primaryAppearanceId: appEntry.appearanceId,
                    primaryBlogURL: appEntry.blogURL,
                    primaryArticleRevisionId: appEntry.articleRevisionId,
                    primaryPublicationStatus: appEntry.publicationStatus,
                    primaryDetail: appEntry.detail,
                    appearances: [appEntry]
                )
            }
        }

        guard paperDetails.count == expectedPaperCount,
              witnessPrimary.count == expectedPaperCount else {
            throw ServiceError.invalid("跨端恢复去重论文数与快照或 Android 状态见证不一致。")
        }
        let totalPaperAppearances = paperDetails.values.reduce(0) { $0 + $1.appearances.count }
        guard witnessAppearances.count == totalPaperAppearances else {
            throw ServiceError.invalid("跨端恢复出现记录数与 Android 状态见证不一致。")
        }
        for (paperKey, witnessAppId) in witnessPrimary {
            guard var entry = paperDetails[paperKey],
                  let matched = entry.appearances.first(where: { $0.appearanceId == witnessAppId }) else {
                throw ServiceError.invalid("跨端 Android 状态见证指向不存在的论文或出现记录：\(paperKey)")
            }
            entry.primaryAppearanceId = matched.appearanceId
            entry.primaryBlogURL = matched.blogURL
            entry.primaryArticleRevisionId = matched.articleRevisionId
            entry.primaryPublicationStatus = matched.publicationStatus
            entry.primaryDetail = matched.detail
            paperDetails[paperKey] = entry
        }

        // 5. Validate tombstones & import optional Android tombstone history
        let tombstoneRequiredKeys: Set<String> = [
            "appearanceId", "paperId", "previousArticleRevisionId", "reason",
            "effectiveAt", "sourceCommit", "replacementAppearanceId", "evidenceUrl", "note"
        ]
        var seenTombIDs = Set<String>()
        var activeTombstones: [DesktopTombstoneRecord] = []
        for tomb in allTombstoneRows {
            guard Set(tomb.keys).isSuperset(of: tombstoneRequiredKeys),
                  let appearanceId = tomb["appearanceId"] as? String,
                  isValidAppearanceID(appearanceId),
                  seenTombIDs.insert(appearanceId).inserted,
                  !activeAppearanceIDs.contains(appearanceId),
                  let prevRev = tomb["previousArticleRevisionId"] as? String,
                  isValidSHA256(prevRev),
                  let reason = tomb["reason"] as? String,
                  ["site-removed", "retracted", "replaced"].contains(reason),
                  let effectiveAt = tomb["effectiveAt"] as? String,
                  isValidISOTimestampWithTZ(effectiveAt),
                  let tombCommit = tomb["sourceCommit"] as? String,
                  isValidCommitOID(tombCommit) else {
                throw ServiceError.invalid("跨端恢复删除记录无效或与活跃目录重叠。")
            }
            let tombPaperId = (tomb["paperId"] is NSNull) ? nil : (tomb["paperId"] as? String)
            let replId = (tomb["replacementAppearanceId"] is NSNull) ? nil : (tomb["replacementAppearanceId"] as? String)
            let evidenceUrl = try optionalVerifiedHTTPS(tomb["evidenceUrl"], label: "tombstone.evidenceUrl")
            let noteText = nonemptyString(tomb["note"])
            if reason == "retracted" {
                guard evidenceUrl != nil, noteText != nil else {
                    throw ServiceError.invalid("跨端恢复撤稿记录缺少证据链接或说明。")
                }
            } else if reason == "replaced" {
                guard let replId, activeAppearanceIDs.contains(replId) else {
                    throw ServiceError.invalid("跨端恢复替换记录未指向活跃目录条目。")
                }
            } else {
                guard replId == nil else {
                    throw ServiceError.invalid("跨端恢复普通移除记录不得包含 replacementAppearanceId。")
                }
            }
            activeTombstones.append(DesktopTombstoneRecord(
                appearanceId: appearanceId,
                paperId: tombPaperId,
                previousArticleRevisionId: prevRev,
                reason: reason,
                effectiveAt: effectiveAt,
                sourceCommit: tombCommit,
                replacementAppearanceId: replId,
                evidenceUrl: evidenceUrl,
                note: noteText
            ))
        }
        activeTombstones.sort { $0.appearanceId < $1.appearanceId }

        let fallbackTimestamp = (snapshot.summary.syncedAt.flatMap { isValidISOTimestampWithTZ($0) ? $0 : nil }) ?? "1970-01-01T00:00:00Z"
        var importedHistory: [DesktopTombstoneEvent] = []
        var foundAndroidTombstoneState = false
        for candidateRel in [
            "desktop-details/tombstone-states/\(snapshotId)-\(epoch).json",
            "desktop-details/android-tombstone-states/\(snapshotId)-\(epoch).json"
        ] {
            if let tombHit = try verifiedOptionalLocalFile(relative: candidateRel, directory: directory, maxBytes: 32 * 1024 * 1024) {
                foundAndroidTombstoneState = true
                let tombStateObj = try parseUTF8JSONObject(tombHit.bytes, label: candidateRel)
                guard tombStateObj["format"] as? String == DesktopDetailsState.androidTombstoneFormat,
                      (try? strictNonNegativeInt(tombStateObj["version"], label: "androidTombstone.version")) == 1,
                      tombStateObj["latestSnapshotId"] as? String == snapshotId,
                      tombStateObj["validationEpoch"] as? String == epoch,
                      let rawEvents = tombStateObj["events"] as? [[String: Any]] else {
                    throw ServiceError.invalid("跨端 Android 删除历史状态文件格式或验证代不匹配。")
                }
                for ev in rawEvents {
                    guard let eventType = ev["eventType"] as? String,
                          ["tombstone", "restored"].contains(eventType),
                          let appId = ev["appearanceId"] as? String,
                          isValidAppearanceID(appId),
                          let evCommit = ev["sourceCommit"] as? String,
                          isValidCommitOID(evCommit) else {
                        throw ServiceError.invalid("跨端 Android 删除历史事件记录无效。")
                    }
                    let obsSnap = (ev["snapshotId"] as? String).flatMap { isValidSHA256($0) ? $0 : nil } ?? snapshotId
                    let obsAt = nonemptyString(ev["observedAt"]) ?? fallbackTimestamp
                    let effAt = nonemptyString(ev["effectiveAt"]) ?? obsAt
                    importedHistory.append(DesktopTombstoneEvent(
                        kind: eventType == "tombstone" ? "removed" : "restored",
                        appearanceId: appId,
                        paperId: nonemptyString(ev["paperId"]),
                        previousArticleRevisionId: nonemptyString(ev["previousArticleRevisionId"]),
                        restoredArticleRevisionId: nonemptyString(ev["articleRevisionId"]),
                        reason: nonemptyString(ev["reason"]),
                        effectiveAt: effAt,
                        sourceCommit: evCommit,
                        replacementAppearanceId: nonemptyString(ev["replacementAppearanceId"]),
                        evidenceUrl: try optionalVerifiedHTTPS(ev["evidenceUrl"], label: "event.evidenceUrl"),
                        note: nonemptyString(ev["note"]),
                        observedSnapshotId: obsSnap,
                        observedAt: obsAt
                    ))
                }
                break
            }
        }
        if !foundAndroidTombstoneState {
            for tomb in activeTombstones {
                importedHistory.append(DesktopTombstoneEvent(
                    kind: "removed",
                    appearanceId: tomb.appearanceId,
                    paperId: tomb.paperId,
                    previousArticleRevisionId: tomb.previousArticleRevisionId,
                    restoredArticleRevisionId: nil,
                    reason: tomb.reason,
                    effectiveAt: tomb.effectiveAt,
                    sourceCommit: tomb.sourceCommit,
                    replacementAppearanceId: tomb.replacementAppearanceId,
                    evidenceUrl: tomb.evidenceUrl,
                    note: tomb.note,
                    observedSnapshotId: snapshotId,
                    observedAt: fallbackTimestamp
                ))
            }
        }

        return DesktopDetailsState(
            snapshotID: snapshotId,
            validationEpoch: epoch,
            sourceCommit: sourceCommit,
            generatedAt: fallbackTimestamp,
            basePath: expectedSiteBasePath(siteBaseURL),
            paperDetails: paperDetails,
            aggregateDetails: aggregateDetails,
            activeTombstones: activeTombstones,
            tombstoneHistory: importedHistory
        )
    }

    static func loadDesktopDetailsState(directory: URL, snapshot: StoredSnapshot, siteBaseURL: URL) throws -> DesktopDetailsState? {
        let isDesktopManifestSnapshot = snapshot.summary.syncProtocol == ClientProtocols.contract("paper-desktop-manifest")
        if isDesktopManifestSnapshot {
            guard let epoch = snapshot.validationEpoch, !epoch.isEmpty else {
                throw ServiceError.invalid("本机桌面快照缺少 validationEpoch，拒绝载入不完整目录。")
            }
            // 1. Primary macOS state location: desktop-details/macos-states/<snapshotID>-<epoch>.json
            let macosRel = try desktopDetailsStateRelativePath(snapshotID: snapshot.summary.snapshotID, validationEpoch: epoch)
            if let hit = try verifiedOptionalLocalFile(relative: macosRel, directory: directory, maxBytes: 32 * 1024 * 1024) {
                return try decodeVerifiedMacOSStateBytes(hit.bytes, expectedSnapshotID: snapshot.summary.snapshotID, expectedEpoch: epoch)
            }
            // 2. Shared states/<snapshotID>-<epoch>.json: either Round 2 macOS state OR portable Android backup witness
            let sharedRel = "desktop-details/states/\(snapshot.summary.snapshotID)-\(epoch).json"
            if let hit = try verifiedOptionalLocalFile(relative: sharedRel, directory: directory, maxBytes: 64 * 1024 * 1024) {
                let obj = try parseUTF8JSONObject(hit.bytes, label: sharedRel)
                if obj["format"] as? String == DesktopDetailsState.androidFormat {
                    return try reconstructDesktopDetailsStateFromAndroidWitness(witnessObj: obj, directory: directory, snapshot: snapshot, siteBaseURL: siteBaseURL)
                }
                if obj["format"] == nil && (obj["contract"] == nil || obj["contract"] as? String == DesktopDetailsState.macosContract) {
                    return try decodeVerifiedMacOSStateBytes(hit.bytes, expectedSnapshotID: snapshot.summary.snapshotID, expectedEpoch: epoch)
                }
                throw ServiceError.invalid("桌面详情状态文件协议头未知或被篡改：\(sharedRel)")
            }
            // 3. Dedicated Android witness location if present
            let androidRel = "desktop-details/android-states/\(snapshot.summary.snapshotID)-\(epoch).json"
            if let hit = try verifiedOptionalLocalFile(relative: androidRel, directory: directory, maxBytes: 64 * 1024 * 1024) {
                let obj = try parseUTF8JSONObject(hit.bytes, label: androidRel)
                guard obj["format"] as? String == DesktopDetailsState.androidFormat else {
                    throw ServiceError.invalid("Android 桌面详情状态文件协议头不匹配：\(androidRel)")
                }
                return try reconstructDesktopDetailsStateFromAndroidWitness(witnessObj: obj, directory: directory, snapshot: snapshot, siteBaseURL: siteBaseURL)
            }
            // 4. Transitional Round 1 single-file macOS state.json ONLY when matching exact snapshotID + epoch
            if let hit = try verifiedOptionalLocalFile(relative: "desktop-details/state.json", directory: directory, maxBytes: 32 * 1024 * 1024) {
                return try decodeVerifiedMacOSStateBytes(hit.bytes, expectedSnapshotID: snapshot.summary.snapshotID, expectedEpoch: epoch)
            }
            throw ServiceError.invalid("本机桌面详情索引文件缺失，原目录保留；请重新同步或从备份恢复。")
        }

        // Legacy/non-desktop snapshot: never fail if absent, still reject symlinks/corruption if present
        guard let hit = try verifiedOptionalLocalFile(relative: "desktop-details/state.json", directory: directory, maxBytes: 32 * 1024 * 1024) else {
            return nil
        }
        guard String(data: hit.bytes, encoding: .utf8) != nil else {
            throw ServiceError.invalid("桌面详情本地索引不是有效 UTF-8。")
        }
        let decoded: DesktopDetailsState
        do {
            decoded = try JSONDecoder().decode(DesktopDetailsState.self, from: hit.bytes)
        } catch {
            throw ServiceError.invalid("桌面详情本地索引损坏（\(error.localizedDescription)），原文件已保留。")
        }
        if let epoch = snapshot.validationEpoch,
           decoded.snapshotID == snapshot.summary.snapshotID,
           decoded.validationEpoch == epoch {
            return decoded
        }
        return nil
    }

    func cleanupDesktopDetailsStateFilesAfterLegacyFallback() {
        let fm = FileManager.default
        for rel in [
            "desktop-details/state.json",
            "desktop-details/macos-states",
            "desktop-details/states",
            "desktop-details/android-states",
            "desktop-details/tombstone-states",
            "desktop-details/android-tombstone-states"
        ] {
            try? fm.removeItem(at: directory.appendingPathComponent(rel))
        }
    }

    func pruneSupersededDesktopDetailsStates(keepingFileName: String) {
        let fm = FileManager.default
        try? fm.removeItem(at: directory.appendingPathComponent("desktop-details/state.json"))
        let macosStatesDir = directory.appendingPathComponent("desktop-details/macos-states", isDirectory: true)
        guard let entries = try? fm.contentsOfDirectory(at: macosStatesDir, includingPropertiesForKeys: nil) else { return }
        for entry in entries where entry.lastPathComponent != keepingFileName {
            try? fm.removeItem(at: entry)
        }
    }

    // MARK: - Primitive Validators

    static func isValidSHA256(_ value: String) -> Bool {
        value.range(of: #"\A[a-f0-9]{64}\z"#, options: .regularExpression) != nil
    }

    static func isValidCommitOID(_ value: String) -> Bool {
        value.range(of: #"\A[a-f0-9]{40}\z"#, options: .regularExpression) != nil
    }

    static func isValidAppearanceID(_ value: String) -> Bool {
        value.range(of: #"\Aposts/[a-z0-9][a-z0-9._-]*/\z"#, options: .regularExpression) != nil
    }

    static func isValidDateOnly(_ value: String) -> Bool {
        guard value.range(of: #"\A[0-9]{4}-[0-9]{2}-[0-9]{2}\z"#, options: .regularExpression) != nil else { return false }
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, parts[0] >= 1970, (1...12).contains(parts[1]), (1...31).contains(parts[2]) else { return false }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let comps = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        guard let date = cal.date(from: comps) else { return false }
        let back = cal.dateComponents([.year, .month, .day], from: date)
        return back.year == parts[0] && back.month == parts[1] && back.day == parts[2]
    }

    static func isValidISOTimestampWithTZ(_ value: String) -> Bool {
        guard value.range(of: #"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})\z"#, options: .regularExpression) != nil else { return false }
        let f1 = ISO8601DateFormatter()
        f1.formatOptions = [.withInternetDateTime]
        if f1.date(from: value) != nil { return true }
        let f2 = ISO8601DateFormatter()
        f2.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f2.date(from: value) != nil
    }

    static func isSafeRelativePath(_ value: String) -> Bool {
        guard !value.isEmpty, !value.hasPrefix("/"), !value.hasPrefix("\\"),
              !value.contains("\\"), !value.contains("?"), !value.contains("#"), !value.contains("%"),
              !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return false }
        let parts = value.split(separator: "/", omittingEmptySubsequences: false)
        guard !parts.isEmpty else { return false }
        for part in parts {
            if part.isEmpty || part == "." || part == ".." { return false }
        }
        return value.range(of: #"\A[A-Za-z0-9._/-]+\z"#, options: .regularExpression) != nil
    }

    static func strictNonNegativeInt(_ raw: Any?, label: String) throws -> Int {
        guard let number = raw as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else {
            throw ServiceError.invalid("\(label) 必须为非负整数。")
        }
        let d = number.doubleValue
        guard d.isFinite, d >= 0, d <= 9_007_199_254_740_991, floor(d) == d,
              let value = Int(exactly: d) else {
            throw ServiceError.invalid("\(label) 超出安全非负整数范围。")
        }
        return value
    }

    static func parseUTF8JSONObject(_ bytes: Data, label: String) throws -> [String: Any] {
        guard String(data: bytes, encoding: .utf8) != nil else {
            throw ServiceError.invalid("\(label) 不是有效 UTF-8 编码。")
        }
        let parsed: Any
        do { parsed = try JSONSerialization.jsonObject(with: bytes) }
        catch { throw ServiceError.invalid("\(label) 不是有效 JSON。") }
        guard let dict = parsed as? [String: Any] else {
            throw ServiceError.invalid("\(label) 顶层必须为 JSON 对象。")
        }
        return dict
    }

    static func parseUTF8JSONArray(_ bytes: Data, label: String) throws -> [[String: Any]] {
        guard String(data: bytes, encoding: .utf8) != nil else {
            throw ServiceError.invalid("\(label) 不是有效 UTF-8 编码。")
        }
        let parsed: Any
        do { parsed = try JSONSerialization.jsonObject(with: bytes) }
        catch { throw ServiceError.invalid("\(label) 不是有效 JSON。") }
        guard let arr = parsed as? [[String: Any]] else {
            throw ServiceError.invalid("\(label) 顶层必须为 JSON 对象数组。")
        }
        return arr
    }

    static func parseFileDescriptor(_ raw: Any?, maxBytes: Int, label: String) throws -> DesktopFileDescriptor {
        guard let dict = raw as? [String: Any],
              let url = dict["url"] as? String,
              isSafeRelativePath(url),
              let sha = dict["sha256"] as? String,
              isValidSHA256(sha) else {
            throw ServiceError.invalid("\(label) 文件描述符格式无效。")
        }
        let bytes = try strictNonNegativeInt(dict["bytes"], label: "\(label).bytes")
        guard bytes > 0, bytes <= maxBytes else {
            throw ServiceError.invalid("\(label) 文件字节数超出允许范围。")
        }
        return DesktopFileDescriptor(url: url, bytes: bytes, sha256: sha)
    }

    static func parseShardDescriptor(_ raw: Any?, expectedPrefix: String, label: String) throws -> DesktopShardDescriptor {
        guard let dict = raw as? [String: Any],
              Set(dict.keys).isSuperset(of: ["url", "bytes", "sha256", "recordCount"]),
              let url = dict["url"] as? String,
              isSafeRelativePath(url),
              let sha = dict["sha256"] as? String,
              isValidSHA256(sha),
              url == "\(expectedPrefix)/\(sha).json" else {
            throw ServiceError.invalid("\(label) 分片描述符路径或 SHA 无效。")
        }
        let bytes = try strictNonNegativeInt(dict["bytes"], label: "\(label).bytes")
        let recordCount = try strictNonNegativeInt(dict["recordCount"], label: "\(label).recordCount")
        guard bytes > 0, bytes <= maxDesktopShardBytes, recordCount > 0 else {
            throw ServiceError.invalid("\(label) 分片大小或记录数无效。")
        }
        return DesktopShardDescriptor(url: url, bytes: bytes, sha256: sha, recordCount: recordCount)
    }

    static func expectedSiteBasePath(_ siteBaseURL: URL) -> String {
        let raw = URLComponents(url: siteBaseURL, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? siteBaseURL.path
        return raw.hasSuffix("/") ? raw : raw + "/"
    }

    private func verifiedCachedFile(relative: String, expectedBytes: Int, expectedSHA256: String) throws -> Data? {
        try Self.verifiedOptionalLocalFile(
            relative: relative,
            directory: directory,
            expectedBytes: expectedBytes,
            maxBytes: expectedBytes,
            expectedSHA256: expectedSHA256
        )?.bytes
    }

    /// Cold-verifies local content-addressed detail JSON, article HTML, and cached assets before
    /// serving a `refresh == false` cached `Article`. Any local corruption or symlink throws
    /// `ServiceError.invalid` fail-closed; genuine `ENOENT` returns `(verified: false, allAssetsPresent: false)`.
    func verifyDesktopArticleFastPath(
        paper: Paper,
        detailEntry: DesktopPaperDetailEntry,
        cached: Article
    ) throws -> (verified: Bool, allAssetsPresent: Bool) {
        let primaryAppearance = detailEntry.appearances.first(where: { $0.appearanceId == detailEntry.primaryAppearanceId })
            ?? DesktopAppearanceEntry(
                appearanceId: detailEntry.primaryAppearanceId,
                blogURL: detailEntry.primaryBlogURL,
                pageType: "paper",
                publicationStatus: detailEntry.primaryPublicationStatus,
                blogPublishedAt: paper.date,
                articleUpdatedAt: nil,
                sourceVersionId: nil,
                articleRevisionId: detailEntry.primaryArticleRevisionId,
                detail: detailEntry.primaryDetail
            )
        guard let detailBytes = try verifiedCachedFile(
            relative: "desktop-details/papers/\(primaryAppearance.detail.sha256).json",
            expectedBytes: primaryAppearance.detail.bytes,
            expectedSHA256: primaryAppearance.detail.sha256
        ) else {
            return (false, false)
        }
        let detail = try Self.parseAndVerifyDesktopDetail(
            detailBytes,
            expectedAppearance: primaryAppearance,
            expectedPaperID: paper.id,
            expectedIdentityStatus: paper.identityStatus
        )
        guard try verifiedCachedFile(
            relative: "desktop-details/articles/\(detail.articleDescriptor.sha256).html",
            expectedBytes: detail.articleDescriptor.bytes,
            expectedSHA256: detail.articleDescriptor.sha256
        ) != nil else {
            return (false, false)
        }
        var allAssetsPresent = cached.resources.count <= 32
        for res in cached.resources {
            guard let localPath = res.localPath, let sha = res.sha256 else {
                allAssetsPresent = false
                continue
            }
            guard Self.isValidSHA256(sha) else {
                throw ServiceError.invalid("本地导读缓存资源 SHA-256 格式无效。")
            }
            if try findVerifiedCachedImageBytes(sha256: sha) != nil {
                continue
            }
            // Check relocated or non-standard path via lstat + SHA verification (throws on symlink/tamper, nil on ENOENT)
            if try reusePreviouslyCachedExternalImage(previous: cached, canonicalURL: res.sourceURL, rawURL: res.sourceURL, expectedSHA256: sha) == nil {
                _ = localPath
                allAssetsPresent = false
            }
        }
        return (true, allAssetsPresent)
    }

    private func fetchOrReuseContentAddressed(
        cacheRelative: String,
        remoteRelativeURL: String,
        expectedBytes: Int,
        maxBytes: Int,
        expectedSHA256: String,
        label: String
    ) async throws -> (bytes: Data, fromCache: Bool) {
        guard expectedBytes > 0, expectedBytes <= maxBytes,
              Self.isValidSHA256(expectedSHA256),
              Self.isSafeRelativePath(remoteRelativeURL) else {
            throw ServiceError.invalid("\(label) 描述符超出安全边界。")
        }
        if let cached = try verifiedCachedFile(relative: cacheRelative, expectedBytes: expectedBytes, expectedSHA256: expectedSHA256) {
            return (cached, true)
        }
        let remoteURL = try sameSite(remoteRelativeURL)
        let downloaded = try await read(remoteURL, limit: maxBytes)
        guard downloaded.count == expectedBytes, Self.sha256(downloaded) == expectedSHA256 else {
            throw ServiceError.invalid("\(label) 实际字节长度或 SHA-256 与清单不符，保留上一份完整资料库。")
        }
        return (downloaded, false)
    }

    // MARK: - Atomic Snapshot Sync (§§3, 7, 8)

    func syncDesktopDetailsIfAvailable(
        identifier: UUID,
        progress: @escaping @Sendable (Progress) -> Void
    ) async throws -> Summary? {
        let manifestURL = siteBaseURL.appendingPathComponent("client/details/manifest.json")
        let manifestBytes: Data
        do {
            manifestBytes = try await read(manifestURL, limit: Self.maxDesktopManifestBytes)
        } catch ServiceError.httpStatus(let status) where status == 404 || status == 410 {
            return nil
        }
        try Task.checkCancellation()

        // Once client/details/manifest.json returns HTTP 200, fail closed on any error — NEVER fall back!
        guard !manifestBytes.isEmpty, manifestBytes.count <= Self.maxDesktopManifestBytes,
              let manifestText = String(data: manifestBytes, encoding: .utf8) else {
            throw ServiceError.invalid("桌面详情入口清单超出限额或不是有效 UTF-8。")
        }
        let manifestSelfSHA = Self.sha256(manifestBytes)
        guard !manifestText.localizedCaseInsensitiveContains(manifestSelfSHA) else {
            throw ServiceError.invalid("桌面详情入口清单禁止包含自身 SHA。")
        }
        let manifestObj = try Self.parseUTF8JSONObject(manifestBytes, label: "client/details/manifest.json")
        let manifestRequired: Set<String> = ["snapshotId", "snapshot", "generatedAt", "sourceCommit", "basePath"]
        guard ClientProtocols.hasValidHeader(manifestObj, "paper-desktop-manifest"),
              manifestObj["contract"] as? String == ClientProtocols.contract("paper-desktop-manifest"),
              Set(manifestObj.keys).isSuperset(of: manifestRequired),
              let basePath = manifestObj["basePath"] as? String,
              basePath == Self.expectedSiteBasePath(siteBaseURL),
              let snapshotId = manifestObj["snapshotId"] as? String,
              Self.isValidSHA256(snapshotId),
              let sourceCommit = manifestObj["sourceCommit"] as? String,
              Self.isValidCommitOID(sourceCommit),
              let generatedAt = manifestObj["generatedAt"] as? String,
              Self.isValidISOTimestampWithTZ(generatedAt) else {
            throw ServiceError.invalid("桌面详情入口清单协议头、部署前缀或快照身份无效。")
        }
        let snapshotDesc = try Self.parseFileDescriptor(manifestObj["snapshot"], maxBytes: Self.maxDesktopSnapshotBytes, label: "manifest.snapshot")
        guard snapshotDesc.sha256 == snapshotId,
              snapshotDesc.url == "client/details/snapshots/\(snapshotId).json" else {
            throw ServiceError.invalid("桌面详情入口清单的快照描述符与 snapshotId 不一致。")
        }

        // Download or reuse content-addressed snapshot JSON, verifying raw bytes BEFORE parsing JSON
        let (snapshotBytes, snapshotFromCache) = try await fetchOrReuseContentAddressed(
            cacheRelative: "desktop-details/snapshots/\(snapshotId).json",
            remoteRelativeURL: snapshotDesc.url,
            expectedBytes: snapshotDesc.bytes,
            maxBytes: Self.maxDesktopSnapshotBytes,
            expectedSHA256: snapshotId,
            label: "桌面快照 \(snapshotId)"
        )
        try Task.checkCancellation()
        guard let snapshotText = String(data: snapshotBytes, encoding: .utf8) else {
            throw ServiceError.invalid("桌面快照不是有效 UTF-8。")
        }
        guard !snapshotText.localizedCaseInsensitiveContains(snapshotId) else {
            throw ServiceError.invalid("桌面快照禁止包含自身 SHA。")
        }
        let snapshotObj = try Self.parseUTF8JSONObject(snapshotBytes, label: snapshotDesc.url)
        let snapshotRequired: Set<String> = [
            "sourceCommit", "catalogShards", "recordCount", "paperCount",
            "appearanceCount", "tombstoneShards", "tombstoneCount", "tagCatalogs"
        ]
        guard ClientProtocols.hasValidHeader(snapshotObj, "paper-desktop-snapshot"),
              snapshotObj["contract"] as? String == ClientProtocols.contract("paper-desktop-snapshot"),
              Set(snapshotObj.keys).isSuperset(of: snapshotRequired),
              snapshotObj["sourceCommit"] as? String == sourceCommit else {
            throw ServiceError.invalid("桌面快照协议头、指纹或 sourceCommit 与入口清单不符。")
        }
        let expectedRecordCount = try Self.strictNonNegativeInt(snapshotObj["recordCount"], label: "snapshot.recordCount")
        let expectedPaperCount = try Self.strictNonNegativeInt(snapshotObj["paperCount"], label: "snapshot.paperCount")
        let expectedAppearanceCount = try Self.strictNonNegativeInt(snapshotObj["appearanceCount"], label: "snapshot.appearanceCount")
        let expectedTombstoneCount = try Self.strictNonNegativeInt(snapshotObj["tombstoneCount"], label: "snapshot.tombstoneCount")
        guard expectedRecordCount > 0,
              expectedAppearanceCount == expectedRecordCount,
              expectedPaperCount > 0,
              expectedPaperCount <= expectedRecordCount else {
            throw ServiceError.invalid("桌面快照记录计数与出现计数不一致。")
        }

        guard let rawCatalogShards = snapshotObj["catalogShards"] as? [Any],
              !rawCatalogShards.isEmpty,
              rawCatalogShards.count <= Self.maxDesktopShards else {
            throw ServiceError.invalid("桌面快照目录分片数量超出允许范围。")
        }
        var catalogShards: [DesktopShardDescriptor] = []
        var seenCatalogURLs = Set<String>()
        var catalogTotalBytes = 0
        var catalogShardRowsSum = 0
        for rawShard in rawCatalogShards {
            let shard = try Self.parseShardDescriptor(rawShard, expectedPrefix: "client/details/catalog", label: "catalogShard")
            guard seenCatalogURLs.insert(shard.url).inserted else {
                throw ServiceError.invalid("桌面快照存在重复目录分片地址。")
            }
            catalogTotalBytes += shard.bytes
            catalogShardRowsSum += shard.recordCount
            catalogShards.append(shard)
        }
        guard catalogTotalBytes <= Self.maxDesktopTotalCatalogBytes,
              catalogShardRowsSum == expectedRecordCount else {
            throw ServiceError.invalid("桌面快照目录分片总字节超限或记录总数不闭合。")
        }

        guard let rawTombstoneShards = snapshotObj["tombstoneShards"] as? [Any] else {
            throw ServiceError.invalid("桌面快照缺少 tombstoneShards 数组。")
        }
        var tombstoneShards: [DesktopShardDescriptor] = []
        if expectedTombstoneCount == 0 {
            guard rawTombstoneShards.isEmpty else {
                throw ServiceError.invalid("桌面快照 tombstoneCount 为 0 但包含非空分片。")
            }
        } else {
            guard !rawTombstoneShards.isEmpty, rawTombstoneShards.count <= Self.maxDesktopShards else {
                throw ServiceError.invalid("桌面快照删除记录分片数量无效。")
            }
            var seenTombURLs = Set<String>()
            var tombTotalBytes = 0
            var tombRowsSum = 0
            for rawShard in rawTombstoneShards {
                let shard = try Self.parseShardDescriptor(rawShard, expectedPrefix: "client/details/tombstones", label: "tombstoneShard")
                guard seenTombURLs.insert(shard.url).inserted else {
                    throw ServiceError.invalid("桌面快照存在重复删除记录分片。")
                }
                tombTotalBytes += shard.bytes
                tombRowsSum += shard.recordCount
                tombstoneShards.append(shard)
            }
            guard tombTotalBytes <= Self.maxDesktopTotalCatalogBytes,
                  tombRowsSum == expectedTombstoneCount else {
                throw ServiceError.invalid("桌面快照删除记录分片总字节超限或数量不闭合。")
            }
        }

        // Stage everything into an isolated staging directory before touching live catalog state
        let detailsRoot = directory.appendingPathComponent("desktop-details", isDirectory: true)
        try FileManager.default.createDirectory(at: detailsRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let stagingDir = detailsRoot.appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: stagingDir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: stagingDir) }

        if !snapshotFromCache {
            try atomicWrite(snapshotBytes, to: stagingDir.appendingPathComponent("snapshots/\(snapshotId).json"))
        }

        // Verify and stage paired tagCatalogs (websiteTaxonomy)
        let (websiteTaxonomy, conceptsByID, currentRegistrySHA, stagedTaxonomyFiles) = try await fetchAndVerifyDesktopTagCatalogs(snapshotObj["tagCatalogs"])
        for (sha, bytes) in stagedTaxonomyFiles {
            try atomicWrite(bytes, to: stagingDir.appendingPathComponent("taxonomy/\(sha).json"))
        }

        // Stage and verify all catalogShards
        var allCatalogRows: [[String: Any]] = []
        allCatalogRows.reserveCapacity(expectedRecordCount)
        var preparedShards: [String: PublishedAggregateReader.PreparedShard] = [:]
        var preparedBytes = 0
        for (idx, shard) in catalogShards.enumerated() {
            try Task.checkCancellation()
            let (bytes, fromCache) = try await fetchOrReuseContentAddressed(
                cacheRelative: "desktop-details/catalog/\(shard.sha256).json",
                remoteRelativeURL: shard.url,
                expectedBytes: shard.bytes,
                maxBytes: Self.maxDesktopShardBytes,
                expectedSHA256: shard.sha256,
                label: "桌面目录分片 \(shard.url)"
            )
            let rows = try Self.parseUTF8JSONArray(bytes, label: shard.url)
            guard rows.count == shard.recordCount else {
                throw ServiceError.invalid("桌面目录分片记录条数与清单声明不符。")
            }
            if !fromCache {
                try atomicWrite(bytes, to: stagingDir.appendingPathComponent("catalog/\(shard.sha256).json"))
            }
            allCatalogRows.append(contentsOf: rows)
            preparedShards[shard.url] = PublishedAggregateReader.PreparedShard(bytes: bytes, rows: rows)
            preparedBytes += bytes.count
            progress(Progress(phase: "catalog", message: "正在同步论文目录（\(idx + 1)/\(catalogShards.count) 分片）", completed: idx + 1, total: catalogShards.count))
        }
        guard allCatalogRows.count == expectedRecordCount, allCatalogRows.count == expectedAppearanceCount else {
            throw ServiceError.invalid("桌面目录分片总记录数与快照声明不一致。")
        }

        // Stage and verify all tombstoneShards
        var allTombstoneRows: [[String: Any]] = []
        allTombstoneRows.reserveCapacity(expectedTombstoneCount)
        for shard in tombstoneShards {
            try Task.checkCancellation()
            let (bytes, fromCache) = try await fetchOrReuseContentAddressed(
                cacheRelative: "desktop-details/tombstones/\(shard.sha256).json",
                remoteRelativeURL: shard.url,
                expectedBytes: shard.bytes,
                maxBytes: Self.maxDesktopShardBytes,
                expectedSHA256: shard.sha256,
                label: "桌面删除分片 \(shard.url)"
            )
            let rows = try Self.parseUTF8JSONArray(bytes, label: shard.url)
            guard rows.count == shard.recordCount else {
                throw ServiceError.invalid("桌面删除分片记录条数与声明不符。")
            }
            if !fromCache {
                try atomicWrite(bytes, to: stagingDir.appendingPathComponent("tombstones/\(shard.sha256).json"))
            }
            allTombstoneRows.append(contentsOf: rows)
        }
        guard allTombstoneRows.count == expectedTombstoneCount else {
            throw ServiceError.invalid("桌面删除记录总数与快照声明不一致。")
        }

        // Parse catalog rows: separate aggregate pages from Paper entries, deduplicate multi-appearance papers
        let catalogRequiredKeys: Set<String> = [
            "appearanceId", "paperId", "identityStatus", "sourceKind", "sourceVersionId",
            "pageType", "publicationStatus", "title", "titleZh", "summary",
            "blogPublishedAt", "articleUpdatedAt", "pageUrl", "score",
            "tagConceptIds", "articleRevisionId", "detail"
        ]
        var activeAppearanceIDs = Set<String>()
        var activeRowsByAppearance: [String: (paperId: String?, revisionId: String)] = [:]
        var papersByID: [String: Paper] = [:]
        var primarySortKeyByPaperID: [String: (String, String, String)] = [:]
        var paperDetails: [String: DesktopPaperDetailEntry] = [:]
        var aggregateDetails: [String: DesktopAppearanceEntry] = [:]

        for row in allCatalogRows {
            try Task.checkCancellation()
            guard Set(row.keys).isSuperset(of: catalogRequiredKeys),
                  let appearanceId = row["appearanceId"] as? String,
                  Self.isValidAppearanceID(appearanceId),
                  activeAppearanceIDs.insert(appearanceId).inserted,
                  let pageUrl = row["pageUrl"] as? String,
                  pageUrl == appearanceId,
                  let pageType = row["pageType"] as? String,
                  let publicationStatus = row["publicationStatus"] as? String,
                  ["active", "retracted"].contains(publicationStatus),
                  let blogPublishedAt = row["blogPublishedAt"] as? String,
                  Self.isValidDateOnly(blogPublishedAt),
                  let articleRevisionId = row["articleRevisionId"] as? String,
                  Self.isValidSHA256(articleRevisionId),
                  let tagConceptIds = row["tagConceptIds"] as? [String] else {
                throw ServiceError.invalid("桌面轻量目录记录字段缺失、重复或格式无效。")
            }
            let articleUpdatedAt: String?
            if let rawUpdated = row["articleUpdatedAt"], !(rawUpdated is NSNull) {
                guard let text = rawUpdated as? String,
                      Self.isValidDateOnly(text) || Self.isValidISOTimestampWithTZ(text) else {
                    throw ServiceError.invalid("桌面轻量目录 articleUpdatedAt 时间格式无效。")
                }
                articleUpdatedAt = text
            } else {
                articleUpdatedAt = nil
            }
            let blogURL = try sameSite(pageUrl)
            let detailDesc = try Self.parseFileDescriptor(row["detail"], maxBytes: Self.maxDesktopDetailBytes, label: "catalog.detail")
            guard detailDesc.url == "client/details/papers/\(detailDesc.sha256).json" else {
                throw ServiceError.invalid("桌面轻量目录详情路径必须为内容寻址路径。")
            }
            let sourceVersionId: String?
            if let rawSV = row["sourceVersionId"], !(rawSV is NSNull) {
                guard let sv = rawSV as? String, !sv.isEmpty else {
                    throw ServiceError.invalid("桌面轻量目录 sourceVersionId 格式无效。")
                }
                sourceVersionId = sv
            } else {
                sourceVersionId = nil
            }
            let appearanceEntry = DesktopAppearanceEntry(
                appearanceId: appearanceId,
                blogURL: blogURL.absoluteString,
                pageType: pageType,
                publicationStatus: publicationStatus,
                blogPublishedAt: blogPublishedAt,
                articleUpdatedAt: articleUpdatedAt,
                sourceVersionId: sourceVersionId,
                articleRevisionId: articleRevisionId,
                detail: detailDesc
            )

            if pageType == "daily" || pageType == "conference" {
                guard (row["paperId"] == nil || row["paperId"] is NSNull),
                      row["identityStatus"] as? String == "aggregate-page" else {
                    throw ServiceError.invalid("桌面目录汇总页面不能声明单篇论文身份。")
                }
                aggregateDetails[appearanceId] = appearanceEntry
                activeRowsByAppearance[appearanceId] = (nil, articleRevisionId)
                continue
            }
            guard pageType == "paper" else {
                throw ServiceError.invalid("桌面轻量目录包含未知页面类型：\(pageType)")
            }

            let parsedPaper = try buildPaperFromDesktopCatalogRow(
                row,
                blogURL: blogURL,
                appearanceEntry: appearanceEntry,
                tagConceptIds: tagConceptIds,
                conceptsByID: conceptsByID,
                currentRegistrySHA: currentRegistrySHA
            )
            activeRowsByAppearance[appearanceId] = (parsedPaper.id, articleRevisionId)
            let sortKey = (blogPublishedAt, articleUpdatedAt ?? "", appearanceEntry.appearanceId)

            if var existing = papersByID[parsedPaper.id],
               var existingDetail = paperDetails[parsedPaper.id],
               let prevKey = primarySortKeyByPaperID[parsedPaper.id] {
                let mergedAppearances = Array(Set(existing.appearances + parsedPaper.appearances)).sorted()
                let mergedTagRecords = (existing.websiteTagRecords ?? []) + (parsedPaper.websiteTagRecords ?? [])
                var allEntries = existingDetail.appearances
                allEntries.append(appearanceEntry)
                allEntries.sort { $0.appearanceId < $1.appearanceId }
                if sortKey > prevKey {
                    existing = parsedPaper
                    primarySortKeyByPaperID[parsedPaper.id] = sortKey
                    existingDetail.primaryAppearanceId = appearanceEntry.appearanceId
                    existingDetail.primaryBlogURL = appearanceEntry.blogURL
                    existingDetail.primaryArticleRevisionId = appearanceEntry.articleRevisionId
                    existingDetail.primaryPublicationStatus = appearanceEntry.publicationStatus
                    existingDetail.primaryDetail = appearanceEntry.detail
                }
                existing.appearances = mergedAppearances
                existing.websiteTagRecords = mergedTagRecords
                existingDetail.appearances = allEntries
                papersByID[parsedPaper.id] = existing
                paperDetails[parsedPaper.id] = existingDetail
            } else {
                papersByID[parsedPaper.id] = parsedPaper
                primarySortKeyByPaperID[parsedPaper.id] = sortKey
                paperDetails[parsedPaper.id] = DesktopPaperDetailEntry(
                    paperID: parsedPaper.id,
                    primaryAppearanceId: appearanceEntry.appearanceId,
                    primaryBlogURL: appearanceEntry.blogURL,
                    primaryArticleRevisionId: appearanceEntry.articleRevisionId,
                    primaryPublicationStatus: appearanceEntry.publicationStatus,
                    primaryDetail: appearanceEntry.detail,
                    appearances: [appearanceEntry]
                )
            }
        }

        guard !papersByID.isEmpty, papersByID.count == expectedPaperCount else {
            throw ServiceError.invalid("桌面目录去重论文数（\(papersByID.count)）与快照声明（\(expectedPaperCount)）不一致。")
        }

        // Validate tombstones & verify disjointness with activeAppearanceIDs (§7)
        let tombstoneRequiredKeys: Set<String> = [
            "appearanceId", "paperId", "previousArticleRevisionId", "reason",
            "effectiveAt", "sourceCommit", "replacementAppearanceId", "evidenceUrl", "note"
        ]
        var seenTombstoneAppearanceIDs = Set<String>()
        var activeTombstones: [DesktopTombstoneRecord] = []
        activeTombstones.reserveCapacity(expectedTombstoneCount)
        for tomb in allTombstoneRows {
            guard Set(tomb.keys).isSuperset(of: tombstoneRequiredKeys),
                  let appearanceId = tomb["appearanceId"] as? String,
                  Self.isValidAppearanceID(appearanceId),
                  seenTombstoneAppearanceIDs.insert(appearanceId).inserted,
                  !activeAppearanceIDs.contains(appearanceId),
                  let prevRev = tomb["previousArticleRevisionId"] as? String,
                  Self.isValidSHA256(prevRev),
                  let reason = tomb["reason"] as? String,
                  ["site-removed", "retracted", "replaced"].contains(reason),
                  let effectiveAt = tomb["effectiveAt"] as? String,
                  Self.isValidISOTimestampWithTZ(effectiveAt),
                  let tombCommit = tomb["sourceCommit"] as? String,
                  Self.isValidCommitOID(tombCommit) else {
                throw ServiceError.invalid("桌面快照删除记录格式无效或与活跃目录冲突。")
            }
            let tombPaperId: String?
            if let rawPid = tomb["paperId"], !(rawPid is NSNull) {
                guard let pid = rawPid as? String, !pid.isEmpty else {
                    throw ServiceError.invalid("删除记录 paperId 字段格式无效。")
                }
                tombPaperId = pid
            } else {
                tombPaperId = nil
            }
            let replId: String?
            if let rawRepl = tomb["replacementAppearanceId"], !(rawRepl is NSNull) {
                guard let r = rawRepl as? String, !r.isEmpty else {
                    throw ServiceError.invalid("删除记录 replacementAppearanceId 格式无效。")
                }
                replId = r
            } else {
                replId = nil
            }
            let evidenceUrl: String?
            if let rawEv = tomb["evidenceUrl"], !(rawEv is NSNull) {
                guard let ev = rawEv as? String, cleanHTTPS(ev) != nil else {
                    throw ServiceError.invalid("删除记录 evidenceUrl 必须为合法 HTTPS 链接。")
                }
                evidenceUrl = ev
            } else {
                evidenceUrl = nil
            }
            let noteText: String?
            if let rawNote = tomb["note"], !(rawNote is NSNull) {
                guard let n = rawNote as? String else {
                    throw ServiceError.invalid("删除记录 note 格式无效。")
                }
                let trimmed = n.trimmingCharacters(in: .whitespacesAndNewlines)
                noteText = trimmed.isEmpty ? nil : trimmed
            } else {
                noteText = nil
            }

            if reason == "retracted" {
                guard evidenceUrl != nil, noteText != nil else {
                    throw ServiceError.invalid("正式撤稿记录必须提供真实 HTTPS evidenceUrl 与说明。")
                }
            } else if reason == "replaced" {
                guard let replId, activeAppearanceIDs.contains(replId) else {
                    throw ServiceError.invalid("替换记录必须指向当前活跃目录中的 replacementAppearanceId。")
                }
            } else {
                guard replId == nil else {
                    throw ServiceError.invalid("普通移除记录不得携带 replacementAppearanceId。")
                }
            }

            activeTombstones.append(DesktopTombstoneRecord(
                appearanceId: appearanceId,
                paperId: tombPaperId,
                previousArticleRevisionId: prevRev,
                reason: reason,
                effectiveAt: effectiveAt,
                sourceCommit: tombCommit,
                replacementAppearanceId: replId,
                evidenceUrl: evidenceUrl,
                note: noteText
            ))
        }
        activeTombstones.sort { $0.appearanceId < $1.appearanceId }

        // Build traceable tombstone history from the active desktop-details epoch only
        let priorState = activeDesktopDetails()
        var tombstoneHistory = priorState?.tombstoneHistory ?? []
        let syncedAt = Self.now()
        let priorActiveByAppearance = Dictionary(uniqueKeysWithValues: (priorState?.activeTombstones ?? []).map { ($0.appearanceId, $0) })

        for oldTomb in (priorState?.activeTombstones ?? []) where activeAppearanceIDs.contains(oldTomb.appearanceId) {
            let activeInfo = activeRowsByAppearance[oldTomb.appearanceId]
            tombstoneHistory.append(DesktopTombstoneEvent(
                kind: "restored",
                appearanceId: oldTomb.appearanceId,
                paperId: activeInfo?.paperId ?? oldTomb.paperId,
                previousArticleRevisionId: oldTomb.previousArticleRevisionId,
                restoredArticleRevisionId: activeInfo?.revisionId,
                reason: oldTomb.reason,
                effectiveAt: generatedAt,
                sourceCommit: sourceCommit,
                replacementAppearanceId: nil,
                evidenceUrl: nil,
                note: nil,
                observedSnapshotId: snapshotId,
                observedAt: syncedAt
            ))
        }
        for tomb in activeTombstones {
            if let prev = priorActiveByAppearance[tomb.appearanceId],
               prev.reason == tomb.reason,
               prev.previousArticleRevisionId == tomb.previousArticleRevisionId,
               prev.replacementAppearanceId == tomb.replacementAppearanceId,
               prev.evidenceUrl == tomb.evidenceUrl {
                continue
            }
            tombstoneHistory.append(DesktopTombstoneEvent(
                kind: "removed",
                appearanceId: tomb.appearanceId,
                paperId: tomb.paperId,
                previousArticleRevisionId: tomb.previousArticleRevisionId,
                restoredArticleRevisionId: nil,
                reason: tomb.reason,
                effectiveAt: tomb.effectiveAt,
                sourceCommit: tomb.sourceCommit,
                replacementAppearanceId: tomb.replacementAppearanceId,
                evidenceUrl: tomb.evidenceUrl,
                note: tomb.note,
                observedSnapshotId: snapshotId,
                observedAt: syncedAt
            ))
        }

        // Preserve missingFromLatest & retiredPapers without touching personal notes/sessions/mappings
        let currentIDs = Set(papersByID.keys)
        let previousIDs = Set(snapshot.papers.map(\.id))
        let tombPaperIDs = Set(activeTombstones.compactMap { tomb -> String? in
            if let pid = tomb.paperId { return pid }
            guard let blogURL = try? sameSite(tomb.appearanceId) else { return nil }
            let unverifiedPath = URLComponents(url: blogURL, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? blogURL.path
            let unverifiedCandidate = "page:\(unverifiedPath)"
            let knownAll = previousIDs.union(Set((snapshot.retiredPapers ?? []).map(\.id)))
            return knownAll.contains(unverifiedCandidate) ? unverifiedCandidate : nil
        })
        let missing = Set(snapshot.summary.missingFromLatest)
            .union(previousIDs.subtracting(currentIDs))
            .union(tombPaperIDs)
            .subtracting(currentIDs)

        var summary = Summary(
            paperCount: papersByID.count,
            recordCount: expectedRecordCount,
            shardCount: catalogShards.count,
            snapshotID: snapshotId,
            syncedAt: syncedAt,
            source: siteBaseURL.absoluteString,
            syncing: false,
            missingFromLatest: missing.sorted()
        )
        summary.syncProtocol = ClientProtocols.contract("paper-desktop-manifest")
        var replacement = StoredSnapshot(summary: summary, papers: papersByID.values.sorted { $0.id < $1.id })
        replacement.websiteTaxonomy = websiteTaxonomy
        let nextEpoch = UUID().uuidString
        replacement.validationEpoch = nextEpoch
        replacement.retiredPapers = Dictionary(
            (snapshot.papers + (snapshot.retiredPapers ?? []))
                .filter { !currentIDs.contains($0.id) }
                .map { ($0.id, $0) },
            uniquingKeysWith: { a, _ in a }
        ).values.sorted { $0.id < $1.id }

        let newState = DesktopDetailsState(
            snapshotID: snapshotId,
            validationEpoch: nextEpoch,
            sourceCommit: sourceCommit,
            generatedAt: generatedAt,
            basePath: basePath,
            paperDetails: paperDetails,
            aggregateDetails: aggregateDetails,
            activeTombstones: activeTombstones,
            tombstoneHistory: tombstoneHistory
        )

        try Task.checkCancellation()
        guard syncID == identifier else { throw CancellationError() }

        let encodedSnapshot = try JSONEncoder().encode(replacement)
        guard encodedSnapshot.count <= Self.maxTotal else {
            throw ServiceError.invalid("合并后的本地目录超过大小限制。")
        }
        let stateEncoder = JSONEncoder()
        stateEncoder.outputFormatting = [.sortedKeys]
        let encodedState = try stateEncoder.encode(newState)
        let stateRel = try Self.desktopDetailsStateRelativePath(snapshotID: snapshotId, validationEpoch: nextEpoch)
        let stateURL = directory.appendingPathComponent(stateRel)

        // Move staged content-addressed immutable objects into place before staging aggregate store & committing state
        try commitStagedDesktopFiles(from: stagingDir, detailsRoot: detailsRoot)

        let reusableShards = preparedBytes <= 16 * 1024 * 1024 ? preparedShards : nil
        _ = try PublishedAggregateStore(directory: directory, siteBase: siteBaseURL)
            .stage(manifest: snapshotBytes, validationEpoch: nextEpoch, preparedShards: reusableShards)

        try Task.checkCancellation()
        guard syncID == identifier else { throw CancellationError() }

        // Write epoch-scoped state file BEFORE current.json so S1's state file is never overwritten
        // while staging S2; current.json is the single atomic commit point!
        try atomicWriteChecked(encodedState, relative: stateRel)
        do {
            try atomicWriteChecked(encodedSnapshot, relative: "current.json")
        } catch {
            try? FileManager.default.removeItem(at: stateURL)
            throw error
        }

        desktopDetails = newState
        snapshot = replacement
        pruneSupersededDesktopDetailsStates(keepingFileName: stateURL.lastPathComponent)
        promoteLoadPhaseAfterSync()
        progress(Progress(phase: "complete", message: "已同步 \(summary.paperCount) 篇论文，\(summary.recordCount) 条页面记录", completed: catalogShards.count, total: catalogShards.count))
        return summary
    }

    private func commitStagedDesktopFiles(from stagingDir: URL, detailsRoot: URL) throws {
        let fm = FileManager.default
        for subdir in ["snapshots", "catalog", "tombstones"] {
            let srcDir = stagingDir.appendingPathComponent(subdir, isDirectory: true)
            guard fm.fileExists(atPath: srcDir.path) else { continue }
            for file in try fm.contentsOfDirectory(at: srcDir, includingPropertiesForKeys: nil) {
                let data = try Data(contentsOf: file)
                let rel = "desktop-details/\(subdir)/\(file.lastPathComponent)"
                if let existing = try Self.verifiedOptionalLocalFile(relative: rel, directory: directory, maxBytes: Self.maxDesktopShardBytes) {
                    guard existing.bytes == data else {
                        throw ServiceError.invalid("桌面详情内容寻址对象发生字节冲突：\(file.lastPathComponent)")
                    }
                } else {
                    try atomicWriteChecked(data, relative: rel)
                }
            }
        }
        let taxSrc = stagingDir.appendingPathComponent("taxonomy", isDirectory: true)
        if fm.fileExists(atPath: taxSrc.path) {
            for file in try fm.contentsOfDirectory(at: taxSrc, includingPropertiesForKeys: nil) {
                let sha = file.deletingPathExtension().lastPathComponent
                let data = try Data(contentsOf: file)
                let rel = "taxonomy/\(sha).json"
                if let existing = try Self.verifiedOptionalLocalFile(relative: rel, directory: directory, maxBytes: 16 * 1024 * 1024) {
                    guard existing.bytes == data else {
                        throw ServiceError.invalid("分类词表内容寻址对象发生字节冲突：\(sha)")
                    }
                } else {
                    try atomicWriteChecked(data, relative: rel)
                }
            }
        }
    }

    private func fetchAndVerifyDesktopTagCatalogs(
        _ rawTagCatalogs: Any?
    ) async throws -> (taxonomy: JSONValue, concepts: [String: (facet: String, zh: String)], registrySHA: String, staged: [(String, Data)]) {
        guard let container = rawTagCatalogs as? [String: Any],
              let snapDescRaw = container["snapshot"] as? [String: Any],
              let versDescRaw = container["versions"] as? [String: Any] else {
            throw ServiceError.invalid("桌面快照缺少成对的 tagCatalogs 描述符。")
        }
        let snapDesc = try Self.parseFileDescriptor(snapDescRaw, maxBytes: 16 * 1024 * 1024, label: "tagCatalogs.snapshot")
        let versDesc = try Self.parseFileDescriptor(versDescRaw, maxBytes: 16 * 1024 * 1024, label: "tagCatalogs.versions")
        let isClientDataPair = snapDesc.url == "client/data/tag-catalog-snapshot.json" && versDesc.url == "client/data/tag-catalog-versions.json"
        let isLegacyDataPair = snapDesc.url == "data/tag-catalog-snapshot.json" && versDesc.url == "data/tag-catalog-versions.json"
        guard isClientDataPair || isLegacyDataPair else {
            throw ServiceError.invalid("桌面快照 tagCatalogs 路径必须成对位于 client/data/ 或 data/。")
        }

        let snapshotFamily = "paper-tag-catalog-snapshot"
        let versionsFamily = "paper-tag-catalog-versions"
        let expectedSnapContract = isLegacyDataPair
            ? try ClientProtocols.historicalContract(snapshotFamily, variant: "public-concept-hierarchy")
            : ClientProtocols.contract(snapshotFamily)
        let expectedVersContract = isLegacyDataPair
            ? try ClientProtocols.historicalContract(versionsFamily, variant: "sha-keyed-snapshot-set")
            : ClientProtocols.contract(versionsFamily)

        let declaredSnapFP = (snapDescRaw["schemaFingerprint"] is NSNull) ? nil : (snapDescRaw["schemaFingerprint"] as? String)
        let declaredVersFP = (versDescRaw["schemaFingerprint"] is NSNull) ? nil : (versDescRaw["schemaFingerprint"] as? String)
        guard snapDescRaw["contract"] as? String == expectedSnapContract,
              versDescRaw["contract"] as? String == expectedVersContract,
              ClientProtocols.hasValidHeader(expectedSnapContract, fingerprint: declaredSnapFP, snapshotFamily),
              ClientProtocols.hasValidHeader(expectedVersContract, fingerprint: declaredVersFP, versionsFamily),
              let declaredRegistrySHA = snapDescRaw["registrySha256"] as? String,
              Self.isValidSHA256(declaredRegistrySHA),
              versDescRaw["currentSha256"] as? String == declaredRegistrySHA else {
            throw ServiceError.invalid("桌面快照 tagCatalogs 协议头或词表版本不一致。")
        }

        var staged: [(String, Data)] = []
        let snapBytes: Data
        if let cached = try verifiedCachedFile(relative: "taxonomy/\(snapDesc.sha256).json", expectedBytes: snapDesc.bytes, expectedSHA256: snapDesc.sha256) {
            snapBytes = cached
        } else {
            let downloaded = try await read(try sameSite(snapDesc.url), limit: 16 * 1024 * 1024)
            guard downloaded.count == snapDesc.bytes, Self.sha256(downloaded) == snapDesc.sha256 else {
                throw ServiceError.invalid("分类词表快照字节或 SHA 与快照声明不符。")
            }
            snapBytes = downloaded
            staged.append((snapDesc.sha256, downloaded))
        }

        let versBytes: Data
        if let cached = try verifiedCachedFile(relative: "taxonomy/\(versDesc.sha256).json", expectedBytes: versDesc.bytes, expectedSHA256: versDesc.sha256) {
            versBytes = cached
        } else {
            let downloaded = try await read(try sameSite(versDesc.url), limit: 16 * 1024 * 1024)
            guard downloaded.count == versDesc.bytes, Self.sha256(downloaded) == versDesc.sha256 else {
                throw ServiceError.invalid("分类词表版本目录字节或 SHA 与快照声明不符。")
            }
            versBytes = downloaded
            staged.append((versDesc.sha256, downloaded))
        }

        let currentObj = try Self.parseUTF8JSONObject(snapBytes, label: snapDesc.url)
        let versionsObj = try Self.parseUTF8JSONObject(versBytes, label: versDesc.url)
        guard ClientProtocols.hasValidHeader(currentObj, snapshotFamily),
              ClientProtocols.hasValidHeader(versionsObj, versionsFamily),
              currentObj["contract"] as? String == expectedSnapContract,
              versionsObj["contract"] as? String == expectedVersContract,
              currentObj["registrySha256"] as? String == declaredRegistrySHA,
              versionsObj["currentSha256"] as? String == declaredRegistrySHA,
              let conceptsArray = currentObj["concepts"] as? [[String: Any]],
              !conceptsArray.isEmpty,
              let snapshotsArray = versionsObj["snapshots"] as? [[String: Any]],
              !snapshotsArray.isEmpty else {
            throw ServiceError.invalid("网页分类显示资源格式、指纹或概念列表无效。")
        }

        var conceptsByID: [String: (facet: String, zh: String)] = [:]
        conceptsByID.reserveCapacity(conceptsArray.count)
        for item in conceptsArray {
            guard let id = item["id"] as? String, !id.isEmpty,
                  let facet = item["facet"] as? String, !facet.isEmpty,
                  let zh = item["zh"] as? String, !zh.isEmpty else {
                throw ServiceError.invalid("网页分类概念条目缺少必要字段。")
            }
            conceptsByID[id] = (facet: facet, zh: zh)
        }

        let snapFullURL = try sameSite(snapDesc.url).absoluteString
        let versFullURL = try sameSite(versDesc.url).absoluteString
        let taxonomyValue = try JSONValue.from([
            "snapshot": currentObj,
            "versions": versionsObj,
            "snapshotSourceURL": snapFullURL,
            "versionsSourceURL": versFullURL,
            "snapshotContentSHA256": snapDesc.sha256,
            "versionsContentSHA256": versDesc.sha256
        ])
        return (taxonomyValue, conceptsByID, declaredRegistrySHA, staged)
    }

    private func buildPaperFromDesktopCatalogRow(
        _ row: [String: Any],
        blogURL: URL,
        appearanceEntry: DesktopAppearanceEntry,
        tagConceptIds: [String],
        conceptsByID: [String: (facet: String, zh: String)],
        currentRegistrySHA: String
    ) throws -> Paper {
        guard let identityStatus = row["identityStatus"] as? String, !identityStatus.isEmpty else {
            throw ServiceError.invalid("桌面论文记录缺少 identityStatus。")
        }
        let rawSourceKind: String?
        if let sk = row["sourceKind"], !(sk is NSNull) {
            guard let text = sk as? String, !text.isEmpty else {
                throw ServiceError.invalid("桌面论文记录 sourceKind 无效。")
            }
            rawSourceKind = text
        } else {
            rawSourceKind = nil
        }

        let paperID: String
        let effectiveSourceKind: String
        var sourceURL: String? = nil
        var pdfURL: String? = nil
        var sourceVersion: String? = nil
        var pdfSHA256: String? = nil

        if identityStatus == "verified" {
            guard let declaredID = row["paperId"] as? String, !declaredID.isEmpty,
                  let kind = rawSourceKind else {
                throw ServiceError.invalid("已核验桌面论文记录必须提供 paperId 与 sourceKind。")
            }
            effectiveSourceKind = kind
            if kind == "arxiv" {
                guard declaredID.hasPrefix("arxiv:") else {
                    throw ServiceError.invalid("arXiv 论文 paperId 必须以 arxiv: 开头。")
                }
                let base = String(declaredID.dropFirst("arxiv:".count))
                guard DesktopArxivIdentifier.isBase(base) else {
                    throw ServiceError.invalid("arXiv 论文基础编号格式无效：\(declaredID)")
                }
                paperID = declaredID
                if let sv = appearanceEntry.sourceVersionId {
                    if let range = sv.range(of: "@sha256:") {
                        let prefixID = String(sv[..<range.lowerBound])
                        let shaPart = String(sv[range.upperBound...])
                        guard prefixID == declaredID, Self.isValidSHA256(shaPart) else {
                            throw ServiceError.invalid("arXiv SHA 绑定版本身份无效：\(sv)")
                        }
                        pdfSHA256 = shaPart
                        sourceURL = "https://arxiv.org/abs/\(base)"
                    } else if sv.hasPrefix("arxiv:") {
                        let candidate = String(sv.dropFirst("arxiv:".count))
                        guard DesktopArxivIdentifier.base(of: candidate) == base,
                              candidate.range(of: #"v[1-9][0-9]*\z"#, options: .regularExpression) != nil else {
                            throw ServiceError.invalid("arXiv sourceVersionId 与论文基础身份不一致：\(sv)")
                        }
                        sourceVersion = candidate
                        sourceURL = "https://arxiv.org/abs/\(candidate)"
                        pdfURL = "https://arxiv.org/pdf/\(candidate).pdf"
                    } else {
                        throw ServiceError.invalid("不识别的 arXiv sourceVersionId：\(sv)")
                    }
                } else {
                    sourceURL = "https://arxiv.org/abs/\(base)"
                }
            } else {
                paperID = declaredID
                if let sv = appearanceEntry.sourceVersionId {
                    guard let range = sv.range(of: "@sha256:") else {
                        throw ServiceError.invalid("会议论文 sourceVersionId 格式无效：\(sv)")
                    }
                    let prefixID = String(sv[..<range.lowerBound])
                    let shaPart = String(sv[range.upperBound...])
                    guard prefixID == declaredID, Self.isValidSHA256(shaPart) else {
                        throw ServiceError.invalid("会议论文 SHA 绑定版本身份无效：\(sv)")
                    }
                    pdfSHA256 = shaPart
                }
            }
        } else {
            guard row["paperId"] == nil || row["paperId"] is NSNull else {
                throw ServiceError.invalid("未核验论文记录不得携带已核验 paperId。")
            }
            let canonicalPath = URLComponents(url: blogURL, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? blogURL.path
            paperID = "page:\(canonicalPath)"
            effectiveSourceKind = rawSourceKind ?? "unknown"
        }

        guard let rawTitle = row["title"] as? String,
              !rawTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ServiceError.invalid("桌面论文记录缺少标题。")
        }
        let titleZh = (row["titleZh"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? rawTitle
        let summaryText = row["summary"] as? String ?? ""
        let scoreValue: Double?
        if let rawScore = row["score"], !(rawScore is NSNull) {
            guard let parsed = Self.publishedScore(rawScore) else {
                throw ServiceError.invalid("桌面论文记录评分超出 0–10 范围或格式无效。")
            }
            scoreValue = parsed
        } else {
            scoreValue = nil
        }

        var primaryTask = ""
        var primaryTaskId: String? = nil
        var primaryMethod = ""
        var primaryMethodId: String? = nil
        var flatTags: [String] = []
        var tagConcepts: [[String: String]] = []
        for conceptId in tagConceptIds {
            guard let info = conceptsByID[conceptId] else {
                throw ServiceError.invalid("桌面论文记录引用了未在当前词表登记的概念：\(conceptId)")
            }
            flatTags.append(info.zh)
            tagConcepts.append(["id": conceptId, "facet": info.facet, "label": info.zh])
            if info.facet == "task" && primaryTask.isEmpty {
                primaryTask = info.zh
                primaryTaskId = conceptId
            } else if info.facet == "method" && primaryMethod.isEmpty {
                primaryMethod = info.zh
                primaryMethodId = conceptId
            }
        }

        let permalinkPath = URLComponents(url: blogURL, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? blogURL.path
        var citationFields: [String: Any] = [
            "paperKey": paperID,
            "paperId": identityStatus == "verified" && effectiveSourceKind != "arxiv" ? paperID : "",
            "identityStatus": identityStatus,
            "verified": identityStatus == "verified",
            "complete": false,
            "sourceKind": identityStatus == "verified" ? effectiveSourceKind : (rawSourceKind ?? ""),
            "title": rawTitle,
            "authors": [String](),
            "date": "",
            "doi": "",
            "venue": "",
            "arxivId": sourceVersion ?? (paperID.hasPrefix("arxiv:") ? String(paperID.dropFirst(6)) : ""),
            "url": sourceURL ?? "",
            "sourceUrl": sourceURL ?? "",
            "pdfUrl": pdfURL ?? "",
            "pageUrl": blogURL.absoluteString,
            "pageType": "paper"
        ]
        let defaultCitation = try ClientProtocols.record("paper-citation-source", fields: citationFields)
        citationFields = defaultCitation

        var tagRecord: [String: Any] = [
            "pageType": "paper",
            "permalink": permalinkPath,
            "identityStatus": identityStatus,
            "sourceKind": effectiveSourceKind,
            "title": rawTitle,
            "titleZh": titleZh,
            "summary": summaryText,
            "date": appearanceEntry.blogPublishedAt,
            "task": primaryTask,
            "method": primaryMethod,
            "tags": flatTags,
            "citation": ["authors": [String]()]
        ]
        if identityStatus == "verified" {
            tagRecord["paperId"] = paperID
        }
        if let sourceVersion {
            tagRecord["arxivId"] = sourceVersion
        } else if paperID.hasPrefix("arxiv:") {
            tagRecord["arxivId"] = String(paperID.dropFirst(6))
        }
        if let scoreValue {
            tagRecord["score"] = scoreValue
        }
        if let primaryTaskId { tagRecord["primaryTaskId"] = primaryTaskId }
        if let primaryMethodId { tagRecord["primaryMethodId"] = primaryMethodId }
        if !tagConcepts.isEmpty {
            tagRecord["tagCatalogSha256"] = currentRegistrySHA
            tagRecord["tagContract"] = ClientProtocols.contract("paper-tag-flat-tags")
            tagRecord["tagSchemaFingerprint"] = ClientProtocols.schemaFingerprint("paper-tag-flat-tags")
            tagRecord["tagConcepts"] = tagConcepts
        }

        var paper = Paper(
            id: paperID,
            title: rawTitle,
            titleZh: titleZh,
            authors: [],
            date: appearanceEntry.blogPublishedAt,
            score: scoreValue,
            task: primaryTask,
            method: primaryMethod,
            tags: flatTags,
            sourceKind: effectiveSourceKind,
            identityStatus: identityStatus,
            pageType: "paper",
            blogURL: blogURL.absoluteString,
            sourceURL: sourceURL,
            pdfURL: pdfURL,
            sourceVersion: sourceVersion,
            appearances: [blogURL.absoluteString],
            citation: try JSONValue.from(citationFields),
            websiteTagRecords: [try JSONValue.from(tagRecord)],
            pdfSHA256: pdfSHA256
        )

        // If the exact content-addressed detail JSON is already cached & verified locally, enrich immediately with 0 network I/O (fail closed on schema/identity/local-tamper violation)
        if let cachedDetailBytes = try verifiedCachedFile(
            relative: "desktop-details/papers/\(appearanceEntry.detail.sha256).json",
            expectedBytes: appearanceEntry.detail.bytes,
            expectedSHA256: appearanceEntry.detail.sha256
        ) {
            let verified = try Self.parseAndVerifyDesktopDetail(
                cachedDetailBytes,
                expectedAppearance: appearanceEntry,
                expectedPaperID: paperID,
                expectedIdentityStatus: identityStatus
            )
            try Self.applyVerifiedDetail(verified, to: &paper)
        }

        return paper
    }

    // MARK: - On-Demand Detail & Content-Addressed Article Reading (§§5, 6, 8)

    static func parseAndVerifyDesktopDetail(
        _ bytes: Data,
        expectedAppearance: DesktopAppearanceEntry,
        expectedPaperID: String,
        expectedIdentityStatus: String
    ) throws -> VerifiedDesktopDetail {
        guard bytes.count > 0, bytes.count <= maxDesktopDetailBytes else {
            throw ServiceError.invalid("论文详情 JSON 超出大小上限。")
        }
        let obj = try parseUTF8JSONObject(bytes, label: expectedAppearance.detail.url)
        let requiredFields: Set<String> = [
            "appearanceId", "paperId", "identityStatus", "sourceKind", "sourceVersion",
            "appearance", "articleRevision", "titles", "authors", "dates",
            "bibliographic", "abstract", "oneSentenceThesis", "classification",
            "assessment", "citation", "sidecars", "resources"
        ]
        guard ClientProtocols.hasValidHeader(obj, "paper-desktop-detail"),
              obj["contract"] as? String == ClientProtocols.contract("paper-desktop-detail"),
              Set(obj.keys).isSuperset(of: requiredFields),
              let appearanceId = obj["appearanceId"] as? String,
              appearanceId == expectedAppearance.appearanceId,
              let identityStatus = obj["identityStatus"] as? String,
              identityStatus == expectedIdentityStatus else {
            throw ServiceError.invalid("论文详情 JSON 协议头、结构指纹或出现身份与目录不符。")
        }

        let detailPaperId: String?
        if let rawPid = obj["paperId"], !(rawPid is NSNull) {
            guard let pid = rawPid as? String, !pid.isEmpty else {
                throw ServiceError.invalid("论文详情 paperId 字段无效。")
            }
            detailPaperId = pid
        } else {
            detailPaperId = nil
        }
        if identityStatus == "verified" {
            guard detailPaperId == expectedPaperID else {
                throw ServiceError.invalid("论文详情已核验 paperId 与当前目录不一致。")
            }
        } else {
            guard detailPaperId == nil else {
                throw ServiceError.invalid("未核验论文详情不得声称已核验 paperId。")
            }
        }

        let sourceKind: String?
        if let rawSK = obj["sourceKind"], !(rawSK is NSNull) {
            guard let sk = rawSK as? String, !sk.isEmpty else {
                throw ServiceError.invalid("论文详情 sourceKind 格式无效。")
            }
            sourceKind = sk
        } else {
            sourceKind = nil
        }

        // Validate sourceVersion
        guard let svObj = obj["sourceVersion"] as? [String: Any] else {
            throw ServiceError.invalid("论文详情缺少 sourceVersion 对象。")
        }
        let svId: String?
        if let rawSVId = svObj["sourceVersionId"], !(rawSVId is NSNull) {
            guard let s = rawSVId as? String, !s.isEmpty else {
                throw ServiceError.invalid("论文详情 sourceVersion.sourceVersionId 无效。")
            }
            svId = s
        } else {
            svId = nil
        }
        guard svId == expectedAppearance.sourceVersionId else {
            throw ServiceError.invalid("论文详情来源版本身份与目录记录不一致。")
        }
        let versionLabel = (svObj["versionLabel"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let officialSourceURL = try optionalVerifiedHTTPS(svObj["sourceUrl"], label: "sourceVersion.sourceUrl")
        let officialPDFURL = try optionalVerifiedHTTPS(svObj["pdfUrl"], label: "sourceVersion.pdfUrl")
        let pdfSHA256: String?
        if let rawPdfSha = svObj["pdfSha256"], !(rawPdfSha is NSNull) {
            guard let sha = rawPdfSha as? String, isValidSHA256(sha) else {
                throw ServiceError.invalid("论文详情 pdfSha256 格式无效。")
            }
            pdfSHA256 = sha
        } else {
            pdfSHA256 = nil
        }
        let sourceVersionWarning = nonemptyString(svObj["sourceVersionWarning"])
        let provenanceDisclosure = nonemptyString(svObj["provenanceDisclosure"])

        // Validate appearance
        guard let appObj = obj["appearance"] as? [String: Any],
              appObj["appearanceId"] as? String == appearanceId,
              appObj["pageUrl"] as? String == appearanceId,
              appObj["pageType"] as? String == "paper",
              appObj["articleRevisionId"] as? String == expectedAppearance.articleRevisionId,
              let pubStatus = appObj["publicationStatus"] as? String,
              pubStatus == expectedAppearance.publicationStatus else {
            throw ServiceError.invalid("论文详情 appearance 字段与当前目录不一致。")
        }
        var retractionEvidenceURL: String? = nil
        var retractionNote: String? = nil
        if pubStatus == "retracted" {
            guard let retr = appObj["retraction"] as? [String: Any],
                  let ev = try optionalVerifiedHTTPS(retr["evidenceUrl"], label: "retraction.evidenceUrl"),
                  let note = nonemptyString(retr["note"]) else {
                throw ServiceError.invalid("撤稿论文详情缺少真实 HTTPS 证据链接或说明。")
            }
            retractionEvidenceURL = ev
            retractionNote = note
        }

        // Validate articleRevision & articleDescriptor
        guard let revObj = obj["articleRevision"] as? [String: Any],
              let revId = revObj["articleRevisionId"] as? String,
              revId == expectedAppearance.articleRevisionId,
              revObj["appearanceId"] as? String == appearanceId,
              let hasGuideContent = revObj["hasGuideContent"] as? Bool else {
            throw ServiceError.invalid("论文详情 articleRevision 与目录修订身份不一致。")
        }
        let resourceCount = try strictNonNegativeInt(revObj["resourceCount"], label: "articleRevision.resourceCount")
        let articleDesc = try parseFileDescriptor(revObj["articleDescriptor"], maxBytes: maxDesktopArticleBytes, label: "articleRevision.articleDescriptor")
        guard articleDesc.url == "client/details/articles/\(articleDesc.sha256).html" else {
            throw ServiceError.invalid("论文详情正文描述符路径必须为 client/details/articles/<sha256>.html。")
        }

        // Validate titles (originalTitle vs readerTitle strictly separated)
        guard let titlesObj = obj["titles"] as? [String: Any],
              let readerTitle = titlesObj["readerTitle"] as? String, !readerTitle.isEmpty,
              let displayTitle = titlesObj["displayTitle"] as? String, !displayTitle.isEmpty else {
            throw ServiceError.invalid("论文详情 titles 缺少有效标题。")
        }
        let originalTitle: String?
        if let rawOrig = titlesObj["originalTitle"], !(rawOrig is NSNull) {
            guard let orig = rawOrig as? String, !orig.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw ServiceError.invalid("论文详情 originalTitle 格式无效。")
            }
            originalTitle = orig
        } else {
            originalTitle = nil
        }

        // Validate authors preserving declared order
        guard let rawAuthors = obj["authors"] as? [[String: Any]] else {
            throw ServiceError.invalid("论文详情 authors 必须为对象数组。")
        }
        var authorNames: [String] = []
        authorNames.reserveCapacity(rawAuthors.count)
        for (idx, author) in rawAuthors.enumerated() {
            let pos = try strictNonNegativeInt(author["position"], label: "authors.position")
            guard pos == idx + 1,
                  let name = nonemptyString(author["name"]) else {
                throw ServiceError.invalid("论文详情作者顺序或姓名无效。")
            }
            authorNames.append(name)
        }

        // Validate dates (paperPublishedAt, blogPublishedAt, articleUpdatedAt kept distinct)
        guard let datesObj = obj["dates"] as? [String: Any],
              let blogPublishedAt = datesObj["blogPublishedAt"] as? String,
              blogPublishedAt == expectedAppearance.blogPublishedAt else {
            throw ServiceError.invalid("论文详情 dates.blogPublishedAt 与目录不一致。")
        }
        let paperPublishedAt: String?
        if let rawPaperDate = datesObj["paperPublishedAt"], !(rawPaperDate is NSNull) {
            guard let text = rawPaperDate as? String else {
                throw ServiceError.invalid("论文详情 paperPublishedAt 类型无效。")
            }
            paperPublishedAt = text.isEmpty ? nil : text
        } else {
            paperPublishedAt = nil
        }
        let articleUpdatedAt: String?
        if let rawUpd = datesObj["articleUpdatedAt"], !(rawUpd is NSNull) {
            guard let text = rawUpd as? String else {
                throw ServiceError.invalid("论文详情 articleUpdatedAt 类型无效。")
            }
            articleUpdatedAt = text.isEmpty ? nil : text
        } else {
            articleUpdatedAt = nil
        }

        // Validate bibliographic
        guard let bibObj = obj["bibliographic"] as? [String: Any] else {
            throw ServiceError.invalid("论文详情缺少 bibliographic 字段。")
        }
        let arxivVersionedId = nonemptyString(bibObj["arxivVersionedId"])

        // Validate abstract & oneSentenceThesis
        let abstractText: String?
        if let rawAbs = obj["abstract"], !(rawAbs is NSNull) {
            guard let text = rawAbs as? String else {
                throw ServiceError.invalid("论文详情 abstract 类型无效。")
            }
            abstractText = text.isEmpty ? nil : text
        } else {
            abstractText = nil
        }
        let oneSentenceThesis: String?
        if let rawThesis = obj["oneSentenceThesis"], !(rawThesis is NSNull) {
            guard let text = rawThesis as? String else {
                throw ServiceError.invalid("论文详情 oneSentenceThesis 类型无效。")
            }
            oneSentenceThesis = text.isEmpty ? nil : text
        } else {
            oneSentenceThesis = nil
        }

        // Validate citation & paper-citation-source header
        guard let citationObj = obj["citation"] as? [String: Any],
              let citationSource = citationObj["sourceRecord"] as? [String: Any],
              ClientProtocols.hasValidHeader(citationSource, "paper-citation-source"),
              citationSource["contract"] as? String == ClientProtocols.contract("paper-citation-source"),
              citationObj["verified"] is Bool,
              citationObj["complete"] is Bool,
              citationObj["missingFields"] is [String],
              citationObj["fieldStatus"] is [String: Any] else {
            throw ServiceError.invalid("论文详情 citation 或 paper-citation-source 协议头无效。")
        }

        // Validate sidecars
        guard let sidecarsObj = obj["sidecars"] as? [String: Any],
              let sidecarsAvailable = sidecarsObj["available"] as? Bool,
              let sidecarFiles = sidecarsObj["files"] as? [String: Any] else {
            throw ServiceError.invalid("论文详情 sidecars 结构无效。")
        }
        let expectedSidecarNames = ["citation.json", "citation.bib", "citation.ris", "rethink-context.json"]
        guard Set(sidecarFiles.keys) == Set(expectedSidecarNames) else {
            throw ServiceError.invalid("论文详情 sidecars.files 键集合无效。")
        }
        var sidecarDescriptors: [String: DesktopSidecarDescriptor] = [:]
        if sidecarsAvailable {
            guard identityStatus == "verified" else {
                throw ServiceError.invalid("未核验论文不得携带已核验 sidecars。")
            }
            for name in expectedSidecarNames {
                guard let rawSidecar = sidecarFiles[name] as? [String: Any] else {
                    throw ServiceError.invalid("论文详情 sidecar \(name) 描述缺失。")
                }
                let baseDesc = try parseFileDescriptor(rawSidecar, maxBytes: maxDesktopSidecarBytes, label: "sidecars.\(name)")
                guard baseDesc.url.hasPrefix("client/papers/"), baseDesc.url.hasSuffix("/" + name) else {
                    throw ServiceError.invalid("论文详情 sidecar \(name) 路径超出 client/papers/。")
                }
                let contract = rawSidecar["contract"] as? String
                let fp: String?
                if let rawFP = rawSidecar["schemaFingerprint"], !(rawFP is NSNull) {
                    guard let fpStr = rawFP as? String, isValidSHA256(fpStr) else {
                        throw ServiceError.invalid("论文详情 sidecar \(name) schemaFingerprint 格式无效。")
                    }
                    fp = fpStr
                } else {
                    fp = nil
                }
                if name == "citation.json" {
                    guard let contract,
                          (try? ClientProtocols.recordHeader(contract, "researcher-sidecars", fp)) != nil else {
                        throw ServiceError.invalid("论文详情 citation.json 协议声明无效。")
                    }
                } else if name == "rethink-context.json" {
                    guard let contract,
                          (try? ClientProtocols.recordHeader(contract, "paper-research-context", fp)) != nil else {
                        throw ServiceError.invalid("论文详情 rethink-context.json 协议声明无效。")
                    }
                }
                sidecarDescriptors[name] = DesktopSidecarDescriptor(
                    name: name,
                    url: baseDesc.url,
                    bytes: baseDesc.bytes,
                    sha256: baseDesc.sha256,
                    contract: contract,
                    schemaFingerprint: fp
                )
            }
        } else {
            for name in expectedSidecarNames {
                guard sidecarFiles[name] == nil || sidecarFiles[name] is NSNull else {
                    throw ServiceError.invalid("sidecars.available 为 false 时不得包含非空文件描述符。")
                }
            }
        }

        // Validate resources
        guard let rawResources = obj["resources"] as? [[String: Any]],
              rawResources.count == resourceCount,
              rawResources.count <= maxDesktopArticleResources else {
            throw ServiceError.invalid("论文详情 resources 数量不符或超出上限。")
        }
        var resources: [DesktopResourceEntry] = []
        resources.reserveCapacity(rawResources.count)
        var bundledAssetsTotal = 0
        for res in rawResources {
            guard let resourceId = nonemptyString(res["resourceId"]),
                  let kind = nonemptyString(res["kind"]),
                  let mediaType = nonemptyString(res["mediaType"]),
                  let sourceUrl = nonemptyString(res["sourceUrl"]),
                  let availability = res["availability"] as? String,
                  ["bundled", "external", "missing"].contains(availability),
                  let requiredForOffline = res["requiredForOffline"] as? Bool else {
                throw ServiceError.invalid("论文详情资源项缺少必要字段或 availability 无效。")
            }
            let expectedSha: String?
            if let rawExp = res["expectedSha256"], !(rawExp is NSNull) {
                guard let sha = rawExp as? String, isValidSHA256(sha) else {
                    throw ServiceError.invalid("资源 expectedSha256 格式无效。")
                }
                expectedSha = sha
            } else {
                expectedSha = nil
            }
            let desc: DesktopFileDescriptor?
            if availability == "bundled" {
                let d = try parseFileDescriptor(res["descriptor"], maxBytes: maxDesktopAssetBytes, label: "resources.\(resourceId)")
                if let expectedSha, expectedSha != d.sha256 {
                    throw ServiceError.invalid("bundled 资源 expectedSha256 与描述符 sha256 不一致。")
                }
                bundledAssetsTotal += d.bytes
                guard bundledAssetsTotal <= maxDesktopBundledArticleAssetsBytes else {
                    throw ServiceError.invalid("单篇捆绑资源总大小超过 64 MiB 上限。")
                }
                desc = d
            } else {
                guard res["descriptor"] == nil || res["descriptor"] is NSNull else {
                    throw ServiceError.invalid("非 bundled 资源不得携带文件描述符或伪造字节数。")
                }
                desc = nil
            }
            resources.append(DesktopResourceEntry(
                resourceId: resourceId,
                kind: kind,
                mediaType: mediaType,
                sourceUrl: sourceUrl,
                availability: availability,
                requiredForOffline: requiredForOffline,
                descriptor: desc,
                expectedSha256: expectedSha
            ))
        }

        return VerifiedDesktopDetail(
            rawBytes: bytes,
            rawObject: obj,
            appearanceId: appearanceId,
            paperId: detailPaperId,
            identityStatus: identityStatus,
            sourceKind: sourceKind,
            sourceVersionId: svId,
            versionLabel: versionLabel,
            officialSourceURL: officialSourceURL,
            officialPDFURL: officialPDFURL,
            pdfSHA256: pdfSHA256,
            sourceVersionWarning: sourceVersionWarning,
            provenanceDisclosure: provenanceDisclosure,
            publicationStatus: pubStatus,
            retractionEvidenceURL: retractionEvidenceURL,
            retractionNote: retractionNote,
            articleRevisionId: revId,
            articleDescriptor: articleDesc,
            hasGuideContent: hasGuideContent,
            originalTitle: originalTitle,
            readerTitle: readerTitle,
            displayTitle: displayTitle,
            authorNames: authorNames,
            paperPublishedAt: paperPublishedAt,
            blogPublishedAt: blogPublishedAt,
            articleUpdatedAt: articleUpdatedAt,
            arxivVersionedId: arxivVersionedId,
            abstractText: abstractText,
            oneSentenceThesis: oneSentenceThesis,
            citationSourceRecord: citationSource,
            sidecarsAvailable: sidecarsAvailable,
            sidecarDescriptors: sidecarDescriptors,
            resources: resources
        )
    }

    private static func nonemptyString(_ raw: Any?) -> String? {
        guard let text = raw as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func optionalVerifiedHTTPS(_ raw: Any?, label: String) throws -> String? {
        guard let raw, !(raw is NSNull) else { return nil }
        guard let text = raw as? String else {
            throw ServiceError.invalid("\(label) 必须为字符串或 null。")
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        guard let url = URL(string: trimmed),
              url.scheme == "https",
              url.host != nil,
              url.user == nil,
              url.password == nil else {
            throw ServiceError.invalid("\(label) 必须为不含凭据的 HTTPS 链接。")
        }
        return url.absoluteString
    }

    static func applyVerifiedDetail(_ detail: VerifiedDesktopDetail, to paper: inout Paper) throws {
        if let orig = detail.originalTitle {
            paper.title = orig
        } else {
            paper.title = detail.displayTitle
        }
        paper.titleZh = detail.readerTitle
        paper.authors = detail.authorNames
        if detail.identityStatus == "verified" {
            if let src = detail.officialSourceURL { paper.sourceURL = src }
            if let pdf = detail.officialPDFURL { paper.pdfURL = pdf }
            if let sha = detail.pdfSHA256 { paper.pdfSHA256 = sha }
            if paper.sourceKind == "arxiv" {
                let citationArxiv = nonemptyString(detail.citationSourceRecord["arxivId"])
                if let versioned = detail.arxivVersionedId ?? citationArxiv,
                   versioned.range(of: #"v[1-9][0-9]*\z"#, options: .regularExpression) != nil {
                    paper.sourceVersion = versioned
                }
            }
        }
        paper.citation = try JSONValue.from(detail.citationSourceRecord)
        if var records = paper.websiteTagRecords {
            for idx in records.indices {
                guard case .object(var dict) = records[idx] else { continue }
                dict["citation"] = .object(["authors": .array(detail.authorNames.map { .string($0) })])
                if let orig = detail.originalTitle {
                    dict["originalTitle"] = .string(orig)
                }
                records[idx] = .object(dict)
            }
            paper.websiteTagRecords = records
        }
    }

    @discardableResult
    func resolveDesktopDetailForPaper(_ paperID: String) async throws -> (paper: Paper, detail: VerifiedDesktopDetail)? {
        guard let state = activeDesktopDetails(),
              let entry = state.paperDetails[paperID],
              let paperIndex = snapshot.papers.firstIndex(where: { $0.id == paperID }) else {
            return nil
        }
        let startSnapshotID = snapshot.summary.snapshotID
        let startEpoch = snapshot.validationEpoch
        let currentPaper = snapshot.papers[paperIndex]
        let primaryAppearance = entry.appearances.first(where: { $0.appearanceId == entry.primaryAppearanceId })
            ?? DesktopAppearanceEntry(
                appearanceId: entry.primaryAppearanceId,
                blogURL: entry.primaryBlogURL,
                pageType: "paper",
                publicationStatus: entry.primaryPublicationStatus,
                blogPublishedAt: currentPaper.date,
                articleUpdatedAt: nil,
                sourceVersionId: nil,
                articleRevisionId: entry.primaryArticleRevisionId,
                detail: entry.primaryDetail
            )

        let (detailBytes, fromCache) = try await fetchOrReuseContentAddressed(
            cacheRelative: "desktop-details/papers/\(primaryAppearance.detail.sha256).json",
            remoteRelativeURL: primaryAppearance.detail.url,
            expectedBytes: primaryAppearance.detail.bytes,
            maxBytes: Self.maxDesktopDetailBytes,
            expectedSHA256: primaryAppearance.detail.sha256,
            label: "论文详情 \(primaryAppearance.detail.url)"
        )
        let verified = try Self.parseAndVerifyDesktopDetail(
            detailBytes,
            expectedAppearance: primaryAppearance,
            expectedPaperID: currentPaper.id,
            expectedIdentityStatus: currentPaper.identityStatus
        )
        if !fromCache {
            try atomicWriteChecked(detailBytes, relative: "desktop-details/papers/\(primaryAppearance.detail.sha256).json")
        }
        try Task.checkCancellation()
        guard snapshot.summary.snapshotID == startSnapshotID, snapshot.validationEpoch == startEpoch else {
            throw DesktopEpochChangedError(message: "读取期间网站目录快照已更新，未将旧快照详情写入新目录。")
        }

        var updatedPaper = snapshot.papers[paperIndex]
        let beforeEncoded = try JSONEncoder().encode(updatedPaper)
        try Self.applyVerifiedDetail(verified, to: &updatedPaper)
        let afterEncoded = try JSONEncoder().encode(updatedPaper)
        if beforeEncoded != afterEncoded {
            var updatedSnapshot = snapshot
            updatedSnapshot.papers[paperIndex] = updatedPaper
            let snapshotBytes = try JSONEncoder().encode(updatedSnapshot)
            if snapshotBytes.count <= Self.maxTotal {
                try atomicWriteChecked(snapshotBytes, relative: "current.json")
                snapshot = updatedSnapshot
            }
        }
        return (updatedPaper, verified)
    }

    func fetchDesktopDetailArticle(
        _ initialPaper: Paper,
        detailEntry: DesktopPaperDetailEntry,
        cache: URL,
        previous: Article?,
        downloadImages: Bool,
        progress: @escaping @Sendable (Progress) -> Void
    ) async throws -> Article {
        let startSnapshotID = snapshot.summary.snapshotID
        let startEpoch = snapshot.validationEpoch
        guard activeDesktopDetails()?.snapshotID == startSnapshotID,
              activeDesktopDetails()?.validationEpoch == startEpoch else {
            throw DesktopEpochChangedError(message: "读取开始前网站目录已切换，请重新选择当前版本。")
        }

        progress(Progress(phase: "detail", message: "正在读取并校验论文详情记录", completed: 0, total: 2))
        guard let resolved = try await resolveDesktopDetailForPaper(initialPaper.id) else {
            throw DesktopEpochChangedError(message: "当前论文不在活跃桌面详情索引中。")
        }
        let paper = resolved.paper
        let detail = resolved.detail

        progress(Progress(phase: "article", message: "正在读取内容寻址导读正文", completed: 1, total: 2))
        let (articleBytes, articleFromCache) = try await fetchOrReuseContentAddressed(
            cacheRelative: "desktop-details/articles/\(detail.articleDescriptor.sha256).html",
            remoteRelativeURL: detail.articleDescriptor.url,
            expectedBytes: detail.articleDescriptor.bytes,
            maxBytes: Self.maxDesktopArticleBytes,
            expectedSHA256: detail.articleDescriptor.sha256,
            label: "导读正文 \(detail.articleDescriptor.url)"
        )
        guard let rawFragment = String(data: articleBytes, encoding: .utf8) else {
            throw ServiceError.invalid("导读正文片段不是有效 UTF-8 文本。")
        }
        // Fail-closed HTML safety verification BEFORE caching or rendering
        try Self.verifySafeDesktopArticleHTML(rawFragment)
        if !articleFromCache {
            try atomicWriteChecked(articleBytes, relative: "desktop-details/articles/\(detail.articleDescriptor.sha256).html")
        }

        let pageURL = URL(string: paper.blogURL)!
        let (sanitizedHTML, plainText, domImageURLs) = try Self.parseSanitizedDesktopFragment(rawFragment, pageURL: pageURL)

        var notices: [String] = []
        if let warning = detail.sourceVersionWarning {
            notices.append(warning)
        }
        if let provenance = detail.provenanceDisclosure {
            notices.append(provenance)
        }
        if detail.publicationStatus == "retracted",
           let note = detail.retractionNote,
           let ev = detail.retractionEvidenceURL {
            notices.append("撤稿提示：\(note)（来源证据：\(ev)）")
        }

        // Sidecars: declared SHA-bound descriptors MUST verify fail-closed (never swallowed!)
        var citationFiles: [String: String]? = nil
        var citationFileSHA256: [String: String]? = nil
        var citationSidecar: JSONValue? = nil
        var researchContext: JSONValue? = nil
        if detail.sidecarsAvailable {
            var urls: [String: String] = [:]
            var hashes: [String: String] = [:]
            for (name, desc) in detail.sidecarDescriptors {
                urls[name] = try sameSite(desc.url).absoluteString
                hashes[name] = desc.sha256
            }
            citationFiles = urls
            citationFileSHA256 = hashes

            if let citDesc = detail.sidecarDescriptors["citation.json"] {
                let sideRel = "desktop-details/sidecars/\(citDesc.sha256).json"
                let (bytes, fromCache) = try await fetchOrReuseContentAddressed(
                    cacheRelative: sideRel,
                    remoteRelativeURL: citDesc.url,
                    expectedBytes: citDesc.bytes,
                    maxBytes: Self.maxDesktopSidecarBytes,
                    expectedSHA256: citDesc.sha256,
                    label: "citation.json"
                )
                citationSidecar = try Self.validatedSidecar(bytes, paper: paper, context: false)
                if !fromCache {
                    try atomicWriteChecked(bytes, relative: sideRel)
                }
            }
            if let ctxDesc = detail.sidecarDescriptors["rethink-context.json"] {
                let sideRel = "desktop-details/sidecars/\(ctxDesc.sha256).json"
                let (bytes, fromCache) = try await fetchOrReuseContentAddressed(
                    cacheRelative: sideRel,
                    remoteRelativeURL: ctxDesc.url,
                    expectedBytes: ctxDesc.bytes,
                    maxBytes: Self.maxDesktopSidecarBytes,
                    expectedSHA256: ctxDesc.sha256,
                    label: "rethink-context.json"
                )
                researchContext = try Self.validatedSidecar(bytes, paper: paper, context: true)
                if !fromCache {
                    try atomicWriteChecked(bytes, relative: sideRel)
                }
            }
        } else if detail.abstractText != nil || detail.oneSentenceThesis != nil {
            let syntheticContext = try ClientProtocols.record("desktop-bundled-research-context", fields: [
                "origin": "desktop-detail-record",
                "sampleOnly": false,
                "sourceContract": ClientProtocols.contract("paper-desktop-detail"),
                "paperID": paper.id,
                "sourceURL": paper.sourceURL ?? paper.blogURL,
                "blogURL": paper.blogURL,
                "sourceVersion": paper.sourceVersion ?? "",
                "originalTitle": detail.originalTitle ?? paper.title,
                "readerTitle": detail.readerTitle,
                "authors": detail.authorNames,
                "abstract": detail.abstractText ?? NSNull(),
                "oneSentenceThesis": detail.oneSentenceThesis ?? NSNull(),
                "assessment": [
                    "score": (paper.score as Any?) ?? NSNull(),
                    "primaryTask": paper.task,
                    "primaryMethod": paper.method,
                    "tags": paper.tags
                ]
            ])
            researchContext = try JSONValue.from(syntheticContext)
        }

        // Resources & honest completeOffline calculation (§6)
        var articleResources: [Resource] = []
        var replacements: [String: String] = [:]
        var imageBytesTotal = 0
        var allRequiredGuideMediaCached = detail.hasGuideContent

        for (idx, res) in detail.resources.enumerated() {
            try Task.checkCancellation()
            if res.kind == "math-renderer" || res.kind == "pdf" {
                // Math rendering is bundled locally via locked KaTeX; PDF offline state is tracked independently.
                continue
            }
            if res.kind != "image" {
                if res.requiredForOffline {
                    if res.availability == "bundled", let desc = res.descriptor {
                        let cacheRel = "desktop-details/assets/\(desc.sha256).bin"
                        if try verifiedCachedFile(relative: cacheRel, expectedBytes: desc.bytes, expectedSHA256: desc.sha256) == nil {
                            if downloadImages {
                                let (bytes, fromCache) = try await fetchOrReuseContentAddressed(
                                    cacheRelative: cacheRel,
                                    remoteRelativeURL: desc.url,
                                    expectedBytes: desc.bytes,
                                    maxBytes: Self.maxDesktopAssetBytes,
                                    expectedSHA256: desc.sha256,
                                    label: "媒体资源 \(desc.url)"
                                )
                                if !fromCache {
                                    try atomicWriteChecked(bytes, relative: cacheRel)
                                }
                            } else {
                                allRequiredGuideMediaCached = false
                            }
                        }
                    } else {
                        allRequiredGuideMediaCached = false
                    }
                }
                continue
            }

            let resolvedHTTPS = URL(string: res.sourceUrl, relativeTo: pageURL)?.absoluteURL
            let canonicalURLString: String
            if let resolvedHTTPS, resolvedHTTPS.scheme == "https", resolvedHTTPS.user == nil, resolvedHTTPS.password == nil {
                canonicalURLString = resolvedHTTPS.absoluteString
            } else if let desc = res.descriptor, let bundledURL = try? sameSite(desc.url) {
                canonicalURLString = bundledURL.absoluteString
            } else {
                canonicalURLString = res.sourceUrl
            }

            switch res.availability {
            case "missing":
                articleResources.append(Resource(
                    sourceURL: canonicalURLString,
                    kind: "image",
                    localPath: nil,
                    sha256: nil,
                    missingReason: "发布源图片缺失"
                ))
                if res.requiredForOffline { allRequiredGuideMediaCached = false }
                notices.append("部分来源图片不可用：\(res.sourceUrl)")

            case "bundled":
                // Bundled station assets are content-addressed & SHA-bound: any 404, byte/SHA mismatch,
                // invalid image payload, >64 MiB overflow, or disk write failure MUST fail closed!
                guard let desc = res.descriptor else {
                    throw ServiceError.invalid("bundled 图片缺少描述符。")
                }
                if let existingData = try findVerifiedCachedImageBytes(sha256: desc.sha256, expectedBytes: desc.bytes) {
                    imageBytesTotal += existingData.bytes.count
                    guard imageBytesTotal <= Self.maxDesktopBundledArticleAssetsBytes else {
                        throw ServiceError.invalid("单篇图片累计超过 64 MiB。")
                    }
                    articleResources.append(Resource(sourceURL: canonicalURLString, kind: "image", localPath: existingData.file.path, sha256: desc.sha256, missingReason: nil))
                    let dataURI = "data:\(Self.imageMIME(existingData.ext));base64,\(existingData.bytes.base64EncodedString())"
                    replacements[canonicalURLString] = dataURI
                    replacements[res.sourceUrl] = dataURI
                    if let bundledURL = try? sameSite(desc.url) { replacements[bundledURL.absoluteString] = dataURI }
                } else if !downloadImages {
                    articleResources.append(Resource(sourceURL: canonicalURLString, kind: "image", localPath: nil, sha256: nil, missingReason: "尚未下载图片"))
                    if res.requiredForOffline { allRequiredGuideMediaCached = false }
                } else {
                    progress(Progress(phase: "images", message: "正在保存科学图（\(idx + 1)/\(detail.resources.count)）", completed: idx, total: detail.resources.count))
                    let bundledSiteURL = try sameSite(desc.url)
                    let bytes = try await read(bundledSiteURL, limit: min(desc.bytes, Self.maxDesktopAssetBytes))
                    guard bytes.count == desc.bytes, Self.sha256(bytes) == desc.sha256 else {
                        throw ServiceError.invalid("站内科学图实际字节或 SHA 与详情描述符不符。")
                    }
                    guard imageBytesTotal + bytes.count <= Self.maxDesktopBundledArticleAssetsBytes else {
                        throw ServiceError.invalid("单篇图片累计超过 64 MiB，停止下载其余图片。")
                    }
                    let ext = try Self.verifiedDesktopImageExtension(bytes, url: bundledSiteURL)
                    imageBytesTotal += bytes.count
                    let assetRel = "assets/\(desc.sha256).\(ext)"
                    try atomicWriteChecked(bytes, relative: assetRel)
                    let assetFile = directory.appendingPathComponent(assetRel)
                    articleResources.append(Resource(sourceURL: canonicalURLString, kind: "image", localPath: assetFile.path, sha256: desc.sha256, missingReason: nil))
                    let dataURI = "data:\(Self.imageMIME(ext));base64,\(bytes.base64EncodedString())"
                    replacements[canonicalURLString] = dataURI
                    replacements[res.sourceUrl] = dataURI
                    replacements[bundledSiteURL.absoluteString] = dataURI
                }

            default: // "external"
                if let reused = try reusePreviouslyCachedExternalImage(previous: previous, canonicalURL: canonicalURLString, rawURL: res.sourceUrl, expectedSHA256: res.expectedSha256) {
                    guard imageBytesTotal + reused.bytes.count <= Self.maxDesktopBundledArticleAssetsBytes else {
                        throw ServiceError.invalid("单篇图片累计超过 64 MiB。")
                    }
                    imageBytesTotal += reused.bytes.count
                    articleResources.append(Resource(sourceURL: canonicalURLString, kind: "image", localPath: reused.file.path, sha256: reused.sha256, missingReason: nil))
                    let dataURI = "data:\(Self.imageMIME(reused.ext));base64,\(reused.bytes.base64EncodedString())"
                    replacements[canonicalURLString] = dataURI
                    replacements[res.sourceUrl] = dataURI
                } else if !downloadImages {
                    articleResources.append(Resource(sourceURL: canonicalURLString, kind: "image", localPath: nil, sha256: nil, missingReason: "尚未下载图片"))
                    if res.requiredForOffline { allRequiredGuideMediaCached = false }
                } else {
                    guard let url = URL(string: canonicalURLString), url.scheme == "https" else {
                        throw ServiceError.invalid("外部图片链接不是合法 HTTPS 地址。")
                    }
                    progress(Progress(phase: "images", message: "正在保存科学图（\(idx + 1)/\(detail.resources.count)）", completed: idx, total: detail.resources.count))
                    var fetchedBytes: Data? = nil
                    do {
                        fetchedBytes = try await read(url, limit: Self.maxDesktopAssetBytes)
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch let svcErr as ServiceError {
                        switch svcErr {
                        case .httpStatus, .network, .unavailable:
                            // Only genuinely unpinned external resources experiencing transport/HTTP unavailability degrade to incomplete offline
                            if res.expectedSha256 != nil { throw svcErr }
                            articleResources.append(Resource(sourceURL: canonicalURLString, kind: "image", localPath: nil, sha256: nil, missingReason: svcErr.localizedDescription))
                            if res.requiredForOffline { allRequiredGuideMediaCached = false }
                            notices.append("部分图片未离线保存：\(svcErr.localizedDescription)")
                        case .invalid:
                            // Unpinned external image policy/size/DNS failures (e.g. third-party image host) degrade per-image
                            // instead of blocking the entire paper from opening; pinned/bundled/cumulative limits remain fail-closed.
                            if res.expectedSha256 != nil { throw svcErr }
                            articleResources.append(Resource(sourceURL: canonicalURLString, kind: "image", localPath: nil, sha256: nil, missingReason: svcErr.localizedDescription))
                            if res.requiredForOffline { allRequiredGuideMediaCached = false }
                            notices.append("部分外部图片未离线保存：\(svcErr.localizedDescription)")
                        case .cancelled:
                            throw svcErr
                        }
                    } catch {
                        if res.expectedSha256 != nil { throw error }
                        articleResources.append(Resource(sourceURL: canonicalURLString, kind: "image", localPath: nil, sha256: nil, missingReason: error.localizedDescription))
                        if res.requiredForOffline { allRequiredGuideMediaCached = false }
                        notices.append("部分图片未离线保存：\(error.localizedDescription)")
                    }
                    if let bytes = fetchedBytes {
                        let sha = Self.sha256(bytes)
                        if let expectedSha = res.expectedSha256, sha != expectedSha {
                            throw ServiceError.invalid("外部图片实际 SHA-256 与详情声明 expectedSha256 不符。")
                        }
                        guard imageBytesTotal + bytes.count <= Self.maxDesktopBundledArticleAssetsBytes else {
                            throw ServiceError.invalid("单篇图片累计超过 64 MiB，停止下载其余图片。")
                        }
                        let ext: String
                        do {
                            ext = try Self.verifiedDesktopImageExtension(bytes, url: url)
                        } catch {
                            if res.expectedSha256 != nil { throw error }
                            articleResources.append(Resource(sourceURL: canonicalURLString, kind: "image", localPath: nil, sha256: nil, missingReason: error.localizedDescription))
                            if res.requiredForOffline { allRequiredGuideMediaCached = false }
                            notices.append("部分图片未离线保存：\(error.localizedDescription)")
                            continue
                        }
                        imageBytesTotal += bytes.count
                        let assetRel = "assets/\(sha).\(ext)"
                        try atomicWriteChecked(bytes, relative: assetRel)
                        let assetFile = directory.appendingPathComponent(assetRel)
                        articleResources.append(Resource(sourceURL: canonicalURLString, kind: "image", localPath: assetFile.path, sha256: sha, missingReason: nil))
                        let dataURI = "data:\(Self.imageMIME(ext));base64,\(bytes.base64EncodedString())"
                        replacements[canonicalURLString] = dataURI
                        replacements[res.sourceUrl] = dataURI
                    }
                }
            }
        }

        // Any <img> in the HTML not matched in replacements is not cached offline
        for domSrc in domImageURLs where !domSrc.lowercased().hasPrefix("data:image/") && replacements[domSrc] == nil {
            allRequiredGuideMediaCached = false
            if !articleResources.contains(where: { $0.sourceURL == domSrc }) {
                articleResources.append(Resource(sourceURL: domSrc, kind: "image", localPath: nil, sha256: nil, missingReason: "图片未声明或未离线缓存"))
            }
        }

        let localizedHTML = try Self.localizeImagesPreservingDataURI(sanitizedHTML, replacements: replacements)
        let honestOffline = allRequiredGuideMediaCached
            && articleResources.count <= 32
            && articleResources.allSatisfy { $0.localPath != nil && $0.sha256 != nil }

        // Epoch / snapshot consistency check BEFORE committing cached article (§8)
        try Task.checkCancellation()
        guard snapshot.summary.snapshotID == startSnapshotID,
              snapshot.validationEpoch == startEpoch else {
            throw DesktopEpochChangedError(message: "读取期间网站目录快照已切换，拒绝混用新旧快照详情与目录验证代。")
        }

        var article = Article(
            paperID: paper.id,
            html: localizedHTML,
            markdown: nil,
            plainText: plainText,
            citation: try JSONValue.from(detail.citationSourceRecord),
            resources: articleResources,
            sourceURL: paper.sourceURL ?? paper.blogURL,
            pdfURL: paper.pdfURL,
            sourceVersion: paper.sourceVersion,
            fetchedAt: Self.now(),
            revisionSHA256: detail.articleRevisionId,
            completeOffline: honestOffline,
            notices: Array(Set(notices)).sorted(),
            citationSidecar: citationSidecar,
            researchContext: researchContext,
            citationFiles: citationFiles,
            citationFileSHA256: citationFileSHA256,
            blogURL: paper.blogURL,
            catalogEpoch: startEpoch,
            isStale: false,
            cacheStatus: "current",
            validationAttemptedAt: Self.now(),
            expectedSourceVersion: paper.sourceVersion,
            mathMLContract: "published-html-mathml"
        )
        article = Self.presentSourceWarning(article, blogURL: paper.blogURL)
        if article.completeOffline && !resourcesVerified(article) {
            article.completeOffline = false
        }

        if let previous { try preserveRevision(previous, blogURL: paper.blogURL) }
        try preserveRevision(article, blogURL: paper.blogURL)
        try atomicWrite(try JSONEncoder().encode(article), to: cache)
        indexText(article)
        return article
    }

    private static func verifiedDesktopImageExtension(_ data: Data, url: URL) throws -> String {
        let ext = try Self.imageExtension(data, url: url)
        if ext == "svg" {
            guard let svgText = String(data: data, encoding: .utf8), Self.isSafeInlineSVG(svgText) else {
                throw ServiceError.invalid("SVG 科学图未通过静态安全子集核验。")
            }
        }
        return ext
    }

    private func findVerifiedCachedImageBytes(sha256: String, expectedBytes: Int? = nil) throws -> (file: URL, bytes: Data, ext: String)? {
        for ext in ["png", "jpg", "gif", "webp", "svg"] {
            let relative = "assets/\(sha256).\(ext)"
            if let hit = try Self.verifiedOptionalLocalFile(
                relative: relative,
                directory: directory,
                expectedBytes: expectedBytes,
                maxBytes: expectedBytes ?? Self.maxDesktopAssetBytes,
                expectedSHA256: sha256
            ) {
                let verifiedExt = try Self.verifiedDesktopImageExtension(hit.bytes, url: hit.file)
                return (hit.file, hit.bytes, verifiedExt)
            }
        }
        return nil
    }

    private func reusePreviouslyCachedExternalImage(
        previous: Article?,
        canonicalURL: String,
        rawURL: String,
        expectedSHA256: String?
    ) throws -> (file: URL, bytes: Data, sha256: String, ext: String)? {
        if let expectedSHA256,
           let directHit = try findVerifiedCachedImageBytes(sha256: expectedSHA256) {
            return (directHit.file, directHit.bytes, expectedSHA256, directHit.ext)
        }
        guard let prevResource = previous?.resources.first(where: { $0.sourceURL == canonicalURL || $0.sourceURL == rawURL }),
              let path = prevResource.localPath,
              let sha = prevResource.sha256,
              Self.isValidSHA256(sha) else {
            return nil
        }
        if let expectedSHA256, sha != expectedSHA256 {
            return nil
        }
        if let cachedHit = try findVerifiedCachedImageBytes(sha256: sha) {
            return (cachedHit.file, cachedHit.bytes, sha, cachedHit.ext)
        }
        try PrivateStoragePaths.absolute(path)
        let root = try PrivateStoragePaths.checkedDirectory(privateDirectory)
        var prefixes = [privateDirectory.path, root.standardizedFileURL.path, root.resolvingSymlinksInPath().path]
        if let resolvedRoot = realpath(privateDirectory.path, nil) {
            prefixes.append(String(cString: resolvedRoot))
            free(resolvedRoot)
        }
        let directRoots = Array(Set(prefixes)).sorted { $0.count > $1.count }
        var relative: String?
        for prefix in directRoots where path.hasPrefix(prefix + "/") {
            relative = String(path.dropFirst(prefix.count + 1))
            break
        }
        if relative == nil {
            let aliasRoots = try PrivateStoragePaths.loadRoots(directory: root)
            for prefix in aliasRoots where path.hasPrefix(prefix + "/") {
                relative = String(path.dropFirst(prefix.count + 1))
                break
            }
        }
        guard let relative else {
            throw ServiceError.invalid("本地已缓存图片路径超出当前私有资料目录或受控旧目录。")
        }
        guard let hit = try Self.verifiedOptionalLocalFile(
            relative: relative,
            directory: root,
            maxBytes: Self.maxDesktopAssetBytes,
            expectedSHA256: sha
        ) else {
            return nil
        }
        let ext = try Self.verifiedDesktopImageExtension(hit.bytes, url: hit.file)
        return (hit.file, hit.bytes, sha, ext)
    }

    func desktopDetailSidecarAddresses(for paper: Paper) async throws -> (urls: [String: String], hashes: [String: String], sizes: [String: Int])? {
        guard activeDesktopDetails()?.paperDetails[paper.id] != nil else { return nil }
        guard let resolved = try await resolveDesktopDetailForPaper(paper.id) else { return nil }
        let detail = resolved.detail
        guard detail.sidecarsAvailable else { return ([:], [:], [:]) }
        var urls: [String: String] = [:]
        var hashes: [String: String] = [:]
        var sizes: [String: Int] = [:]
        for (name, desc) in detail.sidecarDescriptors {
            urls[name] = try sameSite(desc.url).absoluteString
            hashes[name] = desc.sha256
            sizes[name] = desc.bytes
        }
        return (urls, hashes, sizes)
    }

    func paperDetailResponse(id: String) async throws -> [String: Any] {
        if activeDesktopDetails()?.paperDetails[id] != nil {
            do {
                _ = try await resolveDesktopDetailForPaper(id)
            } catch let epochErr as DesktopEpochChangedError {
                throw ServiceError.invalid(epochErr.localizedDescription)
            }
        }
        return try paperDetail(id: id)
    }

    func mergeActiveTombstoneNotices(_ article: Article, paper: Paper) -> Article {
        guard let state = activeDesktopDetails() else { return article }
        let appearanceURLs = Set(paper.appearances + [paper.blogURL])
        let matching = state.activeTombstones.filter { tomb in
            if tomb.paperId == paper.id { return true }
            if let url = try? sameSite(tomb.appearanceId).absoluteString, appearanceURLs.contains(url) { return true }
            return false
        }
        guard !matching.isEmpty else { return article }
        var extra: [String] = []
        for tomb in matching {
            switch tomb.reason {
            case "retracted":
                let ev = tomb.evidenceUrl ?? ""
                let note = tomb.note ?? "已正式撤稿"
                extra.append(ev.isEmpty ? "撤稿提示：\(note)" : "撤稿提示：\(note)（来源证据：\(ev)）")
            case "replaced":
                if let repl = tomb.replacementAppearanceId {
                    extra.append("该出现记录已被新页面 \(repl) 替代；本机历史笔记与会话继续保留。")
                }
            default:
                extra.append("该页面已从最新站点目录移除（\(tomb.appearanceId)）；本机历史记录继续保留。")
            }
        }
        guard !extra.isEmpty else { return article }
        var updated = article
        updated.notices = Array(Set(updated.notices + extra)).sorted()
        return updated
    }

    // MARK: - Strict Fail-Closed HTML5 Fragment Security Verification (§6)

    private static let mathMLAllowedTags: Set<String> = [
        "math", "mrow", "mi", "mn", "mo", "ms", "mtext", "mspace", "msqrt", "mroot", "mfrac",
        "msub", "msup", "msubsup", "munder", "mover", "munderover", "mmultiscripts", "mprescripts",
        "none", "mtable", "mtr", "mtd", "mpadded", "mphantom", "mstyle", "menclose", "semantics", "annotation"
    ]

    private static let allowedFragmentTags: Set<String> = Set([
        "div", "section", "article", "aside", "header", "footer", "nav",
        "p", "blockquote", "pre", "hr", "br", "wbr",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "ul", "ol", "li", "dl", "dt", "dd",
        "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
        "figure", "figcaption", "details", "summary",
        "a", "em", "strong", "code", "del", "ins", "s", "u", "b", "i", "mark", "small", "sub", "sup", "span",
        "abbr", "cite", "dfn", "kbd", "q", "rp", "rt", "ruby", "samp", "time", "var",
        "img", "picture", "audio", "video", "source"
    ]).union(mathMLAllowedTags)

    private static let htmlVoidTags: Set<String> = [
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"
    ]

    private static let globalAllowedAttrs: Set<String> = [
        "id", "class", "title", "lang", "dir", "role", "tabindex", "hidden"
    ]

    private static let booleanAttrs: Set<String> = [
        "hidden", "reversed", "open", "controls", "muted", "loop"
    ]

    private static let tagSpecificAllowedAttrs: [String: Set<String>] = [
        "a": ["href", "target", "rel"],
        "img": ["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding"],
        "source": ["src", "srcset", "sizes", "type", "media"],
        "audio": ["src", "controls", "preload", "muted", "loop"],
        "video": ["src", "poster", "controls", "preload", "muted", "loop", "width", "height"],
        "td": ["colspan", "rowspan", "scope", "headers", "style"],
        "th": ["colspan", "rowspan", "scope", "headers", "style"],
        "col": ["span", "width"],
        "colgroup": ["span", "width"],
        "ol": ["start", "reversed", "type"],
        "li": ["value"],
        "details": ["open"],
        "blockquote": ["cite"],
        "q": ["cite"],
        "del": ["cite", "datetime"],
        "ins": ["cite", "datetime"],
        "time": ["datetime"]
    ]

    private static let mathMLAllowedAttrs: Set<String> = [
        "display", "xmlns", "encoding", "mathvariant", "displaystyle", "scriptlevel",
        "stretchy", "fence", "separator", "accent", "accentunder", "lspace", "rspace",
        "width", "height", "depth", "voffset", "columnalign", "rowalign", "columnspacing",
        "rowspacing", "columnlines", "rowlines", "frame", "framespacing", "equalrows",
        "equalcolumns", "linethickness", "notation", "maxsize", "minsize", "movablelimits", "symmetric"
    ]

    private static let allowedSVGTags: Set<String> = [
        "svg", "g", "defs", "symbol", "clippath", "mask", "pattern",
        "lineargradient", "radialgradient", "stop",
        "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
        "text", "tspan", "title", "desc", "metadata", "marker", "use"
    ]

    private static let svgFragmentRefTags: Set<String> = [
        "use", "lineargradient", "radialgradient", "pattern"
    ]

    private struct ScannedHTMLAttribute {
        let rawName: String
        let name: String
        let value: String?
        let quote: UnicodeScalar?
        let unquotedUnsafe: Bool
    }

    private struct ScannedHTMLTag {
        let tagEnd: Int
        let isClosing: Bool
        let rawTagName: String
        let tagName: String
        let attrs: [ScannedHTMLAttribute]
        let selfClosing: Bool
    }

    private static func isASCIIWhitespace(_ ch: UnicodeScalar) -> Bool {
        // Omit 0x0C (\f) because stripHTMLControlBytesForTidy removes it before libtidy,
        // so treating \f as whitespace here would diverge from DOM attribute parsing.
        ch.value == 0x20 || ch.value == 0x09 || ch.value == 0x0A || ch.value == 0x0D
    }

    private static func isASCIILetter(_ ch: UnicodeScalar) -> Bool {
        (ch.value >= 65 && ch.value <= 90) || (ch.value >= 97 && ch.value <= 122)
    }

    private static func isTagNameContinue(_ ch: UnicodeScalar) -> Bool {
        isASCIILetter(ch) || (ch.value >= 48 && ch.value <= 57) || ch.value == 58 || ch.value == 45
    }

    /// Exact WHATWG HTML5 tag & attribute state machine (§13.2.5.6–§13.2.5.40).
    private static func scanHTMLTag(_ scalars: [UnicodeScalar], at ltIndex: Int) -> ScannedHTMLTag? {
        let n = scalars.count
        guard ltIndex >= 0, ltIndex + 1 < n, scalars[ltIndex] == "<" else { return nil }
        var i = ltIndex + 1
        var isClosing = false
        if scalars[i] == "/" {
            isClosing = true
            i += 1
        }
        guard i < n, isASCIILetter(scalars[i]) else { return nil }
        let nameStart = i
        while i < n && isTagNameContinue(scalars[i]) { i += 1 }
        if i < n && !isASCIIWhitespace(scalars[i]) && scalars[i] != "/" && scalars[i] != ">" {
            return nil
        }
        let rawTagName = String(String.UnicodeScalarView(scalars[nameStart..<i]))
        let tagName = rawTagName.lowercased()
        var attrs: [ScannedHTMLAttribute] = []
        var selfClosing = false

        while i < n {
            // BEFORE_ATTR_NAME
            while i < n && isASCIIWhitespace(scalars[i]) { i += 1 }
            guard i < n else { return nil }
            if scalars[i] == ">" {
                return ScannedHTMLTag(tagEnd: i, isClosing: isClosing, rawTagName: rawTagName, tagName: tagName, attrs: attrs, selfClosing: selfClosing)
            }
            if scalars[i] == "/" {
                // SELF_CLOSING_START_TAG: in libtidy, stray '/' is NOT an attribute separator;
                // only '/>' at tag end is valid self-closing. Fail closed on '<p hidden/class="x">'.
                i += 1
                guard i < n, scalars[i] == ">" else { return nil }
                selfClosing = true
                return ScannedHTMLTag(tagEnd: i, isClosing: isClosing, rawTagName: rawTagName, tagName: tagName, attrs: attrs, selfClosing: selfClosing)
            }

            // ATTR_NAME ('=' at start of attribute name is part of attribute name in HTML5)
            let attrStart = i
            i += 1
            while i < n && !isASCIIWhitespace(scalars[i]) && scalars[i] != "/" && scalars[i] != ">" && scalars[i] != "=" {
                i += 1
            }
            // Live libtidy merges '/' into an unquoted attribute name (e.g. `<p hidden/>` drops `hidden`),
            // so fail closed whenever an attribute name terminates directly at '/'.
            if i < n && scalars[i] == "/" { return nil }
            let rawName = String(String.UnicodeScalarView(scalars[attrStart..<i]))
            let name = rawName.lowercased()

            // AFTER_ATTR_NAME
            while i < n && isASCIIWhitespace(scalars[i]) { i += 1 }
            guard i < n else { return nil }
            if scalars[i] != "=" {
                attrs.append(ScannedHTMLAttribute(rawName: rawName, name: name, value: nil, quote: nil, unquotedUnsafe: false))
                continue
            }

            // BEFORE_ATTR_VALUE (consume '=')
            i += 1
            while i < n && isASCIIWhitespace(scalars[i]) { i += 1 }
            guard i < n else { return nil }
            if scalars[i] == "\"" || scalars[i] == "'" {
                let quote = scalars[i]
                i += 1
                let valStart = i
                while i < n && scalars[i] != quote { i += 1 }
                guard i < n else { return nil }
                let value = String(String.UnicodeScalarView(scalars[valStart..<i]))
                i += 1
                attrs.append(ScannedHTMLAttribute(rawName: rawName, name: name, value: value, quote: quote, unquotedUnsafe: false))
            } else if scalars[i] == ">" {
                attrs.append(ScannedHTMLAttribute(rawName: rawName, name: name, value: "", quote: nil, unquotedUnsafe: true))
                return ScannedHTMLTag(tagEnd: i, isClosing: isClosing, rawTagName: rawTagName, tagName: tagName, attrs: attrs, selfClosing: selfClosing)
            } else {
                // ATTR_VALUE_UNQUOTED: quotes '"', "'", '=' do NOT open strings; '>' closes tag immediately!
                let valStart = i
                while i < n && !isASCIIWhitespace(scalars[i]) && scalars[i] != ">" { i += 1 }
                guard i < n else { return nil }
                let slice = scalars[valStart..<i]
                let value = String(String.UnicodeScalarView(slice))
                let hasUnsafeChar = slice.contains(where: { ch in
                    ch == "\"" || ch == "'" || ch == "=" || ch == "`" || ch == "<" || ch == ">"
                }) || (scalars[i] == ">" && slice.last == "/")
                attrs.append(ScannedHTMLAttribute(rawName: rawName, name: name, value: value, quote: nil, unquotedUnsafe: value.isEmpty || hasUnsafeChar))
                if scalars[i] == ">" {
                    return ScannedHTMLTag(tagEnd: i, isClosing: isClosing, rawTagName: rawTagName, tagName: tagName, attrs: attrs, selfClosing: selfClosing)
                }
            }
        }
        return nil
    }

    static func verifySafeDesktopArticleHTML(_ html: String) throws {
        let trimmed = html.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, html.utf8.count <= maxDesktopArticleBytes else {
            throw ServiceError.invalid("导读正文片段为空或超过大小限制。")
        }
        let hasDisallowedControlScalar = html.unicodeScalars.contains { scalar in
            let v = scalar.value
            return (v < 0x20 && v != 0x09 && v != 0x0A && v != 0x0D) || v == 0x7F
        }
        guard !hasDisallowedControlScalar,
              !containsInvalidNumericEntity(html),
              !html.contains("<!--"),
              !html.contains("<?"),
              html.range(of: #"<!DOCTYPE|<!ENTITY"#, options: [.regularExpression, .caseInsensitive]) == nil else {
            throw ServiceError.invalid("导读正文片段包含禁止的控制字符、非法数值字符实体、HTML 注释、处理指令或 DTD/实体声明。")
        }

        let scalars = Array(html.unicodeScalars)
        let n = scalars.count
        var cursor = 0
        var mathDepth = 0

        while cursor < n {
            guard let ltOffset = scalars[cursor..<n].firstIndex(of: "<") else { break }
            guard let parsed = scanHTMLTag(scalars, at: ltOffset) else {
                throw ServiceError.invalid("导读正文片段包含未转义的孤立 '<'、未闭合标签或声明节点。")
            }
            guard allowedFragmentTags.contains(parsed.tagName) else {
                throw ServiceError.invalid("导读正文片段包含非白名单或禁止标签 <\(parsed.tagName)>。")
            }
            let isMathChildTag = mathMLAllowedTags.contains(parsed.tagName) && parsed.tagName != "math"
            if isMathChildTag {
                guard mathDepth > 0 else {
                    throw ServiceError.invalid("导读正文片段不允许在 <math> 外部使用 MathML 子标签 <\(parsed.tagName)>。")
                }
            }
            if parsed.isClosing {
                guard parsed.attrs.isEmpty, !parsed.selfClosing, !htmlVoidTags.contains(parsed.tagName) else {
                    throw ServiceError.invalid("导读正文片段闭合标签 </\(parsed.tagName)> 携带非法属性或自闭合标记。")
                }
                if parsed.tagName == "math" {
                    guard mathDepth > 0 else {
                        throw ServiceError.invalid("导读正文片段包含没有对应起点的 </math> 闭合标签。")
                    }
                    mathDepth -= 1
                }
            } else {
                if parsed.selfClosing {
                    let allowMathSelfClose = parsed.tagName == "math" || (mathDepth > 0 && isMathChildTag)
                    guard htmlVoidTags.contains(parsed.tagName) || allowMathSelfClose else {
                        throw ServiceError.invalid("导读正文片段非空元素 <\(parsed.tagName)/> 不允许使用自闭合语法。")
                    }
                }
                if parsed.tagName == "math" && !parsed.selfClosing {
                    mathDepth += 1
                }
                var seenAttrs = Set<String>()
                for attr in parsed.attrs {
                    guard seenAttrs.insert(attr.name).inserted else {
                        throw ServiceError.invalid("导读正文片段标签 <\(parsed.tagName)> 存在重复属性 \(attr.name)。")
                    }
                    guard !attr.unquotedUnsafe else {
                        throw ServiceError.invalid("导读正文片段属性 \(attr.name) 含未加引号的特殊字符。")
                    }
                    guard isAllowedHTMLAttribute(tagName: parsed.tagName, attr: attr) else {
                        throw ServiceError.invalid("导读正文片段标签 <\(parsed.tagName)> 含非白名单或危险属性 \(attr.name)。")
                    }
                }
            }
            cursor = parsed.tagEnd + 1
        }
        guard mathDepth == 0 else {
            throw ServiceError.invalid("导读正文片段包含未闭合的 <math> 标签。")
        }
    }

    private static func isAllowedHTMLAttribute(tagName: String, attr: ScannedHTMLAttribute) -> Bool {
        let name = attr.name
        guard name.range(of: #"\A[a-z][a-z0-9:-]*\z"#, options: .regularExpression) != nil else { return false }
        if name.hasPrefix("on") || name == "srcdoc" || name == "ping" { return false }
        if mathMLAllowedTags.contains(tagName) && name == "hidden" { return false }

        let isGlobal = globalAllowedAttrs.contains(name)
            || name.range(of: #"\Aaria-[a-z0-9-]+\z"#, options: .regularExpression) != nil
            || name.range(of: #"\Adata-[a-z0-9-]+\z"#, options: .regularExpression) != nil
        let isTagSpecific = tagSpecificAllowedAttrs[tagName]?.contains(name) == true
        let isMathSpecific = mathMLAllowedTags.contains(tagName) && mathMLAllowedAttrs.contains(name)
        guard isGlobal || isTagSpecific || isMathSpecific else { return false }

        guard let rawValue = attr.value else {
            return booleanAttrs.contains(name)
        }
        if containsInvalidNumericEntity(rawValue) { return false }
        let decodedVal = decodeHTMLEntities(rawValue)
        if decodedVal.contains("\0") { return false }

        switch name {
        case "href":
            return !isUnsafeDesktopURL(rawValue, allowMailto: tagName == "a", allowDataImage: false, allowLegacyPlaceholder: false)
        case "cite", "poster":
            return !isUnsafeDesktopURL(rawValue, allowMailto: false, allowDataImage: false, allowLegacyPlaceholder: false)
        case "src":
            let isImg = tagName == "img"
            return !isUnsafeDesktopURL(rawValue, allowMailto: false, allowDataImage: isImg, allowLegacyPlaceholder: isImg)
        case "srcset":
            return parseSrcsetCandidates(rawValue) != nil
        case "style":
            if decodedVal.contains("\u{FFFD}") { return false }
            guard tagName == "td" || tagName == "th" else { return false }
            return decodedVal.range(of: #"\A\s*text-align\s*:\s*(?:left|center|right|justify)\s*;?\s*\z"#, options: [.regularExpression, .caseInsensitive]) != nil
        case "xmlns":
            if decodedVal.contains("\u{FFFD}") { return false }
            return tagName == "math" && decodedVal.trimmingCharacters(in: .whitespacesAndNewlines) == "http://www.w3.org/1998/Math/MathML"
        default:
            return true
        }
    }

    private static func parseSrcsetCandidates(_ rawSrcset: String) -> [String]? {
        let decoded = decodeHTMLEntities(rawSrcset)
        if decoded.contains("\0") || decoded.contains("\u{FFFD}") { return nil }
        let rawItems = decoded.split(separator: ",", omittingEmptySubsequences: false)
        var urls: [String] = []
        for rawItem in rawItems {
            let trimmed = rawItem.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return nil }
            let tokens = trimmed.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            guard !tokens.isEmpty, tokens.count <= 2 else { return nil }
            let candidateURL = tokens[0]
            if isUnsafeDesktopURL(candidateURL, allowMailto: false, allowDataImage: false, allowLegacyPlaceholder: false) {
                return nil
            }
            if tokens.count == 2,
               tokens[1].range(of: #"\A\d+(?:\.\d+)?[wx]\z"#, options: [.regularExpression, .caseInsensitive]) == nil {
                return nil
            }
            urls.append(candidateURL)
        }
        return urls.isEmpty ? nil : urls
    }

    private static func containsInvalidNumericEntity(_ raw: String) -> Bool {
        guard raw.contains("&#") else { return false }
        let ns = raw as NSString
        let fullRange = NSRange(location: 0, length: ns.length)
        if let hexRegex = try? NSRegularExpression(pattern: #"&#x0*([0-9a-fA-F]+);?"#, options: .caseInsensitive) {
            for m in hexRegex.matches(in: raw, range: fullRange) {
                let cap = m.range(at: 1)
                guard cap.location != NSNotFound else { return true }
                let hex = ns.substring(with: cap)
                if hex.count > 6 { return true }
                guard let code = UInt32(hex, radix: 16),
                      code != 0,
                      !(code >= 0xD800 && code <= 0xDFFF),
                      code <= 0x10FFFF,
                      UnicodeScalar(code) != nil else {
                    return true
                }
            }
        }
        if let decRegex = try? NSRegularExpression(pattern: #"&#0*([0-9]+);?"#) {
            for m in decRegex.matches(in: raw, range: fullRange) {
                let cap = m.range(at: 1)
                guard cap.location != NSNotFound else { return true }
                let dec = ns.substring(with: cap)
                if dec.count > 7 { return true }
                guard let code = UInt32(dec, radix: 10),
                      code != 0,
                      !(code >= 0xD800 && code <= 0xDFFF),
                      code <= 0x10FFFF,
                      UnicodeScalar(code) != nil else {
                    return true
                }
            }
        }
        return false
    }

    private static func safeCodePointString(_ code: UInt32) -> String {
        if code == 0 || (code >= 0xD800 && code <= 0xDFFF) || code > 0x10FFFF {
            return "\u{FFFD}"
        }
        guard let scalar = UnicodeScalar(code) else {
            return "\u{FFFD}"
        }
        return String(scalar)
    }

    private static func replacingRegexMatches(
        in input: String,
        pattern: String,
        options: NSRegularExpression.Options = [],
        transform: (NSString, NSTextCheckingResult) -> String?
    ) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
            return input
        }
        let ns = input as NSString
        let matches = regex.matches(in: input, range: NSRange(location: 0, length: ns.length))
        guard !matches.isEmpty else { return input }
        let out = NSMutableString()
        var cursor = 0
        for match in matches {
            if match.range.location > cursor {
                out.append(ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
            }
            if let replacement = transform(ns, match) {
                out.append(replacement)
            } else {
                out.append(ns.substring(with: match.range))
            }
            cursor = match.range.location + match.range.length
        }
        if cursor < ns.length {
            out.append(ns.substring(from: cursor))
        }
        return out as String
    }

    private static func decodeHTMLEntities(_ raw: String) -> String {
        var result = replacingRegexMatches(in: raw, pattern: #"&#x0*([0-9a-fA-F]+);?"#, options: .caseInsensitive) { ns, m in
            let hex = ns.substring(with: m.range(at: 1))
            if hex.count > 6 { return "\u{FFFD}" }
            if let code = UInt32(hex, radix: 16) { return safeCodePointString(code) }
            return "\u{FFFD}"
        }
        result = replacingRegexMatches(in: result, pattern: #"&#0*([0-9]+);?"#) { ns, m in
            let dec = ns.substring(with: m.range(at: 1))
            if dec.count > 7 { return "\u{FFFD}" }
            if let code = UInt32(dec, radix: 10) { return safeCodePointString(code) }
            return "\u{FFFD}"
        }
        result = replacingRegexMatches(in: result, pattern: #"&(colon|sol|bsol|tab|newline|nbsp|amp|lt|gt|quot|apos);?"#, options: .caseInsensitive) { ns, m in
            switch ns.substring(with: m.range(at: 1)).lowercased() {
            case "colon": return ":"
            case "sol": return "/"
            case "bsol": return "\\"
            case "tab": return "\t"
            case "newline": return "\n"
            case "nbsp": return "\u{00A0}"
            case "amp": return "&"
            case "lt": return "<"
            case "gt": return ">"
            case "quot": return "\""
            case "apos": return "'"
            default: return nil
            }
        }
        return result
    }

    private static func isSafeDataImageURL(_ decoded: String) -> Bool {
        let trimmed = decoded.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.contains("\0") || trimmed.contains("\u{FFFD}") { return false }
        if trimmed.range(of: #"\Adata:image/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+\z"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return true
        }
        if trimmed.range(of: #"\Adata:image/svg\+xml(?:;charset=utf-8)?,"#, options: [.regularExpression, .caseInsensitive]) != nil,
           let comma = trimmed.firstIndex(of: ",") {
            guard let svg = String(trimmed[trimmed.index(after: comma)...]).removingPercentEncoding else { return false }
            return isSafeInlineSVG(svg)
        }
        if trimmed.range(of: #"\Adata:image/svg\+xml(?:;charset=utf-8)?;base64,[A-Za-z0-9+/=\s]+\z"#, options: [.regularExpression, .caseInsensitive]) != nil,
           let comma = trimmed.firstIndex(of: ",") {
            let b64 = String(trimmed[trimmed.index(after: comma)...]).components(separatedBy: .whitespacesAndNewlines).joined()
            guard let data = Data(base64Encoded: b64), let svg = String(data: data, encoding: .utf8) else { return false }
            return isSafeInlineSVG(svg)
        }
        return false
    }

    static func isSafeInlineSVG(_ svg: String) -> Bool {
        guard !svg.isEmpty,
              !svg.contains("\0"),
              !svg.contains("\u{FFFD}"),
              !svg.contains("<!--"),
              !svg.contains("<?") else {
            return false
        }
        let decodedAll = decodeHTMLEntities(svg)
        guard !decodedAll.contains("\0"),
              !decodedAll.contains("\u{FFFD}"),
              !decodedAll.contains("<!--"),
              !decodedAll.contains("<?"),
              svg.range(of: #"<!DOCTYPE|<!ENTITY"#, options: [.regularExpression, .caseInsensitive]) == nil,
              decodedAll.range(of: #"<!DOCTYPE|<!ENTITY"#, options: [.regularExpression, .caseInsensitive]) == nil else {
            return false
        }
        let forbiddenSVGPattern = #"<(?:script|iframe|object|embed|applet|foreignobject|set|animate|animatetransform|animatemotion|mpath|feimage|audio|video|form|style)\b"#
        guard svg.range(of: forbiddenSVGPattern, options: [.regularExpression, .caseInsensitive]) == nil,
              decodedAll.range(of: forbiddenSVGPattern, options: [.regularExpression, .caseInsensitive]) == nil else {
            return false
        }

        let scalars = Array(svg.unicodeScalars)
        let n = scalars.count
        var cursor = 0
        var sawSVGRoot = false

        while cursor < n {
            guard let ltOffset = scalars[cursor..<n].firstIndex(of: "<") else { break }
            guard let parsed = scanHTMLTag(scalars, at: ltOffset),
                  allowedSVGTags.contains(parsed.tagName) else {
                return false
            }
            if parsed.isClosing {
                guard parsed.attrs.isEmpty, !parsed.selfClosing else { return false }
                cursor = parsed.tagEnd + 1
                continue
            }
            if parsed.tagName == "svg" { sawSVGRoot = true }
            var seenAttrs = Set<String>()
            for attr in parsed.attrs {
                guard seenAttrs.insert(attr.name).inserted else { return false }
                guard let rawVal = attr.value,
                      attr.quote == "\"" || attr.quote == "'",
                      !attr.name.hasPrefix("on"),
                      attr.name != "srcdoc" else {
                    return false
                }
                let val = decodeHTMLEntities(rawVal)
                if val.contains("\0") || val.contains("\u{FFFD}") { return false }
                if attr.name == "href" || attr.name == "xlink:href" {
                    let compact = val.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard svgFragmentRefTags.contains(parsed.tagName),
                          compact.range(of: #"\A#[A-Za-z_][A-Za-z0-9_.-]*\z"#, options: .regularExpression) != nil else {
                        return false
                    }
                } else if attr.name == "style" {
                    // Reject CSS comments outright so quote-vs-comment desynchronization can never smuggle declarations.
                    if val.contains("/*") || val.contains("*/") { return false }
                    var cleanCSS = val
                    if let safeURLRegex = try? NSRegularExpression(
                        pattern: #"url\s*\(\s*(?:'\s*#[A-Za-z_][A-Za-z0-9_.-]*\s*'|"\s*#[A-Za-z_][A-Za-z0-9_.-]*\s*"|#[A-Za-z_][A-Za-z0-9_.-]*)\s*\)"#,
                        options: .caseInsensitive
                    ) {
                        cleanCSS = safeURLRegex.stringByReplacingMatches(in: cleanCSS, range: NSRange(cleanCSS.startIndex..., in: cleanCSS), withTemplate: "none")
                    }
                    let compactCSS = String(String.UnicodeScalarView(cleanCSS.unicodeScalars.filter { $0.value > 0x20 && $0.value != 0x7F })).lowercased()
                    for token in ["url(", "image-set(", "expression(", "@import", "javascript:", "vbscript:", "data:", "http:", "https:", "file:", "zotero:", "smb:", "-moz-binding", "behavior:", "//", "\\"] {
                        if compactCSS.contains(token) { return false }
                    }
                } else {
                    var cleanAttrVal = val
                    if let safeURLRegex = try? NSRegularExpression(
                        pattern: #"url\s*\(\s*(?:'\s*#[A-Za-z_][A-Za-z0-9_.-]*\s*'|"\s*#[A-Za-z_][A-Za-z0-9_.-]*\s*"|#[A-Za-z_][A-Za-z0-9_.-]*)\s*\)"#,
                        options: .caseInsensitive
                    ) {
                        cleanAttrVal = safeURLRegex.stringByReplacingMatches(in: cleanAttrVal, range: NSRange(cleanAttrVal.startIndex..., in: cleanAttrVal), withTemplate: "none")
                    }
                    let compactAttrVal = String(String.UnicodeScalarView(cleanAttrVal.unicodeScalars.filter { $0.value > 0x20 && $0.value != 0x7F }))
                    let lowerCompactAttr = compactAttrVal.lowercased()
                    if lowerCompactAttr.contains("url(") || lowerCompactAttr.contains("image-set(") || lowerCompactAttr.contains("\\") {
                        return false
                    }
                    if !(attr.name == "xmlns" && compactAttrVal == "http://www.w3.org/2000/svg"),
                       !(attr.name == "xmlns:xlink" && compactAttrVal == "http://www.w3.org/1999/xlink") {
                        if lowerCompactAttr.contains("//") || compactAttrVal.range(of: #"\A[A-Za-z][A-Za-z0-9+.-]*:"#, options: .regularExpression) != nil {
                            return false
                        }
                    }
                }
            }
            cursor = parsed.tagEnd + 1
        }
        return sawSVGRoot
    }

    static func isUnsafeDesktopURL(
        _ rawValue: String,
        allowMailto: Bool = false,
        allowDataImage: Bool = false,
        allowLegacyPlaceholder: Bool = false
    ) -> Bool {
        let decoded = decodeHTMLEntities(rawValue)
        if decoded.contains("\0") || decoded.contains("\u{FFFD}") { return true }
        let compactScalars = decoded.unicodeScalars.filter { $0.value > 0x20 && $0.value != 0x7F }
        let compact = String(String.UnicodeScalarView(compactScalars))
        if compact.isEmpty { return true }
        if compact.hasPrefix("//") || compact.hasPrefix("\\\\") || compact.hasPrefix("/\\") || compact.hasPrefix("\\/") {
            return true
        }
        let head: Substring
        if let firstDelim = compact.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) {
            head = compact[..<firstDelim]
        } else {
            head = compact[...]
        }
        if head.contains(":") {
            guard let colonIdx = compact.firstIndex(of: ":") else { return true }
            let schemeRaw = String(compact[..<colonIdx])
            guard schemeRaw.range(of: #"\A[A-Za-z][A-Za-z0-9+.-]*\z"#, options: .regularExpression) != nil else {
                return true
            }
            let scheme = schemeRaw.lowercased()
            switch scheme {
            case "https", "http":
                return compact.range(of: #"\Ahttps?://[A-Za-z0-9]"#, options: [.regularExpression, .caseInsensitive]) == nil
            case "mailto":
                return !allowMailto
            case "data":
                guard allowDataImage else { return true }
                return !isSafeDataImageURL(decoded)
            case "icassp-img":
                return !allowLegacyPlaceholder
            default:
                return true
            }
        }
        return false
    }

    /// Strips ASCII C0 control bytes (0x00..0x08, 0x0B, 0x0C, 0x0E..0x1F) and DEL (0x7F)
    /// identically to Apple's libtidy input pre-filter so both byte scanners and Foundation's
    /// `.documentTidyHTML` always observe the exact same byte stream.
    static func stripHTMLControlBytesForTidy(_ raw: String) -> String {
        let bytes = Array(raw.utf8)
        var needsStrip = false
        for b in bytes {
            if (b < 32 && b != 9 && b != 10 && b != 13) || b == 127 {
                needsStrip = true
                break
            }
        }
        guard needsStrip else { return raw }
        var out = Data()
        out.reserveCapacity(bytes.count)
        for b in bytes {
            if (b < 32 && b != 9 && b != 10 && b != 13) || b == 127 { continue }
            out.append(b)
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Locale-independent ASCII case-insensitive substring check (immune to Turkish `tr_TR` `i`/`I` folding).
    static func asciiCaseInsensitiveContains(_ haystack: String, _ needle: String) -> Bool {
        haystack.range(of: needle, options: .caseInsensitive, locale: Locale(identifier: "en_US_POSIX")) != nil
    }

    /// Detects Hugo's exact JSON sidecar `<script type="application/json" class="<requiredClass>">`
    /// (without `src`) by byte-parsing real HTML attributes so spoofed text inside another attribute's value,
    /// hyphen-extended class names, or slash-separated `src` attributes can never promote an arbitrary script.
    static func isJSONSidecarScriptOpenTag(_ openTagBytes: ArraySlice<UInt8>, requiredClass: String) -> Bool {
        let bytes = Array(openTagBytes)
        let n = bytes.count
        guard n >= 8, bytes[0] == 60, bytes[n - 1] == 62 else { return false }
        func isWS(_ b: UInt8) -> Bool { b == 9 || b == 10 || b == 13 || b == 32 }
        func asciiLower(_ slice: ArraySlice<UInt8>) -> String {
            var out = [UInt8]()
            out.reserveCapacity(slice.count)
            for b in slice { out.append((65...90).contains(b) ? b + 32 : b) }
            return String(decoding: out, as: UTF8.self)
        }
        // Must open with `<script` followed by ASCII whitespace (rejects `<script/src=...`, `<script!...`).
        guard asciiLower(bytes[1..<7]) == "script", isWS(bytes[7]) else { return false }
        var idx = 7
        var seenAttrs = Set<String>()
        var typeValue: String? = nil
        var classTokens: [String]? = nil
        while idx < n - 1 {
            while idx < n - 1 && isWS(bytes[idx]) { idx += 1 }
            if idx >= n - 1 { break }
            let lead = bytes[idx]
            // Fail closed on malformed attribute-start syntax (stray `=`, `"`, `'`, `<`, `/`, `-`) that triggers libtidy recovery.
            if lead == 61 || lead == 34 || lead == 39 || lead == 60 || lead == 47 || lead == 45 { return false }
            let attrStart = idx
            while idx < n - 1 && !isWS(bytes[idx]) && bytes[idx] != 61 {
                let b = bytes[idx]
                if b == 60 || b == 34 || b == 39 || b == 47 { return false }
                if b == 45, idx + 1 < n - 1, (bytes[idx + 1] == 34 || bytes[idx + 1] == 39) { return false }
                idx += 1
            }
            let attrName = asciiLower(bytes[attrStart..<idx])
            // Fail closed on empty, `src`, or duplicate attributes (libtidy uses keep-last on repeated attrs).
            guard !attrName.isEmpty, attrName != "src", seenAttrs.insert(attrName).inserted else { return false }
            while idx < n - 1 && isWS(bytes[idx]) { idx += 1 }
            // Reject libtidy quote-as-equals recovery (`a "b="` / `a ""`).
            if idx < n - 1 && (bytes[idx] == 34 || bytes[idx] == 39) { return false }
            var valBytes: ArraySlice<UInt8> = []
            if idx < n - 1 && bytes[idx] == 61 {
                idx += 1
                while idx < n - 1 && isWS(bytes[idx]) { idx += 1 }
                // Reject trailing bare `=` (`type=>`, `foo=>`).
                if idx >= n - 1 { return false }
                if bytes[idx] == 34 || bytes[idx] == 39 {
                    let q = bytes[idx]
                    idx += 1
                    let vStart = idx
                    while idx < n - 1 && bytes[idx] != q { idx += 1 }
                    guard idx < n - 1 && bytes[idx] == q else { return false }
                    valBytes = bytes[vStart..<idx]
                    idx += 1
                    // Require whitespace or tag end after a quoted attribute value.
                    guard idx == n - 1 || isWS(bytes[idx]) else { return false }
                } else {
                    let vStart = idx
                    while idx < n - 1 && !isWS(bytes[idx]) {
                        let b = bytes[idx]
                        if b == 60 || b == 34 || b == 39 { return false }
                        idx += 1
                    }
                    if idx == n - 1 && idx > vStart && bytes[idx - 1] == 47 { return false } // self-closing unquoted value
                    valBytes = bytes[vStart..<idx]
                }
            }
            if attrName == "type" {
                typeValue = asciiLower(valBytes).trimmingCharacters(in: CharacterSet(charactersIn: " \t\r\n"))
            } else if attrName == "class" {
                classTokens = asciiLower(valBytes).split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\r" || $0 == "\n" }).map(String.init)
            }
        }
        return typeValue == "application/json" && (classTokens?.contains(requiredClass) == true)
    }

    static func isJSONCitationScriptOpenTag(_ openTagBytes: ArraySlice<UInt8>) -> Bool {
        isJSONSidecarScriptOpenTag(openTagBytes, requiredClass: "paper-tools__citation-record")
    }

    static func isJSONClientSidecarsScriptOpenTag(_ openTagBytes: ArraySlice<UInt8>) -> Bool {
        isJSONSidecarScriptOpenTag(openTagBytes, requiredClass: "paper-tools__client-sidecars")
    }

    enum HTML5ByteTagScanResult {
        case notATag
        case bogusComment(end: Int)
        case unquotedLessThan(end: Int)
        case unclosedEOF
        case tooLong
        case tag(name: String, nameEnd: Int, end: Int, closing: Bool, selfClosing: Bool, hasValidNameDelimiter: Bool)
    }

    /// Shared O(n) Foundation-Tidy-aligned byte-level tag and bogus-comment scanner.
    /// Operates on control-byte-stripped UTF-8 and mirrors macOS Foundation `.documentTidyHTML`
    /// (libtidy) rules for `ParseTagName` non-`IsNamechar` delimiter consumption, bogus end-tags
    /// (`</ ` vs `</<`), leading `=`/`"`/`'` in `BEFORE_ATTR_NAME`, `/` inside attribute names vs
    /// true `/>` self-closing, `<` termination, and fail-closed rejection of unquoted `<` values.
    static func scanHTML5ByteTag(_ bytes: [UInt8], at start: Int, maxLength: Int? = nil) -> HTML5ByteTagScanResult {
        let n = bytes.count
        guard start >= 0, start < n, bytes[start] == 60 else { return .notATag }
        let limit = maxLength.map { min(n, start + $0 + 1) } ?? n
        func isWS(_ b: UInt8) -> Bool { b == 9 || b == 10 || b == 13 || b == 32 }
        func isASCIIAlpha(_ b: UInt8) -> Bool { (65...90).contains(b) || (97...122).contains(b) }
        func isTagNameCont(_ b: UInt8) -> Bool {
            isASCIIAlpha(b) || (48...57).contains(b) || b == 45 || b == 58 || b == 95 || b == 46
        }
        func isNameDelim(_ b: UInt8) -> Bool { isWS(b) || b == 47 || b == 62 }
        // Decodes a valid UTF-8 scalar at `i` within `limit`, guarding against Apple libtidy's
        // 8-bit `(tmbchar)cp` truncation in `ParseTagName` / `LEX_ENDTAG` where `(cp & 0xFF)` in
        // `{0x2F ('/'), 0x3E ('>'), 0xFF (EOF)}` triggers delimiter/EOF parser differentials.
        func decodeUTF8Scalar(at i: Int) -> (scalar: UInt32, length: Int, truncatedAtLimit: Bool)? {
            guard i < limit else { return nil }
            let b0 = bytes[i]
            if b0 < 0x80 { return (UInt32(b0), 1, false) }
            let expectedLen: Int
            var cp: UInt32
            if b0 >= 0xC2 && b0 <= 0xDF {
                expectedLen = 2; cp = UInt32(b0 & 0x1F)
            } else if b0 >= 0xE0 && b0 <= 0xEF {
                expectedLen = 3; cp = UInt32(b0 & 0x0F)
            } else if b0 >= 0xF0 && b0 <= 0xF4 {
                expectedLen = 4; cp = UInt32(b0 & 0x07)
            } else {
                return nil
            }
            if i + expectedLen > limit {
                return limit < n ? (0, 0, true) : nil
            }
            for k in 1..<expectedLen {
                let bk = bytes[i + k]
                guard (bk & 0xC0) == 0x80 else { return nil }
                cp = (cp << 6) | UInt32(bk & 0x3F)
            }
            if (expectedLen == 3 && (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF)))
                || (expectedLen == 4 && (cp < 0x10000 || cp > 0x10FFFF)) {
                return nil
            }
            return (cp, expectedLen, false)
        }
        func isLibtidyTruncatedDelimiter(_ cp: UInt32) -> Bool {
            let lo = cp & 0xFF
            return lo == 0x2F || lo == 0x3E || lo == 0xFF
        }

        var idx = start + 1
        guard idx < n else { return .notATag }

        if bytes[idx] == 47 { // '/' -> End tag open state
            idx += 1
            if idx >= n { return .unclosedEOF }
            if bytes[idx] == 62 { return .bogusComment(end: idx + 1) }
            if bytes[idx] == 60 {
                // Live macOS libtidy consumes all 3 bytes `</<` as literal text and resumes scanning at `idx + 1`.
                return .bogusComment(end: idx + 1)
            }
            if !isASCIIAlpha(bytes[idx]) {
                // For `</ `, `</1`, `</! `, macOS libtidy emits literal `&lt;/...` text and still parses
                // any following `<tag ...>` live — return `.notATag` so scanning resumes after `<`.
                return .notATag
            }
            let nameStart = idx
            while idx < limit && isTagNameCont(bytes[idx]) { idx += 1 }
            if idx >= limit && idx < n { return .tooLong }
            let nameEnd = idx
            if idx >= n { return .unclosedEOF }
            let validDelim = isNameDelim(bytes[idx])
            let name = String(decoding: bytes[nameStart..<nameEnd], as: UTF8.self).lowercased()
            // Foundation `.documentTidyHTML` closes alphabetic end tags at the very first '>' without quote toggling,
            // EXCEPT non-ASCII scalars with `(cp & 0xFF) ∈ {0x2F, 0x3E, 0xFF}` trigger libtidy 8-bit truncation — fail closed.
            while idx < limit {
                if bytes[idx] == 62 {
                    return .tag(name: name, nameEnd: nameEnd, end: idx + 1, closing: true, selfClosing: false, hasValidNameDelimiter: validDelim)
                }
                if bytes[idx] >= 0x80 {
                    guard let decoded = decodeUTF8Scalar(at: idx) else { return .unquotedLessThan(end: idx) }
                    if decoded.truncatedAtLimit { return .tooLong }
                    if isLibtidyTruncatedDelimiter(decoded.scalar) { return .unquotedLessThan(end: idx) }
                    idx += decoded.length
                    continue
                }
                idx += 1
            }
            return idx < n ? .tooLong : .unclosedEOF
        }

        // Start tag open state: live macOS libtidy consumes `<<` as literal text without ungetting
        // the second `<`; otherwise first byte after '<' must be an ASCII letter.
        if bytes[idx] == 60 {
            return .bogusComment(end: idx + 1)
        }
        guard isASCIIAlpha(bytes[idx]) else { return .notATag }
        let nameStart = idx
        while idx < limit && isTagNameCont(bytes[idx]) { idx += 1 }
        if idx >= limit && idx < n { return .tooLong }
        let nameEnd = idx
        if idx >= n { return .unclosedEOF }
        let validDelim = isNameDelim(bytes[idx])
        let name = String(decoding: bytes[nameStart..<nameEnd], as: UTF8.self).lowercased()
        // Mirror libtidy ParseTagName: any non-IsNamechar delimiter other than WS, '/', '>' (e.g. '!', '<', '中')
        // is consumed and discarded as a single UTF-8 scalar before attribute parsing begins,
        // EXCEPT non-ASCII scalars whose low byte collides with '/', '>', or EOF (0xFF), which fail closed.
        if !validDelim {
            if bytes[idx] >= 0x80 {
                guard let decoded = decodeUTF8Scalar(at: idx) else { return .unquotedLessThan(end: idx) }
                if decoded.truncatedAtLimit { return .tooLong }
                if isLibtidyTruncatedDelimiter(decoded.scalar) { return .unquotedLessThan(end: idx) }
                idx += decoded.length
            } else {
                idx += 1
            }
        }

        // Tidy-aligned attribute state machine:
        // - Leading `=`, `"`, `'` in BEFORE_ATTR_NAME are skipped (matching libtidy on `<div =="x>`, `<div "="x>`, `<div "a="x>`).
        // - `/` in BEFORE_ATTR_NAME is self-closing ONLY when immediately followed by `>`; otherwise `/` starts ATTR_NAME.
        // - `/` inside ATTR_NAME does NOT terminate the attribute name (matching libtidy on `<script a/>`, `<div a/="x>`).
        // - `<` terminates the tag before `<` in BEFORE_ATTR_NAME, ATTR_NAME, AFTER_ATTR_NAME, and after >=1 char in ATTR_VALUE_UNQUOTED.
        // - Unquoted attribute values beginning with `<` (`a=<>`, `a=< `) return `.unquotedLessThan` for fail-closed rejection.
        // - Unquoted attribute values ending in `/>` set `selfClosing = true` EXCEPT for libtidy's 12 URL attributes
        //   (`TidyAttrIsUrl`), where trailing `/` stays part of the URL value (`<style src=https://example.com/>`).
        let libtidyURLAttributes: Set<String> = [
            "background", "cite", "classid", "codebase", "data", "datasrc",
            "href", "longdesc", "lowsrc", "profile", "src", "usemap"
        ]
        func isInlineServerTagAt(_ i: Int) -> Bool {
            i + 1 < n && (bytes[i + 1] == 63 || bytes[i + 1] == 37 || bytes[i + 1] == 35)
        }
        while idx < limit {
            // BEFORE_ATTR_NAME
            while idx < limit && (isWS(bytes[idx]) || bytes[idx] == 61 || bytes[idx] == 34 || bytes[idx] == 39) { idx += 1 }
            if idx >= limit { return idx < n ? .tooLong : .unclosedEOF }
            if bytes[idx] == 62 {
                return .tag(name: name, nameEnd: nameEnd, end: idx + 1, closing: false, selfClosing: false, hasValidNameDelimiter: validDelim)
            }
            if bytes[idx] == 60 {
                if isInlineServerTagAt(idx) { return .unquotedLessThan(end: idx) }
                return .tag(name: name, nameEnd: nameEnd, end: idx, closing: false, selfClosing: false, hasValidNameDelimiter: validDelim)
            }
            if bytes[idx] == 47, idx + 1 < limit, bytes[idx + 1] == 62 { // true self-closing `/>`
                return .tag(name: name, nameEnd: nameEnd, end: idx + 2, closing: false, selfClosing: true, hasValidNameDelimiter: validDelim)
            }
            if bytes[idx] == 45, idx + 1 < n, (bytes[idx + 1] == 34 || bytes[idx + 1] == 39) {
                // Live macOS libtidy terminates the tag immediately after `-` when BEFORE_ATTR_NAME sees `-"'` / `-'`.
                return .tag(name: name, nameEnd: nameEnd, end: idx + 1, closing: false, selfClosing: false, hasValidNameDelimiter: validDelim)
            }
            // ATTR_NAME: first byte is guaranteed non-WS and not in {=, ", ', <, >}; `/` is part of ATTR_NAME
            let attrNameStart = idx
            idx += 1
            while idx < limit && !isWS(bytes[idx]) && bytes[idx] != 62 && bytes[idx] != 61 && bytes[idx] != 60 {
                if bytes[idx] == 45, idx + 1 < n, (bytes[idx + 1] == 34 || bytes[idx + 1] == 39) {
                    break
                }
                idx += 1
            }
            let attrNameEnd = idx
            if idx < limit, bytes[idx] == 45, idx + 1 < n, (bytes[idx + 1] == 34 || bytes[idx + 1] == 39) {
                // Live macOS libtidy strips trailing `-` immediately before `"` / `'` inside ATTR_NAME and treats the quote as `=`.
                idx += 1
            }
            if idx < limit && bytes[idx] == 60 {
                if isInlineServerTagAt(idx) { return .unquotedLessThan(end: idx) }
                return .tag(name: name, nameEnd: nameEnd, end: idx, closing: false, selfClosing: false, hasValidNameDelimiter: validDelim)
            }
            // AFTER_ATTR_NAME
            while idx < limit && isWS(bytes[idx]) { idx += 1 }
            if idx >= limit { return idx < n ? .tooLong : .unclosedEOF }
            if bytes[idx] == 60 {
                if isInlineServerTagAt(idx) { return .unquotedLessThan(end: idx) }
                return .tag(name: name, nameEnd: nameEnd, end: idx, closing: false, selfClosing: false, hasValidNameDelimiter: validDelim)
            }
            // Live macOS libtidy treats `"` and `'` in AFTER_ATTR_NAME identically to `=` (missing-equals recovery).
            if bytes[idx] != 61 && bytes[idx] != 34 && bytes[idx] != 39 { // boolean attribute; reconsume current byte in BEFORE_ATTR_NAME
                continue
            }
            // BEFORE_ATTR_VALUE (consume '=')
            idx += 1
            while idx < limit && isWS(bytes[idx]) { idx += 1 }
            if idx >= limit { return idx < n ? .tooLong : .unclosedEOF }
            if bytes[idx] == 34 || bytes[idx] == 39 {
                let q = bytes[idx]
                idx += 1
                while idx < limit && bytes[idx] != q { idx += 1 }
                if idx >= limit { return idx < n ? .tooLong : .unclosedEOF }
                idx += 1 // consume closing quote
            } else if bytes[idx] == 62 {
                return .tag(name: name, nameEnd: nameEnd, end: idx + 1, closing: false, selfClosing: false, hasValidNameDelimiter: validDelim)
            } else if bytes[idx] == 60 {
                // Unquoted attribute value starting with '<' triggers libtidy ParseValue lookahead differentials (`a=<>`, `a=< `).
                return .unquotedLessThan(end: idx)
            } else {
                // ATTR_VALUE_UNQUOTED: ends at WS, '>', or '<'; trailing '/>' is self-closing in libtidy
                // unless the attribute is one of libtidy's URL attributes (e.g. `src`, `href`).
                let valStart = idx
                idx += 1
                while idx < limit && !isWS(bytes[idx]) && bytes[idx] != 62 && bytes[idx] != 60 { idx += 1 }
                if idx >= limit { return idx < n ? .tooLong : .unclosedEOF }
                if bytes[idx] == 62 {
                    let attrLower = String(
                        decoding: bytes[attrNameStart..<attrNameEnd].map { ($0 >= 65 && $0 <= 90) ? ($0 + 32) : $0 },
                        as: UTF8.self
                    )
                    let isSelfClose = idx > valStart && bytes[idx - 1] == 47 && !libtidyURLAttributes.contains(attrLower)
                    return .tag(name: name, nameEnd: nameEnd, end: idx + 1, closing: false, selfClosing: isSelfClose, hasValidNameDelimiter: validDelim)
                }
                if bytes[idx] == 60 {
                    if isInlineServerTagAt(idx) { return .unquotedLessThan(end: idx) }
                    return .tag(name: name, nameEnd: nameEnd, end: idx, closing: false, selfClosing: false, hasValidNameDelimiter: validDelim)
                }
            }
        }
        return idx < n ? .tooLong : .unclosedEOF
    }

    enum RawTextEndScanResult {
        case closed(bodyEnd: Int, closeEnd: Int)
        case unclosed(bodyEnd: Int)
        case unsafe
    }

    /// Scans for the matching raw-text/RCDATA closing tag `</rawName...>` starting at `bodyStart`.
    /// Recognizes any non-`IsNamechar` delimiter after `</rawName` (matching libtidy on `</script!>`, `</script中>`),
    /// Scans for the matching closing tag of a raw-text/RCDATA element using `scanHTML5ByteTag`,
    /// mirroring WHATWG HTML5 §13.2.5.17–31 script escaped/double-escaped state for `<script>`
    /// and propagating fail-closed `.unsafe` on libtidy 8-bit truncation characters (e.g. `</textarea\u{013E}`, `</textarea\u{FEFF}>`).
    static func scanRawTextElementEnd(
        _ bytes: [UInt8],
        rawName: String,
        from bodyStart: Int,
        formFeedAfterCleanPos: Set<Int> = []
    ) -> RawTextEndScanResult {
        let n = bytes.count
        let needle = Array(("</" + rawName).utf8)
        let needleLen = needle.count
        let isScript = rawName == "script"
        func isTagNameCont(_ b: UInt8) -> Bool {
            (65...90).contains(b) || (97...122).contains(b) || (48...57).contains(b) || b == 45 || b == 58 || b == 95 || b == 46
        }
        func isScriptDelimByte(_ b: UInt8) -> Bool {
            b == 9 || b == 10 || b == 12 || b == 13 || b == 32 || b == 47 || b == 62
        }
        func isScriptDelimAt(_ endIdx: Int) -> Bool {
            formFeedAfterCleanPos.contains(endIdx - 1) || (endIdx < n && isScriptDelimByte(bytes[endIdx]))
        }
        func matchesCI(_ ascii: [UInt8], at idx: Int) -> Bool {
            guard idx + ascii.count <= n else { return false }
            for k in 0..<ascii.count {
                let b = bytes[idx + k]
                let lc = (65...90).contains(b) ? b + 32 : b
                if lc != ascii[k] { return false }
            }
            return true
        }
        let openScriptPat = Array("<script".utf8)
        let closeScriptPat = Array("</script".utf8)
        enum ScriptState { case normal, escaped, doubleEscaped }
        var scriptState: ScriptState = .normal
        var pos = bodyStart
        while pos < n {
            if isScript {
                if scriptState == .normal {
                    if pos + 3 < n && bytes[pos] == 60 && bytes[pos + 1] == 33 && bytes[pos + 2] == 45 && bytes[pos + 3] == 45 {
                        // WHATWG §13.2.5.20-24: abrupt `<!-->`, `<!--->`, `<!---->` transition immediately back to normal.
                        var dashEnd = pos + 4
                        while dashEnd < n && bytes[dashEnd] == 45 { dashEnd += 1 }
                        if dashEnd < n && bytes[dashEnd] == 62 {
                            pos = dashEnd + 1
                            continue
                        }
                        scriptState = .escaped
                        pos += 4
                        continue
                    }
                } else {
                    if pos + 2 < n && bytes[pos] == 45 && bytes[pos + 1] == 45 && bytes[pos + 2] == 62 {
                        scriptState = .normal
                        pos += 3
                        continue
                    }
                    if scriptState == .escaped, pos + openScriptPat.count <= n,
                       matchesCI(openScriptPat, at: pos), isScriptDelimAt(pos + openScriptPat.count) {
                        scriptState = .doubleEscaped
                        pos += openScriptPat.count
                        continue
                    }
                    if scriptState == .doubleEscaped, pos + closeScriptPat.count <= n,
                       matchesCI(closeScriptPat, at: pos), isScriptDelimAt(pos + closeScriptPat.count) {
                        scriptState = .escaped
                        pos += closeScriptPat.count
                        continue
                    }
                }
            }
            if bytes[pos] == 60, (!isScript || scriptState != .doubleEscaped), pos + needleLen < n {
                var matched = true
                for k in 0..<needleLen {
                    let b = bytes[pos + k]
                    let lc = (65...90).contains(b) ? b + 32 : b
                    if lc != needle[k] { matched = false; break }
                }
                if matched {
                    let ffAfterName = formFeedAfterCleanPos.contains(pos + needleLen - 1)
                    let after = bytes[pos + needleLen]
                    if ffAfterName {
                        // Form-feed (`0x0C`) immediately after `</rawName` is valid WHATWG whitespace delimiter.
                        var k = pos + needleLen
                        while k < n && bytes[k] != 62 {
                            if bytes[k] >= 128 { return .unsafe }
                            k += 1
                        }
                        if k < n { return .closed(bodyEnd: pos, closeEnd: k + 1) }
                        return .unclosed(bodyEnd: pos)
                    }
                    // WHATWG §13.2.5.13 / §13.2.5.15 / §13.2.5.19: ONLY ASCII WS / `/` / `>` closes any RAWTEXT/RCDATA end tag
                    // (never `</script!>`, `</style!>`, `</textarea!>`, `</iframe!>`, `</xmp!>`, `</noframes!>`, `</noscript!>`).
                    if isScriptDelimByte(after) {
                        switch scanHTML5ByteTag(bytes, at: pos) {
                        case .tag(let name, _, let end, let closing, _, _) where closing && name == rawName:
                            return .closed(bodyEnd: pos, closeEnd: end)
                        case .unquotedLessThan:
                            return .unsafe
                        case .unclosedEOF, .tooLong:
                            return .unclosed(bodyEnd: pos)
                        default:
                            break
                        }
                    } else if after >= 128 {
                        if case .unquotedLessThan = scanHTML5ByteTag(bytes, at: pos) {
                            return .unsafe
                        }
                    }
                }
            }
            pos += 1
        }
        return .unclosed(bodyEnd: n)
    }

    /// Scans an HTML5 comment starting at `start` (pointing at `<!--`), honoring WHATWG §13.2.5.45–50
    /// abrupt closers (`<!-->`, `<!--->`) and bang closer (`--!>`). `needsRewrite` is true when `libtidy`
    /// would fail to close the comment at `end` (abrupt/bang/unclosed).
    static func scanHTML5CommentEnd(_ bytes: [UInt8], from start: Int) -> (end: Int, closed: Bool, needsRewrite: Bool) {
        let n = bytes.count
        var i = start + 4
        if i < n && bytes[i] == 62 {
            return (i + 1, true, true) // abrupt `<!-->`
        }
        if i + 1 < n && bytes[i] == 45 && bytes[i + 1] == 62 {
            return (i + 2, true, true) // abrupt `<!--->`
        }
        while i < n {
            if bytes[i] == 45 && i + 1 < n && bytes[i + 1] == 45 {
                if i + 2 < n && bytes[i + 2] == 62 {
                    return (i + 3, true, false) // standard `-->`
                }
                if i + 3 < n && bytes[i + 2] == 33 && bytes[i + 3] == 62 {
                    return (i + 4, true, true) // WHATWG `--!>`
                }
            }
            i += 1
        }
        return (n, false, true)
    }

    /// Appends `slice` to `out`, replacing every literal `<` (0x3C) with `replacement` (e.g. `&lt;` or `\u003c`).
    static func appendEscapingLessThan(_ slice: ArraySlice<UInt8>, replacement: [UInt8], to out: inout Data) {
        var segStart = slice.startIndex
        var i = segStart
        while i < slice.endIndex {
            if slice[i] == 60 {
                if i > segStart { out.append(contentsOf: slice[segStart..<i]) }
                out.append(contentsOf: replacement)
                segStart = i + 1
            }
            i += 1
        }
        if segStart < slice.endIndex { out.append(contentsOf: slice[segStart..<slice.endIndex]) }
    }

    /// HTML5 elements that Apple's HTML4/XHTML1 `libtidy` strips (unwrapping their children and
    /// dropping `@hidden` before XPath detachment). Flow block elements map to `<div>`; phrasing-allowed
    /// containers map to `<span>` when visible (preserving `<p><time>...</time></p>`, `<p><picture>...</picture></p>`,
    /// etc., never prematurely closing `<p>` or `<p hidden>`) and to `<div>` when carrying `@hidden` outside `<p hidden>`.
    static let html5BlockContainerTags: Set<String> = [
        "section", "article", "main", "aside", "header", "footer", "nav",
        "hgroup", "search", "dialog",
        "figure", "figcaption", "details", "summary"
    ]

    static let html5InlineContainerTags: Set<String> = [
        "bdi", "data", "mark", "menuitem", "meter", "output", "progress", "time",
        "audio", "video", "picture", "svg", "canvas", "datalist", "slot"
    ]

    /// Native HTML4 block/table/document containers whose `@hidden` attribute is faithfully preserved
    /// by Apple's `libtidy` without prematurely closing/dropping the wrapper around flow/table children
    /// (and whose optional HTML5 end tags like `<p>` / `<li>` / `<dd>` must stay native).
    private static let safeHiddenNativeTags: Set<String> = [
        "html", "head", "body",
        "div", "p", "ul", "ol", "li", "dd", "blockquote", "form", "fieldset", "center",
        "table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup"
    ]

    /// Conservative union of WHATWG HTML5 and Apple `libtidy` attribute parsing on a start tag's
    /// attribute slice (`bytes[t.nameEnd..<t.end]`), detecting `@hidden` across HTML5 `/` separators
    /// (`<figure/hidden>`, `<p hidden/class="x">`), HTML5 non-equals quotes (`<div a " hidden>`,
    /// `<div -" hidden>`), and `libtidy` recovery forms (`=hidden`, `"hidden`, `!hidden`,
    /// `a "x=" hidden`, `a-"x=" hidden`, `a ""x"hidden`) while extracting clean `id` and `class` values.
    private static func parseHiddenAndIdentityAttrs(_ attrBytes: ArraySlice<UInt8>) -> (hasHidden: Bool, idValue: String?, classValue: String?) {
        let bytes = Array(attrBytes)
        let n = bytes.count
        var i = 0
        var hasHidden = false
        var idValue: String? = nil
        var classValue: String? = nil
        func isWS(_ b: UInt8) -> Bool { b == 32 || b == 9 || b == 10 || b == 13 || b == 12 }
        func asciiLower(_ slice: ArraySlice<UInt8>) -> String {
            var out = [UInt8]()
            out.reserveCapacity(slice.count)
            for b in slice { out.append((65...90).contains(b) ? b + 32 : b) }
            return String(decoding: out, as: UTF8.self)
        }
        // Pass 1: Apple libtidy attribute tokenizer (skipping any non-namechar delimiter like `@`, `;`, `!`, CJK)
        func isAttrNameStartByte(_ b: UInt8) -> Bool {
            (65...90).contains(b) || (97...122).contains(b) || (48...57).contains(b) || b == 95 || b == 45
        }
        while i < n {
            // BEFORE_ATTR_NAME: skip WS, HTML5 '/' separator, and libtidy discarded non-namechar delimiters
            while i < n && bytes[i] != 62 && bytes[i] != 60 && !isAttrNameStartByte(bytes[i]) { i += 1 }
            if i >= n || bytes[i] == 62 || bytes[i] == 60 { break }
            if bytes[i] == 45, i + 1 < n, (bytes[i + 1] == 34 || bytes[i + 1] == 39) { break }
            let nameStart = i
            i += 1
            while i < n && !isWS(bytes[i]) && bytes[i] != 61 && bytes[i] != 62 && bytes[i] != 47 && bytes[i] != 60 {
                if bytes[i] == 45, i + 1 < n, (bytes[i + 1] == 34 || bytes[i + 1] == 39) { break }
                i += 1
            }
            let nameEnd = i
            if i < n, bytes[i] == 45, i + 1 < n, (bytes[i + 1] == 34 || bytes[i + 1] == 39) {
                i += 1 // mirror libtidy stripping trailing '-' before quote-as-equals
            }
            let attrName = asciiLower(bytes[nameStart..<nameEnd])
            if attrName == "hidden" { hasHidden = true }
            while i < n && isWS(bytes[i]) { i += 1 }
            var rawVal: String? = nil
            if i < n && (bytes[i] == 61 || bytes[i] == 34 || bytes[i] == 39) {
                i += 1 // consume '=' or libtidy quote-as-equals
                while i < n && isWS(bytes[i]) { i += 1 }
                if i < n && (bytes[i] == 34 || bytes[i] == 39) {
                    let q = bytes[i]
                    i += 1
                    let vStart = i
                    while i < n && bytes[i] != q { i += 1 }
                    rawVal = String(decoding: bytes[vStart..<i], as: UTF8.self)
                    if i < n { i += 1 }
                } else if i < n && bytes[i] != 62 && bytes[i] != 60 {
                    let vStart = i
                    while i < n && !isWS(bytes[i]) && bytes[i] != 62 && bytes[i] != 60 { i += 1 }
                    var vEnd = i
                    if i < n && bytes[i] == 62 && vEnd > vStart && bytes[vEnd - 1] == 47 {
                        vEnd -= 1 // strip trailing '/' from unquoted value before '>' (e.g. `id=x/>`)
                    }
                    rawVal = String(decoding: bytes[vStart..<vEnd], as: UTF8.self)
                }
            }
            if let val = rawVal {
                if attrName == "id" { idValue = val }
                else if attrName == "class" { classValue = val }
            }
        }
        // Pass 2: Strict WHATWG HTML5 §13.2.5.32-38 union check (quotes do NOT act as '=' and '-"' does NOT end the tag).
        if !hasHidden {
            var w = 0
            while w < n {
                while w < n && (isWS(bytes[w]) || bytes[w] == 47) { w += 1 }
                if w >= n || bytes[w] == 62 { break }
                let wnStart = w
                w += 1
                while w < n && !isWS(bytes[w]) && bytes[w] != 47 && bytes[w] != 61 && bytes[w] != 62 { w += 1 }
                let wAttr = asciiLower(bytes[wnStart..<w])
                if wAttr == "hidden" {
                    hasHidden = true
                    break
                }
                while w < n && isWS(bytes[w]) { w += 1 }
                if w < n && bytes[w] == 61 {
                    w += 1
                    while w < n && isWS(bytes[w]) { w += 1 }
                    if w < n && (bytes[w] == 34 || bytes[w] == 39) {
                        let q = bytes[w]
                        w += 1
                        while w < n && bytes[w] != q { w += 1 }
                        if w < n { w += 1 }
                    } else {
                        while w < n && !isWS(bytes[w]) && bytes[w] != 62 { w += 1 }
                    }
                }
            }
        }
        return (hasHidden, idValue, classValue)
    }

    private static func escapeNormalizedAttrValue(_ raw: String) -> String {
        var out = ""
        out.reserveCapacity(raw.count)
        for ch in raw {
            switch ch {
            case "&": out += "&amp;"
            case "\"": out += "&quot;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            default: out.append(ch)
            }
        }
        return out
    }

    /// Compatibility non-throwing wrapper used by unit tests; all production pipelines call `rewriteHTML5TagsForTidyStrict`.
    static func rewriteHTML5TagsForTidy(
        _ raw: String,
        tagMarker: String,
        preserveTags: Set<String>,
        containerTags: Set<String>,
        inlineContainerTags: Set<String> = [],
        preserveClientSidecarsScript: Bool = false
    ) -> String {
        (try? rewriteHTML5TagsForTidyStrict(
            raw,
            tagMarker: tagMarker,
            preserveTags: preserveTags,
            containerTags: containerTags,
            inlineContainerTags: inlineContainerTags,
            preserveClientSidecarsScript: preserveClientSidecarsScript
        )) ?? stripHTMLControlBytesForTidy(raw)
    }

    /// Strict fail-closed HTML-tag-aware HTML5 wrapper rewrite + pre-Tidy raw-text/control/@hidden hygiene
    /// for Foundation's `.documentTidyHTML`, throwing on any parser-differential construct instead of
    /// silently downgrading to unrewritten bytes.
    static func rewriteHTML5TagsForTidyStrict(
        _ raw: String,
        tagMarker: String,
        preserveTags: Set<String>,
        containerTags: Set<String>,
        inlineContainerTags: Set<String> = [],
        preserveClientSidecarsScript: Bool = false
    ) throws -> String {
        let rawBytes = Array(raw.utf8)
        guard rawBytes.count <= 16 * 1024 * 1024 else {
            throw ServiceError.invalid("读取的HTML页面超过16 MiB。")
        }
        let hasFormFeedInRaw = rawBytes.contains(12)
        let cleanedRaw: String
        let bytes: [UInt8]
        var rawWSBytes: [UInt8] = []
        var cleanToRawWS: [Int] = []
        var rawWSToClean: [Int] = []
        var ffPrefixCount: [Int] = []
        var formFeedAfterCleanPos: Set<Int> = []
        if hasFormFeedInRaw {
            var cleanedBuf = [UInt8]()
            cleanedBuf.reserveCapacity(rawBytes.count)
            rawWSBytes.reserveCapacity(rawBytes.count)
            cleanToRawWS.reserveCapacity(rawBytes.count)
            rawWSToClean.reserveCapacity(rawBytes.count + 1)
            ffPrefixCount.reserveCapacity(rawBytes.count + 1)
            ffPrefixCount.append(0)
            var totalFF = 0
            for b in rawBytes {
                if b == 12 {
                    if !cleanedBuf.isEmpty {
                        formFeedAfterCleanPos.insert(cleanedBuf.count - 1)
                    }
                    totalFF += 1
                    rawWSToClean.append(cleanedBuf.count)
                    rawWSBytes.append(32) // normalize 0x0C to ASCII space per WHATWG HTML5
                    ffPrefixCount.append(totalFF)
                    continue
                }
                if (b < 32 && b != 9 && b != 10 && b != 13) || b == 127 { continue }
                cleanToRawWS.append(rawWSBytes.count)
                rawWSToClean.append(cleanedBuf.count)
                cleanedBuf.append(b)
                rawWSBytes.append(b)
                ffPrefixCount.append(totalFF)
            }
            rawWSToClean.append(cleanedBuf.count)
            bytes = cleanedBuf
            cleanedRaw = String(decoding: cleanedBuf, as: UTF8.self)
        } else {
            cleanedRaw = stripHTMLControlBytesForTidy(raw)
            bytes = Array(cleanedRaw.utf8)
        }
        let n = bytes.count
        guard bytes.contains(60) else { return cleanedRaw }
        try validateHTMLSafetyGuards(cleanedRaw, bytes)
        var out = Data()
        out.reserveCapacity(n + 256)
        var pos = 0
        var last = 0
        var mathDepth = 0
        var templateDepth = 0
        enum TemplateForeignNS { case svg, math }
        struct TemplateForeignFrame {
            let tag: String
            let ns: TemplateForeignNS
            let isHtmlIntegration: Bool
            let isMathTextIntegration: Bool
            let templateLevel: Int
        }
        var templateForeignStack: [TemplateForeignFrame] = []
        var templateOuterStart = 0

        struct RewrittenEntry {
            let emittedTag: String // "" == passthrough sentinel for nested visible same-name tag
            let scopeId: Int // -1 if not tracked on divScopeStack
            let frameId: Int
            let dlDepth: Int // dlDtHiddenFrames.count when opened
        }
        struct DivScopeItem {
            let id: Int
            let origTag: String
            let isLiteralDiv: Bool
            let isTableBoundary: Bool
        }
        // Strictly O(1) amortized in-place stacks (avoiding Swift CoW copy-on-pop).
        var rewrittenTagStacks: [String: [RewrittenEntry]] = [:]
        var divScopeStack: [DivScopeItem] = []
        var closedScopeIds: Set<Int> = []
        var nextScopeId = 1
        var literalDivCountsByTableFrame: [Int] = [0]
        var scopeBoundaryKinds: [String] = ["root"]
        var scopeBoundaryFrameIds: [Int] = [0]
        var nextFrameId = 1
        var openBoundaryCounts: [String: Int] = [:]
        var tableCellCountsStack: [[String: Int]] = [[:]]
        var dlDtHiddenFrames: [(frameId: Int, count: Int)] = []
        var tableDepth = 0
        var selectDepth = 0
        var inHiddenP = false
        var inBody = false
        var sawAnyElement = false
        var firstHtmlInsertOffset: Int? = nil
        var firstBodyInsertOffset: Int? = nil
        var leadingDoctypeEndInOut: Int? = nil
        var htmlAlreadyHidden = false
        var bodyAlreadyHidden = false
        var sawLateHiddenHtml = false
        var sawLateHiddenBody = false

        func startsCI(_ ascii: String, at idx: Int) -> Bool {
            let pat = Array(ascii.utf8)
            guard idx + pat.count <= n else { return false }
            for k in 0..<pat.count {
                let b = bytes[idx + k]
                let lc = (65...90).contains(b) ? b + 32 : b
                if lc != pat[k] { return false }
            }
            return true
        }
        func startsExact(_ ascii: String, at idx: Int) -> Bool {
            let pat = Array(ascii.utf8)
            guard idx + pat.count <= n else { return false }
            return bytes[idx..<(idx + pat.count)].elementsEqual(pat)
        }
        func findDelimiter(_ delim: String, from start: Int) -> Int {
            let pat = Array(delim.utf8)
            var idx = start
            while idx + pat.count <= n {
                if bytes[idx..<(idx + pat.count)].elementsEqual(pat) { return idx + pat.count }
                idx += 1
            }
            return n
        }
        func findFirstGreaterThan(from start: Int) -> Int {
            var idx = start
            while idx < n {
                if bytes[idx] == 62 { return idx + 1 }
                idx += 1
            }
            return n
        }
        func appendOpenTagRest(from nameEnd: Int, to tagEnd: Int, stripSelfClosing: Bool = false) {
            var endIdx = tagEnd
            var addClose = false
            if stripSelfClosing && endIdx >= nameEnd + 2 && bytes[endIdx - 2] == 47 && bytes[endIdx - 1] == 62 {
                endIdx -= 2
                addClose = true
            }
            if nameEnd < endIdx && bytes[nameEnd] == 47 && !(nameEnd + 1 < endIdx && bytes[nameEnd + 1] == 62) {
                out.append(32)
                out.append(contentsOf: bytes[(nameEnd + 1)..<endIdx])
            } else {
                out.append(contentsOf: bytes[nameEnd..<endIdx])
            }
            if addClose { out.append(62) }
        }
        func appendRawWSOpenTagRest(from rawNameEnd: Int, to rawEnd: Int, stripSelfClosing: Bool = false) {
            var endIdx = rawEnd
            var addClose = false
            if stripSelfClosing && endIdx >= rawNameEnd + 2 && rawWSBytes[endIdx - 2] == 47 && rawWSBytes[endIdx - 1] == 62 {
                endIdx -= 2
                addClose = true
            }
            if rawNameEnd < endIdx && rawWSBytes[rawNameEnd] == 47 && !(rawNameEnd + 1 < endIdx && rawWSBytes[rawNameEnd + 1] == 62) {
                out.append(32)
                out.append(contentsOf: rawWSBytes[(rawNameEnd + 1)..<endIdx])
            } else {
                out.append(contentsOf: rawWSBytes[rawNameEnd..<endIdx])
            }
            if addClose { out.append(62) }
        }
        func hasFontBreakoutAttr(_ slice: ArraySlice<UInt8>) -> Bool {
            let lower = String(decoding: slice.map { (65...90).contains($0) ? $0 + 32 : $0 }, as: UTF8.self)
            return lower.contains("color") || lower.contains("face") || lower.contains("size")
        }
        /// WHATWG HTML5 §13.2.6.1: `<annotation-xml>` is an HTML integration point ONLY when
        /// its `encoding` attribute is `"text/html"` or `"application/xhtml+xml"` (ASCII CI).
        func hasHtmlAnnotationXmlEncoding(_ slice: ArraySlice<UInt8>) -> Bool {
            let buf = Array(slice)
            let m = buf.count
            func isWS(_ b: UInt8) -> Bool { b == 32 || b == 9 || b == 10 || b == 13 || b == 12 }
            func asciiLower(_ s: ArraySlice<UInt8>) -> String {
                String(decoding: s.map { (65...90).contains($0) ? $0 + 32 : $0 }, as: UTF8.self)
            }
            var w = 0
            while w < m {
                while w < m && (isWS(buf[w]) || buf[w] == 47) { w += 1 }
                if w >= m || buf[w] == 62 { break }
                let ns = w
                w += 1
                while w < m && !isWS(buf[w]) && buf[w] != 47 && buf[w] != 61 && buf[w] != 62 { w += 1 }
                let aName = asciiLower(buf[ns..<w])
                while w < m && isWS(buf[w]) { w += 1 }
                var aVal: String? = nil
                if w < m && buf[w] == 61 {
                    w += 1
                    while w < m && isWS(buf[w]) { w += 1 }
                    if w < m && (buf[w] == 34 || buf[w] == 39) {
                        let q = buf[w]; w += 1
                        let vs = w
                        while w < m && buf[w] != q { w += 1 }
                        aVal = asciiLower(buf[vs..<w])
                        if w < m { w += 1 }
                    } else if w < m && buf[w] != 62 {
                        let vs = w
                        while w < m && !isWS(buf[w]) && buf[w] != 62 { w += 1 }
                        aVal = asciiLower(buf[vs..<w])
                    }
                }
                if aName == "encoding", let v = aVal, (v == "text/html" || v == "application/xhtml+xml") {
                    return true
                }
            }
            return false
        }
        /// Strictly O(N) amortized memoized WHATWG HTML5 §13.2.5.32–38 attribute scanner.
        /// Caches `(end, hasHidden, selfClosing)` at every visited `BEFORE_ATTR_NAME` offset
        /// plus monotonic non-delimiter span skips so adversarial unclosed tags stay O(N).
        struct WHATWGScanCache {
            var memo: [Int: (end: Int, hasHidden: Bool, selfClosing: Bool)] = [:]
            var lastNameSpan: (start: Int, end: Int) = (-1, -1)
            var lastUnquotedSpan: (start: Int, end: Int) = (-1, -1)
            var lastDQuoteSpan: (start: Int, end: Int) = (-1, -1)
            var lastSQuoteSpan: (start: Int, end: Int) = (-1, -1)
            let lastGtIndex: Int
            init(_ buf: [UInt8]) {
                self.lastGtIndex = buf.lastIndex(of: 62) ?? -1
            }
        }
        var cleanWhatwgCache = WHATWGScanCache(bytes)
        var rawWhatwgCache = WHATWGScanCache(rawWSBytes)
        let hiddenBytes: [UInt8] = [104, 105, 100, 100, 101, 110] // "hidden"
        func scanWHATWGFromBeforeAttr(
            _ buf: [UInt8],
            start w0: Int,
            cache: inout WHATWGScanCache
        ) -> (end: Int, hasHidden: Bool, selfClosing: Bool) {
            let m = buf.count
            if w0 > cache.lastGtIndex {
                return (m, false, false)
            }
            func isWS(_ b: UInt8) -> Bool { b == 32 || b == 9 || b == 10 || b == 13 || b == 12 }
            var w = w0
            var trail: [(w: Int, isHidden: Bool)] = []
            var result: (end: Int, hasHidden: Bool, selfClosing: Bool) = (m, false, false)
            while w < m {
                var sawSlashBeforeGt = false
                while w < m && (isWS(buf[w]) || buf[w] == 47) {
                    sawSlashBeforeGt = (buf[w] == 47)
                    w += 1
                }
                if w >= m {
                    result = (m, false, false)
                    break
                }
                if buf[w] == 62 {
                    result = (w + 1, false, sawSlashBeforeGt)
                    break
                }
                if let cached = cache.memo[w] {
                    result = cached
                    break
                }
                let attrStart = w
                var idx = w + 1
                if idx >= cache.lastNameSpan.start && idx < cache.lastNameSpan.end {
                    idx = cache.lastNameSpan.end
                } else {
                    let s0 = idx
                    while idx < m && !isWS(buf[idx]) && buf[idx] != 47 && buf[idx] != 61 && buf[idx] != 62 { idx += 1 }
                    if idx - s0 > 32 && idx > cache.lastNameSpan.end {
                        cache.lastNameSpan = (s0, idx)
                    }
                }
                var isHidden = false
                if idx - attrStart == 6 {
                    var eq = true
                    for k in 0..<6 {
                        let b = buf[attrStart + k]
                        let lc = (65...90).contains(b) ? b + 32 : b
                        if lc != hiddenBytes[k] { eq = false; break }
                    }
                    isHidden = eq
                }
                while idx < m && isWS(buf[idx]) { idx += 1 }
                if idx < m && buf[idx] == 61 {
                    idx += 1
                    while idx < m && isWS(buf[idx]) { idx += 1 }
                    if idx < m && (buf[idx] == 34 || buf[idx] == 39) {
                        let q = buf[idx]
                        idx += 1
                        if q == 34 {
                            if idx >= cache.lastDQuoteSpan.start && idx < cache.lastDQuoteSpan.end {
                                idx = cache.lastDQuoteSpan.end
                            } else {
                                let qs = idx
                                while idx < m && buf[idx] != 34 { idx += 1 }
                                if idx - qs > 32 && idx > cache.lastDQuoteSpan.end {
                                    cache.lastDQuoteSpan = (qs, idx)
                                }
                            }
                        } else {
                            if idx >= cache.lastSQuoteSpan.start && idx < cache.lastSQuoteSpan.end {
                                idx = cache.lastSQuoteSpan.end
                            } else {
                                let qs = idx
                                while idx < m && buf[idx] != 39 { idx += 1 }
                                if idx - qs > 32 && idx > cache.lastSQuoteSpan.end {
                                    cache.lastSQuoteSpan = (qs, idx)
                                }
                            }
                        }
                        if idx < m { idx += 1 }
                    } else if idx < m && buf[idx] == 62 {
                        trail.append((attrStart, isHidden))
                        result = (idx + 1, false, false)
                        break
                    } else if idx < m {
                        if idx >= cache.lastUnquotedSpan.start && idx < cache.lastUnquotedSpan.end {
                            idx = cache.lastUnquotedSpan.end
                        } else {
                            let us = idx
                            while idx < m && !isWS(buf[idx]) && buf[idx] != 62 { idx += 1 }
                            if idx - us > 32 && idx > cache.lastUnquotedSpan.end {
                                cache.lastUnquotedSpan = (us, idx)
                            }
                        }
                    }
                }
                trail.append((attrStart, isHidden))
                w = idx
            }
            var accHidden = result.hasHidden
            for step in trail.reversed() {
                accHidden = accHidden || step.isHidden
                cache.memo[step.w] = (result.end, accHidden, result.selfClosing)
            }
            return (result.end, accHidden, result.selfClosing)
        }
        struct RawFormFeedTagInfo {
            let name: String
            let closing: Bool
            let attrInfo: (hasHidden: Bool, idValue: String?, classValue: String?)
            let mappedCleanEnd: Int
            let rawStart: Int
            let rawNameEnd: Int
            let rawEnd: Int
            let selfClosing: Bool
            let validDelim: Bool
            let whatwgExtended: Bool
        }
        func resolveRawFormFeedTag(at cleanStart: Int) throws -> RawFormFeedTagInfo? {
            guard hasFormFeedInRaw, cleanStart < cleanToRawWS.count else { return nil }
            let rawStart = cleanToRawWS[cleanStart]
            switch scanHTML5ByteTag(rawWSBytes, at: rawStart) {
            case .tag(let rawName, let rawNameEnd, let rawEnd0, let rawClosing, let rawSelfClosing0, let rawValidDelim):
                var rawEnd = rawEnd0
                var rawSelfClosing = rawSelfClosing0
                var whatwgExtended = false
                var rawAttrInfo: (hasHidden: Bool, idValue: String?, classValue: String?) = (false, nil, nil)
                if !rawClosing {
                    let wScan = scanWHATWGFromBeforeAttr(rawWSBytes, start: rawNameEnd, cache: &rawWhatwgCache)
                    let wClosed = wScan.end > rawNameEnd && wScan.end <= rawWSBytes.count && rawWSBytes[wScan.end - 1] == 62
                    if wClosed && wScan.end > rawEnd {
                        let checkEnd = wScan.end
                        if checkEnd <= ffPrefixCount.count - 1 && ffPrefixCount[checkEnd] > ffPrefixCount[rawStart] {
                            rawAttrInfo = parseHiddenAndIdentityAttrs(rawWSBytes[rawNameEnd..<rawEnd])
                            if wScan.hasHidden {
                                let wAttr = parseHiddenAndIdentityAttrs(rawWSBytes[rawNameEnd..<checkEnd])
                                rawAttrInfo = (true, wAttr.idValue ?? rawAttrInfo.idValue, wAttr.classValue ?? rawAttrInfo.classValue)
                                rawEnd = checkEnd
                                rawSelfClosing = wScan.selfClosing
                                whatwgExtended = true
                            } else if rawName == "template" || rawName == "script" || rawName == "style" || rawName == "server"
                                || rawName == "noscript" || rawName == "plaintext"
                                || rawName == "textarea" || rawName == "title" || rawName == "xmp"
                                || rawName == "iframe" || rawName == "noembed" || rawName == "noframes" {
                                rawEnd = checkEnd
                                rawSelfClosing = wScan.selfClosing
                                whatwgExtended = true
                            }
                        } else {
                            return nil
                        }
                    } else {
                        guard rawEnd <= ffPrefixCount.count - 1, ffPrefixCount[rawEnd] > ffPrefixCount[rawStart] else {
                            return nil
                        }
                        rawAttrInfo = parseHiddenAndIdentityAttrs(rawWSBytes[rawNameEnd..<rawEnd])
                        if wClosed && wScan.hasHidden {
                            rawAttrInfo.hasHidden = true
                        }
                    }
                } else {
                    guard rawEnd <= ffPrefixCount.count - 1, ffPrefixCount[rawEnd] > ffPrefixCount[rawStart] else {
                        return nil
                    }
                }
                return RawFormFeedTagInfo(
                    name: rawName,
                    closing: rawClosing,
                    attrInfo: rawAttrInfo,
                    mappedCleanEnd: rawWSToClean[rawEnd],
                    rawStart: rawStart,
                    rawNameEnd: rawNameEnd,
                    rawEnd: rawEnd,
                    selfClosing: rawSelfClosing,
                    validDelim: rawValidDelim,
                    whatwgExtended: whatwgExtended
                )
            case .unquotedLessThan:
                throw ServiceError.invalid("文章标签包含不安全或未加引号的尖括号属性值，未猜测解析边界。")
            default:
                return nil
            }
        }
        func popRewrittenThrough(origTag: String, scopeId: Int, frameId: Int) {
            guard var stack = rewrittenTagStacks[origTag] else { return }
            while let entry = stack.last, entry.frameId == frameId {
                stack.removeLast()
                if entry.scopeId == scopeId { break }
            }
            rewrittenTagStacks[origTag] = stack
        }
        func pushBoundaryFrame(_ kind: String) {
            let sid = nextScopeId
            nextScopeId += 1
            let fid = nextFrameId
            nextFrameId += 1
            divScopeStack.append(DivScopeItem(id: sid, origTag: kind, isLiteralDiv: false, isTableBoundary: true))
            literalDivCountsByTableFrame.append(0)
            scopeBoundaryKinds.append(kind)
            scopeBoundaryFrameIds.append(fid)
            openBoundaryCounts[kind, default: 0] += 1
            if kind == "table" {
                tableCellCountsStack.append([:])
            } else if kind == "td" || kind == "th" || kind == "caption" {
                tableCellCountsStack[tableCellCountsStack.count - 1][kind, default: 0] += 1
            }
        }
        @discardableResult
        func popOneBoundaryFrame() -> Int {
            guard scopeBoundaryKinds.count > 1 else { return 0 }
            let poppedKind = scopeBoundaryKinds.removeLast()
            let poppedFrame = scopeBoundaryFrameIds.removeLast()
            literalDivCountsByTableFrame.removeLast()
            inHiddenP = false
            if let c = openBoundaryCounts[poppedKind], c > 0 {
                openBoundaryCounts[poppedKind] = c - 1
            }
            if poppedKind == "table" {
                if tableCellCountsStack.count > 1 {
                    tableCellCountsStack.removeLast()
                }
            } else if poppedKind == "td" || poppedKind == "th" || poppedKind == "caption" {
                let topIdx = tableCellCountsStack.count - 1
                if let c = tableCellCountsStack[topIdx][poppedKind] {
                    if c <= 1 {
                        tableCellCountsStack[topIdx].removeValue(forKey: poppedKind)
                    } else {
                        tableCellCountsStack[topIdx][poppedKind] = c - 1
                    }
                }
            }
            while let topDt = dlDtHiddenFrames.last, topDt.frameId == poppedFrame {
                dlDtHiddenFrames.removeLast()
            }
            var closesToEmit = 0
            while let top = divScopeStack.last {
                divScopeStack.removeLast()
                if top.isTableBoundary { break }
                if !closedScopeIds.contains(top.id) {
                    closedScopeIds.insert(top.id)
                    closesToEmit += 1
                    if !top.isLiteralDiv {
                        popRewrittenThrough(origTag: top.origTag, scopeId: top.id, frameId: poppedFrame)
                    }
                }
            }
            return closesToEmit
        }
        func pushRewritten(_ origTag: String, emittedTag: String) {
            let curFrame = scopeBoundaryFrameIds.last ?? 0
            let curDlDepth = dlDtHiddenFrames.count
            if emittedTag == "div" {
                let sid = nextScopeId
                nextScopeId += 1
                divScopeStack.append(DivScopeItem(id: sid, origTag: origTag, isLiteralDiv: false, isTableBoundary: false))
                rewrittenTagStacks[origTag, default: []].append(RewrittenEntry(emittedTag: emittedTag, scopeId: sid, frameId: curFrame, dlDepth: curDlDepth))
            } else {
                rewrittenTagStacks[origTag, default: []].append(RewrittenEntry(emittedTag: emittedTag, scopeId: -1, frameId: curFrame, dlDepth: curDlDepth))
            }
        }
        /// Unwinds `divScopeStack` down to and including `targetScopeId` within the current boundary frame,
        /// returning the exact number of `</div>` closing tags required so inner unclosed literal `<div>`s
        /// cannot stay open or leak stale counts into `literalDivCountsByTableFrame`.
        func unwindDivScopeDownTo(scopeId targetScopeId: Int) -> Int {
            if closedScopeIds.contains(targetScopeId) { return 0 }
            let curFrame = scopeBoundaryFrameIds.last ?? 0
            var closesToEmit = 0
            while let top = divScopeStack.last {
                if top.isTableBoundary { break }
                divScopeStack.removeLast()
                if closedScopeIds.contains(top.id) { continue }
                closedScopeIds.insert(top.id)
                closesToEmit += 1
                if top.isLiteralDiv {
                    let lastIdx = literalDivCountsByTableFrame.count - 1
                    if literalDivCountsByTableFrame[lastIdx] > 0 {
                        literalDivCountsByTableFrame[lastIdx] -= 1
                    }
                } else if top.id != targetScopeId {
                    popRewrittenThrough(origTag: top.origTag, scopeId: top.id, frameId: curFrame)
                    if top.origTag == "dt", let lastDt = dlDtHiddenFrames.last,
                       lastDt.frameId == curFrame, lastDt.count > 0 {
                        dlDtHiddenFrames[dlDtHiddenFrames.count - 1].count -= 1
                    }
                }
                if top.id == targetScopeId { break }
            }
            return closesToEmit
        }
        func popPassthroughDtAtCurrentDlDepth() {
            let curFrame = scopeBoundaryFrameIds.last ?? 0
            let curDlDepth = dlDtHiddenFrames.count
            guard var stack = rewrittenTagStacks["dt"] else { return }
            while let top = stack.last, top.frameId == curFrame, top.emittedTag.isEmpty, top.dlDepth == curDlDepth {
                stack.removeLast()
            }
            rewrittenTagStacks["dt"] = stack
        }
        func flushOneDtHiddenInCurrentFrame(before tagPos: Int) {
            let curFrame = scopeBoundaryFrameIds.last ?? 0
            popPassthroughDtAtCurrentDlDepth()
            guard let topFrame = dlDtHiddenFrames.last, topFrame.frameId == curFrame, topFrame.count > 0 else { return }
            dlDtHiddenFrames[dlDtHiddenFrames.count - 1].count -= 1
            if let lastEntry = rewrittenTagStacks["dt"]?.last, lastEntry.frameId == curFrame, !lastEntry.emittedTag.isEmpty {
                let entry = rewrittenTagStacks["dt"]!.removeLast()
                let closes: Int
                if entry.scopeId > 0 {
                    closes = unwindDivScopeDownTo(scopeId: entry.scopeId)
                } else {
                    closes = 1
                }
                if closes > 0 {
                    out.append(contentsOf: bytes[last..<tagPos])
                    for _ in 0..<closes { out.append(contentsOf: "</\(entry.emittedTag)>".utf8) }
                    last = tagPos
                }
            }
        }
        func flushAllDtHiddenInCurrentFrame(before tagPos: Int) {
            let curFrame = scopeBoundaryFrameIds.last ?? 0
            popPassthroughDtAtCurrentDlDepth()
            guard let topFrame = dlDtHiddenFrames.last, topFrame.frameId == curFrame else { return }
            let curDlDepth = dlDtHiddenFrames.count
            let count = dlDtHiddenFrames.removeLast().count
            guard count > 0 else { return }
            out.append(contentsOf: bytes[last..<tagPos])
            for _ in 0..<count {
                while let top = rewrittenTagStacks["dt"]?.last, top.frameId == curFrame, top.emittedTag.isEmpty, top.dlDepth == curDlDepth {
                    _ = rewrittenTagStacks["dt"]!.removeLast()
                }
                if let lastEntry = rewrittenTagStacks["dt"]?.last, lastEntry.frameId == curFrame, !lastEntry.emittedTag.isEmpty {
                    let entry = rewrittenTagStacks["dt"]!.removeLast()
                    let closes = entry.scopeId > 0 ? unwindDivScopeDownTo(scopeId: entry.scopeId) : 1
                    for _ in 0..<closes { out.append(contentsOf: "</\(entry.emittedTag)>".utf8) }
                }
            }
            last = tagPos
        }

        let rcdataElements: Set<String> = ["textarea", "title", "xmp", "iframe", "noembed", "noframes"]
        // WHATWG HTML5 §13.2.6.5 foreign-content breakout start tags
        let foreignBreakoutTags: Set<String> = [
            "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt",
            "em", "embed", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i", "img", "li",
            "listing", "menu", "meta", "nobr", "ol", "p", "pre", "ruby", "s", "small", "span",
            "strong", "strike", "sub", "sup", "table", "tt", "u", "ul", "var"
        ]
        // WHATWG HTML5 §13.2.6.5 SVG/MathML integration point tags
        let svgIntegrationPoints: Set<String> = ["foreignobject", "desc", "title"]
        let mathMLTextIntegrationPoints: Set<String> = ["mi", "mo", "mn", "ms", "mtext"]
        // Tags that close an open `<p>` / `<p hidden>` in WHATWG HTML5 §13.2.6.4.7
        let pClosingBlockTags: Set<String> = [
            "address", "article", "aside", "blockquote", "center", "details", "dialog", "dir",
            "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
            "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "listing",
            "main", "menu", "nav", "ol", "p", "plaintext", "pre", "search", "section", "summary",
            "table", "ul", "xmp"
        ]
        // Obsolete/non-HTML5 tags that prematurely close `<p hidden>` / `<div hidden>` in Apple's libtidy
        let obsoleteQuirksBreakers: Set<String> = ["frameset", "frame", "isindex", "layer", "multicol", "bgsound", "nextid"]
        let headOnlyTags: Set<String> = ["html", "head", "meta", "link", "base", "title", "style", "script", "noscript"]
        let tableInnerTags: Set<String> = ["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"]
        let tableCellScopeTags: Set<String> = ["td", "th", "caption"]
        let nonTableScopeBoundaryTags: Set<String> = ["object", "applet", "marquee"]
        let formFeedAlwaysSplitTags: Set<String> = [
            "template", "script", "style", "server", "noscript", "plaintext",
            "textarea", "title", "xmp", "iframe", "noembed", "noframes", "frameset", "frame",
            "html", "body"
        ]
        let formFeedStructuralTags: Set<String> = Set<String>([
            "select", "option", "optgroup", "object", "applet", "marquee",
            "svg", "math", "desc", "foreignobject", "mi", "mo", "mn", "ms", "mtext",
            "annotation-xml", "mglyph", "malignmark", "font"
        ]).union(foreignBreakoutTags).union(pClosingBlockTags).union(obsoleteQuirksBreakers)
          .union(tableInnerTags).union(preserveTags).union(containerTags).union(inlineContainerTags)
        let ltEntity = Array("&lt;".utf8)
        let ltJSON = Array("\\u003c".utf8)
        let inertComment = Array("<!-- -->".utf8)

        while pos < n {
            if bytes[pos] != 60 {
                if templateDepth == 0 && mathDepth == 0 {
                    let b = bytes[pos]
                    if b != 32 && b != 9 && b != 10 && b != 13 && b != 12 {
                        sawAnyElement = true
                        inBody = true
                    }
                }
                pos += 1
                continue
            }
            if startsCI("<!--", at: pos) {
                if mathDepth > 0 && templateDepth == 0 {
                    pos = findDelimiter("-->", from: pos + 4)
                } else {
                    let cScan = scanHTML5CommentEnd(bytes, from: pos)
                    if templateDepth == 0 && mathDepth == 0 && cScan.needsRewrite {
                        out.append(contentsOf: bytes[last..<pos])
                        out.append(contentsOf: inertComment)
                        last = cScan.end
                    }
                    pos = cScan.end
                }
                continue
            }
            if startsExact("<![CDATA[", at: pos) {
                let inForeignCdata: Bool
                if templateDepth > 0 {
                    if let tf = templateForeignStack.last, tf.templateLevel == templateDepth {
                        inForeignCdata = !tf.isHtmlIntegration && !tf.isMathTextIntegration
                    } else {
                        inForeignCdata = false
                    }
                } else {
                    inForeignCdata = mathDepth > 0
                }
                if inForeignCdata {
                    pos = findDelimiter("]]>", from: pos + 9)
                } else {
                    // Outside foreign content (SVG/MathML), WHATWG §13.2.5.42 parses `<![CDATA[...>`
                    // as a bogus comment ending at the first '>'.
                    let cEnd = findFirstGreaterThan(from: pos + 9)
                    if templateDepth == 0 && mathDepth == 0 {
                        out.append(contentsOf: bytes[last..<pos])
                        out.append(contentsOf: inertComment)
                        last = cEnd
                    }
                    pos = cEnd
                }
                continue
            }
            if pos + 2 < n, bytes[pos + 1] == 33, bytes[pos + 2] == 91 {
                throw ServiceError.invalid("文章包含不支持的SGML标记段，未交给HTML解析。")
            }
            if startsExact("<?php", at: pos) || startsExact("<%", at: pos) || startsExact("<#", at: pos) {
                throw ServiceError.invalid("文章包含不支持的服务器脚本或模板标签，未交给HTML解析。")
            }
            if pos + 1 < n, bytes[pos + 1] == 33 {
                var idx = pos + 2
                while idx < n, idx - pos <= 65536 {
                    if bytes[idx] == 62 { idx += 1; break }
                    idx += 1
                }
                guard idx <= n, idx > pos + 2, bytes[idx - 1] == 62 else {
                    throw ServiceError.invalid("文章声明不完整，未交给外部实体解析器。")
                }
                let declaration = String(decoding: bytes[pos..<idx], as: UTF8.self)
                guard declaration.range(of: #"\A<!DOCTYPE[\t\r\n ]+html[\t\r\n ]*>\z"#, options: [.regularExpression, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")) != nil else {
                    throw ServiceError.invalid("文章包含不支持的DOCTYPE或实体声明。")
                }
                if templateDepth == 0 && mathDepth == 0 && !sawAnyElement && !inBody {
                    out.append(contentsOf: bytes[last..<idx])
                    last = idx
                    leadingDoctypeEndInOut = out.count
                }
                pos = idx
                continue
            }
            if pos + 1 < n, bytes[pos + 1] == 63 {
                var idx = pos + 2
                while idx < n {
                    if bytes[idx] == 62 { idx += 1; break }
                    idx += 1
                }
                pos = idx
                continue
            }
            let t: (name: String, nameEnd: Int, end: Int, closing: Bool, selfClosing: Bool, validDelim: Bool)
            switch scanHTML5ByteTag(bytes, at: pos) {
            case .notATag:
                pos += 1
                continue
            case .bogusComment(let end):
                pos = end
                continue
            case .unquotedLessThan:
                throw ServiceError.invalid("文章标签包含不安全或未加引号的尖括号属性值，未猜测解析边界。")
            case .unclosedEOF, .tooLong:
                pos = n
                continue
            case .tag(let name, let nameEnd, let end, let closing, let selfClosing, let validDelim):
                t = (name, nameEnd, end, closing, selfClosing, validDelim)
            }

            // Resolve form-feed (`0x0C`) full WHATWG tag boundaries & attributes (both opening and closing tags)
            // when present in raw bytes, keeping libtidy sync on harmless non-structural tags.
            let ffInfo = hasFormFeedInRaw ? try resolveRawFormFeedTag(at: pos) : nil
            let curFrameForFF = scopeBoundaryFrameIds.last ?? 0
            let effectiveName: String
            let formFeedSplitTag: Bool
            var effectiveTagEnd = t.end
            var effectiveSelfClosing = t.selfClosing
            var whatwgExtendedTag = false
            if let ff = ffInfo, ff.closing == t.closing,
               (formFeedAlwaysSplitTags.contains(ff.name)
                || (!t.closing && ff.attrInfo.hasHidden)
                || templateDepth > 0
                || mathDepth > 0
                || ((t.closing || ff.mappedCleanEnd == t.end)
                    && (formFeedStructuralTags.contains(ff.name)
                        || (rewrittenTagStacks[ff.name]?.last?.frameId == curFrameForFF)))) {
                effectiveName = ff.name
                formFeedSplitTag = true
                effectiveTagEnd = max(t.end, ff.mappedCleanEnd)
                effectiveSelfClosing = ff.selfClosing
                whatwgExtendedTag = ff.whatwgExtended
            } else {
                effectiveName = t.name
                formFeedSplitTag = false
            }

            // Apply strict O(N) memoized WHATWG tag boundaries to `<template>`, RAWTEXT, RCDATA, and `<plaintext>`
            // open tags so `<` / quote-as-equals / `-"'` in attributes cannot truncate the tag early
            // (preserving libtidy `<p>` interior escaping on unclosed RCDATA/plaintext without quoted `>`, e.g. `<textarea a=b/<p>`).
            if !t.closing && !formFeedSplitTag,
               (effectiveName == "template" || effectiveName == "script" || effectiveName == "style"
                || effectiveName == "server" || effectiveName == "noscript" || effectiveName == "plaintext"
                || rcdataElements.contains(effectiveName)) {
                let wScan = scanWHATWGFromBeforeAttr(bytes, start: t.nameEnd, cache: &cleanWhatwgCache)
                if wScan.end > effectiveTagEnd && wScan.end <= n && bytes[wScan.end - 1] == 62 {
                    let isRcdataOrPlaintext = effectiveName == "plaintext" || rcdataElements.contains(effectiveName)
                    if !isRcdataOrPlaintext || wScan.hasHidden || bytes[effectiveTagEnd..<(wScan.end - 1)].contains(62) {
                        effectiveTagEnd = wScan.end
                        effectiveSelfClosing = wScan.selfClosing
                        whatwgExtendedTag = true
                    }
                }
            }

            if templateDepth > 0 {
                // Inside inert <template>, apply WHATWG HTML5 §13.2.6.1 / §13.2.6.5 foreign-content rules:
                // HTML/MathML integration points, `<annotation-xml encoding=...>`, `<mglyph>`/`<malignmark>`,
                // bounded breakout unwinding, namespace-preserving nesting, and `</template>` unwinding.
                if t.closing && effectiveName == "template" && (t.validDelim || formFeedSplitTag) {
                    while let top = templateForeignStack.last, top.templateLevel == templateDepth {
                        templateForeignStack.removeLast()
                    }
                    templateDepth -= 1
                    if templateDepth == 0 {
                        templateForeignStack.removeAll()
                        out.append(contentsOf: bytes[last..<templateOuterStart])
                        out.append(contentsOf: inertComment)
                        last = effectiveTagEnd
                    }
                    pos = effectiveTagEnd
                    continue
                }
                var inCurrentForeign = templateForeignStack.last?.templateLevel == templateDepth
                if inCurrentForeign {
                    let topF = templateForeignStack.last!
                    let inAnyIntegration = topF.isHtmlIntegration || topF.isMathTextIntegration
                    if t.closing {
                        if !inAnyIntegration && (effectiveName == "p" || effectiveName == "br") {
                            // WHATWG §13.2.6.5 breakout end tags pop foreign nodes down to nearest integration point or HTML element.
                            while let top = templateForeignStack.last, top.templateLevel == templateDepth,
                                  !top.isHtmlIntegration, !top.isMathTextIntegration {
                                templateForeignStack.removeLast()
                            }
                            pos = effectiveTagEnd
                            continue
                        }
                        if inAnyIntegration {
                            if effectiveName == topF.tag {
                                _ = templateForeignStack.popLast()
                            }
                            pos = effectiveTagEnd
                            continue
                        }
                        // Non-integration foreign end tag: match any open foreign element at current templateLevel.
                        if let matchIdx = templateForeignStack.lastIndex(where: { $0.templateLevel == templateDepth && $0.tag == effectiveName }) {
                            templateForeignStack.removeSubrange(matchIdx..<templateForeignStack.count)
                        }
                        pos = effectiveTagEnd
                        continue
                    } else {
                        if !inAnyIntegration {
                            let attrSlice = (formFeedSplitTag && ffInfo != nil)
                                ? rawWSBytes[ffInfo!.rawNameEnd..<ffInfo!.rawEnd]
                                : bytes[t.nameEnd..<effectiveTagEnd]
                            let isBreakout = foreignBreakoutTags.contains(effectiveName)
                                || (effectiveName == "font" && hasFontBreakoutAttr(attrSlice))
                            if isBreakout {
                                while let top = templateForeignStack.last, top.templateLevel == templateDepth,
                                      !top.isHtmlIntegration, !top.isMathTextIntegration {
                                    templateForeignStack.removeLast()
                                }
                                inCurrentForeign = templateForeignStack.last?.templateLevel == templateDepth
                            } else {
                                if !effectiveSelfClosing {
                                    if topF.ns == .svg {
                                        if svgIntegrationPoints.contains(effectiveName) {
                                            templateForeignStack.append(TemplateForeignFrame(
                                                tag: effectiveName, ns: .svg, isHtmlIntegration: true, isMathTextIntegration: false, templateLevel: templateDepth
                                            ))
                                        } else if effectiveName == "svg" || effectiveName == "math" {
                                            templateForeignStack.append(TemplateForeignFrame(
                                                tag: effectiveName, ns: .svg, isHtmlIntegration: false, isMathTextIntegration: false, templateLevel: templateDepth
                                            ))
                                        }
                                    } else {
                                        if mathMLTextIntegrationPoints.contains(effectiveName) {
                                            templateForeignStack.append(TemplateForeignFrame(
                                                tag: effectiveName, ns: .math, isHtmlIntegration: false, isMathTextIntegration: true, templateLevel: templateDepth
                                            ))
                                        } else if effectiveName == "annotation-xml" {
                                            let isHtmlInt = hasHtmlAnnotationXmlEncoding(attrSlice)
                                            templateForeignStack.append(TemplateForeignFrame(
                                                tag: effectiveName, ns: .math, isHtmlIntegration: isHtmlInt, isMathTextIntegration: false, templateLevel: templateDepth
                                            ))
                                        } else if effectiveName == "math" || effectiveName == "svg" {
                                            templateForeignStack.append(TemplateForeignFrame(
                                                tag: effectiveName, ns: .math, isHtmlIntegration: false, isMathTextIntegration: false, templateLevel: templateDepth
                                            ))
                                        }
                                    }
                                }
                                pos = effectiveTagEnd
                                continue
                            }
                        } else if topF.isMathTextIntegration && (effectiveName == "mglyph" || effectiveName == "malignmark") {
                            // WHATWG §13.2.6.1: `<mglyph>`/`<malignmark>` inside MathML text integration points stay in MathML foreign content.
                            if !effectiveSelfClosing {
                                templateForeignStack.append(TemplateForeignFrame(
                                    tag: effectiveName, ns: .math, isHtmlIntegration: false, isMathTextIntegration: false, templateLevel: templateDepth
                                ))
                            }
                            pos = effectiveTagEnd
                            continue
                        }
                    }
                }
                if !t.closing, effectiveName == "plaintext" {
                    pos = n
                    break
                }
                if !t.closing, (effectiveName == "script" || effectiveName == "style" || effectiveName == "server" || effectiveName == "noscript" || rcdataElements.contains(effectiveName)) {
                    switch scanRawTextElementEnd(bytes, rawName: effectiveName, from: effectiveTagEnd, formFeedAfterCleanPos: formFeedAfterCleanPos) {
                    case .closed(_, let cEnd):
                        pos = cEnd
                    case .unclosed:
                        pos = n
                    case .unsafe:
                        throw ServiceError.invalid("文章原始文本结束标签包含不安全的非ASCII截断字符，未猜测解析边界。")
                    }
                    continue
                }
                if !t.closing, effectiveName == "math" {
                    if !effectiveSelfClosing {
                        templateForeignStack.append(TemplateForeignFrame(
                            tag: "math", ns: .math, isHtmlIntegration: false, isMathTextIntegration: false, templateLevel: templateDepth
                        ))
                    }
                    pos = effectiveTagEnd
                    continue
                }
                if !t.closing, effectiveName == "svg" {
                    if !effectiveSelfClosing {
                        templateForeignStack.append(TemplateForeignFrame(
                            tag: "svg", ns: .svg, isHtmlIntegration: false, isMathTextIntegration: false, templateLevel: templateDepth
                        ))
                    }
                    pos = effectiveTagEnd
                    continue
                }
                if !t.closing, effectiveName == "template", (t.validDelim || formFeedSplitTag) {
                    templateDepth += 1
                }
                pos = effectiveTagEnd
                continue
            }
            if effectiveName == "math" {
                if t.closing {
                    mathDepth = max(0, mathDepth - 1)
                    if formFeedSplitTag {
                        out.append(contentsOf: bytes[last..<pos])
                        out.append(contentsOf: "</math>".utf8)
                        last = effectiveTagEnd
                    }
                } else {
                    if !effectiveSelfClosing { mathDepth += 1 }
                    if formFeedSplitTag, let ff = ffInfo {
                        out.append(contentsOf: bytes[last..<pos])
                        out.append(contentsOf: rawWSBytes[ff.rawStart..<ff.rawEnd])
                        last = effectiveTagEnd
                    }
                }
                pos = effectiveTagEnd
                continue
            }
            if mathDepth == 0 {
                let wasInBody = inBody
                let hadSeenAnyElement = sawAnyElement
                sawAnyElement = true
                if !t.closing && !headOnlyTags.contains(effectiveName) && effectiveName != "template" {
                    inBody = true
                }
                if effectiveName == "template", (t.validDelim || formFeedSplitTag) {
                    if !t.closing {
                        templateDepth = 1
                        templateForeignStack.removeAll()
                        templateOuterStart = pos
                    }
                    pos = effectiveTagEnd
                    continue
                }
                if obsoleteQuirksBreakers.contains(effectiveName) || (inHiddenP && effectiveName == "area") {
                    // Obsolete/quirks tags (`<frameset>`, `<frame>`, `<isindex>`, `<layer>`, `<multicol>`, `<bgsound>`, `<nextid>`,
                    // and `<area>` inside `<p hidden>`) force-close hidden wrappers or foster out of `<td hidden>` in libtidy.
                    out.append(contentsOf: bytes[last..<pos])
                    out.append(contentsOf: inertComment)
                    last = effectiveTagEnd
                    pos = effectiveTagEnd
                    continue
                }
                if wasInBody && effectiveName == "head" {
                    // Per WHATWG HTML5 §13.2.6.4.7, `<head>` / `</head>` in body are parse errors and ignored
                    // (never allowed to close `<p hidden>` or `<div hidden>` in libtidy).
                    out.append(contentsOf: bytes[last..<pos])
                    out.append(contentsOf: inertComment)
                    last = effectiveTagEnd
                    pos = effectiveTagEnd
                    continue
                }
                if !t.closing, effectiveName == "plaintext" {
                    inHiddenP = false
                    var ptAttr = ffInfo?.attrInfo.hasHidden == true ? ffInfo!.attrInfo : parseHiddenAndIdentityAttrs(bytes[t.nameEnd..<effectiveTagEnd])
                    if !ptAttr.hasHidden && !formFeedSplitTag {
                        let wScan = scanWHATWGFromBeforeAttr(bytes, start: t.nameEnd, cache: &cleanWhatwgCache)
                        if wScan.hasHidden && wScan.end > t.nameEnd && wScan.end <= n && bytes[wScan.end - 1] == 62 {
                            ptAttr = parseHiddenAndIdentityAttrs(bytes[t.nameEnd..<wScan.end])
                            ptAttr.hasHidden = true
                            effectiveTagEnd = max(effectiveTagEnd, wScan.end)
                        }
                    }
                    if ptAttr.hasHidden {
                        var cleanAttrs = " hidden"
                        if let idVal = ptAttr.idValue { cleanAttrs += " id=\"\(escapeNormalizedAttrValue(idVal))\"" }
                        if let clsVal = ptAttr.classValue { cleanAttrs += " class=\"\(escapeNormalizedAttrValue(clsVal))\"" }
                        out.append(contentsOf: bytes[last..<pos])
                        out.append(contentsOf: "<pre\(cleanAttrs)>".utf8)
                        appendEscapingLessThan(bytes[effectiveTagEnd..<n], replacement: ltEntity, to: &out)
                        out.append(contentsOf: "</pre>".utf8)
                    } else if !effectiveSelfClosing {
                        out.append(contentsOf: bytes[last..<pos])
                        if formFeedSplitTag || whatwgExtendedTag {
                            out.append(contentsOf: "<plaintext>".utf8)
                        } else {
                            out.append(contentsOf: bytes[pos..<effectiveTagEnd])
                            if effectiveTagEnd > pos && bytes[effectiveTagEnd - 1] != 62 {
                                if bytes[effectiveTagEnd - 1] == 47 { out.append(32) }
                                out.append(62)
                            }
                        }
                        appendEscapingLessThan(bytes[effectiveTagEnd..<n], replacement: ltEntity, to: &out)
                    } else {
                        pos = effectiveTagEnd
                        continue
                    }
                    last = n
                    pos = n
                    break
                }
                if !t.closing, effectiveName == "script" || effectiveName == "style" || effectiveName == "server" {
                    if effectiveSelfClosing && !formFeedSplitTag && !whatwgExtendedTag {
                        out.append(contentsOf: bytes[last..<pos])
                        out.append(contentsOf: inertComment)
                        last = effectiveTagEnd
                        pos = effectiveTagEnd
                        continue
                    }
                    let bodyEnd: Int
                    let closeEnd: Int
                    switch scanRawTextElementEnd(bytes, rawName: effectiveName, from: effectiveTagEnd, formFeedAfterCleanPos: formFeedAfterCleanPos) {
                    case .closed(let bEnd, let cEnd):
                        bodyEnd = bEnd; closeEnd = cEnd
                    case .unclosed(let bEnd):
                        bodyEnd = bEnd; closeEnd = n
                    case .unsafe:
                        throw ServiceError.invalid("文章原始文本结束标签包含不安全的非ASCII截断字符，未猜测解析边界。")
                    }
                    out.append(contentsOf: bytes[last..<pos])
                    if effectiveName == "script", !formFeedSplitTag, !whatwgExtendedTag, isJSONCitationScriptOpenTag(bytes[pos..<effectiveTagEnd]) {
                        out.append(contentsOf: "<script type=\"application/json\" class=\"paper-tools__citation-record\">".utf8)
                        appendEscapingLessThan(bytes[effectiveTagEnd..<bodyEnd], replacement: ltJSON, to: &out)
                        out.append(contentsOf: "</script>".utf8)
                    } else if preserveClientSidecarsScript, effectiveName == "script", !formFeedSplitTag, !whatwgExtendedTag, isJSONClientSidecarsScriptOpenTag(bytes[pos..<effectiveTagEnd]) {
                        out.append(contentsOf: "<script type=\"application/json\" class=\"paper-tools__client-sidecars\">".utf8)
                        appendEscapingLessThan(bytes[effectiveTagEnd..<bodyEnd], replacement: ltJSON, to: &out)
                        out.append(contentsOf: "</script>".utf8)
                    } else {
                        out.append(contentsOf: inertComment)
                    }
                    last = closeEnd
                    pos = closeEnd
                    continue
                }
                if !t.closing, rcdataElements.contains(effectiveName) {
                    if effectiveName == "xmp" { inHiddenP = false }
                    var rcAttr = ffInfo?.attrInfo.hasHidden == true ? ffInfo!.attrInfo : parseHiddenAndIdentityAttrs(bytes[t.nameEnd..<effectiveTagEnd])
                    if !rcAttr.hasHidden && !formFeedSplitTag {
                        let wScan = scanWHATWGFromBeforeAttr(bytes, start: t.nameEnd, cache: &cleanWhatwgCache)
                        if wScan.hasHidden && wScan.end > t.nameEnd && wScan.end <= n && bytes[wScan.end - 1] == 62 {
                            rcAttr = parseHiddenAndIdentityAttrs(bytes[t.nameEnd..<wScan.end])
                            rcAttr.hasHidden = true
                            effectiveTagEnd = max(effectiveTagEnd, wScan.end)
                            whatwgExtendedTag = true
                        }
                    }
                    if effectiveSelfClosing && !rcAttr.hasHidden && !formFeedSplitTag && !whatwgExtendedTag && effectiveName != "noframes" && !(effectiveName == "title" && wasInBody) {
                        pos = effectiveTagEnd
                        continue
                    }
                    let bodyEnd: Int
                    let closeEnd: Int
                    if effectiveSelfClosing && !whatwgExtendedTag && effectiveName != "xmp" {
                        bodyEnd = effectiveTagEnd; closeEnd = effectiveTagEnd
                    } else {
                        switch scanRawTextElementEnd(bytes, rawName: effectiveName, from: effectiveTagEnd, formFeedAfterCleanPos: formFeedAfterCleanPos) {
                        case .closed(let bEnd, let cEnd):
                            bodyEnd = bEnd; closeEnd = cEnd
                        case .unclosed(let bEnd):
                            bodyEnd = bEnd; closeEnd = n
                        case .unsafe:
                            throw ServiceError.invalid("文章原始文本结束标签包含不安全的非ASCII截断字符，未猜测解析边界。")
                        }
                    }
                    if effectiveName == "noframes" || (effectiveName == "title" && wasInBody) {
                        // <noframes> and in-body <title> force-close hidden wrappers in libtidy; neutralize cleanly.
                        out.append(contentsOf: bytes[last..<pos])
                        out.append(contentsOf: inertComment)
                        last = closeEnd
                        pos = closeEnd
                        continue
                    }
                    if effectiveName == "xmp", rcAttr.hasHidden {
                        var cleanAttrs = " hidden"
                        if let idVal = rcAttr.idValue { cleanAttrs += " id=\"\(escapeNormalizedAttrValue(idVal))\"" }
                        if let clsVal = rcAttr.classValue { cleanAttrs += " class=\"\(escapeNormalizedAttrValue(clsVal))\"" }
                        out.append(contentsOf: bytes[last..<pos])
                        out.append(contentsOf: "<pre\(cleanAttrs)>".utf8)
                        appendEscapingLessThan(bytes[effectiveTagEnd..<bodyEnd], replacement: ltEntity, to: &out)
                        out.append(contentsOf: "</pre>".utf8)
                        last = closeEnd
                        pos = closeEnd
                        continue
                    }
                    out.append(contentsOf: bytes[last..<pos])
                    if formFeedSplitTag || whatwgExtendedTag {
                        out.append(contentsOf: "<\(effectiveName)>".utf8)
                    } else {
                        out.append(contentsOf: bytes[pos..<effectiveTagEnd])
                        if effectiveTagEnd > pos && bytes[effectiveTagEnd - 1] != 62 {
                            if bytes[effectiveTagEnd - 1] == 47 { out.append(32) }
                            out.append(62)
                        }
                    }
                    appendEscapingLessThan(bytes[effectiveTagEnd..<bodyEnd], replacement: ltEntity, to: &out)
                    if closeEnd > bodyEnd {
                        out.append(contentsOf: "</\(effectiveName)>".utf8)
                    }
                    last = closeEnd
                    pos = closeEnd
                    continue
                }

                // Strip stray table-inner tags outside any open <table>, AND ignore `<col>`/`<colgroup>` inside
                // an open cell (`<td>`/`<th>`/`<caption>` in current table) per WHATWG §13.2.6.4.15 so libtidy
                // cannot close the cell/row and foster-parent siblings out of `<td hidden>` / `<table hidden>`.
                if (tableDepth == 0 && tableInnerTags.contains(effectiveName))
                    || ((effectiveName == "col" || effectiveName == "colgroup")
                        && !(tableCellCountsStack.last?.isEmpty ?? true)) {
                    out.append(contentsOf: bytes[last..<pos])
                    out.append(contentsOf: inertComment)
                    last = effectiveTagEnd
                    pos = effectiveTagEnd
                    continue
                }

                if t.closing {
                    let curFrame = scopeBoundaryFrameIds.last ?? 0
                    if inHiddenP && (effectiveName == "body" || effectiveName == "html") {
                        // Per WHATWG §13.2.6.4.7, `</body>` / `</html>` never pops an open `<p hidden>` for subsequent text.
                        out.append(contentsOf: bytes[last..<pos])
                        out.append(contentsOf: inertComment)
                        last = effectiveTagEnd
                        pos = effectiveTagEnd
                        continue
                    }
                    if effectiveName == "dl" {
                        flushAllDtHiddenInCurrentFrame(before: pos)
                    }
                    if effectiveName == "select" {
                        if let entry = rewrittenTagStacks["select"]?.last, entry.frameId == curFrame, !entry.emittedTag.isEmpty {
                            // Rewritten `<select hidden>` closes via rewrittenTagStacks below.
                        } else if selectDepth > 0 {
                            selectDepth = 0
                        }
                    }
                    let tableRowOrSectionTags: Set<String> = ["tr", "tbody", "thead", "tfoot"]
                    var boundaryCloses = 0
                    if effectiveName == "table" {
                        if tableDepth > 0 { tableDepth -= 1 }
                        if openBoundaryCounts["table", default: 0] > 0 {
                            // Unwind all implicit open `<td>`/`<th>`/`<caption>` frames up to and including `<table>`.
                            while scopeBoundaryKinds.count > 1 {
                                let topKind = scopeBoundaryKinds.last!
                                boundaryCloses += popOneBoundaryFrame()
                                if topKind == "table" { break }
                            }
                        }
                    } else if tableRowOrSectionTags.contains(effectiveName) {
                        if let topKind = scopeBoundaryKinds.last, tableCellScopeTags.contains(topKind) {
                            boundaryCloses += popOneBoundaryFrame()
                        }
                    } else if tableCellScopeTags.contains(effectiveName) {
                        // O(1) check whether `<td>`/`<th>`/`<caption>` is open in the current `<table>` frame.
                        if (tableCellCountsStack.last?[effectiveName] ?? 0) > 0 {
                            while scopeBoundaryKinds.count > 1 {
                                let topKind = scopeBoundaryKinds.last!
                                boundaryCloses += popOneBoundaryFrame()
                                if topKind == effectiveName { break }
                            }
                        }
                    } else if nonTableScopeBoundaryTags.contains(effectiveName) {
                        // Per WHATWG §13.2.6.4.7, `</object>`/`</applet>`/`</marquee>` aborts on any open special element
                        // (`<div>`, `<section>`, `<p>`, `<td>`, etc.); never unwind inner hidden wrappers.
                        if openBoundaryCounts[effectiveName, default: 0] > 0,
                           let topKind = scopeBoundaryKinds.last, topKind == effectiveName,
                           divScopeStack.last?.isTableBoundary == true, !inHiddenP {
                            boundaryCloses += popOneBoundaryFrame()
                        } else {
                            out.append(contentsOf: bytes[last..<pos])
                            out.append(contentsOf: inertComment)
                            last = effectiveTagEnd
                            pos = effectiveTagEnd
                            continue
                        }
                    }
                    if boundaryCloses > 0 {
                        out.append(contentsOf: bytes[last..<pos])
                        for _ in 0..<boundaryCloses { out.append(contentsOf: "</div>".utf8) }
                        last = pos
                    }
                    let activeFrame = scopeBoundaryFrameIds.last ?? 0
                    var emittedClose = false
                    if effectiveName == "div" {
                        if (literalDivCountsByTableFrame.last ?? 0) == 0 {
                            // Stray </div> with no matching literal <div> in current scope: drop per HTML5
                            // so it cannot prematurely close a rewritten <div hidden> or foster out of <td hidden>.
                            out.append(contentsOf: bytes[last..<pos])
                            out.append(contentsOf: inertComment)
                            last = effectiveTagEnd
                            emittedClose = true
                        } else {
                            inHiddenP = false
                            var closesToEmit = 0
                            while let top = divScopeStack.last {
                                if top.isTableBoundary { break }
                                divScopeStack.removeLast()
                                if closedScopeIds.contains(top.id) { continue }
                                closedScopeIds.insert(top.id)
                                closesToEmit += 1
                                if top.isLiteralDiv {
                                    literalDivCountsByTableFrame[literalDivCountsByTableFrame.count - 1] -= 1
                                    break
                                } else {
                                    popRewrittenThrough(origTag: top.origTag, scopeId: top.id, frameId: activeFrame)
                                    if top.origTag == "dt", let lastDt = dlDtHiddenFrames.last,
                                       lastDt.frameId == activeFrame, lastDt.count > 0 {
                                        dlDtHiddenFrames[dlDtHiddenFrames.count - 1].count -= 1
                                    }
                                }
                            }
                            if closesToEmit > 1 {
                                out.append(contentsOf: bytes[last..<pos])
                                for _ in 0..<closesToEmit { out.append(contentsOf: "</div>".utf8) }
                                last = effectiveTagEnd
                                emittedClose = true
                            } else if closesToEmit == 0 {
                                out.append(contentsOf: bytes[last..<pos])
                                out.append(contentsOf: inertComment)
                                last = effectiveTagEnd
                                emittedClose = true
                            }
                        }
                    } else if let topEntry = rewrittenTagStacks[effectiveName]?.last, topEntry.frameId == activeFrame {
                        let entry = rewrittenTagStacks[effectiveName]!.removeLast()
                        if entry.emittedTag.isEmpty {
                            // Passthrough sentinel for nested visible same-name tag: leave closing tag raw (or canonical if form-feed split).
                            if pClosingBlockTags.contains(effectiveName) { inHiddenP = false }
                        } else {
                            if entry.emittedTag == "div" || pClosingBlockTags.contains(effectiveName) { inHiddenP = false }
                            if effectiveName == "dt", let lastDt = dlDtHiddenFrames.last, lastDt.frameId == activeFrame, lastDt.count > 0 {
                                dlDtHiddenFrames[dlDtHiddenFrames.count - 1].count -= 1
                            }
                            if entry.scopeId > 0 {
                                let closes = unwindDivScopeDownTo(scopeId: entry.scopeId)
                                out.append(contentsOf: bytes[last..<pos])
                                if closes > 0 {
                                    for _ in 0..<closes { out.append(contentsOf: "</\(entry.emittedTag)>".utf8) }
                                } else {
                                    out.append(contentsOf: inertComment)
                                }
                                last = effectiveTagEnd
                                emittedClose = true
                            } else {
                                out.append(contentsOf: bytes[last..<pos])
                                out.append(contentsOf: "</\(entry.emittedTag)>".utf8)
                                last = effectiveTagEnd
                                emittedClose = true
                            }
                        }
                    } else if preserveTags.contains(effectiveName) || containerTags.contains(effectiveName) || inlineContainerTags.contains(effectiveName)
                        || (selectDepth == 0 && (effectiveName == "option" || effectiveName == "optgroup")) {
                        // Unmatched HTML5 closing tag or stray `</option>`/`</optgroup>` outside `<select>` is a no-op;
                        // never emit `</div>`/`</span>` or raw `</option>` that would close enclosing containers.
                        out.append(contentsOf: bytes[last..<pos])
                        out.append(contentsOf: inertComment)
                        last = effectiveTagEnd
                        emittedClose = true
                    } else if pClosingBlockTags.contains(effectiveName) || tableInnerTags.contains(effectiveName) {
                        inHiddenP = false
                    }
                    if !emittedClose && formFeedSplitTag {
                        out.append(contentsOf: bytes[last..<pos])
                        out.append(contentsOf: "</\(effectiveName)>".utf8)
                        last = effectiveTagEnd
                    }
                } else {
                    if effectiveName == "dl" {
                        dlDtHiddenFrames.append((frameId: scopeBoundaryFrameIds.last ?? 0, count: 0))
                    } else if effectiveName == "dt" || effectiveName == "dd" {
                        flushOneDtHiddenInCurrentFrame(before: pos)
                    }
                    if effectiveName == "table" {
                        tableDepth += 1
                        pushBoundaryFrame("table")
                    } else if tableCellScopeTags.contains(effectiveName) {
                        // HTML5 implicitly closes an open sibling cell (`<td>`/`<th>`/`<caption>`) before opening a new one;
                        // emit `</div>` for any unclosed `<div>` inside the previous cell so libtidy doesn't synthesize a nested `<table>`.
                        if let topKind = scopeBoundaryKinds.last, tableCellScopeTags.contains(topKind) {
                            let cellCloses = popOneBoundaryFrame()
                            if cellCloses > 0 {
                                out.append(contentsOf: bytes[last..<pos])
                                for _ in 0..<cellCloses { out.append(contentsOf: "</div>".utf8) }
                                last = pos
                            }
                        }
                        pushBoundaryFrame(effectiveName)
                    } else if effectiveName == "tr" || effectiveName == "tbody" || effectiveName == "thead" || effectiveName == "tfoot" {
                        if let topKind = scopeBoundaryKinds.last, tableCellScopeTags.contains(topKind) {
                            let cellCloses = popOneBoundaryFrame()
                            if cellCloses > 0 {
                                out.append(contentsOf: bytes[last..<pos])
                                for _ in 0..<cellCloses { out.append(contentsOf: "</div>".utf8) }
                                last = pos
                            }
                        }
                    }
                    if pClosingBlockTags.contains(effectiveName) && effectiveName != "p" {
                        inHiddenP = false
                    }

                    // Check @hidden across both libtidy and O(N) memoized WHATWG HTML5 boundaries
                    // (including `<` in attrs, quote-as-equals `a " b="x>y"`, `-"'`, and `0x0C` split tags).
                    var attrInfo = parseHiddenAndIdentityAttrs(bytes[t.nameEnd..<effectiveTagEnd])
                    var effectiveTagName = effectiveName
                    if !attrInfo.hasHidden, let ff = ffInfo, ff.attrInfo.hasHidden {
                        attrInfo = ff.attrInfo
                        effectiveTagName = ff.name
                    }
                    if !attrInfo.hasHidden && !formFeedSplitTag {
                        let wScan = scanWHATWGFromBeforeAttr(bytes, start: t.nameEnd, cache: &cleanWhatwgCache)
                        if wScan.hasHidden && wScan.end > t.nameEnd && wScan.end <= n && bytes[wScan.end - 1] == 62 {
                            let wAttr = parseHiddenAndIdentityAttrs(bytes[t.nameEnd..<wScan.end])
                            attrInfo = (true, wAttr.idValue ?? attrInfo.idValue, wAttr.classValue ?? attrInfo.classValue)
                            effectiveTagEnd = max(effectiveTagEnd, wScan.end)
                            effectiveSelfClosing = wScan.selfClosing
                        }
                    }

                    if effectiveTagName == "html" {
                        if firstHtmlInsertOffset == nil && !htmlAlreadyHidden {
                            if attrInfo.hasHidden {
                                if hadSeenAnyElement || wasInBody {
                                    sawLateHiddenHtml = true
                                    out.append(contentsOf: bytes[last..<pos])
                                    out.append(contentsOf: inertComment)
                                    last = effectiveTagEnd
                                    pos = effectiveTagEnd
                                    continue
                                } else {
                                    htmlAlreadyHidden = true
                                }
                            } else if !wasInBody && !hadSeenAnyElement {
                                out.append(contentsOf: bytes[last..<pos])
                                out.append(contentsOf: "<html".utf8)
                                firstHtmlInsertOffset = out.count
                                if formFeedSplitTag, let ff = ffInfo {
                                    appendRawWSOpenTagRest(from: ff.rawNameEnd, to: ff.rawEnd, stripSelfClosing: ff.selfClosing)
                                } else if t.selfClosing {
                                    appendOpenTagRest(from: t.nameEnd, to: effectiveTagEnd, stripSelfClosing: true)
                                } else if !t.validDelim {
                                    out.append(62)
                                } else {
                                    appendOpenTagRest(from: t.nameEnd, to: effectiveTagEnd)
                                }
                                last = effectiveTagEnd
                                pos = effectiveTagEnd
                                continue
                            } else {
                                // Duplicate/late visible `<html>` after content: ignore per HTML5 so libtidy doesn't close `<p hidden>`.
                                out.append(contentsOf: bytes[last..<pos])
                                out.append(contentsOf: inertComment)
                                last = effectiveTagEnd
                                pos = effectiveTagEnd
                                continue
                            }
                        } else if attrInfo.hasHidden {
                            sawLateHiddenHtml = true
                            out.append(contentsOf: bytes[last..<pos])
                            out.append(contentsOf: inertComment)
                            last = effectiveTagEnd
                            pos = effectiveTagEnd
                            continue
                        } else {
                            out.append(contentsOf: bytes[last..<pos])
                            out.append(contentsOf: inertComment)
                            last = effectiveTagEnd
                            pos = effectiveTagEnd
                            continue
                        }
                    } else if effectiveTagName == "body" {
                        inBody = true
                        if firstBodyInsertOffset == nil && !bodyAlreadyHidden {
                            if attrInfo.hasHidden {
                                if wasInBody {
                                    // Implicit `<body>` already exists before this late `<body hidden>`: propagate onto root/wrapper.
                                    sawLateHiddenBody = true
                                    out.append(contentsOf: bytes[last..<pos])
                                    out.append(contentsOf: inertComment)
                                    last = effectiveTagEnd
                                    pos = effectiveTagEnd
                                    continue
                                } else {
                                    bodyAlreadyHidden = true
                                }
                            } else if !wasInBody {
                                out.append(contentsOf: bytes[last..<pos])
                                out.append(contentsOf: "<body".utf8)
                                firstBodyInsertOffset = out.count
                                if formFeedSplitTag, let ff = ffInfo {
                                    appendRawWSOpenTagRest(from: ff.rawNameEnd, to: ff.rawEnd, stripSelfClosing: ff.selfClosing)
                                } else if t.selfClosing {
                                    appendOpenTagRest(from: t.nameEnd, to: effectiveTagEnd, stripSelfClosing: true)
                                } else if !t.validDelim {
                                    out.append(62)
                                } else {
                                    appendOpenTagRest(from: t.nameEnd, to: effectiveTagEnd)
                                }
                                last = effectiveTagEnd
                                pos = effectiveTagEnd
                                continue
                            } else {
                                out.append(contentsOf: bytes[last..<pos])
                                out.append(contentsOf: inertComment)
                                last = effectiveTagEnd
                                pos = effectiveTagEnd
                                continue
                            }
                        } else if attrInfo.hasHidden {
                            sawLateHiddenBody = true
                            out.append(contentsOf: bytes[last..<pos])
                            out.append(contentsOf: inertComment)
                            last = effectiveTagEnd
                            pos = effectiveTagEnd
                            continue
                        } else {
                            out.append(contentsOf: bytes[last..<pos])
                            out.append(contentsOf: inertComment)
                            last = effectiveTagEnd
                            pos = effectiveTagEnd
                            continue
                        }
                    }

                    if !attrInfo.hasHidden && selectDepth == 0 && (effectiveTagName == "option" || effectiveTagName == "optgroup") {
                        // Outside `<select>`, `<option>`/`<optgroup>` (including inside `<datalist>`) force-closes all enclosing
                        // `<div>`s (truncating `#article-body` or escaping `<div hidden>`) and fosters out of `<td hidden>` in libtidy.
                        out.append(contentsOf: bytes[last..<pos])
                        out.append(contentsOf: inertComment)
                        last = effectiveTagEnd
                        pos = effectiveTagEnd
                        continue
                    }

                    if attrInfo.hasHidden {
                        var cleanAttrs = " hidden"
                        if let idVal = attrInfo.idValue {
                            cleanAttrs += " id=\"\(escapeNormalizedAttrValue(idVal))\""
                        }
                        if let clsVal = attrInfo.classValue {
                            cleanAttrs += " class=\"\(escapeNormalizedAttrValue(clsVal))\""
                        }
                        out.append(contentsOf: bytes[last..<pos])
                        if htmlVoidTags.contains(effectiveTagName) || safeHiddenNativeTags.contains(effectiveTagName) {
                            if effectiveTagName == "p" { inHiddenP = true }
                            if effectiveTagName == "div" {
                                let sid = nextScopeId
                                nextScopeId += 1
                                divScopeStack.append(DivScopeItem(id: sid, origTag: "div", isLiteralDiv: true, isTableBoundary: false))
                                literalDivCountsByTableFrame[literalDivCountsByTableFrame.count - 1] += 1
                            }
                            out.append(contentsOf: "<\(effectiveTagName)\(cleanAttrs)>".utf8)
                        } else if inHiddenP && !pClosingBlockTags.contains(effectiveTagName) {
                            // Inside an open `<p hidden>`, emit `<span hidden ...>` for phrasing elements
                            // so `libtidy` does NOT implicitly close `<p hidden>` and leak following siblings.
                            pushRewritten(effectiveTagName, emittedTag: "span")
                            out.append(contentsOf: "<span\(cleanAttrs)>".utf8)
                        } else {
                            // Rewrite all HTML4/HTML5 content-model-differential, phrasing, unknown, custom,
                            // or stray non-<math> MathML elements carrying @hidden to a clean `<div hidden ...>`
                            // (ignoring non-void `/>` per WHATWG HTML5 so children stay inside the hidden wrapper).
                            pushRewritten(effectiveTagName, emittedTag: "div")
                            if effectiveTagName == "dt", let lastDt = dlDtHiddenFrames.last,
                               lastDt.frameId == (scopeBoundaryFrameIds.last ?? 0) {
                                dlDtHiddenFrames[dlDtHiddenFrames.count - 1].count += 1
                            }
                            out.append(contentsOf: "<div\(cleanAttrs)>".utf8)
                        }
                        last = effectiveTagEnd
                        if nonTableScopeBoundaryTags.contains(effectiveTagName) {
                            pushBoundaryFrame(effectiveTagName)
                        }
                    } else {
                        let curFrame = scopeBoundaryFrameIds.last ?? 0
                        let isNonVoidSelfClose = effectiveSelfClosing && !htmlVoidTags.contains(effectiveTagName) && effectiveTagName != "svg" && effectiveTagName != "math"
                        func emitVisibleTagAs(_ emittedName: String, extraPrefix: String = "", stripSelfClose: Bool) {
                            out.append(contentsOf: bytes[last..<pos])
                            out.append(contentsOf: "<\(emittedName)\(extraPrefix)".utf8)
                            if formFeedSplitTag, let ff = ffInfo {
                                appendRawWSOpenTagRest(from: ff.rawNameEnd, to: ff.rawEnd, stripSelfClosing: stripSelfClose)
                            } else {
                                appendOpenTagRest(from: t.nameEnd, to: effectiveTagEnd, stripSelfClosing: stripSelfClose)
                            }
                            last = effectiveTagEnd
                        }
                        if effectiveTagName == "p" {
                            inHiddenP = false
                            if formFeedSplitTag || isNonVoidSelfClose {
                                emitVisibleTagAs("p", stripSelfClose: isNonVoidSelfClose)
                            }
                        } else if effectiveTagName == "div" {
                            // Track literal `<div>` even when `t.validDelim == false` or `<div/>` (non-void HTML5 ignores `/`).
                            let sid = nextScopeId
                            nextScopeId += 1
                            divScopeStack.append(DivScopeItem(id: sid, origTag: "div", isLiteralDiv: true, isTableBoundary: false))
                            literalDivCountsByTableFrame[literalDivCountsByTableFrame.count - 1] += 1
                            if formFeedSplitTag || isNonVoidSelfClose {
                                emitVisibleTagAs("div", stripSelfClose: isNonVoidSelfClose)
                            }
                        } else if effectiveTagName == "select" {
                            if selectDepth > 0 {
                                // Per WHATWG §13.2.6.4.16, a nested `<select>` closes the open `<select>`.
                                selectDepth = 0
                                out.append(contentsOf: bytes[last..<pos])
                                out.append(contentsOf: "</select>".utf8)
                                last = effectiveTagEnd
                            } else {
                                selectDepth = 1
                                if let topSel = rewrittenTagStacks["select"]?.last, topSel.frameId == curFrame {
                                    rewrittenTagStacks["select"]!.append(RewrittenEntry(emittedTag: "", scopeId: -1, frameId: curFrame, dlDepth: dlDtHiddenFrames.count))
                                }
                                if formFeedSplitTag || isNonVoidSelfClose {
                                    emitVisibleTagAs("select", stripSelfClose: isNonVoidSelfClose)
                                }
                            }
                        } else if nonTableScopeBoundaryTags.contains(effectiveTagName) {
                            pushBoundaryFrame(effectiveTagName)
                            if let topB = rewrittenTagStacks[effectiveTagName]?.last, topB.frameId == curFrame {
                                rewrittenTagStacks[effectiveTagName]!.append(RewrittenEntry(emittedTag: "", scopeId: -1, frameId: curFrame, dlDepth: dlDtHiddenFrames.count))
                            }
                            if formFeedSplitTag || isNonVoidSelfClose {
                                emitVisibleTagAs(effectiveTagName, stripSelfClose: isNonVoidSelfClose)
                            }
                        } else if (t.validDelim || formFeedSplitTag) && preserveTags.contains(effectiveTagName) {
                            pushRewritten(effectiveTagName, emittedTag: "div")
                            emitVisibleTagAs("div", extraPrefix: " \(tagMarker)=\"\(effectiveTagName)\"", stripSelfClose: true)
                        } else if (t.validDelim || formFeedSplitTag) && containerTags.contains(effectiveTagName) {
                            pushRewritten(effectiveTagName, emittedTag: "div")
                            emitVisibleTagAs("div", stripSelfClose: true)
                        } else if (t.validDelim || formFeedSplitTag) && inlineContainerTags.contains(effectiveTagName) {
                            if effectiveTagName == "svg" && effectiveSelfClosing {
                                out.append(contentsOf: bytes[last..<pos])
                                out.append(contentsOf: "<span></span>".utf8)
                                last = effectiveTagEnd
                            } else {
                                pushRewritten(effectiveTagName, emittedTag: "span")
                                emitVisibleTagAs("span", stripSelfClose: true)
                            }
                        } else {
                            if !htmlVoidTags.contains(effectiveTagName),
                               let topSame = rewrittenTagStacks[effectiveTagName]?.last, topSame.frameId == curFrame {
                                // Push passthrough sentinel so nested visible same-name closing tag does not pop outer `@hidden` wrapper.
                                rewrittenTagStacks[effectiveTagName]!.append(RewrittenEntry(emittedTag: "", scopeId: -1, frameId: curFrame, dlDepth: dlDtHiddenFrames.count))
                                if formFeedSplitTag || isNonVoidSelfClose {
                                    emitVisibleTagAs(effectiveTagName, stripSelfClose: isNonVoidSelfClose)
                                }
                            } else if formFeedSplitTag {
                                emitVisibleTagAs(effectiveTagName, stripSelfClose: isNonVoidSelfClose)
                            }
                        }
                    }
                }
            }
            pos = effectiveTagEnd
        }
        if templateDepth > 0 {
            out.append(contentsOf: bytes[last..<templateOuterStart])
            out.append(contentsOf: inertComment)
            last = n
        }
        out.append(contentsOf: bytes[last..<n])
        // Propagate WHATWG HTML5 §13.2.6.4.7 duplicate `<body hidden>` / `<html hidden>` onto the live root/body.
        let needInjectHiddenOnBody = sawLateHiddenBody && !bodyAlreadyHidden
        let needInjectHiddenOnHtml = sawLateHiddenHtml && !htmlAlreadyHidden
        if needInjectHiddenOnBody || needInjectHiddenOnHtml {
            func insertHiddenAttr(at off: Int) {
                let needsTrailingSpace = off < out.count && out[off] != 62 && out[off] != 32 && out[off] != 9 && out[off] != 10 && out[off] != 13
                let attrBytes = Array((needsTrailingSpace ? " hidden " : " hidden").utf8)
                out.insert(contentsOf: attrBytes, at: off)
            }
            if needInjectHiddenOnBody, let off = firstBodyInsertOffset {
                insertHiddenAttr(at: off)
            } else if needInjectHiddenOnHtml, let off = firstHtmlInsertOffset {
                insertHiddenAttr(at: off)
            } else if let off = firstBodyInsertOffset ?? firstHtmlInsertOffset {
                insertHiddenAttr(at: off)
            } else {
                let insertPos = leadingDoctypeEndInOut ?? 0
                var wrapped = Data()
                wrapped.reserveCapacity(out.count + 20)
                if insertPos > 0 {
                    wrapped.append(out.prefix(insertPos))
                }
                wrapped.append(contentsOf: "<div hidden>".utf8)
                wrapped.append(out.dropFirst(insertPos))
                wrapped.append(contentsOf: "</div>".utf8)
                out = wrapped
            }
        }
        return String(decoding: out, as: UTF8.self)
    }

    private static let desktopProtectedHTML5Tags: Set<String> = ["figure", "figcaption", "details", "summary"]

    static func parseSanitizedDesktopFragment(
        _ rawFragment: String,
        pageURL: URL
    ) throws -> (html: String, plainText: String, imageURLs: [String]) {
        let marker = "data-desktop-tag-" + UUID().uuidString.lowercased()
        let adapted = try rewriteHTML5TagsForTidyStrict(
            rawFragment,
            tagMarker: marker,
            preserveTags: desktopProtectedHTML5Tags,
            containerTags: html5BlockContainerTags,
            inlineContainerTags: html5InlineContainerTags
        )

        let doc = try htmlDocumentPreservingMath("<html><body>\(adapted)</body></html>")
        let bodyCandidates = try doc.nodes(forXPath: "//div[@id='article-body']")
        guard bodyCandidates.count <= 1 else {
            throw ServiceError.invalid("导读正文片段包含重复的 #article-body 容器。")
        }
        let rootElement: XMLElement
        if let articleDiv = bodyCandidates.first as? XMLElement {
            rootElement = articleDiv
        } else if let htmlBody = try doc.nodes(forXPath: "//body").first as? XMLElement {
            rootElement = htmlBody
        } else {
            throw ServiceError.invalid("导读正文片段缺少可解析的正文容器。")
        }

        if !(try rootElement.nodes(forXPath: "ancestor-or-self::*[@hidden]")).isEmpty {
            rootElement.setChildren(nil)
        } else {
            for hidden in try rootElement.nodes(forXPath: ".//*[@hidden]") { hidden.detach() }
        }
        let groups = try rootElement.nodes(forXPath: ".//div[@" + marker + "]").compactMap { node -> (XMLElement, String, Bool)? in
            guard let el = node as? XMLElement,
                  let tag = el.attribute(forName: marker)?.stringValue?.lowercased(),
                  desktopProtectedHTML5Tags.contains(tag) else { return nil }
            let hadOpen = tag == "details" && el.attribute(forName: "open") != nil
            return (el, tag, hadOpen)
        }
        let inlineDataImages: [(XMLElement, String)] = try rootElement.nodes(forXPath: ".//img[@src]").compactMap { node in
            guard let el = node as? XMLElement,
                  let src = el.attribute(forName: "src")?.stringValue,
                  src.lowercased().hasPrefix("data:image/"),
                  isSafeDataImageURL(src) else { return nil }
            return (el, src)
        }
        try sanitize(rootElement, pageURL: pageURL)
        for (el, tag, hadOpen) in groups {
            el.name = tag
            if hadOpen && el.attribute(forName: "open") == nil {
                el.addAttribute(XMLNode.attribute(withName: "open", stringValue: "") as! XMLNode)
            }
        }
        for (el, safeDataSrc) in inlineDataImages {
            if el.attribute(forName: "src") == nil {
                el.addAttribute(XMLNode.attribute(withName: "src", stringValue: safeDataSrc) as! XMLNode)
            }
        }
        let imageURLs = try rootElement.nodes(forXPath: ".//img[@src]").compactMap { ($0 as? XMLElement)?.attribute(forName: "src")?.stringValue }
        let plain = try articlePlainText(rootElement)
        let html = (rootElement.children ?? []).map { $0.xmlString(options: [.nodePreserveWhitespace]) }.joined()
        return (html, plain, imageURLs)
    }

    static func localizeImagesPreservingDataURI(_ fragment: String, replacements: [String: String]) throws -> String {
        let marker = "data-desktop-fig-" + UUID().uuidString.lowercased()
        let grouped = try rewriteHTML5TagsForTidyStrict(
            fragment,
            tagMarker: marker,
            preserveTags: desktopProtectedHTML5Tags,
            containerTags: []
        )

        let doc = try htmlDocumentPreservingMath("<html><body>\(grouped)</body></html>")
        for node in try doc.nodes(forXPath: "//div[@" + marker + "]") {
            guard let el = node as? XMLElement,
                  let tag = el.attribute(forName: marker)?.stringValue?.lowercased(),
                  desktopProtectedHTML5Tags.contains(tag) else { continue }
            el.removeAttribute(forName: marker)
            el.name = tag
        }
        for node in try doc.nodes(forXPath: "//img") {
            guard let image = node as? XMLElement,
                  let source = image.attribute(forName: "src")?.stringValue else { continue }
            if source.lowercased().hasPrefix("data:image/") && isSafeDataImageURL(source) {
                continue
            }
            if let local = replacements[source] {
                image.attribute(forName: "src")?.stringValue = local
            } else {
                image.removeAttribute(forName: "src")
                image.addAttribute(XMLNode.attribute(withName: "data-source-url", stringValue: source) as! XMLNode)
            }
        }
        return try doc.nodes(forXPath: "//body").first?.children?.map { $0.xmlString(options: [.nodePreserveWhitespace]) }.joined() ?? ""
    }
}
