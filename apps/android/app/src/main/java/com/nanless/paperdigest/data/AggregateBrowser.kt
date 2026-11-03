package com.nanless.paperdigest.data

import kotlinx.coroutines.CancellationException
import org.json.JSONObject
import org.jsoup.Jsoup
import java.time.Instant

/** Aggregate display identity only. Neither this stamp nor any UI DTO grants a paper capability. */
data class AggregateCatalogStamp(val snapshotSHA256:String,val validationEpoch:String)
data class AggregateResource(val sourceURL:String,val missingReason:String)
data class AggregateDocumentView(val descriptor:PublishedAggregate,val bodyHTML:String,val rawHTMLSHA256:String,val bodySHA256:String,val rawHTMLBytes:Int,val fetchedAt:String,val resources:List<AggregateResource>,val notices:List<String>,val fromCache:Boolean,val images:AggregateImageAccess?=null,val imageError:String?=null,val linkHTML:String?=null,val linkNonce:String?=null,val plainText:String?=null) {
    companion object {
        internal fun verified(value:JSONObject,descriptor:PublishedAggregate,fromCache:Boolean):AggregateDocumentView {
            require(value.getString("contract")=="published-aggregate-document-v1"&&canonical(value.getJSONObject("descriptor"))==canonical(descriptor.json()))
            require(value.getString("responseURL")==descriptor.sourceURL&&value.get("completeOffline")==false)
            val raw=value.getString("rawHTMLSHA256");val body=value.getString("bodyHTML");val derived=value.getString("sanitizedBodySHA256")
            require(PublishedAggregateReader.validSHA(raw)&&PublishedAggregateReader.sha(body.toByteArray())==derived&&value.getInt("rawHTMLBytes") in 1..16*1024*1024);Instant.parse(value.getString("fetchedAt"))
            return AggregateDocumentView(descriptor,body,raw,derived,value.getInt("rawHTMLBytes"),value.getString("fetchedAt"),value.getJSONArray("resources").objects().map{AggregateResource(it.getString("sourceURL"),it.getString("missingReason"))},value.getJSONArray("notices").strings(),fromCache,plainText=value.getString("plainText"))
        }
    }
}
/** Display-only text. It has no document, resource, link, PDF, model or export capability. */
data class AggregateTextPreview(val pageID:String,val title:String,val text:String)
data class AggregateBrowseState(val catalog:PublishedAggregateCatalog?=null,val stamp:AggregateCatalogStamp?=null,val selected:PublishedAggregate?=null,val document:AggregateDocumentView?=null,val revisions:List<AggregateCachedRevision> = emptyList(),val loading:Boolean=false,val attemptedIndex:Boolean=false,val catalogStale:Boolean=false,val error:String?=null,val cacheError:String?=null,val offlineMode:Boolean=false,val loadingImages:Boolean=false,val backTitle:String="返回汇总列表",val preview:AggregateTextPreview?=null)

/** A current native cache-only selection, assembled and checked inside one synchronous source scope. */
internal data class AggregateSavedSelection(val catalog:PublishedAggregateCatalog,val descriptor:PublishedAggregate,
    val revisions:List<AggregateCachedRevision>,val document:JSONObject?,val images:AggregateImageAccess?,val cacheError:String?,val imageError:String?)

/** Implemented by the native catalog. UI commands supply IDs/SHA only, never URLs, descriptors or files. */
internal interface AggregateBrowsePort {
    fun stamp():AggregateCatalogStamp
    suspend fun catalog():PublishedAggregateCatalog?
    suspend fun savedSelection(id:String):AggregateSavedSelection?=null
    suspend fun revisions(id:String):List<AggregateCachedRevision>
    suspend fun read(id:String):JSONObject
    suspend fun cached(id:String,sha:String):JSONObject
    suspend fun images(id:String,rawHTMLSHA256:String,allowNetwork:Boolean):AggregateImageAccess?=null
    suspend fun link(document:AggregateDocumentView,href:String):AggregateLinkDestination=AggregateLinkDestination.External(href)
    fun offlineMode():Boolean
    fun readingEpoch():Long
    fun mayPresent(readingEpoch:Long):Boolean
}

/** Private native generation rejects late results, ABA selection and a switch back to a real paper. */
internal class AggregateBrowser(private val port:AggregateBrowsePort,private val claimReading:suspend (()->Boolean)->Boolean,private val publish:(AggregateBrowseState)->Unit,private val commitReading:suspend (()->Boolean,()->Boolean)->Boolean={live,commit->live()&&commit()},private val openLinkedPaper:suspend (Paper,()->Boolean)->JSONObject={_,_->JSONObject().put("status","not-adopted")}) {
    companion object {internal const val PREVIEW_MAX_PAGES=2;internal const val PREVIEW_MAX_BYTES=4*1024*1024}
    private data class SavedText(val stamp:AggregateCatalogStamp,val descriptor:PublishedAggregate,val rawSHA:String,val bodySHA:String,val preview:AggregateTextPreview,val bytes:Int)
    private val previews=linkedMapOf<String,SavedText>()
    private var previewPauses=0
    private fun invalidatePreviewsLocked(){previews.clear();if(state.preview!=null){state=state.copy(preview=null,selected=null,document=null,revisions=emptyList());publish(state)}}
    fun invalidatePreviews()=synchronized(lock){invalidatePreviewsLocked()}
    fun pausePreviews()=synchronized(lock){previewPauses++;invalidatePreviewsLocked()}
    fun resumePreviews()=synchronized(lock){require(previewPauses>0);previewPauses--}
    private fun rememberText(document:AggregateDocumentView,stamp:AggregateCatalogStamp){
        if(previewPauses>0)return
        previews.entries.removeAll{it.value.stamp!=stamp}
        val id=document.descriptor.id;val old=previews.remove(id)
        if(old!=null&&old.rawSHA==document.rawHTMLSHA256&&old.bodySHA==document.bodySHA256){previews[id]=old;return}
        if(document.bodyHTML.length>PREVIEW_MAX_BYTES*2)return
        val text=document.plainText?.takeIf{it.isNotBlank()}?.trim()?:run {
            val tree=Jsoup.parseBodyFragment(document.bodyHTML).body()
            tree.select("script,style,noscript,iframe,object,embed,svg,img,video,audio,canvas").remove()
            tree.select(".katex").forEach{if(it.selectFirst("math")!=null)it.select(".katex-html").remove()}
            tree.select("math").toList().forEach{math->val tex=math.selectFirst("annotation[encoding=application/x-tex]")?.wholeText();math.replaceWith(org.jsoup.nodes.TextNode("[公式：${tex?:math.text()}]"))}
            tree.wholeText().trim()
        }
        if(text.isEmpty())return
        val descriptor=document.descriptor.copy(categories=document.descriptor.categories.toList(),tags=document.descriptor.tags.toList())
        val bytes=text.toByteArray().size+descriptor.json().toString().toByteArray().size+128
        if(bytes>PREVIEW_MAX_BYTES)return
        while(previews.isNotEmpty()&&(previews.size>=PREVIEW_MAX_PAGES||previews.values.sumOf{it.bytes}+bytes>PREVIEW_MAX_BYTES))previews.remove(previews.keys.first())
        previews[id]=SavedText(stamp,descriptor,document.rawHTMLSHA256,document.bodySHA256,AggregateTextPreview(id,descriptor.titleZh.ifBlank{descriptor.title},text),bytes)
    }
    private fun preview(id:String,stamp:AggregateCatalogStamp):SavedText? {
        previews.entries.removeAll{it.value.stamp!=stamp}
        if(previewPauses>0)return null
        return previews.remove(id)?.also{previews[id]=it}
    }
    private var links:AggregateLinkTable?=null
    private var lastUnchangedCheck: Pair<Pair<PublishedAggregate, String>, Instant>? = null
    // Display IDs only. Every back/resume reloads the current native catalog and mints new links.
    private var trail=emptyList<String>()
    private data class SuspendedRoute(val id:String,val trail:List<String>,val stamp:AggregateCatalogStamp?)
    private var suspendedRoute:SuspendedRoute?=null
    private fun parentTitle():String=trail.lastOrNull()?.let{id->state.catalog?.records?.firstOrNull{it.id==id}?.let{"返回"+it.titleZh.ifBlank{it.title}}}?:"返回汇总列表"
    private val lock=Any();private var ticket=0L;private var readingEpoch:Long?=null;private var viewIsCurrent:()->Boolean={true}
    @Volatile var state=AggregateBrowseState();private set
    private fun begin(viewGuard:()->Boolean,initialGuard:()->Boolean={true},transform:(AggregateBrowseState)->AggregateBrowseState):Long=synchronized(lock){if(!viewGuard()||!initialGuard())return -1L;links=null;ticket++;viewIsCurrent=viewGuard;readingEpoch=null;state=transform(state.copy(preview=null));publish(state);ticket}
    private fun withoutFailedPreview(value:AggregateBrowseState):AggregateBrowseState {
        val preview=value.preview?:return value
        previews.remove(preview.pageID)
        return value.copy(preview=null,selected=null,document=null,revisions=emptyList())
    }
    private fun current(token:Long)=synchronized(lock){ticket==token&&viewIsCurrent()}
    private fun change(token:Long,body:(AggregateBrowseState)->AggregateBrowseState):Boolean=synchronized(lock){if(ticket!=token||!viewIsCurrent())return false;state=body(state);publish(state);true}
    private fun ready(token:Long,stamp:AggregateCatalogStamp,epoch:Long)=current(token)&&port.stamp()==stamp&&port.mayPresent(epoch)
    private fun response(status:String)=JSONObject().put("status",status)
    fun enter(){synchronized(lock){trail=emptyList();links=null;ticket++;readingEpoch=null;viewIsCurrent={true};state=state.copy(selected=null,document=null,preview=null,revisions=emptyList(),loading=false,loadingImages=false,attemptedIndex=false,error=null,cacheError=null);publish(state)}}
    fun retire(){synchronized(lock){links=null;ticket++;viewIsCurrent={true};state=state.copy(preview=null,loading=false,loadingImages=false);publish(state)}}
    fun leave(){synchronized(lock){
        state.selected?.let{suspendedRoute=SuspendedRoute(it.id,trail.toList(),state.stamp)}
        trail=emptyList();links=null;viewIsCurrent={true};ticket++;readingEpoch=null;state=state.copy(selected=null,document=null,preview=null,revisions=emptyList(),loading=false,loadingImages=false,error=null,cacheError=null);publish(state)}}
    private fun recordEpoch(token:Long,epoch:Long):Boolean=synchronized(lock){if(ticket!=token||!viewIsCurrent())return false;readingEpoch=epoch;true}
    fun observeNativeState(){
        val stamp=port.stamp()
        synchronized(lock){
            previews.entries.removeAll{it.value.stamp!=stamp}
            if(state.preview!=null&&state.stamp!=stamp){links=null;ticket++;readingEpoch=null;state=state.copy(preview=null,selected=null,document=null,revisions=emptyList(),loading=false,loadingImages=false)}
            val epoch=readingEpoch
            if(epoch!=null&&!port.mayPresent(epoch)){links=null;ticket++;readingEpoch=null;state=state.copy(selected=null,document=null,preview=null,revisions=emptyList(),loading=false,loadingImages=false,error=null,cacheError=null)}
            state=state.copy(catalogStale=state.stamp!=null&&state.stamp!=stamp,offlineMode=port.offlineMode());publish(state)
        }
    }
    suspend fun execute(command:String,payload:JSONObject,viewGuard:()->Boolean={true},claimGuard:()->Boolean={true}):JSONObject {
        if(command=="aggregate.link")return followLink(payload,viewGuard,claimGuard)
        val allowed=when(command){"aggregate.list","aggregate.back","aggregate.close"->emptySet();"aggregate.select","aggregate.resume","aggregate.refresh"->setOf("id");"aggregate.cached"->setOf("id","rawHTMLSHA256");else->throw IllegalArgumentException("未知汇总操作")}
        require(payload.keys().asSequence().toSet()==allowed){"汇总入口只接受原条目身份，不接受网页地址或正文"}
        if(command=="aggregate.close")return synchronized(lock){if(!viewGuard())response("not-adopted")else{leave();response("closed")}}
        if(command=="aggregate.back"){
            val parent=synchronized(lock){if(!viewGuard())return response("not-adopted");trail.lastOrNull()?.let{it to trail.dropLast(1)}}
            if(parent!=null)return select(parent.first,viewGuard,claimGuard,history=parent.second)
            val token=begin(viewGuard){it.copy(selected=null,document=null,revisions=emptyList(),loading=false,loadingImages=false,error=null,cacheError=null)};return response(if(token<0)"not-adopted"else"list")}
        if(command=="aggregate.list")return loadIndex(viewGuard,claimGuard)
        val id=payload.getString("id")
        return if(command in setOf("aggregate.select","aggregate.resume")){
            val history=synchronized(lock){suspendedRoute?.takeIf{command=="aggregate.resume"&&it.id==id&&it.stamp==port.stamp()}?.trail.orEmpty()}
            select(id,viewGuard,claimGuard,history=history)
        }else readSelection(id,if(command=="aggregate.cached")payload.getString("rawHTMLSHA256")else null,viewGuard)
    }
    private suspend fun loadIndex(viewGuard:()->Boolean,claimGuard:()->Boolean):JSONObject {
        val token=begin(viewGuard){trail=emptyList();suspendedRoute=null;it.copy(selected=null,document=null,revisions=emptyList(),loading=true,attemptedIndex=true,error=null,cacheError=null)}
        try {
            if(!claimReading{current(token)&&claimGuard()})return stale(token)
            if(!current(token))return response("not-adopted")
            val epoch=port.readingEpoch();if(!recordEpoch(token,epoch))return response("not-adopted");val stamp=port.stamp()
            // Even a failed first local read records its display epoch, so a later automatic sync
            // can invalidate that empty/error screen. This stamp is not a document/link capability.
            change(token){it.copy(stamp=stamp)}
            val catalog=port.catalog()
            if(!ready(token,stamp,epoch))return stale(token)
            if(catalog==null){change(token){it.copy(catalog=null,stamp=stamp,loading=false,catalogStale=false,offlineMode=port.offlineMode(),error="网站汇总目录尚未核验，请先同步已发布内容。")};return response("needs-sync")}
            require(catalog.snapshotSHA256==stamp.snapshotSHA256)
            change(token){it.copy(catalog=catalog,stamp=stamp,loading=false,catalogStale=false,offlineMode=port.offlineMode())};return response("index-ready")
        }catch(e:CancellationException){cancelled(token);throw e}catch(_:Exception){change(token){it.copy(loading=false,error="汇总目录读取未完成，原资料保留。请重新读取目录。")};return response("failed")}
    }
    private suspend fun select(id:String,viewGuard:()->Boolean,claimGuard:()->Boolean,initialGuard:()->Boolean={true},history:List<String> = emptyList()):JSONObject {
        val token=begin(viewGuard,initialGuard){trail=history.takeLast(24);suspendedRoute=null;it.copy(selected=null,document=null,revisions=emptyList(),loading=true,attemptedIndex=true,error=null,cacheError=null)}
        try {
            if(!claimReading{current(token)&&claimGuard()})return stale(token)
            if(!current(token))return response("not-adopted")
            val epoch=port.readingEpoch();if(!recordEpoch(token,epoch))return response("not-adopted");val stamp=port.stamp()
            synchronized(lock){if(current(token)){preview(id,stamp)?.let{old->change(token){it.copy(stamp=stamp,selected=old.descriptor,document=null,preview=old.preview,revisions=emptyList(),loading=true,loadingImages=false,catalogStale=false,backTitle=parentTitle())}}}}
            val saved=port.savedSelection(id);val catalog=saved?.catalog?:port.catalog()?:return needsSync(token)
            require(catalog.snapshotSHA256==stamp.snapshotSHA256)
            val descriptor=catalog.records.firstOrNull{it.id==id}?:return missing(token)
            require(history.size<=24&&history.all{parent->catalog.records.any{it.id==parent}}){"原返回路径不属于当前目录"}
            if(!ready(token,stamp,epoch))return stale(token)
            require(saved==null||saved.descriptor==descriptor){"缓存选择与当前目录条目不同"}
            var revisions=saved?.revisions?:emptyList();var cacheError=saved?.cacheError
            if(saved==null)try{revisions=port.revisions(id)}catch(e:CancellationException){throw e}catch(_:Exception){cacheError="保存修订清单核验未完成；没有挑选其他旧正文。"}
            if(!ready(token,stamp,epoch))return stale(token)
            change(token){it.copy(catalog=catalog,stamp=stamp,selected=descriptor,revisions=revisions,cacheError=cacheError,catalogStale=false,offlineMode=port.offlineMode(),backTitle=parentTitle())}
            if (revisions.isNotEmpty()) {
                val cached = saved?.document ?: port.cached(id, revisions.first().rawHTMLSHA256)
                val cachedResult = adopt(token, stamp, epoch, descriptor, cached, true,
                    allowImageNetwork = !port.offlineMode(), saved = saved)
                val fetchedAt = Instant.parse(cached.getString("fetchedAt"))
                val now = Instant.now()
                val identity = descriptor to cached.getString("rawHTMLSHA256")
                val lastChecked = synchronized(lock) {
                    lastUnchangedCheck?.takeIf { it.first == identity }?.second ?: fetchedAt
                }
                if (port.offlineMode() || !ready(token, stamp, epoch) ||
                    (!lastChecked.isAfter(now) && lastChecked.plusSeconds(6 * 3600).isAfter(now))) return cachedResult
                return try {
                    val fresh = port.read(id)
                    if (!ready(token, stamp, epoch)) return stale(token)
                    val checked = AggregateDocumentView.verified(fresh, descriptor, false)
                    if (checked.rawHTMLSHA256 == state.document?.rawHTMLSHA256) {
                        synchronized(lock) {
                            if (ready(token, stamp, epoch)) lastUnchangedCheck = identity to now
                        }
                        cachedResult
                    } else adopt(token, stamp, epoch, descriptor, fresh, false)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    cachedResult
                }
            }
            if(port.offlineMode()){change(token){withoutFailedPreview(it).copy(loading=false,error="离线模式下，此条目没有当前目录中已核验的保存正文。")};return response("offline")}
            // Ordinary public webpage read is automatic when no verified same-scope cache exists.
            if(!ready(token,stamp,epoch))return stale(token)
            return adopt(token,stamp,epoch,descriptor,port.read(id),false)
        }catch(e:CancellationException){cancelled(token);throw e}catch(_:Exception){change(token){withoutFailedPreview(it).copy(loading=false,error="网页读取未完成；没有改用其他保存修订。请重试或查看来源。")};return response("failed")}
    }
    private suspend fun readSelection(id:String,sha:String?,viewGuard:()->Boolean):JSONObject {
        val captured=synchronized(lock){
            val prior=state;val selected=prior.selected
            if(!viewGuard())return response("not-adopted")
            if(selected==null||selected.id!=id)return response("not-selected")
            links=null;ticket++;viewIsCurrent=viewGuard;state=prior.copy(document=if(prior.preview!=null)null else prior.document,preview=null,loading=true,error=null);publish(state);Triple(ticket,prior,readingEpoch)
        }
        val token=captured.first;val prior=captured.second;val selected=requireNotNull(prior.selected)
        try {
            val epoch=captured.third?:return stale(token);val stamp=prior.stamp?:return stale(token)
            if(!ready(token,stamp,epoch))return stale(token)
            if(sha==null&&port.offlineMode()){change(token){it.copy(loading=false,error="当前为离线模式；可以明确读取已核验的保存修订。",offlineMode=true)};restoreDocumentLinks(token);return response("offline")}
            if(sha!=null){require(PublishedAggregateReader.validSHA(sha));val verified=port.revisions(id);require(verified.any{it.rawHTMLSHA256==sha});change(token){it.copy(revisions=verified,cacheError=null)}}
            if(!ready(token,stamp,epoch))return stale(token)
            return adopt(token,stamp,epoch,selected,if(sha==null)port.read(id)else port.cached(id,sha),sha!=null)
        }catch(e:CancellationException){cancelled(token);throw e}catch(_:Exception){change(token){it.copy(loading=false,error="本次读取未完成；下方如有正文，仍是原保存版本，未声称刷新成功。")};restoreDocumentLinks(token);return response("failed")}
    }
    private suspend fun adopt(token:Long,stamp:AggregateCatalogStamp,epoch:Long,descriptor:PublishedAggregate,value:JSONObject,cached:Boolean,allowImageNetwork:Boolean=!cached,saved:AggregateSavedSelection?=null):JSONObject {
        if(!ready(token,stamp,epoch))return stale(token)
        val base=AggregateDocumentView.verified(value,descriptor,cached)
        // Publish verified text and fresh link capability before waiting for optional image transport.
        saved?.images?.let{candidate->require(candidate.plan.descriptor==descriptor&&candidate.plan.rawHTMLSHA256==base.rawHTMLSHA256&&candidate.plan.originalBodySHA256==base.bodySHA256){"已保存图片与当前原网页身份不同"}}
        val initial=base.copy(images=saved?.images,imageError=saved?.imageError)
        val needsImages=saved==null || (allowImageNetwork&&!port.offlineMode()&&(saved.images?.missingCount?:base.resources.size)>0)
        val firstTable=AggregateLinkTable.derive(initial)
        val text=initial.copy(linkHTML=firstTable.html,linkNonce=firstTable.nonce)
        val textAdopted=commitReading({ready(token,stamp,epoch)},{synchronized(lock){
            if(!ready(token,stamp,epoch))false else {
                links=firstTable
                rememberText(text,stamp)
                change(token){it.copy(selected=descriptor,document=text,preview=null,loading=false,loadingImages=needsImages,error=null,catalogStale=false,offlineMode=port.offlineMode())}
            }
        }})
        if(!textAdopted)return stale(token)
        if(!needsImages)return response(if(cached)"saved-document"else"website-document")
        var images:AggregateImageAccess?=saved?.images;var imageError:String?=saved?.imageError
        try{
            val candidate=port.images(descriptor.id,base.rawHTMLSHA256,allowImageNetwork&&!port.offlineMode())
            if(candidate!=null)require(candidate.plan.descriptor==descriptor&&candidate.plan.rawHTMLSHA256==base.rawHTMLSHA256&&candidate.plan.originalBodySHA256==base.bodySHA256){"图片与本次原网页修订不同"}
            images=candidate;imageError=null
        }catch(e:CancellationException){throw e}catch(_:Exception){imageError="图片保存或缓存核验未完成；下方仍保留原网页正文，没有改用其他图片修订。"}
        val original=base.copy(images=images,imageError=imageError)
        val table=AggregateLinkTable.derive(original)
        val document=original.copy(linkHTML=table.html,linkNonce=table.nonce)
        var revisions=saved?.revisions?:emptyList();var cacheError=saved?.cacheError
        if(saved==null)try{revisions=port.revisions(descriptor.id)}catch(e:CancellationException){throw e}catch(_:Exception){cacheError="保存修订清单核验未完成；没有自动改用其他修订。"}
        if(!ready(token,stamp,epoch))return stale(token)
        val adopted=commitReading({ready(token,stamp,epoch)},{synchronized(lock){if(!ready(token,stamp,epoch))false else{links=table;rememberText(document,stamp);change(token){it.copy(selected=descriptor,document=document,preview=null,revisions=revisions,loading=false,loadingImages=false,error=null,cacheError=cacheError,catalogStale=false,offlineMode=port.offlineMode())}}}});return if(adopted)response(if(cached)"saved-document"else"website-document")else stale(token)
    }
    fun linkIsCurrent(nonce:String,index:Int):Boolean=synchronized(lock){
        val table=links?:return false;val stamp=state.stamp?:return false;val epoch=readingEpoch?:return false
        table.nonce==nonce&&table.href(index)!=null&&!state.loading&&state.document?.linkNonce==nonce&&ready(ticket,stamp,epoch)
    }
    /** A failed refresh keeps the old verified body, with a fresh presentation ticket. */
    private fun restoreDocumentLinks(token:Long)=synchronized(lock){
        if(state.preview!=null)return@synchronized
        val document=state.document?:return@synchronized
        val stamp=state.stamp?:return@synchronized;val epoch=readingEpoch?:return@synchronized
        if(!ready(token,stamp,epoch)||state.loading||links!=null)return@synchronized
        val table=AggregateLinkTable.derive(document);links=table
        state=state.copy(document=document.copy(linkHTML=table.html,linkNonce=table.nonce));publish(state)
    }
    private suspend fun followLink(payload:JSONObject,viewGuard:()->Boolean,claimGuard:()->Boolean):JSONObject {
        require(payload.keys().asSequence().toSet()==setOf("nonce","index")){"链接入口只接受当前正文位置"}
        val nonce=payload.get("nonce");val number=payload.get("index")
        require(nonce is String&&number is Int&&number>=0){"链接位置无效"}
        val source=synchronized(lock){
            val table=links?:return response("not-adopted")
            val doc=state.document?:return response("not-adopted")
            val stamp=state.stamp?:return response("not-adopted")
            val epoch=readingEpoch?:return response("not-adopted")
            if(table.nonce!=nonce||state.loading||!viewGuard()||!ready(ticket,stamp,epoch))return response("not-adopted")
            val href=table.href(number)?:return response("not-adopted")
            LinkSource(ticket,table,doc,stamp,epoch,href)
        }
        val live={synchronized(lock){links===source.table&&state.document===source.document&&!state.loading&&viewGuard()&&ready(source.ticket,source.stamp,source.epoch)}}
        val destination=port.link(source.document,source.href)
        if(!live())return response("not-adopted")
        return when(destination) {
            is AggregateLinkDestination.Anchor->response("link-ready").put("kind","anchor").put("fragment",destination.rawFragment)
            is AggregateLinkDestination.External->response("link-ready").put("kind","external").put("url",destination.url)
            is AggregateLinkDestination.Aggregate->{
                val history=synchronized(lock){(trail+source.document.descriptor.id).takeLast(24)}
                select(destination.id,viewGuard,claimGuard,live,history)
            }
            is AggregateLinkDestination.PublishedPaper->{
                val result=openLinkedPaper(destination.paper,live)
                if(result.optString("status")=="not-adopted")result else response("link-opened").put("kind","paper").put("paperID",destination.paper.id)
            }
        }
    }
    private data class LinkSource(val ticket:Long,val table:AggregateLinkTable,val document:AggregateDocumentView,val stamp:AggregateCatalogStamp,val epoch:Long,val href:String)
    private fun stale(token:Long):JSONObject {change(token){withoutFailedPreview(it).copy(loading=false,loadingImages=false,catalogStale=true,error="目录或阅读入口已变化；未把旧响应接到新页面。请重新读取目录。")};return response("not-adopted")}
    private fun needsSync(token:Long):JSONObject {change(token){withoutFailedPreview(it).copy(loading=false,loadingImages=false,catalogStale=true,error="网站汇总目录尚未核验，请先同步已发布内容。")};return response("needs-sync")}
    private fun missing(token:Long):JSONObject {change(token){withoutFailedPreview(it).copy(loading=false,error="此条目不在当前已核验的汇总目录中。请重新读取目录。")};return response("missing")}
    private fun cancelled(token:Long){change(token){withoutFailedPreview(it).copy(loading=false,loadingImages=false,error="本次读取已停止；已保存的原修订保留。")};restoreDocumentLinks(token)}
}
