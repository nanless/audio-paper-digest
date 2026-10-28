package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.cloud.RequestContinuity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.net.URI
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardOpenOption.READ
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.IdentityHashMap
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

typealias RetainedDestinationVerifier = suspend (uri:String,expectedSHA256:String,expectedBytes:Long)->Unit

/** Presentation-only fields. Only the service's actual issued instance has Native authority. */
interface RetainedSnapshot {
 val operationID:String;val documentID:String;val mime:String;val name:String;val bytes:Long;val sha256:String
}
interface RetainedDelivery { val operationID:String;val attemptID:String }

/** No path from JSON is accepted. All proofs have a domain disjoint from ordinary export cleanup. */
class RetainedExportService(private val pending:PendingExportStore,controlRoot:File,researchRoot:File,deviceRoot:File,
 private val requireExternalDestination:(String)->Unit,private val clock:()->String={now()},private val boundary:(String)->Unit={}) {
 private val controls=ExportArtifactWriter.existingDirectory(controlRoot)
 private val research=ExportArtifactWriter.directory(researchRoot)
 private val device=ExportArtifactWriter.directory(deviceRoot)
 private val controlKey=attributes(controls).fileKey()?:error("无法确认保留材料目录身份")
 private val lock=Any()
 private data class Snapshot(override val operationID:String,override val documentID:String,override val mime:String,override val name:String,override val bytes:Long,override val sha256:String):RetainedSnapshot
 private data class Delivery(override val operationID:String,override val attemptID:String):RetainedDelivery
 private data class Lease(val snapshot:Snapshot,val revision:String,val file:File,val fileKey:Any,val proof:File,val proofSHA:String,val operationKey:Any)
 private data class Attempt(val delivery:Delivery,val snapshot:RetainedSnapshot,var copying:Boolean=false)
 private val snapshots=IdentityHashMap<RetainedSnapshot,Lease>()
 private val attempts=IdentityHashMap<RetainedDelivery,Attempt>()
 init {
  val roots=listOf(controls,research,device)
  require(roots.indices.all{a->roots.indices.all{b->a==b||(!roots[a].toPath().startsWith(roots[b].toPath())&&!roots[b].toPath().startsWith(roots[a].toPath()))}})
 }

 fun prepareSnapshot(operationID:String,check:()->Unit={}):RetainedSnapshot = synchronized(lock) {
  check();val row=pending.get(operationID,check);require(row.preparation=="retained"&&row.sourceIdentity.optString("format")=="backup"){"这里只能另存已结束准备的原完整研究快照"}
  val revision=pending.retainedRevision(operationID);val directory=operation(operationID)
  val producer=ExportProducerReceipt(directory,row.operationID,row.documentID,row.sourceIdentity)
  // Actual inventory passes the producer's outbound gate before any retained lease exists.
   val complete=producer.verifiedCapture(check);require(pending.retainedRevision(operationID)==revision)
  val proof=File(directory,"producer-complete.json");ExportArtifactWriter.regular(proof)
  val view=Snapshot(row.operationID,row.documentID,complete.mime,complete.name,complete.bytes,complete.sha256)
  val lease=Lease(view,revision,complete.file,attributes(complete.file).fileKey()?:error("无法确认原快照身份"),proof,BackupCodec.hash(JsonFiles.read(proof,65536)),attributes(File(directory,"operation.json")).fileKey()?:error("无法确认原准备身份"))
  snapshots[view]=lease;view
 }

 fun beginDelivery(snapshot:RetainedSnapshot,check:()->Unit={}):RetainedDelivery = synchronized(lock) {
  val lease=lease(snapshot);verifySource(lease,check)
  val previous=readCurrent(lease.snapshot.operationID)
  require(previous?.optString("state") !in setOf("choosing","writing")){"请先结束这份保留快照的当前保存操作"}
  val token=Delivery(lease.snapshot.operationID,UUID.randomUUID().toString())
  val record=JSONObject().put("contract",ATTEMPT).put("kind",DOMAIN).put("operationID",token.operationID).put("documentID",lease.snapshot.documentID)
   .put("attemptID",token.attemptID).put("sha256",lease.snapshot.sha256).put("bytes",lease.snapshot.bytes).put("state","choosing").put("createdAt",time())
  writeCurrent(record);attempts[token]=Attempt(token,snapshot);token
 }

 fun chooserCancelled(delivery:RetainedDelivery):JSONObject = synchronized(lock) {
  val attempt=attempt(delivery);val row=current(attempt);require(row.getString("state")=="choosing")
  row.put("state","cancelled").put("message","已取消位置选择；保留的原完整快照未改变。");writeCurrent(row);safe(row)
 }

 /** Root passes only a validated external content URI and a Native provider opener.
  * writing is durable before open; close must succeed before written-unverified; no background writer survives return. */
 suspend fun save(delivery:RetainedDelivery,uri:String,openOutput:()->OutputStream,verifier:RetainedDestinationVerifier):JSONObject {
  try{contentURI(uri);requireExternalDestination(uri)}catch(cancelled:CancellationException){throw cancelled}catch(_:Exception){throw AppFailure("storage","请选择此应用之外的系统文档保存位置")}
  val context=currentCoroutineContext()
  val admitted=synchronized(lock){val a=attempt(delivery);val row=current(a);require(row.getString("state")=="choosing"&&!a.copying);val l=lease(a.snapshot);verifySource(l){context.ensureActive()};row.put("state","writing");writeCurrent(row);a.copying=true;a to l}
  val (attempt,lease)=admitted
  try {
   openOutput().use{output->
    val hash=MessageDigest.getInstance("SHA-256");var count=0L
    Files.newInputStream(lease.file.toPath(),READ,NOFOLLOW_LINKS).use{input->
     val buffer=ByteArray(65536)
     while(true){context.ensureActive();fast(lease,attempt);val n=input.read(buffer);if(n<0)break;if(n==0)continue;require(n<=lease.snapshot.bytes-count){"原保留快照长度已变化"};output.write(buffer,0,n);hash.update(buffer,0,n);count+=n}
    }
    require(count==lease.snapshot.bytes&&hex(hash.digest())==lease.snapshot.sha256){"写出字节未对应原完整快照"};output.flush()
   }
   synchronized(lock){attempt.copying=false;verifySource(lease){context.ensureActive()};val row=current(attempt);require(row.getString("state")=="writing");row.put("state","written-unverified").put("message","已写入所选位置，完整回读尚未确认；原快照保留。");writeCurrent(row)}
   verifier(uri,lease.snapshot.sha256,lease.snapshot.bytes)
   return synchronized(lock){
    context.ensureActive();verifySource(lease){context.ensureActive()};val row=current(attempt);require(row.getString("state")=="written-unverified")
    val time=time();val history=JSONObject().put("contract",HISTORY).put("kind",DOMAIN).put("operationID",lease.snapshot.operationID).put("documentID",lease.snapshot.documentID)
     .put("attemptID",delivery.attemptID).put("sha256",lease.snapshot.sha256).put("bytes",lease.snapshot.bytes).put("mime",lease.snapshot.mime).put("suggestedName",lease.snapshot.name).put("readbackAt",time)
    val proof=JSONObject().put("contract",PROOF).put("domain",DOMAIN).put("operationID",lease.snapshot.operationID).put("documentID",lease.snapshot.documentID)
     .put("attemptID",delivery.attemptID).put("sha256",lease.snapshot.sha256).put("bytes",lease.snapshot.bytes).put("uri",uri).put("readbackAt",time).put("history",history).put("historySHA256",BackupCodec.hash(canonical(history).toByteArray()))
    proof.put("hmacSHA256",authenticate(proof,true));createSame(proofFile(delivery.attemptID),canonical(proof).toByteArray());boundary("retained.proof.persisted");require(current(attempt).getString("state")=="written-unverified")
    // This marker is not cleanup permission. A proof may survive even if this or History cannot be written.
    row.put("state","readback-proven-history-pending").put("message","原完整快照已实际回读；独立历史记录尚待补记，未授予清理资格。");writeCurrent(row)
    completeHistory(proof);boundary("retained.history.persisted");require(current(attempt).getString("state")=="readback-proven-history-pending")
    row.put("state","verified").put("message","保留的原快照已写出并完整回读；原准备及冲突文件仍保留，不授予普通清理资格。");writeCurrent(row);safe(row)
   }
  } catch(failure:Throwable) {
   withContext(NonCancellable){synchronized(lock){attempt.copying=false;runCatching{markFailure(attempt)}}}
   if(failure is CancellationException)throw failure
   throw AppFailure("storage","本次保存或记录未全部完成；所选位置可能已有文件。请查看独立回读事实，原快照与冲突材料保留。")
  }
 }

 /** Cold loading retires chooser/writer authority; it never reopens an external URI or rewrites research bytes. */
 fun deliveries(operationID:String):JSONObject = synchronized(lock) {
  require(pending.get(operationID).preparation=="retained")
  val row=readCurrent(operationID)?:return@synchronized JSONObject().put("kind",DOMAIN).put("state","none")
  if(row.getString("state") in setOf("choosing","writing")&&attempts.values.none{it.delivery.attemptID==row.getString("attemptID")}){row.put("state","failed").put("message","上次保存中断；外部位置可能已有部分文件。请明确重新选择位置，原快照保留。");writeCurrent(row)}
  project(row)
 }

 fun reconcileHistory(operationID:String,attemptID:String?=null):JSONObject = synchronized(lock) {
  require(pending.get(operationID).preparation=="retained");val row=if(attemptID==null)readCurrent(operationID)?:error("没有原保存尝试") else readAttempt(operationID,attemptID)
  val proof=verifiedProofOrNull(row)?:error("没有原生完整回读证明，不能补记成功")
  completeHistory(proof);row.put("state","verified").put("message","此前真实回读事实已补记；未重新写出、回读或采集原快照，也未授予清理资格。");if(readCurrent(operationID)?.getString("attemptID")==row.getString("attemptID"))writeCurrent(row)else writeAttempt(row);safe(row)
 }

 /** Subset of the existing pendingExports capacity row. Nothing is deleted. */
 fun retainedSummary():JSONObject {
  var files=0L;var bytes=0L;val rows=pending.retainedPreparations()
  for(row in rows){val root=operation(row.operationID);Files.walk(root.toPath()).use{paths->paths.forEach{path->require(!Files.isSymbolicLink(path));val a=Files.readAttributes(path,BasicFileAttributes::class.java,NOFOLLOW_LINKS);if(a.isRegularFile){files=Math.addExact(files,1);bytes=Math.addExact(bytes,a.size())}else require(a.isDirectory)}}}
  return JSONObject().put("subsetOf","pendingExports").put("retainedOperations",rows.size).put("fileCount",files).put("bytes",bytes)
 }

 private fun lease(handle:RetainedSnapshot)=snapshots[handle]?:error("原保留快照许可已结束，请重新核验")
 private fun attempt(handle:RetainedDelivery)=attempts[handle]?:error("原保存窗口已结束，请明确重新选择位置")
 private fun current(attempt:Attempt):JSONObject {val row=readCurrent(attempt.delivery.operationID)?:error("原保存记录缺失");val source=lease(attempt.snapshot).snapshot;require(row.getString("attemptID")==attempt.delivery.attemptID&&row.getString("documentID")==source.documentID&&row.getString("sha256")==source.sha256&&row.getLong("bytes")==source.bytes){"旧保存回调没有修改新尝试的权限"};return row}
 private fun fast(lease:Lease,attempt:Attempt?=null){
  require(attributes(controls).fileKey()==controlKey);val op=operation(lease.snapshot.operationID);require(attributes(File(op,"operation.json")).fileKey()==lease.operationKey)
  val a=attributes(lease.file);require(a.isRegularFile&&a.fileKey()==lease.fileKey&&a.size()==lease.snapshot.bytes)
  if(attempt!=null)synchronized(lock){require(current(attempt).getString("state")=="writing"){"原文件操作已结束，旧写入没有恢复权限"}}
 }
 private fun verifySource(lease:Lease,check:()->Unit){
  check();fast(lease);require(pending.retainedRevision(lease.snapshot.operationID)==lease.revision)
  require(BackupCodec.hash(JsonFiles.read(lease.proof,65536))==lease.proofSHA&&ExportArtifactWriter.digest(lease.file,check)==lease.snapshot.sha256){"原快照或生产回执已变化，未另存其他材料"};check();fast(lease)
 }
 private fun markFailure(a:Attempt){val row=current(a);val proof=verifiedProofOrNull(row);row.put("state",if(proof==null)"failed" else if(historyMatches(proof))"verified" else "readback-proven-history-pending").put("message",if(proof==null)"本次写入或回读未证实完成；外部可能已有部分文件，原快照保留。" else "此前完整回读事实已保留；请查看独立历史补记状态，不授予普通清理资格。");writeCurrent(row)}
 private fun project(row:JSONObject):JSONObject {
  val proof=verifiedProofOrNull(row)
  if(proof!=null)row.put("state",if(historyMatches(proof))"verified"else "readback-proven-history-pending")
  else if(row.getString("state") in setOf("verified","readback-proven-history-pending"))row.put("state","unconfirmed").put("message","原保存记录声称已回读，但本机完整回读证明缺失；当前不能确认成功，原记录和材料保留。")
  return safe(row)
 }
 private fun safe(row:JSONObject)=JSONObject().put("kind",DOMAIN).put("operationID",row.getString("operationID")).put("attemptID",row.getString("attemptID")).put("state",row.getString("state")).put("sha256",row.getString("sha256")).put("bytes",row.getLong("bytes")).put("message",row.optString("message")).put("cleanupEligible",false).put("readbackProven",row.getString("state") in setOf("verified","readback-proven-history-pending"))
 private fun operation(id:String):File {ExportArtifactWriter.uuid(id);require(attributes(controls).fileKey()==controlKey);return ExportArtifactWriter.existingDirectory(File(controls,id))}
 private fun currentFile(id:String)=File(operation(id),"retained-delivery.json")
 private fun readCurrent(id:String):JSONObject? {val file=currentFile(id);if(!Files.exists(file.toPath(),NOFOLLOW_LINKS))return null;ExportArtifactWriter.regular(file);val row=JSONObject(PublishedUtf8.decode(JsonFiles.read(file,65536)));require(row.getString("contract")==ATTEMPT&&row.getString("kind")==DOMAIN&&row.getString("operationID")==id);ExportArtifactWriter.uuid(row.getString("attemptID"));ExportArtifactWriter.uuid(row.getString("documentID"));require(BackupCodec.validSHA(row.getString("sha256"))&&row.getLong("bytes") in 1..BackupCodec.MAX_ENCODED);require(row.getString("state") in setOf("choosing","writing","written-unverified","cancelled","failed","readback-proven-history-pending","verified"));return row}
 private fun writeCurrent(row:JSONObject){writeAttempt(row);JsonFiles.write(currentFile(row.getString("operationID")),canonical(row).toByteArray())}
 private fun attemptFile(operationID:String,attemptID:String):File{ExportArtifactWriter.uuid(attemptID);return File(operation(operationID),"retained-attempt-$attemptID.json")}
 private fun writeAttempt(row:JSONObject){JsonFiles.write(attemptFile(row.getString("operationID"),row.getString("attemptID")),canonical(row).toByteArray())}
 private fun readAttempt(operationID:String,attemptID:String):JSONObject {val file=attemptFile(operationID,attemptID);ExportArtifactWriter.regular(file);val row=JSONObject(PublishedUtf8.decode(JsonFiles.read(file,65536)));require(row.getString("contract")==ATTEMPT&&row.getString("kind")==DOMAIN&&row.getString("operationID")==operationID&&row.getString("attemptID")==attemptID);return row}
 fun deliveryHistory(operationID:String):List<JSONObject> = synchronized(lock){require(pending.get(operationID).preparation=="retained");val dir=operation(operationID);(dir.listFiles()?:error("无法读取原保存历史")).filter{it.name.matches(Regex("retained-attempt-[a-f0-9-]{36}\\.json"))}.sortedBy{it.name}.map{file->val id=file.name.removePrefix("retained-attempt-").removeSuffix(".json");val row=readAttempt(operationID,id);project(row)}}
 private fun proofRoot()=ExportArtifactWriter.directory(File(device,"RetainedCaptureExportProofs"))
 private fun proofFile(id:String):File{ExportArtifactWriter.uuid(id);return File(proofRoot(),"$id.json")}
 private fun historyFile(id:String,create:Boolean=false):File{ExportArtifactWriter.uuid(id);val parent=File(research,"ExportHistory");if(create)ExportArtifactWriter.directory(parent)else if(Files.exists(parent.toPath(),NOFOLLOW_LINKS))ExportArtifactWriter.existingDirectory(parent);return File(parent,"retained-$id.json")}
 private fun verifiedProofOrNull(row:JSONObject):JSONObject? {
  val file=proofFile(row.getString("attemptID"));if(!Files.exists(file.toPath(),NOFOLLOW_LINKS))return null
  ExportArtifactWriter.regular(file);val proof=JSONObject(PublishedUtf8.decode(JsonFiles.read(file,65536)))
  require(proof.getString("contract")==PROOF&&proof.getString("domain")==DOMAIN)
  for(key in listOf("operationID","documentID","attemptID","sha256"))require(proof.getString(key)==row.getString(key));require(proof.getLong("bytes")==row.getLong("bytes"))
  val signature=proof.getString("hmacSHA256");val unsigned=proof.copy().also{it.remove("hmacSHA256")};require(MessageDigest.isEqual(signature.toByteArray(),authenticate(unsigned,false).toByteArray()))
  contentURI(proof.getString("uri"));val history=proof.getJSONObject("history");require(history.getString("contract")==HISTORY&&history.getString("kind")==DOMAIN)
  for(key in listOf("operationID","documentID","attemptID","sha256"))require(history.getString(key)==proof.getString(key));require(history.getLong("bytes")==proof.getLong("bytes")&&BackupCodec.hash(canonical(history).toByteArray())==proof.getString("historySHA256"));return proof
 }
 private fun completeHistory(proof:JSONObject){createSame(historyFile(proof.getString("attemptID"),true),canonical(proof.getJSONObject("history")).toByteArray())}
 private fun historyMatches(proof:JSONObject):Boolean {val file=historyFile(proof.getString("attemptID"));if(!Files.exists(file.toPath(),NOFOLLOW_LINKS))return false;ExportArtifactWriter.regular(file);return BackupCodec.hash(JsonFiles.read(file,65536))==proof.getString("historySHA256")}
 private fun authenticate(value:JSONObject,create:Boolean):String {
  val file=File(proofRoot(),"retained-capture-integrity.key")
  if(!Files.exists(file.toPath(),NOFOLLOW_LINKS)&&create)ExportArtifactWriter.createOnly(file,ByteArray(32).also{SecureRandom().nextBytes(it)})
  ExportArtifactWriter.regular(file);val key=JsonFiles.read(file,32);require(key.size==32);return Mac.getInstance("HmacSHA256").run{init(SecretKeySpec(key,"HmacSHA256"));doFinal((DOMAIN+"\n"+canonical(value)).toByteArray()).let(::hex)}
 }
 private fun createSame(file:File,bytes:ByteArray){if(Files.exists(file.toPath(),NOFOLLOW_LINKS)){ExportArtifactWriter.regular(file);require(JsonFiles.read(file,65536).contentEquals(bytes)){"原独立证明已存在且不同，未覆盖"}}else ExportArtifactWriter.createOnly(file,bytes)}
 private fun time()=clock().also{require(RequestContinuity.validTime(it))}
 private fun contentURI(raw:String){require(raw.length in 1..8192){"系统保存位置长度无效"};val u=try{URI(raw)}catch(_:Exception){throw AppFailure("storage","系统保存位置格式无效")};require(u.scheme=="content"&&!u.authority.isNullOrBlank()&&u.userInfo==null&&u.fragment==null){"保存位置必须为系统返回的外部文档位置"}}
 private fun attributes(file:File):BasicFileAttributes{ExportArtifactWriter.existingDirectory(if(file.isDirectory)file else file.parentFile!!);require(!Files.isSymbolicLink(file.toPath()));return Files.readAttributes(file.toPath(),BasicFileAttributes::class.java,NOFOLLOW_LINKS)}
 private fun hex(bytes:ByteArray)=bytes.joinToString(""){"%02x".format(it.toInt()and 255)}
 companion object { private const val DOMAIN="retained-capture-v1";private const val ATTEMPT="paperdigest-retained-capture-attempt-v1";private const val PROOF="paperdigest-retained-capture-export-proof-v1";private const val HISTORY="paperdigest-retained-capture-export-history-v1" }
}
