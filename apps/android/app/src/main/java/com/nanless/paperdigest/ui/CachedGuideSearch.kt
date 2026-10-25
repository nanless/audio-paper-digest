package com.nanless.paperdigest.ui

import androidx.compose.runtime.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import org.json.JSONObject

/** A receipt is valid only for its literal query and the explicit cached-guide scope. */
internal data class CachedGuideMatches(val query:String,val paperIDs:Set<String>,val scanned:Int,val unavailable:Int)
internal fun cachedGuideMatches(receipt:JSONObject,query:String):CachedGuideMatches {
 require(receipt.opt("query")==query&&receipt.opt("scope")=="cached-published-guides"){"缓存检索回执与本次查询不一致"}
 fun count(key:String):Int {
  val n=receipt.opt(key) as? Number?:error("缓存检索未返回实际检查数量")
  val value=n.toLong();require(value in 0..Int.MAX_VALUE.toLong()&&n.toDouble()==value.toDouble()){"缓存检索数量无效"};return value.toInt()
 }
 val scanned=count("scannedArticles");val unavailable=count("unavailableArticles")
 val ids=receipt.optJSONArray("paperIDs")?:error("缓存检索未返回论文身份")
 val matches=LinkedHashSet<String>()
 for(i in 0 until ids.length()){val id=ids.opt(i) as? String;require(!id.isNullOrBlank()){"缓存检索论文身份无效"};matches+=id}
 return CachedGuideMatches(query,matches,scanned,unavailable)
}
internal data class CachedGuideSearchState(val query:String,val result:CachedGuideMatches?=null,val error:String?=null,val loading:Boolean=false)

@Composable internal fun rememberCachedGuideSearch(controller:AppController,query:String,retry:Int,cacheIdentity:Any?):CachedGuideSearchState {
 var state by remember(controller){mutableStateOf(CachedGuideSearchState(""))}
 val latestQuery by rememberUpdatedState(query)
 LaunchedEffect(controller,query,retry,cacheIdentity){
  if(query.isBlank()){state=CachedGuideSearchState(query);return@LaunchedEffect}
  if(query.length>256){state=CachedGuideSearchState(query,error="本机导读检索最多 256 个字符；当前仍匹配论文信息与笔记。");return@LaunchedEffect}
  state=CachedGuideSearchState(query,loading=true)
  try {
   delay(300)
   val receipt=controller.execute("library.search",obj("query" to query))
   currentCoroutineContext().ensureActive()
   if(latestQuery==query)state=CachedGuideSearchState(query,result=cachedGuideMatches(receipt,query))
  }catch(e:CancellationException){throw e}catch(e:Exception){
   currentCoroutineContext().ensureActive()
   if(latestQuery==query)state=CachedGuideSearchState(query,error=e.message?:"本机导读检索未完成，论文信息与笔记仍可检索。")
  }
 }
 // Do not expose the preceding query's IDs even before its cancelled coroutine resumes.
 return if(state.query==query)state else CachedGuideSearchState(query,loading=query.isNotBlank()&&query.length<=256)
}
