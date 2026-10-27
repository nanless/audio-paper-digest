package com.nanless.paperdigest.data

import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.TextNode
import java.io.InputStream
import java.time.Instant
import java.util.UUID

/** Source-bound aggregate resources only; never a Paper or scientific/model capability. */
data class AggregateImageSlot(val index:Int,val sourceURL:String?,val alternative:String,val caption:String) {
    fun json()=JSONObject().put("index",index).put("alternative",alternative).put("caption",caption).apply{sourceURL?.let{put("sourceURL",it)}}
}
data class AggregateImagePlan(val descriptor:PublishedAggregate,val rawHTMLSHA256:String,val originalBodySHA256:String,val slots:List<AggregateImageSlot>,val templateBodyHTML:String) {
    fun json()=JSONObject().put("contract",AggregateImages.CONTRACT).put("descriptor",descriptor.json()).put("rawHTMLSHA256",rawHTMLSHA256).put("originalBodySHA256",originalBodySHA256).put("slots",JSONArray(slots.map{it.json()})).put("templateBodyHTML",templateBodyHTML).put("templateBodySHA256",PublishedAggregateReader.sha(templateBodyHTML.toByteArray()))
}
data class AggregateImageRecord(val slot:AggregateImageSlot,val sha256:String?=null,val mime:String?=null,val bytes:Int?=null,val missingReason:String?=null) {
    fun json()=JSONObject().put("slot",slot.json()).apply{sha256?.let{put("sha256",it)};mime?.let{put("mime",it)};bytes?.let{put("bytes",it)};missingReason?.let{put("missingReason",it)}}
}
data class AggregateImageBlob(val sha256:String,val mime:String,val bytes:Int)

data class AggregateImageImport(val platform:String,val manifestSHA256:String) {
    init{require(platform in setOf("macos","android")&&PublishedAggregateReader.validSHA(manifestSHA256))}
    fun json()=JSONObject().put("platform",platform).put("manifestSHA256",manifestSHA256)
}
object AggregateImages {
    const val CONTRACT="published-aggregate-image-render-v1"
    const val DIRECTORY="aggregate-resource-renders-android-v1"
    const val MAX_IMAGE_BYTES=16*1024*1024
    const val MAX_TRANSFER_BYTES=64*1024*1024
    const val MAX_REFERENCED_BYTES=64*1024*1024
    private val raster=setOf("image/png","image/jpeg","image/gif","image/webp")
    fun rasterMIME(header:ByteArray):String {
        if(header.size>=8&&header.take(8).toByteArray().contentEquals(byteArrayOf(0x89.toByte(),80,78,71,13,10,26,10)))return "image/png"
        if(header.size>=3&&header[0]==0xff.toByte()&&header[1]==0xd8.toByte()&&header[2]==0xff.toByte())return "image/jpeg"
        if(header.size>=6&&String(header,0,6,Charsets.US_ASCII) in setOf("GIF87a","GIF89a"))return "image/gif"
        if(header.size>=12&&String(header,0,4,Charsets.US_ASCII)=="RIFF"&&String(header,8,4,Charsets.US_ASCII)=="WEBP")return "image/webp"
        error("汇总图片字节类型不受支持")
    }
    /** Integer/range checks precede blob allocation; every repeated reference consumes the raw-byte budget. */
    fun records(plan:AggregateImagePlan,rows:JSONArray):List<AggregateImageRecord> {
        require(rows.length()==plan.slots.size&&rows.length()<=128)
        return (0 until rows.length()).map{i->val row=rows.getJSONObject(i);require(canonical(row.getJSONObject("slot"))==canonical(plan.slots[i].json()))
            val sha=row.optString("sha256").takeUnless{it.isEmpty()};val mime=row.optString("mime").takeUnless{it.isEmpty()};val reason=row.optString("missingReason").takeUnless{it.isEmpty()}
            val size=if(row.has("bytes")&&!row.isNull("bytes")){val value=row.get("bytes");require(value is Int||value is Long);(value as Number).toLong().also{require(it in 1..MAX_IMAGE_BYTES.toLong())}.toInt()}else null
            AggregateImageRecord(plan.slots[i],sha,mime,size,reason)
        }.also{validateReferenceBudget(it)}
    }
    fun validateReferenceBudget(records:List<AggregateImageRecord>) {
        require(records.size<=128);var total=0
        for(record in records){
            if(record.sha256!=null){require(PublishedAggregateReader.validSHA(record.sha256)&&record.slot.sourceURL!=null&&record.mime in raster&&record.missingReason==null);val size=requireNotNull(record.bytes);require(size in 1..MAX_IMAGE_BYTES&&size<=MAX_REFERENCED_BYTES-total){"页面图片引用累计超过64 MiB"};total+=size}
            else require(record.mime==null&&record.bytes==null&&!record.missingReason.isNullOrBlank()){"图片缺项状态无效"}
        }
    }
    /** Stable native derivation uses logical SHA references, never data URIs or untrusted network addresses. */
    fun render(plan:AggregateImagePlan,records:List<AggregateImageRecord>,scope:String?=null):String {
        require(records.map{it.slot}==plan.slots);validateReferenceBudget(records)
        require(plan.templateBodyHTML.toByteArray().size<=16*1024*1024)
        scope?.let{require(UUID.fromString(it).toString()==it)}
        val doc=Jsoup.parseBodyFragment(plan.templateBodyHTML);val nodes=doc.body().select("img");require(nodes.size==records.size)
        nodes.forEachIndexed{i,image->val record=records[i];image.removeAttr("src")
            if(record.sha256!=null)image.attr("src",if(scope==null)"aggregate-image:${record.sha256}"else"https://reader.invalid/aggregate-images/$scope/${record.sha256}")
            else image.replaceWith(TextNode("[图片未缓存"+(if(record.slot.alternative.isEmpty())""else"：${record.slot.alternative}")+"]"))
        }
        return doc.body().html()
    }
    fun manifest(plan:AggregateImagePlan,records:List<AggregateImageRecord>,observedAt:String,origin:AggregateImageImport?=null):JSONObject {
        Instant.parse(observedAt);val body=render(plan,records)
        return JSONObject().put("contract",CONTRACT).put("parserContract","published-aggregate-jsoup-images-v1").put("plan",plan.json()).put("observedAt",observedAt).put("images",JSONArray(records.map{it.json()})).put("renderedBodySHA256",PublishedAggregateReader.sha(body.toByteArray())).put("completeOffline",false).apply{origin?.let{put("importedFrom",it.json())}}
    }
}

/** One immutable native access owns its random image scope. UI/bridge cannot submit a path, URL or bytes. */
class AggregateImageAccess internal constructor(
    val manifestSHA256:String,val plan:AggregateImagePlan,val records:List<AggregateImageRecord>,val observedAt:String,
    private val openVerified:(AggregateImageRecord)->InputStream,val importedFrom:AggregateImageImport?=null,
) {
    private val scope=UUID.randomUUID().toString()
    val bodyHTML=AggregateImages.render(plan,records,scope)
    val cspImageSource="https://reader.invalid/aggregate-images/$scope/"
    val savedCount=records.count{it.sha256!=null}
    val missingCount=records.size-savedCount
    private val byURL=records.filter{it.sha256!=null}.associateBy{cspImageSource+it.sha256}
    fun canServe(url:String,isMainFrame:Boolean,method:String)=!isMainFrame&&method=="GET"&&byURL.containsKey(url)
    fun open(url:String,isMainFrame:Boolean,method:String):Pair<String,InputStream>? {
        if(!canServe(url,isMainFrame,method))return null
        val record=byURL.getValue(url);return requireNotNull(record.mime) to openVerified(record)
    }
}

/** Sequential native downloads keep only SHA metadata between slots; no64MiB in-memory image collection. */
internal object AggregateImageLoader {
    suspend fun read(store:PublishedAggregateStore,descriptor:PublishedAggregate,raw:String,allowNetwork:Boolean,
        approved:(String)->Boolean,fetch:suspend (String,Int)->ByteArray,check:()->Unit={}):AggregateImageAccess? {
        kotlinx.coroutines.currentCoroutineContext().ensureActive();check()
        val cached=store.latestImageRendering(descriptor,raw)?:store.importMacImageRendering(descriptor,raw)
        kotlinx.coroutines.currentCoroutineContext().ensureActive();check()
        if(!allowNetwork||cached?.missingCount==0)return cached
        val plan=store.imagePlan(descriptor,raw);if(plan.slots.isEmpty())return null
        require(cached==null||canonical(cached.plan.json())==canonical(plan.json())){"已有图片与当前网页位置不符"}
        val saved=cached?.records?.filter{it.sha256!=null}?.associateBy{it.slot.index}.orEmpty()
        val retainedBytes=saved.values.sumOf{requireNotNull(it.bytes)}
        require(retainedBytes<=AggregateImages.MAX_REFERENCED_BYTES)
        val downloaded=mutableMapOf<String,AggregateImageBlob>();val records=mutableListOf<AggregateImageRecord>();var transferred=0;var referenced=retainedBytes
        fun missing(slot:AggregateImageSlot)=AggregateImageRecord(slot,missingReason="该图片未保存；原地址不可用、类型不支持或超出安全限额")
        for(existing in saved.values){
            downloaded.putIfAbsent(requireNotNull(existing.slot.sourceURL),AggregateImageBlob(requireNotNull(existing.sha256),requireNotNull(existing.mime),requireNotNull(existing.bytes)))
        }
        for(slot in plan.slots){
            kotlinx.coroutines.currentCoroutineContext().ensureActive();check()
            val existing=saved[slot.index]
            if(existing!=null){
                require(existing.slot==slot);val size=requireNotNull(existing.bytes)
                records+=existing
                downloaded[requireNotNull(slot.sourceURL)]=AggregateImageBlob(requireNotNull(existing.sha256),requireNotNull(existing.mime),size)
                continue
            }
            val address=slot.sourceURL
            if(address==null||!approved(address)||referenced>=AggregateImages.MAX_REFERENCED_BYTES){records+=missing(slot);continue}
            var blob=downloaded[address]
            if(blob==null){
                val remaining=minOf(AggregateImages.MAX_IMAGE_BYTES,AggregateImages.MAX_TRANSFER_BYTES-transferred,AggregateImages.MAX_REFERENCED_BYTES-referenced)
                if(remaining<=0){records+=missing(slot);continue}
                val bytes=try{fetch(address,remaining)}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(_:Exception){transferred=AggregateImages.MAX_TRANSFER_BYTES;records+=missing(slot);continue}
                kotlinx.coroutines.currentCoroutineContext().ensureActive();check()
                if(bytes.isEmpty()||bytes.size>remaining){transferred=AggregateImages.MAX_TRANSFER_BYTES;records+=missing(slot);continue}
                transferred+=bytes.size
                val supported=runCatching{AggregateImages.rasterMIME(bytes.copyOfRange(0,minOf(16,bytes.size)))}.isSuccess
                if(!supported){records+=missing(slot);continue}
                // Filesystem/publication errors are not rewritten as ordinary missing network images.
                blob=store.cacheImageBlob(bytes);downloaded[address]=blob
            }
            if(blob.bytes>AggregateImages.MAX_REFERENCED_BYTES-referenced){records+=missing(slot);continue}
            referenced+=blob.bytes;records+=AggregateImageRecord(slot,blob.sha256,blob.mime,blob.bytes)
        }
        kotlinx.coroutines.currentCoroutineContext().ensureActive();check()
        return store.cacheImageRendering(plan,records,Instant.now().toString())
    }
}
