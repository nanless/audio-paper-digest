package com.nanless.paperdigest.ui

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.nio.file.Files
import java.time.LocalDate

/** Reads and selects a synthetic list through actual controls, without network or personal workspace access. */
class LibraryContextInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private class Controller:AppController {
        val store=PersonalStore(Files.createTempDirectory("library-context-ui-").toRealPath().toFile())
        val papers=(1..120).map { index->Paper("context:$index","Synthetic $index","上下文论文 ${index.toString().padStart(3,'0')}",date=LocalDate.of(2026,1,1).plusDays(index.toLong()).toString(),score=(index%10).toDouble()) }
        override val state=MutableStateFlow(UiState(papers=papers,personal=store.snapshot()))
        val calls=mutableListOf<String>()
        override suspend fun execute(command:String,payload:JSONObject):JSONObject {
            calls+=command
            val result=when(command) {
                "paper.open"->{val paper=papers.single {it.id==payload.getString("paperID")};state.value=state.value.copy(selectedPaperId=paper.id,viewedPaper=paper);JSONObject().put("status","opened")}
                "personal.list.edit"->store.editList(payload.getString("key"),payload.getString("action"),FavoriteCollections.paperIDs(payload.getJSONArray("ids")))
                "library.search"->JSONObject().put("query",payload.getString("query")).put("scope","cached-published-guides").put("paperIDs",JSONArray()).put("scannedArticles",0).put("unavailableArticles",0)
                else->JSONObject()
            }
            state.value=state.value.copy(personal=store.snapshot());return result
        }
        override suspend fun updateSecret(kind:SecretKind,value:String?){error("No credentials in context fixture")}
        override suspend fun updatePdfSelection(selection:PdfSelection){}
    }
    private fun open():Controller {val controller=Controller();compose.setContent{PaperDigestApp(controller)};compose.onNodeWithText("论文库").performClick();return controller}
    private fun libraryList()=compose.onNode(hasScrollToIndexAction() and SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange))
    private fun scroll(label:String)=libraryList().performScrollToNode(hasText(label))
    private fun position()=libraryList().fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
    @Test fun readingAndReturningKeepsTheExactLibraryListAnchor(){
        open();scroll("上下文论文 060");val before=position()
        compose.onNodeWithText("上下文论文 060").performClick();compose.onNodeWithContentDescription("论文操作与导出").assertIsDisplayed()
        compose.onNodeWithText("论文库").performClick()
        compose.onNodeWithText("上下文论文 060").assertIsDisplayed();assertEquals(before,position(),0.05f)
    }
    @Test fun explicitSortChangeStartsAtTheTopRatherThanKeepingAnOldResultIndex(){
        open();scroll("上下文论文 030");scroll("筛选与排序 · 最新")
        compose.onNodeWithText("筛选与排序 · 最新").performClick();compose.onNodeWithText("评分").performClick()
        compose.onNodeWithText("查看 120 篇结果").performScrollTo().performClick()
        compose.onNodeWithText("文献资料库").assertIsDisplayed();assertEquals(0f,position(),0.05f)
    }
    @Test fun hiddenSelectionIsExplicitAndCanBeLimitedToTheCurrentResultBeforeBatchAdd(){
        val controller=open();compose.onNodeWithText("多选").performClick();scroll("加选匹配 120 篇");compose.onNodeWithText("加选匹配 120 篇").performClick()
        scroll("搜索论文、作者与笔记");compose.onNodeWithText("搜索论文、作者与笔记").performTextInput("上下文论文 001")
        scroll("已选 120 篇，其中 119 篇不在当前结果中");compose.onNodeWithText("已选 120 篇，其中 119 篇不在当前结果中").assertIsDisplayed()
        compose.onNodeWithText("仅保留当前结果内已选").performScrollTo().performClick()
        compose.onNodeWithText("加入待读").performScrollTo().performClick();compose.waitForIdle()
        assertEquals(listOf("context:1"),controller.store.list("reading"));assertFalse(controller.calls.contains("personal.setList"))
    }
    @Test fun emptyFavoritesExplainCollectionAndAnEmptySearchHasADirectRecovery(){
        val controller=open();compose.onNodeWithText("收藏").performScrollTo().performClick();scroll("还没有收藏");compose.onNodeWithText("还没有收藏").assertIsDisplayed()
        scroll("全部");compose.onNodeWithText("全部").performClick()
        compose.onNodeWithText("搜索论文、作者与笔记").performTextInput("no-synthetic-match")
        compose.waitUntil(5000){controller.calls.contains("library.search")};compose.waitForIdle()
        scroll("清除搜索和筛选");compose.onNodeWithText("当前搜索或筛选没有匹配").assertExists();compose.onNodeWithText("清除搜索和筛选").performClick()
        compose.onNodeWithText("120 篇匹配").assertExists();compose.onNodeWithContentDescription("清除搜索").assertDoesNotExist()
    }
}
