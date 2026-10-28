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
import com.nanless.paperdigest.data.AggregateImageAccess
import com.nanless.paperdigest.data.ExportService
import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.pdf.PdfReaderPane
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

internal typealias Action = (String, JSONObject) -> Unit
internal typealias AggregateLinkAction = (String,Int,(JSONObject)->Unit)->Unit
internal typealias AggregateLinkCurrent = (String,Int)->Boolean
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
    var exportDeliveryJSON by rememberSaveable { mutableStateOf<String?>(null) }
    var preparedRestoreJSON by rememberSaveable { mutableStateOf<String?>(null) }
    val preparedRestore=preparedRestoreJSON?.let{JSONObject(it)}
    var restoreBusy by remember{mutableStateOf(false)}
    var restoreError by rememberSaveable{mutableStateOf<String?>(null)}
    val pendingActions=remember{mutableStateMapOf<String,Boolean>()}
    var restoreCommand by rememberSaveable { mutableStateOf("app.restore.commit") }
    val snackbar = remember { SnackbarHostState() }
    var routeRevision by remember { mutableLongStateOf(0) }
    val renderedRouteRevision=routeRevision
    val renderedAggregateLease=controller.captureAggregateView()
    fun navigateCurrent(next:String) {
        if(next==route)return
        if(route=="aggregates")controller.leaveAggregateView()
        if(next=="aggregates")controller.enterAggregateView()
        routeRevision++;route=next
    }
    DisposableEffect(controller){onDispose{controller.retireAggregateView()}}
    val action: Action = action@{ command,payload ->
        val viewSensitive=command.startsWith("aggregate.")||command.startsWith("ui.")||command in setOf("paper.open","storage.openPackage","pdf.studySource.open")
        if(viewSensitive&&(renderedRouteRevision!=routeRevision||(route=="aggregates"&&renderedAggregateLease!=controller.captureAggregateView())))return@action
        when(command) {
            "ui.reader" -> {navigateCurrent("reader");return@action}
            "ui.aggregates" -> {navigateCurrent("aggregates");return@action}
            "ui.library" -> {navigateCurrent("library");return@action}
            "ui.tasks" -> {navigateCurrent("tasks");return@action}
            "ui.session.open" -> {val id=payload.getString("id");if(state.sessions.none{it.optString("id")==id})return@action;selectedSessionID=id;navigateCurrent("session");return@action}
            "ui.settings" -> {settingsPaneRequest=payload.optString("pane").takeIf{it in listOf("阅读","模型","资料","坚果云","Zotero")};settingsRequestID++;navigateCurrent("settings");return@action}
        }
        if(command.endsWith("restore.prepare")&&preparedRestoreJSON!=null){localError="请先确认或取消已校验的恢复材料";return@action}
        val guarded=command.startsWith("export.retained.") || command in setOf("pdf.open","pdf.studySource.open","library.sync","storage.prepare","export.prepare","retained.export.prepare","export.delivery.prepare","export.pending.list","export.reconcile","cloud.restore.prepare","app.restore.prepare","zotero.prepare","zotero.archive","zotero.resume","cloud.upload","cloud.check","zotero.check")
        if(guarded&&pendingActions[command]==true)return@action
        if(guarded)pendingActions[command]=true
        scope.launch {
        try {
            if(viewSensitive&&(renderedRouteRevision!=routeRevision||(route=="aggregates"&&renderedAggregateLease!=controller.captureAggregateView())))return@launch
            when(command) {
                else -> {
                    val result=if(command.startsWith("aggregate."))controller.executeAggregateInView(command,payload,renderedAggregateLease)else controller.execute(command,payload)
                    if(command in setOf("paper.open","pdf.import","storage.openPackage","pdf.studySource.open")&&renderedRouteRevision==routeRevision&&result.optString("status")!="not-adopted"&&(command!="pdf.studySource.open"||result.optBoolean("opened")))navigateCurrent("reader")
                    if(command=="export.prepare" || command=="retained.export.prepare") {
                        require(result.optString("preparation")=="ready" && result.optBoolean("ready")) {"原件尚未就绪，请到任务查看真实进度"}
                        if(snackbar.showSnackbar("原件已准备，尚未保存到所选位置。",actionLabel="查看待保存") == SnackbarResult.ActionPerformed) navigateCurrent("tasks")
                    }
                    if(command=="export.delivery.cancel" || command=="export.retained.delivery.cancel") {
                        exportDeliveryJSON?.let{old->val claim=JSONObject(old);if(claim.optString("operationID")==payload.optString("operationID")&&claim.optString("attemptID")==payload.optString("attemptID"))exportDeliveryJSON=null}
                    }
                    if(command=="export.delivery.prepare" || command=="export.retained.prepare") {
                        require(exportDeliveryJSON==null) {"请先结束当前系统保存"}
                        require(result.optString("preparation")==if(command=="export.retained.prepare")"retained" else "ready") {"原件尚未取得本次保存许可"}
                        require(result.optString("delivery")=="choosing") {"原件尚未取得本次保存许可"}
                        result.getString("operationID");result.getString("attemptID")
                        exportDeliveryJSON=result.toString()
                    }
                    if(command.endsWith("restore.prepare")) { preparedRestoreJSON=result.toString();restoreError=null; restoreCommand=if(command.startsWith("cloud")) "cloud.restore.commit" else "app.restore.commit" }
                }
            }
        } catch(e:CancellationException) { throw e } catch(e:Exception){localError=e.message ?: "操作未完成，已有资料保留"}finally{if(guarded)pendingActions.remove(command)}
    } }
    val aggregateLinkCurrent:AggregateLinkCurrent={nonce,index->route=="aggregates"&&renderedRouteRevision==routeRevision&&renderedAggregateLease==controller.captureAggregateView()&&controller.aggregateLinkIsCurrent(nonce,index)}
    val aggregateLink:AggregateLinkAction=link@{nonce,index,reply->
        if(route!="aggregates"||renderedRouteRevision!=routeRevision||renderedAggregateLease!=controller.captureAggregateView())return@link
        scope.launch {
            try {
                if(route!="aggregates"||renderedRouteRevision!=routeRevision||renderedAggregateLease!=controller.captureAggregateView())return@launch
                val result=controller.executeAggregateInView("aggregate.link",obj("nonce" to nonce,"index" to index),renderedAggregateLease)
                if(renderedRouteRevision!=routeRevision||route!="aggregates")return@launch
                if(result.optString("kind")=="paper"&&result.optString("status")=="link-opened"&&controller.state.value.selectedPaperId==result.optString("paperID"))navigateCurrent("reader")
                else if(renderedAggregateLease==controller.captureAggregateView())reply(result)
            }catch(cancelled:CancellationException){throw cancelled}
            catch(error:Exception){if(renderedRouteRevision==routeRevision&&route=="aggregates")localError=error.message?:"链接未能打开，原网页保留。"}
        }
    }
    val importPDF=rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()){uris ->
        if(uris.isNotEmpty())try {
            // Transfer the whole picker result before a composition coroutine can be cancelled by rotation.
            val originalBatch=controller.importPdfs(uris.toList())
            scope.launch {try {
                val result=originalBatch.await()
                if(result.optInt("completed")>0)navigateCurrent("reader")
                if(result.optString("status")!="completed")localError=result.optString("message","所选 PDF 未全部接纳，请查看原批次记录")
            }catch(cancelled:CancellationException){throw cancelled}
             catch(error:Exception){localError=error.message?:"本批次未完成，请查看任务记录；原件保留"}}
        }catch(error:Exception){localError=error.message?:"未开始导入，请重新选择原件"}
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
    MaterialTheme(colorScheme=scheme,typography=paperTypography,shapes=paperShapes) {
        val tabs=listOf("library" to "文献","reader" to "阅读","tasks" to "任务","settings" to "设置")
        val icons=listOf(Icons.Outlined.LibraryBooks,Icons.Outlined.MenuBook,Icons.Outlined.Checklist,Icons.Outlined.Settings)
        val navigate:(String)->Unit={next->if(renderedRouteRevision==routeRevision)navigateCurrent(next)}
        BackHandler(route!="library"){
            if(route=="aggregates"&&state.aggregate.selected!=null)action("aggregate.back",JSONObject())
            else navigate(if(route=="session")"tasks"else"library")
        }
        BoxWithConstraints(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            val wide=maxWidth>=840.dp
            Row(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                if(wide) NavigationRail(containerColor=MaterialTheme.colorScheme.background) { Spacer(Modifier.height(24.dp)); Icon(Icons.Outlined.AutoStories,null,Modifier.padding(20.dp).size(28.dp),tint=MaterialTheme.colorScheme.primary); tabs.forEachIndexed {i,t->NavigationRailItem((route==t.first||(route=="session"&&t.first=="reader")||(route=="aggregates"&&t.first=="library")),{navigate(t.first)},{Icon(icons[i],t.second)},label={Text(t.second)})} }
                Scaffold(Modifier.weight(1f),snackbarHost={SnackbarHost(snackbar)},bottomBar={if(!wide)NavigationBar(containerColor=MaterialTheme.colorScheme.surface,tonalElevation=0.dp) { tabs.forEachIndexed{i,t->NavigationBarItem((route==t.first||(route=="session"&&t.first=="reader")||(route=="aggregates"&&t.first=="library")),{navigate(t.first)},{Icon(icons[i],t.second)},label={Text(t.second)})} }}) { padding ->
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
                            "aggregates" -> AggregatePane(state,action,aggregateLink,aggregateLinkCurrent)
                            "reader" -> ReaderPane(state,controller,action)
                            "tasks" -> NonOccludingViewport{TasksPane(state,action)}
                            "session" -> NonOccludingViewport{SessionPane(state,selectedSessionID,controller,action)}
                            "settings" -> NonOccludingViewport{SettingsPane(state,controller,action,{restore.launch(arrayOf("application/octet-stream","*/*"))},settingsPaneRequest,settingsRequestID)}
                        }}
                    }
                }
            }
        }
        state.pdfUnlockPrompt?.let { prompt -> key(prompt.requestID) { PdfUnlockDialog(prompt, controller) } }
        exportDeliveryJSON?.let { frozenRequest ->
            key(frozenRequest) {
                PendingExportChooser(controller,frozenRequest) { originalRequest,uri,error ->
                    // Every launcher instance captures its original lease; a late callback never selects a newer op.
                    if(exportDeliveryJSON==originalRequest) {
                        exportDeliveryJSON=null
                        if(error!=null) localError=error
                        else scope.launch {
                            try {
                                val original=JSONObject(originalRequest)
                                val claim=obj("operationID" to original.getString("operationID"),"attemptID" to original.getString("attemptID"))
                                val namespace=exportDeliveryNamespace(original)
                                val receipt=if(uri==null)controller.execute("$namespace.delivery.cancel",claim)
                                  else controller.execute("$namespace.save",claim.put("uri",uri.toString()))
                                snackbar.currentSnackbarData?.dismiss()
                                snackbar.showSnackbar(if(uri==null)receipt.optString("message","已取消选择位置；原件保留，可继续保存。") else exportSaveFeedback(receipt))
                            } catch(cancelled:CancellationException){throw cancelled}
                            catch(failure:Exception){localError=failure.message?:"保存尚未确认；原件保留。"}
                        }
                    }
                }
            }
        }
        state.retainedExportConfirmation?.let { confirmation ->
            val id=confirmation.getString("confirmationID")
            AlertDialog(onDismissRequest={if(pendingActions["export.retained.confirm"]!=true)action("export.retained.confirm.discard",obj("confirmationID" to id))},
                title={Text("结束本次准备并保留材料？")},text={Text(confirmation.getString("message"))},
                confirmButton={TextButton({action("export.retained.confirm",obj("confirmationID" to id))},enabled=pendingActions["export.retained.confirm"]!=true&&!state.busy){Text("确认保留材料并结束准备")}},
                dismissButton={TextButton({action("export.retained.confirm.discard",obj("confirmationID" to id))},enabled=pendingActions["export.retained.confirm"]!=true){Text("取消确认")}})
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


internal fun exportDeliveryNamespace(original:JSONObject):String = when(original.optString("exportRoute")) {
    "" -> "export"
    "retained" -> "export.retained"
    else -> error("未识别的原保存许可，未打开另一份材料")
}

@Composable private fun PendingExportChooser(controller:AppController,requestJSON:String,onResult:(String,Uri?,String?)->Unit) {
    val original=remember(requestJSON){JSONObject(requestJSON)}
    val frozenRequest=remember(requestJSON){requestJSON}
    var launched by rememberSaveable(requestJSON){mutableStateOf(false)}
    val currentResult by rememberUpdatedState(onResult)
    val launcher=rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()){result->
        currentResult(frozenRequest,if(result.resultCode==android.app.Activity.RESULT_OK)result.data?.data else null,null)
    }
    LaunchedEffect(frozenRequest) {
        try {
            controller.execute("${exportDeliveryNamespace(original)}.delivery.validate",obj("operationID" to original.getString("operationID"),"attemptID" to original.getString("attemptID")))
            if(!launched) {
                launched=true
                launcher.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(original.getString("mime")).putExtra(Intent.EXTRA_TITLE,original.getString("suggestedName")))
            }
        } catch(cancelled:CancellationException){throw cancelled}
        catch(failure:Exception){
            // A failed chooser launch must not leave a live permission that blocks later explicit saves.
            try { controller.execute("${exportDeliveryNamespace(original)}.delivery.cancel",obj("operationID" to original.getString("operationID"),"attemptID" to original.getString("attemptID"))) }
            catch(cancelled:CancellationException){throw cancelled}
            catch(_:Exception) { /* Root may already have retired this exact lease. */ }
            currentResult(frozenRequest,null,failure.message?:"系统保存许可已结束；请从待保存清单重新选择位置。")
        }
    }
}

@Composable internal fun SectionTitle(title:String,subtitle:String?=null,actions:@Composable RowScope.()->Unit={}) {
 Row(Modifier.fillMaxWidth().padding(horizontal=20.dp,vertical=18.dp),horizontalArrangement=Arrangement.spacedBy(12.dp),verticalAlignment=androidx.compose.ui.Alignment.CenterVertically){
  Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(4.dp)){
   Text(title,style=MaterialTheme.typography.headlineMedium)
   subtitle?.let{Text(it,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)}
  }
  actions()
 }
}
@Composable internal fun EmptyPane(title:String,text:String){
 Column(Modifier.fillMaxWidth().padding(horizontal=24.dp,vertical=36.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  Surface(shape=MaterialTheme.shapes.large,color=MaterialTheme.colorScheme.primaryContainer){Icon(Icons.Outlined.AutoStories,null,Modifier.padding(18.dp).size(28.dp),MaterialTheme.colorScheme.onPrimaryContainer)}
  Text(title,style=MaterialTheme.typography.titleLarge)
  Text(text,color=MaterialTheme.colorScheme.onSurfaceVariant,style=MaterialTheme.typography.bodyMedium)
 }
}

@OptIn(ExperimentalMaterial3Api::class,ExperimentalLayoutApi::class)
@Composable internal fun LibraryPane(state:UiState,controller:AppController,action:Action,importPDF:()->Unit){
 var source by rememberSaveable{mutableStateOf("")};var task by rememberSaveable{mutableStateOf("")};var method by rememberSaveable{mutableStateOf("")};var minimum by rememberSaveable{mutableStateOf("")};var choosing by rememberSaveable{mutableStateOf(false)};var picked by rememberSaveable{mutableStateOf(listOf<String>())}
 var query by rememberSaveable{mutableStateOf("")};var filter by rememberSaveable{mutableStateOf("全部")};var sort by rememberSaveable{mutableStateOf("最新")}
 var showFilters by rememberSaveable{mutableStateOf(false)};var showSearchInfo by rememberSaveable{mutableStateOf(false)}
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
 val keyboard=androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
 val activeFilters=listOf(source,task,method,minimum).count{it.isNotEmpty()}+if(filter=="全部")0 else 1
 val searchMessage=when{
  query.isBlank()->"搜索论文信息、作者、分类及私人笔记；输入后会补查本机已保存导读。不搜索未下载正文或 PDF 全文。"
  cachedSearch.loading->"正在补充检索本机已缓存导读；论文信息与笔记结果先显示。"
  cachedSearch.error!=null->"缓存检索未完成：${cachedSearch.error}"
  cachedSearch.result!=null->{val result=cachedSearch.result;buildString{
   append(if(result.scanned==0)"尚无可检索的已保存导读；当前只匹配论文信息与笔记。" else "已检查 ${result.scanned} 份本机缓存导读，命中 ${result.paperIDs.size} 篇；不包含未下载正文或 PDF 全文。")
   if(result.unavailable>0)append(" 另有 ${result.unavailable} 份缓存暂不可读或身份不匹配，尚未确认其中是否命中。")
   if(unknownCached>0)append(" 其中 $unknownCached 个命中缺少当前论文目录信息，原缓存仍保留。")
  }}
  else->"当前匹配论文信息与笔记。"
 }
 NonOccludingViewport{
  val libraryViewportHeight=maxHeight
  // Search, notices, filters and results all share ONE scroll viewport. When IME
  // leaves little height, the header can scroll away while actual results remain clickable.
  LazyColumn(Modifier.fillMaxSize(),contentPadding=PaddingValues(horizontal=16.dp,vertical=12.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
   item(key="library-heading"){
    Row(Modifier.fillMaxWidth().padding(top=8.dp),verticalAlignment=androidx.compose.ui.Alignment.CenterVertically){
     Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(4.dp)){
      Text("文献资料库",style=MaterialTheme.typography.headlineMedium)
      Text("发现、阅读，积累自己的研究",style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
     }
     IconButton(importPDF){Icon(Icons.Outlined.FileOpen,"导入 PDF")}
     IconButton({action("library.sync",JSONObject())},enabled=!state.loading){Icon(Icons.Outlined.Sync,"同步已发布内容")}
    }
   }
   item(key="library-catalog"){
    Surface(onClick={action("ui.aggregates",JSONObject())},shape=MaterialTheme.shapes.large,color=MaterialTheme.colorScheme.primaryContainer){
     Row(Modifier.fillMaxWidth().padding(horizontal=16.dp,vertical=12.dp),verticalAlignment=androidx.compose.ui.Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)){
      Icon(Icons.Outlined.Article,null,Modifier.size(24.dp),tint=MaterialTheme.colorScheme.onPrimaryContainer)
      Text("网站汇总",style=MaterialTheme.typography.titleSmall,color=MaterialTheme.colorScheme.onPrimaryContainer,modifier=Modifier.weight(1f))
      Icon(Icons.Outlined.ChevronRight,null,tint=MaterialTheme.colorScheme.onPrimaryContainer)
     }
    }
   }
   item(key="library-search"){
    OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),singleLine=true,shape=MaterialTheme.shapes.medium,placeholder={Text("搜索论文、作者与笔记",maxLines=1,overflow=androidx.compose.ui.text.style.TextOverflow.Ellipsis)},leadingIcon={Icon(Icons.Outlined.Search,null)},
     keyboardOptions=androidx.compose.foundation.text.KeyboardOptions(imeAction=androidx.compose.ui.text.input.ImeAction.Search),
     keyboardActions=androidx.compose.foundation.text.KeyboardActions(onSearch={keyboard?.hide()}))
   }
   item(key="library-status"){
    FlowRow(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(4.dp)){
     Text("${papers.size} 篇匹配",style=MaterialTheme.typography.labelLarge,modifier=Modifier.padding(vertical=12.dp))
     OutlinedButton({showFilters=true}){Icon(Icons.Outlined.Tune,null,Modifier.size(18.dp));Spacer(Modifier.width(6.dp));Text(if(activeFilters==0)"筛选与排序 · $sort" else "筛选 $activeFilters 项 · $sort")}
     IconButton({showSearchInfo=true}){Icon(if(cachedSearch.error!=null)Icons.Outlined.ErrorOutline else Icons.Outlined.Info,if(cachedSearch.error!=null)"检索未完成，查看范围与状态" else "目录与检索范围")}
     if(cachedSearch.loading)Text("正在检查导读…",style=MaterialTheme.typography.labelMedium,modifier=Modifier.padding(vertical=12.dp))
     else if((cachedSearch.result?.unavailable?:0)>0||unknownCached>0)Text("部分缓存未核对",style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.tertiary,modifier=Modifier.padding(vertical=12.dp))
     TextButton({choosing=!choosing;if(!choosing)picked=emptyList()}){Text(if(choosing)"完成多选" else "多选")}
    }
    if(activeFilters>0)Text(listOf(filter.takeUnless{it=="全部"},source.takeIf{it.isNotEmpty()}?.let{"来源：$it"},task.takeIf{it.isNotEmpty()}?.let{"任务：$it"},method.takeIf{it.isNotEmpty()}?.let{"方法：$it"},minimum.takeIf{it.isNotEmpty()}?.let{"最低 $it 分"}).filterNotNull().joinToString(" · "),style=MaterialTheme.typography.labelSmall)
    if(cachedSearch.error!=null)Text("缓存检查未完成，当前结果不包含未确认的导读命中。",color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)
   }
   if(choosing)item(key="library-selection"){
    FlowRow(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)){
     TextButton({picked=papers.map{it.id}}){Text("选择匹配 ${papers.size} 篇")}
     TextButton({action("personal.setList",obj("key" to "favorites","ids" to JSONArray((state.personal.ids("favorites")+picked).distinct())))},enabled=picked.isNotEmpty()){Text("收藏 ${picked.size} 篇")}
     TextButton({action("personal.setList",obj("key" to "reading","ids" to JSONArray((state.personal.ids("reading")+picked).distinct())))},enabled=picked.isNotEmpty()){Text("加入待读")}
    }
   }
   if(papers.isEmpty())item(key="library-empty"){EmptyPane(if(cachedSearch.loading)"正在查找本机导读" else if(cachedSearch.error!=null)"论文信息与笔记暂未匹配" else "这里还没有匹配的论文",if(query.isNotBlank())"当前筛选下未显示论文；缓存检查范围与未完成项可在“检索范围与状态”查看。" else "同步已发布资料，或导入本地 PDF。同步读取已有分析，不会重复请求模型。")}
   items(papers,key={it.id}){paper->OutlinedCard(onClick={if(choosing)picked=if(paper.id in picked)picked-paper.id else picked+paper.id else action("paper.open",obj("paperID" to paper.id))},colors=CardDefaults.outlinedCardColors(containerColor=MaterialTheme.colorScheme.surfaceContainerLow),border=androidx.compose.foundation.BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.6f)),modifier=Modifier.fillMaxWidth()){
    Column(Modifier.padding(18.dp)){
     FlowRow(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(12.dp),verticalArrangement=Arrangement.spacedBy(2.dp)){
      if(choosing)Checkbox(paper.id in picked,{checked->picked=if(checked)(picked+paper.id).distinct()else picked-paper.id})
      Text(paper.date,style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.primary)
      paper.score?.let{PaperLabel("$it 分")}
     }
     if(paper.id in missingFromLatest)Text("未列入最新网站快照，保留本机资料（不表示撤稿）",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.tertiary)
     Text(paper.titleZh,style=MaterialTheme.typography.titleMedium,fontWeight=FontWeight.SemiBold,maxLines=3,overflow=androidx.compose.ui.text.style.TextOverflow.Ellipsis,modifier=Modifier.padding(vertical=8.dp))
     if(paper.titleZh!=paper.title)Text(paper.title,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant,maxLines=2,overflow=androidx.compose.ui.text.style.TextOverflow.Ellipsis)
     Text(paper.authors.take(3).joinToString(" · "),style=MaterialTheme.typography.bodySmall,maxLines=2,overflow=androidx.compose.ui.text.style.TextOverflow.Ellipsis,modifier=Modifier.padding(top=8.dp))
     FlowRow(Modifier.padding(top=12.dp),horizontalArrangement=Arrangement.spacedBy(6.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
      if(paper.task.isNotBlank())PaperLabel(paper.task)
      if(paper.method.isNotBlank())PaperLabel(paper.method)
     }
     Text(paperSourceLabel(paper),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant,modifier=Modifier.padding(top=8.dp))
    }
   }}
  }
  if(showFilters)ModalBottomSheet(onDismissRequest={showFilters=false},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)){
   Column(Modifier.fillMaxWidth().heightIn(max=libraryViewportHeight).verticalScroll(rememberScrollState()).padding(start=20.dp,end=20.dp,bottom=24.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
    Text("筛选与排序",style=MaterialTheme.typography.titleLarge)
    Text("${papers.size} 篇匹配 · 当前筛选 $activeFilters 项。关闭此面板不会清除搜索或多选。",style=MaterialTheme.typography.bodySmall)
    FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)){listOf("全部","收藏","待读","离线").forEach{FilterChip(filter==it,{filter=it},label={Text(it)})}}
    Text("排序",style=MaterialTheme.typography.titleSmall)
    FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)){listOf("最新","评分").forEach{choice->FilterChip(sort==choice,{sort=choice},label={Text(choice)})}}
    FlowRow(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
     FilterChoice("来源",options.first,source,{source=it});FilterChoice("任务",options.second,task,{task=it});FilterChoice("方法",options.third,method,{method=it});FilterChoice("最低评分",listOf("7","8","9"),minimum,{minimum=it})
    }
    TextButton({source="";task="";method="";minimum="";filter="全部"},enabled=activeFilters>0){Text("清除筛选（保留搜索和排序）")}
    Button({showFilters=false},Modifier.fillMaxWidth()){Text("查看 ${papers.size} 篇结果")}
   }
  }
  if(showSearchInfo)AlertDialog(onDismissRequest={showSearchInfo=false},title={Text("目录与检索范围")},text={Column(Modifier.heightIn(max=libraryViewportHeight).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)){
   Text(catalogMessage(state.catalogSummary,localCount));Text(searchMessage,color=if(cachedSearch.error!=null)MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
   Text("论文信息与笔记匹配，以及本次已核验的缓存导读命中，合并后继续应用全部筛选与排序。未下载的正文和 PDF 全文不在检索范围内。")
   if(cachedSearch.error!=null&&query.length<=256)TextButton({searchRetry++}){Text("重试本机导读检索")}
  }},confirmButton={TextButton({showSearchInfo=false}){Text("关闭")}})
 }
}

/** Register the real provider when this static document View joins its native window.
 * No synthetic tree, focus transfer, notification, script or renderer-private API is used. */
private class StaticDocumentWebView(context:android.content.Context):WebView(context) {
 override fun onAttachedToWindow(){
  super.onAttachedToWindow()
  val accessibility=context.getSystemService(android.view.accessibility.AccessibilityManager::class.java)
  if(accessibility?.isEnabled==true)accessibilityNodeProvider
 }
}

@Composable internal fun StaticDocument(body:String,fontSize:Int=18,initialScroll:Int=0,onScroll:(Int)->Unit={},images:AggregateImageAccess?=null,aggregateLink:AggregateLinkAction?=null,aggregateNonce:String?=null,aggregateCurrent:AggregateLinkCurrent?=null){
 val context=LocalContext.current
 val scrollValue=rememberUpdatedState(initialScroll);val scrollCallback=rememberUpdatedState(onScroll)
 val linkCallback=rememberUpdatedState(aggregateLink);val linkNonce=rememberUpdatedState(aggregateNonce);val linkCurrent=rememberUpdatedState(aggregateCurrent)
 val restoring=remember{java.util.concurrent.atomic.AtomicBoolean(true)}
 val activeView=remember{java.util.concurrent.atomic.AtomicReference<WebView?>(null)}
 val activeDocument=remember{java.util.concurrent.atomic.AtomicReference<StreamedHtmlDocument?>(null)}
 val activeImages=remember{java.util.concurrent.atomic.AtomicReference<Pair<StreamedHtmlDocument,AggregateImageAccess>?>(null)}
 val background=MaterialTheme.colorScheme.surface.toArgb();val foreground=MaterialTheme.colorScheme.onSurface.toArgb();val link=MaterialTheme.colorScheme.primary.toArgb()
 val zoom=(fontSize.coerceIn(14,30)/18f*LocalDensity.current.fontScale*100).toInt().coerceAtLeast(50)
 // The shared head is small; body remains the immutable renderer result, never concatenated/replaced.
 val document=remember(body,background,foreground,link,images){
  var head=ExportService.htmlDocumentHead("",background,foreground,link)
  if(images!=null){require(head.contains("img-src data:;"));head=head.replace("img-src data:;","img-src ${images.cspImageSource};")}
  StreamedHtmlDocument(head,body,"</body></html>")
 }
 AndroidView(factory={StaticDocumentWebView(it).apply {
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
    val web=view?:return true
    val owner=activeDocument.get()?:return true
    if(activeView.get()!==web||web.tag!==owner)return true
    val u=request?.url?:return true
    if(owner.mayNavigateWithin(u.toString()))return false
    val callback=linkCallback.value
    if(callback!=null) {
     if(!request.isForMainFrame||request.method!="GET"||u.scheme!="https"||u.encodedAuthority!="reader.invalid"||u.encodedQuery!=null||u.encodedFragment!=null)return true
     val parts=u.pathSegments
     val nonce=linkNonce.value?:return true
     if(parts.size!=3||parts[0]!="aggregate-link"||parts[1]!=nonce||u.encodedPath!="/aggregate-link/$nonce/${parts[2]}")return true
     val index=parts[2].toIntOrNull()?.takeIf{it>=0&&it.toString()==parts[2]}?:return true
     callback(nonce,index){result->
      // 异步结果可能来自后台线程；平台动作及当前页面核验统一回到此 View 的线程。
      web.post {
       if(activeView.get()===web&&activeDocument.get()===owner&&web.tag===owner&&web.isAttachedToWindow&&web.isShown&&owner.mayNavigateWithin(web.url)&&web.progress==100&&web.contentHeight>0&&linkNonce.value==nonce&&linkCallback.value!=null&&result.optString("status")=="link-ready"&&linkCurrent.value?.invoke(nonce,index)==true) {
        when(result.optString("kind")) {
         "anchor"->web.loadUrl(owner.url+"#"+result.getString("fragment"))
         "external"->{val target=Uri.parse(result.getString("url"));if(target.scheme=="https"&&target.host!=null&&target.userInfo==null&&target.host!="reader.invalid")runCatching{context.startActivity(Intent(Intent.ACTION_VIEW,target))}}
        }
       }
      }
     }
     return true
    }
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
    val bound=activeImages.get()
    if(activeView.get()===view&&owner!=null&&view?.tag===owner&&bound!=null&&bound.first===owner){
     val response=runCatching{bound.second.open(u.toString(),request.isForMainFrame,request.method)}.getOrNull()
     if(response!=null){
      if(activeView.get()===view&&activeDocument.get()===owner&&view?.tag===owner&&activeImages.get()===bound)return WebResourceResponse(response.first,null,200,"OK",mapOf("Cache-Control" to "no-store","X-Content-Type-Options" to "nosniff"),response.second)
      response.second.close()
     }
    }
    return WebResourceResponse("text/plain","utf-8",403,"Forbidden",emptyMap(),ByteArrayInputStream(byteArrayOf()))
   }
  }
 }},update={web->
  activeView.set(web)
  web.setBackgroundColor(background)
  if(web.settings.textZoom!=zoom)web.settings.textZoom=zoom
  if(web.tag!==document){
   restoring.set(true);web.stopLoading();activeImages.set(images?.let{document to it});activeDocument.set(document);web.tag=document;web.loadUrl(document.url)
  }
 },onRelease={web->if(activeView.compareAndSet(web,null)){activeDocument.set(null);activeImages.set(null)};web.stopLoading();web.tag=null;web.destroy()},modifier=Modifier.fillMaxSize().clipToBounds())
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
