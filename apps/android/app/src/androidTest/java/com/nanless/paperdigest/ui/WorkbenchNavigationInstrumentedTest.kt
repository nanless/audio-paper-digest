package com.nanless.paperdigest.ui

import androidx.compose.ui.test.*
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Synthetic UI navigation only. No production controller, filesystem, credentials or network. */
class WorkbenchNavigationInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private class Controller:AppController {
        private val source=AggregateSource("a".repeat(64),"b".repeat(64),1,"index.json",0,"c".repeat(64),"foundation-sorted-keys-json-v1")
        val daily=PublishedAggregate("synthetic-day","daily",null,"合成日更","合成日更","", "2026-10-31","2026-10-31",emptyList(),emptyList(),PublishedAggregateReader.SITE+"posts/synthetic-day/",source)
        val conference=daily.copy(id="synthetic-conference",kind="conference",conferenceScope="overview",title="合成会议总览",titleZh="合成会议总览",sourceURL=PublishedAggregateReader.SITE+"posts/conference-synthetic-2026/")
        val directory=daily.copy(id="synthetic-directory",kind="page",title="全部会议目录",titleZh="全部会议目录",sourceURL=PublishedAggregateReader.SITE+"conferences/")
        val paper=Paper("synthetic-paper","Synthetic paper","合成测试论文")
        val catalog=PublishedAggregateCatalog(source.manifestSHA256,3,listOf(daily,conference,directory))
        override val state=MutableStateFlow(UiState(papers=listOf(paper),personal=JSONObject().put("notes",JSONObject()).put("annotations",JSONObject()),aggregate=AggregateBrowseState(catalog=catalog,attemptedIndex=true)))
        val calls=mutableListOf<String>()
        val readerOwners=mutableSetOf<Any>()
        override fun readingViewVisible(owner:Any,visible:Boolean){if(visible)readerOwners.add(owner)else readerOwners.remove(owner)}
        override fun leaveAggregateView(){state.value=state.value.copy(aggregate=state.value.aggregate.copy(selected=null,document=null))}
        override fun enterAggregateView()=leaveAggregateView()
        override fun aggregateLinkIsCurrent(nonce:String,index:Int)=state.value.aggregate.document?.linkNonce==nonce&&index==0
        override suspend fun execute(command:String,payload:JSONObject):JSONObject {
            calls+=command
            when(command){
                "aggregate.list","aggregate.back"->leaveAggregateView()
                "aggregate.select","aggregate.resume"->{
                    val record=catalog.records.single{it.id==payload.getString("id")}
                    val html="<h1>合成汇总正文</h1><p><a href='${PublishedAggregateReader.SITE}posts/synthetic-paper/'>打开测试论文</a></p>"
                    val original=AggregateDocumentView(record,html,"d".repeat(64),PublishedAggregateReader.sha(html.toByteArray()),html.length,"2026-10-31T00:00:00Z",emptyList(),emptyList(),true)
                    val links=AggregateLinkTable.derive(original)
                    state.value=state.value.copy(selectedPaperId=null,viewedPaper=null,aggregate=state.value.aggregate.copy(selected=record,document=original.copy(linkHTML=links.html,linkNonce=links.nonce),attemptedIndex=true))
                }
                "aggregate.link"->{
                    assertTrue(aggregateLinkIsCurrent(payload.getString("nonce"),payload.getInt("index")))
                    state.value=state.value.copy(selectedPaperId=paper.id,viewedPaper=paper)
                    return JSONObject().put("status","link-opened").put("kind","paper").put("paperID",paper.id)
                }
            }
            return JSONObject().put("status","ready")
        }
        override suspend fun updateSecret(kind:SecretKind,value:String?){error("No credentials in navigation fixture")}
        override suspend fun updatePdfSelection(selection:PdfSelection){}
    }
    @Test fun firstLaunchShowsDailyAndConferenceIsFirstLevelAndSetupIsDirect(){
        val controller=Controller();compose.setContent{PaperDigestApp(controller)}
        compose.onNodeWithText("每日论文速递").assertIsDisplayed()
        compose.onNodeWithText("合成日更").assertExists()
        compose.onNodeWithText("会议论文集 2").performClick()
        compose.onNodeWithText("会议").assertIsSelected()
        compose.onNodeWithText("会议论文集").assertExists()
        compose.onAllNodesWithText("全部会议目录").onFirst().assertExists()
        compose.onNodeWithText("合成会议总览").assertExists()
        compose.onNodeWithText("简单配置").performClick()
        compose.onNodeWithText("连接你的研究资料").assertIsDisplayed()
        compose.onNodeWithText("配置 WebDAV 备份").performScrollTo().performClick()
        compose.onNodeWithText("2. 填写账号，再安全保存应用密码").performScrollTo().assertIsDisplayed()
        assertTrue(controller.calls.none{it.startsWith("cloud.")||it.startsWith("zotero.")||it.startsWith("model.")})
    }
    private fun views(root:View):List<View> = listOf(root)+(if(root is ViewGroup)(0 until root.childCount).flatMap{views(root.getChildAt(it))}else emptyList())
    /** Locate the actual document anchor through a fresh system tree, then touch its rendered pixels.
     * WebView's cold accessibility cache is not used as a substitute for the real link callback. */
    private fun touchPaperLink(device:UiDevice){
        var web:WebView?=null
        compose.waitUntil(30000){
            compose.runOnUiThread {
                val activity=ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).singleOrNull()
                web=activity?.let{views(it.window.decorView).filterIsInstance<WebView>().firstOrNull{v->v.isShown&&v.progress==100&&v.contentHeight>0}}
            }
            web!=null
        }
        var point:Pair<Int,Int>?=null
        compose.waitUntil(30000){
            // A full system snapshot refreshes WebView's lazily populated accessibility subtree.
            val snapshot=java.io.ByteArrayOutputStream()
            runCatching{device.dumpWindowHierarchy(snapshot)}
            if(snapshot.size()>0){
                val parser=android.util.Xml.newPullParser();parser.setInput(snapshot.toString("UTF-8").reader())
                while(parser.eventType!=org.xmlpull.v1.XmlPullParser.END_DOCUMENT){
                    if(parser.eventType==org.xmlpull.v1.XmlPullParser.START_TAG&&parser.name=="node"&&
                        (parser.getAttributeValue(null,"text")=="打开测试论文"||parser.getAttributeValue(null,"content-desc")=="打开测试论文")){
                        val values=Regex("[0-9]+").findAll(parser.getAttributeValue(null,"bounds").orEmpty()).map{it.value.toInt()}.toList()
                        if(values.size==4&&values[2]>values[0]&&values[3]>values[1])point=(values[0]+values[2])/2 to (values[1]+values[3])/2
                    }
                    parser.next()
                }
            }
            point!=null
        }
        val (x,y)=requireNotNull(point);assertTrue(device.click(x,y))
    }

    @Test fun paperLinkHasVisibleReturnToExactDailyAndSystemBackAlsoReturns(){
        val controller=Controller();val shown=mutableStateOf(true);compose.setContent{if(shown.value)PaperDigestApp(controller)}
        compose.onNodeWithText("合成日更").performScrollTo().performClick()
        compose.waitUntil(5000){controller.state.value.aggregate.selected?.id==controller.daily.id}
        val device=UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        touchPaperLink(device)
        compose.waitUntil(15000){controller.state.value.selectedPaperId==controller.paper.id}
        compose.waitUntil(5000){controller.readerOwners.size==1}
        compose.onNodeWithText("返回日更汇总").assertIsDisplayed().performClick()
        compose.waitUntil(5000){controller.readerOwners.isEmpty()}
        compose.waitUntil(15000){controller.state.value.aggregate.selected?.id==controller.daily.id}
        compose.onNodeWithText("合成日更").assertExists()
        touchPaperLink(device)
        compose.waitUntil(15000){controller.state.value.selectedPaperId==controller.paper.id}
        compose.onNodeWithText("返回日更汇总").assertIsDisplayed()
        compose.waitForIdle()
        device.pressBack()
        compose.waitUntil(15000){controller.state.value.aggregate.selected?.id==controller.daily.id}
        compose.waitUntil(5000){controller.readerOwners.isEmpty()}
        assertEquals(1,controller.calls.count{it=="aggregate.select"});assertEquals(2,controller.calls.count{it=="aggregate.resume"})
        touchPaperLink(device)
        compose.waitUntil(5000){controller.readerOwners.size==1}
        compose.onNodeWithText("论文库").performClick()
        compose.waitUntil(5000){controller.readerOwners.isEmpty()}
        assertEquals("The library keeps the selected paper without marking its reader visible",controller.paper.id,controller.state.value.selectedPaperId)
        compose.onNodeWithText("日更").performClick()
        compose.onNodeWithText("合成日更").performScrollTo().performClick()
        touchPaperLink(device)
        compose.waitUntil(5000){controller.readerOwners.size==1}
        compose.runOnIdle{shown.value=false}
        compose.waitUntil(5000){controller.readerOwners.isEmpty()}
    }

}
