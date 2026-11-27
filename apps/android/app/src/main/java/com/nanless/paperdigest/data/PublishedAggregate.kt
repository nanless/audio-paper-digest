package com.nanless.paperdigest.data

import com.nanless.paperdigest.protocols.ClientProtocols

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest

/** Website metadata has no Paper, Article, PDF, model, citation or Zotero capability. */
data class PublishedAggregate(
    val id:String,val kind:String,val conferenceScope:String?,val title:String,val titleZh:String,val summary:String,
    val rawDate:String,val displayDate:String?,val categories:List<String>,val tags:List<String>,val sourceURL:String,val source:AggregateSource,
) {
    fun json()=JSONObject().put("id",id).put("kind",kind).put("title",title).put("titleZh",titleZh).put("summary",summary).put("rawDate",rawDate).put("categories",JSONArray(categories)).put("tags",JSONArray(tags)).put("sourceURL",sourceURL).put("source",source.json()).apply{conferenceScope?.let{put("conferenceScope",it)};displayDate?.let{put("displayDate",it)}}
}
data class AggregateSource(val manifestSHA256:String,val shardSHA256:String,val shardBytes:Int,val shardURL:String,val rowIndex:Int,val normalizedRowSHA256:String,val normalizedRowAlgorithm:String) {
    fun json()=JSONObject().put("manifestSHA256",manifestSHA256).put("shardSHA256",shardSHA256).put("shardBytes",shardBytes).put("shardURL",shardURL).put("rowIndex",rowIndex).put("normalizedRowSHA256",normalizedRowSHA256).put("normalizedRowAlgorithm",normalizedRowAlgorithm)
}
data class PublishedAggregateCatalog(val snapshotSHA256:String,val sourceRecordCount:Int,val records:List<PublishedAggregate>) {
    fun json()=JSONObject().put("snapshotSHA256",snapshotSHA256).put("sourceRecordCount",sourceRecordCount).put("aggregateCount",records.size).put("records",JSONArray(records.map{it.json()}))
}
object PublishedAggregateReader {
    const val SITE="https://nanless.github.io/audio-research-portal/"
    const val CANONICAL_DESKTOP_PAGES_SHARD_URL="desktop-canonical-pages"
    private data class CanonicalPortalPage(val slug:String,val title:String,val summary:String)
    private val CANONICAL_DESKTOP_PAGES=listOf(
        CanonicalPortalPage("about/","关于与使用方法","找到值得读的论文，核对原文与证据，使用专题导航、快捷键与引用工具高效精读。"),
        CanonicalPortalPage("conferences/","会议论文集","先按会议档次浏览，再按年份与举办月日查找语音、音乐、音频和相关领域研究。"),
        CanonicalPortalPage("links/","研究资源指南","按发现论文、核对来源、整理阅读和研究写作的顺序，选择真正能进入日常工作的工具。"),
    )
    data class Shard(val url:String,val bytes:Int,val sha256:String,val recordCount:Int)
    data class Manifest(val recordCount:Int,val totalBytes:Int,val shards:List<Shard>,val rowEncoding:String,val desktopDetails:Boolean=false)
    fun sha(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it.toInt() and 255)}
    fun validSHA(value:String)=value.matches(Regex("[a-f0-9]{64}"))
    internal fun isDesktopSnapshotManifest(raw:ByteArray):Boolean = runCatching {
        if(raw.isEmpty()||raw.size>2*1024*1024)return false
        val value=JSONObject(PublishedUtf8.decode(raw))
        value.opt("contract")==ClientProtocols.contract("paper-desktop-snapshot") &&
            ClientProtocols.hasValidHeader(value,"paper-desktop-snapshot")
    }.getOrDefault(false)
    internal fun canonicalDesktopPageRow(index:Int):JSONObject {
        require(index in CANONICAL_DESKTOP_PAGES.indices){"桌面规范站点页面索引无效"}
        val item=CANONICAL_DESKTOP_PAGES[index]
        val permalink="/audio-research-portal/${item.slug}"
        pageURL(permalink)
        return JSONObject()
            .put("pageType","page")
            .put("permalink",permalink)
            .put("title",item.title)
            .put("titleZh",item.title)
            .put("summary",item.summary)
            .put("date","")
            .put("categories",JSONArray())
            .put("tags",JSONArray())
            .put("canonicalPortalPage",true)
    }
    internal fun supplementCanonicalDesktopPages(catalog:PublishedAggregateCatalog,rawManifest:ByteArray):PublishedAggregateCatalog {
        if(!isDesktopSnapshotManifest(rawManifest))return catalog
        val rowEncoding=ClientProtocols.contract("foundation-sorted-keys-json")
        val existingURLs=catalog.records.mapTo(HashSet()){it.sourceURL}
        val merged=catalog.records.toMutableList()
        for((index,item) in CANONICAL_DESKTOP_PAGES.withIndex()){
            val url=pageURL("/audio-research-portal/${item.slug}")
            if(!existingURLs.add(url))continue
            val row=canonicalDesktopPageRow(index)
            val source=AggregateSource(catalog.snapshotSHA256,catalog.snapshotSHA256,0,CANONICAL_DESKTOP_PAGES_SHARD_URL,index,sha(normalizedRow(row)),rowEncoding)
            merged+=PublishedAggregate("page:"+URI(url).rawPath,"page",null,item.title,item.title,item.summary,"",null,emptyList(),emptyList(),url,source)
        }
        return if(merged.size==catalog.records.size) catalog else PublishedAggregateCatalog(catalog.snapshotSHA256,catalog.sourceRecordCount,merged.sortedBy{it.id})
    }
    fun pageURL(value:String):String {
        val raw=URI(value);require(raw.rawUserInfo==null&&raw.rawQuery==null&&raw.rawFragment==null){"汇总页面地址无效"}
        val rawPath=raw.rawPath.orEmpty()
        val normalizedInput=if(!raw.isAbsolute&&!rawPath.startsWith("/"))"/audio-research-portal/$rawPath" else value
        val resolved=URI(SITE).resolve(normalizedInput);val path=resolved.rawPath.orEmpty()
        val ownedPrefix=if(path.startsWith("/audio-research-portal/"))"/audio-research-portal/" else if(path.startsWith("/audio-paper-digest-blog/"))"/audio-paper-digest-blog/" else null
        require(ownedPrefix!=null&&path.length>ownedPrefix.length&&path.endsWith('/')&&!path.contains('%')&&!path.contains('\\')&&!path.contains("//")&&path.split('/').none{it=="."||it==".."}){"汇总路径不规范"}
        require(resolved.scheme=="https"&&resolved.host=="nanless.github.io"&&resolved.port==-1){"汇总页面不属于资料站点"}
        return resolved.toASCIIString()
    }
    private fun strictInt(value:JSONObject,key:String):Int {val raw=value.get(key);require(raw is Int||raw is Long){"清单数量必须为整数"};val number=(raw as Number).toLong();require(number in 0..Int.MAX_VALUE);return number.toInt()}
    fun manifest(raw:ByteArray):Manifest {
        require(raw.size in 1..2*1024*1024);val value=JSONObject(PublishedUtf8.decode(raw))
        if(ClientProtocols.hasValidHeader(value,"paper-desktop-snapshot")) {
            val descriptors=value.getJSONArray("catalogShards");require(descriptors.length() in 1..128)
            val seen=mutableSetOf<String>();val shards=(0 until descriptors.length()).map{i->val d=descriptors.getJSONObject(i);val s=Shard(d.getString("url"),strictInt(d,"bytes"),d.getString("sha256"),strictInt(d,"recordCount"));require(validSHA(s.sha256)&&s.url=="client/details/catalog/${s.sha256}.json"&&s.bytes in 1..1024*1024&&s.recordCount>0&&seen.add(s.url));s}
            val count=strictInt(value,"recordCount");val appearances=strictInt(value,"appearanceCount");val totalLong=shards.sumOf{it.bytes.toLong()}
            require(count>0&&appearances==count&&totalLong in 1..64L*1024*1024&&shards.sumOf{it.recordCount.toLong()}==count.toLong())
            return Manifest(count,totalLong.toInt(),shards,ClientProtocols.contract("foundation-sorted-keys-json"),desktopDetails=true)
        }
        require(ClientProtocols.hasValidHeader(value,"paper-search-index-manifest"));val descriptors=value.getJSONArray("shards");require(descriptors.length() in 1..128)
        val seen=mutableSetOf<String>();val shards=(0 until descriptors.length()).map{i->val d=descriptors.getJSONObject(i);val s=Shard(d.getString("url"),strictInt(d,"bytes"),d.getString("sha256"),strictInt(d,"recordCount"));require(s.url.matches(Regex("search-index/part-[0-9]{4,}-[a-f0-9]{12}\\.json"))&&validSHA(s.sha256)&&s.url.endsWith("-${s.sha256.take(12)}.json")&&s.bytes in 1..1024*1024&&s.recordCount>0&&seen.add(s.url));s}
        val count=strictInt(value,"recordCount");val total=strictInt(value,"totalBytes");require(count>0&&total in 1..64*1024*1024&&shards.sumOf{it.bytes.toLong()}==total.toLong()&&shards.sumOf{it.recordCount.toLong()}==count.toLong())
        val rowEncodingFamily="foundation-sorted-keys-json"
        val rowEncoding=if(value.opt("contract")=="paper-search-index-manifest")ClientProtocols.contract(rowEncodingFamily)
            else ClientProtocols.historicalContract(rowEncodingFamily,"original-row-canonical-byte-encoding")
        return Manifest(count,total,shards,rowEncoding)
    }
    private fun strings(row:JSONObject,key:String):List<String> = row.optJSONArray(key)?.let{a->(0 until a.length()).map{a.getString(it)}}?:emptyList()
    fun normalizedRow(row:JSONObject):ByteArray=OfflineFoundationJSON.encode(row)
    fun read(raw:ByteArray,check:()->Unit={},shardBytes:(Shard)->ByteArray):PublishedAggregateCatalog {
        val m=manifest(raw);val snapshot=sha(raw);val result=mutableListOf<PublishedAggregate>();val pages=mutableSetOf<String>();var sourceRows=0
        for(shard in m.shards){check();val bytes=shardBytes(shard);require(bytes.size==shard.bytes&&sha(bytes)==shard.sha256){"分片与原清单不符"};val rows=JSONArray(PublishedUtf8.decode(bytes));require(rows.length()==shard.recordCount)
            for(i in 0 until rows.length()){check();sourceRows++;val row=rows.getJSONObject(i)
                if(m.desktopDetails){
                    val pageType=row.getString("pageType");val url=pageURL(row.getString("pageUrl"));require(pages.add(url)){"目录页面地址重复"}
                    if(pageType=="paper")continue
                    require(pageType in setOf("daily","conference","page")&&row.getString("identityStatus")=="aggregate-page"&&row.isNull("paperId")){"非论文汇总记录身份无效"}
                    val title=row.getString("title");require(title.isNotBlank());val titleZh=row.nullableString("titleZh")?:title;val summary=row.nullableString("summary")?:""
                    val date=row.nullableString("blogPublishedAt")?:""
                    val explicitScope=row.nullableString("conferenceScope")
                    require(explicitScope==null||(pageType=="conference"&&explicitScope in setOf("overview","task"))){"会议范围字段无效"}
                    val scope=explicitScope?:if(pageType=="conference"&&row.getString("pageUrl").endsWith("-summary/"))"overview" else null
                    val tags=strings(row,"tagConceptIds").ifEmpty{strings(row,"flatTags").ifEmpty{strings(row,"tags")}}
                    val source=AggregateSource(snapshot,shard.sha256,shard.bytes,shard.url,i,sha(normalizedRow(row)),m.rowEncoding)
                    result+=PublishedAggregate("page:"+URI(url).rawPath,pageType,scope,title,titleZh,summary,date,date.takeUnless{it.isEmpty()||it.startsWith("0001-01-01")},strings(row,"categories"),tags,url,source)
                    continue
                }
                val pageType=row.getString("pageType");val kind=if(pageType=="daily-summary")"daily" else pageType;val url=pageURL(row.getString("permalink"));require(pages.add(url)){"目录页面地址重复"};if(kind=="paper")continue
                require(kind in setOf("daily","conference","page")){"非论文类型尚不支持"};val title=row.getString("title");require(title.isNotBlank());val date=row.optString("date");val scope=row.optString("conferenceScope").takeIf{row.has("conferenceScope")&&!row.isNull("conferenceScope")};require(scope==null||kind=="conference"&&scope in setOf("task","overview"))
                row.optJSONObject("citation")?.optString("pageUrl")?.takeIf{it.isNotEmpty()}?.let{require(pageURL(it)==url)}
                val source=AggregateSource(snapshot,shard.sha256,shard.bytes,shard.url,i,sha(normalizedRow(row)),m.rowEncoding)
                result+=PublishedAggregate("page:"+URI(url).rawPath,kind,scope,title,row.optString("titleZh",title),row.optString("summary"),date,date.takeUnless{it.isEmpty()||it.startsWith("0001-01-01")},strings(row,"categories"),strings(row,"tags"),url,source)
            }
        }
        require(sourceRows==m.recordCount);return PublishedAggregateCatalog(snapshot,sourceRows,result.sortedBy{it.id})
    }
    internal fun readSupplementalPages(snapshotSHA256:String,shardURL:String,shardSHA256:String,shardBytes:Int,rawShard:ByteArray,existingIds:Set<String>):List<PublishedAggregate> {
        require(validSHA(snapshotSHA256)&&validSHA(shardSHA256)&&shardURL=="client/details/pages/$shardSHA256.json"&&shardBytes in 1..1024*1024)
        require(rawShard.size==shardBytes&&sha(rawShard)==shardSHA256){"补充页面分片与原清单不符"}
        val rows=JSONArray(PublishedUtf8.decode(rawShard))
        val encoding=ClientProtocols.contract("foundation-sorted-keys-json")
        val pages=mutableSetOf<String>();val result=mutableListOf<PublishedAggregate>()
        for(i in 0 until rows.length()){
            val row=rows.getJSONObject(i)
            require(row.getString("pageType")=="page"){"补充目录仅允许网站页面类型"}
            val url=pageURL(row.getString("permalink"));require(pages.add(url)){"补充目录页面地址重复"}
            val id="page:"+URI(url).rawPath
            if(id in existingIds)continue
            val title=row.getString("title");require(title.isNotBlank())
            val titleZh=row.optString("titleZh",title).ifBlank{title};val summary=row.optString("summary");val date=row.optString("date")
            val source=AggregateSource(snapshotSHA256,shardSHA256,shardBytes,shardURL,i,sha(normalizedRow(row)),encoding)
            result+=PublishedAggregate(id,"page",null,title,titleZh,summary,date,date.takeUnless{it.isEmpty()||it.startsWith("0001-01-01")},strings(row,"categories"),strings(row,"tags"),url,source)
        }
        return result
    }
}
