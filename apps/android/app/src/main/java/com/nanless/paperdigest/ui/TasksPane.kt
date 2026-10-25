package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable internal fun TasksPane(state:UiState,action:Action) {
 var filter by rememberSaveable { mutableStateOf("全部") }
 var page by rememberSaveable { mutableIntStateOf(0) }
 val jobs=recordsNewest(state.jobs).filter {
  when(filter) {
   "进行中" -> it.optString("status") in listOf("running","pending","queued")
   "需关注" -> it.optString("status") in listOf("failed","cancelled","interrupted")
   else -> true
  }
 }
 val last=((jobs.size-1).coerceAtLeast(0))/20
 LaunchedEffect(last) { if(page>last) page=last }
 Column(Modifier.fillMaxSize()) {
  SectionTitle("后台任务","真实进度、来源与用量，都有据可查")
  Row(Modifier.padding(horizontal=20.dp),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
   listOf("全部","进行中","需关注").forEach { value ->
    FilterChip(filter==value,{filter=value;page=0},label={Text(value)})
   }
  }
  if(jobs.isEmpty()) EmptyPane("当前没有任务","同步、研究、下载与存档会在这里留下真实记录。")
  LazyColumn(Modifier.weight(1f),contentPadding=PaddingValues(20.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
   items(jobs.drop(page*20).take(20),key={it.optString("id")}) { job ->
    OutlinedCard(Modifier.fillMaxWidth()) {
     Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
      Text(job.optString("title").takeIf{it.isNotBlank()}?:jobTitle(job.optString("kind",job.optString("command"))),style=MaterialTheme.typography.titleMedium)
      Text(jobStatus(job.optString("status")),color=MaterialTheme.colorScheme.primary)
      Text(job.optString("identity",job.optString("paperID","研究空间")),style=MaterialTheme.typography.bodySmall)
      job.optString("message",job.optString("error")).takeIf{it.isNotBlank()}?.let { Text(it) }
      job.optJSONObject("material")?.let { m ->
       Text("材料：${m.optString("kind")} · ${m.optString("createdAt")}\n${if(m.has("fileCount"))m.optInt("fileCount").toString()+" 文件" else "文件数未记录"}\n${m.optString("sha256")}",style=MaterialTheme.typography.labelSmall)
      }
      Text("${job.optString("startedAt")}  ${job.optString("endedAt")}",style=MaterialTheme.typography.labelSmall)
      if(job.optString("status") in listOf("running","pending","queued")) {
       TextButton({action("jobs.cancel",obj("id" to job.optString("id")))}) { Text("取消") }
      }
      job.optJSONObject("usage")?.let { Text("原始用量：$it",style=MaterialTheme.typography.bodySmall) }
      jobSession(job,state.sessions)?.let { session ->
       Text(sessionEvidenceLabel(session),style=MaterialTheme.typography.bodySmall)
       Text(sessionChargeLabel(session),style=MaterialTheme.typography.bodySmall)
       TextButton({action("ui.session.open",obj("id" to session.getString("id")))}){Text("打开原研究记录")}
      }
      job.optString("paperID").takeIf{it.isNotEmpty()}?.let { id ->
       TextButton({action("paper.open",obj("paperID" to id))}) { Text("打开对应论文") }
      }
     }
    }
   }
  }
  Row(Modifier.fillMaxWidth().padding(horizontal=20.dp),horizontalArrangement=Arrangement.SpaceBetween) {
   TextButton({page--},enabled=page>0) { Text("上一页") }
   Text(if(jobs.isEmpty())"0 条" else "${page*20+1}–${minOf((page+1)*20,jobs.size)} / ${jobs.size}",Modifier.padding(top=12.dp))
   TextButton({page++},enabled=page<last) { Text("下一页") }
  }
 }
}

internal fun jobStatus(value:String):String = when(value){"queued","pending"->"等待执行";"running"->"进行中";"completed"->"已完成";"failed"->"未完成";"cancelled"->"已取消";"interrupted"->"已中断，可检查原记录";else->value.ifBlank{"状态未记录"}}
internal fun jobTitle(value:String):String=when(value){"library.sync"->"同步已发布论文";"model.run"->"基于原文继续研究";"model.check"->"检查模型连接";"cloud.upload"->"保存完整研究空间";"cloud.check"->"检查坚果云连接";"cloud.restore"->"恢复研究快照";"zotero.archive"->"完整存档到 Zotero";"zotero.resume"->"继续 Zotero 存档并回读";"pdf.open"->"准备 PDF 原件";else->value.ifBlank{"研究任务"}}

/** Display ordering never rewrites the original cross-platform arrays or invents missing times. */
internal fun recordsNewest(records:List<org.json.JSONObject>):List<org.json.JSONObject> = records.withIndex().sortedWith(compareByDescending<IndexedValue<org.json.JSONObject>>{ indexed ->
 listOf("startedAt","createdAt","endedAt").firstNotNullOfOrNull{key->runCatching{java.time.Instant.parse(indexed.value.optString(key))}.getOrNull()}?:java.time.Instant.MIN
}.thenBy{it.index}).map{it.value}

internal fun jobSession(job:org.json.JSONObject,sessions:List<org.json.JSONObject>):org.json.JSONObject? {
 val explicit=job.optString("sessionID").ifBlank{job.optJSONObject("result")?.optString("sessionID").orEmpty()}
 val id=explicit.ifBlank{job.optString("id")}
 return sessions.firstOrNull{it.optString("id")==id}
}
