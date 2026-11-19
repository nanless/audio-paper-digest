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
        var primarySortKeyByPaperID: [String: (String, String)] = [:]

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

            let sortKey = (blogPublishedAt, articleUpdatedAt ?? "")
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
        var primarySortKeyByPaperID: [String: (String, String)] = [:]
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
            let sortKey = (blogPublishedAt, articleUpdatedAt ?? "")

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
                        case .invalid, .cancelled:
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
        ch.value == 0x20 || ch.value == 0x09 || ch.value == 0x0A || ch.value == 0x0D || ch.value == 0x0C
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
                // SELF_CLOSING_START_TAG
                i += 1
                guard i < n else { return nil }
                if scalars[i] == ">" {
                    selfClosing = true
                    return ScannedHTMLTag(tagEnd: i, isClosing: isClosing, rawTagName: rawTagName, tagName: tagName, attrs: attrs, selfClosing: selfClosing)
                }
                continue
            }

            // ATTR_NAME ('=' at start of attribute name is part of attribute name in HTML5)
            let attrStart = i
            i += 1
            while i < n && !isASCIIWhitespace(scalars[i]) && scalars[i] != "/" && scalars[i] != ">" && scalars[i] != "=" {
                i += 1
            }
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
                })
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
        guard !html.contains("\0"),
              !containsInvalidNumericEntity(html),
              !html.contains("<!--"),
              !html.contains("<?"),
              html.range(of: #"<!DOCTYPE|<!ENTITY"#, options: [.regularExpression, .caseInsensitive]) == nil else {
            throw ServiceError.invalid("导读正文片段包含禁止的 NUL、非法数值字符实体、HTML 注释、处理指令或 DTD/实体声明。")
        }

        let scalars = Array(html.unicodeScalars)
        let n = scalars.count
        var cursor = 0

        while cursor < n {
            guard let ltOffset = scalars[cursor..<n].firstIndex(of: "<") else { break }
            guard let parsed = scanHTMLTag(scalars, at: ltOffset) else {
                throw ServiceError.invalid("导读正文片段包含未转义的孤立 '<'、未闭合标签或声明节点。")
            }
            guard allowedFragmentTags.contains(parsed.tagName) else {
                throw ServiceError.invalid("导读正文片段包含非白名单或禁止标签 <\(parsed.tagName)>。")
            }
            if parsed.isClosing {
                guard parsed.attrs.isEmpty, !parsed.selfClosing, !htmlVoidTags.contains(parsed.tagName) else {
                    throw ServiceError.invalid("导读正文片段闭合标签 </\(parsed.tagName)> 携带非法属性或自闭合标记。")
                }
            } else {
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
    }

    private static func isAllowedHTMLAttribute(tagName: String, attr: ScannedHTMLAttribute) -> Bool {
        let name = attr.name
        guard name.range(of: #"\A[a-z][a-z0-9:-]*\z"#, options: .regularExpression) != nil else { return false }
        if name.hasPrefix("on") || name == "srcdoc" || name == "ping" { return false }

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
        if let hexRegex = try? NSRegularExpression(pattern: #"&#x0*([0-9a-fA-F]+);?"#, options: .caseInsensitive) {
            for m in hexRegex.matches(in: raw, range: NSRange(raw.startIndex..., in: raw)) {
                guard let r = Range(m.range(at: 1), in: raw) else { return true }
                let hex = String(raw[r])
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
            for m in decRegex.matches(in: raw, range: NSRange(raw.startIndex..., in: raw)) {
                guard let r = Range(m.range(at: 1), in: raw) else { return true }
                let dec = String(raw[r])
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

    private static func decodeHTMLEntities(_ raw: String) -> String {
        var result = raw
        if let hexRegex = try? NSRegularExpression(pattern: #"&#x0*([0-9a-fA-F]+);?"#, options: .caseInsensitive) {
            let matches = hexRegex.matches(in: result, range: NSRange(result.startIndex..., in: result)).reversed()
            for m in matches {
                guard let r = Range(m.range(at: 1), in: result),
                      let full = Range(m.range, in: result) else { continue }
                let hex = String(result[r])
                if hex.count > 6 {
                    result.replaceSubrange(full, with: "\u{FFFD}")
                } else if let code = UInt32(hex, radix: 16) {
                    result.replaceSubrange(full, with: safeCodePointString(code))
                } else {
                    result.replaceSubrange(full, with: "\u{FFFD}")
                }
            }
        }
        if let decRegex = try? NSRegularExpression(pattern: #"&#0*([0-9]+);?"#) {
            let matches = decRegex.matches(in: result, range: NSRange(result.startIndex..., in: result)).reversed()
            for m in matches {
                guard let r = Range(m.range(at: 1), in: result),
                      let full = Range(m.range, in: result) else { continue }
                let dec = String(result[r])
                if dec.count > 7 {
                    result.replaceSubrange(full, with: "\u{FFFD}")
                } else if let code = UInt32(dec, radix: 10) {
                    result.replaceSubrange(full, with: safeCodePointString(code))
                } else {
                    result.replaceSubrange(full, with: "\u{FFFD}")
                }
            }
        }
        if let namedRegex = try? NSRegularExpression(pattern: #"&(colon|sol|bsol|tab|newline|nbsp|amp|lt|gt|quot|apos);?"#, options: .caseInsensitive) {
            let matches = namedRegex.matches(in: result, range: NSRange(result.startIndex..., in: result)).reversed()
            for m in matches {
                guard let r = Range(m.range(at: 1), in: result),
                      let full = Range(m.range, in: result) else { continue }
                switch result[r].lowercased() {
                case "colon": result.replaceSubrange(full, with: ":")
                case "sol": result.replaceSubrange(full, with: "/")
                case "bsol": result.replaceSubrange(full, with: "\\")
                case "tab": result.replaceSubrange(full, with: "\t")
                case "newline": result.replaceSubrange(full, with: "\n")
                case "nbsp": result.replaceSubrange(full, with: "\u{00A0}")
                case "amp": result.replaceSubrange(full, with: "&")
                case "lt": result.replaceSubrange(full, with: "<")
                case "gt": result.replaceSubrange(full, with: ">")
                case "quot": result.replaceSubrange(full, with: "\"")
                case "apos": result.replaceSubrange(full, with: "'")
                default: break
                }
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

    private static func isSafeInlineSVG(_ svg: String) -> Bool {
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

    private static func parseSanitizedDesktopFragment(
        _ rawFragment: String,
        pageURL: URL
    ) throws -> (html: String, plainText: String, imageURLs: [String]) {
        let marker = "data-desktop-tag-" + UUID().uuidString.lowercased()
        let figures = try NSRegularExpression(pattern: "(?i)<(figure|figcaption)(?=[\\s/>])")
        let figureBody = figures.stringByReplacingMatches(in: rawFragment, range: NSRange(rawFragment.startIndex..<rawFragment.endIndex, in: rawFragment), withTemplate: "<div " + marker + "=\"$1\"")
        let closes = try NSRegularExpression(pattern: "(?i)</(?:figure|figcaption)\\s*>")
        let grouped = closes.stringByReplacingMatches(in: figureBody, range: NSRange(figureBody.startIndex..<figureBody.endIndex, in: figureBody), withTemplate: "</div>")
        let containers = try NSRegularExpression(pattern: "(?i)<(/?)(section|article|main)(?=[\\s/>])")
        let adapted = containers.stringByReplacingMatches(in: grouped, range: NSRange(grouped.startIndex..<grouped.endIndex, in: grouped), withTemplate: "<$1div")

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

        for hidden in try rootElement.nodes(forXPath: ".//*[@hidden]") { hidden.detach() }
        let groups = try rootElement.nodes(forXPath: ".//div[@" + marker + "]").compactMap { node -> (XMLElement, String)? in
            guard let el = node as? XMLElement,
                  let tag = el.attribute(forName: marker)?.stringValue?.lowercased(),
                  ["figure", "figcaption"].contains(tag) else { return nil }
            return (el, tag)
        }
        let inlineDataImages: [(XMLElement, String)] = try rootElement.nodes(forXPath: ".//img[@src]").compactMap { node in
            guard let el = node as? XMLElement,
                  let src = el.attribute(forName: "src")?.stringValue,
                  src.lowercased().hasPrefix("data:image/"),
                  isSafeDataImageURL(src) else { return nil }
            return (el, src)
        }
        try sanitize(rootElement, pageURL: pageURL)
        for (el, tag) in groups { el.name = tag }
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
        let figures = try NSRegularExpression(pattern: "(?i)<(figure|figcaption)(?=[\\s/>])")
        let figureBody = figures.stringByReplacingMatches(in: fragment, range: NSRange(fragment.startIndex..<fragment.endIndex, in: fragment), withTemplate: "<div " + marker + "=\"$1\"")
        let closes = try NSRegularExpression(pattern: "(?i)</(?:figure|figcaption)\\s*>")
        let grouped = closes.stringByReplacingMatches(in: figureBody, range: NSRange(figureBody.startIndex..<figureBody.endIndex, in: figureBody), withTemplate: "</div>")

        let doc = try htmlDocumentPreservingMath("<html><body>\(grouped)</body></html>")
        for node in try doc.nodes(forXPath: "//div[@" + marker + "]") {
            guard let el = node as? XMLElement,
                  let tag = el.attribute(forName: marker)?.stringValue?.lowercased(),
                  ["figure", "figcaption"].contains(tag) else { continue }
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
