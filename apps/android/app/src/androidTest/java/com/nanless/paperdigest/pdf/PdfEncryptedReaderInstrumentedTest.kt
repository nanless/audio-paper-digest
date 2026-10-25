package com.nanless.paperdigest.pdf

import androidx.compose.runtime.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.activity.compose.setContent
import androidx.compose.ui.platform.createLifecycleAwareWindowRecomposer
import com.nanless.paperdigest.PaperDigestApplication
import com.nanless.paperdigest.ui.AppMotionDurationScale
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Actual encrypted Compose reader with private fixture repo. No Jetpack private password dialog, no model or sidecar writes. */
class PdfEncryptedReaderInstrumentedTest {
 @get:Rule val compose=createAndroidComposeRule<PdfEncryptedHostActivity>()
 @Test fun encryptedPageActuallyRendersSearchesSelectsAndSavesPortableCentralCoordinates(){
  val context=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext;val root=File(context.cacheDir,"encrypted-pane-"+UUID.randomUUID()).canonicalFile.also{it.mkdirs()};val repo=PdfRepository(context,File(root,"Research"));val source=File(root,"synthetic.pdf");val showing=mutableStateOf(true)
  try {
   PDDocument().use{pdf->pdf.addPage(PDPage());PDPageContentStream(pdf,pdf.getPage(0)).use{out->out.beginText();out.setFont(PDType1Font.HELVETICA,14f);out.newLineAtOffset(50f,700f);out.showText("Native encrypted reader evidence");out.endText()};pdf.protect(StandardProtectionPolicy("fixture-owner","fixture-reader",AccessPermission()).apply{encryptionKeyLength=128});pdf.save(source)}
   val doc=runBlocking{repo.importFile(source,password="fixture-reader")};val original=File(doc.localPath).readBytes()
   var selected:PdfSelection?=null;val marks=mutableStateOf<List<JSONObject>>(emptyList());var saves=0
   compose.activityRule.scenario.onActivity{activity->
    val controller=(activity.application as PaperDigestApplication).controller
    val recomposer=activity.window.decorView.createLifecycleAwareWindowRecomposer(coroutineContext=AppMotionDurationScale(activity,controller),lifecycle=activity.lifecycle)
    activity.setContent(parent=recomposer){MaterialTheme{if(showing.value)Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)){PdfReaderPane(document=doc,page=1,onPageChanged={assertEquals(1,it)},onSelection={selected=it},modifier=Modifier.fillMaxSize(),onError={throw AssertionError(it)},onSaveAnnotation={selection,note->val dto=repo.prepareAnnotation(doc,selection,note);marks.value=repo.portableMarks(doc,dto);saves++},annotationRevision=marks.value.size.toString(),portableAnnotations=marks.value,repository=repo)}}}
   }
   compose.waitUntil(30000){compose.onAllNodesWithContentDescription("已解锁原文物理页 1 / 1").fetchSemanticsNodes().isNotEmpty()}
   compose.onNodeWithContentDescription("已解锁原文物理页 1 / 1").assertIsDisplayed()
   compose.onNodeWithText("查找").assertIsEnabled().performClick();compose.onNodeWithText("查找 PDF 原文").performTextInput("Native");compose.onNodeWithText("查找原文").performClick()
   compose.waitUntil(10000){compose.onAllNodesWithText("原文匹配 1 / 1",substring=true).fetchSemanticsNodes().isNotEmpty()}
   compose.onNodeWithText("关闭查找").performClick();compose.onNodeWithText("选取本页文字").performClick()
   val field=compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.SetSelection) and hasText("Native encrypted reader evidence",substring=true));val text=field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text;val start=text.indexOf("Native");assertTrue(start>=0);field.performTextInputSelection(TextRange(start,start+6));compose.onNodeWithText("采用选区").assertIsEnabled().performClick()
   compose.waitUntil(10000){selected?.text=="Native"};assertEquals(doc.sha256,selected!!.documentSHA256);assertTrue(selected!!.bounds.isNotEmpty())
   compose.onNodeWithText("保存标注").assertIsEnabled().performClick();compose.onNodeWithText("我的批注（可留空）").performTextInput("synthetic encrypted coordinate note");compose.onNodeWithText("保存在本机").performClick();compose.waitUntil(10000){saves==1}
   assertTrue(marks.value.isNotEmpty());marks.value.forEach{assertEquals(doc.sha256,it.getString("pdfSHA"));assertEquals("pdf-user-space-unrotated-v1",it.getString("coordinateSystem"));assertEquals("Native",it.getString("text"))}
   assertFalse(File(root,"Research/PdfAnnotations/${doc.sha256}.json").exists());assertArrayEquals(original,File(doc.localPath).readBytes());compose.runOnIdle{showing.value=false};compose.waitForIdle()
  }finally{compose.runOnIdle{showing.value=false};compose.waitForIdle();repo.clearSessionPasswords();root.deleteRecursively()}
 }
}
