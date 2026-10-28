package com.nanless.paperdigest.pdf

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.io.File

/** Debug-only, nonexported activity for real PDF UI tests; never reads a user-selected private file. */
class PdfHarnessActivity:FragmentActivity(){
 override fun onCreate(savedInstanceState:Bundle?){
  super.onCreate(savedInstanceState)
  enableEdgeToEdge()
  val fixture=JSONObject(assets.open("published/sample.json").bufferedReader().use{it.readText()}).getJSONObject("pdf")
  val temporary=File(cacheDir.canonicalFile,"public-pdf-harness.pdf")
  assets.open("published/"+fixture.getString("src")).use{input->temporary.outputStream().use{input.copyTo(it)}}
  val doc=runBlocking{PdfRepository(this@PdfHarnessActivity).importFile(temporary)}
  temporary.delete()
  setContent{MaterialTheme{Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)){var page by remember{mutableIntStateOf(1)};PdfReaderPane(doc,page,{page=it},{},onSaveAnnotation={selection,note->PdfRepository(this@PdfHarnessActivity).saveAnnotation(doc,selection,note);Unit})}}}
 }
}
