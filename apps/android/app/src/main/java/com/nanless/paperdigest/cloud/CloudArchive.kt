package com.nanless.paperdigest.cloud

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.w3c.dom.Element
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.time.Instant
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.coroutines.coroutineContext

class CloudFailure(val code: String, val untilMillis: Long? = null) : Exception(when (code) {
    "credentialsUnavailable" -> "未能取得本机保存的坚果云应用密码，请处理本机安全设置后重试"
    "authentication" -> "坚果云认证失败，请检查账号和应用专用密码"
    "forbidden" -> "坚果云拒绝访问此目录"
    "throttled" -> "坚果云访问需要等待，原快照已保留"
    "integrity" -> "云端快照完整性校验失败，当前研究资料未改变"
    "incompleteListing" -> "月份列表不完整，不能据此判断备份是否存在"
    "busy" -> "已有云端操作正在进行"
    "targetChanged" -> "云端保存目标已经变化，旧任务未读取凭据或上传资料；请在当前目标明确新建备份"
    "checkpointStore" -> "本机续传记录保存失败，已停止云端操作"
    "redirect" -> "云端返回重定向，已停止发送认证信息"
    "oversizedResponse" -> "云端响应超过允许大小"
    else -> "云端操作未完成，原研究资料和续传材料已保留"
})

data class CloudReference(val month: String, val id: String) {
    init { require(Regex("[0-9]{4}-(0[1-9]|1[0-2])").matches(month) && month.take(4).toInt() in 2000..9999); require(Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}").matches(id) && UUID.fromString(id).toString() == id) }
    fun json() = JSONObject().put("month", month).put("id", id)
}
data class CloudChunk(val index: Int, val bytes: Int, val sha256: String) {
    fun json() = JSONObject().put("index", index).put("bytes", bytes).put("sha256", sha256)
}
data class CloudManifest(val reference: CloudReference, val createdAt: Long, val encodedBytes: Long, val sha256: String, val chunks: List<CloudChunk>) {
    fun json() = JSONObject().put("contract", "paperdigest-cloud-snapshot-v1").put("reference", reference.json()).put("createdAt", createdAt).put("encodedBytes", encodedBytes).put("sha256", sha256).put("chunks", JSONArray(chunks.map { it.json() }))
    fun info() = JSONObject().put("reference", reference.json()).put("createdAt", Instant.ofEpochMilli(createdAt).toString()).put("encodedBytes", encodedBytes).put("sha256", sha256).put("chunkCount", chunks.size)
    companion object {
        const val CHUNK = 8 * 1024 * 1024
        fun parse(bytes: ByteArray, expected: CloudReference): CloudManifest {
            if (bytes.size > 128 * 1024) throw CloudFailure("oversizedResponse")
            try {
                val o = JSONObject(bytes.toString(Charsets.UTF_8)); require(o.getString("contract") == "paperdigest-cloud-snapshot-v1")
                val r = o.getJSONObject("reference"); val rawID = r.getString("id"); require(Regex("[A-Fa-f0-9-]{36}").matches(rawID))
                val ref = CloudReference(r.getString("month"), UUID.fromString(rawID).toString()); require(ref == expected)
                val time = number(o, "createdAt"); require(time % 1000 == 0L && month(time) == ref.month)
                val count = number(o, "encodedBytes"); require(count in 1..BackupCodec.MAX_ENCODED)
                val hash = o.getString("sha256"); require(BackupCodec.validSHA(hash))
                val a = o.getJSONArray("chunks"); require(a.length().toLong() == (count + CHUNK - 1) / CHUNK)
                var offset = 0L; val chunks = (0 until a.length()).map { i ->
                    val c = a.getJSONObject(i); require(number(c, "index") == i.toLong())
                    val size = number(c, "bytes"); require(size == minOf(CHUNK.toLong(), count - offset)); offset += size
                    val sha = c.getString("sha256"); require(BackupCodec.validSHA(sha)); CloudChunk(i, size.toInt(), sha)
                }
                require(offset == count); return CloudManifest(ref, time, count, hash, chunks)
            } catch (e: Exception) { if (e is CloudFailure) throw e; throw CloudFailure("integrity") }
        }
        fun number(obj: JSONObject, key: String): Long { val n = obj.get(key); require(n is Number && n.toDouble().isFinite() && n.toDouble() == n.toLong().toDouble()); return n.toLong() }
        fun month(time: Long) = Instant.ofEpochMilli(time).atZone(ZoneOffset.UTC).format(DateTimeFormatter.ofPattern("uuuu-MM"))
    }
}
data class CloudCheckpoint(val destinationID: String, val folder: String, val manifest: CloudManifest, val verified: Set<Int> = emptySet(), val manifestVerified: Boolean = false, val retryAfter: Long? = null) {
    fun json() = JSONObject().put("contract", "paperdigest-android-cloud-transfer-v1").put("destinationID", destinationID).put("folder", folder).put("manifest", manifest.json()).put("verified", JSONArray(verified.sorted())).put("manifestVerified", manifestVerified).put("retryAfter", retryAfter ?: JSONObject.NULL)
    companion object {
        fun parse(obj: JSONObject): CloudCheckpoint {
            require(obj.getString("contract") == "paperdigest-android-cloud-transfer-v1")
            val manifestJSON = obj.getJSONObject("manifest"); val refJSON = manifestJSON.getJSONObject("reference")
            val ref = CloudReference(refJSON.getString("month"), UUID.fromString(refJSON.getString("id")).toString())
            val manifest = CloudManifest.parse(manifestJSON.toString().toByteArray(), ref)
            val a = obj.getJSONArray("verified"); val indices = (0 until a.length()).map { val n = a.get(it); require(n is Number && n.toDouble() == n.toInt().toDouble()); n.toInt() }
            require(indices.toSet().size == indices.size && indices.all { it in manifest.chunks.indices })
            require(obj.get("manifestVerified") is Boolean)
            return CloudCheckpoint(obj.getString("destinationID"), obj.getString("folder"), manifest, indices.toSet(), obj.getBoolean("manifestVerified"), if (obj.isNull("retryAfter")) null else CloudManifest.number(obj, "retryAfter"))
        }
    }
}
data class CloudCredentials(val username: String, val password: String)
data class CloudHTTP(val status: Int, val headers: Map<String, String>, val body: ByteArray)
fun interface CloudTransport { suspend fun execute(request: Request, limit: Int): CloudHTTP }
class NutstoreTransport : CloudTransport {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .cookieJar(CookieJar.NO_COOKIES).authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
        .callTimeout(60, TimeUnit.SECONDS).build()
    override suspend fun execute(request: Request, limit: Int): CloudHTTP {
        coroutineContext.ensureActive()
        require(request.url.scheme == "https" && request.url.host == "dav.jianguoyun.com" && request.url.port == 443 && request.url.username.isEmpty() && request.url.password.isEmpty() && request.url.query == null && request.url.fragment == null && request.url.encodedPath.startsWith("/dav/"))
        val call = client.newCall(request)
        return kotlinx.coroutines.suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: java.io.IOException) { if (continuation.isActive) continuation.resumeWith(Result.failure(CloudFailure("transport"))) }
                override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                    response.use { r ->
                        try {
                            if (r.request.url != request.url) throw CloudFailure("redirect")
                            val stream = r.body ?: throw CloudFailure("transport"); if (stream.contentLength() > limit) throw CloudFailure("oversizedResponse")
                            val out = ByteArrayOutputStream(minOf(limit, 64 * 1024)); val buffer = ByteArray(64 * 1024)
                            stream.byteStream().use { input -> while (true) { val count = input.read(buffer); if (count < 0) break; if (count > limit - out.size()) throw CloudFailure("oversizedResponse"); out.write(buffer, 0, count) } }
                            if (continuation.isActive) continuation.resumeWith(Result.success(CloudHTTP(r.code, r.headers.toMultimap().mapValues { it.value.joinToString(",") }, out.toByteArray())))
                        } catch (e: Exception) { if (continuation.isActive) continuation.resumeWith(Result.failure(if (e is CloudFailure) e else CloudFailure("transport"))) }
                    }
                }
            })
        }
    }
}

/** One object is reused for all operations on a target. No redirects or blind retries. */
class CloudArchive(
    private val folder: String, private val destinationID: String,
    private val credentials: suspend () -> CloudCredentials,
    private val saveCheckpoint: suspend (CloudCheckpoint) -> Unit,
    private val transport: CloudTransport = NutstoreTransport(),
    private val now: () -> Long = System::currentTimeMillis,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val minimumInterval: Long = 3100,
    private val loadTraffic: () -> JSONObject = { JSONObject() },
    private val saveTraffic: (JSONObject) -> Unit = {}
) {
    private val lock = Mutex(); private var checkpoint: CloudCheckpoint? = null
    private val times = ArrayList<Long>(); private var retryAt = 0L
    init {
        require(validFolder(folder)); UUID.fromString(destinationID); require(minimumInterval >= 0 && (minimumInterval >= 3100 || transport !is NutstoreTransport))
        val traffic = loadTraffic(); val a = traffic.optJSONArray("times") ?: JSONArray()
        require(a.length() <= 600); for (i in 0 until a.length()) { val v = a.get(i); require(v is Number); times += v.toLong() }
        retryAt = traffic.optLong("retryAfter", 0)
    }
    private suspend fun <T> operation(body: suspend () -> T): T {
        if (!lock.tryLock()) throw CloudFailure("busy")
        try { coroutineContext.ensureActive(); return body() } finally { checkpoint = null; lock.unlock() }
    }
    suspend fun probe() = operation { requireCollection(request("PROPFIND", "/dav/", body = PROP, headers = mapOf("Depth" to "0", "Content-Type" to "application/xml; charset=utf-8"), accepted = setOf(207), limit = LISTING), "/dav/") }
    suspend fun upload(file: File, old: CloudCheckpoint? = null): CloudManifest = operation {
        require(file.isFile && file.length() in 1..BackupCodec.MAX_ENCODED)
        val hash = BackupCodec.hash(file); val chunks = chunks(file); require(BackupCodec.hash(file) == hash) { "原待传快照已变化" }
        val created = (now() / 1000) * 1000
        var cp = old ?: CloudCheckpoint(destinationID, folder, CloudManifest(CloudReference(CloudManifest.month(created), UUID.randomUUID().toString()), created, file.length(), hash, chunks))
        require(cp.destinationID == destinationID && cp.folder == folder && cp.manifest.encodedBytes == file.length() && cp.manifest.sha256 == hash && cp.manifest.chunks == chunks) { "续传记录不属于原快照或目标" }
        retryAt = maxOf(retryAt, cp.retryAfter ?: 0); checkpoint = cp; persist(cp)
        val base = path(cp.manifest.reference)
        for (directory in listOf("/dav/$folder/", "/dav/$folder/${cp.manifest.reference.month}/", base)) {
            request("MKCOL", directory, accepted = setOf(201, 405)); requireCollection(request("PROPFIND", directory, PROP, mapOf("Depth" to "0", "Content-Type" to "application/xml; charset=utf-8"), setOf(207), LISTING), directory)
        }
        val existingManifest = optionalGet(base + "manifest.json", MANIFEST)
        if (existingManifest != null) require(CloudManifest.parse(existingManifest, cp.manifest.reference) == cp.manifest) { "已有完成清单属于不同快照" }
        for (chunk in chunks) {
            coroutineContext.ensureActive(); val bytes = readChunk(file, chunk); val chunkPath = base + chunkName(chunk.index)
            val existing = optionalGet(chunkPath, chunk.bytes)
            if (existing == null) {
                if (existingManifest != null) throw CloudFailure("integrity")
                request("PUT", chunkPath, bytes, mapOf("If-None-Match" to "*", "Content-Type" to "application/octet-stream"), setOf(200, 201, 204, 412))
            }
            val actual = existing ?: request("GET", chunkPath, accepted = setOf(200), limit = chunk.bytes)
            if (!actual.contentEquals(bytes)) throw CloudFailure("integrity")
            cp = cp.copy(verified = cp.verified + chunk.index, retryAfter = null); persist(cp)
        }
        if (existingManifest == null) request("PUT", base + "manifest.json", cp.manifest.json().toString().toByteArray(), mapOf("If-None-Match" to "*", "Content-Type" to "application/json"), setOf(200, 201, 204, 412))
        val actual = request("GET", base + "manifest.json", accepted = setOf(200), limit = MANIFEST)
        if (CloudManifest.parse(actual, cp.manifest.reference) != cp.manifest) throw CloudFailure("integrity")
        cp = cp.copy(manifestVerified = true, retryAfter = null); persist(cp); cp.manifest
    }
    suspend fun list(month: String): List<CloudManifest> = operation {
        CloudReference(month, UUID(0, 0).toString()); val directory = "/dav/$folder/$month/"
        val response = requestResponse("PROPFIND", directory, PROP, mapOf("Depth" to "1", "Content-Type" to "application/xml; charset=utf-8"), setOf(207, 404), LISTING)
        if (response.status == 404) emptyList() else {
            val members = listing(response.body); require(members.any { it.path == directory && it.collection }) { "月份列表缺少根目录" }
            val refs = members.filter { it.path != directory }.mapNotNull { m ->
                if (!m.path.startsWith(directory)) throw CloudFailure("incompleteListing")
                val tail = m.path.removePrefix(directory)
                if (m.collection) { try { CloudReference(month, tail.removeSuffix("/")).also { require(tail == it.id + "/") } } catch (e: Exception) { throw CloudFailure("incompleteListing") } }
                else { if ('/' in tail) throw CloudFailure("incompleteListing"); null }
            }
            val result = ArrayList<CloudManifest>(); for (ref in refs) optionalGet(path(ref) + "manifest.json", MANIFEST)?.let { result += CloudManifest.parse(it, ref) }
            result.sortedWith(compareByDescending<CloudManifest> { it.createdAt }.thenBy { it.reference.id })
        }
    }
    suspend fun download(reference: CloudReference, target: File): CloudManifest = operation {
        require(!target.exists()); val base = path(reference); val manifest = CloudManifest.parse(request("GET", base + "manifest.json", accepted = setOf(200), limit = MANIFEST), reference)
        try {
            FileOutputStreamSync(target).use { out -> for (chunk in manifest.chunks) {
                val bytes = request("GET", base + chunkName(chunk.index), accepted = setOf(200), limit = chunk.bytes)
                if (bytes.size != chunk.bytes || BackupCodec.hash(bytes) != chunk.sha256) throw CloudFailure("integrity"); out.write(bytes)
            } }
            if (target.length() != manifest.encodedBytes || BackupCodec.hash(target) != manifest.sha256) throw CloudFailure("integrity")
            manifest
        } catch (t: Throwable) { target.delete(); throw t }
    }
    private suspend fun persist(value: CloudCheckpoint) { try { saveCheckpoint(value); checkpoint = value } catch (e: CancellationException) { throw e } catch (e: Exception) { coroutineContext.ensureActive(); throw CloudFailure("checkpointStore") } }
    private suspend fun request(method: String, path: String, body: ByteArray? = null, headers: Map<String, String> = emptyMap(), accepted: Set<Int>, limit: Int = 64 * 1024) = requestResponse(method, path, body, headers, accepted, limit).body
    private suspend fun optionalGet(path: String, limit: Int): ByteArray? { val r = requestResponse("GET", path, accepted = setOf(200, 404), limit = limit); return if (r.status == 404) null else r.body }
    private suspend fun requestResponse(method: String, path: String, body: ByteArray? = null, headers: Map<String, String> = emptyMap(), accepted: Set<Int>, limit: Int = 64 * 1024): CloudHTTP {
        coroutineContext.ensureActive(); val time = now(); if (retryAt > time) throw CloudFailure("throttled", retryAt)
        times.removeAll { time - it >= 1_800_000 }
        if (times.size >= 600) { coolDown(times.first() + 1_800_000); throw CloudFailure("throttled", retryAt) }
        val gap = (times.lastOrNull() ?: (time - minimumInterval)) + minimumInterval - now(); if (gap > 0) sleep(gap)
        coroutineContext.ensureActive()
        val access = try { credentials() } catch (e: CancellationException) { throw e } catch (e: Exception) { coroutineContext.ensureActive(); throw CloudFailure("credentialsUnavailable") }
        coroutineContext.ensureActive(); if (access.password.isEmpty()) throw CloudFailure("credentialsUnavailable")
        require(access.username.isNotEmpty() && ':' !in access.username && (access.username + access.password).none { it.code < 32 || it.code == 127 })
        val url = "https://dav.jianguoyun.com$path"; require(path.startsWith("/dav/") && '\\' !in path && '?' !in path && '#' !in path && '%' !in path && !path.contains(".."))
        val builder = Request.Builder().url(url).header("Authorization", "Basic " + Base64.getEncoder().encodeToString((access.username + ":" + access.password).toByteArray())).header("Accept-Encoding", "identity")
        headers.forEach { (key, value) -> builder.header(key, value) }
        builder.method(method, if (method in listOf("PUT", "PROPFIND")) (body ?: ByteArray(0)).toRequestBody((headers["Content-Type"] ?: "application/octet-stream").toMediaType()) else null)
        times += now(); traffic()
        val response = try { transport.execute(builder.build(), limit) } catch (e: CancellationException) { throw e } catch (e: Exception) { coroutineContext.ensureActive(); if (e is CloudFailure) throw e; throw CloudFailure("transport") }
        coroutineContext.ensureActive(); if (response.body.size > limit) throw CloudFailure("oversizedResponse")
        when (response.status) {
            401 -> throw CloudFailure("authentication"); 403 -> throw CloudFailure("forbidden")
            in 300..399 -> throw CloudFailure("redirect")
            429, 503 -> { val header = response.headers.entries.firstOrNull { it.key.equals("Retry-After", true) }?.value; val until = header?.toLongOrNull()?.takeIf { it >= 0 && it <= Long.MAX_VALUE / 1000 - now() / 1000 }?.let { now() + maxOf(1000, it * 1000) } ?: runCatching { ZonedDateTime.parse(header, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() }.getOrNull()?.takeIf { it > now() } ?: (now() + 60_000); coolDown(until); throw CloudFailure("throttled", until) }
        }
        if (response.status !in accepted) throw CloudFailure("http_${response.status}")
        return response
    }
    private fun traffic() { try { saveTraffic(JSONObject().put("times", JSONArray(times)).put("retryAfter", retryAt)) } catch (e: Exception) { throw CloudFailure("checkpointStore") } }
    private suspend fun coolDown(until: Long) { retryAt = until; traffic(); checkpoint?.let { persist(it.copy(retryAfter = until)) } }
    private fun path(ref: CloudReference) = "/dav/$folder/${ref.month}/${ref.id}/"
    companion object {
        private const val MANIFEST = 128 * 1024; private const val LISTING = 4 * 1024 * 1024
        private val PROP = "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>".toByteArray()
        fun validFolder(value: String) = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,63}").matches(value) && !value.contains("..") && !value.equals("zotero", true)
        private fun chunkName(index: Int) = "chunk-%06d.bin".format(java.util.Locale.ROOT, index)
        private fun readChunk(file: File, chunk: CloudChunk): ByteArray = RandomAccessFile(file, "r").use { input -> input.seek(chunk.index.toLong() * CloudManifest.CHUNK); ByteArray(chunk.bytes).also { input.readFully(it); if (chunk.sha256.isNotEmpty() && BackupCodec.hash(it) != chunk.sha256) throw CloudFailure("integrity") } }
        private fun chunks(file: File): List<CloudChunk> = (0 until ((file.length() + CloudManifest.CHUNK - 1) / CloudManifest.CHUNK).toInt()).map { i -> val size = minOf(CloudManifest.CHUNK.toLong(), file.length() - i.toLong() * CloudManifest.CHUNK).toInt(); val initial = CloudChunk(i, size, ""); initial.copy(sha256 = BackupCodec.hash(readChunk(file, initial))) }
        private data class Member(val path: String, val collection: Boolean)
        private fun collectionPath(path: String) = if (path.endsWith('/')) path else "$path/"
        private fun requireCollection(bytes: ByteArray, path: String) { val members = listing(bytes); if (members.size != 1 || members[0] != Member(path, true)) throw CloudFailure("incompleteListing") }
        private fun listing(bytes: ByteArray): List<Member> {
            try {
                val text = Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes)).toString(); require(!text.contains("<!DOCTYPE", true) && !text.contains("<!ENTITY", true))
                val factory = DocumentBuilderFactory.newInstance(); factory.isNamespaceAware = true; factory.isExpandEntityReferences = false
                runCatching { factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true) }
                runCatching { factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true) }
                val builder = factory.newDocumentBuilder(); builder.setEntityResolver { _, _ -> org.xml.sax.InputSource(java.io.StringReader("")) }; val doc = builder.parse(ByteArrayInputStream(bytes)); val root = doc.documentElement
                require(root.namespaceURI == "DAV:" && root.localName == "multistatus")
                fun children(e: Element): List<Element> = (0 until e.childNodes.length).mapNotNull { e.childNodes.item(it) as? Element }.also { require(it.all { child -> child.namespaceURI == "DAV:" }) }
                val responses = children(root); require(responses.isNotEmpty() && responses.size < 750 && responses.all { it.localName == "response" }); val seen = HashSet<String>()
                return responses.map { response ->
                    val elements = children(response); val hrefs = elements.filter { it.localName == "href" }; require(hrefs.size == 1)
                    val href = hrefs[0].textContent.trim(); require('\\' !in href)
                    val raw = java.net.URI(href); val rawPath = raw.path ?: error("DAV href has no absolute path")
                    require(raw.isAbsolute || (raw.rawAuthority == null && rawPath.startsWith('/')))
                    require(raw.rawPath == rawPath && rawPath.all { it.code in 33..126 } && "//" !in rawPath && rawPath.split('/').none { it == "." || it == ".." })
                    val uri = java.net.URI("https://dav.jianguoyun.com").resolve(raw)
                    require(uri.scheme == "https" && uri.host == "dav.jianguoyun.com" && uri.port in listOf(-1, 443) && uri.userInfo == null && uri.query == null && uri.fragment == null && uri.path == rawPath && (rawPath == "/dav" || rawPath.startsWith("/dav/")))
                    var successful = false; var collection = false
                    elements.filter { it.localName == "propstat" }.forEach { propstat ->
                        val p = children(propstat); val status = p.filter { it.localName == "status" }; require(status.size == 1)
                        if (Regex("HTTP/[^ ]+ 200(?: .*)?").matches(status[0].textContent.trim())) {
                            successful = true; p.filter { it.localName == "prop" }.flatMap(::children).filter { it.localName == "resourcetype" }.flatMap(::children).forEach { if (it.localName == "collection") collection = true }
                        }
                    }
                    require(successful)
                    // Only a successful DAV collection receives the one-slash alias.
                    // The collision key also rejects file/collection disagreements.
                    require(seen.add(collectionPath(rawPath)))
                    Member(if (collection) collectionPath(rawPath) else rawPath, collection)
                }
            } catch (e: Exception) { throw CloudFailure("incompleteListing") }
        }
    }
    private class FileOutputStreamSync(file: File) : java.io.FileOutputStream(file) { init { BackupCodec.privateFile(file) }; override fun close() { try { fd.sync() } finally { super.close() } } }
}
