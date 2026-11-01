package com.nanless.paperdigest.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.data.copy
import com.nanless.paperdigest.pdf.PdfSelection
import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.nio.file.Files

/** Real settings controls and RootController validation in a private workspace; no API, account or secret access. */
class ModelSettingsInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private class Controller(initial:JSONObject):AppController {
        private val target=InstrumentationRegistry.getInstrumentation().targetContext
        private val directory=Files.createTempDirectory(target.cacheDir.toPath(),"model-settings-ui-").toFile().canonicalFile
        private val context=object:ContextWrapper(target){override fun getNoBackupFilesDir()=directory}
        private val root=RootController(context,installBackground=false,secretStore=object:SecretStore{
            override fun load(scope:String):String?=null
            override fun save(scope:String,secret:String){error("No secrets in settings fixture")}
            override fun remove(scope:String){error("No secrets in settings fixture")}
        })
        val store get()=root.personal
        override val state get()=root.state
        val calls=mutableListOf<Pair<String,JSONObject>>()
        var failSave=false
        init {store.replaceValidated(store.snapshot().put("settings",initial));runBlocking{root.execute("app.bootstrap")}}
        override suspend fun execute(command:String,payload:JSONObject):JSONObject {
            calls+=command to payload.copy();require(command=="settings.save") {"A model operation must never be issued by this test"}
            if(failSave)throw IllegalStateException("合成保存失败，保留草稿")
            return root.execute(command,payload)
        }
        override suspend fun updateSecret(kind:SecretKind,value:String?){error("No secret writes in model settings fixture")}
        override suspend fun updatePdfSelection(selection:PdfSelection){}
    }
    private fun settings()=JSONObject().put("endpoint","https://example.invalid/v1").put("model","synthetic-model").put("timeoutMs",180123).put("maxTokens",9000).put("dailyRequests",17).put("futureOption",JSONObject().put("keep",true))
    private fun open(initial:JSONObject=settings()):Controller {
        val controller=Controller(initial)
        compose.setContent {val state by controller.state.collectAsState();MaterialTheme{SettingsPane(state,controller,{_,_->},{},"模型",1)}}
        return controller
    }
    @Test fun defaultsAreChoicesAdvancedIsCollapsedAndChoosingProtocolOnlySavesThatKey(){
        val controller=open()
        compose.onNodeWithText("自动识别").assertIsDisplayed();compose.onNodeWithText("超时（毫秒）").assertDoesNotExist()
        assertTrue(controller.calls.isEmpty())
        compose.onNodeWithContentDescription("选择接口协议").performClick();compose.onNodeWithText("Responses").performClick()
        compose.onNodeWithText("为已保存连接设置模型密钥…").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("保存连接").performScrollTo().performClick();compose.waitForIdle()
        val patch=controller.calls.single().second.getJSONObject("changes")
        assertEquals(setOf("protocol"),patch.keys().asSequence().toSet());assertEquals("responses",patch.getString("protocol"));assertEquals(180123,controller.store.settings().getInt("timeoutMs"))
        assertTrue(controller.store.settings().getJSONObject("futureOption").getBoolean("keep"))
    }
    @Test fun customSavedChoicesAndNonWholeSecondTimeoutAreNotRewrittenByOtherEdits(){
        val controller=open(settings().put("protocol","custom-saved-protocol").put("reasoningEffort","custom-saved-effort"))
        compose.onNodeWithText("保留现有值：custom-saved-protocol").assertIsDisplayed()
        compose.onNodeWithText("API 地址").performTextReplacement("https://changed.invalid/v1")
        compose.onNodeWithText("展开高级参数（预算、超时与推理）").performScrollTo().performClick()
        compose.onNodeWithText("保留现有值：custom-saved-effort").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("180123").assertExists()
        compose.onNodeWithText("保存连接").performScrollTo().performClick();compose.waitForIdle()
        compose.onNodeWithText("接口协议未保存：请明确选择自动识别或受支持的协议，原配置与草稿保留。").assertIsDisplayed()
        assertEquals("https://example.invalid/v1",controller.store.settings().getString("endpoint"))
        compose.onNodeWithContentDescription("选择接口协议").performScrollTo().performClick();compose.onNodeWithText("自动识别").performClick()
        compose.onNodeWithText("保存连接").performScrollTo().performClick();compose.waitForIdle()
        assertEquals(setOf("endpoint","protocol"),controller.calls.last().second.getJSONObject("changes").keys().asSequence().toSet())
        assertEquals("auto",controller.store.settings().getString("protocol"));assertEquals("https://changed.invalid/v1",controller.store.settings().getString("endpoint"))
        assertEquals("custom-saved-effort",controller.store.settings().getString("reasoningEffort"));assertEquals(180123,controller.store.settings().getInt("timeoutMs"))
    }
    @Test fun museProxyIsVisibleWithoutOpeningAdvancedAndReasoningIsAChoice(){
        val controller=open(settings().put("model","muse-spark-synthetic").put("httpProxy","http://proxy.invalid:8080"))
        compose.onNodeWithText("Muse 需要 HTTP CONNECT 代理").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("HTTP CONNECT 代理（Muse 必填）").assertExists()
        compose.onNodeWithText("展开高级参数（预算、超时与推理）").performScrollTo().performClick()
        compose.onNodeWithContentDescription("选择推理强度").performScrollTo().performClick();compose.onNodeWithText("高").performClick()
        compose.onNodeWithText("保存连接").performScrollTo().performClick();compose.waitForIdle()
        assertEquals(setOf("reasoningEffort"),controller.calls.single().second.getJSONObject("changes").keys().asSequence().toSet());assertEquals("high",controller.store.settings().getString("reasoningEffort"))
    }
    @Test fun advancedDraftSurvivesRecreationAndFailedSaveKeepsSecretAndCheckDisabled(){
        val controller=Controller(settings());val restoration=StateRestorationTester(compose)
        restoration.setContent {val state by controller.state.collectAsState();MaterialTheme{SettingsPane(state,controller,{_,_->},{},"模型",1)}}
        compose.onNodeWithText("展开高级参数（预算、超时与推理）").performScrollTo().performClick()
        compose.onNodeWithText("单次输出上限").performScrollTo().performTextReplacement("12345")
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("12345").assertExists();compose.onNodeWithText("收起高级参数").assertExists()
        controller.failSave=true
        compose.onNodeWithText("保存连接").performScrollTo().performClick();compose.waitForIdle()
        compose.onNodeWithText("合成保存失败，保留草稿").assertIsDisplayed()
        compose.onNodeWithText("为已保存连接设置模型密钥…").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("检查当前连接（计入用量）").performScrollTo().assertIsNotEnabled()
        assertEquals(9000,controller.store.settings().getInt("maxTokens"))
        controller.failSave=false;compose.onNodeWithText("保存连接").performScrollTo().performClick();compose.waitForIdle()
        assertEquals(12345,controller.store.settings().getInt("maxTokens"));assertEquals(2,controller.calls.size)
    }
}
