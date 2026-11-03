package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import org.json.JSONObject

/** Website pages have their own navigation and typed state; no paper reader/actions are composed here. */
@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun AggregatePane(state:UiState,action:Action,openLink:AggregateLinkAction?=null,linkCurrent:AggregateLinkCurrent?=null,requestedSection:String="all",sectionRequest:Int=0,autoLoad:Boolean=true) {
    val aggregate=state.aggregate
    var filter by rememberSaveable { mutableStateOf(requestedSection) }
    LaunchedEffect(requestedSection,sectionRequest){filter=requestedSection}
    val savedDocuments=rememberSaveableStateHolder()
    var query by rememberSaveable { mutableStateOf("") }
    var sourceInfo by rememberSaveable(aggregate.selected?.id) { mutableStateOf(false) }
    var savedVersions by rememberSaveable(aggregate.selected?.id) { mutableStateOf(false) }
    val listState=rememberLazyListState()
    var readingMenu by rememberSaveable(aggregate.selected?.id){mutableStateOf(false)}
    LaunchedEffect(autoLoad){if(autoLoad&&!aggregate.attemptedIndex)action("aggregate.list",JSONObject())}
    LaunchedEffect(state.catalogSummary.optString("snapshotID")){
        if(autoLoad&&aggregate.attemptedIndex&&aggregate.catalogStale&&aggregate.selected==null)action("aggregate.list",JSONObject())
    }
    LaunchedEffect(aggregate.selected?.id,aggregate.loading,aggregate.document,aggregate.error){if(aggregate.selected!=null&&!aggregate.loading&&aggregate.document==null&&aggregate.error==null)action("aggregate.select",obj("id" to aggregate.selected.id))}
    LaunchedEffect(aggregate.preview){if(aggregate.preview!=null){readingMenu=false;sourceInfo=false;savedVersions=false}}
    val selected=aggregate.selected
    NonOccludingViewport {
        val viewportHeight=maxHeight
        if(selected==null) {
            val records=remember(aggregate.catalog){workbenchAggregateOrder(aggregate.catalog?.records.orEmpty())}
            val displayed=records.filter{record->workbenchAggregateInSection(record,filter)&&(query.isBlank()||listOf(record.title,record.titleZh,record.summary,record.displayDate.orEmpty(),record.sourceURL).any{it.contains(query.trim(),true)}||record.categories.any{it.contains(query.trim(),true)}||record.tags.any{it.contains(query.trim(),true)})}
            LazyColumn(Modifier.fillMaxSize(),state=listState,contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
                item("heading") { Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                    IconButton({action("ui.library",JSONObject())}){Icon(Icons.Outlined.ArrowBack,"返回论文列表")}
                    Text(when(filter){"daily"->"每日论文速递";"conference"->"会议论文集";else->"网站页面"},style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.SemiBold,modifier=Modifier.weight(1f))
                    IconButton({action("ui.resources",JSONObject())}){Icon(Icons.Outlined.Language,"网站全部成果")}
                } }
                item("scope"){Text("与网站同步浏览日更、会议论文集和说明。会议先列总览，再列各研究方向。",style=MaterialTheme.typography.bodySmall)}
                item("filters") { FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) { for((key,label)in listOf("daily" to "日更","conference" to "会议论文集","page" to "关于与资源","all" to "全部")){val count=if(key=="all")records.size else records.count{workbenchAggregateInSection(it,key)};FilterChip(filter==key,{filter=key;action("ui.aggregates.section",obj("section" to key))},label={Text("$label $count")})} } }
                item("search"){OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),label={Text("搜索汇总标题、日期与标签")},singleLine=true)}
                item("status") {
                    Column(verticalArrangement=Arrangement.spacedBy(6.dp)) {
                        if(aggregate.loading){LinearProgressIndicator(Modifier.fillMaxWidth());Text("正在读取汇总目录…")}
                        aggregate.error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
                        if(aggregate.catalogStale)Text("目录有更新，请重新读取后打开页面。",color=MaterialTheme.colorScheme.tertiary)
                        FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                            if(aggregate.offlineMode && aggregate.catalog!=null) {
                                OutlinedButton({action("aggregate.list",JSONObject())},enabled=!aggregate.loading){Text("重读本机目录")}
                            }
                            if(!aggregate.offlineMode) {
                                OutlinedButton({action("library.sync",JSONObject())},enabled=!aggregate.loading&&!state.busy){
                                    Text(if(aggregate.catalog==null)"同步已发布内容" else "刷新日更与网站目录")
                                }
                            }
                        }
                        if(aggregate.offlineMode)Text(if(aggregate.catalog==null)"尚无保存的网站目录。关闭离线模式后可同步内容。"else"离线模式 · 阅读已经保存的页面。",style=MaterialTheme.typography.bodySmall)
                        if(state.busy)Text("资料任务正在进行，可到任务页查看进度。",style=MaterialTheme.typography.bodySmall)
                        Text("${displayed.size} 个页面匹配",style=MaterialTheme.typography.labelLarge)
                    }
                }
                if(displayed.isEmpty()&&!aggregate.loading)item("empty"){Text(if(aggregate.catalog==null)"同步来源后，即可查看已发布的汇总和网站页面。"else"当前筛选没有匹配的页面。")}
                items(displayed,key={it.id}){record->OutlinedCard(onClick={action("aggregate.select",obj("id" to record.id))},enabled=!aggregate.loading&&!aggregate.catalogStale,modifier=Modifier.fillMaxWidth()){
                    Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                        Text(aggregateRecordLabel(record)+" · "+(record.displayDate?:"未标注发布日期"),style=MaterialTheme.typography.labelMedium)
                        Text(record.titleZh.ifBlank{record.title},style=MaterialTheme.typography.titleMedium,fontWeight=FontWeight.SemiBold,maxLines=2,overflow=TextOverflow.Ellipsis)
                        if(record.summary.isNotBlank())Text(record.summary,style=MaterialTheme.typography.bodySmall,maxLines=2,overflow=androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                        val tags=(record.categories+record.tags).distinct();if(tags.isNotEmpty())Text(tags.joinToString(" · "),style=MaterialTheme.typography.labelSmall,maxLines=1,overflow=androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                    }
                }}
            }
        } else {
            val noticeScroll=rememberScrollState()
            LaunchedEffect(selected.id,aggregate.error,aggregate.cacheError,aggregate.catalogStale,aggregate.document?.imageError,aggregate.document?.images?.missingCount,aggregate.offlineMode,aggregate.loadingImages){noticeScroll.scrollTo(0)}
            Column(Modifier.fillMaxSize()) {
                Surface(color=MaterialTheme.colorScheme.surface) {
                    Column {
                        Row(Modifier.fillMaxWidth().padding(horizontal=4.dp,vertical=4.dp),verticalAlignment=Alignment.CenterVertically) {
                            IconButton({action("aggregate.back",JSONObject())}){Icon(Icons.Outlined.ArrowBack,aggregate.backTitle)}
                            Column(Modifier.weight(1f).clickable(enabled=aggregate.preview==null,onClickLabel="查看完整标题与来源"){sourceInfo=true}.padding(horizontal=4.dp),verticalArrangement=Arrangement.spacedBy(2.dp)) {
                                Text(selected.titleZh.ifBlank{selected.title},style=MaterialTheme.typography.titleMedium,fontWeight=FontWeight.SemiBold,maxLines=if(viewportHeight<360.dp)1 else 2,overflow=TextOverflow.Ellipsis)
                                Text(aggregateKindLabel(selected.kind),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            IconButton({action("aggregate.refresh",obj("id" to selected.id))},enabled=!aggregate.offlineMode&&!aggregate.loading&&!aggregate.catalogStale){Icon(Icons.Outlined.Refresh,"刷新网站正文")}
                            Box {
                                IconButton({readingMenu=true},enabled=aggregate.preview==null){Icon(Icons.Outlined.MoreVert,"页面操作、来源与已保存版本")}
                                DropdownMenu(readingMenu,{readingMenu=false}) {
                                    ReaderTextSizeMenu(state.settings.optInt("font",18)){size->readingMenu=false;action("settings.save",obj("changes" to obj("font" to size)))}
                                    HorizontalDivider()
                                    DropdownMenuItem(text={Text("来源与提示")},leadingIcon={Icon(Icons.Outlined.Info,null)},onClick={readingMenu=false;sourceInfo=true})
                                    if(aggregate.revisions.isNotEmpty())DropdownMenuItem(text={Text("已保存版本（${aggregate.revisions.size}）")},leadingIcon={Icon(Icons.Outlined.History,null)},enabled=!aggregate.loading&&!aggregate.catalogStale,onClick={readingMenu=false;savedVersions=true})
                                    if(aggregate.catalogStale)DropdownMenuItem(text={Text("更新目录")},enabled=!aggregate.loading,onClick={readingMenu=false;action("aggregate.list",JSONObject())})
                                }
                            }
                        }
                        // Only exceptional short notices scroll; the document keeps its own weighted viewport.
                        Column(Modifier.fillMaxWidth().heightIn(max=viewportHeight*0.22f).verticalScroll(noticeScroll).padding(horizontal=16.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                            aggregate.error?.let{Text(if(aggregate.document==null)"网页暂时未能读取。请重试或查看来源提示。"else"本次读取未完成，保留已保存的正文。",color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)}
                            if(!aggregate.loadingImages)aggregate.document?.imageError?.let{Text("图片读取未完成，正文仍可阅读。",color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)}
                            if(aggregate.cacheError!=null)Text("已保存版本暂不可读，请查看来源提示。",color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)
                            val doc=aggregate.document
                            val missing=doc?.images?.missingCount?:doc?.resources?.size?:0
                            if(aggregate.loadingImages)Text("正文已就绪，图片正在后台读取，可继续阅读。",style=MaterialTheme.typography.bodySmall)
                            else if(missing>0)Text("还有 $missing 张图片未保存，正文仍可阅读。",color=MaterialTheme.colorScheme.tertiary,style=MaterialTheme.typography.bodySmall)
                            if(aggregate.catalogStale)Text("目录有更新，请在页面菜单中更新目录。",color=MaterialTheme.colorScheme.tertiary,style=MaterialTheme.typography.bodySmall)
                            if(aggregate.offlineMode)Text("离线模式 · 只读已保存内容",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                            else if(doc?.fromCache==true)Text("正在阅读已保存版本",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.5f))
                if(aggregate.loading){LinearProgressIndicator(Modifier.fillMaxWidth());Text(if(aggregate.preview!=null)"正在打开已保存页面…"else"正在读取正文…",Modifier.padding(horizontal=16.dp),style=MaterialTheme.typography.bodySmall)}
                if(aggregate.preview!=null)Text("先显示上次阅读文字，图文和链接加载后恢复。",Modifier.padding(horizontal=16.dp),style=MaterialTheme.typography.bodySmall)
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    val doc=aggregate.document
                    if(doc!=null)savedDocuments.SaveableStateProvider("${doc.descriptor.id}:${doc.rawHTMLSHA256}"){var scroll by rememberSaveable(doc.descriptor.id,doc.rawHTMLSHA256){mutableIntStateOf(0)};AggregateFormulaDocument(doc,state.settings.optInt("font",18),scroll,{scroll=it},openLink,linkCurrent)}
                    else if(aggregate.preview!=null){
                        val preview=aggregate.preview
                        val escaped=remember(preview){"<pre style='white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit'>"+android.text.Html.escapeHtml(preview.text)+"</pre>"}
                        StaticDocument(escaped,state.settings.optInt("font",18))
                    }else Text(if(aggregate.loading)"正在读取网站正文。"else"尚未取得可显示的网页正文。",Modifier.padding(16.dp))
                }
            }
        }
    }
    if(sourceInfo&&selected!=null&&aggregate.preview==null)AlertDialog(onDismissRequest={sourceInfo=false},title={Text("来源与保存信息")},text={Column(Modifier.heightIn(max=480.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)){
        val doc=aggregate.document;val descriptor=doc?.descriptor?:selected
        Text(descriptor.titleZh.ifBlank{descriptor.title},style=MaterialTheme.typography.titleMedium)
        if(descriptor.title.isNotBlank()&&descriptor.title!=descriptor.titleZh)Text(descriptor.title)
        Text(aggregateKindLabel(descriptor.kind)+" · "+(descriptor.displayDate?:"网站未标注日期"))
        Text(descriptor.sourceURL);Text("目录原清单 SHA：${descriptor.source.manifestSHA256}");Text("原分片 SHA：${descriptor.source.shardSHA256}");Text("原行：${descriptor.source.rowIndex} · ${descriptor.source.normalizedRowSHA256}")
        if(doc!=null){Text("原 HTML SHA：${doc.rawHTMLSHA256}");Text("派生正文 SHA：${doc.bodySHA256}");Text("网页保存于：${aggregateLocalMoment(doc.fetchedAt)}");Text("原记录时间：${doc.fetchedAt}",style=MaterialTheme.typography.bodySmall);doc.notices.forEach{Text(aggregateFriendlyNotice(it))};doc.resources.forEach{Text(it.missingReason+"\n"+it.sourceURL)}}
        doc?.images?.let{images->Text("图片清单 SHA：${images.manifestSHA256}");Text("图片保存于：${aggregateLocalMoment(images.observedAt)}");images.importedFrom?.let{Text("由已核备份原件重新读取 · ${it.platform} · ${it.manifestSHA256}")};images.records.forEach{record->Text("位置 ${record.slot.index+1} · ${record.slot.sourceURL.orEmpty()}\n"+(record.sha256?.let{"$it · ${record.bytes} 字节 · ${record.mime}"}?:record.missingReason.orEmpty())+(if(record.slot.caption.isBlank())""else"\n图注：${record.slot.caption}"))}}
        doc?.imageError?.let{Text(it,color=MaterialTheme.colorScheme.error)}
        aggregate.cacheError?.let{Text(it,color=MaterialTheme.colorScheme.error)}
        aggregate.error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
        Text("已保存的网页版本会保留；目录更新不代表旧正文已经重新读取。")
        Text("此页尚未保存全部网页资源，不是完整离线页面。")
    }},confirmButton={TextButton({sourceInfo=false}){Text("关闭")}})
    if(savedVersions&&selected!=null&&aggregate.preview==null)AlertDialog(onDismissRequest={savedVersions=false},title={Text("已保存版本")},text={Column(Modifier.heightIn(max=480.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)){
        Text("选择这页以前保存的版本；这里不会自动获取网站新内容。")
        aggregate.revisions.forEachIndexed{index,revision->OutlinedButton({savedVersions=false;action("aggregate.cached",obj("id" to selected.id,"rawHTMLSHA256" to revision.rawHTMLSHA256))}){Text("版本 ${index+1} · "+aggregateLocalMoment(revision.fetchedAt)+(if(revision.rawHTMLSHA256==aggregate.document?.rawHTMLSHA256)" · 当前显示"else""))}}
    }},confirmButton={TextButton({savedVersions=false}){Text("关闭")}})
}
internal fun aggregateRecordLabel(record:PublishedAggregate)=when {
    workbenchConferenceDirectory(record)->"全部会议目录"
    record.kind=="conference"->if(workbenchConferenceTask(record))"研究方向"else"会议总览"
    else->aggregateKindLabel(record.kind)
}
internal fun aggregateKindLabel(kind:String)=when(kind){"daily"->"日更汇总";"conference"->"会议与专题";"page"->"网站页面";else->"网站页面"}

/** The effect owns one genuine document; old completions cannot publish after its replacement. */
@Composable private fun AggregateFormulaDocument(document:AggregateDocumentView,fontSize:Int,scroll:Int,onScroll:(Int)->Unit,openLink:AggregateLinkAction?,linkCurrent:AggregateLinkCurrent?){
    val context=androidx.compose.ui.platform.LocalContext.current
    val current by rememberUpdatedState(document)
    // The sealed, sanitized document is already readable. Formula enhancement must never hide it.
    var rendered by remember(document){mutableStateOf(document.linkHTML?:document.images?.bodyHTML?:document.bodyHTML)}
    var formatting by remember(document){mutableStateOf(true)}
    var failure by remember(document){mutableStateOf<String?>(null)}
    LaunchedEffect(document){
        val effect=kotlin.coroutines.coroutineContext
        try{
            val html=ResearchRenderer.renderAggregateHTML(context,document){
                effect.ensureActive()
                if(current!=document)throw CancellationException("汇总阅读已切换，未采用旧公式排版")
            }
            rendered=html
            formatting=false
        }catch(cancelled:CancellationException){throw cancelled}
        catch(error:Exception){
            effect.ensureActive()
            if(current==document){formatting=false;failure="部分公式未完成排版，保留原式供核对。";rendered=document.linkHTML?:document.images?.bodyHTML?:document.bodyHTML}
        }
    }
    Column(Modifier.fillMaxSize()){
        failure?.let{Text(it,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)}
        if(formatting)Text("正文已就绪 · 正在优化公式排版…",style=MaterialTheme.typography.bodySmall)
        Box(Modifier.weight(1f).fillMaxWidth()){StaticDocument(rendered,fontSize,scroll,onScroll,document.images,openLink,document.linkNonce,linkCurrent)}
    }
}

/** Display-only formatting; source timestamps and selection hashes are retained unchanged. */
internal fun aggregateLocalMoment(value:String):String=runCatching{
    java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM)
        .withZone(java.time.ZoneId.systemDefault()).format(java.time.Instant.parse(value))
}.getOrDefault(value.ifBlank{"时间未记录"})
internal fun aggregateFriendlyNotice(value:String):String=when(value){
    "网站汇总只读正文；不具有单篇论文、PDF、模型或Zotero资格。"->"这是网站已经发布的汇总或说明页面。"
    "原HTML与派生正文分别保存；目录当前性不代表旧网页已重新核验。"->"原网页与阅读内容已分别保存；网站更新后可手动刷新正文。"
    else->value
}
