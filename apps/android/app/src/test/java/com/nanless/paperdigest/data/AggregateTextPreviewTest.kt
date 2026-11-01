package com.nanless.paperdigest.data

import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Real source Store/parser with synthetic text. Preview never stands in for a scientific result or a paid response. */
class AggregateTextPreviewTest {
 private data class Gate(val entered:CompletableDeferred<Unit> = CompletableDeferred(),val release:CompletableDeferred<Unit> = CompletableDeferred())
 private class Port(val store:PublishedAggregateStore,val catalogValue:PublishedAggregateCatalog,val records:List<PublishedAggregate>,val raw:Map<String,String>):AggregateBrowsePort {
  var stampValue=AggregateCatalogStamp(catalogValue.snapshotSHA256,UUID.randomUUID().toString())
  val gates=java.util.ArrayDeque<Gate>();var fail=false;var online=false;var links=0
  private suspend fun pause(){if(gates.isNotEmpty()){val gate=gates.removeFirst();gate.entered.complete(Unit);gate.release.await()};if(fail)error("Controlled source failure")}
  override fun stamp()=stampValue
  override suspend fun catalog():PublishedAggregateCatalog {pause();return catalogValue}
  override suspend fun revisions(id:String)=store.cachedRevisions(records.single{it.id==id})
  override suspend fun read(id:String):JSONObject {pause();return cached(id,raw.getValue(id))}
  override suspend fun cached(id:String,sha:String)=store.cachedDocument(records.single{it.id==id},sha)
  override fun offlineMode()=!online
  override fun readingEpoch()=1L
  override fun mayPresent(readingEpoch:Long)=readingEpoch==1L
  override suspend fun link(document:AggregateDocumentView,href:String):AggregateLinkDestination {links++;return AggregateLinkDestination.External(href)}
 }
 private fun fixture(texts:List<String> = listOf("Source A","Source B","Source C"),test:suspend(AggregateBrowser,Port)->Unit)=runBlocking {
  val directory=Files.createTempDirectory("aggregate-text-preview-").toFile().canonicalFile
  try {
   val rows=JSONArray(texts.mapIndexed{i,_->JSONObject().put("pageType","daily").put("title","Synthetic page $i").put("date","2026-10-31").put("permalink","/audio-paper-digest-blog/preview-$i/")})
   val bytes=OfflineFoundationJSON.encode(rows);val sha=sha256(bytes);File(directory,"index/$sha.json").apply{parentFile.mkdirs();writeBytes(bytes)}
   val manifest=OfflineFoundationJSON.encode(JSONObject().put("contract","paper-search-index-manifest-v1").put("recordCount",texts.size).put("totalBytes",bytes.size).put("shards",JSONArray().put(JSONObject().put("url","search-index/part-0001-${sha.take(12)}.json").put("sha256",sha).put("bytes",bytes.size).put("recordCount",texts.size))))
   val store=PublishedAggregateStore(directory);val catalog=store.stage(manifest,UUID.randomUUID().toString());val records=catalog.records.sortedBy{it.sourceURL}
   val raw=records.mapIndexed{i,record->
    val html="<div id='article-body' class='post-content'><p>${texts[i]}</p><a href='https://example.org/real-link'>Known link</a><img src='https://example.org/image.png'/></div>".toByteArray()
    record.id to store.cacheDocument(html,record,record.sourceURL,"2026-10-31T00:00:00Z").getString("rawHTMLSHA256")
   }.toMap()
   val port=Port(store,catalog,records,raw)
   test(AggregateBrowser(port,{it()},{ }),port)
  }finally{directory.deleteRecursively()}
 }
 private suspend fun select(browser:AggregateBrowser,id:String)=browser.execute("aggregate.select",JSONObject().put("id",id))
 private suspend fun held(scope:CoroutineScope,browser:AggregateBrowser,port:Port,id:String):Pair<Gate,Deferred<JSONObject>> {
  val gate=Gate();port.gates.addLast(gate)
  val request=scope.async{select(browser,id)};gate.entered.await();return gate to request
 }
 @Test fun textAppearsDuringHeldColdReadButNoDocumentNonceLinkOrImageCapabilityExists()=fixture { b,p->coroutineScope {
  val id=p.records[0].id;select(b,id);val old=b.state.document!!.linkNonce!!
  b.leave();b.enter();val (gate,request)=held(this,b,p,id)
  assertTrue(b.state.loading);assertNull(b.state.document);assertTrue(b.state.preview!!.text.contains("Source A"))
  assertFalse(b.state.preview!!.text.contains("<a"));assertFalse(b.linkIsCurrent(old,0))
  assertEquals("not-adopted",b.execute("aggregate.link",JSONObject().put("nonce",old).put("index",0)).getString("status"));assertEquals(0,p.links)
  gate.release.complete(Unit);assertEquals("saved-document",request.await().getString("status"))
  assertNull(b.state.preview);assertNotNull(b.state.document);assertNotEquals(old,b.state.document!!.linkNonce)
 }}
 @Test fun failedColdReadWithdrawsTextAndCannotReviveItOnTheNextRetry()=fixture { b,p->coroutineScope {
  val id=p.records[0].id;select(b,id);b.leave();b.enter();val (gate,request)=held(this,b,p,id)
  assertNotNull(b.state.preview);p.fail=true;gate.release.complete(Unit)
  assertEquals("failed",request.await().getString("status"));assertNull(b.state.preview);assertNull(b.state.document);assertNotNull(b.state.error)
  p.fail=false;b.leave();b.enter();val (next,pending)=held(this,b,p,id)
  assertNull(b.state.preview);next.release.complete(Unit);pending.await()
 }}
 @Test fun explicitRefreshNeverUsesThePreviewAsADocumentOrRestoresItsLinks()=fixture { b,p->coroutineScope {
  val id=p.records[0].id;select(b,id);p.online=true
  val gate=Gate();p.gates.addLast(gate)
  val request=async{b.execute("aggregate.refresh",JSONObject().put("id",id))};gate.entered.await()
  assertNull(b.state.preview);p.fail=true;gate.release.complete(Unit);request.await()
  assertNull(b.state.preview) // The normal prior verified document keeps its existing explicit-refresh policy.
 }}
 @Test fun aNewStampCannotBorrowOldTextEvenIfThePageIdIsTheSame()=fixture { b,p->coroutineScope {
  val id=p.records[0].id;select(b,id);b.leave();b.enter();p.stampValue=p.stampValue.copy(validationEpoch=UUID.randomUUID().toString());b.observeNativeState()
  val (gate,request)=held(this,b,p,id);assertNull(b.state.preview);gate.release.complete(Unit);request.await()
 }}
 @Test fun heldOldResponseCannotReplaceTheNewPagesTextOrMintAnOldLink()=fixture { b,p->coroutineScope {
  val a=p.records[0].id;val c=p.records[1].id;select(b,a);select(b,c);b.leave();b.enter()
  val (ga,old)=held(this,b,p,a);val (gc,current)=held(this,b,p,c)
  assertEquals(c,b.state.preview!!.pageID)
  ga.release.complete(Unit);assertEquals("not-adopted",old.await().getString("status"));assertEquals(c,b.state.preview!!.pageID);assertNull(b.state.document)
  gc.release.complete(Unit);current.await();assertEquals(c,b.state.document!!.descriptor.id);assertNull(b.state.preview)
 }}
 @Test fun onlyTwoRecentlyAdoptedPagesAreRetained()=fixture { b,p->coroutineScope {
  p.records.forEach{select(b,it.id)};b.leave();b.enter()
  val (old,a)=held(this,b,p,p.records[0].id);assertNull(b.state.preview);a.cancelAndJoin();old.release.complete(Unit)
  b.leave();b.enter();val (recent,c)=held(this,b,p,p.records[1].id);assertNotNull(b.state.preview);c.cancelAndJoin();recent.release.complete(Unit)
  b.leave();b.enter();val (latest,d)=held(this,b,p,p.records[2].id);assertNotNull(b.state.preview);d.cancelAndJoin();latest.release.complete(Unit)
 }}
 @Test fun utf8BudgetEvictsOlderTextAndRejectsAnOversizedEntry()=fixture(listOf("甲".repeat(800_000),"乙".repeat(800_000),"丙".repeat(1_400_000))) { b,p->coroutineScope {
  p.records.forEach{select(b,it.id)};b.leave();b.enter()
  val (old,a)=held(this,b,p,p.records[0].id);assertNull(b.state.preview);a.cancelAndJoin();old.release.complete(Unit)
  b.leave();b.enter();val (large,c)=held(this,b,p,p.records[2].id);assertNull(b.state.preview);c.cancelAndJoin();large.release.complete(Unit)
  b.leave();b.enter();val (retained,d)=held(this,b,p,p.records[1].id);assertNotNull(b.state.preview);assertTrue(b.state.preview!!.text.toByteArray().size<=AggregateBrowser.PREVIEW_MAX_BYTES);d.cancelAndJoin();retained.release.complete(Unit)
 }}
 @Test fun syncOrRestorePauseClearsAndCannotRepopulatePreviewUntilItEnds()=fixture { b,p->coroutineScope {
  val id=p.records[0].id;select(b,id);b.pausePreviews();b.pausePreviews();b.resumePreviews();b.leave();b.enter()
  val (gate,request)=held(this,b,p,id);assertNull(b.state.preview);gate.release.complete(Unit);request.await()
  b.resumePreviews();b.leave();b.enter();val (again,pending)=held(this,b,p,id);assertNull(b.state.preview);again.release.complete(Unit);pending.await()
  b.invalidatePreviews();b.leave();b.enter();val (restored,last)=held(this,b,p,id);assertNull(b.state.preview);last.cancelAndJoin();restored.release.complete(Unit)
 }}
}
