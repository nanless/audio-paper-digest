package com.nanless.paperdigest.ui

import androidx.compose.ui.test.*
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.StateRestorationTester
import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class UiBehaviorInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private class Controller:AppController {
  override val state=MutableStateFlow(UiState(papers=listOf(Paper("p1","Original paper","真实论文")),selectedPaperId="p1",personal=JSONObject().put("notes",JSONObject()).put("annotations",JSONObject())))
  val calls=mutableListOf<Pair<String,JSONObject>>();var noteFails=true;var restoreFails=true
  override suspend fun execute(command:String,payload:JSONObject):JSONObject {calls+=command to JSONObject(payload.toString());if(command=="cloud.list")return JSONObject().put("selectionContext",state.value.cloud.getString("selectionContext")).put("month",payload.getString("month")).put("snapshots",org.json.JSONArray().put(JSONObject().put("selectionID","test-cloud-selection").put("createdAt","2026-10-25T00:00:00Z").put("encodedBytes",123).put("sha256","a".repeat(64))))
   if(command=="cloud.restore.prepare"){check(payload.keys().asSequence().toSet()==setOf("selectionID"));check(payload.getString("selectionID")=="test-cloud-selection");return JSONObject().put("restoreID","test-validated-token").put("fileCount",3).put("message","原材料已校验，尚未恢复")}
   if(command=="cloud.restore.commit"){if(restoreFails)throw IllegalStateException("恢复被阻断，当前资料保留");return JSONObject().put("restored",true)}
   if(command=="pdf.outline")return JSONObject().put("pdfSHA",state.value.pdfDocument!!.sha256).put("chapters",org.json.JSONArray().put(JSONObject().put("index",0).put("title","第一章").put("page",1).put("endPage",7).put("depth",0)).put(JSONObject().put("index",1).put("title","第二章").put("page",8).put("endPage",13).put("depth",0)))
   if(command=="zotero.collections")return JSONObject().put("collections",org.json.JSONArray().put(JSONObject().put("key","AAAAAAAA").put("data",JSONObject().put("name","音频研究").put("parentCollection",false))).put(JSONObject().put("key","BBBBBBBB").put("data",JSONObject().put("name","优先阅读").put("parentCollection","AAAAAAAA"))))
   if(command=="zotero.save"){state.value=state.value.copy(zotero=JSONObject(payload.toString()));return state.value.zotero}
   if(command=="personal.note"&&noteFails)throw IllegalStateException("笔记冲突，草稿保留");return JSONObject().put("revision",1)}
  override suspend fun updateSecret(kind:SecretKind,value:String?){}
  override suspend fun updatePdfSelection(selection:PdfSelection){}
 }
 @Test fun failedNoteSaveKeepsActualDraftAndRemainsRetryable(){
  val controller=Controller();compose.setContent{val observed by controller.state.collectAsState();androidx.compose.material3.MaterialTheme{ReaderPane(observed,controller,{_,_->})}}
  compose.onNodeWithText("笔记",useUnmergedTree=true).performClick()
  compose.onNodeWithText("你的想法、疑问与结论").performTextInput("只属于这个新测试的草稿")
  compose.onNodeWithText("保存笔记").performClick()
  compose.waitForIdle()
  compose.onNodeWithText("笔记冲突，草稿保留").assertIsDisplayed()
  compose.onNodeWithText("只属于这个新测试的草稿").assertIsDisplayed()
  compose.onNodeWithText("保存笔记").assertIsEnabled()
  assertEquals("只属于这个新测试的草稿",controller.calls.single{it.first=="personal.note"}.second.getString("text"))
 }
 @Test fun taskPaginationExposesAllRecordsAndCancelsExactOwner(){
  val jobs=(1..43).map{JSONObject().put("id","job-$it").put("kind","任务 $it").put("createdAt","2026-10-25T00:00:${it.toString().padStart(2,'0')}Z").put("status",if(it==43)"running" else "completed")};val calls=mutableListOf<JSONObject>()
  compose.setContent{androidx.compose.material3.MaterialTheme{TasksPane(UiState(jobs=jobs),{_,p->calls+=p})}}
  compose.onNodeWithText("1–20 / 43").assertIsDisplayed();compose.onNodeWithText("取消").performClick();assertEquals("job-43",calls.single().getString("id"))
  compose.onNodeWithText("下一页").performClick();compose.onNodeWithText("21–40 / 43").assertIsDisplayed();compose.onNodeWithText("下一页").performClick();compose.onNodeWithText("41–43 / 43").assertIsDisplayed();compose.onNodeWithText("下一页").assertIsNotEnabled()
 }
 @Test fun validatedRestoreSurvivesRecreationAndClosesOnlyAfterSuccess(){
  val controller=Controller();controller.state.value=controller.state.value.copy(cloud=JSONObject().put("selectionContext","synthetic-cloud-context").put("account","synthetic-account").put("folder","PaperDigest").put("automatic",false));val restoration=StateRestorationTester(compose)
  restoration.setContent{PaperDigestApp(controller)}
  compose.onNodeWithText("设置").performClick();compose.onNodeWithText("坚果云").performScrollTo().performClick()
  compose.onNodeWithText("读取此月版本").performScrollTo().assertIsEnabled().performClick();compose.waitForIdle()
  compose.onNodeWithText("校验并准备恢复…").performScrollTo().performClick();compose.waitForIdle()
  val selection=controller.calls.single{it.first=="cloud.restore.prepare"}.second
  assertEquals(setOf("selectionID"),selection.keys().asSequence().toSet());assertEquals("test-cloud-selection",selection.getString("selectionID"))
  compose.onNodeWithText("恢复完整研究资料？").assertIsDisplayed()
  restoration.emulateSavedInstanceStateRestore()
  compose.onNodeWithText("恢复完整研究资料？").assertIsDisplayed()
  compose.onNodeWithText("确认恢复").performClick();compose.waitForIdle()
  compose.onNodeWithText("恢复被阻断，当前资料保留").assertIsDisplayed()
  compose.onNodeWithText("确认恢复").assertIsEnabled()
  controller.restoreFails=false
  compose.onNodeWithText("确认恢复").performClick();compose.waitForIdle()
  compose.onNodeWithText("恢复完整研究资料？").assertDoesNotExist()
  val commits=controller.calls.filter{it.first=="cloud.restore.commit"}
  assertEquals(2,commits.size);assertTrue(commits.all{it.second.getString("restoreID")=="test-validated-token"})
 }

 @Test fun modelDraftSurvivesPaneSwitchAndRecreationAndCannotRetargetSecret(){
  val controller=Controller();controller.state.value=controller.state.value.copy(settings=JSONObject().put("endpoint","https://a.invalid/v1").put("model","fixture-model"))
  val restoration=StateRestorationTester(compose)
  restoration.setContent{val observed by controller.state.collectAsState();androidx.compose.material3.MaterialTheme{SettingsPane(observed,controller,{_,_->},{})}}
  compose.onNodeWithText("模型").performClick()
  compose.onNodeWithText("API 地址").performScrollTo().performTextReplacement("https://b.invalid/v1")
  compose.onNodeWithText("为已保存连接设置模型密钥…").performScrollTo().assertIsNotEnabled()
  compose.onNodeWithText("阅读").performClick();compose.onNodeWithText("模型").performClick()
  compose.onNodeWithText("https://b.invalid/v1").assertExists()
  restoration.emulateSavedInstanceStateRestore()
  compose.onNodeWithText("https://b.invalid/v1").assertExists()
  compose.onNodeWithText("为已保存连接设置模型密钥…").performScrollTo().assertIsNotEnabled()
  assertTrue(controller.calls.none{it.first=="settings.save"})
 }
 @Test fun macLayoutModeAndEvidenceScopeStaySeparateAndNewestSessionWins(){
  val controller=Controller();val captured=mutableListOf<JSONObject>()
  val personal=JSONObject().put("notes",JSONObject()).put("annotations",JSONObject()).put("readingState",JSONObject().put("p1",JSONObject().put("mode","analysis").put("scope","range").put("from",2).put("to",3).put("question","Preserved question")))
  val sessions=listOf(JSONObject().put("id","old").put("paperID","p1").put("question","Old question").put("answer","old answer").put("createdAt","2026-10-01T00:00:00Z"),JSONObject().put("id","new").put("paperID","p1").put("question","Newest question").put("answer","new answer").put("createdAt","2026-10-25T00:00:00Z"))
  val state=controller.state.value.copy(personal=personal,sessions=sessions)
  compose.setContent{androidx.compose.material3.MaterialTheme{ReaderPane(state,controller,{command,payload->if(command=="personal.reading")captured+=JSONObject(payload.toString())})}}
  compose.onNodeWithText("研究记录 2 · Newest question").assertExists()
  compose.onNodeWithText("页段").assertIsSelected()
  compose.mainClock.advanceTimeBy(800);compose.waitForIdle();compose.waitUntil(3000){captured.any{it.optString("scope")=="range"}}
  assertTrue(captured.any{it.optString("mode")=="analysis"})
  assertTrue(captured.any{it.optString("scope")=="range"&&it.optInt("from")==2&&it.optInt("to")==3})
  assertTrue(captured.none{it.optString("mode")=="range"})
 }

 @Test fun zoteroCollectionsUseRealParentNamesAndSaveExactSelectedKey(){
  val controller=Controller();controller.state.value=controller.state.value.copy(zotero=JSONObject().put("libraryType","users").put("libraryID","123").put("collection",""))
  compose.setContent{val observed by controller.state.collectAsState();androidx.compose.material3.MaterialTheme{androidx.compose.foundation.layout.Column(androidx.compose.ui.Modifier.verticalScroll(androidx.compose.foundation.rememberScrollState())){ZoteroSettings(observed,controller,{_,_->},{},davPassword={})}}}
  assertTrue(controller.calls.isEmpty())
  compose.onNodeWithText("读取并选择分类…").performScrollTo().performClick()
  compose.onNodeWithText("音频研究 / 优先阅读").performClick()
  compose.onNodeWithText("保存目标文库").performScrollTo().performClick();compose.waitForIdle()
  val save=controller.calls.single{it.first=="zotero.save"}.second
  assertEquals("users",save.getString("libraryType"));assertEquals("123",save.getString("libraryID"));assertEquals("BBBBBBBB",save.getString("collection"))
  assertEquals(1,controller.calls.count{it.first=="zotero.collections"})
  assertEquals("storage",save.getString("attachmentBackend"));assertEquals("",save.getString("davBaseURL"));assertEquals("",save.getString("davUsername"))
  assertTrue(controller.calls.none{it.first=="zotero.check"})
 }
 @Test fun webdavTargetChangesRequireSaveAndSeparatePasswordActionWithoutGrantingAuthority(){
  val controller=Controller();var apiPasswordActions=0;var davPasswordActions=0
  controller.state.value=controller.state.value.copy(zotero=JSONObject().put("libraryType","users").put("libraryID","123").put("collection","").put("attachmentBackend","storage").put("credentialState","confirmed"))
  compose.setContent{val observed by controller.state.collectAsState();androidx.compose.material3.MaterialTheme{androidx.compose.foundation.layout.Column(androidx.compose.ui.Modifier.verticalScroll(androidx.compose.foundation.rememberScrollState())){ZoteroSettings(observed,controller,{command,payload->controller.calls+=command to JSONObject(payload.toString())},{apiPasswordActions++},davPassword={davPasswordActions++})}}}
  compose.onNodeWithText("Zotero Storage").assertIsSelected()
  compose.onNodeWithText("为已保存附件目标设置独立应用密码…").assertDoesNotExist()
  compose.onNodeWithText("WebDAV 附件").performScrollTo().performClick()
  compose.onNodeWithText("群组文库").assertIsNotEnabled()
  compose.onNodeWithText("核验身份、目标与权限").performScrollTo().assertIsNotEnabled()
  compose.onNodeWithText("为已保存目标设置专用 API key…").performScrollTo().assertIsNotEnabled()
  compose.onNodeWithText("为已保存附件目标设置独立应用密码…").performScrollTo().assertIsNotEnabled()
  assertTrue(controller.calls.isEmpty());assertEquals(0,apiPasswordActions);assertEquals(0,davPasswordActions)
  compose.onNodeWithText("WebDAV 上一级地址（不含末段 zotero）").performScrollTo().performTextReplacement("https://dav.example.invalid/dav/")
  compose.onNodeWithText("WebDAV 独立账号").performScrollTo().performTextReplacement("synthetic-dav-user")
  compose.onNodeWithText("保存目标文库").performScrollTo().performClick();compose.waitForIdle()
  val davSave=controller.calls.single{it.first=="zotero.save"}.second
  assertEquals("users",davSave.getString("libraryType"));assertEquals("webdav",davSave.getString("attachmentBackend"));assertEquals("https://dav.example.invalid/dav/",davSave.getString("davBaseURL"));assertEquals("synthetic-dav-user",davSave.getString("davUsername"))
  compose.onNodeWithText("许可状态：需要主动核验").performScrollTo().assertExists()
  compose.onNodeWithText("为已保存附件目标设置独立应用密码…").performScrollTo().assertIsEnabled().performClick();compose.waitForIdle()
  assertEquals(1,davPasswordActions);assertEquals(0,apiPasswordActions)
  compose.onNodeWithText("许可状态：需要主动核验").assertExists()
  assertTrue(controller.calls.none{it.first in setOf("zotero.check","zotero.archive","zotero.resume")||it.first.startsWith("cloud.")})
  compose.onNodeWithText("Zotero Storage").performScrollTo().performClick()
  compose.onNodeWithText("群组文库").assertIsEnabled()
  compose.onNodeWithText("为已保存附件目标设置独立应用密码…").assertDoesNotExist()
  compose.onNodeWithText("保存目标文库").performScrollTo().performClick();compose.waitForIdle()
  assertEquals("storage",controller.calls.last{it.first=="zotero.save"}.second.getString("attachmentBackend"))
  assertEquals(1,davPasswordActions);assertEquals(0,apiPasswordActions)
  assertTrue(controller.calls.none{it.first=="zotero.check"})
 }
 @Test fun modelSaveChangesOnlyEditedFieldsAndPreservesOtherPreferences(){
  val controller=Controller();controller.state.value=controller.state.value.copy(settings=JSONObject().put("endpoint","https://a.invalid/v1").put("model","fixture-model").put("appearance","dark").put("font",24))
  compose.setContent{val observed by controller.state.collectAsState();androidx.compose.material3.MaterialTheme{SettingsPane(observed,controller,{_,_->},{})}}
  compose.onNodeWithText("模型").performClick();compose.onNodeWithText("API 地址").performScrollTo().performTextReplacement("https://b.invalid/v1")
  compose.onNodeWithText("保存连接").performScrollTo().performClick();compose.waitForIdle()
  val changes=controller.calls.single{it.first=="settings.save"}.second.getJSONObject("changes")
  assertEquals(setOf("endpoint"),changes.keys().asSequence().toSet());assertEquals("https://b.invalid/v1",changes.getString("endpoint"));assertFalse(changes.has("appearance"));assertFalse(changes.has("font"))
 }

 @Test fun chapterQuestionRequiresActualOutlineAndSendsOriginalChapterIndex(){
  val controller=Controller();val captured=mutableListOf<Pair<String,JSONObject>>()
  val reading=JSONObject().put("p1",JSONObject().put("mode","analysis").put("scope","chapter").put("chapter",1).put("question","保留的章节问题"))
  controller.state.value=controller.state.value.copy(personal=JSONObject().put("readingState",reading).put("notes",JSONObject()).put("annotations",JSONObject()),pdfDocument=com.nanless.paperdigest.pdf.PdfDocumentRef("fixture","/isolated-not-read.pdf","a".repeat(64),13,"fixture"))
  compose.setContent{val observed by controller.state.collectAsState();androidx.compose.material3.MaterialTheme{ReaderPane(observed,controller,{command,payload->captured+=command to JSONObject(payload.toString())})}}
  compose.onNodeWithText("发送").assertIsNotEnabled()
  compose.onNodeWithText("读取原 PDF 目录").performScrollTo().performClick();compose.waitForIdle()
  compose.onNodeWithText("第二章").assertExists()
  compose.onNodeWithText("发送").performScrollTo().performClick()
  val payload=captured.single{it.first=="model.run"}.second
  assertEquals("chapter",payload.getString("evidenceKind"));assertEquals(1,payload.getInt("chapter"));assertEquals("保留的章节问题",payload.getString("question"));assertEquals(1,controller.calls.count{it.first=="pdf.outline"})
 }

 @Test fun taskLinkKeepsHistoricalSessionInsteadOfLatestAnswer(){
  val old=JSONObject().put("id","historical").put("paperID","p1").put("answer","old saved answer").put("status","completed");val newer=JSONObject().put("id","newest").put("paperID","p1").put("answer","new saved answer");val calls=mutableListOf<Pair<String,JSONObject>>()
  compose.setContent{androidx.compose.material3.MaterialTheme{TasksPane(UiState(jobs=listOf(JSONObject().put("id","job").put("sessionID","historical").put("status","completed")),sessions=listOf(newer,old)),{c,p->calls+=c to p})}}
  compose.onNodeWithText("打开原研究记录").performClick();assertEquals("ui.session.open",calls.single().first);assertEquals("historical",calls.single().second.getString("id"))
 }
 @Test fun interruptedSessionRecoveryCallsOnlyTheOriginalRecord(){
  val controller=Controller();val original=JSONObject().put("id","paid-original").put("paperID","p1").put("question","原已派发问题").put("inputContract","android-study-input-v1").put("requestIssued",true).put("status","interrupted")
  controller.state.value=controller.state.value.copy(sessions=listOf(original))
  compose.setContent{val observed by controller.state.collectAsState();androidx.compose.material3.MaterialTheme{SessionPane(observed,"paid-original",controller,{_,_->})}}
  compose.onNodeWithText("核验已保存回答（不重新请求）").performScrollTo().performClick();compose.waitForIdle()
  assertEquals(listOf("model.recover"),controller.calls.map{it.first});assertEquals("paid-original",controller.calls.single().second.getString("id"));assertFalse(controller.calls.any{it.first=="model.run"||it.first=="model.check"})
 }
 @Test fun readingPreferencesSaveOnlyExplicitIntervalAndMotionFields(){
  val controller=Controller();controller.state.value=controller.state.value.copy(settings=JSONObject().put("font",30).put("syncHours",12));val actions=mutableListOf<Pair<String,JSONObject>>()
  compose.setContent{val observed by controller.state.collectAsState();androidx.compose.material3.MaterialTheme{SettingsPane(observed,controller,{c,p->actions+=c to p},{})}}
  compose.onNodeWithContentDescription("减少界面动画").performScrollTo().performClick()
  assertTrue(actions.single().second.getJSONObject("changes").getBoolean("reduceMotion"));assertEquals(setOf("reduceMotion"),actions.single().second.getJSONObject("changes").keys().asSequence().toSet())
  compose.onNodeWithText("已发布目录同步间隔（1–168 小时）").performScrollTo().performTextReplacement("24")
  compose.onNodeWithText("保存目录同步间隔").performScrollTo().performClick();compose.waitForIdle()
  val changes=controller.calls.single{it.first=="settings.save"}.second.getJSONObject("changes");assertEquals(24,changes.getInt("syncHours"));assertEquals(setOf("syncHours"),changes.keys().asSequence().toSet())
 }

 @Test fun reducedMotionScaleUsesCurrentPreferenceAndPreservesReadOnlySystemScale(){
  val controller=Controller();val context=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
  val system=android.provider.Settings.Global.getFloat(context.contentResolver,android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,1f)
  val scale=AppMotionDurationScale(context,controller);assertEquals(system,scale.scaleFactor,0f)
  controller.state.value=controller.state.value.copy(settings=JSONObject().put("reduceMotion",true));assertEquals(0f,scale.scaleFactor,0f)
  kotlinx.coroutines.runBlocking{kotlinx.coroutines.withContext(scale){assertSame(scale,kotlinx.coroutines.currentCoroutineContext()[androidx.compose.ui.MotionDurationScale]);assertEquals(0f,kotlinx.coroutines.currentCoroutineContext()[androidx.compose.ui.MotionDurationScale]!!.scaleFactor,0f)}}
  controller.state.value=controller.state.value.copy(settings=JSONObject().put("reduceMotion",false));assertEquals(system,scale.scaleFactor,0f)
  assertEquals(system,android.provider.Settings.Global.getFloat(context.contentResolver,android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,1f),0f)
 }

 @Test fun storageWarningCanOpenDataWithoutErasingModelDraftAndClearsWithRealState(){
  val controller=Controller();val warning="中断状态尚未写盘；原文件保留，不会自动重发已付请求。"
  controller.state.value=controller.state.value.copy(storageWarning=warning,settings=JSONObject().put("endpoint","https://a.invalid/v1").put("model","fixture-model"))
  compose.setContent{PaperDigestApp(controller)}
  compose.onNodeWithText(warning).assertExists();compose.onNodeWithText("前往资料，导出完整备份").performClick();compose.waitForIdle()
  compose.onNodeWithText("资料").assertIsSelected();compose.onNodeWithText("完整研究资料").assertExists();assertTrue(controller.calls.isEmpty())
  compose.onNodeWithText("模型").performClick();compose.onNodeWithText("API 地址").performScrollTo().performTextReplacement("https://b.invalid/v1")
  compose.runOnIdle{controller.state.value=controller.state.value.copy(storageWarning=null)};compose.waitForIdle();compose.onNodeWithText(warning).assertDoesNotExist();compose.onNodeWithText("https://b.invalid/v1").assertExists()
  compose.runOnIdle{controller.state.value=controller.state.value.copy(storageWarning=warning)};compose.waitForIdle();compose.onNodeWithText("前往资料，导出完整备份").performClick();compose.waitForIdle();compose.onNodeWithText("资料").assertIsSelected()
  compose.onNodeWithText("模型").performClick();compose.onNodeWithText("https://b.invalid/v1").assertExists();assertTrue(controller.calls.none{it.first=="model.run"||it.first=="model.check"||it.first=="settings.save"})
 }

}
