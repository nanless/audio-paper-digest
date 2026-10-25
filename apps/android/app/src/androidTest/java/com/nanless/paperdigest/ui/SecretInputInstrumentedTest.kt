package com.nanless.paperdigest.ui

import android.text.InputType
import android.view.View
import android.view.inputmethod.EditorInfo
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.core.view.inputmethod.EditorInfoCompat
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.UiController
import androidx.test.espresso.ViewAction
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.matcher.ViewMatchers.isRoot
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.flow.MutableStateFlow
import org.hamcrest.Matcher
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Inspects real platform EditorInfo with an inert synthetic value; no real credential read/write or screenshots. */
class SecretInputInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private class Controller:AppController {
  override val state=MutableStateFlow(UiState(settings=JSONObject().put("endpoint","https://model-review.invalid/v1").put("model","review-only")))
  var calls=0
  override suspend fun execute(command:String,payload:JSONObject):JSONObject{calls++;error("No service operations in this fixture")}
  override suspend fun updateSecret(kind:SecretKind,value:String?){calls++;error("No credential storage in this fixture")}
  override suspend fun updatePdfSelection(selection:PdfSelection){error("No PDF in this fixture")}
 }
 private data class Observed(val inputType:Int,val imeOptions:Int,val beforeLength:Int?,val autofillOptOut:Boolean,val ownerClass:String)
 private fun capture():Observed {
  val controller=Controller()
  compose.setContent{val state by controller.state.collectAsState();MaterialTheme{SettingsPane(state,controller,{_,_->},{})}}
  compose.onNodeWithText("模型").performClick()
  compose.onNodeWithText("为已保存连接设置模型密钥…").performScrollTo().performClick()
  compose.onNodeWithText("新的密钥").performClick().performTextInput("synthetic-editor-review-4Z9")
  compose.waitForIdle()
  var observed:Observed?=null
  onView(isRoot()).inRoot(isDialog()).perform(object:ViewAction{
   override fun getDescription()="Read numeric EditorInfo policy from the actual focused dialog view"
   override fun getConstraints():Matcher<View> = isRoot()
   override fun perform(uiController:UiController,view:View){
    uiController.loopMainThreadUntilIdle()
    val owner=view.findFocus()?:error("No actual focused dialog view; this is a fixture failure, not an input-policy RED")
    val info=EditorInfo();requireNotNull(owner.onCreateInputConnection(info)){"Actual focus did not provide InputConnection"}
    var ancestor:View?=owner;var blocked=false
    while(ancestor!=null){if(ancestor.importantForAutofill==View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS)blocked=true;ancestor=ancestor.parent as? View}
    observed=Observed(info.inputType,info.imeOptions,EditorInfoCompat.getInitialTextBeforeCursor(info,128,0)?.length,blocked,owner.javaClass.name)
   }
  })
  val result=observed?:error("EditorInfo capture did not run")
  println("SYNTHETIC_SECRET_EDITOR_POLICY "+JSONObject().put("inputType",result.inputType).put("imeOptions",result.imeOptions).put("surroundingBeforeLength",result.beforeLength?:JSONObject.NULL).put("autofillOptOut",result.autofillOptOut).put("ownerClass",result.ownerClass))
  assertEquals("Opening/typing in this fixture must never dispatch a model or write a credential",0,controller.calls)
  return result
 }
 @Test fun syntheticSecretUsesActualPasswordVariationWithoutAutocorrection(){
  val info=capture()
  assertEquals(InputType.TYPE_CLASS_TEXT,info.inputType and InputType.TYPE_MASK_CLASS)
  assertEquals("Password masking alone must not leave a plain-text IME field",InputType.TYPE_TEXT_VARIATION_PASSWORD,info.inputType and InputType.TYPE_MASK_VARIATION)
  assertEquals("API keys must not request automatic spelling correction",0,info.inputType and InputType.TYPE_TEXT_FLAG_AUTO_CORRECT)
  assertTrue("A password EditorInfo must not publish initial surrounding text",info.beforeLength==null||info.beforeLength==0)
 }
 @Test fun localCredentialDialogExplicitlyOptsOutOfLoginAutofill(){
  assertTrue("Only this credential dialog subtree must exclude login-password autofill",capture().autofillOptOut)
 }
}
