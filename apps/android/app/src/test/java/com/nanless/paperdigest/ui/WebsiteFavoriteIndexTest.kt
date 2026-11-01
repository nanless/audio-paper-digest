package com.nanless.paperdigest.ui
import com.nanless.paperdigest.data.*
import org.json.JSONObject
import org.json.JSONArray
import java.io.File
import org.junit.Assert.*
import org.junit.Test
class WebsiteFavoriteIndexTest {
    @Test fun missingWebsiteClassificationDoesNotUsePersonalCustomFoldersOrFlatTags(){
        val p=Paper("old","Old",task="自定义同名",tags=listOf("task.asr"));val index=WebsiteFavoriteIndex(null,listOf(p))
        assertEquals(1,index.unclassified);assertFalse(index.matches("old","task.asr"));assertTrue(index.matches("old","unclassified"));assertTrue(index.explanation(p).contains("请同步"))
    }
    @Test fun metadataAndWebsiteCategoryMustMatchTheSameGuide(){
        val root=generateSequence(File(System.getProperty("user.dir")).absoluteFile){it.parentFile}.first{File(it,"tests/fixtures/workbench-website-taxonomy-golden.json").isFile}
        val fixture=JSONObject(File(root,"tests/fixtures/workbench-website-taxonomy-golden.json").readText());val taxonomy=WebsiteTaxonomy.parse(fixture.getJSONObject("display"))
        val original=fixture.getJSONArray("cases").getJSONObject(0).getJSONObject("record")
        val a=original.copy().put("title","Alice high score").put("titleZh","Alice").put("summary","").put("score",9).put("citation",JSONObject().put("authors",JSONArray(listOf("Alice")))).put("tagConcepts",JSONArray().put(original.getJSONArray("tagConcepts").getJSONObject(1)))
        val b=original.copy().put("title","Bob low score").put("titleZh","Bob").put("summary","").put("score",5).put("citation",JSONObject().put("authors",JSONArray(listOf("Bob")))).put("tagConcepts",JSONArray().put(original.getJSONArray("tagConcepts").getJSONObject(0)))
        val p=Paper("arxiv:2610.38696","Alice high score",score=9.0,original=JSONObject().put("websiteTagRecords",JSONArray().put(a).put(b)))
        val index=WebsiteFavoriteIndex(taxonomy,listOf(p))
        assertFalse(index.matchesCriteria(p,"task.music-mixing","","8","",false))
        assertFalse(index.matchesCriteria(p,"task.music-mixing","","","Alice",false))
        assertTrue(index.matchesCriteria(p,"task.audio-editing","","4","Bob",false))
        assertTrue(index.matchesCriteria(p,"task.music-mixing","","4","private note",true))
        assertEquals(1,index.counts["task.audio-editing"])
    }

}
