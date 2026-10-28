package com.nanless.paperdigest.data

import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.After
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Real published bytes and native Store; controlled ports exercise ownership, never a provider. */
class AggregateLinksTest {
    private val roots=mutableListOf<File>()
    private val site=CatalogRepository.SITE
    private data class Fixture(val root:File,val store:PublishedAggregateStore,val catalog:PublishedAggregateCatalog,val document:AggregateDocumentView,val paper:Paper)
    private fun bytes(name:String)=requireNotNull(javaClass.classLoader!!.getResourceAsStream(name)).use{it.readBytes()}
    private fun fixture():Fixture {
        val root=Files.createTempDirectory("aggregate-links81-").toFile().canonicalFile;roots+=root
        val shard=bytes("aggregate-daily24-links-rows.json");val rows=JSONArray(PublishedUtf8.decode(shard));val sha=sha256(shard)
        val manifest=JSONObject().put("contract","paper-search-index-manifest-v1").put("recordCount",rows.length()).put("totalBytes",shard.size).put("shards",JSONArray().put(JSONObject().put("url","search-index/part-0001-${sha.take(12)}.json").put("sha256",sha).put("bytes",shard.size).put("recordCount",rows.length()))).toString().toByteArray()
        val snapshot=sha256(manifest);File(root,"index/$sha.json").apply{parentFile.mkdirs();writeBytes(shard)};File(root,"index-manifests/$snapshot.json").apply{parentFile.mkdirs();writeBytes(manifest)}
        val store=PublishedAggregateStore(root);val catalog=store.stage(manifest,UUID.randomUUID().toString());val descriptor=catalog.records.single()
        val raw=bytes("aggregate-daily24-links-original.html");require(sha256(raw)=="c51f3797c5e9036ddb5afef60fab0463c6a2ab48991980639f557d915fe9ab1a")
        val document=AggregateDocumentView.verified(store.cacheDocument(raw,descriptor,descriptor.sourceURL,"2026-10-24T00:00:00Z"),descriptor,true)
        val paper=requireNotNull(CatalogRepository.parsePaper(rows.getJSONObject(0))).copy(original=JSONObject().put("publishedSnapshotID",snapshot))
        return Fixture(root,store,catalog,document,paper)
    }
    private suspend fun resolve(f:Fixture,href:String,papers:List<Paper> = listOf(f.paper),valid:suspend(Paper)->Boolean={p->val w=PublishedRecordArchive(f.root).read(p);w.optString("status")=="verified-local-originals"&&w.optString("snapshotID")==f.catalog.snapshotSHA256},current:()->Boolean={true})=
        AggregateLinkRouting.resolve(f.document,href,f.catalog,papers,valid,current)
    @After fun cleanup(){roots.forEach{it.deleteRecursively()}}
    @Test fun actualDailyLinksOneAndThreeOpenWitnessedPaperAndKeepOriginalBytes()=runBlocking {
        val f=fixture();val before=canonical(f.store.cachedDocument(f.document.descriptor,f.document.rawHTMLSHA256));val table=AggregateLinkTable.derive(f.document)
        for(index in listOf(1,3)){val href=requireNotNull(table.href(index));assertTrue(href.endsWith("2610-30682"));val result=resolve(f,href) as AggregateLinkDestination.PublishedPaper;assertEquals("arxiv:2610.30682",result.paper.id)}
        assertEquals(before,canonical(f.store.cachedDocument(f.document.descriptor,f.document.rawHTMLSHA256)))
        assertTrue(Jsoup.parseBodyFragment(table.html).select("a[href]").all{it.attr("href").startsWith("https://reader.invalid/aggregate-link/${table.nonce}/")})
        val original=Jsoup.parseBodyFragment(f.document.bodyHTML);val displayed=Jsoup.parseBodyFragment(table.html)
        assertEquals(original.text(),displayed.text());original.select("a").forEach{it.removeAttr("href");it.removeAttr("target")};displayed.select("a").forEach{it.removeAttr("href");it.removeAttr("target")};for(tag in listOf("img","math","figure","figcaption","table"))assertEquals(original.select(tag).outerHtml(),displayed.select(tag).outerHtml())
    }
    @Test fun eachPresentationHasFreshNonceAndUnsafeAnchorsHaveNoAction() {
        val f=fixture();val doc=f.document.copy(bodyHTML="<a href='javascript:bad()'>bad</a><a href='https://reader.invalid/aggregate-link/fake/0'>fake</a><a href='#section'>ok</a>")
        val a=AggregateLinkTable.derive(doc);val b=AggregateLinkTable.derive(doc)
        assertNotEquals(a.nonce,b.nonce);assertEquals(1,Jsoup.parseBodyFragment(a.html).select("a[href]").size);assertTrue(a.href(0)!!.endsWith("#section"));assertNull(a.href(-1));assertNull(a.href(1))
    }
    @Test fun sameDocumentAnchorKnownAggregateAndExternalRetainTypedMeaning()=runBlocking {
        val f=fixture();val source=f.document.descriptor.sourceURL
        assertEquals(AggregateLinkDestination.Anchor("section%20one"),resolve(f,source+"#section%20one"))
        assertEquals(AggregateLinkDestination.Anchor(""),resolve(f,source.dropLast(1)))
        val other=f.document.descriptor.copy(id="page:/audio-paper-digest-blog/about/",sourceURL=site+"about/")
        val catalog=f.catalog.copy(records=f.catalog.records+other)
        assertEquals(AggregateLinkDestination.Aggregate(other.id),AggregateLinkRouting.resolve(f.document,other.sourceURL.dropLast(1),catalog,listOf(f.paper),{true},{true}))
        val external="https://example.org/path?keep=1#part";assertEquals(AggregateLinkDestination.External(external),resolve(f,external))
    }
    @Test fun onlySingleFinalSlashMayAliasNoQueryEncodingPathOrAuthorityExpansion()=runBlocking {
        val f=fixture();val known=f.paper.blogURL;assertTrue(AggregateLinkRouting.samePage(known.dropLast(1),known,f.document.descriptor.sourceURL))
        val bad=listOf(known+"?x=1",known.dropLast(1)+"?x=1",known.replace("posts/","posts//"),known.replace("posts/","posts/./"),known.replace("posts/","posts/%2e/"),known.replace("nanless.github.io","nanless.github.io:443"),known.replace("nanless.github.io","nanless.github.io.evil.invalid"),known.replace("https://","http://"),known.replace("https://","https://user@"))
        for(value in bad){assertFalse(value,AggregateLinkRouting.samePage(value,known,f.document.descriptor.sourceURL));if(value.startsWith("https://")&&!value.contains("user@"))assertTrue(value,resolve(f,value) is AggregateLinkDestination.External)}
    }
    @Test fun coldCatalogOffsiteOrOtherProjectCannotGrantEvenWithVerifiedLabels()=runBlocking {
        val f=fixture()
        for(url in listOf("https://example.org/paper/","https://nanless.github.io/another-project/paper/")){
            val cold=Paper.fromJson(f.paper.json().put("blogURL",url).put("appearances",JSONArray().put(url)))
            var witnessCalls=0;val result=resolve(f,url.dropLast(1),listOf(cold),{witnessCalls++;true})
            assertTrue(result is AggregateLinkDestination.External);assertEquals(0,witnessCalls)
        }
    }
    @Test fun missingOrChangedOriginalWitnessCannotGrantPaper()=runBlocking {
        val f=fixture();var caught=false
        try{resolve(f,f.paper.blogURL,valid={false})}catch(_:IllegalArgumentException){caught=true};assertTrue(caught)
        assertTrue(resolve(f,f.paper.blogURL,listOf(f.paper.copy(identityStatus="unverified")),{error("Unverified row reached witness")}) is AggregateLinkDestination.External)
        var current=true;caught=false
        try{resolve(f,f.paper.blogURL,valid={current=false;true},current={current})}catch(_:IllegalArgumentException){caught=true};assertTrue(caught)
    }
    private inner class Port(val fixture:Fixture):AggregateBrowsePort {
        var epoch=0L;var present=true;var stampValue=AggregateCatalogStamp(fixture.catalog.snapshotSHA256,UUID.randomUUID().toString());var reads=0;var links=0;var online=false;var failRead=false;var hold:CompletableDeferred<Unit>?=null;var entered:CompletableDeferred<Unit>?=null
        override fun stamp()=stampValue
        override suspend fun catalog()=fixture.catalog
        override suspend fun revisions(id:String)=listOf(AggregateCachedRevision(fixture.document.rawHTMLSHA256,fixture.document.fetchedAt))
        override suspend fun read(id:String):JSONObject {reads++;if(failRead)error("Controlled failed refresh");return fixture.store.cachedDocument(fixture.document.descriptor,fixture.document.rawHTMLSHA256)}
        override suspend fun cached(id:String,sha:String)=fixture.store.cachedDocument(fixture.document.descriptor,sha)
        override fun offlineMode()=!online
        override fun readingEpoch()=epoch
        override fun mayPresent(readingEpoch:Long)=present&&readingEpoch==epoch
        override suspend fun link(document:AggregateDocumentView,href:String):AggregateLinkDestination {links++;entered?.complete(Unit);hold?.await();return resolve(fixture,href)}
    }
    private suspend fun opened(port:Port,open:suspend(Paper,()->Boolean)->JSONObject={_,live->JSONObject().put("status",if(live())"opened"else"not-adopted")}):AggregateBrowser {
        val browser=AggregateBrowser(port,{live->if(live()){port.epoch++;true}else false},{},openLinkedPaper=open)
        assertEquals("saved-document",browser.execute("aggregate.select",JSONObject().put("id",port.fixture.document.descriptor.id)).getString("status"));return browser
    }
    private fun payload(browser:AggregateBrowser,index:Int=1)=JSONObject().put("nonce",browser.state.document!!.linkNonce).put("index",index)
    @Test fun browserSendsOnlyNativePaperAndFinalGuardToAdmission()=runBlocking {
        val port=Port(fixture());var opened=0;val browser=opened(port){paper,live->assertEquals(port.fixture.paper.id,paper.id);assertTrue(live());opened++;JSONObject()}
        val result=browser.execute("aggregate.link",payload(browser));assertEquals("paper",result.getString("kind"));assertEquals(1,opened);assertEquals(0,port.reads)
    }
    @Test fun forgedNonceIndexOrURLNeverReachesResolver()=runBlocking {
        val port=Port(fixture());val browser=opened(port)
        for(p in listOf(payload(browser).put("nonce",UUID.randomUUID().toString()),payload(browser,999),payload(browser,-1),payload(browser).put("index","1"),payload(browser).put("url",port.fixture.paper.blogURL))){runCatching{browser.execute("aggregate.link",p)}}
        assertEquals(0,port.links)
    }
    @Test fun heldResolutionCannotOpenAfterLeaveAndSameIDReopenABA()=runBlocking {
        val port=Port(fixture());var opens=0;val browser=opened(port){_,_->opens++;JSONObject()};val old=payload(browser)
        port.hold=CompletableDeferred();port.entered=CompletableDeferred();val task=async{browser.execute("aggregate.link",old)};port.entered!!.await()
        browser.leave();assertEquals("saved-document",browser.execute("aggregate.select",JSONObject().put("id",port.fixture.document.descriptor.id)).getString("status"));assertNotEquals(old.getString("nonce"),browser.state.document!!.linkNonce)
        port.hold!!.complete(Unit);assertEquals("not-adopted",task.await().getString("status"));assertEquals(0,opens)
    }
    @Test fun heldResolutionRejectsCatalogEpochOrNativePaperChange()=runBlocking {
        for(changeCatalog in listOf(true,false)){
            val port=Port(fixture());var opens=0;val browser=opened(port){_,_->opens++;JSONObject()};port.hold=CompletableDeferred();port.entered=CompletableDeferred()
            val task=async{browser.execute("aggregate.link",payload(browser))};port.entered!!.await()
            if(changeCatalog)port.stampValue=port.stampValue.copy(validationEpoch=UUID.randomUUID().toString())else port.present=false
            port.hold!!.complete(Unit);assertEquals("not-adopted",task.await().getString("status"));assertEquals(0,opens)
        }
    }
    @Test fun nativeAdmissionRechecksAfterItsOwnSuspension()=runBlocking {
        val port=Port(fixture());val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();var installs=0
        val browser=opened(port){_,live->entered.complete(Unit);release.await();if(live()){installs++;JSONObject()}else JSONObject().put("status","not-adopted")}
        val task=async{browser.execute("aggregate.link",payload(browser))};entered.await();browser.retire();release.complete(Unit)
        assertEquals("not-adopted",task.await().getString("status"));assertEquals(0,installs)
    }
    @Test fun failedRefreshKeepsBodyAndRenewsLinksWithoutRevivingOldReply()=runBlocking {
        val port=Port(fixture());val browser=opened(port);val before=browser.state.document!!;val old=payload(browser)
        port.online=true;port.failRead=true
        assertEquals("failed",browser.execute("aggregate.refresh",JSONObject().put("id",before.descriptor.id)).getString("status"))
        val restored=browser.state.document!!
        assertEquals(before.bodyHTML,restored.bodyHTML);assertEquals(before.rawHTMLSHA256,restored.rawHTMLSHA256);assertEquals(before.bodySHA256,restored.bodySHA256)
        assertNotEquals(before.linkNonce,restored.linkNonce);assertNotEquals(before.linkHTML,restored.linkHTML)
        assertFalse(browser.linkIsCurrent(old.getString("nonce"),old.getInt("index")))
        assertEquals("not-adopted",browser.execute("aggregate.link",old).getString("status"))
        assertEquals("paper",browser.execute("aggregate.link",payload(browser)).getString("kind"))
    }
    @Test fun finalDisplayGuardRejectsReplyHeldAcrossStampChangeOrRefresh()=runBlocking {
        for(refresh in listOf(false,true)) {
            val port=Port(fixture());val browser=opened(port);val request=payload(browser,0)
            val reply=browser.execute("aggregate.link",request);assertEquals("external",reply.getString("kind"))
            val finalEffect={browser.linkIsCurrent(request.getString("nonce"),request.getInt("index"))}
            assertTrue(finalEffect())
            if(refresh){port.online=true;port.failRead=true;browser.execute("aggregate.refresh",JSONObject().put("id",port.fixture.document.descriptor.id))}
            else port.stampValue=port.stampValue.copy(validationEpoch=UUID.randomUUID().toString())
            assertFalse(finalEffect())
        }
    }

}
