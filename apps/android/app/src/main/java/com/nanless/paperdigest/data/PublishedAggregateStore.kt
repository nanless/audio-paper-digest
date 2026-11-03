package com.nanless.paperdigest.data

import com.nanless.paperdigest.protocols.ClientProtocols
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardOpenOption.*
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID

data class AggregateCachedRevision(val rawHTMLSHA256:String,val fetchedAt:String)

/** Original manifest + per-shard witness required. Scattered legacy caches never grant a retroactive manifest. */
class PublishedAggregateStore(private val directory:File) {
    companion object {private val immutablePublishLock=Any();private const val activationFamily="published-aggregate-activation";private const val catalogFamily="published-aggregate-index"}
    private data class SourceFile(val file:File,val limit:Int,val sha256:String)
    private data class ParsedSource(val catalog:PublishedAggregateCatalog,val shapeSHA256:String)
    private data class ParsedImagePlan(val plan:AggregateImagePlan,val canonical:String)
    private class SourceReadScope {
        val owner=Thread.currentThread()
        val files=linkedMapOf<String,SourceFile>()
        val catalogs=linkedMapOf<String,ParsedSource>()
        val plans=linkedMapOf<String,ParsedImagePlan>()
        val renderedImages=java.util.IdentityHashMap<AggregateImagePlan,MutableMap<String,String>>()
    }
    @Volatile private var sourceReadScope:SourceReadScope?=null
    private fun ownedSourceReadScope()=sourceReadScope?.takeIf{it.owner===Thread.currentThread()}
    /** Native synchronous read only: never spans a suspension, transport or another member.
     * Original bytes are read completely on first use and again before returning the combined view. */
    @Synchronized internal fun <T> withSourceReadScope(block:()->T):T {
        if(sourceReadScope!=null){require(sourceReadScope?.owner===Thread.currentThread()){"来源读取范围不能跨线程"};return block()}
        val scope=SourceReadScope();sourceReadScope=scope
        try {
            val result=block()
            scope.catalogs.values.forEach{saved->require(PublishedAggregateReader.sha(OfflineFoundationJSON.encode(saved.catalog.json()))==saved.shapeSHA256){"读取期间原生目录对象变化"}}
            scope.plans.values.forEach{saved->require(canonical(saved.plan.json())==saved.canonical){"读取期间原生图片计划变化"}}
            scope.files.values.forEach{saved->require(PublishedAggregateReader.sha(readRaw(saved.file,saved.limit))==saved.sha256){"读取期间汇总原来源字节变化"}}
            return result
        }finally{sourceReadScope=null}
    }
    private fun sourceBytes(file:File,limit:Int)=read(file,limit)
    private fun canonicalImagePlan(plan:AggregateImagePlan):String {
        val known=ownedSourceReadScope()?.plans?.values?.firstOrNull{it.plan===plan}
        return known?.canonical?:canonical(plan.json())
    }
    private fun renderedImageBodySHA(plan:AggregateImagePlan,records:List<AggregateImageRecord>):String {
        val scope=ownedSourceReadScope()
        // Only a private plan actually rebuilt from these original bytes may reuse a pure derivation.
        if(scope==null||scope.plans.values.none{it.plan===plan})return PublishedAggregateReader.sha(AggregateImages.render(plan,records).toByteArray())
        val key=canonical(JSONArray(records.map{it.json()}))
        val known=scope.renderedImages.getOrPut(plan){linkedMapOf()}
        return known.getOrPut(key){PublishedAggregateReader.sha(AggregateImages.render(plan,records).toByteArray())}
    }
    private fun noLinks(file:File){var path:File?=file.absoluteFile;while(path!=null){require(!Files.isSymbolicLink(path.toPath())){"汇总缓存不能含链接"};path=path.parentFile}}
    private fun child(vararg names:String):File {var result=directory;noLinks(result);for(name in names){require(name.isNotEmpty()&&name!="."&&name!=".."&&!name.contains('/')&&!name.contains('\\'));result=File(result,name);noLinks(result)};return result}
    private fun attrs(file:File)=Files.readAttributes(file.toPath(),BasicFileAttributes::class.java,NOFOLLOW_LINKS)
    private fun read(file:File,limit:Int):ByteArray {
        val bytes=readRaw(file,limit);val scope=ownedSourceReadScope()?:return bytes
        val proof=SourceFile(file,limit,PublishedAggregateReader.sha(bytes));val prior=scope.files.putIfAbsent(file.absolutePath,proof)
        require(prior==null||prior.sha256==proof.sha256){"读取期间汇总原来源字节变化"}
        return bytes
    }
    private fun readRaw(file:File,limit:Int):ByteArray {
        noLinks(file);val before=attrs(file);require(before.isRegularFile&&before.fileKey()!=null&&before.size() in 0..limit.toLong())
        val result=FileChannel.open(file.toPath(),READ,NOFOLLOW_LINKS).use{channel->val bytes=ByteArray(before.size().toInt());val buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining()){require(channel.read(buffer)>0)};require(channel.read(ByteBuffer.allocate(1))==-1);bytes}
        noLinks(file);val after=attrs(file);require(before.fileKey()==after.fileKey()&&before.size()==after.size()&&before.lastModifiedTime()==after.lastModifiedTime());return result
    }
    private fun immutable(file:File,bytes:ByteArray)=synchronized(immutablePublishLock){
        noLinks(directory);Files.createDirectories(directory.toPath());noLinks(directory)
        val rootIdentity=attrs(directory);require(rootIdentity.isDirectory&&rootIdentity.fileKey()!=null)
        val lock=child(".aggregate-publish.lock")
        val priorLock=if(Files.exists(lock.toPath(),NOFOLLOW_LINKS))attrs(lock).also{require(it.isRegularFile&&it.fileKey()!=null)}else null
        // A root-level persistent lock is part of the portable research tree, never a revision.
        FileChannel.open(lock.toPath(),WRITE,CREATE,NOFOLLOW_LINKS).use{channel->
            noLinks(lock);val lockIdentity=attrs(lock);require(lockIdentity.isRegularFile&&lockIdentity.fileKey()!=null&&(priorLock==null||priorLock.fileKey()==lockIdentity.fileKey()))
            channel.lock().use{
                fun pinned(){
                    noLinks(directory);noLinks(lock);noLinks(file)
                    require(attrs(directory).fileKey()==rootIdentity.fileKey()&&attrs(lock).fileKey()==lockIdentity.fileKey()){"汇总发布目录或锁身份变化"}
                }
                pinned();Files.createDirectories(file.parentFile.toPath());noLinks(file.parentFile)
                val parentIdentity=attrs(file.parentFile);require(parentIdentity.isDirectory&&parentIdentity.fileKey()!=null)
                if(Files.exists(file.toPath(),NOFOLLOW_LINKS))require(read(file,maxOf(1,bytes.size)).contentEquals(bytes)){"原汇总缓存冲突，未覆盖"}
                else{
                    val temporary=File(file.parentFile,".aggregate-${UUID.randomUUID()}");var owned:Any?=null
                    try{
                        FileChannel.open(temporary.toPath(),WRITE,CREATE_NEW,NOFOLLOW_LINKS).use{out->
                            owned=attrs(temporary).fileKey();require(owned!=null)
                            val buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining())out.write(buffer);out.force(true)
                        }
                        pinned();require(attrs(file.parentFile).fileKey()==parentIdentity.fileKey()&&attrs(temporary).fileKey()==owned)
                        // This private owned file is renamed below; guard the committed pathname, never a retired temporary name.
                        require(readRaw(temporary,maxOf(1,bytes.size)).contentEquals(bytes))
                        // ATOMIC_MOVE supplies complete visibility, not no-replace. The trusted OS lock
                        // and second existence/CAS check serialize every cooperating Store publisher.
                        if(Files.exists(file.toPath(),NOFOLLOW_LINKS))require(read(file,maxOf(1,bytes.size)).contentEquals(bytes)){"原汇总缓存冲突，未覆盖"}
                        else{Files.move(temporary.toPath(),file.toPath(),ATOMIC_MOVE);require(attrs(file).fileKey()==owned)}
                    }finally{
                        if(owned!=null&&Files.exists(temporary.toPath(),NOFOLLOW_LINKS)&&!Files.isSymbolicLink(temporary.toPath())&&attrs(temporary).fileKey()==owned)Files.delete(temporary.toPath())
                    }
                }
                pinned();require(attrs(file.parentFile).fileKey()==parentIdentity.fileKey())
                FileChannel.open(file.parentFile.toPath(),READ,NOFOLLOW_LINKS).use{it.force(true)}
                require(read(file,maxOf(1,bytes.size)).contentEquals(bytes))
            }
        }
    }
    private fun epoch(value:String):String {val id=UUID.fromString(value).toString();require(id.equals(value,true)){"汇总目录验证代无效"};return id}
    private fun catalogRecord(catalog:PublishedAggregateCatalog, original:ByteArray?=null):ByteArray {
        val body=catalog.json()
        if(original==null)return OfflineFoundationJSON.encode(ClientProtocols.record(catalogFamily,body))
        val saved=JSONObject(PublishedUtf8.decode(original))
        require(ClientProtocols.hasValidHeader(saved,catalogFamily)){"汇总目录格式无效"}
        val expected=ClientProtocols.recordHeader(saved.get("contract"),catalogFamily,saved.opt("schemaFingerprint") as? String)
        body.keys().forEach{key->expected.put(key,body.get(key))}
        require(canonical(saved)==canonical(expected)){"汇总目录与原清单不一致"}
        return original
    }
    private fun checkActivation(raw:ByteArray, snapshot:String, epoch:String, catalogSHA:String) {
        val value=JSONObject(PublishedUtf8.decode(raw))
        val body=mapOf("snapshotSHA256" to snapshot,"validationEpoch" to epoch,"catalogSHA256" to catalogSHA)
        require(ClientProtocols.hasValidHeader(value,activationFamily)&&
            value.keys().asSequence().toSet()==ClientProtocols.recordKeys(value.get("contract"),activationFamily,body.keys,value.opt("schemaFingerprint") as? String)&&
            body.all{(key,expected)->value.opt(key)==expected}){"汇总激活代与原清单不一致"}
    }
    fun stage(rawManifest:ByteArray,validationEpoch:String,check:()->Unit={}):PublishedAggregateCatalog {
        val identity=epoch(validationEpoch)
        val catalog=PublishedAggregateReader.read(rawManifest,check){read(child("index","${it.sha256}.json"),it.bytes)}
        check();immutable(child("aggregate-manifests","${catalog.snapshotSHA256}.json"),rawManifest)
        check();val sidecar=child("aggregate-index","${catalog.snapshotSHA256}.json")
        if(!sidecar.exists())immutable(sidecar,catalogRecord(catalog))
        val actual=catalogRecord(catalog,read(sidecar,8*1024*1024))
        val marker=child("aggregate-activations",catalog.snapshotSHA256,"$identity.json")
        val actualSHA=PublishedAggregateReader.sha(actual)
        check()
        if(marker.exists()) checkActivation(read(marker,4096),catalog.snapshotSHA256,identity,actualSHA)
        else {
            val activation=ClientProtocols.record(activationFamily).put("snapshotSHA256",catalog.snapshotSHA256).put("validationEpoch",identity).put("catalogSHA256",actualSHA)
            immutable(marker,OfflineFoundationJSON.encode(activation))
        }
        return catalog
    }
    fun load(activeSnapshotSHA256:String,validationEpoch:String?,check:()->Unit={}):PublishedAggregateCatalog? {
        if(!PublishedAggregateReader.validSHA(activeSnapshotSHA256)||validationEpoch==null)return null
        val identity=runCatching{epoch(validationEpoch)}.getOrNull()?:return null
        val manifest=child("aggregate-manifests","$activeSnapshotSHA256.json");val sidecar=child("aggregate-index","$activeSnapshotSHA256.json");val marker=child("aggregate-activations",activeSnapshotSHA256,"$identity.json")
        if(!manifest.exists()||!sidecar.exists()||!marker.exists())return null
        val catalog=sourceCatalog(activeSnapshotSHA256,check)
        val actual=catalogRecord(catalog,sourceBytes(sidecar,8*1024*1024))
        checkActivation(sourceBytes(marker,4096),activeSnapshotSHA256,identity,PublishedAggregateReader.sha(actual))
        return catalog
    }
    private fun sourceCatalog(snapshot:String,check:()->Unit={}):PublishedAggregateCatalog {
        require(PublishedAggregateReader.validSHA(snapshot));check()
        ownedSourceReadScope()?.catalogs?.get(snapshot)?.let{saved->return saved.catalog}
        val raw=sourceBytes(child("aggregate-manifests","$snapshot.json"),2*1024*1024);require(PublishedAggregateReader.sha(raw)==snapshot)
        val catalog=PublishedAggregateReader.read(raw,check){sourceBytes(child("index","${it.sha256}.json"),it.bytes)}
        ownedSourceReadScope()?.catalogs?.put(snapshot,ParsedSource(catalog,PublishedAggregateReader.sha(OfflineFoundationJSON.encode(catalog.json()))))
        return catalog
    }
    fun originalRow(descriptor:PublishedAggregate):ByteArray {
        require(sourceCatalog(descriptor.source.manifestSHA256).records.contains(descriptor)){"汇总原目录身份未核验"}
        val raw=read(child("index","${descriptor.source.shardSHA256}.json"),descriptor.source.shardBytes);require(PublishedAggregateReader.sha(raw)==descriptor.source.shardSHA256)
        val rows=JSONArray(PublishedUtf8.decode(raw));require(descriptor.source.rowIndex in 0 until rows.length())
        return PublishedAggregateReader.normalizedRow(rows.getJSONObject(descriptor.source.rowIndex)).also{require(PublishedAggregateReader.sha(it)==descriptor.source.normalizedRowSHA256)}
    }
    /** Platform-specific derivation namespace preserves any restored Mac rendering instead of replacing it. */
    fun cacheDocument(raw:ByteArray,descriptor:PublishedAggregate,responseURL:String,fetchedAt:String):JSONObject {
        originalRow(descriptor);val document=AggregateHtml.parse(raw,descriptor,responseURL,fetchedAt);val encoded=OfflineFoundationJSON.encode(document);require(encoded.size<=20*1024*1024)
        val prefix=arrayOf("aggregate-documents-android",PublishedAggregateReader.sha(descriptor.id.toByteArray()),descriptor.source.manifestSHA256,document.getString("rawHTMLSHA256"))
        immutable(child(*prefix,"original.html"),raw);immutable(child(*prefix,"body.html"),document.getString("bodyHTML").toByteArray())
        if(child(*prefix,"document.json").exists())return cachedDocument(descriptor,document.getString("rawHTMLSHA256"))
        immutable(child(*prefix,"document.json"),encoded)
        return document
    }
    /** Every revision in this exact Android+descriptor+manifest scope is cold-verified. A damaged peer is never skipped. */
    fun cachedRevisions(descriptor:PublishedAggregate):List<AggregateCachedRevision> {
        val native=nativeRevisions(descriptor);val rows=linkedMapOf<String,AggregateCachedRevision>()
        native.forEach{rows[it.rawHTMLSHA256]=it};macRevisions(descriptor).forEach{rows.putIfAbsent(it.rawHTMLSHA256,it)}
        return rows.values.sortedWith(compareByDescending<AggregateCachedRevision>{java.time.Instant.parse(it.fetchedAt)}.thenBy{it.rawHTMLSHA256})
    }
    private fun nativeRevisions(descriptor:PublishedAggregate):List<AggregateCachedRevision> {
        originalRow(descriptor)
        val root=child("aggregate-documents-android",PublishedAggregateReader.sha(descriptor.id.toByteArray()),descriptor.source.manifestSHA256)
        if(!Files.exists(root.toPath(),NOFOLLOW_LINKS))return emptyList()
        noLinks(root);val before=attrs(root);require(before.isDirectory&&before.fileKey()!=null){"汇总修订目录无效"}
        val paths=Files.newDirectoryStream(root.toPath()).use{stream->stream.toList().sortedBy{it.fileName.toString()}}
        val revisions=paths.map{path->
            val name=path.fileName.toString();require(PublishedAggregateReader.validSHA(name)){"汇总修订目录含未知项，未挑选其他旧稿"}
            val folder=child("aggregate-documents-android",PublishedAggregateReader.sha(descriptor.id.toByteArray()),descriptor.source.manifestSHA256,name)
            val stat=attrs(folder);require(stat.isDirectory&&!stat.isSymbolicLink&&stat.fileKey()!=null)
            val document=cachedDocument(descriptor,name);require(document.getString("rawHTMLSHA256")==name)
            val date=document.getString("fetchedAt");java.time.Instant.parse(date)
            AggregateCachedRevision(name,date)
        }
        noLinks(root);val after=attrs(root);require(before.fileKey()==after.fileKey()&&before.lastModifiedTime()==after.lastModifiedTime()){"保存修订清单读取期间已变化，请重新核验"}
        return revisions.sortedWith(compareByDescending<AggregateCachedRevision>{java.time.Instant.parse(it.fetchedAt)}.thenBy{it.rawHTMLSHA256})
    }
    fun cachedDocument(descriptor:PublishedAggregate,rawHTMLSHA256:String):JSONObject {
        originalRow(descriptor);require(PublishedAggregateReader.validSHA(rawHTMLSHA256))
        val prefix=arrayOf("aggregate-documents-android",PublishedAggregateReader.sha(descriptor.id.toByteArray()),descriptor.source.manifestSHA256,rawHTMLSHA256)
        if(!Files.exists(child(*prefix).toPath(),NOFOLLOW_LINKS))return importMacDocument(descriptor,rawHTMLSHA256)
        val raw=read(child(*prefix,"original.html"),16*1024*1024);require(PublishedAggregateReader.sha(raw)==rawHTMLSHA256)
        val saved=JSONObject(PublishedUtf8.decode(read(child(*prefix,"document.json"),20*1024*1024)))
        require(canonical(saved.getJSONObject("descriptor"))==canonical(descriptor.json()))
        val actual=AggregateHtml.parse(raw,descriptor,saved.getString("responseURL"),saved.getString("fetchedAt"),saved)
        require(canonical(saved)==canonical(actual)&&read(child(*prefix,"body.html"),16*1024*1024).contentEquals(actual.getString("bodyHTML").toByteArray()))
        return actual
    }
    /** Image bytes are immutable SHA blobs shared across platform derivation namespaces. */
    fun cacheImageBlob(bytes:ByteArray):AggregateImageBlob {
        require(bytes.size in 1..AggregateImages.MAX_IMAGE_BYTES)
        val mime=AggregateImages.rasterMIME(bytes.copyOfRange(0,minOf(16,bytes.size)));val sha=PublishedAggregateReader.sha(bytes)
        immutable(child(AggregateImages.blobDirectory(false),sha),bytes)
        return AggregateImageBlob(sha,mime,bytes.size)
    }
    fun imagePlan(descriptor:PublishedAggregate,rawHTMLSHA256:String):AggregateImagePlan {
        require(PublishedAggregateReader.validSHA(rawHTMLSHA256))
        val key=canonical(descriptor.json())+"|"+rawHTMLSHA256
        ownedSourceReadScope()?.plans?.get(key)?.let{return it.plan}
        val source=cachedDocument(descriptor,rawHTMLSHA256)
        val raw=read(child("aggregate-documents-android",PublishedAggregateReader.sha(descriptor.id.toByteArray()),descriptor.source.manifestSHA256,rawHTMLSHA256,"original.html"),16*1024*1024)
        val plan=AggregateHtml.imagePlan(raw,descriptor,source.getString("responseURL"),source.getString("fetchedAt")).also{require(it.originalBodySHA256==source.getString("sanitizedBodySHA256"))}
        ownedSourceReadScope()?.plans?.put(key,ParsedImagePlan(plan,canonical(plan.json())))
        return plan
    }

    private fun imageFolder(descriptor:PublishedAggregate,raw:String,platform:String="android",legacy:Boolean=false):Array<String> {
        require(PublishedAggregateReader.validSHA(raw))
        return arrayOf(AggregateImages.directory(platform,legacy),PublishedAggregateReader.sha(descriptor.id.toByteArray()),descriptor.source.manifestSHA256,raw,AggregateImages.folderContract(legacy))
    }
    private fun imageLocations(descriptor:PublishedAggregate,raw:String,platform:String="android")=
        listOf(false,true).map{legacy->legacy to child(*imageFolder(descriptor,raw,platform,legacy))}
    private fun sameSavedPlan(plan:AggregateImagePlan,saved:JSONObject):Boolean {
        val expected=JSONObject(canonicalImagePlan(plan))
        expected.remove("contract");expected.remove("schemaFingerprint")
        val original=ClientProtocols.recordHeader(saved.get("contract"),AggregateImages.PLAN,saved.opt("schemaFingerprint") as? String)
        expected.keys().forEach{key->original.put(key,expected.get(key))}
        return canonical(saved)==canonical(original)
    }
    /** Hash/type/length verification and delivery share one opened handle; no large image ByteArray is retained. */
    private fun openVerifiedImage(record:AggregateImageRecord,legacy:Boolean):java.io.InputStream {
        val sha=requireNotNull(record.sha256);require(PublishedAggregateReader.validSHA(sha));val size=requireNotNull(record.bytes);require(size in 1..AggregateImages.MAX_IMAGE_BYTES)
        val file=child(AggregateImages.blobDirectory(legacy),sha);val before=attrs(file)
        require(before.isRegularFile&&before.fileKey()!=null&&before.size()==size.toLong()){"图片实际长度与清单不一致"}
        val channel=FileChannel.open(file.toPath(),READ,NOFOLLOW_LINKS)
        try {
            val digest=java.security.MessageDigest.getInstance("SHA-256");val buffer=ByteBuffer.allocate(65536);val header=ByteArray(minOf(16,size));var headerCount=0;var count=0
            while(count<size){buffer.clear();buffer.limit(minOf(buffer.capacity(),size-count));val n=channel.read(buffer);require(n>0);digest.update(buffer.array(),0,n);if(headerCount<header.size){val take=minOf(n,header.size-headerCount);buffer.array().copyInto(header,headerCount,0,take);headerCount+=take};count+=n}
            require(channel.read(ByteBuffer.allocate(1))==-1&&digest.digest().joinToString(""){"%02x".format(it.toInt()and 255)}==sha&&AggregateImages.rasterMIME(header)==record.mime){"图片真实字节或类型身份不一致"}
            noLinks(file);val after=attrs(file);require(before.fileKey()==after.fileKey()&&before.size()==after.size()&&before.lastModifiedTime()==after.lastModifiedTime())
            ownedSourceReadScope()?.let{scope->
                val proof=SourceFile(file,AggregateImages.MAX_IMAGE_BYTES,sha);val prior=scope.files.putIfAbsent(file.absolutePath,proof)
                require(prior==null||prior.sha256==sha){"读取期间图片原字节变化"}
            }
            channel.position(0)
            return object:java.io.FilterInputStream(java.nio.channels.Channels.newInputStream(channel)){
                private var remaining=size
                override fun read():Int{if(remaining==0)return -1;val value=super.read();require(value>=0);remaining--;return value}
                override fun read(bytes:ByteArray,offset:Int,length:Int):Int{if(length==0)return 0;if(remaining==0)return -1;val n=super.read(bytes,offset,minOf(length,remaining));require(n>0);remaining-=n;return n}
                override fun skip(n:Long):Long{if(n<=0)return 0;val amount=super.skip(minOf(n,remaining.toLong()));remaining-=amount.toInt();return amount}
                override fun available()=minOf(super.available(),remaining)
                override fun markSupported()=false
            }
        }catch(error:Throwable){channel.close();throw error}
    }
    internal fun cacheImageRendering(plan:AggregateImagePlan,records:List<AggregateImageRecord>,observedAt:String,origin:AggregateImageImport?=null):AggregateImageAccess {
        require(canonical(imagePlan(plan.descriptor,plan.rawHTMLSHA256).json())==canonical(plan.json())){"图片位置或原来源已变化"}
        require(records.map{it.slot}==plan.slots);AggregateImages.validateReferenceBudget(records)
        records.filter{it.sha256!=null}.distinctBy{it.sha256}.forEach{record->
            val sha=requireNotNull(record.sha256)
            if(!Files.exists(child(AggregateImages.blobDirectory(false),sha).toPath(),NOFOLLOW_LINKS)) {
                // A current observation carries its own verified blob; copy
                // one bounded old image only after checking its original file.
                val size=requireNotNull(record.bytes)
                val original=openVerifiedImage(record,true).use{stream->
                    ByteArray(size).also{buffer->
                        var offset=0
                        while(offset<size){val count=stream.read(buffer,offset,size-offset);require(count>0);offset+=count}
                        require(stream.read()==-1)
                    }
                }
                require(cacheImageBlob(original).sha256==sha)
            }
        }
        records.filter{it.sha256!=null}.forEach{openVerifiedImage(it,false).close()}
        val manifest=AggregateImages.manifest(plan,records,observedAt,origin);val bytes=OfflineFoundationJSON.encode(manifest);require(bytes.size<=4*1024*1024)
        val sha=PublishedAggregateReader.sha(bytes);immutable(child(*imageFolder(plan.descriptor,plan.rawHTMLSHA256),"$sha.json"),bytes)
        return cachedImageRendering(plan.descriptor,plan.rawHTMLSHA256,sha)
    }
    internal fun cachedImageRendering(descriptor:PublishedAggregate,rawHTMLSHA256:String,manifestSHA256:String):AggregateImageAccess {
        val plan=imagePlan(descriptor,rawHTMLSHA256);require(PublishedAggregateReader.validSHA(manifestSHA256))
        val (legacy,file)=imageLocations(descriptor,rawHTMLSHA256).map{(legacy,_)->legacy to child(*imageFolder(descriptor,rawHTMLSHA256,legacy=legacy),"$manifestSHA256.json")}
            .filter{Files.exists(it.second.toPath(),NOFOLLOW_LINKS)}.single()
        val bytes=read(file,4*1024*1024);require(PublishedAggregateReader.sha(bytes)==manifestSHA256)
        val manifest=JSONObject(PublishedUtf8.decode(bytes));val originalPlan=AggregateImages.verifyManifestHeader(manifest,"android",legacy)
        require(manifest.get("completeOffline")==false&&sameSavedPlan(plan,originalPlan))
        java.time.Instant.parse(manifest.getString("observedAt"))
        // Declared per-reference budget is validated before any blob; every physical blob is then checked immediately.
        val records=AggregateImages.records(plan,manifest.getJSONArray("images"))
        records.filter{it.sha256!=null}.forEach{openVerifiedImage(it,legacy).close()}
        require(renderedImageBodySHA(plan,records)==manifest.getString("renderedBodySHA256"))
        val origin=manifest.optJSONObject("importedFrom")?.let{AggregateImageImport(it.getString("platform"),it.getString("manifestSHA256"))}
        return AggregateImageAccess(manifestSHA256,plan,records,manifest.getString("observedAt"),{openVerifiedImage(it,legacy)},origin)
    }
    internal fun latestImageRendering(descriptor:PublishedAggregate,rawHTMLSHA256:String):AggregateImageAccess? {
        val locations=imageLocations(descriptor,rawHTMLSHA256).filter{Files.exists(it.second.toPath(),NOFOLLOW_LINKS)}
        if(locations.isEmpty())return null
        imagePlan(descriptor,rawHTMLSHA256)
        var latest:AggregateImageAccess?=null
        for((_,folder) in locations){
            noLinks(folder);val before=attrs(folder);require(before.isDirectory&&before.fileKey()!=null)
            val files=Files.newDirectoryStream(folder.toPath()).use{it.toList().sortedBy{p->p.fileName.toString()}}
            for(file in files){val name=file.fileName.toString();require(name.endsWith(".json")&&PublishedAggregateReader.validSHA(name.removeSuffix(".json"))){"图片修订目录含未知项，未改用其他修订"}
                val value=cachedImageRendering(descriptor,rawHTMLSHA256,name.removeSuffix(".json"))
                if(latest==null||java.time.Instant.parse(value.observedAt)>java.time.Instant.parse(latest.observedAt))latest=value
            }
            noLinks(folder);val after=attrs(folder);require(before.fileKey()==after.fileKey()&&before.lastModifiedTime()==after.lastModifiedTime())
        }
        return latest
    }

    /** Foreign derived bodies are evidence only; authoritative display always replays this platform's raw parser. */
    private fun macSource(descriptor:PublishedAggregate,raw:String):Pair<ByteArray,JSONObject> {
        require(PublishedAggregateReader.validSHA(raw))
        val prefix=arrayOf("aggregate-documents",PublishedAggregateReader.sha(descriptor.id.toByteArray()),descriptor.source.manifestSHA256,raw)
        val bytes=read(child(*prefix,"original.html"),16*1024*1024);require(PublishedAggregateReader.sha(bytes)==raw)
        val saved=JSONObject(PublishedUtf8.decode(read(child(*prefix,"document.json"),20*1024*1024)))
        AggregateDocumentFormat.replay(saved,AggregateDocumentFormat.Platform.MACOS)
        require(canonical(saved.getJSONObject("descriptor"))==canonical(descriptor.json())&&saved.getString("rawHTMLSHA256")==raw&&saved.getInt("rawHTMLBytes")==bytes.size&&saved.getString("responseURL")==descriptor.sourceURL){"Mac原网页来源或格式不受支持，原件保留"}
        val body=read(child(*prefix,"body.html"),16*1024*1024)
        require(body.contentEquals(saved.getString("bodyHTML").toByteArray())&&PublishedAggregateReader.sha(body)==saved.getString("sanitizedBodySHA256")){"Mac原网页派生见证未通过核验"}
        // Also require this raw HTML to pass the unchanged native parser; never display foreign bodyHTML.
        AggregateHtml.parse(bytes,descriptor,saved.getString("responseURL"),saved.getString("fetchedAt"))
        return bytes to saved
    }
    private fun macRevisions(descriptor:PublishedAggregate):List<AggregateCachedRevision> {
        val root=child("aggregate-documents",PublishedAggregateReader.sha(descriptor.id.toByteArray()),descriptor.source.manifestSHA256)
        if(!Files.exists(root.toPath(),NOFOLLOW_LINKS))return emptyList()
        noLinks(root);val before=attrs(root);require(before.isDirectory&&before.fileKey()!=null)
        val names=Files.newDirectoryStream(root.toPath()).use{it.toList().map{p->p.fileName.toString()}.sorted()}
        val rows=names.map{raw->require(PublishedAggregateReader.validSHA(raw)){"Mac保存修订目录格式未知，原件保留"};val saved=macSource(descriptor,raw).second;java.time.Instant.parse(saved.getString("fetchedAt"));AggregateCachedRevision(raw,saved.getString("fetchedAt"))}
        noLinks(root);val after=attrs(root);require(before.fileKey()==after.fileKey()&&before.lastModifiedTime()==after.lastModifiedTime());return rows
    }
    private fun importMacDocument(descriptor:PublishedAggregate,raw:String):JSONObject {
        val source=macSource(descriptor,raw)
        return cacheDocument(source.first,descriptor,source.second.getString("responseURL"),source.second.getString("fetchedAt"))
    }
    internal fun importMacImageRendering(descriptor:PublishedAggregate,raw:String):AggregateImageAccess? {
        require(PublishedAggregateReader.validSHA(raw))
        val locations=imageLocations(descriptor,raw,"macos").filter{Files.exists(it.second.toPath(),NOFOLLOW_LINKS)}
        if(locations.isEmpty())return null
        val plan=imagePlan(descriptor,raw)
        val foreignSource=macSource(descriptor,raw).second
        var selectedRecords:List<AggregateImageRecord>?=null;var selectedSHA:String?=null;var selectedTime:String?=null
        val seen=mutableSetOf<String>()
        for((legacy,folder) in locations){
            noLinks(folder);val before=attrs(folder);require(before.isDirectory&&before.fileKey()!=null)
            val names=Files.newDirectoryStream(folder.toPath()).use{it.toList().map{p->p.fileName.toString()}.sorted()}
            for(name in names){
            require(name.endsWith(".json")&&PublishedAggregateReader.validSHA(name.removeSuffix(".json"))){"Mac图片修订目录格式未知，原件保留"}
            val sha=name.removeSuffix(".json");val bytes=read(File(folder,name),4*1024*1024);require(PublishedAggregateReader.sha(bytes)==sha&&seen.add(sha))
            val saved=JSONObject(PublishedUtf8.decode(bytes));val foreignPlan=AggregateImages.verifyManifestHeader(saved,"macos",legacy)
            require(saved.get("completeOffline")==false&&canonical(foreignPlan.getJSONObject("descriptor"))==canonical(descriptor.json())&&foreignPlan.getString("rawHTMLSHA256")==raw&&foreignPlan.getString("originalBodySHA256")==foreignSource.getString("sanitizedBodySHA256")&&PublishedAggregateReader.sha(foreignPlan.getString("templateBodyHTML").toByteArray())==foreignPlan.getString("templateBodySHA256")){"Mac图片来源见证未通过核验"}
            require(canonical(foreignPlan.getJSONArray("slots"))==canonical(JSONArray(plan.slots.map{it.json()}))){"两端图片位置或图注不同，未把其他派生图片接到本端正文"}
            val records=AggregateImages.records(plan,saved.getJSONArray("images"));records.filter{it.sha256!=null}.forEach{openVerifiedImage(it,legacy).close()}
            val time=saved.getString("observedAt");java.time.Instant.parse(time)
            if(selectedTime==null||java.time.Instant.parse(time)>java.time.Instant.parse(selectedTime)){selectedRecords=records;selectedSHA=sha;selectedTime=time}
            }
            noLinks(folder);val after=attrs(folder);require(before.fileKey()==after.fileKey()&&before.lastModifiedTime()==after.lastModifiedTime())
        }
        if(selectedRecords==null)return null
        // The foreign body/renderedBodySHA is never reused: this creates a separate native derivation.
        return cacheImageRendering(plan,selectedRecords,requireNotNull(selectedTime),AggregateImageImport("macos",requireNotNull(selectedSHA)))
    }

}
