package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject
import com.nanless.paperdigest.cloud.CloudArchive
import java.time.YearMonth
import java.time.ZoneOffset

@Composable internal fun SettingsPane(state:UiState,controller:AppController,action:Action,restore:()->Unit,requestedPane:String?=null,requestID:Int=0){
 val savedPanes=rememberSaveableStateHolder()
 var showLicenses by rememberSaveable{mutableStateOf(false)}
 var pane by rememberSaveable{mutableStateOf("阅读")};var secret by remember{mutableStateOf<SecretKind?>(null)}
 var handledRequest by rememberSaveable{mutableIntStateOf(-1)}
 LaunchedEffect(requestID,requestedPane){if(handledRequest!=requestID&&requestedPane in listOf("阅读","模型","资料","坚果云","Zotero","关于")){pane=requestedPane!!;handledRequest=requestID}}
 Column(Modifier.fillMaxSize()){
 SectionTitle("设置","连接、研究资料与阅读偏好")
 ScrollableTabRow(listOf("阅读","模型","资料","坚果云","Zotero","关于").indexOf(pane)){listOf("阅读","模型","资料","坚果云","Zotero","关于").forEach{Tab(pane==it,{pane=it},text={Text(it)})}}
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),verticalArrangement=Arrangement.spacedBy(16.dp)){
 savedPanes.SaveableStateProvider(pane){when(pane){
 "阅读"->{Text("按你的节奏阅读",style=MaterialTheme.typography.titleLarge);listOf("system" to "跟随系统","light" to "浅色","dark" to "深色").forEach{(v,l)->FilterChip(state.settings.optString("appearance","system")==v,{action("settings.save",obj("changes" to obj("appearance" to v)))},label={Text(l)})};Text("正文字号");Slider(state.settings.optInt("font",18).coerceIn(14,30).toFloat(),{action("settings.save",obj("changes" to obj("font" to it.toInt())))},valueRange=14f..30f,steps=15);Row{Text("离线模式",Modifier.weight(1f));Switch(state.settings.optBoolean("offlineMode"),{action("settings.save",obj("changes" to obj("offlineMode" to it)))})};Text("离线模式读取已保存的导读与 PDF；未保存的资料会明确提示。");Row{Text("减少界面动画",Modifier.weight(1f));Switch(state.settings.optBoolean("reduceMotion"),{action("settings.save",obj("changes" to obj("reduceMotion" to it)))},modifier=Modifier.semantics{contentDescription="减少界面动画"})}
 var syncHours by rememberSaveable{mutableStateOf(state.settings.optInt("syncHours",12).toString())};var syncDirty by rememberSaveable{mutableStateOf(false)};var syncSaving by remember{mutableStateOf(false)};var syncError by remember{mutableStateOf<String?>(null)};val syncScope=rememberCoroutineScope()
 LaunchedEffect(state.settings.optInt("syncHours",12)){if(!syncDirty)syncHours=state.settings.optInt("syncHours",12).toString()}
 OutlinedTextField(syncHours,{syncHours=it.filter(Char::isDigit);syncDirty=true},label={Text("已发布目录同步间隔（1–168 小时）")},singleLine=true)
 Button({val submitted=syncHours;syncSaving=true;syncScope.launch{try{controller.execute("settings.save",obj("changes" to obj("syncHours" to submitted.toInt())));if(syncHours==submitted)syncDirty=false;syncError=null}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;syncError=e.message}finally{syncSaving=false}}},enabled=syncDirty&&!syncSaving&&(syncHours.toIntOrNull()?:0)in 1..168){Text("保存目录同步间隔")};syncError?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 Text("Android 可因电量与网络延后执行；离线模式不会联网。目录同步读取已有发布结果，不调用模型。",style=MaterialTheme.typography.bodySmall)}
 "模型"->{var freshCheckRevision by remember{mutableLongStateOf(0)};var draft by rememberSaveable{mutableStateOf(state.settings.toString())};var changedKeys by rememberSaveable{mutableStateOf(listOf<String>())};var dirty by rememberSaveable{mutableStateOf(false)};LaunchedEffect(state.settings.toString()){if(!dirty)draft=state.settings.toString()};var saving by remember{mutableStateOf(false)};var saveError by remember{mutableStateOf<String?>(null)};val saveScope=rememberCoroutineScope();val settings=JSONObject(draft)
 Text("本机模型连接",style=MaterialTheme.typography.titleLarge);Text("只有你明确发送研究问题或检查连接时才会请求 API。密钥保存在 Android 安全存储，不随备份迁移。")
 listOf("endpoint" to "API 地址","model" to "模型名称","protocol" to "协议 chat / responses","httpProxy" to "HTTP CONNECT 代理（Muse 必填）","maxTokens" to "单次输出上限","dailyRequests" to "每日请求上限（UTC）","timeoutMs" to "超时（毫秒）","reasoningEffort" to "推理强度").forEach{(k,l)->OutlinedTextField(settings.optString(k),{v->draft=JSONObject(draft).put(k,v).toString();changedKeys=(changedKeys+k).distinct();dirty=true;freshCheckRevision++},Modifier.fillMaxWidth(),label={Text(l)},singleLine=true)}
 Row{Text("Responses 流式响应",Modifier.weight(1f));Switch(settings.optBoolean("responsesStream"),{draft=JSONObject(draft).put("responsesStream",it).toString();changedKeys=(changedKeys+"responsesStream").distinct();dirty=true;freshCheckRevision++})}
 Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){Button({val submitted=draft;val changes=JSONObject().apply{changedKeys.forEach{key->put(key,JSONObject(submitted).get(key))}};saving=true;saveScope.launch{try{controller.execute("settings.save",obj("changes" to changes));if(draft==submitted){dirty=false;changedKeys=emptyList()};saveError=null}catch(e:Exception){saveError=e.message}finally{saving=false}}},enabled=dirty&&!saving){Text("保存连接")};OutlinedButton({draft=state.settings.toString();dirty=false;changedKeys=emptyList();freshCheckRevision++},enabled=dirty&&!saving){Text("撤销更改")}}
 saveError?.let{Text(it,color=MaterialTheme.colorScheme.error)};OutlinedButton({secret=SecretKind.MODEL},enabled=!dirty&&!saving&&!state.busy){Text("为已保存连接设置模型密钥…")};FreshStudyAction(state,controller,connectionCheck=true,draftRevision=freshCheckRevision,enabled=!dirty&&!saving&&!state.busy,label="检查当前连接（计入用量）")}
 "资料"->{Text("完整研究资料",style=MaterialTheme.typography.titleLarge);Text("备份包含已保存论文、导读、PDF、笔记、标注、研究输入与原始用量；密钥留在本机。恢复前会校验原件并保留恢复前副本。")
 Button({action("export.prepare",obj("format" to "backup"))}){Text("保存完整备份…")};OutlinedButton(restore){Text("从完整备份恢复…")};OutlinedButton({action("export.prepare",obj("format" to "diagnostics"))}){Text("导出不含凭据与正文的诊断…")}
 StorageCapacityControls(state,controller)
 Text("保留的云端传输快照",style=MaterialTheme.typography.titleMedium);var packages by remember{mutableStateOf<List<JSONObject>>(emptyList())};var retained by remember{mutableStateOf<List<JSONObject>>(emptyList())};val scope=rememberCoroutineScope();var message by remember{mutableStateOf<String?>(null)}
 Text("完整离线研究包",style=MaterialTheme.typography.titleMedium);Text("打开封存时的真实版本；旧快照不表示已核对当前网站。");TextButton({scope.launch{try{packages=controller.execute("storage.list").rows("packages")}catch(e:Exception){message=e.message}}}){Text("读取已保存的离线包")};packages.forEach{p->OutlinedButton({action("storage.openPackage",obj("id" to p.optString("id")))}){Text(p.optString("title",p.optString("paperID")))}}
 TextButton({scope.launch{try{retained=controller.execute("retained.list").rows("transfers")}catch(e:Exception){message=e.message}}}){Text("查看保留快照")};message?.let{Text(it)};retained.forEach{r->OutlinedButton({action("retained.export.prepare",obj("transferID" to r.optString("id")))}){Text("导出 ${r.optString("createdAt",r.optString("id"))}")}}}
 "坚果云"->CloudSettings(state,controller,action,{secret=SecretKind.CLOUD})
 "Zotero"->ZoteroSettings(state,controller,action,{secret=SecretKind.ZOTERO})
 "关于"->AboutContent({showLicenses=true})
 }}
 }
 }
 secret?.let{kind->SecretDialog(kind,controller,{secret=null})}
 if(showLicenses)OfflineLicensesDialog{showLicenses=false}
}

@Composable private fun SecretDialog(kind:SecretKind,controller:AppController,close:()->Unit){
 var text by remember{mutableStateOf("")};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};val scope=rememberCoroutineScope()
 fun save(value:String?){busy=true;scope.launch{try{controller.updateSecret(kind,value);text="";close()}catch(e:Exception){error=e.message}finally{busy=false}}}
 AlertDialog(onDismissRequest={if(!busy){text="";close()}},title={Text(when(kind){SecretKind.MODEL->"模型 API 密钥";SecretKind.CLOUD->"坚果云第三方应用密码";SecretKind.ZOTERO->"Zotero 专用 API key"})},text={Column(verticalArrangement=Arrangement.spacedBy(12.dp)){Text("仅在本机加密保存，不进入设置、任务记录或研究备份。");CredentialPasswordField(text,{text=it});error?.let{Text(it,color=MaterialTheme.colorScheme.error)};TextButton({save(null)},enabled=!busy){Text("删除本机保存的密钥")}}},confirmButton={TextButton({save(text)},enabled=text.isNotBlank()&&!busy){Text("安全保存")}},dismissButton={TextButton(close,enabled=!busy){Text("取消")}})
}


/** The opt-out belongs only to this dialog host and is restored when the credential UI leaves composition. */
@Composable internal fun CredentialPasswordField(value:String,change:(String)->Unit,label:String="新的密钥",enabled:Boolean=true){
 val dialogView=LocalView.current
 DisposableEffect(dialogView){
  var root:android.view.View?=null;var original:Int?=null;var disposed=false
  fun applyDialogPolicy(){
   if(disposed||root!=null)return
   val decor=generateSequence(dialogView){it.parent as? android.view.View}.mapNotNull{(it as? DialogWindowProvider)?.window?.decorView}.firstOrNull()?:return
   root=decor;original=decor.importantForAutofill
   decor.importantForAutofill=android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
  }
  val attachment=object:android.view.View.OnAttachStateChangeListener{
   override fun onViewAttachedToWindow(view:android.view.View){applyDialogPolicy()}
   override fun onViewDetachedFromWindow(view:android.view.View){}
  }
  dialogView.addOnAttachStateChangeListener(attachment);applyDialogPolicy();dialogView.post{applyDialogPolicy()}
  onDispose{disposed=true;dialogView.removeOnAttachStateChangeListener(attachment);root?.let{view->original?.let{view.importantForAutofill=it}}}
 }
 CompositionLocalProvider(androidx.compose.runtime.saveable.LocalSaveableStateRegistry provides null) {
  OutlinedTextField(value,change,visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password,autoCorrectEnabled=false),singleLine=true,label={Text(label)},enabled=enabled)
 }
}

@Composable private fun CloudSettings(state:UiState,controller:AppController,action:Action,password:()->Unit){
 val cloud=state.cloud;var account by rememberSaveable{mutableStateOf(cloud.optString("account"))};var folder by rememberSaveable{mutableStateOf(cloud.optString("folder","PaperDigest"))};var automatic by rememberSaveable{mutableStateOf(cloud.optBoolean("automatic"))};var interval by rememberSaveable{mutableStateOf(cloud.optInt("intervalHours",24).toString())};var dirty by rememberSaveable{mutableStateOf(false)}
 LaunchedEffect(cloud.toString()){if(!dirty){account=cloud.optString("account");folder=cloud.optString("folder","PaperDigest");automatic=cloud.optBoolean("automatic");interval=cloud.optInt("intervalHours",24).toString()}}
 var month by rememberSaveable{mutableStateOf(YearMonth.now(ZoneOffset.UTC).toString())};var versions by remember{mutableStateOf<List<JSONObject>>(emptyList())};var confirm by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)}
 var saving by remember{mutableStateOf(false)};val busy=cloud.optBoolean("busy")||saving||state.busy;val pending=cloud.optJSONObject("pending");val scope=rememberCoroutineScope()
 Text("坚果云资料",style=MaterialTheme.typography.titleLarge);Text("保存全部研究空间。独立目录与 Zotero 附件同步分开；资料上限 512 MiB，编码快照上限 750 MiB。自动任务由 Android 调度，可能延后；强制停止应用后不会继续。")
 OutlinedTextField(account,{account=it;dirty=true},Modifier.fillMaxWidth(),label={Text("坚果云账号")},enabled=!busy,singleLine=true);OutlinedTextField(folder,{folder=it;dirty=true},Modifier.fillMaxWidth(),label={Text("独立目录（例如 PaperDigest，不可用 zotero）")},enabled=!busy,singleLine=true)
 Row{Text("自动完整备份",Modifier.weight(1f));Switch(automatic,{automatic=it;dirty=true},enabled=!busy)};OutlinedTextField(interval,{interval=it.filter(Char::isDigit);dirty=true},label={Text("备份间隔（6–168 小时）")},enabled=!busy)
 Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){Button({val submitted=obj("account" to account,"folder" to folder,"automatic" to automatic,"intervalHours" to interval.toIntOrNull());saving=true;scope.launch{try{controller.execute("cloud.save",submitted);if(account==submitted.optString("account")&&folder==submitted.optString("folder")&&automatic==submitted.optBoolean("automatic")&&interval==submitted.optString("intervalHours"))dirty=false;error=null}catch(e:Exception){error=e.message}finally{saving=false}}},enabled=dirty&&!busy&&CloudArchive.validFolder(folder)&&(interval.toIntOrNull()?:0)in 6..168){Text("保存设置")};TextButton({account=cloud.optString("account");folder=cloud.optString("folder","PaperDigest");automatic=cloud.optBoolean("automatic");interval=cloud.optInt("intervalHours",24).toString();dirty=false},enabled=dirty&&!busy){Text("撤销未保存更改")}}
 OutlinedButton(password,enabled=!dirty&&!busy){Text("设置第三方应用密码…")};OutlinedButton({action("cloud.check",JSONObject())},enabled=!dirty&&!busy){Text("检查连接与权限")}
 cloud.optString("lastError").takeIf{it.isNotBlank()}?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 if(pending!=null)Text(if(pending.optBoolean("damaged"))"未完成材料损坏或缺少检查点。可原样保留，但不能保证完整恢复。" else "有未完成的同一快照：${pending.optLong("fileCount")} 文件 / ${pending.optLong("encodedBytes")} 字节。继续不会创建新版本。")
 Button({action("cloud.upload",JSONObject())},enabled=!dirty&&!busy&&pending?.optBoolean("damaged")!=true){Text(if(pending==null)"保存完整快照" else "继续保存同一快照")}
 if(busy&&cloud.optString("activeJobID").isNotEmpty())OutlinedButton({action("jobs.cancel",obj("id" to cloud.optString("activeJobID")))}){Text("取消当前传输（保留续传）")}
 if(pending!=null)TextButton({confirm=true},enabled=!busy&&!dirty){Text("保留快照并停止本次续传…")}
 cloud.optJSONObject("lastBackup")?.let{Text("最近完整保存：${it.optString("createdAt")} · ${it.optLong("encodedBytes")} 字节",style=MaterialTheme.typography.bodySmall)};if(cloud.optBoolean("automaticPaused"))Text("自动备份已暂停：请检查上述原因后显式重新启用。",color=MaterialTheme.colorScheme.error)
 HorizontalDivider();Text("已保存版本",style=MaterialTheme.typography.titleMedium);Text("版本按 UTC 月份归档，时间按原记录显示。列表不会自动联网。")
 OutlinedTextField(month,{month=it},label={Text("UTC 月份 YYYY-MM")},singleLine=true)
 Button({scope.launch{try{versions=controller.execute("cloud.list",obj("month" to month)).rows("snapshots");error=null}catch(e:Exception){error=e.message}}},enabled=!dirty&&!busy&&month.matches(Regex("\\d{4}-\\d{2}"))){Text("读取此月版本")};error?.let{Text(it)}
 versions.forEach{v->OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(14.dp)){Text(v.optString("createdAt"));Text("${v.optLong("encodedBytes")} 字节",style=MaterialTheme.typography.bodySmall);Text(v.optString("sha256"),style=MaterialTheme.typography.labelSmall);TextButton({action("cloud.restore.prepare",obj("month" to v.optString("month",month),"id" to v.optString("id")))},enabled=!busy&&!dirty){Text("校验并准备恢复…")}}}}
 if(confirm)AlertDialog(onDismissRequest={confirm=false},title={Text("原样保留并结束本次续传？")},text={Text("本机原快照和检查点移入保留区，云端半成品不自动删除。完整有效的快照可以导出后从文件恢复；损坏材料需要人工核对。")},confirmButton={TextButton({action("cloud.archivePending",JSONObject());confirm=false}){Text("保留并停止")}},dismissButton={TextButton({confirm=false}){Text("取消")}})
}
