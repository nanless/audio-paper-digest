package com.nanless.paperdigest.ui

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
import java.time.Instant

/** Actual website-tree controls; synthetic fixture never invokes HTTP, accounts or model APIs. */
class FavoriteCollectionsInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private class Controller:AppController {
        val hash="a".repeat(64)
        fun node(id:String,name:String,ancestors:List<String>)=JSONObject().put("id",id).put("facet","task").put("zh",name).put("ancestorIds",JSONArray(ancestors)).put("aliases",JSONArray())
        val source=JSONObject().put("contract","paper-tag-catalog-snapshot-v2").put("registrySha256",hash).put("registryVersion","paper-taxonomy-v2").put("concepts",JSONArray().put(node("task.audio","音频任务",emptyList())).put(node("task.music","音乐处理",listOf("task.audio"))).put(node("task.mix","音乐混音",listOf("task.audio","task.music"))))
        val taxonomy=WebsiteTaxonomy.parse(JSONObject().put("snapshot",source).put("versions",JSONObject().put("contract","paper-tag-catalog-versions-v2").put("currentSha256",hash).put("snapshots",JSONArray().put(source))))
        val record=JSONObject().put("tagContract","paper-tag-flat-tags-v2").put("tagCatalogSha256",hash).put("tagConcepts",JSONArray().put(JSONObject().put("id","task.mix").put("facet","task").put("label","音乐混音")))
        val papers=listOf(Paper("synthetic:1","One","网站三级论文",original=JSONObject().put("websiteTagRecords",JSONArray().put(record))),Paper("synthetic:2","Two","旧收藏论文"))
        val personal=JSONObject().put("favorites",JSONArray(papers.map{it.id})).put("reading",JSONArray()).put("favoriteCollections",JSONObject().put("version",1).put("revision",1).put("folders",JSONArray().put(JSONObject().put("id","11111111-1111-4111-8111-111111111111").put("name","禁止显示的自建分类").put("createdAt","2026-01-01T00:00:00Z"))).put("items",JSONObject().put("synthetic:1",JSONObject().put("addedAt",Instant.now().toString()).put("folderIDs",JSONArray(listOf("11111111-1111-4111-8111-111111111111"))))))
        val calls=mutableListOf<String>();override val state=MutableStateFlow(UiState(papers=papers,websiteTaxonomy=taxonomy,personal=personal))
        override suspend fun execute(command:String,payload:JSONObject):JSONObject {calls+=command;when(command){"paper.open"->{val p=papers.single{it.id==payload.getString("paperID")};state.value=state.value.copy(viewedPaper=p,selectedPaperId=p.id)};"library.search"->return JSONObject().put("query",payload.getString("query")).put("scope","cached-published-guides").put("paperIDs",JSONArray()).put("scannedArticles",0).put("unavailableArticles",0)};return JSONObject()}
        override suspend fun updateSecret(kind:SecretKind,value:String?){error("No credentials")};override suspend fun updatePdfSelection(selection:PdfSelection){}
    }
    private fun open():Controller {val c=Controller();compose.setContent{PaperDigestApp(c)};compose.onNodeWithText("论文库").performClick();compose.waitUntil(5000){compose.onAllNodesWithText("2 篇匹配").fetchSemanticsNodes().isNotEmpty()};return c}
    private fun scroll(text:String){compose.onNodeWithTag("library-results").performScrollToNode(hasText(text))}
    @Test fun fullLibraryHasThreeLevelDirectoryWithoutRequiringFavorites(){
        val c=open();val original=c.personal.toString();compose.onNodeWithText("研究方向").performClick()
        compose.onNodeWithContentDescription("展开网站方向：音频任务").performClick();compose.onNodeWithContentDescription("展开网站方向：音乐处理").performClick()
        compose.onNodeWithContentDescription("筛选网站方向：音乐混音").performClick();compose.onNodeWithText("查看 1 篇论文").performClick();scroll("网站三级论文");compose.onNodeWithText("网站三级论文").assertIsDisplayed()
        compose.onNodeWithText("旧收藏论文").assertDoesNotExist();compose.onNodeWithText("禁止显示的自建分类").assertDoesNotExist();assertEquals(original,c.personal.toString());assertFalse(c.calls.contains("personal.favorite.edit"))
    }
    @Test fun favoriteTimeMonthsAndScopeSpecificQueryRemainIndependent(){
        open();compose.onNodeWithText("论文、作者、编号或笔记").performTextInput("网站")
        compose.onNodeWithText("收藏").performClick();compose.onNodeWithText("论文、作者、编号或笔记").assertTextContains("")
        scroll("今天收藏 · 1 篇");compose.onNodeWithText("今天收藏 · 1 篇").assertExists();scroll("收藏时间未知 · 1 篇");compose.onNodeWithText("收藏时间未知 · 1 篇").assertExists()
        scroll("按月份分区");compose.onNodeWithText("按月份分区").performClick();scroll("论文、作者、编号或笔记");compose.onNodeWithText("论文、作者、编号或笔记").performTextInput("旧收藏")
        scroll("全部");compose.onNodeWithText("全部").performClick();compose.onNodeWithText("网站").assertExists();compose.onNodeWithText("管理分类").assertDoesNotExist()
    }
    @Test fun readerKeepsSimpleFavoriteWithoutManualClassificationMenu(){
        open();scroll("网站三级论文");compose.onNodeWithText("网站三级论文").performClick();compose.onNodeWithContentDescription("论文操作与导出").performClick()
        compose.onNodeWithText("取消收藏").assertExists();compose.onNodeWithText("整理收藏分类…").assertDoesNotExist();compose.onNodeWithText("收藏并分类…").assertDoesNotExist()
    }
    @Test fun allNineFacetsAndZeroResultNodesRemainReachable(){
        val c=Controller();val source=c.source.copy();source.getJSONArray("concepts").put(c.node("task.zero","零论文方向",emptyList()));val graph=WebsiteTaxonomy.parse(JSONObject().put("snapshot",source).put("versions",JSONObject().put("contract","paper-tag-catalog-versions-v2").put("currentSha256",c.hash).put("snapshots",JSONArray().put(source))))
        c.state.value=c.state.value.copy(websiteTaxonomy=graph);compose.setContent{PaperDigestApp(c)};compose.onNodeWithText("论文库").performClick();compose.onNodeWithText("研究方向").performClick()
        compose.onNodeWithContentDescription("筛选网站方向：零论文方向").performClick();compose.onNodeWithText("查看 0 篇论文").performClick();compose.onNodeWithText("零论文方向").assertExists();scroll("当前搜索或筛选没有匹配");compose.onNodeWithText("当前搜索或筛选没有匹配").assertExists()
        scroll("方向 1");compose.onNodeWithText("方向 1").performClick();compose.onNodeWithContentDescription("筛选网站方向：零论文方向").assertIsOn()
        compose.onNodeWithTag("website-facets").performScrollToNode(hasContentDescription("目录维度：模型家族"));compose.onNodeWithContentDescription("目录维度：模型家族").assertExists()
    }
    @Test fun retainedOldPapersAndFutureFavoriteMetadataRemainExplicitWithoutWrites(){
        val c=Controller();c.personal.getJSONObject("favoriteCollections").put("version",2);c.state.value=c.state.value.copy(personal=c.personal,catalogSummary=JSONObject().put("missingFromLatest",JSONArray(listOf("synthetic:1"))))
        compose.setContent{PaperDigestApp(c)};compose.onNodeWithText("论文库").performClick();compose.onNodeWithText("收藏").performClick();scroll("收藏数据由较新版本保存；更新应用后可编辑，现有收藏仍可阅读。");compose.onNodeWithText("收藏数据由较新版本保存；更新应用后可编辑，现有收藏仍可阅读。").assertIsDisplayed()
        scroll("本机保留 · 未列入最新网站快照（不表示撤稿）");compose.onNodeWithText("本机保留 · 未列入最新网站快照（不表示撤稿）").assertIsDisplayed();scroll("多选");compose.onNodeWithText("多选").performClick();scroll("网站三级论文");compose.onNodeWithText("网站三级论文").performClick();scroll("收藏 1 篇");compose.onNodeWithText("收藏 1 篇").assertIsNotEnabled();assertFalse(c.calls.contains("personal.favorite.edit"))
    }

}
