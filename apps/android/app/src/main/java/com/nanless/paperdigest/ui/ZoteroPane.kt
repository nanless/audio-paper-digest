package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import kotlinx.coroutines.launch

@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun ZoteroSettings(state:UiState,controller:AppController,action:Action,password:()->Unit,davPassword:()->Unit){
 val scope=rememberCoroutineScope();val z=state.zotero
 var libraryType by rememberSaveable{mutableStateOf(z.optString("libraryType","users"))}
 var libraryID by rememberSaveable{mutableStateOf(z.optString("libraryID"))}
 var attachmentBackend by rememberSaveable{mutableStateOf(z.optString("attachmentBackend","storage"))}
 var davBaseURL by rememberSaveable{mutableStateOf(z.optString("davBaseURL"))}
 var davUsername by rememberSaveable{mutableStateOf(z.optString("davUsername"))}
 var collection by rememberSaveable{mutableStateOf(z.optString("collection"))}
 var independentDraft by rememberSaveable{mutableStateOf(false)}
 var dirty by rememberSaveable{mutableStateOf(false)}
 var saving by remember{mutableStateOf(false)};var listing by remember{mutableStateOf(false)}
 var error by remember{mutableStateOf<String?>(null)}
 var collections by remember{mutableStateOf<List<JSONObject>>(emptyList())}
 var listedFor by remember{mutableStateOf<String?>(null)};var showCollections by remember{mutableStateOf(false)}
 val busy=saving||listing||z.optBoolean("busy")||state.busy
 LaunchedEffect(z.toString()){
  if(!dirty){independentDraft=false;val type=z.optString("libraryType","users");val id=z.optString("libraryID");if(type!=libraryType||id!=libraryID){collections=emptyList();listedFor=null};libraryType=type;libraryID=id;collection=z.optString("collection");attachmentBackend=z.optString("attachmentBackend","storage");davBaseURL=z.optString("davBaseURL");davUsername=z.optString("davUsername")}
 }
 Text("Zotero 完整存档",style=MaterialTheme.typography.titleLarge)
 Text("使用官方 Web API 保存书目和笔记，附件可选 Zotero Storage 或个人文库的 WebDAV。创建专用 API key，无需 Zotero 登录密码。完整研究空间备份在“坚果云”设置中独立配置。")
 FlowRow(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){listOf("storage" to "Zotero Storage","webdav" to "WebDAV 附件").forEach{(v,l)->FilterChip(attachmentBackend==v,{attachmentBackend=v;if(v=="webdav")libraryType="users";dirty=true;collections=emptyList();listedFor=null},enabled=!busy,label={Text(l)})}}
 if(attachmentBackend=="webdav"){
  Text("仅支持个人文库。填写 zotero 文件夹的上一级 HTTPS 地址；请先在服务端准备好 zotero 文件夹。账号和应用密码单独保存，绝不会自动复用研究空间备份密码。")
  OutlinedTextField(davBaseURL,{davBaseURL=it;dirty=true},Modifier.fillMaxWidth(),enabled=!busy,label={Text("WebDAV 上一级地址（不含末段 zotero）")},singleLine=true)
  OutlinedTextField(davUsername,{davUsername=it;dirty=true},Modifier.fillMaxWidth(),enabled=!busy,label={Text("WebDAV 独立账号")},singleLine=true)
 }
 FlowRow(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){listOf("users" to "个人文库","groups" to "群组文库").forEach{(v,l)->FilterChip(libraryType==v,{libraryType=v;dirty=true;collections=emptyList();listedFor=null},enabled=!busy&&(attachmentBackend!="webdav"||v=="users"),label={Text(l)})}}
 OutlinedTextField(libraryID,{libraryID=it.filter(Char::isDigit);dirty=true;collections=emptyList();listedFor=null},Modifier.fillMaxWidth(),enabled=!busy,label={Text("文库数字 ID（在 Zotero API key 页面可查看）")},singleLine=true)
 val selectedName=collections.firstOrNull{collectionKey(it)==collection}?.let{collectionPath(it,collections)}
 OutlinedTextField(if(collection.isEmpty())"不指定分类" else selectedName?:"已保存的分类（读取后显示名称）",{},Modifier.fillMaxWidth(),readOnly=true,label={Text("存档分类")})
 OutlinedButton({
  val type=libraryType;val id=libraryID;listing=true;error=null
  scope.launch{try{
   val result=controller.execute("zotero.collections")
   val actual=controller.state.value.zotero
   require(actual.optString("libraryType")==type&&actual.optString("libraryID")==id){"文库已经切换，未采用旧文库分类"}
   val rows=result.rows("collections");require(rows.all{com.nanless.paperdigest.zotero.ZoteroService.validKey(collectionKey(it))}){"Zotero 分类身份异常，未采用不完整列表"};collections=rows;listedFor="$type:$id";showCollections=true
  }catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;error=e.message}finally{listing=false}}
 },enabled=!dirty&&!busy&&libraryID.isNotEmpty()){Text(if(listing)"正在读取真实分类…" else "读取并选择分类…")}
 FlowRow(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
  Button({val submitted=obj("libraryType" to libraryType,"libraryID" to libraryID,"collection" to collection,"attachmentBackend" to attachmentBackend,"davBaseURL" to davBaseURL,"davUsername" to davUsername);saving=true;scope.launch{try{controller.execute("zotero.save",submitted);if(libraryType==submitted.optString("libraryType")&&libraryID==submitted.optString("libraryID")&&collection==submitted.optString("collection")&&attachmentBackend==submitted.optString("attachmentBackend")&&davBaseURL==submitted.optString("davBaseURL")&&davUsername==submitted.optString("davUsername"))dirty=false;error=null}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;error=e.message}finally{saving=false}}},enabled=dirty&&!busy){Text("保存目标文库")}
  TextButton({independentDraft=false;libraryType=z.optString("libraryType","users");libraryID=z.optString("libraryID");collection=z.optString("collection");attachmentBackend=z.optString("attachmentBackend","storage");davBaseURL=z.optString("davBaseURL");davUsername=z.optString("davUsername");dirty=false;error=null},enabled=dirty&&!busy){Text("撤销未保存更改")}
 }
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 OutlinedButton(password,enabled=!dirty&&!busy){Text("为已保存目标设置专用 API key…")}
 if(attachmentBackend=="webdav"){
  if(z.optString("davCredentialSource")=="saved-cloud"&&!independentDraft){
   Text("本次迁移记录使用已连接的坚果云；其他新存档仍需单独配置附件密码。",style=MaterialTheme.typography.bodySmall)
   Text(if(z.optString("borrowedCredentialState")=="granted")"本次授权有效"else"继续前，请在原存档记录重新确认坚果云连接。",style=MaterialTheme.typography.bodySmall)
   TextButton({action("zotero.migration.revoke",JSONObject())},enabled=!dirty){Text("撤销本次迁移记录的共享连接授权")}
   TextButton({independentDraft=true;dirty=true},enabled=!busy){Text("为其他存档配置独立附件连接")}
   Text("保存独立连接会结束本次共享授权；迁移记录继续前仍需重新确认坚果云。",style=MaterialTheme.typography.bodySmall)
  }else OutlinedButton(davPassword,enabled=!dirty&&!busy){Text("为已保存附件目标设置独立应用密码…")}
 }
 Button({action("zotero.check",JSONObject())},enabled=!dirty&&!busy){Text("核验身份、目标与权限")}
 Text("许可状态：${when(z.optString("credentialState")){"confirmed"->"已核验";"missing"->"尚未保存";else->"需要主动核验"}}")
 z.optJSONObject("permissions")?.let{Text("最近核验：${it.optString("verifiedAt")}",style=MaterialTheme.typography.labelSmall)}
 Text("独立存档记录",style=MaterialTheme.typography.titleLarge)
 z.rows("journals").forEach{j->
 val hasMigrationChild=z.rows("journals").any{it.optString("migrationParentID")==j.optString("id")}
 OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
  Text("附件后端：${if(j.optString("attachmentBackend","storage")=="webdav")"WebDAV" else "Zotero Storage"}")
  if(j.optString("migrationParentID").isNotBlank())Text("由原 Storage 存档继续；原记录和原材料仍单独保留。",style=MaterialTheme.typography.bodySmall)
  if(hasMigrationChild)Text("已另建 WebDAV 继续记录；此处仍保留原 Storage 的结果。",style=MaterialTheme.typography.bodySmall)
  Text(j.optString("paperID"));Text("${jobStatus(j.optString("status"))} · ${j.optString("createdAt")}")
  Text("原目标：${if(j.optString("libraryType")=="groups")"群组" else "个人文库"} ${j.optString("libraryID")} · ${if(j.optString("collection").isEmpty())"不指定分类" else "所选原分类"}",style=MaterialTheme.typography.labelSmall)
  j.ids("notices").forEach{Text(it,color=MaterialTheme.colorScheme.tertiary,style=MaterialTheme.typography.bodySmall)}
  j.optString("error").takeIf{it.isNotBlank()}?.let{Text(it,color=MaterialTheme.colorScheme.error)}
  OutlinedButton({action("zotero.resume",obj("journalID" to j.optString("id")))},enabled=!busy&&!dirty&&!hasMigrationChild){Text(if(j.optString("status")=="completed")"重新逐项回读" else "沿原断点继续")}
  ZoteroMigrationEntry(j,state,controller,action,enabled=!busy&&!dirty)
 }}}
 z.optJSONObject("macHistory")?.let{history->
  val oldRecords=history.rows("records")
  if(oldRecords.isNotEmpty()||history.optInt("unreadableCount")>0){
   Text("来自 Mac 的存档记录",style=MaterialTheme.typography.titleLarge)
   Text("这是备份保留的原 Mac 本地归档记录，只读展示。原来的核验结果不代表安卓刚刚回读了远端；如需核验或续传，请回到原 Mac。",style=MaterialTheme.typography.bodySmall)
   oldRecords.forEach{record->OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
    Text(record.optString("title"),style=MaterialTheme.typography.titleMedium)
    Text("Mac 本地归档 · 只读历史",color=MaterialTheme.colorScheme.tertiary,style=MaterialTheme.typography.labelMedium)
    Text(record.optString("identity"),style=MaterialTheme.typography.bodySmall)
    record.optString("originalCollectionKey").takeUnless{it=="null"||it.isBlank()}?.let{Text("原 Mac 分类 key：$it",style=MaterialTheme.typography.bodySmall)}
    val oldSteps=record.rows("steps");val checked=oldSteps.count{it.optBoolean("reportedVerified")}
    Text("原记录核验：$checked / ${oldSteps.size} 项；当前远端状态尚未核验。",style=MaterialTheme.typography.bodySmall)
    oldSteps.forEach{step->
     val label=when(step.optString("role")){"bibliography"->"书目";"source-metadata"->"来源元数据";"pdf"->"原文 PDF";"guide"->"图文导读";"analysis"->"研究解析";"note"->"私人笔记";else->"原材料"}
     Text("$label · ${step.optString("originalKey").takeUnless{it=="null"||it.isBlank()}?:"尚无条目 key"} · ${if(step.optBoolean("reportedVerified"))"原记录已核验" else "原记录未完成"}",style=MaterialTheme.typography.bodySmall)
    }
    if(record.optBoolean("summaryUnavailable"))Text("原汇总信息不匹配或不可读，未采用其时间或状态；原检查点已保留。",color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)
   }}}
   if(history.optInt("unreadableCount")>0)Text("${history.optInt("unreadableCount")} 份原 Mac 检查点暂不可读，原文件完整保留，未将它们显示为已完成。",color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)
  }
 }
 Text("引用、来源元数据、原文 PDF、图文导读、研究与笔记分别封存。全部所选材料实际回读相符才完成；失败或取消保留原条目 key。",style=MaterialTheme.typography.bodySmall)
 if(showCollections)AlertDialog(onDismissRequest={showCollections=false},title={Text("选择实际存档分类")},text={Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(4.dp)){
  TextButton({collection="";dirty=true;showCollections=false}){Text("不指定分类")}
  if(collections.isEmpty())Text("此文库当前没有分类，可直接保存到文库。")
  collections.sortedBy{collectionPath(it,collections)}.forEach{row->TextButton({if(listedFor=="$libraryType:$libraryID"){collection=collectionKey(row);dirty=true};showCollections=false}){Text(collectionPath(row,collections))}}
 }},confirmButton={TextButton({showCollections=false}){Text("关闭")}})
}
internal fun collectionKey(row:JSONObject):String=row.optString("key",row.optJSONObject("data")?.optString("key").orEmpty())
internal fun collectionPath(row:JSONObject,all:List<JSONObject>):String {
 val names=mutableListOf<String>();val visited=mutableSetOf<String>();var current:JSONObject?=row
 while(current!=null&&names.size<30){val key=collectionKey(current);if(!visited.add(key)){names.add("父分类待核对");break};val data=current.optJSONObject("data")?:current;names.add(data.optString("name").ifBlank{"未命名分类"});val parent=data.optString("parentCollection");current=if(parent.isBlank()||parent=="false")null else all.firstOrNull{collectionKey(it)==parent}}
 return names.asReversed().joinToString(" / ")
}

@Composable internal fun ZoteroArchiveDialog(state:UiState,action:Action,close:()->Unit){
 var pdf by rememberSaveable{mutableStateOf(true)};var guide by rememberSaveable{mutableStateOf(true)};var analysis by rememberSaveable{mutableStateOf(true)};var note by rememberSaveable{mutableStateOf(true)}
 var optionRevision by rememberSaveable{mutableIntStateOf(0)}
 var requestedRevision by rememberSaveable{mutableStateOf<Int?>(null)}
 var preparationRequestID by rememberSaveable{mutableStateOf<String?>(null)}
 val prepared=state.zotero.optJSONObject("prepared")?.takeIf{it.optString("paperID")==state.selectedPaperId}
 fun prepare(){val request=java.util.UUID.randomUUID().toString();preparationRequestID=request;requestedRevision=optionRevision;action("zotero.prepare",obj("includePDF" to pdf,"includeGuide" to guide,"includeAnalysis" to analysis,"includeNote" to note,"preparationRequestID" to request,"readingMaterialID" to state.readingMaterialID))}
 val actualOptions=prepared?.optJSONObject("options")
 val optionsMatch=actualOptions!=null&&actualOptions.opt("includePDF")==pdf&&actualOptions.opt("includeGuide")==guide&&actualOptions.opt("includeAnalysis")==analysis&&actualOptions.opt("includeNote")==note
 val currentRequest=if(preparationRequestID==null)false else prepared?.opt("preparationRequestID")==preparationRequestID&&requestedRevision==optionRevision
 val sourceMatches=state.readingMaterialID.isNotBlank()&&prepared?.opt("readingMaterialID")==state.readingMaterialID
 val materialsCurrent=prepared?.opt("materialsCurrent")==true
 val canConfirm=prepared!=null&&optionsMatch&&currentRequest&&sourceMatches&&materialsCurrent
 var materialDetails by rememberSaveable(prepared?.optString("preparedID")){mutableStateOf(false)}
 val materialContext=androidx.compose.ui.platform.LocalContext.current
 AlertDialog(onDismissRequest=close,title={Text("存档到 Zotero")},text={Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(10.dp)){
 Text("引用书目与来源元数据始终保留。其余材料可明确选择；导读需要已完整离线保存科学图片。")
 listOf(Triple("PDF 原件",pdf,{v:Boolean->pdf=v;optionRevision++;Unit}),Triple("图文导读",guide,{v:Boolean->guide=v;optionRevision++;Unit}),Triple("研究、原始输入与用量",analysis,{v:Boolean->analysis=v;optionRevision++;Unit}),Triple("笔记与标注",note,{v:Boolean->note=v;optionRevision++;Unit})).forEach{(label,value,set)->Row{Text(label,Modifier.weight(1f));Checkbox(value,set)}}
 if(prepared!=null)TextButton({prepare()},enabled=state.readingMaterialID.isNotBlank()&&!state.busy&&!state.zotero.optBoolean("busy")){Text("按当前选项重新准备材料")}
 if(state.zotero.optString("libraryID").isEmpty())Text("请先在设置 → Zotero 配置并核验目标文库。",color=MaterialTheme.colorScheme.error)
 if(prepared!=null&&!canConfirm)Text("这份准备的材料已不适用于当前选项或阅读内容，请重新准备。",color=MaterialTheme.colorScheme.tertiary)
 prepared?.let{p->
  Text("准备完成：${p.rows("roles").size+1} 项材料",style=MaterialTheme.typography.titleSmall)
  p.ids("notices").forEach{notice->Text(notice,color=MaterialTheme.colorScheme.tertiary,style=MaterialTheme.typography.bodySmall)}
  Text("引用书目",style=MaterialTheme.typography.bodyMedium)
  p.rows("roles").forEach{r->
   val label=when(r.optString("role")){"source-metadata"->"来源信息";"pdf"->"PDF 原件";"guide"->"图文导读";"analysis"->"研究记录与用量";"note"->"笔记与标注";"guide-preview-pdf"->"导读预览 PDF";else->"其他材料"}
   Text("$label · ${android.text.format.Formatter.formatShortFileSize(materialContext,r.optLong("bytes"))}",style=MaterialTheme.typography.bodyMedium)
  }
  TextButton({materialDetails=!materialDetails}){Text(if(materialDetails)"收起材料与校验信息" else "查看材料与校验信息")}
  if(materialDetails)Column(verticalArrangement=Arrangement.spacedBy(8.dp)){
   p.rows("roles").forEach{r->Text("材料类型：${r.optString("role")}\n原件长度：${r.optLong("bytes")} 字节\nSHA-256：${r.optString("sha256")}",style=MaterialTheme.typography.labelSmall)}
  }
 }
 }},confirmButton={if(prepared==null)TextButton({prepare()},enabled=state.readingMaterialID.isNotBlank()&&state.zotero.optString("libraryID").isNotEmpty()&&!state.busy&&!state.zotero.optBoolean("busy")){Text("核验并准备材料")}else TextButton({if(canConfirm){action("zotero.archive",obj("preparedID" to prepared.optString("preparedID"),"readingMaterialID" to state.readingMaterialID));close()}},enabled=canConfirm&&!state.busy&&!state.zotero.optBoolean("busy")){Text("确认存档")}},dismissButton={TextButton(close){Text("关闭")}})
}
