package com.nanless.paperdigest.data

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
    companion object {private val immutablePublishLock=Any()}
    private fun noLinks(file:File){var path:File?=file.absoluteFile;while(path!=null){require(!Files.isSymbolicLink(path.toPath())){"汇总缓存不能含链接"};path=path.parentFile}}
    private fun child(vararg names:String):File {var result=directory;noLinks(result);for(name in names){require(name.isNotEmpty()&&name!="."&&name!=".."&&!name.contains('/')&&!name.contains('\\'));result=File(result,name);noLinks(result)};return result}
    private fun attrs(file:File)=Files.readAttributes(file.toPath(),BasicFileAttributes::class.java,NOFOLLOW_LINKS)
    private fun read(file:File,limit:Int):ByteArray {
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
                        require(read(temporary,maxOf(1,bytes.size)).contentEquals(bytes))
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
    fun stage(rawManifest:ByteArray,validationEpoch:String,check:()->Unit={}):PublishedAggregateCatalog {
        val identity=epoch(validationEpoch)
        val catalog=PublishedAggregateReader.read(rawManifest,check){read(child("index","${it.sha256}.json"),it.bytes)}
        check();immutable(child("aggregate-manifests","${catalog.snapshotSHA256}.json"),rawManifest)
        check();val sidecar=child("aggregate-index","${catalog.snapshotSHA256}.json")
        if(sidecar.exists())require(canonical(JSONObject(PublishedUtf8.decode(read(sidecar,8*1024*1024))))==canonical(catalog.json())) else immutable(sidecar,OfflineFoundationJSON.encode(catalog.json()))
        val actual=read(sidecar,8*1024*1024)
        val activation=JSONObject().put("contract","published-aggregate-activation-v1").put("snapshotSHA256",catalog.snapshotSHA256).put("validationEpoch",identity).put("catalogSHA256",PublishedAggregateReader.sha(actual))
        check();immutable(child("aggregate-activations",catalog.snapshotSHA256,"$identity.json"),OfflineFoundationJSON.encode(activation))
        return catalog
    }
    fun load(activeSnapshotSHA256:String,validationEpoch:String?,check:()->Unit={}):PublishedAggregateCatalog? {
        if(!PublishedAggregateReader.validSHA(activeSnapshotSHA256)||validationEpoch==null)return null
        val identity=runCatching{epoch(validationEpoch)}.getOrNull()?:return null
        val manifest=child("aggregate-manifests","$activeSnapshotSHA256.json");val sidecar=child("aggregate-index","$activeSnapshotSHA256.json");val marker=child("aggregate-activations",activeSnapshotSHA256,"$identity.json")
        if(!manifest.exists()||!sidecar.exists()||!marker.exists())return null
        val raw=read(manifest,2*1024*1024);require(PublishedAggregateReader.sha(raw)==activeSnapshotSHA256)
        val catalog=PublishedAggregateReader.read(raw,check){read(child("index","${it.sha256}.json"),it.bytes)}
        val actual=read(sidecar,8*1024*1024);val activation=JSONObject(PublishedUtf8.decode(read(marker,4096)))
        require(canonical(JSONObject(PublishedUtf8.decode(actual)))==canonical(catalog.json())&&activation.getString("contract")=="published-aggregate-activation-v1"&&activation.getString("snapshotSHA256")==activeSnapshotSHA256&&activation.getString("validationEpoch")==identity&&activation.getString("catalogSHA256")==PublishedAggregateReader.sha(actual)){"汇总sidecar/激活代与原清单不一致"}
        return catalog
    }
    private fun sourceCatalog(snapshot:String):PublishedAggregateCatalog {
        require(PublishedAggregateReader.validSHA(snapshot));val raw=read(child("aggregate-manifests","$snapshot.json"),2*1024*1024);require(PublishedAggregateReader.sha(raw)==snapshot)
        return PublishedAggregateReader.read(raw){read(child("index","${it.sha256}.json"),it.bytes)}
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
        val actual=AggregateHtml.parse(raw,descriptor,saved.getString("responseURL"),saved.getString("fetchedAt"))
        require(canonical(saved)==canonical(actual)&&read(child(*prefix,"body.html"),16*1024*1024).contentEquals(actual.getString("bodyHTML").toByteArray()))
        return actual
    }
    /** Image bytes are immutable SHA blobs shared across platform derivation namespaces. */
    fun cacheImageBlob(bytes:ByteArray):AggregateImageBlob {
        require(bytes.size in 1..AggregateImages.MAX_IMAGE_BYTES)
        val mime=AggregateImages.rasterMIME(bytes.copyOfRange(0,minOf(16,bytes.size)));val sha=PublishedAggregateReader.sha(bytes)
        immutable(child("aggregate-image-bytes-v1",sha),bytes)
        return AggregateImageBlob(sha,mime,bytes.size)
    }
    fun imagePlan(descriptor:PublishedAggregate,rawHTMLSHA256:String):AggregateImagePlan {
        val source=cachedDocument(descriptor,rawHTMLSHA256)
        val raw=read(child("aggregate-documents-android",PublishedAggregateReader.sha(descriptor.id.toByteArray()),descriptor.source.manifestSHA256,rawHTMLSHA256,"original.html"),16*1024*1024)
        return AggregateHtml.imagePlan(raw,descriptor,source.getString("responseURL"),source.getString("fetchedAt")).also{require(it.originalBodySHA256==source.getString("sanitizedBodySHA256"))}
    }
    private fun imageFolder(descriptor:PublishedAggregate,raw:String):Array<String> {
        require(PublishedAggregateReader.validSHA(raw))
        return arrayOf(AggregateImages.DIRECTORY,PublishedAggregateReader.sha(descriptor.id.toByteArray()),descriptor.source.manifestSHA256,raw,AggregateImages.CONTRACT)
    }
    /** Hash/type/length verification and delivery share one opened handle; no large image ByteArray is retained. */
    private fun openVerifiedImage(record:AggregateImageRecord):java.io.InputStream {
        val sha=requireNotNull(record.sha256);require(PublishedAggregateReader.validSHA(sha));val size=requireNotNull(record.bytes);require(size in 1..AggregateImages.MAX_IMAGE_BYTES)
        val file=child("aggregate-image-bytes-v1",sha);val before=attrs(file)
        require(before.isRegularFile&&before.fileKey()!=null&&before.size()==size.toLong()){"图片实际长度与清单不一致"}
        val channel=FileChannel.open(file.toPath(),READ,NOFOLLOW_LINKS)
        try {
            val digest=java.security.MessageDigest.getInstance("SHA-256");val buffer=ByteBuffer.allocate(65536);val header=ByteArray(minOf(16,size));var headerCount=0;var count=0
            while(count<size){buffer.clear();buffer.limit(minOf(buffer.capacity(),size-count));val n=channel.read(buffer);require(n>0);digest.update(buffer.array(),0,n);if(headerCount<header.size){val take=minOf(n,header.size-headerCount);buffer.array().copyInto(header,headerCount,0,take);headerCount+=take};count+=n}
            require(channel.read(ByteBuffer.allocate(1))==-1&&digest.digest().joinToString(""){"%02x".format(it.toInt()and 255)}==sha&&AggregateImages.rasterMIME(header)==record.mime){"图片真实字节或类型身份不一致"}
            noLinks(file);val after=attrs(file);require(before.fileKey()==after.fileKey()&&before.size()==after.size()&&before.lastModifiedTime()==after.lastModifiedTime())
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
        records.filter{it.sha256!=null}.forEach{openVerifiedImage(it).close()}
        val manifest=AggregateImages.manifest(plan,records,observedAt,origin);val bytes=OfflineFoundationJSON.encode(manifest);require(bytes.size<=4*1024*1024)
        val sha=PublishedAggregateReader.sha(bytes);immutable(child(*imageFolder(plan.descriptor,plan.rawHTMLSHA256),"$sha.json"),bytes)
        return cachedImageRendering(plan.descriptor,plan.rawHTMLSHA256,sha)
    }
    internal fun cachedImageRendering(descriptor:PublishedAggregate,rawHTMLSHA256:String,manifestSHA256:String):AggregateImageAccess {
        val plan=imagePlan(descriptor,rawHTMLSHA256);require(PublishedAggregateReader.validSHA(manifestSHA256))
        val bytes=read(child(*imageFolder(descriptor,rawHTMLSHA256),"$manifestSHA256.json"),4*1024*1024);require(PublishedAggregateReader.sha(bytes)==manifestSHA256)
        val manifest=JSONObject(PublishedUtf8.decode(bytes));require(manifest.getString("contract")==AggregateImages.CONTRACT&&manifest.getString("parserContract")=="published-aggregate-jsoup-images-v1"&&manifest.get("completeOffline")==false&&canonical(manifest.getJSONObject("plan"))==canonical(plan.json()))
        java.time.Instant.parse(manifest.getString("observedAt"))
        // Declared per-reference budget is validated before any blob; every physical blob is then checked immediately.
        val records=AggregateImages.records(plan,manifest.getJSONArray("images"))
        records.filter{it.sha256!=null}.forEach{openVerifiedImage(it).close()}
        require(PublishedAggregateReader.sha(AggregateImages.render(plan,records).toByteArray())==manifest.getString("renderedBodySHA256"))
        val origin=manifest.optJSONObject("importedFrom")?.let{AggregateImageImport(it.getString("platform"),it.getString("manifestSHA256"))}
        return AggregateImageAccess(manifestSHA256,plan,records,manifest.getString("observedAt"),::openVerifiedImage,origin)
    }
    internal fun latestImageRendering(descriptor:PublishedAggregate,rawHTMLSHA256:String):AggregateImageAccess? {
        imagePlan(descriptor,rawHTMLSHA256);val folder=child(*imageFolder(descriptor,rawHTMLSHA256))
        if(!Files.exists(folder.toPath(),NOFOLLOW_LINKS))return null
        noLinks(folder);val before=attrs(folder);require(before.isDirectory&&before.fileKey()!=null)
        val files=Files.newDirectoryStream(folder.toPath()).use{it.toList().sortedBy{p->p.fileName.toString()}}
        var latest:AggregateImageAccess?=null
        for(file in files){val name=file.fileName.toString();require(name.endsWith(".json")&&PublishedAggregateReader.validSHA(name.removeSuffix(".json"))){"图片修订目录含未知项，未改用其他修订"}
            val value=cachedImageRendering(descriptor,rawHTMLSHA256,name.removeSuffix(".json"))
            if(latest==null||java.time.Instant.parse(value.observedAt)>java.time.Instant.parse(latest.observedAt))latest=value
        }
        noLinks(folder);val after=attrs(folder);require(before.fileKey()==after.fileKey()&&before.lastModifiedTime()==after.lastModifiedTime());return latest
    }

    /** Foreign derived bodies are evidence only; authoritative display always replays this platform's raw parser. */
    private fun macSource(descriptor:PublishedAggregate,raw:String):Pair<ByteArray,JSONObject> {
        require(PublishedAggregateReader.validSHA(raw))
        val prefix=arrayOf("aggregate-documents",PublishedAggregateReader.sha(descriptor.id.toByteArray()),descriptor.source.manifestSHA256,raw)
        val bytes=read(child(*prefix,"original.html"),16*1024*1024);require(PublishedAggregateReader.sha(bytes)==raw)
        val saved=JSONObject(PublishedUtf8.decode(read(child(*prefix,"document.json"),20*1024*1024)))
        require(saved.getString("contract")=="published-aggregate-document-v1"&&saved.getString("parserContract")=="published-aggregate-html-v1"&&canonical(saved.getJSONObject("descriptor"))==canonical(descriptor.json())&&saved.getString("rawHTMLSHA256")==raw&&saved.getInt("rawHTMLBytes")==bytes.size&&saved.getString("responseURL")==descriptor.sourceURL){"Mac原网页来源或格式不受支持，原件保留"}
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
        val plan=imagePlan(descriptor,raw)
        val folder=child("aggregate-resource-renders-macos-v1",PublishedAggregateReader.sha(descriptor.id.toByteArray()),descriptor.source.manifestSHA256,raw,AggregateImages.CONTRACT)
        if(!Files.exists(folder.toPath(),NOFOLLOW_LINKS))return null
        val foreignSource=macSource(descriptor,raw).second
        noLinks(folder);val before=attrs(folder);require(before.isDirectory&&before.fileKey()!=null)
        val names=Files.newDirectoryStream(folder.toPath()).use{it.toList().map{p->p.fileName.toString()}.sorted()}
        var selectedRecords:List<AggregateImageRecord>?=null;var selectedSHA:String?=null;var selectedTime:String?=null
        for(name in names){
            require(name.endsWith(".json")&&PublishedAggregateReader.validSHA(name.removeSuffix(".json"))){"Mac图片修订目录格式未知，原件保留"}
            val sha=name.removeSuffix(".json");val bytes=read(File(folder,name),4*1024*1024);require(PublishedAggregateReader.sha(bytes)==sha)
            val saved=JSONObject(PublishedUtf8.decode(bytes));val foreignPlan=saved.getJSONObject("plan")
            require(saved.getString("contract")==AggregateImages.CONTRACT&&saved.get("completeOffline")==false&&foreignPlan.getString("contract")==AggregateImages.CONTRACT&&canonical(foreignPlan.getJSONObject("descriptor"))==canonical(descriptor.json())&&foreignPlan.getString("rawHTMLSHA256")==raw&&foreignPlan.getString("originalBodySHA256")==foreignSource.getString("sanitizedBodySHA256")&&PublishedAggregateReader.sha(foreignPlan.getString("templateBodyHTML").toByteArray())==foreignPlan.getString("templateBodySHA256")){"Mac图片来源见证未通过核验"}
            require(canonical(foreignPlan.getJSONArray("slots"))==canonical(JSONArray(plan.slots.map{it.json()}))){"两端图片位置或图注不同，未把其他派生图片接到本端正文"}
            val records=AggregateImages.records(plan,saved.getJSONArray("images"));records.filter{it.sha256!=null}.forEach{openVerifiedImage(it).close()}
            val time=saved.getString("observedAt");java.time.Instant.parse(time)
            if(selectedTime==null||java.time.Instant.parse(time)>java.time.Instant.parse(selectedTime)){selectedRecords=records;selectedSHA=sha;selectedTime=time}
        }
        noLinks(folder);val after=attrs(folder);require(before.fileKey()==after.fileKey()&&before.lastModifiedTime()==after.lastModifiedTime())
        if(selectedRecords==null)return null
        // The foreign body/renderedBodySHA is never reused: this creates a separate native derivation.
        return cacheImageRendering(plan,selectedRecords,requireNotNull(selectedTime),AggregateImageImport("macos",requireNotNull(selectedSHA)))
    }

}
