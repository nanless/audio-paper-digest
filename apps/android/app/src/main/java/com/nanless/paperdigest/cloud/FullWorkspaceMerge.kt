package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.data.CatalogRepository
import com.nanless.paperdigest.data.PersonalStore
import com.nanless.paperdigest.data.OfflineStore
import com.nanless.paperdigest.data.canonical
import com.nanless.paperdigest.data.copy
import com.nanless.paperdigest.data.objects
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE

/** Full sync imports original research bytes without replacing a local workspace. */
internal object FullWorkspaceMerge {
    private val roots = setOf("Imports", "Offline", "ModelUsage", "ZoteroArchives", "ZoteroDavArchives", "zotero-archives", "Exports")
    private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

    fun includes(path: String): Boolean {
        if (path.split('/').any { it.startsWith(".sync-import-") || it.startsWith(".sync-package-") }) return false
        if (path.startsWith("ModelUsage/") && uuid.find(path.substringAfter('/').substringBefore('/')) == null) return false
        if (path.startsWith("Imports/") || path.startsWith("PublishedLibrary/pdf/")) {
            val parent = if (path.startsWith("Imports/")) "Imports/" else "PublishedLibrary/pdf/"
            val name = path.removePrefix(parent)
            return name.endsWith(".pdf") && BackupCodec.validSHA(name.removeSuffix(".pdf"))
        }
        return path == "personal.json" || path == BackupCodec.ROOTS_FILE || path.substringBefore('/') in roots
    }

    fun capturePersonal(local: JSONObject): JSONObject = PersonalStore.initial()
        .put("personalPapers", local.optJSONObject("personalPapers")?.copy() ?: JSONObject())
        .put("sessions", JSONArray(local.getJSONArray("sessions").objects().filterNot { it.optBoolean("syncedHistory") }))

    private fun group(path: String): String {
        val root = path.substringBefore('/')
        val item = path.substringAfter('/').substringBefore('/')
        return when (root) {
            "Offline" -> "$root/$item"
            "ModelUsage", "ZoteroArchives", "ZoteroDavArchives", "zotero-archives" ->
                "$root/${uuid.find(item)?.value?.lowercase() ?: item.substringBefore('.')}"
            else -> path
        }
    }

    private fun destination(root: File, relative: String): File? {
        BackupCodec.checkedPath(relative)
        var parent = root
        val parts = relative.split('/')
        for ((index, part) in parts.withIndex()) {
            val candidate = File(parent, part)
            if (Files.isSymbolicLink(candidate.toPath())) return null
            val aliases = parent.listFiles()?.filter { BackupCodec.alias(it.name) == BackupCodec.alias(part) }.orEmpty()
            if (aliases.any { it.name != part }) return null
            if (index < parts.lastIndex && candidate.exists() && !candidate.isDirectory) return null
            if (index == parts.lastIndex && candidate.exists() && !candidate.isFile) return null
            parent = candidate
        }
        return parent
    }

    private fun install(source: File, target: File, entry: BackupCodec.Entry, check: () -> Unit) {
        val parent = requireNotNull(target.parentFile)
        if (!parent.exists()) require(parent.mkdirs())
        BackupCodec.checkedDirectory(parent)
        val temporary = Files.createTempFile(parent.toPath(), ".sync-import-", ".tmp").toFile()
        try {
            BackupCodec.privateFile(temporary)
            source.inputStream().buffered().use { input ->
                temporary.outputStream().use { output ->
                    val buffer = ByteArray(65536)
                    while (true) {
                        check()
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                    }
                    output.fd.sync()
                }
            }
            require(temporary.length() == entry.bytes && BackupCodec.hash(temporary, check) == entry.sha256)
            check()
            // The shared maintenance lock and no competing artifact job protect
            // the destination. Android's app sandbox disallows hard-link creation.
            require(!target.exists() && !Files.isSymbolicLink(target.toPath()))
            Files.move(temporary.toPath(), target.toPath(), ATOMIC_MOVE)
        } finally { temporary.delete() }
    }

    /** Requires the application's maintenance lock. Replays only add missing bytes. */
    fun merge(research: File, store: PersonalStore, incoming: BackupCodec.Staged, check: () -> Unit): Int {
        BackupCodec.requirePortableInventory(incoming.entries)
        val remote = JSONObject(BackupCodec.checkedFile(incoming.directory, "personal.json").readText())
        PersonalStore.validate(remote)
        val entries = incoming.entries.filter { includes(it.path) && it.path !in setOf("personal.json", BackupCodec.ROOTS_FILE) }
        val rejected = HashSet<String>()
        try { BackupCodec.mergeVerifiedAliases(research, incoming) }
        catch (_: IllegalArgumentException) { rejected += BackupCodec.ROOTS_FILE }
        incoming.entries.filterNot { includes(it.path) }.forEach { rejected += it.path }
        for ((identity, files) in entries.groupBy { group(it.path) }) {
            check()
            if ((identity.startsWith("Imports/") || identity.startsWith("PublishedLibrary/pdf/")) &&
                files.any { it.path.substringAfterLast('/').removeSuffix(".pdf") != it.sha256 }) {
                rejected += identity
                continue
            }
            if (identity.startsWith("Offline/")) {
                val id = identity.substringAfter('/')
                try { OfflineStore(research).verifyAt(File(incoming.directory, identity), id) }
                catch (_: Exception) { rejected += identity; continue }
            }
            val historyPrefix = if (identity.substringBefore('/') in setOf("ZoteroArchives", "ZoteroDavArchives", "zotero-archives"))
                "SyncedArchiveHistory/${incoming.encodedSHA256}/" else ""
            val targets = files.map { entry -> entry to destination(research, historyPrefix + entry.path) }
            if (targets.any { (entry, file) ->
                file == null || (file.exists() && (file.length() != entry.bytes || BackupCodec.hash(file, check) != entry.sha256))
            }) {
                rejected += identity
                continue
            }
            val groupRelative = files.first().path.split('/').take(2).joinToString("/")
            val directoryGroup = files.all { it.path.startsWith("$groupRelative/") }
            val groupPath = historyPrefix + groupRelative
            val groupTarget = if (directoryGroup) File(research, groupPath) else null
            if (groupTarget != null && !groupTarget.exists()) {
                val parent = requireNotNull(groupTarget.parentFile)
                if (!parent.exists()) require(parent.mkdirs())
                BackupCodec.checkedDirectory(parent)
                val stage = Files.createTempDirectory(research.parentFile!!.toPath(), ".sync-package-").toFile()
                try {
                    BackupCodec.privateDirectory(stage)
                    for ((entry, _) in targets) {
                        val file = File(stage, entry.path.removePrefix("$groupRelative/"))
                        install(BackupCodec.checkedFile(incoming.directory, entry.path), file, entry, check)
                    }
                    check()
                    require(!groupTarget.exists())
                    Files.move(stage.toPath(), groupTarget.toPath(), ATOMIC_MOVE)
                } finally { stage.deleteRecursively() }
            } else for ((entry, file) in targets) if (!requireNotNull(file).exists()) {
                install(BackupCodec.checkedFile(incoming.directory, entry.path), file, entry, check)
            }
        }
        return store.mergeSyncedResearch { local ->
            val papers = local.optJSONObject("personalPapers") ?: JSONObject().also { local.put("personalPapers", it) }
            remote.optJSONObject("personalPapers")?.let { supplied ->
                supplied.keys().forEach { id ->
                    val original = supplied.getJSONObject(id)
                    val kind = original.getString("sourceKind")
                    // Published metadata can include device-local reading fields. The
                    // catalog still owns these public records; retain their raw bytes
                    // in the snapshot without assigning a local PDF or counting a conflict.
                    if (kind != "local" && !id.startsWith("local:") &&
                        original.optString("blogURL").let { it.isNotBlank() && runCatching { CatalogRepository.sameSite(it) }.isSuccess }) {
                        return@forEach
                    }
                    val hash = id.removePrefix("local:")
                    val path = "Imports/$hash.pdf"
                    if (kind != "local" || !id.startsWith("local:") || !BackupCodec.validSHA(hash) || rejected.contains(path) ||
                        entries.none { it.path == path && it.sha256 == hash }) {
                        rejected += "paper/$id"
                    } else {
                        val projected = original.copy().put("localPDFPath", File(research, path).absolutePath)
                        val old = papers.optJSONObject(id)
                        if (old == null) papers.put(id, projected)
                        else if (canonical(old) != canonical(projected)) rejected += "paper/$id"
                    }
                }
            }
            val sessions = local.getJSONArray("sessions")
            val known = (0 until sessions.length()).associateBy({ sessions.getJSONObject(it).optString("id") }, { sessions.getJSONObject(it) })
            val others = remote.getJSONArray("sessions").objects().groupBy { it.optString("id") }
            for ((id, records) in others) {
                if (id.isBlank() || records.size != 1 || "ModelUsage/${id.lowercase()}" in rejected) {
                    rejected += "session/$id"
                    continue
                }
                val original = records.single()
                val old = known[id]
                if (old == null) {
                    sessions.put(original.copy().put("syncedHistory", true))
                } else {
                    val comparable = old.copy().apply { remove("syncedHistory") }
                    val supplied = original.copy().apply { remove("syncedHistory") }
                    if (canonical(comparable) != canonical(supplied)) rejected += "session/$id"
                }
            }
            check()
            rejected.size
        }
    }
}
