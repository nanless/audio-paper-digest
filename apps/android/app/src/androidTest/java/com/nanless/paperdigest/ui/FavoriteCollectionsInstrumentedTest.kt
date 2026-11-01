package com.nanless.paperdigest.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.nio.file.Files
import java.time.Instant

/** Actual Compose controls and real PersonalStore edits in a private synthetic tree; no HTTP or credentials. */
class FavoriteCollectionsInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private class Controller:AppController {
        val store=PersonalStore(Files.createTempDirectory("favorite-ui-").toRealPath().toFile())
        val a="11111111-1111-4111-8111-111111111111";val b="22222222-2222-4222-8222-222222222222"
        val papers=(1..4).map { Paper("synthetic:$it","Synthetic $it","合成论文 $it",date="2020-01-01") }
        val calls=mutableListOf<Pair<String,JSONObject>>()
        override val state:MutableStateFlow<UiState>
        init {
            val metadata=JSONObject().put("version",1).put("revision",1).put("folders",JSONArray().put(folder(a,"已有分类")).put(folder(b,"第二分类"))).put("items",JSONObject()
                .put("synthetic:1",JSONObject().put("addedAt",Instant.now().toString()).put("folderIDs",JSONArray(listOf(a))))
                .put("synthetic:3",JSONObject().put("addedAt",Instant.now().minusSeconds(40L*86400).toString()).put("folderIDs",JSONArray(listOf(b)))))
            store.replaceValidated(store.snapshot().put("favorites",JSONArray(listOf("synthetic:1","synthetic:2","synthetic:3"))).put(FavoriteCollections.KEY,metadata))
            state=MutableStateFlow(UiState(papers=papers,personal=store.snapshot()))
        }
        private fun folder(id:String,name:String)=JSONObject().put("id",id).put("name",name).put("createdAt","2026-01-01T00:00:00.000Z")
        override suspend fun execute(command:String,payload:JSONObject):JSONObject {
            calls+=command to payload.copy()
            val result=when(command) {
                "personal.list.edit"->store.editList(payload.getString("key"),payload.getString("action"),FavoriteCollections.paperIDs(payload.getJSONArray("ids")))
                "personal.favorite.edit"->store.editFavorites(payload)
                "paper.open"->{val paper=papers.single { it.id==payload.getString("paperID") };state.value=state.value.copy(selectedPaperId=paper.id,viewedPaper=paper);JSONObject().put("status","opened")}
                "library.search"->JSONObject().put("query",payload.getString("query")).put("scope","cached-published-guides").put("paperIDs",JSONArray()).put("scannedArticles",0).put("unavailableArticles",0)
                else->JSONObject()
            }
            state.value=state.value.copy(personal=store.snapshot())
            return result
        }
        override suspend fun updateSecret(kind:SecretKind,value:String?){error("No real credentials in this fixture")}
        override suspend fun updatePdfSelection(selection:PdfSelection){}
    }
    private fun open():Controller {
        val controller=Controller();compose.setContent{PaperDigestApp(controller)}
        compose.onNodeWithText("论文库").performClick()
        return controller
    }
    private fun scroll(label:String) {
        compose.onAllNodes(hasScrollToIndexAction()).onFirst().performScrollToNode(hasText(label))
    }
    @Test fun favoritesHaveDirectEntryRealTimeSectionsMonthsAndAnUnclassifiedFilter(){
        open();compose.onNodeWithText("收藏").performScrollTo().performClick()
        scroll("今天收藏 · 1 篇");compose.onNodeWithText("今天收藏 · 1 篇").assertIsDisplayed()
        scroll("收藏时间未知 · 1 篇");compose.onNodeWithText("收藏时间未知 · 1 篇").assertIsDisplayed()
        scroll("按月份分区");compose.onNodeWithText("按月份分区").performClick()
        scroll("收藏时间未知 · 1 篇");compose.onNodeWithText("收藏时间未知 · 1 篇").assertExists()
        scroll("全部分类");compose.onNodeWithContentDescription("筛选收藏分类：未分类").performClick()
        scroll("合成论文 2");compose.onNodeWithText("合成论文 2").assertIsDisplayed()
        compose.onNodeWithText("合成论文 1").assertDoesNotExist()
    }
    @Test fun readerCanCreateCategoryAndExplicitlyFavoriteAndClassifyInOneDialog(){
        val controller=open();scroll("合成论文 4");compose.onNodeWithText("合成论文 4").performClick()
        compose.onNodeWithContentDescription("论文操作与导出").performClick()
        compose.onNodeWithText("收藏并分类…").performClick()
        compose.onNodeWithText("直接新建分类").performScrollTo().performTextInput("阅读中创建")
        compose.onNodeWithText("创建并选中分类").performScrollTo().performClick()
        compose.waitUntil { FavoriteCollections.view(controller.store.snapshot()).folders.any { it.name=="阅读中创建" } }
        compose.onNodeWithText("收藏并保存分类").performClick()
        compose.waitUntil { "synthetic:4" in controller.store.list("favorites") }
        val view=FavoriteCollections.view(controller.store.snapshot());val folder=view.folders.single { it.name=="阅读中创建" }
        assertEquals(setOf(folder.id),view.items.getValue("synthetic:4").folderIDs)
        assertNotNull(view.items.getValue("synthetic:4").addedAt)
        assertTrue(controller.calls.none { it.first=="personal.setList" })
    }
    @Test fun bulkAddCategoryKeepsOriginalCategoryAndOriginalFavoriteTime(){
        val controller=open();val original=FavoriteCollections.view(controller.store.snapshot()).items.getValue("synthetic:1").addedAt
        compose.onNodeWithText("收藏").performScrollTo().performClick()
        scroll("多选");compose.onNodeWithText("多选").performClick()
        scroll("合成论文 1");compose.onNodeWithText("合成论文 1").performClick()
        scroll("加入分类…");compose.onNodeWithText("加入分类…").performClick()
        compose.onNodeWithContentDescription("收藏分类：第二分类").performScrollTo().performClick()
        compose.onNodeWithText("保存分类").performClick()
        compose.waitUntil { FavoriteCollections.view(controller.store.snapshot()).items.getValue("synthetic:1").folderIDs.size==2 }
        val item=FavoriteCollections.view(controller.store.snapshot()).items.getValue("synthetic:1")
        assertEquals(setOf(controller.a,controller.b),item.folderIDs);assertEquals(original,item.addedAt)
    }
    @Test fun restoredAssignmentKeepsOriginalRevisionUntilExplicitNativeReload(){
        val controller=Controller();val restoration=StateRestorationTester(compose)
        restoration.setContent {val state by controller.state.collectAsState();androidx.compose.material3.MaterialTheme{FavoriteAssignmentDialog(FavoriteCollections.view(state.personal),state.personal.ids("favorites").toSet(),listOf("synthetic:1"),controller,{})}}
        compose.onNodeWithContentDescription("收藏分类：第二分类").performScrollTo().performClick()
        controller.store.editFavorites(JSONObject().put("action","folder.rename").put("folderID",controller.b).put("name","另一视图改名").put("expectedRevision",1))
        compose.runOnIdle {controller.state.value=controller.state.value.copy(personal=controller.store.snapshot())}
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithContentDescription("收藏分类：另一视图改名").assertIsOn()
        compose.onNodeWithText("保存分类").performClick();compose.waitForIdle()
        assertEquals(1,controller.calls.last {it.first=="personal.favorite.edit"}.second.getInt("expectedRevision"))
        assertEquals(setOf(controller.a),FavoriteCollections.view(controller.store.snapshot()).items.getValue("synthetic:1").folderIDs)
        compose.onNodeWithText("重新读取当前分类").performScrollTo().performClick();compose.waitForIdle()
        compose.onNodeWithText("保存分类").performClick();compose.waitForIdle()
        assertEquals(setOf(controller.a,controller.b),FavoriteCollections.view(controller.store.snapshot()).items.getValue("synthetic:1").folderIDs)
        assertTrue(controller.calls.any {it.first=="app.bootstrap"})
    }
    @Test fun restoredManagerDraftDoesNotSilentlyRebaseItsRevision(){
        val controller=Controller();val restoration=StateRestorationTester(compose)
        restoration.setContent {val state by controller.state.collectAsState();androidx.compose.material3.MaterialTheme{FavoriteFolderManager(FavoriteCollections.view(state.personal),controller,{})}}
        compose.onNodeWithText("新分类名称").performScrollTo().performTextInput("保留的新名称")
        controller.store.editFavorites(JSONObject().put("action","folder.rename").put("folderID",controller.b).put("name","另一窗口分类").put("expectedRevision",1))
        compose.runOnIdle {controller.state.value=controller.state.value.copy(personal=controller.store.snapshot())}
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("创建分类").performScrollTo().performClick();compose.waitForIdle()
        assertEquals(1,controller.calls.last {it.first=="personal.favorite.edit"}.second.getInt("expectedRevision"))
        assertTrue(FavoriteCollections.view(controller.store.snapshot()).folders.none {it.name=="保留的新名称"})
        compose.onNodeWithText("重新读取当前分类").performScrollTo().performClick();compose.waitForIdle()
        compose.onNodeWithText("创建分类").performScrollTo().performClick();compose.waitForIdle()
        assertTrue(FavoriteCollections.view(controller.store.snapshot()).folders.any {it.name=="保留的新名称"})
    }
    @Test fun failedDeleteClosesItsConfirmationAndShowsVisibleConflictWithoutRemovingFavorites(){
        val controller=Controller()
        compose.setContent {val state by controller.state.collectAsState();androidx.compose.material3.MaterialTheme{FavoriteFolderManager(FavoriteCollections.view(state.personal),controller,{})}}
        compose.onNodeWithContentDescription("删除分类：已有分类").performScrollTo().performClick()
        controller.store.editFavorites(JSONObject().put("action","folder.rename").put("folderID",controller.a).put("name","其他窗口的新名字").put("expectedRevision",1))
        compose.runOnIdle {controller.state.value=controller.state.value.copy(personal=controller.store.snapshot())}
        compose.onNodeWithText("删除分类，保留收藏").performClick();compose.waitForIdle()
        compose.onNodeWithText("删除分类，保留收藏").assertDoesNotExist()
        compose.onNodeWithText("收藏分类已在其他操作中改变；请重新打开分类后再试，原收藏保留。").assertIsDisplayed()
        assertEquals(3,controller.store.list("favorites").size)
        assertTrue(FavoriteCollections.view(controller.store.snapshot()).folders.any {it.id==controller.a})
    }
}
