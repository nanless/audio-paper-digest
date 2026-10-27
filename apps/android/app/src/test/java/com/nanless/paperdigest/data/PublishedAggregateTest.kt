package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Small controlled fixtures run in ordinary CI without a website download or SDK device. */
class PublishedAggregateTest {
    private val kinds = listOf("daily", "conference", "page")
    private val rows = JSONArray(kinds.map { kind -> JSONObject().put("pageType", kind).put("permalink", "/audio-paper-digest-blog/ci-$kind/").put("title", "受控${kind}页面").put("date", "0001-01-01").put("citation", JSONObject().put("complete", false)).put("futurePublisherField", JSONObject().put("preserve", true)) })
    private val shard = rows.toString().toByteArray()
    private val hash = PublishedAggregateReader.sha(shard)
    private val manifest = JSONObject().put("contract", "paper-search-index-manifest-v1").put("recordCount", 3).put("totalBytes", shard.size).put("shards", JSONArray().put(JSONObject().put("url", "search-index/part-0001-${hash.take(12)}.json").put("bytes", shard.size).put("sha256", hash).put("recordCount", 3))).toString().toByteArray()
    private val epoch = "00000000-0000-0000-0000-000000000001"
    private fun catalog() = PublishedAggregateReader.read(manifest) { shard }
    private fun fixture(body: (File, PublishedAggregateStore) -> Unit) {
        val directory = Files.createTempDirectory("aggregate-ci-").toFile().canonicalFile
        try { File(directory, "index/$hash.json").apply { parentFile.mkdirs(); writeBytes(shard) }; body(directory, PublishedAggregateStore(directory)) }
        finally { directory.deleteRecursively() }
    }
    @Test fun threeExplicitKindsPreserveUnknownDates() {
        val c = catalog(); assertEquals(3, c.records.size); assertEquals(kinds.toSet(), c.records.map { it.kind }.toSet()); assertTrue(c.records.all { it.displayDate == null })
    }
    @Test fun metadataDoesNotGrantPaperCapabilities() {
        val dto = catalog().records.first().json(); for (key in listOf("pdfURL", "authors", "arxivId", "citation", "sourceVersion")) assertFalse(dto.has(key))
    }
    @Test fun changedShardCannotBorrowDescriptor() {
        val changedShard = shard.toString(Charsets.UTF_8).replace("受控", "授控").toByteArray()
        assertEquals(shard.size, changedShard.size); assertNotEquals(hash, PublishedAggregateReader.sha(changedShard)); assertEquals(rows.length(), JSONArray(PublishedUtf8.decode(changedShard)).length())
        assertTrue(runCatching { PublishedAggregateReader.read(manifest) { changedShard } }.isFailure)
    }
    @Test fun sameManifestRequiresExactCurrentValidationEpoch() = fixture { _, store ->
        val c = store.stage(manifest, epoch); assertNull(store.load(c.snapshotSHA256, null)); assertNull(store.load(c.snapshotSHA256, "00000000-0000-0000-0000-000000000002")); assertEquals(c, store.load(c.snapshotSHA256, epoch))
    }
    @Test fun originalPublisherFieldsRetainRowWitness() = fixture { _, store ->
        val descriptor = store.stage(manifest, epoch).records.first(); val raw = store.originalRow(descriptor); assertTrue(JSONObject(PublishedUtf8.decode(raw)).has("futurePublisherField")); assertEquals(descriptor.source.normalizedRowSHA256, PublishedAggregateReader.sha(raw))
    }
    @Test fun threeBodySelectorsColdReplayContentWithoutExecutableOrOfflineClaims() = fixture { directory, store ->
        for (descriptor in store.stage(manifest, epoch).records) {
            val attributes = if (descriptor.kind == "page") "class='reader-guide-content post-content'" else "id='article-body' class='post-content'"
            val html = "<html><body><div $attributes><h2 id='anchor'>正文</h2><table><tr><td>7.5</td></tr></table><math><mi>x</mi></math><img src='https://example.org/image.png' onerror='bad()'><script>bad()</script><p onclick='bad()'>说明</p></div></body></html>".toByteArray()
            val doc = store.cacheDocument(html, descriptor, descriptor.sourceURL, "2026-10-27T00:00:00Z"); val cold = PublishedAggregateStore(directory).cachedDocument(descriptor, doc.getString("rawHTMLSHA256")); assertEquals(canonical(doc), canonical(cold))
            val body = doc.getString("bodyHTML"); for (token in listOf("<table", "<math", "anchor")) assertTrue(body.contains(token)); for (token in listOf("script", "onclick", "src=")) assertFalse(body.contains(token)); assertEquals(1, doc.getJSONArray("resources").length()); assertFalse(doc.getBoolean("completeOffline"))
        }
    }
    // Exact UTF8 source vector is shared byte-for-byte with the Mac normal test.
    private val legacyVector = """[{"pageType":"paper","permalink":"/audio-paper-digest-blog/ci-alias-paper/","title":"Existing paper"},{"pageType":"daily-summary","permalink":"/audio-paper-digest-blog/ci-alias-daily/","title":"Legacy summary","identityStatus":"verified","pdfURL":"https://arxiv.org/pdf/2501.00001","paperId":"arxiv:2501.00001","citation":{"pdfUrl":"https://arxiv.org/pdf/2501.00001"},"futurePublisherField":{"preserve":true}}]"""
    private fun legacyRead(value:String):PublishedAggregateCatalog {
        val bytes=value.toByteArray();val hash=PublishedAggregateReader.sha(bytes)
        val witness=JSONObject().put("contract","paper-search-index-manifest-v1").put("recordCount",2).put("totalBytes",bytes.size).put("shards",JSONArray().put(JSONObject().put("url","search-index/part-0001-${hash.take(12)}.json").put("bytes",bytes.size).put("sha256",hash).put("recordCount",2))).toString().toByteArray()
        return PublishedAggregateReader.read(witness){bytes}
    }
    @Test fun explicitLegacyDailyAliasPreservesRawWitnessUnknownDateAndNoPaperPowers() {
        val c=legacyRead(legacyVector);assertEquals(2,c.sourceRecordCount);assertEquals(1,c.records.size);val dto=c.records.single();val raw=JSONArray(legacyVector).getJSONObject(1)
        assertEquals("daily",dto.kind);assertEquals("",dto.rawDate);assertNull(dto.displayDate);assertNull(dto.conferenceScope);assertEquals(1,dto.source.rowIndex);assertEquals(PublishedAggregateReader.sha(PublishedAggregateReader.normalizedRow(raw)),dto.source.normalizedRowSHA256);assertEquals("daily-summary",raw.getString("pageType"));for(key in listOf("pdfURL","paperId","citation","identityStatus"))assertFalse(dto.json().has(key))
    }
    @Test fun scanKindsAndUnknownTypesStillRejectWithTheirOwnValidWitness() {
        for(kind in listOf("conference-summary","conference-task","future-summary","DAILY-SUMMARY","daily-summary "))assertTrue(runCatching{legacyRead(legacyVector.replace("daily-summary",kind))}.isFailure)
    }

}
