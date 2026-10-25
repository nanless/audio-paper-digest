package com.nanless.paperdigest.ui
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** Synthetic material/Action protocol; never contacts Zotero or writes a credential. */
class ZoteroPreparedOptionsInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private fun options()=JSONObject().put("includePDF",true).put("includeGuide",true).put("includeAnalysis",true).put("includeNote",true)
 private fun prepared(id:String,withOptions:Boolean=true)=JSONObject().put("paperID","original-paper").put("preparedID",id).put("roles",JSONArray()).put("readingMaterialID","material-a").put("materialsCurrent",true).apply{if(withOptions)put("options",options())}
 private fun state(prepared:JSONObject?)=UiState(selectedPaperId="original-paper",readingMaterialID="material-a",zotero=JSONObject().put("libraryID","123").apply{prepared?.let{put("prepared",it)}})
 @Test fun uncheckingPrivateNoteRetiresAnEarlierPreparedPermission(){
  val calls=CopyOnWriteArrayList<Pair<String,JSONObject>>();var view by mutableStateOf(state(prepared("original-private-note-package")))
  compose.setContent{ZoteroArchiveDialog(view,{c,p->calls+=c to JSONObject(p.toString());if(c=="zotero.prepare")view=state(prepared("original-private-note-package").put("preparationRequestID",p.getString("preparationRequestID")))},{})}
  compose.onNodeWithText("按当前选项重新准备材料").performClick();compose.onNodeWithText("确认存档").assertIsEnabled()
  compose.onAllNodes(isToggleable()).onLast().performClick()
  compose.onNodeWithText("确认存档").performTouchInput{click()}
  assertTrue("Deselected private material must not upload through an older preparedID",calls.none{it.first=="zotero.archive"})
  compose.onNodeWithText("确认存档").assertIsNotEnabled()
 }
 @Test fun latePrepareForEarlierOptionsDoesNotGrantCurrentConfirmation(){
  var view by mutableStateOf(state(null));val calls=CopyOnWriteArrayList<Pair<String,JSONObject>>()
  compose.setContent{ZoteroArchiveDialog(view,{c,p->calls+=c to JSONObject(p.toString())},{})}
  compose.onNodeWithText("核验并准备材料").performClick();assertTrue(calls.single().second.getBoolean("includeNote"))
  compose.onAllNodes(isToggleable()).onLast().performClick()
  compose.runOnIdle{view=state(prepared("late-original-private-note-package").put("preparationRequestID",calls.single().second.getString("preparationRequestID")))}
  compose.onNodeWithText("确认存档").performTouchInput{click()}
  assertTrue("A late prior-options result must not authorize archive",calls.none{it.first=="zotero.archive"});compose.onNodeWithText("确认存档").assertIsNotEnabled()
 }
 @Test fun oldPreviewWithoutOptionBindingMustBePreparedAgain(){
  val calls=CopyOnWriteArrayList<String>();var view by mutableStateOf(state(prepared("legacy-preview",false)))
  compose.setContent{ZoteroArchiveDialog(view,{c,p->calls+=c;if(c=="zotero.prepare")view=state(prepared("legacy-preview",false).put("preparationRequestID",p.getString("preparationRequestID")))},{})}
  compose.onNodeWithText("按当前选项重新准备材料").performClick();assertTrue(calls.contains("zotero.prepare"))
  compose.onNodeWithText("确认存档").performTouchInput{click()};assertTrue(calls.none{it=="zotero.archive"});compose.onNodeWithText("确认存档").assertIsNotEnabled()
 }
 @Test fun exactBoundOptionsConfirmOnlyTheOriginalPreparedID(){
  // Tighten the original positive fixture: a visible prior journal is not this dialog's prepare permission.
  var view by mutableStateOf(state(prepared("actual-bound-package")));var preparations=0
  val calls=CopyOnWriteArrayList<Pair<String,JSONObject>>()
  compose.setContent{ZoteroArchiveDialog(view,{c,p->if(c=="zotero.prepare"){preparations++;view=state(prepared("actual-bound-package").put("preparationRequestID",p.getString("preparationRequestID")))}else calls+=c to JSONObject(p.toString())},{})}
  compose.onNodeWithText("按当前选项重新准备材料").performClick();compose.waitForIdle();assertEquals(1,preparations)
  compose.onNodeWithText("确认存档").assertIsEnabled().performClick();assertEquals(1,calls.size);assertEquals("zotero.archive",calls.single().first);assertEquals("actual-bound-package",calls.single().second.getString("preparedID"))
 }
 @Test fun aFreshMatchingRequestCanArchiveTheNewSelectionOnce(){
  var view by mutableStateOf(state(null));val calls=CopyOnWriteArrayList<Pair<String,JSONObject>>()
  compose.setContent{ZoteroArchiveDialog(view,{c,p->calls+=c to JSONObject(p.toString())},{})}
  compose.onAllNodes(isToggleable()).onLast().performClick();compose.onNodeWithText("核验并准备材料").performClick()
  val request=calls.single().second;assertEquals(false,request.opt("includeNote"))
  compose.runOnIdle{val p=prepared("new-excludes-private-note").put("options",options().put("includeNote",false)).put("preparationRequestID",request.getString("preparationRequestID"));view=state(p)}
  compose.onNodeWithText("确认存档").assertIsEnabled().performClick();assertEquals("new-excludes-private-note",calls.single{it.first=="zotero.archive"}.second.getString("preparedID"))
 }
 @Test fun changingOptionsAwayAndBackStillRequiresANewExplicitPreparation(){
  val calls=CopyOnWriteArrayList<String>();var view by mutableStateOf(state(prepared("old-includes-private-note")))
  compose.setContent{ZoteroArchiveDialog(view,{c,p->calls+=c;if(c=="zotero.prepare")view=state(prepared("old-includes-private-note").put("preparationRequestID",p.getString("preparationRequestID")))},{})}
  compose.onNodeWithText("按当前选项重新准备材料").performClick();compose.onNodeWithText("确认存档").assertIsEnabled()
  repeat(2){compose.onAllNodes(isToggleable()).onLast().performClick()}
  compose.onNodeWithText("确认存档").performTouchInput{click()};compose.onNodeWithText("确认存档").assertIsNotEnabled();assertTrue(calls.none{it=="zotero.archive"})
 }

 @Test fun closingAndReopeningAfterSamePaperSourceChangedCannotClaimThePriorPreview(){
  var show by mutableStateOf(true);var view by mutableStateOf(state(prepared("old-version-package")));val calls=CopyOnWriteArrayList<Pair<String,JSONObject>>()
  compose.setContent{if(show)ZoteroArchiveDialog(view,{c,p->calls+=c to JSONObject(p.toString());if(c=="zotero.prepare")view=state(prepared("old-version-package").put("preparationRequestID",p.optString("preparationRequestID","00000000-0000-0000-0000-000000000001")))},{show=false})else androidx.compose.material3.Button({show=true}){androidx.compose.material3.Text("重开原文存档")}}
  compose.onNodeWithText("按当前选项重新准备材料").performClick();compose.waitForIdle();compose.onNodeWithText("确认存档").assertIsEnabled()
  compose.onNodeWithText("关闭").performClick()
  compose.runOnIdle{view=view.copy(papers=listOf(com.nanless.paperdigest.data.Paper("original-paper","Synthetic same identity newer source",sourceVersion="2610.00001v2")),article=com.nanless.paperdigest.data.Article("original-paper","<p>New original revision</p>","New original revision","https://example.invalid/v2","https://example.invalid/blog","b".repeat(64),"2026-10-25",sourceVersion="2610.00001v2"))}
  compose.onNodeWithText("重开原文存档").performClick();compose.onNodeWithText("确认存档").performTouchInput{click()}
  compose.onNodeWithText("确认存档").assertIsNotEnabled();assertTrue("Reopening must not authorize the old material just because paperID and checkboxes match",calls.none{it.first=="zotero.archive"})
 }

 @Test fun changingTheReadingMaterialRetiresAnOtherwiseMatchingPreparedPermission(){
  var view by mutableStateOf(state(null));val calls=CopyOnWriteArrayList<Pair<String,JSONObject>>()
  compose.setContent{ZoteroArchiveDialog(view,{c,p->calls+=c to JSONObject(p.toString())},{})}
  compose.onNodeWithText("核验并准备材料").performClick()
  val oldRequest=calls.single().second;assertEquals("material-a",oldRequest.getString("readingMaterialID"))
  compose.runOnIdle{view=state(prepared("original-source-package").put("preparationRequestID",oldRequest.getString("preparationRequestID")))}
  compose.onNodeWithText("确认存档").assertIsEnabled()
  compose.runOnIdle{view=view.copy(readingMaterialID="material-b")}
  compose.onNodeWithText("确认存档").assertIsNotEnabled().performTouchInput{click()}
  assertTrue(calls.none{it.first=="zotero.archive"})
  compose.onNodeWithText("按当前选项重新准备材料").performClick()
  val newRequest=calls.last().second;assertEquals("material-b",newRequest.getString("readingMaterialID"))
  // Even a matching current nonce cannot grant permission for the earlier source version.
  compose.runOnIdle{view=view.copy(zotero=JSONObject().put("libraryID","123").put("prepared",prepared("late-wrong-source").put("preparationRequestID",newRequest.getString("preparationRequestID"))))}
  compose.onNodeWithText("确认存档").assertIsNotEnabled()
  compose.runOnIdle{view=view.copy(zotero=JSONObject().put("libraryID","123").put("prepared",prepared("current-source-package").put("readingMaterialID","material-b").put("preparationRequestID",newRequest.getString("preparationRequestID"))))}
  compose.onNodeWithText("确认存档").assertIsEnabled().performClick()
  val archive=calls.single{it.first=="zotero.archive"}.second
  assertEquals("current-source-package",archive.getString("preparedID"));assertEquals("material-b",archive.getString("readingMaterialID"))
 }
 @Test fun aPreviewMissingTheReadingMaterialBindingCannotBeConfirmed(){
  var view by mutableStateOf(state(null));val calls=CopyOnWriteArrayList<Pair<String,JSONObject>>()
  compose.setContent{ZoteroArchiveDialog(view,{c,p->calls+=c to JSONObject(p.toString())},{})}
  compose.onNodeWithText("核验并准备材料").performClick()
  compose.runOnIdle{val preview=prepared("legacy-no-source-binding").put("preparationRequestID",calls.single().second.getString("preparationRequestID"));preview.remove("readingMaterialID");view=state(preview)}
  compose.onNodeWithText("确认存档").assertIsNotEnabled().performTouchInput{click()}
  assertTrue(calls.none{it.first=="zotero.archive"})
 }

 @Test fun changingSelectedPrivateMaterialsRetiresThePreviouslyEnabledPreview(){
  var view by mutableStateOf(state(null));val calls=CopyOnWriteArrayList<Pair<String,JSONObject>>()
  compose.setContent{ZoteroArchiveDialog(view,{c,p->calls+=c to JSONObject(p.toString())},{})}
  compose.onNodeWithText("核验并准备材料").performClick()
  val prepared=prepared("original-private-records").put("preparationRequestID",calls.single().second.getString("preparationRequestID"))
  compose.runOnIdle{view=state(prepared)}
  compose.onNodeWithText("确认存档").assertIsEnabled()
  compose.runOnIdle{view=state(JSONObject(prepared.toString()).put("materialsCurrent",false))}
  compose.onNodeWithText("确认存档").assertIsNotEnabled().performTouchInput{click()}
  assertTrue("Changed private note/session roles cannot inherit the prior confirmation",calls.none{it.first=="zotero.archive"})
  compose.runOnIdle{val legacy=JSONObject(prepared.toString());legacy.remove("materialsCurrent");view=state(legacy)}
  compose.onNodeWithText("确认存档").assertIsNotEnabled().performTouchInput{click()}
  assertTrue("Missing current-materials status is not permission",calls.none{it.first=="zotero.archive"})
 }

}
