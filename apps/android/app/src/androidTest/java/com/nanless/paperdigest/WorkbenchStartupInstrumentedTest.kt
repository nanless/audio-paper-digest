package com.nanless.paperdigest

import android.content.ContextWrapper
import android.os.Looper
import androidx.compose.material3.Text
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger

/** Actual startup UI and Root failure/retry, using private canonical fixtures and no real transport. */
class WorkbenchStartupInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private val secrets=object:SecretStore {
        override fun load(scope:String):String?=null
        override fun save(scope:String,secret:String)=error("No secrets in startup fixture")
        override fun remove(scope:String)=error("No secrets in startup fixture")
    }
    private fun stop(root:RootController?) {if(root!=null)(RootController::class.java.getDeclaredField("exportScope").also{it.isAccessible=true}.get(root)as CoroutineScope).cancel()}
    @Test fun initialFrameIsResponsiveWhileApplicationOwnedInitializationIsHeldOffMain() {
        val target=InstrumentationRegistry.getInstrumentation().targetContext
        val directory=Files.createTempDirectory(target.cacheDir.toPath(),"startup-held-").toFile().canonicalFile
        val context=object:ContextWrapper(target){override fun getNoBackupFilesDir()=directory}
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO);val release=CompletableDeferred<Unit>();val starts=AtomicInteger();var created:RootController?=null;var ranOnMain=true
        val startup=ControllerStartup(scope){ranOnMain=Looper.myLooper()==Looper.getMainLooper();starts.incrementAndGet();release.await();RootController(context,false,secrets).also{created=it}}
        try {
            compose.setContent {WorkbenchStartup(startup::await,{}){Text("受控工作台已打开")}}
            compose.onNodeWithText("正在打开已保存的工作台…").assertIsDisplayed()
            compose.waitUntil(10_000){starts.get()==1};assertFalse(ranOnMain)
            release.complete(Unit);compose.waitUntil(15_000){compose.onAllNodesWithText("受控工作台已打开").fetchSemanticsNodes().size==1}
            assertEquals(1,starts.get());compose.onNodeWithText("正在打开已保存的工作台…").assertDoesNotExist()
        }finally{scope.cancel();stop(created);directory.deleteRecursively()}
    }
    @Test fun corruptCatalogKeepsItsBytesAndShowsAnExplicitRetryBeforeNormalRecovery() {
        val target=InstrumentationRegistry.getInstrumentation().targetContext
        val directory=Files.createTempDirectory(target.cacheDir.toPath(),"startup-corrupt-").toFile().canonicalFile
        val context=object:ContextWrapper(target){override fun getNoBackupFilesDir()=directory}
        val research=RootResearchDirectory.resolve(directory);val personal=PersonalStore(research)
        val row=JSONObject().put("pageType","paper").put("title","Synthetic startup source").put("identityStatus","verified").put("sourceKind","arxiv").put("arxivId","2601.00001").put("permalink","posts/startup-fixture/")
        val repository=CatalogRepository(context,personal){url,_->if(url==CatalogRepository.SITE+"client/index.json")throw PublishedHttpStatus(404) else if(url==CatalogRepository.SITE+"index.json")JSONArray().put(row).toString().toByteArray()else error("Synthetic optional resource missing")}
        runBlocking{repository.sync()}
        val file=research.resolve("PublishedLibrary/current.json");val valid=file.readBytes();val corrupt="{\"format\":broken-synthetic-catalog".toByteArray();JsonFiles.write(file,corrupt)
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO);val starts=AtomicInteger();var created:RootController?=null
        val startup=ControllerStartup(scope){starts.incrementAndGet();RootController(context,false,secrets).also{created=it}}
        try {
            compose.setContent {WorkbenchStartup(startup::await,{}){Text("受控目录恢复成功")}}
            compose.waitUntil(15_000){compose.onAllNodesWithText("重试打开").fetchSemanticsNodes().size==1}
            compose.onNodeWithText("工作台暂时无法打开").assertIsDisplayed();assertEquals(1,starts.get());assertArrayEquals(corrupt,file.readBytes())
            compose.onNodeWithText("已保存的资料没有删除。可以重试，或稍后重新打开应用。").assertIsDisplayed()
            // Explicit test repair uses the original normal-sync bytes, not a fabricated success state.
            JsonFiles.write(file,valid);compose.onNodeWithText("重试打开").performClick()
            compose.waitUntil(15_000){compose.onAllNodesWithText("受控目录恢复成功").fetchSemanticsNodes().size==1}
            assertEquals(2,starts.get());assertEquals(1,created!!.state.value.catalogSummary.getInt("paperCount"));assertTrue(created!!.state.value.papers.any{it.id=="arxiv:2601.00001"})
        }finally{scope.cancel();stop(created);directory.deleteRecursively()}
    }
}
