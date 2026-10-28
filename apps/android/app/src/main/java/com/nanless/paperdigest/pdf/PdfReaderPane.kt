package com.nanless.paperdigest.pdf

import android.graphics.RectF
import android.net.Uri
import android.os.Bundle
import android.util.SparseArray
import android.view.View
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.core.os.bundleOf
import androidx.fragment.compose.AndroidFragment
import androidx.lifecycle.lifecycleScope
import androidx.pdf.ExperimentalPdfApi
import androidx.pdf.Highlight
import androidx.pdf.PdfDocument
import androidx.pdf.PdfRect
import androidx.pdf.selection.Selection
import androidx.pdf.selection.model.TextSelection
import androidx.pdf.view.PdfView
import androidx.pdf.viewer.fragment.PdfViewerFragment
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.io.File

/** Optional deterministic search transport for isolated component acceptance; production always uses the verified repository. */
internal val LocalPdfSearchOverride = staticCompositionLocalOf<(suspend (PdfDocumentRef,String)->List<PdfSearchMatch>)?> { null }

@OptIn(ExperimentalPdfApi::class, ExperimentalLayoutApi::class)
@Composable
fun PdfReaderPane(document: PdfDocumentRef, page: Int, onPageChanged: (Int)->Unit,
                  onSelection: (PdfSelection)->Unit, modifier: Modifier=Modifier, onError: (String)->Unit={}, onSaveAnnotation: suspend (PdfSelection,String)->Unit, annotationRevision:String="", portableAnnotations:List<org.json.JSONObject> = emptyList(), repository:PdfRepository?=null) {
    key(document.id,document.sha256,document.localPath) {
    val context=LocalContext.current
    val focus=LocalFocusManager.current
    val keyboard=LocalSoftwareKeyboardController.current
    val repo=remember(context,repository){repository?:PdfRepository(context)}
    val searchOverride=LocalPdfSearchOverride.current
    val scope=rememberCoroutineScope()
    val activeDocument=remember{java.util.concurrent.atomic.AtomicBoolean(true)}
    DisposableEffect(Unit){onDispose{activeDocument.set(false)}}
    var access by remember(document.sha256){mutableStateOf<PdfDocumentAccess?>(null)}
    var encryptedReady by remember(document.sha256,page){mutableStateOf(false)}
    var compatibilityZoom by remember(document.sha256){mutableFloatStateOf(1f)}
    var native by remember(document.sha256){mutableStateOf<DigestPdfFragment?>(null)}
    var pageInput by remember(document.sha256){mutableStateOf(page.toString())}
    var failure by remember(document.sha256){mutableStateOf<String?>(null)}
    var selection by remember(document.sha256){mutableStateOf<PdfSelection?>(null)}
    var textPage by remember(document.sha256){mutableStateOf<PdfPageText?>(null)}
    var textValue by remember(document.sha256){mutableStateOf(TextFieldValue())}
    var annotationNote by remember(document.sha256){mutableStateOf<String?>(null)}
    var marks by remember(document.sha256){mutableStateOf<List<PdfAnnotation>>(emptyList())}
    var compatibilitySearch by remember(document.sha256){mutableStateOf(false)}
    var searchQuery by remember(document.sha256){mutableStateOf("")}
    var searchResults by remember(document.sha256){mutableStateOf<List<PdfSearchMatch>>(emptyList())}
    var searchIndex by remember(document.sha256){mutableIntStateOf(-1)}
    var searching by remember(document.sha256){mutableStateOf(false)}
    val selectedCallback by rememberUpdatedState(onSelection)
    val pageCallback by rememberUpdatedState(onPageChanged)
    fun finishTextEntry(){focus.clearFocus();keyboard?.hide()}
    fun navigate(target:Int){if(!activeDocument.get())return;finishTextEntry();pageCallback(target)}
    fun showResult(index:Int){if(index in searchResults.indices){searchIndex=index;val match=searchResults[index];native?.showCompatibilityMatch(match);pageCallback(match.page)}}
    val errorCallback by rememberUpdatedState(onError)
    val saveAnnotationCallback by rememberUpdatedState(onSaveAnnotation)
    val documentReady=encryptedReady || native?.documentReady==true
    fun zoom(){if(access?.encrypted==true)compatibilityZoom=(compatibilityZoom*1.15f).coerceAtMost(4f)else native?.zoomBy(1.15f)}
    fun fail(e:Throwable){if(e is CancellationException)throw e;if(!scope.isActive)return;failure=e.message ?: "PDF 操作未完成";errorCallback(failure!!)}
    LaunchedEffect(document.sha256){try{access=repo.access(document)}catch(e:Throwable){fail(e)}}
    LaunchedEffect(document.sha256,annotationRevision){try{repo.verify(document);marks=repo.projectPortableAnnotations(document,portableAnnotations)}catch(e:Throwable){fail(e)}}
    BoxWithConstraints(modifier){
        val compactControls=maxHeight<480.dp||maxWidth<360.dp||LocalDensity.current.fontScale>=1.5f
        var toolsOpen by remember{mutableStateOf(false)}
        var jumpOpen by remember{mutableStateOf(false)}
        var jumpError by remember{mutableStateOf<String?>(null)}
        var showFailure by remember{mutableStateOf(false)}
        fun closeSearch(){if(!searching){compatibilitySearch=false;searchResults=emptyList();searchIndex=-1;native?.clearCompatibilitySearch()}}
        val searchControls: @Composable() (Boolean) -> Unit = { showClose ->
            OutlinedTextField(searchQuery,{searchQuery=it.take(1000);searchResults=emptyList();searchIndex=-1;native?.clearCompatibilitySearch()},Modifier.fillMaxWidth().padding(horizontal=8.dp),singleLine=true,label={Text("查找 PDF 原文")})
            FlowRow(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(2.dp)){
                TextButton(onClick={finishTextEntry();val query=searchQuery;searching=true;scope.launch{try{val result=searchOverride?.invoke(document,query) ?: repo.search(document,query);currentCoroutineContext().ensureActive();if(searchQuery==query){searchResults=result;searchIndex=-1;if(result.isNotEmpty())showResult(0);failure=null}}catch(e:Throwable){fail(e)}finally{searching=false}}},enabled=searchQuery.isNotBlank()&&!searching){Text(if(searching)"查找中…" else "查找原文")}
                TextButton(onClick={showResult((searchIndex-1+searchResults.size)%searchResults.size)},enabled=searchResults.isNotEmpty()&&!searching){Text("上一个结果")}
                TextButton(onClick={showResult((searchIndex+1)%searchResults.size)},enabled=searchResults.isNotEmpty()&&!searching){Text("下一个结果")}
                if(showClose)TextButton(onClick={compatibilitySearch=false;searchResults=emptyList();searchIndex=-1;native?.clearCompatibilitySearch()},enabled=!searching){Text("关闭查找")}
            }
            Text(if(searching)"正在读取原件文字" else if(searchIndex>=0)"原文匹配 ${searchIndex+1} / ${searchResults.size} · 物理页 ${searchResults[searchIndex].page}" else "原文匹配 0 / ${searchResults.size}",Modifier.padding(horizontal=12.dp),style=MaterialTheme.typography.labelSmall)
        }
        Column(Modifier.fillMaxSize()){
        if(compactControls){
            Row(Modifier.fillMaxWidth().heightIn(min=48.dp),verticalAlignment=androidx.compose.ui.Alignment.CenterVertically){
                IconButton(onClick={navigate((page-1).coerceAtLeast(1))},enabled=page>1){Icon(Icons.AutoMirrored.Outlined.ArrowBack,contentDescription="上一页")}
                TextButton(onClick={pageInput=page.toString();jumpError=null;jumpOpen=true},modifier=Modifier.weight(1f)){Text("$page / ${document.pageCount}",maxLines=1,overflow=TextOverflow.Ellipsis)}
                IconButton(onClick={navigate((page+1).coerceAtMost(document.pageCount))},enabled=page<document.pageCount){Icon(Icons.AutoMirrored.Outlined.ArrowForward,contentDescription="下一页")}
                Box{
                    IconButton(onClick={toolsOpen=true}){Icon(Icons.Outlined.MoreVert,contentDescription="原文工具")}
                    DropdownMenu(expanded=toolsOpen,onDismissRequest={toolsOpen=false}){
                        DropdownMenuItem(text={Text("跳转页码")},onClick={toolsOpen=false;pageInput=page.toString();jumpError=null;jumpOpen=true})
                        DropdownMenuItem(text={Text("查找")},enabled=documentReady,onClick={toolsOpen=false;compatibilitySearch=true})
                        DropdownMenuItem(text={Text("选取本页文字")},onClick={toolsOpen=false;scope.launch{try{val p=repo.readPages(document,page,page).single();textPage=p;textValue=TextFieldValue(p.text)}catch(e:Throwable){fail(e)}}})
                        DropdownMenuItem(text={Text("保存标注")},enabled=selection!=null,onClick={toolsOpen=false;annotationNote=""})
                        DropdownMenuItem(text={Text("放大")},enabled=documentReady,onClick={toolsOpen=false;zoom()})
                    }
                }
            }
        }else{
        FlowRow(Modifier.fillMaxWidth().padding(horizontal=4.dp),horizontalArrangement=Arrangement.spacedBy(2.dp)){
            TextButton(onClick={navigate((page-1).coerceAtLeast(1))},enabled=page>1){Text("上一页")}
            TextButton(onClick={pageInput=page.toString();jumpError=null;jumpOpen=true},modifier=Modifier.semantics{contentDescription="跳转页码"}){Text("$page / ${document.pageCount}")}
            TextButton(onClick={navigate((page+1).coerceAtMost(document.pageCount))},enabled=page<document.pageCount){Text("下一页")}
            TextButton(onClick={if(access?.encrypted==true || searchOverride!=null || native?.search()!=true)compatibilitySearch=true},enabled=documentReady){Text("查找")}
        }
        FlowRow(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
            TextButton(onClick={scope.launch{try{val p=repo.readPages(document,page,page).single();textPage=p;textValue=TextFieldValue(p.text)}catch(e:Throwable){fail(e)}}}){Text("选取本页文字")}
            TextButton(onClick={annotationNote=""},enabled=selection!=null){Text("保存标注")}
            TextButton(onClick={zoom()},enabled=documentReady){Text("放大")}
        }
        }
        if(compatibilitySearch&&!compactControls)searchControls(true)
        failure?.let{if(compactControls)TextButton(onClick={showFailure=true}){Text("原文操作提示：查看详情",maxLines=1,overflow=TextOverflow.Ellipsis)}else Text(it,color=MaterialTheme.colorScheme.error,modifier=Modifier.padding(8.dp))}
        Text((if(documentReady) "原文已载入 · " else "原文载入中 · ")+"物理页 $page / ${document.pageCount}",style=MaterialTheme.typography.labelSmall,modifier=Modifier.padding(horizontal=12.dp))
        when {
        access==null -> Box(Modifier.weight(1f).fillMaxWidth()){if(failure==null)LinearProgressIndicator(Modifier.fillMaxWidth())}
        access?.encrypted==true -> PdfEncryptedPagePane(repo,document,page,marks,searchResults.getOrNull(searchIndex),compatibilityZoom,Modifier.weight(1f).fillMaxWidth(),{encryptedReady=it},::fail)
        else -> key(document.sha256){
            AndroidFragment<DigestPdfFragment>(modifier=Modifier.weight(1f).fillMaxWidth(),arguments=bundleOf("id" to document.id,"file" to document.localPath,"sha" to document.sha256,"count" to document.pageCount,"name" to document.displayName),onUpdate={fragment->native=fragment})
            // AndroidFragment.onUpdate runs when its fragment is made available,
            // not on page/annotation recomposition. Keep the same native document
            // and bind current inputs after each successful Compose update.
            SideEffect {
                native?.let { fragment ->
                    fun current()=activeDocument.get()&&native===fragment&&fragment.isAdded&&
                        fragment.arguments?.getString("id")==document.id&&fragment.arguments?.getString("sha")==document.sha256&&
                        fragment.arguments?.getString("file")==document.localPath&&fragment.arguments?.getInt("count")==document.pageCount
                    if(current())fragment.bind(document,page,marks,
                        pageChanged={if(current())pageCallback(it)},
                        selected={value->if(current()){selection=value.takeIf{it.text.isNotBlank()};selectedCallback(value)}},
                        failed={message->if(current()){failure=message;errorCallback(message)}})
                }
            }
        }
        }
    }
        if(compactControls&&compatibilitySearch)AlertDialog(onDismissRequest={closeSearch()},title={Text("查找 PDF 原文")},text={Column(Modifier.heightIn(max=360.dp).verticalScroll(rememberScrollState())){searchControls(false)}},confirmButton={TextButton(enabled=!searching,onClick={closeSearch()}){Text("关闭查找")}})
        if(jumpOpen)AlertDialog(onDismissRequest={jumpOpen=false},title={Text("跳转到原文物理页")},text={Column(Modifier.heightIn(max=240.dp).verticalScroll(rememberScrollState())){OutlinedTextField(pageInput,{pageInput=it.filter(Char::isDigit).take(5);jumpError=null},singleLine=true,label={Text("页码（1–${document.pageCount}）")},isError=jumpError!=null);jumpError?.let{Text(it,color=MaterialTheme.colorScheme.error)}}},confirmButton={TextButton(onClick={val target=pageInput.toIntOrNull();if(target!=null&&target in 1..document.pageCount){navigate(target);jumpOpen=false}else jumpError="页码须为1–${document.pageCount}"}){Text("跳转")}},dismissButton={TextButton(onClick={jumpOpen=false}){Text("取消")}})
        if(showFailure&&failure!=null)AlertDialog(onDismissRequest={showFailure=false},title={Text("原文操作提示")},text={Column(Modifier.heightIn(max=360.dp).verticalScroll(rememberScrollState())){Text(failure.orEmpty())}},confirmButton={TextButton(onClick={showFailure=false}){Text("关闭")}})
    }
    textPage?.let{p->
        AlertDialog(onDismissRequest={textPage=null},title={Text("选取物理页 ${p.page} 的原文")},text={
            Column(Modifier.heightIn(max=420.dp).verticalScroll(rememberScrollState())){
                Text(if(p.text.isBlank())"本页没有可提取文字，图片内容未送入模型。" else "长按并拖动选择真实文字，再采用选区。")
                OutlinedTextField(value=textValue,onValueChange={if(it.text==p.text)textValue=it},readOnly=true,modifier=Modifier.fillMaxWidth(),textStyle=MaterialTheme.typography.bodyMedium)
            }
        },confirmButton={TextButton(enabled=!textValue.selection.collapsed,onClick={try{val range=textValue.selection;val value=PdfTextSemantics.selection(document.sha256,p,minOf(range.start,range.end),maxOf(range.start,range.end));selection=value;selectedCallback(value);textPage=null}catch(e:Throwable){fail(e)}}){Text("采用选区")}},dismissButton={TextButton(onClick={textPage=null}){Text("取消")}})
    }
    annotationNote?.let{note->AlertDialog(onDismissRequest={annotationNote=null},title={Text("保存原文标注")},text={Column(Modifier.heightIn(max=420.dp).verticalScroll(rememberScrollState())){Text(selection?.text?.take(160).orEmpty());OutlinedTextField(value=note,onValueChange={annotationNote=it.take(20000)},label={Text("我的批注（可留空）")},minLines=2,maxLines=6)}},confirmButton={TextButton(onClick={val current=selection ?: return@TextButton;scope.launch{try{saveAnnotationCallback(current,note);annotationNote=null}catch(e:Throwable){fail(e)}}}){Text("保存在本机")}},dismissButton={TextButton(onClick={annotationNote=null}){Text("取消")}})}
    }
}

/** Public zero-arg fragment: Android can restore its own native PDF state after recreation. */
@OptIn(ExperimentalPdfApi::class)
class DigestPdfFragment:PdfViewerFragment(){
    private var reference:PdfDocumentRef?=null
    private var pdf:PdfView?=null
    private var requestedPage=1
    private var loaded by mutableStateOf(false)
    private var contentDocument:PdfDocument?=null
    private var contentSHA:String?=null
    private var pendingScroll:Int?=null
    private var readinessPost:Runnable?=null
    private var laidOutWidth=0
    private var laidOutHeight=0
    private var applyingScroll=false
    private var restoringPage:Int?=null
    private var restoredPosition:Triple<Int,Int,Float>?=null
    private var restoreConfirmation:Runnable?=null
    private fun pageVisible(page:Int,first:Int,count:Int)=first>=0&&count>0&&page-1>=first&&page-1-first<count
    private val readinessLayout=View.OnLayoutChangeListener{view,_,_,_,_,_,_,_,_->
        if(view===pdf){
            // PdfView reports a viewport from onSizeChanged before its onLayout
            // refits zoom/scroll. Keep the last logical page through that reflow.
            val resized=laidOutWidth>0&&laidOutHeight>0&&
                (view.width!=laidOutWidth||view.height!=laidOutHeight)
            if(resized){cancelRestoreConfirmation();restoredPosition=null;restoringPage=requestedPage;if(pendingScroll==null)pendingScroll=requestedPage}
            laidOutWidth=view.width;laidOutHeight=view.height
            settleMeasuredDocument()
        }
    }
    val documentReady:Boolean get()=loaded && pdf?.let{it.isAttachedToWindow&&it.width>0&&it.height>0}==true
    val loadedPageCount:Int get()=pdf?.pdfDocument?.pageCount ?: 0
    private var selected:((PdfSelection)->Unit)?=null
    private var pageChanged:((Int)->Unit)?=null
    private var failed:((String)->Unit)?=null
    private var marks:List<PdfAnnotation> = emptyList()
    private var compatibilityHighlights:List<PdfSelectionBounds> = emptyList()
    private var nativeSearch=false
    /** Result of the last public search activation attempt; queried only after search(). */
    val nativeSearchAvailable:Boolean get()=nativeSearch
    private var hadNativeSelection=false
    private var searchSurface:View?=null
    private val searchLayout=View.OnLayoutChangeListener{_,_,_,_,_,_,_,_,_->if(loaded && !isTextSearchActive)applyMarks()}
    fun bind(document:PdfDocumentRef,page:Int,annotations:List<PdfAnnotation>,pageChanged:(Int)->Unit,selected:(PdfSelection)->Unit,failed:(String)->Unit){
        // A delayed update cannot retarget an already-created native fragment.
        val owner=arguments ?: return
        if(owner.getString("id")!=document.id||owner.getString("sha")!=document.sha256||owner.getString("file")!=document.localPath||owner.getInt("count")!=document.pageCount)return
        reference=document;this.pageChanged=pageChanged;this.selected=selected;this.failed=failed;marks=annotations
        val target=page.coerceIn(1,document.pageCount)
        if(requestedPage!=target){cancelRestoreConfirmation();requestedPage=target;if(restoringPage!=null)restoringPage=target;pendingScroll=target;settleMeasuredDocument()}
        applyMarks()
    }
    override fun onViewCreated(view:View,savedInstanceState:Bundle?){
        super.onViewCreated(view,savedInstanceState)
        searchSurface=view.findViewById(androidx.pdf.viewer.fragment.R.id.pdfSearchView)
        searchSurface?.addOnLayoutChangeListener(searchLayout)
        val a=requireArguments();val ref=PdfDocumentRef(a.getString("id")!!,a.getString("file")!!,a.getString("sha")!!,a.getInt("count"),a.getString("name")!!)
        reference=ref
        viewLifecycleOwner.lifecycleScope.launch{
            try{val file=PdfRepository(requireContext()).verify(ref);if(reference?.sha256==ref.sha256 && isAdded)documentUri=Uri.fromFile(file)}
            catch(e:CancellationException){throw e}catch(e:Throwable){failed?.invoke("PDF 原件校验或读取失败，请重新导入")}
        }
    }
    override fun onPdfViewCreated(pdfView:PdfView){
        super.onPdfViewCreated(pdfView);pdf=pdfView
        laidOutWidth=pdfView.width;laidOutHeight=pdfView.height
        pdfView.addOnLayoutChangeListener(readinessLayout)
        pdfView.addOnViewportChangedListener(object:PdfView.OnViewportChangedListener{
            override fun onViewportChanged(firstVisiblePage:Int,visiblePagesCount:Int,pageLocations:SparseArray<RectF>,zoomLevel:Float){
                if(pdf!==pdfView||applyingScroll||!documentReady||pdfView.pdfDocument!==contentDocument||reference?.sha256!=contentSHA||pdfView.width!=laidOutWidth||pdfView.height!=laidOutHeight)return
                val restoring=restoringPage
                if(restoring!=null){
                    if(!pageVisible(restoring,firstVisiblePage,visiblePagesCount))return
                    // Native metadata dispatches this callback before applying
                    // its deferred scroll in the same Main stack. Confirm only
                    // after that stack; do not publish an intermediate first page.
                    confirmRestoreAfterViewport(pdfView)
                    return
                }
                restoredPosition?.let{position->
                    if(position.first==pdfView.scrollX&&position.second==pdfView.scrollY&&position.third==pdfView.zoom)return
                    restoredPosition=null
                }
                if(documentReady && visiblePagesCount>0 && firstVisiblePage>=0){val page=firstVisiblePage+1;if(page in 1..(reference?.pageCount ?: 0) && page!=requestedPage){requestedPage=page;pageChanged?.invoke(page)}}
            }
        })
        pdfView.addOnSelectionChangedListener(object:PdfView.OnSelectionChangedListener{
            override fun onSelectionChanged(newSelection:Selection?){
                val ref=reference ?: return
                if(newSelection==null){if(hadNativeSelection){hadNativeSelection=false;selected?.invoke(PdfSelection(ref.sha256,"",emptyList(),emptyList(),extractor="android-jetpack-pdf-selection-v1"))};return}
                if(newSelection is TextSelection && newSelection.text.isNotBlank()){
                    if(newSelection.text.length>100000){hadNativeSelection=false;selected?.invoke(PdfSelection(ref.sha256,"",emptyList(),emptyList(),extractor="android-jetpack-pdf-selection-v1"));failed?.invoke("选区超过10万字符，请缩小选择或按页段解析");return}
                    hadNativeSelection=true
                    val boxes=newSelection.bounds.map{PdfSelectionBounds(it.pageNum+1,it.left,it.top,it.right,it.bottom)}
                    if(boxes.isNotEmpty() && boxes.all{it.page in 1..ref.pageCount})selected?.invoke(PdfSelection(ref.sha256,newSelection.text.toString(),boxes.map{it.page}.distinct(),boxes,extractor="android-jetpack-pdf-selection-v1"))
                }else if(hadNativeSelection){hadNativeSelection=false;selected?.invoke(PdfSelection(ref.sha256,"",emptyList(),emptyList(),extractor="android-jetpack-pdf-selection-v1"))}
            }
        })
    }
    override fun onLoadDocumentSuccess(document:PdfDocument){
        super.onLoadDocumentSuccess(document);isToolboxVisible=false
        if(document.pageCount!=reference?.pageCount){failed?.invoke("PDF 实际页数与原件记录不符，未采用其他材料");return}
        val target=pdf ?: return;val sha=reference?.sha256
        readinessPost?.let(target::removeCallbacks)
        cancelRestoreConfirmation();loaded=false;contentDocument=document;contentSHA=sha;pendingScroll=requestedPage;restoredPosition=null
        // The official callback precedes both PdfView.document assignment and visibility/layout.
        // One post covers assignment to an already measured view; real layout events cover a new
        // or temporarily zero-sized surface. Never scroll or report ready before positive geometry.
        val attempt=Runnable{if(pdf===target&&contentDocument===document&&contentSHA==sha)settleMeasuredDocument()}
        readinessPost=attempt;target.post(attempt)
    }
    private fun settleMeasuredDocument(){
        val target=pdf ?: return;val document=contentDocument ?: return
        if(!isAdded||reference?.sha256!=contentSHA||target.pdfDocument!==document||!target.isAttachedToWindow||target.width<=0||target.height<=0||target.width!=laidOutWidth||target.height!=laidOutHeight){loaded=false;return}
        loaded=true
        val page=pendingScroll;pendingScroll=null
        if(page!=null){
            cancelRestoreConfirmation();restoringPage=page;restoredPosition=null;applyingScroll=true
            try{target.scrollToPage(page-1)}finally{applyingScroll=false}
            // Native scrolling is bounded at the document end: the target can
            // be visible together with a preceding page. Deferred scrolls keep
            // their target until that actual range is observed.
            completeRestore(target,page,document,contentSHA,target.width,target.height)
        }
        applyMarks()
    }
    private fun cancelRestoreConfirmation(){restoreConfirmation?.let{pdf?.removeCallbacks(it)};restoreConfirmation=null}
    private fun completeRestore(target:PdfView,page:Int,document:PdfDocument,sha:String?,width:Int,height:Int){
        if(!isAdded||pdf!==target||contentDocument!==document||target.pdfDocument!==document||contentSHA!=sha||reference?.sha256!=sha||restoringPage!=page||!documentReady||target.width!=width||target.height!=height||width!=laidOutWidth||height!=laidOutHeight)return
        if(pageVisible(page,target.firstVisiblePage,target.visiblePagesCount)){
            restoringPage=null;restoredPosition=Triple(target.scrollX,target.scrollY,target.zoom)
        }
    }
    private fun confirmRestoreAfterViewport(target:PdfView){
        if(restoreConfirmation!=null)return
        val page=restoringPage ?: return;val document=contentDocument ?: return
        val sha=contentSHA;val width=target.width;val height=target.height
        lateinit var attempt:Runnable
        attempt=Runnable{
            if(restoreConfirmation===attempt){restoreConfirmation=null;completeRestore(target,page,document,sha,width,height)}
        }
        restoreConfirmation=attempt
        if(!target.post(attempt))restoreConfirmation=null
    }
    override fun onLoadDocumentError(error:Throwable){super.onLoadDocumentError(error);cancelRestoreConfirmation();readinessPost?.let{pdf?.removeCallbacks(it)};readinessPost=null;contentDocument=null;contentSHA=null;pendingScroll=null;restoringPage=null;restoredPosition=null;loaded=false;failed?.invoke("PDF 无法打开；原件保留，请检查密码或重新导入")}
    private fun applyMarks(){if(!documentReady || isTextSearchActive)return;pdf?.setHighlights((compatibilityHighlights.ifEmpty{marks.flatMap{it.selection.bounds}}).map{Highlight(PdfRect(it.page-1,it.left,it.top,it.right,it.bottom),0x66FFCF4A)})}
    fun search():Boolean {
        if(!documentReady)return false
        // The public setter is a documented no-op when this actual document cannot search.
        // Its public getter reflects the same synchronous saved-state change; no restricted feature API.
        isTextSearchActive=true;nativeSearch=isTextSearchActive
        return nativeSearch
    }
    fun showCompatibilityMatch(match:PdfSearchMatch){compatibilityHighlights=match.bounds;cancelRestoreConfirmation();requestedPage=match.page;if(restoringPage!=null)restoringPage=match.page;pendingScroll=match.page;settleMeasuredDocument()}
    fun clearCompatibilitySearch(){compatibilityHighlights=emptyList();applyMarks()}
    fun zoomBy(factor:Float){if(documentReady)pdf?.let{it.zoom=(it.zoom*factor).coerceIn(it.minZoom,it.maxZoom)}}
    override fun onDestroyView(){cancelRestoreConfirmation();searchSurface?.removeOnLayoutChangeListener(searchLayout);searchSurface=null;pdf?.removeOnLayoutChangeListener(readinessLayout);readinessPost?.let{pdf?.removeCallbacks(it)};readinessPost=null;contentDocument=null;contentSHA=null;pendingScroll=null;laidOutWidth=0;laidOutHeight=0;applyingScroll=false;restoringPage=null;restoredPosition=null;hadNativeSelection=false;loaded=false;nativeSearch=false;compatibilityHighlights=emptyList();pdf=null;selected=null;pageChanged=null;failed=null;super.onDestroyView()}
    override fun onRequestImmersiveMode(enterImmersive:Boolean){isToolboxVisible=false}
    override fun onLinkClicked(externalLink:androidx.pdf.content.ExternalLink):Boolean {
        val uri=externalLink.uri
        if(uri.scheme!="https" || uri.host.isNullOrBlank() || uri.userInfo!=null){failed?.invoke("原文链接须为不含凭据的 HTTPS 地址");return true}
        try{startActivity(android.content.Intent.createChooser(android.content.Intent(android.content.Intent.ACTION_VIEW,uri).addCategory(android.content.Intent.CATEGORY_BROWSABLE),"打开论文链接"))}catch(_:android.content.ActivityNotFoundException){failed?.invoke("此设备没有可打开论文链接的浏览器")}
        return true
    }
}
