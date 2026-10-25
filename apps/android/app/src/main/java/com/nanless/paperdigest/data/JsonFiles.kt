package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
fun now(): String = Instant.now().toString()
fun JSONObject.nullableString(key: String): String? = if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }
fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
/** Clone mutable containers, sharing immutable JSON scalars instead of serializing every saved answer. */
fun JSONObject.copy(): JSONObject {
    val ancestors = java.util.IdentityHashMap<Any, Boolean>()
    fun clone(value: Any?, depth: Int): Any {
        require(depth <= 128) { "资料JSON嵌套超过安全范围" }
        return when (value) {
            null, JSONObject.NULL -> JSONObject.NULL
            is JSONObject -> {
                require(ancestors.put(value, true) == null) { "资料JSON包含循环引用" }
                try { JSONObject().also { result -> value.keys().forEach { key -> result.put(key, clone(value.get(key), depth + 1)) } } }
                finally { ancestors.remove(value) }
            }
            is JSONArray -> {
                require(ancestors.put(value, true) == null) { "资料JSON包含循环引用" }
                try { JSONArray().also { result -> for (index in 0 until value.length()) result.put(clone(value.get(index), depth + 1)) } }
                finally { ancestors.remove(value) }
            }
            is String, is Boolean -> value
            is Byte, is Short, is Int, is Long, is Float, is Double, is java.math.BigInteger, is java.math.BigDecimal -> value
            is Number -> JSONObject("{\"value\":" + value.toString() + "}").get("value")
            else -> throw IllegalArgumentException("资料包含非JSON值，原材料未改写")
        }
    }
    return clone(this, 0) as JSONObject
}

/** No credentials or response bodies enter exception messages. */
class AppFailure(val category: String, message: String): Exception(message)

object JsonFiles {
    fun read(file: File, limit: Long = 32L * 1024 * 1024): ByteArray {
        require(file.isFile && !Files.isSymbolicLink(file.toPath())) { "资料文件不可用" }
        return FileInputStream(file).use { input -> readKnownLength(input, input.channel.size(), limit) }
    }

    /** One allocation for a regular file; never grows and duplicates a full-sized buffer. */
    internal fun readKnownLength(input: java.io.InputStream, expected: Long, limit: Long): ByteArray {
        require(expected >= 0 && expected <= limit && expected <= Int.MAX_VALUE) { "资料文件超过大小限制" }
        val bytes = ByteArray(expected.toInt()); var offset = 0
        while (offset < bytes.size) {
            val count = input.read(bytes, offset, bytes.size - offset)
            require(count >= 0) { "资料文件在读取期间截断，原文件保留" }
            if (count == 0) {
                val next = input.read(); require(next >= 0) { "资料文件在读取期间截断，原文件保留" }
                bytes[offset++] = next.toByte()
            } else offset += count
        }
        require(input.read() == -1) { "资料文件在读取期间变大，未截断采纳" }
        return bytes
    }

    fun write(file: File, bytes: ByteArray) {
        file.parentFile!!.mkdirs()
        require(!Files.isSymbolicLink(file.toPath())) { "资料路径不能是链接" }
        var parent: File? = file.parentFile
        while (parent != null) {
            require(!Files.isSymbolicLink(parent.toPath())) { "资料目录不能是链接" }
            parent = parent.parentFile
        }
        val temporary = File(file.parentFile, ".${file.name}.${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temporary).use { it.write(bytes); it.fd.sync() }
            temporary.setReadable(false, false); temporary.setWritable(false, false)
            temporary.setReadable(true, true); temporary.setWritable(true, true)
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { temporary.delete() }
    }

    fun write(file: File, value: JSONObject) = write(file, value.toString().toByteArray(Charsets.UTF_8))

    /** Write a bounded document without constructing a second whole-library string/byte array. */
    fun writeStream(file: File, limit: Long, body: (OutputStream) -> Unit) {
        require(limit > 0)
        file.parentFile!!.mkdirs()
        require(!Files.isSymbolicLink(file.toPath())) { "资料路径不能是链接" }
        var parent: File? = file.parentFile
        while (parent != null) { require(!Files.isSymbolicLink(parent.toPath())) { "资料目录不能是链接" }; parent = parent.parentFile }
        val temporary = File(file.parentFile, ".${file.name}.${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temporary).use { raw ->
                var written = 0L
                val bounded = object : OutputStream() {
                    override fun write(value: Int) { require(written < limit) { "资料文件超过大小限制，原文件保留" }; raw.write(value); written++ }
                    override fun write(bytes: ByteArray, offset: Int, length: Int) { require(length >= 0 && written + length <= limit) { "资料文件超过大小限制，原文件保留" }; raw.write(bytes, offset, length); written += length }
                    override fun flush() = raw.flush()
                }
                body(bounded); raw.flush(); raw.fd.sync()
            }
            temporary.setReadable(false, false); temporary.setWritable(false, false)
            temporary.setReadable(true, true); temporary.setWritable(true, true)
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { temporary.delete() }
    }
}

/** Canonical JSON is used for NEW Android identities, never to replace old sealed bytes. */
fun canonical(value: Any?): String = when (value) {
    null, JSONObject.NULL -> "null"
    is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
    is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
    is String -> JSONObject.quote(value)
    is Boolean -> value.toString()
    is Number -> JSONObject.numberToString(value)
    else -> error("不能编码的资料类型")
}
