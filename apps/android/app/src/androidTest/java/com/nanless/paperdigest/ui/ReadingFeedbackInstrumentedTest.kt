package com.nanless.paperdigest.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Display/cancellation fixtures only: no image download, PDF source, credentials or model request. */
class ReadingFeedbackInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private class Controller(val cancel:Boolean=true):AppController {
        val paper=Paper("synthetic-reading","Synthetic reading","合成阅读")
        val personal=PersonalStore.initial().put("readingState",JSONObject().put(paper.id,JSONObject().put("mode","note")))
            .put("notes",JSONObject().put(paper.id,JSONObject().put("text","原笔记").put("revision",0)))
            .put("annotations",JSONObject().put(paper.id,JSONArray().put(JSONObject().put("id","synthetic-annotation").put("text","合成原文").put("comment","原批注").put("page",1).put("pdfSHA","a".repeat(64)))))
        override val state=MutableStateFlow(UiState(papers=listOf(paper),selectedPaperId=paper.id,viewedPaper=paper,personal=personal))
        val calls=mutableListOf<String>()
        var hold=false
        val held=CompletableDeferred<JSONObject>()
        var submitted:String?=null
        override suspend fun execute(command:String,payload:JSONObject):JSONObject {
            calls+=command
            if(hold){submitted=payload.getString("comment");return held.await()}
            if(cancel)throw CancellationException("合成取消，不是保存故障")
            throw IllegalStateException("合成批注保存失败，草稿保留")
        }
        override suspend fun updateSecret(kind:SecretKind,value:String?){error("No secrets in feedback fixture")}
        override suspend fun updatePdfSelection(selection:PdfSelection){}
    }
    private fun open(cancel:Boolean=true,hold:Boolean=false):Controller {
        val controller=Controller(cancel).apply{this.hold=hold};compose.setContent{val state by controller.state.collectAsState();MaterialTheme{ReaderPane(state,controller,{_,_->})}};return controller
    }
    @Test fun cancellingNoteSaveKeepsDraftRetryableWithoutAFalseFailure(){
        val controller=open();compose.onNodeWithText("你的想法、疑问与结论").performTextReplacement("保留的笔记草稿")
        compose.onNodeWithText("保存笔记").performScrollTo().performClick();compose.waitForIdle()
        assertEquals(listOf("personal.note"),controller.calls)
        compose.onNodeWithText("合成取消，不是保存故障").assertDoesNotExist();compose.onNodeWithText("保存笔记").assertIsEnabled()
        compose.onNodeWithText("保留的笔记草稿").assertExists();assertEquals("原笔记",controller.personal.getJSONObject("notes").getJSONObject(controller.paper.id).getString("text"))
    }
    @Test fun cancellingAnnotationSaveKeepsTheDialogAndOriginalComment(){
        val controller=open();compose.onNodeWithText("编辑批注…").performScrollTo().performClick()
        compose.onNodeWithText("批注").performTextReplacement("新的批注草稿");compose.onNodeWithText("保存").performClick();compose.waitForIdle()
        compose.onNodeWithText("合成取消，不是保存故障").assertDoesNotExist();compose.onNodeWithText("新的批注草稿").assertIsDisplayed();compose.onNodeWithText("保存").assertIsEnabled()
        assertEquals(listOf("personal.annotationNote"),controller.calls);assertEquals("原批注",controller.personal.getJSONObject("annotations").getJSONArray(controller.paper.id).getJSONObject(0).getString("comment"))
    }
    @Test fun annotationFailureIsVisibleInsideItsOwnDialog(){
        open(false);compose.onNodeWithText("编辑批注…").performScrollTo().performClick();compose.onNodeWithText("批注").performTextReplacement("未丢失的批注")
        compose.onNodeWithText("保存").performClick();compose.waitForIdle()
        compose.onNodeWithText("合成批注保存失败，草稿保留").assertIsDisplayed();compose.onNodeWithText("未丢失的批注").assertIsDisplayed();compose.onNodeWithText("保存").assertIsEnabled()
    }
    @Test fun pendingAnnotationSaveFreezesTheSubmittedTextAndCannotBeDismissedBySystemBack(){
        val controller=open(hold=true);compose.onNodeWithText("编辑批注…").performScrollTo().performClick();compose.onNodeWithText("批注").performTextReplacement("本次提交批注")
        compose.onNodeWithText("保存").performClick();compose.waitUntil(5000){controller.calls.isNotEmpty()}
        compose.onNodeWithText("批注").assertIsNotEnabled()
        val pending=compose.onAllNodesWithText("正在保存…");val pendingCount=pending.fetchSemanticsNodes().size;assertTrue(pendingCount>0)
        for(index in 0 until pendingCount)pending[index].assertIsNotEnabled()
        compose.onNodeWithText("取消").assertIsNotEnabled()
        androidx.test.espresso.Espresso.closeSoftKeyboard();compose.waitForIdle()
        androidx.test.uiautomator.UiDevice.getInstance(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()).pressBack();compose.waitForIdle()
        compose.onNodeWithText("编辑标注批注").assertIsDisplayed();assertEquals("本次提交批注",controller.submitted)
        compose.runOnIdle{controller.held.complete(JSONObject().put("saved",true))};compose.waitForIdle();compose.onNodeWithText("编辑标注批注").assertDoesNotExist()
    }
    @Test fun selectedAggregateShowsImageWorkAndKeepsControlsAvailableThenReportsActualMissing(){
        val source=AggregateSource("a".repeat(64),"b".repeat(64),1,"index.json",0,"c".repeat(64),"foundation-sorted-keys-json-v1")
        val record=PublishedAggregate("synthetic-feedback","daily",null,"合成日更","合成日更","","2026-11-01","2026-11-01",emptyList(),emptyList(),PublishedAggregateReader.SITE+"posts/synthetic-feedback/",source)
        val html="<p>可以继续阅读的合成正文</p>"
        val doc=AggregateDocumentView(record,html,"d".repeat(64),PublishedAggregateReader.sha(html.toByteArray()),html.toByteArray().size,"2026-11-01T00:00:00Z",listOf(AggregateResource(PublishedAggregateReader.SITE+"a.png","未保存"),AggregateResource(PublishedAggregateReader.SITE+"b.png","未保存")),emptyList(),true,imageError="上次合成图片错误")
        val initial=UiState(aggregate=AggregateBrowseState(selected=record,document=doc,loading=false,loadingImages=true,attemptedIndex=true))
        val state=mutableStateOf(initial);val calls=mutableListOf<String>()
        compose.setContent{MaterialTheme{AggregatePane(state.value,{command,_->calls+=command},autoLoad=false)}}
        compose.onNodeWithText("正文已就绪，图片正在后台读取，可继续阅读。").assertIsDisplayed()
        compose.onNodeWithText("还有 2 张图片未保存，正文仍可阅读。").assertDoesNotExist()
        compose.onNodeWithText("图片读取未完成，正文仍可阅读。").assertDoesNotExist()
        compose.onNodeWithContentDescription("刷新网站正文").assertIsEnabled();compose.onNodeWithContentDescription(initial.aggregate.backTitle).assertIsEnabled()
        compose.runOnIdle{state.value=initial.copy(aggregate=initial.aggregate.copy(loadingImages=false))}
        compose.onNodeWithText("正文已就绪，图片正在后台读取，可继续阅读。").assertDoesNotExist()
        compose.onNodeWithText("还有 2 张图片未保存，正文仍可阅读。").assertIsDisplayed()
        compose.onNodeWithContentDescription(initial.aggregate.backTitle).performClick();assertEquals(listOf("aggregate.back"),calls)
    }
}
