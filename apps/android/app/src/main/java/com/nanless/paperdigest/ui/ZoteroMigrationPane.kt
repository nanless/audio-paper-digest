package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

/** A visible confirmation selects a native owner-held consent; no password or permission enters UI JSON. */
@Composable internal fun ZoteroMigrationEntry(journal:JSONObject,state:UiState,controller:AppController,action:Action,enabled:Boolean){
 val eligible=journal.optString("attachmentBackend","storage")=="storage"&&journal.optString("libraryType")=="users"&&journal.optString("status")!="completed"
 if(!eligible)return
 var show by rememberSaveable(journal.optString("id")){mutableStateOf(false)}
 if(journal.optString("error").contains("配额"))Text("Zotero 附件空间已满",style=MaterialTheme.typography.titleSmall,color=MaterialTheme.colorScheme.tertiary)
 if(state.cloud.optString("account").isBlank())TextButton({action("ui.settings",obj("pane" to "坚果云"))},enabled=enabled){Text("先连接坚果云，再继续这次存档")}
 else OutlinedButton({show=true},enabled=enabled){Text(if(state.zotero.rows("journals").any{it.optString("migrationParentID")==journal.optString("id")})"重新确认坚果云并继续迁移记录"else"改用已连接的坚果云继续存档")}
 if(show)ZoteroMigrationDialog(journal.getString("id"),state,controller){show=false}
}

@Composable private fun ZoteroMigrationDialog(parentID:String,state:UiState,controller:AppController,closed:()->Unit){
 var root by rememberSaveable(parentID){mutableStateOf("https://dav.jianguoyun.com/dav/zotero/")}
 var previewJSON by rememberSaveable(parentID){mutableStateOf<String?>(null)}
 val preview=previewJSON?.let{JSONObject(it)}
 var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var completed by remember{mutableStateOf(false)};var details by rememberSaveable{mutableStateOf(false)}
 val scope=rememberCoroutineScope();val context=LocalContext.current
 val keyboardVisible=WindowInsets.ime.getBottom(LocalDensity.current)>0
 val active=state.jobs.firstOrNull{it.optString("kind") in setOf("zotero.migration.preview","zotero.migration.confirm")&&it.optString("status")=="running"}
 fun close(){if(!busy)scope.launch{try{preview?.optString("previewID")?.takeIf{it.isNotBlank()}?.let{controller.execute("zotero.migration.discard",obj("previewID" to it))}}finally{closed()}}}
 fun retire(){val old=preview;previewJSON=null;details=false;old?.optString("previewID")?.takeIf{it.isNotBlank()}?.let{id->scope.launch{runCatching{controller.execute("zotero.migration.discard",obj("previewID" to id))}}}}
 fun baseURL():String{
  val uri=java.net.URI(root.trim());require(uri.scheme=="https"&&uri.host=="dav.jianguoyun.com"&&uri.port in setOf(-1,443)&&uri.rawUserInfo==null&&uri.rawQuery==null&&uri.rawFragment==null&&uri.rawPath.endsWith("/zotero/")){"请填写 Zotero 客户端正在使用的 HTTPS 附件目录，并保留末尾 /zotero/"}
  return root.trim().removeSuffix("zotero/")
 }
 AlertDialog(onDismissRequest={close()},
  modifier=Modifier.windowInsetsPadding(WindowInsets.safeDrawing.union(WindowInsets.ime)).padding(horizontal=12.dp,vertical=8.dp),
  properties=DialogProperties(usePlatformDefaultWidth=false,decorFitsSystemWindows=false),
  title={Text(if(completed)"本次存档已逐项核验" else "用坚果云继续这次存档",style=if(keyboardVisible)MaterialTheme.typography.titleMedium else MaterialTheme.typography.headlineSmall)},text={Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)){
  Text("保留 Zotero 已有书目和已上传附件。接下来会把同一份材料写入坚果云附件目录，并逐项读取核对；原来的空间不足记录仍保留。")
  Text("使用本 App 已连接的坚果云账号：${state.cloud.optString("account")}",style=MaterialTheme.typography.titleSmall)
  Text("本次只授权这份迁移记录使用该连接；不会让其他新存档自动共用。应用重启、更换账号、修改密码、恢复资料或主动撤销后，需要重新确认。密码不会复制到 Zotero 设置或研究备份。",style=MaterialTheme.typography.bodySmall)
  OutlinedTextField(root,{root=it;retire();error=null},Modifier.fillMaxWidth(),label={Text("Zotero 客户端的附件目录")},enabled=!busy&&!completed,singleLine=false)
  Text("请与 Zotero 客户端的 WebDAV 设置核对。坚果云研究资料备份目录仍单独保留。",style=MaterialTheme.typography.bodySmall)
  preview?.let{p->
   Text("确认目录：${p.optString("targetRoot")}",style=MaterialTheme.typography.bodyMedium)
   Text("已有书目保留；下面的文件仍需写入并回读坚果云，先前上传到 Zotero 的结果不会当作坚果云已完成。")
   p.rows("roles").forEach{r->
    val label=when(r.optString("role")){"source-metadata"->"来源信息";"pdf"->"PDF 原件";"guide"->"图文导读";"analysis"->"研究记录与用量";"note"->"笔记与标注";"guide-preview-pdf"->"导读预览 PDF";else->"其他原材料"}
    Text("$label · ${android.text.format.Formatter.formatShortFileSize(context,r.optLong("bytes"))}${if(r.optString("role")=="note")" · 保留在 Zotero"else" · 写入坚果云并核对"}")
   }
   TextButton({details=!details}){Text(if(details)"收起来源与校验信息"else"查看来源与校验信息")}
   if(details){Text("原存档：$parentID",style=MaterialTheme.typography.labelSmall);p.rows("roles").forEach{r->Text("${r.optString("role")} · ${r.optLong("bytes")} 字节\nSHA-256：${r.optString("sha256")}",style=MaterialTheme.typography.labelSmall)}}
  }
  error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
  if(busy){LinearProgressIndicator(Modifier.fillMaxWidth());Text("正在核对或继续原材料；请等当前操作停止。")
   active?.optString("id")?.takeIf{it.isNotBlank()}?.let{id->TextButton({scope.launch{controller.execute("jobs.cancel",obj("id" to id))}}){Text("取消并保留断点")}}
  }
  if(completed)Text("所有所选材料已按真实存档结果核验。Zotero 客户端是否已下载打开，仍需在客户端另行检查。")
 }},confirmButton={
  if(!completed)TextButton({
   busy=true;error=null
   scope.launch{try{
    if(preview==null){val result=controller.execute("zotero.migration.preview",obj("journalID" to parentID,"davBaseURL" to baseURL()));require(result.optString("previewID").isNotBlank()&&result.rows("roles").isNotEmpty()){ "材料预览尚未完整返回，请保留原记录核对" };previewJSON=result.toString()}
    else{val result=controller.execute("zotero.migration.confirm",obj("previewID" to preview.getString("previewID")));require(result.optString("status")=="completed"){"本次存档尚未完成，已有材料与断点保留"};completed=true}
   }catch(e:CancellationException){error="已取消；已有材料与断点保留"}catch(e:Exception){error=e.message?:"本次未完成，原存档与断点保留"}finally{busy=false}}
  },enabled=!busy&&!state.busy){Text(if(preview==null)"核对原材料与目标"else"确认并继续存档")}
 },dismissButton={TextButton({close()},enabled=!busy){Text(if(completed)"关闭"else"暂不继续")}})
}
