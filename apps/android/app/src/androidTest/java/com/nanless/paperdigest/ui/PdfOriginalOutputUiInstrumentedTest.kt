package com.nanless.paperdigest.ui

import android.app.Activity
import android.content.ContextWrapper
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.pdf.*
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.*
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Actual menu/dialog and typed capability path. System actions are explicitly mocked; no chooser/printing acceptance. */
class PdfOriginalOutputUiInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private class Fixture(encrypted:Boolean=false,forgetPassword:Boolean=true) {
  val target=InstrumentationRegistry.getInstrumentation().targetContext
  val root=File(target.cacheDir,"PdfOutputMenu-${UUID.randomUUID()}").canonicalFile.also{it.mkdirs()}
  val context=object:ContextWrapper(target){override fun getNoBackupFilesDir()=root}
  val original=File(root,"synthetic-original.pdf")
  val repository:PdfRepository
  val document:PdfDocumentRef
  val originalSHA:String
  val snapshots=mutableListOf<PdfOriginalSnapshot>()
  init {
   PDFBoxResourceLoader.init(target.applicationContext)
   PDDocument().use{pdf->pdf.addPage(PDPage());if(encrypted)pdf.protect(StandardProtectionPolicy("synthetic-owner","synthetic-reader",AccessPermission().apply{setCanPrint(true)}).apply{encryptionKeyLength=128});pdf.save(original)}
   repository=PdfRepository(context,File(root,"Research"));document=runBlocking{repository.importFile(original,password=if(encrypted)"synthetic-reader"else null)}
   if(encrypted&&forgetPassword)repository.clearSessionPasswords()
   originalSHA=BackupCodecForTest.hash(original)
  }
  val paper get()=Paper(document.id,"Synthetic PDF original","合成原文",sourceKind="local",pdfSHA256=document.sha256,localPDFPath=document.localPath)
  inner class Controller:AppController {
   override val state=MutableStateFlow(UiState(papers=listOf(paper),viewedPaper=paper,selectedPaperId=paper.id,readingMaterialID="a".repeat(64),pdfMode=true,pdfDocument=document,pdfReceipt=JSONObject().put("paperID",paper.id).put("sha256",document.sha256),pendingExportsLoading=false))
   val typedTokens=mutableListOf<String>();val commands=mutableListOf<JSONObject>()
   override suspend fun prepareOriginalPdfOutput(expectedReadingMaterialID:String):PdfOriginalSnapshot {
    typedTokens+=expectedReadingMaterialID
    check(expectedReadingMaterialID==state.value.readingMaterialID)
    return PdfOriginalSnapshot.prepare(context,repository,document,paper.id){check(expectedReadingMaterialID==state.value.readingMaterialID)}.also{snapshots+=it}
   }
   override suspend fun execute(command:String,payload:JSONObject):JSONObject {commands+=payload.copy();error("No command JSON is authorized for original output")}
   override suspend fun updateSecret(kind:SecretKind,value:String?){error("No account credential")}
   override suspend fun updatePdfSelection(selection:PdfSelection){error("No selection")}
  }
  fun assertOriginal(){assertEquals(originalSHA,BackupCodecForTest.hash(original));assertEquals(document.sha256,BackupCodecForTest.hash(File(document.localPath)))}
  fun close(){snapshots.forEach{it.discardIfUnhanded()};repository.clearSessionPasswords();root.deleteRecursively()}
 }
 private class Actions:PdfOriginalOutputActions {
  var shares=0;var prints=0
  override suspend fun inspect(snapshot:PdfOriginalSnapshot)=PdfOriginalPrintAdapter.inspect(snapshot)
  override suspend fun share(activity:Activity,snapshot:PdfOriginalSnapshot):String {snapshot.validate();shares++;return "合成分享系统边界已调用，未核验存档。"}
  override suspend fun print(activity:Activity,snapshot:PdfOriginalSnapshot,password:String):String {
   if(PdfOriginalPrintAdapter.inspect(snapshot,password)!=PdfOriginalPrintReadiness.READY)throw PdfOriginalPrintPasswordRequired()
   prints++;return "合成打印系统边界已调用，未确认打印完成。"
  }
 }
 @Composable private fun Host(controller:AppController,actions:Actions) {
  val state by controller.state.collectAsState();val context=LocalContext.current;val scope=rememberCoroutineScope()
  val session=remember(state.selectedPaperId,state.readingMaterialID,state.pdfDocument?.sha256){PdfOriginalOutputSession(controller,context,scope,state.selectedPaperId.orEmpty(),state.readingMaterialID,state.pdfDocument?.sha256.orEmpty(),actions)}
  DisposableEffect(session){onDispose{session.dispose()}}
  var expanded by remember{mutableStateOf(true)}
  MaterialTheme {Box {DropdownMenu(expanded,onDismissRequest={expanded=false}){PdfOriginalOutputMenuItems(canOutputCurrentPdf(state),session){expanded=false}};PdfOriginalOutputDialogs(session)}}
 }
 @Test fun twoRealMenuSelectorsStayDisabledBeforeTheActualPdfIsOpened() {
  val f=Fixture();try{val controller=f.Controller();controller.state.value=controller.state.value.copy(pdfMode=false);val actions=Actions()
   compose.setContent{Host(controller,actions)}
   compose.onNodeWithText("分享 PDF 原件…").assertIsNotEnabled();compose.onNodeWithText("打印 PDF 原件…").assertIsNotEnabled()
   assertTrue(controller.typedTokens.isEmpty());assertEquals(0,actions.shares);assertEquals(0,actions.prints);f.assertOriginal()
  }finally{f.close()}
 }
 @Test fun shareSelectorUsesTypedCurrentTokenAndNeverAPathCommand() {
  val f=Fixture();try{val controller=f.Controller();val actions=Actions();compose.setContent{Host(controller,actions)}
   compose.onNodeWithText("分享 PDF 原件…").assertIsEnabled().performClick()
   compose.waitUntil(10000){actions.shares==1}
   compose.onNodeWithText("合成分享系统边界已调用，未核验存档。").assertExists()
   assertEquals(listOf("a".repeat(64)),controller.typedTokens);assertTrue(controller.commands.isEmpty());assertEquals(0,actions.prints);f.assertOriginal()
  }finally{f.close()}
 }
 @Test fun encryptedPrintPasswordStaysInTheLocalDialogAndWrongValueDoesNotOpenPreview() {
  val f=Fixture(true);try{val controller=f.Controller();val actions=Actions();val registry=androidx.compose.runtime.saveable.SaveableStateRegistry(null){true}
   compose.setContent{CompositionLocalProvider(androidx.compose.runtime.saveable.LocalSaveableStateRegistry provides registry){Host(controller,actions)}}
   compose.onNodeWithText("打印 PDF 原件…").assertIsEnabled().performClick()
   compose.waitUntil(10000){compose.onAllNodesWithText("本次打印密码").fetchSemanticsNodes().isNotEmpty()}
   compose.onNodeWithText("本次打印密码").assertExists().performTextInput("synthetic-wrong")
   compose.onNodeWithText("核对并打开预览").performClick()
   compose.waitUntil(10000){compose.onAllNodesWithText("密码为空或不正确，请重新输入本次打印密码。").fetchSemanticsNodes().isNotEmpty()}
   assertEquals(0,actions.prints);assertEquals(0,actions.shares)
   compose.onNodeWithText("本次打印密码").performTextInput("synthetic-reader")
   compose.runOnIdle{assertFalse(registry.performSave().values.flatten().any{it.toString().contains("synthetic-reader")})}
   compose.onNodeWithText("核对并打开预览").performClick()
   compose.waitUntil(10000){actions.prints==1}
   compose.onNodeWithText("合成打印系统边界已调用，未确认打印完成。").assertExists()
   assertTrue(controller.commands.isEmpty());assertFalse(controller.state.value.settings.toString().contains("synthetic-reader"));assertEquals(1,controller.typedTokens.size);f.assertOriginal()
  }finally{f.close()}
 }
 @Test fun samePaperSourceChangeDisposesPasswordAndUnhandedCapabilityWithoutNewPermission() {
  val f=Fixture(true);try{val controller=f.Controller();val actions=Actions();compose.setContent{Host(controller,actions)}
   compose.onNodeWithText("打印 PDF 原件…").performClick()
   compose.waitUntil(10000){compose.onAllNodesWithText("本次打印密码").fetchSemanticsNodes().isNotEmpty()}
   compose.onNodeWithText("本次打印密码").assertExists().performTextInput("synthetic-reader")
   compose.runOnIdle{controller.state.value=controller.state.value.copy(readingMaterialID="b".repeat(64))}
   compose.waitForIdle();compose.onAllNodesWithText("本次打印密码").assertCountEquals(0)
   assertEquals(0,actions.prints);assertEquals(0,actions.shares);assertEquals(1,controller.typedTokens.size);assertTrue(controller.commands.isEmpty())
   assertTrue(runBlocking{runCatching{f.snapshots.single().validate()}.isFailure});assertFalse(f.snapshots.single().file.exists());f.assertOriginal()
  }finally{f.close()}
 }
 @Test fun acceptedEncryptedPasswordCacheDoesNotPromptAgainForTheSameOriginal() {
  val f=Fixture(true,forgetPassword=false);try{val controller=f.Controller();val actions=Actions();compose.setContent{Host(controller,actions)}
   compose.onNodeWithText("打印 PDF 原件…").assertIsEnabled().performClick()
   compose.waitUntil(10000){actions.prints==1}
   compose.onAllNodesWithText("本次打印密码").assertCountEquals(0)
   compose.onNodeWithText("合成打印系统边界已调用，未确认打印完成。").assertExists()
   assertEquals(1,controller.typedTokens.size);assertEquals(0,actions.shares);assertTrue(controller.commands.isEmpty());f.assertOriginal()
  }finally{f.close()}
 }
 private object BackupCodecForTest {fun hash(file:File)=com.nanless.paperdigest.cloud.BackupCodec.hash(file)}
}
