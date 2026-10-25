package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardOpenOption.*
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONObject

/** Native registration of one reserved UUID. Existing complete bytes and metadata are never replaced. */
class ExportArtifactWriter(root:File) {
 private val root=directory(root)
 private val rootKey=Files.readAttributes(this.root.toPath(),java.nio.file.attribute.BasicFileAttributes::class.java,NOFOLLOW_LINKS).fileKey()?:error("无法确认原导出目录身份")
 private fun checkRoot(){existingDirectory(root);require(Files.readAttributes(root.toPath(),java.nio.file.attribute.BasicFileAttributes::class.java,NOFOLLOW_LINKS).fileKey()==rootKey){"原导出目录已变化，未认领替代目录"}}
 data class Artifact(val id:String,val file:File,val mime:String,val name:String,val bytes:Long,val sha256:String)
 fun register(file:File,mime:String,name:String,documentID:String=UUID.randomUUID().toString(),check:()->Unit={}):Artifact {
  regular(file);return write({Files.newInputStream(file.toPath(),READ,NOFOLLOW_LINKS)},mime,name,documentID,check)
 }
 fun completed(file:File,mime:String,name:String,documentID:String,expectedSHA256:String,expectedBytes:Long,check:()->Unit={}):Artifact {
  regular(file);require(BackupCodec.validSHA(expectedSHA256)&&expectedBytes in 1..BackupCodec.MAX_ENCODED)
  return write({Files.newInputStream(file.toPath(),READ,NOFOLLOW_LINKS)},mime,name,documentID,check,expectedSHA256,expectedBytes)
 }
 fun bytes(data:ByteArray,mime:String,name:String,documentID:String=UUID.randomUUID().toString(),check:()->Unit={}):Artifact =
  write({data.inputStream()},mime,name,documentID,check)
 private fun write(input:()->InputStream,mime:String,name:String,id:String,check:()->Unit,expectedSHA256:String?=null,expectedBytes:Long?=null):Artifact {
  uuid(id);require(mime.matches(Regex("[A-Za-z0-9!#\u0024&^_.+-]+/[A-Za-z0-9!#\u0024&^_.+-]+")))
  val display=suggestedName(name);check();checkRoot()
  val bin=File(root,"$id.bin");val manifest=File(root,"$id.json");for(f in listOf(bin,manifest))require(!Files.isSymbolicLink(f.toPath()))
  val temporary=Files.createTempFile(root.toPath(),".export-",".tmp").toFile();BackupCodec.privateFile(temporary)
  var total=0L;val hash=MessageDigest.getInstance("SHA-256")
  try {
   input().use{source->FileChannel.open(temporary.toPath(),WRITE,NOFOLLOW_LINKS).use{output->
    val buffer=ByteArray(65536)
    while(true){check();val n=source.read(buffer);if(n<0)break;if(n==0)continue;require(n<=BackupCodec.MAX_ENCODED-total){"导出原件超过750MiB上限"};total+=n;hash.update(buffer,0,n);val bytes=ByteBuffer.wrap(buffer,0,n);while(bytes.hasRemaining()){check();output.write(bytes)}}
    output.force(true)
   }}
   val sha=hex(hash.digest());check();checkRoot()
   require((expectedSHA256==null||sha==expectedSHA256)&&(expectedBytes==null||total==expectedBytes)){"原正常完成快照在注册前变化，未授予就绪且未覆盖原材料"}
   if(Files.exists(bin.toPath(),NOFOLLOW_LINKS)){regular(bin);require(bin.length()==total&&digest(bin,check)==sha){"预留文档已有另一份原件，未覆盖"};FileChannel.open(bin.toPath(),WRITE,NOFOLLOW_LINKS).use{it.force(true)}}
   else createOnlyFromFile(temporary,bin,check)
   val meta=JSONObject().put("documentID",id).put("mime",mime).put("suggestedName",display).put("bytes",total).put("sha256",sha)
   check()
   if(Files.exists(manifest.toPath(),NOFOLLOW_LINKS)){
    regular(manifest);val old=JSONObject(PublishedUtf8.decode(JsonFiles.read(manifest,1024*1024)))
    for(key in listOf("savedAt","savedSHA256","savedBytes","savedProofID"))old.remove(key)
    require(canonical(old)==canonical(meta)){"预留文档清单已存在且不同，未覆盖"}
   }else createOnly(manifest,meta.toString().toByteArray())
   checkRoot();regular(bin);require(bin.length()==total&&digest(bin,check)==sha);check()
   return Artifact(id,bin,mime,display,total,sha)
  }finally{temporary.delete()}
 }
 companion object {
  fun suggestedName(name:String)=name.replace(Regex("[\\p{Cntrl}\\\\/:*?\"<>|]"),"-").take(160).also{require(it.isNotBlank()){ "导出名称无效" }}
  internal fun uuid(id:String){require(id.matches(Regex("[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}"))&&UUID.fromString(id).toString()==id)}
  internal fun directory(root:File):File {var p:File?=root.absoluteFile;while(p!=null){require(!Files.isSymbolicLink(p.toPath()));p=p.parentFile};require(root.absoluteFile==root.canonicalFile);if(!root.exists())require(root.mkdirs());require(root.isDirectory);BackupCodec.privateDirectory(root);return root}
  internal fun existingDirectory(root:File):File {var p:File?=root.absoluteFile;while(p!=null){require(!Files.isSymbolicLink(p.toPath()));p=p.parentFile};require(root.isDirectory&&root.absoluteFile==root.canonicalFile){"原材料目录缺失，未创建替代目录"};return root}
  internal fun regular(file:File){existingDirectory(file.parentFile!!);require(!Files.isSymbolicLink(file.toPath())&&Files.isRegularFile(file.toPath(),NOFOLLOW_LINKS))}
  internal fun digest(file:File,check:()->Unit):String {regular(file);val d=MessageDigest.getInstance("SHA-256");Files.newInputStream(file.toPath(),READ,NOFOLLOW_LINKS).use{input->val b=ByteArray(65536);while(true){check();val n=input.read(b);if(n<0)break;if(n>0)d.update(b,0,n)}};check();return hex(d.digest())}
  private fun hex(bytes:ByteArray)=bytes.joinToString(""){"%02x".format(it.toInt() and 255)}
  internal fun createOnly(file:File,raw:ByteArray){existingDirectory(file.parentFile!!);val temp=Files.createTempFile(file.parentFile.toPath(),".export-meta-",".tmp").toFile();try{BackupCodec.privateFile(temp);FileChannel.open(temp.toPath(),WRITE,NOFOLLOW_LINKS).use{out->val b=ByteBuffer.wrap(raw);while(b.hasRemaining())out.write(b);out.force(true)};createOnlyFromFile(temp,file)}finally{temp.delete()}}
  private fun createOnlyFromFile(source:File,target:File,check:()->Unit={}) {
   regular(source);existingDirectory(target.parentFile!!);require(!Files.isSymbolicLink(target.toPath()))
   val expectedBytes=source.length();val expectedSHA=digest(source,check)
   var createdKey:Any?=null;var completed=false
   try {
    // CREATE_NEW is a kernel-enforced reservation. Never replace an existing target,
    // and never silently fall back from a denied hard-link or atomic move.
    FileChannel.open(target.toPath(),CREATE_NEW,WRITE,NOFOLLOW_LINKS).use{output->
     createdKey=Files.readAttributes(target.toPath(),java.nio.file.attribute.BasicFileAttributes::class.java,NOFOLLOW_LINKS).fileKey()?:error("无法确认本次导出文件身份")
     BackupCodec.privateFile(target)
     Files.newInputStream(source.toPath(),READ,NOFOLLOW_LINKS).use{input->
      val buffer=ByteArray(65536);var copied=0L
      while(true){
       check();val n=input.read(buffer);if(n<0)break;if(n==0)continue
       require(n<=expectedBytes-copied){"本次导出暂存长度已变化"};copied+=n
       val bytes=ByteBuffer.wrap(buffer,0,n);while(bytes.hasRemaining()){check();output.write(bytes)}
      }
      require(copied==expectedBytes){"本次导出暂存长度已变化"}
     }
     output.force(true)
    }
    regular(target);require(Files.readAttributes(target.toPath(),java.nio.file.attribute.BasicFileAttributes::class.java,NOFOLLOW_LINKS).fileKey()==createdKey&&target.length()==expectedBytes&&digest(target,check)==expectedSHA){"本次导出写入未通过完整回读"}
    completed=true
   } finally {
    // A failed/cancelled copy owns only the new inode it reserved. Preserve every
    // pre-existing or replacement target and all original capture/temp bytes.
    if(!completed&&createdKey!=null)runCatching{
     val a=Files.readAttributes(target.toPath(),java.nio.file.attribute.BasicFileAttributes::class.java,NOFOLLOW_LINKS)
     if(a.isRegularFile&&a.fileKey()==createdKey) {
      // Preserve a fully written exact original even when cancellation arrived
      // before metadata qualification. A later registration re-verifies and fsyncs it.
      val full=target.length()==expectedBytes&&runCatching{digest(target,{})==expectedSHA}.getOrDefault(false)
      if(!full)Files.delete(target.toPath())
     }
    }
   }
  }
 }
}
