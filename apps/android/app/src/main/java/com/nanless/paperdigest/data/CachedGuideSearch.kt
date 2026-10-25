package com.nanless.paperdigest.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStreamReader
import java.io.Reader
import java.nio.charset.CodingErrorAction
import java.nio.file.Files

/** Search saved guide text without loading its potentially large inline images into memory. */
class CachedGuideSearch(private val directory: File) {
    suspend fun search(query: String, papers: List<Paper>): JSONObject = withContext(Dispatchers.IO) {
        require(query.length <= 256) { "搜索词过长，请使用不超过 256 个字符的关键词" }
        val text = query.trim()
        val matches = linkedSetOf<String>()
        var scanned = 0; var unavailable = 0
        if (text.isNotEmpty() && directory.exists()) {
            require(directory.isDirectory && !Files.isSymbolicLink(directory.toPath())) { "已保存导读目录不可用" }
            val byID = papers.associateBy { it.id }
            val operation = currentCoroutineContext()
            val files = directory.listFiles() ?: throw AppFailure("storage", "无法读取已保存导读，搜索未完成")
            for (file in files.sortedBy { it.name }) {
                operation.ensureActive()
                if (!file.name.endsWith(".json")) continue
                try {
                    require(file.isFile && !Files.isSymbolicLink(file.toPath()) && file.length() in 1..MAX_BYTES)
                    val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    val record = file.inputStream().use { input -> InputStreamReader(input, decoder).buffered(32 * 1024).use { reader ->
                        Scanner(reader, text) { operation.ensureActive() }.read()
                    } }
                    val paper = byID[record.paperID] ?: error("旧导读没有对应论文")
                    require(record.blogURL == paper.blogURL && file.name == sha256(record.blogURL.toByteArray(Charsets.UTF_8)) + ".json")
                    require(record.revision.matches(Regex("[a-f0-9]{64}")))
                    scanned++
                    if (record.matched) matches += paper.id
                } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
                catch (_: Exception) { operation.ensureActive(); unavailable++ }
            }
        }
        JSONObject().put("query", query).put("paperIDs", JSONArray(matches.sorted())).put("scannedArticles", scanned)
            .put("unavailableArticles", unavailable).put("scope", "cached-published-guides")
    }

    private data class Record(val paperID: String, val blogURL: String, val revision: String, val matched: Boolean)

    /** Strict, bounded streaming JSON reader. Unselected strings are never materialized. */
    private class Scanner(private val reader: Reader, private val query: String, private val check: () -> Unit) {
        private var next = reader.read()
        private var consumed = 0L
        private var values = 0
        private var paperID: String? = null
        private var blogURL: String? = null
        private var revision: String? = null
        private var hasText = false
        private var matched = false

        fun read(): Record {
            whitespace(); require(next == '{'.code); value(0); whitespace(); require(next == -1)
            require(hasText && paperID != null && blogURL != null && revision != null)
            return Record(paperID!!, blogURL!!, revision!!, matched)
        }
        private fun advance() {
            consumed++; require(consumed <= MAX_BYTES)
            if (consumed % 4096 == 0L) check()
            next = reader.read()
        }
        private fun whitespace() { while (next in listOf(32, 9, 10, 13)) advance() }
        private fun expect(character: Char) { require(next == character.code); advance() }
        private fun value(depth: Int) {
            require(depth <= 64 && ++values <= 100000)
            whitespace()
            when (next) {
                '{'.code -> {
                    advance(); whitespace(); val keys = HashSet<String>()
                    if (next != '}'.code) while (true) {
                        val key = string(256); require(keys.size < 4096 && keys.add(key)); whitespace(); expect(':'); whitespace()
                        if (depth == 0) when (key) {
                            "paperID" -> paperID = string(2048)
                            "blogURL" -> blogURL = string(8192)
                            "revisionSHA256" -> revision = string(64)
                            "plainText" -> {
                                hasText = true
                                val window = StringBuilder(query.length)
                                stringValue { char ->
                                    if (!matched) {
                                        window.append(char)
                                        if (window.length > query.length) window.deleteCharAt(0)
                                        if (window.length == query.length && window[0].equals(query[0], ignoreCase = true) && window[window.lastIndex].equals(query.last(), ignoreCase = true) && window.toString().equals(query, ignoreCase = true)) matched = true
                                    }
                                }
                            }
                            else -> value(depth + 1)
                        } else value(depth + 1)
                        whitespace(); if (next != ','.code) break
                        advance(); whitespace()
                    }
                    expect('}')
                }
                '['.code -> {
                    advance(); whitespace()
                    if (next != ']'.code) while (true) { value(depth + 1); whitespace(); if (next != ','.code) break; advance(); whitespace() }
                    expect(']')
                }
                '"'.code -> stringValue {}
                't'.code -> literal("true")
                'f'.code -> literal("false")
                'n'.code -> literal("null")
                else -> number()
            }
        }
        private fun string(limit: Int): String {
            val result = StringBuilder()
            stringValue { require(result.length < limit); result.append(it) }
            return result.toString()
        }
        private inline fun stringValue(consume: (Char) -> Unit) {
            expect('"')
            while (next != '"'.code) {
                require(next >= 32)
                if (next == '\\'.code) {
                    advance()
                    val character = when (next) {
                        '"'.code -> '"'; '\\'.code -> '\\'; '/'.code -> '/'
                        'b'.code -> '\b'; 'f'.code -> '\u000c'; 'n'.code -> '\n'; 'r'.code -> '\r'; 't'.code -> '\t'
                        'u'.code -> {
                            var code = 0
                            repeat(4) { advance(); val digit = Character.digit(next.toChar(), 16); require(next >= 0 && digit >= 0); code = code * 16 + digit }
                            code.toChar()
                        }
                        else -> error("非法JSON转义")
                    }
                    consume(character); advance()
                } else { consume(next.toChar()); advance() }
            }
            advance()
        }
        private fun literal(text: String) { text.forEach { expect(it) } }
        private fun number() {
            if (next == '-'.code) advance()
            if (next == '0'.code) advance() else { require(next in '1'.code..'9'.code); while (next in '0'.code..'9'.code) advance() }
            if (next == '.'.code) { advance(); require(next in '0'.code..'9'.code); while (next in '0'.code..'9'.code) advance() }
            if (next == 'e'.code || next == 'E'.code) {
                advance(); if (next == '+'.code || next == '-'.code) advance()
                require(next in '0'.code..'9'.code); while (next in '0'.code..'9'.code) advance()
            }
        }
    }
    companion object { private const val MAX_BYTES = 128L * 1024 * 1024 }
}
