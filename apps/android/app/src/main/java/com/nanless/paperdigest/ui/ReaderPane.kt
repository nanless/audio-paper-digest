package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.clickable
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

@Composable internal fun ReaderPane(state:UiState,controller:AppController,action:Action){
 val paper=state.viewedPaper?.takeIf{it.id==state.selectedPaperId}?:state.papers.find{it.id==state.selectedPaperId}
 if(paper==null){EmptyPane("从一篇论文开始","打开文献后，导读、PDF、研究与笔记会保留在同一处。");return}
 val latestCatalog=state.papers.firstOrNull{it.id==paper.id}
 var showPaperInfo by remember{mutableStateOf(false)}
 val readerContext=LocalContext.current;var pdfError by remember{mutableStateOf<String?>(null)}
 val paperReading=state.personal.optJSONObject("readingState")?.optJSONObject(paper.id)?:JSONObject()
 var tab by rememberSaveable(paper.id){mutableStateOf(when(paperReading.optString("mode")){"analysis"->"研究";"note"->"笔记";else->"导读"})};var phonePDF by rememberSaveable{mutableStateOf(false)};var export by remember{mutableStateOf(false)};var zotero by remember{mutableStateOf(false)}
 LaunchedEffect(state.pdfMode){phonePDF=state.pdfMode}
 LaunchedEffect(tab){action("personal.reading",obj("paperID" to paper.id,"mode" to when(tab){"研究"->"analysis";"笔记"->"note";else->"guide"}))}
 val scope=rememberCoroutineScope();val tabStates=rememberSaveableStateHolder();var guideScroll by rememberSaveable(paper.id){mutableIntStateOf(state.personal.optJSONObject("readingState")?.optJSONObject(paper.id)?.let{it.optInt("guideScroll",it.optInt("scroll",0))}?:0)}
 LaunchedEffect(guideScroll){delay(600);action("personal.reading",obj("paperID" to paper.id,"guideScroll" to guideScroll))}
 Column(Modifier.fillMaxSize()){
 Row(Modifier.fillMaxWidth().padding(horizontal=16.dp,vertical=10.dp),horizontalArrangement=Arrangement.spacedBy(2.dp)){
 Column(Modifier.weight(1f)){Text(paper.titleZh,style=MaterialTheme.typography.titleMedium,maxLines=2,overflow=TextOverflow.Ellipsis,modifier=Modifier.clickable(onClickLabel="查看完整论文信息"){showPaperInfo=true});Text("打开时来源："+(paper.sourceVersion?:paper.sourceKind)+(latestCatalog?.sourceVersion?.takeIf{it!=paper.sourceVersion}?.let{" · 当前目录：$it"}?:""),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)}
 IconButton({val ids=state.personal.ids("favorites").toMutableList();if(!ids.remove(paper.id))ids+=paper.id;action("personal.setList",obj("key" to "favorites","ids" to JSONArray(ids)))}){Icon(if(paper.id in state.personal.ids("favorites"))Icons.Outlined.Bookmark else Icons.Outlined.BookmarkBorder,"收藏")}
 IconButton({val ids=state.personal.ids("reading").toMutableList();if(!ids.remove(paper.id))ids+=paper.id;action("personal.setList",obj("key" to "reading","ids" to JSONArray(ids)))}){Icon(Icons.Outlined.BookmarkAdd,"待读")}
 IconButton({action(if(state.pdfMode)"pdf.close" else "pdf.open",JSONObject());phonePDF=!state.pdfMode}){Icon(Icons.Outlined.PictureAsPdf,if(state.pdfMode)"关闭 PDF" else "打开 PDF")}
 Box{IconButton({export=true}){Icon(Icons.Outlined.IosShare,"导出")};DropdownMenu(export,{export=false}){listOf("guide-html" to "图文导读 HTML","paper-pdf" to "PDF 原件","bibtex" to "BibTeX","ris" to "RIS","citation-json" to "引用 JSON","research-md" to "研究 Markdown","research-html" to "研究 HTML","research-json" to "完整研究 JSON").forEach{(format,label)->DropdownMenuItem({Text(label)},{export=false;action("export.prepare",obj("format" to format))})};paper.sourceURL?.takeIf{publicShareURL(it)}?.let{url->DropdownMenuItem({Text("分享论文来源…")},{export=false;try{readerContext.startActivity(android.content.Intent.createChooser(android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain").putExtra(android.content.Intent.EXTRA_SUBJECT,paper.title).putExtra(android.content.Intent.EXTRA_TEXT,publicShareText(paper.title,url)),"分享论文来源"))}catch(e:Exception){pdfError="此设备没有可处理文本分享的应用"}})}
 DropdownMenuItem({Text("保存完整离线研究包")},{export=false;action("storage.prepare",JSONObject())});if(state.article!=null)DropdownMenuItem({Text("打印图文导读…")},{export=false;scope.launch{try{printPaper(readerContext,paper.titleZh,ResearchRenderer.renderArticle(readerContext,state.article))}catch(e:Exception){pdfError=e.message}}});DropdownMenuItem({Text("存档到 Zotero…")},{export=false;zotero=true})}}
 }
 if(state.pdfMode){Text("已打开 PDF：${state.pdfReceipt.optString("version").ifBlank{"原版本未标注"}} · ${state.pdfDocument?.sha256?.take(12).orEmpty()}",Modifier.padding(horizontal=16.dp),style=MaterialTheme.typography.labelSmall);if(state.pdfReceipt.optBoolean("isStale"))Text("此 PDF 为已保存的旧版本，未核对当前版本。",Modifier.padding(horizontal=16.dp),color=MaterialTheme.colorScheme.error);state.pdfReceipt.optJSONArray("notices")?.let{a->for(i in 0 until a.length())Text(a.optString(i),Modifier.padding(horizontal=16.dp),style=MaterialTheme.typography.labelSmall)}}
 pdfError?.let{Text(it,Modifier.padding(horizontal=16.dp),color=MaterialTheme.colorScheme.error)}
 if(paper.id in state.catalogSummary.ids("missingFromLatest"))Surface(color=MaterialTheme.colorScheme.primaryContainer,modifier=Modifier.fillMaxWidth()){Text("本机保留的先前资料，未列入最新网站快照；这不等于论文撤稿。",Modifier.padding(horizontal=16.dp,vertical=8.dp),style=MaterialTheme.typography.labelSmall)}
 state.article?.let{a->val tone=noticeTone(a);val color=when(tone){"error"->MaterialTheme.colorScheme.errorContainer;"warning"->MaterialTheme.colorScheme.tertiaryContainer;else->MaterialTheme.colorScheme.primaryContainer};if(a.isStale)Surface(color=color,modifier=Modifier.fillMaxWidth()){Text("正在读取先前保存的版本；尚未核对当前发布。",Modifier.padding(horizontal=16.dp,vertical=8.dp),style=MaterialTheme.typography.labelSmall)};a.notices.forEach{Surface(color=color,modifier=Modifier.fillMaxWidth()){Text(it,Modifier.padding(horizontal=16.dp,vertical=8.dp),style=MaterialTheme.typography.labelSmall)}}}
 Row(Modifier.padding(horizontal=16.dp).horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)){listOf("导读","研究","笔记").forEach{FilterChip(tab==it,{tab=it;phonePDF=false},label={Text(it)})};if(state.pdfMode)FilterChip(phonePDF,{phonePDF=!phonePDF},label={Text("PDF")});TextButton({val u=android.net.Uri.parse(paper.sourceURL?:paper.blogURL);if(u.scheme=="https"&&u.host!=null&&u.userInfo==null)runCatching{readerContext.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW,u))}}){Text("来源")};TextButton({action("paper.open",obj("paperID" to paper.id,"refresh" to true))}){Text("刷新")}}
 BoxWithConstraints(Modifier.weight(1f)){
 val split=state.pdfMode&&state.pdfDocument!=null&&maxWidth>=840.dp
 Row(Modifier.fillMaxSize()){
 if(!state.pdfMode||split||!phonePDF)Box(Modifier.weight(1f).fillMaxHeight()){tabStates.SaveableStateProvider(tab){when(tab){"导读"->if(state.article!=null)ArticleDocument(state.article,state.settings.optInt("font",18),guideScroll,{guideScroll=it})else EmptyPane("导读尚未载入","本地 PDF 可直接开始研究；公开导读可在联网后同步。");"研究"->ResearchPane(state,controller,action);else->NotesPane(state,controller,action)}}}
 if(state.pdfMode&&state.pdfDocument!=null&&(split||phonePDF)){if(split)VerticalDivider();PdfReaderPane(state.pdfDocument,state.pdfPage,{action("pdf.page",obj("page" to it,"paperID" to paper.id,"pdfSHA" to state.pdfDocument.sha256))},{selection->scope.launch{try{controller.updatePdfSelection(selection)}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;pdfError=e.message}}},Modifier.weight(1f).fillMaxHeight(),{pdfError=it},onSaveAnnotation={selection,note->controller.updatePdfSelection(selection);controller.execute("pdf.highlight",obj("comment" to note));Unit},annotationRevision=state.personal.optJSONObject("annotations")?.optJSONArray(paper.id)?.toString().orEmpty(),portableAnnotations=(state.personal.optJSONObject("annotations")?.rows(paper.id)?:emptyList()).filter{it.optString("pdfSHA")==state.pdfDocument.sha256})}
 }
 }
 }
 if(showPaperInfo)AlertDialog(onDismissRequest={showPaperInfo=false},title={Text("论文信息")},text={SelectionContainer{Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(10.dp)){Text(paper.titleZh,style=MaterialTheme.typography.titleMedium);if(paper.title!=paper.titleZh)Text(paper.title);Text(paper.authors.joinToString(" · "));Text("目录日期：${paper.date.ifBlank{"未标注"}}\n打开时目录版本：${paper.sourceVersion?:"未标注"}\n当前目录版本：${latestCatalog?.sourceVersion?:"未标注"}\n来源编号：${paper.id}");paper.score?.let{Text("目录原评分：$it / 10（完整量表见原导读）")};paper.citation.optString("doi").takeIf{it.isNotBlank()}?.let{Text("DOI：$it")};Text("当前导读版本：${state.article?.sourceVersion?:"未标注"}");if(state.pdfMode)Text("当前PDF原版本：${state.pdfReceipt.optString("version").ifBlank{"未标注"}}")}}},confirmButton={TextButton({showPaperInfo=false}){Text("关闭")}})
 if(zotero)ZoteroArchiveDialog(state,action,{zotero=false})
}

@Composable private fun ResearchPane(state:UiState,controller:AppController,action:Action){
 val context=LocalContext.current;val id=state.selectedPaperId.orEmpty()
 val reading=state.personal.optJSONObject("readingState")?.optJSONObject(id)?:JSONObject()
 var question by rememberSaveable(id){mutableStateOf(reading.optString("question"))};var evidence by rememberSaveable(id){mutableStateOf(reading.optString("scope","guide"))};var from by rememberSaveable(id){mutableStateOf(reading.optInt("from",reading.optInt("fromPage",1)).toString())};var to by rememberSaveable(id){mutableStateOf(reading.optInt("to",reading.optInt("toPage",1)).toString())}
 var chapter by rememberSaveable(id){mutableIntStateOf(reading.optInt("chapter",0))}
 var chapters by remember(state.pdfDocument?.sha256){mutableStateOf<List<JSONObject>>(emptyList())};var chapterLoading by remember{mutableStateOf(false)};var chapterError by remember{mutableStateOf<String?>(null)};var chapterMenu by remember{mutableStateOf(false)};val chapterScope=rememberCoroutineScope()
 LaunchedEffect(question,evidence,from,to,chapter){delay(600);action("personal.reading",obj("paperID" to id,"question" to question,"scope" to evidence,"from" to from.toIntOrNull(),"to" to to.toIntOrNull(),"chapter" to chapter))}
 var chosen by rememberSaveable(id){mutableStateOf<String?>(null)}
 val sessions=recordsNewest(state.sessions.filter{it.optString("paperID")==id});val session=sessions.find{it.optString("id")==chosen}?:sessions.firstOrNull()
 var html by remember(session?.toString()){mutableStateOf<String?>(null)};var renderError by remember(session?.toString()){mutableStateOf<String?>(null)}
 LaunchedEffect(session?.toString()){if(session!=null)try{html=ResearchRenderer.render(context,session.optString("answer",session.optString("text")));renderError=null}catch(e:Exception){renderError=e.message}}
 Column(Modifier.fillMaxSize()){
 Column(Modifier.weight(1f,fill=false).verticalScroll(rememberScrollState()).padding(16.dp)){
 OutlinedTextField(question,{question=it.take(16000)},Modifier.fillMaxWidth(),label={Text("向这篇论文提问")},placeholder={Text("例如：这项方法依赖哪些假设？")},minLines=2,maxLines=6)
 Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(4.dp)){listOf("guide" to "导读","selection" to "选区","page" to "当前页","chapter" to "章节","range" to "页段","full" to "全文").forEach{(v,l)->FilterChip(evidence==v,{evidence=v},label={Text(l)})}}
 Text(if(evidence=="guide")"导读证据：${state.article?.sourceVersion?:"版本未标注"} · ${state.article?.revisionSHA256?.take(12).orEmpty()}" else "PDF 证据：${state.pdfReceipt.optString("version").ifBlank{"原版本未标注"}} · ${state.pdfDocument?.sha256?.take(12).orEmpty()} · 物理页",style=MaterialTheme.typography.labelSmall)
 if(evidence=="chapter"){
  Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
   OutlinedButton({val sha=state.pdfDocument?.sha256;if(sha!=null){chapterLoading=true;chapterError=null;chapterScope.launch{try{val result=controller.execute("pdf.outline");require(result.optString("pdfSHA")==sha&&controller.state.value.selectedPaperId==id&&controller.state.value.pdfDocument?.sha256==sha){"原文已切换，未采用旧目录"};chapters=result.rows("chapters");if(chapters.isEmpty())chapterError="此原件没有可用目录；请选择明确页段，不按博客标题推断章节。"}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;chapterError=e.message}finally{chapterLoading=false}}}},enabled=state.pdfDocument!=null&&!chapterLoading&&!state.busy){Text(if(chapterLoading)"正在读取目录…" else "读取原 PDF 目录")}
   Box{TextButton({chapterMenu=true},enabled=chapters.isNotEmpty()){Text(chapters.firstOrNull{it.optInt("index")==chapter}?.optString("title")?:"选择真实章节")};DropdownMenu(chapterMenu,{chapterMenu=false}){chapters.forEach{entry->DropdownMenuItem({Text("${entry.optString("title")} · 物理页 ${entry.optInt("page")}–${entry.optInt("endPage")}")},{chapter=entry.optInt("index");chapterMenu=false})}}}
  }
  chapterError?.let{Text(it,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.labelSmall)}
 }
 if(evidence !in listOf("guide","selection","page","chapter","range","full"))Text("原记录的证据范围为 $evidence；请先明确选择 Android 当前可用的原文范围，未自动改用其他材料。",color=MaterialTheme.colorScheme.error)
 if(evidence=="range")Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){OutlinedTextField(from,{from=it.filter(Char::isDigit)},Modifier.weight(1f),label={Text("起始物理页")});OutlinedTextField(to,{to=it.filter(Char::isDigit)},Modifier.weight(1f),label={Text("结束物理页")})}
 Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("仅点击发送才调用模型 · 用量据实记录",style=MaterialTheme.typography.labelSmall,modifier=Modifier.weight(1f));Button({action("model.run",obj("question" to question,"evidenceKind" to evidence,"fromPage" to from.toIntOrNull(),"toPage" to to.toIntOrNull(),"chapter" to chapter,"force" to false))},enabled=question.isNotBlank()&&!state.busy&&evidence in listOf("guide","selection","page","chapter","range","full")&&(evidence!="chapter"||chapters.any{it.optInt("index")==chapter})){Icon(Icons.Outlined.Send,null);Text("发送")}}
 if(sessions.isNotEmpty()){var menu by remember{mutableStateOf(false)};Box{TextButton({menu=true}){Text("研究记录 ${sessions.size} · ${session?.optString("question").orEmpty().take(30)}")};DropdownMenu(menu,{menu=false}){sessions.forEach{s->DropdownMenuItem({Text(s.optString("question").take(70))},{chosen=s.optString("id");menu=false})}}}}
 session?.let{s->Text("${jobStatus(s.optString("status"))} · ${s.optJSONObject("usage")?.toString()?:"用量未记录"}",style=MaterialTheme.typography.labelSmall);Text("金额以原记录为准，未知不表示免费。",style=MaterialTheme.typography.labelSmall)}
 }
 when{renderError!=null->Text(renderError!!,Modifier.padding(16.dp));html!=null->Box(Modifier.weight(1f)){StaticDocument(html!!)};else->EmptyPane("让阅读形成研究记录","每次回答关联实际输入、来源页码和原始用量，可完整导出。")}
 }
}

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
 annotationGroups(state.personal.optJSONObject("annotations")?.rows(id)?:emptyList()).forEach{group->val a=group.first();OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(14.dp)){Text(group.map{it.optString("text")}.filter{it.isNotBlank()}.distinct().joinToString("\n"));Text(group.map{it.optString("comment",it.optString("note"))}.filter{it.isNotBlank()}.distinct().joinToString("\n"));Text("${group.size} 个原页位置",style=MaterialTheme.typography.labelSmall);Row{TextButton({action("pdf.annotation.open",obj("id" to a.optString("id")))}){Text("回到原文")};TextButton({edit=a;editText=group.map{it.optString("comment",it.optString("note"))}.filter{it.isNotBlank()}.distinct().joinToString("\n")}){Text("编辑批注…")};TextButton({removeCount=group.size;remove=a}){Text("删除标注…")}}}}}
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
