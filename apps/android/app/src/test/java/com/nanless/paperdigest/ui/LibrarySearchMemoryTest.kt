package com.nanless.paperdigest.ui
import com.nanless.paperdigest.data.Paper
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
/** GREEN-after-source contract tests; actual pre-fix memory failure is the complete online API35 run. */
class LibrarySearchMemoryTest {
 private class NoSerialization:JSONObject(){override fun toString():String=error("Search must not allocate a serialized full metadata string")}
 @Test fun emptyQueryDoesNotReadOrSerializeEightThousandMetadataRows(){val metadata="metadata-value ".repeat(512);val papers=(1..8005).map{Paper("paper-$it","Original $it",appearances=listOf(metadata))};val notes=object:JSONObject(){override fun optJSONObject(key:String):JSONObject?=error("Blank query must not touch note text")};assertEquals(8005,papers.count{matchesLibrarySearch(it,"",notes)});assertEquals(8005,papers.count{matchesLibrarySearch(it,"   ",notes)})}
 @Test fun allOriginalSearchFieldsRemainReachableWithoutJoiningOrJsonSerialization(){
  val appearance="VenueNeedle AppearanceNeedle 1234"
  val paper=Paper("IdNeedle","TitleNeedle","译题词",authors=listOf("AuthorNeedle"),date="DateNeedle",task="TaskNeedle",method="MethodNeedle",tags=listOf("TagNeedle"),sourceKind="SourceNeedle",appearances=listOf(appearance))
  val notes=NoSerialization().put(paper.id,JSONObject().put("text","PrivateNoteNeedle"))
  for(term in listOf("idneedle","titleneedle","译题词","authorneedle","dateneedle","taskneedle","methodneedle","tagneedle","sourceneedle","privatenoteneedle","venueneedle","appearanceneedle","1234"))assertTrue(term,matchesLibrarySearch(paper,term,notes))
  assertTrue(matchesLibrarySearch(paper,"  titleneedle  ",notes));assertTrue(matchesLibrarySearch(paper,"  privatenoteneedle  ",notes))
  assertFalse(matchesLibrarySearch(paper,"not-present",notes))
 }
}
