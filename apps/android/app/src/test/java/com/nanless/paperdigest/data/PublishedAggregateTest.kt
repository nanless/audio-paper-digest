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
    @Test fun activationKeepsOriginalHeaderOnColdReplayAndRestage() = fixture { directory, store ->
        val catalog=store.stage(manifest,epoch)
        val marker=File(directory,"aggregate-activations/${catalog.snapshotSHA256}/$epoch.json")
        val record=JSONObject(marker.readText())
        val family="published-aggregate-activation"
        val protocols=com.nanless.paperdigest.protocols.ClientProtocols
        assertTrue(protocols.isCurrentHeader(record,family))
        val sidecar=File(directory,"aggregate-index/${catalog.snapshotSHA256}.json")
        val sidecarRecord=JSONObject(sidecar.readText())
        assertTrue(protocols.isCurrentHeader(sidecarRecord,"published-aggregate-index"))
        sidecarRecord.remove("schemaFingerprint")
        val historicalSidecar=sidecarRecord.put("contract","published-aggregate-index-v1").toString().toByteArray()
        sidecar.writeBytes(historicalSidecar)
        record.put("catalogSHA256",PublishedAggregateReader.sha(historicalSidecar))
        record.remove("schemaFingerprint")
        record.put("contract","published-aggregate-activation-v1")
        val historical=record.toString().toByteArray()
        marker.writeBytes(historical)
        val cold=PublishedAggregateStore(directory)
        assertEquals(catalog,cold.load(catalog.snapshotSHA256,epoch))
        assertEquals(catalog,cold.stage(manifest,epoch))
        assertTrue(marker.readBytes().contentEquals(historical))
        assertTrue(sidecar.readBytes().contentEquals(historicalSidecar))
        marker.writeText(record.put("schemaFingerprint",protocols.schemaFingerprint(family)).toString())
        assertTrue(runCatching{cold.load(catalog.snapshotSHA256,epoch)}.isFailure)
    }
    @Test fun actualDocumentParserProfileControlsColdReplay() = fixture { directory, store ->
        val descriptor=store.stage(manifest,epoch).records.first{it.kind=="daily"}
        val html="<html><body><div id='article-body' class='post-content'><p>Original body</p></div></body></html>".toByteArray()
        val record=store.cacheDocument(html,descriptor,descriptor.sourceURL,"2026-10-27T00:00:00Z")
        val sha=record.getString("rawHTMLSHA256")
        val path=File(directory,"aggregate-documents-android/${PublishedAggregateReader.sha(descriptor.id.toByteArray())}/${descriptor.source.manifestSHA256}/$sha/document.json")
        assertTrue(com.nanless.paperdigest.protocols.ClientProtocols.isCurrentHeader(record,"published-aggregate-document"))
        record.remove("schemaFingerprint")
        record.put("contract","published-aggregate-document-v1").put("parserContract","published-aggregate-jsoup-v1")
        val historical=OfflineFoundationJSON.encode(record)
        path.writeBytes(historical)
        val cold=PublishedAggregateStore(directory)
        assertEquals("published-aggregate-jsoup-v1",cold.cachedDocument(descriptor,sha).getString("parserContract"))
        assertTrue(path.readBytes().contentEquals(historical))
        path.writeBytes(OfflineFoundationJSON.encode(record.put("parserContract","published-aggregate-html-v1")))
        assertTrue(runCatching{cold.cachedDocument(descriptor,sha)}.isFailure)
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

    @Test fun crossPlatformDesktopAggregateStoreSupportsPureBaseLegacyMergedAndMacRestoredCanonicalPages() {
        val dir = Files.createTempDirectory("aggregate-xplat-").toFile().canonicalFile
        try {
            val rows = JSONArray()
                .put(JSONObject().put("pageType", "paper").put("appearanceId", "posts/2026-11-26-p1/").put("pageUrl", "posts/2026-11-26-p1/").put("paperId", "arxiv:2611.00001").put("identityStatus", "verified").put("title", "Paper 1"))
                .put(JSONObject().put("pageType", "daily").put("appearanceId", "posts/2026-11-26-daily/").put("pageUrl", "posts/2026-11-26-daily/").put("identityStatus", "aggregate-page").put("paperId", JSONObject.NULL).put("title", "Daily 26").put("titleZh", "11-26 日报").put("summary", "日报").put("blogPublishedAt", "2026-11-26").put("tagConceptIds", JSONArray().put("task.asr")))
                .put(JSONObject().put("pageType", "conference").put("appearanceId", "posts/interspeech2026-summary/").put("pageUrl", "posts/interspeech2026-summary/").put("identityStatus", "aggregate-page").put("paperId", JSONObject.NULL).put("title", "Interspeech 2026").put("titleZh", "Interspeech 2026 汇总").put("summary", "会议").put("blogPublishedAt", "2026-11-26").put("tagConceptIds", JSONArray()))
            val shardBytes = OfflineFoundationJSON.encode(rows)
            val shardSHA = PublishedAggregateReader.sha(shardBytes)
            val shardURL = "client/details/catalog/$shardSHA.json"
            val manifestObj = com.nanless.paperdigest.protocols.ClientProtocols.record("paper-desktop-snapshot")
                .put("recordCount", 3).put("paperCount", 1).put("appearanceCount", 3)
                .put("catalogShards", JSONArray().put(JSONObject().put("url", shardURL).put("sha256", shardSHA).put("bytes", shardBytes.size).put("recordCount", 3)))
            val manifestBytes = OfflineFoundationJSON.encode(manifestObj)
            val snapSHA = PublishedAggregateReader.sha(manifestBytes)
            val ep1 = "00000000-0000-0000-0000-000000000101"
            val ep2 = "00000000-0000-0000-0000-000000000102"

            // (a) macOS-staged store (pure baseCatalog with conferenceScope omitted on -summary/, NO aggregate-pages-refs) loads on Android with /about/, /conferences/, /links/ intact AND re-sync creates refFile cleanly!
            val macDir = File(dir, "from-macos").apply { mkdirs() }
            File(macDir, "desktop-details/catalog/$shardSHA.json").apply { parentFile.mkdirs(); writeBytes(shardBytes) }
            File(macDir, "aggregate-manifests/$snapSHA.json").apply { parentFile.mkdirs(); writeBytes(manifestBytes) }
            val androidBase = PublishedAggregateReader.read(manifestBytes) { shardBytes }
            val macBase = PublishedAggregateCatalog(snapSHA, androidBase.sourceRecordCount, androidBase.records.map { if (it.kind == "conference") it.copy(conferenceScope = null) else it })
            val macSidecarBytes = OfflineFoundationJSON.encode(com.nanless.paperdigest.protocols.ClientProtocols.record("published-aggregate-index", macBase.json()))
            File(macDir, "aggregate-index/$snapSHA.json").apply { parentFile.mkdirs(); writeBytes(macSidecarBytes) }
            val macAct = OfflineFoundationJSON.encode(com.nanless.paperdigest.protocols.ClientProtocols.record("published-aggregate-activation").put("snapshotSHA256", snapSHA).put("validationEpoch", ep1).put("catalogSHA256", PublishedAggregateReader.sha(macSidecarBytes)))
            File(macDir, "aggregate-activations/$snapSHA/$ep1.json").apply { parentFile.mkdirs(); writeBytes(macAct) }

            val androidStoreOnMac = PublishedAggregateStore(macDir)
            val loadedFromMac = requireNotNull(androidStoreOnMac.load(snapSHA, ep1))
            assertEquals(5, loadedFromMac.records.size)
            val macPages = loadedFromMac.records.filter { it.kind == "page" }
            assertEquals(
                setOf(
                    "https://nanless.github.io/audio-research-portal/about/",
                    "https://nanless.github.io/audio-research-portal/conferences/",
                    "https://nanless.github.io/audio-research-portal/links/",
                ),
                macPages.map { it.sourceURL }.toSet(),
            )
            macPages.forEach { p -> assertEquals(p.source.normalizedRowSHA256, PublishedAggregateReader.sha(androidStoreOnMac.originalRow(p))) }

            // Re-syncing on Android with supplementalPages now creates aggregate-pages-refs without conflicting with macOS's pure sidecar!
            val suppPages = listOf(
                JSONObject().put("pageType", "page").put("permalink", "/audio-research-portal/about/").put("title", "About Portal").put("titleZh", "关于本站").put("summary", "来自索引的真实简介").put("date", ""),
                JSONObject().put("pageType", "page").put("permalink", "/audio-research-portal/conferences/").put("title", "Conferences").put("titleZh", "会议论文集").put("summary", "目录").put("date", ""),
                JSONObject().put("pageType", "page").put("permalink", "/audio-research-portal/links/").put("title", "Links").put("titleZh", "研究资源").put("summary", "资源").put("date", ""),
            )
            val resynced = androidStoreOnMac.stage(manifestBytes, ep2, suppPages)
            assertTrue(File(macDir, "aggregate-pages-refs/$snapSHA.json").isFile)
            assertTrue(File(macDir, "aggregate-index/$snapSHA.json").readBytes().contentEquals(macSidecarBytes))
            assertEquals("来自索引的真实简介", resynced.records.first { it.sourceURL.endsWith("/about/") }.summary)

            // (b) Legacy Android v1.5.1 merged aggregate-index + aggregate-pages-refs loads & re-stages cleanly, while tampered aggregate-index fails closed
            val legacyDir = File(dir, "legacy-android").apply { mkdirs() }
            File(legacyDir, "desktop-details/catalog/$shardSHA.json").apply { parentFile.mkdirs(); writeBytes(shardBytes) }
            File(legacyDir, "aggregate-manifests/$snapSHA.json").apply { parentFile.mkdirs(); writeBytes(manifestBytes) }
            val pageBytes = OfflineFoundationJSON.encode(JSONArray(suppPages))
            val pageSHA = PublishedAggregateReader.sha(pageBytes)
            val pageURL = "client/details/pages/$pageSHA.json"
            File(legacyDir, "aggregate-pages/$pageSHA.json").apply { parentFile.mkdirs(); writeBytes(pageBytes) }
            val refBytes = OfflineFoundationJSON.encode(JSONObject().put("snapshotSHA256", snapSHA).put("shardURL", pageURL).put("shardSHA256", pageSHA).put("shardBytes", pageBytes.size).put("recordCount", suppPages.size))
            File(legacyDir, "aggregate-pages-refs/$snapSHA.json").apply { parentFile.mkdirs(); writeBytes(refBytes) }
            val extra = PublishedAggregateReader.readSupplementalPages(snapSHA, pageURL, pageSHA, pageBytes.size, pageBytes, androidBase.records.mapTo(HashSet()) { it.id })
            val legacyMerged = PublishedAggregateCatalog(snapSHA, androidBase.sourceRecordCount, (androidBase.records + extra).sortedBy { it.id })
            val legacySidecar = OfflineFoundationJSON.encode(com.nanless.paperdigest.protocols.ClientProtocols.record("published-aggregate-index", legacyMerged.json()))
            File(legacyDir, "aggregate-index/$snapSHA.json").apply { parentFile.mkdirs(); writeBytes(legacySidecar) }
            val legacyAct = OfflineFoundationJSON.encode(com.nanless.paperdigest.protocols.ClientProtocols.record("published-aggregate-activation").put("snapshotSHA256", snapSHA).put("validationEpoch", ep1).put("catalogSHA256", PublishedAggregateReader.sha(legacySidecar)))
            File(legacyDir, "aggregate-activations/$snapSHA/$ep1.json").apply { parentFile.mkdirs(); writeBytes(legacyAct) }

            val legacyStore = PublishedAggregateStore(legacyDir)
            assertEquals(5, requireNotNull(legacyStore.load(snapSHA, ep1)).records.size)
            assertEquals(5, legacyStore.stage(manifestBytes, ep2, suppPages).records.size)
            assertTrue(File(legacyDir, "aggregate-index/$snapSHA.json").readBytes().contentEquals(legacySidecar))

            // Tampered legacy sidecar fails closed
            val tamperedJson = JSONObject(PublishedUtf8.decode(legacySidecar))
            tamperedJson.getJSONArray("records").getJSONObject(0).put("title", "Tampered")
            val tamperedBytes = OfflineFoundationJSON.encode(tamperedJson)
            File(legacyDir, "aggregate-index/$snapSHA.json").writeBytes(tamperedBytes)
            val tamperedAct = OfflineFoundationJSON.encode(com.nanless.paperdigest.protocols.ClientProtocols.record("published-aggregate-activation").put("snapshotSHA256", snapSHA).put("validationEpoch", ep1).put("catalogSHA256", PublishedAggregateReader.sha(tamperedBytes)))
            File(legacyDir, "aggregate-activations/$snapSHA/$ep1.json").writeBytes(tamperedAct)
            assertTrue(runCatching { legacyStore.load(snapSHA, ep1) }.isFailure)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun aggregateHtmlPreservesSemanticTagsListNumberingAndTableAlignmentWhileStrippingUnsafeMarkup() = fixture { _, store ->
        val descriptor = store.stage(manifest, epoch).records.first { it.kind == "daily" }
        val raw = """
            <html><body><div id="article-body" class="post-content">
                <p><del>旧条目</del> <ins>新增</ins> <small>说明</small> <kbd>Esc</kbd> <abbr title="Text to Speech">TTS</abbr> <cite>Interspeech 2026</cite></p>
                <ol start="4"><li value="9">第九项</li><li value="evil">非法值</li></ol>
                <ol start="1;2"><li value="2">次项</li></ol>
                <table><thead><tr><th style="text-align: center; color: red">列A</th><th style="text-align: right">列B</th></tr></thead>
                <tbody><tr><td style="text-align: left">值1</td><td style="background: url(https://evil.example/x.png)">值2</td></tr></tbody></table>
                <script>evil()</script><p onclick="evil()">正文</p>
            </div></body></html>
        """.trimIndent().toByteArray(Charsets.UTF_8)
        val doc = AggregateHtml.parse(raw, descriptor, descriptor.sourceURL, "2026-11-26T00:00:00Z")
        val body = doc.getString("bodyHTML")
        for (token in listOf("<del>旧条目</del>", "<ins>新增</ins>", "<small>说明</small>", "<kbd>Esc</kbd>", "<abbr title=\"Text to Speech\">TTS</abbr>", "<cite>Interspeech 2026</cite>", "<ol start=\"4\">", "<li value=\"9\">", "class=\"ta-center\"", "class=\"ta-right\"", "class=\"ta-left\"")) {
            assertTrue("Expected $token in $body", body.contains(token))
        }
        for (forbidden in listOf("<script", "onclick", "style=", "evil.example", "value=\"evil\"", "start=\"1;2\"")) {
            assertFalse("Forbidden $forbidden in $body", body.contains(forbidden))
        }
    }

}
