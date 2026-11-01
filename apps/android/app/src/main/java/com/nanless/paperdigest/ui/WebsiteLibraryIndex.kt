package com.nanless.paperdigest.ui

import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.data.WebsiteTaxonomy
import org.json.JSONObject
import java.util.Locale

internal data class WebsiteDirection(val ids:Set<String> = emptySet(),val subtree:Boolean=true,val primary:Boolean=false,val domain:String="all",val research:String="all",val unclassified:Boolean=false)
internal data class WebsiteLibraryCriteria(val source:String="",val task:String="",val method:String="",val minimum:String="",val query:String="",val personalHits:Set<String> = emptySet(),val cachedHits:Set<String> = emptySet(),val from:String="",val until:String="")
internal data class PublishedGuideLink(val url:String,val title:String,val date:String,val score:Double?=null,val authors:List<String> = emptyList(),val paths:List<String> = emptyList(),val source:String="")
internal data class WebsiteLibraryView(val papers:List<Paper>,val counts:Map<String,Int>,val unclassified:Int,val facetCounts:Map<String,Int> = emptyMap(),val matchingGuides:Map<String,List<PublishedGuideLink>> = emptyMap(),val countTotal:Int=0)

/** Pure immutable display projection. Construct once per native catalog/record identity, never a source capability. */
internal class WebsiteLibraryIndex(val taxonomy:WebsiteTaxonomy?,private val sourcePapers:List<Paper>,check:()->Unit = {}) {
    private data class Guide(val nodes:List<WebsiteTaxonomy.Node>,val primary:Map<String,Set<String>>,val domain:String,val research:String,
        val source:String,val task:String,val method:String,val score:Double?,val search:List<String>,val status:String,val link:PublishedGuideLink?,val date:String,val permalink:String)
    private val recordArrays=sourcePapers.map{it.original?.optJSONArray("websiteTagRecords")}
    private val guides=sourcePapers.associate {paper->check();paper.id to WebsiteTaxonomy.records(paper).map {row->
        check();val classification=taxonomy?.classify(row);val nodes=classification?.concepts.orEmpty();val direct=nodes.map{it.id}.toSet()
        val primary=linkedMapOf<String,Set<String>>()
        listOf("task" to "primaryTaskId","method" to "primaryMethodId").forEach{(facet,key)->row.optString(key).takeIf{it in direct&&taxonomy?.nodes?.get(it)?.facet==facet}?.let{primary[facet]=setOf(it)}}
        val role=row.optJSONObject("primaryResearchRole")
        val classified=(row.optString("tagClassificationContract").isNotEmpty()||row.optString("taxonomyClassificationContract").isNotEmpty())&&classification?.status=="verified"&&row.optString("researchType").isNotEmpty()&&role!=null&&role.optString("conceptId") in direct
        if(classified)primary[role!!.optString("kind")]=setOf(role.optString("conceptId"))
        val search=listOf(paper.id)+listOf("title","titleZh","originalTitle","summary","task","method","date","sourceKind","permalink","arxivId").map{row.optString(it)}+
            row.optJSONArray("tags")?.let{(0 until it.length()).map(it::optString)}.orEmpty()+row.optJSONObject("citation")?.optJSONArray("authors")?.let{(0 until it.length()).map(it::optString)}.orEmpty()+
            nodes.flatMap{(it.ancestors+it.id).map{node->taxonomy!!.nodes.getValue(node).label}}
        Guide(nodes,primary,if(classified)row.optString("domainScope")else"",if(classified)row.optString("researchType")else"",
            row.optString("sourceKind",row.optJSONObject("citation")?.optString("sourceKind",paper.sourceKind)?:paper.sourceKind),row.optString("task"),row.optString("method"),Paper.score(row.opt("score")),search.map{it.lowercase(Locale.ROOT)},classification?.status?:"missing",runCatching{com.nanless.paperdigest.data.CatalogRepository.sameSite(row.getString("permalink"))}.getOrNull()?.takeIf{it in paper.appearances||it==paper.blogURL}?.let{PublishedGuideLink(it,row.optString("titleZh",row.optString("title")),row.optString("date"),Paper.score(row.opt("score")),row.optJSONObject("citation")?.optJSONArray("authors")?.let{a->(0 until a.length()).map(a::optString)}.orEmpty(),nodes.map{n->(n.ancestors+n.id).joinToString(" › "){id->taxonomy!!.nodes.getValue(id).label}},row.optString("sourceKind"))},row.optString("date"),row.optString("permalink"))
    } }
    val tasks=guides.values.flatten().map{it.task}.filter{it.isNotBlank()}.distinct().sorted()
    val methods=guides.values.flatten().map{it.method}.filter{it.isNotBlank()}.distinct().sorted()
    val paths=guides.mapValues {(_,rows)->rows.flatMap{it.nodes}.distinctBy{it.id}.map{node->(node.ancestors+node.id).map{taxonomy!!.nodes.getValue(it)}}}
    val counts=paths.values.fold(linkedMapOf<String,Int>()){out,paths->paths.flatten().map{it.id}.toSet().forEach{out[it]=(out[it]?:0)+1};out}
    val unclassified=sourcePapers.count{paths[it.id].isNullOrEmpty()}
    fun hasSameSource(papers:List<Paper>,graph:WebsiteTaxonomy?):Boolean=taxonomy===graph&&(papers===sourcePapers||papers.size==sourcePapers.size&&papers.indices.all{papers[it].id==sourcePapers[it].id&&papers[it].original?.optJSONArray("websiteTagRecords")===recordArrays[it]})
    private fun ids(guide:Guide,facet:String,primary:Boolean):Set<String> = when {
        primary&&guide.primary.containsKey(facet)->guide.primary.getValue(facet)
        primary&&facet in setOf("task","method","scientific_topic","research_focus","artifact")->emptySet()
        else->guide.nodes.filter{it.facet==facet}.mapTo(linkedSetOf()){it.id}
    }
    private fun directionMatches(guide:Guide,direction:WebsiteDirection):Boolean {
        if(direction.domain!="all"&&(if(direction.domain=="unclassified")guide.domain.isNotEmpty()else guide.domain!=direction.domain))return false
        if(direction.research!="all"&&(if(direction.research=="unclassified")guide.research.isNotEmpty()else guide.research!=direction.research))return false
        return direction.ids.groupBy{taxonomy?.nodes?.get(it)?.facet}.all{(facet,selected)->facet!=null&&selected.any{target->
            taxonomy?.nodes?.get(target)?.active==true&&ids(guide,facet,direction.primary).any{id->id==target||direction.subtree&&target in taxonomy.nodes.getValue(id).ancestors}
        }}
    }
    private fun ordinary(guide:Guide,paper:Paper,criteria:WebsiteLibraryCriteria):Boolean =
        websiteDateMatches(guide.date,criteria.from,criteria.until)&&(criteria.source.isEmpty()||guide.source==criteria.source)&&(criteria.task.isEmpty()||guide.task==criteria.task)&&(criteria.method.isEmpty()||guide.method==criteria.method)&&
            (criteria.minimum.isEmpty()||(guide.score?:-1.0)>=(criteria.minimum.toDoubleOrNull()?:0.0))&&
            (criteria.query.isBlank()||paper.id in criteria.personalHits||paper.id in criteria.cachedHits||guide.search.any{it.contains(criteria.query.trim().lowercase(Locale.ROOT))})
    fun select(papers:List<Paper>,criteria:WebsiteLibraryCriteria,direction:WebsiteDirection,countFiltered:Boolean=false,countSubtree:Boolean=direction.subtree):WebsiteLibraryView {
        val counts=linkedMapOf<String,Int>();val facetCounts=linkedMapOf<String,Int>();val links=linkedMapOf<String,List<PublishedGuideLink>>();val results=ArrayList<Paper>();var unclassified=0;var countTotal=0
        for(paper in papers) {
            val rows=guides[paper.id].orEmpty()
            if(rows.isEmpty()) {
                val eligible=websiteDateMatches(paper.date,criteria.from,criteria.until)&&(criteria.source.isEmpty()||paper.sourceKind==criteria.source)&&(criteria.task.isEmpty()||paper.task==criteria.task)&&(criteria.method.isEmpty()||paper.method==criteria.method)&&
                    (criteria.minimum.isEmpty()||(paper.score?:-1.0)>=(criteria.minimum.toDoubleOrNull()?:0.0))&&(paper.id in criteria.personalHits||paper.id in criteria.cachedHits||matchesLibrarySearch(paper,criteria.query,null))
                if(eligible){unclassified++;if(direction.ids.isEmpty()&&direction.domain in setOf("all","unclassified")&&direction.research in setOf("all","unclassified"))results+=paper};continue
            }
            val eligible=rows.filter{ordinary(it,paper,criteria)}
            if(eligible.isEmpty())continue
            // Counts respond to ordinary conditions and scope/role, not the selected nodes.
            val counted=eligible.filter{directionMatches(it,if(countFiltered)direction else direction.copy(ids=emptySet(),unclassified=false))}
            if(counted.isNotEmpty())countTotal++
            counted.flatMap{guide->WebsiteTaxonomy.facets.keys.flatMap{facet->ids(guide,facet,direction.primary).flatMap{id->listOf(id)+if(countSubtree)taxonomy!!.nodes.getValue(id).ancestors else emptyList()}}}.toSet().forEach{counts[it]=(counts[it]?:0)+1}

            counted.flatMap{guide->WebsiteTaxonomy.facets.keys.filter{ids(guide,it,direction.primary).isNotEmpty()}}.toSet().forEach{facetCounts[it]=(facetCounts[it]?:0)+1}
            val missing=eligible.all{it.nodes.isEmpty()};if(missing)unclassified++
            val matched=eligible.filter{directionMatches(it,direction)}
            if((!direction.unclassified||missing)&&matched.isNotEmpty()){results+=paper;links[paper.id]=matched.mapNotNull{it.link}.distinctBy{it.url}}
        }
        return WebsiteLibraryView(results,counts,unclassified,facetCounts,links,countTotal)
    }
    fun matchingPermalinks(paper:Paper,criteria:WebsiteLibraryCriteria,direction:WebsiteDirection):List<String> = guides[paper.id].orEmpty().filter{ordinary(it,paper,criteria)&&directionMatches(it,direction)}.map{it.permalink}.distinct()
    // Compatibility helpers for the previously shipped single-node display tests.
    fun matches(id:String,category:String)=when(category){""->true;"unclassified"->paths[id].isNullOrEmpty();else->paths[id].orEmpty().any{path->path.any{it.id==category}}}
    fun matchesCriteria(paper:Paper,category:String,source:String,minimum:String,query:String,personalSearchHit:Boolean)=select(listOf(paper),WebsiteLibraryCriteria(source=source,minimum=minimum,query=query,personalHits=if(personalSearchHit)setOf(paper.id)else emptySet()),WebsiteDirection(ids=if(category !in setOf("","unclassified"))setOf(category)else emptySet(),unclassified=category=="unclassified")).papers.isNotEmpty()
    fun label(category:String)=when(category){""->"全部网站分类";"unclassified"->"网站分类未就绪";else->taxonomy?.nodes?.get(category)?.label?:"全部网站分类"}
    fun explanation(paper:Paper):String=when(guides[paper.id]?.firstOrNull()?.status){"withheld"->"网站暂缓展示该论文分类";"legacy"->"网站未提供已核验的多级分类";"unknown-version","unbound-version"->"缺少对应分类词表，请同步网站资料";"invalid-roles","invalid"->"网站分类暂不可验证，请同步后查看";else->"本机缺少网站分类资料，请同步已发布内容"}
}
internal typealias WebsiteFavoriteIndex = WebsiteLibraryIndex

internal fun websiteDateMatches(date:String,from:String,until:String):Boolean {
    if(from.isEmpty()&&until.isEmpty())return true
    fun valid(value:String)=value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}"))&&runCatching{java.time.LocalDate.parse(value).year in 1..9999}.getOrDefault(false)
    return valid(date)&&(from.isEmpty()||valid(from)&&date>=from)&&(until.isEmpty()||valid(until)&&date<=until)&&(from.isEmpty()||until.isEmpty()||from<=until)
}

internal fun websiteDirectionFromJSON(value:JSONObject,taxonomy:WebsiteTaxonomy):WebsiteDirection {
    val scope=value.optString("scope","subtree");val role=value.optString("role","any");require(scope in setOf("subtree","direct")&&role in setOf("any","primary"))
    val domain=value.optString("domainScope","all");val research=value.optString("researchType","all")
    require(domain in setOf("all","unclassified","in-domain","cross-domain","adjacent-domain","out-of-domain"))
    require(research in setOf("all","unclassified","engineering","science","analysis","evaluation","resource","review","experience","position"))
    val facets=if(value.has("facets"))value.getJSONObject("facets")else JSONObject();val ids=linkedSetOf<String>()
    facets.keys().forEach{facet->require(facet in WebsiteTaxonomy.facets);val array=facets.getJSONArray(facet);for(i in 0 until array.length()){val id=array.get(i);require(id is String&&taxonomy.nodes[id]?.facet==facet&&taxonomy.nodes[id]?.active==true);ids+=id as String}}
    return WebsiteDirection(ids,scope=="subtree",role=="primary",domain,research)
}
