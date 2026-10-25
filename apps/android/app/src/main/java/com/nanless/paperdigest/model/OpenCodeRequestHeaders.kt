package com.nanless.paperdigest.model

import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Locale
import java.util.UUID

/** Service compatibility metadata, added only for the original unambiguous OpenCode Go route. */
internal object OpenCodeRequestHeaders {
    fun apply(endpoint: String, sessionID: String, request: Request): Request {
        if (!isGoEndpoint(endpoint)) return request
        val builder = request.newBuilder()
        if (request.header("User-Agent") == null) builder.header("User-Agent", "audio-paper-digest/1.0")
        if (request.header("x-opencode-session") == null) {
            require(UUID.fromString(sessionID).toString() == sessionID) { "研究会话身份无效，尚未派发" }
            builder.header("x-opencode-session", "audio-paper-digest-$sessionID")
        }
        return builder.build()
    }

    internal fun isGoEndpoint(endpoint: String): Boolean = try {
        if ('\\' in endpoint) false else {
            val uri = URI(endpoint)
            val rawPath = uri.rawPath ?: "/"
            val decodedPath = decodePath(rawPath)
            val path = rawPath.trimEnd('/').lowercase(Locale.ROOT)
            uri.scheme.equals("https", ignoreCase = true) && uri.host.equals("opencode.ai", ignoreCase = true) &&
                (uri.port == -1 || uri.port == 443) && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
                !dotSegment(rawPath) && !dotSegment(decodedPath) && !Regex("%(?:2f|5c)", RegexOption.IGNORE_CASE).containsMatchIn(rawPath) &&
                (path == "/zen/go" || path.startsWith("/zen/go/"))
        }
    } catch (_: Exception) { false }

    private fun dotSegment(path: String): Boolean = path.split('/', '\\').any { it == "." || it == ".." }

    /** Percent decoding is strict UTF-8 and keeps '+' literal, as decodeURIComponent does. */
    private fun decodePath(raw: String): String = buildString(raw.length) {
        var index = 0
        while (index < raw.length) {
            if (raw[index] != '%') { append(raw[index++]); continue }
            val bytes = ByteArrayOutputStream()
            while (index < raw.length && raw[index] == '%') {
                require(index + 2 < raw.length)
                val high = raw[index + 1].digitToIntOrNull(16) ?: throw IllegalArgumentException()
                val low = raw[index + 2].digitToIntOrNull(16) ?: throw IllegalArgumentException()
                bytes.write((high shl 4) or low); index += 3
            }
            append(Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())))
        }
    }
}
