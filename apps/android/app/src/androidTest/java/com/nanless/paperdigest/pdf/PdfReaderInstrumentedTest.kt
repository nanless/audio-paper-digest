package com.nanless.paperdigest.pdf

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PdfReaderInstrumentedTest {
 @get:Rule val compose=createAndroidComposeRule<PdfHarnessActivity>()
 private fun assertSystemSafeControl(id:Int){
  compose.activityRule.scenario.onActivity{activity->
   val root=activity.window.decorView;val inset=requireNotNull(androidx.core.view.ViewCompat.getRootWindowInsets(root)).getInsetsIgnoringVisibility(androidx.core.view.WindowInsetsCompat.Type.systemBars());val visible=android.graphics.Rect();val view=requireNotNull(activity.findViewById<android.view.View>(id));assertTrue(view.getGlobalVisibleRect(visible));assertTrue("Native search control must be fully below the system status bar",visible.top>=inset.top);assertTrue("Native search control must not overlap the real system navigation area",visible.bottom<=root.height-inset.bottom)
   assertEquals(androidx.lifecycle.Lifecycle.State.RESUMED,activity.lifecycle.currentState)
  }
  val instrument=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation();assertEquals(instrument.targetContext.packageName,androidx.test.uiautomator.UiDevice.getInstance(instrument).currentPackageName)
 }
 private fun matchOrdinal():Int {var ordinal=-1;compose.activityRule.scenario.onActivity{activity->ordinal=Regex("[0-9]+").find(activity.findViewById<android.widget.TextView>(androidx.pdf.R.id.matchStatusTextView)?.text?.toString().orEmpty())?.value?.toInt()?:-1};return ordinal}
 @Test fun actualNativeViewerLoadsThirteenPagesAndNavigatesWithPhysicalPageControls(){
  compose.waitUntil(30000){compose.onAllNodesWithText("原文已载入 · 物理页 1 / 13").fetchSemanticsNodes().isNotEmpty()}
  compose.activityRule.scenario.onActivity{activity->
   val fragment=activity.supportFragmentManager.fragments.filterIsInstance<DigestPdfFragment>().single();assertEquals(13,fragment.loadedPageCount);assertTrue(fragment.documentReady)
   fun surfaces(view:android.view.View):List<androidx.pdf.view.PdfView> = (if(view is androidx.pdf.view.PdfView)listOf(view)else emptyList())+(if(view is android.view.ViewGroup)(0 until view.childCount).flatMap{surfaces(view.getChildAt(it))}else emptyList())
   val surface=surfaces(fragment.requireView()).single();assertTrue("Ready requires an attached, measured native rendering surface",surface.isAttachedToWindow&&surface.width>0&&surface.height>0)
  }
  compose.onNodeWithText("下一页").performClick()
  compose.waitUntil(10000){compose.onAllNodesWithText("原文已载入 · 物理页 2 / 13").fetchSemanticsNodes().isNotEmpty()}
  compose.onNodeWithText("上一页").performClick()
  compose.waitUntil(10000){compose.onAllNodesWithText("原文已载入 · 物理页 1 / 13").fetchSemanticsNodes().isNotEmpty()}
  compose.onNodeWithText("选取本页文字").performClick()
  compose.waitUntil(10000){compose.onAllNodesWithText("选取物理页 1 的原文").fetchSemanticsNodes().isNotEmpty()}
  compose.onNodeWithText("采用选区").assertIsNotEnabled()
  compose.onNodeWithText("取消").performClick()
  compose.onNodeWithText("查找").assertIsEnabled().performClick()
  var nativeSearch=false
  compose.activityRule.scenario.onActivity{activity->nativeSearch=activity.supportFragmentManager.fragments.filterIsInstance<DigestPdfFragment>().single().nativeSearchAvailable}
  if(nativeSearch){
  androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.withId(androidx.pdf.R.id.searchQueryBox)).perform(androidx.test.espresso.action.ViewActions.replaceText("MiCLA"),androidx.test.espresso.action.ViewActions.closeSoftKeyboard())
  compose.waitUntil(15000){var found=false;compose.activityRule.scenario.onActivity{activity->val status=activity.findViewById<android.widget.TextView>(androidx.pdf.R.id.matchStatusTextView)?.text?.toString().orEmpty();val numbers=Regex("[0-9]+").findAll(status).map{it.value.toInt()}.toList();found=numbers.size>=2&&numbers.last()>0};found}
  assertSystemSafeControl(androidx.pdf.R.id.findNextButton);val firstMatch=matchOrdinal();assertTrue(firstMatch>0)
  androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.withId(androidx.pdf.R.id.findNextButton)).check(androidx.test.espresso.assertion.ViewAssertions.matches(androidx.test.espresso.matcher.ViewMatchers.isEnabled())).perform(androidx.test.espresso.action.ViewActions.click())
  compose.waitUntil(10000){matchOrdinal()>0&&matchOrdinal()!=firstMatch};assertSystemSafeControl(androidx.pdf.R.id.closeButton)
  androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.withId(androidx.pdf.R.id.closeButton)).perform(androidx.test.espresso.action.ViewActions.click())
  compose.waitUntil(10000){var closed=false;compose.activityRule.scenario.onActivity{activity->closed=activity.findViewById<android.view.View>(androidx.pdf.viewer.fragment.R.id.pdfSearchView)?.isShown==false};closed}
  }else{
   compose.onNodeWithText("查找 PDF 原文").performTextInput("MiCLA")
   compose.onNodeWithText("查找原文").performClick()
   compose.waitUntil(20000){compose.onAllNodesWithText("原文匹配 1 /",substring=true).fetchSemanticsNodes().isNotEmpty()}
   compose.onNodeWithText("下一个结果").assertIsEnabled().performClick()
   compose.onNodeWithText("原文匹配 2 /",substring=true).assertIsDisplayed()
   compose.onNodeWithText("关闭查找").performClick()
   compose.onNodeWithText("查找 PDF 原文").assertDoesNotExist()
  }
  val instrument=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation();assertEquals(instrument.targetContext.packageName,androidx.test.uiautomator.UiDevice.getInstance(instrument).currentPackageName)
  compose.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.DESTROYED)
  assertEquals("The actual PDF host must close completely",androidx.lifecycle.Lifecycle.State.DESTROYED,compose.activityRule.scenario.state)
 }
}
