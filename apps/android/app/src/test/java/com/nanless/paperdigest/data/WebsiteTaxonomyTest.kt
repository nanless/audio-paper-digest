package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WebsiteTaxonomyTest {
    private val sha="a".repeat(64)
    private fun node(id:String,label:String,ancestors:List<String> = emptyList())=JSONObject().put("id",id).put("facet",id.substringBefore('.')).put("zh",label).put("aliases",JSONArray()).put("ancestorIds",JSONArray(ancestors))
    private fun snapshot(nodes:List<JSONObject>,hash:String=sha)=JSONObject().put("contract","paper-tag-catalog-snapshot-v2").put("registryVersion","paper-taxonomy-v2").put("registrySha256",hash).put("concepts",JSONArray(nodes))
    private fun bundle(current:JSONObject,history:List<JSONObject> = listOf(current))=JSONObject().put("snapshot",current).put("versions",JSONObject().put("contract","paper-tag-catalog-versions-v2").put("currentSha256",current.getString("registrySha256")).put("snapshots",JSONArray(history)))
    private fun current()=snapshot(listOf(node("task.audio","音频"),node("task.music","音乐",listOf("task.audio")),node("task.mixing","混音",listOf("task.audio","task.music"))))
    private fun row(label:String="混音",hash:String=sha)=JSONObject().put("tagContract","paper-tag-flat-tags-v2").put("tagCatalogSha256",hash).put("tagConcepts",JSONArray().put(JSONObject().put("id","task.mixing").put("facet","task").put("label",label)))
    private fun paper(vararg rows:JSONObject)=Paper("synthetic:1","Synthetic",original=JSONObject().put("websiteTagRecords",JSONArray(rows.toList())))
    @Test fun exactIssuedConceptGetsWebsiteThreeLevelNavigationWithoutChangingDirectTags(){
        val taxonomy=WebsiteTaxonomy.parse(bundle(current()));val source=row();val before=source.toString()
        assertEquals(listOf("task.audio","task.music","task.mixing"),taxonomy.paths(paper(source)).single().map{it.id})
        assertEquals(before,source.toString());assertEquals(1,source.getJSONArray("tagConcepts").length())
    }
    @Test fun historicalLabelIsCheckedAgainstItsOwnVersionAndCurrentPathIsUsed(){
        val old=snapshot(listOf(node("task.mixing","旧混音")),"b".repeat(64));val taxonomy=WebsiteTaxonomy.parse(bundle(current(),listOf(current(),old)))
        assertEquals("混音",taxonomy.classify(row(label="旧混音",hash="b".repeat(64))).concepts.single().label)
        assertTrue(taxonomy.classify(row(label="混音",hash="b".repeat(64))).concepts.isEmpty())
        assertTrue(taxonomy.classify(row(hash="c".repeat(64))).concepts.isEmpty())
    }
    @Test fun withheldUnknownUnboundAndLegacyNeverBorrowFlatTaskMethodOrTags(){
        val taxonomy=WebsiteTaxonomy.parse(bundle(current()))
        assertEquals("withheld",taxonomy.classify(row().put("tagPublicationStatus","withheld")).status)
        assertEquals("unknown-version",taxonomy.classify(row(hash="c".repeat(64))).status)
        assertEquals("unbound-version",taxonomy.classify(row().apply{remove("tagCatalogSha256")}).status)
        assertEquals("legacy",taxonomy.classify(JSONObject().put("task","混音").put("tags",JSONArray(listOf("混音")))).status)
        assertTrue(taxonomy.classify(row().put("taxonomyContract","paper-taxonomy-flat-tags-compat-v1")).concepts.isEmpty())
    }
    @Test fun invalidRoleEvidenceIsNotPublishedAsTreeClassification(){
        val taxonomy=WebsiteTaxonomy.parse(bundle(current()));val r=row().put("tagClassificationContract","historical-source-taxonomy-classification-v3").put("researchType","science")
        assertEquals("invalid-roles",taxonomy.classify(r).status)
    }
    @Test fun brokenGraphOrMismatchedCurrentOriginalIsRejected(){
        assertThrows(Exception::class.java){WebsiteTaxonomy.parse(bundle(snapshot(listOf(node("task.child","子",listOf("task.missing"))))))}
        assertThrows(Exception::class.java){WebsiteTaxonomy.parse(bundle(current(),listOf(snapshot(listOf(node("task.other","另"))))))}
    }
    @Test fun ambiguousNormalizedAliasRejectsTheWebsitePair(){
        val s=snapshot(listOf(node("task.one","One").put("aliases",JSONArray(listOf("ＡＳＲ"))),node("task.two","Two").put("aliases",JSONArray(listOf("asr")))))
        assertThrows(Exception::class.java){WebsiteTaxonomy.parse(bundle(s))}
    }
    @Test fun parsePaperKeepsOriginalWebsiteClassificationFieldsAcrossNativeSerialization(){
        val raw=row().put("pageType","paper").put("permalink","posts/synthetic/").put("title","Synthetic").put("primaryResearchRole",JSONObject().put("kind","task")).put("researchType","engineering")
        val paper=CatalogRepository.parsePaper(raw)!!;val restored=Paper.fromJson(paper.json());val record=WebsiteTaxonomy.records(restored).single()
        assertEquals(raw.getJSONArray("tagConcepts").toString(),record.getJSONArray("tagConcepts").toString());assertEquals("engineering",record.getString("researchType"))
    }
}
