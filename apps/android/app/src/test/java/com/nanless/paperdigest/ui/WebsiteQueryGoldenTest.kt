package com.nanless.paperdigest.ui
import com.nanless.paperdigest.data.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
class WebsiteQueryGoldenTest {
 private fun fixture():JSONObject{val root=generateSequence(File(System.getProperty("user.dir")).absoluteFile){it.parentFile}.first{File(it,"tests/fixtures/workbench-website-query-golden.json").isFile};return JSONObject(File(root,"tests/fixtures/workbench-website-query-golden.json").readText())}
 private fun papers(records:List<JSONObject>):List<Paper> = records.filter{it.optString("pageType")=="paper"}.groupBy{row->if(row.optString("identityStatus")!="verified")"page:"+row.getString("permalink")else row.optString("arxivId").takeIf{it.isNotBlank()}?.replace(Regex("v[1-9][0-9]*$"),"")?.let{"arxiv:$it"}?:row.optString("paperId")}.map{(id,rows)->Paper(id,id,original=JSONObject().put("websiteTagRecords",JSONArray(rows)))}
 @Test fun officialDirectionQueriesCountsAndMatchingGuidesAgreeAcrossAllSharedCases(){checkCases(false)}
 @Test fun typedLocalTextAndPrivateNoteExtensionsKeepPublishedConditionsWithinOneGuide(){checkCases(true)}
 private fun checkCases(app:Boolean){
  val f=fixture();val graph=WebsiteTaxonomy.parse(f.getJSONObject("display"));val records=f.getJSONObject("records");val cases=f.getJSONArray(if(app)"appIntegrationCases"else"cases");assertEquals(if(app)7 else 56,cases.length())
  for(i in 0 until cases.length()){
   val c=cases.getJSONObject(i);val name=c.getString("name");val expected=c.getJSONObject("expected");val rows=c.getJSONArray("recordKeys").strings().map{records.getJSONObject(it)};val papers=papers(rows);val index=WebsiteLibraryIndex(graph,papers)
   if(expected.optBoolean("error")){assertThrows(name,Exception::class.java){websiteDirectionFromJSON(c.getJSONObject("filters"),graph)};continue}
   val direction=websiteDirectionFromJSON(c.getJSONObject("filters"),graph);val ordinary=c.optJSONObject("ordinaryFilters")?:JSONObject();val native=c.optJSONObject("nativeResults");fun ids(o:JSONObject?,key:String)=o?.optJSONArray(key)?.strings()?.toSet().orEmpty()
   val criteria=WebsiteLibraryCriteria(source=ordinary.optString("source"),minimum=ordinary.optString("score"),query=c.optString("query"),personalHits=ids(native?.optJSONObject("personal"),"ids"),cachedHits=ids(native?.optJSONObject("library"),"cachedTextIDs"),from=ordinary.optString("from"),until=ordinary.optString("until"))
   val result=index.select(papers,criteria,direction);assertEquals(name,expected.getJSONArray("groupKeys").strings().toSet(),result.papers.map{it.id}.toSet())
   val matching=expected.getJSONArray("matchingGuides").objects().associate{it.getString("groupKey") to it.getJSONArray("permalinks").strings().toSet()};result.papers.forEach{p->assertEquals(name,matching.getValue(p.id),index.matchingPermalinks(p,criteria,direction).toSet())}
   for((key,filtered)in listOf("filteredCounts" to true,"browseCounts" to false)){
    val direct=index.select(papers,criteria,direction,filtered,false);val subtree=index.select(papers,criteria,direction,filtered,true);val counts=expected.getJSONObject(key);assertEquals(name,counts.getInt("total"),direct.countTotal)
    counts.getJSONArray("concepts").objects().forEach{node->assertEquals("$name $key ${node.getString("id")} direct",node.getInt("direct"),direct.counts[node.getString("id")]?:0);assertEquals("$name $key ${node.getString("id")} subtree",node.getInt("subtree"),subtree.counts[node.getString("id")]?:0)}
   }
  }
 }
}
