package com.nanless.paperdigest.data

import com.nanless.paperdigest.protocols.ClientProtocols
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI

data class ResourceBadgeSignals(
    val hasCode: Boolean = false,
    val hasModel: Boolean = false,
    val hasDataset: Boolean = false,
    val hasDemo: Boolean = false,
    val hasProjectPage: Boolean = false,
    val codeUrls: List<String> = emptyList(),
    val demoUrls: List<String> = emptyList(),
    val projectUrls: List<String> = emptyList(),
) {
    val hasAny: Boolean get() = hasCode || hasModel || hasDataset || hasDemo || hasProjectPage
}

data class ResourceBadgesResult(
    val available: Boolean,
    val papers: Map<String, ResourceBadgeSignals>,
    val cachedDemoIds: Set<String>,
)

/**
 * Tier 1 local `.audio-demo-cta-btn` scan + Tier 2 optional `client/signals/resource-badges.json`
 * (HTTP 404/410 silent-graceful, HTTP 200 fail-closed). Never called inside CatalogRepository.sync().
 */
class ResourceBadgesRepository(
    private val publishedLibraryDir: File,
    private val transport: (suspend (String, Int) -> HttpBytes)? = null,
) {
    private val publishedHttp by lazy { SafeHttp.publishedSite() }
    private val loadMutex = Mutex()
    @Volatile private var loaded: Boolean = false
    @Volatile private var cachedSignals: Map<String, ResourceBadgeSignals>? = null

    fun scanCachedAudioDemoPaperIds(): Set<String> {
        val hits = linkedSetOf<String>()
        val articlesDir = File(publishedLibraryDir, "articles")
        articlesDir.listFiles()?.filter { it.isFile && it.name.endsWith(".json") }?.forEach { file ->
            if (file.length() > 32L * 1024L * 1024L) return@forEach
            val raw = runCatching { file.readText(Charsets.UTF_8) }.getOrNull() ?: return@forEach
            if (!raw.contains("audio-demo-cta-btn")) return@forEach
            val pid = runCatching { JSONObject(raw).nullableString("paperID") }.getOrNull().orEmpty()
            if (pid.isNotEmpty()) hits.add(pid)
        }
        val desktopArticlesDir = File(publishedLibraryDir, "desktop-details/articles")
        val desktopPapersDir = File(publishedLibraryDir, "desktop-details/papers")
        if (desktopArticlesDir.isDirectory && desktopPapersDir.isDirectory) {
            val demoArticleShas = hashSetOf<String>()
            desktopArticlesDir.listFiles()?.filter { it.isFile && it.name.endsWith(".html") }?.forEach { htmlFile ->
                if (htmlFile.length() > 16L * 1024L * 1024L) return@forEach
                val raw = runCatching { htmlFile.readText(Charsets.UTF_8) }.getOrNull() ?: return@forEach
                if (raw.contains("audio-demo-cta-btn")) {
                    demoArticleShas.add(htmlFile.name.removeSuffix(".html"))
                }
            }
            if (demoArticleShas.isNotEmpty()) {
                desktopPapersDir.listFiles()?.filter { it.isFile && it.name.endsWith(".json") }?.forEach { detailFile ->
                    if (detailFile.length() > 2L * 1024L * 1024L) return@forEach
                    val obj = runCatching { JSONObject(detailFile.readText(Charsets.UTF_8)) }.getOrNull() ?: return@forEach
                    val articleSha = obj.optJSONObject("articleRevision")
                        ?.optJSONObject("articleDescriptor")
                        ?.nullableString("sha256")
                        .orEmpty()
                    val pid = obj.nullableString("paperId")?.takeIf { it.isNotBlank() }
                        ?: obj.nullableString("appearanceId")?.takeIf { it.isNotBlank() }?.let { raw ->
                            runCatching { "page:" + URI(CatalogRepository.sameSite(raw)).path }.getOrNull()
                        }
                        ?: ""
                    if (articleSha in demoArticleShas && pid.isNotEmpty()) hits.add(pid)
                }
            }
        }
        return hits
    }

    suspend fun load(forceRefresh: Boolean = false, offlineMode: Boolean = false): ResourceBadgesResult = loadMutex.withLock {
        val demoIds = scanCachedAudioDemoPaperIds()
        if (offlineMode || (!forceRefresh && loaded)) {
            return@withLock ResourceBadgesResult(
                available = cachedSignals != null,
                papers = cachedSignals.orEmpty(),
                cachedDemoIds = demoIds,
            )
        }
        val url = CatalogRepository.sameSite("client/signals/resource-badges.json")
        val response = try {
            if (transport != null) {
                transport.invoke(url, MAX_INDEX_BYTES)
            } else {
                publishedHttp.execute(Request.Builder().url(url).header("Cache-Control", "no-cache").get().build(), MAX_INDEX_BYTES)
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (invalid: IllegalArgumentException) {
            throw invalid
        } catch (_: Exception) {
            // Optional Tier 2 network / transport error: preserve prior cachedSignals,
            // do not mark Tier 2 loaded, and still return Tier 1 local cachedDemoIds.
            return@withLock ResourceBadgesResult(
                available = cachedSignals != null,
                papers = cachedSignals.orEmpty(),
                cachedDemoIds = demoIds,
            )
        }
        if (response.code == 404 || response.code == 410) {
            cachedSignals = null
            loaded = true
            return@withLock ResourceBadgesResult(available = false, papers = emptyMap(), cachedDemoIds = demoIds)
        }
        if (response.code != 200) {
            // Transient non-404/410 HTTP error: preserve prior cachedSignals and Tier 1 cachedDemoIds.
            return@withLock ResourceBadgesResult(
                available = cachedSignals != null,
                papers = cachedSignals.orEmpty(),
                cachedDemoIds = demoIds,
            )
        }
        val parsed = parseIndex(response.bytes)
        cachedSignals = parsed
        loaded = true
        return@withLock ResourceBadgesResult(available = true, papers = parsed, cachedDemoIds = demoIds)
    }

    companion object {
        const val MAX_INDEX_BYTES = 8 * 1024 * 1024
        private val ALLOWED_ROOT_KEYS = setOf("contract", "schemaFingerprint", "generatedAt", "papers")
        private val ALLOWED_ENTRY_KEYS = setOf(
            "hasCode", "hasModel", "hasDataset", "hasDemo", "hasProjectPage",
            "codeUrls", "demoUrls", "projectUrls",
        )
        private val DANGEROUS_KEYS = setOf("__proto__", "constructor", "prototype")

        fun parseIndex(rawBytes: ByteArray): Map<String, ResourceBadgeSignals> {
            require(rawBytes.size <= MAX_INDEX_BYTES) { "开源与资源信号索引超过 8 MiB 上限。" }
            val root = runCatching { JSONObject(rawBytes.toString(Charsets.UTF_8)) }.getOrNull()
                ?: throw IllegalArgumentException("开源与资源信号索引不是有效 JSON 对象。")
            require(ClientProtocols.isCurrentHeader(root, "paper-resource-badges-index")) {
                "开源与资源信号索引协议头或 schemaFingerprint 无效。"
            }
            require(root.keys().asSequence().all { it in ALLOWED_ROOT_KEYS }) {
                "开源与资源信号索引包含未声明顶层字段。"
            }
            val rawGeneratedAt = if (root.has("generatedAt") && !root.isNull("generatedAt")) root.opt("generatedAt") else null
            require(rawGeneratedAt is String && rawGeneratedAt.trim().isNotEmpty()) {
                "开源与资源信号索引缺少有效 generatedAt。"
            }
            val papersObj = root.opt("papers") as? JSONObject
                ?: throw IllegalArgumentException("开源与资源信号索引缺少 papers 对象。")
            val result = LinkedHashMap<String, ResourceBadgeSignals>(papersObj.length())
            val keys = papersObj.keys()
            while (keys.hasNext()) {
                val paperId = keys.next()
                require(paperId.isNotEmpty() && paperId !in DANGEROUS_KEYS) {
                    "开源与资源信号条目键无效或包含危险键：$paperId"
                }
                val entry = papersObj.opt(paperId) as? JSONObject
                    ?: throw IllegalArgumentException("开源与资源信号条目不是对象：$paperId")
                require(entry.keys().asSequence().all { it in ALLOWED_ENTRY_KEYS }) {
                    "开源与资源信号条目包含未声明字段：$paperId"
                }

                fun boolField(name: String): Boolean {
                    if (!entry.has(name) || entry.isNull(name)) return false
                    val value = entry.get(name)
                    require(value is Boolean) { "开源与资源信号布尔字段无效：$paperId.$name" }
                    return value
                }

                fun httpsUrls(name: String): List<String> {
                    if (!entry.has(name) || entry.isNull(name)) return emptyList()
                    val arr = entry.opt(name) as? JSONArray
                        ?: throw IllegalArgumentException("开源与资源信号链接列表无效：$paperId.$name")
                    return buildList(arr.length()) {
                        for (i in 0 until arr.length()) {
                            val raw = arr.opt(i) as? String
                                ?: throw IllegalArgumentException("开源与资源信号链接不是字符串：$paperId.$name")
                            val uri = runCatching { URI(raw) }.getOrNull()
                                ?: throw IllegalArgumentException("开源与资源信号链接格式无效：$paperId.$name")
                            require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null) {
                                "开源与资源信号链接必须为不含凭据的 HTTPS：$paperId.$name"
                            }
                            add(uri.toString())
                        }
                    }
                }

                result[paperId] = ResourceBadgeSignals(
                    hasCode = boolField("hasCode"),
                    hasModel = boolField("hasModel"),
                    hasDataset = boolField("hasDataset"),
                    hasDemo = boolField("hasDemo"),
                    hasProjectPage = boolField("hasProjectPage"),
                    codeUrls = httpsUrls("codeUrls"),
                    demoUrls = httpsUrls("demoUrls"),
                    projectUrls = httpsUrls("projectUrls"),
                )
            }
            return result
        }
    }
}
