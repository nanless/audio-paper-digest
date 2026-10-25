package com.nanless.paperdigest.ui

import java.net.URI

/** Only immutable bundled license pages; never arbitrary file/content/network. */
internal object OfflineLicenseRoute {
    const val INDEX = "https://paperdigest-offline.invalid/licenses/index.html"
    fun assetPath(value: String, method: String = "GET"): String? {
        if (method != "GET") return null
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        if (uri.scheme != "https" || uri.rawAuthority != "paperdigest-offline.invalid" || uri.rawQuery != null) return null
        val path = uri.path ?: return null
        if (uri.rawPath != path || !path.startsWith("/licenses/")) return null
        val pieces = path.removePrefix("/").split('/')
        if (pieces.any { it.isEmpty() || it == "." || it == ".." || !it.matches(Regex("[A-Za-z0-9._-]+")) }) return null
        if (!listOf(".html", ".txt", ".json").any { path.endsWith(it) }) return null
        return pieces.joinToString("/")
    }
}
