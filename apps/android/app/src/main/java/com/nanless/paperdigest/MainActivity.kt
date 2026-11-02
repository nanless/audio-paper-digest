package com.nanless.paperdigest

import android.app.Application
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.ui.platform.createLifecycleAwareWindowRecomposer
import androidx.compose.ui.MotionDurationScale
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.nanless.paperdigest.ui.PaperDigestApp
import com.nanless.paperdigest.ui.AppMotionDurationScale
import kotlinx.coroutines.*

class PaperDigestApplication: Application() {
    @Volatile lateinit var controller: RootController
        private set
    private val initializationScope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
    private val controllerStartup by lazy { ControllerStartup(initializationScope) {
        if(::controller.isInitialized)controller else {
            val created=RootController(this)
            synchronized(this){if(::controller.isInitialized)controller else created.also{controller=it}}
        }
    } }
    suspend fun awaitController(retry:Boolean=false):RootController {
        require(android.os.Process.myUid()==applicationInfo.uid&&getProcessName()==packageName)
        return if(::controller.isInitialized)controller else controllerStartup.await(retry)
    }
    override fun onCreate() {
        super.onCreate()
        // Jetpack PDF uses an isolated service process with no right to app-private user data.
        if (android.os.Process.myUid() == applicationInfo.uid && getProcessName() == packageName) controllerStartup.start()
    }
}

class MainActivity: FragmentActivity() {
    private var readyController:RootController?=null
    override fun onStart(){super.onStart();readyController?.foregroundStarted(this)}
    override fun onStop(){readyController?.foregroundStopped(this);super.onStop()}
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app=application as PaperDigestApplication
        var readyScale:AppMotionDurationScale?=null
        val scale=object:MotionDurationScale {
            override val scaleFactor:Float get()=readyScale?.scaleFactor?:runCatching{
                android.provider.Settings.Global.getFloat(contentResolver,android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,1f)
                    .takeIf{it.isFinite()&&it>=0f}?:1f
            }.getOrDefault(1f)
        }
        val recomposer = window.decorView.createLifecycleAwareWindowRecomposer(coroutineContext = scale, lifecycle = lifecycle)
        setContent(parent = recomposer) {
            WorkbenchStartup(app::awaitController,onReady={controller->
                readyController=controller;readyScale=AppMotionDurationScale(this,controller)
                if(lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED))controller.foregroundStarted(this)
            }){controller->PaperDigestApp(controller)}
        }
    }
}

@Composable internal fun WorkbenchStartup(awaitController: suspend (Boolean) -> RootController,onReady:(RootController)->Unit,content: @Composable (RootController) -> Unit) {
    var attempt by remember{mutableIntStateOf(0)}
    var controller by remember{mutableStateOf<RootController?>(null)}
    var failed by remember{mutableStateOf(false)}
    LaunchedEffect(attempt){
        failed=false
        try {val ready=awaitController(attempt>0);onReady(ready);controller=ready}
        catch(cancelled:CancellationException){throw cancelled}
        catch(_:Exception){failed=true}
    }
    val ready=controller
    if(ready!=null)content(ready)
    else MaterialTheme{Surface(Modifier.fillMaxSize()){
        Column(Modifier.fillMaxSize().padding(28.dp),verticalArrangement=Arrangement.Center,horizontalAlignment=Alignment.CenterHorizontally){
            if(failed){
                Text("工作台暂时无法打开",style=MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(12.dp));Text("已保存的资料没有删除。可以重试，或稍后重新打开应用。")
                Spacer(Modifier.height(20.dp));Button({attempt++}){Text("重试打开")}
            }else{CircularProgressIndicator();Spacer(Modifier.height(20.dp));Text("正在打开已保存的工作台…")}
        }
    }}
}
