package com.nanless.paperdigest.ui

import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.TextRange
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.nanless.paperdigest.MainActivity
import com.nanless.paperdigest.PaperDigestApplication
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.CatalogRepository
import com.nanless.paperdigest.data.SafeHttp
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Request
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.UUID

/** Mutating QA operates exclusively on the two dedicated, synthetic/public-only AVDs. */
class RealWorkspaceInstrumentedTest {
 @get:Rule val compose=createAndroidComposeRule<MainActivity>()
 private val controller get()=(compose.activity.application as PaperDigestApplication).controller
 private val device get()=UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
 private val phase get()=InstrumentationRegistry.getArguments().getString("screenLabel")?:"phone"
 private fun requireQA(){val avd=device.executeShellCommand("getprop ro.boot.qemu.avd_name").trim().ifEmpty{device.executeShellCommand("getprop ro.kernel.qemu.avd_name").trim()};require(avd in setOf("PaperDigest_QA_API35","PaperDigest_QA_API28")){"This test must never modify a personal device or another AVD"}}
 private fun waitText(text:String,substring:Boolean=false){compose.waitUntil(30000){compose.onAllNodesWithText(text,substring=substring).fetchSemanticsNodes().isNotEmpty()};compose.waitForIdle()}
 private fun click(text:String){compose.onNodeWithText(text).performClick();compose.waitForIdle()}
 private fun selectReadingMode(mode:String){
  if(compose.onAllNodesWithContentDescription("选择阅读模式").fetchSemanticsNodes().isNotEmpty()){
   compose.onNodeWithContentDescription("选择阅读模式").assertIsDisplayed().performClick();waitText(mode);click(mode)
   compose.onNodeWithText("$mode ·",substring=true).assertIsDisplayed()
  }else{compose.onNodeWithText(mode).performScrollTo().assertIsDisplayed().performClick();compose.onNodeWithText(mode).assertIsSelected()}
  compose.waitForIdle()
 }
 private fun waitReadingControls(){compose.waitUntil(30000){compose.onAllNodesWithContentDescription("论文操作与导出").fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithContentDescription("论文操作与导出").assertIsDisplayed()}
 private fun pdfTool(label:String){
  if(compose.onAllNodesWithContentDescription("原文工具").fetchSemanticsNodes().isNotEmpty()){
   compose.onNodeWithContentDescription("原文工具").assertIsDisplayed().assertIsEnabled().performClick();waitText(label)
  }
  click(label)
 }
 private fun gotoPDFPage(page:Int){
  compose.onNodeWithContentDescription("跳转页码").assertIsDisplayed().assertIsEnabled().performClick();waitText("跳转到原文物理页")
  compose.onNodeWithText("页码（1–13）").performTextReplacement(page.toString());click("跳转")
  compose.onNodeWithText("跳转到原文物理页").assertDoesNotExist()
 }
 private fun nextPDFPage(){
  if(compose.onAllNodesWithContentDescription("下一页").fetchSemanticsNodes().isNotEmpty())compose.onNodeWithContentDescription("下一页").assertIsEnabled().performClick()else click("下一页")
 }
 private fun capture(name:String){compose.waitForIdle();Thread.sleep(400);val bitmap=requireNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot());val file=File(compose.activity.getExternalFilesDir("qa"),"api${Build.VERSION.SDK_INT}-$phase-$name.png");file.outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()}
 @Test fun wholeWorkspaceUsesRealSystemSaveAndOpenThenCancelKeepsResearch(){
  requireQA();waitText("文献资料库")
  val sessions=controller.state.value.sessions.size
  val paper=controller.state.value.papers.first{it.title.contains("MiCLA")}
  compose.onNodeWithText("搜索论文信息、笔记与本机已缓存导读").performTextInput("MiCLA");androidx.test.espresso.Espresso.closeSoftKeyboard();compose.waitForIdle();waitText(paper.titleZh);compose.onNodeWithText(paper.titleZh).performScrollTo().assertIsDisplayed().performClick();compose.waitForIdle()
  waitReadingControls()
  compose.waitUntil(30000){controller.state.value.article?.paperID==paper.id}
  selectReadingMode("笔记");waitText("阅读笔记")
  val previousRevision=controller.state.value.personal.getJSONObject("notes").optJSONObject(paper.id)?.optInt("revision")?:0
  val note="专用 QA 设备公开 MiCLA whole-space 笔记 ${Build.VERSION.SDK_INT}，没有私人资料或模型调用。本轮编号：${System.currentTimeMillis()}"
  compose.onNodeWithText("你的想法、疑问与结论").performTextReplacement(note)
  compose.onNodeWithText("保存笔记").performScrollTo().assertIsDisplayed().assertIsEnabled()
  val saveNote=requireNotNull(device.findObject(By.text("保存笔记"))){"Actual enabled note save button missing from system accessibility"}
  require(saveNote.isEnabled&&!saveNote.visibleBounds.isEmpty){"Actual note save button not visibly actionable"};saveNote.click();compose.waitForIdle()
  try { compose.waitUntil(10000){controller.state.value.personal.getJSONObject("notes").optJSONObject(paper.id)?.let{it.optString("text")==note&&it.optInt("revision")==previousRevision+1}==true} }
  catch(failure:Throwable){
   capture("whole-note-save-failure")
   val qa=compose.activity.getExternalFilesDir("qa")!!
   File(qa,"whole-note-save-failure-${Build.VERSION.SDK_INT}.semantics.txt").writeText(compose.onRoot(useUnmergedTree=true).printToString())
   val actual=controller.state.value.personal.getJSONObject("notes").optJSONObject(paper.id)
   val diagnostic=JSONObject().put("previousRevision",previousRevision).put("actualRevision",actual?.optInt("revision")).put("actualTextEqualsSubmitted",actual?.optString("text")==note).put("busy",controller.state.value.busy)
   compose.runOnUiThread{diagnostic.put("imeVisible",androidx.core.view.ViewCompat.getRootWindowInsets(compose.activity.window.decorView)?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()))}
   File(qa,"whole-note-save-failure-${Build.VERSION.SDK_INT}.state.json").writeText(diagnostic.toString(2));throw failure
  }
  compose.onNodeWithContentDescription("打开 PDF").performClick();waitText("原文已载入",substring=true)
  gotoPDFPage(1)
  compose.waitUntil(10000){controller.state.value.pdfPage==1};waitText("原文已载入 · 物理页 1 / 13")
  pdfTool("选取本页文字");waitText("选取物理页 1 的原文")
  val text=compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.SetSelection) and hasText("MiCLA",substring=true));val original=text.fetchSemanticsNode().config[SemanticsProperties.EditableText].text;val start=original.indexOf("MiCLA");assertTrue(start>=0)
  text.performTextInputSelection(TextRange(start,start+5));click("采用选区")
  compose.waitUntil(10000){controller.state.value.pdfSelection?.text=="MiCLA"}
  val before=controller.state.value.personal.getJSONObject("annotations").optJSONArray(paper.id)?.length()?:0
  pdfTool("保存标注");waitText("保存原文标注");compose.onNodeWithText("我的批注（可留空）").performTextInput("公开 QA whole-space 中央标注");click("保存在本机")
  compose.waitUntil(10000){(controller.state.value.personal.getJSONObject("annotations").optJSONArray(paper.id)?.length()?:0)>before}
  compose.onNodeWithContentDescription("关闭 PDF").performClick();click("设置");click("资料");waitText("完整研究资料")
  val expected=controller.state.value.personal
  val notes=expected.getJSONObject("notes").toString();val annotations=expected.getJSONObject("annotations").toString();val settings=controller.state.value.settings.toString()
  val fileName="paperdigest-whole-api${Build.VERSION.SDK_INT}-${System.currentTimeMillis()}.paperdigest"
  val existingPending=controller.state.value.pendingExports.map{it.getString("operationID")}.toSet()
  compose.onNodeWithText("保存完整备份…").performScrollTo().assertIsDisplayed().assertIsEnabled()
  PhysicalUiTestActions.clickVisible(device,"保存完整备份…",compose.activity.resources.displayMetrics.density)
  compose.waitUntil(60000){controller.state.value.pendingExports.any{it.optString("operationID") !in existingPending && it.optString("preparation")=="ready" && it.optBoolean("ready")}}
  val prepared=controller.state.value.pendingExports.single{it.optString("operationID") !in existingPending && it.optString("preparation")=="ready" && it.optBoolean("ready")}
  val operationID=prepared.getString("operationID");val documentID=prepared.getString("documentID");val readySHA=prepared.getString("sha256")
  // Preparing is deliberately not saving: the user resumes this exact ready original.
  click("任务");waitText("待保存原件")
  val pendingTag="pending-export-$operationID"
  compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasTestTag(pendingTag))
  compose.onNode(hasText("继续保存原件") and hasAnyAncestor(hasTestTag(pendingTag))).assertIsEnabled().performClick()
  compose.waitUntil(10000){controller.state.value.pendingExports.single{it.getString("operationID")==operationID}.optString("delivery")=="choosing"}
  val choosing=controller.state.value.pendingExports.single{it.getString("operationID")==operationID};assertEquals(documentID,choosing.getString("documentID"));assertEquals(readySHA,choosing.getString("sha256"));assertTrue(choosing.getString("attemptID").isNotBlank())
  val title=device.wait(Until.findObject(By.res("android","title").clazz("android.widget.EditText")),30000)
  if(title==null){
   val directory=compose.activity.getExternalFilesDir("qa")!!
   runCatching{capture("whole-save-panel-missing")};runCatching{device.dumpWindowHierarchy(File(directory,"whole-save-missing-${android.os.Build.VERSION.SDK_INT}.ax.xml"))};runCatching{File(directory,"whole-save-missing-${android.os.Build.VERSION.SDK_INT}.semantics.txt").writeText(compose.onRoot(useUnmergedTree=true).printToString())}
   val stacks=Thread.getAllStackTraces().filter{(_,frames)->frames.any{it.className.startsWith("com.nanless.paperdigest.cloud.BackupCodec")}}.entries.joinToString("\n\n"){(thread,frames)->thread.name+" "+thread.state+"\n"+frames.take(35).joinToString("\n")}
   File(directory,"whole-save-missing-${android.os.Build.VERSION.SDK_INT}.threads.txt").writeText(stacks)
  }
  requireNotNull(title){"Actual system save document dialog did not appear"}
  assertTrue(device.currentPackageName.endsWith("documentsui"));title.text=fileName
  requireNotNull(device.findObject(By.res("android","button1"))).click()
  assertTrue(device.wait(Until.hasObject(By.pkg(compose.activity.packageName).text("待保存原件")),30000));waitText("已写入所选位置，并完整回读核对字节与 SHA")
  compose.waitUntil(10000){controller.state.value.pendingExports.single{it.getString("operationID")==operationID}.optString("delivery")=="verified"}
  val verified=controller.state.value.pendingExports.single{it.getString("operationID")==operationID};assertEquals(documentID,verified.getString("documentID"));assertEquals(readySHA,verified.getString("sha256"))
  val qa=compose.activity.getExternalFilesDir("qa")!!;qa.mkdirs();val backup=File(qa,fileName)
  device.executeShellCommand("cp /sdcard/Download/$fileName ${backup.absolutePath}")
  assertTrue("the actual SAF saved original must exist",backup.isFile&&backup.length()>0)
  val verifyParent=File(compose.activity.cacheDir,"WholeVerify-${UUID.randomUUID()}").canonicalFile.also{it.mkdirs()}
  val staged=backup.inputStream().use{BackupCodec.stage(it,verifyParent)}
  try{
   val saved=JSONObject(File(staged.directory,"personal.json").readText())
   assertEquals(notes,saved.getJSONObject("notes").toString());assertEquals(annotations,saved.getJSONObject("annotations").toString())
   assertTrue(staged.entries.any{it.path.endsWith(".pdf")});assertTrue(staged.entries.any{it.path.startsWith("PublishedLibrary/articles/")})
   assertEquals(BackupCodec.hash(backup),staged.encodedSHA256);assertEquals(readySHA,staged.encodedSHA256)
   File(qa,"whole-backup-api${Build.VERSION.SDK_INT}-$phase.json").writeText(JSONObject().put("fileName",fileName).put("sha256",staged.encodedSHA256).put("fileCount",staged.entries.size).put("encodedBytes",backup.length()).put("paperID",paper.id).put("notes",saved.getJSONObject("notes").length()).put("annotations",saved.getJSONObject("annotations").getJSONArray(paper.id).length()).put("modelSessionsBefore",sessions).put("qualification","Real dedicated-AVD SAF save; public MiCLA and QA note/annotation; no paid model results fabricated").toString(2))
  }finally{verifyParent.deleteRecursively()}
  capture("whole-saf-saved")
  click("设置");click("资料");waitText("完整研究资料")
  compose.onNodeWithText("从完整备份恢复…").performScrollTo().performClick()
  requireNotNull(device.wait(Until.findObject(By.text(fileName)),30000)){"Saved original not exposed by actual system picker"}.click()
  waitText("恢复完整研究资料？");capture("whole-restore-confirm")
  compose.onNodeWithText("确认恢复").assertIsEnabled();click("取消")
  compose.onNodeWithText("恢复完整研究资料？").assertDoesNotExist()
  compose.waitUntil(10000){!controller.state.value.busy}
  assertEquals(notes,controller.state.value.personal.getJSONObject("notes").toString());assertEquals(annotations,controller.state.value.personal.getJSONObject("annotations").toString());assertEquals(settings,controller.state.value.settings.toString())
  assertEquals(sessions,controller.state.value.sessions.size);assertEquals(paper.id,controller.state.value.selectedPaperId)
  capture("whole-restore-cancelled")
 }
 @Test fun realPublishedCatalogSyncRecordsActualCountAndManifestWithoutModels()=runBlocking {
  requireQA();waitText("文献资料库");val sessions=controller.state.value.sessions.size
  assertFalse(controller.state.value.settings.optBoolean("offlineMode"))
  val summary=withTimeout(240000){controller.execute("library.sync")}
  assertTrue(summary.getInt("paperCount")>0);assertTrue(summary.getInt("recordCount")>=summary.getInt("paperCount"));assertTrue(summary.getString("snapshotID").matches(Regex("[a-f0-9]{64}")))
  val raw=withTimeout(45000){SafeHttp(timeoutMs=40000).execute(Request.Builder().url(CatalogRepository.SITE+"index.json").build(),CatalogRepository.MAX_TOTAL)}
  assertEquals(200,raw.code);assertEquals("the independently fetched published manifest must match this stable sync",summary.getString("snapshotID"),BackupCodec.hash(raw.bytes))
  assertEquals(summary.getInt("recordCount"),controller.state.value.catalogSummary.getInt("recordCount"));assertEquals(sessions,controller.state.value.sessions.size)
  val papers=controller.state.value.papers
  assertEquals("The displayed corpus must not hide duplicate or dropped identities",papers.size,papers.map{it.id}.distinct().size)
  assertTrue("All current published identities must remain reachable, including when retired papers are retained",papers.count{it.sourceKind!="local"}>=summary.getInt("paperCount"))
  val largeHeap=compose.activity.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_LARGE_HEAP != 0
  assertFalse("A corpus-memory regression must not be hidden by increasing the application heap",largeHeap)
  val runtime=Runtime.getRuntime()
  File(compose.activity.getExternalFilesDir("qa"),"real-catalog-sync-api${Build.VERSION.SDK_INT}-$phase.json").writeText(JSONObject(summary.toString()).put("independentManifestSHA256",BackupCodec.hash(raw.bytes)).put("modelSessionsBefore",sessions).put("modelSessionsAfter",controller.state.value.sessions.size).put("displayedPaperCount",papers.size).put("largeHeap",largeHeap).put("maxHeapBytes",runtime.maxMemory()).put("usedHeapBytesAfterSync",runtime.totalMemory()-runtime.freeMemory()).toString(2))
  capture("real-catalog-synced")
 }
}
