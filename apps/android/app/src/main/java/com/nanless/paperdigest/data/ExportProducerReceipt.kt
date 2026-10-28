package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.NoSuchFileException
import java.nio.file.attribute.BasicFileAttributes
import org.json.JSONObject

/** Only Native may record normal capture return; syntactically complete capture.tmp is insufficient. */
class ExportProducerReceipt(operationDirectory:File,private val operationID:String,private val documentID:String,sourceIdentity:JSONObject) {
 private val directory=operationDirectory.also{require(it.isDirectory&&!Files.isSymbolicLink(it.toPath())){ "本次操作目录缺失，未创建替代来源" }}.let(ExportArtifactWriter::directory)
 private val source=sourceIdentity.copy()
 private val receipt=File(directory,"producer-complete.json")
 private val capture=File(directory,"capture.tmp")
 private val directoryKey=Files.readAttributes(directory.toPath(),BasicFileAttributes::class.java,NOFOLLOW_LINKS).fileKey()?:error("无法确认原生产目录身份")
 @Volatile private var observedNormalReturn=false
 init {ExportArtifactWriter.uuid(operationID);ExportArtifactWriter.uuid(documentID);require(directory.name==operationID);require(canonical(source).toByteArray().size<=4096)}
 data class CompletedCapture(val file:File,val mime:String,val name:String,val bytes:Long,val sha256:String,val fileCount:Int)
 /** Conservative existence only; malformed/link/unreadable material must not be treated as permission to delete. */
 fun hasCompletionMaterials():Boolean {
  checkDirectory()
  if(observedNormalReturn)return true
  return try {Files.readAttributes(receipt.toPath(),BasicFileAttributes::class.java,NOFOLLOW_LINKS);true}catch(_:NoSuchFileException){false}
 }
 fun recordVerifiedCapture(result:BackupCodec.Captured,mime:String,name:String,check:()->Unit={}):CompletedCapture {
  checkDirectory();BackupCodec.requireNormalCapture(result);require(result.file.absoluteFile==capture.absoluteFile&&result.encodedBytes in 1..BackupCodec.MAX_ENCODED&&result.fileCount in 1..BackupCodec.MAX_ENTRIES&&BackupCodec.validSHA(result.sha256))
  // The Native caller invokes this only after normal capture returned. Retire no
  // completed material before its small durable producer checkpoint is attempted.
  observedNormalReturn=true
  ExportArtifactWriter.regular(capture);require(capture.length()==result.encodedBytes){"正常采集返回后原暂存已变化"}
  val display=ExportArtifactWriter.suggestedName(name)
  val expected=JSONObject().put("contract",CONTRACT).put("producer","normal-backup-codec-capture-returned").put("operationID",operationID).put("documentID",documentID).put("sourceIdentity",source.copy()).put("mime",mime).put("suggestedName",display).put("bytes",result.encodedBytes).put("sha256",result.sha256).put("fileCount",result.fileCount)
  if(Files.exists(receipt.toPath(),NOFOLLOW_LINKS))require(canonical(read())==canonical(expected)){"本次生产回执已存在且不同，未覆盖"}
  else ExportArtifactWriter.createOnly(receipt,expected.toString().toByteArray())
  return verifiedCapture(check)
 }
 fun verifiedCapture(check:()->Unit={}):CompletedCapture {
  check();val r=read();val bytes=number(r,"bytes",1,BackupCodec.MAX_ENCODED);val count=number(r,"fileCount",1,BackupCodec.MAX_ENTRIES.toLong()).toInt()
  require(BackupCodec.validSHA(r.getString("sha256")))
  ExportArtifactWriter.regular(capture);require(capture.length()==bytes&&ExportArtifactWriter.digest(capture,check)==r.getString("sha256")){"原完整暂存与生产回执不符，未重新采集"}
  val staged=BackupCodec.stage(Files.newInputStream(capture.toPath(),java.nio.file.StandardOpenOption.READ,NOFOLLOW_LINKS),directory,check)
  try {require(staged.encodedSHA256==r.getString("sha256")&&staged.encodedBytes==bytes&&staged.entries.size==count){"原生产回执未对应完整资料"};BackupCodec.requirePortableInventory(staged.entries)}finally{staged.directory.deleteRecursively()}
  check();require(canonical(read())==canonical(r));require(ExportArtifactWriter.digest(capture,check)==r.getString("sha256"))
  return CompletedCapture(capture,r.getString("mime"),r.getString("suggestedName"),bytes,r.getString("sha256"),count)
 }
 private fun checkDirectory(){ExportArtifactWriter.existingDirectory(directory);require(Files.readAttributes(directory.toPath(),BasicFileAttributes::class.java,NOFOLLOW_LINKS).fileKey()==directoryKey){"原生产目录已变化，未认领替代材料"}}
 private fun read():JSONObject {
  checkDirectory();ExportArtifactWriter.regular(receipt);val r=JSONObject(PublishedUtf8.decode(JsonFiles.read(receipt,65536)))
  require(r.keys().asSequence().toSet()==setOf("contract","producer","operationID","documentID","sourceIdentity","mime","suggestedName","bytes","sha256","fileCount"))
  require(r.getString("contract")==CONTRACT&&r.getString("producer")=="normal-backup-codec-capture-returned"&&r.getString("operationID")==operationID&&r.getString("documentID")==documentID&&canonical(r.getJSONObject("sourceIdentity"))==canonical(source))
  require(r.getString("mime")=="application/octet-stream"&&ExportArtifactWriter.suggestedName(r.getString("suggestedName"))==r.getString("suggestedName"))
  number(r,"bytes",1,BackupCodec.MAX_ENCODED);number(r,"fileCount",1,BackupCodec.MAX_ENTRIES.toLong());return r
 }
 companion object {
  /** Read-only outbound gate, not a restore decoder. Never rewrites legacy bytes or their identity.
   * Ordinary PDF/HTML/research exports are not backups merely because they mention a key path. */
  fun validatePortableBackup(file:File,stageParent:File=file.parentFile!!,check:()->Unit={}) {
   check();ExportArtifactWriter.regular(file)
   require(file.length() in 0..BackupCodec.MAX_ENCODED)
   val probe=backupContractProbe(file,check);val expected=probe.second;val bytes=file.length()
   require(bytes in 0..BackupCodec.MAX_ENCODED)
   require(ExportArtifactWriter.digest(file,check)==expected){"原导出在格式核验期间已变化"}
   if(!probe.first)return
   val parent=ExportArtifactWriter.existingDirectory(stageParent)
   val staged=BackupCodec.stage(Files.newInputStream(file.toPath(),java.nio.file.StandardOpenOption.READ,NOFOLLOW_LINKS),parent,check)
   try {
    require(staged.encodedSHA256==expected&&staged.encodedBytes==bytes){"原完整快照在核验期间已变化"}
    BackupCodec.requirePortableInventory(staged.entries)
   } finally {staged.directory.deleteRecursively()}
   check();ExportArtifactWriter.regular(file)
   require(file.length()==bytes&&ExportArtifactWriter.digest(file,check)==expected){"原完整快照在核验期间已变化"}
  }
  /** Bounded-memory root-contract probe. Field order and JSON string escapes are immaterial.
   * This recognizes only the root contract, never nested research text. Full syntax, inventory,
   * file hashes and encoded SHA are subsequently checked by the unchanged legacy decoder. */
  private fun backupContractProbe(file:File,check:()->Unit):Pair<Boolean,String> {
   val digest=java.security.MessageDigest.getInstance("SHA-256")
   return java.security.DigestInputStream(Files.newInputStream(file.toPath(),java.nio.file.StandardOpenOption.READ,NOFOLLOW_LINKS),digest).bufferedReader(Charsets.UTF_8).use { input ->
   var consumed=0L
   fun next():Int {if(consumed++%4096L==0L)check();require(consumed<=BackupCodec.MAX_ENCODED+1);return input.read()}
   fun nonspace():Int {var c=next();while(c in listOf(32,9,10,13))c=next();return c}
   // Retain only small root tokens; Base64 data and arbitrary research strings are skipped.
   fun string(keep:Boolean):String? {
    val token=if(keep)StringBuilder("\"") else null;var escaped=false;var overflow=false
    while(true){val c=next();if(c<0)return null
     if(token!=null&&!overflow){if(token.length<8192)token.append(c.toChar())else overflow=true}
     if(!escaped&&c=='"'.code)break
     escaped=if(escaped)false else c=='\\'.code
    }
    if(token==null||overflow)return null
    return runCatching{org.json.JSONTokener(token.toString()).nextValue() as? String}.getOrNull()
   }
   fun probe():Boolean {
    if(nonspace()!='{'.code)return false
    var depth=1;var keyExpected=true;var key:String?=null
    while(true){val c=next();if(c<0)return false
     when(c){
      '"'.code->{val value=string(depth==1);if(depth==1){if(keyExpected){key=value;keyExpected=false}else if(key=="contract"&&value=="paperdigest-backup-v2")return true}}
      '{'.code,'['.code->depth++
      '}'.code,']'.code->{depth--;if(depth<=0)return false}
      ','.code->if(depth==1){keyExpected=true;key=null}
     }
    }
   }
   val backup=probe()
   // Bind recognition (including a negative result) to the same complete raw-byte SHA.
   // A concurrent replacement cannot lend a benign probe to a different pending archive.
   val buffer=CharArray(16384)
   while(true){check();val n=input.read(buffer);if(n<0)break;consumed+=n;require(consumed<=BackupCodec.MAX_ENCODED+1)}
   backup to digest.digest().joinToString(""){"%02x".format(it.toInt()and 255)}
   }
  }
  private const val CONTRACT="paperdigest-export-producer-v1"
  private fun number(o:JSONObject,k:String,min:Long,max:Long):Long{val n=o.get(k);require(n is Number&&n.toDouble().isFinite()&&n.toDouble()==n.toLong().toDouble()&&n.toLong()in min..max);return n.toLong()}
 }
}
