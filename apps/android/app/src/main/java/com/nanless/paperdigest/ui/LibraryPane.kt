package com.nanless.paperdigest.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneId

@Composable internal fun LibraryPane(state:UiState,controller:AppController,action:Action,importPDF:()->Unit,providedIndex:WebsiteLibraryIndex?=null,indexProvided:Boolean=false,directoryRequest:Int=0,providedSearchMemo:CachedGuideSearchMemo?=null){
    val searchMemo=providedSearchMemo?:remember(controller){CachedGuideSearchMemo()}
    var contentScope by rememberSaveable{mutableStateOf("全部")}
    var handledRequest by rememberSaveable{mutableIntStateOf(0)};var pendingDirectory by rememberSaveable{mutableStateOf(false)}
    LaunchedEffect(directoryRequest){if(directoryRequest!=handledRequest){handledRequest=directoryRequest;contentScope="全部";pendingDirectory=true}}
    val scopes=rememberSaveableStateHolder()
    val index=if(indexProvided)providedIndex else rememberWebsiteLibraryIndex(state.papers,state.websiteTaxonomy)
    scopes.SaveableStateProvider(contentScope){LibraryScopePane(state,controller,action,importPDF,contentScope,{contentScope=it},index,pendingDirectory,{pendingDirectory=false},searchMemo)}
}
private data class LibraryProjectionRequest(val index:WebsiteLibraryIndex?,val papers:List<Paper>,val criteria:WebsiteLibraryCriteria,val direction:WebsiteDirection)
private data class LibraryProjection(val request:LibraryProjectionRequest,val view:WebsiteLibraryView)

@OptIn(ExperimentalMaterial3Api::class,ExperimentalLayoutApi::class)
@Composable private fun LibraryScopePane(state:UiState,controller:AppController,action:Action,importPDF:()->Unit,filter:String,onScope:(String)->Unit,index:WebsiteLibraryIndex?,openDirectory:Boolean,consumeDirectory:()->Unit,searchMemo:CachedGuideSearchMemo){
    var from by rememberSaveable{mutableStateOf("")};var until by rememberSaveable{mutableStateOf("")};var dateTarget by rememberSaveable{mutableStateOf<String?>(null)}
    var source by rememberSaveable{mutableStateOf("")};var minimum by rememberSaveable{mutableStateOf("")};var query by rememberSaveable{mutableStateOf("")}
    var sort by rememberSaveable{mutableStateOf(if(filter=="收藏")"收藏时间"else"最新")};var monthly by rememberSaveable{mutableStateOf(false)}
    var selectedDirections by rememberSaveable{mutableStateOf(listOf<String>())};var subtree by rememberSaveable{mutableStateOf(true)};var primary by rememberSaveable{mutableStateOf(false)}
    var domain by rememberSaveable{mutableStateOf("all")};var research by rememberSaveable{mutableStateOf("all")};var unclassified by rememberSaveable{mutableStateOf(false)}
    var directoryFacet by rememberSaveable{mutableStateOf("task")};var directoryParent by rememberSaveable{mutableStateOf("")};var directoryQuery by rememberSaveable{mutableStateOf("")}
    var directoryOpen by rememberSaveable{mutableStateOf(false)};var showFilters by rememberSaveable{mutableStateOf(false)};var showSearchInfo by rememberSaveable{mutableStateOf(false)}
    var choosing by rememberSaveable{mutableStateOf(false)};var picked by rememberSaveable{mutableStateOf(listOf<String>())};var tools by remember{mutableStateOf(false)}
    var infoPaperID by rememberSaveable{mutableStateOf<String?>(null)}
    LaunchedEffect(openDirectory){if(openDirectory){directoryOpen=true;consumeDirectory()}}
    val directoryScroll=rememberLazyListState()
    val changeDirectoryFacet:(String)->Unit={if(it!=directoryFacet){directoryFacet=it;directoryScroll.requestScrollToItem(0)}}
    val changeDirectoryParent:(String)->Unit={if(it!=directoryParent){directoryParent=it;directoryScroll.requestScrollToItem(0)}}
    val changeDirectoryQuery:(String)->Unit={if(it!=directoryQuery){directoryQuery=it;directoryScroll.requestScrollToItem(0)}}
    val favoriteIDs=remember(state.personal){state.personal.ids("favorites").toSet()};val readingIDs=remember(state.personal){state.personal.ids("reading").toSet()}
    val favoriteView=remember(state.personal){FavoriteCollections.view(state.personal)}
    val scoped=remember(state.papers,filter,favoriteIDs,readingIDs,state.offlinePaperIDs){state.papers.filter{when(filter){"收藏"->it.id in favoriteIDs;"待读"->it.id in readingIDs;"离线"->it.id in state.offlinePaperIDs;else->true}}}
    var retry by remember{mutableIntStateOf(0)}
    fun retrySearch(){searchMemo.forget(query);retry++}
    val cachedSearch=rememberCachedGuideSearch(controller,query,retry,Triple(state.catalogSyncedAt to state.offlinePaperIDs,state.papers,state.article?.revisionSHA256),searchMemo)
    val privateProjection by produceState<Triple<String,JSONObject,Set<String>>?>(null,query,state.personal){val captured=state.personal;value=withContext(Dispatchers.Default){Triple(query,captured,privateLibraryHits(captured,query))}}
    val personalHits=privateProjection?.takeIf{it.first==query&&it.second===state.personal}?.third.orEmpty()
    val direction=remember(selectedDirections,subtree,primary,domain,research,unclassified){WebsiteDirection(selectedDirections.toSet(),subtree,primary,domain,research,unclassified)}
    val updateDirection:(WebsiteDirection)->Unit={selectedDirections=it.ids.toList();subtree=it.subtree;primary=it.primary;domain=it.domain;research=it.research;unclassified=it.unclassified}
    val criteria=remember(source,minimum,query,personalHits,cachedSearch.result,from,until){WebsiteLibraryCriteria(source=source,minimum=minimum,query=query,personalHits=personalHits,cachedHits=cachedSearch.result?.paperIDs.orEmpty(),from=from,until=until)}
    val request=remember(index,scoped,criteria,direction){LibraryProjectionRequest(index,scoped,criteria,direction)}
    val projection by produceState<LibraryProjection?>(null,request){val captured=request;val current=captured.index;if(current!=null)value=withContext(Dispatchers.Default){LibraryProjection(captured,current.select(captured.papers,captured.criteria,captured.direction))}}
    val ready=projection?.request===request
    val fallback=query.isBlank()&&source.isBlank()&&minimum.isBlank()&&direction==WebsiteDirection()
    val view=if(ready)projection!!.view else WebsiteLibraryView(if(fallback)scoped else emptyList(),emptyMap(),0)
    val papers=remember(view.papers,sort){if(sort=="评分")view.papers.sortedByDescending{it.score?:-1.0}else view.papers.sortedByDescending{it.date}}
    val zone=ZoneId.systemDefault();val today=LocalDate.now(zone)
    val sections=remember(papers,favoriteView,monthly,sort,zone,today){if(filter=="收藏"&&sort=="收藏时间")favoriteLibrarySections(papers,favoriteView,monthly,zone,today)else listOf(FavoriteLibrarySection("all","",papers))}
    val scroll=rememberLazyListState();val loadingScroll=rememberLazyListState();val key=JSONArray(listOf(query,source,minimum,from,until,sort,monthly.toString(),selectedDirections.sorted().joinToString(),subtree.toString(),primary.toString(),domain,research,unclassified.toString())).toString()
    var applied by rememberSaveable{mutableStateOf(key)}
    SideEffect{if(key!=applied){applied=key;scroll.requestScrollToItem(0)}}
    val visibleIDs=remember(papers){papers.mapTo(HashSet()){it.id}};val hiddenPicked=picked.count{it !in visibleIDs};val keyboard=LocalSoftwareKeyboardController.current
    val active=selectedDirections.size+listOf(source,minimum,from,until).count{it.isNotEmpty()}+(if(domain!="all")1 else 0)+(if(research!="all")1 else 0)+(if(unclassified)1 else 0)
    val retiredIDs=remember(state.catalogSummary){state.catalogSummary.ids("missingFromLatest").toSet()}
    val unknownCached=remember(state.papers,cachedSearch.result){val catalogIDs=state.papers.mapTo(HashSet()){it.id};cachedSearch.result?.paperIDs?.count{it !in catalogIDs}?:0}
    val localCount=remember(state.papers){state.papers.count{it.sourceKind=="local"}}
    val title=when(filter){"收藏"->"我的收藏";"待读"->"待读清单";"离线"->"本机已保存";else->"论文库"}
    fun reset(){source="";minimum="";from="";until="";updateDirection(WebsiteDirection())}
    NonOccludingViewport{
        val height=maxHeight;val wide=maxWidth>=840.dp
        Row(Modifier.fillMaxSize()){
            if(wide)Surface(Modifier.width(300.dp).fillMaxHeight().padding(start=16.dp,top=12.dp,bottom=12.dp),shape=MaterialTheme.shapes.large,color=MaterialTheme.colorScheme.surfaceContainerLow){
                WebsiteDirectoryPanel(state.websiteTaxonomy,view,direction,updateDirection,directoryFacet,changeDirectoryFacet,directoryParent,changeDirectoryParent,directoryQuery,changeDirectoryQuery,directoryScroll,Modifier.fillMaxSize(),!ready)
            }
            Box(Modifier.weight(1f).fillMaxHeight(),contentAlignment=Alignment.TopCenter){
                LazyColumn(Modifier.widthIn(max=920.dp).fillMaxHeight().testTag("library-results"),state=if(ready||fallback)scroll else loadingScroll,contentPadding=PaddingValues(horizontal=if(wide)24.dp else 18.dp,vertical=12.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
                    item("library-heading"){Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){Column(Modifier.weight(1f)){Text(title,style=MaterialTheme.typography.headlineSmall);Text(if(filter=="全部")"${String.format("%,d",state.papers.size)} 篇论文 · 网站完整研究方向"else when(filter){"收藏"->"已收藏 ${scoped.size} 篇 · 分类与收藏时间";"待读"->"${scoped.size} 篇待读论文";else->"${scoped.size} 篇已有导读或原文"},style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)};Box{IconButton({tools=true}){Icon(Icons.Outlined.MoreHoriz,"论文库操作")};DropdownMenu(tools,{tools=false}){DropdownMenuItem({Text("同步已发布内容")},{tools=false;action("library.sync",JSONObject())},leadingIcon={Icon(Icons.Outlined.Sync,null)},enabled=!state.loading);DropdownMenuItem({Text("导入 PDF")},{tools=false;importPDF()},leadingIcon={Icon(Icons.Outlined.FileOpen,null)});DropdownMenuItem({Text("网站全部成果")},{tools=false;action("ui.resources",JSONObject())},leadingIcon={Icon(Icons.Outlined.Language,null)})}}}}
                    item("scope"){LazyRow(horizontalArrangement=Arrangement.spacedBy(7.dp)){items(listOf("全部","收藏","待读","离线")){choice->FilterChip(filter==choice,{onScope(choice)},label={Text(choice)})}}}
                    item("personal-sync") {
                        OutlinedButton({
                            if (state.cloud.optString("account").isBlank()) action("ui.settings", obj("pane" to "坚果云"))
                            else action("cloud.syncWorkspace", JSONObject())
                        }, enabled = !state.busy && !state.settings.optBoolean("offlineMode")) {
                            Icon(Icons.Outlined.Sync, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("一键同步 WebDAV")
                        }
                    }
                    item("search"){OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),singleLine=true,placeholder={Text("论文、作者、编号或笔记")},leadingIcon={Icon(Icons.Outlined.Search,null)},trailingIcon={if(query.isNotEmpty())IconButton({query=""}){Icon(Icons.Outlined.Close,"清除搜索")}},keyboardOptions=androidx.compose.foundation.text.KeyboardOptions(imeAction=androidx.compose.ui.text.input.ImeAction.Search),keyboardActions=androidx.compose.foundation.text.KeyboardActions(onSearch={keyboard?.hide()}))}
                    item("controls"){Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)){
                        if(!wide)OutlinedButton({directoryOpen=true},contentPadding=PaddingValues(horizontal=12.dp)){Icon(Icons.Outlined.AccountTree,null,Modifier.size(18.dp));Spacer(Modifier.width(6.dp));Text(if(selectedDirections.isEmpty())"研究方向"else"方向 ${selectedDirections.size}")}
                        TextButton({showFilters=true}){Icon(Icons.Outlined.Tune,null,Modifier.size(18.dp));Spacer(Modifier.width(4.dp));Text(if(active==0)"筛选与排序 · $sort"else"筛选 $active · $sort",style=MaterialTheme.typography.labelMedium)}
                        Spacer(Modifier.weight(1f));IconButton({showSearchInfo=true}){Icon(Icons.Outlined.Info,"目录与检索范围",Modifier.size(20.dp))}
                    }}
                    if(source.isNotBlank()||minimum.isNotBlank()||from.isNotBlank()||until.isNotBlank()||domain!="all"||research!="all"||primary||!subtree)item("applied-summary"){
                        Text(listOfNotNull(source.takeIf{it.isNotBlank()}?.let{librarySourceLabel(it)},minimum.takeIf{it.isNotBlank()}?.let{"最低 $it 分"},if(from.isNotBlank()||until.isNotBlank())"网站发布日期 ${from.ifEmpty{"不限"}} — ${until.ifEmpty{"不限"}}"else null,domain.takeIf{it!="all"}?.let{websiteDomainLabels[it]},research.takeIf{it!="all"}?.let{websiteResearchLabels[it]},if(primary)"仅主要角色"else null,if(!subtree)"仅直接标签"else null).joinToString(" · "),style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
                        if(from.isNotBlank()&&until.isNotBlank()&&from>until)TextButton({showFilters=true}){Text("起始日期晚于结束日期，调整范围",color=MaterialTheme.colorScheme.error)}
                    }
                    if(selectedDirections.isNotEmpty())item("selected-directions"){LazyRow(horizontalArrangement=Arrangement.spacedBy(6.dp)){items(selectedDirections,key={it}){id->InputChip(true,{updateDirection(direction.copy(ids=direction.ids-id))},label={Text(state.websiteTaxonomy?.nodes?.get(id)?.label?:id)},trailingIcon={Icon(Icons.Outlined.Close,"移除方向：${state.websiteTaxonomy?.nodes?.get(id)?.label?:id}",Modifier.size(14.dp))})}}}
                    item("status"){Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){Text(if(!ready)"正在更新结果…"else"${papers.size} 篇匹配",Modifier.weight(1f),style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant);TextButton({choosing=!choosing;if(!choosing)picked=emptyList()}){Text(if(choosing)"完成多选"else"多选",style=MaterialTheme.typography.labelMedium)}};if(!ready)LinearProgressIndicator(Modifier.fillMaxWidth());if(cachedSearch.loading)Text("正在补查本机导读…",style=MaterialTheme.typography.labelSmall)
                        cachedSearch.result?.let{r->if(query.isNotBlank())Text(if(r.scanned==0)"尚无可检索的已保存导读；当前只匹配论文信息与笔记。"else"已检查 ${r.scanned} 份本机导读，正文命中 ${r.paperIDs.size} 篇。"+(if(r.unavailable>0)" 另有 ${r.unavailable} 份缓存不可读。"else""),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)}
                        cachedSearch.error?.let{Text(it,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.error);TextButton({retrySearch()}){Text("重试本机导读检索")}}}
                    if(state.websiteTaxonomy==null&&selectedDirections.isEmpty())item("taxonomy-status"){TextButton({action("library.sync",JSONObject())}){Icon(Icons.Outlined.CloudDownload,null,Modifier.size(18.dp));Spacer(Modifier.width(6.dp));Text("同步网站，开启完整方向目录",style=MaterialTheme.typography.labelMedium)}}
                    if(state.catalogSummary.optString("websiteTaxonomyStatus")=="cached-unavailable")item("cached-taxonomy"){Text("分类资料暂未更新，正在使用上次保存的词表。",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.tertiary)}
                    if(favoriteView.readOnly&&(filter=="收藏"||choosing))item("favorite-readonly"){Text("收藏数据由较新版本保存；更新应用后可编辑，现有收藏仍可阅读。",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.tertiary)}
                    if(filter=="收藏")item("favorite-time"){Row(verticalAlignment=Alignment.CenterVertically){if(sort=="收藏时间"){FilterChip(!monthly,{monthly=false},label={Text("按近期分区")});Spacer(Modifier.width(6.dp));FilterChip(monthly,{monthly=true},label={Text("按月份分区")})}}}
                    if(choosing)item("selection"){Column(verticalArrangement=Arrangement.spacedBy(4.dp)){
                        Text("已选 ${picked.size} 篇"+if(!ready)"，正在更新结果"else if(hiddenPicked>0)"，其中 $hiddenPicked 篇不在当前结果中"else"",style=MaterialTheme.typography.labelMedium)
                        FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)){TextButton({picked=(picked+papers.map{it.id}).distinct()},enabled=ready){Text("加选匹配 ${papers.size} 篇")};TextButton({picked=emptyList()},enabled=picked.isNotEmpty()){Text("清空选择")};if(hiddenPicked>0)TextButton({val visible=papers.map{it.id}.toSet();picked=picked.filter{it in visible}},enabled=ready){Text("仅保留当前结果内已选")};TextButton({action("personal.list.edit",obj("key" to "favorites","action" to "add","ids" to JSONArray(picked)))},enabled=picked.isNotEmpty()&&!favoriteView.readOnly){Text("收藏 ${picked.size} 篇")};TextButton({action("personal.list.edit",obj("key" to "reading","action" to "add","ids" to JSONArray(picked)))},enabled=picked.isNotEmpty()){Text("加入待读")};if(filter=="收藏")TextButton({action("personal.list.edit",obj("key" to "favorites","action" to "remove","ids" to JSONArray(picked)))},enabled=picked.isNotEmpty()&&!favoriteView.readOnly){Text("取消所选收藏")}}
                    }}
                    if(ready&&papers.isEmpty())item("empty"){
                        EmptyPane(if(scoped.isEmpty()&&filter=="收藏")"还没有收藏"else if(scoped.isEmpty()&&filter=="待读")"待读清单为空"else"当前搜索或筛选没有匹配",if(scoped.isEmpty())"收藏、待读和本机资料保留独立入口；同步网站或导入 PDF 即可开始。"else"所选方向与已有资料仍保留。可以调整条件，或清除搜索和筛选。")
                        if(query.isNotEmpty()||active>0)TextButton({query="";reset()}){Text("清除搜索和筛选")}
                    }
                    sections.forEach{section->
                        if(section.label.isNotEmpty())item("favorite-section-${section.key}"){Text("${section.label} · ${section.papers.size} 篇",style=MaterialTheme.typography.titleSmall,modifier=Modifier.padding(top=8.dp))}
                        items(section.papers,key={it.id}){paper->
                            val matches=view.matchingGuides[paper.id].orEmpty();val otherGuide=matches.isNotEmpty()&&matches.none{it.url==paper.blogURL};val matchedGuide=matches.firstOrNull{it.url==paper.blogURL}?:matches.firstOrNull();val cardAuthors=matchedGuide?.authors?:paper.authors;val cardScore=matchedGuide?.score?:if(otherGuide)null else paper.score
                            Card(onClick={if(choosing)picked=if(paper.id in picked)picked-paper.id else picked+paper.id else if(otherGuide)infoPaperID=paper.id else action("paper.open",obj("paperID" to paper.id))},enabled=ready,colors=CardDefaults.cardColors(containerColor=MaterialTheme.colorScheme.surfaceContainerLow),shape=MaterialTheme.shapes.medium,modifier=Modifier.fillMaxWidth()){
                                Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
                                    Row(verticalAlignment=Alignment.CenterVertically){if(choosing)Checkbox(paper.id in picked,{checked->picked=if(checked)(picked+paper.id).distinct()else picked-paper.id});Text(matchedGuide?.date?:paper.date,style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant);Spacer(Modifier.weight(1f));cardScore?.let{Surface(color=MaterialTheme.colorScheme.primaryContainer,shape=MaterialTheme.shapes.extraSmall){Text("$it 分",Modifier.padding(horizontal=8.dp,vertical=3.dp),style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onPrimaryContainer)}}}
                                    if(paper.id in retiredIDs)Text("本机保留 · 未列入最新网站快照（不表示撤稿）",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.tertiary)
                                    Text(if(otherGuide)matches.first().title.ifBlank{paper.titleZh}else paper.titleZh,style=MaterialTheme.typography.titleMedium,fontWeight=FontWeight.SemiBold,maxLines=3,overflow=TextOverflow.Ellipsis)
                                    if(cardAuthors.isNotEmpty())Text(cardAuthors.take(3).joinToString(" · "),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant,maxLines=1,overflow=TextOverflow.Ellipsis)
                                    (if(matchedGuide!=null)matchedGuide.paths.firstOrNull()else index?.paths?.get(paper.id)?.firstOrNull()?.joinToString(" › "){it.label})?.let{path->Text(path,style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.primary,maxLines=1,overflow=TextOverflow.Ellipsis)}
                                    if(paper.id in personalHits||paper.id in criteria.cachedHits)Text("正文、笔记或批注匹配",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.tertiary)
                                    if(filter=="收藏")Text(favoriteAddedLabel(favoriteView.items[paper.id]?.addedAt,zone),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                                    Row(verticalAlignment=Alignment.CenterVertically){Text(if(otherGuide)"筛选命中了另一份已发布导读"else paperSourceLabel(paper),Modifier.weight(1f),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant,maxLines=1,overflow=TextOverflow.Ellipsis);IconButton({infoPaperID=paper.id},Modifier.size(36.dp)){Icon(Icons.Outlined.MoreHoriz,"论文信息与全部已发布导读",Modifier.size(18.dp))}}
                                }
                            }
                        }
                    }
                }
            }
        }
        if(directoryOpen&&!wide)ModalBottomSheet(onDismissRequest={directoryOpen=false},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)){
            Column(Modifier.fillMaxWidth().heightIn(max=height*0.96f)){
                WebsiteDirectoryPanel(state.websiteTaxonomy,view,direction,updateDirection,directoryFacet,changeDirectoryFacet,directoryParent,changeDirectoryParent,directoryQuery,changeDirectoryQuery,directoryScroll,Modifier.weight(1f),!ready)
                Surface(Modifier.testTag("website-directory-footer"),shadowElevation=3.dp){Button({directoryOpen=false;keyboard?.hide()},Modifier.fillMaxWidth().padding(horizontal=18.dp,vertical=10.dp)){Text(if(ready)"查看 ${papers.size} 篇论文"else"正在更新结果…")}}
            }
        }
        if(showFilters)ModalBottomSheet(onDismissRequest={showFilters=false},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)){
            Column(Modifier.fillMaxWidth().heightIn(max=height).verticalScroll(rememberScrollState()).padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
                Text("筛选与排序",style=MaterialTheme.typography.titleLarge)
                FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)){(if(filter=="收藏")listOf("收藏时间","最新","评分")else listOf("最新","评分")).forEach{choice->FilterChip(sort==choice,{sort=choice},label={Text(choice)})}}
                LibrarySourceChoice(state.papers.map{it.sourceKind}.distinct().sorted(),source,{source=it});FilterChoice("最低评分",listOf("5","6","7","8","9"),minimum,{minimum=it})
                Text("网站导读发布日期",style=MaterialTheme.typography.titleSmall)
                Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){OutlinedButton({dateTarget="from"},Modifier.weight(1f)){Text("起始 · ${from.ifEmpty{"不限"}}")};OutlinedButton({dateTarget="until"},Modifier.weight(1f)){Text("结束 · ${until.ifEmpty{"不限"}}")}}
                if(from.isNotEmpty()&&until.isNotEmpty()&&from>until){Text("起始日期晚于结束日期，请调整范围。",color=MaterialTheme.colorScheme.error);TextButton({val old=from;from=until;until=old}){Text("交换起止日期")}}
                Text("任务、方法与其他研究方向在完整目录中选择。",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton({reset()}){Text("清除筛选（保留搜索和排序）")}
                Button({showFilters=false},Modifier.fillMaxWidth()){Text("查看 ${papers.size} 篇结果")}
            }
        }
        if(showSearchInfo)AlertDialog(onDismissRequest={showSearchInfo=false},title={Text("目录与检索范围")},text={Column(Modifier.heightIn(max=height*0.7f).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(10.dp)){
            Text(catalogMessage(state.catalogSummary,localCount));Text("九个分类维度来自网站完整词表，零结果方向仍显示。网站元数据查询、来源、评分与分类由同一份导读满足；本机正文、私人笔记和批注按论文匹配，并在结果中标明。")
            Text(when{cachedSearch.loading->"正在补查本机缓存导读。";cachedSearch.error!=null->"缓存检索未完成，当前不计入未确认的命中。";cachedSearch.result?.scanned==0->"尚无可检索的已保存导读；当前只匹配论文信息与笔记。";else->"可检索论文信息、私人笔记与已保存导读；未下载正文和 PDF 全文不在范围内。"})
            if(unknownCached>0)Text("另有 $unknownCached 个本机正文命中缺少当前目录条目，保存的原件仍保留。",style=MaterialTheme.typography.bodySmall)
            if(cachedSearch.error!=null)TextButton({retrySearch()}){Text("重试本机导读检索")}
        }},confirmButton={TextButton({showSearchInfo=false}){Text("关闭")}})
        dateTarget?.let{target->
            val initial=(if(target=="from")from else until).takeIf{it.isNotEmpty()}?.let{java.time.LocalDate.parse(it).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli()}
            val dateState=rememberDatePickerState(initialSelectedDateMillis=initial)
            DatePickerDialog(onDismissRequest={dateTarget=null},confirmButton={TextButton({val selected=dateState.selectedDateMillis;if(selected!=null){val date=java.time.Instant.ofEpochMilli(selected).atZone(java.time.ZoneOffset.UTC).toLocalDate().toString();if(target=="from")from=date else until=date};dateTarget=null},enabled=dateState.selectedDateMillis!=null){Text("确定")}},dismissButton={Row{TextButton({if(target=="from")from=""else until="";dateTarget=null}){Text("清除日期")};TextButton({dateTarget=null}){Text("取消")}}}){DatePicker(dateState,title={Text(if(target=="from")"起始发布日期"else"结束发布日期",Modifier.padding(20.dp))})}
        }
        infoPaperID?.let{id->state.papers.firstOrNull{it.id==id}?.let{paper->PublishedGuidesDialog(paper,view.matchingGuides[id].orEmpty(),{infoPaperID=null},{infoPaperID=null;action("paper.open",obj("paperID" to paper.id))})}}
    }
}

@Composable internal fun PublishedGuidesDialog(paper:Paper,matches:List<PublishedGuideLink>,close:()->Unit,openDefault:()->Unit){
    val context=LocalContext.current;var error by remember{mutableStateOf<String?>(null)}
    AlertDialog(onDismissRequest=close,title={Text("论文与已发布导读")},text={Column(Modifier.heightIn(max=460.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(10.dp)){
        Text(paper.titleZh,style=MaterialTheme.typography.titleMedium);if(paper.title!=paper.titleZh)Text(paper.title,style=MaterialTheme.typography.bodySmall);Text(paper.authors.joinToString(" · "),style=MaterialTheme.typography.bodySmall)
        if(matches.isNotEmpty()&&matches.none{it.url==paper.blogURL})Text("当前筛选命中了这篇论文的其他导读。可在网站打开对应页面；本机默认导读仍单独保留。",style=MaterialTheme.typography.bodySmall)
        paper.appearances.ifEmpty{listOf(paper.blogURL)}.filter{it.isNotBlank()}.distinct().forEach{address->val safe=runCatching{CatalogRepository.sameSite(address)}.getOrNull();if(safe!=null){
            val record=WebsiteTaxonomy.records(paper).firstOrNull{runCatching{CatalogRepository.sameSite(it.optString("permalink"))}.getOrNull()==safe}
            OutlinedButton({try{context.startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(safe)))}catch(_:Exception){error="此设备没有可打开网站的应用。"}},Modifier.fillMaxWidth()){
                Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(3.dp)){Text(record?.optString("titleZh")?.ifBlank{null}?:record?.optString("title")?.ifBlank{null}?:"已发布导读",maxLines=2,overflow=TextOverflow.Ellipsis);Text((record?.optString("date").orEmpty())+if(matches.any{it.url==safe})" · 当前条件匹配"else"",style=MaterialTheme.typography.labelSmall);Text(safe,style=MaterialTheme.typography.labelSmall,maxLines=2,overflow=TextOverflow.Ellipsis)}
            }
        }}
        error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
    }},confirmButton={TextButton(openDefault){Text("阅读本机默认导读")}},dismissButton={TextButton(close){Text("关闭")}})
}

internal fun librarySourceLabel(kind:String)=when(kind){"arxiv"->"arXiv";"conference"->"正式会议";"local"->"本机 PDF";"unknown","unverified",""->"待核验来源";else->"其他来源"}
@Composable private fun LibrarySourceChoice(options:List<String>,value:String,change:(String)->Unit){var open by remember{mutableStateOf(false)};Box{OutlinedButton({open=true}){Text("来源 · "+if(value.isEmpty())"全部"else librarySourceLabel(value));Icon(Icons.Outlined.ExpandMore,null)};DropdownMenu(open,{open=false}){DropdownMenuItem({Text("全部来源")},{change("");open=false});options.forEach{option->DropdownMenuItem({Text(librarySourceLabel(option))},{change(option);open=false})}}}}
