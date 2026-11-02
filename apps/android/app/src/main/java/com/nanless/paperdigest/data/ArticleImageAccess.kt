package com.nanless.paperdigest.data

import org.jsoup.Jsoup
import org.jsoup.nodes.TextNode
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.channels.Channels
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardOpenOption.READ
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID

/** Reading holds paths and hashes, never an entire collection of Base64 image copies. */
internal class ArticleImageAccess(article: Article, private val root: File): DocumentImageAccess {
    private data class Image(val path: String, val hash: String)
    override val cspImageSource = "https://reader.invalid/article-images/${UUID.randomUUID()}/"
    private val routes = linkedMapOf<String, Image>()
    override val bodyHTML: String
    init {
        val doc = Jsoup.parseBodyFragment(article.html)
        // A repeated address with conflicting material cannot silently choose a different picture.
        val resources = article.resources.groupBy { it.sourceURL }
        doc.select("img").forEachIndexed { index, image ->
            val address = image.attr("data-source-url").ifBlank { image.attr("src") }
            val resource = resources[address]?.distinct()?.singleOrNull() ?: if (address.startsWith("data:image/") && address.length <= 24 * 1024 * 1024) {
                // Older saved HTML embedded its verified image. Match its exact bytes before migration.
                article.resources.getOrNull(index)?.takeIf { candidate -> runCatching {
                    val comma = address.indexOf(','); require(comma in 1..100 && address.substring(0, comma).endsWith(";base64"))
                    val bytes = java.util.Base64.getDecoder().decode(address.substring(comma + 1))
                    bytes.size <= 16 * 1024 * 1024 && sha256(bytes) == candidate.sha256
                }.getOrDefault(false) }
            } else null
            image.removeAttr("srcset").removeAttr("src").removeAttr("style")
            if (resource?.localPath != null && resource.sha256 != null && resource.missingReason == null) {
                val url = cspImageSource + routes.size
                routes[url] = Image(resource.localPath, resource.sha256)
                image.attr("src", url).attr("loading", "lazy").attr("decoding", "async")
            } else image.replaceWith(TextNode("[图片正在准备或尚未保存" + image.attr("alt").takeIf { it.isNotBlank() }?.let { "：$it" }.orEmpty() + "]"))
        }
        bodyHTML = doc.body().html()
    }
    override fun open(url: String, isMainFrame: Boolean, method: String): Pair<String, InputStream>? {
        if (isMainFrame || method != "GET") return null
        val material = routes[url] ?: return null
        // Re-read and verify the actual immutable bytes for every request, including restored aliases.
        val file = StoragePaths.resolve(material.path, root, material.hash, 16 * 1024 * 1024L)
        val before = Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS)
        require(before.isRegularFile && before.size() in 1..16 * 1024 * 1024L)
        val channel = FileChannel.open(file.toPath(), READ, NOFOLLOW_LINKS)
        try {
            val digest = java.security.MessageDigest.getInstance("SHA-256"); val buffer = ByteBuffer.allocate(65536)
            val prefix = ByteArray(minOf(16, before.size().toInt())); var count = 0L
            while (true) {
                buffer.clear(); val n = channel.read(buffer); if (n < 0) break
                require(n > 0 && count + n <= before.size())
                if (count < prefix.size) buffer.array().copyInto(prefix, count.toInt(), 0, minOf(n, prefix.size - count.toInt()))
                digest.update(buffer.array(), 0, n); count += n
            }
            require(count == before.size() && digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) } == material.hash)
            val raster = runCatching { AggregateImages.rasterMIME(prefix) }.getOrNull()
            val mime = raster ?: run {
                channel.position(0); val bytes = ByteArray(count.toInt()); val target = ByteBuffer.wrap(bytes)
                while (target.hasRemaining()) require(channel.read(target) > 0)
                CatalogRepository.imageMime(bytes)
            }
            val after = Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS)
            require(after.isRegularFile && before.fileKey() == after.fileKey() && before.size() == after.size() && before.lastModifiedTime() == after.lastModifiedTime())
            channel.position(0)
            // Delivery uses the very same handle whose bytes were verified, even across atomic replacement.
            return mime to object : java.io.FilterInputStream(Channels.newInputStream(channel)) {
                private var remaining = count
                override fun read(): Int { if (remaining == 0L) return -1; val value = super.read(); require(value >= 0); remaining--; return value }
                override fun read(bytes: ByteArray, offset: Int, length: Int): Int { if (length == 0) return 0; if (remaining == 0L) return -1; val n = super.read(bytes, offset, minOf(length.toLong(), remaining).toInt()); require(n > 0); remaining -= n; return n }
                override fun skip(n: Long): Long { val skipped = super.skip(n.coerceIn(0, remaining)); remaining -= skipped; return skipped }
                override fun markSupported() = false
            }
        } catch (error: Throwable) { channel.close(); throw error }
    }
}
