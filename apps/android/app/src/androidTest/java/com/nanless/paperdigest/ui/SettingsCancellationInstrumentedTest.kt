package com.nanless.paperdigest.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** A native operation can be cancelled while its settings page is still visible. No real accounts or IO. */
class SettingsCancellationInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private class Controller:AppController {
        override val state=MutableStateFlow(UiState())
        val calls=mutableListOf<String>()
        override suspend fun execute(command:String,payload:JSONObject):JSONObject {
            calls+=command
            throw CancellationException("合成取消，不应显示为故障")
        }
        override suspend fun updateSecret(kind:SecretKind,value:String?){error("No secrets in this fixture")}
        override suspend fun updatePdfSelection(selection:PdfSelection){}
    }
    private fun open(pane:String):Controller {
        val controller=Controller()
        compose.setContent{val state by controller.state.collectAsState();MaterialTheme{SettingsPane(state,controller,{_,_->},{},pane,1)}}
        compose.waitForIdle()
        return controller
    }
    private fun noError(controller:Controller,command:String) {
        compose.waitUntil(5000){controller.calls.isNotEmpty()}
        compose.waitForIdle()
        assertEquals(listOf(command),controller.calls)
        compose.onNodeWithText("合成取消，不应显示为故障").assertDoesNotExist()
    }
    @Test fun cancelledModelSaveKeepsDraftRetryableWithoutFalseError(){
        val controller=open("模型")
        compose.onNodeWithText("API 地址").performScrollTo().performTextReplacement("https://example.invalid/v1")
        compose.onNodeWithText("保存连接").performScrollTo().performClick()
        noError(controller,"settings.save")
        compose.onNodeWithText("保存连接").assertIsEnabled()
        compose.onNodeWithText("https://example.invalid/v1").assertExists()
    }
    @Test fun cancelledCloudSaveDoesNotOpenPasswordOrReportFailure(){
        val controller=open("坚果云")
        compose.onNodeWithText("坚果云账号").performScrollTo().performTextReplacement("synthetic@example.invalid")
        compose.onNodeWithText("保存账号并填写应用密码…").performScrollTo().performClick()
        noError(controller,"cloud.save")
        compose.onNodeWithText("保存账号并填写应用密码…").assertIsEnabled()
        compose.onNodeWithText("新的密钥").assertDoesNotExist()
    }
    @Test fun cancelledPackageListDoesNotShowAnOperationError(){
        val controller=open("资料")
        compose.onNodeWithText("读取已保存的离线包").performScrollTo().performClick()
        noError(controller,"storage.list")
    }
    @Test fun cancelledRetainedListDoesNotShowAnOperationError(){
        val controller=open("资料")
        compose.onNodeWithText("查看保留快照").performScrollTo().performClick()
        noError(controller,"retained.list")
    }
}
