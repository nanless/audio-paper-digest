package com.nanless.paperdigest

import android.app.Application
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.ui.platform.createLifecycleAwareWindowRecomposer
import androidx.fragment.app.FragmentActivity
import com.nanless.paperdigest.ui.PaperDigestApp
import com.nanless.paperdigest.ui.AppMotionDurationScale

class PaperDigestApplication: Application() {
    lateinit var controller: RootController
        private set
    override fun onCreate() {
        super.onCreate()
        // Jetpack PDF uses an isolated service process with no right to app-private user data.
        if (android.os.Process.myUid() == applicationInfo.uid && getProcessName() == packageName) controller = RootController(this)
    }
}

class MainActivity: FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val controller = (application as PaperDigestApplication).controller
        val scale = AppMotionDurationScale(this, controller)
        val recomposer = window.decorView.createLifecycleAwareWindowRecomposer(coroutineContext = scale, lifecycle = lifecycle)
        setContent(parent = recomposer) { PaperDigestApp(controller) }
    }
}
