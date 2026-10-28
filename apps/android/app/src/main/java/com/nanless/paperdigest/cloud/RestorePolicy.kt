package com.nanless.paperdigest.cloud

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.time.Instant
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import java.util.UUID

object RequestContinuity {
    const val FILE = "RequestBudgetContinuity.json"
    data class Issued(val id: String, val startedAt: String)
    fun union(vararg groups: List<Issued>): List<Issued> {
        val result = sortedMapOf<String, Issued>()
        groups.forEach { group -> group.forEach { item ->
            require(item.id.isNotEmpty() && item.id.toByteArray().size <= 256 && validTime(item.startedAt)) { "原请求身份或时间无效" }
            val old = result.putIfAbsent(item.id, item); require(old == null || old == item) { "同一原请求的派发时间冲突" }; require(result.size <= 100_000) { "请求连续性超限" }
        } }; return result.values.toList()
    }
    fun validTime(value: String): Boolean {
        if (!Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z").matches(value) || value.take(4) == "0000") return false
        return runCatching { LocalDateTime.parse(value.take(19), DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss").withResolverStyle(ResolverStyle.STRICT)); Instant.parse(value); true }.getOrDefault(false)
    }
    fun sessions(personal: JSONObject): List<Issued> {
        val a = personal.getJSONArray("sessions"); return (0 until a.length()).map { a.getJSONObject(it) }.filter { it.opt("requestIssued") == true }.map { Issued(it.getString("id"), it.getString("startedAt")) }
    }
    fun read(directory: File, check: () -> Unit = {}): List<Issued> {
        val file = File(directory, FILE); if (!file.exists()) { require(!Files.isSymbolicLink(file.toPath())); return emptyList() }
        BackupCodec.checkedFile(directory, FILE); require(file.length() <= 32L * 1024 * 1024)
        val obj = JSONObject(com.nanless.paperdigest.data.PublishedUtf8.decode(RestorePolicyIO.read(file,32L*1024*1024,check))); require(obj.getString("contract") == "paperdigest-request-continuity-v1")
        val a = obj.getJSONArray("requests"); require(a.length() <= 100_000)
        return union((0 until a.length()).map { check(); val row = a.getJSONObject(it); Issued(row.getString("id"), row.getString("startedAt")) })
    }
    fun count(dayUTC: String, directory: File, personal: JSONObject): Int = union(read(directory), sessions(personal)).count { it.startedAt.startsWith(dayUTC + "T") }
    fun json(entries: List<Issued>) = JSONObject().put("contract", "paperdigest-request-continuity-v1").put("requests", JSONArray(entries.map { JSONObject().put("id", it.id).put("startedAt", it.startedAt) }))
}

/** Root holds its shared maintenance lock, flushes edits, and obtains consent first. */
object RestorePolicy {
    val CONNECTION_KEYS = setOf("endpoint", "model", "protocol", "httpProxy", "responsesStream", "reasoningEffort", "maxTokens", "timeoutMs", "dailyRequests")
    fun apply(stage: File, current: File, check: () -> Unit = {}) {
        val original = RestorePolicyIO.read(BackupCodec.checkedFile(stage,"personal.json"),32L*1024*1024,check)
        val local = JSONObject(com.nanless.paperdigest.data.PublishedUtf8.decode(RestorePolicyIO.read(BackupCodec.checkedFile(current,"personal.json"),32L*1024*1024,check))); val restored = JSONObject(com.nanless.paperdigest.data.PublishedUtf8.decode(original))
        BackupCodec.validatePersonal(local); BackupCodec.validatePersonal(restored)
        val old = local.getJSONObject("settings"); val settings = restored.getJSONObject("settings")
        CONNECTION_KEYS.forEach { key -> check(); settings.remove(key); if (old.has(key)) settings.put(key, old.get(key)) }
        val all = RequestContinuity.union(RequestContinuity.read(current,check), RequestContinuity.read(stage,check), RequestContinuity.sessions(local), RequestContinuity.sessions(restored))
        val receipts = File(stage, "RestorationReceipts"); if (!receipts.exists()) require(receipts.mkdir()); BackupCodec.checkedDirectory(receipts); BackupCodec.privateDirectory(receipts)
        RestorePolicyIO.write(File(receipts, "${UUID.randomUUID()}-original-personal.json"), original,check)
        RestorePolicyIO.write(File(stage,RequestContinuity.FILE),RequestContinuity.json(all).toString().toByteArray(),check);RestorePolicyIO.write(File(stage,"personal.json"),restored.toString().toByteArray(),check)
    }
    /** Legacy trailing-initialize callers keep their exact source/API behavior. */
    fun install(staged:BackupCodec.Staged,current:File,initialize:()->Unit):File = install(staged,current,initialize,{})
    /** Build effective local policy in an owned copy; the original preflight survives cancellation. */
    fun install(staged:BackupCodec.Staged,current:File,initialize:()->Unit,check:()->Unit={}):File {
        check();BackupCodec.checkedDirectory(current);BackupCodec.checkedDirectory(staged.directory)
        require(staged.directory.canonicalFile!=current.canonicalFile&&staged.directory.parentFile.canonicalFile==current.parentFile.canonicalFile){"恢复暂存须位于同一本机文件系统"}
        val expected=staged.entries.associateBy{it.path}
        staged.entries.filter{it.path!=BackupCodec.ROOTS_FILE}.forEach{check();require(BackupCodec.hash(BackupCodec.checkedFile(staged.directory,it.path),check)==it.sha256){"确认前恢复材料已变化"}}
        val effective=Files.createTempDirectory(current.parentFile.toPath(),".effective-restore-").toFile();BackupCodec.privateDirectory(effective)
        var committed=false
        try {
            val seen=HashSet<String>()
            Files.walk(staged.directory.toPath()).use{walk->walk.forEach{source->
                check();require(!Files.isSymbolicLink(source)){"恢复暂存不能包含链接"}
                if(source==staged.directory.toPath())return@forEach
                val relative=staged.directory.toPath().relativize(source).toString().replace(File.separatorChar,'/')
                BackupCodec.checkedPath(relative)
                val target=File(effective,relative)
                if(Files.isDirectory(source,java.nio.file.LinkOption.NOFOLLOW_LINKS)){require(target.mkdir());BackupCodec.privateDirectory(target)}
                else {
                    require(Files.isRegularFile(source,java.nio.file.LinkOption.NOFOLLOW_LINKS))
                    require(relative==BackupCodec.ROOTS_FILE||expected.containsKey(relative)){"暂存出现未预检的额外文件，原资料未替换"}
                    // Legacy keys were fully decoded and checked above, but never
                    // become authority on this device, even on a fresh installation.
                    if(BackupCodec.isLocalOnlyIntegrityPath(relative)){seen+=relative;return@forEach}
                    java.io.FileOutputStream(target).use{output->Files.newInputStream(source,java.nio.file.StandardOpenOption.READ,java.nio.file.LinkOption.NOFOLLOW_LINKS).use{input->val b=ByteArray(65536);while(true){check();val n=input.read(b);if(n<0)break;if(n>0)output.write(b,0,n)}};output.flush();output.fd.sync()};BackupCodec.privateFile(target)
                    val actual=BackupCodec.hash(target,check)
                    if(relative!=BackupCodec.ROOTS_FILE)require(actual==expected.getValue(relative).sha256){"恢复工作副本不符原SHA"}
                    else require(actual==BackupCodec.hash(source.toFile(),check)){"原路径映射在复制时变化"}
                    seen+=relative
                }
            }}
            require(seen==expected.keys+BackupCodec.ROOTS_FILE){"恢复工作副本文件集合不完整"}
            // Only current-device keys survive the directory replacement. Never
            // generate missing keys or copy the staged archive's key material.
            for(relative in BackupCodec.localOnlyIntegrityPaths) {
                check()
                val local=File(current,relative)
                if(!Files.exists(local.toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS))continue
                val source=BackupCodec.checkedFile(current,relative)
                val target=File(effective,relative)
                require(!target.exists()&&!Files.isSymbolicLink(target.toPath()))
                target.parentFile!!.mkdirs();BackupCodec.checkedDirectory(target.parentFile!!);BackupCodec.privateDirectory(target.parentFile!!)
                java.io.FileOutputStream(target).use { output ->
                    Files.newInputStream(source.toPath(),java.nio.file.StandardOpenOption.READ,java.nio.file.LinkOption.NOFOLLOW_LINKS).use { input ->
                        val buffer=ByteArray(65536)
                        while(true){check();val n=input.read(buffer);if(n<0)break;if(n>0)output.write(buffer,0,n)}
                    }
                    output.flush();output.fd.sync()
                }
                BackupCodec.privateFile(target)
                require(BackupCodec.hash(target,check)==BackupCodec.hash(BackupCodec.checkedFile(current,relative),check)){"本机完整性材料在保留期间变化，原资料未替换"}
            }
            check();apply(effective,current,check);check()
            val before=File(current.parentFile,"${current.name}-BeforeRestore-${UUID.randomUUID()}")
            // No cancellation checks within the two-renames/initialize/rollback transaction.
            Files.move(current.toPath(),before.toPath(),ATOMIC_MOVE)
            try{Files.move(effective.toPath(),current.toPath(),ATOMIC_MOVE)}
            catch(t:Throwable){try{Files.move(before.toPath(),current.toPath(),ATOMIC_MOVE)}catch(_:Throwable){throw IllegalStateException("恢复安装失败，原资料仍保留在恢复前副本，请手动核对")};throw t}
            try{initialize()}
            catch(t:Throwable){val failed=File(current.parentFile,"${current.name}-FailedRestore-${UUID.randomUUID()}");try{Files.move(current.toPath(),failed.toPath(),ATOMIC_MOVE);Files.move(before.toPath(),current.toPath(),ATOMIC_MOVE);initialize()}catch(_:Throwable){throw IllegalStateException("恢复初始化失败，原资料与失败副本已保留，请手动核对")};throw t}
            committed=true
            // The caller's original preflight was unchanged until the atomic transaction completed.
            staged.directory.deleteRecursively()
            return before
        }finally{if(!committed&&effective.exists())effective.deleteRecursively()}
    }
}

/** Bounded exact-byte policy IO; any cancellation affects only the effective working directory. */
private object RestorePolicyIO {
 fun read(file:File,limit:Long,check:()->Unit):ByteArray {
  check();require(!Files.isSymbolicLink(file.toPath()))
  return java.nio.channels.FileChannel.open(file.toPath(),java.nio.file.StandardOpenOption.READ,java.nio.file.LinkOption.NOFOLLOW_LINKS).use { channel ->
   val size=channel.size();require(size in 0..limit&&size<=Int.MAX_VALUE){"本版个人记录或用量连续性超过32MiB，原文件未改变"};val bytes=ByteArray(size.toInt());var at=0
   while(at<bytes.size){check();val n=channel.read(java.nio.ByteBuffer.wrap(bytes,at,minOf(65536,bytes.size-at)));require(n>0){"原政策记录读取中断"};at+=n}
   check();require(channel.read(java.nio.ByteBuffer.allocate(1))==-1&&channel.size()==size){"政策记录读取期间变化"};bytes
  }
 }
 fun write(file:File,bytes:ByteArray,check:()->Unit){
  check();require(!Files.isSymbolicLink(file.toPath()));val temp=Files.createTempFile(file.parentFile.toPath(),".policy-",".tmp").toFile()
  try {BackupCodec.privateFile(temp);java.nio.channels.FileChannel.open(temp.toPath(),java.nio.file.StandardOpenOption.WRITE,java.nio.file.LinkOption.NOFOLLOW_LINKS).use { out->var at=0;while(at<bytes.size){check();val n=out.write(java.nio.ByteBuffer.wrap(bytes,at,minOf(65536,bytes.size-at)));require(n>0);at+=n};out.force(true)};check();Files.move(temp.toPath(),file.toPath(),ATOMIC_MOVE,java.nio.file.StandardCopyOption.REPLACE_EXISTING)}finally{temp.delete()}
 }
}
