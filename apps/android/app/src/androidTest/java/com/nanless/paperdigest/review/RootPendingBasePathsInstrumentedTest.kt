package com.nanless.paperdigest.review

import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Root path wiring only, private temporary aliases. Actual Android app-path acceptance is a separate platform test. */
@RunWith(AndroidJUnit4::class)
class RootPendingBasePathsInstrumentedTest {
 private class Fixture(aliasBase:Boolean=false,internalLink:Boolean=false) {
  val target=InstrumentationRegistry.getInstrumentation().targetContext
  val directory=File(target.cacheDir,"PendingBase-${UUID.randomUUID()}").canonicalFile.also{it.mkdirs()}
  private val alias=File(directory.parentFile,"PendingBaseAlias-${UUID.randomUUID()}")
  private val internal=File(directory,"PaperDigestTransfers/PendingExports")
  val outside=File(directory,"owned-outside-target").also{it.mkdirs()}
  val sentinel=File(outside,"unknown-original.bin").also{it.writeBytes(byteArrayOf(0,1,2,-1))}
  val sentinelSHA=BackupCodec.hash(sentinel)
  val context=object:ContextWrapper(target){override fun getNoBackupFilesDir()=if(aliasBase)alias else directory}
  val root:RootController
  init {
   if(aliasBase)Files.createSymbolicLink(alias.toPath(),directory.toPath())
   if(internalLink){internal.parentFile!!.mkdirs();Files.createSymbolicLink(internal.toPath(),outside.toPath())}
   PersonalStore(File(directory,"PaperDigest")).updateSettings(JSONObject().put("offlineMode",true))
   root=RootController(context,installBackground=false)
  }
  suspend fun loaded(){withTimeout(10000){while(root.state.value.pendingExportsLoading)delay(5)}}
  suspend fun close(){val scope=field<CoroutineScope>(root,"exportScope");scope.cancel();scope.coroutineContext[Job]?.join();if(Files.isSymbolicLink(internal.toPath()))Files.delete(internal.toPath());if(Files.isSymbolicLink(alias.toPath()))Files.delete(alias.toPath());directory.deleteRecursively()}
 }
 @Test fun legitimateApplicationBaseAliasPreparesOriginalWithoutWeakeningControlPaths()=runBlocking {
  val f=Fixture(aliasBase=true);try{f.loaded();assertNull(f.root.state.value.pendingExportsError)
   val result=f.root.execute("export.prepare",JSONObject().put("format","diagnostics"))
   assertTrue(result.getBoolean("ready"));assertEquals("ready",result.getString("preparation"));assertTrue(result.getString("documentID").isNotBlank())
   assertEquals(1,f.root.state.value.pendingExports.size);assertEquals(0,f.root.personal.snapshot().getJSONArray("sessions").length());assertEquals(f.sentinelSHA,BackupCodec.hash(f.sentinel))
  }finally{f.close()}
 }
 @Test fun internalPendingDirectoryLinkRemainsAnErrorAndCannotRedirectExportWrites()=runBlocking {
  val f=Fixture(internalLink=true);try{f.loaded();assertFalse(f.root.state.value.pendingExportsError.isNullOrBlank())
   assertTrue(f.root.execute("app.bootstrap",JSONObject()).getBoolean("ready"))
   assertTrue(runCatching{f.root.execute("export.prepare",JSONObject().put("format","diagnostics"))}.isFailure)
   assertTrue(f.root.state.value.pendingExports.isEmpty());assertFalse(f.root.state.value.pendingExportsError.isNullOrBlank())
   assertEquals(listOf("unknown-original.bin"),f.outside.listFiles()!!.map{it.name});assertEquals(f.sentinelSHA,BackupCodec.hash(f.sentinel));assertEquals(0,f.root.personal.snapshot().getJSONArray("sessions").length())
  }finally{f.close()}
 }
 companion object {@Suppress("UNCHECKED_CAST")private fun<T>field(value:Any,name:String):T=value.javaClass.getDeclaredField(name).also{it.isAccessible=true}.get(value)as T}
}
