package com.nanless.paperdigest.zotero.webdav

import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.channels.Channels
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardOpenOption.READ
import java.nio.channels.FileChannel
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

class ZoteroDavPrepared internal constructor(internal val journal:DavJournal,private val issuer:Any) {
    val id:String get()=journal.id
    internal fun issuedBy(owner:Any)=issuer===owner
    fun preview():JSONObject=try{val p=journal.read().getJSONObject("plan");val a=p.getJSONObject("attachment");val f=p.getJSONObject("file");JSONObject().put("preparedID",id).put("backend","webdav").put("role",a.getString("role")).put("filename",a.getString("filename")).put("bytes",f.getLong("bytes")).put("sha256",f.getString("sha256")).put("zipSHA256",p.getJSONObject("zip").getString("sha256"))}catch(e:Exception){throw if(e is ZoteroDavFailure)e else ZoteroDavFailure("storage")}
}

/** Original implementation of ordinary ZIP/own constrained properties grammar, not copied Zotero code. */
internal class ZoteroDavCodec(root:File,private val available:()->Long,directorySync:(File)->Unit) {
    constructor(root:File,available:()->Long={root.usableSpace}):this(root,available,DavFiles::syncDirectory)
    internal val files=DavFiles(root,directorySync)
    private val issuer=Any()
    fun prepare(material:ZoteroDavAttachment,target:ZoteroDavTarget,check:()->Unit={}):ZoteroDavPrepared = prepareInternal(material,target,null,check)
    internal fun prepareStorageMigration(material:ZoteroDavAttachment,target:ZoteroDavTarget,adoption:ZoteroDavStorageAdoption,check:()->Unit={}):ZoteroDavPrepared = prepareInternal(material,target,adoption,check)
    private fun prepareInternal(material:ZoteroDavAttachment,target:ZoteroDavTarget,adoption:ZoteroDavStorageAdoption?,check:()->Unit):ZoteroDavPrepared {
        check();files.check();val sourceBefore=DavFiles.regular(material.source)
        val count=sourceBefore.size();val mtime=adoption?.wireMtime(material,target)?:sourceBefore.lastModifiedTime().toMillis()
        davRequire(count in 1..MAX_FILE&&mtime in 1..9_999_999_999_999L,"limit")
        val free=available();davRequire(free>0&&free>=count*3+4*1024*1024,"capacity")
        val id=UUID.randomUUID().toString();val dir=files.create(id)
        val directoryKey=DavFiles.attrs(dir).fileKey()?:throw ZoteroDavFailure("path")
        val opCheck={check();files.check();DavFiles.directory(dir);davRequire(DavFiles.attrs(dir).fileKey()==directoryKey,"path")}
        opCheck()
        val original=files.named(dir,"original.bin");val zip=files.named(dir,"attachment.zip");val prop=files.named(dir,"attachment.prop")
        val sha=MessageDigest.getInstance("SHA-256");val md5=MessageDigest.getInstance("MD5");var copied=0L
        // Failure keeps only this unregistered private operation; there is no success journal or remote write.
        DavFiles.newChannel(original).use{out->FileChannel.open(material.source.toPath(),READ,NOFOLLOW_LINKS).use{input->val b=ByteBuffer.allocate(65536);while(true){opCheck();b.clear();val n=input.read(b);if(n<0)break;davRequire(n>0,"storage");copied+=n;davRequire(copied<=count,"sourceChanged");sha.update(b.array(),0,n);md5.update(b.array(),0,n);b.flip();while(b.hasRemaining())out.write(b)};out.force(true)}}
        DavFiles.same(material.source,sourceBefore);val fileSHA=davHex(sha.digest());val fileMD5=davHex(md5.digest());davRequire(copied==count&&fileSHA==material.sourceSHA256,"sourceChanged")
        adoption?.requireFile(fileMD5,copied,fileSHA)
        val originalBefore=DavFiles.regular(original)
        DavFiles.newChannel(zip).use{channel->
            // The wrapper's close only flushes: the underlying channel must still be fsynced after ZIP finalization.
            val sink=object:java.io.FilterOutputStream(Channels.newOutputStream(channel)){override fun close(){flush()};override fun write(b:ByteArray,off:Int,len:Int){out.write(b,off,len)}}
            ZipOutputStream(sink,Charsets.UTF_8).use{out->val entry=ZipEntry(material.filename);entry.time=mtime;out.putNextEntry(entry);FileChannel.open(original.toPath(),READ,NOFOLLOW_LINKS).use{input->val b=ByteBuffer.allocate(65536);while(true){opCheck();b.clear();val n=input.read(b);if(n<0)break;davRequire(n>0,"storage");out.write(b.array(),0,n)}};out.closeEntry()};channel.force(true)
        }
        DavFiles.same(original,originalBefore);opCheck()
        val propBytes=properties(mtime,fileMD5);files.createBytes(prop,propBytes)
        val facts=JSONObject().put("bytes",count).put("sha256",fileSHA).put("md5",fileMD5).put("mtime",mtime)
        verifyZip(zip,material.filename,facts,opCheck)
        val plan=JSONObject().put("target",target.binding()).put("attachment",material.descriptor()).put("file",facts)
            .put("zip",JSONObject().put("bytes",zip.length()).put("sha256",DavFiles.hash(zip,opCheck))).put("prop",JSONObject().put("bytes",propBytes.size).put("sha256",davHash(propBytes)))
        if(adoption!=null)plan.put("storageAdoption",adoption.binding()).put("sourceObservedMtime",sourceBefore.lastModifiedTime().toMillis())
        opCheck();return ZoteroDavPrepared(DavJournal.create(files,id,dir,plan),issuer)
    }
    fun reopen(id:String,target:ZoteroDavTarget,check:()->Unit={}):ZoteroDavPrepared {val p=ZoteroDavPrepared(DavJournal.reopen(files,id),issuer);verify(p,target,check);return p}
    internal fun verify(prepared:ZoteroDavPrepared,target:ZoteroDavTarget,check:()->Unit={}):JSONObject {
        davRequire(prepared.issuedBy(issuer),"identity");val j=prepared.journal;check();j.checkDirectory();val raw=j.read();val p=raw.getJSONObject("plan")
        davRequire(target.matches(p.getJSONObject("target"))&&raw.getString("planSHA256")==davHash(canonical(p).toByteArray()),"stale")
        val a=p.getJSONObject("attachment");val f=p.getJSONObject("file");validateDescriptor(a,f)
        for(kind in listOf("zip","prop")){val v=p.getJSONObject(kind);davRequire(v.opt("sha256") is String,"identity");shaField(v.getString("sha256"));val n=strictLong(v.opt("bytes"))?:throw ZoteroDavFailure("identity");davRequire(n<=if(kind=="zip")MAX_ZIP else 4096,"limit")}
        val original=files.named(j.dir,"original.bin");val zip=files.named(j.dir,"attachment.zip");val prop=files.named(j.dir,"attachment.prop")
        davRequire(original.length()==f.getLong("bytes")&&DavFiles.hash(original,check)==f.getString("sha256"),"sourceChanged")
        davRequire(zip.length()==p.getJSONObject("zip").getLong("bytes")&&zip.length()<=MAX_ZIP&&DavFiles.hash(zip,check)==p.getJSONObject("zip").getString("sha256"),"sourceChanged")
        verifyZip(zip,a.getString("filename"),f,check)
        val bytes=DavFiles.read(prop,4096);davRequire(bytes.size.toLong()==p.getJSONObject("prop").getLong("bytes")&&davHash(bytes)==p.getJSONObject("prop").getString("sha256"),"sourceChanged")
        val metadata=parseProperties(bytes);davRequire(metadata.first==f.getLong("mtime")&&metadata.second==f.getString("md5"),"sourceChanged");check();j.checkDirectory();return p
    }
    internal fun validateDescriptor(a:JSONObject,f:JSONObject){
        davRequire(listOf("key","parentKey","role","paperID","sourceIdentity","title","contentType","filename","sourceSHA256").all{a.opt(it) is String}&&listOf("sha256","md5").all{f.opt(it) is String},"identity")
        davRequire(validKey(a.getString("key"))&&validKey(a.getString("parentKey"))&&a.getString("key")!=a.getString("parentKey"),"identity")
        val role=a.getString("role");val extension=when(a.getString("contentType")){"application/pdf"->"pdf";"text/html"->"html";"application/json"->"json";else->throw ZoteroDavFailure("contentType")}
        davRequire(role in setOf("source-metadata","pdf","guide","analysis","note","guide-preview-pdf")&&a.getString("filename")=="$role.$extension"&&a.getString("paperID").isNotBlank()&&a.getString("title").isNotBlank(),"identity")
        shaField(a.getString("sourceIdentity"));shaField(a.getString("sourceSHA256"));shaField(f.getString("sha256"))
        davRequire(a.getString("sourceSHA256")==f.getString("sha256")&&(strictLong(f.get("bytes"))?:-1L) in 1..MAX_FILE&&(strictLong(f.get("mtime"))?:-1L) in 1..9_999_999_999_999L&&f.getString("md5").matches(Regex("[a-f0-9]{32}")),"identity")
    }
    companion object {
        const val MAX_FILE=512L*1024*1024
        const val MAX_ZIP=MAX_FILE+1024*1024
        fun properties(mtime:Long,md5:String):ByteArray{davRequire(mtime in 1..9_999_999_999_999L&&md5.matches(Regex("[a-f0-9]{32}")),"properties");return "<properties version=\"1\"><mtime>$mtime</mtime><hash>$md5</hash></properties>".toByteArray(Charsets.UTF_8)}
        /** This closed grammar has no XML engine/entity resolution at all. */
        fun parseProperties(bytes:ByteArray):Pair<Long,String>{davRequire(bytes.size<=4096,"properties");val s=strictText(bytes);val m=Regex("\\A<properties version=\"1\"><mtime>([1-9][0-9]{0,12})</mtime><hash>([a-f0-9]{32})</hash></properties>\\z").matchEntire(s)?:throw ZoteroDavFailure("properties");return m.groupValues[1].toLong() to m.groupValues[2]}
        internal fun verifyZip(file:File,filename:String,facts:JSONObject,check:()->Unit={}) {
            val before=DavFiles.regular(file);davRequire(before.size() in 22..MAX_ZIP&&filename.matches(Regex("[a-z][a-z0-9-]*\\.(pdf|html|json)")),"zip")
            val central=central(file,filename)
            val expected=facts.getLong("bytes");davRequire(expected in 1..MAX_FILE&&central.size==expected&&central.compressed>0&&expected<=central.compressed*10_000,"zip")
            val sha=MessageDigest.getInstance("SHA-256");val md5=MessageDigest.getInstance("MD5");val crc=CRC32();var count=0L
            ZipFile(file,Charsets.UTF_8).use{zip->davRequire(zip.size()==1,"zip");val entry=zip.entries().nextElement();davRequire(entry.name==filename&&!entry.isDirectory&&entry.size==expected&&entry.method in setOf(0,8),"zip");zip.getInputStream(entry).use{input->val b=ByteArray(65536);while(true){check();val n=input.read(b);if(n<0)break;davRequire(n>0,"zip");count+=n;davRequire(count<=expected,"zip");sha.update(b,0,n);md5.update(b,0,n);crc.update(b,0,n)}}}
            davRequire(count==expected&&davHex(sha.digest())==facts.getString("sha256")&&davHex(md5.digest())==facts.getString("md5")&&crc.value==central.crc,"zip")
            DavFiles.same(file,before);check()
        }
        private data class Central(val size:Long,val compressed:Long,val crc:Long)
        private fun central(file:File,filename:String):Central=RandomAccessFile(file,"r").use{r->
            fun u16():Int {val a=r.read();val b=r.read();davRequire(a>=0&&b>=0,"zip");return a or (b shl 8)}
            fun u32():Long=u16().toLong() or (u16().toLong() shl 16)
            val n=r.length();val start=(n-65557).coerceAtLeast(0);var eocd=-1L;var at=n-22
            while(at>=start){r.seek(at);if(u32()==0x06054b50L){r.seek(at+20);if(u16().toLong()+at+22==n){eocd=at;break}};at--}
            davRequire(eocd>=0,"zip");r.seek(eocd+4);davRequire(u16()==0&&u16()==0&&u16()==1&&u16()==1,"zip");val centralSize=u32();val offset=u32();davRequire(centralSize in 46..65536&&offset>0&&offset+centralSize==eocd,"zip");r.seek(offset);davRequire(u32()==0x02014b50L,"zip");val made=u16();val needed=u16();val flags=u16();val method=u16();u16();u16();val crc=u32();val compressed=u32();val size=u32();val nameLen=u16();val extraLen=u16();val commentLen=u16();val disk=u16();u16();val ext=u32();val local=u32()
            davRequire(needed<=20&&flags and 0xf7f7==0&&method in setOf(0,8)&&disk==0&&local==0L&&size<=MAX_FILE&&compressed<=MAX_ZIP&&46L+nameLen+extraLen+commentLen==centralSize,"zip")
            val name=ByteArray(nameLen);r.readFully(name);davRequire(name.contentEquals(filename.toByteArray(Charsets.UTF_8)),"zip")
            val mode=(ext ushr 16).toInt()and 0xf000;davRequire(mode==0||mode==0x8000,"zip");davRequire(ext and 0x10==0L,"zip")
            val extraEnd=r.filePointer+extraLen;while(r.filePointer<extraEnd){val id=u16();val length=u16();davRequire(id==0x5455&&length in 1..13&&r.filePointer+length<=extraEnd,"zip");r.seek(r.filePointer+length)};davRequire(r.filePointer==extraEnd,"zip")
            r.seek(0);davRequire(u32()==0x04034b50L&&u16()==needed&&u16()==flags&&u16()==method,"zip");r.seek(14);val localCRC=u32();val localCompressed=u32();val localSize=u32();val localName=u16();val localExtra=u16();val localBytes=ByteArray(localName);r.readFully(localBytes);davRequire(localBytes.contentEquals(name)&&30L+localName+localExtra+compressed<=offset,"zip")
            if(flags and 8==0)davRequire(localCRC==crc&&localCompressed==compressed&&localSize==size,"zip")else davRequire(localCRC==0L&&localCompressed==0L&&localSize==0L,"zip")
            val localExtraEnd=r.filePointer+localExtra;while(r.filePointer<localExtraEnd){val extraID=u16();val extraSize=u16();davRequire(extraID==0x5455&&extraSize in 1..13&&r.filePointer+extraSize<=localExtraEnd,"zip");r.seek(r.filePointer+extraSize)};davRequire(r.filePointer==localExtraEnd,"zip")
            val dataEnd=30L+localName+localExtra+compressed
            if(flags and 8!=0){r.seek(dataEnd);val first=u32();val gotCRC=if(first==0x08074b50L)u32() else first;davRequire(gotCRC==crc&&u32()==compressed&&u32()==size&&r.filePointer==offset,"zip")}else davRequire(dataEnd==offset,"zip")
            Central(size,compressed,crc)
        }
    }
}
