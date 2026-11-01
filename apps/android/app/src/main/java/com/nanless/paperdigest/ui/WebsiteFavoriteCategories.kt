package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.data.WebsiteTaxonomy

internal class WebsiteFavoriteIndex(val taxonomy:WebsiteTaxonomy?,papers:List<Paper>) {
    val paths=papers.associate { it.id to taxonomy?.paths(it).orEmpty() }
    val counts=linkedMapOf<String,Int>().also { counts->paths.values.forEach { paths->paths.flatten().map {it.id}.toSet().forEach{counts[it]=(counts[it]?:0)+1} } }
    val unclassified=paths.values.count{it.isEmpty()}
    fun matches(id:String,category:String)=when(category){""->true;"unclassified"->paths[id].isNullOrEmpty();else->paths[id].orEmpty().any {path->path.any{it.id==category}}}
    /** A classification and ordinary metadata constraints must be satisfied by the same guide. */
    fun matchesCriteria(paper:Paper,category:String,source:String,minimum:String,query:String,personalSearchHit:Boolean):Boolean {
        if(category=="unclassified"&&!paths[paper.id].isNullOrEmpty())return false
        val records=WebsiteTaxonomy.records(paper)
        if(records.isEmpty())return matches(paper.id,category)&&(source.isEmpty()||paper.sourceKind==source)&&(minimum.isEmpty()||(paper.score?:-1.0)>=(minimum.toDoubleOrNull()?:0.0))&&(personalSearchHit||matchesLibrarySearch(paper,query,null))
        return records.any { row ->
            val kind=row.optString("sourceKind",row.optJSONObject("citation")?.optString("sourceKind",paper.sourceKind)?:paper.sourceKind)
            val score=Paper.score(row.opt("score"))
            val concepts=taxonomy?.classify(row)?.concepts.orEmpty()
            (source.isEmpty()||kind==source)&&(minimum.isEmpty()||(score?:-1.0)>=(minimum.toDoubleOrNull()?:0.0))&&
                (category.isEmpty()||category=="unclassified"||concepts.any{it.id==category||category in it.ancestors})&&
                (personalSearchHit||query.isBlank()||run {
                    val needle=query.trim()
                    val metadata=listOf(paper.id)+listOf("title","titleZh","originalTitle","summary","task","method","date","sourceKind","permalink","arxivId").map{row.optString(it)}+
                        row.optJSONArray("tags")?.let{(0 until it.length()).map(it::optString)}.orEmpty()+
                        row.optJSONObject("citation")?.optJSONArray("authors")?.let{(0 until it.length()).map(it::optString)}.orEmpty()+
                        concepts.flatMap{(it.ancestors+it.id).map{node->taxonomy!!.nodes.getValue(node).label}}
                    metadata.any{it.contains(needle,true)}
                })
        }
    }
    fun label(category:String)=when(category){""->"全部网站分类";"unclassified"->"网站分类未就绪";else->taxonomy?.nodes?.get(category)?.label?:"全部网站分类"}
    fun explanation(paper:Paper):String=when(taxonomy?.status(paper)) {
        "verified"->"网站未提供可显示的分类"
        "withheld"->"网站暂缓展示该论文分类"
        "legacy","missing"->"网站未提供已核验的多级分类；同步可检查最新资料"
        "unknown-version","unbound-version"->"本机缺少该论文的分类词表版本，请同步网站资料"
        "invalid-roles","invalid"->"网站分类来源暂不可验证，请同步后再查看"
        else->"本机缺少网站分类资料，请同步已发布内容"
    }
}

/** One website node at a time, including its descendants; counts deduplicate paper identities. */
@OptIn(ExperimentalMaterial3Api::class,ExperimentalLayoutApi::class)
@Composable internal fun WebsiteFavoriteCategoryPicker(index:WebsiteFavoriteIndex,selected:String,onSelect:(String)->Unit,close:()->Unit) {
    val availableFacets=WebsiteTaxonomy.facets.keys.filter {facet->index.taxonomy?.nodes?.values?.any{it.facet==facet&&(index.counts[it.id]?:0)>0}==true}
    var facet by rememberSaveable {mutableStateOf(index.taxonomy?.nodes?.get(selected)?.facet?.takeIf{it in availableFacets}?:availableFacets.firstOrNull().orEmpty())}
    var parent by rememberSaveable {mutableStateOf(index.taxonomy?.nodes?.get(selected)?.ancestors?.lastOrNull().orEmpty())}
    val graph=index.taxonomy
    LaunchedEffect(availableFacets){if(facet !in availableFacets){facet=availableFacets.firstOrNull().orEmpty();parent=""}}
    ModalBottomSheet(onDismissRequest=close,sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)) {
        Column(Modifier.fillMaxWidth().heightIn(max=620.dp).verticalScroll(rememberScrollState()).padding(20.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
            Text("按网站分类浏览收藏",style=MaterialTheme.typography.titleLarge)
            Text("沿用网页的原有分类；选择一个节点时包含其子分类，每篇论文只计一次。",style=MaterialTheme.typography.bodySmall)
            TextButton({onSelect("");close()}){Text("全部网站分类")}
            if(index.unclassified>0)TextButton({onSelect("unclassified");close()}){Text("网站分类未就绪 · ${index.unclassified} 篇")}
            if(graph==null)Text("本机缺少网站分类资料。关闭后同步已发布内容即可读取，现有收藏和时间保留。")
            else {
                FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)) { WebsiteTaxonomy.facets.forEach {(id,label)->
                    val count=graph.nodes.values.filter{it.facet==id&&it.ancestors.isEmpty()}.sumOf{index.counts[it.id]?:0}
                    if(count>0)FilterChip(facet==id,{facet=id;parent=""},label={Text(label)})
                } }
                val trail=graph.nodes[parent]?.let {(it.ancestors+it.id).map(graph.nodes::getValue)}.orEmpty()
                FlowRow(horizontalArrangement=Arrangement.spacedBy(4.dp)) {
                    TextButton({parent=""}){Text(WebsiteTaxonomy.facets[facet].orEmpty())}
                    trail.forEach {node->TextButton({parent=node.id}){Text("› ${node.label}")}}
                }
                if(parent.isNotEmpty())TextButton({onSelect(parent);close()}){Text("选择此分类及子分类 · ${index.counts[parent]?:0} 篇")}
                graph.nodes.values.filter {it.active&&it.facet==facet&&it.ancestors.lastOrNull().orEmpty()==parent&&(index.counts[it.id]?:0)>0}.forEach {node->
                    Row(Modifier.fillMaxWidth(),verticalAlignment=androidx.compose.ui.Alignment.CenterVertically) {
                        TextButton({onSelect(node.id);close()},Modifier.weight(1f).semantics{contentDescription="筛选网站分类：${node.label}"}){Text("${node.label} · ${index.counts[node.id]} 篇",Modifier.fillMaxWidth())}
                        if(graph.nodes.values.any {it.ancestors.lastOrNull()==node.id&&(index.counts[it.id]?:0)>0})IconButton({parent=node.id}){Icon(Icons.Outlined.ChevronRight,"展开网站分类：${node.label}")}
                    }
                }
            }
            TextButton(close,Modifier.fillMaxWidth()){Text("关闭")}
        }
    }
}
