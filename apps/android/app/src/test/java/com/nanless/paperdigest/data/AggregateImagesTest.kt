package com.nanless.paperdigest.data

import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.After
import org.junit.Test
import java.io.File
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/** Real Store and source-parser fixtures; no Android SDK, network, accounts or replacement safety gates. */
class AggregateImagesTest {
    private val roots=mutableListOf<File>()
    private data class Fixture(val root:File,val store:PublishedAggregateStore,val descriptor:PublishedAggregate,val raw:String,val original:JSONObject)
    private val url="https://arxiv.org/html/2501.00001v1/image.png"
    private fun markup(count:Int)= (0 until count).joinToString(""){i->"<figure><img src='$url' alt='Image $i'/><figcaption>Caption $i</figcaption></figure>"}
    private fun fixture(images:String=markup(2)):Fixture {
        val root=Files.createTempDirectory("aggregate-images51-").toFile().canonicalFile;roots+=root
        val rows=JSONArray().put(JSONObject().put("pageType","daily").put("permalink","/audio-paper-digest-blog/ci-images51/").put("title","Controlled aggregate").put("date","2026-10-24"))
        val shard=OfflineFoundationJSON.encode(rows);val sha=PublishedAggregateReader.sha(shard);File(root,"index").mkdir();File(root,"index/$sha.json").writeBytes(shard)
        val manifest=OfflineFoundationJSON.encode(JSONObject().put("contract","paper-search-index-manifest-v1").put("recordCount",1).put("totalBytes",shard.size).put("shards",JSONArray().put(JSONObject().put("url","search-index/part-0001-${sha.take(12)}.json").put("sha256",sha).put("bytes",shard.size).put("recordCount",1))))
        val store=PublishedAggregateStore(root);val descriptor=store.stage(manifest,UUID.randomUUID().toString()).records.single()
        val html="<html><link rel='canonical' href='${descriptor.sourceURL}'/><body><div id='article-body' class='post-content'><p>Before original images</p>$images<p>After original images</p></div></body></html>".toByteArray()
        val source=store.cacheDocument(html,descriptor,descriptor.sourceURL,"2026-10-24T00:00:00Z")
        return Fixture(root,store,descriptor,source.getString("rawHTMLSHA256"),source)
    }
    /** Portable fixture validator checks every CRC and the actual decoded RGBA pixel. */
    private fun validateFixturePNG(bytes:ByteArray) {
        require(bytes.take(8).toByteArray().contentEquals(byteArrayOf(0x89.toByte(),80,78,71,13,10,26,10)))
        fun number(offset:Int)=java.nio.ByteBuffer.wrap(bytes,offset,4).int
        var offset=8;var header=false;var ended=false;val compressed=ByteArrayOutputStream()
        while(offset<=bytes.size-12){
            val length=number(offset);require(length>=0&&length<=bytes.size-offset-12)
            val type=String(bytes,offset+4,4,Charsets.US_ASCII)
            val crc=java.util.zip.CRC32().apply{update(bytes,offset+4,length+4)}
            require(crc.value==(number(offset+8+length).toLong() and 0xffffffffL))
            when(type){
                "IHDR"->{require(!header&&offset==8&&length==13&&number(offset+8)==1&&number(offset+12)==1);require(bytes.copyOfRange(offset+16,offset+21).contentEquals(byteArrayOf(8,6,0,0,0)));header=true}
                "IDAT"->{require(header&&!ended&&length<=1024);compressed.write(bytes,offset+8,length)}
                "IEND"->{require(header&&length==0&&offset+12==bytes.size);ended=true}
            }
            offset+=length+12
        }
        require(header&&ended&&offset==bytes.size)
        val pixel=java.util.zip.InflaterInputStream(ByteArrayInputStream(compressed.toByteArray())).use{it.readBytes()}
        require(pixel.contentEquals(byteArrayOf(0,0x22,0x66,0xaa.toByte(),0xff.toByte())))
    }
    private fun png():ByteArray=java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQSlv1HwAEEgIyVuBIjQAAAABJRU5ErkJggg==").also{validateFixturePNG(it)}
    private fun paddedPNG():ByteArray {
        val small=png();val amount=AggregateImages.MAX_IMAGE_BYTES-small.size-12;val chunk=ByteArray(amount+4);"paDd".toByteArray().copyInto(chunk);val crc=java.util.zip.CRC32().apply{update(chunk)}
        val output=ByteArrayOutputStream();output.write(small,0,small.size-12);java.io.DataOutputStream(output).apply{writeInt(amount);write(chunk);writeInt(crc.value.toInt());write(small,small.size-12,12)}
        return output.toByteArray().also{require(it.size==16*1024*1024);validateFixturePNG(it)}
    }
    private suspend fun online(f:Fixture,bytes:ByteArray=png(),requests:AtomicInteger=AtomicInteger()):AggregateImageAccess=requireNotNull(AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{it==url},{_,limit->requests.incrementAndGet();require(bytes.size<=limit);bytes}))
    private fun manifestFile(f:Fixture,sha:String)=File(f.root,"${AggregateImages.DIRECTORY}/${PublishedAggregateReader.sha(f.descriptor.id.toByteArray())}/${f.descriptor.source.manifestSHA256}/${f.raw}/${AggregateImages.CONTRACT}/$sha.json")
    private fun rejects(body:()->Unit):Throwable {try{body()}catch(e:Throwable){return e};throw AssertionError("Expected rejection")}
    @After fun cleanup(){roots.forEach{it.deleteRecursively()}}
    @Test fun independentPlanKeepsOriginalDocumentAndPositions() {
        val f=fixture();val original=canonical(f.original);val plan=f.store.imagePlan(f.descriptor,f.raw)
        assertEquals(listOf("Caption 0","Caption 1"),plan.slots.map{it.caption});assertEquals(listOf(0,1),plan.slots.map{it.index});assertEquals(listOf(url,url),plan.slots.map{it.sourceURL});assertEquals(original,canonical(f.store.cachedDocument(f.descriptor,f.raw)))
        assertFalse(plan.templateBodyHTML.contains(" src="));assertEquals(f.original.getString("sanitizedBodySHA256"),plan.originalBodySHA256)
    }
    @Test fun normalDuplicateURLFetchesOnceAndStreamsBothPositions()=runBlocking {
        val f=fixture();val bytes=png();val requests=AtomicInteger();val view=online(f,bytes,requests)
        assertEquals(1,requests.get());assertEquals(2,view.savedCount);assertEquals(0,view.missingCount);assertFalse(view.bodyHTML.contains("base64"));assertTrue(view.bodyHTML.contains("Caption 0")&&view.bodyHTML.contains("Caption 1"))
        val address=view.cspImageSource+PublishedAggregateReader.sha(bytes);val response=requireNotNull(view.open(address,false,"GET"));assertEquals("image/png",response.first);assertArrayEquals(bytes,response.second.use{it.readBytes()})
    }
    @Test fun imageScopeIsPerDocumentAndRejectsOtherMethodsFramesAndAddresses()=runBlocking {
        val f=fixture();val first=online(f);val second=f.store.cachedImageRendering(f.descriptor,f.raw,first.manifestSHA256);val address=first.cspImageSource+first.records.first().sha256
        assertFalse(second.canServe(address,false,"GET"));assertNull(first.open(address,true,"GET"));assertNull(first.open(address,false,"POST"));assertNull(first.open(address+"?x",false,"GET"));assertNull(first.open(address+"#x",false,"GET"));assertNull(first.open("file:///etc/passwd",false,"GET"));assertNull(first.open("https://arxiv.org/image.png",false,"GET"))
    }
    @Test fun cachedSameSourceUsesNoNewTransport()=runBlocking {
        val f=fixture();val first=online(f);var requests=0
        val cached=requireNotNull(AggregateImageLoader.read(f.store,f.descriptor,f.raw,false,{true},{_,_->requests++;error("Offline transport called")}))
        assertEquals(first.manifestSHA256,cached.manifestSHA256);assertEquals(0,requests);assertEquals(2,cached.savedCount)
    }
    @Test fun repeatedValidLargeImageHasBoundedReferencesWithoutBase64Copies()=runBlocking {
        val f=fixture(markup(5));val requests=AtomicInteger();val bytes=paddedPNG();val view=online(f,bytes,requests)
        assertEquals(1,requests.get());assertEquals(4,view.savedCount);assertEquals(1,view.missingCount);assertEquals(64*1024*1024,view.records.mapNotNull{it.bytes}.sum());assertTrue(view.bodyHTML.length<10000);assertFalse(view.bodyHTML.contains("base64"))
        assertTrue(view.bodyHTML.contains("图片未缓存：Image 4"));val response=requireNotNull(view.open(view.cspImageSource+view.records.first().sha256,false,"GET"));val digest=java.security.MessageDigest.getInstance("SHA-256");var count=0
        response.second.use{input->val buffer=ByteArray(65536);while(true){val n=input.read(buffer);if(n<0)break;count+=n;digest.update(buffer,0,n)}}
        assertEquals(16*1024*1024,count);assertEquals(view.records.first().sha256,digest.digest().joinToString(""){"%02x".format(it.toInt()and 255)});println("HEAP_MAX_BYTES=${Runtime.getRuntime().maxMemory()}")
    }
    private suspend fun wrongLengthFirst(length:(Int)->Int):String {
        val f=fixture();val view=online(f);val manifest=JSONObject(manifestFile(f,view.manifestSHA256).readText());val rows=manifest.getJSONArray("images");rows.getJSONObject(0).put("bytes",length(rows.getJSONObject(0).getInt("bytes")));rows.getJSONObject(1).put("sha256","f".repeat(64)).put("bytes",1)
        val raw=OfflineFoundationJSON.encode(manifest);val sha=PublishedAggregateReader.sha(raw);manifestFile(f,sha).writeBytes(raw)
        return rejects{f.store.cachedImageRendering(f.descriptor,f.raw,sha)}.message.orEmpty()
    }
    @Test fun understatedFirstBlobRejectedBeforeLaterAbsentBlob()=runBlocking{assertEquals("图片实际长度与清单不一致",wrongLengthFirst{1})}
    @Test fun overstatedFirstBlobRejectedBeforeLaterAbsentBlob()=runBlocking{assertEquals("图片实际长度与清单不一致",wrongLengthFirst{it+1})}
    @Test fun corruptBlobCannotServeOrColdRestore()=runBlocking {
        val f=fixture();val view=online(f);val blob=File(f.root,"aggregate-image-bytes-v1/${view.records.first().sha256}");val bytes=blob.readBytes();bytes[bytes.size-1]=(bytes.last().toInt() xor 1).toByte();blob.writeBytes(bytes)
        rejects{f.store.cachedImageRendering(f.descriptor,f.raw,view.manifestSHA256)};rejects{view.open(view.cspImageSource+view.records.first().sha256,false,"GET")};Unit
    }
    @Test fun corruptNativePeerFailsStrictlyButForeignNamespaceIsNotNativePeer()=runBlocking {
        val f=fixture();val view=online(f);File(f.root,"aggregate-resource-renders-macos-v1").mkdir();File(f.root,"aggregate-resource-renders-macos-v1/foreign-format").writeText("Not Android")
        assertEquals(view.manifestSHA256,f.store.latestImageRendering(f.descriptor,f.raw)?.manifestSHA256)
        val path=manifestFile(f,view.manifestSHA256);path.writeText(path.readText()+" ");rejects{f.store.latestImageRendering(f.descriptor,f.raw)};Unit
    }
    @Test fun symlinkAssetRejectedEvenWithSameCorrectTargetBytes()=runBlocking {
        val f=fixture();val view=online(f);val blob=File(f.root,"aggregate-image-bytes-v1/${view.records.first().sha256}");val target=File(f.root,"saved-native-image");Files.move(blob.toPath(),target.toPath());Files.createSymbolicLink(blob.toPath(),target.toPath());rejects{f.store.cachedImageRendering(f.descriptor,f.raw,view.manifestSHA256)};Unit
    }
    @Test fun unapprovedImageNeverReachesTransport()=runBlocking {
        val f=fixture("<img src='https://127.0.0.1/private.png' alt='No private access'/>");var requests=0
        val view=requireNotNull(AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{false},{_,_->requests++;png()}));assertEquals(0,requests);assertEquals(0,view.savedCount);assertEquals(1,view.missingCount)
    }
    @Test fun cancelledFetchDoesNotPublishResourceManifest()=runBlocking {
        val f=fixture();val started=CompletableDeferred<Unit>();val job=async{AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{true},{_,_->started.complete(Unit);awaitCancellation()})};started.await();job.cancelAndJoin()
        assertFalse(File(f.root,AggregateImages.DIRECTORY).exists())
    }
    @Test fun changedSourceEpochAfterFetchDoesNotPublishBlobOrManifest()=runBlocking {
        val f=fixture();var current=true
        try{AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{true},{_,_->current=false;png()},{require(current){"Source epoch changed"}});fail("Expected source epoch rejection")}catch(e:IllegalArgumentException){assertEquals("Source epoch changed",e.message)}
        assertFalse(File(f.root,AggregateImages.DIRECTORY).exists());assertFalse(File(f.root,"aggregate-image-bytes-v1").exists())
    }
    @Test fun staleOwnerCannotGetEvenFullyCachedImageAccess()=runBlocking {
        val f=fixture();online(f);var requests=0
        try{AggregateImageLoader.read(f.store,f.descriptor,f.raw,false,{true},{_,_->requests++;png()},{error("Stale native owner")});fail("Expected owner rejection")}catch(e:IllegalStateException){assertEquals("Stale native owner",e.message)}
        assertEquals(0,requests)
    }

    @Test fun partialCacheKeepsVerifiedImageWhenOnlyMissingImageStillFails()=runBlocking {
        val other=url.replace("image.png","missing.png")
        val f=fixture("<img src='$url' alt='Saved'/><img src='$other' alt='Missing'/>")
        val first=requireNotNull(AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{true},{address,_->if(address==url)png() else throw java.io.IOException("Missing original image")}))
        assertEquals(1,first.savedCount);val requested=mutableListOf<String>()
        val retry=requireNotNull(AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{true},{address,_->requested+=address;throw java.io.IOException("Still unavailable")}))
        assertEquals(listOf(other),requested);assertEquals(1,retry.savedCount);assertEquals(first.records[0],retry.records[0]);assertEquals(f.original.getString("sanitizedBodySHA256"),retry.plan.originalBodySHA256)
        val response=requireNotNull(retry.open(retry.cspImageSource+retry.records[0].sha256,false,"GET"));assertArrayEquals(png(),response.second.use{it.readBytes()})
    }
    @Test fun partialCacheDownloadsOnlyMissingOriginalSlot()=runBlocking {
        val other=url.replace("image.png","later.png")
        val f=fixture("<img src='$url' alt='Saved'/><img src='$other' alt='Later'/>")
        val first=requireNotNull(AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{true},{address,_->if(address==url)png() else throw java.io.IOException("Temporarily missing")}))
        val requested=mutableListOf<String>()
        val retry=requireNotNull(AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{true},{address,_->requested+=address;png()}))
        assertEquals(listOf(other),requested);assertEquals(2,retry.savedCount);assertEquals(0,retry.missingCount);assertEquals(first.records[0],retry.records[0]);assertEquals(canonical(f.original),canonical(f.store.cachedDocument(f.descriptor,f.raw)))
    }
    @Test fun partialCacheCannotHideCorruptSavedImageByRefetching()=runBlocking {
        val other=url.replace("image.png","later.png")
        val f=fixture("<img src='$url'/><img src='$other'/>")
        val first=requireNotNull(AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{true},{address,_->if(address==url)png() else throw java.io.IOException("Missing")}))
        File(f.root,"aggregate-image-bytes-v1/${first.records[0].sha256}").writeText("Damaged actual cached bytes")
        var fetched=0;var refused=false
        try{AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{true},{_,_->fetched++;png()})}catch(e:Exception){refused=true}
        assertTrue(refused);assertEquals(0,fetched)
    }

    @Test fun reservedCachedReferenceBudgetProtectsLaterSavedSlots()=runBlocking {
        val firstURL=url.replace("image.png","initially-unsupported.png")
        val f=fixture("<img src='$firstURL' alt='Missing first'/>"+markup(4));val bytes=paddedPNG()
        val first=requireNotNull(AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{true},{address,_->if(address==firstURL)"<svg/>".toByteArray() else bytes}))
        assertEquals(4,first.savedCount);assertEquals(1,first.missingCount)
        val requested=mutableListOf<String>()
        val retry=requireNotNull(AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{true},{address,_->requested+=address;png()}))
        assertTrue(requested.isEmpty());assertEquals(4,retry.savedCount);assertEquals(1,retry.missingCount);assertEquals(first.records.drop(1),retry.records.drop(1));assertEquals(64*1024*1024,retry.records.mapNotNull{it.bytes}.sum())
    }

    private class Port(private val f:Fixture,val readImages:suspend (Boolean)->AggregateImageAccess?):AggregateBrowsePort {
        var offline=false;var saved=false
        override fun stamp()=AggregateCatalogStamp(f.descriptor.source.manifestSHA256,"native-image-test-epoch")
        override suspend fun catalog()=PublishedAggregateCatalog(f.descriptor.source.manifestSHA256,1,listOf(f.descriptor))
        override suspend fun revisions(id:String)=if(saved)listOf(AggregateCachedRevision(f.raw,"2026-10-24T00:00:00Z"))else emptyList()
        override suspend fun read(id:String)=f.store.cachedDocument(f.descriptor,f.raw)
        override suspend fun cached(id:String,sha:String)=f.store.cachedDocument(f.descriptor,sha)
        override suspend fun images(id:String,rawHTMLSHA256:String,allowNetwork:Boolean):AggregateImageAccess?{require(id==f.descriptor.id&&rawHTMLSHA256==f.raw);return readImages(allowNetwork)}
        override fun offlineMode()=offline
        override fun readingEpoch()=1L
        override fun mayPresent(readingEpoch:Long)=readingEpoch==1L
    }
    private fun browser(port:Port)=AggregateBrowser(port,{it()},{})
    @Test fun lateImageReplyAfterBackCannotReinstallOldDocument()=runBlocking {
        val f=fixture();val access=online(f);val started=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
        val b=browser(Port(f){started.complete(Unit);release.await();access});val pending=async{b.execute("aggregate.select",JSONObject().put("id",f.descriptor.id))};started.await()
        b.execute("aggregate.back",JSONObject());release.complete(Unit);assertEquals("not-adopted",pending.await().getString("status"));assertNull(b.state.document);assertNull(b.state.selected)
    }
    @Test fun savedOfflineDocumentRequestsOnlyCachedImages()=runBlocking {
        val f=fixture();val access=online(f);var networkFlag:Boolean?=null;val port=Port(f){networkFlag=it;access};port.offline=true;port.saved=true
        val b=browser(port);assertEquals("saved-document",b.execute("aggregate.select",JSONObject().put("id",f.descriptor.id)).getString("status"));assertEquals(false,networkFlag);assertEquals(access,b.state.document?.images)
    }
    @Test fun imageFailureKeepsVerifiedOriginalTextWithExplicitError()=runBlocking {
        val f=fixture();val b=browser(Port(f){throw java.io.IOException("controlled image failure")})
        assertEquals("website-document",b.execute("aggregate.select",JSONObject().put("id",f.descriptor.id)).getString("status"));assertEquals(f.original.getString("bodyHTML"),b.state.document?.bodyHTML);assertNull(b.state.document?.images);assertNotNull(b.state.document?.imageError)
    }
    @Test fun genuineButOtherRawImageAccessCannotBeInstalledOnThisDocument()=runBlocking {
        val f=fixture();val other=fixture(markup(1));val access=online(other);val b=browser(Port(f){access})
        b.execute("aggregate.select",JSONObject().put("id",f.descriptor.id));assertNull(b.state.document?.images);assertNotNull(b.state.document?.imageError);assertEquals(f.raw,b.state.document?.rawHTMLSHA256)
    }


    @Test fun independentlyVerifiedLaterSameURLCacheFillsEarlierMissingSlotWithoutTransport()=runBlocking {
        val f=fixture("<img src='$url' alt='Earlier'/><img src='$url' alt='Later'/>")
        var initialRequests=0
        val first=requireNotNull(AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{true},{_,_->
            initialRequests++;if(initialRequests==1)"<svg/>".toByteArray() else png()
        }))
        assertEquals(2,initialRequests);assertEquals(1,first.savedCount);assertEquals(1,first.missingCount)
        assertNull(first.records[0].sha256);assertNotNull(first.records[1].sha256)
        val requested=mutableListOf<String>()
        val retry=requireNotNull(AggregateImageLoader.read(f.store,f.descriptor,f.raw,true,{true},{address,_->
            requested+=address;throw java.io.IOException("Controlled unavailable original")
        }))
        println("LATER_SAVED_RETRY_REQUESTS=${requested.size};SAVED=${retry.savedCount};MISSING=${retry.missingCount}")
        assertTrue("An already verified same-URL image exists in the later slot",requested.isEmpty())
        assertEquals(2,retry.savedCount);assertEquals(0,retry.missingCount)
        assertEquals(first.records[1].sha256,retry.records[0].sha256)
    }
}
