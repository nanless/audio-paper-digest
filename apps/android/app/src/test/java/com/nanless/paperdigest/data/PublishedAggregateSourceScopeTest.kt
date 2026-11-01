package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Scope optimizes native decoding only; real manifest/shard/activation bytes remain mandatory. */
class PublishedAggregateSourceScopeTest {
 private fun fixture(test:(PublishedAggregateStore,PublishedAggregate,String,File,ByteArray)->Unit){
  val root=Files.createTempDirectory("aggregate-source-scope-").toFile().canonicalFile
  try {
   val rows=JSONArray().put(JSONObject().put("pageType","daily").put("permalink","/audio-paper-digest-blog/source-scope/").put("title","Synthetic source scope").put("date","2026-10-31"))
   val shard=OfflineFoundationJSON.encode(rows);val hash=sha256(shard);val shardFile=File(root,"index/$hash.json").apply{parentFile.mkdirs();writeBytes(shard)}
   val manifest=OfflineFoundationJSON.encode(JSONObject().put("contract","paper-search-index-manifest-v1").put("recordCount",1).put("totalBytes",shard.size).put("shards",JSONArray().put(JSONObject().put("url","search-index/part-0001-${hash.take(12)}.json").put("sha256",hash).put("bytes",shard.size).put("recordCount",1))))
   val epoch=UUID.randomUUID().toString();val store=PublishedAggregateStore(root);val record=store.stage(manifest,epoch).records.single()
   val html="<div id='article-body' class='post-content'><p>Original scope source</p><a href='#original'>Original link</a></div>".toByteArray()
   store.cacheDocument(html,record,record.sourceURL,"2026-10-31T00:00:00Z")
   test(store,record,epoch,shardFile,shard)
  }finally{root.deleteRecursively()}
 }
 @Test fun nativeCatalogIsDecodedOnceWithinCombinedReadAndNeverReusedAcrossCalls()=fixture { store,record,epoch,_,_->
  val one=store.withSourceReadScope {
   val first=store.load(record.source.manifestSHA256,epoch)!!
   val revisions=store.cachedRevisions(record);val document=store.cachedDocument(record,revisions.single().rawHTMLSHA256)
   assertTrue(document.getString("plainText").contains("Original scope source"))
   assertSame(first,store.load(record.source.manifestSHA256,epoch))
   assertNull(store.latestImageRendering(record,revisions.single().rawHTMLSHA256))
   first
  }
  assertNotSame(one,store.withSourceReadScope{store.load(record.source.manifestSHA256,epoch)!!})
 }
 @Test fun sourceShardChangedAfterReadIsRejectedBeforeTheCombinedResultCanEscape()=fixture { store,record,epoch,file,original->
  val failed=runCatching{store.withSourceReadScope {
   store.load(record.source.manifestSHA256,epoch)
   store.withSourceReadScope{store.cachedRevisions(record)}
   val changed=original.copyOf();changed[changed.lastIndex]=(changed.last().toInt() xor 1).toByte();file.writeBytes(changed)
   "must not return"
  }}
  assertTrue(failed.isFailure)
  file.writeBytes(original)
  assertNotNull(store.withSourceReadScope{store.load(record.source.manifestSHA256,epoch)})
 }
 @Test fun activationChangedAfterReadIsAlsoRejectedAndScopeIsAlwaysClosed()=fixture { store,record,epoch,file,_->
  val marker=File(file.parentFile.parentFile,"aggregate-activations/${record.source.manifestSHA256}/$epoch.json")
  val original=marker.readBytes()
  assertTrue(runCatching{store.withSourceReadScope {
   store.load(record.source.manifestSHA256,epoch)
   marker.writeBytes(original+byteArrayOf(32))
  }}.isFailure)
  marker.writeBytes(original)
  assertNotNull(store.load(record.source.manifestSHA256,epoch))
 }
 @Test fun mutatedNativeCatalogCannotBecomeAReusablePassedJsonObject()=fixture { store,record,epoch,_,_->
  assertTrue(runCatching{store.withSourceReadScope {
   val catalog=store.load(record.source.manifestSHA256,epoch)!!
   @Suppress("UNCHECKED_CAST")
   (catalog.records as MutableList<PublishedAggregate>).clear()
  }}.isFailure)
  assertEquals(1,store.load(record.source.manifestSHA256,epoch)!!.records.size)
 }
 @Test fun anotherThreadCannotBorrowTheOwnersParsedCatalog()=fixture { store,record,epoch,_,_->
  store.withSourceReadScope {
   val owned=store.load(record.source.manifestSHA256,epoch)!!
   val foreign=java.util.concurrent.atomic.AtomicReference<PublishedAggregateCatalog>()
   val failure=java.util.concurrent.atomic.AtomicReference<Throwable>()
   val thread=Thread{try{foreign.set(store.load(record.source.manifestSHA256,epoch))}catch(error:Throwable){failure.set(error)}}
   thread.start();thread.join(10000);assertFalse(thread.isAlive);assertNull(failure.get())
   assertNotNull(foreign.get());assertNotSame(owned,foreign.get())
   assertSame(owned,store.load(record.source.manifestSHA256,epoch))
  }
 }

}
