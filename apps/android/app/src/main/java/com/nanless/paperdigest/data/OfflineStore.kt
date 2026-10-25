package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.cloud.CloudManifest
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import java.io.File
import java.math.BigDecimal
import java.math.BigInteger
import java.math.MathContext
import java.math.RoundingMode
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.text.Collator
import java.time.Instant
import java.util.Base64
import java.util.Locale
import java.util.UUID

/** Foundation JSONSerialization.sortedKeys, used ONLY by the existing offline contract. */
object OfflineFoundationJSON {
    private val collator = ThreadLocal.withInitial { Collator.getInstance(Locale.US) }
    private fun keyCompare(a: String, b: String): Int {
        var ai = 0; var bi = 0
        while (ai < a.length && bi < b.length) {
            val ad = a[ai] in '0'..'9'; val bd = b[bi] in '0'..'9'
            var ae = ai + 1; while (ae < a.length && (a[ae] in '0'..'9') == ad) ae++
            var be = bi + 1; while (be < b.length && (b[be] in '0'..'9') == bd) be++
            val av = a.substring(ai, ae); val bv = b.substring(bi, be)
            val cmp = if (ad && bd) { val n = BigInteger(av).compareTo(BigInteger(bv)); if (n != 0) n else av.length.compareTo(bv.length) } else collator.get().compare(av, bv)
            if (cmp != 0) return cmp; ai = ae; bi = be
        }
        val size = (a.length - ai).compareTo(b.length - bi)
        return if (size != 0) size else a.compareTo(b)
    }
    fun encode(value: Any?): ByteArray = text(value).toByteArray(Charsets.UTF_8)
    // Foundation parses JSON -0 as integer zero. Normalize consistently on both
    // JVM and Android; preserve large integers and binary floating-point meaning.
    fun parse(bytes: ByteArray): JSONObject = LosslessJSON(Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes)).toString()).root()
    private class LosslessJSON(private val input: String) {
        private var at = 0
        private fun ws() { while (at < input.length && input[at] in " \t\r\n") at++ }
        private fun take(c: Char) { ws(); require(at < input.length && input[at++] == c) { "离线JSON格式无效" } }
        private fun string(): String {
            take('"'); val out = StringBuilder()
            while (true) {
                require(at < input.length); val c = input[at++]; if (c == '"') return out.toString(); require(c.code >= 32)
                if (c != '\\') out.append(c) else {
                    require(at < input.length); out.append(when (val escaped = input[at++]) {
                        '"', '\\', '/' -> escaped; 'b' -> '\b'; 'f' -> '\u000c'; 'n' -> '\n'; 'r' -> '\r'; 't' -> '\t'
                        'u' -> { require(at + 4 <= input.length); val hex = input.substring(at, at + 4); require(hex.all { it in "0123456789abcdefABCDEF" }); at += 4; hex.toInt(16).toChar() }
                        else -> error("离线JSON转义无效")
                    })
                }
            }
        }
        private fun value(depth: Int): Any {
            require(depth <= 512); ws(); require(at < input.length)
            return when (input[at]) {
                '{' -> { take('{'); val obj = JSONObject(); ws(); if (at < input.length && input[at] == '}') { at++; obj } else { while (true) { val key = string(); require(!obj.has(key)); take(':'); obj.put(key, value(depth + 1)); ws(); require(at < input.length); if (input[at++] == '}') break; require(input[at - 1] == ',') }; obj } }
                '[' -> { take('['); val array = JSONArray(); ws(); if (at < input.length && input[at] == ']') { at++; array } else { while (true) { array.put(value(depth + 1)); ws(); require(at < input.length); if (input[at++] == ']') break; require(input[at - 1] == ',') }; array } }
                '"' -> string()
                't' -> { require(input.startsWith("true", at)); at += 4; true }
                'f' -> { require(input.startsWith("false", at)); at += 5; false }
                'n' -> { require(input.startsWith("null", at)); at += 4; JSONObject.NULL }
                else -> {
                    val start = at; while (at < input.length && input[at] in "-+0123456789.eE") at++
                    val token = input.substring(start, at); require(Regex("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?").matches(token))
                    if (token == "-0") 0L else if (token.any { it == '.' || it == 'e' || it == 'E' }) token.toDouble().also { require(it.isFinite()) }
                    else token.toLongOrNull() ?: BigInteger(token)
                }
            }
        }
        fun root(): JSONObject { val result = value(0) as? JSONObject ?: error("离线元数据不是对象"); ws(); require(at == input.length); return result }
    }
    private fun quote(value: String): String = buildString {
        append('"'); value.forEach { c -> when (c) {
            '"' -> append("\\\""); '\\' -> append("\\\\"); '/' -> append("\\/"); '\b' -> append("\\b"); '\u000c' -> append("\\f"); '\n' -> append("\\n"); '\r' -> append("\\r"); '\t' -> append("\\t")
            else -> if (c.code < 32) append("\\u%04x".format(Locale.ROOT, c.code)) else append(c)
        } }; append('"')
    }
    private fun number(value: Number): String {
        if (value is Byte || value is Short || value is Int || value is Long || value is BigInteger) return value.toString()
        val d = value.toDouble(); require(d.isFinite()) { "离线合同不支持非有限数" }
        if (d == 0.0) return if (java.lang.Double.doubleToRawLongBits(d) < 0) "-0" else "0"
        val rounded = BigDecimal(d).round(MathContext(17, RoundingMode.HALF_EVEN)).stripTrailingZeros()
        val exponent = rounded.precision() - rounded.scale() - 1
        if (exponent in -4..16) return rounded.toPlainString()
        val coefficient = rounded.movePointLeft(exponent).stripTrailingZeros().toPlainString()
        return coefficient + "e" + (if (exponent < 0) "-" else "+") + kotlin.math.abs(exponent).toString().padStart(2, '0')
    }
    private fun text(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is String -> quote(value)
        is Boolean -> value.toString()
        is Number -> number(value)
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { text(value.get(it)) }
        is JSONObject -> value.keys().asSequence().toList().sortedWith(::keyCompare).joinToString(",", "{", "}") { quote(it) + ":" + text(value.get(it)) }
        else -> error("离线元数据类型尚不支持")
    }
}

/** Reading snapshots never grant publication, credential or model request eligibility. */
class OfflineStore(private val root: File) {
    data class Opened(val id: String, val paper: Paper, val article: Article, val pdfFile: File?, val paperJSON: JSONObject, val articleJSON: JSONObject)
    private val directory = File(root, "Offline")
    private val lock = Any()
    private fun location(id: String): File { require(BackupCodec.validSHA(id)) { "离线包身份无效" }; return File(directory, id) }
    private fun clone(o: JSONObject): JSONObject = OfflineFoundationJSON.parse(OfflineFoundationJSON.encode(o))
    private fun sha(value: Any?) = BackupCodec.hash(OfflineFoundationJSON.encode(value))
    private fun nullable(o: JSONObject, key: String): String? = if (!o.has(key) || o.isNull(key)) null else o.getString(key)
    private fun https(value: String): Boolean = runCatching { java.net.URI(value).let { it.scheme == "https" && it.host != null && it.userInfo == null } }.getOrDefault(false)
    private fun articleContent(article: JSONObject): JSONObject = clone(article).also { content ->
        listOf("fetchedAt", "catalogEpoch", "cacheStatus", "isStale", "validationAttemptedAt", "expectedSourceVersion", "notices").forEach(content::remove)
        content.optJSONArray("resources")?.let { content.put("resources", JSONArray(it.objects().map { r -> clone(r).also { v -> v.remove("localPath") } })) }
    }
    private fun paperContent(paper: JSONObject) = clone(paper).also { it.remove("offlineMode"); it.remove("offlinePackageID") }
    fun list(): List<JSONObject> = synchronized(lock) {
        if (!directory.exists()) return@synchronized emptyList()
        BackupCodec.checkedDirectory(directory)
        directory.listFiles().orEmpty().filter { !it.name.startsWith(".prepare-") }.sortedBy { it.name }.map { folder ->
            try { summary(verify(folder.name)) } catch (_: Exception) { JSONObject().put("id", folder.name).put("status", "corrupt").put("message", "离线包校验失败，原文件已保留") }
        }
    }
    private fun summary(manifest: JSONObject): JSONObject = JSONObject().put("id", manifest.getString("id")).put("paperID", manifest.getString("paperID")).put("title", manifest.getString("title"))
        .put("sourceVersion", manifest.opt("sourceVersion") ?: JSONObject.NULL).put("revisionSHA256", manifest.getString("articleRevisionSHA256")).put("pdfSHA256", manifest.opt("pdfSHA256") ?: "")
        .put("files", manifest.getJSONArray("files").length()).put("bytes", manifest.getJSONArray("files").objects().sumOf { it.getLong("bytes") }).put("createdAt", manifest.getString("createdAt")).put("status", "verified").put("hasPDF", nullable(manifest, "pdfSHA256") != null)
    private fun verify(id: String): JSONObject = verifyAt(location(id), id)
    private fun verifyAt(folder: File, id: String): JSONObject {
        BackupCodec.checkedDirectory(folder)
        val manifest = OfflineFoundationJSON.parse(JsonFiles.read(BackupCodec.checkedFile(folder, "manifest.json"), 2 * 1024 * 1024L))
        val version = manifest.getString("contract")
        require(version in setOf("paperdigest-offline-package-v1", "paperdigest-offline-package-v2") && manifest.getString("id") == id && manifest.getString("paperID").isNotEmpty() && https(manifest.getString("blogURL")) && https(manifest.getString("sourceURL")) && BackupCodec.validSHA(manifest.getString("articleRevisionSHA256"))) { "离线包合同或来源无效" }
        val entries = manifest.getJSONArray("files").objects(); require(entries.size in 2..35)
        val names = HashSet<String>(); val limits = mapOf("paper" to 8L * 1024 * 1024, "article" to 128L * 1024 * 1024, "pdf" to 100L * 1024 * 1024, "image" to 16L * 1024 * 1024)
        entries.forEach { entry ->
            val path = entry.getString("path"); val role = entry.getString("role"); val hash = entry.getString("sha256"); val bytes = CloudManifest.number(entry, "bytes")
            require(names.add(path) && BackupCodec.validSHA(hash) && bytes in 0..(limits[role] ?: -1) && https(entry.getString("sourceURL")))
            require(when (role) { "paper" -> path == "paper.json"; "article" -> path == "article.json"; "pdf" -> path == "original.pdf"; "image" -> path == "resources/$hash.bin"; else -> false })
            val file = BackupCodec.checkedFile(folder, path); require(file.length() == bytes && BackupCodec.hash(file) == hash) { "离线文件大小或SHA损坏" }
        }
        val pdfHash = nullable(manifest, "pdfSHA256"); val pdfURL = nullable(manifest, "pdfURL")
        require(names.containsAll(listOf("paper.json", "article.json")) && entries.count { it.getString("role") == "pdf" } == if (pdfHash == null) 0 else 1)
        if (pdfHash != null) require(entries.any { it.getString("role") == "pdf" && it.getString("sha256") == pdfHash })
        val paper = OfflineFoundationJSON.parse(JsonFiles.read(BackupCodec.checkedFile(folder, "paper.json"), 8 * 1024 * 1024L))
        val article = OfflineFoundationJSON.parse(JsonFiles.read(BackupCodec.checkedFile(folder, "article.json"), 128 * 1024 * 1024L))
        require(article.getString("paperID") == manifest.getString("paperID") && paper.optString("id", paper.optString("paperID")) == manifest.getString("paperID") && paper.getString("blogURL") == manifest.getString("blogURL") && article.getString("sourceURL") == manifest.getString("sourceURL") && (nullable(paper, "sourceURL") ?: manifest.getString("blogURL")) == manifest.getString("sourceURL"))
        require(nullable(paper, "sourceVersion") == nullable(manifest, "sourceVersion") && nullable(article, "sourceVersion") == nullable(manifest, "sourceVersion") && nullable(article, "pdfURL") == nullable(paper, "pdfURL") && (if (pdfHash == null) pdfURL == null else pdfURL == nullable(paper, "pdfURL")))
        require(article.getString("revisionSHA256") == manifest.getString("articleRevisionSHA256") && article.opt("completeOffline") == true && article.opt("isStale") != true)
        val resources = article.getJSONArray("resources").objects()
        require(entries.count { it.getString("role") == "image" } == resources.mapNotNull { nullable(it, "sha256") }.toSet().size)
        entries.forEach { e -> when (e.getString("role")) { "pdf" -> require(e.getString("sourceURL") == pdfURL); "image" -> require(resources.any { it.optString("sha256") == e.getString("sha256") && it.optString("sourceURL") == e.getString("sourceURL") }); else -> Unit } }
        require(sha(articleContent(article)) == manifest.getString("articleContentSHA256")) { "离线导读元数据身份不符" }
        val identity = JSONObject().put("articleSHA256", manifest.getString("articleContentSHA256")).put("paperID", manifest.getString("paperID")).put("revision", manifest.getString("articleRevisionSHA256")).put("sourceURL", manifest.getString("sourceURL")).put("sourceVersion", nullable(manifest, "sourceVersion") ?: JSONObject.NULL).put("pdfSHA256", pdfHash ?: "").put("images", JSONArray(entries.filter { it.getString("role") == "image" }.map { it.getString("sha256") }.sorted()))
        if (version == "paperdigest-offline-package-v2") { val paperHash = sha(paperContent(paper)); require(paperHash == manifest.getString("paperContentSHA256")); identity.put("paperSHA256", paperHash) }
        else require(nullable(manifest, "paperContentSHA256") == null)
        require(sha(identity) == id) { "离线包整体身份不符" }
        Files.walk(folder.toPath()).use { stream -> stream.forEach { path ->
            require(!Files.isSymbolicLink(path) && (Files.isDirectory(path) || Files.isRegularFile(path)))
            if (Files.isRegularFile(path)) require(folder.toPath().relativize(path).toString().replace(File.separatorChar, '/') in names + "manifest.json") { "离线包有未登记文件" }
        } }
        return manifest
    }
    fun open(id: String): Opened = synchronized(lock) {
        val folder = location(id); val before = JsonFiles.read(BackupCodec.checkedFile(folder, "manifest.json"), 2 * 1024 * 1024L); val manifest = verify(id)
        val paperBytes = JsonFiles.read(BackupCodec.checkedFile(folder, "paper.json"), 8 * 1024 * 1024L)
        val articleBytes = JsonFiles.read(BackupCodec.checkedFile(folder, "article.json"), 128 * 1024 * 1024L)
        val files = manifest.getJSONArray("files").objects()
        require(BackupCodec.hash(paperBytes) == files.first { it.getString("path") == "paper.json" }.getString("sha256") && BackupCodec.hash(articleBytes) == files.first { it.getString("path") == "article.json" }.getString("sha256")) { "实际读取的离线正文与原包SHA不符" }
        val paper = OfflineFoundationJSON.parse(paperBytes)
        val article = OfflineFoundationJSON.parse(articleBytes)
        val mapped = article.getJSONArray("resources").objects().map { r -> val e = files.first { it.getString("role") == "image" && it.getString("sha256") == r.getString("sha256") }; clone(r).put("localPath", BackupCodec.checkedFile(folder, e.getString("path")).absolutePath) }
        article.put("resources", JSONArray(mapped)).put("offlineMode", true).put("offlinePackageID", id).put("cacheStatus", "offline").put("websiteFreshness", "not-checked")
        if (!article.has("blogURL")) article.put("blogURL", manifest.getString("blogURL"))
        val notices = article.optJSONArray("notices")?.strings().orEmpty().toMutableList(); notices += "正在阅读离线原始快照，未联网核对后续修订、移除或撤稿，不代表网站最新内容。"
        if (nullable(article, "markdown").isNullOrEmpty() && nullable(article, "mathMLContract") != "published-html-mathml-v1") notices += "旧离线HTML未经过公式结构保真读取，部分MathML可能缺失；原包不变，请对照原始PDF核对。"
        article.put("notices", JSONArray(notices.distinct().sorted())); paper.put("offlineMode", true).put("offlinePackageID", id)
        // Display projection embeds original images; the protected article.json remains unchanged.
        val sources = mapped.associateBy { it.getString("sourceURL") }; val doc = Jsoup.parseBodyFragment(article.getString("html"))
        for (img in doc.select("img[src]")) sources[img.attr("src")]?.let { resource -> val file = File(resource.getString("localPath")); val data = JsonFiles.read(file, 16 * 1024 * 1024L); require(BackupCodec.hash(data) == resource.getString("sha256")) { "实际读取的离线图与原SHA不符" }; img.attr("src", "data:" + CatalogRepository.imageMime(data) + ";base64," + Base64.getEncoder().encodeToString(data)) }
        article.put("html", doc.body().html())
        verify(id); require(before.contentEquals(JsonFiles.read(BackupCodec.checkedFile(folder, "manifest.json"), 2 * 1024 * 1024L))) { "读取期间离线清单变化" }
        val pdf = if (nullable(manifest, "pdfSHA256") != null) BackupCodec.checkedFile(folder, "original.pdf") else null
        Opened(id, Paper.fromJson(paper), Article.fromJson(article), pdf, paper, article)
    }
    fun register(paper: Paper, article: Article, pdfFile: File? = null): JSONObject = synchronized(lock) {
        require(article.paperID == paper.id && article.completeOffline && !article.isStale && https(paper.blogURL) && https(article.sourceURL) && article.sourceURL == (paper.sourceURL ?: paper.blogURL) && article.sourceVersion == paper.sourceVersion && BackupCodec.validSHA(article.revisionSHA256)) { "须先保存当前完整、来源一致的真实导读" }
        val originalArticle = article.original?.let(::clone) ?: article.json()
        originalArticle.put("completeOffline", article.completeOffline).put("isStale", article.isStale).put("notices", JSONArray(article.notices))
        require(originalArticle.getString("paperID") == article.paperID && originalArticle.getString("revisionSHA256") == article.revisionSHA256 && originalArticle.getString("sourceURL") == article.sourceURL && nullable(originalArticle, "sourceVersion") == article.sourceVersion)
        val cache = BackupCodec.checkedFile(root, "PublishedLibrary/articles/${BackupCodec.hash(paper.blogURL.toByteArray())}.json")
        val cached = OfflineFoundationJSON.parse(JsonFiles.read(cache, 128 * 1024 * 1024L)); require(cached.opt("isStale") != true)
        val fields = listOf("paperID", "html", "markdown", "plainText", "citation", "sourceURL", "pdfURL", "sourceVersion", "revisionSHA256", "resources")
        fun projection(o: JSONObject) = JSONObject().also { p -> fields.forEach { p.put(it, o.opt(it) ?: JSONObject.NULL) } }
        require(OfflineFoundationJSON.encode(projection(cached)).contentEquals(OfflineFoundationJSON.encode(projection(originalArticle)))) { "普通JSON不能替代相符的实际网站缓存" }
        val paperJSON = paper.json(); val payloads = linkedMapOf<String, Triple<ByteArray, String, String>>()
        payloads["paper.json"] = Triple(OfflineFoundationJSON.encode(paperJSON), "paper", paper.blogURL)
        payloads["article.json"] = Triple(OfflineFoundationJSON.encode(originalArticle), "article", paper.blogURL)
        var pdfHash: String? = null
        if (pdfFile != null) {
            require(paper.pdfURL != null && https(paper.pdfURL)); pdfHash = BackupCodec.hash(pdfFile)
            if (paper.pdfSHA256 != null) require(paper.pdfSHA256 == pdfHash) { "原文与已发布PDF指纹不符" }
            else {
                val shared = File(root, "PublishedLibrary/pdf-pointers/${BackupCodec.hash(paper.pdfURL.toByteArray())}.json")
                val legacy = File(root, "PublishedLibrary/pdf/${BackupCodec.hash(paper.id.toByteArray())}.json")
                val pointerFile = if (shared.isFile) shared else legacy
                val pointer = OfflineFoundationJSON.parse(JsonFiles.read(pointerFile, 1024 * 1024L))
                require(pointer.getString("sourceURL") == paper.pdfURL && pointer.getString("sha256") == pdfHash && (nullable(pointer, "version") ?: nullable(pointer, "sourceVersion")) == paper.sourceVersion) { "原文缺少相符的真实下载来源回执" }
                if (pointer.has("bytes")) require(pointer.getLong("bytes") == pdfFile.length())
                nullable(pointer, "filePath")?.let { old -> require(StoragePaths.resolve(old, root, pdfHash).canonicalFile == pdfFile.canonicalFile) }
            }
            val verified = StoragePaths.resolve(pdfFile.absolutePath, root, pdfHash, 100L * 1024 * 1024)
            require(JsonFiles.read(verified, 100L * 1024 * 1024).take(5).toByteArray().contentEquals("%PDF-".toByteArray()))
            PDDocument.load(verified, MemoryUsageSetting.setupTempFileOnly()).use { require(it.numberOfPages > 0) }
            payloads["original.pdf"] = Triple(JsonFiles.read(verified, 100L * 1024 * 1024), "pdf", paper.pdfURL)
        }
        val resources = originalArticle.getJSONArray("resources").objects(); require(resources.size <= 32); var total = 0L
        resources.forEach { r ->
            require(r.getString("kind") == "image" && https(r.getString("sourceURL")))
            val hash = r.getString("sha256"); val file = StoragePaths.resolve(r.getString("localPath"), root, hash, 16L * 1024 * 1024); val bytes = JsonFiles.read(file, 16L * 1024 * 1024)
            total += bytes.size; require(total <= 64L * 1024 * 1024)
            payloads.putIfAbsent("resources/$hash.bin", Triple(bytes, "image", r.getString("sourceURL")))
        }
        val contentHash = sha(articleContent(originalArticle)); val paperHash = sha(paperContent(paperJSON)); val imageHashes = payloads.filterValues { it.second == "image" }.values.map { BackupCodec.hash(it.first) }.sorted()
        val identity = JSONObject().put("paperSHA256", paperHash).put("articleSHA256", contentHash).put("paperID", paper.id).put("revision", article.revisionSHA256).put("sourceURL", article.sourceURL).put("sourceVersion", article.sourceVersion ?: JSONObject.NULL).put("pdfSHA256", pdfHash ?: "").put("images", JSONArray(imageHashes))
        val id = sha(identity); if (location(id).exists()) return@synchronized summary(verify(id)).put("reused", true)
        if (!directory.exists()) require(directory.mkdir()); BackupCodec.checkedDirectory(directory); BackupCodec.privateDirectory(directory)
        val stage = File(directory, ".prepare-${UUID.randomUUID()}"); require(stage.mkdir()); BackupCodec.privateDirectory(stage)
        try {
            val entries = JSONArray(); payloads.forEach { (path, item) -> val file = File(stage, path); BackupCodec.atomicBytes(file, item.first); entries.put(JSONObject().put("path", path).put("bytes", item.first.size).put("sha256", BackupCodec.hash(item.first)).put("role", item.second).put("sourceURL", item.third)) }
            val manifest = JSONObject().put("contract", "paperdigest-offline-package-v2").put("id", id).put("paperID", paper.id).put("title", paper.titleZh).put("createdAt", Instant.now().toString()).put("blogURL", paper.blogURL).put("sourceURL", article.sourceURL).put("sourceVersion", article.sourceVersion ?: JSONObject.NULL).put("articleRevisionSHA256", article.revisionSHA256).put("articleContentSHA256", contentHash).put("paperContentSHA256", paperHash).put("files", entries)
            if (pdfHash != null) manifest.put("pdfURL", paper.pdfURL).put("pdfSHA256", pdfHash)
            BackupCodec.atomicJSON(File(stage, "manifest.json"), manifest)
            verifyAt(stage, id)
            Files.move(stage.toPath(), location(id).toPath(), ATOMIC_MOVE)
            return@synchronized summary(verify(id)).put("reused", false)
        } finally { stage.deleteRecursively() }
    }
}
