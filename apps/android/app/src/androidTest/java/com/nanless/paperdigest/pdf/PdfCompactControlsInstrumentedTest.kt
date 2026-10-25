package com.nanless.paperdigest.pdf

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.json.JSONObject
import java.io.File

class PdfCompactControlsInstrumentedTest {
 @get:Rule val compose=createAndroidComposeRule<PdfCompactHarnessActivity>()
 private fun ready(page:Int=1){compose.waitUntil(30000){compose.onAllNodesWithText("原文已载入 · 物理页 $page / 13").fetchSemanticsNodes().isNotEmpty()}}
 private fun surface(){
  var report=JSONObject()
  compose.activityRule.scenario.onActivity{activity->
   val fragment=activity.supportFragmentManager.fragments.filterIsInstance<DigestPdfFragment>().single();assertTrue(fragment.documentReady);assertEquals(13,fragment.loadedPageCount)
   fun views(v:android.view.View):List<android.view.View> = listOf(v)+(if(v is android.view.ViewGroup)(0 until v.childCount).flatMap{views(v.getChildAt(it))}else emptyList())
   val view=views(fragment.requireView()).filterIsInstance<androidx.pdf.view.PdfView>().single();val visible=android.graphics.Rect();assertTrue(view.getGlobalVisibleRect(visible));val density=activity.resources.displayMetrics.density
   assertTrue("Short-screen toolbar must leave a real measured PDF viewport",view.height/density>=120f);assertTrue(visible.width()>0&&visible.height()>0)
   report=JSONObject().put("widthPixels",view.width).put("heightPixels",view.height).put("density",density.toDouble()).put("fixtureWidthDp",320).put("fixtureHeightDp",320).put("composeFontScale",2)
  }
  val folder=compose.activity.getExternalFilesDir("qa")!!;report.write(File(folder,"pdf-compact-api${android.os.Build.VERSION.SDK_INT}.json"));UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).waitForIdle();assertTrue(UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).takeScreenshot(File(folder,"pdf-compact-api${android.os.Build.VERSION.SDK_INT}.png")))
 }
 private fun JSONObject.write(file:File){file.writeText(toString(2))}
 @Test fun compactToolsKeepEveryActionAndMeasuredDocumentAtFontTwo(){
  ready();compose.onNodeWithContentDescription("原文工具").assertIsDisplayed().performClick()
  for(label in listOf("跳转页码","查找","选取本页文字","保存标注","放大"))compose.onNodeWithText(label).assertExists()
  compose.onNodeWithText("保存标注").assertIsNotEnabled();compose.onNodeWithText("放大").assertIsEnabled().performClick();surface()
 }
 @Test fun actualPageDialogAndPdfBoxSearchRemainUsableWithoutConsumingTheDocument(){
  ready();compose.onNodeWithText("1 / 13").performClick();compose.onNodeWithText("跳转到原文物理页").assertIsDisplayed()
  compose.onNode(hasSetTextAction()).performTextReplacement("0");compose.onNodeWithText("跳转",useUnmergedTree=true).performClick();compose.onNodeWithText("页码须为1–13").assertExists()
  compose.onNode(hasSetTextAction()).performTextReplacement("2");compose.onNodeWithText("跳转",useUnmergedTree=true).performClick();ready(2)
  compose.onNodeWithContentDescription("原文工具").performClick();compose.onNodeWithText("查找").performClick();compose.onNode(hasSetTextAction()).performTextInput("MiCLA");compose.onNodeWithText("查找原文").performClick()
  compose.waitUntil(20000){compose.onAllNodesWithText("原文匹配 1 /",substring=true).fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithText("下一个结果").performScrollTo().performClick()
  compose.onNodeWithText("原文匹配 2 /",substring=true).assertExists()
  compose.onNodeWithText("关闭查找").assertIsDisplayed().assertIsEnabled()
  val device=UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
  val close=requireNotNull(device.wait(androidx.test.uiautomator.Until.findObject(androidx.test.uiautomator.By.text("关闭查找")),5000))
  assertTrue(close.isEnabled);assertFalse(close.visibleBounds.isEmpty);close.click()
  compose.waitUntil(10000){compose.onAllNodesWithText("关闭查找").fetchSemanticsNodes().isEmpty()}
  compose.waitUntil(10000){var hidden=false;compose.activityRule.scenario.onActivity{hidden=androidx.core.view.ViewCompat.getRootWindowInsets(it.window.decorView)?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime())==false};hidden}
  compose.waitForIdle();device.waitForIdle();surface()
 }
}
