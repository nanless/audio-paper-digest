package com.nanless.paperdigest.data
import java.io.File
import java.nio.file.Files
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class ReplacedDirectoryReviewTest {
 @Test fun newlyCreatedEmptyDirectoryAtSamePathDoesNotHideTheOriginalPendingOperation(){
  val root=Files.createTempDirectory("pending-directory-v2-independent-").toRealPath().toFile()
  try{val controls=File(root,"Pending");val store=PendingExportStore(File(root,"Exports"),controls,{"2026-01-01T00:00:00Z"});val pending=store.begin(UUID.randomUUID().toString(),"backup",JSONObject().put("owner","synthetic"));val preserved=File(root,"PreservedPending");assertTrue(controls.renameTo(preserved));assertTrue(controls.mkdir());val original=File(preserved,"${pending.operationID}/operation.json").readBytes();assertTrue(runCatching{store.reconcile()}.isFailure);assertArrayEquals(original,File(preserved,"${pending.operationID}/operation.json").readBytes());assertTrue(controls.list()!!.isEmpty())}finally{root.deleteRecursively()}
 }
}
