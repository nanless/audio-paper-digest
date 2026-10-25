package com.nanless.paperdigest.cloud

import android.icu.lang.UCharacter
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Base64
import java.util.Locale
import java.util.UUID

/** The portable v2 format contains every regular research file, including hidden files. */
object BackupCodec {
    const val MAX_DECODED = 512L * 1024 * 1024
    const val MAX_ENCODED = 750L * 1024 * 1024
    const val MAX_ENTRIES = 100_000
    const val ROOTS_FILE = "RestoredPathRoots.json"
    data class Entry(val path: String, val sha256: String, val bytes: Long)
    data class Captured(val file: File, val sha256: String, val encodedBytes: Long, val fileCount: Int)
    data class Staged(val directory: File, val sourceDirectory: String, val entries: List<Entry>, val encodedSHA256: String, val encodedBytes: Long)

    // Captured stays a portable data DTO, while normal producer return is an
    // in-process identity capability. Weak identity keys do not retain periodic
    // cloud snapshots indefinitely and never authorize a copied/constructed DTO.
    private val completedCaptureQueue = java.lang.ref.ReferenceQueue<Captured>()
    private class CaptureIdentity(value:Captured,queue:java.lang.ref.ReferenceQueue<Captured>?=null):java.lang.ref.WeakReference<Captured>(value,queue) {
        private val identityHash=System.identityHashCode(value)
        override fun hashCode()=identityHash
        override fun equals(other:Any?):Boolean = this===other || other is CaptureIdentity && get()!=null && get()===other.get()
    }
    private val completedCaptureIdentities=HashSet<CaptureIdentity>()
    private fun removeExpiredCaptures(){while(true){val expired=completedCaptureQueue.poll()?:break;completedCaptureIdentities.remove(expired)}}
    private fun recordNormalCapture(result:Captured):Captured=synchronized(completedCaptureIdentities){removeExpiredCaptures();completedCaptureIdentities.add(CaptureIdentity(result,completedCaptureQueue));result}
    fun requireNormalCapture(result:Captured)=synchronized(completedCaptureIdentities){removeExpiredCaptures();require(completedCaptureIdentities.contains(CaptureIdentity(result))){"本次生产回执缺少实际正常采集返回凭证，原文件保留且未授予就绪"}}

    fun hash(file: File): String = checkedHash(file) {}
    fun hash(file: File, check: () -> Unit): String = checkedHash(file, check)
    private fun checkedHash(file: File, check: () -> Unit): String = file.inputStream().buffered().use { input ->
        val digest = MessageDigest.getInstance("SHA-256"); val b = ByteArray(64 * 1024)
        while (true) { check(); val n = input.read(b); if (n < 0) break; digest.update(b, 0, n) }; hex(digest.digest())
    }
    fun hash(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    fun validSHA(value: String) = Regex("[a-f0-9]{64}").matches(value)
    fun checkedPath(value: String) {
        Charsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT).encode(java.nio.CharBuffer.wrap(value))
        require(value.isNotEmpty() && !value.startsWith('/') && !value.endsWith('/') && '\\' !in value && value.toByteArray(Charsets.UTF_8).size <= 4096 && value.none { it.code < 32 || it.code == 127 }) { "研究资料路径无效" }
        require(value.split('/').none { it.isEmpty() || it == "." || it == ".." }) { "研究资料路径越界" }
    }
    fun checkedRoot(value: String) { require(value.startsWith('/') && value != "/") { "原研究目录无效" }; checkedPath(value.drop(1)) }
    private fun alias(value: String): String {
        val nfc = Normalizer.normalize(value, Normalizer.Form.NFC)
        return if (nfc.all { it.code < 128 }) nfc.lowercase(Locale.ROOT) else UCharacter.foldCase(nfc, true)
    }
    private class Paths {
        private val files = HashSet<String>(); private val components = HashMap<String, String>()
        fun add(path: String) {
            checkedPath(path); var prefix = ""
            path.split('/').forEach { part ->
                prefix = if (prefix.isEmpty()) part else "$prefix/$part"
                val old = components.putIfAbsent(alias(prefix), prefix)
                require(old == null || old == prefix) { "研究资料目录存在名称别名冲突" }
            }
            val a = alias(path); require(files.add(a)) { "研究资料路径重复" }
            val reserved = alias(ROOTS_FILE)
            require((a != reserved || path == ROOTS_FILE) && !a.startsWith("$reserved/")) { "旧路径映射名称冲突" }
        }
        fun finish() { files.forEach { path -> var prefix = ""; path.split('/').dropLast(1).forEach { part -> prefix = if (prefix.isEmpty()) part else "$prefix/$part"; require(prefix !in files) { "文件与父目录冲突" } } } }
    }
    fun checkedDirectory(directory: File) {
        require(directory.isDirectory && !Files.isSymbolicLink(directory.toPath())) { "研究目录不是私有普通目录" }
        checkedRoot(directory.absolutePath)
    }
    fun checkedFile(root: File, relative: String): File {
        checkedDirectory(root); checkedPath(relative); var next = root
        relative.split('/').forEachIndexed { index, part ->
            next = File(next, part); require(!Files.isSymbolicLink(next.toPath())) { "研究文件不能经过链接" }
            require(if (index == relative.count { it == '/' }) next.isFile else next.isDirectory) { "研究文件或父目录缺失" }
        }
        require(next.canonicalPath.startsWith(root.canonicalPath + File.separator)) { "研究文件越界" }; return next
    }
    private fun roots(bytes: ByteArray): List<String> {
        val obj = JSONObject(bytes.toString(Charsets.UTF_8)); require(obj.keys().asSequence().toSet() == setOf("contract", "roots") && obj.getString("contract") == "paperdigest-storage-aliases-v1") { "旧路径映射合同无效" }
        val array = obj.getJSONArray("roots"); require(array.length() <= MAX_ENTRIES)
        return (0 until array.length()).map { array.getString(it) }.also { validateRoots(it) }
    }
    private fun validateRoots(roots: List<String>) {
        val keys = HashSet<String>(); roots.forEach { checkedRoot(it); require(keys.add(alias(it))) { "旧目录别名重复" } }
        keys.forEach { path -> var prefix = ""; path.split('/').filter { it.isNotEmpty() }.dropLast(1).forEach { prefix += "/$it"; require(prefix !in keys) { "旧目录相互包含" } } }
    }
    fun capture(root: File, output: File): Captured = capture(root, output) {}
    fun capture(root: File, output: File, check: () -> Unit): Captured {
        check()
        checkedDirectory(root); require(!output.canonicalPath.startsWith(root.canonicalPath + "/")) { "快照不能递归保存到研究目录内" }
        val entries = ArrayList<Pair<String, File>>(); val paths = Paths(); var total = 0L
        Files.walk(root.toPath()).use { walk -> walk.forEach { p ->
            check()
            if (p == root.toPath()) return@forEach
            require(!Files.isSymbolicLink(p)) { "备份不能包含链接" }
            if (Files.isDirectory(p, NOFOLLOW_LINKS)) return@forEach
            require(Files.isRegularFile(p, NOFOLLOW_LINKS)) { "备份不能包含特殊文件" }
            val relative = root.toPath().relativize(p).toString().replace(File.separatorChar, '/')
            paths.add(relative); total += Files.size(p); require(total <= MAX_DECODED && entries.size < MAX_ENTRIES) { "完整备份超过512MiB或100000项" }; entries += relative to p.toFile()
        } }
        paths.finish(); require(entries.any { it.first == "personal.json" }) { "研究资料缺少personal.json" }
        validatePersonal(JSONObject(checkedFile(root, "personal.json").readText()))
        entries.firstOrNull { it.first == ROOTS_FILE }?.let { validateRoots(listOf(root.absolutePath) + roots(it.second.readBytes()).filter { r -> r != root.absolutePath }) }
        output.parentFile?.mkdirs(); val temporary = File(output.parentFile, ".${output.name}-${UUID.randomUUID()}")
        try {
            LimitedOutput(temporary.outputStream().buffered(), MAX_ENCODED, check).use { out ->
                fun text(s: String) = out.write(s.toByteArray(Charsets.UTF_8))
                text("{\"contract\":\"paperdigest-backup-v2\",\"files\":[")
                entries.sortedBy { it.first }.forEachIndexed { index, (relative, file) ->
                    check()
                    if (index > 0) text(",")
                    text("{\"data\":\"")
                    val shield = object : FilterOutputStream(out) {
                        override fun write(bytes: ByteArray, offset: Int, length: Int) = out.write(bytes, offset, length)
                        override fun close() { flush() }
                    }
                    Base64.getEncoder().wrap(shield).use { encoded -> file.inputStream().buffered().use { it.copyTo(encoded, 64 * 1024) } }
                    text("\",\"path\":" + JSONObject.quote(relative) + ",\"sha256\":\"" + checkedHash(file, check) + "\"}")
                }
                text("],\"sourceDirectory\":" + JSONObject.quote(root.absolutePath) + "}")
            }
            // Detect edits during streaming, not just during the initial enumeration.
            val verified = stage(temporary.inputStream(), output.parentFile!!, check)
            try { require(verified.entries.map { it.path }.toSet() == entries.map { it.first }.toSet()); verified.entries.forEach { check(); require(checkedHash(checkedFile(root, it.path), check) == it.sha256) { "采集期间研究文件已变化" } } } finally { verified.directory.deleteRecursively() }
            FileOutputStream(temporary, true).use { it.fd.sync() }
            val encodedSHA = checkedHash(temporary, check); val encodedBytes = temporary.length()
            val currentPaths = Files.walk(root.toPath()).use { walk -> walk.peek { check() }.filter { Files.isRegularFile(it, NOFOLLOW_LINKS) }.map { root.toPath().relativize(it).toString().replace(File.separatorChar, '/') }.toArray().map { it as String }.toSet() }
            require(currentPaths == entries.map { it.first }.toSet()) { "采集期间研究目录已变化" }
            check()
            require(!output.exists()) { "不会覆盖已有快照" }; Files.move(temporary.toPath(), output.toPath(), ATOMIC_MOVE)
            return recordNormalCapture(Captured(output, encodedSHA, encodedBytes, entries.size))
        } finally { temporary.delete() }
    }
    /** Input is decoded one Base64 buffer at a time into a newly owned private stage. */
    fun stage(input: InputStream, parent: File): Staged = stage(input, parent) {}
    fun stage(input: InputStream, parent: File, check: () -> Unit): Staged = try { stageChecked(input, parent, check) } finally { input.close() }
    private fun stageChecked(input: InputStream, parent: File, check: () -> Unit): Staged {
        check()
        checkedDirectory(parent); val stage = Files.createTempDirectory(parent.toPath(), ".paperdigest-restore-").toFile(); privateDirectory(stage)
        try {
            val bounded = LimitedInput(input.buffered(), MAX_ENCODED, check); val digest = MessageDigest.getInstance("SHA-256")
            val parser = JsonStream(java.security.DigestInputStream(bounded, digest)); val paths = Paths(); val entries = ArrayList<Entry>(); val seen = HashSet<String>()
            var contract: String? = null; var source: String? = null; var total = 0L
            parser.obj { key ->
                require(seen.add(key)) { "备份根字段重复" }
                when (key) {
                    "contract" -> contract = parser.string(128)
                    "sourceDirectory" -> source = parser.string(4096)
                    "files" -> parser.array {
                        require(entries.size < MAX_ENTRIES) { "备份条目超限" }
                        var path: String? = null; var sha: String? = null; var size: Long? = null; val keys = HashSet<String>(); val temporary = File(stage, ".decode-${UUID.randomUUID()}")
                        parser.obj { field ->
                            require(keys.add(field)) { "备份文件字段重复" }
                            when (field) { "path" -> path = parser.string(4096); "sha256" -> sha = parser.string(64); "data" -> temporary.outputStream().buffered().use { out -> size = parser.base64(out, MAX_DECODED - total) }; else -> error("备份文件含未知字段") }
                        }
                        require(keys == setOf("path", "sha256", "data") && path != null && sha != null && size != null)
                        paths.add(path!!); total += size!!; require(validSHA(sha!!) && checkedHash(temporary, check) == sha) { "备份文件SHA不符" }
                        val target = File(stage, path!!); require(!target.exists()); target.parentFile!!.mkdirs(); privateDirectory(target.parentFile!!)
                        Files.move(temporary.toPath(), target.toPath(), ATOMIC_MOVE); privateFile(target); entries += Entry(path!!, sha!!, size!!)
                    }
                    else -> error("备份含未知根字段")
                }
            }
            parser.end(); paths.finish(); require(contract == "paperdigest-backup-v2" && seen == setOf("contract", "sourceDirectory", "files")) { "备份合同无效" }
            checkedRoot(source ?: error("备份缺少来源目录")); val personal = checkedFile(stage, "personal.json"); validatePersonal(JSONObject(personal.readText()))
            val map = File(stage, ROOTS_FILE); val inherited = if (map.exists()) roots(map.readBytes()) else emptyList(); val combined = listOf(source!!) + inherited.filter { it != source }
            validateRoots(combined)
            atomicJSON(map, JSONObject().put("contract", "paperdigest-storage-aliases-v1").put("roots", JSONArray(combined)))
            entries.filter { it.path != ROOTS_FILE }.forEach { check(); require(checkedHash(checkedFile(stage, it.path), check) == it.sha256) }
            check()
            return Staged(stage, source!!, entries, hex(digest.digest()), bounded.count)
        } catch (t: Throwable) { stage.deleteRecursively(); throw t }
    }
    fun validatePersonal(obj: JSONObject) {
        require(obj.opt("schema") is Number && (obj.get("schema") as Number).toDouble() == 1.0)
        require(obj.opt("notes") is JSONObject && obj.opt("settings") is JSONObject && obj.opt("favorites") is JSONArray && obj.opt("reading") is JSONArray && obj.opt("readingState") is JSONObject && obj.opt("annotations") is JSONObject && obj.opt("sessions") is JSONArray && obj.opt("jobs") is JSONArray) { "个人资料结构无效" }
        val notes = obj.getJSONObject("notes"); notes.keys().forEach { key -> val n = notes.getJSONObject(key); val revision = n.opt("revision"); require(n.opt("text") is String && revision is Number && revision.toDouble() >= 0 && revision.toDouble() == revision.toLong().toDouble()) { "笔记版本无效" } }
        for (key in listOf("favorites", "reading")) { val a = obj.getJSONArray(key); for (i in 0 until a.length()) require(a.get(i) is String) }
        val readingStates = obj.getJSONObject("readingState"); readingStates.keys().forEach { require(readingStates.get(it) is JSONObject) }
        val annotations = obj.getJSONObject("annotations"); annotations.keys().forEach { owner -> val a = annotations.getJSONArray(owner); for (i in 0 until a.length()) require(a.get(i) is JSONObject) }
        if (obj.has("personalPapers")) {
            val papers = obj.getJSONObject("personalPapers"); require(papers.length() <= MAX_ENTRIES)
            papers.keys().forEach { id ->
                val paper = papers.getJSONObject(id); require(id.isNotEmpty() && id.length <= 256 && paper.getString("id") == id && paper.getString("title").isNotEmpty() && paper.getString("sourceKind").isNotEmpty())
                for (key in listOf("titleZh", "sourceURL", "blogURL", "pdfURL", "sourceVersion", "offlinePackageID")) if (paper.has(key) && !paper.isNull(key)) require(paper.get(key) is String)
                for (key in listOf("authors", "tags")) if (paper.has(key)) { val a = paper.getJSONArray(key); for (i in 0 until a.length()) require(a.get(i) is String) }
                if (paper.getString("sourceKind") == "local") { val sha = paper.getString("pdfSHA"); require(validSHA(sha) && id == "local:$sha"); checkedRoot(paper.getString("localPDFPath")) }
            }
        }
        for (key in listOf("sessions", "jobs")) { val a = obj.getJSONArray(key); for (i in 0 until a.length()) require(a.get(i) is JSONObject) }
    }
    fun atomicJSON(file: File, value: JSONObject) = atomicBytes(file, value.toString().toByteArray(Charsets.UTF_8))
    fun atomicBytes(file: File, bytes: ByteArray) {
        require(!Files.isSymbolicLink(file.toPath())); file.parentFile!!.mkdirs(); checkedDirectory(file.parentFile!!)
        val tmp = File(file.parentFile, ".write-${UUID.randomUUID()}")
        try { FileOutputStream(tmp).use { it.write(bytes); it.fd.sync() }; privateFile(tmp); Files.move(tmp.toPath(), file.toPath(), ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING) } finally { tmp.delete() }
    }
    fun privateDirectory(file: File) { file.setReadable(false, false); file.setWritable(false, false); file.setExecutable(false, false); require(file.setReadable(true, true) && file.setWritable(true, true) && file.setExecutable(true, true)) }
    fun privateFile(file: File) { file.setReadable(false, false); file.setWritable(false, false); file.setExecutable(false, false); require(file.setReadable(true, true) && file.setWritable(true, true)) }

    private class LimitedOutput(out: OutputStream, private val limit: Long, private val check: () -> Unit) : FilterOutputStream(out) {
        private var count = 0L
        override fun write(b: Int) { if (count % (64 * 1024) == 0L) check(); require(count < limit) { "备份编码超过750MiB" }; out.write(b); count++ }
        override fun write(b: ByteArray, off: Int, len: Int) {
            require(len >= 0 && len.toLong() <= limit - count) { "备份编码超过750MiB" }
            var position = off; var remaining = len
            while (remaining > 0) { check(); val size = minOf(remaining, 64 * 1024); out.write(b, position, size); count += size; position += size; remaining -= size }
        }
    }
    private class LimitedInput(input: InputStream, private val limit: Long, private val check: () -> Unit) : FilterInputStream(input) {
        var count = 0L; private set
        override fun read(): Int { check(); val n = super.read(); if (n >= 0) { count++; require(count <= limit) { "备份编码超过750MiB" } }; return n }
        override fun read(b: ByteArray, off: Int, len: Int): Int { check(); val n = super.read(b, off, minOf(len.toLong(), limit - count + 1).toInt()); if (n > 0) { count += n; require(count <= limit) { "备份编码超过750MiB" } }; return n }
    }
    /** Strict streaming subset: v2 contains objects, arrays and JSON strings only. */
    private class JsonStream(input: InputStream) {
        private val reader = InputStreamReader(input, Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT))
        private val characters = CharArray(64 * 1024); private var position = 0; private var used = 0; private var next = -2
        private fun readCharacter(): Int {
            if (used < 0) return -1
            if (position == used) {
                used = reader.read(characters, 0, characters.size); position = 0
                if (used < 0) return -1
                require(used > 0) { "备份读取未取得数据" }
            }
            return characters[position++].code
        }
        private fun peek(): Int { if (next == -2) next = readCharacter(); return next }
        private fun take(): Int = peek().also { next = -2 }
        private fun whitespace() { while (peek() in listOf(32, 9, 10, 13)) take() }
        private fun expect(c: Char) { whitespace(); require(take() == c.code) { "备份JSON格式无效" } }
        fun obj(value: (String) -> Unit) { expect('{'); whitespace(); if (peek() == '}'.code) { take(); return }; while (true) { val key = string(4096); expect(':'); value(key); whitespace(); when (take()) { '}'.code -> return; ','.code -> Unit; else -> error("备份JSON对象无效") } } }
        fun array(value: () -> Unit) { expect('['); whitespace(); if (peek() == ']'.code) { take(); return }; while (true) { value(); whitespace(); when (take()) { ']'.code -> return; ','.code -> Unit; else -> error("备份JSON数组无效") } } }
        private inline fun stringChars(value: (Char) -> Unit) { expect('"'); while (true) { val c = take(); require(c >= 32) { "备份JSON字符串无效" }; if (c == '"'.code) return; if (c != '\\'.code) value(c.toChar()) else { val escaped = take(); value(when (escaped) { '"'.code -> '"'; '\\'.code -> '\\'; '/'.code -> '/'; 'b'.code -> '\b'; 'f'.code -> '\u000c'; 'n'.code -> '\n'; 'r'.code -> '\r'; 't'.code -> '\t'; 'u'.code -> { val s = (1..4).map { take().toChar() }.joinToString(""); require(s.all { it in "0123456789abcdefABCDEF" }); s.toInt(16).toChar() }; else -> error("备份JSON转义无效") }) } } }
        fun string(limit: Int): String { val b = StringBuilder(); stringChars { b.append(it); require(b.length <= limit) { "备份字符串超限" } }; return b.toString().also { require(it.toByteArray(Charsets.UTF_8).size <= limit) } }
        fun base64(out: OutputStream, limit: Long): Long {
            val buffer = StringBuilder(8192); var count = 0L; var padded = false
            fun flush() { if (buffer.isEmpty()) return; require(buffer.length % 4 == 0); val raw = Base64.getDecoder().decode(buffer.toString()); require(raw.size <= limit - count) { "备份原文件总量超过512MiB" }; out.write(raw); count += raw.size; padded = buffer.contains('='); buffer.setLength(0) }
            stringChars { c -> require(!padded && (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '+' || c == '/' || c == '=')) { "备份Base64无效" }; buffer.append(c); if (buffer.length == 8192) flush() }
            flush(); return count
        }
        fun end() { whitespace(); require(take() == -1) { "备份JSON有尾随内容" } }
    }
}
