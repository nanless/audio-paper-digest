package com.nanless.paperdigest.ui

import com.nanless.paperdigest.data.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class WebsiteLibraryIndexTest {
    private fun fixture():JSONObject {val root=generateSequence(File(System.getProperty("user.dir")).absoluteFile){it.parentFile}.first{File(it,"tests/fixtures/workbench-website-taxonomy-golden.json").isFile};return JSONObject(File(root,"tests/fixtures/workbench-website-taxonomy-golden.json").readText())}
    private fun paper(id:String,vararg records:JSONObject)=Paper(id,id,original=JSONObject().put("websiteTagRecords",JSONArray(records.toList())))
    @Test fun fullCatalogKeepsZeroNodesAndAllFacetsEvenWhenThereAreNoPapers(){
        val graph=WebsiteTaxonomy.parse(fixture().getJSONObject("display"));val index=WebsiteLibraryIndex(graph,emptyList());val view=index.select(emptyList(),WebsiteLibraryCriteria(),WebsiteDirection())
        assertTrue(graph.nodes.isNotEmpty());assertEquals(9,WebsiteTaxonomy.facets.size);assertTrue(graph.nodes.values.all{(view.counts[it.id]?:0)==0})
    }
    @Test fun sameFacetOrCrossFacetAndStayWithinOneGuideAndHonorPrimaryAndDirectScope(){
        val f=fixture();val graph=WebsiteTaxonomy.parse(f.getJSONObject("display"));val row=f.getJSONArray("cases").getJSONObject(0).getJSONObject("record");val p=paper("one",row);val index=WebsiteLibraryIndex(graph,listOf(p))
        fun result(vararg ids:String,subtree:Boolean=true,primary:Boolean=false)=index.select(listOf(p),WebsiteLibraryCriteria(),WebsiteDirection(ids.toSet(),subtree,primary)).papers
        assertEquals(listOf(p),result("task.audio-editing","method.statistical-analysis"))
        assertTrue(result("task.audio-editing",subtree=false).isEmpty());assertEquals(listOf(p),result("task.music-mixing",subtree=false))
        assertEquals(listOf(p),result("method.subjective-evaluation","method.statistical-analysis",primary=true))
        assertTrue(result("method.subjective-evaluation",primary=true).isEmpty())
        val pair=f.getJSONArray("groupingCases").getJSONObject(0).getJSONArray("records");val split=paper("split",pair.getJSONObject(0),pair.getJSONObject(1));val splitIndex=WebsiteLibraryIndex(graph,listOf(split))
        assertTrue(splitIndex.select(listOf(split),WebsiteLibraryCriteria(),WebsiteDirection(setOf("task.music-mixing","method.statistical-analysis"))).papers.isEmpty())
    }
    @Test fun countsUseOrdinaryEligibilityAndUniquePapersBeforeDirectionSelection(){
        val f=fixture();val graph=WebsiteTaxonomy.parse(f.getJSONObject("display"));val row=f.getJSONArray("cases").getJSONObject(0).getJSONObject("record");val p=paper("one",row,row.copy());val index=WebsiteLibraryIndex(graph,listOf(p))
        val view=index.select(listOf(p),WebsiteLibraryCriteria(),WebsiteDirection(setOf("scientific_topic.sound-propagation")))
        assertTrue(view.papers.isEmpty());assertEquals(1,view.counts["task.audio-editing"])
        assertTrue(index.select(listOf(p),WebsiteLibraryCriteria(minimum="9"),WebsiteDirection()).counts.isEmpty())
    }
    @Test fun sourceTaskAndClassificationCannotBorrowDifferentGuidesAndIndexReuseRequiresOriginalIdentity(){
        val f=fixture();val graph=WebsiteTaxonomy.parse(f.getJSONObject("display"));val original=f.getJSONArray("cases").getJSONObject(0).getJSONObject("record")
        val a=original.copy().put("sourceKind","arxiv").put("task","甲任务").put("tagConcepts",JSONArray().put(original.getJSONArray("tagConcepts").getJSONObject(1)))
        val b=original.copy().put("sourceKind","conference").put("task","乙任务").put("tagConcepts",JSONArray().put(original.getJSONArray("tagConcepts").getJSONObject(0)))
        val p=paper("one",a,b);val papers=listOf(p);val index=WebsiteLibraryIndex(graph,papers)
        assertTrue(index.select(papers,WebsiteLibraryCriteria(source="arxiv"),WebsiteDirection(setOf("task.music-mixing"))).papers.isEmpty())
        assertTrue(index.select(papers,WebsiteLibraryCriteria(task="甲任务"),WebsiteDirection(setOf("task.music-mixing"))).papers.isEmpty())
        assertEquals(listOf(p),index.select(papers,WebsiteLibraryCriteria(source="conference",task="乙任务"),WebsiteDirection(setOf("task.music-mixing"))).papers)
        assertTrue(index.hasSameSource(listOf(p.copy()),graph));assertFalse(index.hasSameSource(listOf(Paper.fromJson(p.json())),graph))
    }
    @Test fun websiteDateBoundsAreInclusiveAndInvalidOrMissingDatesCannotCrossExplicitRanges(){
        assertTrue(websiteDateMatches("2026-10-30","2026-10-30","2026-10-30"));assertFalse(websiteDateMatches("2026-10-29","2026-10-30",""))
        assertFalse(websiteDateMatches("","2026-10-30",""));assertFalse(websiteDateMatches("2026-02-30","2026-01-01",""));assertFalse(websiteDateMatches("0000-01-01","0000-01-01",""))
        assertFalse(websiteDateMatches("2026-10-30","2026-11-01","2026-10-01"));assertTrue(websiteDateMatches("","",""))
    }

}
