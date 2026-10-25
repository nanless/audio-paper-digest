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

@Composable internal fun ZoteroSettings(state:UiState,controller:AppController,action:Action,password:()->Unit){
 val scope=rememberCoroutineScope();val z=state.zotero
 var libraryType by rememberSaveable{mutableStateOf(z.optString("libraryType","users"))}
 var libraryID by rememberSaveable{mutableStateOf(z.optString("libraryID"))}
 var collection by rememberSaveable{mutableStateOf(z.optString("collection"))}
 var dirty by rememberSaveable{mutableStateOf(false)}
 var saving by remember{mutableStateOf(false)};var listing by remember{mutableStateOf(false)}
 var error by remember{mutableStateOf<String?>(null)}
 var collections by remember{mutableStateOf<List<JSONObject>>(emptyList())}
 var listedFor by remember{mutableStateOf<String?>(null)};var showCollections by remember{mutableStateOf(false)}
 val busy=saving||listing||z.optBoolean("busy")||state.busy
 LaunchedEffect(z.toString()){
  if(!dirty){val type=z.optString("libraryType","users");val id=z.optString("libraryID");if(type!=libraryType||id!=libraryID){collections=emptyList();listedFor=null};libraryType=type;libraryID=id;collection=z.optString("collection")}
 }
 Text("Zotero 完整存档",style=MaterialTheme.typography.titleLarge)
 Text("使用官方 Web API v3 保存到你的个人或可编辑群组文库。创建单独 API key，授予目标资料、笔记、写入与文件权限；无需提供 Zotero 登录密码。附件使用 Zotero Storage，坚果云工作空间备份与此独立。")
 Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){listOf("users" to "个人文库","groups" to "群组文库").forEach{(v,l)->FilterChip(libraryType==v,{libraryType=v;dirty=true;collections=emptyList();listedFor=null},enabled=!busy,label={Text(l)})}}
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
 Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
  Button({val submitted=obj("libraryType" to libraryType,"libraryID" to libraryID,"collection" to collection);saving=true;scope.launch{try{controller.execute("zotero.save",submitted);if(libraryType==submitted.optString("libraryType")&&libraryID==submitted.optString("libraryID")&&collection==submitted.optString("collection"))dirty=false;error=null}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;error=e.message}finally{saving=false}}},enabled=dirty&&!busy){Text("保存目标文库")}
  TextButton({libraryType=z.optString("libraryType","users");libraryID=z.optString("libraryID");collection=z.optString("collection");dirty=false;error=null},enabled=dirty&&!busy){Text("撤销未保存更改")}
 }
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 OutlinedButton(password,enabled=!dirty&&!busy){Text("为已保存目标设置专用 API key…")}
 Button({action("zotero.check",JSONObject())},enabled=!dirty&&!busy){Text("核验身份、目标与权限")}
 Text("许可状态：${when(z.optString("credentialState")){"confirmed"->"已核验";"missing"->"尚未保存";else->"需要主动核验"}}")
 z.optJSONObject("permissions")?.let{Text("最近核验：${it.optString("verifiedAt")}",style=MaterialTheme.typography.labelSmall)}
 Text("独立存档记录",style=MaterialTheme.typography.titleLarge)
 z.rows("journals").forEach{j->OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
  Text(j.optString("paperID"));Text("${jobStatus(j.optString("status"))} · ${j.optString("createdAt")}")
  Text("原目标：${if(j.optString("libraryType")=="groups")"群组" else "个人文库"} ${j.optString("libraryID")} · ${if(j.optString("collection").isEmpty())"不指定分类" else "所选原分类"}",style=MaterialTheme.typography.labelSmall)
  j.ids("notices").forEach{Text(it,color=MaterialTheme.colorScheme.tertiary,style=MaterialTheme.typography.bodySmall)}
  j.optString("error").takeIf{it.isNotBlank()}?.let{Text(it,color=MaterialTheme.colorScheme.error)}
  OutlinedButton({action("zotero.resume",obj("journalID" to j.optString("id")))},enabled=!busy&&!dirty){Text(if(j.optString("status")=="completed")"重新逐项回读" else "沿原断点继续")}
 }}}
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
 AlertDialog(onDismissRequest=close,title={Text("存档到 Zotero")},text={Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(10.dp)){
 Text("引用书目与来源元数据始终保留。其余材料可明确选择；导读需要已完整离线保存科学图片。")
 listOf(Triple("PDF 原件",pdf,{v:Boolean->pdf=v;optionRevision++;Unit}),Triple("图文导读",guide,{v:Boolean->guide=v;optionRevision++;Unit}),Triple("研究、原始输入与用量",analysis,{v:Boolean->analysis=v;optionRevision++;Unit}),Triple("笔记与标注",note,{v:Boolean->note=v;optionRevision++;Unit})).forEach{(label,value,set)->Row{Text(label,Modifier.weight(1f));Checkbox(value,set)}}
 if(prepared!=null)TextButton({prepare()},enabled=state.readingMaterialID.isNotBlank()&&!state.busy&&!state.zotero.optBoolean("busy")){Text("按当前选项重新准备材料")}
 if(state.zotero.optString("libraryID").isEmpty())Text("请先在设置 → Zotero 配置并核验目标文库。",color=MaterialTheme.colorScheme.error)
 if(prepared!=null&&!canConfirm)Text("所选材料、阅读版本、笔记或解析已变化，或原准备请求缺少绑定；请按当前选项重新准备，旧包不会上传。",color=MaterialTheme.colorScheme.tertiary)
 prepared?.let{p->Text("准备完成：${p.rows("roles").size+1} 项材料",style=MaterialTheme.typography.titleSmall);p.ids("notices").forEach{notice->Text(notice,color=MaterialTheme.colorScheme.tertiary,style=MaterialTheme.typography.bodySmall)};p.rows("roles").forEach{r->Text("${r.optString("role")} · ${r.optLong("bytes")} 字节\n${r.optString("sha256")}",style=MaterialTheme.typography.labelSmall)}}
 }},confirmButton={if(prepared==null)TextButton({prepare()},enabled=state.readingMaterialID.isNotBlank()&&state.zotero.optString("libraryID").isNotEmpty()&&!state.busy&&!state.zotero.optBoolean("busy")){Text("核验并准备材料")}else TextButton({if(canConfirm){action("zotero.archive",obj("preparedID" to prepared.optString("preparedID"),"readingMaterialID" to state.readingMaterialID));close()}},enabled=canConfirm&&!state.busy&&!state.zotero.optBoolean("busy")){Text("确认存档")}},dismissButton={TextButton(close){Text("关闭")}})
}
