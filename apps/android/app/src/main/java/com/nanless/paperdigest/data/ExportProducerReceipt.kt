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
  try {require(staged.encodedSHA256==r.getString("sha256")&&staged.encodedBytes==bytes&&staged.entries.size==count){"原生产回执未对应完整资料"}}finally{staged.directory.deleteRecursively()}
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
  private const val CONTRACT="paperdigest-export-producer-v1"
  private fun number(o:JSONObject,k:String,min:Long,max:Long):Long{val n=o.get(k);require(n is Number&&n.toDouble().isFinite()&&n.toDouble()==n.toLong().toDouble()&&n.toLong()in min..max);return n.toLong()}
 }
}
