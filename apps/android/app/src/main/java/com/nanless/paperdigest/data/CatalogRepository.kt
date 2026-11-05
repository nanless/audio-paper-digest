package com.nanless.paperdigest.data

import com.nanless.paperdigest.protocols.ClientProtocols

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
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import java.io.File
import java.net.URI
import java.time.Instant
import java.util.UUID
import kotlin.coroutines.coroutineContext

private val ARXIV_VERSION_SUFFIX=Regex("v[1-9][0-9]*$")
private val ARXIV_ID_PATTERN=Regex("(?:[0-9]{4}\\.[0-9]{4,5}|[a-z-]+(?:\\.[A-Z]{2})?/[0-9]{7})")
private val SHA256_PATTERN=Regex("^[a-f0-9]{64}$")
private val SEARCH_SHARD_PATTERN=Regex("^search-index/part-[0-9]{4,}-[a-f0-9]{12}\\.json$")
private val HTML_ALLOWED_TAGS=("div p span a h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code table thead tbody tfoot tr th td caption img figure figcaption strong b em i u s sup sub br hr details summary dl dt dd math mrow mi mo mn msup msub msubsup mfrac msqrt mroot mtext mtable mtr mtd mover munder munderover semantics annotation").split(' ').toSet()
private val HTML_ALLOWED_ATTRS=("id class title alt width height colspan rowspan scope display mathvariant xmlns encoding").split(' ').toSet()

class CatalogRepository(private val context: Context, private val personal: PersonalStore,
    private val fetchOverride: (suspend (String, Int) -> ByteArray)? = null) {
    private val directory = File(personal.directory, "PublishedLibrary").also { it.mkdirs() }
    private val current = File(directory, "current.json")
    private val syncMutex = Mutex()
    private val publishedHttp by lazy { SafeHttp.publishedSite() }
    private val offlineIds = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val offlineIndexFile = File(directory, "offline-index.json")
    private val offlineIndexLock = Any()
    @Volatile private var offlineIndex = OfflineIndexSnapshot(emptyMap(), emptyMap())
    private data class CatalogState(val published: List<Paper>, val retired: List<Paper>, val summary: JSONObject, val epoch: String, val taxonomy: WebsiteTaxonomy? = null) {
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
    fun websiteTaxonomy(): WebsiteTaxonomy? = snapshot.taxonomy
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
                val header=JSONObject(); var epoch = ""; var summary: JSONObject? = null
                var published: List<Paper>? = null; var retired = emptyList<Paper>(); var taxonomy: WebsiteTaxonomy? = null
                val seen = mutableSetOf<String>()
                reader.beginObject()
                while (reader.hasNext()) {
                    val key = reader.nextName(); require(seen.add(key)) { "目录字段重复" }
                    when (key) {
                        "format", "contract", "schemaFingerprint", "version", "schemaVersion", "policyVersion", "__proto__" -> header.put(key,readValue(reader,0))
                        "validationEpoch" -> epoch = reader.nextString()
                        "summary" -> summary = readValue(reader, 0) as? JSONObject ?: error("目录摘要无效")
                        "websiteTaxonomy" -> { val value = readValue(reader, 0); taxonomy = if(value is JSONObject)runCatching { WebsiteTaxonomy.parse(value) }.getOrNull() else null }
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
                require(ClientProtocols.hasValidHeader(header,"paperdigest-published-library",if(header.has("format")) "format" else "contract") && published != null && summary != null) { "目录协议或字段尚不支持" }
                CatalogState(published!!, retired, summary!!.also {if(taxonomy==null)it.put("websiteTaxonomyStatus","unavailable")}, epoch, taxonomy)
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
        val articles = File(directory, "articles")
        val pointers = File(directory, "pdf-pointers")
        // Startup trusts only a fully revalidated derived index; any disagreement with the
        // actual article/PDF-pointer files falls back to one real scan before rebuilding.
        val indexed = synchronized(offlineIndexLock) {
            val stored = OfflineIndex.read(offlineIndexFile)
            val verified = stored?.let { OfflineIndex.offlineIDs(it, articles, pointers) }
            if (stored != null && verified != null) { offlineIndex = stored; verified } else {
                val (rebuilt, scanned) = rebuildOfflineIndex(articles, pointers)
                offlineIndex = rebuilt
                runCatching { OfflineIndex.write(offlineIndexFile, rebuilt) }
                scanned
            }
        }
        offlineIds.clear(); offlineIds.addAll(indexed)
        personal.personalPapers().forEach { p -> if (p.localPDFPath != null && p.pdfSHA256 != null) runCatching { StoragePaths.resolve(p.localPDFPath, personal.directory, p.pdfSHA256); offlineIds += p.id } }
    }

    /** Only the fallback path opens article bodies; it also recreates the index atomically. */
    private fun rebuildOfflineIndex(articles: File, pointers: File): Pair<OfflineIndexSnapshot, Set<String>> {
        val (articleEntries, articleIDs) = OfflineIndex.scanArticles(articles)
        val (pdfEntries, pdfIDs) = OfflineIndex.scanPointers(pointers) { receipt ->
            val original = StoragePaths.resolve(receipt.getString("filePath"), personal.directory, receipt.getString("sha256"), 100 * 1024 * 1024L)
            require(original.length() == receipt.getLong("bytes"))
            original
        }
        val ids = linkedSetOf<String>(); ids.addAll(articleIDs); ids.addAll(pdfIDs)
        return OfflineIndexSnapshot(articleEntries, pdfEntries) to ids
    }

    /** Article bytes and their index entry are separate atomic writes; a crash between them
     * leaves a detectable mismatch for the next start to repair, never a half-written file. */
    private fun saveArticle(file: File, article: Article) {
        JsonFiles.write(file, article.json())
        offlineIds += article.paperID
        recordOfflineArticle(file, article)
    }
    private fun recordOfflineArticle(file: File, article: Article) {
        val entry = OfflineIndex.articleEntry(file, article.paperID, article.html.isNotBlank() || !article.markdown.isNullOrBlank()) ?: return
        synchronized(offlineIndexLock) {
            val current = offlineIndex
            if (current.articles[file.name] == entry) return
            val next = OfflineIndexSnapshot(current.articles + (file.name to entry), current.pdfPointers)
            offlineIndex = next
            runCatching { OfflineIndex.write(offlineIndexFile, next) }
        }
    }
    private fun recordOfflinePointer(pointer: File, receipt: JSONObject) {
        val paperID = receipt.optString("paperID").takeIf { it.isNotEmpty() } ?: return
        offlineIds += paperID
        val originalPath = receipt.optString("filePath").takeIf { it.isNotEmpty() } ?: return
        synchronized(offlineIndexLock) {
            val entry = OfflineIndex.pdfEntry(pointer, receipt, File(originalPath)) ?: return
            val current = offlineIndex
            if (current.pdfPointers[pointer.name] == entry) return
            val next = OfflineIndexSnapshot(current.articles, current.pdfPointers + (pointer.name to entry))
            offlineIndex = next
            runCatching { OfflineIndex.write(offlineIndexFile, next) }
        }
    }

    /** Current epoch, not a coincidentally equal old manifest SHA, activates aggregate metadata. */
    fun aggregateCatalog():PublishedAggregateCatalog? {
        val current=snapshot
        val result=PublishedAggregateStore(directory).load(current.summary.optString("snapshotID"),current.epoch)
        require(snapshot.epoch==current.epoch){"读取期间目录验证代变化，请重新读取汇总"}
        return result
    }
    /** Current catalog, original row, saved HTML and cache-only images share one synchronous cold proof.
     * No network/model operation can enter the source scope; the full original bytes are guarded on return. */
    internal fun aggregateSavedSelection(id:String):AggregateSavedSelection? {
        val before=snapshot;val store=PublishedAggregateStore(directory)
        val selection=store.withSourceReadScope {
            val catalog=store.load(before.summary.optString("snapshotID"),before.epoch)?:return@withSourceReadScope null
            val descriptor=catalog.records.firstOrNull{it.id==id}?:return@withSourceReadScope null
            var cacheError:String?=null
            val revisions=try{store.cachedRevisions(descriptor)}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(_:Exception){cacheError="保存修订清单核验未完成；没有挑选其他旧正文。";emptyList()}
            val document=revisions.firstOrNull()?.let{store.cachedDocument(descriptor,it.rawHTMLSHA256)}
            var imageError:String?=null
            val images=if(document==null)null else try{
                val raw=document.getString("rawHTMLSHA256")
                store.latestImageRendering(descriptor,raw)?:store.importMacImageRendering(descriptor,raw)
            }catch(e:kotlinx.coroutines.CancellationException){throw e}catch(_:Exception){imageError="图片保存或缓存核验未完成；保留原网页正文，没有改用其他图片修订。";null}
            AggregateSavedSelection(catalog,descriptor,revisions,document,images,cacheError,imageError)
        }
        require(snapshot===before){"读取期间目录验证代变化，未采用旧缓存选择"}
        return selection
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
    /** Optional bounded public-HTML prefetch. Network never holds the workspace maintenance lock.
     * Only the still-current native descriptor may be committed; no paper, image or model is opened. */
    internal suspend fun preloadAggregateDocument(id:String,expected:AggregateCatalogStamp,commit:suspend (()->Unit)->Unit) {
        if(personal.settings().optBoolean("offlineMode")||aggregateStamp()!=expected)return
        val store=PublishedAggregateStore(directory);val before=snapshot
        val candidate=store.withSourceReadScope {
            val catalog=store.load(before.summary.optString("snapshotID"),before.epoch)?:return@withSourceReadScope null
            val descriptor=catalog.records.firstOrNull{it.id==id}?:return@withSourceReadScope null
            descriptor to store.cachedRevisions(descriptor).isNotEmpty()
        }?:return
        if(candidate.second)return
        val descriptor=candidate.first
        val raw=kotlinx.coroutines.withTimeout(12_000){read(descriptor.sourceURL,16*1024*1024)}
        coroutineContext.ensureActive()
        commit {
            require(!personal.settings().optBoolean("offlineMode")&&aggregateStamp()==expected){"预载期间目录或离线设置已变化"}
            store.cacheDocument(raw,descriptor,descriptor.sourceURL,now())
        }
    }

    fun aggregateCachedDocument(id:String,rawHTMLSHA256:String):JSONObject {
        val before=snapshot
        val descriptor=aggregateCatalog()?.records?.firstOrNull{it.id==id}?:error("当前汇总目录尚未核验")
        val result=PublishedAggregateStore(directory).cachedDocument(descriptor,rawHTMLSHA256)
        require(snapshot.epoch==before.epoch){"读取期间目录验证代变化，请明确读取原修订"}
        return result
    }

    /** Only an actually opened native aggregate ID/raw revision may fetch its source-bound images. */
    internal suspend fun aggregateImages(id:String,rawHTMLSHA256:String,allowNetwork:Boolean):AggregateImageAccess?=withContext(Dispatchers.IO) {
        if(allowNetwork)require(!personal.settings().optBoolean("offlineMode")){"当前为离线模式"}
        val before=snapshot;val store=PublishedAggregateStore(directory)
        val context=coroutineContext
        fun current(){context.ensureActive();require(snapshot.epoch==before.epoch&&snapshot.summary.optString("snapshotID")==before.summary.optString("snapshotID")){"图片读取期间目录已变化"}}
        current()
        val prepared=store.withSourceReadScope {
            val descriptor=store.load(before.summary.optString("snapshotID"),before.epoch)?.records?.firstOrNull{it.id==id}?:error("当前汇总目录尚未核验")
            AggregateImageLoader.prepare(store,descriptor,rawHTMLSHA256,allowNetwork)
        }
        current()
        val result=AggregateImageLoader.readPrepared(store,prepared,
            approved={address->runCatching{approvedResource(URI(address))}.getOrDefault(false)},
            fetch={address,limit->fetchOverride?.invoke(address,limit)?:readExternal(address,limit)},check=::current)
        current();result
    }

    /** Resolve only a native document href; cold current.json alone never grants a Paper route. */
    internal suspend fun aggregateLink(document:AggregateDocumentView,href:String):AggregateLinkDestination {
        val before=snapshot
        val catalog=aggregateCatalog()?:error("网站目录尚未核验")
        require(catalog.snapshotSHA256==before.summary.optString("snapshotID")&&catalog.records.any{it==document.descriptor})
        return AggregateLinkRouting.resolve(document,href,catalog,before.published,verifiedOriginal={paper->
            val witness=publishedRecords(paper)
            witness.optString("status")=="verified-local-originals"&&witness.optString("snapshotID")==before.summary.optString("snapshotID")
        },current={snapshot===before})
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

    internal suspend fun hasPublishedCatalogUpdate(): Boolean {
        if (personal.settings().optBoolean("offlineMode")) return false
        val index = read(SITE + "index.json", MAX_TOTAL)
        return sha256(index) != snapshot.summary.optString("snapshotID")
    }

    suspend fun sync(progress: (Int, Int, String) -> Unit = { _, _, _ -> }): JSONObject = syncMutex.withLock { withContext(Dispatchers.IO) {
        require(!personal.settings().optBoolean("offlineMode")) { "当前为离线模式，请先在设置中允许联网" }
        var indexURL=SITE+"client/index.json"
        val index=try { read(indexURL,MAX_TOTAL) } catch(error:PublishedHttpStatus) {
            if(error.status !in listOf(404,410))throw error
            indexURL=SITE+"index.json";read(indexURL,MAX_TOTAL)
        }
        val snapshotID = sha256(index)
        val first = index.firstOrNull { it.toInt().toChar() !in " \t\r\n" }
        val legacyIndex = first == '['.code.toByte()
        require(!legacyIndex || indexURL==SITE+"index.json"){"新网站目录缺少完整格式声明"}
        val operationContext = coroutineContext
        val previous = snapshot
        val previousByID = previous.all.associateBy { it.id }
        // One paired website display catalog per sync; unavailable taxonomy never discards papers.
        val refreshedTaxonomy = try {
            suspend fun optional404(url:String,limit:Int):ByteArray?=try {read(url,limit)}catch(error:PublishedHttpStatus){if(error.status==404)null else throw error}
            val currentSnapshot=optional404(SITE+"client/data/tag-catalog-snapshot.json",2*1024*1024)
            val currentVersions=optional404(SITE+"client/data/tag-catalog-versions.json",8*1024*1024)
            val (snapshotBytes,versionsBytes)=if(currentSnapshot==null&&currentVersions==null) {
                read(SITE+"data/tag-catalog-snapshot.json",2*1024*1024) to read(SITE+"data/tag-catalog-versions.json",8*1024*1024)
            } else {require(currentSnapshot!=null&&currentVersions!=null){"新网页分类资源不成对"};currentSnapshot to currentVersions}
            val display=JSONObject().put("snapshot",JSONObject(PublishedUtf8.decode(snapshotBytes)))
                .put("versions",JSONObject(PublishedUtf8.decode(versionsBytes)))
            val snapshotFamily="paper-tag-catalog-snapshot";val versionsFamily="paper-tag-catalog-versions"
            val snapshotContract=if(currentSnapshot!=null)ClientProtocols.contract(snapshotFamily)
                else ClientProtocols.historicalContract(snapshotFamily,"public-concept-hierarchy")
            val versionsContract=if(currentVersions!=null)ClientProtocols.contract(versionsFamily)
                else ClientProtocols.historicalContract(versionsFamily,"sha-keyed-snapshot-set")
            require(display.getJSONObject("snapshot").opt("contract")==snapshotContract&&
                display.getJSONObject("versions").opt("contract")==versionsContract){"分类端点返回了不匹配的格式"}
            WebsiteTaxonomy.parse(display)
        } catch(cancelled:kotlinx.coroutines.CancellationException) { throw cancelled }
          catch(_:Exception) { null }
        operationContext.ensureActive()
        val taxonomy = refreshedTaxonomy ?: previous.taxonomy
        val taxonomyStatus = if(refreshedTaxonomy!=null)"ready"else if(taxonomy!=null)"cached-unavailable"else"unavailable"
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
                val p = decoded.copy(original = source.copy().put("websiteTagRecords", JSONArray(WebsiteTaxonomy.records(decoded)))).sharingCatalogValues(previousByID[decoded.id])
                val old = all[p.id]
                all[p.id] = if (old == null) p else {
                    val chosen = if(p.date > old.date)p else old
                    chosen.copy(appearances = (old.appearances + p.appearances).distinct().sorted(),
                        original = chosen.original!!.copy().put("websiteTagRecords", JSONArray(WebsiteTaxonomy.records(old) + WebsiteTaxonomy.records(p))))
                }
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
            val family="paper-search-index-manifest"
            val expectedContract=if(indexURL==SITE+"client/index.json")ClientProtocols.contract(family)
                else ClientProtocols.historicalContract(family,"sha-bound-ordered-shards")
            require(ClientProtocols.hasValidHeader(manifest,family)&&manifest.opt("contract")==expectedContract) { "网站目录协议尚不支持" }
            val descriptors = manifest.getJSONArray("shards").objects()
            require(descriptors.size in 1..128 && manifest.getInt("recordCount") > 0 && manifest.getLong("totalBytes") in 1..MAX_TOTAL.toLong())
            val urls = mutableSetOf<String>()
            descriptors.forEach { s ->
                val path = s.getString("url"); val hash = s.getString("sha256")
                require(path.matches(SEARCH_SHARD_PATTERN) && hash.matches(SHA256_PATTERN) && path.endsWith("-${hash.take(12)}.json") && urls.add(path) && s.getInt("bytes") in 1..1024 * 1024 && s.getInt("recordCount") > 0) { "网站分片描述无效" }
            }
            require(descriptors.sumOf { it.getLong("bytes") } == manifest.getLong("totalBytes") && descriptors.sumOf { it.getLong("recordCount") } == manifest.getLong("recordCount")) { "网站目录总数量或字节不一致" }
            shards = descriptors.size
            descriptors.forEachIndexed { i, s ->
                operationContext.ensureActive()
                val file = File(directory, "index/${s.getString("sha256")}.json")
                var bytes = if (file.isFile) JsonFiles.read(file, 1024 * 1024L) else byteArrayOf()
                if (bytes.size != s.getInt("bytes") || sha256(bytes) != s.getString("sha256")) {
                    bytes = read(sameSite(URI(indexURL).resolve(s.getString("url")).toASCIIString()), 1024 * 1024)
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
        val summary = JSONObject().put("paperCount", all.size).put("recordCount", recordCount).put("shardCount", shards).put("snapshotID", sha256(index)).put("syncedAt", now()).put("source", SITE).put("syncing", false).put("missingFromLatest", JSONArray(retired.map { it.id })).put("websiteTaxonomyStatus", taxonomyStatus)
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
            writer.write(ClientProtocols.record("paperdigest-published-library").toString().dropLast(1) + ",\"validationEpoch\":" + JSONObject.quote(epoch) + ",\"summary\":" + summary.toString() + ",\"papers\":[")
            published.forEachIndexed { index, paper -> operationContext.ensureActive(); if (index > 0) writer.write(","); writer.write(paper.json().toString()) }
            writer.write("],\"retiredPapers\":[")
            retired.forEachIndexed { index, paper -> operationContext.ensureActive(); if (index > 0) writer.write(","); writer.write(paper.json().toString()) }
            writer.write("]"); taxonomy?.let { writer.write(",\"websiteTaxonomy\":" + it.json().toString()) }; writer.write("}"); writer.flush(); operationContext.ensureActive()
        }
        snapshot = CatalogState(published, retired, summary, epoch, taxonomy)
        summary.copy()
    } }

    suspend fun article(paper: Paper, refresh: Boolean = false, onReadable: (Article) -> Unit = {}): Article = withContext(Dispatchers.IO) {
        require(paper.blogURL.isNotEmpty()) { "本地导入论文没有网站导读，可打开 PDF 后创建本机研究" }
        val file = File(directory, "articles/${sha256(paper.blogURL.toByteArray())}.json")
        val previous = if (file.isFile) Article.fromJson(JSONObject(JsonFiles.read(file, 100 * 1024 * 1024L).toString(Charsets.UTF_8))) else null
        val parserCurrent = previous?.let { it.markdown != null || ClientProtocols.isContract(it.mathMLContract,"published-html-mathml") } ?: false
        val sourceMatches = previous?.let { it.paperID == paper.id && it.blogURL == paper.blogURL && it.sourceURL == (paper.sourceURL ?: paper.blogURL) && it.pdfURL == paper.pdfURL && it.sourceVersion == paper.sourceVersion } ?: false
        if (!refresh && previous != null && parserCurrent && sourceMatches && previous.completeOffline && previous.catalogEpoch == epoch() && age(previous.fetchedAt) < 21600 && resourcesValid(previous)) return@withContext hydrateReading(previous)
        if (previous != null && parserCurrent && sourceMatches) onReadable(hydrateReading(previous.copy(isStale = true,
            notices = (previous.notices + "先显示已保存导读，正在后台核对网站当前版本。").distinct())))
        if (!refresh && previous == null && epoch() == "bundled-sample") seedArticle(paper)?.let { saveArticle(file, it); return@withContext hydrate(it) }
        try {
            require(!personal.settings().optBoolean("offlineMode")) { "当前为离线模式" }
            val citationRepository = citationRepo()
            val page = citationRepository.fetchPage(paper)
            var result: Article
            try {
                // One verified parse of this page; bindPage replays the same parse instead of parsing the bytes again.
                result = citationRepository.extractPage(paper, page, epoch())
                try { result = citationRepository.bindPage(paper, result, page) }
                catch (error: Exception) {
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    coroutineContext.ensureActive()
                    result = result.copy(notices = result.notices + "引用原件下载页面尚未封存；其他导读内容保持原样。")
                }
            } finally { citationRepository.releasePage(page) }
            // The sealed, sanitized body is useful before any optional scientific image or sidecar.
            // Save this partial version too: cancelling a prefetch must not discard readable text.
            // One body parse serves both the pending resource list and the sealed-image rewrite below.
            val doc = Jsoup.parseBodyFragment(result.html)
            result = result.copy(resources = doc.select("img").map { image ->
                ArticleResource(image.attr("src"), missingReason = "图片正在后台准备")
            }, completeOffline = false)
            previous?.let { preserve(it) }
            coroutineContext.ensureActive(); saveArticle(file, result)
            onReadable(hydrateReading(result))
            val images = mutableListOf<ArticleResource>(); val notices = result.notices.toMutableList()
            var total = 0
            for (image in doc.select("img")) {
                coroutineContext.ensureActive()
                val url = image.attr("src")
                try {
                    val data = readExternal(url, 16 * 1024 * 1024)
                    total += data.size; require(total <= 64 * 1024 * 1024) { "图片总量超过 64 MiB" }
                    imageMime(data)
                    val hash = sha256(data); val local = File(directory, "assets/$hash")
                    JsonFiles.write(local, data)
                    // Persistent scientific HTML keeps the declared source address, never Base64 copies.
                    image.attr("data-source-url", url).attr("loading", "lazy")
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
                try { sidecar = validatedSidecar(JSONObject(PublishedUtf8.decode(citationRepository.declaredBytes(paper,result,"citation.json"))), paper, false) }
                catch (error: Exception) { if (error is kotlinx.coroutines.CancellationException) throw error; coroutineContext.ensureActive(); notices += "引用附加文件尚未核验，保留页面已核验字段" }
            }
            citationFiles["rethink-context.json"]?.let { address ->
                try { context = validatedSidecar(JSONObject(PublishedUtf8.decode(citationRepository.declaredBytes(paper,result,"rethink-context.json"))), paper, true) }
                catch (error: Exception) { if (error is kotlinx.coroutines.CancellationException) throw error; coroutineContext.ensureActive(); notices += "研究上下文附加文件尚未读取" }
            }
            val original = result.json().put("citationSidecar", sidecar ?: JSONObject.NULL).put("citationFiles", JSONObject(citationFiles))
            result = result.copy(html = doc.body().html(), resources = images, completeOffline = images.all { it.localPath != null }, notices = notices.distinct(), researchContext = context, original = original)
            if (result.catalogEpoch != epoch()) result = result.copy(isStale = true, notices = result.notices + "读取期间目录发生更新，请刷新核验当前修订")
            previous?.let { preserve(it) }; preserve(result)
            coroutineContext.ensureActive(); saveArticle(file, result); hydrateReading(result)
        } catch (e: Exception) {
            coroutineContext.ensureActive()
            val old = previous ?: throw e
            hydrateReading(old.copy(isStale = true, completeOffline = resourcesValid(old), notices = (old.notices + (if (parserCurrent) emptyList() else listOf("这份旧 HTML 未经过公式结构保真读取，部分 MathML 可能缺失；原稿保留，请联网刷新。")) + "网站当前修订复验未完成，正在读取 ${old.fetchedAt} 保存的旧导读；原文版本 ${old.sourceVersion ?: "未标注"}。").distinct()))
        }
    }

    private val pdfReceipts = java.util.concurrent.ConcurrentHashMap<String, JSONObject>()
    fun pdfReceipt(id: String): JSONObject = pdfReceipts[id]?.copy() ?: JSONObject()
    /** Read the repository's exact published cache mapping only; never refresh or change receipts. */
    suspend fun cachedPDFBySHA(expectedSHA256: String): File? = withContext(Dispatchers.IO) {
        if (!com.nanless.paperdigest.cloud.BackupCodec.validSHA(expectedSHA256)) return@withContext null
        try {
            val file = com.nanless.paperdigest.cloud.BackupCodec.checkedFile(directory, "pdf/$expectedSHA256.pdf")
            require(file.length() in 1..(100L * 1024 * 1024) && com.nanless.paperdigest.cloud.BackupCodec.hash(file) == expectedSHA256)
            file
        } catch (_: Exception) { null }
    }
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
            recordOfflinePointer(pointer, receipt)
            file to hash
        } catch (e: Exception) {
            coroutineContext.ensureActive()
            val old = previous ?: throw e; val file = previousFile ?: throw e
            val stale = old.copy().put("isStale", true).put("cacheStatus", "stale").put("validationAttemptedAt", now()).put("notices", JSONArray(listOf("原文当前性复核未完成，正在读取先前保存的旧 SHA 副本；不代表网站当前原文。")))
            pdfReceipts[paper.id] = stale; JsonFiles.write(pointer, stale)
            recordOfflinePointer(pointer, stale)
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
        if (p.sourceKind != "arxiv" || p.sourceVersion == null || !ARXIV_VERSION_SUFFIX.containsMatchIn(p.sourceVersion)) return false
        val version = p.sourceVersion; val base = version.replace(ARXIV_VERSION_SUFFIX, "")
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
            ClientProtocols.record("android-bundled-research-context").put("sampleOnly", true).put("paperID", paper.id).put("abstract", sample.getString("abstract")).put("summary", primary.optString("summary")), pdfURL = paper.pdfURL, mathMLContract = "published-html-mathml")
        return seeded.copy(original = seeded.json().put("citationSidecar", validatedSidecar(sample.getJSONObject("citation"), paper, false)))
    }
    private fun resourcesValid(article: Article): Boolean = article.resources.all { r -> r.localPath != null && r.sha256 != null && runCatching { StoragePaths.resolve(r.localPath, personal.directory, r.sha256, 16 * 1024 * 1024L); true }.getOrDefault(false) }
    private fun hydrateReading(article: Article): Article = if (article.markdown != null) hydrate(article) else
        PublishedSourceWarning.present(article.copy(inlineImages = emptyMap(), displayImages = ArticleImageAccess(article, personal.directory)))
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
        // Exported/backup HTML must be self-contained; a UI-only random image route cannot escape.
        return PublishedSourceWarning.present(article.copy(inlineImages = map, displayImages = null))
    }
    private suspend fun read(url: String, limit: Int): ByteArray {
        fetchOverride?.let { return it(url, limit).also { b -> require(b.size <= limit) } }
        val safe = sameSite(url)
        val request = Request.Builder().url(safe)
        if (safe == SITE + "client/index.json" || safe == SITE + "index.json") {
            request.header("Cache-Control", "no-cache")
        }
        val response = publishedHttp.execute(request.build(), limit)
        if (response.code != 200) throw PublishedHttpStatus(response.code)
        return response.bytes
    }
    private suspend fun readExternal(initial: String, limit: Int): ByteArray {
        fetchOverride?.let { return it(initial, limit).also { bytes -> require(bytes.size <= limit) } }
        var url = initial
        repeat(6) {
            val uri = URI(url)
            require(approvedResource(uri)) { "原文或图片超出已支持的官方 HTTPS 来源" }
            val isArxiv = uri.host.lowercase() in setOf("arxiv.org", "export.arxiv.org")
            val proxy = personal.settings().nullableString("httpProxy")
            if (isArxiv) require(!proxy.isNullOrBlank()) { "arXiv 原文需要设置 HTTP CONNECT 代理；已有导读仍可阅读" }
            val http = if (uri.host == "nanless.github.io") publishedHttp else SafeHttp(if (isArxiv) proxy else null)
            val response = http.execute(Request.Builder().url(url).build(), limit)
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
        if (seed == null) return ClientProtocols.record("paperdigest-published-library").put("validationEpoch", "unsynced")
            .put("summary", JSONObject().put("paperCount", 0).put("recordCount", 0).put("shardCount", 0).put("source", "尚未同步网站论文").put("snapshotID", "unsynced").put("syncedAt", JSONObject.NULL))
            .put("papers", JSONArray())
        val rows = seed.optJSONArray("librarySample")?.objects() ?: emptyList()
        val papers = rows.map { row ->
            val id = row.getString("id"); val source = row.getString("absUrl"); val version = URI(source).path.substringAfterLast('/')
            Paper("arxiv:$id", row.getString("title"), row.optString("titleZh", row.getString("title")), row.optJSONArray("authors")?.objects()?.map { it.getString("name") } ?: emptyList(),
                row.optString("date"), Paper.score(row.opt("score")), row.optString("task"), row.optString("method"), row.optJSONArray("tags")?.strings() ?: emptyList(), "arxiv", "verified", row.getString("blogUrl"), source,
                row.getString("pdfUrl"), version, ClientProtocols.record("paper-citation-source").put("paperKey", "arxiv:$id").put("identityStatus", "verified").put("verified", true).put("complete", false).put("title", row.getString("title")).put("authors", JSONArray(row.optJSONArray("authors")?.objects()?.map { it.getString("name") } ?: emptyList<String>())).put("arxivId", version).put("sourceUrl", source).put("pdfUrl", row.getString("pdfUrl")).put("sourceKind", "arxiv"))
        }
        return ClientProtocols.record("paperdigest-published-library").put("validationEpoch", "bundled-sample")
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
            val base = arxiv.replace(ARXIV_VERSION_SUFFIX, "")
            val explicit = row.optString("paperId", citation.optString("paperId"))
            val id = if (status == "verified" && kind == "arxiv" && base.matches(ARXIV_ID_PATTERN)) "arxiv:$base" else if (status == "verified" && kind != "arxiv" && explicit.isNotEmpty()) explicit else "page:${URI(blog).path}"
            val title = row.optString("originalTitle", citation.optString("title", row.optString("title")))
            require(title.isNotEmpty()) { "论文目录缺少题名" }
            val hashes = listOf(row.nullableString("pdfSha256"), row.nullableString("pdfSHA256"), citation.nullableString("pdfSha256"), citation.nullableString("pdfSHA256")).filterNotNull().toSet()
            require(hashes.size <= 1 && hashes.all { it.matches(SHA256_PATTERN) }) { "已发布 PDF 指纹无效或相互矛盾" }
            val pdfSHA = hashes.firstOrNull()
            return Paper(id, title, row.optString("titleZh", row.optString("title", title)), citation.optJSONArray("authors")?.strings() ?: emptyList(), row.optString("date"), Paper.score(row.opt("score")), row.optString("task"), row.optString("method"), row.optJSONArray("tags")?.strings() ?: emptyList(), kind, status, blog,
                cleanHTTPS(citation.nullableString("sourceUrl") ?: citation.nullableString("url")), if (status == "verified") cleanHTTPS(citation.nullableString("pdfUrl")) else null, citation.nullableString("arxivId"), citation, pdfSHA, listOf(blog), original = JSONObject().put("websiteTagRecords", JSONArray().put(WebsiteTaxonomy.record(row))))
        }
        fun validatedSidecar(value: JSONObject, paper: Paper, context: Boolean): JSONObject {
            require(ClientProtocols.hasValidHeader(value,if(context)"paper-research-context" else "researcher-sidecars")) { "引用或上下文附加文件合同不受支持" }
            if (paper.identityStatus == "verified") {
                if (paper.sourceKind == "arxiv") {
                    val base = value.optString("arxivId", value.optString("id")).replace(ARXIV_VERSION_SUFFIX, "")
                    require("arxiv:$base" == paper.id) { "附加文件属于另一篇论文" }
                    if (paper.sourceVersion != null) listOf("arxivVersionedId", "id", "arxivId").mapNotNull { value.nullableString(it) }.forEach { id -> require(!ARXIV_VERSION_SUFFIX.containsMatchIn(id) || id == paper.sourceVersion) { "附加文件对应另一原文版本" } }
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
        fun extractArticle(raw: String, paper: Paper, epoch: String = ""): Article =
            extractArticle(Jsoup.parse(raw, paper.blogURL), paper, epoch)
        /** The same parser over an already verified parse: only the body subtree is copied, so the document stays
         * pristine and the caller can reuse it for declarations without parsing the same page twice. */
        internal fun extractArticle(document: Document, paper: Paper, epoch: String = ""): Article {
            val bodies = document.select("div#article-body.post-content")
            require(bodies.size == 1) { "网站正文结构发生变化，未读取导航内容或用模型补写" }
            val body = bodies.single().clone()
            val json = document.selectFirst("script.paper-tools__citation-record[type=application/json]")?.data()
                ?: document.selectFirst("[data-citation-record]")?.attr("data-citation-record")
            val citation = if (json.isNullOrBlank()) paper.citation else JSONObject(json)
            val owner = citation.optString("paperKey")
            require(paper.identityStatus != "verified" || owner.isEmpty() || owner == paper.id) { "页面正文与目录论文身份不符" }
            if (paper.identityStatus == "verified" && paper.sourceKind == "arxiv") {
                val version = citation.optString("arxivId")
                require(!ARXIV_VERSION_SUFFIX.containsMatchIn(version) || paper.sourceVersion == null || version == paper.sourceVersion) { "页面原文版本与目录不符" }
                listOf("sourceUrl" to paper.sourceURL, "pdfUrl" to paper.pdfURL).forEach { (key, expected) -> require(expected == null || citation.optString(key).isEmpty() || citation.optString(key) == expected) { "页面来源地址与目录不符" } }
            }
            sanitize(body, paper.blogURL)
            require(body.select("img").size <= 32) { "单篇科学图超过32张" }
            val html = body.html()
            return PublishedSourceWarning.present(Article(paper.id, html, articlePlainText(body), paper.sourceURL ?: paper.blogURL, paper.blogURL, sha256(html.toByteArray()), now(), paper.sourceVersion, false, emptyList(), false, citation, catalogEpoch = epoch, pdfURL = paper.pdfURL, mathMLContract = "published-html-mathml"))
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
            val allowed = HTML_ALLOWED_TAGS
            val attrs = HTML_ALLOWED_ATTRS
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

/** One article cache file: identity plus enough metadata to detect replacement without parsing it. */
internal data class OfflineArticleIndexEntry(val paperID: String?, val hasBody: Boolean, val bytes: Long, val modifiedMs: Long)
/** One PDF pointer file and the already verified local original it resolves to. */
internal data class OfflinePdfIndexEntry(val paperID: String, val pointerBytes: Long, val pointerModifiedMs: Long,
    val originalPath: String, val originalBytes: Long, val originalModifiedMs: Long)
internal data class OfflineIndexSnapshot(val articles: Map<String, OfflineArticleIndexEntry>, val pdfPointers: Map<String, OfflinePdfIndexEntry>)

/**
 * Derived startup cache for [CatalogRepository.offlinePaperIDs]. It is never authority for
 * publication or reading: every entry is revalidated against the actual file size and
 * modification time (metadata only), and any missing, extra or changed directory entry makes
 * the whole snapshot unusable so the caller performs one real scan and rebuilds it atomically.
 */
internal object OfflineIndex {
    const val FORMAT = "paperdigest-android-offline-index"
    const val VERSION = 1
    const val MAX_BYTES = 16L * 1024 * 1024
    const val MAX_ENTRIES = 100000
    private val ROOT_KEYS = setOf("format", "version", "articles", "pdfPointers")
    private val ARTICLE_KEYS = setOf("paperID", "hasBody", "bytes", "modifiedMs")
    private val PDF_KEYS = setOf("paperID", "pointerBytes", "pointerModifiedMs", "originalPath", "originalBytes", "originalModifiedMs")

    // Article caches are normally "<sha256>.json"; the fallback scan accepts any plain file name,
    // so the index accepts the same names while rejecting separators, controls and traversal.
    private fun validCacheName(name: String): Boolean = name.endsWith(".json") && name != "." && name != ".." &&
        name.length <= 255 && name.none { it == '/' || it == '\\' || it.code < 32 }

    private fun signature(file: File): Pair<Long, Long>? = runCatching {
        require(file.isFile && !Files.isSymbolicLink(file.toPath()))
        file.length() to file.lastModified()
    }.getOrNull()

    private fun names(directory: File): Set<String>? {
        if (!directory.exists()) return emptySet()
        if (!directory.isDirectory || Files.isSymbolicLink(directory.toPath())) return null
        val files = directory.listFiles() ?: return null
        return files.filter { it.isFile && it.name.endsWith(".json") && !Files.isSymbolicLink(it.toPath()) }.mapTo(linkedSetOf()) { it.name }
    }

    /** Null when the cache file itself cannot be measured, so the caller must scan. */
    fun articleEntry(file: File, paperID: String?, hasBody: Boolean): OfflineArticleIndexEntry? {
        val (bytes, modified) = signature(file) ?: return null
        val identity = paperID?.takeIf { it.isNotEmpty() }
        return OfflineArticleIndexEntry(identity, hasBody && identity != null, bytes, modified)
    }

    /** Null when the pointer or its original changed/moved; the caller then rescans instead of trusting an old entry. */
    fun pdfEntry(pointer: File, receipt: JSONObject, original: File): OfflinePdfIndexEntry? {
        val paperID = receipt.optString("paperID").takeIf { it.isNotEmpty() } ?: return null
        val (pointerBytes, pointerModified) = signature(pointer) ?: return null
        val (originalBytes, originalModified) = signature(original) ?: return null
        val receiptBytes = (receipt.opt("bytes") as? Number)?.toLong() ?: -1L
        if (receiptBytes >= 0 && receiptBytes != originalBytes) return null
        return OfflinePdfIndexEntry(paperID, pointerBytes, pointerModified, original.absolutePath, originalBytes, originalModified)
    }

    /** Fallback scan: parse every cached article once. An unreadable file still gets an entry so
     * one corrupt cache cannot force the same full scan on every subsequent start. */
    fun scanArticles(articles: File): Pair<Map<String, OfflineArticleIndexEntry>, Set<String>> {
        val entries = sortedMapOf<String, OfflineArticleIndexEntry>()
        val ids = linkedSetOf<String>()
        articles.listFiles()?.filter { it.isFile && it.name.endsWith(".json") }?.sortedBy { it.name }?.forEach { file ->
            val decoded = runCatching {
                val article = Article.fromJson(JSONObject(JsonFiles.read(file, 128 * 1024 * 1024L).toString(Charsets.UTF_8)))
                article.paperID to (article.html.isNotBlank() || !article.markdown.isNullOrBlank())
            }.getOrNull()
            val entry = articleEntry(file, decoded?.first, decoded?.second ?: false) ?: return@forEach
            entries[file.name] = entry
            if (entry.hasBody) entry.paperID?.let(ids::add)
        }
        return entries to ids
    }

    /** Fallback scan: the resolver must return the already verified local original, or null. */
    fun scanPointers(pointers: File, original: (JSONObject) -> File?): Pair<Map<String, OfflinePdfIndexEntry>, Set<String>> {
        val entries = sortedMapOf<String, OfflinePdfIndexEntry>()
        val ids = linkedSetOf<String>()
        pointers.listFiles()?.filter { it.isFile && it.name.endsWith(".json") }?.sortedBy { it.name }?.forEach { file ->
            val entry = runCatching {
                val receipt = JSONObject(JsonFiles.read(file, 1024 * 1024L).toString(Charsets.UTF_8))
                pdfEntry(file, receipt, original(receipt) ?: error("原文指针无法定位已核验原文件")) ?: error("原文指针缺少离线索引字段")
            }.getOrNull() ?: run {
                // 坏指针也记一条负条目，只用于让下次启动的目录集合对得上；不参与离线集合。
                val (bytes, modified) = signature(file) ?: return@forEach
                OfflinePdfIndexEntry("", bytes, modified, "", 0, 0)
            }
            entries[file.name] = entry
            if (entry.paperID.isNotEmpty()) ids += entry.paperID
        }
        return entries to ids
    }

    /** A missing, oversized, unreadable, malformed or future-format index is not a success. */
    fun read(file: File): OfflineIndexSnapshot? {
        val (bytes, _) = signature(file) ?: return null
        if (bytes !in 1..MAX_BYTES) return null
        val raw = runCatching { JsonFiles.read(file, MAX_BYTES).toString(Charsets.UTF_8) }.getOrNull() ?: return null
        return runCatching { parse(JSONObject(raw)) }.getOrNull()
    }

    fun parse(value: JSONObject): OfflineIndexSnapshot {
        require(value.keys().asSequence().toSet() == ROOT_KEYS) { "离线索引字段不符" }
        require(value.getString("format") == FORMAT) { "离线索引格式不符" }
        val version = value.get("version") as? Number ?: error("离线索引版本不符")
        require(version.toLong() == VERSION.toLong() && version.toDouble() == VERSION.toDouble()) { "离线索引版本不符" }
        val articlesJson = value.getJSONObject("articles"); val pdfJson = value.getJSONObject("pdfPointers")
        require(articlesJson.length() <= MAX_ENTRIES && pdfJson.length() <= MAX_ENTRIES) { "离线索引条目超过范围" }
        val articles = LinkedHashMap<String, OfflineArticleIndexEntry>()
        articlesJson.keys().forEach { name ->
            require(validCacheName(name)) { "离线索引文章文件名无效" }
            val row = articlesJson.getJSONObject(name)
            require(row.keys().asSequence().toSet() == ARTICLE_KEYS) { "离线索引文章条目字段不符" }
            val paperID = if (row.isNull("paperID")) null else row.getString("paperID").also { require(it.isNotBlank()) { "离线索引文章身份为空" } }
            val hasBody = row.opt("hasBody") as? Boolean ?: error("离线索引正文标记不符")
            require(!hasBody || paperID != null) { "离线索引正文缺少论文身份" }
            val bytes = row.getLong("bytes"); require(bytes >= 0) { "离线索引文章大小无效" }
            val modified = row.getLong("modifiedMs"); require(modified >= 0) { "离线索引文章时间无效" }
            articles[name] = OfflineArticleIndexEntry(paperID, hasBody, bytes, modified)
        }
        val pdfPointers = LinkedHashMap<String, OfflinePdfIndexEntry>()
        pdfJson.keys().forEach { name ->
            require(validCacheName(name)) { "离线索引原文指针文件名无效" }
            val row = pdfJson.getJSONObject(name)
            require(row.keys().asSequence().toSet() == PDF_KEYS) { "离线索引原文条目字段不符" }
            val paperID = row.getString("paperID")
            val pointerBytes = row.getLong("pointerBytes"); require(pointerBytes >= 0) { "离线索引原文指针大小无效" }
            val pointerModified = row.getLong("pointerModifiedMs"); require(pointerModified >= 0) { "离线索引原文指针时间无效" }
            val originalPath = row.getString("originalPath")
            if (paperID.isNotEmpty()) require(originalPath.isNotBlank() && originalPath.length <= 4096 && File(originalPath).isAbsolute) { "离线索引原文路径无效" }
            else require(originalPath.isEmpty()) { "离线索引无效原文条目不得带路径" }
            val originalBytes = row.getLong("originalBytes"); require(originalBytes >= 0) { "离线索引原文大小无效" }
            val originalModified = row.getLong("originalModifiedMs"); require(originalModified >= 0) { "离线索引原文时间无效" }
            pdfPointers[name] = OfflinePdfIndexEntry(paperID, pointerBytes, pointerModified, originalPath, originalBytes, originalModified)
        }
        return OfflineIndexSnapshot(articles, pdfPointers)
    }

    /** Null means the index disagrees with the directory; never return a partial or stale set. */
    fun offlineIDs(snapshot: OfflineIndexSnapshot, articles: File, pdfPointers: File): Set<String>? {
        val articleNames = names(articles) ?: return null
        if (articleNames != snapshot.articles.keys) return null
        val ids = linkedSetOf<String>()
        snapshot.articles.forEach { (name, entry) ->
            val (bytes, modified) = signature(File(articles, name)) ?: return null
            if (bytes != entry.bytes || modified != entry.modifiedMs) return null
            if (entry.hasBody) ids += entry.paperID ?: return null
        }
        val pdfNames = names(pdfPointers) ?: return null
        if (pdfNames != snapshot.pdfPointers.keys) return null
        snapshot.pdfPointers.forEach { (name, entry) ->
            val (bytes, modified) = signature(File(pdfPointers, name)) ?: return null
            if (bytes != entry.pointerBytes || modified != entry.pointerModifiedMs) return null
            if (entry.paperID.isEmpty()) return@forEach
            val (originalBytes, originalModified) = signature(File(entry.originalPath)) ?: return null
            if (originalBytes != entry.originalBytes || originalModified != entry.originalModifiedMs) return null
            ids += entry.paperID
        }
        return ids
    }

    private fun envelope(snapshot: OfflineIndexSnapshot): JSONObject {
        val articles = JSONObject()
        snapshot.articles.toSortedMap().forEach { (name, entry) ->
            articles.put(name, JSONObject().put("paperID", entry.paperID ?: JSONObject.NULL).put("hasBody", entry.hasBody)
                .put("bytes", entry.bytes).put("modifiedMs", entry.modifiedMs))
        }
        val pdf = JSONObject()
        snapshot.pdfPointers.toSortedMap().forEach { (name, entry) ->
            pdf.put(name, JSONObject().put("paperID", entry.paperID).put("pointerBytes", entry.pointerBytes)
                .put("pointerModifiedMs", entry.pointerModifiedMs).put("originalPath", entry.originalPath)
                .put("originalBytes", entry.originalBytes).put("originalModifiedMs", entry.originalModifiedMs))
        }
        return JSONObject().put("format", FORMAT).put("version", VERSION).put("articles", articles).put("pdfPointers", pdf)
    }

    /** Same atomic replacement and canonical JSON as other new local identities. */
    fun write(file: File, snapshot: OfflineIndexSnapshot) {
        require(snapshot.articles.size <= MAX_ENTRIES && snapshot.pdfPointers.size <= MAX_ENTRIES) { "离线索引条目超过范围" }
        val encoded = canonical(envelope(snapshot)).toByteArray(Charsets.UTF_8)
        require(encoded.size <= MAX_BYTES) { "离线索引超过大小限制" }
        JsonFiles.write(file, encoded)
    }
}

/** Actual HTTP status only; parse, integrity and transport failures never trigger endpoint fallback. */
internal class PublishedHttpStatus(val status:Int):java.io.IOException("网站资料暂不可用，原资料保留（HTTP $status）")
