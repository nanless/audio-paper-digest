package com.nanless.paperdigest.ui
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class CatalogAndCollectionsTest {
 @Test fun bundledSampleNeverClaimsWholeLibrary(){val s=JSONObject().put("paperCount",15).put("recordCount",15).put("snapshotID","bundled-sample");assertTrue(catalogMessage(s,0).contains("尚未全站同步"));assertFalse(catalogMessage(s,0).contains("已保存网站快照"))}
 @Test fun distinctPaperAndPageCountsAndLocalImportsRemainSeparate(){val s=JSONObject().put("paperCount",902).put("recordCount",1450).put("syncedAt","2026-10-25T00:00:00Z");val message=catalogMessage(s,3);assertTrue(message.contains("902 篇论文"));assertTrue(message.contains("1450 条页面记录"));assertTrue(message.contains("3 篇本地导入"));assertFalse(message.contains("905 篇论文"))}
 @Test fun collectionUsesActualParentPathAndKey(){val a=JSONObject().put("key","AAAAAAAA").put("data",JSONObject().put("name","音频研究").put("parentCollection",false));val b=JSONObject().put("key","BBBBBBBB").put("data",JSONObject().put("name","优先阅读").put("parentCollection","AAAAAAAA"));assertEquals("音频研究 / 优先阅读",collectionPath(b,listOf(a,b)));assertEquals("BBBBBBBB",collectionKey(b))}
 @Test fun cyclicCollectionMetadataCannotHangComposition(){val a=JSONObject().put("key","AAAAAAAA").put("data",JSONObject().put("name","A").put("parentCollection","BBBBBBBB"));val b=JSONObject().put("key","BBBBBBBB").put("data",JSONObject().put("name","B").put("parentCollection","AAAAAAAA"));assertTrue(collectionPath(a,listOf(a,b)).contains("待核对"))}
}
