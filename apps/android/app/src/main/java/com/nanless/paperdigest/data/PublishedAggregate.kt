package com.nanless.paperdigest.data

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
    fun json()=JSONObject().put("contract","published-aggregate-index-v1").put("snapshotSHA256",snapshotSHA256).put("sourceRecordCount",sourceRecordCount).put("aggregateCount",records.size).put("records",JSONArray(records.map{it.json()}))
}
object PublishedAggregateReader {
    const val SITE="https://nanless.github.io/audio-paper-digest-blog/"
    data class Shard(val url:String,val bytes:Int,val sha256:String,val recordCount:Int)
    data class Manifest(val recordCount:Int,val totalBytes:Int,val shards:List<Shard>)
    fun sha(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it.toInt() and 255)}
    fun validSHA(value:String)=value.matches(Regex("[a-f0-9]{64}"))
    fun pageURL(value:String):String {
        val raw=URI(value);require(raw.rawUserInfo==null&&raw.rawQuery==null&&raw.rawFragment==null){"汇总页面地址无效"}
        val path=raw.rawPath.orEmpty();require(path.startsWith("/audio-paper-digest-blog/")&&path.length>"/audio-paper-digest-blog/".length&&path.endsWith('/')&&!path.contains('%')&&!path.contains('\\')&&!path.contains("//")&&path.split('/').none{it=="."||it==".."}){"汇总路径不规范"}
        val actual=URI(SITE).resolve(raw);require(actual.scheme=="https"&&actual.host=="nanless.github.io"&&actual.port==-1){"汇总页面不属于资料站点"}
        return actual.toASCIIString()
    }
    private fun strictInt(value:JSONObject,key:String):Int {val raw=value.get(key);require(raw is Int||raw is Long){"清单数量必须为整数"};val number=(raw as Number).toLong();require(number in 0..Int.MAX_VALUE);return number.toInt()}
    fun manifest(raw:ByteArray):Manifest {
        require(raw.size in 1..2*1024*1024);val value=JSONObject(PublishedUtf8.decode(raw))
        require(value.getString("contract")=="paper-search-index-manifest-v1");val descriptors=value.getJSONArray("shards");require(descriptors.length() in 1..128)
        val seen=mutableSetOf<String>();val shards=(0 until descriptors.length()).map{i->val d=descriptors.getJSONObject(i);val s=Shard(d.getString("url"),strictInt(d,"bytes"),d.getString("sha256"),strictInt(d,"recordCount"));require(s.url.matches(Regex("search-index/part-[0-9]{4,}-[a-f0-9]{12}\\.json"))&&validSHA(s.sha256)&&s.url.endsWith("-${s.sha256.take(12)}.json")&&s.bytes in 1..1024*1024&&s.recordCount>0&&seen.add(s.url));s}
        val count=strictInt(value,"recordCount");val total=strictInt(value,"totalBytes");require(count>0&&total in 1..64*1024*1024&&shards.sumOf{it.bytes.toLong()}==total.toLong()&&shards.sumOf{it.recordCount.toLong()}==count.toLong())
        return Manifest(count,total,shards)
    }
    private fun strings(row:JSONObject,key:String):List<String> = row.optJSONArray(key)?.let{a->(0 until a.length()).map{a.getString(it)}}?:emptyList()
    fun normalizedRow(row:JSONObject):ByteArray=OfflineFoundationJSON.encode(row)
    fun read(raw:ByteArray,check:()->Unit={},shardBytes:(Shard)->ByteArray):PublishedAggregateCatalog {
        val m=manifest(raw);val snapshot=sha(raw);val result=mutableListOf<PublishedAggregate>();val pages=mutableSetOf<String>();var sourceRows=0
        for(shard in m.shards){check();val bytes=shardBytes(shard);require(bytes.size==shard.bytes&&sha(bytes)==shard.sha256){"分片与原清单不符"};val rows=JSONArray(PublishedUtf8.decode(bytes));require(rows.length()==shard.recordCount)
            for(i in 0 until rows.length()){check();sourceRows++;val row=rows.getJSONObject(i);val pageType=row.getString("pageType");val kind=if(pageType=="daily-summary")"daily" else pageType;val url=pageURL(row.getString("permalink"));require(pages.add(url)){"目录页面地址重复"};if(kind=="paper")continue
                require(kind in setOf("daily","conference","page")){"非论文类型尚不支持"};val title=row.getString("title");require(title.isNotBlank());val date=row.optString("date");val scope=row.optString("conferenceScope").takeIf{row.has("conferenceScope")&&!row.isNull("conferenceScope")};require(scope==null||kind=="conference"&&scope in setOf("task","overview"))
                row.optJSONObject("citation")?.optString("pageUrl")?.takeIf{it.isNotEmpty()}?.let{require(pageURL(it)==url)}
                val source=AggregateSource(snapshot,shard.sha256,shard.bytes,shard.url,i,sha(normalizedRow(row)),"foundation-sorted-keys-json-v1")
                result+=PublishedAggregate("page:"+URI(url).rawPath,kind,scope,title,row.optString("titleZh",title),row.optString("summary"),date,date.takeUnless{it.isEmpty()||it.startsWith("0001-01-01")},strings(row,"categories"),strings(row,"tags"),url,source)
            }
        }
        require(sourceRows==m.recordCount);return PublishedAggregateCatalog(snapshot,sourceRows,result.sortedBy{it.id})
    }
}
