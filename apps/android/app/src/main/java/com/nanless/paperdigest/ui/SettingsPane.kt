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
import androidx.compose.ui.Alignment
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
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
 var pane by rememberSaveable{mutableStateOf("开始")};var secret by remember{mutableStateOf<SecretKind?>(null)}
 var handledRequest by rememberSaveable{mutableIntStateOf(-1)}
 LaunchedEffect(requestID,requestedPane){if(handledRequest!=requestID&&requestedPane in listOf("开始","阅读","模型","资料","坚果云","Zotero","关于")){pane=requestedPane!!;handledRequest=requestID}}
 val categories=listOf("开始","阅读","模型","资料","坚果云","Zotero","关于")
 var categoryMenu by remember{mutableStateOf(false)}
 BoxWithConstraints(Modifier.fillMaxSize()){
 val wide=maxWidth>=840.dp
 Row(Modifier.fillMaxSize()){
 if(wide)Column(Modifier.width(208.dp).fillMaxHeight().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
  Text("设置",style=MaterialTheme.typography.headlineSmall,modifier=Modifier.padding(vertical=16.dp))
  categories.forEach{category->
   NavigationDrawerItem(label={Text(settingsCategoryLabel(category))},selected=pane==category,onClick={pane=category},icon={SettingsCategoryIcon(category)})
  }
 }
 Column(Modifier.weight(1f).fillMaxHeight()){
 if(!wide)Row(Modifier.fillMaxWidth().padding(horizontal=20.dp,vertical=12.dp),verticalAlignment=Alignment.CenterVertically){
  Text("设置",style=MaterialTheme.typography.headlineSmall,modifier=Modifier.weight(1f))
  Box{
   FilledTonalButton({categoryMenu=true},modifier=Modifier.semantics{contentDescription="选择设置分组：$pane"}){SettingsCategoryIcon(pane);Spacer(Modifier.width(8.dp));Text(settingsCategoryLabel(pane));Icon(Icons.Outlined.ArrowDropDown,null)}
   DropdownMenu(categoryMenu,{categoryMenu=false}){
    categories.forEach{category->DropdownMenuItem(text={Text(settingsCategoryLabel(category))},leadingIcon={SettingsCategoryIcon(category)},onClick={pane=category;categoryMenu=false})}
   }
  }
 }
 savedPanes.SaveableStateProvider(pane){
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal=16.dp,vertical=12.dp),horizontalAlignment=Alignment.CenterHorizontally){
 PaperPanel(Modifier.widthIn(max=760.dp)){
 when(pane){
 "开始"->ConnectionSetupOverview(state,{pane=it})
 "阅读"->{Text("按你的节奏阅读",style=MaterialTheme.typography.titleLarge);FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(4.dp)){listOf("system" to "跟随系统","light" to "浅色","dark" to "深色").forEach{(v,l)->FilterChip(state.settings.optString("appearance","system")==v,{action("settings.save",obj("changes" to obj("appearance" to v)))},label={Text(l)})}};Text("正文大小 · ${(state.settings.optInt("font",18) / 18f * 100).toInt()}%",style=MaterialTheme.typography.titleSmall);Text("默认使用紧凑排版，同时跟随系统字体大小；阅读页菜单也可直接缩小或放大。",style=MaterialTheme.typography.bodySmall);Slider(state.settings.optInt("font",18).coerceIn(14,30).toFloat(),{action("settings.save",obj("changes" to obj("font" to it.toInt())))},valueRange=14f..30f,steps=15);Row{Text("离线模式",Modifier.weight(1f));Switch(state.settings.optBoolean("offlineMode"),{action("settings.save",obj("changes" to obj("offlineMode" to it)))})};Text("离线模式读取已保存的导读与 PDF；未保存的资料会明确提示。");Row{Text("减少界面动画",Modifier.weight(1f));Switch(state.settings.optBoolean("reduceMotion"),{action("settings.save",obj("changes" to obj("reduceMotion" to it)))},modifier=Modifier.semantics{contentDescription="减少界面动画"})}
 var syncHours by rememberSaveable{mutableStateOf(state.settings.optInt("syncHours",12).toString())};var syncDirty by rememberSaveable{mutableStateOf(false)};var syncSaving by remember{mutableStateOf(false)};var syncError by remember{mutableStateOf<String?>(null)};val syncScope=rememberCoroutineScope()
 LaunchedEffect(state.settings.optInt("syncHours",12)){if(!syncDirty)syncHours=state.settings.optInt("syncHours",12).toString()}
 OutlinedTextField(syncHours,{syncHours=it.filter(Char::isDigit);syncDirty=true},label={Text("后台目录同步间隔（1–168 小时）")},singleLine=true)
 Button({val submitted=syncHours;syncSaving=true;syncScope.launch{try{controller.execute("settings.save",obj("changes" to obj("syncHours" to submitted.toInt())));if(syncHours==submitted)syncDirty=false;syncError=null}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;syncError=e.message}finally{syncSaving=false}}},enabled=syncDirty&&!syncSaving&&(syncHours.toIntOrNull()?:0)in 1..168){Text("保存后台同步间隔")};syncError?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 Text("首次打开会自动同步网站目录；之后回到应用时按间隔检查更新，并预加载近期内容。Android 后台同步可能因电量与网络延后；离线模式不会联网。同步只读取已发布内容，不调用模型。",style=MaterialTheme.typography.bodySmall)}
 "模型"->ModelSettings(state,controller,{secret=SecretKind.MODEL})
 "资料"->{Text("完整研究资料",style=MaterialTheme.typography.titleLarge);Text("备份包含已保存论文、导读、PDF、笔记、标注、研究输入与原始用量；密钥留在本机。恢复前会校验原件并保留恢复前副本。")
 Button({action("export.prepare",obj("format" to "backup"))}){Text("保存完整备份…")};OutlinedButton(restore){Text("从完整备份恢复…")};OutlinedButton({action("export.prepare",obj("format" to "diagnostics"))}){Text("导出不含凭据与正文的诊断…")}
 StorageCapacityControls(state,controller)
 Text("保留的云端传输快照",style=MaterialTheme.typography.titleMedium);var packages by remember{mutableStateOf<List<JSONObject>>(emptyList())};var retained by remember{mutableStateOf<List<JSONObject>>(emptyList())};val scope=rememberCoroutineScope();var message by remember{mutableStateOf<String?>(null)}
 Text("完整离线研究包",style=MaterialTheme.typography.titleMedium);Text("打开封存时的真实版本；旧快照不表示已核对当前网站。");TextButton({scope.launch{try{packages=controller.execute("storage.list").rows("packages")}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;message=e.message}}}){Text("读取已保存的离线包")};packages.forEach{p->OutlinedButton({action("storage.openPackage",obj("id" to p.optString("id")))}){Text(p.optString("title",p.optString("paperID")))}}
 TextButton({scope.launch{try{retained=controller.execute("retained.list").rows("transfers")}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;message=e.message}}}){Text("查看保留快照")};message?.let{Text(it)};retained.forEach{r->OutlinedButton({action("retained.export.prepare",obj("transferID" to r.optString("id")))}){Text("导出 ${r.optString("createdAt",r.optString("id"))}")}}}
 "坚果云"->CloudSettings(state,controller,action,{secret=SecretKind.CLOUD})
 "Zotero"->ZoteroSettings(state,controller,action,{secret=SecretKind.ZOTERO},{secret=SecretKind.ZOTERO_DAV})
 "关于"->AboutContent({showLicenses=true})
 }}
 }
 }
 }
 }
 }
 secret?.let{kind->SecretDialog(kind,controller,{secret=null})}
 if(showLicenses)OfflineLicensesDialog{showLicenses=false}
}

@Composable internal fun SecretDialog(kind:SecretKind,controller:AppController,close:()->Unit){
 var text by remember{mutableStateOf("")}
 var busy by remember{mutableStateOf(false)}
 var saved by remember{mutableStateOf(false)}
 var error by remember{mutableStateOf<String?>(null)}
 val scope=rememberCoroutineScope()
 val verifies=kind in setOf(SecretKind.CLOUD,SecretKind.ZOTERO,SecretKind.ZOTERO_DAV)
 suspend fun verifySaved(){
  try {
   controller.execute(if(kind==SecretKind.CLOUD)"cloud.check"else"zotero.check",JSONObject())
   close()
  }catch(cancelled:kotlinx.coroutines.CancellationException){throw cancelled}
  catch(failure:Exception){error="凭据已安全保存，连接检查未通过："+(failure.message?:"请核对网络与目标权限。")}
 }
 fun retry(){busy=true;error=null;scope.launch{try{verifySaved()}finally{busy=false}}}
 fun save(value:String?){
  busy=true;error=null
  scope.launch{
   try {
    controller.updateSecret(kind,value);text=""
    if(value!=null&&verifies){saved=true;verifySaved()}else close()
   }catch(cancelled:kotlinx.coroutines.CancellationException){throw cancelled}
   catch(failure:Exception){error="凭据尚未确认保存："+(failure.message?:"请重试。")}
   finally{busy=false}
  }
 }
 AlertDialog(onDismissRequest={if(!busy){text="";close()}},
 title={Text(when(kind){SecretKind.MODEL->"模型 API 密钥";SecretKind.CLOUD->"坚果云第三方应用密码";SecretKind.ZOTERO->"Zotero 专用 API key";SecretKind.ZOTERO_DAV->"Zotero WebDAV 独立应用密码"})},
 text={Column(verticalArrangement=Arrangement.spacedBy(12.dp)){
  Text("仅在本机加密保存，不进入设置、任务记录或研究备份。")
  if(saved){Text("凭据已安全保存，无需重新输入。可只重试连接检查，或关闭后稍后再检查。")
   TextButton({saved=false;error=null},enabled=!busy){Text("更换刚才保存的凭据")}
  }else CredentialPasswordField(text,{text=it},enabled=!busy)
  error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
  TextButton({save(null)},enabled=!busy){Text("删除本机保存的密钥")}
 }},
 confirmButton={TextButton({if(saved)retry()else save(text)},enabled=!busy&&(saved||text.isNotBlank())){
  Text(if(saved)"仅重试连接检查"else if(verifies)"保存并检查连接"else"安全保存")
 }},dismissButton={TextButton({text="";close()},enabled=!busy){Text(if(saved)"关闭"else"取消")}})
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
 val listGate=remember{CloudListRequestGate()};val actualContext by rememberUpdatedState(cloud.optString("selectionContext"));var listedTicket by remember{mutableStateOf<CloudListRequestGate.Ticket?>(null)};var listing by remember{mutableStateOf(false)}
 fun retireList(){listGate.invalidate();versions=emptyList();listedTicket=null;listing=false;error=null}
 LaunchedEffect(actualContext){retireList()}
 DisposableEffect(listGate){onDispose{listGate.invalidate()}}
 var saving by remember{mutableStateOf(false)};val busy=cloud.optBoolean("busy")||saving||state.busy;val pending=cloud.optJSONObject("pending");val scope=rememberCoroutineScope()
 val transferID=cloud.optString("activeJobID")
 val configured=cloud.optString("account").isNotBlank()&&cloud.optString("credentialState") !in setOf("missing","unavailable")
 val targetChanged=account.trim()!=cloud.optString("account")||folder!=cloud.optString("folder","PaperDigest")
 Text("WebDAV 备份（坚果云）",style=MaterialTheme.typography.titleLarge)
 Text("把工作台的论文、笔记和研究记录备份到坚果云。服务器地址已内置，只需账号和第三方应用密码。")
 val browser=androidx.compose.ui.platform.LocalUriHandler.current
 TextButton({browser.openUri("https://www.jianguoyun.com/#/settings/security")}){Text("1. 打开坚果云，创建第三方应用密码 ↗")}
 Text("在坚果云网页的账户信息 → 安全选项 → 第三方应用管理中添加应用，复制生成的应用密码。请勿填写登录密码。",style=MaterialTheme.typography.bodySmall)
 Text("2. 填写账号，再安全保存应用密码",style=MaterialTheme.typography.titleMedium)
 Text("保存全部研究空间。独立目录与 Zotero 附件同步分开；资料上限 512 MiB，编码快照上限 750 MiB。自动任务由 Android 调度，可能延后；强制停止应用后不会继续。")
 OutlinedTextField(account,{account=it;dirty=true;retireList()},Modifier.fillMaxWidth(),label={Text("坚果云账号")},enabled=!busy,singleLine=true);OutlinedTextField(folder,{folder=it;dirty=true;retireList()},Modifier.fillMaxWidth(),label={Text("备份目录")},supportingText={Text("例如 PaperDigest；不能使用 Zotero 的附件目录。")},enabled=!busy,singleLine=true)
 Row{Text("自动完整备份",Modifier.weight(1f));Switch(automatic,{automatic=it;dirty=true;retireList()},enabled=!busy)};OutlinedTextField(interval,{interval=it.filter(Char::isDigit);dirty=true;retireList()},label={Text("备份间隔（6–168 小时）")},enabled=!busy)
 Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){Button({retireList();val submitted=obj("account" to account,"folder" to folder,"automatic" to automatic,"intervalHours" to interval.toIntOrNull());saving=true;scope.launch{try{controller.execute("cloud.save",submitted);if(account==submitted.optString("account")&&folder==submitted.optString("folder")&&automatic==submitted.optBoolean("automatic")&&interval==submitted.optString("intervalHours"))dirty=false;error=null;if(targetChanged)password()}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;error=e.message}finally{saving=false}}},enabled=dirty&&!busy&&account.isNotBlank()&&CloudArchive.validFolder(folder)&&(interval.toIntOrNull()?:0)in 6..168){Text(if(targetChanged)"保存账号并填写应用密码…" else "保存备份设置")};TextButton({retireList();account=cloud.optString("account");folder=cloud.optString("folder","PaperDigest");automatic=cloud.optBoolean("automatic");interval=cloud.optInt("intervalHours",24).toString();dirty=false},enabled=dirty&&!busy){Text("撤销未保存更改")}}
 OutlinedButton(password,enabled=!dirty&&!busy&&cloud.optString("account").isNotBlank()){Text("填写或更换应用密码并检查…")}
 Text("3. 双向同步或保存完整备份",style=MaterialTheme.typography.titleMedium)
 Button({action("cloud.syncWorkspace",JSONObject())},enabled=!dirty&&!busy&&!state.settings.optBoolean("offlineMode")&&cloud.optString("account").isNotBlank()){
     Text("一键同步 WebDAV")
 }
 Text("双向同步收藏、待读、笔记、批注、阅读进度及原始研究资料。相互冲突的原件可从资料设置的保留快照导出。",style=MaterialTheme.typography.bodySmall)
 OutlinedButton({action("cloud.check",JSONObject())},enabled=!dirty&&!busy&&cloud.optString("account").isNotBlank()){Text("重新检查连接与权限")}
 Text(if(cloud.optString("account").isBlank())"尚未配置账号"else when(cloud.optString("credentialState")){"present"->"应用密码已保存；以最近一次连接检查结果为准";"missing"->"尚未保存应用密码";else->"账号已保存，连接待检查"},style=MaterialTheme.typography.bodySmall)
 if(pending!=null)Text(if(pending.optBoolean("damaged"))"未完成材料损坏或缺少检查点。可原样保留，但不能保证完整恢复。" else "有未完成的同一快照：${pending.optLong("fileCount")} 文件 / ${pending.optLong("encodedBytes")} 字节。继续不会创建新版本。")
 Button({action("cloud.upload",JSONObject())},enabled=configured&&transferID.isEmpty()&&!dirty&&!busy&&pending?.optBoolean("damaged")!=true){Text(if(pending==null)"保存完整快照" else "继续保存同一快照")}
 if(transferID.isNotEmpty()){
  Text(if(cloud.optString("transferStatus")=="queued")"备份等待系统调度或网络可用。" else "正在保存完整快照。")
  OutlinedButton({action("jobs.cancel",obj("id" to transferID))}){Text("取消备份（保留续传）")}
 }
 if(pending!=null)TextButton({confirm=true},enabled=!busy&&!dirty){Text("保留快照并停止本次续传…")}
 cloud.optJSONObject("lastBackup")?.let{Text("最近完整保存：${it.optString("createdAt")} · ${it.optLong("encodedBytes")} 字节",style=MaterialTheme.typography.bodySmall)};if(cloud.optBoolean("automaticPaused"))Text("自动备份已暂停：请检查上述原因后显式重新启用。",color=MaterialTheme.colorScheme.error)
 HorizontalDivider();Text("已保存版本",style=MaterialTheme.typography.titleMedium);Text("版本按 UTC 月份归档，时间显示为本机时区。列表不会自动联网；目标或月份变化后请重新读取。")
 OutlinedTextField(month,{month=it;retireList()},label={Text("UTC 月份 YYYY-MM")},singleLine=true,enabled=!busy)
 Button({val ticket=listGate.begin(actualContext,month);versions=emptyList();listedTicket=null;listing=true;error=null;scope.launch{try{
  val reply=controller.execute("cloud.list",obj("month" to ticket.month))
  if(listGate.accepts(ticket,actualContext,month)&&!dirty&&reply.optString("selectionContext")==ticket.context&&reply.optString("month")==ticket.month){versions=reply.rows("snapshots");listedTicket=ticket;error=null}
 }catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;if(listGate.accepts(ticket,actualContext,month))error=e.message}finally{if(listGate.accepts(ticket,actualContext,month))listing=false}}},enabled=!dirty&&!busy&&!listing&&actualContext.isNotEmpty()&&month.matches(Regex("\\d{4}-\\d{2}"))){Text(if(listing)"正在读取…" else "读取此月版本")};error?.let{Text(it)}
 versions.forEach{v->key(v.optString("selectionID")){var details by remember{mutableStateOf(false)};val ticket=listedTicket
  OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(14.dp)){
   Text(cloudLocalTime(v.optString("createdAt")));Text(cloudReadableBytes(v.optLong("encodedBytes")),style=MaterialTheme.typography.bodySmall)
   TextButton({details=!details}){Text(if(details)"收起校验信息" else "查看校验信息")}
   if(details){Text("快照 SHA-256：${v.optString("sha256")}",style=MaterialTheme.typography.labelSmall);Text("清单 SHA-256：${v.optString("manifestSHA256")}",style=MaterialTheme.typography.labelSmall);Text("${v.optInt("chunkCount")} 个分块 · 清单 ${v.optInt("manifestBytes")} 字节",style=MaterialTheme.typography.bodySmall)}
   TextButton({if(ticket!=null&&listGate.accepts(ticket,actualContext,month)&&!dirty)action("cloud.restore.prepare",obj("selectionID" to v.getString("selectionID")))},enabled=!busy&&!dirty&&ticket!=null&&listGate.accepts(ticket,actualContext,month)){Text("校验并准备恢复…")}
  }}
 }}
 if(confirm)AlertDialog(onDismissRequest={confirm=false},title={Text("原样保留并结束本次续传？")},text={Text("本机原快照和检查点移入保留区，云端半成品不自动删除。完整有效的快照可以导出后从文件恢复；损坏材料需要人工核对。")},confirmButton={TextButton({action("cloud.archivePending",JSONObject());confirm=false}){Text("保留并停止")}},dismissButton={TextButton({confirm=false}){Text("取消")}})
}

private fun cloudLocalTime(value:String):String=runCatching{java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM).withZone(java.time.ZoneId.systemDefault()).format(java.time.Instant.parse(value))}.getOrDefault(value)
private fun cloudReadableBytes(bytes:Long):String {
 val units=listOf("字节","KiB","MiB","GiB");var value=bytes.toDouble();var unit=0
 while(value>=1024&&unit<units.lastIndex){value/=1024;unit++}
 return if(unit==0)"$bytes 字节" else String.format(java.util.Locale.getDefault(),"%.1f %s",value,units[unit])
}

internal fun settingsCategoryLabel(category:String)=when(category){"开始"->"连接与开始";"坚果云"->"WebDAV 备份";"Zotero"->"Zotero 归档";else->category}

@Composable internal fun ConnectionSetupOverview(state:UiState,open:(String)->Unit){
 Text("连接你的研究资料",style=MaterialTheme.typography.titleLarge)
 Text("阅读网站文章可以直接开始。建议连接以下服务，保存研究资料并把论文归档到自己的文库；两项可以独立使用。")
 OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
  Text("WebDAV 备份（坚果云）",style=MaterialTheme.typography.titleMedium)
  Text("备份整个工作台：论文、笔记、研究输入与回答。填写坚果云账号和应用密码即可，默认目录已准备好。")
  Text(if(state.cloud.optString("account").isBlank())"尚未配置"else"账号已保存 · 可前往检查连接",style=MaterialTheme.typography.labelMedium)
  Button({open("坚果云")}){Text("配置 WebDAV 备份")}
 }}
 OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
  Text("Zotero 归档",style=MaterialTheme.typography.titleMedium)
  Text("把选定论文、PDF、导读和笔记放入 Zotero。使用专用 API key 和个人文库 ID，默认使用 Zotero Storage。")
  Text(if(state.zotero.optString("libraryID").isBlank())"尚未配置"else if(state.zotero.optString("credentialState")=="confirmed")"连接已核验"else"目标已保存 · 连接待核验",style=MaterialTheme.typography.labelMedium)
  Button({open("Zotero")}){Text("配置 Zotero 归档")}
 }}
 Text("Zotero 附件 WebDAV 是可选的附件同步方式；与工作台完整备份分别设置。",style=MaterialTheme.typography.bodySmall)
}
