package com.nanless.paperdigest.pdf

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Encrypted originals use only public PDFBox APIs; one bounded bitmap, with original physical coordinates. */
@Composable internal fun PdfEncryptedPagePane(repository:PdfRepository,document:PdfDocumentRef,page:Int,marks:List<PdfAnnotation>,match:PdfSearchMatch?,zoom:Float,modifier:Modifier,onReady:(Boolean)->Unit,onFailure:(Throwable)->Unit) {
    var rendered by remember(document.sha256,page){mutableStateOf<PdfRenderedPage?>(null)}
    val ready by rememberUpdatedState(onReady)
    val fail by rememberUpdatedState(onFailure)
    LaunchedEffect(repository,document.sha256,page){
        ready(false)
        var acquired:PdfRenderedPage?=null
        try{ acquired=repository.renderPage(document,page);currentCoroutineContext().ensureActive();rendered=acquired;acquired=null;ready(true) }
        catch(error:Throwable){if(error is CancellationException)throw error;fail(error)}
        finally{acquired?.bitmap?.recycle()}
    }
    // Dropping the last Compose reference lets the bitmap retire after the rendering frame; never recycle an in-flight canvas.
    BoxWithConstraints(modifier){
        val value=rendered
        if(value==null)LinearProgressIndicator(Modifier.fillMaxWidth())
        else {
            val fit=minOf(maxWidth.value/value.widthPoints,maxHeight.value/value.heightPoints)
            val width=(value.widthPoints*fit*zoom).dp
            val height=(value.heightPoints*fit*zoom).dp
            Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState())){
                Canvas(Modifier.requiredSize(width,height).semantics{contentDescription="已解锁原文物理页 $page / ${document.pageCount}"}){
                    drawRect(Color.White)
                    drawImage(value.bitmap.asImageBitmap(),dstSize=IntSize(size.width.toInt().coerceAtLeast(1),size.height.toInt().coerceAtLeast(1)))
                    val xs=size.width/value.widthPoints;val ys=size.height/value.heightPoints
                    fun highlight(bounds:PdfSelectionBounds,color:Color){if(bounds.page==page)drawRect(color,androidx.compose.ui.geometry.Offset(bounds.left*xs,bounds.top*ys),androidx.compose.ui.geometry.Size((bounds.right-bounds.left)*xs,(bounds.bottom-bounds.top)*ys))}
                    marks.flatMap{it.selection.bounds}.forEach{highlight(it,Color(0x66FFD54F))}
                    match?.bounds?.forEach{highlight(it,Color(0x7770CFFF))}
                }
            }
        }
    }
}
