package com.nanless.paperdigest.ui
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class StorageCapacityPresentationTest {
 @Test fun partialCleanupNeverBecomesAllDoneOrPhysicalSpaceFreed(){val result=JSONObject().put("status","partial").put("removedFiles",1).put("removedBytes",1024).put("byteMeasure","logical-file-length").put("retainedFiles",1).put("retainedStagingFiles",JSONObject.NULL);val text=cleanupOutcome(result);assertTrue(text.contains("部分完成"));assertTrue(text.contains("逻辑大小"));assertTrue(text.contains("保留 1"));assertTrue(text.contains("尚未确认"));assertFalse(text.contains("全部完成"));assertFalse(text.contains("释放"))}
 @Test fun missingOrInconsistentReceiptsCannotDefaultToZeroSuccess(){val valid=JSONObject().put("status","completed").put("removedFiles",2).put("removedBytes",1050).put("byteMeasure","logical-file-length").put("retainedFiles",0).put("retainedStagingFiles",0);assertTrue(cleanupOutcome(valid).contains("实际可用空间以重新统计为准"));for(invalid in listOf(JSONObject(valid.toString()).put("retainedFiles",1),JSONObject(valid.toString()).put("byteMeasure","physical"),JSONObject(valid.toString()).also{it.remove("removedBytes")},JSONObject(valid.toString()).put("removedFiles",-1))){assertThrows(Exception::class.java){cleanupOutcome(invalid)}};assertThrows(Exception::class.java){storageCount(JSONObject(),"bytes")};assertThrows(IllegalArgumentException::class.java){storageCount(JSONObject().put("bytes",1.5),"bytes")}}
}
