package com.nanless.paperdigest.ui
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class CachedGuideReceiptTest {
 private fun receipt()=JSONObject().put("query","needle").put("scope","cached-published-guides").put("scannedArticles",3).put("unavailableArticles",1).put("paperIDs",JSONArray(listOf("paper-a","paper-a")))
 @Test fun exactReceiptPreservesActualCountsAndKnownIdentity(){val actual=cachedGuideMatches(receipt(),"needle");assertEquals(setOf("paper-a"),actual.paperIDs);assertEquals(3,actual.scanned);assertEquals(1,actual.unavailable)}
 @Test fun mismatchedOrUnknownReceiptNeverBecomesAnEmptySuccessfulSearch(){for(key in listOf("query","scope","paperIDs","scannedArticles","unavailableArticles")){val value=receipt();value.remove(key);assertThrows(Exception::class.java){cachedGuideMatches(value,"needle")}};for(bad in listOf(-1,1.5,"0",JSONObject.NULL)){assertThrows(Exception::class.java){cachedGuideMatches(receipt().put("scannedArticles",bad),"needle")}};assertThrows(Exception::class.java){cachedGuideMatches(receipt().put("paperIDs",JSONArray(listOf(23))),"needle")}}
 @Test fun saveFeedbackRequiresBothActualWriteAndActualVerificationAndKeepsNativeWarning(){val warning="写出完成，但回读失败；原临时材料保留。";assertTrue(exportSaveFeedback(JSONObject().put("saved",true).put("verified",false).put("message",warning)).contains(warning));assertFalse(exportSaveFeedback(JSONObject().put("saved",false).put("verified",true)).contains("完成原件回读核验"));assertTrue(exportSaveFeedback(JSONObject().put("saved","true").put("verified","true")).contains("尚未核验"));assertEquals("实际原回执",exportSaveFeedback(JSONObject().put("saved",true).put("verified",true).put("message","实际原回执")))}
}
