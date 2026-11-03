package com.nanless.paperdigest.data

import com.nanless.paperdigest.protocols.ClientProtocols
import org.json.JSONArray
import org.json.JSONObject

/** Website-owned classification display only. Never a paper/source or model capability. */
class WebsiteTaxonomy private constructor(val nodes: Map<String, Node>, private val versions: Map<String, Map<String, Node>>, private val versionNames: Map<String,String>, private val raw: JSONObject) {
    data class Node(val id:String,val facet:String,val label:String,val ancestors:List<String>,val active:Boolean,val english:String="",val aliases:List<String> = emptyList(),val description:String="")
    data class Classification(val status:String,val concepts:List<Node>,val issuedConcepts:List<Node> = emptyList())
    fun json():JSONObject=raw.copy()
    fun classify(record:JSONObject):Classification {
        val current=fields.any { record.has(it.first) };val legacy=fields.any { record.has(it.second) }
        if(current&&legacy)return Classification("invalid",emptyList())
        fun field(name:String):Any? { val pair=fields.single {it.first==name};return record.opt(if(current)pair.first else pair.second) }
        fun text(name:String)=field(name) as? String ?: ""
        if(text("tagPublicationStatus")=="withheld")return Classification("withheld",emptyList())
        val header=JSONObject().put("contract",text("tagContract")).also{if(field("tagSchemaFingerprint")!=null)it.put("schemaFingerprint",field("tagSchemaFingerprint"))}
        if(!ClientProtocols.hasValidHeader(header,"paper-tag-flat-tags"))return Classification("legacy",emptyList())
        val selected=field("tagConcepts") as? JSONArray?:return Classification("legacy",emptyList())
        val source=versions[text("tagCatalogSha256")]?:return Classification(if(text("tagCatalogSha256").isEmpty())"unbound-version"else"unknown-version",emptyList())
        val issued=ArrayList<Node>()
        for(i in 0 until selected.length()) {
            val value=selected.optJSONObject(i)?:continue;val node=source[value.optString("id")]?:continue;val now=nodes[node.id]?:continue
            if(node.active&&now.active&&node.facet==now.facet&&value.optString("facet")==node.facet&&value.optString("label")==node.label)issued+=node
        }
        val contract=text("tagClassificationContract")
        if(contract.isNotEmpty()&&!validRoles(record,contract,text("tagEvidenceContract"),text("tagEvidenceType"),text("tagCatalogSha256"),text("tagProofSha256"),source,versionNames[text("tagCatalogSha256")].orEmpty(),issued,selected.length()))return Classification("invalid-roles",emptyList())
        return Classification("verified",issued.map {nodes.getValue(it.id)}.distinctBy {it.id},issued.toList())
    }
    fun paths(paper:Paper):List<List<Node>> = records(paper).flatMap { classify(it).concepts }.distinctBy {it.id}.map { node -> (node.ancestors+node.id).map {nodes.getValue(it)} }
    fun status(paper:Paper):String {
        val records=records(paper);if(records.isEmpty())return "missing"
        val states=records.map {classify(it)};return if(states.any {it.concepts.isNotEmpty()})"verified" else states.first().status
    }
    private fun validRoles(r:JSONObject,contract:String,evidence:String,type:String,sha:String,proof:String,source:Map<String,Node>,sourceVersion:String,selected:List<Node>,rawCount:Int):Boolean {
        val v3=contract=="historical-source-taxonomy-classification-v3"
        val qualified=contract=="exact1028-independent-review-qualified-classification-v1"&&r.optString("paperId")=="conference:icassp:2026:icassp-arnumber:11461028"&&sha=="910a94021b085a190abcd5fd9603af3240160f9417293d5a90158bc4ef900d30"&&proof=="03beb37ae2df8f7f48850f935cb274a9b0c75eebde483e9c1d6c51a5cffaeb20"&&evidence==contract&&type=="source-bound-independent-review-qualification"
        val known=contract in setOf("historical-source-taxonomy-classification-v2","historical-source-taxonomy-classification-v3")||qualified
        val evidenceOK=qualified||if(v3)(type=="source-only-taxonomy-v3"&&evidence=="historical-source-taxonomy-supplement-v3")||(type=="source-bound-current-page-fullsite-taxonomy-v3"&&evidence=="fullsite-source-taxonomy-audit-supplement-v1") else (type=="source-only-taxonomy-v2"&&evidence=="historical-source-taxonomy-supplement-v2")||(type=="controlled-current-page-source-taxonomy-v2"&&evidence=="historical-current-page-source-taxonomy-supplement-v2")
        val research=r.optString("researchType");val role=r.optJSONObject("primaryResearchRole")?:return false;val roleNode=source[role.optString("conceptId")]?:return false
        val ids=selected.map {it.id}.toSet();val mechanism=v3&&research=="engineering"&&role.optString("kind")=="method"
        val facets=if(v3&&research=="engineering")setOf("task","method")else roleFacets[research].orEmpty()
        if(sourceVersion !in setOf("paper-taxonomy-v1","paper-taxonomy-v2")||!known||!evidenceOK||r.optString("domainScope") !in setOf("in-domain","cross-domain","adjacent-domain","out-of-domain")||roleNode.id !in ids||role.optString("kind") !in facets||role.optString("kind")!=roleNode.facet||role.optString("label")!=roleNode.label||selected.size!=rawCount||ids.size!=selected.size||ids.size>5||selected.any {n->n.ancestors.any {it in ids}})return false
        if(r.opt("methodNotApplicable")==true) {
            if(research !in setOf("position","experience")||r.optString("primaryMethodId").isNotEmpty()||r.optString("method").isNotBlank()||r.optString("methodNotApplicableReason").trim().length<20||selected.any{it.facet=="method"})return false
        } else {
            val method=source[r.optString("primaryMethodId")]?:return false
            if(r.opt("methodNotApplicable")!=false||method.facet!="method"||method.id !in ids||r.optString("methodNotApplicableReason").isNotBlank()||ids.size<(if(mechanism)1 else 2))return false
            if(mechanism&&(method.id!=roleNode.id||r.optString("primaryTaskId").isNotEmpty()||r.optString("task").isNotBlank()||r.optString("primaryScientificTopicId").isNotEmpty()))return false
        }
        if(research=="engineering"&&!mechanism&&r.optString("primaryTaskId")!=roleNode.id)return false
        if(research!="engineering"&&(r.optString("primaryTaskId").isNotEmpty()||r.optString("task").isNotBlank()))return false
        if(research=="science"&&r.optString("primaryScientificTopicId")!=roleNode.id)return false
        if(research!="science"&&r.optString("primaryScientificTopicId").isNotEmpty())return false
        return true
    }
    companion object {
        val facets=linkedMapOf("task" to "任务","method" to "方法","setting" to "条件","signal" to "信号","application" to "应用","research_focus" to "研究重点","artifact" to "研究产物","scientific_topic" to "科学主题","model_family" to "模型家族")
        private val roleFacets=mapOf("engineering" to setOf("task"),"science" to setOf("scientific_topic"),"analysis" to setOf("scientific_topic","research_focus"),"evaluation" to setOf("research_focus"),"resource" to setOf("artifact"),"review" to setOf("task","scientific_topic","research_focus"),"experience" to setOf("task","scientific_topic","research_focus","artifact"),"position" to setOf("scientific_topic","research_focus"))
        private val fields=listOf("Contract","SchemaFingerprint","Concepts","CatalogSha256","PublicationStatus","EvidenceContract","EvidenceType","ProofSha256","PageSha256","ClassificationContract").map { suffix -> "tag$suffix" to "taxonomy${if(suffix=="CatalogSha256")"RegistrySha256"else suffix}" }
        private val additional=setOf("permalink","arxivId","identityStatus","sourceKind","pageType","title","titleZh","originalTitle","summary","date","score","tags","citation","paperId","primaryTaskId","primaryMethodId","task","method","researchType","domainScope","primaryResearchRole","primaryScientificTopicId","primaryScientificTopicLabel","methodNotApplicable","methodNotApplicableReason")
        fun record(row:JSONObject)=JSONObject().also {out->(fields.flatMap{listOf(it.first,it.second)}+additional).forEach {if(row.has(it))out.put(it,row.get(it))} }.copy()
        fun records(paper:Paper):List<JSONObject> = paper.original?.optJSONArray("websiteTagRecords")?.objects().orEmpty()
        fun parse(value:JSONObject):WebsiteTaxonomy {
            val raw=value.copy();val snapshot=raw.getJSONObject("snapshot");val versions=raw.getJSONObject("versions")
            require(ClientProtocols.hasValidHeader(versions,"paper-tag-catalog-versions"))
            val current=graph(snapshot);val sha=snapshot.getString("registrySha256");require(versions.getString("currentSha256")==sha)
            val list=versions.getJSONArray("snapshots");require(list.length() in 1..128);val historical=linkedMapOf<String,Map<String,Node>>();val versionNames=linkedMapOf<String,String>()
            for(i in 0 until list.length()) {val source=list.getJSONObject(i);val id=source.getString("registrySha256");require(id.matches(Regex("[a-f0-9]{64}"))&&!historical.containsKey(id));val nodes=graph(source);nodes.forEach{(key,node)->require(current[key]==null||current[key]?.facet==node.facet)};historical[id]=nodes;versionNames[id]=source.optString("registryVersion")
                if(id==sha)require(canonical(snapshot,false)==canonical(source,false)){"当前分类词表与版本目录不一致"}
            }
            require(sha in historical);return WebsiteTaxonomy(current,historical,versionNames,raw)
        }
        private fun graph(snapshot:JSONObject):Map<String,Node> {
            require(ClientProtocols.hasValidHeader(snapshot,"paper-tag-catalog-snapshot"));require(snapshot.getString("registrySha256").matches(Regex("[a-f0-9]{64}")))
            val entries=snapshot.getJSONArray("concepts");require(entries.length() in 1..10000);val nodes=linkedMapOf<String,Node>();val labelOwners=mutableMapOf<String,String>()
            for(i in 0 until entries.length()) {val r=entries.getJSONObject(i);val id=r.getString("id");val facet=r.getString("facet");val label=r.getString("zh");val ancestors=r.getJSONArray("ancestorIds").strings();val aliases=r.getJSONArray("aliases").strings();require(id.matches(Regex("[a-z][a-z0-9_]*\\.[a-z0-9][a-z0-9.-]*"))&&facet in facets&&id.startsWith("$facet.")&&label.isNotBlank()&&id !in nodes&&ancestors.size<=64&&ancestors.all{it.isNotBlank()}&&aliases.all{it.isNotBlank()});val labels=listOf(label,r.optString("en"))+aliases
                labels.filter{it.isNotBlank()}.forEach { text->val normalized=java.text.Normalizer.normalize(text.trim(),java.text.Normalizer.Form.NFKC).lowercase(java.util.Locale.ROOT);val key=facet+"\u0000"+normalized;require(labelOwners[key]==null||labelOwners[key]==id){"网站分类别名存在歧义"};labelOwners[key]=id }
                val status=r.optString("status","active");require(status in setOf("active","deprecated"));r.optJSONArray("parentIds")?.let{require(it.length()<=1)};nodes[id]=Node(id,facet,label,ancestors,status=="active",r.optString("en"),aliases.toList(),r.optString("definition",r.optString("description"))+" "+r.optString("scopeNote"))}
            nodes.values.forEach {node->val chain=ArrayList<String>();val seen=hashSetOf(node.id);var parent=node.ancestors.lastOrNull();while(parent!=null){val p=nodes[parent]?:error("网站分类父级缺失");require(p.facet==node.facet&&p.active&&seen.add(parent));chain.add(0,parent);parent=p.ancestors.lastOrNull()};require(chain==node.ancestors){"网站分类祖先路径不闭合"}}
            return nodes.toMap()
        }
        private fun canonical(value:Any?,includeContract:Boolean=true):String=when(value){is JSONObject->value.keys().asSequence().filter{includeContract||it !in setOf("contract","schemaFingerprint")}.sorted().joinToString(prefix="{",postfix="}"){JSONObject.quote(it)+":"+canonical(value.get(it))};is JSONArray->(0 until value.length()).joinToString(prefix="[",postfix="]"){canonical(value.get(it))};is String->JSONObject.quote(value);else->value?.toString()?:"null"}
    }
}
