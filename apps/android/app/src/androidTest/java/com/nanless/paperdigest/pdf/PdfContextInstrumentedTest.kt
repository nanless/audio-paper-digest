package com.nanless.paperdigest.pdf

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PdfContextInstrumentedTest {
 @get:Rule val compose=createAndroidComposeRule<PdfSwitchHarnessActivity>()
 @Test fun delayedOldSearchCannotNavigateTheNewPdfEvenWhenProviderIgnoresCancellation(){
  compose.waitUntil(30000){compose.onAllNodesWithText("原文已载入 · 物理页 1 / 13").fetchSemanticsNodes().isNotEmpty()}
  compose.onNodeWithText("查找").performClick()
  compose.onNodeWithText("查找 PDF 原文").performTextInput("MiCLA")
  compose.onNodeWithText("查找原文").performClick()
  compose.waitUntil(15000){compose.activity.started.isCompleted}
  compose.onNodeWithText("切换原件").performClick()
  compose.waitUntil(30000){compose.onAllNodesWithText("原文已载入 · 物理页 1 / 1").fetchSemanticsNodes().isNotEmpty()}
  assertEquals(compose.activity.second.sha256,compose.activity.current!!.sha256)
  compose.activity.navigation.clear()
  compose.activity.release.complete(Unit)
  compose.waitUntil(10000){compose.activity.returned.isCompleted};compose.waitForIdle()
  assertTrue("old search must emit zero navigation to the current PDF",compose.activity.navigation.isEmpty())
  compose.onNodeWithText("原文匹配 1 /",substring=true).assertDoesNotExist()
  compose.onNodeWithText("原文已载入 · 物理页 1 / 1").assertIsDisplayed()
 }
}
