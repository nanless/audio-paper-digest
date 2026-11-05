package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.nodes.TextNode
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Store-level derivation reuse: one DOM build per sealed source, but never one skipped source check. */
class AggregateDerivationTest {
    private val roots=mutableListOf<File>()
    private class Fixture(val root:File,val store:PublishedAggregateStore,val descriptor:PublishedAggregate,val raw:ByteArray,val document:JSONObject) {
        val rawHTMLSHA256:String get()=document.getString("rawHTMLSHA256")
    }
    private fun fixture(markup:String):Fixture {
        val root=Files.createTempDirectory("aggregate-derivation-").toFile().canonicalFile;roots+=root
        val rows=JSONArray().put(JSONObject().put("pageType","daily").put("permalink","/audio-paper-digest-blog/derivation-${UUID.randomUUID()}/").put("title","Derivation cache page").put("date","2026-11-05"))
        val shard=OfflineFoundationJSON.encode(rows);val shardSHA=PublishedAggregateReader.sha(shard)
        File(root,"index").mkdirs();File(root,"index/$shardSHA.json").writeBytes(shard)
        val manifest=OfflineFoundationJSON.encode(JSONObject().put("contract","paper-search-index-manifest-v1").put("recordCount",1).put("totalBytes",shard.size).put("shards",JSONArray().put(JSONObject().put("url","search-index/part-0001-${shardSHA.take(12)}.json").put("sha256",shardSHA).put("bytes",shard.size).put("recordCount",1))))
        val store=PublishedAggregateStore(root);val descriptor=store.stage(manifest,UUID.randomUUID().toString()).records.single()
        val raw="<html><body><div id='article-body' class='post-content'><p>Before original images</p>$markup<p>After original images</p></div></body></html>".toByteArray()
        val document=store.cacheDocument(raw,descriptor,descriptor.sourceURL,"2026-11-05T00:00:00Z")
        return Fixture(root,store,descriptor,raw,document)
    }
    private fun documentFolder(f:Fixture)=File(f.root,"aggregate-documents-android/${PublishedAggregateReader.sha(f.descriptor.id.toByteArray())}/${f.descriptor.source.manifestSHA256}/${f.rawHTMLSHA256}")
    private fun originalHTML(f:Fixture)=File(documentFolder(f),"original.html")
    private fun resource(name:String)=requireNotNull(javaClass.classLoader!!.getResourceAsStream(name)).use{it.readBytes()}
    @After fun cleanup(){roots.forEach{it.deleteRecursively()}}

    /** The stored document and the image plan share one derivation, and the direct parser entry point agrees byte for byte. */
    @Test fun oneDerivationFeedsTheDocumentAndTheImagePlan() {
        val f=fixture("<figure><img src='https://arxiv.org/html/2610.00001v1/figure1.png' alt='Original image'/><figcaption>Caption one</figcaption></figure>")
        val document=f.store.cachedDocument(f.descriptor,f.rawHTMLSHA256)
        val plan=f.store.imagePlan(f.descriptor,f.rawHTMLSHA256)
        val fresh=AggregateHtml.parse(f.raw,f.descriptor,f.descriptor.sourceURL,"2026-11-05T00:00:00Z")
        val independent=AggregateHtml.imagePlan(f.raw,f.descriptor,f.descriptor.sourceURL,"2026-11-05T00:00:00Z")
        assertEquals(canonical(fresh),canonical(document))
        assertEquals(canonical(independent.json()),canonical(plan.json()))
        val expected=AggregateImagePlan(f.descriptor,f.rawHTMLSHA256,document.getString("sanitizedBodySHA256"),
            listOf(AggregateImageSlot(0,"https://arxiv.org/html/2610.00001v1/figure1.png","Original image","Caption one")),document.getString("bodyHTML"))
        assertEquals(canonical(expected.json()),canonical(plan.json()))
        assertEquals(document.getString("bodyHTML"),plan.templateBodyHTML)
        assertEquals(document.getString("sanitizedBodySHA256"),plan.originalBodySHA256)
        assertEquals(f.rawHTMLSHA256,plan.rawHTMLSHA256)
        assertFalse(plan.templateBodyHTML.contains(" src="))
    }

    /** A memo hit inside a read scope must still contribute the sealed original bytes to the scope's byte guard. */
    @Test fun memoHitStillRechecksTheSealedOriginalBytesBeforeTheScopeReturns() {
        val f=fixture("<p>Stable derivation</p>")
        val first=f.store.cachedDocument(f.descriptor,f.rawHTMLSHA256)
        val original=originalHTML(f);val bytes=original.readBytes()
        val cold=PublishedAggregateStore(f.root)
        cold.withSourceReadScope{assertEquals(canonical(first),canonical(cold.cachedDocument(f.descriptor,f.rawHTMLSHA256)))}
        val error=runCatching{cold.withSourceReadScope {
            cold.cachedDocument(f.descriptor,f.rawHTMLSHA256)
            original.writeBytes(bytes+byteArrayOf(32))
        }}.exceptionOrNull()
        assertTrue(error is IllegalArgumentException&&error.message=="读取期间汇总原来源字节变化")
        original.writeBytes(bytes)
        assertEquals(canonical(first),canonical(PublishedAggregateStore(f.root).cachedDocument(f.descriptor,f.rawHTMLSHA256)))
    }

    /** Neither the source row, the saved document nor the saved body may be skipped just because the DOM is memoized. */
    @Test fun memoHitStillRechecksTheSourceRowAndBothSavedFiles() {
        val f=fixture("<p>Stable derivation</p>")
        f.store.cachedDocument(f.descriptor,f.rawHTMLSHA256)
        val folder=documentFolder(f);val bodyFile=File(folder,"body.html");val body=bodyFile.readBytes()
        try {
            bodyFile.writeBytes(body+byteArrayOf(32))
            assertTrue(runCatching{PublishedAggregateStore(f.root).cachedDocument(f.descriptor,f.rawHTMLSHA256)}.isFailure)
        } finally { bodyFile.writeBytes(body) }
        val savedFile=File(folder,"document.json");val saved=savedFile.readBytes()
        try {
            val changed=String(saved,Charsets.UTF_8).replace("Stable derivation","Tampered derivatio").toByteArray()
            savedFile.writeBytes(changed)
            assertTrue(runCatching{PublishedAggregateStore(f.root).cachedDocument(f.descriptor,f.rawHTMLSHA256)}.isFailure)
        } finally { savedFile.writeBytes(saved) }
        val shardFile=File(f.root,"index/${f.descriptor.source.shardSHA256}.json");val shard=shardFile.readBytes()
        try {
            val changed=shard.copyOf();changed[changed.lastIndex]=(changed.last().toInt() xor 1).toByte();shardFile.writeBytes(changed)
            assertTrue(runCatching{PublishedAggregateStore(f.root).cachedDocument(f.descriptor,f.rawHTMLSHA256)}.isFailure)
        } finally { shardFile.writeBytes(shard) }
        assertNotNull(PublishedAggregateStore(f.root).cachedDocument(f.descriptor,f.rawHTMLSHA256))
    }

    /** The memo is never handed out directly: a caller mutating one result cannot poison later derivations. */
    @Test fun callerMutationCannotPoisonTheMemoizedDocument() {
        val f=fixture("<p>Stable derivation</p>")
        val first=f.store.cachedDocument(f.descriptor,f.rawHTMLSHA256)
        first.put("plainText","forged body text").put("bodyHTML","<p>forged</p>")
        first.put("sanitizedBodySHA256","f".repeat(64))
        val second=PublishedAggregateStore(f.root).cachedDocument(f.descriptor,f.rawHTMLSHA256)
        assertEquals(canonical(f.document),canonical(second))
        assertEquals(f.document.getString("bodyHTML"),second.getString("bodyHTML"))
        assertEquals(f.document.getString("plainText"),second.getString("plainText"))
    }

    /** The old whole-body clone normalization and the read-only traversal must produce exactly the same text. */
    private fun legacyPlainText(body:Element):String {
        val copy=body.clone()
        copy.select(".katex").forEach{if(it.selectFirst("math")!=null)it.select(".katex-html").remove()}
        copy.select("math").toList().forEach{math->
            val tex=math.selectFirst("annotation[encoding=application/x-tex]")?.wholeText()?.takeIf{it.isNotBlank()}
            math.replaceWith(TextNode(if(tex!=null)"[公式 TeX：$tex]" else "[公式 MathML：${math.outerHtml()}]"))
        }
        return copy.wholeText()
    }
    @Test fun plainTextKeepsTheFormerCloneNormalizationExactlyAndDoesNotMutateTheBody() {
        val cases=listOf(
            "<p>Before <span class='katex'><span class='katex-mathml'><math><annotation encoding='application/x-tex'>x^2</annotation></math></span><span class='katex-html' aria-hidden='true'><span class='mord'>x</span><span class='msup'>2</span></span></span> After</p>",
            "<div><math><mi>y</mi></math><span class='katex'><span class='katex-html'>VISUAL</span><span class='katex-mathml'><math><annotation encoding='application/x-tex'>\\frac{a}{b}</annotation></math></span></span></div>",
            "<p><span class='katex'><span class='katex-html'>NO MATH HERE</span></span><math><annotation encoding='application/x-tex'> </annotation><mi>z</mi></math></p>",
            "<div><span class='katex'><span class='katex-html'><math><mi>nested</mi></math></span></span>tail</div>",
            "<p>plain <em>text</em> with <span class='katex'><span class='katex-html'>a</span><math><annotation encoding='application/x-tex'>q</annotation></math><span class='katex-html'>b</span></span> end</p>",
            "<blockquote>inline <code>a &amp;&amp; b</code> no math</blockquote>",
            "<p>line one<br>line two</p>",
            "<div>a<br><br>b<span>c</span><br>d</div>",
            "<p><span class='katex'><span class='katex-html'><br></span><math><annotation encoding='application/x-tex'>t</annotation></math></span>tail<br>end</p>"
        )
        for(html in cases){
            val body=Jsoup.parseBodyFragment(html).body();val before=body.html()
            assertEquals(html,legacyPlainText(body),AggregateHtml.plainText(body))
            assertEquals(html,before,body.html())
        }
    }

    private fun contentCanonicalSHA(value:JSONObject):String {
        val copy=JSONObject(value.toString());copy.remove("contract");copy.remove("schemaFingerprint");copy.remove("parserContract")
        return PublishedAggregateReader.sha(canonical(copy).toByteArray())
    }
    /** Golden bytes recorded from the pre-optimization implementation on a real sealed published source. */
    @Test fun realPublishedSourceKeepsPreOptimizationBodyTextAndPlanBytes() {
        val root=Files.createTempDirectory("aggregate-derivation-real-").toFile().canonicalFile;roots+=root
        val shard=resource("aggregate-daily24-links-rows.json");val rows=JSONArray(PublishedUtf8.decode(shard));val shardSHA=PublishedAggregateReader.sha(shard)
        val manifest=JSONObject().put("contract","paper-search-index-manifest-v1").put("recordCount",rows.length()).put("totalBytes",shard.size).put("shards",JSONArray().put(JSONObject().put("url","search-index/part-0001-${shardSHA.take(12)}.json").put("sha256",shardSHA).put("bytes",shard.size).put("recordCount",rows.length()))).toString().toByteArray()
        File(root,"index").mkdirs();File(root,"index/$shardSHA.json").writeBytes(shard)
        val store=PublishedAggregateStore(root);val descriptor=store.stage(manifest,UUID.randomUUID().toString()).records.single()
        val raw=resource("aggregate-daily24-links-original.html");require(PublishedAggregateReader.sha(raw)=="c51f3797c5e9036ddb5afef60fab0463c6a2ab48991980639f557d915fe9ab1a")
        val document=store.cacheDocument(raw,descriptor,descriptor.sourceURL,"2026-10-24T00:00:00Z")
        val plan=store.imagePlan(descriptor,document.getString("rawHTMLSHA256"))
        assertEquals("17d9a73490e4c1655d473d68e96f7914d3c5273c9f1909c9efcb0073eb0032bf",document.getString("sanitizedBodySHA256"))
        assertEquals("45d890440dc528a0997eb275a87af9a701aae2a390eb7bdc2da92a4915c15960",PublishedAggregateReader.sha(document.getString("plainText").toByteArray()))
        assertEquals("0336cbbdd55167a72ec5695df24fafcf4dbd41858327427b4cf6e6d639432ba3",contentCanonicalSHA(document))
        assertEquals("3b5328d1ce794d9c2f651e078e4305fe639f20c0d3e2c4fc46cf79a7f83886d4",contentCanonicalSHA(plan.json()))
        assertEquals(document.getString("bodyHTML"),plan.templateBodyHTML)
        assertEquals(document.getString("sanitizedBodySHA256"),plan.originalBodySHA256)
        assertEquals(listOf(AggregateImageSlot(0,"https://arxiv.org/html/2610.30682v1/Figure1.png","原论文配图（完整图注与解读见独立文章）","")),plan.slots)
    }
}
