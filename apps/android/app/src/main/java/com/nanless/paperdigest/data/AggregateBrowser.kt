package com.nanless.paperdigest.data

import kotlinx.coroutines.CancellationException
import org.json.JSONObject
import java.time.Instant

/** Aggregate display identity only. Neither this stamp nor any UI DTO grants a paper capability. */
data class AggregateCatalogStamp(val snapshotSHA256:String,val validationEpoch:String)
data class AggregateResource(val sourceURL:String,val missingReason:String)
data class AggregateDocumentView(val descriptor:PublishedAggregate,val bodyHTML:String,val rawHTMLSHA256:String,val bodySHA256:String,val rawHTMLBytes:Int,val fetchedAt:String,val resources:List<AggregateResource>,val notices:List<String>,val fromCache:Boolean,val images:AggregateImageAccess?=null,val imageError:String?=null) {
    companion object {
        internal fun verified(value:JSONObject,descriptor:PublishedAggregate,fromCache:Boolean):AggregateDocumentView {
            require(value.getString("contract")=="published-aggregate-document-v1"&&canonical(value.getJSONObject("descriptor"))==canonical(descriptor.json()))
            require(value.getString("responseURL")==descriptor.sourceURL&&value.get("completeOffline")==false)
            val raw=value.getString("rawHTMLSHA256");val body=value.getString("bodyHTML");val derived=value.getString("sanitizedBodySHA256")
            require(PublishedAggregateReader.validSHA(raw)&&PublishedAggregateReader.sha(body.toByteArray())==derived&&value.getInt("rawHTMLBytes") in 1..16*1024*1024);Instant.parse(value.getString("fetchedAt"))
            return AggregateDocumentView(descriptor,body,raw,derived,value.getInt("rawHTMLBytes"),value.getString("fetchedAt"),value.getJSONArray("resources").objects().map{AggregateResource(it.getString("sourceURL"),it.getString("missingReason"))},value.getJSONArray("notices").strings(),fromCache)
        }
    }
}
data class AggregateBrowseState(val catalog:PublishedAggregateCatalog?=null,val stamp:AggregateCatalogStamp?=null,val selected:PublishedAggregate?=null,val document:AggregateDocumentView?=null,val revisions:List<AggregateCachedRevision> = emptyList(),val loading:Boolean=false,val attemptedIndex:Boolean=false,val catalogStale:Boolean=false,val error:String?=null,val cacheError:String?=null,val offlineMode:Boolean=false)

/** Implemented by the native catalog. UI commands supply IDs/SHA only, never URLs, descriptors or files. */
internal interface AggregateBrowsePort {
    fun stamp():AggregateCatalogStamp
    suspend fun catalog():PublishedAggregateCatalog?
    suspend fun revisions(id:String):List<AggregateCachedRevision>
    suspend fun read(id:String):JSONObject
    suspend fun cached(id:String,sha:String):JSONObject
    suspend fun images(id:String,rawHTMLSHA256:String,allowNetwork:Boolean):AggregateImageAccess?=null
    fun offlineMode():Boolean
    fun readingEpoch():Long
    fun mayPresent(readingEpoch:Long):Boolean
}

/** Private native generation rejects late results, ABA selection and a switch back to a real paper. */
internal class AggregateBrowser(private val port:AggregateBrowsePort,private val claimReading:suspend (()->Boolean)->Boolean,private val publish:(AggregateBrowseState)->Unit,private val commitReading:suspend (()->Boolean,()->Boolean)->Boolean={live,commit->live()&&commit()}) {
    private val lock=Any();private var ticket=0L;private var readingEpoch:Long?=null;private var viewIsCurrent:()->Boolean={true}
    @Volatile var state=AggregateBrowseState();private set
    private fun begin(viewGuard:()->Boolean,transform:(AggregateBrowseState)->AggregateBrowseState):Long=synchronized(lock){if(!viewGuard())return -1L;ticket++;viewIsCurrent=viewGuard;readingEpoch=null;state=transform(state);publish(state);ticket}
    private fun current(token:Long)=synchronized(lock){ticket==token&&viewIsCurrent()}
    private fun change(token:Long,body:(AggregateBrowseState)->AggregateBrowseState):Boolean=synchronized(lock){if(ticket!=token||!viewIsCurrent())return false;state=body(state);publish(state);true}
    private fun ready(token:Long,stamp:AggregateCatalogStamp,epoch:Long)=current(token)&&port.stamp()==stamp&&port.mayPresent(epoch)
    private fun response(status:String)=JSONObject().put("status",status)
    fun enter(){synchronized(lock){ticket++;readingEpoch=null;viewIsCurrent={true};state=state.copy(selected=null,document=null,revisions=emptyList(),loading=false,attemptedIndex=false,error=null,cacheError=null);publish(state)}}
    fun retire(){synchronized(lock){ticket++;viewIsCurrent={true};state=state.copy(loading=false);publish(state)}}
    fun leave(){synchronized(lock){viewIsCurrent={true};ticket++;readingEpoch=null;state=state.copy(selected=null,document=null,revisions=emptyList(),loading=false,error=null,cacheError=null);publish(state)}}
    private fun recordEpoch(token:Long,epoch:Long):Boolean=synchronized(lock){if(ticket!=token||!viewIsCurrent())return false;readingEpoch=epoch;true}
    fun observeNativeState(){
        val stamp=port.stamp()
        synchronized(lock){val epoch=readingEpoch
            if(epoch!=null&&!port.mayPresent(epoch)){ticket++;readingEpoch=null;state=state.copy(selected=null,document=null,revisions=emptyList(),loading=false,error=null,cacheError=null)}
            state=state.copy(catalogStale=state.stamp!=null&&state.stamp!=stamp,offlineMode=port.offlineMode());publish(state)
        }
    }
    suspend fun execute(command:String,payload:JSONObject,viewGuard:()->Boolean={true},claimGuard:()->Boolean={true}):JSONObject {
        val allowed=when(command){"aggregate.list","aggregate.back","aggregate.close"->emptySet();"aggregate.select","aggregate.refresh"->setOf("id");"aggregate.cached"->setOf("id","rawHTMLSHA256");else->throw IllegalArgumentException("未知汇总操作")}
        require(payload.keys().asSequence().toSet()==allowed){"汇总入口只接受原条目身份，不接受网页地址或正文"}
        if(command=="aggregate.close")return synchronized(lock){if(!viewGuard())response("not-adopted")else{leave();response("closed")}}
        if(command=="aggregate.back"){val token=begin(viewGuard){it.copy(selected=null,document=null,revisions=emptyList(),loading=false,error=null,cacheError=null)};return response(if(token<0)"not-adopted"else"list")}
        if(command=="aggregate.list")return loadIndex(viewGuard,claimGuard)
        val id=payload.getString("id")
        return if(command=="aggregate.select")select(id,viewGuard,claimGuard)else readSelection(id,if(command=="aggregate.cached")payload.getString("rawHTMLSHA256")else null,viewGuard)
    }
    private suspend fun loadIndex(viewGuard:()->Boolean,claimGuard:()->Boolean):JSONObject {
        val token=begin(viewGuard){it.copy(selected=null,document=null,revisions=emptyList(),loading=true,attemptedIndex=true,error=null,cacheError=null)}
        try {
            if(!claimReading{current(token)&&claimGuard()})return stale(token)
            if(!current(token))return response("not-adopted")
            val epoch=port.readingEpoch();if(!recordEpoch(token,epoch))return response("not-adopted");val stamp=port.stamp();val catalog=port.catalog()
            if(!ready(token,stamp,epoch))return stale(token)
            if(catalog==null){change(token){it.copy(catalog=null,stamp=stamp,loading=false,catalogStale=false,offlineMode=port.offlineMode(),error="网站汇总目录尚未核验，请先同步已发布内容。")};return response("needs-sync")}
            require(catalog.snapshotSHA256==stamp.snapshotSHA256)
            change(token){it.copy(catalog=catalog,stamp=stamp,loading=false,catalogStale=false,offlineMode=port.offlineMode())};return response("index-ready")
        }catch(e:CancellationException){cancelled(token);throw e}catch(_:Exception){change(token){it.copy(loading=false,error="汇总目录读取未完成，原资料保留。请重新读取目录。")};return response("failed")}
    }
    private suspend fun select(id:String,viewGuard:()->Boolean,claimGuard:()->Boolean):JSONObject {
        val token=begin(viewGuard){it.copy(selected=null,document=null,revisions=emptyList(),loading=true,attemptedIndex=true,error=null,cacheError=null)}
        try {
            if(!claimReading{current(token)&&claimGuard()})return stale(token)
            if(!current(token))return response("not-adopted")
            val epoch=port.readingEpoch();if(!recordEpoch(token,epoch))return response("not-adopted");val stamp=port.stamp();val catalog=port.catalog()?:return needsSync(token)
            require(catalog.snapshotSHA256==stamp.snapshotSHA256)
            val descriptor=catalog.records.firstOrNull{it.id==id}?:return missing(token)
            if(!ready(token,stamp,epoch))return stale(token)
            var revisions=emptyList<AggregateCachedRevision>();var cacheError:String?=null
            try{revisions=port.revisions(id)}catch(e:CancellationException){throw e}catch(_:Exception){cacheError="保存修订清单核验未完成；没有挑选其他旧正文。"}
            if(!ready(token,stamp,epoch))return stale(token)
            change(token){it.copy(catalog=catalog,stamp=stamp,selected=descriptor,revisions=revisions,cacheError=cacheError,catalogStale=false,offlineMode=port.offlineMode())}
            if(revisions.isNotEmpty())return adopt(token,stamp,epoch,descriptor,port.cached(id,revisions.first().rawHTMLSHA256),true)
            if(port.offlineMode()){change(token){it.copy(loading=false,error="离线模式下，此条目没有当前目录中已核验的保存正文。")};return response("offline")}
            // Ordinary public webpage read is automatic when no verified same-scope cache exists.
            if(!ready(token,stamp,epoch))return stale(token)
            return adopt(token,stamp,epoch,descriptor,port.read(id),false)
        }catch(e:CancellationException){cancelled(token);throw e}catch(_:Exception){change(token){it.copy(loading=false,error="网页读取未完成；没有改用其他保存修订。请重试或查看来源。")};return response("failed")}
    }
    private suspend fun readSelection(id:String,sha:String?,viewGuard:()->Boolean):JSONObject {
        val captured=synchronized(lock){
            val prior=state;val selected=prior.selected
            if(!viewGuard())return response("not-adopted")
            if(selected==null||selected.id!=id)return response("not-selected")
            ticket++;viewIsCurrent=viewGuard;state=prior.copy(loading=true,error=null);publish(state);Triple(ticket,prior,readingEpoch)
        }
        val token=captured.first;val prior=captured.second;val selected=requireNotNull(prior.selected)
        try {
            val epoch=captured.third?:return stale(token);val stamp=prior.stamp?:return stale(token)
            if(!ready(token,stamp,epoch))return stale(token)
            if(sha==null&&port.offlineMode()){change(token){it.copy(loading=false,error="当前为离线模式；可以明确读取已核验的保存修订。",offlineMode=true)};return response("offline")}
            if(sha!=null){require(PublishedAggregateReader.validSHA(sha));val verified=port.revisions(id);require(verified.any{it.rawHTMLSHA256==sha});change(token){it.copy(revisions=verified,cacheError=null)}}
            if(!ready(token,stamp,epoch))return stale(token)
            return adopt(token,stamp,epoch,selected,if(sha==null)port.read(id)else port.cached(id,sha),sha!=null)
        }catch(e:CancellationException){cancelled(token);throw e}catch(_:Exception){change(token){it.copy(loading=false,error="本次读取未完成；下方如有正文，仍是原保存版本，未声称刷新成功。")};return response("failed")}
    }
    private suspend fun adopt(token:Long,stamp:AggregateCatalogStamp,epoch:Long,descriptor:PublishedAggregate,value:JSONObject,cached:Boolean):JSONObject {
        if(!ready(token,stamp,epoch))return stale(token)
        val base=AggregateDocumentView.verified(value,descriptor,cached)
        var images:AggregateImageAccess?=null;var imageError:String?=null
        try{
            val candidate=port.images(descriptor.id,base.rawHTMLSHA256,!cached&&!port.offlineMode())
            if(candidate!=null)require(candidate.plan.descriptor==descriptor&&candidate.plan.rawHTMLSHA256==base.rawHTMLSHA256&&candidate.plan.originalBodySHA256==base.bodySHA256){"图片与本次原网页修订不同"}
            images=candidate
        }catch(e:CancellationException){throw e}catch(_:Exception){imageError="图片保存或缓存核验未完成；下方仍保留原网页正文，没有改用其他图片修订。"}
        val document=base.copy(images=images,imageError=imageError)
        var revisions=emptyList<AggregateCachedRevision>();var cacheError:String?=null
        try{revisions=port.revisions(descriptor.id)}catch(e:CancellationException){throw e}catch(_:Exception){cacheError="保存修订清单核验未完成；没有自动改用其他修订。"}
        if(!ready(token,stamp,epoch))return stale(token)
        val adopted=commitReading({ready(token,stamp,epoch)},{change(token){it.copy(selected=descriptor,document=document,revisions=revisions,loading=false,error=null,cacheError=cacheError,catalogStale=false,offlineMode=port.offlineMode())}});return if(adopted)response(if(cached)"saved-document"else"website-document")else stale(token)
    }
    private fun stale(token:Long):JSONObject {change(token){it.copy(loading=false,catalogStale=true,error="目录或阅读入口已变化；未把旧响应接到新页面。请重新读取目录。")};return response("not-adopted")}
    private fun needsSync(token:Long):JSONObject {change(token){it.copy(loading=false,catalogStale=true,error="网站汇总目录尚未核验，请先同步已发布内容。")};return response("needs-sync")}
    private fun missing(token:Long):JSONObject {change(token){it.copy(loading=false,error="此条目不在当前已核验的汇总目录中。请重新读取目录。")};return response("missing")}
    private fun cancelled(token:Long){change(token){it.copy(loading=false,error="本次读取已停止；已保存的原修订保留。")}}
}
