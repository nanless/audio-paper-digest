package com.nanless.paperdigest.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Controlled regression: no real Root, keys, files or user-data writes. */
class SessionBindingInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private fun record(id:String,owner:String,hash:Char,answer:String)=JSONObject().put("id",id).put("paperID",owner).put("inputSHA256",hash.toString().repeat(64)).put("question","Original question $id/$hash").put("answer",answer).put("status","completed").put("source",JSONObject().put("kind","published-guide").put("sourceVersion","v1"))
 private class Controller(initial:UiState):AppController {
  override val state=MutableStateFlow(initial)
  val calls=mutableListOf<Pair<String,JSONObject>>()
  override suspend fun execute(command:String,payload:JSONObject):JSONObject {
   calls+=command to JSONObject(payload.toString())
   require(command=="personal.note")
   val personal=JSONObject(state.value.personal.toString());val notes=personal.getJSONObject("notes");val owner=payload.getString("paperID");val old=notes.getJSONObject(owner)
   require(old.getInt("revision")==payload.getInt("baseRevision")){"Revision conflict"}
   notes.put(owner,JSONObject().put("text",payload.getString("text")).put("revision",old.getInt("revision")+1))
   state.value=state.value.copy(personal=personal)
   return JSONObject().put("saved",true)
  }
  override suspend fun updateSecret(kind:SecretKind,value:String?){error("No secret access in this fixture")}
  override suspend fun updatePdfSelection(selection:PdfSelection){error("No PDF access in this fixture")}
 }
 private fun verifyRetiredConfirmation(changeID:Boolean,changeOwner:Boolean) {
  val a=record("session-A","paper-A",'a',"Original answer A")
  val b=record(if(changeID)"session-B" else "session-A",if(changeOwner)"paper-B" else "paper-A",'b',"Replacement answer B")
  val notes=JSONObject().put("paper-A",JSONObject().put("text","Original note A").put("revision",7)).put("paper-B",JSONObject().put("text","Original note B").put("revision",7))
  val controller=Controller(UiState(sessions=listOf(a),personal=JSONObject().put("notes",notes)))
  val before=controller.state.value.personal.toString();val originalA=a.toString();val originalB=b.toString()
  var selected by mutableStateOf("session-A")
  compose.setContent{val state by controller.state.collectAsState();MaterialTheme{SessionPane(state,selected,controller,{_,_->})}}
  compose.onNodeWithText("追加到原论文笔记…").performScrollTo().performClick()
  compose.onNodeWithText("追加到这条记录所属论文的笔记？").assertIsDisplayed()
  compose.runOnIdle{controller.state.value=controller.state.value.copy(sessions=listOf(b));selected=b.getString("id")}
  compose.waitForIdle()
  // A correct implementation may retire the dialog, or leave a visible explanation and reject its old confirmation.
  val confirm=compose.onAllNodesWithText("保留原笔记并追加")
  if(confirm.fetchSemanticsNodes().isNotEmpty())confirm[0].performClick()
  compose.waitForIdle()
  assertTrue("A confirmation must not issue a write after its session/owner/material changed",controller.calls.none{it.first=="personal.note"})
  assertEquals("Both original notes must remain byte-identical",before,controller.state.value.personal.toString())
  assertEquals(originalA,a.toString());assertEquals(originalB,b.toString())
 }
 @Test fun openAConfirmationThenSwitchSelectedIdToBDoesNotWriteEitherNote()=verifyRetiredConfirmation(changeID=true,changeOwner=true)
 @Test fun sameSessionIdChangedOwnerAndInputCannotReuseOldBaseNote()=verifyRetiredConfirmation(changeID=false,changeOwner=true)
 @Test fun sameSessionAndOwnerChangedInputCannotMixOriginalNoteWithReplacementAnswer()=verifyRetiredConfirmation(changeID=false,changeOwner=false)
}
