package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
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
  LazyColumn(Modifier.weight(1f),contentPadding=PaddingValues(20.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
   item("pending-exports-title") {
    Column {
     Text("待保存原件", style=MaterialTheme.typography.titleMedium)
     state.notice?.takeIf{it.isNotBlank()}?.let{Text(it,style=MaterialTheme.typography.bodySmall)}
     Text("准备完成不表示已写到所选位置。继续时使用原操作的同一份原件，不重新采集当前资料。",style=MaterialTheme.typography.bodySmall)
     TextButton({action("export.pending.list",obj())},enabled=!state.pendingExportsLoading){Text("重新核验待保存清单")}
     if(state.pendingExportsLoading) { LinearProgressIndicator(Modifier.fillMaxWidth());Text("正在读取本机待保存记录…") }
     state.pendingExportsError?.let { Text(it,color=MaterialTheme.colorScheme.error) }
     if(!state.pendingExportsLoading&&state.pendingExportsError==null&&state.pendingExports.isEmpty())Text("尚无待保存原件。")
    }
   }
   items(pendingExportsNewest(state.pendingExports),key={"export-"+it.getString("operationID")}) { pending ->
    OutlinedCard(Modifier.fillMaxWidth().testTag("pending-export-${pending.getString("operationID")}")) {
     Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
      Text(pending.optString("suggestedName").ifBlank{pending.optJSONObject("sourceIdentity")?.optString("label").orEmpty().ifBlank{"本次导出原件"}},style=MaterialTheme.typography.titleMedium)
      Text(pendingExportStatus(pending))
      Text("准备记录：${pending.optString("createdAt")}\n来源：${pending.optJSONObject("sourceIdentity")?.optString("paperID").orEmpty().ifBlank{"研究空间"}}",style=MaterialTheme.typography.bodySmall)
      pending.optJSONObject("sourceIdentity")?.opt("sourceVersion")?.let{it as? String}?.let{Text("原阅读版本：$it",style=MaterialTheme.typography.bodySmall)}
      (pending.opt("bytes") as? Number)?.let{Text("原件逻辑文件长度：${it.toLong()} B",style=MaterialTheme.typography.bodySmall)}
      pending.optString("sha256").takeIf{it.isNotBlank()}?.let{Text("原编码 SHA：$it",style=MaterialTheme.typography.labelSmall)}
      pendingExportMessage(pending)?.let{Text(it)}
      if(pending.optBoolean("ready")&&pending.optString("preparation")=="ready") {
       TextButton({action("export.delivery.prepare",obj("operationID" to pending.getString("operationID")))},enabled=pending.optString("delivery") !in setOf("choosing","writing")) {Text(if(pending.optString("delivery")=="verified")"再次保存同一原件" else "继续保存原件")}
       if(pending.optString("delivery")=="choosing") TextButton({action("export.delivery.cancel",obj("operationID" to pending.getString("operationID"),"attemptID" to pending.getString("attemptID")))}){Text("结束本次位置选择，保留原件")}
      } else if(pending.optString("preparation")=="retained") {
       Text("本次准备已结束，材料原样保留；未重新采集当前研究空间，也不授普通临时副本清理资格。",style=MaterialTheme.typography.bodySmall)
       val delivery=pending.optJSONObject("retainedDelivery")
       delivery?.optString("message")?.takeIf{it.isNotBlank()}?.let{Text(it)}
       TextButton({action("export.retained.prepare",obj("operationID" to pending.getString("operationID")))},enabled=delivery?.optString("state") !in setOf("choosing","writing")) {Text("核验原完整快照并另存")}
       if(delivery?.optString("state")=="choosing") TextButton({action("export.retained.delivery.cancel",obj("operationID" to pending.getString("operationID"),"attemptID" to delivery.getString("attemptID")))}){Text("结束本次位置选择，保留原快照")}
       pending.rows("retainedHistory").forEach{attempt->
        Text("保存尝试：${attempt.optString("attemptID")} · ${retainedAttemptStatus(attempt)}",style=MaterialTheme.typography.bodySmall)
        if(attempt.optString("state")=="readback-proven-history-pending")TextButton({action("export.retained.history.reconcile",obj("operationID" to pending.getString("operationID"),"attemptID" to attempt.getString("attemptID")))}){Text("补记此前已回读事实")}
       }
      } else if(pending.optString("preparation")=="preparing" && pending.optJSONObject("sourceIdentity")?.optString("format")=="backup") {
       TextButton({action("export.retained.stop",obj("operationID" to pending.getString("operationID")))}){Text("停止原准备并原样保留材料…")}
      } else if(pending.optString("preparation") in setOf("interrupted","unavailable")) {
       Text("原材料保留；核验不会重新采集，也不会把未完成材料当成原件。",style=MaterialTheme.typography.bodySmall)
       TextButton({action("export.reconcile",obj("operationID" to pending.getString("operationID")))}){Text("核验本次封存材料")}
       if(pending.optJSONObject("sourceIdentity")?.optString("format")=="backup")TextButton({action("export.retained.stop",obj("operationID" to pending.getString("operationID")))}){Text("结束本次准备并原样保留材料…")}
      }
     }
    }
   }
   item("task-history-title") {Text("任务记录",style=MaterialTheme.typography.titleMedium)}
   if(jobs.isEmpty()&&!state.pendingExportsLoading&&state.pendingExportsError==null) item("empty-jobs") {EmptyPane("当前没有任务","同步、研究、下载与存档会在这里留下真实记录。") }
   items(jobs.drop(page*20).take(20),key={it.optString("id")}) { job ->
    OutlinedCard(Modifier.fillMaxWidth()) {
     Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
      Text(job.optString("title").takeIf{it.isNotBlank()}?:jobTitle(job.optString("kind",job.optString("command"))),style=MaterialTheme.typography.titleMedium)
      Text(jobStatus(job.optString("status")),color=MaterialTheme.colorScheme.primary)
      if(job.optBoolean("localRetainedExport"))Text("本机保留快照任务；此后续任务不属于原捕获快照，不修改原任务和费用。",style=MaterialTheme.typography.bodySmall)
      if(job.optBoolean("localRescueExport"))Text("本机救援导出任务；此任务记录不包含在原研究快照，也不改写原费用与历史。",style=MaterialTheme.typography.bodySmall)
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

internal fun pendingExportStatus(p:org.json.JSONObject):String = when(p.optString("preparation")) {
 "ready" -> when(p.optString("delivery")){"verified"->"所选位置已完整回读；原件仍保留";"written-unverified"->"写流已关闭，完整回读尚未确认";"choosing"->"正在选择保存位置";"writing"->"正在写入与核验，请等实际停止";"cancelled"->"已取消选择位置，原件可继续保存";"failed"->"上次保存未完整确认，原件可继续保存";else->"原件已就绪，尚未保存到所选位置"}
 "retained" -> "本次准备已结束，材料原样保留，尚未授予原件就绪"
 "preparing" -> "正在准备：${p.optString("phase")}"
 "interrupted" -> "准备已中断，未自动重新采集"
 "cancelled" -> "准备已取消，研究原件保留"
 "unavailable" -> "原件或清单暂时无法核验"
 else -> "状态尚未确认，请重新核验"
}

internal fun jobStatus(value:String):String = when(value){"queued","pending"->"等待执行";"running"->"进行中";"completed"->"已完成";"failed"->"未完成";"cancelled"->"已取消";"interrupted"->"已中断，可检查原记录";else->value.ifBlank{"状态未记录"}}
internal fun jobTitle(value:String):String=when(value){"library.sync"->"同步已发布论文";"model.run"->"基于原文继续研究";"model.check"->"检查模型连接";"cloud.upload"->"保存完整研究空间";"cloud.check"->"检查坚果云连接";"cloud.restore"->"恢复研究快照";"zotero.archive"->"完整存档到 Zotero";"zotero.resume"->"继续 Zotero 存档并回读";"pdf.open"->"准备 PDF 原件";"export.retained.prepare"->"核验保留的原完整快照";"export.retained.save"->"另存并回读保留的原快照";"export.prepare"->"准备导出原件";"retained.export.prepare"->"准备保留快照原件";"export.save"->"写出并回读原件";else->value.ifBlank{"研究任务"}}

/** Display ordering never rewrites the original cross-platform arrays or invents missing times. */
internal fun recordsNewest(records:List<org.json.JSONObject>):List<org.json.JSONObject> = records.withIndex().sortedWith(compareByDescending<IndexedValue<org.json.JSONObject>>{ indexed ->
 listOf("startedAt","createdAt","endedAt").firstNotNullOfOrNull{key->runCatching{java.time.Instant.parse(indexed.value.optString(key))}.getOrNull()}?:java.time.Instant.MIN
}.thenBy{it.index}).map{it.value}

internal fun jobSession(job:org.json.JSONObject,sessions:List<org.json.JSONObject>):org.json.JSONObject? {
 if(job.optString("kind") in setOf("export.prepare","retained.export.prepare","export.save","export.retained.prepare","export.retained.save"))return null
 val explicit=job.optString("sessionID").ifBlank{job.optJSONObject("result")?.optString("sessionID").orEmpty()}
 val id=explicit.ifBlank{job.optString("id")}
 return sessions.firstOrNull{it.optString("id")==id}
}

internal fun retainedAttemptStatus(row:org.json.JSONObject):String = when(row.optString("state")) {
 "verified" -> if(row.optBoolean("readbackProven"))"当次完整回读已确认；不代表外部文件此后未变化" else "原回读证明当前无法核验"
 "readback-proven-history-pending" -> if(row.optBoolean("readbackProven"))"当次完整回读已确认，独立历史尚待补记" else "原回读证明当前无法核验"
 "unconfirmed" -> "原回读证明当前无法核验，不能确认成功"
 "written-unverified" -> "写流已关闭，完整回读尚未确认"
 "choosing" -> "正在选择保存位置"
 "writing" -> "正在写入或回读，请等待实际结束"
 "cancelled" -> "已取消位置选择；原快照保留"
 "failed" -> "上次保存未全部确认；外部可能已有文件，原快照保留"
 else -> "尚无已确认的保存事实"
}
