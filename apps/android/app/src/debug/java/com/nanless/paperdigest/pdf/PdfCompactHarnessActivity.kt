package com.nanless.paperdigest.pdf

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.io.File

/** Debug-only measured320dp square +200%Compose font fixture, real public13-page original, no user file/key/LLM. */
class PdfCompactHarnessActivity:FragmentActivity(){
 override fun onCreate(savedInstanceState:Bundle?){
  super.onCreate(savedInstanceState);enableEdgeToEdge()
  val fixture=JSONObject(assets.open("published/sample.json").bufferedReader().use{it.readText()}).getJSONObject("pdf")
  val temporary=File(cacheDir,"public-pdf-compact-fixture.pdf")
  assets.open("published/"+fixture.getString("src")).use{input->temporary.outputStream().use{input.copyTo(it)}}
  val doc=runBlocking{PdfRepository(this@PdfCompactHarnessActivity).importFile(temporary)};temporary.delete()
  setContent{MaterialTheme{
   val density=LocalDensity.current.density
   Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)){
    CompositionLocalProvider(LocalDensity provides Density(density,2f)){
     var page by remember{mutableIntStateOf(1)}
     PdfReaderPane(doc,page,{page=it},{},Modifier.width(320.dp).height(320.dp),onSaveAnnotation={_,_->error("This fixture does not persist annotations")})
    }
   }
  }}
 }
}
