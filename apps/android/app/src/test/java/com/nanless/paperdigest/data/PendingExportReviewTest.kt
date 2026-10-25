package com.nanless.paperdigest.data
import com.nanless.paperdigest.cloud.BackupCodec
import java.io.File
import java.nio.file.Files
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PendingExportReviewTest {
 private class F {
  val root=Files.createTempDirectory("pending-export-independent-").toRealPath().toFile()
  val exports=File(root,"Exports");val controls=File(root,"Pending");val store=PendingExportStore(exports,controls,{"2026-01-01T00:00:00Z"})
  val p=store.begin(UUID.randomUUID().toString(),"backup",JSONObject().put("owner","synthetic-original").put("workspaceEpoch","old-workspace"))
  init{val data="Exact original synthetic immutable backup".toByteArray();JsonFiles.write(File(exports,"${p.documentID}.bin"),data);JsonFiles.write(File(exports,"${p.documentID}.json"),JSONObject().put("documentID",p.documentID).put("mime","application/octet-stream").put("suggestedName","Original.paperdigest").put("bytes",data.size).put("sha256",BackupCodec.hash(data)));store.markReady(p.operationID)}
  fun bytes()=root.walkTopDown().filter{it.isFile}.associate{it.relativeTo(root).path to BackupCodec.hash(it)}
  fun close(){root.deleteRecursively()}
 }
 @Test fun reentrantVerifierCannotOverwriteANewerChooserAttempt(){
  val f=F();try{
   val old=f.store.beginDelivery(f.p.operationID).attemptID!!;f.store.startWriting(f.p.operationID,old);f.store.recordWritten(f.p.operationID,old)
   var replacement="";var readbacks=0
   val result=runCatching{f.store.verifyDelivery(f.p.operationID,old){artifact->
    readbacks++;assertEquals(f.p.documentID,artifact.documentID)
    // A native callback re-enters the same synchronized store, e.g. lifecycle/retry work.
    f.store.deliveryFailed(f.p.operationID,old)
    replacement=f.store.beginDelivery(f.p.operationID).attemptID!!
   }}
   val current=f.store.get(f.p.operationID)
   println("OBSERVED_REENTRANT "+JSONObject().put("previous",old).put("replacement",replacement).put("current",current.attemptID).put("delivery",current.delivery).put("returnedSuccess",result.isSuccess))
   assertEquals(1,readbacks);assertNotEquals(old,replacement)
   assertEquals("An old verification callback must not overwrite the newer chooser attempt",replacement,current.attemptID)
   assertEquals("choosing",current.delivery)
  }finally{f.close()}
 }
 @Test fun unavailableControlDirectoryMustNotMasqueradeAsNoPendingExports(){
  val f=F();try{
   val moved=File(f.root,"Pending-preserved");assertTrue(f.controls.renameTo(moved));f.controls.writeText("Synthetic filesystem replacement")
   val before=f.bytes();val result=runCatching{f.store.reconcile()}
   println("OBSERVED_LISTING "+JSONObject().put("returnedSuccess",result.isSuccess).put("pendingCount",result.getOrNull()?.size?:JSONObject.NULL).put("preservedOriginalRecord",File(moved,"${f.p.operationID}/operation.json").isFile))
   assertEquals(before,f.bytes());assertTrue("Unavailable/non-directory control root must report an error, not an empty successful list",result.isFailure)
  }finally{f.close()}
 }
 @Test fun allLateCallbacksRejectBeforeVerifyingOrChangingTheCurrentAttempt(){
  val f=F();try{
   val old=f.store.beginDelivery(f.p.operationID).attemptID!!;f.store.chooserCancelled(f.p.operationID,old);val next=f.store.beginDelivery(f.p.operationID).attemptID!!;val before=f.bytes();var readbacks=0
   assertTrue(runCatching{f.store.startWriting(f.p.operationID,old)}.isFailure)
   assertTrue(runCatching{f.store.recordWritten(f.p.operationID,old)}.isFailure)
   assertTrue(runCatching{f.store.verifyDelivery(f.p.operationID,old){readbacks++}}.isFailure)
   assertTrue(runCatching{f.store.deliveryFailed(f.p.operationID,old)}.isFailure)
   assertTrue(runCatching{f.store.chooserCancelled(f.p.operationID,old)}.isFailure)
   assertEquals(0,readbacks);assertEquals(next,f.store.get(f.p.operationID).attemptID);assertEquals(before,f.bytes())
  }finally{f.close()}
 }
}
