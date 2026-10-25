package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.isActive
import org.json.JSONObject
import java.util.Locale

/** Explicit measurements and native cleanup plans; reading this pane never starts deletion. */
@Composable internal fun StorageCapacityControls(state:UiState,controller:AppController){
 var measured by remember{mutableStateOf<JSONObject?>(null)}
 var plan by remember{mutableStateOf<JSONObject?>(null)}
 var operation by remember{mutableStateOf<String?>(null)}
 var error by remember{mutableStateOf<String?>(null)}
 var message by remember{mutableStateOf<String?>(null)}
 val scope=rememberCoroutineScope()
 val busy=operation!=null||state.busy
 suspend fun refresh(){
  val next=controller.execute("storage.capacity")
  validateCapacity(next);currentCoroutineContext().ensureActive();measured=JSONObject(next.toString())
 }
 fun perform(kind:String,action:suspend()->Unit){
  if(operation!=null)return
  operation=kind;error=null
  scope.launch{try{action()}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message?:"本次核对未完成，未将未知结果显示为成功"}finally{operation=null}}
 }
 HorizontalDivider();Text("存储容量",style=MaterialTheme.typography.titleMedium)
 Text("读取本机实际文件大小和可用空间。云端保留快照属于传输材料的一部分，不重复相加。",style=MaterialTheme.typography.bodySmall)
 OutlinedButton({perform("measure"){refresh()}},enabled=!busy){Text(if(operation=="measure")"正在统计实际文件…" else "重新统计容量")}
 measured?.let{report->
  Text("实际可用空间：${storageBytes(storageCount(report,"availableBytes"))}")
  Text("统计时间：${report.getString("measuredAt")}",style=MaterialTheme.typography.labelSmall)
  report.rows("rows").forEach{row->
   Column(Modifier.fillMaxWidth().padding(vertical=4.dp)){
    Text(row.getString("label")+(if(row.getBoolean("exists"))"" else "（尚未创建）"))
    Text("${storageBytes(storageCount(row,"bytes"))} · ${storageCount(row,"fileCount")} 文件",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
   }
  }
  report.optJSONObject("retainedCloud")?.let{retained->Text("其中保留的云传输快照：${storageBytes(storageCount(retained,"bytes"))} · ${storageCount(retained,"fileCount")} 文件（已包含在传输材料内）",style=MaterialTheme.typography.bodySmall)}
  report.optJSONObject("lastCleanup")?.let{Text("上次清理回执：${cleanupOutcome(it)}",style=MaterialTheme.typography.bodySmall)}
 }
 Text("清理已导出的临时副本",style=MaterialTheme.typography.titleMedium)
 Text("仅核对本机导出临时文件：已成功写出，而且所选目的文件现在仍能完整回读并核对 SHA。每次最多 20 份，不删除研究资料、PDF、离线包、费用记录、未知文件或用户选择的目的文件。",style=MaterialTheme.typography.bodySmall)
 OutlinedButton({perform("prepare"){
  val next=controller.execute("storage.cleanup.prepare");validateCleanupPlan(next);currentCoroutineContext().ensureActive()
  if(storageCount(next,"documents")==0L){plan=null;message="当前没有满足完整导出回读条件的临时副本。未删除文件。"}else{plan=JSONObject(next.toString());message=null}
 }},enabled=!busy){Text(if(operation=="prepare")"正在完整回读已导出文件…" else "核对可清理的临时副本…")}
 if(operation=="commit")Text("正在清理已确认的临时副本；完成后会重新统计实际容量。",style=MaterialTheme.typography.bodySmall)
 message?.let{Text(it,color=MaterialTheme.colorScheme.primary)}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 plan?.let{prepared->
  AlertDialog(onDismissRequest={if(operation!="commit")plan=null},title={Text("清理这些已核验的临时副本？")},text={
   Column(Modifier.heightIn(max=330.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(10.dp)){
    Text("${storageCount(prepared,"documents")} 份导出，${storageCount(prepared,"files")} 个临时文件，逻辑大小 ${storageBytes(storageCount(prepared,"bytes"))}。")
    Text("正式删除前会再次完整回读目的文件并核对原副本。这里只删除本机导出临时副本，目的文件与研究资料保留。取消不删除文件。")
    Text("${storageCount(prepared,"retainedDocuments")} 份未满足条件的导出、${storageCount(prepared,"unknownEntries")} 个未知条目保留；另有 ${storageCount(prepared,"deferredDocuments")} 份留待下次核对。",style=MaterialTheme.typography.bodySmall)
    prepared.rows("items").forEach{item->Text("${item.getString("name")} · ${storageBytes(storageCount(item,"bytes"))}",style=MaterialTheme.typography.bodySmall)}
    Text("计划有效期至 ${prepared.getString("expiresAt")}",style=MaterialTheme.typography.labelSmall)
   }
  },confirmButton={TextButton({
   val originalID=prepared.getString("planID")
   perform("commit"){
    try{
     val result=controller.execute("storage.cleanup.commit",obj("planID" to originalID));currentCoroutineContext().ensureActive()
     message=cleanupOutcome(result);plan=null
    }catch(e:CancellationException){throw e}catch(e:Exception){plan=null;throw e}
    finally{
     if(currentCoroutineContext().isActive)try{refresh()}catch(e:CancellationException){throw e}catch(e:Exception){error="容量重新统计未完成；清理回执保留，请重试统计。"}
    }
   }
  },enabled=!busy){Text(if(operation=="commit")"正在清理…" else "仅清理这些临时副本")}},dismissButton={TextButton({plan=null},enabled=!busy){Text("取消，保留副本")}})
 }
}

internal fun storageCount(value:JSONObject,key:String):Long {
 val raw=value.get(key);require(raw is Number&&raw.toDouble().isFinite()&&raw.toDouble()==raw.toLong().toDouble()&&raw.toLong()>=0){"容量或清理回执字段无效，未以零代替未知值"};return raw.toLong()
}
internal fun storageBytes(bytes:Long):String {
 require(bytes>=0)
 return when{bytes>=1024L*1024*1024->String.format(Locale.ROOT,"%.2f GiB",bytes/(1024.0*1024*1024));bytes>=1024L*1024->String.format(Locale.ROOT,"%.2f MiB",bytes/(1024.0*1024));bytes>=1024->String.format(Locale.ROOT,"%.1f KiB",bytes/1024.0);else->"$bytes B"}
}
private fun validateCapacity(value:JSONObject){
 require(value.getString("scope").isNotBlank()&&value.getString("measuredAt").isNotBlank());storageCount(value,"availableBytes")
 val rows=value.getJSONArray("rows");require(rows.length()>0)
 for(i in 0 until rows.length()){val row=rows.getJSONObject(i);require(row.getString("id").isNotBlank()&&row.getString("label").isNotBlank()&&row.opt("exists") is Boolean);storageCount(row,"fileCount");storageCount(row,"bytes")}
 value.optJSONObject("retainedCloud")?.let{require(it.getString("subsetOf")=="cloudTransfers");storageCount(it,"fileCount");storageCount(it,"bytes")}
 value.optJSONObject("lastCleanup")?.let{cleanupOutcome(it)}
}
private fun validateCleanupPlan(value:JSONObject){
 require(value.getString("planID").isNotBlank()&&value.getString("expiresAt").isNotBlank())
 listOf("documents","files","bytes","retainedDocuments","unknownEntries","deferredDocuments").forEach{storageCount(value,it)}
 val items=value.getJSONArray("items");require(items.length().toLong()==storageCount(value,"documents"))
 for(i in 0 until items.length()){val item=items.getJSONObject(i);require(item.getString("documentID").isNotBlank()&&item.getString("name").isNotBlank());storageCount(item,"bytes")}
}
internal fun cleanupOutcome(value:JSONObject):String {
 require(value.getString("byteMeasure")=="logical-file-length"){"清理回执大小类型未知，请重新统计实际容量"}
 val files=storageCount(value,"removedFiles");val bytes=storageBytes(storageCount(value,"removedBytes"));val retained=storageCount(value,"retainedFiles")
 val staged=if(value.has("retainedStagingFiles")&&!value.isNull("retainedStagingFiles"))storageCount(value,"retainedStagingFiles")else null
 return when(value.getString("status")){
  "completed"->{require(retained==0L&&(staged==null||staged==0L)){"清理回执仍有保留材料，未显示全部完成"};"已清理 $files 个临时文件，逻辑大小 $bytes。实际可用空间以重新统计为准。"}
  "partial"->"部分完成：已清理 $files 个临时文件（逻辑大小 $bytes），保留 $retained 个；"+(staged?.let{"暂存中仍有 $it 个。"}?:"暂存余项数量尚未确认。")+"请重新统计容量。"
  else->throw IllegalArgumentException("清理状态未确认，请重新统计容量")
 }
}
