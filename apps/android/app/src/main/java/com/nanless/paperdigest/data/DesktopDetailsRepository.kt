package com.nanless.paperdigest.data

import com.nanless.paperdigest.protocols.ClientProtocols
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Comment
import org.jsoup.nodes.DataNode
import org.jsoup.nodes.DocumentType
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.XmlDeclaration
import org.jsoup.parser.Parser
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.time.OffsetDateTime
import java.util.IdentityHashMap
import java.util.UUID

/**
 * Native consumer for `client/details/` (`paper-desktop-manifest`, `paper-desktop-snapshot`,
 * `paper-desktop-detail`, and content-addressed `articles/<sha256>.html`).
 *
 * Enforces raw-byte length and SHA-256 checks BEFORE parsing JSON/HTML, rejects duplicate keys,
 * enforces disjointness between active catalog appearances and tombstones, uses epoch-scoped
 * immutable state files so `PublishedLibrary/current.json` is the single atomic commit point,
 * preserves personal research records across removals/retractions/replacements/restorations,
 * and reuses immutable content-addressed local files across snapshot updates.
 */
class DesktopDetailsRepository(
    private val libraryDirectory: File,
    private val personalRoot: File,
    private val readSite: suspend (String, Int) -> ByteArray,
    private val readExternal: suspend (String, Int) -> ByteArray,
    private val hasLocalMathRenderer: () -> Boolean = { true },
) {
    private val root = checkedChild(libraryDirectory, "desktop-details").also { it.mkdirs() }

    data class FileDescriptor(
        val url: String,
        val bytes: Int,
        val sha256: String,
    ) {
        fun json(): JSONObject = JSONObject()
            .put("url", url)
            .put("bytes", bytes)
            .put("sha256", sha256)
    }

    data class ShardDescriptor(
        val url: String,
        val bytes: Int,
        val sha256: String,
        val recordCount: Int,
    ) {
        fun json(): JSONObject = JSONObject()
            .put("url", url)
            .put("bytes", bytes)
            .put("sha256", sha256)
            .put("recordCount", recordCount)
    }

    data class ParsedManifest(
        val snapshotId: String,
        val snapshot: FileDescriptor,
        val generatedAt: String,
        val sourceCommit: String,
        val basePath: String,
        val snapshotContract: String,
        val snapshotSchemaFingerprint: String,
    )

    data class AppearanceBinding(
        val appearanceId: String,
        val pageUrl: String,
        val blogURL: String,
        val paperKey: String,
        val paperId: String?,
        val identityStatus: String,
        val sourceKind: String?,
        val sourceVersionId: String?,
        val pageType: String,
        val publicationStatus: String,
        val blogPublishedAt: String?,
        val articleUpdatedAt: String?,
        val articleRevisionId: String,
        val detail: FileDescriptor,
    ) {
        fun json(): JSONObject = JSONObject()
            .put("appearanceId", appearanceId)
            .put("pageUrl", pageUrl)
            .put("blogURL", blogURL)
            .put("paperKey", paperKey)
            .put("paperId", paperId ?: JSONObject.NULL)
            .put("identityStatus", identityStatus)
            .put("sourceKind", sourceKind ?: JSONObject.NULL)
            .put("sourceVersionId", sourceVersionId ?: JSONObject.NULL)
            .put("pageType", pageType)
            .put("publicationStatus", publicationStatus)
            .put("blogPublishedAt", blogPublishedAt ?: JSONObject.NULL)
            .put("articleUpdatedAt", articleUpdatedAt ?: JSONObject.NULL)
            .put("articleRevisionId", articleRevisionId)
            .put("detail", detail.json())

        companion object {
            fun fromJson(o: JSONObject): AppearanceBinding {
                val d = o.getJSONObject("detail")
                return AppearanceBinding(
                    appearanceId = o.getString("appearanceId"),
                    pageUrl = o.getString("pageUrl"),
                    blogURL = o.getString("blogURL"),
                    paperKey = o.getString("paperKey"),
                    paperId = o.nullableString("paperId"),
                    identityStatus = o.getString("identityStatus"),
                    sourceKind = o.nullableString("sourceKind"),
                    sourceVersionId = o.nullableString("sourceVersionId"),
                    pageType = o.getString("pageType"),
                    publicationStatus = o.getString("publicationStatus"),
                    blogPublishedAt = o.nullableString("blogPublishedAt"),
                    articleUpdatedAt = o.nullableString("articleUpdatedAt"),
                    articleRevisionId = o.getString("articleRevisionId"),
                    detail = FileDescriptor(d.getString("url"), strictInt(d, "bytes", false), d.getString("sha256")),
                )
            }
        }
    }

    data class ActiveDesktopState(
        val snapshotId: String,
        val sourceCommit: String,
        val validationEpoch: String,
        val byPaperAndBlog: Map<String, AppearanceBinding>,
        val primaryByPaper: Map<String, AppearanceBinding>,
    ) {
        fun resolve(paper: Paper): AppearanceBinding? =
            byPaperAndBlog[paper.id + "\u0000" + paper.blogURL] ?: primaryByPaper[paper.id]

        fun json(): JSONObject = JSONObject()
            .put("format", ACTIVE_STATE_FORMAT)
            .put("version", 1)
            .put("snapshotId", snapshotId)
            .put("sourceCommit", sourceCommit)
            .put("validationEpoch", validationEpoch)
            .put("appearances", JSONArray(byPaperAndBlog.values.map { it.json() }))
            .put("primaryAppearanceIds", JSONObject().also { obj ->
                primaryByPaper.forEach { (paperKey, binding) -> obj.put(paperKey, binding.appearanceId) }
            })
    }

    data class SyncedSnapshot(
        val published: List<Paper>,
        val retired: List<Paper>,
        val summary: JSONObject,
        val epoch: String,
        val taxonomy: WebsiteTaxonomy,
        val activeState: ActiveDesktopState,
        val prepareStateFiles: () -> Unit,
        val rollbackPreparedStateFiles: () -> Unit,
        val cleanupStage: () -> Unit,
    )

    data class LoadedArticle(
        val article: Article,
        val enrichedPaper: Paper,
    )

    internal class SanitizedArticleHtml(
        val body: Element,
        val imgOriginalSources: IdentityHashMap<Element, String>,
        val inlineDataBytesByElement: IdentityHashMap<Element, ByteArray>,
    )

    private fun stateFile(snapshotId: String, epoch: String): File {
        require(SHA256_PATTERN.matches(snapshotId) && SAFE_EPOCH_PATTERN.matches(epoch)) { "桌面状态标识非法" }
        return checkedChild(root, "states", "$snapshotId-$epoch.json")
    }

    private fun tombstoneStateFile(snapshotId: String, epoch: String): File {
        require(SHA256_PATTERN.matches(snapshotId) && SAFE_EPOCH_PATTERN.matches(epoch)) { "删除历史状态标识非法" }
        return checkedChild(root, "tombstone-states", "$snapshotId-$epoch.json")
    }

    private fun macosStateFile(snapshotId: String, epoch: String): File {
        require(SHA256_PATTERN.matches(snapshotId) && SAFE_EPOCH_PATTERN.matches(epoch)) { "macOS 桌面状态标识非法" }
        return checkedChild(root, "macos-states", "$snapshotId-$epoch.json")
    }

    /**
     * Symmetric cross-platform `.paperdigest` backup restoration (`macOS -> Android`):
     * When BOTH Android `states/<snapshotId>-<epoch>.json` and `tombstone-states/<snapshotId>-<epoch>.json`
     * are completely absent (neither regular file nor symlink/directory), check for a portable macOS
     * witness at `desktop-details/macos-states/<snapshotId>-<epoch>.json`. If present, cold-verify the
     * witness plus every referenced `snapshots/<snapshotId>.json`, `catalog/<sha256>.json`, and
     * `tombstones/<sha256>.json` byte-for-byte before materializing the Android state files.
     * Any corruption, symlink, missing shard, or count/disjointness mismatch fails closed!
     */
    private fun reconstructFromMacosWitnessIfPresent(snapshotID: String, epoch: String) {
        val androidState = stateFile(snapshotID, epoch)
        val androidTomb = tombstoneStateFile(snapshotID, epoch)
        // If either Android state file already exists (valid, corrupted, or non-regular), do NOT enter macOS witness path!
        if (Files.exists(androidState.toPath(), NOFOLLOW_LINKS) || Files.exists(androidTomb.toPath(), NOFOLLOW_LINKS)) {
            return
        }
        val macosFile = macosStateFile(snapshotID, epoch)
        if (!Files.exists(macosFile.toPath(), NOFOLLOW_LINKS)) {
            return
        }
        require(Files.isRegularFile(macosFile.toPath(), NOFOLLOW_LINKS)) { "macOS 桌面状态见证不是普通文件" }
        val witnessRaw = JsonFiles.read(macosFile, 32L * 1024 * 1024)
        val witness = StrictJson.parseObject(witnessRaw, macosFile.name)
        require(
            !witness.has("format") &&
                witness.optString("contract") == MACOS_STATE_CONTRACT &&
                witness.getString("snapshotID") == snapshotID &&
                witness.getString("validationEpoch") == epoch
        ) { "macOS 桌面状态见证协议或验证代不匹配" }
        val sourceCommit = witness.getString("sourceCommit")
        require(COMMIT_OID_PATTERN.matches(sourceCommit)) { "macOS 桌面状态见证 sourceCommit 非法" }
        val basePath = witness.getString("basePath")
        require(isAcceptedSiteBasePath(basePath, CatalogRepository.SITE)) {
            "macOS 桌面状态见证 basePath 与当前站点路径不一致：$basePath"
        }
        witness.nullableString("generatedAt")?.let { requireIsoTimestampWithTz(it, "macosWitness.generatedAt") }

        // 1. Cold-verify `desktop-details/snapshots/<snapshotID>.json`
        val snapshotFile = checkedChild(root, "snapshots", "$snapshotID.json")
        require(Files.isRegularFile(snapshotFile.toPath(), NOFOLLOW_LINKS)) { "恢复目录缺少桌面快照原件：$snapshotID" }
        val snapshotRaw = JsonFiles.read(snapshotFile, MAX_SNAPSHOT_BYTES.toLong())
        require(snapshotRaw.size in 1..MAX_SNAPSHOT_BYTES && sha256(snapshotRaw) == snapshotID) {
            "恢复目录桌面快照原件长度或 SHA-256 校验失败：$snapshotID"
        }
        val snapshotText = PublishedUtf8.decode(snapshotRaw)
        require(!snapshotText.contains(snapshotID)) { "快照 JSON 禁止包含自身 SHA" }
        val snapshot = StrictJson.parseObjectText(snapshotText, snapshotFile.name)
        require(ClientProtocols.hasValidHeader(snapshot, SNAPSHOT_CONTRACT)) { "恢复目录桌面快照协议头不受支持" }
        val snapshotSchema = ClientProtocols.declaredSchema(
            snapshot.get("contract"),
            SNAPSHOT_CONTRACT,
            snapshot.opt("schemaFingerprint") as? String,
        )
        val expectedSnapshotKeys = setOf("contract", "schemaFingerprint") + snapshotSchema.getJSONArray("fields").strings()
        requireExactKeys(snapshot, expectedSnapshotKeys, SNAPSHOT_CONTRACT)
        require(snapshot.getString("sourceCommit") == sourceCommit) { "macOS 见证与桌面快照 sourceCommit 不一致" }

        val expectedRecordCount = strictInt(snapshot, "recordCount", allowZero = false)
        val expectedAppearanceCount = strictInt(snapshot, "appearanceCount", allowZero = false)
        val expectedPaperCount = strictInt(snapshot, "paperCount", allowZero = false)
        val expectedTombstoneCount = strictInt(snapshot, "tombstoneCount", allowZero = true)
        require(expectedAppearanceCount == expectedRecordCount && expectedPaperCount <= expectedAppearanceCount) {
            "桌面快照计数不闭合"
        }

        val detailSchema = ClientProtocols.declaredSchema(
            ClientProtocols.contract(DETAIL_CONTRACT),
            DETAIL_CONTRACT,
            ClientProtocols.schemaFingerprint(DETAIL_CONTRACT),
        )
        val descriptorFields = detailSchema.getJSONArray("descriptorFields").strings().toSet()
        val shardFields = snapshotSchema.getJSONArray("shardFields").strings().toSet()
        val catalogRecordFields = snapshotSchema.getJSONArray("catalogRecordFields").strings().toSet()
        val tombstoneRecordFields = snapshotSchema.getJSONArray("tombstoneRecordFields").strings().toSet()

        // 2. Cold-verify all `catalogShards` and reconstruct `ActiveDesktopState`
        val catalogShardJsonList = snapshot.getJSONArray("catalogShards").objects()
        require(catalogShardJsonList.size in 1..MAX_SHARDS) { "桌面目录分片数量越界" }
        val seenCatalogUrls = HashSet<String>()
        var totalCatalogBytes = 0L
        val catalogShards = catalogShardJsonList.map { s ->
            requireExactKeys(s, shardFields, "catalogShard")
            val url = s.getString("url")
            val sha = s.getString("sha256")
            val bytes = strictInt(s, "bytes", allowZero = false)
            val count = strictInt(s, "recordCount", allowZero = false)
            val match = CATALOG_SHARD_URL_PATTERN.matchEntire(url)
            require(
                match != null && SHA256_PATTERN.matches(sha) && match.groupValues[1] == sha &&
                    seenCatalogUrls.add(url) && bytes <= MAX_SHARD_BYTES
            ) { "桌面目录分片描述非法：$url" }
            totalCatalogBytes += bytes
            require(totalCatalogBytes <= MAX_TOTAL_CATALOG_BYTES) { "桌面目录分片总字节超过 64 MiB 上限" }
            ShardDescriptor(url, bytes, sha, count)
        }
        require(catalogShards.sumOf { it.recordCount } == expectedRecordCount) { "桌面目录分片记录总和与快照声明不符" }

        val activeAppearances = LinkedHashMap<String, JSONObject>()
        val bindingsByKey = LinkedHashMap<String, AppearanceBinding>()
        val primaryBindingByPaper = LinkedHashMap<String, AppearanceBinding>()
        val distinctPaperKeys = HashSet<String>()
        var actualRecordCount = 0

        for (shard in catalogShards) {
            val shardFile = checkedChild(root, "catalog", "${shard.sha256}.json")
            require(Files.isRegularFile(shardFile.toPath(), NOFOLLOW_LINKS)) { "恢复目录缺少目录分片原件：${shard.url}" }
            val shardRaw = JsonFiles.read(shardFile, MAX_SHARD_BYTES.toLong())
            require(shardRaw.size == shard.bytes && sha256(shardRaw) == shard.sha256) {
                "恢复目录分片字节数或 SHA-256 校验失败：${shard.url}"
            }
            val rows = StrictJson.parseArray(shardRaw, shard.url)
            require(rows.length() == shard.recordCount) { "恢复目录分片实际条数与声明不符：${shard.url}" }
            for (rowIdx in 0 until rows.length()) {
                val row = rows.optJSONObject(rowIdx) ?: error("桌面目录记录不是对象")
                requireExactKeys(row, catalogRecordFields, "catalogRecord")
                val appearanceId = row.getString("appearanceId")
                val pageUrl = row.getString("pageUrl")
                require(APPEARANCE_ID_PATTERN.matches(appearanceId) && pageUrl == appearanceId && !activeAppearances.containsKey(appearanceId)) {
                    "目录记录 appearanceId 非法或重复：$appearanceId"
                }
                val blogURL = CatalogRepository.sameSite(pageUrl)
                val pageType = row.getString("pageType")
                val publicationStatus = row.getString("publicationStatus")
                val articleRevisionId = row.getString("articleRevisionId")
                require(pageType in setOf("paper", "daily", "conference")) { "目录记录 pageType 非法：$pageType" }
                require(publicationStatus in setOf("active", "retracted")) { "目录记录 publicationStatus 非法：$publicationStatus" }
                require(SHA256_PATTERN.matches(articleRevisionId)) { "目录记录 articleRevisionId 非法" }

                val detailObj = row.getJSONObject("detail")
                requireExactKeys(detailObj, descriptorFields, "catalog.detail")
                val detailUrl = detailObj.getString("url")
                val detailSha = detailObj.getString("sha256")
                val detailBytes = strictInt(detailObj, "bytes", allowZero = false)
                val detailMatch = DETAIL_URL_PATTERN.matchEntire(detailUrl)
                require(
                    detailMatch != null && SHA256_PATTERN.matches(detailSha) &&
                        detailMatch.groupValues[1] == detailSha && detailBytes <= MAX_DETAIL_BYTES
                ) { "详情描述符非法：$appearanceId" }
                val detailDesc = FileDescriptor(detailUrl, detailBytes, detailSha)

                val identityStatus = row.getString("identityStatus")
                val rawPaperId = if (row.isNull("paperId")) null else row.getString("paperId")
                val rawSourceKind = if (row.isNull("sourceKind")) null else row.getString("sourceKind")
                val rawSourceVersionId = if (row.isNull("sourceVersionId")) null else row.getString("sourceVersionId")
                val blogPublishedAt = if (row.isNull("blogPublishedAt")) null else row.getString("blogPublishedAt")
                val articleUpdatedAt = if (row.isNull("articleUpdatedAt")) null else row.getString("articleUpdatedAt")

                activeAppearances[appearanceId] = row
                actualRecordCount++

                if (pageType != "paper") {
                    require(rawPaperId == null && rawSourceVersionId == null && identityStatus == "aggregate-page") {
                        "汇总页不得伪装为单篇论文身份：$appearanceId"
                    }
                    continue
                }
                require(identityStatus != "aggregate-page") { "单篇论文页不得使用 aggregate-page 身份：$appearanceId" }
                val paperKey: String
                if (identityStatus == "verified") {
                    require(!rawPaperId.isNullOrBlank() && rawPaperId.length <= 256 && rawSourceKind in setOf("arxiv", "conference")) {
                        "已核验论文缺少规范 paperId 或 sourceKind：$appearanceId"
                    }
                    if (rawSourceKind == "arxiv") {
                        require(rawPaperId.startsWith("arxiv:") && ARXIV_ID_PATTERN.matches(rawPaperId.removePrefix("arxiv:"))) {
                            "arXiv paperId 非法：$rawPaperId"
                        }
                    } else {
                        require(CONFERENCE_PAPER_ID_PATTERN.matches(rawPaperId)) { "会议 paperId 非法：$rawPaperId" }
                    }
                    paperKey = rawPaperId
                    distinctPaperKeys += paperKey
                } else {
                    require(rawPaperId == null && rawSourceVersionId == null && identityStatus.isNotBlank()) {
                        "未核验历史论文不得伪造 paperId 或 sourceVersionId：$appearanceId"
                    }
                    paperKey = "page:${URI(blogURL).path}"
                    distinctPaperKeys += "unverified:$appearanceId"
                }

                val binding = AppearanceBinding(
                    appearanceId = appearanceId,
                    pageUrl = pageUrl,
                    blogURL = blogURL,
                    paperKey = paperKey,
                    paperId = rawPaperId,
                    identityStatus = identityStatus,
                    sourceKind = rawSourceKind,
                    sourceVersionId = rawSourceVersionId,
                    pageType = pageType,
                    publicationStatus = publicationStatus,
                    blogPublishedAt = blogPublishedAt,
                    articleUpdatedAt = articleUpdatedAt,
                    articleRevisionId = articleRevisionId,
                    detail = detailDesc,
                )
                bindingsByKey[paperKey + "\u0000" + blogURL] = binding
                val oldPrimary = primaryBindingByPaper[paperKey]
                if (oldPrimary == null || compareBindingRecency(binding, oldPrimary) > 0) {
                    primaryBindingByPaper[paperKey] = binding
                }
            }
        }
        require(actualRecordCount == expectedRecordCount && distinctPaperKeys.size == expectedPaperCount) {
            "恢复目录记录总数或论文数与快照声明不符"
        }
        witness.optJSONObject("paperDetails")?.let { witnessPapers ->
            for (paperKey in primaryBindingByPaper.keys.toList()) {
                val expectedAppearance = witnessPapers.optJSONObject(paperKey)?.nullableString("primaryAppearanceId") ?: continue
                val matched = bindingsByKey.values.firstOrNull { it.paperKey == paperKey && it.appearanceId == expectedAppearance }
                if (matched != null) primaryBindingByPaper[paperKey] = matched
            }
        }

        // 3. Cold-verify all `tombstoneShards` and disjointness against `activeAppearances`
        val tombstoneShardJsonList = snapshot.getJSONArray("tombstoneShards").objects()
        require(tombstoneShardJsonList.size <= MAX_SHARDS) { "tombstoneShards 数量越界" }
        if (expectedTombstoneCount == 0) {
            require(tombstoneShardJsonList.isEmpty()) { "tombstoneCount 为 0 时 tombstoneShards 必须为空" }
        } else {
            require(tombstoneShardJsonList.isNotEmpty()) { "tombstoneCount > 0 时必须包含 tombstoneShards" }
        }
        val seenTombstoneUrls = HashSet<String>()
        val seenTombstoneAppearances = LinkedHashMap<String, JSONObject>()
        var actualTombstoneCount = 0
        var totalTombstoneBytes = 0L

        for (s in tombstoneShardJsonList) {
            requireExactKeys(s, shardFields, "tombstoneShard")
            val url = s.getString("url")
            val sha = s.getString("sha256")
            val bytes = strictInt(s, "bytes", allowZero = false)
            val count = strictInt(s, "recordCount", allowZero = false)
            val match = TOMBSTONE_SHARD_URL_PATTERN.matchEntire(url)
            require(
                match != null && SHA256_PATTERN.matches(sha) && match.groupValues[1] == sha &&
                    seenTombstoneUrls.add(url) && bytes <= MAX_SHARD_BYTES
            ) { "tombstone 分片描述非法：$url" }
            totalTombstoneBytes += bytes
            require(totalTombstoneBytes <= MAX_TOTAL_CATALOG_BYTES) { "tombstone 分片总字节超过 64 MiB 上限" }

            val tombFile = checkedChild(root, "tombstones", "$sha.json")
            require(Files.isRegularFile(tombFile.toPath(), NOFOLLOW_LINKS)) { "恢复目录缺少 tombstone 分片原件：$url" }
            val shardRaw = JsonFiles.read(tombFile, MAX_SHARD_BYTES.toLong())
            require(shardRaw.size == bytes && sha256(shardRaw) == sha) { "恢复目录 tombstone 分片 SHA-256 校验失败：$url" }
            val tombs = StrictJson.parseArray(shardRaw, url)
            require(tombs.length() == count) { "tombstone 分片条数不符：$url" }
            for (i in 0 until tombs.length()) {
                val tomb = tombs.optJSONObject(i) ?: error("tombstone 记录不是对象")
                requireExactKeys(tomb, tombstoneRecordFields, "tombstone")
                val appId = tomb.getString("appearanceId")
                require(APPEARANCE_ID_PATTERN.matches(appId) && !seenTombstoneAppearances.containsKey(appId)) {
                    "tombstone appearanceId 非法或重复：$appId"
                }
                require(!activeAppearances.containsKey(appId)) { "tombstone 与当前活动目录 appearanceId 相交：$appId" }
                require(SHA256_PATTERN.matches(tomb.getString("previousArticleRevisionId"))) {
                    "tombstone previousArticleRevisionId 非法：$appId"
                }
                val reason = tomb.getString("reason")
                require(reason in setOf("site-removed", "retracted", "replaced")) { "tombstone reason 非法：$reason" }
                require(COMMIT_OID_PATTERN.matches(tomb.getString("sourceCommit"))) { "tombstone sourceCommit 非法" }
                requireIsoTimestampWithTz(tomb.getString("effectiveAt"), "tombstone.effectiveAt")
                if (reason == "retracted") {
                    require(isValidHttpsUrl(tomb.nullableString("evidenceUrl")) && !tomb.nullableString("note").isNullOrBlank()) {
                        "正式撤稿 tombstone 缺少 HTTPS evidenceUrl 或说明：$appId"
                    }
                }
                if (reason == "replaced") {
                    val replacement = tomb.nullableString("replacementAppearanceId")
                    require(replacement != null && activeAppearances.containsKey(replacement)) {
                        "replaced tombstone 的替换页面不在当前有效目录中：$appId"
                    }
                }
                seenTombstoneAppearances[appId] = tomb
                actualTombstoneCount++
            }
        }
        require(actualTombstoneCount == expectedTombstoneCount) { "tombstone 实际总条数与快照不一致" }

        // 4. Import & validate `tombstoneHistory` from macOS witness
        require(witness.has("tombstoneHistory") && witness.get("tombstoneHistory") is JSONArray) {
            "macOS 桌面状态见证缺少合法 tombstoneHistory 数组"
        }
        val importedEvents = ArrayList<JSONObject>()
        val recordedKeys = HashSet<String>()
        for (ev in witness.getJSONArray("tombstoneHistory").objects()) {
            val kind = ev.getString("kind")
            require(kind in setOf("removed", "restored")) { "macOS tombstoneHistory 事件类型非法：$kind" }
            val appId = ev.getString("appearanceId")
            require(APPEARANCE_ID_PATTERN.matches(appId)) { "macOS tombstoneHistory appearanceId 非法：$appId" }
            val evCommit = ev.getString("sourceCommit")
            require(COMMIT_OID_PATTERN.matches(evCommit)) { "macOS tombstoneHistory sourceCommit 非法" }
            val obsSnap = ev.getString("observedSnapshotId")
            require(SHA256_PATTERN.matches(obsSnap)) { "macOS tombstoneHistory observedSnapshotId 非法" }
            val obsAt = ev.getString("observedAt")
            requireIsoTimestampWithTz(obsAt, "macosHistory.observedAt")
            val effAt = ev.getString("effectiveAt")
            requireIsoTimestampWithTz(effAt, "macosHistory.effectiveAt")

            val paperId = ev.nullableString("paperId")
            val prevRev = ev.nullableString("previousArticleRevisionId")?.also { require(SHA256_PATTERN.matches(it)) }
            val restRev = ev.nullableString("restoredArticleRevisionId")?.also { require(SHA256_PATTERN.matches(it)) }
            val reason = ev.nullableString("reason")?.also { require(it in setOf("site-removed", "retracted", "replaced")) }
            val replacement = ev.nullableString("replacementAppearanceId")?.also { require(APPEARANCE_ID_PATTERN.matches(it)) }
            val evidenceUrl = ev.nullableString("evidenceUrl")?.also { require(isValidHttpsUrl(it)) }
            val note = ev.nullableString("note")

            if (kind == "removed") {
                require(prevRev != null && reason != null) { "macOS removed 事件缺少 previousArticleRevisionId 或 reason" }
                val key = listOf("tombstone", appId, reason, evCommit, prevRev, "").joinToString("|")
                if (recordedKeys.add(key)) {
                    importedEvents += JSONObject()
                        .put("eventType", "tombstone")
                        .put("snapshotId", obsSnap)
                        .put("appearanceId", appId)
                        .put("paperId", paperId ?: JSONObject.NULL)
                        .put("previousArticleRevisionId", prevRev)
                        .put("reason", reason)
                        .put("effectiveAt", effAt)
                        .put("sourceCommit", evCommit)
                        .put("replacementAppearanceId", replacement ?: JSONObject.NULL)
                        .put("evidenceUrl", evidenceUrl ?: JSONObject.NULL)
                        .put("note", note ?: JSONObject.NULL)
                        .put("observedAt", obsAt)
                }
            } else {
                val resolvedRestRev = restRev ?: activeAppearances[appId]?.getString("articleRevisionId")
                require(resolvedRestRev != null && SHA256_PATTERN.matches(resolvedRestRev)) { "macOS restored 事件缺少有效修订号" }
                val key = listOf("restored", appId, "", evCommit, "", resolvedRestRev).joinToString("|")
                if (recordedKeys.add(key)) {
                    importedEvents += JSONObject()
                        .put("eventType", "restored")
                        .put("snapshotId", obsSnap)
                        .put("appearanceId", appId)
                        .put("paperId", paperId ?: JSONObject.NULL)
                        .put("articleRevisionId", resolvedRestRev)
                        .put("sourceCommit", evCommit)
                        .put("observedAt", obsAt)
                }
            }
        }

        val fallbackObservedAt = witness.nullableString("generatedAt") ?: now()
        for ((appId, tomb) in seenTombstoneAppearances) {
            val key = listOf(
                "tombstone",
                appId,
                tomb.optString("reason"),
                tomb.optString("sourceCommit"),
                tomb.optString("previousArticleRevisionId"),
                "",
            ).joinToString("|")
            if (recordedKeys.add(key)) {
                importedEvents += tomb.copy()
                    .put("eventType", "tombstone")
                    .put("snapshotId", snapshotID)
                    .put("observedAt", fallbackObservedAt)
            }
        }

        val currentTombstonesObj = JSONObject()
        seenTombstoneAppearances.forEach { (appId, tomb) -> currentTombstonesObj.put(appId, tomb.copy()) }
        val reconstructedTombstoneHistory = JSONObject()
            .put("format", TOMBSTONE_HISTORY_FORMAT)
            .put("version", 1)
            .put("latestSnapshotId", snapshotID)
            .put("validationEpoch", epoch)
            .put("latestSourceCommit", sourceCommit)
            .put("currentTombstones", currentTombstonesObj)
            .put("events", JSONArray(importedEvents))

        val reconstructedState = ActiveDesktopState(
            snapshotId = snapshotID,
            sourceCommit = sourceCommit,
            validationEpoch = epoch,
            byPaperAndBlog = bindingsByKey,
            primaryByPaper = primaryBindingByPaper,
        )

        // Ensure aggregate store is also staged for this restored epoch if not yet present
        val aggStore = PublishedAggregateStore(libraryDirectory)
        if (aggStore.load(snapshotID, epoch) == null) {
            aggStore.stage(snapshotRaw, epoch)
        }

        try {
            JsonFiles.write(androidTomb, canonical(reconstructedTombstoneHistory).toByteArray(Charsets.UTF_8))
            JsonFiles.write(androidState, canonical(reconstructedState.json()).toByteArray(Charsets.UTF_8))
        } catch (err: Throwable) {
            runCatching { if (androidState.isFile) androidState.delete() }
            runCatching { if (androidTomb.isFile) androidTomb.delete() }
            throw err
        }
    }

    /** Fail-closed read of tombstone history bound to `(snapshotID, epoch)` when `isDesktopSnapshot` is true. */
    fun tombstoneHistoryFor(snapshotID: String, epoch: String, isDesktopSnapshot: Boolean): JSONObject {
        if (!isDesktopSnapshot) return emptyTombstoneHistory()
        reconstructFromMacosWitnessIfPresent(snapshotID, epoch)
        val file = tombstoneStateFile(snapshotID, epoch)
        require(Files.isRegularFile(file.toPath(), NOFOLLOW_LINKS)) { "当前桌面快照缺少删除历史状态文件" }
        val raw = JsonFiles.read(file, 16L * 1024 * 1024)
        val parsed = StrictJson.parseObject(raw, file.name)
        require(
            parsed.optString("format") == TOMBSTONE_HISTORY_FORMAT &&
                parsed.optInt("version") == 1 &&
                parsed.getString("latestSnapshotId") == snapshotID &&
                parsed.getString("validationEpoch") == epoch
        ) { "本地删除历史状态记录损坏或与当前验证代不匹配" }
        return parsed.copy()
    }

    /**
     * Fail-closed loader for `MANIFEST_CONTRACT` catalogs: missing, symlinked, or corrupted
     * epoch-bound state files MUST throw instead of silently degrading to legacy HTML scraping.
     */
    fun loadActiveStateRequired(snapshotID: String, epoch: String): ActiveDesktopState {
        // Also validate the paired tombstone state file so corruption in either fails closed on startup/reload.
        tombstoneHistoryFor(snapshotID, epoch, isDesktopSnapshot = true)
        val file = stateFile(snapshotID, epoch)
        require(Files.isRegularFile(file.toPath(), NOFOLLOW_LINKS)) { "当前桌面快照缺少描述符状态文件" }
        val raw = JsonFiles.read(file, 64L * 1024 * 1024)
        val obj = StrictJson.parseObject(raw, file.name)
        require(
            obj.optString("format") == ACTIVE_STATE_FORMAT &&
                obj.optInt("version") == 1 &&
                obj.getString("snapshotId") == snapshotID &&
                obj.getString("validationEpoch") == epoch
        ) { "桌面快照状态文件协议或验证代不匹配" }
        val sourceCommit = obj.getString("sourceCommit")
        require(COMMIT_OID_PATTERN.matches(sourceCommit)) { "桌面快照状态 sourceCommit 非法" }
        val appearances = obj.getJSONArray("appearances").objects().map(AppearanceBinding::fromJson)
        val byKey = LinkedHashMap<String, AppearanceBinding>(appearances.size)
        val byAppearanceId = HashMap<String, AppearanceBinding>(appearances.size)
        appearances.forEach { b ->
            require(
                APPEARANCE_ID_PATTERN.matches(b.appearanceId) &&
                    SHA256_PATTERN.matches(b.detail.sha256) &&
                    DETAIL_URL_PATTERN.matches(b.detail.url) &&
                    b.detail.bytes in 1..MAX_DETAIL_BYTES
            ) { "桌面快照状态条目非法：${b.appearanceId}" }
            byKey[b.paperKey + "\u0000" + b.blogURL] = b
            byAppearanceId[b.appearanceId] = b
        }
        val primaryObj = obj.getJSONObject("primaryAppearanceIds")
        val primaryByPaper = LinkedHashMap<String, AppearanceBinding>()
        primaryObj.keys().forEach { paperKey ->
            val appId = primaryObj.getString(paperKey)
            val b = byAppearanceId[appId] ?: error("桌面快照主出现记录缺失：$paperKey")
            primaryByPaper[paperKey] = b
        }
        return ActiveDesktopState(snapshotID, sourceCommit, epoch, byKey, primaryByPaper)
    }

    /** Best-effort cleanup of superseded epoch state files ONLY AFTER `current.json` has committed. */
    fun pruneSupersededStates(keepSnapshotId: String?, keepEpoch: String?) {
        val keepName = if (keepSnapshotId != null && keepEpoch != null) "$keepSnapshotId-$keepEpoch.json" else null
        for (folderName in listOf("states", "tombstone-states")) {
            runCatching {
                val folder = checkedChild(root, folderName)
                if (!folder.isDirectory) return@runCatching
                folder.listFiles().orEmpty().forEach { file ->
                    if (!Files.isSymbolicLink(file.toPath()) && file.isFile && file.name != keepName) {
                        file.delete()
                    }
                }
            }
        }
    }

    fun enrichFromCachedDetails(papers: List<Paper>, state: ActiveDesktopState?): List<Paper> {
        if (state == null) return papers
        return papers.map { paper ->
            val binding = state.resolve(paper) ?: return@map paper
            val detailFile = checkedChild(root, "papers", "${binding.detail.sha256}.json")
            if (!Files.exists(detailFile.toPath(), NOFOLLOW_LINKS)) return@map paper
            require(Files.isRegularFile(detailFile.toPath(), NOFOLLOW_LINKS)) { "本地详情缓存文件不是普通文件" }
            val raw = JsonFiles.read(detailFile, MAX_DETAIL_BYTES.toLong())
            require(raw.size == binding.detail.bytes && sha256(raw) == binding.detail.sha256) {
                "本地详情缓存长度或 SHA-256 已损坏：${binding.detail.url}"
            }
            val detail = parseAndValidateDetail(raw, binding)
            applyDetailToPaper(paper, detail, binding)
        }
    }

    suspend fun syncFromManifest(
        manifestBytes: ByteArray,
        previousPublished: List<Paper>,
        previousRetired: List<Paper>,
        previousSnapshotId: String,
        previousEpoch: String,
        previousIsDesktop: Boolean,
        progress: (Int, Int, String) -> Unit,
    ): SyncedSnapshot {
        val ctx = currentCoroutineContext()
        val manifest = parseManifest(manifestBytes, CatalogRepository.SITE)
        val previousTombstoneHistory = tombstoneHistoryFor(previousSnapshotId, previousEpoch, previousIsDesktop)

        val stageDir = checkedChild(root, ".stage-${UUID.randomUUID()}")
        require(!stageDir.exists() && stageDir.mkdirs() && !Files.isSymbolicLink(stageDir.toPath())) { "无法创建桌面快照暂存目录" }

        try {
            // 1. Fetch/read snapshot JSON and verify raw byte size + raw SHA-256 BEFORE JSON parse
            val snapshotRaw = stageImmutableBytes(
                permanentFile = checkedChild(root, "snapshots", "${manifest.snapshotId}.json"),
                stagedFile = checkedChild(stageDir, "snapshots", "${manifest.snapshotId}.json"),
                relativeUrl = manifest.snapshot.url,
                expectedBytes = manifest.snapshot.bytes,
                expectedSha256 = manifest.snapshotId,
                maxBytes = MAX_SNAPSHOT_BYTES,
                label = manifest.snapshot.url,
            )
            ctx.ensureActive()
            val snapshotText = PublishedUtf8.decode(snapshotRaw)
            require(!snapshotText.contains(manifest.snapshotId)) { "快照 JSON 禁止包含自身 SHA" }
            val snapshot = StrictJson.parseObjectText(snapshotText, manifest.snapshot.url)
            require(
                ClientProtocols.hasValidHeader(snapshot, SNAPSHOT_CONTRACT) &&
                    snapshot.optString("contract") == manifest.snapshotContract &&
                    snapshot.optString("schemaFingerprint") == manifest.snapshotSchemaFingerprint
            ) { "桌面目录快照协议或结构指纹不受支持" }
            val snapshotSchema = ClientProtocols.declaredSchema(
                snapshot.get("contract"),
                SNAPSHOT_CONTRACT,
                snapshot.opt("schemaFingerprint") as? String,
            )
            val expectedSnapshotKeys = setOf("contract", "schemaFingerprint") + snapshotSchema.getJSONArray("fields").strings()
            requireExactKeys(snapshot, expectedSnapshotKeys, "paper-desktop-snapshot")
            require(snapshot.getString("sourceCommit") == manifest.sourceCommit) { "manifest 与 snapshot 的 sourceCommit 不一致" }

            val expectedRecordCount = strictInt(snapshot, "recordCount", allowZero = false)
            val expectedAppearanceCount = strictInt(snapshot, "appearanceCount", allowZero = false)
            val expectedPaperCount = strictInt(snapshot, "paperCount", allowZero = false)
            val expectedTombstoneCount = strictInt(snapshot, "tombstoneCount", allowZero = true)
            require(expectedAppearanceCount == expectedRecordCount && expectedPaperCount <= expectedAppearanceCount) {
                "桌面快照计数不闭合"
            }

            // 2. Stage & verify tagCatalogs (WebsiteTaxonomy)
            val tagCatalogs = snapshot.getJSONObject("tagCatalogs")
            val tagSnapDesc = tagCatalogs.getJSONObject("snapshot")
            val tagVerDesc = tagCatalogs.getJSONObject("versions")
            val tagSnapSha = tagSnapDesc.getString("sha256")
            val tagVerSha = tagVerDesc.getString("sha256")
            require(SHA256_PATTERN.matches(tagSnapSha) && SHA256_PATTERN.matches(tagVerSha)) { "分类词表 SHA 非法" }
            val tagSnapBytes = strictInt(tagSnapDesc, "bytes", allowZero = false)
            val tagVerBytes = strictInt(tagVerDesc, "bytes", allowZero = false)
            require(tagSnapBytes <= MAX_TAG_CATALOG_BYTES && tagVerBytes <= MAX_TAG_CATALOG_BYTES) { "分类词表超过大小上限" }
            val tagSnapUrl = requireSafeRelativePath(tagSnapDesc.getString("url"), "tagCatalogs.snapshot")
            val tagVerUrl = requireSafeRelativePath(tagVerDesc.getString("url"), "tagCatalogs.versions")

            val rawTagSnap = stageImmutableBytes(
                permanentFile = checkedChild(root, "tag-catalogs", "$tagSnapSha.json"),
                stagedFile = checkedChild(stageDir, "tag-catalogs", "$tagSnapSha.json"),
                relativeUrl = tagSnapUrl,
                expectedBytes = tagSnapBytes,
                expectedSha256 = tagSnapSha,
                maxBytes = MAX_TAG_CATALOG_BYTES,
                label = "tagCatalogs.snapshot",
            )
            val rawTagVer = stageImmutableBytes(
                permanentFile = checkedChild(root, "tag-catalogs", "$tagVerSha.json"),
                stagedFile = checkedChild(stageDir, "tag-catalogs", "$tagVerSha.json"),
                relativeUrl = tagVerUrl,
                expectedBytes = tagVerBytes,
                expectedSha256 = tagVerSha,
                maxBytes = MAX_TAG_CATALOG_BYTES,
                label = "tagCatalogs.versions",
            )
            ctx.ensureActive()
            val tagSnapObj = StrictJson.parseObject(rawTagSnap, "tagCatalogs.snapshot")
            val tagVerObj = StrictJson.parseObject(rawTagVer, "tagCatalogs.versions")
            require(ClientProtocols.hasValidHeader(tagSnapObj, "paper-tag-catalog-snapshot")) { "分类快照头无效" }
            require(ClientProtocols.hasValidHeader(tagVerObj, "paper-tag-catalog-versions")) { "分类版本头无效" }
            if (tagSnapDesc.has("contract") && !tagSnapDesc.isNull("contract")) {
                require(tagSnapObj.optString("contract") == tagSnapDesc.getString("contract")) { "分类快照合同与声明不一致" }
            }
            if (tagVerDesc.has("contract") && !tagVerDesc.isNull("contract")) {
                require(tagVerObj.optString("contract") == tagVerDesc.getString("contract")) { "分类版本合同与声明不一致" }
            }
            val taxonomy = WebsiteTaxonomy.parse(JSONObject().put("snapshot", tagSnapObj).put("versions", tagVerObj))
            val tagRegistrySha = tagSnapObj.getString("registrySha256")

            // 3. Stage & verify catalogShards
            val shardFields = snapshotSchema.getJSONArray("shardFields").strings().toSet()
            val catalogRecordFields = snapshotSchema.getJSONArray("catalogRecordFields").strings().toSet()
            val detailSchema = ClientProtocols.declaredSchema(
                DETAIL_CONTRACT,
                DETAIL_CONTRACT,
                ClientProtocols.schemaFingerprint(DETAIL_CONTRACT),
            )
            val descriptorFields = detailSchema.getJSONArray("descriptorFields").strings().toSet()

            val catalogShardJsonList = snapshot.getJSONArray("catalogShards").objects()
            require(catalogShardJsonList.size in 1..MAX_SHARDS) { "桌面目录分片数量越界" }

            val catalogShards = ArrayList<ShardDescriptor>(catalogShardJsonList.size)
            val seenCatalogUrls = HashSet<String>()
            var plannedTotalBytes = 0L
            var plannedRecords = 0L
            for (s in catalogShardJsonList) {
                requireExactKeys(s, shardFields, "catalogShard")
                val url = s.getString("url")
                val sha = s.getString("sha256")
                val bytes = strictInt(s, "bytes", allowZero = false)
                val count = strictInt(s, "recordCount", allowZero = false)
                val match = CATALOG_SHARD_URL_PATTERN.matchEntire(url)
                require(
                    match != null && SHA256_PATTERN.matches(sha) && match.groupValues[1] == sha &&
                        seenCatalogUrls.add(url) && bytes <= MAX_SHARD_BYTES
                ) { "桌面目录分片描述非法：$url" }
                plannedTotalBytes += bytes
                plannedRecords += count
                catalogShards += ShardDescriptor(url, bytes, sha, count)
            }
            require(plannedTotalBytes in 1..MAX_TOTAL_CATALOG_BYTES && plannedRecords == expectedRecordCount.toLong()) {
                "桌面目录分片总字节或记录数与快照不一致"
            }

            val previousById = (previousPublished + previousRetired).distinctBy { it.id }.associateBy { it.id }
            val activeAppearances = LinkedHashMap<String, JSONObject>(expectedRecordCount)
            val bindingsByKey = LinkedHashMap<String, AppearanceBinding>(expectedRecordCount)
            val primaryBindingByPaper = LinkedHashMap<String, AppearanceBinding>(expectedPaperCount)
            val papersAcc = LinkedHashMap<String, Paper>(expectedPaperCount)
            val distinctPaperKeys = HashSet<String>(expectedPaperCount)
            var actualRecordCount = 0

            catalogShards.forEachIndexed { index, shard ->
                ctx.ensureActive()
                val shardRaw = stageImmutableBytes(
                    permanentFile = checkedChild(root, "catalog", "${shard.sha256}.json"),
                    stagedFile = checkedChild(stageDir, "catalog", "${shard.sha256}.json"),
                    relativeUrl = shard.url,
                    expectedBytes = shard.bytes,
                    expectedSha256 = shard.sha256,
                    maxBytes = MAX_SHARD_BYTES,
                    label = shard.url,
                )
                val rows = StrictJson.parseArray(shardRaw, shard.url)
                require(rows.length() == shard.recordCount) { "桌面目录分片实际条数与声明不符：${shard.url}" }
                for (rowIdx in 0 until rows.length()) {
                    ctx.ensureActive()
                    val row = rows.optJSONObject(rowIdx) ?: error("桌面目录记录不是对象")
                    requireExactKeys(row, catalogRecordFields, "catalogRecord")
                    val appearanceId = row.getString("appearanceId")
                    val pageUrl = row.getString("pageUrl")
                    require(APPEARANCE_ID_PATTERN.matches(appearanceId) && pageUrl == appearanceId && !activeAppearances.containsKey(appearanceId)) {
                        "目录记录 appearanceId 非法或重复：$appearanceId"
                    }
                    val blogURL = CatalogRepository.sameSite(pageUrl)
                    val pageType = row.getString("pageType")
                    val publicationStatus = row.getString("publicationStatus")
                    val articleRevisionId = row.getString("articleRevisionId")
                    require(pageType in setOf("paper", "daily", "conference")) { "目录记录 pageType 非法：$pageType" }
                    require(publicationStatus in setOf("active", "retracted")) { "目录记录 publicationStatus 非法：$publicationStatus" }
                    require(SHA256_PATTERN.matches(articleRevisionId)) { "目录记录 articleRevisionId 非法" }

                    val detailObj = row.getJSONObject("detail")
                    requireExactKeys(detailObj, descriptorFields, "catalog.detail")
                    val detailUrl = detailObj.getString("url")
                    val detailSha = detailObj.getString("sha256")
                    val detailBytes = strictInt(detailObj, "bytes", allowZero = false)
                    val detailMatch = DETAIL_URL_PATTERN.matchEntire(detailUrl)
                    require(
                        detailMatch != null && SHA256_PATTERN.matches(detailSha) &&
                            detailMatch.groupValues[1] == detailSha && detailBytes <= MAX_DETAIL_BYTES
                    ) { "详情描述符非法：$appearanceId" }
                    val detailDesc = FileDescriptor(detailUrl, detailBytes, detailSha)

                    val identityStatus = row.getString("identityStatus")
                    val rawPaperId = if (row.isNull("paperId")) null else row.getString("paperId")
                    val rawSourceKind = if (row.isNull("sourceKind")) null else row.getString("sourceKind")
                    val rawSourceVersionId = if (row.isNull("sourceVersionId")) null else row.getString("sourceVersionId")
                    val blogPublishedAt = if (row.isNull("blogPublishedAt")) null else row.getString("blogPublishedAt")
                    val articleUpdatedAt = if (row.isNull("articleUpdatedAt")) null else row.getString("articleUpdatedAt")

                    activeAppearances[appearanceId] = row
                    actualRecordCount++

                    if (pageType != "paper") {
                        require(rawPaperId == null && rawSourceVersionId == null && identityStatus == "aggregate-page") {
                            "汇总页不得伪装为单篇论文身份：$appearanceId"
                        }
                        continue
                    }

                    require(identityStatus != "aggregate-page") { "单篇论文页不得使用 aggregate-page 身份：$appearanceId" }
                    val paperKey: String
                    if (identityStatus == "verified") {
                        require(!rawPaperId.isNullOrBlank() && rawPaperId.length <= 256 && rawSourceKind in setOf("arxiv", "conference")) {
                            "已核验论文缺少规范 paperId 或 sourceKind：$appearanceId"
                        }
                        if (rawSourceKind == "arxiv") {
                            require(rawPaperId.startsWith("arxiv:") && ARXIV_ID_PATTERN.matches(rawPaperId.removePrefix("arxiv:"))) {
                                "arXiv paperId 非法：$rawPaperId"
                            }
                        } else {
                            require(CONFERENCE_PAPER_ID_PATTERN.matches(rawPaperId)) { "会议 paperId 非法：$rawPaperId" }
                        }
                        paperKey = rawPaperId
                        distinctPaperKeys += paperKey
                    } else {
                        require(rawPaperId == null && rawSourceVersionId == null && identityStatus.isNotBlank()) {
                            "未核验历史论文不得伪造 paperId 或 sourceVersionId：$appearanceId"
                        }
                        paperKey = "page:${URI(blogURL).path}"
                        distinctPaperKeys += "unverified:$appearanceId"
                    }

                    val binding = AppearanceBinding(
                        appearanceId = appearanceId,
                        pageUrl = pageUrl,
                        blogURL = blogURL,
                        paperKey = paperKey,
                        paperId = rawPaperId,
                        identityStatus = identityStatus,
                        sourceKind = rawSourceKind,
                        sourceVersionId = rawSourceVersionId,
                        pageType = pageType,
                        publicationStatus = publicationStatus,
                        blogPublishedAt = blogPublishedAt,
                        articleUpdatedAt = articleUpdatedAt,
                        articleRevisionId = articleRevisionId,
                        detail = detailDesc,
                    )
                    bindingsByKey[paperKey + "\u0000" + blogURL] = binding

                    val candidatePaper = buildPaperFromCatalogRow(
                        row = row,
                        binding = binding,
                        snapshotId = manifest.snapshotId,
                        sourceCommit = manifest.sourceCommit,
                        taxonomy = taxonomy,
                        tagRegistrySha = tagRegistrySha,
                        previous = previousById[paperKey],
                    )
                    val existing = papersAcc[paperKey]
                    if (existing == null) {
                        papersAcc[paperKey] = candidatePaper
                        primaryBindingByPaper[paperKey] = binding
                    } else {
                        val oldPrimary = primaryBindingByPaper.getValue(paperKey)
                        val candidateNewer = compareBindingRecency(binding, oldPrimary) >= 0
                        val chosen = if (candidateNewer) candidatePaper else existing
                        val chosenPrimary = if (candidateNewer) binding else oldPrimary
                        val mergedAppearances = (existing.appearances + candidatePaper.appearances).distinct().sorted()
                        val mergedTagRecords = JSONArray(WebsiteTaxonomy.records(existing) + WebsiteTaxonomy.records(candidatePaper))
                        val mergedDesktopAppearances = JSONArray().apply {
                            existing.original?.optJSONArray("desktopAppearances")?.objects()?.forEach(::put)
                            candidatePaper.original?.optJSONArray("desktopAppearances")?.objects()?.forEach(::put)
                        }
                        val mergedOriginal = (chosen.original?.copy() ?: JSONObject())
                            .put("websiteTagRecords", mergedTagRecords)
                            .put("desktopAppearances", mergedDesktopAppearances)
                        papersAcc[paperKey] = chosen.copy(appearances = mergedAppearances, original = mergedOriginal)
                        primaryBindingByPaper[paperKey] = chosenPrimary
                    }
                }
                progress(index + 1, catalogShards.size, "正在读取论文目录 ${index + 1}/${catalogShards.size}")
            }

            require(actualRecordCount == expectedRecordCount && actualRecordCount == expectedAppearanceCount) {
                "完整桌面目录记录数与快照声明不符"
            }
            require(distinctPaperKeys.size == expectedPaperCount && papersAcc.size == expectedPaperCount) {
                "去重论文数 (${distinctPaperKeys.size}) 与快照声明 ($expectedPaperCount) 不一致"
            }

            // 4. Stage & verify tombstoneShards + 64 MiB cap + strict disjointness from activeAppearances
            val tombstoneRecordFields = snapshotSchema.getJSONArray("tombstoneRecordFields").strings().toSet()
            val tombstoneShardJsonList = snapshot.getJSONArray("tombstoneShards").objects()
            require(tombstoneShardJsonList.size <= MAX_SHARDS) { "tombstoneShards 数量越界" }
            if (expectedTombstoneCount == 0) {
                require(tombstoneShardJsonList.isEmpty()) { "tombstoneCount 为 0 时 tombstoneShards 必须为空" }
            } else {
                require(tombstoneShardJsonList.isNotEmpty()) { "tombstoneCount > 0 时必须包含 tombstoneShards" }
            }

            val seenTombstoneUrls = HashSet<String>()
            val seenTombstoneAppearances = LinkedHashMap<String, JSONObject>()
            var actualTombstoneCount = 0
            var totalTombstoneBytes = 0L

            for (s in tombstoneShardJsonList) {
                ctx.ensureActive()
                requireExactKeys(s, shardFields, "tombstoneShard")
                val url = s.getString("url")
                val sha = s.getString("sha256")
                val bytes = strictInt(s, "bytes", allowZero = false)
                val count = strictInt(s, "recordCount", allowZero = false)
                val match = TOMBSTONE_SHARD_URL_PATTERN.matchEntire(url)
                require(
                    match != null && SHA256_PATTERN.matches(sha) && match.groupValues[1] == sha &&
                        seenTombstoneUrls.add(url) && bytes <= MAX_SHARD_BYTES
                ) { "tombstone 分片描述非法：$url" }
                totalTombstoneBytes += bytes
                require(totalTombstoneBytes <= MAX_TOTAL_CATALOG_BYTES) { "tombstone 分片总字节超过 64 MiB 上限" }

                val shardRaw = stageImmutableBytes(
                    permanentFile = checkedChild(root, "tombstones", "$sha.json"),
                    stagedFile = checkedChild(stageDir, "tombstones", "$sha.json"),
                    relativeUrl = url,
                    expectedBytes = bytes,
                    expectedSha256 = sha,
                    maxBytes = MAX_SHARD_BYTES,
                    label = url,
                )
                val tombs = StrictJson.parseArray(shardRaw, url)
                require(tombs.length() == count) { "tombstone 分片条数不符：$url" }
                for (i in 0 until tombs.length()) {
                    val tomb = tombs.optJSONObject(i) ?: error("tombstone 记录不是对象")
                    requireExactKeys(tomb, tombstoneRecordFields, "tombstone")
                    val appId = tomb.getString("appearanceId")
                    require(APPEARANCE_ID_PATTERN.matches(appId) && !seenTombstoneAppearances.containsKey(appId)) {
                        "tombstone appearanceId 非法或重复：$appId"
                    }
                    require(!activeAppearances.containsKey(appId)) {
                        "tombstone 与当前活动目录 appearanceId 相交：$appId"
                    }
                    require(SHA256_PATTERN.matches(tomb.getString("previousArticleRevisionId"))) {
                        "tombstone previousArticleRevisionId 非法：$appId"
                    }
                    val reason = tomb.getString("reason")
                    require(reason in setOf("site-removed", "retracted", "replaced")) { "tombstone reason 非法：$reason" }
                    require(COMMIT_OID_PATTERN.matches(tomb.getString("sourceCommit"))) { "tombstone sourceCommit 非法" }
                    requireIsoTimestampWithTz(tomb.getString("effectiveAt"), "tombstone.effectiveAt")

                    if (reason == "retracted") {
                        val evidenceUrl = tomb.nullableString("evidenceUrl")
                        val note = tomb.nullableString("note")
                        require(isValidHttpsUrl(evidenceUrl) && !note.isNullOrBlank()) {
                            "正式撤稿 tombstone 缺少 HTTPS evidenceUrl 或说明：$appId"
                        }
                    }
                    if (reason == "replaced") {
                        val replacement = tomb.nullableString("replacementAppearanceId")
                        require(replacement != null && activeAppearances.containsKey(replacement)) {
                            "replaced tombstone 的替换页面不在当前有效目录中：$appId"
                        }
                    }
                    seenTombstoneAppearances[appId] = tomb
                    actualTombstoneCount++
                }
            }
            require(actualTombstoneCount == expectedTombstoneCount) { "tombstone 实际总条数与快照不一致" }

            // 5. Build retired papers & epoch-bound state files without mutating previous state files
            val epoch = UUID.randomUUID().toString()
            val activeState = ActiveDesktopState(
                snapshotId = manifest.snapshotId,
                sourceCommit = manifest.sourceCommit,
                validationEpoch = epoch,
                byPaperAndBlog = bindingsByKey,
                primaryByPaper = primaryBindingByPaper,
            )
            val published = enrichFromCachedDetails(papersAcc.values.sortedBy { it.id }, activeState)
                .map { it.sharingCatalogValues(previousById[it.id]) }
            val activePaperIds = published.mapTo(HashSet()) { it.id }

            val tombstonesByPaper = HashMap<String, MutableList<JSONObject>>()
            seenTombstoneAppearances.values.forEach { tomb ->
                val pid = tomb.nullableString("paperId")
                    ?: ("page:" + URI(CatalogRepository.sameSite(tomb.getString("appearanceId"))).path)
                tombstonesByPaper.getOrPut(pid) { ArrayList() }.add(tomb.copy())
            }
            val retired = (previousRetired + previousPublished)
                .filter { it.id !in activePaperIds }
                .distinctBy { it.id }
                .map { oldPaper ->
                    val tombs = tombstonesByPaper[oldPaper.id]
                    if (tombs.isNullOrEmpty()) oldPaper
                    else oldPaper.copy(
                        original = (oldPaper.original?.copy() ?: JSONObject())
                            .put("desktopTombstones", JSONArray(tombs))
                    )
                }

            val updatedTombstoneHistory = buildUpdatedTombstoneHistory(
                previousHistory = previousTombstoneHistory,
                snapshotId = manifest.snapshotId,
                validationEpoch = epoch,
                sourceCommit = manifest.sourceCommit,
                activeAppearances = activeAppearances,
                currentTombstones = seenTombstoneAppearances,
            )

            val summary = JSONObject()
                .put("paperCount", published.size)
                .put("recordCount", actualRecordCount)
                .put("appearanceCount", expectedAppearanceCount)
                .put("tombstoneCount", actualTombstoneCount)
                .put("shardCount", catalogShards.size)
                .put("snapshotID", manifest.snapshotId)
                .put("sourceCommit", manifest.sourceCommit)
                .put("syncedAt", now())
                .put("source", CatalogRepository.SITE)
                .put("syncProtocol", MANIFEST_CONTRACT)
                .put("syncing", false)
                .put("missingFromLatest", JSONArray(retired.map { it.id }))
                .put("websiteTaxonomyStatus", "ready")

            ctx.ensureActive()
            val nextStateFile = stateFile(manifest.snapshotId, epoch)
            val nextTombstoneFile = tombstoneStateFile(manifest.snapshotId, epoch)

            val prepareAction: () -> Unit = {
                try {
                    promoteStagedDirectory(stageDir, root)
                    PublishedAggregateStore(libraryDirectory).stage(snapshotRaw, epoch)
                    JsonFiles.write(nextTombstoneFile, canonical(updatedTombstoneHistory).toByteArray(Charsets.UTF_8))
                    JsonFiles.write(nextStateFile, canonical(activeState.json()).toByteArray(Charsets.UTF_8))
                } finally {
                    stageDir.deleteRecursively()
                }
            }
            val rollbackAction: () -> Unit = {
                runCatching { if (nextStateFile.isFile) nextStateFile.delete() }
                runCatching { if (nextTombstoneFile.isFile) nextTombstoneFile.delete() }
            }
            return SyncedSnapshot(
                published = published,
                retired = retired,
                summary = summary,
                epoch = epoch,
                taxonomy = taxonomy,
                activeState = activeState,
                prepareStateFiles = prepareAction,
                rollbackPreparedStateFiles = rollbackAction,
                cleanupStage = { stageDir.deleteRecursively() },
            )
        } catch (error: Throwable) {
            stageDir.deleteRecursively()
            throw error
        }
    }

    suspend fun readArticle(
        paper: Paper,
        state: ActiveDesktopState,
        offlineMode: Boolean,
        previousArticle: Article?,
        currentEpoch: () -> String,
        onPaperEnriched: (Paper) -> Unit = {},
        onReadable: (Article) -> Unit,
    ): LoadedArticle {
        val ctx = currentCoroutineContext()
        require(currentEpoch() == state.validationEpoch) { "读取前目录验证代已变化" }
        val binding = state.resolve(paper) ?: error("当前桌面快照中不存在该论文详情描述符")

        // 1. Verify & parse detail JSON (`papers/<sha256>.json`, <= 2 MiB)
        val detailRaw = readOrFetchContentAddressed(
            localFile = checkedChild(root, "papers", "${binding.detail.sha256}.json"),
            relativeUrl = binding.detail.url,
            expectedBytes = binding.detail.bytes,
            expectedSha256 = binding.detail.sha256,
            maxBytes = MAX_DETAIL_BYTES,
            offlineMode = offlineMode,
            label = binding.detail.url,
        )
        ctx.ensureActive()
        require(currentEpoch() == state.validationEpoch) { "读取详情期间目录验证代已变化" }
        val detail = parseAndValidateDetail(detailRaw, binding)
        val enrichedPaper = applyDetailToPaper(paper, detail, binding)
        onPaperEnriched(enrichedPaper)

        // 2. Verify & parse content-addressed article HTML (`articles/<sha256>.html`, <= 16 MiB)
        val articleRev = detail.getJSONObject("articleRevision")
        val artDescObj = articleRev.getJSONObject("articleDescriptor")
        val artUrl = artDescObj.getString("url")
        val artSha = artDescObj.getString("sha256")
        val artBytes = strictInt(artDescObj, "bytes", allowZero = false)
        val artMatch = ARTICLE_URL_PATTERN.matchEntire(artUrl)
        require(artMatch != null && SHA256_PATTERN.matches(artSha) && artMatch.groupValues[1] == artSha && artBytes <= MAX_ARTICLE_BYTES) {
            "正文描述符非法：$artUrl"
        }

        val articleRaw = readOrFetchContentAddressed(
            localFile = checkedChild(root, "articles", "$artSha.html"),
            relativeUrl = artUrl,
            expectedBytes = artBytes,
            expectedSha256 = artSha,
            maxBytes = MAX_ARTICLE_BYTES,
            offlineMode = offlineMode,
            label = artUrl,
        )
        ctx.ensureActive()
        require(currentEpoch() == state.validationEpoch) { "读取正文期间目录验证代已变化" }

        // 3. Strict HTML safety rejection + sanitization against HTML_ALLOWED_TAGS / HTML_ALLOWED_ATTRS
        val sanitized = verifyAndSanitizeArticleHtml(articleRaw, enrichedPaper.blogURL)
        val sanitizedDoc = sanitized.body
        val hasGuideContent = articleRev.getBoolean("hasGuideContent")
        val citationSource = detail.getJSONObject("citation").getJSONObject("sourceRecord").copy()

        val baseNotices = mutableListOf<String>()
        val sv = detail.getJSONObject("sourceVersion")
        sv.nullableString("sourceVersionWarning")?.takeIf { it.isNotBlank() }?.let(baseNotices::add)
        sv.nullableString("provenanceDisclosure")?.takeIf { it.isNotBlank() }?.let(baseNotices::add)
        if (binding.publicationStatus == "retracted") {
            val retraction = detail.getJSONObject("appearance").getJSONObject("retraction")
            val note = retraction.getString("note")
            val evidenceUrl = retraction.getString("evidenceUrl")
            baseNotices += "撤稿提示：$note（证据：$evidenceUrl）"
        }
        if (!hasGuideContent) {
            baseNotices += "本页暂无完整导读正文。"
        }

        val declaredResources = detail.getJSONArray("resources").objects()
        val imageSpecsByKey = LinkedHashMap<String, JSONObject>()
        for (res in declaredResources) {
            if (res.getString("kind") != "image") continue
            val rawSource = res.getString("sourceUrl")
            val resolvedKey = resolveResourceSourceUrl(rawSource, enrichedPaper.blogURL) ?: rawSource.trim()
            imageSpecsByKey[resolvedKey] = res
        }

        var inlineAssetBytes = 0L
        val materializedInlineByElement = IdentityHashMap<Element, ArticleResource>()
        for (img in sanitizedDoc.select("img")) {
            val inlineBytes = sanitized.inlineDataBytesByElement[img] ?: continue
            verifyDesktopImageBytes(inlineBytes)
            inlineAssetBytes += inlineBytes.size
            require(inlineAssetBytes <= MAX_BUNDLED_ARTICLE_ASSETS_BYTES) { "单篇导读内联图片总量超过 64 MiB" }
            val hash = sha256(inlineBytes)
            val target = checkedChild(libraryDirectory, "assets", hash)
            if (Files.exists(target.toPath(), NOFOLLOW_LINKS)) {
                require(Files.isRegularFile(target.toPath(), NOFOLLOW_LINKS)) { "本地内联图片缓存不是普通文件" }
                val existing = JsonFiles.read(target, MAX_ASSET_BYTES.toLong())
                require(existing.size == inlineBytes.size && sha256(existing) == hash) { "本地内联图片缓存 SHA 冲突" }
            } else {
                JsonFiles.write(target, inlineBytes)
            }
            val inlineSourceUrl = "${enrichedPaper.blogURL.trimEnd('/')}/inline-data/$hash"
            img.attr("src", inlineSourceUrl)
            img.attr("data-source-url", inlineSourceUrl)
            img.attr("loading", "lazy")
            materializedInlineByElement[img] = ArticleResource(
                sourceURL = inlineSourceUrl,
                kind = "image",
                localPath = target.absolutePath,
                sha256 = hash,
            )
        }

        val pendingImages = sanitizedDoc.select("img").map { img ->
            materializedInlineByElement[img]
                ?: ArticleResource(sanitized.imgOriginalSources[img] ?: img.attr("src"), kind = "image", missingReason = "图片正在后台准备")
        }.distinct()

        val researchContext = buildResearchContextFromDetail(detail)
        val desktopExtensions = JSONObject()
            .put("desktopDetailSHA256", binding.detail.sha256)
            .put("desktopArticleSHA256", artSha)
            .put("desktopSnapshotID", state.snapshotId)
            .put("desktopSourceCommit", state.sourceCommit)
            .put("desktopDetail", detail.copy())
            .put("desktopSidecars", detail.getJSONObject("sidecars").copy())

        val earlyArticle = withFullOriginal(
            PublishedSourceWarning.present(
                Article(
                    paperID = enrichedPaper.id,
                    html = sanitizedDoc.html(),
                    plainText = CatalogRepository.articlePlainText(sanitizedDoc),
                    sourceURL = enrichedPaper.sourceURL ?: enrichedPaper.blogURL,
                    blogURL = enrichedPaper.blogURL,
                    revisionSHA256 = binding.articleRevisionId,
                    fetchedAt = now(),
                    sourceVersion = enrichedPaper.sourceVersion,
                    completeOffline = false,
                    notices = baseNotices.distinct(),
                    isStale = false,
                    citation = citationSource,
                    resources = pendingImages,
                    catalogEpoch = state.validationEpoch,
                    researchContext = researchContext,
                    pdfURL = enrichedPaper.pdfURL,
                    mathMLContract = "published-html-mathml",
                )
            ),
            desktopExtensions,
        )
        require(currentEpoch() == state.validationEpoch) { "发布初始正文前目录验证代已变化" }
        onReadable(earlyArticle)

        // 4. Resolve all non-PDF guide resources (`image`, `math-renderer`, `audio`, `video`, etc.) honestly
        val previousImageByUrl = previousArticle?.resources
            ?.filter { it.localPath != null && it.sha256 != null && it.missingReason == null }
            ?.associateBy { it.sourceURL }
            .orEmpty()

        val resolvedImages = ArrayList<ArticleResource>()
        val finalNotices = baseNotices.toMutableList()
        var totalAssetBytes = inlineAssetBytes
        val handledImageKeys = HashSet<String>()

        for (img in sanitizedDoc.select("img")) {
            ctx.ensureActive()
            require(currentEpoch() == state.validationEpoch) { "图片加载期间目录验证代已变化" }
            val materializedInline = materializedInlineByElement[img]
            if (materializedInline != null) {
                handledImageKeys += materializedInline.sourceURL
                resolvedImages += materializedInline
                continue
            }
            val url = sanitized.imgOriginalSources[img] ?: img.attr("src")
            handledImageKeys += url
            val spec = imageSpecsByKey[url]
            val availability = spec?.optString("availability") ?: if (url.startsWith("icassp-img://")) "missing" else "external"

            if (availability == "missing") {
                img.removeAttr("src")
                img.attr("data-source-url", url)
                resolvedImages += ArticleResource(url, kind = "image", missingReason = "原站未包含此图")
                finalNotices += "部分原图缺失，已保留图题与原来源说明"
                continue
            }

            try {
                val (localFile, hash, size) = if (availability == "bundled") {
                    val desc = spec!!.getJSONObject("descriptor")
                    val assetSha = desc.getString("sha256")
                    val assetBytes = strictInt(desc, "bytes", allowZero = false)
                    val assetUrl = requireSafeRelativePath(desc.getString("url"), "bundled-image")
                    val target = checkedChild(libraryDirectory, "assets", assetSha)
                    val bytes = readOrFetchAsset(target, assetUrl, assetBytes, assetSha, offlineMode, ::verifyDesktopImageBytes)
                    Triple(target, assetSha, bytes.size)
                } else {
                    val cachedPrev = previousImageByUrl[url]?.let { prev ->
                        runCatching {
                            val f = StoragePaths.resolve(prev.localPath!!, personalRoot, prev.sha256!!, MAX_ASSET_BYTES.toLong())
                            val b = JsonFiles.read(f, MAX_ASSET_BYTES.toLong())
                            verifyDesktopImageBytes(b)
                            Triple(f, prev.sha256, b.size)
                        }.getOrNull()
                    }
                    if (cachedPrev != null) {
                        cachedPrev
                    } else {
                        require(!offlineMode) { "离线模式下未缓存外部图片" }
                        val data = readExternal(url, MAX_ASSET_BYTES)
                        verifyDesktopImageBytes(data)
                        val hash = sha256(data)
                        val target = checkedChild(libraryDirectory, "assets", hash)
                        if (Files.exists(target.toPath(), NOFOLLOW_LINKS)) {
                            require(Files.isRegularFile(target.toPath(), NOFOLLOW_LINKS)) { "本地图片缓存不是普通文件" }
                            val existing = JsonFiles.read(target, MAX_ASSET_BYTES.toLong())
                            require(existing.size == data.size && sha256(existing) == hash) { "本地图片缓存 SHA 冲突" }
                        } else {
                            JsonFiles.write(target, data)
                        }
                        Triple(target, hash, data.size)
                    }
                }
                totalAssetBytes += size
                require(totalAssetBytes <= MAX_BUNDLED_ARTICLE_ASSETS_BYTES) { "单篇导读资源总量超过 64 MiB" }
                img.attr("data-source-url", url).attr("loading", "lazy")
                resolvedImages += ArticleResource(url, kind = "image", localPath = localFile.absolutePath, sha256 = hash)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                ctx.ensureActive()
                img.removeAttr("src")
                img.attr("data-source-url", url)
                resolvedImages += ArticleResource(url, kind = "image", missingReason = "图片尚未离线保存")
                finalNotices += "部分图片未能下载，已保留图题与原网址"
            }
        }

        // Handle any declared `image` in `detail.resources` not matched by a DOM `<img>` element (deduplicated!)
        var allRequiredGuideResourcesReady = true
        for ((url, spec) in imageSpecsByKey) {
            if (url in handledImageKeys) continue
            val availability = spec.getString("availability")
            val required = spec.getBoolean("requiredForOffline")
            when (availability) {
                "missing" -> {
                    if (required) allRequiredGuideResourcesReady = false
                    resolvedImages += ArticleResource(url, kind = "image", missingReason = "原站未包含此图")
                    finalNotices += "部分原图缺失，已保留图题与原来源说明"
                }
                "bundled" -> {
                    try {
                        val desc = spec.getJSONObject("descriptor")
                        val assetSha = desc.getString("sha256")
                        val assetBytes = strictInt(desc, "bytes", allowZero = false)
                        val assetUrl = requireSafeRelativePath(desc.getString("url"), "bundled-image")
                        val target = checkedChild(libraryDirectory, "assets", assetSha)
                        val bytes = readOrFetchAsset(target, assetUrl, assetBytes, assetSha, offlineMode, ::verifyDesktopImageBytes)
                        totalAssetBytes += bytes.size
                        require(totalAssetBytes <= MAX_BUNDLED_ARTICLE_ASSETS_BYTES)
                        resolvedImages += ArticleResource(url, kind = "image", localPath = target.absolutePath, sha256 = assetSha)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        if (required) allRequiredGuideResourcesReady = false
                        resolvedImages += ArticleResource(url, kind = "image", missingReason = "图片尚未离线保存")
                        finalNotices += "部分图片未能下载，已保留图题与原网址"
                    }
                }
                else -> {
                    if (required) allRequiredGuideResourcesReady = false
                    resolvedImages += ArticleResource(url, kind = "image", missingReason = "外部图片尚未离线保存")
                }
            }
        }

        // Check all other non-`pdf`, non-`image` resources (`math-renderer`, `video`, `audio`, etc.) with `requiredForOffline == true`
        for (res in declaredResources) {
            val kind = res.getString("kind")
            if (kind == "pdf" || kind == "image") continue
            if (!res.getBoolean("requiredForOffline")) continue
            val availability = res.getString("availability")
            when (kind) {
                "math-renderer" -> {
                    when (availability) {
                        "bundled" -> {
                            val ok = try {
                                val desc = res.getJSONObject("descriptor")
                                val assetSha = desc.getString("sha256")
                                val assetBytes = strictInt(desc, "bytes", allowZero = false)
                                val assetUrl = requireSafeRelativePath(desc.getString("url"), "bundled-math-renderer")
                                val target = checkedChild(root, "assets", assetSha)
                                val bytes = readOrFetchAsset(target, assetUrl, assetBytes, assetSha, offlineMode)
                                totalAssetBytes += bytes.size
                                require(totalAssetBytes <= MAX_BUNDLED_ARTICLE_ASSETS_BYTES)
                                true
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (_: Exception) {
                                false
                            }
                            if (!ok && !hasLocalMathRenderer()) allRequiredGuideResourcesReady = false
                        }
                        "external" -> {
                            if (!hasLocalMathRenderer()) allRequiredGuideResourcesReady = false
                        }
                        else -> allRequiredGuideResourcesReady = false
                    }
                }
                else -> {
                    if (availability == "bundled") {
                        val ok = try {
                            val desc = res.getJSONObject("descriptor")
                            val assetSha = desc.getString("sha256")
                            val assetBytes = strictInt(desc, "bytes", allowZero = false)
                            val assetUrl = requireSafeRelativePath(desc.getString("url"), "bundled-guide-resource")
                            val target = checkedChild(root, "assets", assetSha)
                            val bytes = readOrFetchAsset(target, assetUrl, assetBytes, assetSha, offlineMode)
                            totalAssetBytes += bytes.size
                            require(totalAssetBytes <= MAX_BUNDLED_ARTICLE_ASSETS_BYTES)
                            true
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Exception) {
                            false
                        }
                        if (!ok) {
                            allRequiredGuideResourcesReady = false
                            finalNotices += "部分导读离线依赖资源尚未下载"
                        }
                    } else {
                        allRequiredGuideResourcesReady = false
                        finalNotices += "部分外部或缺失媒体资源尚未离线保存"
                    }
                }
            }
        }

        val finalResources = resolvedImages.distinct()
        val completeOffline = hasGuideContent &&
            allRequiredGuideResourcesReady &&
            finalResources.all { it.localPath != null && it.sha256 != null && it.missingReason == null }

        // Final mid-read epoch guard before returning committed article
        ctx.ensureActive()
        require(currentEpoch() == state.validationEpoch) { "读取完成前目录验证代已变化，未混用跨快照修订" }

        val finalArticle = withFullOriginal(
            PublishedSourceWarning.present(
                earlyArticle.copy(
                    html = sanitizedDoc.html(),
                    resources = finalResources,
                    completeOffline = completeOffline,
                    notices = finalNotices.distinct(),
                    isStale = false,
                    original = null,
                )
            ),
            desktopExtensions,
        )
        return LoadedArticle(finalArticle, enrichedPaper)
    }

    suspend fun enrichPaperOnDemand(
        paper: Paper,
        state: ActiveDesktopState,
        offlineMode: Boolean,
        currentEpoch: () -> String,
    ): Paper {
        val binding = state.resolve(paper) ?: return paper
        require(currentEpoch() == state.validationEpoch) { "目录验证代已变化" }
        val detailRaw = readOrFetchContentAddressed(
            localFile = checkedChild(root, "papers", "${binding.detail.sha256}.json"),
            relativeUrl = binding.detail.url,
            expectedBytes = binding.detail.bytes,
            expectedSha256 = binding.detail.sha256,
            maxBytes = MAX_DETAIL_BYTES,
            offlineMode = offlineMode,
            label = binding.detail.url,
        )
        require(currentEpoch() == state.validationEpoch) { "目录验证代已变化" }
        val detail = parseAndValidateDetail(detailRaw, binding)
        return applyDetailToPaper(paper, detail, binding)
    }

    suspend fun citationOriginal(
        paper: Paper,
        article: Article,
        format: PublishedCitationRepository.Format,
        offlineMode: Boolean,
        requireCurrent: () -> Unit,
    ): PublishedCitationRepository.Original {
        require(paper.identityStatus == "verified" && paper.sourceKind in listOf("arxiv", "conference") && !paper.id.startsWith("local:")) {
            "此资料没有可核验的已发布引用原件；未猜写出版类型或论文编号。"
        }
        ReadingSourceBinding.requireArticle(paper, article)
        ReadingSourceBinding.requireCitation(paper, article.citation)
        require(!paper.sourceURL.isNullOrBlank() && isValidHttpsUrl(paper.sourceURL)) { "当前论文缺少可核验的 HTTPS 来源地址" }
        if (paper.pdfURL != null) require(isValidHttpsUrl(paper.pdfURL)) { "当前论文 PDF 地址不安全" }
        requireCurrent()

        // Cold-verify sealed `papers/<detailSha>.json` and `articles/<articleSha>.html` on disk;
        // never trust unverified `article.original.desktopSidecars` JSON directly!
        val detailSha = article.original?.nullableString("desktopDetailSHA256")
            ?: throw AppFailure("citationUnavailable", "此阅读版本缺少已封存详情指纹。")
        val articleSha = article.original.nullableString("desktopArticleSHA256")
            ?: throw AppFailure("citationUnavailable", "此阅读版本缺少已封存正文指纹。")
        require(SHA256_PATTERN.matches(detailSha) && SHA256_PATTERN.matches(articleSha)) { "已封存详情或正文 SHA 格式无效" }

        val detailFile = checkedChild(root, "papers", "$detailSha.json")
        require(Files.isRegularFile(detailFile.toPath(), NOFOLLOW_LINKS)) { "本地已封存详情原件缺失" }
        val detailRaw = JsonFiles.read(detailFile, MAX_DETAIL_BYTES.toLong())
        require(sha256(detailRaw) == detailSha) { "本地已封存详情原件字节已被篡改" }

        val detail = StrictJson.parseObject(detailRaw, detailFile.name)
        require(ClientProtocols.isCurrentHeader(detail, DETAIL_CONTRACT)) { "本地详情协议头无效" }
        val detailSchema = ClientProtocols.declaredSchema(
            detail.get("contract"),
            DETAIL_CONTRACT,
            detail.opt("schemaFingerprint") as? String,
        )
        requireExactKeys(detail, setOf("contract", "schemaFingerprint") + detailSchema.getJSONArray("fields").strings(), detailFile.name)

        val canonicalBlog = CatalogRepository.sameSite(paper.blogURL)
        require(
            detail.nullableString("paperId") == paper.id &&
                detail.getString("identityStatus") == "verified" &&
                detail.nullableString("sourceKind") == paper.sourceKind &&
                CatalogRepository.sameSite(detail.getString("appearanceId")) == canonicalBlog
        ) { "本地详情文件与当前阅读论文身份不一致" }

        val artRev = detail.getJSONObject("articleRevision")
        require(artRev.getString("articleRevisionId") == article.revisionSHA256) { "本地详情修订与当前阅读导读不一致" }
        val artDesc = artRev.getJSONObject("articleDescriptor")
        val expectedArtBytes = strictInt(artDesc, "bytes", allowZero = false)
        require(artDesc.getString("sha256") == articleSha && expectedArtBytes <= MAX_ARTICLE_BYTES) { "正文描述符与当前导读不一致" }

        val articleFile = checkedChild(root, "articles", "$articleSha.html")
        require(Files.isRegularFile(articleFile.toPath(), NOFOLLOW_LINKS)) { "本地已封存正文 HTML 缺失" }
        val articleRaw = JsonFiles.read(articleFile, MAX_ARTICLE_BYTES.toLong())
        require(articleRaw.size == expectedArtBytes && sha256(articleRaw) == articleSha) { "本地已封存正文 HTML 字节已变化" }
        val replayBody = verifyAndSanitizeArticleHtml(articleRaw, canonicalBlog).body
        require(CatalogRepository.articlePlainText(replayBody) == article.plainText) { "重放导读纯文本与当前阅读修订不一致" }

        val sidecars = detail.getJSONObject("sidecars")
        if (!sidecars.optBoolean("available")) {
            throw AppFailure("citationUnavailable", "这个已发布版本没有此格式的真实引用原件；未现场生成替代引用。")
        }
        val desc = sidecars.getJSONObject("files").optJSONObject(format.filename)
            ?: throw AppFailure("citationUnavailable", "这个已发布版本没有此格式的真实引用原件；未现场生成替代引用。")

        val relUrl = requireSafeRelativePath(desc.getString("url"), format.filename)
        val expectedBytes = strictInt(desc, "bytes", allowZero = false)
        val expectedSha = desc.getString("sha256")
        require(expectedBytes <= MAX_SIDECAR_BYTES && SHA256_PATTERN.matches(expectedSha)) { "引用原件描述符非法" }

        val ext = format.filename.substringAfterLast('.')
        val localFile = checkedChild(root, "sidecars", "$expectedSha.$ext")
        val raw = readOrFetchContentAddressed(
            localFile = localFile,
            relativeUrl = relUrl,
            expectedBytes = expectedBytes,
            expectedSha256 = expectedSha,
            maxBytes = MAX_SIDECAR_BYTES,
            offlineMode = offlineMode,
            label = format.filename,
        )
        PublishedCitationRepository.validateBytes(raw, paper, format)
        if (format == PublishedCitationRepository.Format.JSON && desc.has("contract")) {
            val parsedSidecar = StrictJson.parseObject(raw, "citation.json")
            require(
                parsedSidecar.optString("contract") == desc.getString("contract") &&
                    parsedSidecar.optString("schemaFingerprint") == desc.optString("schemaFingerprint")
            ) { "citation.json 实际协议头与详情声明不一致" }
        }
        requireCurrent()

        val sourceURL = CatalogRepository.sameSite(URI(CatalogRepository.SITE).resolve(relUrl).toASCIIString())
        val paperIdentity = JSONObject()
            .put("id", paper.id)
            .put("title", paper.title)
            .put("blogURL", canonicalBlog)
            .put("sourceKind", paper.sourceKind)
            .put("identityStatus", paper.identityStatus)
            .put("sourceURL", paper.sourceURL)
            .put("pdfURL", paper.pdfURL ?: JSONObject.NULL)
            .put("sourceVersion", paper.sourceVersion ?: JSONObject.NULL)
        val binding = JSONObject()
            .put("paper", paperIdentity)
            .put("articleRevisionSHA256", article.revisionSHA256)
            .put("detailSHA256", detailSha)
            .put("articleSHA256", articleSha)
            .put("pageURL", canonicalBlog)

        val record = ClientProtocols.record(ORIGINAL_CITATION_CONTRACT)
            .put("binding", binding)
            .put("filename", format.filename)
            .put("format", format.route)
            .put("mime", format.mime)
            .put("sourceURL", sourceURL)
            .put("bytes", raw.size)
            .put("sha256", expectedSha)
            .put("validatedAt", now())
            .put("validationScope", "desktop-detail-sha256-bound-sidecar")
            .put("bundleHashVerified", true)
            .put("publishedSHA256", expectedSha)
        val declaredFields = ClientProtocols.declaredSchema(
            ORIGINAL_CITATION_CONTRACT,
            ORIGINAL_CITATION_CONTRACT,
            ClientProtocols.schemaFingerprint(ORIGINAL_CITATION_CONTRACT),
        ).getJSONArray("fields").strings().toSet()
        requireExactKeys(
            record,
            ClientProtocols.recordKeys(
                ORIGINAL_CITATION_CONTRACT,
                ORIGINAL_CITATION_CONTRACT,
                declaredFields,
                ClientProtocols.schemaFingerprint(ORIGINAL_CITATION_CONTRACT),
            ),
            ORIGINAL_CITATION_CONTRACT,
        )
        return PublishedCitationRepository.Original(raw, record)
    }

    private fun withFullOriginal(articleWithoutOriginal: Article, extensions: JSONObject): Article {
        val fullOriginal = articleWithoutOriginal.json().also { full ->
            extensions.keys().forEach { key -> full.put(key, extensions.get(key)) }
        }
        return articleWithoutOriginal.copy(original = fullOriginal)
    }

    private fun parseAndValidateDetail(raw: ByteArray, binding: AppearanceBinding): JSONObject {
        val detail = StrictJson.parseObject(raw, binding.detail.url)
        require(ClientProtocols.isCurrentHeader(detail, DETAIL_CONTRACT)) {
            "论文详情协议头或结构指纹未登记：${binding.detail.url}"
        }
        val detailSchema = ClientProtocols.declaredSchema(
            detail.get("contract"),
            DETAIL_CONTRACT,
            detail.opt("schemaFingerprint") as? String,
        )
        val expectedKeys = setOf("contract", "schemaFingerprint") + detailSchema.getJSONArray("fields").strings()
        requireExactKeys(detail, expectedKeys, binding.detail.url)
        val descriptorFields = detailSchema.getJSONArray("descriptorFields").strings().toSet()

        // Cross-paper / cross-snapshot mix check
        val sv = detail.getJSONObject("sourceVersion")
        val app = detail.getJSONObject("appearance")
        val artRev = detail.getJSONObject("articleRevision")
        val dates = detail.getJSONObject("dates")
        require(
            detail.getString("appearanceId") == binding.appearanceId &&
                (if (detail.isNull("paperId")) null else detail.getString("paperId")) == binding.paperId &&
                detail.getString("identityStatus") == binding.identityStatus &&
                (if (detail.isNull("sourceKind")) null else detail.getString("sourceKind")) == binding.sourceKind &&
                (if (sv.isNull("sourceVersionId")) null else sv.getString("sourceVersionId")) == binding.sourceVersionId &&
                app.getString("appearanceId") == binding.appearanceId &&
                app.getString("pageType") == binding.pageType &&
                app.getString("publicationStatus") == binding.publicationStatus &&
                artRev.getString("articleRevisionId") == binding.articleRevisionId &&
                artRev.getString("appearanceId") == binding.appearanceId &&
                (if (dates.isNull("blogPublishedAt")) null else dates.getString("blogPublishedAt")) == binding.blogPublishedAt &&
                (if (dates.isNull("articleUpdatedAt")) null else dates.getString("articleUpdatedAt")) == binding.articleUpdatedAt
        ) {
            "目录记录与详情 JSON 字段不一致（拒绝跨快照串稿）：${binding.appearanceId}"
        }

        if (binding.publicationStatus == "retracted") {
            val retraction = app.optJSONObject("retraction") ?: error("撤稿记录缺少 retraction 详情")
            require(isValidHttpsUrl(retraction.nullableString("evidenceUrl")) && !retraction.nullableString("note").isNullOrBlank()) {
                "撤稿页面缺少有效 HTTPS 撤稿证据"
            }
        }

        // Citation verification
        val citationWrapper = detail.getJSONObject("citation")
        require(citationWrapper.get("verified") is Boolean && citationWrapper.get("complete") is Boolean) { "citation 布尔状态无效" }
        citationWrapper.getJSONArray("missingFields")
        citationWrapper.getJSONObject("fieldStatus")
        val sourceRecord = citationWrapper.getJSONObject("sourceRecord")
        require(ClientProtocols.hasValidHeader(sourceRecord, CITATION_SOURCE_CONTRACT)) {
            "详情 citation.sourceRecord 合同或指纹无效"
        }
        if (sourceRecord.optString("date").isEmpty()) {
            require(dates.isNull("paperPublishedAt")) { "不得用博客日期冒充缺失的论文发表日期" }
        }

        // Sidecars verification
        val sidecars = detail.getJSONObject("sidecars")
        val available = sidecars.get("available") as? Boolean ?: error("sidecars.available 必须为布尔值")
        val files = sidecars.getJSONObject("files")
        requireExactKeys(files, SIDECAR_NAMES, "sidecars.files")
        if (available) {
            for (name in SIDECAR_NAMES) {
                val f = files.optJSONObject(name) ?: error("sidecar 描述缺失：$name")
                requireSafeRelativePath(f.getString("url"), name)
                val b = strictInt(f, "bytes", allowZero = false)
                require(b <= MAX_SIDECAR_BYTES && SHA256_PATTERN.matches(f.getString("sha256"))) { "sidecar 大小或 SHA 非法：$name" }
                if (name == "rethink-context.json") {
                    val hdr = JSONObject().put("contract", f.getString("contract")).put("schemaFingerprint", f.getString("schemaFingerprint"))
                    require(ClientProtocols.hasValidHeader(hdr, "paper-research-context")) { "上下文 sidecar 声明指纹无效" }
                } else if (name == "citation.json" && f.has("contract")) {
                    val hdr = JSONObject().put("contract", f.getString("contract")).put("schemaFingerprint", f.getString("schemaFingerprint"))
                    require(ClientProtocols.hasValidHeader(hdr, "researcher-sidecars")) { "引用 sidecar 声明指纹无效" }
                }
            }
        } else {
            for (name in SIDECAR_NAMES) {
                require(files.isNull(name)) { "sidecars.available=false 时不得伪造 sidecar：$name" }
            }
            require(detail.isNull("abstract")) { "无已核验上下文 sidecar 时严禁用 AI 摘要冒充原摘要" }
        }

        // Article descriptor verification
        val artDesc = artRev.getJSONObject("articleDescriptor")
        requireExactKeys(artDesc, descriptorFields, "articleDescriptor")
        val artSha = artDesc.getString("sha256")
        val artUrl = artDesc.getString("url")
        val artBytes = strictInt(artDesc, "bytes", allowZero = false)
        val artMatch = ARTICLE_URL_PATTERN.matchEntire(artUrl)
        require(artMatch != null && SHA256_PATTERN.matches(artSha) && artMatch.groupValues[1] == artSha && artBytes <= MAX_ARTICLE_BYTES) {
            "articleDescriptor 非法"
        }

        // Resources verification (`resourceCount == resources.size`)
        val resources = detail.getJSONArray("resources").objects()
        val declaredResourceCount = strictInt(artRev, "resourceCount", allowZero = true)
        require(resources.size <= MAX_ARTICLE_RESOURCES && declaredResourceCount == resources.size) {
            "单篇资源列表数量与 articleRevision.resourceCount 不一致或越界"
        }
        var bundledSum = 0L
        for (res in resources) {
            require(
                res.getString("resourceId").isNotBlank() &&
                    res.getString("kind").isNotBlank() &&
                    res.getString("mediaType").isNotBlank() &&
                    res.getString("sourceUrl").isNotBlank() &&
                    res.get("requiredForOffline") is Boolean
            ) { "资源记录缺少必填字段" }
            val availability = res.getString("availability")
            require(availability in setOf("bundled", "external", "missing")) { "资源 availability 非法：$availability" }
            if (availability == "bundled") {
                val desc = res.optJSONObject("descriptor") ?: error("bundled 资源缺少描述符")
                requireExactKeys(desc, descriptorFields, "resource.descriptor")
                requireSafeRelativePath(desc.getString("url"), "resource.descriptor.url")
                val rb = strictInt(desc, "bytes", allowZero = false)
                require(rb <= MAX_ASSET_BYTES && SHA256_PATTERN.matches(desc.getString("sha256"))) { "bundled 资源大小或 SHA 非法" }
                bundledSum += rb
            } else {
                require(res.isNull("descriptor")) { "external/missing 资源禁止伪造非空描述符或 0 字节 SHA" }
            }
        }
        require(bundledSum <= MAX_BUNDLED_ARTICLE_ASSETS_BYTES) { "单篇捆绑资源总字节超过 64 MiB" }
        return detail
    }

    private fun applyDetailToPaper(paper: Paper, detail: JSONObject, binding: AppearanceBinding): Paper {
        val titles = detail.getJSONObject("titles")
        val originalTitle = titles.nullableString("originalTitle")
        val readerTitle = titles.nullableString("readerTitle")
        val displayTitle = titles.nullableString("displayTitle")
        val effectiveTitle = originalTitle ?: displayTitle ?: readerTitle ?: paper.title
        val effectiveTitleZh = readerTitle ?: displayTitle ?: effectiveTitle

        val authors = detail.getJSONArray("authors").objects()
            .sortedBy { strictInt(it, "position", allowZero = false) }
            .map { it.getString("name").also { n -> require(n.isNotBlank()) } }

        val sv = detail.getJSONObject("sourceVersion")
        val bib = detail.getJSONObject("bibliographic")
        val citationSource = detail.getJSONObject("citation").getJSONObject("sourceRecord").copy()
        detail.nullableString("abstract")?.let { citationSource.put("abstract", it) }

        val sourceUrl = cleanHttps(sv.nullableString("sourceUrl") ?: bib.nullableString("sourceUrl") ?: citationSource.nullableString("sourceUrl"))
        val pdfUrl = if (binding.identityStatus == "verified") {
            cleanHttps(sv.nullableString("pdfUrl") ?: bib.nullableString("pdfUrl") ?: citationSource.nullableString("pdfUrl"))
        } else null
        val pdfSha = sv.nullableString("pdfSha256")?.also { require(SHA256_PATTERN.matches(it)) }
        val sourceVersion = if (binding.sourceKind == "arxiv") {
            bib.nullableString("arxivVersionedId") ?: citationSource.nullableString("arxivId")?.takeIf { ARXIV_VERSION_SUFFIX_REGEX.containsMatchIn(it) } ?: paper.sourceVersion
        } else null

        val cls = detail.getJSONObject("classification")
        val primaryTask = cls.nullableString("primaryTask") ?: paper.task
        val primaryMethod = cls.nullableString("primaryMethod") ?: paper.method
        val flatTags = cls.optJSONArray("flatTags")?.strings()?.takeIf { it.isNotEmpty() } ?: paper.tags

        val updatedOriginal = (paper.original?.copy() ?: JSONObject())
            .put("desktopDetailVerified", true)
            .put("originalTitle", originalTitle ?: JSONObject.NULL)
            .put("readerTitle", readerTitle ?: JSONObject.NULL)
            .put("paperPublishedAt", detail.getJSONObject("dates").opt("paperPublishedAt") ?: JSONObject.NULL)
            .put("blogPublishedAt", detail.getJSONObject("dates").opt("blogPublishedAt") ?: JSONObject.NULL)
            .put("articleUpdatedAt", detail.getJSONObject("dates").opt("articleUpdatedAt") ?: JSONObject.NULL)

        return paper.copy(
            title = effectiveTitle,
            titleZh = effectiveTitleZh,
            authors = authors,
            task = primaryTask,
            method = primaryMethod,
            tags = flatTags,
            sourceURL = sourceUrl,
            pdfURL = pdfUrl,
            sourceVersion = sourceVersion,
            citation = citationSource,
            pdfSHA256 = pdfSha,
            original = updatedOriginal,
        )
    }

    private fun buildPaperFromCatalogRow(
        row: JSONObject,
        binding: AppearanceBinding,
        snapshotId: String,
        sourceCommit: String,
        taxonomy: WebsiteTaxonomy,
        tagRegistrySha: String,
        previous: Paper?,
    ): Paper {
        val title = row.getString("title").also { require(it.isNotBlank()) { "目录论文缺少标题" } }
        val titleZh = row.nullableString("titleZh") ?: title
        val scoreVal = row.opt("score")
        val score = if (scoreVal == null || scoreVal === JSONObject.NULL) null else {
            require(scoreVal is Number && scoreVal.toDouble().isFinite() && scoreVal.toDouble() in 0.0..10.0) {
                "目录论文分数超出范围：${binding.appearanceId}"
            }
            scoreVal.toDouble()
        }

        val conceptIds = row.getJSONArray("tagConceptIds").strings()
        val resolvedNodes = conceptIds.mapNotNull { taxonomy.nodes[it] }
        val tags = resolvedNodes.map { it.label }
        val primaryTaskNode = resolvedNodes.firstOrNull { it.facet == "task" }
        val primaryMethodNode = resolvedNodes.firstOrNull { it.facet == "method" }

        var initialVersion: String? = null
        var initialSourceUrl: String? = null
        var initialPdfUrl: String? = null
        var initialPdfSha: String? = null
        if (binding.identityStatus == "verified" && binding.sourceKind == "arxiv" && binding.sourceVersionId != null) {
            val svId = binding.sourceVersionId
            if ("@sha256:" in svId) {
                val shaPart = svId.substringAfter("@sha256:")
                require(SHA256_PATTERN.matches(shaPart)) { "sourceVersionId PDF SHA 非法：$svId" }
                initialPdfSha = shaPart
            } else if (svId.startsWith("arxiv:")) {
                val ver = svId.removePrefix("arxiv:")
                if (ARXIV_VERSION_SUFFIX_REGEX.containsMatchIn(ver)) {
                    initialVersion = ver
                    initialSourceUrl = "https://arxiv.org/abs/$ver"
                    initialPdfUrl = "https://arxiv.org/pdf/$ver.pdf"
                }
            }
        }

        // Reuse verified detail fields (including authors) ONLY when `detail.sha256` is unchanged!
        val verifiedPrev = previous?.takeIf {
            it.original?.optBoolean("desktopDetailVerified") == true &&
                it.original.optJSONObject("desktopDetail")?.optString("sha256") == binding.detail.sha256
        }
        val reusedAuthors = verifiedPrev?.authors ?: emptyList()
        if (verifiedPrev != null) {
            initialVersion = verifiedPrev.sourceVersion
            initialSourceUrl = verifiedPrev.sourceURL
            initialPdfUrl = verifiedPrev.pdfURL
            initialPdfSha = verifiedPrev.pdfSHA256
        }

        val tagRecord = JSONObject()
            .put("permalink", binding.blogURL)
            .put("pageType", "paper")
            .put("identityStatus", binding.identityStatus)
            .put("sourceKind", binding.sourceKind ?: "unknown")
            .put("paperId", binding.paperId ?: "")
            .put("title", title)
            .put("titleZh", titleZh)
            .put("summary", row.nullableString("summary") ?: "")
            .put("date", binding.blogPublishedAt ?: "")
            .put("score", score ?: JSONObject.NULL)
            .put("tags", JSONArray(tags))
            .put("task", primaryTaskNode?.label ?: "")
            .put("method", primaryMethodNode?.label ?: "")
        if (primaryTaskNode != null) tagRecord.put("primaryTaskId", primaryTaskNode.id)
        if (primaryMethodNode != null) tagRecord.put("primaryMethodId", primaryMethodNode.id)
        if (resolvedNodes.isNotEmpty() && resolvedNodes.size == conceptIds.size) {
            tagRecord.put("tagContract", ClientProtocols.contract("paper-tag-flat-tags"))
                .put("tagSchemaFingerprint", ClientProtocols.schemaFingerprint("paper-tag-flat-tags"))
                .put("tagCatalogSha256", tagRegistrySha)
                .put("tagConcepts", JSONArray(resolvedNodes.map { node ->
                    JSONObject().put("id", node.id).put("facet", node.facet).put("label", node.label)
                }))
        }

        val citationPlaceholder = ClientProtocols.record(CITATION_SOURCE_CONTRACT)
            .put("paperKey", binding.paperKey)
            .put("paperId", binding.paperId ?: "")
            .put("identityStatus", binding.identityStatus)
            .put("verified", binding.identityStatus == "verified")
            .put("complete", false)
            .put("sourceKind", binding.sourceKind ?: "")
            .put("title", title)
            .put("authors", JSONArray(reusedAuthors))
            .put("date", "")
            .put("doi", "")
            .put("venue", "")
            .put("arxivId", initialVersion ?: "")
            .put("url", initialSourceUrl ?: "")
            .put("sourceUrl", initialSourceUrl ?: "")
            .put("pdfUrl", initialPdfUrl ?: "")
            .put("pageUrl", binding.blogURL)
            .put("pageType", "paper")

        val appearanceMeta = JSONObject()
            .put("appearanceId", binding.appearanceId)
            .put("pageUrl", binding.pageUrl)
            .put("blogPublishedAt", binding.blogPublishedAt ?: JSONObject.NULL)
            .put("articleUpdatedAt", binding.articleUpdatedAt ?: JSONObject.NULL)
            .put("publicationStatus", binding.publicationStatus)
            .put("sourceVersionId", binding.sourceVersionId ?: JSONObject.NULL)
            .put("articleRevisionId", binding.articleRevisionId)
            .put("detail", binding.detail.json())

        val original = JSONObject()
            .put("desktopSnapshotID", snapshotId)
            .put("desktopSourceCommit", sourceCommit)
            .put("publicationStatus", binding.publicationStatus)
            .put("desktopPrimaryAppearanceId", binding.appearanceId)
            .put("desktopArticleRevisionId", binding.articleRevisionId)
            .put("desktopDetail", binding.detail.json())
            .put("desktopAppearances", JSONArray().put(appearanceMeta))
            .put("websiteTagRecords", JSONArray().put(tagRecord))
        if (verifiedPrev != null) {
            original.put("desktopDetailVerified", true)
        }

        return Paper(
            id = binding.paperKey,
            title = title,
            titleZh = titleZh,
            authors = reusedAuthors,
            date = binding.blogPublishedAt ?: "",
            score = score,
            task = primaryTaskNode?.label ?: "",
            method = primaryMethodNode?.label ?: "",
            tags = tags,
            sourceKind = binding.sourceKind ?: "unknown",
            identityStatus = binding.identityStatus,
            blogURL = binding.blogURL,
            sourceURL = initialSourceUrl,
            pdfURL = initialPdfUrl,
            sourceVersion = initialVersion,
            citation = verifiedPrev?.citation ?: citationPlaceholder,
            pdfSHA256 = initialPdfSha,
            appearances = listOf(binding.blogURL),
            original = original,
        )
    }

    private fun buildResearchContextFromDetail(detail: JSONObject): JSONObject {
        val titles = detail.getJSONObject("titles")
        val abstractText = detail.nullableString("abstract")
        return ClientProtocols.record("paper-research-context")
            .put("readerTitle", titles.nullableString("readerTitle") ?: titles.nullableString("displayTitle") ?: "")
            .put("oneSentenceThesis", detail.opt("oneSentenceThesis") ?: JSONObject.NULL)
            .put("abstract", abstractText ?: JSONObject.NULL)
            .put("abstractSha256", abstractText?.let { sha256(it.toByteArray(Charsets.UTF_8)) } ?: JSONObject.NULL)
            .put("assessment", detail.getJSONObject("assessment").copy())
    }

    private fun buildUpdatedTombstoneHistory(
        previousHistory: JSONObject,
        snapshotId: String,
        validationEpoch: String,
        sourceCommit: String,
        activeAppearances: Map<String, JSONObject>,
        currentTombstones: Map<String, JSONObject>,
    ): JSONObject {
        val oldTombstonesObj = previousHistory.optJSONObject("currentTombstones") ?: JSONObject()
        val oldEvents = previousHistory.optJSONArray("events")?.objects().orEmpty()
        val events = ArrayList<JSONObject>(oldEvents.map { it.copy() })
        val observedAt = now()

        val recordedKeys = HashSet<String>()
        events.forEach { ev ->
            recordedKeys += listOf(
                ev.optString("eventType"),
                ev.optString("appearanceId"),
                ev.optString("reason"),
                ev.optString("sourceCommit"),
                ev.optString("previousArticleRevisionId"),
                ev.optString("articleRevisionId"),
            ).joinToString("|")
        }

        for ((appId, tomb) in currentTombstones) {
            val key = listOf(
                "tombstone",
                appId,
                tomb.optString("reason"),
                tomb.optString("sourceCommit"),
                tomb.optString("previousArticleRevisionId"),
                "",
            ).joinToString("|")
            if (recordedKeys.add(key)) {
                events += tomb.copy()
                    .put("eventType", "tombstone")
                    .put("snapshotId", snapshotId)
                    .put("observedAt", observedAt)
            }
        }

        oldTombstonesObj.keys().forEach { oldAppId ->
            if (!currentTombstones.containsKey(oldAppId) && activeAppearances.containsKey(oldAppId)) {
                val activeRow = activeAppearances.getValue(oldAppId)
                val revId = activeRow.getString("articleRevisionId")
                val key = listOf("restored", oldAppId, "", sourceCommit, "", revId).joinToString("|")
                if (recordedKeys.add(key)) {
                    events += JSONObject()
                        .put("eventType", "restored")
                        .put("snapshotId", snapshotId)
                        .put("appearanceId", oldAppId)
                        .put("paperId", activeRow.opt("paperId") ?: JSONObject.NULL)
                        .put("articleRevisionId", revId)
                        .put("sourceCommit", sourceCommit)
                        .put("observedAt", observedAt)
                }
            }
        }

        val nextCurrent = JSONObject()
        currentTombstones.forEach { (appId, tomb) -> nextCurrent.put(appId, tomb.copy()) }
        return JSONObject()
            .put("format", TOMBSTONE_HISTORY_FORMAT)
            .put("version", 1)
            .put("latestSnapshotId", snapshotId)
            .put("validationEpoch", validationEpoch)
            .put("latestSourceCommit", sourceCommit)
            .put("currentTombstones", nextCurrent)
            .put("events", JSONArray(events))
    }

    private suspend fun stageImmutableBytes(
        permanentFile: File,
        stagedFile: File,
        relativeUrl: String,
        expectedBytes: Int,
        expectedSha256: String,
        maxBytes: Int,
        label: String,
    ): ByteArray {
        require(expectedBytes in 1..maxBytes && SHA256_PATTERN.matches(expectedSha256)) { "$label 描述长度或 SHA 非法" }
        if (Files.exists(permanentFile.toPath(), NOFOLLOW_LINKS)) {
            require(Files.isRegularFile(permanentFile.toPath(), NOFOLLOW_LINKS)) { "$label 本地缓存不是普通文件" }
            val cached = JsonFiles.read(permanentFile, maxBytes.toLong())
            require(cached.size == expectedBytes && sha256(cached) == expectedSha256) {
                "$label 本地已保存内容寻址文件长度或 SHA-256 已损坏"
            }
            return cached
        }
        val fullUrl = CatalogRepository.sameSite(URI(CatalogRepository.SITE).resolve(relativeUrl).toASCIIString())
        val fetched = readSite(fullUrl, maxBytes)
        require(fetched.size == expectedBytes && sha256(fetched) == expectedSha256) {
            "$label 实际字节数或 SHA-256 与声明不符，保留原完整快照"
        }
        JsonFiles.write(stagedFile, fetched)
        return fetched
    }

    private suspend fun readOrFetchContentAddressed(
        localFile: File,
        relativeUrl: String,
        expectedBytes: Int,
        expectedSha256: String,
        maxBytes: Int,
        offlineMode: Boolean,
        label: String,
    ): ByteArray {
        require(expectedBytes in 1..maxBytes && SHA256_PATTERN.matches(expectedSha256)) { "$label 描述非法" }
        if (Files.exists(localFile.toPath(), NOFOLLOW_LINKS)) {
            require(Files.isRegularFile(localFile.toPath(), NOFOLLOW_LINKS)) { "$label 本地缓存不是普通文件" }
            val cached = JsonFiles.read(localFile, maxBytes.toLong())
            require(cached.size == expectedBytes && sha256(cached) == expectedSha256) {
                "$label 本地缓存长度或 SHA-256 校验失败（文件已损坏或被篡改）"
            }
            return cached
        }
        require(!offlineMode) { "当前为离线模式，$label 尚未离线保存" }
        val fullUrl = CatalogRepository.sameSite(URI(CatalogRepository.SITE).resolve(relativeUrl).toASCIIString())
        val fetched = readSite(fullUrl, maxBytes)
        require(fetched.size == expectedBytes && sha256(fetched) == expectedSha256) {
            "$label 下载字节数或 SHA-256 校验失败"
        }
        JsonFiles.write(localFile, fetched)
        return fetched
    }

    private suspend fun readOrFetchAsset(
        localFile: File,
        relativeUrl: String,
        expectedBytes: Int,
        expectedSha256: String,
        offlineMode: Boolean,
        validator: (ByteArray) -> Unit = {},
    ): ByteArray {
        require(expectedBytes in 1..MAX_ASSET_BYTES && SHA256_PATTERN.matches(expectedSha256)) { "捆绑资源描述非法" }
        if (Files.exists(localFile.toPath(), NOFOLLOW_LINKS)) {
            require(Files.isRegularFile(localFile.toPath(), NOFOLLOW_LINKS)) { "本地资源缓存不是普通文件" }
            val cached = JsonFiles.read(localFile, MAX_ASSET_BYTES.toLong())
            require(cached.size == expectedBytes && sha256(cached) == expectedSha256) { "本地捆绑资源长度或 SHA-256 已损坏" }
            validator(cached)
            return cached
        }
        require(!offlineMode) { "离线模式下缺少未缓存捆绑资源" }
        val fullUrl = CatalogRepository.sameSite(URI(CatalogRepository.SITE).resolve(relativeUrl).toASCIIString())
        val fetched = readSite(fullUrl, MAX_ASSET_BYTES)
        require(fetched.size == expectedBytes && sha256(fetched) == expectedSha256) { "捆绑资源大小或 SHA-256 不符" }
        validator(fetched)
        JsonFiles.write(localFile, fetched)
        return fetched
    }

    private fun promoteStagedDirectory(stageDir: File, targetRoot: File) {
        stageDir.listFiles().orEmpty().forEach { sub ->
            if (!sub.isDirectory) return@forEach
            val destFolder = checkedChild(targetRoot, sub.name)
            destFolder.mkdirs()
            sub.listFiles().orEmpty().forEach { staged ->
                if (!staged.isFile) return@forEach
                val dest = checkedChild(destFolder, staged.name)
                val bytes = JsonFiles.read(staged, MAX_TAG_CATALOG_BYTES.toLong())
                if (Files.exists(dest.toPath(), NOFOLLOW_LINKS)) {
                    require(Files.isRegularFile(dest.toPath(), NOFOLLOW_LINKS)) { "目标内容寻址文件不是普通文件" }
                    require(JsonFiles.read(dest, MAX_TAG_CATALOG_BYTES.toLong()).contentEquals(bytes)) { "内容寻址文件字节冲突" }
                } else {
                    JsonFiles.write(dest, bytes)
                }
            }
        }
    }

    companion object {
        const val MANIFEST_PATH = "client/details/manifest.json"
        const val MANIFEST_CONTRACT = "paper-desktop-manifest"
        const val SNAPSHOT_CONTRACT = "paper-desktop-snapshot"
        const val DETAIL_CONTRACT = "paper-desktop-detail"
        const val CITATION_SOURCE_CONTRACT = "paper-citation-source"
        private const val ORIGINAL_CITATION_CONTRACT = "published-citation-original"

        const val MAX_MANIFEST_BYTES = 65_536
        const val MAX_SNAPSHOT_BYTES = 1_048_576
        const val MAX_SHARD_BYTES = 1_048_576
        const val MAX_SHARDS = 128
        const val MAX_TOTAL_CATALOG_BYTES = 67_108_864L
        const val MAX_DETAIL_BYTES = 2_097_152
        const val MAX_ARTICLE_BYTES = 16_777_216
        const val MAX_ASSET_BYTES = 16_777_216
        const val MAX_ARTICLE_RESOURCES = 512
        const val MAX_BUNDLED_ARTICLE_ASSETS_BYTES = 67_108_864L
        const val MAX_SIDECAR_BYTES = 524_288
        const val MAX_TAG_CATALOG_BYTES = 16_777_216

        private const val ACTIVE_STATE_FORMAT = "paperdigest-android-desktop-details-state"
        private const val TOMBSTONE_HISTORY_FORMAT = "paperdigest-android-desktop-tombstone-history"
        internal const val MACOS_STATE_CONTRACT = "paperdigest-macos-desktop-details-state"

        private val SHA256_PATTERN = Regex("^[a-f0-9]{64}$")
        private val COMMIT_OID_PATTERN = Regex("^[a-f0-9]{40}$")
        private val SAFE_EPOCH_PATTERN = Regex("^[A-Za-z0-9._-]{1,128}$")
        private val ARXIV_ID_PATTERN = Regex("^(?:[0-9]{4}\\.[0-9]{4,5}|[a-z-]+(?:\\.[A-Z]{2})?/[0-9]{7})$")
        private val CONFERENCE_PAPER_ID_PATTERN = Regex("^conference:[A-Za-z0-9._:-]+$")
        private val ARXIV_VERSION_SUFFIX_REGEX = Regex("v[1-9][0-9]*$")
        private val SNAPSHOT_URL_PATTERN = Regex("^client/details/snapshots/([a-f0-9]{64})\\.json$")
        private val CATALOG_SHARD_URL_PATTERN = Regex("^client/details/catalog/([a-f0-9]{64})\\.json$")
        private val TOMBSTONE_SHARD_URL_PATTERN = Regex("^client/details/tombstones/([a-f0-9]{64})\\.json$")
        private val DETAIL_URL_PATTERN = Regex("^client/details/papers/([a-f0-9]{64})\\.json$")
        private val ARTICLE_URL_PATTERN = Regex("^client/details/articles/([a-f0-9]{64})\\.html$")
        private val APPEARANCE_ID_PATTERN = Regex("^posts/[a-z0-9][a-z0-9._-]*/$")
        private val SAFE_RELATIVE_URL_PATTERN = Regex("^[A-Za-z0-9._/-]+$")
        private val ISO_TIMESTAMP_WITH_TZ_PATTERN = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$")

        private val FORBIDDEN_HTML_TAGS = setOf(
            "script", "style", "iframe", "frame", "frameset", "form", "input", "button",
            "select", "option", "optgroup", "textarea", "object", "embed", "applet",
            "base", "meta", "link", "template", "svg", "foreignobject", "xmp", "noscript",
            "noembed", "noframes", "plaintext", "title", "annotation-xml", "head", "html", "body",
        )
        private val RAW_FORBIDDEN_TAG_REGEX = Regex(
            "<!--|<\\?|<![a-zA-Z\\[]|<\\s*/?\\s*(?:script|style|iframe|frame|frameset|form|input|button|select|option|optgroup|textarea|object|embed|applet|base|meta|link|template|svg|foreignobject|xmp|noscript|noembed|noframes|plaintext|title|annotation-xml|html|head|body)\\b",
            RegexOption.IGNORE_CASE,
        )
        private val ALLOWED_SVG_TAGS = setOf(
            "svg", "g", "defs", "symbol", "clippath", "mask", "pattern",
            "lineargradient", "radialgradient", "stop",
            "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
            "text", "tspan", "title", "desc", "metadata", "marker", "use",
        )
        private val DATA_IMAGE_HEADER_REGEX = Regex("^data:image/(png|jpe?g|gif|webp|svg\\+xml)(?:;charset=utf-8)?(;base64)?$")
        private val ICASSP_PLACEHOLDER_REGEX = Regex("^icassp-img://[A-Za-z0-9._/-]+$")
        private val URL_ATTR_NAMES = setOf("href", "src", "srcset", "action", "formaction", "xlink:href", "poster", "data", "cite")
        private val SCHEME_PREFIX_REGEX = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*):")
        private val SAFE_SVG_ATTR_NAME_REGEX = Regex("^[a-z][a-z0-9_-]*$")
        private val SIDECAR_NAMES = setOf("citation.json", "citation.bib", "citation.ris", "rethink-context.json")

        fun parseManifest(raw: ByteArray, siteUrl: String): ParsedManifest {
            require(raw.size in 1..MAX_MANIFEST_BYTES) { "manifest.json 为空或超过 64 KiB 上限" }
            val manifestSha = sha256(raw)
            val text = PublishedUtf8.decode(raw)
            require(!text.contains(manifestSha)) { "manifest.json 禁止包含自身 SHA" }
            val obj = StrictJson.parseObjectText(text, MANIFEST_PATH)
            require(ClientProtocols.isCurrentHeader(obj, MANIFEST_CONTRACT)) {
                "manifest.json 合同或结构指纹未登记"
            }
            val schema = ClientProtocols.declaredSchema(
                obj.get("contract"),
                MANIFEST_CONTRACT,
                obj.opt("schemaFingerprint") as? String,
            )
            val expectedKeys = setOf("contract", "schemaFingerprint") + schema.getJSONArray("fields").strings()
            requireExactKeys(obj, expectedKeys, MANIFEST_PATH)

            val basePath = obj.getString("basePath")
            require(isAcceptedSiteBasePath(basePath, siteUrl)) {
                "manifest.basePath 与站点部署路径不一致：$basePath"
            }
            val generatedAt = obj.getString("generatedAt")
            requireIsoTimestampWithTz(generatedAt, "manifest.generatedAt")
            val sourceCommit = obj.getString("sourceCommit")
            require(COMMIT_OID_PATTERN.matches(sourceCommit)) { "manifest.sourceCommit 非法" }

            val snapshotId = obj.getString("snapshotId")
            require(SHA256_PATTERN.matches(snapshotId)) { "manifest.snapshotId 非法" }
            val snapObj = obj.getJSONObject("snapshot")
            requireExactKeys(snapObj, schema.getJSONArray("descriptorFields").strings().toSet(), "manifest.snapshot")
            val snapUrl = snapObj.getString("url")
            val snapSha = snapObj.getString("sha256")
            val snapBytes = strictInt(snapObj, "bytes", allowZero = false)
            require(
                snapSha == snapshotId &&
                    snapUrl == "client/details/snapshots/$snapshotId.json" &&
                    SNAPSHOT_URL_PATTERN.matches(snapUrl) &&
                    snapBytes <= MAX_SNAPSHOT_BYTES
            ) { "manifest.snapshot 描述符非法或与 snapshotId 不一致" }

            val snapshotFormat = schema.getJSONObject("snapshotFormat")
            return ParsedManifest(
                snapshotId = snapshotId,
                snapshot = FileDescriptor(snapUrl, snapBytes, snapSha),
                generatedAt = generatedAt,
                sourceCommit = sourceCommit,
                basePath = basePath,
                snapshotContract = snapshotFormat.getString("contract"),
                snapshotSchemaFingerprint = snapshotFormat.getString("schemaFingerprint"),
            )
        }

        internal fun isAcceptedSiteBasePath(basePath: String, siteUrl: String): Boolean {
            if (!basePath.startsWith("/") || !basePath.endsWith("/")) return false
            val uri = runCatching { URI(siteUrl) }.getOrNull() ?: return false
            val raw = uri.rawPath.orEmpty()
            val expected = if (raw.endsWith("/")) raw else "$raw/"
            if (basePath == expected) return true
            return uri.host?.equals("nanless.github.io", ignoreCase = true) == true &&
                expected == "/audio-research-portal/" &&
                basePath == "/audio-paper-digest-blog/"
        }

        internal fun verifyAndSanitizeArticleHtml(raw: ByteArray, blogURL: String): SanitizedArticleHtml {
            require(raw.size in 1..MAX_ARTICLE_BYTES) { "导读 HTML 为空或超过 16 MiB 上限" }
            val html = PublishedUtf8.decode(raw)
            require(!RAW_FORBIDDEN_TAG_REGEX.containsMatchIn(html)) {
                "导读 HTML 含禁止的执行、注释、RAWTEXT、表单或框架标记"
            }
            val doc = Jsoup.parseBodyFragment(html, blogURL)
            doc.outputSettings().prettyPrint(false)
            val body = doc.body()
            rejectForbiddenNodes(body)

            val validatedDataImgs = IdentityHashMap<Element, Pair<String, ByteArray>>()
            val icasspImgs = IdentityHashMap<Element, String>()

            for (el in body.allElements) {
                if (el === body) continue
                val tag = el.normalName()
                require(tag !in FORBIDDEN_HTML_TAGS) { "导读 HTML 含禁止标签：<$tag>" }
                for (attr in el.attributes().asList()) {
                    val key = attr.key.lowercase()
                    require(!key.startsWith("on") && key != "srcdoc" && key != "formaction") {
                        "导读 HTML 含禁止的事件或执行属性：$key"
                    }
                    if (key == "srcset") {
                        validateSrcsetAttribute(attr.value, tag)
                    } else if (key in URL_ATTR_NAMES) {
                        val special = validatePositiveUrlAttribute(
                            rawValue = attr.value,
                            tag = tag,
                            attrKey = key,
                            allowDataImage = tag == "img" && key == "src",
                            allowMailto = tag == "a" && key == "href",
                            allowIcasspPlaceholder = tag == "img" && key == "src",
                        )
                        if (special != null && tag == "img" && key == "src") {
                            if (special.first.startsWith("data:image/")) validatedDataImgs[el] = special.first to special.second!!
                            else if (special.first.startsWith("icassp-img://")) icasspImgs[el] = special.first
                        }
                    }
                }
            }

            // Unwrap harmless structural wrappers (<section>, <article>, <main>, <del>, <ins>, <picture>) before strict allowlist sanitization
            body.select("section, article, main, del, ins, picture").toList().forEach { wrapper -> wrapper.unwrap() }
            CatalogRepository.sanitizeHtmlFragment(body, blogURL)

            val imgOriginalSources = IdentityHashMap<Element, String>()
            val inlineDataBytesByElement = IdentityHashMap<Element, ByteArray>()
            for (img in body.select("img")) {
                val validatedData = validatedDataImgs[img]
                val icassp = icasspImgs[img]
                if (validatedData != null) {
                    img.attr("src", validatedData.first)
                    imgOriginalSources[img] = validatedData.first
                    inlineDataBytesByElement[img] = validatedData.second
                } else if (icassp != null) {
                    img.removeAttr("src")
                    imgOriginalSources[img] = icassp
                } else {
                    val sanitizedSrc = img.attr("src")
                    if (sanitizedSrc.isNotEmpty()) imgOriginalSources[img] = sanitizedSrc
                }
            }
            return SanitizedArticleHtml(body, imgOriginalSources, inlineDataBytesByElement)
        }

        private fun rejectForbiddenNodes(node: Node) {
            require(node !is Comment && node !is DataNode && node !is XmlDeclaration && node !is DocumentType) {
                "导读 HTML 禁止包含注释或声明节点"
            }
            node.childNodes().forEach(::rejectForbiddenNodes)
        }

        private fun validateSrcsetAttribute(rawSrcset: String, tag: String) {
            require(rawSrcset.none { (it.code < 0x20 && it !in "\t\r\n") || it.code == 0x7F }) { "srcset 含控制字符" }
            // `data:` is strictly forbidden in srcset, so commas unambiguously separate candidates.
            val candidates = rawSrcset.split(',')
            require(candidates.isNotEmpty()) { "srcset 为空" }
            for (entry in candidates) {
                val trimmed = entry.trim()
                if (trimmed.isEmpty()) continue
                val urlPart = trimmed.split(Regex("\\s+"), limit = 2).first()
                validatePositiveUrlAttribute(
                    rawValue = urlPart,
                    tag = tag,
                    attrKey = "srcset",
                    allowDataImage = false,
                    allowMailto = false,
                    allowIcasspPlaceholder = false,
                )
            }
        }

        /**
         * Positive URL scheme allowlist:
         * - `https://` and `http://`
         * - `mailto:` (ONLY on `a[href]`)
         * - validated static `data:image/(png|jpeg|gif|webp|svg+xml)` (ONLY on `img[src]`)
         * - `icassp-img://` placeholder (ONLY on `img[src]`)
         * - non-`//`, non-`\`, scheme-free relative or `#fragment` URLs
         * Everything else (`zotero:`, `smb:`, `file:`, `javascript:`, `vbscript:`, `//evil`, etc.) fails closed!
         */
        private fun validatePositiveUrlAttribute(
            rawValue: String,
            tag: String,
            attrKey: String,
            allowDataImage: Boolean,
            allowMailto: Boolean,
            allowIcasspPlaceholder: Boolean,
        ): Pair<String, ByteArray?>? {
            require(rawValue.none { (it.code < 0x20 && it !in "\t\r\n") || it.code == 0x7F }) {
                "导读 HTML 地址属性含非法控制字符"
            }
            val trimmed = rawValue.trim()
            if (trimmed.isEmpty()) return null
            val compact = rawValue.filter { it.code > 0x20 }
            require(!compact.startsWith("//") && !trimmed.startsWith("//") && '\\' !in compact) {
                "导读 HTML 禁止协议相对 (//) 或反斜杠地址"
            }

            val schemeMatch = SCHEME_PREFIX_REGEX.find(compact)
            if (schemeMatch == null) {
                val beforeSlash = compact.substringBefore('/').substringBefore('?').substringBefore('#')
                require(':' !in beforeSlash) { "导读 HTML 含未识别的冒号协议前缀" }
                return null
            }

            val scheme = schemeMatch.groupValues[1].lowercase()
            return when (scheme) {
                "https", "http" -> {
                    require(trimmed.lowercase().startsWith("$scheme://") && compact.lowercase().startsWith("$scheme://")) {
                        "导读 HTML $scheme 地址缺少规范主机前缀"
                    }
                    null
                }
                "mailto" -> {
                    require(allowMailto && trimmed.lowercase().startsWith("mailto:") && !trimmed.substring(7).startsWith("//")) {
                        "mailto: 仅允许出现在安全的 a[href] 链接中"
                    }
                    null
                }
                "icassp-img" -> {
                    require(allowIcasspPlaceholder && ICASSP_PLACEHOLDER_REGEX.matches(trimmed)) {
                        "icassp-img: 占位地址仅允许出现在 img[src] 中"
                    }
                    trimmed to null
                }
                "data" -> {
                    require(allowDataImage && trimmed.lowercase().startsWith("data:image/")) {
                        "导读 HTML 禁止非 img[src] 或非静态图片的 data: URL"
                    }
                    val decoded = decodeAndValidateInlineDataImage(trimmed)
                    trimmed to decoded
                }
                else -> error("导读 HTML 含未授权 URL 协议：$scheme:")
            }
        }

        private fun decodeAndValidateInlineDataImage(dataUri: String): ByteArray {
            require(dataUri.length <= 8 * 1024 * 1024 && dataUri.none { it.code <= 0x20 || it.code == 0x7F }) {
                "内联 data:image 大小越界或含空白/控制字符"
            }
            val comma = dataUri.indexOf(',')
            require(comma in 11 until dataUri.length) { "内联 data:image 格式无效" }
            val header = dataUri.substring(0, comma).lowercase()
            val headerMatch = DATA_IMAGE_HEADER_REGEX.matchEntire(header)
                ?: error("内联 data:image 媒体类型不受支持：$header")
            val subtype = headerMatch.groupValues[1]
            val normalizedSubtype = if (subtype == "jpg") "jpeg" else subtype
            val isBase64 = headerMatch.groupValues[2] == ";base64"
            val payload = dataUri.substring(comma + 1)
            require(payload.isNotEmpty()) { "内联 data:image 内容为空" }

            val decoded = if (isBase64) {
                java.util.Base64.getDecoder().decode(payload)
            } else {
                strictPercentDecode(payload)
            }
            require(decoded.size in 1..MAX_ASSET_BYTES) { "内联图片解码字节越界" }

            if (normalizedSubtype == "svg+xml") {
                validateSafeStaticSvgBytes(decoded)
            }
            val actualMime = CatalogRepository.imageMime(decoded)
            require(actualMime == "image/$normalizedSubtype") { "内联图片实际类型 ($actualMime) 与声明 (image/$normalizedSubtype) 不符" }
            return decoded
        }

        private fun strictPercentDecode(encoded: String): ByteArray {
            val out = ByteArrayOutputStream(encoded.length)
            var i = 0
            while (i < encoded.length) {
                val c = encoded[i++]
                if (c == '%') {
                    require(i + 2 <= encoded.length) { "data: URL 百分号编码截断" }
                    val hi = asciiHexDigit(encoded[i++])
                    val lo = asciiHexDigit(encoded[i++])
                    require(hi >= 0 && lo >= 0) { "data: URL 百分号编码含非十六进制字符" }
                    out.write((hi shl 4) or lo)
                } else {
                    require(c.code in 0x21..0x7E) { "非 base64 data: URL 含未编码字符" }
                    out.write(c.code)
                }
            }
            return out.toByteArray()
        }

        private val SAFE_SVG_FRAGMENT_URL_CALL_REGEX = Regex(
            "url\\s*\\(\\s*(?:'\\s*#[A-Za-z_][A-Za-z0-9_.-]*\\s*'|\"\\s*#[A-Za-z_][A-Za-z0-9_.-]*\\s*\"|#[A-Za-z_][A-Za-z0-9_.-]*)\\s*\\)",
            RegexOption.IGNORE_CASE,
        )
        private const val UNSAFE_SVG_URL_LOOKAHEAD =
            "url\\s*\\((?!\\s*(?:'\\s*#[A-Za-z_][A-Za-z0-9_.-]*\\s*'|\"\\s*#[A-Za-z_][A-Za-z0-9_.-]*\\s*\"|#[A-Za-z_][A-Za-z0-9_.-]*)\\s*\\))"

        internal fun verifyDesktopImageBytes(bytes: ByteArray): String {
            val mime = CatalogRepository.imageMime(bytes)
            if (mime == "image/svg+xml") {
                validateSafeStaticSvgBytes(bytes)
            }
            return mime
        }

        internal fun validateSafeStaticSvgBytes(bytes: ByteArray) {
            val svgText = PublishedUtf8.decode(bytes)
            require(svgText.none { (it.code < 0x20 && it !in "\t\r\n") || it.code == 0x7F }) { "SVG 含非法控制字符" }
            require(!Regex("<!--|<\\?|<!", RegexOption.IGNORE_CASE).containsMatchIn(svgText)) {
                "SVG 禁止包含注释、XML 声明或 DOCTYPE/ENTITY"
            }
            val unescaped = Parser.unescapeEntities(svgText, false)
            require(!Regex("<!--|<\\?|<!|\\bon[a-z]+\\s*=|image-set\\s*\\(|$UNSAFE_SVG_URL_LOOKAHEAD", RegexOption.IGNORE_CASE).containsMatchIn(unescaped)) {
                "SVG 含事件属性、实体混淆或外部 url()/image-set() 引用"
            }

            val xmlDoc = Jsoup.parse(svgText, "", Parser.xmlParser())
            rejectForbiddenNodes(xmlDoc)
            val rootElements = xmlDoc.children()
            require(rootElements.size == 1 && rootElements.single().tagName().lowercase() == "svg") { "SVG 根节点必须为单一 <svg>" }
            for (el in xmlDoc.allElements) {
                if (el === xmlDoc) continue
                val tag = el.tagName().lowercase()
                require(tag in ALLOWED_SVG_TAGS) { "SVG 含禁止标签（如动画/脚本/外部对象）：<$tag>" }
                for (attr in el.attributes().asList()) {
                    val key = attr.key.lowercase()
                    val valUnescaped = Parser.unescapeEntities(attr.value, true).trim()
                    val valCompact = valUnescaped.filter { it.code > 0x20 }
                    require(!key.startsWith("on")) { "SVG 含禁止事件属性：$key" }
                    if (key == "xmlns") {
                        require(valUnescaped == "http://www.w3.org/2000/svg") { "SVG xmlns 非法：$valUnescaped" }
                    } else if (key == "xmlns:xlink") {
                        require(valUnescaped == "http://www.w3.org/1999/xlink") { "SVG xmlns:xlink 非法：$valUnescaped" }
                    } else if (key == "href" || key == "xlink:href") {
                        require(valCompact.matches(Regex("^#[A-Za-z_][A-Za-z0-9_.-]*$"))) { "SVG href 仅允许文档内规范 #fragment 引用" }
                    } else if (key == "style") {
                        // Reject CSS comments outright so quote-vs-comment desynchronization cannot smuggle declarations.
                        require("/*" !in valUnescaped && "*/" !in valUnescaped) { "SVG style 禁止包含 CSS 注释" }
                        require(
                            !Regex(
                                "$UNSAFE_SVG_URL_LOOKAHEAD|image-set\\s*\\(|@import|expression\\s*\\(|-moz-binding|behavior\\s*:|(?:javascript|vbscript|data|https?|file|zotero|smb)\\s*:|//|\\\\",
                                RegexOption.IGNORE_CASE,
                            ).containsMatchIn(valUnescaped)
                        ) {
                            "SVG style 含外部协议或动态表达式"
                        }
                    } else {
                        require(SAFE_SVG_ATTR_NAME_REGEX.matches(key)) { "SVG 含未授权命名空间属性：$key" }
                        val cleanedAttr = SAFE_SVG_FRAGMENT_URL_CALL_REGEX.replace(valUnescaped, "none")
                        val cleanedCompact = cleanedAttr.filter { it.code > 0x20 }
                        val lowerCompact = cleanedCompact.lowercase()
                        require(
                            !lowerCompact.contains("url(") &&
                                !lowerCompact.contains("image-set(") &&
                                !cleanedCompact.contains("//") &&
                                '\\' !in cleanedCompact &&
                                !SCHEME_PREFIX_REGEX.containsMatchIn(cleanedCompact)
                        ) {
                            "SVG 属性禁止包含外部 url() 或协议引用：$key"
                        }
                    }
                }
            }
        }

        internal fun asciiHexDigit(c: Char): Int = when (c) {
            in '0'..'9' -> c - '0'
            in 'a'..'f' -> c - 'a' + 10
            in 'A'..'F' -> c - 'A' + 10
            else -> -1
        }

        private fun emptyTombstoneHistory(): JSONObject = JSONObject()
            .put("format", TOMBSTONE_HISTORY_FORMAT)
            .put("version", 1)
            .put("latestSnapshotId", JSONObject.NULL)
            .put("validationEpoch", JSONObject.NULL)
            .put("latestSourceCommit", JSONObject.NULL)
            .put("currentTombstones", JSONObject())
            .put("events", JSONArray())

        private fun compareBindingRecency(a: AppearanceBinding, b: AppearanceBinding): Int {
            val dateCmp = (a.blogPublishedAt ?: "").compareTo(b.blogPublishedAt ?: "")
            if (dateCmp != 0) return dateCmp
            val updCmp = (a.articleUpdatedAt ?: "").compareTo(b.articleUpdatedAt ?: "")
            if (updCmp != 0) return updCmp
            return a.appearanceId.compareTo(b.appearanceId)
        }

        private fun requireExactKeys(obj: JSONObject, expected: Set<String>, label: String) {
            val actual = obj.keys().asSequence().toSet()
            require(actual == expected) { "$label 字段集合不匹配" }
        }

        private fun strictInt(obj: JSONObject, key: String, allowZero: Boolean): Int {
            require(obj.has(key) && !obj.isNull(key)) { "缺少整数字段：$key" }
            val raw = obj.get(key)
            require(raw is Int || raw is Long) { "字段 $key 必须为安全整数" }
            val value = (raw as Number).toLong()
            require(value <= Int.MAX_VALUE && (if (allowZero) value >= 0L else value > 0L)) { "字段 $key 数值越界：$value" }
            return value.toInt()
        }

        private fun requireSafeRelativePath(path: String, label: String): String {
            require(
                path.isNotEmpty() &&
                    !path.startsWith("/") &&
                    !path.endsWith("/") &&
                    !path.contains("//") &&
                    SAFE_RELATIVE_URL_PATTERN.matches(path) &&
                    path.split('/').none { it.isEmpty() || it == "." || it == ".." }
            ) { "$label 相对路径非法：$path" }
            CatalogRepository.sameSite(URI(CatalogRepository.SITE).resolve(path).toASCIIString())
            return path
        }

        private fun requireIsoTimestampWithTz(value: String, label: String) {
            require(ISO_TIMESTAMP_WITH_TZ_PATTERN.matches(value)) { "$label 时间格式非法：$value" }
            OffsetDateTime.parse(value)
        }

        private fun isValidHttpsUrl(value: String?): Boolean {
            if (value.isNullOrBlank()) return false
            return runCatching {
                val u = URI(value)
                u.scheme == "https" && !u.host.isNullOrBlank() && u.userInfo == null && (u.port == -1 || u.port == 443)
            }.getOrDefault(false)
        }

        private fun cleanHttps(value: String?): String? = value?.takeIf(::isValidHttpsUrl)

        private fun resolveResourceSourceUrl(raw: String, blogURL: String): String? = runCatching {
            val trimmed = raw.trim()
            if (trimmed.startsWith("//") || '\\' in trimmed) return@runCatching null
            val resolved = URI(blogURL).resolve(trimmed).toASCIIString()
            if (URI(resolved).host == "nanless.github.io") CatalogRepository.sameSite(resolved) else cleanHttps(resolved)
        }.getOrNull()

        internal fun checkedChild(parent: File, vararg segments: String): File {
            var ancestor: File? = parent.absoluteFile
            while (ancestor != null) {
                require(!Files.isSymbolicLink(ancestor.toPath())) { "桌面缓存祖先路径禁止符号链接" }
                ancestor = ancestor.parentFile
            }
            var cur = parent
            for (seg in segments) {
                require(seg.isNotEmpty() && seg != "." && seg != ".." && '/' !in seg && '\\' !in seg && '\u0000' !in seg) {
                    "本地路径段非法：$seg"
                }
                cur = File(cur, seg)
                require(!Files.isSymbolicLink(cur.toPath())) { "桌面缓存路径禁止符号链接" }
            }
            return cur
        }
    }

    /** Strict RFC 8259 UTF-8 JSON parser rejecting duplicate keys, non-ASCII hex escapes, non-finite numbers, and trailing tokens. */
    internal class StrictJson private constructor(private val text: String, private val label: String) {
        private var i = 0
        private var nodes = 0

        private fun ws() {
            while (i < text.length && text[i] in " \t\r\n") i++
        }

        private fun expect(c: Char) {
            ws()
            require(i < text.length && text[i++] == c) { "$label JSON 格式无效" }
        }

        private fun string(): String {
            expect('"')
            val out = StringBuilder()
            while (i < text.length) {
                val c = text[i++]
                if (c == '"') return out.toString()
                require(c >= ' ') { "$label JSON 字符串含未转义控制字符" }
                if (c != '\\') {
                    require(!c.isSurrogate() || (c.isHighSurrogate() && i < text.length && text[i].isLowSurrogate())) {
                        "$label JSON 字符串含非法代理对"
                    }
                    out.append(c)
                    if (c.isHighSurrogate()) out.append(text[i++])
                    continue
                }
                require(i < text.length) { "$label JSON 转义未结束" }
                when (val esc = text[i++]) {
                    '"', '\\', '/' -> out.append(esc)
                    'b' -> out.append('\b')
                    'f' -> out.append('\u000c')
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'u' -> {
                        fun hex4(): Char {
                            require(i + 4 <= text.length) { "$label Unicode 转义截断" }
                            var v = 0
                            repeat(4) {
                                val digit = asciiHexDigit(text[i++])
                                require(digit >= 0) { "$label Unicode 转义仅允许 ASCII [0-9a-fA-F]" }
                                v = (v shl 4) or digit
                            }
                            return v.toChar()
                        }
                        val first = hex4()
                        if (first.isHighSurrogate()) {
                            require(i + 2 <= text.length && text.startsWith("\\u", i)) { "$label 缺少低代理项" }
                            i += 2
                            val second = hex4()
                            require(second.isLowSurrogate()) { "$label 低代理项非法" }
                            out.append(first).append(second)
                        } else {
                            require(!first.isLowSurrogate()) { "$label 孤立低代理项非法" }
                            out.append(first)
                        }
                    }
                    else -> error("$label 不支持的转义序列")
                }
            }
            error("$label JSON 字符串未闭合")
        }

        private fun value(depth: Int): Any {
            require(depth <= 64 && ++nodes <= 2_000_000) { "$label JSON 结构超过安全范围" }
            ws()
            require(i < text.length) { "$label JSON 意外结束" }
            return when (text[i]) {
                '{' -> {
                    i++
                    val obj = JSONObject()
                    ws()
                    if (i < text.length && text[i] == '}') {
                        i++
                        obj
                    } else {
                        while (true) {
                            val key = string()
                            require(!obj.has(key)) { "$label JSON 含重复键：$key" }
                            expect(':')
                            obj.put(key, value(depth + 1))
                            ws()
                            require(i < text.length) { "$label JSON 对象未闭合" }
                            if (text[i] == '}') {
                                i++
                                break
                            }
                            expect(',')
                        }
                        obj
                    }
                }
                '[' -> {
                    i++
                    val arr = JSONArray()
                    ws()
                    if (i < text.length && text[i] == ']') {
                        i++
                        arr
                    } else {
                        while (true) {
                            arr.put(value(depth + 1))
                            ws()
                            require(i < text.length) { "$label JSON 数组未闭合" }
                            if (text[i] == ']') {
                                i++
                                break
                            }
                            expect(',')
                        }
                        arr
                    }
                }
                '"' -> string()
                't' -> {
                    require(text.startsWith("true", i)) { "$label JSON 布尔值非法" }
                    i += 4
                    true
                }
                'f' -> {
                    require(text.startsWith("false", i)) { "$label JSON 布尔值非法" }
                    i += 5
                    false
                }
                'n' -> {
                    require(text.startsWith("null", i)) { "$label JSON null 非法" }
                    i += 4
                    JSONObject.NULL
                }
                else -> {
                    val match = NUMBER_REGEX.find(text, i)
                    require(match != null && match.range.first == i) { "$label JSON 数值格式非法" }
                    val token = match.value
                    i = match.range.last + 1
                    parseStrictNumberToken(token, label)
                }
            }
        }

        companion object {
            internal val NUMBER_REGEX = Regex("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")

            internal fun parseStrictNumberToken(token: String, label: String): Number {
                if ('.' in token || 'e' in token || 'E' in token) {
                    val d = token.toDouble()
                    require(d.isFinite()) { "$label JSON 非有限数非法" }
                    return d
                }
                if (token == "-0") return 0
                val l = token.toLongOrNull() ?: error("$label JSON 整数超出安全范围")
                require(l in -9_007_199_254_740_991L..9_007_199_254_740_991L) { "$label JSON 整数超出安全范围" }
                return if (l in Int.MIN_VALUE..Int.MAX_VALUE) l.toInt() else l
            }

            fun parseObject(raw: ByteArray, label: String): JSONObject =
                parseObjectText(PublishedUtf8.decode(raw), label)

            fun parseObjectText(text: String, label: String): JSONObject {
                val p = StrictJson(text, label)
                val v = p.value(0)
                p.ws()
                require(p.i == text.length && v is JSONObject) { "$label 不是合法 JSON 对象或含尾随内容" }
                return v
            }

            fun parseArray(raw: ByteArray, label: String): JSONArray {
                val text = PublishedUtf8.decode(raw)
                val p = StrictJson(text, label)
                val v = p.value(0)
                p.ws()
                require(p.i == text.length && v is JSONArray) { "$label 不是合法 JSON 数组或含尾随内容" }
                return v
            }
        }
    }
}
