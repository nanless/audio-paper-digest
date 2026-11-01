package com.nanless.paperdigest.ui
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class PrivateLibrarySearchTest {
 @Test fun notesAnnotationQuoteAndCommentAreTheOnlyPrivateSearchFields(){val p=JSONObject().put("notes",JSONObject().put("note",JSONObject().put("text","private NEEDLE"))).put("annotations",JSONObject().put("quote",JSONArray().put(JSONObject().put("text","Needle quotation"))).put("comment",JSONArray().put(JSONObject().put("comment","needle comment"))).put("source",JSONArray().put(JSONObject().put("source","needle metadata")))).put("sessions",JSONArray().put(JSONObject().put("raw","needle request")));assertEquals(setOf("note","quote","comment"),privateLibraryHits(p,"needle"))}
 @Test fun emptyQueryDoesNotScanOrMatchPrivateData(){assertTrue(privateLibraryHits(JSONObject().put("notes",JSONObject().put("p",JSONObject().put("text","anything")))," ").isEmpty())}
}
