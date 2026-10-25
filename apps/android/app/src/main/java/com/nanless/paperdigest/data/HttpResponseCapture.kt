package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import org.json.JSONObject
import kotlinx.coroutines.CancellationException
import java.io.File
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.UUID

/** Durable supplementary original bytes. This receipt never grants complete-response/model adoption. */
class HttpResponseCapture private constructor(
    val bodyFile: File, val manifestFile: File, private val sessionID: String, private val inputSHA256: String,
    private val captureID: String, private val limit: Int, private val signer: (JSONObject) -> String,
    private val timestamp: () -> String, private val channel: FileChannel
) {
    private var startedAt: String? = null
    private var issued = false
    private var httpStatus: Int? = null
    private var count = 0L
    private var status = "prepared"
    private var closed = false
    private val digest = MessageDigest.getInstance("SHA-256")
    @Volatile var persistenceWarning: String? = null
        private set

    @Synchronized fun bindIssued(start: String) {
        check(!closed && !issued)
        require(com.nanless.paperdigest.cloud.RequestContinuity.validTime(start))
        startedAt = start; issued = true; status = "issued"; persist()
    }

    @Synchronized fun responseStarted(code: Int) {
        check(!closed && issued); require(code in 100..999)
        httpStatus = code; status = "receiving"; persist()
    }

    /** Force the newly received chunk before allowing the HTTP reader to request another chunk. */
    @Synchronized fun append(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size) {
        check(!closed && issued && status == "receiving")
        require(offset >= 0 && length >= 0 && offset <= bytes.size - length && count + length <= limit)
        try {
            val buffer = ByteBuffer.wrap(bytes, offset, length)
            while (buffer.hasRemaining()) channel.write(buffer)
            channel.force(true)
            digest.update(bytes, offset, length); count += length
            persist()
        } catch (_: Exception) {
            persistenceWarning = "已接收响应的保存或回执未能全部确认。"
            throw AppFailure("capture", "已接收响应的保存或回执未完成；保留可保全的原始字节，未将部分内容视为完整回答。")
        }
    }

    @Synchronized fun finish(terminal: String) {
        if (closed) return
        require(terminal in setOf("body-complete", "failed", "cancelled", "not-issued"))
        try {
            // A failed write/force can leave a real prefix beyond the last signed
            // chunk. Record its actual bytes when readable, never invent a count.
            channel.force(true)
            count = channel.size(); require(count <= limit)
            status = terminal; persist(actualFileHash = true)
        } catch (_: Exception) {
            persistenceWarning = "响应原始字节或终态回执未能全部确认保存。"
            throw AppFailure("capture", "响应原始字节或终态回执未能全部确认保存；现有文件已保留，不能声称恢复材料完整。")
        } finally { closed = true; runCatching { channel.close() } }
    }

    private fun hashCurrent(): String = try {
        (digest.clone() as MessageDigest).digest().hex()
    } catch (_: CloneNotSupportedException) { BackupCodec.hash(bodyFile) }

    private fun persist(actualFileHash: Boolean = false) {
        val record = JSONObject().put("contract", "android-http-response-capture-v1")
            .put("sessionID", sessionID).put("inputSHA256", inputSHA256).put("captureID", captureID)
            .put("startedAt", startedAt ?: JSONObject.NULL).put("requestIssued", issued).put("status", status)
            .put("httpStatus", httpStatus ?: JSONObject.NULL).put("byteCount", count)
            .put("sha256", if (actualFileHash) BackupCodec.hash(bodyFile) else hashCurrent()).put("updatedAt", timestamp())
        record.put("hmacSHA256", signer(record))
        val raw = canonical(record).toByteArray(Charsets.UTF_8)
        JsonFiles.write(manifestFile, raw)
        require(JsonFiles.read(manifestFile, 1024 * 1024L).contentEquals(raw))
    }

    companion object {
        /** Known path/space/write/receipt faults fail here, before issued bookkeeping or HTTP. */
        fun prepare(usage: File, sessionID: String, inputSHA256: String, limit: Int,
                    signer: (JSONObject) -> String, timestamp: () -> String = { now() },
                    available: (File) -> Long = { it.usableSpace }): HttpResponseCapture {
            require(UUID.fromString(sessionID).toString() == sessionID && BackupCodec.validSHA(inputSHA256) && limit in 1..16 * 1024 * 1024)
            require(usage.isDirectory)
            var parent: File? = usage.absoluteFile
            while (parent != null) { require(!Files.isSymbolicLink(parent.toPath())) { "响应目录不能经过链接" }; parent = parent.parentFile }
            for (suffix in listOf("response.bin", "response.json")) {
                require(!Files.exists(File(usage, "$sessionID-$suffix").toPath(), LinkOption.NOFOLLOW_LINKS)) { "原响应目标已存在或不可写，未发出新的模型请求" }
            }
            // This detects already-known lack of space; it does not promise
            // that another process cannot consume the volume during a request.
            val free = try { available(usage) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { throw AppFailure("storage", "无法确认响应保存空间，尚未派发模型请求。") }
            require(free >= limit.toLong() * 3 + 1024 * 1024) { "响应保存空间不足或无法确认，未发出模型请求" }
            val captureID = UUID.randomUUID().toString(); val base = "$sessionID-response-capture-$captureID"
            val body = File(usage, "$base.bin"); val manifest = File(usage, "$base.json")
            val channel = FileChannel.open(body.toPath(), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)
            try {
                BackupCodec.privateFile(body)
                channel.write(ByteBuffer.wrap(byteArrayOf(0))); channel.force(true); channel.truncate(0); channel.force(true)
                val result = HttpResponseCapture(body, manifest, sessionID, inputSHA256, captureID, limit, signer, timestamp, channel)
                result.persist()
                return result
            } catch (_: Exception) {
                runCatching { channel.close() }
                // Empty/prefix material is deliberately kept, with its unique
                // capture UUID, so a later preparation cannot overwrite it.
                throw AppFailure("capture", "响应保存预检未完成，未发出模型请求；已产生的本机材料保留。")
            }
        }
        private fun ByteArray.hex() = joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}
