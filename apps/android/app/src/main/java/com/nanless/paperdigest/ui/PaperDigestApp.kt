package com.nanless.paperdigest.ui

import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nanless.paperdigest.data.ExportService
import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.pdf.PdfReaderPane
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

internal typealias Action = (String, JSONObject) -> Unit
internal fun obj(vararg pairs: Pair<String, Any?>) = JSONObject().apply { pairs.forEach { (k,v) -> put(k,v ?: JSONObject.NULL) } }
internal fun JSONObject.rows(key:String):List<JSONObject> = optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } } ?: emptyList()
internal fun JSONObject.ids(key:String):List<String> = optJSONArray(key)?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun PaperDigestApp(controller: AppController) {
    val state by controller.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope(); val context = LocalContext.current
    var route by rememberSaveable { mutableStateOf("library") }
    var selectedSessionID by rememberSaveable{mutableStateOf<String?>(null)}
    var settingsPaneRequest by rememberSaveable{mutableStateOf<String?>(null)}
    var settingsRequestID by rememberSaveable{mutableIntStateOf(0)}
    var localError by remember { mutableStateOf<String?>(null) }
    var exportID by rememberSaveable { mutableStateOf<String?>(null) }
    var exportMime by remember { mutableStateOf("application/octet-stream") }
    var preparedRestoreJSON by rememberSaveable { mutableStateOf<String?>(null) }
    val preparedRestore=preparedRestoreJSON?.let{JSONObject(it)}
    var restoreBusy by remember{mutableStateOf(false)}
    var restoreError by rememberSaveable{mutableStateOf<String?>(null)}
    val pendingActions=remember{mutableStateMapOf<String,Boolean>()}
    var restoreCommand by rememberSaveable { mutableStateOf("app.restore.commit") }
    val snackbar = remember { SnackbarHostState() }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uri = if(result.resultCode == android.app.Activity.RESULT_OK) result.data?.data else null
        val id = exportID; exportID = null
        if (uri != null && id != null) scope.launch { try { val receipt=controller.execute("export.save",obj("uri" to uri.toString(),"documentID" to id)); snackbar.showSnackbar(exportSaveFeedback(receipt)) } catch(e:CancellationException){throw e} catch(e:Exception){localError=e.message} }
    }
    val action: Action = action@{ command,payload ->
        if(command.endsWith("restore.prepare")&&preparedRestoreJSON!=null){localError="请先确认或取消已校验的恢复材料";return@action}
        val guarded=command in setOf("pdf.open","library.sync","storage.prepare","export.prepare","retained.export.prepare","cloud.restore.prepare","app.restore.prepare","zotero.prepare","zotero.archive","zotero.resume","cloud.upload","cloud.check","zotero.check")
        if(guarded&&pendingActions[command]==true)return@action
        if(guarded)pendingActions[command]=true
        scope.launch {
        try {
            when(command) {
                "ui.reader" -> route="reader"
                "ui.tasks" -> route="tasks"
                "ui.session.open" -> {val id=payload.getString("id");require(state.sessions.any{it.optString("id")==id}){"原研究记录不存在"};selectedSessionID=id;route="session"}
                "ui.settings" -> {settingsPaneRequest=payload.optString("pane").takeIf{it in listOf("阅读","模型","资料","坚果云","Zotero")};settingsRequestID++;route="settings"}
                else -> {
                    val result=controller.execute(command,payload)
                    if(command=="paper.open" || command=="pdf.import" || command=="storage.openPackage") route="reader"
                    if(command=="export.prepare" || command=="retained.export.prepare") {
                        exportID=result.getString("documentID"); exportMime=result.getString("mime"); save.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(exportMime).putExtra(Intent.EXTRA_TITLE,result.getString("suggestedName")))
                    }
                    if(command.endsWith("restore.prepare")) { preparedRestoreJSON=result.toString();restoreError=null; restoreCommand=if(command.startsWith("cloud")) "cloud.restore.commit" else "app.restore.commit" }
                }
            }
        } catch(e:CancellationException) { throw e } catch(e:Exception){localError=e.message ?: "操作未完成，已有资料保留"}finally{if(guarded)pendingActions.remove(command)}
    } }
    val importPDF=rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()){uris ->
        if(uris.isNotEmpty())scope.launch{val errors=mutableListOf<String>();for(uri in uris){try{controller.execute("pdf.import",obj("uri" to uri.toString()))}catch(e:CancellationException){throw e}catch(e:Exception){errors+=e.message?:"导入未完成"}};route="reader";if(errors.isNotEmpty())localError="${errors.size} 份 PDF 未导入：${errors.distinct().joinToString("；")}"}
    }
    val restore=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()){uri -> if(uri!=null)action("app.restore.prepare",obj("uri" to uri.toString()))}
    val dark=when(state.settings.optString("appearance")){"dark"->true;"light"->false;else->androidx.compose.foundation.isSystemInDarkTheme()}
    SideEffect{
        var host:android.content.Context=context
        while(host is android.content.ContextWrapper&&host !is android.app.Activity)host=host.baseContext
        (host as? android.app.Activity)?.let{activity->androidx.core.view.WindowCompat.getInsetsController(activity.window,activity.window.decorView).apply{isAppearanceLightStatusBars=!dark;isAppearanceLightNavigationBars=!dark}}
    }
    val savedScreens=rememberSaveableStateHolder()
    val scheme=paperColorScheme(dark)
    MaterialTheme(colorScheme=scheme) {
        val tabs=listOf("library" to "文献","reader" to "阅读","tasks" to "任务","settings" to "设置")
        val icons=listOf(Icons.Outlined.LibraryBooks,Icons.Outlined.MenuBook,Icons.Outlined.Checklist,Icons.Outlined.Settings)
        BackHandler(route!="library"){route=if(route=="session")"tasks" else "library"}
        BoxWithConstraints(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            val wide=maxWidth>=840.dp
            Row(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                if(wide) NavigationRail { Spacer(Modifier.height(24.dp)); Text("论文\n速递",fontWeight=FontWeight.Bold,modifier=Modifier.padding(16.dp)); tabs.forEachIndexed {i,t->NavigationRailItem((route==t.first||(route=="session"&&t.first=="reader")),{route=t.first},{Icon(icons[i],t.second)},label={Text(t.second)})} }
                Scaffold(Modifier.weight(1f),snackbarHost={SnackbarHost(snackbar)},bottomBar={if(!wide)NavigationBar { tabs.forEachIndexed{i,t->NavigationBarItem((route==t.first||(route=="session"&&t.first=="reader")),{route=t.first},{Icon(icons[i],t.second)},label={Text(t.second)})} }}) { padding ->
                    Column(Modifier.fillMaxSize().padding(padding)) {
                        if(state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                        state.storageWarning?.let{warning->
                            Surface(color=MaterialTheme.colorScheme.tertiaryContainer,modifier=Modifier.fillMaxWidth()){
                                Column(Modifier.padding(12.dp)){
                                    Text(warning)
                                    TextButton({action("ui.settings",obj("pane" to "资料"))}){Text("前往资料，导出完整备份")}
                                }
                            }
                        }

                        (localError ?: state.error)?.let { message -> Surface(color=MaterialTheme.colorScheme.errorContainer,modifier=Modifier.fillMaxWidth()) { Row(Modifier.padding(12.dp)){Text(message,Modifier.weight(1f));TextButton({localError=null;action("app.bootstrap",JSONObject())}){Text("重新载入")}} }}
                        savedScreens.SaveableStateProvider(if(route=="reader")"reader-${state.selectedPaperId}" else route){when(route){
                            "library" -> LibraryPane(state,controller,action,{importPDF.launch(arrayOf("application/pdf"))})
                            "reader" -> ReaderPane(state,controller,action)
                            "tasks" -> TasksPane(state,action)
                            "session" -> SessionPane(state,selectedSessionID,controller,action)
                            "settings" -> SettingsPane(state,controller,action,{restore.launch(arrayOf("application/octet-stream","*/*"))},settingsPaneRequest,settingsRequestID)
                        }}
                    }
                }
            }
        }
        preparedRestore?.let { prepared ->
            fun cancelRestore(){if(!restoreBusy){action("restore.discard",obj("restoreID" to prepared.optString("restoreID")));preparedRestoreJSON=null;restoreError=null}}
            AlertDialog(onDismissRequest={cancelRestore()},title={Text("恢复完整研究资料？")},text={Column(verticalArrangement=Arrangement.spacedBy(10.dp)){
                Text(prepared.optString("message","将以已校验快照替换研究资料。当前资料会先保留恢复前副本；本机连接与密钥独立保留。")+"\n实际文件：${prepared.optInt("fileCount")}")
                restoreError?.let{Text(it,color=MaterialTheme.colorScheme.error)}
                if(restoreBusy)LinearProgressIndicator(Modifier.fillMaxWidth())
            }},confirmButton={TextButton({
                restoreBusy=true;restoreError=null
                val token=prepared.optString("restoreID")
                scope.launch{try{val restored=controller.execute(restoreCommand,obj("restoreID" to token));require(restored.optBoolean("restored")){"恢复尚未确认完成，原确认材料仍保留"};if(preparedRestoreJSON?.let{JSONObject(it).optString("restoreID")}==token)preparedRestoreJSON=null;snackbar.showSnackbar("完整研究资料已恢复")}catch(e:CancellationException){throw e}catch(e:Exception){restoreError=e.message?:"恢复未完成，原资料保留"}finally{restoreBusy=false}}
            },enabled=!restoreBusy&&!state.busy){Text(if(restoreBusy)"正在恢复…" else "确认恢复")}},dismissButton={TextButton({cancelRestore()},enabled=!restoreBusy){Text("取消")}})
        }
    }
}

@Composable internal fun SectionTitle(title:String,subtitle:String?=null,actions:@Composable RowScope.()->Unit={}) { Row(Modifier.fillMaxWidth().padding(horizontal=24.dp,vertical=18.dp),horizontalArrangement=Arrangement.spacedBy(12.dp)){Column(Modifier.weight(1f)){Text(title,style=MaterialTheme.typography.headlineMedium,fontWeight=FontWeight.SemiBold);subtitle?.let{Text(it,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)}};actions()} }
@Composable internal fun EmptyPane(title:String,text:String){Column(Modifier.fillMaxWidth().padding(32.dp)){Icon(Icons.Outlined.AutoStories,null,Modifier.size(44.dp),MaterialTheme.colorScheme.primary);Spacer(Modifier.height(20.dp));Text(title,style=MaterialTheme.typography.titleLarge);Text(text,Modifier.padding(top=8.dp),color=MaterialTheme.colorScheme.onSurfaceVariant)}}
@Composable internal fun LibraryPane(state:UiState,controller:AppController,action:Action,importPDF:()->Unit){
 var source by rememberSaveable{mutableStateOf("")};var task by rememberSaveable{mutableStateOf("")};var method by rememberSaveable{mutableStateOf("")};var minimum by rememberSaveable{mutableStateOf("")};var choosing by rememberSaveable{mutableStateOf(false)};var picked by rememberSaveable{mutableStateOf(listOf<String>())}
 var query by rememberSaveable{mutableStateOf("")};var filter by rememberSaveable{mutableStateOf("全部")};var sort by rememberSaveable{mutableStateOf("最新")}
 val selected=remember(state.personal,filter){when(filter){"收藏"->state.personal.ids("favorites").toSet();"待读"->state.personal.ids("reading").toSet();else->emptySet<String>()}}
 val notes=if(query.isBlank())null else state.personal.optJSONObject("notes")
 var searchRetry by remember{mutableIntStateOf(0)}
 val cacheIdentity=remember(state.catalogSyncedAt,state.offlinePaperIDs){state.catalogSyncedAt to state.offlinePaperIDs}
 val cachedSearch=rememberCachedGuideSearch(controller,query,searchRetry,cacheIdentity)
 val cachedIDs=cachedSearch.result?.paperIDs?:emptySet()
 val catalogIDs=remember(state.papers){state.papers.mapTo(HashSet()){it.id}}
 val unknownCached=remember(catalogIDs,cachedIDs){cachedIDs.count{it !in catalogIDs}}
 val papers=remember(state.papers,source,task,method,minimum,filter,sort,query,selected,notes,state.offlinePaperIDs,cachedIDs){
  val score=minimum.toDoubleOrNull()?:0.0
  state.papers.filter{paper->(source.isEmpty()||paper.sourceKind==source)&&(task.isEmpty()||paper.task==task)&&(method.isEmpty()||paper.method==method)&&(minimum.isEmpty()||(paper.score?:-1.0)>=score)&&(filter !in listOf("收藏","待读")||paper.id in selected)&&(filter!="离线"||paper.id in state.offlinePaperIDs)&&(matchesLibrarySearch(paper,query,notes)||paper.id in cachedIDs)}.let{if(sort=="评分")it.sortedByDescending{p->p.score?:-1.0}else it.sortedByDescending{p->p.date}}
 }
 val options=remember(state.papers){Triple(state.papers.map{it.sourceKind}.distinct().sorted(),state.papers.map{it.task}.filter{it.isNotBlank()}.distinct().sorted(),state.papers.map{it.method}.filter{it.isNotBlank()}.distinct().sorted())}
 val localCount=remember(state.papers){state.papers.count{it.sourceKind=="local"}}
 val missingFromLatest=remember(state.catalogSummary){state.catalogSummary.ids("missingFromLatest").toSet()}
 Column(Modifier.fillMaxSize()){
 SectionTitle("文献资料库","每天的新论文，和你的长期研究"){IconButton(importPDF){Icon(Icons.Outlined.FileOpen,"导入 PDF")};IconButton({action("library.sync",JSONObject())},enabled=!state.loading){Icon(Icons.Outlined.Sync,"同步已发布内容")}}
 Text(catalogMessage(state.catalogSummary,localCount),Modifier.padding(horizontal=24.dp,vertical=6.dp),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
 OutlinedTextField(query,{query=it},Modifier.fillMaxWidth().padding(horizontal=24.dp),singleLine=true,placeholder={Text("搜索论文信息、笔记与本机已缓存导读")},leadingIcon={Icon(Icons.Outlined.Search,null)})
 if(query.isNotBlank())Column(Modifier.fillMaxWidth().padding(horizontal=24.dp,vertical=6.dp)){
  val searchMessage=when{
   cachedSearch.loading->"正在补充检索本机已缓存导读；论文信息与笔记结果先显示。"
   cachedSearch.error!=null->"缓存检索未完成：${cachedSearch.error}"
   cachedSearch.result!=null->{val result=cachedSearch.result;buildString{
    append(if(result.scanned==0)"尚无可检索的已保存导读；当前只匹配论文信息与笔记。" else "已检查 ${result.scanned} 份本机缓存导读，命中 ${result.paperIDs.size} 篇；不包含未下载正文或 PDF 全文。")
    if(result.unavailable>0)append(" 另有 ${result.unavailable} 份缓存暂不可读或身份不匹配，尚未确认其中是否命中。")
    if(unknownCached>0)append(" 其中 $unknownCached 个命中缺少当前论文目录信息，原缓存仍保留。")
   }}
   else->"当前匹配论文信息与笔记。"
  }
  Text(searchMessage,style=MaterialTheme.typography.bodySmall,color=if(cachedSearch.error!=null)MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
  if(cachedSearch.error!=null&&query.length<=256)TextButton({searchRetry++}){Text("重试本机导读检索")}
 }
 Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal=20.dp,vertical=8.dp),horizontalArrangement=Arrangement.spacedBy(6.dp)){listOf("全部","收藏","待读","离线").forEach{FilterChip(filter==it,{filter=it},label={Text(it)})};TextButton({sort=if(sort=="最新")"评分" else "最新"}){Text(sort)};TextButton({choosing=!choosing;if(!choosing)picked=emptyList()}){Text(if(choosing)"完成多选" else "多选")}}
 Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal=20.dp),horizontalArrangement=Arrangement.spacedBy(8.dp)){
 FilterChoice("来源",options.first,source,{source=it})
 FilterChoice("任务",options.second,task,{task=it})
 FilterChoice("方法",options.third,method,{method=it})
 FilterChoice("最低评分",listOf("7","8","9"),minimum,{minimum=it})
 }
 if(choosing)Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal=20.dp),horizontalArrangement=Arrangement.spacedBy(8.dp)){
 TextButton({picked=papers.map{it.id}}){Text("选择匹配 ${papers.size} 篇")}
 TextButton({action("personal.setList",obj("key" to "favorites","ids" to JSONArray((state.personal.ids("favorites")+picked).distinct())))},enabled=picked.isNotEmpty()){Text("收藏 ${picked.size} 篇")}
 TextButton({action("personal.setList",obj("key" to "reading","ids" to JSONArray((state.personal.ids("reading")+picked).distinct())))},enabled=picked.isNotEmpty()){Text("加入待读")}
 }
 if(papers.isEmpty())EmptyPane(if(cachedSearch.loading)"正在查找本机导读" else if(cachedSearch.error!=null)"论文信息与笔记暂未匹配" else "这里还没有匹配的论文",if(query.isNotBlank())"当前筛选下未显示论文；缓存检查范围与未完成项见上方说明。" else "同步已发布资料，或导入本地 PDF。同步读取已有分析，不会重复请求模型。")
 LazyColumn(contentPadding=PaddingValues(start=20.dp,end=20.dp,bottom=24.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){items(papers,key={it.id}){paper->ElevatedCard(onClick={if(choosing)picked=if(paper.id in picked)picked-paper.id else picked+paper.id else action("paper.open",obj("paperID" to paper.id))},Modifier.fillMaxWidth()){Column(Modifier.padding(18.dp)){Row{if(choosing)Checkbox(paper.id in picked,{checked->picked=if(checked)(picked+paper.id).distinct()else picked-paper.id});Text(paper.date,style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.primary);Spacer(Modifier.weight(1f));paper.score?.let{Text("$it 分",style=MaterialTheme.typography.labelLarge)}};if(paper.id in missingFromLatest)Text("未列入最新网站快照，保留本机资料（不表示撤稿）",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.tertiary);Text(paper.titleZh,style=MaterialTheme.typography.titleMedium,fontWeight=FontWeight.SemiBold,modifier=Modifier.padding(vertical=8.dp));if(paper.titleZh!=paper.title)Text(paper.title,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant);Text(paper.authors.take(3).joinToString(" · "),style=MaterialTheme.typography.bodySmall,modifier=Modifier.padding(top=8.dp));Text(listOf(paper.task,paper.method,paper.sourceVersion?:paper.sourceKind).filter{it.isNotBlank()}.joinToString("  ·  "),style=MaterialTheme.typography.labelSmall,modifier=Modifier.padding(top=8.dp))}}}}
 }
}

@Composable internal fun StaticDocument(body:String,fontSize:Int=18,initialScroll:Int=0,onScroll:(Int)->Unit={}){
 val context=LocalContext.current
 val scrollValue=rememberUpdatedState(initialScroll);val scrollCallback=rememberUpdatedState(onScroll)
 val restoring=remember{java.util.concurrent.atomic.AtomicBoolean(true)}
 val activeView=remember{java.util.concurrent.atomic.AtomicReference<WebView?>(null)}
 val activeDocument=remember{java.util.concurrent.atomic.AtomicReference<StreamedHtmlDocument?>(null)}
 val background=MaterialTheme.colorScheme.surface.toArgb();val foreground=MaterialTheme.colorScheme.onSurface.toArgb();val link=MaterialTheme.colorScheme.primary.toArgb()
 val zoom=(fontSize.coerceIn(14,30)/18f*LocalDensity.current.fontScale*100).toInt().coerceAtLeast(50)
 // The shared head is small; body remains the immutable renderer result, never concatenated/replaced.
 val document=remember(body,background,foreground,link){StreamedHtmlDocument(ExportService.htmlDocumentHead("",background,foreground,link),body,"</body></html>")}
 AndroidView(factory={WebView(it).apply {
  activeView.set(this)
  outlineProvider=android.view.ViewOutlineProvider.BOUNDS;clipToOutline=true
  settings.apply{javaScriptEnabled=false;allowFileAccess=false;allowContentAccess=false;blockNetworkLoads=true;domStorageEnabled=false;builtInZoomControls=true;displayZoomControls=false;if(android.os.Build.VERSION.SDK_INT>=33)setAlgorithmicDarkeningAllowed(false) else if(android.os.Build.VERSION.SDK_INT>=29)forceDark=android.webkit.WebSettings.FORCE_DARK_OFF}
  setOnScrollChangeListener { _,_,y,_,_->if(activeView.get()===this&&!restoring.get()&&tag===activeDocument.get())scrollCallback.value(y) }
  webViewClient=object:WebViewClient(){
   override fun onPageFinished(view:WebView?,url:String?){
    val web=view?:return
    val owner=activeDocument.get()?:return
    if(activeView.get()!==web||url==null||!owner.mayNavigateWithin(url)||web.tag!==owner||!restoring.get())return
    web.post{
     if(activeView.get()===web&&activeDocument.get()===owner&&web.tag===owner&&owner.mayNavigateWithin(web.url)){
      web.scrollTo(0,scrollValue.value.coerceAtLeast(0))
      web.post{if(activeView.get()===web&&activeDocument.get()===owner&&web.tag===owner)restoring.set(false)}
     }
    }
   }
   override fun shouldOverrideUrlLoading(view:WebView?,request:WebResourceRequest?):Boolean {
    if(activeView.get()!==view)return true
    val u=request?.url?:return true
    if(activeDocument.get()?.mayNavigateWithin(u.toString())==true)return false
    if(u.host=="reader.invalid")return true
    if(u.scheme=="https"&&u.host!=null&&u.userInfo==null){runCatching{context.startActivity(Intent(Intent.ACTION_VIEW,u))}}
    return true
   }
   override fun shouldInterceptRequest(view:WebView?,request:WebResourceRequest?):WebResourceResponse? {
    val u=request?.url?:return WebResourceResponse("text/plain","utf-8",403,"Forbidden",emptyMap(),ByteArrayInputStream(byteArrayOf()))
    if(u.scheme=="data"||u.scheme=="about")return null
    val owner=activeDocument.get()
    if(activeView.get()===view&&owner!=null&&owner.canServe(u.toString(),request.isForMainFrame,request.method)){
     return WebResourceResponse("text/html","utf-8",200,"OK",mapOf("Cache-Control" to "no-store","X-Content-Type-Options" to "nosniff"),owner.openStream())
    }
    return WebResourceResponse("text/plain","utf-8",403,"Forbidden",emptyMap(),ByteArrayInputStream(byteArrayOf()))
   }
  }
 }},update={web->
  activeView.set(web)
  web.setBackgroundColor(background)
  if(web.settings.textZoom!=zoom)web.settings.textZoom=zoom
  if(web.tag!==document){
   restoring.set(true);web.stopLoading();activeDocument.set(document);web.tag=document;web.loadUrl(document.url)
  }
 },onRelease={web->if(activeView.compareAndSet(web,null))activeDocument.set(null);web.stopLoading();web.tag=null;web.destroy()},modifier=Modifier.fillMaxSize().clipToBounds())
}

@Composable private fun FilterChoice(label:String,options:List<String>,value:String,change:(String)->Unit){
 var open by remember{mutableStateOf(false)}
 Box{OutlinedButton({open=true}){Text(if(value.isEmpty())label else "$label：$value")};DropdownMenu(open,{open=false}){DropdownMenuItem({Text("全部")},{change("");open=false});options.forEach{option->DropdownMenuItem({Text(option)},{change(option);open=false})}}}
}

internal fun catalogMessage(summary:JSONObject,localCount:Int):String {
 val saved=summary.optString("syncedAt").takeUnless{it.isBlank()||it=="null"}
 val base=if(summary.optString("snapshotID")=="bundled-sample"||summary.optString("source").contains("应用内已发布样稿"))"应用内已发布样稿，尚未全站同步" else if(saved!=null&&summary.has("paperCount")&&summary.has("recordCount"))"已保存网站快照：${summary.optInt("paperCount")} 篇论文 · ${summary.optInt("recordCount")} 条页面记录\n上次完整同步：$saved" else "尚未确认全站同步，目录状态待读"
 return base+if(localCount>0)" · 另有 $localCount 篇本地导入" else ""
}

/** Empty-query progress recompositions never stringify the full catalog or private notes. */
internal fun matchesLibrarySearch(paper:Paper,query:String,notes:JSONObject?):Boolean {
 val needle=query.trim()
 if(needle.isEmpty())return true
 if(paper.id.contains(needle,true)||paper.title.contains(needle,true)||paper.titleZh.contains(needle,true)||paper.task.contains(needle,true)||paper.method.contains(needle,true)||paper.date.contains(needle,true)||paper.sourceKind.contains(needle,true))return true
 if(paper.authors.any{it.contains(needle,true)}||paper.tags.any{it.contains(needle,true)})return true
 if(notes?.optJSONObject(paper.id)?.optString("text").orEmpty().contains(needle,true))return true
 return paper.appearances.any{it.contains(needle,true)}
}

/** A successful write alone does not prove the destination copy or grant cleanup eligibility. */
internal fun exportSaveFeedback(receipt:JSONObject):String {
 val native=(receipt.opt("message") as? String)?.takeIf{it.isNotBlank()}
 return if(receipt.opt("saved")==true&&receipt.opt("verified")==true)native?:"文件已保存，并完成原件回读核验。"
 else "完整保存尚未核验。"+(native?:"所选位置的写出或完整回读未确认；临时副本保留，请检查原文件。")
}
