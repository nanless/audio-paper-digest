package com.nanless.paperdigest.data

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Clearly synthetic navigation pages, sealed by the real manifest/store/parser. No scientific result or network. */
class AggregateNavigationStackTest {
 private fun fixture(test:suspend (AggregateBrowser,List<PublishedAggregate>,()->Unit)->Unit)=runBlocking {
  val root=Files.createTempDirectory("aggregate-navigation-").toFile().canonicalFile
  try {
   val paths=listOf("conferences/","posts/conference-synthetic-2026/","posts/conference-synthetic-2026-task-audio/")
   val rows=JSONArray(paths.mapIndexed{i,path->JSONObject().put("pageType",if(i==0)"page"else"conference").put("permalink","/audio-paper-digest-blog/$path").put("title",listOf("合成会议目录","合成会议总览","合成研究方向")[i]).put("date","2026-10-31")})
   val shard=OfflineFoundationJSON.encode(rows);val sha=sha256(shard);File(root,"index").mkdir();File(root,"index/$sha.json").writeBytes(shard)
   val manifest=OfflineFoundationJSON.encode(JSONObject().put("contract","paper-search-index-manifest-v1").put("recordCount",3).put("totalBytes",shard.size).put("shards",JSONArray().put(JSONObject().put("url","search-index/part-0001-${sha.take(12)}.json").put("sha256",sha).put("bytes",shard.size).put("recordCount",3))))
   val store=PublishedAggregateStore(root);val catalog=store.stage(manifest,UUID.randomUUID().toString())
   val ordered=paths.map{path->catalog.records.single{it.sourceURL==PublishedAggregateReader.SITE+path}}
   val saved=ordered.mapIndexed{i,record->
    val opening=if(i==0)"<div id='conference-directory' class='conference-directory'>"else"<div id='article-body' class='post-content'>"
    val next=ordered.getOrNull(i+1)?.sourceURL?:PublishedAggregateReader.SITE+"posts/synthetic-paper/"
    store.cacheDocument("<html><body>$opening<p>${record.title}</p><a href='$next'>继续阅读</a></div></body></html>".toByteArray(),record,record.sourceURL,"2026-10-31T00:00:00Z")
   }.associateBy{it.getJSONObject("descriptor").getString("id")}
   var stamp=AggregateCatalogStamp(catalog.snapshotSHA256,"synthetic-epoch")
   val port=object:AggregateBrowsePort {
    override fun stamp()=stamp
    override suspend fun catalog()=catalog
    override suspend fun revisions(id:String)=listOf(AggregateCachedRevision(saved.getValue(id).getString("rawHTMLSHA256"),"2026-10-31T00:00:00Z"))
    override suspend fun read(id:String)=error("No network")
    override suspend fun cached(id:String,sha:String)=store.cachedDocument(ordered.single{it.id==id},sha)
    override fun offlineMode()=true
    override fun readingEpoch()=1L
    override fun mayPresent(readingEpoch:Long)=readingEpoch==1L
    override suspend fun link(document:AggregateDocumentView,href:String)=ordered.firstOrNull{it.sourceURL==href}?.let{AggregateLinkDestination.Aggregate(it.id)}?:AggregateLinkDestination.PublishedPaper(Paper("synthetic-paper","Synthetic paper"))
   }
   val browser=AggregateBrowser(port,{it()},{})
   test(browser,ordered){stamp=stamp.copy(validationEpoch=UUID.randomUUID().toString())}
  }finally{root.deleteRecursively()}
 }
 private fun next(browser:AggregateBrowser)=JSONObject().put("nonce",browser.state.document!!.linkNonce).put("index",0)
 @Test fun conferenceDirectoryOverviewAndTaskReturnOneLevelAtATimeWithFreshLinks()=fixture { b,pages,_->
  b.execute("aggregate.select",JSONObject().put("id",pages[0].id));val directoryNonce=b.state.document!!.linkNonce
  b.execute("aggregate.link",next(b));assertEquals(pages[1],b.state.selected);assertEquals("返回合成会议目录",b.state.backTitle)
  val overviewNonce=b.state.document!!.linkNonce
  b.execute("aggregate.link",next(b));assertEquals(pages[2],b.state.selected);assertEquals("返回合成会议总览",b.state.backTitle)
  val retired=next(b)
  b.execute("aggregate.back",JSONObject());assertEquals(pages[1],b.state.selected);assertNotEquals(overviewNonce,b.state.document!!.linkNonce)
  assertEquals("not-adopted",b.execute("aggregate.link",retired).getString("status"))
  b.execute("aggregate.back",JSONObject());assertEquals(pages[0],b.state.selected);assertNotEquals(directoryNonce,b.state.document!!.linkNonce)
  b.execute("aggregate.back",JSONObject());assertNull(b.state.selected)
 }
 @Test fun paperReturnRestoresOnlyDisplayTrailAndCannotReuseRetiredLink()=fixture { b,pages,_->
  b.execute("aggregate.select",JSONObject().put("id",pages[0].id));b.execute("aggregate.link",next(b));b.execute("aggregate.link",next(b))
  val old=next(b);b.leave();b.leave();b.enter()
  b.execute("aggregate.resume",JSONObject().put("id",pages[2].id))
  assertEquals(pages[2],b.state.selected);assertNotEquals(old.getString("nonce"),b.state.document!!.linkNonce)
  assertFalse(b.linkIsCurrent(old.getString("nonce"),0))
  b.execute("aggregate.back",JSONObject());assertEquals(pages[1],b.state.selected)
 }
 @Test fun changedCatalogOrExplicitNewSelectionCannotInheritOldTrail()=fixture { b,pages,changeStamp->
  b.execute("aggregate.select",JSONObject().put("id",pages[0].id));b.execute("aggregate.link",next(b));b.leave();b.enter();changeStamp()
  b.execute("aggregate.resume",JSONObject().put("id",pages[1].id));b.execute("aggregate.back",JSONObject());assertNull(b.state.selected)
  b.execute("aggregate.select",JSONObject().put("id",pages[0].id));b.execute("aggregate.link",next(b))
  b.execute("aggregate.select",JSONObject().put("id",pages[2].id));b.execute("aggregate.back",JSONObject());assertNull(b.state.selected)
 }
}
