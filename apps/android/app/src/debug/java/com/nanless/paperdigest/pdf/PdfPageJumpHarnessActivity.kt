package com.nanless.paperdigest.pdf

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/** Debug-only public original and a synthetic alternate owner; no model/network/credentials. */
class PdfPageJumpHarnessActivity:FragmentActivity(){
 lateinit var first:PdfDocumentRef;lateinit var second:PdfDocumentRef
 var current by mutableStateOf<PdfDocumentRef?>(null)
 var page by mutableIntStateOf(1)
 var compact by mutableStateOf(false)
 val navigation=CopyOnWriteArrayList<Pair<String,Int>>()
 override fun onCreate(savedInstanceState:Bundle?){
  super.onCreate(savedInstanceState);enableEdgeToEdge()
  val repo=PdfRepository(this)
  runBlocking{
   val fixture=JSONObject(assets.open("published/sample.json").bufferedReader().use{it.readText()}).getJSONObject("pdf")
   val a=File(cacheDir,"page-jump-public.pdf");assets.open("published/"+fixture.getString("src")).use{input->a.outputStream().use{input.copyTo(it)}}
   first=repo.importFile(a,"公开13页原文");a.delete()
   val b=File(cacheDir,"page-jump-synthetic.pdf");com.tom_roush.pdfbox.pdmodel.PDDocument().use{pdf->pdf.addPage(com.tom_roush.pdfbox.pdmodel.PDPage());pdf.save(b)}
   second=repo.importFile(b,"单页合成替换原文");b.delete();current=first
  }
  setContent{MaterialTheme{Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)){
   val doc=current!!
   PdfReaderPane(doc,page,{navigation+=doc.sha256 to it;page=it},{},if(compact)Modifier.fillMaxWidth().height(280.dp)else Modifier.fillMaxSize(),onSaveAnnotation={_,_->error("This fixture cannot save annotations")})
  }}}
 }
}
