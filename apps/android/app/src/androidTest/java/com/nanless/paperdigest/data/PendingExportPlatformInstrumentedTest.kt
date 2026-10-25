package com.nanless.paperdigest.data

import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.cloud.BackupCodec
import java.io.File
import java.nio.file.Files
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Actual Android NIO fileKey/strict UTF8/durable store; synthetic own-QA files only. */
class PendingExportPlatformInstrumentedTest {
 @Test fun realAndroidDirectoryIdentityAndReadyReopenPreserveTheExactArtifact() {
  val parent=Files.createTempDirectory(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.toPath(),"pending-export-platform-").toRealPath().toFile()
  try {
   val exports=File(parent,"Exports");val controls=File(parent,"Pending");val store=PendingExportStore(exports,controls)
   val original=store.begin(UUID.randomUUID().toString(),"backup",JSONObject().put("kind","synthetic-platform-only"))
   val data="Synthetic immutable export, not a real study or PDF.".toByteArray()
   JsonFiles.write(File(exports,"${original.documentID}.bin"),data)
   JsonFiles.write(File(exports,"${original.documentID}.json"),JSONObject().put("documentID",original.documentID).put("mime","application/octet-stream").put("suggestedName","synthetic.paperdigest").put("bytes",data.size).put("sha256",BackupCodec.hash(data)))
   val ready=store.markReady(original.operationID);assertEquals(original.documentID,ready.artifact!!.documentID)
   val chooser=store.beginDelivery(original.operationID);store.chooserCancelled(original.operationID,chooser.attemptID!!)
   val reopened=PendingExportStore(exports,controls).reconcile().single();assertEquals(original.operationID,reopened.operationID);assertEquals(original.documentID,reopened.documentID);assertEquals("ready",reopened.preparation);assertEquals("cancelled",reopened.delivery);assertArrayEquals(data,reopened.artifact!!.file.readBytes())
  } finally {parent.deleteRecursively()}
 }
 @Test fun replacedControlDirectoryCannotHideAnExistingPendingOperationAsEmpty() {
  val parent=Files.createTempDirectory(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.toPath(),"pending-export-platform-replaced-").toRealPath().toFile()
  try {
   val controls=File(parent,"Pending");val store=PendingExportStore(File(parent,"Exports"),controls);val original=store.begin(UUID.randomUUID().toString(),"backup",JSONObject())
   val retained=File(parent,"Retained");assertTrue(controls.renameTo(retained));assertTrue(controls.mkdir())
   assertTrue(runCatching{store.reconcile()}.isFailure)
   assertTrue(File(retained,"${original.operationID}/operation.json").isFile)
  } finally {parent.deleteRecursively()}
 }
}
