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
    private fun open():Controller {val c=Controller();compose.setContent{PaperDigestApp(c)};compose.onNodeWithText("论文库").performClick();compose.onNodeWithText("收藏").performScrollTo().performClick();return c}
    private fun scroll(text:String){compose.onAllNodes(hasScrollToIndexAction()).onFirst().performScrollToNode(hasText(text))}
    @Test fun websiteTreeHasThreeLevelsAndNoCustomFolders(){
        val c=open();val original=c.personal.toString();scroll("浏览网站分类 · 全部网站分类");compose.onNodeWithText("浏览网站分类 · 全部网站分类").performClick()
        compose.onNodeWithContentDescription("展开网站分类：音频任务").performClick();compose.onNodeWithContentDescription("展开网站分类：音乐处理").performClick()
        compose.onNodeWithContentDescription("筛选网站分类：音乐混音").performClick();scroll("网站三级论文");compose.onNodeWithText("网站三级论文").assertIsDisplayed()
        compose.onNodeWithText("旧收藏论文").assertDoesNotExist();compose.onNodeWithText("禁止显示的自建分类").assertDoesNotExist()
        assertEquals(original,c.personal.toString());assertFalse(c.calls.contains("personal.favorite.edit"))
    }
    @Test fun favoriteTimeMonthsRemainAndNoCustomEditingEntrypoints(){
        open();scroll("今天收藏 · 1 篇");compose.onNodeWithText("今天收藏 · 1 篇").assertIsDisplayed();scroll("收藏时间未知 · 1 篇");compose.onNodeWithText("收藏时间未知 · 1 篇").assertIsDisplayed()
        scroll("按月份分区");compose.onNodeWithText("按月份分区").performClick();compose.onNodeWithText("管理分类").assertDoesNotExist();compose.onNodeWithText("整理分类…").assertDoesNotExist()
        scroll("多选");compose.onNodeWithText("多选").performClick();compose.onNodeWithText("加入分类…").assertDoesNotExist();compose.onNodeWithText("收藏并分类…").assertDoesNotExist()
    }
    @Test fun readerKeepsSimpleFavoriteWithoutManualClassificationMenu(){
        open();scroll("网站三级论文");compose.onNodeWithText("网站三级论文").performClick();compose.onNodeWithContentDescription("论文操作与导出").performClick()
        compose.onNodeWithText("取消收藏").assertExists();compose.onNodeWithText("整理收藏分类…").assertDoesNotExist();compose.onNodeWithText("收藏并分类…").assertDoesNotExist();compose.onNodeWithText("直接新建分类").assertDoesNotExist()
    }
    @Test fun scienceOnlyFavoritesOpenTheAvailableFacetImmediately(){
        val c=Controller();val node=JSONObject().put("id","scientific_topic.wave").put("facet","scientific_topic").put("zh","声波主题").put("ancestorIds",JSONArray()).put("aliases",JSONArray())
        val snapshot=c.source.copy().put("concepts",JSONArray().put(node));val graph=WebsiteTaxonomy.parse(JSONObject().put("snapshot",snapshot).put("versions",JSONObject().put("contract","paper-tag-catalog-versions-v2").put("currentSha256",c.hash).put("snapshots",JSONArray().put(snapshot))))
        val record=c.record.copy().put("tagConcepts",JSONArray().put(JSONObject().put("id","scientific_topic.wave").put("facet","scientific_topic").put("label","声波主题")))
        val paper=Paper("science","Science",original=JSONObject().put("websiteTagRecords",JSONArray().put(record)))
        compose.setContent{androidx.compose.material3.MaterialTheme{WebsiteFavoriteCategoryPicker(WebsiteFavoriteIndex(graph,listOf(paper)),"",{}, {})}}
        compose.onNodeWithContentDescription("筛选网站分类：声波主题").assertIsDisplayed()
    }

}
