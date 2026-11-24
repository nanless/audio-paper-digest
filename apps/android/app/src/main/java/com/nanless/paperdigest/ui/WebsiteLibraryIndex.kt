package com.nanless.paperdigest.ui

import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.data.ResourceBadgeSignals
import com.nanless.paperdigest.data.WebsiteTaxonomy
import org.json.JSONObject
import java.text.Normalizer
import java.util.Locale

internal data class ConferenceVenue(val key: String, val label: String)
internal data class ScoreTierInfo(val key: String, val label: String)

private val CONFERENCE_VENUE_NAMES = mapOf(
    "interspeech" to "INTERSPEECH",
    "icassp" to "ICASSP",
    "iclr" to "ICLR",
    "icml" to "ICML",
    "neurips" to "NeurIPS",
    "acl" to "ACL",
    "emnlp" to "EMNLP",
    "naacl" to "NAACL",
    "eacl" to "EACL",
    "cvpr" to "CVPR",
    "aaai" to "AAAI",
    "dafx" to "DAFx",
    "eusipco" to "EUSIPCO",
    "speechprosody" to "SpeechProsody",
    "nime" to "NIME",
    "odyssey" to "Odyssey",
    "icmc" to "ICMC",
    "jep" to "JEP",
    "iwslt" to "IWSLT",
    "chime" to "CHiME",
    "uai" to "UAI",
    "aistats" to "AISTATS",
    "waspaa" to "WASPAA",
    "asru" to "ASRU",
    "slt" to "SLT",
    "ismir" to "ISMIR",
)
private val VENUE_TOKEN_REGEX = Regex("^[a-z0-9][a-z0-9._-]{0,63}$")
private val YEAR_REGEX = Regex("^(19|20)\\d{2}$")
private val COMBINING_MARKS_REGEX = Regex("\\p{Mn}+")
private val BARE_ARXIV_ID_REGEX = Regex("^(\\d{4}\\.\\d{4,5})(?:v\\d+)?$", RegexOption.IGNORE_CASE)
internal const val MAX_SEARCH_TOKENS = 32

/** Resolves exact IDs, sourceVersion matches, or bare/versioned arXiv IDs (e.g. "2611.10001v1") to catalog Paper. */
internal fun resolvePaperByCanonicalId(papers: List<Paper>, rawId: String): Paper? {
    val pid = rawId.trim()
    if (pid.isEmpty()) return null
    papers.firstOrNull { it.id == pid }?.let { return it }
    papers.firstOrNull { it.sourceVersion == pid }?.let { return it }
    val match = BARE_ARXIV_ID_REGEX.matchEntire(pid)
    if (match != null) {
        val canonical = "arxiv:${match.groupValues[1]}"
        papers.firstOrNull { it.id == canonical }?.let { return it }
    }
    return null
}

internal fun parseConferenceVenue(paperId: String): ConferenceVenue? {
    if (!paperId.startsWith("conference:")) return null
    val parts = paperId.split(':')
    if (parts.size < 3) return null
    val rawVenue = parts[1].trim().lowercase(Locale.ROOT)
    val rawYear = parts[2].trim()
    if (!VENUE_TOKEN_REGEX.matches(rawVenue) || !YEAR_REGEX.matches(rawYear)) return null
    val display = CONFERENCE_VENUE_NAMES[rawVenue] ?: rawVenue.uppercase(Locale.ROOT)
    return ConferenceVenue(key = "conference:$rawVenue:$rawYear", label = "$display $rawYear")
}

internal fun scoreTierInfo(score: Double?): ScoreTierInfo? {
    if (score == null || !score.isFinite()) return null
    return when {
        score >= 8.0 -> ScoreTierInfo("featured", "精选")
        score >= 7.0 -> ScoreTierInfo("high", "高分")
        score >= 6.0 -> ScoreTierInfo("recommended", "推荐")
        else -> ScoreTierInfo("standard", "常规")
    }
}

internal fun normalizeLibrarySearchText(value: String): String {
    if (value.isEmpty()) return ""
    val nfkc = Normalizer.normalize(value, Normalizer.Form.NFKC)
    val stripped = COMBINING_MARKS_REGEX.replace(Normalizer.normalize(nfkc, Normalizer.Form.NFD), "")
    return stripped.lowercase(Locale.ROOT)
}

internal fun tokenizeLibraryQuery(query: String): List<String> =
    normalizeLibrarySearchText(query)
        .split(Regex("\\s+"))
        .asSequence()
        .filter { it.isNotEmpty() }
        .distinct()
        .take(MAX_SEARCH_TOKENS)
        .toList()

internal fun collectConferenceVenues(papers: List<Paper>): List<Pair<ConferenceVenue, Int>> {
    val counts = LinkedHashMap<String, Pair<ConferenceVenue, Int>>()
    for (paper in papers) {
        val venue = parseConferenceVenue(paper.id) ?: continue
        val existing = counts[venue.key]
        counts[venue.key] = if (existing == null) venue to 1 else venue to (existing.second + 1)
    }
    return counts.values.sortedWith(
        compareByDescending<Pair<ConferenceVenue, Int>> { it.first.key.substringAfterLast(':') }
            .thenBy { it.first.label }
    )
}

internal fun paperArtifactConceptIds(paper: Paper): Set<String> {
    val ids = linkedSetOf<String>()
    WebsiteTaxonomy.records(paper).forEach { row ->
        listOf("tagConcepts", "taxonomyConcepts").forEach { key ->
            val arr = row.optJSONArray(key) ?: return@forEach
            for (i in 0 until arr.length()) {
                val id = arr.optJSONObject(i)?.optString("id").orEmpty()
                if (id.isNotEmpty()) ids.add(id)
            }
        }
        val flatIds = row.optJSONArray("tagConceptIds")
        if (flatIds != null) {
            for (i in 0 until flatIds.length()) {
                val id = flatIds.optString(i)
                if (id.isNotEmpty()) ids.add(id)
            }
        }
    }
    return ids
}

internal fun resolvePaperResources(
    paper: Paper,
    resourceBadges: Map<String, ResourceBadgeSignals> = emptyMap(),
    cachedDemoIds: Set<String> = emptySet(),
): ResourceBadgeSignals {
    val conceptIds = paperArtifactConceptIds(paper)
    val t1Code = conceptIds.any {
        it == "artifact.open-source-tool" || it == "artifact.software" ||
            it.startsWith("artifact.open-source-tool.") || it.startsWith("artifact.software.")
    }
    val t1Model = conceptIds.any { it == "artifact.model-weights" || it.startsWith("artifact.model-weights.") }
    val t1Dataset = conceptIds.any {
        it == "artifact.dataset" || it == "artifact.benchmark" ||
            it.startsWith("artifact.dataset.") || it.startsWith("artifact.benchmark.")
    }
    val t1Demo = paper.id in cachedDemoIds
    val t2 = resourceBadges[paper.id]
    return ResourceBadgeSignals(
        hasCode = t1Code || t2?.hasCode == true,
        hasModel = t1Model || t2?.hasModel == true,
        hasDataset = t1Dataset || t2?.hasDataset == true,
        hasDemo = t1Demo || t2?.hasDemo == true,
        hasProjectPage = t2?.hasProjectPage == true,
        codeUrls = t2?.codeUrls.orEmpty(),
        demoUrls = t2?.demoUrls.orEmpty(),
        projectUrls = t2?.projectUrls.orEmpty(),
    )
}

internal fun matchesResourceFilter(
    paper: Paper,
    filter: String,
    resourceBadges: Map<String, ResourceBadgeSignals> = emptyMap(),
    cachedDemoIds: Set<String> = emptySet(),
): Boolean {
    if (filter.isBlank() || filter == "all") return true
    val sig = resolvePaperResources(paper, resourceBadges, cachedDemoIds)
    return when (filter) {
        "open-source", "any" -> sig.hasAny
        "code" -> sig.hasCode
        "model" -> sig.hasModel
        "dataset" -> sig.hasDataset
        "demo" -> sig.hasDemo
        "project" -> sig.hasProjectPage
        else -> true
    }
}

internal fun matchesMinimumScore(score: Double?, minimum: String): Boolean {
    if (minimum.isBlank()) return true
    if (minimum == "scored") return score != null
    val threshold = minimum.toDoubleOrNull() ?: 0.0
    return (score ?: -1.0) >= threshold
}

internal fun libraryRelevanceScore(
    paper: Paper,
    query: String,
    tokens: List<String> = tokenizeLibraryQuery(query),
    taxonomyLabels: List<String> = emptyList(),
): Int {
    if (tokens.isEmpty()) return 0
    val phrase = normalizeLibrarySearchText(query).trim()
    val titleNorm = normalizeLibrarySearchText("${paper.title} ${paper.titleZh}")
    val idNorm = normalizeLibrarySearchText("${paper.id} ${paper.sourceVersion.orEmpty()} ${parseConferenceVenue(paper.id)?.label.orEmpty()}")
    val authorsNorm = normalizeLibrarySearchText(paper.authors.joinToString(" "))
    val tagsNorm = normalizeLibrarySearchText((listOf(paper.task, paper.method) + paper.tags + taxonomyLabels).joinToString(" "))
    var score = 0
    if (phrase.isNotEmpty()) {
        if (titleNorm.contains(phrase)) score += 100
        if (idNorm.contains(phrase)) score += 80
    }
    for (token in tokens) {
        if (titleNorm.contains(token)) score += 40
        if (idNorm.contains(token)) score += 35
        if (tagsNorm.contains(token)) score += 20
        if (authorsNorm.contains(token)) score += 18
    }
    return score
}

internal data class WebsiteDirection(val ids:Set<String> = emptySet(),val subtree:Boolean=true,val primary:Boolean=false,val domain:String="all",val research:String="all",val unclassified:Boolean=false)
internal data class WebsiteLibraryCriteria(
    val source:String="",
    val task:String="",
    val method:String="",
    val minimum:String="",
    val query:String="",
    val personalHits:Set<String> = emptySet(),
    val cachedHits:Set<String> = emptySet(),
    val from:String="",
    val until:String="",
    val venue:String="",
    val resource:String="",
    val resourceBadges:Map<String, ResourceBadgeSignals> = emptyMap(),
    val cachedDemoIds:Set<String> = emptySet(),
)
internal data class PublishedGuideLink(val url:String,val title:String,val date:String,val score:Double?=null,val authors:List<String> = emptyList(),val paths:List<String> = emptyList(),val source:String="")
internal data class WebsiteLibraryView(val papers:List<Paper>,val counts:Map<String,Int>,val unclassified:Int,val facetCounts:Map<String,Int> = emptyMap(),val matchingGuides:Map<String,List<PublishedGuideLink>> = emptyMap(),val countTotal:Int=0)

/** Pure immutable display projection. Construct once per native catalog/record identity, never a source capability. */
internal class WebsiteLibraryIndex(val taxonomy:WebsiteTaxonomy?,private val sourcePapers:List<Paper>,check:()->Unit = {}) {
    private data class Guide(val nodes:List<WebsiteTaxonomy.Node>,val primary:Map<String,Set<String>>,val domain:String,val research:String,
        val source:String,val task:String,val method:String,val score:Double?,val search:List<String>,val status:String,val link:PublishedGuideLink?,val date:String,val permalink:String)
    private val recordArrays=sourcePapers.map{it.original?.optJSONArray("websiteTagRecords")}
    private val guides=sourcePapers.associate {paper->check();val venueLabel=parseConferenceVenue(paper.id)?.label.orEmpty();paper.id to WebsiteTaxonomy.records(paper).map {row->
        check();val classification=taxonomy?.classify(row);val nodes=classification?.concepts.orEmpty();val direct=nodes.map{it.id}.toSet()
        val primary=linkedMapOf<String,Set<String>>()
        listOf("task" to "primaryTaskId","method" to "primaryMethodId").forEach{(facet,key)->row.optString(key).takeIf{it in direct&&taxonomy?.nodes?.get(it)?.facet==facet}?.let{primary[facet]=setOf(it)}}
        val role=row.optJSONObject("primaryResearchRole")
        val classified=(row.optString("tagClassificationContract").isNotEmpty()||row.optString("taxonomyClassificationContract").isNotEmpty())&&classification?.status=="verified"&&row.optString("researchType").isNotEmpty()&&role!=null&&role.optString("conceptId") in direct
        if(classified)primary[role!!.optString("kind")]=setOf(role.optString("conceptId"))
        val search=listOf(paper.id,venueLabel)+listOf("title","titleZh","originalTitle","summary","task","method","date","sourceKind","permalink","arxivId").map{row.optString(it)}+
            row.optJSONArray("tags")?.let{(0 until it.length()).map(it::optString)}.orEmpty()+row.optJSONObject("citation")?.optJSONArray("authors")?.let{(0 until it.length()).map(it::optString)}.orEmpty()+
            nodes.flatMap{(it.ancestors+it.id).map{node->taxonomy!!.nodes.getValue(node).label}}
        Guide(nodes,primary,if(classified)row.optString("domainScope")else"",if(classified)row.optString("researchType")else"",
            row.optString("sourceKind",row.optJSONObject("citation")?.optString("sourceKind",paper.sourceKind)?:paper.sourceKind),row.optString("task"),row.optString("method"),Paper.score(row.opt("score")),search.filter{it.isNotEmpty()}.map{normalizeLibrarySearchText(it)},classification?.status?:"missing",runCatching{com.nanless.paperdigest.data.CatalogRepository.sameSite(row.getString("permalink"))}.getOrNull()?.takeIf{it in paper.appearances||it==paper.blogURL}?.let{PublishedGuideLink(it,row.optString("titleZh",row.optString("title")),row.optString("date"),Paper.score(row.opt("score")),row.optJSONObject("citation")?.optJSONArray("authors")?.let{a->(0 until a.length()).map(a::optString)}.orEmpty(),nodes.map{n->(n.ancestors+n.id).joinToString(" › "){id->taxonomy!!.nodes.getValue(id).label}},row.optString("sourceKind"))},row.optString("date"),row.optString("permalink"))
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
    private fun ordinary(guide:Guide,paper:Paper,criteria:WebsiteLibraryCriteria,tokens:List<String>):Boolean =
        websiteDateMatches(guide.date,criteria.from,criteria.until)&&
            (criteria.source.isEmpty()||guide.source==criteria.source)&&
            (criteria.task.isEmpty()||guide.task==criteria.task)&&
            (criteria.method.isEmpty()||guide.method==criteria.method)&&
            (criteria.venue.isEmpty()||parseConferenceVenue(paper.id)?.key==criteria.venue)&&
            matchesMinimumScore(guide.score,criteria.minimum)&&
            matchesResourceFilter(paper,criteria.resource,criteria.resourceBadges,criteria.cachedDemoIds)&&
            (tokens.isEmpty()||paper.id in criteria.personalHits||paper.id in criteria.cachedHits||tokens.all{tok->guide.search.any{it.contains(tok)}})

    fun relevanceScore(paper: Paper, query: String, tokens: List<String> = tokenizeLibraryQuery(query)): Int {
        val labels = paths[paper.id]?.flatten()?.map { it.label }.orEmpty()
        return libraryRelevanceScore(paper, query, tokens, labels)
    }

    fun select(papers:List<Paper>,criteria:WebsiteLibraryCriteria,direction:WebsiteDirection,countFiltered:Boolean=false,countSubtree:Boolean=direction.subtree):WebsiteLibraryView {
        val tokens=tokenizeLibraryQuery(criteria.query)
        val counts=linkedMapOf<String,Int>();val facetCounts=linkedMapOf<String,Int>();val links=linkedMapOf<String,List<PublishedGuideLink>>();val results=ArrayList<Paper>();var unclassified=0;var countTotal=0
        for(paper in papers) {
            val rows=guides[paper.id].orEmpty()
            if(rows.isEmpty()) {
                val eligible=websiteDateMatches(paper.date,criteria.from,criteria.until)&&
                    (criteria.source.isEmpty()||paper.sourceKind==criteria.source)&&
                    (criteria.task.isEmpty()||paper.task==criteria.task)&&
                    (criteria.method.isEmpty()||paper.method==criteria.method)&&
                    (criteria.venue.isEmpty()||parseConferenceVenue(paper.id)?.key==criteria.venue)&&
                    matchesMinimumScore(paper.score,criteria.minimum)&&
                    matchesResourceFilter(paper,criteria.resource,criteria.resourceBadges,criteria.cachedDemoIds)&&
                    (tokens.isEmpty()||paper.id in criteria.personalHits||paper.id in criteria.cachedHits||matchesLibrarySearch(paper,criteria.query,null))
                if(eligible){unclassified++;if(direction.ids.isEmpty()&&direction.domain in setOf("all","unclassified")&&direction.research in setOf("all","unclassified"))results+=paper};continue
            }
            val eligible=rows.filter{ordinary(it,paper,criteria,tokens)}
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
    fun matchingPermalinks(paper:Paper,criteria:WebsiteLibraryCriteria,direction:WebsiteDirection):List<String> {
        val tokens=tokenizeLibraryQuery(criteria.query)
        return guides[paper.id].orEmpty().filter{ordinary(it,paper,criteria,tokens)&&directionMatches(it,direction)}.map{it.permalink}.distinct()
    }
    // Compatibility helpers for the previously shipped single-node display tests.
    fun matches(id:String,category:String)=when(category){""->true;"unclassified"->paths[id].isNullOrEmpty();else->paths[id].orEmpty().any{path->path.any{it.id==category}}}
    fun matchesCriteria(paper:Paper,category:String,source:String,minimum:String,query:String,personalSearchHit:Boolean)=select(listOf(paper),WebsiteLibraryCriteria(source=source,minimum=minimum,query=query,personalHits=if(personalSearchHit)setOf(paper.id)else emptySet()),WebsiteDirection(ids=if(category !in setOf("","unclassified"))setOf(category)else emptySet(),unclassified=category=="unclassified")).papers.isNotEmpty()
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
