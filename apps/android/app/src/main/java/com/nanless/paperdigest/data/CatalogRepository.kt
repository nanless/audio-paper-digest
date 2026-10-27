package com.nanless.paperdigest.data

import android.content.Context
import android.util.JsonReader
import android.util.JsonToken
import java.io.InputStream
import java.io.ByteArrayInputStream
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.file.Files
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import java.io.File
import java.net.URI
import java.time.Instant
import java.util.UUID
import kotlin.coroutines.coroutineContext

class CatalogRepository(private val context: Context, private val personal: PersonalStore,
    private val fetchOverride: (suspend (String, Int) -> ByteArray)? = null) {
    private val directory = File(personal.directory, "PublishedLibrary").also { it.mkdirs() }
    private val current = File(directory, "current.json")
    private val syncMutex = Mutex()
    private val offlineIds = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private data class CatalogState(val published: List<Paper>, val retired: List<Paper>, val summary: JSONObject, val epoch: String) {
        val all = (published + retired).distinctBy { it.id }
    }
    @Volatile private var citationCache: PublishedCitationRepository? = null
    private fun citationRepo(): PublishedCitationRepository = citationCache ?: synchronized(this) { citationCache ?: PublishedCitationRepository(File(directory, "citation-originals"), ::read).also { citationCache = it } }
    suspend fun citationOriginal(paper: Paper, article: Article, format: PublishedCitationRepository.Format, requireCurrent: () -> Unit = {}): PublishedCitationRepository.Original =
        personal.settings().optBoolean("offlineMode").let { offline -> citationRepo().original(paper, article, format, offline, verifyRemote = !offline, requireCurrent = requireCurrent) }
    @Volatile private var snapshot = loadCatalog()
    fun papers(): List<Paper> {
        val catalog = snapshot
        val personalPapers = personal.personalPapers()
        return if (personalPapers.isEmpty()) catalog.all else (catalog.published + personalPapers + catalog.retired).distinctBy { it.id }
    }
    fun summary(): JSONObject = snapshot.summary.copy()
    suspend fun searchCached(query: String): JSONObject = CachedGuideSearch(File(directory, "articles")).search(query, papers())
    suspend fun publishedRecords(paper: Paper): JSONObject = PublishedRecordArchive(directory).read(paper)
    fun epoch(): String = snapshot.epoch
    init { reindexOffline() }
    fun offlinePaperIDs(): Set<String> = offlineIds.toSet()
    fun prepareOfflineArticle(article: Article): Article = hydrate(article)
    fun reload() { citationCache = null; snapshot = loadCatalog(); reindexOffline() }

    /** The catalog stays as one owned typed tree; startup never makes a whole-library string plus deep copies. */
    private fun loadCatalog(): CatalogState {
        if (!current.exists()) {
            val seed = seedCatalog()
            return CatalogState(seed.getJSONArray("papers").objects().map(Paper::fromOwnedCatalogJson), emptyList(), seed.getJSONObject("summary"), seed.optString("validationEpoch"))
        }
        require(current.isFile && !Files.isSymbolicLink(current.toPath()) && current.length() in 1..MAX_TOTAL.toLong()) { "目录文件不可用或超过大小限制" }
        return current.inputStream().use { input ->
            var consumed = 0L
            val bounded = object : InputStream() {
                override fun read(): Int { val value = input.read(); if (value >= 0) { consumed++; require(consumed <= MAX_TOTAL) }; return value }
                override fun read(bytes: ByteArray, offset: Int, length: Int): Int { val count = input.read(bytes, offset, length); if (count > 0) { consumed += count; require(consumed <= MAX_TOTAL) }; return count }
            }
            JsonReader(PublishedUtf8.reader(bounded)).use { reader ->
                var format: String? = null; var epoch = ""; var summary: JSONObject? = null
                var published: List<Paper>? = null; var retired = emptyList<Paper>()
                val seen = mutableSetOf<String>()
                reader.beginObject()
                while (reader.hasNext()) {
                    val key = reader.nextName(); require(seen.add(key)) { "目录字段重复" }
                    when (key) {
                        "format" -> format = reader.nextString()
                        "validationEpoch" -> epoch = reader.nextString()
                        "summary" -> summary = readValue(reader, 0) as? JSONObject ?: error("目录摘要无效")
                        "papers", "retiredPapers" -> {
                            val entries = ArrayList<Paper>(); reader.beginArray()
                            while (reader.hasNext()) { require(entries.size < 100000); entries += Paper.fromOwnedCatalogJson(readValue(reader, 0) as? JSONObject ?: error("目录论文无效")) }
                            reader.endArray()
                            require(entries.map { it.id }.toSet().size == entries.size) { "目录论文身份重复" }
                            if (key == "papers") published = entries else retired = entries
                        }
                        else -> reader.skipValue()
                    }
                }
                reader.endObject(); require(reader.peek() == JsonToken.END_DOCUMENT) { "目录含额外内容" }
                require(format == "mac-published-library-v1" && published != null && summary != null) { "目录协议或字段尚不支持" }
                CatalogState(published!!, retired, summary!!, epoch)
            }
        }
    }
    private fun readValue(reader: JsonReader, depth: Int): Any {
        require(depth <= 64) { "目录嵌套超过安全读取范围" }
        return when (reader.peek()) {
            JsonToken.BEGIN_OBJECT -> JSONObject().also { obj -> reader.beginObject(); while (reader.hasNext()) { val name = reader.nextName(); require(!obj.has(name)) { "目录对象字段重复" }; obj.put(name, readValue(reader, depth + 1)) }; reader.endObject() }
            JsonToken.BEGIN_ARRAY -> JSONArray().also { array -> reader.beginArray(); while (reader.hasNext()) array.put(readValue(reader, depth + 1)); reader.endArray() }
            JsonToken.STRING -> reader.nextString()
            JsonToken.NUMBER -> JSONObject("{\"value\":" + reader.nextString() + "}").get("value")
            JsonToken.BOOLEAN -> reader.nextBoolean()
            JsonToken.NULL -> { reader.nextNull(); JSONObject.NULL }
            else -> error("目录JSON值无效")
        }
    }
    private fun reindexOffline() {
        offlineIds.clear()
        File(directory, "articles").listFiles()?.filter { it.isFile && it.name.endsWith(".json") }?.forEach { file -> runCatching { val a = Article.fromJson(JSONObject(JsonFiles.read(file, 128 * 1024 * 1024L).toString(Charsets.UTF_8))); if (a.html.isNotBlank() || !a.markdown.isNullOrBlank()) offlineIds += a.paperID } }
        File(directory, "pdf-pointers").listFiles()?.filter { it.isFile && it.name.endsWith(".json") }?.forEach { file -> runCatching { val o = JSONObject(JsonFiles.read(file, 1024 * 1024L).toString(Charsets.UTF_8)); val original = StoragePaths.resolve(o.getString("filePath"), personal.directory, o.getString("sha256"), 100 * 1024 * 1024L); require(original.length() == o.getLong("bytes")); offlineIds += o.getString("paperID") } }
        personal.personalPapers().forEach { p -> if (p.localPDFPath != null && p.pdfSHA256 != null) runCatching { StoragePaths.resolve(p.localPDFPath, personal.directory, p.pdfSHA256); offlineIds += p.id } }
    }

    /** Current epoch, not a coincidentally equal old manifest SHA, activates aggregate metadata. */
    fun aggregateCatalog():PublishedAggregateCatalog? {
        val current=snapshot
        val result=PublishedAggregateStore(directory).load(current.summary.optString("snapshotID"),current.epoch)
        require(snapshot.epoch==current.epoch){"读取期间目录验证代变化，请重新读取汇总"}
        return result
    }
    suspend fun aggregateDocument(id:String):JSONObject=withContext(Dispatchers.IO) {
        require(!personal.settings().optBoolean("offlineMode")){"当前为离线模式，请明确读取已保存的汇总修订"}
        val before=snapshot
        val descriptor=PublishedAggregateStore(directory).load(before.summary.optString("snapshotID"),before.epoch)?.records?.firstOrNull{it.id==id}?:error("汇总目录尚未同步或条目不存在")
        val raw=read(descriptor.sourceURL,16*1024*1024)
        coroutineContext.ensureActive()
        val latest=snapshot;require(latest.epoch==before.epoch&&latest.summary.optString("snapshotID")==before.summary.optString("snapshotID")){"读取期间目录验证代变化，未拼接新目录与旧网页"}
        // Native read uses a same-site request, no followed redirects and HTTP200; UI never supplies a URL.
        val result=PublishedAggregateStore(directory).cacheDocument(raw,descriptor,descriptor.sourceURL,now())
        coroutineContext.ensureActive();require(snapshot.epoch==before.epoch){"保存期间目录验证代变化，旧原件保留但未采纳到新目录"}
        result
    }
    fun aggregateCachedDocument(id:String,rawHTMLSHA256:String):JSONObject {
        val before=snapshot
        val descriptor=aggregateCatalog()?.records?.firstOrNull{it.id==id}?:error("当前汇总目录尚未核验")
        val result=PublishedAggregateStore(directory).cachedDocument(descriptor,rawHTMLSHA256)
        require(snapshot.epoch==before.epoch){"读取期间目录验证代变化，请明确读取原修订"}
        return result
    }

    /** A display stamp has no Paper capability and comes from one immutable native catalog snapshot. */
    fun aggregateStamp():AggregateCatalogStamp {val current=snapshot;return AggregateCatalogStamp(current.summary.optString("snapshotID"),current.epoch)}
    fun aggregateCachedRevisions(id:String):List<AggregateCachedRevision> {
        val before=snapshot
        val descriptor=PublishedAggregateStore(directory).load(before.summary.optString("snapshotID"),before.epoch)?.records?.firstOrNull{it.id==id}?:error("当前汇总目录尚未核验")
        val result=PublishedAggregateStore(directory).cachedRevisions(descriptor)
        require(snapshot.epoch==before.epoch){"读取修订清单期间目录验证代变化，未拼接旧清单"}
        return result
    }

    suspend fun sync(progress: (Int, Int, String) -> Unit = { _, _, _ -> }): JSONObject = syncMutex.withLock { withContext(Dispatchers.IO) {
        require(!personal.settings().optBoolean("offlineMode")) { "当前为离线模式，请先在设置中允许联网" }
        val index = read(SITE + "index.json", MAX_TOTAL)
        val snapshotID = sha256(index)
        val first = index.firstOrNull { it.toInt().toChar() !in " \t\r\n" }
        val legacyIndex = first == '['.code.toByte()
        val operationContext = coroutineContext
        val previous = snapshot
        val previousByID = previous.all.associateBy { it.id }
        val source = if (legacyIndex) JSONObject().put("legacyPublishedIndexSHA256", snapshotID).put("legacyPublishedIndexBytes", index.size)
            else JSONObject().put("publishedSnapshotID", snapshotID)
        val all = linkedMapOf<String, Paper>(); val pages = mutableSetOf<String>()
        var recordCount = 0
        fun accept(row: JSONObject) {
            operationContext.ensureActive()
            require(pages.add(row.getString("permalink"))) { "目录含重复页面" }
            recordCount++
            parsePaper(row)?.let { decoded ->
                // Keep the old snapshot available until the transaction commits, without retaining a
                // second equal citation/string tree for every paper. Every new row still passes parsing.
                val p = decoded.copy(original = source).sharingCatalogValues(previousByID[decoded.id])
                val old = all[p.id]
                all[p.id] = if (old == null) p else (if (p.date > old.date) p else old).copy(appearances = (old.appearances + p.appearances).distinct().sorted())
            }
        }
        var shards = 0
        if (legacyIndex) {
            JsonReader(PublishedUtf8.reader(ByteArrayInputStream(index))).use { reader ->
                reader.beginArray()
                while (reader.hasNext()) accept(readValue(reader, 0) as? JSONObject ?: error("目录记录无效"))
                reader.endArray(); require(reader.peek() == JsonToken.END_DOCUMENT) { "目录含额外内容" }
            }
        } else {
            val manifest = JSONObject(PublishedUtf8.decode(index))
            require(manifest.getString("contract") == "paper-search-index-manifest-v1") { "网站目录协议尚不支持" }
            val descriptors = manifest.getJSONArray("shards").objects()
            require(descriptors.size in 1..128 && manifest.getInt("recordCount") > 0 && manifest.getLong("totalBytes") in 1..MAX_TOTAL.toLong())
            val urls = mutableSetOf<String>()
            descriptors.forEach { s ->
                val path = s.getString("url"); val hash = s.getString("sha256")
                require(path.matches(Regex("search-index/part-[0-9]{4,}-[a-f0-9]{12}\\.json")) && hash.matches(Regex("[a-f0-9]{64}")) && path.endsWith("-${hash.take(12)}.json") && urls.add(path) && s.getInt("bytes") in 1..1024 * 1024 && s.getInt("recordCount") > 0) { "网站分片描述无效" }
            }
            require(descriptors.sumOf { it.getLong("bytes") } == manifest.getLong("totalBytes") && descriptors.sumOf { it.getLong("recordCount") } == manifest.getLong("recordCount")) { "网站目录总数量或字节不一致" }
            shards = descriptors.size
            descriptors.forEachIndexed { i, s ->
                operationContext.ensureActive()
                val file = File(directory, "index/${s.getString("sha256")}.json")
                var bytes = if (file.isFile) JsonFiles.read(file, 1024 * 1024L) else byteArrayOf()
                if (bytes.size != s.getInt("bytes") || sha256(bytes) != s.getString("sha256")) {
                    bytes = read(sameSite(s.getString("url")), 1024 * 1024)
                    require(bytes.size == s.getInt("bytes") && sha256(bytes) == s.getString("sha256")) { "网站分片与清单不符，原资料库保留" }
                    JsonFiles.write(file, bytes)
                }
                var shardRecords = 0
                JsonReader(PublishedUtf8.reader(ByteArrayInputStream(bytes))).use { reader ->
                    reader.beginArray()
                    while (reader.hasNext()) { accept(readValue(reader, 0) as? JSONObject ?: error("目录记录无效")); shardRecords++ }
                    reader.endArray(); require(reader.peek() == JsonToken.END_DOCUMENT) { "网站分片含额外内容" }
                }
                require(shardRecords == s.getInt("recordCount")) { "网站分片记录数量不符" }
                progress(i + 1, descriptors.size, "正在读取论文目录 ${i + 1}/${descriptors.size}")
            }
            require(recordCount == manifest.getInt("recordCount")) { "完整目录记录数不符" }
        }
        require(recordCount > 0) { "网站返回空目录，原资料库保留" }
        require(all.isNotEmpty()) { "目录没有可读取论文，原资料库保留" }
        val retired = (previous.retired + previous.published).filter { it.id !in all }.distinctBy { it.id }
        val summary = JSONObject().put("paperCount", all.size).put("recordCount", recordCount).put("shardCount", shards).put("snapshotID", sha256(index)).put("syncedAt", now()).put("source", SITE).put("syncing", false).put("missingFromLatest", JSONArray(retired.map { it.id }))
        val epoch = UUID.randomUUID().toString()
        val published = all.values.sortedBy { it.id }
        operationContext.ensureActive()
        // This raw source is immutable and becomes active only with the matching current.json transaction.
        val originalManifest = File(directory, "index-manifests/$snapshotID.json")
        if (originalManifest.exists()) require(JsonFiles.read(originalManifest, MAX_TOTAL.toLong()).contentEquals(index)) { "原目录清单身份对应的原始字节变化" }
        else JsonFiles.write(originalManifest, index)
        if(!legacyIndex)PublishedAggregateStore(directory).stage(index,epoch){operationContext.ensureActive()}
        operationContext.ensureActive()
        JsonFiles.writeStream(current, MAX_TOTAL.toLong()) { output ->
            val writer = OutputStreamWriter(output, Charsets.UTF_8)
            writer.write("{\"format\":\"mac-published-library-v1\",\"validationEpoch\":" + JSONObject.quote(epoch) + ",\"summary\":" + summary.toString() + ",\"papers\":[")
            published.forEachIndexed { index, paper -> operationContext.ensureActive(); if (index > 0) writer.write(","); writer.write(paper.json().toString()) }
            writer.write("],\"retiredPapers\":[")
            retired.forEachIndexed { index, paper -> operationContext.ensureActive(); if (index > 0) writer.write(","); writer.write(paper.json().toString()) }
            writer.write("]}"); writer.flush(); operationContext.ensureActive()
        }
        snapshot = CatalogState(published, retired, summary, epoch)
        summary.copy()
    } }

    suspend fun article(paper: Paper, refresh: Boolean = false): Article = withContext(Dispatchers.IO) {
        require(paper.blogURL.isNotEmpty()) { "本地导入论文没有网站导读，可打开 PDF 后创建本机研究" }
        val file = File(directory, "articles/${sha256(paper.blogURL.toByteArray())}.json")
        val previous = if (file.isFile) Article.fromJson(JSONObject(JsonFiles.read(file, 100 * 1024 * 1024L).toString(Charsets.UTF_8))) else null
        val parserCurrent = previous?.let { it.markdown != null || it.mathMLContract == "published-html-mathml-v1" } ?: false
        val sourceMatches = previous?.let { it.paperID == paper.id && it.blogURL == paper.blogURL && it.sourceURL == (paper.sourceURL ?: paper.blogURL) && it.pdfURL == paper.pdfURL && it.sourceVersion == paper.sourceVersion } ?: false
        if (!refresh && previous != null && parserCurrent && sourceMatches && previous.catalogEpoch == epoch() && age(previous.fetchedAt) < 21600 && resourcesValid(previous)) return@withContext hydrate(previous)
        if (!refresh && previous == null && epoch() == "bundled-sample") seedArticle(paper)?.let { JsonFiles.write(file, it.json()); offlineIds += paper.id; return@withContext hydrate(it) }
        try {
            require(!personal.settings().optBoolean("offlineMode")) { "当前为离线模式" }
            val citationRepository = citationRepo()
            val page = citationRepository.fetchPage(paper)
            var result: Article
            try {
                result = extractArticle(page.html, paper, epoch())
                try { result = citationRepository.bindPage(paper, result, page) }
                catch (error: Exception) {
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    coroutineContext.ensureActive()
                    result = result.copy(notices = result.notices + "引用原件下载页面尚未封存；其他导读内容保持原样。")
                }
            } finally { citationRepository.releasePage(page) }
            val images = mutableListOf<ArticleResource>(); val notices = result.notices.toMutableList()
            val doc = Jsoup.parseBodyFragment(result.html)
            var total = 0
            for (image in doc.select("img")) {
                coroutineContext.ensureActive()
                val url = image.attr("src")
                try {
                    val data = readExternal(url, 16 * 1024 * 1024)
                    total += data.size; require(total <= 64 * 1024 * 1024) { "图片总量超过 64 MiB" }
                    val mime = imageMime(data)
                    val hash = sha256(data); val local = File(directory, "assets/$hash")
                    JsonFiles.write(local, data)
                    image.attr("src", "data:$mime;base64," + java.util.Base64.getEncoder().encodeToString(data))
                    images += ArticleResource(url, localPath = local.absolutePath, sha256 = hash)
                } catch (e: Exception) {
                    coroutineContext.ensureActive()
                    image.removeAttr("src"); image.attr("data-source-url", url)
                    images += ArticleResource(url, missingReason = "图片尚未离线保存")
                    notices += "部分图片未能下载，已保留图题与原网址"
                }
            }
            val citationFiles = try { citationRepository.declaredFiles(paper, result) }
            catch (error: Exception) { if (error is kotlinx.coroutines.CancellationException) throw error; coroutineContext.ensureActive(); emptyMap() }
            var context: JSONObject? = null
            var sidecar: JSONObject? = null
            citationFiles["citation.json"]?.let { address ->
                try { sidecar = validatedSidecar(JSONObject(PublishedUtf8.decode(read(address, 1024 * 1024))), paper, false) }
                catch (error: Exception) { if (error is kotlinx.coroutines.CancellationException) throw error; coroutineContext.ensureActive(); notices += "引用附加文件尚未核验，保留页面已核验字段" }
            }
            citationFiles["rethink-context.json"]?.let { address ->
                try { context = validatedSidecar(JSONObject(PublishedUtf8.decode(read(address, 1024 * 1024))), paper, true) }
                catch (error: Exception) { if (error is kotlinx.coroutines.CancellationException) throw error; coroutineContext.ensureActive(); notices += "研究上下文附加文件尚未读取" }
            }
            val original = result.json().put("citationSidecar", sidecar ?: JSONObject.NULL).put("citationFiles", JSONObject(citationFiles))
            result = result.copy(html = doc.body().html(), resources = images, completeOffline = images.all { it.localPath != null }, notices = notices.distinct(), researchContext = context, original = original)
            if (result.catalogEpoch != epoch()) result = result.copy(isStale = true, notices = result.notices + "读取期间目录发生更新，请刷新核验当前修订")
            previous?.let { preserve(it) }; preserve(result)
            coroutineContext.ensureActive(); JsonFiles.write(file, result.json()); offlineIds += paper.id; hydrate(result)
        } catch (e: Exception) {
            coroutineContext.ensureActive()
            val old = previous ?: throw e
            hydrate(old.copy(isStale = true, completeOffline = resourcesValid(old), notices = (old.notices + (if (parserCurrent) emptyList() else listOf("这份旧 HTML 未经过公式结构保真读取，部分 MathML 可能缺失；原稿保留，请联网刷新。")) + "网站当前修订复验未完成，正在读取 ${old.fetchedAt} 保存的旧导读；原文版本 ${old.sourceVersion ?: "未标注"}。").distinct()))
        }
    }

    private val pdfReceipts = java.util.concurrent.ConcurrentHashMap<String, JSONObject>()
    fun pdfReceipt(id: String): JSONObject = pdfReceipts[id]?.copy() ?: JSONObject()
    suspend fun downloadPDF(paper: Paper): Pair<File, String> = withContext(Dispatchers.IO) {
        paper.localPDFPath?.let { path ->
            val file = StoragePaths.resolve(path, personal.directory, paper.pdfSHA256 ?: error("本地原文缺少内容指纹"), 200 * 1024 * 1024L)
            pdfReceipts[paper.id] = JSONObject().put("paperID", paper.id).put("filePath", file.absolutePath).put("sha256", paper.pdfSHA256).put("currentness", "local-original").put("isStale", false)
            offlineIds += paper.id
            return@withContext file to paper.pdfSHA256!!
        }
        require(paper.identityStatus == "verified" && !paper.pdfURL.isNullOrEmpty()) { "此论文没有经核验的 PDF 来源" }
        val immutable = immutableArxiv(paper)
        if (paper.sourceKind == "arxiv") require(immutable) { "arXiv 原文与摘要必须具有一致的明确版本，不能静默下载最新版" }
        val pointer = File(directory, "pdf-pointers/${sha256(paper.pdfURL!!.toByteArray())}.json")
        var previous: JSONObject? = null
        var previousFile: File? = null
        if (pointer.isFile) {
            val saved = JSONObject(JsonFiles.read(pointer, 1024 * 1024L).toString(Charsets.UTF_8))
            if (saved.optString("sourceURL") == paper.pdfURL && saved.nullableString("version") == paper.sourceVersion && (!saved.has("paperID") || saved.optString("paperID") == paper.id)) {
                val original = runCatching { StoragePaths.resolve(saved.getString("filePath"), personal.directory, saved.getString("sha256"), 100 * 1024 * 1024L) }.getOrNull()
                if (original != null && original.length() == saved.getLong("bytes")) {
                    previous = saved; previousFile = original
                    val publishedMatches = paper.pdfSHA256 == null || paper.pdfSHA256 == saved.getString("sha256")
                    val witnessed = immutable || paper.pdfSHA256 == saved.getString("sha256")
                    val timely = saved.optString("catalogEpoch") == epoch() && age(saved.optString("validatedAt", saved.optString("fetchedAt"))) <= 21600
                    if (publishedMatches && (witnessed || timely) && (!saved.optBoolean("isStale") || witnessed)) {
                        pdfReceipts[paper.id] = saved.copy().put("filePath", original.absolutePath).put("isStale", false).put("currentness", if (immutable) "immutable-arxiv-version" else if (paper.pdfSHA256 != null) "published-sha256" else "bounded-revalidation")
                        offlineIds += paper.id
                        return@withContext original to saved.getString("sha256")
                    }
                }
            }
        }
        try {
            var original: File? = null
            if (epoch() == "bundled-sample") {
                val sample = JSONObject(context.assets.open("published/sample.json").use { it.readBytes().toString(Charsets.UTF_8) })
                val primary = sample.getJSONObject("paper")
                if (paper.id == "arxiv:" + primary.getString("id") && paper.pdfURL == primary.getString("pdfUrl")) {
                    val descriptor = sample.getJSONObject("pdf")
                    val bytes = context.assets.open("published/${descriptor.getString("src")}").use { it.readBytes() }
                    require(bytes.size == descriptor.getInt("bytes") && sha256(bytes) == descriptor.getString("sha256"))
                    original = File(directory, "pdf/${descriptor.getString("sha256")}.pdf"); JsonFiles.write(original, bytes)
                }
            }
            if (original == null) {
                require(!personal.settings().optBoolean("offlineMode")) { "当前为离线模式，原文尚未保存或需要重新核验" }
                val temporary = File(directory, ".pdf-${UUID.randomUUID()}")
                try {
                    downloadExternal(paper.pdfURL, temporary, 100 * 1024 * 1024L)
                    val verified = com.nanless.paperdigest.pdf.PdfRepository(context).importFile(temporary, paper.title + ".pdf")
                    original = File(verified.localPath)
                } finally { temporary.delete() }
            }
            val file = original!!; val hash = com.nanless.paperdigest.cloud.BackupCodec.hash(file)
            require(paper.pdfSHA256 == null || paper.pdfSHA256 == hash) { "原文与网站公布的内容指纹不符" }
            val receipt = JSONObject().put("filePath", file.absolutePath).put("sha256", hash).put("bytes", file.length()).put("version", paper.sourceVersion ?: JSONObject.NULL)
                .put("paperID", paper.id).put("sourceURL", paper.pdfURL).put("fetchedAt", if (previous?.optString("sha256") == hash) previous.optString("fetchedAt", now()) else now())
                .put("validatedAt", now()).put("catalogEpoch", epoch()).put("isStale", false).put("cacheStatus", "current").put("currentness", if (immutable) "immutable-arxiv-version" else if (paper.pdfSHA256 != null) "published-sha256" else "bounded-revalidation").put("publicSHA256", paper.pdfSHA256 ?: JSONObject.NULL)
            val historical = File(directory, "pdf-receipts/${sha256(paper.id.toByteArray())}/$hash.json")
            if (!historical.exists()) JsonFiles.write(historical, receipt)
            JsonFiles.write(pointer, receipt); pdfReceipts[paper.id] = receipt
            offlineIds += paper.id
            file to hash
        } catch (e: Exception) {
            coroutineContext.ensureActive()
            val old = previous ?: throw e; val file = previousFile ?: throw e
            val stale = old.copy().put("isStale", true).put("cacheStatus", "stale").put("validationAttemptedAt", now()).put("notices", JSONArray(listOf("原文当前性复核未完成，正在读取先前保存的旧 SHA 副本；不代表网站当前原文。")))
            pdfReceipts[paper.id] = stale; JsonFiles.write(pointer, stale)
            file to old.getString("sha256")
        }
    }
    private suspend fun downloadExternal(initial: String, target: File, limit: Long) {
        var url = initial
        repeat(6) {
            val uri = URI(url); require(approvedResource(uri)) { "原文超出已支持的官方 HTTPS 来源" }
            val arxiv = uri.host.lowercase() in setOf("arxiv.org", "export.arxiv.org")
            val proxy = personal.settings().nullableString("httpProxy")
            if (arxiv) require(!proxy.isNullOrBlank()) { "arXiv 原文需要设置 HTTP CONNECT 代理" }
            val response = SafeHttp(if (arxiv) proxy else null).download(Request.Builder().url(url).build(), target, limit)
            if (response.code in listOf(301, 302, 303, 307, 308)) {
                val location = response.headers.entries.firstOrNull { it.key.equals("Location", true) }?.value ?: error("重定向缺少地址")
                url = uri.resolve(location).toASCIIString()
            } else { require(response.code == 200) { "官方资源没有返回完整 PDF" }; return }
        }
        throw AppFailure("transport", "官方资源重定向次数过多")
    }
    private fun immutableArxiv(p: Paper): Boolean {
        if (p.sourceKind != "arxiv" || p.sourceVersion == null || !Regex("v[1-9][0-9]*$").containsMatchIn(p.sourceVersion)) return false
        val version = p.sourceVersion; val base = version.replace(Regex("v[1-9][0-9]*$"), "")
        return runCatching {
            val abs = URI(p.sourceURL ?: ""); val pdf = URI(p.pdfURL ?: "")
            p.id == "arxiv:$base" && listOf(abs.host, pdf.host).all { it in setOf("arxiv.org", "export.arxiv.org") } && abs.path == "/abs/$version" && pdf.path.removeSuffix(".pdf") == "/pdf/$version"
        }.getOrDefault(false)
    }
    private fun preserve(article: Article) {
        val identity = article.json()
        listOf("fetchedAt", "catalogEpoch", "isStale", "notices").forEach(identity::remove)
        val immutableRevision = sha256(canonical(identity).toByteArray())
        val file = File(directory, "article-revisions/${sha256(article.blogURL.toByteArray())}/$immutableRevision.json")
        if (!file.exists()) JsonFiles.write(file, article.json())
    }
    private fun seedArticle(paper: Paper): Article? {
        val sample = JSONObject(context.assets.open("published/sample.json").use { it.readBytes().toString(Charsets.UTF_8) })
        val primary = sample.getJSONObject("paper")
        if (paper.id != "arxiv:" + primary.getString("id") || paper.sourceURL != primary.getString("absUrl") || paper.pdfURL != primary.getString("pdfUrl") || paper.blogURL != primary.getString("blogUrl")) return null
        val manifest = JSONObject(context.assets.open("published/manifest.json").use { it.readBytes().toString(Charsets.UTF_8) })
        val htmlBytes = context.assets.open("published/article.html").use { it.readBytes() }
        require(sha256(htmlBytes) == manifest.getString("htmlSHA256")) { "应用内导读样稿内容不符" }
        val resources = sample.getJSONArray("figures").objects().map { row ->
            val name = row.getString("src"); require(name.matches(Regex("[a-zA-Z0-9._-]+")))
            val bytes = context.assets.open("published/$name").use { it.readBytes() }
            require(sha256(bytes) == row.getString("sha256"))
            val file = File(directory, "assets/${row.getString("sha256")}")
            JsonFiles.write(file, bytes)
            ArticleResource(row.optString("sourceUrl"), localPath = file.absolutePath, sha256 = row.getString("sha256"))
        }
        val seeded = Article(paper.id, htmlBytes.toString(Charsets.UTF_8), sample.getString("articleMarkdown"), paper.sourceURL!!, paper.blogURL,
            sha256(htmlBytes), now(), paper.sourceVersion, true, listOf("应用内已发布样稿，尚未核对网站当前修订；可联网刷新导读。"), false, paper.citation, resources, "bundled-sample",
            JSONObject().put("contract", "android-bundled-research-context-v1").put("sampleOnly", true).put("paperID", paper.id).put("abstract", sample.getString("abstract")).put("summary", primary.optString("summary")), pdfURL = paper.pdfURL, mathMLContract = "published-html-mathml-v1")
        return seeded.copy(original = seeded.json().put("citationSidecar", validatedSidecar(sample.getJSONObject("citation"), paper, false)))
    }
    private fun resourcesValid(article: Article): Boolean = article.resources.all { r -> r.localPath != null && r.sha256 != null && runCatching { StoragePaths.resolve(r.localPath, personal.directory, r.sha256, 16 * 1024 * 1024L); true }.getOrDefault(false) }
    private fun hydrate(article: Article): Article {
        val map = linkedMapOf<String, String>(); var total = 0; val ambiguous = mutableSetOf<String>()
        article.resources.forEach { r ->
            runCatching {
                require(r.localPath != null && r.sha256 != null)
                val file = StoragePaths.resolve(r.localPath, personal.directory, r.sha256, 16 * 1024 * 1024L)
                val bytes = JsonFiles.read(file, 16 * 1024 * 1024L); total += bytes.size; require(total <= 64 * 1024 * 1024)
                val data = "data:${imageMime(bytes)};base64," + java.util.Base64.getEncoder().encodeToString(bytes)
                map[r.sourceURL] = data
                val basename = runCatching { URI(r.sourceURL).path.substringAfterLast('/') }.getOrNull()
                if (!basename.isNullOrEmpty() && basename !in ambiguous) {
                    if (map.containsKey(basename) && map[basename] != data) { map.remove(basename); ambiguous += basename } else map[basename] = data
                }
            }
        }
        val allowed = article.resources.mapNotNull { it.sha256 }.toSet()
        val source = article.markdown ?: ""
        val doc = Jsoup.parseBodyFragment(org.commonmark.renderer.html.HtmlRenderer.builder().escapeHtml(true).build().render(org.commonmark.parser.Parser.builder().build().parse(source)))
        doc.select("img[src]").take(32).forEach { image ->
            val value = image.attr("src")
            if (value.startsWith("data:image/") && value.length <= 24 * 1024 * 1024) runCatching {
                val comma = value.indexOf(','); require(comma in 1..100 && value.substring(0, comma).endsWith(";base64"))
                val bytes = java.util.Base64.getDecoder().decode(value.substring(comma + 1)); require(bytes.size <= 16 * 1024 * 1024 && sha256(bytes) in allowed)
                total += bytes.size; require(total <= 64 * 1024 * 1024)
                map[value] = "data:${imageMime(bytes)};base64," + java.util.Base64.getEncoder().encodeToString(bytes)
            }
        }
        return PublishedSourceWarning.present(article.copy(inlineImages = map))
    }
    private suspend fun read(url: String, limit: Int): ByteArray {
        fetchOverride?.let { return it(url, limit).also { b -> require(b.size <= limit) } }
        val safe = sameSite(url)
        val response = SafeHttp().execute(Request.Builder().url(safe).build(), limit)
        require(response.code == 200) { "网站资料暂不可用，原资料保留" }
        return response.bytes
    }
    private suspend fun readExternal(initial: String, limit: Int): ByteArray {
        var url = initial
        repeat(6) {
            val uri = URI(url)
            require(approvedResource(uri)) { "原文或图片超出已支持的官方 HTTPS 来源" }
            val isArxiv = uri.host.lowercase() in setOf("arxiv.org", "export.arxiv.org")
            val proxy = personal.settings().nullableString("httpProxy")
            if (isArxiv) require(!proxy.isNullOrBlank()) { "arXiv 原文需要设置 HTTP CONNECT 代理；已有导读仍可阅读" }
            val response = SafeHttp(if (isArxiv) proxy else null).execute(Request.Builder().url(url).build(), limit)
            if (response.code in listOf(301, 302, 303, 307, 308)) {
                val location = response.headers.entries.firstOrNull { it.key.equals("Location", true) }?.value ?: error("重定向缺少地址")
                url = uri.resolve(location).toASCIIString()
            } else {
                require(response.code == 200) { "官方资源暂不可用，未保存错误页面" }
                return response.bytes
            }
        }
        throw AppFailure("transport", "官方资源重定向次数过多")
    }
    private fun seedCatalog(): JSONObject {
        val seed = runCatching { JSONObject(context.assets.open("published/sample.json").use { it.readBytes().toString(Charsets.UTF_8) }) }.getOrNull()
        if (seed == null) return JSONObject().put("format", "mac-published-library-v1").put("validationEpoch", "unsynced")
            .put("summary", JSONObject().put("paperCount", 0).put("recordCount", 0).put("shardCount", 0).put("source", "尚未同步网站论文").put("snapshotID", "unsynced").put("syncedAt", JSONObject.NULL))
            .put("papers", JSONArray())
        val rows = seed.optJSONArray("librarySample")?.objects() ?: emptyList()
        val papers = rows.map { row ->
            val id = row.getString("id"); val source = row.getString("absUrl"); val version = URI(source).path.substringAfterLast('/')
            Paper("arxiv:$id", row.getString("title"), row.optString("titleZh", row.getString("title")), row.optJSONArray("authors")?.objects()?.map { it.getString("name") } ?: emptyList(),
                row.optString("date"), Paper.score(row.opt("score")), row.optString("task"), row.optString("method"), row.optJSONArray("tags")?.strings() ?: emptyList(), "arxiv", "verified", row.getString("blogUrl"), source,
                row.getString("pdfUrl"), version, JSONObject().put("contract", "paper-citation-source-v1").put("paperKey", "arxiv:$id").put("identityStatus", "verified").put("verified", true).put("complete", false).put("title", row.getString("title")).put("authors", JSONArray(row.optJSONArray("authors")?.objects()?.map { it.getString("name") } ?: emptyList<String>())).put("arxivId", version).put("sourceUrl", source).put("pdfUrl", row.getString("pdfUrl")).put("sourceKind", "arxiv"))
        }
        return JSONObject().put("format", "mac-published-library-v1").put("validationEpoch", "bundled-sample")
            .put("summary", JSONObject().put("paperCount", papers.size).put("recordCount", papers.size).put("shardCount", 0).put("source", "应用内已发布样稿，尚未全站同步").put("snapshotID", "bundled-sample").put("syncedAt", JSONObject.NULL))
            .put("papers", JSONArray(papers.map { it.json() }))
    }

    companion object {
        const val SITE = "https://nanless.github.io/audio-paper-digest-blog/"
        const val MAX_TOTAL = 64 * 1024 * 1024
        fun sameSite(value: String): String {
            val uri = URI(SITE).resolve(value)
            require(uri.scheme == "https" && uri.host == "nanless.github.io" && (uri.port == -1 || uri.port == 443) && uri.userInfo == null && uri.query == null && uri.fragment == null && uri.rawPath.startsWith("/audio-paper-digest-blog/") && !uri.rawPath.contains('%') && !uri.rawPath.contains('\\') && !uri.rawPath.contains("//") && uri.path.split('/').none { it == ".." || it == "." }) { "资料地址超出可信站点目录" }
            return uri.toASCIIString()
        }
        fun parsePaper(row: JSONObject): Paper? {
            if (row.getString("pageType") != "paper") return null
            val citation = row.optJSONObject("citation") ?: JSONObject()
            val status = row.optString("identityStatus", citation.optString("identityStatus", "unverified"))
            val kind = row.optString("sourceKind", citation.optString("sourceKind", "unknown"))
            val blog = sameSite(row.getString("permalink"))
            val arxiv = row.optString("arxivId", citation.optString("arxivId"))
            val base = arxiv.replace(Regex("v[1-9][0-9]*$"), "")
            val explicit = row.optString("paperId", citation.optString("paperId"))
            val id = if (status == "verified" && kind == "arxiv" && base.matches(Regex("(?:[0-9]{4}\\.[0-9]{4,5}|[a-z-]+(?:\\.[A-Z]{2})?/[0-9]{7})"))) "arxiv:$base" else if (status == "verified" && kind != "arxiv" && explicit.isNotEmpty()) explicit else "page:${URI(blog).path}"
            val title = row.optString("originalTitle", citation.optString("title", row.optString("title")))
            require(title.isNotEmpty()) { "论文目录缺少题名" }
            val hashes = listOf(row.nullableString("pdfSha256"), row.nullableString("pdfSHA256"), citation.nullableString("pdfSha256"), citation.nullableString("pdfSHA256")).filterNotNull().toSet()
            require(hashes.size <= 1 && hashes.all { it.matches(Regex("[a-f0-9]{64}")) }) { "已发布 PDF 指纹无效或相互矛盾" }
            val pdfSHA = hashes.firstOrNull()
            return Paper(id, title, row.optString("titleZh", row.optString("title", title)), citation.optJSONArray("authors")?.strings() ?: emptyList(), row.optString("date"), Paper.score(row.opt("score")), row.optString("task"), row.optString("method"), row.optJSONArray("tags")?.strings() ?: emptyList(), kind, status, blog,
                cleanHTTPS(citation.nullableString("sourceUrl") ?: citation.nullableString("url")), if (status == "verified") cleanHTTPS(citation.nullableString("pdfUrl")) else null, citation.nullableString("arxivId"), citation, pdfSHA, listOf(blog))
        }
        fun validatedSidecar(value: JSONObject, paper: Paper, context: Boolean): JSONObject {
            require(value.optString("contract") in if (context) setOf("researcher-sidecars-v1", "paper-research-context-v2") else setOf("researcher-sidecars-v1")) { "引用或上下文附加文件合同不受支持" }
            if (paper.identityStatus == "verified") {
                if (paper.sourceKind == "arxiv") {
                    val base = value.optString("arxivId", value.optString("id")).replace(Regex("v[1-9][0-9]*$"), "")
                    require("arxiv:$base" == paper.id) { "附加文件属于另一篇论文" }
                    if (paper.sourceVersion != null) listOf("arxivVersionedId", "id", "arxivId").mapNotNull { value.nullableString(it) }.forEach { id -> require(!Regex("v[1-9][0-9]*$").containsMatchIn(id) || id == paper.sourceVersion) { "附加文件对应另一原文版本" } }
                    listOf("absUrl" to paper.sourceURL, "pdfUrl" to paper.pdfURL).forEach { (field, expected) -> val address = value.nullableString(field); require(address == null || expected == null || address == expected) { "附加文件来源与当前原文版本不一致" } }
                } else require(value.optString("paperId") == paper.id || value.optString("id") == paper.id) { "附加文件属于另一会议论文" }
            }
            return value.copy()
        }
        private fun cleanHTTPS(value: String?): String? = value?.takeIf { runCatching { URI(it).let { u -> u.scheme == "https" && u.host != null && u.userInfo == null } }.getOrDefault(false) }
        fun approvedResource(uri: URI): Boolean {
            if (uri.scheme != "https" || uri.host == null || uri.userInfo != null || uri.port !in listOf(-1, 443) || uri.fragment != null) return false
            if (uri.host in setOf("arxiv.org", "export.arxiv.org", "isca-archive.org", "www.isca-archive.org", "openreview.net", "proceedings.mlr.press", "papers.nips.cc", "proceedings.neurips.cc", "aclanthology.org")) return true
            if (uri.host == "nanless.github.io") return runCatching { sameSite(uri.toASCIIString()); true }.getOrDefault(false)
            return uri.host == "raw.githubusercontent.com" && uri.path.startsWith("/nanless/audio-paper-digest-blog/main/") && uri.path.split('/').none { it in listOf("..", ".") } && !uri.rawPath.contains('%') && uri.query == null
        }
        fun imageMime(data: ByteArray): String {
            if (data.size >= 4 && data.copyOfRange(0, 4).contentEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47))) return "image/png"
            if (data.size >= 3 && data[0] == 0xff.toByte() && data[1] == 0xd8.toByte() && data[2] == 0xff.toByte()) return "image/jpeg"
            val text = data.toString(Charsets.UTF_8)
            if (text.startsWith("GIF8")) return "image/gif"
            if (data.size > 12 && text.take(4) == "RIFF" && text.substring(8, 12) == "WEBP") return "image/webp"
            if (text.contains("<svg") && !Regex("<!ENTITY|<script|foreignObject|javascript:|\\bon[a-z]+\\s*=|(?:href|src)\\s*=\\s*[\"'](?!#)|url\\(\\s*(?!#)", RegexOption.IGNORE_CASE).containsMatchIn(text)) return "image/svg+xml"
            throw AppFailure("invalid", "科学图内容不受支持或包含外部执行引用")
        }
        fun extractArticle(raw: String, paper: Paper, epoch: String = ""): Article {
            val doc = Jsoup.parse(raw, paper.blogURL)
            val bodies = doc.select("div#article-body.post-content")
            require(bodies.size == 1) { "网站正文结构发生变化，未读取导航内容或用模型补写" }
            val body = bodies.single()
            val json = doc.selectFirst("script.paper-tools__citation-record[type=application/json]")?.data()
                ?: doc.selectFirst("[data-citation-record]")?.attr("data-citation-record")
            val citation = if (json.isNullOrBlank()) paper.citation else JSONObject(json)
            val owner = citation.optString("paperKey")
            require(paper.identityStatus != "verified" || owner.isEmpty() || owner == paper.id) { "页面正文与目录论文身份不符" }
            if (paper.identityStatus == "verified" && paper.sourceKind == "arxiv") {
                val version = citation.optString("arxivId")
                require(!Regex("v[1-9][0-9]*$").containsMatchIn(version) || paper.sourceVersion == null || version == paper.sourceVersion) { "页面原文版本与目录不符" }
                listOf("sourceUrl" to paper.sourceURL, "pdfUrl" to paper.pdfURL).forEach { (key, expected) -> require(expected == null || citation.optString(key).isEmpty() || citation.optString(key) == expected) { "页面来源地址与目录不符" } }
            }
            sanitize(body, paper.blogURL)
            require(body.select("img").size <= 32) { "单篇科学图超过32张" }
            val html = body.html()
            return PublishedSourceWarning.present(Article(paper.id, html, articlePlainText(body), paper.sourceURL ?: paper.blogURL, paper.blogURL, sha256(html.toByteArray()), now(), paper.sourceVersion, false, emptyList(), false, citation, catalogEpoch = epoch, pdfURL = paper.pdfURL, mathMLContract = "published-html-mathml-v1"))
        }
        fun articlePlainText(body: Element): String {
            val copy = body.clone()
            copy.select(".katex").forEach { formula -> if (formula.selectFirst("math") != null) formula.select(".katex-html").remove() }
            copy.select("math").toList().forEach { math ->
                val tex = math.selectFirst("annotation[encoding=application/x-tex]")?.wholeText()?.takeIf { it.isNotBlank() }
                val actual = if (tex != null) "[公式 TeX：$tex]" else "[公式 MathML：${math.outerHtml()}]"
                math.replaceWith(org.jsoup.nodes.TextNode(actual))
            }
            return copy.wholeText()
        }
        private fun sanitize(root: Element, base: String) {
            val allowed = ("div p span a h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code table thead tbody tfoot tr th td caption img figure figcaption strong b em i u s sup sub br hr details summary dl dt dd math mrow mi mo mn msup msub msubsup mfrac msqrt mroot mtext mtable mtr mtd mover munder munderover semantics annotation").split(' ').toSet()
            val attrs = ("id class title alt width height colspan rowspan scope display mathvariant xmlns encoding").split(' ').toSet()
            root.children().toList().forEach { child ->
                if (child.normalName() !in allowed) child.remove() else {
                    child.attributes().asList().forEach { attr ->
                        val name = attr.key.lowercase()
                        if ((name == "href" && child.normalName() == "a") || (name == "src" && child.normalName() == "img")) {
                            if (name == "href" && attr.value.startsWith('#')) Unit else {
                                val url = runCatching { URI(base).resolve(attr.value).toASCIIString() }.getOrNull()
                                if (cleanHTTPS(url) == null) child.removeAttr(attr.key) else child.attr(attr.key, url!!)
                            }
                        } else if (name !in attrs) child.removeAttr(attr.key)
                    }
                    if (child.normalName() == "a") child.attr("rel", "noopener noreferrer")
                    sanitize(child, base)
                }
            }
        }
        private fun age(date: String): Long = runCatching { (Instant.now().toEpochMilli() - Instant.parse(date).toEpochMilli()).coerceAtLeast(0) / 1000 }.getOrDefault(Long.MAX_VALUE)
    }
}
