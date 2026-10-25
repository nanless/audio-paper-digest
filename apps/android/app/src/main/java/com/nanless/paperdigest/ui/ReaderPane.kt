package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.nanless.paperdigest.pdf.PdfReaderPane
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject

@OptIn(ExperimentalMaterial3Api::class,ExperimentalLayoutApi::class)
@Composable internal fun ReaderPane(state:UiState,controller:AppController,action:Action){
 val paper=state.viewedPaper?.takeIf{it.id==state.selectedPaperId}?:state.papers.find{it.id==state.selectedPaperId}
 if(paper==null){EmptyPane("从一篇论文开始","打开文献后，导读、PDF、研究与笔记会保留在同一处。");return}
 val latestCatalog=state.papers.firstOrNull{it.id==paper.id}
 var showPaperInfo by rememberSaveable(paper.id){mutableStateOf(false)}
 var showLayout by rememberSaveable(paper.id){mutableStateOf(false)}
 var modeMenu by remember(paper.id){mutableStateOf(false)}
 val readerContext=LocalContext.current;var pdfError by remember(paper.id){mutableStateOf<String?>(null)}
 val paperReading=state.personal.optJSONObject("readingState")?.optJSONObject(paper.id)?:JSONObject()
 var tab by rememberSaveable(paper.id){mutableStateOf(when(paperReading.optString("mode")){"analysis"->"研究";"note"->"笔记";else->"导读"})}
 var phonePDF by rememberSaveable(paper.id){mutableStateOf(false)}
 var focus by rememberSaveable(paper.id){mutableStateOf("both")}
 var splitPercent by rememberSaveable(paper.id){mutableFloatStateOf(paperReading.optDouble("split",46.0).toFloat().takeIf{it.isFinite()}?.coerceIn(38f,62f)?:46f)}
 var export by remember(paper.id){mutableStateOf(false)};var zotero by remember(paper.id){mutableStateOf(false)}
 LaunchedEffect(state.pdfMode){phonePDF=state.pdfMode}
 LaunchedEffect(paper.id,tab){action("personal.reading",obj("paperID" to paper.id,"mode" to when(tab){"研究"->"analysis";"笔记"->"note";else->"guide"}))}
 LaunchedEffect(paper.id,splitPercent){delay(600);action("personal.reading",obj("paperID" to paper.id,"split" to splitPercent))}
 val scope=rememberCoroutineScope();val tabStates=rememberSaveableStateHolder()
 var guideScroll by rememberSaveable(paper.id){mutableIntStateOf(paperReading.optInt("guideScroll",paperReading.optInt("scroll",0)))}
 LaunchedEffect(paper.id,guideScroll){delay(600);action("personal.reading",obj("paperID" to paper.id,"guideScroll" to guideScroll))}
 val document=state.pdfDocument
 val pdfOutput=remember(paper.id,state.readingMaterialID,document?.sha256){PdfOriginalOutputSession(controller,readerContext,scope,paper.id,state.readingMaterialID,document?.sha256.orEmpty())}
 DisposableEffect(pdfOutput){onDispose{pdfOutput.dispose()}}
 val pdfOutputEnabled=canOutputCurrentPdf(state)
 val pdfAvailable=state.pdfMode&&document!=null
 val sourceNotices=readerSourceNotices(state,paper.id,pdfError)
 val sourceTone=when{sourceNotices.any{it.tone=="error"}->"error";sourceNotices.any{it.tone=="warning"}->"warning";else->"info"}
 val sourceColor=when(sourceTone){"error"->MaterialTheme.colorScheme.error;"warning"->MaterialTheme.colorScheme.tertiary;else->MaterialTheme.colorScheme.onSurfaceVariant}
 val sourceLabel=when(sourceTone){"error"->"来源存在问题";"warning"->"来源尚待核对";else->"来源与版本"}
 val density=androidx.compose.ui.platform.LocalDensity.current
 val modes=if(pdfAvailable)listOf("导读","研究","笔记","PDF")else listOf("导读","研究","笔记")
 fun chooseMode(value:String){if(value=="PDF"){phonePDF=true;focus="pdf"}else{tab=value;phonePDF=false;focus="both"};modeMenu=false}
 fun togglePDF(){action(if(state.pdfMode)"pdf.close" else "pdf.open",JSONObject());phonePDF=!state.pdfMode;focus="both"}
 fun toggleList(key:String){val ids=state.personal.ids(key).toMutableList();if(!ids.remove(paper.id))ids+=paper.id;action("personal.setList",obj("key" to key,"ids" to JSONArray(ids)))}
 NonOccludingViewport(allowHingePair=pdfAvailable,preferHingePair=focus=="both",preferRightRegion=focus=="pdf"){
  val readerViewportWidth=maxWidth
  val readerViewportHeight=maxHeight
  val hingePair=LocalReadingHingePair.current
  val hingePairAvailable=LocalReadingHingePairAvailable.current
  val geometry=readerGeometry(readerViewportWidth.value,readerViewportHeight.value,density.fontScale,pdfAvailable,splitPercent)
  val canSplit=hingePairAvailable||geometry.canSplit
  val split=canSplit&&focus=="both"
  val showPDF=pdfAvailable&&(split||if(canSplit)focus=="pdf" else phonePDF)
  val showText=!pdfAvailable||split||!showPDF
  Column(Modifier.fillMaxSize()){
   Box(Modifier.fillMaxWidth()){
   Column(if(hingePair!=null)Modifier.width(hingePair.left.width.dp)else Modifier.fillMaxWidth()){
   Row(Modifier.fillMaxWidth().padding(horizontal=8.dp,vertical=4.dp),verticalAlignment=androidx.compose.ui.Alignment.CenterVertically){
    if(geometry.compactChrome){
     Box(Modifier.weight(1f)){
      TextButton({modeMenu=true},Modifier.fillMaxWidth()){
       Text((if(showPDF&&!split)"PDF" else tab)+" · "+paper.titleZh,Modifier.weight(1f),maxLines=1,overflow=TextOverflow.Ellipsis)
       Icon(Icons.Outlined.ArrowDropDown,"选择阅读模式")
      }
      DropdownMenu(modeMenu,{modeMenu=false}){modes.forEach{value->DropdownMenuItem({Text(value)},{chooseMode(value)})}}
     }
    }else Column(Modifier.weight(1f).clickable(onClickLabel="查看完整论文信息"){showPaperInfo=true}.padding(horizontal=8.dp)){
     Text(paper.titleZh,style=MaterialTheme.typography.titleMedium,maxLines=2,overflow=TextOverflow.Ellipsis)
     Text("打开时来源："+(paper.sourceVersion?:paper.sourceKind),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant,maxLines=1,overflow=TextOverflow.Ellipsis)
    }
    IconButton({showPaperInfo=true}){BadgedBox(badge={if(sourceNotices.isNotEmpty())Badge{Text(sourceNotices.size.toString())}}){Icon(if(sourceTone=="info")Icons.Outlined.Info else Icons.Outlined.Warning,"$sourceLabel，查看完整信息与 ${sourceNotices.size} 项提示",tint=sourceColor)}}
    IconButton({togglePDF()}){Icon(Icons.Outlined.PictureAsPdf,if(state.pdfMode)"关闭 PDF" else "打开 PDF")}
    Box{
     IconButton({export=true}){Icon(Icons.Outlined.MoreVert,"论文操作与导出")}
     DropdownMenu(export,{export=false}){
      DropdownMenuItem({Text("论文完整信息与来源…")},{export=false;showPaperInfo=true})
      DropdownMenuItem({Text(if(paper.id in state.personal.ids("favorites"))"取消收藏" else "收藏这篇论文")},{export=false;toggleList("favorites")})
      DropdownMenuItem({Text(if(paper.id in state.personal.ids("reading"))"移出待读" else "加入待读")},{export=false;toggleList("reading")})
      DropdownMenuItem({Text("打开原来源页面")},{export=false;val u=android.net.Uri.parse(paper.sourceURL?:paper.blogURL);if(u.scheme=="https"&&u.host!=null&&u.userInfo==null)runCatching{readerContext.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW,u))}})
      DropdownMenuItem({Text("刷新已发布导读")},{export=false;action("paper.open",obj("paperID" to paper.id,"refresh" to true))})
      if(canSplit)DropdownMenuItem({Text("阅读布局与分栏…")},{export=false;showLayout=true})
      HorizontalDivider()
      listOf("guide-html" to "图文导读 HTML","paper-pdf" to "PDF 原件","bibtex" to "BibTeX","ris" to "RIS","citation-json" to "引用 JSON","research-md" to "研究 Markdown","research-html" to "研究 HTML","research-json" to "完整研究 JSON").forEach{(format,label)->DropdownMenuItem({Text(label)},{export=false;action("export.prepare",obj("format" to format))})}
      PdfOriginalOutputMenuItems(pdfOutputEnabled,pdfOutput){export=false}
      paper.sourceURL?.takeIf{publicShareURL(it)}?.let{url->DropdownMenuItem({Text("分享论文来源…")},{export=false;try{readerContext.startActivity(android.content.Intent.createChooser(android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain").putExtra(android.content.Intent.EXTRA_SUBJECT,paper.title).putExtra(android.content.Intent.EXTRA_TEXT,publicShareText(paper.title,url)),"分享论文来源"))}catch(e:Exception){pdfError="此设备没有可处理文本分享的应用"}})}
      DropdownMenuItem({Text("保存完整离线研究包")},{export=false;action("storage.prepare",JSONObject())})
      if(state.article!=null)DropdownMenuItem({Text("打印图文导读…")},{export=false;scope.launch{try{run {
          val article = requireNotNull(state.article) { "请先载入当前图文导读" }
          val binding = com.nanless.paperdigest.data.GuidePrintBinding(paper, article, state.readingMaterialID) {
            val now = controller.state.value
            com.nanless.paperdigest.data.GuidePrintReading(now.readingMaterialID, now.viewedPaper, now.article)
          }
          binding.requireCurrent()
          val rendered = ResearchRenderer.renderArticle(readerContext, article)
          binding.requireCurrent()
          printPaper(readerContext, paper.titleZh, rendered, article.notices, binding::requireCurrent)
        }}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;pdfError=e.message}}})
      DropdownMenuItem({Text("存档到 Zotero…")},{export=false;zotero=true})
     }
    }
   }
   if(!geometry.compactChrome)Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal=12.dp),horizontalArrangement=Arrangement.spacedBy(8.dp)){
    listOf("导读","研究","笔记").forEach{value->FilterChip(tab==value&&(!showPDF||split),{chooseMode(value)},label={Text(value)})}
    if(pdfAvailable)FilterChip(showPDF,{chooseMode("PDF")},label={Text("PDF")})
    TextButton({showPaperInfo=true}){Text(if(sourceNotices.isEmpty())"来源与版本" else "$sourceLabel · ${sourceNotices.size}",color=sourceColor)}
    if(canSplit)TextButton({showLayout=true}){Text("阅读布局")}
   }
   }
   if(hingePair!=null&&document!=null)Column(Modifier.offset(x=(hingePair.left.width+hingePair.gap).dp).width(hingePair.right.width.dp).padding(horizontal=12.dp,vertical=8.dp)){
    Text("PDF 原件",style=MaterialTheme.typography.titleSmall)
    Text(document.displayName,maxLines=1,overflow=TextOverflow.Ellipsis,style=MaterialTheme.typography.labelSmall)
    Text(state.pdfReceipt.optString("version").ifBlank{"原版本未标注"},style=MaterialTheme.typography.labelSmall)
   }
   }
   // Sheets are siblings of this bounded viewport. Opening them does not rebuild
   // the actual scientific WebView, note editor, question editor or PDF fragment.
   Row(Modifier.weight(1f).fillMaxWidth()){
    if(showText)key(paper.id,"reading-text"){
     Box((if(split&&hingePair!=null)Modifier.width(hingePair.left.width.dp)else Modifier.weight(if(split)geometry.leftPercent else 1f)).fillMaxHeight()){
      tabStates.SaveableStateProvider(tab){when(tab){"导读"->if(state.article!=null)ArticleDocument(state.article,state.settings.optInt("font",18),guideScroll,{guideScroll=it})else EmptyPane("导读尚未载入","本地 PDF 可直接开始研究；公开导读可在联网后同步。");"研究"->ResearchPane(state,controller,action);else->NotesPane(state,controller,action)}}
     }
    }
    if(split&&hingePair!=null)Spacer(Modifier.width(hingePair.gap.dp).fillMaxHeight())
    else if(split){
     val availablePx=with(density){(readerViewportWidth-12.dp).toPx()}.coerceAtLeast(1f)
     val drag=androidx.compose.foundation.gestures.rememberDraggableState{delta->splitPercent=(splitPercent.coerceIn(geometry.minPercent,geometry.maxPercent)+delta/availablePx*100f).coerceIn(geometry.minPercent,geometry.maxPercent)}
     Box(Modifier.width(12.dp).fillMaxHeight().draggable(drag,androidx.compose.foundation.gestures.Orientation.Horizontal).clickable(onClickLabel="调整阅读分栏"){showLayout=true},contentAlignment=androidx.compose.ui.Alignment.Center){VerticalDivider()}
    }
    if(showPDF&&document!=null)key(paper.id,document.sha256,"reading-pdf"){
     PdfReaderPane(document,state.pdfPage,{action("pdf.page",obj("page" to it,"paperID" to paper.id,"pdfSHA" to document.sha256))},{selection->scope.launch{try{controller.updatePdfSelection(selection)}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;pdfError=e.message}}},(if(split&&hingePair!=null)Modifier.width(hingePair.right.width.dp)else Modifier.weight(if(split)100f-geometry.leftPercent else 1f)).fillMaxHeight(),{pdfError=it},onSaveAnnotation={selection,note->controller.updatePdfSelection(selection);controller.execute("pdf.highlight",obj("comment" to note));Unit},annotationRevision=state.personal.optJSONObject("annotations")?.optJSONArray(paper.id)?.toString().orEmpty(),portableAnnotations=(state.personal.optJSONObject("annotations")?.rows(paper.id)?:emptyList()).filter{it.optString("pdfSHA")==document.sha256})
    }
   }
  }
  if(showLayout)AlertDialog(onDismissRequest={showLayout=false},title={Text("阅读布局")},text={Column(Modifier.heightIn(max=readerViewportHeight).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)){
   if(LocalHingeConstrained.current)Text("布局按避开分隔或遮挡折痕后的实际安全宽度计算；折痕位置不放置正文或操作。")
   Text(if(canSplit)"只在 PDF 已打开且两栏均有足够宽度时并排。收窄窗口会改为一次显示一份内容；原页码、问题和笔记保留。" else "当前窗口适合单栏，扩大窗口后可使用双栏；也可切换导读、研究、笔记与 PDF。")
   FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)){listOf("both" to "并排阅读","reading" to "专注导读与研究","pdf" to "专注 PDF").forEach{(value,label)->FilterChip(focus==value,{focus=value;if(value=="reading")phonePDF=false;if(value=="pdf")phonePDF=true},enabled=canSplit,label={Text(label)})}}
   if(hingePair!=null)Text("导读与 PDF 分别使用左右安全区域；物理中缝位置不能拖动。")
   else if(geometry.canSplit){Text("左侧 ${geometry.leftPercent.toInt()}%")
    if(geometry.maxPercent>geometry.minPercent)Slider(value=geometry.leftPercent,onValueChange={splitPercent=it},valueRange=geometry.minPercent..geometry.maxPercent)
   }
  }},confirmButton={TextButton({showLayout=false}){Text("关闭")}})
  if(showPaperInfo)AlertDialog(onDismissRequest={showPaperInfo=false},title={Text("论文信息与来源")},text={SelectionContainer{
   Column(Modifier.heightIn(max=readerViewportHeight).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)){
    Text(paper.titleZh,style=MaterialTheme.typography.titleMedium);if(paper.title!=paper.titleZh)Text(paper.title)
    Text(paper.authors.joinToString(" · "))
    Text("目录日期：${paper.date.ifBlank{"未标注"}}\n打开时目录版本：${paper.sourceVersion?:"未标注"}\n当前目录版本：${latestCatalog?.sourceVersion?:"未标注"}\n来源编号：${paper.id}")
    paper.score?.let{Text("目录原评分：$it / 10（完整量表见原导读）")};paper.citation.optString("doi").takeIf{it.isNotBlank()}?.let{Text("DOI：$it")}
    Text("当前导读版本：${state.article?.sourceVersion?:"未标注"}\n导读修订 SHA：${state.article?.revisionSHA256?:"未标注"}")
    if(state.pdfMode)Text("当前PDF原版本：${state.pdfReceipt.optString("version").ifBlank{"未标注"}}\nPDF SHA：${document?.sha256?:"原件尚未载入"}")
    sourceNotices.forEach{notice->Surface(color=when(notice.tone){"error"->MaterialTheme.colorScheme.errorContainer;"warning"->MaterialTheme.colorScheme.tertiaryContainer;else->MaterialTheme.colorScheme.primaryContainer},modifier=Modifier.fillMaxWidth()){
     Column(Modifier.padding(12.dp)){Text(notice.title,style=MaterialTheme.typography.labelLarge);Text(notice.text)}
    }}
   }
  }},confirmButton={TextButton({showPaperInfo=false}){Text("关闭")}})
 }
 PdfOriginalOutputDialogs(pdfOutput)
 if(zotero)ZoteroArchiveDialog(state,action,{zotero=false})
}

internal data class ReaderSourceNotice(val title:String,val text:String,val tone:String)
internal fun readerSourceNotices(state:UiState,paperID:String,pdfError:String?):List<ReaderSourceNotice> = buildList {
 if(pdfError!=null)add(ReaderSourceNotice("操作未完成",pdfError,"error"))
 if(paperID in state.catalogSummary.ids("missingFromLatest"))add(ReaderSourceNotice("目录范围","本机保留的先前资料，未列入最新网站快照；这不等于论文撤稿。","info"))
 if(state.pdfMode){
  if(state.pdfReceipt.optBoolean("isStale"))add(ReaderSourceNotice("原件尚待核对","此 PDF 为已保存的旧版本，未核对当前版本。","warning"))
  state.pdfReceipt.optJSONArray("notices")?.let{a->for(i in 0 until a.length())add(ReaderSourceNotice("PDF 来源",a.optString(i),if(state.pdfReceipt.optBoolean("isStale"))"warning" else "info"))}
 }
 state.article?.let{a->
  val tone=noticeTone(a)
  if(!a.completeOffline)add(ReaderSourceNotice("离线范围","导读资源尚未全部保存为完整离线材料；联网阅读与完整离线状态分别核验。",if(tone=="error")"error" else "warning"))
  a.resources.filter{!it.missingReason.isNullOrBlank()}.forEach{resource->add(ReaderSourceNotice("科学图资源",resource.sourceURL+"\n"+resource.missingReason,"error"))}
  if(a.isStale)add(ReaderSourceNotice("导读尚待核对","正在读取先前保存的版本；尚未核对当前发布。",tone))
  a.notices.forEach{add(ReaderSourceNotice("导读来源",it,tone))}
 }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable private fun ResearchPane(state:UiState,controller:AppController,action:Action){
 val context=LocalContext.current;val id=state.selectedPaperId.orEmpty()
 var freshDraftRevision by remember(id){mutableLongStateOf(0)}
 val reading=state.personal.optJSONObject("readingState")?.optJSONObject(id)?:JSONObject()
 var question by rememberSaveable(id){mutableStateOf(reading.optString("question"))};var evidence by rememberSaveable(id){mutableStateOf(reading.optString("scope","guide"))};var from by rememberSaveable(id){mutableStateOf(reading.optInt("from",reading.optInt("fromPage",1)).toString())};var to by rememberSaveable(id){mutableStateOf(reading.optInt("to",reading.optInt("toPage",1)).toString())}
 var chapter by rememberSaveable(id){mutableIntStateOf(reading.optInt("chapter",0))}
 var chapters by remember(state.pdfDocument?.sha256){mutableStateOf<List<JSONObject>>(emptyList())};var chapterLoading by remember{mutableStateOf(false)};var chapterError by remember{mutableStateOf<String?>(null)};var chapterMenu by remember{mutableStateOf(false)};val chapterScope=rememberCoroutineScope()
 LaunchedEffect(question,evidence,from,to,chapter){delay(600);action("personal.reading",obj("paperID" to id,"question" to question,"scope" to evidence,"from" to from.toIntOrNull(),"to" to to.toIntOrNull(),"chapter" to chapter))}
 var chosen by rememberSaveable(id){mutableStateOf<String?>(null)}
 val originalSessions=state.sessions.filter{it.optString("paperID")==id}
 val uniqueRecords=remember(state.sessions){uniqueStudySessionIndex(state.sessions)}
 val sessions=recordsNewest(originalSessions.filter{uniqueRecords[it.optString("id")]===it})
 val session=if(chosen==null)sessions.firstOrNull() else uniqueStudySession(sessions,chosen)
 var html by remember(session?.toString()){mutableStateOf<String?>(null)};var renderError by remember(session?.toString()){mutableStateOf<String?>(null)}
 LaunchedEffect(session?.toString()){if(session!=null)try{html=ResearchRenderer.render(context,sessionAnswer(session));renderError=null}catch(e:Exception){renderError=e.message}}
 Column(Modifier.fillMaxSize()){
 Column(Modifier.weight(1f,fill=false).verticalScroll(rememberScrollState()).padding(16.dp)){
 OutlinedTextField(question,{question=it.take(16000);freshDraftRevision++},Modifier.fillMaxWidth(),label={Text("向这篇论文提问")},placeholder={Text("例如：这项方法依赖哪些假设？")},minLines=2,maxLines=6)
 Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(4.dp)){listOf("guide" to "导读","selection" to "选区","page" to "当前页","chapter" to "章节","range" to "页段","full" to "全文").forEach{(v,l)->FilterChip(evidence==v,{evidence=v;freshDraftRevision++},label={Text(l)})}}
 Text(if(evidence=="guide")"导读证据：${state.article?.sourceVersion?:"版本未标注"} · ${state.article?.revisionSHA256?.take(12).orEmpty()}" else "PDF 证据：${state.pdfReceipt.optString("version").ifBlank{"原版本未标注"}} · ${state.pdfDocument?.sha256?.take(12).orEmpty()} · 物理页",style=MaterialTheme.typography.labelSmall)
 if(evidence=="chapter"){
  FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
   OutlinedButton({val sha=state.pdfDocument?.sha256;if(sha!=null){chapterLoading=true;chapterError=null;chapterScope.launch{try{val result=controller.execute("pdf.outline");require(result.optString("pdfSHA")==sha&&controller.state.value.selectedPaperId==id&&controller.state.value.pdfDocument?.sha256==sha){"原文已切换，未采用旧目录"};chapters=result.rows("chapters");if(chapters.isEmpty())chapterError="此原件没有可用目录；请选择明确页段，不按博客标题推断章节。"}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;chapterError=e.message}finally{chapterLoading=false}}}},enabled=state.pdfDocument!=null&&!chapterLoading&&!state.busy){Text(if(chapterLoading)"正在读取目录…" else "读取原 PDF 目录")}
   Box{TextButton({chapterMenu=true},enabled=chapters.isNotEmpty()){Text(chapters.firstOrNull{it.optInt("index")==chapter}?.optString("title")?:"选择真实章节")};DropdownMenu(chapterMenu,{chapterMenu=false}){chapters.forEach{entry->DropdownMenuItem({Text("${entry.optString("title")} · 物理页 ${entry.optInt("page")}–${entry.optInt("endPage")}")},{chapter=entry.optInt("index");freshDraftRevision++;chapterMenu=false})}}}
  }
  chapterError?.let{Text(it,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.labelSmall)}
 }
 if(evidence !in listOf("guide","selection","page","chapter","range","full"))Text("原记录的证据范围为 $evidence；请先明确选择 Android 当前可用的原文范围，未自动改用其他材料。",color=MaterialTheme.colorScheme.error)
 if(evidence=="range")Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){OutlinedTextField(from,{from=it.filter(Char::isDigit);freshDraftRevision++},Modifier.weight(1f),label={Text("起始物理页")});OutlinedTextField(to,{to=it.filter(Char::isDigit);freshDraftRevision++},Modifier.weight(1f),label={Text("结束物理页")})}
 Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("仅点击发送才调用模型 · 用量据实记录",style=MaterialTheme.typography.labelSmall,modifier=Modifier.weight(1f));Button({action("model.run",obj("question" to question,"evidenceKind" to evidence,"fromPage" to from.toIntOrNull(),"toPage" to to.toIntOrNull(),"chapter" to chapter,"force" to false))},enabled=question.isNotBlank()&&!state.busy&&evidence in listOf("guide","selection","page","chapter","range","full")&&(evidence!="chapter"||chapters.any{it.optInt("index")==chapter})){Icon(Icons.Outlined.Send,null);Text("发送")}}
 FreshStudyAction(state,controller,obj("question" to question,"evidenceKind" to evidence,"fromPage" to from.toIntOrNull(),"toPage" to to.toIntOrNull(),"chapter" to chapter),draftRevision=freshDraftRevision,
  enabled=question.isNotBlank()&&!state.busy&&evidence in listOf("guide","selection","page","chapter","range","full")&&(evidence!="chapter"||chapters.any{it.optInt("index")==chapter}))
 if(sessions.isNotEmpty()){var menu by remember{mutableStateOf(false)};Box{TextButton({menu=true}){Text("研究记录 ${sessions.size} · ${session?.optString("question").orEmpty().take(30)}")};DropdownMenu(menu,{menu=false}){sessions.forEach{s->DropdownMenuItem({Text(s.optString("question").take(70))},{chosen=s.optString("id");menu=false})}}}}
 if(originalSessions.size!=sessions.size)Text("部分原记录身份重复或归属冲突，未用于显示；原资料仍保留。",style=MaterialTheme.typography.labelSmall)
 session?.let{s->Text("${jobStatus(s.optString("status"))} · ${sessionUsageLabel(s)}",style=MaterialTheme.typography.labelSmall);Text(sessionModelLabel(s),style=MaterialTheme.typography.labelSmall);Text(sessionChargeLabel(s),style=MaterialTheme.typography.labelSmall)}
 }
 when{renderError!=null->Text(renderError!!,Modifier.padding(16.dp));html!=null->Box(Modifier.weight(1f)){StaticDocument(html!!)};else->EmptyPane("让阅读形成研究记录","每次回答关联实际输入、来源页码和原始用量，可完整导出。")}
 }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable private fun NotesPane(state:UiState,controller:AppController,action:Action){
 val id=state.selectedPaperId.orEmpty();val note=state.personal.optJSONObject("notes")?.optJSONObject(id)?:JSONObject()
 var draft by rememberSaveable(id){mutableStateOf(note.optString("text"))};var revision by rememberSaveable(id){mutableIntStateOf(note.optInt("revision"))};var dirty by rememberSaveable(id){mutableStateOf(false)}
 LaunchedEffect(note.toString()){if(!dirty){draft=note.optString("text");revision=note.optInt("revision")}}
 var reloadNote by remember{mutableStateOf(false)};var edit by remember{mutableStateOf<JSONObject?>(null)};var editText by remember{mutableStateOf("")};var removeCount by remember{mutableIntStateOf(1)};var remove by remember{mutableStateOf<JSONObject?>(null)};var saving by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};val saveScope=rememberCoroutineScope()
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 Text("阅读笔记",style=MaterialTheme.typography.titleLarge)
 OutlinedTextField(draft,{draft=it;dirty=true},Modifier.fillMaxWidth().heightIn(min=200.dp),label={Text("你的想法、疑问与结论")})
 Button({val submitted=draft;val base=revision;saving=true;saveScope.launch{try{val result=controller.execute("personal.note",obj("paperID" to id,"text" to submitted,"baseRevision" to base));revision=result.optInt("revision",base+1);if(draft==submitted)dirty=false;error=null}catch(e:Exception){error=e.message}finally{saving=false}}},enabled=dirty&&!saving&&!state.busy){Text(if(saving)"正在保存…" else "保存笔记")};error?.let{Text(it,color=MaterialTheme.colorScheme.error);TextButton({reloadNote=true}){Text("查看并重新读取已保存版本…")}}
 state.pdfSelection?.takeIf{it.text.isNotBlank()}?.let{selection->Text("原文选区 · 物理页 ${selection.pages.joinToString()}",style=MaterialTheme.typography.titleSmall);Text(selection.text);Button({action("pdf.highlight",obj("comment" to "","color" to "yellow"))}){Text("保存高亮标注")}}
 Text("PDF 标注",style=MaterialTheme.typography.titleLarge)
 annotationGroups(state.personal.optJSONObject("annotations")?.rows(id)?:emptyList()).forEach{group->val a=group.first();OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(14.dp)){Text(group.map{it.optString("text")}.filter{it.isNotBlank()}.distinct().joinToString("\n"));Text(group.map{it.optString("comment",it.optString("note"))}.filter{it.isNotBlank()}.distinct().joinToString("\n"));Text("${group.size} 个原页位置",style=MaterialTheme.typography.labelSmall);FlowRow(horizontalArrangement=Arrangement.spacedBy(4.dp)){TextButton({action("pdf.annotation.open",obj("id" to a.optString("id")))}){Text("回到原文")};TextButton({edit=a;editText=group.map{it.optString("comment",it.optString("note"))}.filter{it.isNotBlank()}.distinct().joinToString("\n")}){Text("编辑批注…")};TextButton({removeCount=group.size;remove=a}){Text("删除标注…")}}}}}
 }
 if(reloadNote)AlertDialog(onDismissRequest={reloadNote=false},title={Text("读取已保存笔记？")},text={Column{Text("当前草稿将被以下已保存版本替换。取消会保留草稿。");Text(note.optString("text"))}},confirmButton={TextButton({draft=note.optString("text");revision=note.optInt("revision");dirty=false;error=null;reloadNote=false}){Text("替换当前草稿")}},dismissButton={TextButton({reloadNote=false}){Text("保留草稿")}})
 edit?.let{a->AlertDialog(onDismissRequest={edit=null},title={Text("编辑标注批注")},text={OutlinedTextField(editText,{editText=it},label={Text("批注")})},confirmButton={TextButton({saving=true;saveScope.launch{try{controller.execute("personal.annotationNote",obj("paperID" to id,"id" to a.optString("id"),"comment" to editText));edit=null;error=null}catch(e:Exception){error=e.message}finally{saving=false}}},enabled=!saving){Text("保存")}},dismissButton={TextButton({edit=null},enabled=!saving){Text("取消")}})}
 remove?.let{a->AlertDialog(onDismissRequest={remove=null},title={Text("删除这个标注？")},text={Text("删除这组标注的 $removeCount 个原页位置及批注。导出完整备份后可从备份恢复。")},confirmButton={TextButton({action("pdf.removeAnnotation",obj("id" to a.optString("id")));remove=null}){Text("删除")}},dismissButton={TextButton({remove=null}){Text("取消")}})}
}

@Composable private fun ArticleDocument(article:com.nanless.paperdigest.data.Article,font:Int,scroll:Int,onScroll:(Int)->Unit){
 val context=LocalContext.current
 var html by remember(article.revisionSHA256,article.html,article.markdown){mutableStateOf<String?>(null)}
 var error by remember(article.revisionSHA256,article.html,article.markdown){mutableStateOf<String?>(null)}
 LaunchedEffect(article.revisionSHA256,article.html,article.markdown){try{html=ResearchRenderer.renderArticle(context,article)}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;error=e.message}}
 when{error!=null->EmptyPane("导读未能完整显示",error!!+" 请对照 PDF 原文；原始资料仍保留。");html!=null->StaticDocument(html!!,font,scroll,onScroll);else->LinearProgressIndicator(Modifier.fillMaxWidth())}
}

internal fun annotationGroups(rows:List<JSONObject>):List<List<JSONObject>> = rows.withIndex().groupBy { indexed ->
 val value=indexed.value;val identity=value.optString("groupID").ifBlank{value.optString("id").ifBlank{"unidentified:${indexed.index}"}}
 value.optString("pdfSHA")+":"+identity
}.values.map{group->group.map{it.value}}

internal fun noticeTone(article:com.nanless.paperdigest.data.Article):String=when{article.resources.any{!it.missingReason.isNullOrBlank()}->"error";article.isStale||!article.completeOffline->"warning";else->"info"}
internal fun publicShareURL(url:String):Boolean=runCatching{val value=java.net.URI(url);value.scheme=="https"&&value.host!=null&&value.userInfo==null}.getOrDefault(false)
internal fun publicShareText(originalTitle:String,url:String):String{require(publicShareURL(url));return originalTitle+"\n"+url}
