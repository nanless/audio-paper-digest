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
        val raw=read(child(*prefix,"original.html"),16*1024*1024);require(PublishedAggregateReader.sha(raw)==rawHTMLSHA256)
        val saved=JSONObject(PublishedUtf8.decode(read(child(*prefix,"document.json"),20*1024*1024)))
        require(canonical(saved.getJSONObject("descriptor"))==canonical(descriptor.json()))
        val actual=AggregateHtml.parse(raw,descriptor,saved.getString("responseURL"),saved.getString("fetchedAt"))
        require(canonical(saved)==canonical(actual)&&read(child(*prefix,"body.html"),16*1024*1024).contentEquals(actual.getString("bodyHTML").toByteArray()))
        return actual
    }
}
