package com.nanless.paperdigest.ui
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
/** GREEN-after-source test: expected values come from the unchanged actual Mac delimiter implementation. */
class SharedMathDelimiterTest {
 @Test fun androidRecognizesTheSameOriginalMathSpansAsCurrentMac(){
  val source=javaClass.getResourceAsStream("/shared-math-vectors.json")!!.bufferedReader().use{it.readText()};val vectors=JSONObject(source).getJSONArray("vectors")
  for(n in 0 until vectors.length()){
   val vector=vectors.getJSONObject(n);val text=vector.getString("text");val expected=vector.getJSONArray("expected");val actual=mutableListOf<ResearchRenderer.ScientificMath>();var i=0
   while(i<text.length){val match=ResearchRenderer.scientificMathAt(text,i);if(match==null)i++ else{actual+=match;i=match.end}}
   assertEquals(vector.getString("name"),expected.length(),actual.size)
   actual.forEachIndexed{index,m->val e=expected.getJSONObject(index);assertEquals(e.getInt("start"),m.start);assertEquals(e.getInt("end"),m.end);assertEquals(e.getString("text"),m.text);assertEquals(e.getBoolean("display"),m.display);assertEquals(e.getString("raw"),m.raw)}
  }
 }
}
