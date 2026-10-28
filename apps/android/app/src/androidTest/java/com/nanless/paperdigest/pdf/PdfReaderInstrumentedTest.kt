package com.nanless.paperdigest.pdf

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PdfReaderInstrumentedTest {
 @get:Rule val compose=createAndroidComposeRule<PdfHarnessActivity>()
 private fun assertSystemSafeControl(id:Int){
  compose.activityRule.scenario.onActivity{activity->
   val root=activity.window.decorView;val inset=requireNotNull(androidx.core.view.ViewCompat.getRootWindowInsets(root)).getInsetsIgnoringVisibility(androidx.core.view.WindowInsetsCompat.Type.systemBars());val visible=android.graphics.Rect();val view=requireNotNull(activity.findViewById<android.view.View>(id));assertTrue(view.getGlobalVisibleRect(visible));assertTrue("Native search control must be fully below the system status bar",visible.top>=inset.top);assertTrue("Native search control must not overlap the real system navigation area",visible.bottom<=root.height-inset.bottom)
   assertEquals(androidx.lifecycle.Lifecycle.State.RESUMED,activity.lifecycle.currentState)
  }
  val instrument=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation();assertEquals(instrument.targetContext.packageName,androidx.test.uiautomator.UiDevice.getInstance(instrument).currentPackageName)
 }
 private fun matchOrdinal():Int {var ordinal=-1;compose.activityRule.scenario.onActivity{activity->ordinal=Regex("[0-9]+").find(activity.findViewById<android.widget.TextView>(androidx.pdf.R.id.matchStatusTextView)?.text?.toString().orEmpty())?.value?.toInt()?:-1};return ordinal}
 @Test fun actualNativeViewerLoadsThirteenPagesAndNavigatesWithPhysicalPageControls(){
  compose.waitUntil(30000){compose.onAllNodesWithText("原文已载入 · 物理页 1 / 13").fetchSemanticsNodes().isNotEmpty()}
  compose.activityRule.scenario.onActivity{activity->
   val fragment=activity.supportFragmentManager.fragments.filterIsInstance<DigestPdfFragment>().single();assertEquals(13,fragment.loadedPageCount);assertTrue(fragment.documentReady)
   fun surfaces(view:android.view.View):List<androidx.pdf.view.PdfView> = (if(view is androidx.pdf.view.PdfView)listOf(view)else emptyList())+(if(view is android.view.ViewGroup)(0 until view.childCount).flatMap{surfaces(view.getChildAt(it))}else emptyList())
   val surface=surfaces(fragment.requireView()).single();assertTrue("Ready requires an attached, measured native rendering surface",surface.isAttachedToWindow&&surface.width>0&&surface.height>0)
  }
  compose.onNodeWithText("下一页").performClick()
  compose.waitUntil(10000){compose.onAllNodesWithText("原文已载入 · 物理页 2 / 13").fetchSemanticsNodes().isNotEmpty()}
  compose.onNodeWithText("上一页").performClick()
  compose.waitUntil(10000){compose.onAllNodesWithText("原文已载入 · 物理页 1 / 13").fetchSemanticsNodes().isNotEmpty()}
  compose.onNodeWithText("选取本页文字").performClick()
  compose.waitUntil(10000){compose.onAllNodesWithText("选取物理页 1 的原文").fetchSemanticsNodes().isNotEmpty()}
  compose.onNodeWithText("采用选区").assertIsNotEnabled()
  compose.onNodeWithText("取消").performClick()
  compose.onNodeWithText("查找").assertIsEnabled().performClick()
  var nativeSearch=false
  compose.activityRule.scenario.onActivity{activity->nativeSearch=activity.supportFragmentManager.fragments.filterIsInstance<DigestPdfFragment>().single().nativeSearchAvailable}
  if(nativeSearch){
  androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.withId(androidx.pdf.R.id.searchQueryBox)).perform(androidx.test.espresso.action.ViewActions.replaceText("MiCLA"),androidx.test.espresso.action.ViewActions.closeSoftKeyboard())
  compose.waitUntil(15000){var found=false;compose.activityRule.scenario.onActivity{activity->val status=activity.findViewById<android.widget.TextView>(androidx.pdf.R.id.matchStatusTextView)?.text?.toString().orEmpty();val numbers=Regex("[0-9]+").findAll(status).map{it.value.toInt()}.toList();found=numbers.size>=2&&numbers.last()>0};found}
  assertSystemSafeControl(androidx.pdf.R.id.findNextButton);val firstMatch=matchOrdinal();assertTrue(firstMatch>0)
  androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.withId(androidx.pdf.R.id.findNextButton)).check(androidx.test.espresso.assertion.ViewAssertions.matches(androidx.test.espresso.matcher.ViewMatchers.isEnabled())).perform(androidx.test.espresso.action.ViewActions.click())
  compose.waitUntil(10000){matchOrdinal()>0&&matchOrdinal()!=firstMatch};assertSystemSafeControl(androidx.pdf.R.id.closeButton)
  androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.withId(androidx.pdf.R.id.closeButton)).perform(androidx.test.espresso.action.ViewActions.click())
  compose.waitUntil(10000){var closed=false;compose.activityRule.scenario.onActivity{activity->closed=activity.findViewById<android.view.View>(androidx.pdf.viewer.fragment.R.id.pdfSearchView)?.isShown==false};closed}
  }else{
   compose.onNodeWithText("查找 PDF 原文").performTextInput("MiCLA")
   compose.onNodeWithText("查找原文").performClick()
   compose.waitUntil(20000){compose.onAllNodesWithText("原文匹配 1 /",substring=true).fetchSemanticsNodes().isNotEmpty()}
   compose.onNodeWithText("下一个结果").assertIsEnabled().performClick()
   compose.onNodeWithText("原文匹配 2 /",substring=true).assertIsDisplayed()
   compose.onNodeWithText("关闭查找").performClick()
   compose.onNodeWithText("查找 PDF 原文").assertDoesNotExist()
  }
  val instrument=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation();assertEquals(instrument.targetContext.packageName,androidx.test.uiautomator.UiDevice.getInstance(instrument).currentPackageName)
  compose.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.DESTROYED)
  assertEquals("The actual PDF host must close completely",androidx.lifecycle.Lifecycle.State.DESTROYED,compose.activityRule.scenario.state)
 }
 // Normal component regression: the dedicated offline emulator's existing
 // PdfHarnessActivity imports the bundled public PDF; no private document input.
 @OptIn(androidx.pdf.ExperimentalPdfApi::class)
 private fun actualSurface():Pair<DigestPdfFragment,androidx.pdf.view.PdfView>{
  var result:Pair<DigestPdfFragment,androidx.pdf.view.PdfView>?=null
  compose.activityRule.scenario.onActivity{activity->
   val fragment=activity.supportFragmentManager.fragments.filterIsInstance<DigestPdfFragment>().single{it.isAdded&&it.isVisible}
   fun views(v:android.view.View):List<androidx.pdf.view.PdfView> = (if(v is androidx.pdf.view.PdfView)listOf(v)else emptyList())+(if(v is android.view.ViewGroup)(0 until v.childCount).flatMap{views(v.getChildAt(it))}else emptyList())
   result=fragment to views(fragment.requireView()).single()
  };return requireNotNull(result)
 }
 @OptIn(androidx.pdf.ExperimentalPdfApi::class)
 private fun waitPhysicalPage(page:Int){compose.waitUntil(30000){runCatching{var good=false;val (fragment,view)=actualSurface();compose.activityRule.scenario.onActivity{good=fragment.documentReady&&view.isAttachedToWindow&&view.isShown&&view.width>0&&view.height>0&&view.firstVisiblePage==page-1&&view.visiblePagesCount>0};good}.getOrDefault(false)}}
 private fun nativeControl(label:String){val described=compose.onAllNodesWithContentDescription(label).fetchSemanticsNodes();if(described.size==1)compose.onNodeWithContentDescription(label).assertIsDisplayed().assertIsEnabled().performClick()else compose.onNodeWithText(label).assertIsDisplayed().assertIsEnabled().performClick()}
 @OptIn(androidx.pdf.ExperimentalPdfApi::class)
 @Test fun composePageUpdatesMoveTheSameLoadedNativeDocument(){
  waitPhysicalPage(1)
  val (fragment,view)=actualSurface();var nativeDocument:androidx.pdf.PdfDocument?=null
  compose.activityRule.scenario.onActivity{nativeDocument=view.pdfDocument}
  assertNotNull(nativeDocument);assertEquals(13,nativeDocument!!.pageCount)
  for(page in 2..5){nativeControl("下一页");waitPhysicalPage(page)}
  nativeControl("上一页");waitPhysicalPage(4)
  val (afterFragment,afterView)=actualSurface();assertSame(fragment,afterFragment);assertSame(view,afterView)
  compose.activityRule.scenario.onActivity{assertSame("Page-only Compose updates do not reload the PDF",nativeDocument,afterView.pdfDocument)}
 }
 @OptIn(androidx.pdf.ExperimentalPdfApi::class)
 @Test fun delayedForeignDocumentBindingCannotRetargetTheCurrentFragment(){
  waitPhysicalPage(1);val (fragment,view)=actualSurface()
  var oldReference:Any?=null;var oldCallback:Any?=null;var foreignCallbacks=0
  val reference=DigestPdfFragment::class.java.getDeclaredField("reference").apply{isAccessible=true}
  val callback=DigestPdfFragment::class.java.getDeclaredField("pageChanged").apply{isAccessible=true}
  compose.activityRule.scenario.onActivity{
   oldReference=reference.get(fragment);oldCallback=callback.get(fragment)
   val a=fragment.requireArguments();val foreign=PdfDocumentRef(a.getString("id")+"-foreign",a.getString("file")!!,a.getString("sha")!!,a.getInt("count"),a.getString("name")!!)
   // The bytes are still the real public fixture. Only a mismatching owner is
   // supplied, through the same native bind method used by Compose.
   fragment.bind(foreign,5,emptyList(),{foreignCallbacks++},{foreignCallbacks++},{foreignCallbacks++})
   assertSame(oldReference,reference.get(fragment));assertSame(oldCallback,callback.get(fragment))
   assertEquals(0,view.firstVisiblePage);assertEquals(0,foreignCallbacks)
  }
  nativeControl("下一页");waitPhysicalPage(2)
  val (afterFragment,afterView)=actualSurface();assertSame(fragment,afterFragment);assertSame(view,afterView);assertEquals(0,foreignCallbacks)
 }

 // Real Compose measurement regression on a dedicated offline emulator. The
 // standard target Application startup is outside this synthetic fixture claim.
 @OptIn(androidx.pdf.ExperimentalPdfApi::class)
 @Test fun measuredWidthChangesKeepTheLogicalPageAndSameNativeDocument(){
  waitPhysicalPage(1)
  lateinit var document:PdfDocumentRef
  compose.activityRule.scenario.onActivity{activity->
   val args=activity.supportFragmentManager.fragments.filterIsInstance<DigestPdfFragment>().single{it.isAdded&&it.isVisible}.requireArguments()
   document=PdfDocumentRef(args.getString("id")!!,args.getString("file")!!,args.getString("sha")!!,args.getInt("count"),args.getString("name")!!)
  }
  val fraction=mutableFloatStateOf(.46f);val logicalPage=mutableIntStateOf(1)
  val pages=mutableListOf<Int>();val events=mutableListOf<String>()
  compose.activityRule.scenario.onActivity{activity->activity.setContent{
   MaterialTheme{Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)){
    PdfReaderPane(document,logicalPage.intValue,{logicalPage.intValue=it;pages+=it},{},Modifier.fillMaxHeight().fillMaxWidth(fraction.floatValue),onSaveAnnotation={_,_->})
   }}
  }}
  compose.waitForIdle();waitPhysicalPage(1)
  val (fragment,view)=actualSurface();var nativeDocument:androidx.pdf.PdfDocument?=null
  compose.activityRule.scenario.onActivity{nativeDocument=view.pdfDocument}
  val layout=android.view.View.OnLayoutChangeListener{v,l,t,r,b,ol,ot,or,ob->
   check(android.os.Looper.myLooper()==android.os.Looper.getMainLooper())
   events+="layout ${or-ol}x${ob-ot}->${r-l}x${b-t}; root=${logicalPage.intValue}; first=${view.firstVisiblePage}; count=${view.visiblePagesCount}; same=${v===view}"
  }
  val viewport=object:androidx.pdf.view.PdfView.OnViewportChangedListener{
   override fun onViewportChanged(firstVisiblePage:Int,visiblePagesCount:Int,pageLocations:android.util.SparseArray<android.graphics.RectF>,zoomLevel:Float){
    check(android.os.Looper.myLooper()==android.os.Looper.getMainLooper())
    events+="viewport ${view.width}x${view.height}; root=${logicalPage.intValue}; first=$firstVisiblePage; count=$visiblePagesCount"
   }
  }
  compose.activityRule.scenario.onActivity{view.addOnLayoutChangeListener(layout);view.addOnViewportChangedListener(viewport)}
  try{
   for(page in 2..5){nativeControl("下一页");waitPhysicalPage(page)}
   fun width():Int{var value=0;compose.activityRule.scenario.onActivity{value=view.width};return value}
   fun sameObjects(){val (f,v)=actualSurface();assertSame(fragment,f);assertSame(view,v);compose.activityRule.scenario.onActivity{assertSame(nativeDocument,view.pdfDocument);assertEquals(document.sha256,fragment.requireArguments().getString("sha"));assertEquals(5,logicalPage.intValue)}}
   fun resize(value:Float){
    val before=width();compose.runOnIdle{pages.clear();fraction.floatValue=value}
    compose.waitUntil(30000){var good=false;compose.activityRule.scenario.onActivity{good=view.width>0&&view.width!=before&&view.firstVisiblePage==4&&view.visiblePagesCount>0&&fragment.documentReady&&logicalPage.intValue==5};good}
    compose.waitForIdle();sameObjects()
    compose.activityRule.scenario.onActivity{assertTrue("Resize must not publish transient page changes: $pages; $events",pages.all{it==5})}
   }
   resize(1f);resize(.46f);resize(1f)
   // Geometry has settled: a real native scroll, independent of Compose page
   // input, must still update through the callback rather than remain pinned.
   compose.activityRule.scenario.onActivity{view.scrollToPage(5)}
   compose.waitUntil(30000){var good=false;compose.activityRule.scenario.onActivity{good=view.firstVisiblePage==5&&view.visiblePagesCount>0&&logicalPage.intValue==6};good}
   nativeControl("上一页");waitPhysicalPage(5);nativeControl("上一页");waitPhysicalPage(4)
   val (afterFragment,afterView)=actualSurface();assertSame(fragment,afterFragment);assertSame(view,afterView)
   compose.activityRule.scenario.onActivity{assertSame(nativeDocument,view.pdfDocument);assertEquals(4,logicalPage.intValue);assertTrue(events.any{it.startsWith("layout ")})}
   // A tall/narrow actual viewport clamps the final page at the document end.
   // It may expose preceding pages too, without making logical13 a false12.
   val jump=compose.onAllNodesWithContentDescription("跳转页码")
   if(jump.fetchSemanticsNodes().size==1)jump[0].performClick()else compose.onNodeWithText("4 / 13").performClick()
   compose.onNode(hasSetTextAction() and hasAnyAncestor(isDialog())).performTextReplacement("13")
   compose.onNode(hasText("跳转") and hasAnyAncestor(isDialog())).performClick()
   fun tailVisible():Boolean{var good=false;compose.activityRule.scenario.onActivity{val first=view.firstVisiblePage;val count=view.visiblePagesCount;good=fragment.documentReady&&logicalPage.intValue==13&&first>=0&&count>0&&12>=first&&12-first<count};return good}
   compose.waitUntil(30000){tailVisible()}
   val beforeTailWidth=width();compose.runOnIdle{pages.clear();fraction.floatValue=.22f}
   compose.waitUntil(30000){width()!=beforeTailWidth&&tailVisible()}
   compose.waitForIdle()
   compose.activityRule.scenario.onActivity{
    assertTrue("The actual native final-page position must exercise clamping: $events",view.firstVisiblePage<12)
    assertTrue("Clamped positioning must keep logical13: $pages; $events",pages.all{it==13})
    assertSame(nativeDocument,view.pdfDocument)
    // Real native scroll away from the clamped end must release the restore
    // gate. This would stay logical13 if restoration waited forever for first12.
    view.scrollTo(0,0)
   }
   compose.waitUntil(30000){var good=false;compose.activityRule.scenario.onActivity{good=view.firstVisiblePage==0&&view.visiblePagesCount>0&&logicalPage.intValue==1};good}
   val (tailFragment,tailView)=actualSurface();assertSame(fragment,tailFragment);assertSame(view,tailView)
   compose.activityRule.scenario.onActivity{assertSame(nativeDocument,view.pdfDocument)}
  }finally{
   compose.activityRule.scenario.onActivity{view.removeOnLayoutChangeListener(layout);view.removeOnViewportChangedListener(viewport)}
   androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().sendStatus(0,android.os.Bundle().apply{putString("pdfViewport102Trace",events.takeLast(100).joinToString("\n"))})
  }
 }

}
