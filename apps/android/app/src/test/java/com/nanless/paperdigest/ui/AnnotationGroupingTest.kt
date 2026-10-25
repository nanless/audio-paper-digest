package com.nanless.paperdigest.ui
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class AnnotationGroupingTest {
 @Test fun fiveGlyphPositionsRemainOriginalRecordsButDisplayAsOneGroup(){val rows=(0..4).map{JSONObject().put("id","original-$it").put("groupID","same-group").put("pdfSHA","a".repeat(64)).put("rect","{{$it,1},{2,3}}").put("text","MiCLA")};val before=rows.map{it.toString()};val groups=annotationGroups(rows);assertEquals(1,groups.size);assertEquals(5,groups.single().size);assertEquals("original-0",groups.single().first().getString("id"));assertEquals(before,rows.map{it.toString()})}
 @Test fun sameGroupInDifferentOriginalsCannotMerge(){val a=JSONObject().put("id","a").put("groupID","g").put("pdfSHA","a".repeat(64));val b=JSONObject().put("id","b").put("groupID","g").put("pdfSHA","b".repeat(64));assertEquals(2,annotationGroups(listOf(a,b)).size)}
 @Test fun missingOrEmptyGroupUsesOriginalIdInsteadOfMerging(){val a=JSONObject().put("id","a");val b=JSONObject().put("id","b").put("groupID","");assertEquals(2,annotationGroups(listOf(a,b)).size)}
}
