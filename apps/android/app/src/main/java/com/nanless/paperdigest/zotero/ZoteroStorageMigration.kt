package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.zotero.webdav.ZoteroDavTarget
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardOpenOption.*
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID

/** Facts returned only by the service's read-only authenticated API/Storage verifier. */
internal data class MigrationApiObservation(
    val key: String, val exists: Boolean, val version: Long?, val md5: String?, val mtime: Long?,
    val apiDataSHA256: String?, val storageBytesVerified: Boolean,
) {
    fun json() = JSONObject().put("key", key).put("exists", exists).put("version", version ?: JSONObject.NULL)
        .put("md5", md5 ?: JSONObject.NULL).put("mtime", mtime ?: JSONObject.NULL)
        .put("apiDataSHA256", apiDataSHA256 ?: JSONObject.NULL).put("storageBytesVerified", storageBytesVerified)
}

internal class MigrationParent internal constructor(
    private val issuer: Any, val id: String, internal val bytes: ByteArray, val sha256: String,
    val directoryKey: Any, val headerKey: Any, val materialFacts: List<Material>,
) {
    internal data class Material(val file: File, val key: Any, val bytes: Long, val mtime: Long, val sha256: String)
    fun issuedBy(owner: Any) = issuer === owner
    fun header() = JSONObject(bytes.toString(Charsets.UTF_8))
}
internal class MigrationChild internal constructor(private val issuer: Any, val id: String, val journal: JSONObject, val origin: JSONObject, val target: ZoteroDavTarget) {
    fun issuedBy(owner: Any) = issuer === owner
}

/** Sibling publication; the original UUID directory is never written, even for readback temporaries. */
internal class ZoteroStorageMigrationStore(private val researchRoot: File, private val ownedFiles:ZoteroOwnedDownloadFiles=AndroidZoteroOwnedDownloadFiles, private val beforeLinkPublish: () -> Unit = {}) {
    private val issuer = Any()
    private val records = File(researchRoot, "ZoteroArchives")
    private val control = File(researchRoot, "ZoteroMigrationIntents")
    companion object { private val monitor = Any(); private val roles = setOf("source-metadata", "pdf", "guide", "analysis", "note", "guide-preview-pdf") }
    private fun uuid(value: String) { require(UUID.fromString(value).toString() == value) { "存档身份无效" } }
    private fun attrs(file: File) = Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS)
    private fun directory(file: File) { BackupCodec.checkedDirectory(file) }
    private fun make(file: File) { directory(file.parentFile); if (!file.exists()) require(file.mkdir()||file.isDirectory); directory(file); BackupCodec.privateDirectory(file) }
    private fun read(file: File) = JsonFiles.read(file, 2 * 1024 * 1024)
    private fun header(id: String): File { uuid(id); val dir = File(records, id); directory(dir); return BackupCodec.checkedFile(dir, "journal.json") }
    private fun same(file: File, before: BasicFileAttributes) { val after = attrs(file); require(after.isRegularFile && after.fileKey() == before.fileKey() && after.size() == before.size() && after.lastModifiedTime() == before.lastModifiedTime()) { "原存档材料在读取中变化" } }
    fun captureParent(id: String): MigrationParent {
        directory(researchRoot); directory(records); val file = header(id); val dirKey = attrs(file.parentFile).fileKey() ?: error("原存档目录身份缺失")
        val before = attrs(file); val bytes = read(file); same(file, before); val j = JSONObject(bytes.toString(Charsets.UTF_8))
        require(j.optString("contract") == "paperdigest-zotero-web-v1" && j.getString("id") == id && j.optString("attachmentBackend", "storage") == "storage" && j.getString("libraryType") == "users") { "只可从原个人文库 Storage 存档迁移" }
        require(listOf("id", "destinationID", "libraryType", "libraryID", "collection", "paperID", "identity", "planSHA", "parentKey").all { j.opt(it) is String })
        require(j.optJSONObject("bibliography") != null && j.optJSONObject("options") != null && listOf("includePDF", "includeGuide", "includeAnalysis", "includeNote").all { j.getJSONObject("options").opt(it) is Boolean })
        require(j.optString("paperID").isNotBlank() && ZoteroService.validKey(j.getString("parentKey")) && j.getString("planSHA").matches(Regex("[a-f0-9]{64}")))
        val rows = j.getJSONArray("roles").objects(); require(rows.isNotEmpty() && rows.size <= roles.size && rows.map { it.getString("role") }.distinct().size == rows.size && rows.any { it.optString("role") == "source-metadata" })
        val facts = rows.mapIndexed { i, r ->
            require(listOf("role", "key", "title", "contentType", "file", "sha256").all { r.opt(it) is String } && (r.opt("bytes") is Int || r.opt("bytes") is Long))
            require(r.getString("role") in roles && r.getString("file") == "material-$i" && ZoteroService.validKey(r.getString("key")) && r.getString("sha256").matches(Regex("[a-f0-9]{64}")))
            require(r.opt("note") is Boolean && r.getBoolean("note") == (r.getString("role") == "note"))
            val source = BackupCodec.checkedFile(file.parentFile, "material-$i"); val a = attrs(source)
            require(a.isRegularFile && a.fileKey() != null && a.size() == r.getLong("bytes") && a.size() in 1..512L*1024*1024 && BackupCodec.hash(source) == r.getString("sha256")); same(source, a)
            MigrationParent.Material(source, a.fileKey()!!, a.size(), a.lastModifiedTime().toMillis(), r.getString("sha256"))
        }
        val originalPlan = JSONObject().put("contract", "paperdigest-zotero-plan-v1").put("destinationID", j.getString("destinationID")).put("libraryType", j.getString("libraryType")).put("libraryID", j.getString("libraryID")).put("collection", j.optString("collection")).put("paperID", j.getString("paperID")).put("identity", j.getString("identity")).put("bibliography", j.getJSONObject("bibliography")).put("roles", JSONArray(rows.map { r -> JSONObject().put("role", r.getString("role")).put("title", r.getString("title")).put("contentType", r.getString("contentType")).put("sha256", r.getString("sha256")).put("note", r.getBoolean("note")) }))
        require(j.getString("planSHA") == sha256(canonical(originalPlan).toByteArray())) { "原 Storage 计划身份不符" }
        require(attrs(file.parentFile).fileKey() == dirKey); same(file, before)
        return MigrationParent(issuer, id, bytes, sha256(bytes), dirKey, before.fileKey() ?: error("原记录身份缺失"), facts)
    }
    fun requireParent(parent: MigrationParent) {
        require(parent.issuedBy(issuer)); val fresh = captureParent(parent.id)
        require(fresh.sha256 == parent.sha256 && fresh.directoryKey == parent.directoryKey && fresh.headerKey == parent.headerKey && fresh.materialFacts.map { Triple(it.key, it.mtime, it.sha256) } == parent.materialFacts.map { Triple(it.key, it.mtime, it.sha256) }) { "原存档已变化，迁移来源失效" }
    }
    /** Per-buffer TOCTOU check; complete original bytes/SHA are also checked at every phase boundary. */
    fun requireParentQuick(parent: MigrationParent) {
        require(parent.issuedBy(issuer)); val file=header(parent.id)
        require(attrs(file.parentFile).fileKey()==parent.directoryKey&&attrs(file).fileKey()==parent.headerKey&&file.length()==parent.bytes.size.toLong()) { "原存档身份已变化" }
        parent.materialFacts.forEach{fact->val a=attrs(fact.file);require(a.isRegularFile&&a.fileKey()==fact.key&&a.size()==fact.bytes&&a.lastModifiedTime().toMillis()==fact.mtime){"原存档材料已变化"}}
    }
    private fun roleIdentity(j: JSONObject) = canonical(JSONArray(j.getJSONArray("roles").objects().map { r -> JSONObject().put("role", r.getString("role")).put("key", r.getString("key")).put("title", r.getString("title")).put("contentType", r.getString("contentType")).put("sha256", r.getString("sha256")).put("bytes", r.getLong("bytes")).put("note", r.getBoolean("note")) }))
    private fun writeNew(file:File,bytes:ByteArray,onCreated:((ZoteroOwnedFileReceipt)->Unit)?=null):ZoteroOwnedFileReceipt{
        var created:ZoteroOwnedFileReceipt?=null
        directory(file.parentFile)
        try{
            ownedFiles.create(file).use{sink->
                created=sink.receipt;onCreated?.invoke(sink.receipt)
                val buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining())require(sink.channel.write(buffer)>0)
                sink.force();sink.receipt.requireCurrent()
            }
            val receipt=requireNotNull(created);receipt.requireCurrent();require(BackupCodec.hash(file)==sha256(bytes));receipt.requireCurrent();return receipt
        }catch(e:Throwable){
            try{created?.deleteIfCurrent()}catch(cleanup:Throwable){e.addSuppressed(cleanup)}
            throw e
        }
    }

    /** Delete only this call's unpublished files, never a completed UUID child or an exchanged inode. */
    private fun cleanupStaging(dir:File,directoryKey:Any,owned:Map<String,ZoteroOwnedFileReceipt>){
        directory(dir);require(attrs(dir).fileKey()==directoryKey){"未发布副本目录已变化，原样保留待检查"}
        for((name,receipt)in owned){
            val file=File(dir,name)
            if(!Files.exists(file.toPath(),NOFOLLOW_LINKS))continue
            require(attrs(dir).fileKey()==directoryKey&&receipt.deleteIfCurrent()) { "未发布副本文件已变化，原样保留待检查" }
        }
        require(attrs(dir).fileKey()==directoryKey&&dir.listFiles()?.isEmpty()==true){"未发布副本含未知文件，原样保留待检查"}
        Files.delete(dir.toPath());com.nanless.paperdigest.zotero.webdav.DavFiles.syncDirectory(records)
    }
    private fun publishFile(file: File, value: JSONObject) {
        require(!Files.exists(file.toPath(), NOFOLLOW_LINKS)); val tmp = File(file.parentFile, ".intent-${UUID.randomUUID()}")
        val receipt=writeNew(tmp,value.toString(2).toByteArray())
        try{receipt.requireCurrent();require(!Files.exists(file.toPath(),NOFOLLOW_LINKS));Files.move(tmp.toPath(),file.toPath(),ATOMIC_MOVE);com.nanless.paperdigest.zotero.webdav.DavFiles.syncDirectory(file.parentFile)}
        catch(e:Throwable){try{receipt.deleteIfCurrent()}catch(cleanup:Throwable){e.addSuppressed(cleanup)};throw e}
    }
    private fun <T> locked(body: () -> T): T = synchronized(monitor) {
        make(control); val rootKey = attrs(control).fileKey(); val lock = File(control, ".migration.lock")
        FileChannel.open(lock.toPath(), CREATE, READ, WRITE, NOFOLLOW_LINKS).use { channel ->
            BackupCodec.privateFile(lock); val key = attrs(lock).fileKey(); require(key != null && attrs(lock).isRegularFile && (Files.getAttribute(lock.toPath(), "unix:nlink", NOFOLLOW_LINKS) as Number).toInt() == 1)
            channel.lock().use { require(attrs(control).fileKey() == rootKey && attrs(lock).fileKey() == key); val result = body(); require(attrs(control).fileKey() == rootKey && attrs(lock).fileKey() == key); result }
        }
    }
    private fun publishedChildIDs(parentID: String): List<String> {
        directory(records)
        return requireNotNull(records.listFiles()).mapNotNull { dir ->
            if (!runCatching { UUID.fromString(dir.name).toString() == dir.name }.getOrDefault(false)) return@mapNotNull null
            directory(dir); val marker = File(dir, "migration-origin.json")
            if (!Files.exists(marker.toPath(), NOFOLLOW_LINKS)) return@mapNotNull null
            val j = JSONObject(read(BackupCodec.checkedFile(dir, "journal.json")).toString(Charsets.UTF_8))
            if (j.getString("migrationParentID") == parentID) dir.name else null
        }
    }
    fun parentHasMigration(id: String): Boolean {
        uuid(id); directory(researchRoot)
        if (Files.exists(control.toPath(), NOFOLLOW_LINKS)) { directory(control); if (Files.exists(File(control, "$id.json").toPath(), NOFOLLOW_LINKS)) return true }
        return publishedChildIDs(id).isNotEmpty()
    }
    fun childForParent(id: String): String? {
        uuid(id); val linkFile = File(control, "$id.json")
        if (Files.exists(control.toPath(), NOFOLLOW_LINKS)) {
            directory(control)
            if (Files.exists(linkFile.toPath(), NOFOLLOW_LINKS)) {
                val link = JSONObject(read(BackupCodec.checkedFile(control, "$id.json")).toString(Charsets.UTF_8)); val child = link.getString("childID"); uuid(child)
                val opened = openChild(child); require(opened.origin.getString("parentJournalID") == id && opened.origin.getString("parentJournalSHA256") == link.getString("parentJournalSHA256")); return child
            }
        }
        val orphaned = publishedChildIDs(id); require(orphaned.size <= 1) { "同一原存档存在多个迁移记录，请保留原件核对" }
        return orphaned.singleOrNull()?.also { openChild(it) }
    }
    private fun planSHA(parent: JSONObject, target: ZoteroDavTarget, rows: List<JSONObject>): String = sha256(canonical(JSONObject().put("davTarget", target.binding()).put("attachmentBackend", "webdav").put("contract", "paperdigest-zotero-plan-v1").put("destinationID", parent.getString("destinationID")).put("libraryType", parent.getString("libraryType")).put("libraryID", parent.getString("libraryID")).put("collection", parent.optString("collection")).put("paperID", parent.getString("paperID")).put("identity", parent.getString("identity")).put("bibliography", parent.getJSONObject("bibliography")).put("roles", JSONArray(rows.map { r -> JSONObject().put("role", r.getString("role")).put("title", r.getString("title")).put("contentType", r.getString("contentType")).put("sha256", r.getString("sha256")).put("note", r.getBoolean("note")) }))).toByteArray())
    fun create(parent: MigrationParent, target: ZoteroDavTarget, observations: List<MigrationApiObservation>, check: () -> Unit): MigrationChild = locked {
        check(); requireParent(parent); val old = parent.header(); require(target.userID == old.getString("libraryID"))
        childForParent(parent.id)?.let { id ->
            val child = openChild(id); require(target.matches(child.origin.getJSONObject("target"))) { "此原记录已有另一迁移目标，未创建新计划" }
            val link = File(control, "${parent.id}.json")
            if (!Files.exists(link.toPath(), NOFOLLOW_LINKS)) { beforeLinkPublish(); publishFile(link, JSONObject().put("contract", "paperdigest-storage-migration-link-v1").put("parentJournalID", parent.id).put("parentJournalSHA256", parent.sha256).put("childID", id)) }
            return@locked child
        }
        require(observations.map { it.key }.toSet() == old.getJSONArray("roles").objects().map { it.getString("key") }.toSet())
        require(records.usableSpace > parent.materialFacts.sumOf { it.bytes } + 4L*1024*1024) { "保存迁移副本的可用空间不足" }
        val id = UUID.randomUUID().toString(); val staging = File(records, ".migration-$id"); require(staging.mkdir()); directory(staging); BackupCodec.privateDirectory(staging)
        val stageKey = attrs(staging).fileKey()?:error("迁移副本目录身份缺失")
        val owned=linkedMapOf<String,ZoteroOwnedFileReceipt>()
        fun own(file:File,receipt:ZoteroOwnedFileReceipt){receipt.requireCurrent();owned[file.name]=receipt}
        var failure:Throwable?=null
        try{
        val rows = old.getJSONArray("roles").objects().mapIndexed { i, original ->
            check(); val fact = parent.materialFacts[i]; val sourceBefore = attrs(fact.file); val copy = File(staging, "material-$i")
            ownedFiles.create(copy).use { output -> own(copy,output.receipt); FileChannel.open(fact.file.toPath(), READ, NOFOLLOW_LINKS).use { input -> val b = ByteBuffer.allocate(65536); while (true) { check(); b.clear(); val n = input.read(b); if (n < 0) break; require(n > 0); b.flip(); while (b.hasRemaining()) require(output.channel.write(b)>0) } }; output.force();output.receipt.requireCurrent() }
            same(fact.file, sourceBefore); requireNotNull(owned[copy.name]).requireCurrent();require(copy.length() == fact.bytes && BackupCodec.hash(copy) == fact.sha256);requireNotNull(owned[copy.name]).requireCurrent()
            val observation = observations.single { it.key == original.getString("key") }
            original.copy().also { r -> listOf("davJournalID", "davVerification", "uploadTransferred", "verifiedAt", "version").forEach(r::remove); r.put("created", observation.exists).put("status", "prepared"); observation.version?.let { r.put("version", it) } }
        }
        val origin = JSONObject().put("contract", "paperdigest-storage-migration-origin-v1").put("childID", id).put("parentJournalID", parent.id).put("parentJournalSHA256", parent.sha256).put("parentPlanSHA256", old.getString("planSHA")).put("target", target.binding()).put("baseURL", target.root.removeSuffix("zotero/")).put("username", target.username).put("observations", JSONArray(observations.map { it.json() }))
        origin.put("sourceMaterialTimes",JSONArray(rows.mapIndexed{i,r->val observed=observations.single{it.key==r.getString("key")};JSONObject().put("role",r.getString("role")).put("key",r.getString("key")).put("sourceObservedMtimeMillis",parent.materialFacts[i].mtime).put("copyInitialMtimeMillis",attrs(File(staging,"material-$i")).lastModifiedTime().toMillis()).put("apiObservedWireMtimeMillis",observed.mtime?:JSONObject.NULL)}))
        val originBytes = origin.toString(2).toByteArray(); writeNew(File(staging, "source-journal.json"), parent.bytes){own(File(staging,"source-journal.json"),it)}; writeNew(File(staging, "migration-origin.json"), originBytes){own(File(staging,"migration-origin.json"),it)}
        val child = old.copy().also { j -> listOf("completedAt", "error", "davTarget").forEach(j::remove); j.put("id", id).put("createdAt", now()).put("status", "prepared").put("attachmentBackend", "webdav").put("davTarget", target.binding()).put("roles", JSONArray(rows)).put("planSHA", planSHA(old, target, rows)).put("migrationOriginSHA256", sha256(originBytes)).put("migrationParentID", parent.id) }
        writeNew(File(staging, "journal.json"), child.toString(2).toByteArray()){own(File(staging,"journal.json"),it)}; check(); requireParent(parent); require(attrs(staging).fileKey() == stageKey)
        com.nanless.paperdigest.zotero.webdav.DavFiles.syncDirectory(staging)
        val final = File(records, id); require(!Files.exists(final.toPath(), NOFOLLOW_LINKS)); Files.move(staging.toPath(), final.toPath(), ATOMIC_MOVE); com.nanless.paperdigest.zotero.webdav.DavFiles.syncDirectory(records)
        beforeLinkPublish(); publishFile(File(control, "${parent.id}.json"), JSONObject().put("contract", "paperdigest-storage-migration-link-v1").put("parentJournalID", parent.id).put("parentJournalSHA256", parent.sha256).put("childID", id))
        check(); requireParent(parent); openChild(id)
        }catch(e:Throwable){failure=e;throw e}
        finally{
            if(Files.exists(staging.toPath(),NOFOLLOW_LINKS)){
                try{cleanupStaging(staging,stageKey,owned)}catch(cleanup:Throwable){if(failure!=null)failure.addSuppressed(cleanup)else throw cleanup}
            }
        }
    }
    fun openChild(id: String): MigrationChild {
        val file = header(id); val child = JSONObject(read(file).toString(Charsets.UTF_8)); require(child.optString("contract") == "paperdigest-zotero-web-v1" && child.getString("id") == id)
        val originFile = BackupCodec.checkedFile(file.parentFile, "migration-origin.json"); val originBytes = read(originFile); require(sha256(originBytes) == child.getString("migrationOriginSHA256")); val origin = JSONObject(originBytes.toString(Charsets.UTF_8))
        require(origin.getString("contract") == "paperdigest-storage-migration-origin-v1" && origin.getString("childID") == id); val parent = captureParent(origin.getString("parentJournalID")); require(parent.sha256 == origin.getString("parentJournalSHA256"))
        require(BackupCodec.hash(BackupCodec.checkedFile(file.parentFile, "source-journal.json")) == parent.sha256)
        val old = parent.header(); require(listOf("destinationID", "libraryType", "libraryID", "collection", "options").all { canonical(child.opt(it)) == canonical(old.opt(it)) }) { "迁移子记录更换了原文库或选择" }; require(child.getString("migrationParentID") == parent.id && child.getString("parentKey") == old.getString("parentKey") && child.getString("paperID") == old.getString("paperID") && child.getString("identity") == old.getString("identity") && canonical(child.getJSONObject("bibliography")) == canonical(old.getJSONObject("bibliography")) && roleIdentity(child) == roleIdentity(old))
        val binding = origin.getJSONObject("target"); val target = ZoteroDavTarget.native("users", old.getString("libraryID"), origin.getString("baseURL"), origin.getString("username"), binding.getString("destinationID"), binding.getString("accountID")); require(target.matches(binding) && target.matches(child.getJSONObject("davTarget")) && child.getString("attachmentBackend") == "webdav" && child.getString("planSHA") == planSHA(old, target, child.getJSONArray("roles").objects()))
        child.getJSONArray("roles").objects().forEachIndexed { i, row -> require(row.getString("file") == "material-$i"); val material = BackupCodec.checkedFile(file.parentFile, "material-$i"); require(material.length() == row.getLong("bytes") && BackupCodec.hash(material) == row.getString("sha256")) }
        requireParent(parent); return MigrationChild(issuer, id, child, origin, target)
    }
    fun isChild(id: String): Boolean { val file = header(id); return Files.exists(File(file.parentFile, "migration-origin.json").toPath(), NOFOLLOW_LINKS) || JSONObject(read(file).toString(Charsets.UTF_8)).has("migrationOriginSHA256") }
    fun requireChild(child: MigrationChild) { require(child.issuedBy(issuer)); val fresh = openChild(child.id); require(fresh.origin.toString() == child.origin.toString()) }
}
