package com.nanless.paperdigest.pdf

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PdfPageJumpInstrumentedTest {
 @get:Rule val compose=createAndroidComposeRule<PdfPageJumpHarnessActivity>()
 private fun ready(page:Int=1,count:Int=13){compose.waitUntil(30000){compose.onAllNodesWithText("原文已载入 · 物理页 $page / $count").fetchSemanticsNodes().isNotEmpty()}}
 private fun open(){compose.onNodeWithContentDescription("跳转页码").assertIsDisplayed().performClick();compose.onNodeWithText("跳转到原文物理页").assertIsDisplayed()}
 @Test fun pageDraftSurvivesRealImeAndCompactTransitionAndUnderlyingPageChanges(){
  ready();assertEquals(13,compose.activity.first.pageCount);open()
  compose.onNode(hasSetTextAction()).performTextReplacement("2")
  compose.onNode(hasSetTextAction()).performClick()
  compose.waitUntil(10000){var visible=false;compose.activityRule.scenario.onActivity{visible=androidx.core.view.ViewCompat.getRootWindowInsets(it.window.decorView)?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime())==true};visible}
  compose.activityRule.scenario.onActivity{it.compact=true;it.page=3}
  assertEquals("2",compose.onNode(hasSetTextAction()).fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
  compose.onNodeWithText("跳转",useUnmergedTree=true).performClick();ready(2)
  assertEquals(compose.activity.first.sha256 to 2,compose.activity.navigation.last())
  assertTrue(compose.activity.navigation.all{it.first==compose.activity.first.sha256})
  compose.activityRule.scenario.onActivity{assertEquals(13,it.supportFragmentManager.fragments.filterIsInstance<DigestPdfFragment>().single().loadedPageCount)}
 }
 @Test fun cancelDoesNotNavigateAndChangingOriginalRetiresEvenCapturedJumpAction(){
  ready();open();compose.onNode(hasSetTextAction()).performTextReplacement("2");compose.onNodeWithText("取消").performClick()
  assertTrue(compose.activity.navigation.isEmpty());assertEquals(1,compose.activity.page)
  open();compose.onNode(hasSetTextAction()).performTextReplacement("2")
  val oldAction=compose.onNode(hasText("跳转") and hasClickAction()).fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
  compose.activityRule.scenario.onActivity{it.current=it.second;it.page=1}
  compose.waitForIdle();compose.onNodeWithText("跳转到原文物理页").assertDoesNotExist()
  compose.runOnIdle{
   val failure=runCatching{oldAction()}.exceptionOrNull()
   if(failure!=null){assertTrue("Only the real framework detached-node rejection may retire a captured semantics action",failure is IllegalStateException && failure.message.orEmpty().contains("Modifier node is not currently attached"));println("PD_OLD_JUMP_FRAMEWORK_REJECTED_BEFORE_APP_CALLBACK=true")}
  }
  assertTrue("Disposed source must emit zero late navigation",compose.activity.navigation.isEmpty());ready(1,1)
  assertEquals(compose.activity.second.sha256,compose.activity.current!!.sha256)
 }
}
