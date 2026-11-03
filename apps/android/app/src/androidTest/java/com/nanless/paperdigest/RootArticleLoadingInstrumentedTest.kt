package com.nanless.paperdigest

import android.content.Context
import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger

/** Real Root, native sync/parser/cache, and a held optional image. Every response is synthetic. */
class RootArticleLoadingInstrumentedTest {
    private class Fixture(private val seedCatalog:Boolean=true) {
        val target=InstrumentationRegistry.getInstrumentation().targetContext
        val temporary=Files.createTempDirectory(target.cacheDir.toPath(),"root-article-loading-").toFile().canonicalFile
        val context=object:ContextWrapper(target){override fun getNoBackupFilesDir()=temporary}
        val imageStarted=CompletableDeferred<Unit>();val imageCancelled=CompletableDeferred<Unit>();val releaseImage=CompletableDeferred<Unit>()
        val indexStarted=CompletableDeferred<Unit>();val releaseIndex=CompletableDeferred<Unit>();val indexRequests=AtomicInteger()
        val firstPageStarted=CompletableDeferred<Unit>();val firstPageStopped=CompletableDeferred<Unit>()
        @Volatile var holdFirstPage=false
        @Volatile var holdIndex=false
        @Volatile var failIndex=false
        lateinit var repository:CatalogRepository
        val first=CatalogRepository.SITE+"posts/root-first/";val second=CatalogRepository.SITE+"posts/root-second/";val daily=CatalogRepository.SITE+"qa-root-daily/"
        val image=CatalogRepository.SITE+"images/root-held.png"
        private val png=java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
        private fun row(number:Int,url:String)=JSONObject().put("pageType","paper").put("title","Synthetic root paper $number").put("titleZh","受控根论文 $number")
            .put("identityStatus","verified").put("sourceKind","arxiv").put("arxivId","2601.0000$number").put("date","2026-11-03").put("permalink",url)
            .put("sourceUrl","https://arxiv.org/abs/2601.0000${number}v1").put("pdfUrl","https://arxiv.org/pdf/2601.0000${number}v1")
        private val rows=JSONArray().put(row(1,first)).put(row(2,second)).put(JSONObject().put("pageType","daily").put("title","受控日更").put("date","2026-11-03").put("permalink",daily))
        private val shard=rows.toString().toByteArray();private val shardSHA=sha256(shard)
        private val manifest=JSONObject().put("contract","paper-search-index-manifest-v1").put("recordCount",3).put("totalBytes",shard.size)
            .put("shards",JSONArray().put(JSONObject().put("url","search-index/part-0001-${shardSHA.take(12)}.json").put("sha256",shardSHA).put("bytes",shard.size).put("recordCount",3)))
        private val secrets=object:SecretStore{
            override fun load(scope:String):String?=null
            override fun save(scope:String,secret:String)=error("No credentials in this fixture")
            override fun remove(scope:String)=error("No credentials in this fixture")
        }
        val root=RootController(context,false,secrets){ctx,store->
            CatalogRepository(ctx,store){url,_->when(url){
                CatalogRepository.SITE+"client/index.json"->throw PublishedHttpStatus(404)
                CatalogRepository.SITE+"index.json"->{indexRequests.incrementAndGet();indexStarted.complete(Unit);if(holdIndex)releaseIndex.await();if(failIndex)error("Synthetic index unavailable");manifest.toString().toByteArray()}
                CatalogRepository.SITE+"search-index/part-0001-${shardSHA.take(12)}.json"->shard
                first->{if(holdFirstPage){firstPageStarted.complete(Unit);try{awaitCancellation()}finally{firstPageStopped.complete(Unit)}}
                    "<div id='article-body' class='post-content'><h1>第一篇先显示的正文</h1><img src='$image' alt='受控图'/></div>".toByteArray()}
                second->"<div id='article-body' class='post-content'><h1>第二篇独立正文</h1></div>".toByteArray()
                daily->"<html><head><link rel='canonical' href='$daily'/></head><body><div id='article-body' class='post-content'><p>受控日更正文</p><a href='$first'>第一篇</a></div></body></html>".toByteArray()
                image->{imageStarted.complete(Unit);try{releaseImage.await();png}catch(cancelled:CancellationException){imageCancelled.complete(Unit);throw cancelled}}
                else->error("Synthetic optional source not provided")
            }}.also{repository=it;if(seedCatalog)runBlocking{it.sync()}}
        }
        fun close(){
            (RootController::class.java.getDeclaredField("exportScope").also{it.isAccessible=true}.get(root)as CoroutineScope).cancel()
            temporary.deleteRecursively()
        }
    }
    @Test fun rootOpenReturnsAtReadableTextWhileItsApplicationOwnedImageProducerIsHeld()=runBlocking {
        val f=Fixture()
        try {
            val result=withTimeout(10_000){f.root.execute("paper.open",JSONObject().put("paperID","arxiv:2601.00001"))}
            assertEquals("arxiv:2601.00001",result.getString("id"));withTimeout(10_000){f.imageStarted.await()}
            val early=f.root.state.value;assertEquals("arxiv:2601.00001",early.selectedPaperId);assertFalse(early.loading)
            assertTrue(early.article!!.html.contains("第一篇先显示的正文"));assertFalse(early.article!!.completeOffline);assertTrue(early.readingMaterialID.isNotEmpty())
            f.releaseImage.complete(Unit);withTimeout(10_000){f.root.state.first{it.article?.completeOffline==true}}
            assertEquals("arxiv:2601.00001",f.root.state.value.selectedPaperId)
        }finally{f.close()}
    }
    @Test fun anotherPaperDrainsTheHeldImageWithoutAnOldBodyOrGlobalCancellationError()=runBlocking {
        val f=Fixture()
        try {
            withTimeout(10_000){f.root.execute("paper.open",JSONObject().put("paperID","arxiv:2601.00001"));f.imageStarted.await()}
            withTimeout(10_000){f.root.execute("paper.open",JSONObject().put("paperID","arxiv:2601.00002"));f.imageCancelled.await()}
            f.releaseImage.complete(Unit);yield()
            assertEquals("arxiv:2601.00002",f.root.state.value.selectedPaperId);assertTrue(f.root.state.value.article!!.html.contains("第二篇独立正文"))
            assertFalse(f.root.state.value.article!!.html.contains("第一篇"));assertNull(f.root.state.value.error)
        }finally{f.close()}
    }
    @Test fun cancellingBeforeAnyReadableBodyCompletesTheOriginalWaiterAndClearsItsSpinner()=runBlocking {
        val f=Fixture()
        try {
            f.holdFirstPage=true
            val opening=async{f.root.execute("paper.open",JSONObject().put("paperID","arxiv:2601.00001"))}
            withTimeout(10_000){f.firstPageStarted.await()};assertTrue(f.root.state.value.loading)
            withTimeout(10_000){f.root.execute("settings.save",JSONObject().put("changes",JSONObject().put("appearance","light")));f.firstPageStopped.await()}
            try{withTimeout(10_000){opening.await()};fail("Cancelled unreadable producer returned success")}
            catch(expected:CancellationException){assertFalse(expected is TimeoutCancellationException)}
            assertFalse(f.root.state.value.loading);assertNull(f.root.state.value.error)
            withTimeout(10_000){f.root.execute("paper.open",JSONObject().put("paperID","arxiv:2601.00002"))}
            assertTrue(f.root.state.value.article!!.html.contains("第二篇独立正文"))
        }finally{f.close()}
    }
    @Test fun nativeAggregatePaperLinkAndReturnDoNotWaitForOptionalPaperImages()=runBlocking {
        val f=Fixture()
        try {
            f.root.enterAggregateView();f.root.execute("aggregate.list")
            val id=f.root.state.value.aggregate.catalog!!.records.single().id
            f.root.execute("aggregate.select",JSONObject().put("id",id));val oldNonce=f.root.state.value.aggregate.document!!.linkNonce
            val opened=withTimeout(10_000){f.root.execute("aggregate.link",JSONObject().put("nonce",oldNonce).put("index",0))}
            assertEquals("paper",opened.getString("kind"));assertEquals("arxiv:2601.00001",f.root.state.value.selectedPaperId)
            withTimeout(10_000){f.imageStarted.await()};f.root.enterAggregateView()
            withTimeout(10_000){f.root.execute("aggregate.resume",JSONObject().put("id",id));f.imageCancelled.await()}
            assertNull(f.root.state.value.selectedPaperId);assertEquals(id,f.root.state.value.aggregate.selected?.id)
            assertTrue(f.root.state.value.aggregate.document!!.bodyHTML.contains("受控日更正文"));assertNotEquals(oldNonce,f.root.state.value.aggregate.document!!.linkNonce)
        }finally{f.close()}
    }
    @Test fun automaticFirstSyncCoalescesConcurrentWaitersAndRefreshesTheEmptyDailyIndex()=runBlocking {
        val f=Fixture(seedCatalog=false)
        try {
            f.root.enterAggregateView();f.root.execute("aggregate.list")
            assertNull(f.root.state.value.aggregate.catalog);f.holdIndex=true
            val first=async{f.root.performAutomaticCatalogSync()};withTimeout(10_000){f.indexStarted.await()}
            assertFalse(f.root.performAutomaticCatalogSync());assertEquals(1,f.indexRequests.get())
            f.releaseIndex.complete(Unit);assertTrue(withTimeout(10_000){first.await()})
            assertEquals(2,f.root.state.value.catalogSummary.getInt("paperCount"));assertTrue(f.root.state.value.papers.any{it.id=="arxiv:2601.00001"});assertTrue(f.root.state.value.papers.any{it.id=="arxiv:2601.00002"});assertTrue(f.root.state.value.aggregate.catalogStale)
            assertEquals("index-ready",withTimeout(10_000){f.root.execute("aggregate.list")}.getString("status"))
            assertEquals(1,f.root.state.value.aggregate.catalog!!.records.size)
            // Drain optional preload with an ordinary settings action, then check actual age admission.
            f.root.execute("settings.save",JSONObject().put("changes",JSONObject().put("appearance","light")))
            assertFalse(f.root.performAutomaticCatalogSync());assertEquals(1,f.indexRequests.get())
            assertTrue(f.root.personal.snapshot().getJSONArray("sessions").length()==0)
        }finally{f.close()}
    }
    @Test fun automaticOfflineAndFailedRefreshPreserveTheOriginalCatalogAndFailureCooldown()=runBlocking {
        val f=Fixture()
        try {
            val current=f.root.personal.directory.resolve("PublishedLibrary/current.json")
            // Only age the scheduling hint in this private normal-sync fixture; source IDs/bytes stay bound.
            val aged=JSONObject(current.readText());aged.getJSONObject("summary").put("syncedAt","2020-01-01T00:00:00Z")
            JsonFiles.write(current,aged);f.repository.reload();f.root.execute("app.bootstrap")
            val before=current.readBytes();val beforeIDs=f.root.state.value.papers.map{it.id};f.failIndex=true
            f.root.personal.updateSettings(JSONObject().put("offlineMode",true))
            assertFalse(f.root.performAutomaticCatalogSync());assertEquals(1,f.indexRequests.get())
            f.root.personal.updateSettings(JSONObject().put("offlineMode",false))
            assertFalse(f.root.performAutomaticCatalogSync());assertEquals(2,f.indexRequests.get())
            assertArrayEquals(before,current.readBytes());assertEquals(beforeIDs,f.root.state.value.papers.map{it.id});assertEquals(2,f.root.state.value.catalogSummary.getInt("paperCount"));assertNull(f.root.state.value.error)
            assertTrue(f.root.state.value.notice!!.contains("已保存的目录仍可阅读"))
            assertFalse(f.root.performAutomaticCatalogSync());assertEquals(2,f.indexRequests.get());assertArrayEquals(before,current.readBytes())
        }finally{f.close()}
    }
    @Test fun retainedPaperAllowsAutomaticRefreshOnlyAfterEveryVisibleReaderOwnerLeaves()=runBlocking {
        val f=Fixture();val activity=Any();val firstReader=Any();val secondReader=Any()
        // The fixture deliberately disables WorkManager registration; attach only this synthetic
        // lifecycle owner so the real explicit worker admission observes a foreground Activity.
        @Suppress("UNCHECKED_CAST")
        val foreground=RootController::class.java.getDeclaredField("foregroundOwners").also{it.isAccessible=true}.get(f.root)as MutableSet<Any>
        try {
            f.root.execute("paper.open",JSONObject().put("paperID","arxiv:2601.00002"))
            f.root.execute("settings.save",JSONObject().put("changes",JSONObject().put("appearance","light")))
            val selected=f.root.state.value.selectedPaperId;val body=f.root.state.value.article!!.html
            val current=f.root.personal.directory.resolve("PublishedLibrary/current.json")
            val aged=JSONObject(current.readText());aged.getJSONObject("summary").put("syncedAt","2020-01-01T00:00:00Z")
            JsonFiles.write(current,aged);f.repository.reload();f.root.execute("app.bootstrap")
            foreground.add(activity);f.root.readingViewVisible(firstReader,true);f.root.readingViewVisible(secondReader,true)
            assertFalse(f.root.performAutomaticCatalogSync());assertEquals(1,f.indexRequests.get())
            f.root.readingViewVisible(firstReader,false)
            assertFalse(f.root.performAutomaticCatalogSync());assertEquals(1,f.indexRequests.get())
            f.root.readingViewVisible(secondReader,false)
            assertTrue(withTimeout(10_000){f.root.performAutomaticCatalogSync()});assertEquals(2,f.indexRequests.get())
            assertEquals(selected,f.root.state.value.selectedPaperId);assertEquals(body,f.root.state.value.article!!.html)
            assertFalse(f.root.performAutomaticCatalogSync());assertEquals(2,f.indexRequests.get())
        }finally{
            foreground.remove(activity);f.root.readingViewVisible(firstReader,false);f.root.readingViewVisible(secondReader,false);f.close()
        }
    }

}
