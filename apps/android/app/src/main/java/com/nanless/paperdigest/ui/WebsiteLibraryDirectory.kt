package com.nanless.paperdigest.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.data.WebsiteTaxonomy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.text.Normalizer
import java.util.Locale

@Composable internal fun rememberWebsiteLibraryIndex(papers:List<Paper>,taxonomy:WebsiteTaxonomy?):WebsiteLibraryIndex? {
    var memo by remember {mutableStateOf<WebsiteLibraryIndex?>(null)}
    val current by produceState<WebsiteLibraryIndex?>(memo,papers,taxonomy) {
        val cached=memo
        value=if(cached?.hasSameSource(papers,taxonomy)==true)cached else withContext(Dispatchers.Default){
            val context=kotlin.coroutines.coroutineContext
            WebsiteLibraryIndex(taxonomy,papers){context.ensureActive()}
        }.also{memo=it}
    }
    return current?.takeIf{it.hasSameSource(papers,taxonomy)}
}

internal fun websiteDirectoryNodes(taxonomy:WebsiteTaxonomy,facet:String,parent:String,query:String):List<WebsiteTaxonomy.Node> {
    fun normalized(s:String)=Normalizer.normalize(s.trim(),Normalizer.Form.NFKC).lowercase(Locale.ROOT)
    val needle=normalized(query)
    return taxonomy.nodes.values.filter{node->if(needle.isEmpty())node.facet==facet&&node.ancestors.lastOrNull().orEmpty()==parent else
        (listOf(node.id,node.label,node.english,node.description)+node.aliases+node.ancestors.map{taxonomy.nodes.getValue(it).label}).any{normalized(it).contains(needle)}}
}

@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun WebsiteDirectoryPanel(taxonomy:WebsiteTaxonomy?,view:WebsiteLibraryView?,direction:WebsiteDirection,onChange:(WebsiteDirection)->Unit,
    facet:String,onFacet:(String)->Unit,parent:String,onParent:(String)->Unit,query:String,onQuery:(String)->Unit,scroll:LazyListState,modifier:Modifier=Modifier,loading:Boolean=false) {
    val keyboard=LocalSoftwareKeyboardController.current;val focus=LocalFocusManager.current
    val compact=query.isNotBlank()||WindowInsets.ime.getBottom(LocalDensity.current)>0
    var details by rememberSaveable{mutableStateOf<String?>(null)};var advanced by rememberSaveable{mutableStateOf(false)}
    val nodes=remember(taxonomy,facet,parent,query){taxonomy?.let{websiteDirectoryNodes(it,facet,parent,query)}.orEmpty()}
    LazyColumn(modifier.testTag("website-directory"),state=scroll,contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
        if(!compact)item("heading") {Column(verticalArrangement=Arrangement.spacedBy(3.dp)){Text("研究方向",style=MaterialTheme.typography.titleLarge);Text("${taxonomy?.nodes?.size?:0} 个方向 · 九个维度",style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)}}
        item("search") {OutlinedTextField(query,onQuery,Modifier.fillMaxWidth(),singleLine=true,placeholder={Text("搜索目录、英文或别名",style=MaterialTheme.typography.bodyMedium)},leadingIcon={Icon(Icons.Outlined.Search,null)},trailingIcon={if(query.isNotEmpty())IconButton({onQuery("")}){Icon(Icons.Outlined.Close,"清除目录搜索")}},keyboardOptions=KeyboardOptions(imeAction=ImeAction.Search),keyboardActions=KeyboardActions(onSearch={keyboard?.hide()}))}
        if(!compact)item("facets") {LazyRow(Modifier.testTag("website-facets"),horizontalArrangement=Arrangement.spacedBy(6.dp)){items(WebsiteTaxonomy.facets.entries.toList(),key={it.key}){(key,label)->FilterChip(facet==key,{onFacet(key);onParent("");onQuery("")},label={Text("$label ${view?.facetCounts?.get(key)?:0}")},modifier=Modifier.semantics{contentDescription="目录维度：$label"})}}}
        if(!compact)item("options") {Row(verticalAlignment=Alignment.CenterVertically){TextButton({advanced=!advanced},Modifier.weight(1f)){Text((if(direction.subtree)"含子方向"else"仅直接标签")+" · "+if(direction.primary)"仅主要角色"else"任意标签",style=MaterialTheme.typography.labelMedium);Icon(Icons.Outlined.ExpandMore,null,Modifier.size(18.dp))};if(direction.ids.isNotEmpty()||direction.unclassified||direction.domain!="all"||direction.research!="all")TextButton({onChange(WebsiteDirection(subtree=direction.subtree,primary=direction.primary))}){Text("清除")}}}
        if(advanced&&!compact)item("advanced") {Column(verticalArrangement=Arrangement.spacedBy(6.dp)){
            Text("同维度可多选，跨维度组合；条件由同一份导读满足。",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)){FilterChip(direction.subtree,{onChange(direction.copy(subtree=true))},label={Text("含子方向")});FilterChip(!direction.subtree,{onChange(direction.copy(subtree=false))},label={Text("仅直接标签")});FilterChip(!direction.primary,{onChange(direction.copy(primary=false))},label={Text("任意标签")});FilterChip(direction.primary,{onChange(direction.copy(primary=true))},label={Text("仅主要角色")})}
            DirectionChoice("研究范围",linkedMapOf("all" to "全部","in-domain" to "音频研究","cross-domain" to "跨域交叉","adjacent-domain" to "相邻声学","out-of-domain" to "其他领域","unclassified" to "尚未分类"),direction.domain){onChange(direction.copy(domain=it))}
            DirectionChoice("研究类型",linkedMapOf("all" to "全部","engineering" to "工程研究","science" to "科学研究","analysis" to "机制分析","evaluation" to "评测研究","resource" to "研究资源","review" to "综述","experience" to "实践报告","position" to "观点论文","unclassified" to "尚未分类"),direction.research){onChange(direction.copy(research=it))}
        }}
        if(compact)item("search-context"){Row(verticalAlignment=Alignment.CenterVertically){Text("目录搜索 · ${nodes.size} 个方向",Modifier.weight(1f),style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant);TextButton({onQuery("");focus.clearFocus();keyboard?.hide()}){Text("取消搜索")}}}
        if(loading)item("loading"){LinearProgressIndicator(Modifier.fillMaxWidth())}
        if(taxonomy==null)item("missing"){Text("同步已发布内容后，完整目录会保存在本机；已有论文和个人资料仍可阅读。",style=MaterialTheme.typography.bodySmall)}
        else {
            if(query.isBlank()&&!compact)item("breadcrumbs") {FlowRow(verticalArrangement=Arrangement.spacedBy(0.dp)){TextButton({onParent("")}){Text(WebsiteTaxonomy.facets[facet].orEmpty())};taxonomy.nodes[parent]?.let{node->(node.ancestors+node.id).forEach{id->TextButton({onParent(id)}){Text("› ${taxonomy.nodes.getValue(id).label}")}}}}}
            if(parent.isNotEmpty()&&query.isBlank()&&!compact)taxonomy.nodes[parent]?.let{node->item("parent") {Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer,MaterialTheme.shapes.medium).padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
                Row(verticalAlignment=Alignment.CenterVertically){Checkbox(node.id in direction.ids,{checked->onChange(direction.copy(ids=if(checked)direction.ids+node.id else direction.ids-node.id,unclassified=false))},modifier=Modifier.semantics{contentDescription="筛选网站方向：${node.label}"});Text(node.label,Modifier.weight(1f),style=MaterialTheme.typography.titleSmall);Text("${view?.counts?.get(node.id)?:0}",color=MaterialTheme.colorScheme.primary)}
                Text(websiteNodeDescription(node.description),style=MaterialTheme.typography.bodySmall,maxLines=3,overflow=TextOverflow.Ellipsis)
                TextButton({details=node.id}){Text("定义与完整路径",style=MaterialTheme.typography.labelMedium)}
            }}}
            if(nodes.isEmpty())item("empty"){Text(if(query.isBlank())"此方向没有下一级。"else"目录没有匹配项，试试中文名称、英文或别名。",style=MaterialTheme.typography.bodySmall)}
            items(nodes,key={it.id}){node->
                Row(Modifier.testTag("website-node-${node.id}").fillMaxWidth().background(if(node.id in direction.ids)MaterialTheme.colorScheme.primaryContainer.copy(alpha=0.55f)else MaterialTheme.colorScheme.surface,MaterialTheme.shapes.small).heightIn(min=60.dp),verticalAlignment=Alignment.CenterVertically){
                    Checkbox(node.id in direction.ids,{checked->onChange(direction.copy(ids=if(checked)direction.ids+node.id else direction.ids-node.id,unclassified=false))},enabled=node.active,modifier=Modifier.semantics{contentDescription="筛选网站方向：${node.label}"})
                    Column(Modifier.weight(1f).clickable(onClickLabel="浏览方向：${node.label}"){focus.clearFocus();keyboard?.hide();onFacet(node.facet);onParent(node.id);onQuery("")}.padding(vertical=10.dp),verticalArrangement=Arrangement.spacedBy(3.dp)){
                        Text(node.label,style=MaterialTheme.typography.titleSmall)
                        if(query.isNotBlank())Text((node.ancestors+node.id).joinToString(" › "){taxonomy.nodes.getValue(it).label},style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant,maxLines=2,overflow=TextOverflow.Ellipsis)
                        else if(node.english.isNotBlank())Text(node.english,style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant,maxLines=1,overflow=TextOverflow.Ellipsis)
                    }
                    Text("${view?.counts?.get(node.id)?:0}",style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant,modifier=Modifier.padding(horizontal=8.dp))
                    IconButton({focus.clearFocus();keyboard?.hide();onFacet(node.facet);onParent(node.id);onQuery("")}){Icon(Icons.Outlined.ChevronRight,"展开网站方向：${node.label}",Modifier.size(18.dp))}
                }
            }
            item("unclassified"){TextButton({onChange(direction.copy(ids=emptySet(),unclassified=!direction.unclassified))}){Text("分类资料待就绪 · ${view?.unclassified?:0}")}}
        }
    }
    details?.let{id->taxonomy?.nodes?.get(id)?.let{node->AlertDialog(onDismissRequest={details=null},title={Text(node.label)},text={androidx.compose.foundation.text.selection.SelectionContainer{Column(Modifier.heightIn(max=LocalConfiguration.current.screenHeightDp.dp*0.52f).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)){Text((node.ancestors+node.id).joinToString(" › "){taxonomy.nodes.getValue(it).label});if(node.english.isNotBlank())Text(node.english);if(node.aliases.isNotEmpty())Text("别名："+node.aliases.joinToString("、"));Text(websiteNodeDescription(node.description));Text(node.id,style=MaterialTheme.typography.labelSmall)}}},confirmButton={TextButton({details=null}){Text("关闭")}})}}
}
@Composable private fun DirectionChoice(label:String,values:Map<String,String>,value:String,change:(String)->Unit){var open by remember{mutableStateOf(false)};Box{OutlinedButton({open=true},Modifier.fillMaxWidth()){Text("$label · ${values[value].orEmpty()}",Modifier.weight(1f));Icon(Icons.Outlined.ExpandMore,null)};DropdownMenu(open,{open=false}){values.forEach{(key,text)->DropdownMenuItem({Text(text)},{change(key);open=false})}}}}

internal fun websiteNodeDescription(value:String)=value.split(Regex("(?<=[。！？])")).filterNot{it.contains("父节点缺失故成根")||it.contains("按报告指定成根")}.joinToString("").trim()
internal val websiteDomainLabels=mapOf("all" to "全部范围","in-domain" to "音频研究","cross-domain" to "跨域交叉","adjacent-domain" to "相邻声学","out-of-domain" to "其他领域","unclassified" to "范围尚未分类")
internal val websiteResearchLabels=mapOf("all" to "全部类型","engineering" to "工程研究","science" to "科学研究","analysis" to "机制分析","evaluation" to "评测研究","resource" to "研究资源","review" to "综述","experience" to "实践报告","position" to "观点论文","unclassified" to "类型尚未分类")
