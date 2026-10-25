package com.nanless.paperdigest.data
import com.nanless.paperdigest.cloud.BackupCodec
import kotlinx.coroutines.*
import org.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.*
import java.nio.file.Files
import java.util.UUID
class RetainedExportServiceTest {
 private class Fixture(oldChooser:Boolean=false,retain:Boolean=true) {
  val parent=Files.createTempDirectory("retained-export-").toRealPath().toFile()
  val research=File(parent,"Research").apply{mkdir()};val exports=File(parent,"Exports");val controls=File(parent,"PendingExports");val device=File(parent,"Device").apply{mkdir()}
  val pending=PendingExportStore(exports,controls)
  val personal=File(research,"personal.json").apply{writeText(JSONObject().put("schema",1).put("notes",JSONObject()).put("settings",JSONObject()).put("favorites",JSONArray()).put("reading",JSONArray()).put("readingState",JSONObject()).put("annotations",JSONObject()).put("sessions",JSONArray()).put("jobs",JSONArray().put(JSONObject().put("id","original-failed-job").put("status","failed").put("actualCost",12.5))).toString())}
  val source=JSONObject().put("format","backup").put("epoch","synthetic-original")
  val row:PendingExportStore.PendingExport
  val directory:File;val capture:BackupCodec.Captured;val conflict:File;val manifest:File;var oldAttemptID:String?=null
  init {
   File(research,"opaque-original").writeBytes(ByteArray(180001){(it%251).toByte()})
   row=pending.begin(UUID.randomUUID().toString(),"backup",source);directory=File(controls,row.operationID)
   capture=BackupCodec.capture(research,pending.preparationFile(row.operationID))
   ExportProducerReceipt(directory,row.operationID,row.documentID,source).recordVerifiedCapture(capture,"application/octet-stream","original.paperdigest")
   conflict=File(exports,"${row.documentID}.bin");manifest=File(exports,"${row.documentID}.json")
   if(oldChooser){
    ExportArtifactWriter(exports).completed(capture.file,"application/octet-stream","original.paperdigest",row.documentID,capture.sha256,capture.encodedBytes)
    pending.markReady(row.operationID);oldAttemptID=pending.beginDelivery(row.operationID).attemptID
    conflict.writeBytes(byteArrayOf(1,2,3));pending.get(row.operationID)
    pending.chooserCancelled(row.operationID,oldAttemptID!!)
   }else{conflict.writeBytes(byteArrayOf(1,2,3));manifest.writeText("unknown original conflict manifest");pending.reconcile()}
   if(retain)pending.retainPreparation(row.operationID,pending.preparationRevision(row.operationID))
  }
  fun service(boundary:(String)->Unit={})=RetainedExportService(pending,controls,research,device,requireExternalDestination={require(java.net.URI(it).authority=="synthetic.documents")},boundary=boundary)
  fun originals()=listOf(capture.file,File(directory,"producer-complete.json"),conflict,manifest,personal).associate{it.name to it.readBytes().toList()}
  fun close(){parent.deleteRecursively()}
 }
 private fun fixture(oldChooser:Boolean=false,body:(Fixture)->Unit){val f=Fixture(oldChooser);try{body(f)}finally{f.close()}}
 @Test fun retainedEndsOrdinaryMutationsAndPreservesOriginalEvidenceAndPaidHistory()=fixture{f->
  val original=f.originals();val row=f.pending.get(f.row.operationID);assertEquals("retained",row.preparation);assertFalse(row.json().getBoolean("ready"));assertTrue(row.json().getBoolean("retained"))
  assertTrue(runCatching{f.pending.phase(row.operationID,"capturing")}.isFailure);assertTrue(runCatching{f.pending.preparationFile(row.operationID)}.isFailure);assertTrue(runCatching{f.pending.markReady(row.operationID)}.isFailure);assertTrue(runCatching{f.pending.cancelPreparation(row.operationID)}.isFailure);assertTrue(runCatching{f.pending.beginDelivery(row.operationID)}.isFailure)
  repeat(2){assertEquals("retained",f.pending.reconcile().single().preparation)};assertEquals(original,f.originals())
 }
 @Test fun exactOriginalSaveClosesBeforeReadbackAndCreatesOnlyDisjointProofAndHistory()=fixture{f->runBlocking{
  val original=f.originals();val service=f.service();val source=service.prepareSnapshot(f.row.operationID);val delivery=service.beginDelivery(source);var closed=false;var reads=0
  val output=object:ByteArrayOutputStream(){override fun close(){closed=true;super.close()}}
  val result=service.save(delivery,"content://synthetic.documents/original",{output}){_,sha,bytes->reads++;assertTrue(closed);assertEquals(bytes,output.size().toLong());assertEquals(sha,BackupCodec.hash(output.toByteArray()))}
  assertEquals("verified",result.getString("state"));assertFalse(result.getBoolean("cleanupEligible"));assertEquals(1,reads);assertArrayEquals(f.capture.file.readBytes(),output.toByteArray());assertEquals(original,f.originals())
  val history=File(f.research,"ExportHistory").listFiles()!!.single();val value=JSONObject(history.readText());assertEquals("retained-capture-v1",value.getString("kind"));assertFalse(value.has("uri"));assertFalse(value.has("savedProofID"));assertFalse(File(f.device,"ExportSaveProofs").exists());assertTrue(File(f.device,"RetainedCaptureExportProofs").isDirectory)
 }}
 @Test fun unverifiedSourceAndForgedPresentationObjectNeverGetProviderAuthority()=fixture{f->
  val service=f.service();val real=service.prepareSnapshot(f.row.operationID);val fake=object:RetainedSnapshot{override val operationID=real.operationID;override val documentID=real.documentID;override val mime=real.mime;override val name=real.name;override val bytes=real.bytes;override val sha256=real.sha256}
  assertTrue(runCatching{service.beginDelivery(fake)}.isFailure);val proof=File(f.directory,"producer-complete.json");val bytes=proof.readBytes();proof.writeText("bad original proof")
  assertTrue(runCatching{service.prepareSnapshot(f.row.operationID)}.isFailure);assertTrue(runCatching{service.beginDelivery(real)}.isFailure);assertEquals("bad original proof",proof.readText());assertEquals("retained",f.pending.get(f.row.operationID).preparation);proof.writeBytes(bytes)
 }
 @Test fun failedPartialProviderWriteNeverClaimsVerifiedAndOldAttemptsCannotOpenProvider()=fixture{f->runBlocking{
  val original=f.originals();val service=f.service();val snapshot=service.prepareSnapshot(f.row.operationID);val old=service.beginDelivery(snapshot);var writes=0;var reads=0;var closed=false
  val error=runCatching{service.save(old,"content://synthetic.documents/partial",{object:OutputStream(){override fun write(value:Int){if(writes++>=10000)throw IOException("synthetic bait must not escape")};override fun close(){closed=true}}}){_,_,_->reads++}}.exceptionOrNull()
  assertNotNull(error);assertFalse(error!!.message.orEmpty().contains("synthetic bait"));assertTrue(writes in 10000 until snapshot.bytes);assertTrue(closed);assertEquals(0,reads);assertEquals("failed",service.deliveries(old.operationID).getString("state"));assertEquals(original,f.originals())
  val fresh=service.beginDelivery(snapshot);var opened=0;assertTrue(runCatching{service.save(old,"content://synthetic.documents/stale",{opened++;ByteArrayOutputStream()}){_,_,_->reads++}}.isFailure);assertEquals(0,opened);assertEquals(fresh.attemptID,service.deliveries(old.operationID).getString("attemptID"));assertEquals(2,service.deliveryHistory(old.operationID).size)
 }}
 @Test fun chooserCancellationAndColdRestartRetireOldTypedPermitsWithoutRecapture()=fixture{f->runBlocking{
  val original=f.originals();val service=f.service();val snapshot=service.prepareSnapshot(f.row.operationID);val first=service.beginDelivery(snapshot);assertEquals("cancelled",service.chooserCancelled(first).getString("state"));val second=service.beginDelivery(snapshot)
  val cold=f.service();assertEquals("failed",cold.deliveries(second.operationID).getString("state"));var opens=0
  assertTrue(runCatching{cold.save(second,"content://synthetic.documents/cold",{opens++;ByteArrayOutputStream()}){_,_,_->}}.isFailure);assertEquals(0,opens);assertEquals(original,f.originals());assertEquals("retained",f.pending.reconcile().single().preparation)
 }}
 @Test fun proofBeforeHistoryFailureIsRecoverableColdWithoutClaimingZeroSuccess()=fixture{f->runBlocking{
  val original=f.originals();val service=f.service{if(it=="retained.proof.persisted")throw IOException("controlled history fault")};val source=service.prepareSnapshot(f.row.operationID);val delivery=service.beginDelivery(source);val output=ByteArrayOutputStream();var reads=0
  assertTrue(runCatching{service.save(delivery,"content://synthetic.documents/proven",{output}){_,sha,_->reads++;assertEquals(sha,BackupCodec.hash(output.toByteArray()))}}.isFailure)
  assertEquals(1,reads);val cold=f.service();assertEquals("readback-proven-history-pending",cold.deliveries(source.operationID).getString("state"));assertEquals("verified",cold.reconcileHistory(source.operationID).getString("state"));assertEquals(1,reads);assertEquals(original,f.originals());assertEquals(1,File(f.research,"ExportHistory").listFiles()!!.size)
 }}
 @Test fun reentrantNewAttemptAfterReadbackCannotBeOverwrittenByOldCallback()=fixture{f->runBlocking{
  val service=f.service();val snapshot=service.prepareSnapshot(f.row.operationID);val first=service.beginDelivery(snapshot);var newer:RetainedDelivery?=null
  assertTrue(runCatching{service.save(first,"content://synthetic.documents/old",{ByteArrayOutputStream()}){_,_,_->newer=service.beginDelivery(snapshot)}}.isFailure)
  assertNotNull(newer);assertEquals(newer!!.attemptID,service.deliveries(first.operationID).getString("attemptID"));assertEquals("choosing",service.deliveries(first.operationID).getString("state"));assertFalse(File(f.device,"RetainedCaptureExportProofs/${first.attemptID}.json").exists())
 }}
 @Test fun proofBoundaryReentryPreservesHistoricalProofWithoutRevivingOldAttempt()=fixture{f->runBlocking{
  lateinit var service:RetainedExportService;lateinit var snapshot:RetainedSnapshot;var newer:RetainedDelivery?=null
  service=f.service{if(it=="retained.proof.persisted")newer=service.beginDelivery(snapshot)};snapshot=service.prepareSnapshot(f.row.operationID);val first=service.beginDelivery(snapshot)
  assertTrue(runCatching{service.save(first,"content://synthetic.documents/old-proof",{ByteArrayOutputStream()}){_,_,_->}}.isFailure)
  assertEquals(newer!!.attemptID,service.deliveries(first.operationID).getString("attemptID"));val old=service.deliveryHistory(first.operationID).first{it.getString("attemptID")==first.attemptID};assertEquals("readback-proven-history-pending",old.getString("state"))
  assertEquals("verified",service.reconcileHistory(first.operationID,first.attemptID).getString("state"));assertEquals(newer!!.attemptID,service.deliveries(first.operationID).getString("attemptID"))
 }}
 @Test fun summaryIncludesUnknownRetainedFilesButNotConflictsAndRejectsLinks()=fixture{f->
  val extra=File(f.directory,"unknown-original").apply{writeText("retained unknown bytes")};val service=f.service();val summary=service.retainedSummary();val actual=f.directory.walkTopDown().filter{it.isFile}.toList()
  assertEquals(1,summary.getInt("retainedOperations"));assertEquals("pendingExports",summary.getString("subsetOf"));assertEquals(actual.size.toLong(),summary.getLong("fileCount"));assertEquals(actual.sumOf{it.length()},summary.getLong("bytes"));assertTrue(extra.isFile)
  val outside=File(f.parent,"outside").apply{writeText("outside unchanged")};Files.createSymbolicLink(File(f.directory,"unknown-link").toPath(),outside.toPath());assertTrue(runCatching{service.retainedSummary()}.isFailure);assertEquals("outside unchanged",outside.readText())
 }
 @Test fun everyOldOrdinaryChooserAndProducerMutationIsRetiredWithoutRewritingItsHistory()=fixture(true){f->
  val original=f.originals();val old=f.oldAttemptID!!;val fact=File(f.directory,"attempt-$old.json").readBytes();var calls=0
  assertTrue(runCatching{f.pending.chooserCancelled(f.row.operationID,old)}.isFailure);assertTrue(runCatching{f.pending.startWriting(f.row.operationID,old)}.isFailure);assertTrue(runCatching{f.pending.recordWritten(f.row.operationID,old)}.isFailure);assertTrue(runCatching{f.pending.deliveryFailed(f.row.operationID,old)}.isFailure);assertTrue(runCatching{f.pending.verifyDelivery(f.row.operationID,old){calls++}}.isFailure)
  assertEquals(0,calls);assertEquals(original,f.originals());assertArrayEquals(fact,File(f.directory,"attempt-$old.json").readBytes());assertEquals("retained",f.pending.get(f.row.operationID).preparation)
 }
 @Test fun realCoroutineCancellationAfterOneChunkDrainsBeforeReturningAndNeverVerifies()=fixture{f->runBlocking{supervisorScope{
  val service=f.service();val source=service.prepareSnapshot(f.row.operationID);val delivery=service.beginDelivery(source);var reads=0;var closed=false;val partial=ByteArrayOutputStream()
  val task=async {val owner=currentCoroutineContext()[Job]!!;service.save(delivery,"content://synthetic.documents/cancelled",{object:OutputStream(){override fun write(value:Int){partial.write(value)};override fun write(b:ByteArray,off:Int,len:Int){partial.write(b,off,len);owner.cancel()};override fun close(){closed=true}}}){_,_,_->reads++}}
  assertTrue(runCatching{task.await()}.exceptionOrNull() is CancellationException);assertTrue(closed);assertTrue(partial.size().toLong() in 1 until source.bytes);assertEquals(0,reads);assertEquals("failed",service.deliveries(source.operationID).getString("state"));assertEquals(source.sha256,BackupCodec.hash(f.capture.file))
 }}}
 @Test fun mutationDuringExternalReadbackCannotProduceProofForAnotherSource()=fixture{f->runBlocking{
  val service=f.service();val source=service.prepareSnapshot(f.row.operationID);val delivery=service.beginDelivery(source);val proof=File(f.directory,"producer-complete.json").readBytes()
  assertTrue(runCatching{service.save(delivery,"content://synthetic.documents/mutated",{ByteArrayOutputStream()}){_,_,_->f.capture.file.appendText("controlled changed source")}}.isFailure)
  assertEquals("failed",service.deliveries(source.operationID).getString("state"));assertFalse(File(f.device,"RetainedCaptureExportProofs/${delivery.attemptID}.json").exists());assertArrayEquals(proof,File(f.directory,"producer-complete.json").readBytes());assertTrue(f.capture.file.readText().endsWith("controlled changed source"))
 }}
 @Test fun tamperedLocalReadbackProofNeverBecomesAColdSuccessOrOrdinaryCleanupProof()=fixture{f->runBlocking{
  val service=f.service();val source=service.prepareSnapshot(f.row.operationID);val delivery=service.beginDelivery(source);service.save(delivery,"content://synthetic.documents/proven",{ByteArrayOutputStream()}){_,_,_->}
  val file=File(f.device,"RetainedCaptureExportProofs/${delivery.attemptID}.json");val value=JSONObject(file.readText()).put("uri","content://synthetic.documents/another");file.writeText(value.toString());assertTrue(runCatching{f.service().deliveries(source.operationID)}.isFailure);assertTrue(runCatching{f.service().reconcileHistory(source.operationID)}.isFailure);assertEquals("content://synthetic.documents/another",JSONObject(file.readText()).getString("uri"));assertFalse(File(f.device,"ExportSaveProofs").exists())
 }}

 @Test fun retainedProofCannotAuthorizeOrdinaryCleanupEvenWithSameDocumentIdAndCopiedProof()=fixture{f->runBlocking{
  val service=f.service();val source=service.prepareSnapshot(f.row.operationID);val delivery=service.beginDelivery(source)
  service.save(delivery,"content://synthetic.documents/original",{ByteArrayOutputStream()}){_,_,_->}
  val conflictBytes=f.conflict.readBytes();val metadata=JSONObject().put("documentID",f.row.documentID).put("mime","application/octet-stream").put("suggestedName","conflict.bin").put("bytes",conflictBytes.size).put("sha256",BackupCodec.hash(conflictBytes)).put("savedAt","2026-10-25T00:00:00Z").put("savedSHA256",BackupCodec.hash(conflictBytes)).put("savedBytes",conflictBytes.size).put("savedProofID",delivery.attemptID)
  f.manifest.writeText(metadata.toString());val proof=File(f.device,"RetainedCaptureExportProofs/${delivery.attemptID}.json").readBytes();File(f.device,"ExportSaveProofs").mkdir();File(f.device,"ExportSaveProofs/${delivery.attemptID}.json").writeBytes(proof)
  val historical=File(f.research,"ExportHistory/retained-${delivery.attemptID}.json").readBytes();File(f.research,"ExportHistory/${delivery.attemptID}.json").writeBytes(historical)
  val original=f.originals();var calls=0;val capacity=StorageCapacity(f.research,f.exports,File(f.parent,"Cloud"),f.device)
  val plan=capacity.cleanupPrepare{_,_,_->calls++};assertEquals(0,plan.getInt("documents"));assertEquals(0,calls);val commit=capacity.cleanupCommit(plan.getString("planID")){_,_,_->calls++};assertEquals(0,commit.getInt("removedFiles"));assertEquals(0,calls);assertEquals(original,f.originals())
 }}

 @Test fun retentionConfirmationMustCompareOriginalNativeRevisionAfterItsAwait() {
  val f=Fixture(retain=false);try{val before=f.originals();val original=f.pending.preparationRevision(f.row.operationID);f.pending.phase(f.row.operationID,"verifying")
   assertTrue(runCatching{f.pending.retainPreparation(f.row.operationID,original)}.isFailure);assertNotEquals("retained",f.pending.get(f.row.operationID).preparation);assertEquals(before,f.originals())
   f.pending.reconcile();f.pending.retainPreparation(f.row.operationID,f.pending.preparationRevision(f.row.operationID));assertEquals("retained",f.pending.get(f.row.operationID).preparation);assertEquals(before,f.originals())
  }finally{f.close()}
 }

 @Test fun invalidOrOwnedDestinationNeverOpensProviderOrStartsWriting()=fixture{f->runBlocking{
  val service=f.service();val snapshot=service.prepareSnapshot(f.row.operationID);val attempt=service.beginDelivery(snapshot);var opened=0;var readback=0
  assertTrue(runCatching{service.save(attempt,"content://owned.fileprovider/capture",{opened++;ByteArrayOutputStream()}){_,_,_->readback++}}.isFailure);assertEquals(0,opened);assertEquals(0,readback);assertEquals("choosing",service.deliveries(attempt.operationID).getString("state"));assertEquals(snapshot.sha256,BackupCodec.hash(f.capture.file))
 }}

 @Test fun missingPrivateProofNeverProjectsCurrentUnsignedVerifiedAsProven()=fixture{f->runBlocking{
  val service=f.service();val snapshot=service.prepareSnapshot(f.row.operationID);val delivery=service.beginDelivery(snapshot);service.save(delivery,"content://synthetic.documents/proven",{ByteArrayOutputStream()}){_,_,_->}
  val record=File(f.directory,"retained-delivery.json").readBytes();assertTrue(File(f.device,"RetainedCaptureExportProofs/${delivery.attemptID}.json").delete())
  val view=f.service().deliveries(snapshot.operationID);assertEquals("unconfirmed",view.getString("state"));assertFalse(view.getBoolean("readbackProven"));assertFalse(view.getBoolean("cleanupEligible"));assertArrayEquals(record,File(f.directory,"retained-delivery.json").readBytes())
 }}
 @Test fun missingPrivateProofNeverProjectsUnsignedHistoricalVerifiedAsProven()=fixture{f->runBlocking{
  val service=f.service();val snapshot=service.prepareSnapshot(f.row.operationID);val delivery=service.beginDelivery(snapshot);service.save(delivery,"content://synthetic.documents/proven",{ByteArrayOutputStream()}){_,_,_->}
  val file=File(f.directory,"retained-attempt-${delivery.attemptID}.json");val record=file.readBytes();assertTrue(File(f.device,"RetainedCaptureExportProofs/${delivery.attemptID}.json").delete())
  val view=f.service().deliveryHistory(snapshot.operationID).single();assertEquals("unconfirmed",view.getString("state"));assertFalse(view.getBoolean("readbackProven"));assertFalse(view.getBoolean("cleanupEligible"));assertArrayEquals(record,file.readBytes())
 }}

}
