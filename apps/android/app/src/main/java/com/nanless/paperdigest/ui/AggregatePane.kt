package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.nanless.paperdigest.data.*
import org.json.JSONObject

/** Website pages have their own navigation and typed state; no paper reader/actions are composed here. */
@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun AggregatePane(state:UiState,action:Action) {
    val aggregate=state.aggregate
    var filter by rememberSaveable { mutableStateOf("all") }
    var query by rememberSaveable { mutableStateOf("") }
    var sourceInfo by rememberSaveable(aggregate.selected?.id) { mutableStateOf(false) }
    var savedVersions by rememberSaveable(aggregate.selected?.id) { mutableStateOf(false) }
    val listState=rememberLazyListState()
    LaunchedEffect(Unit){if(!aggregate.attemptedIndex)action("aggregate.list",JSONObject())}
    LaunchedEffect(state.catalogSummary.optString("snapshotID")){
        if(aggregate.attemptedIndex&&aggregate.catalogStale&&aggregate.selected==null)action("aggregate.list",JSONObject())
    }
    LaunchedEffect(aggregate.selected?.id,aggregate.loading,aggregate.document,aggregate.error){if(aggregate.selected!=null&&!aggregate.loading&&aggregate.document==null&&aggregate.error==null)action("aggregate.select",obj("id" to aggregate.selected.id))}
    val selected=aggregate.selected
    NonOccludingViewport {
        val viewportHeight=maxHeight
        if(selected==null) {
            val records=aggregate.catalog?.records.orEmpty().sortedWith(compareByDescending<PublishedAggregate>{it.displayDate.orEmpty()}.thenBy{it.titleZh}.thenBy{it.id})
            val displayed=records.filter{record->(filter=="all"||record.kind==filter)&&(query.isBlank()||listOf(record.title,record.titleZh,record.summary,record.displayDate.orEmpty(),record.sourceURL).any{it.contains(query.trim(),true)}||record.categories.any{it.contains(query.trim(),true)}||record.tags.any{it.contains(query.trim(),true)})}
            LazyColumn(Modifier.fillMaxSize(),state=listState,contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
                item("heading") { FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) { TextButton({action("ui.library",JSONObject())}){Text("返回论文列表")};Text("网站汇总",style=MaterialTheme.typography.headlineSmall,fontWeight=FontWeight.SemiBold) } }
                item("scope"){Text("日更汇总、会议页面与站点说明；这些页面不是单篇论文，不提供 PDF、研究模型、评分或 Zotero 操作。",style=MaterialTheme.typography.bodySmall)}
                item("filters") { FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) { for((key,label)in listOf("all" to "全部","daily" to "日更汇总","conference" to "会议页面","page" to "站点页面")){val count=if(key=="all")records.size else records.count{it.kind==key};FilterChip(filter==key,{filter=key},label={Text("$label $count")})} } }
                item("search"){OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),label={Text("搜索汇总标题、日期与标签")},singleLine=true)}
                item("status") {
                    Column(verticalArrangement=Arrangement.spacedBy(6.dp)) {
                        if(aggregate.loading){LinearProgressIndicator(Modifier.fillMaxWidth());Text("正在核验网站汇总…")}
                        aggregate.error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
                        if(aggregate.catalogStale)Text("网站目录已变化；当前列表仍保留原目录身份，请重新读取。",color=MaterialTheme.colorScheme.tertiary)
                        FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                            if(aggregate.catalog!=null)OutlinedButton({action("aggregate.list",JSONObject())},enabled=!aggregate.loading){Text(if(aggregate.catalog==null)"读取汇总目录"else"重新读取目录")}
                            if(aggregate.catalog==null&&!aggregate.offlineMode)OutlinedButton({action("library.sync",JSONObject())},enabled=!aggregate.loading&&!state.busy){Text("同步已发布内容")}
                        }
                        if(aggregate.offlineMode)Text(if(aggregate.catalog==null)"离线模式下尚无已核网站目录；请允许联网后同步已发布内容。"else"离线模式：只读取当前目录中已核验的保存正文。",style=MaterialTheme.typography.bodySmall)
                        if(state.busy)Text("资料任务正在进行，可在任务页查看真实进度。",style=MaterialTheme.typography.bodySmall)
                        Text("${displayed.size} 个页面匹配",style=MaterialTheme.typography.labelLarge)
                    }
                }
                if(displayed.isEmpty()&&!aggregate.loading)item("empty"){Text(if(aggregate.catalog==null)"尚无已核验的汇总目录；同步网站后再读取。"else"当前筛选没有匹配的页面。")}
                items(displayed,key={it.id}){record->ElevatedCard(onClick={action("aggregate.select",obj("id" to record.id))},enabled=!aggregate.loading&&!aggregate.catalogStale,modifier=Modifier.fillMaxWidth()){
                    Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                        Text(aggregateKindLabel(record.kind)+" · "+(record.displayDate?:"未标注发布日期"),style=MaterialTheme.typography.labelMedium)
                        Text(record.titleZh,style=MaterialTheme.typography.titleMedium,fontWeight=FontWeight.SemiBold)
                        if(record.summary.isNotBlank())Text(record.summary,style=MaterialTheme.typography.bodySmall,maxLines=4,overflow=androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                        val tags=(record.categories+record.tags).distinct();if(tags.isNotEmpty())Text(tags.joinToString(" · "),style=MaterialTheme.typography.labelSmall,maxLines=3,overflow=androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                    }
                }}
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                // Metadata can scroll independently without consuming the whole short-screen document viewport.
                Column(Modifier.fillMaxWidth().heightIn(max=viewportHeight*0.45f).verticalScroll(rememberScrollState()).padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                    TextButton({action("aggregate.back",JSONObject())}){Text("返回汇总列表")}
                    Text(selected.titleZh,style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.SemiBold)
                    Text(aggregateKindLabel(selected.kind)+" · "+(selected.displayDate?:"未标注发布日期"),style=MaterialTheme.typography.labelMedium)
                    val document=aggregate.document
                    if(document!=null)Text((if(document.fromCache)"保存的网页修订 · "else"本次读取网站正文 · ")+document.fetchedAt,style=MaterialTheme.typography.bodySmall)
                    Text(if(document!=null&&document.resources.isNotEmpty())"${document.resources.size} 张网页图片尚未保存；当前不是完整图文或完整离线副本。"else"仅保存网页正文；未封存全部网页资源，不是完整离线副本。",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.tertiary)
                    aggregate.error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
                    if(aggregate.catalogStale)Text("目录已变化，当前正文仍保留原来源身份；请重新读取目录。",color=MaterialTheme.colorScheme.tertiary)
                    if(aggregate.cacheError!=null)Text("保存修订清单核验未完成，未自动改用其他正文。",color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)
                    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                        if(!aggregate.offlineMode)OutlinedButton({action("aggregate.refresh",obj("id" to selected.id))},enabled=!aggregate.loading&&!aggregate.catalogStale){Text("刷新网站正文")}
                        if(aggregate.revisions.isNotEmpty())OutlinedButton({savedVersions=true},enabled=!aggregate.loading&&!aggregate.catalogStale){Text("保存修订 ${aggregate.revisions.size}")}
                        TextButton({sourceInfo=true}){Text("来源与提示")}
                        if(aggregate.catalogStale)OutlinedButton({action("aggregate.list",JSONObject())},enabled=!aggregate.loading){Text("重新读取目录")}
                    }
                    if(aggregate.offlineMode)Text("离线模式不会请求网站；没有已核保存正文时无法读取此页。",style=MaterialTheme.typography.bodySmall)
                }
                if(aggregate.loading){LinearProgressIndicator(Modifier.fillMaxWidth());Text("正在读取网页正文…",Modifier.padding(horizontal=12.dp))}
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    val doc=aggregate.document
                    if(doc!=null)key(doc.descriptor.id,doc.rawHTMLSHA256){var scroll by rememberSaveable(doc.descriptor.id,doc.rawHTMLSHA256){mutableIntStateOf(0)};StaticDocument(doc.bodyHTML,state.settings.optInt("font",18),scroll,{scroll=it})}
                    else Text(if(aggregate.loading)"正在读取网站正文。"else"尚未取得可显示的网页正文。",Modifier.padding(16.dp))
                }
            }
        }
    }
    if(sourceInfo&&selected!=null)AlertDialog(onDismissRequest={sourceInfo=false},title={Text("网页来源与保存身份")},text={Column(Modifier.heightIn(max=480.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)){
        val doc=aggregate.document;val descriptor=doc?.descriptor?:selected
        Text(descriptor.sourceURL);Text("目录原清单 SHA：${descriptor.source.manifestSHA256}");Text("原分片 SHA：${descriptor.source.shardSHA256}");Text("原行：${descriptor.source.rowIndex} · ${descriptor.source.normalizedRowSHA256}")
        if(doc!=null){Text("原 HTML SHA：${doc.rawHTMLSHA256}");Text("派生正文 SHA：${doc.bodySHA256}");Text("保存时刻：${doc.fetchedAt}");doc.notices.forEach{Text(it)};doc.resources.forEach{Text(it.missingReason+"\n"+it.sourceURL)}}
        aggregate.cacheError?.let{Text(it,color=MaterialTheme.colorScheme.error)}
        Text("目录当前性不代表旧网页已重新核验。正文链接只会在浏览器打开，不转成论文、PDF 或研究权限。")
    }},confirmButton={TextButton({sourceInfo=false}){Text("关闭")}})
    if(savedVersions&&selected!=null)AlertDialog(onDismissRequest={savedVersions=false},title={Text("明确读取保存修订")},text={Column(Modifier.heightIn(max=480.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)){
        Text("这些是当前目录同一页面中逐份核验的原修订，未声称与网站最新内容一致。")
        aggregate.revisions.forEach{revision->OutlinedButton({savedVersions=false;action("aggregate.cached",obj("id" to selected.id,"rawHTMLSHA256" to revision.rawHTMLSHA256))}){Text(revision.fetchedAt+"\n"+revision.rawHTMLSHA256.take(12))}}
    }},confirmButton={TextButton({savedVersions=false}){Text("关闭")}})
}
internal fun aggregateKindLabel(kind:String)=when(kind){"daily"->"日更汇总";"conference"->"会议页面";"page"->"站点页面";else->"网站页面"}
