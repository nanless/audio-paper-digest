package com.nanless.paperdigest.review

import android.content.ContentProvider
import android.content.ContentValues
import android.content.ContextWrapper
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.provider.ProviderTestRule
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.pdf.*
import com.nanless.paperdigest.ui.PdfUnlockPrompt
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.*
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Actual private Root/provider/opaque-session/password pipeline, with synthetic originals and no API credentials. */
@RunWith(AndroidJUnit4::class)
class RootEncryptedPdfInstrumentedTest {
 @get:Rule val provider=ProviderTestRule.Builder(Source::class.java,AUTHORITY).build()
 class Source:ContentProvider() {
  override fun onCreate()=true
  override fun openFile(uri:Uri,mode:String):ParcelFileDescriptor {
   if(mode!="r")throw FileNotFoundException("Read-only synthetic original")
   return ParcelFileDescriptor.open(files[uri.lastPathSegment]?:throw FileNotFoundException("Unknown synthetic original"),ParcelFileDescriptor.MODE_READ_ONLY)
  }
  override fun getType(uri:Uri)="application/pdf"
  override fun query(uri:Uri,projection:Array<out String>?,selection:String?,args:Array<out String>?,sort:String?):Cursor?=null
  override fun insert(uri:Uri,values:ContentValues?):Uri?=null
  override fun delete(uri:Uri,selection:String?,args:Array<out String>?)=0
  override fun update(uri:Uri,values:ContentValues?,selection:String?,args:Array<out String>?)=0
 }
 private inner class Fixture {
  val target=InstrumentationRegistry.getInstrumentation().targetContext
  val directory=File(target.cacheDir,"RootEncrypted-${UUID.randomUUID()}").canonicalFile.also{it.mkdirs()}
  val context=object:ContextWrapper(target){override fun getNoBackupFilesDir()=directory;override fun getContentResolver()=provider.resolver}
  val root:RootController
  val own=mutableListOf<String>()
  init {PDFBoxResourceLoader.init(target.applicationContext);PersonalStore(File(directory,"PaperDigest")).updateSettings(JSONObject().put("offlineMode",true));root=RootController(context,installBackground=false)}
  suspend fun loaded(){withTimeout(10000){while(root.state.value.pendingExportsLoading)delay(5)}}
  fun source(encrypted:Boolean):Pair<Uri,File> {
   val id=UUID.randomUUID().toString();val source=File(directory,"synthetic-$id.pdf")
   PDDocument().use{pdf->pdf.addPage(PDPage());if(encrypted)pdf.protect(StandardProtectionPolicy("synthetic-owner","synthetic-reader",AccessPermission().apply{setCanPrint(true);setCanExtractContent(true)}).apply{encryptionKeyLength=128});pdf.save(source)}
   files[id]=source;own+=id;return Uri.parse("content://$AUTHORITY/$id") to source
  }
  suspend fun prompt(after:String?=null):PdfUnlockPrompt {
   withTimeout(10000){while(root.state.value.pdfUnlockPrompt?.let{it.requestID!=after&&!it.checking}!=true)delay(5)}
   return root.state.value.pdfUnlockPrompt!!
  }
  fun assertNoSecret(){val saved=root.personal.snapshot().toString();for(word in listOf("synthetic-reader","synthetic-wrong","synthetic-owner")){assertFalse(saved.contains(word));assertFalse(root.state.value.toString().contains(word))};assertEquals(0,root.personal.snapshot().getJSONArray("sessions").length())}
  suspend fun close(){val scope=field<CoroutineScope>(root,"exportScope");scope.cancel();scope.coroutineContext[Job]?.join();field<PdfRepository>(root,"pdf").clearSessionPasswords();own.forEach(files::remove);directory.deleteRecursively()}
 }
 @Test fun encryptedImportRejectsWrongAndStaleAnswersThenAcceptsExactCiphertext()=runBlocking {
  val f=Fixture();try {f.loaded();val (uri,source)=f.source(true);val sha=BackupCodec.hash(source)
   val caller=async{runCatching{f.root.execute("pdf.import",JSONObject().put("uri",uri.toString()))}}
   val first=f.prompt();assertTrue(f.root.personal.personalPapers().isEmpty());assertTrue(f.root.state.value.busy)
   val wrong="synthetic-wrong".toCharArray();f.root.unlockPdf(first.requestID,wrong);assertTrue(wrong.all{it=='\u0000'})
   val retry=f.prompt(first.requestID);assertTrue(retry.message.orEmpty().contains("不正确"));assertTrue(f.root.personal.personalPapers().isEmpty())
   val late="synthetic-reader".toCharArray();assertTrue(runCatching{f.root.unlockPdf(first.requestID,late)}.isFailure);assertTrue(late.all{it=='\u0000'})
   val correct="synthetic-reader".toCharArray();f.root.unlockPdf(retry.requestID,correct);assertTrue(correct.all{it=='\u0000'})
   val result=withTimeout(10000){caller.await().getOrThrow()};assertEquals("local:$sha",result.getString("paperID"));assertNull(f.root.state.value.pdfUnlockPrompt)
   val doc=f.root.state.value.pdfDocument!!;assertEquals(sha,doc.sha256);assertEquals(sha,BackupCodec.hash(File(doc.localPath)));assertEquals(sha,BackupCodec.hash(source));f.assertNoSecret()
  }finally{f.close()}
 }
 @Test fun explicitPasswordCancellationDrainsOriginalJobAndAllowsNextOrdinaryImport()=runBlocking {
  val f=Fixture();try{f.loaded();val(uri,source)=f.source(true);val sha=BackupCodec.hash(source)
   val caller=async{runCatching{f.root.execute("pdf.import",JSONObject().put("uri",uri.toString()))}};val request=f.prompt()
   f.root.cancelPdfUnlock(request.requestID);assertTrue(caller.await().isFailure);assertNull(f.root.state.value.pdfUnlockPrompt);assertFalse(f.root.state.value.busy);assertTrue(f.root.personal.personalPapers().isEmpty());assertEquals(sha,BackupCodec.hash(source))
   val(normal,plain)=f.source(false);val opened=f.root.execute("pdf.import",JSONObject().put("uri",normal.toString()));assertEquals("local:${BackupCodec.hash(plain)}",opened.getString("paperID"));f.assertNoSecret()
  }finally{f.close()}
 }
 @Test fun cancellingUiAwaitDoesNotCancelTheRootOwnedPasswordTask()=runBlocking {
  val f=Fixture();try{f.loaded();val(uri,source)=f.source(true)
   val caller=async{f.root.execute("pdf.import",JSONObject().put("uri",uri.toString()))};val request=f.prompt();caller.cancelAndJoin()
   assertEquals(request.requestID,f.root.state.value.pdfUnlockPrompt?.requestID);assertTrue(f.root.state.value.busy);assertTrue(f.root.state.value.notice.orEmpty().contains("仍在应用内"));assertFalse(f.root.state.value.error.orEmpty().contains("已取消"))
   f.root.unlockPdf(request.requestID,"synthetic-reader".toCharArray())
   withTimeout(10000){while(f.root.state.value.jobs.none{it.optString("kind")=="pdf.import"&&it.optString("status")=="completed"})delay(5)}
   assertEquals(BackupCodec.hash(source),f.root.state.value.pdfDocument!!.sha256);assertNull(f.root.state.value.pdfUnlockPrompt);f.assertNoSecret()
  }finally{f.close()}
 }
 @Test fun realSourceSwitchRevokesWaitingRequestAndNeverRegistersItsCiphertextAsNewOwner()=runBlocking {
  val f=Fixture();try{f.loaded();val(plainUri,plain)=f.source(false);val original=f.root.execute("pdf.import",JSONObject().put("uri",plainUri.toString()));val owner=original.getString("paperID")
   val(lockedUri,locked)=f.source(true);val lockedSHA=BackupCodec.hash(locked)
   val caller=async{runCatching{f.root.execute("pdf.import",JSONObject().put("uri",lockedUri.toString()))}};val request=f.prompt()
   f.root.execute("paper.open",JSONObject().put("paperID",owner));assertTrue(caller.await().isFailure);assertEquals(owner,f.root.state.value.selectedPaperId);assertNull(f.root.state.value.pdfUnlockPrompt)
   val stale="synthetic-reader".toCharArray();assertTrue(runCatching{f.root.unlockPdf(request.requestID,stale)}.isFailure);assertTrue(stale.all{it=='\u0000'})
   assertFalse(f.root.personal.personalPapers().any{it.id=="local:$lockedSHA"});assertEquals(lockedSHA,BackupCodec.hash(locked));assertEquals(owner,"local:${BackupCodec.hash(plain)}");f.assertNoSecret()
  }finally{f.close()}
 }
 @Test fun explicitForgetAndReopenUsesRealFilePasswordPromptWithoutReplacingOriginal()=runBlocking {
  val f=Fixture();try{f.loaded();val(uri,source)=f.source(true);val sourceSHA=BackupCodec.hash(source)
   val initial=async{f.root.execute("pdf.import",JSONObject().put("uri",uri.toString()))};f.root.unlockPdf(f.prompt().requestID,"synthetic-reader".toCharArray());val first=initial.await()
   val managed=f.root.state.value.pdfDocument!!.localPath
   f.root.execute("pdf.close",JSONObject());field<PdfRepository>(f.root,"pdf").clearSessionPasswords()
   val reopening=async{f.root.execute("pdf.open",JSONObject())};val request=f.prompt();assertEquals("open",request.purpose);assertEquals(first.getString("paperID"),f.root.state.value.selectedPaperId)
   f.root.unlockPdf(request.requestID,"synthetic-reader".toCharArray());reopening.await()
   assertEquals(managed,f.root.state.value.pdfDocument!!.localPath);assertEquals(sourceSHA,BackupCodec.hash(File(managed)));assertEquals(sourceSHA,BackupCodec.hash(source));assertEquals(1,f.root.personal.personalPapers().size);f.assertNoSecret()
  }finally{f.close()}
 }
 @Test fun callerCannotPassAPasswordThroughGeneralCommandJson()=runBlocking {
  val f=Fixture();try{f.loaded();val input="synthetic-reader";assertTrue(runCatching{f.root.execute("pdf.unlock",JSONObject().put("requestID","not-native").put("password",input))}.isFailure)
   assertNull(f.root.state.value.pdfUnlockPrompt);assertTrue(f.root.personal.personalPapers().isEmpty());f.assertNoSecret()
  }finally{f.close()}
 }
 companion object {
  private const val AUTHORITY="com.nanless.paperdigest.test.encrypted-source"
  private val files=ConcurrentHashMap<String,File>()
  @Suppress("UNCHECKED_CAST")private fun<T>field(value:Any,name:String):T=value.javaClass.getDeclaredField(name).also{it.isAccessible=true}.get(value) as T
 }
}
