package com.nanless.paperdigest.pdf

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/** Only synthetic/public fixtures; demonstrates a deliberately uncooperative old search returning after a new original is visible. */
class PdfSwitchHarnessActivity:FragmentActivity(){
 val started=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();val returned=CompletableDeferred<Unit>()
 val navigation=CopyOnWriteArrayList<Pair<String,Int>>()
 lateinit var first:PdfDocumentRef;lateinit var second:PdfDocumentRef
 var current by mutableStateOf<PdfDocumentRef?>(null)
 override fun onCreate(savedInstanceState:Bundle?){
  super.onCreate(savedInstanceState)
  enableEdgeToEdge()
  val repo=PdfRepository(this)
  runBlocking {
   val meta=JSONObject(assets.open("published/sample.json").bufferedReader().use{it.readText()}).getJSONObject("pdf")
   val a=File(cacheDir,"switch-public.pdf");assets.open("published/"+meta.getString("src")).use{input->a.outputStream().use{input.copyTo(it)}}
   first=repo.importFile(a,"A 已封存公开原件");a.delete()
   val b=File(cacheDir,"switch-synthetic.pdf")
   com.tom_roush.pdfbox.pdmodel.PDDocument().use{pdf->pdf.addPage(com.tom_roush.pdfbox.pdmodel.PDPage());pdf.save(b)}
   second=repo.importFile(b,"B 单页合成原件");b.delete();current=first
  }
  setContent {MaterialTheme{Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)){
   val document=current!!
   Text(document.displayName)
   Button({current=second}){Text("切换原件")}
   CompositionLocalProvider(LocalPdfSearchOverride provides {d,q->
    withContext(NonCancellable){val result=repo.search(d,q).filter{it.page>1};check(result.isNotEmpty());started.complete(Unit);release.await();returned.complete(Unit);result}
   }){PdfReaderPane(document,1,{navigation+=current!!.sha256 to it},{},Modifier.weight(1f),onSaveAnnotation={_,_->})}
  }}}
 }
 override fun onDestroy(){release.complete(Unit);super.onDestroy()}
}
