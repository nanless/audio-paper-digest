package com.nanless.paperdigest.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Actual dialog/assets. This screen invokes no controller or credential action;
 * the target application's normal startup remains part of device execution. */
class OfflineLicensesInstrumentedTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private fun showAndClose(fontScale: Float) {
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                MaterialTheme {
                    var open by remember { mutableStateOf(false) }
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) { AboutContent { open = true } }
                    if (open) OfflineLicensesDialog { open = false }
                }
            }
        }
        compose.onNodeWithText("开源许可").performScrollTo().assertIsDisplayed().performClick()
        compose.waitForIdle() // Let the actual Compose Dialog draw before waiting on external native accessibility.
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val appeared=device.wait(Until.hasObject(By.textContains("开源软件与离线许可")),30000)
        if(!appeared){
            val instrument=InstrumentationRegistry.getInstrumentation();val qa=instrument.targetContext.getExternalFilesDir("qa")!!;val name="about16-failure-api${android.os.Build.VERSION.SDK_INT}-font$fontScale"
            device.takeScreenshot(java.io.File(qa,"$name.png"));device.dumpWindowHierarchy(java.io.File(qa,"$name.xml"))
            val rows=org.json.JSONArray()
            var dialogRoot:android.view.View?=null
            val rootFailure=runCatching{androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.isRoot()).inRoot(androidx.test.espresso.matcher.RootMatchers.isDialog()).check{view,error->if(error!=null)throw error;dialogRoot=view}}.exceptionOrNull()
            instrument.runOnMainSync{
                val activities=androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED)
                fun views(view:android.view.View):List<android.view.View> = listOf(view)+(if(view is android.view.ViewGroup)(0 until view.childCount).flatMap{views(view.getChildAt(it))}else emptyList())
                for(activity in activities){
                    val roots=mutableListOf<android.view.View>(activity.window.decorView)
                    // Dialog WebViews are separate public Window roots; ComposeView ancestors expose DialogWindowProvider.
                    dialogRoot?.let{roots.add(it)}
                    for(root in roots)for(web in views(root).filterIsInstance<android.webkit.WebView>()){val rect=android.graphics.Rect();val visible=web.getGlobalVisibleRect(rect);rows.put(org.json.JSONObject().put("url",web.url).put("title",web.title).put("progress",web.progress).put("contentHeight",web.contentHeight).put("width",web.width).put("height",web.height).put("visible",visible).put("rect",rect.toShortString()).put("javaScriptEnabled",web.settings.javaScriptEnabled).put("networkBlocked",web.settings.blockNetworkLoads))}
                }
            }
            // Semantics dump also includes the separate Dialog AndroidView node and errors, without probing private WebView internals.
            runCatching{java.io.File(qa,"$name-semantics.txt").writeText(compose.onRoot(useUnmergedTree=true).printToString())}
            java.io.File(qa,"$name.json").writeText(org.json.JSONObject().put("scope","Read-only own fixture window at original failure, no source/assertion change").put("webViewsInActivityRoot",rows).put("rootInspectionFailureClass",rootFailure?.javaClass?.name).toString(2))
        }
        assertTrue("Actual offline license index never appeared",appeared)
        compose.onNodeWithText("关闭").assertIsDisplayed().performClick()
        compose.onNodeWithText("开源许可").assertIsDisplayed()
    }
    @Test fun offlineDirectoryOpensAndClosesWithDefaultText() = showAndClose(1f)
    @Test fun aboutButtonAndDialogCloseRemainReachableWithDoubleText() = showAndClose(2f)
}
